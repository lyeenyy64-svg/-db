// 전자소송 일괄 + 재산명시 일괄 → src/legalData.js 변환 스크립트
// 실행: node db/generateLegalData.cjs

const XLSX = require('xlsx');
const fs   = require('fs');
const path = require('path');

// ─── 유틸 ─────────────────────────────────────────────────

const str = (v) => v !== undefined && v !== null ? String(v).trim() : '';

const excelDateToStr = (v) => {
  if (v === undefined || v === null || v === '') return '';
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

// 날짜 정규화: 공백 제거 + 통일된 YYYY.MM.DD 포맷
const normDate = (v) => {
  const s = excelDateToStr(v);
  return s.replace(/\.\s+/g, '.').replace(/\s+/g, '');
};

const toNum = (v) => (typeof v === 'number' ? v : (parseFloat(String(v).replace(/,/g, '')) || 0));

// 사건번호 패턴으로 절차 유형 분류
const classifyByCaseNumber = (cn) => {
  if (!cn) return null;
  if (/차전|차합|차소/.test(cn))        return '지급명령';
  if (/타채|타기/.test(cn))              return '압류';
  if (/카명/.test(cn))                   return '재산명시';
  if (/가단|가합|가소/.test(cn))         return '민사소송';
  return null;
};

// 사건분류 텍스트로 폴백 분류
const classifyBySasunBunryu = (v) => {
  const s = str(v);
  if (s.includes('압류'))     return '압류';
  if (s.includes('재산명시')) return '재산명시';
  if (s.includes('민사소송')) return '민사소송';
  return null;
};

// ─── 전자소송 파일 파싱 ───────────────────────────────────
// 공통 컬럼 구조 (0-indexed):
//  0: 사건분류  1: 번호  2: 법원  3: 사건번호  4: 사건지위
//  5: 접수일자  6: 원고  7: 피고  8: 기일시간  9: 기일장소  10: 진행상황

function parseElecLitig(filename, brand) {
  const fullPath = path.join(__dirname, filename);
  if (!fs.existsSync(fullPath)) {
    console.warn(`⚠ 파일 없음: ${filename}`);
    return [];
  }
  const wb = XLSX.readFile(fullPath);
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  // 데이터 시작 행 탐지: 사건번호 패턴이 있는 첫 번째 행
  let startRow = 1;
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const r = rows[i];
    if (r && /\d{4}[가-힣]+\d+/.test(str(r[3]))) { startRow = i; break; }
    if (str(r[0]).includes('사건분류') || str(r[3]).includes('사건번호')) startRow = i + 1;
  }

  const cases = [];
  let idNum = 1;

  for (let i = startRow; i < rows.length; i++) {
    const r = rows[i];
    const caseNumber = str(r[3]);
    if (!caseNumber || !/\d{4}/.test(caseNumber)) continue;

    const type = classifyByCaseNumber(caseNumber) || classifyBySasunBunryu(r[0]) || '기타';

    cases.push({
      id: `${brand}_${String(idNum++).padStart(4, '0')}`,
      type,
      brand,
      court:          str(r[2]),
      caseNumber,
      caseStatus:     str(r[4]),   // 원고/피고/채권자
      filingDate:     excelDateToStr(r[5]),
      plaintiff:      str(r[6]),
      defendant:      str(r[7]),   // = 채무자명 (매칭용)
      hearingTime:    str(r[8]),
      hearingLocation:str(r[9]),
      progressStatus: str(r[10]),
      debtorId:       null,
    });
  }

  return cases;
}

// ─── 제3채무자 파일 파싱 ────────────────────────────────────
// 바로고딜버: 사건번호=col3, seqNo=col5, 제3채무자=col6, 회신일시=col7, 청구금액=col8, 잔액=col9, 회수액=col10, 비고=col11, 완료=col12
// 모아라인  : 사건번호=col4, seqNo=col6, 제3채무자=col7, 회신일시=col8, 청구금액=col9, 잔액=col10, 회수액=col11, 비고=col12, 완료=col13
// cnCol = 사건번호 컬럼 인덱스 (offset 기준)

