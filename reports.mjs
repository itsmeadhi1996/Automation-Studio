import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { browserLabels } from './browsers.mjs';

const SAFE_IMAGE_NAME = /^[\w-]+\.png$/;
const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const STEP_ICONS = { passed: '✓', failed: '×' };
const DEFAULT_STEP_ICON = '−';

// Reference B, Appendix A. The output must stay byte-for-byte equal to the appendix.
const REPORT_CSS = [
  `:root{font:14px Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:#343a40;background:#f5f7fa;--blue:#3b82f6;--green:#59a869;--red:#e85d75;--muted:#89919b;--line:#e6e9ed}*{box-sizing:border-box}body{margin:0}`,
  `.top{height:58px;background:#fff;border-bottom:1px solid var(--line);display:flex;align-items:center;padding:0 28px;gap:12px;color:#3c4653}.logo{font-weight:750;font-size:18px;color:#313a46;letter-spacing:-.5px}.logo-mark{display:inline-flex;width:25px;height:25px;margin-right:8px;border-radius:6px;background:#3b82f6;color:white;align-items:center;justify-content:center}.top small{color:var(--muted);margin-left:auto}`,
  `.layout{display:grid;grid-template-columns:260px minmax(0,1fr);min-height:calc(100vh - 58px)}aside{background:#fff;border-right:1px solid var(--line);padding:25px 16px}.nav-title{font-size:10px;color:#9aa2ac;letter-spacing:1.2px;font-weight:700;padding:0 10px 13px}.nav{display:flex;align-items:center;gap:10px;padding:10px;border-radius:5px;background:#eef5ff;color:#3178d2;font-weight:600}.nav span{margin-left:auto;background:#dceaff;border-radius:10px;padding:1px 7px;font-size:11px}`,
  `.run-info{margin-top:26px;border-top:1px solid var(--line);padding:18px 10px;color:#707985;font-size:12px;line-height:1.8}.run-info strong{display:block;color:#414a56;font-size:13px}`,
  `.main{padding:30px clamp(18px,4vw,58px);max-width:1500px;width:100%;margin:0 auto}.crumb{font-size:12px;color:#8a929d;margin-bottom:14px}.heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.heading h1{font-size:25px;margin:0 0 6px;letter-spacing:-.5px}.heading p{color:#87909b;margin:0}`,
  `.status{border-radius:4px;padding:6px 11px;font-size:11px;font-weight:750;letter-spacing:.5px}.passed{color:#268443}.failed{color:#d7475b}.skipped{color:#77818d}.blocked{color:#b98227}.case-status.blocked{background:#faf3e7}.unknown{color:#77818d}.status.passed,.case-status.passed{background:#e9f6ec}.status.failed,.case-status.failed{background:#fff0f1}`,
  `.overview-title{font-size:15px;margin:30px 0 12px}.metrics{display:grid;grid-template-columns:repeat(4,minmax(100px,1fr));gap:13px}.metric,.panel{background:#fff;border:1px solid var(--line);border-radius:5px}.metric{padding:16px 18px}.metric label{display:block;color:#89919b;font-size:11px;margin-bottom:10px}.metric strong{font-size:24px;font-weight:600;color:#303944}.metric .green{color:#4c9f5c}.metric .red{color:#dd5568}`,
  `.panel{margin-top:16px;padding:20px 22px}.panel-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:17px}.panel h2{font-size:15px;font-weight:600;margin:0}.panel-head small{font-size:12px;color:#89919b}.bar{display:flex;height:10px;border-radius:8px;overflow:hidden;background:#edf0f2}.bar .passed{background:#64b66f}.bar .failed{background:#ed6679}.bar .skipped{background:#a8afb8}.legend{display:flex;gap:22px;margin-top:13px;color:#6f7884;font-size:12px}.legend b{margin-right:5px}.legend .passed{color:#4c9f5c}.legend .failed{color:#dd5568}`,
  `.suite{margin-top:25px}.suite-title{display:flex;align-items:center;gap:9px;padding:0 3px 12px;border-bottom:1px solid var(--line);font-weight:650}.suite-title small{margin-left:auto;color:#89919b;font-weight:400}`,
  `.case{background:#fff;border:1px solid var(--line);border-radius:5px;margin-top:8px}.case>summary{display:flex;align-items:center;gap:13px;padding:13px 15px;cursor:pointer;list-style:none}.case>summary::-webkit-details-marker{display:none}.case>summary:before{content:'›';color:#9aa2ac;font-size:20px;width:10px}.case[open]>summary:before{content:'⌄'}.case-status{font-size:9px;font-weight:750;letter-spacing:.4px;padding:4px 6px;border-radius:3px}.case-status.passed{color:#338c47}.case-status.failed{color:#d7475b}.case-title{font-weight:600;flex:1}.case-title small{display:block;font-size:11px;font-weight:400;color:#8b939e;margin-top:4px}.duration{color:#848d98;font-size:11px;white-space:nowrap}.case-body{border-top:1px solid #edf0f2;padding:7px 18px 15px 39px}`,
  `.step{display:flex;align-items:flex-start;gap:10px;padding:12px 0;border-bottom:1px solid #f0f2f4}.step:last-child{border-bottom:0}.step-icon{width:18px;height:18px;border-radius:50%;background:#e9f6ec;color:#4c9f5c;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;flex-shrink:0}.step.failed .step-icon{background:#fff0f1;color:#dd5568}.step-main{flex:1;min-width:0}.step-main strong{font-size:12px;font-weight:550}.step-main small{display:block;color:#9199a3;font-size:11px;margin-top:4px}`,
  `.attachment{margin-top:8px;color:#4385d5;font-size:11px}.attachment summary{cursor:pointer}.attachment img{display:block;max-width:min(100%,850px);max-height:600px;margin-top:10px;border:1px solid var(--line);border-radius:4px}`,
  `.error-block{background:#fff6f6;border:1px solid #f4d6d9;padding:12px 14px;margin:10px 0;color:#b63d50;border-radius:4px}.error-block p,.error{white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0 0}.error{color:#b63d50;font-size:12px}.empty{color:#89919b;font-size:12px}footer{color:#9aa2ac;font-size:11px;margin:32px 0 10px}`,
  `@media(max-width:760px){.layout{grid-template-columns:1fr}aside{display:none}.main{padding:22px 14px}.metrics{grid-template-columns:repeat(2,minmax(100px,1fr))}.heading{align-items:flex-start}.legend{flex-wrap:wrap}}`,
  `@media print{body{background:#fff}.layout{display:block}aside{display:none}.main{padding:10px;max-width:none}.case,.panel,.metric{break-inside:avoid}.case:not([open])>.case-body{display:block}.attachment:not([open])>*:not(summary){display:block}}`,
].join('');

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ENTITIES[character]);
}

