// 자유 텍스트(채무자 히스토리 메모 등)에서 한국어 날짜 표현(절대/상대)을 찾아
// refDate 기준 절대 날짜로 변환한다. "히스토리에 적힌 입금 약속일 리마인드"용으로,
// 정확도보다 폭넓은 인식(false positive 허용)을 우선한다 — 애매하면 일단 후보로 잡는다.

const WEEKDAY = { "일": 0, "월": 1, "화": 2, "수": 3, "목": 4, "금": 5, "토": 6 };

function pad2(n) { return String(n).padStart(2, "0"); }
function ymd(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function lastDayOfMonth(year, month0) { return new Date(year, month0 + 1, 0); }
function clampDate(year, month0, day) {
  const last = lastDayOfMonth(year, month0).getDate();
  return new Date(year, month0, Math.min(Math.max(day, 1), last));
}

// text: 대상 문자열, refDate: 이 메모가 기록된(또는 오늘) 날짜(Date) — 상대 표현의 기준점.
// 반환: [{ date: Date, raw: 매칭된 원문 조각 }]
function parseKoreanDates(text, refDate) {
  if (!text) return [];
  const ref = refDate instanceof Date && !isNaN(refDate.getTime()) ? refDate : null;
  const anchorYear = (ref || new Date()).getFullYear();
  const found = [];
  const push = (date, raw) => { if (date && !isNaN(date.getTime())) found.push({ date, raw }); };

  // "8월 11일" / "8월11" (일 생략 가능)
  for (const m of text.matchAll(/(\d{1,2})\s*월\s*(\d{1,2})\s*일?/g)) {
    const mo = parseInt(m[1], 10), day = parseInt(m[2], 10);
    if (mo >= 1 && mo <= 12 && day >= 1 && day <= 31) push(clampDate(anchorYear, mo - 1, day), m[0]);
  }
  // "8.11" / "8/11" / "8-11"
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})[./-](\d{1,2})(?!\d)/g)) {
    const mo = parseInt(m[1], 10), day = parseInt(m[2], 10);
    if (mo >= 1 && mo <= 12 && day >= 1 && day <= 31) push(clampDate(anchorYear, mo - 1, day), m[0]);
  }

  if (ref) {
    if (/내일/.test(text)) push(addDays(ref, 1), "내일");
    if (/모레/.test(text)) push(addDays(ref, 2), "모레");
    if (/글피/.test(text)) push(addDays(ref, 3), "글피");

    // (이번주|다음주|차주|담주)? X요일
    for (const m of text.matchAll(/(이번\s?주|다음\s?주|차주|담주)?\s*([일월화수목금토])요일/g)) {
      const targetDow = WEEKDAY[m[2]];
      const refDow = ref.getDay();
      let diff = (targetDow - refDow + 7) % 7;
      if (m[1] && /다음|차주|담주/.test(m[1])) diff += 7;
      push(addDays(ref, diff), m[0]);
    }

    // (이번달|이달|다음달|익월) (말/말일/초/중순)
    const y = ref.getFullYear(), mo0 = ref.getMonth();
    for (const m of text.matchAll(/(이번\s?달|이달|다음\s?달|익월)\s*(말일?|초|중순)/g)) {
      const isNext = /다음|익월/.test(m[1]);
      const targetMo0Raw = isNext ? mo0 + 1 : mo0;
      const targetYear = y + Math.floor(targetMo0Raw / 12);
      const normMo0 = ((targetMo0Raw % 12) + 12) % 12;
      let day;
      if (/말/.test(m[2])) day = lastDayOfMonth(targetYear, normMo0).getDate();
      else if (/초/.test(m[2])) day = 3;
      else day = 15; // 중순
      push(new Date(targetYear, normMo0, day), m[0]);
    }

    // 단독 "N일에/까지/경" — 입금/납부 관련 단어가 근처에 있을 때만(과도한 노이즈 방지)
    for (const m of text.matchAll(/(\d{1,2})\s*일(?:까지|에|경)/g)) {
      const day = parseInt(m[1], 10);
      if (day < 1 || day > 31) continue;
      const idx = m.index || 0;
      const around = text.slice(Math.max(0, idx - 12), idx + 12);
      if (!/입금|납부|드리|넣|송금|갚|보내/.test(around)) continue;
      let targetMo0 = mo0, targetYear = y;
      if (day < ref.getDate()) { targetMo0 += 1; if (targetMo0 > 11) { targetMo0 = 0; targetYear += 1; } }
      push(clampDate(targetYear, targetMo0, day), m[0]);
    }
  }

  return found;
}

module.exports = { parseKoreanDates, ymd };
