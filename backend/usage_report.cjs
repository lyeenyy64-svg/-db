// 특정 사용자가 최근 N일 동안 무엇을 많이 보고/입력했는지 집계하는 읽기 전용 리포트 (업무 길라잡이 순서 설계용).
// 사용법(서버 PC):  node backend/usage_report.cjs <이름> [일수=60]
//   예) node backend/usage_report.cjs 조혜원 60
// 결과는 화면과 함께 ~/.debtflow/usage_report_<이름>.txt 에 저장된다.
// 개인정보 보호: 채무자 이름/ID/사건번호 등은 출력하지 않고, 경로의 식별자는 :id 로 가려 "종류별 건수"만 낸다.

const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");

const user = process.argv[2];
const days = Math.max(1, parseInt(process.argv[3] || "60", 10) || 60);
if (!user) { console.log("사용법: node backend/usage_report.cjs <이름> [일수=60]"); process.exit(1); }

const DB_PATH = process.env.DEBTFLOW_DB_PATH || path.join(__dirname, "..", "db", "debtflow.db");
const AUDIT_PATH = process.env.AUDIT_DB_PATH || path.join(os.homedir(), ".debtflow", "audit", "audit.db");
const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

// 경로에서 식별자(숫자 섞인 토큰)를 가린다
const mask = (p) => String(p || "").replace(/[?#].*$/, "").split("/").map(seg => (/\d/.test(seg) ? ":id" : seg)).join("/");
const label = (p) => {
  const s = String(p || "");
  if (s.startsWith("/api/kv/hist_m_")) return "채무자 히스토리 작성";
  if (s.startsWith("/api/kv/manual_todo_list")) return "주요현안 To Do";
  if (s.startsWith("/api/kv/manual_credit_analyses")) return "신용분석";
  if (s.startsWith("/api/kv/manual_forced_executions")) return "강제집행";
  if (s.startsWith("/api/kv/manual_monthly_schedule")) return "월간 주요일정";
  if (s.startsWith("/api/kv/case_notes_") || s.startsWith("/api/kv/case_event_")) return "사건 메모/기일";
  if (s.startsWith("/api/kv/legal_") || s.startsWith("/api/kv/minsa_") || s.startsWith("/api/kv/ad_")) return "법적절차/민사/재산명시 수정";
  if (s.startsWith("/api/kv/manual_rehab") || s.startsWith("/api/kv/rehab")) return "회생/파산";
  if (s.startsWith("/api/debtors")) return "채무자 정보 수정";
  if (s.startsWith("/api/installments")) return "분할상환";
  if (s.startsWith("/api/payments") || s.startsWith("/api/pending-payments")) return "입금";
  if (s.startsWith("/api/related-data")) return "관련 데이터";
  return "기타 " + mask(s);
};

const out = [];
const log = (s = "") => { out.push(s); console.log(s); };
const table = (rows, cols) => rows.forEach(r => log("  " + cols.map(c => String(r[c]).padEnd(c === "label" || c === "route" ? 42 : 8)).join(" ")));

const db = new Database(DB_PATH, { readonly: true });
log(`■ ${user} 사용 내역 리포트 — 최근 ${days}일 (${since} ~ 오늘)`);

// 1) 접속 일수 / 접속 신호 수
const hb = db.prepare("SELECT COUNT(*) c, COUNT(DISTINCT substr(ts,1,10)) d FROM user_activity_log WHERE type='heartbeat' AND user_name=? AND substr(ts,1,10)>=?").get(user, since);
log(`\n[접속] 접속한 날 ${hb.d}일 · 접속 신호 ${hb.c}회 (신호가 많을수록 오래 켜둠)`);

// 2) 데이터 입력: 종류별 건수/글자수
const agg = {};
for (const r of db.prepare("SELECT path, bytes FROM user_activity_log WHERE type='data_input' AND user_name=? AND substr(ts,1,10)>=? AND bytes>0").all(user, since)) {
  const k = label(r.path);
  (agg[k] ||= { label: k, 건수: 0, 글자수: 0 });
  agg[k].건수++; agg[k].글자수 += r.bytes || 0;
}
const inputRows = Object.values(agg).sort((a, b) => b.건수 - a.건수);
log("\n[데이터 입력] 종류별 (많이 입력한 순)");
inputRows.length ? table(inputRows.slice(0, 25), ["label", "건수", "글자수"]) : log("  (기록 없음)");

// 3) 조회/화면 사용: 접속기록(audit)
try {
  const adb = new Database(AUDIT_PATH, { readonly: true });
  const rows = adb.prepare("SELECT action, route FROM audit_log WHERE user=? AND substr(ts,1,10)>=?").all(user, since);
  const byAction = {}, byRoute = {};
  for (const r of rows) {
    byAction[r.action] = (byAction[r.action] || 0) + 1;
    const k = `${r.action} ${mask(r.route)}`;
    byRoute[k] = (byRoute[k] || 0) + 1;
  }
  log(`\n[접속기록] 행위별 (총 ${rows.length}건)`);
  Object.entries(byAction).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => log(`  ${k.padEnd(20)} ${v}`));
  log("\n[접속기록] 자주 연 화면/API 상위 25 (행위 + 경로)");
  Object.entries(byRoute).sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([k, v]) => log(`  ${k.padEnd(60)} ${v}`));
} catch (e) { log(`\n[접속기록] 읽지 못했습니다: ${e.message}`); }

// 4) 업무 길라잡이 사용 현황
try {
  const g = db.prepare("SELECT mission, COUNT(*) c, SUM(points) p FROM guide_scores WHERE user_name=? AND date>=? GROUP BY mission ORDER BY c DESC").all(user, since);
  log("\n[길라잡이] 단계별 처리 건수/점수");
  g.length ? g.forEach(r => log(`  ${String(r.mission).padEnd(14)} ${String(r.c).padEnd(6)} ${r.p}점`)) : log("  (기록 없음)");
} catch { /* guide_scores 없음 */ }

const file = path.join(os.homedir(), ".debtflow", `usage_report_${user}.txt`);
try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, out.join("\n"), "utf8"); console.log(`\n저장됨: ${file}`); } catch { /* 저장 실패는 무시 */ }
