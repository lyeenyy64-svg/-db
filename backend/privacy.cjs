// ============================================================
// 개인정보 마스킹 (개인정보보호 조치 3번)
// - 모든 /api JSON 응답을 서버에서 한 번 훑어 주민번호·연락처·주소·좌표를 기본 마스킹한다.
//   (화면에서만 가리면 API 응답에 원문이 그대로 남기 때문에 응답 단계에서 처리)
// - 원문은 담당 권한자가 "사유"를 입력해 열람 허용(grant)을 받은 채무자에 한해 일정 시간만 내려간다.
// - 마스킹된 값이 화면에서 다시 저장 요청으로 돌아와도 DB 원문을 덮어쓰지 않도록 쓰기 요청을 정리한다.
// ============================================================
const { decryptDeep } = require("./piiCrypto.cjs");
const REVEAL_MINUTES = Number(process.env.PII_REVEAL_MINUTES) || 30;
const MIN_REASON_LEN = 5;

const RRN_KEYS = new Set(["residentNumber", "resident_number", "rrn"]);
const PHONE_KEYS = new Set(["phone", "creditPhone", "credit_phone", "mobile", "tel", "phoneNumber"]);
const ADDR_KEYS = new Set([
  "latestAddress", "manualAddress", "residentAddress", "address", "creditAddress",
  "latest_address", "manual_address", "resident_address",
]);
const COORD_KEYS = new Set([
  "lat", "lng", "latestAddressLat", "latestAddressLng", "manualAddressLat", "manualAddressLng",
  "residentAddressLat", "residentAddressLng",
]);

const PII_WRITE_KEYS = new Set([...RRN_KEYS, ...PHONE_KEYS, ...ADDR_KEYS]);

// 값 어디에 있든(자유 텍스트 포함) 주민등록번호 형태는 뒤 7자리를 가린다
const RRN_RE = /(?<!\d)(\d{6})-([1-8]\d{6})(?!\d)/g;
const PHONE_RE = /(0\d{1,2})[-\s.]?(\d{3,4})[-\s.]?(\d{4})/g;

// 뒷자리는 첫 숫자(성별·세기 구분)만 남기고 가린다 — 화면이 이 숫자로 출생 세기(19xx/20xx)와 나이를 계산한다
const maskRrnText = (s) => s.replace(RRN_RE, (m, front, back) => `${front}-${back[0]}******`);
const maskPhoneText = (s) => s.replace(PHONE_RE, "$1-****-$3");
function maskAddressText(s) {
  const t = s.trim().split(/\s+/);
  if (t.length <= 1) return t[0] ? t[0].slice(0, 2) + "***" : s;
  return t.slice(0, Math.min(2, t.length - 1)).join(" ") + " ***";
}
const maskCoord = (n) => Math.round(n * 100) / 100; // 약 1km 단위로만 노출

const isFpKey = (k) => k.endsWith("Fp") && RRN_KEYS.has(k.slice(0, -2));

// 주민번호 지문 — 서버에만 있는 솔트로 만든 해시의 앞부분 (원문 복원 불가, 같은 번호끼리만 일치)
let FP_SALT = "";
const rrnFingerprint = (s) => require("crypto").createHash("sha256").update(FP_SALT + String(s).replace(/\D/g, "")).digest("hex").slice(0, 12);

// 키 이름에 맞는 마스킹 (문자열 값)
function maskStringByKey(key, s) {
  let out = maskRrnText(s);
  if (RRN_KEYS.has(key)) out = out.replace(/^(\d{6})[-\s]?(\d)\d*$/, "$1-$2******");
  else if (PHONE_KEYS.has(key)) out = maskPhoneText(out);
  else if (ADDR_KEYS.has(key)) out = maskAddressText(out);
  return out;
}

// 응답 본문 전체를 재귀적으로 마스킹 — granted에 든 채무자(id/debtorId) 하위는 원문 그대로 둔다
function maskDeep(value, granted, key) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return maskStringByKey(key, value);
  if (typeof value === "number") return COORD_KEYS.has(key) ? maskCoord(value) : value;
  if (Array.isArray(value)) return value.map(v => maskDeep(v, granted, key));
  if (typeof value === "object") {
    const gid = value.debtorId ?? value.id;
    const out = {};
    // 주민번호 원문 대신 화면이 "같은 사람인지" 비교할 수 있도록, 복원 불가능한 지문(Fp)을 함께 내려준다
    // (가려진 값끼리는 생년월일이 같으면 구분이 안 되기 때문 — 열람 허용 여부와 상관없이 항상 포함)
    for (const k of RRN_KEYS) {
      if (typeof value[k] === "string" && /^\d{6}-?\d{7}$/.test(value[k].trim())) out[k + "Fp"] = rrnFingerprint(value[k]);
    }
    if (gid !== undefined && granted.has(String(gid))) return Object.assign(out, value);
    // 수정 로그처럼 {fieldName, oldValue, newValue} 형태는 필드명을 기준으로 값을 가린다
    const logField = typeof value.fieldName === "string" && PII_WRITE_KEYS.has(value.fieldName) ? value.fieldName : null;
    for (const k of Object.keys(value)) {
      out[k] = logField && (k === "oldValue" || k === "newValue") && typeof value[k] === "string"
        ? maskStringByKey(logField, value[k]) : maskDeep(value[k], granted, k);
    }
    return out;
  }
  return value;
}

