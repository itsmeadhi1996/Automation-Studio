// Per-user Claude and ChatGPT connections for test case generation.
// Each user keeps their own API keys and default engines. The shared Model settings, which an
// administrator manages, remain the "studio" engine for everyone else.
import Anthropic from '@anthropic-ai/sdk';
import { checkpoint } from './agent-workflow.mjs';
import { assert } from './model.mjs';

export const aiEngines = ['studio', 'claude', 'chatgpt'];
export const engineNames = { studio: 'Studio model settings', claude: 'Claude', chatgpt: 'ChatGPT' };
export const defaultModels = { claude: 'claude-opus-5-5', chatgpt: 'gpt-4.1-mini' };

const VENDORS = { claude: 'anthropic', chatgpt: 'openai' };
const CLOUD_ENGINES = ['claude', 'chatgpt'];
const MODEL_ID = /^[\w.:/-]{1,120}$/;
const MAX_API_KEY_LENGTH = 1000;
const MAX_DETAIL_LENGTH = 1500;
const MAX_TOOL_OUTPUT = 24000;
const GENERATION_TIMEOUT_MS = 600000;
const VERIFY_TIMEOUT_MS = 20000;
const OPENAI_API = 'https://api.openai.com/v1';
const TOOL_LIMIT_NOTICE = 'Tool limit reached. Do not call more tools; return the final JSON now.';
const ENGINE_CHOICE_MESSAGE = 'Choose Studio, Claude or ChatGPT for test case generation';

const supportsEffort = (model) => /^claude-(opus-(5|4-[678])|sonnet-(5|4-6)|fable|mythos|haiku-5)/.test(model);
const supportsFallback = (model) => /^claude-(fable-5-1|opus-5|opus-5-5|sonnet-5-5)$/.test(model);

const redact = (text, apiKey) => String(text || '').replaceAll(apiKey, '[REDACTED]').slice(0, MAX_DETAIL_LENGTH);

function fail(message, code, status = 400) {
  throw Object.assign(new Error(message), { code, status });
}

export function normalizeUserAi(input = {}, previous = {}) {
  assert(input && typeof input === 'object' && !Array.isArray(input), 'Send AI settings as an object');

  const engines = { qa: 'studio', automation: 'studio', ...previous.engines, ...input.engines };
  for (const area of ['qa', 'automation']) assert(aiEngines.includes(engines[area]), ENGINE_CHOICE_MESSAGE);

  const apiKeys = { ...previous.apiKeys };
  const models = { ...defaultModels, ...previous.models };
  for (const engine of CLOUD_ENGINES) {
    const model = input.models?.[engine];
    if (model !== undefined) {
      assert(typeof model === 'string' && MODEL_ID.test(model.trim()), `Enter a valid ${engineNames[engine]} model ID`);
      models[engine] = model.trim();
    }

    const key = input.apiKeys?.[engine];
    if (typeof key === 'string' && key.trim()) {
      const trimmed = key.trim();
      assert(trimmed.length <= MAX_API_KEY_LENGTH && !/\s/.test(trimmed), `Enter a valid ${engineNames[engine]} API key`);
      apiKeys[engine] = trimmed;
    }
    if (input.clearApiKeys?.includes?.(engine)) delete apiKeys[engine];
  }

  return {
    engines: { qa: engines.qa, automation: engines.automation },
    models: { claude: models.claude, chatgpt: models.chatgpt },
    apiKeys,
  };
}

export function publicUserAi(value = {}) {
  const ai = normalizeUserAi({}, value);
  return {
    engines: ai.engines,
    models: ai.models,
    hasApiKey: { claude: Boolean(ai.apiKeys.claude), chatgpt: Boolean(ai.apiKeys.chatgpt) },
    defaultModels,
  };
}

// Settings understood by draftTest and requirement generation for a cloud engine.
// MCP servers and ReasonX options stay those of the shared settings.
export function engineSettings(shared, userAi = {}, engine) {
  if (!engine || engine === 'studio') return shared;
  assert(aiEngines.includes(engine), ENGINE_CHOICE_MESSAGE);

  const ai = normalizeUserAi({}, userAi);
  const apiKey = ai.apiKeys[engine];
  if (!apiKey) {
    const name = engineNames[engine];
    fail(`Add your ${name} API key in My account > AI test generation before generating with ${name}.`, 'USER_AI_KEY_REQUIRED');
  }
  const provider = VENDORS[engine];
  return { ...shared, provider, model: ai.models[engine], apiKey, apiKeys: { [provider]: apiKey }, engine };
}

