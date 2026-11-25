import { randomUUID } from 'node:crypto';

const REQUEST_TIMEOUT_MS = 20000;
const MAX_DETAIL_LENGTH = 1200;
const MAX_SUMMARY_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 20000;
const ISSUE_TYPE_PAGE_SIZE = 100;
const ISSUE_TYPE_START_LIMIT = 1000;
const ATTACHMENT_TIMEOUT_MS = 60000;
const SEVERITY_CHOICES = ['Critical', 'Major', 'Minor', 'Trivial'].map((name) => ({ id: name, name }));

const JIRA_CLOUD_HOST = /^[a-z0-9-]+\.atlassian\.net$/i;
const SITE_URL_HINT = 'Use your Jira Cloud site URL: https://your-team.atlassian.net';
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

const STATUS_MESSAGES = {
  401: 'Jira authentication failed. Check the account email and API token.',
  403: 'Jira denied access. Check Browse Projects and Create Issues permissions.',
  404: 'Jira project or issue type was not found. Check the configuration.',
  429: 'Jira rate limit reached. Wait before trying again.',
};

function httpError(message, status, details = {}) {
  return Object.assign(new Error(message), { status, ...details });
}

function check(condition, message) {
  if (!condition) throw httpError(message, 400);
}

function requiredText(value, label, max = 250) {
  const isValid = typeof value === 'string' && value.trim() && value.length <= max;
  check(isValid, `${label} is required (up to ${max} characters).`);
  return value.trim();
}

function parseSiteUrl(value) {
  const text = requiredText(value, 'Jira site URL', 500);
  let site;
  try {
    site = new URL(text);
  } catch {
    throw httpError(SITE_URL_HINT, 400);
  }
  const isJiraCloudRoot =
    site.protocol === 'https:' &&
    JIRA_CLOUD_HOST.test(site.hostname) &&
    !site.username &&
    !site.password &&
    !site.port &&
    !site.search &&
    !site.hash &&
    site.pathname === '/';
  check(isJiraCloudRoot, SITE_URL_HINT);
  return site.origin;
}

export function normalizeBugTracker(input, previous = {}) {
  check(input && typeof input === 'object' && !Array.isArray(input), 'Invalid bug tracking configuration.');
  const siteUrl = parseSiteUrl(input.siteUrl);
  const email = requiredText(input.email, 'Account email');
  check(/^[^\s@:]+@[^\s@]+\.[^\s@]+$/.test(email), 'Enter a valid Jira account email.');
  const projectKey = requiredText(input.projectKey, 'Project key', 80).toUpperCase();
  check(/^[A-Z][A-Z0-9_]*$/.test(projectKey), 'Enter a valid Jira project key.');
  // A saved token is only reused for the account it was issued to.
  const isSameAccount = previous.siteUrl === siteUrl && previous.email === email;
  const apiKey = requiredText(input.apiKey || (isSameAccount ? previous.apiKey : ''), 'Jira API token', 4000);
  return {
    provider: 'jira',
    siteUrl,
    email,
    apiKey,
    projectKey,
    issueTypeName: requiredText(input.issueTypeName || 'Bug', 'Issue type', 120),
    revision: randomUUID(),
    connected: false,
    verifiedAt: null,
  };
}

export function publicBugTracker(config) {
  if (!config) return { provider: 'jira', connected: false, hasApiKey: false };
  return {
    provider: 'jira',
    siteUrl: config.siteUrl,
    email: config.email,
    projectKey: config.projectKey,
    issueTypeName: config.issueTypeName,
    hasApiKey: Boolean(config.apiKey),
    connected: config.connected === true,
    verifiedAt: config.verifiedAt || null,
    projectName: config.projectName || '',
    accountName: config.accountName || '',
  };
}

const basicCredentials = (config) => Buffer.from(`${config.email}:${config.apiKey}`).toString('base64');

function redactedDetail(detail, config) {
  return String(detail)
    .replaceAll(config.apiKey, '[redacted]')
    .replaceAll(basicCredentials(config), '[redacted]')
    .slice(0, MAX_DETAIL_LENGTH);
}

function rejectionMessage(status, data, config) {
  if (STATUS_MESSAGES[status]) return STATUS_MESSAGES[status];
  const messages = Array.isArray(data.errorMessages) ? data.errorMessages : [];
  const fields = Object.entries(data.errors || {}).map(([key, value]) => `${key}: ${value}`);
  const detail = [...messages, ...fields].join('; ');
  return detail
    ? `Jira rejected the request: ${redactedDetail(detail, config)}.`
    : `Jira rejected the request (HTTP ${status}).`;
}

async function readJson(response) {
  try {
    return (await response.json()) ?? {};
  } catch {
    return {};
  }
}

