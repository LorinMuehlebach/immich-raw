// The only parts of Immich's DOM we rely on. Immich v3.3.6 and v3.4.0:
// web/src/lib/components/asset-viewer/AssetViewerNavBar.svelte
export const ACTIONS_SELECTOR = '[data-testid="asset-viewer-navbar-actions"]';
// The toolbar shown while photos are selected (ControlAppBar), and a selected thumbnail.
export const SELECTION_BAR_SELECTOR = '[data-testid="control-bar"] nav';
export const SELECTED_THUMB_SELECTOR = '[data-thumbnail-focus-container][data-selected="true"][data-asset]';

/** Marks our own button so it can be found and replaced. */
export const BUTTON_ATTR = 'data-raw-editor-button';
/** Marks our export button in the selection toolbar. */
export const EXPORT_BUTTON_ATTR = 'data-raw-editor-export';
/** Marks our auto-stack button in the selection toolbar. */
export const CULL_BUTTON_ATTR = 'data-raw-editor-cull';
/** Marks our "Compare stack" button in the asset viewer. */
export const STACK_BUTTON_ATTR = 'data-raw-editor-stack';
