# The culler

The culler is an optional service that sorts bursts and re-takes. It stacks photos of the same scene taken
close together and puts the best one in front. The others get a tag that says why they lost. It works on
RAW files, camera JPEGs and RAW + JPEG pairs. The results are ordinary Immich stacks and tags, so they show
up everywhere in Immich. The editor's filmstrip adds badges and controls on top.

Setup: [README → Optional: the culler](../README.md#optional-the-culler-auto-stack-and-best-pick).
Code: [services/culler/](../services/culler/).

## How it decides

1. **Which photos.**
   - **Auto-stack… in the editor:** the album the editor was opened from, or else the day of the
     photo being edited.
   - **Automatic run:** every new upload, plus the photos taken around it, so a burst uploaded in two
     parts is seen whole.
   - Trashed, hidden and locked photos are left out.
2. **Captures.** One capture is one press of the shutter:
   - A RAW and a camera JPEG with the same file name, the same camera and at most 2 s apart count as
     one capture.
   - The editor's edits of a RAW (`….edit.jpg`) belong to that RAW's capture.
   - A stack of one RAW and one JPEG (your own, or one Immich's mobile app made) is a capture too.
   - Stacks you made of several shots are left alone.
3. **Groups.** Captures go in the same group when all of these hold:
   - they were taken close together: at most 90 s between neighbours, by the same camera;
   - they look alike: CLIP image similarity of at least 0.88 to one of the group's last three
     shots, and at least 0.82 to its most typical shot (this keeps a slow pan from chaining into one
     endless group);
   - the group is no longer than 10 minutes and has no more than 60 shots.

   Photos that Immich itself marked as duplicates always join. CLIP is the same ViT-B/32 model Immich
   uses for smart search, with brightness evened out first, so a darker or blurred shot of the same
   scene still matches (0.92–0.99 in tests; different scenes stayed below 0.6).
4. **Ranking.** Checks run in this order, and each one only looks at the shots that survived the ones
   before it. No check ever rejects every shot.

   | Check | A shot is rejected when | Tag |
   |---|---|---|
   | Lighting | its exposure score is more than 0.75 worse than the best shot's, or it is more than 1 stop brighter or darker than the best and worse at all | `Culling/Rejected/Lighting` |
   | Sharpness | its subject has less than 70 % of the sharpest shot's fine detail | `Culling/Rejected/Blur` |
   | Eyes | more faces have closed eyes than in the best shot, or its least open eyes are clearly less open (a half-blink) | `Culling/Rejected/Eyes closed` |

   - **Exposure score:**
     - How far the typical brightness is from the target. The target is the same one the editor's
       Auto tone aims for; brightness within ±0.5 stops of it costs nothing.
     - Blown highlights, crushed shadows, and a very flat image (haze, flare).
     - **People first.** When the photos show people, their exposure counts most:
       - the faces make up 80 % of the score, the rest of the photo 20 %;
       - faces have their own target, because well exposed skin is brighter than a scene's average
         and differs between people: within ±1 stop of it costs nothing;
       - the faces' own blown highlights and crushed shadows count too. A face burnt out by the
         flash loses, even if the rest of the photo is fine;
       - without a usable face (seen from the side or from behind, too small), the people the
         object detector found count 60 %.
     - **Every shot of a group is judged alike.** Faces only when every shot has a usable face,
       else people when every shot shows some, else the whole photo with its centre weighted. A
       shot doesn't win just because a whole figure is brighter than a face. Sharpness works the
       same way: the eyes when every shot has a face, else the sharpest areas.
   - **Exposure of RAW files is measured on the RAW file itself.** Immich renders RAW previews with
     LibRaw's automatic brightness. In a test, that made a shot 1.5 stops darker look exactly like
     the normal one in its preview. So the culler downloads the RAW and decodes it without that
     correction.
   - **Sharpness:**
     - Fine detail on a contrast-normalised image, so a darker shot isn't "softer".
     - The flattest areas' noise is subtracted, so grain doesn't count as detail.
     - Measured on the eyes of the largest face, or else on the sharpest 5 % of the photo, so a
       blurred background doesn't matter.
   - **Eyes:**
     - Faces are found with YuNet. Faces smaller than 40 px, much smaller than the main face, or
       turned away are ignored.
     - MediaPipe's face landmarks give how far each eye is open. An eye counts as closed when it is
       less than 0.155 open (height/width, both eyes averaged), or both blink scores are at least 0.5.
       These values were checked on real stage photos.
     - **How open, 0–100 %:** the same opening, 0 % at 0.10 and 100 % from 0.24. Closed eyes
       measured 0.08–0.13, open ones 0.19–0.32. On a face turned more than 30°, only the eye nearer
       the camera counts: the far one, seen from the side, looks more open than it is.
     - **Half-blinks:** a shot is also rejected when its least open eyes are more than 30 points
       less open than in the best shot. A broad smile narrows the eyes a little (on real portraits
       to about 90 %), so a squinting smile stays.
   - **Smiles:** among the survivors, the shot with the most smiling faces is the best. The others
     stay runner-ups, not rejected: a serious face is no flaw.
     - The smile is MediaPipe's score for both mouth corners, averaged. A face counts as smiling
       from 0.4; on real portraits neutral faces measured 0.00–0.17, smiles 0.48–0.87.
   - **Best:** the survivor with the most smiles, then the best mix of sharpness (45 %), exposure
     (35 %) and how open the eyes are (20 %, the faces' average); if that is a tie, the earliest
     shot.
   - **Your choice comes first:** a shot you put in front yourself is always the best. So is the only
     favourite in a group.
   - The other survivors are runner-ups (`Culling/Runner-up`). The best gets `Culling/Best`.

## What it changes in Immich

- **One stack per group**, best in front:
  - for a RAW + JPEG pair, the camera JPEG goes in front;
  - for an edited RAW, its edit does.
- **Tags** on every file of each capture, under `Culling/` (the root can be changed).
  - When a photo's tag changes (say Runner-up becomes Best), Immich 3.4 sometimes loses the new tag a
    moment later. It writes tags to the photo's sidecar file in a background job and reads them back.
  - So after applying or undoing, the culler waits a few seconds, reads the tags again and sets any
    that went missing.
- **Reject flag** (rating −1) on rejected shots. It is never set on favourites or on photos you gave
  stars.
  - Immich 3.4 empties a −1 again a moment later. Its metadata reader in
    `server/src/services/metadata.service.ts` only accepts ratings 1–5: `validateRange(exifTags.Rating,
    1, 5)`.
  - The culler sets the flag once and doesn't retry. Until Immich fixes this, the tags are the
    reliable marker.
- **Details** for the filmstrip in the photo's metadata (`raw-editor.cull`): its group, rank, role,
  reason and the measurements.

A run that finds nothing new changes nothing.

## Your changes win

| You do this in Immich or the editor | The culler then |
|---|---|
| Put another shot in front of a stack (Immich), or ★ **Make best** (filmstrip) | Keeps your choice and moves the `Best` tag to it |
| Give a rejected photo stars, or remove its reject flag | Never sets the flag on it again |
| Take a photo out of a stack | Leaves that photo alone from then on |
| Delete a whole stack | Doesn't stack that group again (only a re-run with `--force` does) |
| Save an edit of a shot that isn't in front | The edit joins the stack without taking the front |

**Undo** works per run, newest run first.
- It puts back the stacks, tags, reject flags and details the run changed.
- It doesn't touch anything you changed since then; it tells you what it skipped.
- An older run can't be undone while a newer run that changed the same photos is still applied.

## Using it

**In the editor.** The filmstrip groups each stack's RAWs, best first, with a coloured line under them.
- **Badges:** ★ best, ◐ runner-up, and a red badge for rejected shots: ☀ lighting, ≋ sharpness,
  ◉ eyes.
- **Tooltip:** the reason and the measurements, for example "−1.5 EV vs best" or "sharpness 54 % of
  best".
- **Stack controls:** the number on a stack opens the stack window (below). ★ on another photo makes
  that one the best. **Collapse stacks** in the filmstrip's header shows only the best photo of each
  stack.
- **Auto-stack…** previews a run (a dry run), applies it, or undoes the last one. Its checkboxes
  choose what that run takes into account; the browser remembers them. Automatic runs use the
  culler's own settings (`culler.toml`).
  - **People's exposure counts most:** the faces, or else the people, before the rest of the photo.
  - **Find people without a visible face.**
  - **Prefer the most smiles.**
  - **Set aside closed eyes** (also half-blinks).
- **Title line:** shows the verdict for the photo you're editing, for example "★ best of 6" or
  "rejected: not sharp". Click it to open the stack window.

**The stack window.** It shows the shots of one stack, best first, one at a time and large.
- **Opening it:** the number on a stack in the filmstrip, the verdict in the editor's title line, or
  **Compare stack** in Immich's photo viewer. That button shows on photos in a stack the culler made
  with at least two shots. It opens the window as a page of its own; Esc goes back to Immich.
- **Switching shots:** ← / →, Home / End, the thumbnails at the bottom, or a swipe on touch screens.
- **Details:** the verdict and its place in the stack, sharpness and exposure compared with the best
  shot, the faces' or people's own exposure, blown highlights, crushed shadows, the exposure error,
  how open the eyes are (in %), smiles, the people found, the camera settings and the files of the
  shot. The measurement a shot was rejected for is shown in red.
- **Pictures:** each shot shows its edit if it has one, else the camera JPEG, else the RAW. Immich's
  RAW previews are auto-brightened, so for exposure trust the numbers more than the RAW's picture.
- **★ Make preferred** (or P) puts the shot in front, the same as ★ in the filmstrip.
- **Delete others…** keeps the preferred shot and moves every other shot to Immich's trash: its RAW,
  camera JPEG and edits. It asks first.
  - Files in the stack the culler doesn't know are left alone.
  - The culler then sorts the group again. With one shot left, it takes the stack apart, puts a RAW
    + JPEG pair back into its own stack and removes the `Culling/` tags.
  - To get the shots back, restore them from Immich's trash and run **Auto-stack…** again.

The filmstrip shows only RAWs. Stacks of JPEGs are sorted too, and show in Immich.

**Automatically.** New uploads are sorted once an upload batch has been quiet for 5 minutes and Immich
has made the previews.
- On its first start the culler only looks at photos uploaded from then on. Sort older photos from
  the editor or the command line.
- To get only suggestions instead of changes, set `CULLER_AUTO_APPLY=false`. The runs then appear as
  dry runs.

An Immich workflow can wake the culler right after each upload instead of waiting for its next check
(every 2 minutes). Set `CULLER_WEBHOOK_SECRET` on the culler, then create this workflow in Immich. You can
paste it into a new workflow's JSON editor, or send it to `POST /api/workflows`:

```json
{
  "name": "Wake the culler",
  "trigger": "AssetMetadataExtraction",
  "enabled": true,
  "steps": [
    {
      "method": "immich-plugin-core#webhook",
      "config": {
        "url": "http://immich-culler:8080/immich-raw/culler/api/v1/hooks/immich",
        "method": "POST",
        "headerName": "X-Culler-Secret",
        "headerValue": "the same secret"
      }
    }
  ]
}
```

**Command line** (inside the container: `docker compose exec immich-culler python -m culler …`):

```sh
python -m culler run --day 2024-05-01            # dry run: prints the stacks and why each shot lost
python -m culler run --day 2024-05-01 --apply    # changes Immich (also --album <id>, --from/--to, --ids)
python -m culler run --day 2024-05-01 --options '{"blur": {"min_ratio": 0.6}}'   # try other thresholds
python -m culler calibrate --day 2024-05-01      # similarity and gap of neighbouring shots
python -m culler runs                            # recent runs
python -m culler undo <run id>
```

`calibrate` helps tune the grouping. It lists each pair of neighbouring shots with their similarity and
time gap, and marks the pairs that would be grouped.

## Settings

| Environment variable | Default | |
|---|---|---|
| `IMMICH_URL` | `http://immich-server:2283` | Immich as seen from the container |
| `IMMICH_API_KEY` or `IMMICH_API_KEY_FILE` | | The key of the user whose library it sorts |
| `CULLER_WATCH` | `true` | Sort new uploads automatically |
| `CULLER_AUTO_APPLY` | `true` | `false`: only suggest (dry runs) |
| `CULLER_WATCH_INTERVAL`, `CULLER_WATCH_QUIET` | `120`, `300` | Seconds between checks; quiet time after the last upload |
| `CULLER_WEBHOOK_SECRET` or `…_FILE` | | Turns on the webhook route |
| `CULLER_TAG_ROOT` | `Culling` | Root of the tags |
| `CULLER_THREADS` | `2` | Threads for the image model |

The API key needs these permissions:
- `asset.read`, `asset.view`, `asset.download`, `asset.update`
- `album.read`, `user.read`
- `stack.create`, `stack.read`, `stack.update`, `stack.delete`
- `tag.create`, `tag.read`, `tag.asset`

They were checked against Immich 3.4. Each container sorts the library of one user.

Thresholds go in `/data/culler.toml`. The sections and every default are in
[config.py](../services/culler/src/culler/config.py). For example:

```toml
[grouping]
max_gap_s = 120          # longer bursts with pauses
link_similarity = 0.85   # group a little more loosely

[blur]
min_ratio = 0.6          # reject only clearly soft shots

[ranking]
order = ["lighting", "blur", "eyes"]
respect_favorites = true

[eyes]
enabled = true
max_open_gap = 0.3       # reject eyes this much less open than in the best shot (0.3 = 30 points)

[lighting]
people_first = true      # faces, or else people, count most for exposure
face_weight = 0.8

[people]
enabled = true           # people without a usable face (MediaPipe object detector)

[smiles]
enabled = true
min_score = 0.4          # a face counts as smiling from this score
```

## Resources

- **Speed:** about 0.3 s per photo on a desktop CPU (CLIP about 70 ms, the people detector about
  30 ms). Only photos that have a neighbour within 90 s are measured.
- **Models:** CLIP, YuNet (faces), MediaPipe's face landmarker (eyes, smiles) and its object
  detector EfficientDet-Lite0 (people, 7 MB). Updating to this version measures every photo once
  again, because faces, people and smiles are now stored apart.
- **Downloads:** for RAW files the original is downloaded as well.
- **Cache:** measurements are cached in `/data`, so re-runs are quick.
- **Memory and size:** about 1 GB of RAM while working; the image is about 1.8 GB including the
  models.

## Known limits

- **Reject flag:** see the Immich 3.4 note above.
- **Small faces:** faces under 40 px, as in group photos taken from afar, get no eyes verdict and no
  smile. The people detector still finds those people for exposure.
- **Smiles count, not how broad:** a shot with three slight smiles beats one with two big ones.
- **Starting values:** the thresholds were tuned on test bursts. Check a dry run or `calibrate` on
  your own photos.
- **Filmstrip:** it lists RAWs only. Stacks of JPEGs can still be opened in the stack window from
  Immich's photo viewer.
- **Compare stack button:** it needs the culler on the same address as Immich (the immich-raw
  container or the proxy setup). With the userscript on another address it doesn't show.
- **One library per container:** run one container per user.
