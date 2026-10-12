// ============================================================
// DEBTFLOW 서버 측 인증 (개인정보보호 조치 1번: 인증 + 2단계 인증)
// - 계정/비밀번호 해시/세션은 전부 서버가 보관한다. 브라우저에는 HttpOnly 쿠키만 남는다.
// - 로그인: 비밀번호 확인 → Slack DM으로 일회용 코드(OTP) 발송 → 코드 확인 → 세션 발급
// - 모든 /api 요청은 세션이 있어야 통과한다 (PUBLIC_PATHS 제외)
// ============================================================
const crypto = require("crypto");
const { createPrivacy } = require("./privacy.cjs");

const SESSION_COOKIE = "df_session";
const SESSION_HOURS = Number(process.env.AUTH_SESSION_HOURS) || 12;
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 10 * 60 * 1000;
// AUTH_2FA=off 로 두면 2단계 인증을 끈다 (Slack 장애로 아무도 로그인 못 할 때의 비상 스위치)
const TWO_FACTOR_ON = String(process.env.AUTH_2FA || "on").toLowerCase() !== "off";

// 로그인 전에도 호출 가능한 경로 (/api 기준)
const PUBLIC_PATHS = new Set(["/auth/login", "/auth/verify", "/auth/logout", "/auth/me", "/todo-list/from-outlook-flag"]);
// 비밀번호 변경이 강제된 세션이 호출할 수 있는 경로
const MUST_CHANGE_ALLOWED = new Set(["/auth/change-password", "/auth/logout", "/auth/me"]);

const ROLE_KEYS = ["superadmin", "admin", "manager", "member"];
const ADMIN_ROLES = ["superadmin", "admin"];

