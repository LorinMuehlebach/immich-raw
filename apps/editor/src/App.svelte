<script lang="ts">
  import { DEFAULT_GROUPS, type GroupId, type Recipe } from '@immich-raw/recipe';
  import { onMount } from 'svelte';
  import { badgeFor } from './lib/immich/cull-view.ts';
  import type { CullInfo } from './lib/immich/culler.ts';
  import { PresetStore } from './lib/state/presets.ts';
  import { editor } from './lib/state/editor.svelte.ts';
  import BasicPanel from './lib/ui/BasicPanel.svelte';
  import CalibrationPanel from './lib/ui/CalibrationPanel.svelte';
  import EffectsPanel from './lib/ui/EffectsPanel.svelte';
  import ColorGradingPanel from './lib/ui/ColorGradingPanel.svelte';
  import ColorMixerPanel from './lib/ui/ColorMixerPanel.svelte';
  import ConvertDngDialog from './lib/ui/ConvertDngDialog.svelte';
  import CopySettingsDialog from './lib/ui/CopySettingsDialog.svelte';
  import CropOverlay from './lib/ui/CropOverlay.svelte';
  import CropPanel from './lib/ui/CropPanel.svelte';
  import DetailPanel from './lib/ui/DetailPanel.svelte';
  import Filmstrip from './lib/ui/Filmstrip.svelte';
  import Histogram from './lib/ui/Histogram.svelte';
  import HistoryPanel from './lib/ui/HistoryPanel.svelte';
  import LensPanel from './lib/ui/LensPanel.svelte';
  import TransformPanel from './lib/ui/TransformPanel.svelte';
  import UnsavedDialog from './lib/ui/UnsavedDialog.svelte';
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
  let neighbours = $state<{ prev: string | null; next: string | null }>({ prev: null, next: null });
  // What the culler decided for this photo (shown in the title line).
  let cullInfo = $state<CullInfo | null>(null);
  const cullText = $derived.by(() => {
    const badge = badgeFor(cullInfo);
    if (!cullInfo || !badge) return '';
    if (cullInfo.role === 'best') return `${badge.icon} best of ${cullInfo.groupSize}${cullInfo.pinned ? ' (your pick)' : ''}`;
    if (cullInfo.role === 'runner-up') return `${badge.icon} runner-up (${cullInfo.rank} of ${cullInfo.groupSize})`;
    return `${badge.icon} ${badge.label.toLowerCase()}`;
  });
  const presetStore = new PresetStore();
  // Built by apps/editor/vite.config.ts: our licence, the third-party notices and the source link.
  const LICENSES_URL = `${import.meta.env.BASE_URL}licenses.txt`;

  const PAD = 24;
  const zoomed = $derived(editor.zoom.on && editor.tool !== 'crop');
  const display = $derived.by(() => {
    if (zoomed) return { w: Math.round(stageW), h: Math.round(stageH) };
    const aspect = editor.frame.width / editor.frame.height;
    const maxW = Math.max(50, stageW - PAD * 2);
    const maxH = Math.max(50, stageH - PAD * 2);
    let w = maxW;
    let h = w / aspect;
    if (h > maxH) {
      h = maxH;
      w = h * aspect;
    }
    return { w: Math.round(w), h: Math.round(h) };
  });

  const info = $derived.by(() => {
    const x = editor.asset?.exifInfo;
    if (!x) return '';
    const parts: string[] = [];
    if (x.iso) parts.push(`ISO ${x.iso}`);
    if (x.focalLength) parts.push(`${Math.round(x.focalLength)} mm`);
    if (x.fNumber) parts.push(`ƒ/${x.fNumber}`);
    if (x.exposureTime) parts.push(`${x.exposureTime} s`);
    return parts.join('   ');
  });

  const camera = $derived([editor.asset?.exifInfo?.make, editor.asset?.exifInfo?.model].filter(Boolean).join(' '));

  onMount(() => {
    const ro = new ResizeObserver(([entry]) => {
      stageW = entry!.contentRect.width;
      stageH = entry!.contentRect.height;
      editor.setViewport(stageW, stageH, devicePixelRatio || 1);
    });
    ro.observe(stage);
    editor.load(canvas);
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (!discarding && (editor.dirty || editor.saving)) e.preventDefault();
    };
    addEventListener('beforeunload', beforeUnload);
    return () => {
      ro.disconnect();
      removeEventListener('beforeunload', beforeUnload);
    };
  });

  // Leaving with unsaved changes asks first: Yes saves, No discards, Cancel stays.
  // The target is a function: after saving, "back" points at the new render.
  // back: returning to Immich, which should show the saved render (see editor.waitForRender).
  let leaving = $state<{ target: () => string; back: boolean } | null>(null);
  let leaveSaving = $state(false);
  let discarding = false;

  async function go(target: () => string, back: boolean) {
    if (back) await editor.waitForRender();
    location.href = target();
  }

  function leave(target: () => string, back = false) {
    if (!editor.dirty) void go(target, back);
    else leaving = { target, back };
  }

  async function leaveSave() {
    const l = leaving;
    if (!l) return;
    leaveSaving = true;
    const ok = await editor.save();
    leaveSaving = false;
    leaving = null;
    // A failed save keeps the editor open; the error is shown.
    if (ok) await go(l.target, l.back);
  }

  function leaveDiscard() {
    const l = leaving;
    leaving = null;
    if (!l) return;
    discarding = true;
    void go(l.target, l.back);
  }

  function goBack() {
    leave(() => editor.backUrl(), true);
  }

  function openAsset(id: string) {
    if (id !== editor.asset?.id) leave(() => editor.urlFor(id));
  }

  function isTyping(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) return true;
    return el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'range';
  }

  function onKey(e: KeyboardEvent) {
    if (isTyping(e.target) || copyOpen || editor.dngDialog || leaving) return;
    if (editor.status !== 'ready' || editor.saving) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const onRange = (e.target as HTMLElement | null)?.tagName === 'INPUT';
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
    } else if (mod || e.altKey) {
      return;
    } else if (key === 'w' && e.shiftKey) {
      editor.setTool(editor.tool === 'mask' ? 'edit' : 'mask');
    } else if (key === 'm') {
      editor.startMask(e.shiftKey ? 'radial' : 'linear');
    } else if (key === 'k') {
      editor.startMask('brush');
    } else if ((e.key === '[' || e.key === ']') && editor.painting) {
      // Brush size, in steps that feel even at every size.
      const s = editor.brush.size;
      editor.setBrush({ size: e.key === ']' ? Math.min(100, s + Math.max(1, Math.round(s * 0.12))) : Math.max(1, s - Math.max(1, Math.round(s * 0.12))) });
    } else if (key === 'o' && editor.tool === 'mask') {
      editor.toggleMaskOverlay();
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
    } else if (key === 'z' && editor.tool !== 'crop') {
      editor.toggleZoom();
    } else if (key === 'x' && editor.tool === 'crop') {
      editor.togglePortrait();
    } else if (e.key === 'Enter' && editor.tool === 'crop') {
      editor.setTool('edit');
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !onRange) {
      const id = e.key === 'ArrowLeft' ? neighbours.prev : neighbours.next;
      if (id) openAsset(id);
    } else if (e.key === 'Escape') {
      if (editor.maskDraft) editor.cancelMaskDraft();
      else if (editor.tool !== 'edit') editor.setTool('edit');
      else if (editor.zoom.on) editor.setZoom(false);
      else goBack();
    }
  }

  // ------------------------------------------------------- view: tap / double-tap / pan
  let drag: { id: number; x: number; y: number; moved: boolean } | null = null;
  let lastTap = { t: 0, x: 0, y: 0 };
  /** Targeted adjustment drag (Color Mixer tool). */
  let tat: { id: number; y: number } | null = null;
  let tatHint = $state('');
  let tatHintAt = 0;

  function viewPoint(e: PointerEvent | MouseEvent): [number, number] {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  }

  function onViewDown(e: PointerEvent) {
    if (editor.tool === 'crop' || editor.status !== 'ready' || e.button > 0) return;
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

  function confirmCopy(groups: GroupId[]) {
    copyOpen = false;
    editor.copySettings(groups);
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="app">
  <header class="top">
    <button class="icon back" onclick={goBack} title="Back to Immich (Esc)" aria-label="Back to Immich">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z" /></svg>
    </button>
    <div class="title">
      <div class="name">{editor.asset?.originalFileName ?? 'immich-raw'}</div>
      <div class="sub">
        {camera}
        {#if editor.status === 'ready'}
          {#if editor.fullStatus === 'decoding'}· decoding full resolution…{/if}
          {#if editor.readOnly}· view only{/if}
          {#if editor.recipe.render && !editor.dirty}· saved{/if}
          {#if editor.dirty}· unsaved changes{/if}
          {#if cullText}<span class="cull" class:rejected={cullInfo?.role === 'rejected'}>· {cullText}</span>{/if}
        {/if}
      </div>
    </div>
    <div class="spacer"></div>
    <button class="icon" onclick={() => editor.undo()} disabled={!editor.canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12.5 8c-2.65 0-5.05 1-6.9 2.6L2 7v9h9l-3.62-3.62A7.98 7.98 0 0 1 20.48 16l2.37-.78A10.5 10.5 0 0 0 12.5 8z" /></svg>
    </button>
    <button class="icon" onclick={() => editor.redo()} disabled={!editor.canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M18.4 10.6A10.46 10.46 0 0 0 11.5 8 10.5 10.5 0 0 0 1.15 15.22l2.37.78A8 8 0 0 1 16.62 12.38L13 16h9V7z" /></svg>
    </button>
    <button class:active={zoomed} onclick={() => (zoomed ? editor.setZoom(false) : editor.toggleZoom())} disabled={editor.status !== 'ready' || editor.tool === 'crop'} title="Zoom 100 % (Z, or double-click the photo)">
      {zoomed ? 'Fit' : '1:1'}
    </button>
    <button class:active={editor.before} onclick={() => editor.toggleBefore()} disabled={editor.status !== 'ready'} title="Before / after (\)">Before</button>
    <button class:active={editor.tool === 'crop'} onclick={() => editor.setTool(editor.tool === 'crop' ? 'edit' : 'crop')} disabled={editor.status !== 'ready' || editor.readOnly} title="Crop & straighten (R)">Crop</button>
    <button class:active={editor.tool === 'mask'} onclick={() => editor.setTool(editor.tool === 'mask' ? 'edit' : 'mask')} disabled={editor.status !== 'ready' || editor.readOnly} title="Masking: local adjustments with gradients and ranges (Shift+W)">
      Masks{editor.recipe.masks.length ? ` (${editor.recipe.masks.length})` : ''}
    </button>
    <button onclick={() => editor.openDngDialog()} disabled={editor.status !== 'ready' || editor.readOnly || !!editor.saving} title="Convert to DNG: replaces the original RAW with a smaller DNG">DNG…</button>
    <button class="primary" onclick={() => editor.save()} disabled={editor.status !== 'ready' || editor.readOnly || !!editor.saving || (!editor.dirty && !!editor.recipe.render)} title="Save to Immich (Ctrl+S)">
      {editor.recipe.render ? 'Save' : 'Save to Immich'}
    </button>
    <a class="about" href={LICENSES_URL} target="_blank" rel="noopener" title="immich-raw: licences and source code" aria-label="Licences and source code">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></svg>
    </a>
  </header>

  <aside class="left">
    {#if editor.status === 'ready'}
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
    {/if}
  </aside>

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
          {#if editor.previewUrl}<img class="preview" src={editor.previewUrl} alt="" />{/if}
          <div class="loading">
            <div>{editor.loadingText}</div>
            {#if editor.loadingProgress !== null}
              <div class="bar"><i style:width="{Math.round(editor.loadingProgress * 100)}%"></i></div>
            {/if}
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

      {#if editor.sidecarOffer}
        <div class="banner">
          <div>
            <strong>Lightroom settings found.</strong>
            This RAW's XMP sidecar has {editor.sidecarOffer.applied} settings the editor can apply{editor.sidecarOffer.unmapped ? ` (${editor.sidecarOffer.unmapped} not supported yet)` : ''}.
            {#each editor.sidecarOffer.warnings.slice(0, 3) as w (w)}<div class="dim">{w}</div>{/each}
          </div>
          <button class="primary" onclick={() => editor.applySidecar()}>Apply</button>
          <button onclick={() => editor.dismissSidecar()}>Ignore</button>
        </div>
      {/if}

      {#if editor.saving}
        <div class="saving">
          <div class="card">
            <div>{editor.saving.label}…</div>
            <div class="bar"><i style:width="{Math.round(editor.saving.fraction * 100)}%"></i></div>
          </div>
        </div>
      {/if}

      {#if editor.status === 'ready' && (editor.notice || editor.error || editor.warning)}
        <div class="toast" class:err={!!editor.error}>
          <span>{editor.error ?? editor.notice ?? editor.warning}</span>
          {#if editor.notice && editor.recipe.render && !editor.error && !editor.dirty}
            <button onclick={() => go(() => editor.backUrl(), true)}>Back to Immich</button>
          {/if}
          <button class="icon" aria-label="Dismiss" onclick={() => ((editor.notice = null), (editor.error = null), (editor.warning = null))}>✕</button>
        </div>
      {/if}
    </main>
    {#if editor.status === 'ready' && editor.asset}
      <Filmstrip
        ctx={editor.ctx}
        current={editor.asset}
        onSelect={openAsset}
        onNeighbours={(prev, next) => (neighbours = { prev, next })}
        canCull={!editor.readOnly}
        onCurrentCull={(info) => (cullInfo = info)}
      />
    {/if}
  </section>

  <aside class="side">
    <Histogram histogram={editor.histogram} clipping={editor.clipping} onToggleClipping={() => editor.toggleClipping()} {info} />
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
        <div><kbd>W</kbd> WB picker</div>
        <div><kbd>Z</kbd> / double-click: 1:1</div>
        <div><kbd>←</kbd><kbd>→</kbd> filmstrip</div>
        <div><kbd>Ctrl</kbd>+<kbd>Z</kbd> undo</div>
        <div><kbd>Ctrl</kbd>+<kbd>S</kbd> save</div>
        <div><kbd>Ctrl</kbd>+<kbd>⇧</kbd>+<kbd>C</kbd>/<kbd>V</kbd> copy/paste</div>
        <div><kbd>Alt</kbd>-drag: clipping</div>
        <div><kbd>Ctrl</kbd>+<kbd>U</kbd> auto tone</div>
        <div><kbd>⇧</kbd>+<kbd>W</kbd> masking</div>
        <div><kbd>M</kbd> / <kbd>⇧</kbd>+<kbd>M</kbd> gradients</div>
        <div><kbd>K</kbd> brush, <kbd>[</kbd> <kbd>]</kbd> size</div>
      </div>
    {/if}
  </aside>
</div>

<ConvertDngDialog />

{#if leaving}
  <UnsavedDialog fileName={editor.asset?.originalFileName ?? 'This photo'} busy={leaveSaving} onSave={leaveSave} onDiscard={leaveDiscard} onCancel={() => (leaving = null)} />
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
  }
  .top {
    grid-column: 1 / 4;
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
  .cull.rejected {
    color: var(--danger);
  }
  .sub {
    color: var(--text-dim);
    font-size: 11px;
    white-space: nowrap;
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
    overflow-y: auto;
    min-height: 0;
  }
  .left {
    border-right: 1px solid #111;
  }
  .side {
    border-left: 1px solid #111;
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
  .preview {
    max-width: calc(100% - 48px);
    max-height: calc(100% - 120px);
    opacity: 0.55;
    filter: blur(0.5px);
  }
  .loading {
    color: var(--text);
    text-align: center;
    min-width: 260px;
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
</style>
