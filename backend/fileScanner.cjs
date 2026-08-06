// ============================================================
// fileScanner.cjs — OneDrive 폴더에서 채무자 관련 서류 탐색
// 파일명 패턴: 날짜_수발신형태_이름_문서명.확장자
//   예) 260624_발급_홍길동_주민등록초본.pdf
// ============================================================
const fs = require("fs");
const path = require("path");

const SUPPORTED_EXTS = new Set(["pdf","docx","doc","xlsx","xls","hwp","hwpx","jpg","jpeg","png","zip","pptx","ppt"]);
const MAX_FILES = 50000;
const MAX_DEPTH = 8;

// 언더스코어 컨벤션을 안 따르는 파일명(예: "차동현 신용정보조회 2026.08.05.pdf")에서
// 날짜만이라도 최대한 건져내기 위한 느슨한 매칭. YYMMDD 6자리로 정규화해서
// 반환한다 — 기존 언더스코어 컨벤션의 날짜 토큰(예: "260624")과 같은 형식이라야
// server.cjs의 문자열 비교(신규 문서 감지, 후보 정렬)가 서로 뒤섞여도 올바르게 동작한다.
const LENIENT_DATE_FULL_RE = /(20\d{2}|19\d{2})[.\-/]\s?(\d{1,2})[.\-/]\s?(\d{1,2})/;
const LENIENT_DATE_COMPACT_RE = /\b(20\d{2}|19\d{2})(\d{2})(\d{2})\b/;

function extractLenientDate(base) {
  let m = base.match(LENIENT_DATE_FULL_RE) || base.match(LENIENT_DATE_COMPACT_RE);
  if (!m) return null;
  const yy = m[1].slice(2), mo = m[2].padStart(2, "0"), dd = m[3].padStart(2, "0");
  return `${yy}${mo}${dd}`;
}

// 인물명도 마찬가지로 느슨하게 추출: 파일명에서 한글 연속 구간들을 뽑아, 사람 이름
// 길이(2~4자)에 맞는 첫 구간을 채택한다. "신용정보조회"(6자) 같은 문서종류 단어는
// 길이 조건에서 자연히 걸러진다. 실패해도 filename LIKE 검색이 안전망으로 남아있어
// (server.cjs의 여러 조회가 parsed_person_name OR filename 둘 다 확인) 매칭 자체가
// 깨지지는 않는다 — 못 찾으면 null.
const HANGUL_RUN_RE = /[가-힣]+/g;

function extractLenientPersonName(base) {
  const runs = base.match(HANGUL_RUN_RE) || [];
  return runs.find(r => r.length >= 2 && r.length <= 4) || null;
}

/**
 * 파일명 파싱: 날짜_수발신형태_이름_문서명.확장자
 * 토큰 4개 이상: [0]=날짜 [1]=방향 [2]=인물명 [3+]=문서종류
 * 토큰 3개: [0]=날짜 [1]=인물명 [2]=문서종류 (방향 없음)
 * 언더스코어가 전혀 없으면(위 컨벤션을 안 따르는 파일) 날짜·인물명을 느슨하게 추출한다.
 */
function parseFileName(filename) {
  const ext = path.extname(filename).replace(".", "").toLowerCase();
  const base = path.basename(filename, path.extname(filename));
  const parts = base.split("_");

  if (parts.length >= 4) {
    return { date: parts[0], direction: parts[1], personName: parts[2], docType: parts.slice(3).join("_"), ext };
  }
  if (parts.length === 3) {
    return { date: parts[0], direction: null, personName: parts[1], docType: parts[2], ext };
  }
  if (parts.length === 2) {
    return { date: null, direction: null, personName: parts[0], docType: parts[1], ext };
  }
  return { date: extractLenientDate(base), direction: null, personName: extractLenientPersonName(base), docType: base, ext };
}

/**
 * 이름 정규화: 숫자·특수문자 제거 후 앞 3글자 한글만 추출
 * 예) "주성호1" → "주성호", "김철수10" → "김철수"
 */
function normalizeKorean3(name) {
  if (!name) return null;
  const korOnly = String(name).replace(/[^가-힣]/g, "");
  return korOnly.length >= 2 ? korOnly.slice(0, 3) : null;
}

/**
 * 파일 하나를 채무자+보증인 목록에 대해 점수 산정
 *
 * 점수 기준 (정확명):
 *   100 — 파일명 인물명 토큰 = 채무자명 정확 일치
 *    90 — 파일명 인물명 토큰 = 채무자명 정규화(앞3자) 일치
 *    75 — 파일명 인물명 토큰 = 보증인명 정확 일치
 *    65 — 파일명에 채무자명 포함
 *    55 — 파일명에 채무자 정규화명 포함
 *    45 — 파일명에 보증인명 포함
 *    30 — 폴더명에 채무자명 포함
 *    25 — 폴더명에 채무자 정규화명 포함
 *    15 — 폴더명에 보증인명 포함
 */
