(() => {
  const ENGINE_NAMES = { claude: 'Claude', chatgpt: 'ChatGPT' };
  const ENGINES = Object.keys(ENGINE_NAMES);
  const STILL_AVAILABLE = 'You can still change your password below.';

  const aiForm = document.querySelector('#ai-form');
  const aiError = document.querySelector('#ai-error');
  const aiNotice = document.querySelector('#ai-notice');
  const fields = aiForm.elements;

  let savedAi;

  async function request(url, method = 'GET', body) {
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(result.error || 'Request failed'), { status: response.status });
    }
    return result;
  }

  function showAccountDetails(user) {
    if (!user) return;
    document.querySelector('#account-name').textContent = user.name;
    const studios = [];
    if (user.permissions.qa) studios.push('QA Studio');
    if (user.permissions.automation) studios.push('Automation Studio');
    document.querySelector('#account-access').textContent =
      user.role === 'admin' ? 'Administrator · Full access' : `Access: ${studios.join(', ') || 'none'}`;
  }

  function showAiMessage(message, isError = false) {
    aiError.hidden = !isError;
    aiNotice.hidden = isError;
    (isError ? aiError : aiNotice).textContent = message;
  }

  function clearAiMessages() {
    aiError.hidden = true;
    aiNotice.hidden = true;
  }

  function setAiBusy(busy) {
    aiForm.querySelectorAll('button,input,select').forEach((control) => {
      control.disabled = busy;
    });
    aiForm.setAttribute('aria-busy', String(busy));
  }

  // Remove key only means something while a key is saved.
  function syncRemoveButtons() {
    for (const engine of ENGINES) {
      aiForm.querySelector(`[data-clear="${engine}"]`).disabled = !savedAi?.hasApiKey[engine];
    }
  }

  function fillAiForm(ai) {
    savedAi = ai;
    fields.qa.value = ai.engines.qa;
    fields.automation.value = ai.engines.automation;
    for (const engine of ENGINES) {
      fields[`${engine}Model`].value = ai.models[engine];
      fields[`${engine}Key`].value = '';
      const hasKey = ai.hasApiKey[engine];
      const status = aiForm.querySelector(`[data-status="${engine}"]`);
      status.textContent = hasKey ? 'API key saved' : `Not connected · add an API key to use ${ENGINE_NAMES[engine]}`;
      status.classList.toggle('connected', hasKey);
    }
  }

  function readAiForm() {
    return {
      engines: { qa: fields.qa.value, automation: fields.automation.value },
      models: {
        claude: fields.claudeModel.value.trim(),
        chatgpt: fields.chatgptModel.value.trim(),
      },
      apiKeys: {
        claude: fields.claudeKey.value.trim(),
        chatgpt: fields.chatgptKey.value.trim(),
      },
    };
  }

  async function saveAi(input) {
    const ai = await request('/api/account/ai', 'PUT', input);
    fillAiForm(ai);
    return ai;
  }

  // Runs one AI action with the form locked and its outcome shown in the section.
  async function runAiAction(action) {
    setAiBusy(true);
    clearAiMessages();
    try {
      showAiMessage(await action());
    } catch (problem) {
      showAiMessage(problem.message, true);
    } finally {
      setAiBusy(false);
      syncRemoveButtons();
    }
  }

  async function loadAiSettings() {
    setAiBusy(true);
    try {
      fillAiForm(await request('/api/account/ai'));
      setAiBusy(false);
      syncRemoveButtons();
    } catch (problem) {
      // The form stays locked: there are no saved values to edit.
      showAiMessage(
        problem.status === 404
          ? `AI settings are not available in this version yet. ${STILL_AVAILABLE}`
          : `Could not load your AI settings. ${problem.message} ${STILL_AVAILABLE}`,
        true,
      );
    }
  }

  aiForm.addEventListener('submit', (event) => {
    event.preventDefault();
    runAiAction(async () => {
      const ai = await saveAi(readAiForm());
      const missing = [ai.engines.qa, ai.engines.automation].find(
        (engine) => engine !== 'studio' && !ai.hasApiKey[engine],
      );
      return missing ? `Saved. Add a ${ENGINE_NAMES[missing]} API key before generating with it.` : 'AI settings saved.';
    });
  });

  aiForm.addEventListener('click', (event) => {
    const testEngine = event.target.closest('[data-test]')?.dataset.test;
    const clearEngine = event.target.closest('[data-clear]')?.dataset.clear;
    if (clearEngine) {
      runAiAction(async () => {
        await saveAi({ clearApiKeys: [clearEngine] });
        return `${ENGINE_NAMES[clearEngine]} API key removed.`;
      });
    } else if (testEngine) {
      runAiAction(async () => {
        // Save first so the check uses the model and key shown in the form.
        await saveAi(readAiForm());
        const result = await request('/api/account/ai/test', 'POST', { engine: testEngine });
        return `${ENGINE_NAMES[testEngine]} is connected. Model ${result.name} is available.`;
      });
    }
  });

  document.querySelector('#password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const error = document.querySelector('#error');
    const button = form.querySelector('button');
    const { currentPassword, password, confirm } = form.elements;
    error.hidden = true;
    button.disabled = true;
    try {
      if (password.value !== confirm.value) throw new Error('Passwords do not match.');
      await request('/api/auth/password', 'PUT', {
        currentPassword: currentPassword.value,
        password: password.value,
      });
      location.replace('/login');
    } catch (problem) {
      error.textContent = problem.message;
      error.hidden = false;
    } finally {
      button.disabled = false;
    }
  });

  window.StudioAuth.ready.then(() => showAccountDetails(window.StudioAuth.user));
  loadAiSettings();
})();
