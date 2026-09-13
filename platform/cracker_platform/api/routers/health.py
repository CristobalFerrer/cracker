from __future__ import annotations

from fastapi import APIRouter

from cracker_platform import __version__
from cracker_platform.config import (
    API_TITLE,
    API_VERSION,
    DEEPCRACK_CODES,
    INPUT_CROPS_DIR,
    RESULTS_DIR,
)

router = APIRouter(tags=["health"])


@router.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": API_TITLE,
        "version": __version__,
        "api_version": API_VERSION,
        "paths": {
            "deepcrack_codes": str(DEEPCRACK_CODES),
            "results_dir": str(RESULTS_DIR),
            "input_crops_dir": str(INPUT_CROPS_DIR),
        },
    }
