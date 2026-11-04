// 추심의뢰 현황.xlsx(세부현황 시트) → src/collectionData.js 변환 스크립트
// 실행: node db/generateCollectionData.cjs "<추심의뢰 현황.xlsx 경로>"
//
// - 세부현황 시트의 행이 곧 추심의뢰 1건 (기준 데이터)
// - 주민번호·주소·연락처는 번들(src)에 들어가므로 읽지 않는다 (채무자 DB에 이미 있음)
// - 세부현황에 없는 값(요청일·최근현황·회수액)은 같은 파일의 총계/CMS 추심의뢰 시트에서 브랜드+채무자명으로 가져온다 (기존 앱 데이터는 사용하지 않음)

const XLSX = require('xlsx');
const fs   = require('fs');
const path = require('path');

const str   = (v) => v !== undefined && v !== null ? String(v).trim() : '';
const toNum = (v) => typeof v === 'number' ? v : (parseFloat(String(v).replace(/,/g, '')) || 0);
const oneLine = (s) => str(s).replace(/\r\n|\r|\n/g, ' ').replace(/\s+/g, ' ').trim();

// 브랜드 법인명 → 브랜드 코드 매핑
const BRAND_MAP = {
  '바로고':         'B',
  '딜버':           'D',
  '더원인터내셔널': 'D',  // 딜버 법인명
  '모아라인':       'M',
  '바다코리아':     'M',  // 법인명 = 모아라인 브랜드
  '그라이더':       'G',
  '에이퍼스':       'E',  // 별도 자회사
  'A2':             'A2', // 별도 자회사
};
// 엑셀 오타 보정
const BRAND_FIX = { '바다코링': '바다코리아' };

const xlsxPath = process.argv[2];
if (!xlsxPath || !fs.existsSync(xlsxPath)) {
  console.error('❌ 사용법: node db/generateCollectionData.cjs "<추심의뢰 현황.xlsx 경로>"');
  process.exit(1);
}

const wb = XLSX.readFile(xlsxPath);
const sheetRows = (name, skip) => {
  if (!wb.Sheets[name]) return [];
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: true }).slice(skip);
};

// 세부현황: B열부터 [0]no [1]업체내no [2]추심업체 [3]회사 [4]채무자 [5]분류 [6]주민번호 [7]주소 [8]연락처
//          [9]채권내용 [10]채권발생일 [11]집행권원 [12]채권액(잔액) [13]지연손해금 [14]수수료 [15]특이사항
// 의뢰 제외 대상: SM신용정보 우상범
const detailRows = sheetRows('세부현황', 2).filter(r => str(r[4]) && !(str(r[2]) === 'SM신용정보' && str(r[4]) === '우상범'));
if (!detailRows.length) {
  console.error('❌ 세부현황 시트에서 데이터를 찾지 못했습니다');
  process.exit(1);
}

const brandRawOf = (v) => BRAND_FIX[str(v)] || str(v);
const keyOf = (brandRaw, name) => `${brandRawOf(brandRaw)}|${str(name)}`;

// 총계: [0]no [1]업체명 [2]대상자(브랜드) [3]채무자 [4]추심요청일
const dateByKey = new Map();
sheetRows('총계', 1).forEach(r => { if (str(r[3]) && str(r[4])) dateByKey.set(keyOf(r[2], r[3]), str(r[4])); });

// CMS 추심의뢰: [0]NO [1]브랜드 [2]채무자 [3]추심업체 [4]요청일 [5]요청금액 [6]회수금액 [7]최근현황월 [8]최근현황
const cmsByKey = new Map();
sheetRows('CMS 추심의뢰', 1).forEach(r => { if (str(r[2])) cmsByKey.set(keyOf(r[1], r[2]), r); });

const outPath = path.join(__dirname, '../src/collectionData.js');

const orders = [];
let idNum = 1;

detailRows.forEach((r) => {
  const brandRaw   = brandRawOf(r[3]);
  const debtorName = str(r[4]);
  const k          = keyOf(brandRaw, debtorName);
  const amount     = toNum(r[12]);
  const cms        = cmsByKey.get(k);

  // 분류: "주채무자" / "OOO의 연대보증인" / "OOO 연대보증인"
  const roleRaw  = str(r[5]);
  const isGuar   = /연대보증|보증인/.test(roleRaw);
  const mainName = isGuar ? roleRaw.replace(/의?\s*연대\s*보증인|\s*보증인/g, '').trim() : '';

  const delayRate = typeof r[13] === 'number' ? `연 ${Math.round(r[13] * 100)}%` : str(r[13]);
  const feeRate   = typeof r[14] === 'number' ? `${Math.round(r[14] * 100)}%`   : str(r[14]);

  // 월별 현황: 기존 이력 + CMS 시트의 최근현황이 새 월이면 추가
  const monthlyUpdates = [];
  if (cms && str(cms[7]) && str(cms[8]) && !monthlyUpdates.some(mu => mu.month === str(cms[7]))) {
    monthlyUpdates.push({ month: str(cms[7]), content: str(cms[8]).replace(/\r\n|\r/g, '\n') });
  }

  // SM신용정보만 일괄 지정, 나머지 업체는 추후 화면에서 입력
  const requestDate = str(r[2]) === 'SM신용정보' ? '2026.11.04' : '';

  orders.push({
    id:              `CD_${String(idNum).padStart(4, '0')}`,
    no:              idNum++,
    agencyName:      str(r[2]),
    brand:           BRAND_MAP[brandRaw] || null,
    brandRaw,
    debtorName,
    debtorRole:      isGuar ? '연대보증인' : (roleRaw || '주채무자'),
    mainDebtorName:  mainName,
    claimType:       str(r[9]),
    claimDate:       str(r[10]),
    execTitle:       oneLine(r[11]),
    requestAmount:   amount,
    delayRate,
    amountDetail:    `채권액(잔액) : ${amount.toLocaleString('ko-KR')}원${delayRate ? `\n지연손해금 : ${delayRate}` : ''}`,
    requestDate,
    condition:       feeRate ? `추심금액의 ${feeRate}` : '',
    feeRate,
    note:            oneLine(r[15]),
    agencyPerson:    '',
    agencyPhone:     '',
    cost:            '',
    activities:      '',
    monthlyUpdates: monthlyUpdates.filter(mu => requestDate && mu.month >= requestDate.slice(0, 7)),  // 추심요청일 이후 월만 (요청일 없으면 없음)
    recoveredAmount: 0,  // 회수금액은 입금현황(요청일 이후 입금)으로만 집계
    debtorId:        null,
  });
});

fs.writeFileSync(
  outPath,
  `// Auto-generated — do not edit manually\n// Run: node db/generateCollectionData.cjs "<추심의뢰 현황.xlsx>" to regenerate\n// 원본: 추심의뢰 현황.xlsx 의 '세부현황' 시트 (주민번호·주소·연락처는 제외)\n\n` +
  `export const COLLECTION_ORDERS = ${JSON.stringify(orders, null, 2)};\n`,
  'utf8'
);

const agencies = [...new Set(orders.map(o => o.agencyName))];
console.log('✓ src/collectionData.js 생성 완료');
console.log(`  총 추심의뢰:   ${orders.length}건 (연대보증인 ${orders.filter(o => o.debtorRole === '연대보증인').length}건)`);
console.log(`  추심업체:      ${agencies.join(', ')}`);
console.log(`  요청일 없음:   ${orders.filter(o => !o.requestDate).length}건`);
