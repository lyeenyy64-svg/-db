// ============================================================
// 대량 반출 통제 (개인정보보호 조치 7번)
// - 목록을 파일(CSV 등)로 내려받기 전에 서버에 허가를 요청해야 한다.
//   · 매니저 이상만 가능, 사유 필수(5자 이상)
//   · 1회 건수 상한(EXPORT_MAX_ROWS, 기본 3000건) / 하루 누적 상한(EXPORT_DAILY_MAX_ROWS, 기본 10000건)
//   · 요청 사실(종류, 건수, 사유)은 접속기록에 남는다 — 사유에 개인정보를 적지 않도록 화면에서 안내
// - 짧은 시간에 API를 과도하게 호출하는 조회(스크래핑)는 사용자별 분당 호출 수로 막는다.
// ============================================================
const MAX_ROWS = Number(process.env.EXPORT_MAX_ROWS) || 3000;
const DAILY_MAX_ROWS = Number(process.env.EXPORT_DAILY_MAX_ROWS) || 10000;
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN) || 1500;
const MIN_REASON_LEN = 5;

const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function mount(app, db, { audit } = {}) {
  const log = typeof audit === "function" ? audit : () => {};
  db.exec(`
    CREATE TABLE IF NOT EXISTS export_usage (
      user TEXT NOT NULL,
      day  TEXT NOT NULL,
      rows INTEGER NOT NULL DEFAULT 0,
      requests INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user, day)
    );
  `);

  app.post("/api/exports/request", (req, res) => {
    if (!["manager", "admin", "superadmin"].includes(req.user.role)) {
      return res.status(403).json({ error: "다운로드 권한이 없습니다" });
    }
    const kind = String((req.body && req.body.kind) || "").slice(0, 40);
    const count = Math.max(0, Math.floor(Number(req.body && req.body.rowCount) || 0));
    const reason = String((req.body && req.body.reason) || "").trim();
    if (!kind) return res.status(400).json({ error: "다운로드 종류가 없습니다" });
    if (reason.length < MIN_REASON_LEN) return res.status(400).json({ error: `사유를 ${MIN_REASON_LEN}자 이상 입력하세요` });
    if (count > MAX_ROWS) {
      log({ event: "export_denied", user: req.user.name, role: req.user.role, ip: req.ip, detail: `${kind} ${count}건 — 1회 상한(${MAX_ROWS}건) 초과` });
      return res.status(413).json({ error: `한 번에 내려받을 수 있는 건수(${MAX_ROWS}건)를 넘었습니다 (${count}건). 조건을 좁혀 나누어 받으세요.` });
    }
    const day = today();
    const used = db.prepare("SELECT rows FROM export_usage WHERE user = ? AND day = ?").get(req.user.name, day);
    const usedRows = used ? used.rows : 0;
    if (usedRows + count > DAILY_MAX_ROWS) {
      log({ event: "export_denied", user: req.user.name, role: req.user.role, ip: req.ip, detail: `${kind} ${count}건 — 일일 상한(${DAILY_MAX_ROWS}건) 초과(오늘 ${usedRows}건 사용)` });
      return res.status(429).json({ error: `오늘 내려받을 수 있는 건수(${DAILY_MAX_ROWS}건)를 초과합니다 (오늘 ${usedRows}건 사용). 필요하면 관리자에게 문의하세요.` });
    }
    db.prepare(`INSERT INTO export_usage (user, day, rows, requests) VALUES (?, ?, ?, 1)
      ON CONFLICT(user, day) DO UPDATE SET rows = rows + excluded.rows, requests = requests + 1`).run(req.user.name, day, count);
    log({ event: "export_request", user: req.user.name, role: req.user.role, ip: req.ip, count, detail: `${kind} ${count}건 / 사유: ${reason.slice(0, 200)}` });
    res.json({ ok: true, maxRows: MAX_ROWS, remainingToday: DAILY_MAX_ROWS - usedRows - count });
  });

  setInterval(() => { try { db.prepare("DELETE FROM export_usage WHERE day < date('now','-60 day','localtime')").run(); } catch {} }, 24 * 3600 * 1000).unref();
}

// 사용자별 분당 호출 수 제한 — 가드 미들웨어에서 사용 (스크래핑/자동화 도구 차단)
const buckets = new Map();
function rateLimited(userKey) {
  const minute = Math.floor(Date.now() / 60000);
  const b = buckets.get(userKey);
  if (!b || b.minute !== minute) { buckets.set(userKey, { minute, n: 1 }); if (buckets.size > 5000) buckets.clear(); return false; }
  b.n += 1;
  return b.n > RATE_LIMIT_PER_MIN;
}

module.exports = { mount, rateLimited, MAX_ROWS, DAILY_MAX_ROWS, RATE_LIMIT_PER_MIN };
