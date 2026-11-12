// Watermarks for exports, a line of text or a logo, drawn after resizing and output sharpening.
// Either is drawn onto a transparent canvas the size of the mark, which is then blended into the
// photo: only the mark's area goes through a canvas, and the photo itself is never copied.

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

export interface LogoWatermarkOptions {
  position: WatermarkPosition;
  /** The logo's long side as % of the image's short edge (1–50). */
  size: number;
  /** 0–100. */
  opacity: number;
}

/** Pixels the mark is blended into, changed in place. */
export interface OverlayTarget {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

const MIN_FONT_PX = 8;
const MIN_LOGO_PX = 8;
const MARGIN = 0.03;
const MIN_MARGIN_PX = 4;

const fontFor = (px: number) => `600 ${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

/** Distance of a watermark from the image's edges: 3 % of the short edge, at least 4 px. */
export function watermarkMargin(width: number, height: number): number {
  return Math.max(MIN_MARGIN_PX, Math.round(Math.min(width, height) * MARGIN));
}

/** Pure layout (unit-tested): font size in px, the anchor point and canvas textAlign/textBaseline for the position, with a margin from the edges. `measure` returns the text's width at a font size in px. */
export function watermarkLayout(
  width: number,
  height: number,
  opts: Pick<WatermarkOptions, 'position' | 'size'>,
  measure: (fontPx: number) => number,
): { fontPx: number; x: number; y: number; align: 'left' | 'center' | 'right'; baseline: 'top' | 'middle' | 'bottom' } {
  const short = Math.min(width, height);
  const size = Math.min(20, Math.max(1, opts.size || 0));
  const margin = watermarkMargin(width, height);
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

/**
 * Pure layout (unit-tested): where a logo of logo.width x logo.height goes, in whole pixels. Its
 * long side is `size` % of the image's short edge (at least 8 px), shrunk to fit inside the
 * margins, the aspect ratio kept.
 */
export function logoLayout(
  width: number,
  height: number,
  logo: { width: number; height: number },
  opts: Pick<LogoWatermarkOptions, 'position' | 'size'>,
): { x: number; y: number; width: number; height: number } {
  const margin = watermarkMargin(width, height);
  const size = Math.min(50, Math.max(1, opts.size || 0));
  const long = Math.max(MIN_LOGO_PX, (size / 100) * Math.min(width, height));
  const aspect = logo.width > 0 && logo.height > 0 ? logo.width / logo.height : 1;
  let w = aspect >= 1 ? long : long * aspect;
  let h = aspect >= 1 ? long / aspect : long;
  const fit = Math.min(1, Math.max(1, width - 2 * margin) / w, Math.max(1, height - 2 * margin) / h);
  w = Math.max(1, Math.round(w * fit));
  h = Math.max(1, Math.round(h * fit));
  const { position } = opts;
  const x = position.endsWith('left') ? margin : position.endsWith('right') ? width - margin - w : Math.round((width - w) / 2);
  const y = position.startsWith('top') ? margin : position.startsWith('bottom') ? height - margin - h : Math.round((height - h) / 2);
  return { x, y, width: w, height: h };
}

/**
 * Blends an RGBA overlay (straight alpha, as getImageData gives it) over `dst` at (x, y), in
 * place, clipped to `dst`. The photo's own alpha is kept.
 */
export function compositeOverlay(dst: OverlayTarget, overlay: OverlayTarget, x: number, y: number): void {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(dst.width, x + overlay.width);
  const y1 = Math.min(dst.height, y + overlay.height);
  const d = dst.data;
  const o = overlay.data;
  for (let row = y0; row < y1; row++) {
    let di = (row * dst.width + x0) * 4;
    let oi = ((row - y) * overlay.width + (x0 - x)) * 4;
    for (let col = x0; col < x1; col++, di += 4, oi += 4) {
      const a = o[oi + 3]!;
      if (a === 0) continue;
      if (a === 255) {
        d[di] = o[oi]!;
        d[di + 1] = o[oi + 1]!;
        d[di + 2] = o[oi + 2]!;
        continue;
      }
      const k = a / 255;
      d[di] = d[di]! + (o[oi]! - d[di]!) * k;
      d[di + 1] = d[di + 1]! + (o[oi + 1]! - d[di + 1]!) * k;
      d[di + 2] = d[di + 2]! + (o[oi + 2]! - d[di + 2]!) * k;
    }
  }
}

/**
 * Draws the text into the image, in place, and returns it (browser only: OffscreenCanvas).
 * Blank text or opacity 0 leaves it unchanged.
 */
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

  // Generous padding for glyph overhang, descenders and the shadow. The canvas also stays clear
  // of Safari's canvas size limit.
  const pad = fontPx * 0.5 + shadowBlur * 2 + shadowOffset;
  const left = align === 'left' ? x : align === 'right' ? x - textWidth : x - textWidth / 2;
  const top = baseline === 'top' ? y : baseline === 'bottom' ? y - fontPx : y - fontPx / 2;
  const x0 = Math.max(0, Math.floor(left - pad));
  const y0 = Math.max(0, Math.floor(top - pad));
  const x1 = Math.min(w, Math.ceil(left + textWidth + pad));
  const y1 = Math.min(h, Math.ceil(top + fontPx + pad));
  if (x1 <= x0 || y1 <= y0) return img;

  const ctx = context2d(x1 - x0, y1 - y0, colorSpace);
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
  compositeOverlay(img, ctx.getImageData(0, 0, x1 - x0, y1 - y0, { colorSpace }), x0, y0);
  return img;
}

/**
 * Draws a logo (a decoded PNG, transparency kept) into the image, in place, and returns it
 * (browser only). Opacity 0 leaves it unchanged.
 */
export function drawLogoWatermark(img: ImageData, logo: ImageBitmap | OffscreenCanvas, opts: LogoWatermarkOptions): ImageData {
  const alpha = Math.min(1, Math.max(0, (opts.opacity || 0) / 100));
  if (alpha === 0 || !logo.width || !logo.height) return img;
  const box = logoLayout(img.width, img.height, logo, opts);
  const ctx = context2d(box.width, box.height, img.colorSpace);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.globalAlpha = alpha;
  ctx.drawImage(logo, 0, 0, box.width, box.height);
  compositeOverlay(img, ctx.getImageData(0, 0, box.width, box.height, { colorSpace: img.colorSpace }), box.x, box.y);
  return img;
}

function context2d(width: number, height: number, colorSpace: PredefinedColorSpace): OffscreenCanvasRenderingContext2D {
  const ctx = new OffscreenCanvas(width, height).getContext('2d', { colorSpace });
  if (!ctx) throw new Error('no 2d context');
  return ctx;
}