// 쓰기 요청 정리: 화면이 들고 있던 "마스킹된 값"이 그대로 돌아오면 DB의 원래 값으로 되돌린다
function restoreMasked(next, prev, key) {
  if (typeof next === "string") {
    if (typeof prev !== "string" || next === prev) return next;
    if (maskStringByKey(key, prev) === next) return prev;
    // 자유 텍스트(메모 등)에 섞인 가려진 주민번호는 앞 6자리가 같은 원문으로 되돌린다 (그 외 편집 내용은 유지)
    const origs = prev.match(RRN_RE);
    if (origs && /-\d\*{6}/.test(next)) {
      const pool = origs.slice();
      return next.replace(/(?<!\d)(\d{6})-(\d)\*{6}/g, (m, head, first) => {
        const i = pool.findIndex(o => o.startsWith(`${head}-${first}`));
        return i >= 0 ? pool.splice(i, 1)[0] : m;
      });
    }
    return next;
  }
  if (typeof next === "number") {
    if (COORD_KEYS.has(key) && typeof prev === "number" && Math.abs(next - prev) < 0.006) return prev;
    return next;
  }
  if (Array.isArray(next)) {
    const prevArr = Array.isArray(prev) ? prev : [];
    const byId = new Map();
    for (const p of prevArr) if (p && typeof p === "object" && p.id !== undefined) byId.set(String(p.id), p);
    return next.map((n, i) => {
      if (n && typeof n === "object" && !Array.isArray(n) && n.id !== undefined) return restoreMasked(n, byId.get(String(n.id)), key);
      if (prevArr.length === next.length) return restoreMasked(n, prevArr[i], key);
      return n;
    });
  }
  if (next && typeof next === "object") {
    const p = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
    const out = {};
    for (const k of Object.keys(next)) {
      if (isFpKey(k)) continue; // 서버가 응답에 덧붙인 지문은 저장하지 않는다 (원문이 바뀌면 낡은 값이 되므로)
      out[k] = restoreMasked(next[k], p[k], k);
    }
    return out;
  }
  return next;
}

// 연락처 문자열 안의 가려진 번호(010-****-6400)를 DB 원문 번호(앞자리·끝 4자리가 같은 것)로 되돌린다.
// 이름/설명만 고치고 번호는 그대로 둔 저장이 "가려진 값"으로 취급돼 통째로 버려지는 것을 막는다.
function restorePhoneText(next, prev) {
  if (typeof next !== "string" || typeof prev !== "string" || !next.includes("*")) return next;
  const pool = prev.match(PHONE_RE) || [];
  return next.replace(/(0\d{1,2})-\*{4}-(\d{4})/g, (m, head, tail) => {
    const i = pool.findIndex(o => maskPhoneText(o) === m);
    return i >= 0 ? pool.splice(i, 1)[0] : m;
  });
}

// 채무자 쓰기 요청에서 값이 이미 가려진 개인정보 필드를 제거 (원본을 모르는 경로용)
function dropMaskedWrites(body) {
  if (!body || typeof body !== "object") return body;
  if (Array.isArray(body)) return body.map(dropMaskedWrites);
  const out = {};
  for (const k of Object.keys(body)) {
    const v = body[k];
    if (COORD_KEYS.has(k) || isFpKey(k)) continue; // 좌표는 지오코딩 API만 기록한다 (화면이 가려진 값을 되돌려 보내는 것 방지)
    if (PII_WRITE_KEYS.has(k) && typeof v === "string" && v.includes("*")) continue;
    out[k] = dropMaskedWrites(v);
  }
  return out;
}

