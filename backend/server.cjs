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
const os = require("os");
let pdfParse; try { pdfParse = require("pdf-parse"); } catch(e) { pdfParse = null; }
// Power Automate 등 외부에서 /api/todo-list/from-outlook-flag 호출 시 검증할 공유 비밀값.
// .env에 OUTLOOK_FLAG_SECRET을 지정하지 않으면 검증 없이 허용(로컬 테스트용).
const OUTLOOK_FLAG_SECRET = process.env.OUTLOOK_FLAG_SECRET || "";
// 노션 "플래그 메일함" 데이터베이스에서 제목을 To Do List로 가져오기 위한 설정.
const NOTION_API_KEY = process.env.NOTION_API_KEY || "";
const NOTION_FLAG_DB_ID = process.env.NOTION_FLAG_DB_ID || "";
const matcher = require("./matcher.cjs");
const slackParser = require("./slackParser.cjs");
const slackBot = require("./slackBot.cjs");
const fileScanner = require("./fileScanner.cjs");
const multer = require("multer");
const { generateHwpx, buildPreviewHtml } = require("./documentGenerator.cjs");
const { scanHistoryPromises } = require("./historyPromiseScan.cjs");
const { WebClient: SlackClient } = require("@slack/web-api");

const slackNotify = process.env.SLACK_BOT_TOKEN ? new SlackClient(process.env.SLACK_BOT_TOKEN) : null;
const NOTIFY_CHANNEL = process.env.SLACK_NOTIFY_CHANNEL_ID || process.env.SLACK_CHANNEL_ID;

const DB_PATH = path.join(__dirname, "..", "db", "debtflow.db");
const db = new Database(DB_PATH, { readonly: false });
db.pragma("foreign_keys = ON");

// ─── v_debtors 뷰 재생성 (재무기준잔액=원채무액-회수액, 법무기준잔액=원채무액+추가법무비용-회수액)
db.exec(`
  DROP VIEW IF EXISTS v_debtors;
  CREATE VIEW v_debtors AS
  SELECT
    d.*,
    b.name  AS brand_name,
    b.color AS brand_color,
    (d.principal_balance - d.collected_amount)                        AS final_balance_finance,
    (d.principal_balance + d.adjustment - d.collected_amount)         AS final_balance_legal
  FROM debtors d
  LEFT JOIN brands b ON d.brand_code = b.code;
`);

// ─── 기본 보조 테이블 자동 생성 ──────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
  CREATE TABLE IF NOT EXISTS file_index (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT UNIQUE NOT NULL,
    filename TEXT NOT NULL,
    folder_name TEXT,
    rel_path TEXT,
    parsed_date TEXT,
    parsed_direction TEXT,
    parsed_person_name TEXT,
    doc_type TEXT,
    ext TEXT,
    indexed_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_file_index_person ON file_index(parsed_person_name);
  CREATE INDEX IF NOT EXISTS idx_file_index_filename ON file_index(filename);
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
  CREATE TABLE IF NOT EXISTS installment_schedule_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    debtor_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    from_date TEXT,
    to_date TEXT,
    amount INTEGER,
    memo TEXT,
    user_name TEXT DEFAULT '관리자',
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_inst_hist_plan ON installment_schedule_history(plan_id);
  CREATE INDEX IF NOT EXISTS idx_inst_hist_debtor ON installment_schedule_history(debtor_id);
`);
try { db.exec("ALTER TABLE installment_plans ADD COLUMN memo TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE debtors ADD COLUMN resident_number TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE installment_schedules ADD COLUMN rolled_over_to TEXT"); } catch(e) {}
// 이월로 새로 생성된 일정이 원래 일정을 역참조하기 위한 컬럼 — 화면에서 "이월된 항목"
// 배지를 표시하는 데 사용 (rolled_over_to는 옛 일정→새 일정, 이건 반대 방향).
try { db.exec("ALTER TABLE installment_schedules ADD COLUMN rolled_over_from TEXT"); } catch(e) {}

// ─── DB 마이그레이션 (컬럼 추가 / 테이블 생성) ─────────────
{
  const debtorCols = db.prepare("PRAGMA table_info(debtors)").all().map(c => c.name);
  for (const [col, type] of [
    ["credit_report_url",   "TEXT"],
    ["resident_copy_url",   "TEXT"],
    ["exec_title_url",      "TEXT"],
    ["subrogation_doc_url", "TEXT"],
    ["latest_address",      "TEXT"],
    ["latest_address_lat",  "REAL"],
    ["latest_address_lng",  "REAL"],
    ["latest_address_updated_at", "TEXT"],
    ["resident_address",           "TEXT"],
    ["resident_registered_date",   "TEXT"],
    ["resident_note",              "TEXT"],
    ["resident_issued_date",       "TEXT"],
    ["credit_phone",               "TEXT"],
    ["credit_queried_date",        "TEXT"],
    ["resident_address_lat",       "REAL"],
    ["resident_address_lng",       "REAL"],
    ["resident_source_date",       "TEXT"],
    ["credit_source_date",         "TEXT"],
    // 이름만으로 CB/초본 문서를 찾다가 동명이인(다른 사람) 데이터가 섞였다고 사람이 직접
    // 확인한 경우, 그 항목의 이름매칭 자동조회/표시를 끈다. 기존 값은 지우지 않고 그대로
    // 두므로(숨김만) 다시 끄면(제외 해제) 즉시 원래대로 복원된다.
    ["cb_match_excluded",           "INTEGER NOT NULL DEFAULT 0"],
    ["resident_match_excluded",     "INTEGER NOT NULL DEFAULT 0"],
    // 대위변제일을 사람이 명시적으로 지운 경우 표시. 이 플래그가 없으면 빈 값과
    // "한 번도 입력 안 한 상태"를 구분할 수 없어서, 지워도 대위변제증명서 OCR
    // 자동추출 결과가 화면에 다시 채워지는 문제가 있었다. 값을 다시 채우면 해제된다.
    ["subrogation_month_cleared",   "INTEGER NOT NULL DEFAULT 0"],
    // 사람이 직접 지정하는 채권 소멸시효 연장일(시효중단/재판 등으로 시효가 새로
    // 시작되는 날짜). 값이 있으면 대여일자 대신 이 날짜를 기준으로 소멸시효를 계산한다 —
    // 지정하지 않은 채무자는 기존 대여일자 기준 계산이 그대로 유지된다.
    ["statute_extension_date",      "TEXT"],
  ]) {
    if (!debtorCols.includes(col)) {
      db.exec(`ALTER TABLE debtors ADD COLUMN ${col} ${type}`);
    }
  }

  const guarantorCols = db.prepare("PRAGMA table_info(debtor_guarantors)").all().map(c => c.name);
  for (const [col, type] of [
    ["cb_match_excluded",       "INTEGER NOT NULL DEFAULT 0"],
    ["resident_match_excluded", "INTEGER NOT NULL DEFAULT 0"],
  ]) {
    if (!guarantorCols.includes(col)) {
      db.exec(`ALTER TABLE debtor_guarantors ADD COLUMN ${col} ${type}`);
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

// ─── 알림 규칙 (알림 설정 화면에서 CRUD, 규칙 엔진이 주기적으로 평가) ─────
// db/schema.sql에 이미 alert_rules 테이블/시드 정의가 있고 실제 debtflow.db에도 이미
// 만들어져 있었다(설정 화면만 있고 백엔드 소비 로직이 없었던 상태) — 그 스키마를 그대로 쓰고
// DM 발송에 필요한 컬럼만 추가한다.
db.exec(`
  CREATE TABLE IF NOT EXISTS alert_rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    trigger_type TEXT NOT NULL,
    condition_text TEXT,
    target TEXT NOT NULL DEFAULT 'channel',
    channel TEXT,
    assignee TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS alert_sent_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id TEXT NOT NULL,
    sent_date TEXT NOT NULL,
    entity_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(rule_id, sent_date)
  );
`);
try { db.exec("ALTER TABLE alert_rules ADD COLUMN assignee_slack_id TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE alert_rules ADD COLUMN updated_at TEXT"); } catch (e) {}
// 최초 실행 시에만 기존 프론트엔드 기본값(DEFAULT_ALERT_RULES)과 동일한 규칙을 시드
if (db.prepare("SELECT COUNT(*) c FROM alert_rules").get().c === 0) {
  const seedRules = [
    { id: "rule1", name: "분할상환 미납", enabled: 1, trigger_type: "installment_overdue", condition_text: "미납 1회 이상", target: "dm", channel: "", assignee: "준원", assignee_slack_id: "U05AGKJNVEY" },
    { id: "rule2", name: "회생 변제금 미납", enabled: 1, trigger_type: "rehab_overdue", condition_text: "미납 상태", target: "channel", channel: "#npl-알림", assignee: "" },
    { id: "rule3", name: "고액 잔액", enabled: 1, trigger_type: "high_balance", condition_text: "잔액 1,000만원 초과", target: "dm", channel: "", assignee: "준원", assignee_slack_id: "U05AGKJNVEY" },
    { id: "rule4", name: "신규 입금", enabled: 0, trigger_type: "new_payment", condition_text: "입금 등록 시", target: "channel", channel: "#npl-입금", assignee: "" },
    { id: "rule5", name: "장기 미연락", enabled: 0, trigger_type: "no_contact", condition_text: "30일 이상 활동 없음", target: "dm", channel: "", assignee: "" },
  ];
  const insSeed = db.prepare(`
    INSERT INTO alert_rules (id, name, enabled, trigger_type, condition_text, target, channel, assignee, assignee_slack_id)
    VALUES (@id, @name, @enabled, @trigger_type, @condition_text, @target, @channel, @assignee, @assignee_slack_id)
  `);
  db.transaction(() => seedRules.forEach(r => insSeed.run({ assignee_slack_id: null, ...r })))();
}

// 분할상환 미납/고액 잔액 알림이 수신인 미등록으로 채널에 대체 발송되던 문제 1회 수정
// (rule1을 채널→DM으로, rule1/rule3에 준원 Slack ID를 채워 채널 대체발송 경로를 막는다)
if (!db.prepare("SELECT value FROM kv_store WHERE key='alert_rules_dm_fix_v1'").get()) {
  db.prepare("UPDATE alert_rules SET target='dm', channel='', assignee='준원', assignee_slack_id='U05AGKJNVEY' WHERE id='rule1'").run();
  db.prepare("UPDATE alert_rules SET assignee='준원', assignee_slack_id='U05AGKJNVEY' WHERE id='rule3'").run();
  db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('alert_rules_dm_fix_v1', '1')").run();
}

// 채무자 히스토리에 적힌 입금 약속일(오늘 ±1일 — 어제/오늘/내일)을 매일 리마인드하는
// 새 규칙 — 요청자 본인(준원)에게만 DM으로 보낸다. alert_rules는 최초 실행 시에만
// 시드되므로, 이미 운영 중인 DB에도 반영되도록 별도 1회성 마이그레이션으로 추가한다.
if (!db.prepare("SELECT value FROM kv_store WHERE key='alert_rule_history_promise_v1'").get()) {
  db.prepare(`
    INSERT INTO alert_rules (id, name, enabled, trigger_type, condition_text, target, channel, assignee, assignee_slack_id)
    VALUES ('rule6', '히스토리 약속일 리마인드', 1, 'history_promise', '히스토리에 언급된 날짜가 오늘 ±1일(어제/오늘/내일) 이내', 'dm', '', '준원', 'U05AGKJNVEY')
  `).run();
  db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('alert_rule_history_promise_v1', '1')").run();
}
// 위 규칙을 처음엔 ±7일로 만들었더니 하루 100건 넘게 쏟아져 실용성이 없다는 피드백으로
// ±1일로 좁혔다 — 이미 시드된 운영 DB의 조건 설명 문구도 맞춰 갱신한다(동작 자체는
// runAlertRules의 windowDays 파라미터가 결정하므로 이 텍스트는 표시용일 뿐이지만, 실제
// 동작과 다른 설명이 남아있으면 혼란을 준다).
if (!db.prepare("SELECT value FROM kv_store WHERE key='alert_rule_history_promise_v2_1day'").get()) {
  db.prepare("UPDATE alert_rules SET condition_text = '히스토리에 언급된 날짜가 오늘 ±1일(어제/오늘/내일) 이내' WHERE id='rule6'").run();
  db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('alert_rule_history_promise_v2_1day', '1')").run();
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

// 채무자 수정 로그 테이블
db.exec(`
  CREATE TABLE IF NOT EXISTS debtor_edit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    debtor_id   TEXT NOT NULL,
    debtor_name TEXT,
    changed_by  TEXT NOT NULL DEFAULT '관리자',
    changed_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    field_name  TEXT NOT NULL,
    field_label TEXT,
    old_value   TEXT,
    new_value   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_edit_log_debtor  ON debtor_edit_log(debtor_id);
  CREATE INDEX IF NOT EXISTS idx_edit_log_changed ON debtor_edit_log(changed_at);
`);

// To Do List 활동 로그 (등록/완료/삭제 — 어드민 통계 "업무 처리 현황"용)
db.exec(`
  CREATE TABLE IF NOT EXISTS todo_activity_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    action     TEXT NOT NULL,
    todo_id    TEXT,
    assignee   TEXT,
    task       TEXT,
    user_name  TEXT NOT NULL,
    ts         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_todo_log_ts          ON todo_activity_log(ts);
  CREATE INDEX IF NOT EXISTS idx_todo_log_user_action ON todo_activity_log(user_name, action);
`);
// todo_activity_log는 위 기능이 배포된 2026-08-04 이후의 등록/완료만 남아있어, 그 이전에
// 등록/완료됐거나 등록일·완료 처리일을 나중에 직접 입력한 항목은 통계에서 빠진다. todo_id+action
// 기준으로 이미 로그가 있으면 건너뛰므로 매번(서버 재시작마다) 실행해도 안전 — manual_todo_list의
// createdAt/completedAt을 근거로 빠진 로그를 소급 채운다. 실제로 누가 등록/완료했는지는 남아있지
// 않아 assignee(담당자)로 대신 귀속한다. 삭제는 deletedAt이 없어 소급 복원이 불가능.
try {
  const todoRow = db.prepare("SELECT value FROM kv_store WHERE key='manual_todo_list'").get();
  const todoArr = todoRow ? JSON.parse(todoRow.value) : [];
  const hasTodoLog = db.prepare("SELECT 1 FROM todo_activity_log WHERE todo_id = ? AND action = ? LIMIT 1");
  const insertTodoBackfill = db.prepare(`INSERT INTO todo_activity_log (action, todo_id, assignee, task, user_name, ts) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const item of Array.isArray(todoArr) ? todoArr : []) {
    if (!item || item.id == null) continue;
    if (item.createdAt && !hasTodoLog.get(item.id, "등록")) {
      insertTodoBackfill.run("등록", item.id, item.assignee || "", item.task || "", item.assignee || "알수없음", `${item.createdAt} 00:00:00`);
    }
    if (item.status === "완료" && item.completedAt && !hasTodoLog.get(item.id, "완료")) {
      insertTodoBackfill.run("완료", item.id, item.assignee || "", item.task || "", item.assignee || "알수없음", `${item.completedAt} 00:00:00`);
    }
  }
} catch {}

// 담당자 변경 이력 (변경일 기준 실적 귀속용)
db.exec(`
  CREATE TABLE IF NOT EXISTS assignee_history (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    debtor_id      TEXT NOT NULL,
    assignee       TEXT NOT NULL,
    effective_date TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE(debtor_id, effective_date)
  );
  CREATE INDEX IF NOT EXISTS idx_assignee_history_debtor ON assignee_history(debtor_id, effective_date);
`);
// 기존 채무자는 이력이 없으므로, 등록일부터 현재 담당자였던 것으로 1회 백필
if (!db.prepare("SELECT value FROM kv_store WHERE key='assignee_history_backfilled'").get()) {
  db.prepare(`
    INSERT OR IGNORE INTO assignee_history (debtor_id, assignee, effective_date)
    SELECT id, assignee, date(created_at) FROM debtors WHERE assignee IS NOT NULL AND assignee != ''
  `).run();
  db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('assignee_history_backfilled', '1')").run();
}

// 어드민 통계용 사용자 활동 로그 (접속 하트비트 / API 쓰기 요청 데이터량)
db.exec(`
  CREATE TABLE IF NOT EXISTS user_activity_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    type      TEXT NOT NULL,
    user_name TEXT NOT NULL,
    bytes     INTEGER NOT NULL DEFAULT 0,
    path      TEXT,
    ts        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_ual_ts        ON user_activity_log(ts);
  CREATE INDEX IF NOT EXISTS idx_ual_user_type ON user_activity_log(user_name, type);
`);
// 통계 상세보기에서 "무엇을 입력했는지" 내용을 보여주고, 경로에 id가 없는 요청(예: 일정
// 일괄생성)도 실제 대상 채무자로 이동할 수 있도록 요청 시점에 미리 계산해 둔다.
try { db.exec("ALTER TABLE user_activity_log ADD COLUMN ref_debtor_id TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE user_activity_log ADD COLUMN detail TEXT"); } catch(e) {}
// kv 배열(히스토리·To Do List 등) 항목 하나를 저장할 때 그 항목의 id를 같이 남겨둔다 —
// 이 항목이 나중에 완전히 삭제되면 그 id로 예전 로그를 찾아 무효화(voidKvItemLogs)할 수 있게.
try { db.exec("ALTER TABLE user_activity_log ADD COLUMN item_id TEXT"); } catch(e) {}

// kvPut(/api/kv/:key)이 사용자 이름을 안 보내던 시절에 쌓인 "알수없음" 통계 노이즈를
// 한 번만 정리 (실제 사용자명이 붙은 기록은 그대로 둔다). 서버 재시작 시 1회만 실행.
{
  const cleanupDone = db.prepare("SELECT value FROM kv_store WHERE key='stats_unknown_cleanup_v1'").get();
  if (!cleanupDone) {
    const removed = db.prepare("DELETE FROM user_activity_log WHERE user_name = '알수없음'").run();
    console.log(`[stats_unknown_cleanup_v1] "알수없음" 통계 노이즈 ${removed.changes}건 정리 완료`);
    db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('stats_unknown_cleanup_v1', '1')").run();
  }
  // v1 이후에도 kvPut 외의 다른 fetch 호출들이 사용자명 없이 나가 "알수없음"이 계속 새어
  // 나갔다 (window.fetch 전역 래핑으로 수정됨) — 그 잔여분을 한 번 더 정리.
  const cleanupDoneV2 = db.prepare("SELECT value FROM kv_store WHERE key='stats_unknown_cleanup_v2'").get();
  if (!cleanupDoneV2) {
    const removed = db.prepare("DELETE FROM user_activity_log WHERE user_name = '알수없음'").run();
    console.log(`[stats_unknown_cleanup_v2] "알수없음" 통계 노이즈 ${removed.changes}건 정리 완료`);
    db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('stats_unknown_cleanup_v2', '1')").run();
  }
  // v2 이후에도 로그인 전 app_users 동기화가 계속 "알수없음"으로 잡혔다
  // (/api/kv/app_users를 통계 집계 대상에서 제외함) — 잔여분 정리.
  const cleanupDoneV3 = db.prepare("SELECT value FROM kv_store WHERE key='stats_unknown_cleanup_v3'").get();
  if (!cleanupDoneV3) {
    const removed = db.prepare("DELETE FROM user_activity_log WHERE user_name = '알수없음'").run();
    console.log(`[stats_unknown_cleanup_v3] "알수없음" 통계 노이즈 ${removed.changes}건 정리 완료`);
    db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('stats_unknown_cleanup_v3', '1')").run();
  }
  // /api/kv/:key 저장은 지금까지 "요청 본문 전체 크기"를 입력량으로 기록해서, 목록 하나에서
  // 한 글자만 고쳐도 목록 전체 크기(수만 자)가 그 사람 몫으로 잡혔다. 이제부터는 실제
  // 변경분만 기록하도록 고쳤으니, 그 전에 부풀려진 기록은 한 번만 지운다.
  const kvBytesFixDone = db.prepare("SELECT value FROM kv_store WHERE key='stats_kv_bytes_fix_v1'").get();
  if (!kvBytesFixDone) {
    const removed = db.prepare("DELETE FROM user_activity_log WHERE type='data_input' AND path LIKE '/api/kv/%'").run();
    console.log(`[stats_kv_bytes_fix_v1] 부풀려진 kv 입력량 기록 ${removed.changes}건 정리 완료`);
    db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('stats_kv_bytes_fix_v1', '1')").run();
  }
  // v3 이후에도 두 종류의 통계 노이즈가 남아있었다:
  // 1) "알수없음" 원인을 조사하며 /api/kv/__diag_test_key 로 직접 보낸 디버깅용 테스트 요청이
  //    "진단테스트"라는 가짜 사용자로 실제 통계에 찍혀버렸다.
  // 2) 그 조사 과정에서 실제 채무자 수정 1건이 사용자 식별 실패로 "알수없음"에 잡혔다.
  // 실제 직원이 아니거나 귀속이 깨진 기록이라 성과 통계에서 신뢰할 수 없으므로 정리한다.
  const cleanupDoneV4 = db.prepare("SELECT value FROM kv_store WHERE key='stats_unknown_cleanup_v4'").get();
  if (!cleanupDoneV4) {
    const removedUnknown = db.prepare("DELETE FROM user_activity_log WHERE user_name = '알수없음'").run();
    const removedDiag = db.prepare("DELETE FROM user_activity_log WHERE user_name = '진단테스트'").run();
    const testKeys = db.prepare("SELECT key FROM kv_store WHERE key LIKE '@_@_%' ESCAPE '@'").all().map(r => r.key);
    const delKv = db.prepare("DELETE FROM kv_store WHERE key = ?");
    for (const k of testKeys) delKv.run(k);
    console.log(`[stats_unknown_cleanup_v4] "알수없음" ${removedUnknown.changes}건, "진단테스트" ${removedDiag.changes}건, 테스트용 kv 키 ${testKeys.length}개 정리 완료`);
    db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('stats_unknown_cleanup_v4', '1')").run();
  }
  // "관련 데이터"(이메일/슬랙/노션 이력) 배치 백필은 실제 수기 입력이 아니라 자동 수집이므로
  // 성과 통계에 포함하면 안 된다. 이미 찍힌 기록(2026-07-31, 배치 백필로 김준원 몫에 8.6M자
  // 잡힌 것 포함)을 한 번만 정리하고, 앞으로도 안 잡히도록 미들웨어에서 이 경로를 제외한다.
  const relatedDataExcludeDone = db.prepare("SELECT value FROM kv_store WHERE key='stats_related_data_exclude_v1'").get();
  if (!relatedDataExcludeDone) {
    const removed = db.prepare("DELETE FROM user_activity_log WHERE type='data_input' AND path LIKE '/api/related-data/%'").run();
    console.log(`[stats_related_data_exclude_v1] 관련 데이터 배치 백필 입력량 기록 ${removed.changes}건 정리 완료`);
    db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('stats_related_data_exclude_v1', '1')").run();
  }
  // AI 종합분석 재생성/초본·CB·좌표 재조회처럼 본문 없이 호출하는 트리거성 요청이 "{}"의
  // 글자수(2자)를 그대로 입력량으로 남겨서, "기타 저장" 목록에 근거 없는 행(사람이 입력한 게
  // 아무것도 없는데 2자로 잡힌 행)이 쌓여있었다. 미들웨어에서 이제 이런 요청은 기록하지
  // 않으므로, 이미 쌓인 잔여 기록도 한 번만 정리한다 — 경로를 구체적으로 지정해서, 본문 없이
  // 호출되는 게 정상인 DELETE 계열(삭제 자체는 실제 행동이라 계속 집계돼야 함)은 건드리지 않는다.
  const emptyTriggerCleanupDone = db.prepare("SELECT value FROM kv_store WHERE key='stats_empty_trigger_cleanup_v1'").get();
  if (!emptyTriggerCleanupDone) {
    const removed = db.prepare(`
      DELETE FROM user_activity_log WHERE type='data_input' AND detail IS NULL AND bytes <= 2 AND (
        path LIKE '/api/debtor/%/analysis' OR
        path LIKE '/api/debtor/%/resident-number/refresh' OR
        path LIKE '/api/debtor/%/credit-address/refresh' OR
        path LIKE '/api/debtor/%/geocode' OR
        path LIKE '/api/debtor/%/extract-address'
      )
    `).run();
    console.log(`[stats_empty_trigger_cleanup_v1] 빈 본문 트리거 호출 입력량 기록 ${removed.changes}건 정리 완료`);
    db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('stats_empty_trigger_cleanup_v1', '1')").run();
  }
  // 헤더를 encodeURIComponent 없이 보낸 요청 등으로 사용자명이 깨진 채(예: "�" 포함) 기록된
  // user_activity_log 행이 통계 화면에 이상한 사용자 컬럼으로 노출된 적이 있어 한 번만 정리.
  // 앞으로는 extractUserName/PATCH 핸들러에서 걸러지고, 혹시 남아도 /api/admin/stats 조회 시
  // 한 번 더 제외되므로 재발하지 않는다.
  const garbledCleanupDone = db.prepare("SELECT value FROM kv_store WHERE key='stats_garbled_username_cleanup_v1'").get();
  if (!garbledCleanupDone) {
    const removed = db.prepare("DELETE FROM user_activity_log WHERE user_name LIKE ?").run("%�%");
    console.log(`[stats_garbled_username_cleanup_v1] 깨진 사용자명 통계 기록 ${removed.changes}건 정리 완료`);
    db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('stats_garbled_username_cleanup_v1', '1')").run();
  }
  // 채무자 PATCH 통계를 필드 단위(debtor_edit_log 행 수) 대신 저장 액션 단위로 통일하면서,
  // 이미 쌓여있던 과거 기록은 새 집계 방식에서 안 보이게 된다 — PATCH 1건을 (사용자, 채무자,
  // 저장 시각) 묶음으로 근사 복원해서 user_activity_log에 한 번만 채워 넣는다 (1회만 실행).
  const patchUnifyDone = db.prepare("SELECT value FROM kv_store WHERE key='stats_debtor_patch_unify_v1'").get();
  if (!patchUnifyDone) {
    const grouped = db.prepare(`
      SELECT changed_by AS user, changed_at AS ts, SUM(LENGTH(COALESCE(new_value,''))) AS bytes
      FROM debtor_edit_log WHERE changed_by != '알수없음'
      GROUP BY changed_by, debtor_id, changed_at
    `).all();
    const insBackfill = db.prepare("INSERT INTO user_activity_log (type, user_name, bytes, path, ts) VALUES ('data_input', ?, ?, '/api/debtors/:id', ?)");
    let backfilled = 0;
    const backfillTx = db.transaction(() => {
      for (const r of grouped) {
        if (r.bytes > 0) { insBackfill.run(r.user, r.bytes, r.ts); backfilled++; }
      }
    });
    backfillTx();
    console.log(`[stats_debtor_patch_unify_v1] 채무자 PATCH 이력 ${backfilled}건을 통계용 액션 단위로 백필 완료`);
    db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('stats_debtor_patch_unify_v1', '1')").run();
  }
}

// 월별 회수 채널 수기 입력 테이블 (캐쉬충전, 웰컴직접상환 수동 기록 + 과거 데이터)
db.exec(`
  CREATE TABLE IF NOT EXISTS collection_channels (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    year       INTEGER NOT NULL,
    month      INTEGER NOT NULL,
    brand      TEXT NOT NULL DEFAULT 'all',
    channel    TEXT NOT NULL,
    amount     INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    updated_by TEXT DEFAULT '관리자',
    UNIQUE(year, month, brand, channel)
  );
  CREATE INDEX IF NOT EXISTS idx_cc_year_month ON collection_channels(year, month);
`);

// 2025/2026 seed data (Excel 종합분석 그래프 기준)
{
  const seedDone = db.prepare("SELECT value FROM kv_store WHERE key='cc_seed_v1'").get();
  if (!seedDone) {
    const ins = db.prepare(
      "INSERT OR IGNORE INTO collection_channels (year, month, brand, channel, amount) VALUES (?,?,?,?,?)"
    );
    const tx = db.transaction(() => {
      // 2025년 월별 합계 (채널 구분 없음)
      const t2025 = [118575458,82598742,296271620,93414986,110080471,76516588,106091287,148150125,132633627,187497062,79411669,132409300];
      t2025.forEach((v, i) => ins.run(2025, i+1, 'all', 'total', v));

      // 2026년 브랜드×채널별 (Excel 기준)
      const data2026 = [
        // [brand, channel, month, amount]
        ['B','캐쉬충전',1,9364974], ['B','캐쉬충전',2,15740976], ['B','캐쉬충전',3,4181614], ['B','캐쉬충전',4,1953294], ['B','캐쉬충전',5,4753030],
        ['B','웰컴직접상환',1,1515975], ['B','웰컴직접상환',2,1264956], ['B','웰컴직접상환',3,1515975], ['B','웰컴직접상환',4,2970798],
        ['D','캐쉬충전',1,10248425], ['D','캐쉬충전',2,8372132], ['D','캐쉬충전',3,10645770], ['D','캐쉬충전',4,9062346], ['D','캐쉬충전',5,9414326],
        ['M','캐쉬충전',1,5740674], ['M','캐쉬충전',2,4227680], ['M','캐쉬충전',3,6115974], ['M','캐쉬충전',4,7804020], ['M','캐쉬충전',5,4826274],
      ];
      data2026.forEach(([brand, channel, month, amount]) => ins.run(2026, month, brand, channel, amount));
    });
    tx();
    db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('cc_seed_v1', '1')").run();
  }
}

// 2025 브랜드별 캐쉬/웰컴 + 2024 브랜드별 합계 시드
{
  const seedDone = db.prepare("SELECT value FROM kv_store WHERE key='cc_seed_v2'").get();
  if (!seedDone) {
    const ins = db.prepare(
      "INSERT OR REPLACE INTO collection_channels (year, month, brand, channel, amount) VALUES (?,?,?,?,?)"
    );
    const tx = db.transaction(() => {
      // 2025 바로고 캐쉬충전
      [[3,12822017],[4,140000],[5,3062812],[6,2393427],[7,7483609],[8,83313783],[9,24627840],[10,28708024],[11,600000],[12,1797000]]
        .forEach(([m,v]) => ins.run(2025,m,'B','캐쉬충전',v));
      // 2025 바로고 웰컴직접상환
      [[2,600000],[3,1350765],[4,5895386],[6,700000],[7,6697338]]
        .forEach(([m,v]) => ins.run(2025,m,'B','웰컴직접상환',v));
      // 2025 딜버 캐쉬충전
      [[4,2543965],[5,4375166],[6,3481668],[7,4212555],[8,5507658],[9,12311900],[10,11448448],[11,10024303],[12,9300000]]
        .forEach(([m,v]) => ins.run(2025,m,'D','캐쉬충전',v));
      // 2025 딜버 웰컴직접상환
      [[2,429670],[3,218000],[4,209810],[5,225000],[6,225000],[7,225000],[8,225000],[9,225000],[10,225000],[11,217500]]
        .forEach(([m,v]) => ins.run(2025,m,'D','웰컴직접상환',v));
      // 2025 모아라인 캐쉬충전
      [[1,18099302],[2,20154471],[3,20410119],[4,22198199],[5,14671841],[6,12919188],[7,7149954],[8,7074092],[9,13628289],[10,5522612],[11,8934960]]
        .forEach(([m,v]) => ins.run(2025,m,'M','캐쉬충전',v));
      // 2025 모아라인 웰컴직접상환
      [[1,15601506],[2,13614880],[3,8990210],[4,5229652],[5,7249778],[6,4715004],[7,2992800],[8,1870500],[9,1870200],[10,1496400],[11,2249400],[12,2100000]]
        .forEach(([m,v]) => ins.run(2025,m,'M','웰컴직접상환',v));
      // 2024 브랜드별 합계 (채널 구분 없음)
      [[1,43730660],[2,24714216],[3,52582160],[4,29504301],[5,50462509],[6,19711655],[7,46985407],[8,49051102],[9,38579356],[10,38879938],[11,194630224],[12,59989337]]
        .forEach(([m,v]) => ins.run(2024,m,'B','total',v));
      [[2,40200000],[3,3813810],[4,4424566],[5,3483151],[6,7366293],[7,145242160],[8,56814261],[9,31720691],[10,3283255],[11,1298785],[12,818210]]
        .forEach(([m,v]) => ins.run(2024,m,'D','total',v));
      [[1,45265256],[2,86025959],[3,26291236],[4,34612333],[5,29028430],[6,26619486],[7,53404117],[8,50233804],[9,14187668],[10,16523176],[11,10760000],[12,34202027]]
        .forEach(([m,v]) => ins.run(2024,m,'M','total',v));
      [[1,88995916],[2,150940175],[3,82687206],[4,68541200],[5,82974090],[6,53697434],[7,245631684],[8,156099167],[9,84487715],[10,58686369],[11,206689009],[12,95009574]]
        .forEach(([m,v]) => ins.run(2024,m,'all','total',v));
    });
    tx();
    db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('cc_seed_v2', '1')").run();
  }
}
{
  // cc_seed_v3: 2025 브랜드별 월합계 (본사+캐쉬+웰컴 합산)
  const seedDone = db.prepare("SELECT value FROM kv_store WHERE key='cc_seed_v3'").get();
  if (!seedDone) {
    const ins = db.prepare("INSERT OR REPLACE INTO collection_channels (year, month, brand, channel, amount) VALUES (?,?,?,?,?)");
    const tx = db.transaction(() => {
      [[1,79137995],[2,42038105],[3,131095461],[4,54753360],[5,51059371],[6,38182738],[7,72925930],[8,120614817],[9,86976741],[10,157604602],[11,26385709],[12,32355355]]
        .forEach(([m,v]) => ins.run(2025,m,'B','total',v));
      [[1,544517],[2,929670],[3,1718000],[4,6173775],[5,11097666],[6,8101758],[7,6137555],[8,10396671],[9,17024368],[10,17473448],[11,15291803],[12,16070000]]
        .forEach(([m,v]) => ins.run(2025,m,'D','total',v));
      [[1,38892946],[2,39630967],[3,163458159],[4,32487851],[5,47923434],[6,30232092],[7,27027802],[8,17138637],[9,28632518],[10,12419012],[11,37734157],[12,83983945]]
        .forEach(([m,v]) => ins.run(2025,m,'M','total',v));
    });
    tx();
    db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('cc_seed_v3', '1')").run();
  }
}
{
  // fix_sched_amounts: "7.1 50만원" → 공백 제거 오파싱(71500) 일괄 수정
  const fixDone = db.prepare("SELECT value FROM kv_store WHERE key='fix_sched_amounts_v1'").get();
  if (!fixDone) {
    function parseAmtFromMemo(text) {
      if (!text) return null;
      const t = text.replace(/,/g, "");
      const manMatches = [...t.matchAll(/(\d+(?:\.\d+)?)\s*만\s*원?/g)];
      if (manMatches.length) return Math.round(parseFloat(manMatches[manMatches.length - 1][1]) * 10000);
      const wonMatches = [...t.matchAll(/(\d+)\s*원/g)];
      if (wonMatches.length) return parseInt(wonMatches[wonMatches.length - 1][1], 10) || null;
      return null;
    }
    const schedules = db.prepare("SELECT id, scheduled_amount, memo FROM installment_schedules WHERE memo IS NOT NULL AND memo != ''").all();
    let fixed = 0;
    const upd = db.prepare("UPDATE installment_schedules SET scheduled_amount = ? WHERE id = ?");
    db.transaction(() => {
      for (const s of schedules) {
        const correct = parseAmtFromMemo(s.memo);
        if (correct && correct > 0 && correct !== s.scheduled_amount) {
          upd.run(correct, s.id);
          fixed++;
        }
      }
    })();
    console.log(`[fix_sched_amounts] 잘못된 금액 ${fixed}건 수정 완료`);
    db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('fix_sched_amounts_v1', '1')").run();
  }
}

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

// 채무자-관련데이터(이메일/슬랙/노션 이력) 테이블
db.exec(`
  CREATE TABLE IF NOT EXISTS debtor_related_data (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    debtor_id    TEXT NOT NULL REFERENCES debtors(id) ON DELETE CASCADE,
    source       TEXT NOT NULL,
    title        TEXT NOT NULL,
    summary      TEXT,
    url          TEXT NOT NULL,
    occurred_at  TEXT,
    shared       INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    created_by   TEXT,
    UNIQUE(debtor_id, source, url)
  );
  CREATE INDEX IF NOT EXISTS idx_debtor_related_data ON debtor_related_data(debtor_id);
`);

// AI 종합분석(채무자 분석/문건 분석) 질문·답변 히스토리 — 언제 누가 무엇을 물어봤는지 조회/검색용
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_analysis_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT NOT NULL,
    target_name  TEXT,
    debtor_id    TEXT,
    question     TEXT NOT NULL,
    answer       TEXT,
    created_by   TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_ai_analysis_log_kind ON ai_analysis_log(kind);
`);

// 주간/월간/반기/연간 보고서 (AI 종합분석 > 보고서 탭)
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_reports (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    period_type   TEXT NOT NULL,
    period_start  TEXT NOT NULL,
    period_end    TEXT NOT NULL,
    title         TEXT NOT NULL,
    content       TEXT NOT NULL,
    created_by    TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_ai_reports_period ON ai_reports(period_type);
`);

