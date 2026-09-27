@echo off
echo Menghentikan CitCat Telegram Bot...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*telegram-bot*index.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('[OK] Berhasil menghentikan bot (PID: ' + $_.ProcessId + ')') -ForegroundColor Green }"
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*start-bot.bat*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo Selesai.
pause
