<script lang="ts">
  import type { AssetResponseDto } from '@immich/sdk';
  import { DEFAULT_GROUPS, type GroupId, type Recipe } from '@immich-raw/recipe';
  import { onMount, untrack } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { shotSettings } from './lib/immich/context.ts';
  import { badgeFor } from './lib/immich/cull-view.ts';
  import { looks } from './lib/immich/looks.ts';
  import { factsOf, flag, flagStatus } from './lib/immich/photo-facts.svelte.ts';
  import type { FlagAction } from './lib/immich/shot-flags.ts';
  import { factsText, type Neighbours } from './lib/immich/strip-view.ts';
  import { drafts } from './lib/drafts/drafts.svelte.ts';
  import type { CullInfo } from './lib/immich/culler.ts';
  import type { StackFrame } from './lib/immich/stack-view.ts';
  import { PresetStore } from './lib/state/presets.ts';
  import { editor } from './lib/state/editor.svelte.ts';
  import { VIEW_PAD, wheelFactor } from './lib/state/zoom.ts';
  import AiDownloadDialog from './lib/ui/AiDownloadDialog.svelte';
  import FujiLooksDialog from './lib/ui/FujiLooksDialog.svelte';
  import { FUJI_LOOKS_MB } from './lib/fuji-looks.svelte.ts';
  import BasicPanel from './lib/ui/BasicPanel.svelte';
  import CalibrationPanel from './lib/ui/CalibrationPanel.svelte';
  import EffectsPanel from './lib/ui/EffectsPanel.svelte';
  import BatchExportDialog from './lib/ui/BatchExportDialog.svelte';
  import ExportPanel from './lib/ui/ExportPanel.svelte';
  import ExportSettingsDialog from './lib/ui/ExportSettingsDialog.svelte';
  import ColorGradingPanel from './lib/ui/ColorGradingPanel.svelte';
  import ColorMixerPanel from './lib/ui/ColorMixerPanel.svelte';
  import ConvertDngDialog from './lib/ui/ConvertDngDialog.svelte';
  import CopySettingsDialog from './lib/ui/CopySettingsDialog.svelte';
  import CropOverlay from './lib/ui/CropOverlay.svelte';
  import CropPanel from './lib/ui/CropPanel.svelte';
  import DetailPanel from './lib/ui/DetailPanel.svelte';
  import DngPanel from './lib/ui/DngPanel.svelte';
  import Filmstrip from './lib/ui/Filmstrip.svelte';
  import OpenProgress from './lib/ui/OpenProgress.svelte';
  import Scopes from './lib/ui/Scopes.svelte';
  import HistoryPanel from './lib/ui/HistoryPanel.svelte';
  import LensPanel from './lib/ui/LensPanel.svelte';
  import TransformPanel from './lib/ui/TransformPanel.svelte';
  import CopyMenu from './lib/ui/CopyMenu.svelte';
  import UpscaleOverlay from './lib/ui/UpscaleOverlay.svelte';
  import UprightOverlay from './lib/ui/UprightOverlay.svelte';
  import UpscalePanel from './lib/ui/UpscalePanel.svelte';
  import MaskOverlay from './lib/ui/MaskOverlay.svelte';
  import MaskPanel from './lib/ui/MaskPanel.svelte';
  import PresetsPanel from './lib/ui/PresetsPanel.svelte';
  import SnapshotsPanel from './lib/ui/SnapshotsPanel.svelte';
  import ToneCurvePanel from './lib/ui/ToneCurvePanel.svelte';

  let canvas: HTMLCanvasElement;
  let stage: HTMLElement;
  let stageW = $state(800);
  let stageH = $state(600);
  let apiKey = $state('');
  let copyOpen = $state(false);
  let neighbours = $state<Neighbours>({ prev: null, next: null, prevStack: null, nextStack: null, nearby: [] });
  // Stars, pick and reject of the open photo (shown in the title line).
  const flagsText = $derived(editor.asset ? factsText(factsOf(editor.asset.id)) : '');
  // What the culler decided for this photo (shown in the title line).
  let cullInfo = $state<CullInfo | null>(null);
  // The stack window is open on the stack of this photo.
  let stackFor = $state<string | null>(null);
  const cullText = $derived.by(() => {
    const badge = badgeFor(cullInfo);
    if (!cullInfo || !badge) return '';
    if (cullInfo.role === 'best') return `${badge.icon} best of ${cullInfo.groupSize}${cullInfo.pinned ? ' (your pick)' : cullInfo.closeCall ? ' · close call' : ''}`;
    if (cullInfo.role === 'bracket') return `${badge.icon} exposure bracket (${cullInfo.rank} of ${cullInfo.groupSize})`;
    if (cullInfo.role === 'runner-up') return `${badge.icon} runner-up (${cullInfo.rank} of ${cullInfo.groupSize})`;
    return `${badge.icon} ${badge.label.toLowerCase()}`;
  });

  // The photos around this one get ready to open: their originals download once it shows, and
  // they are decoded once its full-resolution decode is done.
  $effect(() => {
    const ids = neighbours.nearby;
    const decode = editor.fullStatus === 'ready' || editor.fullStatus === 'error';
    if (editor.status === 'ready') untrack(() => editor.prefetch(ids, decode));
  });

  // The title line counts down to the full-resolution image.
  let fullNow = $state(0);
  $effect(() => {
    if (!editor.fullEta) return;
    fullNow = performance.now();
    const timer = setInterval(() => (fullNow = performance.now()), 1000);
    return () => clearInterval(timer);
  });
  const fullLeft = $derived(editor.fullEta ? editor.fullEta.estimateMs - (fullNow - editor.fullEta.startedAt) : 0);
  const presetStore = new PresetStore();
  // Built by apps/editor/vite.config.ts: our licence, the third-party notices and the source link.
  const LICENSES_URL = `${import.meta.env.BASE_URL}licenses.txt`;

  // Layouts. desktop: presets on the left, the photo, adjustments on the right. split (tablets,
  // phones held sideways): the photo and one panel on the right with tabs. stacked (phones,
  // tablets held upright): the photo above that panel. Touch screens use split up to large tablets.
  const stackedQuery = new MediaQuery('(max-width: 699px), (orientation: portrait) and (max-width: 1099px)');
  const compactQuery = new MediaQuery('(max-width: 1099px), (pointer: coarse) and (max-width: 1399px)');
  const layout = $derived(stackedQuery.current ? 'stacked' : compactQuery.current ? 'split' : 'desktop');
  const compact = $derived(layout !== 'desktop');
  // Phones (also held sideways): the filmstrip starts collapsed to leave the photo the room.
  const shortQuery = new MediaQuery('(max-height: 499px)');

  // Split and stacked layouts: the panel's tabs. Presets holds what the desktop's left column has.
  type Tab = 'edit' | 'crop' | 'mask' | 'presets';
  const TABS: { id: Tab; label: string; edits?: boolean }[] = [
    { id: 'edit', label: 'Edit' },
    { id: 'crop', label: 'Crop', edits: true },
    { id: 'mask', label: 'Masks', edits: true },
    { id: 'presets', label: 'Presets' },
  ];
  let presetsTab = $state(false);
  // Crop and masking (also from the keyboard) show their own panel.
  const tab = $derived<Tab>(editor.tool === 'crop' ? 'crop' : editor.tool === 'mask' ? 'mask' : presetsTab ? 'presets' : 'edit');
  // Stacked layout: the panel folds away to give the photo the screen.
  let panelFolded = $state(false);
  let menuOpen = $state(false);

  function selectTab(t: Tab) {
    panelFolded = false;
    presetsTab = t === 'presets';
    const tool = t === 'crop' ? 'crop' : t === 'mask' ? 'mask' : 'edit';
    // The white balance picker and the targeted adjustment are part of Edit.
    if (tool === 'edit' ? editor.tool === 'crop' || editor.tool === 'mask' || editor.tool === 'upright' : editor.tool !== tool) editor.setTool(tool);
  }

  function fromMenu(action: () => void) {
    menuOpen = false;
    action();
  }

  const PAD = VIEW_PAD;
  const zoomed = $derived(editor.zoom.on && !editor.wholeView);
  /** The photo's size on screen at this aspect: as big as fits the stage, with a margin. */
  function fit(aspect: number): { w: number; h: number } {
    const maxW = Math.max(50, stageW - PAD * 2);
    const maxH = Math.max(50, stageH - PAD * 2);
    let w = maxW;
    let h = w / aspect;
    if (h > maxH) {
      h = maxH;
      w = h * aspect;
    }
    return { w: Math.round(w), h: Math.round(h) };
  }
  const display = $derived(zoomed ? { w: Math.round(stageW), h: Math.round(stageH) } : fit(editor.frame.width / editor.frame.height));

  // While a photo loads, Immich's preview of it takes the photo's place at the same size, so
  // nothing moves when the photo is ready (unless the edit crops it). Its aspect is known once
  // it has loaded.
  let previewAspect = $state<number | null>(null);
  $effect(() => {
    void editor.previewUrl;
    previewAspect = null;
  });
  const previewBox = $derived(previewAspect ? fit(previewAspect) : null);

  const info = $derived(shotSettings(editor.asset?.exifInfo).join('   '));

  const camera = $derived([editor.asset?.exifInfo?.make, editor.asset?.exifInfo?.model].filter(Boolean).join(' '));

  onMount(() => {
    const ro = new ResizeObserver(([entry]) => {
      stageW = entry!.contentRect.width;
      stageH = entry!.contentRect.height;
      editor.setViewport(stageW, stageH, devicePixelRatio || 1);
    });
    ro.observe(stage);
    // Not passive: Ctrl + wheel must not also zoom the browser page.
    stage.addEventListener('wheel', onWheel, { passive: false });
    editor.load(canvas);
    // Unsaved changes stay as a draft (drafts/), so leaving never asks. Only a save still running,
    // or edits from the last moments not stored yet, make the browser ask.
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (unloading) return;
      const late = editor.draftDue || drafts.pending > 0;
      void editor.keepDraft();
      if (editor.saving || late) e.preventDefault();
    };
    const onHide = () => {
      if (document.visibilityState === 'hidden') void editor.keepDraft();
    };
    addEventListener('beforeunload', beforeUnload);
    addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onHide);
    addEventListener('popstate', onPopState);
    return () => {
      ro.disconnect();
      stage.removeEventListener('wheel', onWheel);
      removeEventListener('beforeunload', beforeUnload);
      removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onHide);
      removeEventListener('popstate', onPopState);
    };
  });

  /** The page is being left on purpose, with the draft stored: the browser mustn't ask. */
  let unloading = false;

  /** Back to Immich. The target is a function: after saving, it points at the new render. */
  async function toImmich(target: () => string) {
    await editor.waitForRender();
    unloading = true;
    location.href = target();
  }

  /** The original edit (null) or a virtual copy of this RAW; the edit left keeps its draft. */
  function switchEdit(copyId: string | null) {
    void editor.openEdit(copyId);
  }

  async function goBack() {
    await editor.keepDraft();
    await toImmich(() => editor.backUrl());
  }

  /**
   * Another photo (the filmstrip, the arrow keys): it opens in this page, without loading it again.
   * The photo left keeps its unsaved changes as a draft.
   */
  function openAsset(id: string, asset?: AssetResponseDto) {
    if (id === editor.asset?.id) return;
    stackFor = null;
    // The filmstrip's look of it shows at once (looks.ts).
    void editor.switchPhoto(id, 'push', looks.hint(id, asset));
  }

  /** Back and Forward between photos opened in this page. */
  function onPopState() {
    const id = new URLSearchParams(location.search).get('asset');
    const open = editor.asset?.id;
    if (!id || id === open) return;
    if (editor.saving) {
      // Not while saving: the open photo's address goes back.
      if (open) history.pushState(null, '', editor.urlFor(open));
      return;
    }
    stackFor = null;
    void editor.switchPhoto(id, 'none', looks.hint(id));
  }

  /** "Delete others" in the stack window trashed this photo: go on with the shot that was kept. */
  function afterCurrentDeleted(kept: StackFrame) {
    editor.discardDraft();
    unloading = true;
    if (kept.raw) {
      location.href = editor.urlFor(kept.raw.id);
      return;
    }
    const gone = editor.asset?.id;
    const back = editor.returnPath;
    location.href = back && gone && back.includes(gone) ? back.replaceAll(gone, kept.face.id) : `/photos/${kept.face.id}`;
  }

  function isTyping(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) return true;
    return el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'range';
  }

  function onKey(e: KeyboardEvent) {
    if (menuOpen && e.key === 'Escape') {
      menuOpen = false;
      return;
    }
    if (isTyping(e.target) || copyOpen || editor.dngDialog || editor.exportDialog || stackFor) return;
    if (editor.saving) return;
    if (editor.status !== 'ready') {
      if (editor.status === 'loading' || editor.status === 'error') onKeyWhileOpening(e);
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const onRange = (e.target as HTMLElement | null)?.tagName === 'INPUT';
    if (flagKey(e)) return;
    if (mod && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) editor.redo();
      else editor.undo();
    } else if (mod && key === 'y') {
      e.preventDefault();
      editor.redo();
    } else if (mod && key === 's') {
      e.preventDefault();
      editor.save();
    } else if (mod && (e.shiftKey || e.altKey) && key === 'c') {
      e.preventDefault();
      copyOpen = true;
    } else if (mod && e.altKey && key === 'v') {
      e.preventDefault();
      editor.pastePrevious();
    } else if (mod && e.shiftKey && key === 'v') {
      e.preventDefault();
      editor.pasteSettings();
    } else if (mod && !e.shiftKey && !e.altKey && key === 'u') {
      e.preventDefault();
      editor.autoTone();
    } else if (mod && e.key === '[') {
      e.preventDefault();
      editor.rotate90(-1);
    } else if (mod && e.key === ']') {
      e.preventDefault();
      editor.rotate90(1);
    } else if (mod && !e.shiftKey && !e.altKey && (e.key === "'" || e.code === 'Quote')) {
      // Lightroom's Create Virtual Copy.
      e.preventDefault();
      void editor.newVirtualCopy();
    } else if (mod || e.altKey) {
      return;
    } else if (key === 't' && e.shiftKey) {
      editor.setTool(editor.tool === 'upright' ? 'edit' : 'upright');
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && editor.tool === 'upright' && !onRange) {
      if (editor.uprightSel !== null) {
        e.preventDefault();
        editor.removeUprightGuide(editor.uprightSel);
      }
    } else if (e.key === 'Enter' && editor.tool === 'upright') {
      editor.setTool('edit');
    } else if (key === 'w' && e.shiftKey) {
      editor.setTool(editor.tool === 'mask' ? 'edit' : 'mask');
    } else if (key === 'm') {
      editor.startMask(e.shiftKey ? 'radial' : 'linear');
    } else if (key === 'k' && e.shiftKey) {
      editor.startMask('polygon');
    } else if (key === 'k') {
      editor.startMask('brush');
    } else if ((e.key === '[' || e.key === ']') && editor.painting) {
      // Brush size, in steps that feel even at every size.
      const s = editor.brush.size;
      editor.setBrush({ size: e.key === ']' ? Math.min(100, s + Math.max(1, Math.round(s * 0.12))) : Math.max(1, s - Math.max(1, Math.round(s * 0.12))) });
    } else if (key === 'o' && editor.tool === 'mask') {
      editor.toggleMaskOverlay();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && editor.maskDraft?.kind === 'polygon' && !onRange) {
      // Takes back the last corner of the polygon being drawn.
      e.preventDefault();
      editor.removePolygonPoint();
    } else if (e.key === 'Enter' && editor.maskDraft?.kind === 'polygon') {
      editor.closePolygon();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && editor.tool === 'mask' && !onRange) {
      const m = editor.selectedMask;
      const c = editor.selectedComponent;
      if (m && c) {
        e.preventDefault();
        editor.deleteComponent(m.id, c.id);
      }
    } else if (e.code === 'Backslash' || e.key === '\\') {
      e.preventDefault();
      editor.toggleBefore();
    } else if (key === 'j') {
      editor.toggleClipping();
    } else if (key === 'r') {
      editor.setTool(editor.tool === 'crop' ? 'edit' : 'crop');
    } else if (key === 'w') {
      editor.setTool(editor.tool === 'wb' ? 'edit' : 'wb');
    } else if (key === 'z' && !editor.wholeView) {
      editor.toggleZoom();
    } else if (key === 'x' && editor.tool === 'crop') {
      editor.togglePortrait();
    } else if (e.key === 'Enter' && editor.tool === 'crop') {
      editor.setTool('edit');
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !onRange) {
      const id = e.key === 'ArrowLeft' ? neighbours.prev : neighbours.next;
      if (id) openAsset(id);
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !onRange) {
      e.preventDefault();
      const id = e.key === 'ArrowUp' ? neighbours.prevStack : neighbours.nextStack;
      if (id) openAsset(id);
    } else if (e.key === 'Escape') {
      if (editor.maskDraft) editor.cancelMaskDraft();
      else if (editor.tool !== 'edit') editor.setTool('edit');
      else if (editor.zoom.on) editor.setZoom(false);
      else goBack();
    }
  }

  /** While a photo opens (or failed to): moving on to another photo, its flags, and back to Immich. */
  function onKeyWhileOpening(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (flagKey(e)) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const id = e.key === 'ArrowLeft' ? neighbours.prev : neighbours.next;
      if (id) openAsset(id);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const id = e.key === 'ArrowUp' ? neighbours.prevStack : neighbours.nextStack;
      if (id) openAsset(id);
    } else if (e.key === 'Escape') {
      goBack();
    }
  }

  /**
   * 0-5 (stars), P (pick), X (reject; in the crop tool it turns the crop), U (neither) on the
   * open photo's shot. True when the key was one of them.
   */
  function flagKey(e: KeyboardEvent): boolean {
    const id = editor.asset?.id;
    if (!id || editor.readOnly || e.ctrlKey || e.metaKey || e.altKey) return false;
    const k = e.key.toLowerCase();
    let action: FlagAction | null = null;
    if (/^[0-5]$/.test(e.key)) action = { kind: 'rate', rating: Number(e.key) };
    else if (k === 'p') action = { kind: 'pick' };
    else if (k === 'x' && editor.tool !== 'crop') action = { kind: 'reject' };
    else if (k === 'u') action = { kind: 'clear' };
    if (!action) return false;
    e.preventDefault();
    void flag([id], action);
    return true;
  }

  // ------------------------------------------------------- view: tap / double-tap / pan
  let drag: { id: number; x: number; y: number; moved: boolean } | null = null;
  let lastTap = { t: 0, x: 0, y: 0 };
  /** Targeted adjustment drag (Color Mixer tool). */
  let tat: { id: number; y: number } | null = null;
  let tatHint = $state('');
  let tatHintAt = 0;

  // Two-finger pinch on a touch screen: zooms and pans, keeping the photo point that was between
  // the fingers at the start between them.
  const touches = new Map<number, [number, number]>();
  let pinch: { dist: number; anchor: { scale: number; p: [number, number] } } | null = null;

  function viewPoint(e: PointerEvent | MouseEvent): [number, number] {
    return viewPointAt(e.clientX, e.clientY);
  }

  function viewPointAt(clientX: number, clientY: number): [number, number] {
    const r = canvas.getBoundingClientRect();
    return [(clientX - r.left) / r.width, (clientY - r.top) / r.height];
  }

  function fingers(): { mid: [number, number]; dist: number } {
    const [a, b] = [...touches.values()] as [[number, number], [number, number]];
    return { mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], dist: Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1])) };
  }

  function onViewDown(e: PointerEvent) {
    if (editor.wholeView || editor.status !== 'ready' || e.button > 0) return;
    if (e.pointerType === 'touch' && editor.tool !== 'tat') {
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (touches.size > 2) return;
      if (touches.size === 2) {
        // The second finger turns the tap or pan into a pinch.
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        drag = null;
        lastTap.t = 0;
        const { mid, dist } = fingers();
        const anchor = editor.zoomAnchor(...viewPointAt(mid[0], mid[1]));
        pinch = anchor ? { dist, anchor } : null;
        return;
      }
    }
    if (editor.tool === 'tat') {
      const [x, y] = viewPoint(e);
      if (editor.beginTargeted(x, y)) {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        tat = { id: e.pointerId, y: e.clientY };
      }
      return;
    }
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
  }

  function onViewMove(e: PointerEvent) {
    if (touches.has(e.pointerId)) {
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (pinch && touches.size === 2) {
        const { mid, dist } = fingers();
        const s = stage.getBoundingClientRect();
        editor.zoomFrom(pinch.anchor, dist / pinch.dist, [mid[0] - s.left, mid[1] - s.top]);
        return;
      }
    }
    if (editor.tool === 'tat') {
      if (tat && tat.id === e.pointerId) editor.dragTargeted(e.clientY - tat.y);
      else if (!tat && performance.now() - tatHintAt > 60) {
        tatHintAt = performance.now();
        const [x, y] = viewPoint(e);
        tatHint = editor.bandsAt(x, y) ?? '';
      }
      return;
    }
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    if (zoomed) editor.pan(dx, dy);
    drag.x = e.clientX;
    drag.y = e.clientY;
  }

  function onViewUp(e: PointerEvent) {
    if (touches.delete(e.pointerId) && pinch) {
      // Lifting a finger ends the pinch; the finger left on the photo neither pans nor taps.
      if (touches.size < 2) pinch = null;
      return;
    }
    if (tat && tat.id === e.pointerId) {
      tat = null;
      editor.endTargeted();
      return;
    }
    if (!drag || drag.id !== e.pointerId) return;
    const wasDrag = drag.moved;
    drag = null;
    if (wasDrag) return;
    const [x, y] = viewPoint(e);
    if (editor.tool === 'wb') {
      editor.pickWhiteBalance(x, y);
      return;
    }
    // Double-click / double-tap toggles 100 % zoom at that point.
    const now = performance.now();
    if (now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
      lastTap.t = 0;
      editor.toggleZoom(x, y);
    } else {
      lastTap = { t: now, x: e.clientX, y: e.clientY };
    }
  }

  /** Ctrl + mouse wheel (and trackpad pinch, which arrives as one) zooms around the cursor. */
  function onWheel(e: WheelEvent) {
    if (!e.ctrlKey || editor.status !== 'ready' || editor.wholeView) return;
    e.preventDefault();
    const [x, y] = viewPoint(e);
    const s = stage.getBoundingClientRect();
    editor.zoomBy(wheelFactor(e), x, y, [e.clientX - s.left, e.clientY - s.top]);
  }

  function confirmCopy(groups: GroupId[]) {
    copyOpen = false;
    editor.copySettings(groups);
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="app {layout}" class:folded={layout === 'stacked' && panelFolded}>
  <header class="top">
    <button class="icon back" onclick={goBack} title="Back to Immich (Esc)" aria-label="Back to Immich">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z" /></svg>
    </button>
    <div class="title">
      <div class="name">{editor.asset?.originalFileName ?? 'immich-raw'}</div>
      <div class="sub">
        {camera}
        {#if editor.status === 'ready'}
          {#if editor.fullStatus === 'decoding'}· decoding full resolution{fullLeft >= 1500 ? ` (about ${Math.round(fullLeft / 1000)} s)` : ''}…{/if}
          {#if editor.readOnly}· view only{/if}
          {#if editor.recipe.render && !editor.dirty}· saved{/if}
          {#if editor.dirty}
            · unsaved changes
            {#if !editor.readOnly}<button class="discard" onclick={() => editor.discardDraft()} title="Back to the saved edit; the draft kept in this browser goes">Discard</button>{/if}
          {/if}
          {#if flagsText}<span class="flags" class:rejected={flagsText.startsWith('rejected')}>· {flagsText}</span>{/if}
          {#if flagStatus.error}<span class="cull rejected" title={flagStatus.error}>· {flagStatus.error}</span>{/if}
          {#if cullText}
            {#if (cullInfo?.groupSize ?? 0) > 1}
              <button class="cull" class:rejected={cullInfo?.role === 'rejected'} onclick={() => (stackFor = editor.asset?.id ?? null)} title="Compare the photos of this stack">· {cullText}</button>
            {:else}
              <span class="cull" class:rejected={cullInfo?.role === 'rejected'}>· {cullText}</span>
            {/if}
          {/if}
        {/if}
      </div>
    </div>
    <CopyMenu onSwitch={switchEdit} />
    <div class="spacer"></div>
    <button class="icon" onclick={() => editor.undo()} disabled={!editor.canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12.5 8c-2.65 0-5.05 1-6.9 2.6L2 7v9h9l-3.62-3.62A7.98 7.98 0 0 1 20.48 16l2.37-.78A10.5 10.5 0 0 0 12.5 8z" /></svg>
    </button>
    <button class="icon" onclick={() => editor.redo()} disabled={!editor.canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M18.4 10.6A10.46 10.46 0 0 0 11.5 8 10.5 10.5 0 0 0 1.15 15.22l2.37.78A8 8 0 0 1 16.62 12.38L13 16h9V7z" /></svg>
    </button>
    {#if compact}
      <!-- Crop and Masks are tabs of the panel; zoom, DNG and the licences go in the menu. -->
      <button class="icon" class:active={editor.before} onclick={() => editor.toggleBefore()} disabled={editor.status !== 'ready'} title="Before / after" aria-label="Before / after" aria-pressed={editor.before}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /><path d="M4 5h8v14H4z" fill="currentColor" stroke="none" /></svg>
      </button>
      <button class="primary" onclick={() => editor.save()} disabled={editor.status !== 'ready' || editor.readOnly || !!editor.saving || (!editor.dirty && !!editor.recipe.render)} title="Save to Immich">Save</button>
      <div class="more">
        <button class="icon" onclick={() => (menuOpen = !menuOpen)} aria-label="More" aria-haspopup="menu" aria-expanded={menuOpen}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" /></svg>
        </button>
        {#if menuOpen}
          <div class="menu-shade" role="presentation" onpointerdown={() => (menuOpen = false)}></div>
          <div class="menu" role="menu">
            <button role="menuitem" onclick={() => fromMenu(() => (zoomed ? editor.setZoom(false) : editor.toggleZoom()))} disabled={editor.status !== 'ready' || editor.wholeView}>
              {zoomed ? 'Fit to screen' : 'Zoom to 100 %'}
            </button>
            <button role="menuitem" onclick={() => fromMenu(() => editor.openDngDialog())} disabled={editor.status !== 'ready' || editor.readOnly || !!editor.saving}>Convert to DNG…</button>
            <a role="menuitem" href={LICENSES_URL} target="_blank" rel="noopener" onclick={() => (menuOpen = false)}>Licences and source code</a>
          </div>
        {/if}
      </div>
    {:else}
      <button class:active={zoomed} onclick={() => (zoomed ? editor.setZoom(false) : editor.toggleZoom())} disabled={editor.status !== 'ready' || editor.wholeView} title="Zoom 100 % (Z, or double-click the photo; Ctrl + mouse wheel zooms freely)">
        {zoomed ? 'Fit' : '1:1'}
      </button>
      <button class:active={editor.before} onclick={() => editor.toggleBefore()} disabled={editor.status !== 'ready'} title="Before / after (\)">Before</button>
      <button class:active={editor.tool === 'crop'} onclick={() => editor.setTool(editor.tool === 'crop' ? 'edit' : 'crop')} disabled={editor.status !== 'ready' || editor.readOnly} title="Crop & straighten (R)">Crop</button>
      <button class:active={editor.tool === 'mask'} onclick={() => editor.setTool(editor.tool === 'mask' ? 'edit' : 'mask')} disabled={editor.status !== 'ready' || editor.readOnly} title="Masking: local adjustments with gradients and ranges (Shift+W)">
        Masks{editor.recipe.masks.length ? ` (${editor.recipe.masks.length})` : ''}
      </button>
      <button class="primary" onclick={() => editor.save()} disabled={editor.status !== 'ready' || editor.readOnly || !!editor.saving || (!editor.dirty && !!editor.recipe.render)} title="Save to Immich (Ctrl+S)">
        {editor.recipe.render ? 'Save' : 'Save to Immich'}
      </button>
      <a class="about" href={LICENSES_URL} target="_blank" rel="noopener" title="immich-raw: licences and source code" aria-label="Licences and source code">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></svg>
      </a>
    {/if}
  </header>

  <!-- The left column on desktops, the Presets tab otherwise. -->
  {#snippet library()}
    <PresetsPanel
      store={presetStore}
      getCurrent={() => $state.snapshot(editor.recipe) as Recipe}
      onApply={(patch, name) => editor.applyPatch(patch, `Preset: ${name}`)}
      onPreview={(patch) => editor.previewPatch(patch)}
      parseXmp={(text, filename) => editor.parseXmpPreset(text, filename)}
      disabled={editor.readOnly}
    />
    <SnapshotsPanel
      snapshots={editor.snapshots}
      onCreate={(name) => editor.createSnapshot(name)}
      onApply={(id) => editor.applySnapshot(id)}
      onRename={(id, name) => editor.renameSnapshot(id, name)}
      onDelete={(id) => editor.deleteSnapshot(id)}
      disabled={editor.readOnly}
    />
    <HistoryPanel steps={editor.historySteps} index={editor.historyIndex} onJump={(i) => editor.jumpToHistory(i)} />
    <div class="copy">
      <button onclick={() => (copyOpen = true)} title="Copy settings (Ctrl+Shift+C)">Copy…</button>
      <button onclick={() => editor.pasteSettings()} disabled={!editor.hasClipboard || editor.readOnly} title="Paste settings (Ctrl+Shift+V)">Paste</button>
      <button onclick={() => editor.pastePrevious()} disabled={!editor.hasPrevious || editor.readOnly} title="Paste settings of the last saved photo (Ctrl+Alt+V)">Previous</button>
    </div>
    <ExportPanel />
    <UpscalePanel />
    <DngPanel />
  {/snippet}

  {#if layout === 'desktop'}
    <aside class="left">
      {#if editor.status === 'ready'}{@render library()}{/if}
    </aside>
  {/if}

  <section class="center">
    <main class="stage" bind:this={stage}>
      <div
        class="frame"
        style:width="{display.w}px"
        style:height="{display.h}px"
        class:hidden={editor.status !== 'ready'}
        class:zoomed
        class:picking={editor.tool === 'wb'}
        class:targeting={editor.tool === 'tat'}
        role="presentation"
        onpointerdown={onViewDown}
        onpointermove={onViewMove}
        onpointerup={onViewUp}
        onpointercancel={(e) => {
          drag = null;
          touches.delete(e.pointerId);
          if (touches.size < 2) pinch = null;
          if (tat) onViewUp(e);
        }}
        onpointerleave={() => (tatHint = '')}
      >
        <canvas bind:this={canvas} style:width="{display.w}px" style:height="{display.h}px"></canvas>
        {#if editor.tool === 'crop' && editor.status === 'ready'}
          <CropOverlay width={display.w} height={display.h} />
        {/if}
        {#if editor.tool === 'mask' && editor.status === 'ready' && !editor.before}
          <MaskOverlay width={display.w} height={display.h} />
        {/if}
        {#if editor.tool === 'upscale' && editor.status === 'ready' && !editor.before}
          <UpscaleOverlay width={display.w} height={display.h} />
        {/if}
        {#if editor.tool === 'upright' && editor.status === 'ready'}
          <UprightOverlay width={display.w} height={display.h} />
          <div class="badge bottom">
            {editor.uprightFailed
              ? 'These guides would turn the photo too far: move or remove one'
              : 'Guided Upright: drag along edges that should be vertical or horizontal · Enter when done'}
          </div>
        {/if}
        {#if editor.before}<div class="badge">Before</div>{/if}
        {#if editor.tool === 'tat'}
          <div class="badge bottom">
            Targeted {editor.recipe.profile === 'monochrome' ? 'B&W' : editor.tatTarget === 'bw' ? 'saturation' : editor.tatTarget}{tatHint ? ` · ${tatHint}` : ''} — drag up/down
          </div>
        {/if}
        {#if editor.maskView !== 'none'}<div class="badge right">{editor.maskView === 'sharpenMask' ? 'Sharpening mask' : editor.maskView === 'highlights' ? 'Highlight clipping' : 'Shadow clipping'}</div>{/if}
      </div>

      {#if editor.status === 'loading'}
        <div class="center-msg">
          {#if editor.previewUrl}
            <img
              class="preview"
              class:sized={previewBox}
              src={editor.previewUrl}
              alt=""
              style:width={previewBox ? `${previewBox.w}px` : null}
              style:height={previewBox ? `${previewBox.h}px` : null}
              onload={(e) => {
                const img = e.currentTarget as HTMLImageElement;
                if (img.naturalWidth && img.naturalHeight) previewAspect = img.naturalWidth / img.naturalHeight;
              }}
            />
          {/if}
          <div class="progress-over">
            <OpenProgress steps={editor.openSteps} fallback={editor.loadingText} />
          </div>
        </div>
      {:else if editor.status === 'auth'}
        <div class="center-msg card">
          <h2>Log in to Immich first</h2>
          <p>The editor uses your Immich session. <a href="/auth/login">Open Immich</a>, log in, then reload this page.</p>
          <details>
            <summary>Use an API key instead</summary>
            <p class="dim">For setups where the editor runs on a different address than Immich. The key is stored in this browser only.</p>
            <div class="row"><input placeholder="API key" bind:value={apiKey} /><button onclick={() => editor.useApiKey(apiKey)}>Use key</button></div>
          </details>
        </div>
      {:else if editor.status === 'error'}
        <div class="center-msg card">
          <h2>Can't open this photo</h2>
          <p>{editor.error}</p>
          <button onclick={() => (location.href = editor.backUrl())}>Back to Immich</button>
        </div>
      {/if}

      {#if editor.draftConflict}
        <div class="banner">
          <div>
            <strong>This draft is older than the saved edit.</strong>
            Your unsaved changes from {new Date(editor.draftConflict.at).toLocaleString()} were kept in this browser; the edit was saved again since (in another tab or browser).
          </div>
          <button class="primary" onclick={() => editor.keepOlderDraft()}>Keep draft</button>
          <button onclick={() => editor.discardDraft()}>Use saved</button>
        </div>
      {:else if editor.sidecarOffer}
        <div class="banner">
          <div>
            <strong>Lightroom settings found.</strong>
            This RAW's XMP sidecar has {editor.sidecarOffer.applied} settings the editor can apply{editor.sidecarOffer.unmapped ? ` (${editor.sidecarOffer.unmapped} not supported yet)` : ''}.
            {#each editor.sidecarOffer.warnings.slice(0, 3) as w (w)}<div class="dim">{w}</div>{/each}
          </div>
          <button class="primary" onclick={() => editor.applySidecar()}>Apply</button>
          <button onclick={() => editor.dismissSidecar()}>Ignore</button>
        </div>
      {:else if editor.fujiOffer}
        <div class="banner">
          <div>
            {#if editor.fujiOffer.reason === 'camera'}
              <strong>Shot with {editor.fujiOffer.label}.</strong>
              Download the Fujifilm film looks (about {FUJI_LOOKS_MB} MB) to start from it?
            {:else}
              <strong>This edit uses the {editor.fujiOffer.label} film look.</strong>
              It isn't downloaded in this browser yet, so the photo shows with Color (about {FUJI_LOOKS_MB} MB).
            {/if}
            <div class="dim">Community look tables by abpy (CC BY-NC-SA 4.0), kept in this browser. Your photo is not uploaded.</div>
          </div>
          <button class="primary" onclick={() => editor.acceptFujiOffer()}>Download</button>
          <button onclick={() => editor.dismissFujiOffer()}>Not now</button>
          {#if editor.fujiOffer.reason === 'camera'}<button onclick={() => editor.dismissFujiOffer(true)}>Don't ask again</button>{/if}
        </div>
      {/if}

      {#if editor.saving}
        <div class="saving">
          <div class="card">
            <div>{editor.saving.label}…</div>
            <div class="bar"><i style:width="{Math.round(editor.saving.fraction * 100)}%"></i></div>
            {#if editor.saving.cancel}<button class="cancel" onclick={() => editor.saving?.cancel?.()}>Cancel</button>{/if}
          </div>
        </div>
      {/if}

      {#if editor.status === 'ready' && (editor.notice || editor.error || editor.warning)}
        <div class="toast" class:err={!!editor.error}>
          <span>{editor.error ?? editor.notice ?? editor.warning}</span>
          {#if editor.notice && editor.recipe.render && !editor.error && !editor.dirty}
            <button onclick={() => toImmich(() => editor.backUrl())}>Back to Immich</button>
          {/if}
          <button class="icon" aria-label="Dismiss" onclick={() => ((editor.notice = null), (editor.error = null), (editor.warning = null))}>✕</button>
        </div>
      {/if}
    </main>
    <!-- Stays while the next photo loads, so it keeps its place and its list. -->
    {#if editor.asset && editor.status !== 'auth'}
      <Filmstrip
        ctx={editor.ctx}
        current={editor.asset}
        onSelect={openAsset}
        onNeighbours={(n) => (neighbours = n)}
        canCull={!editor.readOnly}
        onCurrentCull={(info) => (cullInfo = info)}
        bind:stackFor
        unsaved={editor.dirty}
        onCurrentDeleted={afterCurrentDeleted}
        onSaveDrafts={editor.readOnly ? undefined : (ids) => void editor.saveDrafts(ids)}
        currentRenderId={editor.recipe.render?.assetId ?? null}
        startCollapsed={layout === 'stacked' || shortQuery.current}
      />
    {/if}
  </section>

  <aside class="side">
    {#if compact}
      <nav class="tabs" aria-label="Panels">
        {#each TABS as t (t.id)}
          <button class:active={tab === t.id} aria-pressed={tab === t.id} disabled={editor.status !== 'ready' || (t.edits && editor.readOnly)} onclick={() => selectTab(t.id)}>
            {t.label}{t.id === 'mask' && editor.recipe.masks.length ? ` (${editor.recipe.masks.length})` : ''}
          </button>
        {/each}
        {#if layout === 'stacked'}
          <button class="icon fold" onclick={() => (panelFolded = !panelFolded)} aria-label={panelFolded ? 'Show the panel' : 'Hide the panel'} aria-expanded={!panelFolded}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d={panelFolded ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} /></svg>
          </button>
        {/if}
      </nav>
    {/if}
    <div class="panels">
      {#if compact && tab === 'presets'}
        {#if editor.status === 'ready'}{@render library()}{/if}
      {:else}
        <Scopes
          kind={editor.scope}
          histogram={editor.histogram}
          data={editor.scopeData}
          clipping={editor.clipping}
          onToggleClipping={() => editor.toggleClipping()}
          onKind={(k) => editor.setScope(k)}
          {info}
        />
        {#if editor.status === 'ready'}
          {#if editor.tool === 'crop'}
            <CropPanel />
          {:else if editor.tool === 'mask'}
            <MaskPanel />
          {:else}
            <BasicPanel />
            <ToneCurvePanel />
            <ColorMixerPanel />
            <ColorGradingPanel />
            <DetailPanel />
            <LensPanel />
            <TransformPanel />
            <EffectsPanel />
            <CalibrationPanel />
          {/if}
          <div class="keys">
            <div><kbd>\</kbd> before/after</div>
            <div><kbd>J</kbd> clipping</div>
            <div><kbd>R</kbd> crop</div>
            <div><kbd>⇧</kbd>+<kbd>T</kbd> guided upright</div>
            <div><kbd>W</kbd> WB picker</div>
            <div><kbd>Z</kbd> / double-click: 1:1</div>
            <div><kbd>Ctrl</kbd>+wheel: zoom</div>
            <div><kbd>←</kbd><kbd>→</kbd> filmstrip, <kbd>↑</kbd><kbd>↓</kbd> stacks</div>
            <div><kbd>0</kbd>–<kbd>5</kbd> stars</div>
            <div><kbd>P</kbd> pick, <kbd>X</kbd> reject, <kbd>U</kbd> neither</div>
            <div><kbd>Ctrl</kbd>+<kbd>Z</kbd> undo</div>
            <div><kbd>Ctrl</kbd>+<kbd>S</kbd> save</div>
            <div><kbd>Ctrl</kbd>+<kbd>'</kbd> virtual copy</div>
            <div><kbd>Ctrl</kbd>+<kbd>⇧</kbd>+<kbd>C</kbd>/<kbd>V</kbd> copy/paste</div>
            <div><kbd>Alt</kbd>-drag: clipping</div>
            <div><kbd>Ctrl</kbd>+<kbd>U</kbd> auto tone</div>
            <div><kbd>⇧</kbd>+<kbd>W</kbd> masking</div>
            <div><kbd>M</kbd> / <kbd>⇧</kbd>+<kbd>M</kbd> gradients</div>
            <div><kbd>K</kbd> brush, <kbd>[</kbd> <kbd>]</kbd> size</div>
            <div><kbd>⇧</kbd>+<kbd>K</kbd> polygon</div>
          </div>
        {/if}
      {/if}
    </div>
  </aside>
</div>

<ConvertDngDialog />
<AiDownloadDialog />
<FujiLooksDialog />

{#if editor.exportDialog === 'settings'}
  <ExportSettingsDialog />
{:else if editor.exportDialog === 'album'}
  <BatchExportDialog onClose={() => (editor.exportDialog = null)} />
{/if}

{#if copyOpen}
  <CopySettingsDialog title="Copy Settings" confirmLabel="Copy" initial={DEFAULT_GROUPS} onConfirm={confirmCopy} onCancel={() => (copyOpen = false)} />
{/if}

<style>
  .app {
    display: grid;
    grid-template-columns: 230px 1fr 320px;
    grid-template-rows: 48px 1fr;
    height: 100%;
    /* Phones: the height left by the browser's toolbars. */
    height: 100dvh;
  }
  .app.split {
    grid-template-columns: minmax(0, 1fr) 300px;
  }
  .app.stacked {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: 48px minmax(0, 1fr) auto;
  }
  .top {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    background: var(--panel);
    border-bottom: 1px solid #111;
  }
  .title {
    min-width: 0;
  }
  .name {
    color: var(--text-bright);
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  button.cull {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: inherit;
    text-decoration: underline dotted;
    text-underline-offset: 2px;
  }
  button.cull:hover {
    color: var(--text-bright);
  }
  .cull.rejected,
  button.cull.rejected:hover {
    color: var(--danger);
  }
  .flags {
    color: #ffd54a;
  }
  .flags.rejected {
    color: var(--danger);
  }
  button.discard {
    background: none;
    border: none;
    padding: 0 0 0 4px;
    font: inherit;
    color: inherit;
    text-decoration: underline dotted;
    text-underline-offset: 2px;
  }
  button.discard:hover {
    color: var(--text-bright);
  }
  .sub {
    color: var(--text-dim);
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .app:not(.desktop) .top {
    gap: 4px;
    padding: 0 6px;
  }
  .more {
    position: relative;
  }
  .menu-shade {
    position: fixed;
    inset: 0;
    z-index: 50;
  }
  .menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 51;
    min-width: 210px;
    display: flex;
    flex-direction: column;
    padding: 4px;
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 6px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
  }
  .menu button,
  .menu a {
    text-align: left;
    background: none;
    border: none;
    border-radius: 4px;
    padding: 10px 12px;
    color: var(--text);
    text-decoration: none;
  }
  .menu button:hover:not(:disabled),
  .menu a:hover {
    background: var(--line);
    color: var(--text-bright);
  }
  .spacer {
    flex: 1;
  }
  .back {
    border: none;
    background: none;
  }
  .about {
    color: var(--text-dim);
    line-height: 0;
    padding: 4px;
  }
  .about:hover {
    color: var(--text-bright);
  }
  .left,
  .side {
    background: var(--panel);
    min-height: 0;
  }
  .left {
    overflow-y: auto;
    border-right: 1px solid #111;
  }
  .side {
    display: flex;
    flex-direction: column;
    border-left: 1px solid #111;
  }
  .panels {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .app.stacked .side {
    height: 44dvh;
    border-left: none;
    border-top: 1px solid #111;
  }
  .app.stacked.folded .side {
    height: auto;
  }
  .app.stacked.folded .panels {
    display: none;
  }
  .tabs {
    flex: none;
    display: flex;
    gap: 2px;
    padding: 4px;
    border-bottom: 1px solid #111;
  }
  .tabs button {
    flex: 1;
    min-width: 0;
    background: none;
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 7px 4px;
    font-size: 13px;
    color: var(--text-dim);
    white-space: nowrap;
  }
  .tabs button.active {
    background: var(--panel-2);
    border-color: transparent;
    color: var(--accent);
  }
  .tabs .fold {
    flex: none;
    padding: 7px 10px;
  }
  .copy {
    display: flex;
    gap: 6px;
    padding: 10px;
  }
  .copy button {
    flex: 1;
    padding: 4px 4px;
  }
  .center {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .stage {
    position: relative;
    flex: 1;
    min-height: 0;
    background: var(--bg-view);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .frame {
    position: relative;
    box-shadow: 0 2px 18px rgba(0, 0, 0, 0.6);
    cursor: zoom-in;
    touch-action: none;
  }
  .frame.zoomed {
    position: absolute;
    inset: 0;
    box-shadow: none;
    cursor: grab;
  }
  .frame.zoomed:active {
    cursor: grabbing;
  }
  .frame.hidden {
    visibility: hidden;
    position: absolute;
  }
  .frame.picking {
    cursor: crosshair;
  }
  .frame.targeting,
  .frame.targeting:active {
    cursor: ns-resize;
  }
  canvas {
    display: block;
  }
  .badge {
    position: absolute;
    top: 8px;
    left: 8px;
    background: rgba(0, 0, 0, 0.6);
    padding: 2px 8px;
    border-radius: 3px;
    color: var(--text-bright);
    pointer-events: none;
  }
  .badge.right {
    left: auto;
    right: 8px;
  }
  .badge.bottom {
    top: auto;
    bottom: 8px;
  }
  .center-msg {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
  }
  /* Where the photo will be drawn, like .frame; hidden until its size is known. */
  .preview {
    visibility: hidden;
    box-shadow: 0 2px 18px rgba(0, 0, 0, 0.6);
  }
  .preview.sized {
    visibility: visible;
  }
  .progress-over {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
  }
  .progress-over > :global(*) {
    pointer-events: auto;
  }
  .bar {
    height: 4px;
    background: #333;
    border-radius: 2px;
    margin-top: 8px;
    overflow: hidden;
  }
  .bar i {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 0.15s;
  }
  .card {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 18px 22px;
    max-width: 460px;
    margin: auto;
  }
  .center-msg.card {
    position: absolute;
    inset: auto;
  }
  .card h2 {
    margin: 0 0 8px;
    font-size: 16px;
    color: var(--text-bright);
  }
  .card a {
    color: var(--accent);
  }
  .dim {
    color: var(--text-dim);
  }
  .row {
    display: flex;
    gap: 8px;
  }
  .row input {
    flex: 1;
    font: inherit;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 4px 8px;
  }
  .banner {
    position: absolute;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--panel);
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: 10px 12px;
    max-width: 80%;
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.5);
  }
  .banner button {
    white-space: nowrap;
  }
  .saving {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .saving .card {
    min-width: 300px;
  }
  .saving .cancel {
    display: block;
    margin: 10px auto 0;
  }
  .toast {
    position: absolute;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 8px 10px 8px 14px;
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.5);
    max-width: 80%;
  }
  .toast.err {
    border-color: var(--danger);
  }
  .keys {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px 8px;
    padding: 12px;
    color: var(--text-dim);
    font-size: 11px;
  }
  @media (pointer: coarse) {
    .keys {
      display: none;
    }
  }
  /* Phones: messages span the photo instead of floating in its middle. */
  @media (max-width: 599px) {
    .banner,
    .toast {
      left: 8px;
      right: 8px;
      transform: none;
      max-width: none;
    }
    .banner {
      flex-wrap: wrap;
    }
    .card {
      max-width: calc(100% - 24px);
      padding: 16px;
    }
    .saving .card {
      min-width: 0;
      width: calc(100% - 48px);
    }
  }
</style>
