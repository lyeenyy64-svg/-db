"use strict";
// ============================================================
// AI 문건생성 — HWPX 템플릿 치환 엔진
// ============================================================
const path = require("path");
const fs   = require("fs");
const JSZip = require("jszip");

const TEMPLATE_PATH = path.join(__dirname, "../db/(ai용 양식)별지 압류 및 추심할 채권의 표시.hwpx");

function fmt(n) {
  return Number(n || 0).toLocaleString("ko-KR");
}

function buildFormula(n) {
  return "(" + Array.from({ length: n }, (_, i) => i + 1).join("+") + ")";
}

// 단일 lineseg (HWP이 열 때 재계산하므로 최소값으로도 OK)
const LS = `<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="852" horzpos="0" horzsize="42520" flags="393216"/></hp:linesegarray>`;

function bankItemXml(num, name, amount, debtorName, residentId) {
  const body =
    `채무자[${debtorName}][(주민등록번호 : ${residentId})]이 제3채무자 [${name}]에 대하여 ` +
    `가지는 다음의 예금채권 중 현재 입금되어 있거나 장래 입금될 예금채권으로서 다음에서 기재한 ` +
    `순서에 따라 위 청구금액에 이를 때까지의 금액(단, 민사집행법상 246조 1항 7호,  8호 및 ` +
    `동법시행령에 의하여 압류가 금지되는 예금은 제외한다.) `;
  return (
    `<hp:p id="0" paraPrIDRef="12" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="6"><hp:t>${num}. [${name}]에 대하여</hp:t></hp:run>${LS}</hp:p>` +
    `<hp:p id="2147483648" paraPrIDRef="14" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="6"><hp:t>   [금 ${fmt(amount)}원]</hp:t></hp:run>${LS}</hp:p>` +
    `<hp:p id="2147483648" paraPrIDRef="14" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>${body}</hp:t></hp:run>${LS}</hp:p>` +
    `<hp:p id="0" paraPrIDRef="14" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"/>${LS}</hp:p>`
  );
}

function platformItemXml(num, name, amount, debtorName, residentId) {
  const body =
    `채무자[${debtorName}][(주민등록번호 : ${residentId})]이  제3채무자 [${name}]의 ` +
    `배달대행 프로그램상 가지는 배달수수료 및 이에 따른 수당채권 일체중 제3채무자가 채무자에게 ` +
    `현재 지급해야 할 금액 및 장래에 지급해야 금액 중 위 청구금액에 이를 때까지의 금액`;
  return (
    `<hp:p id="0" paraPrIDRef="14" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="6"><hp:t>${num}. [${name}]에 대하여</hp:t></hp:run>${LS}</hp:p>` +
    `<hp:p id="2147483648" paraPrIDRef="14" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="6"><hp:t>  [ 금 ${fmt(amount)}원]</hp:t></hp:run>${LS}</hp:p>` +
    `<hp:p id="2147483648" paraPrIDRef="14" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>${body}</hp:t></hp:run>${LS}</hp:p>` +
    `<hp:p id="2147483648" paraPrIDRef="14" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="6"/>${LS}</hp:p>`
  );
}

// XML 내에서 특정 텍스트를 포함하는 <hp:p 의 시작 위치를 반환
function findParaStart(xml, text) {
  const pos = xml.indexOf(text);
  if (pos === -1) throw new Error(`HWPX 마커를 찾을 수 없음: "${text}"`);
  return xml.lastIndexOf("<hp:p ", pos);
}

