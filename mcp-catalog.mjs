import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const AUTH_TYPES = ['none', 'basic', 'bearer'];
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const MAX_USERNAME = 250;
const MAX_TOKEN = 4000;
const REDACTED = '[redacted]';

function playwrightCli() {
  return path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
}

export function mcpCatalog() {
  const playwrightName = 'Microsoft Playwright MCP';
  const atlassianName = 'Atlassian MCP · Jira & Confluence';
  return [
    {
      id: 'playwright',
      name: playwrightName,
      description:
        'Inspect pages, take screenshots, and interact with a browser. Uses the Playwright package already installed with Studio.',
      docsUrl: 'https://github.com/microsoft/playwright-mcp',
      config: {
        name: playwrightName,
        transport: 'stdio',
        command: process.execPath,
        args: [playwrightCli(), 'mcp', '--browser', 'chrome', '--isolated', '--headless', '--timeout-action', '30000'],
      },
    },
    {
      id: 'atlassian',
      name: atlassianName,
      description:
        'Search Jira and Confluence and work with issues through Atlassian’s official cloud server. Requires a scoped API token and organization approval for API-token authentication.',
      docsUrl: 'https://developer.atlassian.com/cloud/rovo-mcp/guides/configuring-authentication-via-api-token/',
      config: {
        name: atlassianName,
        transport: 'http',
        url: 'https://mcp.atlassian.com/v2/mcp?tools=all',
        authType: 'basic',
        username: '',
        apiKey: '',
      },
    },
  ];
}

// A saved token is only reused for the endpoint, auth type and account it was entered for.
export function normalizeMcpAuth(input, previous, url) {
  const authType = input.authType || 'none';
  if (!AUTH_TYPES.includes(authType)) throw new Error('Choose no authentication, Basic, or Bearer.');
  if (authType === 'none') return { authType };

  if (url.protocol !== 'https:' && !LOOPBACK_HOSTS.includes(url.hostname)) {
    throw new Error('Authenticated MCP connections require HTTPS.');
  }
  if (input.username !== undefined && typeof input.username !== 'string') {
    throw new Error('Invalid MCP account email or username.');
  }
  const username = authType === 'basic' ? (input.username || '').trim() : '';
  if (username.length > MAX_USERNAME || /[:\r\n]/.test(username)) {
    throw new Error('Invalid MCP account email or username.');
  }

  const isSameAccount =
    previous?.transport === 'http' &&
    previous.url === url.href &&
    previous.authType === authType &&
    previous.username === username;
  const retained = isSameAccount ? previous.apiKey : '';
  const apiKey = input.clearApiKey ? '' : input.apiKey || retained || '';
  if (typeof apiKey !== 'string' || apiKey.length > MAX_TOKEN || /[\r\n]/.test(apiKey)) {
    throw new Error('Invalid MCP API token.');
  }
  return { authType, username, apiKey };
}

export function publicMcpServer(server) {
  const { apiKey, ...visible } = server;
  if (!server.authType || server.authType === 'none') return visible;
  return { ...visible, hasApiKey: Boolean(apiKey) };
}

function basicCredentials(server) {
  return Buffer.from(`${server.username}:${server.apiKey}`).toString('base64');
}

export function mcpAuthorization(server) {
  if (!server.authType || server.authType === 'none') return undefined;
  if (!server.apiKey || (server.authType === 'basic' && !server.username)) {
    throw new Error('Add the MCP account credentials using Edit before connecting.');
  }
  return server.authType === 'basic' ? `Basic ${basicCredentials(server)}` : `Bearer ${server.apiKey}`;
}

function secretsOf(server) {
  if (!server.apiKey) return [];
  return server.authType === 'basic' ? [server.apiKey, basicCredentials(server)] : [server.apiKey];
}

export function redactMcp(server, value) {
  const clean = (text) => secretsOf(server).reduce((result, secret) => result.replaceAll(secret, REDACTED), text);

  if (typeof value === 'string') return clean(value);
  if (Array.isArray(value)) return value.map((item) => redactMcp(server, item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [clean(key), redactMcp(server, item)]));
  }
  return value;
}
