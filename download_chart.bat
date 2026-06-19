@echo off
echo Downloading Chart.js into lib\...
curl -L "https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js" -o "lib\chart.min.js"
if %errorlevel%==0 (
  echo Done! chart.min.js saved to lib\
) else (
  echo FAILED. Download manually from:
  echo https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js
  echo and save it as lib\chart.min.js
)
pause
