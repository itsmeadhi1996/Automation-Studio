import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { generateTestCases, generationInputSchema, generationOutputSchema } from './test-case-generator.mjs';

const TOOL_DESCRIPTION =
  'Generate editable manual test scenarios from supplied requirements, optional page metadata and explicit local ' +
  'rule templates. No AI key, app connection, browser, network requests, scans, or load tests. Returns limited ' +
  'coverage and marked assumptions; does not save or execute cases.';

export function registerTestCaseTool(server) {
  server.registerTool(
    'generate_test_cases',
    {
      title: 'Generate test cases locally',
      description: TOOL_DESCRIPTION,
      inputSchema: generationInputSchema,
      outputSchema: generationOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        const output = generateTestCases(input);
        return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    },
  );
}

export function createTestCaseMcpServer() {
  const server = new McpServer({ name: 'qa-studio-test-cases', version: '1.0.0' });
  registerTestCaseTool(server);
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  // stdout is reserved for MCP JSON-RPC. No input, credentials or diagnostics are logged.
  await createTestCaseMcpServer().connect(new StdioServerTransport());
}
