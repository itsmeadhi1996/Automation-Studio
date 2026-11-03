import { randomUUID } from 'node:crypto';

const REQUEST_TIMEOUT_MS = 20000;
const MAX_DETAIL_LENGTH = 1200;
const MAX_SUMMARY_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 20000;
const ISSUE_TYPE_PAGE_SIZE = 100;
const ISSUE_TYPE_START_LIMIT = 1000;

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

async function findIssueType(config, fetcher) {
  const key = encodeURIComponent(config.projectKey);
  const wanted = config.issueTypeName.toLowerCase();
  let startAt = 0;
  while (startAt < ISSUE_TYPE_START_LIMIT) {
    const route = `/issue/createmeta/${key}/issuetypes?startAt=${startAt}&maxResults=${ISSUE_TYPE_PAGE_SIZE}`;
    const page = await jiraRequest(config, route, fetcher);
    check(Array.isArray(page.issueTypes), 'Jira returned invalid issue type metadata.');
    const match = page.issueTypes.find((type) => !type.subtask && type.name?.toLowerCase() === wanted);
    if (match) return match;
    const isFinished = !page.issueTypes.length || page.isLast || startAt + page.issueTypes.length >= page.total;
    if (isFinished) return null;
    startAt += page.issueTypes.length;
  }
  return null;
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

export function issueDraft(input) {
  check(input && typeof input === 'object', 'Enter issue details.');
  return {
    summary: requiredText(input.summary, 'Issue summary', MAX_SUMMARY_LENGTH),
    description: requiredText(input.description, 'Issue description', MAX_DESCRIPTION_LENGTH),
  };
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
  const { summary, description } = issueDraft(input);
  const result = await jiraRequest(config, '/issue', fetcher, {
    method: 'POST',
    body: {
      fields: {
        project: { id: config.projectId },
        issuetype: { id: config.issueTypeId },
        summary,
        description: atlassianDocument(description),
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
