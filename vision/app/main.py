from __future__ import annotations

import asyncio
import logging
import os
import re
import threading
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

logger = logging.getLogger(__name__)

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, UploadFile
from pydantic import BaseModel, Field
from ultralytics import YOLO, YOLOE
from ultralytics.models.sam import SAM3SemanticPredictor

MODEL_STORAGE_DIR = Path("/app/models")
PRELOADED_MODELS = {
    "yolo11n.pt": str(MODEL_STORAGE_DIR / "yolo11n.pt"),
    "yolo26n.pt": str(MODEL_STORAGE_DIR / "yolo26n.pt"),
    "yoloe-26l-seg.pt": str(MODEL_STORAGE_DIR / "yoloe-26l-seg.pt"),
    "yoloe-26x-seg.pt": str(MODEL_STORAGE_DIR / "yoloe-26x-seg.pt"),
}


def env_flag(name: str, default: bool) -> bool:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    return raw_value.strip().lower() in {"1", "true", "yes", "on"}


def resolve_model_reference(model_reference: str) -> str:
    return PRELOADED_MODELS.get(model_reference.strip(), model_reference.strip())


VISION_MODEL = os.getenv("VISION_MODEL", "yolo26n.pt")
RESOLVED_VISION_MODEL = resolve_model_reference(VISION_MODEL)
VISION_IMG_SIZE = int(os.getenv("VISION_IMG_SIZE", "640"))
VISION_MOTION_FRAME_WIDTH = int(os.getenv("VISION_MOTION_FRAME_WIDTH", "320"))
VISION_ENABLE_MOTION_GATE = env_flag("VISION_ENABLE_MOTION_GATE", True)
VISION_DETECT_EVERY_N_FRAMES = int(os.getenv("VISION_DETECT_EVERY_N_FRAMES", "8"))
VISION_WARMUP_DETECT_FRAMES = int(os.getenv("VISION_WARMUP_DETECT_FRAMES", "2"))
VISION_TRACK_CONFIRM_FRAMES = int(os.getenv("VISION_TRACK_CONFIRM_FRAMES", "2"))
VISION_TRACK_MAX_MISSED_FRAMES = int(os.getenv("VISION_TRACK_MAX_MISSED_FRAMES", "12"))
VISION_TRACK_IOU_THRESHOLD = float(os.getenv("VISION_TRACK_IOU_THRESHOLD", "0.35"))
VISION_ROI_REFINE_ON_MOTION = env_flag("VISION_ROI_REFINE_ON_MOTION", True)
VISION_ROI_MAX_REGIONS = int(os.getenv("VISION_ROI_MAX_REGIONS", "2"))
VISION_ROI_IMG_SIZE = int(os.getenv("VISION_ROI_IMG_SIZE", "960"))
VISION_ROI_MIN_AREA_RATIO = float(os.getenv("VISION_ROI_MIN_AREA_RATIO", "0.002"))
VISION_ROI_MARGIN_RATIO = float(os.getenv("VISION_ROI_MARGIN_RATIO", "0.15"))
VISION_ENABLE_PRECISION_VERIFIER = env_flag("VISION_ENABLE_PRECISION_VERIFIER", True)
VISION_PRECISION_MODEL = os.getenv("VISION_PRECISION_MODEL", "yoloe-26x-seg.pt")
RESOLVED_VISION_PRECISION_MODEL = resolve_model_reference(VISION_PRECISION_MODEL)
VISION_PRECISION_IMG_SIZE = int(os.getenv("VISION_PRECISION_IMG_SIZE", "960"))
VISION_PRECISION_MIN_CONFIDENCE = float(
    os.getenv("VISION_PRECISION_MIN_CONFIDENCE", "0.2")
)
VISION_PRECISION_MAX_REGIONS = int(os.getenv("VISION_PRECISION_MAX_REGIONS", "3"))
VISION_PRECISION_REGION_MARGIN_RATIO = float(
    os.getenv("VISION_PRECISION_REGION_MARGIN_RATIO", "0.18")
)
VISION_ENABLE_SAM3_VERIFIER = env_flag("VISION_ENABLE_SAM3_VERIFIER", True)
VISION_SAM3_MODEL = os.getenv("VISION_SAM3_MODEL", "/app/extra-models/sam3.pt")
RESOLVED_VISION_SAM3_MODEL = resolve_model_reference(VISION_SAM3_MODEL)
VISION_SAM3_IMG_SIZE = int(os.getenv("VISION_SAM3_IMG_SIZE", "1008"))
VISION_SAM3_MIN_CONFIDENCE = float(os.getenv("VISION_SAM3_MIN_CONFIDENCE", "0.25"))
VISION_SAM3_MAX_REGIONS = int(os.getenv("VISION_SAM3_MAX_REGIONS", "2"))
VISION_SAM3_TEXT_PROMPT_LIMIT = int(os.getenv("VISION_SAM3_TEXT_PROMPT_LIMIT", "3"))

app = FastAPI(title="remote-camera-ai-vision", version="0.1.0")
SAM3_LOCK = threading.Lock()


