# BAROGO DEBTFLOW — NPL 채권관리 시스템

## 배포 아키텍처
- **개발 PC**: 이 저장소가 있는 PC (kimjw 계정)
- **운영 서버**: `10.10.70.65:3001` — 별도의 물리 PC (buser 계정), PM2로 `debtflow-backend`/`debtflow-frontend` 프로세스 실행 ([ecosystem.config.cjs](ecosystem.config.cjs))
- **파이썬 OCR**: 서버 PC에 Python 3.13 + PyMuPDF + winrt(Windows OCR) 설치되어 있어야 함 (`backend/ocr_*.py`). `backend/server.cjs`의 `PYTHON_BIN`은 PATH에서 `pythonw.exe`를 찾으므로 서버 계정이 바뀌어도 코드 수정 불필요 — PATH에 없으면 `backend/.env`의 `PYTHON_BIN`으로 절대경로 지정.
- **배포 방법**: 서버 PC에서 [update_server.bat](update_server.bat) 실행 → `git pull` + `npm install` + `pm2 restart`. 이 저장소에서 서버 PC로의 원격 접근 수단(SSH 등)은 없음 — 배포 반영은 항상 서버 PC에 직접 가서 배치파일을 실행해야 함.

## 개인정보보호 조치 (서버 PC 설정)
- **로그인/2단계 인증**: 서버가 계정·세션을 관리하고 로그인 때 Slack DM으로 일회용 코드를 보낸다 (봇에 `users:read.email`, `chat:write` 필요). Slack 장애로 아무도 로그인 못 하면 `backend/.env`에 `AUTH_2FA=off` 후 재시작. 비밀번호 분실 비상 복구: `node backend/set_password.cjs <이름|이메일> <새비밀번호>`.
- **암호화 키**: 주민번호는 AES-256-GCM으로 암호화 저장. 키는 서버 계정의 `~/.debtflow/pii.key`(최초 실행 시 자동 생성) 또는 `PII_ENC_KEY`/`PII_ENC_KEY_FILE`. 저장소·OneDrive 밖에 따로 보관할 것 — 분실하면 복구 불가.
- **HTTPS**: `setup_tls_cert.ps1 -HostName <서버IP>`로 인증서를 만들면 vite(3001)가 HTTPS로 뜨고 3000 포트의 HTTP는 HTTPS로 넘어간다. 전원 HTTPS 접속 확인 후 `backend/.env`에 `REQUIRE_HTTPS=on`.
- **접속기록**: 누가·언제·무엇을(조회/수정/삭제/다운로드/원문열람/로그인 등) 했는지 앱 DB와 별도 파일(`~/.debtflow/audit/audit.db`)에 해시 체인으로 기록, 개인정보 원문은 남기지 않는다. 마스터 계정은 어드민 > 접속기록에서 조회·무결성 검증·이상 행위 확인. 보관 기간 기본 730일 — 법정 기준은 정보보안팀/법무팀 확인값으로 `AUDIT_RETENTION_DAYS` 조정. 이 파일도 백업 대상에 포함할 것. 해시는 키가 있는 HMAC이고 키는 접속기록 폴더의 `audit.key`(또는 `AUDIT_HMAC_KEY`) — DB 파일과 분리해 별도 보관·백업할 것(분실 시 이후 기록 검증 불가). 마지막 행 서명은 `audit.head`에 남아 꼬리 삭제도 검증된다.
- **시크릿 규칙**: API 키·토큰·비밀번호·암호화 키는 코드/저장소에 넣지 않는다. 서버 PC의 `backend/.env`(또는 환경변수)에만 두고, 새 키를 추가하면 `backend/.env.example`에 자리표시자만 적는다. 개발 PC에서는 `git config core.hooksPath .githooks`로 커밋 전 비밀값 검사(`scripts/check_secrets.cjs`)를 켠다. `.env` 내용이나 키 값을 채팅/메신저에 붙여넣지 말 것. 키가 노출됐다면 즉시 폐기·재발급하고 이 저장소의 git 이력에 남은 값은 "이미 유출된 것"으로 취급한다.

## 커밋/푸시 정책
사용자가 요청한 하나의 기능/작업 단위가 완료되면, 별도로 매번 확인받지 않고 자동으로 `git add` → `git commit` → `git push origin master`를 수행한다.
- 커밋 메시지는 저장소의 기존 스타일(한글, `type: 설명` 형식)을 따른다.
- 여러 개의 작은 수정을 모아 하나의 논리적 단위로 커밋하되, 단위가 끝나면 지체 없이 push한다.
- push 이후 실제 운영 서버(10.10.70.65:3001) 반영은 자동화되어 있지 않으므로, 배포가 필요한 시점에는 사용자에게 서버 PC에서 `update_server.bat` 실행이 필요함을 알려준다.
