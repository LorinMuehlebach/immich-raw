// M0 prototype of the inject script: adds an "Edit RAW" button to Immich's asset viewer.
// The real version (packages/inject) comes in M1; this one only proves the mechanism.
(() => {
  if (window.__rawEditorInjected) return;
  window.__rawEditorInjected = true;

  const RAW_EXT = /\.(3fr|arw|cr2|cr3|crw|dcr|dng|erf|fff|iiq|k25|kdc|mef|mos|mrw|nef|nrw|orf|ori|pef|raf|raw|rw2|rwl|sr2|srf|srw|x3f)$/i;
  const VIEWER_ROUTE = /\/photos\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:$|[/?#])/i;
  const EXCLUDED = /^\/(share|s|trash|locked)(\/|$)/;
  const ACTIONS = '[data-testid="asset-viewer-navbar-actions"]';
  const BUTTON = 'raw-editor-button';
  const rawCache = new Map();

  const currentAssetId = () => {
    if (EXCLUDED.test(location.pathname)) return null;
    return location.pathname.match(VIEWER_ROUTE)?.[1] ?? null;
  };

  const isRaw = (id) => {
    if (!rawCache.has(id)) {
      rawCache.set(
        id,
        fetch(`/api/assets/${id}`, { credentials: 'same-origin' })
          .then((r) => (r.ok ? r.json() : null))
          .then((a) => !!a && RAW_EXT.test(a.originalFileName ?? ''))
          .catch(() => false),
      );
    }
    return rawCache.get(id);
  };

  async function update() {
    const id = currentAssetId();
    for (const b of document.querySelectorAll(`[data-testid="${BUTTON}"]`)) {
      if (b.dataset.assetId !== id) b.remove();
    }
    if (!id || !(await isRaw(id)) || currentAssetId() !== id) return;
    const bar = document.querySelector(ACTIONS);
    if (!bar || bar.querySelector(`[data-testid="${BUTTON}"]`)) return;

    const link = document.createElement('a');
    link.dataset.testid = BUTTON;
    link.dataset.assetId = id;
    link.href = `/raw-editor/?asset=${id}&return=${encodeURIComponent(location.pathname + location.search)}`;
    link.textContent = 'Edit RAW';
    link.title = 'Edit RAW';
    link.className = bar.querySelector('button')?.className ?? '';
    link.style.cssText = 'display:inline-flex;align-items:center;padding:0 12px;font-weight:600;color:inherit;text-decoration:none;';
    bar.prepend(link);
  }

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      update();
    });
  };
  for (const fn of ['pushState', 'replaceState']) {
    const original = history[fn];
    history[fn] = function (...args) {
      const result = original.apply(this, args);
      schedule();
      return result;
    };
  }
  addEventListener('popstate', schedule);
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  schedule();
})();
