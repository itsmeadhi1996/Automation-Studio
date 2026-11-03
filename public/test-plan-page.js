/* Saved test plans. Case references use QA case IDs, and each plan keeps its own run history. */
(() => {
  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const STATUS_PRIORITY = ['failed', 'blocked', 'running', 'pending', 'interrupted', 'passed', 'skipped'];
  const PLAN_STATUSES = ['open', 'closed', 'archived'];
  const PAGE_SIZES = [10, 25, 50, 100];
  // test-plan-page.css defines .plan-weight-1 to .plan-weight-20; the CSP forbids inline widths.
  const MAX_SEGMENT_WEIGHT = 20;

  const filtersByProject = new Map();
  let current;

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
  }

  function filtersFor(projectId) {
    if (!filtersByProject.has(projectId)) {
      filtersByProject.set(projectId, { search: '', owner: '', type: '', status: 'open', release: '', size: 10, page: 0 });
    }
    return filtersByProject.get(projectId);
  }

  const activeFilters = () => filtersFor(current.project().id);
  const plans = () => current.project().testPlans || [];

  function latestRun(plan) {
    const matching = current.runs().filter((run) => run.planId === plan.id || plan.id === `legacy-${run.id}`);
    return matching.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
  }

  function statusCounts(plan) {
    const run = latestRun(plan);
    const counts = {};
    for (const id of plan.testIds) {
      const results = run?.tests.filter((test) => (test.qaCaseId || test.sourceTestId || test.id) === id) || [];
      const status = STATUS_PRIORITY.find((candidate) => results.some((test) => test.status === candidate)) || 'untested';
      counts[status] = (counts[status] || 0) + 1;
    }
    return counts;
  }

  function summarize(counts, separator = ', ') {
    return Object.entries(counts)
      .map(([status, count]) => `${count} ${status}`)
      .join(separator);
  }

  function filteredPlans() {
    const filters = activeFilters();
    const search = filters.search.toLowerCase();
    return plans().filter(
      (plan) =>
        (!search || plan.name.toLowerCase().includes(search)) &&
        (!filters.owner || plan.assignedTo === filters.owner) &&
        (!filters.type || plan.type === filters.type) &&
        (!filters.status || plan.status === filters.status) &&
        (!filters.release || plan.release === filters.release),
    );
  }

  function initials(name) {
    const letters = name.split(/\s+/).map((part) => part[0]).join('');
    return esc(letters.slice(0, 2).toUpperCase());
  }

  function personCell(name, isCreator = false) {
    if (!name) return `<span class="plan-muted">${isCreator ? '—' : 'Unassigned'}</span>`;
    return (
      `<span class="plan-person">` +
      `<span class="plan-assignee ${isCreator ? 'plan-creator' : ''}" title="${esc(name)}">${initials(name)}</span>` +
      `<span class="plan-owner">${esc(name)}</span>` +
      `</span>`
    );
  }

  function rowAction(name, label, id, icon) {
    const text = esc(label);
    return `<button type="button" data-plan-action="${name}" data-plan-id="${esc(id)}" aria-label="${text}" title="${text}">${StudioUI.icon(icon)}</button>`;
  }

  function segmentWeight(count, total) {
    if (total <= MAX_SEGMENT_WEIGHT) return count;
    return Math.max(1, Math.round((count / total) * MAX_SEGMENT_WEIGHT));
  }

  function statusBar(plan) {
    const counts = statusCounts(plan);
    const summary = summarize(counts) || 'No test cases';
    const segments = Object.entries(counts)
      .map(([status, count]) => `<span class="plan-segment ${esc(status)} plan-weight-${segmentWeight(count, plan.testIds.length)}"></span>`)
      .join('');
    return (
      `<div class="plan-status-bar" role="img" aria-label="${esc(summary)}" title="${esc(summary)}">${segments}</div>` +
      `<small class="plan-status-label">${esc(summary)}</small>`
    );
  }

  function planRow(plan) {
    const created = new Date(plan.createdAt);
    const createdDate = created.toLocaleDateString(undefined, { month: 'short', day: '2-digit', year: 'numeric' });
    const createdTime = created.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const id = esc(plan.id);
    const name = esc(plan.name);
    const canRun = plan.status === 'open' && plan.testIds.length > 0;
    return `<tr data-plan-row="${id}">
      <td>${personCell(plan.createdBy, true)}</td>
      <td>
        <button type="button" class="plan-title" data-plan-action="details" data-plan-id="${id}">${name}</button>
        <span class="plan-title-meta">
          <span class="plan-case-id">${esc(plan.id.replace(/^legacy-/, '').slice(0, 6))}</span>
          ${plan.release ? `<small>${esc(plan.release)}</small>` : ''}
        </span>
      </td>
      <td><span class="plan-type">Specific</span></td>
      <td>${personCell(plan.assignedTo)}</td>
      <td>${esc(createdDate)}<span class="plan-created-time">${esc(createdTime)}</span></td>
      <td>
        <button type="button" class="plan-case-count" data-plan-action="details" data-plan-id="${id}"
          aria-label="View ${plan.testIds.length} test cases in ${name}">${plan.testIds.length}</button>
      </td>
      <td>${statusBar(plan)}</td>
      <td>
        <div class="plan-row-actions">
          ${canRun ? rowAction('run', `Run ${plan.name}`, plan.id, 'runs') : ''}
          ${latestRun(plan) ? rowAction('results', `Results for ${plan.name}`, plan.id, 'reports') : ''}
          ${rowAction('copy', `Copy ${plan.name}`, plan.id, 'copy')}
          ${rowAction('edit', `Edit ${plan.name}`, plan.id, 'edit')}
          ${rowAction('delete', `Delete ${plan.name}`, plan.id, 'trash')}
        </div>
      </td>
    </tr>`;
  }

  function pagination(page, pages) {
    const numbers = Array.from({ length: pages }, (_, index) => index)
      .filter((index) => Math.abs(index - page) < 3 || index === 0 || index === pages - 1)
      .map((index) => {
        const isCurrent = index === page;
        return `<button type="button" data-plan-index="${index}" ${isCurrent ? 'aria-current="page" class="plan-page-number"' : ''}>${index + 1}</button>`;
      })
      .join('');
    return `<nav class="plan-pagination" aria-label="Test plan pages">
      <button type="button" data-plan-page="-1" aria-label="Previous page" ${page ? '' : 'disabled'}>‹</button>
      ${numbers}
      <button type="button" data-plan-page="1" aria-label="Next page" ${page + 1 < pages ? '' : 'disabled'}>›</button>
    </nav>`;
  }

  function emptyState() {
    const hasPlans = plans().length > 0;
    const title = hasPlans ? 'No matching test plans' : 'Your Test plan is empty';
    const description = hasPlans
      ? 'Adjust the search or filters.'
      : 'Select multiple cases on Test cases, choose Transfer to Test plan, then name and save your plan.';
    return `<div class="plan-empty"><strong>${title}</strong><p>${description}</p></div>`;
  }

  function resultsMarkup() {
    const filters = activeFilters();
    const list = filteredPlans();
    const pages = Math.max(1, Math.ceil(list.length / filters.size));
    filters.page = Math.max(0, Math.min(filters.page, pages - 1));
    const start = filters.page * filters.size;
    const shown = list.slice(start, start + filters.size);
    const first = list.length ? start + 1 : 0;
    const last = Math.min(start + filters.size, list.length);
    const total = list.length !== plans().length ? ` · ${plans().length} total` : '';
    return `<div class="table-scroll" tabindex="0" role="region" aria-label="Saved test plans">
      <table class="plan-table">
        <thead>
          <tr>
            <th>Created By</th><th>Title</th><th>Type</th><th>Assigned To</th>
            <th>Created Date</th><th>Test Cases</th><th>Status</th><th>Action</th>
          </tr>
        </thead>
        <tbody>${shown.map(planRow).join('')}</tbody>
      </table>
      ${list.length ? '' : emptyState()}
    </div>
    <div class="plan-list-footer">
      <span>${first}–${last} of ${list.length} plans${total}</span>
      ${pagination(filters.page, pages)}
    </div>`;
  }

  function refreshResults() {
    const node = document.querySelector('#plan-results');
    if (node) node.innerHTML = resultsMarkup();
  }

  function filterOptions(values, selected, emptyLabel) {
    const items = values.map((value) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(value)}</option>`);
    return `<option value="">${emptyLabel}</option>${items.join('')}`;
  }

  function uniqueSorted(field) {
    return [...new Set(plans().map((plan) => plan[field]).filter(Boolean))].sort();
  }

  function render(config) {
    current = config;
    const filters = activeFilters();
    const sizes = PAGE_SIZES.map((size) => `<option ${size === filters.size ? 'selected' : ''}>${size}</option>`).join('');
    return `<div class="test-plan-page">
      <section class="plan-toolbar">
        <div>
          <div class="plan-heading">
            <h1>Test plan &amp; results</h1>
            <span class="plan-total">${plans().length}</span>
          </div>
          <p class="plan-description">Organize test cases, start executions, and track results.</p>
        </div>
        <div class="plan-toolbar-actions">
          <button type="button" data-plan-action="date-export">${StudioUI.icon('download')}Date Export</button>
          <button type="button" data-plan-action="archive">${StudioUI.icon('suites')}Archive</button>
          <button type="button" data-plan-action="export">${StudioUI.icon('download')}Export</button>
          <select data-plan-filter="status" aria-label="Plan status">${filterOptions(PLAN_STATUSES, filters.status, 'All statuses')}</select>
          <select data-plan-filter="release" aria-label="Release">${filterOptions(uniqueSorted('release'), filters.release, 'Select a Release')}</select>
          ${config.select}
        </div>
      </section>
      <section class="plan-list">
        <div class="plan-filters">
          <input type="search" data-plan-filter="search" aria-label="Search By TestRun" placeholder="Search By TestRun" value="${esc(filters.search)}">
          <select data-plan-filter="owner" aria-label="Assign to">${filterOptions(uniqueSorted('assignedTo'), filters.owner, 'Assign to')}</select>
          <select data-plan-filter="type" aria-label="Selection type">${filterOptions(['Specific'], filters.type, 'Select')}</select>
          <label class="plan-size"><select data-plan-filter="size" aria-label="Entries per page">${sizes}</select> entries</label>
          <button type="button" class="plan-clear" data-plan-action="clear">Clear filters</button>
        </div>
        <div id="plan-results">${resultsMarkup()}</div>
      </section>
    </div>`;
  }

  function textField(name, label, value = '', extra = '') {
    return `<label>${label}<input name="${name}" value="${esc(value)}" maxlength="120" ${extra}></label>`;
  }

  function statusField(selected) {
    const items = PLAN_STATUSES.map((status) => {
      const label = status[0].toUpperCase() + status.slice(1);
      return `<option value="${status}" ${status === selected ? 'selected' : ''}>${label}</option>`;
    });
    return `<label>Status<select name="status">${items.join('')}</select></label>`;
  }

  function buildPlan(old, isCopy, testIds, values, name) {
    const isEdit = Boolean(old) && !isCopy;
    return {
      ...old,
      id: isEdit ? old.id : crypto.randomUUID(),
      name,
      testIds,
      assignedTo: values.assignedTo.trim(),
      release: values.release.trim(),
      status: values.status,
      type: 'Specific',
      createdBy: isEdit ? old.createdBy : StudioAuth.user?.name || 'Local user',
      // A copy is a new plan, so the server stamps its own creation date.
      createdAt: isEdit ? old.createdAt : undefined,
    };
  }

  // Creates a plan from selected ids, or edits or copies an existing one.
  function openPlanEditor(config, ids, old, isCopy = false) {
    const snapshot = structuredClone(config.project());
    const testIds = ids || old.testIds;
    if (!testIds.length) throw new Error('Select at least one test case.');
    const initialName = old ? old.name + (isCopy ? ' (copy)' : '') : '';
    const initialStatus = isCopy ? 'open' : old?.status || 'open';
    const body =
      textField('name', 'Test plan name', initialName, 'required') +
      `<p class="field-hint">${testIds.length} selected test cases will be saved together in this plan.</p>` +
      textField('assignedTo', 'Assign to', old?.assignedTo || '') +
      textField('release', 'Release', old?.release || '') +
      statusField(initialStatus);

    async function save(values) {
      const name = values.name.trim();
      if (!name) throw new Error('Enter a test plan name.');
      const plan = buildPlan(old, isCopy, testIds, values, name);
      snapshot.testPlans = snapshot.testPlans || [];
      const index = snapshot.testPlans.findIndex((item) => item.id === plan.id);
      if (index < 0) snapshot.testPlans.push(plan);
      else snapshot.testPlans[index] = plan;
      for (const test of snapshot.tests) {
        if (testIds.includes(test.qaCaseId || test.id)) test.inTestPlan = true;
      }
      await config.save(snapshot);
      // Show the saved plan, even if the previous filters would have hidden it.
      Object.assign(filtersFor(snapshot.id), { status: plan.status, search: '', owner: '', release: '' });
      config.saved();
    }

    config.modal(old && !isCopy ? 'Edit test plan' : 'Save test plan', body, save, 'Save test plan');
  }

  function exportCsv(list) {
    const cell = (value) => `"${String(value ?? '').replace(/"/g, '""').replace(/^[=+@-]/, "'$&")}"`;
    const header = ['Test plan name', 'Created by', 'Assigned to', 'Created date', 'Test cases', 'Status', 'Release', 'Results'];
    const rows = list.map((plan) => [
      plan.name,
      plan.createdBy,
      plan.assignedTo,
      plan.createdAt,
      plan.testIds.length,
      plan.status,
      plan.release,
      summarize(statusCounts(plan), '; '),
    ]);
    const csv = [header, ...rows].map((row) => row.map(cell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'test-plans.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function openDateExport(config) {
    const list = filteredPlans();
    const body = '<label>From<input type="date" name="from" required></label><label>To<input type="date" name="to" required></label>';
    config.modal(
      'Date Export',
      body,
      (values) => {
        if (values.from > values.to) throw new Error('The end date must be after the start date.');
        const start = new Date(`${values.from}T00:00:00`);
        const end = new Date(`${values.to}T23:59:59.999`);
        exportCsv(
          list.filter((plan) => {
            const created = new Date(plan.createdAt);
            return created >= start && created <= end;
          }),
        );
      },
      'Export',
    );
  }

  function clearFilters() {
    Object.assign(activeFilters(), { search: '', owner: '', type: '', status: '', release: '', page: 0 });
    for (const node of document.querySelectorAll('[data-plan-filter]')) {
      if (node.dataset.planFilter !== 'size') node.value = '';
    }
    refreshResults();
  }

  function showArchived() {
    activeFilters().status = 'archived';
    activeFilters().page = 0;
    document.querySelector('[data-plan-filter="status"]').value = 'archived';
    refreshResults();
  }

  function caseListItem(config, id) {
    const test = config.project().tests.find((item) => (item.qaCaseId || item.id) === id);
    if (!test) return '<li>Case unavailable in this workspace</li>';
    return `<li>TC-${String(test.tcNumber || 0).padStart(4, '0')} · ${esc(test.name)}</li>`;
  }

  function showDetails(config, plan) {
    const items = plan.testIds.map((id) => caseListItem(config, id)).join('');
    const body = `<p>${plan.testIds.length} test cases · ${esc(plan.status)}</p><ul class="plan-detail-cases">${items}</ul>`;
    config.modal(plan.name, body, () => {}, 'Done');
  }

  function confirmDelete(config, plan) {
    const snapshot = structuredClone(config.project());
    config.modal(
      'Delete test plan?',
      `<p>Delete ${esc(plan.name)}? Test cases and execution history are retained.</p>`,
      async () => {
        snapshot.testPlans = snapshot.testPlans.filter((item) => item.id !== plan.id);
        for (const test of snapshot.tests) {
          const id = test.qaCaseId || test.id;
          const stillPlanned = snapshot.testPlans.some((item) => item.testIds.includes(id));
          if (plan.testIds.includes(id) && !stillPlanned) test.inTestPlan = false;
        }
        await config.save(snapshot);
        config.saved();
      },
      'Delete test plan',
    );
  }

  const PAGE_ACTIONS = {
    clear: clearFilters,
    export: () => exportCsv(filteredPlans()),
    'date-export': openDateExport,
    archive: showArchived,
  };

  const PLAN_ACTIONS = {
    run: (config, plan) => config.run(plan),
    results: (config, plan) => config.results(latestRun(plan)),
    edit: (config, plan) => openPlanEditor(config, null, plan),
    copy: (config, plan) => openPlanEditor(config, null, plan, true),
    details: showDetails,
    delete: confirmDelete,
  };

  function changePage(control) {
    const filters = activeFilters();
    if (control.dataset.planPage) filters.page += Number(control.dataset.planPage);
    else filters.page = Number(control.dataset.planIndex);
    refreshResults();
  }

  document.addEventListener('input', (event) => {
    if (!current || event.target.dataset.planFilter !== 'search') return;
    const filters = activeFilters();
    filters.search = event.target.value;
    filters.page = 0;
    refreshResults();
  });

  document.addEventListener('change', (event) => {
    const key = event.target.dataset.planFilter;
    if (!current || !key || key === 'search') return;
    const filters = activeFilters();
    filters[key] = key === 'size' ? Number(event.target.value) : event.target.value;
    filters.page = 0;
    refreshResults();
  });

  document.addEventListener('click', async (event) => {
    const control = event.target.closest('[data-plan-action],[data-plan-page],[data-plan-index]');
    if (!control || !current) return;
    const config = current;
    const action = control.dataset.planAction;
    try {
      if (!action) {
        changePage(control);
      } else if (PAGE_ACTIONS[action]) {
        PAGE_ACTIONS[action](config);
      } else {
        const plan = plans().find((item) => item.id === control.dataset.planId);
        if (plan) await PLAN_ACTIONS[action](config, plan);
      }
    } catch (error) {
      config.notify(error.message, true);
    }
  });

  window.StudioTestPlan = {
    render,
    create(config, ids) {
      openPlanEditor(config, ids);
    },
  };
})();
