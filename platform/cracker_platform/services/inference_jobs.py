from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from cracker_platform.config import (
    DEEPCRACK_CODES,
    INFERENCE_PYTHON,
    INPUT_CROPS_DIR,
    RUNS_DIR,
)

JobStatus = Literal["queued", "running", "succeeded", "failed"]


@dataclass
class InferenceJobParams:
    use_tiling_for_large_images: bool = True
    target_long_edge_px: int = 0
    output_at_input_resolution: bool = True
    tile_overlap_percent: float = 25.0
    tile_batch_size: int = 4
    size: int = 512
    input_dir: str | None = None
    checkpoint: str | None = None
    device: str | None = None
    debug_timing: bool = False


@dataclass
class InferenceJobRecord:
    id: str
    status: JobStatus
    created_at: str
    updated_at: str
    label: str | None = None
    params: dict[str, Any] = field(default_factory=dict)
    output_dir: str = ""
    message: str | None = None
    exit_code: int | None = None
    resolved_input_dir: str = ""


_job_lock = threading.Lock()


def _meta_path(job_id: str) -> Path:
    return RUNS_DIR / job_id / "meta.json"


def _write_meta(rec: InferenceJobRecord) -> None:
    p = _meta_path(rec.id)
    p.parent.mkdir(parents=True, exist_ok=True)
    rec.updated_at = datetime.now(timezone.utc).isoformat()
    p.write_text(json.dumps(asdict(rec), indent=2), encoding="utf-8")


def load_job(job_id: str) -> InferenceJobRecord | None:
    p = _meta_path(job_id)
    if not p.is_file():
        return None
    d = json.loads(p.read_text(encoding="utf-8"))
    return InferenceJobRecord(**d)


def list_jobs() -> list[InferenceJobRecord]:
    if not RUNS_DIR.is_dir():
        return []
    out: list[InferenceJobRecord] = []
    for child in sorted(RUNS_DIR.iterdir(), key=lambda x: x.name, reverse=True):
        if not child.is_dir():
            continue
        rec = load_job(child.name)
        if rec:
            out.append(rec)
    return out


def find_running_job() -> InferenceJobRecord | None:
    """First job currently in the 'running' state, if any (jobs run one at a time)."""
    for rec in list_jobs():
        if rec.status == "running":
            return rec
    return None


def _append_job_stdout(job_id: str, line: str) -> None:
    """Append a line to the run's stdout.log (same file the UI polls)."""
    p = RUNS_DIR / job_id / "stdout.log"
    try:
        with open(p, "a", encoding="utf-8", errors="replace") as f:
            f.write(line if line.endswith("\n") else line + "\n")
            f.flush()
    except OSError:
        pass


def _pump_pipe_to_file(stream, log_path: Path) -> None:
    try:
        with open(log_path, "a", encoding="utf-8", errors="replace") as f:
            for line in iter(stream.readline, ""):
                f.write(line)
                f.flush()
    finally:
        try:
            stream.close()
        except OSError:
            pass


def _run_subprocess(job_id: str, params_path: Path) -> int:
    cli = DEEPCRACK_CODES / "run_job_cli.py"
    if not cli.is_file():
        raise FileNotFoundError(f"Missing {cli}")
    if not INFERENCE_PYTHON.is_file():
        raise FileNotFoundError(
            f"Inference python not found: {INFERENCE_PYTHON}. "
            "Set CRACKER_INFERENCE_PYTHON or create DeepCrack/codes/.venv"
        )
    log_dir = RUNS_DIR / job_id
    out_path = log_dir / "stdout.log"
    err_path = log_dir / "stderr.log"
    out_path.write_text("", encoding="utf-8")
    err_path.write_text("", encoding="utf-8")

    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env["CRACKER_POC_PROGRESS"] = "1"

    cmd = [str(INFERENCE_PYTHON), "-u", str(cli), str(params_path)]
    proc = subprocess.Popen(
        cmd,
        cwd=str(DEEPCRACK_CODES),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        bufsize=1,
    )
    assert proc.stdout is not None and proc.stderr is not None
    t_out = threading.Thread(target=_pump_pipe_to_file, args=(proc.stdout, out_path), daemon=True)
    t_err = threading.Thread(target=_pump_pipe_to_file, args=(proc.stderr, err_path), daemon=True)
    t_out.start()
    t_err.start()
    code = int(proc.wait())
    t_out.join(timeout=120)
    t_err.join(timeout=120)
    return code


