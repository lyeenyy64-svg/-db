# BAROGO DEBTFLOW — DB 자동 백업 예약 등록/갱신
# update_server.bat에서 매 배포마다 호출된다. 이미 등록되어 있으면 덮어써서 갱신한다.
# schtasks.exe를 문자열로 조립하면 경로에 공백이 있을 때(예: "OneDrive - 바로고") 인자가
# 깨지기 쉬워서, 인자를 문자열이 아닌 배열로 다루는 New-ScheduledTaskAction을 사용한다.

$scriptDir = $PSScriptRoot
$backupScript = Join-Path $scriptDir "backup_db.cjs"

$action = New-ScheduledTaskAction -Execute "node.exe" -Argument "`"$backupScript`"" -WorkingDirectory $scriptDir
$trigger = New-ScheduledTaskTrigger -Daily -At (Get-Date "03:00")
Register-ScheduledTask -TaskName "DebtFlow DB Backup" -Action $action -Trigger $trigger -Force | Out-Null

Write-Output "DB 자동 백업 예약 등록 완료 (매일 03:00, 대상: $backupScript)"
