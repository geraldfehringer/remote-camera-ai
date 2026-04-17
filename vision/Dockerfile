FROM python:3.13-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    YOLO_CONFIG_DIR=/tmp/Ultralytics \
    HF_HOME=/models/hf-cache \
    HOST=0.0.0.0 \
    PORT=8090

WORKDIR /app

# 1) system deps (changes rarely)
RUN apt-get update \
    && apt-get install -y --no-install-recommends git libglib2.0-0 libgl1 \
    && rm -rf /var/lib/apt/lists/*

# 2) python deps (changes on requirements.txt bump)
COPY requirements.txt ./
RUN pip install --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.txt

# 3) model weights — land in /app/models (runtime lookup path) and /models
#    (volume-mount target for HF cache). Only fires when the RUN lines
#    below are edited, so code edits under /app don't re-download ~5GB.
RUN mkdir -p /models /app/models
# yoloe-26x-seg text-prompt mode needs the mobileclip2_b.ts text encoder asset.
RUN cd /app/models \
    && python -c "from ultralytics.utils.downloads import attempt_download_asset; attempt_download_asset('mobileclip2_b.ts')"
RUN cd /app/models \
    && python -c "from ultralytics import YOLO, YOLOE; YOLO('yolo26n.pt'); YOLOE('yoloe-26x-seg.pt')"
RUN python -c "import open_clip; open_clip.create_model_and_transforms('hf-hub:imageomics/bioclip-2')" \
    || echo "bioclip preload skipped (hf unreachable at build time)"

# 4) app code last — so code edits don't invalidate the weights layer
COPY app ./app
COPY models ./extra-models

RUN useradd --create-home --shell /usr/sbin/nologin app \
    && chown -R app:app /app /home/app /models

USER app

EXPOSE 8090
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8090"]
