// Adds an "Edit RAW" icon button to Immich's asset viewer toolbar, and an "Export" button to
// the toolbar shown while photos are selected (opens the editor's export page for them).
// Loaded into Immich's page by the reverse proxy (/immich-raw/inject.js) or as a userscript.
import { HANDOFF_PREFIX, exportPageUrl, newHandoffKey, staleHandoffKeys, type ExportHandoff } from './handoff.ts';
import { createEditTargetResolver } from './raw.ts';
import { editorUrl, isExcludedPath, pageContext, parseViewerRoute, type ViewerRoute } from './routes.ts';
import { captureSelectedIds, installDownloadCatcher, selectedCount, selectionBar, visibleSelectedIds } from './selection.ts';
import { ACTIONS_SELECTOR, BUTTON_ATTR, EXPORT_BUTTON_ATTR } from './selectors.ts';

// The userscript build declares this at the top of the file so users can change it.
declare const RAW_EDITOR_BASE: string | undefined;
declare global {
  interface Window {
    __rawEditorButton?: boolean;
  }
}

const EDITOR_BASE = typeof RAW_EDITOR_BASE === 'string' && RAW_EDITOR_BASE ? RAW_EDITOR_BASE : '/immich-raw/';
const SVG_NS = 'http://www.w3.org/2000/svg';
// Material Design Icons "camera-iris" (Apache-2.0), the icon set Immich uses.
const ICON_PATH =
  'M13.73,15L9.83,21.76C10.53,21.91 11.25,22 12,22C14.4,22 16.6,21.15 18.32,19.75L14.66,13.4M2.46,15C3.38,17.92 5.61,20.26 8.45,21.34L12.12,15M8.54,12L4.64,5.25C3,7 2,9.39 2,12C2,12.68 2.07,13.35 2.2,14H9.69M21.8,10H14.31L14.6,10.5L19.36,18.75C21,16.97 22,14.6 22,12C22,11.31 21.93,10.64 21.8,10M21.54,9C20.62,6.07 18.39,3.74 15.55,2.66L11.88,9M9.4,10.5L14.17,2.24C13.47,2.09 12.75,2 12,2C9.6,2 7.4,2.84 5.68,4.25L9.34,10.6L9.4,10.5Z';

// Material Design Icons "export-variant" (Apache-2.0).
const EXPORT_ICON_PATH =
  'M12,1L8,5H11V14H13V5H16M18,23H6C4.89,23 4,22.1 4,21V9A2,2 0 0,1 6,7H9V9H6V21H18V9H15V7H18A2,2 0 0,1 20,9V21A2,2 0 0,1 18,23Z';

/** A round icon button styled like `ref` (one of Immich's own). */
function iconButton(ref: Element | null | undefined, label: string, iconPath: string): HTMLButtonElement {
  const refSvg = ref?.querySelector('svg');
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  if (ref) {
    button.className = ref.className;
  } else {
    // Immich changed its markup; still show a usable round button.
    button.style.cssText =
      'display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:9999px;' +
      'border:0;background:transparent;color:inherit;cursor:pointer;';
  }

  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [name, fallback] of [
    ['width', '60%'],
    ['height', '60%'],
    ['viewBox', '0 0 24 24'],
    ['class', ''],
    ['stroke', 'transparent'],
    ['stroke-width', '2'],
  ] as const) {
    const value = refSvg?.getAttribute(name) ?? fallback;
    if (value) svg.setAttribute(name, value);
  }
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', iconPath);
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  button.append(svg);
  return button;
}

/** Hands the selected photos to the editor's export page, in a new tab. */
async function exportSelection(bar: Element, sameTab: boolean): Promise<void> {
  const expected = selectedCount(bar) ?? 0;
  let ids = visibleSelectedIds();
  if (ids.length < expected) ids = (await captureSelectedIds()) ?? ids;
  if (!ids.length) return;
  const key = newHandoffKey();
  const handoff: ExportHandoff = {
    ids,
    context: pageContext(location.pathname),
    expected,
    returnPath: location.pathname + location.search,
    createdAt: Date.now(),
  };
  try {
    const entries: [string, string | null][] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) entries.push([k, localStorage.getItem(k)]);
    }
    for (const k of staleHandoffKeys(entries, Date.now())) localStorage.removeItem(k);
    localStorage.setItem(HANDOFF_PREFIX + key, JSON.stringify(handoff));
  } catch (e) {
    console.warn('immich-raw: could not hand the selection to the export page', e);
    return;
  }
  const url = exportPageUrl(EDITOR_BASE, key);
  if (sameTab) location.assign(url);
  else window.open(url, '_blank');
}

