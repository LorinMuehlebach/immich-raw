// Adds an "Edit RAW" icon button to Immich's asset viewer toolbar.
// Loaded into Immich's page by the reverse proxy (/immich-raw/inject.js) or as a userscript.
import { createEditTargetResolver } from './raw.ts';
import { editorUrl, parseViewerRoute, type ViewerRoute } from './routes.ts';
import { ACTIONS_SELECTOR, BUTTON_ATTR } from './selectors.ts';

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

function createButton(bar: Element, rawId: string, route: ViewerRoute): HTMLButtonElement {
  const url = editorUrl(EDITOR_BASE, rawId, route.context, location.pathname + location.search);
  const ref = bar.querySelector('button');
  const refSvg = ref?.querySelector('svg');

  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute(BUTTON_ATTR, '');
  button.dataset.sourceAsset = route.assetId;
  button.dataset.rawAsset = rawId;
  button.dataset.href = url;
  button.setAttribute('aria-label', 'Edit RAW');
  button.title = 'Edit RAW';
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
  path.setAttribute('d', ICON_PATH);
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  button.append(svg);

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

  const resolve = createEditTargetResolver();
  let generation = 0;

  const removeButtons = (keep?: (b: HTMLElement) => boolean) => {
    for (const b of document.querySelectorAll<HTMLElement>(`[${BUTTON_ATTR}]`)) {
      if (!keep?.(b)) b.remove();
    }
  };

  async function update() {
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
