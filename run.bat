@echo off
REM Start Cracker and open it in your browser.
title Cracker
if not exist "%~dp0platform\.venv\Scripts\python.exe" (
    echo.
    echo Cracker hasn't been set up yet on this computer.
    echo Double-click setup.bat first, then come back and run this again.
    echo.
    pause
    exit /b 1
)
call "%~dp0platform\scripts\run_api.bat"