@dataclass
class SessionRuntimeState:
    last_gray: np.ndarray | None = None
    frame_index: int = 0
    last_detection_frame: int = -10_000
    next_track_id: int = 1
    active_tracks: dict[int, "TrackState"] | None = None


@dataclass
class TrackState:
    track_id: int
    label: str
    bbox: tuple[float, float, float, float]
    streak: int
    last_seen_frame: int
    confidence: float


@dataclass
class MotionAnalysis:
    score: float
    regions: list[tuple[float, float, float, float]]


session_states: dict[str, SessionRuntimeState] = {}

SUPPORTED_TARGETS = {
    "person",
    "bicycle",
    "car",
    "motorcycle",
    "airplane",
    "bus",
    "train",
    "truck",
    "boat",
    "traffic light",
    "fire hydrant",
    "stop sign",
    "parking meter",
    "bench",
    "bird",
    "cat",
    "dog",
    "horse",
    "sheep",
    "cow",
    "elephant",
    "bear",
    "zebra",
    "giraffe",
    "backpack",
    "umbrella",
    "handbag",
    "tie",
    "suitcase",
    "frisbee",
    "skis",
    "snowboard",
    "sports ball",
    "kite",
    "baseball bat",
    "baseball glove",
    "skateboard",
    "surfboard",
    "tennis racket",
    "bottle",
    "wine glass",
    "cup",
    "fork",
    "knife",
    "spoon",
    "bowl",
    "banana",
    "apple",
    "sandwich",
    "orange",
    "broccoli",
    "carrot",
    "hot dog",
    "pizza",
    "donut",
    "cake",
    "chair",
    "couch",
    "potted plant",
    "bed",
    "dining table",
    "toilet",
    "tv",
    "laptop",
    "mouse",
    "remote",
    "keyboard",
    "cell phone",
    "microwave",
    "oven",
    "toaster",
    "sink",
    "refrigerator",
    "book",
    "clock",
    "vase",
    "scissors",
    "teddy bear",
    "hair drier",
    "toothbrush",
    "motion-only",
}

TARGET_ALIASES = {
    "human": "person",
    "people": "person",
    "man": "person",
    "woman": "person",
    "boy": "person",
    "girl": "person",
    "child": "person",
    "pedestrian": "person",
    "walker": "person",
    "bike": "bicycle",
    "cycle": "bicycle",
    "motorbike": "motorcycle",
    "scooter": "motorcycle",
    "automobile": "car",
    "sedan": "car",
    "hatchback": "car",
    "taxi": "car",
    "vehicle": "car",
    "pickup": "truck",
    "lorry": "truck",
    "coach": "bus",
    "ship": "boat",
    "pigeon": "bird",
    "dove": "bird",
    "seagull": "bird",
    "crow": "bird",
    "sparrow": "bird",
    "duck": "bird",
    "goose": "bird",
    "puppy": "dog",
    "canine": "dog",
    "kitten": "cat",
    "feline": "cat",
    "plant": "potted plant",
    "sofa": "couch",
    "table": "dining table",
    "mobile phone": "cell phone",
    "smartphone": "cell phone",
    "phone": "cell phone",
    "tv monitor": "tv",
    "television": "tv",
    "parcel": "suitcase",
    "luggage": "suitcase",
    "motion only": "motion-only",
    "movement only": "motion-only",
    "mensch": "person",
    "menschen": "person",
    "mann": "person",
    "frau": "person",
    "junge": "person",
    "maedchen": "person",
    "mädchen": "person",
    "kind": "person",
    "fussgaenger": "person",
    "fußgänger": "person",
    "fussganger": "person",
    "rad": "bicycle",
    "fahrrad": "bicycle",
    "motorrad": "motorcycle",
    "roller": "motorcycle",
    "auto": "car",
    "wagen": "car",
    "pkw": "car",
    "lieferwagen": "truck",
    "lastwagen": "truck",
    "lkw": "truck",
    "bus": "bus",
    "schiff": "boat",
    "taube": "bird",
    "vogel": "bird",
    "moewe": "bird",
    "möwe": "bird",
    "rabe": "bird",
    "spatz": "bird",
    "ente": "bird",
    "gans": "bird",
    "hund": "dog",
    "katze": "cat",
    "pflanze": "potted plant",
    "sofa": "couch",
    "tisch": "dining table",
    "handy": "cell phone",
    "mobiltelefon": "cell phone",
    "fernseher": "tv",
    "paket": "suitcase",
    "gepaeck": "suitcase",
    "gepäck": "suitcase",
    "nur bewegung": "motion-only",
}


class BoundingBox(BaseModel):
    x1: float
    y1: float
    x2: float
    y2: float


class DetectionObject(BaseModel):
    label: str
    confidence: float
    bbox: BoundingBox
    trackId: int | None = None
    trackStreak: int | None = None
    confirmed: bool = False


