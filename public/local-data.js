/* Local test data authoring. Values are collected once at the start of each execution.
   Shares app.js's global scope. */
const LOCAL_SOURCE_NAMES = {
  manual: 'Manual value',
  random: 'Random',
  database: 'Database',
  file: 'Excel / CSV / JSON',
  global: 'Global variable',
  environment: 'Environment variable',
};
const LOCAL_RANDOM_KINDS = [
  { id: 'uuid', name: 'UUID' },
  { id: 'text', name: 'Letters and numbers' },
  { id: 'number', name: 'Whole number' },
  { id: 'email', name: 'Email (@example.test)' },
  { id: 'date', name: 'Date (2000–2099)' },
];
const LOCAL_ROW_SELECTIONS = [
  { id: 'fixed', name: 'Specific data row' },
  { id: 'random', name: 'Random data row' },
];
const LOCAL_MAX_VARIABLES = 100;
const LOCAL_MAX_FILE_BYTES = 1024 * 1024;
const LOCAL_PREVIEW_ROWS = 5;
const LOCAL_NUMBER_BOUNDS = 'min="-1000000000000" max="1000000000000"';
const LOCAL_PREVIEW_HINT = 'Preview does not change global variables.';

let localDataDraft = null;
let localDataOwner = null;
let localDataIndex = -1;
// Each dialog change bumps this so a slow preview or upload cannot overwrite newer input.
let localPreviewVersion = 0;

function renderLocalDataRow(entry, index) {
  const name = esc(entry.name);
  const previewNote =
    entry.source === 'manual' ? '' : '<small>Preview only; collected again on each run</small>';
  return `
    <tr>
      <td><strong>${name}</strong></td>
      <td><span class="local-data-value">${esc(entry.value || '(empty)')}</span>${previewNote}</td>
      <td>${esc(LOCAL_SOURCE_NAMES[entry.source])}</td>
      <td><input type="checkbox" data-local-global="${index}" aria-label="Keep ${name} in global variable" ${entry.keepGlobal ? 'checked' : ''}></td>
      <td>
        <div class="inline-actions">
          <button data-action="edit-local-data" data-index="${index}">Edit / preview</button>
          <button class="quiet danger" data-action="remove-local-data" data-index="${index}" aria-label="Remove ${name}">Remove</button>
        </div>
      </td>
    </tr>`;
}

function renderLocalData() {
  const test = selectedKind === 'tests' && selected();
  if (!test) return heading('TEST DATA', 'Local Test Data', 'Select a test in the sidebar to manage its data.');
  const entries = test.localTestData || [];
  const actions = `
    <button data-action="view" data-view="editor">Back to test editor</button>
    <button data-action="save-local-data">Save data</button>
    <button class="primary" data-action="add-local-data">Add variable</button>`;
  const rows =
    entries.map(renderLocalDataRow).join('') ||
    '<tr><td colspan="5">No local test data yet. Add a variable to enter a value or configure a data source.</td></tr>';
  return `
    ${heading(tc(test), 'Local Test Data', test.name, actions)}
    <section class="panel">
      <div class="panel-body">
        <p>Values are collected fresh at the start of every run, replay, debug session and dataset row. Steps in the same execution share the collected value.</p>
        <p>Use <strong>Local Test Data</strong> as the step's Value source and select the variable name. <strong>Keep in global variable</strong> also saves the collected value to the project's globals before the steps run, replacing a global with the same name. Unchecking or removing a local variable does not delete an existing global.</p>
      </div>
      <div class="table-scroll">
        <table class="local-data-table">
          <thead>
            <tr>
              <th>Variable name</th>
              <th>Value / preview</th>
              <th>Value source</th>
              <th>Keep in global variable</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>`;
}

function localRandomFields(config) {
  return `
    <label>Generator<select name="kind" id="local-random-kind">${options(LOCAL_RANDOM_KINDS, config.kind || 'uuid')}</select></label>
    <div class="form-grid">
      ${field('length', 'Text length', config.length ?? 12, 'number', 'min="1" max="256"')}
      ${field('min', 'Minimum number', config.min ?? 1, 'number', LOCAL_NUMBER_BOUNDS)}
      ${field('max', 'Maximum number', config.max ?? 100000, 'number', LOCAL_NUMBER_BOUNDS)}
    </div>
    <p class="form-hint">Length applies to text and email; number bounds apply to whole numbers. A fresh random draw can occasionally repeat a previous value.</p>`;
}

