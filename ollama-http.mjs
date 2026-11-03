import http from 'node:http';
import https from 'node:https';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

export const ollamaGenerationTimeoutMs = 45 * 60000;

const coded = (message, code) => Object.assign(new Error(message), { code });

export function isLocalUrl(target, protocols = ['http:']) {
  return (
    protocols.includes(target.protocol) &&
    LOCAL_HOSTS.includes(target.hostname) &&
    !target.username &&
    !target.password
  );
}

// Non-streaming local inference may send no response headers for many minutes, longer than
// fetch's 300 s headers timeout. Native HTTP is limited only by the caller's overall deadline.
export function localHttpRequest(target, { method = 'POST', headers, body, signal, service }) {
  const transport = target.protocol === 'https:' ? https : http;
  const errorCode = service.toUpperCase();

  return new Promise((resolve, reject) => {
    const req = transport.request(target, { method, headers, signal, agent: false }, (res) => {
      res.on('error', reject);

      if (res.statusCode >= 300 && res.statusCode < 400) {
        req.destroy(coded(`${service} redirects are not allowed.`, `${errorCode}_REDIRECT`));
        return;
      }

      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(coded(`${service} response exceeded the size limit.`, `${errorCode}_RESPONSE_TOO_LARGE`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: async () => JSON.parse(text),
        });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

export async function fetchOllama(url, options = {}) {
  const { signal = AbortSignal.timeout(ollamaGenerationTimeoutMs) } = options;
  const target = new URL(url);
  if (!isLocalUrl(target)) {
    throw new TypeError('Ollama requests require a local HTTP URL without credentials.');
  }
  return localHttpRequest(target, { ...options, signal, service: 'Ollama' });
}
