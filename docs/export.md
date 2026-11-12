# Export

Export makes files of your edit, saved or not, for the web, screens or print: one photo from the
editor, a whole album, or the photos selected in Immich.

## One photo

**Low** (web), **Medium** (screens) and **High** (print) in the left panel download the edit.

![The Export panel](images/export/panel.jpg)

## Settings

The gear sets, for each preset:
- file type: JPEG, PNG, TIFF, WebP, AVIF or JPEG XL (8 bits, sRGB; see the table below);
- size: full, long or short edge, width or height (pixels, cm or inches at a resolution), or
  megapixels; never larger than the photo;
- quality, kept for each lossy file type, or lossless for WebP and JPEG XL;
- output sharpening (screen, matte or glossy paper; low, standard or high);
- a text watermark (position, size, opacity);
- metadata: all, all except location, or copyright only, with a copyright line such as
  `© {year} {owner}`;
- the file name: the original name, with the preset or date, album and number, or your own pattern.

The settings are kept in the browser. One of the presets also makes the copy that **Save to
Immich** uploads (**Immich copy**, see [Getting started](getting-started.md#3-save)). Below the
presets, **Save to Immich** sets which photo is in front of the stack and when the edit is a
favourite.

| File type | Compression | Metadata in the file | Notes |
|---|---|---|---|
| JPEG | quality 50–100 | EXIF, XMP | |
| PNG | lossless | EXIF, XMP | |
| TIFF | lossless (Deflate) | EXIF, XMP | |
| WebP | quality 50–100, or lossless | EXIF, XMP | at most 16383 pixels a side |
| AVIF | quality 30–100 (63 looks about like JPEG 90) | none | slow at full size |
| JPEG XL | quality 50–100, or lossless | EXIF, XMP | slow at full size; Chrome and Edge don't show it, Safari does |

WebP, AVIF and JPEG XL are encoded in the background, so the editor stays usable meanwhile. In a
batch, one AVIF or JPEG XL (two WebPs) is encoded at a time.

![Export settings: file type and size](images/export/settings.jpg)

![Export settings: a text watermark](images/export/watermark.jpg)

## A whole album

**Export album…** exports every photo of an Immich album with one preset:
- RAWs with their saved edit (or the default settings);
- other photos at the preset's size and type; videos are skipped;
- a JPEG the editor saved is rendered again from its RAW, so it loses no quality. Only when that RAW
  is gone is the JPEG itself exported.

In Chrome and Edge on HTTPS the files go into a folder you choose, elsewhere into one ZIP.

![Export album](images/export/album.jpg)

## Photos selected in Immich

Select photos in the timeline, an album or a search, then click the export icon in Immich's
selection bar (outlined in red here). A page opens with the same choices as Export album.

![The export icon in Immich's selection bar](images/export/immich-selection.jpg)

![Exporting the selected photos](images/export/selected-page.jpg)

## Speed

Each RAW is rendered in the browser (about 17 seconds of work per photo), several at once: 4 on a
computer and 2 on a phone or tablet, or what you pick, from 1 to 16. On an 8-core laptop, 4 at once
was 2.7 to 3.9 times faster than one at a time, and 8 up to 3.5 times faster for 40 to 65 MP files.
Measurements, and what HTTPS adds: [Export speed](export-speed.md).

Wider colour spaces, 16-bit files and Content Credentials are
[feature requests](feature-requests.md).
