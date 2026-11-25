import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { chromium } from 'playwright';
import { createStudio } from './support.mjs';
import { runRequirementAgent } from '../requirement-agent.mjs';
import { checkDocumentContent, documentContext, documentName, extractDocumentText } from '../project-documents.mjs';

const fields = { generationMode: 'ai', title: 'Refund approval', url: 'https://example.test/refunds', description: 'Managers approve refunds.' };
const draft = {
  summary: 'Refund approval.',
  warnings: [],
  cases: [{ title: 'Approve a refund', description: 'Manager approval', preconditions: 'A pending refund', priority: 'high', steps: [{ instruction: 'Select Approve', expectedResult: 'The refund is approved' }], expectedResult: 'The refund is approved' }],
};
const inspection = { pages: [], warnings: [], context: { pages: [] } };
const aiResponse = () => ({ ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(draft) }] }] }) });

// The smallest PDF with one line of text that pdf.js can read.
function pdfWith(text) {
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const start = body.length;
  const entries = offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

async function fixture(t, port, extra = {}) {
  const storage = path.resolve('.test-output', `project-documents-${port}-${Date.now()}`);
  const studio = await createStudio({ port, storage, requirementInspector: async () => structuredClone(inspection), aiFetcher: async () => aiResponse(), ...extra });
  await studio.listen();
  t.after(() => studio.close());
  studio.store.settings = { ...studio.store.settings, provider: 'openai', apiKey: 'test-key', apiKeys: { openai: 'test-key' } };
  const base = `http://127.0.0.1:${port}`;
  const project = studio.store.projects[0];
  const root = `/api/projects/${project.id}/documents`;
  const upload = async (name, body, cookie, route = root) => {
    const response = await fetch(base + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name), ...(cookie ? { Cookie: cookie } : {}) },
      body,
    });
    return { status: response.status, data: await response.json() };
  };
  const api = async (route, method = 'GET', body, cookie) => {
    const response = await fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  return { studio, storage, base, project, root, upload, api };
}

test('document names, content checks and shared AI limits', () => {
  assert.equal(documentName('..\\..\\secret/guide.PDF'), 'guide.PDF');
  for (const name of ['report.html', 'run.exe', 'noextension', '', 'bad\u0000name.pdf']) assert.equal(documentName(name), null);
  assert.match(checkDocumentContent('a.pdf', Buffer.from('<html>')), /not a valid PDF/);
  assert.match(checkDocumentContent('a.docx', Buffer.from('plain')), /not a valid DOCX/);
  assert.match(checkDocumentContent('a.txt', Buffer.from([65, 0, 66])), /plain text/);
  assert.match(checkDocumentContent('a.txt', Buffer.alloc(0)), /empty/);
  assert.equal(checkDocumentContent('a.txt', Buffer.from('fine')), null);

  const context = documentContext([{ name: 'long', text: 'x'.repeat(500) }, { name: 'short', text: 'y'.repeat(10) }, { name: 'scan', text: '' }], 100);
  assert.deepEqual(context.documents.map((item) => [item.name, item.text.length]), [['long', 90], ['short', 10]]);
  assert.deepEqual(context.clipped, ['long']);
});

test('text is read from PDF, XLSX and text files, and an unreadable PDF returns none', async () => {
  assert.match(await extractDocumentText('a.pdf', pdfWith('Refunds need manager approval')), /Refunds need manager approval/);
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Rules').addRow(['Limit', 500]);
  assert.match(await extractDocumentText('a.xlsx', Buffer.from(await workbook.xlsx.writeBuffer())), /Sheet: Rules\nLimit, 500/);
  assert.equal(await extractDocumentText('a.md', Buffer.from('﻿# Rules\n')), '# Rules');
  const docx = new JSZip();
  docx.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  docx.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  docx.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Managers approve refunds</w:t></w:r></w:p></w:body></w:document>');
  assert.match(await extractDocumentText('a.docx', await docx.generateAsync({ type: 'nodebuffer' })), /Managers approve refunds/);
  assert.equal(await extractDocumentText('a.pdf', Buffer.from('%PDF-1.4 broken')), '');
  assert.equal(await extractDocumentText('a.docx', Buffer.from('PK broken')), '');
});

