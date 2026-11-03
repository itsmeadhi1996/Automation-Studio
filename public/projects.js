(() => {
  const projectPicker = document.querySelector('#managed-project');
  const memberForm = document.querySelector('#project-members');
  const saveButton = document.querySelector('#save-project-members');
  const refreshButton = document.querySelector('#refresh-projects');
  const memberRows = document.querySelector('#project-users');
  const effectiveAccess = document.querySelector('#effective-access');
  const logFilters = document.querySelector('#log-filters');
  const logProject = document.querySelector('#log-project');
  const logUser = document.querySelector('#log-user');
  const logError = document.querySelector('#log-error');
  const prevButton = document.querySelector('#log-prev');
  const nextButton = document.querySelector('#log-next');

  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);

  let data;
  let busy = false;
  let logBusy = false;
  let logOffset = 0;
  let logTicket = 0;
  let logPage = { total: 0, limit: 50 };

  const selectedProject = () => data?.projects.find((project) => project.id === projectPicker.value);

  async function api(route, method = 'GET', body) {
    const response = await fetch(route, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Request failed');
    return result;
  }

  function setMessage(selector, text) {
    const node = document.querySelector(selector);
    node.textContent = text;
    node.hidden = !text;
  }

  const showNotice = (text) => setMessage('#project-notice', text);
  const showError = (text) => setMessage('#project-error', text);

  function clearMessages() {
    showNotice('');
    showError('');
  }

  function syncMemberControls() {
    projectPicker.disabled = busy || !data?.projects.length;
    saveButton.disabled = busy || !selectedProject();
    refreshButton.disabled = busy;
    memberForm.setAttribute('aria-busy', String(busy));
    document.querySelectorAll('input[name="member"]').forEach((input) => {
      input.disabled = busy || input.dataset.admin === 'true';
    });
  }

  function syncLogControls() {
    for (const control of logFilters.elements) control.disabled = logBusy;
    prevButton.disabled = logBusy || logOffset === 0;
    nextButton.disabled = logBusy || logOffset + logPage.limit >= logPage.total;
  }

  function studioSummary(user) {
    const studios = [];
    if (user.effectivePermissions.qa) studios.push('QA Studio');
    if (user.effectivePermissions.automation) studios.push('Automation Studio');
    return studios.join(', ') || 'No studio assigned';
  }

  function accessLabel(user) {
    if (user.role === 'admin') return 'Administrator';
    return user.active ? 'Allow access' : 'Retain assignment';
  }

  function memberRow(user, project) {
    const isAdmin = user.role === 'admin';
    const assigned = isAdmin || project.memberIds.includes(user.id);
    return `<tr>
      <td>
        <strong>${escapeHtml(user.name)}</strong>
        <small>${escapeHtml(user.username)}${user.active ? '' : ' / Disabled'}</small>
      </td>
      <td>
        ${escapeHtml(studioSummary(user))}
        <small><a href="/admin/permissions?user=${encodeURIComponent(user.id)}">Edit permissions</a></small>
      </td>
      <td>
        <label class="check">
          <input type="checkbox" name="member" value="${escapeHtml(user.id)}" data-admin="${isAdmin}"
            aria-label="Project access for ${escapeHtml(user.username)}"${assigned ? ' checked' : ''}${isAdmin ? ' disabled' : ''}>
          ${accessLabel(user)}
        </label>
      </td>
    </tr>`;
  }

  function effectiveAccessText(project) {
    const names = data.users
      .filter((user) => user.active && (user.effectivePermissions.qa || user.effectivePermissions.automation))
      .filter((user) => user.role === 'admin' || project.memberIds.includes(user.id))
      .map((user) => user.name);
    return `Current effective access: ${names.join(', ') || 'none'}.`;
  }

  function renderProject() {
    const project = selectedProject();
    const summary = document.querySelector('#project-summary');
    const overviewLink = document.querySelector('#overview-link');
    if (!project) {
      summary.textContent = 'No projects available.';
      overviewLink.hidden = true;
      memberRows.innerHTML = '<tr><td colspan="3">Create a project in either studio to assign access.</td></tr>';
      effectiveAccess.textContent = '';
      syncMemberControls();
      return;
    }
    const url = new URL(location.href);
    url.searchParams.set('projectId', project.id);
    history.replaceState(null, '', url);
    summary.textContent = `${project.tests} cases / ${project.suites} suites / ${project.runs} runs`;
    overviewLink.href = `/?projectId=${encodeURIComponent(project.id)}#dashboard`;
    overviewLink.hidden = false;
    memberRows.innerHTML = data.users.map((user) => memberRow(user, project)).join('');
    effectiveAccess.textContent = effectiveAccessText(project);
    syncMemberControls();
  }

  async function loadProjects() {
    const currentProject = selectedProject()?.id || new URLSearchParams(location.search).get('projectId');
    const filterProject = logProject.value;
    const filterUser = logUser.value;
    data = await api('/api/admin/projects');

    const projectOptions = data.projects
      .map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`)
      .join('');
    projectPicker.innerHTML = projectOptions;
    if (data.projects.some((project) => project.id === currentProject)) projectPicker.value = currentProject;

    logProject.innerHTML = `<option value="">All projects</option>${projectOptions}`;
    logProject.value = data.projects.some((project) => project.id === filterProject) ? filterProject : '';

    const userOptions = data.users
      .map((user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.name)} (${escapeHtml(user.username)})</option>`)
      .join('');
    logUser.innerHTML = `<option value="">All users</option>${userOptions}`;
    logUser.value = data.users.some((user) => user.id === filterUser) ? filterUser : '';

    renderProject();
  }

  function logRow(entry) {
    const details = entry.details ? `<small>${escapeHtml(entry.details)}</small>` : '';
    return `<tr>
      <td><time datetime="${escapeHtml(entry.at)}" title="${escapeHtml(entry.at)}">${escapeHtml(new Date(entry.at).toLocaleString())}</time></td>
      <td>${escapeHtml(entry.userName)}</td>
      <td>${escapeHtml(entry.projectName)}</td>
      <td>${escapeHtml(entry.action)}${details}</td>
      <td>${escapeHtml(entry.outcome)}</td>
    </tr>`;
  }

  function renderLog(result) {
    document.querySelector('#log-description').textContent =
      `Project changes and execution activity recorded since ${new Date(result.startedAt).toLocaleString()}. ` +
      'Latest 10,000 entries retained. Times use your browser time zone; older activity has no recorded actor.';
    document.querySelector('#work-log').innerHTML = result.entries.length
      ? result.entries.map(logRow).join('')
      : '<tr><td colspan="5">No activity matches these filters.</td></tr>';
    const lastEntry = Math.min(logOffset + result.entries.length, result.total);
    document.querySelector('#log-page').textContent = result.total
      ? `${logOffset + 1}-${lastEntry} of ${result.total}`
      : '0 entries';
  }

  async function loadLog(requestedOffset = logOffset) {
    // Only the newest request may update the page, so a slow response cannot overwrite it.
    logTicket += 1;
    const ticket = logTicket;
    const query = new URLSearchParams({
      offset: String(requestedOffset),
      projectId: logProject.value,
      userId: logUser.value,
      action: document.querySelector('#log-action').value.trim(),
    });
    logBusy = true;
    logError.hidden = true;
    syncLogControls();
    try {
      const result = await api(`/api/admin/work-log?${query}`);
      if (ticket !== logTicket) return;
      logOffset = result.offset;
      logPage = result;
      renderLog(result);
    } catch (problem) {
      if (ticket !== logTicket) return;
      logError.textContent = `Could not refresh the working log. ${problem.message}`;
      logError.hidden = false;
    } finally {
      if (ticket === logTicket) {
        logBusy = false;
        syncLogControls();
      }
    }
  }

  async function load() {
    if (busy) return;
    busy = true;
    clearMessages();
    syncMemberControls();
    try {
      await window.StudioAuth?.ready;
      await loadProjects();
      await loadLog();
    } catch (problem) {
      showError(problem.message);
    } finally {
      busy = false;
      syncMemberControls();
    }
  }

  async function saveMembers(event) {
    event.preventDefault();
    const project = selectedProject();
    if (busy || !project) return;
    const userIds = [...document.querySelectorAll('input[name="member"]:checked')]
      .filter((input) => input.dataset.admin !== 'true')
      .map((input) => input.value);
    busy = true;
    clearMessages();
    syncMemberControls();
    try {
      const saved = await api(`/api/admin/projects/${project.id}/members`, 'PUT', {
        userIds,
        revision: project.revision,
      });
      // Show the saved access straight away; a log refresh failure cannot undo this save.
      project.memberIds = saved.memberIds;
      project.revision = saved.revision;
      renderProject();
      showNotice('Project access saved. New requests use these assignments immediately.');
      await loadLog(0);
    } catch (problem) {
      showError(problem.message);
    } finally {
      busy = false;
      syncMemberControls();
    }
  }

  projectPicker.addEventListener('change', () => {
    clearMessages();
    renderProject();
  });
  refreshButton.addEventListener('click', load);
  memberForm.addEventListener('submit', saveMembers);

  logFilters.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!logBusy) loadLog(0);
  });
  prevButton.addEventListener('click', () => {
    if (!logBusy) loadLog(Math.max(0, logOffset - logPage.limit));
  });
  nextButton.addEventListener('click', () => {
    if (!logBusy) loadLog(logOffset + logPage.limit);
  });

  syncLogControls();
  load();
})();
