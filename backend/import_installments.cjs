/**
 * 분할상환 일정표 일괄.xlsx 임포터 v2
 * 실행: node backend/import_installments.cjs
 */
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "../db/debtflow.db");
const EXCEL_JSON = path.join(__dirname, "../db/excel_data.json");
const CURRENT_MONTH = "2026-06";
const TODAY = "2026-06-25";

const db = new Database(DB_PATH);

// ─── 날짜 파싱 ──────────────────────────────────────────────────────────────
// contextMonth: "YYYY-MM" (엑셀 컬럼 헤더)
function parseDateFromText(text, contextMonth) {
  if (!text) return null;
  const [ctxYear] = contextMonth.split("-").map(Number);

  // 첫 세그먼트만 사용 (> 또는 개행 이후는 무시)
  const seg = text.split(/[\n>]/)[0].replace(/^\s+/, "");

  // 1. YYYY.MM.DD 또는 YYYY-MM-DD (4자리 연도)
  let m = seg.match(/\b(20[2-9]\d)[.\-](\d{1,2})[.\-](\d{1,2})/);
  if (m) {
    const mo = parseInt(m[2]), dy = parseInt(m[3]);
    if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31)
      return `${m[1]}-${String(mo).padStart(2,"0")}-${String(dy).padStart(2,"0")}`;
  }

  // 2. YYMMDD (6자리 연속 숫자, 앞 2자리 20-29)
  m = seg.match(/\b(2\d)([01]\d)([0-3]\d)\b/);
  if (m) {
    const yr = 2000 + parseInt(m[1]);
    const mo = parseInt(m[2]), dy = parseInt(m[3]);
    if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31)
      return `${yr}-${m[2]}-${m[3]}`;
  }

  // 3. YY.MM.DD (2자리 연도, 20-29)
  m = seg.match(/\b(2\d)[.\-](\d{1,2})[.\-](\d{1,2})/);
  if (m) {
    const yr = 2000 + parseInt(m[1]);
    const mo = parseInt(m[2]), dy = parseInt(m[3]);
    if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31)
      return `${yr}-${String(mo).padStart(2,"0")}-${String(dy).padStart(2,"0")}`;
  }

  // 4. YYYY/MM/DD (슬래시, 4자리 연도) — MM/DD보다 먼저 검사해야 연도가 유실되지 않음
  m = seg.match(/\b(20[2-9]\d)\/(\d{1,2})\/(\d{1,2})\b/);
  if (m) {
    const mo = parseInt(m[2]), dy = parseInt(m[3]);
    if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31)
      return `${m[1]}-${String(mo).padStart(2,"0")}-${String(dy).padStart(2,"0")}`;
  }

  // 5. MM/DD (슬래시)
  m = seg.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (m) {
    const mo = parseInt(m[1]), dy = parseInt(m[2]);
    if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31)
      return `${ctxYear}-${String(mo).padStart(2,"0")}-${String(dy).padStart(2,"0")}`;
  }

  // 6. MM.DD (점, 2자리, 문장 앞에 위치)
  m = seg.match(/(?:^|\s)(\d{1,2})\.(\d{1,2})\.?(?:\s|$)/);
  if (m) {
    const mo = parseInt(m[1]), dy = parseInt(m[2]);
    if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31)
      return `${ctxYear}-${String(mo).padStart(2,"0")}-${String(dy).padStart(2,"0")}`;
  }

  // 7. 한국어 N월 N일
  m = seg.match(/(\d{1,2})월\s*(\d{1,2})/);
  if (m) {
    const mo = parseInt(m[1]), dy = parseInt(m[2]);
    if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31)
      return `${ctxYear}-${String(mo).padStart(2,"0")}-${String(dy).padStart(2,"0")}`;
  }

  return null;
}

