// ============================================================
// 접속기록(감사 로그) — 개인정보보호 조치 6번
// - 누가·언제·어디서(IP)·무엇을(조회/수정/삭제/다운로드/원문열람 등) 했는지 기록한다.
// - 개인정보 원문은 남기지 않는다: 경로는 라우트 패턴(/api/debtors/:id)으로, 대상은 숫자/영문 ID일 때만,
//   검색어·본문·이름이 담긴 경로 값은 기록하지 않는다.
// - 앱 DB와 분리된 별도 파일(기본: 사용자 폴더 .debtflow/audit/audit.db)에 저장하고, 앱에는 추가(INSERT)
//   기능만 있고 수정/삭제 API는 없다. 각 행은 직전 행의 해시를 포함해 중간 삭제·변조를 검증할 수 있다.
// - 보관 기간은 AUDIT_RETENTION_DAYS(기본 730일=2년). 법정 기준은 정보보안팀/법무팀 확인값으로 맞출 것.
// ============================================================
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");

const RETENTION_DAYS = Number(process.env.AUDIT_RETENTION_DAYS) || 730;
// 1시간 동안 한 사용자의 원문 열람/다운로드가 이 횟수를 넘으면 이상 행위로 표시
const ALERT_REVEALS_PER_HOUR = Number(process.env.AUDIT_ALERT_REVEALS_PER_HOUR) || 30;
const ALERT_DOWNLOADS_PER_HOUR = Number(process.env.AUDIT_ALERT_DOWNLOADS_PER_HOUR) || 20;
const ALERT_REQUESTS_PER_HOUR = Number(process.env.AUDIT_ALERT_REQUESTS_PER_HOUR) || 5000;

// 기록하지 않는 잡음성 경로 (주기적 호출)
const SKIP_ROUTES = new Set(["/api/admin/heartbeat", "/api/events", "/api/auth/me", "/api/health", "/api/privacy/grants"]);

const SAFE_TARGET = /^[A-Za-z0-9_-]{1,40}$/;
const HANGUL = /[가-힣]/;

function classify(req, res) {
  const ct = String(res.getHeader("content-type") || "");
  const cd = String(res.getHeader("content-disposition") || "");
  if (/attachment/i.test(cd) || /officedocument|hwp|octet-stream|application\/pdf|zip/i.test(ct)) return "다운로드";
  switch (req.method) {
    case "GET": case "HEAD": return "조회";
    case "DELETE": return "삭제";
    default: return "수정";
  }
}

