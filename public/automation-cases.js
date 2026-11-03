/* Test cases view for Automation Studio. Shares app.js's global scope. */
const AUTO_CASES_PAGE_SIZES = ['10', '25', '50', '100'];
const AUTO_CASES_RESULTS = ['untested', 'passed', 'failed', 'blocked', 'running', 'skipped', 'interrupted'];
const AUTO_CASES_PRIORITIES = ['critical', 'high', 'medium', 'low'];
const AUTO_CASES_BLANK_FILTERS = Object.freeze({ search: '', status: '', priority: '', suite: '', folder: null });

let autoCasesProject;
let autoCasesPage = 0;
let autoCasesSize = 25;
// folder: null means all cases, '' means unfiled, otherwise a folder id.
let autoCasesFilters = { ...AUTO_CASES_BLANK_FILTERS };
const autoCasesSelected = new Set();

function autoCasesReset() {
  if (autoCasesProject === project.id) return;
  autoCasesProject = project.id;
  autoCasesPage = 0;
  autoCasesSelected.clear();
  autoCasesFilters = { ...AUTO_CASES_BLANK_FILTERS };
}

function autoCaseResult(test) {
  const id = test.qaCaseId || test.id;
  const run = projectRuns().find((candidate) => candidate.tests.some((item) => historyTools.matchesCase(item, id)));
  return run ? historyTools.caseRun(run, id)?.status || 'untested' : 'untested';
}

function autoCasesMatchesFolder(test, folderIds) {
  const { folder } = autoCasesFilters;
  if (folder === null) return true;
  return folderIds ? folderIds.has(test.folderId) : !test.folderId;
}

function autoCasesFiltered() {
  const { folder, search, status, priority, suite } = autoCasesFilters;
  const folderIds = folder ? StudioFolders.descendants(project.folders, folder) : null;
  const term = search.toLowerCase();
  return project.tests.filter((test) => {
    if (!autoCasesMatchesFolder(test, folderIds)) return false;
    if (term) {
      const text = [tc(test), test.name, test.qa?.description, test.qa?.owner].join(' ').toLowerCase();
      if (!text.includes(term)) return false;
    }
    if (status && autoCaseResult(test) !== status) return false;
    if (priority && (test.qa?.priority || 'medium') !== priority) return false;
    return !suite || test.suiteId === suite || Boolean(test.additionalSuiteIds?.includes(suite));
  });
}

function autoCasesVisiblePage(tests = autoCasesFiltered()) {
  return tests.slice(autoCasesPage * autoCasesSize, (autoCasesPage + 1) * autoCasesSize);
}

function autoCasesFolderTree(parent = null) {
  return project.folders
    .filter((folder) => (folder.parentId || null) === parent)
    .map((folder) => {
      const ids = StudioFolders.descendants(project.folders, folder.id);
      const count = project.tests.filter((test) => ids.has(test.folderId)).length;
      const current = autoCasesFilters.folder === folder.id ? 'aria-current="true"' : '';
      const title = esc(StudioFolders.path(project.folders, folder.id));
      return `
        <div class="auto-folder-branch">
          <button data-action="cases-folder" data-folder="${esc(folder.id)}" ${current} title="${title}">
            <span>${esc(folder.name)}</span><small>${count}</small>
          </button>
          ${autoCasesFolderTree(folder.id)}
        </div>`;
    })
    .join('');
}

function autoCasesBulkBar() {
  if (!autoCasesSelected.size) return '';
  const blocked =
    debugUnavailable() || project.tests.some((test) => autoCasesSelected.has(test.id) && !test.steps.length);
  return `
    <div class="auto-cases-bulk">
      <strong>${autoCasesSelected.size} cases selected</strong>
      <button data-action="cases-run-selected" ${blocked ? 'disabled' : ''}>Run selected</button>
      <button data-action="cases-clear-selection">Clear selection</button>
    </div>`;
}

function autoCasesRow(test) {
  const name = esc(test.name);
  const id = esc(test.id);
  const priority = esc(test.qa?.priority || 'medium');
  const place = esc(StudioFolders.path(project.folders, test.folderId) || test.qa?.type || 'functional');
  const canRun = !debugUnavailable() && test.steps.length;
  return `
    <tr>
      <td><input type="checkbox" data-case-select="${id}" aria-label="Select ${name}" ${autoCasesSelected.has(test.id) ? 'checked' : ''}></td>
      <td>
        <button class="auto-case-link" data-action="select-test" data-id="${id}">
          <span class="auto-case-text"><strong>${name}</strong><small>${tc(test)} · ${place}</small></span>
        </button>
      </td>
      <td><span class="auto-priority ${priority}">${priority}</span></td>
      <td>${badge(test.steps.length ? 'automation' : 'not configured')}</td>
      <td>${badge(autoCaseResult(test))}</td>
      <td>${esc(test.qa?.owner || 'Unassigned')}</td>
      <td>
        <div class="inline-actions">
          <button data-action="cases-run" data-id="${id}" aria-label="Run ${name}" ${canRun ? '' : 'disabled'}>Run</button>
          <button data-action="directory-copy" data-id="${id}" aria-label="Copy ${name}">Copy</button>
          <button data-action="directory-move" data-id="${id}" aria-label="Move ${name}">Move</button>
          <button data-action="directory-delete" data-id="${id}" aria-label="Delete ${name}">Delete</button>
        </div>
      </td>
    </tr>`;
}

