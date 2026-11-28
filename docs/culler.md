# The culler

The culler is an optional service that sorts bursts and re-takes. It stacks photos of the same moment taken
close together and puts the best one in front. The others get a tag that says why they lost. Exposure
brackets get a stack of their own and are kept whole. It works on RAW files, camera JPEGs and RAW + JPEG
pairs. The results are ordinary Immich stacks and tags, so they show up everywhere in Immich. The editor's
filmstrip adds badges and controls on top.

Setup: [Installation → the culler](installation.md#optional-the-culler-auto-stack-and-best-pick). Using it: [Stacking and best pick](stacking.md).
Code: [services/culler/](../services/culler/).

## How it decides

1. **Which photos.**
   - **Auto-stack… in the editor:** the album the editor was opened from, or else the day of the
     photo being edited.
   - **Auto-stack in Immich's selection bar:** the selected photos, with the rest of any stack
     they're in (Immich shows a stack as one photo).
   - **Automatic run:** every new upload, plus the photos taken around it, so a burst uploaded in two
     parts is seen whole.
   - Trashed, hidden and locked photos are left out.
2. **Captures.** One capture is one press of the shutter:
   - A RAW and a camera JPEG with the same file name, the same camera and at most 2 s apart count as
     one capture.
   - The editor's edits of a RAW (`….edit.jpg`) belong to that RAW's capture.
   - A stack of one RAW and one JPEG (your own, or one Immich's mobile app made) is a capture too.
   - Stacks you made of several shots are left alone.
3. **Exposure brackets.** Shots whose exposure steps on purpose (for example 0, −2, +2 EV, for HDR)
   get a stack of their own. They are found before the groups, so the lighting check never sees them.
   A set counts when all of these hold:
   - the shots are at most 2 s apart (plus the previous shot's exposure time), by the same camera;
   - their camera settings (shutter speed, aperture, ISO) differ by at least 0.3 stops from each
     other, and span at least 1 stop;
   - their measured brightness follows the settings, by at least half of each step. In an automatic
     mode the camera changes its settings to keep the brightness the same, so a normal burst doesn't
     count;
   - there are at least 3 of them.

   The shot nearest the middle exposure goes in front, and every shot gets `Culling/Bracket`. None of
   them is rejected or flagged.
4. **Groups.** Captures go in the same group when all of these hold:
   - they were taken close together: at most 90 s between neighbours, by the same camera;
   - they look alike: CLIP image similarity of at least 0.88 to one of the group's last three
     shots, and at least 0.82 to its most typical shot (this keeps a slow pan from chaining into one
     endless group);
   - the group is no longer than 10 minutes and has no more than 60 shots.

   Photos that Immich itself marked as duplicates always join. CLIP is the same ViT-B/32 model Immich
   uses for smart search, with brightness evened out first, so a darker or blurred shot of the same
   scene still matches (0.92–0.99 in tests; different scenes stayed below 0.6).

   **One stack per moment.** A group is then split where a new burst shows something else, such as a
   new pose:
   - Shots at most 1.5 s apart are one burst, and a burst is never split. A jump sequence stays whole.
   - A burst after a longer pause joins the earlier moment it looks most like, when some pair of
     their shots is at least 0.94 alike. A re-take of the same pose stays in its stack.
   - Otherwise the burst starts a stack of its own, with its own best.

   0.94 is a starting value: `calibrate` shows where a new moment would start on your own photos.
5. **Ranking.** Checks run in this order, and each one only looks at the shots that survived the ones
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
       same way: the eyes when every shot has a face, else the animal when every shot shows one,
       else the sharpest areas.
   - **Exposure of RAW files is measured on the RAW file itself.** Immich renders RAW previews with
     LibRaw's automatic brightness. In a test, that made a shot 1.5 stops darker look exactly like
     the normal one in its preview. So the culler downloads the RAW and decodes it without that
     correction.
   - **Sharpness:**
     - Fine detail on a contrast-normalised image, so a darker shot isn't "softer".
     - The flattest areas' noise is subtracted, so grain doesn't count as detail.
     - Measured on the eyes of the largest face.
     - Without a face, on the largest animal: the sharpest quarter of its box, so plain fur or
       feathers don't count. A bird burst where the focus hit the branch behind no longer wins.
       The animals are COCO's ten (bird, cat, dog, horse, sheep, cow, elephant, bear, zebra,
       giraffe), found by the same object detector as people.
     - Without either, on the sharpest 5 % of the photo, so a blurred background doesn't matter.
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
   - **Close call:** when the best and the next shot have as many smiles and their mix is less than
     0.03 apart (on a 0–1 scale), the best also gets `Culling/Close call`. These are the stacks
     worth a look.
   - **Your choice comes first:** a shot you put in front yourself is always the best. So is the only
     favourite in a group. Neither is ever a close call.
   - The other survivors are runner-ups (`Culling/Runner-up`). The best gets `Culling/Best`.

## What it changes in Immich

- **One stack per group**, best in front (for a bracket: the middle exposure):
  - for a RAW + JPEG pair, the camera JPEG goes in front;
  - for an edited RAW, its edit does.
- **Tags** on every file of each capture, under `Culling/` (the root can be changed): `Best`,
  `Runner-up`, `Rejected/Lighting`, `Rejected/Blur`, `Rejected/Eyes closed` or `Bracket`. The best of
  a close call also gets `Close call`, so search for that tag to find the stacks worth a look.
  - `Culling/Rejected` itself, without a reason after it, is yours: the editor's X sets it (see
    [Workflow → Filmstrip](workflow.md#filmstrip)), and the culler never removes it.
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
  reason, whether the group is a close call (and by how much), and the measurements.

A run that finds nothing new changes nothing.

## Your changes win

| You do this in Immich or the editor | The culler then |
|---|---|
| Put another shot in front of a stack (Immich), or ★ **Make best** (filmstrip) | Keeps your choice and moves the `Best` tag to it; it also notes what it would have picked (see [Your picks](#your-picks)). When the stack is later split into moments, your pick stays in front of its own |
| Give a rejected photo stars, or remove its reject flag | Never sets the flag on it again |
| Reject a shot yourself (X in the editor, or the tag `Culling/Rejected`) | Never removes that tag, and never makes that shot the best |
| Take one of its reject tags off (U or P in the editor, or in Immich) | Leaves that shot a runner-up from then on |
| Take a photo out of a stack | Leaves that photo alone from then on |
| Delete a whole stack | Doesn't stack that group again (only **Include them** on the auto-stack page, or a run with `--force`, does) |
| Save an edit of a shot that isn't in front | The edit joins the stack without taking the front |
| Take a shot out of a stack (− on the auto-stack page) | Leaves that shot alone from then on (until **Include previously stacked pictures**) |
| Add a single photo to a stack (on the auto-stack page) | Keeps it in that stack, also when it doesn't look alike or was taken much later |

**Undo** works per run, newest run first.
- It puts back the stacks, tags, reject flags and details the run changed.
- It doesn't touch anything you changed since then; it tells you what it skipped.
- An older run can't be undone while a newer run that changed the same photos is still applied.

## Your picks

When the shot you put in front (or the only favourite) isn't the one the culler would pick, the run
notes the culler's own pick and how your shot compared. **Auto-stack…** in the editor, `python -m
culler picks` and `GET /api/v1/picks` sum this up:
- how often you chose another best, of how many stacks;
- why the culler had passed over your shot: set aside for lighting, sharpness or eyes, or a runner-up
  that lost on the mix;
- settings that would have agreed with you:
  - `blur.min_ratio` just below your softest pick;
  - `lighting.tolerance` or `max_ev_gap`;
  - `eyes.max_open_gap` for half-blinks;
  - the `[ranking]` weights that would have picked most of your runner-ups, nearest to today's.

Nothing changes by itself. A suggestion needs at least 3 of your picks behind it. It comes with the run
options to preview it (**Preview with this** in the editor, `--options` on the command line) and the
`culler.toml` lines to keep it. A suggestion only looks at your picks, and it changes other stacks too,
so look at a preview of a day or an album first.

## Using it

**In the editor, from Immich's selection, and the stack window:** see
[Stacking and best pick](stacking.md), with pictures.

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
python -m culler picks                           # how often you chose another best, and suggestions
```

`calibrate` helps tune the grouping. It lists each pair of neighbouring shots with their similarity and
time gap. It marks the pairs that would be grouped, and where a new moment would start.

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
moment_gap_s = 1.5       # a pause longer than this starts a new burst
moment_similarity = 0.94 # a burst less alike than this to every earlier moment gets its own stack; 0 = off

[brackets]
enabled = true
min_frames = 3
min_spread_ev = 1.0      # the set's exposures span at least this many stops

[blur]
min_ratio = 0.6          # reject only clearly soft shots

[ranking]
order = ["lighting", "blur", "eyes"]
respect_favorites = true
sharpness_weight = 0.45  # the mix among the shots that pass every check (sums to 1)
exposure_weight = 0.35
eyes_weight = 0.2
close_margin = 0.03      # nearer than this is a close call

[eyes]
enabled = true
max_open_gap = 0.3       # reject eyes this much less open than in the best shot (0.3 = 30 points)

[lighting]
people_first = true      # faces, or else people, count most for exposure
face_weight = 0.8

[people]
enabled = true           # people without a usable face (MediaPipe object detector)

[subjects]
enabled = true           # sharpness on the largest animal when every shot shows one
labels = ["bird", "cat", "dog", "horse"]   # default: COCO's ten animals

[smiles]
enabled = true
min_score = 0.4          # a face counts as smiling from this score
```

## Resources

- **Speed:** about 0.3 s per photo on a desktop CPU (CLIP about 70 ms, the people and animal detector
  about 30 ms). Only photos that have a neighbour within 90 s are measured.
- **Models:** CLIP, YuNet (faces), MediaPipe's face landmarker (eyes, smiles) and its object
  detector EfficientDet-Lite0 (people and animals, 7 MB). After updating to this version, a photo
  already measured is only looked at again for animals: the culler fetches its preview again, but not
  its RAW file (about 0.1 s a photo instead of 1.5 s for a RAW).
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
  your own photos. This goes most of all for `moment_similarity`, set without real portrait or sport
  sessions to check it on.
- **Animals:** only COCO's ten. The detector looks at a 320 px copy of the photo, so a small bird far
  away isn't found, and the photo's sharpest areas count instead. An animal's box also holds some
  background: a sharp branch inside it still counts. Exposure isn't judged on animals.
- **Brackets:** they need the camera's exposure settings in Immich (shutter speed, aperture, ISO).
  RAW brackets need `lighting.raw_source = "file"` (the default): Immich's auto-brightened RAW
  previews hide the steps.
- **Filmstrip:** it lists RAWs only. Stacks of JPEGs can still be opened in the stack window from
  Immich's photo viewer.
- **Compare stack and Auto-stack buttons:** they need the culler on the same address as Immich
  (the immich-raw container or the proxy setup). With the userscript on another address they don't
  show.
- **One library per container:** run one container per user.
