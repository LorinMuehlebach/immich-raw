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

## Where it still looks different

The settings come across as numbers; the rendering behind them isn't Adobe's, so a photo can still
look a little different.

- **As Shot shows other numbers.** With "As Shot" both use the camera's own white balance, so the
  colours match, but the temperature and tint read differently (one photo: 4500 K / +41 in
  Lightroom, 4387 K / +37 here). Lightroom converts with Adobe's two-illuminant camera profile, the
  editor with a single matrix. A sidecar with "As Shot" has no temperature to import.
- **Highlight-protection modes.** At Fujifilm DR200 and DR400 the camera underexposes the RAW by 1
  or 2 stops and brightens its own JPEG back. Lightroom does too; the editor adds the same +1 or +2
  EV as a baseline exposure (not shown on the Exposure slider), so an imported edit comes out as
  bright as in Lightroom. Canon's Highlight Tone Priority (+1 EV) and Nikon's Active D-Lighting
  (up to +1.33 EV) get the same treatment. The Fujifilm case is checked against Lightroom on a DR400
  photo; the Canon and Nikon values come from [RapidRAW](https://github.com/CyberTimon/RapidRAW) and
  only their reading is checked here, not the brightness. A DNG made from such a RAW carries it as
  its BaselineExposure.
- **Profiles.** Lightroom's "Adobe Color" and "Adobe Standard" import as **Color** and **Standard**.
  Both are built into the editor and carry no Adobe data: the colour of each is a smooth function of
  hue (chroma gain and hue turn per 15 degrees of OKLab hue), a chroma gain by lightness, and a tone
  curve, all fitted to Lightroom exports (X-T30). Color is the more colourful of the two and has the
  deeper shadows; Standard lifts the shadows and ends a little lower. Three photos went into the fit,
  a dark DR400 scene and two daylight portraits at DR100, and the first two do not share one tone curve (the
  DR100 one has deeper shadows and a longer highlight roll-off), so each profile has a curve at 0 EV
  and at +2 EV baseline exposure, and the photo's own baseline exposure (Fujifilm DR, Canon HTP,
  Nikon ADL) picks the mix; the middle values are a guess. Against Lightroom's own exports with every
  slider at 0 the mean OKLab difference is 0.012 for Color and Standard on the DR400 photo (colour alone
  0.003) and 0.021 to 0.024 on the portraits (colour alone 0.005 to 0.006); most of what is left is fine detail
  (see Sharpening above). How colourful Lightroom renders a photo also varies a little from photo to photo (its chroma is 10 percent
  below the editor's on the dark scene and 5 percent above it on the brightest portrait, with Color); the
  fit takes the middle. It only knows the hues those photos have, so expect it to be least
  exact on saturated blues, magentas and reds. The numbers are in
  `packages/pipeline/src/color/adobe-fit-data.ts`. Neither profile has an Amount slider here, so a
  Lightroom Look amount is ignored. Lightroom also draws strong highlights less colourful when the
  exposure is raised; copying that made the full edit of the DR400 photo less colourful than
  Lightroom's, so it isn't done.
- **Sharpening.** Lightroom's export is sharper than the editor's at the same Amount: at 1:1 the
  finest scale (under one pixel) has 30 to 60 percent more energy at Amount 40. Raising the Amount
  to about 2.5 times closes that gap but does not lower the pixel error, so it is not done.
- **Shadows, Highlights, Whites and Blacks.** Each works on a band of the photo's own tones, as
  Lightroom's do: Whites and Highlights near its brightest tones, Blacks and Shadows near its
  darkest, wherever those sit. (Earlier they acted at fixed brightness, so on a dark photo Whites and
  Blacks did almost nothing.) The photo's black and white point are measured from the preview and
  move with Exposure and with each slider. The strength of each slider, and how it grows with the
  amount (Whites much faster than linearly), are fitted to Lightroom exports of three X-T30 photos by
  searching the constants in `tone-windows.ts`: a dark DR400 scene (single sliders at 20, 50 and 80,
  and a combined edit), a daylight DR100 portrait (one combined edit) and a second portrait
  (Highlights, Whites, Blacks and Contrast at -40, -20, +20 and +40, Shadows at -40 and +40, and a neutral export to measure against). The search compares how far each slider shifts the lightness at each lightness with what
  Lightroom's export shows; the mean colour difference is dominated by fine detail (0.02 whatever the
  slider does), so it barely moved. Fitting the dark scene alone had made the windows too wide for a
  bright photo: Highlights -66, Shadows +45, Whites -56, Blacks -42 on the first portrait was 0.080
  from Lightroom, then 0.029. The windows are a compromise between the photos: Lightroom's Blacks and
  Whites grow about linearly with the amount on the second portrait but much faster than linearly on
  the dark scene, so Blacks -50 on the dark scene is a little worse now (0.056), Whites +80 a little
  better (0.047), and on the second portrait Whites and Blacks at +-20 are weaker than Lightroom's
  (about 0.01 to 0.02 of lightness). Highlights and Whites at +-20 to +-40 on it are within 0.01
  to 0.03 of lightness. Exposure -2, -1, +1 and +2 on it match within 0.02 of lightness, unchanged.
  The same edit with Exposure +1.27 on the dark scene was about 0.05 before the refits (not measured
  again) and rendered a little darker than Lightroom (0.02 to 0.04 of lightness): Lightroom's sliders
  and exposure interact in ways these photos can't pin down. Lightroom's Whites and Blacks also raise
  the picture's local contrast; the editor now does too, but not fully. Shadows at +-40 on the second
  portrait was 0.6 times Lightroom's strength before the last fit (lightness shift 0.034 against
  0.059 at its peak) and is now within about 0.01 of it.
- **Contrast.** Stretches the tones about a pivot. Lightroom's pivot is near the middle of the picture's
  lightness (OKLab L about 0.57); the editor's was at scene middle grey, which the profile puts
  higher (L about 0.7), so Contrast +40 darkened the shadows too much and brightened the highlights too
  little. The pivot is now about one stop below middle grey (`TONE_WINDOWS.contrast`, fitted on
  Contrast -40 to +40 of the second portrait: 0.022 to 0.011 mean lightness-shift error).
  Positive Contrast is still a little further from Lightroom than negative.

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
