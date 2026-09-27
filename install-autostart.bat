@echo off
title Install CitCat Bot Autostart
cd /d "%~dp0"
echo ====================================================
echo    Memasang Autostart CitCat Telegram Bot ke Windows
echo ====================================================
echo.
powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $vbs = (Get-Location).Path + '\start-bot-hidden.vbs'; $s = $ws.CreateShortcut(\"$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\CitCatBot.lnk\"); $s.TargetPath = 'wscript.exe'; $s.Arguments = '\"\"' + $vbs + '\"\"'; $s.WorkingDirectory = (Get-Location).Path; $s.Description = 'Auto-start CitCat Telegram Bot'; $s.Save()"
if %errorlevel% equ 0 (
    echo [SUKSES] Shortcut autostart berhasil dipasang di Windows Startup Folder!
    echo Bot akan otomatis berjalan di latar belakang setiap kali laptop dinyalakan/login.
) else (
    echo [GAGAL] Gagal membuat shortcut autostart.
)
echo.
pause
