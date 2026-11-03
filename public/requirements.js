/* Requirement list, form, generated drafts and approval, plus the case-context helpers used by the
   case editor. Requirements use the QA project and case model. The server commits generation. */
const CLOUD_ENGINE_NAMES = { claude: 'Claude', chatgpt: 'ChatGPT' };
const DEFAULT_AGENT_OPTIONS = { enabled: true, repairLimit: 1, guidance: '', model: '', mode: '' };
const DEFAULT_REPAIR_LIMIT = 1;
const SECONDS_PER_MINUTE = 60;
const TICK_MS = 1000;
const FINISHED_JOB_STATES = ['cancelled', 'failed', 'interrupted'];

const requirementDrafts = new Map();
const requirementTasks = new Set();
const requirementMessages = new Map();
const requirementCategoryFilters = new Map();
const requirementSelections = new Map();
let requirementCaseDialog = null;
// The personal Claude or ChatGPT connection from My account > AI test generation.
let requirementUserAi = null;

fetch('/api/account/ai')
  .then((response) => (response.ok ? response.json() : null))
  .then((value) => {
    requirementUserAi = value;
    const engine = value?.engines?.qa;
    if (!CLOUD_ENGINE_NAMES[engine]) return;
    // A new, untouched requirement form opened before this loaded adopts the default.
    for (const [key, draft] of requirementDrafts) {
      if (key.endsWith('/new') && !draft.dirty && draft.generationMode === 'agent') draft.generationMode = engine;
    }
    if (requirementRoute() && !requirementBusy()) render();
  })
  .catch(() => {});

const requirementKey = (projectKey, id) => `${projectKey}/${id || 'new'}`;

function requirementRoute() {
  return ['requirement', 'requirement-edit', 'requirement-draft'].includes(route().view);
}

function findRequirement(id, current = project()) {
  return (current.requirements || []).find((item) => item.id === id);
}

function requirementBusy() {
  const id = project()?.id;
  if (requirementTasks.has(id)) return true;
  return Boolean(state?.aiGenerations?.some((job) => job.projectId === id && job.status === 'running'));
}

function requirementEditing() {
  if (requirementBusy()) return true;
  return requirementRoute() && Boolean(requirementDrafts.get(requirementKey(project()?.id, route().id))?.dirty);
}

function defaultGenerationMode(saved) {
  if (saved) return saved.generationMode || 'rules';
  const engine = requirementUserAi?.engines?.qa;
  return CLOUD_ENGINE_NAMES[engine] ? engine : 'agent';
}

function requirementDraft(id) {
  const current = project();
  const key = requirementKey(current.id, id);
  const cached = requirementDrafts.get(key);
  if (!cached || (!cached.dirty && cached.revision !== current.revision)) {
    const saved = findRequirement(id, current);
    requirementDrafts.set(key, {
      title: saved?.title || '',
      url: saved?.url || '',
      description: saved?.description || '',
      moduleName: saved?.moduleName || '',
      pageMetadata: JSON.stringify(saved?.pageMetadata || {}, null, 2),
      categories: saved?.categories || CASE_CATEGORIES,
      agentOptions: saved?.agentOptions || DEFAULT_AGENT_OPTIONS,
      generationMode: defaultGenerationMode(saved),
      inspectBeforeGeneration: saved?.inspectBeforeGeneration || false,
      revision: current.revision,
      dirty: false,
    });
  }
  return requirementDrafts.get(key);
}

/* ---- Requirement list ---------------------------------------------------- */

function requirementCoverage(requirement, caseCount) {
  if (requirement.generation) return requirement.needsGeneration ? 'Requirement changed' : 'Drafts generated';
  return caseCount ? 'Review existing drafts' : 'Not generated';
}

function requirementRow(requirement) {
  const linked = project().tests.filter((test) => (requirement.testIds || []).includes(test.id)).length;
  const caseCount = linked + (requirement.draftCases || []).length;
  return `<tr>
    <td>
      <a class="case-link" href="#requirement/${e(requirement.id)}">${e(requirement.title)}</a>
      <span class="case-sub">${e((requirement.description || '').slice(0, 140))}</span>
    </td>
    <td class="requirement-url">${e(requirement.url)}</td>
    <td>${caseCount}</td>
    <td>${requirementCoverage(requirement, caseCount)}</td>
    <td>${button('open-requirement', 'Open', 'arrow', `data-id="${e(requirement.id)}"`)}</td>
  </tr>`;
}

function requirementsView() {
  const requirements = project().requirements || [];
  const addButton = button('new-requirement', 'Add requirement', 'plus', '', 'primary');
  const pageHeading = heading(
    'Requirement',
    'Describe a workflow and generate test cases from its acceptance criteria and application pages.',
    addButton,
  );
  if (!requirements.length) {
    return (
      pageHeading +
      empty('No requirements yet', 'Add a title, application URL, and workflow description to get started.', addButton)
    );
  }
  return `${pageHeading}
    <section class="panel">
      <div class="panel-head">
        <h2>Requirements</h2>
        <span class="tag">${requirements.length} total</span>
      </div>
      <div class="table-scroll">
        <table class="requirements-list">
          <thead>
            <tr><th>Requirement title</th><th>URL</th><th>Test cases</th><th>Coverage</th><th></th></tr>
          </thead>
          <tbody>${requirements.map(requirementRow).join('')}</tbody>
        </table>
      </div>
    </section>`;
}

/* ---- Draft selection ----------------------------------------------------- */

// Forgets selected drafts that have since been approved or deleted.
function selectedDraftIds(requirementId) {
  const current = project();
  const pending = new Set((findRequirement(requirementId, current)?.draftCases || []).map((draft) => draft.id));
  const key = requirementKey(current.id, requirementId);
  const chosen = requirementSelections.get(key) || new Set();
  for (const id of chosen) {
    if (!pending.has(id)) chosen.delete(id);
  }
  requirementSelections.set(key, chosen);
  return [...chosen];
}