function localVariableFields(source, config) {
  const isGlobal = source === 'global';
  const activeEnvironment = project.environments.find((item) => item.id === project.activeEnvironmentId);
  const variables = isGlobal ? project.globalVariables : activeEnvironment?.variables || {};
  return `
    <label>Source variable<select name="variable" required>${options(Object.keys(variables), config.variable, 'Select a variable')}</select></label>
    <p class="form-hint">Uses the selected ${isGlobal ? 'project global' : 'environment'} value at run time.</p>`;
}

function localRowFields(config) {
  return `
    <div class="form-grid">
      ${field('column', 'Column name (blank uses first)', config.column || '', 'text', 'maxlength="120" list="local-preview-columns"')}
      <label>Row selection<select name="selection">${options(LOCAL_ROW_SELECTIONS, config.selection || 'fixed')}</select></label>
      ${field('row', 'Data row number (first is 1)', config.row ?? 1, 'number', 'min="1" max="100"')}
    </div>
    <datalist id="local-preview-columns"></datalist>`;
}

function localDatabaseFields(config) {
  return `
    <label>Database connection<select name="profileId" required>${options(project.jdbcProfiles, config.profileId || project.activeJdbcProfileId, 'Select a connection')}</select></label>
    <label>SELECT query<textarea name="query" required placeholder="SELECT email FROM test_users ORDER BY id LIMIT 25">${esc(config.query || '')}</textarea></label>
    <p class="form-hint">Configure connections in PostgreSQL. Queries are read-only; omit semicolons. Choose at most 25 rows, 40 columns and 128 characters per cell.</p>
    ${localRowFields(config)}`;
}

function localFileFields(config) {
  const uploadStatus = config.fileId
    ? `Uploaded copy: ${esc(config.fileName)}. Upload again to replace it.`
    : 'Use .xlsx, .csv or .json, up to 1 MB; a header and up to 100 data rows / 100 columns.';
  return `
    <label>Upload Excel, CSV or JSON<input type="file" id="local-data-file" accept=".xlsx,.csv,.json"></label>
    <p class="form-hint" id="local-upload-status">${uploadStatus}</p>
    ${field('filePath', 'Or file path on Studio computer', config.filePath || '', 'text', 'placeholder="D:\\TestData\\users.xlsx"')}
    <p class="form-hint">A local path is read again on every run, including your saved file edits. Uploads use a saved copy. The first row contains column headers. Formula results must be saved by Excel.</p>
    ${field('sheet', 'Excel worksheet (blank uses first)', config.sheet || '', 'text', 'list="local-preview-sheets"')}
    <datalist id="local-preview-sheets"></datalist>
    ${localRowFields(config)}`;
}

function localSourceFields() {
  const { source, value, config } = localDataDraft;
  if (source === 'manual') return `<label>Value<textarea name="localValue" maxlength="10000">${esc(value)}</textarea></label>`;
  if (source === 'random') return localRandomFields(config);
  if (source === 'global' || source === 'environment') return localVariableFields(source, config);
  if (source === 'database') return localDatabaseFields(config);
  return localFileFields(config);
}

function captureLocalDraft() {
  if (!localDataDraft || !$('#local-data-source')) return;
  const form = new FormData($('#dialog-form'));
  const draft = localDataDraft;
  const { config } = draft;
  draft.name = String(form.get('localName') || '').trim();
  draft.keepGlobal = form.has('keepGlobal');
  if (draft.source === 'manual') draft.value = String(form.get('localValue') || '');
  for (const key of ['kind', 'column', 'selection', 'profileId', 'query', 'variable', 'sheet', 'filePath']) {
    if (form.has(key)) config[key] = String(form.get(key));
  }
  for (const key of ['length', 'min', 'max', 'row']) {
    if (form.has(key)) config[key] = Number(form.get(key));
  }
  // A typed path replaces any uploaded copy.
  if (config.filePath?.trim()) {
    config.filePath = config.filePath.trim();
    delete config.fileId;
    delete config.fileName;
  }
}

