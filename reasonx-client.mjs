// Client for the local ReasonX API (OpenAI-style /v1/chat/completions, non-streaming, text only).
// ReasonX routes `reasonx-v1` by task complexity to qwen3:1.7b (FAST), qwen3:4b-thinking (STANDARD),
// qwen3:8b (DEEP) or qwen3:14b (EXPERT). It allows one inference at a time (HTTP 429 when busy),
// caps max_tokens at 1024, and rejects tools, JSON mode and streaming.
import { checkpoint } from './agent-workflow.mjs';
import { isLocalUrl, localHttpRequest } from './ollama-http.mjs';
import './public/reasonx-models.js';

const { modelOptions, modeOptions } = globalThis.StudioReasonx;

export const reasonxModels = Object.freeze(modelOptions.map((option) => option.id));
export const reasonxModes = Object.freeze(modeOptions.map((option) => option.id));
export const reasonxMaxTokens = 1024;

const DEFAULT_MAX_TOKENS = 512;
const BUSY_RETRIES = 3;
const BUSY_DELAY_MS = 4000;
const SLOW_MODEL_FLOOR_MS = 250000;
const FAST_MODEL_FLOOR_MS = 130000;
const MODEL_LIST_TIMEOUT_MS = 5000;

// Worst-case wall time of one request, for each reasoning mode.
const MODE_TIMEOUTS = Object.fromEntries(modeOptions.map((option) => [option.id, option.timeoutMs]));

// `draftTest` and the server pass global fetch as their default. That still means "use the
// default transport", because fetch's headers timeout is shorter than a slow ReasonX request.
const nativeFetch = globalThis.fetch;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function normalizeReasonxMode(value) {
  const mode = String(value ?? 'auto').toLowerCase();
  return reasonxModes.includes(mode) ? mode : 'auto';
}

export function reasonxTimeout(mode, model = 'reasonx-v1') {
  const floor = model !== 'reasonx-v1' && model !== 'qwen3:1.7b' ? SLOW_MODEL_FLOOR_MS : FAST_MODEL_FLOOR_MS;
  return Math.max(MODE_TIMEOUTS[normalizeReasonxMode(mode)], floor);
}

export class ReasonxError extends Error {
  // kind: timeout | unreachable | non-json | auth | busy | budget | model | too-large | upstream | http
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'ReasonxError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

function classify(status, code) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'busy';
  if (status === 422 || code === 'generation_budget_exhausted') return 'budget';
  if (status === 404) return 'model';
  if (status === 413) return 'too-large';
  if ([502, 503, 504].includes(status)) return 'upstream';
  return 'http';
}

// Same transport as Ollama: no headers timeout, only the deadline in `signal`.
export async function fetchReasonx(url, options = {}) {
  const target = new URL(url);
  if (!isLocalUrl(target, ['http:', 'https:'])) {
    throw new TypeError('ReasonX requests require a local URL without credentials.');
  }
  return localHttpRequest(target, { ...options, service: 'ReasonX' });
}

// node:http reports a deadline as AbortError with the TimeoutError as its cause.
function isTimeout(error) {
  return error.name === 'TimeoutError' || error.cause?.name === 'TimeoutError';
}

