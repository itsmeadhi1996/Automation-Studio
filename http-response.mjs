import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

const compress = promisify(gzip);
const GZIP_MIN_BYTES = 1024;
const GZIP_LEVEL = 1;

export const contentTag = (content) =>
  `W/"${createHash('sha256').update(content).digest('base64url')}"`;

function matchesTag(header, tag) {
  const bare = tag.replace(/^W\//, '');
  return String(header || '')
    .split(',')
    .map((value) => value.trim())
    .some((value) => value === '*' || value.replace(/^W\//, '') === bare);
}

export function acceptsGzip(header = '') {
  const encodings = new Map(
    String(header)
      .toLowerCase()
      .split(',')
      .map((part) => {
        const [name, ...parameters] = part.trim().split(';');
        const quality = parameters.find((parameter) => parameter.trim().startsWith('q='));
        return [name.trim(), quality === undefined ? 1 : Number(quality.trim().slice(2))];
      }),
  );
  const quality = encodings.get('gzip') ?? encodings.get('*') ?? 0;
  return Number.isFinite(quality) && quality > 0 && quality <= 1;
}

export async function sendText(
  req,
  res,
  content,
  { type = 'application/json; charset=utf-8', status = 200, tag, compressed } = {},
) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  res.setHeader('Content-Type', type);
  res.setHeader('Vary', 'Accept-Encoding');
  if (tag) {
    res.setHeader('ETag', tag);
    if (status === 200 && req.method === 'GET' && matchesTag(req.headers['if-none-match'], tag)) {
      res.writeHead(304);
      res.end();
      return;
    }
  }
  let payload = bytes;
  if (bytes.length >= GZIP_MIN_BYTES && acceptsGzip(req.headers['accept-encoding'])) {
    const zipped = await (compressed ? compressed() : compress(bytes, { level: GZIP_LEVEL }));
    if (zipped.length < bytes.length) {
      payload = zipped;
      res.setHeader('Content-Encoding', 'gzip');
    }
  }
  res.setHeader('Content-Length', payload.length);
  res.writeHead(status);
  res.end(payload);
}

// Call only after route authorization. Revalidate files so development edits
// appear immediately; retain at most one representation per allowlisted file.
export function createStaticResponder(directory) {
  const cache = new Map();

  return async (req, res, name, type) => {
    const file = path.join(directory, name);
    const info = await stat(file);
    const stamp = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
    let entry = cache.get(name);
    if (!entry || entry.stamp !== stamp) {
      entry = {
        stamp,
        ready: readFile(file).then((bytes) => ({ bytes, tag: contentTag(bytes) })),
      };
      cache.set(name, entry);
    }
    let asset;
    try {
      asset = await entry.ready;
    } catch (error) {
      if (cache.get(name) === entry) cache.delete(name);
      throw error;
    }
    res.setHeader('Cache-Control', 'private, no-cache');
    await sendText(req, res, asset.bytes, {
      type: `${type}; charset=utf-8`,
      tag: asset.tag,
      compressed: () => (entry.compressed ||= compress(asset.bytes, { level: GZIP_LEVEL })),
    });
  };
}