function createExportButton(group: Element): HTMLButtonElement {
  const button = iconButton(group.querySelector('button'), 'Export with immich-raw', EXPORT_ICON_PATH);
  button.setAttribute(EXPORT_BUTTON_ATTR, '');
  button.title = 'Export with immich-raw: renders the selected photos (RAWs with their edit) in the browser';
  let busy = false;
  const run = (sameTab: boolean) => {
    if (busy) return;
    busy = true;
    const bar = button.closest('nav') ?? group;
    void exportSelection(bar, sameTab).finally(() => (busy = false));
  };
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    run(e.shiftKey);
  });
  return button;
}

function createButton(bar: Element, rawId: string, route: ViewerRoute): HTMLButtonElement {
  const url = editorUrl(EDITOR_BASE, rawId, route.context, location.pathname + location.search);
  const button = iconButton(bar.querySelector('button'), 'Edit RAW', ICON_PATH);
  button.setAttribute(BUTTON_ATTR, '');
  button.dataset.sourceAsset = route.assetId;
  button.dataset.rawAsset = rawId;
  button.dataset.href = url;

  const open = (newTab: boolean) => (newTab ? window.open(url, '_blank', 'noopener') : location.assign(url));
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    open(e.ctrlKey || e.metaKey || e.shiftKey);
  });
  button.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    open(true);
  });
  return button;
}

function install() {
  if (window.__rawEditorButton) return;
  window.__rawEditorButton = true;

  installDownloadCatcher();
  const resolve = createEditTargetResolver();
  let generation = 0;

  const removeButtons = (keep?: (b: HTMLElement) => boolean) => {
    for (const b of document.querySelectorAll<HTMLElement>(`[${BUTTON_ATTR}]`)) {
      if (!keep?.(b)) b.remove();
    }
  };

  /** The export button in the selection toolbar, while photos are selected. */
  function updateSelection() {
    const bar = isExcludedPath(location.pathname) ? null : selectionBar();
    // Immich's actions on the right (share, add to album, ...); else the toolbar itself.
    const group = bar ? (bar.querySelector('.ms-auto') ?? bar) : null;
    for (const b of document.querySelectorAll<HTMLElement>(`[${EXPORT_BUTTON_ATTR}]`)) {
      if (b.parentElement !== group) b.remove();
    }
    if (group && !group.querySelector(`[${EXPORT_BUTTON_ATTR}]`)) group.prepend(createExportButton(group));
  }

  async function update() {
    updateSelection();
    const gen = ++generation;
    const route = parseViewerRoute(location.pathname);
    if (!route || !document.querySelector(ACTIONS_SELECTOR)) {
      removeButtons();
      return;
    }
    const rawId = await resolve(route.assetId);
    // A newer update (navigation, re-render) superseded this one.
    if (gen !== generation) return;
    const bar = document.querySelector(ACTIONS_SELECTOR);
    removeButtons((b) => !!rawId && b.parentElement === bar && b.dataset.sourceAsset === route.assetId);
    if (!rawId || !bar || bar.querySelector(`[${BUTTON_ATTR}]`)) return;
    bar.prepend(createButton(bar, rawId, route));
  }

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      void update();
    });
  };

  for (const fn of ['pushState', 'replaceState'] as const) {
    const original = history[fn];
    history[fn] = function (this: History, ...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args);
      schedule();
      return result;
    };
  }
  addEventListener('popstate', schedule);
  (window as { navigation?: EventTarget }).navigation?.addEventListener('navigatesuccess', schedule);
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  schedule();
}

install();