function syncDraftSelection() {
  const count = selectedDraftIds(route().id).length;
  for (const name of ['approve', 'delete']) {
    const node = document.querySelector(`[data-action="${name}-selected-requirement-drafts"]`);
    if (!node) continue;
    node.hidden = !count;
    const label = node.querySelector('.selected-label') || node;
    label.textContent = `${cap(name)} selected (${count})`;
  }
  const all = document.querySelector('[data-select-all-drafts]');
  if (all) {
    const boxes = [...document.querySelectorAll('[data-select-draft]')];
    const checked = boxes.filter((box) => box.checked).length;
    all.checked = Boolean(boxes.length) && checked === boxes.length;
    all.indeterminate = checked > 0 && checked < boxes.length;
  }
}

/* ---- Generated cases table ----------------------------------------------- */

function requirementCaseRow(test, requirement) {
  const drafts = requirement?.draftCases || [];
  const isPending = drafts.some((draft) => draft.id === test.id);
  const href = isPending ? `#requirement-draft/${requirement.id}~${test.id}` : `#case/${test.id}`;
  const number = isPending ? `Draft ${drafts.findIndex((draft) => draft.id === test.id) + 1}` : tc(test);
  const chosen = requirementSelections.get(requirementKey(project().id, requirement.id)) || new Set();
  const qa = test.qa || {};
  const draftIds = `data-requirement-id="${e(requirement.id)}" data-draft-id="${e(test.id)}" ${requirementBusy() ? 'disabled' : ''}`;

  const checkbox = isPending
    ? `<input type="checkbox" data-select-draft="${e(test.id)}" aria-label="Select ${e(test.name)}" ${chosen.has(test.id) ? 'checked' : ''}>`
    : '';
  const preconditions = qa.preconditions ? `<details><summary>Preconditions</summary><p>${e(qa.preconditions)}</p></details>` : '';
  const steps = manualSteps(test)
    .map((step) => `<li><span>${e(step.instruction)}</span><small>Expected: ${e(step.expectedResult)}</small></li>`)
    .join('');
  const actions = isPending
    ? `<div class="case-actions">
        ${button('approve-requirement-draft', 'Approve', 'check', draftIds)}
        ${button('delete-requirement-draft', 'Delete', 'trash', draftIds, 'danger')}
      </div>`
    : '';

  return `<tr>
    <td class="select-col">${checkbox}</td>
    <td class="id-text">${number}</td>
    <td>
      <a class="case-link" href="${e(href)}" data-action="review-requirement-case" data-requirement-id="${e(requirement.id)}" data-case-id="${e(test.id)}">${e(test.name)}</a>
      <span class="case-sub">${e(qa.category || 'Functional')} / ${e(cap(qa.priority || 'medium'))} priority</span>
      ${preconditions}
    </td>
    <td><ol>${steps}</ol></td>
    <td>${e(qa.expectedResult || 'Review the expected results for each step.')}</td>
    <td><span class="tag">${isPending ? 'Pending approval' : 'Approved'}</span>${actions}</td>
  </tr>`;
}

function requirementCaseTable(tests, requirement) {
  if (!tests.length) {
    return empty('No matching test cases', 'Select another category, or complete the requirement above and select Generate Test Cases.');
  }
  const hasPending = tests.some((test) => (requirement?.draftCases || []).some((draft) => draft.id === test.id));
  return `<div class="table-scroll" tabindex="0" role="region" aria-label="Generated test cases">
    <table class="requirement-cases">
      <thead>
        <tr>
          <th class="select-col"><input type="checkbox" data-select-all-drafts aria-label="Select all pending drafts shown" ${hasPending ? '' : 'disabled'}></th>
          <th>TC No.</th>
          <th>Title</th>
          <th>Steps</th>
          <th>Expected result</th>
          <th>Approval</th>
        </tr>
      </thead>
      <tbody>${tests.map((test) => requirementCaseRow(test, requirement)).join('')}</tbody>
    </table>
  </div>`;
}

/* ---- Draft page ----------------------------------------------------------- */

function requirementView(id) {
  return requirementForm(id);
}

function requirementDraftView(key) {
  const [requirementId, draftId] = (key || '').split('~');
  const draft = (findRequirement(requirementId)?.draftCases || []).find((item) => item.id === draftId);
  if (!draft) {
    const backLink = `<a class="button" href="#requirement/${e(requirementId)}">Back to requirement</a>`;
    return empty('Draft not found', 'It may already have been approved. Return to the requirement to review its cases.', backLink);
  }
  const qa = draft.qa || {};
  const draftIds = `data-requirement-id="${e(requirementId)}" data-draft-id="${e(draftId)}" ${requirementBusy() ? 'disabled' : ''}`;
  const actions =
    button('edit-requirement-draft', 'Edit case', 'edit', draftIds) +
    button('approve-requirement-draft', 'Approve test case', 'check', draftIds, 'primary');
  const steps = manualSteps(draft)
    .map(
      (step, index) => `<div class="detail-step">
        <span class="step-number">${index + 1}</span>
        <div><strong>${e(step.instruction)}</strong><p><b>Expected result</b><br>${e(step.expectedResult)}</p></div>
      </div>`,
    )
    .join('');
  return `<a class="back-link" href="#requirement/${e(requirementId)}">${icon('back')}Back to requirement</a>
    ${heading(draft.name, 'Pending approval. Approve this draft to add it to Test cases.', actions)}
    <section class="panel">
      <div class="panel-head"><h2>Test case overview</h2><span class="tag">Pending approval</span></div>
      <div class="prose">${e(qa.description || '')}</div>
      <div class="panel-head"><h2>Preconditions</h2></div>
      <div class="prose">${e(qa.preconditions || 'None specified')}</div>
    </section>
    ${caseGenerationDetails(qa)}
    <section class="panel">
      <div class="panel-head"><h2>Test steps</h2></div>
      <div class="detail-steps">${steps}</div>
      <div class="prose"><b>Overall expected result</b><br>${e(qa.expectedResult || '')}</div>
    </section>`;
}

/* ---- Review popup --------------------------------------------------------- */

