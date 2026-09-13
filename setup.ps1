# One-time setup for Cracker: creates both Python environments, installs dependencies,
# and checks for the DeepCrack model weights. Safe to re-run any time.
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Step($msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}

function New-VenvIfMissing($Dir) {
    $VenvPy = Join-Path $Dir ".venv\Scripts\python.exe"
    if (Test-Path $VenvPy) {
        return $VenvPy
    }
    Write-Host "Creating virtual environment in $Dir\.venv ..."
    Push-Location $Dir
    try {
        if (Get-Command py -ErrorAction SilentlyContinue) {
            py -3 -m venv .venv
        } else {
            python -m venv .venv
        }
    } finally {
        Pop-Location
    }
    if (-not (Test-Path $VenvPy)) {
        throw "Could not create a virtual environment in `"$Dir`". Make sure Python 3.10+ is installed and on PATH."
    }
    return $VenvPy
}

function Invoke-Pip($PyExe, $PipArgs, $ErrorMessage) {
    & $PyExe -m pip @PipArgs
    if ($LASTEXITCODE -ne 0) {
        throw $ErrorMessage
    }
}

try {
    Write-Host ""
    Write-Host "Cracker setup" -ForegroundColor Green
    Write-Host "============="
    Write-Host "This installs everything Cracker needs. It only has to run once per computer."

    if (-not (Get-Command py -ErrorAction SilentlyContinue) -and -not (Get-Command python -ErrorAction SilentlyContinue)) {
        Write-Host ""
        Write-Host "Python was not found on this computer." -ForegroundColor Yellow
        Write-Host "1. Install Python 3.10 or newer from the page that just opened."
        Write-Host "2. On the FIRST installer screen, check the box 'Add python.exe to PATH'."
        Write-Host "3. Run this setup.bat again."
        Start-Process "https://www.python.org/downloads/"
        throw "Python is required but was not found."
    }

    Step "Setting up the web app"
    $PlatformDir = Join-Path $Root "platform"
    $PlatformPy = New-VenvIfMissing $PlatformDir
    Invoke-Pip $PlatformPy @("install", "--upgrade", "pip") "Could not upgrade pip in the platform environment."
    Invoke-Pip $PlatformPy @("install", "-r", (Join-Path $PlatformDir "requirements.txt")) "Could not install the web app's dependencies."

    $CodesDir = Join-Path $Root "DeepCrack\codes"
    $CodesVenvPy = Join-Path $CodesDir ".venv\Scripts\python.exe"
    if (Test-Path $CodesVenvPy) {
        Step "Crack-detection environment already set up - leaving it as-is"
        Write-Host "(Found $CodesVenvPy. Delete that .venv folder first if you want setup to rebuild it.)"
    } else {
        Step "Setting up crack detection (downloads PyTorch - this can take several minutes)"
        $SetupVenvScript = Join-Path $CodesDir "setup_venv.ps1"
        & $SetupVenvScript -Cpu
        if ($LASTEXITCODE -ne 0) {
            throw "Setting up the crack-detection environment failed (see messages above)."
        }
    }

    Step "Checking for the DeepCrack model weights"
    $CheckpointDir = Join-Path $CodesDir "checkpoints"
    $CheckpointPath = Join-Path $CheckpointDir "DeepCrack_CT260_FT1.pth"
    New-Item -ItemType Directory -Force -Path $CheckpointDir | Out-Null
    if (Test-Path $CheckpointPath) {
        Write-Host "Found: $CheckpointPath"
    } else {
        Write-Host ""
        Write-Host "One manual step left: Cracker needs a one-time ~120 MB model download." -ForegroundColor Yellow
        Write-Host "1. Download the file from the page that just opened in your browser."
        Write-Host "2. Save it into the folder that just opened, with this exact name:"
        Write-Host "     DeepCrack_CT260_FT1.pth"
        Start-Process "https://drive.google.com/file/d/1OO3OAzR4yxYh_UBR9Nu7hV3XayfKVyO-/view?usp=sharing"
        Start-Process "explorer.exe" $CheckpointDir
    }

    Write-Host ""
    Write-Host "Setup complete." -ForegroundColor Green
    Write-Host "Next: double-click run.bat - Cracker will start and open in your browser."
    Write-Host ""
    Write-Host "(Have an NVIDIA GPU and want faster detection? After setup, run:"
    Write-Host "  DeepCrack\codes\use_cuda_torch.ps1"
    Write-Host "from a PowerShell window.)"
} catch {
    Write-Host ""
    Write-Host "Setup did not finish: $($_.Exception.Message)" -ForegroundColor Red
} finally {
    Write-Host ""
    Read-Host "Press Enter to close this window"
}
