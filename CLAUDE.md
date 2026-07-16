# BAROGO DEBTFLOW — NPL 채권관리 시스템

## 배포 아키텍처
- **개발 PC**: 이 저장소가 있는 PC (kimjw 계정)
- **운영 서버**: `10.10.70.65:3001` — 별도의 물리 PC (buser 계정), PM2로 `debtflow-backend`/`debtflow-frontend` 프로세스 실행 ([ecosystem.config.cjs](ecosystem.config.cjs))
- **파이썬 OCR**: 서버 PC에 Python 3.13 + PyMuPDF + winrt(Windows OCR) 설치되어 있어야 함 (`backend/ocr_*.py`). `backend/server.cjs`의 `PYTHON_BIN`은 PATH에서 `pythonw.exe`를 찾으므로 서버 계정이 바뀌어도 코드 수정 불필요 — PATH에 없으면 `backend/.env`의 `PYTHON_BIN`으로 절대경로 지정.
- **배포 방법**: 서버 PC에서 [update_server.bat](update_server.bat) 실행 → `git pull` + `npm install` + `pm2 restart`. 이 저장소에서 서버 PC로의 원격 접근 수단(SSH 등)은 없음 — 배포 반영은 항상 서버 PC에 직접 가서 배치파일을 실행해야 함.

## 커밋/푸시 정책
사용자가 요청한 하나의 기능/작업 단위가 완료되면, 별도로 매번 확인받지 않고 자동으로 `git add` → `git commit` → `git push origin master`를 수행한다.
- 커밋 메시지는 저장소의 기존 스타일(한글, `type: 설명` 형식)을 따른다.
- 여러 개의 작은 수정을 모아 하나의 논리적 단위로 커밋하되, 단위가 끝나면 지체 없이 push한다.
- push 이후 실제 운영 서버(10.10.70.65:3001) 반영은 자동화되어 있지 않으므로, 배포가 필요한 시점에는 사용자에게 서버 PC에서 `update_server.bat` 실행이 필요함을 알려준다.
