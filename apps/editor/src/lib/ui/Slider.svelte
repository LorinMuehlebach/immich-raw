<script lang="ts">
  // Lightroom-style slider row: label (double-click resets), track, value (click to type).
  import { formatParam, type ParamSpec } from '@immich-raw/recipe';

  interface Props {
    spec: ParamSpec;
    value: number;
    onchange: (v: number) => void;
    oncommit: () => void;
    onreset: () => void;
    /** CSS background for the track (temperature/tint gradients). */
    track?: string;
    disabled?: boolean;
    /** Optional non-linear mapping value <-> 0..1 slider position. */
    toPos?: (v: number) => number;
    fromPos?: (p: number) => number;
    /** Alt held while dragging: show/hide this slider's clipping or mask view. */
    onalt?: (on: boolean) => void;
    /** Shift+double-click: set this slider automatically (Lightroom's per-slider Auto). */
    onauto?: () => void;
  }

  let { spec, value, onchange, oncommit, onreset, track = '', disabled = false, toPos, fromPos, onalt, onauto }: Props = $props();

  const onDouble = (e: MouseEvent) => (e.shiftKey && onauto ? onauto() : onreset());

  function onPointerDown(e: PointerEvent) {
    if (!e.altKey || !onalt) return;
    onalt(true);
    addEventListener('pointerup', () => onalt(false), { once: true });
  }

  const RES = 1000;
  const mapped = $derived(!!toPos && !!fromPos);
  const pos = $derived(mapped ? Math.round(toPos!(value) * RES) : value);
  const min = $derived(mapped ? 0 : spec.min);
  const max = $derived(mapped ? RES : spec.max);
  const step = $derived(mapped ? 1 : spec.step);

  let editing = $state(false);
  let text = $state('');

  const fromInput = (raw: number) => (mapped ? fromPos!(raw / RES) : raw);
  const snap = (v: number) => Math.round(v / spec.step) * spec.step;

  function onKey(e: KeyboardEvent) {
    if (!e.shiftKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const dir = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 1;
    onchange(snap(value + dir * spec.step * (mapped ? 20 : 10)));
    oncommit();
  }

  function startEdit() {
    if (disabled) return;
    text = value.toFixed(spec.decimals);
    editing = true;
  }

  function finishEdit(apply: boolean) {
    if (apply) {
      const v = Number(text.replace(',', '.').replace('+', ''));
      if (Number.isFinite(v)) {
        onchange(v);
        oncommit();
      }
    }
    editing = false;
  }

  function focusSelect(node: HTMLInputElement) {
    node.focus();
    node.select();
  }
</script>

<div class="row" class:disabled>
  <span class="label" role="button" tabindex="-1" title={onauto ? 'Double-click to reset, Shift+double-click for auto' : 'Double-click to reset'} ondblclick={onDouble}>{spec.label}</span>
  <input
    type="range"
    {min}
    {max}
    {step}
    value={pos}
    {disabled}
    aria-label={spec.label}
    style:--track={track || null}
    class:custom-track={!!track}
    oninput={(e) => onchange(fromInput(Number(e.currentTarget.value)))}
    onchange={oncommit}
    ondblclick={onDouble}
    onkeydown={onKey}
    onpointerdown={onPointerDown}
  />
  {#if editing}
    <input
      class="num"
      bind:value={text}
      use:focusSelect
      onblur={() => finishEdit(true)}
      onkeydown={(e) => {
        if (e.key === 'Enter') finishEdit(true);
        if (e.key === 'Escape') finishEdit(false);
        e.stopPropagation();
      }}
    />
  {:else}
    <button class="value" tabindex="-1" onclick={startEdit} {disabled}>{formatParam(spec, value)}</button>
  {/if}
</div>

<style>
  .row {
    display: grid;
    grid-template-columns: 88px 1fr 52px;
    align-items: center;
    gap: 8px;
    height: 24px;
  }
  .row.disabled {
    opacity: 0.45;
  }
  .label {
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: default;
    user-select: none;
  }
  .value,
  .num {
    font: 12px ui-monospace, SFMono-Regular, Consolas, monospace;
    text-align: right;
    width: 52px;
    padding: 1px 4px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--text);
    border-radius: 3px;
  }
  .value:hover:not(:disabled) {
    border-color: var(--line);
  }
  .num {
    border-color: var(--accent);
    background: var(--bg);
    outline: none;
  }
  input[type='range'] {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 16px;
    background: transparent;
    margin: 0;
  }
  input[type='range']::-webkit-slider-runnable-track {
    height: 3px;
    background: var(--track, #4a4a4a);
    border-radius: 2px;
  }
  input[type='range']::-moz-range-track {
    height: 3px;
    background: var(--track, #4a4a4a);
    border-radius: 2px;
  }
  input[type='range'].custom-track::-webkit-slider-runnable-track {
    height: 4px;
  }
  input[type='range']::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 11px;
    height: 11px;
    margin-top: -4px;
    border-radius: 50%;
    background: #d9d9d9;
    border: none;
  }
  input[type='range']::-moz-range-thumb {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: #d9d9d9;
    border: none;
  }
  input[type='range']:focus-visible::-webkit-slider-thumb {
    outline: 2px solid var(--accent);
  }
  input[type='range']:hover::-webkit-slider-thumb {
    background: #fff;
  }
</style>
