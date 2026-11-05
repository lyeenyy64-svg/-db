// update_server.bat 이 서버 재시작 전에 실행하는 1회성 데이터 작업 모음.
// 각 작업은 id 로 한 번만 실행되고(kv_store 'migrations_applied'에 기록), 실패해도 서버 재시작은 막지 않는다.
// 새 작업은 MIGRATIONS 끝에 추가한다. 이미 실행된 id 는 다시 돌지 않으므로 id 를 바꾸지 말 것.

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DB_PATH = process.env.DEBTFLOW_DB_PATH || path.join(__dirname, "..", "db", "debtflow.db");
const KEY = "migrations_applied";

const loadOrders = (db) => {
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
  const orders = [...m.exports, ...manual].filter(o => !deleted.includes(o.id)).map(o => ({ ...o, ...(ed[o.id] || {}) }));
  return { orders, ed };
};

const putKv = (db, key, value) => db.prepare(
  "INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', 'localtime')"
).run(key, JSON.stringify(value));

const MIGRATIONS = [
  {
    // 나라신용정보 의뢰건 중 요청일이 빈 건만 2026.11.05 로 채운다 (이미 입력된 날짜는 건드리지 않음)
    id: "2026-11-05-nara-request-date",
    run(db) {
      const { orders, ed } = loadOrders(db);
      const targets = orders.filter(o => o.agencyName === "나라신용정보" && !o.requestDate);
      const next = { ...ed };
      targets.forEach(o => { next[o.id] = { ...(next[o.id] || {}), requestDate: "2026.11.05" }; });
      putKv(db, "collection_edits", next);
      return `나라신용정보 ${targets.length}건 요청일 2026.11.05 기록`;
    },
  },
];

(async () => {
  const db = new Database(DB_PATH);
  let applied = [];
  try { applied = JSON.parse(db.prepare("SELECT value FROM kv_store WHERE key = ?").get(KEY)?.value || "[]"); } catch {}
  const pending = MIGRATIONS.filter(m => !applied.includes(m.id));
  if (!pending.length) { console.log("[MIGRATE] 실행할 작업 없음"); return; }

  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const bak = `${DB_PATH}.bak-migrate-${stamp}`;
  await db.backup(bak);
  console.log(`[MIGRATE] DB 백업: ${bak}`);
  for (const m of pending) {
    try {
      console.log(`[MIGRATE] ${m.id}: ${m.run(db)}`);
      applied.push(m.id);
      putKv(db, KEY, applied);
    } catch (e) {
      console.log(`[MIGRATE] ${m.id} 실패(다음 실행 때 다시 시도): ${e.message}`);
    }
  }
})().catch(e => console.log("[MIGRATE] 오류:", e.message));
