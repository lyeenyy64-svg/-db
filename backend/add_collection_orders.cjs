// 채무자를 추심의뢰 목록에 수동 추가한다 (화면의 '+ 추가'와 같은 collection_manual 형식).
//
// 사용법 (서버 PC):
//   node backend/add_collection_orders.cjs            # 미리보기 (DB 변경 없음)
//   node backend/add_collection_orders.cjs --apply    # 실제 반영 (DB 백업 생성)
//
// 추가 후 분류까지 맞추려면 sync_collection_category.cjs 를 이어서 실행한다.

const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const APPLY = process.argv.includes("--apply");
const DB_PATH = process.env.DEBTFLOW_DB_PATH || path.join(__dirname, "..", "db", "debtflow.db");

// main: 연대보증인이면 주채무자 이름 (채무자 DB에 없으면 미연동으로 추가, 브랜드·채권액은 주채무자와 동일)
const TARGETS = [
  { name: "윤은택" },
  { name: "홍정용", main: "윤은택" },
];
const AGENCY = "고려신용정보";
const REQUEST_DATE = "2026.01.21";

const BRAND_RAW = { B: "바로고", D: "딜버", M: "바다코리아", G: "그라이더", E: "에이퍼스", A2: "A2" };

const db = new Database(DB_PATH, { readonly: !APPLY });
const kv = (key, fallback) => {
  const row = db.prepare("SELECT value FROM kv_store WHERE key = ?").get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value) ?? fallback; } catch { return fallback; }
};
const manual = kv("collection_manual", []);
const ov = kv("collection_manual_overrides", {});

const findDebtor = (name) => db.prepare("SELECT id, name, brand_code AS brand, category, principal_balance AS bal FROM debtors WHERE name = ?").all(name);

const add = [];
for (const { name, main } of TARGETS) {
  const own = findDebtor(name);
  const mainCands = main ? findDebtor(main) : [];
  if (own.length > 1 || (main && mainCands.length !== 1)) {
    console.log(`! ${name}: 채무자 ${own.length}명${main ? `, 주채무자 ${main} ${mainCands.length}명` : ""} — 모호해서 건너뜀`);
    continue;
  }
  const d = own[0] || mainCands[0];   // 보증인이 채무자 DB에 없으면 주채무자의 브랜드·채권액을 따른다
  if (!d) { console.log(`! ${name}: 채무자를 찾지 못해 건너뜀`); continue; }
  if (manual.some(o => o.debtorName === name && o.agencyName === AGENCY)) {
    console.log(`- ${name}: 이미 ${AGENCY} 추심의뢰가 있어 건너뜀`);
    continue;
  }
  add.push({
    id: "CO_M_" + crypto.randomBytes(4).toString("hex"),
    agencyName: AGENCY,
    brandRaw: BRAND_RAW[d.brand] || d.brand,
    brand: d.brand,
    debtorName: name,
    debtorRole: main ? "연대보증인" : "주채무자",
    mainDebtorName: main || "",
    requestAmount: d.bal || 0,
    amountDetail: "",
    requestDate: REQUEST_DATE,
    condition: "",
    agencyPerson: "",
    agencyPhone: "",
    cost: "",
    activities: "",
    monthlyUpdates: [],
    recoveredAmount: 0,
    debtorId: own[0] ? own[0].id : null,
    createdAt: new Date().toISOString().slice(0, 10),
  });
  console.log(`+ ${name}${main ? ` (${main}의 연대보증인, ${own[0] ? "채무자 연동" : "미연동"})` : ""} (${d.id}, 브랜드 ${d.brand}, 원금잔액 ${d.bal}) → ${AGENCY}, 요청일 ${REQUEST_DATE}`);
}

if (!APPLY) {
  console.log("\n(미리보기입니다. 실제로 반영하려면 --apply 를 붙여 다시 실행하세요.)");
  process.exit(0);
}
if (!add.length) { console.log("추가할 건이 없습니다."); process.exit(0); }

(async () => {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const bak = `${DB_PATH}.bak-addorders-${stamp}`;
  await db.backup(bak);
  const put = db.prepare("INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', 'localtime')");
  db.transaction(() => {
    put.run("collection_manual", JSON.stringify([...manual, ...add]));
    const nextOv = { ...ov };
    add.forEach(o => { if (o.debtorId) nextOv[o.id] = o.debtorId; });
    put.run("collection_manual_overrides", JSON.stringify(nextOv));
  })();
  console.log(`\n✓ ${add.length}건 추가 완료. DB 백업: ${bak}`);
  console.log("  화면을 새로고침하면 보입니다. 분류를 '추심의뢰'로 맞추려면 sync_collection_category.cjs 를 실행하세요.");
})();
