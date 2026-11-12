<script lang="ts">
  import { parametricCurve, pointCurve } from '@immich-raw/pipeline';
  import { CURVE_CHANNELS, PARAMS, type CurveChannel, type ParamSpec } from '@immich-raw/recipe';
  import { editor } from '../state/editor.svelte.ts';
  import CurveEditor from './CurveEditor.svelte';
  import Section from './Section.svelte';
  import Slider from './Slider.svelte';

  let mode = $state<'parametric' | 'point'>('parametric');
  let channel = $state<CurveChannel>('master');

  const COLOR: Record<CurveChannel, string> = { master: '#e6e6e6', red: '#ff6b6b', green: '#6bd47b', blue: '#6b9bff' };
  const LABEL: Record<CurveChannel, string> = { master: 'RGB', red: 'Red', green: 'Green', blue: 'Blue' };
  const regions: ParamSpec[] = [PARAMS.curveHighlights, PARAMS.curveLights, PARAMS.curveDarks, PARAMS.curveShadows];
  const splitsSpecs: ParamSpec[] = [PARAMS.curveShadowSplit, PARAMS.curveMidtoneSplit, PARAMS.curveHighlightSplit];

  const tc = $derived(editor.recipe.toneCurve);
  const param = $derived(parametricCurve(tc.parametric));
  const shown = $derived.by(() => {
    if (mode === 'parametric') return param;
    const master = pointCurve(tc.point.master);
    if (channel === 'master') return (x: number) => master(param(x));
    const ch = pointCurve(tc.point[channel]);
    return (x: number) => ch(x);
  });

  const lumaHist = $derived.by(() => {
    const h = editor.histogram;
    if (!h) return null;
    const out = new Float32Array(256);
    const src = channel === 'red' && mode === 'point' ? [h.r] : channel === 'green' && mode === 'point' ? [h.g] : channel === 'blue' && mode === 'point' ? [h.b] : [h.r, h.g, h.b];
    for (const c of src) for (let i = 0; i < 256; i++) out[i]! += c[i]!;
    return out;
  });

  const set = (spec: ParamSpec) => (v: number) => editor.setParam(spec, v);
</script>

<Section title="Tone Curve" open={false}>
  {#snippet actions()}
    <button class="small" onclick={() => editor.resetToneCurve()} disabled={editor.readOnly}>Reset</button>
  {/snippet}
  <div class="modes">
    <button class:active={mode === 'parametric'} onclick={() => (mode = 'parametric')}>Parametric</button>
    {#each CURVE_CHANNELS as ch (ch)}
      <button
        class="ch"
        class:active={mode === 'point' && channel === ch}
        style:--c={COLOR[ch]}
        onclick={() => {
          mode = 'point';
          channel = ch;
        }}>{LABEL[ch]}</button
      >
    {/each}
  </div>
  <CurveEditor
    curve={shown}
    points={mode === 'point' ? tc.point[channel] : null}
    color={mode === 'point' ? COLOR[channel] : COLOR.master}
    histogram={lumaHist}
    splits={mode === 'parametric' ? [tc.parametric.shadowSplit / 100, tc.parametric.midtoneSplit / 100, tc.parametric.highlightSplit / 100] : []}
    disabled={editor.readOnly}
    onchange={(pts) => editor.setCurvePoints(channel, pts)}
    oncommit={() => editor.commit()}
  />
  {#if mode === 'parametric'}
    <div class="sliders">
      {#each regions as spec (spec.path)}
        <Slider {spec} value={editor.value(spec)} onchange={set(spec)} oncommit={() => editor.commit()} onreset={() => editor.resetParam(spec)} disabled={editor.readOnly} />
      {/each}
      <div class="sub">Region splits</div>
      {#each splitsSpecs as spec (spec.path)}
        <Slider {spec} value={editor.value(spec)} onchange={set(spec)} oncommit={() => editor.commit()} onreset={() => editor.resetParam(spec)} disabled={editor.readOnly} />
      {/each}
    </div>
  {:else}
    <p class="hint">Click the curve to add a point, drag to move it, double-click to remove it.</p>
  {/if}
</Section>

<style>
  .modes {
    display: flex;
    gap: 4px;
    margin-bottom: 8px;
  }
  .modes button {
    padding: 2px 7px;
    font-size: 11px;
  }
  .modes .ch {
    color: var(--c);
  }
  .modes .ch.active,
  .modes button.active {
    border-color: var(--c, var(--accent));
  }
  .sliders {
    margin-top: 8px;
  }
  .sub {
    color: var(--text-dim);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 8px 0 2px;
  }
  .hint {
    color: var(--text-dim);
    font-size: 11px;
    margin: 8px 0 0;
  }
  .small {
    padding: 2px 8px;
    font-size: 11px;
  }
</style>