class AnalysisResponse(BaseModel):
    targetLabel: str
    motionScore: float
    motionDetected: bool
    triggered: bool
    objectDetectionRan: bool
    objectDetectionReason: str
    visionModel: str
    detectionMode: str
    trackingMode: str
    trackConfirmationFrames: int
    confirmedMatchCount: int
    regionRefinementUsed: bool
    precisionVerifierRan: bool
    precisionVerifierMatched: bool
    precisionVerifierModel: str | None = None
    precisionVerifierPrompt: str | None = None
    precisionVerifierMode: str | None = None
    sam3VerifierAvailable: bool = False
    sam3VerifierRan: bool = False
    sam3VerifierMatched: bool = False
    sam3VerifierModel: str | None = None
    sam3VerifierPrompt: str | None = None
    sam3VerifierMode: str | None = None
    matchedObjects: list[DetectionObject] = Field(default_factory=list)
    createdAt: str


class VisionRuntimeResponse(BaseModel):
    visionModel: str
    precisionVerifierEnabled: bool
    precisionVerifierModel: str
    sam3VerifierEnabled: bool
    sam3VerifierConfiguredModel: str
    sam3VerifierModelPresent: bool
    sam3VerifierAvailable: bool


@lru_cache(maxsize=1)
def get_model() -> YOLO:
    return YOLO(RESOLVED_VISION_MODEL)


@lru_cache(maxsize=1)
def get_precision_model() -> YOLOE:
    return YOLOE(RESOLVED_VISION_PRECISION_MODEL)


def sam3_model_available() -> bool:
    return VISION_ENABLE_SAM3_VERIFIER and Path(RESOLVED_VISION_SAM3_MODEL).is_file()


@lru_cache(maxsize=1)
def get_sam3_predictor() -> SAM3SemanticPredictor:
    predictor = SAM3SemanticPredictor(
        overrides=dict(
            conf=VISION_SAM3_MIN_CONFIDENCE,
            iou=0.6,
            task="segment",
            mode="predict",
            model=RESOLVED_VISION_SAM3_MODEL,
            imgsz=VISION_SAM3_IMG_SIZE,
            verbose=False,
        )
    )
    predictor.setup_model(model=None, verbose=False)
    return predictor


def normalize_text(raw_value: str) -> str:
    normalized = raw_value.lower().strip()
    normalized = normalized.translate(
        str.maketrans(
            {
                "ä": "ae",
                "ö": "oe",
                "ü": "ue",
                "ß": "ss",
            }
        )
    )
    return re.sub(r"\s+", " ", normalized)


def normalize_target_label(raw_target: str) -> str:
    normalized = normalize_text(raw_target)
    if not normalized:
        return "motion-only"

    if normalized in TARGET_ALIASES:
        return TARGET_ALIASES[normalized]

    if normalized in SUPPORTED_TARGETS:
        return normalized

    for phrase in sorted(TARGET_ALIASES, key=len, reverse=True):
        if re.search(rf"(^|[^a-z]){re.escape(phrase)}([^a-z]|$)", normalized):
            return TARGET_ALIASES[phrase]

    for label in sorted(SUPPORTED_TARGETS, key=len, reverse=True):
        if label == "motion-only":
            continue
        if re.search(rf"(^|[^a-z]){re.escape(label)}([^a-z]|$)", normalized):
            return label

    tokens = [token for token in re.split(r"[^a-z]+", normalized) if token]
    for token in tokens:
        if token in TARGET_ALIASES:
            return TARGET_ALIASES[token]
        if token in SUPPORTED_TARGETS:
            return token

    return normalized


PROMPT_PHRASE_TRANSLATIONS = {
    "nur bewegung": "motion only",
    "nur bewegung erkennen": "motion only",
    "bewegeung nur": "motion only",
    "auf dem": "on",
    "auf der": "on",
    "auf den": "on",
    "auf das": "on",
    "am": "on",
    "im": "in",
    "in dem": "in",
    "in der": "in",
    "mit dem": "with",
    "mit der": "with",
    "mit den": "with",
}

PROMPT_TOKEN_TRANSLATIONS = {
    "taube": "pigeon",
    "vogel": "bird",
    "moewe": "seagull",
    "rabe": "crow",
    "spatz": "sparrow",
    "ente": "duck",
    "gans": "goose",
    "mensch": "person",
    "menschen": "people",
    "mann": "man",
    "frau": "woman",
    "kind": "child",
    "junge": "boy",
    "maedchen": "girl",
    "person": "person",
    "fahrrad": "bicycle",
    "rad": "bicycle",
    "motorrad": "motorcycle",
    "roller": "scooter",
    "auto": "car",
    "wagen": "car",
    "pkw": "car",
    "lieferwagen": "delivery truck",
    "lastwagen": "truck",
    "lkw": "truck",
    "hund": "dog",
    "katze": "cat",
    "gelb": "yellow",
    "gelbe": "yellow",
    "gelber": "yellow",
    "gelben": "yellow",
    "weiss": "white",
    "weisse": "white",
    "weisser": "white",
    "weisses": "white",
    "schwarz": "black",
    "schwarze": "black",
    "schwarzer": "black",
    "schwarzes": "black",
    "jacke": "jacket",
    "gelaender": "railing",
    "gelaendern": "railings",
    "auf": "on",
    "mit": "with",
    "im": "in",
    "am": "on",
    "der": "",
    "dem": "",
    "den": "",
    "des": "",
    "die": "",
    "das": "",
    "ein": "",
    "eine": "",
    "einen": "",
    "einem": "",
    "einer": "",
}

