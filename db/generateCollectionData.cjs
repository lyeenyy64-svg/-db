// 추심의뢰 리스트 일괄.xlsx → src/collectionData.js 변환 스크립트
// 실행: node db/generateCollectionData.cjs

const XLSX = require('xlsx');
const fs   = require('fs');
const path = require('path');

const str   = (v) => v !== undefined && v !== null ? String(v).trim() : '';
const toNum = (v) => typeof v === 'number' ? v : (parseFloat(String(v).replace(/,/g, '')) || 0);

const excelDateToStr = (v) => {
  if (!v && v !== 0) return '';
  if (typeof v === 'number' && v > 40000 && v < 100000) {
    try {
      const d = XLSX.SSF.parse_date_code(v);
      return `${d.y}.${String(d.m).padStart(2,'0')}.${String(d.d).padStart(2,'0')}`;
    } catch { return ''; }
  }
  const s = String(v).trim();
  if (/^\d{4}[\.\-\/]\d{1,2}/.test(s)) return s.replace(/-/g, '.').replace(/\//g, '.');
  return s;
};

// 브랜드 법인명 → 브랜드 코드 매핑
const BRAND_MAP = {
  '바로고':     'B',
  '딜버':       'D',
  '모아라인':   'M',
  '바다코리아': 'M',  // 법인명 = 모아라인 브랜드
  '그라이더':   'G',
  '에이퍼스':   'E',  // 별도 자회사
  'A2':         'A2', // 별도 자회사
};

const fullPath = path.join(__dirname, '추심의뢰 리스트.xlsx');
if (!fs.existsSync(fullPath)) {
  console.error('❌ 파일 없음: 추심의뢰 리스트 일괄.xlsx');
  process.exit(1);
}

const wb   = XLSX.readFile(fullPath);
const ws   = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

const header = rows[0];

// 활동사항(col13) 이후 ~ 회수현황 전까지를 월별 현황 컬럼으로 동적 탐지
const monthCols = [];
for (let i = 14; i < header.length; i++) {
  const h  = header[i];
  const hs = str(h);
  if (hs === '회수현황') break;
  let monthKey = '';
  if (typeof h === 'number' && h > 2000 && h < 2100) {
    monthKey = String(h);                                        // e.g. 2026.03
  } else if (/^\d{4}\.\d{2}/.test(hs)) {
    monthKey = hs.replace(/\s*추심현황\s*/g, '').trim();         // e.g. "2025.10"
  }
  if (monthKey) monthCols.push({ col: i, month: monthKey });
}
const recoveredCol = header.findIndex((h, i) => str(h) === '회수현황' && i > 13);

const orders = [];
let idNum = 1;

for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  const debtorName = str(r[3]);
  if (!debtorName) continue;

  const brandRaw = str(r[2]);
  const brand    = BRAND_MAP[brandRaw] || null;

  // 월별 추심현황
  const monthlyUpdates = monthCols
    .map(mc => ({
      month:   mc.month,
      content: str(r[mc.col]).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim(),
    }))
    .filter(mu => mu.content);

  // 담당자 병합 (col8 직함, col9 이름, col10 전화, col11 팩스)
  const agencyPerson = [str(r[8]), str(r[9])]
    .map(s => s.replace(/\r\n/g, ' ').replace(/\s+/g, ' '))
    .filter(Boolean).join(' / ');
  const agencyPhone = [str(r[10]), str(r[11])].filter(Boolean).join(' / ');

  orders.push({
    id:             `CO_${String(idNum++).padStart(4, '0')}`,
    no:             toNum(r[0]) || idNum - 1,
    agencyName:     str(r[1]),
    brand,
    brandRaw,
    debtorName,
    requestAmount:  toNum(r[4]),
    amountDetail:   str(r[5]).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim(),
    requestDate:    excelDateToStr(r[6]),
    condition:      str(r[7]).replace(/\r\n/g, ' ').replace(/\s+/g, ' ').trim(),
    agencyPerson,
    agencyPhone,
    cost:           str(r[12]).replace(/\r\n/g, '\n').trim(),
    activities:     str(r[13]).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim(),
    monthlyUpdates,
    recoveredAmount: recoveredCol >= 0 ? toNum(r[recoveredCol]) : 0,
    debtorId:       null,
  });
}

const outPath = path.join(__dirname, '../src/collectionData.js');
fs.writeFileSync(
  outPath,
  `// Auto-generated — do not edit manually\n// Run: node db/generateCollectionData.cjs to regenerate\n\n` +
  `export const COLLECTION_ORDERS = ${JSON.stringify(orders, null, 2)};\n`,
  'utf8'
);

const agencies = [...new Set(orders.map(o => o.agencyName))];
console.log('✓ src/collectionData.js 생성 완료');
console.log(`  총 추심의뢰: ${orders.length}건`);
console.log(`  추심업체:    ${agencies.join(', ')}`);
console.log(`  월별 컬럼:   ${monthCols.map(m => m.month).join(', ')}`);
