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

const kvGet = (db, key, fb) => { try { return JSON.parse(db.prepare("SELECT value FROM kv_store WHERE key = ?").get(key)?.value) ?? fb; } catch { return fb; } };
const DEBTOR_SEL = "SELECT id, name, brand_code AS brand, principal_balance AS bal, (principal_balance + adjustment - collected_amount) AS legal FROM debtors WHERE ";
const claimOf = (d) => d.bal || d.legal || 0;   // 원채무액이 0이면 법무기준잔액을 채권액으로 본다

// 이름으로 채무자 1명 특정. 정확히 1명이 아니면 예외 (→ 다음 배포 때 다시 시도).
const findOne = (db, name) => {
  let cands = db.prepare(DEBTOR_SEL + "name = ?").all(name);
  if (!cands.length) cands = db.prepare(DEBTOR_SEL + "name LIKE ?").all(name + "(%");   // '이름(보증인)' 형태 표기
  if (cands.length === 1) return cands[0];
  const list = db.prepare(DEBTOR_SEL + "REPLACE(name, ' ', '') LIKE ?").all(`%${name}%`)
    .map(c => `${c.id}:${c.name}/${c.brand}/${c.bal}`).join(", ");
  throw new Error(`${name}: 정확히 일치하는 채무자 ${cands.length}명 — 1명이어야 합니다. 이름 포함 후보: ${list || "없음"}`);
};

// 추심의뢰 목록에 수동 추가한다. main 이 있으면 그 사람의 연대보증인으로 추가(채무자 DB에 없어도 됨, 브랜드·채권액은 주채무자를 따름).
const addOrderFor = (db, name, agencyName, requestDate, main) => {
  const own = main ? db.prepare(DEBTOR_SEL + "name = ?").all(name) : [findOne(db, name)];
  if (own.length > 1) throw new Error(`${name}: 채무자 ${own.length}명 — 모호해서 건너뜀`);
  const d = own[0] || findOne(db, main);
  const manual = kvGet(db, "collection_manual", []);
  if (manual.some(o => o.debtorName === name && o.agencyName === agencyName)) return `${name}: 이미 ${agencyName} 의뢰가 있어 건너뜀`;
  const order = {
    id: "CO_M_" + crypto.randomBytes(4).toString("hex"),
    agencyName, brandRaw: BRAND_RAW[d.brand] || d.brand, brand: d.brand,
    debtorName: own[0] ? own[0].name : name, debtorRole: main ? "연대보증인" : "주채무자", mainDebtorName: main || "",
    requestAmount: claimOf(d), amountDetail: "", requestDate,
    condition: "", agencyPerson: "", agencyPhone: "", cost: "", activities: "", monthlyUpdates: [], recoveredAmount: 0,
    debtorId: own[0] ? own[0].id : null, createdAt: new Date().toISOString().slice(0, 10),
  };
  putKv(db, "collection_manual", [...manual, order]);
  if (order.debtorId) putKv(db, "collection_manual_overrides", { ...kvGet(db, "collection_manual_overrides", {}), [order.id]: order.debtorId });
  return `${order.debtorName}${main ? `(${main}의 연대보증인)` : ""} (${d.id}, 브랜드 ${d.brand}, 채권액 ${order.requestAmount}) → ${agencyName}, 요청일 ${requestDate}`;
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
  ...["김이진", "박선우", "박태경"].map(name => ({
    id: `2026-11-05-nara-add-${name}`,
    run: (db) => addOrderFor(db, name, "나라신용정보", "2025.11.20"),
  })),
  {
    // 박은은 박태경의 연대보증인 (별도 채무자 아님)
    id: "2026-11-05-nara-add-박은",
    run: (db) => addOrderFor(db, "박은", "나라신용정보", "2025.11.20", "박태경"),
  },
  {
    // 앞서 원채무액 0으로 들어간 건의 채권액을 법무기준잔액으로 보정 (0원인 건만)
    id: "2026-11-05-nara-fix-zero-amount",
    run(db) {
      const ed = kvGet(db, "collection_edits", {});
      const fixed = [];
      for (const o of kvGet(db, "collection_manual", [])) {
        if (o.agencyName !== "나라신용정보" || o.requestAmount || ed[o.id]?.requestAmount || !o.debtorId) continue;
        const d = db.prepare(DEBTOR_SEL + "id = ?").get(o.debtorId);
        if (d && claimOf(d)) { ed[o.id] = { ...(ed[o.id] || {}), requestAmount: claimOf(d) }; fixed.push(`${o.debtorName} ${claimOf(d)}`); }
      }
      putKv(db, "collection_edits", ed);
      return fixed.length ? `채권액 보정: ${fixed.join(", ")}` : "보정할 건 없음";
    },
  },
  {
    // 미래신용정보 의뢰건 전체의 추심요청일을 2026.11.09 로 통일 (기존 날짜도 덮어씀)
    id: "2026-11-09-mirae-request-date",
    run(db) {
      const { orders, ed } = loadOrders(db);
      const targets = orders.filter(o => o.agencyName === "미래신용정보");
      const next = { ...ed };
      targets.forEach(o => { next[o.id] = { ...(next[o.id] || {}), requestDate: "2026.11.09" }; });
      putKv(db, "collection_edits", next);
      return `미래신용정보 ${targets.length}건 요청일 2026.11.09 기록`;
    },
  },
  {
    // 새한신용정보 의뢰건 전체의 추심요청일을 2026.11.09 로 통일 (기존 날짜도 덮어씀)
    id: "2026-11-09-saehan-request-date",
    run(db) {
      const { orders, ed } = loadOrders(db);
      const targets = orders.filter(o => o.agencyName === "새한신용정보");
      const next = { ...ed };
      targets.forEach(o => { next[o.id] = { ...(next[o.id] || {}), requestDate: "2026.11.09" }; });
      putKv(db, "collection_edits", next);
      return `새한신용정보 ${targets.length}건 요청일 2026.11.09 기록`;
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
