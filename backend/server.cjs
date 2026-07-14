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
let pdfParse; try { pdfParse = require("pdf-parse"); } catch(e) { pdfParse = null; }
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
    { id: "rule1", name: "분할상환 미납", enabled: 1, trigger_type: "installment_overdue", condition_text: "미납 1회 이상", target: "channel", channel: "#npl-알림", assignee: "" },
    { id: "rule2", name: "회생 변제금 미납", enabled: 1, trigger_type: "rehab_overdue", condition_text: "미납 상태", target: "channel", channel: "#npl-알림", assignee: "" },
    { id: "rule3", name: "고액 잔액", enabled: 1, trigger_type: "high_balance", condition_text: "잔액 1,000만원 초과", target: "dm", channel: "", assignee: "준원" },
    { id: "rule4", name: "신규 입금", enabled: 0, trigger_type: "new_payment", condition_text: "입금 등록 시", target: "channel", channel: "#npl-입금", assignee: "" },
    { id: "rule5", name: "장기 미연락", enabled: 0, trigger_type: "no_contact", condition_text: "30일 이상 활동 없음", target: "dm", channel: "", assignee: "" },
  ];
  const insSeed = db.prepare(`
    INSERT INTO alert_rules (id, name, enabled, trigger_type, condition_text, target, channel, assignee)
    VALUES (@id, @name, @enabled, @trigger_type, @condition_text, @target, @channel, @assignee)
  `);
  db.transaction(() => seedRules.forEach(r => insSeed.run(r)))();
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

