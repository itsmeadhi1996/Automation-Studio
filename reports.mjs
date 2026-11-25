import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { browserLabels } from './browsers.mjs';

const SAFE_IMAGE_NAME = /^[\w-]+\.png$/;
const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const STEP_ICONS = { passed: '✓', failed: '×' };
const DEFAULT_STEP_ICON = '−';
const MAX_ATTENTION_DETAIL = 160;

// Self-contained on purpose: reports are downloaded, printed and attached to Jira issues,
// so they use no web fonts, scripts or external files.
const REPORT_CSS = [
  `:root{--ink:#1d2530;--text:#3a4048;--muted:#6b665c;--paper:#faf8f3;--card:#fff;--line:#e6e0d4;--soft:#f3efe6;--gold:#a88a4f;--pass:#2c6e4f;--pass-bg:#e8f1ec;--fail:#a22f3c;--fail-bg:#f8eaeb;--skip:#79756b;--skip-bg:#efece5;--hold:#92661f;--hold-bg:#f6eedd;--serif:Georgia,"Times New Roman",serif;font:15px/1.55 "Segoe UI",Inter,system-ui,-apple-system,sans-serif;color:var(--text);background:var(--paper);font-variant-numeric:tabular-nums}*{box-sizing:border-box}body{margin:0;background:var(--paper)}`,
  `.sheet{max-width:980px;margin:0 auto;padding:40px 48px 32px}.masthead{display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding-bottom:12px;border-bottom:2px solid var(--ink);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}.brand{font-family:var(--serif);font-size:15px;letter-spacing:.04em;text-transform:none;color:var(--ink);font-weight:700}`,
  `.title{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;margin-top:36px}h1{font-family:var(--serif);font-weight:400;font-size:38px;line-height:1.15;letter-spacing:-.01em;color:var(--ink);margin:0;overflow-wrap:anywhere}.verdict{flex-shrink:0;margin-top:8px;padding:6px 14px;border:1px solid currentColor;font-size:11px;font-weight:600;letter-spacing:.16em;color:var(--skip)}.verdict.passed{color:var(--pass)}.verdict.failed{color:var(--fail)}.verdict.blocked{color:var(--hold)}`,
  `.facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px;margin:24px 0 0;padding:16px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.facts dt,.tally dt{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}.facts dd{margin:4px 0 0;font-size:13px;color:var(--ink);overflow-wrap:anywhere}`,
  `.summary{display:grid;grid-template-columns:auto minmax(0,1fr);gap:44px;align-items:center;margin-top:32px}.rate strong{display:block;font-weight:300;font-size:68px;line-height:1;letter-spacing:-.02em;color:var(--ink)}.rate strong small{font-size:30px;margin-left:2px;color:var(--gold)}.rate span{display:block;margin-top:8px;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}.headline{margin:0 0 14px;font-size:18px;line-height:1.3;color:var(--ink)}`,
  `.bar{display:flex;height:6px;overflow:hidden;background:var(--soft)}.bar i{display:block}.bar .passed{background:var(--pass)}.bar .failed{background:var(--fail)}.bar .skipped{background:#b8b3a6}.bar .other{background:var(--gold)}.tally{display:flex;flex-wrap:wrap;gap:12px 36px;margin:16px 0 0}.tally dd{margin:2px 0 0;font-size:22px;font-weight:300;line-height:1.2;color:var(--ink)}.tally .failed dd{color:var(--fail)}.tally .passed dd{color:var(--pass)}`,
  `h2{font-family:var(--serif);font-weight:400;font-size:22px;color:var(--ink);margin:0}.attention{margin-top:36px;padding:20px 24px;background:var(--fail-bg);border-left:3px solid var(--fail)}.attention h2{font-size:18px;color:var(--fail)}.attention ol{margin:10px 0 0;padding:0;list-style:none}.attention li{padding:8px 0;border-top:1px solid rgba(162,47,60,.16);overflow-wrap:anywhere}.attention li:first-child{border-top:0}.attention a{color:var(--ink);font-weight:600;text-decoration:none}.attention a:hover{text-decoration:underline}.attention small{display:block;font-size:12px;color:var(--text)}`,
  `.cases{margin-top:40px}.cases-head{display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding-bottom:10px;border-bottom:1px solid var(--ink)}.cases-head small{font-size:12px;color:var(--muted)}.case{border-bottom:1px solid var(--line);scroll-margin-top:12px}.case>summary{display:flex;align-items:center;gap:16px;padding:15px 4px;cursor:pointer;list-style:none}.case>summary::-webkit-details-marker{display:none}.case>summary:hover{background:var(--soft)}.case>summary:focus-visible,.attachment summary:focus-visible,.attention a:focus-visible{outline:2px solid var(--gold);outline-offset:2px}.case-status{flex:0 0 72px;text-align:center;padding:3px 0;font-size:10px;font-weight:600;letter-spacing:.1em;color:var(--skip);background:var(--skip-bg)}.case-status.passed{color:var(--pass);background:var(--pass-bg)}.case-status.failed{color:var(--fail);background:var(--fail-bg)}.case-status.blocked{color:var(--hold);background:var(--hold-bg)}.case-title{flex:1;min-width:0;font-weight:600;color:var(--ink);overflow-wrap:anywhere}.case-title small{display:block;margin-top:2px;font-size:12px;font-weight:400;color:var(--muted)}.duration{flex-shrink:0;font-size:12px;color:var(--muted);white-space:nowrap}.case>summary:after{content:'+';flex-shrink:0;width:14px;text-align:center;font-size:17px;line-height:1;color:var(--gold)}.case[open]>summary:after{content:'−'}.case-body{padding:2px 4px 20px 88px}`,
  `.error-block{margin:4px 0 12px;padding:12px 16px;background:var(--fail-bg);border-left:3px solid var(--fail);font-size:13px;color:var(--fail)}.error-block b{font-size:10px;letter-spacing:.14em;text-transform:uppercase}.error-block p,.error{margin:4px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}.error{font-size:13px;color:var(--fail)}`,
  `.step{display:flex;align-items:flex-start;gap:12px;padding:11px 0;border-top:1px solid var(--soft)}.step:first-child{border-top:0}.step-icon{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;width:18px;height:18px;margin-top:2px;border:1px solid var(--skip);border-radius:50%;font-size:10px;font-weight:700;color:var(--skip)}.step.passed .step-icon{color:var(--pass);border-color:var(--pass)}.step.failed .step-icon{color:#fff;border-color:var(--fail);background:var(--fail)}.step-main{flex:1;min-width:0}.step-main strong{font-size:14px;font-weight:500;color:var(--ink);overflow-wrap:anywhere}.step-main small{display:block;font-size:12px;color:var(--muted)}.result{margin:6px 0 0;font-size:13px;overflow-wrap:anywhere}.result b{font-weight:600;color:var(--ink)}`,
  `.attachment{margin-top:6px;font-size:12px}.attachment summary{display:inline-block;cursor:pointer;color:#7c6432}.attachment img{display:block;max-width:100%;max-height:600px;margin-top:8px;border:1px solid var(--line)}.empty{padding:16px 4px;font-size:13px;color:var(--muted)}footer{margin-top:32px;padding-top:12px;border-top:1px solid var(--line);font-size:11px;color:var(--muted)}`,
  `@media screen and (max-width:760px){.sheet{padding:24px 16px}h1{font-size:28px}.title{margin-top:24px;gap:12px}.verdict{margin-top:4px;padding:4px 9px;letter-spacing:.1em}.facts{grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.summary{grid-template-columns:1fr;gap:18px;margin-top:24px}.rate strong{font-size:52px}.tally{gap:10px 26px}.attention{padding:16px}.case>summary{flex-wrap:wrap;gap:6px 10px}.case-status{order:1}.duration{order:2;margin-left:auto}.case>summary:after{order:3}.case-title{order:4;flex:1 1 100%}.case-body{padding:0 4px 18px}}`,
  `@media print{:root,body{background:#fff}.sheet{max-width:none;padding:0}.case,.step,.attention li,.summary{break-inside:avoid}.case{break-inside:auto}.case>summary{break-after:avoid}.case>summary:after{display:none}.case:not([open])>.case-body{display:block}.attachment:not([open])>*:not(summary){display:block}.attachment summary{color:var(--muted)}a{color:inherit}}`,
].join('');

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ENTITIES[character]);
}

