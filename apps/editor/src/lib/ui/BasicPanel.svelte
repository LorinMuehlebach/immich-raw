<script lang="ts">
  import { AUTO_PARAM_SPECS, sliderToTemp, tempToSlider } from '@immich-raw/pipeline';
  import { PARAMS, PROFILES, type ParamSpec, type ProfileId } from '@immich-raw/recipe';
  import { ALT_VIEW, Editor, editor } from '../state/editor.svelte.ts';
  import Section from './Section.svelte';
  import Slider from './Slider.svelte';

  const TEMP_TRACK = 'linear-gradient(90deg, #3d6fd6, #d8d8d8 45%, #e0b43a)';
  const TINT_TRACK = 'linear-gradient(90deg, #3fae49, #d8d8d8 50%, #c44fc4)';

  const tone: ParamSpec[] = [PARAMS.exposure, PARAMS.contrast, PARAMS.highlights, PARAMS.shadows, PARAMS.whites, PARAMS.blacks];
  const presence: ParamSpec[] = [PARAMS.texture, PARAMS.clarity, PARAMS.dehaze, PARAMS.vibrance, PARAMS.saturation];

  const set = (spec: ParamSpec) => (v: number) => editor.setParam(spec, v);
  const alt = (spec: ParamSpec) => {
    const view = ALT_VIEW[spec.path];
    return view ? (on: boolean) => editor.setMaskView(on ? view : 'none') : undefined;
  };
  const roundTemp = (p: number) => Math.round(sliderToTemp(p) / 10) * 10;
  let autoOpen = $state(false);
</script>

<Section title="Basic">
  {#snippet actions()}
    <button class="small" onclick={() => editor.resetAll()} disabled={editor.readOnly} title="Reset all settings">Reset</button>
  {/snippet}

  <div class="line">
    <span class="lbl">Profile</span>
    <select value={editor.recipe.profile} onchange={(e) => editor.setProfile(e.currentTarget.value as ProfileId)} disabled={editor.readOnly}>
      {#each PROFILES as p (p.id)}<option value={p.id}>{p.label}</option>{/each}
    </select>
  </div>

  <div class="group">
    <div class="line">
      <span class="lbl">WB</span>
      <select value={editor.recipe.wb.mode} onchange={(e) => editor.setWbMode(e.currentTarget.value as 'asShot' | 'custom')} disabled={editor.readOnly}>
        <option value="asShot">As Shot</option>
        <option value="custom">Custom</option>
      </select>
      <button
        class="icon picker"
        class:active={editor.tool === 'wb'}
        title="White balance selector (W): click something neutral"
        aria-label="White balance selector"
        disabled={editor.readOnly}
        onclick={() => editor.setTool(editor.tool === 'wb' ? 'edit' : 'wb')}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19.35 4.65a2.2 2.2 0 0 0-3.12 0l-2.83 2.83-1.06-1.06-1.41 1.41 1.06 1.06-7.08 7.08V20h4.04l7.08-7.08 1.06 1.06 1.41-1.41-1.06-1.06 2.83-2.83a2.2 2.2 0 0 0 0-3.12zM8.12 18H6v-2.12l6.99-7 2.12 2.13z"/></svg>
      </button>
    </div>
    <Slider
      spec={PARAMS.temp}
      value={editor.value(PARAMS.temp)}
      track={TEMP_TRACK}
      toPos={tempToSlider}
      fromPos={roundTemp}
      onchange={set(PARAMS.temp)}
      oncommit={() => editor.commit()}
      onreset={() => editor.resetParam(PARAMS.temp)}
      disabled={editor.readOnly}
    />
    <Slider
      spec={PARAMS.tint}
      value={editor.value(PARAMS.tint)}
      track={TINT_TRACK}
      onchange={set(PARAMS.tint)}
      oncommit={() => editor.commit()}
      onreset={() => editor.resetParam(PARAMS.tint)}
      disabled={editor.readOnly}
    />
  </div>

  <div class="group">
    <div class="sub tone">
      Tone
      <button
        class="small auto"
        onclick={() => editor.autoTone()}
        disabled={editor.readOnly}
        title="Auto (Ctrl+U): sets exposure, contrast, highlights, shadows, whites and blacks for this photo. Shift+double-click a slider name to set only that one."
      >Auto</button>
      <button
        class="small gear"
        class:active={autoOpen}
        onclick={() => (autoOpen = !autoOpen)}
        title="Auto settings: target brightness, headroom left above white for Highlights to recover, strength of Highlights, Shadows and Whites/Blacks, extra contrast"
        aria-label="Auto settings"
        aria-expanded={autoOpen}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.6 7.6 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.5-1-2 3.5L6.5 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.6 7.6 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.6 7.6 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5A3.5 3.5 0 1 1 13 8.5a3.5 3.5 0 0 1 0 7z" /></svg>
      </button>
      <span class="hint">Alt-drag shows clipping</span>
    </div>
    {#if autoOpen}
      <div class="auto-settings">
        <div class="auto-head">
          <span>Auto settings</span>
          <button class="small" onclick={() => editor.resetAutoParams()}>Defaults</button>
        </div>
        {#each AUTO_PARAM_SPECS as spec (spec.key)}
          <Slider
            {spec}
            value={editor.autoParams[spec.key]}
            onchange={(v) => editor.setAutoParam(spec.key, v)}
            oncommit={() => {}}
            onreset={() => editor.setAutoParam(spec.key, spec.default)}
          />
        {/each}
        <p class="note">
          {editor.autoLive ? 'Changes update this photo now (Auto was the last step).' : 'Used the next time you press Auto, on every photo.'}
        </p>
      </div>
    {/if}
    {#each tone as spec (spec.path)}
      <Slider
        {spec}
        value={editor.value(spec)}
        onchange={set(spec)}
        oncommit={() => editor.commit()}
        onreset={() => editor.resetParam(spec)}
        onalt={alt(spec)}
        onauto={Editor.AUTO_SPECS.includes(spec) ? () => editor.autoTone(spec) : undefined}
        disabled={editor.readOnly}
      />
    {/each}
  </div>

  <div class="group">
    <div class="sub">Presence</div>
    {#each presence as spec (spec.path)}
      <Slider {spec} value={editor.value(spec)} onchange={set(spec)} oncommit={() => editor.commit()} onreset={() => editor.resetParam(spec)} disabled={editor.readOnly} />
    {/each}
  </div>
</Section>

<style>
  .line {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 28px;
  }
  .lbl {
    width: 88px;
    color: var(--text);
  }
  .line select {
    flex: 1;
  }
  .group {
    margin-top: 10px;
  }
  .sub {
    color: var(--text-dim);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 4px 0 2px;
  }
  .hint {
    text-transform: none;
    letter-spacing: 0;
    margin-left: auto;
    opacity: 0.7;
  }
  .sub.tone {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .auto {
    text-transform: none;
    letter-spacing: 0;
    padding: 1px 10px;
    color: var(--text-bright);
  }
  .small {
    padding: 2px 8px;
    font-size: 11px;
  }
  .gear {
    padding: 2px 5px;
    display: inline-flex;
    align-items: center;
  }
  .gear.active {
    color: var(--accent);
    border-color: var(--accent);
  }
  .auto-settings {
    margin: 4px 0 8px;
    padding: 6px 8px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.18);
  }
  .auto-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: var(--text-bright);
    font-size: 11px;
    margin-bottom: 2px;
  }
  .note {
    margin: 4px 0 0;
    color: var(--text-dim);
    font-size: 11px;
  }
  .picker {
    padding: 3px 6px;
  }
</style>
