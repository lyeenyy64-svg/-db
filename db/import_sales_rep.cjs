// 채무자 관리 데이터.xlsx → debtors.sales_rep 업데이트
// 실행: node db/import_sales_rep.cjs

const Database = require("better-sqlite3");
const XLSX     = require("xlsx");
const path     = require("path");

const DB_PATH  = path.join(__dirname, "debtflow.db");
const XL_PATH  = path.join(__dirname, "채무자 관리 데이터.xlsx");
const db       = new Database(DB_PATH);

const wb   = XLSX.readFile(XL_PATH, { cellDates: false });
const ws   = wb.Sheets[wb.SheetNames[0]];
// defval null, 헤더는 2번째 행 (offset:1)
const rows = XLSX.utils.sheet_to_json(ws, { raw: true, defval: null, range: 1 });

// 헤더 확인
const firstRow = rows[0] || {};
console.log("컬럼 샘플:", Object.keys(firstRow).slice(0, 20).join(", "));

const update = db.prepare(`
  UPDATE debtors
  SET    sales_rep   = ?,
         updated_at  = datetime('now', 'localtime')
  WHERE  hub_code    = ?
    AND  brand_code  = ?
    AND  (sales_rep IS NULL OR sales_rep = '')
`);

let updated = 0, skipped = 0;

const tx = db.transaction(() => {
  for (const row of rows) {
    const brand    = String(row["브렌드"]        || "").trim();
    const hubCode  = String(row["코드"]          || "").trim();
    const salesRep = String(row["영업담당자"]    || "").trim();

    if (!brand || !hubCode || !salesRep) { skipped++; continue; }

    const r = update.run(salesRep, hubCode, brand);
    if (r.changes > 0) { updated++; console.log(`  ✓ [${brand}] ${hubCode} → ${salesRep}`); }
    else skipped++;
  }
});

tx();
console.log(`\n완료: 업데이트 ${updated}건 / 스킵 ${skipped}건`);

const check = db.prepare("SELECT COUNT(*) AS c FROM debtors WHERE sales_rep IS NOT NULL AND sales_rep != ''").get();
console.log(`영업담당자 있는 채무자: ${check.c}건`);