function seconds(milliseconds) {
  return (Number(milliseconds || 0) / 1000).toFixed(2);
}

function stepDuration(milliseconds) {
  const duration = Number(milliseconds || 0);
  return duration < 1000 ? `${duration} ms` : `${seconds(duration)} s`;
}

function countStatus(tests, status) {
  return tests.filter((test) => test.status === status).length;
}

function percentOf(count, total) {
  return total ? (count / total) * 100 : 0;
}

// Rounds down so a run with any failure can never read as 100%.
function passRate(passed, total) {
  return Math.floor(percentOf(passed, total));
}

function browserLabel(run) {
  if (run.mode === 'manual') {
    return 'Manual execution';
  }
  return browserLabels[run.browser] || 'Chromium';
}

// A missing or unreadable image is left out rather than failing the whole report.
async function imageAttachment(artifacts, file, summary, altText) {
  if (!file || !SAFE_IMAGE_NAME.test(file)) {
    return '';
  }
  try {
    const image = (await readFile(path.join(artifacts, file))).toString('base64');
    return (
      `<details class="attachment"><summary>${summary}</summary>` +
      `<img alt="${altText}" src="data:image/png;base64,${image}"></details>`
    );
  } catch {
    return '';
  }
}

async function renderAttachments(step, artifacts) {
  const name = escapeHtml(step.name);
  const parts = [
    await imageAttachment(artifacts, step.screenshot, 'Screenshot attachment', `Screenshot after ${name}`),
  ];
  for (const [index, file] of (step.targetScreenshots || []).entries()) {
    const summary = `Locator screenshot ${index + 1}`;
    parts.push(await imageAttachment(artifacts, file, summary, `Exact locator location for ${name}`));
  }
  return parts.join('');
}

