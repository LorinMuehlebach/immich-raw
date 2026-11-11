// Downscaling the rendered image for exports and previews.

/** Output size with the long edge at most `longEdge` px (null: unchanged). Never upscales. */
export function fitLongEdge(width: number, height: number, longEdge: number | null): { width: number; height: number } {
  if (longEdge === null) return { width, height };
  const s = Math.min(1, longEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

/** Scales the image to width x height with the browser's high-quality resampling. */
export async function resizeImage(img: ImageData, width: number, height: number): Promise<ImageData> {
  if (width === img.width && height === img.height) return img;
  const bmp = await createImageBitmap(img, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, width, height);
}