function isValidLocalName(name) {
  return /^[A-Za-z_][A-Za-z0-9_]{0,119}$/.test(name) && !['__proto__', 'constructor', 'prototype'].includes(name);
}

async function saveLocalVariable() {
  captureLocalDraft();
  if (!isValidLocalName(localDataDraft.name)) throw new Error('Enter a valid variable name');
  if (project.id !== localDataOwner.projectId) {
    throw new Error('The selected project changed; reopen Local Test Data');
  }
  const target = project.tests.find((test) => test.id === localDataOwner.testId);
  if (!target) throw new Error('Test was removed');

  const rows = structuredClone(target.localTestData || []);
  const isDuplicate = rows.some((entry, index) => index !== localDataIndex && entry.name === localDataDraft.name);
  if (isDuplicate) throw new Error('This variable name already exists in the test');
  if (localDataIndex < 0 && rows.length >= LOCAL_MAX_VARIABLES) {
    throw new Error('Maximum 100 local test variables');
  }

  // Validates source configuration without collecting values or contacting a database.
  const validated = await api('/api/local-data/validate', 'POST', { definitions: [localDataDraft] });
  const previousName = rows[localDataIndex]?.name;
  if (localDataIndex < 0) rows.push(validated.definitions[0]);
  else rows[localDataIndex] = validated.definitions[0];
  target.localTestData = rows;

  if (previousName && previousName !== localDataDraft.name) {
    for (const step of target.steps) {
      if (step.valueMode === 'local' && step.value === previousName) step.value = localDataDraft.name;
    }
  }
  markDirty();
  await save();
  render();
  notify('Local test data saved');
}

function openLocalData(index = -1) {
  const test = selected();
  if (selectedKind !== 'tests' || !test) throw new Error('Select a test first');
  localDataIndex = index;
  localDataOwner = { projectId: project.id, testId: test.id };
  localPreviewVersion++;
  localDataDraft = structuredClone(
    test.localTestData?.[index] || { name: '', value: '', source: 'manual', keepGlobal: false, config: {} },
  );
  const sourceChoices = Object.entries(LOCAL_SOURCE_NAMES).map(([id, name]) => ({ id, name }));
  const body = `
    ${field('localName', 'Variable name', localDataDraft.name, 'text', 'required pattern="[A-Za-z_][A-Za-z0-9_]*" maxlength="120" placeholder="CUSTOMER_EMAIL"')}
    <label>Value source<select id="local-data-source">${options(sourceChoices, localDataDraft.source)}</select></label>
    <div id="local-source-fields">${localSourceFields()}</div>
    <label class="local-global-label"><input type="checkbox" name="keepGlobal" ${localDataDraft.keepGlobal ? 'checked' : ''}> Keep in global variable</label>
    <p class="form-hint">The collected value replaces a global with the same name on each run. It remains available to later tests.</p>
    <div class="inline-actions"><button type="button" data-action="preview-local-data">Preview value</button></div>
    <div id="local-data-preview" role="status">${LOCAL_PREVIEW_HINT}</div>`;
  modal(index < 0 ? 'Add local test variable' : 'Edit local test variable', body, saveLocalVariable, 'Save variable');
}

