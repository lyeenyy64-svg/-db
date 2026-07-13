// BAROGO DEBTFLOW — DB 자동 백업
// 실행: node backup_db.cjs
// 매일 1회 실행되도록 서버 PC의 Windows 작업 스케줄러에 등록해서 사용한다.
// 저장 위치는 기본적으로 저장소 바로 바깥(부모 폴더) — 서버 PC에서는 이 저장소 자체가
// OneDrive 동기화 폴더 안에 있으므로 부모 폴더도 자동으로 OneDrive에 백업된다.
// 다른 위치를 쓰고 싶으면 backend/.env에 BACKUP_DIR=경로 를 추가하면 된다.

require("dotenv").config({ path: require("path").join(__dirname, "backend", ".env") });
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DB_PATH = path.join(__dirname, "db", "debtflow.db");
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, "..", "DebtFlow_backups");
const RETENTION_DAYS = 30;

if (!fs.existsSync(DB_PATH)) { console.error("DB 파일 없음: " + DB_PATH); process.exit(1); }
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const now = new Date();
const stamp = now.getFullYear()
  + String(now.getMonth() + 1).padStart(2, "0")
  + String(now.getDate()).padStart(2, "0") + "_"
  + String(now.getHours()).padStart(2, "0")
  + String(now.getMinutes()).padStart(2, "0")
  + String(now.getSeconds()).padStart(2, "0");
const destPath = path.join(BACKUP_DIR, `debtflow_${stamp}.db`);

// fs.copyFile 대신 sqlite의 온라인 백업 API를 사용 — 서버가 db에 쓰기 중이어도
// 손상 없이 그 시점의 정합성 있는 스냅샷을 만들어낸다.
const db = new Database(DB_PATH, { readonly: true });
db.backup(destPath)
  .then(() => {
    db.close();
    console.log(`백업 완료: ${destPath}`);

    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const removed = [];
    fs.readdirSync(BACKUP_DIR).forEach(f => {
      if (!/^debtflow_\d{8}_\d{6}\.db$/.test(f)) return;
      const fp = path.join(BACKUP_DIR, f);
      if (fs.statSync(fp).mtimeMs < cutoff) {
        fs.unlinkSync(fp);
        removed.push(f);
      }
    });
    if (removed.length) console.log(`${RETENTION_DAYS}일 초과 백업 ${removed.length}건 삭제: ` + removed.join(", "));
  })
  .catch(err => {
    db.close();
    console.error("백업 실패: " + err.message);
    process.exit(1);
  });
