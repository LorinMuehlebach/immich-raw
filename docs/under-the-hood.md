# Under the hood

Your photos are decoded, edited and rendered in your browser. Nothing is processed on the server,
and no photo is sent anywhere else: the AI models are downloaded to the browser and run there.

- **Same address as Immich.** The editor is a static web app served under `/immich-raw/` on your
  Immich address. It uses your existing Immich login and talks to Immich's API directly. There is
  no separate account.
- **RAW decoding:** [LibRaw](https://www.libraw.org) compiled to WebAssembly, running in a
  background worker in the browser.
- **Rendering:** a WebGL2 pipeline in a wide linear colour space. It previews at reduced size while
  you drag a slider and renders full resolution for 100 % zoom and for saving.
- **The buttons:** a small script that the immich-raw container (or your own proxy, or a browser
  userscript) adds to Immich's pages:
  - Edit RAW in the photo viewer;
  - Compare stack there, for photos in a stack the culler made;
  - in the bar shown while photos are selected, Export and, with the culler, Auto-stack.

  To find out which photos are selected (Immich keeps only those on screen in the page), these
  buttons press Immich's download shortcut (Shift+D) and catch the request, so nothing is
  downloaded. Immich then clears its selection, as after a download.
- **Stored data:** the edit settings live in Immich's asset metadata on the RAW. Over HTTPS the
  browser keeps, in its private storage:
  - the original files, so a reopened photo isn't downloaded again;
  - their decoded half-size images (never a full-resolution one), so it isn't decoded again either;
  - how long the last opens took, per camera, for the loading screen's estimates.

  The originals and the decoded images share 800 MB, about 4–7 photos of 45–61 MP. The photos
  opened longest ago go first; the open photo stays.

  The photos before and after the open one in the filmstrip are downloaded and decoded into these
  caches in the background ([Workflow → Filmstrip](workflow.md#filmstrip)). Nothing leaves the
  browser: it is the same data Immich already serves.
- **AI masks** run small models in a background worker (ONNX Runtime and MediaPipe):
  [Masks → How AI masks work](masks.md#how-ai-masks-work).
- **AI Upscale** runs a super-resolution model the same way:
  [AI Upscale → How it works](upscale.md#how-it-works).
- **Fujifilm film looks** are community look tables, downloaded on request:
  [Editing → Fujifilm film looks](editing.md#fujifilm-film-looks).
- **The culler** is the one part that looks at photos on the server: an optional, separate
  container that sorts bursts with its own small models, on the server's CPU
  ([docs/culler.md](culler.md)).

The project layout and the test setup are in [Development](development.md).
