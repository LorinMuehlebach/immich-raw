<script lang="ts">
  // Lightroom's Calibration panel: shadow tint and the red / green / blue primaries.
  import { CALIBRATION_PARAMS as C, type ParamSpec } from '@immich-raw/recipe';
  import { editor } from '../state/editor.svelte.ts';
  import Section from './Section.svelte';
  import Slider from './Slider.svelte';

  const set = (spec: ParamSpec) => (v: number) => editor.setParam(spec, v);

  const groups: { title: string; rows: { spec: ParamSpec; track: string }[] }[] = [
    { title: 'Shadows', rows: [{ spec: C.shadowTint, track: 'linear-gradient(90deg, #3fae49, #8a8a8a, #c44fc4)' }] },
    {
      title: 'Red Primary',
      rows: [
        { spec: C.redHue, track: 'linear-gradient(90deg, hsl(330 75% 50%), hsl(0 75% 50%), hsl(35 85% 50%))' },
        { spec: C.redSaturation, track: 'linear-gradient(90deg, #8a8a8a, hsl(0 85% 50%))' },
      ],
    },
    {
      title: 'Green Primary',
      rows: [
        { spec: C.greenHue, track: 'linear-gradient(90deg, hsl(70 75% 45%), hsl(120 65% 42%), hsl(170 70% 42%))' },
        { spec: C.greenSaturation, track: 'linear-gradient(90deg, #8a8a8a, hsl(120 70% 42%))' },
      ],
    },
    {
      title: 'Blue Primary',
      rows: [
        { spec: C.blueHue, track: 'linear-gradient(90deg, hsl(195 75% 50%), hsl(235 75% 55%), hsl(275 70% 55%))' },
        { spec: C.blueSaturation, track: 'linear-gradient(90deg, #8a8a8a, hsl(235 80% 55%))' },
      ],
    },
  ];
</script>

<Section title="Calibration" open={false}>
  {#snippet actions()}
    <button class="small" onclick={() => editor.resetParams(Object.values(C), 'Reset Calibration')} disabled={editor.readOnly}>Reset</button>
  {/snippet}
  {#each groups as g (g.title)}
    <div class="sub">{g.title}</div>
    {#each g.rows as r (r.spec.path)}
      <Slider
        spec={r.spec}
        value={editor.value(r.spec)}
        track={r.track}
        onchange={set(r.spec)}
        oncommit={() => editor.commit()}
        onreset={() => editor.resetParam(r.spec)}
        disabled={editor.readOnly}
      />
    {/each}
  {/each}
</Section>

<style>
  .sub {
    color: var(--text-dim);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 6px 0 2px;
  }
  .small {
    padding: 2px 8px;
    font-size: 11px;
  }
</style>
