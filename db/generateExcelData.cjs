// 채무자 관리 데이터.xlsx → src/excelData.js 변환 스크립트
// 실행: node db/generateExcelData.cjs

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const wb = XLSX.readFile(path.join(__dirname, '채무자 관리 데이터.xlsx'));
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

// rows[0] = 그룹헤더, rows[1] = 컬럼헤더, rows[2+] = 데이터
// col index: 1=brand 2=분류 3=담당 4=이름 5=보증인 6=연락처 7=코드 8=허브 9=원인 10=상태
//            11=신용조회 12=집행권원 13=주민초본 14=영업담당 15=대여일 16=주요사항
//            17=원금(재무) 18=조정액 19=회수액 20=최종잔액(재무) 21=최종잔액(법무)
//            22-33=1~12월(무시) 34+=날짜별 히스토리

// 금액 셀이 "1,500,000"처럼 콤마 포함 텍스트로 저장된 경우 parseFloat만 쓰면 1만 파싱되어
// 잔액이 사실상 0으로 붕괴한다. 콤마를 제거한 뒤 파싱한다 (다른 generate*.cjs 스크립트와 동일).
const toNum = (v) => (typeof v === 'number' ? v : (parseFloat(String(v || '').replace(/,/g, '')) || 0));

const normCat = (cat) => {
  if (cat === '회생/파산') return '회생파산';
  if (cat === '협의/소송') return '협의소송';
  return cat;
};

const normStatus = (s) => {
  if (!s || s === '') return '추심진행';
  return s;
};

const excelDateToStr = (v) => {
  if (typeof v === 'number' && v > 40000) {
    const d = XLSX.SSF.parse_date_code(v);
    return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
  }
  return v ? String(v).trim() : '';
};

