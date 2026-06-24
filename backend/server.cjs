// ============================================================
// BAROGO DEBTFLOW — Backend API Server
// 실행: node backend/server.cjs
// 포트: 3001 (Vite 프록시 경유)
// ============================================================

require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const Database = require("better-sqlite3");
const path = require("path");
const matcher = require("./matcher.cjs");
const slackParser = require("./slackParser.cjs");
const slackBot = require("./slackBot.cjs");
const fileScanner = require("./fileScanner.cjs");
const { generateHwpx, buildPreviewHtml } = require("./documentGenerator.cjs");
const { WebClient: SlackClient } = require("@slack/web-api");

const slackNotify = process.env.SLACK_BOT_TOKEN ? new SlackClient(process.env.SLACK_BOT_TOKEN) : null;
const NOTIFY_CHANNEL = process.env.SLACK_NOTIFY_CHANNEL_ID || process.env.SLACK_CHANNEL_ID;

const DB_PATH = path.join(__dirname, "..", "db", "debtflow.db");
const db = new Database(DB_PATH, { readonly: false });
db.pragma("foreign_keys = ON");

// ─── 기본 보조 테이블 자동 생성 ──────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
  CREATE TABLE IF NOT EXISTS installment_schedules (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES installment_plans(id) ON DELETE CASCADE,
    debt_source TEXT,
    institution TEXT,
    loan_amount INTEGER,
    interest_rate TEXT,
    due_date TEXT,
    due_month TEXT,
    scheduled_amount INTEGER NOT NULL DEFAULT 0,
    paid_amount INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT '미납',
    memo TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_inst_sched_plan ON installment_schedules(plan_id);
  CREATE INDEX IF NOT EXISTS idx_inst_sched_due ON installment_schedules(due_date);
  CREATE INDEX IF NOT EXISTS idx_inst_sched_month ON installment_schedules(due_month);
`);
try { db.exec("ALTER TABLE installment_plans ADD COLUMN memo TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE debtors ADD COLUMN resident_number TEXT"); } catch(e) {}

// ─── DB 마이그레이션 (컬럼 추가 / 테이블 생성) ─────────────
{
  const debtorCols = db.prepare("PRAGMA table_info(debtors)").all().map(c => c.name);
  for (const [col, type] of [
    ["credit_report_url",   "TEXT"],
    ["resident_copy_url",   "TEXT"],
    ["exec_title_url",      "TEXT"],
    ["subrogation_doc_url", "TEXT"],
  ]) {
    if (!debtorCols.includes(col)) {
      db.exec(`ALTER TABLE debtors ADD COLUMN ${col} ${type}`);
    }
  }

  const cmpCols = db.prepare("PRAGMA table_info(complaints)").all().map(c => c.name);
  if (!cmpCols.includes("status")) {
    db.exec("ALTER TABLE complaints ADD COLUMN status TEXT DEFAULT '수사중'");
    // 기존 status_note에서 상태 자동 감지
    db.exec(`
      UPDATE complaints SET status =
        CASE
          WHEN status_note LIKE '%혐의없음%' OR status_note LIKE '%불송치%' OR status_note LIKE '%각하%' OR status_note LIKE '%불기소%' THEN '불송치'
          WHEN status_note LIKE '%고소취하%' THEN '취하'
          WHEN status_note LIKE '%기소%' OR status_note LIKE '%검찰송치%' THEN '기소'
          WHEN status_note IS NULL OR status_note = '' THEN '준비중'
          ELSE '수사중'
        END
    `);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS complaint_history (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      complaint_id TEXT NOT NULL,
      date      TEXT NOT NULL,
      content   TEXT NOT NULL,
      assignee  TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_cmp_hist ON complaint_history(complaint_id);
  `);

  // 기존 status_note → complaint_history 1회 마이그레이션
  const migrated = db.prepare("SELECT value FROM kv_store WHERE key='cmp_hist_migrated'").get();
  if (!migrated) {
    const rows = db.prepare("SELECT id, complaint_date, status_note FROM complaints WHERE status_note IS NOT NULL AND status_note != ''").all();
    const ins = db.prepare("INSERT OR IGNORE INTO complaint_history (complaint_id, date, content) VALUES (?, ?, ?)");
    const tx = db.transaction(() => { rows.forEach(r => ins.run(r.id, r.complaint_date || new Date().toISOString().slice(0,10), r.status_note)); });
    tx();
    db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('cmp_hist_migrated', '1')").run();
  }

  // Slack 수집 레코드 중 excel_brand NULL인 것 → 바로고(B) 로 1회 보정
  // (다채널 도입 이전 단일 채널(바로고) 시절 수집된 레코드)
  const brandFixed = db.prepare("SELECT value FROM kv_store WHERE key='pending_brand_backfill'").get();
  if (!brandFixed) {
    db.prepare("UPDATE pending_payments SET excel_brand = 'B' WHERE excel_brand IS NULL AND source = 'slack'").run();
    db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('pending_brand_backfill', '1')").run();
  }
}

// 학습 매핑 테이블 (최초 실행 시 자동 생성)
db.exec(`
  CREATE TABLE IF NOT EXISTS payer_name_mappings (
    payer_name   TEXT PRIMARY KEY,
    debtor_id    TEXT NOT NULL,
    debtor_name  TEXT,
    resolved_count INTEGER NOT NULL DEFAULT 1,
    learned_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  )
`);

// 채무자-서류 연결 테이블
db.exec(`
  CREATE TABLE IF NOT EXISTS debtor_documents (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    debtor_id    TEXT NOT NULL REFERENCES debtors(id) ON DELETE CASCADE,
    file_path    TEXT NOT NULL,
    file_name    TEXT NOT NULL,
    doc_label    TEXT,
    match_type   TEXT,
    matched_name TEXT,
    linked_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    linked_by    TEXT,
    UNIQUE(debtor_id, file_path)
  );
  CREATE INDEX IF NOT EXISTS idx_debtor_docs ON debtor_documents(debtor_id);
`);

const app = express();
app.use(cors());
app.use(express.json());

// ─── SSE 실시간 브로드캐스트 ─────────────────────────
const sseClients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch {}
  }
}
// 모든 쓰기 작업 후 자동 브로드캐스트
app.use((req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    res.on("finish", () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        broadcast("data-changed", { method: req.method, path: req.path, at: Date.now() });
      }
    });
  }
  next();
});

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(": connected\n\n");
  sseClients.add(res);
  // 25초마다 keepalive ping — 프록시/방화벽이 idle 연결을 끊는 것 방지
  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { clearInterval(ping); } }, 25000);
  req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
});

// ─── 헬스체크 ─────────────────────────────────────
app.get("/api/health", (req, res) => {
  const counts = {
    debtors: db.prepare("SELECT COUNT(*) AS c FROM debtors").get().c,
    payments: db.prepare("SELECT COUNT(*) AS c FROM payments").get().c,
    pending: db.prepare("SELECT COUNT(*) AS c FROM pending_payments").get().c,
  };
  res.json({ ok: true, db: path.basename(DB_PATH), counts });
});

// ─── 입금 내역 조회 ──────────────────────────────
// GET /api/payments?brand=B&q=홍길동&from=2026-01-01&to=2026-12-31
app.get("/api/payments", (req, res) => {
  const { brand, q, from, to } = req.query;
  const where = [];
  const params = {};
  if (brand && brand !== "전체") { where.push("d.brand_code = @brand"); params.brand = brand; }
  if (q) {
    where.push("(d.name LIKE @q OR p.payer_name LIKE @q OR d.hub_name LIKE @q)");
    params.q = `%${q}%`;
  }
  if (from) { where.push("p.payment_date >= @from"); params.from = from; }
  if (to) { where.push("p.payment_date <= @to"); params.to = to; }
  const sql = `
    SELECT p.id, p.debtor_id AS debtorId, d.name AS debtorName, d.brand_code AS brand,
           d.assignee, d.hub_name AS hubName, d.hub_code AS hubCode,
           p.payment_date AS paymentDate, p.payer_name AS payerName,
           p.total_amount AS totalAmount, p.company_account AS companyAccount,
           p.cash_charge AS cashCharge, p.welcome_direct AS welcomeDirect, p.note
    FROM payments p
    JOIN debtors d ON p.debtor_id = d.id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY p.payment_date DESC, p.id DESC
  `;
  const rows = db.prepare(sql).all(params);
  res.json(rows);
});