async function renderStep(step, stepIndex, artifacts) {
  const icon = STEP_ICONS[step.status] || DEFAULT_STEP_ICON;
  const name = escapeHtml(step.name || `Step ${stepIndex + 1}`);
  const expected = step.expectedResult ? `<p class="result"><b>Expected:</b> ${escapeHtml(step.expectedResult)}</p>` : '';
  const actual = step.actualResult ? `<p class="result"><b>Actual:</b> ${escapeHtml(step.actualResult)}</p>` : '';
  const error = step.error ? `<p class="error">${escapeHtml(step.error)}</p>` : '';
  const attachments = await renderAttachments(step, artifacts);
  return [
    `<div class="step ${escapeHtml(step.status)}">`,
    `<span class="step-icon">${icon}</span>`,
    `<div class="step-main"><strong>${name}</strong>`,
    `<small>${escapeHtml(step.action || 'Action')}</small>`,
    `${expected}${actual}${error}${attachments}</div>`,
    `<span class="duration">${stepDuration(step.duration)}</span>`,
    '</div>',
  ].join('');
}

async function renderCase(test, testIndex, artifacts) {
  const steps = await Promise.all((test.steps || []).map((step, index) => renderStep(step, index, artifacts)));
  const stepsHtml = steps.join('') || '<p class="empty">No step details were recorded.</p>';
  const tcLabel = test.tcNumber ? `TC-${String(test.tcNumber).padStart(4, '0')}` : null;
  const labels = [test.suiteName, tcLabel].filter(Boolean).map(escapeHtml).join(' · ') || 'Test case';
  const status = escapeHtml(test.status);
  const statusLabel = escapeHtml((test.status || 'unknown').toUpperCase());
  const failure = test.error
    ? `<div class="error-block"><b>Failure message</b><p>${escapeHtml(test.error)}</p></div>`
    : '';
  return [
    `<details class="case ${status}" id="case-${testIndex + 1}" ${test.status === 'failed' ? 'open' : ''}>`,
    '<summary>',
    `<span class="case-status ${status}">${statusLabel}</span>`,
    `<span class="case-title">${escapeHtml(test.name || `Test ${testIndex + 1}`)}<small>${labels}</small></span>`,
    `<span class="duration">${seconds(test.duration)} s</span>`,
    '</summary>',
    `<div class="case-body">${failure}<div class="steps">${stepsHtml}</div></div>`,
    '</details>',
  ].join('');
}

