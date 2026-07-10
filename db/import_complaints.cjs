// 형사고소 db데이터 일괄.xlsx → complaints 테이블 임포트
// 실행: node db/import_complaints.cjs

const Database = require("better-sqlite3");
const XLSX = require("xlsx");
const path = require("path");

const DB_PATH  = path.join(__dirname, "debtflow.db");
const XL_PATH  = path.join(__dirname, "형사고소 db데이터 일괄.xlsx");
const db = new Database(DB_PATH);

// ─── 1. 테이블 컬럼 추가 (이미 있으면 IGNORE) ─────────────
const existingCols = db.prepare("PRAGMA table_info(complaints)").all().map(c => c.name);
if (!existingCols.includes("investigator")) {
  db.prepare("ALTER TABLE complaints ADD COLUMN investigator TEXT").run();
  console.log("✅ investigator 컬럼 추가");
}
if (!existingCols.includes("investigator_contact")) {
  db.prepare("ALTER TABLE complaints ADD COLUMN investigator_contact TEXT").run();
  console.log("✅ investigator_contact 컬럼 추가");
}

// ─── 2. 엑셀 읽기 ──────────────────────────────────────────
const wb   = XLSX.readFile(XL_PATH, { cellDates: false });
const ws   = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { raw: true, defval: null });

// 실제 데이터 행: NO 컬럼이 숫자인 행만
const dataRows = rows.filter(r => typeof r["__EMPTY"] === "number");
console.log(`엑셀 데이터 행: ${dataRows.length}건`);

// ─── 3. 채무자 목록 (이름+브랜드 → id 매핑) ─────────────
const debtors = db.prepare("SELECT id, name, brand_code FROM debtors").all();
const byNameBrand = {};
debtors.forEach(d => {
  const key = `${d.brand_code}||${(d.name || "").trim()}`;
  if (!byNameBrand[key]) byNameBrand[key] = d.id;
});

// ─── 4. 헬퍼 함수 ──────────────────────────────────────────
function parseDate(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  // "2026.01.30" → "2026-01-30"
  const full = s.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})\.?$/);
  if (full) return `${full[1]}-${full[2].padStart(2,"0")}-${full[3].padStart(2,"0")}`;
  // "2026.01." or "2026.01" or 2026.01 (number)
  const partial = s.match(/^(\d{4})\.(\d{1,2})\.?$/);
  if (partial) return `${partial[1]}-${partial[2].padStart(2,"0")}`;
  // number like 2026.01
  if (!isNaN(val) && typeof val === "number") {
    const yr = Math.floor(val);
    const mo = Math.round((val - yr) * 100);
    if (yr > 2000 && mo >= 1 && mo <= 12) return `${yr}-${String(mo).padStart(2,"0")}`;
  }
  return s || null;
}

function detectStatus(progressTexts) {
  const all = progressTexts.filter(Boolean).join(" ").toLowerCase();
  if (!all) return "준비중";
  if (/혐의\s*없음|불송치|각하|수사\s*종결|조사\s*종결|불기소/.test(all)) return "불송치";
  if (/고소\s*취하/.test(all) && !/불송치|각하/.test(all)) return "취하";
  if (/기소|검찰\s*송치|공판/.test(all)) return "기소";
  if (/1심|판결/.test(all)) return "1심진행중";
  return "수사중";
}

function brandToCompany(code) {
  return { B: "㈜바로고", M: "㈜모아라인", D: "㈜딜버" }[code] || "㈜바로고";
}

// ─── 5. 임포트 ─────────────────────────────────────────────
// id가 같으면 원본 엑셀이 수정돼도 재실행 시 반영되도록 INSERT OR IGNORE 대신
// ON CONFLICT DO UPDATE를 사용한다 (기존에는 IGNORE로 조용히 no-op되면서도
// imported 카운터와 "✓" 로그가 매번 찍혀 실제로는 아무것도 갱신되지 않은 것처럼 보였다).
let imported = 0, updated = 0, skipped = 0;