// ─── 입금 통계 (KPI 카드용) ──────────────────────
app.get("/api/payments/stats", (req, res) => {
  const total = db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(total_amount),0) AS s FROM payments").get();
  const company = db.prepare("SELECT COALESCE(SUM(company_account),0) AS s FROM payments").get();
  const cashWelcome = db.prepare("SELECT COALESCE(SUM(cash_charge + welcome_direct),0) AS s FROM payments").get();
  res.json({
    totalCount: total.c,
    totalAmount: total.s,
    companyAccountTotal: company.s,
    cashWelcomeTotal: cashWelcome.s,
  });
});

// ─── 채무자 마스터 조회 ──────────────────────────
app.get("/api/debtors", (req, res) => {
  const { brand, category, status, q } = req.query;
  const where = [];
  const params = {};
  if (brand && brand !== "전체") { where.push("brand_code = @brand"); params.brand = brand; }
  if (category && category !== "전체") { where.push("category = @category"); params.category = category; }
  if (status && status !== "전체") { where.push("collection_status = @status"); params.status = status; }
  if (q) {
    where.push("(name LIKE @q OR id LIKE @q OR hub_name LIKE @q OR hub_code LIKE @q)");
    params.q = `%${q}%`;
  }
  const sql = `
    SELECT id, brand_code AS brand, brand_name AS brandName, category, assignee, name,
           phone, hub_code AS hubCode, hub_name AS hubName, debt_cause AS debtCause,
           collection_status AS collectionStatus, exec_title AS execTitle,
           exec_title_url AS execTitleUrl,
           loan_date AS loanDate, subrogation_month AS subrogationMonth,
           subrogation_doc_url AS subrogationDocUrl,
           credit_check_date AS creditCheck, credit_grade AS creditGrade,
           credit_report_url AS creditReportUrl,
           resident_copy_date AS residentCopy, resident_copy_url AS residentCopyUrl,
           birth_date AS birthDate,
           resident_number AS residentNumber,
           sales_rep AS salesRep,
           key_notes AS keyNotes,
           principal_balance AS principalBalance, adjustment, collected_amount AS collectedAmount,
           final_balance_finance AS finalBalanceFinance,
           final_balance_legal AS finalBalanceLegal,
           (SELECT GROUP_CONCAT(name, ',') FROM debtor_guarantors WHERE debtor_id = id) AS guarantors_str
    FROM v_debtors
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY final_balance_legal DESC
  `;
  const rows = db.prepare(sql).all(params);
  res.json(rows.map(r => ({ ...r, guarantors: r.guarantors_str ? r.guarantors_str.split(',').filter(Boolean) : [], guarantors_str: undefined })));
});

// ─── 대시보드 통계 ──────────────────────────────
app.get("/api/dashboard", (req, res) => {
  const debtors = db.prepare("SELECT * FROM v_debtors").all();
  const total = debtors.length;
  const totalPrincipal = debtors.reduce((s, x) => s + (x.principal_balance || 0), 0);
  const totalCollected = debtors.reduce((s, x) => s + (x.collected_amount || 0), 0);
  const totalRemaining = debtors.reduce((s, x) => s + (x.final_balance_legal || 0), 0);
  const collectionRate = totalPrincipal > 0 ? (totalCollected / totalPrincipal) * 100 : 0;

  const byBrand = {};
  for (const d of debtors) {
    if (!byBrand[d.brand_code]) byBrand[d.brand_code] = { count: 0, principal: 0, collected: 0, remaining: 0 };
    byBrand[d.brand_code].count++;
    byBrand[d.brand_code].principal += d.principal_balance || 0;
    byBrand[d.brand_code].collected += d.collected_amount || 0;
    byBrand[d.brand_code].remaining += d.final_balance_legal || 0;
  }

  // 월별 입금실적 (2026년)
  const monthlyPayments = {};
  for (let m = 1; m <= 12; m++) monthlyPayments[m] = 0;
  const months = db.prepare(`
    SELECT CAST(strftime('%Y', payment_date) AS INT) AS yr,
           CAST(strftime('%m', payment_date) AS INT) AS mo,
           SUM(total_amount) AS s
    FROM payments
    WHERE strftime('%Y', payment_date) = '2026'
    GROUP BY mo
  `).all();
  for (const r of months) monthlyPayments[r.mo] = r.s;

  res.json({ total, totalPrincipal, totalCollected, totalRemaining, collectionRate, byBrand, monthlyPayments });
});