function renderLocalPreviewTable(table) {
  const shown = Math.min(LOCAL_PREVIEW_ROWS, table.rows.length);
  const headerCells = table.columns.map((column) => `<th>${esc(column)}</th>`).join('');
  const bodyRows = table.rows
    .slice(0, LOCAL_PREVIEW_ROWS)
    .map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`)
    .join('');
  return `
    <div class="table-scroll local-preview-table">
      <table>
        <thead><tr>${headerCells}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
    <p class="form-hint">Showing the first ${shown} of ${table.rows.length} rows. Choose a column and row, then preview again.</p>`;
}

function fillLocalPreviewList(id, values) {
  const list = $(id);
  if (list) list.innerHTML = (values || []).map((value) => `<option value="${esc(value)}"></option>`).join('');
}

function showLocalPreview(result) {
  const { table } = result;
  const rowNote = result.row ? `<p>Data row ${result.row}, column ${esc(result.column)}</p>` : '';
  $('#local-data-preview').innerHTML = `
    <p><strong>Preview value:</strong> <span class="local-data-value">${esc(result.value ?? '')}</span></p>
    ${rowNote}
    ${table ? renderLocalPreviewTable(table) : ''}`;
  fillLocalPreviewList('#local-preview-columns', table?.columns);
  fillLocalPreviewList('#local-preview-sheets', table?.sheets);
}

function removeLocalVariable(index) {
  const test = selected();
  const entry = test.localTestData[index];
  modal(
    'Remove local variable',
    `<p>Remove ${esc(entry.name)}? Steps using this local variable will need a replacement. An existing global with this name is kept.</p>`,
    async () => {
      test.localTestData.splice(index, 1);
      markDirty();
      await save();
      render();
    },
    'Remove variable',
  );
}

async function previewLocalVariable(button) {
  captureLocalDraft();
  const version = ++localPreviewVersion;
  button.disabled = true;
  $('#local-data-preview').textContent = 'Collecting preview…';
  try {
    const result = await api('/api/local-data/preview', 'POST', {
      projectId: localDataOwner.projectId,
      definition: { ...localDataDraft, name: localDataDraft.name || 'PREVIEW' },
    });
    if (version !== localPreviewVersion || !$('#dialog').open) return;
    localDataDraft.value = result.value;
    showLocalPreview(result);
  } catch (error) {
    if (version === localPreviewVersion && $('#local-data-preview')) {
      $('#local-data-preview').textContent = error.message;
    }
    throw error;
  } finally {
    button.disabled = false;
  }
}

const LOCAL_DATA_ACTIONS = {
  'local-test-data': () => navigate('local-data'),
  'save-local-data': async () => {
    await save();
    render();
    notify('Local test data saved');
  },
  'add-local-data': async () => {
    await save();
    openLocalData(-1);
  },
  'edit-local-data': async ({ index }) => {
    await save();
    openLocalData(index);
  },
  'remove-local-data': ({ index }) => removeLocalVariable(index),
  'preview-local-data': ({ button }) => previewLocalVariable(button),
};

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

async function uploadLocalFile(file) {
  if (file.size > LOCAL_MAX_FILE_BYTES) throw new Error('Choose a file of 1 MB or smaller');
  const version = ++localPreviewVersion;
  $('#local-upload-status').textContent = 'Uploading…';
  $('#dialog-submit').disabled = true;
  try {
    const content = await readFileAsBase64(file);
    const result = await api('/api/local-data/file', 'POST', { name: file.name, content });
    if (version !== localPreviewVersion || !$('#dialog').open) return;
    Object.assign(localDataDraft.config, { fileId: result.fileId, fileName: result.name, filePath: '' });
    $('#dialog-form [name="filePath"]').value = '';
    $('#local-upload-status').textContent = `Uploaded copy: ${result.name}`;
    showLocalPreview({ value: 'Choose a column and row, then click Preview value.', table: result });
  } catch (error) {
    if (version === localPreviewVersion && $('#local-upload-status')) {
      $('#local-upload-status').textContent = error.message;
    }
    throw error;
  } finally {
    $('#dialog-submit').disabled = false;
  }
}

document.addEventListener('change', async (event) => {
  const element = event.target;
  try {
    if (element.id === 'local-data-source') {
      captureLocalDraft();
      localDataDraft.source = element.value;
      localDataDraft.config = {};
      localDataDraft.value = '';
      localPreviewVersion++;
      $('#local-source-fields').innerHTML = localSourceFields();
      $('#local-data-preview').textContent = LOCAL_PREVIEW_HINT;
    } else if (element.dataset.localGlobal !== undefined) {
      selected().localTestData[Number(element.dataset.localGlobal)].keepGlobal = element.checked;
      markDirty();
    } else if (element.id === 'local-data-file' && element.files[0]) {
      await uploadLocalFile(element.files[0]);
    }
  } catch (error) {
    notify(error.message, true);
  }
});

document.addEventListener('input', (event) => {
  if (event.target.closest('#dialog') && localDataDraft) localPreviewVersion++;
});

document.addEventListener(
  'close',
  (event) => {
    if (event.target.id === 'dialog') localPreviewVersion++;
  },
  true,
);
