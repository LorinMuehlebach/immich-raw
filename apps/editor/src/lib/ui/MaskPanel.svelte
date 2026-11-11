<script lang="ts">
  // Lightroom's Masking panel: create masks, combine their parts, and set each mask's
  // local sliders. Gradients are drawn on the photo, brushes painted, colours picked there
  // (see MaskOverlay).
  import {
    BRUSH_DENSITY,
    BRUSH_FEATHER,
    BRUSH_FLOW,
    BRUSH_SIZE,
    COLOR_REFINE,
    COMPONENT_LABELS,
    MAX_COLOR_SAMPLES,
    LOCAL_PARAMS,
    LUMINANCE_SMOOTH,
    MASK_AMOUNT,
    RADIAL_FEATHER,
    getPath,
    type ComponentKind,
    type LocalKey,
    type MaskComponent,
    type MaskMode,
    type ParamSpec,
  } from '@immich-raw/recipe';
  import { editor } from '../state/editor.svelte.ts';
  import Section from './Section.svelte';
  import Slider from './Slider.svelte';

  const GROUPS: { title: string; keys: LocalKey[] }[] = [
    { title: 'Light', keys: ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'] },
    { title: 'Color', keys: ['temp', 'tint', 'hue', 'saturation'] },
    { title: 'Effects', keys: ['texture', 'clarity', 'dehaze'] },
    { title: 'Detail', keys: ['sharpness'] },
  ];
  const TRACK: Partial<Record<LocalKey, string>> = {
    temp: 'linear-gradient(90deg, #3d6fd6, #d8d8d8 50%, #e0b43a)',
    tint: 'linear-gradient(90deg, #3fae49, #d8d8d8 50%, #c44fc4)',
    colorHue: 'linear-gradient(90deg, #e33, #ee3 17%, #3e3 33%, #3ee 50%, #33e 67%, #e3e 83%, #e33)',
  };
  const RANGE_LO: ParamSpec = { path: 'lo', label: 'Range from', min: 0, max: 100, default: 50, step: 1, decimals: 0, signed: false };
  const RANGE_HI: ParamSpec = { path: 'hi', label: 'Range to', min: 0, max: 100, default: 100, step: 1, decimals: 0, signed: false };
  const MODE_LABEL: Record<MaskMode, string> = { add: 'Add', subtract: 'Subtract', intersect: 'Intersect' };
  const KINDS: ComponentKind[] = ['brush', 'linear', 'radial', 'color', 'luminance'];
  const BRUSH_ROWS = [
    { key: 'size', spec: BRUSH_SIZE },
    { key: 'feather', spec: BRUSH_FEATHER },
    { key: 'flow', spec: BRUSH_FLOW },
    { key: 'density', spec: BRUSH_DENSITY },
  ] as const;
  const DRAFT_HINT: Record<string, string> = {
    linear: 'Drag on the photo to draw the linear gradient.',
    radial: 'Drag on the photo to draw the radial gradient (Shift: circle).',
    brush: 'Paint on the photo. Alt erases; [ and ] change the size.',
    color: 'Click the colour to select on the photo, or drag to average an area.',
  };

  const sel = $derived(editor.selectedMask);
  const comp = $derived(editor.selectedComponent);
  let renaming = $state<string | null>(null);
  let nameText = $state('');

  function startRename(id: string, name: string) {
    if (editor.readOnly) return;
    renaming = id;
    nameText = name;
  }

  function finishRename(apply: boolean) {
    if (apply && renaming) editor.renameMask(renaming, nameText);
    renaming = null;
  }

  function focusSelect(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  function addPart(e: Event & { currentTarget: HTMLSelectElement }, mode: MaskMode) {
    const kind = e.currentTarget.value as ComponentKind | '';
    e.currentTarget.value = '';
    if (kind && sel) editor.startMask(kind, mode, sel.id);
  }

  const compValue = (c: MaskComponent, spec: ParamSpec) => getPath(c, spec.path) as number;
  const setComp = (c: MaskComponent, spec: ParamSpec) => (v: number) =>
    sel && editor.updateComponent(sel.id, c.id, { [spec.path]: Math.round(v) } as Partial<MaskComponent>, false, `${sel.name}: ${spec.label} ${Math.round(v)}`);
</script>

<Section title="Masking">
  {#snippet actions()}
    <label class="overlay" title="Show the selected mask in red (O)">
      <input type="checkbox" checked={editor.maskOverlay} onchange={() => editor.toggleMaskOverlay()} />
      Overlay
    </label>
  {/snippet}

  <div class="create">
    <span class="lbl">New mask</span>
    <button class:active={editor.maskDraft?.kind === 'linear' && !editor.maskDraft.maskId} onclick={() => editor.startMask('linear')} disabled={editor.readOnly} title="Linear gradient (M): drag on the photo from full effect to none">Linear</button>
    <button class:active={editor.maskDraft?.kind === 'radial' && !editor.maskDraft.maskId} onclick={() => editor.startMask('radial')} disabled={editor.readOnly} title="Radial gradient (Shift+M): drag on the photo from the centre out">Radial</button>
    <button class:active={editor.maskDraft?.kind === 'brush' && !editor.maskDraft.maskId} onclick={() => editor.startMask('brush')} disabled={editor.readOnly} title="Brush (K): paint the mask on the photo">Brush</button>
    <button class:active={editor.maskDraft?.kind === 'color' && !editor.maskDraft.maskId} onclick={() => editor.startMask('color')} disabled={editor.readOnly} title="Color range: select by colour">Color</button>
    <button onclick={() => editor.startMask('luminance')} disabled={editor.readOnly} title="Luminance range: select by brightness">Luminance</button>
  </div>
  {#if editor.maskDraft}
    <div class="hint">
      {DRAFT_HINT[editor.maskDraft.kind]}
      <button class="small" onclick={() => editor.cancelMaskDraft()}>Cancel</button>
    </div>
  {/if}
  {#if editor.painting || editor.maskDraft?.kind === 'brush'}
    <div class="group">
      <div class="sub">
        Brush
        <label class="invert"><input type="checkbox" checked={editor.brush.erase} onchange={(e) => editor.setBrush({ erase: e.currentTarget.checked })} /> Erase</label>
      </div>
      {#each BRUSH_ROWS as row (row.key)}
        <Slider
          spec={row.spec}
          value={editor.brush[row.key]}
          onchange={(v) => editor.setBrush({ [row.key]: v })}
          oncommit={() => {}}
          onreset={() => editor.setBrush({ [row.key]: row.spec.default })}
          disabled={editor.readOnly}
        />
      {/each}
    </div>
  {/if}

  {#if editor.recipe.masks.length === 0 && !editor.maskDraft}
    <p class="empty">Masks apply adjustments to part of the photo: a gradient across the sky, a soft circle around a face, or only the bright tones.</p>
  {/if}

  <ul class="masks">
    {#each editor.recipe.masks as m (m.id)}
      <li class:selected={m.id === sel?.id}>
        <div class="mask-row">
          <button class="icon eye" class:off={!m.visible} onclick={() => editor.toggleMaskVisible(m.id)} title={m.visible ? 'Hide this mask\'s effect' : 'Show this mask\'s effect'} aria-label="Toggle mask">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 5C6.5 5 2.7 9.6 1.5 12c1.2 2.4 5 7 10.5 7s9.3-4.6 10.5-7C21.3 9.6 17.5 5 12 5zm0 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9zm0-2.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" /></svg>
          </button>
          {#if renaming === m.id}
            <input
              class="rename"
              bind:value={nameText}
              use:focusSelect
              onkeydown={(e) => (e.key === 'Enter' ? finishRename(true) : e.key === 'Escape' ? finishRename(false) : null)}
              onblur={() => finishRename(true)}
            />
          {:else}
            <button class="name" onclick={() => editor.selectMask(m.id)} ondblclick={() => startRename(m.id, m.name)} title="Click to select, double-click to rename">{m.name}</button>
          {/if}
          <button class="icon small del" onclick={() => editor.deleteMask(m.id)} disabled={editor.readOnly} title="Delete mask" aria-label="Delete mask">✕</button>
        </div>
        {#if m.id === sel?.id}
          <ul class="parts">
            {#each m.components as c, i (c.id)}
              <li class:current={c.id === comp?.id}>
                <button class="part" onclick={() => editor.selectMask(m.id, c.id)}>
                  <span class="mode">{i === 0 ? '' : MODE_LABEL[c.mode]}</span>
                  {COMPONENT_LABELS[c.kind]}{c.invert ? ' (inverted)' : ''}
                </button>
                <button class="icon small del" onclick={() => editor.deleteComponent(m.id, c.id)} disabled={editor.readOnly} title="Remove this part" aria-label="Remove part">✕</button>
              </li>
            {/each}
          </ul>
          <div class="ops">
            <select onchange={(e) => addPart(e, 'add')} disabled={editor.readOnly} aria-label="Add to mask">
              <option value="">Add…</option>
              {#each KINDS as k (k)}<option value={k}>{COMPONENT_LABELS[k]}</option>{/each}
            </select>
            <select onchange={(e) => addPart(e, 'subtract')} disabled={editor.readOnly} aria-label="Subtract from mask">
              <option value="">Subtract…</option>
              {#each KINDS as k (k)}<option value={k}>{COMPONENT_LABELS[k]}</option>{/each}
            </select>
            <select onchange={(e) => addPart(e, 'intersect')} disabled={editor.readOnly} aria-label="Intersect mask with">
              <option value="">Intersect…</option>
              {#each KINDS as k (k)}<option value={k}>{COMPONENT_LABELS[k]}</option>{/each}
            </select>
          </div>
        {/if}
      </li>
    {/each}
  </ul>

  {#if sel && comp}
    <div class="group">
      <div class="sub">
        {COMPONENT_LABELS[comp.kind]}
        <label class="invert"><input type="checkbox" checked={comp.invert} onchange={() => editor.invertComponent(sel.id, comp.id)} disabled={editor.readOnly} /> Invert</label>
      </div>
      {#if comp.kind === 'radial'}
        <Slider spec={RADIAL_FEATHER} value={comp.feather} onchange={setComp(comp, RADIAL_FEATHER)} oncommit={() => editor.commit()} onreset={() => setComp(comp, RADIAL_FEATHER)(50)} disabled={editor.readOnly} />
      {:else if comp.kind === 'luminance'}
        {#each [RANGE_LO, RANGE_HI, LUMINANCE_SMOOTH] as spec (spec.path)}
          <Slider {spec} value={compValue(comp, spec)} onchange={setComp(comp, spec)} oncommit={() => editor.commit()} onreset={() => setComp(comp, spec)(spec.default)} disabled={editor.readOnly} />
        {/each}
      {:else if comp.kind === 'color'}
        <Slider spec={COLOR_REFINE} value={comp.refine} onchange={setComp(comp, COLOR_REFINE)} oncommit={() => editor.commit()} onreset={() => setComp(comp, COLOR_REFINE)(50)} disabled={editor.readOnly} />
        <p class="note">Click the photo to pick a colour; Shift+click adds one (up to {MAX_COLOR_SAMPLES}); drag to average an area.</p>
        {#if comp.samples.length}
          <div class="samples">
            {#each comp.samples as _, i (i)}
              <button class="small" onclick={() => editor.removeColorSample(i)} disabled={editor.readOnly} title="Remove this colour">Colour {i + 1} ✕</button>
            {/each}
          </div>
        {/if}
      {:else if comp.kind === 'brush'}
        <p class="note">{comp.strokes.length} stroke{comp.strokes.length === 1 ? '' : 's'}. Paint on the photo to add, hold Alt (or tick Erase) to remove.</p>
      {:else}
        <p class="note">Drag the square handles to change where the gradient starts and ends; the round handle rotates it.</p>
      {/if}
    </div>
  {/if}

  {#if sel}
    <div class="group">
      <div class="sub">
        {sel.name}
        <button class="small reset" onclick={() => editor.resetMaskAdjust()} disabled={editor.readOnly}>Reset sliders</button>
      </div>
      <Slider spec={MASK_AMOUNT} value={sel.amount} onchange={(v) => editor.setMaskParam(MASK_AMOUNT, v)} oncommit={() => editor.commit()} onreset={() => editor.setMaskParam(MASK_AMOUNT, 100, true)} disabled={editor.readOnly} />
    </div>
    {#each GROUPS as g (g.title)}
      <div class="group">
        <div class="sub">{g.title}</div>
        {#each g.keys as k (k)}
          {@const spec = LOCAL_PARAMS[k]}
          <Slider
            {spec}
            value={sel.adjust[k]}
            track={TRACK[k] ?? ''}
            onchange={(v) => editor.setMaskParam(spec, v)}
            oncommit={() => editor.commit()}
            onreset={() => editor.setMaskParam(spec, 0, true)}
            disabled={editor.readOnly}
          />
        {/each}
        {#if g.title === 'Color'}
          {#each [LOCAL_PARAMS.colorHue, LOCAL_PARAMS.colorSat] as spec (spec.path)}
            <Slider
              {spec}
              value={editor.maskValue(spec)}
              track={TRACK.colorHue && spec === LOCAL_PARAMS.colorHue ? TRACK.colorHue : ''}
              onchange={(v) => editor.setMaskParam(spec, v)}
              oncommit={() => editor.commit()}
              onreset={() => editor.setMaskParam(spec, 0, true)}
              disabled={editor.readOnly}
            />
          {/each}
        {/if}
      </div>
    {/each}
  {/if}
</Section>

<style>
  .create {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .create button {
    flex: 1;
    padding: 4px 4px;
  }
  .lbl {
    color: var(--text-dim);
    font-size: 11px;
    white-space: nowrap;
  }
  .hint,
  .empty,
  .note {
    color: var(--text-dim);
    font-size: 11px;
    margin: 8px 0 0;
  }
  .samples {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 4px;
  }
  .hint {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--accent);
  }
  .masks,
  .parts {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
  }
  .masks > li {
    border: 1px solid transparent;
    border-radius: 5px;
    padding: 2px 4px;
  }
  .masks > li.selected {
    border-color: var(--line);
    background: rgba(255, 255, 255, 0.03);
  }
  .mask-row,
  .parts li {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .name,
  .part {
    flex: 1;
    text-align: left;
    background: none;
    border: none;
    padding: 3px 4px;
    color: var(--text);
  }
  .selected .name {
    color: var(--text-bright);
    font-weight: 600;
  }
  .parts {
    margin: 0 0 4px 22px;
  }
  .parts li.current .part {
    color: var(--accent);
  }
  .mode {
    display: inline-block;
    min-width: 54px;
    color: var(--text-dim);
    font-size: 11px;
  }
  .rename {
    flex: 1;
    font: inherit;
    color: var(--text-bright);
    background: var(--bg);
    border: 1px solid var(--accent);
    border-radius: 3px;
    padding: 2px 4px;
  }
  .eye.off {
    opacity: 0.35;
  }
  .del {
    padding: 1px 5px;
    opacity: 0.7;
  }
  .ops {
    display: flex;
    gap: 4px;
    margin: 0 0 4px 22px;
  }
  .ops select {
    flex: 1;
    min-width: 0;
  }
  .group {
    margin-top: 10px;
  }
  .sub {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-dim);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 4px 0 2px;
  }
  .sub .reset,
  .sub .invert {
    margin-left: auto;
    text-transform: none;
    letter-spacing: 0;
  }
  .invert {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .overlay {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--text);
  }
  .small {
    padding: 2px 8px;
    font-size: 11px;
  }
</style>