// ─── 비밀번호 해시 (scrypt, 솔트 포함) ─────────────────────
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}
function verifyPassword(pw, stored) {
  if (!stored || typeof stored !== "string") return false;
  const [algo, saltHex, hashHex] = stored.split("$");
  if (algo !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(String(pw), Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

function validatePassword(pw) {
  if (typeof pw !== "string" || pw.length < 8) return "비밀번호는 8자 이상이어야 합니다";
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return "비밀번호는 영문과 숫자를 모두 포함해야 합니다";
  if (/^(.)\1+$/.test(pw)) return "너무 단순한 비밀번호입니다";
  return null;
}

// ─── 권한(RBAC) 정책 — 화면에서 버튼을 숨기는 것과 별개로 서버가 직접 막는다 ───
// member(구성원): 읽기만 / manager(매니저): + 등록·수정·삭제(핵심 항목 제외)
// admin(관리자): + 채무자 삭제, 어드민 메뉴 / superadmin(마스터): + 통계
const ROLE_LEVEL = { member: 0, manager: 1, admin: 2, superadmin: 3 };
// 구성원도 호출해야 하는 "읽기 성격"의 POST (AI 질의, 문서 미리보기 등)
const MEMBER_SAFE_POST = [
  /^\/ai-chat$/, /^\/ai\/(doc-chat|extract-pdf-text)$/, /^\/documents\/(preview-html|generate-hwpx)$/,
  /^\/slack\/preview$/, /^\/payments\/verify-excel$/, /^\/admin\/heartbeat$/,
];
function authorize(req) {
  const level = ROLE_LEVEL[req.user.role] ?? 0;
  const p = req.path;
  const isRead = req.method === "GET" || req.method === "HEAD";
  // 계정 관리 API는 auth.cjs 안에서 자체 권한을 검사한다
  if (p.startsWith("/auth/")) return null;
  // 어드민 영역
  if (p.startsWith("/admin/")) {
    if (p === "/admin/heartbeat") return null;
    if (p.startsWith("/admin/stats")) return level >= 3 ? null : "마스터 권한이 필요합니다";
    return level >= 2 ? null : "관리자 권한이 필요합니다";
  }
  if (isRead) return null;
  if (level < 1 && !MEMBER_SAFE_POST.some(re => re.test(p))) return "구성원 권한은 조회만 할 수 있습니다";
  if (level < 2) {
    if (req.method === "DELETE" && /^\/debtors\/[^/]+$/.test(p)) return "관리자 권한이 필요합니다";
    if (p.startsWith("/alert-rules") || p.startsWith("/edit-logs/")) return "관리자 권한이 필요합니다";
  }
  return null;
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setupAuth(app, db, { slackClient, ROLE_CHANGE_PASSCODE, audit } = {}) {
  const log = typeof audit === "function" ? audit : () => {};

  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_accounts (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      email           TEXT,
      avatar          TEXT,
      role            TEXT NOT NULL DEFAULT 'member',
      approved        INTEGER NOT NULL DEFAULT 1,
      password_hash   TEXT,
      must_change_pw  INTEGER NOT NULL DEFAULT 0,
      slack_user_id   TEXT,
      registered_at   TEXT,
      last_login_at   TEXT
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash   TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      ip           TEXT
    );
    CREATE TABLE IF NOT EXISTS auth_challenges (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      code_hash   TEXT NOT NULL,
      expires_at  INTEGER NOT NULL,
      attempts    INTEGER NOT NULL DEFAULT 0
    );
  `);

  // ─── 최초 이전: 예전에 kv_store(app_users)에 평문으로 있던 계정을 서버 계정으로 옮긴다 ───
  const accountCount = db.prepare("SELECT COUNT(*) c FROM auth_accounts").get().c;
  if (accountCount === 0) {
    const row = db.prepare("SELECT value FROM kv_store WHERE key = 'app_users'").get();
    let legacy = [];
    try { legacy = row ? JSON.parse(row.value) : []; } catch {}
    const ins = db.prepare(`INSERT OR IGNORE INTO auth_accounts
      (id, name, email, avatar, role, approved, password_hash, must_change_pw, registered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`);
    for (const u of Array.isArray(legacy) ? legacy : []) {
      if (!u || !u.id || !u.name) continue;
      // 기존 비밀번호는 해시로만 이전하고, 첫 로그인 직후 새 비밀번호로 바꾸게 강제한다
      const hash = typeof u.password === "string" && u.password ? hashPassword(u.password) : null;
      ins.run(String(u.id), u.name, u.email || null, u.avatar || u.name[0], ROLE_KEYS.includes(u.role) ? u.role : "member",
        u.approved === false ? 0 : 1, hash, u.registeredAt || null);
    }
    console.log(`[auth] 기존 계정 ${Array.isArray(legacy) ? legacy.length : 0}건을 서버 계정으로 이전했습니다`);
  }
  // 평문 비밀번호가 남아있던 kv 키는 계정 이전 여부와 상관없이 항상 제거
  db.prepare("DELETE FROM kv_store WHERE key = 'app_users'").run();

  const publicUser = (a) => ({
    id: a.id, name: a.name, email: a.email, avatar: a.avatar, role: a.role,
    approved: !!a.approved, registeredAt: a.registered_at,
  });
  const getAccountById = (id) => db.prepare("SELECT * FROM auth_accounts WHERE id = ?").get(id);
  const findAccountByLogin = (login) => {
    const v = String(login || "").trim().toLowerCase();
    if (!v) return null;
    return db.prepare("SELECT * FROM auth_accounts WHERE lower(name) = ? OR lower(email) = ?").get(v, v);
  };

  // ─── 로그인 실패 잠금 (메모리) ───────────────────────────
  const failMap = new Map(); // key -> { n, lockedUntil }
  const failKey = (req, login) => `${String(login || "").toLowerCase()}|${req.ip}`;
  const isLocked = (k) => { const f = failMap.get(k); return f && f.lockedUntil > Date.now(); };
  const addFail = (k) => {
    const f = failMap.get(k) || { n: 0, lockedUntil: 0 };
    f.n += 1;
    if (f.n >= LOGIN_MAX_FAILS) { f.lockedUntil = Date.now() + LOGIN_LOCK_MS; f.n = 0; }
    failMap.set(k, f);
  };

  // ─── 세션 ────────────────────────────────────────────────
  function createSession(res, req, userId) {
    const token = crypto.randomBytes(32).toString("hex");
    const now = Date.now();
    db.prepare("INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?)")
      .run(sha256(token), userId, now, now + SESSION_HOURS * 3600 * 1000, req.ip || null);
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}${req.secure ? "; Secure" : ""}`);
  }
  function clearCookie(req, res) {
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${req.secure ? "; Secure" : ""}`);
  }
  function sessionFromRequest(req) {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token) return null;
    const s = db.prepare("SELECT * FROM auth_sessions WHERE token_hash = ?").get(sha256(token));
    if (!s) return null;
    if (s.expires_at < Date.now()) {
      db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(s.token_hash);
      return null;
    }
    const acc = getAccountById(s.user_id);
    if (!acc || !acc.approved) return null;
    return { session: s, account: acc };
  }
  // 만료된 세션/인증요청 정리 (10분마다)
  setInterval(() => {
    try {
      db.prepare("DELETE FROM auth_sessions WHERE expires_at < ?").run(Date.now());
      db.prepare("DELETE FROM auth_challenges WHERE expires_at < ?").run(Date.now());
    } catch {}
  }, 10 * 60 * 1000).unref();

  // ─── Slack DM으로 OTP 발송 ───────────────────────────────
  async function sendOtp(account, code) {
    if (!slackClient) throw new Error("Slack 봇이 설정되지 않았습니다");
    let slackId = account.slack_user_id;
    if (!slackId) {
      if (!account.email) throw new Error("계정에 이메일이 없어 Slack 사용자를 찾을 수 없습니다");
      const r = await slackClient.users.lookupByEmail({ email: account.email });
      slackId = r.user && r.user.id;
      if (!slackId) throw new Error("Slack 사용자를 찾을 수 없습니다");
      db.prepare("UPDATE auth_accounts SET slack_user_id = ? WHERE id = ?").run(slackId, account.id);
    }
    await slackClient.chat.postMessage({
      channel: slackId,
      text: `[DEBTFLOW] 로그인 인증코드: *${code}*\n5분 안에 입력하세요. 본인이 시도한 로그인이 아니라면 이 코드를 누구에게도 알려주지 말고 관리자에게 알려주세요.`,
    });
  }

  // ─── 인증 라우트 ─────────────────────────────────────────
  app.post("/api/auth/login", async (req, res) => {
    const { id, password } = req.body || {};
    const key = failKey(req, id);
    if (isLocked(key)) return res.status(429).json({ error: "로그인 시도가 너무 많습니다. 10분 뒤에 다시 시도하세요." });
    const acc = findAccountByLogin(id);
    // 계정이 없어도 같은 시간이 걸리도록 더미 검증을 수행 (계정 존재 여부 노출 방지)
    const ok = acc ? verifyPassword(password, acc.password_hash) : (verifyPassword(password, "scrypt$00$00"), false);
    if (!acc || !ok) {
      addFail(key);
      log({ event: "login_fail", user: acc ? acc.name : String(id || "").slice(0, 40), ip: req.ip });
      return res.status(401).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." });
    }
    if (!acc.approved) return res.status(403).json({ error: "승인 대기 중이거나 비활성화된 계정입니다." });
    failMap.delete(key);

    if (!TWO_FACTOR_ON) {
      createSession(res, req, acc.id);
      db.prepare("UPDATE auth_accounts SET last_login_at = datetime('now','localtime') WHERE id = ?").run(acc.id);
      log({ event: "login", user: acc.name, ip: req.ip, detail: "2FA 꺼짐" });
      return res.json({ step: "done", user: publicUser(acc), mustChangePassword: !!acc.must_change_pw });
    }

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    const challengeId = crypto.randomBytes(16).toString("hex");
    try {
      await sendOtp(acc, code);
    } catch (e) {
      console.warn("[auth] OTP 발송 실패:", e.message);
      return res.status(503).json({ error: `인증코드를 Slack으로 보내지 못했습니다 (${e.message}). 관리자에게 문의하세요.` });
    }
    db.prepare("INSERT INTO auth_challenges (id, user_id, code_hash, expires_at) VALUES (?, ?, ?, ?)")
      .run(challengeId, acc.id, sha256(`${challengeId}:${code}`), Date.now() + OTP_TTL_MS);
    res.json({ step: "otp", challengeId });
  });

  app.post("/api/auth/verify", (req, res) => {
    const { challengeId, code } = req.body || {};
    const ch = db.prepare("SELECT * FROM auth_challenges WHERE id = ?").get(String(challengeId || ""));
    if (!ch || ch.expires_at < Date.now()) return res.status(401).json({ error: "인증 시간이 만료되었습니다. 처음부터 다시 로그인하세요.", expired: true });
    if (ch.attempts >= OTP_MAX_ATTEMPTS) {
      db.prepare("DELETE FROM auth_challenges WHERE id = ?").run(ch.id);
      return res.status(429).json({ error: "인증코드 입력 횟수를 초과했습니다. 처음부터 다시 로그인하세요.", expired: true });
    }
    const given = sha256(`${ch.id}:${String(code || "").trim()}`);
    if (given.length !== ch.code_hash.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(ch.code_hash))) {
      db.prepare("UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = ?").run(ch.id);
      const acc0 = getAccountById(ch.user_id);
      log({ event: "otp_fail", user: acc0 ? acc0.name : ch.user_id, ip: req.ip });
      return res.status(401).json({ error: "인증코드가 올바르지 않습니다." });
    }
    db.prepare("DELETE FROM auth_challenges WHERE id = ?").run(ch.id);
    const acc = getAccountById(ch.user_id);
    if (!acc || !acc.approved) return res.status(403).json({ error: "사용할 수 없는 계정입니다." });
    createSession(res, req, acc.id);
    db.prepare("UPDATE auth_accounts SET last_login_at = datetime('now','localtime') WHERE id = ?").run(acc.id);
    log({ event: "login", user: acc.name, ip: req.ip });
    res.json({ step: "done", user: publicUser(acc), mustChangePassword: !!acc.must_change_pw });
  });

  app.get("/api/auth/me", (req, res) => {
    const s = sessionFromRequest(req);
    if (!s) return res.status(401).json({ error: "로그인이 필요합니다" });
    res.json({ user: publicUser(s.account), mustChangePassword: !!s.account.must_change_pw });
  });

  app.post("/api/auth/logout", (req, res) => {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) {
      const s = sessionFromRequest(req);
      db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(sha256(token));
      if (s) log({ event: "logout", user: s.account.name, ip: req.ip });
    }
    clearCookie(req, res);
    res.json({ ok: true });
  });

  const privacy = createPrivacy(db, { audit });

  // ─── 가드: 이 아래에 등록되는 모든 /api 라우트는 로그인이 필요하다 ───
  app.use("/api", (req, res, next) => {
    if (PUBLIC_PATHS.has(req.path)) return next();
    const s = sessionFromRequest(req);
    if (!s) return res.status(401).json({ error: "로그인이 필요합니다", code: "UNAUTHENTICATED" });
    if (s.account.must_change_pw && !MUST_CHANGE_ALLOWED.has(req.path)) {
      return res.status(403).json({ error: "비밀번호를 먼저 변경해야 합니다", code: "MUST_CHANGE_PASSWORD" });
    }
    req.user = publicUser(s.account);
    const denied = authorize(req);
    if (denied) {
      log({ event: "access_denied", user: req.user.name, ip: req.ip, detail: `${req.method} ${req.path}` });
      return res.status(403).json({ error: denied, code: "FORBIDDEN" });
    }
    req.sessionHash = s.session.token_hash;
    privacy.attach(req, res); // 응답 개인정보 마스킹 + 마스킹된 값의 역저장 방지
    next();
  });
  privacy.mount(app);

  const requireAdmin = (req, res, next) => {
    if (!req.user || !ADMIN_ROLES.includes(req.user.role)) return res.status(403).json({ error: "관리자 권한이 필요합니다" });
    next();
  };

  app.post("/api/auth/change-password", (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    const acc = getAccountById(req.user.id);
    if (!verifyPassword(currentPassword, acc.password_hash)) return res.status(401).json({ error: "현재 비밀번호가 올바르지 않습니다" });
    const bad = validatePassword(newPassword);
    if (bad) return res.status(400).json({ error: bad });
    if (verifyPassword(newPassword, acc.password_hash)) return res.status(400).json({ error: "현재 비밀번호와 다른 비밀번호를 사용하세요" });
    db.prepare("UPDATE auth_accounts SET password_hash = ?, must_change_pw = 0 WHERE id = ?").run(hashPassword(newPassword), acc.id);
    // 현재 세션을 제외한 이 계정의 다른 세션은 모두 종료
    const cur = sha256(parseCookies(req)[SESSION_COOKIE] || "");
    db.prepare("DELETE FROM auth_sessions WHERE user_id = ? AND token_hash != ?").run(acc.id, cur);
    log({ event: "password_change", user: acc.name, ip: req.ip });
    res.json({ ok: true });
  });

  // ─── 계정 관리 ───────────────────────────────────────────
  app.get("/api/auth/users", (req, res) => {
    const rows = db.prepare("SELECT * FROM auth_accounts ORDER BY registered_at, id").all();
    res.json(rows.map(publicUser));
  });

  app.post("/api/auth/users", requireAdmin, (req, res) => {
    const { name, email, avatar, role, password } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "이름은 필수입니다" });
    const bad = validatePassword(password);
    if (bad) return res.status(400).json({ error: `초기 ${bad}` });
    const r = ROLE_KEYS.includes(role) ? role : "member";
    if (r === "superadmin" && req.user.role !== "superadmin") return res.status(403).json({ error: "마스터 계정은 마스터만 만들 수 있습니다" });
    const id = "U" + crypto.randomBytes(4).toString("hex");
    db.prepare(`INSERT INTO auth_accounts (id, name, email, avatar, role, approved, password_hash, must_change_pw, registered_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, 1, date('now','localtime'))`)
      .run(id, String(name).trim(), (email || "").trim() || null, (avatar || "").trim() || String(name).trim()[0], r, hashPassword(password));
    log({ event: "account_create", user: req.user.name, ip: req.ip, detail: `${String(name).trim()} (${r})` });
    res.json(publicUser(getAccountById(id)));
  });

  app.patch("/api/auth/users/:id", requireAdmin, (req, res) => {
    const target = getAccountById(req.params.id);
    if (!target) return res.status(404).json({ error: "계정을 찾을 수 없습니다" });
    const { role, approved, passcode } = req.body || {};
    if (target.role === "superadmin" && req.user.role !== "superadmin") return res.status(403).json({ error: "마스터 계정은 마스터만 수정할 수 있습니다" });
    if (role !== undefined && role !== target.role) {
      if (!ROLE_KEYS.includes(role)) return res.status(400).json({ error: "알 수 없는 권한입니다" });
      if (role === "superadmin" && req.user.role !== "superadmin") return res.status(403).json({ error: "마스터 권한은 마스터만 부여할 수 있습니다" });
      if (!ROLE_CHANGE_PASSCODE || passcode !== ROLE_CHANGE_PASSCODE) return res.status(403).json({ error: "확인 암호가 일치하지 않습니다" });
      db.prepare("UPDATE auth_accounts SET role = ? WHERE id = ?").run(role, target.id);
      log({ event: "role_change", user: req.user.name, ip: req.ip, detail: `${target.name}: ${target.role} → ${role}` });
    }
    if (approved !== undefined && !!approved !== !!target.approved) {
      if (target.id === req.user.id) return res.status(400).json({ error: "본인 계정은 비활성화할 수 없습니다" });
      db.prepare("UPDATE auth_accounts SET approved = ? WHERE id = ?").run(approved ? 1 : 0, target.id);
      if (!approved) db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(target.id);
      log({ event: approved ? "account_approve" : "account_disable", user: req.user.name, ip: req.ip, detail: target.name });
    }
    res.json(publicUser(getAccountById(target.id)));
  });

  app.post("/api/auth/users/:id/reset-password", requireAdmin, (req, res) => {
    const target = getAccountById(req.params.id);
    if (!target) return res.status(404).json({ error: "계정을 찾을 수 없습니다" });
    if (target.role === "superadmin" && req.user.role !== "superadmin") return res.status(403).json({ error: "마스터 계정은 마스터만 수정할 수 있습니다" });
    const bad = validatePassword(req.body && req.body.newPassword);
    if (bad) return res.status(400).json({ error: bad });
    db.prepare("UPDATE auth_accounts SET password_hash = ?, must_change_pw = 1 WHERE id = ?").run(hashPassword(req.body.newPassword), target.id);
    db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(target.id);
    log({ event: "password_reset", user: req.user.name, ip: req.ip, detail: target.name });
    res.json({ ok: true });
  });

  app.delete("/api/auth/users/:id", requireAdmin, (req, res) => {
    const target = getAccountById(req.params.id);
    if (!target) return res.status(404).json({ error: "계정을 찾을 수 없습니다" });
    if (target.id === req.user.id) return res.status(400).json({ error: "본인 계정은 삭제할 수 없습니다" });
    if (target.role === "superadmin" && req.user.role !== "superadmin") return res.status(403).json({ error: "마스터 계정은 마스터만 삭제할 수 있습니다" });
    db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(target.id);
    db.prepare("DELETE FROM auth_accounts WHERE id = ?").run(target.id);
    log({ event: "account_delete", user: req.user.name, ip: req.ip, detail: target.name });
    res.json({ ok: true });
  });

  console.log(`[auth] 서버 인증 활성화 (2단계 인증: ${TWO_FACTOR_ON ? "켜짐" : "꺼짐"}, 세션 ${SESSION_HOURS}시간)`);
}

module.exports = { setupAuth, hashPassword, verifyPassword, validatePassword, ADMIN_ROLES };
