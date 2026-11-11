// Served from /raw-editor/ with COOP/COEP: can it use Immich's session cookie for /api calls?
const result = { crossOriginIsolated, hasCookieAccessToken: document.cookie.includes('immich_access_token') };
try {
  const res = await fetch('/api/users/me', { credentials: 'same-origin' });
  result.usersMeStatus = res.status;
  if (res.ok) result.email = (await res.json()).email;
} catch (e) {
  result.error = String(e);
}
document.getElementById('out').textContent = JSON.stringify(result, null, 2);
window.__result = result;
window.__done = true;
