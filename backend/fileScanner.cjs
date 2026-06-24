// ============================================================
// fileScanner.cjs — OneDrive 폴더에서 채무자 관련 서류 탐색
// 파일명 패턴: 날짜_수발신형태_이름_문서명.확장자
//   예) 260624_발급_홍길동_주민등록초본.pdf
// ============================================================
const fs = require("fs");
const path = require("path");

const SUPPORTED_EXTS = new Set(["pdf","docx","doc","xlsx","xls","hwp","hwpx","jpg","jpeg","png","zip","pptx","ppt"]);
const MAX_FILES = 8000;
const MAX_DEPTH = 8;

/**
 * 파일명 파싱: 날짜_수발신형태_이름_문서명.확장자
 * 토큰 4개 이상: [0]=날짜 [1]=방향 [2]=인물명 [3+]=문서종류
 * 토큰 3개: [0]=날짜 [1]=인물명 [2]=문서종류 (방향 없음)
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
  return { date: null, direction: null, personName: null, docType: base, ext };
}

/**
 * 파일 하나를 채무자+보증인 목록에 대해 점수 산정
 *
 * 점수 기준:
 *   100 — 파일명 인물명 토큰이 채무자명과 정확 일치
 *    75 — 파일명 인물명 토큰이 보증인명과 정확 일치
 *    65 — 파일명 어딘가에 채무자명 포함
 *    45 — 파일명 어딘가에 보증인명 포함
 *    30 — 폴더명에 채무자명 포함
 *    15 — 폴더명에 보증인명 포함
 */
function scoreFile(parsed, filename, relFolderPath, debtorName, guarantorNames) {
  const targets = [
    { name: debtorName, type: "primary" },
    ...(guarantorNames || []).map(g => ({ name: g, type: "guarantor" })),
  ].filter(t => t.name && String(t.name).trim());

  let bestScore = 0, bestReason = "", bestName = null, bestType = null;

  for (const { name, type } of targets) {
    const ip = type === "primary";
    let score = 0, reason = "";

    if (parsed.personName === name) {
      score = ip ? 100 : 75;
      reason = `파일명 인물명 토큰이 ${ip ? "채무자" : "보증인"}명과 정확 일치`;
    } else if (filename.includes(name)) {
      score = ip ? 65 : 45;
      reason = `파일명에 ${ip ? "채무자" : "보증인"}명 포함`;
    } else if (relFolderPath.includes(name)) {
      score = ip ? 30 : 15;
      reason = `폴더명에 ${ip ? "채무자" : "보증인"}명 포함`;
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

module.exports = { findCandidates, parseFileName };