function requirementStepGenerator(testCase, isPending, isApproval) {
  const summary = isApproval
    ? 'Review the case details, test steps and expected results below. Confirm approval to save your changes and add this case to Test cases.'
    : 'Review the selected case and generate its action steps. Save your changes when they are ready.';
  return `<p><span class="tag">${isPending ? 'Pending approval' : 'Approved'}</span> ${summary}</p>
    <p class="field-hint">If detailed steps are missing, click Generate test steps. You can edit each action and its expected result before ${isApproval ? 'approving' : 'saving'}.</p>
    <label>Workflow details (optional)
      <textarea name="workflowDetails" aria-label="Workflow details (optional)" maxlength="10000" rows="3" placeholder="For example: Sign in with valid credentials. Click Leave on the Dashboard. Verify the Leaves page is displayed.">${e(testCase.qa?.workflowDetails || '')}</textarea>
    </label>
    <p class="field-hint">The requirement supplies the starting workflow. Add the sign-in, navigation and destination page here when more detail is needed.</p>
    ${button('generate-requirement-steps', 'Generate test steps', 'bolt', '', 'primary')}
    <p id="requirement-step-feedback" class="field-hint" role="status" aria-live="polite"></p>`;
}

// Saves the edits and approves them in one revision-checked commit.
function approvalSubmit(requirementId, caseId) {
  return async (draft, snapshot) => {
    const context = requirementCaseDialog;
    if (!context || context.busy) throw new Error('Wait for the test steps to finish, then confirm approval.');
    context.busy = true;
    const generateButton = $('#dialog [data-action="generate-requirement-steps"]');
    generateButton.disabled = true;
    try {
      await commitRequirementApproval(snapshot, requirementId, [caseId], [draft]);
    } finally {
      if (requirementCaseDialog === context) {
        context.busy = false;
        generateButton.disabled = false;
      }
    }
  };
}

function openRequirementCasePopup(requirementId, caseId, approving = false) {
  const current = project();
  const requirement = findRequirement(requirementId, current);
  const pending = (requirement?.draftCases || []).find((item) => item.id === caseId);
  const isLinked = (requirement?.testIds || []).includes(caseId);
  const testCase = pending || (isLinked && current.tests.find((item) => item.id === caseId));
  if (!testCase || requirementBusy()) {
    notify('This case is not available right now. Refresh the requirement and try again.', true);
    return;
  }

  const isApproval = approving && Boolean(pending);
  const onSaved = () => {
    const cached = requirementDrafts.get(requirementKey(current.id, requirementId));
    const saved = state.projects.find((item) => item.id === current.id);
    if (cached && saved && cached.revision === current.revision) cached.revision = saved.revision;
    render();
  };
  editCase(caseId, null, pending ? requirementId : undefined, onSaved, isApproval ? approvalSubmit(requirementId, caseId) : undefined);

  requirementCaseDialog = { projectId: current.id, requirementId, caseId, revision: current.revision, approving: isApproval };
  $('#dialog-title').textContent = isApproval ? 'Review and approve test case' : 'Review test case';
  if (isApproval) $('#dialog-submit').textContent = 'Confirm approval';

  const generator = document.createElement('section');
  generator.className = 'requirement-step-generator';
  generator.innerHTML = requirementStepGenerator(testCase, Boolean(pending), isApproval);
  $('#dialog-body [name="name"]').closest('label').insertAdjacentElement('afterend', generator);

  // Keeps the steps and the overall result directly below the generator that replaces them.
  const stepsSection = document.createElement('section');
  stepsSection.className = 'requirement-popup-steps';
  generator.insertAdjacentElement('afterend', stepsSection);
  const outcome = $('#dialog-body [name="expectedResult"]');
  outcome.setAttribute('aria-label', 'Overall expected result');
  const stepNodes = [
    $('#dialog-body [data-action="add-step"]').closest('.editor-section-heading'),
    $('#dialog-body .step-editor-toolbar'),
    $('#step-editor-status'),
    $('#step-editors'),
    outcome.closest('label'),
  ];
  for (const node of stepNodes) {
    if (node) stepsSection.append(node);
  }
}

async function generateRequirementStepsInPopup() {
  const context = requirementCaseDialog;
  if (!context || context.busy || !$('#dialog').open) return;
  const isCurrent = () => requirementCaseDialog === context;
  const generateButton = $('#dialog [data-action="generate-requirement-steps"]');
  const feedback = $('#requirement-step-feedback');
  const url = `/api/projects/${context.projectId}/requirements/${context.requirementId}/cases/${context.caseId}/generate-steps`;

  context.busy = true;
  generateButton.disabled = true;
  $('#dialog-submit').disabled = true;
  $('#dialog-error').hidden = true;
  feedback.textContent = 'Creating the steps for this case…';
  try {
    const result = await api(url, 'POST', {
      revision: context.revision,
      workflow: $('#dialog [name="workflowDetails"]').value,
    });
    if (!isCurrent() || !$('#dialog').open) return;
    $('#step-editors').innerHTML = result.steps
      .map((step, index) => stepEditorRow({ ...step, id: crypto.randomUUID() }, index))
      .join('');
    syncStepEditor();
    $('#dialog [name="expectedResult"]').value = result.expectedResult;
    $('#dialog [name="assumptions"]').value = result.assumptions.join('\n');
    const nextStep = context.approving ? 'confirm approval' : 'save this case';
    feedback.textContent = `${result.steps.length} steps generated. Review or edit them, then ${nextStep}.\n${result.warnings.join('\n')}`;
    $('#step-editors').scrollIntoView({ block: 'nearest' });
  } catch (error) {
    if (isCurrent() && $('#dialog').open) {
      feedback.textContent = '';
      $('#dialog-error').textContent = error.message;
      $('#dialog-error').hidden = false;
    }
  } finally {
    if (isCurrent()) {
      context.busy = false;
      generateButton.disabled = false;
      $('#dialog-submit').disabled = false;
    }
  }
}

document.getElementById('dialog').addEventListener('close', () => {
  if (requirementCaseDialog && !$('#dialog').open) {
    requirementCaseDialog = null;
    $('#dialog-submit').disabled = false;
  }
});

/* ---- Requirement form ----------------------------------------------------- */

function cloudEngineLabel(engine) {
  const isMissing = requirementUserAi && !requirementUserAi.hasApiKey?.[engine];
  return `${CLOUD_ENGINE_NAMES[engine]} — my API key${isMissing ? ' (not connected)' : ''}`;
}