def clear_all_runs() -> tuple[int, str]:
    """
    Remove every subdirectory under RUNS_DIR (job outputs, logs, meta).
    Preserves RUNS_DIR itself and non-directory files (e.g. .gitkeep).
    """
    root = RUNS_DIR.resolve()
    if not root.is_dir():
        root.mkdir(parents=True, exist_ok=True)
        return 0, str(root)
    n = 0
    for child in list(root.iterdir()):
        if child.is_dir():
            shutil.rmtree(child, ignore_errors=False)
            n += 1
    root.mkdir(parents=True, exist_ok=True)
    return n, str(root)


def read_job_logs(job_id: str, tail_chars: int = 120_000) -> tuple[str, str]:
    """Return (stdout_tail, stderr_tail) for a run directory."""
    log_dir = RUNS_DIR / job_id
    out_path = log_dir / "stdout.log"
    err_path = log_dir / "stderr.log"

    def _tail(p: Path) -> str:
        if not p.is_file():
            return ""
        raw = p.read_text(encoding="utf-8", errors="replace")
        if tail_chars <= 0 or len(raw) <= tail_chars:
            return raw
        return raw[-tail_chars:]

    return _tail(out_path), _tail(err_path)


def _worker_thread(job_id: str) -> None:
    rec = load_job(job_id)
    if rec is None:
        return
    try:
        rec.status = "running"
        rec.message = "Running DeepCrack inference…"
        _write_meta(rec)

        params_path = RUNS_DIR / job_id / "params.json"
        code = _run_subprocess(job_id, params_path)

        rec = load_job(job_id)
        if rec is None:
            msg = f"[cracker] Done: job {job_id} subprocess exited ({code}) but meta.json is missing."
            _append_job_stdout(job_id, msg)
            print(msg, flush=True)
            return
        rec.exit_code = code
        if code == 0:
            rec.status = "succeeded"
            rec.message = "Finished. Load outputs in the viewer."
            msg = f"[cracker] Done: job {job_id} finished successfully (platform worker)."
            _append_job_stdout(job_id, msg)
            print(msg, flush=True)
        else:
            rec.status = "failed"
            rec.message = f"Inference exited with code {code}. See stderr.log in run folder."
            msg = f"[cracker] Done: job {job_id} failed (exit code {code}, platform worker)."
            _append_job_stdout(job_id, msg)
            print(msg, flush=True)
        _write_meta(rec)
    except Exception as e:  # noqa: BLE001
        rec = load_job(job_id)
        if rec:
            rec.status = "failed"
            rec.message = str(e)
            _write_meta(rec)
        msg = f"[cracker] Done: job {job_id} failed with error: {e}"
        _append_job_stdout(job_id, msg)
        print(msg, flush=True)


def enqueue_inference_job(label: str | None, params: InferenceJobParams) -> InferenceJobRecord:
    job_id = str(uuid.uuid4())
    run_dir = RUNS_DIR / job_id
    outputs = run_dir / "outputs"
    outputs.mkdir(parents=True, exist_ok=True)

    inp = params.input_dir or str(INPUT_CROPS_DIR)
    ck = params.checkpoint or str(DEEPCRACK_CODES / "checkpoints" / "DeepCrack_CT260_FT1.pth")

    payload: dict[str, Any] = {
        "input_dir": inp,
        "output_dir": str(outputs),
        "checkpoint": ck,
        "device": params.device,
        "size": params.size,
        "use_tiling_for_large_images": params.use_tiling_for_large_images,
        "output_at_input_resolution": params.output_at_input_resolution,
        "tile_overlap_percent": params.tile_overlap_percent,
        "tile_batch_size": params.tile_batch_size,
        "debug_timing": params.debug_timing,
    }
    if params.target_long_edge_px > 0:
        payload["target_long_edge_px"] = int(params.target_long_edge_px)

    (run_dir / "params.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")

    now = datetime.now(timezone.utc).isoformat()
    rec = InferenceJobRecord(
        id=job_id,
        status="queued",
        created_at=now,
        updated_at=now,
        label=label,
        params=asdict(params),
        output_dir=str(outputs),
        message="Queued",
        resolved_input_dir=inp,
    )
    _write_meta(rec)

    def _run() -> None:
        with _job_lock:
            _worker_thread(job_id)

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return rec
