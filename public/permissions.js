(() => {
  const picker = document.querySelector('#permission-user');
  const form = document.querySelector('#permissions-form');
  const fieldsContainer = document.querySelector('#permission-fields');
  const errorBox = document.querySelector('#permission-error');
  const noticeBox = document.querySelector('#permission-notice');
  const saveButton = document.querySelector('#save-permissions');
  const refreshButton = document.querySelector('#refresh-permissions');
  const description = document.querySelector('#user-description');

  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);

  let users = [];
  let catalog = [];
  let selected;
  let busy = false;

  async function api(route, method = 'GET', input) {
    const response = await fetch(route, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(result.error || 'Request failed'), { status: response.status });
    }
    return result;
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function clearMessages() {
    errorBox.hidden = true;
    noticeBox.hidden = true;
  }

  function syncControls() {
    picker.disabled = busy || !users.length;
    refreshButton.disabled = busy;
    saveButton.disabled = busy || !selected || selected.role === 'admin';
    form.setAttribute('aria-busy', String(busy));
    if (!selected) return;

    const isAdmin = selected.role === 'admin';
    const elements = form.elements;
    const hasAutomation = elements.automation.checked;
    const hasStudio = hasAutomation || elements.qa.checked;
    for (const item of catalog) {
      const input = elements[item.id];
      const needsAutomation = item.requires?.includes('automation') && !hasAutomation;
      const needsStudio = item.id === 'createProjects' && !hasStudio;
      const unavailable = needsAutomation || needsStudio;
      if (!isAdmin && unavailable) input.checked = false;
      input.disabled = busy || isAdmin || unavailable;
    }
    // Managing MCP connections always includes using them.
    if (!isAdmin && hasAutomation && elements.manageMcp.checked) {
      elements.useMcp.checked = true;
      elements.useMcp.disabled = true;
    }
  }

  function describeUser(user) {
    if (user.role === 'admin') return 'Administrators have full access. Their permissions cannot be restricted here.';
    return user.active
      ? 'Enabled account. At least one studio must be selected for the user to sign in.'
      : 'This account is disabled. Enable it on the Users page before the user can sign in.';
  }

  function permissionOption(item, user) {
    const checked = user.role === 'admin' || user.permissions[item.id];
    return `<label class="permission-option">
      <input type="checkbox" name="${escapeHtml(item.id)}"${checked ? ' checked' : ''}>
      <span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.description)}</small></span>
    </label>`;
  }

  function renderFields(user) {
    const groups = [...new Set(catalog.map((item) => item.group))];
    fieldsContainer.innerHTML = groups
      .map((group) => {
        const options = catalog
          .filter((item) => item.group === group)
          .map((item) => permissionOption(item, user))
          .join('');
        return `<fieldset class="permission-group"><legend>${escapeHtml(group)}</legend>${options}</fieldset>`;
      })
      .join('');
  }

  function selectUser() {
    selected = users.find((user) => user.id === picker.value);
    clearMessages();
    if (!selected) {
      fieldsContainer.replaceChildren();
      description.textContent = 'No users available.';
      syncControls();
      return;
    }
    description.textContent = describeUser(selected);
    renderFields(selected);
    syncControls();
    const url = new URL(location.href);
    url.searchParams.set('user', selected.id);
    history.replaceState(null, '', url);
  }

  function guideItem(item, note = '') {
    return `<div class="permission-guide-item">
      <strong>${escapeHtml(item.name)}</strong>
      <p>${escapeHtml(item.description)}${note}</p>
    </div>`;
  }

  function renderGuide(definitions) {
    catalog = definitions.permissions;
    document.querySelector('#permission-guide').innerHTML = catalog
      .map((item) => guideItem(item, item.requires?.includes('automation') ? ' Requires Automation Studio access.' : ''))
      .join('');
    document.querySelector('#admin-only-guide').innerHTML = definitions.adminOnly.map((item) => guideItem(item)).join('');
  }

  function userOptionLabel(user) {
    let suffix = '';
    if (user.role === 'admin') suffix = ' - Administrator';
    else if (!user.active) suffix = ' - Disabled';
    return `${user.name} (${user.username})${suffix}`;
  }

  async function load() {
    if (busy) return;
    busy = true;
    clearMessages();
    syncControls();
    try {
      await window.StudioAuth?.ready;
      const [accounts, definitions] = await Promise.all([
        api('/api/admin/users'),
        catalog.length ? null : api('/api/admin/permissions'),
      ]);
      const current = selected?.id || new URLSearchParams(location.search).get('user');
      users = accounts.users;
      if (definitions) renderGuide(definitions);
      picker.innerHTML = users
        .map((user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(userOptionLabel(user))}</option>`)
        .join('');
      const preferred =
        users.find((user) => user.id === current) || users.find((user) => user.role !== 'admin') || users[0];
      picker.value = preferred?.id || '';
      selectUser();
    } catch (problem) {
      showError(problem.message);
    } finally {
      busy = false;
      syncControls();
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy || !selected || selected.role === 'admin') return;
    const target = selected;
    const permissions = Object.fromEntries(catalog.map((item) => [item.id, form.elements[item.id].checked]));
    busy = true;
    clearMessages();
    syncControls();
    try {
      const updated = await api(`/api/admin/users/${target.id}/permissions`, 'PUT', {
        permissions,
        revision: target.revision,
      });
      users = users.map((user) => (user.id === updated.id ? updated : user));
      selectUser();
      noticeBox.textContent = `Permissions saved for ${updated.name}. Existing sessions have been revoked.`;
      noticeBox.hidden = false;
    } catch (problem) {
      const suffix =
        problem.status === 409 ? ' Use Refresh users to review the latest permissions, then apply your changes.' : '';
      showError(problem.message + suffix);
    } finally {
      busy = false;
      syncControls();
    }
  }

  form.addEventListener('change', syncControls);
  form.addEventListener('submit', handleSubmit);
  picker.addEventListener('change', selectUser);
  refreshButton.addEventListener('click', load);

  load();
})();
