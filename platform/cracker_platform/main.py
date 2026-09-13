"""
FastAPI entrypoint for the Cracker platform (visualization / data layer).

Run from the `platform` directory:
  pip install -r requirements.txt
  uvicorn cracker_platform.main:app --reload --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from cracker_platform.api.routers import health, jobs, results
from cracker_platform.config import API_TITLE, API_VERSION

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


def _infer_listen_port() -> int:
    """Best-effort port for clickable URLs (uvicorn --port, or PORT / UVICORN_PORT)."""
    for key in ("PORT", "UVICORN_PORT"):
        v = os.environ.get(key)
        if v:
            try:
                return int(v)
            except ValueError:
                break
    argv = sys.argv
    for i, arg in enumerate(argv):
        if arg == "--port" and i + 1 < len(argv):
            try:
                return int(argv[i + 1])
            except ValueError:
                break
        if arg.startswith("--port="):
            try:
                return int(arg.split("=", 1)[1])
            except ValueError:
                break
    return 8000


@asynccontextmanager
async def lifespan(app: FastAPI):
    port = _infer_listen_port()
    base = f"http://127.0.0.1:{port}"
    print(f"\n  Open in browser (ctrl+click):\n    {base}/\n    {base}/viewer\n", flush=True)
    yield


def create_app() -> FastAPI:
    app = FastAPI(title=API_TITLE, version=API_VERSION, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(health.router)
    app.include_router(results.router)
    app.include_router(jobs.router)
    if WEB_DIR.is_dir():
        app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")

        @app.get("/")
        def web_index():
            index = WEB_DIR / "index.html"
            if not index.is_file():
                return {"detail": "web/index.html missing"}
            return FileResponse(index)

        @app.get("/viewer")
        def web_viewer():
            viewer = WEB_DIR / "viewer.html"
            if not viewer.is_file():
                return {"detail": "web/viewer.html missing"}
            return FileResponse(viewer)

    return app


app = create_app()