PROMPT_STOPWORDS = {
    "der",
    "dem",
    "den",
    "des",
    "die",
    "das",
    "ein",
    "eine",
    "einen",
    "einem",
    "einer",
    "the",
    "a",
    "an",
}

PROMPT_OBJECT_SPECIALIZATIONS = {
    "bird": {
        "taube": ["pigeon", "dove"],
        "pigeon": ["pigeon", "dove"],
        "dove": ["dove", "pigeon"],
        "moewe": ["seagull", "bird"],
        "seagull": ["seagull", "bird"],
        "rabe": ["crow", "bird"],
        "crow": ["crow", "bird"],
        "spatz": ["sparrow", "bird"],
        "sparrow": ["sparrow", "bird"],
        "ente": ["duck", "bird"],
        "duck": ["duck", "bird"],
        "gans": ["goose", "bird"],
        "goose": ["goose", "bird"],
    },
    "truck": {
        "lieferwagen": ["delivery truck", "truck", "van"],
        "delivery": ["delivery truck", "truck"],
        "van": ["delivery van", "truck", "van"],
        "lkw": ["truck"],
    },
    "person": {
        "mensch": ["person"],
        "mann": ["man", "person"],
        "frau": ["woman", "person"],
        "kind": ["child", "person"],
        "junge": ["boy", "person"],
        "maedchen": ["girl", "person"],
    },
}


def dedupe_prompts(prompts: list[str]) -> list[str]:
    unique: list[str] = []
    seen: set[str] = set()
    for prompt in prompts:
        cleaned = re.sub(r"\s+", " ", prompt.strip().lower())
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        unique.append(cleaned)
    return unique


def replace_prompt_phrases(normalized: str) -> str:
    translated = normalized
    for phrase, replacement in sorted(
        PROMPT_PHRASE_TRANSLATIONS.items(), key=lambda item: len(item[0]), reverse=True
    ):
        translated = re.sub(
            rf"(^|[^a-z]){re.escape(phrase)}([^a-z]|$)",
            lambda match: f"{match.group(1)}{replacement}{match.group(2)}",
            translated,
        )
    return re.sub(r"\s+", " ", translated).strip()


def translate_prompt_phrase(raw_target: str) -> str:
    normalized = replace_prompt_phrases(normalize_text(raw_target))
    tokens = [token for token in re.split(r"[^a-z]+", normalized) if token]
    translated_tokens = []
    for token in tokens:
        if token == "motion":
            continue
        translated = PROMPT_TOKEN_TRANSLATIONS.get(token, token)
        if not translated or translated in PROMPT_STOPWORDS:
            continue
        translated_tokens.append(translated)
    return " ".join(translated_tokens).strip()


def build_precision_prompts(raw_target: str, normalized_target: str) -> list[str]:
    if normalized_target == "motion-only":
        return []

    prompts: list[str] = []
    translated_phrase = translate_prompt_phrase(raw_target)
    if translated_phrase:
        prompts.append(translated_phrase)

    normalized_raw = normalize_text(raw_target)
    raw_tokens = [token for token in re.split(r"[^a-z]+", normalized_raw) if token]
    for token in raw_tokens:
        for specialized in PROMPT_OBJECT_SPECIALIZATIONS.get(normalized_target, {}).get(
            token, []
        ):
            prompts.append(specialized)

    if translated_phrase and normalized_target not in translated_phrase.split():
        prompts.append(f"{normalized_target} {translated_phrase}")
        prompts.append(f"{translated_phrase} {normalized_target}")

    prompts.append(normalized_target)

    return dedupe_prompts(prompts)


def expand_region(
    region: tuple[float, float, float, float], image_shape: tuple[int, int, int]
) -> tuple[float, float, float, float]:
    image_height, image_width = image_shape[:2]
    x1, y1, x2, y2 = region
    width = max(1.0, x2 - x1)
    height = max(1.0, y2 - y1)
    margin_x = width * VISION_PRECISION_REGION_MARGIN_RATIO
    margin_y = height * VISION_PRECISION_REGION_MARGIN_RATIO
    return (
        max(0.0, x1 - margin_x),
        max(0.0, y1 - margin_y),
        min(float(image_width), x2 + margin_x),
        min(float(image_height), y2 + margin_y),
    )


def verification_regions(
    image_shape: tuple[int, int, int],
    candidate_matches: list[DetectionObject],
    motion_regions: list[tuple[float, float, float, float]],
) -> list[tuple[float, float, float, float]]:
    regions: list[tuple[float, float, float, float]] = []

    for item in candidate_matches:
        regions.append(
            expand_region(
                (item.bbox.x1, item.bbox.y1, item.bbox.x2, item.bbox.y2), image_shape
            )
        )

    if not regions:
        for region in motion_regions[:VISION_PRECISION_MAX_REGIONS]:
            regions.append(expand_region(region, image_shape))

    if not regions:
        image_height, image_width = image_shape[:2]
        return [(0.0, 0.0, float(image_width), float(image_height))]

    deduped: list[tuple[float, float, float, float]] = []
    for region in sorted(
        regions,
        key=lambda item: (item[2] - item[0]) * (item[3] - item[1]),
        reverse=True,
    ):
        if any(bbox_iou(region, existing) >= 0.85 for existing in deduped):
            continue
        deduped.append(region)
        if len(deduped) >= VISION_PRECISION_MAX_REGIONS:
            break

    return deduped


