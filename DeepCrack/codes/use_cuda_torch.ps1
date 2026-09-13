# Reinstall PyTorch + torchvision with CUDA 12.4 wheels into the existing .venv.
# Run from DeepCrack\codes after activating venv (or use full paths below).
# If import fails, install latest NVIDIA driver and VC++ redistributables, or use setup_venv.ps1 -Cpu.

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$VenvPip = Join-Path $Root ".venv\Scripts\pip.exe"
if (-not (Test-Path $VenvPip)) {
    Write-Error ".venv not found. Run .\setup_venv.ps1 first."
}
Write-Host "Uninstalling CPU/CUDA torch (if any) ..."
& $VenvPip uninstall -y torch torchvision 2>$null
Write-Host "Installing PyTorch CUDA 12.4 wheels ..."
& $VenvPip install torch torchvision --index-url "https://download.pytorch.org/whl/cu124"
Write-Host "Verifying import ..."
& (Join-Path $Root ".venv\Scripts\python.exe") -c "import torch; print('torch', torch.__version__); print('cuda available', torch.cuda.is_available()); print('device count', torch.cuda.device_count())"