async function jiraRequest(config, route, fetcher, { method = 'GET', body } = {}) {
  const isPost = method === 'POST';
  let response;
  try {
    response = await fetcher(`${config.siteUrl}/rest/api/3${route}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Basic ${basicCredentials(config)}`,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    const message = isPost
      ? 'Jira did not confirm the result. Check Jira before submitting this issue again.'
      : 'Could not reach Jira. Check the site URL, network connection, and try again.';
    throw httpError(message, 502, { uncertain: isPost });
  }
  const data = await readJson(response);
  if (!response.ok) {
    throw httpError(rejectionMessage(response.status, data, config), 400, {
      authFailed: response.status === 401 || response.status === 403,
      uncertain: isPost && response.status >= 500,
    });
  }
  return data;
}

async function createMetaPages(config, route, readItems, fetcher) {
  const items = [];
  let startAt = 0;
  while (startAt < ISSUE_TYPE_START_LIMIT) {
    const page = await jiraRequest(config, `${route}?startAt=${startAt}&maxResults=${ISSUE_TYPE_PAGE_SIZE}`, fetcher);
    const pageItems = readItems(page);
    check(Array.isArray(pageItems), 'Jira returned invalid issue type metadata.');
    items.push(...pageItems);
    const isFinished = !pageItems.length || page.isLast || startAt + pageItems.length >= page.total;
    if (isFinished) break;
    startAt += pageItems.length;
  }
  return items;
}

async function listIssueTypes(config, fetcher) {
  const route = `/issue/createmeta/${encodeURIComponent(config.projectKey)}/issuetypes`;
  const types = await createMetaPages(config, route, (page) => page.issueTypes, fetcher);
  return types.filter((type) => !type.subtask);
}

async function findIssueType(config, fetcher) {
  const wanted = config.issueTypeName.toLowerCase();
  const types = await listIssueTypes(config, fetcher);
  return types.find((type) => type.name?.toLowerCase() === wanted) || null;
}

const fieldChoices = (field) =>
  (field.allowedValues || [])
    .filter((item) => item?.id)
    .map((item) => ({ id: String(item.id), name: String(item.name ?? item.value ?? item.id) }));

function severityField(field) {
  if (!field) return null;
  const options = fieldChoices(field);
  const isList = field.schema?.type === 'array';
  if (options.length) return { fieldId: field.fieldId, options, isList };
  // A plain text field takes the value as written. Rich text and other types fall back to the description.
  const isPlainText = field.schema?.type === 'string' && !/textarea/i.test(field.schema?.custom || '');
  return isPlainText ? { fieldId: field.fieldId, options: [], isList: false } : null;
}

async function issueFields(config, issueTypeId, fetcher) {
  const route = `/issue/createmeta/${encodeURIComponent(config.projectKey)}/issuetypes/${encodeURIComponent(issueTypeId)}`;
  const fields = await createMetaPages(config, route, (page) => page.fields || page.results || page.values, fetcher);
  const priority = fields.find((field) => field.fieldId === 'priority');
  const severity = severityField(fields.find((field) => /^severity$/i.test(field.name || '')));
  return {
    priority: priority
      ? { options: fieldChoices(priority), defaultId: priority.defaultValue?.id ? String(priority.defaultValue.id) : '' }
      : null,
    severity,
  };
}

// What the report popup can offer for this Jira project and issue type.
export async function jiraIssueOptions(config, issueTypeId, fetcher = fetch) {
  check(config?.connected, 'Connect Jira successfully in Settings before reporting an issue.');
  const types = await listIssueTypes(config, fetcher);
  const selected = types.find((type) => String(type.id) === issueTypeId) ||
    types.find((type) => String(type.id) === config.issueTypeId) ||
    types[0];
  check(selected, 'This Jira project has no issue types available for creation.');
  const query = new URLSearchParams({ projectKey: config.projectKey, permissions: 'CREATE_ATTACHMENTS' });
  const [fields, { permissions }] = await Promise.all([
    issueFields(config, String(selected.id), fetcher),
    jiraRequest(config, `/mypermissions?${query}`, fetcher),
  ]);
  return {
    issueTypes: types.map((type) => ({ id: String(type.id), name: String(type.name) })),
    issueTypeId: String(selected.id),
    priority: fields.priority,
    severity: fields.severity
      ? { inJira: true, options: fields.severity.options.length ? fields.severity.options : SEVERITY_CHOICES }
      : { inJira: false, options: SEVERITY_CHOICES },
    canAttach: permissions?.CREATE_ATTACHMENTS?.havePermission === true,
  };
}

export async function verifyBugTracker(config, fetcher = fetch) {
  check(config?.apiKey, 'Save a Jira connection first.');

  const user = await jiraRequest(config, '/myself', fetcher);
  check(user.accountId && user.active !== false, 'Jira did not confirm an active account.');

  const project = await jiraRequest(config, `/project/${encodeURIComponent(config.projectKey)}`, fetcher);
  check(project.id && project.key, 'Jira did not return the configured project.');

  const query = new URLSearchParams({
    projectKey: config.projectKey,
    permissions: 'BROWSE_PROJECTS,CREATE_ISSUES',
  });
  const { permissions } = await jiraRequest(config, `/mypermissions?${query}`, fetcher);
  check(
    permissions?.BROWSE_PROJECTS?.havePermission && permissions?.CREATE_ISSUES?.havePermission,
    'Jira account needs Browse Projects and Create Issues permissions for this project.',
  );

  const issueType = await findIssueType(config, fetcher);
  check(issueType?.id, `Issue type "${config.issueTypeName}" is not available for creation in this Jira project.`);

  return {
    ...config,
    connected: true,
    verifiedAt: new Date().toISOString(),
    projectId: String(project.id),
    projectName: String(project.name || project.key),
    accountName: String(user.displayName || config.email),
    issueTypeId: String(issueType.id),
  };
}

function composedDescription(input) {
  const sections = [
    ['Steps to reproduce', input.stepsToReproduce],
    ['Expected vs actual', input.results],
    ['Run details', input.runDetails],
  ];
  return sections
    .filter(([, text]) => typeof text === 'string' && text.trim())
    .map(([title, text]) => `${title}:\n${text.trim()}`)
    .join('\n\n');
}

export function issueDraft(input) {
  check(input && typeof input === 'object', 'Enter issue details.');
  return {
    summary: requiredText(input.summary, 'Issue summary', MAX_SUMMARY_LENGTH),
    description: requiredText(input.description ?? composedDescription(input), 'Issue description', MAX_DESCRIPTION_LENGTH),
    ...(input.issueTypeId ? { issueTypeId: String(input.issueTypeId) } : {}),
    ...(input.priorityId ? { priorityId: String(input.priorityId) } : {}),
    ...(input.severity ? { severity: String(input.severity) } : {}),
  };
}

// Turns the popup's choices into Jira fields, after checking them against what Jira currently allows.
async function chosenFields(config, draft, fetcher) {
  const types = await listIssueTypes(config, fetcher);
  check(types.some((type) => String(type.id) === draft.issueTypeId), 'That issue type is not available in this Jira project.');
  const { priority, severity } = await issueFields(config, draft.issueTypeId, fetcher);
  const fields = {};
  let description = draft.description;
  if (draft.priorityId) {
    check(priority?.options.some((item) => item.id === draft.priorityId), 'That priority is not available for this issue type.');
    fields.priority = { id: draft.priorityId };
  }
  if (draft.severity && severity?.options.length) {
    check(severity.options.some((item) => item.id === draft.severity), 'That severity is not available for this issue type.');
    fields[severity.fieldId] = severity.isList ? [{ id: draft.severity }] : { id: draft.severity };
  } else if (draft.severity) {
    const isKnown = SEVERITY_CHOICES.some((item) => item.id === draft.severity);
    check(isKnown, 'Choose a valid severity.');
    if (severity) fields[severity.fieldId] = draft.severity;
    else description = `Severity: ${draft.severity}\n\n${description}`.slice(0, MAX_DESCRIPTION_LENGTH);
  }
  return { fields, description };
}

function atlassianDocument(text) {
  return {
    type: 'doc',
    version: 1,
    content: text.split(/\r?\n/).map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : [],
    })),
  };
}

