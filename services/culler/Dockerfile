# Culler container: HTTP API + upload watcher, models baked in.
# Build from this folder:
#   docker build -t immich-culler services/culler

FROM python:3.12-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.12.12 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
RUN uv sync --frozen --no-dev

FROM build AS models
# Downloads are checked against the hashes pinned in src/culler/model_files.py.
RUN CULLER_MODELS_DIR=/models /app/.venv/bin/python -m culler fetch-models

FROM python:3.12-slim
# MediaPipe loads EGL/GLES at import, even when it runs on the CPU.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libegl1 libgles2 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 1001 --home-dir /data culler && mkdir -p /data && chown culler /data
WORKDIR /app
COPY --from=build /app /app
COPY --from=models /models /models
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    CULLER_DATA_DIR=/data \
    CULLER_MODELS_DIR=/models \
    OPENBLAS_NUM_THREADS=2 \
    OMP_NUM_THREADS=2
USER culler
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/immich-raw/culler/api/v1/health', timeout=4)"
CMD ["python", "-m", "culler", "serve"]
