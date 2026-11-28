# Culler

Stacks bursts and re-takes in Immich, one stack per moment, puts the best shot in front and tags why
the others lost (lighting, sharpness, closed eyes). Exposure brackets are kept whole, and near-ties are
marked as close calls. How it decides, its settings and the command line:
[docs/culler.md](../../docs/culler.md). Setup next to Immich:
[Installation → the culler](../../docs/installation.md#optional-the-culler-auto-stack-and-best-pick).

## Development

Python 3.12 with [uv](https://docs.astral.sh/uv/):

```sh
uv sync
uv run pytest                       # unit tests (the RAW tests also need Node, for e2e/raw-burst.mjs)
uv run ruff check src tests && uv run ruff format src tests
CULLER_MODELS_DIR=<dir> uv run python -m culler fetch-models   # CLIP, YuNet, MediaPipe (~370 MB)
```

To run it against the test Immich, see [e2e/README.md](../../e2e/README.md#the-culler).

Layout of `src/culler/`:

- **Measuring:** `features/` — exposure (on the RAW file for RAWs; photo, faces and people apart),
  sharpness (eyes, animal or photo), faces with eyes and smiles, people and animals (`people.py`), CLIP
  embedding.
- **Deciding (pure, tested on their own):**
  - `frames.py`: captures;
  - `brackets.py`: exposure brackets;
  - `grouping.py`: scenes and their moments;
  - `checks.py`, `ranking.py`: the best shot, close calls, and what the culler would pick instead of
    yours;
  - `suggest.py`: settings that would agree with your picks;
  - `planner.py`: what to change in Immich, and undo.
- **Doing:** `immich.py` holds every Immich route. Around it:
  - `executor.py` applies the changes;
  - `runner.py` runs everything in order;
  - `store.py` is the SQLite state in `/data`.
- **Serving:**
  - `api.py`, `auth.py`: the HTTP API, behind the proxy at `/immich-raw/culler/`;
  - `watcher.py`: new uploads;
  - `service.py`: one worker thread;
  - `__main__.py`: the command line.
- **Tooling:** `scripts/make_burst.py` makes the test bursts for `e2e/cull.mjs`.
