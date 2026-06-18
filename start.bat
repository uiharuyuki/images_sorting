@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "PORT=8765"
set "PYEXE="

rem --- Python を探す（python / py の順）---
where python >nul 2>nul && set "PYEXE=python"
if not defined PYEXE (
  where py >nul 2>nul && set "PYEXE=py"
)

if not defined PYEXE (
  echo.
  echo [!] Python が見つかりませんでした。
  echo     画像振り分けツールには Python 3 が必要です。
  echo.
  echo  インストール方法（いずれか）:
  echo    1) https://www.python.org/downloads/ からインストール
  echo    2) winget が使える場合は、この下のコメントを外して自動インストール
  echo.
  rem --- 自動インストールしたい場合は次の2行のコメント( rem )を外してください ---
  rem echo  winget で Python をインストールします...
  rem winget install -e --id Python.Python.3.12
  echo.
  pause
  exit /b 1
)

echo Python: %PYEXE%
echo 画像振り分けツールを起動します...
start "" "http://127.0.0.1:%PORT%/"
%PYEXE% "%~dp0app.py"

endlocal
