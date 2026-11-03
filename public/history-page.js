/* Run history inside Automation Studio. Filters and pagination apply to complete visible history. */
(() => {
  const FILTER_KEYS = ['from', 'to', 'testName', 'status', 'suiteName'];
  const PAGE_SIZES = [10, 25, 50, 100];
  const REQUEST_TIMEOUT_MS = 15000;
  const ACTIVE_REFRESH_MS = 5000;
  const BADGE_STATUSES = ['passed', 'failed', 'running', 'skipped', 'interrupted'];

  const TEMPLATE = `
    <section class="history-view">
      <div class="page-heading">
        <div>
          <p class="eyebrow">EXECUTION INSIGHTS</p>
          <h1>Run history</h1>
          <p>Browse project runs. Expand a run to review test results and evidence.</p>
        </div>
      </div>
      <form id="history-filters" class="panel history-filters">
        <label>From date<input type="date" name="from" aria-label="From date"></label>
        <label>Through date<input type="date" name="to" aria-label="Through date"></label>
        <label>TC name
          <input name="testName" list="history-tests" placeholder="Search test case names" autocomplete="off">
          <datalist id="history-tests"></datalist>
        </label>
        <label>Status
          <input name="status" list="history-statuses" placeholder="All statuses" autocomplete="off">
          <datalist id="history-statuses"></datalist>
        </label>
        <label>Suite name
          <input name="suiteName" list="history-suites" placeholder="Search suite names" autocomplete="off">
          <datalist id="history-suites"></datalist>
        </label>
        <div class="inline-actions">
          <button class="primary" type="submit">Apply filters</button>
          <button type="button" id="clear-filters">Clear filters</button>
        </div>
        <p class="form-hint">Type or choose a name from the dropdown. Dates include the full day in your local time zone.</p>
      </form>
      <p id="history-error" class="error-text" role="alert" hidden></p>
      <div id="history-results" aria-live="polite"></div>
      <nav class="pagination" aria-label="Run history pages">
        <button id="history-prev" type="button">Previous</button>
        <span id="history-page-label"></span>
        <button id="history-next" type="button">Next</button>
        <label>Runs per page
          <select id="history-size">
            ${PAGE_SIZES.map((size) => `<option>${size}</option>`).join('')}
          </select>
        </label>
        <button id="history-refresh" type="button">Refresh</button>
      </nav>
    </section>`;

  const $ = (selector) => document.querySelector(selector);
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
    );

  let active = false;
  let projectId = '';
  let offset = 0;
  let limit = PAGE_SIZES[0];
  let total = 0;
  let rows = [];
  let ticket = 0;
  let loading = false;
  let lastRendered = '';
  let controller;
  let filters = blankFilters();
  const expanded = new Set();

  function blankFilters() {
    return Object.fromEntries(FILTER_KEYS.map((key) => [key, '']));
  }

  function badge(status) {
    const kind = BADGE_STATUSES.includes(status) ? status : 'neutral';
    return `<span class="badge ${kind}">${esc(status)}</span>`;
  }

  function artifactUrl(file) {
    return `/artifacts/${encodeURIComponent(file)}`;
  }

  function resetView() {
    offset = 0;
    expanded.clear();
  }

  function showError(message) {
    const node = $('#history-error');
    node.textContent = message;
    node.hidden = false;
  }

  // Filters and paging come from the URL only when it describes the project being opened.
  function readUrl() {
    const query = new URLSearchParams(location.search);
    const sameProject = query.get('projectId') === projectId;
    const requestedLimit = Number(query.get('limit'));
    const requestedOffset = Number(query.get('offset'));
    limit = PAGE_SIZES.includes(requestedLimit) ? requestedLimit : PAGE_SIZES[0];
    offset = sameProject && Number.isSafeInteger(requestedOffset) ? Math.max(0, requestedOffset) : 0;
    const form = $('#history-filters');
    for (const key of FILTER_KEYS) {
      filters[key] = sameProject ? query.get(key) || '' : '';
      form.elements[key].value = filters[key];
    }
    $('#history-size').value = String(limit);
  }

  function syncUrl() {
    const query = new URLSearchParams({
      view: 'history',
      projectId,
      offset: String(offset),
      limit: String(limit),
    });
    for (const [key, value] of Object.entries(filters)) {
      if (value) query.set(key, value);
    }
    history.replaceState(null, '', `/automation?${query}`);
  }

  function pageLabel() {
    if (loading) return 'Loading…';
    if (!total) return '0 runs';
    const page = Math.floor(offset / limit) + 1;
    return `Page ${page} of ${Math.ceil(total / limit)} · ${total} runs`;
  }

  function updateControls() {
    $('#history-prev').disabled = loading || !offset;
    $('#history-next').disabled = loading || offset + limit >= total;
    $('#history-refresh').disabled = loading;
    $('#history-page-label').textContent = pageLabel();
  }

  function evidenceLinks(step) {
    const links = [];
    if (step.screenshot) {
      links.push(`<a target="_blank" rel="noopener" href="${artifactUrl(step.screenshot)}">Screenshot</a>`);
    }
    for (const shot of step.targetScreenshots || []) {
      const file = typeof shot === 'string' ? shot : shot.screenshot || shot.file;
      if (!file) continue;
      links.push(
        `<a target="_blank" rel="noopener" href="${artifactUrl(file)}">${esc(shot.name || 'Target screenshot')}</a>`,
      );
    }
    return links.join(' ');
  }

  function renderStep(step) {
    const parts = [
      badge(step.status),
      `<span>${esc(step.name || step.instruction)}</span>`,
      `<small>${Number(step.duration || 0)}ms</small>`,
    ];
    if (step.expectedResult) {
      parts.push(`<p class="result-step-detail"><b>Expected:</b> ${esc(step.expectedResult)}</p>`);
    }
    if (step.actualResult) {
      parts.push(`<p class="result-step-detail"><b>Actual:</b> ${esc(step.actualResult)}</p>`);
    }
    if (step.error) parts.push(`<p class="error-text">${esc(step.error)}</p>`);
    parts.push(evidenceLinks(step));
    if (step.jdbcResult) parts.push(`<pre>${esc(JSON.stringify(step.jdbcResult, null, 2))}</pre>`);
    return `<div class="result-step">${parts.join('')}</div>`;
  }

  function renderRunTest(run, test) {
    const key = `${run.id}:${test.id}`;
    const parts = [`<summary><span>${esc(test.name)}</span>${badge(test.status)}</summary>`];
    if (test.error) parts.push(`<p class="error-text">${esc(test.error)}</p>`);
    if (test.trace) {
      parts.push(`<a href="${artifactUrl(test.trace)}" download>Download execution trace</a>`);
    }
    if (test.diagnostics?.length) {
      parts.push(
        `<details><summary>Browser diagnostics</summary><pre>${esc(JSON.stringify(test.diagnostics, null, 2))}</pre></details>`,
      );
    }
    parts.push(...test.steps.map(renderStep));
    const open = expanded.has(key) ? 'open' : '';
    return `<details class="run-test" data-test="${esc(key)}" ${open}>${parts.join('')}</details>`;
  }

  function renderRun(run) {
    const title = run.name || run.tests[0]?.name || 'Test run';
    const scope = `${run.replay ? 'Replay · ' : ''}${run.suiteName || 'Individual / grouped run'}`;
    const started = new Date(run.startedAt).toLocaleString();
    const reportUrl = `/api/runs/${encodeURIComponent(run.id)}/report`;
    const cancel =
      run.status === 'running'
        ? `<button type="button" data-cancel="${esc(run.id)}">${run.replay ? 'Stop replay' : 'Stop run'}</button>`
        : '';
    const error = run.error ? `<p class="error-text">${esc(run.error)}</p>` : '';
    return `
      <details class="panel run-card" data-run="${esc(run.id)}" ${expanded.has(run.id) ? 'open' : ''}>
        <summary>
          <span class="run-title">
            <strong>${esc(title)}</strong>
            <small>${esc(started)} · ${esc(scope)} · ${run.tests.length} test cases</small>
          </span>
          ${badge(run.status)}
          <small>${((run.duration || 0) / 1000).toFixed(1)}s</small>
        </summary>
        <div class="run-body">
          <div class="inline-actions">
            <a target="_blank" rel="noopener" href="${reportUrl}">HTML report</a>
            <a href="${reportUrl}.pdf" download>PDF report</a>
            ${cancel}
          </div>
          ${error}
          ${run.tests.map((test) => renderRunTest(run, test)).join('')}
        </div>
      </details>`;
  }

  function renderResults() {
    $('#history-results').innerHTML = rows.length
      ? rows.map(renderRun).join('')
      : `<section class="panel empty-state">
           <h2>No matching runs</h2>
           <p>Adjust the filters or run a test in this project.</p>
         </section>`;
    updateControls();
  }

  function requestParams() {
    if (filters.from && filters.to && filters.from > filters.to) {
      throw new Error('From date must be on or before Through date');
    }
    const query = new URLSearchParams({ projectId, offset: String(offset), limit: String(limit) });
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

  async function fetchRuns(query) {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    const response = await StudioUI.request(`/api/runs?${query}`, { signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  function fillDatalists(lists) {
    const entries = [
      ['history-tests', lists.testNames],
      ['history-suites', lists.suiteNames],
      ['history-statuses', lists.statuses],
    ];
    for (const [id, values] of entries) {
      $(`#${id}`).innerHTML = values.map((value) => `<option value="${esc(value)}"></option>`).join('');
    }
  }

  async function load(quiet = false) {
    controller?.abort();
    controller = new AbortController();
    const request = ++ticket;
    loading = true;
    if (!quiet) updateControls();
    try {
      const result = await fetchRuns(requestParams());
      if (request !== ticket || !active) return;
      rows = result.runs;
      offset = result.offset;
      total = result.total;
      fillDatalists(result.filters);
      $('#history-error').hidden = true;
      syncUrl();
      // Rendering only on change keeps open details, focus and DOM identity across polls.
      const signature = JSON.stringify(result);
      if (signature !== lastRendered) {
        lastRendered = signature;
        renderResults();
      }
    } catch (error) {
      if (request === ticket && active) showError(error.message);
    } finally {
      if (request === ticket && active) {
        loading = false;
        updateControls();
      }
    }
  }

  async function cancelRun(button) {
    button.disabled = true;
    try {
      const response = await StudioUI.request(`/api/runs/${encodeURIComponent(button.dataset.cancel)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not stop run');
      await load();
    } catch (error) {
      showError(error.message);
      button.disabled = false;
    }
  }

  function bindControls() {
    $('#history-filters').addEventListener('submit', (event) => {
      event.preventDefault();
      for (const key of FILTER_KEYS) filters[key] = event.target.elements[key].value.trim();
      resetView();
      void load();
    });
    $('#clear-filters').addEventListener('click', () => {
      $('#history-filters').reset();
      filters = blankFilters();
      resetView();
      void load();
    });
    $('#history-size').addEventListener('change', (event) => {
      limit = Number(event.target.value);
      resetView();
      void load();
    });
    $('#history-prev').addEventListener('click', () => {
      offset = Math.max(0, offset - limit);
      expanded.clear();
      void load();
    });
    $('#history-next').addEventListener('click', () => {
      offset += limit;
      expanded.clear();
      void load();
    });
    $('#history-refresh').addEventListener('click', () => void load());

    const results = $('#history-results');
    results.addEventListener('click', (event) => {
      const button = event.target.closest('[data-cancel]');
      if (button) void cancelRun(button);
    });
    // `toggle` does not bubble, so expansion state is tracked in the capture phase.
    results.addEventListener(
      'toggle',
      (event) => {
        const id = event.target.dataset.run || event.target.dataset.test;
        if (!id) return;
        if (event.target.open) expanded.add(id);
        else expanded.delete(id);
      },
      true,
    );
  }

  globalThis.StudioHistory = {
    mount(container, id) {
      if (active && projectId === id && container.querySelector('.history-view')) return;
      ticket++;
      active = true;
      loading = false;
      lastRendered = '';
      projectId = id;
      rows = [];
      total = 0;
      expanded.clear();
      container.innerHTML = TEMPLATE;
      readUrl();
      bindControls();
      void load();
    },
    unmount() {
      active = false;
      loading = false;
      ticket++;
      controller?.abort();
    },
    refresh() {
      if (active && !loading) void load(true);
    },
  };

  setInterval(() => {
    const hasRunningRun = rows.some((run) => run.status === 'running');
    if (active && !loading && !document.hidden && hasRunningRun) void load(true);
  }, ACTIVE_REFRESH_MS);
})();
