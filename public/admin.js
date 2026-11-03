(() => {
  const form = document.querySelector('#user-form');
  const errorBox = document.querySelector('#error');
  const noticeBox = document.querySelector('#notice');
  const searchInput = document.querySelector('#user-search');
  const usersBody = document.querySelector('#users');
  const fields = form.elements;

  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
  const roleLabel = (user) => (user.role === 'admin' ? 'Administrator' : 'User');

  let users = [];
  let editing = null;
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

  function showNotice(message) {
    noticeBox.textContent = message;
    noticeBox.hidden = false;
  }

  function clearMessages() {
    errorBox.hidden = true;
    noticeBox.hidden = true;
  }

  function syncControls() {
    form.querySelectorAll('input,select,button').forEach((control) => {
      control.disabled = busy;
    });
    document.querySelectorAll('[data-edit]').forEach((control) => {
      control.disabled = busy;
    });
    // Administrators always have full access, so studio choices do not apply.
    const isAdmin = fields.role.value === 'admin';
    fields.qa.disabled = busy || isAdmin;
    fields.automation.disabled = busy || isAdmin;
    form.setAttribute('aria-busy', String(busy));
  }

  function resetForm() {
    editing = null;
    form.reset();
    fields.password.required = true;
    document.querySelector('#form-title').textContent = 'Create user';
    document.querySelector('#password-label').textContent = 'Password';
    document.querySelector('#save-user').textContent = 'Create user';
    document.querySelector('#cancel-edit').hidden = true;
    syncControls();
  }

  function loadUserIntoForm(user) {
    editing = user;
    clearMessages();
    fields.name.value = user.name;
    fields.username.value = user.username;
    fields.role.value = user.role;
    fields.qa.checked = user.permissions.qa;
    fields.automation.checked = user.permissions.automation;
    fields.active.checked = user.active;
    fields.password.value = '';
    fields.password.required = false;
    document.querySelector('#form-title').textContent = 'Edit user';
    document.querySelector('#password-label').textContent = 'Reset password (leave blank to keep)';
    document.querySelector('#save-user').textContent = 'Save changes';
    document.querySelector('#cancel-edit').hidden = false;
    syncControls();
    fields.name.focus();
  }

  function initials(name) {
    return name
      .trim()
      .split(/\s+/)
      .map((part) => Array.from(part)[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();
  }

  function accessSummary(user) {
    if (user.role === 'admin') return 'Full access';
    const studios = [];
    if (user.permissions.qa) studios.push('QA Studio');
    if (user.permissions.automation) studios.push('Automation Studio');
    return studios.join('<br>') || 'No studio access';
  }

  function userRow(user) {
    const statusClass = user.active ? 'admin-status' : 'admin-status disabled';
    return `<tr>
      <td>
        <div class="admin-user">
          <span class="admin-avatar" aria-hidden="true">${escapeHtml(initials(user.name))}</span>
          <div>
            <strong>${escapeHtml(user.name)}</strong>
            <small>${escapeHtml(user.username)} · ${roleLabel(user)}</small>
          </div>
        </div>
      </td>
      <td>${accessSummary(user)}</td>
      <td><span class="${statusClass}">${user.active ? 'Enabled' : 'Disabled'}</span></td>
      <td>
        <div class="admin-row-actions">
          <button type="button" data-edit="${escapeHtml(user.id)}" aria-label="Edit ${escapeHtml(user.username)}">Edit</button>
          <a href="/admin/permissions?user=${encodeURIComponent(user.id)}">Permissions</a>
        </div>
      </td>
    </tr>`;
  }

  function renderUsers() {
    const query = searchInput.value.trim().toLowerCase();
    const matches = users.filter((user) =>
      `${user.name} ${user.username} ${roleLabel(user)}`.toLowerCase().includes(query),
    );
    document.querySelector('#user-count').textContent = String(users.length);
    const emptyMessage = query ? 'No users match your search.' : 'No users available.';
    usersBody.innerHTML =
      matches.map(userRow).join('') || `<tr><td colspan="4" class="admin-empty">${emptyMessage}</td></tr>`;
    syncControls();
  }

  async function refreshUsers() {
    users = (await api('/api/admin/users')).users;
    renderUsers();
  }

  function createdMessage(saved) {
    const canSignIn = saved.active && (saved.effectivePermissions.qa || saved.effectivePermissions.automation);
    return canSignIn
      ? 'User created. Assign their projects in Project management.'
      : 'User created. Enable the account and grant studio access before they can sign in.';
  }

  function readForm(target) {
    const input = {
      name: fields.name.value,
      username: fields.username.value,
      role: fields.role.value,
      active: fields.active.checked,
      // Keep the grants set on the Permissions page; this form edits only the studios.
      permissions: {
        ...(target ? target.permissions : {}),
        qa: fields.qa.checked,
        automation: fields.automation.checked,
      },
    };
    if (target) input.revision = target.revision;
    if (fields.password.value) input.password = fields.password.value;
    return input;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy) return;
    const target = editing;
    const input = readForm(target);
    busy = true;
    clearMessages();
    syncControls();
    try {
      const saved = target
        ? await api(`/api/admin/users/${target.id}`, 'PUT', input)
        : await api('/api/admin/users', 'POST', input);
      showNotice(target ? 'User updated. Existing sessions have been revoked.' : createdMessage(saved));
      resetForm();
      await refreshUsers();
    } catch (problem) {
      let message = problem.message;
      if (problem.status === 409 && target) {
        message += ' Select Edit again to load the current user before retrying.';
        await refreshUsers().catch(() => {
          // The save error below is the one the administrator needs to see.
        });
      }
      showError(message);
    } finally {
      busy = false;
      syncControls();
    }
  }

  searchInput.addEventListener('input', renderUsers);
  fields.role.addEventListener('change', syncControls);
  form.addEventListener('submit', handleSubmit);

  usersBody.addEventListener('click', (event) => {
    const id = event.target.closest('[data-edit]')?.dataset.edit;
    if (!id || busy) return;
    const user = users.find((candidate) => candidate.id === id);
    if (user) loadUserIntoForm(user);
  });

  document.querySelector('#cancel-edit').addEventListener('click', () => {
    if (!busy) resetForm();
  });

  refreshUsers().catch((problem) => showError(problem.message));
})();
