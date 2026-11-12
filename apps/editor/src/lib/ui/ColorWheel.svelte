<script lang="ts">
  // Color Grading wheel: angle = hue (0 red at 3 o'clock, counter-clockwise), distance from
  // the centre = saturation. Drag anywhere on the wheel; Shift keeps the hue and only
  // changes saturation; double-click resets.

  interface Props {
    hue: number;
    sat: number;
    size?: number;
    disabled?: boolean;
    label?: string;
    onchange: (hue: number, sat: number) => void;
    oncommit: () => void;
    onreset: () => void;
  }

  let { hue, sat, size = 110, disabled = false, label = '', onchange, oncommit, onreset }: Props = $props();

  let el: HTMLDivElement | undefined = $state();
  let dragging = $state(false);
  let startHue = 0;

  // conic-gradient runs clockwise from the top; start at 3 o'clock and list hues descending.
  const WHEEL = `conic-gradient(from 90deg, ${Array.from({ length: 13 }, (_, i) => `hsl(${360 - i * 30} 70% 50%)`).join(', ')})`;

  const puck = $derived.by(() => {
    const r = (Math.min(100, Math.max(0, sat)) / 100) * (size / 2);
    const a = (hue * Math.PI) / 180;
    return { x: size / 2 + r * Math.cos(a), y: size / 2 - r * Math.sin(a) };
  });

  function fromPointer(e: PointerEvent) {
    const rect = el!.getBoundingClientRect();
    const dx = e.clientX - rect.left - rect.width / 2;
    const dy = rect.top + rect.height / 2 - e.clientY;
    const s = Math.min(100, (Math.hypot(dx, dy) / (rect.width / 2)) * 100);
    const h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    onchange(e.shiftKey ? startHue : Math.round(h), Math.round(s));
  }

  function onDown(e: PointerEvent) {
    if (disabled || e.button > 0) return;
    e.preventDefault();
    el!.setPointerCapture(e.pointerId);
    dragging = true;
    startHue = hue;
    fromPointer(e);
  }

  function onMove(e: PointerEvent) {
    if (dragging) fromPointer(e);
  }

  function onUp() {
    if (!dragging) return;
    dragging = false;
    oncommit();
  }
</script>

<div
  class="wheel"
  class:disabled
  bind:this={el}
  style:width="{size}px"
  style:height="{size}px"
  style:--wheel={WHEEL}
  role="slider"
  tabindex="-1"
  aria-label="{label} hue and saturation"
  aria-valuenow={sat}
  aria-valuetext="{hue}°, {sat}"
  onpointerdown={onDown}
  onpointermove={onMove}
  onpointerup={onUp}
  onpointercancel={onUp}
  ondblclick={onreset}
>
  <div class="cross"></div>
  <div class="puck" class:on={sat > 0} style:left="{puck.x}px" style:top="{puck.y}px" style:background={sat > 0 ? `hsl(${hue} 80% 55%)` : '#9a9a9a'}></div>
</div>

<style>
  .wheel {
    position: relative;
    border-radius: 50%;
    background:
      radial-gradient(closest-side, #8a8a8a 0%, rgba(138, 138, 138, 0.6) 35%, rgba(138, 138, 138, 0) 100%),
      var(--wheel);
    touch-action: none;
    cursor: crosshair;
    flex: none;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.5);
  }
  .wheel.disabled {
    opacity: 0.45;
    cursor: default;
  }
  .cross {
    position: absolute;
    inset: 0;
    background:
      linear-gradient(rgba(0, 0, 0, 0.18), rgba(0, 0, 0, 0.18)) center / 1px 100% no-repeat,
      linear-gradient(rgba(0, 0, 0, 0.18), rgba(0, 0, 0, 0.18)) center / 100% 1px no-repeat;
    border-radius: 50%;
    pointer-events: none;
  }
  .puck {
    position: absolute;
    width: 11px;
    height: 11px;
    margin: -6px 0 0 -6px;
    border-radius: 50%;
    border: 1.5px solid #fff;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);
    pointer-events: none;
  }
</style>
