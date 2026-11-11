// The only part of Immich's DOM we rely on. Immich v3.3.6 and v3.4.0:
// web/src/lib/components/asset-viewer/AssetViewerNavBar.svelte
export const ACTIONS_SELECTOR = '[data-testid="asset-viewer-navbar-actions"]';

/** Marks our own button so it can be found and replaced. */
export const BUTTON_ATTR = 'data-raw-editor-button';
