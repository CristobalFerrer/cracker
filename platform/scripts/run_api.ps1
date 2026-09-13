# Run the platform API (working directory: Cracker/platform) and open the browser once it's ready.
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$Port = 8000
$HealthUrl = "http://127.0.0.1:$Port/health"
$OpenUrl = "http://127.0.0.1:$Port/"

# Poll in the background while uvicorn runs in the foreground, then open the default browser.
Start-Job -ScriptBlock {
    param($HealthUrl, $OpenUrl)
    for ($i = 0; $i -lt 60; $i++) {
        try {
            $r = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 2
            if ($r.StatusCode -eq 200) {
                Start-Process $OpenUrl
                return
            }
        } catch {
            Start-Sleep -Seconds 1
        }
    }
} -ArgumentList $HealthUrl, $OpenUrl | Out-Null

if (Test-Path ".\.venv\Scripts\python.exe") {
    & ".\.venv\Scripts\python.exe" -m uvicorn cracker_platform.main:app --reload --host 0.0.0.0 --port $Port
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
    py -3 -m uvicorn cracker_platform.main:app --reload --host 0.0.0.0 --port $Port
} else {
    python -m uvicorn cracker_platform.main:app --reload --host 0.0.0.0 --port $Port
}