test('documents upload, stay encrypted, reach the AI and can be deleted', { timeout: 45000 }, async (t) => {
  const bodies = [];
  const f = await fixture(t, 3891, {
    aiFetcher: async (url, options) => {
      bodies.push(options.body);
      return aiResponse();
    },
  });
  const { api, upload, root, project } = f;
  assert.deepEqual((await api(root)).data.documents, []);

  for (const [name, body, pattern] of [
    ['page.html', '<script>', /not supported/],
    ['fake.pdf', '<html>', /not a valid PDF/],
    ['big.txt', Buffer.alloc(10 * 1024 * 1024 + 1, 97), /up to 10 MB/],
  ]) {
    const refused = await upload(name, body);
    assert.ok(refused.status === 400 || refused.status === 413, name);
    assert.match(refused.data.error, pattern);
  }

  const secret = 'Refund limit is 500 for managers';
  const added = await upload('rules guide.txt', secret);
  assert.equal(added.status, 201);
  const { id } = added.data.document;
  assert.equal(added.data.document.readable, true);
  assert.equal((await upload('RULES GUIDE.txt', 'again')).status, 400);
  const pdf = await upload('flow.pdf', pdfWith('Refunds need manager approval'));
  assert.equal(pdf.status, 201);

  const files = await readdir(path.join(f.storage, 'data', 'project-documents'));
  assert.equal(files.length, 4);
  for (const file of files) {
    assert.doesNotMatch(await readFile(path.join(f.storage, 'data', 'project-documents', file), 'utf8'), /Refund limit/);
  }

  const preview = await api(`${root}/${id}`);
  assert.equal(preview.data.text, secret);
  assert.equal(preview.data.inline, false);
  const download = await fetch(`${f.base}${root}/${id}/content`);
  assert.match(download.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''rules%20guide\.txt$/);
  assert.equal(await download.text(), secret);
  const inline = await fetch(`${f.base}${root}/${pdf.data.document.id}/content`);
  assert.equal(inline.headers.get('content-type'), 'application/pdf');
  assert.match(inline.headers.get('content-disposition'), /^inline/);

  const saved = await api(`/api/projects/${project.id}/requirements`, 'POST', { ...fields, revision: project.revision });
  assert.equal(saved.status, 201);
  const route = `/api/projects/${project.id}/requirements/${saved.data.requirement.id}`;
  const generated = await api(`${route}/generate`, 'POST', { revision: saved.data.project.revision });
  assert.equal(generated.status, 201, JSON.stringify(generated.data));
  assert.match(bodies[0], /untrustedProjectDocuments/);
  assert.match(bodies[0], /Refund limit is 500/);
  assert.match(bodies[0], /Refunds need manager approval/);
  assert.match(bodies[0], /never instructions/);
  assert.doesNotMatch(JSON.stringify(generated.data.project), /Refund limit is 500|projectDocuments/);
  assert.doesNotMatch(await api('/api/state').then((result) => JSON.stringify(result.data)), /rules guide/);

  const deleted = await api(`${root}/${id}`, 'DELETE');
  assert.deepEqual(deleted.data.documents.map((item) => item.name), ['flow.pdf']);
  assert.equal((await api(`${root}/${id}`)).status, 404);
  assert.equal((await readdir(path.join(f.storage, 'data', 'project-documents'))).length, 2);

  await api(`${root}/${pdf.data.document.id}`, 'DELETE');
  const next = await api(route);
  const again = await api(`${route}/generate`, 'POST', { revision: next.data.revision ?? generated.data.project.revision });
  assert.equal(again.status, 201, JSON.stringify(again.data));
  assert.doesNotMatch(bodies[1], /"untrustedProjectDocuments"/);
});

