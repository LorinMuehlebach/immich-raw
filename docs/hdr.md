# HDR

**Merge to HDR…** (in the left panel; on phones in the More menu) makes one photo with the range
of a whole exposure bracket. Without a bracket, it brings out the range of the open RAW alone.

## Merging a bracket

The editor looks in Immich for the bracket around the open photo: RAWs from the same camera, lens
and focal length, taken one right after the other (within 2.5 seconds plus the exposure time), each
at a different exposure. Shoot them with the camera's exposure bracketing (or by hand, quickly,
without moving) and upload all of them. Brackets shot back to back, for a panorama or a time lapse,
are told apart where an exposure comes round again.

The dialog lists the shots with their exposure relative to the middle one. Untick any you want to
leave out (at least two stay). Then:

- **Align** lines the shots up, for hand-held brackets. It finds shifts, not rotation.
- **Deghost** (Low, Medium, High) uses the middle shot where something moved between shots:
  people, cars, branches, water. Higher finds smaller movement.

**Merge** reads every shot at full resolution in the browser and takes each pixel from the
brightest shot that isn't clipped there, since it has the least noise. The exposure steps are
measured from the shots themselves, so the camera's rounded shutter speeds don't leave seams.
Merging three 24 MP shots takes a minute or two.

The result is a DNG named after the middle shot (`DSC01234-HDR.dng`):

- **What it holds:** the merged image, demosaiced, as 16-bit linear camera RGB (lossless), with the
  middle shot's white balance, colour, date, place, rating, description, albums and tags.
- **Where it goes:** it is added to Immich in front of the bracket, in one stack. The bracket's own
  photos are not changed. If shots were already stacked (with their edited JPEGs, or by the
  culler), those stacks join this one.
- **Checking:** before anything is uploaded, the DNG is decoded again and compared with the merged
  image.

It then opens in the editor. It starts with Auto tone and the **HDR** slider (under Basic › Tone)
set for its range; edit it like any RAW. Saving stacks the edited JPEG in front, as usual.

## One RAW, no bracket

A RAW holds more range than the screen shows: often bright skies and deep shadows that the default
look clips. When no bracket is found, the dialog offers **HDR from this photo**: it sets the HDR
slider to an amount that fits the photo and runs Auto tone with it, as one step you can undo. No
new file is made: the RAW already holds everything one shot can record.

## Limits

- A DNG holds 16 bits per channel, so a bracket spanning more than about 4 stops loses some
  precision in the deepest shadows. These are the shadows nobody brings up that far.
- Alignment finds shifts only. A hand-held bracket that also turned shows slight doubling towards
  the corners; a tripod avoids that.
- Brackets of JPEGs, or of RAWs from different cameras, aren't merged.
- The shots are decoded one at a time, and the merge needs about 15 bytes per pixel next to that:
  roughly 360 MB for 24 MP, 900 MB for 61 MP.
