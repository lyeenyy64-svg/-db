// 추심의뢰 화면에 연동된 채무자의 분류를 '추심의뢰'로, 그 외 '추심의뢰' 채무자는 '장기채권'으로 맞춘다.
//
// 사용법 (서버 PC):
//   node backend/sync_collection_category.cjs            # 미리보기 (DB 변경 없음)
//   node backend/sync_collection_category.cjs --apply    # 실제 반영 (DB 백업 + 되돌리기 파일 생성)
//
// 연동 판단은 화면(src/App.jsx applyCollectionOv)과 동일: 수동 연결 > 이름 일치(같은 브랜드 우선).
// 화면에서 '미연동'인 건은 먼저 화면에서 연결한 뒤 다시 실행한다.

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const APPLY = process.argv.includes("--apply");
const DB_PATH = process.env.DEBTFLOW_DB_PATH || path.join(__dirname, "..", "db", "debtflow.db");
const TO_COLLECTION = "추심의뢰";
const TO_OTHERS = "장기채권";

const db = new Database(DB_PATH, { readonly: !APPLY });

// 추심의뢰 원본(src/collectionData.js) + 화면에서 저장된 추가/삭제/수정/수동연결(kv_store)
const src = fs.readFileSync(path.join(__dirname, "..", "src", "collectionData.js"), "utf8")
  .replace(/export const COLLECTION_ORDERS =/, "module.exports =");
const m = { exports: [] };
new Function("module", src)(m);

const kv = (key, fallback) => {
  const row = db.prepare("SELECT value FROM kv_store WHERE key = ?").get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value) ?? fallback; } catch { return fallback; }
};
const ov = kv("collection_manual_overrides", {});
const ed = kv("collection_edits", {});
const manual = kv("collection_manual", []);
const deleted = kv("collection_deleted_ids", []);

const orders = [...m.exports, ...manual]
  .filter(o => !deleted.includes(o.id))
  .map(o => ({ ...o, ...(ed[o.id] || {}) }));

const normName = (s) => String(s || "").replace(/\(.*?\)|\s+|㈜|주식회사/g, "").toLowerCase();
const debtors = db.prepare("SELECT id, name, brand_code AS brand, category FROM debtors").all();
const byId = new Map(debtors.map(d => [d.id, d]));

const linked = new Map();   // debtorId -> order
const warn = [];
const unmatched = [];
for (const o of orders) {
  let d = null;
  if (ov[o.id] !== undefined && ov[o.id] !== null) {
    d = byId.get(ov[o.id]) || null;
  } else {
    const cands = debtors.filter(x => normName(x.name) === normName(o.debtorName));
    const same = cands.filter(x => x.brand === o.brand);
    d = same[0] || cands[0] || null;
    if (same.length > 1) warn.push(`동명이인 ${same.length}명(같은 브랜드) → 첫 번째로 연동: ${o.id} ${o.debtorName}`);
    else if (d && same.length === 0) warn.push(`브랜드 불일치 연동: ${o.id} ${o.debtorName} (의뢰 ${o.brand} / 채무자 ${d.brand})`);
  }
  if (!d) { unmatched.push(o); continue; }
  if (linked.has(d.id)) warn.push(`한 채무자에 추심의뢰 2건 연동: ${d.id} (${linked.get(d.id).id}, ${o.id})`);
  linked.set(d.id, o);
}

const toCollection = debtors.filter(d => linked.has(d.id) && d.category !== TO_COLLECTION);
const toOthers = debtors.filter(d => !linked.has(d.id) && d.category === TO_COLLECTION);
const alreadyOk = debtors.filter(d => linked.has(d.id) && d.category === TO_COLLECTION).length;

console.log(`DB: ${DB_PATH}`);
console.log(`추심의뢰 ${orders.length}건 → 연동 ${linked.size}명 (미연동 ${unmatched.length}건)`);
console.log(`  → '${TO_COLLECTION}'으로 변경: ${toCollection.length}명 (이미 '${TO_COLLECTION}': ${alreadyOk}명)`);
console.log(`  → '${TO_OTHERS}'으로 변경: ${toOthers.length}명 (연동되지 않은 기존 '${TO_COLLECTION}')`);
console.log(`반영 후 '${TO_COLLECTION}' 분류: ${linked.size}명`);
const countBy = (arr, k) => arr.reduce((a, d) => (a[d[k]] = (a[d[k]] || 0) + 1, a), {});
console.log("  변경 전 분류 분포(→추심의뢰):", countBy(toCollection, "category"));
if (unmatched.length) console.log(`미연동 ${unmatched.length}건은 화면에서 '미연동' 배지를 눌러 연결 후 다시 실행하세요.`);
warn.forEach(w => console.log("  ! " + w));

if (!APPLY) {
  console.log("\n(미리보기입니다. 실제로 반영하려면 --apply 를 붙여 다시 실행하세요.)");
  process.exit(0);
}

(async () => {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const bak = `${DB_PATH}.bak-category-${stamp}`;
  await db.backup(bak);
  const undoPath = path.join(path.dirname(DB_PATH), `category_undo_${stamp}.json`);
  const undo = [...toCollection, ...toOthers].map(d => ({ id: d.id, from: d.category }));
  fs.writeFileSync(undoPath, JSON.stringify(undo, null, 2));

  const upd = db.prepare("UPDATE debtors SET category = ?, updated_at = datetime('now', 'localtime') WHERE id = ?");
  db.transaction(() => {
    toCollection.forEach(d => upd.run(TO_COLLECTION, d.id));
    toOthers.forEach(d => upd.run(TO_OTHERS, d.id));
  })();
  console.log(`\n✓ 반영 완료. DB 백업: ${bak}`);
  console.log(`  되돌리기 정보: ${undoPath} (각 id의 이전 분류)`);
})();