function createAudit({ slackClient, notifyChannel } = {}) {
  const file = process.env.AUDIT_DB_PATH || path.join(os.homedir(), ".debtflow", "audit", "audit.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const adb = new Database(file);
  adb.pragma("journal_mode = WAL");
  adb.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ts        TEXT NOT NULL,
      user      TEXT,
      role      TEXT,
      ip        TEXT,
      action    TEXT NOT NULL,
      method    TEXT,
      route     TEXT,
      target    TEXT,
      status    INTEGER,
      count     INTEGER,
      detail    TEXT,
      prev_hash TEXT NOT NULL,
      hash      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user, ts);
  `);
  // 해시 버전: 1=키 없는 SHA-256(기존 행), 2=HMAC-SHA256(키 필요, 필드 구분자 모호성 제거). 기존 행은 그대로 검증된다.
  try { adb.exec("ALTER TABLE audit_log ADD COLUMN hv INTEGER NOT NULL DEFAULT 1"); } catch { /* 이미 있음 */ }
  // 키 없는 해시는 파일에 쓰기 권한이 있으면 체인 전체를 다시 계산해 위조할 수 있다 — 키는 DB 파일과 분리해 둔다
  // (AUDIT_HMAC_KEY 환경변수 → AUDIT_KEY_FILE → 접속기록 폴더의 audit.key(없으면 자동 생성)). 가능하면 별도 위치에 보관·백업할 것.
  const keyFile = process.env.AUDIT_KEY_FILE || path.join(path.dirname(file), "audit.key");
  const auditKey = (() => {
    if (process.env.AUDIT_HMAC_KEY && process.env.AUDIT_HMAC_KEY.length >= 16) return Buffer.from(process.env.AUDIT_HMAC_KEY, "utf8");
    try {
      if (fs.existsSync(keyFile)) return Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "hex");
      fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
      console.warn(`[audit] 접속기록 무결성 키를 새로 만들었습니다: ${keyFile} — 접속기록 파일과 분리해 별도로 보관하세요(분실하면 이후 기록 검증이 불가능)`);
      return Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "hex");
    } catch (e) {
      console.error("[audit] 무결성 키를 준비하지 못해 기존 방식(SHA-256)으로 기록합니다:", e.message);
      return null;
    }
  })();
  const headFile = path.join(path.dirname(file), "audit.head");
  console.log(`[audit] 접속기록 저장소: ${file} (보관 ${RETENTION_DAYS}일)`);

  const localTs = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const last = adb.prepare("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1").get();
  let lastHash = last ? last.hash : "GENESIS";
  const insert = adb.prepare(`INSERT INTO audit_log (ts, user, role, ip, action, method, route, target, status, count, detail, prev_hash, hash, hv)
    VALUES (@ts, @user, @role, @ip, @action, @method, @route, @target, @status, @count, @detail, @prev_hash, @hash, @hv)`);
  const hashOf = (r) => {
    const fields = [r.prev_hash, r.ts, r.user, r.role, r.ip, r.action, r.method, r.route, r.target, r.status, r.count, r.detail];
    if (r.hv === 2 && auditKey) return crypto.createHmac("sha256", auditKey).update(JSON.stringify(fields.map(v => v ?? ""))).digest("hex");
    return crypto.createHash("sha256").update(fields.map(v => v ?? "").join("|")).digest("hex");
  };
  // 마지막 행의 (id, 해시)를 서명해 별도 파일에 둔다 — 최신 행들을 통째로 지우는 "꼬리 삭제"를 검증에서 알아채기 위함.
  // 요청마다 쓰지 않도록 최대 3초에 한 번 기록한다.
  let lastHeadWrite = 0, headDirty = null;
  const headSig = (id, hash) => (auditKey ? crypto.createHmac("sha256", auditKey).update(`head|${id}|${hash}`).digest("hex") : "");
  function writeHead(id, hash, force) {
    if (!auditKey) return;
    headDirty = { id, hash };
    if (!force && Date.now() - lastHeadWrite < 3000) return;
    try { fs.writeFileSync(headFile, JSON.stringify({ id, hash, sig: headSig(id, hash) })); lastHeadWrite = Date.now(); headDirty = null; } catch {}
  }
  process.on("exit", () => { if (headDirty) writeHead(headDirty.id, headDirty.hash, true); });
  setInterval(() => { if (headDirty) writeHead(headDirty.id, headDirty.hash, true); }, 5000).unref();

  // 1시간 단위 이상 행위 알림 (같은 사용자·종류는 시간당 1회만 알린다)
  const alerted = new Set();
  function maybeAlert(user, kind, n, limit, label) {
    if (!user || n < limit) return;
    const key = `${new Date().toISOString().slice(0, 13)}|${user}|${kind}`;
    if (alerted.has(key)) return;
    alerted.add(key);
    if (alerted.size > 2000) alerted.clear();
    const text = `[DEBTFLOW 보안] 이상 접속 감지: ${user} — 최근 1시간 ${label} ${n}건 (기준 ${limit}건). 접속기록을 확인하세요.`;
    console.warn(text);
    if (slackClient && notifyChannel) slackClient.chat.postMessage({ channel: notifyChannel, text }).catch(() => {});
  }
  function hourCount(user, whereSql, params = {}) {
    const since = new Date(Date.now() - 3600 * 1000);
    const p = (n) => String(n).padStart(2, "0");
    const sinceTs = `${since.getFullYear()}-${p(since.getMonth() + 1)}-${p(since.getDate())} ${p(since.getHours())}:${p(since.getMinutes())}:${p(since.getSeconds())}`;
    return adb.prepare(`SELECT COUNT(*) c FROM audit_log WHERE user = @user AND ts >= @since AND ${whereSql}`).get({ user, since: sinceTs, ...params }).c;
  }

  // 원문 열람은 요청 수가 아니라 열람한 채무자 수(count)로 센다 — 한 요청에 50명씩 여러 번 열어도 임계치에 걸리게
  function revealHourCount(user) {
    const since = new Date(Date.now() - 3600 * 1000);
    const p = (n) => String(n).padStart(2, "0");
    const sinceTs = `${since.getFullYear()}-${p(since.getMonth() + 1)}-${p(since.getDate())} ${p(since.getHours())}:${p(since.getMinutes())}:${p(since.getSeconds())}`;
    return adb.prepare("SELECT COALESCE(SUM(COALESCE(count, 1)), 0) c FROM audit_log WHERE user = ? AND ts >= ? AND action = 'pii_reveal'").get(user, sinceTs).c;
  }

  // 한 건 기록 — 실패해도 업무 요청을 막지 않는다
  function record(evt) {
    try {
      const row = {
        ts: localTs(), user: evt.user ?? null, role: evt.role ?? null, ip: evt.ip ?? null,
        action: evt.action || evt.event || "기타", method: evt.method ?? null, route: evt.route ?? null,
        target: evt.target ?? null, status: evt.status ?? null, count: evt.count ?? null,
        detail: evt.detail ? String(evt.detail).slice(0, 300) : null,
        prev_hash: lastHash,
        hv: auditKey ? 2 : 1,
      };
      row.hash = hashOf(row);
      const info = insert.run(row);
      lastHash = row.hash;
      writeHead(Number(info.lastInsertRowid), row.hash, false);
      if (row.action === "pii_reveal") maybeAlert(row.user, "reveal", revealHourCount(row.user), ALERT_REVEALS_PER_HOUR, "개인정보 원문 열람");
      else if (row.action === "다운로드") maybeAlert(row.user, "download", hourCount(row.user, "action = '다운로드'"), ALERT_DOWNLOADS_PER_HOUR, "다운로드");
    } catch (e) { console.error("[audit] 기록 실패:", e.message); }
  }

  // 인증/권한 이벤트(auth.cjs, privacy.cjs가 { event, user, ip, detail } 형태로 호출)
  const recordEvent = (e) => record({ ...e, action: e.event });

  // API 요청 1건을 응답이 끝난 뒤 기록한다 (라우트 패턴이 확정된 시점)
  function attach(req, res) {
    const fullPath = "/api" + req.path;
    if (SKIP_ROUTES.has(fullPath) || fullPath.startsWith("/api/auth/")) return;
    let rows = null;
    const origJson = res.json.bind(res);
    res.json = (body) => {
      if (Array.isArray(body)) rows = body.length;
      else if (body && typeof body === "object") {
        const arr = Object.values(body).find(v => Array.isArray(v));
        if (arr) rows = arr.length;
      }
      return origJson(body);
    };
    res.on("finish", () => {
      const pattern = req.route && req.route.path ? `${req.baseUrl || ""}${req.route.path}` : fullPath.replace(/\/[^/]*[가-힣][^/]*/g, "/:value");
      const params = req.params || {};
      const cand = params.id ?? params.debtorId ?? params.planId ?? params.key ?? null;
      const target = typeof cand === "string" && SAFE_TARGET.test(cand) && !HANGUL.test(cand) ? cand : null;
      record({
        user: req.user && req.user.name, role: req.user && req.user.role, ip: req.ip,
        action: classify(req, res), method: req.method,
        route: typeof pattern === "string" ? pattern : fullPath, target, status: res.statusCode, count: rows,
      });
    });
  }

  function verifyChain() {
    const all = adb.prepare("SELECT * FROM audit_log ORDER BY id").all();
    let prev = all.length ? all[0].prev_hash : "GENESIS"; // 보관기간이 지나 앞부분이 삭제됐다면 첫 행의 prev_hash를 기준으로 한다
    for (const r of all) {
      if (r.prev_hash !== prev || hashOf(r) !== r.hash) return { ok: false, brokenAtId: r.id, total: all.length };
      prev = r.hash;
    }
    // 꼬리 삭제 검사: 서명된 마지막 행 정보가 DB에 그대로 있어야 한다
    try {
      if (auditKey && fs.existsSync(headFile)) {
        const h = JSON.parse(fs.readFileSync(headFile, "utf8"));
        if (h.sig !== headSig(h.id, h.hash)) return { ok: false, reason: "head_signature_invalid", total: all.length };
        const row = all.find(r => r.id === h.id);
        const maxId = all.length ? all[all.length - 1].id : 0;
        if (!row && h.id > maxId) return { ok: false, reason: "tail_truncated", brokenAtId: maxId + 1, total: all.length };
        if (row && row.hash !== h.hash) return { ok: false, reason: "head_mismatch", brokenAtId: row.id, total: all.length };
      }
    } catch (e) { return { ok: false, reason: "head_unreadable", total: all.length }; }
    return { ok: true, total: all.length, keyed: !!auditKey };
  }

  // 보관기간 지난 기록 정리 (하루 1회)
  function purge() {
    try {
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000);
      const p = (n) => String(n).padStart(2, "0");
      const ts = `${cutoff.getFullYear()}-${p(cutoff.getMonth() + 1)}-${p(cutoff.getDate())} 00:00:00`;
      const r = adb.prepare("DELETE FROM audit_log WHERE ts < ?").run(ts);
      if (r.changes) console.log(`[audit] 보관기간(${RETENTION_DAYS}일) 경과 기록 ${r.changes}건 정리`);
    } catch (e) { console.error("[audit] 정리 실패:", e.message); }
  }
  purge();
  setInterval(purge, 24 * 3600 * 1000).unref();

  function mount(app) {
    const requireSuper = (req, res, next) => (req.user && req.user.role === "superadmin") ? next() : res.status(403).json({ error: "마스터 권한이 필요합니다" });

    // GET /api/admin/audit?user=&action=&from=YYYY-MM-DD&to=YYYY-MM-DD&limit=
    app.get("/api/admin/audit", requireSuper, (req, res) => {
      const { user, action, from, to } = req.query;
      const limit = Math.min(Number(req.query.limit) || 200, 1000);
      const where = [], params = {};
      if (user) { where.push("user = @user"); params.user = String(user); }
      if (action) { where.push("action = @action"); params.action = String(action); }
      if (from) { where.push("ts >= @from"); params.from = `${from} 00:00:00`; }
      if (to) { where.push("ts <= @to"); params.to = `${to} 23:59:59`; }
      const rows = adb.prepare(`SELECT id, ts, user, role, ip, action, method, route, target, status, count, detail FROM audit_log
        ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ${limit}`).all(params);
      const users = adb.prepare("SELECT DISTINCT user FROM audit_log WHERE user IS NOT NULL ORDER BY user").all().map(r => r.user);
      const actions = adb.prepare("SELECT DISTINCT action FROM audit_log ORDER BY action").all().map(r => r.action);
      res.json({ rows, users, actions, retentionDays: RETENTION_DAYS });
    });

    // 무결성 검증 (중간 삭제/변조 탐지)
    app.get("/api/admin/audit/verify", requireSuper, (req, res) => res.json(verifyChain()));

    // 이상 행위 후보: 시간당 원문열람/다운로드/요청 과다, 심야(00~05시) 활동
    app.get("/api/admin/audit/anomalies", requireSuper, (req, res) => {
      const days = Math.min(Number(req.query.days) || 7, 90);
      const p = (n) => String(n).padStart(2, "0");
      const since = new Date(Date.now() - days * 86400000);
      const sinceTs = `${since.getFullYear()}-${p(since.getMonth() + 1)}-${p(since.getDate())} 00:00:00`;
      const hourly = adb.prepare(`
        SELECT user, substr(ts, 1, 13) AS hour,
               SUM(CASE WHEN action = 'pii_reveal' THEN COALESCE(count, 1) ELSE 0 END) AS reveals, SUM(action = '다운로드') AS downloads, COUNT(*) AS requests
        FROM audit_log WHERE ts >= ? AND user IS NOT NULL GROUP BY user, hour`).all(sinceTs);
      const flagged = [];
      for (const h of hourly) {
        const reasons = [];
        if (h.reveals >= ALERT_REVEALS_PER_HOUR) reasons.push(`원문 열람 ${h.reveals}건`);
        if (h.downloads >= ALERT_DOWNLOADS_PER_HOUR) reasons.push(`다운로드 ${h.downloads}건`);
        if (h.requests >= ALERT_REQUESTS_PER_HOUR) reasons.push(`요청 ${h.requests}건`);
        if (reasons.length) flagged.push({ user: h.user, hour: h.hour, reasons });
      }
      const night = adb.prepare(`
        SELECT user, substr(ts, 1, 10) AS day, COUNT(*) AS requests, SUM(CASE WHEN action = 'pii_reveal' THEN COALESCE(count, 1) ELSE 0 END) AS reveals, SUM(action = '다운로드') AS downloads
        FROM audit_log WHERE ts >= ? AND user IS NOT NULL AND CAST(substr(ts, 12, 2) AS INTEGER) < 5
          AND action NOT IN ('login_fail','otp_fail','logout')
        GROUP BY user, day HAVING reveals > 0 OR downloads > 0 OR requests >= 100 ORDER BY day DESC`).all(sinceTs);
      const failures = adb.prepare(`SELECT user, COUNT(*) AS fails FROM audit_log WHERE ts >= ? AND action IN ('login_fail','otp_fail','access_denied') GROUP BY user HAVING fails >= 5 ORDER BY fails DESC`).all(sinceTs);
      res.json({ days, thresholds: { revealsPerHour: ALERT_REVEALS_PER_HOUR, downloadsPerHour: ALERT_DOWNLOADS_PER_HOUR, requestsPerHour: ALERT_REQUESTS_PER_HOUR }, flagged, night, failures });
    });
  }

  return { record: recordEvent, recordRaw: record, attach, mount, verifyChain };
}

module.exports = { createAudit };