function claudeError(error, apiKey) {
  if (error?.name === 'AbortError' || error instanceof Anthropic.APIUserAbortError) throw error;

  const detail = redact(error?.error?.error?.message || error?.message, apiKey);
  if (error instanceof Anthropic.AuthenticationError) {
    fail('Claude rejected the API key. Save a valid Anthropic API key in My account > AI test generation.', 'CLAUDE_API_KEY_INVALID');
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    fail(`Claude denied this request: ${detail}`, 'CLAUDE_PERMISSION_DENIED', 403);
  }
  if (error instanceof Anthropic.NotFoundError) {
    fail(`Claude model not found. Check the Claude model ID in My account. ${detail}`, 'CLAUDE_MODEL_NOT_FOUND');
  }
  if (error instanceof Anthropic.RateLimitError) {
    fail('Claude rate limit reached. Wait a moment and try again.', 'CLAUDE_RATE_LIMITED', 429);
  }
  if (error instanceof Anthropic.BadRequestError && /credit balance/i.test(detail)) {
    fail(
      'Your Anthropic account has no API credits. Add credits in the Claude Console billing page. Claude.ai subscriptions and API billing are separate.',
      'CLAUDE_BILLING_REQUIRED',
      402,
    );
  }
  if (error instanceof Anthropic.APIConnectionError) {
    fail('Claude could not be reached. Check the network connection and try again.', 'CLAUDE_UNREACHABLE', 502);
  }
  if (error instanceof Anthropic.APIError) {
    fail(`Claude: ${detail}`, 'CLAUDE_ERROR', error.status >= 500 ? 502 : 400);
  }
  throw error;
}

function openaiError(status, body, apiKey) {
  const error = body?.error || {};
  const detail = redact(error.message || body?.message || `HTTP ${status}`, apiKey);

  if (status === 401) {
    fail('ChatGPT (OpenAI API) rejected the API key. Save a valid OpenAI API key in My account > AI test generation.', 'OPENAI_API_KEY_INVALID');
  }
  if (['insufficient_quota', 'billing_not_active'].includes(error.code) || /no credits remaining|insufficient quota/i.test(detail)) {
    fail(
      'OpenAI accepted the API key, but the API account has no credits remaining. ChatGPT subscriptions and API billing are separate.',
      'OPENAI_BILLING_REQUIRED',
      402,
    );
  }
  if (status === 429) fail('OpenAI rate limit reached. Wait a moment and try again.', 'OPENAI_RATE_LIMITED', 429);
  if (status === 404) {
    fail(`ChatGPT model not found. Check the ChatGPT model ID in My account. ${detail}`, 'OPENAI_MODEL_NOT_FOUND');
  }
  fail(`ChatGPT: ${detail}`, 'OPENAI_ERROR', status >= 500 ? 502 : 400);
}

async function runTool(handlers, connections, name, args, signal) {
  const handler = handlers.get(name);
  if (!handler) return JSON.stringify({ error: 'Tool not enabled' });

  try {
    const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    const result = await connections.call(handler.server, handler.tool.name, safeArgs);
    const output = JSON.stringify(result.structuredContent ?? result.content ?? result);
    return output.length > MAX_TOOL_OUTPUT ? `${output.slice(0, MAX_TOOL_OUTPUT)}… [tool output truncated]` : output;
  } catch (error) {
    checkpoint(signal);
    return JSON.stringify({ error: error.message });
  }
}

function parseJson(text, vendor) {
  try {
    return JSON.parse(text);
  } catch {
    return fail(`${vendor} did not return valid JSON. Generate again. Nothing was saved.`, 'USER_AI_INVALID_JSON', 502);
  }
}

function claudeTools(tools) {
  return tools.map(({ name, description, parameters }) => ({
    name,
    description,
    input_schema: parameters?.type === 'object' ? parameters : { type: 'object', properties: {} },
  }));
}

