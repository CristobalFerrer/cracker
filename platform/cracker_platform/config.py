"""
Paths and defaults. Override with environment variables where noted.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Repo layout: .../Cracker/platform/cracker_platform/config.py
_PLATFORM_ROOT = Path(__file__).resolve().parents[1]
CRACKER_ROOT = Path(os.environ.get("CRACKER_ROOT", _PLATFORM_ROOT.parent)).resolve()
DEEPCRACK_CODES = Path(
    os.environ.get("DEEPCRACK_CODES", CRACKER_ROOT / "DeepCrack" / "codes")
).resolve()

# Same defaults as early POC: inference writes here, crops live here.
RESULTS_DIR = Path(os.environ.get("CRACKER_RESULTS_DIR", DEEPCRACK_CODES / "poc_results")).resolve()
INPUT_CROPS_DIR = Path(
    os.environ.get("CRACKER_INPUT_CROPS_DIR", DEEPCRACK_CODES / "input_crops")
).resolve()

# Platform data (per-run job folders).
DATA_DIR = Path(os.environ.get("CRACKER_DATA_DIR", _PLATFORM_ROOT / "data")).resolve()
RUNS_DIR = DATA_DIR / "runs"

# Python interpreter that has torch + DeepCrack deps (DeepCrack venv by default).
def _default_inference_python() -> Path:
    venv_win = DEEPCRACK_CODES / ".venv" / "Scripts" / "python.exe"
    venv_nix = DEEPCRACK_CODES / ".venv" / "bin" / "python"
    if venv_win.is_file():
        return venv_win
    if venv_nix.is_file():
        return venv_nix
    return Path(os.environ.get("PYTHON_EXECUTABLE", sys.executable))


INFERENCE_PYTHON = Path(os.environ.get("CRACKER_INFERENCE_PYTHON", _default_inference_python())).resolve()

API_TITLE = os.environ.get("CRACKER_API_TITLE", "Cracker platform API")
API_VERSION = os.environ.get("CRACKER_API_VERSION", "0.1.0")
