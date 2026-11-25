import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { merge } from 'monocart-reporter';
import { caseResult, playwrightJsonReport, runBrowserLabel, tcLabel } from './playwright-json.mjs';

const CASE_TYPES = { expected: 'passed', unexpected: 'failed', skipped: 'skipped' };
const RECENT_MARKS = { passed: '✓', failed: '×', skipped: '−' };
const RECENT_RESULTS = 5;
const MAX_TREND_RUNS = 30;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const ARTIFACT_PATH = /^\/artifacts\/([\w-]+\.png)$/;
const COLUMNS = [
  { id: 'caseType', name: '', width: 36, sortable: false, align: 'center', formatter: 'iconCaseType' },
  { id: 'title', name: 'Title', searchable: true, width: 380, maxWidth: 3012 },
  { id: 'tc', name: 'TC No.', searchable: true, width: 80, align: 'center' },
  { id: 'qaStatus', name: 'Result', width: 90, align: 'center' },
  { id: 'recent', name: 'Recent runs', width: 110, align: 'center', sortable: false },
  { id: 'duration', name: 'Duration', align: 'right', sortAsc: false, formatter: 'duration' },
  { id: 'errors', name: 'Errors', width: 60, align: 'center', comparer: 'errors', formatter: 'errors' },
  { id: 'attachments', name: 'Evidence', width: 80, align: 'center', formatter: 'attachments' },
];
// Shown on each step in the detail panel. Step rows stay collapsed in the grid, so these would
// be empty columns there.
const DETAIL_COLUMNS = [
  { id: 'action', name: 'Action', invisible: true },
  { id: 'expected', name: 'Expected result', searchable: true, invisible: true, detailed: true },
  { id: 'actual', name: 'Actual result', searchable: true, invisible: true, detailed: true },
];

// Monocart reads localStorage without a guard, and the sandbox it is served in has none. The
// fallback only holds its display preferences for the life of the page.
const STORAGE_FALLBACK = `<script>try{localStorage}catch{const m=new Map();Object.defineProperty(window,'localStorage',{value:{getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),clear:()=>m.clear()}})}</script>`;
// The Timeline section reports CPU, memory and folders of the machine, which are removed on purpose.
const REPORT_STYLE = '<style>.mcr-report-item:has(.mcr-usage-list){display:none}</style>';

const caseKey = (test) => test.qaCaseId || test.sourceTestId || test.id;
const annotationValue = (item, type) => item.annotations?.find((entry) => entry.type === type)?.description;

function trendEntry(run) {
  const tests = run.tests || [];
  const count = (outcome) => tests.filter((test) => caseResult(test.status).outcome === outcome).length;
  return {
    date: Date.parse(run.startedAt),
    duration: Number(run.duration || 0),
    tests: tests.length,
    failed: count('unexpected'),
    flaky: 0,
    skipped: count('skipped'),
    passed: count('expected'),
  };
}

// "3/5 ✓✓×✓✓", oldest first. Dataset rows of a case in one run count as one result: any failure
// fails it, because that is how the case reads on the test case page.
function recentResults(run, history) {
  const results = new Map();
  for (const source of [...history, run]) {
    const statuses = new Map();
    for (const test of source.tests || []) {
      const previous = statuses.get(caseKey(test));
      if (previous !== 'failed') statuses.set(caseKey(test), test.status);
    }
    for (const [key, status] of statuses) {
      results.set(key, [...(results.get(key) || []), status].slice(-RECENT_RESULTS));
    }
  }
  return (test) => {
    const statuses = results.get(caseKey(test)) || [];
    const passed = statuses.filter((status) => status === 'passed').length;
    return `${passed}/${statuses.length} ${statuses.map((status) => RECENT_MARKS[status] || '!').join('')}`;
  };
}

// A failed step's evidence goes first, so a run over the size limit still explains its failures.
async function embedImages(spec, budget, artifacts) {
  const result = spec.tests[0].results[0];
  const failedNames = result.steps.filter((step) => step.error).map((step) => step.title);
  const isFailureEvidence = (attachment) => failedNames.some((name) => attachment.name.startsWith(`${name} — `));
  const ordered = [...result.attachments.filter(isFailureEvidence), ...result.attachments.filter((item) => !isFailureEvidence(item))];
  const embedded = [];
  let omitted = 0;
  for (const attachment of ordered) {
    const file = attachment.path.match(ARTIFACT_PATH)?.[1];
    const image = file ? await readFile(path.join(artifacts, file)).catch(() => null) : null;
    if (!image) continue;
    if (image.length > budget.remaining) {
      omitted += 1;
      continue;
    }
    budget.remaining -= image.length;
    embedded.push({ name: attachment.name, contentType: attachment.contentType, retry: 0, path: `data:image/png;base64,${image.toString('base64')}` });
  }
  return { embedded, omitted };
}

