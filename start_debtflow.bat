@echo off
cd /d "C:\Users\hjbae\OneDrive - 바로고\문서\클로드 코드 에이전트\채권관리 시스템"

echo [DEBTFLOW] PM2로 시작 중...
pm2 start ecosystem.config.cjs

echo.
echo [DEBTFLOW] 시작 완료! http://localhost:3001
echo [DEBTFLOW] 창을 닫아도 시스템은 계속 실행됩니다.
echo [DEBTFLOW] 중지하려면 stop_debtflow.bat 실행
echo.
pause
