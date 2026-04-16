"""BioCLIP 2 species classifier, restricted to a curated catalogue.

Loads ``imageomics/bioclip-2`` via open_clip, precomputes text embeddings for
every entry in ``app/data/species_catalogue.json`` at construction time, then
runs cosine similarity against the image embedding for each detection crop.

Device selection:
  - Apple MPS if available (host-side future use).
  - CPU otherwise (the usual Docker path).
"""
from __future__ import annotations

import json
import logging
import os
import pathlib
from dataclasses import dataclass
from typing import Literal

import numpy as np
import torch
from PIL import Image

SpeciesMode = Literal["unavailable", "disabled", "skipped", "error", "top3"]

logger = logging.getLogger(__name__)


@dataclass
class SpeciesCandidate:
    scientificName: str
    commonName: str
    confidence: float
    taxonomyPath: str


class SpeciesClassifier:
    def __init__(self, model_id_or_path: str, catalogue_path: pathlib.Path):
        self._model = None
        self._preprocess = None
        self._tokenizer = None
        self._device = self._select_device()
        self._taxa_embeddings: torch.Tensor | None = None
        self._catalogue: list[dict] = []
        self._model_id = model_id_or_path
        self._catalogue_path = catalogue_path
        self._available = False
        self._init_error: str | None = None

        try:
            self._load()
            self._available = True
        except Exception as exc:
            logger.exception("BioCLIP 2 init failed: %s", exc)
            self._init_error = str(exc)

    @staticmethod
    def _select_device() -> torch.device:
        if torch.backends.mps.is_available():
            return torch.device("mps")
        return torch.device("cpu")

    def _load(self) -> None:
        import open_clip

        spec = (
            f"hf-hub:{self._model_id}"
            if "/" in self._model_id and not os.path.exists(self._model_id)
            else self._model_id
        )
        model, _, preprocess = open_clip.create_model_and_transforms(spec)
        tokenizer = open_clip.get_tokenizer(spec)

        model.to(self._device).float()
        model.eval()

        self._model = model
        self._preprocess = preprocess
        self._tokenizer = tokenizer

        self._catalogue = json.loads(self._catalogue_path.read_text(encoding="utf-8"))
        prompts = [self._prompt(entry) for entry in self._catalogue]
        with torch.inference_mode():
            tokens = tokenizer(prompts).to(self._device)
            text_features = model.encode_text(tokens)
            text_features = text_features / text_features.norm(dim=-1, keepdim=True)
        self._taxa_embeddings = text_features

    @staticmethod
    def _prompt(entry: dict) -> str:
        common = entry.get("commonNameEn") or entry.get("commonNameDe") or entry["scientificName"]
        return f"a photo of {common}, {entry['scientificName']}"

    @staticmethod
    def _taxonomy_path(entry: dict) -> str:
        parts = [
            "Animalia",
            "Chordata",
            entry.get("classHint", ""),
            entry.get("order", ""),
            entry.get("family", ""),
            entry["scientificName"].split(" ")[0],
            entry["scientificName"],
        ]
        return ">".join([p for p in parts if p])

    def available(self) -> bool:
        return self._available

    def classify(
        self,
        image: np.ndarray,
        bbox: tuple[float, float, float, float],
        target: str,
        min_confidence: float,
        locale: str = "de",
    ) -> tuple[list[SpeciesCandidate], SpeciesMode]:
        if not self._available or self._model is None or self._taxa_embeddings is None:
            return [], "unavailable"

        try:
            crop = self._crop(image, bbox, margin_ratio=0.10)
            if crop is None:
                return [], "skipped"
            pil = Image.fromarray(crop)
            if self._preprocess is None:
                return [], "unavailable"
            pre = self._preprocess(pil).unsqueeze(0).to(self._device)
            with torch.inference_mode():
                img_emb = self._model.encode_image(pre)
                img_emb = img_emb / img_emb.norm(dim=-1, keepdim=True)
                scores = (img_emb @ self._taxa_embeddings.T).softmax(dim=-1).squeeze(0)
            scores_np = scores.detach().cpu().numpy()
            top_idx = np.argsort(-scores_np)[:3]
            candidates: list[SpeciesCandidate] = []
            for idx in top_idx:
                conf = float(scores_np[idx])
                if conf < min_confidence:
                    continue
                entry = self._catalogue[int(idx)]
                common = entry.get("commonNameDe") if locale == "de" else entry.get("commonNameEn")
                common = common or entry.get("commonNameEn") or entry["scientificName"]
                candidates.append(
                    SpeciesCandidate(
                        scientificName=entry["scientificName"],
                        commonName=common,
                        confidence=conf,
                        taxonomyPath=self._taxonomy_path(entry),
                    )
                )
            if not candidates:
                return [], "skipped"
            return candidates, "top3"
        except Exception as exc:
            logger.exception("species classify failed: %s", exc)
            return [], "error"

    @staticmethod
    def _crop(
        image: np.ndarray,
        bbox: tuple[float, float, float, float],
        margin_ratio: float,
    ) -> np.ndarray | None:
        h, w = image.shape[:2]
        x1, y1, x2, y2 = bbox
        mw = (x2 - x1) * margin_ratio
        mh = (y2 - y1) * margin_ratio
        x1 = max(0, int(x1 - mw))
        y1 = max(0, int(y1 - mh))
        x2 = min(w, int(x2 + mw))
        y2 = min(h, int(y2 + mh))
        if x2 <= x1 or y2 <= y1:
            return None
        return image[y1:y2, x1:x2]