// 어드민 통계용: 모든 API 쓰기 요청의 본문 크기를 사용자별로 집계
const insertActivityLog = db.prepare(
  "INSERT INTO user_activity_log (type, user_name, bytes, path) VALUES (?, ?, ?, ?)"
);
const USER_FIELD_CANDIDATES = ["_userName", "userName", "createdByName", "createdBy", "changedBy", "changed_by", "author", "actorName"];
function extractUserName(req) {
  const headerName = req.headers["x-user-name"];
  if (typeof headerName === "string" && headerName.trim()) {
    try { const decoded = decodeURIComponent(headerName).trim(); if (decoded) return decoded; } catch {}
  }
  const body = req.body;
  if (!body || typeof body !== "object") return "알수없음";
  for (const f of USER_FIELD_CANDIDATES) {
    if (typeof body[f] === "string" && body[f].trim()) return body[f].trim();
  }
  return "알수없음";
}
// 로그인 전에도 반복적으로 저장되는 시스템 설정성 키 — 특정 사용자의 "데이터 입력"으로
// 볼 수 없어 통계 집계 대상에서 제외한다 (그래도 실제 저장은 정상 동작함).
const STATS_EXCLUDED_PATHS = ["/api/admin/heartbeat", "/api/kv/app_users"];
app.use((req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && req.path.startsWith("/api/") && !STATS_EXCLUDED_PATHS.includes(req.path)) {
    const userName = extractUserName(req);
    let bytes = 0;
    try { bytes = JSON.stringify(req.body || {}).length; } catch {}
    res.on("finish", () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        try { insertActivityLog.run("data_input", userName, bytes, req.path); } catch {}
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
    // 1순위: 학습된 매핑 확인
    if (b.payerName) {
      const learned = db.prepare("SELECT debtor_id FROM payer_name_mappings WHERE payer_name = ?").get(b.payerName);
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

async function deliverAlert(rule, text) {
  if (!slackNotify) { console.warn(`[알림규칙] Slack 미설정 — "${rule.name}" 발송 건너뜀`); return false; }
  try {
    if (rule.target === "dm" && rule.assignee_slack_id) {
      await slackNotify.chat.postMessage({ channel: rule.assignee_slack_id, text });
      return true;
    }
    if (!NOTIFY_CHANNEL) { console.warn(`[알림규칙] 알림 채널 미설정 — "${rule.name}" 발송 건너뜀`); return false; }
    // DM 대상인데 Slack ID가 등록 안 된 경우, 조용히 누락되지 않도록 채널로 대체 발송
    const prefix = rule.target === "dm"
      ? `*[DM 대상: ${rule.assignee || "미지정"} — Slack ID 미등록, 채널로 대체 발송]*\n`
      : (rule.channel ? `*[${rule.channel}]*\n` : "");
    await slackNotify.chat.postMessage({ channel: NOTIFY_CHANNEL, text: prefix + text });
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
      dueDate: s.due_date, dueMonth: s.due_month, rolledOverTo: s.rolled_over_to,
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
app.post("/api/installments/schedules/:id/rollover", (req, res) => {
  const { newDate, memo, userName } = req.body || {};
  if (!newDate) return res.status(400).json({ ok: false, error: "newDate 필요" });
  const sched = db.prepare("SELECT s.*, p.debtor_id FROM installment_schedules s JOIN installment_plans p ON s.plan_id = p.id WHERE s.id = ?").get(req.params.id);
  if (!sched) return res.status(404).json({ ok: false, error: "일정 없음" });
  const newId = "ISS" + Date.now();
  const newMonth = newDate.slice(0, 7);
  try {
    db.transaction(() => {
      db.prepare("UPDATE installment_schedules SET status = '이월', rolled_over_to = ? WHERE id = ?").run(newId, req.params.id);
      db.prepare("INSERT INTO installment_schedules (id, plan_id, debt_source, institution, loan_amount, interest_rate, due_date, due_month, scheduled_amount, status, memo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '미납', ?)").run(
        newId, sched.plan_id, sched.debt_source, sched.institution, sched.loan_amount, sched.interest_rate,
        newDate, newMonth, sched.scheduled_amount, memo || null
      );
      db.prepare("INSERT INTO installment_schedule_history (schedule_id, plan_id, debtor_id, event_type, from_date, to_date, amount, memo, user_name) VALUES (?, ?, ?, '이월', ?, ?, ?, ?, ?)").run(
        req.params.id, sched.plan_id, sched.debtor_id,
        sched.due_date || sched.due_month, newDate,
        sched.scheduled_amount, memo || null, userName || '관리자'
      );
    })();
    res.json({ ok: true, newScheduleId: newId });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/installments/schedules/:id/memo - 히스토리 메모 추가
app.post("/api/installments/schedules/:id/memo", (req, res) => {
  const { memo, eventType, userName } = req.body || {};
  if (!memo) return res.status(400).json({ ok: false, error: "memo 필요" });
  const sched = db.prepare("SELECT s.*, p.debtor_id FROM installment_schedules s JOIN installment_plans p ON s.plan_id = p.id WHERE s.id = ?").get(req.params.id);
  if (!sched) return res.status(404).json({ ok: false, error: "일정 없음" });
  db.prepare("INSERT INTO installment_schedule_history (schedule_id, plan_id, debtor_id, event_type, from_date, amount, memo, user_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    req.params.id, sched.plan_id, sched.debtor_id,
    eventType || '메모', sched.due_date || sched.due_month,
    sched.scheduled_amount, memo, userName || '관리자'
  );
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

// ── 분할상환 자동 동기화 함수 (워터폴 배분 방식) ──
// 같은 채무자의 여러 일정에 동일 입금액이 중복 매칭되는 것을 방지.
// 플랜 시작일부터 총 입금합 계산 후 오래된 일정부터 순서대로 배분.
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

      // 플랜 시작일 = 첫 일정 해당 월의 1일
      const firstSched = allScheds[0];
      const planStartDate = firstSched.due_date
        ? firstSched.due_date.slice(0, 7) + "-01"
        : (firstSched.due_month || today.slice(0, 7)) + "-01";

      // 플랜 시작일 이후 이 채무자의 총 입금액
      const { total: totalPaid } = db.prepare(`
        SELECT COALESCE(SUM(total_amount), 0) AS total
        FROM payments
        WHERE debtor_id = ? AND payment_date >= ? AND payment_date <= ?
      `).get(plan.debtor_id, planStartDate, today);

      // 최근 입금 목록 (메모 생성용)
      const recentPayments = db.prepare(`
        SELECT payment_date, total_amount FROM payments
        WHERE debtor_id = ? AND payment_date >= ? AND payment_date <= ?
        ORDER BY payment_date ASC
      `).all(plan.debtor_id, planStartDate, today);

      // 워터폴 배분
      let pool = totalPaid || 0;
      const changes = [];

      for (const s of allScheds) {
        const isDue = (s.due_date && s.due_date <= today) ||
                      (!s.due_date && s.due_month && s.due_month <= todayMonth);

        if (!isDue) continue;

        const needed = s.scheduled_amount || 0;

        if (s.status === "완납" && !forceDebtorIds.has(plan.debtor_id)) {
          // 이미 완납 → 예약된 금액만 풀에서 차감, 재처리 안 함
          pool = Math.max(0, pool - needed);
          continue;
        }

        let allocated = 0;
        let newStatus;

        if (needed > 0) {
          allocated = Math.min(pool, needed);
          pool -= allocated;
          if (allocated >= needed)      newStatus = "완납";
          else if (allocated > 0)       newStatus = "일부납";
          else                          newStatus = "미납";
        } else {
          // scheduled_amount 없는 경우
          newStatus = pool > 0 ? "완납" : "미납";
        }

        const paidAmtToStore = allocated > 0 ? allocated : (s.paid_amount || 0);
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
      if (payChanges.length > 0 && recentPayments.length > 0) {
        const lastPay = recentPayments[recentPayments.length - 1];
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
    fireEventAlert("new_debtor", { debtorName: b.name || "", brand: b.brand || "" }).catch(() => {});
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
    db.prepare("DELETE FROM complaint_history WHERE complaint_id IN (SELECT id FROM complaints WHERE debtor_id = ?)").run(id);
    db.prepare("DELETE FROM complaints WHERE debtor_id = ?").run(id);
    db.prepare("DELETE FROM debtors WHERE id = ?").run(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── 채무자 정보 수정 ────────────────────────────
app.patch("/api/debtors/:id", (req, res) => {
  try {
    const { id } = req.params;
    const _userName = req.body._userName || '관리자';

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
    const fieldLabels = {
      category:"분류",assignee:"담당자",name:"채무자명",phone:"연락처",
      hubCode:"코드",hubName:"허브/지점",debtCause:"채무발생원인",collectionStatus:"추심상태",
      execTitle:"집행권원",execTitleUrl:"집행권원PDF",loanDate:"대여일자",
      subrogationMonth:"대위변제월",subrogationDocUrl:"대위변제증명서PDF",
      creditCheck:"신용조회일자",creditGrade:"신용점수",creditReportUrl:"CB종합보고서PDF",
      residentCopy:"주민등록초본",residentCopyUrl:"주민등록초본PDF",
      birthDate:"생년월일",residentNumber:"주민등록번호",
      salesRep:"영업담당자",keyNotes:"주요사항",
      principalBalance:"원채무액",adjustment:"추가법무비용",collectedAmount:"회수액",
    };

    const fields = [], vals = [], changedJsKeys = [];
    for (const [jsKey, dbCol] of Object.entries(fieldMap)) {
      if (jsKey === '_userName') continue;
      if (req.body[jsKey] !== undefined) {
        fields.push(`${dbCol} = ?`);
        vals.push(req.body[jsKey]);
        changedJsKeys.push(jsKey);
      }
    }
    if (fields.length === 0 && req.body.guarantors === undefined) return res.json({ ok: true });

    // 수정 전 현재 값 조회 (로그 기록용)
    let oldRow = null;
    if (fields.length > 0) {
      const selectParts = Object.entries(fieldMap).map(([jk, dbCol]) => `${dbCol} AS "${jk}"`).join(', ');
      oldRow = db.prepare(`SELECT name, ${selectParts} FROM debtors WHERE id = ?`).get(id);
    }

    if (fields.length > 0) {
      fields.push("updated_at = datetime('now','localtime')");
      vals.push(id);
      db.prepare(`UPDATE debtors SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
    }

    // 변경 항목을 debtor_edit_log에 기록
    if (oldRow && changedJsKeys.length > 0) {
      const debtorName = changedJsKeys.includes('name') ? String(req.body.name || '') : String(oldRow.name || '');
      const insLog = db.prepare(
        "INSERT INTO debtor_edit_log (debtor_id, debtor_name, changed_by, field_name, field_label, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      const logTx = db.transaction(() => {
        for (const jsKey of changedJsKeys) {
          const oldVal = String(oldRow[jsKey] ?? '');
          const newVal = String(req.body[jsKey] ?? '');
          if (oldVal !== newVal) {
            insLog.run(id, debtorName, _userName, jsKey, fieldLabels[jsKey] || jsKey, oldVal, newVal);
          }
        }
      });
      logTx();
    }

    // 연대보증인 업데이트 (기존 삭제 후 재삽입)
    if (req.body.guarantors !== undefined) {
      const guarantors = Array.isArray(req.body.guarantors) ? req.body.guarantors : [];
      db.prepare("DELETE FROM debtor_guarantors WHERE debtor_id = ?").run(id);
      const insG = db.prepare("INSERT INTO debtor_guarantors (debtor_id, name) VALUES (?, ?)");
      for (const g of guarantors.filter(n => n && String(n).trim())) insG.run(id, String(g).trim());
    }

    // "추심상태 변경" 알림 규칙 즉시 평가
    if (oldRow && changedJsKeys.includes("collectionStatus") && String(oldRow.collectionStatus ?? "") !== String(req.body.collectionStatus ?? "")) {
      const debtorName = changedJsKeys.includes('name') ? String(req.body.name || '') : String(oldRow.name || '');
      fireEventAlert("status_change", { debtorName, oldStatus: oldRow.collectionStatus, newStatus: req.body.collectionStatus }).catch(() => {});
    }

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

// 파일 인덱스 재구성 (워커 스레드에서 실행 — 이벤트 루프 비차단)
app.post("/api/admin/reindex", (req, res) => {
  try {
    const rootRow = db.prepare("SELECT value FROM kv_store WHERE key='docs_scan_root'").get();
    if (!rootRow || !rootRow.value) return res.status(400).json({ ok: false, error: "스캔 폴더 경로가 설정되지 않았습니다" });

    const { Worker } = require("worker_threads");
    const scannerPath = require.resolve("./fileScanner.cjs");
    const rootPath    = rootRow.value;

    const workerCode = `
      const { workerData, parentPort } = require('worker_threads');
      const { indexAllFiles } = require(workerData.scannerPath);
      parentPort.postMessage(indexAllFiles(workerData.rootPath));
    `;
    const worker = new Worker(workerCode, { eval: true, workerData: { scannerPath, rootPath } });
    const timer  = setTimeout(() => { worker.terminate(); res.status(408).json({ ok: false, error: "인덱싱 시간 초과 (3분)" }); }, 180000);

    worker.on("message", result => {
      clearTimeout(timer);
      if (!result.ok) return res.status(500).json(result);
      const ins = db.prepare(`INSERT OR REPLACE INTO file_index
        (file_path,filename,folder_name,rel_path,parsed_date,parsed_direction,parsed_person_name,doc_type,ext)
        VALUES (?,?,?,?,?,?,?,?,?)`);
      db.transaction(() => {
        db.prepare("DELETE FROM file_index").run();
        for (const f of result.files) ins.run(f.filePath,f.filename,f.folderName,f.relPath,f.parsedDate,f.parsedDirection,f.parsedPersonName,f.docType,f.ext);
      })();
      res.json({ ok: true, indexed: result.files.length });
    });
    worker.on("error", err => { clearTimeout(timer); res.status(500).json({ ok: false, error: err.message }); });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 어드민 통계: 접속 하트비트 수신
app.post("/api/admin/heartbeat", (req, res) => {
  try {
    const userName = (req.body && req.body.userName) ? String(req.body.userName).trim() : "";
    insertActivityLog.run("heartbeat", userName || "알수없음", 0, "/api/admin/heartbeat");
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 어드민 통계: 사용자별 일/월/연 접속시간 · 데이터 입력량
// 통계 집계 시작일 — 이전 테스트/오류 데이터(예: 깨진 사용자명)를 통계에서 배제하기 위한 기준일.
// 이 날짜 이전 데이터는 화면에 표시하지 않는다 (데이터 자체를 지우지는 않음).
const STATS_START_DATE = "2026-07-14 00:00:00";

app.get("/api/admin/stats", (req, res) => {
  try {
    const BUCKET_LEN = { daily: 10, monthly: 7, yearly: 4 };

    const accessBuckets = (len) => db.prepare(`
      SELECT substr(ts,1,${len}) AS period, user_name AS user, COUNT(*) * 60 AS seconds
      FROM user_activity_log WHERE type='heartbeat' AND ts >= ?
      GROUP BY period, user
      ORDER BY period DESC
    `).all(STATS_START_DATE);

    const volumeBuckets = (len) => {
      const fromActivity = db.prepare(`
        SELECT substr(ts,1,${len}) AS period, user_name AS user, SUM(bytes) AS bytes
        FROM user_activity_log WHERE type='data_input' AND ts >= ?
        GROUP BY period, user
      `).all(STATS_START_DATE);
      const fromEditLog = db.prepare(`
        SELECT substr(changed_at,1,${len}) AS period, changed_by AS user, SUM(LENGTH(COALESCE(new_value,''))) AS bytes
        FROM debtor_edit_log WHERE changed_at >= ?
        GROUP BY period, user
      `).all(STATS_START_DATE);
      const merged = new Map();
      for (const r of [...fromActivity, ...fromEditLog]) {
        const key = r.period + " " + r.user;
        merged.set(key, (merged.get(key) || 0) + (r.bytes || 0));
      }
      return [...merged.entries()]
        .map(([key, bytes]) => { const [period, user] = key.split(" "); return { period, user, bytes }; })
        .sort((a, b) => b.period.localeCompare(a.period));
    };

    const access = { daily: accessBuckets(BUCKET_LEN.daily), monthly: accessBuckets(BUCKET_LEN.monthly), yearly: accessBuckets(BUCKET_LEN.yearly) };
    const volume = { daily: volumeBuckets(BUCKET_LEN.daily), monthly: volumeBuckets(BUCKET_LEN.monthly), yearly: volumeBuckets(BUCKET_LEN.yearly) };

    // "총 수정 건수"는 채무자 필드 수정(debtor_edit_log)뿐 아니라, 신용분석/협의/TodoList
    // 등 kvPut 기반 저장(user_activity_log의 data_input)까지 합산해야 실제 작업량을 반영한다 —
    // debtor_edit_log만 세면 kvPut으로 저장되는 대부분의 작업이 0건으로 보이게 된다.
    const editSummary = db.prepare(`
      SELECT changed_by AS user, COUNT(*) AS cnt, MAX(changed_at) AS lastAt
      FROM debtor_edit_log WHERE changed_at >= ? GROUP BY changed_by
    `).all(STATS_START_DATE);
    const dataInputSummary = db.prepare(`
      SELECT user_name AS user, COUNT(*) AS cnt, MAX(ts) AS lastAt
      FROM user_activity_log WHERE type='data_input' AND ts >= ? GROUP BY user_name
    `).all(STATS_START_DATE);
    const heartbeatSummary = db.prepare(`
      SELECT user_name AS user, MAX(ts) AS lastAt
      FROM user_activity_log WHERE type='heartbeat' AND ts >= ? GROUP BY user_name
    `).all(STATS_START_DATE);
    const summaryMap = new Map();
    const touch = (user, addCnt, lastAt) => {
      const cur = summaryMap.get(user) || { user, totalEdits: 0, lastActiveAt: null };
      cur.totalEdits += addCnt;
      if (lastAt && (!cur.lastActiveAt || lastAt > cur.lastActiveAt)) cur.lastActiveAt = lastAt;
      summaryMap.set(user, cur);
    };
    for (const r of editSummary) touch(r.user, r.cnt, r.lastAt);
    for (const r of dataInputSummary) touch(r.user, r.cnt, r.lastAt);
    for (const r of heartbeatSummary) touch(r.user, 0, r.lastAt);
    const summary = [...summaryMap.values()].sort((a, b) => (b.lastActiveAt || "").localeCompare(a.lastActiveAt || ""));

    res.json({ access, volume, summary });
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

// pythonw.exe = GUI subsystem, never opens a console window
const PYTHON_BIN = "C:\\Users\\hjbae\\AppData\\Local\\Python\\pythoncore-3.14-64\\pythonw.exe";

function ocrPdfForResident(pdfPath) {
  return new Promise((resolve) => {
    const proc = spawn(PYTHON_BIN, [OCR_SCRIPT, pdfPath], { timeout: 90000, windowsHide: true });
    let out = "";
    proc.stdout.on("data", d => { out += d.toString(); });
    proc.on("close", () => {
      try { resolve(JSON.parse(out.trim())); } catch { resolve({ ok: false }); }
    });
    proc.on("error", () => resolve({ ok: false }));
  });
}

function ocrPdfForSubrogationDate(pdfPath) {
  return new Promise((resolve) => {
    const proc = spawn(PYTHON_BIN, [OCR_SUBROGATION_SCRIPT, pdfPath], { timeout: 90000, windowsHide: true });
    let out = "";
    proc.stdout.on("data", d => { out += d.toString(); });
    proc.on("close", () => {
      try { resolve(JSON.parse(out.trim())); } catch { resolve({ ok: false }); }
    });
    proc.on("error", () => resolve({ ok: false }));
  });
}

function ocrPdfForCreditScore(pdfPath) {
  return new Promise((resolve) => {
    const proc = spawn(PYTHON_BIN, [OCR_CREDIT_SCRIPT, pdfPath], { timeout: 90000, windowsHide: true });
    let out = "";
    proc.stdout.on("data", d => { out += d.toString(); });
    proc.on("close", () => {
      try { resolve(JSON.parse(out.trim())); } catch { resolve({ ok: false }); }
    });
    proc.on("error", () => resolve({ ok: false }));
  });
}

function korName3(name) {
  const kor = String(name || "").replace(/[^가-힣]/g, "");
  return kor.length >= 2 ? kor.slice(0, 3) : null;
}

app.get("/api/debtor/:id/resident-number", async (req, res) => {
  try {
    const debtor = db.prepare(
      `SELECT d.name, d.resident_number,
              (SELECT GROUP_CONCAT(g.name, ',') FROM debtor_guarantors g WHERE g.debtor_id = d.id) AS guarantors_str
       FROM debtors d WHERE d.id = ?`
    ).get(req.params.id);
    if (!debtor) return res.json({ ok: false, entries: [] });

    const entries = [];

    // 주채무자
    if (debtor.resident_number) {
      entries.push({ name: debtor.name, number: debtor.resident_number, source: "db" });
    } else {
      const kor = korName3(debtor.name);
      if (kor) {
        const rows = db.prepare(
          `SELECT file_path, filename FROM file_index
           WHERE (parsed_person_name LIKE ? OR filename LIKE ?)
           AND (doc_type LIKE '%초본%' OR filename LIKE '%초본%')
           AND ext = 'pdf'
           ORDER BY parsed_date DESC LIMIT 5`
        ).all(`%${kor}%`, `%${kor}%`);
        for (const c of rows) {
          const r = await ocrPdfForResident(c.file_path);
          if (r.ok && r.number) { entries.push({ name: debtor.name, number: r.number, source: "ocr", filename: c.filename }); break; }
        }
      }
    }

    // 연대보증인
    const guarantors = debtor.guarantors_str ? debtor.guarantors_str.split(",").filter(Boolean) : [];
    for (const gName of guarantors) {
      const kor = korName3(gName);
      if (!kor) continue;
      const rows = db.prepare(
        `SELECT file_path, filename FROM file_index
         WHERE (parsed_person_name LIKE ? OR filename LIKE ?)
         AND (doc_type LIKE '%초본%' OR filename LIKE '%초본%')
         AND ext = 'pdf'
         ORDER BY parsed_date DESC LIMIT 3`
      ).all(`%${kor}%`, `%${kor}%`);
      for (const c of rows) {
        const r = await ocrPdfForResident(c.file_path);
        if (r.ok && r.number) { entries.push({ name: gName, number: r.number, source: "ocr", filename: c.filename }); break; }
      }
    }

    res.json({ ok: true, entries });
  } catch (e) { res.status(500).json({ ok: false, entries: [], error: e.message }); }
});

// ─── 신용점수 자동 추출 (CB종합보고서 PDF → Python Windows OCR) ──
app.get("/api/debtor/:id/credit-score", async (req, res) => {
  try {
    const debtor = db.prepare(
      `SELECT d.name, d.credit_grade,
              (SELECT GROUP_CONCAT(g.name, ',') FROM debtor_guarantors g WHERE g.debtor_id = d.id) AS guarantors_str
       FROM debtors d WHERE d.id = ?`
    ).get(req.params.id);
    if (!debtor) return res.json({ ok: false, entries: [] });

    const entries = [];

    const findScore = async (name) => {
      const kor = korName3(name);
      if (!kor) return null;
      const rows = db.prepare(
        `SELECT file_path, filename FROM file_index
         WHERE (parsed_person_name LIKE ? OR filename LIKE ?)
         AND (LOWER(doc_type) LIKE '%cb%' OR LOWER(filename) LIKE '%cb%' OR LOWER(filename) LIKE '%신용%')
         AND ext = 'pdf'
         ORDER BY parsed_date DESC LIMIT 5`
      ).all(`%${kor}%`, `%${kor}%`);
      for (const c of rows) {
        const r = await ocrPdfForCreditScore(c.file_path);
        if (r.ok && r.score) return { score: r.score, filename: c.filename };
      }
      return null;
    };

    // 주채무자
    const mainResult = await findScore(debtor.name);
    if (mainResult) entries.push({ name: debtor.name, ...mainResult, source: "ocr" });

    // 연대보증인
    const guarantors = debtor.guarantors_str ? debtor.guarantors_str.split(",").filter(Boolean) : [];
    for (const gName of guarantors) {
      const r = await findScore(gName);
      if (r) entries.push({ name: gName, ...r, source: "ocr" });
    }

    res.json({ ok: true, entries });
  } catch (e) { res.status(500).json({ ok: false, entries: [], error: e.message }); }
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
app.get("/{*splat}", (req, res) => {
  if (!req.path.startsWith("/api")) {
    res.sendFile(path.join(__dirname, "../dist/index.html"));
  }
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

app.post("/api/ai-chat", async (req, res) => {
  const openaiClient = getOpenAIClient();
  if (!openaiClient) return res.status(503).json({ error: "OPENAI_API_KEY 미설정" });
  const { query, debtorId } = req.body;
  if (!query) return res.status(400).json({ error: "query 필요" });

  try {
    // 특정 채무자 지정 시 해당 채무자 데이터 로드
    let contextText = "";
    if (debtorId) {
      const d = db.prepare("SELECT * FROM debtors WHERE id=?").get(debtorId);
      if (d) {
        const pays = db.prepare("SELECT * FROM payments WHERE debtor_id=? ORDER BY payment_date DESC LIMIT 20").all(debtorId);
        const acts = db.prepare("SELECT * FROM activities WHERE debtor_id=? ORDER BY activity_date DESC LIMIT 10").all(debtorId);
        const seizures = db.prepare("SELECT * FROM seizure_cases WHERE debtor_id=? ORDER BY created_at DESC LIMIT 5").all(debtorId);
        const rehabs = db.prepare("SELECT * FROM rehabilitations WHERE debtor_id=? ORDER BY id DESC LIMIT 3").all(debtorId);
        const installs = db.prepare("SELECT * FROM installment_plans WHERE debtor_id=? ORDER BY id DESC LIMIT 1").all(debtorId);
        const complaints = db.prepare("SELECT * FROM complaints WHERE debtor_id=? ORDER BY complaint_date DESC LIMIT 3").all(debtorId);

        const fmt = v => v != null ? Number(v).toLocaleString("ko-KR") : "0";
        const totalPaid = pays.reduce((s, p) => s + (p.total_amount || 0), 0);
        const lastPay = pays[0];
        contextText = `
[채무자 기본정보]
이름: ${d.name} | 브랜드: ${d.brand_code || "-"} | 허브: ${d.hub_name || "-"}
원금: ${fmt(d.principal_balance)}원 | 수금상태: ${d.collection_status || "-"}
담당자: ${d.assignee || "-"} | 메모: ${d.key_notes || "-"}
전화: ${d.phone || "-"} | 채무원인: ${d.debt_cause || "-"}
집행권원: ${d.exec_title || "-"}

[입금 현황]
총 입금액: ${fmt(totalPaid)}원 (${pays.length}건)
최근 입금: ${lastPay ? `${lastPay.payment_date} ${fmt(lastPay.total_amount)}원` : "없음"}
${pays.length > 0 ? pays.slice(0, 10).map(p => `  ${p.payment_date} ${fmt(p.total_amount)}원 (${p.payer_name || "-"})`).join("\n") : ""}

[활동 이력 (최대 10건)]
${acts.length === 0 ? "없음" : acts.map(a => `${a.activity_date} [${a.activity_type}] ${a.content || ""}`).join("\n")}

[압류/법적절차 (최대 5건)]
${seizures.length === 0 ? "없음" : seizures.map(s => `법원: ${s.court || "-"} | 사건번호: ${s.case_number || "-"} | 상태: ${s.status || "-"}`).join("\n")}

[회생/파산]
${rehabs.length === 0 ? "없음" : rehabs.map(r => `${r.type || "-"} | 사건번호: ${r.case_number || "-"} | 법원: ${r.court || "-"}`).join("\n")}

[분납약정]
${installs.length === 0 ? "없음" : installs.map(i => `월 ${fmt(i.monthly_amount)}원 | 총채권: ${fmt(i.total_claim)}원 | 상태: ${i.status}`).join("\n")}

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
바로고 채권관리 시스템의 실제 데이터를 바탕으로 담당자에게 실무적인 분석과 조언을 제공합니다.
- 금액은 항상 원화(원) 단위로 표시하고 천단위 콤마를 사용하세요.
- 입금 패턴, 법적 조치 이력을 분석해 구체적인 다음 조치를 추천하세요.
- 압류, 분납약정, 법적 조치 가능성을 실무적 관점에서 판단하세요.
- 답변은 간결하되 핵심 정보를 빠짐없이 포함하세요.
- 한국어로 답변하세요.`;

    const userMessage = contextText
      ? `[채무자 데이터]\n${contextText}\n\n[질문]\n${query}`
      : query;

    const completion = await openaiClient.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      max_tokens: 1000,
      temperature: 0.3,
    });

    res.json({ answer: completion.choices[0].message.content });
  } catch (err) {
    console.error("AI chat error:", err.message);
    res.status(500).json({ error: err.message });
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
});
