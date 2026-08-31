"use strict";
// ============================================================
// AI 종합현황 보고서 → MS Word(.docx) 변환
// 화면에 보이는 것과 동일한 섹션 구성(1~5)을 그대로 표/불릿으로 옮긴다.
// 별도 docx 라이브러리 없이 JSZip으로 최소한의 OOXML을 직접 작성한다
// (backend/documentGenerator.cjs의 HWPX 생성과 같은 방식).
// ============================================================
const JSZip = require("jszip");

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function fmtWon(n) { return `${Number(n || 0).toLocaleString("ko-KR")}원`; }

function run(text, { bold } = {}) {
  const rPr = bold ? "<w:rPr><w:b/></w:rPr>" : "";
  return `<w:r>${rPr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}
function paragraph(text, { bold, size, spacingBefore = 0, spacingAfter = 120 } = {}) {
  const rPr = [bold && "<w:b/>", size && `<w:sz w:val="${size}"/>`].filter(Boolean).join("");
  const pPr = `<w:pPr><w:spacing w:before="${spacingBefore}" w:after="${spacingAfter}"/></w:pPr>`;
  const r = `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
  return `<w:p>${pPr}${r}</w:p>`;
}
function bulletParagraph(text) {
  return `<w:p><w:pPr><w:spacing w:after="80"/></w:pPr>${run("• " + text)}</w:p>`;
}

const BORDER = `<w:tcBorders>${["top", "left", "bottom", "right"].map(s => `<w:${s} w:val="single" w:sz="4" w:color="CCCCCC"/>`).join("")}</w:tcBorders>`;
function cell(text, { bold, widthPct } = {}, colCount) {
  const width = Math.round(9026 / colCount);
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${BORDER}<w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${run(text, { bold })}</w:p></w:tc>`;
}
// columns: 헤더 문자열 배열, rows: 원본 데이터 배열, cellsFn: row => 문자열 배열(컬럼과 동일 길이)
function tableBlock(columns, rows, cellsFn) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return paragraph("해당 없음", { size: 20 });
  }
  const n = columns.length;
  const header = `<w:tr>${columns.map(c => cell(c, { bold: true }, n)).join("")}</w:tr>`;
  const body = rows.map(r => `<w:tr>${cellsFn(r).map(v => cell(v, {}, n)).join("")}</w:tr>`).join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="9026" w:type="dxa"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(s => `<w:${s} w:val="single" w:sz="4" w:color="CCCCCC"/>`).join("")}</w:tblBorders></w:tblPr><w:tblGrid>${columns.map(() => `<w:gridCol w:w="${Math.round(9026 / n)}"/>`).join("")}</w:tblGrid>${header}${body}</w:tbl><w:p/>`;
}
function subLabel(text) {
  return paragraph("· " + text, { bold: true, spacingBefore: 160, spacingAfter: 80 });
}
function sectionTitle(text) {
  return paragraph(text, { bold: true, size: 28, spacingBefore: 280, spacingAfter: 160 });
}

