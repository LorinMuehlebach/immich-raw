// Text watermark for exports, drawn after resizing and output sharpening.

export type WatermarkPosition = 'top-left' | 'top' | 'top-right' | 'left' | 'center' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right';

export interface WatermarkOptions {
  text: string;
  position: WatermarkPosition;
  /** Text height as % of the image's short edge (1–20). */
  size: number;
  /** 0–100. */
  opacity: number;
  color: 'white' | 'black';
}

const MIN_FONT_PX = 8;
const MARGIN = 0.03;
const MIN_MARGIN_PX = 4;

const fontFor = (px: number) => `600 ${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

/** Pure layout (unit-tested): font size in px, the anchor point and canvas textAlign/textBaseline for the position, with a margin from the edges. `measure` returns the text's width at a font size in px. */
export function watermarkLayout(
  width: number,
  height: number,
  opts: Pick<WatermarkOptions, 'position' | 'size'>,
  measure: (fontPx: number) => number,
): { fontPx: number; x: number; y: number; align: 'left' | 'center' | 'right'; baseline: 'top' | 'middle' | 'bottom' } {
  const short = Math.min(width, height);
  const size = Math.min(20, Math.max(1, opts.size || 0));
  const margin = Math.max(MIN_MARGIN_PX, Math.round(short * MARGIN));
  let fontPx = Math.max(MIN_FONT_PX, Math.round((size / 100) * short));
  fontPx = Math.min(fontPx, Math.max(1, height - 2 * margin));

  // Too wide: shrink to fit between the side margins (this wins over the minimum size).
  // Re-measured because text width doesn't scale exactly with the font size.
  const room = Math.max(1, width - 2 * margin);
  for (let i = 0; i < 8 && fontPx > 1; i++) {
    const textWidth = measure(fontPx);
    if (textWidth <= room) break;
    fontPx = Math.max(1, Math.min(fontPx - 1, Math.floor((fontPx * room) / textWidth)));
  }

  const { position } = opts;
  const align = position.endsWith('left') ? 'left' : position.endsWith('right') ? 'right' : 'center';
  const baseline = position.startsWith('top') ? 'top' : position.startsWith('bottom') ? 'bottom' : 'middle';
  const x = align === 'left' ? margin : align === 'right' ? width - margin : width / 2;
  const y = baseline === 'top' ? margin : baseline === 'bottom' ? height - margin : height / 2;
  return { fontPx, x, y, align, baseline };
}

/** Draws the text onto a copy of the image with an OffscreenCanvas 2D context and returns the new ImageData (browser only; returns the input unchanged when text is blank or opacity is 0). */
export function drawWatermark(img: ImageData, opts: WatermarkOptions): ImageData {
  const text = opts.text.trim();
  const alpha = Math.min(1, Math.max(0, (opts.opacity || 0) / 100));
  if (!text || alpha === 0) return img;
  const { width: w, height: h, colorSpace } = img;

  const measureCtx = context2d(1, 1, colorSpace);
  const measure = (px: number) => {
    measureCtx.font = fontFor(px);
    return measureCtx.measureText(text).width;
  };
  const { fontPx, x, y, align, baseline } = watermarkLayout(w, h, opts, measure);
  const textWidth = measure(fontPx);
  const shadowBlur = Math.max(1, fontPx * 0.08);
  const shadowOffset = Math.max(1, Math.round(fontPx * 0.03));

  // Only the area around the text goes through a canvas: far less copying than the whole
  // image, and it stays clear of Safari's canvas size limit. Generous padding for glyph
  // overhang, descenders and the shadow.
  const pad = fontPx * 0.5 + shadowBlur * 2 + shadowOffset;
  const left = align === 'left' ? x : align === 'right' ? x - textWidth : x - textWidth / 2;
  const top = baseline === 'top' ? y : baseline === 'bottom' ? y - fontPx : y - fontPx / 2;
  const x0 = Math.max(0, Math.floor(left - pad));
  const y0 = Math.max(0, Math.floor(top - pad));
  const x1 = Math.min(w, Math.ceil(left + textWidth + pad));
  const y1 = Math.min(h, Math.ceil(top + fontPx + pad));
  if (x1 <= x0 || y1 <= y0) return img;
  const bw = x1 - x0;
  const bh = y1 - y0;

  const ctx = context2d(bw, bh, colorSpace);
  ctx.putImageData(img, -x0, -y0, x0, y0, bw, bh);
  ctx.translate(-x0, -y0);
  ctx.font = fontFor(fontPx);
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  // A soft shadow in the opposite colour keeps the text readable on busy backgrounds.
  ctx.shadowColor = opts.color === 'white' ? 'rgba(0, 0, 0, 0.4)' : 'rgba(255, 255, 255, 0.4)';
  ctx.shadowBlur = shadowBlur;
  ctx.shadowOffsetX = shadowOffset;
  ctx.shadowOffsetY = shadowOffset;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = opts.color === 'white' ? '#fff' : '#000';
  ctx.fillText(text, x, y);
  const region = ctx.getImageData(0, 0, bw, bh, { colorSpace }).data;

  const out = new Uint8ClampedArray(img.data);
  const rowBytes = bw * 4;
  for (let r = 0; r < bh; r++) out.set(region.subarray(r * rowBytes, (r + 1) * rowBytes), ((y0 + r) * w + x0) * 4);
  return new ImageData(out, w, h, { colorSpace });
}

function context2d(width: number, height: number, colorSpace: PredefinedColorSpace): OffscreenCanvasRenderingContext2D {
  const ctx = new OffscreenCanvas(width, height).getContext('2d', { colorSpace });
  if (!ctx) throw new Error('no 2d context');
  return ctx;
}
