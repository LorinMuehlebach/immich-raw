// Adds an "Edit RAW" icon button to Immich's asset viewer toolbar, a "Compare stack" button there
// for photos in a culler stack (opens the editor's stack window), and to the toolbar shown while
// photos are selected an "Export" button (the editor's export page) and, with two or more photos
// and the culler installed, an "Auto-stack" button (the editor's auto-stack page).
// Loaded into Immich's page by the reverse proxy (/immich-raw/inject.js) or as a userscript.
import { createCullerCheck } from './culler.ts';
import { HANDOFF_PREFIX, cullPageUrl, exportPageUrl, newHandoffKey, staleHandoffKeys, type SelectionHandoff } from './handoff.ts';
import { createEditTargetResolver, type EditTarget } from './raw.ts';
import { editorUrl, isExcludedPath, pageContext, parseViewerRoute, stackPageUrl, type ViewerRoute } from './routes.ts';
import { captureSelectedIds, installDownloadCatcher, selectedCount, selectionBar, visibleSelectedIds } from './selection.ts';
import { ACTIONS_SELECTOR, BUTTON_ATTR, CULL_BUTTON_ATTR, EXPORT_BUTTON_ATTR, STACK_BUTTON_ATTR } from './selectors.ts';
import { createCullerStackResolver } from './stack.ts';

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

// Material Design Icons "camera-burst" (Apache-2.0), Immich's own icon for stacks.
const STACK_ICON_PATH =
  'M1,5H3V19H1V5M5,5H7V19H5V5M22,5H10A1,1 0 0,0 9,6V18A1,1 0 0,0 10,19H22A1,1 0 0,0 23,18V6A1,1 0 0,0 22,5M11,17L13.5,13.85L15.29,16L17.79,12.78L21,17H11Z';

// Material Design Icons "export-variant" (Apache-2.0).
const EXPORT_ICON_PATH =
  'M12,1L8,5H11V14H13V5H16M18,23H6C4.89,23 4,22.1 4,21V9A2,2 0 0,1 6,7H9V9H6V21H18V9H15V7H18A2,2 0 0,1 20,9V21A2,2 0 0,1 18,23Z';

// Material Design Icons "star-box-multiple-outline" (Apache-2.0): a stack of photos, the best starred.
const CULL_ICON_PATH =
  'M4 6V20H18V22H3C2.4 22 2 21.6 2 21V6H4M12.1 10.6L10.2 8.8L12.8 8.4L14 6L15.2 8.4L17.8 8.8L15.9 10.7L16.3 13.3L14 12L11.6 13.2L12.1 10.6M8 2H20C21.11 2 22 2.9 22 4V16C22 17.11 21.11 18 20 18H8C6.9 18 6 17.11 6 16V4C6 2.9 6.9 2 8 2M8 4V16H20V4H8Z';

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

type PageUrl = (base: string, key: string) => string;

/** Hands the selected photos to an editor page (`pageUrl` of the handoff key), in a new tab. */
async function handOffSelection(bar: Element, sameTab: boolean, pageUrl: PageUrl): Promise<void> {
  const expected = selectedCount(bar) ?? 0;
  let ids = visibleSelectedIds();
  if (ids.length < expected) ids = (await captureSelectedIds()) ?? ids;
  if (!ids.length) return;
  const key = newHandoffKey();
  const handoff: SelectionHandoff = {
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
    console.warn('immich-raw: could not hand the selection to the editor', e);
    return;
  }
  const url = pageUrl(EDITOR_BASE, key);
  if (sameTab) location.assign(url);
  else window.open(url, '_blank');
}

/** A selection toolbar button that opens an editor page for the selected photos (Shift: this tab). */
function selectionButton(group: Element, attr: string, label: string, title: string, iconPath: string, pageUrl: PageUrl): HTMLButtonElement {
  const button = iconButton(group.querySelector('button'), label, iconPath);
  button.setAttribute(attr, '');
  button.title = title;
  let busy = false;
  const run = (sameTab: boolean) => {
    if (busy) return;
    busy = true;
    const bar = button.closest('nav') ?? group;
    void handOffSelection(bar, sameTab, pageUrl).finally(() => (busy = false));
  };
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    run(e.shiftKey);
  });
  return button;
}

const createExportButton = (group: Element) =>
  selectionButton(
    group,
    EXPORT_BUTTON_ATTR,
    'Export with immich-raw',
    'Export with immich-raw: renders the selected photos (RAWs with their edit) in the browser',
    EXPORT_ICON_PATH,
    exportPageUrl,
  );

const createCullButton = (group: Element) =>
  selectionButton(
    group,
    CULL_BUTTON_ATTR,
    'Auto-stack and pick the best',
    'Auto-stack with immich-raw: stacks similar photos of the selection and picks the best of each (you choose what counts first)',
    CULL_ICON_PATH,
    cullPageUrl,
  );