function renderSummary(total, passed, failed, skipped) {
  const other = total - passed - failed - skipped;
  const headline = total
    ? `${passed} of ${total} test ${total === 1 ? 'case' : 'cases'} passed.`
    : 'No test cases in this run.';
  const rate = total ? `${passRate(passed, total)}<small>%</small>` : '—';
  const tally = [
    ['passed', 'Passed', passed],
    ['failed', 'Failed', failed],
    ['skipped', 'Skipped', skipped],
    ...(other ? [['other', 'Not completed', other]] : []),
  ];
  return [
    '<section class="summary">',
    `<div class="rate"><strong>${rate}</strong><span>Pass rate</span></div>`,
    `<div><p class="headline">${headline}</p>`,
    '<div class="bar">',
    `<i class="passed" style="width:${percentOf(passed, total)}%"></i>`,
    `<i class="failed" style="width:${percentOf(failed, total)}%"></i>`,
    `<i class="skipped" style="width:${percentOf(skipped, total)}%"></i>`,
    `<i class="other" style="width:${percentOf(other, total)}%"></i>`,
    '</div>',
    '<dl class="tally">',
    ...tally.map(([name, label, count]) => `<div class="${name}"><dt>${label}</dt><dd>${count}</dd></div>`),
    '</dl></div>',
    '</section>',
  ].join('');
}

function renderAttention(tests) {
  const items = tests
    .map((test, index) => ({ test, index }))
    .filter(({ test }) => test.status === 'failed')
    .map(({ test, index }) => {
      const detail = String(test.error || '').split('\n')[0].slice(0, MAX_ATTENTION_DETAIL);
      return (
        `<li><a href="#case-${index + 1}">${escapeHtml(test.name || `Test ${index + 1}`)}</a>` +
        `${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</li>`
      );
    });
  return items.length ? `<section class="attention"><h2>Needs attention</h2><ol>${items.join('')}</ol></section>` : '';
}

export async function reportHtml(run, artifacts) {
  const tests = run.tests || [];
  const cases = await Promise.all(tests.map((test, index) => renderCase(test, index, artifacts)));

  const total = tests.length;
  const passed = countStatus(tests, 'passed');
  const failed = countStatus(tests, 'failed');
  const skipped = countStatus(tests, 'skipped');
  const duration = seconds(run.duration);
  const runId = escapeHtml(run.id);
  const project = escapeHtml(run.projectName || 'Project');
  const browser = escapeHtml(browserLabel(run));
  const date = escapeHtml(run.startedAt ? new Date(run.startedAt).toLocaleString() : 'Unknown');
  const status = escapeHtml(run.status || 'unknown');
  const statusLabel = escapeHtml((run.status || 'unknown').toUpperCase());

  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width">',
    `<title>QA Studio Report — ${escapeHtml(run.projectName)}</title>`,
    `<style>${REPORT_CSS}</style></head><body><main class="sheet">`,
    '<header class="masthead"><span class="brand">QA Studio</span><span>Test execution report</span></header>',
    `<div class="title"><h1>${project}</h1><span class="verdict ${status}">${statusLabel}</span></div>`,
    '<dl class="facts">',
    `<div><dt>Started</dt><dd>${date}</dd></div>`,
    `<div><dt>Browser</dt><dd>${browser}</dd></div>`,
    `<div><dt>Duration</dt><dd>${duration} s</dd></div>`,
    `<div><dt>Run</dt><dd>${runId}</dd></div>`,
    '</dl>',
    renderSummary(total, passed, failed, skipped),
    renderAttention(tests),
    `<section class="cases"><div class="cases-head"><h2>Test cases</h2><small>${total} ${total === 1 ? 'item' : 'items'}</small></div>`,
    cases.join('') || '<p class="empty">No test cases in this run.</p>',
    '</section>',
    '<footer>Generated locally by QA Studio · Screenshots are attached to their steps. Test values are omitted.</footer>',
    '</main></body></html>',
  ].join('');
}