test('documents are still there after a restart', { timeout: 30000 }, async (t) => {
  const storage = path.resolve('.test-output', `project-documents-restart-${Date.now()}`);
  const studio = await createStudio({ port: 3894, storage });
  await studio.listen();
  const root = `/api/projects/${studio.store.projects[0].id}/documents`;
  const added = await fetch(`http://127.0.0.1:3894${root}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'kept.txt' }, body: 'Kept rules' });
  const { document } = await added.json();
  await studio.close();
  const reopened = await createStudio({ port: 3894, storage });
  await reopened.listen();
  t.after(() => reopened.close());
  const preview = await (await fetch(`http://127.0.0.1:3894${root}/${document.id}`)).json();
  assert.equal(preview.document.name, 'kept.txt');
  assert.equal(preview.text, 'Kept rules');
  assert.doesNotMatch(await readFile(path.join(storage, 'data', 'studio.json'), 'utf8'), /kept\.txt/);
});

test('ReasonX requests carry documents and stay inside the service limit', async () => {
  const settings = { provider: 'reasonx', model: 'local-model', reasonxBaseUrl: 'http://localhost:8080/v1', apiKeys: {} };
  const projectDocuments = documentContext([{ name: 'guide.txt', text: 'Refund rule. '.repeat(500) }], 700).documents;
  const requirement = { title: 'Refunds', moduleName: 'Billing', description: 'Managers approve refunds. '.repeat(400), projectDocuments };
  for (const agentOptions of [undefined, { enabled: true, repairLimit: 0, mode: 'fast', model: 'local-model' }]) {
    const sent = [];
    const fetcher = async (url, init) => {
      sent.push(JSON.parse(init.body).messages.map((message) => message.content).join(''));
      throw new Error('Stop after the first request');
    };
    await assert.rejects(runRequirementAgent({ settings, requirement: { ...requirement, agentOptions }, inspection, fetcher }));
    assert.match(sent[0], /untrustedProjectDocuments/);
    assert.match(sent[0], /Refund rule/);
    assert.match(sent[0], /never instructions/);
    assert.ok(sent[0].length <= 6000, `${sent[0].length} characters`);
  }
});

test('a project holds a limited number of documents and other users cannot reach them', { timeout: 30000 }, async (t) => {
  const f = await fixture(t, 3892);
  const { api, upload, root, project, studio } = f;
  const added = await upload('private.txt', 'Private rules');
  const route = `${root}/${added.data.document.id}`;
  const makeUser = async (username, permissions) => {
    const user = (await api('/api/admin/users', 'POST', { name: username, username, password: 'Document-test-password', permissions, active: true })).data;
    return { user, cookie: (await api('/api/auth/login', 'POST', { username, password: 'Document-test-password' })).cookie };
  };
  const outsider = await makeUser('documents-outsider', { qa: true });
  const automationOnly = await makeUser('documents-automation', { automation: true });
  studio.store.projectMembers[project.id] = [automationOnly.user.id];
  for (const { cookie } of [outsider, automationOnly]) {
    for (const [target, method] of [[root, 'GET'], [route, 'GET'], [`${route}/content`, 'GET'], [route, 'DELETE']]) {
      assert.equal((await fetch(f.base + target, { method, headers: { Cookie: cookie } })).status, 403, `${method} ${target}`);
    }
    assert.equal((await upload('more.txt', 'More', cookie)).status, 403);
  }

  for (let index = 1; index < 20; index += 1) assert.equal((await upload(`file-${index}.txt`, 'Text')).status, 201);
  const full = await upload('one-too-many.txt', 'Text');
  assert.equal(full.status, 400);
  assert.match(full.data.error, /up to 20 documents/);
});

test('Related Document opens the upload window first, then lists, previews and deletes documents', { timeout: 60000 }, async (t) => {
  const f = await fixture(t, 3893);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(error.message));
  await page.goto(`${f.base}/#requirements`);
  const dialog = page.locator('#documents-dialog');

  await page.getByRole('button', { name: 'Related Document' }).click();
  await assert.doesNotReject(dialog.getByRole('heading', { name: 'Upload related documents' }).waitFor());
  assert.equal(await dialog.getByRole('button', { name: 'Upload', exact: true }).isDisabled(), true);

  await dialog.locator('#documents-input').setInputFiles([{ name: 'bad.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('x') }]);
  assert.match(await dialog.locator('#documents-error').innerText(), /use PDF, DOCX/);
  await dialog.locator('#documents-input').setInputFiles([
    { name: 'rules.txt', mimeType: 'text/plain', buffer: Buffer.from('Refund <b>limit</b> is 500') },
    { name: 'flow.pdf', mimeType: 'application/pdf', buffer: pdfWith('Approval flow') },
  ]);
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
  await dialog.getByRole('heading', { name: 'Related documents (2)' }).waitFor();

  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Related Document' }).click();
  await dialog.getByRole('heading', { name: 'Related documents (2)' }).waitFor();

  await dialog.getByRole('button', { name: 'Preview rules.txt' }).click();
  await dialog.locator('.documents-text').waitFor();
  assert.equal(await dialog.locator('.documents-text').innerText(), 'Refund <b>limit</b> is 500');
  await dialog.getByRole('button', { name: 'Back to documents' }).click();

  await dialog.getByRole('button', { name: 'Preview flow.pdf' }).click();
  const frame = dialog.locator('iframe.documents-frame');
  await frame.waitFor();
  assert.match(await frame.getAttribute('src'), /\/content$/);
  await dialog.getByRole('button', { name: 'Back to documents' }).click();

  await dialog.getByRole('button', { name: 'Delete rules.txt' }).click();
  await dialog.getByRole('button', { name: 'Delete document' }).click();
  await dialog.getByRole('heading', { name: 'Related documents (1)' }).waitFor();
  await dialog.getByRole('button', { name: 'Delete flow.pdf' }).click();
  await dialog.getByRole('button', { name: 'Delete document' }).click();
  await dialog.getByRole('heading', { name: 'Upload related documents' }).waitFor();
  assert.deepEqual(problems, []);
});