const app = express();
app.use(cors());
// strict:false — 공유 KV 스토어(/api/kv/:key)는 문자열/null 같은 원시값도 그대로 저장해야 하는데
// express.json() 기본값(strict:true)은 최상위가 객체/배열이 아닌 JSON 바디를 거부해서
// 원시값 PUT이 전부 400으로 조용히 실패하고 있었다 (예: 이벤트 날짜 "YYYY-MM-DD" 저장)
// limit:'20mb' — 공유 KV 값(예: legal_thirds_overrides처럼 모든 사건의 데이터를 한 JSON에
// 합쳐 저장하는 키)이 누적되며 기본값 100kb를 넘어서면 413으로 조용히 저장이 막힌다.
// kvPut()은 실패해도 console.warn만 하고 화면엔 표시하지 않아 사용자가 알 방법이 없었다.
app.use(express.json({ strict: false, limit: "20mb" }));

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

// 어드민 통계용: 모든 API 쓰기 요청의 본문 크기를 사용자별로 집계
// ref_debtor_id/detail: 분할상환처럼 경로에 개별 id가 없는 요청(일괄 등록 등)도 실제
// 대상 채무자로 이동하고 입력 내용을 볼 수 있도록, 해당 모듈에 한해 요청 시점에 채워둔다.
const insertActivityLog = db.prepare(
  "INSERT INTO user_activity_log (type, user_name, bytes, path, ref_debtor_id, detail) VALUES (?, ?, ?, ?, ?, ?)"
);
const USER_FIELD_CANDIDATES = ["_userName", "userName", "createdByName", "createdBy", "changedBy", "changed_by", "author", "actorName"];
// 헤더/바디 인코딩이 깨진 요청(예: 헤더를 encodeURIComponent 없이 보내 UTF-8 바이트가
// 손상된 경우)은 복원 불가능한 깨진 글자(U+FFFD)로 남는다 — 통계 화면에 이상한 사용자
// 컬럼(예: "�?�Ĵ�")으로 노출되므로 "알수없음"과 동일하게 취급해 걸러낸다.
const hasReplacementChar = (s) => typeof s === "string" && s.includes("�");
function extractUserName(req) {
  const headerName = req.headers["x-user-name"];
  if (typeof headerName === "string" && headerName.trim()) {
    try {
      const decoded = decodeURIComponent(headerName).trim();
      if (decoded && !hasReplacementChar(decoded)) return decoded;
    } catch {}
  }
  const body = req.body;
  if (!body || typeof body !== "object") return "알수없음";
  for (const f of USER_FIELD_CANDIDATES) {
    if (typeof body[f] === "string" && body[f].trim() && !hasReplacementChar(body[f])) return body[f].trim();
  }
  return "알수없음";
}

// AI 종합분석 질문/답변 1건을 ai_analysis_log에 기록하고 방금 넣은 행을 그대로 돌려준다
// (프론트가 히스토리 목록에 새로고침 없이 바로 추가할 수 있도록).
function logAiAnalysis(req, kind, targetName, debtorId, question, answer) {
  const createdBy = extractUserName(req);
  const info = db.prepare(
    "INSERT INTO ai_analysis_log (kind, target_name, debtor_id, question, answer, created_by) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(kind, targetName || null, debtorId || null, question, answer || null, createdBy === "알수없음" ? null : createdBy);
  return db.prepare("SELECT * FROM ai_analysis_log WHERE id = ?").get(info.lastInsertRowid);
}
// 로그인 전에도 반복적으로 저장되는 시스템 설정성 키 — 특정 사용자의 "데이터 입력"으로
// 볼 수 없어 통계 집계 대상에서 제외한다 (그래도 실제 저장은 정상 동작함).
// /api/kv/:key 저장은 이 배열/객체 전체를 매번 다시 쓰는 방식이라(예: 목록 하나에서
// 한 항목만 고쳐도 전체 목록을 다시 저장) 요청 본문 전체 크기를 세면 실제로 입력한 양보다
// 훨씬 크게 잡힌다 — 아래 kv 핸들러에서 실제 변경분만 따로 정확히 계산해서 기록하므로
// 여기서는 중복 집계하지 않도록 제외한다.
const STATS_EXCLUDED_PATHS = ["/api/admin/heartbeat"];
// PATCH /api/debtors/:id는 debtor_edit_log에 필드별 실제 변경분을 이미 정확히 기록하므로,
// 여기서 요청 본문 전체 크기까지 또 세면 같은 저장 1번이 두 번 잡혀 입력량/수정 건수가 부풀려진다.
const isDebtorPatch = (req) => req.method === "PATCH" && /^\/api\/debtors\/[^/]+$/.test(req.path);
// "관련 데이터"(이메일/슬랙/노션 이력) 저장은 배치 백필 등 자동 수집으로 들어오는 경우가 있어
// 실제 수기 입력이 아니다 — 누가 검색해서 채워넣었든 성과 통계에 포함하지 않는다.
const isRelatedDataWrite = (req) => req.path.startsWith("/api/related-data/");

// 분할상환(/api/installments/*) 쓰기 요청에서 대상 채무자 id와 "무엇을 입력했는지"를
// 미리 계산해 둔다. DELETE는 핸들러가 실행되고 나면 대상 행이 이미 지워져 조회가 안 되므로
// (아래 미들웨어에서 next() 호출 전, 즉 실제 처리 전에) 여기서 먼저 조회해 둬야 한다.
function resolveInstallmentActivity(req) {
  const body = req.body || {};
  const p = req.path;
  const won = (n) => `${(parseInt(n, 10) || 0).toLocaleString()}원`;
  const planDebtor = (planId) => { const r = db.prepare("SELECT debtor_id FROM installment_plans WHERE id = ?").get(planId); return r ? r.debtor_id : null; };
  const schedDebtor = (schedId) => { const r = db.prepare("SELECT p.debtor_id AS debtor_id FROM installment_schedules s JOIN installment_plans p ON s.plan_id = p.id WHERE s.id = ?").get(schedId); return r ? r.debtor_id : null; };
  let m;
  try {
    if (p === "/api/installments" && req.method === "POST") {
      return { debtorId: body.debtorId || null, detail: `플랜 생성 (${body.paymentTiming || "월말"}, 월 ${won(body.monthlyAmount)}${body.memo ? " · " + body.memo : ""})` };
    }
    if (p === "/api/installments/schedules/batch") {
      const scheds = Array.isArray(body.schedules) ? body.schedules : [];
      const dates = scheds.map(s => s.dueDate || s.dueMonth).filter(Boolean).sort();
      const total = scheds.reduce((s, x) => s + (parseInt(x.scheduledAmount, 10) || 0), 0);
      // 요약(건수·기간·합계)만으로는 "실제로 뭘 넣었는지"가 안 보여서, 실제 만들어진 각 건의
      // 날짜/금액을 그대로 나열해준다 — 너무 많으면(대량 일괄등록) 앞 20건만 보여주고 나머지는 개수만.
      const CAP = 20;
      const lines = scheds.slice(0, CAP).map(s => `${s.dueDate || s.dueMonth || "?"} ${won(s.scheduledAmount)}${s.memo ? "(" + s.memo + ")" : ""}`);
      const more = scheds.length > CAP ? ` 외 ${scheds.length - CAP}건` : "";
      return {
        debtorId: body.planId ? planDebtor(body.planId) : null,
        detail: `일정 ${scheds.length}건 일괄 추가${dates.length ? ` (${dates[0]}~${dates[dates.length - 1]})` : ""}, 합계 ${won(total)} — ${lines.join(", ")}${more}`,
      };
    }
    if ((m = p.match(/^\/api\/installments\/schedules\/([^/]+)\/rollover$/))) {
      const splitDates = (Array.isArray(body.splits) ? body.splits : []).filter(s => s && s.date).map(s => s.date);
      const dest = splitDates.length ? splitDates.join(", ") : (body.newDate || "?");
      return { debtorId: schedDebtor(m[1]), detail: `이월 → ${dest}${body.memo ? " · " + body.memo : ""}` };
    }
    if ((m = p.match(/^\/api\/installments\/schedules\/([^/]+)\/memo$/))) {
      return { debtorId: schedDebtor(m[1]), detail: `메모: ${body.memo || ""}` };
    }
    if ((m = p.match(/^\/api\/installments\/schedules\/([^/]+)$/))) {
      const parts = [];
      if (body.status !== undefined) parts.push(`상태→${body.status}`);
      if (body.dueDate !== undefined) parts.push(`납부일→${body.dueDate}`);
      if (body.dueMonth !== undefined) parts.push(`납부월→${body.dueMonth}`);
      if (body.scheduledAmount !== undefined) parts.push(`예정금액→${won(body.scheduledAmount)}`);
      if (body.paidAmount !== undefined) parts.push(`납부금액→${won(body.paidAmount)}`);
      if (body.memo !== undefined) parts.push(`메모→${body.memo}`);
      return { debtorId: schedDebtor(m[1]), detail: parts.join(", ") || (req.method === "DELETE" ? "일정 삭제" : null) };
    }
    if ((m = p.match(/^\/api\/installments\/([^/]+)\/schedules$/))) {
      return { debtorId: planDebtor(m[1]), detail: `일정 추가: ${body.dueDate || body.dueMonth || ""} ${won(body.scheduledAmount)}${body.memo ? " · " + body.memo : ""}` };
    }
    if ((m = p.match(/^\/api\/installments\/([^/]+)$/))) {
      const parts = [];
      if (body.paymentTiming !== undefined) parts.push(`납부주기→${body.paymentTiming}`);
      if (body.monthlyAmount !== undefined) parts.push(`월분납액→${won(body.monthlyAmount)}`);
      if (body.startDate !== undefined) parts.push(`시작일→${body.startDate}`);
      if (body.status !== undefined) parts.push(`상태→${body.status}`);
      if (body.memo !== undefined) parts.push(`메모→${body.memo}`);
      return { debtorId: planDebtor(m[1]), detail: parts.join(", ") || (req.method === "DELETE" ? "플랜 삭제" : null) };
    }
  } catch { /* 조회 실패해도 통계 자체는 계속 진행 — 이동/내용 표시만 못 하게 됨 */ }
  return { debtorId: null, detail: null };
}

// POST /api/debtors(신규 채무자 등록)는 detail 계산 로직이 없어서 요청 본문 전체 크기만
// "기타 저장" 목록에 남고 있었다 — 등록한 이름/브랜드가 보이도록 채워준다.
// id는 프론트에서 항상 uid("NPL")로 미리 만들어 body.id로 보내므로, 핸들러가 실행되기 전인
// 여기서도 그대로 같은 값을 참조할 수 있다(직접 새로 만들면 핸들러의 생성 시각과 어긋난다).
function resolveDebtorCreateActivity(req) {
  const b = req.body || {};
  let brandName = b.brand || "";
  try {
    const row = db.prepare("SELECT name FROM brands WHERE code = ?").get(b.brand);
    if (row?.name) brandName = row.name;
  } catch {}
  return { debtorId: b.id || null, detail: `신규 채무자 등록: ${b.name || "(이름 없음)"}${brandName ? ` (${brandName})` : ""}` };
}

// 형사고소(등록/수정/진행내역)는 손을 안 대서 요청 본문 크기만 잡히고 무슨 내용인지 전혀
// 안 보였다 — installments/debtors처럼 "무엇이 저장됐는지" 문구를 만들어준다.
function resolveComplaintActivity(req) {
  const b = req.body || {};
  const p = req.path;
  const won = (n) => `${(parseInt(n, 10) || 0).toLocaleString()}원`;
  const complaintDebtor = (id) => { try { const r = db.prepare("SELECT debtor_id FROM complaints WHERE id = ?").get(id); return r ? r.debtor_id : null; } catch { return null; } };
  const historyComplaint = (histId) => { try { return db.prepare("SELECT complaint_id FROM complaint_history WHERE id = ?").get(histId)?.complaint_id || null; } catch { return null; } };
  let m;
  try {
    if (p === "/api/complaints" && req.method === "POST") {
      return { debtorId: b.debtorId || null, detail: `형사고소 등록: 고소인 ${b.complainant || "-"}, 혐의 ${b.charge || "-"}${b.goodsAmount ? `, 물품대 ${won(b.goodsAmount)}` : ""}${b.loanAmount ? `, 대여금 ${won(b.loanAmount)}` : ""}` };
    }
    if ((m = p.match(/^\/api\/complaints\/([^/]+)$/)) && req.method === "PATCH") {
      const parts = [];
      if (b.status !== undefined) parts.push(`상태→${b.status}`);
      if (b.complainant !== undefined) parts.push(`고소인→${b.complainant}`);
      if (b.charge !== undefined) parts.push(`혐의→${b.charge}`);
      if (b.policeStation !== undefined) parts.push(`경찰서→${b.policeStation}`);
      if (b.complaintDate !== undefined) parts.push(`고소일→${b.complaintDate}`);
      if (b.investigator !== undefined) parts.push(`수사관→${b.investigator}`);
      if (b.investigatorContact !== undefined) parts.push(`수사관연락처→${b.investigatorContact}`);
      if (b.complaintUrl !== undefined) parts.push(`고소장 링크 갱신`);
      if (b.goodsAmount !== undefined) parts.push(`물품대→${won(b.goodsAmount)}`);
      if (b.loanAmount !== undefined) parts.push(`대여금→${won(b.loanAmount)}`);
      return { debtorId: b.debtorId || complaintDebtor(m[1]), detail: parts.join(", ") || null };
    }
    if ((m = p.match(/^\/api\/complaints\/([^/]+)\/history$/)) && req.method === "POST") {
      return { debtorId: complaintDebtor(m[1]), detail: `형사고소 진행내역 등록: ${b.date || ""} ${b.content || ""}${b.assignee ? ` (${b.assignee})` : ""}` };
    }
    if ((m = p.match(/^\/api\/complaint-history\/([^/]+)$/)) && req.method === "PATCH") {
      const parts = [];
      if (b.date !== undefined) parts.push(`날짜→${b.date}`);
      if (b.content !== undefined) parts.push(`내용→${b.content}`);
      if (b.assignee !== undefined) parts.push(`담당자→${b.assignee}`);
      return { debtorId: complaintDebtor(historyComplaint(m[1])), detail: parts.join(", ") || null };
    }
  } catch {}
  return { debtorId: null, detail: null };
}

// 입금 등록/재매칭, 담당자·추심상태 일괄수정, 알림규칙, 월별 회수채널, 미매칭 연결 —
// 각자 audit_logs/debtor_edit_log 등 자기 화면용 이력은 따로 남기지만, 어드민 "다른 활동"
// 통계(user_activity_log)에는 안 걸려 있어서 같은 자리에서 무슨 입력인지 안 보였다.
function resolveMiscActivity(req) {
  const b = req.body || {};
  const p = req.path;
  const won = (n) => `${(parseInt(n, 10) || 0).toLocaleString()}원`;
  let m;
  try {
    if (p === "/api/activities" && req.method === "POST") {
      return { debtorId: b.debtorId || null, detail: `활동 등록: ${b.activityType || "-"} - ${b.content || ""}${b.assignee ? ` (${b.assignee})` : ""}` };
    }
    if (p === "/api/payments" && req.method === "POST") {
      return { debtorId: b.debtorId || null, detail: `입금 등록: ${b.payerName || "-"} ${won(b.totalAmount)} (${b.paymentDate || "-"})` };
    }
    if ((m = p.match(/^\/api\/payments\/([^/]+)\/rematch$/)) && req.method === "PATCH") {
      const pay = db.prepare("SELECT debtor_id FROM payments WHERE id = ?").get(m[1]);
      return { debtorId: b.newDebtorId || pay?.debtor_id || null, detail: `입금 재매칭 (id=${m[1]}) → 새 채무자 연결` };
    }
    if (p === "/api/debtors/bulk" && req.method === "PATCH") {
      const ids = Array.isArray(b.ids) ? b.ids : [];
      const parts = [];
      if (b.assignee) parts.push(`담당자→${b.assignee}`);
      if (b.collectionStatus) parts.push(`추심상태→${b.collectionStatus}`);
      return { debtorId: null, detail: `일괄수정 ${ids.length}건: ${parts.join(", ")}` };
    }
    if (p === "/api/alert-rules" && req.method === "POST") {
      return { debtorId: null, detail: `알림규칙 등록: ${b.name || "-"} (${b.condition || "조건 미설정"})` };
    }
    if ((m = p.match(/^\/api\/alert-rules\/([^/]+)$/)) && req.method === "PATCH") {
      const parts = [];
      if (b.name !== undefined) parts.push(`이름→${b.name}`);
      if (b.enabled !== undefined) parts.push(`사용여부→${b.enabled ? "켬" : "끔"}`);
      if (b.condition !== undefined) parts.push(`조건→${b.condition}`);
      if (b.channel !== undefined) parts.push(`채널→${b.channel}`);
      if (b.assignee !== undefined) parts.push(`대상자→${b.assignee}`);
      return { debtorId: null, detail: parts.join(", ") || null };
    }
    if (p === "/api/collection-channels" && req.method === "PUT") {
      return { debtorId: null, detail: `월별 회수채널 수정: ${b.year || ""}년 ${b.month || ""}월 ${b.brand || ""} ${b.channel || ""} → ${won(b.amount)}` };
    }
    if ((m = p.match(/^\/api\/pending-payments\/([^/]+)\/resolve$/)) && req.method === "POST") {
      const debtor = b.debtorId ? db.prepare("SELECT name FROM debtors WHERE id = ?").get(b.debtorId) : null;
      return { debtorId: b.debtorId || null, detail: `미매칭 입금 연결 → ${debtor?.name || b.debtorId || "-"}${b.channel ? ` (${b.channel})` : ""}` };
    }
  } catch {}
  return { debtorId: null, detail: null };
}

// DELETE는 핸들러가 실행되면 대상 행이 사라져 조회가 안 되므로, next() 전에(=삭제되기 전에)
// "무엇을 지우는지" 미리 조회해 둔다. 본문이 없는 게 정상이라 위 두 리졸버로는 못 잡는다.
function resolveDeleteActivity(req) {
  const p = req.path;
  let m;
  try {
    if ((m = p.match(/^\/api\/complaints\/([^/]+)$/))) {
      const r = db.prepare("SELECT complainant, debtor_id FROM complaints WHERE id = ?").get(m[1]);
      return { debtorId: r?.debtor_id || null, detail: `형사고소 삭제: ${r?.complainant || m[1]}` };
    }
    if ((m = p.match(/^\/api\/complaint-history\/([^/]+)$/))) {
      const r = db.prepare("SELECT content, complaint_id FROM complaint_history WHERE id = ?").get(m[1]);
      const cd = r?.complaint_id ? db.prepare("SELECT debtor_id FROM complaints WHERE id = ?").get(r.complaint_id) : null;
      return { debtorId: cd?.debtor_id || null, detail: `형사고소 진행내역 삭제: ${(r?.content || "").slice(0, 60)}` };
    }
    if ((m = p.match(/^\/api\/activities\/([^/]+)$/))) {
      const r = db.prepare("SELECT content, debtor_id FROM activities WHERE id = ?").get(m[1]);
      return { debtorId: r?.debtor_id || null, detail: `활동사항 삭제: ${(r?.content || "").slice(0, 60)}` };
    }
    if ((m = p.match(/^\/api\/payer-mappings\/([^/]+)$/))) {
      return { debtorId: null, detail: `입금자명 매핑 삭제: ${decodeURIComponent(m[1])}` };
    }
    if ((m = p.match(/^\/api\/pending-payments\/(\d+)$/))) {
      const r = db.prepare("SELECT payer_name, total_amount FROM pending_payments WHERE id = ?").get(m[1]);
      return { debtorId: null, detail: r ? `미매칭 항목 삭제: ${r.payer_name || "-"} ${(r.total_amount || 0).toLocaleString()}원` : "미매칭 항목 삭제" };
    }
    if ((m = p.match(/^\/api\/documents\/link\/([^/]+)$/))) {
      const r = db.prepare("SELECT file_name, debtor_id FROM debtor_documents WHERE id = ?").get(m[1]);
      return { debtorId: r?.debtor_id || null, detail: r ? `서류 연결 해제: ${r.file_name}` : "서류 연결 해제" };
    }
    if ((m = p.match(/^\/api\/alert-rules\/([^/]+)$/))) {
      const r = db.prepare("SELECT name FROM alert_rules WHERE id = ?").get(m[1]);
      return { debtorId: null, detail: `알림규칙 삭제: ${r?.name || m[1]}` };
    }
    if ((m = p.match(/^\/api\/payments\/([^/]+)$/))) {
      const r = db.prepare("SELECT payer_name, total_amount, debtor_id FROM payments WHERE id = ?").get(m[1]);
      return { debtorId: r?.debtor_id || null, detail: r ? `입금 삭제: ${r.payer_name || "-"} ${(r.total_amount || 0).toLocaleString()}원` : "입금 삭제" };
    }
  } catch {}
  return { debtorId: null, detail: null };
}

// 위의 리졸버들이 다루지 않는 나머지 모든 저장 요청(현재/향후 추가되는 엔드포인트 포함)도
// 최소한 "무엇을 입력/수정했는지"가 보이도록 하는 범용 폴백 — 본문 필드를 "필드명→값"으로
// 나열한다. id·시스템 식별자·객체/배열 값은 제외(너무 길거나 의미가 없음), "…Amount"로
// 끝나는 필드는 금액으로 포맷한다.
const GENERIC_SKIP_FIELDS = new Set([
  "id", "_userName", "userName", "createdBy", "createdByName", "debtorId", "newDebtorId",
  "planId", "scheduleId", "complaintId", "source", "sourceRef", "linkedBy", "force", "ids",
]);
const GENERIC_FIELD_LABELS = {
  complainant: "고소인", charge: "혐의", policeStation: "경찰서", complaintDate: "고소일",
  status: "상태", content: "내용", activityType: "활동유형", activityDate: "활동일자",
  payerName: "입금자", paymentDate: "입금일", name: "이름", condition: "조건",
  channel: "채널", assignee: "담당자", memo: "메모", note: "비고", enabled: "사용여부",
  collectionStatus: "추심상태", trigger: "트리거", target: "발송대상", brand: "브랜드",
  year: "연도", month: "월", docLabel: "문서분류",
};
function genericBodyDetail(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const parts = [];
  for (const [k, v] of Object.entries(body)) {
    if (GENERIC_SKIP_FIELDS.has(k)) continue;
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "object") continue;
    const label = GENERIC_FIELD_LABELS[k] || k;
    let val;
    if (/Amount$/.test(k) && !isNaN(Number(v))) val = `${Number(v).toLocaleString()}원`;
    else if (k === "enabled") val = v ? "켬" : "끔";
    else { val = String(v); if (val.length > 80) val = val.slice(0, 80) + "…"; }
    parts.push(`${label}→${val}`);
  }
  return parts.length ? parts.join(", ") : null;
}

