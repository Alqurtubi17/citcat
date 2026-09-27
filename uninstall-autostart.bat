@echo off
title Uninstall CitCat Bot Autostart
cd /d "%~dp0"
echo ====================================================
echo    Menghapus Autostart CitCat Telegram Bot
echo ====================================================
echo.
powershell -NoProfile -Command "Remove-Item -Path \"$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\CitCatBot.lnk\" -Force -ErrorAction SilentlyContinue"
echo [OK] Autostart di Startup folder telah dihapus.
echo.
pause