function parseThirdParties(filename, cnCol) {
  const fullPath = path.join(__dirname, filename);
  if (!fs.existsSync(fullPath)) {
    console.warn(`⚠ 파일 없음: ${filename}`);
    return {};
  }
  const wb = XLSX.readFile(fullPath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const result = {}; // caseNumber → [thirdParty, ...]
  let curCaseNumber = '';
  let seqAuto = 0;

  for (let i = 2; i < rows.length; i++) {
    const r = rows[i];

    // 사건번호 carry-forward (병합셀 대응)
    const cn = str(r[cnCol]);
    if (cn && /\d{4}타채/.test(cn)) {
      curCaseNumber = cn;
      seqAuto = 0;
    }
    if (!curCaseNumber) continue;

    const bankName = str(r[cnCol + 3]);
    if (!bankName) continue; // 은행명 없으면 스킵

    seqAuto++;
    const seqRaw = r[cnCol + 2];
    const seqNo  = (typeof seqRaw === 'number' && seqRaw > 0) ? seqRaw : seqAuto;

    const tp = {
      seqNo,
      bankName,
      responseDate: normDate(r[cnCol + 4]),
      claimAmount:  toNum(r[cnCol + 5]),
      balance:      toNum(r[cnCol + 6]),
      collected:    toNum(r[cnCol + 7]),
      remarks:      str(r[cnCol + 8]),
      completed:    str(r[cnCol + 9]) !== '',
    };

    if (!result[curCaseNumber]) result[curCaseNumber] = [];
    result[curCaseNumber].push(tp);
  }

  return result;
}

// ─── 재산명시 파일 파싱 ───────────────────────────────────
// 컬럼 구조 (0-indexed, 헤더 2행 이후 데이터):
//  0: (marker)  1: 번호  2: 대상자  3: 연령  4: 법원  5: 채무액
//  6: 사건번호  7: 신청일  8: 결정일  9: 결과  10: 취하/각하
//  11: 사유  12: 감치결정  13: 재산목록  14: 재산목록설명
//  15: 집행장만료/취하  16: 결과2  17: 신청일2  18: 조회명령  19: 회신여부

function parseAssetDisclosure() {
  const fullPath = path.join(__dirname, '재산명시 일괄.xlsx');
  if (!fs.existsSync(fullPath)) {
    console.warn('⚠ 파일 없음: 재산명시 일괄.xlsx');
    return [];
  }
  const wb = XLSX.readFile(fullPath);
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  // 데이터 시작 행 탐지: 카명 패턴이 있는 첫 번째 행
  let startRow = 2;
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const r = rows[i];
    if (r && /\d{4}카명\d+/.test(str(r[6]))) { startRow = i; break; }
    if (str(r[2]) === '대상자' || str(r[6]) === '사건번호') startRow = i + 1;
  }

  const cases = [];
  let idNum = 1;

  for (let i = startRow; i < rows.length; i++) {
    const r = rows[i];
    const debtorName = str(r[2]);
    if (!debtorName) continue;
    const caseNumber = str(r[6]);
    if (!caseNumber) continue;

    const inquiryOrderDate = excelDateToStr(r[18]);

    cases.push({
      id:                    `AD_${String(idNum++).padStart(4, '0')}`,
      type:                  '재산명시',
      brand:                 null,     // 런타임에 채무자 매칭으로 확정
      debtorName,
      court:                 str(r[4]),
      caseNumber,
      applicationDate:       excelDateToStr(r[7]),
      decisionDate:          excelDateToStr(r[8]),
      result:                excelDateToStr(r[9]),
      status:                str(r[10]),        // 취하/각하
      withdrawReason:        str(r[11]),
      detentionDecision:     excelDateToStr(r[12]),
      propertyList:          excelDateToStr(r[13]),
      propertyListDesc:      str(r[14]),
      executionExpiration:   excelDateToStr(r[15]),
      inquiryResult:         excelDateToStr(r[16]),
      inquiryApplicationDate:excelDateToStr(r[17]),
      inquiryOrderDate,
      hasInquiryOrder:       !!inquiryOrderDate,
      inquiryResponse:       str(r[19]),
      debtorId:              null,
    });
  }

  return cases;
}

// ─── 실행 ─────────────────────────────────────────────────

const barogoAll = parseElecLitig('바로고 전자소송 일괄.xlsx',        'B');
const badaAll   = parseElecLitig('바다코리아 전자소송 일괄.xlsx',    'M');
const dwAll     = parseElecLitig('더원인터내셔널 전자소송 일괄.xlsx','D');
const allElec   = [...barogoAll, ...badaAll, ...dwAll];

// 지급명령 + 압류 → 법적절차 탭
const legalCases = allElec.filter(c => ['지급명령', '압류'].includes(c.type));

