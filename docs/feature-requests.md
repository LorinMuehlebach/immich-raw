# Feature requests

Ideas that are wanted but not built yet, with what stands in the way.

## Export

- **Wide-gamut colour spaces: Display P3, Adobe RGB, ProPhoto RGB.** Exports are sRGB only. The
  renderer clips colours to sRGB early, in the tone stage (`FS_TONE` in
  `packages/pipeline/src/shaders.ts`), and colour grading, the tone curve and the finishing passes
  work on sRGB values after that. Converting the finished image to another space would not bring back
  the clipped colours. Doing it properly means:
  - keeping out-of-range values through the display stages (the intermediate targets are already
    16-bit float);
  - an export-only last pass with the target space's matrix, gamut clip and transfer curve;
  - an embedded ICC profile (JPEG APP2, PNG `iCCP`, TIFF tag 34675) and the EXIF colour space tag.
- **16-bit TIFF and PNG.** Exports are 8 bits per channel. 16-bit needs a float read-back of the
  render (the final target is 8-bit today) and a resampler that works on 16-bit data, since the
  browser's `createImageBitmap` scaling is 8-bit.
- **Content Credentials (C2PA).** Signing an export needs a C2PA manifest (JUMBF in JPEG APP11
  segments), a hash of the file and a signature with an X.509 certificate. A self-signed certificate
  shows as an unknown signer, so this needs a certificate the user brings, or signing on a server.
- **Image watermarks.** The watermark is text only; a logo (PNG with transparency) would need an
  upload and somewhere to keep it.
