# Lightroom import

Edits made in Lightroom come along in two ways:
- **Sidecars:** when you open a RAW, the editor reads the Lightroom settings in its XMP sidecar and
  offers to apply them.
- **Presets:** **Import** in the Presets panel reads Lightroom `.xmp` presets
  ([Workflow → Presets](workflow.md#presets)).

The editor never changes the RAW or its sidecar.

## Opening a RAW with Lightroom settings

When you open a RAW you haven't edited yet and Immich has an XMP sidecar with Lightroom settings for
it, a banner says **Lightroom settings found**. It shows how many settings the editor can apply, how
many it can't yet, and up to three notes on what it approximated or skipped.
- **Apply** puts the settings on the photo as one history step, "Lightroom settings". Undo takes it
  back.
- **Ignore** starts from the editor's defaults.
- **Save** stores the edit with the RAW in Immich, as for any edit.

The banner only appears for a photo without an edit. Once the photo is saved, changes made later in
Lightroom aren't offered again. To bring them in anyway, import the sidecar as a preset
([below](#photos-already-in-immich)).

Immich writes sidecars of its own when you change a rating, description or tags in Immich. Those have
no develop settings and don't bring up the banner. When Immich adds its changes to a sidecar from
Lightroom, the Lightroom settings stay.

## What comes across

- **Basic:**
  - white balance: As Shot, a temperature and tint, or a preset such as Daylight (approximated as a
    temperature and tint);
  - tone and presence;
  - the profile: Lightroom's names ("Adobe Vivid", "Camera CLASSIC CHROME") are recognised, and
    other profiles are replaced by the closest one, with a note.
- **Tone Curve, Color Mixer and B&W, Color Grading, Calibration, Detail** (sharpening and noise
  reduction), **Lens Corrections, Transform, Effects** (vignette and grain) and the **crop**.
- **Masks:** linear and radial gradients, brush, and colour and luminance ranges.
  - AI masks (Subject, Sky, Background, People and their parts, Landscape) are found again in the
    photo.
  - AI Objects and one person's parts can't be told apart in the file: objects are skipped, and a
    part of one person applies to everyone.
  - Lightroom has no edge settings, so imported masks start without them ([Masks](masks.md)).

Left out (the banner counts them as not supported):
- spot removal, healing and red eye;
- Depth Range masks;
- settings from Lightroom's process versions before 2012;
- the crop of a mirrored photo;
- any other setting the editor has no equivalent for. The notes name the panels they come from.

## Getting the sidecars into Immich

The editor only reads the sidecar Immich already has for the RAW, so the RAW and its `.xmp` have to
arrive in Immich together. Immich itself also reads the sidecar's rating, keywords (as tags),
description, date and location.

### 1. Let Lightroom write the sidecars

- **Lightroom Classic** keeps edits in its catalog. To have them in files too, either:
  - turn on **Automatically write changes into XMP** (Catalog Settings, Metadata tab);
  - or select the photos and choose **Metadata → Save Metadata to File** (Ctrl+S, ⌘S on a Mac).
- **Lightroom** (the cloud-based version): **Export** with the file type **Original + Settings**.
- **Camera Raw** (Photoshop, Bridge) writes sidecars for RAW files by default.

The sidecar sits next to the RAW and has its name: `IMG_1234.xmp` for `IMG_1234.CR3`. Immich also
accepts `IMG_1234.CR3.xmp`, and prefers it when both exist.

Only proprietary RAWs (CR3, NEF, ARW, RAF…) get a sidecar. For DNG, JPEG and TIFF files Lightroom
writes its settings into the file itself, and the editor doesn't read them there.

### 2. Upload the RAWs together with their sidecars

immich-raw passes uploads on to Immich, so use the address you open Immich at. Each way below needs
an API key: in Immich, **Account Settings → API Keys**.

**Immich CLI** (needs Node.js):

```sh
npm i -g @immich/cli
immich login http://<immich-address>:2283/api <api-key>
immich upload --recursive /path/to/photos
```

It uploads each photo with its `.xmp`.

**[immich-go](https://github.com/simulot/immich-go)** (a single program, no Node.js):

```sh
immich-go upload from-folder --server=http://<immich-address>:2283 --api-key=<api-key> /path/to/photos
```

It uploads each photo with its `.xmp`, unless you add `--ignore-sidecar-files`.

**An external library**, if the photos are on the server already. Immich then reads them where they
are, and you don't upload anything:
- Mount the folder into the `immich-server` container, then add it under **Administration →
  External Libraries**.
- When Immich scans the library, it finds the `.xmp` next to each photo.
- For a sidecar added later, run the **Sidecar metadata** job's **Discover** in Immich's
  administration.
- If the folder is mounted writable, Immich writes the ratings, descriptions and tags you change in
  Immich into the same `.xmp` that Lightroom uses.

**These leave the sidecars behind:**
- uploads from Immich's web page or its phone app;
- the Lightroom Classic plugins for Immich (lrc-immich-plugin, mi.Immich.Publisher, as of November
  2026): they upload the photo only.

### Photos already in Immich

Uploading a photo again doesn't add its sidecar: Immich sees the same file and keeps the one it
has. For those photos, one at a time:
1. Open the RAW in the editor.
2. Choose **Presets → Import**, and pick its `.xmp`.
3. Click the new preset in the **Lightroom Presets** folder. It applies the same settings the banner
   would have, crop and masks included.

## Presets

**Import** in the Presets panel reads Lightroom `.xmp` presets, several at once, into the
**Lightroom Presets** folder.
- Presets with AI masks (Adaptive presets) find their masks again in each photo they're applied to.
- Presets are kept in the browser ([Workflow → Presets](workflow.md#presets)).