// 제3채무자 파싱 (브랜드별 파일로 분리 보관 — 법원 사건번호는 브랜드 간 중복될 수 있어
// 사건번호만으로 두 브랜드 맵을 합치면 다른 브랜드의 제3채무자 데이터가 잘못 붙을 수 있다)
const barogoThirds = parseThirdParties('바로고딜버 제3채무자.xlsx', 3);   // 바로고 brand B
const moaThirds    = parseThirdParties('모아라인 제3채무자.xlsx',   4);   // 모아라인 brand M
const thirdsByBrand = { B: barogoThirds, M: moaThirds };

// 압류 케이스에 thirdParties 배열 주입 (같은 브랜드의 제3채무자 맵에서만 조회)
legalCases.forEach(c => {
  const thirds = thirdsByBrand[c.brand];
  c.thirdParties = (c.type === '압류' && thirds && thirds[c.caseNumber]) || [];
});

// 민사소송 → 민사소송 메뉴
const minsaCases = allElec.filter(c => c.type === '민사소송');

// 재산명시: 일괄 파일 파싱 후 전자소송에서 누락분 보충
const adCases      = parseAssetDisclosure();
const adCaseNumSet = new Set(adCases.map(c => c.caseNumber));

// 전자소송에서 재산명시 항목 추출하여 브랜드 정보 확보
// 사건번호만으로는 다른 법원의 다른 브랜드 사건과 우연히 같은 문자열이 나올 수 있으므로
// court+caseNumber 조합으로 키를 잡아 오귀속을 방지한다.
const kaMyungFromElec = allElec.filter(c => c.type === '재산명시');
const brandByCaseNum  = {};
kaMyungFromElec.forEach(c => { brandByCaseNum[`${c.court}|${c.caseNumber}`] = c.brand; });

// 재산명시 일괄에 없는 항목 보충
const extraAD = kaMyungFromElec
  .filter(c => !adCaseNumSet.has(c.caseNumber))
  .map(c => ({
    id:                    `AD_EX_${c.id}`,
    type:                  '재산명시',
    brand:                 c.brand,
    debtorName:            c.defendant,
    court:                 c.court,
    caseNumber:            c.caseNumber,
    applicationDate:       c.filingDate,
    decisionDate:          '',
    result:                '',
    status:                c.progressStatus,
    withdrawReason:        '',
    detentionDecision:     '',
    propertyList:          '',
    propertyListDesc:      '',
    executionExpiration:   '',
    inquiryResult:         '',
    inquiryApplicationDate:'',
    inquiryOrderDate:      '',
    hasInquiryOrder:       false,
    inquiryResponse:       '',
    debtorId:              null,
  }));

// 재산명시 일괄 항목에 브랜드 주입
const assetDisclosures = [
  ...adCases.map(c => ({ ...c, brand: brandByCaseNum[`${c.court}|${c.caseNumber}`] || null })),
  ...extraAD,
];

// ─── 파일 출력 ────────────────────────────────────────────

const outPath = path.join(__dirname, '../src/legalData.js');
fs.writeFileSync(
  outPath,
  `// Auto-generated — do not edit manually\n// Run: node db/generateLegalData.cjs to regenerate\n\n` +
  `export const LEGAL_CASES = ${JSON.stringify(legalCases, null, 2)};\n\n` +
  `export const MINSA_CASES = ${JSON.stringify(minsaCases, null, 2)};\n\n` +
  `export const ASSET_DISCLOSURE_CASES = ${JSON.stringify(assetDisclosures, null, 2)};\n`,
  'utf8'
);

const byType = (arr, t) => arr.filter(c => c.type === t).length;
const seizuresWithThirds = legalCases.filter(c => c.type === '압류' && c.thirdParties.length > 0);
const totalThirds = legalCases.reduce((s, c) => s + (c.thirdParties?.length || 0), 0);
console.log('✓ src/legalData.js 생성 완료');
console.log(`  지급명령  : ${byType(legalCases, '지급명령')}건`);
console.log(`  압류      : ${byType(legalCases, '압류')}건 (제3채무자 연결 ${seizuresWithThirds.length}건 / 은행 ${totalThirds}건)`);
console.log(`  민사소송  : ${minsaCases.length}건`);
console.log(`  재산명시  : ${assetDisclosures.length}건 (조회명령 ${assetDisclosures.filter(c => c.hasInquiryOrder).length}건)`);
console.log(`  기타/미분류: ${allElec.filter(c => c.type === '기타').length}건`);
