(() => {
  const form = document.querySelector('#login');
  const errorBox = document.querySelector('#error');
  const submitButton = document.querySelector('#submit');
  let isSetup = false;

  async function api(route, input) {
    const response = await fetch(route, {
      method: input ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: input ? JSON.stringify(input) : undefined,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function homeFor(user) {
    if (user.role === 'admin') return '/admin';
    if (user.effectivePermissions?.qa) return '/';
    if (user.effectivePermissions?.automation) return '/automation';
    return '/account';
  }

  function showSetupForm() {
    document.querySelector('#title').textContent = 'Create your administrator';
    document.querySelector('#description').textContent =
      'Set up the first administrator for this workspace. You can then create users and assign studio access.';
    document.querySelector('#name-field').hidden = false;
    form.elements.name.required = true;
    document.querySelector('#confirm-field').hidden = false;
    form.elements.confirm.required = true;
    form.elements.password.minLength = 12;
    form.elements.password.autocomplete = 'new-password';
    submitButton.textContent = 'Create administrator';
    document.querySelector('#hint').textContent =
      'Use at least 12 characters. There is no default administrator password.';
  }

  const ready = api('/api/auth/session')
    .then((session) => {
      if (session.user) {
        location.replace(homeFor(session.user));
        return;
      }
      isSetup = session.setupRequired;
      if (isSetup) showSetupForm();
    })
    .catch((error) => showError(error.message));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await ready;
    errorBox.hidden = true;
    submitButton.disabled = true;
    try {
      const input = Object.fromEntries(new FormData(form));
      if (isSetup) {
        if (input.password !== input.confirm) throw new Error('Passwords do not match.');
        await api('/api/auth/setup', input);
        isSetup = false;
      }
      const result = await api('/api/auth/login', input);
      location.replace(result.home);
    } catch (error) {
      showError(error.message);
    } finally {
      submitButton.disabled = false;
    }
  });
})();