function seconds(milliseconds) {
  return (Number(milliseconds || 0) / 1000).toFixed(2);
}

function countStatus(tests, status) {
  return tests.filter((test) => test.status === status).length;
}

function percentOf(count, total) {
  return total ? (count / total) * 100 : 0;
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
  const duration = Number(step.duration || 0);
  const name = escapeHtml(step.name || `Step ${stepIndex + 1}`);
  const expected = step.expectedResult ? `<p><b>Expected:</b> ${escapeHtml(step.expectedResult)}</p>` : '';
  const actual = step.actualResult ? `<p><b>Actual:</b> ${escapeHtml(step.actualResult)}</p>` : '';
  const error = step.error ? `<p class="error">${escapeHtml(step.error)}</p>` : '';
  const attachments = await renderAttachments(step, artifacts);
  return [
    `<div class="step ${escapeHtml(step.status)}">`,
    `<span class="step-icon">${icon}</span>`,
    `<div class="step-main"><strong>${name}</strong>`,
    `<small>${escapeHtml(step.action || 'Action')} · ${duration} ms</small>`,
    `${expected}${actual}${error}${attachments}</div>`,
    `<span class="duration">${duration} ms</span>`,
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
    `<details class="case ${status}" ${test.status === 'failed' ? 'open' : ''}>`,
    '<summary>',
    `<span class="case-status ${status}">${statusLabel}</span>`,
    `<span class="case-title">${escapeHtml(test.name || `Test ${testIndex + 1}`)}<small>${labels}</small></span>`,
    `<span class="duration">${seconds(test.duration)} s</span>`,
    '</summary>',
    `<div class="case-body">${failure}<div class="steps">${stepsHtml}</div></div>`,
    '</details>',
  ].join('');
}

function renderMetrics(total, passed, failed, duration) {
  return [
    '<div class="metrics">',
    `<div class="metric"><label>TEST CASES</label><strong>${total}</strong></div>`,
    `<div class="metric"><label>PASSED</label><strong class="green">${passed}</strong></div>`,
    `<div class="metric"><label>FAILED</label><strong class="red">${failed}</strong></div>`,
    `<div class="metric"><label>DURATION</label><strong>${duration}<small> s</small></strong></div>`,
    '</div>',
  ].join('');
}

function renderBreakdown(total, passed, failed, skipped) {
  return [
    '<section class="panel">',
    `<div class="panel-head"><h2>Test cases</h2><small>${passed} of ${total} passed</small></div>`,
    '<div class="bar">',
    `<i class="passed" style="width:${percentOf(passed, total)}%"></i>`,
    `<i class="failed" style="width:${percentOf(failed, total)}%"></i>`,
    `<i class="skipped" style="width:${percentOf(skipped, total)}%"></i>`,
    '</div>',
    '<div class="legend">',
    `<span class="passed"><b>●</b> Passed ${passed}</span>`,
    `<span class="failed"><b>●</b> Failed ${failed}</span>`,
    `<span class="skipped"><b>●</b> Skipped ${skipped}</span>`,
    '</div>',
    '</section>',
  ].join('');
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
    `<style>${REPORT_CSS}</style></head><body>`,
    '<header class="top"><span class="logo-mark">A</span><span class="logo">QA Studio Report</span>',
    `<small>Automation Studio · Run ${runId}</small></header>`,
    '<div class="layout"><aside><div class="nav-title">REPORT</div>',
    `<div class="nav">▦ &nbsp; Overview <span>${total}</span></div>`,
    `<div class="run-info"><strong>${project}</strong>${date}<br>Browser: ${browser}<br>Duration: ${duration} s</div>`,
    '</aside><main class="main">',
    `<div class="crumb">${project} / Test report / ${runId}</div>`,
    `<div class="heading"><div><h1>${project}</h1><p>${date} · ${browser} · ${duration} s</p></div>`,
    `<span class="status ${status}">${statusLabel}</span></div>`,
    '<h2 class="overview-title">Overview</h2>',
    renderMetrics(total, passed, failed, duration),
    renderBreakdown(total, passed, failed, skipped),
    `<section class="suite"><div class="suite-title">⌄ &nbsp; Test cases <small>${total} items</small></div>`,
    cases.join('') || '<div class="case empty">No test cases in this run.</div>',
    '</section>',
    '<footer>Generated locally by Automation Studio · Screenshots are attached to their steps. Test values are omitted.</footer>',
    '</main></div></body></html>',
  ].join('');
}
