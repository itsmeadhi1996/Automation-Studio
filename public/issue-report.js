// The Raise bug button and popup, shared by QA Studio and Automation Studio.
(() => {
  const REPORTABLE = ['failed', 'blocked', 'interrupted'];
  const ALLOWED_FILES = '.png,.jpg,.jpeg,.gif,.webp,.mp4,.webm,.mov,.txt,.log,.json,.csv,.pdf,.zip';
  const ALLOWED_EXTENSIONS = new Set(ALLOWED_FILES.split(','));

  let tracker = {};
  let issues = [];

  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

  const notify = (message, isError = false) => StudioUI.notify(message, isError);

  async function request(url, options = {}) {
    const response = await StudioUI.request(url, options);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || 'Request failed'), { status: response.status });
    return result;
  }

  const postJson = (url, body) =>
    request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  function formatSize(bytes) {
    return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
  }

  function dialogElement() {
    let dialog = document.querySelector('#issue-dialog');
    if (dialog) return dialog;
    document.body.insertAdjacentHTML(
      'beforeend',
      `<dialog id="issue-dialog" class="issue-dialog" aria-labelledby="issue-dialog-title">
        <form novalidate>
          <div class="dialog-heading">
            <h2 id="issue-dialog-title">Raise bug in Jira</h2>
            <button type="button" class="icon-button" data-issue-close aria-label="Close dialog">${StudioUI.icon('close')}</button>
          </div>
          <div id="issue-dialog-body" class="issue-form"></div>
          <p id="issue-dialog-error" class="error-text" role="alert" hidden></p>
          <div class="dialog-actions" id="issue-dialog-actions"></div>
        </form>
      </dialog>`,
    );
    dialog = document.querySelector('#issue-dialog');
    dialog.querySelector('form').addEventListener('submit', (event) => event.preventDefault());
    dialog.addEventListener('click', (event) => {
      if (event.target.closest('[data-issue-close]')) dialog.close();
    });
    return dialog;
  }

  const textField = (name, label, value, extra = '') =>
    `<label>${label}<input name="${name}" value="${esc(value)}" ${extra}></label>`;

  const textArea = (name, label, value, extra = '') =>
    `<label>${label}<textarea name="${name}" rows="5" ${extra}>${esc(value)}</textarea></label>`;

  const choices = (items, selected) =>
    items.map((item) => `<option value="${esc(item.id)}" ${item.id === selected ? 'selected' : ''}>${esc(item.name)}</option>`).join('');

  function jiraFieldsMarkup(options) {
    const priority = options.priority?.options.length
      ? `<label>Priority<select name="priorityId">${choices(options.priority.options, options.priority.defaultId)}</select></label>`
      : '';
    const severityHint = options.severity.inJira ? '' : '<small class="field-hint">Added to the description, because this issue type has no Severity field.</small>';
    const severity = `<label>Severity<select name="severity"><option value="">Not set</option>${choices(options.severity.options)}</select>${severityHint}</label>`;
    return priority + severity;
  }

  function evidenceMarkup(evidence) {
    return evidence
      .map((item) => {
        const size = formatSize(item.size);
        const note = item.tooLarge ? ` · over the 10 MB limit, download it from Run history` : '';
        return `<label class="issue-evidence ${item.tooLarge ? 'too-large' : ''}">
          <input type="checkbox" name="evidence" value="${esc(item.id)}" ${item.checked && !item.tooLarge ? 'checked' : ''} ${item.tooLarge ? 'disabled' : ''}>
          <span>${esc(item.label)} <small>(${size}${note})</small></span>
        </label>`;
      })
      .join('');
  }

  function attachmentsMarkup(evidence, canAttach) {
    if (!canAttach) return '<p class="field-hint">The connected Jira account cannot add attachments in this project.</p>';
    return `${evidenceMarkup(evidence)}
      <label>Add your own files
        <input type="file" id="issue-files" multiple accept="${ALLOWED_FILES}">
        <small class="field-hint">Up to 10 MB each. Images, video, logs, PDF and zip.</small>
      </label>
      <p class="field-hint">Screenshots and traces can show test data. Check them before sending.</p>`;
  }

  function existingMarkup(existing) {
    if (!existing.length) return '';
    const links = existing
      .map((issue) => `<a href="${esc(issue.url)}" target="_blank" rel="noopener noreferrer">${esc(issue.key)}</a> ${esc(issue.summary)}`)
      .join('<br>');
    return `<div class="issue-existing" role="note"><strong>Already raised for this test case</strong><br>${links}</div>`;
  }

  function validFiles(files) {
    return files.find((file) => file.size > 10 * 1024 * 1024)
      ? 'Attachments can be up to 10 MB each.'
      : files.find((file) => !ALLOWED_EXTENSIONS.has(file.name.slice(file.name.lastIndexOf('.')).toLowerCase())) &&
          'This file type cannot be attached. Use images, video, logs, PDF or zip.';
  }

  async function uploadAll(requestId, uploads) {
    const failed = [];
    for (const upload of uploads) {
      try {
        const route = `/api/issues/${requestId}/attachments`;
        if (upload.file) {
          await request(route, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(upload.file.name) },
            body: upload.file,
          });
        } else {
          await postJson(route, { evidenceId: upload.evidenceId });
        }
      } catch (error) {
        failed.push({ ...upload, error: error.message });
      }
    }
    return failed;
  }

  function showAttachmentFailures(dialog, issue, requestId, failed) {
    dialog.querySelector('#issue-dialog-title').textContent = `${issue.key} created`;
    dialog.querySelector('#issue-dialog-error').hidden = true;
    dialog.querySelector('#issue-dialog-body').innerHTML = `
      <p>The issue is in Jira, but ${failed.length} ${failed.length === 1 ? 'file' : 'files'} did not upload.
        <a href="${esc(issue.url)}" target="_blank" rel="noopener noreferrer">Open ${esc(issue.key)}</a></p>
      <ul class="issue-failed">${failed.map((item) => `<li><strong>${esc(item.label)}</strong>: ${esc(item.error)}</li>`).join('')}</ul>`;
    const actions = dialog.querySelector('#issue-dialog-actions');
    actions.innerHTML = `<button type="button" data-issue-close>${StudioUI.icon('close')}Close</button>
      <button type="button" class="primary" id="issue-retry">Retry failed files</button>`;
    actions.querySelector('#issue-retry').addEventListener('click', async (event) => {
      event.target.disabled = true;
      const remaining = await uploadAll(requestId, failed);
      if (remaining.length) showAttachmentFailures(dialog, issue, requestId, remaining);
      else {
        dialog.close();
        notify(`All files added to ${issue.key}.`);
      }
    });
  }

  function chosenUploads(form, evidence) {
    const ticked = [...form.querySelectorAll('[name="evidence"]:checked')].map((box) => box.value);
    const fromRun = evidence.filter((item) => ticked.includes(item.id)).map((item) => ({ evidenceId: item.id, label: item.label }));
    const own = [...(form.querySelector('#issue-files')?.files || [])].map((file) => ({ file, label: file.name }));
    return [...fromRun, ...own];
  }

  async function submit(dialog, context, submitButton) {
    const form = dialog.querySelector('form');
    const error = dialog.querySelector('#issue-dialog-error');
    const value = (name) => form.elements[name]?.value ?? '';
    error.hidden = true;
    const uploads = chosenUploads(form, context.evidence);
    const problem =
      (!value('summary').trim() && 'Enter a bug title.') ||
      (!value('stepsToReproduce').trim() && 'Enter the steps to reproduce.') ||
      validFiles(uploads.filter((item) => item.file).map((item) => item.file));
    if (problem) {
      error.textContent = problem;
      error.hidden = false;
      return;
    }
    submitButton.disabled = true;
    try {
      const issue = await postJson('/api/issues', {
        projectId: context.projectId,
        testId: context.testId,
        runId: context.runId,
        requestId: context.requestId,
        issueTypeId: value('issueTypeId'),
        priorityId: value('priorityId'),
        severity: value('severity'),
        summary: value('summary'),
        stepsToReproduce: value('stepsToReproduce'),
        results: value('results'),
        runDetails: value('runDetails'),
      });
      const failed = await uploadAll(context.requestId, uploads);
      window.dispatchEvent(new Event('studio:issue-reported'));
      if (failed.length) showAttachmentFailures(dialog, issue, context.requestId, failed);
      else {
        dialog.close();
        notify(`Jira issue ${issue.key} created.`);
      }
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
      submitButton.disabled = false;
      window.dispatchEvent(new Event('studio:issue-reported'));
    }
  }

  function renderForm(dialog, context, options) {
    const { draft, evidence, existing } = context;
    dialog.querySelector('#issue-dialog-title').textContent = 'Raise bug in Jira';
    dialog.querySelector('#issue-dialog-body').innerHTML = `
      ${existingMarkup(existing)}
      <label>Issue type<select name="issueTypeId">${choices(options.issueTypes, options.issueTypeId)}</select></label>
      ${textField('summary', 'Bug title', draft.summary, 'maxlength="255" required')}
      <div class="issue-jira-fields" id="issue-jira-fields">${jiraFieldsMarkup(options)}</div>
      ${textArea('stepsToReproduce', 'Steps to reproduce', draft.stepsToReproduce, 'required')}
      ${textArea('results', 'Expected vs actual', draft.results)}
      ${textArea('runDetails', 'Run details', draft.runDetails)}
      <fieldset class="issue-attachments"><legend>Attachments</legend>${attachmentsMarkup(evidence, options.canAttach)}</fieldset>`;
    const actions = dialog.querySelector('#issue-dialog-actions');
    actions.innerHTML = `<button type="button" data-issue-close>${StudioUI.icon('close')}Cancel</button>
      <button type="button" class="primary" id="issue-submit">${StudioUI.icon('check')}Report as issue</button>`;
    const submitButton = actions.querySelector('#issue-submit');
    submitButton.addEventListener('click', () => void submit(dialog, context, submitButton));
    let typeRequest = 0;
    dialog.querySelector('[name="issueTypeId"]').addEventListener('change', async (event) => {
      const ticket = ++typeRequest;
      submitButton.disabled = true;
      try {
        const next = await request(`/api/issues/options?issueTypeId=${encodeURIComponent(event.target.value)}`);
        if (ticket !== typeRequest) return;
        const fields = dialog.querySelector('#issue-jira-fields');
        const chosen = [...fields.querySelectorAll('select')].map((select) => [select.name, select.selectedOptions[0]?.text]);
        fields.innerHTML = jiraFieldsMarkup(next);
        // Keep what the user already picked when the new issue type offers the same choice.
        for (const [name, text] of chosen) {
          const select = fields.querySelector(`[name="${name}"]`);
          const match = select && [...select.options].find((option) => option.text === text);
          if (match) select.value = match.value;
        }
      } catch (failure) {
        const error = dialog.querySelector('#issue-dialog-error');
        error.textContent = failure.message;
        error.hidden = false;
      } finally {
        if (ticket === typeRequest) submitButton.disabled = false;
      }
    });
  }

  async function open({ projectId, testId, runId }) {
    const dialog = dialogElement();
    const error = dialog.querySelector('#issue-dialog-error');
    error.hidden = true;
    dialog.querySelector('#issue-dialog-title').textContent = 'Raise bug in Jira';
    dialog.querySelector('#issue-dialog-body').innerHTML = '<p class="field-hint" role="status">Loading details from Jira…</p>';
    dialog.querySelector('#issue-dialog-actions').innerHTML = `<button type="button" data-issue-close>${StudioUI.icon('close')}Cancel</button>`;
    dialog.showModal();
    const query = new URLSearchParams({ projectId, testId, ...(runId ? { runId } : {}) });
    try {
      const [details, options] = await Promise.all([
        request(`/api/issues/draft?${query}`),
        request('/api/issues/options'),
      ]);
      if (!dialog.open) return;
      renderForm(dialog, { ...details, projectId, requestId: crypto.randomUUID() }, options);
    } catch (failure) {
      dialog.querySelector('#issue-dialog-body').innerHTML = '';
      error.textContent = failure.message;
      error.hidden = false;
    }
  }

  function issueLinks(testIds) {
    const known = issues.filter((issue) => testIds.includes(issue.testId));
    if (!known.length) return '';
    return `<span class="issue-links">${known
      .map((issue) => `<a href="${esc(issue.url)}" target="_blank" rel="noopener noreferrer" title="${esc(issue.summary)}">${esc(issue.key)}</a>`)
      .join(' ')}</span>`;
  }

  // Dataset rows of one case share a bug, so callers pass every status of that case.
  function controls({ projectId, testIds, runId, statuses }) {
    const ids = testIds.filter(Boolean);
    const links = issueLinks(ids);
    if (!statuses.some((status) => REPORTABLE.includes(status))) return links;
    if (!tracker?.connected) {
      const isAdmin = globalThis.StudioAuth?.user?.role === 'admin';
      const help = isAdmin
        ? '<a class="issue-connect" href="/automation?view=settings">Connect Jira in Settings</a>'
        : '<small class="issue-connect">Ask an admin to connect Jira</small>';
      return `<button type="button" disabled title="Ask an admin to connect Jira">Raise bug</button>${help}${links}`;
    }
    const run = runId ? `data-run-id="${esc(runId)}"` : '';
    return `<button type="button" data-raise-bug data-project-id="${esc(projectId)}" data-test-id="${esc(ids[0])}" ${run}>Raise bug</button>${links}`;
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-raise-bug]');
    if (!button || button.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    void open({ projectId: button.dataset.projectId, testId: button.dataset.testId, runId: button.dataset.runId });
  });

  globalThis.StudioIssueReport = {
    open,
    controls,
    setState(next) {
      tracker = next.bugTracker || {};
      issues = next.reportedIssues || [];
    },
    signature: () => JSON.stringify([tracker?.connected, issues.map((issue) => issue.key)]),
  };
})();
