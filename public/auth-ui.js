(() => {
  let user;

  const ACTION_PERMISSIONS = {
    'new-project': 'createProjects',
    'import-project': 'createProjects',
    'edit-mcp': 'manageMcp',
    'delete-mcp': 'manageMcp',
    'setup-mcp-preset': 'manageMcp',
    'discover-mcp': 'useMcp',
    'reconnect-mcp': 'useMcp',
    'call-mcp': 'useMcp',
    'toggle-ai-mcp': 'useMcp',
  };
  const ADMIN_ONLY_SELECTOR = [
    '[data-view="settings"]',
    '[data-view="vpn"]',
    '[data-action="history-retention"]',
    '[data-action="backup-workspace"]',
    '[data-action="restore-workspace"]',
  ].join(',');

  function allowed(permission) {
    if (!user?.active) return false;
    if (user.effectivePermissions) return Boolean(user.effectivePermissions[permission]);
    return user.role === 'admin' || Boolean(user.permissions?.[permission]);
  }

  function isViewAllowed(view) {
    if (view === 'mcp') return allowed('useMcp');
    return (view !== 'settings' && view !== 'vpn') || user?.role === 'admin';
  }

  function isLinkHidden(url) {
    const view = url.searchParams.get('view');
    if (url.pathname === '/automation' && !allowed('automation')) return true;
    if (url.pathname === '/' && !allowed('qa')) return true;
    if (url.pathname.startsWith('/admin') && user.role !== 'admin') return true;
    return !isViewAllowed(view);
  }

  function restrictAutomationMode() {
    const controls = document.querySelectorAll('input[name="mode"][value="automation"],option[value="automation"]');
    controls.forEach((control) => {
      control.disabled = true;
      if (control.tagName !== 'INPUT') return;
      control.checked = false;
      const manual = document.querySelector('input[name="mode"][value="manual"]');
      if (manual) manual.checked = true;
    });
  }

  function addAccountBlock(sidebar) {
    const block = document.createElement('div');
    block.className = 'studio-account';
    const name = document.createElement('strong');
    name.textContent = user.name;
    block.append(name);
    const links = [['/account', 'My account']];
    if (user.role === 'admin') links.push(['/admin', 'Administration']);
    for (const [href, label] of links) {
      const link = document.createElement('a');
      link.href = href;
      link.textContent = label;
      block.append(link);
    }
    const logout = document.createElement('button');
    logout.type = 'button';
    logout.dataset.authLogout = '';
    logout.textContent = 'Sign out';
    block.append(logout);
    sidebar.prepend(block);
  }

  function apply() {
    if (!user) return;
    for (const link of document.querySelectorAll('a[href]')) {
      const url = new URL(link.href, location.href);
      if (url.origin === location.origin && isLinkHidden(url)) link.hidden = true;
    }
    if (user.role !== 'admin') {
      document.querySelectorAll(ADMIN_ONLY_SELECTOR).forEach((node) => {
        node.hidden = true;
      });
    }
    document.querySelectorAll('[data-view="mcp"]').forEach((node) => {
      node.hidden = !allowed('useMcp');
    });
    for (const [action, permission] of Object.entries(ACTION_PERMISSIONS)) {
      document.querySelectorAll(`[data-action="${action}"]`).forEach((node) => {
        node.hidden = !allowed(permission);
      });
    }
    if (!allowed('automation')) restrictAutomationMode();
    const sidebar = document.querySelector('.sidebar-bottom');
    if (sidebar && !sidebar.querySelector('.studio-account')) addAccountBlock(sidebar);
  }

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    const isSameOrigin = new URL(response.url).origin === location.origin;
    if (response.status === 401 && isSameOrigin && !response.url.includes('/api/auth/')) {
      location.replace('/login');
    }
    return response;
  };

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-auth-logout]');
    if (!button) return;
    button.disabled = true;
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      if (response.ok) location.replace('/login');
      else button.disabled = false;
    } catch {
      button.disabled = false;
    }
  });

  const ready = fetch('/api/auth/session')
    .then((response) => response.json())
    .then((session) => {
      if (!session.user) {
        location.replace('/login');
        return;
      }
      user = session.user;
      window.StudioAuth.user = user;
      apply();
      document.dispatchEvent(new CustomEvent('studio-user', { detail: user }));
      new MutationObserver(apply).observe(document.body, { childList: true, subtree: true });
    });

  window.StudioAuth = { ready, user, allowed, viewAllowed: isViewAllowed, apply };
  ready.catch(() => {});
})();
