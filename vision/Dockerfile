FROM python:3.13-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    YOLO_CONFIG_DIR=/tmp/Ultralytics \
    HOST=0.0.0.0 \
    PORT=8090

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends git libglib2.0-0 libgl1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.txt

COPY app ./app
COPY models ./extra-models

RUN mkdir -p /app/models \
    && python -c "from ultralytics.utils.downloads import attempt_download_asset; attempt_download_asset('mobileclip2_b.ts')" \
    && cd /app/models \
    && python -c "from ultralytics import YOLO, YOLOE; YOLO('yolo11n.pt'); YOLO('yolo26n.pt'); YOLOE('yoloe-26l-seg.pt'); YOLOE('yoloe-26x-seg.pt')"

RUN useradd --create-home --shell /usr/sbin/nologin app \
    && chown -R app:app /app /home/app

USER app

EXPOSE 8090
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8090"]
