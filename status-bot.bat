@echo off
powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*telegram-bot*index.js*' }; if ($p) { Write-Host ('[ONLINE] CitCat Bot sedang AKTIF (PID: ' + $p.ProcessId + ')') -ForegroundColor Green } else { Write-Host '[OFFLINE] CitCat Bot TIDAK AKTIF' -ForegroundColor Red }"
pause
