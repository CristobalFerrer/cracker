# Creates .venv in this folder and installs PyTorch + POC dependencies.
# Usage (from codes\):
#   .\setup_venv.ps1              # CUDA 12.4 PyTorch (GPU; needs NVIDIA driver)
#   .\setup_venv.ps1 -Cpu         # CPU-only PyTorch if CUDA/DLL install fails

param(
    [switch]$Cpu
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$VenvPython = Join-Path $Root ".venv\Scripts\python.exe"
$VenvPip = Join-Path $Root ".venv\Scripts\pip.exe"

if (-not (Test-Path $VenvPython)) {
    Write-Host "Creating virtual environment in $Root\.venv ..."
    if (Get-Command py -ErrorAction SilentlyContinue) {
        py -3 -m venv .venv
    }
    if (-not (Test-Path $VenvPython)) {
        python -m venv .venv
    }
}

if (-not (Test-Path $VenvPython)) {
    Write-Error "Could not create .venv (try: python -m venv .venv)"
}

& $VenvPython -m pip install --upgrade pip wheel setuptools

if ($Cpu) {
    Write-Host "Installing PyTorch (CPU wheels)."
    & $VenvPip install torch torchvision --index-url "https://download.pytorch.org/whl/cpu"
} else {
    Write-Host "Installing PyTorch (CUDA 12.4 wheels). If import/DLL errors: .\setup_venv.ps1 -Cpu or install NVIDIA driver."
    & $VenvPip install torch torchvision --index-url "https://download.pytorch.org/whl/cu124"
}

Write-Host "Installing requirements-poc.txt ..."
& $VenvPip install -r (Join-Path $Root "requirements-poc.txt")

Write-Host ""
Write-Host "Done. Activate with:"
Write-Host "  .\.venv\Scripts\Activate.ps1"
Write-Host "Put images in input_crops\, then open poc_inference.py and Run (F5), or:"
Write-Host "  python poc_inference.py"
