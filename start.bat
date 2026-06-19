@echo off
setlocal
cd /d "%~dp0"

set "PORT=8765"
set "PYEXE="

rem --- Find Python (try python, then py) ---
where python >nul 2>nul && set "PYEXE=python"
if not defined PYEXE (
  where py >nul 2>nul && set "PYEXE=py"
)

if not defined PYEXE (
  echo.
  echo [ERROR] Python 3 was not found.
  echo This tool requires Python 3.
  echo.
  echo How to install:
  echo   1^) Download from https://www.python.org/downloads/
  echo   2^) During setup, check "Add python.exe to PATH"
  echo.
  echo If winget is available, you can also run:
  echo   winget install -e --id Python.Python.3.12
  echo.
  pause
  exit /b 1
)

echo Using Python: %PYEXE%
echo Starting the Image Triage server in a new window...
start "Image Triage Server" %PYEXE% "%~dp0app.py"

rem --- Wait a moment so the server is ready before opening the browser ---
ping -n 3 127.0.0.1 >nul

echo Opening browser at http://127.0.0.1:%PORT%/ ...
start "" "http://127.0.0.1:%PORT%/"

echo.
echo The server runs in the "Image Triage Server" window.
echo Close that window to stop the server.
echo If the browser shows "connection refused", wait a second and reload.
echo.
pause

endlocal
