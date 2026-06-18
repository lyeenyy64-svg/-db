// ============================================================
// Slack 입금 메시지 파서
// 규칙:
//   1) 메시지 안에 "국민#1812" 헤더가 있으면, 그 헤더 이후 라인만 채택
//      (법무실 전용 추심 계좌). 헤더 없는 메시지는 무시.
//   2) 다른 은행 헤더(신한#xxxx, 우리#xxxx 등)가 나오면 채택 중단.
//   3) "MM/DD" 라인은 그 아래 모든 입금 라인의 날짜로 적용.
//      연도는 messageDate(Slack 메시지 발송 시각)의 연도 사용.
//   4) "입금자명 ... 금액(콤마 포함)" 형식의 라인 = 입금건.
// ============================================================

// 다른 은행 헤더 패턴 (이 헤더가 나오면 채택 중단)
// 예: "신한 1234-...", "우리#5678", "농협 ..."
const OTHER_BANK_HEADER = /^(신한|우리|하나|농협|기업|카카오뱅크|토스뱅크|SC제일|새마을|수협|광주|대구|부산|경남|전북|제주)[\s#]/;

// 국민#1812 패턴 (공백·# 변형 허용)
const KOOKMIN_1812 = /국민\s*[#]?\s*1812/;

// MM/DD
const DATE_LINE = /^(\d{1,2})\s*\/\s*(\d{1,2})$/;

// 날짜+이름+금액 한 줄 형식 (FinanceDesk 봇 포맷)
// 예: "06/11 김영준00 115,488원"  "06/11 안성용 100,000원"
const COMBINED_LINE = /^(\d{1,2})\s*\/\s*(\d{1,2})\s+(.+?)\s+([\d]{1,3}(?:,\d{3})+|\d{4,})원?$/;

// 마지막 토큰이 금액인 라인 ("원" 접미사 선택 허용)
// 그룹1: 입금자명 (공백 포함 가능), 그룹2: 금액 (콤마 포함)
const PAYMENT_LINE = /^(.+?)\s+([\d]{1,3}(?:,\d{3})+|\d{4,})원?$/;

function parse(text, messageDate) {
  const lines = String(text || "").split(/\r?\n/);
  const messageYear = messageDate
    ? new Date(messageDate).getFullYear()
    : new Date().getFullYear();

  let activated = false;       // 국민#1812 헤더 이후 활성화
  let currentDate = null;
  const entries = [];
  const meta = {
    hasKookminHeader: false,
    foundDates: [],
    rejectedLines: [],         // 디버깅용: 무시된 라인
    deactivatedByHeader: null, // 다른 은행 헤더로 중단된 경우
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // 국민#1812 헤더 — 활성화
    if (KOOKMIN_1812.test(line)) {
      activated = true;
      meta.hasKookminHeader = true;
      continue;
    }

    // 다른 은행 헤더 — 채택 중단
    if (OTHER_BANK_HEADER.test(line)) {
      if (activated) meta.deactivatedByHeader = line;
      activated = false;
      continue;
    }

    if (!activated) {
      meta.rejectedLines.push({ line, reason: "국민#1812 헤더 이전" });
      continue;
    }

    // 날짜+이름+금액 합산 라인 (FinanceDesk 봇: "06/11 김영준00 115,488원")
    const cm = line.match(COMBINED_LINE);
    if (cm) {
      const mm = cm[1].padStart(2, "0");
      const dd = cm[2].padStart(2, "0");
      const date = `${messageYear}-${mm}-${dd}`;
      const payerName = cm[3].trim().replace(/\s+/g, " ");
      const amount = parseInt(cm[4].replace(/,/g, ""), 10);
      if (!isNaN(amount) && amount > 0) {
        entries.push({ paymentDate: date, payerName, totalAmount: amount });
        meta.foundDates.push(date);
      }
      continue;
    }

    // 날짜 단독 라인
    const dm = line.match(DATE_LINE);
    if (dm) {
      const mm = dm[1].padStart(2, "0");
      const dd = dm[2].padStart(2, "0");
      currentDate = `${messageYear}-${mm}-${dd}`;
      meta.foundDates.push(currentDate);
      continue;
    }

    // 입금 라인
    const pm = line.match(PAYMENT_LINE);
    if (pm) {
      const payerName = pm[1].trim().replace(/\s+/g, " ");
      const amount = parseInt(pm[2].replace(/,/g, ""), 10);
      if (!isNaN(amount) && amount > 0) {
        entries.push({
          paymentDate: currentDate,
          payerName,
          totalAmount: amount,
        });
        continue;
      }
    }

    meta.rejectedLines.push({ line, reason: "형식 불일치" });
  }

  return { entries, meta };
}

// ============================================================
// 모아라인 파서
// 형식 (메시지 1건 = 입금 1건):
//   ★ 모아라인 입금알림 ★
//   YYYY-MM-DD
//   입금자명
//   [5/11~5/17 같은 기간 라인 — 무시]
//   금액원
// ============================================================
function parseMoaline(text) {
  const lines = String(text || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const entries = [];
  const meta = { brand: "M", hasHeader: false };

  const headerIdx = lines.findIndex(l => /★.*모아라인.*입금/.test(l));
  if (headerIdx === -1) return { entries, meta };
  meta.hasHeader = true;

  let paymentDate = null, payerName = null;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    // 날짜 라인
    if (/^\d{4}-\d{2}-\d{2}$/.test(line)) { paymentDate = line; continue; }
    // 기간 라인 (5/11~5/17) — 무시
    if (/^\d{1,2}\/\d{1,2}~\d{1,2}\/\d{1,2}$/.test(line)) continue;
    // 금액 라인 (숫자+콤마+원)
    const am = line.match(/^([\d,]+)원$/);
    if (am) {
      const amount = parseInt(am[1].replace(/,/g, ""), 10);
      if (paymentDate && payerName && amount > 0) {
        entries.push({ paymentDate, payerName, totalAmount: amount, brand: "M" });
      }
      paymentDate = null; payerName = null;
      continue;
    }
    // 이름 라인
    if (!payerName) payerName = line;
  }
  return { entries, meta };
}

// ============================================================
// 딜버 파서
// 형식 (메시지 1건 = 입금 1건):
//   ★ 입금내역 딜버 ★
//   입금자명
//   금액 (콤마 포함, 원 없음)
//   YYYY-MM-DD
//   WJ코드 (선택)
// ============================================================
function parseDilver(text) {
  const lines = String(text || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const entries = [];
  const meta = { brand: "D", hasHeader: false };

  const headerIdx = lines.findIndex(l => /★.*딜버.*입금|★.*입금.*딜버/.test(l));
  if (headerIdx === -1) return { entries, meta };
  meta.hasHeader = true;

  let payerName = null, amount = null, paymentDate = null, caseRef = null;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\d{4}-\d{2}-\d{2}$/.test(line)) { paymentDate = line; continue; }
    const am = line.match(/^([\d,]+)$/);
    if (am) { amount = parseInt(am[1].replace(/,/g, ""), 10); continue; }
    if (/^[A-Z]{2}\d{4,}$/.test(line)) { caseRef = line; continue; }
    if (!payerName) payerName = line;
  }
  if (payerName && amount > 0 && paymentDate) {
    entries.push({
      paymentDate, payerName, totalAmount: amount, brand: "D",
      note: caseRef ? `케이스 ${caseRef}` : null,
    });
  }
  return { entries, meta };
}

module.exports = { parse, parseMoaline, parseDilver };