function autoCasesTable(pageTests) {
  const allChecked = pageTests.every((test) => autoCasesSelected.has(test.id));
  return `
    <div class="table-scroll">
      <table class="auto-cases-table">
        <thead>
          <tr>
            <th><input type="checkbox" id="auto-cases-all" aria-label="Select all visible cases" ${allChecked ? 'checked' : ''}></th>
            <th>TEST CASE</th>
            <th>PRIORITY</th>
            <th>EXECUTION</th>
            <th>LAST RESULT</th>
            <th>ASSIGNEE</th>
            <th>ACTIONS</th>
          </tr>
        </thead>
        <tbody>${pageTests.map(autoCasesRow).join('')}</tbody>
      </table>
    </div>`;
}

function autoCasesEmpty() {
  if (project.tests.length) {
    return `
      <div class="empty-state">
        <h2>No test cases found</h2>
        <p>No cases match this selection. Clear the filters to see all cases.</p>
        <button data-action="cases-clear-filters">Clear filters</button>
      </div>`;
  }
  return `
    <div class="empty-state">
      <h2>No test cases found</h2>
      <p>Create your first case, then configure its automation steps.</p>
      <button data-action="new-test">Create test case</button>
    </div>`;
}

function autoCasesPagination(matching) {
  const pages = Math.max(1, Math.ceil(matching / autoCasesSize));
  const isLastPage = (autoCasesPage + 1) * autoCasesSize >= matching;
  return `
    <nav class="pagination" aria-label="Test case pages">
      <span>${matching} of ${project.tests.length} cases</span>
      <button data-action="cases-page" data-direction="-1" ${autoCasesPage ? '' : 'disabled'}>Previous</button>
      <span>Page ${autoCasesPage + 1} of ${pages}</span>
      <button data-action="cases-page" data-direction="1" ${isLastPage ? 'disabled' : ''}>Next</button>
      <label>Cases per page
        <select id="auto-cases-size">${options(AUTO_CASES_PAGE_SIZES, String(autoCasesSize))}</select>
      </label>
    </nav>`;
}

function autoCasesResults() {
  const tests = autoCasesFiltered();
  for (const id of autoCasesSelected) {
    if (!project.tests.some((test) => test.id === id)) autoCasesSelected.delete(id);
  }
  autoCasesPage = Math.max(0, Math.min(autoCasesPage, Math.ceil(tests.length / autoCasesSize) - 1));
  const pageTests = autoCasesVisiblePage(tests);
  return (
    autoCasesBulkBar() +
    (pageTests.length ? autoCasesTable(pageTests) : autoCasesEmpty()) +
    autoCasesPagination(tests.length)
  );
}

function autoCasesFolderName() {
  const { folder } = autoCasesFilters;
  if (folder === null) return 'All test cases';
  return folder ? StudioFolders.path(project.folders, folder) : 'Unfiled';
}

function autoCasesSidebar() {
  const { folder } = autoCasesFilters;
  const unfiled = project.tests.filter((test) => !test.folderId).length;
  return `
    <aside class="panel auto-cases-folders">
      <h2>Test cases</h2>
      <nav aria-label="Test case folders">
        <button data-action="cases-folder" data-scope="all" ${folder === null ? 'aria-current="true"' : ''}>
          All test cases <small>${project.tests.length}</small>
        </button>
        ${autoCasesFolderTree()}
        <button data-action="cases-folder" data-scope="unfiled" ${folder === '' ? 'aria-current="true"' : ''}>
          Unfiled <small>${unfiled}</small>
        </button>
      </nav>
    </aside>`;
}

