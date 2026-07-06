@echo off
echo [DEBTFLOW] 시스템 중지 중...
pm2 stop debtflow-backend debtflow-frontend
pm2 delete debtflow-backend debtflow-frontend
echo [DEBTFLOW] 중지 완료
pause