function buildBodyXml(report) {
  let parsed = {};
  try { parsed = JSON.parse(report.content || "{}"); } catch { /* 파싱 실패 시 빈 보고서로 처리 */ }
  const brands = parsed.collection?.brands || [];
  const issues = parsed.issues || {};
  const debtorMgmt = parsed.debtorMgmt || {};
  const overview = parsed.overview || [];
  const checklist = parsed.checklist || [];

  const parts = [];
  parts.push(paragraph(report.title || "", { bold: true, size: 32, spacingAfter: 40 }));
  parts.push(paragraph(`${report.created_by || "-"} 작성 · ${(report.created_at || "").slice(0, 16)}`, { size: 18, spacingAfter: 200 }));

  // 1. 채권추심 현황
  parts.push(sectionTitle("1. 채권추심 현황"));
  const brandRows = brands.length ? [
    ...brands,
    { brandName: "계", balance: brands.reduce((s, b) => s + (b.balance || 0), 0), periodCollected: brands.reduce((s, b) => s + (b.periodCollected || 0), 0) },
  ] : [];
  parts.push(tableBlock(["브랜드", "잔액", "기간 입금액"], brandRows,
    b => [b.brandName || b.brandCode, fmtWon(b.balance), fmtWon(b.periodCollected)]));

  // 2. 주요현안
  parts.push(sectionTitle("2. 주요현안"));
  parts.push(subLabel("강제집행 대상자 중 등록 1주 이상 미완료"));
  parts.push(tableBlock(["채무자", "브랜드", "담당자", "경과"], issues.forcedExecOverdue,
    r => [r.debtorName, r.brand || "-", r.assignee || "-", `${r.daysElapsed}일`]));
  parts.push(subLabel("신용분석 대상자 중 요청 1주 이상 미조회"));
  parts.push(tableBlock(["대상", "브랜드", "담당자", "경과"], issues.creditCheckOverdue,
    r => [r.target, r.brand || "-", r.assignee || "-", `${r.daysElapsed}일`]));
  parts.push(subLabel("주요협의 대상자 현황"));
  parts.push(tableBlock(["채무자", "메모"], issues.negotiations,
    r => [r.debtorName, r.note || "-"]));
  parts.push(subLabel("이번 기간 등록된 업무"));
  parts.push(tableBlock(["분류", "업무내용", "담당자", "등록일"], issues.todoRegistered,
    r => [r.priority, r.task, r.assignee || "-", r.createdAt]));
  parts.push(subLabel("이번 기간 완료된 업무"));
  parts.push(tableBlock(["분류", "업무내용", "담당자", "완료일"], issues.todoCompleted,
    r => [r.priority, r.task, r.assignee || "-", r.completedAt]));
  parts.push(subLabel("다음 기간 주요일정"));
  parts.push(tableBlock(["일정", "구분", "내용"], issues.nextPeriodSchedule,
    r => [`${r.date}${r.endDate && r.endDate !== r.date ? `~${r.endDate}` : ""}`, r.type, r.text]));

  // 3. 채무자관리
  parts.push(sectionTitle("3. 채무자관리"));
  parts.push(subLabel("히스토리 경과기간 오래된 채무자 (담당자별 무작위 5명, 오래된 순 우선)"));
  const contactRows = (debtorMgmt.contactAgingByAssignee || []).flatMap(g => g.picks.map(p => ({ assignee: g.assignee, ...p })));
  parts.push(tableBlock(["담당자", "채무자", "경과일", "잔액"], contactRows,
    r => [r.assignee, r.name, `${r.agingDays}일`, fmtWon(r.balance)]));
  parts.push(subLabel("이전 기간 분할상환 미입금"));
  parts.push(tableBlock(["채무자", "담당자", "납부기한", "예정액", "납부액", "상태"], debtorMgmt.installmentOverduePrevPeriod,
    r => [r.debtorName, r.assignee || "-", r.dueDate, fmtWon(r.scheduledAmount), fmtWon(r.paidAmount), r.status]));
  parts.push(subLabel("이번 기간 분할상환 미입금 현황"));
  parts.push(tableBlock(["채무자", "담당자", "납부기한", "예정액", "상태"], debtorMgmt.installmentThisPeriod,
    r => [r.debtorName, r.assignee || "-", r.dueDate, fmtWon(r.scheduledAmount), r.status]));

  // 4. 종합현황
  parts.push(sectionTitle("4. 종합현황"));
  parts.push(tableBlock(["구분", "잘한 점", "우려·미흡한 점", "체크할 사항"], overview,
    r => [r.category, r.good || "-", r.concern || "-", r.checkpoint || "-"]));

  // 5. 차주 주요체크사항
  parts.push(sectionTitle("5. 차주 주요체크사항"));
  if (!checklist.length) parts.push(paragraph("해당 없음", { size: 20 }));
  else parts.push(...checklist.map(bulletParagraph));
  parts.push(subLabel("차주 분할상환 예정 현황"));
  parts.push(tableBlock(["채무자", "담당자", "납부기한", "예정액", "상태"], debtorMgmt.installmentNextPeriod,
    r => [r.debtorName, r.assignee || "-", r.dueDate, fmtWon(r.scheduledAmount), r.status]));

  return parts.join("");
}

async function generateReportDocx(report) {
  const bodyXml = buildBodyXml(report);
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${bodyXml}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body>
</w:document>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

  const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>${esc(report.title || "")}</dc:title>
<dc:creator>${esc(report.created_by || "DebtFlow")}</dc:creator>
</cp:coreProperties>`;

  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypesXml);
  zip.folder("_rels").file(".rels", rootRelsXml);
  zip.folder("word").file("document.xml", documentXml);
  zip.folder("docProps").file("core.xml", coreXml);
  return zip.generateAsync({ type: "nodebuffer" });
}

module.exports = { generateReportDocx };