function renderCasesList() {
  autoCasesReset();
  const { folder, search, status, priority, suite } = autoCasesFilters;
  const actions = `
    <button data-action="new-folder">New folder</button>
    <button class="primary" data-action="new-test" data-folder="${esc(folder || '')}">Create test case</button>`;
  return `
    ${heading('TEST WORKSPACE', 'Test cases', 'Every scenario, organized. Choose a case to open its automation editor.', actions)}
    <div class="auto-cases-workspace">
      ${autoCasesSidebar()}
      <section class="panel auto-cases-panel">
        <div class="panel-head">
          <div>
            <h2>${esc(autoCasesFolderName())}</h2>
            ${folder ? '<p class="subtitle">Includes cases in subfolders</p>' : ''}
          </div>
        </div>
        <div class="auto-cases-filters">
          <input id="auto-cases-search" type="search" aria-label="Search test cases" placeholder="Search by title, ID, or assignee…" value="${esc(search)}">
          <select data-cases-filter="status" aria-label="Filter by result">${options(AUTO_CASES_RESULTS, status, 'All results')}</select>
          <select data-cases-filter="priority" aria-label="Filter by priority">${options(AUTO_CASES_PRIORITIES, priority, 'All priorities')}</select>
          <select data-cases-filter="suite" aria-label="Filter by suite">${options(project.suites, suite, 'All suites')}</select>
          <button data-action="cases-clear-filters">Clear filters</button>
        </div>
        <div id="auto-cases-results">${autoCasesResults()}</div>
      </section>
    </div>`;
}

function syncCasesSelection() {
  const visible = autoCasesVisiblePage();
  const selectAll = document.querySelector('#auto-cases-all');
  if (selectAll) {
    const someSelected = visible.some((test) => autoCasesSelected.has(test.id));
    const allSelected = visible.every((test) => autoCasesSelected.has(test.id));
    selectAll.indeterminate = someSelected && !allSelected;
  }

  const bulk = document.querySelector('.auto-cases-bulk');
  const runButton = bulk?.querySelector('[data-action="cases-run-selected"]');
  if (!runButton?.disabled || bulk.querySelector('.auto-cases-help')) return;
  const hint = document.createElement('p');
  hint.className = 'auto-cases-help';
  hint.id = 'auto-cases-run-help';
  hint.textContent = debugUnavailable()
    ? 'Finish the active session before running selected cases.'
    : 'Open each unconfigured case and add automation steps before running the selection.';
  bulk.append(hint);
  runButton.setAttribute('aria-describedby', hint.id);
}

function refreshCasesList() {
  const results = document.querySelector('#auto-cases-results');
  if (!results) return;
  const focused = document.activeElement;
  const selectKey = focused?.dataset.caseSelect;
  const focusedId = focused?.id;
  results.innerHTML = autoCasesResults();
  syncCasesSelection();
  if (selectKey) {
    document.querySelector(`[data-case-select="${CSS.escape(selectKey)}"]`)?.focus();
  } else if (focusedId && results.querySelector(`#${CSS.escape(focusedId)}`)) {
    document.getElementById(focusedId)?.focus();
  }
}

function setAutoCaseSelected(id, isSelected) {
  if (isSelected) autoCasesSelected.add(id);
  else autoCasesSelected.delete(id);
}

const CASES_ACTIONS = {
  'cases-folder': ({ button }) => {
    const { scope, folder } = button.dataset;
    autoCasesFilters.folder = scope === 'all' ? null : scope === 'unfiled' ? '' : folder;
    autoCasesPage = 0;
    autoCasesSelected.clear();
    activeFolderId = autoCasesFilters.folder || null;
    render();
  },
  'cases-page': ({ button }) => {
    autoCasesPage += Number(button.dataset.direction);
    refreshCasesList();
  },
  'cases-clear-selection': () => {
    autoCasesSelected.clear();
    refreshCasesList();
  },
  'cases-clear-filters': () => {
    autoCasesSelected.clear();
    autoCasesFilters = { ...AUTO_CASES_BLANK_FILTERS };
    autoCasesPage = 0;
    render();
    document.querySelector('#auto-cases-search')?.focus();
  },
  'cases-run': ({ id }) => run({ testId: id }),
  'cases-run-selected': async () => {
    const chosen = project.tests.filter((test) => autoCasesSelected.has(test.id));
    if (!chosen.length) throw new Error('Select a test case');
    if (chosen.some((test) => !test.steps.length)) {
      throw new Error('Configure automation steps for every selected case before running.');
    }
    await run({ testIds: chosen.map((test) => test.id) });
  },
};

document.addEventListener('input', (event) => {
  if (event.target.id !== 'auto-cases-search') return;
  autoCasesFilters.search = event.target.value;
  autoCasesPage = 0;
  refreshCasesList();
});

document.addEventListener('change', (event) => {
  const element = event.target;
  if (element.dataset.casesFilter) {
    autoCasesFilters[element.dataset.casesFilter] = element.value;
    autoCasesPage = 0;
  } else if (element.id === 'auto-cases-size') {
    autoCasesSize = Number(element.value);
    autoCasesPage = 0;
  } else if (element.dataset.caseSelect) {
    setAutoCaseSelected(element.dataset.caseSelect, element.checked);
  } else if (element.id === 'auto-cases-all') {
    for (const test of autoCasesVisiblePage()) setAutoCaseSelected(test.id, element.checked);
  } else {
    return;
  }
  refreshCasesList();
});
