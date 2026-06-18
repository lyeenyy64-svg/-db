# DEBTFLOW 배포 가이드

## 사전 요구사항
- Node.js 18 이상 (`node -v` 로 확인)
- npm (`npm -v` 로 확인)

Node.js 설치가 안 되어 있으면:
```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# macOS (Homebrew)
brew install node
```

---

## 1단계: 프로젝트 설치 (1분)

```bash
# 압축 해제 후 폴더 이동
cd debtflow

# 패키지 설치
npm install
```

---

## 2단계: 개발 모드 실행 (즉시 확인용)

```bash
npm run dev
```

실행 후 터미널에 아래와 같이 표시됩니다:
```
  VITE v8.x.x  ready in xxx ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: http://192.168.x.x:5173/
```

**같은 네트워크의 다른 PC에서** `http://서버IP:5173` 으로 접속하면 바로 볼 수 있습니다.

---

## 3단계: 프로덕션 빌드 + 배포 (권장)

```bash
# 빌드 (dist/ 폴더에 정적 파일 생성)
npm run build

# 프리뷰 서버 실행 (port 4173)
npm run preview
```

또는 빌드된 `dist/` 폴더를 Nginx로 서빙:

```nginx
# /etc/nginx/sites-available/debtflow
server {
    listen 80;
    server_name 내부서버IP;

    root /path/to/debtflow/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/debtflow /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## 4단계: 백그라운드 실행 (서버 재시작 후에도 유지)

### 방법 A: PM2 사용 (권장)
```bash
# PM2 설치
npm install -g pm2

# 프리뷰 서버를 PM2로 실행
pm2 start "npm run preview" --name debtflow

# 서버 재시작 시 자동 실행 설정
pm2 startup
pm2 save
```

### 방법 B: systemd 서비스
```bash
sudo cat > /etc/systemd/system/debtflow.service << 'EOF'
[Unit]
Description=DEBTFLOW Debt Management App
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/path/to/debtflow
ExecStart=/usr/bin/npx vite preview --host 0.0.0.0 --port 4173
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable debtflow
sudo systemctl start debtflow
```

---

## 접속 확인

| 환경 | URL |
|------|-----|
| 개발 모드 | http://서버IP:5173 |
| 프로덕션 | http://서버IP:4173 (preview) 또는 http://서버IP (nginx) |

---

## 현재 상태

이 버전은 **프론트엔드 데모**입니다:
- 600명 채무자 데이터는 브라우저에서 랜덤 생성 (새로고침 시 재생성)
- 엑셀 업로드, CSV 업로드, 서류 첨부는 시뮬레이션 (실제 파일 처리 아님)
- Slack 인증은 미적용 (추후 백엔드 구현 시 추가)

채권관리팀 피드백 반영 후 백엔드(Node.js + SQLite + Slack OAuth)를 추가 구현하면
실제 운영 가능한 시스템이 됩니다.

---

## 문의
경영전략실 AX | 이지민 | Slack @이지민