export async function createJiraIssue(config, input, fetcher = fetch) {
  check(
    config?.connected && config.issueTypeId && config.projectId,
    'Connect Jira successfully in Settings before reporting an issue.',
  );
  const draft = issueDraft(input);
  const { summary } = draft;
  const { fields, description } = draft.issueTypeId
    ? await chosenFields(config, draft, fetcher)
    : { fields: {}, description: draft.description };
  const result = await jiraRequest(config, '/issue', fetcher, {
    method: 'POST',
    body: {
      fields: {
        project: { id: config.projectId },
        issuetype: { id: draft.issueTypeId || config.issueTypeId },
        summary,
        description: atlassianDocument(description),
        ...fields,
      },
    },
  });
  if (typeof result.key !== 'string' || !ISSUE_KEY.test(result.key)) {
    throw httpError('Jira did not return an issue key. Check Jira before submitting again.', 502, { uncertain: true });
  }
  return {
    key: result.key,
    url: `${config.siteUrl}/browse/${encodeURIComponent(result.key)}`,
    summary,
    createdAt: new Date().toISOString(),
  };
}

// Jira takes attachments in a separate multipart request, after the issue exists.
export async function uploadJiraAttachment(config, issueKey, { name, data }, fetcher = fetch) {
  check(config?.connected, 'Connect Jira successfully in Settings before adding attachments.');
  const form = new FormData();
  form.append('file', new Blob([data]), name);
  let response;
  try {
    response = await fetcher(`${config.siteUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(ATTACHMENT_TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
        'X-Atlassian-Token': 'no-check',
        Authorization: `Basic ${basicCredentials(config)}`,
      },
      body: form,
    });
  } catch {
    throw httpError('Could not reach Jira to upload this file. Try again.', 502);
  }
  if (!response.ok) {
    const data = await readJson(response);
    const message = response.status === 413 ? 'Jira rejected this file because it is too large.' : rejectionMessage(response.status, data, config);
    throw httpError(message, 400);
  }
}
