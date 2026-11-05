// 특정 추심업체 의뢰건의 추심요청일을 일괄 변경한다 (화면의 '수정 > 추심요청일'과 같은 collection_edits 에 기록).
//
// 사용법 (서버 PC):
//   node backend/set_collection_request_date.cjs 나라신용정보            # 미리보기, 날짜 생략 시 오늘
//   node backend/set_collection_request_date.cjs 나라신용정보 --apply    # 실제 반영 (DB 백업 생성)
//   node backend/set_collection_request_date.cjs 나라신용정보 2026.11.05 --apply
//
// 주의: 회수금액은 '추심요청일 이후 입금'으로 집계되므로 요청일을 늦추면 회수금액이 줄 수 있다.

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const pos = args.filter(a => !a.startsWith("--"));
const AGENCY = pos[0];
const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const DATE = pos[1] || `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}`;
if (!AGENCY || !/^\d{4}\.\d{2}\.\d{2}$/.test(DATE)) {
  console.log("사용법: node backend/set_collection_request_date.cjs <추심업체> [YYYY.MM.DD] [--apply]");
  process.exit(1);
}

const DB_PATH = process.env.DEBTFLOW_DB_PATH || path.join(__dirname, "..", "db", "debtflow.db");
const db = new Database(DB_PATH, { readonly: !APPLY });

const src = fs.readFileSync(path.join(__dirname, "..", "src", "collectionData.js"), "utf8")
  .replace(/export const COLLECTION_ORDERS =/, "module.exports =");
const m = { exports: [] };
new Function("module", src)(m);

const kv = (key, fallback) => {
  const row = db.prepare("SELECT value FROM kv_store WHERE key = ?").get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value) ?? fallback; } catch { return fallback; }
};
const ed = kv("collection_edits", {});
const manual = kv("collection_manual", []);
const deleted = kv("collection_deleted_ids", []);

const orders = [...m.exports, ...manual]
  .filter(o => !deleted.includes(o.id))
  .map(o => ({ ...o, ...(ed[o.id] || {}) }))
  .filter(o => o.agencyName === AGENCY);

const before = {};
orders.forEach(o => { before[o.requestDate || "(없음)"] = (before[o.requestDate || "(없음)"] || 0) + 1; });
console.log(`${AGENCY} ${orders.length}건 → 추심요청일 ${DATE}`);
console.log("  현재 요청일 분포:", before);

if (!orders.length) process.exit(0);
if (!APPLY) {
  console.log("\n(미리보기입니다. 실제로 반영하려면 --apply 를 붙여 다시 실행하세요.)");
  process.exit(0);
}

(async () => {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const bak = `${DB_PATH}.bak-reqdate-${stamp}`;
  await db.backup(bak);
  const next = { ...ed };
  orders.forEach(o => { next[o.id] = { ...(next[o.id] || {}), requestDate: DATE }; });
  db.prepare("INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', 'localtime')")
    .run("collection_edits", JSON.stringify(next));
  console.log(`\n✓ ${orders.length}건 변경 완료. DB 백업: ${bak}`);
  console.log("  되돌리려면 위 백업으로 복원하거나, 화면에서 건별로 요청일을 수정하세요.");
})();
