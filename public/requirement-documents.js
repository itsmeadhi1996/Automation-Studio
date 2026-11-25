// The Related Document popup on the Requirement page. Documents belong to the project,
// so every requirement in it shares them and the AI reads them when generating test cases.
(() => {
  const ALLOWED_FILES = '.pdf,.docx,.xlsx,.csv,.txt,.md';
  const ALLOWED_EXTENSIONS = new Set(ALLOWED_FILES.split(','));
  const MAX_BYTES = 10 * 1024 * 1024;

  let projectId = '';
  let documents = [];
  let chosenFiles = [];

  const root = () => `/api/projects/${encodeURIComponent(projectId)}/documents`;
  const documentById = (id) => documents.find((item) => item.id === id);

  async function request(url, options = {}) {
    let response;
    try {
      response = await StudioUI.request(url, options);
    } catch {
      throw new Error('QA Studio could not be reached. Check that QA Studio is running, then try again.');
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.userMessage || result.error || 'QA Studio could not finish this request. Try again.');
    return result;
  }

  function formatSize(bytes) {
    return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
  }

  function dialogElement() {
    let dialog = document.querySelector('#documents-dialog');
    if (dialog) return dialog;
    document.body.insertAdjacentHTML(
      'beforeend',
      `<dialog id="documents-dialog" class="documents-dialog" aria-labelledby="documents-title">
        <div class="dialog-header">
          <div>
            <span class="eyebrow">QA STUDIO</span>
            <h2 id="documents-title"></h2>
          </div>
          <button type="button" class="icon-button" data-documents="close" aria-label="Close dialog">${icon('close')}</button>
        </div>
        <div id="documents-body" class="documents-body"></div>
        <p id="documents-error" class="error documents-error" role="alert" hidden></p>
        <div id="documents-actions" class="dialog-footer"></div>
      </dialog>`,
    );
    dialog = document.querySelector('#documents-dialog');
    dialog.addEventListener('click', handleClick);
    dialog.addEventListener('change', handleFilePick);
    dialog.addEventListener('dragover', handleDrag);
    dialog.addEventListener('dragleave', handleDrag);
    dialog.addEventListener('drop', handleDrop);
    return dialog;
  }

  function showView(title, body, actions) {
    const dialog = dialogElement();
    dialog.querySelector('#documents-title').textContent = title;
    dialog.querySelector('#documents-body').innerHTML = body;
    dialog.querySelector('#documents-actions').innerHTML = actions;
    showError('');
    if (!dialog.open) dialog.showModal();
  }

  function showError(message) {
    const box = document.querySelector('#documents-error');
    box.textContent = message;
    box.hidden = !message;
  }

  /* ---- Upload ------------------------------------------------------------- */

  function chosenFilesMarkup() {
    if (!chosenFiles.length) return '';
    const rows = chosenFiles.map(
      (file, index) => `<li>
        <span class="documents-name">${e(file.name)}</span>
        <span class="field-hint">${formatSize(file.size)}</span>
        <button type="button" class="icon-button" data-documents="unchoose" data-index="${index}" aria-label="Remove ${e(file.name)}">${icon('close')}</button>
      </li>`,
    );
    return `<ul class="documents-chosen">${rows.join('')}</ul>`;
  }

  function showUpload() {
    const back = documents.length
      ? `<button type="button" class="button" data-documents="list">${icon('back')}Back to documents</button>`
      : `<button type="button" class="button" data-documents="close">${icon('close')}Cancel</button>`;
    showView(
      'Upload related documents',
      `<p class="field-hint">Add documents about this project, such as specifications, user guides or business rules. The AI reads them to understand the workflow when it generates test cases.</p>
      <label class="documents-drop" id="documents-drop">
        ${icon('upload')}
        <strong>Choose files or drop them here</strong>
        <span class="field-hint">PDF, DOCX, XLSX, CSV, TXT or MD. Up to 10 MB each.</span>
        <input type="file" id="documents-input" multiple accept="${ALLOWED_FILES}">
      </label>
      <div id="documents-chosen">${chosenFilesMarkup()}</div>
      <p class="field-hint">Document text is sent to the AI engine selected on the requirement. Claude, ChatGPT and other cloud engines receive it over the internet, so check documents for confidential data first.</p>`,
      `${back}<button type="button" class="button primary" id="documents-upload" data-documents="upload" ${chosenFiles.length ? '' : 'disabled'}>${icon('upload')}Upload</button>`,
    );
  }

  function refreshChosen() {
    document.querySelector('#documents-chosen').innerHTML = chosenFilesMarkup();
    document.querySelector('#documents-upload').disabled = !chosenFiles.length;
  }

  function fileProblem(file) {
    const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) return `${file.name}: use PDF, DOCX, XLSX, CSV, TXT or MD.`;
    if (file.size > MAX_BYTES) return `${file.name}: documents can be up to 10 MB each.`;
    return '';
  }

  function chooseFiles(files) {
    const problems = files.map(fileProblem).filter(Boolean);
    const known = new Set(chosenFiles.map((file) => file.name.toLowerCase()));
    chosenFiles.push(...files.filter((file) => !fileProblem(file) && !known.has(file.name.toLowerCase())));
    refreshChosen();
    showError(problems.join(' '));
  }

  async function uploadChosen(control) {
    control.disabled = true;
    const failed = [];
    const errors = [];
    for (const file of chosenFiles) {
      try {
        const result = await request(root(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
          body: file,
        });
        documents = result.documents;
      } catch (error) {
        failed.push(file);
        errors.push(`${file.name}: ${error.message}`);
      }
    }
    chosenFiles = failed;
    if (failed.length) {
      showUpload();
      showError(errors.join(' '));
      return;
    }
    notify('Documents uploaded.');
    showList();
  }

  /* ---- List ---------------------------------------------------------------- */

  function documentRow(item) {
    const uploaded = new Date(item.uploadedAt).toLocaleDateString();
    return `<li class="documents-row">
      <div class="documents-details">
        <span class="documents-name">${e(item.name)}</span>
        <span class="field-hint">${formatSize(item.size)} · ${e(uploaded)} · ${e(item.uploadedBy || '')}</span>
        ${item.readable ? '' : '<span class="tag" title="No text could be read, such as in a scanned or password-protected file.">AI cannot read this file</span>'}
      </div>
      <div class="documents-row-actions">
        <button type="button" class="button" data-documents="preview" data-id="${e(item.id)}" aria-label="Preview ${e(item.name)}">${icon('search')}Preview</button>
        <button type="button" class="button danger" data-documents="confirm-delete" data-id="${e(item.id)}" aria-label="Delete ${e(item.name)}">${icon('trash')}Delete</button>
      </div>
    </li>`;
  }

  function showList() {
    showView(
      `Related documents (${documents.length})`,
      `<p class="field-hint">The AI reads these documents when it generates test cases for any requirement in this project.</p>
      <ul class="documents-list">${documents.map(documentRow).join('')}</ul>`,
      `<button type="button" class="button" data-documents="close">${icon('close')}Close</button>
      <button type="button" class="button primary" data-documents="add">${icon('upload')}Upload more</button>`,
    );
  }

  /* ---- Preview and delete ------------------------------------------------------ */

  async function showPreview(id) {
    const item = documentById(id);
    const contentUrl = `${root()}/${encodeURIComponent(id)}/content`;
    const preview = await request(`${root()}/${encodeURIComponent(id)}`);
    const isEmpty = !preview.inline && !preview.text;
    const body = preview.inline
      ? `<iframe class="documents-frame" src="${e(contentUrl)}" title="Preview of ${e(item.name)}"></iframe>`
      : isEmpty
        ? '<p class="field-hint">No text could be read from this file. Download it to open it on your computer.</p>'
        : `<p class="field-hint">Text preview. Download the file to see its original layout.</p><pre class="documents-text">${e(preview.text)}</pre>`;
    showView(
      item.name,
      body,
      `<button type="button" class="button" data-documents="list">${icon('back')}Back to documents</button>
      <a class="button" href="${e(contentUrl)}?download=1" download="${e(item.name)}">${icon('download')}Download</a>`,
    );
    document.querySelector('#documents-dialog').classList.add('wide');
  }

  function showDeleteConfirm(id) {
    const item = documentById(id);
    showView(
      'Delete document?',
      `<p>Delete <strong>${e(item.name)}</strong>? The AI will stop using it for new test cases. Test cases already generated are kept.</p>`,
      `<button type="button" class="button" data-documents="list">${icon('close')}Cancel</button>
      <button type="button" class="button danger" data-documents="delete" data-id="${e(id)}">${icon('trash')}Delete document</button>`,
    );
  }

  async function deleteDocument(control) {
    control.disabled = true;
    const result = await request(`${root()}/${encodeURIComponent(control.dataset.id)}`, { method: 'DELETE' });
    documents = result.documents;
    notify('Document deleted.');
    if (documents.length) showList();
    else showUpload();
  }

  /* ---- Events ---------------------------------------------------------------- */

  const CLICK_ACTIONS = {
    close: () => document.querySelector('#documents-dialog').close(),
    list: showList,
    add: showUpload,
    upload: uploadChosen,
    unchoose: (control) => {
      chosenFiles.splice(Number(control.dataset.index), 1);
      refreshChosen();
    },
    preview: (control) => showPreview(control.dataset.id),
    'confirm-delete': (control) => showDeleteConfirm(control.dataset.id),
    delete: deleteDocument,
  };

  async function handleClick(event) {
    const control = event.target.closest('[data-documents]');
    if (!control || control.disabled) return;
    const dialog = document.querySelector('#documents-dialog');
    if (control.dataset.documents !== 'preview') dialog.classList.remove('wide');
    try {
      await CLICK_ACTIONS[control.dataset.documents]?.(control);
    } catch (error) {
      control.disabled = false;
      showError(error.message);
    }
  }

  function handleFilePick(event) {
    if (event.target.id !== 'documents-input') return;
    chooseFiles([...event.target.files]);
    event.target.value = '';
  }

  function handleDrag(event) {
    const zone = event.target.closest?.('#documents-drop');
    if (!zone) return;
    event.preventDefault();
    zone.classList.toggle('dragging', event.type === 'dragover');
  }

  function handleDrop(event) {
    const zone = event.target.closest?.('#documents-drop');
    if (!zone) return;
    event.preventDefault();
    zone.classList.remove('dragging');
    chooseFiles([...event.dataTransfer.files]);
  }

  // The first visit opens the upload window. Once a project has documents, the list opens instead.
  async function openRelatedDocuments() {
    projectId = project().id;
    chosenFiles = [];
    try {
      documents = (await request(root())).documents;
    } catch (error) {
      notify(error.message, true);
      return;
    }
    dialogElement().classList.remove('wide');
    if (documents.length) showList();
    else showUpload();
  }

  document.addEventListener('click', (event) => {
    const control = event.target.closest('[data-action="related-documents"]');
    if (control && !control.disabled) openRelatedDocuments();
  });
})();
