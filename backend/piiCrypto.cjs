// ============================================================
// 저장 시 암호화 (개인정보보호 조치 4번)
// - 주민등록번호처럼 고유식별정보는 컬럼 단위로 AES-256-GCM 암호화해서 저장한다.
//   (DB 파일/백업 파일이 통째로 유출돼도 원문을 읽을 수 없게 하는 마지막 방어선)
// - 암호문 형식: enc:v1:<iv hex>:<태그 hex>:<암호문 hex>  — 접두사가 없는 값은 아직 암호화 전의 평문으로 본다.
// - 키는 DB/저장소와 분리된 곳에 둔다: 환경변수 PII_ENC_KEY(64자리 hex) →
//   PII_ENC_KEY_FILE 경로의 파일 → 기본값 홈폴더의 .debtflow/pii.key (없으면 자동 생성).
//   ※ 키를 잃어버리면 암호화된 값은 복구할 수 없으므로 키 파일은 별도로 안전하게 보관해야 한다.
// - 비밀번호는 복호화가 필요 없는 일방향 해시(scrypt)로 auth.cjs에서 따로 처리한다.
// ============================================================
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PREFIX = "enc:v1:";
// kv 저장소(수동 등록 채무자 등)의 JSON 안에서 암호화할 키 이름
const ENCRYPT_KEYS = new Set(["residentNumber", "resident_number", "rrn"]);

function loadKey() {
  const fromHex = (hex) => {
    const h = String(hex || "").trim();
    return /^[0-9a-fA-F]{64}$/.test(h) ? Buffer.from(h, "hex") : null;
  };
  try {
    if (process.env.PII_ENC_KEY) {
      const k = fromHex(process.env.PII_ENC_KEY);
      if (k) return k;
      console.error("[pii] PII_ENC_KEY 형식이 올바르지 않습니다 (64자리 hex 필요)");
      return null;
    }
    const file = process.env.PII_ENC_KEY_FILE || path.join(os.homedir(), ".debtflow", "pii.key");
    if (fs.existsSync(file)) {
      const k = fromHex(fs.readFileSync(file, "utf8"));
      if (k) return k;
      console.error(`[pii] 키 파일 형식이 올바르지 않습니다: ${file}`);
      return null;
    }
    // 키가 아직 없으면 새로 만든다 (최초 1회)
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
    console.warn(`[pii] 암호화 키를 새로 만들었습니다: ${file}\n[pii] ※ 이 파일을 분실하면 암호화된 주민번호를 복구할 수 없습니다. 저장소/백업 폴더 밖의 안전한 곳에 별도로 보관하세요.`);
    return fromHex(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error("[pii] 암호화 키를 준비하지 못했습니다 — 암호화 없이 동작합니다:", e.message);
    return null;
  }
}

const KEY = loadKey();
const isEncrypted = (s) => typeof s === "string" && s.startsWith(PREFIX);

function encryptPii(text) {
  if (!KEY || text === null || text === undefined) return text;
  const s = String(text);
  if (s === "" || isEncrypted(s)) return s;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([c.update(s, "utf8"), c.final()]);
  return `${PREFIX}${iv.toString("hex")}:${c.getAuthTag().toString("hex")}:${ct.toString("hex")}`;
}

function decryptPii(s) {
  if (!isEncrypted(s)) return s;
  if (!KEY) return s;
  try {
    const [ivHex, tagHex, ctHex] = s.slice(PREFIX.length).split(":");
    const d = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivHex, "hex"));
    d.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([d.update(Buffer.from(ctHex, "hex")), d.final()]).toString("utf8");
  } catch {
    return ""; // 키가 다르거나 손상된 값은 암호문을 그대로 노출하지 않고 빈 값으로 취급
  }
}

// JSON 값(kv 저장소 등) 안의 주민번호 키를 일괄 암호화/복호화
function mapDeep(value, fn) {
  if (Array.isArray(value)) return value.map(v => mapDeep(v, fn));
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = ENCRYPT_KEYS.has(k) && typeof value[k] === "string" ? fn(value[k]) : mapDeep(value[k], fn);
    }
    return out;
  }
  return value;
}
const encryptDeep = (v) => (KEY ? mapDeep(v, encryptPii) : v);
const decryptDeep = (v) => mapDeep(v, decryptPii);

// 서버 시작 시 1회: 기존에 평문으로 저장된 값을 암호화한다 (이미 암호화된 값은 건너뜀)
function migrateDatabase(db, dbPath) {
  if (!KEY) return;
  const needs = db.prepare(
    "SELECT COUNT(*) c FROM debtors WHERE resident_number IS NOT NULL AND resident_number != '' AND resident_number NOT LIKE 'enc:v1:%'"
  ).get().c;
  const needsLog = db.prepare(
    "SELECT COUNT(*) c FROM debtor_edit_log WHERE field_name = 'residentNumber' AND ((old_value != '' AND old_value NOT LIKE 'enc:v1:%') OR (new_value != '' AND new_value NOT LIKE 'enc:v1:%'))"
  ).get().c;
  const kvRows = db.prepare("SELECT key, value FROM kv_store").all().filter(r => /"(residentNumber|resident_number|rrn)"\s*:\s*"(?!enc:v1:)[^"]+"/.test(r.value || ""));
  if (!needs && !needsLog && !kvRows.length) return;

  // 암호화 전 안전 사본 — 문제가 생기면 이 파일로 되돌릴 수 있다. (평문이 들어있으므로 확인 후 직접 삭제할 것)
  try {
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const dest = path.join(path.dirname(dbPath), `debtflow_pre_encrypt_${stamp}.db`);
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    console.log(`[pii] 암호화 전 안전 사본을 만들었습니다: ${dest} (확인 후 삭제하세요 — 평문 포함)`);
  } catch (e) {
    console.error("[pii] 안전 사본 생성 실패 — 암호화를 건너뜁니다:", e.message);
    return;
  }

  const tx = db.transaction(() => {
    const sel = db.prepare("SELECT id, resident_number FROM debtors WHERE resident_number IS NOT NULL AND resident_number != '' AND resident_number NOT LIKE 'enc:v1:%'").all();
    const upd = db.prepare("UPDATE debtors SET resident_number = ? WHERE id = ?");
    for (const r of sel) upd.run(encryptPii(r.resident_number), r.id);

    const logs = db.prepare("SELECT id, old_value, new_value FROM debtor_edit_log WHERE field_name = 'residentNumber'").all();
    const updLog = db.prepare("UPDATE debtor_edit_log SET old_value = ?, new_value = ? WHERE id = ?");
    for (const l of logs) updLog.run(encryptPii(l.old_value ?? ""), encryptPii(l.new_value ?? ""), l.id);

    const updKv = db.prepare("UPDATE kv_store SET value = ? WHERE key = ?");
    for (const r of kvRows) {
      try { updKv.run(JSON.stringify(encryptDeep(JSON.parse(r.value))), r.key); } catch {}
    }
    console.log(`[pii] 주민번호 암호화 완료: 채무자 ${sel.length}건, 수정로그 ${logs.length}건, 공유저장소 ${kvRows.length}건`);
  });
  tx();
}

module.exports = { encryptPii, decryptPii, isEncrypted, encryptDeep, decryptDeep, migrateDatabase, keyReady: !!KEY };