app.use((req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && req.path.startsWith("/api/") && !req.path.startsWith("/api/kv/") && !STATS_EXCLUDED_PATHS.includes(req.path) && !isDebtorPatch(req) && !isRelatedDataWrite(req)) {
    const userName = extractUserName(req);
    // 사용자를 식별할 수 없는 요청은 "알수없음"이라는 가짜 사용자로 통계에 남기지 않는다 —
    // 누구의 성과에도 귀속시킬 수 없는 기록이라 어차피 평가에 쓸 수 없고, 화면에 노이즈만 남긴다.
    if (userName === "알수없음") return next();
    // DELETE는 핸들러 실행 후엔 대상이 이미 삭제돼 조회가 안 되므로 next() 호출(=핸들러 실행) 전에 미리 계산.
    let refDebtorId = null, detail = null;
    if (req.path.startsWith("/api/installments")) {
      const r = resolveInstallmentActivity(req);
      refDebtorId = r.debtorId;
      detail = r.detail;
    } else if (req.path === "/api/debtors" && req.method === "POST") {
      const r = resolveDebtorCreateActivity(req);
      refDebtorId = r.debtorId;
      detail = r.detail;
    } else if (req.path.startsWith("/api/complaints") || req.path.startsWith("/api/complaint-history")) {
      const r = resolveComplaintActivity(req);
      refDebtorId = r.debtorId;
      detail = r.detail;
    }
    if (!detail && req.method !== "DELETE") {
      const r = resolveMiscActivity(req);
      if (r.detail) { refDebtorId = r.debtorId; detail = r.detail; }
    }
    if (!detail && req.method === "DELETE") {
      const r = resolveDeleteActivity(req);
      if (r.detail) { refDebtorId = r.debtorId; detail = r.detail; }
    }
    if (!detail) detail = genericBodyDetail(req.body);
    // 요청 본문 전체 크기(JSON.stringify(req.body).length)로 세면 id/구조적 JSON까지 다 잡혀서
    // "이 사람이 실제로 입력한 양"과 안 맞는다(예: 일정 12건 일괄등록 1번이 수천 자로 잡힘) —
    // 화면에 보여줄 내용(detail)이 있으면 그 글자수를 그대로 쓴다. 보이는 텍스트 = 세는 글자수
    // 라서 숫자를 신뢰할 수 있고, detail이 없는(아직 이 방식으로 안 옮긴) 경로만 예전 방식으로 폴백.
    let bytes = 0;
    if (detail) {
      bytes = detail.length;
    } else {
      try { bytes = JSON.stringify(req.body || {}).length; } catch {}
    }
    // 본문 없이 호출하는 트리거성 요청(AI 종합분석 재생성, 초본/CB/좌표 재조회 버튼 등)은
    // 사용자가 실제로 입력한 내용이 없는데도 "{}"의 글자수(2자)가 그대로 입력량으로 잡혀
    // "기타 저장" 목록에 근거 없는 행을 남기는 문제가 있었다 — detail도 없고 본문도 비어있으면
    // 애초에 "입력"이 아니므로 기록하지 않는다. (결과물은 대개 뒤이은 채무자 PATCH로 별도 기록됨)
    // DELETE는 제외 — 본문이 원래 없는 게 정상이고, 삭제 자체는 실제 사용자 행동이라 건수
    // 집계(총 수정 건수/마지막 활동)에서 계속 잡혀야 한다.
    const hasBody = req.body && typeof req.body === "object" && Object.keys(req.body).length > 0;
    if (req.method !== "DELETE" && !detail && !hasBody) return next();
    res.on("finish", () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        try { insertActivityLog.run("data_input", userName, bytes, req.path, refDebtorId, detail); } catch {}
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
           COALESCE(
             (SELECT ah.assignee FROM assignee_history ah
               WHERE ah.debtor_id = d.id AND ah.effective_date <= p.payment_date
               ORDER BY ah.effective_date DESC, ah.id DESC LIMIT 1),
             d.assignee
           ) AS assignee,
           d.hub_name AS hubName, d.hub_code AS hubCode,
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
           loan_date AS loanDate, statute_extension_date AS statuteExtensionDate,
           subrogation_month AS subrogationMonth,
           subrogation_month_cleared AS subrogationMonthCleared,
           subrogation_doc_url AS subrogationDocUrl,
           credit_check_date AS creditCheck, credit_grade AS creditGrade,
           credit_report_url AS creditReportUrl,
           resident_copy_date AS residentCopy, resident_copy_url AS residentCopyUrl,
           birth_date AS birthDate,
           resident_number AS residentNumber,
           latest_address AS latestAddress,
           latest_address_lat AS latestAddressLat,
           latest_address_lng AS latestAddressLng,
           resident_address AS residentAddress,
           resident_registered_date AS residentRegisteredDate,
           resident_note AS residentNote,
           resident_issued_date AS residentIssuedDate,
           credit_phone AS creditPhone,
           credit_queried_date AS creditQueriedDate,
           cb_match_excluded AS cbMatchExcluded,
           resident_match_excluded AS residentMatchExcluded,
           sales_rep AS salesRep,
           key_notes AS keyNotes,
           principal_balance AS principalBalance, adjustment, collected_amount AS collectedAmount,
           final_balance_finance AS finalBalanceFinance,
           final_balance_legal AS finalBalanceLegal,
           created_at AS createdAt,
           updated_at AS updatedAt,
           (SELECT GROUP_CONCAT(name, ',') FROM debtor_guarantors WHERE debtor_id = vd.id) AS guarantors_str
    FROM v_debtors vd
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
    if (ch === 0 && w === 0) {
      // 채널 세부 입력이 없는 경우(Slack/엑셀 입금)만 기본적으로 본사계좌로 가정
      c = total;
    } else {
      // 채널별 금액이 명시적으로 입력됐는데 총액과 일치하지 않으면 조용히 재배분하지 않고 에러 반환
      return { ok: false, error: `채널별 금액 합계(${(c + ch + w).toLocaleString()}원)가 총 입금액(${total.toLocaleString()}원)과 일치하지 않습니다` };
    }
  }

  let resolvedId = b.debtorId;
  let matchedBy = "수동지정";
  if (!resolvedId) {
    // 1순위: 학습된 매핑 확인 — 브랜드가 주어졌으면 그 debtor의 실제 브랜드와 일치할 때만 신뢰
    // (동일 입금자명이 과거엔 다른 브랜드 채무자로 학습됐을 수 있으므로, 안 맞으면 2순위 매처로 넘김)
    if (b.payerName) {
      const learned = db.prepare(`
        SELECT pm.debtor_id FROM payer_name_mappings pm
        JOIN debtors d ON d.id = pm.debtor_id
        WHERE pm.payer_name = ? AND (? IS NULL OR d.brand_code = ?)
      `).get(b.payerName, b.brand || null, b.brand || null);
      if (learned) { resolvedId = learned.debtor_id; matchedBy = "학습매핑"; }
    }
  }
  if (!resolvedId) {
    // 2순위: 자동 매처 (채무자명 + 연대보증인명 검색, 원코드 우선)
    const all = db.prepare("SELECT id, brand_code, name, hub_code FROM debtors").all();
    const guarantors = db.prepare("SELECT debtor_id, name FROM debtor_guarantors").all();
    const idx = matcher.buildIndex(all, guarantors);
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

  // 새 입금이 분할상환 일정과 즉시 매칭되도록 재평가 (기존엔 30분 주기 자동동기화만 있어 반영 지연)
  try { runInstallmentAutoSync({ forceDebtorIds: [resolvedId] }); } catch (e) { console.error("[auto-sync] 오류:", e.message); }

  // "신규 입금" 알림 규칙 즉시 평가 (동기 함수이므로 await 없이 fire-and-forget)
  fireEventAlert("new_payment", { debtorName: debtor.name, hubName: debtor.hub_name, amount: total }).catch(() => {});

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

  // 각 entry에 매칭 후보 부착 (연대보증인 포함, 원코드 우선)
  const all = db.prepare("SELECT id, brand_code, name, hub_code FROM debtors").all();
  const guarantors = db.prepare("SELECT debtor_id, name FROM debtor_guarantors").all();
  const idx = matcher.buildIndex(all, guarantors);
  const enriched = entries.map(e => {
    const m = matcher.matchDebtor(idx, { brand: e.brand || meta.brand, payerName: e.payerName, debtorName: e.payerName });
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
      brand: e.brand || meta.brand,
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

  let result;
  try {
    result = db.transaction(() => {
      // 잔액 원복
      db.prepare(`UPDATE debtors SET collected_amount = collected_amount - ?, updated_at = datetime('now', 'localtime') WHERE id = ?`).run(pay.total_amount, pay.debtor_id);

      // 미매칭 대기열에서 이 입금으로 연결된 건이 있으면 참조를 끊어준다 —
      // pending_payments.resolved_to_payment_id가 payments(id)를 FK로 참조하고 있어
      // 끊지 않으면 FOREIGN KEY constraint failed로 삭제 자체가 막힌다.
      db.prepare("UPDATE pending_payments SET resolved_to_payment_id = NULL WHERE resolved_to_payment_id = ?").run(payId);

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
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }

  // 입금이 삭제되어 분할상환 완납의 근거가 사라졌을 수 있으므로 해당 채무자 일정을 재열어 재평가
  try { runInstallmentAutoSync({ forceDebtorIds: [pay.debtor_id] }); } catch (e) { console.error("[auto-sync] 오류:", e.message); }

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

      // 입금자명 학습 매핑 업데이트 (다음 자동매칭 때 올바른 채무자로 적용)
      if (pay.payer_name) {
        db.prepare(`
          INSERT INTO payer_name_mappings (payer_name, debtor_id, debtor_name, resolved_count, learned_at)
          VALUES (?, ?, ?, 1, datetime('now', 'localtime'))
          ON CONFLICT(payer_name) DO UPDATE SET
            debtor_id = excluded.debtor_id,
            debtor_name = excluded.debtor_name,
            resolved_count = resolved_count + 1,
            learned_at = excluded.learned_at
        `).run(pay.payer_name, newDebtorId, newDebtor.name);
      }

      db.prepare(`INSERT INTO audit_logs (user_name, action, target, target_id, detail) VALUES (?, '수정', '입금', ?, ?)`).run(
        userName || "시스템", payId,
        `[재매칭] 입금 ${pay.total_amount.toLocaleString()}원: ${oldDebtor?.name || pay.debtor_id} → ${newDebtor.name}`
      );
      return { ok: true, oldDebtorName: oldDebtor?.name || pay.debtor_id, newDebtorName: newDebtor.name };
    })();
    // 재매칭으로 이전/신규 채무자 양쪽의 분할상환 완납 근거가 바뀔 수 있으므로 재평가
    try { runInstallmentAutoSync({ forceDebtorIds: [pay.debtor_id, newDebtorId] }); } catch (e) { console.error("[auto-sync] 오류:", e.message); }
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ─── 입금 등록/수정 히스토리 조회 ───────────────────
// GET /api/payments/:id/history
app.get("/api/payments/:id/history", (req, res) => {
  const payId = req.params.id;
  const pay = db.prepare("SELECT id, created_at, created_by FROM payments WHERE id = ?").get(payId);
  if (!pay) return res.status(404).json({ ok: false, error: "해당 입금건 없음" });

  const logs = db.prepare(`
    SELECT timestamp, user_name AS userName, action, detail
    FROM audit_logs WHERE target = '입금' AND target_id = ?
    ORDER BY timestamp ASC, id ASC
  `).all(payId);

  res.json({ ok: true, paymentId: pay.id, createdAt: pay.created_at, createdBy: pay.created_by, logs });
});

// ─── 알림 규칙 엔진 (관리자 > 알림 설정에서 만든 규칙을 실제로 평가/발송) ──
// 상태 스캔형 규칙(installment_overdue/rehab_overdue/high_balance/no_contact)은
// 30분마다 평가하되, 같은 규칙은 하루 1회만 발송(다이제스트)해 알림 폭주를 막는다.
// 이벤트형 규칙(new_payment/new_debtor/status_change)은 해당 API 처리 성공 시 즉시 발송한다.
// seizure_collected는 압류 회수액을 서버 DB에서 신뢰성 있게 추적할 데이터가 아직 없어 평가하지 않는다.
function alertAlreadySentToday(ruleId) {
  const today = new Date().toISOString().slice(0, 10);
  return !!db.prepare("SELECT 1 FROM alert_sent_log WHERE rule_id = ? AND sent_date = ?").get(ruleId, today);
}
function markAlertSentToday(ruleId, count) {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare("INSERT OR REPLACE INTO alert_sent_log (rule_id, sent_date, entity_count) VALUES (?, ?, ?)").run(ruleId, today, count);
}

// 채무자 개인정보(이름/금액/잔액 등)가 포함되므로 다인원 채널에는 절대 발송하지 않고
// 반드시 등록된 개인 Slack ID로만 DM 발송한다. Slack ID가 없으면 채널로 대체하지 않고
// 그냥 건너뛴다 — 어드민 > 알림 설정에서 DM 대상자 Slack ID를 등록해야 발송이 시작된다.
async function deliverAlert(rule, text) {
  if (!slackNotify) { console.warn(`[알림규칙] Slack 미설정 — "${rule.name}" 발송 건너뜀`); return false; }
  if (!rule.assignee_slack_id) {
    console.warn(`[알림규칙] "${rule.name}" DM 대상자 Slack ID 미등록 — 채널 대체발송 금지 정책으로 발송 건너뜀`);
    return false;
  }
  try {
    await slackNotify.chat.postMessage({ channel: rule.assignee_slack_id, text });
    return true;
  } catch (e) {
    console.warn(`[알림규칙] "${rule.name}" 발송 실패:`, e.message);
    return false;
  }
}

async function runAlertRules() {
  if (!slackNotify) return; // Slack 미설정 시 평가 자체를 건너뜀 (불필요한 쿼리 방지)
  const rules = db.prepare("SELECT * FROM alert_rules WHERE enabled = 1").all();

  for (const rule of rules) {
    if (alertAlreadySentToday(rule.id)) continue;
    let matched = [];
    let lines = [];

    if (rule.trigger_type === "installment_overdue") {
      matched = db.prepare(`
        SELECT s.id, d.name AS debtor_name, d.hub_name, s.debt_source, s.scheduled_amount, s.due_date, s.due_month
        FROM installment_schedules s
        JOIN installment_plans p ON s.plan_id = p.id
        JOIN debtors d ON p.debtor_id = d.id
        WHERE s.status IN ('미납','지연')
      `).all();
      lines = matched.map(s => `• ${s.debtor_name} (${s.hub_name || "-"}) | ${s.debt_source || "-"} | ${(s.scheduled_amount || 0).toLocaleString()}원 | 기준일: ${s.due_date || s.due_month}`);
    } else if (rule.trigger_type === "rehab_overdue") {
      matched = db.prepare(`
        SELECT r.id, d.name AS debtor_name, r.court, r.case_number, r.monthly_payment
        FROM rehabilitations r JOIN debtors d ON r.debtor_id = d.id
        WHERE r.overdue_status = '미납'
      `).all();
      lines = matched.map(r => `• ${r.debtor_name} | ${r.court || "-"} ${r.case_number || ""} | 월변제금 ${(r.monthly_payment || 0).toLocaleString()}원`);
    } else if (rule.trigger_type === "high_balance") {
      matched = db.prepare(`
        SELECT id, name, hub_name, final_balance_legal FROM v_debtors
        WHERE collection_status = '추심진행' AND final_balance_legal > 10000000
      `).all();
      lines = matched.map(d => `• ${d.name} (${d.hub_name || "-"}) | 잔액 ${(d.final_balance_legal || 0).toLocaleString()}원`);
    } else if (rule.trigger_type === "no_contact") {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      matched = db.prepare(`
        SELECT d.id, d.name, d.hub_name FROM debtors d
        WHERE d.collection_status = '추심진행'
          AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.debtor_id = d.id AND p.payment_date >= ?)
          AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.debtor_id = d.id AND a.activity_date >= ?)
      `).all(cutoff, cutoff);
      lines = matched.map(d => `• ${d.name} (${d.hub_name || "-"})`);
    } else if (rule.trigger_type === "history_promise") {
      matched = scanHistoryPromises(db, { windowDays: 1 });
      lines = matched.map(h => `• ${h.debtorName} (${h.hubName || "-"}) — ${h.resolvedDate} 추정 | "${h.snippet}" (기록일 ${h.entryDate})`);
    } else {
      continue; // 이벤트형 트리거는 해당 API 경로에서 즉시 발송하므로 여기서는 스킵
    }

    if (!matched.length) continue;
    const text = `🔔 *[${rule.name}] ${matched.length}건*\n${lines.slice(0, 30).join("\n")}${matched.length > 30 ? `\n...외 ${matched.length - 30}건` : ""}`;
    const sent = await deliverAlert(rule, text);
    if (sent) markAlertSentToday(rule.id, matched.length);
  }
}

// 이벤트형 규칙(입금 등록/신규 채권 등록/추심상태 변경) — 발생 즉시 평가·발송, 하루 dedup 없음
async function fireEventAlert(triggerType, ctx) {
  if (!slackNotify) return;
  const rules = db.prepare("SELECT * FROM alert_rules WHERE enabled = 1 AND trigger_type = ?").all(triggerType);
  for (const rule of rules) {
    let text;
    if (triggerType === "new_payment") {
      text = `💰 *[${rule.name}]*\n${ctx.debtorName} (${ctx.hubName || "-"}) 입금 ${(ctx.amount || 0).toLocaleString()}원 등록`;
    } else if (triggerType === "new_debtor") {
      text = `🆕 *[${rule.name}]*\n${ctx.debtorName} (${ctx.brand || "-"}) 채권 신규 등록`;
    } else if (triggerType === "status_change") {
      text = `🔁 *[${rule.name}]*\n${ctx.debtorName}: 추심상태 "${ctx.oldStatus || "-"}" → "${ctx.newStatus}"`;
    } else {
      continue;
    }
    await deliverAlert(rule, text);
  }
}

// ─── 알림 규칙 CRUD API (관리자 > 알림 설정) ─────────────────
const ALERT_RULE_ROW_TO_JSON = (r) => ({
  id: r.id, name: r.name, enabled: !!r.enabled, trigger: r.trigger_type, condition: r.condition_text,
  target: r.target, channel: r.channel, assignee: r.assignee, assigneeSlackId: r.assignee_slack_id,
});

app.get("/api/alert-rules", (req, res) => {
  const rows = db.prepare("SELECT * FROM alert_rules ORDER BY created_at").all();
  res.json(rows.map(ALERT_RULE_ROW_TO_JSON));
});

app.post("/api/alert-rules", (req, res) => {
  const b = req.body || {};
  const id = b.id || ("rule" + Date.now() + Math.floor(Math.random() * 900 + 100));
  try {
    db.prepare(`
      INSERT INTO alert_rules (id, name, enabled, trigger_type, condition_text, target, channel, assignee, assignee_slack_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, b.name || "새 알림 규칙", b.enabled ? 1 : 0, b.trigger || "installment_overdue",
      b.condition || "", b.target || "channel", b.channel || "", b.assignee || "", b.assigneeSlackId || "");
    res.json({ ok: true, id });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.patch("/api/alert-rules/:id", (req, res) => {
  const cols = { name: "name", enabled: "enabled", trigger: "trigger_type", condition: "condition_text", target: "target", channel: "channel", assignee: "assignee", assigneeSlackId: "assignee_slack_id" };
  const fields = [], vals = [];
  for (const [k, col] of Object.entries(cols)) {
    if (req.body[k] !== undefined) {
      fields.push(`${col} = ?`);
      vals.push(k === "enabled" ? (req.body[k] ? 1 : 0) : req.body[k]);
    }
  }
  if (!fields.length) return res.json({ ok: true });
  fields.push("updated_at = datetime('now','localtime')");
  vals.push(req.params.id);
  db.prepare(`UPDATE alert_rules SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
  res.json({ ok: true });
});

app.delete("/api/alert-rules/:id", (req, res) => {
  db.prepare("DELETE FROM alert_rules WHERE id = ?").run(req.params.id);
  db.prepare("DELETE FROM alert_sent_log WHERE rule_id = ?").run(req.params.id);
  res.json({ ok: true });
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

// ─── 분할상환 자동 상태 동기화 (GET 조회 시 최대 1분에 1회, runInstallmentAutoSync 위임) ──
// 과거에는 회차별로 ±7일 창에서 독립적으로 입금 합계를 조회해 완납 여부를 판단했으나,
// 이 경우 회차 간격이 7일보다 좁으면 하나의 입금이 두 회차 모두를 완납 처리하는 이중 크레딧
// 버그가 있었다. 아래 runInstallmentAutoSync()의 워터폴 배분 방식으로 완전히 대체한다.
let _lastAutoSync = 0;
function runAutoSync() {
  const now = Date.now();
  if (now - _lastAutoSync < 60000) return 0;
  _lastAutoSync = now;
  try {
    return runInstallmentAutoSync();
  } catch (e) {
    console.error("[auto-sync] 오류:", e.message);
    return 0;
  }
}

// GET /api/installments - 전체 플랜 + 일정 + 히스토리 목록
app.get("/api/installments", (req, res) => {
  runAutoSync();
  const plans = db.prepare(`
    SELECT p.*, d.name AS debtor_name, d.brand_code AS brand, d.assignee,
           d.hub_code, d.hub_name, d.final_balance_legal AS total_claim
    FROM installment_plans p
    JOIN v_debtors d ON p.debtor_id = d.id
    ORDER BY p.start_date DESC, p.id
  `).all();
  const getSchedules = db.prepare("SELECT * FROM installment_schedules WHERE plan_id = ? ORDER BY COALESCE(due_date, due_month || '-01'), id");
  const getHistory = db.prepare("SELECT * FROM installment_schedule_history WHERE plan_id = ? ORDER BY created_at ASC");
  res.json(plans.map(p => ({
    id: p.id, debtorId: p.debtor_id, debtorName: p.debtor_name, brand: p.brand,
    assignee: p.assignee, hubCode: p.hub_code, hubName: p.hub_name,
    paymentTiming: p.payment_timing, monthlyAmount: p.monthly_amount,
    totalClaim: p.total_claim, startDate: p.start_date, status: p.status, memo: p.memo,
    schedules: getSchedules.all(p.id).map(s => ({
      id: s.id, planId: s.plan_id, debtSource: s.debt_source, institution: s.institution,
      loanAmount: s.loan_amount, interestRate: s.interest_rate,
      dueDate: s.due_date, dueMonth: s.due_month, rolledOverTo: s.rolled_over_to, rolledOverFrom: s.rolled_over_from,
      scheduledAmount: s.scheduled_amount, paidAmount: s.paid_amount, status: s.status, memo: s.memo,
    })),
    history: getHistory.all(p.id).map(h => ({
      id: h.id, scheduleId: h.schedule_id, eventType: h.event_type,
      fromDate: h.from_date, toDate: h.to_date, amount: h.amount,
      memo: h.memo, userName: h.user_name, createdAt: h.created_at,
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

// PATCH /api/installments/schedules/:id - 일정 수정 (상태 변경 시 히스토리 기록)
app.patch("/api/installments/schedules/:id", (req, res) => {
  const { status, paidAmount, dueDate, dueMonth, scheduledAmount, memo, userName } = req.body || {};
  const cols = { status: "status", paidAmount: "paid_amount", dueDate: "due_date", dueMonth: "due_month", scheduledAmount: "scheduled_amount", memo: "memo" };
  const fields = [], vals = [];
  for (const [k, col] of Object.entries(cols)) {
    if (req.body[k] !== undefined) { fields.push(`${col} = ?`); vals.push(req.body[k]); }
  }
  if (!fields.length) return res.json({ ok: true });
  // 변경 전 원본 조회 (월 변경 감지용)
  const beforeSched = db.prepare("SELECT s.*, p.debtor_id FROM installment_schedules s JOIN installment_plans p ON s.plan_id = p.id WHERE s.id = ?").get(req.params.id);
  vals.push(req.params.id);
  db.prepare(`UPDATE installment_schedules SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
  if (status && beforeSched) {
    db.prepare(`INSERT INTO installment_schedule_history (schedule_id, plan_id, debtor_id, event_type, from_date, amount, memo, user_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.params.id, beforeSched.plan_id, beforeSched.debtor_id,
      status, beforeSched.due_date || beforeSched.due_month, beforeSched.scheduled_amount,
      memo || null, userName || '관리자'
    );
  }
  // 드래그 등으로 월이 바뀌었을 때, 원래 월에 일정이 없어지면 날짜미정 플레이스홀더 생성
  if (dueMonth && beforeSched && beforeSched.due_month && dueMonth !== beforeSched.due_month) {
    const leftInOldMonth = db.prepare("SELECT COUNT(*) AS cnt FROM installment_schedules WHERE plan_id = ? AND due_month = ?").get(beforeSched.plan_id, beforeSched.due_month);
    if (leftInOldMonth.cnt === 0) {
      const newId = "SCH" + Math.random().toString(36).slice(2, 11).toUpperCase();
      db.prepare("INSERT INTO installment_schedules (id, plan_id, due_month, due_date, scheduled_amount, paid_amount, status, created_at) VALUES (?, ?, ?, NULL, 0, 0, '예정', datetime('now','localtime'))").run(newId, beforeSched.plan_id, beforeSched.due_month);
    }
  }
  res.json({ ok: true });
});

// DELETE /api/installments/schedules/:id - 일정 삭제
app.delete("/api/installments/schedules/:id", (req, res) => {
  const sched = db.prepare("SELECT plan_id, due_month FROM installment_schedules WHERE id = ?").get(req.params.id);
  if (!sched) return res.json({ ok: true });
  db.prepare("DELETE FROM installment_schedules WHERE id = ?").run(req.params.id);
  if (sched.due_month) {
    // 같은 월에 일정이 없어지면 날짜미정 플레이스홀더 생성 (해당 월 카드에서 사라지지 않도록)
    const leftInMonth = db.prepare("SELECT COUNT(*) AS cnt FROM installment_schedules WHERE plan_id = ? AND due_month = ?").get(sched.plan_id, sched.due_month);
    if (leftInMonth.cnt === 0) {
      const newId = "SCH" + Math.random().toString(36).slice(2, 11).toUpperCase();
      db.prepare("INSERT INTO installment_schedules (id, plan_id, due_month, due_date, scheduled_amount, paid_amount, status, created_at) VALUES (?, ?, ?, NULL, 0, 0, '예정', datetime('now','localtime'))").run(newId, sched.plan_id, sched.due_month);
    }
  }
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

// POST /api/installments/schedules/:id/rollover - 이월 처리
// 이월은 한 건을 그대로 미래 날짜로 미루는 게 기본이지만, 실제로는 "900,000원을 8/7 45만 +
// 8/8 45만으로 나눠서 받기로 했다"처럼 여러 날짜로 쪼개 이월하는 경우가 있어 splits 배열로
// 받는다. 하위 호환을 위해 예전 방식(newDate 단일 필드)도 그대로 지원한다.
app.post("/api/installments/schedules/:id/rollover", (req, res) => {
  const { newDate, splits, memo, userName } = req.body || {};
  const items = (Array.isArray(splits) ? splits : [])
    .filter(s => s && s.date)
    .map(s => ({ date: s.date, amount: parseInt(s.amount, 10) || 0 }));
  if (items.length === 0 && newDate) items.push({ date: newDate, amount: 0 });
  if (items.length === 0) return res.status(400).json({ ok: false, error: "이월 날짜가 필요합니다" });

  const sched = db.prepare("SELECT s.*, p.debtor_id FROM installment_schedules s JOIN installment_plans p ON s.plan_id = p.id WHERE s.id = ?").get(req.params.id);
  if (!sched) return res.status(404).json({ ok: false, error: "일정 없음" });

  // 이미 완납/일부납으로 실제 입금이 반영된 일정이면 그 기록을 이월로 덮어쓰지 않는다.
  // 예) 90만원 중 60만원만 들어와 이미 완납 처리된 일정에 대해, 나머지 30만원을 다음
  // 날짜로 미루려고 "이월"을 쓰면 — 기존엔 원본 일정까지 통째로 '이월' 상태가 되어
  // (해당 상태는 달력에서 숨겨짐) 이미 받은 60만원 완납 기록이 사라지고, 그 자리에
  // 새로 만들어진 30만원 일정이 그 달 입금 풀을 다시 가져가 "완납"으로 잘못 표시되는
  // 이중 카운트 버그가 있었다. 이미 돈이 들어온 일정은 그대로 두고, 부족분만 새 일정
  // 으로 추가 생성해서 "원본 완납 1건 + 이월 1건" 2건이 남게 한다.
  const alreadyPaid = sched.status === "완납" || sched.status === "일부납";

  try {
    const newIds = db.transaction(() => {
      const ids = [];
      items.forEach((item, i) => {
        // Date.now()만 쓰면 같은 요청에서 여러 건을 만들 때 밀리초가 겹쳐 id가 충돌할 수 있어 인덱스를 더한다.
        const newId = "ISS" + (Date.now() + i) + Math.random().toString(36).slice(2, 6).toUpperCase();
        const newMonth = item.date.slice(0, 7);
        const amt = item.amount > 0 ? item.amount : sched.scheduled_amount;
        // 이월로 새로 만드는 일정은 아직 다가올 예정 납부일이지 이미 밀린 미납이 아니므로 '예정'으로
        // 시작해야 한다 — 예전엔 '미납'으로 박아서 새 날짜가 오기도 전에 연체로 표시되는 버그가 있었다.
        db.prepare("INSERT INTO installment_schedules (id, plan_id, debt_source, institution, loan_amount, interest_rate, due_date, due_month, scheduled_amount, status, memo, rolled_over_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '예정', ?, ?)").run(
          newId, sched.plan_id, sched.debt_source, sched.institution, sched.loan_amount, sched.interest_rate,
          item.date, newMonth, amt, memo || null, req.params.id
        );
        db.prepare("INSERT INTO installment_schedule_history (schedule_id, plan_id, debtor_id, event_type, from_date, to_date, amount, memo, user_name) VALUES (?, ?, ?, '이월', ?, ?, ?, ?, ?)").run(
          req.params.id, sched.plan_id, sched.debtor_id,
          sched.due_date || sched.due_month, item.date,
          amt, memo || null, userName || '관리자'
        );
        ids.push(newId);
      });
      if (alreadyPaid) {
        db.prepare("UPDATE installment_schedules SET rolled_over_to = ? WHERE id = ?").run(ids.join(","), req.params.id);
      } else {
        db.prepare("UPDATE installment_schedules SET status = '이월', rolled_over_to = ? WHERE id = ?").run(ids.join(","), req.params.id);
      }
      return ids;
    })();
    // 이월로 그 달의 일정 구성이 바뀌었으니, 같은 채무자의 이미 '완납'으로 확정된 일정도
    // 다시 계산한다 — 예: 과거 놓친 달을 뒤늦게 이월하면서 실제 입금일로 되돌리면, 그동안
    // 다른 달로 잘못 매칭돼 있던 완납이 다시 열려서 원래 달로 재배분돼야 한다.
    try { runInstallmentAutoSync({ forceDebtorIds: [sched.debtor_id] }); } catch (e) { console.error("[auto-sync] 오류:", e.message); }
    res.json({ ok: true, newScheduleIds: newIds, newScheduleId: newIds[0] });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/installments/schedules/:id/memo - 히스토리 메모 추가
app.post("/api/installments/schedules/:id/memo", (req, res) => {
  const { memo, eventType, userName } = req.body || {};
  if (!memo) return res.status(400).json({ ok: false, error: "memo 필요" });
  const sched = db.prepare("SELECT s.*, p.debtor_id FROM installment_schedules s JOIN installment_plans p ON s.plan_id = p.id WHERE s.id = ?").get(req.params.id);
  if (!sched) return res.status(404).json({ ok: false, error: "일정 없음" });
  const info = db.prepare("INSERT INTO installment_schedule_history (schedule_id, plan_id, debtor_id, event_type, from_date, amount, memo, user_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    req.params.id, sched.plan_id, sched.debtor_id,
    eventType || '메모', sched.due_date || sched.due_month,
    sched.scheduled_amount, memo, userName || '관리자'
  );
  db.prepare("UPDATE installment_schedules SET memo = ? WHERE id = ?").run(memo, req.params.id);
  res.json({ ok: true, historyId: info.lastInsertRowid });
});

// DELETE /api/installments/schedules/:id/memo/:historyId - 특이사항 메모 삭제
// (해당 일정에 지금 표시 중인 "기존 메모"를 지운다 — 이력 로그 한 줄과 현재 memo 값을 함께 지움.
// 더 이전 메모로 되돌리지 않고 그냥 "현재 특이사항 없음" 상태로 만든다.)
app.delete("/api/installments/schedules/:id/memo/:historyId", (req, res) => {
  const hist = db.prepare("SELECT * FROM installment_schedule_history WHERE id = ? AND schedule_id = ? AND event_type = '메모'").get(req.params.historyId, req.params.id);
  if (!hist) return res.status(404).json({ ok: false, error: "메모 이력 없음" });
  db.prepare("DELETE FROM installment_schedule_history WHERE id = ?").run(hist.id);
  db.prepare("UPDATE installment_schedules SET memo = '' WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// POST /api/installments/schedules/sync-memo-amounts - 메모 금액 일괄 적용
app.post("/api/installments/schedules/sync-memo-amounts", (req, res) => {
  function parseAmountFromText(text) {
    if (!text) return null;
    const manMatches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*만\s*원?/g)];
    if (manMatches.length) return Math.round(parseFloat(manMatches[manMatches.length - 1][1]) * 10000);
    const wonMatches = [...text.matchAll(/([\d,]+)\s*원/g)];
    if (wonMatches.length) return parseInt(wonMatches[wonMatches.length - 1][1].replace(/,/g, ""), 10) || null;
    return null;
  }
  const schedules = db.prepare("SELECT id, scheduled_amount, memo FROM installment_schedules WHERE memo IS NOT NULL AND memo != ''").all();
  let updated = 0;
  const updateStmt = db.prepare("UPDATE installment_schedules SET scheduled_amount = ? WHERE id = ?");
  db.transaction(() => {
    for (const s of schedules) {
      const amt = parseAmountFromText(s.memo);
      if (amt && amt > 0 && amt !== s.scheduled_amount) {
        updateStmt.run(amt, s.id);
        updated++;
      }
    }
  })();
  res.json({ ok: true, updated, total: schedules.length });
});

// ── 분할상환 자동 동기화 함수 (예정월 = 입금월 매칭 방식) ──
// 예정일이 속한 달과 같은 달에 들어온 입금만 그 달 일정에 배분한다(달을 넘어서는 워터폴
// 없음) — 이번 달 입금이 지난달 밀린 일정부터 채워지는 걸 막고, 특정 달을 놓치면 그 달은
// 계속 미납으로 남는다(자동 이월 없음, 이월은 수동으로만). 같은 달에 일정이 여러 개면
// (일괄 등록 등) 같은 채무자의 동일 입금액이 그 달 안에서 중복 매칭되지 않도록 그 달 안에서만
// 오래된 순서대로 배분한다.
// opts.forceDebtorIds: 이 채무자들의 일정은 이미 '완납'이어도 재계산한다
// (입금 삭제/재매칭으로 완납의 근거가 사라졌을 때 상태를 다시 열기 위함).
function runInstallmentAutoSync(opts = {}) {
  const forceDebtorIds = new Set(opts.forceDebtorIds || []);
  const today = new Date().toISOString().slice(0, 10);
  const todayMonth = today.slice(0, 7);

  const fmtAmt = (n) => {
    if (!n || n <= 0) return "0원";
    const man = Math.floor(n / 10000);
    const rest = n % 10000;
    if (man > 0 && rest === 0) return `${man}만원`;
    if (man > 0) return `${man}만 ${rest.toLocaleString("ko-KR")}원`;
    return `${n.toLocaleString("ko-KR")}원`;
  };

  const plans = db.prepare("SELECT id, debtor_id FROM installment_plans").all();
  let updated = 0;

  db.transaction(() => {
    for (const plan of plans) {
      // 이월 제외, 날짜순 전체 일정
      const allScheds = db.prepare(`
        SELECT id, due_date, due_month, scheduled_amount, status, paid_amount
        FROM installment_schedules
        WHERE plan_id = ? AND status != '이월'
        ORDER BY COALESCE(due_date, due_month || '-28') ASC
      `).all(plan.id);

      if (allScheds.length === 0) continue;

      // 예정일(due_date/due_month) 기준 월별로 나눠서, 그 달에 들어온 입금만 그 달 일정에
      // 배분한다 — 예전엔 플랜 시작일부터의 입금 전체를 하나의 풀로 모아 오래된 일정부터
      // 순서대로 채웠지만("워터폴"), 이러면 이번 달에 입금해도 지난달 밀린 일정부터 채워져서
      // "이번 달 걸 냈는데 왜 이번 달이 미납이냐"는 문의가 생겼다. 이제는 입금월과 예정월을
      // 그대로 맞춰서 매칭하고, 특정 달을 놓치면 그 달은 다른 달 입금으로 자동으로 채워지지
      // 않고 계속 미납으로 남는다(자동 이월 없음 — 이월은 여전히 수동으로만 처리).
      const schedsByMonth = new Map();
      for (const s of allScheds) {
        const month = s.due_date ? s.due_date.slice(0, 7) : (s.due_month || todayMonth);
        if (!schedsByMonth.has(month)) schedsByMonth.set(month, []);
        schedsByMonth.get(month).push(s);
      }

      for (const [month, monthScheds] of schedsByMonth) {
        const monthPrefix = `${month}%`;

        // 그 달에 들어온 입금만 (다른 달 입금은 이 달로 넘어오지 않음)
        const { total: monthPaid } = db.prepare(`
          SELECT COALESCE(SUM(total_amount), 0) AS total
          FROM payments WHERE debtor_id = ? AND payment_date LIKE ?
        `).get(plan.debtor_id, monthPrefix);

        const monthPayments = db.prepare(`
          SELECT payment_date, total_amount FROM payments
          WHERE debtor_id = ? AND payment_date LIKE ?
          ORDER BY payment_date ASC
        `).all(plan.debtor_id, monthPrefix);

        // 같은 달에 일정이 여러 개면(예: 일괄 등록) 그 달 안에서만 오래된 순서대로 배분
        let pool = monthPaid || 0;
        const changes = [];

        // 이 달(예정월) 자체가 아직 안 왔으면 처리 안 함 — 날짜 단위(due_date <= today)로
        // 더 세게 걸면 "이번 달 중 늦은 날짜"(예: 이월로 8/5에 잡힌 건)가 이번 달인데도
        // 아직 그 날이 안 됐다는 이유로 매칭이 안 되는 문제가 있었다(입금은 이미 들어왔는데
        // "왜 완납 처리가 안 되냐"는 문의로 이어짐) — 예정월=입금월 정책과 맞게 달 단위로만 게이트.
        if (month > todayMonth) continue;

        for (const s of monthScheds) {

          const needed = s.scheduled_amount || 0;
          // 이 특정 일정의 예정일이 실제로 지났는지(날짜 단위) — 위의 달 단위 게이트와는 별개로,
          // "아직 예정일이 안 된 건을 돈이 없다고 미납으로 찍어버리는" 걸 막기 위한 것.
          // 돈이 이미 들어와 있으면(allocated>0) 예정일 전이라도 완납/일부납으로 앞당겨 반영하되,
          // 배분할 돈이 하나도 없을 때는 예정일이 지나기 전까지는 상태를 건드리지 않고 "예정"을 유지한다.
          const isPastDue = (s.due_date && s.due_date <= today) ||
                             (!s.due_date && s.due_month && s.due_month <= todayMonth);

          if (s.status === "완납" && !forceDebtorIds.has(plan.debtor_id)) {
            // 이미 완납 → 예약된 금액만 풀에서 차감, 재처리 안 함
            pool = Math.max(0, pool - needed);
            continue;
          }

          let allocated = 0;
          let newStatus;

          if (needed > 0) {
            allocated = Math.min(pool, needed);
            if (allocated >= needed)      newStatus = "완납";
            else if (allocated > 0)       newStatus = "일부납";
            else if (isPastDue)           newStatus = "미납";
            // 아직 예정일 전이고 배분할 돈도 없으면 "예정"이어야 한다 — 예전 버그로 이미
            // 미납/일부납으로 잘못 찍혀 있던 건도 여기서 다시 예정으로 되돌려야 하므로
            // continue로 건너뛰지 않고 명시적으로 "예정"을 지정해 아래에서 되돌린다.
            else                          newStatus = "예정";
            pool -= allocated;
          } else {
            // scheduled_amount 없는 경우
            if (pool > 0)            newStatus = "완납";
            else if (isPastDue)      newStatus = "미납";
            else                     newStatus = "예정";
          }

          const paidAmtToStore = allocated > 0 ? allocated : (newStatus === "예정" ? 0 : (s.paid_amount || 0));
          const statusChanged   = newStatus !== s.status;
          const amountChanged   = newStatus === "일부납" && allocated !== (s.paid_amount || 0);

          if (statusChanged || amountChanged) {
            db.prepare("UPDATE installment_schedules SET status=?, paid_amount=? WHERE id=?")
              .run(newStatus, paidAmtToStore, s.id);
            if (statusChanged) {
              changes.push({ sched: s, newStatus, allocated });
              updated++;
            }
          }
        }

        // 입금 관련 변경(완납/일부납)만 자동 메모 생성
        const payChanges = changes.filter(c => c.newStatus === "완납" || c.newStatus === "일부납");
        if (payChanges.length > 0 && monthPayments.length > 0) {
          const lastPay = monthPayments[monthPayments.length - 1];
          const payDateStr = lastPay.payment_date.slice(5).replace("-", "/");
          const payAmtStr  = fmtAmt(lastPay.total_amount);

          const parts = payChanges.map(c => {
            const d = (c.sched.due_date || c.sched.due_month || "").slice(5).replace("-", "/");
            if (c.newStatus === "완납")   return `${d} 완납처리`;
            if (c.newStatus === "일부납") return `${d} ${fmtAmt(c.sched.scheduled_amount)} 중 ${fmtAmt(c.allocated)} 일부납 처리`;
            return null;
          }).filter(Boolean);

          const memoText = `${payDateStr} ${payAmtStr} 입금. ${parts.join(", ")}`;

          for (const c of payChanges) {
            db.prepare(`
              INSERT INTO installment_schedule_history
              (schedule_id, plan_id, debtor_id, event_type, from_date, amount, memo, user_name)
              VALUES (?, ?, ?, '자동동기화', ?, ?, ?, '시스템')
            `).run(c.sched.id, plan.id, plan.debtor_id,
              c.sched.due_date || c.sched.due_month,
              lastPay.total_amount, memoText);
          }
        } else if (changes.filter(c => c.newStatus === "미납").length > 0) {
          // 미납 처리 기록 (입금 없음)
          for (const c of changes.filter(ch => ch.newStatus === "미납")) {
            db.prepare(`
              INSERT INTO installment_schedule_history
              (schedule_id, plan_id, debtor_id, event_type, from_date, amount, memo, user_name)
              VALUES (?, ?, ?, '자동동기화', ?, NULL, '입금 미확인으로 미납 처리', '시스템')
            `).run(c.sched.id, plan.id, plan.debtor_id,
              c.sched.due_date || c.sched.due_month);
          }
        }
      }
    }
  })();

  return updated;
}

// 서버 시작 시 1회 + 30분마다 자동 실행
setTimeout(() => { try { const n = runInstallmentAutoSync(); if (n > 0) console.log(`[auto-sync] 분할상환 ${n}건 업데이트`); } catch(e) { console.error("[auto-sync] 오류:", e.message); } }, 5000);
setInterval(() => { try { const n = runInstallmentAutoSync(); if (n > 0) console.log(`[auto-sync] 분할상환 ${n}건 업데이트`); } catch(e) { console.error("[auto-sync] 오류:", e.message); } }, 30 * 60 * 1000);

// POST /api/installments/auto-sync - 입금내역 자동 매칭으로 상태 업데이트 (수동 호출)
app.post("/api/installments/auto-sync", (req, res) => {
  try {
    const updated = runInstallmentAutoSync();
    res.json({ ok: true, updated });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/installments/schedules/:id/diagnose - 이 일정이 왜 완납/일부납/미납으로 판정됐는지
// runInstallmentAutoSync()와 동일한(예정월 = 입금월 매칭) 배분 과정을 읽기 전용으로 그대로
// 재현해 보여준다. "입금은 됐는데 왜 미납인지" 문의가 있을 때, DB를 직접 열어보지 않고도
// 화면에서 바로(다른 달로 넘어가지 않고 그 달 안에서만 배분되는지 등) 원인을 확인할 수 있게 한다.
app.get("/api/installments/schedules/:id/diagnose", (req, res) => {
  try {
    const target = db.prepare("SELECT s.*, p.debtor_id FROM installment_schedules s JOIN installment_plans p ON s.plan_id = p.id WHERE s.id = ?").get(req.params.id);
    if (!target) return res.status(404).json({ ok: false, error: "일정 없음" });

    const today = new Date().toISOString().slice(0, 10);
    const todayMonth = today.slice(0, 7);

    const allScheds = db.prepare(`
      SELECT id, due_date, due_month, scheduled_amount, status, paid_amount
      FROM installment_schedules
      WHERE plan_id = ? AND status != '이월'
      ORDER BY COALESCE(due_date, due_month || '-28') ASC
    `).all(target.plan_id);

    const schedsByMonth = new Map();
    for (const s of allScheds) {
      const month = s.due_date ? s.due_date.slice(0, 7) : (s.due_month || todayMonth);
      if (!schedsByMonth.has(month)) schedsByMonth.set(month, []);
      schedsByMonth.get(month).push(s);
    }

    const months = [];
    for (const [month, monthScheds] of schedsByMonth) {
      const monthPrefix = `${month}%`;
      const { total: monthPaid } = db.prepare(`
        SELECT COALESCE(SUM(total_amount), 0) AS total
        FROM payments WHERE debtor_id = ? AND payment_date LIKE ?
      `).get(target.debtor_id, monthPrefix);

      const monthPayments = db.prepare(`
        SELECT id, payment_date, total_amount, payer_name FROM payments
        WHERE debtor_id = ? AND payment_date LIKE ?
        ORDER BY payment_date ASC
      `).all(target.debtor_id, monthPrefix);

      let pool = monthPaid || 0;
      const rows = [];
      const monthDue = month <= todayMonth; // 이 달 자체가 이미 시작됐는지 — runInstallmentAutoSync의 달 단위 게이트
      for (const s of monthScheds) {
        const needed = s.scheduled_amount || 0;
        // 이 일정 하나의 예정일이 실제로 지났는지(날짜 단위) — runInstallmentAutoSync과 동일하게,
        // 돈이 이미 들어와 있으면 예정일 전이라도 앞당겨 반영하지만, 배분할 돈이 없을 때 미납으로
        // 넘기는 건 예정일이 지난 뒤부터만 한다.
        const isPastDue = monthDue && ((s.due_date && s.due_date <= today) || (!s.due_date && s.due_month && s.due_month <= todayMonth));
        const poolBefore = pool;
        let allocated = 0, note;

        if (!monthDue) {
          note = "아직 이 달이 되지 않아 배분 대상이 아님";
        } else if (s.status === "완납") {
          allocated = needed;
          pool = Math.max(0, pool - needed);
          note = "이미 완납 처리됨 — 예정금액만큼 이 달 풀에서 차감";
        } else if (needed > 0) {
          allocated = Math.min(pool, needed);
          if (allocated > 0) pool -= allocated;
          note = allocated >= needed ? "전액 배분됨"
            : allocated > 0 ? "일부만 배분됨 (이 달 입금 부족)"
            : isPastDue ? "이 달에 입금이 없거나, 같은 달 앞선 일정이 먼저 가져감 — 다른 달 입금은 자동으로 넘어오지 않음"
            : "아직 예정일 전이라 미납으로 넘기지 않고 예정 상태를 유지함";
        } else {
          note = "예정금액이 설정되지 않음";
        }

        rows.push({
          scheduleId: s.id, dueDate: s.due_date, dueMonth: s.due_month,
          scheduledAmount: needed, currentStatus: s.status, isDue: isPastDue,
          poolBefore, allocated, poolAfter: pool,
          note, isTarget: s.id === target.id,
        });
      }

      months.push({ month, monthPaid: monthPaid || 0, payments: monthPayments, schedules: rows });
    }

    res.json({ ok: true, today, months });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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

// POST /api/installments/schedules/batch - 일정 일괄 생성 (달력 추가 모달)
app.post("/api/installments/schedules/batch", (req, res) => {
  const { planId, schedules } = req.body || {};
  if (!planId || !Array.isArray(schedules) || schedules.length === 0)
    return res.status(400).json({ ok: false, error: "planId, schedules 필요" });
  const plan = db.prepare("SELECT id FROM installment_plans WHERE id = ?").get(planId);
  if (!plan) return res.status(404).json({ ok: false, error: "플랜 없음" });
  try {
    const stmt = db.prepare(
      "INSERT INTO installment_schedules (id, plan_id, due_date, due_month, scheduled_amount, paid_amount, status, memo, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, datetime('now','localtime'))"
    );
    const insertMany = db.transaction((rows) => {
      for (const s of rows) stmt.run(s.id, planId, s.dueDate || null, s.dueMonth || null, s.scheduledAmount || 0, s.status || "예정", s.memo || null);
    });
    insertMany(schedules);
    res.json({ ok: true, created: schedules.length });
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
      INSERT INTO debtors (id, brand_code, category, assignee, name, phone,
        hub_code, hub_name, debt_cause, collection_status, exec_title, exec_title_url,
        loan_date, subrogation_month, birth_date, resident_number, sales_rep, key_notes,
        principal_balance, adjustment, collected_amount)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, b.brand || "B", b.category || "", b.assignee || "",
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
    if (b.assignee) {
      db.prepare("INSERT OR IGNORE INTO assignee_history (debtor_id, assignee, effective_date) VALUES (?, ?, date('now','localtime'))")
        .run(id, b.assignee);
    }
    fireEventAlert("new_debtor", { debtorName: b.name || "", brand: b.brand || "" }).catch(() => {});
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── 채무자 삭제 ──────────────────────────────────
app.delete("/api/debtors/:id", (req, res) => {
  try {
    const { id } = req.params;
    db.prepare("UPDATE pending_payments SET resolved_to_payment_id = NULL WHERE resolved_to_payment_id IN (SELECT id FROM payments WHERE debtor_id = ?)").run(id);
    db.prepare("DELETE FROM payments WHERE debtor_id = ?").run(id);
    db.prepare("DELETE FROM activities WHERE debtor_id = ?").run(id);
    db.prepare("DELETE FROM rehabilitations WHERE debtor_id = ?").run(id);
    db.prepare("DELETE FROM installment_plans WHERE debtor_id = ?").run(id);
    db.prepare("DELETE FROM complaint_history WHERE complaint_id IN (SELECT id FROM complaints WHERE debtor_id = ?)").run(id);
    db.prepare("DELETE FROM complaints WHERE debtor_id = ?").run(id);
    db.prepare("DELETE FROM assignee_history WHERE debtor_id = ?").run(id);
    db.prepare("DELETE FROM debtors WHERE id = ?").run(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── 채무자 정보 수정 ────────────────────────────
// debtors 테이블에 실제로 존재하는 컬럼만 추림 — fieldMap에 있는 필드 중
// 테이블에 없는 게 하나라도 있으면(예: 더 이상 안 쓰는 legacy 필드) 그 컬럼을
// 조회하려다 전체 PATCH가 실패해서 아무 필드도 저장되지 않는 문제를 방지한다.
const DEBTOR_TABLE_COLS = new Set(db.prepare("PRAGMA table_info(debtors)").all().map(c => c.name));

// ─── 채무자 대량 작업 (담당자/추심상태 일괄 변경) ─────────
// /api/debtors/:id 보다 먼저 등록해야 한다 — 안 그러면 Express가 "bulk"을 :id로 매칭해버린다.
app.patch("/api/debtors/bulk", (req, res) => {
  try {
    const { ids, assignee, collectionStatus, assigneeEffectiveDate, userName } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ ok: false, error: "ids가 필요합니다" });
    if (!assignee && !collectionStatus) return res.status(400).json({ ok: false, error: "변경할 담당자 또는 추심상태가 없습니다" });
    const _userName = userName || "관리자";
    const effDate = /^\d{4}-\d{2}-\d{2}$/.test(assigneeEffectiveDate || "")
      ? assigneeEffectiveDate
      : new Date().toISOString().slice(0, 10);

    const getOld = db.prepare("SELECT id, name, assignee, collection_status AS collectionStatus FROM debtors WHERE id = ?");
    const updBoth = db.prepare("UPDATE debtors SET assignee = ?, collection_status = ?, updated_at = datetime('now','localtime') WHERE id = ?");
    const updAssignee = db.prepare("UPDATE debtors SET assignee = ?, updated_at = datetime('now','localtime') WHERE id = ?");
    const updStatus = db.prepare("UPDATE debtors SET collection_status = ?, updated_at = datetime('now','localtime') WHERE id = ?");
    const insHist = db.prepare(`
      INSERT INTO assignee_history (debtor_id, assignee, effective_date) VALUES (?, ?, ?)
      ON CONFLICT(debtor_id, effective_date) DO UPDATE SET assignee = excluded.assignee
    `);
    const insLog = db.prepare(
      "INSERT INTO debtor_edit_log (debtor_id, debtor_name, changed_by, field_name, field_label, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );

    let updated = 0;
    const statusChanges = [];
    const tx = db.transaction(() => {
      for (const id of ids) {
        const old = getOld.get(id);
        if (!old) continue;
        if (assignee && collectionStatus) updBoth.run(assignee, collectionStatus, id);
        else if (assignee) updAssignee.run(assignee, id);
        else updStatus.run(collectionStatus, id);

        if (assignee && String(old.assignee ?? "") !== String(assignee)) {
          insHist.run(id, assignee, effDate);
          insLog.run(id, old.name, _userName, "assignee", "담당자", old.assignee ?? "", assignee);
        }
        if (collectionStatus && String(old.collectionStatus ?? "") !== String(collectionStatus)) {
          insLog.run(id, old.name, _userName, "collectionStatus", "추심상태", old.collectionStatus ?? "", collectionStatus);
          statusChanges.push({ debtorName: old.name, oldStatus: old.collectionStatus, newStatus: collectionStatus });
        }
        updated++;
      }
    });
    tx();

    statusChanges.forEach(c => { fireEventAlert("status_change", c).catch(() => {}); });

    res.json({ ok: true, updated });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

const DEBTOR_FIELD_MAP = {
  category:"category",assignee:"assignee",name:"name",phone:"phone",
  hubCode:"hub_code",hubName:"hub_name",debtCause:"debt_cause",collectionStatus:"collection_status",
  execTitle:"exec_title",execTitleUrl:"exec_title_url",loanDate:"loan_date",
  statuteExtensionDate:"statute_extension_date",
  subrogationMonth:"subrogation_month",subrogationDocUrl:"subrogation_doc_url",
  creditCheck:"credit_check_date",creditGrade:"credit_grade",creditReportUrl:"credit_report_url",
  residentCopy:"resident_copy_date",residentCopyUrl:"resident_copy_url",
  birthDate:"birth_date",residentNumber:"resident_number",
  salesRep:"sales_rep",keyNotes:"key_notes",
  principalBalance:"principal_balance",adjustment:"adjustment",collectedAmount:"collected_amount",
  latestAddress:"latest_address",
  residentAddress:"resident_address",residentRegisteredDate:"resident_registered_date",
  residentNote:"resident_note",creditPhone:"credit_phone",
};
const DEBTOR_FIELD_LABELS = {
  category:"분류",assignee:"담당자",name:"채무자명",phone:"연락처",
  hubCode:"코드",hubName:"허브/지점",debtCause:"채무발생원인",collectionStatus:"추심상태",
  execTitle:"집행권원",execTitleUrl:"집행권원PDF",loanDate:"대여일자",
  statuteExtensionDate:"채권 소멸시효 연장일",
  subrogationMonth:"대위변제월",subrogationDocUrl:"대위변제증명서PDF",
  creditCheck:"신용조회일자",creditGrade:"신용점수",creditReportUrl:"CB종합보고서PDF",
  residentCopy:"주민등록초본",residentCopyUrl:"주민등록초본PDF",
  birthDate:"생년월일",residentNumber:"주민등록번호",
  salesRep:"영업담당자",keyNotes:"주요사항",
  principalBalance:"원채무액",adjustment:"추가법무비용",collectedAmount:"회수액",
  latestAddress:"최신 주소",
  residentAddress:"최근 주소(초본)",residentRegisteredDate:"등록일",
  residentNote:"비고(세대주및관계)",creditPhone:"연락처(CB)",
};
// PATCH /api/debtors/:id와 수정 로그 "복원"이 공유하는 필드 저장 로직 —
// 두 곳이 각자 구현하면 조용히 갈라져서 복원만 지오코딩 초기화/담당자 이력을 빼먹는 등의
// 버그가 나기 쉽다. statsPath는 어드민 통계에 남길 요청 경로 표시용.
function applyDebtorFieldPatch(id, body, userName, statsPath) {
  const fields = [], vals = [], changedJsKeys = [], coercedVals = {};
  for (const [jsKey, dbCol] of Object.entries(DEBTOR_FIELD_MAP)) {
    if (!DEBTOR_TABLE_COLS.has(dbCol)) continue;
    if (body[jsKey] !== undefined) {
      // exec_title 등 INTEGER 컬럼에 프론트가 boolean(true/false)을 보내는 경우가 있는데
      // better-sqlite3는 boolean을 bind 파라미터로 받지 않아 저장 자체가 500으로 전부
      // 실패한다 (분류 등 다른 필드까지 같이 저장 안 됨). 0/1로 변환해서 방지.
      let v = body[jsKey];
      if (typeof v === "boolean") v = v ? 1 : 0;
      coercedVals[jsKey] = v;
      fields.push(`${dbCol} = ?`);
      vals.push(v);
      changedJsKeys.push(jsKey);
    }
  }
  if (fields.length === 0) return;

  // 수정 전 현재 값 조회 (로그 기록용) — 테이블에 실제로 존재하는 컬럼만 조회
  const selectParts = Object.entries(DEBTOR_FIELD_MAP)
    .filter(([, dbCol]) => DEBTOR_TABLE_COLS.has(dbCol))
    .map(([jk, dbCol]) => `${dbCol} AS "${jk}"`).join(', ');
  const oldRow = db.prepare(`SELECT name, ${selectParts} FROM debtors WHERE id = ?`).get(id);
  if (!oldRow) return;

  // 주소 텍스트가 바뀌면 예전 주소로 지오코딩된 좌표는 더 이상 유효하지 않으므로 비운다
  // (지도 화면에서 다시 조회할 때 자동으로 재지오코딩된다)
  if (changedJsKeys.includes('latestAddress')) {
    fields.push("latest_address_lat = NULL", "latest_address_lng = NULL", "latest_address_updated_at = datetime('now','localtime')");
  }
  if (changedJsKeys.includes('residentAddress')) {
    fields.push("resident_address_lat = NULL", "resident_address_lng = NULL");
  }
  // 대위변제일을 사람이 비워서 저장하면 "명시적으로 지움" 플래그를 세워, 대위변제증명서
  // OCR 자동추출 결과로 다시 채워지지 않게 한다. 값을 다시 입력하면 플래그는 해제된다.
  if (changedJsKeys.includes('subrogationMonth') && DEBTOR_TABLE_COLS.has('subrogation_month_cleared')) {
    fields.push("subrogation_month_cleared = ?");
    vals.push(coercedVals.subrogationMonth ? 0 : 1);
  }
  fields.push("updated_at = datetime('now','localtime')");
  vals.push(id);
  db.prepare(`UPDATE debtors SET ${fields.join(", ")} WHERE id = ?`).run(...vals);

  // 담당자가 바뀌면 변경일(effective date) 기준 이력을 남긴다 — 담당자별 실적은
  // 이 이력을 기준으로 결제일 시점 담당자에게 귀속되므로, 오늘이 아니라 과거/미래
  // 특정일부터 적용하고 싶을 때 프론트에서 assigneeEffectiveDate로 지정할 수 있다.
  if (changedJsKeys.includes('assignee') && String(oldRow.assignee ?? '') !== String(coercedVals.assignee ?? '')) {
    const effDate = /^\d{4}-\d{2}-\d{2}$/.test(body.assigneeEffectiveDate || '')
      ? body.assigneeEffectiveDate
      : new Date().toISOString().slice(0, 10);
    db.prepare(`
      INSERT INTO assignee_history (debtor_id, assignee, effective_date) VALUES (?, ?, ?)
      ON CONFLICT(debtor_id, effective_date) DO UPDATE SET assignee = excluded.assignee
    `).run(id, coercedVals.assignee, effDate);
  }

  // 변경 항목을 debtor_edit_log에 기록 (필드별 상세 이력 — "최근 수정 내역" 화면용)
  const debtorName = changedJsKeys.includes('name') ? String(body.name || '') : String(oldRow.name || '');
  const insLog = db.prepare(
    "INSERT INTO debtor_edit_log (debtor_id, debtor_name, changed_by, field_name, field_label, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  let statsBytes = 0;
  const logTx = db.transaction(() => {
    for (const jsKey of changedJsKeys) {
      const oldVal = String(oldRow[jsKey] ?? '');
      const newVal = String(coercedVals[jsKey] ?? '');
      if (oldVal !== newVal) {
        insLog.run(id, debtorName, userName, jsKey, DEBTOR_FIELD_LABELS[jsKey] || jsKey, oldVal, newVal);
        statsBytes += newVal.length;
      }
    }
  });
  logTx();
  // 어드민 통계용: 필드가 몇 개 바뀌었든 이 저장은 kv 저장과 동일하게
  // "저장 액션 1건"으로 집계한다 (필드별 세부 건수는 debtor_edit_log 자체를 볼 때만 쓴다).
  if (statsBytes > 0 && userName !== '알수없음') {
    insertActivityLog.run("data_input", userName, statsBytes, statsPath, null, null);
  }

  // "추심상태 변경" 알림 규칙 즉시 평가
  if (changedJsKeys.includes("collectionStatus") && String(oldRow.collectionStatus ?? "") !== String(body.collectionStatus ?? "")) {
    fireEventAlert("status_change", { debtorName, oldStatus: oldRow.collectionStatus, newStatus: body.collectionStatus }).catch(() => {});
  }
}

app.patch("/api/debtors/:id", (req, res) => {
  try {
    const { id } = req.params;
    let _userName = req.body._userName || '관리자';
    if (hasReplacementChar(_userName)) _userName = '알수없음';

    if (Object.keys(DEBTOR_FIELD_MAP).some(k => req.body[k] !== undefined)) {
      applyDebtorFieldPatch(id, req.body, _userName, req.path);
    } else if (req.body.guarantors === undefined) {
      return res.json({ ok: true });
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

// 수정 로그 항목 하나를 이전 값으로 되돌린다 — 잘못 고친 필드를 그 이전 값으로 복구.
app.post("/api/edit-logs/:id/restore", (req, res) => {
  try {
    const log = db.prepare("SELECT * FROM debtor_edit_log WHERE id = ?").get(req.params.id);
    if (!log) return res.status(404).json({ ok: false, error: "로그를 찾을 수 없습니다" });
    if (!DEBTOR_FIELD_MAP[log.field_name]) return res.status(400).json({ ok: false, error: "복원할 수 없는 항목입니다" });

    // principal_balance 등 숫자 컬럼은 문자열로 그대로 보내면 SQLite에 TEXT로 박혀 이후
    // 합계/비교 연산이 깨질 수 있어, 숫자로 안전하게 변환 가능하면 숫자로 되돌린다.
    const dbCol = DEBTOR_FIELD_MAP[log.field_name];
    const isNumericCol = ["principal_balance", "adjustment", "collected_amount", "exec_title"].includes(dbCol);
    let restoredVal = log.old_value ?? "";
    if (isNumericCol && restoredVal !== "" && !isNaN(Number(restoredVal))) restoredVal = Number(restoredVal);

    const userName = req.body?.userName || req.headers["x-user-name"] || "관리자";
    applyDebtorFieldPatch(log.debtor_id, { [log.field_name]: restoredVal }, userName, "/api/edit-logs/:id/restore");
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── 수정 로그 조회 ──────────────────────────────
app.get("/api/edit-logs", (req, res) => {
  try {
    const { debtorId, from, to, changedBy } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 1000, 5000);
    const where = [];
    const params = {};
    if (debtorId)  { where.push("debtor_id = @debtorId");  params.debtorId = debtorId; }
    if (from)      { where.push("changed_at >= @from");     params.from = from; }
    if (to)        { where.push("changed_at <= @to");       params.to = to + " 23:59:59"; }
    if (changedBy) { where.push("changed_by = @changedBy"); params.changedBy = changedBy; }
    params.limit = limit;
    const rows = db.prepare(`
      SELECT id, debtor_id AS debtorId, debtor_name AS debtorName,
             changed_by AS changedBy, changed_at AS changedAt,
             field_name AS fieldName, field_label AS fieldLabel,
             old_value AS oldValue, new_value AS newValue
      FROM debtor_edit_log
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY changed_at DESC, id DESC
      LIMIT @limit
    `).all(params);
    res.json(rows);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── 월별 회수채널 조회 ──────────────────────────
app.get("/api/collection-channels", (req, res) => {
  try {
    const { year } = req.query;
    const rows = db.prepare(
      year
        ? "SELECT year, month, brand, channel, amount, updated_at AS updatedAt, updated_by AS updatedBy FROM collection_channels WHERE year = ? ORDER BY month, brand, channel"
        : "SELECT year, month, brand, channel, amount, updated_at AS updatedAt, updated_by AS updatedBy FROM collection_channels ORDER BY year, month, brand, channel"
    ).all(...(year ? [parseInt(year)] : []));
    res.json(rows);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── 월별 회수채널 수정 (upsert) ─────────────────
app.put("/api/collection-channels", (req, res) => {
  try {
    const { year, month, brand = 'all', channel, amount, updatedBy = '관리자' } = req.body;
    if (!year || !month || !channel || amount === undefined) return res.status(400).json({ ok: false, error: "필수 파라미터 누락" });
    db.prepare(`
      INSERT INTO collection_channels (year, month, brand, channel, amount, updated_by)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(year, month, brand, channel) DO UPDATE SET
        amount = excluded.amount,
        updated_at = datetime('now','localtime'),
        updated_by = excluded.updated_by
    `).run(parseInt(year), parseInt(month), brand, channel, parseInt(amount) || 0, updatedBy);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── 형사고소 수정 (상태·URL·수사관 정보) ────────
app.patch("/api/complaints/:id", (req, res) => {
  try {
    const { id } = req.params;
    const { status, complaintUrl, investigator, investigatorContact, debtorId, policeStation, charge,
            complaintDate, complainant, goodsAmount, loanAmount } = req.body;
    const fields = [];
    const vals   = [];
    if (status              !== undefined) { fields.push("status = ?");                vals.push(status); }
    if (complaintUrl        !== undefined) { fields.push("complaint_url = ?");          vals.push(complaintUrl); }
    if (investigator        !== undefined) { fields.push("investigator = ?");           vals.push(investigator); }
    if (investigatorContact !== undefined) { fields.push("investigator_contact = ?");   vals.push(investigatorContact); }
    if (debtorId            !== undefined) { fields.push("debtor_id = ?");              vals.push(debtorId); }
    if (policeStation       !== undefined) { fields.push("police_station = ?");         vals.push(policeStation); }
    if (charge              !== undefined) { fields.push("charge = ?");                 vals.push(charge); }
    if (complaintDate       !== undefined) { fields.push("complaint_date = ?");         vals.push(complaintDate); }
    if (complainant         !== undefined) { fields.push("complainant = ?");            vals.push(complainant); }
    if (goodsAmount         !== undefined) { fields.push("goods_amount = ?");           vals.push(goodsAmount); }
    if (loanAmount          !== undefined) { fields.push("loan_amount = ?");            vals.push(loanAmount); }
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
    // created_by는 users(slack_id)를 참조하는 FK라 빈 문자열("")을 넣으면 어떤 slack_id와도
    // 안 맞아 매번 FOREIGN KEY constraint failed로 저장이 실패했다(프론트가 createdBy를
    // 안 보내는 게 정상 흐름이라 항상 이 경로를 탐) — NULL은 FK 검사를 통과하므로 null로 폴백.
    db.prepare("INSERT INTO activities (id, debtor_id, activity_date, activity_type, content, assignee, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, debtorId, activityDate || "", activityType || "", content || "", assignee || "", createdBy || null);
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

// ─── 재무실 대여금 회수 스케쥴 엑셀 대사 ────────────────
// 프론트에서 xlsx 파일을 직접 파싱해 해당 월에 회수 표시된 채무자 목록을 보내오면,
// CMS 입금 기록에 이미 반영돼 있는지 확인하고 없으면 미매칭 관리(pending_payments)에 등록한다.
// body: { year, month, items: [{ debtorName, hubName, hubCode, companyName, amount }], brand? }
app.post("/api/payments/verify-excel", (req, res) => {
  const { year, month, items, brand } = req.body || {};
  if (!year || !month || !Array.isArray(items)) {
    return res.status(400).json({ ok: false, error: "year, month, items가 필요합니다" });
  }
  const from = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  const all = db.prepare("SELECT id, brand_code, name, hub_code FROM debtors").all();
  const guarantors = db.prepare("SELECT debtor_id, name FROM debtor_guarantors").all();
  const idx = matcher.buildIndex(all, guarantors);

  let checked = 0, alreadyRecorded = 0, newlyFlagged = 0, duplicateSkipped = 0;
  for (const item of items) {
    const name = (item.debtorName || "").toString().trim();
    const amount = parseInt(item.amount, 10) || 0;
    if (!name || amount <= 0) continue;
    checked++;

    const m = matcher.matchDebtor(idx, { brand, hubCode: item.hubCode, debtorName: name });
    if (m) {
      const existing = db.prepare(
        "SELECT id FROM payments WHERE debtor_id = ? AND payment_date BETWEEN ? AND ?"
      ).get(m.debtorId, from, to);
      if (existing) { alreadyRecorded++; continue; }
    }

    const sourceRef = `verify:${brand || ""}:${year}-${String(month).padStart(2, "0")}:${item.hubCode || ""}:${name}`;
    const dup = db.prepare("SELECT id FROM pending_payments WHERE source_ref = ?").get(sourceRef);
    if (dup) { duplicateSkipped++; continue; }

    db.prepare(`
      INSERT INTO pending_payments (payment_date, excel_brand, excel_hub_name, excel_hub_code, excel_debtor_name,
                                    payer_name, total_amount, company_account, cash_charge,
                                    welcome_direct, note, source, source_ref, reason)
      VALUES (@payment_date, @brand, @hub_name, @hub_code, @debtor_name, @payer_name, @total, 0, @total, 0,
              @note, 'excel', @source_ref, '대여금 회수 스케쥴 대사 — CMS 입금 미확인')
    `).run({
      payment_date: to, brand: brand || null, hub_name: item.hubName || null, hub_code: item.hubCode || null,
      debtor_name: name, payer_name: name, total: amount,
      note: item.companyName ? `거래처: ${item.companyName}` : null, source_ref: sourceRef,
    });
    newlyFlagged++;
  }

  res.json({ ok: true, checked, alreadyRecorded, newlyFlagged, duplicateSkipped });
});

// ─── 매칭 실패 대기열 조회 ──────────────────────
app.get("/api/pending-payments", (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM pending_payments WHERE resolved = 0 ORDER BY payment_date DESC
  `).all();
  res.json(rows);
});

// ─── 보류 항목 채무자 수동 연결 ─────────────────
// 대기건 생성 시 채널을 추정해 pending_payments에 넣어두지만, 실제로는 연결 화면에서
// 캐쉬충전/웰컴직접 중 사용자가 명시적으로 고른 값을 우선한다 — channel이 없으면(예: 예전
// 클라이언트, 일괄연결 등 하위호환) pending 테이블에 저장된 값을 그대로 쓴다.
function splitChannelAmount(pending, channel) {
  const total = pending.total_amount;
  if (channel === "본사계좌") return { companyAccount: total, cashCharge: 0, welcomeDirect: 0 };
  if (channel === "캐쉬충전") return { companyAccount: 0, cashCharge: total, welcomeDirect: 0 };
  if (channel === "웰컴직접상환") return { companyAccount: 0, cashCharge: 0, welcomeDirect: total };
  return { companyAccount: pending.company_account, cashCharge: pending.cash_charge, welcomeDirect: pending.welcome_direct };
}

app.post("/api/pending-payments/:id/resolve", (req, res) => {
  const pendingId = parseInt(req.params.id, 10);
  const { debtorId, createdByName, force, channel } = req.body || {};
  if (!debtorId) return res.status(400).json({ ok: false, error: "debtorId가 필요합니다" });

  const pending = db.prepare("SELECT * FROM pending_payments WHERE id = ? AND resolved = 0").get(pendingId);
  if (!pending) return res.status(404).json({ ok: false, error: "대기 항목 없음" });

  const result = ingestPayment({
    debtorId,
    paymentDate: pending.payment_date,
    payerName: pending.payer_name,
    totalAmount: pending.total_amount,
    ...splitChannelAmount(pending, channel),
    note: pending.note,
    source: pending.source,
    sourceRef: pending.source_ref,
    createdByName: createdByName || "수동연결",
    force: !!force,
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

    // 같은 입금자명 + 같은 브랜드의 다른 보류 건만 즉시 자동처리 (다른 브랜드 동명이인 오매칭 방지)
    const samePending = db.prepare(
      "SELECT * FROM pending_payments WHERE payer_name = ? AND resolved = 0 AND id != ? AND excel_brand IS ?"
    ).all(pending.payer_name, pendingId, pending.excel_brand);

    let autoResolved = 0;
    for (const other of samePending) {
      const r2 = ingestPayment({
        debtorId,
        paymentDate: other.payment_date,
        payerName: other.payer_name,
        totalAmount: other.total_amount,
        ...splitChannelAmount(other, channel),
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

// ─── 문건 자동 생성 ─────────────────────────────────
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

// 배열(주로 id 있는 레코드 목록) 전체를 통째로 다시 저장하는 kvPut 특성상, 요청 본문
// 전체 크기를 "입력량"으로 세면 목록 하나에서 한 글자만 고쳐도 목록 전체 크기가 잡힌다.
// 이전 값과 비교해서 실제로 추가/변경된 항목의 크기만 합산 — 그 외 타입은 늘어난 만큼만.
function diffByteEstimate(oldVal, newVal) {
  if (Array.isArray(oldVal) && Array.isArray(newVal)) {
    const oldById = new Map();
    for (const item of oldVal) { if (item && typeof item === "object" && item.id != null) oldById.set(item.id, item); }
    let total = 0;
    for (const item of newVal) {
      if (!item || typeof item !== "object" || item.id == null) { total += JSON.stringify(item ?? "").length; continue; }
      const prev = oldById.get(item.id);
      if (!prev || JSON.stringify(prev) !== JSON.stringify(item)) total += JSON.stringify(item).length;
    }
    return total;
  }
  const len = (v) => { try { return JSON.stringify(v ?? "").length; } catch { return 0; } };
  return Math.max(0, len(newVal) - len(oldVal));
}

// diffByteEstimate와 같은 방식으로 "무엇이 추가/변경됐는지" 실제 내용을 뽑아낸다 —
// 예전엔 kv 저장은 항목 크기(byte)만 세고 내용은 전혀 남기지 않아서, 관리자 통계 화면에서
// hist_m_(채무자 히스토리) 등의 저장 내역이 전부 "세부 내용 미기록"으로만 보였다.
// 레코드 배열이면 content/text/memo/note 필드나(히스토리류), task/result(To Do List·
// 강제집행 등 업무현안 표) 조합 중 있는 걸 미리보기로 쓴다 — 둘 다 없으면 JSON 그대로.
function diffDetailText(oldVal, newVal) {
  const pickText = (item) => {
    if (item == null) return "";
    if (typeof item !== "object") return String(item);
    const v = item.content ?? item.text ?? item.memo ?? item.note;
    if (v != null) return String(v);
    if (item.task != null) {
      const parts = [String(item.task)];
      if (item.result) parts.push(`→ ${item.result}`);
      if (item.status) parts.push(`[${item.status}]`);
      if (item.assignee) parts.push(`(${item.assignee})`);
      return parts.join(" ");
    }
    if (item.debtorName != null) return String(item.debtorName) + (item.result ? ` — ${item.result}` : "");
    return JSON.stringify(item);
  };
  // 이전 텍스트와 새 텍스트에서 실제로 달라진(늘어난) 가운데 부분만 뽑아낸다 — 앞/뒤로
  // 겹치는 부분은 그대로 잘라내므로, 메모 한 줄만 고치거나 끝에 몇 줄 추가해도 그 부분만 잡힌다.
  const diffTextMiddle = (oldText, newText) => {
    oldText = String(oldText ?? "");
    newText = String(newText ?? "");
    const maxStart = Math.min(oldText.length, newText.length);
    let start = 0;
    while (start < maxStart && oldText[start] === newText[start]) start++;
    let endOld = oldText.length, endNew = newText.length;
    while (endOld > start && endNew > start && oldText[endOld - 1] === newText[endNew - 1]) { endOld--; endNew--; }
    return newText.slice(start, endNew);
  };
  // task/result/status/assignee 조합(To Do List·강제집행 등 업무현안 표)을 "수정"할 때는 실제로
  // 바뀐 필드만 나열한다 — 상태 드롭다운 클릭 한 번만 해도 매번 pickText()가 task+result+assignee
  // 전체 문장을 다시 만들어내서, 클릭 1번이 그 항목 전체 글자수(수십 자)로 부풀려지는 문제가 있었다.
  // 메모/히스토리 같은 자유 텍스트 항목도 마찬가지 이유로, 수정 시 전체 글자수를 다시 세지 않고
  // diffTextMiddle로 뽑아낸 "실제로 늘어난 부분"만 카운팅한다 — 늘어난 부분이 없으면(삭제/필드만
  // 변경) 통계에서 새로 입력한 글자가 없다는 뜻이므로 전체 텍스트로 되돌아가지 않는다.
  const pickChangedFieldsText = (prev, item) => {
    if (item.task == null) return diffTextMiddle(pickText(prev), pickText(item));
    const parts = [];
    if (String(prev.task ?? "") !== String(item.task ?? "")) parts.push(`업무내용→${item.task || "(비움)"}`);
    if (String(prev.result ?? "") !== String(item.result ?? "")) parts.push(`결과→${item.result || "(비움)"}`);
    if (String(prev.status ?? "") !== String(item.status ?? "")) parts.push(`상태 ${prev.status || "-"}→${item.status || "-"}`);
    if (String(prev.assignee ?? "") !== String(item.assignee ?? "")) parts.push(`담당자 ${prev.assignee || "-"}→${item.assignee || "-"}`);
    if (String(prev.deleted ?? "") !== String(item.deleted ?? "")) parts.push(item.deleted ? "삭제 처리" : "복구");
    return parts.length ? parts.join(", ") : pickText(item);
  };
  let changed = null;
  const touchedIds = []; // 이번 저장에서 실제로 추가/변경된 항목의 id — 짧은 시간 내 같은 항목을
                          // 반복 저장할 때 새 행을 계속 쌓지 않고 하나로 합치기 위해 호출부에 넘겨준다.
  if (Array.isArray(newVal)) {
    // 이 키의 첫 저장(oldVal이 아직 없음)이면 전부 새 항목으로 취급 — oldVal이 배열이 아니어도
    // (null 등) newVal이 배열이면 그 항목들에서 내용을 뽑아내야 첫 저장 때도 미리보기가 나온다.
    const oldArr = Array.isArray(oldVal) ? oldVal : [];
    const oldById = new Map();
    for (const item of oldArr) { if (item && typeof item === "object" && item.id != null) oldById.set(item.id, item); }
    changed = [];
    for (const item of newVal) {
      if (!item || typeof item !== "object" || item.id == null) { changed.push(pickText(item)); continue; }
      const prev = oldById.get(item.id);
      if (!prev) { changed.push(`추가: ${pickText(item)}`); touchedIds.push(item.id); }
      else if (JSON.stringify(prev) !== JSON.stringify(item)) { changed.push(`수정: ${pickChangedFieldsText(prev, item)}`); touchedIds.push(item.id); }
    }
    changed = changed.filter(t => t && t.trim());
  } else if (newVal != null && typeof newVal === "object") {
    // 배열이 아닌 통짜 객체(예: legal_manual_overrides의 "사건번호→채무자id" 매핑)는 그동안
    // JSON을 그대로 다 세서, 안 바뀐 나머지 항목까지 매번 다시 잡히고("이 사건번호가 어느
    // 채무자였는지" raw JSON만 남아 사람이 읽고 확인("증빙")할 수도 없었다. 실제로 추가/변경된
    // 키만 "키→값"으로 뽑아서 보여준다 — 값이 채무자 id로 보이면 이름까지 붙여 읽을 수 있게 한다.
    const oldObj = (oldVal && typeof oldVal === "object" && !Array.isArray(oldVal)) ? oldVal : {};
    changed = [];
    for (const [k, v] of Object.entries(newVal)) {
      if (JSON.stringify(oldObj[k]) === JSON.stringify(v)) continue;
      const vStr = typeof v === "string" ? v : JSON.stringify(v);
      const debtorName = typeof v === "string" ? db.prepare("SELECT name FROM debtors WHERE id = ?").get(v)?.name : null;
      changed.push(`${k}→${debtorName ? `${debtorName}(${vStr})` : vStr}`);
      touchedIds.push(k);
    }
  } else if (newVal != null) {
    const t = typeof newVal === "string" ? newVal : JSON.stringify(newVal);
    changed = t ? [t] : [];
  }
  if (!changed || changed.length === 0) return null;
  const CAP = 2000; // 목록형 kv(To Do List 등)는 여러 항목이 한 번에 바뀔 수 있어 여유 있게 잡음
  const joined = changed.join(" / ");
  const text = joined.length > CAP ? joined.slice(0, CAP) + "…" : joined;
  // 이번 저장에서 항목이 정확히 하나만 바뀌었을 때만 그 id를 넘긴다 — 여러 항목이 한 번에
  // 바뀐 저장(일괄 처리 등)까지 하나로 합치면 서로 다른 항목의 기록이 뒤섞여버린다.
  return { text, itemId: touchedIds.length === 1 ? touchedIds[0] : null };
}

// kv 저장 하나가 여러 단계로 나뉘어 들어올 때(새 항목을 만들면서 담당자→업무내용→상태를
// 순서대로 따로 저장하는 경우 등) 매번 새 행으로 쌓으면 한 번의 실제 작업이 여러 건으로
// 부풀려진다 — 같은 (사용자, 키, 항목 id)를 짧은 시간 안에 다시 저장하면 새 행을 추가하지
// 않고 마지막 저장을 갱신한다. 서버 프로세스가 살아있는 동안만 유지되는 메모리 캐시라
// 재시작되면 그냥 새로 쌓이기 시작할 뿐이라 안전하다 — 서로 다른 항목/사용자/키는 절대 섞이지 않는다.
const recentKvEdits = new Map(); // "user path itemId" -> { logId, ts }
const KV_COALESCE_WINDOW_MS = 3 * 60 * 1000;
const insertActivityLogWithItem = db.prepare(
  "INSERT INTO user_activity_log (type, user_name, bytes, path, ref_debtor_id, detail, item_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
);
function logKvDataInput(userName, path, bytes, detail, itemId) {
  if (bytes <= 0 || userName === "알수없음") return;
  const last = db.prepare(
    "SELECT id, detail FROM user_activity_log WHERE type='data_input' AND user_name = ? AND path = ? ORDER BY id DESC LIMIT 1"
  ).get(userName, path);
  // 직전 저장과 내용이 완전히 같으면(예: 실제 변화 없이 같은 값을 다시 저장) 새로 입력한 게
  // 없으므로 기록하지 않는다 — 항목 단위 구분이 없는 키(예: 통짜 객체)에서도 안전하게 적용됨.
  if (last && (last.detail ?? null) === (detail ?? null)) return;
  if (itemId != null) {
    const cacheKey = `${userName} ${path} ${itemId}`;
    const cached = recentKvEdits.get(cacheKey);
    if (cached && last && cached.logId === last.id && Date.now() - cached.ts <= KV_COALESCE_WINDOW_MS) {
      db.prepare("UPDATE user_activity_log SET bytes = ?, detail = ?, ts = datetime('now','localtime') WHERE id = ?").run(bytes, detail, cached.logId);
      cached.ts = Date.now();
      return;
    }
  }
  const info = insertActivityLogWithItem.run("data_input", userName, bytes, path, null, detail, itemId != null ? String(itemId) : null);
  if (itemId != null) recentKvEdits.set(`${userName} ${path} ${itemId}`, { logId: info.lastInsertRowid, ts: Date.now() });
}

// kv 배열/객체에서 항목이 완전히 삭제되면(예: 히스토리 항목 삭제, 매핑 항목 제거), 그 항목
// 때문에 예전에 찍혔던 "추가"/"수정" 로그도 더 이상 실제로 남아있는 입력이 아니다 — 통계에서
// 빼되(bytes=0), 로그 자체는 지우지 않고 "[이후 삭제됨]" 표시만 붙여서 "그때 이런 걸 썼다가
// 나중에 지웠다"는 사실은 화면에서 계속 확인할 수 있게 남겨둔다. 이미 확인/마감한 과거 기간의
// 숫자도 다시 조회하면 이 삭제가 반영되어 바뀔 수 있다 — 다만 이 기능 적용 이전에 이미 지워진
// 항목은 item_id가 안 남아있어 손댈 수 없고, 앞으로 발생하는 삭제부터만 적용된다.
function voidKvItemLogs(path, itemId) {
  if (itemId == null) return;
  db.prepare(`
    UPDATE user_activity_log
    SET bytes = 0, detail = '[이후 삭제됨] ' || COALESCE(detail, '')
    WHERE path = ? AND item_id = ? AND bytes > 0
  `).run(path, String(itemId));
}

// PUT /api/kv/:key — 키 하나 저장 (저장 후 SSE broadcast)
app.put("/api/kv/:key", (req, res) => {
  const key = req.params.key;
  if (isInternalKey(key)) return res.status(403).json({ error: "internal key" });
  // 시스템 설정성 키(app_users)와 "__"로 시작하는 테스트/진단용 키는 통계 집계 대상이 아니므로
  // diff 계산 없이 바로 저장
  if (key !== "app_users" && !key.startsWith("__")) {
    try {
      const oldRow = db.prepare("SELECT value FROM kv_store WHERE key = ?").get(key);
      const oldVal = oldRow ? JSON.parse(oldRow.value) : null;
      const diffResult = diffDetailText(oldVal, req.body);
      // detail(화면에 보일 실제 내용)이 있으면 그 글자수를 그대로 쓴다 — 보이는 텍스트와
      // 세는 글자수가 항상 같아야 신뢰할 수 있다. 못 뽑아낸 경우만 예전 크기 추정치로 대체.
      const detail = diffResult ? diffResult.text : null;
      const bytes = detail ? detail.length : diffByteEstimate(oldVal, req.body);
      const userName = extractUserName(req);
      logKvDataInput(userName, req.path, bytes, detail, diffResult ? diffResult.itemId : null);
      // 배열/객체에서 항목이 통째로 사라졌으면(완전 삭제) 그 항목으로 예전에 찍힌 로그를 무효화.
      if (Array.isArray(oldVal) && Array.isArray(req.body)) {
        const newIds = new Set(req.body.filter(x => x && x.id != null).map(x => x.id));
        for (const item of oldVal) {
          if (item && item.id != null && !newIds.has(item.id)) voidKvItemLogs(req.path, item.id);
        }
      } else if (oldVal && typeof oldVal === "object" && !Array.isArray(oldVal) && req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
        for (const k of Object.keys(oldVal)) {
          if (!(k in req.body)) voidKvItemLogs(req.path, k);
        }
      }
    } catch {}
  }
  // To Do List는 항목 배열 전체를 통째로 PUT하므로, 직전 저장값과 비교해서
  // 등록/완료/삭제 이벤트만 뽑아 별도 로그에 남긴다 (통계 "업무 처리 현황"용).
  if (key === "manual_todo_list") {
    try {
      const userName = extractUserName(req);
      if (userName !== "알수없음") {
        const oldRow2 = db.prepare("SELECT value FROM kv_store WHERE key = ?").get(key);
        const oldArr = oldRow2 ? JSON.parse(oldRow2.value) : [];
        const newArr = Array.isArray(req.body) ? req.body : [];
        const oldById = new Map(oldArr.map(x => [x.id, x]));
        const insertTodoLog = db.prepare(`INSERT INTO todo_activity_log (action, todo_id, assignee, task, user_name) VALUES (?, ?, ?, ?, ?)`);
        for (const item of newArr) {
          const prev = oldById.get(item.id);
          if (!prev) {
            insertTodoLog.run("등록", item.id, item.assignee || "", item.task || "", userName);
            continue;
          }
          if (prev.status !== "완료" && item.status === "완료") insertTodoLog.run("완료", item.id, item.assignee || "", item.task || "", userName);
          if (!prev.deleted && item.deleted) insertTodoLog.run("삭제", item.id, item.assignee || "", item.task || "", userName);
        }
        // 트래시(deleted=true)에서 영구 삭제된 항목은 위에서 이미 "삭제"로 집계된 뒤이므로
        // 배열에서 사라질 때 다시 세지 않는다 — deleted=false인 채로 통째로 사라지는
        // (정상 플로우에서는 없는) 경우만 방어적으로 "삭제" 1건으로 남긴다.
        const newIds = new Set(newArr.map(x => x.id));
        for (const item of oldArr) {
          if (!newIds.has(item.id) && !item.deleted) insertTodoLog.run("삭제", item.id, item.assignee || "", item.task || "", userName);
        }
      }
    } catch {}
  }
  db.prepare(`
    INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now', 'localtime'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(req.body));
  res.json({ ok: true });
});

// POST /api/todo-list/from-outlook-flag — Outlook에서 메일에 플래그를 걸면 Power Automate가
// 이 엔드포인트를 호출해 To Do List에 항목 하나를 추가한다. outlookMessageId로 같은 메일이
// 이미 등록됐는지 확인해 중복 등록을 막는다(플로우가 같은 메일을 두 번 감지해도 안전).
app.post("/api/todo-list/from-outlook-flag", (req, res) => {
  if (OUTLOOK_FLAG_SECRET && req.get("x-webhook-secret") !== OUTLOOK_FLAG_SECRET) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  const subject = String(req.body?.subject || "").trim();
  const messageId = req.body?.messageId ? String(req.body.messageId) : null;
  const assignee = String(req.body?.assignee || "배현진").trim();
  if (!subject) return res.status(400).json({ ok: false, error: "subject 필요" });
  const row = db.prepare("SELECT value FROM kv_store WHERE key='manual_todo_list'").get();
  const arr = row ? JSON.parse(row.value) : [];
  if (messageId && arr.some(x => x.outlookMessageId === messageId)) {
    return res.json({ ok: true, skipped: true });
  }
  const item = {
    id: `TODO${Date.now()}${Math.floor(Math.random() * 900 + 100)}`,
    assignee,
    task: subject,
    result: "",
    status: "진행중",
    createdAt: new Date().toISOString().split("T")[0],
    completedAt: null,
    deleted: false,
    outlookMessageId: messageId,
  };
  arr.push(item);
  db.prepare(`
    INSERT INTO kv_store (key, value, updated_at) VALUES ('manual_todo_list', ?, datetime('now', 'localtime'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(JSON.stringify(arr));
  res.json({ ok: true, id: item.id });
});

// POST /api/todo-list/from-notion-flag — "플래그 메일함" 노션 데이터베이스에 쌓인 항목들의
// 제목만 To Do List에 담당자(요청한 사용자)로 등록한다. 수동 버튼 트리거이며, notionPageId로
// 이미 가져온 항목은 건너뛰어 같은 메일이 중복 등록되지 않게 한다.
app.post("/api/todo-list/from-notion-flag", async (req, res) => {
  if (!NOTION_API_KEY || !NOTION_FLAG_DB_ID) {
    return res.status(400).json({ ok: false, error: "NOTION_API_KEY / NOTION_FLAG_DB_ID가 설정되지 않았습니다" });
  }
  const assignee = extractUserName(req);
  if (assignee === "알수없음") return res.status(400).json({ ok: false, error: "로그인한 사용자를 확인할 수 없습니다" });
  try {
    const row = db.prepare("SELECT value FROM kv_store WHERE key='manual_todo_list'").get();
    const arr = row ? JSON.parse(row.value) : [];
    const already = new Set(arr.filter(x => x.notionPageId).map(x => x.notionPageId));

    const pages = [];
    let cursor = undefined;
    do {
      const notionRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_FLAG_DB_ID}/query`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${NOTION_API_KEY}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 }),
      });
      const notionData = await notionRes.json();
      if (!notionRes.ok) {
        return res.status(502).json({ ok: false, error: `노션 API 오류: ${notionData?.message || notionRes.status}` });
      }
      pages.push(...(notionData.results || []));
      cursor = notionData.has_more ? notionData.next_cursor : undefined;
    } while (cursor);

    let imported = 0, skipped = 0;
    for (const page of pages) {
      if (already.has(page.id)) { skipped++; continue; }
      const titleProp = Object.values(page.properties || {}).find(p => p.type === "title");
      const subject = (titleProp?.title || []).map(t => t.plain_text || "").join("").trim();
      if (!subject) { skipped++; continue; }
      arr.push({
        id: `TODO${Date.now()}${Math.floor(Math.random() * 900 + 100)}`,
        assignee,
        priority: "보통",
        task: subject,
        result: "",
        status: "진행중",
        createdAt: new Date().toISOString().split("T")[0],
        completedAt: null,
        deleted: false,
        notionPageId: page.id,
      });
      already.add(page.id);
      imported++;
    }
    if (imported > 0) {
      db.prepare(`
        INSERT INTO kv_store (key, value, updated_at) VALUES ('manual_todo_list', ?, datetime('now', 'localtime'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(JSON.stringify(arr));
    }
    res.json({ ok: true, imported, skipped });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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

// 채무자별 관련 데이터(이메일/슬랙/노션 이력) 조회
// 본인이 등록한 항목(created_by=viewer) + 공유(shared=1) 처리된 항목만 보임
app.get("/api/related-data/:debtorId", (req, res) => {
  try {
    const viewer = req.query.viewer || "";
    const rows = db.prepare("SELECT * FROM debtor_related_data WHERE debtor_id = ? AND (shared = 1 OR created_by = ?) ORDER BY occurred_at DESC")
      .all(req.params.debtorId, viewer);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 채무자별 관련 데이터 등록
app.post("/api/related-data/:debtorId", (req, res) => {
  try {
    const { source, title, summary, url, occurredAt, createdBy, shared } = req.body;
    if (!source || !title || !url) return res.status(400).json({ error: "source, title, url은 필수입니다" });
    db.prepare(`
      INSERT OR IGNORE INTO debtor_related_data (debtor_id, source, title, summary, url, occurred_at, created_by, shared)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.params.debtorId, source, title, summary || null, url, occurredAt || null, createdBy || null, shared ? 1 : 0);
    const rows = db.prepare("SELECT * FROM debtor_related_data WHERE debtor_id = ? AND (shared = 1 OR created_by = ?) ORDER BY occurred_at DESC")
      .all(req.params.debtorId, createdBy || "");
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 관련 데이터 공유 여부 변경
app.patch("/api/related-data/:id", (req, res) => {
  try {
    db.prepare("UPDATE debtor_related_data SET shared = ? WHERE id = ?").run(req.body.shared ? 1 : 0, parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 관련 데이터 삭제
app.delete("/api/related-data/:id", (req, res) => {
  try {
    db.prepare("DELETE FROM debtor_related_data WHERE id = ?").run(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 파일 인덱스 기반 후보 검색 (빠름)
function findCandidatesFromIndex(debtorName, guarantorNames, minScore, keywords) {
  let rows = db.prepare("SELECT * FROM file_index").all();
  if (keywords && keywords.length > 0) {
    rows = rows.filter(r => {
      const fn = r.filename.toLowerCase();
      const dt = (r.doc_type || "").toLowerCase();
      return keywords.some(kw => fn.includes(kw) || dt.includes(kw));
    });
  }
  const candidates = [];
  for (const row of rows) {
    const parsed = { personName: row.parsed_person_name };
    const { score, matchReason, matchedName, matchType } = fileScanner.scoreFile(
      parsed, row.filename, row.rel_path || "", debtorName, guarantorNames
    );
    if (score >= minScore) {
      candidates.push({
        filePath: row.file_path, filename: row.filename, relPath: row.rel_path,
        folderName: row.folder_name, parsedDate: row.parsed_date,
        parsedDirection: row.parsed_direction, parsedPersonName: row.parsed_person_name,
        docType: row.doc_type, ext: row.ext, score, matchReason, matchedName, matchType,
      });
    }
  }
  candidates.sort((a, b) => b.score !== a.score ? b.score - a.score : (b.parsedDate || "").localeCompare(a.parsedDate || ""));
  return { ok: true, candidates, totalScanned: rows.length, fromIndex: true };
}

// 인덱스 상태 조회
app.get("/api/admin/index-status", (req, res) => {
  try {
    const row = db.prepare("SELECT COUNT(*) as cnt, MAX(indexed_at) as lastAt FROM file_index").get();
    res.json({ count: row.cnt, lastAt: row.lastAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 파일 인덱스 재구성 (워커 스레드에서 실행 — 이벤트 루프 비차단). 어드민 버튼과
// 주기적 자동 재인덱싱(서버 기동 부분 참고)이 이 함수를 공유해서 쓴다.
function runReindex() {
  return new Promise((resolve, reject) => {
    const rootRow = db.prepare("SELECT value FROM kv_store WHERE key='docs_scan_root'").get();
    if (!rootRow || !rootRow.value) return reject(new Error("스캔 폴더 경로가 설정되지 않았습니다"));

    const { Worker } = require("worker_threads");
    const scannerPath = require.resolve("./fileScanner.cjs");
    const rootPath    = rootRow.value;

    const workerCode = `
      const { workerData, parentPort } = require('worker_threads');
      const { indexAllFiles } = require(workerData.scannerPath);
      parentPort.postMessage(indexAllFiles(workerData.rootPath));
    `;
    const worker = new Worker(workerCode, { eval: true, workerData: { scannerPath, rootPath } });
    const timer  = setTimeout(() => { worker.terminate(); reject(new Error("인덱싱 시간 초과 (3분)")); }, 180000);

    worker.on("message", result => {
      clearTimeout(timer);
      if (!result.ok) return reject(new Error(result.error || "인덱싱 실패"));
      const ins = db.prepare(`INSERT OR REPLACE INTO file_index
        (file_path,filename,folder_name,rel_path,parsed_date,parsed_direction,parsed_person_name,doc_type,ext)
        VALUES (?,?,?,?,?,?,?,?,?)`);
      db.transaction(() => {
        db.prepare("DELETE FROM file_index").run();
        for (const f of result.files) ins.run(f.filePath,f.filename,f.folderName,f.relPath,f.parsedDate,f.parsedDirection,f.parsedPersonName,f.docType,f.ext);
      })();
      resolve({ indexed: result.files.length });
    });
    worker.on("error", err => { clearTimeout(timer); reject(err); });
  });
}

app.post("/api/admin/reindex", async (req, res) => {
  try {
    const result = await runReindex();
    res.json({ ok: true, indexed: result.indexed });
  } catch (e) {
    const status = /경로가 설정/.test(e.message) ? 400 : /시간 초과/.test(e.message) ? 408 : 500;
    res.status(status).json({ ok: false, error: e.message });
  }
});

// 어드민 통계: 접속 하트비트 수신
app.post("/api/admin/heartbeat", (req, res) => {
  try {
    const userName = (req.body && req.body.userName) ? String(req.body.userName).trim() : "";
    // 사용자를 식별할 수 없는 하트비트는 "알수없음"으로 남기지 않고 그냥 무시한다.
    if (userName) insertActivityLog.run("heartbeat", userName, 0, "/api/admin/heartbeat", null, null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 어드민 통계: 사용자별 일/월/연 접속시간 · 데이터 입력량
// 통계 집계 시작일 — 이전 테스트/오류 데이터(예: 깨진 사용자명)를 통계에서 배제하기 위한 기준일.
// 이 날짜 이전 데이터는 화면에 표시하지 않는다 (데이터 자체를 지우지는 않음).
const STATS_START_DATE = "2026-07-14 00:00:00";

// 채무자 필드 수정은 "썼다가 지운 값"이 그대로 누적되지 않도록, 기간 시작 시점 값과
// 종료 시점 값을 비교한 순변화량만 그 기간의 실질 입력량으로 센다 — 중간에 여러 번
// 고쳤어도 최종적으로 원래 값으로 돌아왔으면 0이 된다. 같은 필드를 그 기간 안에서
// 여러 사람이 건드렸다면, 마지막에 저장해 그 결과를 실제로 남긴 사람에게 순변화량
// 전체를 귀속한다(중간 편집자는 그 필드로는 0을 받는다 — 이 기간엔 그의 편집이
// 최종 결과에 남지 않았기 때문).
// 주요사항(key_notes)의 [채무자 및 연대보증인 종합분석] 마커 이후 블록은 AI가 생성한
// 텍스트라 사람이 "입력"한 게 아니다 — 그 부분만 바뀐 저장은 순변화량에 잡히면 안 되므로,
// 계산 전에 마커 이후를 잘라내고 마커 이전(직접 쓰는 기타사항)만 비교 대상으로 남긴다.
// (원본 debtor_edit_log 행 자체는 그대로 두므로 "최근 수정 내역"에서는 전체 내용을 그대로 볼 수 있다.)
function stripAiAnalysisBlock(fieldName, value) {
  // debtor_edit_log.field_name엔 DB 컬럼명(key_notes)이 아니라 프론트 JS 키(keyNotes)가
  // 저장된다(applyDebtorFieldPatch의 insLog.run(..., jsKey, ...) 참고) — "key_notes"로
  // 비교하면 항상 불일치라 이 함수가 실질적으로 아무것도 걸러내지 못하고 있었다.
  if (fieldName !== "keyNotes") return value ?? "";
  const v = value ?? "";
  const idx = v.indexOf(ANALYSIS_MARKER);
  return idx >= 0 ? v.slice(0, idx).trimEnd() : v;
}

function computeNetDebtorVolume(len) {
  const rows = db.prepare(`
    SELECT debtor_id, field_name, changed_by, changed_at, old_value, new_value
    FROM debtor_edit_log
    ORDER BY debtor_id, field_name, changed_at ASC, id ASC
  `).all().map(r => ({
    ...r,
    old_value: stripAiAnalysisBlock(r.field_name, r.old_value),
    new_value: stripAiAnalysisBlock(r.field_name, r.new_value),
  }));

  const groups = new Map();
  for (const r of rows) {
    const key = r.debtor_id + " " + r.field_name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const cutoff = STATS_START_DATE.slice(0, len);
  // 사용자명에 구분자로 쓸 문자가 섞여 있을 수 있어 문자열 결합 대신 배열 키로 안전하게 묶는다.
  const result = new Map(); // JSON.stringify([user, period]) -> { user, period, netChars }

  for (const seq of groups.values()) {
    let prevValue = seq[0].old_value ?? "";
    let curPeriod = null, curStartValue = prevValue, curEndValue = null, curLastEditor = null;

    const flush = () => {
      if (curPeriod == null || curPeriod < cutoff) return;
      if (!curLastEditor || curLastEditor === "알수없음" || hasReplacementChar(curLastEditor)) return;
      const netLen = Math.max(0, (curEndValue ?? "").length - (curStartValue ?? "").length);
      if (netLen <= 0) return;
      const key = JSON.stringify([curLastEditor, curPeriod]);
      const prev = result.get(key);
      if (prev) prev.netChars += netLen;
      else result.set(key, { user: curLastEditor, period: curPeriod, netChars: netLen });
    };

    for (const r of seq) {
      const period = r.changed_at.slice(0, len);
      if (period !== curPeriod) {
        flush();
        curPeriod = period;
        curStartValue = prevValue;
      }
      curEndValue = r.new_value ?? "";
      curLastEditor = r.changed_by;
      prevValue = r.new_value ?? "";
    }
    flush();
  }

  return result;
}

app.get("/api/admin/stats", (req, res) => {
  try {
    const BUCKET_LEN = { daily: 10, monthly: 7, yearly: 4 };
    // 헤더 인코딩이 깨져 들어온 요청이 "�" 섞인 사용자명으로 남는 경우가 있어(예: "�?�Ĵ�"),
    // 기록 시점에 거르는 것과 별개로 조회 시점에도 한 번 더 막아 화면에 이상 컬럼이 뜨지 않게 한다.
    const NOT_GARBLED = "user_name NOT LIKE ?";
    const garbledParam = "%�%";

    // 사용자를 식별 못한 요청은 애초에 기록 시점에 걸러내지만, 혹시 남는 게 있어도
    // 성과 통계 화면에는 절대 노출되지 않도록 조회 시점에도 한 번 더 막는다.
    const accessBuckets = (len) => db.prepare(`
      SELECT substr(ts,1,${len}) AS period, user_name AS user, COUNT(*) * 60 AS seconds
      FROM user_activity_log WHERE type='heartbeat' AND ts >= ? AND user_name != '알수없음' AND ${NOT_GARBLED}
      GROUP BY period, user
      ORDER BY period DESC
    `).all(STATS_START_DATE, garbledParam);

    // 채무자 필드 수정(/api/debtors/*)은 여기서 원본 바이트를 그대로 더하지 않는다 — "썼다가
    // 지운" 글자가 영구히 누적되는 문제가 있어, 대신 debtor_edit_log를 기간 시작~종료 값으로
    // 순변화량만 계산하는 computeNetDebtorVolume() 결과를 아래에서 합산한다.
    const volumeBuckets = (len) => {
      const rawRows = db.prepare(`
        SELECT substr(ts,1,${len}) AS period, user_name AS user, SUM(bytes) AS bytes
        FROM user_activity_log
        WHERE type='data_input' AND ts >= ? AND user_name != '알수없음' AND ${NOT_GARBLED} AND path NOT LIKE '/api/debtors/%'
        GROUP BY period, user
      `).all(STATS_START_DATE, garbledParam);

      const merged = new Map();
      for (const r of rawRows) merged.set(JSON.stringify([r.period, r.user]), { period: r.period, user: r.user, bytes: r.bytes || 0 });

      for (const { user, period, netChars } of computeNetDebtorVolume(len).values()) {
        const key = JSON.stringify([period, user]);
        const prev = merged.get(key);
        if (prev) prev.bytes += netChars;
        else merged.set(key, { period, user, bytes: netChars });
      }

      return [...merged.values()].sort((a, b) => b.period.localeCompare(a.period));
    };

    const access = { daily: accessBuckets(BUCKET_LEN.daily), monthly: accessBuckets(BUCKET_LEN.monthly), yearly: accessBuckets(BUCKET_LEN.yearly) };
    const volume = { daily: volumeBuckets(BUCKET_LEN.daily), monthly: volumeBuckets(BUCKET_LEN.monthly), yearly: volumeBuckets(BUCKET_LEN.yearly) };

    // To Do List 사용자별 등록/완료/삭제 건수 (todo_activity_log 기반)
    const todoBuckets = (len, action) => db.prepare(`
      SELECT substr(ts,1,${len}) AS period, user_name AS user, COUNT(*) AS count
      FROM todo_activity_log WHERE action = ? AND ts >= ? AND ${NOT_GARBLED}
      GROUP BY period, user
      ORDER BY period DESC
    `).all(action, STATS_START_DATE, garbledParam);
    const todo = {
      register: { daily: todoBuckets(BUCKET_LEN.daily, "등록"), monthly: todoBuckets(BUCKET_LEN.monthly, "등록"), yearly: todoBuckets(BUCKET_LEN.yearly, "등록") },
      complete: { daily: todoBuckets(BUCKET_LEN.daily, "완료"), monthly: todoBuckets(BUCKET_LEN.monthly, "완료"), yearly: todoBuckets(BUCKET_LEN.yearly, "완료") },
      remove:   { daily: todoBuckets(BUCKET_LEN.daily, "삭제"), monthly: todoBuckets(BUCKET_LEN.monthly, "삭제"), yearly: todoBuckets(BUCKET_LEN.yearly, "삭제") },
    };

    // "총 수정 건수"는 kv 저장(협의/TodoList/신용분석 등)과 채무자 PATCH를 합쳐 하나의
    // user_activity_log(data_input)만 보고 센다 — 두 저장 방식 모두 "저장 액션 1건 = 1행"으로
    // 통일되어 있어(PATCH /api/debtors/:id 핸들러 참고) debtor_edit_log를 따로 셀 필요가 없다.
    const dataInputSummary = db.prepare(`
      SELECT user_name AS user, COUNT(*) AS cnt, MAX(ts) AS lastAt
      FROM user_activity_log WHERE type='data_input' AND ts >= ? AND user_name != '알수없음' AND ${NOT_GARBLED} GROUP BY user_name
    `).all(STATS_START_DATE, garbledParam);
    const heartbeatSummary = db.prepare(`
      SELECT user_name AS user, MAX(ts) AS lastAt
      FROM user_activity_log WHERE type='heartbeat' AND ts >= ? AND user_name != '알수없음' AND ${NOT_GARBLED} GROUP BY user_name
    `).all(STATS_START_DATE, garbledParam);
    const summaryMap = new Map();
    const touch = (user, addCnt, lastAt) => {
      const cur = summaryMap.get(user) || { user, totalEdits: 0, lastActiveAt: null };
      cur.totalEdits += addCnt;
      if (lastAt && (!cur.lastActiveAt || lastAt > cur.lastActiveAt)) cur.lastActiveAt = lastAt;
      summaryMap.set(user, cur);
    };
    for (const r of dataInputSummary) touch(r.user, r.cnt, r.lastAt);
    for (const r of heartbeatSummary) touch(r.user, 0, r.lastAt);

    // 활동 로그가 하나도 없는 사용자도 "0건/활동 없음"으로 표시되도록, 등록된 전체
    // 사용자 목록(app_users)을 기준으로 빠진 사용자를 채워 넣는다 (LEFT JOIN과 동일한 효과).
    try {
      const appUsersRow = db.prepare("SELECT value FROM kv_store WHERE key='app_users'").get();
      const allUsers = appUsersRow ? JSON.parse(appUsersRow.value) : [];
      for (const u of allUsers) {
        const name = u && u.name;
        if (name && !summaryMap.has(name)) {
          summaryMap.set(name, { user: name, totalEdits: 0, lastActiveAt: null });
        }
      }
    } catch { /* app_users 파싱 실패 시 로그 기반 요약만 표시 */ }

    const summary = [...summaryMap.values()].sort((a, b) => (b.lastActiveAt || "").localeCompare(a.lastActiveAt || ""));

    res.json({ access, volume, todo, summary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 어드민 통계: 특정 사용자·기간의 접속시간이 "언제부터 언제까지"였는지 상세 조회
// (사용자별 접속시간 표의 칸 하나를 클릭했을 때 실제 구간을 보여주기 위함)
// 하트비트는 60초 간격 핑이라 실제 세션 시작/종료를 직접 기록하진 않는다 — 연속된
// 핑(간격 120초 이내) 묶음을 하나의 구간으로 보고, 그 구간의 길이는 (핑 개수 × 60초)로
// 계산한다. 이렇게 해야 여러 구간의 합이 표에 보이는 총 접속시간과 정확히 일치한다.
app.get("/api/admin/stats/access-detail", (req, res) => {
  try {
    const { user, period } = req.query;
    if (!user || !period) return res.status(400).json({ ok: false, error: "user, period가 필요합니다" });
    const len = String(period).length;
    const pings = db.prepare(`
      SELECT ts FROM user_activity_log
      WHERE type='heartbeat' AND user_name = ? AND substr(ts,1,${len}) = ?
      ORDER BY ts ASC
    `).all(user, period);

    const GAP_MS = 120 * 1000;
    const sessions = [];
    let cur = null;
    for (const { ts } of pings) {
      const t = new Date(ts.replace(" ", "T")).getTime();
      if (cur && t - cur.lastTs <= GAP_MS) {
        cur.count++;
        cur.lastTs = t;
      } else {
        if (cur) sessions.push(cur);
        cur = { startTs: t, lastTs: t, count: 1 };
      }
    }
    if (cur) sessions.push(cur);

    const fmt = (ms) => {
      const d = new Date(ms);
      const p2 = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    };
    const result = sessions.map(s => {
      const durationSec = s.count * 60;
      return { start: fmt(s.startTs), end: fmt(s.startTs + durationSec * 1000), minutes: Math.round(durationSec / 60) };
    }).sort((a, b) => b.start.localeCompare(a.start));

    res.json({ ok: true, sessions: result, totalMinutes: result.reduce((sum, s) => sum + s.minutes, 0) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 어드민 통계: 특정 사용자·기간의 입력량이 "무엇"이었는지 상세 조회
// (사용자별 데이터 입력량 표의 칸 하나를 클릭했을 때 실제 입력 내용을 보여주기 위함)
// period 길이로 일/월/연 단위를 판단한다: "YYYY-MM-DD"(10)/"YYYY-MM"(7)/"YYYY"(4).
app.get("/api/admin/stats/detail", (req, res) => {
  try {
    const { user, period } = req.query;
    if (!user || !period) return res.status(400).json({ ok: false, error: "user, period가 필요합니다" });
    const len = String(period).length;

    // 채무자 정보 수정은 debtor_edit_log에 필드 단위로 실제 변경 전/후 값이 남아있으므로
    // user_activity_log(액션 단위 바이트 합계)보다 이걸 그대로 보여주는 게 훨씬 구체적이다.
    // 순변화량 계산(computeNetDebtorVolume)과 마찬가지로 주요사항의 AI 종합분석 블록은
    // 사람이 "입력"한 게 아니므로 목록에서도 잘라내고, 그 결과 실제로 달라진 게 없는
    // 저장(순수 AI 재생성만 있던 저장)은 항목 자체를 보여주지 않는다.
    const debtorEdits = db.prepare(`
      SELECT debtor_id AS debtorId, debtor_name AS debtorName, field_name AS fieldName,
             field_label AS fieldLabel, old_value AS oldValue, new_value AS newValue, changed_at AS changedAt
      FROM debtor_edit_log
      WHERE changed_by = ? AND substr(changed_at,1,${len}) = ?
      ORDER BY changed_at DESC
      LIMIT 500
    `).all(user, period)
      .map(r => ({ ...r, oldValue: stripAiAnalysisBlock(r.fieldName, r.oldValue), newValue: stripAiAnalysisBlock(r.fieldName, r.newValue) }))
      .filter(r => r.oldValue !== r.newValue);

    // 그 외(kv 저장, 협의/추심의뢰/민사소송 등) 저장은 필드별 상세 로그가 없어 요청 경로와
    // 바이트만 보여준다 — /api/debtors/*로 시작하는 행은 위 debtorEdits로 이미 다뤘으므로 제외.
    // 목록은 500건까지만 보여주지만, 합계(otherActivityBytesTotal)는 전체를 다시 SUM해서 구한다 —
    // 안 그러면 500건 넘게 저장한 기간엔 목록에서 보이는 것만 더한 합계가 실제 표 숫자보다
    // 작게 나와서 "왜 숫자가 안 맞냐"는 혼동이 생긴다.
    const otherActivity = db.prepare(`
      SELECT path, bytes, ts, ref_debtor_id AS refDebtorId, detail
      FROM user_activity_log
      WHERE type='data_input' AND user_name = ? AND substr(ts,1,${len}) = ? AND path NOT LIKE '/api/debtors/%'
      ORDER BY ts DESC
      LIMIT 500
    `).all(user, period);
    const { total: otherActivityBytesTotal, cnt: otherActivityCount } = db.prepare(`
      SELECT COALESCE(SUM(bytes),0) AS total, COUNT(*) AS cnt
      FROM user_activity_log
      WHERE type='data_input' AND user_name = ? AND substr(ts,1,${len}) = ? AND path NOT LIKE '/api/debtors/%'
    `).get(user, period);

    // debtorEdits는 이 사용자가 그 기간에 "시도한" 모든 저장을 그대로 보여주지만, 통계 표의
    // 칸 숫자는 기간 시작~종료 값을 비교한 순변화량이라 서로 다를 수 있다 — 두 숫자를 같이
    // 내려줘서 왜 차이가 나는지(썼다가 지운 부분) 화면에서 바로 설명할 수 있게 한다.
    const netEntry = computeNetDebtorVolume(len).get(JSON.stringify([user, period]));
    const debtorEditsNetChars = netEntry ? netEntry.netChars : 0;
    // 통계 표 칸에 실제로 보이는 숫자와 정확히 같은 값 — volumeBuckets()가 계산하는 것과
    // 동일한 두 항목(순변화량 + 기타 저장 합계)의 합.
    const totalNetChars = debtorEditsNetChars + (otherActivityBytesTotal || 0);

    res.json({ ok: true, debtorEdits, debtorEditsNetChars, otherActivity, otherActivityBytesTotal: otherActivityBytesTotal || 0, otherActivityCount, totalNetChars });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 어드민 통계: "기타 저장" 목록의 저장 위치(API 경로)를 실제 화면(채무자 상세)으로 역추적
// path에 분할상환 일정/플랜 id가 들어있는 경우만 해당 id로 소유 채무자를 찾아 이동시킨다 —
// batch/일괄 처리처럼 경로에 개별 id가 없는 요청은 어느 채무자 것인지 특정할 수 없어 대상에서 제외.
app.get("/api/admin/resolve-path", (req, res) => {
  try {
    const p = String(req.query.path || "");
    let row = null;
    let m;
    if ((m = p.match(/^\/api\/installments\/schedules\/([^/]+)(?:\/(?:rollover|memo))?$/))) {
      row = db.prepare(`
        SELECT d.id AS debtorId, d.name AS debtorName
        FROM installment_schedules s
        JOIN installment_plans ip ON s.plan_id = ip.id
        JOIN debtors d ON d.id = ip.debtor_id
        WHERE s.id = ?
      `).get(m[1]);
    } else if ((m = p.match(/^\/api\/installments\/([^/]+)(?:\/schedules)?$/)) && m[1] !== "schedules") {
      row = db.prepare(`
        SELECT d.id AS debtorId, d.name AS debtorName
        FROM installment_plans ip
        JOIN debtors d ON d.id = ip.debtor_id
        WHERE ip.id = ?
      `).get(m[1]);
    } else if ((m = p.match(/^\/api\/kv\/hist_[med]_(.+)$/))) {
      // hist_m_/hist_e_/hist_d_{debtorId} — 채무자 "히스토리" 탭 저장 키는 debtorId가 그대로
      // 키 안에 들어있어 별도 조회 없이 바로 매핑 가능
      row = db.prepare("SELECT id AS debtorId, name AS debtorName FROM debtors WHERE id = ?").get(m[1]);
      if (row) return res.json({ ok: true, debtorId: row.debtorId, debtorName: row.debtorName, tab: "히스토리" });
    }
    if (!row) return res.json({ ok: false });
    res.json({ ok: true, debtorId: row.debtorId, debtorName: row.debtorName, tab: "분할상환" });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 어드민 통계 진단용: "알수없음"/특정 사용자로 잡힌 원본 요청을 개별적으로 확인
// (집계된 합계만으로는 어느 요청이 왜 그 사용자/바이트로 잡혔는지 추적할 수 없어 추가)
app.get("/api/admin/activity-log", (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
    const where = [];
    const params = [];
    if (req.query.user) { where.push("user_name = ?"); params.push(req.query.user); }
    if (req.query.date) { where.push("substr(ts,1,10) = ?"); params.push(req.query.date); }
    const rows = db.prepare(`
      SELECT type, user_name AS user, bytes, path, ts
      FROM user_activity_log
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY ts DESC
      LIMIT ?
    `).all(...params, limit);
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
    const kwParam  = req.query.keywords || req.query.keyword || "";
    const keywords = kwParam.split(",").map(k => k.trim().toLowerCase()).filter(Boolean);

    // 인덱스가 있으면 DB에서 조회 (빠름), 없으면 실시간 스캔 (느림)
    const indexCount = db.prepare("SELECT COUNT(*) as c FROM file_index").get();
    if (indexCount.c > 0) {
      return res.json(findCandidatesFromIndex(debtor.name, guarantors, minScore, keywords));
    }

    let result = fileScanner.findCandidates(rootRow.value, debtor.name, guarantors, minScore);
    if (result.ok && keywords.length > 0) {
      result.candidates = result.candidates.filter(c => {
        const fn = c.filename.toLowerCase();
        const dt = (c.docType || "").toLowerCase();
        return keywords.some(kw => fn.includes(kw) || dt.includes(kw));
      });
    }
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

// OneDrive 스캔으로 못 찾는 서류(다른 경로에 있거나 아직 스캔 안 된 파일)를 사용자가
// 직접 업로드해서 연결할 수 있게 한다. 저장 위치는 스캔 루트 폴더 밑 "_직접등록"
// 폴더로 고정 — /api/file-stream이 루트 경로 밖의 파일은 열어주지 않기 때문에,
// 업로드한 파일도 같은 방식으로(열기/스트리밍) 볼 수 있으려면 루트 안에 있어야 한다.
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const rootRow = db.prepare("SELECT value FROM kv_store WHERE key='docs_scan_root'").get();
      if (!rootRow || !rootRow.value) return cb(new Error("스캔 폴더 경로가 설정되지 않았습니다. 관리자 > 시스템 설정 > 서류 폴더 에서 지정해주세요."));
      const debtor = db.prepare("SELECT id, name FROM debtors WHERE id = ?").get(req.params.debtorId);
      if (!debtor) return cb(new Error("채무자 없음"));
      const dir = path.join(rootRow.value, "_직접등록", `${debtor.name}(${debtor.id})`);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    } catch (e) { cb(e); }
  },
  filename: (req, file, cb) => {
    // 멀티파트 파일명은 브라우저가 UTF-8로 보내지만 busboy가 기본적으로 latin1로
    // 디코딩해서 한글이 깨진다 — 표준 우회법으로 다시 utf8로 복원한다.
    const original = Buffer.from(file.originalname, "latin1").toString("utf8");
    const safeName = path.basename(original).replace(/[\\/:*?"<>|]/g, "_");
    cb(null, `${Date.now()}_${safeName}`);
  },
});
const upload = multer({ storage: uploadStorage, limits: { fileSize: 100 * 1024 * 1024 } });

// 서류 직접 업로드 + 연결 (OneDrive 스캔 후보에 없는 서류를 사용자가 파일로 올릴 때 사용)
app.post("/api/documents/:debtorId/upload", (req, res) => {
  upload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message });
    if (!req.file) return res.status(400).json({ ok: false, error: "파일이 없습니다" });
    try {
      const fileName = Buffer.from(req.file.originalname, "latin1").toString("utf8");
      db.prepare(`
        INSERT INTO debtor_documents (debtor_id, file_path, file_name, doc_label, match_type, matched_name, linked_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(req.params.debtorId, req.file.path, fileName, "직접등록", "manual", null, req.body.linkedBy || null);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
});

// 파일 스트리밍 (보안: 설정된 루트 경로 내부만 허용)
app.get("/api/file-stream", (req, res) => {
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

// ─── 주민등록번호 자동 추출 (초본 PDF → Python Windows OCR) ──
const { spawn } = require("child_process");
const OCR_SCRIPT = path.join(__dirname, "ocr_resident.py");
const OCR_CREDIT_SCRIPT = path.join(__dirname, "ocr_credit_score.py");
const OCR_SUBROGATION_SCRIPT = path.join(__dirname, "ocr_subrogation_date.py");
const OCR_ADDRESS_SCRIPT = path.join(__dirname, "ocr_credit_address.py");
const OCR_DOCUMENT_SCRIPT = path.join(__dirname, "ocr_document_text.py");

// pythonw.exe = GUI subsystem, never opens a console window.
// 절대경로로 고정하지 않고 PATH에서 찾는다 — 서버 PC의 사용자 계정/파이썬 설치 위치가
// 바뀌어도(예: hjbae → buser) 코드 수정 없이 동작하도록. PATH에 없으면 PYTHON_BIN
// 환경변수(backend/.env)로 절대경로를 지정할 수 있다.
const PYTHON_BIN = process.env.PYTHON_BIN || "pythonw.exe";

// OCR(pythonw.exe)는 CPU를 많이 써서, 배치(전체 채무자 주소 추출 등)와 화면에서 직접 여는
// 개별 조회가 서로 아무 제약 없이 각자 pythonw.exe를 띄우면 서버 PC가 감당 못 하고 전부
// 같이 느려진다(체감상 "조회 중..."이 끝없이 이어짐). 모든 OCR 호출이 이 슬롯을 거치게 해서
// 전체 동시 실행 개수를 하나로 통제하고, 화면에서 직접 연 조회(priority="high")는 배치
// 작업(priority="low")보다 항상 먼저 슬롯을 받도록 큐 앞쪽에 끼워준다.
const OCR_MAX_CONCURRENT = 3;
let ocrActiveCount = 0;
const ocrHighQueue = [];
const ocrLowQueue = [];
function ocrSlotRelease() {
  ocrActiveCount--;
  const next = ocrHighQueue.shift() || ocrLowQueue.shift();
  if (next) { ocrActiveCount++; next(); }
}
function withOcrSlot(fn, priority) {
  return new Promise((resolve, reject) => {
    const run = () => { fn().then(resolve, reject).finally(ocrSlotRelease); };
    if (ocrActiveCount < OCR_MAX_CONCURRENT) { ocrActiveCount++; run(); }
    else (priority === "low" ? ocrLowQueue : ocrHighQueue).push(run);
  });
}

function spawnOcr(script, pdfPath, timeout) {
  return new Promise((resolve) => {
    const proc = spawn(PYTHON_BIN, [script, pdfPath], { timeout, windowsHide: true });
    let out = "", err = ""; // err: 임시 디버그용 stderr 캡처 — 원인 확인되면 제거할 것
    proc.stdout.on("data", d => { out += d.toString(); });
    proc.stderr.on("data", d => { err += d.toString(); });
    proc.on("close", () => {
      try { resolve({ ...JSON.parse(out.trim()), _stderr: err }); } catch { resolve({ ok: false, _stderr: err }); }
    });
    proc.on("error", () => resolve({ ok: false, _stderr: err }));
  });
}

function ocrPdfForResident(pdfPath, priority) {
  // 주소이력표 파싱 때문에 최대 6페이지까지 OCR. Windows OCR(winrt) 기준이라 여유를 둔다.
  return withOcrSlot(() => spawnOcr(OCR_SCRIPT, pdfPath, 150000), priority);
}

function ocrPdfForSubrogationDate(pdfPath, priority) {
  return withOcrSlot(() => spawnOcr(OCR_SUBROGATION_SCRIPT, pdfPath, 90000), priority);
}

function ocrPdfForCreditScore(pdfPath, priority) {
  return withOcrSlot(() => spawnOcr(OCR_CREDIT_SCRIPT, pdfPath, 90000), priority);
}

function ocrPdfForCreditAddress(pdfPath, priority) {
  // 자택정보이력표(보통 3페이지)까지 스캔. Windows OCR(winrt) 기준이라 여유를 둔다.
  return withOcrSlot(() => spawnOcr(OCR_ADDRESS_SCRIPT, pdfPath, 150000), priority);
}

function ocrPdfForDocument(pdfPath, priority) {
  // 문건 분석: 스캔본(이미지) PDF의 전체 텍스트 추출. 최대 30페이지라 다른 OCR보다 오래 걸릴 수 있어 여유를 크게 둔다.
  return withOcrSlot(() => spawnOcr(OCR_DOCUMENT_SCRIPT, pdfPath, 240000), priority);
}

function korName3(name) {
  const kor = String(name || "").replace(/[^가-힣]/g, "");
  return kor.length >= 2 ? kor.slice(0, 3) : null;
}

// 이름이 완전히 같은 다른 채무자가 이미 있으면(동명이인), 이름만으로 찾은 문서가
// 사실은 그 동명이인의 것일 수 있다 — 실제로 신규 등록한 채무자에게 기존 동명이인의
// 주민등록번호가 자동으로 잘못 채워져 저장된 사례가 있었다. 이 경우엔 자동추출 결과를
// DB에 써넣지 않고(화면에만 "확인 필요"로 보여주고) 사람이 직접 확인해서 입력하게 한다.
function hasNameCollision(debtorId, name) {
  if (!name) return false;
  const row = db.prepare("SELECT 1 FROM debtors WHERE name = ? AND id != ? LIMIT 1").get(name, debtorId);
  return !!row;
}

// 사람이 "동명이인 데이터"라고 직접 확인해서 제외 처리한 항목인지 확인.
// field: "cb"(신용조회) | "resident"(초본) — 채무자 본인 기준.
function isNameMatchExcluded(debtorId, field) {
  const col = field === "cb" ? "cb_match_excluded" : "resident_match_excluded";
  const row = db.prepare(`SELECT ${col} AS v FROM debtors WHERE id = ?`).get(debtorId);
  return !!(row && row.v);
}

// 연대보증인 버전 — debtor_guarantors 행 id 기준(이름이 아니라 행으로 구분해야
// 같은 채무자에게 동명 연대보증인이 두 명 등록된 경우에도 안전하다).
function isGuarantorMatchExcluded(guarantorId, field) {
  const col = field === "cb" ? "cb_match_excluded" : "resident_match_excluded";
  const row = db.prepare(`SELECT ${col} AS v FROM debtor_guarantors WHERE id = ?`).get(guarantorId);
  return !!(row && row.v);
}

// 이름으로 CB(신용정보) 보고서 PDF를 찾아 OCR로 점수를 추출.
// /api/debtor/:id/credit-score 화면 표시와 AI 종합분석(연대보증인 신용점수)이 각자
// 따로 검색하다가 서로 다른 값을 보여주던 문제가 있어 이 함수로 통합했다.
// 이름이 완전히 일치하는 파일이 있으면 그것만 쓰고, 하나도 없을 때만 앞 2~3글자
// 부분일치로 넓혀서 찾는다 — 동명이인(다른 사람)의 CB 파일이 잘못 매칭되는 걸 줄이기 위함.
async function findCreditScoreForName(name, limit, priority) {
  if (!name) return null;
  const CB_FILTER = `(LOWER(doc_type) LIKE '%cb%' OR LOWER(filename) LIKE '%cb%' OR LOWER(filename) LIKE '%신용%') AND ext = 'pdf'`;

  let rows = db.prepare(
    `SELECT file_path, filename, parsed_person_name FROM file_index
     WHERE parsed_person_name = ? AND ${CB_FILTER}
     ORDER BY parsed_date DESC LIMIT ?`
  ).all(name, limit);

  let fuzzy = false;
  if (rows.length === 0) {
    const kor = korName3(name);
    if (!kor) return null;
    fuzzy = true;
    rows = db.prepare(
      `SELECT file_path, filename, parsed_person_name FROM file_index
       WHERE (parsed_person_name LIKE ? OR filename LIKE ?) AND ${CB_FILTER}
       ORDER BY parsed_date DESC LIMIT ?`
    ).all(`%${kor}%`, `%${kor}%`, limit);
  }

  // 이름이 완전히 일치하는 파일이 하나도 없어 앞 2~3글자 부분일치로 넓힌 경우에만 해당 —
  // 후보 중 실제로 파싱된 이름(parsed_person_name)이 검색 대상과 "다른" 값으로 확인된 게
  // 있으면, 동명이인(다른 사람)의 CB 파일이 섞여 들어왔다는 뚜렷한 신호다. 이 경우 점수를
  // 자신 있게 하나 골라 보여주면 위험하므로 ambiguous 플래그를 같이 내려서, 화면/AI
  // 종합분석 양쪽 모두 "확인 필요"로 표시하고 그 점수를 근거로 단정하지 않게 한다.
  const ambiguous = fuzzy && rows.some(r => r.parsed_person_name && r.parsed_person_name !== name);

  for (const c of rows) {
    const r = await ocrPdfForCreditScore(c.file_path, priority);
    if (r.ok && r.score) return { score: r.score, filename: c.filename, ambiguous };
  }
  return null;
}

// 초본에서 최근 주소/등록일/비고/발급일을 찾아 비어있는 컬럼만 채운다.
// (예전 로직이 잘못 저장해둔 값은 덮어쓰지 않으므로, 그걸 고치려면 먼저 컬럼을 비워야 한다 — /resident-number/refresh 참고)
async function lookupResidentDetails(debtorId, debtor, priority) {
  if (isNameMatchExcluded(debtorId, "resident")) return { ok: false, excluded: true, error: "동명이인으로 제외됨" };
  const kor = korName3(debtor.name);
  if (!kor) return { ok: false, error: "이름 인식 불가" };
  const ambiguous = hasNameCollision(debtorId, debtor.name);

  // 후보 파일을 5개→2개로 줄임 — 파일마다 OCR이 실패하면 타임아웃까지 기다려야 해서,
  // 배치로 여러 채무자를 순회할 때 후보를 다 시도하면 한 명당 최악의 경우 너무 오래 걸린다.
  // 보통 가장 최근 파일에서 바로 성공하므로 2개면 충분하고, 그래도 실패하면 상세화면의
  // "재조회"로 다시 시도할 수 있다.
  const rows = db.prepare(
    `SELECT file_path, filename, parsed_date FROM file_index
     WHERE (parsed_person_name LIKE ? OR filename LIKE ?)
     AND (doc_type LIKE '%초본%' OR filename LIKE '%초본%')
     AND ext = 'pdf'
     ORDER BY parsed_date DESC LIMIT 2`
  ).all(`%${kor}%`, `%${kor}%`);

  for (const c of rows) {
    const r = await ocrPdfForResident(c.file_path, priority);
    if (!r.address && !r.registeredDate) continue;

    const updates = [], vals = [];
    if (!debtor.resident_number && r.number) { updates.push("resident_number = ?"); vals.push(r.number); }
    if (!debtor.resident_address && r.address) {
      updates.push("resident_address = ?", "resident_address_lat = NULL", "resident_address_lng = NULL", "resident_source_date = ?");
      vals.push(r.address, c.parsed_date || null);
    }
    if (!debtor.resident_registered_date && r.registeredDate) { updates.push("resident_registered_date = ?"); vals.push(r.registeredDate); }
    if (!debtor.resident_note && r.note) { updates.push("resident_note = ?"); vals.push(r.note); }
    if (!debtor.resident_issued_date && r.issuedDate) { updates.push("resident_issued_date = ?"); vals.push(r.issuedDate); }
    if (updates.length && !ambiguous) {
      db.prepare(`UPDATE debtors SET ${updates.join(", ")} WHERE id = ?`).run(...vals, debtorId);
    }

    return {
      ok: true,
      address: debtor.resident_address || (ambiguous ? null : r.address) || null,
      registeredDate: debtor.resident_registered_date || (ambiguous ? null : r.registeredDate) || null,
      note: debtor.resident_note || (ambiguous ? null : r.note) || null,
      issuedDate: debtor.resident_issued_date || (ambiguous ? null : r.issuedDate) || null,
      filename: c.filename,
      ambiguous,
    };
  }

  return { ok: false, address: debtor.resident_address || null, error: "초본 인식 실패" };
}

app.get("/api/debtor/:id/resident-number", async (req, res) => {
  try {
    const debtor = db.prepare(
      `SELECT d.name, d.resident_number, d.resident_match_excluded,
              d.resident_address, d.resident_registered_date, d.resident_note, d.resident_issued_date
       FROM debtors d WHERE d.id = ?`
    ).get(req.params.id);
    if (!debtor) return res.json({ ok: false, entries: [], residentDetails: null });
    const guarantorRows = db.prepare("SELECT id, name, resident_match_excluded FROM debtor_guarantors WHERE debtor_id = ?").all(req.params.id);

    const entries = [];
    let residentDetails = null;

    if (debtor.resident_match_excluded) {
      // 사람이 "동명이인 데이터"라고 확인해서 제외한 상태 — 자동조회를 건너뛰고
      // 화면에는 "제외됨" + 다시 포함할 수 있는 상태만 표시한다.
      entries.push({ name: debtor.name, number: null, source: "excluded", excluded: true, target: "self" });
    } else {
      const ambiguous = hasNameCollision(req.params.id, debtor.name);

      // 주채무자 — 주민등록번호 + 최근주소/등록일/비고/발급일 (같은 초본 1회 OCR로 함께 추출)
      const detailsComplete = !!(debtor.resident_address && debtor.resident_registered_date && debtor.resident_issued_date);
      if (debtor.resident_number && detailsComplete) {
        entries.push({ name: debtor.name, number: debtor.resident_number, source: "db", target: "self" });
        residentDetails = {
          address: debtor.resident_address, registeredDate: debtor.resident_registered_date,
          note: debtor.resident_note, issuedDate: debtor.resident_issued_date,
        };
      } else {
        const kor = korName3(debtor.name);
        if (kor) {
          const rows = db.prepare(
            `SELECT file_path, filename, parsed_date FROM file_index
             WHERE (parsed_person_name LIKE ? OR filename LIKE ?)
             AND (doc_type LIKE '%초본%' OR filename LIKE '%초본%')
             AND ext = 'pdf'
             ORDER BY parsed_date DESC LIMIT 5`
          ).all(`%${kor}%`, `%${kor}%`);
          for (const c of rows) {
            const r = await ocrPdfForResident(c.file_path);
            const gotNumber = r.ok && r.number;
            const gotDetails = r.address || r.registeredDate;
            if (!gotNumber && !gotDetails) continue;

            if (gotNumber) entries.push({ name: debtor.name, number: r.number, source: "ocr", filename: c.filename, ambiguous, target: "self" });

            // 이미 DB에 있는 값은 덮어쓰지 않고, 비어있는 컬럼만 채운다 — 단, 동명이인이 있으면
            // 이 문서가 그 사람 것일 수 있어 DB에는 쓰지 않고 화면에만 "확인 필요"로 보여준다.
            const updates = [], vals = [];
            if (!ambiguous) {
              if (!debtor.resident_number && r.number) { updates.push("resident_number = ?"); vals.push(r.number); }
              if (!debtor.resident_address && r.address) { updates.push("resident_address = ?", "resident_source_date = ?"); vals.push(r.address, c.parsed_date || null); }
              if (!debtor.resident_registered_date && r.registeredDate) { updates.push("resident_registered_date = ?"); vals.push(r.registeredDate); }
              if (!debtor.resident_note && r.note) { updates.push("resident_note = ?"); vals.push(r.note); }
              if (!debtor.resident_issued_date && r.issuedDate) { updates.push("resident_issued_date = ?"); vals.push(r.issuedDate); }
            }
            if (updates.length) {
              db.prepare(`UPDATE debtors SET ${updates.join(", ")} WHERE id = ?`).run(...vals, req.params.id);
            }

            residentDetails = {
              address: debtor.resident_address || (ambiguous ? null : r.address) || null,
              registeredDate: debtor.resident_registered_date || (ambiguous ? null : r.registeredDate) || null,
              note: debtor.resident_note || (ambiguous ? null : r.note) || null,
              issuedDate: debtor.resident_issued_date || (ambiguous ? null : r.issuedDate) || null,
              ambiguous,
            };
            if (gotNumber) break; // 번호까지 찾았으면 더 오래된 파일은 볼 필요 없음
          }
        }
        if (!entries.length && debtor.resident_number) {
          entries.push({ name: debtor.name, number: debtor.resident_number, source: "db", target: "self" });
        }
        if (!residentDetails && detailsComplete) {
          residentDetails = {
            address: debtor.resident_address, registeredDate: debtor.resident_registered_date,
            note: debtor.resident_note, issuedDate: debtor.resident_issued_date,
          };
        }
      }
    }

    // 연대보증인
    for (const g of guarantorRows) {
      if (g.resident_match_excluded) {
        entries.push({ name: g.name, number: null, source: "excluded", excluded: true, target: "guarantor", guarantorId: g.id });
        continue;
      }
      const kor = korName3(g.name);
      if (!kor) continue;
      // 이 연대보증인과 이름이 같은 다른 채무자가 이미 있으면(동명이인), 아래에서 이름만으로
      // 찾은 초본이 사실 그 사람 것일 수 있다 — 주채무자 항목과 동일하게 경고를 붙인다.
      const gAmbiguous = hasNameCollision(req.params.id, g.name);
      const rows = db.prepare(
        `SELECT file_path, filename FROM file_index
         WHERE (parsed_person_name LIKE ? OR filename LIKE ?)
         AND (doc_type LIKE '%초본%' OR filename LIKE '%초본%')
         AND ext = 'pdf'
         ORDER BY parsed_date DESC LIMIT 3`
      ).all(`%${kor}%`, `%${kor}%`);
      for (const c of rows) {
        const r = await ocrPdfForResident(c.file_path);
        if (r.ok && r.number) { entries.push({ name: g.name, number: r.number, source: "ocr", filename: c.filename, ambiguous: gAmbiguous, target: "guarantor", guarantorId: g.id }); break; }
      }
    }

    res.json({ ok: true, entries, residentDetails });
  } catch (e) { res.status(500).json({ ok: false, entries: [], residentDetails: null, error: e.message }); }
});

// 예전 OCR 로직으로 잘못 저장된 초본상 최근주소/등록일/비고/발급일을 지우고 최신 스크립트로 다시 추출한다.
// (주민등록번호는 그대로 둔다 — 이 문제와 무관하게 이미 맞는 경우가 대부분이라 건드리지 않음)
app.post("/api/debtor/:id/resident-number/refresh", async (req, res) => {
  try {
    const existing = db.prepare("SELECT id, name, resident_number FROM debtors WHERE id = ?").get(req.params.id);
    if (!existing) return res.json({ ok: false, error: "채무자 없음" });

    db.prepare(
      `UPDATE debtors SET resident_address = NULL, resident_address_lat = NULL, resident_address_lng = NULL,
              resident_registered_date = NULL, resident_note = NULL, resident_issued_date = NULL,
              resident_source_date = NULL WHERE id = ?`
    ).run(existing.id);

    const debtor = {
      name: existing.name, resident_number: existing.resident_number,
      resident_address: null, resident_registered_date: null, resident_note: null, resident_issued_date: null,
    };
    const result = await lookupResidentDetails(existing.id, debtor);
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── 신용점수 자동 추출 (CB종합보고서 PDF → Python Windows OCR) ──
app.get("/api/debtor/:id/credit-score", async (req, res) => {
  try {
    const debtor = db.prepare("SELECT d.name, d.credit_grade, d.cb_match_excluded FROM debtors d WHERE d.id = ?").get(req.params.id);
    if (!debtor) return res.json({ ok: false, entries: [] });
    const guarantorRows = db.prepare("SELECT id, name, cb_match_excluded FROM debtor_guarantors WHERE debtor_id = ?").all(req.params.id);

    const entries = [];

    if (debtor.cb_match_excluded) {
      entries.push({ name: debtor.name, score: null, source: "excluded", excluded: true, target: "self" });
    } else {
      const ambiguous = hasNameCollision(req.params.id, debtor.name);
      // 주채무자 — OCR로 찾은 점수를 DB에도 저장해둔다(예전엔 화면에만 잠깐 띄우고 저장을 안 해서,
      // AI 종합분석이 읽는 credit_grade 컬럼은 항상 비어있어 "확인 필요"로만 나오던 문제가 있었다).
      // 이미 값이 있으면(수동 입력 등) 덮어쓰지 않는다. 동명이인이 있으면(다른 채무자와 이름이
      // 같으면) 이 CB 파일이 그 사람 것일 수 있어 DB에는 저장하지 않고 화면에만 표시한다.
      const mainResult = await findCreditScoreForName(debtor.name, 5);
      if (mainResult) {
        entries.push({ name: debtor.name, ...mainResult, source: "ocr", ambiguous: mainResult.ambiguous || ambiguous, target: "self" });
        if (!debtor.credit_grade && !ambiguous) {
          db.prepare("UPDATE debtors SET credit_grade = ? WHERE id = ?").run(String(mainResult.score), req.params.id);
        }
      }
    }

    // 연대보증인
    for (const g of guarantorRows) {
      if (g.cb_match_excluded) {
        entries.push({ name: g.name, score: null, source: "excluded", excluded: true, target: "guarantor", guarantorId: g.id });
        continue;
      }
      const r = await findCreditScoreForName(g.name, 5);
      if (r) {
        // 이 연대보증인과 이름이 같은 다른 채무자가 이미 있으면(동명이인), 완전일치로 찾은
        // CB 파일이라도 사실 그 사람 것일 수 있다 — 주채무자 항목과 동일하게 경고를 붙인다.
        const gAmbiguous = r.ambiguous || hasNameCollision(req.params.id, g.name);
        entries.push({ name: g.name, ...r, ambiguous: gAmbiguous, source: "ocr", target: "guarantor", guarantorId: g.id });
      }
    }

    res.json({ ok: true, entries });
  } catch (e) { res.status(500).json({ ok: false, entries: [], error: e.message }); }
});

// 이름만으로 찾은 CB/초본 데이터가 동명이인(다른 사람) 것이라고 사람이 직접 확인했을 때
// 켜고 끄는 스위치. 켜면(excluded=true) 해당 항목의 이름매칭 자동조회/표시를 끄고,
// 꺼도(excluded=false) 되돌릴 수 있도록 기존 DB 값은 지우지 않고 그대로 둔다.
// guarantorId를 안 보내면 채무자 본인 기준, 보내면 그 연대보증인(행 id) 기준으로 처리한다.
app.post("/api/debtor/:id/name-match-exclude", (req, res) => {
  try {
    const { field, excluded, guarantorId } = req.body;
    if (field !== "cb" && field !== "resident") return res.status(400).json({ ok: false, error: "field는 cb 또는 resident여야 합니다" });
    const col = field === "cb" ? "cb_match_excluded" : "resident_match_excluded";
    const val = excluded ? 1 : 0;

    if (guarantorId) {
      const row = db.prepare("SELECT id FROM debtor_guarantors WHERE id = ? AND debtor_id = ?").get(guarantorId, req.params.id);
      if (!row) return res.status(404).json({ ok: false, error: "연대보증인을 찾을 수 없습니다" });
      db.prepare(`UPDATE debtor_guarantors SET ${col} = ? WHERE id = ?`).run(val, guarantorId);
    } else {
      const row = db.prepare("SELECT id FROM debtors WHERE id = ?").get(req.params.id);
      if (!row) return res.status(404).json({ ok: false, error: "채무자를 찾을 수 없습니다" });
      db.prepare(`UPDATE debtors SET ${col} = ? WHERE id = ?`).run(val, req.params.id);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── 최신 주소지 자동 추출 (CB종합보고서 PDF → Python Windows OCR) ──
// 채무자 위치 지도에 쓸 주소라서 연대보증인은 대상에서 제외하고 주채무자만 추출한다.
// 추출에 성공하면 DB에 저장해서(latest_address) 다음부터는 OCR을 다시 돌리지 않고 캐시를 쓴다.
// debtor 행에 이미 값이 있는 컬럼은 절대 덮어쓰지 않고, 비어있는 컬럼만 골라서 채운다 —
// 그래서 예전(수정 전) OCR 로직이 잘못 저장해둔 값은 이 함수만으로는 고쳐지지 않는다.
// 잘못된 캐시를 다시 뽑으려면 먼저 해당 컬럼을 비워야 하고, 그건 /credit-address/refresh가 한다.
async function lookupCreditAddress(debtor, priority) {
  if (isNameMatchExcluded(debtor.id, "cb")) return { ok: false, excluded: true, error: "동명이인으로 제외됨" };
  const kor = korName3(debtor.name);
  if (!kor) return { ok: false, error: "이름 인식 불가" };
  const ambiguous = hasNameCollision(debtor.id, debtor.name);

  // 후보 파일을 5개→2개로 줄임 (사유는 lookupResidentDetails 주석 참고)
  const rows = db.prepare(
    `SELECT file_path, filename, parsed_date FROM file_index
     WHERE (parsed_person_name LIKE ? OR filename LIKE ?)
     AND (LOWER(doc_type) LIKE '%cb%' OR LOWER(filename) LIKE '%cb%' OR LOWER(filename) LIKE '%신용%')
     AND ext = 'pdf'
     ORDER BY parsed_date DESC LIMIT 2`
  ).all(`%${kor}%`, `%${kor}%`);

  const _debugAttempts = []; // 임시 디버그 — 추출 실패 원인 파악용 (원인 확인되면 제거할 것)
  let noHistoryResult = null;
  for (const c of rows) {
    const r = await ocrPdfForCreditAddress(c.file_path, priority);
    _debugAttempts.push({ filename: c.filename, debug: r.debug || null, ocrError: r.error || null, stderr: r._stderr || null });
    if (r.noHistory) {
      // 가장 최근 CB보고서가 "자택정보이력 0건"이라고 명시하면, 그보다 오래된 보고서로
      // 넘어가지 않는다 — 더 오래된 보고서의 이력을 잘못 캐치는 것보다 "없음"이 안전하다.
      const noHistUpdates = [], noHistVals = [];
      if (!ambiguous) {
        if (!debtor.credit_phone && r.phone) { noHistUpdates.push("credit_phone = ?"); noHistVals.push(r.phone); }
        if (!debtor.credit_queried_date && r.queriedDate) { noHistUpdates.push("credit_queried_date = ?"); noHistVals.push(r.queriedDate); }
      }
      if (noHistUpdates.length) db.prepare(`UPDATE debtors SET ${noHistUpdates.join(", ")} WHERE id = ?`).run(...noHistVals, debtor.id);
      noHistoryResult = { ok: false, address: debtor.latest_address || null, phone: debtor.credit_phone || (ambiguous ? null : r.phone) || null, queriedDate: debtor.credit_queried_date || (ambiguous ? null : r.queriedDate) || null, error: "CB보고서에 자택정보이력 없음", filename: c.filename, ambiguous };
      break;
    }
    if (!r.address && !r.phone) continue;

    const updates = [], vals = [];
    if (!ambiguous) {
      if (!debtor.latest_address && r.address) {
        updates.push("latest_address = ?", "latest_address_lat = NULL", "latest_address_lng = NULL", "latest_address_updated_at = datetime('now','localtime')", "credit_source_date = ?");
        vals.push(r.address, c.parsed_date || null);
      }
      if (!debtor.credit_phone && r.phone) { updates.push("credit_phone = ?"); vals.push(r.phone); }
      if (!debtor.credit_queried_date && r.queriedDate) { updates.push("credit_queried_date = ?"); vals.push(r.queriedDate); }
    }
    if (updates.length) {
      db.prepare(`UPDATE debtors SET ${updates.join(", ")} WHERE id = ?`).run(...vals, debtor.id);
    }

    return {
      ok: true,
      address: debtor.latest_address || (ambiguous ? null : r.address) || null,
      phone: debtor.credit_phone || (ambiguous ? null : r.phone) || null,
      queriedDate: debtor.credit_queried_date || (ambiguous ? null : r.queriedDate) || null,
      source: "ocr",
      filename: c.filename,
      ambiguous,
    };
  }

  if (noHistoryResult) return { ...noHistoryResult, _debugAttempts };
  return { ok: false, address: debtor.latest_address || null, phone: debtor.credit_phone || null, error: "주소 인식 실패", _debugAttempts };
}

app.get("/api/debtor/:id/credit-address", async (req, res) => {
  try {
    const debtor = db.prepare("SELECT id, name, latest_address, credit_phone, credit_queried_date FROM debtors WHERE id = ?").get(req.params.id);
    if (!debtor) return res.json({ ok: false, address: null });

    if (debtor.latest_address && debtor.credit_phone) {
      return res.json({ ok: true, address: debtor.latest_address, phone: debtor.credit_phone, queriedDate: debtor.credit_queried_date, source: "cache" });
    }

    const result = await lookupCreditAddress(debtor);
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, address: null, error: e.message }); }
});

// 예전 OCR 로직으로 잘못 저장된 최신주소/연락처/조회일자를 지우고 최신 스크립트로 다시 추출한다.
app.post("/api/debtor/:id/credit-address/refresh", async (req, res) => {
  try {
    const existing = db.prepare("SELECT id, name FROM debtors WHERE id = ?").get(req.params.id);
    if (!existing) return res.json({ ok: false, address: null, error: "채무자 없음" });

    db.prepare(
      `UPDATE debtors SET latest_address = NULL, latest_address_lat = NULL, latest_address_lng = NULL,
              credit_phone = NULL, credit_queried_date = NULL, credit_source_date = NULL WHERE id = ?`
    ).run(existing.id);

    const debtor = { id: existing.id, name: existing.name, latest_address: null, credit_phone: null, credit_queried_date: null };
    const result = await lookupCreditAddress(debtor);
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, address: null, error: e.message }); }
});

// 채무자 한 명에 대해 비어있는 주소 컬럼(초본/CB)만 골라 OCR 추출을 시도한다.
// lookupResidentDetails/lookupCreditAddress 둘 다 이미 값이 있는 컬럼은 덮어쓰지 않으므로
// 안전하게 둘 다 호출할 수 있다 — "전체 채무자 주소 추출" 배치와 수동 추출 버튼이 공유해서 쓴다.
// label(예: "(4/497) 홍길동")을 넘기면 pm2 로그에 시작/완료가 남아 어느 채무자에서
// 오래 걸리는지(멈춘 건지 그냥 느린 건지) 확인할 수 있다.
async function extractAddressForDebtor(debtor, label, priority) {
  const tag = label || debtor.name;
  const result = { residentOk: false, creditOk: false };
  const parts = [];
  if (!debtor.resident_address) {
    console.log(`[주소추출] ${tag} 초본 조회 시작`);
    try { const r = await lookupResidentDetails(debtor.id, debtor, priority); result.residentOk = !!r.ok; } catch (e) { console.error(`[주소추출] ${tag} 초본 오류:`, e.message); }
    parts.push(`초본 ${result.residentOk ? "성공" : "실패"}`);
  }
  if (!debtor.latest_address) {
    console.log(`[주소추출] ${tag} CB보고서 조회 시작`);
    try { const r = await lookupCreditAddress(debtor, priority); result.creditOk = !!r.ok; } catch (e) { console.error(`[주소추출] ${tag} CB 오류:`, e.message); }
    parts.push(`CB ${result.creditOk ? "성공" : "실패"}`);
  }
  console.log(`[주소추출] ${tag} 완료 — ${parts.length ? parts.join(", ") : "둘 다 이미 있음(스킵)"}`);
  return result;
}

// 초본 또는 CB보고서 주소가 하나라도 비어있는 채무자를 수동/배치 추출 대상으로 조회
app.get("/api/debtors/missing-address", (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT id, name FROM debtors
       WHERE (resident_address IS NULL OR resident_address = '') OR (latest_address IS NULL OR latest_address = '')`
    ).all();
    res.json({ ok: true, debtors: rows });
  } catch (e) { res.status(500).json({ ok: false, debtors: [], error: e.message }); }
});

// 채무자 한 명의 비어있는 주소를 즉시 추출 (프론트 "전체 채무자 주소 추출" 버튼이 순회 호출).
// 프론트가 idx/total 쿼리를 같이 보내주면 pm2 로그에 "(4/497) 홍길동"처럼 남아, 화면에
// 표시된 진행률과 로그를 대조해서 어느 채무자에서 멈췄는지/그냥 느린지 확인할 수 있다.
app.post("/api/debtor/:id/extract-address", async (req, res) => {
  try {
    const debtor = db.prepare(
      `SELECT id, name, resident_number, resident_address, resident_registered_date, resident_note, resident_issued_date,
              latest_address, credit_phone, credit_queried_date
       FROM debtors WHERE id = ?`
    ).get(req.params.id);
    if (!debtor) return res.json({ ok: false, error: "채무자 없음" });
    const { idx, total } = req.query;
    const label = idx && total ? `(${idx}/${total}) ${debtor.name}` : null;
    const result = await extractAddressForDebtor(debtor, label);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 원드라이브 폴더에 더 최근 초본/CB보고서가 새로 올라오면, 이미 캐시된 주소를 계속
// 보여주지 않도록 자동으로 감지해서 캐시를 지운다. 지우기만 하고 그 자리에서 바로
// OCR을 다시 돌리지는 않는다 — 실제로 그 채무자 화면을 여는 시점에 기존 자동추출
// useEffect가 알아서 다시 뽑아오므로, 아무도 안 보는 채무자까지 미리 OCR을 돌려서
// 서버 부담을 늘릴 필요가 없다. resident_source_date/credit_source_date가 아직
// 없는(이 기능 배포 전에 캐시된) 값도 "오래된 것"으로 간주해 한 번은 다시 뽑는다 —
// 예전 버그로 잘못 저장된 값들을 사람이 일일이 "재조회"하지 않아도 자연스럽게 정리된다.
async function runAutoAddressRefreshCheck() {
  try {
    const residentTargets = db.prepare(
      `SELECT id, name, resident_source_date FROM debtors WHERE resident_address IS NOT NULL AND resident_address != ''`
    ).all();
    let residentInvalidated = 0;
    for (const deb of residentTargets) {
      const kor = korName3(deb.name);
      if (!kor) continue;
      const newest = db.prepare(
        `SELECT parsed_date FROM file_index
         WHERE (parsed_person_name LIKE ? OR filename LIKE ?)
         AND (doc_type LIKE '%초본%' OR filename LIKE '%초본%')
         AND ext = 'pdf' ORDER BY parsed_date DESC LIMIT 1`
      ).get(`%${kor}%`, `%${kor}%`);
      if (!newest || !newest.parsed_date) continue;
      if (!deb.resident_source_date || newest.parsed_date > deb.resident_source_date) {
        db.prepare(
          `UPDATE debtors SET resident_address = NULL, resident_address_lat = NULL, resident_address_lng = NULL,
                  resident_registered_date = NULL, resident_note = NULL, resident_issued_date = NULL,
                  resident_source_date = NULL WHERE id = ?`
        ).run(deb.id);
        residentInvalidated++;
      }
    }

    const creditTargets = db.prepare(
      `SELECT id, name, credit_source_date FROM debtors WHERE latest_address IS NOT NULL AND latest_address != ''`
    ).all();
    let creditInvalidated = 0;
    for (const deb of creditTargets) {
      const kor = korName3(deb.name);
      if (!kor) continue;
      const newest = db.prepare(
        `SELECT parsed_date FROM file_index
         WHERE (parsed_person_name LIKE ? OR filename LIKE ?)
         AND (LOWER(doc_type) LIKE '%cb%' OR LOWER(filename) LIKE '%cb%' OR LOWER(filename) LIKE '%신용%')
         AND ext = 'pdf' ORDER BY parsed_date DESC LIMIT 1`
      ).get(`%${kor}%`, `%${kor}%`);
      if (!newest || !newest.parsed_date) continue;
      if (!deb.credit_source_date || newest.parsed_date > deb.credit_source_date) {
        db.prepare(
          `UPDATE debtors SET latest_address = NULL, latest_address_lat = NULL, latest_address_lng = NULL,
                  credit_phone = NULL, credit_queried_date = NULL, credit_source_date = NULL WHERE id = ?`
        ).run(deb.id);
        creditInvalidated++;
      }
    }

    if (residentInvalidated || creditInvalidated) {
      console.log(`[문서 자동동기화] 새 문서 감지 — 초본 캐시 ${residentInvalidated}건, CB 캐시 ${creditInvalidated}건 초기화 (다음에 해당 채무자 화면을 열면 자동으로 다시 추출됩니다)`);
    }
  } catch (e) {
    console.error("[문서 자동동기화] 캐시 최신성 점검 오류:", e.message);
  }
}

// ─── 채무자 위치 지도 (카카오맵) ──────────────────────
// JavaScript 키는 비밀값이 아니라(도메인 제한으로 보호되고 JS SDK에 그대로 노출됨) 프론트에
// 그냥 내려줘도 되지만, REST API 키(지오코딩용)는 서버에만 두고 절대 프론트로 보내지 않는다.
app.get("/api/config/kakao-map", (req, res) => {
  res.json({ appKey: process.env.KAKAO_MAP_APP_KEY || null });
});

// 신용조회(CB) 주소와 초본 주소 중 채무자 위치 지도에 쓸 "더 최근" 주소를 고른다.
// 기준일이 둘 다 있으면 더 늦은 날짜 쪽, 하나만 있으면 그쪽, 둘 다 없으면 있는 주소.
function pickAddressSource(row) {
  const hasResident = !!(row.resident_address && String(row.resident_address).trim());
  const hasCredit = !!(row.latest_address && String(row.latest_address).trim());
  if (!hasResident && !hasCredit) return null;
  if (hasResident && !hasCredit) return "resident";
  if (!hasResident && hasCredit) return "credit";
  if (row.resident_issued_date && (!row.credit_queried_date || row.resident_issued_date > row.credit_queried_date)) {
    return "resident";
  }
  return "credit";
}

// 위치가 캐시돼 있는(또는 주소만 있고 좌표가 없는) 채무자 목록 — 지도 마커용
app.get("/api/debtors/locations", (req, res) => {
  try {
    const rows = db.prepare(`
      WITH addr_pick AS (
        SELECT *,
          CASE
            WHEN resident_address IS NOT NULL AND resident_address != '' AND (
              latest_address IS NULL OR latest_address = '' OR
              (resident_issued_date IS NOT NULL AND (credit_queried_date IS NULL OR resident_issued_date > credit_queried_date))
            ) THEN 'resident' ELSE 'credit'
          END AS addr_source
        FROM v_debtors
      )
      SELECT id, name, brand_code AS brand, brand_name AS brandName, category, assignee,
             collection_status AS collectionStatus,
             addr_source AS addressSource,
             CASE WHEN addr_source = 'resident' THEN resident_address ELSE latest_address END AS latestAddress,
             CASE WHEN addr_source = 'resident' THEN resident_address_lat ELSE latest_address_lat END AS lat,
             CASE WHEN addr_source = 'resident' THEN resident_address_lng ELSE latest_address_lng END AS lng
      FROM addr_pick
      WHERE (latest_address IS NOT NULL AND latest_address != '') OR (resident_address IS NOT NULL AND resident_address != '')
    `).all();
    res.json({ ok: true, debtors: rows });
  } catch (e) { res.status(500).json({ ok: false, debtors: [], error: e.message }); }
});

// 주소 → 좌표 지오코딩 (카카오 로컬 API). 이미 좌표가 캐시돼 있으면 API 호출 없이 반환.
// 라우트와 야간 자동 배치(runAddressBatch)가 함께 쓰도록 함수로 분리했다.
async function geocodeDebtorById(debtorId) {
  const debtor = db.prepare(
    `SELECT id, latest_address, latest_address_lat AS lat, latest_address_lng AS lng,
            resident_address, resident_address_lat AS residentLat, resident_address_lng AS residentLng,
            resident_issued_date, credit_queried_date
     FROM debtors WHERE id = ?`
  ).get(debtorId);
  if (!debtor) return { ok: false, error: "채무자 없음" };

  const source = pickAddressSource(debtor);
  if (!source) return { ok: false, error: "주소 없음" };

  const address = source === "resident" ? debtor.resident_address : debtor.latest_address;
  const cachedLat = source === "resident" ? debtor.residentLat : debtor.lat;
  const cachedLng = source === "resident" ? debtor.residentLng : debtor.lng;
  if (cachedLat != null && cachedLng != null) {
    return { ok: true, lat: cachedLat, lng: cachedLng, source: "cache", addressSource: source };
  }

  const restKey = process.env.KAKAO_REST_API_KEY;
  if (!restKey) return { ok: false, error: "카카오맵 API 키가 설정되지 않았습니다 (backend/.env)" };

  const headers = { Authorization: `KakaoAK ${restKey}` };
  const q = encodeURIComponent(address);

  // 1차: 지번/도로명 주소 검색 → 실패하면 2차: 키워드(장소) 검색으로 재시도
  let doc = null;
  let r = await fetch(`https://dapi.kakao.com/v2/local/search/address.json?query=${q}`, { headers });
  let data = await r.json();
  if (r.ok && data.documents?.length) doc = data.documents[0];
  if (!doc) {
    r = await fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?query=${q}`, { headers });
    data = await r.json();
    if (r.ok && data.documents?.length) doc = data.documents[0];
  }
  if (!doc) return { ok: false, error: "주소를 좌표로 변환할 수 없습니다" };

  const lat = parseFloat(doc.y);
  const lng = parseFloat(doc.x);
  if (source === "resident") {
    db.prepare("UPDATE debtors SET resident_address_lat = ?, resident_address_lng = ? WHERE id = ?").run(lat, lng, debtor.id);
  } else {
    db.prepare("UPDATE debtors SET latest_address_lat = ?, latest_address_lng = ? WHERE id = ?").run(lat, lng, debtor.id);
  }
  return { ok: true, lat, lng, source: "geocode", addressSource: source };
}

app.post("/api/debtor/:id/geocode", async (req, res) => {
  try {
    const result = await geocodeDebtorById(req.params.id);
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 채무자 위치 지도를 전체 채무자 기준으로 채워두기 위한 배치 — 평소엔 그 채무자 화면을
// 열 때만 지연 추출하지만(서버 부담 방지), 이 배치는 초본/CB 주소가 하나라도 비어있는
// 항목들을 최대 concurrency개씩 동시에 처리 — OCR 프로세스 하나가 대부분의 시간을
// 파이썬 기동+모델 로딩에 쓰고 있어서(실제 인식 자체보다 오래 걸림), 순차 처리 대신
// 몇 개씩 동시에 띄우면 전체 소요 시간이 그만큼 줄어든다.
async function runWithConcurrency(items, worker, concurrency) {
  let idx = 0;
  const lanes = new Array(Math.min(concurrency, items.length) || 0).fill(null).map(async () => {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
}

// 지금 배치가 얼마나 진행됐는지 프론트가 polling으로 확인할 수 있게 메모리에 상태를 둔다.
// 이 상태 덕분에 브라우저 탭을 닫거나 PC가 절전모드에 들어가도(서버 PC만 살아있으면)
// 배치 자체는 서버에서 계속 진행되고, 나중에 다시 화면을 열면 진행 상황을 이어서 볼 수 있다.
let addressBatchStatus = { running: false, phase: null, done: 0, total: 0, startedAt: null, finishedAt: null, result: null, error: null };
const ADDRESS_EXTRACT_CONCURRENCY = 3; // OCR은 CPU를 많이 쓰므로 서버 PC 사양을 고려해 보수적으로 설정
const GEOCODE_CONCURRENCY = 5; // 좌표 변환은 카카오 API 호출이라 가벼워서 좀 더 높여도 된다

// 심야(00:00~06:00) 자동배치인지 아닌지에 따라 "지금이 그 시간대인지"를 체크한다.
// 수동 트리거(관리자가 직접 버튼을 누른 경우)는 이 창을 무시하고 바로 돌린다 — 급하게
// 필요하면 낮에도 쓸 수 있게. 자동 실행만 이 창 밖으로 나가면 남은 대상을 건너뛰고
// 다음날 밤에 이어서 처리한다(이미 처리된 건 다시 안 함 — 대상 쿼리 자체가 매번
// "아직 없는 것"만 골라오므로).
function isNightWindow() {
  const h = new Date().getHours();
  return h >= 0 && h < 6;
}

// 채무자 전원에 대해 OCR 추출 + 좌표변환까지 한 번에 돌린다. 수동 트리거
// (/api/debtors/batch-extract-addresses)와 매일 밤 자동 실행(checkNightlyAddressBatch)이
// 공유해서 쓴다. respectNightWindow가 true면(자동 실행) 창을 벗어나는 순간부터 남은
// 대상은 건너뛰고, false면(수동 트리거) 시간대와 무관하게 끝까지 돌린다.
async function runAddressBatch(respectNightWindow) {
  const targets = db.prepare(
    `SELECT id, name, resident_number, resident_address, resident_registered_date, resident_note, resident_issued_date,
            latest_address, credit_phone, credit_queried_date
     FROM debtors
     WHERE (resident_address IS NULL OR resident_address = '') OR (latest_address IS NULL OR latest_address = '')`
  ).all();
  addressBatchStatus.phase = "extract";
  addressBatchStatus.total = targets.length;
  addressBatchStatus.done = 0;
  let extracted = 0;
  let stoppedForWindow = false;
  await runWithConcurrency(targets, async (debtor, i) => {
    if (respectNightWindow && !isNightWindow()) { stoppedForWindow = true; addressBatchStatus.done++; return; }
    const r = await extractAddressForDebtor(debtor, `(${i + 1}/${targets.length}) ${debtor.name}`, "low");
    if (r.residentOk || r.creditOk) extracted++;
    addressBatchStatus.done++;
  }, ADDRESS_EXTRACT_CONCURRENCY);

  const geoTargets = db.prepare(
    `SELECT id FROM debtors
     WHERE (latest_address IS NOT NULL AND latest_address != '' AND latest_address_lat IS NULL)
        OR (resident_address IS NOT NULL AND resident_address != '' AND resident_address_lat IS NULL)`
  ).all();
  addressBatchStatus.phase = "geocode";
  addressBatchStatus.total = geoTargets.length;
  addressBatchStatus.done = 0;
  let geocoded = 0;
  await runWithConcurrency(geoTargets, async (row) => {
    if (respectNightWindow && !isNightWindow()) { stoppedForWindow = true; addressBatchStatus.done++; return; }
    try {
      const r = await geocodeDebtorById(row.id);
      if (r.ok) geocoded++;
    } catch (e) { console.error(`[주소배치] ${row.id} 좌표변환 오류:`, e.message); }
    addressBatchStatus.done++;
  }, GEOCODE_CONCURRENCY);

  return { targeted: targets.length, extracted, geoTargeted: geoTargets.length, geocoded, stoppedForWindow };
}

// 수동 트리거 — "채무자 위치" 화면의 "전체 채무자 주소 추출" 버튼이 호출.
// OCR을 다수 순회하는 무거운 작업이라 응답은 즉시 반환하고 백그라운드에서 계속 진행한다.
// 브라우저 탭을 닫아도(서버 PC만 켜져 있으면) 끝까지 진행된다 — 진행 상황은
// /api/debtors/batch-extract-addresses/status 로 polling해서 확인한다.
app.post("/api/debtors/batch-extract-addresses", (req, res) => {
  if (addressBatchStatus.running) return res.json({ ok: false, error: "이미 실행 중입니다" });
  addressBatchStatus = { running: true, phase: "extract", done: 0, total: 0, startedAt: Date.now(), finishedAt: null, result: null, error: null };
  res.json({ ok: true, started: true });
  runAddressBatch(false)
    .then(result => {
      addressBatchStatus = { ...addressBatchStatus, running: false, phase: "done", finishedAt: Date.now(), result };
      console.log(`[주소배치] 수동 실행 완료 — 대상 ${result.targeted}건 중 ${result.extracted}건 추출, 좌표 ${result.geocoded}/${result.geoTargeted}건 변환`);
      broadcast("data-changed", { method: "BATCH", path: "/api/debtors/batch-extract-addresses", at: Date.now() });
    })
    .catch(e => {
      addressBatchStatus = { ...addressBatchStatus, running: false, phase: "error", finishedAt: Date.now(), error: e.message };
      console.error("[주소배치] 수동 실행 오류:", e.message);
    });
});

app.get("/api/debtors/batch-extract-addresses/status", (req, res) => {
  res.json({ ok: true, ...addressBatchStatus });
});

// ─── 대위변제일 자동 추출 (대위변제증명서 PDF → Python Windows OCR) ──
app.get("/api/debtor/:id/subrogation-date", async (req, res) => {
  try {
    const debtor = db.prepare("SELECT name FROM debtors WHERE id = ?").get(req.params.id);
    if (!debtor) return res.json({ ok: false, date: null });

    const kor = korName3(debtor.name);
    if (!kor) return res.json({ ok: false, date: null });

    const rows = db.prepare(
      `SELECT file_path, filename FROM file_index
       WHERE (parsed_person_name LIKE ? OR filename LIKE ?)
       AND (LOWER(doc_type) LIKE '%대위변제%' OR LOWER(filename) LIKE '%대위변제%')
       AND ext IN ('pdf', 'hwp', 'hwpx')
       ORDER BY parsed_date DESC LIMIT 5`
    ).all(`%${kor}%`, `%${kor}%`);

    for (const c of rows) {
      if (!c.file_path.toLowerCase().endsWith('.pdf')) continue;
      const r = await ocrPdfForSubrogationDate(c.file_path);
      if (r.ok && r.date) return res.json({ ok: true, date: r.date, filename: c.filename });
    }

    res.json({ ok: false, date: null });
  } catch (e) { res.status(500).json({ ok: false, date: null, error: e.message }); }
});

app.use(express.static(path.join(__dirname, "../dist")));
// SPA 라우팅용 폴백 — API 경로는 여기서 그냥 끝내면 안 된다. 이 핸들러가 GET을 전부
// 매칭하는 와일드카드라서, next()를 안 부르면 이 줄 "아래"에 등록된 /api GET 라우트는
// (앞쪽에 이미 등록된 라우트와 안 겹치는 한) 영영 도달하지 못하고 응답 없이 멈춘다 —
// 실제로 이 문제 때문에 나중에 추가한 몇몇 /api 라우트가 응답을 영원히 안 하는 버그가 있었다.
app.get("/{*splat}", (req, res, next) => {
  if (!req.path.startsWith("/api")) {
    return res.sendFile(path.join(__dirname, "../dist/index.html"));
  }
  next();
});

// ─── AI 종합분석 ──────────────────────────────────
const OpenAI = require("openai");
let openaiClient = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// .env가 서버 기동 이후에 추가/수정된 경우 재시작 없이도 다음 요청에서 자동으로 반영되도록 재시도
function getOpenAIClient() {
  if (openaiClient) return openaiClient;
  require("dotenv").config({ path: path.join(__dirname, ".env"), override: true });
  if (process.env.OPENAI_API_KEY) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

// AI 챗봇이 "활동 로그에 남겨줘" 요청을 실제로 처리할 수 있도록 하는 function-calling 도구.
// 히스토리 탭이 실제로 읽는 저장소는 activities 테이블이 아니라 kv_store의 hist_m_{debtorId}
// 배열이므로(위 주석 참고), 여기서도 반드시 같은 키/형태로 써야 화면에 보인다.
const AI_ACTIVITY_TYPES = ["전화", "문자", "입금확인", "법적조치", "방문", "카카오톡", "내용증명", "기타"];
const AI_ACTIVITY_LOG_TOOLS = [{
  type: "function",
  function: {
    name: "log_activity",
    description: "이 채무자의 히스토리(활동 로그)에 새 활동 기록을 실제로 추가한다. 사용자가 방금 한 통화/문자/방문 등의 내용을 \"기록해줘\", \"남겨줘\", \"적어줘\" 라고 명시적으로 요청할 때만 호출한다. 단순 질문이나 분석 요청에는 호출하지 않는다. 이 함수는 대화당 한 번만 호출한다.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "히스토리에 실제로 저장될 본문. \"분석 기록함\", \"조언 기록\" 같은 메타 설명이 아니라, 직전 assistant 답변에 담긴 실질적 내용(성향 판단, 회수율 평가, 강제집행 결과, 제시한 대안 등 핵심 근거와 결론)을 담당자가 나중에 읽어도 이해할 수 있도록 구체적으로 요약해서 담는다. 사용자가 통화/방문 내용을 직접 불러준 경우엔 그 내용을 그대로 요약한다.",
        },
        type: { type: "string", enum: AI_ACTIVITY_TYPES, description: "활동 유형, 알 수 없으면 기타" },
        date: { type: "string", description: "활동 날짜 YYYY.MM.DD 형식, 명시하지 않으면 오늘 날짜 사용" },
      },
      required: ["content"],
    },
  },
}];
function appendDebtorHistory(debtorId, entry) {
  const key = `hist_m_${debtorId}`;
  const row = db.prepare("SELECT value FROM kv_store WHERE key=?").get(key);
  let arr = [];
  if (row) { try { const parsed = JSON.parse(row.value); if (Array.isArray(parsed)) arr = parsed; } catch {} }
  arr = [entry, ...arr];
  db.prepare(`
    INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now', 'localtime'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(arr));
}

app.post("/api/ai-chat", async (req, res) => {
  const openaiClient = getOpenAIClient();
  if (!openaiClient) return res.status(503).json({ error: "OPENAI_API_KEY 미설정" });
  const { query, debtorId, history, chatHistory } = req.body;
  if (!query) return res.status(400).json({ error: "query 필요" });

  try {
    // 특정 채무자 지정 시 해당 채무자 데이터 로드
    let contextText = "";
    let debtorName = null;
    if (debtorId) {
      const d = db.prepare("SELECT * FROM debtors WHERE id=?").get(debtorId);
      if (d) {
        debtorName = d.name;
        const pays = db.prepare("SELECT * FROM payments WHERE debtor_id=? ORDER BY payment_date DESC LIMIT 30").all(debtorId);
        const seizures = db.prepare("SELECT * FROM seizure_cases WHERE debtor_id=? ORDER BY created_at DESC LIMIT 5").all(debtorId);
        const seizureTargets = seizures.length
          ? db.prepare(`SELECT * FROM seizure_targets WHERE seizure_case_id IN (${seizures.map(() => "?").join(",")}) ORDER BY seizure_case_id, seq`).all(...seizures.map(s => s.id))
          : [];
        const rehabs = db.prepare("SELECT * FROM rehabilitations WHERE debtor_id=? ORDER BY id DESC LIMIT 3").all(debtorId);
        const installs = db.prepare("SELECT * FROM installment_plans WHERE debtor_id=? ORDER BY id DESC LIMIT 1").all(debtorId);
        const instLogs = installs.length
          ? db.prepare("SELECT * FROM installment_logs WHERE plan_id=? ORDER BY id DESC LIMIT 12").all(installs[0].id)
          : [];
        const complaints = db.prepare("SELECT * FROM complaints WHERE debtor_id=? ORDER BY complaint_date DESC LIMIT 3").all(debtorId);
        const guarantors = db.prepare("SELECT name FROM debtor_guarantors WHERE debtor_id=?").all(debtorId).map(g => g.name);

        // "히스토리" 탭에 실제로 보이는 기록(엑셀 원본+수정/삭제 반영 + 수동 추가)은 서버 DB의
        // activities 테이블이 아니라 프론트(엑셀 원본 + localStorage/kv_store)에만 있어서, 여기선
        // 클라이언트가 함께 보낸 history를 우선 사용한다 — activities 테이블은 이 화면 밖에서
        // 쓰이는 경우를 위한 보조 폴백일 뿐 히스토리 탭 내용과는 별개다.
        const clientHistory = Array.isArray(history) ? history.filter(h => h && h.content) : [];
        const histLines = clientHistory.length > 0
          ? clientHistory.slice(0, 40).map((h, i) => `${i + 1}. ${h.date || "날짜미상"} [${h.type || "메모"}] ${h.content}`).join("\n")
          : (() => {
              const acts = db.prepare("SELECT * FROM activities WHERE debtor_id=? ORDER BY activity_date DESC LIMIT 20").all(debtorId);
              return acts.length === 0 ? "없음" : acts.map((a, i) => `${i + 1}. ${a.activity_date} [${a.activity_type}] ${a.content || ""}`).join("\n");
            })();

        const fmt = v => v != null ? Number(v).toLocaleString("ko-KR") : "0";
        const totalPaid = pays.reduce((s, p) => s + (p.total_amount || 0), 0);
        const lastPay = pays[0];
        const finalFinance = (d.principal_balance || 0) - (d.collected_amount || 0);
        const finalLegal = (d.principal_balance || 0) + (d.adjustment || 0) - (d.collected_amount || 0);
        const daysSinceLastPay = lastPay ? Math.floor((Date.now() - new Date(lastPay.payment_date).getTime()) / 86400000) : null;
        // 최근 3건 vs 그 이전 3건 입금액 비교로 입금 추세(증가/감소/정지) 파악
        const recent3 = pays.slice(0, 3).reduce((s, p) => s + (p.total_amount || 0), 0);
        const prev3 = pays.slice(3, 6).reduce((s, p) => s + (p.total_amount || 0), 0);
        const paymentTrend = pays.length === 0 ? "입금 이력 없음"
          : pays.length < 4 ? "판단하기엔 입금 건수 부족"
          : recent3 > prev3 * 1.1 ? "증가세"
          : recent3 < prev3 * 0.9 ? "감소세"
          : "유지";

        const targetsByCase = {};
        for (const t of seizureTargets) (targetsByCase[t.seizure_case_id] ||= []).push(t);

        contextText = `
[채무자 기본정보]
이름: ${d.name} | 브랜드: ${d.brand_code || "-"} | 허브: ${d.hub_name || "-"}
원금: ${fmt(d.principal_balance)}원 | 조정액: ${fmt(d.adjustment)}원 | 회수액: ${fmt(d.collected_amount)}원
잔액(재무기준): ${fmt(finalFinance)}원 | 잔액(법무기준, 법무비용 포함): ${fmt(finalLegal)}원
수금상태: ${d.collection_status || "-"}
담당자: ${d.assignee || "-"} | 메모: ${d.key_notes || "-"}
전화: ${d.phone || "-"} | 채무원인: ${d.debt_cause || "-"}
집행권원: ${d.exec_title || "-"}
연대보증인: ${guarantors.length ? guarantors.join(", ") : "없음"}

[입금 현황]
총 입금액(전체): ${fmt(d.collected_amount)}원 | 최근 조회된 입금: ${fmt(totalPaid)}원 (${pays.length}건, 최근 30건 기준)
전체 청구액 대비 회수율: ${(finalLegal + (d.collected_amount || 0)) > 0 ? (((d.collected_amount || 0) / (finalLegal + (d.collected_amount || 0))) * 100).toFixed(1) : "0"}%
최근 입금: ${lastPay ? `${lastPay.payment_date} ${fmt(lastPay.total_amount)}원 (오늘까지 ${daysSinceLastPay}일 경과)` : "없음"}
최근 입금 추세(최근 3건 합 vs 그 이전 3건 합 비교): ${paymentTrend}
${pays.length > 0 ? pays.slice(0, 15).map(p => `  ${p.payment_date} ${fmt(p.total_amount)}원 (${p.payer_name || "-"})`).join("\n") : ""}

[히스토리 — 담당자가 실제 기록한 추심활동 전체 흐름, 시간순 최신이 위 (최대 40건)]
${histLines}

[압류/강제집행 결과 (최대 5건, 제3채무자별 실제 회수 내역 포함)]
${seizures.length === 0 ? "없음" : seizures.map(s => {
  const targets = targetsByCase[s.id] || [];
  const head = `법원: ${s.court || "-"} | 사건번호: ${s.case_number || "-"} | 상태: ${s.status || "-"}`;
  if (targets.length === 0) return `${head}\n  제3채무자 진술 내역 없음`;
  const lines = targets.map(t => `  - ${t.third_party_name || "-"} | 청구액 ${fmt(t.claim_amount)}원 | 잔액 ${fmt(t.balance)}원 | 회수액 ${fmt(t.collected)}원 | 회신일 ${t.response_date || "-"} | ${t.completed ? "완료" : "진행중"}${t.note ? ` | ${t.note}` : ""}`);
  return `${head}\n${lines.join("\n")}`;
}).join("\n")}

[회생/파산]
${rehabs.length === 0 ? "없음" : rehabs.map(r => `${r.type || "-"} | 사건번호: ${r.case_number || "-"} | 법원: ${r.court || "-"}`).join("\n")}

[분납약정 및 실제 이행 현황 — 이행 로그는 채무자의 상환 의지/능력을 보여주는 핵심 근거]
${installs.length === 0 ? "없음" : installs.map(i => `월 ${fmt(i.monthly_amount)}원 | 총채권: ${fmt(i.total_claim)}원 | 상태: ${i.status}`).join("\n")}
${instLogs.length > 0 ? instLogs.map(l => `  ${l.target_month} [${l.status}] ${fmt(l.paid_amount)}원${l.memo ? ` (${l.memo})` : ""}`).join("\n") : (installs.length > 0 ? "  월별 이행 로그 없음" : "")}

[형사고소]
${complaints.length === 0 ? "없음" : complaints.map(c => `${c.complaint_date} | ${c.police_station || "-"} | ${c.status_note || "-"}`).join("\n")}
`.trim();
      }
    } else {
      // 전체 현황 요약 제공
      const totalDebtors = db.prepare("SELECT COUNT(*) AS c FROM debtors").get().c;
      const totalBalance = db.prepare("SELECT SUM(principal_balance) AS s FROM debtors").get().s || 0;
      const recentPays = db.prepare("SELECT d.name, p.total_amount, p.payment_date FROM payments p JOIN debtors d ON d.id=p.debtor_id ORDER BY p.payment_date DESC LIMIT 10").all();
      const noPayDebtors = db.prepare(`SELECT COUNT(*) AS c FROM debtors d WHERE NOT EXISTS (SELECT 1 FROM payments p WHERE p.debtor_id=d.id AND p.payment_date >= date('now','-3 months'))`).get().c;
      contextText = `
[전체 현황]
총 채무자 수: ${totalDebtors}명
총 원금 잔액: ${Number(totalBalance).toLocaleString("ko-KR")}원
최근 3개월 입금 없는 채무자: ${noPayDebtors}명

[최근 입금 10건]
${recentPays.map(p => `${p.payment_date} ${p.name} ${Number(p.total_amount).toLocaleString("ko-KR")}원`).join("\n")}
`.trim();
    }

    const systemPrompt = `당신은 NPL 채권관리 전문 AI 어시스턴트입니다.
바로고 채권관리 시스템의 실제 데이터를 바탕으로 담당자에게 이 채무자 개인에게 맞춘 실무 분석과
조언을 제공합니다. "협상을 시도해보세요", "압류를 고려해보세요", "지속적으로 연락하세요" 같은
누구에게나 적용되는 뭉뚱그린 답변은 절대 금지입니다. 반드시 아래 데이터를 종합해 이 채무자만의
근거를 인용하며 답하세요.

- [히스토리]는 담당자가 그동안 실제로 남긴 추심활동 기록(통화·문자·방문·협상·주소변경 등)으로,
  가장 구체적이고 신뢰도 높은 근거입니다. 연락 시도 빈도/최근성, 채무자의 반응이나 약속과 그
  이행 여부, 협상·분납 논의 경과, 연락처·주소 변경 이력, 반복되는 패턴(예: 특정 시기마다 연락
  끊김)을 파악하고 "N월 N일 기록에 따르면"처럼 구체적인 날짜를 인용해 근거를 제시하세요.
  히스토리·데이터에 없는 내용은 추측해서 답하지 마세요.

- **사용자의 질문에 직접 답하는 것이 최우선입니다.** 질문이 특정 정보만 묻고 있으면(예: "완납
  가능성이 얼마나 돼?", "소멸시효 임박했어?", "압류 가능성 있어?") 그 질문에 필요한 근거만
  사용해서 그 질문에만 간결하게 답하세요. 아래 성향 판단/강제집행 결과/채무액·회수율/대안 제시
  항목을 매번 전부 나열하지 마세요 — 질문과 관련 없는 항목까지 억지로 붙이면 실제로 원하는 답이
  묻혀버립니다. "히스토리에 남겨줘"처럼 기록만 요청하는 경우엔 무엇을 기록했는지만 답하세요.
  사용자가 "종합적으로 분석해줘", "전반적으로 어떻게 해야해" 처럼 전체 현황·대응방향을 물을
  때만 아래 항목들을 모두 포함한 구조화된 답변을 주세요.

- **성향 판단** (종합분석 시 포함): 히스토리의 연락 반응 패턴, [분납약정 및 실제 이행 현황]의
  완납/미납/지연 비율, [입금 현황]의 입금 추세·경과일을 종합해 이 채무자를 다음과 같은 유형 중
  가장 근접한 것으로 명시적으로 분류하고 그 근거를 제시하세요: 협조적 상환형(약속을 대체로 지킴) /
  상환 의지는 있으나 능력 부족형(약속하지만 반복적으로 미납·지연) / 회피·잠적형(연락 두절·주소·
  연락처 변경 반복) / 의도적 비협조형(연락은 되지만 상환 의사 없음) / 판단 근거 부족(데이터 부족).
  유형은 참고용 명칭이며 데이터와 다르면 다르게 표현해도 됩니다.

- **강제집행 결과 반영** (종합분석·압류 관련 질문 시 포함): [압류/강제집행 결과]에 제3채무자별
  청구액·잔액·회수액·완료여부가 있으면 회수율과 효과를 평가하고("OO은행 압류에서 청구액 대비
  OO% 회수" 등), 압류가 없거나 실효성이 낮았다면 왜 그런지(재산 없음/제3채무자 무응답 등)와
  추가 압류 대상 발굴 필요성을 판단하세요.

- **채무액·회수율 반영** (종합분석·완납가능성 관련 질문 시 포함): [채무자 기본정보]의 잔액(재무/
  법무기준)과 [입금 현황]의 전체 청구액 대비 회수율을 근거로, 잔액 규모와 회수 속도 대비 완전
  회수까지 걸릴 기간이나 현실적 회수 가능성을 구체적으로 판단하세요.

- **현실적 대안 제시** (종합분석·대응방향 질문 시 포함): 성향·강제집행 결과·채무액·회수율 분석을
  종합해서, 이 채무자에게 실제로 실행 가능한 대안을 우선순위(1, 2, 3...) 순으로 제시하세요. 각
  항목은 "무엇을/누구에게/어떻게/왜 이 채무자에게 이 방법이 적합한지(데이터 근거)"를 포함해야
  하며, 일반론이 아니라 이 채무자의 구체적 상황(성향, 남은 잔액, 연대보증인 유무와 그쪽 상태,
  압류 실효성, 회생·분납 이력)에 근거해야 합니다. 예를 들어 회피·잠적형이면 연락 재개보다
  재산조사·압류가 우선이고, 능력 부족형이면 분납 재조정이나 연대보증인 활용이 우선일 수
  있습니다 — 데이터가 실제로 그렇게 보일 때만 그렇게 판단하세요.

- 금액은 항상 원화(원) 단위로 표시하고 천단위 콤마를 사용하세요.
- 답변은 질문 범위에 맞게 간결하게, 그러나 근거(날짜·건수·금액·비율 등)는 빠짐없이 포함하세요.
- 한국어로 답변하세요.`;

    const userMessage = contextText
      ? `[채무자 데이터]\n${contextText}\n\n[질문]\n${query}`
      : query;

    const fullSystemPrompt = debtorId
      ? `${systemPrompt}\n\n- 사용자가 방금 한 통화·문자·방문 등의 활동 내용을 히스토리에 기록해달라고 요청하면 log_activity 기능을 호출해 실제로 기록하고, 기록 완료 여부를 답변에 알려주세요.`
      : systemPrompt;

    // "히스토리에 남겨줘"는 보통 방금 나눈 대화(직전 분석 답변)를 가리키므로, 그 내용을 알아야
    // log_activity의 content에 실제 분석 내용을 담을 수 있다 — 프론트가 최근 대화 turn을 함께 보낸다.
    const priorTurns = Array.isArray(chatHistory)
      ? chatHistory.filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string").slice(-8)
      : [];

    const baseMessages = [
      { role: "system", content: fullSystemPrompt },
      ...priorTurns,
      { role: "user", content: userMessage },
    ];

    const completion = await openaiClient.chat.completions.create({
      model: "gpt-4o-mini",
      messages: baseMessages,
      max_tokens: 1500,
      temperature: 0.3,
      ...(debtorId ? { tools: AI_ACTIVITY_LOG_TOOLS, tool_choice: "auto" } : {}),
    });

    const assistantMsg = completion.choices[0].message;
    const toolCalls = assistantMsg.tool_calls || [];

    if (debtorId && toolCalls.length > 0) {
      const userName = extractUserName(req);
      const todayDot = db.prepare("SELECT date('now','localtime') AS d").get().d.replace(/-/g, ".");
      let loggedAny = false;
      const seenContents = new Set();
      const toolResultMessages = toolCalls.map(tc => {
        if (tc.function?.name !== "log_activity") {
          return { role: "tool", tool_call_id: tc.id, content: JSON.stringify({ ok: false, error: "알 수 없는 기능" }) };
        }
        let args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
        const content = typeof args.content === "string" ? args.content.trim() : "";
        if (!content) {
          return { role: "tool", tool_call_id: tc.id, content: JSON.stringify({ ok: false, error: "기록할 내용이 없습니다" }) };
        }
        // 모델이 같은 요청에 log_activity를 여러 번 호출하는 경우(동일 내용) 중복 기록 방지
        if (seenContents.has(content)) {
          return { role: "tool", tool_call_id: tc.id, content: JSON.stringify({ ok: true, skipped: true, reason: "이미 기록됨(중복)" }) };
        }
        seenContents.add(content);
        const type = AI_ACTIVITY_TYPES.includes(args.type) ? args.type : "기타";
        const date = typeof args.date === "string" && /^\d{4}\.\d{2}\.\d{2}$/.test(args.date) ? args.date : todayDot;
        const entry = {
          id: `HIST${Date.now()}${Math.floor(100 + Math.random() * 900)}`,
          date, content, type,
          createdBy: userName && userName !== "알수없음" ? `${userName} (AI)` : "AI 챗봇",
        };
        appendDebtorHistory(debtorId, entry);
        loggedAny = true;
        return { role: "tool", tool_call_id: tc.id, content: JSON.stringify({ ok: true, ...entry }) };
      });

      const follow = await openaiClient.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [...baseMessages, assistantMsg, ...toolResultMessages],
        max_tokens: 500,
        temperature: 0.3,
      });
      const followAnswer = follow.choices[0].message.content;
      const followLogEntry = logAiAnalysis(req, "debtor", debtorName, debtorId, query, followAnswer);
      return res.json({ answer: followAnswer, activityLogged: loggedAny, logEntry: followLogEntry });
    }

    const logEntry = logAiAnalysis(req, "debtor", debtorName, debtorId, query, assistantMsg.content);
    res.json({ answer: assistantMsg.content, logEntry });
  } catch (err) {
    console.error("AI chat error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── 문건 분석: PDF 텍스트 추출 + 채팅 ────────────────
app.post("/api/ai/extract-pdf-text", express.raw({ type: "application/pdf", limit: "20mb" }), async (req, res) => {
  try {
    if (!pdfParse) return res.status(503).json({ error: "PDF 처리 모듈(pdf-parse)이 설치되어 있지 않습니다" });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: "PDF 파일이 비어 있습니다" });
    }
    const data = await pdfParse(req.body);
    const text = (data.text || "").trim();
    if (text) {
      return res.json({ text, pages: data.numpages || 0 });
    }

    // 텍스트가 없으면 스캔본(이미지) PDF일 가능성이 높다 — 기존 초본/CB 서류에 쓰던
    // Windows OCR 파이프라인을 그대로 재사용해 이미지에서 전체 텍스트를 뽑아본다.
    const tmpPath = path.join(os.tmpdir(), `docanalysis_${Date.now()}_${Math.round(Math.random() * 1e6)}.pdf`);
    fs.writeFileSync(tmpPath, req.body);
    try {
      const ocrResult = await ocrPdfForDocument(tmpPath, "high");
      if (ocrResult.ok && ocrResult.text && ocrResult.text.trim()) {
        return res.json({
          text: ocrResult.text,
          pages: ocrResult.pages || data.numpages || 0,
          ocr: true,
          warning: ocrResult.truncated ? `문서가 길어 앞 ${ocrResult.pages}페이지만 OCR로 인식했습니다.` : undefined,
        });
      }
      return res.json({
        text: "", pages: data.numpages || 0,
        warning: "텍스트를 추출할 수 없습니다 — OCR로도 인식하지 못했습니다" + (ocrResult.error ? ` (${ocrResult.error})` : ""),
      });
    } finally {
      try { fs.unlinkSync(tmpPath); } catch (e) {}
    }
  } catch (err) {
    res.status(500).json({ error: "PDF 처리 실패: " + err.message });
  }
});

app.post("/api/ai/doc-chat", async (req, res) => {
  const openaiClient = getOpenAIClient();
  if (!openaiClient) return res.status(503).json({ error: "OPENAI_API_KEY 미설정" });
  const { query, docText, docFileName, history } = req.body || {};
  if (!query) return res.status(400).json({ error: "query 필요" });
  if (!docText) return res.status(400).json({ error: "docText 필요 — 먼저 문서를 업로드하세요" });

  try {
    const MAX_CHARS = 60000; // 대략 30페이지 분량 — gpt-4o-mini 컨텍스트 내에서 충분히 여유있게 통째로 넘김
    const truncated = docText.length > MAX_CHARS;
    const docContext = docText.slice(0, MAX_CHARS);

    const systemPrompt = `당신은 법률/채권 문서 분석 전문가입니다. 담당자가 업로드한 문서(판결문, 결정문,
답변서, 화의안 등)의 내용을 바탕으로 질문에 답합니다.
- 문서에 실제로 있는 내용만 근거로 답하고, 문서에 없는 내용은 추측하지 마세요.
- 판결문/결정문이면 요지·핵심 쟁점·결과(주문)를 명확히 구분해서, 법률 지식이 없어도 이해할 수 있게
  쉬운 말로 설명하세요.
- 금액이 나오면 원화(원) 단위, 천단위 콤마로 표시하세요.
- 날짜·금액·당사자명 등 문서 안의 구체적인 근거를 인용하세요.
- 한국어로 답변하세요.`;

    const clientHistory = Array.isArray(history)
      ? history.filter(h => h && h.role && h.content).slice(-10).map(h => ({ role: h.role, content: h.content }))
      : [];

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `[문서: ${docFileName || "업로드된 문서"}]${truncated ? " (문서가 길어 앞부분만 발췌되었습니다)" : ""}\n${docContext}` },
      ...clientHistory,
      { role: "user", content: query },
    ];

    const completion = await openaiClient.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      max_tokens: 1500,
      temperature: 0.3,
    });

    const answer = completion.choices[0].message.content;
    const logEntry = logAiAnalysis(req, "document", docFileName || null, null, query, answer);
    res.json({ answer, logEntry });
  } catch (err) {
    console.error("AI doc-chat error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// AI 종합분석 히스토리 목록 (채무자 분석/문건 분석 공통) — 검색·탭 필터는 프론트에서 처리
app.get("/api/ai-analysis-log", (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM ai_analysis_log ORDER BY id DESC LIMIT 1000").all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/ai-analysis-log/:id", (req, res) => {
  try {
    db.prepare("DELETE FROM ai_analysis_log WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════ 주간/월간/반기/연간 보고서 ═══════════════
const PERIOD_LABELS = { weekly: "주간", monthly: "월간", half: "반기", yearly: "연간" };

function getKvArray(key) {
  const row = db.prepare("SELECT value FROM kv_store WHERE key = ?").get(key);
  if (!row) return [];
  try { const v = JSON.parse(row.value); return Array.isArray(v) ? v : []; } catch { return []; }
}
function daysBetween(a, b) { return Math.floor((new Date(b) - new Date(a)) / 86400000); }
function shiftDate(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
app.post("/api/reports/generate", async (req, res) => {
  try {
    const { periodType, periodStart, periodEnd, contactAgingPicks } = req.body || {};
    if (!PERIOD_LABELS[periodType] || !periodStart || !periodEnd) {
      return res.status(400).json({ error: "periodType(weekly/monthly/half/yearly), periodStart, periodEnd 필요" });
    }
    const label = PERIOD_LABELS[periodType];
    // "이전/다음 기간" = 같은 기간 길이만큼 앞/뒤로 이동한 구간 (주간이면 정확히 저번주/다음주,
    // 월/반기/연간은 달력 경계와 살짜 어긋날 수 있지만 보고서 안에 날짜 범위를 그대로 표기하므로 무해함)
    const spanDays = daysBetween(periodStart, periodEnd) + 1;
    const prevStart = shiftDate(periodStart, -spanDays);
    const prevEnd = shiftDate(periodEnd, -spanDays);
    const nextStart = shiftDate(periodEnd, 1);
    const nextEnd = shiftDate(periodEnd, spanDays);

    // 1. 채권추심현황 — 브랜드별 잔액(현재 시점 스냅샷) + 기간 내 입금액
    const brandTotals = db.prepare(`
      SELECT brand_code AS brandCode, MAX(brand_name) AS brandName,
             SUM(principal_balance) AS totalPrincipal,
             SUM(final_balance_legal) AS balance
      FROM v_debtors GROUP BY brand_code
    `).all();
    const brandCollectedRows = db.prepare(`
      SELECT d.brand_code AS brandCode, SUM(p.total_amount) AS periodCollected
      FROM payments p JOIN debtors d ON d.id = p.debtor_id
      WHERE p.payment_date >= ? AND p.payment_date <= ?
      GROUP BY d.brand_code
    `).all(periodStart, periodEnd);
    const collectedMap = new Map(brandCollectedRows.map(r => [r.brandCode, r.periodCollected]));
    const brands = brandTotals.map(b => ({ ...b, periodCollected: collectedMap.get(b.brandCode) || 0 }));

    // 2. 주요현안
    const forcedExecOverdue = getKvArray("manual_forced_executions")
      .filter(r => r && !r.deleted && !r.completed && r.registeredDate && daysBetween(r.registeredDate, periodEnd) >= 7)
      .map(r => ({ debtorName: r.debtorName, brand: r.brand, assignee: r.assignee, registeredDate: r.registeredDate, daysElapsed: daysBetween(r.registeredDate, periodEnd) }));

    const creditCheckOverdue = getKvArray("manual_credit_analyses")
      .filter(r => r && !r.deleted && !r.completed && !r.checkDate && r.requestDate && daysBetween(r.requestDate, periodEnd) >= 7)
      .map(r => ({ target: r.target, brand: r.brand, assignee: r.assignee, requestDate: r.requestDate, daysElapsed: daysBetween(r.requestDate, periodEnd) }));

    const debtorNameById = new Map(db.prepare("SELECT id, name FROM debtors").all().map(d => [d.id, d.name]));
    const negotiations = getKvArray("manual_negotiations")
      .filter(r => r && !r.deleted)
      .map(r => ({ debtorName: debtorNameById.get(r.debtorId) || r.debtorId, note: r.note }));

    const todoAll = getKvArray("manual_todo_list").filter(r => r && !r.deleted);
    const todoRegistered = todoAll
      .filter(r => r.createdAt && r.createdAt >= periodStart && r.createdAt <= periodEnd)
      .map(r => ({ assignee: r.assignee, task: r.task, priority: r.priority, createdAt: r.createdAt }));
    const todoCompleted = todoAll
      .filter(r => r.status === "완료" && r.completedAt && r.completedAt >= periodStart && r.completedAt <= periodEnd)
      .map(r => ({ assignee: r.assignee, task: r.task, priority: r.priority, completedAt: r.completedAt }));

    const nextPeriodSchedule = getKvArray("manual_monthly_schedule")
      .filter(r => r && !r.deleted && r.date && r.date <= nextEnd && (r.endDate || r.date) >= nextStart)
      .map(r => ({ date: r.date, endDate: r.endDate, type: r.type, text: r.text }));

    // 3. 채무자관리 — "히스토리 경과기간 오래된 채무자" 담당자별 무작위 5명은 채무자
    // CONTACT 현황(엑셀 원본 히스토리 + localStorage/kv_store 수동기록)을 기준으로 하는데
    // 이 데이터가 프론트에만 있어(서버 DB에 없음), 프론트에서 미리 계산해 보낸 값을 그대로 쓴다.
    const contactAgingByAssignee = Array.isArray(contactAgingPicks) ? contactAgingPicks : [];

    const installmentRowsFor = (from, to) => db.prepare(`
      SELECT s.due_date AS dueDate, s.scheduled_amount AS scheduledAmount, s.paid_amount AS paidAmount,
             s.status, d.name AS debtorName, d.assignee
      FROM installment_schedules s
      JOIN installment_plans p ON s.plan_id = p.id
      JOIN debtors d ON p.debtor_id = d.id
      WHERE s.due_date >= ? AND s.due_date <= ?
    `).all(from, to);
    const installmentOverduePrevPeriod = installmentRowsFor(prevStart, prevEnd).filter(r => r.status === "미납" || r.status === "지연");
    const installmentThisPeriod = installmentRowsFor(periodStart, periodEnd).filter(r => r.status === "미납" || r.status === "지연");

    // 4. 민사소송·법적절차 — 엑셀에서 임포트된 소송 마스터 데이터(대부분의 실제 사건)는
    // 프론트에만 번들되어 있어 백엔드가 볼 수 없다. 이 화면에서 기간 내 새로 등록한 사건과,
    // 사건 진행상황 메모(사건 종류·데이터 출처와 무관하게 전부 kv_store에 기록됨)만 근거로 삼는다.
    const newMinsaCases = getKvArray("manual_minsa_cases")
      .filter(r => r && !r.deleted && r.filingDate && r.filingDate >= periodStart && r.filingDate <= periodEnd)
      .map(r => ({ name: r.defendant || "-", caseNumber: r.caseNumber, filingDate: r.filingDate, progressStatus: r.progressStatus }));
    const newLegalCases = getKvArray("manual_legal_cases")
      .filter(r => r && !r.deleted && r.filingDate && r.filingDate >= periodStart && r.filingDate <= periodEnd)
      .map(r => ({ name: r.defendant || "-", type: r.type || "-", filingDate: r.filingDate }));
    const newAssetDisclosures = getKvArray("manual_asset_disclosures")
      .filter(r => r && !r.deleted && r.applicationDate && r.applicationDate >= periodStart && r.applicationDate <= periodEnd)
      .map(r => ({ name: r.debtorName || "-", applicationDate: r.applicationDate }));
    const complaintsInPeriod = db.prepare(`
      SELECT c.complaint_date AS complaintDate, d.name AS debtorName
      FROM complaints c JOIN debtors d ON d.id = c.debtor_id
      WHERE c.complaint_date >= ? AND c.complaint_date <= ?
    `).all(periodStart, periodEnd);
    const caseNoteRows = db.prepare("SELECT key, value FROM kv_store WHERE key LIKE 'case_notes_%'").all();
    let caseNoteCount = 0;
    const caseNoteSamples = [];
    for (const row of caseNoteRows) {
      let arr;
      try { arr = JSON.parse(row.value); } catch { continue; }
      if (!Array.isArray(arr)) continue;
      const inPeriod = arr.filter(n => n && n.createdAt && n.createdAt.slice(0, 10) >= periodStart && n.createdAt.slice(0, 10) <= periodEnd);
      if (inPeriod.length > 0) {
        caseNoteCount += inPeriod.length;
        for (const n of inPeriod.slice(0, 2)) caseNoteSamples.push(String(n.content || "").slice(0, 90));
      }
    }

    // 5. 추심목표관리 — 담당자별 목표(manual_assignee_targets, 월/연 고정값) 대비 이번 기간 실적.
    // 목표는 "월" 기준 고정값이라 기간이 1개월이 아니면(주간/반기/연간) 기간 길이에 비례 배분한다.
    const assigneeTargetsList = getKvArray("manual_assignee_targets");
    const periodCollectedByAssignee = db.prepare(`
      SELECT assignee, SUM(total_amount) AS collected FROM (
        SELECT COALESCE(
                 (SELECT ah.assignee FROM assignee_history ah
                   WHERE ah.debtor_id = d.id AND ah.effective_date <= p.payment_date
                   ORDER BY ah.effective_date DESC, ah.id DESC LIMIT 1),
                 d.assignee
               ) AS assignee,
               p.total_amount
        FROM payments p JOIN debtors d ON d.id = p.debtor_id
        WHERE p.payment_date >= ? AND p.payment_date <= ?
      ) GROUP BY assignee
    `).all(periodStart, periodEnd);
    const collectedMapByAssignee = new Map(periodCollectedByAssignee.map(r => [r.assignee, r.collected || 0]));
    const targetProrated = assigneeTargetsList
      .filter(t => t && t.assignee && (t.monthlyTarget || t.annualTarget))
      .map(t => {
        const monthlyTarget = t.monthlyTarget || 0;
        const proratedTarget = periodType === "yearly" ? (t.annualTarget || monthlyTarget * 12)
          : periodType === "half" ? monthlyTarget * 6
          : monthlyTarget * (spanDays / 30);
        const collected = collectedMapByAssignee.get(t.assignee) || 0;
        const achieveRate = proratedTarget > 0 ? (collected / proratedTarget) * 100 : null;
        return { assignee: t.assignee, target: Math.round(proratedTarget), collected, achieveRate };
      });

    // 6. 종합현황 — 단순 건수 요약이 아니라 실제 내용(히스토리 문구·구체 항목)을 근거로 AI가 판단
    // (잘된 점/우려되는 점/체크할 사항)을 내리도록, 건수뿐 아니라 실제 항목 샘플까지 프롬프트에 싣는다.
    const histRows = db.prepare("SELECT key, value FROM kv_store WHERE key LIKE 'hist_m_%'").all();
    let histCount = 0, histDebtorCount = 0;
    const histSamples = [];
    for (const row of histRows) {
      let arr;
      try { arr = JSON.parse(row.value); } catch { continue; }
      if (!Array.isArray(arr)) continue;
      const inPeriod = arr.filter(h => h && h.createdAt && h.createdAt.slice(0, 10) >= periodStart && h.createdAt.slice(0, 10) <= periodEnd);
      if (inPeriod.length > 0) {
        histCount += inPeriod.length; histDebtorCount++;
        const debtorId = row.key.slice("hist_m_".length);
        const dName = debtorNameById.get(debtorId) || debtorId;
        for (const h of inPeriod.slice(0, 3)) histSamples.push(`${dName}: ${String(h.content || "").slice(0, 90)}`);
      }
    }
    // "차주 주요체크사항"용 — 채무자 히스토리 본문에 언급된 날짜(절대/상대 표현)를 훑어
    // 다음 기간(nextStart~nextEnd) 안에 걸리는 약속(예: "다음주 화요일 통화하기로 함",
    // "8/25까지 입금하기로 함")만 골라낸다. 히스토리 리마인드 알림(rule6)과 같은 스캐너를
    // windowDays 대신 명시적 날짜 범위로 재사용.
    const nextPeriodPromises = scanHistoryPromises(db, { rangeStart: nextStart, rangeEnd: nextEnd });

    // type 필터 없이 세면 60초 간격 heartbeat 핑까지 다 합산돼, 실제 작업량이 아니라
    // 그냥 화면을 오래 켜둔 사람이 "활동이 가장 활발하다"로 잘못 나온다 — 다른 통계 화면
    // (사용자별 데이터 입력량)과 동일하게 실제 저장 액션(data_input)만 센다.
    const activityByUser = db.prepare(`
      SELECT user_name, COUNT(*) AS cnt FROM user_activity_log
      WHERE type='data_input' AND ts >= ? AND ts <= ? AND user_name != '알수없음' AND user_name NOT LIKE '%�%'
      GROUP BY user_name ORDER BY cnt DESC LIMIT 10
    `).all(`${periodStart} 00:00:00`, `${periodEnd} 23:59:59`);

    const lines = (arr, fmt, limit = 30) => (arr && arr.length) ? arr.slice(0, limit).map(fmt).join("\n") : "없음";
    const digest = `
[채권추심현황]
${lines(brands, b => `- ${b.brandName || b.brandCode}: 잔액 ${Number(b.balance || 0).toLocaleString("ko-KR")}원, 기간입금 ${Number(b.periodCollected || 0).toLocaleString("ko-KR")}원`)}

[강제집행 대상자 중 등록 1주 이상 미완료] (${forcedExecOverdue.length}건)
${lines(forcedExecOverdue, r => `- ${r.debtorName} (${r.brand || "-"}, 담당 ${r.assignee || "-"}) 등록 ${r.daysElapsed}일 경과`)}

[신용분석 대상자 중 요청 1주 이상 미조회] (${creditCheckOverdue.length}건)
${lines(creditCheckOverdue, r => `- ${r.target} (${r.brand || "-"}, 담당 ${r.assignee || "-"}) 요청 ${r.daysElapsed}일 경과`)}

[주요협의 대상자] (${negotiations.length}건)
${lines(negotiations, n => `- ${n.debtorName}: ${n.note || "-"}`)}

[${label} 등록된 업무] (${todoRegistered.length}건)
${lines(todoRegistered, t => `- [${t.priority}] ${t.task} (${t.assignee || "-"})`)}

[${label} 완료된 업무] (${todoCompleted.length}건)
${lines(todoCompleted, t => `- [${t.priority}] ${t.task} (${t.assignee || "-"})`)}

[다음 기간 주요일정] (${nextPeriodSchedule.length}건)
${lines(nextPeriodSchedule, s => `- ${s.date}${s.endDate && s.endDate !== s.date ? `~${s.endDate}` : ""} [${s.type}] ${s.text}`)}

[히스토리 경과기간 오래된 채무자 — 담당자별 샘플] (담당자 ${contactAgingByAssignee.length}명)
${lines(contactAgingByAssignee, g => `- ${g.assignee}: ${g.picks.map(p => `${p.name}(${p.agingDays}일)`).join(", ")}`)}

[이전 기간 분할상환 미입금] (${installmentOverduePrevPeriod.length}건)
${lines(installmentOverduePrevPeriod, r => `- ${r.debtorName}(${r.assignee || "-"}) 예정 ${Number(r.scheduledAmount || 0).toLocaleString("ko-KR")}원 중 ${Number(r.paidAmount || 0).toLocaleString("ko-KR")}원 납부 [${r.status}]`)}

[${label} 분할상환 미입금 현황] (${installmentThisPeriod.length}건)
${lines(installmentThisPeriod, r => `- ${r.debtorName}(${r.assignee || "-"}) ${r.dueDate} [${r.status}]`)}

[민사소송 — 이번 기간 신규 접수] (${newMinsaCases.length}건)
${lines(newMinsaCases, r => `- ${r.name} (${r.caseNumber || "-"}) 접수 ${r.filingDate} [${r.progressStatus || "-"}]`)}

[법적절차 — 이번 기간 신규 접수] (지급명령·압류 ${newLegalCases.length}건, 재산명시·재산조회 ${newAssetDisclosures.length}건, 형사고소 ${complaintsInPeriod.length}건)
${lines(newLegalCases, r => `- ${r.name} (${r.type}) 접수 ${r.filingDate}`)}
${lines(newAssetDisclosures, r => `- ${r.name} 신청 ${r.applicationDate}`)}
${lines(complaintsInPeriod, r => `- ${r.debtorName} 고소일 ${r.complaintDate}`)}

[민사소송·법적절차 — 사건 진행상황 메모] (${caseNoteCount}건, 사건 종류·등록 경로 무관 전체)
${lines(caseNoteSamples, s => `- ${s}`, 20)}

[추심목표관리] (담당자 ${targetProrated.length}명 목표 설정)
${lines(targetProrated, t => `- ${t.assignee}: 목표 ${t.target.toLocaleString("ko-KR")}원 대비 실적 ${t.collected.toLocaleString("ko-KR")}원 (달성률 ${t.achieveRate != null ? t.achieveRate.toFixed(1) + "%" : "-"})`)}

[채무자 히스토리 샘플] (총 ${histCount}건, ${histDebtorCount}명)
${lines(histSamples, s => `- ${s}`, 40)}

[CMS 사용] ${activityByUser.map(u => `${u.user_name} ${u.cnt}건`).join(", ") || "기록 없음"}

[채무자 히스토리 — 차주(${nextStart}~${nextEnd}) 언급된 약속] (${nextPeriodPromises.length}건)
${lines(nextPeriodPromises, p => `- ${p.debtorName}: ${p.resolvedDate} "${p.snippet}" [${p.source}]`, 30)}
`.trim();

    let overviewRows, nextPeriodChecklist;
    const openaiClient = getOpenAIClient();
    if (openaiClient) {
      const prompt = `아래는 ${label} 보고서(${periodStart}~${periodEnd})의 실제 데이터입니다. 건수를 그대로 나열하지 말고, 데이터 안의 구체적인 이름·내용을 근거로 "잘 진행된 점"과 "우려되거나 놓친 점"을 실제로 판단해서 짚어주세요. 근거 없는 내용은 절대 지어내지 말고, 판단할 근거가 없으면 "특이사항 없음"이라고 쓰세요.

다음 6개 구분에 대해 각각 판단하세요:
1) 채무자 히스토리 — 협상·약속 이행, 연락 상태 등에서 잘된 점/우려되는 점
2) 주요현안 — 강제집행·신용조회 지연 대응, 업무 등록·완료 속도에서 잘된 점/놓친 점
3) 주요일정 — 다음 기간 일정 관련 체크할 사항
4) CMS 사용 — 담당자 간 활동 편중이나 저활동 등 특이 패턴(활동량으로 성과 순위를 매기지는 마세요)
5) 민사소송·법적절차 — 이번 기간 신규 접수·사건 진행상황 메모에서 잘된 점/우려되는 점. 단 여기 실린 데이터는 "이번 기간 신규 등록·메모"만이고 기존에 진행 중인 전체 소송 건수를 반영하지 않으니, 그 범위를 벗어난 판단(예: 전체 소송 현황이 어떻다는 식)은 하지 마세요
6) 추심목표관리 — 담당자별 목표 대비 실적 달성률에서 잘된 점/우려되는 점. 목표가 설정된 담당자가 없으면 "목표 미설정"이라고 쓰세요

그리고 별도로 "차주 주요체크사항"을 작성하세요 — 위 데이터 전체(주요현안의 미완료 항목, 채무자관리의 히스토리 경과기간 오래된 채무자·분할상환 미입금, 민사소송·법적절차 진행상황, 다음 기간 일정, 그리고 채무자 히스토리에 언급된 차주 약속)를 종합해서, 다음 기간에 실제로 체크하고 진행해야 할 구체적인 항목을 5~10개의 짧은 문장으로 만드세요. 각 항목은 누구를/무엇을 왜 확인·진행해야 하는지가 드러나야 하고, 특히 채무자 히스토리에 언급된 차주 약속(예: 누구와 통화하기로 함, 언제까지 입금하기로 함)이 있으면 반드시 포함하세요. 근거 없는 항목은 만들지 말고, 체크할 게 없으면 ["특이사항 없음"] 하나만 담으세요.

반드시 아래 JSON 형식으로만, 다른 말 없이 답하세요:
{"rows":[{"category":"채무자 히스토리","good":"...","concern":"...","checkpoint":"..."},{"category":"주요현안","good":"...","concern":"...","checkpoint":"..."},{"category":"주요일정","good":"...","concern":"...","checkpoint":"..."},{"category":"CMS 사용","good":"...","concern":"...","checkpoint":"..."},{"category":"민사소송·법적절차","good":"...","concern":"...","checkpoint":"..."},{"category":"추심목표관리","good":"...","concern":"...","checkpoint":"..."}],"checklist":["...", "..."]}

[데이터]
${digest}`;
      try {
        const completion = await openaiClient.chat.completions.create({
          model: "gpt-4o-mini",
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "당신은 채권관리 조직의 보고서 작성 보조자입니다. 한국어로, 주어진 데이터 범위 안에서만 근거를 갖고 판단해 답하세요." },
            { role: "user", content: prompt },
          ],
          max_tokens: 1100,
          temperature: 0.3,
        });
        const parsed = JSON.parse(completion.choices[0].message.content);
        overviewRows = Array.isArray(parsed.rows) ? parsed.rows : [];
        nextPeriodChecklist = Array.isArray(parsed.checklist) ? parsed.checklist : [];
      } catch (e) {
        overviewRows = [{ category: "종합현황", good: "-", concern: "-", checkpoint: "AI 종합현황 생성 실패: " + e.message }];
        nextPeriodChecklist = ["AI 차주 체크사항 생성 실패: " + e.message];
      }
    } else {
      overviewRows = [{ category: "종합현황", good: "-", concern: "-", checkpoint: "OPENAI_API_KEY 미설정 — 종합현황은 생성되지 않았습니다" }];
      nextPeriodChecklist = ["OPENAI_API_KEY 미설정 — 차주 주요체크사항은 생성되지 않았습니다"];
    }

    const content = JSON.stringify({
      collection: { brands },
      issues: { forcedExecOverdue, creditCheckOverdue, negotiations, todoRegistered, todoCompleted, nextPeriodSchedule },
      debtorMgmt: { contactAgingByAssignee, installmentOverduePrevPeriod, installmentThisPeriod },
      overview: overviewRows,
      checklist: nextPeriodChecklist,
    });
    const title = `${label} 보고서 (${periodStart} ~ ${periodEnd})`;
    const createdBy = extractUserName(req);
    const info = db.prepare(
      "INSERT INTO ai_reports (period_type, period_start, period_end, title, content, created_by) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(periodType, periodStart, periodEnd, title, content, createdBy === "알수없음" ? null : createdBy);
    const saved = db.prepare("SELECT * FROM ai_reports WHERE id = ?").get(info.lastInsertRowid);
    res.json(saved);
  } catch (err) {
    console.error("report generate error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// 보고서 목록 — 검색은 프론트에서 처리
app.get("/api/reports", (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM ai_reports ORDER BY id DESC LIMIT 300").all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/reports/:id", (req, res) => {
  try {
    db.prepare("DELETE FROM ai_reports WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

const ANALYSIS_MARKER = "[채무자 및 연대보증인 종합분석]";

// 채무자+연대보증인 종합분석 텍스트 생성 (OpenAI 호출만, DB 저장은 호출부 책임).
// 단건 API(/api/debtor/:id/analysis)와 일괄 재생성 배치가 이 함수를 공유한다.
async function generateDebtorAnalysisText(debtorId, priority) {
  const openaiClient = getOpenAIClient();
  if (!openaiClient) return { ok: false, error: "OPENAI_API_KEY 미설정" };
  try {
    const d = db.prepare("SELECT * FROM debtors WHERE id = ?").get(debtorId);
    if (!d) return { ok: false, error: "채무자 없음" };

    const guarantorRows = db.prepare("SELECT id, name, cb_match_excluded FROM debtor_guarantors WHERE debtor_id = ?").all(d.id);
    const guarantorNames = guarantorRows.map(r => r.name);
    const acts = db.prepare("SELECT * FROM activities WHERE debtor_id=? ORDER BY activity_date DESC LIMIT 20").all(d.id);
    const seizures = db.prepare("SELECT * FROM seizure_cases WHERE debtor_id=? ORDER BY created_at DESC LIMIT 5").all(d.id);
    const rehabs = db.prepare("SELECT * FROM rehabilitations WHERE debtor_id=? ORDER BY id DESC LIMIT 3").all(d.id);
    const complaints = db.prepare("SELECT * FROM complaints WHERE debtor_id=? ORDER BY complaint_date DESC LIMIT 3").all(d.id);
    const pays = db.prepare("SELECT * FROM payments WHERE debtor_id=? ORDER BY payment_date DESC LIMIT 10").all(d.id);
    const installs = db.prepare("SELECT * FROM installment_plans WHERE debtor_id=? ORDER BY id DESC LIMIT 1").all(d.id);

    const fmt = v => v != null ? Number(v).toLocaleString("ko-KR") : "0";
    const totalPaid = pays.reduce((s, p) => s + (p.total_amount || 0), 0);
    // 법인 채무자는 개인 CB 신용점수 자체가 없는 게 정상이므로, credit_grade가 비어있어도
    // "확인 안됨/즉시 조회 필요"로 잘못 플래그되지 않도록 구분한다.
    const isCorporate = /㈜|주식회사|\(주\)/.test(d.name || "");

    // 연대보증인 신용점수 — CB보고서에서 라이브 OCR (best-effort, 못 찾아도 무시)
    // /api/debtor/:id/credit-score와 같은 findCreditScoreForName을 공유해서, 두 화면이
    // 서로 다른 파일을 골라 서로 다른 점수를 보여주는 일이 없도록 한다.
    const guarantorScores = [];
    for (const g of guarantorRows) {
      if (g.cb_match_excluded) continue; // 동명이인 데이터로 확인되어 제외된 항목 — 근거로 쓰지 않음
      const result = await findCreditScoreForName(g.name, 3, priority);
      if (!result) continue;
      // 이 연대보증인과 이름이 같은 다른 채무자가 이미 있으면(동명이인), 완전일치로 찾은
      // CB 파일이라도 그 사람 것일 수 있다 — /credit-score API와 동일하게 함께 확인한다.
      const ambiguous = result.ambiguous || hasNameCollision(d.id, g.name);
      // ambiguous=true면 동명이인 CB 파일이 섞여있을 수 있다는 뜻이라, AI가 그 점수를
      // 근거로 단정하지 않도록 함께 표시한다 (점수 자체는 참고용으로 남겨둠).
      guarantorScores.push(`${g.name}: ${result.score}점${ambiguous ? " (동명이인 파일 혼재 가능 — 확인 필요)" : ""}`);
    }

    const contextText = `
[채무자 기본정보]
이름: ${d.name} | 브랜드: ${d.brand_code || "-"} | 담당자: ${d.assignee || "-"} | 수금상태: ${d.collection_status || "-"}
원금: ${fmt(d.principal_balance)}원 | 회수액: ${fmt(d.collected_amount)}원 | 법무기준잔액: ${fmt(d.final_balance_legal)}원
채무발생원인: ${d.debt_cause || "-"} | 대여일자: ${d.loan_date || "-"}
${isCorporate ? "채무자 유형: 법인 (개인 CB 신용점수 대상 아님)" : `채무자 신용점수: ${d.cb_match_excluded ? "확인 안됨 (동명이인으로 제외됨)" : (d.credit_grade || "확인 안됨")}`}
연대보증인: ${guarantorNames.length ? guarantorNames.join(", ") : "없음"}
연대보증인 신용점수: ${guarantorScores.length ? guarantorScores.join(" / ") : "확인 안됨"}

[입금 현황]
총 입금액: ${fmt(totalPaid)}원 (${pays.length}건)
${pays.length > 0 ? pays.slice(0, 5).map(p => `  ${p.payment_date} ${fmt(p.total_amount)}원`).join("\n") : "  입금 내역 없음"}

[분납약정]
${installs.length === 0 ? "없음" : installs.map(i => `월 ${fmt(i.monthly_amount)}원 | 상태: ${i.status}`).join("\n")}

[법적절차내역]
압류: ${seizures.length === 0 ? "없음" : seizures.map(s => `법원 ${s.court || "-"} 사건번호 ${s.case_number || "-"} 상태 ${s.status || "-"}`).join(" / ")}
회생파산: ${rehabs.length === 0 ? "없음" : rehabs.map(r => `${r.type || "-"} 사건번호 ${r.case_number || "-"} 법원 ${r.court || "-"}`).join(" / ")}
형사고소: ${complaints.length === 0 ? "없음" : complaints.map(c => `${c.complaint_date} ${c.police_station || "-"} ${c.status_note || "-"}`).join(" / ")}

[히스토리 (최근 20건)]
${acts.length === 0 ? "없음" : acts.map(a => `${a.activity_date} [${a.activity_type || "-"}] ${a.content || ""}`).join("\n")}
`.trim();

    const systemPrompt = `당신은 NPL 채권관리 전문가입니다. 아래 채무자/연대보증인 데이터를 종합적으로 검토하고,
향후 채권 회수를 위해 담당자가 어떤 부분을 체크하거나 조치해야 할지 핵심만 뽑아서 정리하세요.
- 반드시 줄글(서술형 문장)이 아니라, 짧은 핵심 항목들의 목록으로 작성하세요. 각 줄은 "- "로 시작하고,
  완결된 문장이 아니라 명사형/짧은 구 단위로 끝내세요 (예: "- 신용점수 확인 필요", "- 최근 3개월 입금 없음").
- 신용점수, 법적절차내역, 히스토리(추심 활동 기록)를 근거로 판단하세요.
- 채무자 유형이 "법인"이면 법인은 개인 CB 신용점수 대상이 아니므로 채무자 신용점수 관련 항목은
  만들지 마세요(연대보증인 신용점수는 정상적으로 다루세요).
- 연대보증인 신용점수에 "(동명이인 파일 혼재 가능 — 확인 필요)"가 붙어있으면, 그 점수를 확정된
  값처럼 인용하지 말고 "동명이인 파일과 섞였을 수 있어 재확인 필요"로만 언급하세요.
- 채무자와 연대보증인 항목을 구분해서 각각 나열하세요.
- 항목 중 특히 긴급하거나 중요하다고 판단되는 것은 그 항목 전체를 **와 ** 사이에 넣어서 표시하세요
  (예: "- **연대보증인 신용점수 확인 안됨, 즉시 조회 필요**"). 모든 항목을 강조하지 말고 정말 중요한 것만 표시하세요.
- 항목 수는 5~8개 정도로 제한하세요. 인사말/서론/결론 문단은 쓰지 마세요.
- **와 ** 외의 다른 마크다운 기호(#, *, \` 등)는 쓰지 마세요.
- 한국어로 작성하세요.`;

    const completion = await openaiClient.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: contextText },
      ],
      max_tokens: 700,
      temperature: 0.3,
    });

    return { ok: true, text: completion.choices[0].message.content.trim() };
  } catch (err) {
    console.error("종합분석 오류:", err.message);
    return { ok: false, error: err.message };
  }
}

app.post("/api/debtor/:id/analysis", async (req, res) => {
  const result = await generateDebtorAnalysisText(req.params.id);
  res.status(result.ok ? 200 : (result.error === "OPENAI_API_KEY 미설정" ? 503 : 500)).json(result);
});

// 기존 기타사항(key_notes)의 마커 이전 텍스트는 보존하고, 마커 이후(AI 종합분석 블록)만 교체한다.
// 프론트(DebtorDetail.runAnalysis)와 동일한 병합 규칙 — 일괄 재생성도 같은 결과가 나오도록 서버에서 재사용.
function mergeAnalysisIntoKeyNotes(existingKeyNotes, analysisText) {
  const cur = existingKeyNotes || "";
  const idx = cur.indexOf(ANALYSIS_MARKER);
  const before = (idx >= 0 ? cur.slice(0, idx) : cur).trim();
  const block = `${ANALYSIS_MARKER}\n${analysisText}`;
  return before ? `${before}\n\n${block}` : block;
}

// 마커 이후 블록에 "- "로 시작하는 줄이 하나도 없으면 예전(줄글/서술형) 프롬프트로 만들어진
// 것으로 간주한다 — 일괄 재생성 대상을 고를 때 이미 단답형인 항목까지 다시 만들어서
// OpenAI 비용을 낭비하지 않기 위한 판별 기준.
function looksLikeOldFormatAnalysis(keyNotes) {
  const idx = (keyNotes || "").indexOf(ANALYSIS_MARKER);
  if (idx < 0) return false;
  const block = keyNotes.slice(idx + ANALYSIS_MARKER.length, idx + ANALYSIS_MARKER.length + 1000);
  return !/\n\s*-\s/.test(block);
}

app.get("/api/debtors/analysis-format-status", (req, res) => {
  try {
    const rows = db.prepare(`SELECT id FROM debtors WHERE key_notes LIKE '%' || ? || '%'`).all(ANALYSIS_MARKER);
    let outdated = 0;
    for (const r of rows) {
      const row = db.prepare("SELECT key_notes FROM debtors WHERE id = ?").get(r.id);
      if (looksLikeOldFormatAnalysis(row.key_notes)) outdated++;
    }
    res.json({ ok: true, total: rows.length, outdated });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

let analysisBatchStatus = { running: false, done: 0, total: 0, startedAt: null, finishedAt: null, error: null };
const ANALYSIS_REGEN_CONCURRENCY = 3; // OpenAI 요청 동시 개수 제한 — 레이트리밋/비용 관리용 보수적 값

app.post("/api/debtors/batch-regenerate-analysis", (req, res) => {
  if (analysisBatchStatus.running) return res.json({ ok: false, error: "이미 실행 중입니다" });
  const targets = db.prepare(`SELECT id, key_notes FROM debtors WHERE key_notes LIKE '%' || ? || '%'`).all(ANALYSIS_MARKER)
    .filter(r => looksLikeOldFormatAnalysis(r.key_notes));
  if (targets.length === 0) return res.json({ ok: true, started: false, message: "서술형으로 남은 항목이 없습니다" });

  analysisBatchStatus = { running: true, done: 0, total: targets.length, startedAt: Date.now(), finishedAt: null, error: null };
  res.json({ ok: true, started: true, total: targets.length });

  runWithConcurrency(targets, async (row) => {
    try {
      const result = await generateDebtorAnalysisText(row.id, "low");
      if (result.ok) {
        const fresh = db.prepare("SELECT key_notes FROM debtors WHERE id = ?").get(row.id);
        const merged = mergeAnalysisIntoKeyNotes(fresh.key_notes, result.text);
        db.prepare("UPDATE debtors SET key_notes = ? WHERE id = ?").run(merged, row.id);
      } else {
        console.error(`[종합분석 일괄재생성] ${row.id} 실패:`, result.error);
      }
    } catch (e) { console.error(`[종합분석 일괄재생성] ${row.id} 오류:`, e.message); }
    analysisBatchStatus.done++;
  }, ANALYSIS_REGEN_CONCURRENCY)
    .then(() => {
      analysisBatchStatus = { ...analysisBatchStatus, running: false, finishedAt: Date.now() };
      console.log(`[종합분석 일괄재생성] 완료 — ${targets.length}건 처리`);
      broadcast("data-changed", { method: "BATCH", path: "/api/debtors/batch-regenerate-analysis", at: Date.now() });
    })
    .catch(e => {
      analysisBatchStatus = { ...analysisBatchStatus, running: false, finishedAt: Date.now(), error: e.message };
      console.error("[종합분석 일괄재생성] 오류:", e.message);
    });
});

app.get("/api/debtors/batch-regenerate-analysis/status", (req, res) => {
  res.json({ ok: true, ...analysisBatchStatus });
});

// 어떤 라우트에도 안 걸린 /api 요청은 응답 없이 매달리는 대신 바로 404를 준다
// (위 SPA 폴백의 next() 누락 같은 문제가 다시 생겨도 요청이 무한 대기하지 않도록 하는 안전망).
app.use("/api", (req, res) => {
  res.status(404).json({ ok: false, error: "not found" });
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
  // 예전에는 서버 부팅 시점에 "오늘이 1일이면" 딱 한 번만 검사했는데, 서버를 재시작하지
  // 않고 몇 달째 켜둔 상태로 두면 그 이후로는 영원히 재검사하지 않아 알림이 끊겼다.
  // sendInstallmentMonthlyNotify 자체가 kv_store에 "이번 달에 이미 보냈는지"를 기록해
  // 중복 발송을 막아주므로, 몇 시간마다 반복 호출해도 안전하다 — 그 안전장치를 활용해
  // 서버를 계속 띄워둔 채로도 매월 1일에 실제로 발송되도록 주기적으로 재확인한다.
  const checkMonthlyInstallmentNotify = () => {
    if (new Date().getDate() === 1) {
      sendInstallmentMonthlyNotify(db).catch(e => console.error("[월간알림] 오류:", e.message));
    }
  };
  setTimeout(checkMonthlyInstallmentNotify, 5000);
  setInterval(checkMonthlyInstallmentNotify, 6 * 60 * 60 * 1000); // 6시간마다 날짜 재확인

  // 알림 규칙 엔진: 서버 시작 20초 후 1회 + 이후 30분마다 평가
  setTimeout(() => { runAlertRules().catch(e => console.error("[알림규칙] 오류:", e.message)); }, 20000);
  setInterval(() => { runAlertRules().catch(e => console.error("[알림규칙] 오류:", e.message)); }, 30 * 60 * 1000);

  // 문서 자동 동기화: 원드라이브 폴더를 주기적으로 재인덱싱하고, 이미 캐시된
  // 초본/CB 주소보다 더 최근 문서가 새로 들어와 있으면 캐시를 지운다(실제 재추출은
  // 담당자가 그 채무자 화면을 여는 순간 기존 자동추출 로직이 처리). 서버 시작
  // 30초 후 1회 + 이후 30분마다. "서류 폴더 경로 설정"이 안 되어 있으면 조용히 스킵.
  const runAutoDocSync = async () => {
    try {
      const result = await runReindex();
      console.log(`[문서 자동동기화] 재인덱싱 완료 (${result.indexed}건)`);
      await runAutoAddressRefreshCheck();
    } catch (e) {
      if (!/경로가 설정/.test(e.message)) console.error("[문서 자동동기화] 오류:", e.message);
    }
  };
  setTimeout(runAutoDocSync, 30000);
  setInterval(runAutoDocSync, 30 * 60 * 1000);

  // 매일 밤 00:00~06:00: 채무자 위치 지도용 주소 배치 추출 + 좌표변환을 조금씩 돌린다.
  // 채무자 수가 많아 하룻밤에 다 못 끝내도 괜찮다 — 대상 쿼리가 매번 "아직 주소/좌표
  // 없는 것"만 골라오므로, runAddressBatch(true)가 06시를 넘기는 순간부터 남은 건
  // 건너뛰고 다음날 밤에 이어서 처리된다. kv_store에 그날 밤 실행 여부를 기록해
  // 15분마다 재확인해도 하룻밤에 중복 시작되지 않는다.
  const checkNightlyAddressBatch = () => {
    if (!isNightWindow()) return;
    if (addressBatchStatus.running) return; // 수동 실행 중이거나 이미 오늘 밤 시작됨
    const dateStr = new Date().toISOString().slice(0, 10);
    const kvKey = `address_batch_night_${dateStr}`;
    if (db.prepare("SELECT value FROM kv_store WHERE key = ?").get(kvKey)) return;
    db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)").run(kvKey, JSON.stringify({ startedAt: new Date().toISOString() }));
    console.log("[주소배치] 야간 자동 실행 시작");
    addressBatchStatus = { running: true, phase: "extract", done: 0, total: 0, startedAt: Date.now(), finishedAt: null, result: null, error: null };
    runAddressBatch(true)
      .then(result => {
        addressBatchStatus = { ...addressBatchStatus, running: false, phase: "done", finishedAt: Date.now(), result };
        console.log(`[주소배치] 야간 자동 실행 완료 — 대상 ${result.targeted}건 중 ${result.extracted}건 추출, 좌표 ${result.geocoded}/${result.geoTargeted}건 변환${result.stoppedForWindow ? " (06시가 되어 중단 — 남은 건 내일 밤 계속)" : ""}`);
        broadcast("data-changed", { method: "BATCH", path: "nightly-address-batch", at: Date.now() });
      })
      .catch(e => {
        addressBatchStatus = { ...addressBatchStatus, running: false, phase: "error", finishedAt: Date.now(), error: e.message };
        console.error("[주소배치] 야간 자동 실행 오류:", e.message);
      });
  };
  setTimeout(checkNightlyAddressBatch, 60000); // 서버 기동 시점이 이미 밤 시간대면 곧바로 시작
  setInterval(checkNightlyAddressBatch, 15 * 60 * 1000);
});
