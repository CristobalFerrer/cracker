from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from cracker_platform.api.security import safe_file_under_root
from cracker_platform.config import INPUT_CROPS_DIR, RESULTS_DIR, RUNS_DIR

router = APIRouter(prefix="/results", tags=["results"])


def _results_root(run_id: str | None) -> Path:
    if run_id:
        root = (RUNS_DIR / run_id / "outputs").resolve()
        if not root.is_dir():
            raise HTTPException(status_code=404, detail="Unknown run_id or outputs missing")
        return root
    return RESULTS_DIR.resolve()


@router.get("")
def list_results(run_id: str | None = Query(default=None, description="Job id → list that run's outputs")):
    root = _results_root(run_id)
    if not root.is_dir():
        return {"directory": str(root), "exists": False, "run_id": run_id, "files": []}
    files = []
    for p in sorted(root.iterdir()):
        if p.is_file():
            files.append(
                {
                    "name": p.name,
                    "size_bytes": p.stat().st_size,
                    "suffix": p.suffix.lower(),
                }
            )
    return {"directory": str(root), "exists": True, "run_id": run_id, "files": files}


@router.get("/file/{filename}")
def get_result_file(
    filename: str,
    run_id: str | None = Query(default=None),
):
    root = _results_root(run_id)
    path = safe_file_under_root(filename, root)
    if path is None or not path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(path, filename=path.name)


def _resolve_input_root(dir_override: str | None) -> Path:
    """Directory to browse for input images: a job's own input_dir if given, else the default."""
    if dir_override:
        try:
            return Path(dir_override).resolve()
        except OSError:
            return INPUT_CROPS_DIR
    return INPUT_CROPS_DIR


@router.get("/inputs/list")
def list_input_crops(dir: str | None = Query(default=None, description="Override input directory (e.g. a run's resolved input_dir)")) -> dict:
    root = _resolve_input_root(dir)
    if not root.is_dir():
        return {"directory": str(root), "exists": False, "files": []}
    files = []
    for p in sorted(root.iterdir()):
        if p.is_file() and p.name != ".gitkeep":
            files.append(
                {
                    "name": p.name,
                    "size_bytes": p.stat().st_size,
                    "suffix": p.suffix.lower(),
                }
            )
    return {"directory": str(root), "exists": True, "files": files}


@router.get("/inputs/file/{filename}")
def get_input_crop_file(filename: str, dir: str | None = Query(default=None)):
    root = _resolve_input_root(dir)
    path = safe_file_under_root(filename, root)
    if path is None or not path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(path, filename=path.name)
