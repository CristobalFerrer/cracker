# Cracker

Pavement crack detection: a web viewer/UI (FastAPI + a browser page) on top of **DeepCrack**, a
pretrained crack-segmentation model, shipped together as one repository.

## Quick start (Windows, no programming experience needed)

1. **Download or clone this repository**, keeping its folder structure intact.
2. **Double-click `setup.bat`.** It installs everything Cracker needs (this only has to run once,
   and takes a few minutes — mostly downloading PyTorch). It will also tell you if a manual step
   is needed (see "Model weights" below).
3. **Double-click `run.bat`.** It starts Cracker and opens it in your browser automatically.

That's it. Leave the black console window open while you use Cracker; closing it stops the server.

### Model weights (one manual step)

Cracker needs a pretrained model file that isn't part of this repository (too large for GitHub).
`setup.bat` checks for it and, if missing, opens the download page and the destination folder for
you automatically. Save the file as:

```
DeepCrack\codes\checkpoints\DeepCrack_CT260_FT1.pth
```

See `DeepCrack/POC_README.md` for the download link and details.

### Have an NVIDIA GPU?

`setup.bat` installs the CPU version of PyTorch by default, since it works on any computer.
If you have an NVIDIA GPU and want faster detection, after setup run this from a PowerShell window:

```powershell
DeepCrack\codes\use_cuda_torch.ps1
```

## Repository layout

| Path | Role |
|------|------|
| `platform/` | FastAPI app (`cracker_platform`), web UI under `platform/web/`, job data under `platform/data/` |
| `DeepCrack/codes/` | Inference scripts (`poc_inference.py`, `run_job_cli.py`), checkpoints, `input_crops`, default `poc_results` |

The platform **does not import torch**. Jobs run DeepCrack in a **subprocess** using a Python
interpreter you configure (see below). They stay separate so the API stays lightweight while
inference can use its own Python/torch environment.

`DeepCrack/` is a vendored (patched) copy of [qinnzou/DeepCrack](https://github.com/qinnzou/DeepCrack) —
see `DeepCrack/README.md` for upstream details and `DeepCrack/POC_README.md` for the inference
script this platform drives.

## Manual setup (developers)

If you'd rather set things up by hand instead of using `setup.bat`, there are **two different**
`.venv` folders by design:

1. **`platform/.venv`** — for **running the web API** (FastAPI, uvicorn). Create from the `platform` directory:
   ```powershell
   cd platform
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install -r requirements.txt
   ```
2. **`DeepCrack/codes/.venv`** — for **inference** (torch, OpenCV, DeepCrack). From `DeepCrack/codes`:
   ```powershell
   cd DeepCrack\codes
   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
   .\setup_venv.ps1          # CPU-only PyTorch
   # or: .\setup_venv.ps1 -Cpu is the same; omit -Cpu for CUDA 12.4 PyTorch (needs an NVIDIA driver)
   ```

**Override:** set `CRACKER_INFERENCE_PYTHON` to any `python.exe` that has torch + DeepCrack deps (full path).

### Run the web app manually

From `platform/` (or use `platform/scripts/run_api.ps1` / `run_api.bat`, which `cd` there first and
open your browser once the server responds):

```powershell
cd platform
.\.venv\Scripts\python.exe -m uvicorn cracker_platform.main:app --reload --host 0.0.0.0 --port 8000
```

Open **http://localhost:8000/**.

## Configuration (environment variables)

All paths default relative to this repo; override when you move trees apart.

| Variable | Purpose |
|----------|---------|
| `CRACKER_ROOT` | Root that contains `DeepCrack/` (default: parent of `platform/`) |
| `DEEPCRACK_CODES` | Directory with `run_job_cli.py` (default: `CRACKER_ROOT/DeepCrack/codes`) |
| `CRACKER_INFERENCE_PYTHON` | `python.exe` used to run jobs (default: `DEEPCRACK_CODES/.venv/...` if present, else current interpreter) |
| `CRACKER_DATA_DIR` | Platform job runs (default: `platform/data`) |
| `CRACKER_RESULTS_DIR` | Legacy results folder for `/results` without `run_id` (default: `DeepCrack/codes/poc_results`) |
| `CRACKER_INPUT_CROPS_DIR` | Default ortho crops for jobs (default: `DeepCrack/codes/input_crops`) |

## Inference jobs (high level)

1. Browser **POST /jobs** → worker writes `platform/data/runs/<uuid>/` (`params.json`, logs, `outputs/`).
2. Worker runs: `CRACKER_INFERENCE_PYTHON` + `DeepCrack/codes/run_job_cli.py` + `params.json`, cwd = `DeepCrack/codes`.
3. UI polls job status and log files under that run folder.

## Sharing this repo

Clone or download the **whole `Cracker` folder** so both `platform/` and `DeepCrack/` stay siblings,
then follow "Quick start" above. Nothing needs to be installed globally — everything lives in the
two `.venv` folders `setup.bat` creates, and the model checkpoint is a one-time manual download
(not committed to git — see "Model weights" above).
