@echo off
cd /d "%~dp0"
echo [%date% %time%] Starting CitCat Telegram Bot... >> bot.log
:loop
node index.js >> bot.log 2>&1
echo [%date% %time%] Bot stopped. Restarting in 10 seconds... >> bot.log
ping 127.0.0.1 -n 11 >nul
goto loop
