import pg from 'pg';
import { assert, normalizeProfile } from './model.mjs';

const CONNECT_TIMEOUT_MS = 10000;
const QUERY_TIMEOUT_MS = 12000;
const STATEMENT_TIMEOUT_MS = 10000;
const MAX_ROWS = 25;
const FETCH_LIMIT = MAX_ROWS + 1;
const MAX_COLUMNS = 40;
const MAX_CELL_LENGTH = 128;
const READ_ONLY_SELECT = /^\s*SELECT\b/i;
const TLS_UNSUPPORTED_ERROR = /does not support SSL/i;

function tlsOption(sslmode) {
  if (sslmode === 'require') {
    return { rejectUnauthorized: true };
  }
  // Like libpq's prefer: encrypt when possible, without certificate verification,
  // because this mode also accepts a server that has no TLS at all.
  if (sslmode === 'prefer') {
    return { rejectUnauthorized: false };
  }
  return false;
}

function createClient(profile, ssl) {
  const client = new pg.Client({
    host: profile.host,
    port: profile.port,
    database: profile.database,
    user: profile.username,
    password: profile.password,
    ssl,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  });
  // An idle connection dropping would otherwise raise an uncaught 'error' event and end the process.
  client.on('error', () => {});
  return client;
}

async function closeClient(client) {
  await client.end().catch(() => {});
}

async function connectClient(profile, ssl) {
  const client = createClient(profile, ssl);
  try {
    await client.connect();
    return client;
  } catch (error) {
    await closeClient(client);
    throw error;
  }
}

async function openConnection(profile) {
  try {
    return await connectClient(profile, tlsOption(profile.sslmode));
  } catch (error) {
    if (profile.sslmode !== 'prefer' || !TLS_UNSUPPORTED_ERROR.test(error.message)) {
      throw error;
    }
  }
  return connectClient(profile, false);
}

export async function queryDatabase(rawProfile, sql) {
  const profile = normalizeProfile(rawProfile);
  assert(
    typeof sql === 'string' && READ_ONLY_SELECT.test(sql) && !sql.includes(';'),
    'Use one SELECT statement without a semicolon',
  );

  const client = await openConnection(profile);
  try {
    await client.query('BEGIN READ ONLY');
    const result = await client.query({
      text: `SELECT * FROM (${sql}) AS studio_query LIMIT ${FETCH_LIMIT}`,
      rowMode: 'array',
    });

    let valueTruncated = false;
    const previewCell = (cell) => {
      if (cell === null) {
        return null;
      }
      const text = typeof cell === 'object' ? JSON.stringify(cell) : String(cell);
      if (text.length > MAX_CELL_LENGTH) {
        valueTruncated = true;
      }
      return text.slice(0, MAX_CELL_LENGTH);
    };

    const columns = result.fields.slice(0, MAX_COLUMNS).map((field) => field.name);
    const rows = result.rows.slice(0, MAX_ROWS).map((row) => row.slice(0, MAX_COLUMNS).map(previewCell));
    return {
      ok: true,
      columns,
      rows,
      rowCount: rows.length,
      columnCount: columns.length,
      truncated: result.rows.length > MAX_ROWS || result.fields.length > MAX_COLUMNS,
      valueTruncated,
    };
  } finally {
    await closeClient(client);
  }
}
