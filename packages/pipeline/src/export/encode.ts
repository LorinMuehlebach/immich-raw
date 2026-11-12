// JPEG encoding of the rendered image. The browser's own encoder is ~7x faster than
// MozJPEG/WASM (M0: 1.4 s vs 9-19 s at 45 MP), so it's the default. jSquash is the
// fallback where the canvas can't hold the image (Safari limits canvas area).
export async function encodeJpeg(image: ImageData, quality = 0.92): Promise<Uint8Array> {
  try {
    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.putImageData(image, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    if (blob.size < 1000) throw new Error('canvas produced an empty image');
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    const { default: encode } = await import('@jsquash/jpeg/encode');
    const buf = await encode(image, {
      quality: Math.round(quality * 100),
      baseline: true,
      progressive: false,
      optimize_coding: true,
      auto_subsample: false,
      chroma_subsample: 1,
    });
    return new Uint8Array(buf);
  }
}
