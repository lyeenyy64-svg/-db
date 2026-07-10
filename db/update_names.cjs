// db/update_names.cjs
// 채무자 리스트 최종.xlsx 기준으로 DB의 채무자 이름을 갱신
// 실행: node db/update_names.cjs
// - hub_code를 고유 키로 사용하여 이름 업데이트
// - 새 레코드(최종 파일에만 있는 것)는 INSERT

const Database = require("better-sqlite3");
const XLSX = require("xlsx");
const path = require("path");

const DB_PATH = path.join(__dirname, "debtflow.db");
const OLD_XLSX = path.join(__dirname, "채무자 관리 데이터.xlsx");
const NEW_XLSX = path.join(__dirname, "채무자 리스트 최종.xlsx");

const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");

const isEmpty = (v) =>
  v == null || v === "" || v === " " || v === "　" || v === "-" || v === "－";
const cleanStr = (v) =>
  isEmpty(v)
    ? null
    : String(v).trim().replace(/\r\n/g, " ").replace(/\n/g, " ").replace(/\s+/g, " ");

// 컬럼 인덱스 (헤더 행: index 1, 데이터 행: index 2~)
// index 0=빈칸, 1=브렌드, 2=분류, 3=담당, 4=채무자명, 5=연대보증인,
//        6=연락처, 7=코드, 8=허브/지점명, 9=채무발생원인, 10=재무추심상태
const COL = {
  brand: 1, category: 2, assignee: 3, name: 4,
  guarantor: 5, phone: 6, code: 7, hubName: 8,
  cause: 9, status: 10,
};

function readExcelRows(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
}

// ── 구 Excel에서 코드 → 이름 맵 구성 ────────────────────────────────
console.log("[1/4] 구 Excel 로드:", OLD_XLSX);
const oldRows = readExcelRows(OLD_XLSX);

const oldMap = new Map(); // code → name
for (let i = 2; i < oldRows.length; i++) {
  const row = oldRows[i];
  const code = cleanStr(row[COL.code]);
  const name = cleanStr(row[COL.name]);
  if (code && name) oldMap.set(code, name);
}
console.log(`     로드된 레코드: ${oldMap.size}개`);

// ── 신 Excel에서 코드 → 전체 행 맵 구성 ─────────────────────────────
console.log("[2/4] 신 Excel 로드:", NEW_XLSX);
const newRows = readExcelRows(NEW_XLSX);

const newMap = new Map(); // code → { name, row }
for (let i = 2; i < newRows.length; i++) {
  const row = newRows[i];
  const code = cleanStr(row[COL.code]);
  const name = cleanStr(row[COL.name]);
  if (code && name) newMap.set(code, { name, row });
}
console.log(`     로드된 레코드: ${newMap.size}개`);

// ── DB에서 현재 채무자 목록 로드 ─────────────────────────────────────
// hub_code는 브랜드 간(때로는 같은 브랜드 내에서도) 중복될 수 있는 값이라 고유 키로 쓸 수 없다.
// (setup.cjs도 동일한 이유로 byHubCode를 code → [id...] 배열로 관리한다.)
// 여기서는 code로 후보를 모은 뒤, 후보가 여럿이면 브랜드로 좁히고, 그래도 모호하면
// 잘못된 채무자 이름을 덮어쓰지 않도록 업데이트를 건너뛴다.
console.log("[3/4] DB에서 채무자 로드");
const dbDebtors = db.prepare("SELECT id, hub_code, brand_code, name FROM debtors").all();
const dbByHubCode = new Map(); // hub_code → [{ id, brand_code, name }, ...]
for (const d of dbDebtors) {
  if (!d.hub_code) continue;
  const key = String(d.hub_code).trim();
  if (!dbByHubCode.has(key)) dbByHubCode.set(key, []);
  dbByHubCode.get(key).push(d);
}
console.log(`     DB 레코드: ${dbDebtors.length}개`);

// ── 변경 사항 처리 ───────────────────────────────────────────────────
console.log("[4/4] 이름 업데이트 및 신규 삽입");

const updateStmt = db.prepare(
  "UPDATE debtors SET name = ?, updated_at = datetime('now','localtime') WHERE id = ?"
);

const insertStmt = db.prepare(`
  INSERT INTO debtors (
    id, brand_code, category, assignee, name, phone,
    hub_code, hub_name, debt_cause, collection_status,
    principal_balance, adjustment, collected_amount
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)
`);

let updated = 0, inserted = 0, skipped = 0, unchanged = 0, ambiguous = 0;

const tx = db.transaction(() => {
  for (const [code, { name: newName, row }] of newMap.entries()) {
    const brand = cleanStr(row[COL.brand]) || "B";
    const candidates = dbByHubCode.get(code) || [];
    let dbRecord = null;
    if (candidates.length === 1) {
      dbRecord = candidates[0];
    } else if (candidates.length > 1) {
      const byBrand = candidates.filter(d => d.brand_code === brand);
      if (byBrand.length === 1) {
        dbRecord = byBrand[0];
      } else {
        console.warn(`  [모호함] 코드=${code}에 해당하는 채무자가 ${candidates.length}명 있어 이름을 업데이트하지 않고 건너뜀`);
        ambiguous++;
        continue;
      }
    }

    if (!dbRecord) {
      // 신규 레코드 INSERT
      const category = cleanStr(row[COL.category]) || "장기채권";
      const assignee = cleanStr(row[COL.assignee]) || "";
      const phone = cleanStr(row[COL.phone]) || "";
      const hubName = cleanStr(row[COL.hubName]) || "";
      const cause = cleanStr(row[COL.cause]) || "";
      const status = cleanStr(row[COL.status]) || "추심진행";

      const newId = `NPL_NEW_${code}`;
      try {
        insertStmt.run(
          newId, brand, category, assignee, newName, phone,
          code, hubName, cause, status
        );
        console.log(`  [INSERT] 코드=${code}, 이름=${newName} (id=${newId})`);
        inserted++;
      } catch (e) {
        console.warn(`  [INSERT 실패] 코드=${code}: ${e.message}`);
        skipped++;
      }
    } else {
      // 기존 레코드 UPDATE (이름이 다를 때만)
      const currentName = dbRecord.name;
      if (currentName !== newName) {
        updateStmt.run(newName, dbRecord.id);
        console.log(`  [UPDATE] 코드=${code} (${dbRecord.id}) | "${currentName}" → "${newName}"`);
        updated++;
      } else {
        unchanged++;
      }
    }
  }
});

tx();

console.log(`
완료:
  - 이름 업데이트: ${updated}개
  - 신규 삽입:     ${inserted}개
  - 변경 없음:     ${unchanged}개
  - 처리 실패:     ${skipped}개
  - 모호(건너뜀): ${ambiguous}개
`);

db.close();
