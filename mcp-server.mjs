import { request } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { studioHeaders } from './auth-client.mjs';
import { registerTestCaseTool } from './test-case-mcp.mjs';

const API_DEADLINE_MS = 30000;
// ReasonX requests run for up to 740 s and may be retried, so a draft outlasts the ordinary API deadline.
const DRAFT_DEADLINE_MS = 1600 * 1000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const LOCAL_HOSTS = ['127.0.0.1', 'localhost'];

const base = process.argv[2] || process.env.STUDIO_URL || 'http://127.0.0.1:3300';
const baseUrl = new URL(base);
if (!LOCAL_HOSTS.includes(baseUrl.hostname) || baseUrl.protocol !== 'http:') {
  throw new Error('STUDIO_URL must be a local HTTP address');
}

// Signing in waits for the first Studio call, so the tool list is available while Studio is stopped.
let pendingHeaders;
function authHeaders() {
  pendingHeaders ??= studioHeaders(base).catch((error) => {
    pendingHeaders = undefined;
    throw error;
  });
  return pendingHeaders;
}

// node:http has only the supplied deadline. Global fetch would also apply a 300 s wait for response headers,
// which a slow local model can exceed.
function send(route, { method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const req = request(new URL(route, base), { method, headers, signal, agent: false }, (res) => {
      res.on('error', reject);
      if (res.statusCode >= 300 && res.statusCode < 400) {
        req.destroy(new Error('Studio redirects are not allowed.'));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('Studio response exceeded the size limit.'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function api(route, method = 'GET', body, deadlineMs = API_DEADLINE_MS) {
  const headers = { 'Content-Type': 'application/json', ...(await authHeaders()) };
  const signal = AbortSignal.timeout(deadlineMs);
  let response;
  try {
    response = await send(route, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw new Error(`Studio request timed out after ${deadlineMs / 1000} seconds.`);
    throw error;
  }
  let data;
  try {
    data = JSON.parse(response.text);
  } catch {
    throw new Error(`Studio returned an unreadable response (HTTP ${response.status}).`);
  }
  const ok = response.status >= 200 && response.status < 300;
  if (!ok) throw new Error(data?.error || `Studio request failed (HTTP ${response.status}).`);
  return data;
}

const tool = (handler) => async (input) => {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await handler(input), null, 2) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
};

const automationProjects = async () => (await api('/api/state?workspace=automation')).projects;

const testSummary = (test) => ({
  id: test.id,
  tcNumber: test.tcNumber,
  name: test.name,
  suiteId: test.suiteId,
  inTestPlan: test.inTestPlan === true,
  stepCount: test.steps.length,
});

const stepSchema = z.object({
  name: z.string(),
  action: z.string(),
  locatorType: z.string(),
  target: z.string(),
  replacement: z.string(),
  value: z.string(),
  valueMode: z.string(),
  framePath: z.array(z.string()).max(10).optional(),
  frame: z.string().optional(),
  qaRequirementId: z.string().optional(),
});

const server = new McpServer({ name: 'automation-studio', version: '1.0.0' });

registerTestCaseTool(server);

server.registerTool(
  'studio_list_projects',
  {
    description: 'List local projects and test summaries without secret values.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  tool(async () => {
    const projects = await automationProjects();
    return projects.map((project) => ({
      id: project.id,
      name: project.name,
      suites: project.suites,
      tests: project.tests.map(testSummary),
    }));
  }),
);

server.registerTool(
  'studio_get_test',
  {
    description: 'Read a test definition. Literal step values may contain test data.',
    inputSchema: { projectId: z.string(), testId: z.string() },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ projectId, testId }) => {
    const projects = await automationProjects();
    const found = projects.find((project) => project.id === projectId)?.tests.find((test) => test.id === testId);
    if (!found) throw new Error('Test not found');
    return found;
  }),
);

server.registerTool(
  'studio_inspect_page',
  {
    description:
      'Inspect the initial target page in a fresh browser. Returns observed fields, buttons, headings and locators ' +
      'without input values. Does not click, fill or submit forms. Omitting url uses the selected environment ' +
      'BASE_URL.',
    inputSchema: { projectId: z.string(), url: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  tool((input) => api('/api/inspect', 'POST', input)),
);

server.registerTool(
  'studio_ai_status',
  {
    description:
      'Report the configured AI provider, the ReasonX local model status (reachable, authorized, available model ' +
      'IDs, reasoning mode) and the MCP server IDs selected as AI context. Never returns keys.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  tool(() => api('/api/ai/status')),
);

server.registerTool(
  'studio_ai_draft_test',
  {
    description:
      'Ask the configured AI model (ReasonX when selected) to draft a browser test from a short workflow ' +
      'description, optionally using read-only context from configured MCP servers. Returns a draft for review; it ' +
      'is not saved or run. Local models are slow and handle one request at a time.',
    inputSchema: {
      projectId: z.string(),
      prompt: z.string().min(1).max(5000),
      mcpServerIds: z.array(z.string()).max(10).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  tool(({ projectId, prompt, mcpServerIds }) =>
    api('/api/ai/draft', 'POST', { projectId, prompt, mcpServerIds: mcpServerIds || [] }, DRAFT_DEADLINE_MS),
  ),
);

server.registerTool(
  'studio_create_test',
  {
    description:
      'Add and save a test case with validated steps in a project. Does not run the test. Use when the user requests ' +
      'test creation.',
    inputSchema: {
      projectId: z.string(),
      name: z.string().min(1).max(120),
      steps: z.array(stepSchema).min(1).max(100),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  tool(({ projectId, ...test }) => api(`/api/projects/${encodeURIComponent(projectId)}/tests`, 'POST', test)),
);

server.registerTool(
  'studio_run',
  {
    description:
      'Execute planned tests in the selected browser. Transfer cases to Test plan first; suite runs include only ' +
      'planned members. Browser steps may change the tested application. Use only when the user requests execution.',
    inputSchema: { projectId: z.string(), testId: z.string().optional(), suiteId: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  tool((input) => api('/api/runs', 'POST', input)),
);

server.registerTool(
  'studio_get_run',
  {
    description: 'Read execution status and diagnostics for a run.',
    inputSchema: { runId: z.string() },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ runId }) => {
    const run = await api(`/api/runs/${encodeURIComponent(runId)}`);
    if (!run) throw new Error('Run not found');
    return run;
  }),
);

await server.connect(new StdioServerTransport());
