/* Requirement list plus the case-context helpers used by the case editor.
   Generation, drafts and approval arrive with the full Requirement screens. */
const requirementDrafts = new Map();

const requirementKey = (projectKey, id) => `${projectKey}/${id || 'new'}`;

function requirementRoute() {
  return ['requirement', 'requirement-edit', 'requirement-draft'].includes(route().view);
}

function requirementBusy() {
  const id = project()?.id;
  return Boolean(state?.aiGenerations?.some((job) => job.projectId === id && job.status === 'running'));
}

function requirementEditing() {
  if (requirementBusy()) return true;
  return requirementRoute() && Boolean(requirementDrafts.get(requirementKey(project()?.id, route().id))?.dirty);
}

function requirementDraft(id) {
  const current = project();
  const key = requirementKey(current.id, id);
  const cached = requirementDrafts.get(key);
  if (!cached || (!cached.dirty && cached.revision !== current.revision)) {
    const saved = (current.requirements || []).find((item) => item.id === id);
    requirementDrafts.set(key, {
      title: saved?.title || '',
      url: saved?.url || '',
      description: saved?.description || '',
      revision: current.revision,
      dirty: false,
      feedback: '',
      isError: false,
    });
  }
  return requirementDrafts.get(key);
}

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

function requirementFeedback(draft) {
  const role = draft.isError ? 'alert' : 'status';
  const hidden = draft.feedback ? '' : 'hidden';
  return `<p id="requirement-feedback" class="requirement-feedback ${draft.isError ? 'error' : ''}" role="${role}" ${hidden}>${e(draft.feedback)}</p>`;
}

function requirementForm(id) {
  const saved = id ? (project().requirements || []).find((item) => item.id === id) : null;
  const backLink = `<a class="button" href="#requirements">Back to requirements</a>`;
  if (id && !saved) return empty('Requirement not found', 'It may have been deleted.', backLink);
  const draft = requirementDraft(id);
  return `<a class="back-link" href="#requirements">${icon('back')}Back to requirements</a>
    ${heading(saved ? 'Requirement' : 'Add requirement', 'Add the starting URL and describe the workflow, rules, and expected outcomes.')}
    <form id="requirement-form" class="panel requirement-form" data-project-id="${e(project().id)}" data-requirement-id="${e(id || '')}">
      <fieldset>
        <div class="form-grid">
          ${input('title', 'Requirement title', draft.title, 'required maxlength="160" placeholder="For example: Customer sign-in"')}
          ${input('url', 'URL', draft.url, 'type="url" required maxlength="2000" placeholder="https://example.com/login"')}
          <label class="full">Description
            <textarea name="description" aria-label="Description" required maxlength="10000" rows="6"
              placeholder="Describe the workflow, valid and invalid inputs, business rules, and expected results.">${e(draft.description)}</textarea>
          </label>
        </div>
        <p class="field-hint">Generating and reviewing test cases from a requirement is not available in this version yet.</p>
        <div class="requirement-form-actions">
          <span id="requirement-draft-status">${draft.dirty ? 'Unsaved changes' : saved ? 'Saved requirement' : 'New requirement'}</span>
          <button type="submit" class="button primary">${icon('save')}Save requirement</button>
        </div>
      </fieldset>
      ${requirementFeedback(draft)}
    </form>`;
}

function requirementView(id) {
  return requirementForm(id);
}

function requirementDraftView(key) {
  const [requirementId] = (key || '').split('~');
  const backLink = `<a class="button" href="#requirement/${e(requirementId)}">Back to requirement</a>`;
  return empty('Draft not found', 'It may already have been approved. Return to the requirement to review its cases.', backLink);
}

function acceptRequirementProject(saved) {
  const index = state.projects.findIndex((item) => item.id === saved.id);
  if (index >= 0 && state.projects[index].revision <= saved.revision) state.projects[index] = saved;
}

function updateRequirementDraftFromForm(form) {
  const draft = requirementDraft(form.dataset.requirementId);
  draft.title = form.elements.title.value;
  draft.url = form.elements.url.value;
  draft.description = form.elements.description.value;
  draft.dirty = true;
  return draft;
}

function showRequirementFeedback(form, draft, message, isError) {
  draft.feedback = message;
  draft.isError = isError;
  const node = form.querySelector('#requirement-feedback');
  node.textContent = message;
  node.classList.toggle('error', isError);
  node.setAttribute('role', isError ? 'alert' : 'status');
  node.hidden = !message;
}

// A failed save keeps the typed values and shows the reason next to the form.
async function submitRequirement(form) {
  const draft = updateRequirementDraftFromForm(form);
  const requirementId = form.dataset.requirementId;
  const root = `/api/projects/${encodeURIComponent(form.dataset.projectId)}/requirements`;
  const fieldset = form.querySelector('fieldset');
  const body = {
    title: draft.title,
    url: draft.url,
    description: draft.description,
    revision: project().revision,
  };
  fieldset.disabled = true;
  showRequirementFeedback(form, draft, '', false);
  try {
    const result = requirementId
      ? await api(`${root}/${encodeURIComponent(requirementId)}`, 'PUT', body)
      : await api(root, 'POST', body);
    acceptRequirementProject(result.project);
    requirementDrafts.delete(requirementKey(form.dataset.projectId, requirementId));
    if (requirementId) render();
    else go(`requirement/${result.requirement.id}`);
    notify('Requirement saved.');
  } catch (error) {
    showRequirementFeedback(form, draft, error.message, true);
  } finally {
    fieldset.disabled = false;
  }
}

document.addEventListener('input', (event) => {
  const form = event.target.closest?.('#requirement-form');
  if (!form) return;
  updateRequirementDraftFromForm(form);
  form.querySelector('#requirement-draft-status').textContent = 'Unsaved changes';
});

document.addEventListener('submit', (event) => {
  if (event.target.id !== 'requirement-form') return;
  event.preventDefault();
  submitRequirement(event.target);
});

// Polling updates this as generations progress once the full Requirement screens exist.
function updateRequirementAgentProgress() {}

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