function generationModeChoices(draft) {
  return [
    { id: 'agent', name: 'Use ReasonX agents' },
    ...(draft.generationMode === 'ai' ? [{ id: 'ai', name: 'AI - configured provider' }] : []),
    { id: 'claude', name: cloudEngineLabel('claude') },
    { id: 'chatgpt', name: cloudEngineLabel('chatgpt') },
    { id: 'qwen', name: 'Qwen3 14B — local AI' },
    { id: 'rules', name: 'Local rules — no AI key required' },
  ];
}

function requirementAgentFields(draft) {
  const agent = draft.agentOptions || {};
  const settingsChoice = { id: '', name: 'Use Model settings' };
  return `<details class="full">
    <summary>ReasonX agent options</summary>
    <div class="form-grid">
      <label>Agent model<select aria-label="Agent model" name="agentModel">${options([settingsChoice, ...StudioReasonx.modelOptions], agent.model || '')}</select></label>
      <label>Agent reasoning mode<select aria-label="Agent reasoning mode" name="agentMode">${options([settingsChoice, ...StudioReasonx.modeOptions], agent.mode || '')}</select></label>
      <label>Repair limit<input name="agentRepairLimit" type="number" min="0" max="3" value="${e(agent.repairLimit ?? DEFAULT_REPAIR_LIMIT)}" required></label>
      <label class="full">Agent workflow guidance (optional)
        <textarea aria-label="Agent workflow guidance (optional)" name="agentGuidance" maxlength="1000" rows="2">${e(agent.guidance || '')}</textarea>
      </label>
    </div>
    <p class="field-hint">Options apply to Use ReasonX agents. Guidance supplies preferences; schema checks and permissions always apply. Save requirement to retain these choices.</p>
  </details>`;
}

function requirementGenerationFields(draft) {
  const categories = CASE_CATEGORIES.map(
    (category) => `<label><input name="categories" type="checkbox" value="${category}" ${draft.categories.includes(category) ? 'checked' : ''}>${category}</label>`,
  ).join('');
  return `${input('moduleName', 'Module (optional)', draft.moduleName, 'maxlength="120"')}
    <label>Generation method<select name="generationMode" aria-label="Generation method">${options(generationModeChoices(draft), draft.generationMode)}</select></label>
    <p class="full field-hint">ReasonX agents analyze acceptance criteria, design test cases, repair invalid drafts and check coverage. Select ReasonX and save its API key in <a href="${autoUrl(null, { view: 'settings' })}">Model settings</a> first. Claude and ChatGPT use your own API key and model from <a href="/account#ai">My account</a>; the URL is inspected when provided. Qwen uses qwen3:14b directly in Ollama without a key. Selected categories guide ReasonX agents and local rules. AI generation can take several minutes.</p>
    ${requirementAgentFields(draft)}
    <div class="full requirement-categories" role="group" aria-label="Test case categories">${categories}</div>
    <label class="full requirement-check"><input name="inspectBeforeGeneration" type="checkbox" ${draft.inspectBeforeGeneration ? 'checked' : ''}>Inspect URL before generation (optional)</label>
    <details class="full requirement-metadata">
      <summary>Fields, controls, and constraints (optional)</summary>
      <label>Page metadata<textarea name="pageMetadata" aria-label="Page metadata" rows="8" maxlength="120000" spellcheck="false">${e(draft.pageMetadata)}</textarea></label>
      <p class="field-hint">Example: {"fields":[{"name":"Email","type":"email","constraints":{"required":true}}],"controls":[{"name":"Save","type":"submit"}],"constraints":["The page responds within 2 seconds."]}</p>
    </details>`;
}

function readRequirementForm(form) {
  const data = new FormData(form);
  return {
    title: data.get('title'),
    url: data.get('url'),
    description: data.get('description'),
    moduleName: data.get('moduleName'),
    pageMetadata: data.get('pageMetadata'),
    generationMode: data.get('generationMode'),
    categories: data.getAll('categories'),
    inspectBeforeGeneration: data.has('inspectBeforeGeneration'),
    agentOptions: {
      enabled: data.get('generationMode') === 'agent',
      repairLimit: Number(data.get('agentRepairLimit') ?? DEFAULT_REPAIR_LIMIT),
      guidance: data.get('agentGuidance') || '',
      model: data.get('agentModel') || '',
      mode: data.get('agentMode') || '',
    },
  };
}

function generatingMessage(mode) {
  if (mode === 'qwen') return 'Generating drafts with Qwen3 14B. This can take a few minutes.';
  if (CLOUD_ENGINE_NAMES[mode]) return `Generating drafts with ${CLOUD_ENGINE_NAMES[mode]}. This can take a few minutes.`;
  return 'Generating cases. Optional inspection or AI generation can take a few minutes.';
}

function requirementFeedback(draft, message, isBusy) {
  const isHidden = !message && !isBusy;
  const text = isBusy ? generatingMessage(draft.generationMode) : message?.text || '';
  return `<p id="requirement-feedback" class="requirement-feedback ${message?.error ? 'error' : ''}" role="${message?.error ? 'alert' : 'status'}" ${isHidden ? 'hidden' : ''}>${e(text)}</p>`;
}

function requirementCoveragePanel(rows) {
  const items = rows
    .map((row) => `<li><strong>${e(row.id)} - ${e(row.status)}</strong>: ${e(row.text)} (${e(row.source)})<br>${row.caseTitles.map((title) => e(title)).join(', ')}</li>`)
    .join('');
  return `<section class="panel requirement-coverage">
    <h2>Requirement coverage</h2>
    <p>Draft mappings only; coverage is not exhaustive and no tests were executed. Partial means assumptions still need review.</p>
    <ul>${items}</ul>
  </section>`;
}

