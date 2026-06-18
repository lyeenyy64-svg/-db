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
console.log("[3/4] DB에서 채무자 로드");
const dbDebtors = db.prepare("SELECT id, hub_code, name FROM debtors").all();
const dbByHubCode = new Map(); // hub_code → { id, name }
for (const d of dbDebtors) {
  if (d.hub_code) dbByHubCode.set(String(d.hub_code).trim(), d);
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

let updated = 0, inserted = 0, skipped = 0, unchanged = 0;

const tx = db.transaction(() => {
  for (const [code, { name: newName, row }] of newMap.entries()) {
    const dbRecord = dbByHubCode.get(code);

    if (!dbRecord) {
      // 신규 레코드 INSERT
      const brand = cleanStr(row[COL.brand]) || "B";
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
`);

db.close();