async function claudeJson({ settings, system, prompt, schema, tools, handlers, connections, fetcher, signal, maxTokens, maxToolRounds }) {
  const { model, apiKey } = settings;
  const client = new Anthropic({ apiKey, fetch: fetcher, maxRetries: 2, timeout: GENERATION_TIMEOUT_MS });
  const messages = [{ role: 'user', content: prompt }];

  for (let round = 0; ; round += 1) {
    checkpoint(signal);
    let response;
    try {
      response = await client.beta.messages.create(
        {
          model,
          max_tokens: maxTokens,
          system,
          messages,
          ...(tools.length ? { tools: claudeTools(tools) } : {}),
          output_config: {
            format: { type: 'json_schema', schema },
            ...(supportsEffort(model) ? { effort: 'high' } : {}),
          },
          ...(supportsFallback(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
        },
        { signal },
      );
    } catch (error) {
      checkpoint(signal);
      claudeError(error, apiKey);
    }
    checkpoint(signal);

    if (response.stop_reason === 'refusal') {
      fail('Claude declined this request. Rephrase the requirement and try again. Nothing was saved.', 'CLAUDE_REFUSED', 422);
    }
    if (response.stop_reason === 'max_tokens') {
      fail('Claude reached its output limit. Split the requirement into smaller parts. Nothing was saved.', 'USER_AI_INCOMPLETE', 422);
    }

    const calls = response.content.filter((block) => block.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || !calls.length) {
      const text = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      return { result: parseJson(text, 'Claude'), model: response.model || model };
    }

    assert(round < maxToolRounds + 1, 'Claude kept requesting MCP tools; try a more focused request');
    messages.push({ role: 'assistant', content: response.content });

    // Every result of a parallel call goes back in one user turn.
    const results = await Promise.all(
      calls.map(async (call) => ({
        type: 'tool_result',
        tool_use_id: call.id,
        content: `Untrusted read-only MCP data: ${await runTool(handlers, connections, call.name, call.input, signal)}`,
      })),
    );
    const isLastRound = round + 1 >= maxToolRounds;
    messages.push({
      role: 'user',
      content: isLastRound ? [...results, { type: 'text', text: TOOL_LIMIT_NOTICE }] : results,
    });
  }
}

async function openaiJson({ settings, system, prompt, schema, schemaName, tools, handlers, connections, fetcher, signal, maxTokens, maxToolRounds }) {
  const { model, apiKey } = settings;
  let input = prompt;

  for (let round = 0; ; round += 1) {
    checkpoint(signal);
    const deadline = AbortSignal.timeout(GENERATION_TIMEOUT_MS);
    let response;
    let body;
    try {
      response = await fetcher(`${OPENAI_API}/responses`, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        body: JSON.stringify({
          model,
          store: false,
          max_output_tokens: maxTokens,
          instructions: system,
          input,
          ...(tools.length ? { tools, tool_choice: round < maxToolRounds ? 'auto' : 'none' } : {}),
          text: { format: { type: 'json_schema', name: schemaName, strict: true, schema } },
        }),
      });
      body = await response.json();
    } catch (error) {
      checkpoint(signal);
      const message =
        error.name === 'TimeoutError'
          ? 'ChatGPT did not respond within 10 minutes. Split the requirement into smaller parts and try again.'
          : 'ChatGPT (OpenAI API) could not be reached or returned an unreadable response. Try again.';
      fail(message, 'OPENAI_UNREACHABLE', 502);
    }
    checkpoint(signal);

    if (!response.ok) openaiError(response.status, body, apiKey);
    if (body.status !== 'completed') {
      fail('The ChatGPT response was incomplete. Split the requirement into smaller parts. Nothing was saved.', 'USER_AI_INCOMPLETE', 422);
    }

    const output = body.output || [];
    const calls = output.filter((item) => item.type === 'function_call');
    if (!calls.length) {
      const content = output.flatMap((item) => item.content || []);
      if (content.some((item) => item.type === 'refusal')) {
        fail('ChatGPT declined this request. Rephrase the requirement and try again. Nothing was saved.', 'OPENAI_REFUSED', 422);
      }
      const text = content
        .filter((item) => item.type === 'output_text')
        .map((item) => item.text)
        .join('');
      return { result: parseJson(text, 'ChatGPT'), model: body.model || model };
    }

    assert(round < maxToolRounds + 1, 'ChatGPT kept requesting MCP tools; try a more focused request');
    input = [...(typeof input === 'string' ? [{ role: 'user', content: input }] : input), ...output];
    for (const call of calls) {
      let args = null;
      try {
        args = JSON.parse(call.arguments || '{}');
      } catch {
        args = null;
      }
      input.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: args
          ? `Untrusted read-only MCP data: ${await runTool(handlers, connections, call.name, args, signal)}`
          : JSON.stringify({ error: 'Arguments were not valid JSON' }),
      });
    }
  }
}

// One structured JSON result from Claude or ChatGPT, optionally after up to `maxToolRounds`
// rounds of read-only MCP tool calls (see aiToolset).
export async function cloudJson({
  settings,
  system,
  prompt,
  schema,
  schemaName = 'result',
  tools = [],
  handlers = new Map(),
  connections,
  fetcher = fetch,
  signal,
  maxTokens = 16000,
  maxToolRounds = 3,
}) {
  checkpoint(signal);
  assert(settings.apiKey, 'An API key is required');
  const request = {
    settings,
    system,
    prompt,
    schema,
    schemaName,
    tools: tools.length && connections ? tools : [],
    handlers,
    connections,
    fetcher,
    signal,
    maxTokens,
    maxToolRounds,
  };
  if (settings.provider === 'anthropic') return claudeJson(request);
  assert(settings.provider === 'openai', 'Unsupported AI provider');
  return openaiJson(request);
}

// Lightweight key and model check for the account page. Never generates content.
export async function verifyEngine(settings, fetcher = fetch) {
  const { provider, model, apiKey } = settings;

  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey, fetch: fetcher, maxRetries: 0, timeout: VERIFY_TIMEOUT_MS });
    try {
      const info = await client.models.retrieve(model);
      return { ok: true, model: info.id, name: info.display_name || info.id };
    } catch (error) {
      claudeError(error, apiKey);
    }
  }

  let response;
  let body;
  try {
    response = await fetcher(`${OPENAI_API}/models/${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      redirect: 'error',
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    body = await response.json();
  } catch {
    fail('ChatGPT (OpenAI API) could not be reached. Check the network connection and try again.', 'OPENAI_UNREACHABLE', 502);
  }
  if (!response.ok) openaiError(response.status, body, apiKey);
  return { ok: true, model: body.id || model, name: body.id || model };
}