// ─── 입금 등록 핵심 함수 (POST /api/payments 와 Slack ingest 가 공유) ─────
// b: { debtorId?, paymentDate, payerName, totalAmount, companyAccount?, cashCharge?,
//      welcomeDirect?, note?, source?, brand?, hubCode?, debtorName?, createdByName? }
// 반환:
//   성공: { ok:true, paymentId, debtorId, matchedBy, balanceAfter }
//   매칭실패: { ok:false, pendingId, reason:'채무자 미발견' }
//   입력오류: { ok:false, error }
function ingestPayment(b) {
  const date = b.paymentDate;
  const total = parseInt(b.totalAmount, 10) || 0;
  if (!date) return { ok: false, error: "paymentDate가 필요합니다" };
  if (total <= 0) return { ok: false, error: "totalAmount는 0보다 커야 합니다" };

  const company = parseInt(b.companyAccount, 10) || 0;
  const cash = parseInt(b.cashCharge, 10) || 0;
  const welcome = parseInt(b.welcomeDirect, 10) || 0;
  let c = company, ch = cash, w = welcome;
  if (c + ch + w !== total) {
    // Slack/엑셀 입금은 기본적으로 본사계좌로 가정
    c = total - ch - w;
    if (c < 0) { c = total; ch = 0; w = 0; }
  }

  let resolvedId = b.debtorId;
  let matchedBy = "수동지정";
  if (!resolvedId) {
    // 1순위: 학습된 매핑 확인
    if (b.payerName) {
      const learned = db.prepare("SELECT debtor_id FROM payer_name_mappings WHERE payer_name = ?").get(b.payerName);
      if (learned) { resolvedId = learned.debtor_id; matchedBy = "학습매핑"; }
    }
  }
  if (!resolvedId) {
    // 2순위: 자동 매처
    const all = db.prepare("SELECT id, brand_code, name, hub_code FROM debtors").all();
    const idx = matcher.buildIndex(all);
    const m = matcher.matchDebtor(idx, {
      brand: b.brand, hubCode: b.hubCode,
      debtorName: b.debtorName, payerName: b.payerName,
    });
    if (m) { resolvedId = m.debtorId; matchedBy = m.matchedBy; }
  }

  if (!resolvedId) {
    const r = db.prepare(`
      INSERT INTO pending_payments (payment_date, excel_brand, excel_hub_code, excel_debtor_name,
                                    payer_name, total_amount, company_account, cash_charge,
                                    welcome_direct, note, source, source_ref, reason)
      VALUES (@payment_date, @brand, @hub_code, @debtor_name, @payer_name, @total, @c, @ch, @w,
              @note, @source, @source_ref, @reason)
    `).run({
      payment_date: date, brand: b.brand, hub_code: b.hubCode, debtor_name: b.debtorName,
      payer_name: b.payerName, total, c, ch, w, note: b.note || null,
      source: b.source || "slack", source_ref: b.sourceRef || null, reason: "채무자 미발견",
    });
    return { ok: false, pendingId: r.lastInsertRowid, reason: "채무자 미발견", payerName: b.payerName, total };
  }

  const debtor = db.prepare("SELECT * FROM debtors WHERE id = ?").get(resolvedId);
  if (!debtor) return { ok: false, error: `채무자 ${resolvedId} 없음` };

  // 중복 감지: 같은 채무자·날짜·금액이 이미 존재하면 force 없이는 차단
  if (!b.force) {
    const dup = db.prepare(
      "SELECT id FROM payments WHERE debtor_id = ? AND payment_date = ? AND total_amount = ?"
    ).get(resolvedId, date, total);
    if (dup) {
      return {
        ok: false,
        isDuplicate: true,
        existingPaymentId: dup.id,
        debtorId: resolvedId,
        debtorName: debtor.name,
        paymentDate: date,
        total,
        reason: "동일 채무자·날짜·금액 중복 입금 감지",
      };
    }
  }

  const result = db.transaction(() => {
    const last = db.prepare(`SELECT id FROM payments WHERE id LIKE 'PAY%' ORDER BY id DESC LIMIT 1`).get();
    const nextNum = last ? parseInt(last.id.substring(3), 10) + 1 : 1;
    const payId = `PAY${String(nextNum).padStart(5, "0")}`;

    db.prepare(`
      INSERT INTO payments (id, debtor_id, payment_date, payer_name, total_amount,
                            company_account, cash_charge, welcome_direct, note, created_by)
      VALUES (@id, @debtor_id, @payment_date, @payer_name, @total, @c, @ch, @w, @note, @created_by)
    `).run({
      id: payId, debtor_id: resolvedId, payment_date: date,
      payer_name: b.payerName || null, total, c, ch, w,
      note: b.note || null, created_by: b.createdBy || null,
    });

    db.prepare(`UPDATE debtors SET collected_amount = collected_amount + ?, updated_at = datetime('now', 'localtime') WHERE id = ?`).run(total, resolvedId);

    const after = db.prepare(`SELECT final_balance_legal, collection_status FROM v_debtors WHERE id = ?`).get(resolvedId);
    if (after && after.final_balance_legal <= 0 && after.collection_status !== "추심보류") {
      db.prepare(`UPDATE debtors SET collection_status = '추심보류' WHERE id = ?`).run(resolvedId);
    }

    const dt = new Date(date);
    const targetMonth = `${dt.getFullYear()}년 ${dt.getMonth() + 1}월`;
    db.prepare(`
      UPDATE installment_logs
         SET status = '완납',
             paid_amount = ?,
             memo = COALESCE(memo, '') || ' [자동완납:' || ? || ']'
       WHERE plan_id IN (SELECT id FROM installment_plans WHERE debtor_id = ?)
         AND target_month = ?
         AND status IN ('미납', '지연')
    `).run(total, date, resolvedId, targetMonth);

    db.prepare(`
      INSERT INTO audit_logs (user_name, action, target, target_id, detail)
      VALUES (?, '등록', '입금', ?, ?)
    `).run(b.createdByName || "시스템(자동)", payId,
           `${debtor.name} (${resolvedId}) 입금 ${total.toLocaleString()}원 — 매칭: ${matchedBy}`);

    return { payId, balanceAfter: after?.final_balance_legal ?? null };
  })();

  return {
    ok: true,
    paymentId: result.payId,
    debtorId: resolvedId,
    debtorName: debtor.name,
    matchedBy,
    balanceAfter: result.balanceAfter,
    payerName: b.payerName,
    total,
  };
}

// POST /api/payments — 단건 입금 등록
app.post("/api/payments", (req, res) => {
  const result = ingestPayment(req.body || {});
  res.json(result);
});

// POST /api/slack/preview — Slack 텍스트 파싱 + 매칭 미리보기 (DB 변경 없음)
// Body: { text, messageDate }
app.post("/api/slack/preview", (req, res) => {
  const { text, messageDate } = req.body || {};
  if (!text) return res.status(400).json({ error: "text가 필요합니다" });

  const { entries, meta } = slackParser.parse(text, messageDate);

  // 각 entry에 매칭 후보 부착
  const all = db.prepare("SELECT id, brand_code, name, hub_code FROM debtors").all();
  const idx = matcher.buildIndex(all);
  const enriched = entries.map(e => {
    const m = matcher.matchDebtor(idx, { payerName: e.payerName, debtorName: e.payerName });
    if (m) {
      const d = db.prepare("SELECT id, name, brand_code, hub_name FROM debtors WHERE id = ?").get(m.debtorId);
      return {
        ...e,
        suggestedDebtor: { id: d.id, name: d.name, brand: d.brand_code, hubName: d.hub_name },
        matchedBy: m.matchedBy,
      };
    }
    return { ...e, suggestedDebtor: null, matchedBy: null };
  });

  res.json({
    entries: enriched,
    meta,
    summary: {
      total: enriched.length,
      matched: enriched.filter(e => e.suggestedDebtor).length,
      unmatched: enriched.filter(e => !e.suggestedDebtor).length,
    },
  });
});

// POST /api/slack/ingest — Slack 텍스트를 실제 DB에 적재
// Body: { text, messageDate, createdByName? }
app.post("/api/slack/ingest", (req, res) => {
  const { text, messageDate, createdByName } = req.body || {};
  if (!text) return res.status(400).json({ error: "text가 필요합니다" });

  const { entries, meta } = slackParser.parse(text, messageDate);
  const results = entries.map(e =>
    ingestPayment({
      paymentDate: e.paymentDate,
      payerName: e.payerName,
      totalAmount: e.totalAmount,
      companyAccount: e.totalAmount,  // Slack은 본사계좌(국민#1812)로 가정
      source: "slack",
      sourceRef: messageDate || null,
      createdByName: createdByName || "Slack 자동수집",
    })
  );

  res.json({
    meta,
    results,
    summary: {
      total: results.length,
      success: results.filter(r => r.ok).length,
      pending: results.filter(r => !r.ok && r.pendingId).length,
      error: results.filter(r => !r.ok && r.error).length,
    },
  });
});

// ─── 입금 삭제 (잔액 원복) ──────────────────────
// DELETE /api/payments/:id
app.delete("/api/payments/:id", (req, res) => {
  const payId = req.params.id;
  const pay = db.prepare("SELECT * FROM payments WHERE id = ?").get(payId);
  if (!pay) return res.status(404).json({ ok: false, error: "해당 입금건 없음" });

  const result = db.transaction(() => {
    // 잔액 원복
    db.prepare(`UPDATE debtors SET collected_amount = collected_amount - ?, updated_at = datetime('now', 'localtime') WHERE id = ?`).run(pay.total_amount, pay.debtor_id);
    // 입금 삭제
    db.prepare("DELETE FROM payments WHERE id = ?").run(payId);

    const debtor = db.prepare(`SELECT name, final_balance_legal FROM v_debtors WHERE id = ?`).get(pay.debtor_id);
    db.prepare(`
      INSERT INTO audit_logs (user_name, action, target, target_id, detail)
      VALUES (?, '삭제', '입금', ?, ?)
    `).run(req.body?.userName || "시스템", payId,
           `${debtor?.name || pay.debtor_id} 입금 ${pay.total_amount.toLocaleString()}원 삭제 (잔액 원복)`);

    return { debtorId: pay.debtor_id, balanceAfter: debtor?.final_balance_legal ?? null };
  })();

  res.json({ ok: true, ...result });
});

