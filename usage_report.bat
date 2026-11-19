@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo [DEBTFLOW] 조혜원 사용 내역 집계 중... (읽기 전용, 최근 60일)
node backend\usage_report.cjs > usage_report_last.log 2>&1
type usage_report_last.log
echo.
echo 결과 파일: %~dp0usage_report_last.log
echo.
pause
