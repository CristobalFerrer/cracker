from __future__ import annotations

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field

from cracker_platform.services.inference_jobs import (
    InferenceJobParams,
    InferenceJobRecord,
    clear_all_runs,
    enqueue_inference_job,
    find_running_job,
    list_jobs,
    load_job,
    read_job_logs,
    save_uploaded_input,
)

router = APIRouter(prefix="/jobs", tags=["jobs"])


class InferenceJobCreate(BaseModel):
    label: str | None = Field(default=None, description="Optional label in the jobs list")
    use_tiling_for_large_images: bool = True
    target_long_edge_px: int = Field(
        default=0,
        ge=0,
        le=65535,
        description="Scale each image so max(width,height) equals this (px); 0 = native (scale 1). Other side follows aspect ratio.",
    )
    output_at_input_resolution: bool = True
    tile_overlap_percent: float = Field(
        default=25.0,
        ge=0.0,
        le=99.0,
        description="Overlap between tiles as percent of model tile width (size)",
    )
    tile_batch_size: int = Field(default=4, ge=1, le=32)
    size: int = Field(default=512, ge=64, le=1024)
    input_dir: str | None = Field(default=None, description="Override input folder (default: DeepCrack input_crops)")
    checkpoint: str | None = None
    device: str | None = Field(default=None, description='"auto", "cuda", or "cpu"')
    debug_timing: bool = False


class JobRecordResponse(BaseModel):
    id: str
    status: str
    created_at: str
    updated_at: str
    label: str | None = None
    params: dict = Field(default_factory=dict)
    output_dir: str = ""
    message: str | None = None
    exit_code: int | None = None
    resolved_input_dir: str = ""
    blocked_by: str | None = None

    @classmethod
    def from_record(cls, r: InferenceJobRecord, blocked_by: str | None = None) -> JobRecordResponse:
        return cls(
            id=r.id,
            status=r.status,
            created_at=r.created_at,
            updated_at=r.updated_at,
            label=r.label,
            params=r.params,
            output_dir=r.output_dir,
            message=r.message,
            exit_code=r.exit_code,
            resolved_input_dir=r.resolved_input_dir,
            blocked_by=blocked_by,
        )


@router.post("", response_model=JobRecordResponse)
def create_inference_job(body: InferenceJobCreate) -> JobRecordResponse:
    params = InferenceJobParams(
        use_tiling_for_large_images=body.use_tiling_for_large_images,
        target_long_edge_px=body.target_long_edge_px,
        output_at_input_resolution=body.output_at_input_resolution,
        tile_overlap_percent=body.tile_overlap_percent,
        tile_batch_size=body.tile_batch_size,
        size=body.size,
        input_dir=body.input_dir,
        checkpoint=body.checkpoint,
        device=body.device,
        debug_timing=body.debug_timing,
    )
    rec = enqueue_inference_job(body.label, params)
    return JobRecordResponse.from_record(rec)


@router.post("/from-upload", response_model=JobRecordResponse)
async def create_inference_job_from_upload(
    file: UploadFile = File(...),
    label: str | None = Form(default=None),
    use_tiling_for_large_images: bool = Form(default=True),
    tile_overlap_percent: float = Form(default=25.0),
    tile_batch_size: int = Form(default=4),
    size: int = Form(default=512),
) -> JobRecordResponse:
    """Simple path for the UI: run detection on a single uploaded photo with sane defaults."""
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")
    job_id, input_dir = save_uploaded_input(data, file.filename or "image.jpg")
    params = InferenceJobParams(
        use_tiling_for_large_images=use_tiling_for_large_images,
        output_at_input_resolution=True,
        tile_overlap_percent=tile_overlap_percent,
        tile_batch_size=tile_batch_size,
        size=size,
        input_dir=input_dir,
        debug_timing=False,
    )
    rec = enqueue_inference_job(label, params, job_id=job_id)
    return JobRecordResponse.from_record(rec)


@router.delete("/all")
def delete_all_runs() -> dict:
    """Delete all job run folders under the platform data runs directory."""
    deleted, directory = clear_all_runs()
    return {"deleted": deleted, "directory": directory}


@router.get("/{job_id}/logs")
def get_job_logs(
    job_id: str,
    tail: int = Query(
        default=120_000,
        ge=0,
        le=500_000,
        description="Max characters returned per stream (tail of each log file)",
    ),
) -> dict:
    rec = load_job(job_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="Unknown job id")
    stdout, stderr = read_job_logs(job_id, tail_chars=tail)
    return {
        "job_id": job_id,
        "status": rec.status,
        "stdout": stdout,
        "stderr": stderr,
    }


@router.get("/{job_id}", response_model=JobRecordResponse)
def get_job(job_id: str) -> JobRecordResponse:
    rec = load_job(job_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="Unknown job id")
    blocked_by = None
    if rec.status == "queued":
        running = find_running_job()
        if running and running.id != rec.id:
            blocked_by = running.id
    return JobRecordResponse.from_record(rec, blocked_by=blocked_by)


@router.get("")
def get_jobs() -> dict:
    jobs = list_jobs()
    jobs.sort(key=lambda r: r.created_at, reverse=True)
    return {"jobs": [JobRecordResponse.from_record(r).model_dump() for r in jobs]}