// Waits before a busy retry, and stops at once if the generation is cancelled.
async function waitForRetry(ms, sleep, signal) {
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(Object.assign(new Error('Generation cancelled.'), { code: 'GENERATION_CANCELLED' }));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  try {
    await Promise.race([sleep(ms), cancelled]);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

function chatBody({ model, messages, maxTokens, temperature, mode }) {
  return JSON.stringify({
    model,
    messages,
    max_tokens: Math.max(1, Math.min(reasonxMaxTokens, Math.trunc(maxTokens) || DEFAULT_MAX_TOKENS)),
    stream: false,
    ...(temperature === undefined ? {} : { temperature }),
    ...(mode === 'auto' ? {} : { reasoning_mode: mode.toUpperCase() }),
  });
}

// One chat completion. Returns {text, finish, refused, reasoning, usage}. Callers decide how to word
// finish, refusal and empty-text problems. `reasoning` is ReasonX's extension ({mode, backend_model,
// calls, review, independently_verified}); its review is a second opinion, never proof.
export async function reasonxChat({
  fetcher = fetchReasonx,
  endpoint,
  apiKey = '',
  model,
  mode,
  messages,
  maxTokens = DEFAULT_MAX_TOKENS,
  temperature,
  redact = String,
  signal,
  sleep = pause,
}) {
  const send = fetcher === nativeFetch ? fetchReasonx : fetcher;
  const resolvedMode = normalizeReasonxMode(mode);
  const body = chatBody({ model, messages, maxTokens, temperature, mode: resolvedMode });
  const headers = { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };

  for (let attempt = 0; ; attempt += 1) {
    checkpoint(signal);

    const deadline = AbortSignal.timeout(reasonxTimeout(resolvedMode, model));
    let response;
    try {
      response = await send(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        headers,
        body,
      });
    } catch (error) {
      checkpoint(signal);
      throw new ReasonxError(isTimeout(error) ? 'timeout' : 'unreachable', redact(error.message));
    }

    let data;
    try {
      data = await response.json();
      checkpoint(signal);
    } catch {
      checkpoint(signal);
      throw new ReasonxError('non-json', 'ReasonX returned a non-JSON API response. Check its API base URL.');
    }

    if (!response.ok) {
      const kind = classify(response.status, data?.error?.code);
      // Another client holds ReasonX's single inference slot. Wait briefly and try again.
      if (kind === 'busy' && attempt < BUSY_RETRIES) {
        await waitForRetry(BUSY_DELAY_MS * (attempt + 1), sleep, signal);
        checkpoint(signal);
        continue;
      }
      const detail = data?.error?.message || data?.message || `HTTP ${response.status}`;
      throw new ReasonxError(kind, redact(String(detail)), { status: response.status, code: data?.error?.code });
    }

    const choice = data.choices?.[0];
    return {
      text: choice?.message?.content,
      finish: choice?.finish_reason,
      refused: Boolean(choice?.message?.refusal || choice?.message?.tool_calls?.length),
      reasoning: data.reasoning,
      usage: data.usage,
    };
  }
}

// Plain-English guidance for the errors ReasonX added with automatic routing.
export function reasonxAdvice(error) {
  switch (error.kind) {
    case 'timeout':
      return 'ReasonX timed out. Shorten the task or choose Fast mode, then retry.';
    case 'busy':
      return 'ReasonX is busy with another request. Wait for it to finish and try again.';
    case 'budget':
      return 'ReasonX used its whole token budget before answering. Shorten the request, or set the ReasonX mode to Fast or Deep in Model settings.';
    case 'model':
      return `ReasonX does not offer that model. Use ${reasonxModels.join(', ')}.`;
    case 'too-large':
      return 'The request is larger than ReasonX accepts (6000 characters). Shorten it.';
    case 'upstream':
      return 'ReasonX could not reach Ollama or the model timed out. Check that Ollama is running and the model is installed.';
    default:
      return '';
  }
}

// A label such as "qwen3:8b (deep)" for traces and explanations.
export function describeReasoning(reasoning, fallback) {
  if (!reasoning?.backend_model) return fallback;
  const mode = reasoning.mode ? ` (${String(reasoning.mode).toLowerCase()})` : '';
  return `${reasoning.backend_model}${mode}`;
}

// Reads ReasonX's model list for the status check. Never throws, so it cannot block generation.
export async function reasonxModelList({ fetcher = fetch, baseUrl, apiKey = '' }) {
  const offline = { reachable: false, authorized: false, models: [] };
  try {
    const response = await fetcher(`${baseUrl}/models`, {
      redirect: 'error',
      signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (response.status === 401 || response.status === 403) {
      return {
        reachable: true,
        authorized: false,
        models: [],
        error: 'ReasonX rejected the API key. Save a valid key from its console.',
      };
    }
    if (!response.ok) {
      return {
        reachable: true,
        authorized: false,
        models: [],
        error: `ReasonX model check failed (HTTP ${response.status}). Check the local service.`,
      };
    }
    const data = await response.json();
    const models = (data?.data || []).map((model) => model.id).filter((id) => typeof id === 'string');
    return { reachable: true, authorized: true, models };
  } catch (error) {
    return {
      ...offline,
      error:
        error.name === 'TimeoutError'
          ? 'ReasonX connection check timed out. Retry or check the local service.'
          : 'ReasonX could not be reached or returned an invalid model list. Check its API URL and start the service.',
    };
  }
}
