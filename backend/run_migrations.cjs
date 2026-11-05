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

const crypto = require("crypto");
const BRAND_RAW = { B: "바로고", D: "딜버", M: "바다코리아", G: "그라이더", E: "에이퍼스", A2: "A2" };

// 채무자 1명을 추심의뢰 목록에 수동 추가한다. 이름이 정확히 1명으로 특정되지 않으면 예외 (→ 다음 배포 때 다시 시도).
const addOrderFor = (db, name, agencyName, requestDate) => {
  const sel = "SELECT id, name, brand_code AS brand, principal_balance AS bal FROM debtors WHERE ";
  let cands = db.prepare(sel + "name = ?").all(name);
  if (!cands.length) cands = db.prepare(sel + "name LIKE ?").all(name + "(%");   // '이름(보증인)' 형태 표기
  if (cands.length !== 1) {
    const list = db.prepare("SELECT id, name, brand_code AS brand, category, principal_balance AS bal FROM debtors WHERE REPLACE(name, ' ', '') LIKE ?").all(`%${name}%`)
      .map(c => `${c.id}:${c.name}/${c.brand}/${c.category}/${c.bal}`).join(", ");
    throw new Error(`${name}: 정확히 일치하는 채무자 ${cands.length}명 — 1명이어야 합니다. 이름 포함 후보: ${list || "없음"}`);
  }
  const d = cands[0];
  const kvGet = (key, fb) => { try { return JSON.parse(db.prepare("SELECT value FROM kv_store WHERE key = ?").get(key)?.value) ?? fb; } catch { return fb; } };
  const manual = kvGet("collection_manual", []);
  if (manual.some(o => o.debtorName === d.name && o.agencyName === agencyName)) return `${d.name}: 이미 ${agencyName} 의뢰가 있어 건너뜀`;
  const order = {
    id: "CO_M_" + crypto.randomBytes(4).toString("hex"),
    agencyName, brandRaw: BRAND_RAW[d.brand] || d.brand, brand: d.brand,
    debtorName: d.name, debtorRole: "주채무자", mainDebtorName: "",
    requestAmount: d.bal || 0, amountDetail: "", requestDate,
    condition: "", agencyPerson: "", agencyPhone: "", cost: "", activities: "", monthlyUpdates: [], recoveredAmount: 0,
    debtorId: d.id, createdAt: new Date().toISOString().slice(0, 10),
  };
  const ov = kvGet("collection_manual_overrides", {});
  putKv(db, "collection_manual", [...manual, order]);
  putKv(db, "collection_manual_overrides", { ...ov, [order.id]: d.id });
  return `${d.name}(${d.id}, 브랜드 ${d.brand}, 채권액 ${d.bal}) → ${agencyName}, 요청일 ${requestDate}`;
};

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
  // 사람별로 따로 두어, 특정이 안 되는 이름은 그 건만 다음 배포 때 다시 시도한다
  ...["김이진", "박선우", "박태경", "박은"].map(name => ({
    id: `2026-11-05-nara-add-${name}`,
    run: (db) => addOrderFor(db, name, "나라신용정보", "2025.11.20"),
  })),
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
