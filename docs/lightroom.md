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
- **Profiles.** "Adobe Color" and "Adobe Standard" use your own Adobe camera profile when the editor
  has one for the camera ([below](#camera-profiles-from-lightroom)); without it they show as Color,
  an approximation. Adobe's base tone curve is in Lightroom's engine, not in a profile, so the two
  Adobe profiles use a stand-in fitted to Lightroom exports of one photo (X-T30, DR400): about twice
  the contrast around mid-grey, more colour in the middle tones, and the Shadows slider at half
  strength. On that photo it brought the editor 33 % closer to Lightroom; for other cameras and
  scenes it is an approximation. It only affects the Adobe profiles, so no other edit changes.
- **Whites, Highlights and Blacks.** They work on the scene's brightness in stops, Lightroom's on
  the brightness of the picture as shown, so on a dark photo they can do almost nothing here. On the
  test photo Whites +50, Highlights -50 and Blacks -50 changed nothing visible in the editor, against
  0.05 to 0.12 of lightness in Lightroom. An edit that leans on them looks flatter here.

## Camera profiles from Lightroom

Most of the colour of "Adobe Color" and "Adobe Standard" is in Adobe's camera profile for the body:
a hue and saturation map (one for tungsten, one for daylight light, blended by the photo's colour
temperature) and, for Adobe Color, a look table. On a test photo they took the editor's colour from
too grey and cool (about 66 % of Lightroom's chroma, a blue-red cast) to 84 % with the cast gone.

Adobe's profiles are Adobe's, so the editor ships none. You convert the ones from your own Lightroom;
the result stays in a folder that git ignores and is never uploaded anywhere.

1. Find your camera's profile. Lightroom keeps them in
   `C:\ProgramData\Adobe\CameraRaw\CameraProfiles\Adobe Standard\` (named like
   `Fujifilm X-T30 Adobe Standard.dcp`); Lightroom's own folder has them too, under
   `Resources\CameraProfiles\`.
2. Convert it (Node 22.18 or newer), from the repository root:

   ```sh
   node packages/pipeline/scripts/convert-camera-profiles.mjs apps/editor/public/camera-profiles "C:/ProgramData/Adobe/CameraRaw/CameraProfiles/Adobe Standard/Fujifilm X-T30 Adobe Standard.dcp"
   ```

   It writes one small JSON file per profile and an `index.json` next to them, and adds to what is
   already there. Name the cameras you use: a folder converts everything in it.
3. Reload the editor. Photos from that camera now offer **Camera profiles** in the Profile list, and
   a Lightroom sidecar that says "Adobe Color" or "Adobe Standard" uses them.

A deployed editor needs the same folder next to its files (`camera-profiles/`, beside `index.html`).
Don't put it in an image you share: the files are Adobe's. Cameras without a converted profile keep
working: the two profiles then show as Color.

What the profile does not carry: Adobe's tone curve and baseline exposure per camera (see
"Profiles" above for the stand-in tone), and the colour matrices (the editor keeps its own, which on
their own did not bring the colour closer).

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