function requirementInspectionPanel(generation) {
  const pages = (generation.pages || [])
    .map((page) => `<li>${e(page.title || page.url)} — HTTP ${e(page.status)} · ${e(page.controlCount)} controls<br><span class="requirement-url">${e(page.url)}</span></li>`)
    .join('');
  const warnings = (generation.warnings || []).map((warning) => `<li>${e(warning)}</li>`).join('');
  const agentSteps = generation.agent?.length
    ? `<h3>Agent steps</h3><ol>${generation.agent.map((step) => `<li><b>${e(step.stage)}</b> — ${e(step.detail)}</li>`).join('')}</ol>`
    : '';
  return `<section class="panel requirement-coverage">
    <div class="panel-head">
      <div>
        <h2>Inspection and coverage</h2>
        <p>Generated ${e(new Date(generation.at).toLocaleString())} · ${(generation.pages || []).length} pages inspected</p>
      </div>
      <span class="tag">Cases await execution</span>
    </div>
    <div class="prose">${e(generation.summary)}</div>
    <details>
      <summary>Inspected pages and coverage gaps</summary>
      <ul>${pages}</ul>
      <ul>${warnings}</ul>
      ${agentSteps}
    </details>
  </section>`;
}

function requirementCasesPanel(id, saved, isBusy) {
  const current = project();
  const tests = [...(saved?.draftCases || []), ...current.tests.filter((test) => (saved?.testIds || []).includes(test.id))];
  const category = requirementCategoryFilters.get(requirementKey(current.id, id)) || '';
  const visibleTests = tests.filter((test) => !category || (test.qa?.category || 'Functional') === category);
  const hasVisibleDrafts = visibleTests.some((test) => (saved?.draftCases || []).some((draft) => draft.id === test.id));
  const picked = selectedDraftIds(id).length;
  const requirementId = `data-requirement-id="${e(id)}"`;
  const disabled = isBusy ? 'disabled' : '';
  const selectedExtra = `${requirementId} ${picked ? '' : 'hidden'} ${disabled}`;

  return `<section class="panel">
    <div class="panel-head">
      <div>
        <h2>Test cases</h2>
        <p>Review and edit drafts here. Only approved cases appear on the Test cases page.</p>
      </div>
      <div class="heading-actions">
        <select id="requirement-category" aria-label="Filter generated cases by category">${options(CASE_CATEGORIES, category, 'All categories')}</select>
        ${button('approve-selected-requirement-drafts', `<span class="selected-label">Approve selected (${picked})</span>`, 'check', selectedExtra)}
        ${button('delete-selected-requirement-drafts', `<span class="selected-label">Delete selected (${picked})</span>`, 'trash', selectedExtra, 'danger')}
        ${hasVisibleDrafts ? button('approve-requirement-draft', 'Approve shown drafts', 'check', `${requirementId} ${disabled}`, 'primary') : ''}
        ${button('export-requirement-cases', 'Export CSV', 'download', visibleTests.length ? '' : 'disabled')}
        <span class="tag">${visibleTests.length} of ${tests.length} cases</span>
      </div>
    </div>
    ${requirementCaseTable(visibleTests, saved)}
  </section>`;
}

function requirementForm(id) {
  const current = project();
  const saved = findRequirement(id, current);
  if (id && !saved) {
    return empty('Requirement not found', 'It may have been deleted.', '<a class="button" href="#requirements">Back to requirements</a>');
  }
  const draft = requirementDraft(id);
  const isBusy = requirementBusy();
  const message = requirementMessages.get(requirementKey(current.id, id));
  const deleteButton = saved
    ? button('delete-requirement', 'Delete requirement', 'trash', `data-id="${e(id)}" ${isBusy ? 'disabled' : ''}`, 'danger')
    : '';
  const statusText = draft.dirty ? 'Unsaved changes' : saved ? 'Saved requirement' : 'New requirement';
  const changedNotice = saved?.needsGeneration && saved?.generation
    ? '<p class="notice warning">This requirement changed since the last generation. Existing cases are available below; generate again to add missing scenarios.</p>'
    : '';

  return `<a class="back-link" href="#requirements">${icon('back')}Back to requirements</a>
    ${heading(saved ? 'Requirement' : 'Add requirement', 'Add the starting URL and describe the workflow, rules, and expected outcomes.', deleteButton)}
    <form id="requirement-form" class="panel requirement-form" data-project-id="${e(current.id)}" data-requirement-id="${e(id || '')}">
      <fieldset ${isBusy ? 'disabled' : ''}>
        <div class="form-grid">
          ${input('title', 'Requirement title', draft.title, 'required maxlength="160" placeholder="For example: Customer sign-in"')}
          ${input('url', 'URL', draft.url, 'type="url" required maxlength="2000" placeholder="https://example.com/login"')}
          <label class="full">Description
            <textarea name="description" aria-label="Description" required maxlength="10000" rows="6"
              placeholder="Describe the workflow, valid and invalid inputs, business rules, and expected results.">${e(draft.description)}</textarea>
          </label>
          ${requirementGenerationFields(draft)}
        </div>
        <p class="field-hint">Generation creates drafts for review. Check steps, expected results and assumptions, then approve cases to add them to Test cases. Generation does not execute tests.</p>
        <div class="requirement-form-actions">
          <span id="requirement-draft-status">${statusText}</span>
          <button class="button" type="submit" name="operation" value="save">${icon('save')}Save requirement</button>
          <button class="button primary" type="submit" name="operation" value="generate">${icon('bolt')}Generate Test Cases</button>
        </div>
      </fieldset>
      ${isBusy ? '<button type="button" class="button" data-action="cancel-requirement-generation">Cancel generation</button>' : ''}
      ${requirementFeedback(draft, message, isBusy)}
    </form>
    ${changedNotice}
    ${saved?.generation?.coverage ? requirementCoveragePanel(saved.generation.coverage) : ''}
    ${saved?.generation ? requirementInspectionPanel(saved.generation) : ''}
    ${requirementCasesPanel(id, saved, isBusy)}`;
}

/* ---- Saving and generating ------------------------------------------------ */

function acceptRequirementProject(saved) {
  const index = state.projects.findIndex((item) => item.id === saved.id);
  if (index >= 0 && state.projects[index].revision <= saved.revision) state.projects[index] = saved;
}

function submissionLabel(mode, isGenerating) {
  if (!isGenerating) return 'Saving requirement…';
  if (mode === 'qwen') return 'Saving requirement and generating drafts with Qwen3 14B…';
  if (CLOUD_ENGINE_NAMES[mode]) return `Saving requirement and generating drafts with ${CLOUD_ENGINE_NAMES[mode]}…`;
  return 'Saving requirement and generating test cases…';
}

