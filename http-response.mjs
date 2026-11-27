import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

const compress = promisify(gzip);
const GZIP_MIN_BYTES = 1024;
const GZIP_LEVEL = 1;
// Static files are compressed once and kept, so they can use the smallest output.
const STATIC_GZIP_LEVEL = 9;
// Pages link their scripts and styles as /name.js?v=<version of that file>. A request naming the
// current version can be kept by the browser until the file changes, which saves a round trip per
// file on every page load; any other request is revalidated as before.
const ASSET_REFERENCE = /((?:src|href)=")\/([\w.-]+\.(?:js|css|svg))(")/g;
const VERSIONED_CACHE = 'private, max-age=31536000, immutable';
const assetVersion = (tag) => tag.slice(3, 15);

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

  async function load(name) {
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
    try {
      return { entry, asset: await entry.ready };
    } catch (error) {
      if (cache.get(name) === entry) cache.delete(name);
      throw error;
    }
  }

  // The page with each linked file's current version added; rebuilt when the page or a file changes.
  async function versionedPage(entry, asset) {
    const source = asset.bytes.toString('utf8');
    const names = [...new Set([...source.matchAll(ASSET_REFERENCE)].map((match) => match[2]))];
    const versions = new Map();
    await Promise.all(
      names.map(async (name) => {
        const linked = await load(name).catch(() => null);
        if (linked) versions.set(name, assetVersion(linked.asset.tag));
      }),
    );
    const key = names.map((name) => versions.get(name) || '').join(',');
    if (entry.page?.key !== key) {
      const bytes = Buffer.from(
        source.replace(ASSET_REFERENCE, (match, start, name, end) =>
          versions.has(name) ? `${start}/${name}?v=${versions.get(name)}${end}` : match,
        ),
      );
      entry.page = { key, bytes, tag: contentTag(bytes) };
    }
    return entry.page;
  }

  return async (req, res, name, type) => {
    const { entry, asset } = await load(name);
    const sent = type === 'text/html' ? await versionedPage(entry, asset) : asset;
    const requested = new URL(req.url, 'http://localhost').searchParams.get('v');
    const isCurrent = requested && requested === assetVersion(asset.tag);
    res.setHeader('Cache-Control', isCurrent ? VERSIONED_CACHE : 'private, no-cache');
    await sendText(req, res, sent.bytes, {
      type: `${type}; charset=utf-8`,
      tag: sent.tag,
      compressed: () => (sent.compressed ||= compress(sent.bytes, { level: STATIC_GZIP_LEVEL })),
    });
  };
}