// ─── 입금 재매칭 ────────────────────────────────────
// PATCH /api/payments/:id/rematch
app.patch("/api/payments/:id/rematch", (req, res) => {
  const payId = req.params.id;
  const { newDebtorId, userName } = req.body || {};
  if (!newDebtorId) return res.status(400).json({ ok: false, error: "newDebtorId 필요" });

  const pay = db.prepare("SELECT * FROM payments WHERE id = ?").get(payId);
  if (!pay) return res.status(404).json({ ok: false, error: "해당 입금건 없음" });
  if (pay.debtor_id === newDebtorId) return res.status(400).json({ ok: false, error: "동일 채무자로는 재매칭 불가" });

  try {
    const result = db.transaction(() => {
      const oldDebtor = db.prepare("SELECT name FROM debtors WHERE id = ?").get(pay.debtor_id);
      const newDebtor = db.prepare("SELECT name FROM debtors WHERE id = ?").get(newDebtorId);
      if (!newDebtor) throw new Error("새 채무자 없음");

      db.prepare(`UPDATE debtors SET collected_amount = collected_amount - ?, updated_at = datetime('now', 'localtime') WHERE id = ?`).run(pay.total_amount, pay.debtor_id);
      db.prepare(`UPDATE debtors SET collected_amount = collected_amount + ?, updated_at = datetime('now', 'localtime') WHERE id = ?`).run(pay.total_amount, newDebtorId);
      db.prepare(`UPDATE payments SET debtor_id = ? WHERE id = ?`).run(newDebtorId, payId);

      db.prepare(`INSERT INTO audit_logs (user_name, action, target, target_id, detail) VALUES (?, '재매칭', '입금', ?, ?)`).run(
        userName || "시스템", payId,
        `입금 ${pay.total_amount.toLocaleString()}원: ${oldDebtor?.name || pay.debtor_id} → ${newDebtor.name}`
      );
      return { ok: true };
    })();
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ─── 분할상환 Slack 알림 헬퍼 ─────────────────────────────────

async function sendInstallmentOverdueNotify(overdueList) {
  if (!slackNotify || !NOTIFY_CHANNEL || !overdueList.length) return;
  try {
    const lines = overdueList.map(s =>
      `• ${s.debtor_name} (${s.hub_name || "-"}) | ${s.debt_source || "-"} | ${(s.scheduled_amount || 0).toLocaleString()}원 | 기준일: ${s.due_date}`
    );
    await slackNotify.chat.postMessage({
      channel: NOTIFY_CHANNEL,
      text: `⚠️ *분할상환 지연 감지 - ${overdueList.length}건*\n${lines.join("\n")}`,
    });
  } catch(e) {
    console.warn("분할상환 지연 Slack 알림 실패:", e.message);
  }
}

async function sendInstallmentMonthlyNotify(database) {
  if (!slackNotify || !NOTIFY_CHANNEL) return { ok: false, reason: "Slack 미설정" };
  const today = new Date();
  const monthStr = today.toISOString().slice(0, 7);
  const kvKey = `installment_monthly_notify_${monthStr}`;
  const lastSent = database.prepare("SELECT value FROM kv_store WHERE key = ?").get(kvKey);
  if (lastSent) return { ok: false, reason: "이미 이번달 전송됨", lastSent: lastSent.value };

  const schedules = database.prepare(`
    SELECT s.*, p.debtor_id, d.name AS debtor_name, d.assignee, d.hub_name
    FROM installment_schedules s
    JOIN installment_plans p ON s.plan_id = p.id
    JOIN debtors d ON p.debtor_id = d.id
    WHERE (s.due_month = ? OR (s.due_date IS NOT NULL AND strftime('%Y-%m', s.due_date) = ?))
      AND s.status = '미납'
    ORDER BY d.assignee, d.name
  `).all(monthStr, monthStr);

  if (!schedules.length) return { ok: true, sent: false, reason: "이번달 예정 없음" };

  const byAssignee = {};
  schedules.forEach(s => {
    const k = s.assignee || "미지정";
    if (!byAssignee[k]) byAssignee[k] = [];
    byAssignee[k].push(s);
  });

  const yearMonth = `${today.getFullYear()}년 ${today.getMonth() + 1}월`;
  const total = schedules.reduce((acc, s) => acc + (s.scheduled_amount || 0), 0);
  let text = `📅 *[${yearMonth}] 분할상환 예정 목록*\n총 ${schedules.length}건 / 합계 ${total.toLocaleString()}원\n\n`;
  for (const [assignee, items] of Object.entries(byAssignee)) {
    text += `*◆ 담당: ${assignee}*\n`;
    items.forEach(s => {
      const date = s.due_date || (s.due_month ? `${s.due_month} (날짜미정)` : "날짜미정");
      text += `  • ${s.debtor_name} (${s.hub_name || "-"}) | ${s.debt_source || "-"} | ${(s.scheduled_amount || 0).toLocaleString()}원 | ${date}\n`;
    });
    text += "\n";
  }

  try {
    await slackNotify.chat.postMessage({ channel: NOTIFY_CHANNEL, text });
    database.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)").run(kvKey, new Date().toISOString());
    return { ok: true, sent: true, count: schedules.length };
  } catch(e) {
    console.warn("월간 분할상환 Slack 알림 실패:", e.message);
    return { ok: false, reason: e.message };
  }
}

// ─── 분할상환 API ──────────────────────────────────────────────

// GET /api/installments/schedules?month=YYYY-MM&status=미납&debtorId=...
app.get("/api/installments/schedules", (req, res) => {
  const { month, status, debtorId } = req.query;
  const where = [];
  const params = {};
  if (month) {
    where.push("(s.due_month = @month OR (s.due_date IS NOT NULL AND strftime('%Y-%m', s.due_date) = @month))");
    params.month = month;
  }
  if (status && status !== "전체") { where.push("s.status = @status"); params.status = status; }
  if (debtorId) { where.push("p.debtor_id = @debtorId"); params.debtorId = debtorId; }
  const sql = `
    SELECT s.*, p.debtor_id AS debtorId, d.name AS debtorName,
           d.brand_code AS brand, d.assignee, d.hub_code AS hubCode, d.hub_name AS hubName
    FROM installment_schedules s
    JOIN installment_plans p ON s.plan_id = p.id
    JOIN debtors d ON p.debtor_id = d.id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY COALESCE(s.due_date, s.due_month || '-01'), d.name
  `;
  const rows = db.prepare(sql).all(params);
  res.json(rows.map(r => ({
    id: r.id, planId: r.plan_id, debtorId: r.debtorId, debtorName: r.debtorName,
    brand: r.brand, assignee: r.assignee, hubCode: r.hubCode, hubName: r.hubName,
    debtSource: r.debt_source, institution: r.institution, loanAmount: r.loan_amount,
    interestRate: r.interest_rate, dueDate: r.due_date, dueMonth: r.due_month,
    scheduledAmount: r.scheduled_amount, paidAmount: r.paid_amount, status: r.status, memo: r.memo,
  })));
});

// POST /api/installments/auto-overdue - 지연 자동 처리
app.post("/api/installments/auto-overdue", async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const overdue = db.prepare(`
    SELECT s.*, p.debtor_id, d.name AS debtor_name, d.assignee, d.hub_name
    FROM installment_schedules s
    JOIN installment_plans p ON s.plan_id = p.id
    JOIN debtors d ON p.debtor_id = d.id
    WHERE s.due_date < ? AND s.status = '미납'
  `).all(today);
  if (overdue.length > 0) {
    const placeholders = overdue.map(() => "?").join(",");
    db.prepare(`UPDATE installment_schedules SET status = '지연' WHERE id IN (${placeholders})`).run(...overdue.map(s => s.id));
    await sendInstallmentOverdueNotify(overdue);
  }
  res.json({ ok: true, updated: overdue.length });
});

// POST /api/installments/monthly-notify - 월간 알림 수동 트리거
app.post("/api/installments/monthly-notify", async (req, res) => {
  if (req.body?.force) {
    const monthStr = new Date().toISOString().slice(0, 7);
    db.prepare("DELETE FROM kv_store WHERE key = ?").run(`installment_monthly_notify_${monthStr}`);
  }
  const result = await sendInstallmentMonthlyNotify(db);
  res.json(result);
});

// POST /api/installments/import-excel - 엑셀 이관
app.post("/api/installments/import-excel", (req, res) => {
  try {
    const XLSX = require("xlsx");
    const xlsxPath = path.join(__dirname, "../db/분할상환 규칙화low.xlsx");
    const wb = XLSX.readFile(xlsxPath, { cellDates: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { raw: true, defval: null });

    const debtors = db.prepare("SELECT id, name, hub_code FROM debtors").all();
    const byCode = {};
    debtors.forEach(d => { if (d.hub_code) byCode[String(d.hub_code).trim()] = d; });

    const today = new Date().toISOString().slice(0, 7); // YYYY-MM

    // 열 이름에서 YYYY-MM 파싱 ("2024년 1월", "2025년 12월", "2026년 1월 " 등)
    function parseMonthCol(colName) {
      const m = String(colName).match(/^(\d{4})년\s*(\d{1,2})월/);
      if (!m) return null;
      return `${m[1]}-${String(m[2]).padStart(2, "0")}`;
    }

    // 셀 값에서 금액 추출 (숫자 직접 또는 "150만원", "700,000원" 등)
    function parseAmount(val) {
      if (val === null || val === undefined) return 0;
      if (typeof val === "number") return val > 100 ? Math.round(val) : 0; // 100이하는 날짜/순번으로 간주
      const s = String(val).replace(/,/g, "");
      const manMatch = s.match(/(\d+(?:\.\d+)?)만원?/);
      if (manMatch) return Math.round(parseFloat(manMatch[1]) * 10000);
      const wonMatch = s.match(/(\d{3,})\s*원/);
      if (wonMatch) return parseInt(wonMatch[1]);
      return 0;
    }

    // 셀 메모로 납부 완료 여부 판단
    function isCellPaid(val) {
      const s = String(val ?? "");
      return /완료|완납|입금완료|완전/.test(s);
    }

    // 엑셀 피벗 형식의 월 컬럼 목록
    const monthCols = rows.length > 0
      ? Object.keys(rows[0]).filter(k => parseMonthCol(k) !== null)
      : [];

    let imported = 0, skipped = 0, planCreated = 0;
    const planCache = {};

    const importTx = db.transaction(() => {
      for (const row of rows) {
        const code = String(row["코드"] ?? "").trim();
        if (!code || code === "코드없음") { skipped++; continue; }
        const debtor = byCode[code];
        if (!debtor) { skipped++; continue; }

        // 플랜 확인/생성
        if (!planCache[code]) {
          let plan = db.prepare("SELECT id FROM installment_plans WHERE debtor_id = ?").get(debtor.id);
          if (!plan) {
            const planId = "INS" + debtor.id.replace(/\D/g, "").padStart(6, "0").slice(-6);
            const timing = String(row["분류"] ?? "수시").trim() || "수시";
            const monthlyAmt = typeof row["월분납액"] === "number" ? row["월분납액"] : 0;
            db.prepare("INSERT OR IGNORE INTO installment_plans (id, debtor_id, payment_timing, monthly_amount, status, memo) VALUES (?, ?, ?, ?, '진행중', '엑셀 이관')").run(
              planId, debtor.id, timing, monthlyAmt
            );
            planCreated++;
            plan = { id: planId };
          }
          planCache[code] = plan.id;
        }
        const planId = planCache[code];
        const defaultAmt = typeof row["월분납액"] === "number" ? row["월분납액"] : 0;

        // 각 월 컬럼 처리
        for (const col of monthCols) {
          const cellVal = row[col];
          if (cellVal === null || cellVal === undefined) continue;

          const dueMonth = parseMonthCol(col);
          if (!dueMonth) continue;

          const cellStr = String(cellVal).trim();
          if (!cellStr) continue;

          // 금액: 셀에 있으면 셀값, 없으면 월분납액
          const cellAmt = parseAmount(cellVal);
          const schedAmt = cellAmt > 0 ? cellAmt : defaultAmt;

          // 중복 방지
          const dup = db.prepare("SELECT id FROM installment_schedules WHERE plan_id=? AND due_month=? AND due_date IS NULL").get(planId, dueMonth);
          if (dup) continue;

          // 상태 결정
          let status;
          if (isCellPaid(cellVal)) status = "완납";
          else if (dueMonth < today) status = "지연";
          else status = "미납";

          const schedId = "SCH" + Date.now().toString(36).toUpperCase().slice(-6) + Math.random().toString(36).slice(2, 5).toUpperCase();
          const memo = cellStr.length > 300 ? cellStr.slice(0, 300) + "…" : cellStr;
          db.prepare("INSERT INTO installment_schedules (id, plan_id, due_month, scheduled_amount, paid_amount, status, memo) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
            schedId, planId, dueMonth, schedAmt, isCellPaid(cellVal) ? schedAmt : 0, status, memo
          );
          imported++;
        }
      }
    });
    importTx();
    res.json({ ok: true, imported, skipped, planCreated });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/installments - 전체 플랜 + 일정 목록
app.get("/api/installments", (req, res) => {
  const plans = db.prepare(`
    SELECT p.*, d.name AS debtor_name, d.brand_code AS brand, d.assignee,
           d.hub_code, d.hub_name, d.final_balance_legal AS total_claim
    FROM installment_plans p
    JOIN v_debtors d ON p.debtor_id = d.id
    ORDER BY p.start_date DESC, p.id
  `).all();
  const getSchedules = db.prepare("SELECT * FROM installment_schedules WHERE plan_id = ? ORDER BY COALESCE(due_date, due_month || '-01'), id");
  res.json(plans.map(p => ({
    id: p.id, debtorId: p.debtor_id, debtorName: p.debtor_name, brand: p.brand,
    assignee: p.assignee, hubCode: p.hub_code, hubName: p.hub_name,
    paymentTiming: p.payment_timing, monthlyAmount: p.monthly_amount,
    totalClaim: p.total_claim, startDate: p.start_date, status: p.status, memo: p.memo,
    schedules: getSchedules.all(p.id).map(s => ({
      id: s.id, planId: s.plan_id, debtSource: s.debt_source, institution: s.institution,
      loanAmount: s.loan_amount, interestRate: s.interest_rate,
      dueDate: s.due_date, dueMonth: s.due_month,
      scheduledAmount: s.scheduled_amount, paidAmount: s.paid_amount, status: s.status, memo: s.memo,
    })),
  })));
});

// POST /api/installments - 플랜 생성
app.post("/api/installments", (req, res) => {
  const { id, debtorId, paymentTiming, monthlyAmount, startDate, status, memo } = req.body || {};
  if (!id || !debtorId) return res.status(400).json({ ok: false, error: "id/debtorId 필요" });
  try {
    db.prepare("INSERT INTO installment_plans (id, debtor_id, payment_timing, monthly_amount, start_date, status, memo) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      id, debtorId, paymentTiming || "월말", monthlyAmount || 0, startDate || null, status || "진행중", memo || null
    );
    res.json({ ok: true, id });
  } catch(e) { res.status(400).json({ ok: false, error: e.message }); }
});

// PATCH /api/installments/schedules/:id - 일정 수정
app.patch("/api/installments/schedules/:id", (req, res) => {
  const cols = { status: "status", paidAmount: "paid_amount", dueDate: "due_date", dueMonth: "due_month", scheduledAmount: "scheduled_amount", memo: "memo" };
  const fields = [], vals = [];
  for (const [k, col] of Object.entries(cols)) {
    if (req.body[k] !== undefined) { fields.push(`${col} = ?`); vals.push(req.body[k]); }
  }
  if (!fields.length) return res.json({ ok: true });
  vals.push(req.params.id);
  db.prepare(`UPDATE installment_schedules SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
  res.json({ ok: true });
});

// DELETE /api/installments/schedules/:id - 일정 삭제
app.delete("/api/installments/schedules/:id", (req, res) => {
  db.prepare("DELETE FROM installment_schedules WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// PATCH /api/installments/:id - 플랜 수정
app.patch("/api/installments/:id", (req, res) => {
  const cols = { paymentTiming: "payment_timing", monthlyAmount: "monthly_amount", startDate: "start_date", status: "status", memo: "memo" };
  const fields = [], vals = [];
  for (const [k, col] of Object.entries(cols)) {
    if (req.body[k] !== undefined) { fields.push(`${col} = ?`); vals.push(req.body[k]); }
  }
  if (!fields.length) return res.json({ ok: true });
  vals.push(req.params.id);
  db.prepare(`UPDATE installment_plans SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
  res.json({ ok: true });
});

// DELETE /api/installments/:id - 플랜 삭제
app.delete("/api/installments/:id", (req, res) => {
  db.prepare("DELETE FROM installment_plans WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// POST /api/installments/:planId/schedules - 일정 추가
app.post("/api/installments/:planId/schedules", (req, res) => {
  const { id, debtSource, institution, loanAmount, interestRate, dueDate, dueMonth, scheduledAmount, memo } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, error: "id 필요" });
  try {
    db.prepare("INSERT INTO installment_schedules (id, plan_id, debt_source, institution, loan_amount, interest_rate, due_date, due_month, scheduled_amount, memo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      id, req.params.planId, debtSource || null, institution || null, loanAmount || null,
      interestRate || null, dueDate || null, dueMonth || null, scheduledAmount || 0, memo || null
    );
    res.json({ ok: true });
  } catch(e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ─── Slack 봇 상태 ──────────────────────────────
app.get("/api/slack/status", (req, res) => {
  res.json(slackBot.getStatus());
});

// ─── Slack 즉시 폴링 (수동 트리거) ───────────────
app.post("/api/slack/poll-now", async (req, res) => {
  const result = await slackBot.pollOnce(db, ingestPayment);
  res.json({ ...result, status: slackBot.getStatus() });
});

// ─── 형사고소 목록 조회 ─────────────────────────
app.get("/api/complaints", (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT c.id, d.brand_code AS brand, d.name AS debtorName, c.debtor_id AS debtorId,
             c.complainant, c.charge, c.goods_amount AS goodsAmount, c.loan_amount AS loanAmount,
             c.complaint_date AS complaintDate, c.police_station AS policeStation,
             c.status, c.investigator, c.investigator_contact AS investigatorContact,
             c.complaint_url AS complaintUrl
      FROM complaints c
      JOIN debtors d ON c.debtor_id = d.id
      ORDER BY c.complaint_date DESC, c.id
    `).all();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 채무자 신규 등록 ────────────────────────────
app.post("/api/debtors", (req, res) => {
  try {
    const b = req.body;
    const id = b.id || `NPL${Date.now()}`;
    db.prepare(`
      INSERT INTO debtors (id, brand_code, brand_name, category, assignee, name, phone,
        hub_code, hub_name, debt_cause, collection_status, exec_title, exec_title_url,
        loan_date, subrogation_month, birth_date, resident_number, sales_rep, key_notes,
        principal_balance, adjustment, collected_amount)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, b.brand || "B", b.brandName || "", b.category || "", b.assignee || "",
      b.name || "", b.phone || "", b.hubCode || "", b.hubName || "",
      b.debtCause || "", b.collectionStatus || "", b.execTitle ? 1 : 0, b.execTitleUrl || "",
      b.loanDate || "", b.subrogationMonth || "", b.birthDate || "", b.residentNumber || "",
      b.salesRep || "", b.keyNotes || "",
      b.principalBalance || 0, b.adjustment || 0, b.collectedAmount || 0
    );
    // 연대보증인 INSERT
    if (Array.isArray(b.guarantors)) {
      const insG = db.prepare("INSERT INTO debtor_guarantors (debtor_id, name) VALUES (?, ?)");
      for (const g of b.guarantors.filter(n => n && String(n).trim())) insG.run(id, String(g).trim());
    }
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── 채무자 삭제 ──────────────────────────────────
app.delete("/api/debtors/:id", (req, res) => {
  try {
    const { id } = req.params;
    db.prepare("DELETE FROM payments WHERE debtor_id = ?").run(id);
    db.prepare("DELETE FROM activities WHERE debtor_id = ?").run(id);
    db.prepare("DELETE FROM rehabilitations WHERE debtor_id = ?").run(id);
    db.prepare("DELETE FROM installment_plans WHERE debtor_id = ?").run(id);
    db.prepare("DELETE FROM complaints WHERE debtor_id = ?").run(id);
    db.prepare("DELETE FROM debtors WHERE id = ?").run(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── 채무자 정보 수정 ────────────────────────────
app.patch("/api/debtors/:id", (req, res) => {
  try {
    const { id } = req.params;
    const fieldMap = {
      category:"category",assignee:"assignee",name:"name",phone:"phone",
      hubCode:"hub_code",hubName:"hub_name",debtCause:"debt_cause",collectionStatus:"collection_status",
      execTitle:"exec_title",execTitleUrl:"exec_title_url",loanDate:"loan_date",
      subrogationMonth:"subrogation_month",subrogationDocUrl:"subrogation_doc_url",
      creditCheck:"credit_check_date",creditGrade:"credit_grade",creditReportUrl:"credit_report_url",
      residentCopy:"resident_copy_date",residentCopyUrl:"resident_copy_url",
      birthDate:"birth_date",residentNumber:"resident_number",
      salesRep:"sales_rep",keyNotes:"key_notes",
      principalBalance:"principal_balance",adjustment:"adjustment",collectedAmount:"collected_amount",
    };
    const fields = [], vals = [];
    for (const [jsKey, dbCol] of Object.entries(fieldMap)) {
      if (req.body[jsKey] !== undefined) { fields.push(`${dbCol} = ?`); vals.push(req.body[jsKey]); }
    }
    if (fields.length === 0 && req.body.guarantors === undefined) return res.json({ ok: true });
    if (fields.length > 0) {
      fields.push("updated_at = datetime('now','localtime')");
      vals.push(id);
      db.prepare(`UPDATE debtors SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
    }
    // 연대보증인 업데이트 (기존 삭제 후 재삽입)
    if (req.body.guarantors !== undefined) {
      const guarantors = Array.isArray(req.body.guarantors) ? req.body.guarantors : [];
      db.prepare("DELETE FROM debtor_guarantors WHERE debtor_id = ?").run(id);
      const insG = db.prepare("INSERT INTO debtor_guarantors (debtor_id, name) VALUES (?, ?)");
      for (const g of guarantors.filter(n => n && String(n).trim())) insG.run(id, String(g).trim());
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── 형사고소 수정 (상태·URL·수사관 정보) ────────
app.patch("/api/complaints/:id", (req, res) => {
  try {
    const { id } = req.params;
    const { status, complaintUrl, investigator, investigatorContact, debtorId, policeStation, charge } = req.body;
    const fields = [];
    const vals   = [];
    if (status              !== undefined) { fields.push("status = ?");                vals.push(status); }
    if (complaintUrl        !== undefined) { fields.push("complaint_url = ?");          vals.push(complaintUrl); }
    if (investigator        !== undefined) { fields.push("investigator = ?");           vals.push(investigator); }
    if (investigatorContact !== undefined) { fields.push("investigator_contact = ?");   vals.push(investigatorContact); }
    if (debtorId            !== undefined) { fields.push("debtor_id = ?");              vals.push(debtorId); }
    if (policeStation       !== undefined) { fields.push("police_station = ?");         vals.push(policeStation); }
    if (charge              !== undefined) { fields.push("charge = ?");                 vals.push(charge); }
    if (fields.length === 0) return res.json({ ok: true });
    vals.push(id);
    db.prepare(`UPDATE complaints SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── 형사고소 신규 등록 ──────────────────────────
app.post("/api/complaints", (req, res) => {
  try {
    const b = req.body;
    if (!b.id || !b.debtorId) return res.status(400).json({ ok: false, error: "id/debtorId 필요" });
    db.prepare(`
      INSERT INTO complaints (id, debtor_id, complainant, goods_amount, loan_amount, charge,
        complaint_date, police_station, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(b.id, b.debtorId, b.complainant || "", b.goodsAmount || 0, b.loanAmount || 0,
           b.charge || "", b.complaintDate || "", b.policeStation || "", b.status || "수사중");
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── 형사고소 삭제 ────────────────────────────────
app.delete("/api/complaints/:id", (req, res) => {
  try {
    db.prepare("DELETE FROM complaint_history WHERE complaint_id = ?").run(req.params.id);
    db.prepare("DELETE FROM complaints WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── 활동사항 조회 ────────────────────────────────
app.get("/api/activities", (req, res) => {
  try {
    const { debtorId } = req.query;
    const sql = debtorId
      ? `SELECT a.id, a.debtor_id AS debtorId, d.name AS debtorName, d.brand_code AS brand,
                a.activity_date AS activityDate, a.activity_type AS activityType,
                a.content, a.assignee, a.created_by AS createdBy
         FROM activities a JOIN debtors d ON a.debtor_id = d.id
         WHERE a.debtor_id = ? ORDER BY a.activity_date DESC, a.id DESC`
      : `SELECT a.id, a.debtor_id AS debtorId, d.name AS debtorName, d.brand_code AS brand,
                a.activity_date AS activityDate, a.activity_type AS activityType,
                a.content, a.assignee, a.created_by AS createdBy
         FROM activities a JOIN debtors d ON a.debtor_id = d.id
         ORDER BY a.activity_date DESC, a.id DESC`;
    const rows = debtorId
      ? db.prepare(sql).all(debtorId)
      : db.prepare(sql).all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 활동사항 등록 ────────────────────────────────
app.post("/api/activities", (req, res) => {
  try {
    const { id, debtorId, activityDate, activityType, content, assignee, createdBy } = req.body;
    if (!id || !debtorId) return res.status(400).json({ ok: false, error: "id/debtorId 필요" });
    db.prepare("INSERT INTO activities (id, debtor_id, activity_date, activity_type, content, assignee, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, debtorId, activityDate || "", activityType || "", content || "", assignee || "", createdBy || "");
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── 활동사항 삭제 ────────────────────────────────
app.delete("/api/activities/:id", (req, res) => {
  try {
    db.prepare("DELETE FROM activities WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── 형사고소 진행 히스토리 ──────────────────────
app.get("/api/complaints/:id/history", (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM complaint_history WHERE complaint_id = ? ORDER BY date DESC, id DESC").all(req.params.id);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/complaints/:id/history", (req, res) => {
  try {
    const { date, content, assignee } = req.body;
    if (!date || !content) return res.status(400).json({ ok: false, error: "date, content 필수" });
    const r = db.prepare("INSERT INTO complaint_history (complaint_id, date, content, assignee) VALUES (?, ?, ?, ?)")
               .run(req.params.id, date, content, assignee || null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.patch("/api/complaint-history/:id", (req, res) => {
  try {
    const { date, content, assignee } = req.body;
    const fields = [], vals = [];
    if (date    !== undefined) { fields.push("date = ?");     vals.push(date); }
    if (content !== undefined) { fields.push("content = ?");  vals.push(content); }
    if (assignee !== undefined) { fields.push("assignee = ?"); vals.push(assignee); }
    if (fields.length === 0) return res.json({ ok: true });
    vals.push(req.params.id);
    db.prepare(`UPDATE complaint_history SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.delete("/api/complaint-history/:id", (req, res) => {
  try {
    db.prepare("DELETE FROM complaint_history WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── 매칭 실패 대기열 조회 ──────────────────────
app.get("/api/pending-payments", (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM pending_payments WHERE resolved = 0 ORDER BY payment_date DESC
  `).all();
  res.json(rows);
});

// ─── 보류 항목 채무자 수동 연결 ─────────────────
app.post("/api/pending-payments/:id/resolve", (req, res) => {
  const pendingId = parseInt(req.params.id, 10);
  const { debtorId, createdByName } = req.body || {};
  if (!debtorId) return res.status(400).json({ ok: false, error: "debtorId가 필요합니다" });

  const pending = db.prepare("SELECT * FROM pending_payments WHERE id = ? AND resolved = 0").get(pendingId);
  if (!pending) return res.status(404).json({ ok: false, error: "대기 항목 없음" });

  const result = ingestPayment({
    debtorId,
    paymentDate: pending.payment_date,
    payerName: pending.payer_name,
    totalAmount: pending.total_amount,
    companyAccount: pending.company_account,
    cashCharge: pending.cash_charge,
    welcomeDirect: pending.welcome_direct,
    note: pending.note,
    source: pending.source,
    sourceRef: pending.source_ref,
    createdByName: createdByName || "수동연결",
  });

  if (result.ok) {
    db.prepare("UPDATE pending_payments SET resolved = 1, resolved_to_payment_id = ? WHERE id = ?")
      .run(result.paymentId, pendingId);

    // 학습 매핑 저장 (같은 입금자명은 앞으로 자동 적용)
    const debtor = db.prepare("SELECT name FROM debtors WHERE id = ?").get(debtorId);
    db.prepare(`
      INSERT INTO payer_name_mappings (payer_name, debtor_id, debtor_name, resolved_count, learned_at)
      VALUES (?, ?, ?, 1, datetime('now', 'localtime'))
      ON CONFLICT(payer_name) DO UPDATE SET
        debtor_id = excluded.debtor_id,
        debtor_name = excluded.debtor_name,
        resolved_count = resolved_count + 1,
        learned_at = excluded.learned_at
    `).run(pending.payer_name, debtorId, debtor?.name || null);

    // 같은 입금자명의 다른 보류 건 즉시 자동처리
    const samePending = db.prepare(
      "SELECT * FROM pending_payments WHERE payer_name = ? AND resolved = 0 AND id != ?"
    ).all(pending.payer_name, pendingId);

    let autoResolved = 0;
    for (const other of samePending) {
      const r2 = ingestPayment({
        debtorId,
        paymentDate: other.payment_date,
        payerName: other.payer_name,
        totalAmount: other.total_amount,
        companyAccount: other.company_account,
        cashCharge: other.cash_charge,
        welcomeDirect: other.welcome_direct,
        note: other.note,
        source: other.source,
        sourceRef: other.source_ref,
        createdByName: "학습매핑 자동처리",
      });
      if (r2.ok) {
        db.prepare("UPDATE pending_payments SET resolved = 1, resolved_to_payment_id = ? WHERE id = ?")
          .run(r2.paymentId, other.id);
        autoResolved++;
      }
    }

    return res.json({ ...result, autoResolved });
  }

  res.json(result);
});

// ─── 학습 매핑 조회 ──────────────────────────────
app.get("/api/payer-mappings", (req, res) => {
  const rows = db.prepare(`
    SELECT pm.*, d.name AS debtor_name
    FROM payer_name_mappings pm
    LEFT JOIN debtors d ON pm.debtor_id = d.id
    ORDER BY pm.learned_at DESC
  `).all();
  res.json(rows);
});

// ─── 학습 매핑 삭제 ──────────────────────────────
app.delete("/api/payer-mappings/:payerName", (req, res) => {
  db.prepare("DELETE FROM payer_name_mappings WHERE payer_name = ?").run(
    decodeURIComponent(req.params.payerName)
  );
  res.json({ ok: true });
});

// ─── 보류 항목 삭제 ──────────────────────────────
app.delete("/api/pending-payments/:id", (req, res) => {
  const pendingId = parseInt(req.params.id, 10);
  const result = db.prepare("DELETE FROM pending_payments WHERE id = ? AND resolved = 0").run(pendingId);
  if (result.changes === 0) return res.status(404).json({ ok: false, error: "항목 없음" });
  res.json({ ok: true });
});

// ─── AI 문건생성 ─────────────────────────────────
app.post("/api/documents/generate-hwpx", async (req, res) => {
  try {
    const docData = req.body;
    if (!docData || !docData.debtorName) {
      return res.status(400).json({ ok: false, error: "채무자명 필수" });
    }
    const buffer = await generateHwpx(docData);
    const filename = encodeURIComponent(`압류채권표시_${docData.debtorName}.hwpx`);
    res.setHeader("Content-Type", "application/hwp+zip");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${filename}`);
    res.send(buffer);
  } catch (e) {
    console.error("HWPX 생성 오류:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/documents/preview-html", (req, res) => {
  try {
    const html = buildPreviewHtml(req.body || {});
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── 정적 파일 서빙 (React 빌드) ────────────────
// ─── 공유 KV 스토어 API (localStorage → DB 마이그레이션) ──
// 내부 서버 전용 키는 클라이언트에 노출하지 않음
const KV_INTERNAL_PREFIXES = ["slack_last_ts", "cmp_hist_migrated"];
const isInternalKey = (k) => KV_INTERNAL_PREFIXES.some(p => k.startsWith(p));

// GET /api/kv-all — 앱 공유 KV 전체 조회 (loadData 시 localStorage 동기화용)
app.get("/api/kv-all", (req, res) => {
  const rows = db.prepare("SELECT key, value FROM kv_store").all();
  const result = {};
  for (const { key, value } of rows) {
    if (isInternalKey(key)) continue;
    try { result[key] = JSON.parse(value); } catch { result[key] = value; }
  }
  res.json(result);
});

// PUT /api/kv/:key — 키 하나 저장 (저장 후 SSE broadcast)
app.put("/api/kv/:key", (req, res) => {
  const key = req.params.key;
  if (isInternalKey(key)) return res.status(403).json({ error: "internal key" });
  db.prepare(`
    INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now', 'localtime'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(req.body));
  res.json({ ok: true });
});

// ─── 서류 연결 (Document Links) ──────────────────────────────

// 스캔 루트 경로 조회
app.get("/api/admin/docs-config", (req, res) => {
  const row = db.prepare("SELECT value FROM kv_store WHERE key='docs_scan_root'").get();
  res.json({ rootPath: row ? row.value : null });
});

// 스캔 루트 경로 저장
app.patch("/api/admin/docs-config", (req, res) => {
  try {
    const { rootPath } = req.body;
    if (!rootPath) return res.status(400).json({ ok: false, error: "rootPath 필요" });
    db.prepare(`
      INSERT INTO kv_store (key, value, updated_at) VALUES ('docs_scan_root', ?, datetime('now','localtime'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(rootPath);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 채무자별 연결된 서류 조회
app.get("/api/documents/:debtorId", (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM debtor_documents WHERE debtor_id = ? ORDER BY linked_at DESC").all(req.params.debtorId);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 채무자별 파일 후보 스캔
app.get("/api/documents/:debtorId/scan", (req, res) => {
  try {
    const rootRow = db.prepare("SELECT value FROM kv_store WHERE key='docs_scan_root'").get();
    if (!rootRow || !rootRow.value) return res.status(400).json({ ok: false, error: "스캔 폴더 경로가 설정되지 않았습니다. 관리자 > 서류 폴더 설정에서 지정해주세요." });

    const debtor = db.prepare("SELECT id, name FROM debtors WHERE id = ?").get(req.params.debtorId);
    if (!debtor) return res.status(404).json({ ok: false, error: "채무자 없음" });

    const guarantors = db.prepare("SELECT name FROM debtor_guarantors WHERE debtor_id = ?").all(debtor.id).map(r => r.name);
    const minScore = parseInt(req.query.minScore, 10) || 20;

    const result = fileScanner.findCandidates(rootRow.value, debtor.name, guarantors, minScore);
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 서류 연결 저장
app.post("/api/documents/:debtorId/link", (req, res) => {
  try {
    const { filePath, fileName, docLabel, matchType, matchedName, linkedBy } = req.body;
    if (!filePath || !fileName) return res.status(400).json({ ok: false, error: "filePath, fileName 필요" });
    db.prepare(`
      INSERT OR IGNORE INTO debtor_documents (debtor_id, file_path, file_name, doc_label, match_type, matched_name, linked_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(req.params.debtorId, filePath, fileName, docLabel || null, matchType || null, matchedName || null, linkedBy || null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 서류 연결 해제
app.delete("/api/documents/link/:id", (req, res) => {
  try {
    db.prepare("DELETE FROM debtor_documents WHERE id = ?").run(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 파일 스트리밍 (보안: 설정된 루트 경로 내부만 허용)
app.get("/api/documents/file", (req, res) => {
  try {
    const rootRow = db.prepare("SELECT value FROM kv_store WHERE key='docs_scan_root'").get();
    const rootPath = rootRow ? rootRow.value : null;
    if (!rootPath) return res.status(400).json({ error: "스캔 경로 미설정" });

    const requestedPath = req.query.path;
    if (!requestedPath) return res.status(400).json({ error: "path 파라미터 필요" });

    const normalizedRoot = path.resolve(rootPath);
    const normalizedFile = path.resolve(requestedPath);
    if (!normalizedFile.startsWith(normalizedRoot + path.sep) && normalizedFile !== normalizedRoot) {
      return res.status(403).json({ error: "허용되지 않은 경로" });
    }
    if (!fs.existsSync(normalizedFile)) return res.status(404).json({ error: "파일 없음" });

    const ext = path.extname(normalizedFile).toLowerCase();
    const MIME = {
      ".pdf":"application/pdf", ".docx":"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".doc":"application/msword", ".xlsx":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".xls":"application/vnd.ms-excel", ".hwp":"application/x-hwp", ".hwpx":"application/x-hwpx",
      ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".png":"image/png", ".zip":"application/zip",
    };
    const filename = path.basename(normalizedFile);
    res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(filename)}`);
    fs.createReadStream(normalizedFile).pipe(res);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use(express.static(path.join(__dirname, "../dist")));
app.get("/{*splat}", (req, res) => {
  if (!req.path.startsWith("/api")) {
    res.sendFile(path.join(__dirname, "../dist/index.html"));
  }
});

// ─── 서버 기동 ──────────────────────────────────
const PORT = 3010;
app.listen(PORT, () => {
  const counts = {
    debtors: db.prepare("SELECT COUNT(*) AS c FROM debtors").get().c,
    payments: db.prepare("SELECT COUNT(*) AS c FROM payments").get().c,
    pending: db.prepare("SELECT COUNT(*) AS c FROM pending_payments").get().c,
  };
  console.log(`✅ DEBTFLOW Backend on http://localhost:${PORT}`);
  console.log(`   DB: ${DB_PATH}`);
  console.log(`   채무자: ${counts.debtors}건 / 입금: ${counts.payments}건 / 대기열: ${counts.pending}건`);
  // Slack 봇 시작 시도 (.env 설정 있을 때만 실제로 동작)
  slackBot.startBot(db, ingestPayment);

  // 매월 1일: 분할상환 월간 알림 자동 발송
  const todayDate = new Date().getDate();
  if (todayDate === 1) {
    setTimeout(() => sendInstallmentMonthlyNotify(db).catch(() => {}), 5000);
  }
});