// ─── HWPX 생성 ───────────────────────────────────────────────
async function generateHwpx(docData) {
  const {
    debtorName,
    residentId,
    totalAmount,
    executionTitleText, // 집행권원 전체 텍스트 (프론트에서 생성)
    bankItems,          // [{name, amount}]
    platformItems,      // [{name, amount}]
  } = docData;

  const allItemCount = (bankItems || []).length + (platformItems || []).length;

  const templateBytes = fs.readFileSync(TEMPLATE_PATH);
  const zip = await JSZip.loadAsync(templateBytes);

  let xml = await zip.file("Contents/section0.xml").async("string");

  // ── 1. 고정 필드 전체 치환 ─────────────────────────────────
  xml = xml
    .replace(/\[ 홍길동  \]/g,       `[ ${debtorName} ]`)
    .replace(/\[ 123,345,678 \]/g,   `[ ${fmt(totalAmount)} ]`)
    .replace(/\(1\+2\+3\+4\+5\+6\+7\+8\+9\+10\)/g, buildFormula(allItemCount))
    .replace(/홍길동/g, debtorName)
    .replace(/000000-0000000/g, residentId);

  // 집행권원 텍스트 치환 (프론트에서 생성된 전체 문자열)
  if (executionTitleText) {
    xml = xml.replace(
      /<hp:t>\* 청구금액 산정내역 : .*?<\/hp:t>/,
      `<hp:t>* 청구금액 산정내역 : ${executionTitleText}</hp:t>`
    );
  }

  // ── 2. 동적 항목 섹션 경계 탐색 ───────────────────────────
  // 은행 항목 시작: 원본 1번 항목 제목 단락
  const bankStart  = findParaStart(xml, "[주식회사 우리은행]에 대하여</hp:t>");
  // "다 음" 표 시작
  const tableStart = findParaStart(xml, "- 다  음 -</hp:t>");
  // 8번 항목(플라이앤컴퍼니) 시작
  const item8Start = findParaStart(xml, "[유한책임회사 플라이앤컴퍼니]에 대하여</hp:t>");
  // 말미 빈 단락 (</hs:sec> 직전 마지막 <hp:p>)
  const secEndPos    = xml.lastIndexOf("</hs:sec>");
  const platformEnd  = xml.lastIndexOf("<hp:p ", secEndPos);

  // ── 3. 구간 추출 ──────────────────────────────────────────
  const header       = xml.substring(0, bankStart);
  // 은행 항목이 0건이면 "다 음" 예금압류 순서 표도 미리보기(buildPreviewHtml)와 동일하게 생략한다.
  const tableSection = (bankItems || []).length > 0 ? xml.substring(tableStart, item8Start) : "";
  const footer       = xml.substring(platformEnd);

  // ── 4. 새 항목 XML 생성 ───────────────────────────────────
  let newBankXml = "";
  (bankItems || []).forEach((item, i) => {
    newBankXml += bankItemXml(i + 1, item.name, item.amount, debtorName, residentId);
  });

  let newPlatformXml = "";
  (platformItems || []).forEach((item, i) => {
    newPlatformXml += platformItemXml(
      (bankItems || []).length + i + 1,
      item.name, item.amount, debtorName, residentId
    );
  });

  // ── 5. 조립 ───────────────────────────────────────────────
  const newXml = header + newBankXml + tableSection + newPlatformXml + footer;
  zip.file("Contents/section0.xml", newXml);

  // mimetype은 반드시 STORE (비압축)
  const mimetypeContent = await zip.file("mimetype").async("string");
  zip.file("mimetype", mimetypeContent, { compression: "STORE" });

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

// ─── HTML 미리보기 생성 ──────────────────────────────────────
function buildPreviewHtml(docData) {
  const {
    debtorName, residentId, totalAmount,
    executionTitleText = "",
    bankItems = [], platformItems = [],
  } = docData;

  const allItems = [...bankItems, ...platformItems];
  const formula  = buildFormula(allItems.length);

  const bankBody  = (name) =>
    `채무자[${debtorName}][(주민등록번호 : ${residentId})]이 제3채무자 [${name}]에 대하여 가지는 다음의 예금채권 중 현재 입금되어 있거나 장래 입금될 예금채권으로서 다음에서 기재한 순서에 따라 위 청구금액에 이를 때까지의 금액(단, 민사집행법상 246조 1항 7호, 8호 및 동법시행령에 의하여 압류가 금지되는 예금은 제외한다.)`;
  const platBody  = (name) =>
    `채무자[${debtorName}][(주민등록번호 : ${residentId})]이 제3채무자 [${name}]의 배달대행 프로그램상 가지는 배달수수료 및 이에 따른 수당채권 일체중 제3채무자가 채무자에게 현재 지급해야 할 금액 및 장래에 지급해야 금액 중 위 청구금액에 이를 때까지의 금액`;

  const bankRows = bankItems.map((item, i) => `
    <div class="item-title"><strong>${i + 1}. [${item.name}]에 대하여</strong></div>
    <div class="item-amount">&nbsp;&nbsp;&nbsp;[금 ${fmt(item.amount)}원]</div>
    <p>${bankBody(item.name)}</p>
  `).join("");

  const platRows = platformItems.map((item, i) => `
    <div class="item-title"><strong>${bankItems.length + i + 1}. [${item.name}]에 대하여</strong></div>
    <div class="item-amount">&nbsp;&nbsp;[ 금 ${fmt(item.amount)}원]</div>
    <p>${platBody(item.name)}</p>
  `).join("");

  return `
<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8"/>
<style>
  body { font-family: "맑은 고딕", "Malgun Gothic", sans-serif; font-size: 10pt; line-height: 1.6;
         margin: 0; padding: 0; background: #fff; color: #000; }
  .page { width: 210mm; margin: 0 auto; padding: 20mm 22mm; box-sizing: border-box; }
  h2 { text-align: center; font-size: 14pt; margin: 16px 0 20px; }
  .label { font-size: 11pt; font-weight: bold; margin: 8px 0 4px; }
  .claim { font-size: 12pt; font-weight: bold; }
  .notary { font-size: 9.5pt; margin: 10px 0; }
  .item-title { font-weight: bold; margin-top: 14px; }
  .item-amount { margin: 2px 0 4px; font-weight: bold; }
  p { margin: 4px 0 8px; font-size: 9.5pt; }
  .daeum-box { border: 1px solid #000; padding: 10px 14px; margin: 14px 0; font-size: 9.5pt; }
  .daeum-title { text-align: center; font-weight: bold; margin-bottom: 8px; }
  .note { font-size: 9pt; color: #555; margin-top: 20px; }
  @media print {
    body { margin: 0; } .page { margin: 0; padding: 15mm 18mm; }
  }
</style>
</head>
<body>
<div class="page">
  <p>[별지]</p>
  <h2>압류 및 추심할 채권의 표시</h2>
  <div class="label">채무자 : [ ${debtorName} ]</div>
  <div class="claim">청구금액 : [ ${fmt(totalAmount)} ]원</div>
  <div>${formula}</div>
  <div class="notary">
    * 청구금액 산정내역 : ${executionTitleText}
  </div>
  ${bankRows}
  ${bankItems.length > 0 ? `
  <div class="daeum-box">
    <div class="daeum-title">- 다 음 -</div>
    <div>1. 압류·가압류되지 않은 예금과 압류·가압류된 예금이 있는 때에는 다음 순서에 따라서 압류한다.<br>
      &nbsp;&nbsp;&nbsp;① 선행 압류·가압류가 되지 않은 예금&nbsp;&nbsp;② 선행 압류·가압류가 된 예금</div>
    <div>2. 여러 종류의 예금이 있는 때에는 다음 순서에 의하여 압류한다.<br>
      &nbsp;&nbsp;&nbsp;① 보통예금 ② 당좌예금 ③ 정기예금 ④ 정기적금 ⑤ 별단예금<br>
      &nbsp;&nbsp;&nbsp;⑥ 저축예금 ⑦ MMF ⑧ MMDA ⑨ 적립식펀드예금 ⑩ 신탁예금 ⑪ 채권형 예금 ⑫청약예금</div>
    <div>3. 같은 종류의 예금이 여러 계좌에 있는 때에는 계좌번호가 빠른 예금부터 압류한다.</div>
    <div><strong>4. 다만, 채무자의 1개월간 생계유지에 필요한 예금으로 민사집행법 시행령이 정한 금액에 해당하는 경우에는 이를 제외한 나머지 금액. 끝.</strong></div>
  </div>` : ""}
  ${platRows}
</div>
</body>
</html>`;
}

module.exports = { generateHwpx, buildPreviewHtml };
