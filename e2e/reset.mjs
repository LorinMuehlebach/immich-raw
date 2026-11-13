// Puts seeded RAWs back to their unedited state on the test Immich: deletes the editor's
// renders (permanently), the stack, the stored recipe and the virtual copies.
// Usage: node e2e/reset.mjs <filename-part>
const BASE = process.env.IMMICH_URL ?? 'http://127.0.0.1:8088';
const [namePart] = process.argv.slice(2);
if (!namePart) {
  console.error('Usage: node e2e/reset.mjs <filename-part>');
  process.exit(1);
}

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@example.com', password: 'raw-editor-e2e' }),
});
const { accessToken } = await login.json();
const api = async (method, path, data) => {
  const r = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, ...(data ? { 'Content-Type': 'application/json' } : {}) },
    body: data ? JSON.stringify(data) : undefined,
  });
  return r.status === 204 ? null : r.json().catch(() => null);
};

const found = await api('POST', '/search/metadata', { originalFileName: namePart, size: 20 });
const raws = (found?.assets?.items ?? []).filter((a) => /\.(arw|nef|cr3|cr2|raf|dng|orf|rw2)$/i.test(a.originalFileName));
for (const raw of raws) {
  const info = await api('GET', `/assets/${raw.id}`);
  let removed = 0;
  if (info?.stack?.id) {
    const stack = await api('GET', `/stacks/${info.stack.id}`);
    // Only the editor's renders: never delete a camera JPEG that shares the stack.
    const renders = (stack?.assets ?? []).filter((a) => a.id !== raw.id && /\.edit\.jpg$/i.test(a.originalFileName)).map((a) => a.id);
    await api('DELETE', `/stacks/${info.stack.id}`);
    if (renders.length) await api('DELETE', '/assets', { ids: renders, force: true });
    removed = renders.length;
  }
  await api('DELETE', `/assets/${raw.id}/metadata/raw-editor.recipe`);
  // Virtual copies, and their snapshots.
  const keys = ((await api('GET', `/assets/${raw.id}/metadata`)) ?? []).map((i) => i.key).filter((k) => /^raw-editor\.(copy|history)\./.test(k));
  for (const k of keys) await api('DELETE', `/assets/${raw.id}/metadata/${encodeURIComponent(k)}`);
  console.log(`reset ${raw.originalFileName}: ${removed} render(s) deleted, recipe${keys.length ? ` and ${keys.length} virtual copy key(s)` : ''} cleared`);
}
if (!raws.length) console.log('no matching RAW found');
