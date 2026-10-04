@echo off
title RaceTrackstar
cd /d "%~dp0"

rem Aabn browseren om 2 sekunder (naar serveren er klar)
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start https://localhost:8443"

echo.
echo  RaceTrackstar starter...
echo  Luk dette vindue for at stoppe serveren.
echo  Adressen til telefonen (samme wifi) vises herunder:
echo.
node server.js
pause