function formatElapsed(startedAt) {
  const total = Math.round((Date.now() - startedAt) / TICK_MS);
  if (total < SECONDS_PER_MINUTE) return `${total}s`;
  return `${Math.floor(total / SECONDS_PER_MINUTE)}m ${String(total % SECONDS_PER_MINUTE).padStart(2, '0')}s`;
}

// Shows the running job's stage and elapsed time until the returned function stops it.
function startSubmissionTicker(projectKey, label) {
  const startedAt = Date.now();
  const tick = () => {
    const node = document.getElementById('requirement-feedback');
    if (!node || node.classList.contains('error')) return;
    const job = state.aiGenerations?.find((item) => item.projectId === projectKey && item.status === 'running');
    const stage = job ? StudioReasonx.agentStageLabel(job.stage, job.detail) || `Agent stage: ${job.stage}` : label;
    node.hidden = false;
    node.textContent = `${stage} · ${formatElapsed(startedAt)}`;
  };
  tick();
  const timer = setInterval(tick, TICK_MS);
  return () => clearInterval(timer);
}

function parsePageMetadata(text) {
  try {
    return JSON.parse(text.trim() || '{}');
  } catch {
    throw new Error('The optional page details could not be read. Clear the Page metadata box and try again, or ask your team to correct its contents.');
  }
}

function generationResultText(generated) {
  const kept = generated.existingCount ? ` ${generated.existingCount} matching drafts or approved cases were kept.` : '';
  return `${generated.addedCount} drafts generated.${kept} Review and approve drafts below to add them to Test cases.`;
}

// A failed save keeps the typed values and shows the reason next to the form.
async function submitRequirement(form, isGenerating) {
  const projectKey = form.dataset.projectId;
  const id = form.dataset.requirementId || undefined;
  const key = requirementKey(projectKey, id);
  if (requirementTasks.has(projectKey)) return;

  const draft = requirementDrafts.get(key);
  const values = readRequirementForm(form);
  Object.assign(draft, values, { dirty: true });
  requirementTasks.add(projectKey);
  requirementMessages.delete(key);
  form.querySelector('fieldset').disabled = true;
  const feedback = form.querySelector('#requirement-feedback');
  feedback.hidden = false;
  feedback.classList.remove('error');
  const stopTicker = startSubmissionTicker(projectKey, submissionLabel(values.generationMode, isGenerating));

  const root = `/api/projects/${encodeURIComponent(projectKey)}/requirements`;
  let savedId = id;
  let hasSaved = false;
  try {
    const pageMetadata = parsePageMetadata(values.pageMetadata);
    if (!values.categories.length) throw new Error('Select at least one test case category.');
    const body = {
      title: values.title,
      url: values.url,
      description: values.description,
      moduleName: values.moduleName,
      pageMetadata,
      categories: values.categories,
      generationMode: values.generationMode,
      agentOptions: values.agentOptions,
      inspectBeforeGeneration: values.inspectBeforeGeneration,
      revision: draft.revision,
    };
    const result = id ? await api(`${root}/${encodeURIComponent(id)}`, 'PUT', body) : await api(root, 'POST', body);
    acceptRequirementProject(result.project);
    savedId = result.requirement.id;
    hasSaved = true;
    requirementDrafts.delete(key);
    requirementDrafts.delete(requirementKey(projectKey, savedId));
    if (project()?.id === projectKey && requirementRoute() && route().id === id) {
      history.replaceState(null, '', `#requirement/${savedId}`);
      render();
    }

    let text = 'Requirement saved.';
    if (isGenerating) {
      const generated = await api(`${root}/${encodeURIComponent(savedId)}/generate`, 'POST', { revision: result.project.revision });
      acceptRequirementProject(generated.project);
      requirementDrafts.delete(requirementKey(projectKey, savedId));
      text = generationResultText(generated);
    }
    requirementMessages.set(requirementKey(projectKey, savedId), { text });
    notify(text);
  } catch (error) {
    requirementMessages.set(requirementKey(projectKey, hasSaved ? savedId : id), { text: error.message, error: true });
    notify(error.message, true);
  } finally {
    stopTicker();
    requirementTasks.delete(projectKey);
    if (project()?.id === projectKey && requirementRoute()) render();
  }
}

/* ---- Approval and deletion ------------------------------------------------ */

async function commitRequirementApproval(snapshot, requirementId, draftIds, editedDrafts) {
  if (requirementTasks.has(snapshot.id)) {
    throw new Error('Another action is still running for this project. Wait for it to finish, then try again.');
  }
  const key = requirementKey(snapshot.id, requirementId);
  const url = `/api/projects/${encodeURIComponent(snapshot.id)}/requirements/${encodeURIComponent(requirementId)}/approve`;
  requirementTasks.add(snapshot.id);
  render();
  try {
    const result = await api(url, 'POST', {
      revision: snapshot.revision,
      draftIds,
      ...(editedDrafts ? { editedDrafts } : {}),
    });
    acceptRequirementProject(result.project);
    const cached = requirementDrafts.get(key);
    if (cached && cached.revision === snapshot.revision) cached.revision = result.project.revision;
    const text = `${result.approvedCount} test cases approved and added to Test cases.`;
    requirementMessages.set(key, { text });
    notify(text);
    if (project()?.id === snapshot.id && route().view === 'requirement-draft' && draftIds.length === 1) {
      location.hash = `case/${draftIds[0]}`;
    }
    return result;
  } finally {
    requirementTasks.delete(snapshot.id);
    render();
  }
}

function showApprovalError(projectKey, requirementId, error) {
  requirementMessages.set(requirementKey(projectKey, requirementId), { text: error.message, error: true });
  notify(error.message, true);
  render();
}

