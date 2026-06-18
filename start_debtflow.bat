@echo off
cd /d "C:\Users\hjbae\OneDrive - 바로고\문서\클로드 코드 에이전트\채권관리 시스템"

echo [DEBTFLOW] 백엔드 시작...
start "DEBTFLOW-Backend" cmd /k "node backend/server.cjs"

timeout /t 3 /nobreak >nul

echo [DEBTFLOW] 프론트엔드 시작...
start "DEBTFLOW-Frontend" cmd /k "node node_modules/vite/bin/vite.js"

echo [DEBTFLOW] 시작 완료! http://localhost:3001