/** Opens `url` on click; Ctrl/Shift/middle click opens it in a new tab. */
function linkTo(button: HTMLButtonElement, url: string): void {
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
}

function createButton(bar: Element, target: EditTarget, route: ViewerRoute): HTMLButtonElement {
  const button = iconButton(bar.querySelector('button'), 'Edit RAW', ICON_PATH);
  button.setAttribute(BUTTON_ATTR, '');
  button.dataset.sourceAsset = route.assetId;
  button.dataset.rawAsset = target.rawId;
  linkTo(button, editorUrl(EDITOR_BASE, target.rawId, route.context, location.pathname + location.search, target.copyId));
  return button;
}

function createStackButton(bar: Element, route: ViewerRoute): HTMLButtonElement {
  const button = iconButton(bar.querySelector('button'), 'Compare stack', STACK_ICON_PATH);
  button.setAttribute(STACK_BUTTON_ATTR, '');
  button.title = 'Compare stack with immich-raw: look through the shots of this stack, pick the best, delete the others';
  button.dataset.sourceAsset = route.assetId;
  linkTo(button, stackPageUrl(EDITOR_BASE, route.assetId, route.context, location.pathname + location.search));
  return button;
}

function install() {
  if (window.__rawEditorButton) return;
  window.__rawEditorButton = true;

  installDownloadCatcher();
  const resolve = createEditTargetResolver();
  const resolveStack = createCullerStackResolver(`${EDITOR_BASE}culler/api/v1`);
  const cullerCheck = createCullerCheck(`${EDITOR_BASE}culler/api/v1`);
  let cullerOk = false;
  let generation = 0;

  const removeButtons = (attr: string, keep?: (b: HTMLElement) => boolean) => {
    for (const b of document.querySelectorAll<HTMLElement>(`[${attr}]`)) {
      if (!keep?.(b)) b.remove();
    }
  };

  /** The export and auto-stack buttons in the selection toolbar, while photos are selected. */
  function updateSelection() {
    const bar = isExcludedPath(location.pathname) ? null : selectionBar();
    // Immich's actions on the right (share, add to album, ...); else the toolbar itself.
    const group = bar ? (bar.querySelector('.ms-auto') ?? bar) : null;
    const inGroup = (b: HTMLElement) => !!group && b.parentElement === group;
    removeButtons(EXPORT_BUTTON_ATTR, inGroup);
    if (group && !group.querySelector(`[${EXPORT_BUTTON_ATTR}]`)) group.prepend(createExportButton(group));

    // Auto-stack: two photos or more, and only where the culler works for this user (asked in
    // the background; a changed answer updates the toolbar).
    const several = !!bar && (selectedCount(bar) ?? 0) >= 2;
    if (several) {
      void cullerCheck().then((ok) => {
        if (ok === cullerOk) return;
        cullerOk = ok;
        schedule();
      });
    }
    const showCull = several && cullerOk;
    removeButtons(CULL_BUTTON_ATTR, (b) => showCull && inGroup(b));
    if (showCull && group && !group.querySelector(`[${CULL_BUTTON_ATTR}]`)) {
      const exportButton = group.querySelector(`[${EXPORT_BUTTON_ATTR}]`);
      if (exportButton) exportButton.after(createCullButton(group));
      else group.prepend(createCullButton(group));
    }
  }

  async function update() {
    updateSelection();
    const gen = ++generation;
    const route = parseViewerRoute(location.pathname);
    if (!route || !document.querySelector(ACTIONS_SELECTOR)) {
      removeButtons(BUTTON_ATTR);
      removeButtons(STACK_BUTTON_ATTR);
      return;
    }
    const [target, inStack] = await Promise.all([resolve(route.assetId), resolveStack(route.assetId)]);
    // A newer update (navigation, re-render) superseded this one.
    if (gen !== generation) return;
    const bar = document.querySelector(ACTIONS_SELECTOR);
    const current = (b: HTMLElement) => b.parentElement === bar && b.dataset.sourceAsset === route.assetId;
    removeButtons(BUTTON_ATTR, (b) => !!target && current(b));
    removeButtons(STACK_BUTTON_ATTR, (b) => inStack && current(b));
    if (!bar) return;
    // Prepended: the stack button ends up right of Edit RAW.
    if (inStack && !bar.querySelector(`[${STACK_BUTTON_ATTR}]`)) bar.prepend(createStackButton(bar, route));
    if (target && !bar.querySelector(`[${BUTTON_ATTR}]`)) {
      const stackButton = bar.querySelector(`[${STACK_BUTTON_ATTR}]`);
      if (stackButton) stackButton.before(createButton(bar, target, route));
      else bar.prepend(createButton(bar, target, route));
    }
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