function stepRow(step, index) {
  return {
    id: `step-${index}-${crypto.randomUUID()}`,
    title: step.title,
    type: 'step',
    stepType: 'test.step',
    count: 1,
    duration: step.duration,
    ...(step.error ? { errors: [step.error.message], errorNum: 1 } : {}),
    qaStatus: annotationValue(step, 'status') || '',
    action: annotationValue(step, 'action') || '',
    expected: annotationValue(step, 'expected') || '',
    actual: annotationValue(step, 'actual') || '',
  };
}

async function caseRow(spec, test, recent, budget, artifacts) {
  const entry = spec.tests[0];
  const result = entry.results[0];
  const start = Date.parse(result.startTime);
  const { embedded, omitted } = await embedImages(spec, budget, artifacts);
  const steps = result.steps.map(stepRow);
  const failedSteps = steps.filter((step) => step.errors);
  const caseErrors = result.errors.map((error) => error.message);
  // A step's failure is usually the case's error too, and it still counts as one error.
  const errorNum = new Set([...caseErrors, ...failedSteps.map((step) => step.errors[0])]).size;
  return {
    id: spec.id,
    title: spec.title,
    type: 'case',
    caseType: CASE_TYPES[entry.status],
    ok: spec.ok,
    outcome: entry.status,
    expectedStatus: entry.expectedStatus,
    status: result.status,
    timestamps: [start, start + result.duration],
    duration: result.duration,
    tags: spec.tags.map((tag) => `@${tag}`),
    retry: 0,
    stepNum: steps.length,
    stepFailed: failedSteps.length,
    stepSubs: false,
    ...(steps.length ? { subs: steps } : {}),
    ...(caseErrors.length ? { errors: caseErrors } : {}),
    ...(errorNum ? { errorNum, ...(failedSteps.length ? { errorId: failedSteps[0].id } : {}) } : {}),
    ...(embedded.length ? { attachments: embedded } : {}),
    tc: tcLabel(test),
    qaStatus: annotationValue(entry, 'qa-status') || '',
    recent: recent(test),
    ...(omitted ? { actual: `${omitted} screenshot(s) were left out to keep this report small. Open the run in QA Studio to see them.` } : {}),
  };
}

// Without this hook the report would carry the server's folder paths and system details.
function publicData(reportData, run, history, cases) {
  for (const field of ['cwd', 'outputFile', 'outputDir', 'jsonPath', 'htmlPath']) delete reportData[field];
  reportData.traceViewerUrl = '';
  reportData.summary.errors.value = cases.reduce((total, item) => total + (item.errorNum || 0), 0);
  reportData.system = reportData.system.map(() => neutralSystem(run, reportData));
  reportData.trends = history.slice(-MAX_TREND_RUNS).map(trendEntry);
}

function neutralSystem(run, { date, duration }) {
  return {
    hostname: runBrowserLabel(run),
    cpu: { color: '', count: 0 },
    mem: { color: '', total: 0 },
    timestampStart: date,
    timestampEnd: date + duration,
    workers: 1,
    jobs: [],
    ticks: [],
  };
}

// `history` is the same project's or case's earlier runs, oldest first. Generation always uses a
// new folder because Monocart empties its output folder first.
export async function monocartReportHtml(run, artifacts, { history = [] } = {}) {
  const report = playwrightJsonReport(run);
  const directory = await mkdtemp(path.join(tmpdir(), 'qa-studio-report-'));
  try {
    const recent = recentResults(run, history);
    const budget = { remaining: MAX_IMAGE_BYTES };
    const specs = report.suites[0].specs;
    const tests = run.tests || [];
    const order = specs.map((_, index) => index).sort((a, b) => Number(specs[b].ok === false) - Number(specs[a].ok === false));
    const cases = [];
    for (const index of order) {
      cases[index] = await caseRow(specs[index], tests[index], recent, budget, artifacts);
    }
    const start = Date.parse(report.stats.startTime);
    const outputFile = path.join(directory, 'index.html');
    const { metadata } = report.config;
    await merge(
      [
        {
          outputDir: directory,
          name: 'QA Studio report',
          date: start,
          duration: report.stats.duration,
          metadata: Object.fromEntries(Object.entries(metadata).filter(([, value]) => value)),
          system: { hostname: runBrowserLabel(run) },
          columns: [...COLUMNS.map((column) => ({ ...column, detailed: false })), ...DETAIL_COLUMNS],
          formatters: {},
          suiteTypes: ['project', 'file', 'describe', 'shard'],
          caseTypes: ['failed', 'flaky', 'skipped', 'passed'],
          summary: { tests: { value: cases.length } },
          rows: [{ id: 'cases', title: report.suites[0].title, type: 'suite', suiteType: 'describe', caseNum: cases.length, subs: cases }],
        },
      ],
      {
        name: `${run.projectName || 'Project'} — QA Studio report`,
        outputFile,
        logging: 'off',
        json: false,
        onData: (reportData) => publicData(reportData, run, history, cases),
      },
    );
    const html = await readFile(outputFile, 'utf8');
    return html.replace('<head>', () => `<head>${STORAGE_FALLBACK}${REPORT_STYLE}`);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