// ─── 금액 파싱 ──────────────────────────────────────────────────────────────
function parseAmount(text) {
  if (!text) return null;
  // 공백 제거 금지 — "7.1 50만원" 에서 공백 제거 시 "7.150만원"(71500)으로 오파싱됨
  const t = text.replace(/,/g, "");

  // "50만5000원"처럼 만+숫자 복합 표기를 아래 단순 \d+원 패턴보다 먼저 검사한다.
  // 순서가 바뀌면 "50만5000원"에서 "5000원"만 매칭되어 505000원이 5000원으로 100배 축소된다.
  let m = t.match(/(\d+(?:\.\d+)?)만(\d{1,4})원/);
  if (m) return Math.round(parseFloat(m[1]) * 10000) + parseInt(m[2], 10);

  m = t.match(/(\d+)만(\d+)천원?/);
  if (m) return parseInt(m[1]) * 10000 + parseInt(m[2]) * 1000;
  // 마지막 숫자+만원 패턴을 사용 (날짜 "7.1" 같은 앞부분 숫자 제외)
  const manMatches = [...t.matchAll(/(\d+(?:\.\d+)?)\s*만원?/g)];
  if (manMatches.length) return Math.round(parseFloat(manMatches[manMatches.length - 1][1]) * 10000);
  m = t.match(/(\d+)천원?/);
  if (m) return parseInt(m[1]) * 1000;

  m = t.match(/\d+원/);
  if (m) {
    const n = parseInt(m[0].replace(/원/g, ""), 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return null;
}

// ─── 상태 결정 ──────────────────────────────────────────────────────────────
function determineStatus(color, month) {
  if (color === "black") return "완납";
  if (color === "red") return month <= CURRENT_MONTH ? "미납" : "예정";
  return "예정";
}

// ─── ID 생성 ────────────────────────────────────────────────────────────────
function randId(prefix = "SCH") {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = prefix;
  for (let i = 0; i < 9; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ─── 채무자 매핑 ────────────────────────────────────────────────────────────
// brand가 주어지면 항상 브랜드로 좁혀서 검색한다 — 그러지 않으면 서로 다른 브랜드에
// 동명의 채무자가 있을 때 엉뚱한 브랜드의 채무자로 매칭될 수 있다.
function findDebtor(code, name, brand) {
  if (code && code !== "코드없음") {
    const r = brand
      ? db.prepare("SELECT id, name FROM debtors WHERE hub_code = ? AND brand_code = ?").get(code, brand)
      : db.prepare("SELECT id, name FROM debtors WHERE hub_code = ?").get(code);
    if (r) return r;
  }
  const baseName = name.replace(/\(.*?\)/g, "").trim();
  if (!baseName) return null;
  const byExact = brand
    ? db.prepare("SELECT id, name FROM debtors WHERE name = ? AND brand_code = ?").all(baseName, brand)
    : db.prepare("SELECT id, name FROM debtors WHERE name = ?").all(baseName);
  if (byExact.length === 1) return byExact[0];
  if (byExact.length > 1) return null; // 동명이인 — 자동 매칭 대신 미매칭 처리
  const byLike = brand
    ? db.prepare("SELECT id, name FROM debtors WHERE name LIKE ? AND brand_code = ? ORDER BY id LIMIT 2").all(`%${baseName}%`, brand)
    : db.prepare("SELECT id, name FROM debtors WHERE name LIKE ? ORDER BY id LIMIT 2").all(`%${baseName}%`);
  return byLike.length === 1 ? byLike[0] : null; // 후보가 2개 이상이면 임의로 고르지 않고 미매칭 처리
}

// ─── 메인 임포트 ────────────────────────────────────────────────────────────
const excelData = JSON.parse(fs.readFileSync(EXCEL_JSON, "utf8").replace(/^﻿/, ""));

const stats = {
  total: excelData.length, matched: 0, unmatched: 0,
  plansCreated: 0, schedulesCreated: 0, schedulesUpdated: 0,
  historyCreated: 0, datesFound: 0,
  unmatchedList: [],
};

const doImport = db.transaction(() => {
  // 기존 엑셀임포트 히스토리 삭제 후 재생성 (덮어쓰기)
  db.prepare("DELETE FROM installment_schedule_history WHERE user_name='엑셀임포트'").run();

  for (const row of excelData) {
    const debtor = findDebtor(row.code, row.name, row.brand);
    if (!debtor) {
      stats.unmatched++;
      stats.unmatchedList.push({ name: row.name, code: row.code, brand: row.brand });
      continue;
    }
    stats.matched++;

    // ── 플랜 조회/생성 ───────────────────────────────────────────────────
    let plan = db.prepare("SELECT id FROM installment_plans WHERE debtor_id = ?").get(debtor.id);
    if (!plan) {
      const planId = "INS" + debtor.id.replace("NPL", "");
      const existingId = db.prepare("SELECT id FROM installment_plans WHERE id = ?").get(planId);
      const finalPlanId = existingId ? planId + "_X" : planId;
      db.prepare(`INSERT INTO installment_plans (id, debtor_id, payment_timing, monthly_amount, total_debt, total_claim, start_date, status, memo)
                  VALUES (?, ?, ?, 0, 0, 0, ?, '진행중', ?)`)
        .run(finalPlanId, debtor.id, row.category || "수시", row.cells[0]?.month || CURRENT_MONTH, row.origData || null);
      plan = { id: finalPlanId };
      stats.plansCreated++;
    }

    // ── 각 셀 처리 ──────────────────────────────────────────────────────
    for (const cell of row.cells) {
      const amount = parseAmount(cell.text);
      const status = determineStatus(cell.color, cell.month);
      const dueDate = parseDateFromText(cell.text, cell.month);
      if (dueDate) stats.datesFound++;

      let sched = db.prepare(
        "SELECT id, status, due_date FROM installment_schedules WHERE plan_id = ? AND due_month = ?"
      ).get(plan.id, cell.month);

      if (!sched) {
        const schedId = randId("SCH");
        db.prepare(`INSERT INTO installment_schedules
            (id, plan_id, due_month, due_date, scheduled_amount, paid_amount, status, memo, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`)
          .run(schedId, plan.id, cell.month, dueDate,
            amount || 0,
            status === "완납" ? (amount || 0) : 0,
            status, cell.text);
        sched = { id: schedId };
        stats.schedulesCreated++;
      } else {
        // 항상 덮어쓰기 (사용자 요청) — memo도 예외 없이 매번 최신 셀 텍스트로 덮어써야 한다
        db.prepare(`UPDATE installment_schedules
            SET due_date=?, status=?, scheduled_amount=CASE WHEN ?> 0 THEN ? ELSE scheduled_amount END,
                paid_amount=CASE WHEN ?='완납' AND ?>0 THEN ? ELSE paid_amount END, memo=?
            WHERE id=?`)
          .run(dueDate, status, amount||0, amount||0, status, amount||0, amount||0, cell.text, sched.id);
        stats.schedulesUpdated++;
      }

      // 히스토리 기록
      if (cell.text && cell.text.trim()) {
        db.prepare(`INSERT INTO installment_schedule_history
            (schedule_id, plan_id, debtor_id, event_type, from_date, amount, memo, user_name, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, '엑셀임포트', ?)`)
          .run(sched.id, plan.id, debtor.id,
            status,
            dueDate || cell.month,
            amount,
            cell.text.trim(),
            (dueDate || cell.month + "-01") + " 00:00:00");
        stats.historyCreated++;
      }
    }
  }
});

doImport();

console.log("\n=== 분할상환 임포트 v2 결과 ===");
console.log(`총 ${stats.total}명 처리`);
console.log(`  매칭 성공: ${stats.matched}명 / 실패: ${stats.unmatched}명`);
console.log(`  플랜 신규: ${stats.plansCreated}개`);
console.log(`  스케줄 신규: ${stats.schedulesCreated}개 / 업데이트: ${stats.schedulesUpdated}개`);
console.log(`  날짜 파싱 성공: ${stats.datesFound}개`);
console.log(`  히스토리 기록: ${stats.historyCreated}개`);

if (stats.unmatchedList.length > 0) {
  console.log(`\n=== 매핑 실패 (${stats.unmatchedList.length}명) ===`);
  stats.unmatchedList.forEach(u => console.log(`  ${u.brand} ${u.name} (${u.code})`));
}
