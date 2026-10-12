# 서버 PC에서 1회 실행: HTTPS용 자체서명 인증서를 만든다 (임시 방편).
# 사용법:  powershell -ExecutionPolicy Bypass -File setup_tls_cert.ps1 -HostName 10.10.70.65
#
# ※ 자체서명 인증서는 접속하는 PC의 브라우저가 "신뢰할 수 없는 인증서"라고 경고한다.
#   정식 운영에는 사내 인증기관(IT팀)이 발급한 인증서를 쓰고, 아래 둘 중 한 방식으로 연결한다.
#     1) 환경변수 TLS_KEY_FILE / TLS_CERT_FILE 에 PEM 파일 경로 지정
#     2) PFX 파일을 ~/.debtflow/tls/server.pfx 로, 비밀번호를 server.pfx.pass 로 저장
# 만든 뒤 pm2 restart debtflow-frontend debtflow-backend --update-env 로 재시작하면 적용된다.
param(
  [Parameter(Mandatory = $true)][string]$HostName,
  [int]$Years = 2
)
$ErrorActionPreference = "Stop"
$dir = Join-Path $env:USERPROFILE ".debtflow\tls"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$sans = @($HostName, "localhost") | Select-Object -Unique
$cert = New-SelfSignedCertificate -DnsName $sans -CertStoreLocation "Cert:\CurrentUser\My" `
  -NotAfter (Get-Date).AddYears($Years) -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
  -FriendlyName "DEBTFLOW" -KeyExportPolicy Exportable

# 무작위 비밀번호로 PFX 내보내기 (비밀번호는 같은 폴더의 .pass 파일에 보관)
$bytes = New-Object byte[] 24
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$plain = [Convert]::ToBase64String($bytes)
$secure = ConvertTo-SecureString -String $plain -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath (Join-Path $dir "server.pfx") -Password $secure | Out-Null
Set-Content -Path (Join-Path $dir "server.pfx.pass") -Value $plain -NoNewline -Encoding ascii
# 브라우저에 신뢰 등록할 때 쓰는 공개 인증서(.cer)도 내보낸다 (개인키 미포함)
Export-Certificate -Cert $cert -FilePath (Join-Path $dir "server.cer") | Out-Null

# 이 폴더는 현재 사용자만 읽을 수 있게 제한
icacls $dir /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null

Write-Host "완료: $dir"
Write-Host " - server.pfx / server.pfx.pass : 서버가 사용 (외부로 복사 금지)"
Write-Host " - server.cer : 사용자 PC에 '신뢰할 수 있는 루트 인증 기관'으로 설치하면 브라우저 경고가 사라짐"
Write-Host "이제 pm2 restart debtflow-frontend debtflow-backend --update-env 후 https://$($HostName):3001 로 접속하세요."