function createPrivacy(db, { audit } = {}) {
  const log = typeof audit === "function" ? audit : () => {};
  db.exec(`
    CREATE TABLE IF NOT EXISTS pii_reveal_grants (
      session_hash TEXT NOT NULL,
      debtor_id    TEXT NOT NULL,
      expires_at   INTEGER NOT NULL,
      PRIMARY KEY (session_hash, debtor_id)
    );
  `);
  db.exec("CREATE TABLE IF NOT EXISTS app_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
  let saltRow = db.prepare("SELECT value FROM app_secrets WHERE name = 'pii_fp_salt'").get();
  if (!saltRow) {
    db.prepare("INSERT INTO app_secrets (name, value) VALUES ('pii_fp_salt', ?)").run(require("crypto").randomBytes(24).toString("hex"));
    saltRow = db.prepare("SELECT value FROM app_secrets WHERE name = 'pii_fp_salt'").get();
  }
  FP_SALT = saltRow.value;
  const grantedIds = (sessionHash) => {
    const rows = db.prepare("SELECT debtor_id FROM pii_reveal_grants WHERE session_hash = ? AND expires_at > ?").all(sessionHash, Date.now());
    return new Set(rows.map(r => String(r.debtor_id)));
  };
  setInterval(() => { try { db.prepare("DELETE FROM pii_reveal_grants WHERE expires_at < ?").run(Date.now()); } catch {} }, 10 * 60 * 1000).unref();

  // 가드 미들웨어에서 호출: 이 요청의 응답/쓰기 본문에 마스킹 규칙을 붙인다
  function attach(req, res) {
    const p = req.path;
    if (p.startsWith("/auth/") || p === "/events") return;
    const granted = grantedIds(req.sessionHash);
    // /debtor/:id/... 계열(주민번호·주소 조회 등)은 응답에 id가 없으므로 경로의 채무자로 판단
    const m = p.match(/^\/debtor\/([^/]+)\//);
    const routeGranted = m && granted.has(decodeURIComponent(m[1]));
    if (!routeGranted) {
      const origJson = res.json.bind(res);
      res.json = (body) => origJson(maskDeep(body, granted, undefined));
    }
    // 쓰기 요청 정리
    if (req.method !== "GET" && req.method !== "HEAD" && req.body && typeof req.body === "object") {
      if (/^\/debtors(\/|$)|^\/debtor\//.test(p)) {
        const dm = req.method === "PATCH" && p.match(/^\/debtors\/([^/]+)$/);
        if (dm && dm[1] !== "bulk") {
          try {
            const row = db.prepare("SELECT phone, credit_phone FROM debtors WHERE id = ?").get(decodeURIComponent(dm[1]));
            if (row) {
              req.body = { ...req.body };
              if (typeof req.body.phone === "string") req.body.phone = restorePhoneText(req.body.phone, row.phone);
              if (typeof req.body.creditPhone === "string") req.body.creditPhone = restorePhoneText(req.body.creditPhone, row.credit_phone);
            }
          } catch {}
        }
        req.body = dropMaskedWrites(req.body);
      } else if (req.method === "PUT" && /^\/kv\/[^/]+$/.test(p)) {
        const key = decodeURIComponent(p.slice(4));
        const row = db.prepare("SELECT value FROM kv_store WHERE key = ?").get(key);
        if (row) { try { req.body = restoreMasked(req.body, decryptDeep(JSON.parse(row.value)), undefined); } catch {} }
      }
    }
  }

  function mount(app) {
    // 원문 열람 허용 — 매니저 이상, 사유 필수. 사유와 열람 사실은 접속기록에 남는다 (사유에 개인정보를 적지 않도록 화면에서 안내)
    app.post("/api/privacy/reveal", (req, res) => {
      if (!["manager", "admin", "superadmin"].includes(req.user.role)) return res.status(403).json({ error: "원문 열람 권한이 없습니다" });
      const debtorIds = (Array.isArray(req.body.debtorIds) ? req.body.debtorIds : [req.body.debtorId]).map(x => String(x || "")).filter(Boolean).slice(0, 50);
      const reason = String(req.body.reason || "").trim();
      if (!debtorIds.length) return res.status(400).json({ error: "대상 채무자가 없습니다" });
      if (reason.length < MIN_REASON_LEN) return res.status(400).json({ error: `사유를 ${MIN_REASON_LEN}자 이상 입력하세요` });
      const exp = Date.now() + REVEAL_MINUTES * 60 * 1000;
      const ins = db.prepare("INSERT OR REPLACE INTO pii_reveal_grants (session_hash, debtor_id, expires_at) VALUES (?, ?, ?)");
      for (const id of debtorIds) ins.run(req.sessionHash, id, exp);
      // 사유를 앞에 둔다 — 접속기록 detail은 300자에서 잘리는데, 대상 ID가 많으면 뒤에 있던 사유가 통째로 사라졌다.
      // count는 이번 요청으로 열람한 채무자 수 — 이상 행위 판정이 요청 수가 아니라 열람 인원 기준이 되게 한다.
      log({ event: "pii_reveal", user: req.user.name, ip: req.ip, count: debtorIds.length, detail: `사유: ${reason.slice(0, 150)} / 대상 ${debtorIds.length}건: ${debtorIds.join(",")}` });
      res.json({ ok: true, expiresAt: exp, minutes: REVEAL_MINUTES });
    });
    app.get("/api/privacy/grants", (req, res) => {
      const rows = db.prepare("SELECT debtor_id, expires_at FROM pii_reveal_grants WHERE session_hash = ? AND expires_at > ?").all(req.sessionHash, Date.now());
      res.json(rows.map(r => ({ debtorId: r.debtor_id, expiresAt: r.expires_at })));
    });
    app.post("/api/privacy/hide", (req, res) => {
      db.prepare("DELETE FROM pii_reveal_grants WHERE session_hash = ?").run(req.sessionHash);
      res.json({ ok: true });
    });
  }

  return { attach, mount };
}

module.exports = { createPrivacy, maskDeep, restoreMasked, dropMaskedWrites, maskRrnText, maskPhoneText, maskAddressText };