// One draft opens its review popup. Without a draft id, every draft in the current filter is approved.
async function approveRequirementDrafts(requirementId, draftId) {
  const current = project();
  const requirement = findRequirement(requirementId, current);
  if (!requirement || requirementBusy()) return;
  if (draftId) {
    openRequirementCasePopup(requirementId, draftId, true);
    return;
  }
  const category = requirementCategoryFilters.get(requirementKey(current.id, requirementId));
  const draftIds = (requirement.draftCases || [])
    .filter((item) => !category || (item.qa?.category || 'Functional') === category)
    .map((item) => item.id);
  if (!draftIds.length) {
    notify('Choose at least one draft to approve.', true);
    return;
  }
  try {
    await commitRequirementApproval(current, requirementId, draftIds);
  } catch (error) {
    showApprovalError(current.id, requirementId, error);
  }
}

async function approveSelectedRequirementDrafts(requirementId) {
  const ids = selectedDraftIds(requirementId);
  if (!ids.length) return;
  const current = project();
  try {
    await commitRequirementApproval(current, requirementId, ids);
    requirementSelections.delete(requirementKey(current.id, requirementId));
  } catch (error) {
    showApprovalError(current.id, requirementId, error);
  }
}

function deleteRequirementDraft(requirementId, draftId) {
  const current = project();
  const draft = (findRequirement(requirementId, current)?.draftCases || []).find((item) => item.id === draftId);
  if (!draft || requirementBusy()) return;
  const url = `/api/projects/${encodeURIComponent(current.id)}/requirements/${encodeURIComponent(requirementId)}/drafts/${encodeURIComponent(draftId)}`;
  modal(
    'Delete draft?',
    `<p class="field-hint">Delete the draft ${e(draft.name)}? It has not been approved, so it is removed permanently.</p>`,
    async () => {
      const result = await api(url, 'DELETE', { revision: current.revision });
      acceptRequirementProject(result.project);
      render();
      notify('Draft deleted.');
    },
    'Delete draft',
  );
}

function deleteSelectedRequirementDrafts(requirementId) {
  const current = project();
  const ids = selectedDraftIds(requirementId);
  if (!ids.length || requirementBusy()) return;
  const noun = (count) => `draft${count === 1 ? '' : 's'}`;
  const url = `/api/projects/${encodeURIComponent(current.id)}/requirements/${encodeURIComponent(requirementId)}/drafts`;
  modal(
    'Delete selected drafts?',
    `<p class="field-hint">Delete ${ids.length} unapproved ${noun(ids.length)}? They are removed permanently. Approved test cases are not affected.</p>`,
    async () => {
      const result = await api(url, 'DELETE', { revision: current.revision, draftIds: ids });
      requirementSelections.delete(requirementKey(current.id, requirementId));
      acceptRequirementProject(result.project);
      render();
      notify(`${result.deletedCount} ${noun(result.deletedCount)} deleted.`);
    },
    'Delete drafts',
  );
}

function deleteRequirement(id) {
  const current = project();
  const requirement = findRequirement(id, current);
  if (!requirement || requirementBusy()) return;
  const projectKey = current.id;
  const { revision } = current;
  modal(
    'Delete requirement?',
    `<p class="field-hint">Delete ${e(requirement.title)}? Its pending drafts will be removed. Approved test cases and execution history will remain in the workspace.</p>`,
    async () => {
      const result = await api(`/api/projects/${encodeURIComponent(projectKey)}/requirements/${encodeURIComponent(id)}`, 'DELETE', { revision });
      acceptRequirementProject(result.project);
      requirementDrafts.delete(requirementKey(projectKey, id));
      if (project()?.id === projectKey) {
        location.hash = 'requirements';
        render();
      }
      notify('Requirement deleted. Test cases were kept.');
    },
    'Delete requirement',
  );
}

function cancelRequirementGeneration() {
  const job = state.aiGenerations?.find((item) => item.projectId === project().id && item.status === 'running');
  if (!job) {
    notify('Waiting for generation to start. Try cancel again shortly.');
    return;
  }
  api(`/api/generations/${job.id}/cancel`, 'POST', {})
    .then(() => notify('Cancellation requested.'))
    .catch((error) => notify(error.message, true));
}

// Unapproved cases are labelled by the Draft prefix in the ID column.
function exportRequirementCases() {
  const current = project();
  const requirement = findRequirement(route().id, current);
  const category = requirementCategoryFilters.get(requirementKey(current.id, route().id));
  const linked = current.tests.filter((test) => (requirement?.testIds || []).includes(test.id));
  const tests = [...(requirement?.draftCases || []), ...linked].filter(
    (test) => !category || (test.qa?.category || 'Functional') === category,
  );
  const headers = [
    'ID', 'Title', 'Priority', 'Type', 'Assignee', 'Execution', 'Last result', 'Description', 'Preconditions', 'Steps',
    'Expected result', 'Module', 'Category', 'Test data', 'Requirement reference', 'Assumptions', 'Workflow details', 'Generation ID',
  ];
  const rows = tests.map((test) => {
    const qa = test.qa || {};
    const steps = manualSteps(test).map((step, index) => `${index + 1}. ${step.instruction}\nExpected: ${step.expectedResult}`);
    return [
      test.tcNumber ? tc(test) : `Draft ${test.id.slice(0, 8)}`,
      test.name,
      qa.priority || 'medium',
      qa.type || 'functional',
      qa.owner,
      mode(test),
      latest(test),
      qa.description,
      qa.preconditions,
      steps.join('\n'),
      qa.expectedResult,
      qa.module,
      qa.category || 'Functional',
      JSON.stringify(qa.testData || []),
      qa.requirementReference,
      (qa.assumptions || []).join('\n'),
      qa.workflowDetails,
      qa.generationId,
    ];
  });
  downloadCsv('qa-studio-requirement-cases.csv', headers, rows);
  notify('Test cases exported');
}

/* ---- Events ---------------------------------------------------------------- */

const REQUIREMENT_ACTIONS = {
  'delete-requirement': (control) => deleteRequirement(control.dataset.id),
  'cancel-requirement-generation': cancelRequirementGeneration,
  'generate-requirement-steps': generateRequirementStepsInPopup,
  'approve-requirement-draft': (control) => approveRequirementDrafts(control.dataset.requirementId, control.dataset.draftId),
  'approve-selected-requirement-drafts': (control) => approveSelectedRequirementDrafts(control.dataset.requirementId),
  'delete-selected-requirement-drafts': (control) => deleteSelectedRequirementDrafts(control.dataset.requirementId),
  'delete-requirement-draft': (control) => deleteRequirementDraft(control.dataset.requirementId, control.dataset.draftId),
  'edit-requirement-draft': (control) => openRequirementCasePopup(control.dataset.requirementId, control.dataset.draftId),
  'export-requirement-cases': exportRequirementCases,
};

