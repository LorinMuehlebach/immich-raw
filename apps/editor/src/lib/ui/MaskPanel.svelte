<script lang="ts">
  // Lightroom's Masking panel: create masks, combine their parts, and set each mask's
  // local sliders. Gradients are drawn on the photo, brushes painted, polygons and lassos
  // outlined, colours picked there (see MaskOverlay).
  import {
    AI_TARGET_LABELS,
    BRUSH_DENSITY,
    BRUSH_FEATHER,
    BRUSH_FLOW,
    BRUSH_SIZE,
    COLOR_REFINE,
    COMPONENT_LABELS,
    LANDSCAPE_CLASSES,
    LANDSCAPE_LABELS,
    MAX_COLOR_SAMPLES,
    LOCAL_PARAMS,
    LUMINANCE_SMOOTH,
    MASK_AMOUNT,
    MASK_FEATHER,
    MASK_OFFSET,
    MASK_SMOOTH,
    PERSON_PARTS,
    PERSON_PART_LABELS,
    RADIAL_FEATHER,
    aiLabel,
    componentLabel,
    getPath,
    isMaskRefined,
    isPartRefined,
    type MaskEdge,
    type AiComponent,
    type AiTarget,
    type ComponentKind,
    type LandscapeClass,
    type LocalKey,
    type MaskComponent,
    type MaskMode,
    type ParamSpec,
    type PersonPart,
    type Recipe,
  } from '@immich-raw/recipe';
  import { applyAffine, type PersonInfo } from '@immich-raw/ai';
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
  const KINDS: (ComponentKind | 'lasso')[] = ['brush', 'polygon', 'lasso', 'linear', 'radial', 'color', 'luminance'];
  const kindLabel = (k: ComponentKind | 'lasso') => (k === 'lasso' ? 'Lasso' : COMPONENT_LABELS[k]);
  const AI_TARGETS: AiTarget[] = ['subject', 'sky', 'background', 'people', 'landscape', 'object'];
  const AI_TITLE: Record<AiTarget, string> = {
    subject: 'Select Subject: the main subject of the photo (AI)',
    sky: 'Select Sky (AI)',
    background: 'Select Background: everything but the subject (AI)',
    people: 'People: whole people or parts such as skin, hair, eyes or lips (AI)',
    landscape: 'Landscape: sky, water, vegetation, mountains, buildings, ground or snow (AI)',
    object: 'Objects: drag a box around something on the photo, or click it (AI)',
  };
  /** Menu label of an AI target (People and Landscape open their choices). */
  const aiMenuLabel = (t: AiTarget) => `${AI_TARGET_LABELS[t]}${t === 'people' || t === 'landscape' ? '…' : ''} (AI)`;
  const AI_STATE_TEXT: Record<string, string> = { working: 'working…', empty: 'not found', failed: 'failed' };
  const MB = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;
  const EDGE_ROWS = [
    { key: 'offset', spec: MASK_OFFSET, title: 'Grows (+) or shrinks (−) the selection by this many pixels' },
    { key: 'feather', spec: MASK_FEATHER, title: 'Fades the edge over about this many pixels' },
    { key: 'smooth', spec: MASK_SMOOTH, title: 'Smooths wiggles and specks smaller than this away (a soft gradient becomes a crisp edge)' },
  ] as const;
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
    polygon: 'Click the corners on the photo. Click the first corner, double-click or press Enter to close; Backspace takes back a corner.',
    lasso: 'Drag around the area on the photo; let go to close the shape.',
    color: 'Click the colour to select on the photo, or drag to average an area.',
    object: 'Drag a box around the object on the photo, or click it.',
  };

  const sel = $derived(editor.selectedMask);
  const comp = $derived(editor.selectedComponent);

  // A People part's "who" list needs the people found in the photo.
  $effect(() => {
    if (comp?.kind === 'ai' && comp.target === 'people' && comp.person) void editor.ai.findPeople();
  });
  let renaming = $state<string | null>(null);
  let nameText = $state('');
  /** Mask or part whose edge settings (gear) are open. */
  let edgeOpen = $state<string | null>(null);

  /** Opens or closes a mask's (compId absent) or a part's edge settings, and selects it. */
  function toggleEdge(maskId: string, compId?: string) {
    const id = compId ?? maskId;
    if (edgeOpen === id) {
      edgeOpen = null;
      return;
    }
    edgeOpen = id;
    editor.selectMask(maskId, compId);
  }

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
    const value = e.currentTarget.value;
    e.currentTarget.value = '';
    if (!value || !sel) return;
    if (value.startsWith('ai:')) editor.startAiMask(value.slice(3) as AiTarget, mode, sel.id);
    else editor.startMask(value as ComponentKind | 'lasso', mode, sel.id);
  }

  const toggle = <T,>(list: T[], item: T, on: boolean): T[] => (on ? [...list, item] : list.filter((x) => x !== item));
  const ordered = <T extends string>(all: T[], list: T[]) => all.filter((x) => list.includes(x));
  const partLabel = (c: MaskComponent) => componentLabel(c);

  /** Index in ai.people of the person an AI part selects (-1 = everyone). */
  function whoIndex(c: AiComponent, people: PersonInfo[] | null): number {
    if (!c.person || !people?.length) return -1;
    const photo = editor.ai.current();
    const s = editor.renderer?.maskToSource(c.person.x, c.person.y, $state.snapshot(editor.recipe) as Recipe);
    if (!s || !photo) return -1;
    // Compare in the analysis image, where the people were found.
    const t = applyAffine(photo.sToT, s[0], s[1]);
    let best = -1;
    let bd = Infinity;
    people.forEach((p, i) => {
      const d = Math.hypot(t[0] - p.at[0], t[1] - p.at[1]);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  /** Draws a person's face (or box) from the analysis image into a small canvas. */
  function personThumb(canvas: HTMLCanvasElement, p: PersonInfo) {
    const draw = (q: PersonInfo) => {
      const img = editor.ai.current()?.image;
      const ctx = canvas.getContext('2d');
      if (!img || !ctx) return;
      const [x0, y0, x1, y1] = q.box;
      const side = Math.max((x1 - x0) * img.width, (y1 - y0) * img.height) * 1.3;
      const cx = ((x0 + x1) / 2) * img.width;
      const cy = ((y0 + y1) / 2) * img.height;
      createImageBitmap(img, Math.max(0, Math.round(cx - side / 2)), Math.max(0, Math.round(cy - side / 2)), Math.max(1, Math.round(side)), Math.max(1, Math.round(side)))
        .then((bmp) => {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
          bmp.close();
        })
        .catch(() => {});
    };
    draw(p);
    return { update: draw };
  }

  const compValue = (c: MaskComponent, spec: ParamSpec) => getPath(c, spec.path) as number;
  const setComp = (c: MaskComponent, spec: ParamSpec) => (v: number) =>
    sel && editor.updateComponent(sel.id, c.id, { [spec.path]: Math.round(v) } as Partial<MaskComponent>, false, `${sel.name}: ${spec.label} ${Math.round(v)}`);
</script>

{#snippet gear(id: string, set: boolean, title: string, onclick: () => void)}
  <button class="icon small gear" class:open={edgeOpen === id} class:set {onclick} {title} aria-label={title} aria-expanded={edgeOpen === id}>
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" stroke-width="3" stroke-dasharray="3.34 3.34" />
      <circle cx="12" cy="12" r="5.5" stroke-width="3.5" />
    </svg>
  </button>
{/snippet}

<!-- Offset, Feather and Smooth of a part (compId) or of the whole mask (compId null). -->
{#snippet edgePanel(maskId: string, compId: string | null, e: MaskEdge | undefined, title: string)}
  <div class="edge">
    <div class="sub" title="In pixels of the full-size photo">{title}</div>
    {#each EDGE_ROWS as row (row.key)}
      <div title={row.title}>
        <Slider
          spec={row.spec}
          value={e?.[row.key] ?? 0}
          onchange={(v) => editor.setEdge(maskId, compId, row.spec, v)}
          oncommit={() => editor.commit()}
          onreset={() => editor.setEdge(maskId, compId, row.spec, 0, true)}
          disabled={editor.readOnly}
        />
      </div>
    {/each}
  </div>
{/snippet}

<Section title="Masking">
  {#snippet actions()}
    {@const held = editor.maskOverlay && editor.maskEditing === 'adjust'}
    <label
      class="overlay"
      class:held
      title={held
        ? 'The red overlay is hidden while the mask parameters are active; click the mask settings (or press O) to show it'
        : 'Show the selected mask in red while the mask settings are active; it hides while you work on the mask parameters (O)'}
    >
      <input type="checkbox" checked={editor.maskOverlay} onchange={(e) => editor.setMaskOverlay(e.currentTarget.checked)} />
      Overlay
    </label>
  {/snippet}

  <!-- Mask settings: clicking anywhere here shows the red overlay. -->
  <div class="area" class:active={editor.maskEditing === 'shape'} role="group" aria-label="Mask settings" onpointerdown={() => editor.setMaskEditing('shape')}>
  <div class="area-head">Mask settings{#if editor.maskEditing === 'shape' && editor.maskOverlay}<span class="badge">red overlay</span>{/if}</div>
  <div class="create">
    <span class="lbl">New mask</span>
    <button class:active={editor.maskDraft?.kind === 'linear' && !editor.maskDraft.maskId} onclick={() => editor.startMask('linear')} disabled={editor.readOnly} title="Linear gradient (M): drag on the photo from full effect to none">Linear</button>
    <button class:active={editor.maskDraft?.kind === 'radial' && !editor.maskDraft.maskId} onclick={() => editor.startMask('radial')} disabled={editor.readOnly} title="Radial gradient (Shift+M): drag on the photo from the centre out">Radial</button>
    <button class:active={editor.maskDraft?.kind === 'brush' && !editor.maskDraft.maskId} onclick={() => editor.startMask('brush')} disabled={editor.readOnly} title="Brush (K): paint the mask on the photo">Brush</button>
    <button class:active={editor.maskDraft?.kind === 'polygon' && !editor.maskDraft.maskId} onclick={() => editor.startMask('polygon')} disabled={editor.readOnly} title="Polygon (Shift+K): click the corners of the area on the photo">Polygon</button>
    <button class:active={editor.maskDraft?.kind === 'lasso' && !editor.maskDraft.maskId} onclick={() => editor.startMask('lasso')} disabled={editor.readOnly} title="Lasso: drag around the area on the photo">Lasso</button>
    <button class:active={editor.maskDraft?.kind === 'color' && !editor.maskDraft.maskId} onclick={() => editor.startMask('color')} disabled={editor.readOnly} title="Color range: select by colour">Color</button>
    <button onclick={() => editor.startMask('luminance')} disabled={editor.readOnly} title="Luminance range: select by brightness">Luminance</button>
  </div>
  <div class="create ai">
    <span class="lbl">AI</span>
    {#each AI_TARGETS as t (t)}
      <button
        class:active={(t === 'object' && editor.maskDraft?.kind === 'object' && !editor.maskDraft.maskId) || (editor.aiPicker?.target === t && !editor.aiPicker.maskId)}
        onclick={() => editor.startAiMask(t)}
        disabled={editor.readOnly}
        title={AI_TITLE[t]}>{t === 'object' ? 'Objects' : AI_TARGET_LABELS[t]}{t === 'people' || t === 'landscape' ? '…' : ''}</button
      >
    {/each}
  </div>
  {#if editor.maskDraft}
    <div class="hint">
      {DRAFT_HINT[editor.maskDraft.kind]}
      <button class="small" onclick={() => editor.cancelMaskDraft()}>Cancel</button>
    </div>
  {/if}
  {#if editor.aiPicker}
    {@const p = editor.aiPicker}
    <div class="picker">
      <div class="sub">{p.target === 'people' ? 'People' : 'Landscape'}{p.maskId ? ` · ${MODE_LABEL[p.mode]}` : ''}</div>
      {#if p.target === 'people'}
        <div class="who">
          <label><input type="radio" name="ai-who" checked={p.who === -1} onchange={() => editor.setAiPicker({ who: -1 })} /> Everyone</label>
          {#if editor.ai.people}
            {#each editor.ai.people as person, i (i)}
              <label class="person" title="Person {i + 1}">
                <input type="radio" name="ai-who" checked={p.who === i} onchange={() => editor.setAiPicker({ who: i })} />
                <canvas width="40" height="40" use:personThumb={person}></canvas>
              </label>
            {/each}
            {#if !editor.ai.people.length}<span class="note">No people found.</span>{/if}
          {:else if editor.ai.peopleError}
            <span class="note error">{editor.ai.peopleError}</span>
          {:else}
            <span class="note">Finding people…</span>
          {/if}
        </div>
        <div class="checks">
          {#each PERSON_PARTS as part (part)}
            <label><input type="checkbox" checked={p.parts.includes(part)} onchange={(e) => editor.setAiPicker({ parts: ordered(PERSON_PARTS, toggle(p.parts, part, e.currentTarget.checked)) })} /> {PERSON_PART_LABELS[part]}</label>
          {/each}
        </div>
      {:else}
        <div class="checks">
          {#each LANDSCAPE_CLASSES as k (k)}
            <label><input type="checkbox" checked={p.classes.includes(k)} onchange={(e) => editor.setAiPicker({ classes: ordered(LANDSCAPE_CLASSES, toggle(p.classes, k, e.currentTarget.checked)) })} /> {LANDSCAPE_LABELS[k]}</label>
          {/each}
        </div>
      {/if}
      <div class="row">
        <button onclick={() => editor.confirmAiPicker()} disabled={p.target === 'people' ? !p.parts.length : !p.classes.length}>Create mask</button>
        <button class="small" onclick={() => editor.cancelMaskDraft()}>Cancel</button>
      </div>
    </div>
  {/if}
  {#if editor.ai.progress}
    {@const pr = editor.ai.progress}
    <div class="progress">
      {pr.kind === 'download' ? `Downloading the ${pr.label}: ${MB(pr.loaded)} of ${MB(pr.total)}` : pr.label}
      {#if pr.kind === 'download'}<progress max={pr.total} value={pr.loaded}></progress>{/if}
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
          {@render gear(m.id, isMaskRefined(m), 'Edge of the whole mask: offset, feather, smooth', () => toggleEdge(m.id))}
          <button class="icon small del" onclick={() => editor.deleteMask(m.id)} disabled={editor.readOnly} title="Delete mask" aria-label="Delete mask">✕</button>
        </div>
        {#if edgeOpen === m.id}
          {@render edgePanel(m.id, null, m.edge, 'Edge of the whole mask')}
        {/if}
        {#if m.id === sel?.id}
          <ul class="parts">
            {#each m.components as c, i (c.id)}
              <li class:current={c.id === comp?.id}>
                <div class="part-row">
                  <button class="part" onclick={() => editor.selectMask(m.id, c.id)}>
                    <span class="mode">{i === 0 ? '' : MODE_LABEL[c.mode]}</span>
                    {partLabel(c)}{c.invert ? ' (inverted)' : ''}
                    {#if c.kind === 'ai' && editor.ai.status[c.id] && editor.ai.status[c.id]!.state !== 'ready'}
                      <span class="ai-state {editor.ai.status[c.id]!.state}">{AI_STATE_TEXT[editor.ai.status[c.id]!.state]}</span>
                    {/if}
                  </button>
                  {@render gear(c.id, isPartRefined(c), `Edge of this part: offset, feather, smooth`, () => toggleEdge(m.id, c.id))}
                  <button class="icon small del" onclick={() => editor.deleteComponent(m.id, c.id)} disabled={editor.readOnly} title="Remove this part" aria-label="Remove part">✕</button>
                </div>
                {#if edgeOpen === c.id}
                  {@render edgePanel(m.id, c.id, c.edge, `Edge of ${partLabel(c)}`)}
                {/if}
              </li>
            {/each}
          </ul>
          <div class="ops">
            {#each [['add', 'Add…', 'Add to mask'], ['subtract', 'Subtract…', 'Subtract from mask'], ['intersect', 'Intersect…', 'Intersect mask with']] as [mode, label, aria] (mode)}
              <select onchange={(e) => addPart(e, mode as MaskMode)} disabled={editor.readOnly} aria-label={aria}>
                <option value="">{label}</option>
                {#each KINDS as k (k)}<option value={k}>{kindLabel(k)}</option>{/each}
                <optgroup label="AI">
                  {#each AI_TARGETS as t (t)}<option value="ai:{t}">{aiMenuLabel(t)}</option>{/each}
                </optgroup>
              </select>
            {/each}
          </div>
        {/if}
      </li>
    {/each}
  </ul>

  {#if sel && comp}
    <div class="group">
      <div class="sub">
        {partLabel(comp)}
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
      {:else if comp.kind === 'polygon'}
        <Slider
          spec={MASK_FEATHER}
          value={comp.edge?.feather ?? 0}
          onchange={(v) => editor.setEdge(sel.id, comp.id, MASK_FEATHER, v)}
          oncommit={() => editor.commit()}
          onreset={() => editor.setEdge(sel.id, comp.id, MASK_FEATHER, 0, true)}
          disabled={editor.readOnly}
        />
        <p class="note">
          {#if comp.freehand}
            Drag the pin to move the lasso.
          {:else}
            {comp.points.length / 2} corners. Drag a corner to move it, drag an edge to add one, Alt+click a corner to remove it; the pin moves the whole shape.
          {/if}
          Feather softens the edge (in pixels of the full-size photo).
        </p>
      {:else if comp.kind === 'brush'}
        <p class="note">{comp.strokes.length} stroke{comp.strokes.length === 1 ? '' : 's'}. Paint on the photo to add, hold Alt (or tick Erase) to remove.</p>
      {:else if comp.kind === 'ai'}
        {@const st = editor.ai.status[comp.id]}
        {#if st?.state === 'working'}
          <p class="note">Working… The models run in this browser; the first time they are downloaded once.</p>
        {:else if st?.state === 'empty'}
          <p class="note">{st.message}</p>
        {:else if st?.state === 'failed'}
          <p class="note error">{st.message} <button class="small" onclick={() => editor.ai.retry()}>Retry</button></p>
        {/if}
        {#if comp.target === 'people'}
          <div class="who">
            <select
              value={whoIndex(comp, editor.ai.people)}
              onchange={(e) => editor.setAiComponent(sel.id, comp.id, { who: Number(e.currentTarget.value) })}
              disabled={editor.readOnly}
              aria-label="Who"
            >
              <option value={-1}>Everyone</option>
              {#each editor.ai.people ?? [] as _, i (i)}<option value={i}>Person {i + 1}</option>{/each}
            </select>
          </div>
          <div class="checks">
            {#each PERSON_PARTS as part (part)}
              {@const parts = comp.parts ?? (['person'] as PersonPart[])}
              <label
                ><input
                  type="checkbox"
                  checked={parts.includes(part)}
                  disabled={editor.readOnly || (parts.length === 1 && parts[0] === part)}
                  onchange={(e) => editor.setAiComponent(sel.id, comp.id, { parts: ordered(PERSON_PARTS, toggle(parts, part, e.currentTarget.checked)) })}
                /> {PERSON_PART_LABELS[part]}</label
              >
            {/each}
          </div>
        {:else if comp.target === 'landscape'}
          <div class="checks">
            {#each LANDSCAPE_CLASSES as k (k)}
              {@const classes = comp.classes ?? ([] as LandscapeClass[])}
              <label
                ><input
                  type="checkbox"
                  checked={classes.includes(k)}
                  disabled={editor.readOnly || (classes.length === 1 && classes[0] === k)}
                  onchange={(e) => editor.setAiComponent(sel.id, comp.id, { classes: ordered(LANDSCAPE_CLASSES, toggle(classes, k, e.currentTarget.checked)) })}
                /> {LANDSCAPE_LABELS[k]}</label
              >
            {/each}
          </div>
        {:else if comp.target === 'object'}
          <p class="note">{comp.box ? 'The object found inside the box you drew.' : 'Shift+click the photo to add more points on the object.'}</p>
        {:else}
          <p class="note">Found by AI. Copied to another photo or saved in a preset, it is found again on that photo.</p>
        {/if}
      {:else}
        <p class="note">Drag the square handles to change where the gradient starts and ends; the round handle rotates it.</p>
      {/if}
    </div>
  {/if}
  </div>

  {#if sel}
    <!-- Mask parameters: clicking anywhere here hides the red overlay, to show the result. -->
    <div class="area" class:active={editor.maskEditing === 'adjust'} role="group" aria-label="Mask parameters" onpointerdown={() => editor.setMaskEditing('adjust')}>
    <div class="area-head">
      Mask parameters · {sel.name}
      <button class="small reset" onclick={() => editor.resetMaskAdjust()} disabled={editor.readOnly}>Reset sliders</button>
    </div>
    <div class="group first">
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
    </div>
  {/if}
</Section>

<style>
  .create {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .create button {
    flex: 1 0 auto;
    padding: 4px 4px;
  }
  .lbl {
    color: var(--text-dim);
    font-size: 11px;
    white-space: nowrap;
  }
  .create.ai {
    flex-wrap: wrap;
    margin-top: 6px;
  }
  .create.ai .lbl {
    min-width: 46px;
  }
  .create.ai button {
    flex: 1 0 auto;
  }
  .picker {
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 4px 8px 8px;
    margin-top: 8px;
  }
  .checks {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2px 8px;
    font-size: 12px;
    margin: 4px 0;
  }
  .checks label,
  .who label {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .who {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin: 4px 0;
    font-size: 12px;
  }
  .person canvas {
    width: 32px;
    height: 32px;
    border-radius: 4px;
    display: block;
    background: var(--bg);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
  }
  .progress {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-top: 8px;
    font-size: 11px;
    color: var(--text-dim);
  }
  .progress progress {
    width: 100%;
    height: 6px;
  }
  .ai-state {
    margin-left: 6px;
    font-size: 10px;
    color: var(--text-dim);
  }
  .ai-state.working {
    color: var(--accent);
  }
  .ai-state.failed,
  .note.error {
    color: #e57373;
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
  .part-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  /* The two areas: mask settings (shape: red overlay) and mask parameters (adjustments). */
  .area {
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 6px 8px 8px;
    margin-top: 8px;
  }
  .area.active {
    border-color: var(--accent);
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .area-head {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-dim);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 6px;
  }
  .area.active .area-head {
    color: var(--text-bright);
  }
  .area-head .reset {
    margin-left: auto;
    text-transform: none;
    letter-spacing: 0;
    font-weight: normal;
  }
  .badge {
    font-weight: normal;
    text-transform: none;
    letter-spacing: 0;
    color: #e57373;
  }
  .group.first {
    margin-top: 0;
  }
  .gear {
    padding: 1px 4px;
    opacity: 0.55;
  }
  .gear.set {
    opacity: 1;
    color: var(--accent);
  }
  .gear.open {
    opacity: 1;
    background: rgba(255, 255, 255, 0.08);
  }
  .edge {
    border-left: 2px solid var(--accent);
    padding: 0 0 4px 8px;
    margin: 2px 0 6px 4px;
  }
  .edge .sub {
    margin-top: 2px;
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
  /* Wanted, but hidden while the mask's adjustments are edited. */
  .overlay.held {
    opacity: 0.55;
  }
  .small {
    padding: 2px 8px;
    font-size: 11px;
  }
</style>
