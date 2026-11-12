// INSECURE=1: the browser reaches the test Immich over plain HTTP from an origin that is not a
// secure context, like Immich on http://192.168.x.x:2283 at home. 127.0.0.1 and localhost always
// count as secure, so the browser maps the made-up host immich.test to 127.0.0.1 and pages use
// http://immich.test:<port>. API calls from Node (Playwright's context.request) can't use that
// mapping and keep going to 127.0.0.1.

export const INSECURE = process.env.INSECURE === '1';
/** Where Node's API calls go. */
export const API_BASE = process.env.IMMICH_URL ?? 'http://127.0.0.1:8088';
/** Where the browser's pages go. */
export const PAGE_BASE = INSECURE ? API_BASE.replace(/\/\/(?:127\.0\.0\.1|localhost)(?=[:/]|$)/, '//immich.test') : API_BASE;
/** Extra browser arguments. */
export const browserArgs = INSECURE ? ['--host-resolver-rules=MAP immich.test 127.0.0.1'] : [];

/**
 * Console errors that are expected on an insecure origin: the browser ignores the
 * Cross-Origin-Opener-Policy header the editor sends, and says so on every page load.
 */
export const expectedConsoleError = (text) => INSECURE && /Cross-Origin-Opener-Policy header has been ignored/.test(text);

/**
 * In insecure mode, logs the browser in on PAGE_BASE too: the session cookie from the API login
 * belongs to 127.0.0.1. Returns whether the page there is a secure context (null when not in
 * insecure mode).
 */
export async function loginOnPageOrigin(context, login) {
  if (!INSECURE) return null;
  const page = await context.newPage();
  try {
    await page.goto(`${PAGE_BASE}/api/server/ping`);
    const status = await page.evaluate(
      async (body) => (await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status,
      login,
    );
    if (status !== 201 && status !== 200) throw new Error(`login on ${PAGE_BASE} failed: HTTP ${status}`);
    return await page.evaluate(() => isSecureContext);
  } finally {
    await page.close();
  }
}