const existsStmt = db.prepare("SELECT 1 FROM complaints WHERE id = ?");
const insert = db.prepare(`
  INSERT INTO complaints
    (id, debtor_id, complainant, goods_amount, loan_amount, charge,
     complaint_date, police_station, status_note, investigator, investigator_contact)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    debtor_id = excluded.debtor_id,
    complainant = excluded.complainant,
    goods_amount = excluded.goods_amount,
    loan_amount = excluded.loan_amount,
    charge = excluded.charge,
    complaint_date = excluded.complaint_date,
    police_station = excluded.police_station,
    status_note = excluded.status_note,
    investigator = excluded.investigator,
    investigator_contact = excluded.investigator_contact
`);

const importTx = db.transaction(() => {
  for (const row of dataRows) {
    const no    = row["__EMPTY"];
    const brand = String(row["__EMPTY_1"] || "").trim();
    const name  = String(row["우수사례"]  || "").trim();

    if (!name || !brand) { skipped++; continue; }

    const key      = `${brand}||${name}`;
    const debtorId = byNameBrand[key];
    if (!debtorId) {
      console.log(`  SKIP (미매칭) #${no} [${brand}] ${name}`);
      skipped++;
      continue;
    }

    const goodsAmt = typeof row["issue"] === "number" ? row["issue"] : 0;
    const loanAmt  = typeof row[" 종결 또는 취하 "] === "number" ? row[" 종결 또는 취하 "] : 0;
    const charge   = row["__EMPTY_8"] ? String(row["__EMPTY_8"]).trim() : null;
    const cDate    = parseDate(row["__EMPTY_9"]);
    const police   = row["__EMPTY_10"] ? String(row["__EMPTY_10"]).trim() : null;
    const inv      = row["__EMPTY_11"] ? String(row["__EMPTY_11"]).trim() : null;
    const invCont  = row["__EMPTY_12"] ? String(row["__EMPTY_12"]).trim() : null;

    const progressCols = ["__EMPTY_13","__EMPTY_14","__EMPTY_15","__EMPTY_16","__EMPTY_17","__EMPTY_18","__EMPTY_19","__EMPTY_20"];
    const progressTexts = progressCols.map(c => row[c]).filter(v => v !== null && v !== undefined).map(v => String(v).trim()).filter(v => v && !/^\d+$/.test(v)); // 숫자만 있는 잔존물 제외
    const statusNote = progressTexts.join("\n") || null;
    const status     = detectStatus(progressTexts);

    const id = `CRM${String(no).padStart(4, "0")}`;
    const isNew = !existsStmt.get(id);

    insert.run(id, debtorId, brandToCompany(brand), goodsAmt, loanAmt, charge, cDate, police, statusNote, inv, invCont);
    if (isNew) imported++; else updated++;
    console.log(`  ${isNew ? "✓" : "↻"} #${no} [${brand}] ${name} → ${status}`);
  }
});

importTx();

console.log(`\n완료: 신규 임포트 ${imported}건 / 갱신 ${updated}건 / 스킵 ${skipped}건`);

// ─── 6. 결과 확인 ──────────────────────────────────────────
const total = db.prepare("SELECT COUNT(*) as cnt FROM complaints").get();
const byStatus = db.prepare(`
  SELECT
    CASE
      WHEN status_note IS NULL OR status_note = '' THEN '준비중'
      WHEN status_note LIKE '%혐의없음%' OR status_note LIKE '%불송치%' OR status_note LIKE '%각하%' OR status_note LIKE '%수사종결%' OR status_note LIKE '%불기소%' THEN '불송치'
      WHEN status_note LIKE '%고소취하%' THEN '취하'
      WHEN status_note LIKE '%기소%' OR status_note LIKE '%검찰송치%' THEN '기소'
      ELSE '수사중'
    END as status, COUNT(*) as cnt
  FROM complaints GROUP BY 1
`).all();
console.log("\nDB 최종 complaints:", total.cnt, "건");
byStatus.forEach(r => console.log(`  ${r.status}: ${r.cnt}건`));
