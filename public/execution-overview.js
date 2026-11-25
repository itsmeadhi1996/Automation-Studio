/* TC Execution overview: all-matching totals plus a 25-per-page detailed report. */
(() => {
  const PAGE_SIZE = 25;
  const REQUEST_TIMEOUT_MS = 15000;
  const REFRESH_MS = 15000;
  const STATUSES = ['passed', 'failed', 'blocked', 'skipped', 'interrupted', 'running', 'pending'];
  const FILTER_KEYS = ['from', 'to', 'search', 'status', 'suite', 'mode'];

  const TEMPLATE = `
    <section class="execution-overview">
      <div class="page-heading">
        <div>
          <p class="eyebrow">EXECUTION INSIGHTS</p>
          <h1>TC Execution overview</h1>
          <p class="subtitle">Detailed results across this project’s retained manual and automated runs.</p>
        </div>
        <div class="inline-actions">
          <a id="execution-export" class="button" download hidden>Export CSV</a>
          <button id="execution-refresh" type="button">Refresh</button>
        </div>
      </div>
      <form id="execution-filters" class="panel history-filters">
        <label>From date<input type="date" name="from"></label>
        <label>Through date<input type="date" name="to"></label>
        <label>Test case<input name="search" type="search" placeholder="Name, TC ID, assignee or run"></label>
        <label>Status
          <select name="status" aria-label="Status">
            <option value="">All statuses</option>
            ${STATUSES.map((status) => `<option>${status}</option>`).join('')}
          </select>
        </label>
        <label>Execution mode
          <select name="mode" aria-label="Execution mode">
            <option value="">All modes</option>
            <option value="automation">Automation</option>
            <option value="manual">Manual</option>
          </select>
        </label>
        <label>Suite
          <select name="suite" aria-label="Suite"><option value="">All suites</option></select>
        </label>
        <div class="inline-actions">
          <button class="primary" id="execution-apply">Apply filters</button>
          <button type="button" id="execution-clear">Clear filters</button>
        </div>
        <p class="form-hint">Dates use your local time. Totals include all matching executions, including reruns. Pass rate excludes pending and running executions.</p>
      </form>
      <p id="execution-error" class="error-text" role="alert" hidden></p>
      <div id="execution-summary" class="execution-stats"></div>
      <div class="execution-breakdowns">
        <section class="panel">
          <div class="panel-head"><h2>Status distribution</h2></div>
          <div id="execution-distribution" class="panel-body"></div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Suite breakdown</h2></div>
          <div id="execution-suites" class="panel-body"></div>
        </section>
      </div>
      <div class="panel-head execution-report-heading">
        <h2>Detailed execution report</h2>
        <small id="execution-updated" role="status"></small>
      </div>
      <div id="execution-results"></div>
      <nav class="pagination" aria-label="Execution report pages">
        <button id="execution-prev" type="button">Previous</button>
        <span id="execution-page" role="status"></span>
        <button id="execution-next" type="button">Next</button>
      </nav>
    </section>`;

  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
    );

  let container;
  let projectId;
  let active = false;
  let ticket = 0;
  let busy = false;
  let offset = 0;
  let total = 0;
  let filters = {};
  let lastRendered = '';
  let controller;
  const expanded = new Set();

  const $ = (selector) => container.querySelector(selector);

  function badge(status) {
    const kind = STATUSES.includes(status) ? status : 'neutral';
    return `<span class="badge ${kind}">${esc(status)}</span>`;
  }

  function formatDuration(value) {
    return value === null ? '—' : `${(Number(value || 0) / 1000).toFixed(1)} s`;
  }

  function requestParams() {
    if (filters.from && filters.to && filters.from > filters.to) {
      throw new Error('From date must be on or before Through date');
    }
    const query = new URLSearchParams({ projectId, offset: String(offset), limit: String(PAGE_SIZE) });
    for (const [key, value] of Object.entries(filters)) {
      if (!value) continue;
      if (key !== 'from' && key !== 'to') {
        query.set(key, value);
        continue;
      }
      const date = new Date(`${value}${key === 'from' ? 'T00:00:00' : 'T23:59:59.999'}`);
      if (!Number.isFinite(date.getTime())) throw new Error('Choose valid dates');
      query.set(key, date.toISOString());
    }
    return query;
  }

  function syncUrl() {
    const url = new URL(location.href);
    url.searchParams.set('view', 'execution');
    url.searchParams.set('projectId', projectId);
    for (const key of FILTER_KEYS) {
      if (filters[key]) url.searchParams.set(`execution-${key}`, filters[key]);
      else url.searchParams.delete(`execution-${key}`);
    }
    history.replaceState(null, '', url);
  }

  function pageLabel() {
    if (busy) return 'Loading report…';
    if (!total) return '0 case executions';
    return `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total} case executions`;
  }

  function updateControls() {
    $('#execution-prev').disabled = busy || offset === 0;
    $('#execution-next').disabled = busy || offset + PAGE_SIZE >= total;
    $('#execution-refresh').disabled = busy;
    $('#execution-apply').disabled = busy;
    $('#execution-page').textContent = pageLabel();
  }

  function renderStat([label, value, hint]) {
    return `
      <section class="panel execution-stat">
        <span>${label}</span>
        <strong>${esc(value)}</strong>
        <small>${esc(hint)}</small>
      </section>`;
  }

  function renderSummary(data) {
    const { summary } = data;
    const stats = [
      ['Case executions', data.total, 'One case per run; dataset rows grouped'],
      ['Runs', summary.runs, `${summary.cases} distinct cases`],
      ['Pass rate', summary.passRate === null ? '—' : `${summary.passRate}%`, 'Passed / completed case executions'],
      ['Average duration', formatDuration(summary.averageDuration), 'Completed case executions'],
    ];
    $('#execution-summary').innerHTML = stats.map(renderStat).join('');
    $('#execution-distribution').innerHTML = STATUSES.map(
      (status) => `
        <div class="execution-status-row">
          ${badge(status)}
          <progress max="${Math.max(1, data.total)}" value="${summary.counts[status]}" aria-label="${status} case executions"></progress>
          <strong>${summary.counts[status]}</strong>
        </div>`,
    ).join('');
    $('#execution-suites').innerHTML = summary.suites.length
      ? `<div class="table-scroll">
           <table>
             <thead><tr><th>Suite</th><th>Executions</th><th>Passed</th><th>Failed</th></tr></thead>
             <tbody>
               ${summary.suites
                 .map(
                   (suite) =>
                     `<tr><td>${esc(suite.name)}</td><td>${suite.total}</td><td>${suite.passed}</td><td>${suite.failed}</td></tr>`,
                 )
                 .join('')}
             </tbody>
           </table>
         </div>`
      : '<p>No suite results in this selection.</p>';
  }

  // Keeps the chosen suite selectable even when the current results no longer contain it.
  function renderSuiteOptions(data) {
    const select = $('[name="suite"]');
    const chosen = select.value;
    const names = [...new Set([...data.suites, ...(chosen ? [chosen] : [])])];
    select.innerHTML =
      '<option value="">All suites</option>' +
      names.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
    select.value = chosen;
  }

  function renderStep(step) {
    const screenshot = step.screenshot
      ? `<a target="_blank" rel="noopener" href="/artifacts/${encodeURIComponent(step.screenshot)}">View screenshot</a>`
      : '';
    return `
      <li>
        <div class="execution-step-heading">
          <strong>${esc(step.name)}</strong>
          ${badge(step.status)}
          <small>${formatDuration(step.duration)}</small>
        </div>
        ${step.expectedResult ? `<p><b>Expected:</b> ${esc(step.expectedResult)}</p>` : ''}
        ${step.actualResult ? `<p><b>Actual:</b> ${esc(step.actualResult)}</p>` : ''}
        ${step.error ? `<p class="error-text">${esc(step.error)}</p>` : ''}
        ${screenshot}
      </li>`;
  }

  function renderTest(test) {
    const trace = test.trace
      ? `<a href="/artifacts/${encodeURIComponent(test.trace)}" download>Download trace</a>`
      : '';
    return `
      <section class="execution-test">
        <h3>${esc(test.name)}</h3>
        ${test.error ? `<p class="error-text">${esc(test.error)}</p>` : ''}
        ${trace}
        <ol>${test.steps.map(renderStep).join('')}</ol>
      </section>`;
  }

  function renderRow(row) {
    const key = `${row.runId}:${row.caseId}`;
    const report = `/api/runs/${encodeURIComponent(row.runId)}/report`;
    const caseQuery = `?${new URLSearchParams({ testId: row.caseId })}`;
    const started = new Date(row.startedAt).toLocaleString();
    return `
      <details class="panel execution-result" data-key="${esc(key)}" ${expanded.has(key) ? 'open' : ''}>
        <summary>
          <div>
            <strong>${esc(row.number)} · ${esc(row.name)}</strong>
            <small>${esc(started)} · ${esc(row.suite)} · ${esc(row.mode)} · ${esc(row.browser)}</small>
          </div>
          ${badge(row.status)}
          <span>${formatDuration(row.duration)}</span>
        </summary>
        <div class="panel-body">
          <p>Run: ${esc(row.runName)} · Assignee: ${esc(row.owner)} · ${row.tests.length} dataset result(s)</p>
          <div class="inline-actions">
            <a class="button" target="_blank" rel="noopener" href="${report}${caseQuery}">Case HTML report</a>
            <a class="button" href="${report}.pdf${caseQuery}" download>Case PDF report</a>
            <a class="button" target="_blank" rel="noopener" href="${report}/interactive${caseQuery}">Case interactive report</a>
            <a class="button" href="${report}.json${caseQuery}" download>Case Playwright JSON</a>
            <a class="button" target="_blank" rel="noopener" href="${report}">Full run report</a>
          </div>
          ${row.error ? `<p class="error-text">${esc(row.error)}</p>` : ''}
          ${row.tests.map(renderTest).join('')}
        </div>
      </details>`;
  }

  function render(data) {
    renderSummary(data);
    renderSuiteOptions(data);
    $('#execution-results').innerHTML = data.rows.length
      ? data.rows.map(renderRow).join('')
      : `<section class="panel empty-state">
           <h2>No matching executions</h2>
           <p>Run a test case or adjust the report filters.</p>
         </section>`;
  }

  function showFailure(message) {
    const node = $('#execution-error');
    node.textContent = message;
    node.hidden = false;
    $('#execution-export').hidden = true;
  }

  async function load(quiet = false) {
    controller?.abort();
    controller = new AbortController();
    const request = ++ticket;
    busy = true;
    if (!quiet) updateControls();
    try {
      const query = requestParams();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
      const response = await StudioUI.request(`/api/automation/execution-overview?${query}`, { signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load execution report');
      if (!active || request !== ticket) return;

      offset = data.offset;
      total = data.total;
      const signature = JSON.stringify(data);
      if (signature !== lastRendered) {
        lastRendered = signature;
        render(data);
      }
      syncUrl();
      $('#execution-error').hidden = true;

      const exportQuery = new URLSearchParams(query);
      exportQuery.set('export', 'csv');
      const exportLink = $('#execution-export');
      exportLink.href = `/api/automation/execution-overview?${exportQuery}`;
      exportLink.hidden = false;
      $('#execution-updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch (error) {
      if (active && request === ticket) showFailure(error.message);
    } finally {
      if (active && request === ticket) {
        busy = false;
        updateControls();
      }
    }
  }

  function restoreFilters(form) {
    const url = new URL(location.href);
    const sameProject = url.searchParams.get('projectId') === projectId;
    filters = {};
    for (const key of FILTER_KEYS) {
      filters[key] = sameProject ? url.searchParams.get(`execution-${key}`) || '' : '';
    }
    if (filters.suite) form.elements.suite.add(new Option(filters.suite, filters.suite));
    for (const [key, value] of Object.entries(filters)) form.elements[key].value = value;
  }

  function bindControls(form) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      filters = Object.fromEntries(new FormData(form));
      offset = 0;
      expanded.clear();
      void load();
    });
    $('#execution-clear').addEventListener('click', () => {
      form.reset();
      for (const key of FILTER_KEYS) {
        filters[key] = '';
        form.elements[key].value = '';
      }
      offset = 0;
      expanded.clear();
      void load();
    });
    $('#execution-refresh').addEventListener('click', () => void load());
    $('#execution-prev').addEventListener('click', () => {
      offset = Math.max(0, offset - PAGE_SIZE);
      void load();
    });
    $('#execution-next').addEventListener('click', () => {
      offset += PAGE_SIZE;
      void load();
    });
    // `toggle` does not bubble, so expansion state is tracked in the capture phase.
    $('#execution-results').addEventListener(
      'toggle',
      (event) => {
        const { key } = event.target.dataset;
        if (!key) return;
        if (event.target.open) expanded.add(key);
        else expanded.delete(key);
      },
      true,
    );
  }

  globalThis.StudioExecution = {
    mount(target, id) {
      if (active && projectId === id && target.querySelector('.execution-overview')) return;
      ticket++;
      lastRendered = '';
      active = true;
      busy = false;
      container = target;
      projectId = id;
      offset = 0;
      total = 0;
      expanded.clear();
      container.innerHTML = TEMPLATE;
      const form = $('#execution-filters');
      restoreFilters(form);
      bindControls(form);
      void load();
    },
    unmount() {
      active = false;
      busy = false;
      ticket++;
      controller?.abort();
    },
    refresh() {
      if (active && !busy) void load(true);
    },
  };

  setInterval(() => {
    if (active && !busy && !document.hidden) void load(true);
  }, REFRESH_MS);
})();
