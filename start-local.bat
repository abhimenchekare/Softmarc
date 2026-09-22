@echo off
echo.
echo ========================================
echo   Softmarc - Local Development Server
echo ========================================
echo.
echo Cleaning old files...
if exist node_modules rmdir /s /q node_modules
if exist package-lock.json del package-lock.json
if exist softmarc.db del softmarc.db

echo.
echo Installing dependencies...
call npm install

echo.
echo Starting local server...
echo.
node server-local.js
pause
