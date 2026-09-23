@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "OLLAMA_URL=http://127.0.0.1:11434"
set "OLLAMA_MODEL=qwen3:14b"
set "NEIRO_PORT=32145"

echo Neiro AI Bridge
echo Model: %OLLAMA_MODEL%
echo Port:  %NEIRO_PORT%
echo.

if exist "%~dp0tools\node\node.exe" (
  "%~dp0tools\node\node.exe" "%~dp0bridge\src\server.js"
  goto :eof
)

where node >nul 2>&1
if %ERRORLEVEL%==0 (
  node "%~dp0bridge\src\server.js"
  goto :eof
)

echo [ОШИБКА] Node.js не найден.
echo Установите Node.js с https://nodejs.org
echo или положите portable node в папку tools\node\node.exe
echo.
pause
exit /b 1