def dedupe_detections(matches: list[DetectionObject]) -> list[DetectionObject]:
    deduped: list[DetectionObject] = []
    for match in sorted(matches, key=lambda item: item.confidence, reverse=True):
        bbox = (match.bbox.x1, match.bbox.y1, match.bbox.x2, match.bbox.y2)
        if any(
            existing.label == match.label
            and bbox_iou(
                bbox,
                (
                    existing.bbox.x1,
                    existing.bbox.y1,
                    existing.bbox.x2,
                    existing.bbox.y2,
                ),
            )
            >= 0.65
            for existing in deduped
        ):
            continue
        deduped.append(match)
    return deduped


def decode_upload(upload: UploadFile, raw_bytes: bytes) -> np.ndarray:
    np_buffer = np.frombuffer(raw_bytes, dtype=np.uint8)
    image = cv2.imdecode(np_buffer, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"Unsupported image payload: {upload.filename}")
    return image


def runtime_state_for(session_id: str) -> SessionRuntimeState:
    if session_id not in session_states:
        session_states[session_id] = SessionRuntimeState(active_tracks={})
    return session_states[session_id]


def motion_frame(image: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    height, width = gray.shape[:2]

    if width <= VISION_MOTION_FRAME_WIDTH:
        return gray

    target_height = max(1, round(height * (VISION_MOTION_FRAME_WIDTH / width)))
    return cv2.resize(
        gray,
        (VISION_MOTION_FRAME_WIDTH, target_height),
        interpolation=cv2.INTER_AREA,
    )


def extract_motion_regions(
    delta: np.ndarray, image_shape: tuple[int, int, int]
) -> list[tuple[float, float, float, float]]:
    _, thresholded = cv2.threshold(delta, 25, 255, cv2.THRESH_BINARY)
    thresholded = cv2.dilate(thresholded, None, iterations=2)
    contours, _ = cv2.findContours(
        thresholded, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )

    delta_height, delta_width = delta.shape[:2]
    image_height, image_width = image_shape[:2]
    min_contour_area = max(4.0, delta_height * delta_width * VISION_ROI_MIN_AREA_RATIO)
    scale_x = image_width / max(delta_width, 1)
    scale_y = image_height / max(delta_height, 1)
    motion_regions: list[tuple[float, float, float, float]] = []

    for contour in contours:
        contour_area = cv2.contourArea(contour)
        if contour_area < min_contour_area:
            continue

        x, y, width, height = cv2.boundingRect(contour)
        margin_x = width * VISION_ROI_MARGIN_RATIO
        margin_y = height * VISION_ROI_MARGIN_RATIO
        x1 = max(0.0, (x - margin_x) * scale_x)
        y1 = max(0.0, (y - margin_y) * scale_y)
        x2 = min(float(image_width), (x + width + margin_x) * scale_x)
        y2 = min(float(image_height), (y + height + margin_y) * scale_y)
        motion_regions.append((x1, y1, x2, y2))

    motion_regions.sort(
        key=lambda region: (region[2] - region[0]) * (region[3] - region[1]),
        reverse=True,
    )
    return motion_regions[:VISION_ROI_MAX_REGIONS]


def compute_motion_analysis(
    session_id: str, image: np.ndarray
) -> tuple[MotionAnalysis, SessionRuntimeState]:
    state = runtime_state_for(session_id)
    gray = motion_frame(image)
    previous = state.last_gray
    state.last_gray = gray
    state.frame_index += 1

    if previous is None:
        return MotionAnalysis(score=0.0, regions=[]), state

    delta = cv2.absdiff(previous, gray)
    blurred = cv2.GaussianBlur(delta, (5, 5), 0)
    score = float(np.mean(blurred) / 255.0)
    return (
        MotionAnalysis(
            score=round(score, 4),
            regions=extract_motion_regions(blurred, image.shape),
        ),
        state,
    )


def should_run_object_detection(
    state: SessionRuntimeState, target_label: str, motion_detected: bool
) -> tuple[bool, str]:
    if target_label == "motion-only":
        return False, "motion-only-target"

    if not VISION_ENABLE_MOTION_GATE:
        return True, "motion-gate-disabled"

    if state.frame_index <= VISION_WARMUP_DETECT_FRAMES:
        return True, "warmup"

    if motion_detected:
        return True, "motion-detected"

    if (
        VISION_DETECT_EVERY_N_FRAMES > 0
        and state.frame_index - state.last_detection_frame >= VISION_DETECT_EVERY_N_FRAMES
    ):
        return True, "periodic-resync"

    return False, "motion-gate-skip"


def detect_objects(
    image: np.ndarray, target_label: str, min_confidence: float
) -> list[DetectionObject]:
    return detect_objects_for_image(
        image=image,
        target_label=target_label,
        min_confidence=min_confidence,
        imgsz=VISION_IMG_SIZE,
    )


def detect_objects_for_image(
    image: np.ndarray, target_label: str, min_confidence: float, imgsz: int
) -> list[DetectionObject]:
    model = get_model()
    prediction = model.predict(
        image,
        imgsz=imgsz,
        conf=max(min_confidence / 2, 0.1),
        verbose=False,
    )[0]

    names = prediction.names
    matches: list[DetectionObject] = []

    for box in prediction.boxes:
        cls_idx = int(box.cls.item())
        label = str(names[cls_idx]).lower()
        confidence = float(box.conf.item())

        if confidence < min_confidence:
            continue

        if target_label != "motion-only" and label != target_label:
            continue

        x1, y1, x2, y2 = box.xyxy.tolist()[0]
        matches.append(
            DetectionObject(
                label=label,
                confidence=round(confidence, 3),
                bbox=BoundingBox(x1=x1, y1=y1, x2=x2, y2=y2),
            )
        )

    return matches


def detect_objects_with_motion_regions(
    image: np.ndarray,
    target_label: str,
    min_confidence: float,
    motion_regions: list[tuple[float, float, float, float]],
) -> tuple[list[DetectionObject], bool]:
    matches = detect_objects(image, target_label, min_confidence)
    if matches or not VISION_ROI_REFINE_ON_MOTION or len(motion_regions) == 0:
        return matches, False

    refined_matches: list[DetectionObject] = []

    for x1, y1, x2, y2 in motion_regions:
        crop = image[int(y1) : int(y2), int(x1) : int(x2)]
        if crop.size == 0:
            continue

        for item in detect_objects_for_image(
            image=crop,
            target_label=target_label,
            min_confidence=min_confidence,
            imgsz=max(VISION_IMG_SIZE, VISION_ROI_IMG_SIZE),
        ):
            refined_matches.append(
                DetectionObject(
                    label=item.label,
                    confidence=item.confidence,
                    bbox=BoundingBox(
                        x1=item.bbox.x1 + x1,
                        y1=item.bbox.y1 + y1,
                        x2=item.bbox.x2 + x1,
                        y2=item.bbox.y2 + y1,
                    ),
                )
            )

    return refined_matches, len(refined_matches) > 0


def verify_with_precision_model(
    image: np.ndarray,
    raw_target: str,
    normalized_target: str,
    min_confidence: float,
    candidate_matches: list[DetectionObject],
    motion_regions: list[tuple[float, float, float, float]],
) -> tuple[list[DetectionObject], str | None, str]:
    prompts = build_precision_prompts(raw_target, normalized_target)
    if len(prompts) == 0:
        return [], None, "disabled"

    verifier = get_precision_model()
    verifier.set_classes(prompts)
    regions = verification_regions(image.shape, candidate_matches, motion_regions)
    verified: list[DetectionObject] = []
    primary_prompt = prompts[0]
    min_verifier_confidence = max(min_confidence, VISION_PRECISION_MIN_CONFIDENCE)

    for x1, y1, x2, y2 in regions:
        crop = image[int(y1) : int(y2), int(x1) : int(x2)]
        if crop.size == 0:
            continue

        prediction = verifier.predict(
            crop,
            imgsz=max(VISION_PRECISION_IMG_SIZE, VISION_IMG_SIZE),
            conf=min_verifier_confidence,
            verbose=False,
        )[0]
        names = prediction.names

        for box in prediction.boxes:
            cls_idx = int(box.cls.item())
            label = str(names[cls_idx]).lower()
            confidence = float(box.conf.item())
            if confidence < min_verifier_confidence:
                continue

            box_x1, box_y1, box_x2, box_y2 = box.xyxy.tolist()[0]
            verified.append(
                DetectionObject(
                    label=label,
                    confidence=round(confidence, 3),
                    bbox=BoundingBox(
                        x1=box_x1 + x1,
                        y1=box_y1 + y1,
                        x2=box_x2 + x1,
                        y2=box_y2 + y1,
                    ),
                )
            )

    return dedupe_detections(verified), primary_prompt, "roi-focused-open-vocabulary"


def verify_with_sam3(
    image: np.ndarray,
    raw_target: str,
    normalized_target: str,
    min_confidence: float,
    seed_matches: list[DetectionObject],
    motion_regions: list[tuple[float, float, float, float]],
) -> tuple[list[DetectionObject], str | None, str]:
    if not sam3_model_available():
        return [], None, "unavailable"

    prompts = build_precision_prompts(raw_target, normalized_target)[
        : max(1, VISION_SAM3_TEXT_PROMPT_LIMIT)
    ]
    if len(prompts) == 0:
        return [], None, "disabled"

    try:
        predictor = get_sam3_predictor()
    except Exception:
        logger.exception("sam3 predictor initialization failed")
        return [], prompts[0], "error"

    regions = verification_regions(image.shape, seed_matches, motion_regions)[
        : max(1, VISION_SAM3_MAX_REGIONS)
    ]
    verified: list[DetectionObject] = []
    primary_prompt = prompts[0]
    min_sam3_confidence = max(min_confidence, VISION_SAM3_MIN_CONFIDENCE)

    try:
        with SAM3_LOCK:
            predictor.args.conf = min_sam3_confidence
            predictor.args.imgsz = VISION_SAM3_IMG_SIZE

            for x1, y1, x2, y2 in regions:
                crop = image[int(y1) : int(y2), int(x1) : int(x2)]
                if crop.size == 0:
                    continue

                predictor.reset_image()
                predictor.reset_prompts()
                predictor.set_image(crop)
                results = predictor(text=prompts)
                if len(results) == 0 or results[0].boxes is None:
                    continue

                result = results[0]
                names = result.names
                for box in result.boxes:
                    cls_idx = int(box.cls.item())
                    label = str(names[cls_idx]).lower()
                    confidence = float(box.conf.item())
                    if confidence < min_sam3_confidence:
                        continue

                    box_x1, box_y1, box_x2, box_y2 = box.xyxy.tolist()[0]
                    verified.append(
                        DetectionObject(
                            label=label,
                            confidence=round(confidence, 3),
                            bbox=BoundingBox(
                                x1=box_x1 + x1,
                                y1=box_y1 + y1,
                                x2=box_x2 + x1,
                                y2=box_y2 + y1,
                            ),
                        )
                    )

            predictor.reset_image()
            predictor.reset_prompts()
    except Exception:
        logger.exception("sam3 predict failed")
        return [], primary_prompt, "error"

    return dedupe_detections(verified), primary_prompt, "roi-focused-concept-segmentation"


def bbox_iou(
    left: tuple[float, float, float, float], right: tuple[float, float, float, float]
) -> float:
    inter_x1 = max(left[0], right[0])
    inter_y1 = max(left[1], right[1])
    inter_x2 = min(left[2], right[2])
    inter_y2 = min(left[3], right[3])

    inter_width = max(0.0, inter_x2 - inter_x1)
    inter_height = max(0.0, inter_y2 - inter_y1)
    intersection = inter_width * inter_height
    if intersection <= 0:
        return 0.0

    left_area = max(0.0, left[2] - left[0]) * max(0.0, left[3] - left[1])
    right_area = max(0.0, right[2] - right[0]) * max(0.0, right[3] - right[1])
    union = left_area + right_area - intersection
    if union <= 0:
        return 0.0
    return intersection / union


def enrich_with_track_confirmation(
    state: SessionRuntimeState, matches: list[DetectionObject]
) -> list[DetectionObject]:
    if state.active_tracks is None:
        state.active_tracks = {}

    stale_track_ids = [
        track_id
        for track_id, track in state.active_tracks.items()
        if state.frame_index - track.last_seen_frame > VISION_TRACK_MAX_MISSED_FRAMES
    ]
    for track_id in stale_track_ids:
        state.active_tracks.pop(track_id, None)

    assigned_tracks: set[int] = set()
    enriched_matches: list[DetectionObject] = []

    for match in sorted(matches, key=lambda item: item.confidence, reverse=True):
        bbox = (match.bbox.x1, match.bbox.y1, match.bbox.x2, match.bbox.y2)
        best_track_id: int | None = None
        best_iou = 0.0

        for track_id, track in state.active_tracks.items():
            if track_id in assigned_tracks or track.label != match.label:
                continue

            overlap = bbox_iou(track.bbox, bbox)
            if overlap >= VISION_TRACK_IOU_THRESHOLD and overlap > best_iou:
                best_track_id = track_id
                best_iou = overlap

        if best_track_id is None:
            best_track_id = state.next_track_id
            state.next_track_id += 1
            track = TrackState(
                track_id=best_track_id,
                label=match.label,
                bbox=bbox,
                streak=1,
                last_seen_frame=state.frame_index,
                confidence=match.confidence,
            )
            state.active_tracks[best_track_id] = track
        else:
            track = state.active_tracks[best_track_id]
            if state.frame_index - track.last_seen_frame <= max(
                1, VISION_DETECT_EVERY_N_FRAMES
            ):
                track.streak += 1
            else:
                track.streak = 1
            track.bbox = bbox
            track.last_seen_frame = state.frame_index
            track.confidence = max(track.confidence, match.confidence)

        assigned_tracks.add(best_track_id)
        enriched_matches.append(
            DetectionObject(
                label=match.label,
                confidence=match.confidence,
                bbox=match.bbox,
                trackId=best_track_id,
                trackStreak=track.streak,
                confirmed=track.streak >= VISION_TRACK_CONFIRM_FRAMES,
            )
        )

    return enriched_matches


@app.on_event("startup")
def warm_model() -> None:
    get_model()
    if VISION_ENABLE_PRECISION_VERIFIER:
        get_precision_model()
    if sam3_model_available():
        get_sam3_predictor()


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/runtime", response_model=VisionRuntimeResponse)
def runtime() -> VisionRuntimeResponse:
    sam3_model_path = Path(RESOLVED_VISION_SAM3_MODEL)
    return VisionRuntimeResponse(
        visionModel=Path(RESOLVED_VISION_MODEL).name,
        precisionVerifierEnabled=VISION_ENABLE_PRECISION_VERIFIER,
        precisionVerifierModel=Path(RESOLVED_VISION_PRECISION_MODEL).name,
        sam3VerifierEnabled=VISION_ENABLE_SAM3_VERIFIER,
        sam3VerifierConfiguredModel=sam3_model_path.name,
        sam3VerifierModelPresent=sam3_model_path.is_file(),
        sam3VerifierAvailable=sam3_model_available(),
    )


@app.post("/analyze", response_model=AnalysisResponse)
async def analyze(
    file: UploadFile = File(...),
    session_id: str = Form(...),
    target_label: str = Form("bird"),
    min_confidence: float = Form(0.4),
    motion_threshold: float = Form(0.075),
) -> AnalysisResponse:
    raw_bytes = await file.read()
    image = decode_upload(file, raw_bytes)

    normalized_target = normalize_target_label(target_label)
    motion_analysis, state = compute_motion_analysis(session_id, image)
    motion_detected = motion_analysis.score >= motion_threshold
    object_detection_ran, detection_reason = should_run_object_detection(
        state, normalized_target, motion_detected
    )
    matched_objects: list[DetectionObject] = []
    region_refinement_used = False
    precision_verifier_ran = False
    precision_verifier_matched = False
    precision_verifier_prompt: str | None = None
    precision_verifier_mode: str | None = None
    sam3_verifier_available = sam3_model_available()
    sam3_verifier_ran = False
    sam3_verifier_matched = False
    sam3_verifier_prompt: str | None = None
    sam3_verifier_mode: str | None = None

    if object_detection_ran:
        candidate_matches, region_refinement_used = await asyncio.to_thread(
            detect_objects_with_motion_regions,
            image=image,
            target_label=normalized_target,
            min_confidence=min_confidence,
            motion_regions=motion_analysis.regions,
        )
        should_verify = (
            VISION_ENABLE_PRECISION_VERIFIER
            and normalized_target != "motion-only"
            and (motion_detected or len(candidate_matches) > 0)
        )

        if should_verify:
            precision_verifier_ran = True
            (
                precision_matches,
                precision_verifier_prompt,
                precision_verifier_mode,
            ) = await asyncio.to_thread(
                verify_with_precision_model,
                image=image,
                raw_target=target_label,
                normalized_target=normalized_target,
                min_confidence=min_confidence,
                candidate_matches=candidate_matches,
                motion_regions=motion_analysis.regions,
            )
            if len(precision_matches) > 0:
                precision_verifier_matched = True
                matched_objects = precision_matches
                if sam3_verifier_available:
                    sam3_verifier_ran = True
                    (
                        sam3_matches,
                        sam3_verifier_prompt,
                        sam3_verifier_mode,
                    ) = await asyncio.to_thread(
                        verify_with_sam3,
                        image=image,
                        raw_target=target_label,
                        normalized_target=normalized_target,
                        min_confidence=min_confidence,
                        seed_matches=precision_matches,
                        motion_regions=motion_analysis.regions,
                    )
                    if len(sam3_matches) > 0:
                        sam3_verifier_matched = True
                        matched_objects = sam3_matches
            else:
                matched_objects = []
        else:
            matched_objects = candidate_matches

        matched_objects = enrich_with_track_confirmation(state, matched_objects)
        state.last_detection_frame = state.frame_index

    confirmed_match_count = len([item for item in matched_objects if item.confirmed])
    triggered = motion_detected and (
        normalized_target == "motion-only" or confirmed_match_count > 0
    )
    detection_mode = (
        "motion-only-gate"
        if normalized_target == "motion-only"
        else "motion-gated-object-detection"
        if VISION_ENABLE_MOTION_GATE
        else "always-on-object-detection"
    )

    return AnalysisResponse(
        targetLabel=normalized_target,
        motionScore=motion_analysis.score,
        motionDetected=motion_detected,
        triggered=triggered,
        objectDetectionRan=object_detection_ran,
        objectDetectionReason=detection_reason,
        visionModel=Path(RESOLVED_VISION_MODEL).name,
        detectionMode=detection_mode,
        trackingMode="iou-track-confirmation",
        trackConfirmationFrames=VISION_TRACK_CONFIRM_FRAMES,
        confirmedMatchCount=confirmed_match_count,
        regionRefinementUsed=region_refinement_used,
        precisionVerifierRan=precision_verifier_ran,
        precisionVerifierMatched=precision_verifier_matched,
        precisionVerifierModel=(
            Path(RESOLVED_VISION_PRECISION_MODEL).name
            if precision_verifier_ran
            else None
        ),
        precisionVerifierPrompt=precision_verifier_prompt,
        precisionVerifierMode=precision_verifier_mode,
        sam3VerifierAvailable=sam3_verifier_available,
        sam3VerifierRan=sam3_verifier_ran,
        sam3VerifierMatched=sam3_verifier_matched,
        sam3VerifierModel=(
            Path(RESOLVED_VISION_SAM3_MODEL).name if sam3_verifier_available else None
        ),
        sam3VerifierPrompt=sam3_verifier_prompt,
        sam3VerifierMode=sam3_verifier_mode,
        matchedObjects=matched_objects,
        createdAt=np.datetime_as_string(np.datetime64("now"), timezone="UTC"),
    )


@app.delete("/sessions/{session_id}")
def delete_session(session_id: str) -> dict[str, bool]:
    existed = session_id in session_states
    session_states.pop(session_id, None)
    return {"ok": True, "existed": existed}
