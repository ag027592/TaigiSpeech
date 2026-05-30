@echo off
REM TaigiSpeech local recording launcher for Windows.
REM Double-click this file to start the fully local app. No network is required.
setlocal
cd /d "%~dp0"

set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"

REM Try py.exe first; the official Python installer usually includes it.
where py >nul 2>&1
if %ERRORLEVEL%==0 (
    py -3 local_server.py %*
    goto :done
)

REM Fall back to python if py.exe is not available.
where python >nul 2>&1
if %ERRORLEVEL%==0 (
    python local_server.py %*
    goto :done
)

echo.
echo [錯誤] 找不到 Python。
echo 請到 https://www.python.org/downloads/ 安裝 Python 3 後再執行本檔。
pause
exit /b 1

:done
pause