function scoreFile(parsed, filename, relFolderPath, debtorName, guarantorNames) {
  const normDebtor = normalizeKorean3(debtorName);

  const targets = [
    { name: debtorName, norm: false, type: "primary" },
    ...(normDebtor && normDebtor !== debtorName ? [{ name: normDebtor, norm: true, type: "primary" }] : []),
    ...(guarantorNames || []).flatMap(g => {
      const ng = normalizeKorean3(g);
      return [
        { name: g, norm: false, type: "guarantor" },
        ...(ng && ng !== g ? [{ name: ng, norm: true, type: "guarantor" }] : []),
      ];
    }),
  ].filter(t => t.name && String(t.name).trim());

  let bestScore = 0, bestReason = "", bestName = null, bestType = null;

  for (const { name, norm, type } of targets) {
    const ip = type === "primary";
    let score = 0, reason = "";

    if (parsed.personName === name) {
      score = ip ? (norm ? 90 : 100) : 75;
      reason = `파일명 인물명 토큰 = ${ip ? "채무자" : "보증인"}명${norm ? " (정규화)" : ""} 정확 일치`;
    } else if (filename.includes(name)) {
      score = ip ? (norm ? 55 : 65) : 45;
      reason = `파일명에 ${ip ? "채무자" : "보증인"}명${norm ? " (정규화)" : ""} 포함`;
    } else if (relFolderPath.includes(name)) {
      score = ip ? (norm ? 25 : 30) : 15;
      reason = `폴더명에 ${ip ? "채무자" : "보증인"}명${norm ? " (정규화)" : ""} 포함`;
    }

    if (score > bestScore) {
      bestScore = score; bestReason = reason; bestName = name; bestType = type;
    }
  }

  return { score: bestScore, matchReason: bestReason, matchedName: bestName, matchType: bestType };
}

/**
 * 디렉토리 재귀 탐색 (최대 깊이·파일 수 제한)
 */
function scanDir(dirPath, depth, collected) {
  if (depth > MAX_DEPTH || collected.length >= MAX_FILES) return;
  let entries;
  try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    if (collected.length >= MAX_FILES) break;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      scanDir(fullPath, depth + 1, collected);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).replace(".", "").toLowerCase();
      if (SUPPORTED_EXTS.has(ext)) collected.push(fullPath);
    }
  }
}

/**
 * 채무자에 맞는 파일 후보 목록 반환
 *
 * @param {string}   rootPath      - 스캔 루트 폴더 (절대 경로)
 * @param {string}   debtorName    - 채무자명
 * @param {string[]} guarantorNames - 연대보증인명 목록
 * @param {number}   minScore      - 최소 점수 (기본 20)
 * @returns {{ ok, candidates, totalScanned, error? }}
 */
function findCandidates(rootPath, debtorName, guarantorNames = [], minScore = 20) {
  if (!rootPath || !fs.existsSync(rootPath)) {
    return { ok: false, error: "스캔 경로가 존재하지 않습니다", candidates: [], totalScanned: 0 };
  }

  const allFiles = [];
  scanDir(rootPath, 0, allFiles);

  const candidates = [];

  for (const filePath of allFiles) {
    const filename    = path.basename(filePath);
    const relFolder   = path.relative(rootPath, path.dirname(filePath));
    const parsed      = parseFileName(filename);
    const { score, matchReason, matchedName, matchType } = scoreFile(
      parsed, filename, relFolder, debtorName, guarantorNames
    );

    if (score >= minScore) {
      candidates.push({
        filePath,
        filename,
        relPath:          path.relative(rootPath, filePath),
        folderName:       path.basename(path.dirname(filePath)),
        parsedDate:       parsed.date       || null,
        parsedDirection:  parsed.direction  || null,
        parsedPersonName: parsed.personName || null,
        docType:          parsed.docType    || filename,
        ext:              parsed.ext,
        score,
        matchReason,
        matchedName,
        matchType,
      });
    }
  }

  // 점수 내림차순, 동점이면 날짜 내림차순 (최신 우선)
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.parsedDate || "").localeCompare(a.parsedDate || "");
  });

  return { ok: true, candidates, totalScanned: allFiles.length };
}

/**
 * 전체 파일 목록 반환 (점수 없이, 인덱스 구축용)
 */
function indexAllFiles(rootPath) {
  if (!rootPath || !fs.existsSync(rootPath)) {
    return { ok: false, error: "스캔 경로가 존재하지 않습니다", files: [], totalScanned: 0 };
  }
  const allFiles = [];
  scanDir(rootPath, 0, allFiles);
  const files = allFiles.map(filePath => {
    const filename   = path.basename(filePath);
    const relPath    = path.relative(rootPath, filePath);
    const folderName = path.basename(path.dirname(filePath));
    const parsed     = parseFileName(filename);
    return {
      filePath, filename, relPath, folderName,
      parsedDate:       parsed.date       || null,
      parsedDirection:  parsed.direction  || null,
      parsedPersonName: parsed.personName || null,
      docType:          parsed.docType    || filename,
      ext:              parsed.ext,
    };
  });
  return { ok: true, files, totalScanned: allFiles.length };
}

module.exports = { findCandidates, parseFileName, scoreFile, indexAllFiles };
