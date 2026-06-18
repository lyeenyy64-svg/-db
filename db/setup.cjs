// ============================================================
// BAROGO DEBTFLOW — DB 초기화 + 엑셀 임포트 통합 스크립트
// 실행:  node db/setup.cjs
// 결과:  db/debtflow.db (SQLite 파일)
// ============================================================

const Database = require("better-sqlite3");
const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "debtflow.db");
const SCHEMA_PATH = path.join(__dirname, "schema.sql");
const XLSX_PATH = path.join(__dirname, "★★★ 2026년 3사 npl 추심현황_최신본 ★★★.xlsx");

// ============== 1. DB 파일 초기화 ==============
if (fs.existsSync(DB_PATH)) {
  console.log(`[1/5] 기존 ${path.basename(DB_PATH)} 파일 삭제`);
  fs.unlinkSync(DB_PATH);
}
console.log(`[1/5] 새 DB 파일 생성: ${path.basename(DB_PATH)}`);
const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");

// ============== 2. schema.sql 실행 ==============
console.log(`[2/5] schema.sql 실행`);
const schema = fs.readFileSync(SCHEMA_PATH, "utf-8");
db.exec(schema);

// ============== 유틸 ==============
const isEmpty = (v) => v == null || v === "" || v === " " || v === "　" || v === "-" || v === "－";
const cleanStr = (v) => (isEmpty(v) ? null : String(v).trim().replace(/\r\n/g, " ").replace(/\s+/g, " "));
const parseAmount = (v) => {
  if (isEmpty(v)) return 0;
  const s = String(v).replace(/[,\s]/g, "");
  const n = parseInt(s, 10);
  return isNaN(n) ? 0 : n;
};
const parseDate = (v) => {
  if (isEmpty(v)) return null;
  const s = String(v).trim();
  // "2026/01/01" -> "2026-01-01"
  let m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  // "3/25/21" (M/D/YY 미국식) -> 2021-03-25
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (m) {
    const year = 2000 + parseInt(m[3], 10);
    return `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  // "2024-01-01" 이미 ISO
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return null;
};
// 회사명 정규화: ㈜ / (주) / 주식회사 / 공백 차이 무시
const normalizeName = (name) => {
  if (!name) return "";
  return String(name)
    .replace(/㈜/g, "")
    .replace(/\(주\)/g, "")
    .replace(/주식회사/g, "")
    .replace(/\([^)]*\)/g, "")   // "송봉은(송채안)" -> "송봉은"
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
};

// ============== 3. 채무자 임포트 ==============
console.log(`[3/5] [채권관리] 시트 → debtors 테이블 임포트`);
const wb = XLSX.readFile(XLSX_PATH);
const debtorsSheet = wb.Sheets["채권관리"];
const debtorRows = XLSX.utils.sheet_to_json(debtorsSheet, { header: 1, raw: false, defval: "" });

// 헤더는 2행(index 1), 데이터는 3행부터(index 2)
// 컬럼 매핑 (열 인덱스, 0-based)
// B(1)브렌드, C(2)분류, D(3)담당, E(4)채무자명, F(5)연대보증인, G(6)연락처, H(7)코드,
// I(8)허브/지점명, J(9)채무발생원인, K(10)재무추심상태, L(11)신용조회, M(12)집행권원,
// N(13)주민등록초본, O(14)영업담당자, P(15)대여일자, Q(16)주요사항, R(17)원금잔액,
// S(18)조정액, T(19)회수액

const insertDebtor = db.prepare(`
  INSERT INTO debtors (id, brand_code, category, assignee, name, phone, hub_code, hub_name,
                       debt_cause, collection_status, exec_title, loan_date, key_notes,
                       principal_balance, adjustment, collected_amount)
  VALUES (@id, @brand_code, @category, @assignee, @name, @phone, @hub_code, @hub_name,
          @debt_cause, @collection_status, @exec_title, @loan_date, @key_notes,
          @principal_balance, @adjustment, @collected_amount)
`);
const insertGuarantor = db.prepare(`INSERT INTO debtor_guarantors (debtor_id, name) VALUES (?, ?)`);
const insertPhoneHist = db.prepare(`INSERT INTO debtor_phone_history (debtor_id, phone, note) VALUES (?, ?, ?)`);

const VALID_BRANDS = new Set(["B", "D", "M"]);
const VALID_CATEGORIES = new Set(["장기채권", "회생/파산", "회생파산", "추심의뢰"]);
const VALID_STATUSES = new Set(["추심진행", "추심보류"]);

let debtorIdCounter = 1;
let imported = 0, skipped = 0;
const skippedRows = [];

const txDebtors = db.transaction(() => {
  for (let i = 2; i < debtorRows.length; i++) {  // 3행부터
    const row = debtorRows[i];
    const brand = cleanStr(row[1]);
    const name = cleanStr(row[4]);

    // 핵심 필드 누락 시 스킵
    if (!brand || !VALID_BRANDS.has(brand) || !name) {
      skipped++;
      if (i < 10) skippedRows.push({ row: i + 1, reason: "브랜드/이름 누락", brand, name });
      continue;
    }

    const category = cleanStr(row[2]) || "장기채권";
    const finalCategory = category === "회생파산" ? "회생/파산" : category;
    const status = cleanStr(row[10]) || "추심진행";
    const validStatus = VALID_STATUSES.has(status) ? status : "추심진행";

    const id = `NPL${String(debtorIdCounter).padStart(4, "0")}`;
    debtorIdCounter++;

    insertDebtor.run({
      id,
      brand_code: brand,
      category: VALID_CATEGORIES.has(finalCategory) ? finalCategory : "장기채권",
      assignee: cleanStr(row[3]),
      name,
      phone: cleanStr(row[6]),
      hub_code: cleanStr(row[7]),
      hub_name: cleanStr(row[8]),
      debt_cause: cleanStr(row[9]),
      collection_status: validStatus,
      exec_title: cleanStr(row[12]) === "O" ? 1 : 0,
      loan_date: parseDate(row[15]),
      key_notes: cleanStr(row[16]),
      principal_balance: parseAmount(row[17]),
      adjustment: parseAmount(row[18]),
      collected_amount: parseAmount(row[19]),
    });

    // 연대보증인 (쉼표로 분리)
    const guarantorsStr = cleanStr(row[5]);
    if (guarantorsStr) {
      for (const g of guarantorsStr.split(",")) {
        const gn = g.trim();
        if (gn) insertGuarantor.run(id, gn);
      }
    }

    // 연락처 이력 — 전체 텍스트를 phone에 넣고, 추가 번호는 history로 분리 (간단 처리)
    const phoneStr = cleanStr(row[6]);
    if (phoneStr && /신규번호|결번|->|→/.test(phoneStr)) {
      insertPhoneHist.run(id, phoneStr, "엑셀 임포트 — 원본 텍스트");
    }

    imported++;
  }
});
txDebtors();
console.log(`     → 임포트: ${imported}건, 스킵: ${skipped}건`);
if (skippedRows.length > 0) {
  console.log(`     → 스킵된 첫 ${skippedRows.length}건:`, skippedRows);
}

// ============== 4. 입금 임포트 ==============
console.log(`[4/5] [입금내역] 시트 → payments / pending_payments 임포트`);
const paySheet = wb.Sheets["입금내역"];
const payRows = XLSX.utils.sheet_to_json(paySheet, { header: 1, raw: false, defval: "" });

// 헤더 3행(index 2), 데이터 4행(index 3)부터
// B(1)년월일, C(2)구분, D(3)담당, E(4)허브/지점명, F(5)코드, G(6)채무자명,
// H(7)입금자명, I(8)계, J(9)본사계좌, K(10)캐쉬충전, L(11)웰컴직접상환, M(12)비고

// 채무자 매칭용 인덱스 미리 만들기
const allDebtors = db.prepare(`SELECT id, brand_code, name, hub_code FROM debtors`).all();
const byBrandCodeName = new Map();  // "B|4134|㈜에스플러스" -> id
const byNormalizedName = new Map(); // "에스플러스" -> [id, ...]
const byHubCode = new Map();        // "4134" -> [id, ...]
for (const d of allDebtors) {
  const key1 = `${d.brand_code}|${d.hub_code || ""}|${d.name}`;
  byBrandCodeName.set(key1, d.id);
  const nn = normalizeName(d.name);
  if (nn) {
    if (!byNormalizedName.has(nn)) byNormalizedName.set(nn, []);
    byNormalizedName.get(nn).push(d.id);
  }
  if (d.hub_code) {
    if (!byHubCode.has(d.hub_code)) byHubCode.set(d.hub_code, []);
    byHubCode.get(d.hub_code).push(d.id);
  }
}

const insertPayment = db.prepare(`
  INSERT INTO payments (id, debtor_id, payment_date, payer_name, total_amount,
                        company_account, cash_charge, welcome_direct, note)
  VALUES (@id, @debtor_id, @payment_date, @payer_name, @total_amount,
          @company_account, @cash_charge, @welcome_direct, @note)
`);
const insertPending = db.prepare(`
  INSERT INTO pending_payments (payment_date, excel_brand, excel_assignee, excel_hub_name,
                                excel_hub_code, excel_debtor_name, payer_name, total_amount,
                                company_account, cash_charge, welcome_direct, note,
                                source, source_ref, reason)
  VALUES (@payment_date, @excel_brand, @excel_assignee, @excel_hub_name,
          @excel_hub_code, @excel_debtor_name, @payer_name, @total_amount,
          @company_account, @cash_charge, @welcome_direct, @note,
          @source, @source_ref, @reason)
`);

let payImported = 0, payPending = 0, payInvalid = 0;
let payCounter = 1;

const txPayments = db.transaction(() => {
  for (let i = 3; i < payRows.length; i++) {  // 4행부터
    const row = payRows[i];
    const dateRaw = cleanStr(row[1]);
    const total = parseAmount(row[8]);

    // 빈 줄 또는 합산이 0인 줄 스킵 (엑셀 끝쪽 빈 행 처리)
    if (!dateRaw || total <= 0) {
      payInvalid++;
      continue;
    }

    const date = parseDate(dateRaw);
    if (!date) {
      payInvalid++;
      continue;
    }

    const brand = cleanStr(row[2]);
    const hubCode = cleanStr(row[5]);
    const debtorName = cleanStr(row[6]);
    const payerName = cleanStr(row[7]);

    // 매칭 시도
    let matchedId = null;
    let matchReason = null;

    // 1단계: 브랜드 + 코드 + 정확한 이름
    if (brand && hubCode && debtorName) {
      matchedId = byBrandCodeName.get(`${brand}|${hubCode}|${debtorName}`);
    }
    // 2단계: 정규화된 이름으로
    if (!matchedId && debtorName) {
      const candidates = byNormalizedName.get(normalizeName(debtorName));
      if (candidates && candidates.length === 1) matchedId = candidates[0];
      else if (candidates && candidates.length > 1) {
        // 브랜드로 좁히기
        const byBrand = candidates.filter(id => {
          const d = allDebtors.find(x => x.id === id);
          return d && d.brand_code === brand;
        });
        if (byBrand.length === 1) matchedId = byBrand[0];
      }
    }
    // 3단계: 입금자명으로
    if (!matchedId && payerName) {
      const candidates = byNormalizedName.get(normalizeName(payerName));
      if (candidates && candidates.length === 1) matchedId = candidates[0];
    }
    // 4단계: 코드로
    if (!matchedId && hubCode) {
      const candidates = byHubCode.get(hubCode);
      if (candidates && candidates.length === 1) matchedId = candidates[0];
    }

    if (matchedId) {
      const company = parseAmount(row[9]);
      const cash = parseAmount(row[10]);
      const welcome = parseAmount(row[11]);
      // 합계 불일치 시 보정 (계 우선)
      let c = company, ch = cash, w = welcome;
      const sum = c + ch + w;
      if (sum !== total) {
        // 차액을 본사계좌에 보정
        c = total - ch - w;
        if (c < 0) { c = total; ch = 0; w = 0; }
      }
      try {
        insertPayment.run({
          id: `PAY${String(payCounter).padStart(5, "0")}`,
          debtor_id: matchedId,
          payment_date: date,
          payer_name: payerName,
          total_amount: total,
          company_account: c,
          cash_charge: ch,
          welcome_direct: w,
          note: cleanStr(row[12]),
        });
        payCounter++;
        payImported++;
        continue;
      } catch (e) {
        matchReason = `INSERT 실패: ${e.message}`;
      }
    } else {
      matchReason = "채무자 미발견";
    }

    // 대기열로
    insertPending.run({
      payment_date: date,
      excel_brand: brand,
      excel_assignee: cleanStr(row[3]),
      excel_hub_name: cleanStr(row[4]),
      excel_hub_code: hubCode,
      excel_debtor_name: debtorName,
      payer_name: payerName,
      total_amount: total,
      company_account: parseAmount(row[9]),
      cash_charge: parseAmount(row[10]),
      welcome_direct: parseAmount(row[11]),
      note: cleanStr(row[12]),
      source: "excel",
      source_ref: `row ${i + 1}`,
      reason: matchReason,
    });
    payPending++;
  }
});
txPayments();
console.log(`     → payments: ${payImported}건 적재`);
console.log(`     → pending_payments: ${payPending}건 (매칭 실패 — 어드민에서 수동 연결 필요)`);
console.log(`     → 무효 행: ${payInvalid}건 스킵 (빈 행/금액 0)`);

// ============== 5. 결과 요약 ==============
console.log(`\n[5/5] 결과 요약`);
const sumByBrand = db.prepare(`SELECT brand_code, COUNT(*) AS c, SUM(principal_balance) AS p FROM debtors GROUP BY brand_code`).all();
console.log(`\n  ━ 채무자 ━`);
console.log(`     총 ${db.prepare(`SELECT COUNT(*) AS c FROM debtors`).get().c}건`);
for (const r of sumByBrand) console.log(`       ${r.brand_code}: ${r.c}건 / 원금 ${(r.p || 0).toLocaleString()}원`);

const payByBrand = db.prepare(`
  SELECT d.brand_code, COUNT(*) AS c, SUM(p.total_amount) AS s
  FROM payments p JOIN debtors d ON p.debtor_id = d.id
  GROUP BY d.brand_code
`).all();
console.log(`\n  ━ 입금 ━`);
console.log(`     총 ${db.prepare(`SELECT COUNT(*) AS c FROM payments`).get().c}건 / 합계 ${(db.prepare(`SELECT SUM(total_amount) AS s FROM payments`).get().s || 0).toLocaleString()}원`);
for (const r of payByBrand) console.log(`       ${r.brand_code}: ${r.c}건 / ${(r.s || 0).toLocaleString()}원`);

console.log(`\n  ━ 매칭 실패 (대기열) ━`);
const pendingByReason = db.prepare(`SELECT reason, COUNT(*) AS c FROM pending_payments GROUP BY reason`).all();
console.log(`     총 ${db.prepare(`SELECT COUNT(*) AS c FROM pending_payments`).get().c}건`);
for (const r of pendingByReason) console.log(`       ${r.reason}: ${r.c}건`);

// 대기열 상위 5건 샘플
const pendingSamples = db.prepare(`SELECT excel_debtor_name, payer_name, total_amount, excel_brand, excel_hub_code FROM pending_payments LIMIT 5`).all();
if (pendingSamples.length > 0) {
  console.log(`\n     [대기열 샘플 5건]`);
  for (const s of pendingSamples) {
    console.log(`       ${s.excel_brand} ${s.excel_hub_code} ${s.excel_debtor_name} (입금자: ${s.payer_name}) ${(s.total_amount || 0).toLocaleString()}원`);
  }
}

db.close();
console.log(`\n✅ 완료. DB 파일: ${DB_PATH}`);
