// Starts the culler (services/culler) next to the test Immich: gives it an API key of the test
// admin, (re)builds and starts its container, and waits until it answers behind the proxy.
// Usage: node e2e/culler-up.mjs        (e2e/cull.mjs uses it too)
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const BASE = process.env.IMMICH_URL ?? 'http://127.0.0.1:8088';
export const ADMIN = { email: 'admin@example.com', password: 'raw-editor-e2e' };
export const COMPOSE = ['compose', '-f', 'e2e/docker-compose.immich.yml', '--profile', 'culler'];
const KEY_NAME = 'culler-e2e';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(method, path, body, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  try {
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } catch {
    return { status: res.status, body: text };
  }
}

/** Returns the culler's health once it answers at /immich-raw/culler/. */
export async function cullerUp({ quiet = false } = {}) {
  const log = quiet ? () => {} : (m) => console.log(m);
  const login = await json('POST', '/api/auth/login', ADMIN);
  const token = login.body?.accessToken;
  if (!token) throw new Error(`cannot log in to the test Immich at ${BASE}: is it running? (docker ${COMPOSE.slice(0, 3).join(' ')} up -d)`);

  // Immich shows a key's secret only once: make a new key, start the container with it, then
  // delete the old keys (deleting first would leave a running container with a dead key).
  const oldKeys = ((await json('GET', '/api/api-keys', undefined, token)).body ?? []).filter((k) => k.name === KEY_NAME);
  const key = await json('POST', '/api/api-keys', { name: KEY_NAME, permissions: ['all'] }, token);
  if (!key.body?.secret) throw new Error(`could not create an API key: ${key.status} ${JSON.stringify(key.body)}`);

  log('starting the culler container (the first build downloads ~1 GB)…');
  const stdio = ['ignore', quiet ? 'ignore' : 'inherit', 'inherit'];
  execFileSync('docker', [...COMPOSE, 'rm', '--stop', '--force', 'culler'], { stdio: ['ignore', 'ignore', 'ignore'] });
  execFileSync('docker', [...COMPOSE, 'up', '-d', '--build', 'culler', 'proxy'], { env: { ...process.env, CULLER_API_KEY: key.body.secret }, stdio });
  // nginx reads its config at start: make sure the /immich-raw/culler/ route is loaded.
  execFileSync('docker', [...COMPOSE, 'exec', 'proxy', 'nginx', '-s', 'reload'], { stdio: ['ignore', 'ignore', 'ignore'] });

  for (let i = 0; i < 180; i++) {
    const health = await json('GET', '/immich-raw/culler/api/v1/health').catch(() => null); // nginx may be (re)starting
    if (health?.body?.ok) {
      // Only now: a recreated proxy doesn't take requests right away.
      for (const k of oldKeys) await json('DELETE', `/api/api-keys/${k.id}`, undefined, token);
      log(`culler is up: ${BASE}/immich-raw/culler/ (library of ${ADMIN.email})`);
      return health.body;
    }
    await sleep(1000);
  }
  throw new Error(`the culler did not answer: docker ${COMPOSE.join(' ')} logs culler`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await cullerUp();
  console.log(`\nOpen ${BASE}, log in as ${ADMIN.email} / ${ADMIN.password}, open a RAW and click "Edit RAW".`);
  console.log('In the filmstrip: Auto-stack… → Preview → Apply.');
}
