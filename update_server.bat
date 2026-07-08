@echo off
cd /d "%~dp0"

echo [DEBTFLOW] GitHub에서 최신 코드 받는 중...
git pull origin master

echo.
echo [DEBTFLOW] 패키지 업데이트 확인 중...
call npm install

echo.
echo [DEBTFLOW] 서버 재시작 중...
pm2 restart debtflow-backend debtflow-frontend

echo.
echo [DEBTFLOW] 업데이트 완료!
echo.
pause
