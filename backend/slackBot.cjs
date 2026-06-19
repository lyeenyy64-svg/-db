// ============================================================
// Slack Bot — 다채널 폴링 + 자동 입금 적재
// 채널별 파서: 바로고(국민#1812), 모아라인(★모아라인입금알림★), 딜버(★입금내역딜버★)
// ============================================================
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { WebClient } = require("@slack/web-api");
const slackParser = require("./slackParser.cjs");

const TOKEN = process.env.SLACK_BOT_TOKEN;
const POLL_INTERVAL_MS = (parseInt(process.env.SLACK_POLL_INTERVAL_MINUTES, 10) || 5) * 60 * 1000;

const client = TOKEN ? new WebClient(TOKEN) : null;

// ─── 채널 설정 ────────────────────────────────────────────
// kvKey: kv_store에서 lastTs를 보관할 키 (채널별로 독립)
const CHANNEL_CONFIGS = [
  {
    id: process.env.SLACK_CHANNEL_ID,
    label: "바로고",
    brand: "B",
    kvKey: "slack_last_ts_barogo",
    parse: (text, msgDate) => slackParser.parse(text, msgDate),
  },
  {
    id: process.env.SLACK_CHANNEL_MOALINE_ID,
    label: "모아라인",
    brand: "M",
    kvKey: "slack_last_ts_moaline",
    parse: (text, msgDate) => slackParser.parseMoaline(text, msgDate),
  },
  {
    id: process.env.SLACK_CHANNEL_DILVER_ID,
    label: "딜버",
    brand: "D",
    kvKey: "slack_last_ts_dilver",
    parse: (text) => slackParser.parseDilver(text),
  },
].filter(c => c.id); // ID 미설정 채널은 제외

// ─── 상태 ────────────────────────────────────────────────
const status = {
  enabled: false,
  connected: false,
  botName: null,
  team: null,
  lastPollAt: null,
  lastError: null,
  pollIntervalMinutes: POLL_INTERVAL_MS / 60000,
  channels: Object.fromEntries(
    CHANNEL_CONFIGS.map(c => [c.label, {
      channelId: c.id,
      lastTs: null,
      lastPollResult: null,
      totalScanned: 0,
      totalIngested: 0,
      totalPending: 0,
    }])
  ),
};

// ─── kv_store ─────────────────────────────────────────────
function ensureKvStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);
}

function getLastTs(db, key) {
  const row = db.prepare("SELECT value FROM kv_store WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setLastTs(db, key, ts) {
  db.prepare(`
    INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now', 'localtime'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, ts);
}

// ─── 연결 확인 ────────────────────────────────────────────
async function checkConnection() {
  if (!client) return null;
  try {
    const r = await client.auth.test();
    status.connected = true;
    status.botName = r.user;
    status.team = r.team;
    status.lastError = null;
    return r;
  } catch (e) {
    status.connected = false;
    status.lastError = e.data?.error || e.message;
    return null;
  }
}

// ─── 채널 1개 폴링 ────────────────────────────────────────
async function pollChannel(db, ingestPayment, cfg) {
  const chStatus = status.channels[cfg.label];
  const oldest = getLastTs(db, cfg.kvKey);
  const args = { channel: cfg.id, limit: 100 };
  if (oldest) args.oldest = oldest;

  const result = await client.conversations.history(args);
  const messages = (result.messages || []).slice().reverse();

  let processed = 0, success = 0, pending = 0;
  let newLastTs = oldest;

  for (const msg of messages) {
    if (oldest && msg.ts <= oldest) continue;
    // channel_join은 항상 스킵. bot_message는 스킵하지 않음 —
    // 모아라인/딜버는 워크플로 봇이 메시지를 올리므로 파서가 직접 판별
    if (msg.subtype === "channel_join") {
      newLastTs = msg.ts;
      continue;
    }

    const messageDate = new Date(parseFloat(msg.ts) * 1000).toISOString();
    const parsed = cfg.parse(msg.text || "", messageDate);

    for (const entry of parsed.entries) {
      const r = ingestPayment({
        paymentDate: entry.paymentDate,
        payerName: entry.payerName,
        totalAmount: entry.totalAmount,
        companyAccount: entry.totalAmount,
        brand: entry.brand || cfg.brand,
        note: entry.note || null,
        source: "slack",
        sourceRef: msg.ts,
        createdByName: `Slack 자동수집(${cfg.label})`,
      });
      if (r.ok) success++;
      else if (r.pendingId) pending++;
      else if (r.isDuplicate) { /* 중복 — skip */ }
      processed++;
    }

    newLastTs = msg.ts;
  }

  if (newLastTs && newLastTs !== oldest) setLastTs(db, cfg.kvKey, newLastTs);

  chStatus.lastTs = newLastTs;
  chStatus.totalScanned += messages.length;
  chStatus.totalIngested += success;
  chStatus.totalPending += pending;
  chStatus.lastPollResult = { fetched: messages.length, processed, success, pending };

  return { channel: cfg.label, ok: true, fetched: messages.length, processed, success, pending };
}

// ─── 전체 채널 폴링 ───────────────────────────────────────
async function pollAllChannels(db, ingestPayment) {
  if (!client || CHANNEL_CONFIGS.length === 0) {
    return { ok: false, error: "SLACK_BOT_TOKEN 또는 채널 ID 미설정" };
  }
  ensureKvStore(db);
  const results = [];
  for (const cfg of CHANNEL_CONFIGS) {
    try {
      const r = await pollChannel(db, ingestPayment, cfg);
      results.push(r);
    } catch (e) {
      const err = e.data?.error || e.message;
      status.lastError = err;
      results.push({ channel: cfg.label, ok: false, error: err });
    }
  }
  status.lastPollAt = new Date().toISOString();
  return { ok: true, results };
}

// 하위호환: pollOnce는 전체 채널 폴링으로 위임
async function pollOnce(db, ingestPayment) {
  return pollAllChannels(db, ingestPayment);
}

// ─── 봇 시작/종료 ─────────────────────────────────────────
let intervalId = null;

function startBot(db, ingestPayment) {
  if (!TOKEN) {
    console.log("⚠️  Slack 봇 비활성화 (SLACK_BOT_TOKEN 미설정)");
    status.enabled = false;
    return false;
  }
  if (CHANNEL_CONFIGS.length === 0) {
    console.log("⚠️  Slack 봇 비활성화 (채널 ID 미설정)");
    status.enabled = false;
    return false;
  }
  status.enabled = true;
  ensureKvStore(db);

  checkConnection().then(r => {
    if (r) console.log(`✅ Slack 봇 연결: @${r.user} on "${r.team}"`);
    else console.log(`❌ Slack 인증 실패: ${status.lastError}`);
  });

  if (intervalId) clearInterval(intervalId);
  intervalId = setInterval(() => pollAllChannels(db, ingestPayment), POLL_INTERVAL_MS);

  const labels = CHANNEL_CONFIGS.map(c => `${c.label}(${c.id})`).join(", ");
  console.log(`📡 Slack 폴링 시작 (${POLL_INTERVAL_MS / 60000}분 간격)`);
  console.log(`   채널: ${labels}`);

  setTimeout(() => pollAllChannels(db, ingestPayment), 3000);
  return true;
}

function stopBot() {
  if (intervalId) { clearInterval(intervalId); intervalId = null; }
}

function getStatus() {
  return { ...status };
}

module.exports = { startBot, stopBot, getStatus, pollOnce, checkConnection };
