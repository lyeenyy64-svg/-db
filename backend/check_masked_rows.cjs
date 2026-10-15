// 사용법: node backend/check_masked_rows.cjs [kv키]   (기본: manual_credit_analyses)
// DB에 저장된 행의 연락처/주민번호가 이미 "****"로 가려진 채 저장됐는지만 확인한다 (값 자체는 출력하지 않음, 읽기 전용).
const path = require("path");
const Database = require("better-sqlite3");
const piiCrypto = require("./piiCrypto.cjs");
const DB_PATH = process.env.DEBTFLOW_DB_PATH || path.join(__dirname, "..", "db", "debtflow.db");
const key = process.argv[2] || "manual_credit_analyses";
const db = new Database(DB_PATH, { readonly: true });
const row = db.prepare("SELECT value FROM kv_store WHERE key = ?").get(key);
if (!row) { console.log("키 없음:", key); process.exit(0); }
const rows = piiCrypto.decryptDeep(JSON.parse(row.value));
console.log(`${key}: ${rows.length}건  (id / 요청일 / 연락처가림 / 주민번호가림)`);
for (const x of rows) {
  console.log(String(x.id), "|", x.requestDate || "-", "|", /\*/.test(x.phone || ""), "|", /\*/.test(x.residentId || ""));
}
