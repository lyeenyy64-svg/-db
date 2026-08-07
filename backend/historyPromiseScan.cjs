// 채무자 히스토리(추심활동 + 히스토리 탭 수동/자동 기록)를 훑어서, 오늘 기준 ±windowDays
// 안에 걸리는 "약속 날짜"를 찾아낸다. 두 가지 방식을 모두 잡는다:
//  1) 기록 자체의 날짜가 창 안이면 그대로 후보로 삼는다 (담당자가 "다음주 화요일" 약속을
//     기록일 자체를 그 약속일로 남기는 관행이 있음).
//  2) 본문 텍스트에 언급된 날짜(절대/상대 표현)를 기록일 기준으로 해석해 창 안이면 후보로 삼는다.
// 정확도보다 폭넓은 인식을 우선한다 — 불필요한 후보가 섞여도 괜찮다는 전제.
const { parseKoreanDates, ymd } = require("./koreanDateParse.cjs");

function parseAnyDate(str) {
  if (!str) return null;
  const m = /^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/.exec(String(str).trim());
  if (!m) return null;
  const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  return isNaN(d.getTime()) ? null : d;
}

function withinWindow(date, today, windowDays) {
  const diffDays = Math.round((date - today) / 86400000);
  return diffDays >= -windowDays && diffDays <= windowDays;
}

function scanHistoryPromises(db, { windowDays = 7 } = {}) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const results = [];
  const seen = new Set();

  const addResult = (debtorId, debtorName, hubName, entryDateStr, content, resolvedDate, raw, source) => {
    const key = `${debtorId}|${entryDateStr}|${content}|${ymd(resolvedDate)}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({
      debtorId, debtorName, hubName,
      entryDate: entryDateStr,
      resolvedDate: ymd(resolvedDate),
      snippet: content.length > 60 ? content.slice(0, 57) + "..." : content,
      raw, source,
    });
  };

  const acts = db.prepare(`
    SELECT a.debtor_id, a.activity_date, a.content, d.name AS debtor_name, d.hub_name
    FROM activities a JOIN debtors d ON a.debtor_id = d.id
    WHERE a.content IS NOT NULL AND a.content <> ''
  `).all();
  for (const a of acts) {
    const refDate = parseAnyDate(a.activity_date);
    if (refDate && withinWindow(refDate, today, windowDays)) {
      addResult(a.debtor_id, a.debtor_name, a.hub_name, a.activity_date, a.content, refDate, a.activity_date, "기록일");
    }
    for (const { date, raw } of parseKoreanDates(a.content, refDate)) {
      if (withinWindow(date, today, windowDays)) {
        addResult(a.debtor_id, a.debtor_name, a.hub_name, a.activity_date, a.content, date, raw, "본문언급");
      }
    }
  }

  const kvRows = db.prepare("SELECT key, value FROM kv_store WHERE key LIKE 'hist\\_m\\_%' ESCAPE '\\'").all();
  const debtorCache = new Map();
  const getDebtor = (id) => {
    if (debtorCache.has(id)) return debtorCache.get(id);
    const row = db.prepare("SELECT name, hub_name FROM debtors WHERE id = ?").get(id);
    debtorCache.set(id, row || null);
    return row || null;
  };
  for (const row of kvRows) {
    const debtorId = row.key.slice("hist_m_".length);
    let entries;
    try { entries = JSON.parse(row.value || "[]"); } catch { continue; }
    if (!Array.isArray(entries)) continue;
    const debtor = getDebtor(debtorId);
    if (!debtor) continue;
    for (const h of entries) {
      if (!h || !h.content) continue;
      const refDate = parseAnyDate(h.date);
      if (refDate && withinWindow(refDate, today, windowDays)) {
        addResult(debtorId, debtor.name, debtor.hub_name, h.date, h.content, refDate, h.date, "기록일");
      }
      for (const { date, raw } of parseKoreanDates(h.content, refDate)) {
        if (withinWindow(date, today, windowDays)) {
          addResult(debtorId, debtor.name, debtor.hub_name, h.date, h.content, date, raw, "본문언급");
        }
      }
    }
  }

  results.sort((a, b) => a.resolvedDate.localeCompare(b.resolvedDate));
  return results;
}

module.exports = { scanHistoryPromises };