document.addEventListener('input', (event) => {
  const form = event.target.closest?.('#requirement-form');
  if (!form) return;
  const draft = requirementDrafts.get(requirementKey(form.dataset.projectId, form.dataset.requirementId));
  if (!draft) return;
  Object.assign(draft, readRequirementForm(form), { dirty: true });
  const status = form.querySelector('#requirement-draft-status');
  if (status) status.textContent = 'Unsaved changes';
});

document.addEventListener('submit', (event) => {
  if (event.target.id !== 'requirement-form') return;
  event.preventDefault();
  submitRequirement(event.target, event.submitter?.value === 'generate');
});

function selectDrafts(key, ids, isChecked) {
  const chosen = requirementSelections.get(key) || new Set();
  for (const id of ids) {
    if (isChecked) chosen.add(id);
    else chosen.delete(id);
  }
  requirementSelections.set(key, chosen);
  syncDraftSelection();
}

document.addEventListener('change', (event) => {
  const { target } = event;
  const key = project() && requirementKey(project().id, route().id);
  if (target.matches?.('[data-select-draft]')) {
    selectDrafts(key, [target.dataset.selectDraft], target.checked);
  } else if (target.matches?.('[data-select-all-drafts]')) {
    const boxes = [...document.querySelectorAll('[data-select-draft]')];
    for (const box of boxes) box.checked = target.checked;
    selectDrafts(key, boxes.map((box) => box.dataset.selectDraft), target.checked);
  } else if (target.id === 'requirement-category') {
    requirementCategoryFilters.set(key, target.value);
    render();
  }
});

document.addEventListener('click', (event) => {
  const control = event.target.closest('[data-action]');
  if (!control || control.disabled) return;
  if (control.dataset.action === 'review-requirement-case') {
    // Modifier keys keep the link's normal behaviour, such as opening in a new tab.
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openRequirementCasePopup(control.dataset.requirementId, control.dataset.caseId);
    return;
  }
  REQUIREMENT_ACTIONS[control.dataset.action]?.(control);
});

// Keeps open requirement work in step when the case editor saves the project, such as after adding a folder.
document.addEventListener('studio:project-revision', ({ detail }) => {
  if (requirementCaseDialog?.projectId === detail.projectId && requirementCaseDialog.revision === detail.from) {
    requirementCaseDialog.revision = detail.to;
  }
  for (const [key, cached] of requirementDrafts) {
    if (key.startsWith(`${detail.projectId}/`) && cached.revision === detail.from) cached.revision = detail.to;
  }
});

function updateRequirementAgentProgress() {
  const id = project()?.id;
  const job = state?.aiGenerations?.find((item) => item.projectId === id && item.kind === 'requirements');
  if (!requirementRoute() || !job) return;
  const node = document.getElementById('requirement-feedback');
  if (!node) return;
  if (job.status === 'running') {
    node.hidden = false;
    node.textContent = StudioReasonx.agentStageLabel(job.stage, job.detail) || `Agent stage: ${job.stage}`;
  } else if (FINISHED_JOB_STATES.includes(job.status) && !requirementTasks.has(id)) {
    node.hidden = false;
    node.textContent = job.error;
    node.classList.add('error');
  }
}

/* Requirement and generation context shown and edited on test cases. */
// .prose keeps line breaks from user text, so this markup carries no template whitespace.
function contextField(label, value) {
  return `<div><b>${label}</b><br>${e(value)}</div>`;
}

function caseGenerationDetails(qa) {
  const testData = (qa.testData || []).map((item) => `${item.field}: ${item.value}`).join('\n');
  const assumptions = (qa.assumptions || []).join('\n');
  return `<section class="panel">
    <div class="panel-head"><h2>Case context</h2></div>
    <div class="prose case-context">${[
      contextField('Requirement reference', qa.requirementReference || 'Not specified'),
      contextField('Test data', testData || 'Not specified'),
      contextField('Assumptions to review', assumptions || 'No assumptions recorded.'),
    ].join('')}</div>
  </section>`;
}

function caseGenerationEditor(qa) {
  return `<div class="form-grid">
      ${input('module', 'Module', qa.module || '', 'maxlength="120"')}
      <label>Category<select name="category" aria-label="Category">${options(CASE_CATEGORIES, qa.category || 'Functional')}</select></label>
    </div>
    ${area('requirementReference', 'Requirement reference', qa.requirementReference || '')}
    ${area('testData', 'Test data (JSON array)', JSON.stringify(qa.testData || [], null, 2), 'aria-label="Test data (JSON array)"')}
    ${area('assumptions', 'Assumptions (one per line)', (qa.assumptions || []).join('\n'), 'aria-label="Assumptions (one per line)"')}
    <p class="field-hint">Test data format: [{"field":"Email","value":"tester@example.test"}]. Use dummy values for credentials.</p>`;
}

function parseCaseTestData(text) {
  let testData;
  try {
    testData = JSON.parse(text || '[]');
  } catch {
    throw new Error('The optional test data could not be read. Clear the Test data box and try again, or ask your team to correct it.');
  }
  const isValid =
    Array.isArray(testData) &&
    testData.length <= 100 &&
    testData.every((item) => item && typeof item.field === 'string' && typeof item.value === 'string');
  if (!isValid) {
    throw new Error('Each test data entry needs a field name and a sample value, with no more than 100 entries. Correct the Test data box or clear it and try again.');
  }
  return testData;
}

function caseGenerationValues(values) {
  const assumptions = (values.assumptions || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const result = {
    module: values.module,
    category: values.category,
    requirementReference: values.requirementReference,
    testData: parseCaseTestData(values.testData),
    assumptions,
  };
  if (values.workflowDetails !== undefined) result.workflowDetails = values.workflowDetails;
  return result;
}
