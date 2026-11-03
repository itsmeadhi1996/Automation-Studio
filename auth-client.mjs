const LOGIN_TIMEOUT_MS = 30000;

// Credentials are read from the process environment, never command-line arguments.
export async function studioHeaders(base) {
  const { STUDIO_SESSION_TOKEN, STUDIO_USERNAME, STUDIO_PASSWORD } = process.env;
  if (STUDIO_SESSION_TOKEN) return { Authorization: `Bearer ${STUDIO_SESSION_TOKEN}` };
  if (!STUDIO_USERNAME || !STUDIO_PASSWORD) return {};
  const response = await fetch(new URL('/api/auth/login', base), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: STUDIO_USERNAME, password: STUDIO_PASSWORD }),
    signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error((await response.json()).error);
  return { Cookie: response.headers.get('set-cookie').split(';')[0] };
}
