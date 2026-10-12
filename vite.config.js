import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

// ─── 전송 구간 암호화(HTTPS) ─────────────────────────────────
// 인증서가 준비돼 있으면 3001 포트를 HTTPS(TLS 1.2 이상)로 서비스하고, HTTP 접속은 HTTPS로 넘긴다.
// 인증서 위치(우선순위): 환경변수 TLS_KEY_FILE + TLS_CERT_FILE → 사용자 폴더 .debtflow/tls/server.pfx(+ server.pfx.pass)
// 인증서가 없으면 예전처럼 HTTP로 동작한다 (setup_tls_cert.ps1 로 만들 수 있음).
function loadTls() {
  try {
    const keyFile = process.env.TLS_KEY_FILE
    const certFile = process.env.TLS_CERT_FILE
    if (keyFile && certFile) return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }
    const dir = process.env.TLS_DIR || path.join(os.homedir(), '.debtflow', 'tls')
    const pfx = path.join(dir, 'server.pfx')
    if (fs.existsSync(pfx)) {
      return { pfx: fs.readFileSync(pfx), passphrase: fs.readFileSync(path.join(dir, 'server.pfx.pass'), 'utf8').trim() }
    }
  } catch (e) {
    console.warn('[tls] 인증서를 읽지 못해 HTTP로 동작합니다:', e.message)
  }
  return null
}

const PORT = 3001
const HTTP_REDIRECT_PORT = Number(process.env.HTTP_REDIRECT_PORT) || 3000
const tls = loadTls()

// 평문 HTTP(기본 3000 포트)로 들어온 접속을 HTTPS 주소로 돌려보낸다
const httpRedirectPlugin = {
  name: 'http-to-https-redirect',
  configureServer() {
    http
      .createServer((req, res) => {
        const host = (req.headers.host || '').split(':')[0]
        res.writeHead(301, { Location: `https://${host}:${PORT}${req.url}` })
        res.end()
      })
      .on('error', (e) => console.warn(`[tls] HTTP 리다이렉트 포트(${HTTP_REDIRECT_PORT}) 사용 불가:`, e.message))
      .listen(HTTP_REDIRECT_PORT, '0.0.0.0')
  },
}

export default defineConfig({
  plugins: [react(), ...(tls ? [httpRedirectPlugin] : [])],
  server: {
    host: '0.0.0.0',
    port: PORT,
    https: tls ? { ...tls, minVersion: 'TLSv1.2' } : undefined,
    proxy: {
      '/api': {
        target: 'http://localhost:3010',
        changeOrigin: true,
        xfwd: true, // 백엔드가 원래 접속이 HTTPS였는지 알 수 있도록 X-Forwarded-* 전달
      },
    },
  },
})