const excelDateToDisplay = (v) => {
  if (typeof v === 'number' && v > 40000) {
    const d = XLSX.SSF.parse_date_code(v);
    return `${d.y}.${String(d.m).padStart(2,'0')}.${String(d.d).padStart(2,'0')}`;
  }
  const s = String(v || '').trim();
  if (/^\d{4}[\.\-\/]\d{1,2}/.test(s)) return s.replace(/-/g, '.').replace(/\//g, '.');
  return s;
};

// 이름 정제
const cleanName = (raw) => String(raw || '').trim().split(/[\r\n]+/)[0].trim();
const extractNameNote = (raw) => {
  const s = String(raw || '').trim();
  const parts = s.split(/[\r\n]+/);
  return parts.length > 1 ? parts.slice(1).join(' ').trim() : '';
};

// 날짜 컬럼 인덱스 맵 구축 (rows[1], col 34+)
const headerRow = rows[1];
const dateColMap = [];
for (let i = 34; i < headerRow.length; i++) {
  const v = headerRow[i];
  if (typeof v === 'number' && v > 40000 && v < 100000) {
    dateColMap.push({ colIdx: i, date: excelDateToDisplay(v) });
  }
}

// 특정 행의 히스토리 파싱
function parseHistory(row) {
  const entries = [];
  for (const { colIdx, date } of dateColMap) {
    const val = row[colIdx];
    if (val !== undefined && val !== null) {
      const s = String(val).trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      if (s) entries.push({ date, content: s });
    }
  }
  return entries.sort((a, b) => b.date.localeCompare(a.date));
}

// (brand, name) 기준으로 그룹핑
const groupMap = new Map();

for (let i = 2; i < rows.length; i++) {
  const r = rows[i];
  const rawName = String(r[4] || '').trim();
  if (!rawName) continue;
  const name = cleanName(rawName);
  const nameNote = extractNameNote(rawName);
  if (!name) continue;

  const brand = String(r[1] || '').trim();
  if (!brand || ['계', 'LAST', 'G'].includes(brand)) continue;

  const key = `${brand}||${name}`;

  const code     = String(r[7] || '').trim();
  const hubName  = String(r[8] || '').trim();
  const principal  = toNum(r[17]);
  const adjustment = toNum(r[18]);
  const collected  = toNum(r[19]);
  const loanDate   = excelDateToStr(r[15]);
  const rowHistory = parseHistory(r);

  if (!groupMap.has(key)) {
    const rawPhone = String(r[6] || '').trim().replace(/\r\n/g, ' / ').replace(/\n/g, ' / ');
    const rawGuar = String(r[5] || '').trim();
    const guarantors = rawGuar ? rawGuar.split(/[,、]+/).map(s => s.trim()).filter(Boolean) : [];

    groupMap.set(key, {
      brand,
      category: normCat(String(r[2] || '').trim()),
      assignee: String(r[3] || '').trim(),
      name,
      guarantors,
      phone: rawPhone,
      debtCause: String(r[9] || '').trim(),
      collectionStatus: normStatus(String(r[10] || '').trim()),
      creditCheck: String(r[11] || '').trim(),
      execTitle: String(r[12] || '').trim() === 'O',
      execTitleType: '',
      execTitleUrl: '',
      residentCopy: String(r[13] || '').trim(),
      salesRep: String(r[14] || '').trim(),
      keyNotes: [nameNote, String(r[16] || '').trim()].filter(Boolean).join('\n').replace(/\r\n/g, '\n'),
      subrogationMonth: '',
      subrogationDocUrl: '',
      creditReportUrl: '',
      subRows: [],
      loanDate,
      // 날짜만으로 중복 제거하면 같은 날짜에 다른 허브 서브로우의 서로 다른 히스토리가
      // 하나로 뭉개진다. 날짜+내용 조합으로 키를 잡아야 서로 다른 기록이 보존된다.
      historyDates: new Set(rowHistory.map(h => `${h.date} ${h.content}`)),
      history: [...rowHistory],
    });
  } else {
    const g = groupMap.get(key);
    if (!g.loanDate && loanDate) g.loanDate = loanDate;
    // 히스토리 머지 (날짜+내용 조합 기준 중복 제거)
    for (const h of rowHistory) {
      const hKey = `${h.date} ${h.content}`;
      if (!g.historyDates.has(hKey)) {
        g.history.push(h);
        g.historyDates.add(hKey);
      }
    }
  }

  groupMap.get(key).subRows.push({ code, hubName, principal, adjustment, collected, loanDate });
}

// 최종 debtor 배열 생성
const debtors = [];
let idx = 1;

for (const [, g] of groupMap) {
  const totalPrincipal  = g.subRows.reduce((s, r) => s + r.principal, 0);
  const totalCollected  = g.subRows.reduce((s, r) => s + r.collected, 0);
  const totalAdjustment = g.subRows.reduce((s, r) => s + r.adjustment, 0);
  const finalFinance    = totalPrincipal - totalCollected;
  const finalLegal      = finalFinance + totalAdjustment;

  // 히스토리 최신순 정렬
  const history = g.history.sort((a, b) => b.date.localeCompare(a.date));

  debtors.push({
    id: `NPL${String(idx++).padStart(4, '0')}`,
    brand: g.brand,
    category: g.category,
    assignee: g.assignee,
    name: g.name,
    guarantors: g.guarantors,
    phone: g.phone,
    phoneHistory: [],
    hubCode: g.subRows[0].code,
    hubName: g.subRows[0].hubName,
    debtCause: g.debtCause,
    collectionStatus: g.collectionStatus,
    creditCheck: g.creditCheck,
    execTitle: g.execTitle,
    execTitleType: g.execTitleType,
    execTitleUrl: g.execTitleUrl,
    residentCopy: g.residentCopy,
    salesRep: g.salesRep,
    loanDate: g.loanDate,
    keyNotes: g.keyNotes,
    subrogationMonth: g.subrogationMonth,
    subrogationDocUrl: g.subrogationDocUrl,
    creditReportUrl: g.creditReportUrl,
    creditGrade: null,
    principalBalance: totalPrincipal,
    adjustment: totalAdjustment,
    collectedAmount: totalCollected,
    finalBalanceFinance: finalFinance,
    finalBalanceLegal: finalLegal,
    subRows: g.subRows.length > 1 ? g.subRows : null,
    monthlyCollected: {},
    history,
  });
}

const outPath = path.join(__dirname, '../src/excelData.js');
fs.writeFileSync(outPath,
  `// Auto-generated from 채무자 관리 데이터.xlsx — do not edit manually\n` +
  `// Run: node db/generateExcelData.cjs to regenerate\n\n` +
  `export const EXCEL_DEBTORS = ${JSON.stringify(debtors, null, 2)};\n`,
  'utf8'
);

console.log(`✓ excelData.js 생성: ${debtors.length}명`);
console.log(`  브랜드: ${[...new Set(debtors.map(d => d.brand))].join(', ')}`);
console.log(`  총 원금: ${debtors.reduce((s,d)=>s+d.principalBalance,0).toLocaleString()}원`);
console.log(`  총 회수: ${debtors.reduce((s,d)=>s+d.collectedAmount,0).toLocaleString()}원`);
console.log(`  다중 허브: ${debtors.filter(d => d.subRows).length}명`);
console.log(`  히스토리 있는 채무자: ${debtors.filter(d => d.history.length > 0).length}명`);
console.log(`  히스토리 총 건수: ${debtors.reduce((s,d)=>s+d.history.length,0)}건`);
