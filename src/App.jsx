import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { EXCEL_DEBTORS } from "./excelData.js";
import { EXCEL_REHABS } from "./rehabData.js";
import { LEGAL_CASES, MINSA_CASES, ASSET_DISCLOSURE_CASES } from "./legalData.js";
import { COLLECTION_ORDERS } from "./collectionData.js";

// ─── Utilities ────────────────────────────────────────────
const fmt = (n) => `${(n || 0).toLocaleString("ko-KR")}원`;
const fmtDate = (d) => {
  if (!d) return "-";
  const dt = new Date(d);
  return `${dt.getFullYear()}.${String(dt.getMonth() + 1).padStart(2, "0")}.${String(dt.getDate()).padStart(2, "0")}`;
};
const today = () => new Date().toISOString().split("T")[0];
const daysUntil = (d) => (d ? Math.ceil((new Date(d) - new Date()) / 864e5) : Infinity);
const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const uid = (prefix) => `${prefix}${Date.now()}${rand(100, 999)}`;
// "**중요**" 처럼 **로 감싼 부분만 붉은 글씨로 강조해서 렌더링 (AI 종합분석이 중요 항목을
// 이 문법으로 표시해서 만든 기능 — 일반 텍스트에도 그대로 적용돼도 무해함)
const RichNoteText = ({ text }) => {
  const parts = String(text || "").split(/\*\*(.+?)\*\*/g);
  return parts.map((part, i) =>
    i % 2 === 1
      ? <span key={i} style={{ color: "#dc2626", fontWeight: 700 }}>{part}</span>
      : <span key={i}>{part}</span>
  );
};

// ─── Default Config (editable via admin) ──────────────────
const DEFAULT_CONFIG = {
  brands: [
    { code: "B", name: "바로고",   color: "#f59e0b" },
    { code: "D", name: "딜버",     color: "#3b82f6" },
    { code: "M", name: "모아라인", color: "#8b5cf6" },
    { code: "G", name: "그라이더", color: "#10b981" },
  ],
  categories: ["장기채권", "추심의뢰", "회생/파산", "협의/소송", "분할상환", "캐쉬상환", "완료", "대손채권"],
  collStatuses: ["추심진행", "추심보류", "완료", "대손채권"],
  assignees: ["준원", "덕진"],
  debtCauses: ["본사", "웰컴", "어뷰징", "물품대금"],
  hubNames: [
    "광진본점허브", "충남천안원콜성두7지점", "강서마곡허브", "동대문허브",
    "용산허브", "송파석촌허브", "인천서구허브", "부산해운대허브",
    "대구수성허브", "수원영통허브", "성남분당허브", "안양만안허브",
  ],
  activityTypes: ["전화", "문자", "입금확인", "법적조치", "방문", "카카오톡", "내용증명"],
  paymentChannels: ["본사계좌", "캐쉬충전", "웰컴직접상환"],
  installmentTimings: ["월초", "월중", "월말", "수시"],
  courts: ["서울중앙지법", "서울동부지법", "인천지법", "수원지법", "부산지법", "대구지법", "대전지법"],
  rehabTypes: ["회생", "파산/면책"],
  chargeTypes: ["사기", "횡령"],
  policeStations: ["광진경찰서", "강서경찰서", "송파경찰서", "서초경찰서", "강남경찰서"],
};

const DEBTOR_NAMES = [
  "㈜에스플러스","한준희","김용진","박찬영","이정석","장연옥","김호순",
  "최민수","강태양","오서연","윤재호","임미경","조성훈","배수진",
  "신동우","허지영","류현우","문예진","권도현","황수빈","안지훈",
  "서하은","전민재","양나경","노태영","하지원","구본석","유서현",
  "남기태","엄혜원","정대호","송민서","강다은","조재욱","홍예진",
  "문성훈","권나영","황도윤","박상현","최유리","이미진","김영수",
];
const GUARANTOR_NAMES = ["이정석","장연옥","김호순","박미영","최재원","한수진"];
const THIRD_PARTIES = [
  "국민은행","신한은행","우리은행","하나은행","농협은행",
  "카카오뱅크","토스뱅크","기업은행","SC제일은행","대구은행",
  "부산은행","경남은행","쿠팡이츠","배달의민족","요기요",
];

function pickW(items, w) {
  let r = Math.random(), c = 0;
  for (let i = 0; i < items.length; i++) { c += w[i]; if (r <= c) return items[i]; }
  return items[items.length - 1];
}

// 대시보드 분류별 현황
const DASHBOARD_GROUPS = [
  { label: "추심진행중", color: "#3b82f6", cats: ["장기채권"] },
  { label: "협의소송",   color: "#f97316", cats: ["협의/소송"] },
  { label: "회생/파산",  color: "#7c3aed", cats: ["회생/파산"] },
  { label: "추심의뢰",   color: "#f59e0b", cats: ["추심의뢰"] },
  { label: "분할상환",   color: "#06b6d4", cats: ["분할상환"] },
  { label: "캐쉬상환",   color: "#10b981", cats: ["캐쉬상환"] },
  { label: "완료",       color: "#22c55e", cats: ["완료"] },
  { label: "대손채권",   color: "#ef4444", cats: ["대손채권"] },
];

// ─── 연체 에이징 구간 ───────────────────────────────────────
const AGING_BUCKETS = [
  { key: "b0",   label: "30일 미만",  min: 0,   max: 30,       color: "#10b981" },
  { key: "b30",  label: "30~59일",    min: 30,  max: 60,       color: "#f59e0b" },
  { key: "b60",  label: "60~89일",    min: 60,  max: 90,       color: "#f97316" },
  { key: "b90",  label: "90~119일",   min: 90,  max: 120,      color: "#ef4444" },
  { key: "b120", label: "120일 이상", min: 120, max: Infinity, color: "#991b1b" },
];

const ASSIGNEE_COLORS = ["#3b82f6", "#f97316", "#10b981", "#8b5cf6", "#ef4444", "#06b6d4", "#eab308", "#ec4899"];

// ─── Data Generation ──────────────────────────────────────
function generateData(cfg) {
  const debtors = [], payments = [], activities = [], seizureCases = [], rehabilitations = [], installmentPlans = [], complaints = [];
  for (let i = 0; i < 500; i++) {
    const brand = pick(cfg.brands);
    const category = pickW(cfg.categories, [0.6, 0.25, 0.15]);
    const status = category === "회생파산" ? "추심보류" : pick(cfg.collStatuses);
    const hubCode = String(rand(1000, 9999));
    const subCode = Math.random() > 0.8 ? `${hubCode}-${rand(1, 3)}` : hubCode;
    const principal = rand(50, 5000) * 10000;
    const adjustment = Math.random() > 0.7 ? rand(10, 200) * 10000 : 0;
    const collected = Math.round(principal * Math.random() * 0.6);
    const finalFinance = principal - collected;
    const finalLegal = finalFinance + adjustment;
    const assignee = pick(cfg.assignees);
    const debtorName = pick(DEBTOR_NAMES);
    const loanDate = new Date(2019 + rand(0, 5), rand(0, 11), rand(1, 28)).toISOString().split("T")[0];
    const monthlyCollected = {};
    for (let m = 1; m <= 12; m++) monthlyCollected[m] = m <= 4 ? rand(0, 5) * 100000 : 0;

    const debtor = {
      id: `NPL${String(i + 1).padStart(4, "0")}`, brand: brand.code, brandName: brand.name, brandColor: brand.color,
      category, assignee, name: debtorName,
      guarantors: Math.random() > 0.6 ? Array.from({ length: rand(1, 2) }, () => pick(GUARANTOR_NAMES)) : [],
      phone: `010-${rand(1000, 9999)}-${rand(1000, 9999)}`,
      phoneHistory: Math.random() > 0.7 ? [`010-${rand(1000, 9999)}-${rand(1000, 9999)} (결번)`] : [],
      hubCode: subCode, hubName: pick(cfg.hubNames), debtCause: pick(cfg.debtCauses),
      collectionStatus: status,
      creditCheck: Math.random() > 0.5 ? fmtDate(new Date(2023, rand(0, 11), rand(1, 28))) : null,
      creditGrade: Math.random() > 0.5 ? pick(["1등급","2등급","3등급","4등급","5등급","6등급","7등급","8등급","9등급","10등급"]) : null,
      execTitle: Math.random() > 0.4,
      residentCopy: Math.random() > 0.5 ? fmtDate(new Date(2023, rand(0, 11), rand(1, 28))) : null,
      salesRep: Math.random() > 0.6 ? `${rand(1, 3)}팀 ${pick(["김상원","박지호","이승현"])} 010-${rand(1000, 9999)}-${rand(1000, 9999)}` : null,
      loanDate, subrogationMonth: Math.random() > 0.7 ? `${2020 + rand(0, 4)}년 ${rand(1, 12)}월` : null,
      keyNotes: Math.random() > 0.5 ? pick(["2024.03 내용증명 발송 완료","지급명령 확정, 강제집행 준비중","분납 협의 진행중 - 월 30만원","주소불명, 초본 재발급 필요","연대보증인 통해 일부 회수","파산면책 신청 확인됨","2025.01 채권압류 신청"]) : "",
      principalBalance: principal, adjustment, collectedAmount: collected,
      finalBalanceFinance: finalFinance, finalBalanceLegal: finalLegal, monthlyCollected,
    };
    debtors.push(debtor);

    for (let p = 0; p < rand(0, 8); p++) {
      const total = rand(1, 50) * 10000; const ch = pick(cfg.paymentChannels);
      payments.push({ id: `PAY${String(payments.length + 1).padStart(5, "0")}`, debtorId: debtor.id, debtorName: debtor.name, brand: debtor.brand, assignee: debtor.assignee, hubName: debtor.hubName, hubCode: debtor.hubCode, paymentDate: new Date(2025 + rand(0, 1), rand(0, 11), rand(1, 28)).toISOString().split("T")[0], payerName: Math.random() > 0.8 ? pick(GUARANTOR_NAMES) : debtor.name, totalAmount: total, companyAccount: ch === "본사계좌" ? total : 0, cashCharge: ch === "캐쉬충전" ? total : 0, welcomeDirect: ch === "웰컴직접상환" ? total : 0, note: pick(["","","회생금","분납","일시납","연대보증인 입금"]) });
    }
    for (let a = 0; a < rand(1, 12); a++) {
      activities.push({ id: `ACT${String(activities.length + 1).padStart(5, "0")}`, debtorId: debtor.id, debtorName: debtor.name, brand: debtor.brand, activityDate: new Date(2025, rand(0, 11), rand(1, 28)).toISOString().split("T")[0], activityType: pick(cfg.activityTypes), content: pick(["통화 성공 - 다음주 월요일 50만원 입금 약속","부재중, 문자 발송","입금 확인 30만원","지급명령 신청 완료","카카오톡 발송 - 읽음 확인","현장 방문 - 부재","분납 협의 - 월 20만원 합의","연락 불가, 결번 확인","내용증명 발송","연대보증인 연락 - 상황 안내","채무자 연락옴 - 상환 의사 확인","압류 결정문 수령"]), assignee: debtor.assignee });
    }
    if (Math.random() > 0.7 && debtor.execTitle) {
      seizureCases.push({ id: `SEZ${String(seizureCases.length + 1).padStart(4, "0")}`, debtorId: debtor.id, debtorName: debtor.name, brand: debtor.brand, hubName: debtor.hubName, court: pick(cfg.courts), caseNumber: `2025타채${rand(10000, 99999)}`, procedureType: pickW(["압류","지급명령","재산명시 및 재산조회"],[0.5,0.3,0.2]), status: pick(["결정","송달완료","추심중","배당완료","취하"]), targets: Array.from({ length: rand(2, 8) }, (_, ti) => ({ seq: ti + 1, thirdPartyName: pick(THIRD_PARTIES), responseDate: Math.random() > 0.4 ? new Date(2025, rand(0, 11), rand(1, 28)).toISOString().split("T")[0] : null, claimAmount: rand(50, 3000) * 10000, balance: rand(0, 500) * 10000, collected: rand(0, 200) * 10000, note: pick(["","","청구필요","추심포기","잔액없음","추심중"]), completed: Math.random() > 0.6 })) });
    }
    if (category === "회생파산") {
      rehabilitations.push({ id: `REH${String(rehabilitations.length + 1).padStart(4, "0")}`, debtorId: debtor.id, debtorName: debtor.name, brand: debtor.brand, court: pick(cfg.courts), caseNumber: `2024개회${rand(1000, 9999)}`, type: pick(cfg.rehabTypes), creditorNumber: rand(1, 30), planApproved: Math.random() > 0.3, dismissed: Math.random() > 0.85, debtAmount: principal, approvedAmount: Math.round(principal * (rand(10, 40) / 100)), currentRound: `${rand(1, 36)}회차`, monthlyPayment: rand(5, 30) * 10000, repaymentNote: pick(["변제 진행중","1~36회차 진행","미납 2회","정상 변제중","폐지 검토"]), overdueStatus: Math.random() > 0.7 ? "미납" : "" });
    }
    if (status === "추심진행" && Math.random() > 0.6) {
      const mAmt = rand(10, 100) * 10000;
      installmentPlans.push({ id: `INS${String(installmentPlans.length + 1).padStart(4, "0")}`, debtorId: debtor.id, debtorName: debtor.name, brand: debtor.brand, brandName: brand.name, hubCode: subCode, paymentTiming: pick(cfg.installmentTimings), monthlyAmount: mAmt, totalDebt: principal, totalClaim: finalLegal, assignee: debtor.assignee, startDate: new Date(2024, rand(0, 11), 1).toISOString().split("T")[0], status: pick(["진행중","진행중","진행중","완료","중단"]), logs: Array.from({ length: rand(3, 12) }, (_, li) => ({ targetMonth: `${2024 + Math.floor((li + rand(0, 5)) / 12)}년 ${((li + rand(1, 3)) % 12) + 1}월`, paidAmount: Math.random() > 0.2 ? mAmt : 0, memo: pick(["입금확인","","미납","지연입금","일부입금",""]), status: Math.random() > 0.2 ? "완납" : Math.random() > 0.5 ? "미납" : "지연" })) });
    }
    if (Math.random() > 0.9) {
      complaints.push({ id: `CRM${String(complaints.length + 1).padStart(4, "0")}`, debtorId: debtor.id, debtorName: debtor.name, brand: debtor.brand, assignee: debtor.assignee, complainant: "㈜바로고", hubName: debtor.hubName, goodsAmount: rand(100, 3000) * 10000, loanAmount: principal, charge: pick(cfg.chargeTypes), complaintDate: new Date(2024, rand(0, 11), rand(1, 28)).toISOString().split("T")[0], policeStation: pick(cfg.policeStations), status: pick(["수사중","기소","불기소","재정신청","1심 진행중"]) });
    }
  }
  activities.sort((a, b) => b.activityDate.localeCompare(a.activityDate));
  payments.sort((a, b) => b.paymentDate.localeCompare(a.paymentDate));
  return { debtors, payments, activities, seizureCases, rehabilitations, installmentPlans, complaints, legalCases: [], minsaCases: [], assetDisclosures: [] };
}

// ─── Excel 데이터 로더 ────────────────────────────────────
const CATEGORY_NORMALIZE = { "회생파산": "회생/파산" };

// 채무자 이름 정규화: (회생), (파산면책), ㈜ 등 제거하여 매칭에 사용
function normNameForMatch(s) {
  return String(s || "")
    .replace(/\([^)]*\)/g, "")    // 괄호 안 내용 전체 제거: (회생), (파산 면책), (파산) 등
    .replace(/㈜|주식회사|\(주\)/g, "")
    .replace(/회생|파산|면책|회셍/g, "")
    .replace(/\s+/g, "")
    .toLowerCase()
    .trim();
}

// 채무자명이 나중에 수정(중복 구분용 "1" 등)되어 이름+브랜드 매칭이 끊겼을 때의 보조 매칭용:
// 전화번호 문자열에서 첫 010-XXXX-XXXX 형태만 추출해 숫자만 남긴다 (다중 번호 텍스트에도 안전)
function extractPhoneDigits(s) {
  const m = String(s || "").match(/01[0-9][-\s]?\d{3,4}[-\s]?\d{4}/);
  return m ? m[0].replace(/[-\s]/g, "") : "";
}

// excelData.js(원본 엑셀 스냅샷) ↔ 실제 DB 채무자 매칭용 인덱스.
// 이름+브랜드가 1차 키. NPL#### id는 excelData.js와 운영 DB가 서로 다른 원본 파일에서
// 독립적으로 새로 매겨진 값이라 우연히 겹칠 수 있으므로 매칭 키로 쓰지 않는다.
const EXCEL_BY_KEY = {};
const EXCEL_BY_PHONE = {}; // 브랜드+전화번호가 여러 명과 겹치면 null(모호함) — 유일할 때만 보조 매칭에 사용
EXCEL_DEBTORS.forEach(e => {
  EXCEL_BY_KEY[`${e.brand}||${e.name}`] = e;
  const pd = extractPhoneDigits(e.phone);
  if (pd) {
    const pkey = `${e.brand}||${pd}`;
    EXCEL_BY_PHONE[pkey] = (pkey in EXCEL_BY_PHONE) ? null : e;
  }
});
// 이름+브랜드 매칭 실패 시에만, 전화번호가 유일하게 일치하는 원본이 있으면 보조로 매칭
function matchExcelDebtor(d) {
  return EXCEL_BY_KEY[`${d.brand}||${d.name}`] || EXCEL_BY_PHONE[`${d.brand}||${extractPhoneDigits(d.phone)}`] || undefined;
}

// 현재 로그인한 사용자 이름 — App() 컴포넌트 밖에서도 참조할 수 있도록
// 모듈 전역 변수에 최신값을 유지한다 (어드민 통계의 "누가 입력했는지" 집계용).
let CURRENT_USER_NAME = null;

// 이 앱은 fetch()를 곳곳에서 개별적으로 직접 호출하고 있어(중앙 API 헬퍼가 없음),
// kvPut 하나만 고쳐서는 다른 fetch 호출들이 여전히 사용자명 없이 나가 통계가 "알수없음"에
// 계속 쌓인다. window.fetch 자체를 한 번만 감싸서, 사용자명 헤더가 아직 없는 모든 요청에
// 자동으로 붙여준다 (호출부를 하나씩 고칠 필요 없음).
if (typeof window !== "undefined" && !window.__fetchWrappedForUserName) {
  window.__fetchWrappedForUserName = true;
  const origFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const headers = new Headers(init.headers || {});
    if (!headers.has("X-User-Name") && CURRENT_USER_NAME) {
      headers.set("X-User-Name", encodeURIComponent(CURRENT_USER_NAME));
    }
    return origFetch(input, { ...init, headers });
  };
}

// ─── 공유 KV 스토어 헬퍼 (localStorage + DB 동시 저장) ─────
// 저장: 로컬에 즉시 반영, DB에 비동기 전송 (SSE로 다른 사용자에게 전파)
function kvPut(key, value) {
  // 실패해도 로컬 화면은 정상으로 보이지만 다른 사용자/기기와는 조용히 어긋난다.
  // 원인 추적이 가능하도록 최소한 콘솔에는 남긴다.
  fetch(`/api/kv/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  })
    .then(r => { if (!r.ok) console.warn(`[kvPut] 서버 동기화 실패 (key=${key}, status=${r.status})`); })
    .catch(e => console.warn(`[kvPut] 서버 동기화 실패 (key=${key}):`, e.message));
}

// ─── 수동 추가 데이터 (localStorage + DB 공유 저장) ────────
const MK = {
  legalCases:       "manual_legal_cases",
  minsaCases:       "manual_minsa_cases",
  assetDisclosures: "manual_asset_disclosures",
  rehabilitations:  "manual_rehabilitations",
  installmentPlans: "manual_installment_plans",
  complaints:       "manual_complaints",
  debtors:          "manual_debtors",
  payments:         "manual_payments",
  activities:       "manual_activities",
  forcedExecutions: "manual_forced_executions",
  creditAnalyses:   "manual_credit_analyses",
  negotiations:     "manual_negotiations",
  todoList:         "manual_todo_list",
  assigneeTargets:  "manual_assignee_targets",
};
function getMR(key)  { try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch { return []; } }
function saveMR(key, recs) {
  localStorage.setItem(key, JSON.stringify(recs));
  kvPut(key, recs);
}
function addMR(key, rec)   { const r = [rec, ...getMR(key)]; saveMR(key, r); return r; }
function delMR(key, id)    { const r = getMR(key).filter(x => x.id !== id); saveMR(key, r); return r; }
function updateMR(key, id, patch) {
  const recs = getMR(key);
  const idx = recs.findIndex(x => x.id === id);
  if (idx === -1) return false;
  recs[idx] = { ...recs[idx], ...patch };
  saveMR(key, recs);
  return true;
}

// ─── 채무자 히스토리 (localStorage + DB 공유 저장) ──────────
// hist_m_{id}: 수동 추가 항목 [{id, date, content}]
// hist_e_{id}: Excel 항목 편집 { "e_N": {date, content} }
// hist_d_{id}: Excel 항목 삭제 [N, ...]
const getHistM = (id) => { try { return JSON.parse(localStorage.getItem(`hist_m_${id}`) || "[]"); } catch { return []; } };
const saveHistM = (id, arr) => { localStorage.setItem(`hist_m_${id}`, JSON.stringify(arr)); kvPut(`hist_m_${id}`, arr); };
const getHistE = (id) => { try { return JSON.parse(localStorage.getItem(`hist_e_${id}`) || "{}"); } catch { return {}; } };
const saveHistE = (id, obj) => { localStorage.setItem(`hist_e_${id}`, JSON.stringify(obj)); kvPut(`hist_e_${id}`, obj); };
const getHistD = (id) => { try { return JSON.parse(localStorage.getItem(`hist_d_${id}`) || "[]"); } catch { return []; } };
const saveHistD = (id, arr) => { localStorage.setItem(`hist_d_${id}`, JSON.stringify(arr)); kvPut(`hist_d_${id}`, arr); };
// 검색용: 채무자 히스토리(엑셀 원본 + 수동 추가, 수정/삭제 반영)를 한 문자열로 합친다
const getDebtorHistoryText = (d) => {
  const deletedSet = new Set(getHistD(d.id));
  const edits = getHistE(d.id);
  const excelTexts = (d.history || []).map((h, i) => deletedSet.has(i) ? "" : (edits[`e_${i}`]?.content ?? h.content ?? ""));
  const manualTexts = getHistM(d.id).map(h => h.content || "");
  return [...excelTexts, ...manualTexts].join(" ");
};
const histDateToInput = (s) => String(s || "").replace(/\./g, "-");
const histDateFromInput = (s) => String(s || "").replace(/-/g, ".");

// ─── 소송/사건 진행상황 메모 (localStorage + DB 공유 저장) ──
// case_notes_{caseId}: [{id, createdAt, content, createdBy}] — 날짜/작성자 자동 기재
const getCaseNotes = (id) => { try { return JSON.parse(localStorage.getItem(`case_notes_${id}`) || "[]"); } catch { return []; } };
const saveCaseNotes = (id, arr) => { localStorage.setItem(`case_notes_${id}`, JSON.stringify(arr)); kvPut(`case_notes_${id}`, arr); };
const fmtDateTime = (iso) => {
  if (!iso) return "-";
  const dt = new Date(iso);
  return `${dt.getFullYear()}.${String(dt.getMonth() + 1).padStart(2, "0")}.${String(dt.getDate()).padStart(2, "0")} ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
};

// ─── 수동 매칭 override (localStorage 영구 저장) ─────────
const REHAB_OVERRIDES_KEY = "rehab_manual_overrides";
function getRehabOverrides() {
  try { return JSON.parse(localStorage.getItem(REHAB_OVERRIDES_KEY) || "{}"); } catch { return {}; }
}
function saveRehabOverride(rehabId, debtorId) {
  const ov = getRehabOverrides();
  if (debtorId === null) delete ov[rehabId]; else ov[rehabId] = debtorId;
  localStorage.setItem(REHAB_OVERRIDES_KEY, JSON.stringify(ov));
  kvPut(REHAB_OVERRIDES_KEY, ov);
}
function applyRehabOverrides(rehabs) {
  const ov = getRehabOverrides();
  if (!Object.keys(ov).length) return rehabs;
  return rehabs.map(r => ov[r.id] !== undefined ? { ...r, debtorId: ov[r.id] } : r);
}

// 채무자 목록(기준)을 받아 회생파산 데이터의 debtorId를 재매칭
// 채무자 관리가 마스터 데이터 → 카테고리 '회생/파산'인 채무자를 최우선 매칭
function matchRehabsToDebtors(rehabs, debtors) {
  const byBrand = {};   // "brand:norm" → id  (회생/파산 카테고리가 덮어씀)
  const byName = {};    // "norm" → id         (회생/파산 카테고리가 덮어씀)

  // 1차: 전체 채무자 등록
  debtors.forEach(d => {
    const norm = normNameForMatch(d.name);
    if (!norm) return;
    if (!byBrand[`${d.brand}:${norm}`]) byBrand[`${d.brand}:${norm}`] = d.id;
    if (!byName[norm]) byName[norm] = d.id;
  });
  // 2차: 회생/파산 카테고리 채무자로 덮어쓰기 (최우선)
  debtors.forEach(d => {
    const isRehab = d.category === "회생/파산" || d.category === "회생파산";
    if (!isRehab) return;
    const norm = normNameForMatch(d.name);
    if (!norm) return;
    byBrand[`${d.brand}:${norm}`] = d.id;
    byName[norm] = d.id;
  });

  return rehabs.map(r => {
    const norm = normNameForMatch(r.debtorName);
    const debtorId = byBrand[`${r.brand}:${norm}`] || byName[norm] || null;
    return { ...r, debtorId };
  });
}

// ─── 법적절차 수동 매칭 override (localStorage 영구 저장) ──
const LEGAL_OVERRIDES_KEY = "legal_manual_overrides";
const MINSA_OVERRIDES_KEY = "minsa_manual_overrides";
const AD_OVERRIDES_KEY    = "ad_manual_overrides";
function getLegalOv(key)  { try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch { return {}; } }
function saveLegalOv(key, caseId, debtorId) {
  const ov = getLegalOv(key);
  if (debtorId === null) delete ov[caseId]; else ov[caseId] = debtorId;
  localStorage.setItem(key, JSON.stringify(ov));
  kvPut(key, ov);
}
function applyLegalOv(cases, key) {
  const ov = getLegalOv(key);
  if (!Object.keys(ov).length) return cases;
  return cases.map(c => ov[c.id] !== undefined ? { ...c, debtorId: ov[c.id] } : c);
}

// ─── 사건별 OneDrive URL ─────────────────────────────────
const CASE_URLS_KEY = "case_onedrive_urls";
function getCaseUrls() { try { return JSON.parse(localStorage.getItem(CASE_URLS_KEY) || "{}"); } catch { return {}; } }
function saveCaseUrl(caseId, url) { const m = getCaseUrls(); if (url && url.trim()) m[caseId] = url.trim(); else delete m[caseId]; localStorage.setItem(CASE_URLS_KEY, JSON.stringify(m)); kvPut(CASE_URLS_KEY, m); }
function getCaseUrl(caseId) { return getCaseUrls()[caseId] || ""; }

// ─── 추심의뢰 수동 매칭 + 편집 + 수동추가 + 삭제 override ───
const COLLECTION_OV_KEY      = "collection_manual_overrides";
const COLLECTION_EDIT_KEY    = "collection_edits";
const COLLECTION_MANUAL_KEY  = "collection_manual";
const COLLECTION_DELETED_KEY = "collection_deleted_ids";
function getCollectionOv()      { try { return JSON.parse(localStorage.getItem(COLLECTION_OV_KEY)      || "{}"); } catch { return {}; } }
function getCollectionEdits()   { try { return JSON.parse(localStorage.getItem(COLLECTION_EDIT_KEY)    || "{}"); } catch { return {}; } }
function getCollectionManual()  { try { return JSON.parse(localStorage.getItem(COLLECTION_MANUAL_KEY)  || "[]"); } catch { return []; } }
function getCollectionDeleted() { try { return JSON.parse(localStorage.getItem(COLLECTION_DELETED_KEY) || "[]"); } catch { return []; } }
function saveCollectionOv(orderId, debtorId) {
  const ov = getCollectionOv();
  if (debtorId === null) delete ov[orderId]; else ov[orderId] = debtorId;
  localStorage.setItem(COLLECTION_OV_KEY, JSON.stringify(ov));
  kvPut(COLLECTION_OV_KEY, ov);
}
function saveCollectionEdit(orderId, fields) {
  const ed = getCollectionEdits();
  ed[orderId] = { ...(ed[orderId] || {}), ...fields };
  localStorage.setItem(COLLECTION_EDIT_KEY, JSON.stringify(ed));
  kvPut(COLLECTION_EDIT_KEY, ed);
}
function saveCollectionManual(records) {
  localStorage.setItem(COLLECTION_MANUAL_KEY, JSON.stringify(records));
  kvPut(COLLECTION_MANUAL_KEY, records);
}
function addCollectionDeleted(id) {
  const del = getCollectionDeleted();
  if (!del.includes(id)) {
    const next = [...del, id];
    localStorage.setItem(COLLECTION_DELETED_KEY, JSON.stringify(next));
    kvPut(COLLECTION_DELETED_KEY, next);
  }
}
function applyCollectionOv(orders, debtors) {
  const ov      = getCollectionOv();
  const ed      = getCollectionEdits();
  const manual  = getCollectionManual();
  const deleted = getCollectionDeleted();
  const all     = [...orders, ...manual];
  const normName = (s) => String(s || "").replace(/\(.*?\)|\s+|㈜|주식회사/g, "").toLowerCase();
  return all
    .filter(o => !deleted.includes(o.id))
    .map(o => {
      let debtorId = ov[o.id] !== undefined ? ov[o.id] : o.debtorId;
      if (!debtorId) {
        const on = normName(o.debtorName);
        const candidates = debtors.filter(d => normName(d.name) === on);
        const match = candidates.find(d => d.brand === o.brand) || candidates[0] || null;
        debtorId = match?.id || null;
      }
      return { ...o, ...(ed[o.id] || {}), debtorId };
    });
}

// ─── 사건 정보 편집 override (localStorage 영구 저장) ────────
const CASE_FIELD_OV_KEY = "legal_case_field_overrides";
function getCaseFieldOv() { try { return JSON.parse(localStorage.getItem(CASE_FIELD_OV_KEY) || "{}"); } catch { return {}; } }
function saveCaseFieldOv(caseId, fields) {
  const ov = getCaseFieldOv();
  ov[caseId] = { ...ov[caseId], ...fields };
  localStorage.setItem(CASE_FIELD_OV_KEY, JSON.stringify(ov));
  kvPut(CASE_FIELD_OV_KEY, ov);
}
function applyCaseFieldOv(cases) {
  const ov = getCaseFieldOv();
  if (!Object.keys(ov).length) return cases;
  return cases.map(c => ov[c.id] !== undefined ? { ...c, ...ov[c.id] } : c);
}

// ─── 강화된 이름 정규화 (전자소송 피고명용) ────────────────
function normLegalName(raw) {
  return String(raw || "")
    .replace(/외\s*\d+\s*명/g, "")               // "외 N명" 제거
    .replace(/[변개]경전[^:：)]*[:：]\s*[가-힣a-z]+/gi, "") // "변경전:이름", "개명전:이름" 제거
    .replace(/성명\s*[:：]\s*/gi, "")             // "성명:" 제거
    .replace(/\([^)]*\)/g, "")                   // 나머지 괄호 내용 제거
    .replace(/㈜|주식회사|\(주\)/g, "")           // 법인 표기 제거
    .replace(/회생|파산|면책/g, "")
    .replace(/\s+/g, "").toLowerCase().trim();
}

// "변경전:xxx" 에서 이전 이름 추출 → 매칭 후보 확장
function extractPrevNames(raw) {
  const results = [];
  const s = String(raw || "");
  // "(변경전:김성진)", "(개명전:김연길)", "(변경전 : 박현욱)" 등 처리
  for (const m of s.matchAll(/[변개]경전[^:：)]*[:：]\s*([가-힣]{2,6})/g)) {
    const n = normNameForMatch(m[1]);
    if (n) results.push(n);
  }
  return results;
}

// 채무자 인덱스 구축
// - 같은 브랜드 내 동명이인 → 충돌(ambiguous) 처리 → 자동매칭 안 하고 수동 연결 유도
// - "(구 장민철)" 패턴 → byAlias 인덱스로 정확 매칭 (유태걸(구 장민철) 구분용)
// - "김용진95" → "김용진" 숫자 접미사 제거 (낮은 우선순위)
function buildDebtorIndex(debtors) {
  const byBrand = {}, byName = {}, byAlias = {};
  const ambBrand = new Set(), ambName = new Set();

  // 1차: 이름 등록 + 충돌 감지
  debtors.forEach(d => {
    const norm = normNameForMatch(d.name);
    if (!norm) return;
    const bk = `${d.brand}:${norm}`;
    if (byBrand[bk]) ambBrand.add(bk); else byBrand[bk] = d.id;
    if (byName[norm]) ambName.add(norm); else byName[norm] = d.id;

    // "(구 xxx)" 패턴 → alias 인덱스 (구 이름으로도 찾을 수 있게)
    const aliasM = d.name.match(/[\(（]구\s*([가-힣]{2,6})[\)）]/);
    if (aliasM) {
      const an = normNameForMatch(aliasM[1]);
      if (an) {
        if (!byAlias[`${d.brand}:${an}`]) byAlias[`${d.brand}:${an}`] = d.id;
        if (!byAlias[an]) byAlias[an] = d.id;
      }
    }
  });

  // 충돌 항목 제거 (동명이인 → 수동 매칭으로)
  ambBrand.forEach(k => delete byBrand[k]);
  ambName.forEach(k => delete byName[k]);

  // 2차: 숫자 접미사 제거 (김용진95→김용진) — 충돌 감지 포함
  // (기존에는 byName[noNum]이 이미 채워져 있으면 그냥 스킵만 해서, 서로 다른 두 채무자가
  //  같은 noNum으로 축약될 때 먼저 등록된 쪽이 잘못 고착되고 충돌로 표시되지 않았다.)
  const ambNoNum = new Set(), ambBrandNoNum = new Set();
  debtors.forEach(d => {
    const norm = normNameForMatch(d.name);
    const noNum = norm.replace(/\d+$/, "");
    if (!noNum || noNum === norm) return;
    if (!ambName.has(noNum)) {
      if (byName[noNum] && byName[noNum] !== d.id) ambNoNum.add(noNum);
      else if (!byName[noNum]) byName[noNum] = d.id;
    }
    const bk2 = `${d.brand}:${noNum}`;
    if (!ambBrand.has(bk2)) {
      if (byBrand[bk2] && byBrand[bk2] !== d.id) ambBrandNoNum.add(bk2);
      else if (!byBrand[bk2]) byBrand[bk2] = d.id;
    }
  });
  ambNoNum.forEach(k => delete byName[k]);
  ambBrandNoNum.forEach(k => delete byBrand[k]);

  return { byBrand, byName, byAlias };
}

// ─── 전자소송 사건 → 채무자 매칭 ──────────────────────────
function matchLegalCasesToDebtors(cases, debtors) {
  const { byBrand, byName, byAlias } = buildDebtorIndex(debtors);

  const tryMatch = (rawName, brand) => {
    const n1 = normLegalName(rawName);       // 괄호·외N명·변경전 모두 제거
    const n2 = normNameForMatch(rawName);    // 기본 정규화

    // 1. 브랜드+이름 (가장 정확)
    if (brand) {
      const id = byBrand[`${brand}:${n1}`] || byBrand[`${brand}:${n2}`];
      if (id) return id;
    }

    // 2. 브랜드+구이름 — rawName에서 (구 xxx) 추출
    const aliasM = rawName.match(/[\(（]구\s*([가-힣]{2,6})[\)）]/);
    if (aliasM) {
      const an = normNameForMatch(aliasM[1]);
      if (an) {
        const id = (brand ? byAlias[`${brand}:${an}`] : null) || byAlias[an] || null;
        if (id) return id;
      }
    }

    // 3. 브랜드 없이 이름만 (폴백)
    const id3 = byName[n1] || byName[n2];
    if (id3) return id3;

    // 4. 변경전:xxx 이전 이름
    for (const pn of extractPrevNames(rawName)) {
      const id4 = (brand ? byBrand[`${brand}:${pn}`] : null) || byName[pn] || null;
      if (id4) return id4;
    }

    return null;
  };

  return cases.map(c => ({ ...c, debtorId: tryMatch(c.defendant || "", c.brand) }));
}

// ─── 재산명시 → 채무자 매칭 ────────────────────────────────
function matchAssetDisclosuresToDebtors(cases, debtors) {
  const { byBrand, byName, byAlias } = buildDebtorIndex(debtors);

  const tryMatch = (rawName, brand) => {
    const n1 = normLegalName(rawName);
    const n2 = normNameForMatch(rawName);
    const base = (n) => brand ? (byBrand[`${brand}:${n}`] || byName[n] || null) : (byName[n] || null);
    let id = base(n1) || base(n2);
    if (!id) {
      const aliasM = rawName.match(/[\(（]구\s*([가-힣]{2,6})[\)）]/);
      if (aliasM) {
        const an = normNameForMatch(aliasM[1]);
        if (an) id = (brand ? byAlias[`${brand}:${an}`] : null) || byAlias[an] || null;
      }
    }
    return id || null;
  };

  return cases.map(c => {
    const debtorId = tryMatch(c.debtorName || "", c.brand);
    const brand = c.brand || (debtorId ? (debtors.find(x => x.id === debtorId)?.brand || null) : null);
    return { ...c, debtorId, brand };
  });
}

function loadExcelData(cfg) {
  const brandMap = {};
  cfg.brands.forEach(b => { brandMap[b.code] = b; });

  const debtors = EXCEL_DEBTORS.map(d => {
    const brand = brandMap[d.brand] || { code: d.brand, name: d.brand, color: "#64748b" };
    return {
      ...d,
      category: CATEGORY_NORMALIZE[d.category] || d.category,
      brandName: brand.name,
      brandColor: brand.color,
    };
  });

  const allDebtors = [...debtors, ...getMR(MK.debtors)];
  return {
    debtors:          allDebtors,
    payments:         getMR(MK.payments),
    activities:       getMR(MK.activities),
    seizureCases:     [],
    installmentPlans:     getMR(MK.installmentPlans),
    installmentSchedules: [],
    complaints:       getMR(MK.complaints),
    rehabilitations:  applyRehabOverrides([...matchRehabsToDebtors(EXCEL_REHABS, allDebtors),   ...getMR(MK.rehabilitations)]),
    legalCases:       applyCaseFieldOv([...applyLegalOv(matchLegalCasesToDebtors(LEGAL_CASES,               allDebtors), LEGAL_OVERRIDES_KEY), ...getMR(MK.legalCases)]),
    minsaCases:       [...applyLegalOv(matchLegalCasesToDebtors(MINSA_CASES,               allDebtors), MINSA_OVERRIDES_KEY), ...getMR(MK.minsaCases)],
    assetDisclosures:  [...applyLegalOv(matchAssetDisclosuresToDebtors(ASSET_DISCLOSURE_CASES, allDebtors), AD_OVERRIDES_KEY), ...getMR(MK.assetDisclosures)],
    collectionOrders:  applyCollectionOv(COLLECTION_ORDERS, allDebtors),
    forcedExecutions: getMR(MK.forcedExecutions),
    creditAnalyses:   getMR(MK.creditAnalyses),
    negotiations:     getMR(MK.negotiations),
    todoList:         getMR(MK.todoList),
    assigneeTargets:  getMR(MK.assigneeTargets),
  };
}

// ─── Icons ────────────────────────────────────────────────
const I = ({ name, size = 18 }) => {
  const s = {
    dashboard: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>,
    users: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
    calendar: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>,
    won: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4l4 16h1l3-10 3 10h1l4-16"/><line x1="2" y1="10" x2="22" y2="10"/><line x1="2" y1="14" x2="22" y2="14"/></svg>,
    gavel: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2.5l5 5-8 8-5-5z"/><path d="M3 21l3.5-3.5"/><path d="M6.5 17.5l5-5"/><line x1="18" y1="2" x2="22" y2="6"/></svg>,
    activity: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
    settings: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
    search: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
    bell: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>,
    close: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
    check: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>,
    plus: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
    upload: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>,
    edit: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
    trash: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>,
    arrowUp: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>,
    arrowDown:  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>,
    arrowRight: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>,
    back: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>,
    eye: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
    eyeOff: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>,
    userPlus: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>,
    key: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>,
    shield: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
    scale: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="3" x2="12" y2="21"/><path d="M4 9h16"/><path d="M4 9l4 6c0 1.1-.9 2-2 2s-2-.9-2-2l4-6z"/><path d="M20 9l-4 6c0 1.1.9 2 2 2s2-.9 2-2l-4-6z"/></svg>,
    refresh: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>,
    fileText: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>,
    download: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
    sparkles: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M19 3l.75 2.25L22 6l-2.25.75L19 9l-.75-2.25L16 6l2.25-.75z"/><path d="M5 17l.75 2.25L8 20l-2.25.75L5 23l-.75-2.25L2 20l2.25-.75z"/></svg>,
    pieChart: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>,
    flag: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 22V4"/><path d="M4 4h14l-3 4 3 4H4"/></svg>,
  };
  return s[name] || null;
};

// ─── Badges ───────────────────────────────────────────────
const Badge = ({ status, small }) => {
  const c = { "추심진행":{bg:"#eff6ff",t:"#1d4ed8",b:"#bfdbfe"},"추심보류":{bg:"#fef2f2",t:"#b91c1c",b:"#fecaca"},"추심진행중":{bg:"#f1f5f9",t:"#475569",b:"#e2e8f0"},"장기채권":{bg:"#f1f5f9",t:"#475569",b:"#e2e8f0"},"회생파산":{bg:"#faf5ff",t:"#7e22ce",b:"#e9d5ff"},"회생/파산":{bg:"#faf5ff",t:"#7e22ce",b:"#e9d5ff"},"추심의뢰":{bg:"#fffbeb",t:"#b45309",b:"#fde68a"},"대손채권":{bg:"#fef2f2",t:"#991b1b",b:"#fecaca"},"분할상환":{bg:"#eff6ff",t:"#1d4ed8",b:"#bfdbfe"},"협의소송":{bg:"#fff7ed",t:"#c2410c",b:"#fed7aa"},"캐쉬상환":{bg:"#ecfdf5",t:"#047857",b:"#a7f3d0"},"완납":{bg:"#ecfdf5",t:"#047857",b:"#a7f3d0"},"미납":{bg:"#fef2f2",t:"#b91c1c",b:"#fecaca"},"지연":{bg:"#fffbeb",t:"#b45309",b:"#fde68a"},"진행중":{bg:"#eff6ff",t:"#1d4ed8",b:"#bfdbfe"},"진행":{bg:"#eff6ff",t:"#1d4ed8",b:"#bfdbfe"},"완료":{bg:"#ecfdf5",t:"#047857",b:"#a7f3d0"},"중단":{bg:"#fef2f2",t:"#b91c1c",b:"#fecaca"},"결정":{bg:"#eff6ff",t:"#1d4ed8",b:"#bfdbfe"},"송달완료":{bg:"#ecfdf5",t:"#047857",b:"#a7f3d0"},"추심중":{bg:"#fffbeb",t:"#b45309",b:"#fde68a"},"배당완료":{bg:"#ecfdf5",t:"#047857",b:"#a7f3d0"},"취하":{bg:"#f1f5f9",t:"#475569",b:"#e2e8f0"},"각하":{bg:"#fef3c7",t:"#92400e",b:"#fde68a"},"회생":{bg:"#faf5ff",t:"#7e22ce",b:"#e9d5ff"},"파산/면책":{bg:"#fef2f2",t:"#b91c1c",b:"#fecaca"},"수사중":{bg:"#fffbeb",t:"#b45309",b:"#fde68a"},"기소":{bg:"#fef2f2",t:"#b91c1c",b:"#fecaca"},"불기소":{bg:"#f1f5f9",t:"#475569",b:"#e2e8f0"},"사기":{bg:"#fef2f2",t:"#b91c1c",b:"#fecaca"},"횡령":{bg:"#faf5ff",t:"#7e22ce",b:"#e9d5ff"},"지급명령":{bg:"#eff6ff",t:"#1d4ed8",b:"#bfdbfe"},"압류":{bg:"#faf5ff",t:"#7e22ce",b:"#e9d5ff"},"재산명시":{bg:"#fff7ed",t:"#c2410c",b:"#fed7aa"},"민사소송":{bg:"#f0fdf4",t:"#166534",b:"#bbf7d0"},"채권자":{bg:"#eff6ff",t:"#1d4ed8",b:"#bfdbfe"},"원고":{bg:"#eff6ff",t:"#1d4ed8",b:"#bfdbfe"},"피고":{bg:"#fef2f2",t:"#b91c1c",b:"#fecaca"},"미연결":{bg:"#f1f5f9",t:"#64748b",b:"#e2e8f0"} }[status] || {bg:"#f1f5f9",t:"#475569",b:"#e2e8f0"};
  return <span style={{display:"inline-flex",alignItems:"center",padding:small?"1px 6px":"2px 10px",borderRadius:20,fontSize:small?10:11,fontWeight:600,background:c.bg,color:c.t,border:`1px solid ${c.b}`}}>{status}</span>;
};
const BrandBadge = ({ code, brands }) => {
  const b = (brands || DEFAULT_CONFIG.brands).find(x => x.code === code) || { code, name: code, color: "#64748b" };
  return <span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:22,height:22,borderRadius:6,fontSize:11,fontWeight:700,background:`${b.color}18`,color:b.color,border:`1px solid ${b.color}40`}}>{code}</span>;
};

// ─── Form Field Components ────────────────────────────────
const Field = ({ label, children, span }) => (
  <div style={{ gridColumn: span ? `span ${span}` : undefined }}>
    <div style={{ fontSize: 11, color: "var(--tm)", marginBottom: 4, fontWeight: 500 }}>{label}</div>
    {children}
  </div>
);
const inp = { width: "100%", padding: "8px 10px", fontSize: 13 };

// App() 내부에 중첩 정의된 "XxxView" 컴포넌트(예: PaymentsView, LegalView 등)를
// <XxxView/>처럼 JSX로 렌더링하면, App이 리렌더링될 때마다(예: 한 글자 타이핑할 때마다)
// 매번 새 함수 레퍼런스가 되어 React가 그 컴포넌트를 완전히 마운트 해제 후 재마운트한다.
// 이 과정에서 하위 입력 필드의 DOM이 통째로 교체되어 포커스/커서 위치가 초기화되고,
// 한글 입력 중 글자 순서가 뒤섞이는 등의 버그가 발생한다 (원인: KoreanInput이 아니라 이 재마운트).
// 이 훅은 컴포넌트의 "정체성"(레퍼런스)만 useRef로 고정해서 재마운트를 막고,
// 그 안의 최신 클로저(내부에서 쓰는 data/config/currentUser 등)는 매 렌더마다 갈아끼운다 —
// 내부에서 쓰는 useState/useEffect/useMemo는 그대로 유지되며 Rules of Hooks도 위반하지 않는다.
function useStableComponent(render) {
  const renderRef = useRef(render);
  renderRef.current = render;
  const componentRef = useRef((props) => renderRef.current(props));
  return componentRef.current;
}

// 한글 IME 버그 방지 — uncontrolled + ref 방식으로 React가 DOM value를 건드리지 않게 함
// controlled input(value prop)은 조합 중 React가 value attribute를 덮어써서 IME를 끊어버림
const KoreanInput = ({ value, onChange, ...rest }) => {
  const ref = useRef(null);
  const composing = useRef(false);
  useEffect(() => {
    if (ref.current && !composing.current && ref.current.value !== (value ?? ""))
      ref.current.value = value ?? "";
  }, [value]);
  return (
    <input
      ref={ref}
      {...rest}
      defaultValue={value ?? ""}
      onChange={e => { if (!composing.current && onChange) onChange(e); }}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={e => { composing.current = false; if (onChange) onChange(e); }}
    />
  );
};
const KoreanTextarea = ({ value, onChange, ...rest }) => {
  const ref = useRef(null);
  const composing = useRef(false);
  useEffect(() => {
    if (ref.current && !composing.current && ref.current.value !== (value ?? ""))
      ref.current.value = value ?? "";
  }, [value]);
  return (
    <textarea
      ref={ref}
      {...rest}
      defaultValue={value ?? ""}
      onChange={e => { if (!composing.current && onChange) onChange(e); }}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={e => { composing.current = false; if (onChange) onChange(e); }}
    />
  );
};

// 천단위 쉼표 금액 입력 컴포넌트
// value: 숫자 문자열 (쉼표 없음), onChange: raw 숫자 문자열 반환 → Number() 그대로 사용 가능
const MoneyInput = ({ value, onChange, style, placeholder }) => {
  const display = value !== "" && value !== undefined && !isNaN(Number(value)) && value !== null
    ? Number(value).toLocaleString("ko-KR")
    : (value || "");
  return (
    <input
      value={display}
      onChange={e => { const raw = e.target.value.replace(/[^0-9]/g, ""); onChange(raw); }}
      inputMode="numeric"
      style={style}
      placeholder={placeholder || ""}
    />
  );
};

// ─── Autocomplete Component ──────────────────────────────
const AutoComplete = ({ value, onChange, options, placeholder, displayFn, style: extraStyle }) => {
  const [text, setText] = useState(displayFn ? (displayFn(value) || "") : (value || ""));
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const ref = useRef(null);
  useEffect(() => { setText(displayFn ? (displayFn(value) || "") : (value || "")); }, [value]);
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);
  const filtered = options.filter(o => {
    const label = displayFn ? displayFn(o) : String(o);
    return label.toLowerCase().includes(text.toLowerCase());
  });
  return (
    <div ref={ref} style={{ position: "relative", ...extraStyle }}>
      <KoreanInput
        value={text}
        onChange={e => { setText(e.target.value); setOpen(true); }}
        onFocus={() => { setOpen(true); setFocused(true); }}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        style={inp}
      />
      {open && filtered.length > 0 && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, maxHeight: 180, overflow: "auto", background: "var(--card)", border: "1px solid var(--brd)", borderRadius: 8, marginTop: 2, zIndex: 100, boxShadow: "0 4px 16px rgba(0,0,0,.1)" }}>
          {filtered.map((o, i) => {
            const label = displayFn ? displayFn(o) : String(o);
            return (
              <div key={i} onClick={() => { onChange(o); setText(label); setOpen(false); }}
                style={{ padding: "8px 12px", fontSize: 13, cursor: "pointer", borderBottom: i < filtered.length - 1 ? "1px solid var(--brd)" : "none" }}
                onMouseEnter={e => e.currentTarget.style.background = "var(--hover)"}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                {label}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
const DebtorAutoComplete = ({ value, onChange, debtors, brands, nameOnly = false }) => {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const selected = debtors.find(d => d.id === value);
  const label = (d) => nameOnly ? d.name : `${d.brandName} / ${d.name} (${d.id})`;
  useEffect(() => { if (selected) setText(label(selected)); }, [value]);
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);
  const filtered = debtors.filter(d => {
    const q = text.toLowerCase();
    return (d.name || "").toLowerCase().includes(q) || (d.id || "").toLowerCase().includes(q) || (d.hubName || "").toLowerCase().includes(q) || (d.brandName || "").toLowerCase().includes(q);
  }).slice(0, 20);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <KoreanInput value={text} onChange={e => { setText(e.target.value); setOpen(true); if (!e.target.value) onChange(""); }} onFocus={() => setOpen(true)} placeholder="채무자명, ID, 허브명으로 검색..." style={inp} />
      {open && filtered.length > 0 && (
        // minWidth: 좁은 칸(예: 주요 협의 대상자 테이블) 안에 있을 때도 목록이 트리거 입력창
        // 폭만큼 눌려서 항목이 겹치거나 클릭하기 어려워지지 않도록 최소 폭을 보장
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, minWidth: 280, maxHeight: 220, overflow: "auto", background: "var(--card)", border: "1px solid var(--brd)", borderRadius: 8, marginTop: 2, zIndex: 100, boxShadow: "0 4px 16px rgba(0,0,0,.1)" }}>
          {filtered.map(d => (
            <div key={d.id} onClick={() => { onChange(d.id); setText(label(d)); setOpen(false); }}
              style={{ padding: "8px 12px", fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid var(--brd)" }}
              onMouseEnter={e => e.currentTarget.style.background = "var(--hover)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <BrandBadge code={d.brand} brands={brands} />
              <span style={{ fontWeight: 500 }}>{d.name}</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--tm)" }}>{d.id}</span>
              <span style={{ fontSize: 11, color: "var(--ts)" }}>{d.hubName}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Rematch Modal (module-level to prevent state reset on parent re-render) ──
const RematchModalStandalone = ({ pay, debtors, brands, onClose, onReload, showToast }) => {
  const [newDebtorId, setNewDebtorId] = useState("");
  const [saving, setSaving] = useState(false);
  const currentDebtor = debtors.find(d => d.id === pay?.debtorId);
  const selectedNewDebtor = debtors.find(d => d.id === newDebtorId);
  const doRematch = async () => {
    if (!newDebtorId) { showToast("새 채무자를 선택하세요"); return; }
    setSaving(true);
    try {
      const r = await fetch("/api/payments/" + pay.id + "/rematch", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newDebtorId, userName: "관리자" }),
      });
      const result = await r.json();
      if (!result.ok) { showToast(result.error || "재매칭 실패"); setSaving(false); return; }
      await onReload();
      showToast(`재매칭 완료: ${result.oldDebtorName} → ${result.newDebtorName}`);
      onClose();
    } catch (e) { showToast("재매칭 실패: " + (e.message || "네트워크 오류")); setSaving(false); }
  };
  return (
    <Overlay onClose={onClose}>
      <ModalHeader title="입금 재매칭" onClose={onClose} />
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ background: "var(--bg2)", borderRadius: 10, padding: "12px 14px", fontSize: 13 }}>
          <div style={{ marginBottom: 6, color: "var(--tm)", fontWeight: 600, fontSize: 11 }}>현재 매칭 정보</div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <span><span style={{ color: "var(--tm)" }}>입금일:</span> {fmtDate(pay?.paymentDate)}</span>
            <span><span style={{ color: "var(--tm)" }}>금액:</span> <b>{fmt(pay?.totalAmount)}</b></span>
            <span><span style={{ color: "var(--tm)" }}>입금자:</span> {pay?.payerName || "-"}</span>
          </div>
          <div style={{ marginTop: 8 }}>
            <span style={{ color: "var(--tm)" }}>현재 채무자: </span>
            <b style={{ color: "#ef4444" }}>{currentDebtor?.name || pay?.debtorName}</b>
            <span style={{ color: "var(--tm)", marginLeft: 4, fontSize: 11 }}>({pay?.debtorId})</span>
          </div>
        </div>
        <Field label="새 채무자 선택">
          <DebtorAutoComplete value={newDebtorId} onChange={setNewDebtorId} debtors={debtors} brands={brands} />
        </Field>
        {selectedNewDebtor && (
          <div style={{ background: "#10b98112", border: "1px solid #10b98140", borderRadius: 8, padding: "8px 12px", fontSize: 12, color: "#10b981", display: "flex", alignItems: "center", gap: 6 }}>
            <b>선택됨:</b> {selectedNewDebtor.name} <span style={{ color: "var(--tm)", fontSize: 11 }}>({selectedNewDebtor.id}) · {selectedNewDebtor.hubName}</span>
          </div>
        )}
      </div>
      <ModalFooter onCancel={onClose} onSave={doRematch} saveLabel={saving ? "처리중…" : "재매칭"} />
    </Overlay>
  );
};

// ─── RolloverModal ────────────────────────────────────────
const RolloverModal = ({ sched, onClose, onReload, showToast }) => {
  const [newDate, setNewDate] = useState("");
  const [memo, setMemo] = useState("");
  const [saving, setSaving] = useState(false);
  const doRollover = async () => {
    if (!newDate) { showToast("이월 날짜를 선택하세요"); return; }
    setSaving(true);
    try {
      const r = await fetch(`/api/installments/schedules/${sched.id}/rollover`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newDate, memo, userName: "관리자" }),
      });
      const result = await r.json();
      if (!result.ok) { showToast(result.error || "이월 실패"); setSaving(false); return; }
      await onReload();
      const [, m, d] = newDate.split("-");
      showToast(`이월 완료 → ${parseInt(m)}월 ${parseInt(d)}일`);
      onClose();
    } catch(e) { showToast("이월 실패: " + (e.message || "네트워크 오류")); setSaving(false); }
  };
  const todayStr = new Date().toISOString().slice(0, 10);
  return (
    <Overlay onClose={onClose}>
      <ModalHeader title="납부일 이월" onClose={onClose} />
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ background: "var(--bg2)", borderRadius: 10, padding: "12px 14px", fontSize: 13 }}>
          <div style={{ marginBottom: 6, color: "var(--tm)", fontWeight: 600, fontSize: 11 }}>현재 납부 일정</div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
            <span><span style={{ color: "var(--tm)" }}>채무자:</span> <b>{sched?.debtorName}</b></span>
            <span><span style={{ color: "var(--tm)" }}>예정일:</span> <b className="mono">{sched?.dueDate || sched?.dueMonth}</b></span>
            <span><span style={{ color: "var(--tm)" }}>금액:</span> <b className="mono" style={{ color: "var(--acc)" }}>{fmt(sched?.scheduledAmount)}</b></span>
          </div>
        </div>
        <Field label="이월 날짜 (필수)">
          <input type="date" value={newDate} onChange={e => setNewDate(e.target.value)} min={todayStr} style={{ ...inp, border: "1px solid var(--brd)", borderRadius: 6, background: "var(--bg)", color: "var(--tp)" }} />
        </Field>
        <Field label="메모 (채무자와 통화 내용 등)">
          <KoreanInput value={memo} onChange={e => setMemo(e.target.value)} placeholder="예: 월급 후 3일 뒤 입금하겠다고 함" style={{ ...inp, border: "1px solid var(--brd)", borderRadius: 6, background: "var(--bg)", color: "var(--tp)" }} />
        </Field>
        {newDate && (
          <div style={{ background: "#8b5cf610", border: "1px solid #8b5cf640", borderRadius: 8, padding: "8px 12px", fontSize: 12, color: "#7c3aed" }}>
            기존 일정은 <b>이월</b> 처리되고, <b>{newDate}</b>에 새 납부 일정이 생성됩니다.
          </div>
        )}
      </div>
      <ModalFooter onCancel={onClose} onSave={doRollover} saveLabel={saving ? "처리중…" : "이월 처리"} />
    </Overlay>
  );
};

// ─── Modal Overlay ────────────────────────────────────────
const Overlay = ({ children, onClose, wide }) => (
  <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1e3 }} onClick={onClose}>
    <div className="anim" onClick={e => e.stopPropagation()} style={{ background: "var(--card)", borderRadius: 16, width: wide ? 720 : 560, maxHeight: "85vh", overflow: "auto", padding: 24, border: "1px solid var(--brd)" }}>{children}</div>
  </div>
);
const KO_DAYS = ["일", "월", "화", "수", "목", "금", "토"];
const pad2 = n => String(n).padStart(2, "0");
function HeaderClock({ currentUser, lastSaved }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const dateStr = `${now.getFullYear()}-${pad2(now.getMonth()+1)}-${pad2(now.getDate())} (${KO_DAYS[now.getDay()]})`;
  const timeStr = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  const savedStr = lastSaved ? (() => {
    const sameDay = lastSaved.getFullYear() === now.getFullYear() && lastSaved.getMonth() === now.getMonth() && lastSaved.getDate() === now.getDate();
    const t = `${pad2(lastSaved.getHours())}:${pad2(lastSaved.getMinutes())}:${pad2(lastSaved.getSeconds())}`;
    return sameDay ? t : `${lastSaved.getMonth()+1}/${pad2(lastSaved.getDate())} ${t}`;
  })() : "-";
  return (
    <div style={{ textAlign: "right" }}>
      <div style={{ fontSize: 12, fontWeight: 600, fontVariantNumeric: "tabular-nums", fontFamily: "monospace", color: "var(--tp)", lineHeight: "1.4" }}>{dateStr}&nbsp;&nbsp;{timeStr}</div>
      <div style={{ fontSize: 11, color: "var(--tm)", lineHeight: "1.4" }}>
        <span style={{ fontWeight: 600, color: "var(--ts)" }}>{currentUser.name}</span>
        <span style={{ margin: "0 6px", opacity: 0.4 }}>|</span>
        마지막 갱신&nbsp;<span style={{ fontFamily: "monospace", fontVariantNumeric: "tabular-nums" }}>{savedStr}</span>
      </div>
    </div>
  );
}

const ModalHeader = ({ title, onClose }) => (
  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 20 }}>
    <div style={{ fontSize: 16, fontWeight: 700 }}>{title}</div>
    <button onClick={onClose} style={{ background: "none", color: "var(--tm)" }}><I name="close" size={18} /></button>
  </div>
);
const ModalFooter = ({ onCancel, onSave, saveLabel }) => (
  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}>
    <button onClick={onCancel} style={{ padding: "8px 20px", borderRadius: 8, fontSize: 13, background: "var(--bg)", color: "var(--tm)", border: "1px solid var(--brd)" }}>취소</button>
    <button onClick={onSave} style={{ padding: "8px 20px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: "var(--acc)", color: "#fff" }}>{saveLabel || "저장"}</button>
  </div>
);

// ─── Permissions ──────────────────────────────────────────
const ROLES = [
  { key: "admin",   label: "관리자", desc: "모든 데이터 삭제/추가/편집/읽기 + 사용자 관리" },
  { key: "manager", label: "매니저", desc: "본인 데이터 삭제/편집, 전체 추가/읽기 가능" },
  { key: "member",  label: "구성원", desc: "데이터 읽기만 가능" },
];
const PERM_MAP = {
  admin:   { view: true, edit: true, delete: true,  admin: true },
  manager: { view: true, edit: true, delete: false, admin: false },
  member:  { view: true, edit: false, delete: false, admin: false },
};

// ─── User Store ────────────────────────────────────────────
const APP_USERS_KEY = "app_users";
const DEFAULT_USERS = [
  { id: "U002", name: "배현진", email: "hjbae@barogo.com", avatar: "배", role: "admin", approved: true, registeredAt: "2026-06-10", password: "hj12345!" },
  { id: "U003", name: "김준원", email: "kimjw@barogo.com", avatar: "김", role: "manager", approved: true, registeredAt: "2026-06-10", password: "0000" },
  { id: "U004", name: "조혜원", email: "chohw1997@barogo.com", avatar: "조", role: "manager", approved: true, registeredAt: "2026-06-10", password: "0000" },
  { id: "U005", name: "장덕진", email: "djjang_bu@barogo.com", avatar: "장", role: "manager", approved: true, registeredAt: "2026-06-10", password: "0000" },
  { id: "U006", name: "유재선", email: "jsyoo6708@barogo.com", avatar: "유", role: "manager", approved: true, registeredAt: "2026-06-10", password: "0000" },
];

// ─── Default Alert Rules ──────────────────────────────────
const DEFAULT_ALERT_RULES = [
  { id: "rule1", name: "분할상환 미납", enabled: true, trigger: "installment_overdue", condition: "미납 1회 이상", target: "channel", channel: "#npl-알림", assignee: "" },
  { id: "rule2", name: "회생 변제금 미납", enabled: true, trigger: "rehab_overdue", condition: "미납 상태", target: "channel", channel: "#npl-알림", assignee: "" },
  { id: "rule3", name: "고액 잔액", enabled: true, trigger: "high_balance", condition: "잔액 1,000만원 초과", target: "dm", channel: "", assignee: "준원" },
  { id: "rule4", name: "신규 입금", enabled: false, trigger: "new_payment", condition: "입금 등록 시", target: "channel", channel: "#npl-입금", assignee: "" },
  { id: "rule5", name: "장기 미연락", enabled: false, trigger: "no_contact", condition: "30일 이상 활동 없음", target: "dm", channel: "", assignee: "" },
];
const TRIGGER_TYPES = [
  { key: "installment_overdue", label: "분할상환 미납" },
  { key: "rehab_overdue", label: "회생 변제금 미납" },
  { key: "high_balance", label: "고액 잔액 (1,000만원 초과)" },
  { key: "new_payment", label: "신규 입금 등록" },
  { key: "no_contact", label: "장기 미연락 (30일)" },
  { key: "status_change", label: "추심상태 변경" },
  { key: "new_debtor", label: "신규 채권 등록" },
  { key: "seizure_collected", label: "압류 회수 발생" },
];

// ─── Brand Logo ───────────────────────────────────────────
const BrandLogo = ({ size = 32 }) => (
  <svg width={size} height={size} viewBox="0 0 40 40">
    <rect width="40" height="40" rx="9" fill="#241b4d" />
    <circle cx="20" cy="9" r="2" fill="#fff" />
    <line x1="20" y1="11" x2="20" y2="30" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    <line x1="9" y1="13" x2="31" y2="13" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    <line x1="9" y1="13" x2="9" y2="21" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    <line x1="31" y1="13" x2="31" y2="21" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    <path d="M4 21 a5 5 0 0 0 10 0 Z" fill="#f97316" />
    <path d="M26 21 a5 5 0 0 0 10 0 Z" fill="#f97316" />
    <line x1="13" y1="30" x2="27" y2="30" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

const BrandWordmark = ({ fontSize = 22 }) => (
  <div style={{ fontSize, fontWeight: 900, letterSpacing: -0.5 }}>
    <span style={{ color: "#f97316" }}>바</span>
    <span style={{ color: "#8b5cf6" }}>모</span>
    <span style={{ color: "#241b4d" }}>딜</span>
    <span style={{ color: "#111" }}> CMS</span>
  </div>
);

// ─── Login Screen ─────────────────────────────────────────
const LoginScreen = ({ onLogin, loginError }) => {
  const [id, setId]       = useState("");
  const [pw, setPw]       = useState("");
  const [showPw, setShowPw] = useState(false);
  const doLogin = () => onLogin(id, pw);
  const brd = loginError ? "var(--err)" : "var(--brd)";
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "var(--bg)", fontFamily: "'Noto Sans KR', sans-serif" }}>
      <div className="anim" style={{ background: "var(--card)", borderRadius: 20, padding: 48, width: 400, border: "1px solid var(--brd)", boxShadow: "0 8px 40px rgba(0,0,0,.08)" }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 8 }}>
            <BrandLogo size={44} />
            <BrandWordmark fontSize={28} />
          </div>
          <div style={{ fontSize: 12, color: "var(--tm)" }}>NPL 채권관리 시스템</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div style={{ fontSize: 12, color: "var(--tm)", marginBottom: 5, fontWeight: 500 }}>이름 또는 이메일</div>
            <KoreanInput value={id} onChange={e => setId(e.target.value)} placeholder="이름 또는 이메일 주소"
              style={{ width: "100%", padding: "11px 13px", borderRadius: 10, fontSize: 14, border: `1px solid ${brd}`, background: "var(--bg)", color: "var(--tp)", boxSizing: "border-box" }}
              onKeyDown={e => e.key === "Enter" && doLogin()} />
          </div>
          <div>
            <div style={{ fontSize: 12, color: "var(--tm)", marginBottom: 5, fontWeight: 500 }}>비밀번호</div>
            <div style={{ position: "relative" }}>
              <KoreanInput value={pw} type={showPw ? "text" : "password"} onChange={e => setPw(e.target.value)} placeholder="비밀번호"
                style={{ width: "100%", padding: "11px 40px 11px 13px", borderRadius: 10, fontSize: 14, border: `1px solid ${brd}`, background: "var(--bg)", color: "var(--tp)", boxSizing: "border-box" }}
                onKeyDown={e => e.key === "Enter" && doLogin()} />
              <button onClick={() => setShowPw(p => !p)} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--tm)", padding: 4 }}>
                <I name={showPw ? "eyeOff" : "eye"} size={16} />
              </button>
            </div>
          </div>
          {loginError && <div style={{ fontSize: 12, color: "var(--err)", padding: "8px 12px", background: "#fef2f2", borderRadius: 8, border: "1px solid #fecaca" }}>{loginError}</div>}
          <button onClick={doLogin} style={{ width: "100%", padding: "13px 0", borderRadius: 10, fontSize: 15, fontWeight: 700, background: "var(--acc)", color: "#fff", border: "none", cursor: "pointer", marginTop: 4 }}>로그인</button>
        </div>
        <div style={{ fontSize: 11, color: "var(--tm)", marginTop: 20, textAlign: "center" }}>접근 권한이 필요하면 관리자에게 문의하세요</div>
      </div>
    </div>
  );
};

const PendingScreen = ({ user, onLogout }) => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "var(--bg)", fontFamily: "'Noto Sans KR', sans-serif" }}>
    <div className="anim" style={{ background: "var(--card)", borderRadius: 20, padding: 48, width: 420, textAlign: "center", border: "1px solid var(--brd)" }}>
      <div style={{ width: 60, height: 60, borderRadius: 30, background: "#f59e0b18", color: "#f59e0b", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, fontWeight: 700, margin: "0 auto 16px" }}>{user.avatar}</div>
      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>{user.name}</div>
      <div style={{ fontSize: 12, color: "var(--tm)", marginBottom: 24 }}>{user.email}</div>
      <div style={{ padding: "12px 20px", background: "#f59e0b18", borderRadius: 10, fontSize: 14, color: "#b45309", fontWeight: 500, marginBottom: 24 }}>관리자 승인 대기 중입니다</div>
      <div style={{ fontSize: 12, color: "var(--tm)", marginBottom: 20 }}>관리자가 승인하면 시스템을 이용할 수 있습니다.</div>
      <button onClick={onLogout} style={{ padding: "8px 24px", borderRadius: 8, fontSize: 13, background: "var(--bg)", color: "var(--tm)", border: "1px solid var(--brd)" }}>로그아웃</button>
    </div>
  </div>
);

// ─── SlackIngestView (모듈 레벨 — App 내부 정의 시 매 렌더마다 리마운트되어 state 초기화되는 문제 방지)
function SlackIngestView({ showToast, reloadFromBackend, currentUser, isAdmin }) {
  const [text, setText] = useState("");
  const [msgDate, setMsgDate] = useState(today());
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [botStatus, setBotStatus] = useState(null);
  const [polling, setPolling] = useState(false);

  const loadBotStatus = async () => {
    try {
      const res = await fetch("/api/slack/status");
      setBotStatus(await res.json());
    } catch (e) { /* 백엔드 다운 시 무시 */ }
  };
  useEffect(() => { loadBotStatus(); const t = setInterval(loadBotStatus, 15000); return () => clearInterval(t); }, []);

  const doPollNow = async () => {
    if (!confirm("지금 즉시 Slack 채널을 폴링해서 새 메시지를 가져올까요?")) return;
    setPolling(true);
    try {
      const res = await fetch("/api/slack/poll-now", { method: "POST" });
      const data = await res.json();
      setBotStatus(data.status);
      if (data.ok) {
        showToast(`폴링 완료: ${data.fetched}개 메시지 / 입금 ${data.success}건 적재 / 대기 ${data.pending}건`);
        if (data.success > 0 || data.pending > 0) await reloadFromBackend();
      } else {
        showToast(`폴링 실패: ${data.error}`);
      }
    } catch (e) { showToast(`오류: ${e.message}`); }
    setPolling(false);
  };

  const doPreview = async () => {
    if (!text.trim()) { showToast("Slack 텍스트를 붙여넣으세요"); return; }
    setLoading(true);
    try {
      const res = await fetch("/api/slack/preview", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, messageDate: msgDate }),
      });
      setPreview(await res.json());
    } catch (e) { showToast(`미리보기 실패: ${e.message}`); }
    setLoading(false);
  };

  const doIngest = async () => {
    if (!preview || preview.entries.length === 0) return;
    if (!confirm(`${preview.entries.length}건을 DB에 적재합니다. 잔액이 자동 차감됩니다. 계속할까요?`)) return;
    setLoading(true);
    try {
      const res = await fetch("/api/slack/ingest", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, messageDate: msgDate, createdByName: currentUser?.name }),
      });
      const data = await res.json();
      const merged = { ...preview, entries: data.results, summary: data.summary, ingested: true };
      setPreview(merged);
      await reloadFromBackend();
      showToast(`Slack 적재: 성공 ${data.summary.success}건 / 대기열 ${data.summary.pending}건 / 오류 ${data.summary.error}건`);
      setText("");
    } catch (e) { showToast(`적재 실패: ${e.message}`); }
    setLoading(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* ━━━━━ Slack 봇 상태 카드 ━━━━━ */}
      <div style={{ background: "var(--card)", borderRadius: 12, padding: 20, border: "1px solid var(--brd)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>🤖 Slack 봇 상태</div>
          {isAdmin && <button onClick={doPollNow} disabled={polling || !botStatus?.enabled} style={{ padding: "6px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: botStatus?.enabled ? "var(--acc)" : "var(--bg)", color: botStatus?.enabled ? "#fff" : "var(--tm)", opacity: polling || !botStatus?.enabled ? 0.5 : 1 }}>
            {polling ? "폴링중..." : "🔄 지금 폴링"}
          </button>}
        </div>
        {!botStatus ? (
          <div style={{ fontSize: 12, color: "var(--tm)" }}>상태 조회 중...</div>
        ) : !botStatus.enabled ? (
          <div style={{ padding: 12, background: "#fef2f2", borderRadius: 8, fontSize: 12, color: "#b91c1c" }}>
            ⚠️ <b>Slack 봇 비활성화</b> — backend/.env 파일에 SLACK_BOT_TOKEN과 SLACK_CHANNEL_ID를 설정한 후 백엔드를 재시작하세요.
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, fontSize: 12 }}>
            <div style={{ padding: 10, background: "var(--bg)", borderRadius: 8 }}>
              <div style={{ color: "var(--tm)", fontSize: 11, marginBottom: 4 }}>연결 상태</div>
              <div style={{ fontWeight: 600, color: botStatus.connected ? "var(--ok)" : "var(--err)" }}>
                {botStatus.connected ? `✓ ${botStatus.botName ? "@" + botStatus.botName : ""}` : "✗ 인증 실패"}
              </div>
              {botStatus.team && <div style={{ fontSize: 10, color: "var(--tm)", marginTop: 2 }}>{botStatus.team}</div>}
            </div>
            <div style={{ padding: 10, background: "var(--bg)", borderRadius: 8 }}>
              <div style={{ color: "var(--tm)", fontSize: 11, marginBottom: 4 }}>마지막 폴링</div>
              <div className="mono" style={{ fontWeight: 600, fontSize: 11 }}>
                {botStatus.lastPollAt ? new Date(botStatus.lastPollAt).toLocaleString("ko-KR") : "아직 없음"}
              </div>
              <div style={{ fontSize: 10, color: "var(--tm)", marginTop: 2 }}>{botStatus.pollIntervalMinutes}분 간격</div>
            </div>
            <div style={{ padding: 10, background: "var(--bg)", borderRadius: 8 }}>
              <div style={{ color: "var(--tm)", fontSize: 11, marginBottom: 4 }}>누적 적재</div>
              <div className="mono" style={{ fontWeight: 600, color: "var(--acc)" }}>{botStatus.totalPaymentsIngested || 0}건</div>
              <div style={{ fontSize: 10, color: "var(--tm)", marginTop: 2 }}>대기열 {botStatus.totalPending || 0}건</div>
            </div>
            <div style={{ padding: 10, background: "var(--bg)", borderRadius: 8 }}>
              <div style={{ color: "var(--tm)", fontSize: 11, marginBottom: 4 }}>마지막 결과</div>
              <div style={{ fontWeight: 600, fontSize: 11 }}>
                {botStatus.lastError ? <span style={{ color: "var(--err)" }}>오류: {botStatus.lastError}</span>
                  : botStatus.lastPollResult ? <span>메시지 {botStatus.lastPollResult.fetched}/입금 {botStatus.lastPollResult.success}</span>
                  : <span style={{ color: "var(--tm)" }}>—</span>}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ━━━━━ 수동 텍스트 붙여넣기 (백업/데모용) ━━━━━ */}
      <div style={{ background: "var(--card)", borderRadius: 12, padding: 20, border: "1px solid var(--brd)" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Slack 메시지 텍스트 붙여넣기 (수동)</div>
        <div style={{ fontSize: 11, color: "var(--tm)", marginBottom: 12, lineHeight: 1.5 }}>
          📌 <b>#입금내역_공유방</b>의 메시지 한 건을 통째로 복사해서 아래에 붙여넣으세요.<br />
          📌 메시지에 <b>국민#1812</b> 헤더가 포함된 경우에만 입금건으로 채택됩니다 (법무실 추심 계좌).<br />
          📌 IT팀에서 Slack 봇 설치 완료되면 이 작업이 자동으로 수행됩니다 — 지금은 데모입니다.
        </div>
        <KoreanTextarea
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder={"예시:\n국민#1812\n05/20\n서병택   500,000\n주식회사 슈퍼메이커   247,940"}
          style={{ width: "100%", minHeight: 180, fontFamily: "'JetBrains Mono', monospace", fontSize: 13, padding: 12, resize: "vertical" }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
          <label style={{ fontSize: 12, color: "var(--tm)" }}>메시지 발송일:</label>
          <input type="date" value={msgDate} onChange={e => setMsgDate(e.target.value)} style={{ width: 160, fontSize: 12 }} />
          <button onClick={doPreview} disabled={loading} style={{ padding: "8px 16px", borderRadius: 8, background: "var(--acc)", color: "#fff", fontSize: 12, fontWeight: 600, opacity: loading ? 0.5 : 1 }}>
            {loading ? "처리중..." : "① 미리보기"}
          </button>
          {preview && !preview.ingested && preview.entries.length > 0 && (
            <button onClick={doIngest} disabled={loading} style={{ padding: "8px 16px", borderRadius: 8, background: "var(--ok)", color: "#fff", fontSize: 12, fontWeight: 600 }}>
              ② DB에 적재 ({preview.entries.length}건)
            </button>
          )}
        </div>
      </div>

      {preview && (
        <div style={{ background: "var(--card)", borderRadius: 12, padding: 20, border: "1px solid var(--brd)" }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
            {preview.ingested ? "✅ 적재 결과" : "🔍 미리보기 결과"}
            {preview.summary && (
              <span style={{ fontSize: 12, fontWeight: 400, color: "var(--tm)", marginLeft: 8 }}>
                (총 {preview.summary.total}건
                {preview.summary.matched !== undefined ? ` / 매칭 ${preview.summary.matched} / 미매칭 ${preview.summary.unmatched}` : ""}
                {preview.summary.success !== undefined ? ` / 성공 ${preview.summary.success} / 대기열 ${preview.summary.pending}` : ""})
              </span>
            )}
          </div>
          {preview.meta && !preview.meta.hasKookminHeader && (
            <div style={{ padding: 10, background: "#fef2f2", color: "#b91c1c", borderRadius: 6, fontSize: 12, marginBottom: 10 }}>
              ⚠️ <b>국민#1812</b> 헤더가 텍스트 안에 없습니다. 모든 입금 라인이 무시됐어요. 헤더를 포함시켜 주세요.
            </div>
          )}
          {preview.meta?.deactivatedByHeader && (
            <div style={{ padding: 10, background: "#fffbeb", color: "#b45309", borderRadius: 6, fontSize: 12, marginBottom: 10 }}>
              ℹ️ "{preview.meta.deactivatedByHeader}" 헤더 이후 입금은 다른 계좌로 간주되어 채택되지 않았습니다.
            </div>
          )}
          {preview.entries.length > 0 ? (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "var(--bg2)" }}>
                    {["입금일", "입금자", "금액", "매칭 채무자", "결과"].map(h => (
                      <th key={h} style={{ padding: "8px 10px", textAlign: "left", fontSize: 11, color: "var(--tm)", fontWeight: 600, borderBottom: "1px solid var(--brd)" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.entries.map((e, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid var(--brd)" }}>
                      <td className="mono" style={{ padding: "8px 10px" }}>{e.paymentDate || "-"}</td>
                      <td style={{ padding: "8px 10px", fontWeight: 500 }}>{e.payerName}</td>
                      <td className="mono" style={{ padding: "8px 10px", fontWeight: 600 }}>{fmt(e.totalAmount || e.total)}</td>
                      <td style={{ padding: "8px 10px" }}>
                        {e.ok === true ? <span style={{ color: "var(--ok)" }}><b>{e.debtorName}</b> <span style={{ fontSize: 10, color: "var(--tm)" }}>({e.debtorId})</span></span>
                          : e.suggestedDebtor ? <span><b>{e.suggestedDebtor.name}</b> <span style={{ fontSize: 10, color: "var(--tm)" }}>({e.suggestedDebtor.id} · {e.suggestedDebtor.hubName})</span></span>
                          : <span style={{ color: "var(--err)" }}>채무자 미발견</span>}
                      </td>
                      <td style={{ padding: "8px 10px", fontSize: 11 }}>
                        {e.ok === true ? <span style={{ color: "var(--ok)", fontWeight: 600 }}>✓ 등록완료 — 잔액 {fmt(e.balanceAfter)} ({e.matchedBy})</span>
                          : e.ok === false && e.pendingId ? <span style={{ color: "var(--warn)", fontWeight: 600 }}>⏳ 대기열 이동 (수동 연결 필요)</span>
                          : e.ok === false ? <span style={{ color: "var(--err)" }}>오류: {e.error || e.reason}</span>
                          : e.matchedBy ? <span style={{ color: "var(--ts)" }}>매칭: {e.matchedBy}</span>
                          : <span style={{ color: "var(--tm)" }}>미매칭 — 적재 시 대기열로</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ padding: 20, textAlign: "center", color: "var(--tm)", fontSize: 13 }}>채택된 입금건이 없습니다.</div>
          )}
          {preview.meta?.rejectedLines?.length > 0 && (
            <details style={{ marginTop: 12 }}>
              <summary style={{ fontSize: 12, color: "var(--tm)", cursor: "pointer" }}>무시된 라인 {preview.meta.rejectedLines.length}개 보기</summary>
              <ul style={{ marginTop: 8, paddingLeft: 20, fontSize: 11, color: "var(--ts)" }}>
                {preview.meta.rejectedLines.map((r, i) => <li key={i} className="mono">{r.line} <span style={{ color: "var(--tm)" }}>({r.reason})</span></li>)}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────
// ─── 주요현안 (강제집행/신용분석/협의 대상자) — 엑셀 스타일 테이블 ──
// App 밖(모듈 스코프)에 정의: App이 리렌더될 때마다 컴포넌트 아이덴티티가
// 바뀌어 통째로 리마운트되면서 입력 중인 필드의 포커스/한글 조합이 끊기는
// 문제를 방지 (타이핑할 때마다 setData가 호출되어 App이 리렌더되기 때문)
const issueTh  = { padding: "8px 10px", fontSize: 11, fontWeight: 700, color: "var(--tp)", background: "var(--bg2)", border: "1px solid var(--brd)", textAlign: "center", whiteSpace: "nowrap" };
const issueTd  = { padding: "5px 8px", fontSize: 12, border: "1px solid var(--brd)", verticalAlign: "middle", textAlign: "center" };
const issueInp = { width: "100%", padding: "5px 7px", fontSize: 12, borderRadius: 4, border: "1px solid transparent", background: "transparent", textAlign: "center" };
const issueAuto = { fontSize: 12, color: "var(--tm)" };

// viewMode: "all"(기본, 삭제되지 않은 전체) | "completed"(완료만) | "trash"(삭제된 것만)
// showComplete=false인 표(주요 협의 대상자)는 완료 개념이 없어 완료 버튼을 숨긴다
const IssueTableCard = ({ title, count, onAdd, viewMode, setViewMode, showComplete = true, children }) => {
  const toggle = (mode) => setViewMode(viewMode === mode ? "all" : mode);
  const btn = (active) => ({ width: 46, boxSizing: "border-box", padding: "5px 0", textAlign: "center", borderRadius: 4, fontSize: 12, fontWeight: 600, border: "1px solid #000", cursor: "pointer", background: active ? "#000" : "var(--bg2)", color: active ? "#fff" : "var(--acc)" });
  return (
    <div style={{ background: "var(--card)", borderRadius: 12, padding: 20, border: "1px solid var(--brd)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", gap: 8 }}><span style={{ width: 10, height: 10, background: "#000", flexShrink: 0 }} />{title} <span style={{ fontSize: 12, color: "var(--tm)", fontWeight: 400 }}>{count}건</span></div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={onAdd} style={btn(false)}>등록</button>
          {showComplete && <button onClick={() => toggle("completed")} style={btn(viewMode === "completed")}>완료</button>}
          <button onClick={() => toggle("trash")} style={btn(viewMode === "trash")}>삭제</button>
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>{children}</table>
      </div>
    </div>
  );
};

const ForcedExecutionTable = ({ rows, users, brands, addKeyIssue, updateKeyIssue, deleteKeyIssue, canDelete }) => {
  const cols = ["채무자명", "브랜드", "집행권원", "주민등록초본", "신용분석", "담당자", "등록일", "처리일", "처리결과", "삭제"];
  // 채무자명이 minWidth만 있고 다른 칸엔 폭 제한이 없어, 남는 공간을 전부 채무자명 칸이
  // 가져가며 유독 넓어 보이던 문제 수정 — 각 칸에 비율에 맞는 폭을 지정
  const colWidths = [110, 90, 110, 110, 70, 90, 110, 110, 110, 46];
  const approvedUsers = users.filter(u => u.approved);
  const [viewMode, setViewMode] = useState("all");
  const shown = rows.filter(r => viewMode === "trash" ? r.deleted : viewMode === "completed" ? (r.completed && !r.deleted) : (!r.completed && !r.deleted));
  const emptyMsg = viewMode === "trash" ? "삭제된 항목이 없습니다" : viewMode === "completed" ? "완료된 항목이 없습니다" : "등록된 대상자가 없습니다 — [등록]으로 추가하세요";
  return (
    <IssueTableCard title="강제집행 대상자" count={shown.length} viewMode={viewMode} setViewMode={setViewMode}
      onAdd={() => { setViewMode("all"); addKeyIssue("forcedExecutions", { id: uid("FEX"), debtorName: "", brand: "", execTitleDate: "", residentCopyDate: "", creditOk: "", assignee: "", registeredDate: today(), resolvedDate: "", result: "", completed: false, deleted: false }); }}>
      <thead><tr>{cols.map((h, i) => <th key={i} style={{ ...issueTh, width: colWidths[i] }}>{h}</th>)}</tr></thead>
      <tbody>
        {shown.length === 0 && <tr><td colSpan={cols.length} style={{ ...issueTd, color: "var(--tm)" }}>{emptyMsg}</td></tr>}
        {shown.map(r => {
          const strike = (extra) => ({ ...issueTd, position: "relative", ...extra });
          const strikeLine = r.completed && <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 2, background: "#ef4444", transform: "translateY(-50%)", pointerEvents: "none" }} />;
          const onRestoreClick = () => updateKeyIssue("forcedExecutions", r.id, { deleted: false });
          const onPurgeClick = () => { if (confirm(`"${r.debtorName || "이 항목"}"을 영구 삭제하시겠습니까? 복구할 수 없습니다.`)) deleteKeyIssue("forcedExecutions", r.id); };
          const onDeleteClick = () => updateKeyIssue("forcedExecutions", r.id, { deleted: true });
          return (
            <tr key={r.id}>
              <td style={strike({ width: colWidths[0] })}><KoreanInput value={r.debtorName || ""} onChange={e => updateKeyIssue("forcedExecutions", r.id, { debtorName: e.target.value })} style={issueInp} placeholder="채무자명" /></td>
              <td style={strike({ width: colWidths[1] })}>
                <select value={r.brand || ""} onChange={e => updateKeyIssue("forcedExecutions", r.id, { brand: e.target.value })} style={{ ...issueInp, border: "1px solid var(--brd)" }}>
                  <option value="">-- 선택 --</option>
                  {brands.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}
                </select>
                {strikeLine}
              </td>
              <td style={strike({ width: colWidths[2] })}><input type="date" value={r.execTitleDate || ""} onChange={e => updateKeyIssue("forcedExecutions", r.id, { execTitleDate: e.target.value })} style={issueInp} />{strikeLine}</td>
              <td style={strike({ width: colWidths[3] })}><input type="date" value={r.residentCopyDate || ""} onChange={e => updateKeyIssue("forcedExecutions", r.id, { residentCopyDate: e.target.value })} style={issueInp} />{strikeLine}</td>
              <td style={strike({ width: colWidths[4] })}>
                <select value={r.creditOk || ""} onChange={e => updateKeyIssue("forcedExecutions", r.id, { creditOk: e.target.value })} style={{ ...issueInp, border: "1px solid var(--brd)" }}>
                  <option value="">-</option>
                  <option value="O">O</option>
                  <option value="X">X</option>
                </select>
                {strikeLine}
              </td>
              <td style={strike({ width: colWidths[5] })}>
                <select value={r.assignee || ""} onChange={e => updateKeyIssue("forcedExecutions", r.id, { assignee: e.target.value })} style={{ ...issueInp, border: "1px solid var(--brd)" }}>
                  <option value="">-- 선택 --</option>
                  {approvedUsers.map(u => <option key={u.id || u.name} value={u.name}>{u.name}</option>)}
                </select>
                {strikeLine}
              </td>
              <td style={strike({ width: colWidths[6] })}><input type="date" value={r.registeredDate || ""} onChange={e => updateKeyIssue("forcedExecutions", r.id, { registeredDate: e.target.value })} style={issueInp} />{strikeLine}</td>
              <td style={strike({ width: colWidths[7] })}><input type="date" value={r.resolvedDate || ""} onChange={e => updateKeyIssue("forcedExecutions", r.id, { resolvedDate: e.target.value })} style={issueInp} />{strikeLine}</td>
              <td style={strike({ width: colWidths[8], maxWidth: colWidths[8] })}>
                <button onClick={() => updateKeyIssue("forcedExecutions", r.id, { completed: !r.completed })}
                  style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 5, cursor: "pointer", background: r.completed ? "#ef4444" : "#3b82f6", color: "#fff", border: `1px solid ${r.completed ? "#ef4444" : "#3b82f6"}` }}>{r.completed ? "복귀" : "완료"}</button>
              </td>
              <td style={strike({ width: viewMode === "trash" ? 88 : colWidths[9], textAlign: "center" })}>
                {canDelete && (viewMode === "trash"
                  ? <div style={{ display: "flex", gap: 4, justifyContent: "center" }}>
                      <button onClick={onRestoreClick} style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 5, cursor: "pointer", background: "#3b82f6", color: "#fff", border: "1px solid #3b82f6" }}>복귀</button>
                      <button onClick={onPurgeClick} title="영구 삭제" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--tm)" }}><I name="close" size={14} /></button>
                    </div>
                  : <button onClick={onDeleteClick} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--tm)" }}><I name="close" size={14} /></button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </IssueTableCard>
  );
};

const CreditAnalysisTable = ({ rows, users, brands, addKeyIssue, updateKeyIssue, deleteKeyIssue, canDelete }) => {
  const cols = ["대상자", "주민등록번호", "연락처", "브랜드", "요청자", "요청일", "담당자", "신용조회일", "신용조회 결과", "처리결과", "삭제"];
  // 대상자/요청자가 폭 제한 없이 남는 공간을 다 가져가 유독 넓어 보이던 문제 수정
  const colWidths = [110, 130, 110, 90, 90, 110, 90, 110, 90, 110, 46];
  const approvedUsers = users.filter(u => u.approved);
  const [viewMode, setViewMode] = useState("all");
  const shown = rows.filter(r => viewMode === "trash" ? r.deleted : viewMode === "completed" ? (r.completed && !r.deleted) : (!r.completed && !r.deleted));
  const emptyMsg = viewMode === "trash" ? "삭제된 항목이 없습니다" : viewMode === "completed" ? "완료된 항목이 없습니다" : "등록된 대상자가 없습니다 — [등록]으로 추가하세요";
  return (
    <IssueTableCard title="신용분석 대상자" count={shown.length} viewMode={viewMode} setViewMode={setViewMode}
      onAdd={() => { setViewMode("all"); addKeyIssue("creditAnalyses", { id: uid("CRA"), target: "", residentId: "", phone: "", brand: "", requester: "", requestDate: today(), assignee: "", checkDate: "", checkResult: "", completed: false, deleted: false }); }}>
      <thead><tr>{cols.map((h, i) => <th key={i} style={{ ...issueTh, width: colWidths[i] }}>{h}</th>)}</tr></thead>
      <tbody>
        {shown.length === 0 && <tr><td colSpan={cols.length} style={{ ...issueTd, color: "var(--tm)" }}>{emptyMsg}</td></tr>}
        {shown.map(r => {
          const strike = (extra) => ({ ...issueTd, position: "relative", ...extra });
          const strikeLine = r.completed && <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 2, background: "#ef4444", transform: "translateY(-50%)", pointerEvents: "none" }} />;
          const onRestoreClick = () => updateKeyIssue("creditAnalyses", r.id, { deleted: false });
          const onPurgeClick = () => { if (confirm(`"${r.target || "이 항목"}"을 영구 삭제하시겠습니까? 복구할 수 없습니다.`)) deleteKeyIssue("creditAnalyses", r.id); };
          const onDeleteClick = () => updateKeyIssue("creditAnalyses", r.id, { deleted: true });
          return (
            <tr key={r.id}>
              <td style={strike({ width: colWidths[0] })}><KoreanInput value={r.target || ""} onChange={e => updateKeyIssue("creditAnalyses", r.id, { target: e.target.value })} style={issueInp} placeholder="대상자명" /></td>
              <td style={strike({ width: colWidths[1] })}><input value={r.residentId || ""} onChange={e => updateKeyIssue("creditAnalyses", r.id, { residentId: e.target.value })} style={issueInp} placeholder="주민등록번호" />{strikeLine}</td>
              <td style={strike({ width: colWidths[2] })}><input value={r.phone || ""} onChange={e => updateKeyIssue("creditAnalyses", r.id, { phone: e.target.value })} style={issueInp} placeholder="연락처" />{strikeLine}</td>
              <td style={strike({ width: colWidths[3] })}>
                <select value={r.brand || ""} onChange={e => updateKeyIssue("creditAnalyses", r.id, { brand: e.target.value })} style={{ ...issueInp, border: "1px solid var(--brd)" }}>
                  <option value="">-- 선택 --</option>
                  {brands.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}
                </select>
                {strikeLine}
              </td>
              <td style={strike({ width: colWidths[4] })}><KoreanInput value={r.requester || ""} onChange={e => updateKeyIssue("creditAnalyses", r.id, { requester: e.target.value })} style={issueInp} placeholder="요청자" />{strikeLine}</td>
              <td style={strike({ width: colWidths[5] })}><input type="date" value={r.requestDate || ""} onChange={e => updateKeyIssue("creditAnalyses", r.id, { requestDate: e.target.value })} style={issueInp} />{strikeLine}</td>
              <td style={strike({ width: colWidths[6] })}>
                <select value={r.assignee || ""} onChange={e => updateKeyIssue("creditAnalyses", r.id, { assignee: e.target.value })} style={{ ...issueInp, border: "1px solid var(--brd)" }}>
                  <option value="">-- 선택 --</option>
                  {approvedUsers.map(u => <option key={u.id || u.name} value={u.name}>{u.name}</option>)}
                </select>
                {strikeLine}
              </td>
              <td style={strike({ width: colWidths[7] })}><input type="date" value={r.checkDate || ""} onChange={e => updateKeyIssue("creditAnalyses", r.id, { checkDate: e.target.value })} style={issueInp} />{strikeLine}</td>
              <td style={strike({ width: colWidths[8] })}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 3 }}>
                  <input value={r.checkResult || ""} onChange={e => updateKeyIssue("creditAnalyses", r.id, { checkResult: e.target.value.replace(/[^0-9]/g, "") })} inputMode="numeric" placeholder="000" style={{ ...issueInp, width: 46, textAlign: "right", padding: "5px 4px" }} />
                  <span style={{ fontSize: 12, color: "var(--ts)" }}>점</span>
                </div>
              </td>
              <td style={strike({ width: colWidths[9], maxWidth: colWidths[9] })}>
                <button onClick={() => updateKeyIssue("creditAnalyses", r.id, { completed: !r.completed })}
                  style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 5, cursor: "pointer", background: r.completed ? "#ef4444" : "#3b82f6", color: "#fff", border: `1px solid ${r.completed ? "#ef4444" : "#3b82f6"}` }}>{r.completed ? "복귀" : "완료"}</button>
              </td>
              <td style={strike({ width: viewMode === "trash" ? 88 : colWidths[10], textAlign: "center" })}>
                {canDelete && (viewMode === "trash"
                  ? <div style={{ display: "flex", gap: 4, justifyContent: "center" }}>
                      <button onClick={onRestoreClick} style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 5, cursor: "pointer", background: "#3b82f6", color: "#fff", border: "1px solid #3b82f6" }}>복귀</button>
                      <button onClick={onPurgeClick} title="영구 삭제" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--tm)" }}><I name="close" size={14} /></button>
                    </div>
                  : <button onClick={onDeleteClick} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--tm)" }}><I name="close" size={14} /></button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </IssueTableCard>
  );
};

const NegotiationTable = ({ rows, debtors, brands, addKeyIssue, updateKeyIssue, deleteKeyIssue, canDelete, currentUserName }) => {
  const cols = ["채무자명", "담당자", "주요 협의 사항", "삭제"];
  // 채무자명/담당자는 좁게, 주요 협의 사항이 남는 공간을 모두 가져가도록 폭 지정
  const colWidths = [110, 64, undefined, 46];

  // 주요협의사항 텍스트를 해당 채무자의 히스토리(hist_m_)에도 반영한다.
  // 같은 협의건을 여러 번 고쳐도 새 기록이 계속 쌓이지 않도록 r.histId로 같은 항목을 갱신하고,
  // 이 협의 행이 삭제되어도 histId는 여기서만 참조할 뿐 히스토리 쪽에서 삭제를 연쇄시키지 않는다
  // (요청사항: 협의 대상자 삭제와 무관하게 채무자 히스토리는 그대로 남아있어야 함).
  const syncNoteToHistory = (r, debtorId, noteText) => {
    const text = (noteText || "").trim();
    if (!debtorId || !text) return;
    const hist = getHistM(debtorId);
    const todayDot = new Date().toISOString().slice(0, 10).replace(/-/g, ".");
    if (r.histId) {
      const idx = hist.findIndex(h => h.id === r.histId);
      if (idx >= 0) {
        if (hist[idx].content === text) return;
        const updated = [...hist];
        updated[idx] = { ...updated[idx], content: text, date: todayDot };
        saveHistM(debtorId, updated);
        return;
      }
    }
    const newId = uid("HIST");
    saveHistM(debtorId, [{ id: newId, date: todayDot, content: text, createdBy: currentUserName || "관리자" }, ...hist]);
    updateKeyIssue("negotiations", r.id, { histId: newId });
  };

  const [viewMode, setViewMode] = useState("all");
  const shown = rows.filter(r => viewMode === "trash" ? r.deleted : !r.deleted);
  const emptyMsg = viewMode === "trash" ? "삭제된 항목이 없습니다" : "등록된 대상자가 없습니다 — [등록]으로 추가하세요";
  return (
    <IssueTableCard title="주요 협의 대상자" count={shown.length} viewMode={viewMode} setViewMode={setViewMode} showComplete={false}
      onAdd={() => { setViewMode("all"); addKeyIssue("negotiations", { id: uid("NEG"), debtorId: "", note: "", histId: null, deleted: false }); }}>
      <thead><tr>{cols.map((h, i) => <th key={i} style={{ ...issueTh, ...(colWidths[i] ? { width: colWidths[i] } : {}) }}>{h}</th>)}</tr></thead>
      <tbody>
        {shown.length === 0 && <tr><td colSpan={cols.length} style={{ ...issueTd, textAlign: "center", color: "var(--tm)" }}>{emptyMsg}</td></tr>}
        {shown.map(r => {
          const d = debtors.find(x => x.id === r.debtorId);
          const onRestoreClick = () => updateKeyIssue("negotiations", r.id, { deleted: false });
          const onPurgeClick = () => { if (confirm("이 항목을 영구 삭제하시겠습니까? 복구할 수 없습니다.")) deleteKeyIssue("negotiations", r.id); };
          const onDeleteClick = () => updateKeyIssue("negotiations", r.id, { deleted: true });
          return (
            <tr key={r.id}>
              <td style={{ ...issueTd, width: colWidths[0] }}><DebtorAutoComplete value={r.debtorId} onChange={id => { updateKeyIssue("negotiations", r.id, { debtorId: id }); syncNoteToHistory(r, id, r.note); }} debtors={debtors} brands={brands} nameOnly /></td>
              <td style={{ ...issueTd, width: colWidths[1] }}><span style={issueAuto}>{d?.assignee || "-"}</span></td>
              <td style={issueTd}>
                <KoreanTextarea
                  value={r.note || ""}
                  onChange={e => updateKeyIssue("negotiations", r.id, { note: e.target.value })}
                  onBlur={e => syncNoteToHistory(r, r.debtorId, e.target.value)}
                  placeholder="주요 협의 사항"
                  rows={2}
                  style={{ ...issueInp, textAlign: "left", resize: "vertical", minHeight: 32, lineHeight: 1.5, whiteSpace: "pre-wrap" }}
                />
              </td>
              <td style={{ ...issueTd, width: viewMode === "trash" ? 88 : colWidths[3], textAlign: "center" }}>
                {canDelete && (viewMode === "trash"
                  ? <div style={{ display: "flex", gap: 4, justifyContent: "center" }}>
                      <button onClick={onRestoreClick} style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 5, cursor: "pointer", background: "#3b82f6", color: "#fff", border: "1px solid #3b82f6" }}>복귀</button>
                      <button onClick={onPurgeClick} title="영구 삭제" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--tm)" }}><I name="close" size={14} /></button>
                    </div>
                  : <button onClick={onDeleteClick} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--tm)" }}><I name="close" size={14} /></button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </IssueTableCard>
  );
};

const TodoListTable = ({ rows, users, addKeyIssue, updateKeyIssue, deleteKeyIssue, canDelete }) => {
  const cols = ["담당자", "업무 내용", "결과", "진행상태", "삭제"];
  const colWidths = [90, undefined, 220, 90, 46];
  const approvedUsers = users.filter(u => u.approved);
  const [viewMode, setViewMode] = useState("all");
  const shown = rows.filter(r => viewMode === "trash" ? r.deleted : viewMode === "completed" ? (r.status === "완료" && !r.deleted) : (r.status !== "완료" && !r.deleted));
  const emptyMsg = viewMode === "trash" ? "삭제된 항목이 없습니다" : viewMode === "completed" ? "완료된 항목이 없습니다" : "등록된 항목이 없습니다 — [등록]으로 추가하세요";
  return (
    <IssueTableCard title="To Do List" count={shown.length} viewMode={viewMode} setViewMode={setViewMode}
      onAdd={() => { setViewMode("all"); addKeyIssue("todoList", { id: uid("TODO"), assignee: "", task: "", result: "", status: "진행중", deleted: false }); }}>
      <thead><tr>{cols.map((h, i) => <th key={i} style={{ ...issueTh, ...(colWidths[i] ? { width: colWidths[i] } : {}) }}>{h}</th>)}</tr></thead>
      <tbody>
        {shown.length === 0 && <tr><td colSpan={cols.length} style={{ ...issueTd, color: "var(--tm)" }}>{emptyMsg}</td></tr>}
        {shown.map(r => {
          const strike = (extra) => ({ ...issueTd, position: "relative", ...extra });
          const strikeLine = r.status === "완료" && <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 2, background: "#ef4444", transform: "translateY(-50%)", pointerEvents: "none" }} />;
          const onRestoreClick = () => updateKeyIssue("todoList", r.id, { deleted: false });
          const onPurgeClick = () => { if (confirm("이 항목을 영구 삭제하시겠습니까? 복구할 수 없습니다.")) deleteKeyIssue("todoList", r.id); };
          const onDeleteClick = () => updateKeyIssue("todoList", r.id, { deleted: true });
          return (
            <tr key={r.id}>
              <td style={strike({ width: colWidths[0] })}>
                <select value={r.assignee || ""} onChange={e => updateKeyIssue("todoList", r.id, { assignee: e.target.value })} style={{ ...issueInp, border: "1px solid var(--brd)" }}>
                  <option value="">-- 선택 --</option>
                  {approvedUsers.map(u => <option key={u.id || u.name} value={u.name}>{u.name}</option>)}
                </select>
              </td>
              <td style={strike()}><KoreanInput value={r.task || ""} onChange={e => updateKeyIssue("todoList", r.id, { task: e.target.value })} style={{ ...issueInp, textAlign: "left" }} placeholder="업무 내용" />{strikeLine}</td>
              <td style={strike({ width: colWidths[2] })}><KoreanInput value={r.result || ""} onChange={e => updateKeyIssue("todoList", r.id, { result: e.target.value })} style={{ ...issueInp, textAlign: "left" }} placeholder="결과" />{strikeLine}</td>
              <td style={strike({ width: colWidths[3] })}>
                <select value={r.status || "진행중"} onChange={e => updateKeyIssue("todoList", r.id, { status: e.target.value })} style={{ ...issueInp, border: "1px solid var(--brd)" }}>
                  <option value="진행중">진행중</option>
                  <option value="보류">보류</option>
                  <option value="완료">완료</option>
                </select>
              </td>
              <td style={strike({ width: viewMode === "trash" ? 88 : colWidths[4], textAlign: "center" })}>
                {canDelete && (viewMode === "trash"
                  ? <div style={{ display: "flex", gap: 4, justifyContent: "center" }}>
                      <button onClick={onRestoreClick} style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 5, cursor: "pointer", background: "#3b82f6", color: "#fff", border: "1px solid #3b82f6" }}>복귀</button>
                      <button onClick={onPurgeClick} title="영구 삭제" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--tm)" }}><I name="close" size={14} /></button>
                    </div>
                  : <button onClick={onDeleteClick} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--tm)" }}><I name="close" size={14} /></button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </IssueTableCard>
  );
};

export default function App() {
  // ─── Auth & Users ─────────────────────────────────────
  const [currentUser, setCurrentUser] = useState(null);
  const [loginError, setLoginError]   = useState("");
  const [lastSaved,  setLastSaved]    = useState(null);
  const REMOVED_USER_EMAILS = ["junwon@barogo.com"]; // 삭제된 계정 목록
  // DEFAULT_USERS 기준으로 이름/역할 등 강제 동기화할 필드 (이메일 키)
  const USER_OVERRIDES = { "hjbae@barogo.com": { name: "배현진", role: "admin" } };
  // localStorage에 저장된(혹은 서버에서 막 받아온) 사용자 목록을 REMOVED_USER_EMAILS/
  // USER_OVERRIDES 규칙에 맞춰 정리한다. useState 초기값과 loadData의 서버 동기화 양쪽에서
  // 같은 로직을 써야, 다른 기기·브라우저에서 사용자 관리 화면에서 바꾼 권한(예: 관리자 승격)이
  // 이 세션에도 그대로 반영된다 — 안 그러면 localStorage가 비어있는(처음 접속하는) 브라우저는
  // 항상 DEFAULT_USERS의 기본 권한으로만 로그인되어 "어드민 탭이 없어졌다"처럼 보인다.
  const normalizeUsers = (stored) => {
    try {
      const base = (stored && stored.length ? stored : DEFAULT_USERS)
        .filter(u => !REMOVED_USER_EMAILS.includes(u.email))
        .map(u => USER_OVERRIDES[u.email] ? { ...u, ...USER_OVERRIDES[u.email] } : u);
      const extras = DEFAULT_USERS.filter(d => !base.find(s => s.email === d.email));
      return extras.length ? [...base, ...extras] : base;
    } catch { return DEFAULT_USERS; }
  };
  const [users, setUsers] = useState(() => {
    try {
      return normalizeUsers(JSON.parse(localStorage.getItem(APP_USERS_KEY)));
    } catch { return DEFAULT_USERS; }
  });
  // 마운트 직후엔 이 브라우저의 localStorage(비어있거나 오래된 값일 수 있음)로 users가
  // 먼저 초기화되는데, 이 상태에서 곧바로 kvPut을 쏘면 loadData()가 서버의 최신 값을
  // 받아오기도 전에 서버 kv_store를 이 브라우저의 (기본값일 수 있는) users로 덮어써버린다 —
  // 다른 기기에서 부여한 관리자 권한 등이 그렇게 사라진 적이 있었다. loadData()가 서버 값을
  // 한 번 받아올 때까지는 kvPut을 보류한다 (로컬 저장은 그대로 즉시 반영).
  const usersHydratedRef = useRef(false);
  useEffect(() => {
    localStorage.setItem(APP_USERS_KEY, JSON.stringify(users));
    if (usersHydratedRef.current) kvPut(APP_USERS_KEY, users);
  }, [users]);
  const [alertRules, setAlertRules] = useState(DEFAULT_ALERT_RULES);
  // 알림 규칙은 서버 DB(alert_rules 테이블)에 영구 저장되고, 백엔드의 알림 규칙 엔진이
  // 주기적으로 평가해 실제 Slack 발송까지 수행한다 (더 이상 새로고침하면 사라지는 화면 전용 상태가 아님).
  useEffect(() => {
    fetch("/api/alert-rules").then(r => r.ok ? r.json() : null).then(rows => { if (rows) setAlertRules(rows); }).catch(() => {});
  }, []);
  const addAlertRule = (rule) => {
    setAlertRules(prev => [...prev, rule]);
    fetch("/api/alert-rules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rule) })
      .catch(() => showToast("알림 규칙 저장 실패 — 새로고침하면 사라집니다"));
  };
  const patchAlertRule = (id, patch) => {
    setAlertRules(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r));
    fetch(`/api/alert-rules/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) })
      .catch(() => showToast("알림 규칙 저장 실패 — 새로고침하면 되돌아갑니다"));
  };
  const deleteAlertRule = (id) => {
    setAlertRules(prev => prev.filter(r => r.id !== id));
    fetch(`/api/alert-rules/${id}`, { method: "DELETE" }).catch(() => {});
  };

  const handleLogin = (nameOrEmail, password) => {
    const user = users.find(u => u.name === nameOrEmail || u.email === nameOrEmail);
    if (!user) { setLoginError("존재하지 않는 계정입니다."); return; }
    if (user.password !== password) { setLoginError("비밀번호가 올바르지 않습니다."); return; }
    setLoginError("");
    setCurrentUser({ ...user });
  };
  const handleLogout = () => { setCurrentUser(null); setLoginError(""); };
  // 어드민 통계용 접속 하트비트 — 로그인 중이고 화면이 활성 상태일 때만 60초마다 전송
  useEffect(() => {
    if (!currentUser) return;
    const sendHeartbeat = () => {
      if (document.visibilityState !== "visible") return;
      fetch("/api/admin/heartbeat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userName: currentUser.name }) }).catch(() => {});
    };
    sendHeartbeat();
    const id = setInterval(sendHeartbeat, 60000);
    return () => clearInterval(id);
  }, [currentUser]);
  // kvPut 등 App() 밖의 저장 함수도 "누가 저장했는지" 알 수 있도록 모듈 전역에 동기화
  useEffect(() => { CURRENT_USER_NAME = currentUser?.name || null; }, [currentUser]);
  const userPerms = currentUser ? (PERM_MAP[currentUser.role] || PERM_MAP.member) : PERM_MAP.member;
  const canEdit = userPerms.edit;
  const canDelete = userPerms.delete;
  const isAdmin = userPerms.admin;
  const canEditRecord   = (record) => isAdmin || (currentUser?.role === "manager" && (record?.createdBy === currentUser?.name || record?.createdBy === currentUser?.id));
  const canDeleteRecord = (record) => isAdmin || (currentUser?.role === "manager" && (record?.createdBy === currentUser?.name || record?.createdBy === currentUser?.id));

  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [data, setData] = useState(() => loadExcelData(DEFAULT_CONFIG));
  const [tab, setTab] = useState("dashboard");
  const [sel, setSel] = useState(null);
  const [q, setQ] = useState("");
  const [brandFilter, setBrandFilter] = useState("전체");
  const [catFilter, setCatFilter] = useState("전체");
  const [statusFilter, setStatusFilter] = useState("전체");
  const [assigneeFilter, setAssigneeFilter] = useState("전체");
  const [sort, setSort] = useState({ f: null, d: "desc" }); // f=null: 기본 정렬(히스토리>입금>연체에이징>채권액) 사용
  const [page, setPage] = useState(1);
  // 좌측 "채무자 관리" 또는 상단 제목 클릭 시, 검색/필터/상세선택을 모두 지우고
  // 전체 채무자 목록으로 되돌아가기 위한 헬퍼
  const goToDebtorList = () => {
    setTab("debtors");
    setSel(null);
    setQ("");
    setBrandFilter("전체");
    setCatFilter("전체");
    setStatusFilter("전체");
    setAssigneeFilter("전체");
    setPage(1);
  };
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState(null);
  const [detailTab, setDetailTab] = useState("히스토리");
  const [adminMainTab, setAdminMainTab] = useState("settings");
  const [adminSettingTab, setAdminSettingTab] = useState("담당자");
  const [adminNewItem, setAdminNewItem] = useState("");
  const [adminEditingRule, setAdminEditingRule] = useState(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [pendingRefreshKey, setPendingRefreshKey] = useState(0);
  // 실시간 동기화(SSE) 재렌더링 시 PaymentsView가 새로 마운트되어도 탭 선택이 유지되도록
  // legalTypeFilter/rehabSubTab과 동일하게 최상위에 둔다
  const [paymentsSubTab, setPaymentsSubTab] = useState("목록");
  // InstallmentsView도 같은 이유로 최상위에 둔다 — 그렇지 않으면 CHECK 사항 패널 클릭 시
  // installmentsFocusDate를 소비/초기화하는 과정에서 InstallmentsView가 다시 마운트되어
  // 방금 연 dayPopup이 곧바로 사라져버린다
  const [instTab, setInstTab] = useState("이번달");
  const [viewMonth, setViewMonth] = useState(new Date().toISOString().slice(0, 7));
  const [dayPopup, setDayPopup] = useState(null);
  // 대시보드 CHECK 사항 패널에서 특정 건수를 클릭했을 때, 해당 탭으로 이동한 뒤
  // 그 날짜만 보도록 열어주기 위한 신호값 (설정되면 해당 뷰가 소비하고 다시 null로 되돌린다)
  const [installmentsFocusDate, setInstallmentsFocusDate] = useState(null);
  const [paymentsFocusDate, setPaymentsFocusDate] = useState(null);
  const [adminEditLogs, setAdminEditLogs] = useState(null); // null=미로드, []~=로드됨
  const [adminEditLogsLoading, setAdminEditLogsLoading] = useState(false);
  const [adminStats, setAdminStats] = useState(null); // null=미로드
  const [adminStatsLoading, setAdminStatsLoading] = useState(false);
  const [statsAccessGran, setStatsAccessGran] = useState("daily"); // daily|monthly|yearly
  const [statsVolumeGran, setStatsVolumeGran] = useState("daily");
  const [dupConfirm, setDupConfirm] = useState(null); // { payment, existingPaymentId, debtorName, paymentDate, total }
  // 법적절차 화면은 이제 지급명령/압류/재산명시·재산조회/형사고소를 한 화면에서 통합 조회하므로
  // legalTypeFilter는 탭 전환이 아니라 "유형" 드롭다운 값이다 (SSE 재렌더링에도 유지되도록 최상위에 둔다)
  const [legalTypeFilter, setLegalTypeFilter] = useState("전체");
  const [rehabSubTab, setRehabSubTab] = useState("회생");
  const [debtorsSubTab, setDebtorsSubTab] = useState("채무자 목록");
  const [expandedNav, setExpandedNav] = useState(() => new Set());
  const [autoResidentNums, setAutoResidentNums] = useState({});
  const [residentRevealed, setResidentRevealed] = useState(() => new Set());
  const [autoResidentDetails, setAutoResidentDetails] = useState({}); // {address, registeredDate, note, issuedDate} — 초본
  const [autoCreditScores, setAutoCreditScores] = useState({});
  const [autoSubrogationDates, setAutoSubrogationDates] = useState({});
  const [autoAddresses, setAutoAddresses] = useState({}); // {address, phone, queriedDate, filename} — CB보고서
  const [prevTab, setPrevTab] = useState(null);
  const [chartYear, setChartYear] = useState(new Date().getFullYear());
  const [agingModalBucket, setAgingModalBucket] = useState(null);
  const [collapsedSections, setCollapsedSections] = useState(() => new Set());
  const [assigneeMonthlyModal, setAssigneeMonthlyModal] = useState(null); // {year, month} | null
  const [legalSearchInit, setLegalSearchInit] = useState(null);
  const [minsaSearchInit, setMinsaSearchInit] = useState(null);
  // AI 종합분석 — 탭 전환해도 대화 유지
  const [aiMessages, setAiMessages] = useState([
    { role: "assistant", content: "안녕하세요! 채권관리 AI 어시스턴트입니다.\n\n채무자 이름을 포함해 질문하시면 해당 채무자의 상세 정보를 분석해드립니다.\n\n예시:\n• \"홍길동 채무자 현황 알려줘\"\n• \"이번 달 입금 없는 채무자 있어?\"\n• \"압류 진행 가능한 채무자 추천해줘\"" },
  ]);
  const [aiInput, setAiInput] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSelDebtor, setAiSelDebtor] = useState(null);
  const [aiDebtorQ, setAiDebtorQ] = useState("");
  const [collectionChannels, setCollectionChannels] = useState({});
  const [collectionChannelsLoading, setCollectionChannelsLoading] = useState(false);
  const PP = 50;

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3000); };
  const navigateToDebtor = (debtor, detailTabName = "히스토리") => {
    setPrevTab(tab);
    setSel(debtor);
    setTab("debtors");
    setDetailTab(detailTabName);
  };
  const goBack = () => {
    setSel(null);
    if (prevTab) {
      setTab(prevTab);
      setPrevTab(null);
    }
  };
  const [backendStatus, setBackendStatus] = useState("loading"); // loading / connected / failed
  const [isRefreshing, setIsRefreshing] = useState(false);
  const loadingRef = useRef(false);

  // ─── 데이터 로드 (초기 / 새로고침 / SSE 재동기화) ──────────
  const loadData = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setIsRefreshing(true);
    try {
      // DB → localStorage 동기화 (공유 데이터 최신화)
      try {
        const kvAll = await fetch("/api/kv-all").then(r => r.ok ? r.json() : {});
        for (const [key, value] of Object.entries(kvAll)) {
          // 유저 계정: DB 값이 있을 때만 덮어씀 (초기 설정 보호).
          // localStorage뿐 아니라 React 상태(users)도 같이 갱신해야 다른 기기·브라우저에서
          // 바뀐 권한(예: 관리자 승격)이 이 세션에도 반영된다 — useState 초기값은 마운트 시
          // 1회만 읽고 끝나서, 여기서 갱신 안 하면 어드민 탭이 계속 안 보일 수 있다.
          if (key === APP_USERS_KEY) {
            if (Array.isArray(value) && value.length > 0) {
              localStorage.setItem(key, JSON.stringify(value));
              // 실제로 내용이 달라졌을 때만 setUsers — 매번 새 배열을 만들면 [users] 이펙트가
              // 매 로드마다 kvPut을 다시 쏴서 서버에 같은 값을 계속 재전송하게 된다.
              const next = normalizeUsers(value);
              setUsers(prev => JSON.stringify(prev) === JSON.stringify(next) ? prev : next);
            }
          } else {
            localStorage.setItem(key, JSON.stringify(value));
          }
        }
      } catch {}
      // 서버 kv_store를 한 번 받아온 뒤부터는 [users] 이펙트의 kvPut을 허용한다.
      usersHydratedRef.current = true;

      const [debtorsRes, paymentsRes, installmentsRes, complaintsRes, activitiesRes] = await Promise.all([
        fetch("/api/debtors").then(r => { if (!r.ok) throw new Error(`debtors ${r.status}`); return r.json(); }),
        fetch("/api/payments").then(r => { if (!r.ok) throw new Error(`payments ${r.status}`); return r.json(); }),
        (() => { const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 5000); return fetch("/api/installments", { signal: ctrl.signal }).then(r => r.ok ? r.json() : []).catch(() => []).finally(() => clearTimeout(t)); })(),
        fetch("/api/complaints").then(r => r.ok ? r.json() : []).catch(() => []),
        fetch("/api/activities").then(r => r.ok ? r.json() : []).catch(() => []),
      ]);
      const brandColorMap = Object.fromEntries(DEFAULT_CONFIG.brands.map(b => [b.code, b.color]));
      const debtors = debtorsRes.map(d => {
        const ex = matchExcelDebtor(d);
        return {
          ...d,
          brandColor: brandColorMap[d.brand] || "#64748b",
          execTitle: !!d.execTitle,
          guarantors: ex?.guarantors || [],
          history: ex?.history || [],
          phoneHistory: [],
          monthlyCollected: {},
        };
      });
      const manualDebtors = getMR(MK.debtors);
      const allDebtorsForMatch = [...debtors, ...manualDebtors];
      const rehabilitations = applyRehabOverrides([...matchRehabsToDebtors(EXCEL_REHABS, allDebtorsForMatch), ...getMR(MK.rehabilitations)]);
      const legalCases      = applyCaseFieldOv([...applyLegalOv(matchLegalCasesToDebtors(LEGAL_CASES,               allDebtorsForMatch), LEGAL_OVERRIDES_KEY), ...getMR(MK.legalCases)]);
      const minsaCases      = [...applyLegalOv(matchLegalCasesToDebtors(MINSA_CASES,               allDebtorsForMatch), MINSA_OVERRIDES_KEY), ...getMR(MK.minsaCases)];
      const assetDisclosures  = [...applyLegalOv(matchAssetDisclosuresToDebtors(ASSET_DISCLOSURE_CASES, allDebtorsForMatch), AD_OVERRIDES_KEY), ...getMR(MK.assetDisclosures)];
      const collectionOrders  = applyCollectionOv(COLLECTION_ORDERS, allDebtorsForMatch);
      const installmentSchedules = installmentsRes.flatMap(p =>
        (p.schedules || []).map(s => ({ ...s, debtorId: p.debtorId, debtorName: p.debtorName, brand: p.brand, assignee: p.assignee, hubCode: p.hubCode, hubName: p.hubName }))
      );
      const complaints   = [...complaintsRes, ...getMR(MK.complaints)];
      const activities   = [...activitiesRes, ...getMR(MK.activities)];
      const allDebtors   = [...debtors, ...manualDebtors];
      const forcedExecutions = getMR(MK.forcedExecutions);
      const creditAnalyses   = getMR(MK.creditAnalyses);
      const negotiations     = getMR(MK.negotiations);
      const todoList         = getMR(MK.todoList);
      const assigneeTargets  = getMR(MK.assigneeTargets);
      setData(prev => ({ ...prev, debtors: allDebtors, payments: paymentsRes, activities, installmentPlans: installmentsRes, installmentSchedules, rehabilitations, legalCases, minsaCases, assetDisclosures, complaints, collectionOrders, forcedExecutions, creditAnalyses, negotiations, todoList, assigneeTargets }));
      setBackendStatus("connected");
      setLastSaved(new Date());
      setPendingRefreshKey(k => k + 1);
      setToast(`데이터 동기화 완료: 채무자 ${debtors.length}건, 입금 ${paymentsRes.length}건`);
      setTimeout(() => setToast(null), 3000);
    } catch (e) {
      console.warn("백엔드 연결 실패:", e);
      setBackendStatus("failed");
    } finally {
      loadingRef.current = false;
      setIsRefreshing(false);
    }
  }, []);

  // 초기 로드
  useEffect(() => { loadData(); }, [loadData]);

  // 채무자 선택 시 초본 PDF에서 주민등록번호 + 최근주소/등록일/비고/발급일 자동 추출
  // (entries: [{name, number}], residentDetails: {address, registeredDate, note, issuedDate})
  useEffect(() => {
    if (!sel || autoResidentNums[sel.id] !== undefined) return;
    setAutoResidentNums(prev => ({ ...prev, [sel.id]: null }));
    fetch(`/api/debtor/${sel.id}/resident-number`)
      .then(r => r.json())
      .then(data => {
        setAutoResidentNums(prev => ({ ...prev, [sel.id]: (data.ok && data.entries?.length) ? data.entries : [] }));
        setAutoResidentDetails(prev => ({ ...prev, [sel.id]: data.residentDetails || false }));
      })
      .catch(() => {
        setAutoResidentNums(prev => ({ ...prev, [sel.id]: [] }));
        setAutoResidentDetails(prev => ({ ...prev, [sel.id]: false }));
      });
  }, [sel?.id]);

  // 채무자 선택 시 CB종합보고서에서 신용점수 자동 추출
  useEffect(() => {
    if (!sel || autoCreditScores[sel.id] !== undefined) return;
    setAutoCreditScores(prev => ({ ...prev, [sel.id]: null }));
    fetch(`/api/debtor/${sel.id}/credit-score`)
      .then(r => r.json())
      .then(data => {
        setAutoCreditScores(prev => ({ ...prev, [sel.id]: data.ok && data.entries?.length ? data.entries : [] }));
      })
      .catch(() => { setAutoCreditScores(prev => ({ ...prev, [sel.id]: [] })); });
  }, [sel?.id]);

  // 채무자 선택 시 대위변제증명서에서 대위변제일 자동 추출
  useEffect(() => {
    if (!sel || autoSubrogationDates[sel.id] !== undefined) return;
    setAutoSubrogationDates(prev => ({ ...prev, [sel.id]: null }));
    fetch(`/api/debtor/${sel.id}/subrogation-date`)
      .then(r => r.json())
      .then(data => {
        setAutoSubrogationDates(prev => ({ ...prev, [sel.id]: data.ok && data.date ? { date: data.date, filename: data.filename } : false }));
      })
      .catch(() => { setAutoSubrogationDates(prev => ({ ...prev, [sel.id]: false })); });
  }, [sel?.id]);

  // 채무자 선택 시 CB종합보고서에서 최신 주소지 + 연락처 + 조회일자 자동 추출 (채무자 위치 지도용) — DB에 이미 있으면 재조회 안 함
  useEffect(() => {
    if (!sel || autoAddresses[sel.id] !== undefined) return;
    if (sel.latestAddress && sel.creditPhone) {
      setAutoAddresses(prev => ({ ...prev, [sel.id]: { address: sel.latestAddress, phone: sel.creditPhone, queriedDate: sel.creditQueriedDate, filename: null } }));
      return;
    }
    setAutoAddresses(prev => ({ ...prev, [sel.id]: null }));
    fetch(`/api/debtor/${sel.id}/credit-address`)
      .then(r => r.json())
      .then(data => {
        setAutoAddresses(prev => ({ ...prev, [sel.id]: data.ok && data.address ? { address: data.address, phone: data.phone, queriedDate: data.queriedDate, filename: data.filename } : false }));
      })
      .catch(() => { setAutoAddresses(prev => ({ ...prev, [sel.id]: false })); });
  }, [sel?.id]);

  // SSE 실시간 동기화 — 다른 사용자가 데이터 변경 시 자동 반영
  // 변경이 있을 때마다 즉시 새로고침하지 않고, 변경이 멈춘 뒤 IDLE_REFRESH_MS만큼
  // 조용하면 새로고침한다. 다만 변경이 계속 이어져 조용해질 틈이 없어도
  // MAX_REFRESH_MS(최대 대기)마다는 강제로 한 번 새로고침한다.
  useEffect(() => {
    if (backendStatus !== "connected") return;
    const IDLE_REFRESH_MS = 10 * 60 * 1000; // 데이터 변경이 멈춘 뒤 10분 지나면 새로고침
    const MAX_REFRESH_MS  = 30 * 60 * 1000; // 변경이 계속돼도 최소 30분마다는 새로고침
    let debounce;
    let src;
    let retryTimer;
    let idleWaitTimer;
    let maxTimer;

    // 입력 중(포커스가 입력 필드에 있음)이면 새로고침으로 값이 덮어써지지 않도록 대기
    const isUserTyping = () => {
      const el = document.activeElement;
      return !!el && ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
    };
    const resetMaxTimer = () => {
      clearTimeout(maxTimer);
      maxTimer = setTimeout(reloadWhenIdle, MAX_REFRESH_MS);
    };
    const reloadWhenIdle = () => {
      clearTimeout(idleWaitTimer);
      if (isUserTyping()) { idleWaitTimer = setTimeout(reloadWhenIdle, 2000); return; }
      loadData();
      resetMaxTimer();
    };

    const connect = () => {
      src = new EventSource("/api/events");
      src.addEventListener("data-changed", () => {
        clearTimeout(debounce);
        debounce = setTimeout(reloadWhenIdle, IDLE_REFRESH_MS);
      });
      src.onerror = () => {
        src.close();
        // 3초 후 재연결 시도
        retryTimer = setTimeout(connect, 3000);
      };
    };
    connect();
    resetMaxTimer();

    // 탭 복귀 시 놓친 변경사항 반영 (입력 중이면 대기)
    const onVisible = () => { if (document.visibilityState === "visible") reloadWhenIdle(); };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      src.close();
      clearTimeout(debounce);
      clearTimeout(retryTimer);
      clearTimeout(idleWaitTimer);
      clearTimeout(maxTimer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [backendStatus, loadData]);

  useEffect(() => {
    fetch("/api/pending-payments")
      .then(r => r.ok ? r.json() : [])
      .then(rows => setPendingCount(Array.isArray(rows) ? rows.length : 0))
      .catch(() => {});
  }, []);

  // 월별 회수 채널 데이터 로드 (대시보드 접속 시)
  useEffect(() => {
    if (collectionChannelsLoading) return;
    setCollectionChannelsLoading(true);
    const _curY = new Date().getFullYear();
    const _years = Array.from({ length: _curY - 2023 }, (_, i) => 2024 + i);
    Promise.all(_years.map(y => fetch(`/api/collection-channels?year=${y}`).then(r => r.ok ? r.json() : [])))
    .then(results => {
      const map = {};
      results.flat().forEach(r => {
        const key = `${r.year}_${r.month}_${r.brand}_${r.channel}`;
        map[key] = r.amount;
      });
      setCollectionChannels(map);
      setCollectionChannelsLoading(false);
    }).catch(() => setCollectionChannelsLoading(false));
  }, []); // eslint-disable-line

  // 수정 로그 탭 활성화 시 DB에서 자동 로드
  useEffect(() => {
    if (adminMainTab !== "logs") return;
    if (adminEditLogs !== null && !adminEditLogsLoading) return; // 이미 로드됨
    setAdminEditLogsLoading(true);
    fetch("/api/edit-logs")
      .then(r => r.ok ? r.json() : [])
      .then(rows => { setAdminEditLogs(rows); setAdminEditLogsLoading(false); })
      .catch(() => { setAdminEditLogs([]); setAdminEditLogsLoading(false); });
  }, [adminMainTab]);

  // ─── Audit Log (with user) ──────────────────────────────
  const [auditLogs, setAuditLogs] = useState([]);
  const addLog = (action, target, detail, changes) => {
    setAuditLogs(prev => [{ id: uid("LOG"), timestamp: new Date().toISOString(), user: currentUser?.name || "시스템", action, target, detail, changes: changes || [] }, ...prev].slice(0, 500));
  };
  const diffFields = (oldObj, newObj, fieldLabels) => {
    const changes = [];
    for (const [key, label] of Object.entries(fieldLabels)) {
      const ov = oldObj[key], nv = newObj[key];
      if (String(ov ?? "") !== String(nv ?? "")) {
        changes.push({ field: label, from: ov ?? "(없음)", to: nv ?? "(없음)" });
      }
    }
    return changes;
  };
  const DEBTOR_FIELD_LABELS = { brand: "브랜드", category: "분류", assignee: "담당", name: "채무자명", phone: "연락처", hubCode: "코드", hubName: "허브/지점", debtCause: "채무발생원인", collectionStatus: "추심상태", principalBalance: "재무잔액", adjustment: "조정액", collectedAmount: "회수액", execTitle: "집행권원", execTitleType: "집행권원종류", execTitleUrl: "집행권원PDF", loanDate: "대여일자", subrogationMonth: "대위변제월", subrogationDocUrl: "대위변제증명서PDF", creditCheck: "신용조회일자", creditReportUrl: "CB종합보고서PDF", creditGrade: "신용점수", residentCopy: "주민등록초본", residentNumber: "주민등록번호", birthDate: "생년월일", salesRep: "영업담당자", keyNotes: "주요사항", residentAddress: "최근 주소(초본)", residentRegisteredDate: "등록일(초본)", residentNote: "비고(세대주및관계)", creditPhone: "연락처(CB)" };

  // ─── Excel Download ─────────────────────────────────────
  const downloadCSV = (filename, headers, rows) => {
    const BOM = "\uFEFF";
    const escape = (v) => { const s = String(v ?? ""); return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = BOM + [headers.join(","), ...rows.map(r => r.map(escape).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
    showToast(`${filename} 다운로드 완료`);
  };
  const exportDebtors = (list) => {
    downloadCSV(`채권관리_${today()}.csv`,
      ["ID","브랜드","분류","담당","채무자명","연락처","코드","허브/지점","채무발생원인","추심상태","원채무액","추가법무비용","회수액","재무기준잔액","법무기준잔액","집행권원","대여일자","주요사항"],
      list.map(d => [d.id, d.brandName, d.category, d.assignee, d.name, d.phone, d.hubCode, d.hubName, d.debtCause, d.collectionStatus, d.principalBalance, d.adjustment, d.collectedAmount, d.finalBalanceFinance, d.finalBalanceLegal, d.execTitle ? "O" : "X", d.loanDate, d.keyNotes])
    );
  };
  const exportPayments = (list) => {
    downloadCSV(`입금내역_${today()}.csv`,
      ["ID","입금일","브랜드","담당","허브/지점","코드","채무자","입금자","합계","본사계좌","캐쉬충전","웰컴직접","비고"],
      list.map(p => [p.id, p.paymentDate, p.brand, p.assignee, p.hubName, p.hubCode, p.debtorName, p.payerName, p.totalAmount, p.companyAccount, p.cashCharge, p.welcomeDirect, p.note])
    );
  };
  const exportInstallments = (list) => {
    downloadCSV(`분할상환_${today()}.csv`,
      ["ID","브랜드","채무자","납부시기","월분납액","채무액","채권액","상태","담당"],
      list.map(p => [p.id, p.brand, p.debtorName, p.paymentTiming, p.monthlyAmount, p.totalDebt, p.totalClaim, p.status, p.assignee])
    );
  };
  const exportLegal = (seizures, rehabs, complaints) => {
    const rows = [];
    seizures.forEach(s => rows.push(["압류", s.brand, s.debtorName, s.court, s.caseNumber, s.status, s.targets.length + "건", s.targets.reduce((a, t) => a + t.collected, 0)]));
    rehabs.forEach(r => rows.push(["회생파산", r.brand, r.debtorName, r.court, r.caseNumber, r.type, r.currentRound, r.monthlyPayment]));
    complaints.forEach(c => rows.push(["형사", c.brand, c.debtorName, c.policeStation, c.charge, c.status, "", c.loanAmount]));
    downloadCSV(`법적절차_${today()}.csv`, ["구분","브랜드","채무자","법원/경찰서","사건번호/죄명","상태","비고","금액"], rows);
  };

  // ─── Data Mutation Helpers ──────────────────────────────
  // #2,#3 채무자 수정 — 이름/브랜드 변경 시 관련 데이터 연쇄 ���신
  const updateDebtor = async (id, changes) => {
    setData(prev => {
      const old = prev.debtors.find(d => d.id === id);
      if (!old) return prev;
      const nameChanged = changes.name && changes.name !== old.name;
      const brandChanged = changes.brand && changes.brand !== old.brand;
      const cascadeRelated = (arr) => {
        if (!nameChanged && !brandChanged) return arr;
        return arr.map(item => {
          if (item.debtorId !== id) return item;
          const upd = { ...item };
          if (nameChanged) upd.debtorName = changes.name;
          if (brandChanged) upd.brand = changes.brand;
          return upd;
        });
      };
      return {
        ...prev,
        debtors: prev.debtors.map(d => d.id === id ? { ...d, ...changes } : d),
        payments: cascadeRelated(prev.payments),
        activities: cascadeRelated(prev.activities),
        seizureCases: cascadeRelated(prev.seizureCases),
        rehabilitations: cascadeRelated(prev.rehabilitations),
        installmentPlans: cascadeRelated(prev.installmentPlans).map(p => {
          if (p.debtorId !== id) return p;
          const upd = { ...p };
          if (nameChanged) upd.debtorName = changes.name;
          if (brandChanged) { upd.brand = changes.brand; upd.brandName = changes.brandName; }
          return upd;
        }),
        complaints: cascadeRelated(prev.complaints),
      };
    });
    if (sel && sel.id === id) setSel(prev => ({ ...prev, ...changes }));
    // DB에 영구 저장 (에러 시 토스트로 즉시 알림)
    try {
      const res = await fetch(`/api/debtors/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...changes, _userName: currentUser?.name || "관리자" }),
      });
      const result = await res.json();
      if (!result.ok) {
        showToast(`저장 실패: ${result.error || "서버 오류"} — 새로고침 후 다시 시도해주세요`);
        await reloadFromBackend();
      }
    } catch (e) {
      showToast("서버 연결 실패 — 변경사항이 저장되지 않았습니다. 새로고침 후 다시 시도해주세요.");
      await reloadFromBackend();
    }
  };
  const addDebtor = async (debtor) => {
    setData(prev => ({ ...prev, debtors: [debtor, ...prev.debtors] }));
    // DB 저장 시도, 실패 시 localStorage 폴백
    if (backendStatus === "connected") {
      try {
        const res = await fetch("/api/debtors", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(debtor) });
        const result = await res.json();
        if (!result.ok) addMR(MK.debtors, debtor);
      } catch { addMR(MK.debtors, debtor); }
    } else {
      addMR(MK.debtors, debtor);
    }
  };
  // #2 채무자 삭제 — 관련 데이터 캐스케이드 삭제
  const deleteDebtor = async (id) => {
    setData(prev => ({
      ...prev,
      debtors: prev.debtors.filter(d => d.id !== id),
      payments: prev.payments.filter(p => p.debtorId !== id),
      activities: prev.activities.filter(a => a.debtorId !== id),
      seizureCases: prev.seizureCases.filter(s => s.debtorId !== id),
      rehabilitations: prev.rehabilitations.filter(r => r.debtorId !== id),
      installmentPlans: prev.installmentPlans.filter(p => p.debtorId !== id),
      complaints: prev.complaints.filter(c => c.debtorId !== id),
    }));
    if (sel && sel.id === id) setSel(null);
    // DB 삭제 시도, localStorage에서도 제거
    delMR(MK.debtors, id);
    if (backendStatus === "connected") {
      fetch(`/api/debtors/${id}`, { method: "DELETE" }).catch(() => {});
    }
  };
  // 채무자 잔액 재계산 헬퍼
  const recalcDebtor = (d, collectedDelta, paymentDate) => {
    const newCollected = d.collectedAmount + collectedDelta;
    const newFinFinance = (d.principalBalance || 0) - newCollected;
    const newFinLegal = (d.principalBalance || 0) + (d.adjustment || 0) - newCollected;
    const month = paymentDate ? new Date(paymentDate).getMonth() + 1 : null;
    const newMonthly = month ? { ...d.monthlyCollected, [month]: Math.max(0, (d.monthlyCollected[month] || 0) + collectedDelta) } : d.monthlyCollected;
    // #6 잔액 0 이하 시 추심보류로 자동 변경
    const newStatus = newFinLegal <= 0 ? "추심보류" : d.collectionStatus;
    return { ...d, collectedAmount: newCollected, finalBalanceFinance: newFinFinance, finalBalanceLegal: newFinLegal, monthlyCollected: newMonthly, collectionStatus: newStatus };
  };
  // ─── 백엔드에서 채무자/입금 데이터 다시 가져오기 ─────────
  const reloadFromBackend = async () => {
    try {
      const [debtorsRes, paymentsRes] = await Promise.all([
        fetch("/api/debtors").then(r => r.json()),
        fetch("/api/payments").then(r => r.json()),
      ]);
      const brandColorMap = Object.fromEntries(DEFAULT_CONFIG.brands.map(b => [b.code, b.color]));
      const debtors = debtorsRes.map(d => {
        const ex = matchExcelDebtor(d);
        return {
          ...d,
          brandColor: brandColorMap[d.brand] || "#64748b",
          execTitle: !!d.execTitle,
          guarantors: ex?.guarantors || [],
          history: ex?.history || [],
          phoneHistory: [], monthlyCollected: {},
        };
      });
      // 실DB 채무자를 기준으로 회생파산 debtorId 재매칭 + 수동 override/수동 추가 건 적용
      // (loadData와 동일하게 처리해야 입금 등록/삭제 후에도 연대보증인·히스토리·수동 회생파산건이 유지된다)
      const rehabilitations = applyRehabOverrides([...matchRehabsToDebtors(EXCEL_REHABS, debtors), ...getMR(MK.rehabilitations)]);
      setData(prev => ({ ...prev, debtors, payments: paymentsRes, rehabilitations }));
      setLastSaved(new Date());
      if (sel) {
        const updated = debtors.find(d => d.id === sel.id);
        if (updated) setSel(updated);
      }
      return true;
    } catch (e) { console.warn("리로드 실패:", e); return false; }
  };

  const reloadInstallments = async () => {
    try {
      const plans = await fetch("/api/installments").then(r => r.json());
      const schedules = plans.flatMap(p =>
        (p.schedules || []).map(s => ({ ...s, debtorId: p.debtorId, debtorName: p.debtorName, brand: p.brand, assignee: p.assignee, hubCode: p.hubCode, hubName: p.hubName }))
      );
      setData(prev => ({ ...prev, installmentPlans: plans, installmentSchedules: schedules }));
    } catch(e) { showToast("분할상환 로드 실패"); }
  };
  const addInstallmentMemo = async (schedId, memo, eventType = "메모") => {
    await fetch(`/api/installments/schedules/${schedId}/memo`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memo, eventType, userName: "관리자" }),
    });
    await reloadInstallments();
  };

  // 회생파산 회차 문자열 +1 증가: "33회차" → "34회차" (범위 형식은 변경 안 함)
  const incrementRehabRound = (roundStr) => {
    if (!roundStr) return roundStr;
    const m = roundStr.match(/^(\d+)회차$/);
    return m ? `${parseInt(m[1]) + 1}회차` : roundStr;
  };

  // 회생파산 입금 여부 판단: 입금자명 끝에 1~2자리 숫자가 붙어 있으면 법원 회생금
  const isRehabPayerName = (payerName) => /\d{1,2}$/.test((payerName || "").trim());

  // 입금 후 회생파산 회차 자동 증가 처리
  const applyRehabRoundIncrement = (debtorId, payerName) => {
    if (!debtorId || !isRehabPayerName(payerName)) return;
    setData(prev => {
      const hasRehab = prev.rehabilitations.some(r => r.debtorId === debtorId);
      if (!hasRehab) return prev;
      const updated = prev.rehabilitations.map(r =>
        r.debtorId === debtorId
          ? { ...r, currentRound: incrementRehabRound(r.currentRound) }
          : r
      );
      return { ...prev, rehabilitations: updated };
    });
  };

  // 입금 추가 — 백엔드 API 호출 (잔액·분할상환·추심상태 자동 처리)
  // 백엔드 미연결 시 기존 프론트 전용 로직으로 폴백
  const addPayment = async (payment, force = false) => {
    if (backendStatus === "connected") {
      try {
        const res = await fetch("/api/payments", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            debtorId: payment.debtorId, paymentDate: payment.paymentDate,
            payerName: payment.payerName, totalAmount: payment.totalAmount,
            companyAccount: payment.companyAccount, cashCharge: payment.cashCharge,
            welcomeDirect: payment.welcomeDirect, note: payment.note,
            createdByName: currentUser?.name,
            force,
          }),
        });
        const result = await res.json();
        if (result.isDuplicate) {
          setDupConfirm({ payment, ...result });
          return;
        }
        if (!result.ok) { showToast(`입금 등록 실패: ${result.error || result.reason}`); return; }
        await reloadFromBackend();
        applyRehabRoundIncrement(payment.debtorId, payment.payerName);
        const rehabMsg = isRehabPayerName(payment.payerName) ? ` (회생금 — 회차 자동 증가)` : "";
        showToast(`입금 등록 완료 — 잔액 자동 차감 (잔액 ${(result.balanceAfter || 0).toLocaleString()}원)${rehabMsg}`);
        return;
      } catch (e) { showToast(`백엔드 오류: ${e.message} — 프론트 임시 적용`); }
    }
    // 폴백: 프론트엔드 전용 갱신
    const isRehab = isRehabPayerName(payment.payerName);
    setData(prev => {
      const newDebtors = prev.debtors.map(d => d.id === payment.debtorId ? recalcDebtor(d, payment.totalAmount, payment.paymentDate) : d);
      const payMonth = new Date(payment.paymentDate).getMonth() + 1;
      const payYear = new Date(payment.paymentDate).getFullYear();
      const targetMonthStr = `${payYear}년 ${payMonth}월`;
      const newInstallments = prev.installmentPlans.map(plan => {
        if (plan.debtorId !== payment.debtorId) return plan;
        return { ...plan, logs: (plan.logs || []).map(log => {
          if (log.targetMonth === targetMonthStr && (log.status === "미납" || log.status === "지연")) {
            return { ...log, status: "완납", paidAmount: payment.totalAmount, memo: `입금확인 ${fmtDate(payment.paymentDate)}` };
          }
          return log;
        }) };
      });
      const newRehabs = isRehab
        ? prev.rehabilitations.map(r => r.debtorId === payment.debtorId ? { ...r, currentRound: incrementRehabRound(r.currentRound) } : r)
        : prev.rehabilitations;
      return { ...prev, debtors: newDebtors, payments: [payment, ...prev.payments], installmentPlans: newInstallments, rehabilitations: newRehabs };
    });
    if (sel && sel.id === payment.debtorId) setSel(prev => recalcDebtor(prev, payment.totalAmount, payment.paymentDate));
  };

  // 입금 삭제 — 백엔드 API 호출 (잔액 자동 원복)
  const deletePayment = async (paymentId) => {
    if (backendStatus === "connected") {
      try {
        const res = await fetch(`/api/payments/${paymentId}`, {
          method: "DELETE", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userName: currentUser?.name }),
        });
        const result = await res.json();
        if (!result.ok) { showToast(`삭제 실패: ${result.error}`); return; }
        await reloadFromBackend();
        showToast(`입금 삭제 완료 — 잔액 원복`);
        return;
      } catch (e) { showToast(`백엔드 오류: ${e.message}`); }
    }
    // 폴백
    setData(prev => {
      const payment = prev.payments.find(p => p.id === paymentId);
      if (!payment) return prev;
      const newDebtors = prev.debtors.map(d => d.id === payment.debtorId ? recalcDebtor(d, -payment.totalAmount, payment.paymentDate) : d);
      return { ...prev, debtors: newDebtors, payments: prev.payments.filter(p => p.id !== paymentId) };
    });
    if (sel) {
      const payment = data.payments.find(p => p.id === paymentId);
      if (payment && sel.id === payment.debtorId) setSel(prev => recalcDebtor(prev, -payment.totalAmount, payment.paymentDate));
    }
  };
  const addActivity = async (activity) => {
    setData(prev => ({ ...prev, activities: [activity, ...prev.activities] }));
    if (backendStatus === "connected") {
      try {
        const res = await fetch("/api/activities", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(activity) });
        const result = await res.json();
        if (!result.ok) addMR(MK.activities, activity);
      } catch { addMR(MK.activities, activity); }
    } else {
      addMR(MK.activities, activity);
    }
  };
  const addSeizure = (sz) => {
    setData(prev => ({ ...prev, seizureCases: [sz, ...prev.seizureCases] }));
  };
  const addRehab = (r) => {
    setData(prev => ({ ...prev, rehabilitations: [r, ...prev.rehabilitations] }));
    addMR(MK.rehabilitations, r);
  };
  const addInstallment = async (p) => {
    setData(prev => ({ ...prev, installmentPlans: [p, ...prev.installmentPlans] }));
    if (backendStatus === "connected") {
      try {
        await fetch("/api/installments", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: p.id, debtorId: p.debtorId, paymentTiming: p.paymentTiming, monthlyAmount: p.monthlyAmount, startDate: p.startDate, status: p.status, memo: p.memo }) });
      } catch { addMR(MK.installmentPlans, p); }
    } else {
      addMR(MK.installmentPlans, p);
    }
  };
  const addComplaint = async (c) => {
    setData(prev => ({ ...prev, complaints: [c, ...prev.complaints] }));
    if (backendStatus === "connected" && c.debtorId) {
      try {
        const res = await fetch("/api/complaints", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c) });
        const result = await res.json();
        if (!result.ok) addMR(MK.complaints, c);
      } catch { addMR(MK.complaints, c); }
    } else {
      addMR(MK.complaints, c);
    }
  };
  // ─── 주요현안 (강제집행/신용분석/협의 대상자) ───────────
  const addKeyIssue = (listKey, rec) => {
    setData(prev => ({ ...prev, [listKey]: [rec, ...prev[listKey]] }));
    addMR(MK[listKey], rec);
  };
  const updateKeyIssue = (listKey, id, patch) => {
    setData(prev => ({ ...prev, [listKey]: prev[listKey].map(r => r.id === id ? { ...r, ...patch } : r) }));
    updateMR(MK[listKey], id, patch);
  };
  const deleteKeyIssue = (listKey, id) => {
    setData(prev => ({ ...prev, [listKey]: prev[listKey].filter(r => r.id !== id) }));
    delMR(MK[listKey], id);
  };
  // ─── 담당자별 월간 목표 금액 설정 ─────────────────────────
  const setAssigneeTarget = (assignee, field, value) => {
    const existing = (data.assigneeTargets || []).find(t => t.assignee === assignee);
    if (existing) updateKeyIssue("assigneeTargets", existing.id, { [field]: value });
    else addKeyIssue("assigneeTargets", { id: uid("TGT"), assignee, [field]: value });
  };
  // #4 브랜드 변경 시 채무자 연쇄 갱신
  const updateBrandInDebtors = (oldCode, newBrand) => {
    setData(prev => ({
      ...prev,
      debtors: prev.debtors.map(d => d.brand === oldCode ? { ...d, brandName: newBrand.name, brandColor: newBrand.color } : d),
    }));
  };
  const removeBrandFromConfig = (idx) => {
    const brand = config.brands[idx];
    const count = data.debtors.filter(d => d.brand === brand.code).length;
    if (count > 0) { showToast(`${brand.name} 브랜드에 ${count}건의 채권이 있어 삭제할 수 없습니다`); return false; }
    setConfig(p => ({ ...p, brands: p.brands.filter((_, i) => i !== idx) }));
    showToast("삭제 완료");
    return true;
  };
  // #5 담당자 삭제 시 경고
  const removeAssigneeFromConfig = (idx) => {
    const assignee = config.assignees[idx];
    const count = data.debtors.filter(d => d.assignee === assignee).length;
    if (count > 0) { showToast(`${assignee} 담당자에 ${count}건의 채권이 배정되어 있어 삭제할 수 없습���다`); return false; }
    setConfig(p => ({ ...p, assignees: p.assignees.filter((_, i) => i !== idx) }));
    showToast("삭제 완료");
    return true;
  };

  // ─── Stats ──────────────────────────────────────────────
  const stats = useMemo(() => {
    const d = data.debtors;
    const totalDebtors = d.length, totalPrincipal = d.reduce((s, x) => s + x.principalBalance, 0);
    const totalCollected = d.reduce((s, x) => s + x.collectedAmount, 0), totalRemaining = d.reduce((s, x) => s + x.finalBalanceLegal, 0);
    const totalFinanceRemaining = d.reduce((s, x) => s + x.finalBalanceFinance, 0);
    const collectionRate = totalPrincipal > 0 ? (totalCollected / totalPrincipal * 100) : 0;
    const byBrand = {};
    config.brands.forEach(b => { const bd = d.filter(x => x.brand === b.code); byBrand[b.code] = { count: bd.length, principal: bd.reduce((s, x) => s + x.principalBalance, 0), collected: bd.reduce((s, x) => s + x.collectedAmount, 0), remaining: bd.reduce((s, x) => s + x.finalBalanceLegal, 0) }; });
    const byCat = {}; config.categories.forEach(c => { byCat[c] = d.filter(x => x.category === c).length; });
    const byGroup = {}; DASHBOARD_GROUPS.forEach(g => { byGroup[g.label] = d.filter(x => g.cats.includes(x.category)).length; });
    const byStatus = {}; config.collStatuses.forEach(s => { byStatus[s] = d.filter(x => x.collectionStatus === s).length; });
    const byAssignee = {}; config.assignees.forEach(a => { byAssignee[a] = d.filter(x => x.assignee === a).length; });
    const monthlyPayments = {};
    const monthlyByChannel = {};
    const _thisYear = new Date().getFullYear();
    for (let m = 1; m <= 12; m++) {
      const ps = data.payments.filter(p => { const pd = new Date(p.paymentDate); return pd.getFullYear() === _thisYear && pd.getMonth() + 1 === m; });
      monthlyPayments[m] = ps.reduce((s, p) => s + p.totalAmount, 0);
      const companyAccount = ps.reduce((s, p) => s + (p.companyAccount || 0), 0);
      monthlyByChannel[m] = {
        companyAccount,
        cashCharge: ps.reduce((s, p) => s + (p.cashCharge || 0), 0),
        welcomeDirect: ps.reduce((s, p) => s + (p.welcomeDirect || 0), 0),
        byBrand: {
          B: ps.filter(p => p.brand === 'B').reduce((s, p) => s + (p.totalAmount || 0), 0),
          D: ps.filter(p => p.brand === 'D').reduce((s, p) => s + (p.totalAmount || 0), 0),
          M: ps.filter(p => p.brand === 'M').reduce((s, p) => s + (p.totalAmount || 0), 0),
        },
      };
    }
    const lc = data.legalCases || [];
    const ad = data.assetDisclosures || [];
    const cmp = data.complaints || [];
    const byLegalType = {
      "압류":     lc.filter(c => c.type === "압류").length,
      "지급명령": lc.filter(c => c.type === "지급명령").length,
      "재산명시": ad.length,
      "형사고소": cmp.length,
    };
    const totalLegal = lc.length + ad.length + cmp.length + data.rehabilitations.length;
    const totalSeizures = lc.filter(c => c.type === "압류").length;
    return { totalDebtors, totalPrincipal, totalCollected, totalRemaining, totalFinanceRemaining, collectionRate, byBrand, byCat, byGroup, byStatus, byAssignee, monthlyPayments, monthlyByChannel, byLegalType, totalLegal, totalPayments: data.payments.length, totalSeizures, totalRehabs: data.rehabilitations.length, totalInstallments: data.installmentPlans.length };
  }, [data, config]);

  // ─── 연체 에이징 분석 ──────────────────────────────────────
  // "연체일수"는 채무자별 별도 만기일이 없는 채권이 많아, 최근 입금일(없으면 대여일)로부터
  // 경과한 일수를 기준으로 삼는다 — NPL 추심 실무에서 흔히 쓰는 방식이며, 값이 클수록
  // 오래 방치된(=우선 추심이 필요한) 채권임을 뜻한다.
  const agingStats = useMemo(() => {
    const lastPayByDebtor = {};
    data.payments.forEach(p => {
      if (!p.debtorId || !p.paymentDate) return;
      if (!lastPayByDebtor[p.debtorId] || p.paymentDate > lastPayByDebtor[p.debtorId]) lastPayByDebtor[p.debtorId] = p.paymentDate;
    });
    const nowMs = new Date(today() + "T00:00:00").getTime();
    const buckets = AGING_BUCKETS.map(b => ({ ...b, count: 0, amount: 0, items: [] }));
    let noAnchorCount = 0;
    data.debtors.filter(d => d.collectionStatus === "추심진행" && (d.finalBalanceLegal || 0) > 0).forEach(d => {
      const anchor = lastPayByDebtor[d.id] || d.loanDate || null;
      const anchorMs = anchor ? new Date(anchor + "T00:00:00").getTime() : NaN;
      if (!anchor || isNaN(anchorMs)) { noAnchorCount++; return; }
      const days = Math.max(0, Math.floor((nowMs - anchorMs) / 86400000));
      const bucket = buckets.find(b => days >= b.min && days < b.max) || buckets[buckets.length - 1];
      bucket.count++;
      bucket.amount += (d.finalBalanceLegal || 0);
      bucket.items.push({ ...d, agingDays: days, lastPaymentDate: lastPayByDebtor[d.id] || null });
    });
    buckets.forEach(b => b.items.sort((a, c) => c.finalBalanceLegal - a.finalBalanceLegal));
    return {
      buckets,
      totalCount: buckets.reduce((s, b) => s + b.count, 0),
      totalAmount: buckets.reduce((s, b) => s + b.amount, 0),
      noAnchorCount,
    };
  }, [data]);

  // ─── 담당자별 성과 리더보드 (이번달 vs 지난달, 목표 대비 달성률) ─
  const assigneeStats = useMemo(() => {
    const debtorAssignee = {};
    data.debtors.forEach(d => { debtorAssignee[d.id] = d.assignee; });
    const targetMap = {};
    (data.assigneeTargets || []).forEach(t => { targetMap[t.assignee] = t; });
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth() + 1;
    const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
    const sumFor = (a, year, month) => data.payments
      .filter(p => p.debtorId && debtorAssignee[p.debtorId] === a && p.paymentDate)
      .filter(p => { const pd = new Date(p.paymentDate); return pd.getFullYear() === year && pd.getMonth() + 1 === month; })
      .reduce((s, p) => s + (p.totalAmount || 0), 0);
    const sumForYear = (a, year) => data.payments
      .filter(p => p.debtorId && debtorAssignee[p.debtorId] === a && p.paymentDate)
      .filter(p => new Date(p.paymentDate).getFullYear() === year)
      .reduce((s, p) => s + (p.totalAmount || 0), 0);
    const rows = config.assignees.map(a => {
      const thisMonth = sumFor(a, y, m);
      const lastMonth = sumFor(a, py, pm);
      const thisYear = sumForYear(a, y);
      const momRate = lastMonth > 0 ? ((thisMonth - lastMonth) / lastMonth) * 100 : (thisMonth > 0 ? 100 : 0);
      const target = targetMap[a]?.monthlyTarget || 0;
      const annualTarget = targetMap[a]?.annualTarget || 0;
      const achieveRate = target > 0 ? (thisMonth / target) * 100 : null;
      const annualAchieveRate = annualTarget > 0 ? (thisYear / annualTarget) * 100 : null;
      return { assignee: a, thisMonth, lastMonth, thisYear, momRate, target, annualTarget, achieveRate, annualAchieveRate };
    });
    rows.sort((a, b) => b.thisMonth - a.thisMonth);
    return rows;
  }, [data, config]);

  // ─── Filtered Debtors ───────────────────────────────────
  const filtered = useMemo(() => {
    let l = [...data.debtors];
    if (q) {
      const ql = q.toLowerCase();
      l = l.filter(d => {
        if ((d.name || "").toLowerCase().includes(ql)) return true;
        if ((d.id || "").toLowerCase().includes(ql)) return true;
        if ((d.assignee || "").toLowerCase().includes(ql)) return true;
        if ((d.phone || "").toLowerCase().includes(ql)) return true;
        if ((d.hubCode || "").toLowerCase().includes(ql)) return true;
        if ((d.hubName || "").toLowerCase().includes(ql)) return true;
        if ((d.guarantors || []).some(g => (g || "").toLowerCase().includes(ql))) return true;
        if (getDebtorHistoryText(d).toLowerCase().includes(ql)) return true;
        return false;
      });
    }
    if (brandFilter !== "전체") l = l.filter(d => d.brand === brandFilter);
    if (catFilter !== "전체") l = l.filter(d => d.category === catFilter);
    if (statusFilter !== "전체") l = l.filter(d => d.collectionStatus === statusFilter);
    if (assigneeFilter !== "전체") l = l.filter(d => d.assignee === assigneeFilter);

    // 같은 이름+브랜드 or 유사 코드(1234 / 1234-1)인 채무자를 그룹핑
    // (정렬은 그룹 합산 이후에 해야 한다 — 화면에 보이는 값은 그룹 합계인데 그룹핑 전
    //  개별 채무자 값으로 먼저 정렬하면 합계 기준 정렬 순서와 어긋난다)
    const baseCode = (c) => String(c || "").trim().replace(/-\d+$/, "");
    const grouped = [];
    const seen = new Set();
    for (const d of l) {
      if (seen.has(d.id)) continue;
      const bc = baseCode(d.hubCode);
      const siblings = l.filter(x =>
        x.id !== d.id && !seen.has(x.id) && x.brand === d.brand && (
          (x.name && d.name && x.name.trim() === d.name.trim()) ||
          (bc && bc.length >= 3 && baseCode(x.hubCode) === bc)
        )
      );
      if (siblings.length > 0) {
        const grp = [d, ...siblings];
        grp.forEach(g => seen.add(g.id));
        grouped.push({
          ...d,
          principalBalance:    grp.reduce((s, g) => s + (g.principalBalance || 0), 0),
          collectedAmount:     grp.reduce((s, g) => s + (g.collectedAmount || 0), 0),
          adjustment:          grp.reduce((s, g) => s + (g.adjustment || 0), 0),
          finalBalanceFinance: grp.reduce((s, g) => s + (g.finalBalanceFinance || 0), 0),
          finalBalanceLegal:   grp.reduce((s, g) => s + (g.finalBalanceLegal || 0), 0),
          subRows: grp,
        });
      } else {
        seen.add(d.id);
        grouped.push(d);
      }
    }
    if (sort.f) {
      grouped.sort((a, b) => { const av = a[sort.f], bv = b[sort.f]; if (typeof av === "number") return sort.d === "asc" ? av - bv : bv - av; return sort.d === "asc" ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av)); });
    } else {
      // 기본 정렬: ①최근 히스토리 기입순 → ②최근 입금순 → ③연체 에이징 구간(짧은 순) → ④채권액 큰 순
      const normDate = (s) => String(s || "").replace(/\./g, "-");
      const extractDate = (s) => { const m = String(s || "").match(/(\d{4})[.-](\d{1,2})[.-](\d{1,2})/); return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null; };
      const lastPayByDebtor = {};
      data.payments.forEach(p => {
        if (!p.debtorId || !p.paymentDate) return;
        if (!lastPayByDebtor[p.debtorId] || p.paymentDate > lastPayByDebtor[p.debtorId]) lastPayByDebtor[p.debtorId] = p.paymentDate;
      });
      const nowMs = Date.now();
      const sortInfo = (d) => {
        // 엑셀 원본에서 넘어온 d.history는 원본 파일 파싱 오류로 엉뚱한 값이 섞여 들어간 경우가 있어
        // (예: 브랜드명·담당자명이 날짜에 잘못 매칭됨) 정렬 기준에서 제외하고, 이 프로그램에서
        // "히스토리 추가"로 직접 입력한 항목(히스토리 관리)만 "최근 히스토리"로 취급한다.
        const histDates = getHistM(d.id).map(h => h.date).map(normDate).filter(Boolean);
        const lastHistory = histDates.length ? histDates.reduce((x, y) => (x > y ? x : y)) : null;
        const lastPayment = lastPayByDebtor[d.id] || null;
        const anchor = extractDate(lastPayment || d.loanDate);
        let agingIdx = AGING_BUCKETS.length;
        if (anchor) {
          const anchorMs = new Date(anchor + "T00:00:00").getTime();
          if (!isNaN(anchorMs)) {
            const days = Math.max(0, Math.floor((nowMs - anchorMs) / 86400000));
            const idx = AGING_BUCKETS.findIndex(b => days >= b.min && days < b.max);
            agingIdx = idx === -1 ? AGING_BUCKETS.length - 1 : idx;
          }
        }
        return { lastHistory, lastPayment, agingIdx };
      };
      grouped.sort((a, b) => {
        const ia = sortInfo(a), ib = sortInfo(b);
        if (ia.lastHistory || ib.lastHistory) {
          if (!ia.lastHistory) return 1;
          if (!ib.lastHistory) return -1;
          if (ia.lastHistory !== ib.lastHistory) return ia.lastHistory > ib.lastHistory ? -1 : 1;
        } else if (ia.lastPayment || ib.lastPayment) {
          if (!ia.lastPayment) return 1;
          if (!ib.lastPayment) return -1;
          if (ia.lastPayment !== ib.lastPayment) return ia.lastPayment > ib.lastPayment ? -1 : 1;
        }
        if (ia.agingIdx !== ib.agingIdx) return ia.agingIdx - ib.agingIdx;
        return (b.finalBalanceLegal || 0) - (a.finalBalanceLegal || 0);
      });
    }
    return grouped;
  }, [data, q, brandFilter, catFilter, statusFilter, assigneeFilter, sort]);

  const tp = Math.ceil(filtered.length / PP);
  const paged = filtered.slice((page - 1) * PP, page * PP);
  useEffect(() => { setPage(1); }, [q, brandFilter, catFilter, statusFilter, assigneeFilter]);
  const doSort = (f) => {
    if (sort.f === f) {
      if (sort.d === "desc") setSort({ f, d: "asc" });
      else setSort({ f: null, d: null });
    } else {
      setSort({ f, d: "desc" });
    }
  };

  // ─── CSS ────────────────────────────────────────────────
  const CSS = `@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;600;700;900&family=JetBrains+Mono:wght@400;500;600&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#f3f4f6;--bg2:#f9fafb;--card:#ffffff;--hover:#fff5ed;--inp:#f9fafb;--brd:#e5e7eb;--bf:#ff5f00;--tp:#111827;--ts:#475569;--tm:#94a3b8;--acc:#ff5f00;--ok:#10b981;--err:#ef4444;--warn:#f59e0b}
body{background:#fff;color:var(--tp);font-family:'Noto Sans KR',sans-serif}
::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:var(--bg)}::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:3px}
input,select,textarea{font-family:'Noto Sans KR',sans-serif;background:var(--inp);color:var(--tp);border:1px solid var(--brd);border-radius:8px;padding:8px 12px;font-size:13px;outline:none;transition:border .2s}
input:focus,select:focus,textarea:focus{border-color:var(--bf)}
button{font-family:'Noto Sans KR',sans-serif;cursor:pointer;border:none;outline:none;transition:all .15s}button:hover{opacity:.85}
.mono{font-family:'JetBrains Mono',monospace}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}.anim{animation:fadeIn .3s ease-out}
@keyframes slideIn{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}.slide{animation:slideIn .3s ease-out}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
@keyframes toastIn{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}.spinning{animation:spin .8s linear infinite}`;

  const KPI = ({ label, value, sub, color, onClick, active }) => (
    <div
      onClick={onClick}
      style={{
        background: "var(--card)", borderRadius: 12, padding: 20,
        border: `1px solid ${active ? color : "var(--brd)"}`, position: "relative", overflow: "hidden",
        cursor: onClick ? "pointer" : "default",
        boxShadow: active ? `0 0 0 1px ${color}40` : "none",
        transition: "border-color 0.1s, box-shadow 0.1s",
      }}
      onMouseEnter={onClick ? (e => e.currentTarget.style.background = "var(--hover)") : undefined}
      onMouseLeave={onClick ? (e => e.currentTarget.style.background = "var(--card)") : undefined}
    >
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg,${color},${color}00)` }} />
      <div style={{ fontSize: 12, color: "var(--tm)", marginBottom: 8, fontWeight: 500 }}>{label}</div>
      <div className="mono" style={{ fontSize: 22, fontWeight: 700, color, marginBottom: 4 }}>{value}</div>
      <div style={{ fontSize: 11, color: "var(--ts)" }}>{sub}</div>
    </div>
  );

  // ═══ MODALS ═════════════════════════════════════════════

  // ─── Debtor Add/Edit Modal ──────────────────────────────
  const DebtorFormModal = useStableComponent(() => {
    // "+항목"(같은 채무자의 신규 서브로우 추가)은 id 없이 brand/name 등 기본값만 담은
    // modal.data를 넘긴다 — modal.data의 truthy 여부만으로는 이 경우와 실제 수정을
    // 구분할 수 없어 신규 등록인데도 updateDebtor(undefined, ...)가 호출되는 버그가 있었다.
    const isEdit = !!modal.data?.id;
    const [f, setF] = useState(isEdit ? { ...modal.data } : {
      brand: config.brands[0]?.code || "B", category: config.categories[0], assignee: config.assignees[0],
      name: "", phone: "", hubCode: "", hubName: "", debtCause: config.debtCauses[0] || "",
      collectionStatus: config.collStatuses[0], execTitle: false, execTitleType: "", execTitleUrl: "",
      loanDate: today(), principalBalance: 0, adjustment: 0, collectedAmount: 0,
      salesRep: "", residentNumber: "",
      keyNotes: "", guarantors: [], subrogationMonth: "", subrogationDocUrl: "", creditReportUrl: "",
      ...modal.data, // "+항목"으로 넘어온 brand/name/category/assignee/hubName 기본값 적용
    });
    const set = (k, v) => setF(p => ({ ...p, [k]: v }));
    const [phoneItems, setPhoneItems] = useState(() => {
      const raw = (isEdit ? modal.data?.phone : "") || "";
      const items = raw.split(/\s*\/\s*|\n/).map(p => p.trim()).filter(Boolean);
      return items.length > 0 ? items : [""];
    });
    const save = () => {
      if (!f.name.trim()) { showToast("채무자명을 입력하세요"); return; }
      const brandObj = config.brands.find(b => b.code === f.brand) || config.brands[0];
      const rec = {
        ...f,
        phone: phoneItems.filter(p => p.trim()).join("\n"),
        brandName: brandObj.name, brandColor: brandObj.color,
        finalBalanceFinance: (f.principalBalance || 0) - (f.collectedAmount || 0),
        finalBalanceLegal: (f.principalBalance || 0) + (f.adjustment || 0) - (f.collectedAmount || 0),
        monthlyCollected: f.monthlyCollected || {},
        phoneHistory: f.phoneHistory || [], guarantors: f.guarantors || [],
      };
      if (isEdit) {
        const changes = diffFields(modal.data, rec, DEBTOR_FIELD_LABELS);
        updateDebtor(rec.id, rec);
        addLog("수정", "채권", `${rec.name} (${rec.id})`, changes);
        showToast(`${rec.name} 정보가 수정되었습니다`);
      } else {
        rec.id = uid("NPL");
        addDebtor(rec);
        addLog("등록", "채권", `${rec.name} (${rec.id}) 신규 등록 — ${rec.brandName}, ${fmt(rec.principalBalance)}`);
        showToast(`${rec.name} 채권이 등록되었습니다`);
      }
      setModal(null);
    };
    return (
      <Overlay onClose={() => setModal(null)} wide>
        <ModalHeader title={isEdit ? "채권 정보 수정" : "신규 채권 등록"} onClose={() => setModal(null)} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <Field label="브랜드"><select value={f.brand} onChange={e => set("brand", e.target.value)} style={inp}>{config.brands.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}</select></Field>
          <Field label="분류"><select value={f.category} onChange={e => set("category", e.target.value)} style={inp}>{config.categories.map(c => <option key={c}>{c}</option>)}</select></Field>
          <Field label="담당"><select value={f.assignee} onChange={e => set("assignee", e.target.value)} style={inp}>{config.assignees.map(a => <option key={a}>{a}</option>)}</select></Field>
          <Field label="채무자명"><KoreanInput value={f.name} onChange={e => set("name", e.target.value)} style={inp} placeholder="채무자명 입력" /></Field>
          <Field label="연대보증인" span={2}><KoreanInput value={(f.guarantors || []).join(", ")} onChange={e => set("guarantors", e.target.value.split(/\s*,\s*/).map(s => s.trim()).filter(Boolean))} style={inp} placeholder="예: 홍길동, 김철수" /></Field>
          <Field label="연락처" span={3}>
            <div>
              {phoneItems.map((p, i) => (
                <div key={i} style={{ display: "flex", gap: 6, marginBottom: 5 }}>
                  <KoreanInput value={p} onChange={e => setPhoneItems(prev => prev.map((x, xi) => xi === i ? e.target.value : x))} style={{ ...inp, flex: 1 }} placeholder={`연락처 ${i + 1} (예: 이름 010-0000-0000)`} />
                  <button type="button" onClick={() => setPhoneItems(prev => prev.filter((_, xi) => xi !== i))} style={{ padding: "0 10px", borderRadius: 8, background: "#ef444418", color: "#ef4444", border: "1px solid #ef444430", cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
                </div>
              ))}
              <button type="button" onClick={() => setPhoneItems(prev => [...prev, ""])} style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 12px", borderRadius: 7, background: "var(--bg2)", color: "var(--tm)", border: "1px solid var(--brd)", cursor: "pointer", fontSize: 12, marginTop: 2 }}>+ 연락처 추가</button>
            </div>
          </Field>
          <Field label="코드"><KoreanInput value={f.hubCode} onChange={e => set("hubCode", e.target.value)} style={inp} placeholder="허브 코드" /></Field>
          <Field label="허브/지점"><KoreanInput value={f.hubName || ""} onChange={e => set("hubName", e.target.value)} style={inp} placeholder="허브/지점 직접 입력" /></Field>
          <Field label="채무발생원인"><select value={f.debtCause} onChange={e => set("debtCause", e.target.value)} style={inp}>{config.debtCauses.map(c => <option key={c}>{c}</option>)}</select></Field>
          <Field label="추심상태"><select value={f.collectionStatus} onChange={e => set("collectionStatus", e.target.value)} style={inp}>{config.collStatuses.map(s => <option key={s}>{s}</option>)}</select></Field>
          <Field label="원금 잔액"><input type="text" value={f.principalBalance === 0 || f.principalBalance == null ? "" : Number(f.principalBalance).toLocaleString("ko-KR")} onChange={e => { const n = Number(e.target.value.replace(/,/g, "")); set("principalBalance", isNaN(n) ? 0 : n); }} style={inp} placeholder="0" /></Field>
          <Field label="조정액(법무비용)"><input type="text" value={f.adjustment === 0 || f.adjustment == null ? "" : Number(f.adjustment).toLocaleString("ko-KR")} onChange={e => { const n = Number(e.target.value.replace(/,/g, "")); set("adjustment", isNaN(n) ? 0 : n); }} style={inp} placeholder="0" /></Field>
          <Field label="회수액"><input type="text" value={f.collectedAmount === 0 || f.collectedAmount == null ? "" : Number(f.collectedAmount).toLocaleString("ko-KR")} onChange={e => { const n = Number(e.target.value.replace(/,/g, "")); set("collectedAmount", isNaN(n) ? 0 : n); }} style={inp} placeholder="0" /></Field>
          <Field label="대여일자"><input type="date" value={f.loanDate} onChange={e => set("loanDate", e.target.value)} style={inp} /></Field>
          <Field label="집행권원 종류"><select value={f.execTitleType || ""} onChange={e => { set("execTitleType", e.target.value); set("execTitle", e.target.value ? 1 : 0); }} style={inp}><option value="">없음</option><option value="공정증서+집행문">공정증서+집행문</option><option value="지급명령결정정본">지급명령결정정본</option><option value="판결정본+집행문+송달증명원+확정증명원">판결정본+집행문+송달증명원+확정증명원</option></select></Field>
          <Field label="집행권원 PDF (OneDrive)"><KoreanInput value={f.execTitleUrl || ""} onChange={e => set("execTitleUrl", e.target.value)} style={inp} placeholder="OneDrive 공유 링크" /></Field>
          <Field label="대위변제일"><KoreanInput value={f.subrogationMonth || ""} onChange={e => set("subrogationMonth", e.target.value)} style={inp} placeholder="예: 2026.03.31" /></Field>
          <Field label="신용점수"><KoreanInput value={f.creditGrade || ""} onChange={e => set("creditGrade", e.target.value)} style={inp} placeholder="예: 850" /></Field>
          <Field label="신용조회상 최신 주소" span={2}><KoreanInput value={f.latestAddress || ""} onChange={e => set("latestAddress", e.target.value)} style={inp} placeholder="CB보고서 자동추출 또는 직접 입력 — 초본상 주소와 비교해 더 최근 것이 채무자 위치 지도에 쓰입니다" /></Field>
          <Field label="연락처(CB)"><KoreanInput value={f.creditPhone || ""} onChange={e => set("creditPhone", e.target.value)} style={inp} placeholder="CB보고서 자동추출 또는 직접 입력" /></Field>
          <Field label="영업담당자"><KoreanInput value={f.salesRep || ""} onChange={e => set("salesRep", e.target.value)} style={inp} placeholder="예: 2팀 김상원 010-..." /></Field>
          <Field label="주민등록번호" span={2}><KoreanInput value={f.residentNumber || ""} onChange={e => set("residentNumber", e.target.value)} onBlur={e => { const v = e.target.value.trim(); if (v && !/^\d{6}-\d{7}$/.test(v)) showToast("주민등록번호 형식이 올바르지 않습니다 (000000-0000000)"); }} style={inp} placeholder="000000-0000000" maxLength={14} /></Field>
          <Field label="초본상 최신 주소" span={2}><KoreanInput value={f.residentAddress || ""} onChange={e => set("residentAddress", e.target.value)} style={inp} placeholder="초본 자동추출 또는 직접 입력" /></Field>
          <Field label="등록일(초본)"><KoreanInput value={f.residentRegisteredDate || ""} onChange={e => set("residentRegisteredDate", e.target.value)} style={inp} placeholder="예: 2024-04-03" /></Field>
          <Field label="비고(세대주및관계)" span={3}><KoreanInput value={f.residentNote || ""} onChange={e => set("residentNote", e.target.value)} style={inp} placeholder="초본 자동추출 또는 직접 입력" /></Field>
          <Field label="주요사항" span={3}><KoreanTextarea value={f.keyNotes || ""} onChange={e => set("keyNotes", e.target.value)} rows={3} style={{ ...inp, resize: "vertical" }} placeholder="법적 조치, 소송 이력 등" /></Field>
        </div>
        <ModalFooter onCancel={() => setModal(null)} onSave={save} saveLabel={isEdit ? "수정" : "등록"} />
      </Overlay>
    );
  });

  // ─── Payment Add Modal ──────────────────────────────────
  const PaymentFormModal = useStableComponent(() => {
    const debtorId = modal.debtorId || "";
    const debtor = data.debtors.find(d => d.id === debtorId);
    const [f, setF] = useState({
      debtorId, paymentDate: today(), payerName: debtor?.name || "",
      totalAmount: 0, channel: config.paymentChannels[0], note: "",
    });
    const set = (k, v) => setF(p => ({ ...p, [k]: v }));
    const save = () => {
      const d = data.debtors.find(x => x.id === f.debtorId);
      if (!d) { showToast("채무자를 선택하세요"); return; }
      if (!f.totalAmount) { showToast("금액을 입력하세요"); return; }
      const amt = Number(f.totalAmount);
      addPayment({
        id: uid("PAY"), debtorId: d.id, debtorName: d.name, brand: d.brand, assignee: d.assignee,
        hubName: d.hubName, hubCode: d.hubCode, paymentDate: f.paymentDate, payerName: f.payerName || d.name,
        totalAmount: amt, companyAccount: f.channel === "본사계좌" ? amt : 0,
        cashCharge: f.channel === "캐쉬충전" ? amt : 0, welcomeDirect: f.channel === "웰컴직접상환" ? amt : 0,
        note: f.note,
      });
      addLog("등록", "입금", `${d.name} (${d.id}) — ${fmt(amt)} / ${f.channel}`);
      showToast(`${d.name} 입금 ${fmt(amt)} 등록 완료`);
      setModal(null);
    };
    return (
      <Overlay onClose={() => setModal(null)}>
        <ModalHeader title="입금 등록" onClose={() => setModal(null)} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="채무자" span={2}>
            {debtor ? <div style={{ padding: "8px 10px", background: "var(--bg)", borderRadius: 8, fontSize: 13 }}><BrandBadge code={debtor.brand} brands={config.brands} /> {debtor.name} ({debtor.id})</div>
              : <DebtorAutoComplete value={f.debtorId} onChange={v => set("debtorId", v)} debtors={data.debtors} brands={config.brands} />}
          </Field>
          <Field label="입금일"><input type="date" value={f.paymentDate} onChange={e => set("paymentDate", e.target.value)} style={inp} /></Field>
          <Field label="입금자명"><KoreanInput value={f.payerName} onChange={e => set("payerName", e.target.value)} style={inp} /></Field>
          <Field label="입금액"><MoneyInput value={f.totalAmount} onChange={v => set("totalAmount", v)} style={inp} placeholder="금액 입력" /></Field>
          <Field label="입금 채널"><select value={f.channel} onChange={e => set("channel", e.target.value)} style={inp}>{config.paymentChannels.map(c => <option key={c}>{c}</option>)}</select></Field>
          <Field label="비고" span={2}><KoreanInput value={f.note} onChange={e => set("note", e.target.value)} style={inp} placeholder="비고 사항" /></Field>
        </div>
        <ModalFooter onCancel={() => setModal(null)} onSave={save} saveLabel="등록" />
      </Overlay>
    );
  });

  // RematchModal → RematchModalStandalone (module-level) 사용

  // ─── Activity Add Modal ─────────────────────────────────
  const ActivityFormModal = useStableComponent(() => {
    const debtorId = modal.debtorId || "";
    const debtor = data.debtors.find(d => d.id === debtorId);
    const [f, setF] = useState({
      debtorId, activityDate: today(), activityType: config.activityTypes[0], content: "", assignee: config.assignees[0],
    });
    const set = (k, v) => setF(p => ({ ...p, [k]: v }));
    const save = () => {
      const d = data.debtors.find(x => x.id === f.debtorId);
      if (!d) { showToast("채무자를 선택하세요"); return; }
      if (!f.content.trim()) { showToast("활동 내용을 입력하세요"); return; }
      addActivity({ id: uid("ACT"), debtorId: d.id, debtorName: d.name, brand: d.brand, activityDate: f.activityDate, activityType: f.activityType, content: f.content, assignee: f.assignee });
      addLog("등록", "추심활동", `${d.name} — ${f.activityType}: ${f.content.slice(0, 50)}`);
      showToast(`추심 활동이 기록되었습니다`);
      setModal(null);
    };
    return (
      <Overlay onClose={() => setModal(null)}>
        <ModalHeader title="추심 활동 기록" onClose={() => setModal(null)} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="채무자" span={2}>
            {debtor ? <div style={{ padding: "8px 10px", background: "var(--bg)", borderRadius: 8, fontSize: 13 }}><BrandBadge code={debtor.brand} brands={config.brands} /> {debtor.name} ({debtor.id})</div>
              : <DebtorAutoComplete value={f.debtorId} onChange={v => set("debtorId", v)} debtors={data.debtors} brands={config.brands} />}
          </Field>
          <Field label="활동일"><input type="date" value={f.activityDate} onChange={e => set("activityDate", e.target.value)} style={inp} /></Field>
          <Field label="활동 유형"><select value={f.activityType} onChange={e => set("activityType", e.target.value)} style={inp}>{config.activityTypes.map(t => <option key={t}>{t}</option>)}</select></Field>
          <Field label="담당자"><select value={f.assignee} onChange={e => set("assignee", e.target.value)} style={inp}>{config.assignees.map(a => <option key={a}>{a}</option>)}</select></Field>
          <Field label="활동 내용" span={2}><KoreanTextarea value={f.content} onChange={e => set("content", e.target.value)} rows={4} style={{ ...inp, resize: "vertical" }} placeholder="통화 내용, 결과, 약속 등" /></Field>
        </div>
        <ModalFooter onCancel={() => setModal(null)} onSave={save} saveLabel="기록" />
      </Overlay>
    );
  });

  // ═══ VIEWS ══════════════════════════════════════════════

  // ─── Dashboard ──────────────────────────────────────────
  const SectionHeader = ({ children, sectionId }) => {
    const collapsed = collapsedSections.has(sectionId);
    return (
      <div onClick={() => setCollapsedSections(prev => { const next = new Set(prev); next.has(sectionId) ? next.delete(sectionId) : next.add(sectionId); return next; })}
        style={{ alignSelf: "flex-start", background: "#4b5563", color: "#fff", fontSize: 18, fontWeight: 800, padding: "10px 16px", borderRadius: 8, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, userSelect: "none" }}>
        <span>{children}</span>
        <span style={{ fontSize: 13, transform: collapsed ? "rotate(-90deg)" : "none", transition: "transform 0.15s" }}>▾</span>
      </div>
    );
  };

  const Dashboard = () => {
    const maxBrand = Math.max(...config.brands.map(b => stats.byBrand[b.code]?.remaining || 0));
    return (
      <div className="anim" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <SectionHeader sectionId="bonds">채권현황</SectionHeader>
        {!collapsedSections.has("bonds") && (<>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16 }}>
          <KPI label="총 관리 채권" value={`${stats.totalDebtors}건`} sub={config.categories.map(c => `${c} ${stats.byCat[c] || 0}`).join(" / ")} color="#3b82f6" />
          <KPI label="총 채권금액" value={fmt(stats.totalRemaining)} sub={`재무 ${fmt(stats.totalFinanceRemaining)}`} color="#8b5cf6" />
          <KPI label="소송현황" value={`${(stats.totalLegal || 0).toLocaleString()}건`} sub={`지급명령 ${stats.byLegalType["지급명령"] || 0} / 압류 ${stats.byLegalType["압류"] || 0} / 재산명시·재산조회 ${stats.byLegalType["재산명시"] || 0} / 형사고소 ${stats.byLegalType["형사고소"] || 0} / 회생/파산 ${stats.totalRehabs || 0}`} color="#ef4444" />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div style={{ background: "var(--card)", borderRadius: 12, padding: 20, border: "1px solid var(--brd)" }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>브랜드별 현황</div>
            {config.brands.map(b => { const bd = stats.byBrand[b.code] || {}; return (<div key={b.code} style={{ marginBottom: 14 }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><BrandBadge code={b.code} brands={config.brands} /><span style={{ fontSize: 13, fontWeight: 500 }}>{b.name}</span><span className="mono" style={{ fontSize: 11, color: "var(--tm)" }}>{bd.count || 0}건</span></div><span className="mono" style={{ fontSize: 12, fontWeight: 600, color: b.color }}>{fmt(bd.remaining)}</span></div><div style={{ height: 8, background: "var(--bg)", borderRadius: 4, overflow: "hidden" }}><div style={{ height: "100%", width: `${maxBrand > 0 ? ((bd.remaining || 0) / maxBrand) * 100 : 0}%`, background: `linear-gradient(90deg,${b.color},${b.color}88)`, borderRadius: 4 }} /></div></div>); })}
          </div>
          <div style={{ background: "var(--card)", borderRadius: 12, padding: 20, border: "1px solid var(--brd)" }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>분류별 현황</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, marginBottom: 20 }}>
              {DASHBOARD_GROUPS.map(g => (
                <div key={g.label} onClick={() => { setQ(""); setBrandFilter("전체"); setStatusFilter("전체"); setAssigneeFilter("전체"); setCatFilter(g.cats[0]); setTab("debtors"); }}
                  style={{ textAlign: "center", padding: 12, background: "var(--bg)", borderRadius: 8, cursor: "pointer" }}
                  onMouseEnter={e => e.currentTarget.style.background = "var(--hover)"}
                  onMouseLeave={e => e.currentTarget.style.background = "var(--bg)"}>
                  <div className="mono" style={{ fontSize: 20, fontWeight: 700, marginBottom: 4, color: g.color }}>{stats.byGroup?.[g.label] || 0}</div>
                  <div style={{ fontSize: 11, color: "var(--tm)" }}>{g.label}</div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>담당자별 현황</div>
            <div style={{ display: "flex", gap: 10 }}>
              {config.assignees.map(a => (
                <div key={a} onClick={() => { setQ(""); setBrandFilter("전체"); setCatFilter("전체"); setStatusFilter("전체"); setAssigneeFilter(a); setTab("debtors"); }}
                  style={{ flex: 1, textAlign: "center", padding: 12, background: "var(--bg)", borderRadius: 8, cursor: "pointer" }}
                  onMouseEnter={e => e.currentTarget.style.background = "var(--hover)"}
                  onMouseLeave={e => e.currentTarget.style.background = "var(--bg)"}>
                  <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: "var(--acc)", marginBottom: 4 }}>{stats.byAssignee[a] || 0}</div>
                  <div style={{ fontSize: 12, fontWeight: 500 }}>{a}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
        </>)}
        {/* ── 연체 에이징 분석 ── */}
        <SectionHeader sectionId="aging">연체 에이징 분석</SectionHeader>
        {!collapsedSections.has("aging") && (<>
        <div style={{ background: "var(--card)", borderRadius: 12, padding: 20, border: "1px solid var(--brd)" }}>
          <div style={{ fontSize: 12, color: "#000", marginBottom: 14 }}>
            추심 진행중인 채권을 최근 입금일(입금 이력이 없으면 대여일) 기준 경과일수
          </div>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${agingStats.buckets.length}, 1fr)`, gap: 12 }}>
            {agingStats.buckets.map(b => (
              <div key={b.key} onClick={() => b.count > 0 && setAgingModalBucket(b.key)}
                style={{ textAlign: "center", padding: 14, borderRadius: 10, background: "var(--bg)", cursor: b.count > 0 ? "pointer" : "default", border: `1px solid ${b.color}30` }}
                onMouseEnter={e => { if (b.count > 0) e.currentTarget.style.background = "var(--hover)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "var(--bg)"; }}>
                <div style={{ fontSize: 11, color: "var(--tm)", marginBottom: 8, fontWeight: 600 }}>{b.label}</div>
                <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: b.color, marginBottom: 4 }}>{b.count}건</div>
                <div className="mono" style={{ fontSize: 12, color: "var(--ts)" }}>{fmt(b.amount)}</div>
              </div>
            ))}
          </div>
          {agingStats.noAnchorCount > 0 && <div style={{ marginTop: 10, fontSize: 11, color: "#000" }}>* 기준일(대여일·입금이력) 정보가 없어 집계에서 제외된 채권 {agingStats.noAnchorCount}건</div>}
        </div>
        </>)}
        {agingModalBucket && (() => {
          const bucket = agingStats.buckets.find(b => b.key === agingModalBucket);
          if (!bucket) return null;
          return (
            <Overlay onClose={() => setAgingModalBucket(null)} wide>
              <ModalHeader title={`${bucket.label} 연체 채권 (${bucket.count}건, ${fmt(bucket.amount)})`} onClose={() => setAgingModalBucket(null)} />
              <div style={{ maxHeight: 460, overflow: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead><tr style={{ background: "var(--bg2)" }}>{["채무자", "브랜드", "담당", "경과일", "최근입금일", "잔액"].map(h => <th key={h} style={{ padding: "8px 10px", textAlign: "left", fontSize: 11, color: "var(--tm)", borderBottom: "1px solid var(--brd)", whiteSpace: "nowrap" }}>{h}</th>)}</tr></thead>
                  <tbody>
                    {bucket.items.map(d => (
                      <tr key={d.id} style={{ borderBottom: "1px solid var(--brd)", cursor: "pointer" }}
                        onClick={() => { navigateToDebtor(d); setAgingModalBucket(null); }}
                        onMouseEnter={e => e.currentTarget.style.background = "var(--hover)"}
                        onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                        <td style={{ padding: "8px 10px", fontWeight: 500 }}>{d.name}</td>
                        <td style={{ padding: "8px 10px" }}><BrandBadge code={d.brand} brands={config.brands} /></td>
                        <td style={{ padding: "8px 10px" }}>{d.assignee}</td>
                        <td className="mono" style={{ padding: "8px 10px", fontWeight: 600, color: bucket.color }}>{d.agingDays}일</td>
                        <td className="mono" style={{ padding: "8px 10px", color: "var(--tm)" }}>{d.lastPaymentDate ? fmtDate(d.lastPaymentDate) : "-"}</td>
                        <td className="mono" style={{ padding: "8px 10px", fontWeight: 600 }}>{fmt(d.finalBalanceLegal)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Overlay>
          );
        })()}
        {/* ── 월별 회수실적 차트 ── */}
        <SectionHeader sectionId="collection">회수현황</SectionHeader>
        {!collapsedSections.has("collection") && (() => {
          const fmtBar = (v) => { if (!v) return ""; if (v >= 100000000) return `${(v/100000000).toFixed(1)}억`; return `${Math.round(v/10000)}만`; };
          const CHART_H = 180;
          const nowMonth = new Date().getMonth() + 1;
          const nowYear = new Date().getFullYear();
          const CHART_BRANDS = [{ code: 'B', name: '바로고' }, { code: 'D', name: '딜버' }, { code: 'M', name: '모아라인' }];

          const getCC = (year, month, brand, channel) =>
            collectionChannels[`${year}_${month}_${brand}_${channel}`] || 0;

          const monthlyData = Array.from({ length: 12 }, (_, i) => {
            const m = i + 1;
            if (chartYear === nowYear) {
              const cc = stats.monthlyByChannel?.[m];
              const total = (cc?.companyAccount || 0) + (cc?.cashCharge || 0) + (cc?.welcomeDirect || 0);
              const brands = { B: cc?.byBrand?.B || 0, D: cc?.byBrand?.D || 0, M: cc?.byBrand?.M || 0 };
              return { m, total, brands };
            }
            const total = getCC(chartYear, m, 'all', 'total') || 0;
            const brands = { B: getCC(chartYear, m, 'B', 'total'), D: getCC(chartYear, m, 'D', 'total'), M: getCC(chartYear, m, 'M', 'total') };
            return { m, total, brands };
          });

          const maxVal = Math.max(...monthlyData.map(d => d.total), 1);
          const totalAnnual = monthlyData.reduce((s, d) => s + d.total, 0);

          return (
            <div style={{ background: "var(--card)", borderRadius: 12, padding: 20, border: "1px solid var(--brd)" }}>
              <style>{`.chart-bc-col .chart-bc-tip{opacity:0;transition:opacity 0.12s;}.chart-bc-col:hover .chart-bc-tip{opacity:1;}.chart-bc-col:hover .chart-bc-bar{opacity:0.75;}`}</style>
              {/* 헤더 */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", marginBottom: 14 }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <button onClick={() => setChartYear(y => y - 1)} disabled={chartYear <= 2024}
                      style={{ width: 28, height: 28, borderRadius: 6, border: "1px solid var(--brd)", background: "var(--card)", color: chartYear <= 2024 ? "var(--brd)" : "var(--tp)", cursor: chartYear <= 2024 ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 700 }}>‹</button>
                    <span style={{ fontSize: 13, fontWeight: 700, minWidth: 44, textAlign: "center", color: "var(--tp)" }}>{chartYear}년</span>
                    <button onClick={() => setChartYear(y => y + 1)} disabled={chartYear >= nowYear + 1}
                      style={{ width: 28, height: 28, borderRadius: 6, border: "1px solid var(--brd)", background: "var(--card)", color: chartYear >= nowYear + 1 ? "var(--brd)" : "var(--tp)", cursor: chartYear >= nowYear + 1 ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 700 }}>›</button>
                  </div>
                  {totalAnnual > 0 && <div className="mono" style={{ fontSize: 13, fontWeight: 700, color: "#ef4444" }}>{fmt(totalAnnual)}</div>}
                </div>
              </div>
              {/* 차트 바 */}
              <div style={{ display: "flex", gap: 4, alignItems: "flex-end", height: CHART_H + 52 }}>
                {monthlyData.map(({ m, total, brands }) => {
                  const totalH = total > 0 ? Math.max((total / maxVal) * CHART_H, 8) : 4;
                  const isCurMonth = chartYear === nowYear && m === nowMonth;
                  const isFuture = chartYear === nowYear && m > nowMonth;
                  const hasBrands = CHART_BRANDS.some(b => brands[b.code] > 0);
                  return (
                    <div key={m} className="chart-bc-col"
                      style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2, cursor: "default", position: "relative" }}>
                      {/* CSS hover 툴팁 — JS state 없이 렌더링 */}
                      {total > 0 && (
                        <div className="chart-bc-tip" style={{
                          position: "absolute", bottom: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)",
                          zIndex: 50, pointerEvents: "none",
                          background: "var(--card)", border: "1px solid var(--brd)", borderRadius: 8,
                          padding: "8px 10px", boxShadow: "0 4px 16px rgba(0,0,0,.18)", minWidth: 96, whiteSpace: "nowrap",
                        }}>
                          {hasBrands ? CHART_BRANDS.map(b => (
                            <div key={b.code} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                              <span style={{ fontSize: 10, color: "var(--tm)", flex: 1 }}>{b.name}</span>
                              <span className="mono" style={{ fontSize: 10, fontWeight: 700, color: brands[b.code] > 0 ? "var(--tp)" : "var(--ts)" }}>
                                {brands[b.code] > 0 ? fmtBar(brands[b.code]) : "—"}
                              </span>
                            </div>
                          )) : (
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ fontSize: 10, color: "var(--tm)" }}>합계</span>
                              <span className="mono" style={{ fontSize: 10, fontWeight: 700 }}>{fmtBar(total)}</span>
                            </div>
                          )}
                          <div style={{ position: "absolute", bottom: -5, left: "50%", width: 8, height: 8,
                            background: "var(--card)", border: "1px solid var(--brd)", borderTop: "none", borderLeft: "none",
                            transform: "translateX(-50%) rotate(45deg)" }} />
                        </div>
                      )}
                      <div className="mono" style={{ fontSize: 10, color: isCurMonth ? "var(--acc)" : "var(--ts)", fontWeight: isCurMonth ? 700 : 500, textAlign: "center", lineHeight: 1.2, minHeight: 28, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end" }}>
                        {total > 0 ? fmtBar(total) : ""}
                      </div>
                      <div className="chart-bc-bar" style={{ width: "100%", height: totalH, borderRadius: "4px 4px 0 0",
                        transition: "height 0.35s ease, opacity 0.12s",
                        background: isFuture || total === 0 ? "var(--bg)"
                          : (chartYear % 3 === 0) ? "linear-gradient(180deg,#60a5fa,#2563eb)"
                          : (chartYear % 3 === 1) ? "linear-gradient(180deg,#a78bfa,#7c3aed)"
                          : "linear-gradient(180deg,#34d399,#059669)" }} />
                      <div style={{ width: "100%", height: 1, background: "var(--brd)" }} />
                      <div style={{ fontSize: 11, color: isCurMonth ? "var(--acc)" : "var(--tm)", fontWeight: isCurMonth ? 700 : 400, marginTop: 2 }}>{m}월</div>
                      {isCurMonth && <div style={{ width: 4, height: 4, borderRadius: "50%", background: "var(--acc)" }} />}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}
        {/* ── 담당자 성과 리더보드 ── */}
        <SectionHeader sectionId="leaderboard">담당자별 실적</SectionHeader>
        {!collapsedSections.has("leaderboard") && (
          <div style={{ background: "var(--card)", borderRadius: 12, padding: 20, border: "1px solid var(--brd)" }}>
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
              <button onClick={() => { const n = new Date(); setAssigneeMonthlyModal({ year: n.getFullYear(), month: n.getMonth() + 1 }); }}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 8, border: "1px solid var(--brd)", background: "var(--bg)", color: "var(--tp)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                onMouseEnter={e => e.currentTarget.style.background = "var(--hover)"}
                onMouseLeave={e => e.currentTarget.style.background = "var(--bg)"}>
                <I name="pieChart" size={14} />월별 회수액
              </button>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "var(--bg2)" }}>
                    {["순위", "담당자", "이번달 회수액", "연간 회수액", "지난달 회수액", "전월대비", "월간 목표", "연간 목표", "월간 달성률", "연간 달성률"].map((h, i) => (
                      <th key={h} style={{ padding: "8px 10px", textAlign: i === 1 ? "left" : "center", fontSize: 11, color: "var(--tm)", borderBottom: "1px solid var(--brd)", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {assigneeStats.map((a, i) => (
                    <tr key={a.assignee} style={{ borderBottom: "1px solid var(--brd)" }}>
                      <td style={{ padding: "10px", textAlign: "center", fontWeight: 700, color: i === 0 ? "#f59e0b" : "var(--tm)" }}>{i + 1}</td>
                      <td style={{ padding: "10px", fontWeight: 600 }}>{a.assignee}</td>
                      <td className="mono" style={{ padding: "10px", textAlign: "center", fontWeight: 700 }}>{fmt(a.thisMonth)}</td>
                      <td className="mono" style={{ padding: "10px", textAlign: "center", fontWeight: 700 }}>{fmt(a.thisYear)}</td>
                      <td className="mono" style={{ padding: "10px", textAlign: "center", color: "var(--tm)" }}>{fmt(a.lastMonth)}</td>
                      <td className="mono" style={{ padding: "10px", textAlign: "center", fontWeight: 700, color: a.momRate > 0 ? "#10b981" : a.momRate < 0 ? "#ef4444" : "var(--tm)" }}>
                        {a.momRate > 0 ? "▲" : a.momRate < 0 ? "▼" : "–"} {Math.abs(a.momRate).toFixed(1)}%
                      </td>
                      <td style={{ padding: "10px", textAlign: "center" }}>
                        <input type="text" inputMode="numeric" value={a.target ? a.target.toLocaleString("ko-KR") : ""}
                          onChange={e => { const n = Number(e.target.value.replace(/[^0-9]/g, "")); setAssigneeTarget(a.assignee, "monthlyTarget", isNaN(n) ? 0 : n); }}
                          placeholder="목표 미설정"
                          style={{ width: 110, textAlign: "right", padding: "5px 8px", borderRadius: 6, border: "1px solid var(--brd)", background: "var(--bg)", fontSize: 12, color: "var(--tp)" }} />
                      </td>
                      <td style={{ padding: "10px", textAlign: "center" }}>
                        <input type="text" inputMode="numeric" value={a.annualTarget ? a.annualTarget.toLocaleString("ko-KR") : ""}
                          onChange={e => { const n = Number(e.target.value.replace(/[^0-9]/g, "")); setAssigneeTarget(a.assignee, "annualTarget", isNaN(n) ? 0 : n); }}
                          placeholder="목표 미설정"
                          style={{ width: 110, textAlign: "right", padding: "5px 8px", borderRadius: 6, border: "1px solid var(--brd)", background: "var(--bg)", fontSize: 12, color: "var(--tp)" }} />
                      </td>
                      <td style={{ padding: "10px", textAlign: "center" }}>
                        {a.achieveRate == null ? <span style={{ color: "var(--tm)", fontSize: 12 }}>-</span> : (
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                            <span className="mono" style={{ fontWeight: 700, fontSize: 13, color: a.achieveRate >= 100 ? "#10b981" : "var(--tp)" }}>{a.achieveRate.toFixed(1)}%</span>
                            <div style={{ width: 80, height: 6, background: "var(--bg)", borderRadius: 3, overflow: "hidden" }}>
                              <div style={{ width: `${Math.min(100, a.achieveRate)}%`, height: "100%", background: a.achieveRate >= 100 ? "#10b981" : "#3b82f6" }} />
                            </div>
                          </div>
                        )}
                      </td>
                      <td style={{ padding: "10px", textAlign: "center" }}>
                        {a.annualAchieveRate == null ? <span style={{ color: "var(--tm)", fontSize: 12 }}>-</span> : (
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                            <span className="mono" style={{ fontWeight: 700, fontSize: 13, color: a.annualAchieveRate >= 100 ? "#10b981" : "var(--tp)" }}>{a.annualAchieveRate.toFixed(1)}%</span>
                            <div style={{ width: 80, height: 6, background: "var(--bg)", borderRadius: 3, overflow: "hidden" }}>
                              <div style={{ width: `${Math.min(100, a.annualAchieveRate)}%`, height: "100%", background: a.annualAchieveRate >= 100 ? "#10b981" : "#3b82f6" }} />
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {assigneeMonthlyModal && (() => {
          const { year, month } = assigneeMonthlyModal;
          const debtorAssignee = {};
          data.debtors.forEach(d => { debtorAssignee[d.id] = d.assignee; });
          const rows = config.assignees.map((a, i) => {
            const amount = data.payments
              .filter(p => p.debtorId && debtorAssignee[p.debtorId] === a && p.paymentDate)
              .filter(p => { const pd = new Date(p.paymentDate); return pd.getFullYear() === year && pd.getMonth() + 1 === month; })
              .reduce((s, p) => s + (p.totalAmount || 0), 0);
            return { assignee: a, amount, color: ASSIGNEE_COLORS[i % ASSIGNEE_COLORS.length] };
          }).sort((a, b) => b.amount - a.amount);
          const total = rows.reduce((s, r) => s + r.amount, 0);
          let acc = 0;
          const gradient = total > 0 ? rows.map(r => {
            const pct = (r.amount / total) * 100;
            const from = acc; acc += pct;
            return `${r.color} ${from}% ${acc}%`;
          }).join(", ") : "var(--bg2) 0% 100%";
          const shiftMonth = (delta) => {
            let y = year, m = month + delta;
            if (m < 1) { m = 12; y -= 1; } else if (m > 12) { m = 1; y += 1; }
            setAssigneeMonthlyModal({ year: y, month: m });
          };
          return (
            <Overlay onClose={() => setAssigneeMonthlyModal(null)}>
              <ModalHeader title="담당자별 월별 회수액" onClose={() => setAssigneeMonthlyModal(null)} />
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 20 }}>
                <button onClick={() => shiftMonth(-1)} style={{ width: 28, height: 28, borderRadius: 6, border: "1px solid var(--brd)", background: "var(--card)", cursor: "pointer", fontSize: 16, fontWeight: 700, color: "var(--tp)" }}>‹</button>
                <span style={{ fontSize: 15, fontWeight: 700, minWidth: 90, textAlign: "center" }}>{year}년 {month}월</span>
                <button onClick={() => shiftMonth(1)} style={{ width: 28, height: 28, borderRadius: 6, border: "1px solid var(--brd)", background: "var(--card)", cursor: "pointer", fontSize: 16, fontWeight: 700, color: "var(--tp)" }}>›</button>
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 32 }}>
                <div style={{ width: 160, height: 160, borderRadius: "50%", background: `conic-gradient(${gradient})`, flexShrink: 0 }} />
                <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 160 }}>
                  {total === 0 && <div style={{ fontSize: 12, color: "var(--tm)" }}>해당 월 회수 내역이 없습니다.</div>}
                  {rows.map(r => (
                    <div key={r.assignee} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 10, height: 10, borderRadius: "50%", background: r.color, flexShrink: 0 }} />
                      <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{r.assignee}</span>
                      <span className="mono" style={{ fontSize: 12, fontWeight: 700 }}>{fmt(r.amount)}</span>
                      <span className="mono" style={{ fontSize: 11, color: "var(--tm)", minWidth: 40, textAlign: "right" }}>{total > 0 ? `${((r.amount / total) * 100).toFixed(1)}%` : "-"}</span>
                    </div>
                  ))}
                </div>
              </div>
            </Overlay>
          );
        })()}
        {/* 마지막 카드가 화면 하단에 바짝 붙어 잘려 보이지 않도록 여유 공간 확보 */}
        <div style={{ height: 24 }} />
      </div>
    );
  };

  // ─── Issues View (주요현안: 강제집행/신용분석/협의/TodoList) ─
  // 주의: <IssuesView/>처럼 JSX 컴포넌트로 렌더링하면 App()이 리렌더링될 때마다(예: 입력 필드 타이핑 시)
  // 매번 새 함수 레퍼런스가 되어 React가 하위 트리를 통째로 마운트 해제 후 재마운트한다 —
  // 이 때문에 한글 입력 중 커서가 초기화되어 글자 순서가 뒤섞이는 버그가 있었다.
  // 컴포넌트가 아니라 값으로 즉시 호출해 그 결과(JSX 엘리먼트)를 그대로 끼워 넣으면 재마운트가 없다.
  const issuesView = (() => {
    const canDelete = ["배현진", "김준원"].includes(currentUser?.name);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <ForcedExecutionTable rows={data.forcedExecutions} users={users} brands={config.brands} addKeyIssue={addKeyIssue} updateKeyIssue={updateKeyIssue} deleteKeyIssue={deleteKeyIssue} canDelete={canDelete} />
        <CreditAnalysisTable rows={data.creditAnalyses} users={users} brands={config.brands} addKeyIssue={addKeyIssue} updateKeyIssue={updateKeyIssue} deleteKeyIssue={deleteKeyIssue} canDelete={canDelete} />
        <NegotiationTable rows={data.negotiations} debtors={data.debtors} brands={config.brands} addKeyIssue={addKeyIssue} updateKeyIssue={updateKeyIssue} deleteKeyIssue={deleteKeyIssue} canDelete={canDelete} currentUserName={currentUser?.name} />
        <TodoListTable rows={data.todoList || []} users={users} addKeyIssue={addKeyIssue} updateKeyIssue={updateKeyIssue} deleteKeyIssue={deleteKeyIssue} canDelete={canDelete} />
      </div>
    );
  })();

  // ─── 공통: 채무자 검색 드롭다운 (폼 내부용) ──────────────
  const DebtorSearchField = useStableComponent(({ value, onChange, label = "채무자 연결" }) => {
    const [q, setQ] = useState(value ? (data.debtors.find(d => d.id === value)?.name || "") : "");
    const [open, setOpen] = useState(false);
    const candidates = useMemo(() => {
      if (!q.trim()) return data.debtors.slice(0, 20);
      const lq = q.toLowerCase();
      return data.debtors.filter(d => d.name.toLowerCase().includes(lq) || (d.hubName||"").includes(lq)).slice(0, 30);
    }, [q]);
    return (
      <div style={{ position: "relative" }}>
        <KoreanInput value={q} onChange={e => { setQ(e.target.value); setOpen(true); onChange(null); }}
          onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 180)}
          placeholder="채무자명 검색 (선택 시 연결)"
          style={{ ...inp, borderColor: value ? "var(--ok)" : undefined }} />
        {open && candidates.length > 0 && (
          <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 200, background: "var(--card)", border: "1px solid var(--brd)", borderRadius: 8, maxHeight: 180, overflowY: "auto", boxShadow: "0 4px 16px rgba(0,0,0,.1)" }}>
            {candidates.map(d => (
              <div key={d.id} onMouseDown={() => { onChange(d.id); setQ(d.name); setOpen(false); }}
                style={{ padding: "7px 12px", fontSize: 12, cursor: "pointer", display: "flex", gap: 8, alignItems: "center", borderBottom: "1px solid var(--brd)" }}
                onMouseEnter={e => e.currentTarget.style.background = "var(--hover)"}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <BrandBadge code={d.brand} brands={config.brands} />
                <span style={{ fontWeight: 600 }}>{d.name}</span>
                <span style={{ color: "var(--ts)", fontSize: 11 }}>{d.hubName}</span>
                <span style={{ flex: 1 }} />
                <span className="mono" style={{ color: "var(--ok)", fontSize: 11 }}>{fmt(d.finalBalanceLegal)}</span>
              </div>
            ))}
          </div>
        )}
        {value && <div style={{ fontSize: 11, color: "var(--ok)", marginTop: 3 }}>연결됨 ✓</div>}
      </div>
    );
  });

  // ─── 분할상환 추가 모달 ────────────────────────────────────
  const InstallmentAddModal = useStableComponent(() => {
    const initDebtorId = modal?.debtorId || "";
    const [debtorId, setDebtorId] = useState(initDebtorId);
    const [firstDueDate, setFirstDueDate] = useState(today());
    const [amountStr, setAmountStr] = useState("");
    const [repeat, setRepeat] = useState(false);
    const [repeatInterval, setRepeatInterval] = useState("매월");
    const [endDate, setEndDate] = useState("");
    const [useEndOfMonth, setUseEndOfMonth] = useState(false);
    const [memo, setMemo] = useState("");
    const [saving, setSaving] = useState(false);

    // 로컬 날짜 포맷 — toISOString()은 UTC 기준이라 UTC+9에서 하루 밀림
    const localStr = (d) => {
      if (!d || isNaN(d.getTime())) return "";
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    };

    const debtor = data.debtors.find(d => d.id === debtorId);
    const parsedAmount = Number(amountStr.replace(/,/g, "")) || 0;
    const totalClaim = debtor?.finalBalanceLegal || 0;
    const count = totalClaim > 0 && parsedAmount > 0 ? Math.ceil(totalClaim / parsedAmount) : 0;

    const firstDay = firstDueDate ? new Date(firstDueDate + "T00:00:00").getDate() : 0;
    const showEndOfMonthToggle = repeatInterval === "매월" && firstDay >= 28;

    const addNIntervals = (dateStr, interval, n, endOfMonth = false) => {
      if (!dateStr || n <= 0) return dateStr;
      const d = new Date(dateStr + "T00:00:00");
      if (isNaN(d.getTime())) return "";
      if (interval === "매주") d.setDate(d.getDate() + 7 * n);
      else if (interval === "격주") d.setDate(d.getDate() + 14 * n);
      else if (interval === "매월") {
        const origDay = endOfMonth ? 31 : d.getDate();
        const ny = d.getFullYear() + Math.floor((d.getMonth() + n) / 12);
        const nm = (d.getMonth() + n) % 12;
        const lastDay = new Date(ny, nm + 1, 0).getDate();
        d.setFullYear(ny, nm, Math.min(origDay, lastDay));
      } else if (interval === "매년") {
        d.setFullYear(d.getFullYear() + n);
      }
      if (isNaN(d.getTime())) return "";
      return localStr(d);
    };

    const cappedCount = Math.min(count, 1200);
    const suggestedEndDate = cappedCount > 1 && firstDueDate ? addNIntervals(firstDueDate, repeatInterval, cappedCount - 1, useEndOfMonth) : "";

    const generateDates = () => {
      if (!firstDueDate) return [];
      if (!repeat || !endDate) return [firstDueDate];
      const endD = new Date(endDate + "T00:00:00");
      if (isNaN(endD.getTime())) return [firstDueDate];
      const dates = [];
      const MAX = 1200;
      if (repeatInterval === "매월") {
        const origDay = useEndOfMonth ? 31 : new Date(firstDueDate + "T00:00:00").getDate();
        let cur = new Date(firstDueDate + "T00:00:00");
        while (dates.length < MAX) {
          if (isNaN(cur.getTime()) || cur > endD) break;
          dates.push(localStr(cur));
          const nm = (cur.getMonth() + 1) % 12;
          const ny = cur.getMonth() === 11 ? cur.getFullYear() + 1 : cur.getFullYear();
          const lastDay = new Date(ny, nm + 1, 0).getDate();
          cur = new Date(ny, nm, Math.min(origDay, lastDay));
        }
      } else if (repeatInterval === "매년") {
        const origDay = new Date(firstDueDate + "T00:00:00").getDate();
        const origMonth = new Date(firstDueDate + "T00:00:00").getMonth();
        let cur = new Date(firstDueDate + "T00:00:00");
        while (dates.length < MAX) {
          if (isNaN(cur.getTime()) || cur > endD) break;
          dates.push(localStr(cur));
          cur = new Date(cur.getFullYear() + 1, origMonth, origDay);
        }
      } else {
        const iv = repeatInterval === "매주" ? 7 : 14;
        let cur = new Date(firstDueDate + "T00:00:00");
        while (dates.length < MAX) {
          if (isNaN(cur.getTime()) || cur > endD) break;
          dates.push(localStr(cur));
          cur.setDate(cur.getDate() + iv);
        }
      }
      return dates;
    };

    const previewDates = generateDates();

    const handleSave = async () => {
      if (!debtorId) return showToast("채무자를 선택하세요");
      if (!firstDueDate) return showToast("첫 납부 예정일을 입력하세요");
      const existingPlan = data.installmentPlans.find(p => p.debtorId === debtorId);
      if (existingPlan) return showToast("이미 분할상환 플랜이 있습니다. 일정을 직접 추가하세요.");
      setSaving(true);
      try {
        const planId = uid("INS");
        const pr = await fetch("/api/installments", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: planId, debtorId, paymentTiming: useEndOfMonth ? "말일" : "", monthlyAmount: parsedAmount, startDate: firstDueDate, status: "진행중", memo }),
        });
        const pResult = await pr.json();
        if (!pResult.ok) { showToast(pResult.error || "플랜 생성 실패"); setSaving(false); return; }
        if (previewDates.length > 0) {
          const schedules = previewDates.map((d, idx) => {
            let amt = parsedAmount;
            if (totalClaim > 0 && parsedAmount > 0 && previewDates.length > 1 && idx === previewDates.length - 1) {
              const remainder = totalClaim - (previewDates.length - 1) * parsedAmount;
              if (remainder > 0 && remainder < parsedAmount) amt = remainder;
            }
            return { id: "SCH" + Math.random().toString(36).slice(2, 11).toUpperCase(), dueDate: d, dueMonth: d.slice(0, 7), scheduledAmount: amt, status: "예정", memo: "" };
          });
          const sr = await fetch("/api/installments/schedules/batch", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ planId, schedules }),
          });
          const sResult = await sr.json();
          if (!sResult.ok) showToast(sResult.error || "일정 생성 오류");
        }
        await reloadInstallments();
        setModal(null);
        showToast(`플랜 추가 완료${previewDates.length > 1 ? ` (일정 ${previewDates.length}건)` : ""}`);
      } catch(e) { showToast("저장 실패"); setSaving(false); }
    };

    return (
      <Overlay onClose={() => setModal(null)}>
        <ModalHeader title="분할상환 플랜 추가" onClose={() => setModal(null)} />
        <div style={{ display: "grid", gap: 12 }}>
          <Field label="채무자 연결"><DebtorSearchField value={debtorId} onChange={setDebtorId} /></Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="첫 납부 예정일">
              <input type="date" value={firstDueDate} onChange={e => { setFirstDueDate(e.target.value); setUseEndOfMonth(false); }} style={inp} />
            </Field>
            <Field label="1회 납부액(원)">
              <MoneyInput value={amountStr} onChange={setAmountStr} style={inp} placeholder="예: 300,000" />
            </Field>
          </div>
          {showEndOfMonthToggle && (
            <div style={{ padding: "8px 12px", background: "#fff7ed", borderRadius: 8, border: "1px solid #fed7aa", fontSize: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ color: "#92400e", fontWeight: 600 }}>매월 납부일:</span>
              {[false, true].map(eom => (
                <button key={String(eom)} onClick={() => setUseEndOfMonth(eom)}
                  style={{ padding: "4px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", border: "1px solid", borderColor: useEndOfMonth === eom ? "#f97316" : "var(--brd)", background: useEndOfMonth === eom ? "#f97316" : "var(--bg)", color: useEndOfMonth === eom ? "#fff" : "var(--tp)" }}>
                  {eom ? "말일" : `${firstDay}일 고정`}
                </button>
              ))}
              <span style={{ fontSize: 11, color: "#92400e" }}>{useEndOfMonth ? "매달 마지막 날에 납부" : `매달 ${firstDay}일에 납부 (짧은 달은 말일)`}</span>
            </div>
          )}
          {debtor && (
            <div style={{ padding: "8px 12px", background: "var(--bg2)", borderRadius: 8, fontSize: 12, color: "var(--ts)" }}>
              총 채권액: <b style={{ color: "var(--tp)" }}>{fmt(debtor.finalBalanceLegal)}</b>
              {count > 0 && (() => {
                const lastAmt = totalClaim - (count - 1) * parsedAmount;
                return <span> · 예상 <b style={{ color: "var(--acc)" }}>{count}회</b> 납부{lastAmt > 0 && lastAmt < parsedAmount ? <span style={{ color: "var(--tm)" }}> (마지막 {fmt(lastAmt)}원)</span> : ""}</span>;
              })()}
            </div>
          )}
          <div style={{ borderRadius: 8, border: "1px solid var(--brd)", overflow: "hidden" }}>
            <div onClick={() => setRepeat(p => !p)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", cursor: "pointer", background: repeat ? "#3b82f610" : "var(--bg2)", userSelect: "none" }}>
              <div style={{ width: 16, height: 16, borderRadius: 4, border: `2px solid ${repeat ? "var(--acc)" : "var(--brd)"}`, background: repeat ? "var(--acc)" : "transparent", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {repeat && <span style={{ color: "#fff", fontSize: 10, fontWeight: 700 }}>✓</span>}
              </div>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--tp)" }}>되풀이 일정 등록</span>
              {repeat && endDate && <span style={{ fontSize: 11, color: "var(--acc)", marginLeft: "auto" }}>{repeatInterval}{useEndOfMonth ? " (말일)" : ""} · {previewDates.length}건</span>}
            </div>
            {repeat && (
              <div style={{ padding: "12px", borderTop: "1px solid var(--brd)", display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", gap: 5 }}>
                  {["매주", "격주", "매월", "매년"].map(t => (
                    <button key={t} onClick={() => setRepeatInterval(t)} style={{ flex: 1, padding: "6px 0", borderRadius: 7, fontSize: 12, fontWeight: 600, border: "1px solid var(--brd)", cursor: "pointer", background: repeatInterval === t ? "var(--acc)" : "var(--bg2)", color: repeatInterval === t ? "#fff" : "var(--tp)" }}>{t}</button>
                  ))}
                </div>
                <Field label="종료일">
                  <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={inp} />
                </Field>
                {suggestedEndDate && (
                  <div style={{ padding: "7px 10px", background: "#3b82f612", borderRadius: 6, fontSize: 11, color: "var(--acc)", display: "flex", alignItems: "center", gap: 6 }}>
                    <span>자동 추천: <b>{suggestedEndDate}</b> (총 {cappedCount}회)</span>
                    <button onClick={() => setEndDate(suggestedEndDate)} style={{ marginLeft: "auto", padding: "2px 8px", borderRadius: 5, fontSize: 11, background: "var(--acc)", color: "#fff", border: "none", cursor: "pointer" }}>적용</button>
                  </div>
                )}
                {previewDates.length > 1 && (
                  <div style={{ fontSize: 11, color: "var(--tm)", lineHeight: 1.7 }}>
                    <b>총 {previewDates.length}건</b> 생성 예정: {previewDates.slice(0, 5).map(d => d.slice(5).replace("-", "/")).join(", ")}{previewDates.length > 5 ? ` … 외 ${previewDates.length - 5}건` : ""}
                  </div>
                )}
              </div>
            )}
          </div>
          <Field label="메모"><KoreanTextarea value={memo} onChange={e => setMemo(e.target.value)} style={{ ...inp, height: 60, resize: "vertical" }} placeholder="메모 (선택)" /></Field>
        </div>
        <ModalFooter onCancel={() => setModal(null)} onSave={handleSave} saveLabel={saving ? "저장중…" : repeat && previewDates.length > 1 ? `플랜 추가 (일정 ${previewDates.length}건)` : "플랜 추가"} />
      </Overlay>
    );
  });

  // ─── 회생/파산 추가 모달 ──────────────────────────────────
  const RehabAddModal = useStableComponent(() => {
    const [f, setF] = useState({ debtorId: "", type: "회생", court: "", caseNumber: "", creditorNumber: "", debtAmount: "", approvedAmount: "", monthlyPayment: "", currentRound: "", repaymentNote: "" });
    const set = (k, v) => setF(p => ({ ...p, [k]: v }));
    const debtor = data.debtors.find(d => d.id === f.debtorId);
    const handleSave = () => {
      if (!f.caseNumber.trim()) return showToast("사건번호를 입력하세요");
      const rec = {
        id:              uid("MRH"),
        debtorId:        f.debtorId || null,
        debtorName:      debtor?.name || "미연결",
        brand:           debtor?.brand || "",
        court:           f.court,
        caseNumber:      f.caseNumber,
        type:            f.type,
        creditorNumber:  f.creditorNumber,
        planApproved:    false,
        dismissed:       false,
        debtAmount:      Number(f.debtAmount) || 0,
        approvedAmount:  Number(f.approvedAmount) || 0,
        currentRound:    f.currentRound,
        monthlyPayment:  Number(f.monthlyPayment) || 0,
        repaymentNote:   f.repaymentNote,
        overdueStatus:   "",
      };
      addMR(MK.rehabilitations, rec);
      setData(prev => ({ ...prev, rehabilitations: [rec, ...prev.rehabilitations] }));
      setModal(null);
      showToast("회생/파산 추가 완료");
    };
    return (
      <Overlay onClose={() => setModal(null)} wide>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <span style={{ fontSize: 16, fontWeight: 700 }}>회생/파산 추가</span>
          <button onClick={() => setModal(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--tm)" }}><I name="close" size={18} /></button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="채무자 연결" span={2}><DebtorSearchField value={f.debtorId} onChange={v => set("debtorId", v)} /></Field>
          <Field label="유형">
            <div style={{ display: "flex", gap: 6 }}>
              {["회생", "파산/면책"].map(t => <button key={t} onClick={() => set("type", t)} style={{ flex: 1, padding: "6px 0", borderRadius: 7, fontSize: 12, fontWeight: 600, background: f.type === t ? "var(--acc)" : "var(--bg2)", color: f.type === t ? "#fff" : "var(--tp)", border: "1px solid var(--brd)", cursor: "pointer" }}>{t}</button>)}
            </div>
          </Field>
          <Field label="채권자번호"><KoreanInput value={f.creditorNumber} onChange={e => set("creditorNumber", e.target.value)} style={inp} placeholder="예: 18" /></Field>
          <Field label="법원"><KoreanInput value={f.court} onChange={e => set("court", e.target.value)} style={inp} placeholder="예: 수원회생법원" /></Field>
          <Field label="사건번호"><KoreanInput value={f.caseNumber} onChange={e => set("caseNumber", e.target.value)} style={inp} placeholder="예: 2024개회12345" /></Field>
          <Field label="채무액(원)"><MoneyInput value={f.debtAmount} onChange={v => set("debtAmount", v)} style={inp} /></Field>
          <Field label="인가액(원)"><MoneyInput value={f.approvedAmount} onChange={v => set("approvedAmount", v)} style={inp} /></Field>
          <Field label="월 납부액(원)"><MoneyInput value={f.monthlyPayment} onChange={v => set("monthlyPayment", v)} style={inp} /></Field>
          <Field label="현재 회차"><KoreanInput value={f.currentRound} onChange={e => set("currentRound", e.target.value)} style={inp} placeholder="예: 12회차" /></Field>
          <Field label="비고" span={2}><KoreanTextarea value={f.repaymentNote} onChange={e => set("repaymentNote", e.target.value)} style={{ ...inp, height: 64, resize: "vertical" }} /></Field>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}>
          <button onClick={() => setModal(null)} style={{ padding: "8px 18px", borderRadius: 8, background: "var(--bg2)", color: "var(--tp)", border: "1px solid var(--brd)", cursor: "pointer" }}>취소</button>
          <button onClick={handleSave} style={{ padding: "8px 18px", borderRadius: 8, background: "var(--acc)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600 }}>저장</button>
        </div>
      </Overlay>
    );
  });

  // ─── 법적절차 추가 모달 ────────────────────────────────────
  const LegalAddModal = useStableComponent(() => {
    const initType = modal?.legalType || "압류";
    const [f, setF] = useState({ type: initType, brand: config.brands[0]?.code || "B", defendant: "", debtorId: "", court: "", caseNumber: "", caseStatus: "채권자", filingDate: today(), progressStatus: "진행", applicationDate: today(), decisionDate: "", status: "", hasInquiryOrder: false });
    const set = (k, v) => setF(p => ({ ...p, [k]: v }));
    const debtor = data.debtors.find(d => d.id === f.debtorId);
    const isAD = f.type === "재산명시";
    const handleSave = () => {
      if (!f.caseNumber.trim()) return showToast("사건번호를 입력하세요");
      if (!isAD && !f.defendant.trim() && !f.debtorId) return showToast("채무자명 또는 채무자 연결이 필요합니다");
      if (isAD && !f.defendant.trim() && !f.debtorId) return showToast("채무자명 또는 채무자 연결이 필요합니다");

      let rec;
      if (isAD) {
        rec = {
          id: uid("MAD"), type: "재산명시", brand: f.brand, debtorName: debtor?.name || f.defendant,
          court: f.court, caseNumber: f.caseNumber, applicationDate: f.applicationDate,
          decisionDate: f.decisionDate, result: "", status: f.status, withdrawReason: "",
          detentionDecision: "", propertyList: "", propertyListDesc: "", executionExpiration: "",
          inquiryResult: "", inquiryApplicationDate: "", inquiryOrderDate: f.hasInquiryOrder ? today() : "",
          hasInquiryOrder: f.hasInquiryOrder, inquiryResponse: "", debtorId: f.debtorId || null,
        };
        addMR(MK.assetDisclosures, rec);
        setData(prev => ({ ...prev, assetDisclosures: [rec, ...prev.assetDisclosures] }));
      } else {
        rec = {
          id: uid("MLC"), type: f.type, brand: f.brand, court: f.court, caseNumber: f.caseNumber,
          caseStatus: f.caseStatus, filingDate: f.filingDate, plaintiff: config.brands.find(b => b.code === f.brand)?.name || "",
          defendant: debtor?.name || f.defendant, hearingTime: "", hearingLocation: "",
          progressStatus: f.progressStatus, debtorId: f.debtorId || null,
        };
        addMR(MK.legalCases, rec);
        setData(prev => ({ ...prev, legalCases: [rec, ...prev.legalCases] }));
      }
      setModal(null);
      showToast(`${f.type} 추가 완료`);
    };
    return (
      <Overlay onClose={() => setModal(null)} wide>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <span style={{ fontSize: 16, fontWeight: 700 }}>법적절차 추가</span>
          <button onClick={() => setModal(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--tm)" }}><I name="close" size={18} /></button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="절차 유형" span={2}>
            <div style={{ display: "flex", gap: 6 }}>
              {["지급명령","압류","재산명시","형사고소"].map(t => <button key={t} onClick={() => set("type", t)} style={{ flex: 1, padding: "6px 0", borderRadius: 7, fontSize: 12, fontWeight: 600, background: f.type === t ? "var(--acc)" : "var(--bg2)", color: f.type === t ? "#fff" : "var(--tp)", border: "1px solid var(--brd)", cursor: "pointer" }}>{t}</button>)}
            </div>
          </Field>
          <Field label="브랜드">
            <select value={f.brand} onChange={e => set("brand", e.target.value)} style={inp}>
              {config.brands.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}
            </select>
          </Field>
          {!isAD && <Field label="사건지위">
            <select value={f.caseStatus} onChange={e => set("caseStatus", e.target.value)} style={inp}>
              {["채권자","원고","피고"].map(s => <option key={s}>{s}</option>)}
            </select>
          </Field>}
          <Field label="법원" span={isAD ? 2 : 1}><KoreanInput value={f.court} onChange={e => set("court", e.target.value)} style={inp} placeholder="예: 서울중앙지법" /></Field>
          <Field label="사건번호" span={2}><KoreanInput value={f.caseNumber} onChange={e => set("caseNumber", e.target.value)} style={inp} placeholder="예: 2026타채125019" /></Field>
          <Field label="채무자 연결" span={2}><DebtorSearchField value={f.debtorId} onChange={v => set("debtorId", v)} /></Field>
          {!f.debtorId && <Field label={isAD ? "대상자명" : "피고/채무자명"} span={2}><KoreanInput value={f.defendant} onChange={e => set("defendant", e.target.value)} style={inp} placeholder="채무자 연결 없이 이름만 입력" /></Field>}
          {!isAD && <>
            <Field label="접수일"><input type="date" value={f.filingDate} onChange={e => set("filingDate", e.target.value)} style={inp} /></Field>
            <Field label="진행상황"><KoreanInput value={f.progressStatus} onChange={e => set("progressStatus", e.target.value)} style={inp} /></Field>
          </>}
          {isAD && <>
            <Field label="신청일"><input type="date" value={f.applicationDate} onChange={e => set("applicationDate", e.target.value)} style={inp} /></Field>
            <Field label="결정일"><input type="date" value={f.decisionDate} onChange={e => set("decisionDate", e.target.value)} style={inp} /></Field>
            <Field label="결과 상태"><KoreanInput value={f.status} onChange={e => set("status", e.target.value)} style={inp} placeholder="예: 취하, 각하" /></Field>
            <Field label="재산조회 명령">
              <div style={{ display: "flex", gap: 6 }}>
                {[true, false].map(v => <button key={String(v)} onClick={() => set("hasInquiryOrder", v)} style={{ flex: 1, padding: "6px 0", borderRadius: 7, fontSize: 12, fontWeight: 600, background: f.hasInquiryOrder === v ? (v ? "#10b981" : "#64748b") : "var(--bg2)", color: f.hasInquiryOrder === v ? "#fff" : "var(--tp)", border: "1px solid var(--brd)", cursor: "pointer" }}>{v ? "O (조회명령 있음)" : "X (없음)"}</button>)}
              </div>
            </Field>
          </>}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}>
          <button onClick={() => setModal(null)} style={{ padding: "8px 18px", borderRadius: 8, background: "var(--bg2)", color: "var(--tp)", border: "1px solid var(--brd)", cursor: "pointer" }}>취소</button>
          <button onClick={handleSave} style={{ padding: "8px 18px", borderRadius: 8, background: "var(--acc)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600 }}>저장</button>
        </div>
      </Overlay>
    );
  });

  // ─── 민사소송 추가 모달 ────────────────────────────────────
  const MinsaAddModal = useStableComponent(() => {
    const [f, setF] = useState({ brand: config.brands[0]?.code || "B", defendant: "", debtorId: "", court: "", caseNumber: "", caseStatus: "원고", filingDate: today(), progressStatus: "진행", plaintiff: "" });
    const set = (k, v) => setF(p => ({ ...p, [k]: v }));
    const debtor = data.debtors.find(d => d.id === f.debtorId);
    const handleSave = () => {
      if (!f.caseNumber.trim()) return showToast("사건번호를 입력하세요");
      const rec = {
        id: uid("MMS"), type: "민사소송", brand: f.brand, court: f.court, caseNumber: f.caseNumber,
        caseStatus: f.caseStatus, filingDate: f.filingDate,
        plaintiff: f.plaintiff || (config.brands.find(b => b.code === f.brand)?.name || ""),
        defendant: debtor?.name || f.defendant, hearingTime: "", hearingLocation: "",
        progressStatus: f.progressStatus, debtorId: f.debtorId || null,
      };
      addMR(MK.minsaCases, rec);
      setData(prev => ({ ...prev, minsaCases: [rec, ...prev.minsaCases] }));
      setModal(null);
      showToast("민사소송 추가 완료");
    };
    return (
      <Overlay onClose={() => setModal(null)} wide>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <span style={{ fontSize: 16, fontWeight: 700 }}>민사소송 추가</span>
          <button onClick={() => setModal(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--tm)" }}><I name="close" size={18} /></button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="브랜드">
            <select value={f.brand} onChange={e => set("brand", e.target.value)} style={inp}>
              {config.brands.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}
            </select>
          </Field>
          <Field label="사건지위">
            <select value={f.caseStatus} onChange={e => set("caseStatus", e.target.value)} style={inp}>
              {["원고","피고","채권자"].map(s => <option key={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="법원"><KoreanInput value={f.court} onChange={e => set("court", e.target.value)} style={inp} placeholder="예: 서울중앙지법" /></Field>
          <Field label="사건번호"><KoreanInput value={f.caseNumber} onChange={e => set("caseNumber", e.target.value)} style={inp} placeholder="예: 2026가단51603" /></Field>
          <Field label="원고(채권자)"><KoreanInput value={f.plaintiff} onChange={e => set("plaintiff", e.target.value)} style={inp} placeholder="자동 입력 (브랜드명)" /></Field>
          <Field label="접수일"><input type="date" value={f.filingDate} onChange={e => set("filingDate", e.target.value)} style={inp} /></Field>
          <Field label="채무자 연결" span={2}><DebtorSearchField value={f.debtorId} onChange={v => set("debtorId", v)} /></Field>
          {!f.debtorId && <Field label="피고(채무자명)" span={2}><KoreanInput value={f.defendant} onChange={e => set("defendant", e.target.value)} style={inp} placeholder="채무자 연결 없이 이름만 입력" /></Field>}
          <Field label="진행상황" span={2}><KoreanInput value={f.progressStatus} onChange={e => set("progressStatus", e.target.value)} style={inp} placeholder="예: 진행, 확정, 취하" /></Field>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}>
          <button onClick={() => setModal(null)} style={{ padding: "8px 18px", borderRadius: 8, background: "var(--bg2)", color: "var(--tp)", border: "1px solid var(--brd)", cursor: "pointer" }}>취소</button>
          <button onClick={handleSave} style={{ padding: "8px 18px", borderRadius: 8, background: "var(--acc)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600 }}>저장</button>
        </div>
      </Overlay>
    );
  });

  // ─── 형사고소 추가 모달 ────────────────────────────────────
  const ComplaintAddModal = useStableComponent(() => {
    const [f, setF] = useState({ brand: config.brands[0]?.code || "B", debtorId: "", debtorName: "", complainant: "", charge: "사기", goodsAmount: "", loanAmount: "", complaintDate: today(), policeStation: "", status: "수사중" });
    const set = (k, v) => setF(p => ({ ...p, [k]: v }));
    const debtor = data.debtors.find(d => d.id === f.debtorId);
    const handleSave = () => {
      if (!f.policeStation.trim() && !f.debtorId && !f.debtorName.trim()) return showToast("채무자 또는 경찰서 정보를 입력하세요");
      const rec = {
        id: uid("MCO"), brand: f.brand, debtorId: f.debtorId || null,
        debtorName: debtor?.name || f.debtorName,
        complainant: f.complainant, charge: f.charge,
        goodsAmount: Number(f.goodsAmount) || 0, loanAmount: Number(f.loanAmount) || 0,
        complaintDate: f.complaintDate, policeStation: f.policeStation, status: f.status,
      };
      addMR(MK.complaints, rec);
      setData(prev => ({ ...prev, complaints: [rec, ...prev.complaints] }));
      setModal(null);
      showToast("형사고소 추가 완료");
    };
    return (
      <Overlay onClose={() => setModal(null)} wide>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <span style={{ fontSize: 16, fontWeight: 700 }}>형사고소 추가</span>
          <button onClick={() => setModal(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--tm)" }}><I name="close" size={18} /></button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="브랜드">
            <select value={f.brand} onChange={e => set("brand", e.target.value)} style={inp}>
              {config.brands.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}
            </select>
          </Field>
          <Field label="죄명">
            <KoreanInput value={f.charge || ""} onChange={e => set("charge", e.target.value)} style={inp} placeholder="예: 사기, 횡령, 배임 등" />
          </Field>
          <Field label="채무자 연결" span={2}><DebtorSearchField value={f.debtorId} onChange={v => set("debtorId", v)} /></Field>
          {!f.debtorId && <Field label="채무자명" span={2}><KoreanInput value={f.debtorName} onChange={e => set("debtorName", e.target.value)} style={inp} /></Field>}
          <Field label="고소인"><KoreanInput value={f.complainant} onChange={e => set("complainant", e.target.value)} style={inp} placeholder="예: 주식회사 바로고" /></Field>
          <Field label="경찰서"><KoreanInput value={f.policeStation} onChange={e => set("policeStation", e.target.value)} style={inp} placeholder="예: 광진경찰서" /></Field>
          <Field label="고소일"><input type="date" value={f.complaintDate} onChange={e => set("complaintDate", e.target.value)} style={inp} /></Field>
          <Field label="진행상황"><KoreanInput value={f.status} onChange={e => set("status", e.target.value)} style={inp} placeholder="수사중, 기소, 불기소 등" /></Field>
          <Field label="물품대(원)"><MoneyInput value={f.goodsAmount} onChange={v => set("goodsAmount", v)} style={inp} /></Field>
          <Field label="대여금(원)"><MoneyInput value={f.loanAmount} onChange={v => set("loanAmount", v)} style={inp} /></Field>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}>
          <button onClick={() => setModal(null)} style={{ padding: "8px 18px", borderRadius: 8, background: "var(--bg2)", color: "var(--tp)", border: "1px solid var(--brd)", cursor: "pointer" }}>취소</button>
          <button onClick={handleSave} style={{ padding: "8px 18px", borderRadius: 8, background: "var(--acc)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600 }}>저장</button>
        </div>
      </Overlay>
    );
  });

  // ─── Debtor List ────────────────────────────────────────
  const debtorListView = (
    <div className="anim" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* 분류별 현황 카드 */}
      {(() => {
        const CC = { "전체":"#6366f1","장기채권":"#f59e0b","추심의뢰":"#3b82f6","회생/파산":"#8b5cf6","협의/소송":"#ef4444","분할상환":"#06b6d4","캐쉬상환":"#10b981","완료":"#6b7280","대손채권":"#ec4899" };
        const cats = ["전체", ...config.categories];
        return (
          <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 2 }}>
            {cats.map(k => {
              const color = CC[k] || "#6b7280";
              const cnt = k === "전체" ? data.debtors.length : data.debtors.filter(d => d.category === k).length;
              const active = catFilter === k;
              return (
                <div key={k} onClick={() => setCatFilter(active && k !== "전체" ? "전체" : k)} style={{ cursor: "pointer", flex: "0 0 auto", minWidth: 95, padding: "10px 14px", borderRadius: 10, border: `1.5px solid ${active ? color : "var(--brd)"}`, background: active ? color + "18" : "var(--card)", transition: "all 0.15s" }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: active ? color : "var(--tm)", whiteSpace: "nowrap", marginBottom: 5 }}>{k}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: active ? color : "var(--tx)", lineHeight: 1 }}>{cnt}</div>
                </div>
              );
            })}
          </div>
        );
      })()}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", background: "var(--card)", borderRadius: 12, padding: 14, border: "1px solid var(--brd)" }}>
        <div style={{ position: "relative", flex: 1, minWidth: 200 }}><div style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--tm)" }}><I name="search" size={14} /></div><KoreanInput value={q} onChange={e => setQ(e.target.value)} placeholder="채무자명, ID, 연대보증인, 허브명, 코드, 히스토리 검색..." style={{ width: "100%", paddingLeft: 32 }} /></div>
        {canEdit && <button onClick={() => setModal({ type: "debtor" })} style={{ padding: "7px 14px", borderRadius: 8, background: "var(--acc)15", color: "var(--acc)", fontSize: 12, fontWeight: 600, border: "1px solid var(--acc)40", cursor: "pointer" }}>등록</button>}
        <button onClick={() => exportDebtors(filtered)} style={{ display: "flex", alignItems: "center", gap: 4, padding: "7px 12px", borderRadius: 8, background: "#10b98118", color: "#10b981", fontSize: 12, fontWeight: 600, border: "1px solid #10b98140" }}><I name="arrowDown" size={14} />엑셀</button>
        <div className="mono" style={{ fontSize: 12, color: "var(--tm)" }}>{filtered.length}건</div>
      </div>
      <div style={{ background: "var(--card)", borderRadius: 12, border: "1px solid var(--brd)", overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ background: "var(--bg2)" }}>
              {[
                { k: "brand", l: "브랜드", w: 60 },
                { k: "category", l: "분류", w: 110 },
                { k: "assignee", l: "담당", w: 50 },
                { k: "name", l: "채무자명", w: 110 },
                { k: "guarantors", l: "연대보증인", w: 100 },
                { k: "hubCode", l: "코드", w: 70 },
                { k: "hubName", l: "허브/지점", w: 130 },
                { k: "debtCause", l: "채무발생원인", w: 90 },
                { k: "principalBalance",   l: "원채무액",      w: 125 },
                { k: "adjustment",         l: "추가법무비용",  w: 120 },
                { k: "collectedAmount",    l: "회수액",        w: 120 },
                { k: "finalBalanceFinance",l: "재무기준잔액",   w: 130 },
                { k: "finalBalanceLegal",  l: "법무기준잔액",   w: 130 },
              ].map(c => (
                <th key={c.k} onClick={() => doSort(c.k)} style={{ padding: "10px 10px", textAlign: "center", fontWeight: 600, fontSize: 11, color: "var(--tm)", cursor: "pointer", whiteSpace: "nowrap", borderBottom: "1px solid var(--brd)", width: c.w, userSelect: "none" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>{c.l}{sort.f === c.k && <I name={sort.d === "asc" ? "arrowUp" : "arrowDown"} size={12} />}</div>
                </th>
              ))}
            </tr></thead>
            <tbody>{paged.map(d => {
              const subs = d.subRows && d.subRows.length > 1 ? d.subRows : null;
              const span = subs ? subs.length : 1;

              if (!subs) {
                return (
                  <tr key={d.id} onClick={() => { setSel(d); setDetailTab("히스토리"); }} style={{ cursor: "pointer", borderBottom: "1px solid var(--brd)" }}
                    onMouseEnter={e => e.currentTarget.style.background = "var(--hover)"}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <td style={{ padding: "10px 10px", textAlign: "center" }}><BrandBadge code={d.brand} brands={config.brands} /></td>
                    <td style={{ padding: "10px 10px", whiteSpace: "nowrap", textAlign: "center" }}><Badge status={d.category} small /></td>
                    <td style={{ padding: "10px 10px", fontSize: 12, textAlign: "center" }}>{d.assignee}</td>
                    <td style={{ padding: "10px 10px", fontWeight: 500, textAlign: "center" }}>{d.name}</td>
                    <td style={{ padding: "10px 10px", fontSize: 11, color: "var(--ts)", textAlign: "center" }}>{d.guarantors?.join(", ") || "-"}</td>
                    <td className="mono" style={{ padding: "10px 10px", fontSize: 11, color: "var(--tm)", textAlign: "center" }}>{d.hubCode}</td>
                    <td style={{ padding: "10px 10px", fontSize: 12, color: "var(--ts)", textAlign: "center" }}>{d.hubName}</td>
                    <td style={{ padding: "10px 10px", fontSize: 12, color: "var(--ts)", textAlign: "center" }}>{d.debtCause || "-"}</td>
                    <td className="mono" style={{ padding: "10px 10px", fontSize: 12, textAlign: "right", whiteSpace: "nowrap" }}>{fmt(d.principalBalance)}</td>
                    <td className="mono" style={{ padding: "10px 10px", fontSize: 12, textAlign: "right", whiteSpace: "nowrap", color: "#f59e0b" }}>{d.adjustment ? fmt(d.adjustment) : "-"}</td>
                    <td className="mono" style={{ padding: "10px 10px", fontSize: 12, textAlign: "right", whiteSpace: "nowrap", color: "var(--ok)" }}>{fmt(d.collectedAmount)}</td>
                    <td className="mono" style={{ padding: "10px 10px", fontSize: 12, textAlign: "right", whiteSpace: "nowrap", color: "#8b5cf6" }}>{fmt(d.finalBalanceFinance)}</td>
                    <td className="mono" style={{ padding: "10px 10px", fontSize: 12, textAlign: "right", whiteSpace: "nowrap", fontWeight: 600, color: "var(--err)" }}>{fmt(d.finalBalanceLegal)}</td>
                  </tr>
                );
              }

              // ── 그룹 행 (같은 이름+브랜드의 다중 항목) ──────────────
              const sharedBg = { background: "transparent", verticalAlign: "middle" };
              return subs.map((sub, si) => {
                const isFirst = si === 0;
                const subLegal = sub.finalBalanceLegal ?? ((sub.principalBalance || 0) - (sub.collectedAmount || 0) + (sub.adjustment || 0));
                return (
                  <tr key={`${d.id}-${si}`} style={{ cursor: "pointer", borderBottom: "1px solid var(--brd)" }}
                    onMouseEnter={e => e.currentTarget.style.background = "var(--hover)"}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                    onClick={() => { setSel(sub); setDetailTab("히스토리"); }}>
                    {isFirst && (
                      <td rowSpan={span} style={{ padding: "10px 10px", borderBottom: "1px solid var(--brd)", textAlign: "center", ...sharedBg }}>
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
                          <BrandBadge code={d.brand} brands={config.brands} />
                          {canEdit && (
                            <button onClick={e => { e.stopPropagation(); setModal({ type: "debtor", data: { brand: d.brand, name: d.name, category: d.category, assignee: d.assignee, hubName: d.hubName } }); }}
                              style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: "var(--acc)22", color: "var(--acc)", border: "1px solid var(--acc)55", cursor: "pointer" }}>
                              +항목
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                    {isFirst && <td rowSpan={span} style={{ padding: "10px 10px", borderBottom: "1px solid var(--brd)", whiteSpace: "nowrap", textAlign: "center", ...sharedBg }}><Badge status={d.category} small /></td>}
                    {isFirst && <td rowSpan={span} style={{ padding: "10px 10px", fontSize: 12, borderBottom: "1px solid var(--brd)", textAlign: "center", ...sharedBg }}>{d.assignee}</td>}
                    {isFirst && (
                      <td rowSpan={span} style={{ padding: "10px 10px", fontWeight: 600, borderBottom: "1px solid var(--brd)", borderRight: "1px solid var(--brd)", textAlign: "center", ...sharedBg }}
                        onClick={e => { e.stopPropagation(); setSel(subs[0]); setDetailTab("히스토리"); }}>
                        {d.name}
                        <div style={{ fontSize: 10, color: "var(--tm)", fontWeight: 400, marginTop: 2 }}>{span}건</div>
                      </td>
                    )}
                    <td style={{ padding: "8px 10px", fontSize: 11, color: "var(--ts)", textAlign: "center" }}>{sub.guarantors?.join(", ") || "-"}</td>
                    <td className="mono" style={{ padding: "8px 10px", fontSize: 11, color: "var(--tm)", textAlign: "center" }}>{sub.hubCode}</td>
                    <td style={{ padding: "8px 10px", fontSize: 12, color: "var(--ts)", textAlign: "center" }}>{sub.hubName}</td>
                    <td style={{ padding: "8px 10px", fontSize: 12, color: "var(--ts)", textAlign: "center" }}>{sub.debtCause || "-"}</td>
                    <td className="mono" style={{ padding: "8px 10px", fontSize: 12, textAlign: "right", whiteSpace: "nowrap" }}>{fmt(sub.principalBalance || 0)}</td>
                    <td className="mono" style={{ padding: "8px 10px", fontSize: 12, textAlign: "right", whiteSpace: "nowrap", color: "#f59e0b" }}>{sub.adjustment ? fmt(sub.adjustment) : "-"}</td>
                    <td className="mono" style={{ padding: "8px 10px", fontSize: 12, textAlign: "right", whiteSpace: "nowrap", color: "var(--ok)" }}>{fmt(sub.collectedAmount || 0)}</td>
                    <td className="mono" style={{ padding: "8px 10px", fontSize: 12, textAlign: "right", whiteSpace: "nowrap", color: "#8b5cf6" }}>{fmt(sub.finalBalanceFinance ?? ((sub.principalBalance || 0) - (sub.collectedAmount || 0)))}</td>
                    <td className="mono" style={{ padding: "8px 10px", fontSize: 12, textAlign: "right", whiteSpace: "nowrap", fontWeight: 600, color: "var(--err)" }}>{fmt(subLegal)}</td>
                  </tr>
                );
              });
            })}</tbody>
          </table>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderTop: "1px solid var(--brd)" }}>
          <span style={{ fontSize: 12, color: "var(--tm)" }}>{(page - 1) * PP + 1}-{Math.min(page * PP, filtered.length)} / {filtered.length}</span>
          <div style={{ display: "flex", gap: 4 }}>
            {page > 1 && <button onClick={() => setPage(page - 1)} style={{ width: 32, height: 32, borderRadius: 6, fontSize: 12, background: "transparent", color: "var(--tm)" }}>&lt;</button>}
            {Array.from({ length: Math.min(tp, 10) }, (_, i) => { let p; if (tp <= 10) p = i + 1; else if (page <= 5) p = i + 1; else if (page >= tp - 4) p = tp - 9 + i; else p = page - 5 + i; return <button key={i} onClick={() => setPage(p)} style={{ width: 32, height: 32, borderRadius: 6, fontSize: 12, fontWeight: 500, background: page === p ? "var(--acc)" : "transparent", color: page === p ? "#fff" : "var(--tm)" }}>{p}</button>; })}
            {page < tp && <button onClick={() => setPage(page + 1)} style={{ width: 32, height: 32, borderRadius: 6, fontSize: 12, background: "transparent", color: "var(--tm)" }}>&gt;</button>}
          </div>
        </div>
      </div>
    </div>
  );

  // ─── Debtor Detail ──────────────────────────────────────
  const DebtorDetail = useStableComponent(({ d }) => {
    // ── 히스토리 로컬 state (hooks must be first) ──
    const [histManual, setHistManual_] = useState(() => getHistM(d.id));
    const [histEdits,  setHistEdits_]  = useState(() => getHistE(d.id));
    const [histDeleted,setHistDeleted_]= useState(() => getHistD(d.id));
    const [histForm,   setHistForm]    = useState(null);
    const [analyzing, setAnalyzing] = useState(false);
    const analyzedIdsRef = useRef(new Set());

    const runAnalysis = async (debtor) => {
      setAnalyzing(true);
      try {
        const res = await fetch(`/api/debtor/${debtor.id}/analysis`, { method: "POST" });
        const data = await res.json();
        if (!data.ok) { showToast(data.error ? `종합분석 실패: ${data.error}` : "종합분석 실패"); return; }
        const marker = "[채무자 및 연대보증인 종합분석]";
        const cur = debtor.keyNotes || "";
        const idx = cur.indexOf(marker);
        const before = (idx >= 0 ? cur.slice(0, idx) : cur).trim();
        const block = `${marker}\n${data.text}`;
        const newNotes = before ? `${before}\n\n${block}` : block;
        await updateDebtor(debtor.id, { keyNotes: newNotes });
        addLog("수정", "채권", `${debtor.name} — AI 종합분석 추가`);
      } catch { showToast("종합분석 실패"); }
      finally { setAnalyzing(false); }
    };

    // 채무자 상세를 열었을 때 "AI 종합분석"이 아직 없으면 버튼을 누르지 않아도 자동으로 생성한다.
    // 이미 있으면(마커 존재) 건드리지 않음 — 매번 새로 생성하면 API 호출이 계속 반복되고
    // 직접 입력한 기존 메모가 있을 때 불필요하게 다시 쓰게 된다.
    useEffect(() => {
      if (!canEdit) return;
      if ((d.keyNotes || "").includes("[채무자 및 연대보증인 종합분석]")) return;
      if (analyzedIdsRef.current.has(d.id)) return;
      analyzedIdsRef.current.add(d.id);
      runAnalysis(d);
    }, [d.id]);

    const updHistM = (arr) => { saveHistM(d.id, arr); setHistManual_(arr); };
    const updHistE = (obj) => { saveHistE(d.id, obj); setHistEdits_(obj); };
    const updHistD = (arr) => { saveHistD(d.id, arr); setHistDeleted_(arr); };

    const debtorHistory = d.history || [];
    const deletedSet = new Set(histDeleted);
    const allHistory = [
      ...debtorHistory
        .map((h, i) => {
          if (deletedSet.has(i)) return null;
          const ed = histEdits[`e_${i}`];
          return { key: `e_${i}`, date: ed?.date ?? h.date, content: ed?.content ?? h.content, type: ed?.type ?? h.type, isExcel: true, origIdx: i };
        })
        .filter(Boolean),
      ...histManual.map(h => ({ key: `m_${h.id}`, date: h.date, content: h.content, type: h.type, isManual: true, manualId: h.id, createdBy: h.createdBy })),
    ].sort((a, b) => b.date.localeCompare(a.date));

    const todayDot = new Date().toISOString().slice(0, 10).replace(/-/g, ".");
    const openAdd  = () => setHistForm({ mode: "add",  date: todayDot, content: "", type: config.activityTypes[0] || "" });
    const openEdit = (h) => setHistForm({ mode: "edit", key: h.key, date: h.date, content: h.content, type: h.type || config.activityTypes[0] || "" });
    const handleHistSave = () => {
      const date = histDateFromInput(histForm.date);
      const content = histForm.content.trim();
      const type = histForm.type;
      if (!date || !content) return;
      if (histForm.mode === "add") {
        updHistM([{ id: uid("HIST"), date, content, type, createdBy: currentUser?.name }, ...histManual]);
      } else {
        if (histForm.key.startsWith("e_")) {
          updHistE({ ...histEdits, [histForm.key]: { date, content, type } });
        } else {
          const mid = histForm.key.replace("m_", "");
          updHistM(histManual.map(h => h.id === mid ? { ...h, date, content, type } : h));
        }
      }
      setHistForm(null);
    };
    const handleHistDelete = (h) => {
      if (!confirm("이 히스토리 항목을 삭제하시겠습니까?")) return;
      if (h.isExcel) updHistD([...histDeleted, h.origIdx]);
      else updHistM(histManual.filter(m => m.id !== h.manualId));
    };

    const debtorPayments = data.payments.filter(p => p.debtorId === d.id);
    const _normD = normNameForMatch(d.name);
    const debtorRehabs = data.rehabilitations.filter(r =>
      r.debtorId === d.id || (normNameForMatch(r.debtorName) === _normD && r.brand === d.brand)
    );
    const debtorLegalAll = [
      ...data.legalCases.filter(c => c.debtorId === d.id),
      ...data.assetDisclosures.filter(c => c.debtorId === d.id),
      ...(data.minsaCases || []).filter(c => c.debtorId === d.id),
      ...(data.complaints || []).filter(c => c.debtorId === d.id).map(c => ({
        ...c, type: "형사고소", caseNumber: c.charge, court: c.policeStation,
        progressStatus: c.status || "수사중",
      })),
    ];
    const debtorInstPlan = (data.installmentPlans || []).find(p => p.debtorId === d.id);
    const debtorInstScheds = debtorInstPlan ? (debtorInstPlan.schedules || []) : [];
    const debtorInstHistory = debtorInstPlan ? (debtorInstPlan.history || []) : [];
    const [instMemoSchedId, setInstMemoSchedId] = useState(null);
    const [instMemoText, setInstMemoText] = useState("");
    const [linkedDocs, setLinkedDocs] = useState(null);
    const [scanResult, setScanResult] = useState(null);
    const [scanning, setScanning] = useState(false);
    const [docModal, setDocModal] = useState(null); // { url, filename, candidates }

    const openDocModal = async (debtorId, keywords, debtorName) => {
      setDocModal({ searching: true, keywords, debtorName });
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25000);
      try {
        const r = await fetch(
          `/api/documents/${debtorId}/scan?keywords=${encodeURIComponent(keywords)}&minScore=20`,
          { signal: ctrl.signal }
        ).then(x => x.json());
        clearTimeout(timer);
        if (!r.ok) {
          setDocModal({ error: r.error || "스캔 실패", keywords });
          return;
        }
        if (!r.candidates || r.candidates.length === 0) {
          setDocModal({ error: `OneDrive에 해당 서류 없음`, keywords });
          return;
        }
        setDocModal({ candidates: r.candidates, debtorId, keywords, debtorName });
      } catch (e) {
        clearTimeout(timer);
        const msg = e.name === "AbortError"
          ? "검색 시간 초과 (25초).\n서버가 실행 중인지, 폴더 경로가 설정되어 있는지 확인해주세요."
          : `연결 실패: ${e.message}`;
        setDocModal({ error: msg, keywords });
      }
    };

    useEffect(() => {
      if (detailTab === "연결서류") {
        fetch(`/api/documents/${d.id}`).then(r => r.json()).then(rows => setLinkedDocs(rows)).catch(() => setLinkedDocs([]));
      }
    }, [detailTab, d.id]);

    const runDocScan = async () => {
      setScanning(true); setScanResult(null);
      try {
        const r = await fetch(`/api/documents/${d.id}/scan`).then(x => x.json());
        setScanResult(r);
      } catch { setScanResult({ ok: false, error: "스캔 실패" }); }
      setScanning(false);
    };

    const linkDoc = async (cand) => {
      await fetch(`/api/documents/${d.id}/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filePath: cand.filePath, fileName: cand.filename, docLabel: cand.docType, matchType: cand.matchType, matchedName: cand.matchedName, linkedBy: currentUser?.name }) });
      const rows = await fetch(`/api/documents/${d.id}`).then(r => r.json());
      setLinkedDocs(rows);
      setScanResult(prev => prev ? { ...prev, candidates: prev.candidates.filter(c => c.filePath !== cand.filePath) } : prev);
      showToast("서류 연결 완료");
    };

    const unlinkDoc = async (docId) => {
      if (!confirm("서류 연결을 해제하시겠습니까?")) return;
      await fetch(`/api/documents/link/${docId}`, { method: "DELETE" });
      setLinkedDocs(prev => prev.filter(x => x.id !== docId));
      showToast("연결 해제 완료");
    };

    const EXT_ICONS = { pdf: "📄", docx: "📝", doc: "📝", xlsx: "📊", xls: "📊", hwp: "📋", hwpx: "📋", jpg: "🖼", jpeg: "🖼", png: "🖼", zip: "🗜" };

    const dtabs = [
      { k: "히스토리", count: allHistory.length },
      { k: "입금내역", count: debtorPayments.length },
      { k: "분할상환", count: debtorInstScheds.length },
      { k: "법적절차내역", count: debtorLegalAll.length },
      { k: "회생파산", count: debtorRehabs.length },
      { k: "연결서류", count: linkedDocs ? linkedDocs.length : 0 },
    ];

    return (
      <div className="slide" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Header with edit/delete */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", background: "var(--card)", borderRadius: 12, padding: 20, border: "1px solid var(--brd)" }}>
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <div style={{ position: "relative", width: 52, height: 52 }}>
              <div style={{ width: 52, height: 52, borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center", background: `${d.brandColor}18`, fontSize: 20, fontWeight: 700, color: d.brandColor }}>{d.brand}</div>
              {(() => {
                const hasResident = !!(d.residentAddress && d.residentAddress.trim());
                const hasCredit = !!(d.latestAddress && d.latestAddress.trim());
                if (!hasResident && !hasCredit) return null;
                let source;
                if (hasResident && !hasCredit) source = "초";
                else if (!hasResident && hasCredit) source = "신";
                else source = (d.residentIssuedDate && (!d.creditQueriedDate || d.residentIssuedDate > d.creditQueriedDate)) ? "초" : "신";
                return (
                  <span
                    title={source === "초" ? "초본상 주소가 더 최근 — 채무자 위치 지도에 사용" : "신용조회상 주소가 더 최근 — 채무자 위치 지도에 사용"}
                    style={{ position: "absolute", bottom: -4, right: -4, width: 20, height: 20, borderRadius: "50%", background: source === "초" ? "#8b5cf6" : "#3b82f6", color: "#fff", fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", border: "2px solid var(--card)" }}
                  >{source}</span>
                );
              })()}
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}><span style={{ fontSize: 18, fontWeight: 700 }}>{d.name}</span><Badge status={d.category} /><Badge status={d.assignee} /></div>
              {d.execTitle && <div style={{ display: "flex", gap: 14, fontSize: 12, color: "var(--ts)", flexWrap: "wrap" }}>{d.execTitleUrl ? <a href={d.execTitleUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--ok)", fontWeight: 600, textDecoration: "none" }} title={d.execTitleType || "집행권원"}>집행권원 O ↗</a> : <span style={{ color: "var(--ok)", fontWeight: 600 }}>집행권원 O{d.execTitleType ? ` (${d.execTitleType})` : ""}</span>}</div>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {canEdit && <button onClick={() => {
              const korKey = n => String(n || "").replace(/[^가-힣]/g, "").slice(0, 3);
              const resEntries = autoResidentNums[d.id];
              let autoNum = d.residentNumber || "";
              if (!autoNum && Array.isArray(resEntries) && resEntries.length > 0) {
                const main = resEntries.find(e => korKey(e.name) === korKey(d.name)) || resEntries[0];
                if (main?.number) autoNum = main.number;
              }
              const scoreEntries = autoCreditScores[d.id];
              let autoGrade = d.creditGrade || "";
              if (!autoGrade && Array.isArray(scoreEntries) && scoreEntries.length > 0) {
                const main = scoreEntries.find(e => korKey(e.name) === korKey(d.name)) || scoreEntries[0];
                if (main?.score) autoGrade = main.score;
              }
              const subResult = autoSubrogationDates[d.id];
              const autoSubDate = (subResult && subResult.date) ? subResult.date : d.subrogationMonth || "";
              const addrResult = autoAddresses[d.id];
              const autoAddress = d.latestAddress || (addrResult && addrResult.address) || "";
              const autoCreditPhone = d.creditPhone || (addrResult && addrResult.phone) || "";
              const residentDetails = autoResidentDetails[d.id];
              const autoResidentAddress = d.residentAddress || (residentDetails && residentDetails.address) || "";
              const autoResidentRegisteredDate = d.residentRegisteredDate || (residentDetails && residentDetails.registeredDate) || "";
              const autoResidentNote = d.residentNote || (residentDetails && residentDetails.note) || "";
              setModal({ type: "debtor", data: { ...d, residentNumber: autoNum, creditGrade: autoGrade, subrogationMonth: autoSubDate, latestAddress: autoAddress, creditPhone: autoCreditPhone, residentAddress: autoResidentAddress, residentRegisteredDate: autoResidentRegisteredDate, residentNote: autoResidentNote } });
            }} style={{ display: "flex", alignItems: "center", gap: 4, padding: "7px 12px", borderRadius: 8, background: "#3b82f618", color: "#3b82f6", fontSize: 12, fontWeight: 600, border: "1px solid #3b82f640" }}><I name="edit" size={14} />수정</button>}
            {canDelete && <button onClick={() => { if (confirm(`${d.name} 채권을 삭제하시겠습니까?`)) { deleteDebtor(d.id); addLog("삭제", "채권", `${d.name} (${d.id}) 삭제`); showToast("삭제 완료"); } }} style={{ display: "flex", alignItems: "center", gap: 4, padding: "7px 12px", borderRadius: 8, background: "#ef444418", color: "#ef4444", fontSize: 12, fontWeight: 600, border: "1px solid #ef444440" }}><I name="trash" size={14} />삭제</button>}
            <button onClick={goBack} style={{ width: 36, height: 36, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)", color: "var(--tm)" }}><I name="close" size={16} /></button>
          </div>
        </div>

        {/* Financial */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 12 }}>
          {[{ l: "원채무액", v: fmt(d.principalBalance), c: "var(--tp)" },{ l: "추가법무비용", v: d.adjustment ? fmt(d.adjustment) : "-", c: "#f59e0b" },{ l: "회수액", v: fmt(d.collectedAmount), c: "var(--ok)" },{ l: "재무기준잔액", v: fmt(d.finalBalanceFinance), c: "#8b5cf6" },{ l: "법무기준잔액", v: fmt(d.finalBalanceLegal), c: "var(--err)" }].map((x, i) => (<div key={i} style={{ background: "var(--card)", borderRadius: 10, padding: 14, border: "1px solid var(--brd)" }}><div style={{ fontSize: 10, color: "var(--tm)", marginBottom: 6 }}>{x.l}</div><div className="mono" style={{ fontSize: 15, fontWeight: 700, color: x.c }}>{x.v}</div></div>))}
        </div>

        {/* Info cards */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {/* 왼쪽: 기본 정보 */}
          <div style={{ background: "var(--card)", borderRadius: 10, padding: 16, border: "1px solid var(--brd)" }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>기본 정보</div>
            {/* 코드번호/허브지점명 */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid var(--brd)" }}>
              <span style={{ fontSize: 12, color: "var(--tm)", flexShrink: 0 }}>코드번호, 허브/지점명</span>
              <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{(d.hubCode || "-")}/{(d.hubName || "-")}</span>
            </div>
            {/* 연대보증인 */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "7px 0", borderBottom: "1px solid var(--brd)" }}>
              <span style={{ fontSize: 12, color: "var(--tm)", flexShrink: 0, paddingTop: 1 }}>연대보증인</span>
              <span style={{ fontSize: 12, fontWeight: 500, textAlign: "right", maxWidth: "65%" }}>
                {d.guarantors?.length > 0 ? d.guarantors.join(", ") : "-"}
              </span>
            </div>
            {/* 주민등록번호 */}
            <div style={{ padding: "7px 0", borderBottom: "1px solid var(--brd)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 12, color: "var(--tm)" }}>주민등록번호</span>
                <button onClick={() => openDocModal(d.id, "주민등록초본,초본", d.name)} style={{ padding: "2px 8px", borderRadius: 5, fontSize: 10, fontWeight: 600, background: "#3b82f618", color: "#1d4ed8", border: "1px solid #3b82f630", cursor: "pointer" }}>초본 보기</button>
              </div>
              {(() => {
                const entries = autoResidentNums[d.id];
                const allEntries = (() => {
                  const base = Array.isArray(entries) ? entries : [];
                  if (d.residentNumber && !base.find(e => e.name === d.name)) return [{ name: d.name, number: d.residentNumber, source: "db" }, ...base];
                  return base;
                })();
                if (!allEntries.length) return <span style={{ fontSize: 12, color: "var(--tm)" }}>{entries === null ? "조회 중..." : "없음"}</span>;
                const renderEntry = (entry, idx) => {
                  const clean = entry.number.replace(/[-\s]/g, "");
                  const front = clean.slice(0, 6), back = clean.slice(6);
                  const revealKey = `${d.id}_${idx}`;
                  const isRevealed = residentRevealed.has(revealKey);
                  const toggleReveal = () => setResidentRevealed(prev => { const next = new Set(prev); if (next.has(revealKey)) next.delete(revealKey); else next.add(revealKey); return next; });
                  const yy = front.slice(0,2), mm = front.slice(2,4), dd2 = front.slice(4,6);
                  const century = ([3,4].includes(parseInt(clean[6],10))) ? "20" : "19";
                  return <div key={idx}>
                    <div style={{ fontSize: 10, color: "var(--tm)", marginBottom: 1 }}>{entry.name}</div>
                    <span style={{ fontSize: 11, fontWeight: 500 }}>{front}-<span onClick={toggleReveal} style={{ cursor: "pointer", color: isRevealed ? "inherit" : "#9ca3af", textDecoration: "underline dotted", userSelect: "none" }}>{isRevealed ? back : "*".repeat(back.length||7)}</span></span>
                    <div style={{ fontSize: 10, color: "var(--ts)" }}>{century}{yy}.{mm}.{dd2} 생 {(() => { const by=parseInt(century+yy,10),bm=parseInt(mm,10),bd=parseInt(dd2,10),now=new Date(); const age=now.getFullYear()-by-(now.getMonth()+1<bm||(now.getMonth()+1===bm&&now.getDate()<bd)?1:0); return `(만 ${age}세)`; })()}</div>
                  </div>;
                };
                if (allEntries.length === 1) return renderEntry(allEntries[0], 0);
                const half = Math.ceil(allEntries.length / 2);
                return <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 16px" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{allEntries.slice(0, half).map((e, i) => renderEntry(e, i))}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{allEntries.slice(half).map((e, i) => renderEntry(e, half+i))}</div>
                </div>;
              })()}
            </div>
            {/* 초본 발급일 / 초본상 등록일 / 비고 */}
            <div style={{ padding: "7px 0", borderBottom: "1px solid var(--brd)" }}>
              {(() => {
                const details = autoResidentDetails[d.id];
                const registeredDate = d.residentRegisteredDate || (details && details.registeredDate) || null;
                const note = d.residentNote || (details && details.note) || null;
                const issuedDate = d.residentIssuedDate || (details && details.issuedDate) || null;
                if (!registeredDate && !note && !issuedDate) {
                  return <>
                    <div style={{ fontSize: 12, color: "var(--tm)", marginBottom: 6 }}>초본 발급일 / 초본 등록일 / 비고</div>
                    <span style={{ fontSize: 12, color: "var(--tm)" }}>{details === null ? "조회 중..." : "없음 — 초본 보기로 확인 후 '수정'에서 직접 입력 가능"}</span>
                  </>;
                }
                return <div>
                  <div style={{ fontSize: 12, color: "var(--tm)", marginBottom: 2 }}>초본 발급일 / 초본 등록일 / 비고</div>
                  <div style={{ fontSize: 12, fontWeight: 500 }}>{[issuedDate || "-", registeredDate || "-", note || "-"].join(" / ")}</div>
                </div>;
              })()}
            </div>
            {/* 신용조회 */}
            <div style={{ padding: "7px 0", borderBottom: "1px solid var(--brd)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 12, color: "var(--tm)" }}>신용조회</span>
                <button onClick={() => openDocModal(d.id, "cb,신용정보,신용조회,신용보고", d.name)} style={{ padding: "2px 8px", borderRadius: 5, fontSize: 10, fontWeight: 600, background: "#3b82f618", color: "#1d4ed8", border: "1px solid #3b82f630", cursor: "pointer" }}>CB 보기</button>
              </div>
              {(() => {
                const scoreEntries = autoCreditScores[d.id];
                const allEntries = (() => {
                  const base = Array.isArray(scoreEntries) ? scoreEntries : [];
                  if (d.creditGrade && !base.find(e => String(e.name||"").replace(/[^가-힣]/g,"").slice(0,3) === String(d.name||"").replace(/[^가-힣]/g,"").slice(0,3))) return [{ name: d.name, score: d.creditGrade, source: "db" }, ...base];
                  return base;
                })();
                if (!allEntries.length) return <span style={{ fontSize: 12, color: "var(--tm)" }}>{scoreEntries === null ? "조회 중..." : "없음"}</span>;
                const renderScore = (entry, idx) => (
                  <div key={idx}>
                    <div style={{ fontSize: 10, color: "var(--tm)", marginBottom: 1 }}>{entry.name}</div>
                    <span style={{ fontSize: 12, fontWeight: 700, color: parseInt(entry.score)>=700 ? "var(--ok)" : parseInt(entry.score)>=400 ? "var(--warn)" : "var(--err)" }}>{entry.score}점</span>
                  </div>
                );
                if (allEntries.length === 1) return renderScore(allEntries[0], 0);
                const half = Math.ceil(allEntries.length / 2);
                return <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 16px" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{allEntries.slice(0, half).map((e, i) => renderScore(e, i))}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{allEntries.slice(half).map((e, i) => renderScore(e, half+i))}</div>
                </div>;
              })()}
            </div>
            {/* 신용조회상 연락처 */}
            <div style={{ padding: "7px 0", borderBottom: "1px solid var(--brd)" }}>
              <div style={{ fontSize: 12, color: "var(--tm)", marginBottom: 6 }}>신용조회상 연락처</div>
              {(() => {
                const addrResult = autoAddresses[d.id];
                const phone = d.creditPhone || (addrResult && addrResult.phone) || null;
                if (phone) return <span style={{ fontSize: 12, fontWeight: 500 }}>{phone}</span>;
                return <span style={{ fontSize: 12, color: "var(--tm)" }}>{addrResult === null ? "CB보고서에서 자동 조회 중..." : "없음"}</span>;
              })()}
            </div>
            {/* 신용조회상 최신 주소 */}
            <div style={{ padding: "7px 0", borderBottom: "1px solid var(--brd)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 12, color: "var(--tm)" }}>신용조회상 최신 주소</span>
                {canEdit && <button
                  onClick={async () => {
                    setAutoAddresses(prev => ({ ...prev, [d.id]: null }));
                    try {
                      const res = await fetch(`/api/debtor/${d.id}/credit-address/refresh`, { method: "POST" });
                      const data = await res.json();
                      setAutoAddresses(prev => ({ ...prev, [d.id]: data.ok && data.address ? { address: data.address, phone: data.phone, queriedDate: data.queriedDate, filename: data.filename } : false }));
                      showToast(data.ok ? "CB보고서에서 다시 추출했습니다" : "재추출 실패 — CB 보기로 직접 확인해주세요");
                    } catch { setAutoAddresses(prev => ({ ...prev, [d.id]: false })); showToast("재추출 실패"); }
                  }}
                  title="예전에 잘못 저장된 값을 지우고 CB보고서에서 다시 추출합니다"
                  style={{ padding: "2px 8px", borderRadius: 5, fontSize: 10, fontWeight: 600, background: "#3b82f618", color: "#1d4ed8", border: "1px solid #3b82f630", cursor: "pointer" }}
                >재조회</button>}
              </div>
              {(() => {
                const addrResult = autoAddresses[d.id];
                const address = d.latestAddress || (addrResult && addrResult.address) || null;
                if (address) return <span style={{ fontSize: 12, fontWeight: 500 }}>{address}</span>;
                return <span style={{ fontSize: 12, color: "var(--tm)" }}>{addrResult === null ? "CB보고서에서 자동 조회 중..." : "없음 — CB 보기로 확인 후 '수정'에서 직접 입력 가능"}</span>;
              })()}
              {(() => {
                const queriedDate = d.creditQueriedDate || (autoAddresses[d.id] && autoAddresses[d.id].queriedDate) || null;
                return queriedDate ? <div style={{ fontSize: 10, color: "var(--ts)", marginTop: 2 }}>CB 조회일자 {queriedDate} 기준</div> : null;
              })()}
            </div>
            {/* 초본상 최신 주소 */}
            <div style={{ padding: "7px 0", borderBottom: "1px solid var(--brd)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 12, color: "var(--tm)" }}>초본상 최신 주소</span>
                {canEdit && <button
                  onClick={async () => {
                    setAutoResidentDetails(prev => ({ ...prev, [d.id]: null }));
                    try {
                      const res = await fetch(`/api/debtor/${d.id}/resident-number/refresh`, { method: "POST" });
                      const data = await res.json();
                      setAutoResidentDetails(prev => ({ ...prev, [d.id]: data.ok ? { address: data.address, registeredDate: data.registeredDate, note: data.note, issuedDate: data.issuedDate } : false }));
                      showToast(data.ok ? "초본에서 다시 추출했습니다" : "재추출 실패 — 초본 보기로 직접 확인해주세요");
                    } catch { setAutoResidentDetails(prev => ({ ...prev, [d.id]: false })); showToast("재추출 실패"); }
                  }}
                  title="예전에 잘못 저장된 값을 지우고 초본에서 다시 추출합니다"
                  style={{ padding: "2px 8px", borderRadius: 5, fontSize: 10, fontWeight: 600, background: "#3b82f618", color: "#1d4ed8", border: "1px solid #3b82f630", cursor: "pointer" }}
                >재조회</button>}
              </div>
              {(() => {
                const details = autoResidentDetails[d.id];
                const address = d.residentAddress || (details && details.address) || null;
                if (address) return <span style={{ fontSize: 12, fontWeight: 500 }}>{address}</span>;
                return <span style={{ fontSize: 12, color: "var(--tm)" }}>{details === null ? "초본에서 자동 조회 중..." : "없음 — 초본 보기로 확인 후 '수정'에서 직접 입력 가능"}</span>;
              })()}
            </div>
            {/* 전화번호 — 맨 아래, 내용 무한 확장 */}
            <div style={{ padding: "7px 0" }}>
              <div style={{ fontSize: 12, color: "var(--tm)", marginBottom: 6 }}>전화번호</div>
              {(() => {
                const phones = (d.phone || "").split(/\s*\/\s*|\n/).map(p => p.trim()).filter(Boolean);
                if (!phones.length) return <span style={{ fontSize: 12, color: "var(--tm)" }}>-</span>;
                if (phones.length <= 3) return (
                  <div>{phones.map((p, i) => <div key={i} style={{ fontSize: 12, fontWeight: 500, lineHeight: 1.8 }}>{p}</div>)}</div>
                );
                const half = Math.ceil(phones.length / 2);
                return (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 8px" }}>
                    <div>{phones.slice(0, half).map((p, i) => <div key={i} style={{ fontSize: 11, fontWeight: 500, lineHeight: 1.8 }}>{p}</div>)}</div>
                    <div>{phones.slice(half).map((p, i) => <div key={i} style={{ fontSize: 11, fontWeight: 500, lineHeight: 1.8 }}>{p}</div>)}</div>
                  </div>
                );
              })()}
            </div>
          </div>

          {/* 오른쪽: 추가 정보 */}
          <div style={{ background: "var(--card)", borderRadius: 10, padding: 16, border: "1px solid var(--brd)" }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>추가 정보</div>
            {/* 채무발생원인 */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid var(--brd)" }}>
              <span style={{ fontSize: 12, color: "var(--tm)", flexShrink: 0 }}>채무발생원인</span>
              <span style={{ fontSize: 12, fontWeight: 500 }}>{d.debtCause || "-"}</span>
            </div>
            {/* 대여일자 */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid var(--brd)" }}>
              <span style={{ fontSize: 12, color: "var(--tm)", flexShrink: 0 }}>대여일자</span>
              <span className="mono" style={{ fontSize: 12, fontWeight: 500 }}>{fmtDate(d.loanDate)}</span>
            </div>
            {/* 대위변제일 */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid var(--brd)" }}>
              <span style={{ fontSize: 12, color: "var(--tm)", flexShrink: 0 }}>대위변제일</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {(() => {
                  const sub = autoSubrogationDates[d.id];
                  const displayDate = (sub && sub.date) ? sub.date : d.subrogationMonth || null;
                  return <span style={{ fontSize: 12, fontWeight: displayDate ? 500 : 400, color: displayDate ? "var(--tp)" : "var(--tm)" }}>
                    {sub === null ? "조회 중..." : displayDate || "없음"}
                  </span>;
                })()}
                <button onClick={() => openDocModal(d.id, "대위변제증명서,대위변제", d.name)} style={{ padding: "2px 8px", borderRadius: 5, fontSize: 10, fontWeight: 600, background: "#3b82f618", color: "#1d4ed8", border: "1px solid #3b82f630", cursor: "pointer" }}>
                  증명서 보기
                </button>
              </div>
            </div>
            {/* 영업담당자 */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "7px 0", borderBottom: "1px solid var(--brd)" }}>
              <span style={{ fontSize: 12, color: "var(--tm)", flexShrink: 0, paddingTop: 1 }}>영업담당자</span>
              <span style={{ fontSize: 12, fontWeight: 500, textAlign: "right", maxWidth: "65%" }}>{d.salesRep || "-"}</span>
            </div>
            {/* 기타사항 */}
            <div style={{ padding: "7px 0" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontSize: 12, color: "var(--tm)" }}>기타사항</span>
                {canEdit && <button
                  disabled={analyzing}
                  onClick={() => runAnalysis(d)}
                  style={{ padding: "2px 8px", borderRadius: 5, fontSize: 10, fontWeight: 600, background: "#8b5cf618", color: "#6d28d9", border: "1px solid #8b5cf640", cursor: analyzing ? "default" : "pointer", opacity: analyzing ? 0.6 : 1 }}
                >{analyzing ? "분석 중..." : "AI 종합분석 다시 생성"}</button>}
              </div>
              {d.keyNotes
                ? <div style={{ fontSize: 13, lineHeight: 1.7, padding: "6px 8px", background: "var(--bg)", borderRadius: 6, whiteSpace: "pre-wrap" }}><RichNoteText text={d.keyNotes} /></div>
                : <span style={{ fontSize: 12, color: "var(--tm)" }}>-</span>}
            </div>
          </div>
        </div>

        {/* Tabs with quick-add buttons */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ display: "flex", gap: 2, flex: 1, background: "var(--card)", borderRadius: 10, padding: 4, border: "1px solid var(--brd)" }}>
            {dtabs.map(t => (<button key={t.k} onClick={() => setDetailTab(t.k)} style={{ flex: 1, padding: "8px 0", borderRadius: 8, fontSize: 12, fontWeight: 500, background: detailTab === t.k ? "var(--bg)" : "transparent", color: detailTab === t.k ? "var(--tp)" : "var(--tm)" }}>{t.k} {t.count > 0 && <span className="mono" style={{ fontSize: 10 }}>({t.count})</span>}</button>))}
          </div>
          {detailTab === "히스토리" && canEdit && (
            <button onClick={openAdd} style={{ padding: "8px 14px", borderRadius: 8, background: "var(--acc)15", color: "var(--acc)", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", border: "1px solid var(--acc)40", cursor: "pointer" }}>히스토리 추가</button>
          )}
          {detailTab === "입금내역" && canEdit && (
            <button onClick={() => setModal({ type: "payment", debtorId: d.id })} style={{ display: "flex", alignItems: "center", gap: 4, padding: "8px 14px", borderRadius: 8, background: "var(--acc)", color: "#fff", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}><I name="plus" size={14} />입금 등록</button>
          )}
          {detailTab === "분할상환" && !debtorInstPlan && canEdit && (
            <button onClick={() => setModal({ type: "addInstallment", debtorId: d.id })} style={{ display: "flex", alignItems: "center", gap: 4, padding: "8px 14px", borderRadius: 8, background: "var(--acc)", color: "#fff", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}><I name="plus" size={14} />플랜 추가</button>
          )}
        </div>

        {/* Tab content */}
        {detailTab === "히스토리" && <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {/* 추가/수정 폼 */}
          {histForm && (
            <div style={{ background: "var(--card)", borderRadius: 10, padding: 14, border: "2px solid var(--acc)" }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "var(--tm)", whiteSpace: "nowrap" }}>날짜</span>
                <input type="date" value={histDateToInput(histForm.date)} onChange={e => setHistForm(f => ({ ...f, date: e.target.value }))} style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--brd)", background: "var(--bg)", color: "var(--tp)", fontSize: 12 }} />
                <span style={{ fontSize: 12, color: "var(--tm)", whiteSpace: "nowrap", marginLeft: 8 }}>활동유형</span>
                <select value={histForm.type} onChange={e => setHistForm(f => ({ ...f, type: e.target.value }))} style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--brd)", background: "var(--bg)", color: "var(--tp)", fontSize: 12 }}>
                  {config.activityTypes.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <KoreanTextarea
                value={histForm.content}
                onChange={e => setHistForm(f => ({ ...f, content: e.target.value }))}
                rows={4}
                placeholder="추심 내용을 입력하세요..."
                style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--brd)", background: "var(--bg)", color: "var(--tp)", fontSize: 12, lineHeight: 1.7, resize: "vertical", boxSizing: "border-box" }}
              />
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 8 }}>
                <button onClick={() => setHistForm(null)} style={{ padding: "6px 14px", borderRadius: 7, background: "var(--bg2)", color: "var(--tp)", border: "1px solid var(--brd)", fontSize: 12, cursor: "pointer" }}>취소</button>
                <button onClick={handleHistSave} style={{ padding: "6px 14px", borderRadius: 7, background: "var(--acc)", color: "#fff", border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>저장</button>
              </div>
            </div>
          )}
          {/* 히스토리 목록 */}
          <div style={{ background: "var(--card)", borderRadius: 12, border: "1px solid var(--brd)", overflow: "hidden" }}>
            {allHistory.length === 0 && <div style={{ padding: 32, textAlign: "center", color: "var(--tm)", fontSize: 13 }}>추심 히스토리 없음 — 위 버튼으로 추가하세요</div>}
            {allHistory.length > 0 && (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <tbody>
                  {allHistory.map((h, i) => (
                    <tr key={h.key} style={{ borderBottom: i < allHistory.length - 1 ? "1px solid var(--brd)" : "none" }}>
                      <td style={{ width: 90, padding: "8px 10px", borderRight: "1px solid var(--brd)", verticalAlign: "top" }}>
                        <div className="mono" style={{ fontSize: 11, color: "var(--acc)", fontWeight: 600, lineHeight: 1.4 }}>{h.date}</div>
                        <div style={{ fontSize: 11, color: h.type ? "var(--tp)" : "var(--tm)", marginTop: 2 }}>{h.type || "-"}</div>
                      </td>
                      <td style={{ width: 70, padding: "8px 10px", borderRight: "1px solid var(--brd)", verticalAlign: "top" }}>
                        <div style={{ fontSize: 11, color: h.isManual ? "var(--ok)" : "var(--tm)", fontWeight: 600 }}>{h.isManual ? "수동" : "-"}</div>
                        <div style={{ fontSize: 11, color: "var(--tp)", marginTop: 2 }}>{h.createdBy || ""}</div>
                      </td>
                      <td style={{ padding: "8px 16px", fontSize: 12, lineHeight: 1.6, color: "var(--tp)", whiteSpace: "pre-wrap", wordBreak: "break-all", borderRight: "1px solid var(--brd)" }}>{h.content}</td>
                      <td style={{ width: 60, padding: "8px 10px", verticalAlign: "top" }}>
                        <div style={{ display: "flex", flexDirection: "row", gap: 4 }}>
                          {(canEditRecord(h) || (h.isManual && !h.createdBy && canEdit)) && <button onClick={() => openEdit(h)} title="수정" style={{ width: 26, height: 26, borderRadius: 6, background: "#3b82f610", color: "#3b82f6", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><I name="edit" size={12} /></button>}
                          {(canDeleteRecord(h) || (h.isManual && !h.createdBy && canEdit)) && <button onClick={() => handleHistDelete(h)} title="삭제" style={{ width: 26, height: 26, borderRadius: 6, background: "#ef444410", color: "#ef4444", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><I name="trash" size={12} /></button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>}

        {detailTab === "입금내역" && <div style={{ background: "var(--card)", borderRadius: 12, border: "1px solid var(--brd)", overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}><thead><tr style={{ background: "var(--bg2)" }}>{["입금일","입금자","합계","본사계좌","캐쉬충전","웰컴직접","비고",""].map(h => <th key={h} style={{ padding: "8px 10px", textAlign: "left", fontSize: 11, color: "var(--tm)", fontWeight: 600, borderBottom: "1px solid var(--brd)" }}>{h}</th>)}</tr></thead>
            <tbody>{debtorPayments.map(p => (<tr key={p.id} style={{ borderBottom: "1px solid var(--brd)" }}><td className="mono" style={{ padding: "8px 10px" }}>{fmtDate(p.paymentDate)}</td><td style={{ padding: "8px 10px" }}>{p.payerName}</td><td className="mono" style={{ padding: "8px 10px", fontWeight: 600 }}>{fmt(p.totalAmount)}</td><td className="mono" style={{ padding: "8px 10px", color: p.companyAccount > 0 ? "var(--tp)" : "var(--tm)" }}>{p.companyAccount > 0 ? fmt(p.companyAccount) : "-"}</td><td className="mono" style={{ padding: "8px 10px", color: p.cashCharge > 0 ? "var(--tp)" : "var(--tm)" }}>{p.cashCharge > 0 ? fmt(p.cashCharge) : "-"}</td><td className="mono" style={{ padding: "8px 10px", color: p.welcomeDirect > 0 ? "var(--tp)" : "var(--tm)" }}>{p.welcomeDirect > 0 ? fmt(p.welcomeDirect) : "-"}</td><td style={{ padding: "8px 10px", color: "var(--ts)" }}>{p.note || "-"}</td><td style={{ padding: "8px 10px" }}>{canEdit && <button onClick={(e) => { e.stopPropagation(); if (confirm(`${fmtDate(p.paymentDate)} ${fmt(p.totalAmount)} 입금을 삭제하시겠습니까? 회수액/잔액이 원복됩니다.`)) { deletePayment(p.id); addLog("삭제", "입금", `${p.debtorName} — ${fmt(p.totalAmount)} 삭제 (잔액 원복)`); showToast("입금 삭제 및 잔액 원복 완료"); } }} style={{ background: "none", color: "var(--err)", padding: 2 }}><I name="trash" size={13} /></button>}</td></tr>))}
              {debtorPayments.length === 0 && <tr><td colSpan={8} style={{ padding: 20, textAlign: "center", color: "var(--tm)" }}>입금 내역 없음</td></tr>}</tbody></table>
        </div>}

        <div style={{ display: detailTab === "분할상환" ? "flex" : "none", flexDirection: "column", gap: 12 }}>
          {!debtorInstPlan && <div style={{ padding: 32, textAlign: "center", color: "var(--tm)", background: "var(--card)", borderRadius: 12, border: "1px solid var(--brd)", fontSize: 13 }}>분할상환 플랜 없음 — 위 버튼으로 추가하세요</div>}
          {debtorInstPlan && <>
            {/* 플랜 개요 */}
            <div style={{ background: "var(--card)", borderRadius: 10, padding: "10px 14px", border: "1px solid var(--brd)", display: "flex", gap: 20, fontSize: 12, alignItems: "center", flexWrap: "wrap" }}>
              {debtorInstPlan.startDate && <><span style={{ color: "var(--tm)" }}>시작일:</span><b className="mono">{debtorInstPlan.startDate}</b></>}
              <span style={{ color: "var(--tm)" }}>1회 납부:</span><b className="mono" style={{ color: "var(--acc)" }}>{fmt(debtorInstPlan.monthlyAmount)}</b>
              <span style={{ color: "var(--tm)" }}>총 채권액:</span><b className="mono">{fmt(d.finalBalanceLegal)}</b>
              {debtorInstPlan.memo && <span style={{ color: "var(--ts)" }}>{debtorInstPlan.memo}</span>}
            </div>
            {/* 현재 납부 일정 */}
            {debtorInstScheds.filter(s => s.status !== "이월").length > 0 && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--tm)", marginBottom: 6 }}>납부 일정</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {debtorInstScheds.filter(s => s.status !== "이월").map(s => {
                    const sc = s.status === "완납" ? { bg: "#10b98110", t: "#047857", b: "#10b98130" } : s.status === "지연" ? { bg: "#f59e0b10", t: "#b45309", b: "#f59e0b30" } : { bg: "#ef444410", t: "#b91c1c", b: "#ef444430" };
                    return (
                      <div key={s.id} style={{ background: "var(--card)", borderRadius: 8, border: `1px solid ${sc.b}`, padding: "8px 12px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <span className="mono" style={{ fontSize: 12, minWidth: 90 }}>{s.dueDate ? fmtDate(s.dueDate) : <span style={{ color: "#f59e0b" }}>{s.dueMonth}(미정)</span>}</span>
                        <span className="mono" style={{ fontWeight: 700 }}>{fmt(s.scheduledAmount)}</span>
                        {s.debtSource && <span style={{ fontSize: 11, color: "var(--ts)" }}>{s.debtSource}</span>}
                        <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, background: sc.bg, color: sc.t }}>{s.status}</span>
                        {canEdit && s.status !== "완납" && s.status !== "이월" && (
                          <div style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
                            <button onClick={async () => { await fetch(`/api/installments/schedules/${s.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "완납", userName: "관리자" }) }); await reloadInstallments(); showToast("완납 처리됨"); }} style={{ padding: "2px 10px", borderRadius: 5, background: "#10b98118", color: "#047857", border: "1px solid #10b98130", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>완납</button>
                            <button onClick={() => setModal({ type: "rollover", sched: { ...s, debtorName: d.name } })} style={{ padding: "2px 10px", borderRadius: 5, background: "#8b5cf618", color: "#6d28d9", border: "1px solid #8b5cf640", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>이월</button>
                            <button onClick={() => { setInstMemoSchedId(s.id); setInstMemoText(""); }} style={{ padding: "2px 8px", borderRadius: 5, background: "var(--bg2)", color: "var(--tm)", border: "1px solid var(--brd)", fontSize: 11, cursor: "pointer" }}>메모</button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {/* 메모 입력 영역 */}
            {instMemoSchedId && (
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <KoreanInput value={instMemoText} onChange={e => setInstMemoText(e.target.value)} placeholder="통화 내용 기록 (예: 다음달 10일 입금 약속)" style={{ flex: 1, padding: "7px 10px", fontSize: 12, borderRadius: 6, border: "1px solid var(--brd)", background: "var(--bg)", color: "var(--tp)" }} onKeyDown={async e => { if (e.key === "Enter" && instMemoText.trim()) { await addInstallmentMemo(instMemoSchedId, instMemoText.trim()); setInstMemoSchedId(null); setInstMemoText(""); showToast("메모 저장됨"); } }} />
                <button onClick={async () => { if (instMemoText.trim()) { await addInstallmentMemo(instMemoSchedId, instMemoText.trim()); setInstMemoSchedId(null); setInstMemoText(""); showToast("메모 저장됨"); } }} style={{ padding: "7px 14px", borderRadius: 6, background: "var(--acc)", color: "#fff", fontSize: 12, fontWeight: 600, border: "none", cursor: "pointer" }}>저장</button>
                <button onClick={() => setInstMemoSchedId(null)} style={{ padding: "7px 10px", borderRadius: 6, background: "var(--bg2)", color: "var(--tm)", fontSize: 12, border: "1px solid var(--brd)", cursor: "pointer" }}>취소</button>
              </div>
            )}
            {/* 히스토리 타임라인 */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--tm)", marginBottom: 8 }}>납부 히스토리 ({debtorInstHistory.length}건)</div>
              {debtorInstHistory.length === 0 && <div style={{ padding: "20px 0", textAlign: "center", color: "var(--tm)", fontSize: 12 }}>기록 없음 — 완납/이월/메모 시 자동으로 쌓입니다</div>}
              <div style={{ position: "relative", paddingLeft: 20 }}>
                {debtorInstHistory.length > 0 && <div style={{ position: "absolute", left: 7, top: 6, bottom: 6, width: 2, background: "var(--brd)", borderRadius: 2 }} />}
                {debtorInstHistory.map((h) => {
                  const evtColor = h.eventType === "완납" ? "#047857" : h.eventType === "이월" ? "#6d28d9" : h.eventType === "지연" ? "#b45309" : h.eventType === "메모" ? "#3b82f6" : h.eventType === "미납" ? "#b91c1c" : h.eventType === "예정" ? "#1d4ed8" : "var(--tm)";
                  const evtBg = h.eventType === "완납" ? "#10b98118" : h.eventType === "이월" ? "#8b5cf618" : h.eventType === "지연" ? "#f59e0b18" : h.eventType === "메모" ? "#3b82f618" : h.eventType === "미납" ? "#ef444418" : h.eventType === "예정" ? "#3b82f618" : "var(--bg2)";
                  const [dt, tm] = (h.createdAt || "").split(" ");
                  return (
                    <div key={h.id} style={{ display: "flex", gap: 10, marginBottom: 10, alignItems: "flex-start" }}>
                      <div style={{ width: 14, height: 14, borderRadius: "50%", background: evtColor, border: "2px solid var(--card)", flexShrink: 0, marginTop: 2, position: "relative", zIndex: 1 }} />
                      <div style={{ flex: 1, background: "var(--card)", borderRadius: 8, padding: "8px 10px", border: "1px solid var(--brd)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: h.memo ? 4 : 0 }}>
                          <span style={{ padding: "1px 8px", borderRadius: 8, fontSize: 11, fontWeight: 700, background: evtBg, color: evtColor }}>{h.eventType}</span>
                          {h.fromDate && <span className="mono" style={{ fontSize: 11, color: "var(--ts)" }}>{h.fromDate}</span>}
                          {h.toDate && <><span style={{ fontSize: 11, color: "var(--tm)" }}>→</span><span className="mono" style={{ fontSize: 11, color: evtColor, fontWeight: 600 }}>{h.toDate}</span></>}
                          {h.amount && <span className="mono" style={{ fontSize: 11, color: "var(--ts)" }}>{fmt(h.amount)}</span>}
                          <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--ts)" }}>{dt} {tm?.slice(0,5)}</span>
                        </div>
                        {h.memo && <div style={{ fontSize: 12, color: "var(--tp)", marginTop: 2, lineHeight: 1.5 }}>"{h.memo}"</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>}
        </div>

        {detailTab === "법적절차내역" && <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {debtorLegalAll.length === 0 && <div style={{ padding: 32, textAlign: "center", color: "var(--tm)", background: "var(--card)", borderRadius: 12, border: "1px solid var(--brd)", fontSize: 13 }}>법적절차 내역 없음</div>}
          {debtorLegalAll.map((c, i) => {
            const _legalTypes = ["지급명령", "압류", "재산명시", "형사고소"];
            const _handleCardNav = () => {
              if (c.type === "민사소송") {
                setMinsaSearchInit(d.name); setPrevTab(tab); setSel(null); setTab("minsa");
              } else if (_legalTypes.includes(c.type)) {
                setLegalSearchInit(d.name); setLegalTypeFilter("전체"); setPrevTab(tab); setSel(null); setTab("legal");
              }
            };
            return (
            <div key={c.id || i} style={{ background: "var(--card)", borderRadius: 10, padding: 14, border: "1px solid var(--brd)", cursor: "pointer" }}
              onClick={_handleCardNav}
              onMouseEnter={e => e.currentTarget.style.background = "var(--hover)"}
              onMouseLeave={e => e.currentTarget.style.background = "var(--card)"}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Badge status={c.type} />
                  <span className="mono" style={{ fontSize: 12, color: "var(--tm)" }}>{c.caseNumber}</span>
                  <span style={{ fontSize: 12, color: "var(--ts)" }}>{c.court}</span>
                </div>
                <Badge status={c.progressStatus || c.status || "진행"} small />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, fontSize: 11, color: "var(--ts)" }}>
                {c.filingDate && <span>접수일: {c.filingDate}</span>}
                {c.applicationDate && <span>신청일: {c.applicationDate}</span>}
                {c.defendant && <span>피고: {c.defendant}</span>}
                {c.debtorName && <span>대상자: {c.debtorName}</span>}
                {c.hasInquiryOrder !== undefined && <span>재산조회: {c.hasInquiryOrder ? <span style={{ color: "var(--ok)", fontWeight: 600 }}>O</span> : <span style={{ color: "var(--tm)" }}>X</span>}</span>}
                {c.caseStatus && <span>지위: {c.caseStatus}</span>}
              </div>
            </div>
            );
          })}
        </div>}

        {detailTab === "회생파산" && <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {debtorRehabs.map(r => (<div key={r.id} style={{ background: "var(--card)", borderRadius: 12, padding: 16, border: "1px solid var(--brd)" }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><Badge status={r.type} /><span className="mono" style={{ fontSize: 12, color: "var(--tm)" }}>{r.caseNumber}</span><span style={{ fontSize: 12, color: "var(--ts)" }}>{r.court}</span></div>{r.dismissed && <span style={{ fontSize: 11, fontWeight: 600, color: "var(--err)" }}>폐지</span>}</div><div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>{[{ l: "채무액", v: fmt(r.debtAmount) },{ l: "승인액", v: fmt(r.approvedAmount) },{ l: "월상환액", v: fmt(r.monthlyPayment) },{ l: "현재 회차", v: r.currentRound },{ l: "변제계획 인가", v: r.planApproved ? "O" : "X" },{ l: "미납 여부", v: r.overdueStatus || "정상" }].map((x, i) => (<div key={i} style={{ padding: 8, background: "var(--bg)", borderRadius: 6 }}><div style={{ fontSize: 10, color: "var(--tm)", marginBottom: 2 }}>{x.l}</div><div className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{x.v}</div></div>))}</div>{r.repaymentNote && <div style={{ marginTop: 10, fontSize: 12, color: "var(--ts)", padding: 8, background: "var(--bg)", borderRadius: 6 }}>{r.repaymentNote}</div>}</div>))}
          {debtorRehabs.length === 0 && <div style={{ padding: 20, textAlign: "center", color: "var(--tm)", background: "var(--card)", borderRadius: 12, border: "1px solid var(--brd)" }}>회생/파산 내역 없음</div>}
        </div>}

        {/* PDF 팝업 모달 */}
        {docModal && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 9000, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setDocModal(null)}>
            <div style={{ background: "var(--card)", borderRadius: 14, width: "min(92vw, 1100px)", height: docModal.selected ? "88vh" : undefined, maxHeight: "88vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.4)" }} onClick={e => e.stopPropagation()}>
              {/* 헤더 */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 18px", borderBottom: "1px solid var(--brd)", flexShrink: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {docModal.selected && (
                    <button onClick={() => setDocModal(p => ({ ...p, selected: null, url: null }))} style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, background: "var(--bg)", border: "1px solid var(--brd)", cursor: "pointer", color: "var(--tp)", fontWeight: 500 }}>← 목록</button>
                  )}
                  <span style={{ fontWeight: 600, fontSize: 13 }}>
                    {docModal.searching ? "OneDrive 검색 중..."
                      : docModal.error ? "서류를 찾지 못했습니다"
                      : docModal.selected ? docModal.selected.filename
                      : `검색 결과 — ${docModal.debtorName || ""}${docModal.candidates ? ` (${docModal.candidates.length}건)` : ""}`}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  {docModal.url && <button onClick={() => window.open(docModal.url, "_blank")} style={{ padding: "5px 12px", borderRadius: 7, background: "#3b82f618", color: "#1d4ed8", fontSize: 12, fontWeight: 600, border: "1px solid #3b82f630", cursor: "pointer" }}>새 탭으로 열기</button>}
                  <button onClick={() => setDocModal(null)} style={{ width: 32, height: 32, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)", color: "var(--tm)", border: "1px solid var(--brd)" }}><I name="close" size={15} /></button>
                </div>
              </div>
              {/* 본문 */}
              <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
                {docModal.searching && <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--tm)", fontSize: 13 }}>OneDrive 검색 중...</div>}
                {docModal.error && <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--err)", fontSize: 13, textAlign: "center", whiteSpace: "pre-line", padding: 20 }}>{docModal.error}</div>}
                {/* 후보 목록 */}
                {!docModal.searching && !docModal.error && !docModal.selected && docModal.candidates && (() => {
                  const getDocYear = pd => {
                    if (!pd || pd.length < 2) return null;
                    if (/^\d{6}/.test(pd)) return "20" + pd.slice(0, 2) + "년";
                    if (/^\d{8}/.test(pd)) return pd.slice(0, 4) + "년";
                    if (/^\d{4}/.test(pd)) return pd.slice(0, 4) + "년";
                    return null;
                  };
                  const sorted = [...docModal.candidates].sort((a, b) => {
                    const da = a.parsedDate || "", db2 = b.parsedDate || "";
                    if (db2 !== da) return db2.localeCompare(da);
                    return b.score - a.score;
                  });
                  const items = [];
                  let lastYear;
                  for (const c of sorted) {
                    const year = getDocYear(c.parsedDate);
                    if (year !== lastYear) {
                      items.push({ header: true, year: year || "날짜 미상" });
                      lastYear = year;
                    }
                    items.push({ header: false, c });
                  }
                  return (
                    <div style={{ overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 6 }}>
                      {items.map((item, i) => item.header ? (
                        <div key={`y${i}`} style={{ fontSize: 11, fontWeight: 700, color: "var(--tm)", padding: i === 0 ? "0 4px 2px" : "10px 4px 2px", letterSpacing: 0.5, borderBottom: "1px solid var(--brd)" }}>{item.year}</div>
                      ) : (
                        <div key={`f${i}`}
                          onClick={() => setDocModal(p => ({ ...p, selected: item.c, url: `/api/file-stream?path=${encodeURIComponent(item.c.filePath)}` }))}
                          style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", borderRadius: 10, border: "1px solid var(--brd)", background: "var(--bg)", cursor: "pointer" }}>
                          <span style={{ fontSize: 18, flexShrink: 0 }}>📄</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--tp)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.c.filename}</div>
                            <div style={{ fontSize: 11, color: "var(--tm)", marginTop: 2 }}>
                              {item.c.folderName}{item.c.parsedDate ? ` · ${item.c.parsedDate}` : ""}{item.c.parsedDirection ? ` · ${item.c.parsedDirection}` : ""}
                            </div>
                          </div>
                          <span style={{ fontSize: 11, color: "var(--acc)", fontWeight: 600, flexShrink: 0 }}>미리보기 →</span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
                {/* 미리보기 */}
                {docModal.url && <iframe src={docModal.url} style={{ flex: 1, border: "none" }} title={docModal.selected?.filename || ""} />}
              </div>
            </div>
          </div>
        )}

        {detailTab === "연결서류" && <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* 연결된 서류 목록 */}
          <div style={{ background: "var(--card)", borderRadius: 12, border: "1px solid var(--brd)", overflow: "hidden" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", borderBottom: "1px solid var(--brd)" }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>연결된 서류 <span className="mono" style={{ fontSize: 11, color: "var(--tm)" }}>({linkedDocs ? linkedDocs.length : 0})</span></div>
              {canEdit && <button onClick={runDocScan} disabled={scanning} style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 14px", borderRadius: 8, background: "#3b82f6", color: "#fff", fontSize: 12, fontWeight: 600, opacity: scanning ? 0.6 : 1 }}>
                {scanning ? <><span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>⟳</span> 스캔 중...</> : <><span>🔍</span> OneDrive 스캔</>}
              </button>}
            </div>
            {!linkedDocs && <div style={{ padding: 20, textAlign: "center", color: "var(--tm)", fontSize: 12 }}>불러오는 중...</div>}
            {linkedDocs && linkedDocs.length === 0 && !scanResult && <div style={{ padding: 24, textAlign: "center", color: "var(--tm)", fontSize: 12 }}>
              연결된 서류가 없습니다.<br />
              <span style={{ fontSize: 11, color: "var(--ts)" }}>위의 'OneDrive 스캔' 버튼을 눌러 자동으로 찾아보세요.</span>
            </div>}
            {linkedDocs && linkedDocs.length > 0 && <div style={{ display: "flex", flexDirection: "column" }}>
              {linkedDocs.map(doc => (
                <div key={doc.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: "1px solid var(--brd)", fontSize: 12 }}>
                  <span style={{ fontSize: 16 }}>{EXT_ICONS[doc.file_name.split(".").pop()?.toLowerCase()] || "📎"}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <a href={`/api/file-stream?path=${encodeURIComponent(doc.file_path)}`} target="_blank" rel="noopener noreferrer"
                       style={{ fontWeight: 500, color: "var(--acc)", textDecoration: "none", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                       title={doc.file_name}>
                      {doc.file_name}
                    </a>
                    <div style={{ display: "flex", gap: 8, marginTop: 2, color: "var(--ts)", fontSize: 10 }}>
                      {doc.match_type === "guarantor" && <span style={{ color: "#f59e0b", fontWeight: 600 }}>보증인 ({doc.matched_name})</span>}
                      {doc.linked_by && <span>연결: {doc.linked_by}</span>}
                      <span>{doc.linked_at?.slice(0, 10)}</span>
                    </div>
                  </div>
                  {canEdit && <button onClick={() => unlinkDoc(doc.id)} style={{ background: "none", color: "var(--err)", padding: 4, flexShrink: 0 }} title="연결 해제"><I name="trash" size={13} /></button>}
                </div>
              ))}
            </div>}
          </div>

          {/* 스캔 결과 - 후보 목록 */}
          {scanResult && <div style={{ background: "var(--card)", borderRadius: 12, border: "1px solid var(--brd)", overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--brd)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                스캔 결과
                {scanResult.ok && <span className="mono" style={{ fontSize: 11, color: "var(--tm)" }}>후보 {scanResult.candidates?.length}건 / 전체 {scanResult.totalScanned}개 파일 검색</span>}
              </div>
              <button onClick={() => setScanResult(null)} style={{ background: "none", color: "var(--tm)", padding: 4 }}><I name="close" size={14} /></button>
            </div>
            {!scanResult.ok && <div style={{ padding: 16, color: "var(--err)", fontSize: 12 }}>{scanResult.error}</div>}
            {scanResult.ok && scanResult.candidates?.length === 0 && <div style={{ padding: 20, textAlign: "center", color: "var(--tm)", fontSize: 12 }}>매칭되는 서류를 찾지 못했습니다.<br /><span style={{ fontSize: 11 }}>관리자 &gt; 시스템 설정 &gt; 서류 폴더 에서 경로가 올바른지 확인해주세요.</span></div>}
            {scanResult.ok && scanResult.candidates?.length > 0 && <div style={{ display: "flex", flexDirection: "column", maxHeight: 360, overflowY: "auto" }}>
              {scanResult.candidates.map((c, i) => {
                const alreadyLinked = linkedDocs?.some(d => d.file_path === c.filePath);
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: "1px solid var(--brd)", fontSize: 12, opacity: alreadyLinked ? 0.45 : 1 }}>
                    <span style={{ fontSize: 15 }}>{EXT_ICONS[c.ext] || "📎"}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.filename}>{c.filename}</div>
                      <div style={{ display: "flex", gap: 8, marginTop: 2, color: "var(--ts)", fontSize: 10 }}>
                        <span style={{ background: c.score >= 90 ? "#10b98120" : c.score >= 60 ? "#3b82f620" : "#f59e0b20", color: c.score >= 90 ? "var(--ok)" : c.score >= 60 ? "#3b82f6" : "#f59e0b", padding: "1px 5px", borderRadius: 4, fontWeight: 600 }}>
                          {c.score}점
                        </span>
                        <span>{c.matchReason}</span>
                        {c.matchType === "guarantor" && <span style={{ color: "#f59e0b" }}>보증인 ({c.matchedName})</span>}
                        <span style={{ color: "var(--ts)" }}>{c.folderName}</span>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                      <a href={`/api/file-stream?path=${encodeURIComponent(c.filePath)}`} target="_blank" rel="noopener noreferrer"
                         style={{ padding: "5px 10px", borderRadius: 6, background: "var(--bg)", color: "var(--tm)", fontSize: 11, fontWeight: 500, border: "1px solid var(--brd)", textDecoration: "none" }}>
                        열기
                      </a>
                      {!alreadyLinked && canEdit && <button onClick={() => linkDoc(c)} style={{ padding: "5px 10px", borderRadius: 6, background: "#3b82f6", color: "#fff", fontSize: 11, fontWeight: 600, border: "none" }}>
                        연결
                      </button>}
                      {alreadyLinked && <span style={{ padding: "5px 8px", fontSize: 10, color: "var(--ok)" }}>연결됨</span>}
                    </div>
                  </div>
                );
              })}
            </div>}
          </div>}
        </div>}
      </div>
    );
  });

  // ─── Payments View ──────────────────────────────────────
  const PaymentsView = useStableComponent(() => {
    const [pq, setPq] = useState(""); const [pBrand, setPBrand] = useState("전체"); const [pPage, setPPage] = useState(1);
    const [pFrom, setPFrom] = useState(""); const [pTo, setPTo] = useState("");
    // 대시보드 "오늘 입금 건수" 클릭 시 그 날짜로 필터를 걸어서 보여준다
    useEffect(() => {
      if (paymentsFocusDate) {
        setPaymentsSubTab("목록");
        setPq(""); setPBrand("전체");
        setPFrom(paymentsFocusDate); setPTo(paymentsFocusDate); setPPage(1);
        setPaymentsFocusDate(null);
      }
    }, [paymentsFocusDate]); // eslint-disable-line react-hooks/exhaustive-deps
    const pFiltered = useMemo(() => {
      let l = [...data.payments];
      if (pq) { const ql = pq.toLowerCase(); l = l.filter(p => (p.debtorName || "").toLowerCase().includes(ql) || (p.payerName || "").toLowerCase().includes(ql) || (p.hubName || "").toLowerCase().includes(ql) || (p.hubCode || "").toLowerCase().includes(ql)); }
      if (pBrand !== "전체") l = l.filter(p => p.brand === pBrand);
      if (pFrom) l = l.filter(p => p.paymentDate >= pFrom);
      if (pTo) l = l.filter(p => p.paymentDate <= pTo);
      return l;
    }, [data.payments, pq, pBrand, pFrom, pTo]);
    const pTP = Math.ceil(pFiltered.length / PP); const pPaged = pFiltered.slice((pPage - 1) * PP, pPage * PP);
    const totalAmt = pFiltered.reduce((s, p) => s + p.totalAmount, 0);
    // 페이지 윈도우 (현재 페이지 기준 앞뒤 최대 7개)
    const WIN = 7;
    let winStart = Math.max(1, pPage - 3);
    let winEnd = Math.min(pTP, winStart + WIN - 1);
    if (winEnd - winStart + 1 < WIN) winStart = Math.max(1, winEnd - WIN + 1);
    const pageNums = []; for (let p = winStart; p <= winEnd; p++) pageNums.push(p);
    const setQuickRange = (days) => {
      const t = new Date(); const f = new Date(); f.setDate(f.getDate() - days);
      setPFrom(f.toISOString().slice(0, 10)); setPTo(t.toISOString().slice(0, 10)); setPPage(1);
    };
    const clearRange = () => { setPFrom(""); setPTo(""); setPPage(1); };
    return (
      <div className="anim" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", gap: 2, background: "var(--card)", borderRadius: 10, padding: 4, border: "1px solid var(--brd)" }}>
          {[{ k: "목록", l: "입금 목록" }, { k: "미매칭", l: pendingCount > 0 ? "미매칭 관리 (" + pendingCount + ")" : "미매칭 관리" }].map(t => (
            <button key={t.k} onClick={() => setPaymentsSubTab(t.k)} style={{ flex: 1, padding: "10px 0", borderRadius: 8, fontSize: 13, fontWeight: 600, background: paymentsSubTab === t.k ? "var(--bg)" : "transparent", color: paymentsSubTab === t.k ? (t.k === "미매칭" && pendingCount > 0 ? "#ef4444" : "var(--tp)") : "var(--tm)" }}>{t.l}</button>
          ))}
        </div>
        {paymentsSubTab === "미매칭" && <PendingPaymentsView refreshKey={pendingRefreshKey} />}
        <div style={{ display: paymentsSubTab === "목록" ? "flex" : "none", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
          <KPI label="총 입금건수" value={`${pFiltered.length}건`} sub={`전체 ${data.payments.length}건`} color="#3b82f6" />
          <KPI label="총 입금액" value={fmt(totalAmt)} sub="필터 적용 합계" color="#10b981" />
          <KPI label="본사계좌" value={fmt(pFiltered.reduce((s, p) => s + p.companyAccount, 0))} sub="입금 채널별" color="#8b5cf6" />
          <KPI label="캐쉬충전+웰컴" value={fmt(pFiltered.reduce((s, p) => s + p.cashCharge + p.welcomeDirect, 0))} sub="기타 채널 합계" color="#f59e0b" />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, background: "var(--card)", borderRadius: 12, padding: 14, border: "1px solid var(--brd)" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ position: "relative", flex: 1, minWidth: 200 }}><div style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--tm)" }}><I name="search" size={14} /></div><KoreanInput value={pq} onChange={e => { setPq(e.target.value); setPPage(1); }} placeholder="채무자명, 입금자명, 허브명 검색..." style={{ width: "100%", paddingLeft: 32 }} /></div>
            <select value={pBrand} onChange={e => { setPBrand(e.target.value); setPPage(1); }} style={{ width: 110 }}><option value="전체">브랜드: 전체</option>{config.brands.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}</select>
            <button onClick={() => setModal({ type: "payment" })} style={{ display: "flex", alignItems: "center", gap: 4, padding: "7px 14px", borderRadius: 8, background: "var(--acc)", color: "#fff", fontSize: 12, fontWeight: 600 }}><I name="plus" size={14} />입금 등록</button>
            <button onClick={() => exportPayments(pFiltered)} style={{ display: "flex", alignItems: "center", gap: 4, padding: "7px 12px", borderRadius: 8, background: "#10b98118", color: "#10b981", fontSize: 12, fontWeight: 600, border: "1px solid #10b98140" }}><I name="arrowDown" size={14} />엑셀</button>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", borderTop: "1px dashed var(--brd)", paddingTop: 10 }}>
            <span style={{ fontSize: 12, color: "var(--tm)", fontWeight: 600, marginRight: 4 }}>입금일 :</span>
            <input type="date" value={pFrom} onChange={e => { setPFrom(e.target.value); setPPage(1); }} style={{ width: 150, fontSize: 12 }} />
            <span style={{ color: "var(--tm)" }}>~</span>
            <input type="date" value={pTo} onChange={e => { setPTo(e.target.value); setPPage(1); }} style={{ width: 150, fontSize: 12 }} />
            <button onClick={() => setQuickRange(7)} style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, background: "var(--bg)", color: "var(--ts)", border: "1px solid var(--brd)" }}>최근 7일</button>
            <button onClick={() => setQuickRange(30)} style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, background: "var(--bg)", color: "var(--ts)", border: "1px solid var(--brd)" }}>최근 30일</button>
            <button onClick={() => setQuickRange(90)} style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, background: "var(--bg)", color: "var(--ts)", border: "1px solid var(--brd)" }}>최근 90일</button>
            {(pFrom || pTo) && <button onClick={clearRange} style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, background: "#ef444418", color: "var(--err)", border: "1px solid #ef444440" }}>날짜 해제</button>}
            <span className="mono" style={{ marginLeft: "auto", fontSize: 12, color: "var(--tm)" }}>총 <b style={{ color: "var(--acc)" }}>{pFiltered.length}건</b> / 합계 <b style={{ color: "var(--acc)" }}>{fmt(totalAmt)}</b></span>
          </div>
        </div>
        <div style={{ background: "var(--card)", borderRadius: 12, border: "1px solid var(--brd)", overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}><thead><tr style={{ background: "var(--bg2)" }}>{["입금일","브랜드","담당","허브/지점","코드","채무자","입금자","합계","본사계좌","캐쉬충전","웰컴직접","비고",""].map(h => <th key={h} style={{ padding: "8px 10px", textAlign: "left", fontSize: 11, color: "var(--tm)", fontWeight: 600, borderBottom: "1px solid var(--brd)", whiteSpace: "nowrap" }}>{h}</th>)}</tr></thead><tbody>{pPaged.map(p => (<tr key={p.id} style={{ borderBottom: "1px solid var(--brd)", cursor: "pointer" }} onClick={() => { const d = data.debtors.find(x => x.id === p.debtorId); if (d) { navigateToDebtor(d, "입금내역"); } }} onMouseEnter={e => e.currentTarget.style.background = "var(--hover)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}><td className="mono" style={{ padding: "8px 10px" }}>{fmtDate(p.paymentDate)}</td><td style={{ padding: "8px 10px" }}><BrandBadge code={p.brand} brands={config.brands} /></td><td style={{ padding: "8px 10px" }}>{p.assignee}</td><td style={{ padding: "8px 10px", color: "var(--ts)" }}>{p.hubName}</td><td className="mono" style={{ padding: "8px 10px", color: "var(--tm)" }}>{p.hubCode}</td><td style={{ padding: "8px 10px", fontWeight: 500 }}>{p.debtorName}</td><td style={{ padding: "8px 10px" }}>{p.payerName}</td><td className="mono" style={{ padding: "8px 10px", fontWeight: 600 }}>{fmt(p.totalAmount)}</td><td className="mono" style={{ padding: "8px 10px", color: p.companyAccount > 0 ? "var(--tp)" : "var(--tm)" }}>{p.companyAccount > 0 ? fmt(p.companyAccount) : "-"}</td><td className="mono" style={{ padding: "8px 10px", color: p.cashCharge > 0 ? "var(--tp)" : "var(--tm)" }}>{p.cashCharge > 0 ? fmt(p.cashCharge) : "-"}</td><td className="mono" style={{ padding: "8px 10px", color: p.welcomeDirect > 0 ? "var(--tp)" : "var(--tm)" }}>{p.welcomeDirect > 0 ? fmt(p.welcomeDirect) : "-"}</td><td style={{ padding: "8px 10px", color: "var(--ts)" }}>{p.note || "-"}</td><td style={{ padding: "8px 10px" }}><div style={{ display: "flex", gap: 4, alignItems: "center" }}>{canEdit && <button onClick={(e) => { e.stopPropagation(); setModal({ type: "rematch", payment: p }); }} style={{ background: "none", color: "#f59e0b", padding: 2 }} title="재매칭"><I name="refresh" size={13} /></button>}{canEdit && <button onClick={(e) => { e.stopPropagation(); if (confirm(`${fmtDate(p.paymentDate)} ${fmt(p.totalAmount)} 입금을 삭제하시겠습니까?`)) { deletePayment(p.id); addLog("삭제", "입금", `${p.debtorName} — ${fmt(p.totalAmount)} 삭제`); showToast("입금 삭제 완료"); } }} style={{ background: "none", color: "var(--err)", padding: 2 }}><I name="trash" size={13} /></button>}</div></td></tr>))}</tbody></table></div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderTop: "1px solid var(--brd)" }}>
            <span style={{ fontSize: 12, color: "var(--tm)" }}>{pFiltered.length === 0 ? 0 : (pPage - 1) * PP + 1}-{Math.min(pPage * PP, pFiltered.length)} / {pFiltered.length}건 (총 {pTP || 1}페이지)</span>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <button onClick={() => setPPage(1)} disabled={pPage <= 1} style={{ padding: "6px 10px", borderRadius: 6, fontSize: 11, background: "transparent", color: pPage <= 1 ? "var(--tm)" : "var(--ts)", border: "1px solid var(--brd)", opacity: pPage <= 1 ? 0.5 : 1 }}>« 처음</button>
              <button onClick={() => setPPage(Math.max(1, pPage - 1))} disabled={pPage <= 1} style={{ padding: "6px 10px", borderRadius: 6, fontSize: 11, background: "transparent", color: pPage <= 1 ? "var(--tm)" : "var(--ts)", border: "1px solid var(--brd)", opacity: pPage <= 1 ? 0.5 : 1 }}>‹ 이전</button>
              {pageNums.map(p => (<button key={p} onClick={() => setPPage(p)} style={{ width: 32, height: 32, borderRadius: 6, fontSize: 12, fontWeight: 500, background: pPage === p ? "var(--acc)" : "transparent", color: pPage === p ? "#fff" : "var(--tm)" }}>{p}</button>))}
              <button onClick={() => setPPage(Math.min(pTP, pPage + 1))} disabled={pPage >= pTP} style={{ padding: "6px 10px", borderRadius: 6, fontSize: 11, background: "transparent", color: pPage >= pTP ? "var(--tm)" : "var(--ts)", border: "1px solid var(--brd)", opacity: pPage >= pTP ? 0.5 : 1 }}>다음 ›</button>
              <button onClick={() => setPPage(pTP)} disabled={pPage >= pTP} style={{ padding: "6px 10px", borderRadius: 6, fontSize: 11, background: "transparent", color: pPage >= pTP ? "var(--tm)" : "var(--ts)", border: "1px solid var(--brd)", opacity: pPage >= pTP ? 0.5 : 1 }}>끝 »</button>
            </div>
          </div>
        </div>
        </div>
      </div>
    );
  });


  // ─── Installments View ──────────────────────────────────
  const InstallmentsView = useStableComponent(() => {
    const now = new Date();
    const [stFilter, setStFilter] = useState("전체");
    const [importing, setImporting] = useState(false);
    const [editDateId, setEditDateId] = useState(null);
    const [editDateVal, setEditDateVal] = useState("");
    const [dragSchedId, setDragSchedId] = useState(null);
    const [dragOverDate, setDragOverDate] = useState(null);
    const [cardSearch, setCardSearch] = useState("");
    const [planSearch, setPlanSearch] = useState("");
    const [addSchedModal, setAddSchedModal] = useState(null); // null | { date: "YYYY-MM-DD", planId?: string }
    const [planPopup, setPlanPopup] = useState(null); // null | plan object
    const [pPlanEditing, setPPlanEditing] = useState(false);
    const [pPlanEditMonthly, setPPlanEditMonthly] = useState("");
    const [pPlanEditMemo, setPPlanEditMemo] = useState("");
    const [pPlanSaving, setPPlanSaving] = useState(false);
    const [pSchedEditId, setPSchedEditId] = useState(null);
    const [pSchedEditDate, setPSchedEditDate] = useState("");
    const [pSchedEditAmt, setPSchedEditAmt] = useState("");
    const [pSchedEditMemo, setPSchedEditMemo] = useState("");
    const [pSchedEditStatus, setPSchedEditStatus] = useState("예정");

    // 대시보드 "○○ 분할상환 대상자" 클릭 시 그 날짜의 일정 팝업을 바로 열어준다
    useEffect(() => {
      if (installmentsFocusDate) {
        setInstTab("이번달");
        setViewMonth(installmentsFocusDate.slice(0, 7));
        setDayPopup(installmentsFocusDate);
        setInstallmentsFocusDate(null);
      }
    }, [installmentsFocusDate]); // eslint-disable-line react-hooks/exhaustive-deps

    const thisMonthSchedsAll = useMemo(() => {
      return (data.installmentSchedules || []).filter(s =>
        (s.dueMonth === viewMonth || (s.dueDate && s.dueDate.startsWith(viewMonth))) && s.status !== "이월"
      );
    }, [data.installmentSchedules, viewMonth]);

    const thisMonthScheds = useMemo(() => {
      if (stFilter === "전체") return thisMonthSchedsAll;
      return thisMonthSchedsAll.filter(s => s.status === stFilter);
    }, [thisMonthSchedsAll, stFilter]);

    const monthStats = useMemo(() => ({
      total: thisMonthSchedsAll.length,
      done: thisMonthSchedsAll.filter(s => s.status === "완납").length,
      partial: thisMonthSchedsAll.filter(s => s.status === "일부납").length,
      unpaid: thisMonthSchedsAll.filter(s => s.status === "미납").length,
      overdue: thisMonthSchedsAll.filter(s => s.status === "지연").length,
      scheduled: thisMonthSchedsAll.filter(s => s.status === "예정").length,
      totalAmt: thisMonthSchedsAll.reduce((a, s) => a + (s.scheduledAmount || 0), 0),
      doneAmt: thisMonthSchedsAll.filter(s => s.status === "완납").reduce((a, s) => a + (s.scheduledAmount || 0), 0),
      partialAmt: thisMonthSchedsAll.filter(s => s.status === "일부납").reduce((a, s) => a + (s.paidAmount || 0), 0),
    }), [thisMonthSchedsAll]);

    const monthLabel = (ym) => {
      const [y, m] = ym.split("-");
      return `${y}년 ${parseInt(m)}월`;
    };
    const prevMonth = (ym) => { const d = new Date(ym + "-01"); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); };
    const nextMonth = (ym) => { const d = new Date(ym + "-01"); d.setMonth(d.getMonth() + 1); return d.toISOString().slice(0, 7); };

    const markComplete = async (schedId) => {
      await fetch(`/api/installments/schedules/${schedId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "완납" }) });
      await reloadInstallments();
    };
    const markUnpaid = async (schedId) => {
      await fetch(`/api/installments/schedules/${schedId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "미납" }) });
      await reloadInstallments();
    };
    const saveDate = async (schedId) => {
      if (!editDateVal) return setEditDateId(null);
      await fetch(`/api/installments/schedules/${schedId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dueDate: editDateVal, dueMonth: editDateVal.slice(0, 7) }) });
      setEditDateId(null);
      await reloadInstallments();
      showToast("날짜 지정 완료");
    };
    const dropOnDate = async (targetDate) => {
      if (!dragSchedId || !targetDate) return;
      setDragSchedId(null);
      setDragOverDate(null);
      await fetch(`/api/installments/schedules/${dragSchedId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dueDate: targetDate, dueMonth: targetDate.slice(0, 7) }),
      });
      await reloadInstallments();
      showToast("날짜 변경 완료");
    };
    const deleteSchedule = async (schedId) => {
      if (!confirm("이 일정을 삭제하시겠습니까?")) return;
      await fetch(`/api/installments/schedules/${schedId}`, { method: "DELETE" });
      await reloadInstallments();
      showToast("삭제 완료");
    };
    const doImport = async () => {
      if (!confirm("엑셀 파일의 분할상환 데이터를 DB로 이관합니다.\n중복 항목은 자동으로 건너뜁니다.\n계속할까요?")) return;
      setImporting(true);
      try {
        const r = await fetch("/api/installments/import-excel", { method: "POST", headers: { "Content-Type": "application/json" } });
        const result = await r.json();
        if (result.ok) {
          await reloadInstallments();
          showToast(`이관 완료: 등록 ${result.imported}건 / 건너뜀 ${result.skipped}건 / 플랜 생성 ${result.planCreated}건`);
        } else { showToast("이관 실패: " + result.error); }
      } catch(e) { showToast("이관 실패"); }
      setImporting(false);
    };
    const checkOverdue = async () => {
      const r = await fetch("/api/installments/auto-overdue", { method: "POST", headers: { "Content-Type": "application/json" } });
      const result = await r.json();
      if (result.updated > 0) { await reloadInstallments(); showToast(`지연 ${result.updated}건 자동 처리됨`); }
      else showToast("지연 건 없음");
    };
    const sendMonthlyNotify = async () => {
      const r = await fetch("/api/installments/monthly-notify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: true }) });
      const result = await r.json();
      showToast(result.sent ? "Slack 알림 전송 완료" : (result.reason || "알림 없음"));
    };

    const scColor = (st) => st === "완납" ? { bg: "#10b98110", t: "#047857", b: "#10b98130" } : st === "지연" ? { bg: "#f59e0b10", t: "#b45309", b: "#f59e0b30" } : st === "이월" ? { bg: "#8b5cf610", t: "#6d28d9", b: "#8b5cf640" } : st === "예정" ? { bg: "#3b82f610", t: "#1d4ed8", b: "#3b82f630" } : st === "일부납" ? { bg: "#fb923c10", t: "#c2410c", b: "#fb923c30" } : { bg: "#ef444410", t: "#b91c1c", b: "#ef444430" };

    const calCells = useMemo(() => {
      const [y, m] = viewMonth.split("-").map(Number);
      const firstDow = new Date(y, m - 1, 1).getDay();
      const daysInMonth = new Date(y, m, 0).getDate();
      const cells = [];
      for (let i = 0; i < firstDow; i++) cells.push(null);
      for (let d = 1; d <= daysInMonth; d++) cells.push(d);
      while (cells.length % 7 !== 0) cells.push(null);
      return cells;
    }, [viewMonth]);

    const schedsByDate = useMemo(() => {
      const map = {};
      thisMonthScheds.filter(s => s.dueDate).forEach(s => {
        if (!map[s.dueDate]) map[s.dueDate] = [];
        map[s.dueDate].push(s);
      });
      return map;
    }, [thisMonthScheds]);

    const undatedScheds = useMemo(() => {
      const cq = cardSearch.toLowerCase();
      let list = thisMonthScheds.filter(s => !s.dueDate);
      if (cardSearch) list = list.filter(s => (s.debtorName || "").toLowerCase().includes(cq));
      return list;
    }, [thisMonthScheds, cardSearch]);
    const datedScheds = useMemo(() => {
      const cq = cardSearch.toLowerCase();
      let list = thisMonthScheds.filter(s => s.dueDate).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      if (cardSearch) list = list.filter(s => (s.debtorName || "").toLowerCase().includes(cq));
      return list;
    }, [thisMonthScheds, cardSearch]);

    const todayStr = now.toISOString().slice(0, 10);
    const cellDate = (day) => `${viewMonth}-${String(day).padStart(2, "0")}`;
    const calRows = calCells.length / 7;
    const calBodyH = calRows * 82;
    const undatedSectionH = undatedScheds.length > 0 ? 66 : 0;
    const calPanelH = 37 + calBodyH + undatedSectionH;

    // ── 일정 추가 모달 (달력 + 버튼) ──────────────────────────
    const AddSchedModal = useStableComponent(() => {
      const initDate = addSchedModal?.date || "";
      const initPlanId = addSchedModal?.planId || null;
      const initDebtorId = initPlanId ? (data.installmentPlans.find(p => p.id === initPlanId)?.debtorId || "") : "";
      const [debtorId, setDebtorId] = useState(initDebtorId);
      const [date, setDate] = useState(initDate);
      const [amountStr, setAmountStr] = useState("");
      const [status, setStatus] = useState("예정");
      const [newPlanTiming] = useState("");
      const [memo, setMemo] = useState("");
      const [repeatType, setRepeatType] = useState("없음");
      const [repeatEnd, setRepeatEnd] = useState("");
      const [useEndOfMonth, setUseEndOfMonth] = useState(false);
      const [saving, setSaving] = useState(false);

      const debtor = data.debtors.find(d => d.id === debtorId);
      const plan = data.installmentPlans.find(p => p.debtorId === debtorId);
      const totalClaim = plan?.totalClaim || debtor?.finalBalanceLegal || 0;
      const parsedAmount = parseInt(amountStr.replace(/,/g, ""), 10) || 0;
      const firstDay = date ? new Date(date + "T00:00:00").getDate() : 0;
      const showEndOfMonthToggle = repeatType === "월간" && firstDay >= 28;

      // 추천 계산 (월간: 횟수, 주간/격주: 주 수)
      const suggestedCount = totalClaim > 0 && parsedAmount > 0 ? Math.ceil(totalClaim / parsedAmount) : 0;
      const applySuggestion = () => {
        if (!date || !suggestedCount) return;
        const d = new Date(date + "T00:00:00");
        if (repeatType === "월간") {
          const origDay = useEndOfMonth ? 31 : d.getDate();
          const ny = d.getFullYear() + Math.floor((d.getMonth() + suggestedCount - 1) / 12);
          const nm = (d.getMonth() + suggestedCount - 1) % 12;
          const lastDay = new Date(ny, nm + 1, 0).getDate();
          d.setFullYear(ny, nm, Math.min(origDay, lastDay));
        } else if (repeatType === "주간") {
          d.setDate(d.getDate() + (suggestedCount - 1) * 7);
        } else if (repeatType === "격주") {
          d.setDate(d.getDate() + (suggestedCount - 1) * 14);
        }
        setRepeatEnd(localStr(d));
      };
      const suggestionLabel = repeatType === "월간" ? `약 ${suggestedCount}개월` : repeatType === "주간" ? `약 ${suggestedCount}주` : repeatType === "격주" ? `약 ${suggestedCount}회(격주)` : "";

      const localStr = (d) => {
        if (!d || isNaN(d.getTime())) return "";
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
      };

      const generateDates = () => {
        if (!date) return [];
        if (repeatType === "없음" || !repeatEnd) return [date];
        const dates = [];
        const end = new Date(repeatEnd + "T00:00:00");
        if (isNaN(end.getTime())) return [date];
        const MAX = 1200;
        if (repeatType === "월간") {
          const origDay = useEndOfMonth ? 31 : new Date(date + "T00:00:00").getDate();
          let cur = new Date(date + "T00:00:00");
          while (dates.length < MAX) {
            if (isNaN(cur.getTime()) || cur > end) break;
            dates.push(localStr(cur));
            const nm = cur.getMonth() === 11 ? 0 : cur.getMonth() + 1;
            const ny = cur.getMonth() === 11 ? cur.getFullYear() + 1 : cur.getFullYear();
            const daysInNm = new Date(ny, nm + 1, 0).getDate();
            cur = new Date(ny, nm, Math.min(origDay, daysInNm));
          }
        } else {
          const interval = repeatType === "주간" ? 7 : 14;
          let cur = new Date(date + "T00:00:00");
          while (dates.length < MAX) {
            if (isNaN(cur.getTime()) || cur > end) break;
            dates.push(localStr(cur));
            cur.setDate(cur.getDate() + interval);
          }
        }
        return dates;
      };

      const previewDates = generateDates();

      const handleSave = async () => {
        if (!debtorId) return showToast("채무자를 선택하세요");
        if (!date) return showToast("날짜를 입력하세요");
        setSaving(true);
        try {
          let targetPlanId = plan?.id;
          // 플랜 없으면 자동 생성
          if (!targetPlanId) {
            const newPlanId = uid("INS");
            const pr = await fetch("/api/installments", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: newPlanId, debtorId, paymentTiming: newPlanTiming, monthlyAmount: parsedAmount, startDate: date, status: "진행중", memo: "" }),
            });
            const pResult = await pr.json();
            if (!pResult.ok) { showToast(pResult.error || "플랜 생성 실패"); setSaving(false); return; }
            targetPlanId = newPlanId;
          }
          const schedules = previewDates.map((d, idx) => {
            let amt = parsedAmount;
            if (totalClaim > 0 && parsedAmount > 0 && previewDates.length > 1 && idx === previewDates.length - 1) {
              const remainder = totalClaim - (previewDates.length - 1) * parsedAmount;
              if (remainder > 0 && remainder < parsedAmount) amt = remainder;
            }
            return { id: "SCH" + Math.random().toString(36).slice(2, 11).toUpperCase(), dueDate: d, dueMonth: d.slice(0, 7), scheduledAmount: amt, status, memo };
          });
          const r = await fetch("/api/installments/schedules/batch", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ planId: targetPlanId, schedules }),
          });
          const result = await r.json();
          if (!result.ok) { showToast(result.error || "저장 실패"); setSaving(false); return; }
          await reloadInstallments();
          setAddSchedModal(null);
          showToast(`일정 ${schedules.length}건 추가 완료`);
        } catch(e) { showToast("저장 실패"); }
        setSaving(false);
      };

      return (
        <Overlay onClose={() => setAddSchedModal(null)}>
          <ModalHeader title={`일정 추가${initDate ? ` — ${initDate.slice(5).replace("-", "/")}` : ""}`} onClose={() => setAddSchedModal(null)} />
          <div style={{ display: "grid", gap: 12 }}>
            <Field label="채무자">
              <DebtorSearchField value={debtorId} onChange={setDebtorId} />
              {plan && totalClaim > 0 && <div style={{ fontSize: 11, color: "var(--tm)", marginTop: 3 }}>잔여채권: <b>{fmt(totalClaim)}</b></div>}
              {debtorId && !plan && (
                <div style={{ marginTop: 6, padding: "7px 10px", background: "#eff6ff", borderRadius: 7, border: "1px solid #bfdbfe", fontSize: 11, color: "#1d4ed8", fontWeight: 600 }}>+ 분할상환 플랜을 새로 생성합니다</div>
              )}
            </Field>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="날짜"><input type="date" value={date} onChange={e => setDate(e.target.value)} style={inp} /></Field>
              <Field label="금액(원)"><MoneyInput value={amountStr} onChange={setAmountStr} style={inp} placeholder="예: 300,000" /></Field>
            </div>
            <Field label="상태">
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {["예정", "미납", "일부납", "완납", "이월"].map(s => {
                  const c = scColor(s);
                  return (
                    <button key={s} onClick={() => setStatus(s)} style={{ padding: "4px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: status === s ? c.bg : "var(--bg2)", color: status === s ? c.t : "var(--tm)", border: `1px solid ${status === s ? c.b : "var(--brd)"}`, cursor: "pointer" }}>{s}</button>
                  );
                })}
              </div>
            </Field>
            <Field label="특이사항 메모">
              <KoreanTextarea value={memo} onChange={e => setMemo(e.target.value)} style={{ ...inp, height: 52, resize: "vertical" }} placeholder="메모 (선택)" />
            </Field>
            <div style={{ borderRadius: 8, border: "1px solid var(--brd)", overflow: "hidden" }}>
              <div onClick={() => setRepeatType(p => p === "없음" ? "월간" : "없음")} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", cursor: "pointer", background: repeatType !== "없음" ? "#3b82f610" : "var(--bg2)", userSelect: "none" }}>
                <div style={{ width: 16, height: 16, borderRadius: 4, border: `2px solid ${repeatType !== "없음" ? "var(--acc)" : "var(--brd)"}`, background: repeatType !== "없음" ? "var(--acc)" : "transparent", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {repeatType !== "없음" && <span style={{ color: "#fff", fontSize: 10, fontWeight: 700 }}>✓</span>}
                </div>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--tp)" }}>되풀이 일정 등록</span>
                {repeatType !== "없음" && repeatEnd && <span style={{ fontSize: 11, color: "var(--acc)", marginLeft: "auto" }}>{repeatType} · {previewDates.length}건</span>}
              </div>
              {repeatType !== "없음" && (
                <div style={{ padding: "12px", borderTop: "1px solid var(--brd)", display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ display: "flex", gap: 5 }}>
                    {["주간", "격주", "월간"].map(t => (
                      <button key={t} onClick={() => { setRepeatType(t); setUseEndOfMonth(false); }} style={{ flex: 1, padding: "6px 0", borderRadius: 7, fontSize: 12, fontWeight: 600, border: "1px solid var(--brd)", cursor: "pointer", background: repeatType === t ? "var(--acc)" : "var(--bg2)", color: repeatType === t ? "#fff" : "var(--tp)" }}>{t}</button>
                    ))}
                  </div>
                  {showEndOfMonthToggle && (
                    <div style={{ padding: "8px 12px", background: "#fff7ed", borderRadius: 8, border: "1px solid #fed7aa", fontSize: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ color: "#92400e", fontWeight: 600 }}>매월 납부일:</span>
                      {[false, true].map(eom => (
                        <button key={String(eom)} onClick={() => setUseEndOfMonth(eom)}
                          style={{ padding: "4px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", border: "1px solid", borderColor: useEndOfMonth === eom ? "#f97316" : "var(--brd)", background: useEndOfMonth === eom ? "#f97316" : "var(--bg)", color: useEndOfMonth === eom ? "#fff" : "var(--tp)" }}>
                          {eom ? "말일" : `${firstDay}일 고정`}
                        </button>
                      ))}
                      <span style={{ fontSize: 11, color: "#92400e" }}>{useEndOfMonth ? "매달 마지막 날" : `매달 ${firstDay}일 (짧은 달은 말일)`}</span>
                    </div>
                  )}
                  <Field label="종료일"><input type="date" value={repeatEnd} onChange={e => setRepeatEnd(e.target.value)} style={inp} /></Field>
                  {suggestedCount > 0 && (
                    <div style={{ padding: "7px 10px", background: "#3b82f612", borderRadius: 6, fontSize: 11, color: "var(--acc)", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <span>자동 추천: <b>{suggestionLabel}</b></span>
                      {(() => {
                        const lastAmt = totalClaim - (suggestedCount - 1) * parsedAmount;
                        return lastAmt > 0 && lastAmt < parsedAmount ? <span style={{ color: "var(--tm)" }}>(마지막 {fmt(lastAmt)}원)</span> : null;
                      })()}
                      {date && <button onClick={applySuggestion} style={{ marginLeft: "auto", padding: "2px 8px", borderRadius: 5, fontSize: 11, background: "var(--acc)", color: "#fff", border: "none", cursor: "pointer" }}>적용</button>}
                    </div>
                  )}
                  {previewDates.length > 1 && (
                    <div style={{ fontSize: 11, color: "var(--tm)", lineHeight: 1.7 }}>
                      <b>총 {previewDates.length}건</b> 생성 예정: {previewDates.slice(0, 5).map(d => d.slice(5).replace("-", "/")).join(", ")}{previewDates.length > 5 ? ` … 외 ${previewDates.length - 5}건` : ""}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          <ModalFooter onCancel={() => setAddSchedModal(null)} onSave={handleSave} saveLabel={saving ? "저장중…" : `일정 ${previewDates.length}건 추가`} />
        </Overlay>
      );
    });

    // ── PlanDetailPopup 핸들러 (InstallmentsView 스코프 — 리렌더 시 참조 안정) ──
    const onPlanClose = () => { setPlanPopup(null); setPPlanEditing(false); setPSchedEditId(null); };
    const onPlanStartEdit = () => {
      const plan = data.installmentPlans.find(p => p.id === planPopup?.id) || planPopup;
      setPPlanEditMonthly(plan?.monthlyAmount ? String(plan.monthlyAmount) : "");
      setPPlanEditMemo(plan?.memo || "");
      setPPlanEditing(true);
    };
    const onPlanSave = async () => {
      setPPlanSaving(true);
      await fetch(`/api/installments/${planPopup?.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthlyAmount: Number(pPlanEditMonthly) || 0, memo: pPlanEditMemo }),
      });
      await reloadInstallments();
      setPPlanEditing(false);
      setPPlanSaving(false);
      showToast("플랜 정보 수정 완료");
    };
    const onPlanDelete = async () => {
      const plan = data.installmentPlans.find(p => p.id === planPopup?.id) || planPopup;
      if (!confirm(`${plan?.debtorName} 플랜 및 모든 일정(${(plan?.schedules || []).length}건)을 삭제하시겠습니까?`)) return;
      await fetch(`/api/installments/${planPopup?.id}`, { method: "DELETE" });
      await reloadInstallments();
      onPlanClose();
      showToast("삭제 완료");
    };
    const onSchedStartEdit = (s) => {
      setPSchedEditId(s.id);
      setPSchedEditDate(s.dueDate || "");
      setPSchedEditAmt(s.scheduledAmount ? String(s.scheduledAmount) : "");
      setPSchedEditMemo(s.memo || "");
      setPSchedEditStatus(s.status || "예정");
    };
    const onSchedSave = async (schedId) => {
      await fetch(`/api/installments/schedules/${schedId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dueDate: pSchedEditDate || null, dueMonth: pSchedEditDate ? pSchedEditDate.slice(0, 7) : null, scheduledAmount: parseInt(pSchedEditAmt.replace(/,/g, ""), 10) || 0, memo: pSchedEditMemo, status: pSchedEditStatus }),
      });
      await reloadInstallments();
      setPSchedEditId(null);
      showToast("일정 수정 완료");
    };
    const onSchedDelete = async (schedId) => {
      if (!confirm("이 일정을 삭제하시겠습니까?")) return;
      await fetch(`/api/installments/schedules/${schedId}`, { method: "DELETE" });
      await reloadInstallments();
      showToast("일정 삭제 완료");
    };

    // ── 플랜 상세 팝업 (hook 없음 → 함수 직접 호출로 remount 방지) ──
    const PlanDetailPopup = () => {
      const plan = data.installmentPlans.find(p => p.id === planPopup?.id) || planPopup;
      if (!plan) return null;
      const d = data.debtors.find(x => x.id === plan.debtorId);
      const scheds = (plan.schedules || []).slice().sort((a, b) => (a.dueDate || a.dueMonth || "").localeCompare(b.dueDate || b.dueMonth || ""));
      const overdue = scheds.filter(s => s.status === "지연").length;

      // 금액 기반 스택 진행 바
      const totalClaim = plan.totalClaim || d?.finalBalanceLegal || 0;
      const plannedTotal = scheds.reduce((sum, s) => sum + (s.scheduledAmount || 0), 0);
      const paidTotal = scheds.filter(s => s.status === "완납").reduce((sum, s) => sum + (s.paidAmount || s.scheduledAmount || 0), 0);
      const paidPct = totalClaim > 0 ? Math.min(100, (paidTotal / totalClaim) * 100) : 0;
      const plannedPct = totalClaim > 0 ? Math.min(100 - paidPct, Math.max(0, (plannedTotal - paidTotal) / totalClaim * 100)) : 0;

      return (
        <Overlay onClose={onPlanClose}>
          <ModalHeader title={`${plan.debtorName} — 분할상환 플랜`} onClose={onPlanClose} />

          {/* 요약 헤더 */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
            <BrandBadge code={plan.brand} brands={config.brands} />
            {plan.hubName && <span style={{ fontSize: 12, color: "var(--ts)" }}>{plan.hubName}</span>}
            {plan.startDate && <span style={{ fontSize: 12, color: "var(--tm)" }}>시작 {plan.startDate.slice(5).replace("-", "/")}</span>}
            <span style={{ fontSize: 12, color: "var(--ts)", marginLeft: "auto" }}>총채권 <b className="mono">{fmt(totalClaim)}</b></span>
          </div>

          {/* 진행 바 */}
          <div style={{ marginBottom: 14 }}>
            {overdue > 0 && <div style={{ fontSize: 11, color: "#b45309", marginBottom: 4 }}>⚠ 지연 {overdue}건</div>}
            {/* 회색 배경(미예정 잔여) + 주황 점선 윤곽(예정 합계) + 초록 실선(실제 상환) */}
            <div style={{ height: 12, background: "var(--bg2)", borderRadius: 6, marginBottom: 6, position: "relative" }}>
              {/* 예정 합계 — 주황 점선 윤곽만 */}
              {(paidPct + plannedPct) > 0 && (
                <div style={{
                  position: "absolute", left: 0, top: 0, height: "100%",
                  width: `${Math.min(100, paidPct + plannedPct)}%`,
                  borderRadius: paidPct + plannedPct >= 100 ? 6 : "6px 0 0 6px",
                  border: "2px dashed #f97316",
                  boxSizing: "border-box",
                  transition: "width .3s",
                }} />
              )}
              {/* 실제 상환 — 초록 채움 */}
              {paidPct > 0 && (
                <div style={{
                  position: "absolute", left: 0, top: 0, height: "100%",
                  width: `${paidPct}%`,
                  background: "#10b981",
                  borderRadius: paidPct >= 100 ? 6 : "6px 0 0 6px",
                  transition: "width .3s",
                }} />
              )}
            </div>
            <div style={{ display: "flex", gap: 10, fontSize: 11, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width: 10, height: 8, borderRadius: 2, background: "#10b981", flexShrink: 0 }} />
                <span style={{ color: "var(--tm)" }}>실제 상환</span>
                <b className="mono" style={{ color: "#047857" }}>{fmt(paidTotal)}</b>
                {totalClaim > 0 && <span style={{ color: "var(--ts)" }}>({Math.round(paidPct)}%)</span>}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width: 10, height: 8, borderRadius: 2, border: "2px dashed #f97316", boxSizing: "border-box", flexShrink: 0 }} />
                <span style={{ color: "var(--tm)" }}>예정 합계</span>
                <b className="mono" style={{ color: "#ea580c" }}>{fmt(plannedTotal)}</b>
                {totalClaim > 0 && <span style={{ color: "var(--ts)" }}>({Math.round(plannedTotal / totalClaim * 100)}%)</span>}
              </div>
              {totalClaim > plannedTotal && (
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <div style={{ width: 10, height: 8, borderRadius: 2, background: "var(--bg2)", border: "1px solid var(--brd)", flexShrink: 0 }} />
                  <span style={{ color: "var(--tm)" }}>미예정 잔여</span>
                  <b className="mono" style={{ color: "var(--ts)" }}>{fmt(totalClaim - plannedTotal)}</b>
                </div>
              )}
            </div>
          </div>

          {/* 편집 폼 or 메모 */}
          {pPlanEditing ? (
            <div style={{ background: "var(--bg2)", borderRadius: 10, padding: "12px 14px", marginBottom: 12, border: "1px solid var(--brd)" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--tp)", marginBottom: 10 }}>플랜 정보 수정</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: "var(--tm)", width: 60, flexShrink: 0 }}>월 납부액</span>
                  <MoneyInput value={pPlanEditMonthly} onChange={setPPlanEditMonthly} style={{ ...inp, flex: 1, fontSize: 12 }} placeholder="0" />
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                  <span style={{ fontSize: 11, color: "var(--tm)", width: 60, flexShrink: 0, paddingTop: 4 }}>메모</span>
                  <KoreanTextarea value={pPlanEditMemo} onChange={e => setPPlanEditMemo(e.target.value)} rows={2} style={{ ...inp, flex: 1, fontSize: 12, resize: "vertical" }} />
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 10, justifyContent: "flex-end" }}>
                <button onClick={() => setPPlanEditing(false)} style={{ padding: "5px 14px", borderRadius: 7, background: "var(--bg)", color: "var(--tm)", border: "1px solid var(--brd)", fontSize: 12, cursor: "pointer" }}>취소</button>
                <button onClick={onPlanSave} disabled={pPlanSaving} style={{ padding: "5px 14px", borderRadius: 7, background: "var(--acc)", color: "#fff", border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>{pPlanSaving ? "저장중…" : "저장"}</button>
              </div>
            </div>
          ) : (
            plan.memo && <div style={{ background: "#eff6ff", borderRadius: 8, padding: "6px 12px", marginBottom: 10, fontSize: 12, color: "#1d4ed8", borderLeft: "3px solid #93c5fd" }}>{plan.memo}</div>
          )}

          {/* 액션 버튼 */}
          <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
            {canEdit && !pPlanEditing && (
              <button onClick={onPlanStartEdit} style={{ padding: "5px 12px", borderRadius: 7, background: "var(--bg2)", color: "var(--tp)", border: "1px solid var(--brd)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>✏ 정보 수정</button>
            )}
            {canEdit && (
              <button onClick={() => setAddSchedModal({ date: new Date().toISOString().slice(0, 10), planId: plan.id })}
                style={{ padding: "5px 12px", borderRadius: 7, background: "var(--acc)", color: "#fff", border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>+ 일정 추가</button>
            )}
            {d && (
              <button onClick={() => { navigateToDebtor(d, "분할상환"); onPlanClose(); }}
                style={{ padding: "5px 12px", borderRadius: 7, background: "#3b82f618", color: "#3b82f6", border: "1px solid #3b82f640", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>채무자 페이지 ↗</button>
            )}
            {canEdit && (
              <button onClick={onPlanDelete}
                style={{ padding: "5px 12px", borderRadius: 7, background: "#ef444418", color: "var(--err)", border: "1px solid #ef444430", fontSize: 12, fontWeight: 600, cursor: "pointer", marginLeft: "auto" }}>삭제</button>
            )}
          </div>

          {/* 납부 일정 목록 */}
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--tp)", marginBottom: 8 }}>납부 일정 ({scheds.length}건)</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {scheds.length === 0 && <div style={{ padding: 20, textAlign: "center", color: "var(--tm)", fontSize: 12 }}>일정 없음 — 위 '+ 일정 추가'로 추가하세요</div>}
            {scheds.map((s, i) => {
              const c = scColor(s.status);
              const isEditRow = pSchedEditId === s.id;
              return (
                <div key={s.id} style={{ background: "var(--bg2)", borderRadius: 7, border: `1px solid ${isEditRow ? "var(--acc)" : c.b}`, overflow: "hidden" }}>
                  {isEditRow ? (
                    <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={{ display: "flex", gap: 8 }}>
                        <input type="date" value={pSchedEditDate} onChange={e => setPSchedEditDate(e.target.value)} style={{ ...inp, flex: 1, fontSize: 12 }} />
                        <MoneyInput value={pSchedEditAmt} onChange={setPSchedEditAmt} style={{ ...inp, flex: 1, fontSize: 12 }} placeholder="금액" />
                      </div>
                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                        {["예정", "미납", "일부납", "완납", "이월"].map(st => {
                          const sc = scColor(st);
                          return <button key={st} onClick={() => setPSchedEditStatus(st)} style={{ padding: "3px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer", background: pSchedEditStatus === st ? sc.bg : "var(--bg)", color: pSchedEditStatus === st ? sc.t : "var(--tm)", border: `1px solid ${pSchedEditStatus === st ? sc.b : "var(--brd)"}` }}>{st}</button>;
                        })}
                      </div>
                      <KoreanInput value={pSchedEditMemo} onChange={e => setPSchedEditMemo(e.target.value)} style={{ ...inp, fontSize: 12 }} placeholder="메모 (선택)" />
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        <button onClick={() => setPSchedEditId(null)} style={{ padding: "4px 14px", borderRadius: 6, fontSize: 11, background: "var(--bg)", color: "var(--tm)", border: "1px solid var(--brd)", cursor: "pointer" }}>취소</button>
                        <button onClick={() => onSchedSave(s.id)} style={{ padding: "4px 14px", borderRadius: 6, fontSize: 11, fontWeight: 600, background: "var(--acc)", color: "#fff", border: "none", cursor: "pointer" }}>저장</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 10px" }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <span style={{ fontSize: 10, color: "var(--ts)", minWidth: 20 }}>#{i + 1}</span>
                        <span className="mono" style={{ fontSize: 12 }}>{s.dueDate ? fmtDate(s.dueDate) : (s.dueMonth ? s.dueMonth.slice(5) + "월 (미정)" : "날짜미정")}</span>
                        {s.memo && <span style={{ fontSize: 10, color: "var(--ts)", maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.memo}</span>}
                      </div>
                      <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                        <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{fmt(s.scheduledAmount)}</span>
                        <span style={{ padding: "1px 7px", borderRadius: 8, fontSize: 10, fontWeight: 600, background: c.bg, color: c.t, border: `1px solid ${c.b}` }}>{s.status}</span>
                        {canEdit && <>
                          <button onClick={() => onSchedStartEdit(s)} title="수정" style={{ width: 24, height: 24, borderRadius: 5, background: "var(--acc)12", border: "1px solid var(--acc)30", color: "var(--acc)", fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>✏</button>
                          <button onClick={() => onSchedDelete(s.id)} title="삭제" style={{ width: 24, height: 24, borderRadius: 5, background: "#ef444412", border: "1px solid #ef444430", color: "var(--err)", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
                        </>}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Overlay>
      );
    };

    const DayPopup = useStableComponent(({ date, onClose }) => {
      const scheds = schedsByDate[date] || [];
      const parts = date.split("-");
      const dow = ["일", "월", "화", "수", "목", "금", "토"][new Date(date + "T00:00:00").getDay()];
      const [cardMemos, setCardMemos] = useState({});
      const [savingMemoId, setSavingMemoId] = useState(null);
      const [patchingId, setPatchingId] = useState(null);
      const [editingId, setEditingId] = useState(null);
      const [editDate, setEditDate] = useState("");
      const [editAmount, setEditAmount] = useState("");

      const patchStatus = async (schedId, status) => {
        setPatchingId(schedId);
        await fetch(`/api/installments/schedules/${schedId}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status, userName: "관리자" }),
        });
        await reloadInstallments();
        setPatchingId(null);
      };

      const saveEdit = async (schedId) => {
        const body = {};
        if (editDate) { body.dueDate = editDate; body.dueMonth = editDate.slice(0, 7); }
        if (editAmount !== "") { body.scheduledAmount = parseInt(editAmount.replace(/,/g, ""), 10) || 0; }
        if (Object.keys(body).length === 0) { setEditingId(null); return; }
        await fetch(`/api/installments/schedules/${schedId}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        setEditingId(null);
        await reloadInstallments();
        showToast("수정 완료");
      };

      const parseAmountFromText = (text) => {
        if (!text) return null;
        const manMatches = [...text.matchAll(/(\d+(?:\.\d+)?)만\s*원?/g)];
        if (manMatches.length) return Math.round(parseFloat(manMatches[manMatches.length - 1][1]) * 10000);
        const wonMatches = [...text.matchAll(/([\d,]+)원/g)];
        if (wonMatches.length) return parseInt(wonMatches[wonMatches.length - 1][1].replace(/,/g, ""), 10) || null;
        return null;
      };

      const saveMemo = async (schedId) => {
        const text = (cardMemos[schedId] || "").trim();
        if (!text) return;
        setSavingMemoId(schedId);
        await fetch(`/api/installments/schedules/${schedId}/memo`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ memo: text, eventType: "메모", userName: "관리자" }),
        });
        setCardMemos(prev => ({ ...prev, [schedId]: "" }));
        // 메모에서 금액 자동 감지
        const detectedAmt = parseAmountFromText(text);
        const sched = scheds.find(x => x.id === schedId);
        if (detectedAmt && detectedAmt > 0 && sched && detectedAmt !== sched.scheduledAmount) {
          await fetch(`/api/installments/schedules/${schedId}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scheduledAmount: detectedAmt }),
          });
          setSavingMemoId(null);
          await reloadInstallments();
          showToast(`메모 금액 자동 적용: ${detectedAmt.toLocaleString("ko-KR")}원`);
        } else {
          setSavingMemoId(null);
          await reloadInstallments();
          showToast("특이사항 저장");
        }
      };

      return (
        <Overlay onClose={onClose}>
          <ModalHeader title={`${parseInt(parts[1])}월 ${parseInt(parts[2])}일 (${dow}) 납부 일정`} onClose={onClose} />
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {scheds.length === 0 && <div style={{ padding: 28, textAlign: "center", color: "var(--tm)", fontSize: 13 }}>이 날짜에 납부 일정이 없습니다</div>}
            {(() => {
              const unpaid = scheds.filter(s => s.status !== "완납");
              const paid   = scheds.filter(s => s.status === "완납");
              const mkDivider = (label, color, bg, brd) => (
                <div style={{ display:"flex", alignItems:"center", gap:8, margin:"4px 0 6px" }}>
                  <div style={{ flex:1, height:1, background:"var(--brd)" }} />
                  <span style={{ fontSize:11, fontWeight:700, color, whiteSpace:"nowrap", padding:"2px 10px", background:bg, borderRadius:10, border:"1px solid "+brd }}>{label}</span>
                  <div style={{ flex:1, height:1, background:"var(--brd)" }} />
                </div>
              );
              const renderCard = (s) => {
              const c = scColor(s.status);
              const isRolledOver = s.status === "이월";
              const shortfall = s.scheduledAmount > 0 && s.paidAmount > 0 && s.paidAmount < s.scheduledAmount ? s.scheduledAmount - s.paidAmount : 0;
              return (
                <div key={s.id} style={{ background: "var(--bg2)", borderRadius: 12, padding: "14px 16px", border: `1px solid ${c.b}` }}>
                  {/* 헤더 */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <BrandBadge code={s.brand} brands={config.brands} />
                      <button onClick={() => { const d = data.debtors.find(x => x.id === s.debtorId); if (d) { navigateToDebtor(d, "분할상환"); onClose(); } }}
                        style={{ fontWeight: 700, fontSize: 14, background: "none", border: "none", cursor: "pointer", color: "var(--acc)", padding: 0 }}>
                        {s.debtorName} ↗
                      </button>
                      {s.assignee && <span style={{ fontSize: 11, color: "var(--tm)" }}>{s.assignee}</span>}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {canEdit && editingId !== s.id && (
                        <button onClick={() => { setEditingId(s.id); setEditDate(s.dueDate || ""); setEditAmount(s.scheduledAmount ? String(s.scheduledAmount) : ""); }}
                          style={{ padding: "3px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer", border: "1px solid var(--acc)60", background: "var(--acc)12", color: "var(--acc)" }}>
                          ✏ 날짜/금액 수정
                        </button>
                      )}
                      <span style={{ padding: "2px 10px", borderRadius: 10, fontSize: 11, fontWeight: 600, background: c.bg, color: c.t, border: `1px solid ${c.b}` }}>{s.status || "예정"}</span>
                    </div>
                  </div>
                  {/* 금액 */}
                  <div style={{ fontSize: 13, marginBottom: 8, display: "flex", gap: 12, alignItems: "center" }}>
                    <span className="mono" style={{ fontWeight: 700, color: "var(--acc)" }}>{fmt(s.scheduledAmount)}</span>
                    {s.paidAmount > 0 && <span style={{ fontSize: 12, color: "#047857" }}>입금 {fmt(s.paidAmount)}</span>}
                    {shortfall > 0 && <span style={{ fontSize: 12, color: "#c2410c" }}>미납 {fmt(shortfall)}</span>}
                  </div>
                  {/* 날짜/금액 수정 폼 */}
                  {editingId === s.id && (
                    <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap", alignItems: "center", background: "var(--bg)", borderRadius: 8, padding: "10px 12px", border: "1px solid var(--brd)" }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 120 }}>
                        <span style={{ fontSize: 11, color: "var(--tm)" }}>날짜</span>
                        <input type="date" value={editDate} onChange={e => setEditDate(e.target.value)}
                          style={{ ...inp, border: "1px solid var(--brd)", borderRadius: 6, background: "var(--bg2)", color: "var(--tp)", fontSize: 12, padding: "5px 8px" }} />
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 120 }}>
                        <span style={{ fontSize: 11, color: "var(--tm)" }}>금액</span>
                        <MoneyInput value={editAmount} onChange={v => setEditAmount(v)}
                          placeholder="0"
                          style={{ ...inp, border: "1px solid var(--brd)", borderRadius: 6, background: "var(--bg2)", color: "var(--tp)", fontSize: 12, padding: "5px 8px" }} />
                      </div>
                      <div style={{ display: "flex", gap: 6, alignSelf: "flex-end" }}>
                        <button onClick={() => saveEdit(s.id)}
                          style={{ padding: "5px 14px", borderRadius: 6, background: "var(--acc)", color: "#fff", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
                          저장
                        </button>
                        <button onClick={() => setEditingId(null)}
                          style={{ padding: "5px 10px", borderRadius: 6, background: "none", color: "var(--tm)", border: "1px solid var(--brd)", cursor: "pointer", fontSize: 12 }}>
                          취소
                        </button>
                      </div>
                    </div>
                  )}
                  {/* 기존 메모 */}
                  {s.memo && (() => {
                    const memoAmt = parseAmountFromText(s.memo);
                    const amtMismatch = canEdit && memoAmt && memoAmt > 0 && memoAmt !== s.scheduledAmount;
                    return (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 12, color: "var(--tm)", background: "var(--bg)", borderRadius: 6, padding: "6px 10px", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{s.memo.slice(0, 120)}{s.memo.length > 120 ? "…" : ""}</div>
                        {amtMismatch && (
                          <button onClick={async () => {
                            await fetch(`/api/installments/schedules/${s.id}`, {
                              method: "PATCH", headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ scheduledAmount: memoAmt }),
                            });
                            await reloadInstallments();
                            showToast(`금액 적용: ${memoAmt.toLocaleString("ko-KR")}원`);
                          }} style={{ marginTop: 4, padding: "3px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer", background: "#fef3c7", color: "#b45309", border: "1px solid #fcd34d", display: "flex", alignItems: "center", gap: 4 }}>
                            ⚡ 메모 금액 적용 ({memoAmt.toLocaleString("ko-KR")}원)
                          </button>
                        )}
                      </div>
                    );
                  })()}
                  {/* 특이사항 입력 */}
                  {canEdit && (
                    <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                      <KoreanInput value={cardMemos[s.id] || ""} onChange={e => setCardMemos(p => ({ ...p, [s.id]: e.target.value }))}
                        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveMemo(s.id); } }}
                        placeholder="특이사항 메모 (Enter로 저장)…"
                        style={{ ...inp, flex: 1, border: "1px solid var(--brd)", borderRadius: 6, background: "var(--bg)", color: "var(--tp)", fontSize: 12, padding: "5px 8px" }} />
                      <button onClick={() => saveMemo(s.id)} disabled={savingMemoId === s.id}
                        style={{ padding: "5px 12px", borderRadius: 6, background: "var(--acc)", color: "#fff", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, opacity: savingMemoId === s.id ? 0.6 : 1 }}>
                        {savingMemoId === s.id ? "…" : "저장"}
                      </button>
                    </div>
                  )}
                  {/* 상태 버튼 */}
                  {canEdit && (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {!isRolledOver && (
                        <>
                          <button onClick={() => patchStatus(s.id, "완납")} disabled={patchingId === s.id}
                            style={{ padding: "5px 14px", borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: "pointer", border: "1px solid #10b98140", background: s.status === "완납" ? "#10b981" : "#10b98118", color: s.status === "완납" ? "#fff" : "#047857" }}>
                            완납
                          </button>
                          <button onClick={() => patchStatus(s.id, "일부납")} disabled={patchingId === s.id}
                            style={{ padding: "5px 12px", borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: "pointer", border: "1px solid #fb923c40", background: s.status === "일부납" ? "#fb923c" : "#fb923c18", color: s.status === "일부납" ? "#fff" : "#c2410c" }}>
                            일부납
                          </button>
                          <button onClick={() => patchStatus(s.id, "미납")} disabled={patchingId === s.id}
                            style={{ padding: "5px 12px", borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: "pointer", border: "1px solid #ef444440", background: s.status === "미납" ? "#ef4444" : "#ef444418", color: s.status === "미납" ? "#fff" : "#b91c1c" }}>
                            미납
                          </button>
                          <button onClick={() => { onClose(); setModal({ type: "rollover", sched: { ...s } }); }}
                            style={{ padding: "5px 12px", borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: "pointer", border: "1px solid #8b5cf640", background: "#8b5cf618", color: "#6d28d9" }}>
                            이월
                          </button>
                        </>
                      )}
                      {isRolledOver && <span style={{ fontSize: 12, color: "#6d28d9", padding: "5px 0" }}>이월 처리됨</span>}
                      <button onClick={() => deleteSchedule(s.id)}
                        style={{ padding: "5px 8px", borderRadius: 6, background: "none", color: "var(--tm)", border: "1px solid var(--brd)", fontSize: 12, cursor: "pointer", marginLeft: "auto" }}>
                        <I name="trash" size={12} />
                      </button>
                    </div>
                  )}
                </div>
              );
              };
              return (<>
                {unpaid.length > 0 && mkDivider("미납 · "+unpaid.length+"건", "#b91c1c", "#ef444414", "#ef444430")}
                {unpaid.map(s => renderCard(s))}
                {paid.length > 0 && mkDivider("완납 · "+paid.length+"건", "#047857", "#10b98114", "#10b98130")}
                {paid.map(s => renderCard(s))}
              </>);
            })()}
          </div>
        </Overlay>
      );
    });

    return (
      <div className="anim" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* 탭 바 */}
        <div style={{ display: "flex", gap: 2, background: "var(--card)", borderRadius: 10, padding: 4, border: "1px solid var(--brd)" }}>
          {[{ k: "이번달", l: "월간 달력" }, { k: "플랜관리", l: "플랜 관리" }].map(t => (
            <button key={t.k} onClick={() => setInstTab(t.k)} style={{ flex: 1, padding: "10px 0", borderRadius: 8, fontSize: 13, fontWeight: 600, background: instTab === t.k ? "var(--bg)" : "transparent", color: instTab === t.k ? "var(--tp)" : "var(--tm)", border: "none", cursor: "pointer" }}>{t.l}</button>
          ))}
        </div>

        {/* ── 월간 달력 탭 ── */}
        {instTab === "이번달" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {/* 컨트롤 헤더 */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <button onClick={() => setViewMonth(prevMonth(viewMonth))} style={{ width: 30, height: 30, borderRadius: 6, background: "var(--bg2)", color: "var(--tp)", border: "1px solid var(--brd)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><I name="back" size={14} /></button>
                <span style={{ fontWeight: 700, fontSize: 15, minWidth: 90, textAlign: "center" }}>{monthLabel(viewMonth)}</span>
                <button onClick={() => setViewMonth(nextMonth(viewMonth))} style={{ width: 30, height: 30, borderRadius: 6, background: "var(--bg2)", color: "var(--tp)", border: "1px solid var(--brd)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><I name="arrowDown" size={14} /></button>
                {viewMonth !== now.toISOString().slice(0, 7) && <button onClick={() => setViewMonth(now.toISOString().slice(0, 7))} style={{ padding: "3px 10px", borderRadius: 6, background: "var(--acc)", color: "#fff", fontSize: 11, fontWeight: 600, border: "none", cursor: "pointer" }}>오늘</button>}
              </div>
              <select value={stFilter} onChange={e => setStFilter(e.target.value)} style={{ ...inp, padding: "5px 8px", fontSize: 12 }}>
                {["전체", "예정", "미납", "일부납", "완납", "지연", "이월"].map(s => <option key={s}>{s}</option>)}
              </select>
              <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                {canEdit && <button onClick={() => setModal({ type: "addInstallment" })} style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 10px", borderRadius: 8, background: "var(--acc)", color: "#fff", fontSize: 12, fontWeight: 600, border: "none", cursor: "pointer" }}><I name="plus" size={13} />플랜 추가</button>}
                {canEdit && <button onClick={async () => { const r = await (await fetch("/api/installments/auto-sync", { method: "POST" })).json(); showToast(`입금 동기화: ${r.updated}건 업데이트`); await reloadInstallments(); }} style={{ padding: "6px 10px", borderRadius: 8, background: "#10b98118", color: "#047857", border: "1px solid #10b98140", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>입금동기화</button>}
              </div>
            </div>

            {/* KPI 요약 */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[{ l: "전체", v: monthStats.total, c: "var(--acc)" }, { l: "완납", v: monthStats.done, c: "#047857" }, { l: "일부납", v: monthStats.partial, c: "#c2410c" }, { l: "미납", v: monthStats.unpaid, c: "#b91c1c" }, { l: "예정", v: monthStats.scheduled, c: "#1d4ed8" }, { l: "지연", v: monthStats.overdue, c: "#b45309" }].map(x => (
                <div key={x.l} style={{ padding: "6px 14px", background: "var(--card)", borderRadius: 8, border: "1px solid var(--brd)", textAlign: "center" }}>
                  <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: x.c }}>{x.v}</div>
                  <div style={{ fontSize: 10, color: "var(--tm)" }}>{x.l}</div>
                </div>
              ))}
              <div style={{ padding: "6px 14px", background: "var(--card)", borderRadius: 8, border: "1px solid var(--brd)", display: "flex", flexDirection: "column", justifyContent: "center", gap: 2 }}>
                <div style={{ fontSize: 11 }}><span style={{ color: "var(--tm)" }}>예정: </span><b className="mono">{fmt(monthStats.totalAmt)}</b></div>
                <div style={{ fontSize: 11 }}><span style={{ color: "var(--tm)" }}>완납: </span><b className="mono" style={{ color: "#047857" }}>{fmt(monthStats.doneAmt)}</b></div>
              </div>
            </div>

            {/* 달력 + 카드 분할 */}
            <div style={{ display: "flex", gap: 12 }}>
              {/* 왼쪽: 달력 (고정) */}
              <div style={{ flex: "0 0 55%", background: "var(--card)", borderRadius: 12, border: "1px solid var(--brd)", overflow: "hidden" }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", background: "var(--bg2)", borderBottom: "1px solid var(--brd)" }}>
                  {["일", "월", "화", "수", "목", "금", "토"].map((d, i) => (
                    <div key={d} style={{ padding: "7px 0", textAlign: "center", fontSize: 11, fontWeight: 700, color: i === 0 ? "#ef4444" : i === 6 ? "#3b82f6" : "var(--tm)" }}>{d}</div>
                  ))}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)" }}>
                  {calCells.map((day, idx) => {
                    if (!day) return (
                      <div key={`e${idx}`} style={{ minHeight: 82, borderRight: idx % 7 !== 6 ? "1px solid var(--brd)" : "none", borderBottom: "1px solid var(--brd)", background: "var(--bg2)", opacity: 0.4 }} />
                    );
                    const ds = cellDate(day);
                    const dayScheds = schedsByDate[ds] || [];
                    const isToday = ds === todayStr;
                    const hasOverdue = dayScheds.some(s => s.status === "지연");
                    const allDone = dayScheds.length > 0 && dayScheds.every(s => s.status === "완납");
                    const col = idx % 7;
                    const isDragOver = dragOverDate === ds && dragSchedId;
                    return (
                      <div key={ds}
                        onClick={() => { if (dayScheds.length > 0 && !dragSchedId) setDayPopup(ds); }}
                        onDragOver={e => { e.preventDefault(); setDragOverDate(ds); }}
                        onDragLeave={() => setDragOverDate(null)}
                        onDrop={e => { e.preventDefault(); dropOnDate(ds); }}
                        style={{
                          minHeight: 82, padding: "4px 3px 3px",
                          borderRight: col !== 6 ? "1px solid var(--brd)" : "none",
                          borderBottom: "1px solid var(--brd)",
                          background: isDragOver ? "var(--acc)18" : hasOverdue ? "#f59e0b06" : allDone ? "#10b98106" : "transparent",
                          cursor: dragSchedId ? "copy" : dayScheds.length > 0 ? "pointer" : "default",
                          outline: isDragOver ? "2px solid var(--acc)" : "none",
                          outlineOffset: -2,
                          transition: "background 0.1s",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                          <div style={{
                            width: 22, height: 22, borderRadius: "50%",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontSize: 11, fontWeight: isToday ? 700 : 500,
                            background: isToday ? "var(--acc)" : "transparent",
                            color: isToday ? "#fff" : col === 0 ? "#ef4444" : col === 6 ? "#3b82f6" : "var(--tp)",
                          }}>{day}</div>
                          {canEdit && (
                            <button
                              onClick={e => { e.stopPropagation(); setAddSchedModal({ date: ds }); }}
                              style={{ width: 16, height: 16, borderRadius: 4, background: "var(--acc)22", color: "var(--acc)", border: "none", cursor: "pointer", fontSize: 13, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, fontWeight: 700 }}>+</button>
                          )}
                        </div>
                        {dayScheds.map((s) => {
                          const c = scColor(s.status);
                          return (
                            <div key={s.id}
                              draggable={canEdit}
                              onDragStart={e => { e.stopPropagation(); setDragSchedId(s.id); e.dataTransfer.effectAllowed = "move"; }}
                              onDragEnd={() => { setDragSchedId(null); setDragOverDate(null); }}
                              onClick={e => { e.stopPropagation(); setDayPopup(ds); }}
                              style={{
                                fontSize: 9, lineHeight: "14px", padding: "0 4px",
                                borderRadius: 3, marginBottom: 2,
                                background: c.bg, color: c.t, border: `1px solid ${c.b}`,
                                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                display: "flex", justifyContent: "space-between", gap: 2,
                                cursor: canEdit ? "grab" : "pointer",
                                opacity: dragSchedId === s.id ? 0.4 : 1,
                              }}>
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{s.debtorName}</span>
                              <span style={{ flexShrink: 0, opacity: 0.8 }}>{(s.scheduledAmount / 10000).toFixed(0)}만</span>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
                {undatedScheds.length > 0 && (
                  <div style={{ padding: "8px 10px", borderTop: "1px solid var(--brd)", background: "#f59e0b08" }}>
                    <div style={{ fontSize: 10, color: "#b45309", fontWeight: 600, marginBottom: 4 }}>날짜 미정 {undatedScheds.length}건</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                      {undatedScheds.map(s => (
                        <span key={s.id} style={{ fontSize: 9, padding: "1px 6px", borderRadius: 4, background: "#f59e0b18", color: "#b45309", border: "1px solid #f59e0b30" }}>{s.debtorName}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* 오른쪽: 검색 + 스크롤 카드 */}
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
                <KoreanInput value={cardSearch} onChange={e => setCardSearch(e.target.value)} placeholder="이름 검색…" style={{ ...inp, padding: "5px 9px", fontSize: 12, border: "1px solid var(--brd)", borderRadius: 7, background: "var(--bg)", color: "var(--tp)", flexShrink: 0 }} />
                <div style={{ overflowY: "auto", height: calPanelH - 38, display: "flex", flexDirection: "column", gap: 6, paddingRight: 2 }}>
                  {datedScheds.length === 0 && undatedScheds.length === 0 && (
                    <div style={{ padding: 40, textAlign: "center", color: "var(--tm)", background: "var(--card)", borderRadius: 12, border: "1px solid var(--brd)", fontSize: 13 }}>{cardSearch ? "검색 결과 없음" : "이번달 예정 없음"}</div>
                  )}
                  {datedScheds.map(s => {
                    const c = scColor(s.status);
                    return (
                      <div key={s.id}
                        draggable={canEdit}
                        onDragStart={e => { setDragSchedId(s.id); e.dataTransfer.effectAllowed = "move"; }}
                        onDragEnd={() => { setDragSchedId(null); setDragOverDate(null); }}
                        onClick={() => s.dueDate && setDayPopup(s.dueDate)}
                        style={{
                          background: s.status === "완납" ? "#10b98108" : s.status === "지연" ? "#f59e0b08" : "var(--card)",
                          borderRadius: 10, border: `1px solid ${c.b}`, padding: "10px 12px", flexShrink: 0,
                          cursor: canEdit ? "grab" : "pointer",
                          opacity: dragSchedId === s.id ? 0.4 : 1,
                        }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 5 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <BrandBadge code={s.brand} brands={config.brands} />
                            <span style={{ fontWeight: 700, fontSize: 13, color: "var(--tp)" }}>{s.debtorName}</span>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                            <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, background: c.bg, color: c.t, border: `1px solid ${c.b}` }}>{s.status}</span>
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 10, fontSize: 11, color: "var(--ts)", flexWrap: "wrap" }}>
                          <span className="mono">{fmtDate(s.dueDate)}</span>
                          <span className="mono" style={{ fontWeight: 700, color: "var(--tp)" }}>{fmt(s.scheduledAmount)}</span>
                          {s.debtSource && <span>{s.debtSource}</span>}
                          {s.institution && <span style={{ color: "var(--tm)" }}>{s.institution}</span>}
                          {s.assignee && <span style={{ marginLeft: "auto", color: "var(--tm)" }}>{s.assignee}</span>}
                          {canEdit && <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--tm)", opacity: 0.6 }}>⠿ 드래그</span>}
                        </div>
                      </div>
                    );
                  })}
                  {undatedScheds.length > 0 && (
                    <div style={{ flexShrink: 0 }}>
                      <div style={{ borderTop: "2px dashed var(--brd)", margin: "4px 0 8px", opacity: 0.5 }} />
                      <div style={{ fontSize: 11, color: "#b45309", fontWeight: 600, marginBottom: 6 }}>날짜 미정 {undatedScheds.length}건</div>
                      {undatedScheds.map(s => {
                      const c = scColor(s.status);
                      const isEditingDate = editDateId === s.id;
                      return (
                        <div key={s.id}
                          draggable={canEdit}
                          onDragStart={e => { setDragSchedId(s.id); e.dataTransfer.effectAllowed = "move"; }}
                          onDragEnd={() => { setDragSchedId(null); setDragOverDate(null); }}
                          style={{ background: "var(--card)", borderRadius: 10, border: "1px dashed #f59e0b60", padding: "10px 12px", marginBottom: 6, cursor: canEdit ? "grab" : "default", opacity: dragSchedId === s.id ? 0.4 : 1 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <BrandBadge code={s.brand} brands={config.brands} />
                              <span style={{ fontWeight: 700, fontSize: 13, color: "var(--tp)" }}>{s.debtorName}</span>
                              {canEdit && <span style={{ fontSize: 10, color: "var(--tm)", opacity: 0.6 }}>⠿ 달력에 드래그</span>}
                            </div>
                            <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, background: c.bg, color: c.t, border: `1px solid ${c.b}` }}>{s.status}</span>
                          </div>
                          <div style={{ display: "flex", gap: 10, fontSize: 11, color: "var(--ts)", marginBottom: 7 }}>
                            <span className="mono" style={{ color: "#f59e0b" }}>{s.dueMonth} (미정)</span>
                            <span className="mono" style={{ fontWeight: 700, color: "var(--tp)" }}>{fmt(s.scheduledAmount)}</span>
                          </div>
                          {canEdit && (
                            <div style={{ display: "flex", gap: 4 }}>
                              {isEditingDate ? (
                                <>
                                  <input type="date" value={editDateVal} onChange={e => setEditDateVal(e.target.value)} style={{ ...inp, padding: "3px 6px", fontSize: 11, width: 120 }} />
                                  <button onClick={() => saveDate(s.id)} style={{ padding: "2px 8px", background: "var(--acc)", color: "#fff", borderRadius: 5, fontSize: 11, border: "none", cursor: "pointer" }}>확인</button>
                                  <button onClick={() => setEditDateId(null)} style={{ padding: "2px 6px", background: "var(--bg2)", color: "var(--tm)", borderRadius: 5, fontSize: 11, border: "1px solid var(--brd)", cursor: "pointer" }}>취소</button>
                                </>
                              ) : (
                                <>
                                  {s.status !== "완납" && <button onClick={() => { setEditDateId(s.id); setEditDateVal(""); }} style={{ padding: "3px 10px", borderRadius: 6, background: "#3b82f618", color: "#3b82f6", border: "1px solid #3b82f640", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>날짜지정</button>}
                                  {s.status !== "완납" && <button onClick={() => markComplete(s.id)} style={{ padding: "3px 10px", borderRadius: 6, background: "#10b98118", color: "#047857", border: "1px solid #10b98130", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>완납</button>}
                                  {s.status === "완납" && <button onClick={() => markUnpaid(s.id)} style={{ padding: "3px 10px", borderRadius: 6, background: "#ef444418", color: "var(--err)", border: "1px solid #ef444430", fontSize: 11, cursor: "pointer" }}>완납취소</button>}
                                  <button onClick={() => deleteSchedule(s.id)} style={{ padding: "3px 7px", borderRadius: 6, background: "none", color: "var(--tm)", border: "1px solid var(--brd)", fontSize: 11, cursor: "pointer" }}><I name="trash" size={11} /></button>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  )}
              </div>
            </div>
          </div>
        </div>
      )}

        {/* ── 플랜 관리 탭 ── */}
        <div style={{ display: instTab === "플랜관리" ? "flex" : "none", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {isAdmin && <button onClick={doImport} disabled={importing} style={{ display: "flex", alignItems: "center", gap: 4, padding: "7px 12px", borderRadius: 8, background: importing ? "var(--bg2)" : "#f59e0b18", color: importing ? "var(--tm)" : "#b45309", fontSize: 12, fontWeight: 600, border: "1px solid #f59e0b40", cursor: importing ? "not-allowed" : "pointer" }}><I name="upload" size={14} />{importing ? "이관중…" : "엑셀 이관"}</button>}
              <button onClick={() => exportInstallments(data.installmentPlans)} style={{ display: "flex", alignItems: "center", gap: 4, padding: "7px 12px", borderRadius: 8, background: "#10b98118", color: "#10b981", fontSize: 12, fontWeight: 600, border: "1px solid #10b98140", cursor: "pointer" }}><I name="arrowDown" size={14} />CSV</button>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <KoreanInput value={planSearch} onChange={e => setPlanSearch(e.target.value)} placeholder="채무자명 검색…" style={{ ...inp, padding: "6px 10px", fontSize: 12, border: "1px solid var(--brd)", borderRadius: 7, background: "var(--bg)", color: "var(--tp)", width: 180 }} />
              <span style={{ fontSize: 12, color: "var(--tm)", whiteSpace: "nowrap" }}>플랜 {data.installmentPlans.length}건</span>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {data.installmentPlans.length === 0 && <div style={{ padding: 40, textAlign: "center", color: "var(--tm)", background: "var(--card)", borderRadius: 12, border: "1px solid var(--brd)" }}>플랜 없음 — 월간 달력에서 <b>+ 플랜 추가</b> 버튼으로 시작하세요</div>}
            {data.installmentPlans.filter(plan => !planSearch || (plan.debtorName || "").toLowerCase().includes(planSearch.toLowerCase())).map(plan => {
              const d = data.debtors.find(x => x.id === plan.debtorId);
              const scheds = plan.schedules || [];
              const done = scheds.filter(s => s.status === "완납").length;
              const overdue = scheds.filter(s => s.status === "지연").length;
              return (
                <div key={plan.id} style={{ background: "var(--card)", borderRadius: 10, border: overdue > 0 ? "1px solid #f59e0b80" : "1px solid var(--brd)", overflow: "hidden" }}>
                  <div style={{ padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}
                    onClick={() => setPlanPopup(plan)}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <BrandBadge code={plan.brand} brands={config.brands} />
                      <span style={{ fontWeight: 600 }}>{plan.debtorName}</span>
                      {plan.startDate && <span style={{ fontSize: 11, color: "var(--tm)" }}>{plan.startDate.slice(0, 7)} 시작</span>}
                      <span style={{ fontSize: 11, color: "var(--ts)" }}>{plan.hubName}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 11, color: "var(--tm)" }}>
                        총 {scheds.length}건 / 완납 <span style={{ color: "#047857", fontWeight: 600 }}>{done}</span> / 지연 <span style={{ color: "#b45309", fontWeight: 600 }}>{overdue}</span>
                      </span>
                      <span style={{ fontSize: 12, color: "var(--ts)" }}>총채권: <b className="mono">{fmt(plan.totalClaim || (d?.finalBalanceLegal ?? 0))}</b></span>
                      {canEdit && <button onClick={async (e) => { e.stopPropagation(); if (!confirm(`${plan.debtorName} 플랜 및 모든 일정을 삭제하시겠습니까?`)) return; await fetch(`/api/installments/${plan.id}`, { method: "DELETE" }); await reloadInstallments(); showToast("삭제 완료"); }} style={{ padding: "3px 6px", borderRadius: 6, background: "#ef444418", color: "var(--err)", border: "none", cursor: "pointer" }}><I name="trash" size={12} /></button>}
                    </div>
                  </div>
                  {overdue > 0 && <div style={{ padding: "4px 14px", background: "#f59e0b10", fontSize: 11, color: "#b45309", fontWeight: 600 }}>⚠ 지연 {overdue}건</div>}
                  <div style={{ padding: "6px 14px 10px", display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {scheds.slice(0, 18).map((s, i) => {
                      const c = scColor(s.status);
                      return <span key={i} style={{ padding: "2px 7px", borderRadius: 4, fontSize: 10, background: c.bg, color: c.t, border: `1px solid ${c.b}` }}>{s.dueDate ? s.dueDate.slice(5) : (s.dueMonth ? s.dueMonth.slice(5) + "(미정)" : "?")}</span>;
                    })}
                    {scheds.length > 18 && <span style={{ fontSize: 10, color: "var(--tm)" }}>+{scheds.length - 18}건</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {planPopup && PlanDetailPopup()}
        {addSchedModal && <AddSchedModal />}
        {dayPopup && <DayPopup date={dayPopup} onClose={() => setDayPopup(null)} />}
      </div>
    );
  });

  // ─── Debtor Locations View (채무자 위치 지도) ─────────────
  const DebtorLocationsView = useStableComponent(() => {
    const [mapAppKey, setMapAppKey] = useState(undefined); // undefined=조회중, null=키없음, string=사용가능
    const [locations, setLocations] = useState(null); // null=로딩중
    const [mapReady, setMapReady] = useState(false);
    const [searchQ, setSearchQ] = useState("");
    const [geocoding, setGeocoding] = useState(false);
    const [geocodeProgress, setGeocodeProgress] = useState(null);
    const [refreshingAddr, setRefreshingAddr] = useState(false);
    const [refreshAddrProgress, setRefreshAddrProgress] = useState(null);
    const mapElRef = useRef(null);
    const mapObjRef = useRef(null);
    const overlaysRef = useRef([]);

    const loadLocations = () => {
      fetch("/api/debtors/locations").then(r => r.json()).then(d => setLocations(d.ok ? d.debtors : [])).catch(() => setLocations([]));
    };
    useEffect(() => {
      fetch("/api/config/kakao-map").then(r => r.json()).then(d => setMapAppKey(d.appKey || null)).catch(() => setMapAppKey(null));
      loadLocations();
    }, []);

    // 카카오맵 JS SDK 동적 로드 (JavaScript 키는 비밀값 아님 — URL에 그대로 노출돼도 안전)
    useEffect(() => {
      if (!mapAppKey) return;
      if (window.kakao && window.kakao.maps) { setMapReady(true); return; }
      const existing = document.getElementById("kakao-maps-sdk");
      if (existing) { existing.addEventListener("load", () => window.kakao.maps.load(() => setMapReady(true))); return; }
      const script = document.createElement("script");
      script.id = "kakao-maps-sdk";
      script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${mapAppKey}&autoload=false`;
      script.onload = () => window.kakao.maps.load(() => setMapReady(true));
      document.head.appendChild(script);
    }, [mapAppKey]);

    // 지도 초기화 (1회)
    useEffect(() => {
      if (!mapReady || !mapElRef.current || mapObjRef.current) return;
      mapObjRef.current = new window.kakao.maps.Map(mapElRef.current, {
        center: new window.kakao.maps.LatLng(36.5, 127.8), // 대한민국 중앙 부근 기본값
        level: 13,
      });
    }, [mapReady]);

    // 마커(커스텀 오버레이) 렌더링
    useEffect(() => {
      if (!mapObjRef.current || !locations) return;
      overlaysRef.current.forEach(o => o.setMap(null));
      overlaysRef.current = [];
      const withCoords = locations.filter(d => d.lat != null && d.lng != null);
      withCoords.forEach(d => {
        const color = config.brands.find(b => b.code === d.brand)?.color || "#64748b";
        const el = document.createElement("div");
        el.style.cssText = `padding:3px 8px;border-radius:6px;background:${color};color:#fff;font-size:11px;font-weight:700;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.35);cursor:pointer;`;
        el.textContent = `${d.brand} ${d.name} (${d.addressSource === "resident" ? "초" : "신"})`;
        el.addEventListener("click", () => {
          const debtor = data.debtors.find(x => x.id === d.id);
          if (debtor) navigateToDebtor(debtor);
        });
        const overlay = new window.kakao.maps.CustomOverlay({
          position: new window.kakao.maps.LatLng(d.lat, d.lng),
          content: el,
          yAnchor: 1,
        });
        overlay.setMap(mapObjRef.current);
        overlaysRef.current.push(overlay);
      });
    }, [locations, mapReady]);

    const noCoords = (locations || []).filter(d => d.lat == null || d.lng == null);
    const withCoordsCount = (locations || []).length - noCoords.length;

    const runBulkGeocode = async () => {
      if (geocoding || noCoords.length === 0) return;
      setGeocoding(true);
      setGeocodeProgress({ done: 0, total: noCoords.length });
      for (let i = 0; i < noCoords.length; i++) {
        try { await fetch(`/api/debtor/${noCoords[i].id}/geocode`, { method: "POST" }); } catch {}
        setGeocodeProgress({ done: i + 1, total: noCoords.length });
      }
      setGeocoding(false);
      loadLocations();
    };

    // 좌표 변환에 계속 실패하는 항목은 대부분 예전(수정 전) OCR 로직이 잘못 저장해둔
    // 주소 캐시가 원인이다 — 하나씩 상세화면에서 "재조회" 누르는 대신 여기서 한 번에 처리한다.
    const runBulkAddressRefresh = async () => {
      if (refreshingAddr || noCoords.length === 0) return;
      setRefreshingAddr(true);
      setRefreshAddrProgress({ done: 0, total: noCoords.length });
      for (let i = 0; i < noCoords.length; i++) {
        const item = noCoords[i];
        const endpoint = item.addressSource === "resident"
          ? `/api/debtor/${item.id}/resident-number/refresh`
          : `/api/debtor/${item.id}/credit-address/refresh`;
        try { await fetch(endpoint, { method: "POST" }); } catch {}
        setRefreshAddrProgress({ done: i + 1, total: noCoords.length });
      }
      setRefreshingAddr(false);
      loadLocations();
      showToast("주소 재조회 완료 — '주소→좌표 변환'을 다시 눌러주세요");
    };

    const panTo = (d) => {
      if (!mapObjRef.current || d.lat == null) return;
      mapObjRef.current.setCenter(new window.kakao.maps.LatLng(d.lat, d.lng));
      mapObjRef.current.setLevel(3);
    };

    const q = searchQ.trim().toLowerCase();
    // 좌표가 정상적으로 확보된(지도에 이미 잘 표시되는) 채무자는 목록에서 빼고, 아직
    // 손봐야 할(좌표 없는) 채무자만 보여준다 — 검색어가 있으면 검색 결과는 예외로 전체에서 찾는다.
    const searched = (locations || []).filter(d => (q || d.lat == null) && (!q || d.name.toLowerCase().includes(q) || (d.brandName || "").toLowerCase().includes(q)));

    return (
      <div className="anim" style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <div style={{ background: "var(--card)", borderRadius: 10, padding: "10px 16px", border: "1px solid var(--brd)", fontSize: 12, color: "var(--tm)" }}>
            주소 확보 <b style={{ color: "var(--tp)" }}>{(locations || []).length}</b>건 · 좌표 확보 <b style={{ color: "var(--tp)" }}>{withCoordsCount}</b>건
          </div>
          {mapAppKey && noCoords.length > 0 && (
            <button onClick={runBulkGeocode} disabled={geocoding}
              style={{ padding: "8px 14px", borderRadius: 8, background: geocoding ? "var(--bg2)" : "var(--acc)", color: geocoding ? "var(--tm)" : "#fff", fontSize: 12, fontWeight: 600, border: "none", cursor: geocoding ? "default" : "pointer" }}>
              {geocoding ? `좌표 변환 중... (${geocodeProgress?.done || 0}/${geocodeProgress?.total || 0})` : `주소→좌표 변환 (${noCoords.length}건 남음)`}
            </button>
          )}
          {canEdit && noCoords.length > 0 && (
            <button onClick={runBulkAddressRefresh} disabled={refreshingAddr}
              title="좌표 변환에 계속 실패하는 항목은 예전에 잘못 저장된 주소 캐시가 원인인 경우가 많습니다 — 눌러서 다시 추출합니다"
              style={{ padding: "8px 14px", borderRadius: 8, background: refreshingAddr ? "var(--bg2)" : "#8b5cf618", color: refreshingAddr ? "var(--tm)" : "#6d28d9", fontSize: 12, fontWeight: 600, border: refreshingAddr ? "none" : "1px solid #8b5cf640", cursor: refreshingAddr ? "default" : "pointer" }}>
              {refreshingAddr ? `주소 재조회 중... (${refreshAddrProgress?.done || 0}/${refreshAddrProgress?.total || 0})` : `주소 재조회 (${noCoords.length}건)`}
            </button>
          )}
          <span style={{ flex: 1 }} />
          <div style={{ position: "relative", width: 260 }}>
            <div style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--tm)" }}><I name="search" size={14} /></div>
            <KoreanInput value={searchQ} onChange={e => setSearchQ(e.target.value)} placeholder="채무자명·브랜드 검색"
              style={{ width: "100%", padding: "7px 10px 7px 30px", borderRadius: 8, fontSize: 13, border: "1px solid var(--brd)", background: "var(--card)", color: "var(--tp)" }} />
          </div>
        </div>

        {mapAppKey === null && (
          <div style={{ padding: "12px 16px", borderRadius: 10, background: "#f59e0b18", border: "1px solid #f59e0b40", color: "#b45309", fontSize: 12 }}>
            카카오맵 API 키가 설정되지 않았습니다. <code>backend/.env</code>에 <code>KAKAO_MAP_APP_KEY</code>/<code>KAKAO_REST_API_KEY</code>를 추가한 뒤 서버를 재시작해주세요.
          </div>
        )}

        <div style={{ display: "flex", gap: 12, flex: 1, minHeight: 520 }}>
          <div style={{ width: 280, flexShrink: 0, display: "flex", flexDirection: "column", gap: 6, overflowY: "auto", background: "var(--card)", borderRadius: 12, border: "1px solid var(--brd)", padding: 10 }}>
            {locations === null
              ? <div style={{ padding: 16, textAlign: "center", color: "var(--tm)", fontSize: 12 }}>불러오는 중...</div>
              : searched.length === 0
                ? <div style={{ padding: 16, textAlign: "center", color: "var(--tm)", fontSize: 12 }}>{q ? "검색 결과 없음" : "주소가 확보된 채무자가 없습니다.\n채무자 상세 페이지에서 CB보기로 주소를 자동추출해보세요."}</div>
                : searched.map(d => (
                    <div key={d.id} onClick={() => panTo(d)}
                      style={{ padding: "8px 10px", borderRadius: 8, background: "var(--bg)", border: "1px solid var(--brd)", cursor: d.lat != null ? "pointer" : "default", opacity: d.lat != null ? 1 : 0.55 }}
                      onMouseEnter={e => { if (d.lat != null) e.currentTarget.style.background = "var(--hover)"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "var(--bg)"; }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <BrandBadge code={d.brand} brands={config.brands} />
                        <span style={{ fontSize: 12, fontWeight: 700 }}>{d.name}</span>
                        {d.lat == null && <span style={{ fontSize: 9, color: "var(--warn)", marginLeft: "auto" }}>좌표 없음</span>}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--ts)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.latestAddress}</div>
                    </div>
                  ))
            }
          </div>
          <div ref={mapElRef} style={{ flex: 1, borderRadius: 12, border: "1px solid var(--brd)", minHeight: 520, background: "var(--bg2)" }} />
        </div>
      </div>
    );
  });

  // ─── Legal View ─────────────────────────────────────────
  const LegalView = useStableComponent(() => {
    const [brandF,            setBrandF]            = useState("전체");
    const [searchQ,           setSearchQ]           = useState("");
    useEffect(() => { if (legalSearchInit) { setSearchQ(legalSearchInit); setLegalSearchInit(null); } }, [legalSearchInit]);
    const [selCase,           setSelCase]            = useState(null);
    const [caseNotes,         setCaseNotes]          = useState([]);   // 진행상황 메모
    const [noteDraft,         setNoteDraft]          = useState("");
    useEffect(() => { setCaseNotes(selCase ? getCaseNotes(selCase.id) : []); setNoteDraft(""); }, [selCase?.id]);
    const [matchingCase,      setMatchingCase]       = useState(null);
    const [matchQ,            setMatchQ]             = useState("");
    const [selComplaint,      setSelComplaint]       = useState(null);  // 형사고소 팝업
    const [cmpMatchQ,         setCmpMatchQ]          = useState("");
    const [cmpMatchMode,      setCmpMatchMode]       = useState(false); // 재매칭 패널 열림
    const [cmpEdit,           setCmpEdit]            = useState({});    // 팝업 편집 중 값
    const [cmpHistory,        setCmpHistory]         = useState([]);    // 진행 히스토리
    const [cmpHistForm,       setCmpHistForm]        = useState(null);  // 추가/수정 폼
    const [statusSort,        setStatusSort]         = useState(null);  // null | "asc" | "desc"
    const toggleSort = () => setStatusSort(s => s === null ? "asc" : s === "asc" ? "desc" : null);

    const lc  = data.legalCases       || [];
    const ad  = data.assetDisclosures  || [];
    const cmp = data.complaints        || [];

    const payOrders = lc.filter(c => c.type === "지급명령");
    const seizures  = lc.filter(c => c.type === "압류");

    const applyFilter = (arr, nameKey = "defendant") => {
      let r = arr;
      if (brandF !== "전체") r = r.filter(c => c.brand === brandF);
      if (searchQ) {
        const q = searchQ.toLowerCase();
        r = r.filter(c =>
          (c[nameKey] || "").toLowerCase().includes(q) ||
          (c.caseNumber || "").toLowerCase().includes(q) ||
          (c.court || "").toLowerCase().includes(q) ||
          (c.charge || "").toLowerCase().includes(q) ||
          (c.policeStation || "").toLowerCase().includes(q)
        );
      }
      return r;
    };

    const filteredPO  = applyFilter(payOrders);
    const filteredSz  = applyFilter(seizures);
    const filteredAD  = applyFilter(ad, "debtorName");
    const filteredCmp = applyFilter(cmp, "debtorName");

    const sortByStatus = (arr, getStatus) => {
      if (!statusSort) return arr;
      return [...arr].sort((a, b) => {
        const sa = getStatus(a) || ""; const sb = getStatus(b) || "";
        return statusSort === "asc" ? sa.localeCompare(sb, "ko") : sb.localeCompare(sa, "ko");
      });
    };
    const sortedPO  = sortByStatus(filteredPO,  c => c.progressStatus || "");
    const sortedSz  = sortByStatus(filteredSz,  c => c.progressStatus || "");
    const sortedAD  = sortByStatus(filteredAD,  c => c.status || "진행");
    const sortedCmp = sortByStatus(filteredCmp, c => c.status || "준비중");

    // 지급명령/압류/재산명시·재산조회/형사고소를 한 화면에서 함께 검색·조회할 수 있도록 통합
    // (유형 드롭다운이 "전체"가 아니면 해당 유형만 남긴다)
    const KIND_COLOR = { "지급명령": "#3b82f6", "압류": "#8b5cf6", "재산명시·재산조회": "#f59e0b", "형사고소": "#ef4444" };
    const allItems = [
      ...sortedPO.map(c => ({ c, kind: "지급명령" })),
      ...sortedSz.map(c => ({ c, kind: "압류" })),
      ...sortedAD.map(c => ({ c, kind: "재산명시·재산조회" })),
      ...sortedCmp.map(c => ({ c, kind: "형사고소" })),
    ].filter(({ kind }) => legalTypeFilter === "전체" || legalTypeFilter === kind);

    // 연동 채무자 찾기
    const getDebtor = (id) => data.debtors.find(d => d.id === id);

    // 수동 매칭 후보 목록
    const matchCandidates = useMemo(() => {
      if (!matchingCase) return [];
      const q = matchQ.toLowerCase().trim();
      return (q
        ? data.debtors.filter(d => d.name.toLowerCase().includes(q) || (d.phone || "").includes(q) || (d.hubName || "").includes(q))
        : data.debtors
      ).slice(0, 30);
    }, [matchQ, matchingCase, data.debtors]);

    // ─── 형사고소 팝업 ─────────────────────────────────────
    const cmpMatchCandidates = useMemo(() => {
      if (!cmpMatchMode) return [];
      const q = cmpMatchQ.toLowerCase().trim();
      return (q
        ? data.debtors.filter(d => d.name.toLowerCase().includes(q) || (d.hubName || "").includes(q))
        : data.debtors
      ).slice(0, 30);
    }, [cmpMatchQ, cmpMatchMode, data.debtors]);

    const openComplaint = (c) => {
      setSelComplaint(c);
      setCmpEdit({ status: c.status || "수사중", complaintUrl: c.complaintUrl || "", investigator: c.investigator || "", investigatorContact: c.investigatorContact || "", policeStation: c.policeStation || "", charge: c.charge || "" });
      setCmpMatchMode(false); setCmpMatchQ("");
      setCmpHistory([]); setCmpHistForm(null);
      fetch(`/api/complaints/${c.id}/history`).then(r => r.ok ? r.json() : []).then(setCmpHistory).catch(() => {});
    };

    const saveComplaintEdit = async () => {
      if (!selComplaint) return;
      try {
        await fetch(`/api/complaints/${selComplaint.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cmpEdit),
        });
        updateMR(MK.complaints, selComplaint.id, cmpEdit);
        setData(prev => ({ ...prev, complaints: prev.complaints.map(c => c.id === selComplaint.id ? { ...c, ...cmpEdit } : c) }));
        setSelComplaint(prev => ({ ...prev, ...cmpEdit }));
        showToast("저장 완료");
      } catch { showToast("저장 실패"); }
    };

    const saveCmpHist = async () => {
      if (!cmpHistForm || !selComplaint) return;
      const { id, date, content, assignee, mode } = cmpHistForm;
      if (!date || !content.trim()) { showToast("날짜와 내용을 입력하세요"); return; }
      try {
        if (mode === "add") {
          const r = await fetch(`/api/complaints/${selComplaint.id}/history`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ date, content, assignee }),
          }).then(r => r.json());
          setCmpHistory(prev => [{ id: r.id, complaint_id: selComplaint.id, date, content, assignee }, ...prev]);
        } else {
          await fetch(`/api/complaint-history/${id}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ date, content, assignee }),
          });
          setCmpHistory(prev => prev.map(h => h.id === id ? { ...h, date, content, assignee } : h));
        }
        setCmpHistForm(null);
      } catch { showToast("저장 실패"); }
    };

    const deleteCmpHist = async (h) => {
      if (!confirm("이 항목을 삭제하시겠습니까?")) return;
      try {
        await fetch(`/api/complaint-history/${h.id}`, { method: "DELETE" });
        setCmpHistory(prev => prev.filter(x => x.id !== h.id));
      } catch { showToast("삭제 실패"); }
    };

    const saveComplaintMatch = async (debtorId) => {
      if (!selComplaint) return;
      try {
        await fetch(`/api/complaints/${selComplaint.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ debtorId }),
        });
        const debtor = data.debtors.find(d => d.id === debtorId);
        updateMR(MK.complaints, selComplaint.id, { debtorId, debtorName: debtor?.name || selComplaint.debtorName, brand: debtor?.brand || selComplaint.brand });
        setData(prev => ({ ...prev, complaints: prev.complaints.map(c => c.id === selComplaint.id ? { ...c, debtorId, debtorName: debtor?.name || c.debtorName, brand: debtor?.brand || c.brand } : c) }));
        setSelComplaint(prev => ({ ...prev, debtorId, debtorName: debtor?.name || prev.debtorName, brand: debtor?.brand || prev.brand }));
        setCmpMatchMode(false); setCmpMatchQ("");
        showToast(debtorId ? "채무자 연결 완료" : "연결 해제됨");
      } catch { showToast("저장 실패"); }
    };

    const ComplaintDetailModal = () => {
      if (!selComplaint) return null;
      const c = selComplaint;
      const debtor = getDebtor(c.debtorId);
      const total = (c.loanAmount || 0) + (c.goodsAmount || 0);
      const statusOptions = ["준비중", "수사중", "기소", "불송치", "취하"];
      const today2 = () => new Date().toISOString().slice(0, 10);
      return (
        <div onClick={() => setSelComplaint(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, width: 580, maxHeight: "90vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.25)", overflow: "hidden" }}>
            {/* 헤더 */}
            <div style={{ padding: "16px 20px 12px", borderBottom: "1px solid var(--brd)", display: "flex", alignItems: "center", gap: 10, background: "var(--bg2)", flexShrink: 0 }}>
              <BrandBadge code={c.brand} brands={config.brands} />
              <div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{c.debtorName}</div>
                <div style={{ fontSize: 11, color: "var(--tm)", marginTop: 2 }}>고소인: {c.complainant || "-"}</div>
              </div>
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
                <Badge status={c.charge} />
                <button onClick={() => setSelComplaint(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--tm)", padding: 4 }}><I name="close" size={18} /></button>
              </div>
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: "14px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
              {/* 기본 정보 */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, background: "var(--bg2)", borderRadius: 10, padding: 14 }}>
                <div><div style={{ fontSize: 10, color: "var(--tm)", marginBottom: 3 }}>고소일</div><div style={{ fontSize: 12, fontWeight: 500 }}>{fmtDate(c.complaintDate) || "-"}</div></div>
                <div><div style={{ fontSize: 10, color: "var(--tm)", marginBottom: 3 }}>피해금액</div><div className="mono" style={{ fontSize: 12, fontWeight: 600, color: "var(--err)" }}>{fmt(total)}</div></div>
                <div><div style={{ fontSize: 10, color: "var(--tm)", marginBottom: 3 }}>물품대</div><div className="mono" style={{ fontSize: 12 }}>{fmt(c.goodsAmount || 0)}</div></div>
                <div><div style={{ fontSize: 10, color: "var(--tm)", marginBottom: 3 }}>대여금</div><div className="mono" style={{ fontSize: 12 }}>{fmt(c.loanAmount || 0)}</div></div>
              </div>

              {/* 수사 정보 + 상태 */}
              <div style={{ background: "var(--bg2)", borderRadius: 10, padding: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ts)", marginBottom: 10 }}>수사 정보</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <div>
                    <div style={{ fontSize: 10, color: "var(--tm)", marginBottom: 4 }}>경찰서</div>
                    <KoreanInput value={cmpEdit.policeStation} onChange={e => setCmpEdit(p => ({ ...p, policeStation: e.target.value }))} placeholder="예: 광진경찰서" style={{ width: "100%", padding: "6px 10px", fontSize: 12, borderRadius: 6, border: "1px solid var(--brd)", background: "var(--card)" }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: "var(--tm)", marginBottom: 4 }}>죄명</div>
                    <KoreanInput value={cmpEdit.charge} onChange={e => setCmpEdit(p => ({ ...p, charge: e.target.value }))} placeholder="예: 사기, 횡령, 배임 등" style={{ width: "100%", padding: "6px 10px", fontSize: 12, borderRadius: 6, border: "1px solid var(--brd)", background: "var(--card)" }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: "var(--tm)", marginBottom: 4 }}>결과/상태</div>
                    <select value={cmpEdit.status} onChange={e => setCmpEdit(p => ({ ...p, status: e.target.value }))} style={{ width: "100%", padding: "6px 10px", fontSize: 12, borderRadius: 6, border: "1px solid var(--brd)", background: "var(--card)" }}>
                      {statusOptions.map(s => <option key={s}>{s}</option>)}
                    </select>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: "var(--tm)", marginBottom: 4 }}>수사관</div>
                    <KoreanInput value={cmpEdit.investigator} onChange={e => setCmpEdit(p => ({ ...p, investigator: e.target.value }))} placeholder="수사관 이름" style={{ width: "100%", padding: "6px 10px", fontSize: 12, borderRadius: 6, border: "1px solid var(--brd)", background: "var(--card)" }} />
                  </div>
                  <div style={{ gridColumn: "1 / -1" }}>
                    <div style={{ fontSize: 10, color: "var(--tm)", marginBottom: 4 }}>연락처</div>
                    <KoreanInput value={cmpEdit.investigatorContact} onChange={e => setCmpEdit(p => ({ ...p, investigatorContact: e.target.value }))} placeholder="전화번호" style={{ width: "100%", padding: "6px 10px", fontSize: 12, borderRadius: 6, border: "1px solid var(--brd)", background: "var(--card)" }} />
                  </div>
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                  <button onClick={saveComplaintEdit} style={{ padding: "5px 14px", borderRadius: 6, background: "var(--ok)", color: "#fff", fontSize: 12, fontWeight: 600, border: "none", cursor: "pointer" }}>저장</button>
                </div>
              </div>

              {/* 고소장 PDF */}
              <div style={{ background: "var(--bg2)", borderRadius: 10, padding: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ts)", marginBottom: 8 }}>고소장 PDF</div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <KoreanInput value={cmpEdit.complaintUrl} onChange={e => setCmpEdit(p => ({ ...p, complaintUrl: e.target.value }))} placeholder="OneDrive 공유 링크 붙여넣기..." style={{ flex: 1, padding: "7px 10px", fontSize: 12, borderRadius: 6, border: "1px solid var(--brd)", background: "var(--card)" }} />
                  {cmpEdit.complaintUrl
                    ? <a href={cmpEdit.complaintUrl} target="_blank" rel="noopener noreferrer" style={{ padding: "7px 12px", borderRadius: 6, background: "#3b82f618", color: "#1d4ed8", fontSize: 12, fontWeight: 600, border: "1px solid #3b82f630", textDecoration: "none", whiteSpace: "nowrap" }}>열기</a>
                    : <span style={{ padding: "7px 12px", borderRadius: 6, background: "var(--bg)", color: "var(--tm)", fontSize: 12, border: "1px solid var(--brd)", whiteSpace: "nowrap" }}>미연동</span>}
                  <button onClick={saveComplaintEdit} style={{ padding: "7px 12px", borderRadius: 6, background: "var(--ok)", color: "#fff", fontSize: 12, fontWeight: 600, border: "none", cursor: "pointer" }}>저장</button>
                </div>
              </div>

              {/* 진행 히스토리 */}
              <div style={{ background: "var(--bg2)", borderRadius: 10, padding: 14 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ts)" }}>진행 히스토리</div>
                  <button onClick={() => setCmpHistForm({ mode: "add", date: today2(), content: "", assignee: "" })} style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 10px", borderRadius: 6, background: "var(--acc)", color: "#fff", fontSize: 11, fontWeight: 600, border: "none", cursor: "pointer" }}><I name="plus" size={12} />추가</button>
                </div>
                {/* 추가/수정 폼 */}
                {cmpHistForm && (
                  <div style={{ background: "var(--card)", borderRadius: 8, padding: 12, border: "2px solid var(--acc)", marginBottom: 10 }}>
                    <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <input type="date" value={cmpHistForm.date} onChange={e => setCmpHistForm(f => ({ ...f, date: e.target.value }))} style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--brd)", background: "var(--bg)", fontSize: 12 }} />
                      <KoreanInput value={cmpHistForm.assignee} onChange={e => setCmpHistForm(f => ({ ...f, assignee: e.target.value }))} placeholder="담당자" style={{ width: 90, padding: "5px 8px", borderRadius: 6, border: "1px solid var(--brd)", background: "var(--bg)", fontSize: 12 }} />
                      <span style={{ fontSize: 11, color: "var(--tm)" }}>{cmpHistForm.mode === "add" ? "새 항목" : "수정"}</span>
                    </div>
                    <KoreanTextarea value={cmpHistForm.content} onChange={e => setCmpHistForm(f => ({ ...f, content: e.target.value }))} rows={3} placeholder="진행사항을 입력하세요..." style={{ width: "100%", padding: "7px 9px", borderRadius: 6, border: "1px solid var(--brd)", background: "var(--bg)", fontSize: 12, lineHeight: 1.6, resize: "vertical", boxSizing: "border-box" }} />
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 8 }}>
                      <button onClick={() => setCmpHistForm(null)} style={{ padding: "5px 12px", borderRadius: 6, background: "var(--bg)", color: "var(--tp)", border: "1px solid var(--brd)", fontSize: 12, cursor: "pointer" }}>취소</button>
                      <button onClick={saveCmpHist} style={{ padding: "5px 12px", borderRadius: 6, background: "var(--acc)", color: "#fff", border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>저장</button>
                    </div>
                  </div>
                )}
                {/* 히스토리 목록 */}
                <div style={{ background: "var(--card)", borderRadius: 8, border: "1px solid var(--brd)", overflow: "hidden" }}>
                  {cmpHistory.length === 0 && <div style={{ padding: 20, textAlign: "center", color: "var(--tm)", fontSize: 12 }}>진행사항 없음 — 위 버튼으로 추가하세요</div>}
                  {cmpHistory.map((h, i) => (
                    <div key={h.id} style={{ display: "flex", gap: 0, borderBottom: i < cmpHistory.length - 1 ? "1px solid var(--brd)" : "none" }}>
                      <div style={{ width: 100, flexShrink: 0, padding: "10px 12px", background: "var(--bg2)", borderRight: "1px solid var(--brd)", display: "flex", flexDirection: "column", gap: 3 }}>
                        <span className="mono" style={{ fontSize: 11, color: "var(--acc)", fontWeight: 600 }}>{h.date}</span>
                        {h.assignee && <span style={{ fontSize: 10, color: "var(--tm)" }}>{h.assignee}</span>}
                        {h.createdBy && h.createdBy !== h.assignee && <span style={{ fontSize: 9, color: "var(--tm)", opacity: 0.7 }}>{h.createdBy}</span>}
                      </div>
                      <div style={{ flex: 1, padding: "10px 14px", fontSize: 12, lineHeight: 1.7, color: "var(--tp)", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{h.content}</div>
                      <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", justifyContent: "center", gap: 3, padding: "6px 8px", borderLeft: "1px solid var(--brd)" }}>
                        {canEdit && <button onClick={() => setCmpHistForm({ mode: "edit", id: h.id, date: h.date, content: h.content, assignee: h.assignee || "" })} style={{ width: 24, height: 24, borderRadius: 5, background: "#3b82f610", color: "#3b82f6", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><I name="edit" size={11} /></button>}
                        {canEdit && <button onClick={() => deleteCmpHist(h)} style={{ width: 24, height: 24, borderRadius: 5, background: "#ef444410", color: "#ef4444", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><I name="trash" size={11} /></button>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* 채무자 매칭 */}
              <div style={{ background: "var(--bg2)", borderRadius: 10, padding: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ts)", marginBottom: 10 }}>채무자 연결</div>
                {debtor ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 8, background: "var(--card)", border: "1px solid var(--brd)" }}>
                    <BrandBadge code={debtor.brand} brands={config.brands} />
                    <span style={{ fontWeight: 600, flex: 1 }}>{debtor.name}</span>
                    <span className="mono" style={{ fontSize: 11, color: "var(--ok)" }}>{fmt(debtor.finalBalanceLegal)}</span>
                    <button onClick={() => { setCmpMatchMode(v => !v); setCmpMatchQ(""); }} style={{ fontSize: 11, padding: "3px 10px", borderRadius: 6, background: "var(--bg)", color: "var(--ts)", border: "1px solid var(--brd)", cursor: "pointer" }}>재매칭</button>
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 12, color: "var(--tm)", flex: 1 }}>연결된 채무자 없음</span>
                    <button onClick={() => { setCmpMatchMode(true); setCmpMatchQ(""); }} style={{ fontSize: 11, padding: "3px 10px", borderRadius: 6, background: "#3b82f618", color: "#1d4ed8", border: "1px solid #3b82f630", cursor: "pointer" }}>연결</button>
                  </div>
                )}
                {cmpMatchMode && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ position: "relative", marginBottom: 8 }}>
                      <div style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "var(--tm)" }}><I name="search" size={13} /></div>
                      <KoreanInput autoFocus value={cmpMatchQ} onChange={e => setCmpMatchQ(e.target.value)} placeholder="채무자명 검색..." style={{ width: "100%", padding: "6px 8px 6px 26px", fontSize: 12, borderRadius: 7, border: "1px solid var(--brd)", background: "var(--card)" }} />
                    </div>
                    <div style={{ maxHeight: 160, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
                      {c.debtorId && <div onClick={() => saveComplaintMatch(null)} style={{ display: "flex", alignItems: "center", padding: "6px 10px", borderRadius: 7, cursor: "pointer", fontSize: 12, background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", marginBottom: 4 }}>연결 해제</div>}
                      {cmpMatchCandidates.map(d => (
                        <div key={d.id} onClick={() => saveComplaintMatch(d.id)}
                          style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 7, cursor: "pointer", fontSize: 12, background: "var(--card)", border: "1px solid var(--brd)" }}
                          onMouseEnter={e => e.currentTarget.style.background = "var(--hover)"}
                          onMouseLeave={e => e.currentTarget.style.background = "var(--card)"}
                        >
                          <BrandBadge code={d.brand} brands={config.brands} />
                          <span style={{ fontWeight: 600, flex: 1 }}>{d.name}</span>
                          <span className="mono" style={{ color: "var(--ok)", fontSize: 11 }}>{fmt(d.finalBalanceLegal)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* 하단 버튼 */}
            <div style={{ padding: "10px 20px", borderTop: "1px solid var(--brd)", display: "flex", gap: 8, justifyContent: "flex-end", background: "var(--bg2)", flexShrink: 0 }}>
              {debtor && (
                <button onClick={() => { navigateToDebtor(debtor, "법적절차내역"); setSelComplaint(null); }} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, background: "#3b82f6", color: "#fff", fontSize: 13, fontWeight: 600, border: "none", cursor: "pointer" }}>
                  <I name="users" size={14} /> 채무자 페이지로 가기
                </button>
              )}
              <button onClick={() => setSelComplaint(null)} style={{ padding: "8px 16px", borderRadius: 8, background: "var(--bg)", color: "var(--tp)", fontSize: 13, border: "1px solid var(--brd)", cursor: "pointer" }}>닫기</button>
            </div>
          </div>
        </div>
      );
    };

    // 수동 매칭 저장 + state 갱신
    const handleManualMatch = (caseId, debtorId, ovKey, dataKey) => {
      saveLegalOv(ovKey, caseId, debtorId);
      setData(prev => ({
        ...prev,
        [dataKey]: prev[dataKey].map(c => c.id === caseId ? { ...c, debtorId } : c),
      }));
      setMatchingCase(null);
      setMatchQ("");
      showToast(debtorId ? "수동 매칭 완료 — 저장됨" : "연결 해제됨");
    };

    // 수동 매칭 패널 (인라인, 행 아래에 표시)
    const ManualMatchPanel = useStableComponent(({ caseId, ovKey, dataKey, onClose }) => (
      <div style={{ background: "var(--bg2)", borderRadius: 10, border: "1px solid var(--acc)", padding: 14, marginTop: -4 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--acc)", flex: 1 }}>채무자 수동 연결</div>
          <button onClick={() => handleManualMatch(caseId, null, ovKey, dataKey)} style={{ fontSize: 11, padding: "3px 10px", borderRadius: 6, background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca", cursor: "pointer" }}>연결 해제</button>
          <button onClick={onClose} style={{ fontSize: 11, padding: "3px 10px", borderRadius: 6, background: "var(--bg)", color: "var(--tm)", border: "1px solid var(--brd)", cursor: "pointer" }}>닫기</button>
        </div>
        <div style={{ position: "relative", marginBottom: 8 }}>
          <div style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "var(--tm)" }}><I name="search" size={13} /></div>
          <KoreanInput value={matchQ} onChange={e => setMatchQ(e.target.value)} autoFocus placeholder="채무자명·연락처·허브명 검색..." style={{ width: "100%", padding: "6px 8px 6px 26px", fontSize: 12, borderRadius: 7, border: "1px solid var(--brd)", background: "var(--card)", color: "var(--tp)" }} />
        </div>
        <div style={{ maxHeight: 200, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
          {matchCandidates.length === 0 && <div style={{ fontSize: 12, color: "var(--tm)", padding: 8 }}>검색 결과 없음</div>}
          {matchCandidates.map(d => (
            <div key={d.id} onClick={() => handleManualMatch(caseId, d.id, ovKey, dataKey)}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 7, cursor: "pointer", fontSize: 12, background: "var(--card)", border: "1px solid var(--brd)" }}
              onMouseEnter={e => e.currentTarget.style.background = "var(--hover)"}
              onMouseLeave={e => e.currentTarget.style.background = "var(--card)"}
            >
              <BrandBadge code={d.brand} brands={config.brands} />
              <span style={{ fontWeight: 600, minWidth: 70 }}>{d.name}</span>
              <span style={{ color: "var(--ts)", fontSize: 11 }}>{d.hubName}</span>
              <span style={{ flex: 1 }} />
              <span className="mono" style={{ color: "var(--ok)", fontSize: 11 }}>{fmt(d.finalBalanceLegal)}</span>
            </div>
          ))}
        </div>
      </div>
    ));

    // 단일 사건 행 (지급명령/압류)
    // 지급명령/압류/재산명시·재산조회/형사고소 4종을 한 행 컴포넌트로 통합 — kind로 분기
    const CaseRow = useStableComponent(({ c, kind }) => {
      const kindBadge = (
        <span style={{ minWidth: 88, textAlign: "center", flexShrink: 0, fontSize: 11, fontWeight: 700, padding: "2px 6px", borderRadius: 6, background: `${KIND_COLOR[kind]}18`, color: KIND_COLOR[kind], border: `1px solid ${KIND_COLOR[kind]}30` }}>{kind}</span>
      );

      if (kind === "형사고소") {
        const debtor = getDebtor(c.debtorId);
        return (
          <div
            onClick={() => openComplaint(c)}
            style={{ background: "var(--card)", borderRadius: 10, border: "1px solid var(--brd)", cursor: "pointer", transition: "background 0.1s" }}
            onMouseEnter={e => e.currentTarget.style.background = "var(--hover)"}
            onMouseLeave={e => e.currentTarget.style.background = "var(--card)"}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 16px", flexWrap: "wrap" }}>
              {c.brand ? <BrandBadge code={c.brand} brands={config.brands} /> : <span style={{ width: 22 }} />}
              {kindBadge}
              <span style={{ fontWeight: 600, minWidth: 80 }}>{c.debtorName || "-"}</span>
              <span style={{ fontSize: 12, color: "var(--ts)", minWidth: 100 }}>{c.policeStation || "-"}</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--tm)", minWidth: 130 }}>{c.charge || "-"}</span>
              <span style={{ fontSize: 12, color: "var(--ts)", minWidth: 90 }}>{c.complaintDate || "-"}</span>
              <Badge status={c.status || "준비중"} small />
              <span style={{ flex: 1 }} />
              {debtor && <span className="mono" style={{ fontSize: 12, color: "var(--ok)", fontWeight: 600 }}>{fmt(debtor.finalBalanceLegal)}</span>}
            </div>
          </div>
        );
      }

      const isAD      = kind === "재산명시·재산조회";
      const debtor     = getDebtor(c.debtorId);
      const isMatching = matchingCase?.id === c.id;
      const name       = isAD ? c.debtorName : c.defendant;
      const dateVal    = isAD ? c.applicationDate : c.filingDate;
      const statusVal  = isAD ? (c.status || "진행") : c.progressStatus;
      const ovKey      = isAD ? AD_OVERRIDES_KEY : LEGAL_OVERRIDES_KEY;
      const dataKey    = isAD ? "assetDisclosures" : "legalCases";
      const inquiryBadge = isAD && (
        <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, borderRadius: 6, fontSize: 12, fontWeight: 700, background: c.hasInquiryOrder ? "#10b98118" : "#f1f5f9", color: c.hasInquiryOrder ? "#047857" : "#94a3b8", border: `1px solid ${c.hasInquiryOrder ? "#10b98140" : "#e2e8f0"}` }}>
          {c.hasInquiryOrder ? "O" : "X"}
        </span>
      );
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          <div
            onClick={() => !isMatching && setSelCase({ ...c, _kind: isAD ? "ad" : "legal" })}
            style={{ background: "var(--card)", borderRadius: isMatching ? "10px 10px 0 0" : 10, border: "1px solid var(--brd)", borderBottom: isMatching ? "none" : "1px solid var(--brd)", padding: "11px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}
            onMouseEnter={e => { if (!isMatching) e.currentTarget.style.background = "var(--hover)"; }}
            onMouseLeave={e => { if (!isMatching) e.currentTarget.style.background = "var(--card)"; }}
          >
            {c.brand ? <BrandBadge code={c.brand} brands={config.brands} /> : <span style={{ width: 22 }} />}
            {kindBadge}
            <span style={{ fontWeight: 600, minWidth: 80 }}>{name || "-"}</span>
            <span style={{ fontSize: 12, color: "var(--ts)", minWidth: 100 }}>{c.court}</span>
            <span className="mono" style={{ fontSize: 11, color: "var(--tm)", minWidth: 130 }}>{c.caseNumber}</span>
            <span style={{ fontSize: 12, color: "var(--ts)", minWidth: 90 }}>{dateVal || "-"}</span>
            {statusVal ? <Badge status={statusVal} /> : null}
            {!isAD && c.caseStatus ? <Badge status={c.caseStatus} small /> : null}
            {inquiryBadge}
            <span style={{ flex: 1 }} />
            {getCaseUrl(c.id) && <a href={getCaseUrl(c.id)} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ fontSize: 10, padding: "2px 7px", borderRadius: 5, background: "#3b82f618", color: "#1d4ed8", border: "1px solid #3b82f630", textDecoration: "none", whiteSpace: "nowrap", flexShrink: 0 }}>문서</a>}
            {debtor
              ? <>
                  <span className="mono" style={{ fontSize: 12, color: "var(--ok)", fontWeight: 600 }}>{fmt(debtor.finalBalanceLegal)}</span>
                  <button onClick={e => { e.stopPropagation(); setMatchingCase({ id: c.id }); setMatchQ(""); }}
                    style={{ fontSize: 10, padding: "2px 7px", borderRadius: 5, background: "var(--bg2)", color: "var(--tm)", border: "1px solid var(--brd)", cursor: "pointer" }}>재매칭</button>
                </>
              : <button onClick={e => { e.stopPropagation(); setMatchingCase({ id: c.id }); setMatchQ(""); }}
                  style={{ fontSize: 11, padding: "3px 9px", borderRadius: 6, background: "#eff6ff", color: "#1d4ed8", border: "1px solid #bfdbfe", cursor: "pointer", fontWeight: 600 }}>연결</button>
            }
          </div>
          {isMatching && <ManualMatchPanel caseId={c.id} ovKey={ovKey} dataKey={dataKey} onClose={() => { setMatchingCase(null); setMatchQ(""); }} />}
        </div>
      );
    });

    const handleAddNote = () => {
      if (!selCase || !noteDraft.trim()) return;
      const arr = [{ id: uid("NOTE"), createdAt: new Date().toISOString(), content: noteDraft.trim(), createdBy: currentUser?.name || "알수없음" }, ...caseNotes];
      saveCaseNotes(selCase.id, arr);
      setCaseNotes(arr);
      setNoteDraft("");
    };
    const handleDeleteNote = (noteId) => {
      if (!selCase || !confirm("이 메모를 삭제하시겠습니까?")) return;
      const arr = caseNotes.filter(n => n.id !== noteId);
      saveCaseNotes(selCase.id, arr);
      setCaseNotes(arr);
    };

    // 상세 모달 내용
    const DetailModal = useStableComponent(() => {
      if (!selCase) return null;
      const debtor = getDebtor(selCase.debtorId);
      const isAD   = selCase._kind === "ad";
      const title  = isAD ? selCase.debtorName : selCase.defendant;
      const [docUrl, setDocUrl] = useState(() => getCaseUrl(selCase.id));
      const saveDocUrl = () => { saveCaseUrl(selCase.id, docUrl); showToast("문서 링크 저장됨"); };
      const [isEditingCase, setIsEditingCase] = useState(false);
      const [caseDraft, setCaseDraft] = useState(() => ({
        court: selCase.court || "", caseNumber: selCase.caseNumber || "",
        plaintiff: selCase.plaintiff || "", defendant: selCase.defendant || "",
        filingDate: selCase.filingDate || "", progressStatus: selCase.progressStatus || "진행",
      }));
      const setCF = (k, v) => setCaseDraft(p => ({ ...p, [k]: v }));
      const startEditCase = () => {
        setCaseDraft({
          court: selCase.court || "", caseNumber: selCase.caseNumber || "",
          plaintiff: selCase.plaintiff || "", defendant: selCase.defendant || "",
          filingDate: selCase.filingDate || "", progressStatus: selCase.progressStatus || "진행",
        });
        setIsEditingCase(true);
      };
      const saveEditCase = () => {
        saveCaseFieldOv(selCase.id, caseDraft);
        setSelCase(prev => ({ ...prev, ...caseDraft }));
        setData(prev => ({ ...prev, legalCases: prev.legalCases.map(c => c.id === selCase.id ? { ...c, ...caseDraft } : c) }));
        setIsEditingCase(false);
        showToast("저장 완료");
      };
      const DL = ({ label, val }) => val ? (
        <div style={{ display: "flex", gap: 8, fontSize: 13, padding: "4px 0", borderBottom: "1px solid var(--brd)" }}>
          <span style={{ color: "var(--tm)", minWidth: 110, flexShrink: 0 }}>{label}</span>
          <span style={{ color: "var(--tp)", fontWeight: 500 }}>{val}</span>
        </div>
      ) : null;
      const EF = ({ label, children }) => (
        <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, padding: "4px 0", borderBottom: "1px solid var(--brd)" }}>
          <span style={{ color: "var(--tm)", minWidth: 110, flexShrink: 0 }}>{label}</span>
          <div style={{ flex: 1 }}>{children}</div>
        </div>
      );
      return (
        <Overlay onClose={() => setSelCase(null)} wide>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {selCase.brand && <BrandBadge code={selCase.brand} brands={config.brands} />}
              <span style={{ fontSize: 17, fontWeight: 700 }}>{title}</span>
            </div>
            <button onClick={() => setSelCase(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--tm)", padding: 4 }}><I name="close" size={18} /></button>
          </div>

          {/* 사건 정보 */}
          <div style={{ background: "var(--bg)", borderRadius: 10, padding: "12px 16px", marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--tm)" }}>사건 정보</div>
              <span style={{ flex: 1 }} />
              {!isAD && (isEditingCase ? (
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={saveEditCase} style={{ fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 6, background: "var(--acc)", color: "#fff", border: "none", cursor: "pointer" }}>저장</button>
                  <button onClick={() => setIsEditingCase(false)} style={{ fontSize: 11, padding: "3px 10px", borderRadius: 6, background: "var(--bg2)", color: "var(--tm)", border: "1px solid var(--brd)", cursor: "pointer" }}>취소</button>
                </div>
              ) : (
                <button onClick={startEditCase} style={{ fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 6, background: "var(--bg2)", color: "var(--tm)", border: "1px solid var(--brd)", cursor: "pointer" }}>수정</button>
              ))}
            </div>
            {!isAD && isEditingCase ? (
              <>
                <EF label="법원"><KoreanInput value={caseDraft.court} onChange={e => setCF("court", e.target.value)} style={inp} /></EF>
                <EF label="사건번호"><KoreanInput value={caseDraft.caseNumber} onChange={e => setCF("caseNumber", e.target.value)} style={inp} /></EF>
                <EF label="원고(채권자)"><KoreanInput value={caseDraft.plaintiff} onChange={e => setCF("plaintiff", e.target.value)} style={inp} /></EF>
                <EF label="피고(채무자)"><KoreanInput value={caseDraft.defendant} onChange={e => setCF("defendant", e.target.value)} style={inp} /></EF>
                <EF label="접수일자"><KoreanInput value={caseDraft.filingDate} onChange={e => setCF("filingDate", e.target.value)} style={inp} placeholder="YYYY.MM.DD" /></EF>
                <EF label="진행상황">
                  <select value={caseDraft.progressStatus} onChange={e => setCF("progressStatus", e.target.value)} style={inp}>
                    {["진행", "완료", "부분해지", "전부해지"].map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </EF>
              </>
            ) : (
              <>
                <DL label="법원"       val={selCase.court} />
                <DL label="사건번호"   val={selCase.caseNumber} />
                {!isAD && <DL label="원고(채권자)"  val={selCase.plaintiff} />}
                {!isAD && <DL label="피고(채무자)"  val={selCase.defendant} />}
                {!isAD && <DL label="접수일자"      val={selCase.filingDate} />}
                {!isAD && <DL label="기일시간"      val={selCase.hearingTime} />}
                {!isAD && <DL label="기일장소"      val={selCase.hearingLocation} />}
                {!isAD && <DL label="진행상황"      val={selCase.progressStatus} />}
                {isAD  && <DL label="대상자"        val={selCase.debtorName} />}
                {isAD  && <DL label="신청일"        val={selCase.applicationDate} />}
                {isAD  && <DL label="결정일"        val={selCase.decisionDate} />}
                {isAD  && <DL label="결과"          val={selCase.result} />}
                {isAD  && <DL label="결과 상태"     val={selCase.status} />}
                {isAD  && <DL label="취하/각하 사유" val={selCase.withdrawReason} />}
                {isAD  && <DL label="감치결정"      val={selCase.detentionDecision} />}
                {isAD  && <DL label="재산목록 제출"  val={selCase.propertyList && `${selCase.propertyList}${selCase.propertyListDesc ? ` (${selCase.propertyListDesc})` : ""}`} />}
                {isAD  && <DL label="집행장 만료/취하" val={selCase.executionExpiration} />}
              </>
            )}
          </div>

          {/* 재산조회 섹션 (재산명시인 경우) */}
          {isAD && (
            <div style={{ background: "var(--bg)", borderRadius: 10, padding: "12px 16px", marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--tm)" }}>재산조회</div>
                <span style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  width: 22, height: 22, borderRadius: 6, fontSize: 12, fontWeight: 700,
                  background: selCase.hasInquiryOrder ? "#10b98118" : "#f1f5f9",
                  color:      selCase.hasInquiryOrder ? "#047857"   : "#94a3b8",
                  border:     `1px solid ${selCase.hasInquiryOrder ? "#10b98140" : "#e2e8f0"}`
                }}>{selCase.hasInquiryOrder ? "O" : "X"}</span>
              </div>
              <DL label="조회명령일"  val={selCase.inquiryOrderDate} />
              <DL label="조회 신청일" val={selCase.inquiryApplicationDate} />
              <DL label="회신 결과"   val={selCase.inquiryResponse} />
            </div>
          )}

          {/* 진행상황 메모 */}
          <div style={{ background: "var(--bg)", borderRadius: 10, padding: "12px 16px", marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--tm)", marginBottom: 8 }}>진행상황 메모</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
              <KoreanTextarea
                value={noteDraft} onChange={e => setNoteDraft(e.target.value)} rows={2}
                placeholder="진행상황을 입력하세요... (날짜·작성자 자동 기재)"
                style={{ flex: 1, padding: "7px 10px", borderRadius: 7, border: "1px solid var(--brd)", background: "var(--card)", color: "var(--tp)", fontSize: 12, lineHeight: 1.6, resize: "vertical", boxSizing: "border-box" }}
              />
              <button onClick={handleAddNote} disabled={!noteDraft.trim()} style={{ padding: "0 14px", borderRadius: 7, background: noteDraft.trim() ? "var(--acc)" : "var(--bg2)", color: noteDraft.trim() ? "#fff" : "var(--tm)", border: "none", fontSize: 12, fontWeight: 600, cursor: noteDraft.trim() ? "pointer" : "default", whiteSpace: "nowrap" }}>추가</button>
            </div>
            {caseNotes.length === 0
              ? <div style={{ fontSize: 12, color: "var(--tm)", padding: "4px 0" }}>등록된 메모가 없습니다.</div>
              : <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
                  {caseNotes.map(n => (
                    <div key={n.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", background: "var(--card)", borderRadius: 8, border: "1px solid var(--brd)", padding: "8px 10px" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 3 }}>
                          <span className="mono" style={{ fontSize: 10, color: "var(--acc)", fontWeight: 600 }}>{fmtDateTime(n.createdAt)}</span>
                          <span style={{ fontSize: 10, color: "var(--tm)" }}>{n.createdBy}</span>
                        </div>
                        <div style={{ fontSize: 12, color: "var(--tp)", lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{n.content}</div>
                      </div>
                      {canDeleteRecord(n) && <button onClick={() => handleDeleteNote(n.id)} title="삭제" style={{ width: 22, height: 22, flexShrink: 0, borderRadius: 6, background: "#ef444410", color: "#ef4444", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><I name="trash" size={11} /></button>}
                    </div>
                  ))}
                </div>
            }
          </div>

          {/* OneDrive 문서 */}
          <div style={{ background: "var(--bg)", borderRadius: 10, padding: "12px 16px", marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--tm)", marginBottom: 8 }}>문서 (OneDrive)</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <KoreanInput value={docUrl} onChange={e => setDocUrl(e.target.value)} placeholder="OneDrive 공유 링크 붙여넣기..." style={{ flex: 1, padding: "7px 10px", fontSize: 12, borderRadius: 6, border: "1px solid var(--brd)", background: "var(--card)", color: "var(--tp)" }} />
              {docUrl
                ? <a href={docUrl} target="_blank" rel="noopener noreferrer" style={{ padding: "7px 12px", borderRadius: 6, background: "#3b82f618", color: "#1d4ed8", fontSize: 12, fontWeight: 600, border: "1px solid #3b82f630", textDecoration: "none", whiteSpace: "nowrap" }}>열기</a>
                : <span style={{ padding: "7px 12px", borderRadius: 6, background: "var(--bg2)", color: "var(--tm)", fontSize: 12, border: "1px solid var(--brd)", whiteSpace: "nowrap" }}>미연동</span>}
              <button onClick={saveDocUrl} style={{ padding: "7px 12px", borderRadius: 6, background: "var(--ok)", color: "#fff", fontSize: 12, fontWeight: 600, border: "none", cursor: "pointer" }}>저장</button>
            </div>
          </div>

          {/* 연동 채무자 */}
          <div style={{ background: "var(--bg)", borderRadius: 10, padding: "12px 16px", marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--tm)", marginBottom: 8 }}>채무자 연동</div>
            {debtor ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <DL label="분류"     val={debtor.category} />
                <DL label="담당자"   val={debtor.assignee} />
                <DL label="연락처"   val={debtor.phone} />
                <DL label="잔액(법무)" val={fmt(debtor.finalBalanceLegal)} />
                <DL label="잔액(재무)" val={fmt(debtor.finalBalanceFinance)} />
              </div>
            ) : (
              <div style={{ fontSize: 13, color: "var(--tm)", padding: "6px 0" }}>채무자 관리 탭과 연결되지 않은 사건입니다.</div>
            )}
          </div>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            {debtor && (
              <button
                onClick={() => { navigateToDebtor(debtor, "법적절차내역"); setSelCase(null); }}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, background: "#3b82f6", color: "#fff", fontSize: 13, fontWeight: 600, border: "none", cursor: "pointer" }}
              >
                <I name="users" size={14} /> 채무자 페이지로 가기
              </button>
            )}
            <button onClick={() => setSelCase(null)} style={{ padding: "8px 16px", borderRadius: 8, background: "var(--bg2)", color: "var(--tp)", fontSize: 13, fontWeight: 500, border: "1px solid var(--brd)", cursor: "pointer" }}>닫기</button>
          </div>
        </Overlay>
      );
    });

    return (
      <div className="anim" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {selCase && <DetailModal />}

        {/* KPI 카드 — 클릭하면 해당 유형만 필터링 (다시 클릭하면 전체 유형으로 해제) */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
          <KPI label="지급명령" value={`${payOrders.length}건`}
            sub={`브랜드 B:${payOrders.filter(c=>c.brand==="B").length} / M:${payOrders.filter(c=>c.brand==="M").length} / D:${payOrders.filter(c=>c.brand==="D").length}`}
            color="#3b82f6" active={legalTypeFilter === "지급명령"}
            onClick={() => setLegalTypeFilter(f => f === "지급명령" ? "전체" : "지급명령")} />
          <KPI label="압류" value={`${seizures.length}건`}
            sub={`브랜드 B:${seizures.filter(c=>c.brand==="B").length} / M:${seizures.filter(c=>c.brand==="M").length} / D:${seizures.filter(c=>c.brand==="D").length}`}
            color="#8b5cf6" active={legalTypeFilter === "압류"}
            onClick={() => setLegalTypeFilter(f => f === "압류" ? "전체" : "압류")} />
          <KPI label="재산명시·재산조회" value={`${ad.length}건`}
            sub={`재산조회 명령 ${ad.filter(c=>c.hasInquiryOrder).length}건`}
            color="#f59e0b" active={legalTypeFilter === "재산명시·재산조회"}
            onClick={() => setLegalTypeFilter(f => f === "재산명시·재산조회" ? "전체" : "재산명시·재산조회")} />
          <KPI label="형사고소" value={`${cmp.length}건`}
            sub={`수사중 ${cmp.filter(c=>c.status==="수사중").length}건`}
            color="#ef4444" active={legalTypeFilter === "형사고소"}
            onClick={() => setLegalTypeFilter(f => f === "형사고소" ? "전체" : "형사고소")} />
        </div>

        {/* 필터 + 다운로드 */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select value={brandF} onChange={e => setBrandF(e.target.value)} style={{ padding: "7px 10px", borderRadius: 8, fontSize: 13, border: "1px solid var(--brd)", background: "var(--card)", color: "var(--tp)" }}>
            <option value="전체">전체 브랜드</option>
            {config.brands.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}
          </select>
          <select value={legalTypeFilter} onChange={e => setLegalTypeFilter(e.target.value)} style={{ padding: "7px 10px", borderRadius: 8, fontSize: 13, border: "1px solid var(--brd)", background: "var(--card)", color: "var(--tp)" }}>
            <option value="전체">전체 유형</option>
            <option value="지급명령">지급명령</option>
            <option value="압류">압류</option>
            <option value="재산명시·재산조회">재산명시·재산조회</option>
            <option value="형사고소">형사고소</option>
          </select>
          <div style={{ position: "relative", flex: 1 }}>
            <div style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--tm)" }}><I name="search" size={14} /></div>
            <KoreanInput
              value={searchQ} onChange={e => setSearchQ(e.target.value)}
              placeholder="채무자명·사건번호·법원·죄명·경찰서 검색 (지급명령/압류/재산명시·재산조회/형사고소 통합)"
              style={{ width: "100%", padding: "7px 10px 7px 30px", borderRadius: 8, fontSize: 13, border: "1px solid var(--brd)", background: "var(--card)", color: "var(--tp)" }}
            />
          </div>
          <button onClick={() => setModal(legalTypeFilter === "형사고소" ? { type: "addComplaint" } : { type: "addLegal", legalType: legalTypeFilter === "전체" ? "지급명령" : (legalTypeFilter === "재산명시·재산조회" ? "재산명시" : legalTypeFilter) })}
            style={{ display: "flex", alignItems: "center", gap: 4, padding: "7px 12px", borderRadius: 8, background: "var(--acc)", color: "#fff", fontSize: 12, fontWeight: 600, border: "none", cursor: "pointer", whiteSpace: "nowrap" }}>
            <I name="plus" size={14} />데이터 추가
          </button>
          <button onClick={() => {
            const rows = allItems.map(({ c, kind }) => {
              const d = getDebtor(c.debtorId);
              const name   = kind === "형사고소" ? c.debtorName : (kind === "재산명시·재산조회" ? c.debtorName : c.defendant);
              const org    = kind === "형사고소" ? c.policeStation : c.court;
              const caseNo = kind === "형사고소" ? c.charge : c.caseNumber;
              const date   = kind === "형사고소" ? c.complaintDate : (kind === "재산명시·재산조회" ? c.applicationDate : c.filingDate);
              const status = kind === "형사고소" ? c.status : (kind === "재산명시·재산조회" ? (c.status || "진행") : c.progressStatus);
              return [kind, c.brand || "", name || "", org || "", caseNo || "", date || "", status || "", d ? (d.finalBalanceLegal || 0) : ""];
            });
            downloadCSV(`법적절차_${today()}.csv`, ["유형","브랜드","채무자","법원/기관","사건번호/죄명","접수일","상태","잔액"], rows);
          }} style={{ display: "flex", alignItems: "center", gap: 4, padding: "7px 12px", borderRadius: 8, background: "#10b98118", color: "#10b981", fontSize: 12, fontWeight: 600, border: "1px solid #10b98140", whiteSpace: "nowrap" }}>
            <I name="arrowDown" size={14} />엑셀
          </button>
        </div>

        {/* 리스트 헤더 */}
        <div style={{ display: "flex", gap: 10, padding: "4px 16px", fontSize: 11, color: "var(--ts)", fontWeight: 600 }}>
          <span style={{ width: 22 }} /><span style={{ minWidth: 88 }}>구분</span>
          <span style={{ minWidth: 80 }}>채무자명</span>
          <span style={{ minWidth: 100 }}>법원/기관</span><span style={{ minWidth: 130 }}>사건번호/죄명</span>
          <span style={{ minWidth: 90 }}>접수일</span>
          <span style={{ minWidth: 58, cursor: "pointer", userSelect: "none" }} onClick={toggleSort}>상태{statusSort === "asc" ? " ↑" : statusSort === "desc" ? " ↓" : ""}</span>
          <span style={{ flex: 1 }} /><span>잔액</span>
        </div>

        {/* 지급명령/압류/재산명시·재산조회/형사고소 통합 리스트 */}
        {allItems.length === 0
          ? <div style={{ padding: 32, textAlign: "center", color: "var(--tm)", background: "var(--card)", borderRadius: 12, border: "1px solid var(--brd)" }}>조건에 맞는 법적절차 사건이 없습니다.</div>
          : <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{allItems.map(({ c, kind }) => <CaseRow key={`${kind}-${c.id}`} c={c} kind={kind} />)}</div>
        }
        {ComplaintDetailModal()}
      </div>
    );
  });

  // ─── Rehab/Bankruptcy View ───────────────────────────────
  const RehabBankruptcyView = useStableComponent(() => {
    const rehabTab = rehabSubTab;
    const [rBrand, setRBrand] = useState("전체");
    const [rq, setRq] = useState("");
    const [matchingRehab, setMatchingRehab] = useState(null); // 수동 매칭 중인 rehab
    const [matchQ, setMatchQ] = useState("");
    const [selRehab, setSelRehab] = useState(null);

    const matchCandidates = useMemo(() => {
      if (!matchingRehab) return [];
      const q = matchQ.toLowerCase().trim();
      const list = q
        ? data.debtors.filter(d => d.name.toLowerCase().includes(q) || d.id.toLowerCase().includes(q))
        : data.debtors.filter(d => d.category === "회생/파산");
      return list.slice(0, 30);
    }, [matchQ, matchingRehab, data.debtors]);

    const handleManualMatch = (rehabId, debtorId) => {
      saveRehabOverride(rehabId, debtorId);
      setData(prev => ({
        ...prev,
        rehabilitations: prev.rehabilitations.map(r => r.id === rehabId ? { ...r, debtorId } : r),
      }));
      setMatchingRehab(null);
      setMatchQ("");
      showToast(debtorId ? "수동 매칭 완료 — 저장됨" : "연결 해제됨");
    };
    const filtered = useMemo(() => {
      let l = data.rehabilitations.filter(r => r.type === rehabTab);
      if (rBrand !== "전체") l = l.filter(r => r.brand === rBrand);
      if (rq) { const q = rq.toLowerCase(); l = l.filter(r => r.debtorName.toLowerCase().includes(q) || r.caseNumber.includes(q) || (r.repaymentNote || "").includes(q)); }
      return l;
    }, [data.rehabilitations, rehabTab, rBrand, rq]);
    const RehabDetailModal = useStableComponent(() => {
      if (!selRehab) return null;
      const r = selRehab;
      const debtor = r.debtorId ? data.debtors.find(d => d.id === r.debtorId) : null;
      const [docUrl, setDocUrl] = useState(() => getCaseUrl(r.id));
      const saveDocUrl = () => { saveCaseUrl(r.id, docUrl); showToast("문서 링크 저장됨"); };
      const DL = ({ label, val }) => val ? (
        <div style={{ display: "flex", gap: 8, fontSize: 13, padding: "4px 0", borderBottom: "1px solid var(--brd)" }}>
          <span style={{ color: "var(--tm)", minWidth: 120, flexShrink: 0 }}>{label}</span>
          <span style={{ color: "var(--tp)", fontWeight: 500 }}>{val}</span>
        </div>
      ) : null;
      return (
        <Overlay onClose={() => setSelRehab(null)} wide>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {r.brand && <BrandBadge code={r.brand} brands={config.brands} />}
              <span style={{ fontSize: 17, fontWeight: 700 }}>{r.debtorName}</span>
              <Badge status={r.type} />
              {r.overdueStatus === "미납" && <span style={{ fontSize: 11, fontWeight: 700, color: "#b91c1c", padding: "2px 10px", background: "#ef444420", borderRadius: 20, border: "1px solid #ef444440" }}>미납</span>}
              {r.dismissed && <span style={{ fontSize: 11, fontWeight: 700, color: "#b45309", padding: "2px 10px", background: "#f59e0b20", borderRadius: 20, border: "1px solid #f59e0b40" }}>폐지</span>}
              {r.planApproved && <span style={{ fontSize: 11, fontWeight: 600, color: "#047857", padding: "2px 10px", background: "#10b98118", borderRadius: 20, border: "1px solid #10b98130" }}>인가</span>}
            </div>
            <button onClick={() => setSelRehab(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--tm)", padding: 4 }}><I name="close" size={18} /></button>
          </div>

          {/* 사건 정보 */}
          <div style={{ background: "var(--bg)", borderRadius: 10, padding: "12px 16px", marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--tm)", marginBottom: 8 }}>사건 정보</div>
            <DL label="법원" val={r.court} />
            <DL label="사건번호" val={r.caseNumber} />
            <DL label="채권번호" val={r.creditorNumber} />
            <DL label="채무액" val={r.debtAmount > 0 ? fmt(r.debtAmount) : null} />
            <DL label="승인액" val={r.approvedAmount > 0 ? fmt(r.approvedAmount) : null} />
            <DL label="월상환액" val={r.monthlyPayment > 0 ? fmt(r.monthlyPayment) : null} />
            <DL label="현재 회차" val={r.currentRound} />
            <DL label="변제 계획 인가" val={r.planApproved ? "인가" : null} />
            <DL label="폐지 여부" val={r.dismissed ? "폐지" : null} />
            <DL label="미납 현황" val={r.overdueStatus} />
            <DL label="비고" val={r.repaymentNote} />
          </div>

          {/* 연동 채무자 */}
          <div style={{ background: "var(--bg)", borderRadius: 10, padding: "12px 16px", marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--tm)", marginBottom: 8 }}>채무자 연동</div>
            {debtor ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <DL label="이름" val={debtor.name} />
                <DL label="브랜드" val={debtor.brandName || debtor.brand} />
                <DL label="분류" val={debtor.category} />
                <DL label="담당자" val={debtor.assignee} />
                <DL label="잔액(법무)" val={fmt(debtor.finalBalanceLegal)} />
                <DL label="잔액(재무)" val={fmt(debtor.finalBalanceFinance)} />
              </div>
            ) : (
              <div style={{ fontSize: 13, color: "var(--tm)", padding: "6px 0" }}>채무자 관리 탭과 연결되지 않은 사건입니다.</div>
            )}
          </div>

          {/* OneDrive 문서 */}
          <div style={{ background: "var(--bg)", borderRadius: 10, padding: "12px 16px", marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--tm)", marginBottom: 8 }}>문서 (OneDrive)</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <KoreanInput value={docUrl} onChange={e => setDocUrl(e.target.value)} placeholder="OneDrive 공유 링크 붙여넣기..." style={{ flex: 1, padding: "7px 10px", fontSize: 12, borderRadius: 6, border: "1px solid var(--brd)", background: "var(--card)", color: "var(--tp)" }} />
              {docUrl
                ? <a href={docUrl} target="_blank" rel="noopener noreferrer" style={{ padding: "7px 12px", borderRadius: 6, background: "#3b82f618", color: "#1d4ed8", fontSize: 12, fontWeight: 600, border: "1px solid #3b82f630", textDecoration: "none", whiteSpace: "nowrap" }}>열기</a>
                : <span style={{ padding: "7px 12px", borderRadius: 6, background: "var(--bg2)", color: "var(--tm)", fontSize: 12, border: "1px solid var(--brd)", whiteSpace: "nowrap" }}>미연동</span>}
              <button onClick={saveDocUrl} style={{ padding: "7px 12px", borderRadius: 6, background: "var(--ok)", color: "#fff", fontSize: 12, fontWeight: 600, border: "none", cursor: "pointer" }}>저장</button>
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            {debtor && (
              <button
                onClick={() => { navigateToDebtor(debtor, "회생파산"); setSelRehab(null); }}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, background: "#3b82f6", color: "#fff", fontSize: 13, fontWeight: 600, border: "none", cursor: "pointer" }}
              >
                <I name="users" size={14} /> 채무자 페이지로 가기
              </button>
            )}
            <button onClick={() => setSelRehab(null)} style={{ padding: "8px 16px", borderRadius: 8, background: "var(--bg2)", color: "var(--tp)", fontSize: 13, fontWeight: 500, border: "1px solid var(--brd)", cursor: "pointer" }}>닫기</button>
          </div>
        </Overlay>
      );
    });

    return (
      <>
      {selRehab && <RehabDetailModal />}
      <div className="anim" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12 }}>
          <KPI label="회생/파산 전체" value={`${data.rehabilitations.length}건`} sub={`회생 ${data.rehabilitations.filter(r => r.type === "회생").length} / 파산 ${data.rehabilitations.filter(r => r.type === "파산/면책").length}`} color="#8b5cf6" />
          <KPI label="미납" value={`${data.rehabilitations.filter(r => r.overdueStatus === "미납").length}건`} sub="변제 연체 중" color="#ef4444" />
          <KPI label="폐지" value={`${data.rehabilitations.filter(r => r.dismissed).length}건`} sub="인가 취소/기각" color="#f59e0b" />
        </div>
        {/* 브랜드 필터 */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {["전체", ...config.brands.map(b => b.code)].map(code => {
            const brand = config.brands.find(b => b.code === code);
            const cnt = code === "전체" ? data.rehabilitations.length : data.rehabilitations.filter(r => r.brand === code).length;
            const isActive = rBrand === code;
            return (
              <button key={code} onClick={() => setRBrand(code)} style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 12px", borderRadius: 20, fontSize: 12, fontWeight: isActive ? 700 : 500, background: isActive ? (brand ? brand.color + "22" : "var(--bg)") : "var(--card)", color: isActive ? (brand ? brand.color : "var(--tp)") : "var(--ts)", border: `1px solid ${isActive ? (brand ? brand.color + "60" : "var(--brd)") : "var(--brd)"}`, cursor: "pointer" }}>
                {code === "전체" ? "전체" : brand?.name || code}
                <span className="mono" style={{ fontSize: 11 }}>{cnt}</span>
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", background: "var(--card)", borderRadius: 12, padding: 14, border: "1px solid var(--brd)" }}>
          <div style={{ position: "relative", flex: 1 }}><div style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--tm)" }}><I name="search" size={14} /></div><KoreanInput value={rq} onChange={e => setRq(e.target.value)} placeholder="채무자명, 사건번호, 비고 검색..." style={{ width: "100%", paddingLeft: 32 }} /></div>
          <button onClick={() => setModal({ type: "addRehab" })} style={{ display: "flex", alignItems: "center", gap: 4, padding: "7px 12px", borderRadius: 8, background: "var(--acc)", color: "#fff", fontSize: 12, fontWeight: 600, border: "none", cursor: "pointer", whiteSpace: "nowrap" }}><I name="plus" size={14} />데이터 추가</button>
          <button onClick={() => exportLegal([], filtered, [])} style={{ display: "flex", alignItems: "center", gap: 4, padding: "7px 12px", borderRadius: 8, background: "#10b98118", color: "#10b981", fontSize: 12, fontWeight: 600, border: "1px solid #10b98140" }}><I name="arrowDown" size={14} />엑셀</button>
          <span className="mono" style={{ fontSize: 12, color: "var(--tm)" }}>{filtered.length}건</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map(r => { const _norm = normNameForMatch(r.debtorName); const _findDebtor = () => { let d = r.debtorId ? data.debtors.find(x => x.id === r.debtorId) : null; if (!d && _norm) { const cs = data.debtors.filter(x => normNameForMatch(x.name) === _norm && x.brand === r.brand); d = cs.find(x => x.category === "회생/파산") || cs[0] || null; } return d; }; return (<div key={r.id} style={{ background: "var(--card)", borderRadius: 12, border: `1px solid ${r.overdueStatus === "미납" ? "#ef444430" : "var(--brd)"}`, overflow: "hidden", cursor: "pointer" }} onClick={() => setSelRehab(r)} onMouseEnter={e => e.currentTarget.style.background = "var(--hover)"} onMouseLeave={e => e.currentTarget.style.background = "var(--card)"}><div style={{ padding: "12px 16px", background: r.overdueStatus === "미납" ? "#ef44440a" : "var(--bg2)", borderBottom: "1px solid var(--brd)", display: "flex", justifyContent: "space-between", alignItems: "center" }}><div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}><BrandBadge code={r.brand} brands={config.brands} /><span style={{ fontWeight: 700, fontSize: 14, color: r.debtorId ? "var(--tp)" : "#c0c4cc" }}>{r.debtorName}</span><Badge status={r.type} />{r.creditorNumber && <span style={{ fontSize: 11, color: "var(--tm)" }}>채권번호 {r.creditorNumber}</span>}<span className="mono" style={{ fontSize: 11, color: "var(--ts)" }}>{r.court}</span><span className="mono" style={{ fontSize: 11, color: "var(--ts)" }}>{r.caseNumber}</span></div><div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>{r.overdueStatus === "미납" && <span style={{ fontSize: 11, fontWeight: 700, color: "#b91c1c", padding: "2px 10px", background: "#ef444420", borderRadius: 20, border: "1px solid #ef444440" }}>미납</span>}{r.dismissed && <span style={{ fontSize: 11, fontWeight: 700, color: "#b45309", padding: "2px 10px", background: "#f59e0b20", borderRadius: 20, border: "1px solid #f59e0b40" }}>폐지</span>}{r.planApproved && <span style={{ fontSize: 11, fontWeight: 600, color: "#047857", padding: "2px 10px", background: "#10b98118", borderRadius: 20, border: "1px solid #10b98130" }}>인가</span>}{getCaseUrl(r.id) && <a href={getCaseUrl(r.id)} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 10, background: "#3b82f618", color: "#1d4ed8", border: "1px solid #3b82f630", textDecoration: "none", whiteSpace: "nowrap" }}>문서</a>}<button onClick={e => { e.stopPropagation(); setMatchingRehab(r); setMatchQ(""); }} style={{ fontSize: 11, fontWeight: 600, padding: "2px 10px", borderRadius: 20, border: r.debtorId ? "1px solid var(--brd)" : "1px solid #3b82f660", background: r.debtorId ? "var(--bg)" : "#3b82f618", color: r.debtorId ? "var(--ts)" : "#1d4ed8", cursor: "pointer" }}>{r.debtorId ? "재매칭" : "연결"}</button></div></div><div style={{ padding: "10px 16px", display: "flex", gap: 20, fontSize: 12, flexWrap: "wrap", alignItems: "center" }}>{r.debtAmount > 0 && <span style={{ color: "var(--tm)" }}>채무액 <span className="mono" style={{ fontWeight: 600, color: "var(--tp)" }}>{fmt(r.debtAmount)}</span></span>}{r.approvedAmount > 0 && <span style={{ color: "var(--tm)" }}>승인액 <span className="mono" style={{ fontWeight: 600, color: "var(--ok)" }}>{fmt(r.approvedAmount)}</span></span>}{r.monthlyPayment > 0 && <span style={{ color: "var(--tm)" }}>월상환 <span className="mono" style={{ fontWeight: 600 }}>{fmt(r.monthlyPayment)}</span></span>}{r.currentRound && <span style={{ color: "var(--tm)" }}>회차 <span style={{ fontWeight: 600, color: "var(--tp)" }}>{r.currentRound}</span></span>}{r.repaymentNote && <span style={{ fontSize: 11, color: "var(--ts)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.repaymentNote}</span>}</div></div>); })}
        </div>
      </div>

      {/* 수동 매칭 모달 */}
      {matchingRehab && (
        <div onClick={() => { setMatchingRehab(null); setMatchQ(""); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, padding: 24, width: 520, maxHeight: "80vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>채무자 수동 연결</div>
              <div style={{ fontSize: 12, color: "var(--tm)" }}>
                <span style={{ fontWeight: 600, color: "var(--tp)" }}>{matchingRehab.debtorName}</span>
                {" "}({matchingRehab.caseNumber}) 를 연결할 채무자를 선택하세요
              </div>
              {matchingRehab.debtorId && (
                <div style={{ marginTop: 6, fontSize: 11, color: "var(--ts)" }}>
                  현재 연결: {data.debtors.find(d => d.id === matchingRehab.debtorId)?.name || matchingRehab.debtorId}
                </div>
              )}
            </div>
            <div style={{ position: "relative", marginBottom: 12 }}>
              <div style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--tm)" }}><I name="search" size={14} /></div>
              <KoreanInput autoFocus value={matchQ} onChange={e => setMatchQ(e.target.value)} placeholder="채무자명 또는 ID 검색 (비워두면 회생/파산 목록 표시)..." style={{ width: "100%", paddingLeft: 32 }} />
            </div>
            <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 }}>
              {matchCandidates.length === 0 && <div style={{ padding: 20, textAlign: "center", color: "var(--tm)", fontSize: 13 }}>검색 결과 없음</div>}
              {matchCandidates.map(d => (
                <div key={d.id} onClick={() => handleManualMatch(matchingRehab.id, d.id)}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 8, border: "1px solid var(--brd)", cursor: "pointer", background: d.id === matchingRehab.debtorId ? "#3b82f610" : "transparent" }}
                  onMouseEnter={e => e.currentTarget.style.background = "var(--hover)"}
                  onMouseLeave={e => e.currentTarget.style.background = d.id === matchingRehab.debtorId ? "#3b82f610" : "transparent"}>
                  <BrandBadge code={d.brand} brands={config.brands} />
                  <span style={{ fontWeight: 600, flex: 1 }}>{d.name}</span>
                  <span className="mono" style={{ fontSize: 11, color: "var(--ts)" }}>{d.id}</span>
                  <Badge status={d.category} small />
                  {d.id === matchingRehab.debtorId && <span style={{ fontSize: 11, color: "#3b82f6", fontWeight: 700 }}>현재</span>}
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              {matchingRehab.debtorId && (
                <button onClick={() => handleManualMatch(matchingRehab.id, null)} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca" }}>연결 해제</button>
              )}
              <button onClick={() => { setMatchingRehab(null); setMatchQ(""); }} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "var(--bg)", color: "var(--tm)", border: "1px solid var(--brd)" }}>취소</button>
            </div>
          </div>
        </div>
      )}
      </>
    );
  });

  // ─── 추심의뢰 View ──────────────────────────────────────
  const CollectionView = useStableComponent(() => {
    const orders = data.collectionOrders || [];
    const [brandF,  setBrandF]  = useState("전체");
    const [agencyF, setAgencyF] = useState("전체");
    const [searchQ, setSearchQ] = useState("");
    const [selOrder,      setSelOrder]      = useState(null);
    const [editMode,      setEditMode]      = useState(false);
    const [editFields,    setEditFields]    = useState({});
    const [matchingOrder, setMatchingOrder] = useState(null);
    const [matchQ,        setMatchQ]        = useState("");
    const [collSort,      setCollSort]      = useState({ f: "requestDate", d: "desc" });
    const [showAddForm,   setShowAddForm]   = useState(false);
    const [addFields,     setAddFields]     = useState({ agencyName:"", brandRaw:"B", debtorName:"", requestAmount:"", amountDetail:"", requestDate:"", condition:"", agencyPerson:"", agencyPhone:"", cost:"", activities:"", monthlyUpdates:[], recoveredAmount:"" });
    const [recMode,       setRecMode]       = useState(() => localStorage.getItem("coll_rec_mode") || "auto");
    const [manualRecTotal, setManualRecTotal] = useState(() => Number(localStorage.getItem("coll_rec_manual") || "0"));
    const [editingRec,    setEditingRec]    = useState(false);
    const [editRecInput,  setEditRecInput]  = useState("");

    const agencies = useMemo(() => [...new Set(orders.map(o => o.agencyName).filter(Boolean))], [orders]);

    const filtered = useMemo(() => {
      let l = orders;
      if (brandF  !== "전체") l = l.filter(o => o.brand === brandF);
      if (agencyF !== "전체") l = l.filter(o => o.agencyName === agencyF);
      if (searchQ) {
        const q = searchQ.toLowerCase();
        l = l.filter(o => o.debtorName.toLowerCase().includes(q) || (o.agencyName || "").toLowerCase().includes(q));
      }
      return l;
    }, [orders, brandF, agencyF, searchQ]);

    const sortedOrders = useMemo(() => {
      const { f, d } = collSort;
      return [...filtered].sort((a, b) => {
        let va = a[f], vb = b[f];
        if (typeof va === "number" || typeof vb === "number") {
          return d === "asc" ? (va || 0) - (vb || 0) : (vb || 0) - (va || 0);
        }
        va = String(va || ""); vb = String(vb || "");
        return d === "asc" ? va.localeCompare(vb, "ko") : vb.localeCompare(va, "ko");
      });
    }, [filtered, collSort]);

    const toggleSort = (field) => setCollSort(prev => ({ f: field, d: prev.f === field && prev.d === "asc" ? "desc" : "asc" }));
    const SortBtn = ({ field, label }) => (
      <span onClick={() => toggleSort(field)} style={{ cursor: "pointer", userSelect: "none", display: "inline-flex", alignItems: "center", gap: 3 }}>
        {label}
        <span style={{ fontSize: 10, color: collSort.f === field ? "var(--acc)" : "var(--tm)", lineHeight: 1 }}>
          {collSort.f === field ? (collSort.d === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </span>
    );

    const matchCandidates = useMemo(() => {
      if (!matchingOrder) return [];
      const q = matchQ.toLowerCase().trim();
      const list = q
        ? data.debtors.filter(d => d.name.toLowerCase().includes(q) || d.hubCode?.toLowerCase().includes(q))
        : data.debtors.filter(d => d.category === "추심의뢰").slice(0, 30);
      return list.slice(0, 30);
    }, [matchQ, matchingOrder, data.debtors]);

    const getDebtor = (id) => id ? data.debtors.find(d => d.id === id) : null;

    const handleManualMatch = (orderId, debtorId) => {
      saveCollectionOv(orderId, debtorId);
      setData(prev => ({ ...prev, collectionOrders: prev.collectionOrders.map(o => o.id === orderId ? { ...o, debtorId } : o) }));
      if (selOrder?.id === orderId) setSelOrder(prev => ({ ...prev, debtorId }));
      setMatchingOrder(null); setMatchQ("");
      showToast(debtorId ? "수동 매칭 완료" : "연결 해제됨");
    };

    const handleSaveEdit = () => {
      saveCollectionEdit(selOrder.id, editFields);
      const updated = { ...selOrder, ...editFields };
      setData(prev => ({ ...prev, collectionOrders: prev.collectionOrders.map(o => o.id === selOrder.id ? updated : o) }));
      setSelOrder(updated);
      setEditMode(false); setEditFields({});
      showToast("저장 완료");
    };

    const handleAddOrder = () => {
      if (!addFields.debtorName.trim()) { showToast("채무자명을 입력하세요"); return; }
      const BRAND_RAW_TO_CODE = { "바로고":"B","딜버":"D","모아라인":"M","바다코리아":"M","그라이더":"G","에이퍼스":"E","A2":"A2" };
      const newOrder = {
        ...addFields,
        id: uid("CO_M_"),
        brand: BRAND_RAW_TO_CODE[addFields.brandRaw] || addFields.brandRaw,
        requestAmount:  Number(addFields.requestAmount)  || 0,
        recoveredAmount: Number(addFields.recoveredAmount) || 0,
        debtorId: null,
        createdBy: currentUser?.id,
        createdAt: today(),
      };
      const manual = getCollectionManual();
      saveCollectionManual([...manual, newOrder]);
      setData(prev => ({ ...prev, collectionOrders: [...prev.collectionOrders, newOrder] }));
      setShowAddForm(false);
      setAddFields({ agencyName:"", brandRaw:"B", debtorName:"", requestAmount:"", amountDetail:"", requestDate:"", condition:"", agencyPerson:"", agencyPhone:"", cost:"", activities:"", monthlyUpdates:[], recoveredAmount:"" });
      showToast("추심의뢰 추가 완료");
    };

    const handleDeleteOrder = (order) => {
      if (!confirm(`"${order.debtorName}" 추심의뢰를 삭제하시겠습니까?`)) return;
      addCollectionDeleted(order.id);
      const manual = getCollectionManual();
      saveCollectionManual(manual.filter(o => o.id !== order.id));
      setData(prev => ({ ...prev, collectionOrders: prev.collectionOrders.filter(o => o.id !== order.id) }));
      setSelOrder(null);
      showToast("삭제 완료");
    };

    // collectedAmount는 채무자 단위 누적값이라, 같은 채무자에 매칭된 추심의뢰가 2건 이상이면
    // 채무자별로 한 번만 합산해야 한다 (그러지 않으면 중복 매칭될수록 회수금액이 배로 커진다).
    const seenRecDebtorIds = new Set();
    const autoTotalRec = orders.reduce((s, o) => {
      if (!o.debtorId || seenRecDebtorIds.has(o.debtorId)) return s;
      seenRecDebtorIds.add(o.debtorId);
      const d = getDebtor(o.debtorId);
      return s + (d?.collectedAmount || 0);
    }, 0);
    const kpiTotalRec = recMode === "manual" ? manualRecTotal : autoTotalRec;

    // 팝업에서 현재 값 (편집 중이면 editFields 우선)
    const cur = (key) => editMode ? (editFields[key] !== undefined ? editFields[key] : selOrder?.[key]) : selOrder?.[key];
    const setF = (k, v) => setEditFields(prev => ({ ...prev, [k]: v }));

    const inpS = { padding: "5px 8px", fontSize: 12, borderRadius: 6, border: "1px solid var(--brd)", background: "var(--card)", color: "var(--tp)", width: "100%" };
    const DL = ({ label, val, children }) => (val || children) ? (
      <div style={{ display: "flex", gap: 8, fontSize: 13, padding: "5px 0", borderBottom: "1px solid var(--brd)" }}>
        <span style={{ color: "var(--tm)", minWidth: 120, flexShrink: 0 }}>{label}</span>
        <span style={{ color: "var(--tp)", fontWeight: 500, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{children || val}</span>
      </div>
    ) : null;

    return (
      <>
      <div className="anim" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* KPI */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <KPI label="총 추심의뢰" value={`${orders.length}건`} sub={`추심업체 ${agencies.length}곳`} color="#3b82f6" />
          <div style={{ background: "var(--card)", borderRadius: 12, padding: 20, border: "1px solid var(--brd)", position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "linear-gradient(90deg,#10b981,#10b98100)" }} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
              <div style={{ fontSize: 12, color: "var(--tm)", fontWeight: 500 }}>
                회수금액
                <span style={{ marginLeft: 6, fontSize: 10, padding: "1px 6px", borderRadius: 8, background: recMode === "auto" ? "#eff6ff" : "#fefce8", color: recMode === "auto" ? "#1d4ed8" : "#92400e", border: `1px solid ${recMode === "auto" ? "#bfdbfe" : "#fde68a"}` }}>
                  {recMode === "auto" ? "자동(슬랙)" : "수동"}
                </span>
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                {editingRec ? (
                  <>
                    <button onClick={() => {
                      const v = Number(String(editRecInput).replace(/,/g, "")) || 0;
                      setManualRecTotal(v); setRecMode("manual");
                      localStorage.setItem("coll_rec_mode", "manual");
                      localStorage.setItem("coll_rec_manual", String(v));
                      setEditingRec(false);
                    }} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 5, background: "#10b981", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600 }}>저장</button>
                    <button onClick={() => setEditingRec(false)} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 5, background: "var(--bg2)", color: "var(--tm)", border: "1px solid var(--brd)", cursor: "pointer" }}>취소</button>
                  </>
                ) : (
                  <>
                    <button onClick={() => { setEditRecInput(String(kpiTotalRec)); setEditingRec(true); }} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 5, background: "var(--bg2)", color: "var(--tm)", border: "1px solid var(--brd)", cursor: "pointer" }}>수정</button>
                    {recMode === "manual" && (
                      <button onClick={() => { setRecMode("auto"); localStorage.setItem("coll_rec_mode", "auto"); }} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 5, background: "#eff6ff", color: "#1d4ed8", border: "1px solid #bfdbfe", cursor: "pointer" }}>자동</button>
                    )}
                  </>
                )}
              </div>
            </div>
            {editingRec ? (
              <MoneyInput value={editRecInput} onChange={v => setEditRecInput(v)} style={{ padding: "5px 8px", fontSize: 16, borderRadius: 6, border: "1px solid var(--brd)", background: "var(--card)", color: "var(--tp)", width: "100%", marginBottom: 4 }} />
            ) : (
              <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: "#10b981", marginBottom: 4 }}>{fmt(kpiTotalRec)}</div>
            )}
            <div style={{ fontSize: 11, color: "var(--ts)" }}>{recMode === "auto" ? "연동 채무자 입금 자동 집계" : "수동 입력값"}</div>
          </div>
        </div>

        {/* 필터 */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select value={brandF} onChange={e => setBrandF(e.target.value)} style={{ padding: "7px 10px", borderRadius: 8, fontSize: 12, border: "1px solid var(--brd)", background: "var(--card)", color: "var(--tp)" }}>
            <option value="전체">전체 브랜드</option>
            {config.brands.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}
            <option value="E">에이퍼스</option>
            <option value="A2">A2</option>
          </select>
          <select value={agencyF} onChange={e => setAgencyF(e.target.value)} style={{ padding: "7px 10px", borderRadius: 8, fontSize: 12, border: "1px solid var(--brd)", background: "var(--card)", color: "var(--tp)" }}>
            <option value="전체">전체 업체</option>
            {agencies.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <div style={{ position: "relative", flex: 1, minWidth: 180 }}>
            <div style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--tm)" }}><I name="search" size={14} /></div>
            <KoreanInput value={searchQ} onChange={e => setSearchQ(e.target.value)} placeholder="채무자명·업체명 검색" style={{ width: "100%", padding: "7px 10px 7px 30px", borderRadius: 8, fontSize: 12, border: "1px solid var(--brd)", background: "var(--card)", color: "var(--tp)" }} />
          </div>
          <span className="mono" style={{ fontSize: 12, color: "var(--tm)" }}>{filtered.length}건</span>
          {canEdit && (
            <button onClick={() => setShowAddForm(true)} style={{ display: "flex", alignItems: "center", gap: 5, padding: "7px 14px", borderRadius: 8, background: "var(--acc)", color: "#fff", fontSize: 12, fontWeight: 600, border: "none", cursor: "pointer", flexShrink: 0 }}>
              <I name="plus" size={14} /> 데이터 추가
            </button>
          )}
        </div>

        {/* 정렬 헤더 */}
        <div style={{ display: "flex", gap: 12, padding: "6px 16px", background: "var(--bg2)", borderRadius: 8, fontSize: 11, color: "var(--tm)", fontWeight: 600, border: "1px solid var(--brd)" }}>
          <span style={{ minWidth: 22 }}></span>
          <span style={{ minWidth: 100 }}><SortBtn field="debtorName" label="채무자" /></span>
          <span style={{ minWidth: 90 }}><SortBtn field="agencyName" label="추심업체" /></span>
          <span style={{ minWidth: 90 }}><SortBtn field="requestDate" label="요청일" /></span>
          <span style={{ minWidth: 110 }}><SortBtn field="requestAmount" label="요청금액" /></span>
          <span style={{ minWidth: 100 }}>회수금액</span>
          <span style={{ flex: 1 }}>최근 현황</span>
          <span style={{ minWidth: 50 }}>연동</span>
        </div>

        {/* 리스트 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {sortedOrders.length === 0 && <div style={{ padding: 40, textAlign: "center", color: "var(--tm)", background: "var(--card)", borderRadius: 12, border: "1px solid var(--brd)" }}>조건에 맞는 추심의뢰 없음</div>}
          {sortedOrders.map(o => {
            const debtor = getDebtor(o.debtorId);
            const lastUpdate = o.monthlyUpdates?.slice(-1)[0];
            return (
              <div key={o.id}
                onClick={() => { setSelOrder(o); setEditMode(false); setEditFields({}); }}
                style={{ background: "var(--card)", borderRadius: 12, border: "1px solid var(--brd)", padding: "12px 16px", cursor: "pointer", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}
                onMouseEnter={e => e.currentTarget.style.background = "var(--hover)"}
                onMouseLeave={e => e.currentTarget.style.background = "var(--card)"}
              >
                <BrandBadge code={o.brand || o.brandRaw?.slice(0,2)} brands={config.brands} />
                <div style={{ minWidth: 100 }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{o.debtorName}</div>
                  <div style={{ fontSize: 11, color: "var(--ts)" }}>{o.brandRaw}</div>
                </div>
                <div style={{ fontSize: 12, color: "var(--tm)", minWidth: 90 }}>{o.agencyName}</div>
                <div style={{ fontSize: 11, color: "var(--ts)", minWidth: 90 }}>{o.requestDate}</div>
                <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: "var(--ok)", minWidth: 110 }}>{fmt(o.requestAmount)}</span>
                {(() => { const d = getDebtor(o.debtorId); const ra = d?.collectedAmount || o.recoveredAmount || 0; return <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: ra > 0 ? "#3b82f6" : "var(--ts)", minWidth: 100 }}>{ra > 0 ? fmt(ra) : "-"}</span>; })()}
                <div style={{ flex: 1, fontSize: 11, color: "var(--ts)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                  {lastUpdate && <><span style={{ color: "var(--tm)", fontWeight: 600 }}>{lastUpdate.month} </span>{lastUpdate.content.split('\n')[0]}</>}
                </div>
                <span style={{ minWidth: 50, flexShrink: 0, textAlign: "right" }}>
                  {debtor
                    ? <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: "#10b98118", color: "#047857", border: "1px solid #10b98130" }}>연동됨</span>
                    : <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a" }}>미연동</span>}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* 상세 팝업 */}
      {selOrder && (
        <Overlay onClose={() => { setSelOrder(null); setEditMode(false); setEditFields({}); }} wide>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <BrandBadge code={selOrder.brand || selOrder.brandRaw?.slice(0,2)} brands={config.brands} />
              <span style={{ fontSize: 17, fontWeight: 700 }}>{selOrder.debtorName}</span>
              <span style={{ fontSize: 12, color: "var(--tm)" }}>{selOrder.agencyName}</span>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              {!editMode
                ? <button onClick={() => { setEditMode(true); setEditFields({}); }} style={{ fontSize: 11, padding: "4px 12px", borderRadius: 6, background: "var(--bg2)", color: "var(--tm)", border: "1px solid var(--brd)", cursor: "pointer" }}>수정</button>
                : <>
                    <button onClick={handleSaveEdit} style={{ fontSize: 11, padding: "4px 12px", borderRadius: 6, background: "var(--acc)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600 }}>저장</button>
                    <button onClick={() => { setEditMode(false); setEditFields({}); }} style={{ fontSize: 11, padding: "4px 12px", borderRadius: 6, background: "var(--bg2)", color: "var(--tm)", border: "1px solid var(--brd)", cursor: "pointer" }}>취소</button>
                  </>
              }
              <button onClick={() => { setSelOrder(null); setEditMode(false); setEditFields({}); }} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--tm)", padding: 4 }}><I name="close" size={18} /></button>
            </div>
          </div>

          {/* 기본 정보 */}
          <div style={{ background: "var(--bg)", borderRadius: 10, padding: "12px 16px", marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--tm)", marginBottom: 8 }}>기본 정보</div>
            <DL label="추심업체"   val={selOrder.agencyName} />
            <DL label="브랜드"     val={selOrder.brandRaw} />
            <DL label="채무자"     val={selOrder.debtorName} />
            <DL label="추심요청 금액"><span className="mono" style={{ fontWeight: 600, color: "var(--ok)" }}>{fmt(selOrder.requestAmount)}</span></DL>
            {selOrder.amountDetail && <DL label="금액 상세" val={selOrder.amountDetail} />}
            <DL label="추심요청일" val={selOrder.requestDate} />
            <DL label="조건"       val={selOrder.condition} />
            <DL label="담당자"     val={selOrder.agencyPerson} />
            <DL label="연락처"     val={selOrder.agencyPhone} />
            {editMode
              ? <div style={{ display: "flex", gap: 8, padding: "5px 0", borderBottom: "1px solid var(--brd)", fontSize: 13 }}>
                  <span style={{ color: "var(--tm)", minWidth: 120, flexShrink: 0 }}>소요비용</span>
                  <KoreanTextarea value={cur("cost") || ""} onChange={e => setF("cost", e.target.value)} rows={2} style={{ ...inpS, resize: "vertical" }} />
                </div>
              : <DL label="소요비용" val={selOrder.cost} />
            }
          </div>

          {/* 활동사항 */}
          <div style={{ background: "var(--bg)", borderRadius: 10, padding: "12px 16px", marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--tm)", marginBottom: 8 }}>활동사항</div>
            {editMode
              ? <KoreanTextarea value={cur("activities") || ""} onChange={e => setF("activities", e.target.value)} rows={4} style={{ ...inpS, resize: "vertical" }} />
              : <div style={{ fontSize: 13, color: "var(--tp)", whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{selOrder.activities || "-"}</div>
            }
          </div>

          {/* 월별 추심현황 */}
          {((editMode ? cur("monthlyUpdates") : selOrder.monthlyUpdates) || []).length > 0 || editMode ? (
            <div style={{ background: "var(--bg)", borderRadius: 10, padding: "12px 16px", marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--tm)" }}>월별 추심현황</div>
                {editMode && (
                  <button onClick={() => {
                    const prev = cur("monthlyUpdates") || selOrder.monthlyUpdates || [];
                    setF("monthlyUpdates", [...prev, { month: "", content: "" }]);
                  }} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 5, background: "#eff6ff", color: "#1d4ed8", border: "1px solid #bfdbfe", cursor: "pointer" }}>+ 추가</button>
                )}
              </div>
              {editMode
                ? (cur("monthlyUpdates") || selOrder.monthlyUpdates || []).map((mu, i) => (
                    <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "flex-start" }}>
                      <KoreanInput value={mu.month} onChange={e => {
                        const arr = [...(cur("monthlyUpdates") || selOrder.monthlyUpdates)];
                        arr[i] = { ...arr[i], month: e.target.value };
                        setF("monthlyUpdates", arr);
                      }} placeholder="YYYY.MM" style={{ ...inpS, width: 90, flexShrink: 0 }} />
                      <KoreanTextarea value={mu.content} onChange={e => {
                        const arr = [...(cur("monthlyUpdates") || selOrder.monthlyUpdates)];
                        arr[i] = { ...arr[i], content: e.target.value };
                        setF("monthlyUpdates", arr);
                      }} rows={2} style={{ ...inpS, flex: 1, resize: "vertical" }} />
                      <button onClick={() => {
                        const arr = (cur("monthlyUpdates") || selOrder.monthlyUpdates).filter((_, ri) => ri !== i);
                        setF("monthlyUpdates", arr);
                      }} style={{ padding: "4px 8px", borderRadius: 5, background: "#fef2f2", color: "#ef4444", border: "1px solid #fecaca", cursor: "pointer", flexShrink: 0 }}>×</button>
                    </div>
                  ))
                : selOrder.monthlyUpdates?.map((mu, i) => (
                    <div key={i} style={{ display: "flex", gap: 10, padding: "6px 0", borderBottom: "1px solid var(--brd)", fontSize: 13 }}>
                      <span style={{ color: "var(--acc)", fontWeight: 700, flexShrink: 0, minWidth: 70 }}>{mu.month}</span>
                      <span style={{ color: "var(--tp)", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{mu.content}</span>
                    </div>
                  ))
              }
            </div>
          ) : null}

          {/* 회수현황 */}
          <div style={{ background: "var(--bg)", borderRadius: 10, padding: "12px 16px", marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--tm)" }}>회수현황</div>
              {getDebtor(selOrder.debtorId)?.collectedAmount > 0 && (
                <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 8, background: "#eff6ff", color: "#1d4ed8", border: "1px solid #bfdbfe" }}>입금내역 자동</span>
              )}
            </div>
            {editMode
              ? <MoneyInput value={String(cur("recoveredAmount") ?? selOrder.recoveredAmount ?? 0)} onChange={v => setF("recoveredAmount", Number(v) || 0)} style={{ ...inpS, maxWidth: 200 }} />
              : (() => {
                  const autoRec = getDebtor(selOrder.debtorId)?.collectedAmount || 0;
                  const manualRec = selOrder.recoveredAmount || 0;
                  const displayRec = autoRec || manualRec;
                  return (
                    <div>
                      <span className="mono" style={{ fontSize: 14, fontWeight: 700, color: displayRec > 0 ? "#3b82f6" : "var(--tm)" }}>
                        {displayRec > 0 ? fmt(displayRec) : "미회수"}
                      </span>
                      {autoRec > 0 && manualRec > 0 && autoRec !== manualRec && (
                        <div style={{ fontSize: 11, color: "var(--ts)", marginTop: 4 }}>수동입력: {fmt(manualRec)}</div>
                      )}
                    </div>
                  );
                })()
            }
          </div>

          {/* 채무자 연동 */}
          <div style={{ background: "var(--bg)", borderRadius: 10, padding: "12px 16px", marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--tm)" }}>채무자 연동</div>
              <button onClick={() => { setMatchingOrder(selOrder); setMatchQ(""); }} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 5, background: "var(--bg2)", color: "var(--ts)", border: "1px solid var(--brd)", cursor: "pointer" }}>
                {selOrder.debtorId ? "재매칭" : "연결"}
              </button>
            </div>
            {(() => {
              const debtor = getDebtor(selOrder.debtorId);
              return debtor ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <DL label="이름"     val={debtor.name} />
                  <DL label="브랜드"   val={debtor.brandName || debtor.brand} />
                  <DL label="분류"     val={debtor.category} />
                  <DL label="담당자"   val={debtor.assignee} />
                  <DL label="잔액(법무)" val={fmt(debtor.finalBalanceLegal)} />
                </div>
              ) : (
                <div style={{ fontSize: 13, color: "var(--tm)", padding: "4px 0" }}>채무자 관리와 연결되지 않음</div>
              );
            })()}
          </div>

          <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center" }}>
            <div>
              {canDeleteRecord(selOrder) && (
                <button onClick={() => handleDeleteOrder(selOrder)}
                  style={{ display: "flex", alignItems: "center", gap: 5, padding: "8px 16px", borderRadius: 8, background: "#fef2f2", color: "#b91c1c", fontSize: 13, fontWeight: 600, border: "1px solid #fecaca", cursor: "pointer" }}>
                  <I name="trash" size={13} /> 삭제
                </button>
              )}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {getDebtor(selOrder.debtorId) && (
                <button onClick={() => { setSel(getDebtor(selOrder.debtorId)); setTab("debtors"); setSelOrder(null); }}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, background: "#3b82f6", color: "#fff", fontSize: 13, fontWeight: 600, border: "none", cursor: "pointer" }}>
                  <I name="users" size={14} /> 채무자 페이지로 가기
                </button>
              )}
              <button onClick={() => { setSelOrder(null); setEditMode(false); setEditFields({}); }}
                style={{ padding: "8px 16px", borderRadius: 8, background: "var(--bg2)", color: "var(--tp)", fontSize: 13, border: "1px solid var(--brd)", cursor: "pointer" }}>닫기</button>
            </div>
          </div>
        </Overlay>
      )}

      {/* 수동 매칭 모달 */}
      {matchingOrder && (
        <div onClick={() => { setMatchingOrder(null); setMatchQ(""); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "var(--card)", borderRadius: 16, padding: 24, width: 520, maxHeight: "80vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>채무자 수동 연결</div>
              <div style={{ fontSize: 12, color: "var(--tm)" }}>
                <span style={{ fontWeight: 600, color: "var(--tp)" }}>{matchingOrder.debtorName}</span> ({matchingOrder.agencyName})를 연결할 채무자를 선택하세요
              </div>
              {matchingOrder.debtorId && (
                <div style={{ fontSize: 11, color: "var(--ts)", marginTop: 4 }}>
                  현재 연결: {data.debtors.find(d => d.id === matchingOrder.debtorId)?.name || matchingOrder.debtorId}
                </div>
              )}
            </div>
            <div style={{ position: "relative", marginBottom: 10 }}>
              <div style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--tm)" }}><I name="search" size={14} /></div>
              <KoreanInput autoFocus value={matchQ} onChange={e => setMatchQ(e.target.value)} placeholder="채무자명 검색…" style={{ width: "100%", paddingLeft: 32, padding: "8px 10px 8px 32px", borderRadius: 8, border: "1px solid var(--brd)", background: "var(--bg)", fontSize: 12, color: "var(--tp)" }} />
            </div>
            <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 }}>
              {matchCandidates.length === 0 && <div style={{ padding: 20, textAlign: "center", color: "var(--tm)", fontSize: 13 }}>검색 결과 없음</div>}
              {matchCandidates.map(d => (
                <div key={d.id} onClick={() => handleManualMatch(matchingOrder.id, d.id)}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 8, border: "1px solid var(--brd)", cursor: "pointer", background: d.id === matchingOrder.debtorId ? "#3b82f610" : "transparent" }}
                  onMouseEnter={e => e.currentTarget.style.background = "var(--hover)"}
                  onMouseLeave={e => e.currentTarget.style.background = d.id === matchingOrder.debtorId ? "#3b82f610" : "transparent"}>
                  <BrandBadge code={d.brand} brands={config.brands} />
                  <span style={{ fontWeight: 600, flex: 1 }}>{d.name}</span>
                  <span className="mono" style={{ fontSize: 11, color: "var(--ts)" }}>{d.hubCode}</span>
                  <Badge status={d.category} small />
                  {d.id === matchingOrder.debtorId && <span style={{ fontSize: 11, color: "#3b82f6", fontWeight: 700 }}>현재</span>}
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              {matchingOrder.debtorId && <button onClick={() => handleManualMatch(matchingOrder.id, null)} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca", cursor: "pointer" }}>연결 해제</button>}
              <button onClick={() => { setMatchingOrder(null); setMatchQ(""); }} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, background: "var(--bg)", color: "var(--tm)", border: "1px solid var(--brd)", cursor: "pointer" }}>취소</button>
            </div>
          </div>
        </div>
      )}

      {/* 데이터 추가 폼 */}
      {showAddForm && (
        <div onClick={() => setShowAddForm(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "var(--card)", borderRadius: 16, padding: 28, width: 600, maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <div style={{ fontSize: 16, fontWeight: 700 }}>추심의뢰 추가</div>
              <button onClick={() => setShowAddForm(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--tm)" }}><I name="close" size={18} /></button>
            </div>
            {(() => {
              const fS = { padding: "8px 10px", fontSize: 13, borderRadius: 8, border: "1px solid var(--brd)", background: "var(--bg)", color: "var(--tp)", width: "100%", boxSizing: "border-box" };
              const AF = addFields;
              const setAF = (k, v) => setAddFields(p => ({ ...p, [k]: v }));
              const LI = ({ label, children }) => (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: 11, color: "var(--tm)", fontWeight: 600 }}>{label}</span>
                  {children}
                </div>
              );
              const BRAND_OPTS = [
                { code: "B", name: "바로고" }, { code: "D", name: "딜버" },
                { code: "M", name: "모아라인/바다코리아" }, { code: "G", name: "그라이더" },
                { code: "E", name: "에이퍼스" }, { code: "A2", name: "A2" },
              ];
              return (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <LI label="추심업체 *"><KoreanInput value={AF.agencyName} onChange={e => setAF("agencyName", e.target.value)} placeholder="추심업체명" style={fS} /></LI>
                    <LI label="브랜드">
                      <select value={AF.brandRaw} onChange={e => setAF("brandRaw", e.target.value)} style={fS}>
                        {BRAND_OPTS.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}
                      </select>
                    </LI>
                    <LI label="채무자명 *"><KoreanInput value={AF.debtorName} onChange={e => setAF("debtorName", e.target.value)} placeholder="채무자 이름" style={fS} /></LI>
                    <LI label="추심요청일"><input type="text" value={AF.requestDate} onChange={e => setAF("requestDate", e.target.value)} placeholder="YYYY.MM.DD" style={fS} /></LI>
                    <LI label="추심요청금액 (원)"><MoneyInput value={AF.requestAmount} onChange={v => setAF("requestAmount", v)} placeholder="0" style={fS} /></LI>
                    <LI label="회수금액 (원)"><MoneyInput value={AF.recoveredAmount} onChange={v => setAF("recoveredAmount", v)} placeholder="0" style={fS} /></LI>
                    <LI label="담당자"><KoreanInput value={AF.agencyPerson} onChange={e => setAF("agencyPerson", e.target.value)} placeholder="담당자명" style={fS} /></LI>
                    <LI label="연락처"><KoreanInput value={AF.agencyPhone} onChange={e => setAF("agencyPhone", e.target.value)} placeholder="전화번호" style={fS} /></LI>
                  </div>
                  <LI label="조건"><KoreanInput value={AF.condition} onChange={e => setAF("condition", e.target.value)} placeholder="추심 조건" style={fS} /></LI>
                  <LI label="금액 상세"><KoreanTextarea value={AF.amountDetail} onChange={e => setAF("amountDetail", e.target.value)} rows={2} placeholder="원금, 이자 등 구성 내역" style={{ ...fS, resize: "vertical" }} /></LI>
                  <LI label="소요비용"><KoreanInput value={AF.cost} onChange={e => setAF("cost", e.target.value)} placeholder="비용 내역" style={fS} /></LI>
                  <LI label="활동사항"><KoreanTextarea value={AF.activities} onChange={e => setAF("activities", e.target.value)} rows={3} placeholder="주요 활동 내역" style={{ ...fS, resize: "vertical" }} /></LI>
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <span style={{ fontSize: 11, color: "var(--tm)", fontWeight: 600 }}>월별 추심현황</span>
                      <button onClick={() => setAF("monthlyUpdates", [...(AF.monthlyUpdates || []), { month: "", content: "" }])}
                        style={{ fontSize: 11, padding: "3px 10px", borderRadius: 6, background: "#eff6ff", color: "#1d4ed8", border: "1px solid #bfdbfe", cursor: "pointer" }}>+ 행 추가</button>
                    </div>
                    {(AF.monthlyUpdates || []).map((mu, i) => (
                      <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "flex-start" }}>
                        <KoreanInput value={mu.month} onChange={e => { const arr = [...AF.monthlyUpdates]; arr[i] = { ...arr[i], month: e.target.value }; setAF("monthlyUpdates", arr); }} placeholder="YYYY.MM" style={{ ...fS, width: 90, flexShrink: 0 }} />
                        <KoreanTextarea value={mu.content} onChange={e => { const arr = [...AF.monthlyUpdates]; arr[i] = { ...arr[i], content: e.target.value }; setAF("monthlyUpdates", arr); }} rows={2} style={{ ...fS, flex: 1, resize: "vertical" }} />
                        <button onClick={() => setAF("monthlyUpdates", AF.monthlyUpdates.filter((_, ri) => ri !== i))} style={{ padding: "4px 8px", borderRadius: 5, background: "#fef2f2", color: "#ef4444", border: "1px solid #fecaca", cursor: "pointer", flexShrink: 0 }}>×</button>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
                    <button onClick={() => setShowAddForm(false)} style={{ padding: "8px 20px", borderRadius: 8, fontSize: 13, background: "var(--bg2)", color: "var(--tp)", border: "1px solid var(--brd)", cursor: "pointer" }}>취소</button>
                    <button onClick={handleAddOrder} style={{ padding: "8px 20px", borderRadius: 8, fontSize: 13, fontWeight: 700, background: "var(--acc)", color: "#fff", border: "none", cursor: "pointer" }}>추가</button>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}
      </>
    );
  });

  // ─── 미매칭 대기열 View ──────────────────────────────────
  const PendingPaymentsView = useStableComponent(({ refreshKey }) => {
    const [items, setItems] = useState([]);
    const [loadingList, setLoadingList] = useState(true);
    const [resolving, setResolving] = useState(null);
    const [selectedDebtor, setSelectedDebtor] = useState({});
    const [debtorSearch, setDebtorSearch] = useState({});
    const [learnedMap, setLearnedMap] = useState({}); // { payerName → { debtor_id, debtor_name, resolved_count } }
    const [showMappings, setShowMappings] = useState(false);
    const [checkedIds, setCheckedIds] = useState(new Set());

    const loadPending = async () => {
      try {
        const [r1, r2] = await Promise.all([
          fetch("/api/pending-payments"),
          fetch("/api/payer-mappings"),
        ]);
        const pendingData = await r1.json();
        const mappingData = await r2.json();

        // 학습 매핑을 Map으로 변환
        const lm = {};
        for (const m of mappingData) lm[m.payer_name] = m;
        setLearnedMap(lm);

        setItems(pendingData);
        setPendingCount(pendingData.length);

        // 학습된 매핑이 있는 항목은 채무자 미리 선택
        const preSelected = {};
        for (const item of pendingData) {
          if (lm[item.payer_name]) preSelected[item.id] = lm[item.payer_name].debtor_id;
        }
        setSelectedDebtor(preSelected);
      } catch (e) {}
      setLoadingList(false);
    };
    useEffect(() => { loadPending(); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
    // items가 바뀔 때마다 pendingCount를 여기서 파생시킨다 — 여러 항목을 동시에 처리할 때
    // 각 핸들러가 오래된 items 클로저를 기준으로 직접 길이를 계산해 덮어쓰면 방금 처리된
    // 항목이 되살아나거나 카운트가 어긋날 수 있다.
    useEffect(() => { setPendingCount(items.length); }, [items.length]); // eslint-disable-line react-hooks/exhaustive-deps

    const getFiltered = (srch) => {
      if (!srch) return [];
      const q = srch.toLowerCase();
      return data.debtors
        .filter(d => (d.name || "").toLowerCase().includes(q) || (d.hubName || "").toLowerCase().includes(q) || (d.id || "").toLowerCase().includes(q))
        .slice(0, 8);
    };

    const doResolve = async (item) => {
      const dId = selectedDebtor[item.id];
      if (!dId) { showToast("채무자를 선택하세요"); return; }
      const d = data.debtors.find(x => x.id === dId);
      if (!confirm(`"${item.payer_name}" 입금 ${fmt(item.total_amount)}을\n${d?.name}(${dId})에 연결합니까?\n잔액이 자동 차감되고, 이 입금자명은 기억됩니다.`)) return;
      setResolving(item.id);
      try {
        const res = await fetch(`/api/pending-payments/${item.id}/resolve`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ debtorId: dId, createdByName: currentUser?.name }),
        });
        const result = await res.json();
        if (result.ok) {
          const autoMsg = result.autoResolved > 0 ? ` + 동일 입금자 ${result.autoResolved}건 자동처리` : "";
          showToast(`✓ 연결 완료: ${result.debtorName} — 잔액 ${fmt(result.balanceAfter)}${autoMsg}`);
          // 같은 payer_name인 항목도 목록에서 제거
          const removedNames = new Set([item.payer_name]);
          setItems(prev => prev.filter(x => !removedNames.has(x.payer_name)));
          // 학습 매핑 갱신
          setLearnedMap(prev => ({ ...prev, [item.payer_name]: { payer_name: item.payer_name, debtor_id: dId, debtor_name: d?.name, resolved_count: (prev[item.payer_name]?.resolved_count || 0) + 1 } }));
          await reloadFromBackend();
        } else {
          showToast(`오류: ${result.error}`);
        }
      } catch (e) { showToast(e.message); }
      setResolving(null);
    };

    const doDiscard = async (item) => {
      if (!confirm(`"${item.payer_name}" ${fmt(item.total_amount)} 항목을 삭제할까요?`)) return;
      try {
        await fetch(`/api/pending-payments/${item.id}`, { method: "DELETE" });
        setItems(prev => prev.filter(x => x.id !== item.id));
        setCheckedIds(prev => { const n = new Set(prev); n.delete(item.id); return n; });
        showToast("삭제됨");
      } catch (e) { showToast(e.message); }
    };

    const doBulkDelete = async () => {
      if (checkedIds.size === 0) return;
      if (!confirm(`선택한 ${checkedIds.size}건을 삭제할까요?`)) return;
      try {
        await Promise.all([...checkedIds].map(id => fetch(`/api/pending-payments/${id}`, { method: "DELETE" })));
        setItems(prev => prev.filter(x => !checkedIds.has(x.id)));
        setCheckedIds(new Set());
        showToast(`${checkedIds.size}건 삭제됨`);
      } catch (e) { showToast(e.message); }
    };

    const doDeleteMapping = async (payerName) => {
      if (!confirm(`"${payerName}" 학습 매핑을 삭제할까요?\n앞으로 이 입금자는 다시 수동 연결이 필요합니다.`)) return;
      try {
        await fetch(`/api/payer-mappings/${encodeURIComponent(payerName)}`, { method: "DELETE" });
        setLearnedMap(prev => { const n = { ...prev }; delete n[payerName]; return n; });
        showToast("매핑 삭제됨");
      } catch (e) { showToast(e.message); }
    };

    const learnedPendingItems = items.filter(x => learnedMap[x.payer_name]);
    const unlearnedItems = items.filter(x => !learnedMap[x.payer_name]);
    const totalAmt = unlearnedItems.reduce((s, x) => s + (x.total_amount || 0), 0);
    const learnedList = Object.values(learnedMap);

    const doResolveAll = async () => {
      if (learnedPendingItems.length === 0) return;
      if (!confirm(`학습 매핑된 ${learnedPendingItems.length}건을 일괄 연결할까요?`)) return;
      let ok = 0;
      for (const item of learnedPendingItems) {
        const mapping = learnedMap[item.payer_name];
        if (!mapping) continue;
        try {
          const res = await fetch(`/api/pending-payments/${item.id}/resolve`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ debtorId: mapping.debtor_id, createdByName: currentUser?.name }),
          });
          if ((await res.json()).ok) ok++;
        } catch {}
      }
      showToast(`${ok}건 일괄 연결 완료`);
      await loadPending();
      await reloadFromBackend();
    };

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* 대기열 목록 */}
        <div style={{ background: "var(--card)", borderRadius: 12, padding: 20, border: "1px solid var(--brd)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>⏳ 미매칭 대기열 ({unlearnedItems.length}건)</div>
              <div style={{ fontSize: 12, color: "var(--tm)" }}>
                합계 <span className="mono" style={{ fontWeight: 700, color: "var(--acc)" }}>{fmt(totalAmt)}</span>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {checkedIds.size > 0 && canEdit && (
                <button onClick={doBulkDelete} style={{ fontSize: 12, padding: "5px 12px", borderRadius: 6, background: "#ef444415", color: "var(--err)", border: "1px solid #ef444430", fontWeight: 600, cursor: "pointer" }}>
                  <I name="trash" size={12} /> 선택 삭제 ({checkedIds.size})
                </button>
              )}
              <button onClick={() => setShowMappings(p => !p)} style={{ fontSize: 11, padding: "5px 10px", borderRadius: 6, background: "#7c3aed18", color: "#7c3aed", border: "1px solid #7c3aed30", fontWeight: 600 }}>
                🧠 학습 매핑 {learnedList.length}개{learnedPendingItems.length > 0 ? ` · 대기 ${learnedPendingItems.length}건` : ""} {showMappings ? "▲" : "▼"}
              </button>
            </div>
          </div>

          {loadingList ? (
            <div style={{ textAlign: "center", padding: 40, color: "var(--tm)" }}>불러오는 중...</div>
          ) : unlearnedItems.length === 0 ? (
            <div style={{ textAlign: "center", padding: 40, color: "var(--ok)", fontSize: 14 }}>✓ 미처리 대기 항목이 없습니다</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {canEdit && <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 14px 4px 10px" }}>
                <input type="checkbox"
                  checked={unlearnedItems.length > 0 && checkedIds.size === unlearnedItems.length}
                  ref={el => { if (el) el.indeterminate = checkedIds.size > 0 && checkedIds.size < unlearnedItems.length; }}
                  onChange={e => setCheckedIds(e.target.checked ? new Set(unlearnedItems.map(x => x.id)) : new Set())}
                  style={{ width: 15, height: 15, cursor: "pointer" }}
                />
                <span style={{ fontSize: 11, color: "var(--tm)" }}>전체 선택</span>
              </div>}
              {unlearnedItems.map(item => {
                const srch = debtorSearch[item.id] || "";
                const chosen = selectedDebtor[item.id];
                const chosenDebtor = chosen ? data.debtors.find(d => d.id === chosen) : null;
                const filtered = getFiltered(srch);
                const isChecked = checkedIds.has(item.id);
                const brandCode = item.excel_brand || (item.source === "slack" ? "B" : null);
                const brandInfo = brandCode ? (config.brands.find(x => x.code === brandCode) || { name: brandCode, color: "#64748b" }) : null;
                return (
                  <div key={item.id} style={{ background: isChecked ? "#ef444408" : "var(--bg)", borderRadius: 10, padding: "10px 14px", border: `1px solid ${isChecked ? "#ef444440" : "var(--brd)"}`, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                    {canEdit && <input type="checkbox" checked={isChecked}
                      onChange={e => setCheckedIds(prev => { const n = new Set(prev); e.target.checked ? n.add(item.id) : n.delete(item.id); return n; })}
                      style={{ width: 15, height: 15, cursor: "pointer", flexShrink: 0 }}
                    />}
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        {brandInfo && (
                          <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 4, fontWeight: 700, background: `${brandInfo.color}18`, color: brandInfo.color, border: `1px solid ${brandInfo.color}30`, flexShrink: 0 }}>
                            {brandInfo.name}
                          </span>
                        )}
                        <span style={{ fontWeight: 600, fontSize: 14 }}>{item.payer_name}</span>
                        <span className="mono" style={{ fontSize: 13, fontWeight: 700, color: "var(--acc)" }}>{fmt(item.total_amount)}</span>
                        <span className="mono" style={{ fontSize: 11, color: "var(--tm)" }}>{item.payment_date}</span>
                        <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "#f59e0b18", color: "#b45309", fontWeight: 600 }}>
                          {item.source === "slack" ? "Slack 자동" : "수동입력"}
                        </span>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <div style={{ position: "relative" }}>
                        <KoreanInput
                          value={chosenDebtor ? `${chosenDebtor.name} (${chosenDebtor.id})` : srch}
                          onChange={e => {
                            setDebtorSearch(p => ({ ...p, [item.id]: e.target.value }));
                            setSelectedDebtor(p => ({ ...p, [item.id]: null }));
                          }}
                          placeholder="채무자 검색..."
                          style={{ width: 210, padding: "6px 10px", fontSize: 12, borderRadius: 6, border: `1px solid ${chosen ? "var(--ok)" : "var(--brd)"}`, background: "var(--inp)", outline: "none" }}
                        />
                        {srch && !chosen && filtered.length > 0 && (
                          <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "var(--card)", border: "1px solid var(--brd)", borderRadius: 6, zIndex: 200, maxHeight: 220, overflowY: "auto", boxShadow: "0 4px 12px rgba(0,0,0,.15)" }}>
                            {filtered.map(d => (
                              <div key={d.id}
                                onClick={() => { setSelectedDebtor(p => ({ ...p, [item.id]: d.id })); setDebtorSearch(p => ({ ...p, [item.id]: "" })); }}
                                style={{ padding: "8px 10px", cursor: "pointer", fontSize: 12, borderBottom: "1px solid var(--brd)" }}
                                onMouseEnter={e => e.currentTarget.style.background = "var(--bg)"}
                                onMouseLeave={e => e.currentTarget.style.background = ""}
                              >
                                <div style={{ fontWeight: 600 }}>{d.name}</div>
                                <div style={{ fontSize: 10, color: "var(--tm)", marginTop: 2 }}>{d.id} · {d.hubName || ""} · 잔액 {fmt(d.finalBalanceLegal)}</div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      {canEdit && <button
                        onClick={() => doResolve(item)}
                        disabled={!chosen || resolving === item.id}
                        style={{ padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: chosen ? "var(--ok)" : "var(--bg)", color: chosen ? "#fff" : "var(--tm)", border: chosen ? "none" : "1px solid var(--brd)", opacity: (!chosen || resolving === item.id) ? 0.6 : 1, cursor: !chosen ? "not-allowed" : "pointer" }}
                      >
                        {resolving === item.id ? "처리중..." : "✓ 연결"}
                      </button>}
                      {canEdit && <button
                        onClick={() => doDiscard(item)}
                        title="이 항목 삭제"
                        style={{ padding: "6px 10px", borderRadius: 6, fontSize: 12, background: "#ef444410", color: "var(--err)", border: "1px solid #ef444430", cursor: "pointer" }}
                      >
                        <I name="trash" size={13} />
                      </button>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 학습 매핑 관리 패널 */}
        {showMappings && (
          <div style={{ background: "var(--card)", borderRadius: 12, padding: 20, border: "1px solid #7c3aed30", display: "flex", flexDirection: "column", gap: 20 }}>

            {/* 학습 매핑으로 대기 중인 항목 */}
            {learnedPendingItems.length > 0 && (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#7c3aed" }}>🧠 학습 매핑 대기 ({learnedPendingItems.length}건)</div>
                    <div style={{ fontSize: 11, color: "var(--tm)", marginTop: 2 }}>채무자가 이미 자동 선택된 항목입니다. 일괄 연결하거나 개별 처리하세요.</div>
                  </div>
                  <button onClick={doResolveAll} style={{ padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: "#7c3aed", color: "#fff", border: "none", cursor: "pointer" }}>
                    전체 일괄 연결
                  </button>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {learnedPendingItems.map(item => {
                    const mapping = learnedMap[item.payer_name];
                    return (
                      <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "#7c3aed08", borderRadius: 8, border: "1px solid #7c3aed20" }}>
                        <span style={{ fontWeight: 600, fontSize: 13, minWidth: 120 }}>{item.payer_name}</span>
                        <span className="mono" style={{ fontSize: 13, color: "var(--acc)", fontWeight: 700 }}>{fmt(item.total_amount)}</span>
                        <span className="mono" style={{ fontSize: 11, color: "var(--tm)" }}>{item.payment_date}</span>
                        <span style={{ color: "var(--tm)", fontSize: 12 }}>→</span>
                        <span style={{ fontSize: 13, color: "var(--ok)", fontWeight: 500, flex: 1 }}>{mapping?.debtor_name} <span style={{ fontSize: 11, color: "var(--tm)" }}>({mapping?.debtor_id})</span></span>
                        <button onClick={() => doResolve(item)} disabled={resolving === item.id} style={{ padding: "4px 10px", borderRadius: 5, fontSize: 11, fontWeight: 600, background: "#7c3aed", color: "#fff", border: "none", cursor: "pointer", opacity: resolving === item.id ? 0.6 : 1 }}>
                          {resolving === item.id ? "처리중..." : "✓ 연결"}
                        </button>
                        <button onClick={() => doDiscard(item)} style={{ padding: "4px 8px", borderRadius: 5, fontSize: 11, background: "#ef444410", color: "var(--err)", border: "1px solid #ef444430", cursor: "pointer" }}>
                          <I name="trash" size={11} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 학습된 입금자 매핑 규칙 */}
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4, color: "#7c3aed" }}>학습된 입금자 규칙 ({learnedList.length}개)</div>
              <div style={{ fontSize: 12, color: "var(--tm)", marginBottom: 10 }}>
                수동 연결 이력이 저장되어, 앞으로 같은 입금자명은 자동 선택됩니다.
              </div>
              {learnedList.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--tm)", textAlign: "center", padding: 20 }}>아직 학습된 매핑이 없습니다</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {learnedList.map(m => (
                    <div key={m.payer_name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "var(--bg)", borderRadius: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 13, minWidth: 120 }}>{m.payer_name}</span>
                      <span style={{ color: "var(--tm)", fontSize: 12 }}>→</span>
                      <span style={{ fontSize: 13, color: "var(--ok)", fontWeight: 500, flex: 1 }}>{m.debtor_name} <span style={{ fontSize: 11, color: "var(--tm)" }}>({m.debtor_id})</span></span>
                      <span className="mono" style={{ fontSize: 11, color: "var(--tm)" }}>{m.resolved_count}회 적용</span>
                      {isAdmin && <button onClick={() => doDeleteMapping(m.payer_name)} style={{ padding: "3px 8px", borderRadius: 4, fontSize: 11, background: "#ef444410", color: "var(--err)", border: "1px solid #ef444430" }}>삭제</button>}
                    </div>
                  ))}
                </div>
              )}
            </div>

          </div>
        )}
      </div>
    );
  });

  // ─── 문건 자동 생성 ─────────────────────────────────────────
  const PRESET_BANKS = [
    { label: "국민은행",   fullName: "주식회사 국민은행",           type: "bank" },
    { label: "농협은행",   fullName: "농협은행 주식회사",            type: "bank" },
    { label: "우리은행",   fullName: "주식회사 우리은행",            type: "bank" },
    { label: "신한은행",   fullName: "주식회사 신한은행",            type: "bank" },
    { label: "하나은행",   fullName: "주식회사 하나은행",            type: "bank" },
    { label: "카카오뱅크", fullName: "주식회사 카카오뱅크",          type: "bank" },
    { label: "케이뱅크",   fullName: "주식회사 케이뱅크",            type: "bank" },
    { label: "기업은행",   fullName: "중소기업은행",                 type: "bank" },
    { label: "쿠팡이츠",   fullName: "쿠팡이츠서비스 유한회사",      type: "platform" },
    { label: "배민",       fullName: "주식회사 우아한청년들",         type: "platform" },
    { label: "바로고",     fullName: "유한책임회사 플라이앤컴퍼니",   type: "platform" },
  ];

  const AI_TEMPLATES = [
    { id: "압류별지", label: "[압류][별지] 압류 및 추심할 채권의 표시", active: true },
    { id: "강제집행", label: "강제집행 신청서", active: false },
  ];

  const EXEC_TITLE_TYPES = [
    { id: "공정증서", label: "공정증서" },
    { id: "판결문",   label: "판결문" },
    { id: "지급명령", label: "지급명령" },
  ];


  const AiDocsView = useStableComponent(() => {
    const [selTemplate,   setSelTemplate]   = useState("압류별지");
    const [execType,      setExecType]      = useState("공정증서");
    const [debtorQ,       setDebtorQ]       = useState("");
    const [selDebtor,     setSelDebtor]     = useState(null);
    const [residentId,    setResidentId]    = useState("");
    const [origPrincipal, setOrigPrincipal] = useState("");
    const [remaining,     setRemaining]     = useState("");
    // 공정증서 전용
    const [notaryDoc,  setNotaryDoc]  = useState("");
    const [docType,    setDocType]    = useState("공정증서 정본");
    const [clause,     setClause]     = useState("제1조(목적)상");
    const [borrowDate, setBorrowDate] = useState("");
    // 판결문/지급명령 공통
    const [courtName,   setCourtName]   = useState("");
    const [caseNumber,  setCaseNumber]  = useState("");
    const [orderNumber, setOrderNumber] = useState("");

    const [items,      setItems]      = useState([]);
    const [customName, setCustomName] = useState("");
    const [customType, setCustomType] = useState("bank");
    const [previewHtml, setPreviewHtml] = useState("");
    const [showPreview, setShowPreview] = useState(false);
    const [dlLoading,  setDlLoading]  = useState(false);
    const [dlError,    setDlError]    = useState("");

    const debtorResults = useMemo(() => {
      if (!debtorQ.trim()) return [];
      const q = debtorQ.trim().toLowerCase();
      return data.debtors
        .filter(d => d.name.toLowerCase().includes(q) || (d.hubCode || "").includes(q))
        .slice(0, 8);
    }, [debtorQ, data.debtors]);

    const handleSelectDebtor = (d) => {
      setSelDebtor(d);
      setDebtorQ(d.name);
      setRemaining(String(d.principalBalance || d.principal_balance || ""));
    };

    const togglePreset = (preset) => {
      const exists = items.find(it => it.name === preset.fullName);
      if (exists) setItems(items.filter(it => it.name !== preset.fullName));
      else setItems([...items, { id: Date.now(), name: preset.fullName, amount: 2000000, type: preset.type }]);
    };

    const addCustom = () => {
      if (!customName.trim()) return;
      setItems([...items, { id: Date.now(), name: customName.trim(), amount: 2000000, type: customType }]);
      setCustomName("");
    };

    const updateItemAmount = (id, val) =>
      setItems(items.map(it => it.id === id ? { ...it, amount: parseInt(String(val).replace(/,/g, ""), 10) || 0 } : it));
    const updateItemName = (id, val) =>
      setItems(items.map(it => it.id === id ? { ...it, name: val } : it));
    const removeItem = (id) => setItems(items.filter(it => it.id !== id));
    const moveItem = (id, dir) => {
      const idx = items.findIndex(it => it.id === id);
      if (idx < 0) return;
      const next = [...items];
      const swap = idx + dir;
      if (swap < 0 || swap >= next.length) return;
      [next[idx], next[swap]] = [next[swap], next[idx]];
      setItems(next);
    };

    const bankItems     = items.filter(it => it.type === "bank");
    const platformItems = items.filter(it => it.type === "platform");
    const totalAmount   = items.reduce((s, it) => s + (it.amount || 0), 0);
    const fmtNum        = n => Number(n || 0).toLocaleString("ko-KR");
    const origNum       = parseInt(String(origPrincipal).replace(/,/g, ""), 10) || 0;
    const remNum        = parseInt(String(remaining).replace(/,/g, ""), 10) || 0;

    const buildExecTitleText = () => {
      if (execType === "공정증서") {
        return `[${notaryDoc || "공증인가 법무법인 ○○ 증서 20__년 제___호"}] 집행력있는 [${docType || "공정증서 정본"}] [${clause || "제1조(목적)상"}]의 채무자가 채권자에게 [${borrowDate || "20__년 __월 __일"}] 차용한 원금 [${fmtNum(origNum)}원] 중 변제 후 잔액 [${fmtNum(remNum)}원]`;
      } else if (execType === "판결문") {
        return `[${courtName || "○○지방법원"}] [${caseNumber || "20__가단_____"}] 판결문에 의한 원금 [${fmtNum(origNum)}원] 중 변제 후 잔액 [${fmtNum(remNum)}원]`;
      } else {
        return `[${courtName || "○○지방법원"}] [${orderNumber || "20__차_____"}] 지급명령에 의한 원금 [${fmtNum(origNum)}원] 중 변제 후 잔액 [${fmtNum(remNum)}원]`;
      }
    };

    const buildDocData = () => ({
      debtorName:         selDebtor?.name || "",
      residentId:         residentId || "000000-0000000",
      totalAmount,
      executionTitleText: buildExecTitleText(),
      bankItems:          bankItems.map(it => ({ name: it.name, amount: it.amount })),
      platformItems:      platformItems.map(it => ({ name: it.name, amount: it.amount })),
    });

    const generateDocHtml = () => {
      const dName = selDebtor?.name || "(채무자 미선택)";
      const rid   = residentId || "000000-0000000";
      const execText = buildExecTitleText();
      const allItems = [...bankItems, ...platformItems];
      const formula  = allItems.length > 0
        ? "(" + allItems.map((_, i) => i + 1).join("+") + ")"
        : "(항목 없음)";

      const bankBody = (name) =>
        `채무자[${dName}][(주민등록번호 : ${rid})]이 제3채무자 [${name}]에 대하여 가지는 다음의 예금채권 중 현재 입금되어 있거나 장래 입금될 예금채권으로서 다음에서 기재한 순서에 따라 위 청구금액에 이를 때까지의 금액(단, 민사집행법상 246조 1항 7호, 8호 및 동법시행령에 의하여 압류가 금지되는 예금은 제외한다.)`;
      const platBody = (name) =>
        `채무자[${dName}][(주민등록번호 : ${rid})]이 제3채무자 [${name}]의 배달대행 프로그램상 가지는 배달수수료 및 이에 따른 수당채권 일체중 제3채무자가 채무자에게 현재 지급해야 할 금액 및 장래에 지급해야 금액 중 위 청구금액에 이를 때까지의 금액`;

      const bankRows = bankItems.map((item, i) => `
        <div class="item-title"><strong>${i + 1}. [${item.name}]에 대하여</strong></div>
        <div class="item-amount">&nbsp;&nbsp;&nbsp;[금 ${fmtNum(item.amount)}원]</div>
        <p>${bankBody(item.name)}</p>`).join("");

      const platRows = platformItems.map((item, i) => `
        <div class="item-title"><strong>${bankItems.length + i + 1}. [${item.name}]에 대하여</strong></div>
        <div class="item-amount">&nbsp;&nbsp;[ 금 ${fmtNum(item.amount)}원]</div>
        <p>${platBody(item.name)}</p>`).join("");

      return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"/>
<style>
  body{font-family:"맑은 고딕","Malgun Gothic",sans-serif;font-size:10pt;line-height:1.6;margin:0;padding:0;background:#fff;color:#000}
  .page{width:210mm;margin:0 auto;padding:20mm 22mm;box-sizing:border-box}
  h2{text-align:center;font-size:14pt;margin:16px 0 20px}
  .label{font-size:11pt;font-weight:bold;margin:8px 0 4px}
  .claim{font-size:12pt;font-weight:bold}
  .notary{font-size:9.5pt;margin:10px 0}
  .item-title{font-weight:bold;margin-top:14px}
  .item-amount{margin:2px 0 4px;font-weight:bold}
  p{margin:4px 0 8px;font-size:9.5pt}
  .daeum-box{border:1px solid #000;padding:10px 14px;margin:14px 0;font-size:9.5pt}
  .daeum-title{text-align:center;font-weight:bold;margin-bottom:8px}
  @media print{body{margin:0}.page{margin:0;padding:15mm 18mm}}
</style></head><body>
<div class="page">
  <p>[별지]</p>
  <h2>압류 및 추심할 채권의 표시</h2>
  <div class="label">채무자 : [ ${dName} ]</div>
  <div class="claim">청구금액 : [ ${fmtNum(totalAmount)} ]원</div>
  <div>${formula}</div>
  <div class="notary">* 청구금액 산정내역 : ${execText}</div>
  ${bankRows}
  ${bankItems.length > 0 ? `<div class="daeum-box">
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
</div></body></html>`;
    };

    const handlePreview = () => {
      setDlError("");
      setPreviewHtml(generateDocHtml());
      setShowPreview(true);
    };

    const handleDownloadHwpx = async () => {
      if (!selDebtor) return setDlError("채무자를 먼저 선택하세요.");
      if (items.length === 0) return setDlError("제3채무자 항목을 1개 이상 추가하세요.");
      setDlLoading(true); setDlError("");
      try {
        const res = await fetch("/api/documents/generate-hwpx", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildDocData()),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(err.error || "서버 오류");
        }
        const blob = await res.blob();
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement("a");
        a.href = url;
        a.download = `압류채권표시_${selDebtor.name}.hwpx`;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a); URL.revokeObjectURL(url);
      } catch (e) {
        setDlError("HWPX 생성 실패: " + e.message);
      } finally {
        setDlLoading(false);
      }
    };

    const handlePrintPdf = () => {
      const html = previewHtml || generateDocHtml();
      const w = window.open("", "_blank");
      w.document.write(html);
      w.document.close();
      setTimeout(() => { w.focus(); w.print(); }, 600);
    };

    const inputStyle   = { width: "100%", padding: "7px 10px", fontSize: 12, borderRadius: 6,
      border: "1px solid var(--brd)", background: "var(--card)", color: "var(--tp)", boxSizing: "border-box" };
    const labelStyle   = { fontSize: 11, color: "var(--tm)", fontWeight: 500, marginBottom: 3, display: "block" };
    const sectionStyle = { background: "var(--card)", borderRadius: 10, border: "1px solid var(--brd)",
      padding: "14px 16px", marginBottom: 14 };

    return (
      <div style={{ display: "flex", gap: 16, height: "100%", alignItems: "flex-start" }}>
        {/* ── 좌측: 입력 폼 ── */}
        <div style={{ width: 440, flexShrink: 0, overflowY: "auto", maxHeight: "calc(100vh - 100px)" }}>

          {/* 양식 선택 */}
          <div style={sectionStyle}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>양식 선택</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {AI_TEMPLATES.map(t => (
                <div key={t.id} onClick={() => t.active && setSelTemplate(t.id)}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 8,
                    border: `2px solid ${selTemplate === t.id ? "var(--acc)" : "var(--brd)"}`,
                    background: selTemplate === t.id ? "rgba(99,102,241,.06)" : "var(--bg2)",
                    cursor: t.active ? "pointer" : "not-allowed", opacity: t.active ? 1 : 0.45 }}>
                  <div style={{ width: 14, height: 14, borderRadius: "50%", flexShrink: 0,
                    border: `2px solid ${selTemplate === t.id ? "var(--acc)" : "var(--brd)"}`,
                    background: selTemplate === t.id ? "var(--acc)" : "transparent" }} />
                  <span style={{ fontSize: 12, fontWeight: 500, flex: 1 }}>{t.label}</span>
                  {!t.active && (
                    <span style={{ fontSize: 10, color: "var(--tm)", background: "var(--bg)", padding: "2px 6px", borderRadius: 4 }}>준비 중</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* 채무자 정보 */}
          <div style={sectionStyle}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10 }}>채무자 정보</div>
            <label style={labelStyle}>채무자 검색 (DB)</label>
            <div style={{ position: "relative", marginBottom: 10 }}>
              <KoreanInput
                value={debtorQ}
                onChange={e => { setDebtorQ(e.target.value); setSelDebtor(null); }}
                placeholder="채무자명 또는 허브코드 입력..."
                style={inputStyle}
              />
              {debtorResults.length > 0 && !selDebtor && (
                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "var(--card)",
                  border: "1px solid var(--brd)", borderRadius: 6, zIndex: 10, boxShadow: "0 4px 12px rgba(0,0,0,.1)" }}>
                  {debtorResults.map(d => (
                    <div key={d.id} onClick={() => handleSelectDebtor(d)}
                      style={{ padding: "8px 12px", cursor: "pointer", fontSize: 12, borderBottom: "1px solid var(--brd)" }}
                      onMouseEnter={e => e.currentTarget.style.background = "var(--hover)"}
                      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                      <span style={{ fontWeight: 600 }}>{d.name}</span>
                      <span style={{ color: "var(--tm)", marginLeft: 8 }}>{d.brandName || d.brand_code} / {d.hubCode || d.hub_code}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {selDebtor && (
              <div style={{ background: "var(--bg2)", borderRadius: 6, padding: "6px 10px", fontSize: 11,
                color: "var(--ts)", display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span>선택됨: <strong>{selDebtor.name}</strong> ({selDebtor.brandName || selDebtor.brand_code})</span>
                <button onClick={() => { setSelDebtor(null); setDebtorQ(""); }}
                  style={{ background: "none", color: "var(--err)", border: "none", cursor: "pointer", fontSize: 10 }}>×</button>
              </div>
            )}
            <label style={labelStyle}>주민등록번호 (수동 입력)</label>
            <KoreanInput value={residentId} onChange={e => setResidentId(e.target.value)}
              placeholder="000000-0000000" style={{ ...inputStyle, marginBottom: 0 }} />
          </div>

          {/* 집행권원 유형 + 동적 필드 */}
          <div style={sectionStyle}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10 }}>집행권원 유형</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
              {EXEC_TITLE_TYPES.map(et => (
                <button key={et.id} onClick={() => setExecType(et.id)}
                  style={{ flex: 1, padding: "7px 0", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer",
                    border: `2px solid ${execType === et.id ? "var(--acc)" : "var(--brd)"}`,
                    background: execType === et.id ? "var(--acc)" : "var(--bg2)",
                    color: execType === et.id ? "#fff" : "var(--tp)" }}>
                  {et.label}
                </button>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
              {execType === "공정증서" && <>
                <div>
                  <label style={labelStyle}>공증서류명</label>
                  <KoreanInput value={notaryDoc} onChange={e => setNotaryDoc(e.target.value)}
                    placeholder="공증인가 법무법인 ○○ 증서 20__년 제___호" style={inputStyle} />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <div>
                    <label style={labelStyle}>서류종류</label>
                    <KoreanInput value={docType} onChange={e => setDocType(e.target.value)}
                      placeholder="공정증서 정본" style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>조항</label>
                    <KoreanInput value={clause} onChange={e => setClause(e.target.value)}
                      placeholder="제1조(목적)상" style={inputStyle} />
                  </div>
                </div>
                <div>
                  <label style={labelStyle}>차용일</label>
                  <KoreanInput value={borrowDate} onChange={e => setBorrowDate(e.target.value)}
                    placeholder="20__년 __월 __일" style={inputStyle} />
                </div>
              </>}
              {(execType === "판결문" || execType === "지급명령") && <>
                <div>
                  <label style={labelStyle}>법원명</label>
                  <KoreanInput value={courtName} onChange={e => setCourtName(e.target.value)}
                    placeholder="○○지방법원" style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>{execType === "판결문" ? "사건번호" : "명령번호"}</label>
                  <KoreanInput
                    value={execType === "판결문" ? caseNumber : orderNumber}
                    onChange={e => execType === "판결문" ? setCaseNumber(e.target.value) : setOrderNumber(e.target.value)}
                    placeholder={execType === "판결문" ? "20__가단_____" : "20__차_____"}
                    style={inputStyle}
                  />
                </div>
              </>}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <div>
                  <label style={labelStyle}>원금</label>
                  <KoreanInput value={origPrincipal} onChange={e => setOrigPrincipal(e.target.value)}
                    placeholder="123,645,678" style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>변제 후 잔액 (DB 자동)</label>
                  <KoreanInput value={remaining ? Number(remaining).toLocaleString("ko-KR") : ""}
                    onChange={e => setRemaining(e.target.value.replace(/,/g, ""))}
                    placeholder="12,234,567" style={inputStyle} />
                </div>
              </div>
            </div>
          </div>

          {/* 제3채무자 선택 */}
          <div style={sectionStyle}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
              제3채무자 선택
              <span style={{ fontSize: 10, color: "var(--tm)", fontWeight: 400, marginLeft: 8 }}>
                선택 순서대로 1번부터 번호가 매겨집니다
              </span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
              {PRESET_BANKS.map(p => {
                const active = !!items.find(it => it.name === p.fullName);
                return (
                  <button key={p.fullName} onClick={() => togglePreset(p)}
                    style={{ padding: "4px 10px", borderRadius: 16, fontSize: 11, fontWeight: 500, cursor: "pointer",
                      background: active ? (p.type === "bank" ? "#eff6ff" : "#f0fdf4") : "var(--bg2)",
                      color: active ? (p.type === "bank" ? "#1d4ed8" : "#166534") : "var(--ts)",
                      border: `1px solid ${active ? (p.type === "bank" ? "#bfdbfe" : "#bbf7d0") : "var(--brd)"}` }}>
                    {active && "✓ "}{p.label}
                    <span style={{ fontSize: 9, color: "var(--tm)", marginLeft: 4 }}>
                      {p.type === "bank" ? "은행" : "플랫폼"}
                    </span>
                  </button>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
              <KoreanInput value={customName} onChange={e => setCustomName(e.target.value)}
                placeholder="직접입력 (예: 주식회사 하나저축은행)" style={{ ...inputStyle, flex: 1 }} />
              <select value={customType} onChange={e => setCustomType(e.target.value)}
                style={{ ...inputStyle, width: 80, flex: "none" }}>
                <option value="bank">은행</option>
                <option value="platform">플랫폼</option>
              </select>
              <button onClick={addCustom}
                style={{ padding: "7px 12px", borderRadius: 6, background: "var(--acc)", color: "#fff",
                  fontSize: 12, border: "none", cursor: "pointer", whiteSpace: "nowrap" }}>추가</button>
            </div>
            {items.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {items.map((item, idx) => (
                  <div key={item.id} style={{ display: "flex", gap: 6, alignItems: "center",
                    background: "var(--bg2)", borderRadius: 6, padding: "6px 8px",
                    borderLeft: `3px solid ${item.type === "bank" ? "#3b82f6" : "#10b981"}` }}>
                    <span style={{ fontSize: 11, color: "var(--tm)", fontWeight: 600, width: 18 }}>{idx + 1}.</span>
                    <KoreanInput value={item.name} onChange={e => updateItemName(item.id, e.target.value)}
                      style={{ ...inputStyle, flex: 1, padding: "4px 8px", fontSize: 11 }} />
                    <KoreanInput value={item.amount.toLocaleString("ko-KR")}
                      onChange={e => updateItemAmount(item.id, e.target.value.replace(/,/g, ""))}
                      style={{ ...inputStyle, width: 110, flex: "none", padding: "4px 8px", fontSize: 11,
                        textAlign: "right", fontFamily: "monospace" }} />
                    <span style={{ fontSize: 10, color: "var(--tm)" }}>원</span>
                    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                      <button onClick={() => moveItem(item.id, -1)} style={{ padding: "1px 4px", fontSize: 9,
                        background: "var(--bg)", border: "1px solid var(--brd)", borderRadius: 3, cursor: "pointer" }}>▲</button>
                      <button onClick={() => moveItem(item.id, 1)} style={{ padding: "1px 4px", fontSize: 9,
                        background: "var(--bg)", border: "1px solid var(--brd)", borderRadius: 3, cursor: "pointer" }}>▼</button>
                    </div>
                    <button onClick={() => removeItem(item.id)}
                      style={{ background: "none", color: "var(--err)", border: "none", cursor: "pointer", fontSize: 14, lineHeight: 1 }}>×</button>
                  </div>
                ))}
                <div style={{ textAlign: "right", fontSize: 11, color: "var(--tm)", marginTop: 4 }}>
                  총 청구금액: <strong style={{ color: "var(--acc)" }}>{totalAmount.toLocaleString("ko-KR")}원</strong>
                </div>
              </div>
            ) : (
              <div style={{ textAlign: "center", padding: "12px 0", color: "var(--tm)", fontSize: 12 }}>
                위에서 항목을 선택하거나 직접 추가하세요
              </div>
            )}
          </div>

          {/* 버튼 */}
          {dlError && <div style={{ color: "var(--err)", fontSize: 11, marginBottom: 8 }}>{dlError}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handlePreview}
              style={{ flex: 1, padding: "10px 0", borderRadius: 8, background: "var(--bg2)",
                color: "var(--tp)", fontSize: 13, fontWeight: 600, border: "1px solid var(--brd)", cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              <I name="eye" size={15} /> 미리보기
            </button>
            <button onClick={handleDownloadHwpx} disabled={dlLoading}
              style={{ flex: 1, padding: "10px 0", borderRadius: 8,
                background: dlLoading ? "var(--bg2)" : "#6366f1", color: dlLoading ? "var(--tm)" : "#fff",
                fontSize: 13, fontWeight: 600, border: "none", cursor: dlLoading ? "default" : "pointer",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              <I name="download" size={15} /> {dlLoading ? "생성 중..." : "HWPX 다운"}
            </button>
            <button onClick={handlePrintPdf}
              style={{ flex: 1, padding: "10px 0", borderRadius: 8, background: "#ef4444", color: "#fff",
                fontSize: 13, fontWeight: 600, border: "none", cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              <I name="download" size={15} /> PDF 출력
            </button>
          </div>
        </div>

        {/* ── 우측: 미리보기 ── */}
        <div style={{ flex: 1, background: "var(--card)", border: "1px solid var(--brd)", borderRadius: 10,
          overflow: "hidden", minHeight: 500 }}>
          {showPreview && previewHtml ? (
            <div style={{ height: "calc(100vh - 120px)", display: "flex", flexDirection: "column" }}>
              <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--brd)", display: "flex",
                justifyContent: "space-between", alignItems: "center", background: "var(--bg2)" }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>미리보기</span>
                <button onClick={() => setShowPreview(false)}
                  style={{ background: "none", border: "none", color: "var(--tm)", cursor: "pointer" }}>
                  <I name="close" size={14} />
                </button>
              </div>
              <iframe srcDoc={previewHtml} style={{ flex: 1, border: "none", width: "100%" }}
                title="문건 미리보기" />
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
              height: 400, color: "var(--tm)" }}>
              <I name="fileText" size={40} />
              <div style={{ marginTop: 12, fontSize: 13 }}>좌측 양식을 작성하고 미리보기를 눌러주세요</div>
            </div>
          )}
        </div>
      </div>
    );
  });

  // ─── 민사소송 View ───────────────────────────────────────
  const MinSaView = useStableComponent(() => {
    const [brandF,       setBrandF]       = useState("전체");
    const [typeF,        setTypeF]        = useState("전체");
    const [searchQ,      setSearchQ]      = useState("");
    useEffect(() => { if (minsaSearchInit) { setSearchQ(minsaSearchInit); setMinsaSearchInit(null); } }, [minsaSearchInit]);
    const [selCase,      setSelCase]      = useState(null);
    const [matchingCase, setMatchingCase] = useState(null);
    const [matchQ,       setMatchQ]       = useState("");
    const [caseNotes,    setCaseNotes]    = useState([]);
    const [noteDraft,    setNoteDraft]    = useState("");
    useEffect(() => { setCaseNotes(selCase ? getCaseNotes(selCase.id) : []); setNoteDraft(""); }, [selCase?.id]);

    const mc = data.minsaCases || [];

    const getCaseType = (caseNumber) => {
      if (!caseNumber) return "기타";
      if (caseNumber.includes("가합")) return "가합";
      if (caseNumber.includes("가단")) return "가단";
      if (caseNumber.includes("가소")) return "가소";
      return "기타";
    };

    const caseTypeTabs = [
      { k: "전체", label: "전체" },
      { k: "가합", label: "가합", desc: "합의부" },
      { k: "가단", label: "가단", desc: "단독" },
      { k: "가소", label: "가소", desc: "소액" },
      { k: "기타", label: "기타" },
    ].filter(t => t.k === "전체" || mc.some(c => getCaseType(c.caseNumber) === t.k));

    const filtered = useMemo(() => {
      let r = mc;
      if (brandF !== "전체") r = r.filter(c => c.brand === brandF);
      if (typeF !== "전체") r = r.filter(c => getCaseType(c.caseNumber) === typeF);
      if (searchQ) {
        const q = searchQ.toLowerCase();
        r = r.filter(c =>
          (c.defendant || "").toLowerCase().includes(q) ||
          (c.caseNumber || "").toLowerCase().includes(q) ||
          (c.court || "").toLowerCase().includes(q)
        );
      }
      return r;
    }, [mc, brandF, typeF, searchQ]);

    const getDebtor = (id) => data.debtors.find(d => d.id === id);

    const matchCandidates = useMemo(() => {
      if (!matchingCase) return [];
      const q = matchQ.toLowerCase().trim();
      return (q
        ? data.debtors.filter(d => d.name.toLowerCase().includes(q) || (d.phone || "").includes(q) || (d.hubName || "").includes(q))
        : data.debtors
      ).slice(0, 30);
    }, [matchQ, matchingCase, data.debtors]);

    const handleManualMatch = (caseId, debtorId) => {
      saveLegalOv(MINSA_OVERRIDES_KEY, caseId, debtorId);
      setData(prev => ({
        ...prev,
        minsaCases: prev.minsaCases.map(c => c.id === caseId ? { ...c, debtorId } : c),
      }));
      setMatchingCase(null);
      setMatchQ("");
      showToast(debtorId ? "수동 매칭 완료 — 저장됨" : "연결 해제됨");
    };

    const ManualMatchPanel = useStableComponent(({ caseId, onClose }) => (
      <div style={{ background: "var(--bg2)", borderRadius: 10, border: "1px solid var(--acc)", padding: 14, marginTop: -4 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--acc)", flex: 1 }}>채무자 수동 연결</div>
          <button onClick={() => handleManualMatch(caseId, null)} style={{ fontSize: 11, padding: "3px 10px", borderRadius: 6, background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca", cursor: "pointer" }}>연결 해제</button>
          <button onClick={onClose} style={{ fontSize: 11, padding: "3px 10px", borderRadius: 6, background: "var(--bg)", color: "var(--tm)", border: "1px solid var(--brd)", cursor: "pointer" }}>닫기</button>
        </div>
        <div style={{ position: "relative", marginBottom: 8 }}>
          <div style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "var(--tm)" }}><I name="search" size={13} /></div>
          <KoreanInput value={matchQ} onChange={e => setMatchQ(e.target.value)} autoFocus placeholder="채무자명·연락처·허브명 검색..." style={{ width: "100%", padding: "6px 8px 6px 26px", fontSize: 12, borderRadius: 7, border: "1px solid var(--brd)", background: "var(--card)", color: "var(--tp)" }} />
        </div>
        <div style={{ maxHeight: 200, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
          {matchCandidates.length === 0 && <div style={{ fontSize: 12, color: "var(--tm)", padding: 8 }}>검색 결과 없음</div>}
          {matchCandidates.map(d => (
            <div key={d.id} onClick={() => handleManualMatch(caseId, d.id)}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 7, cursor: "pointer", fontSize: 12, background: "var(--card)", border: "1px solid var(--brd)" }}
              onMouseEnter={e => e.currentTarget.style.background = "var(--hover)"}
              onMouseLeave={e => e.currentTarget.style.background = "var(--card)"}
            >
              <BrandBadge code={d.brand} brands={config.brands} />
              <span style={{ fontWeight: 600, minWidth: 70 }}>{d.name}</span>
              <span style={{ color: "var(--ts)", fontSize: 11 }}>{d.hubName}</span>
              <span style={{ flex: 1 }} />
              <span className="mono" style={{ color: "var(--ok)", fontSize: 11 }}>{fmt(d.finalBalanceLegal)}</span>
            </div>
          ))}
        </div>
      </div>
    ));

    const handleAddNote = () => {
      if (!selCase || !noteDraft.trim()) return;
      const arr = [{ id: uid("NOTE"), createdAt: new Date().toISOString(), content: noteDraft.trim(), createdBy: currentUser?.name || "알수없음" }, ...caseNotes];
      saveCaseNotes(selCase.id, arr);
      setCaseNotes(arr);
      setNoteDraft("");
    };
    const handleDeleteNote = (noteId) => {
      if (!selCase || !confirm("이 메모를 삭제하시겠습니까?")) return;
      const arr = caseNotes.filter(n => n.id !== noteId);
      saveCaseNotes(selCase.id, arr);
      setCaseNotes(arr);
    };

    const DetailModal = () => {
      if (!selCase) return null;
      const debtor = getDebtor(selCase.debtorId);
      const DL = ({ label, val }) => val ? (
        <div style={{ display: "flex", gap: 8, fontSize: 13, padding: "4px 0", borderBottom: "1px solid var(--brd)" }}>
          <span style={{ color: "var(--tm)", minWidth: 110, flexShrink: 0 }}>{label}</span>
          <span style={{ color: "var(--tp)", fontWeight: 500 }}>{val}</span>
        </div>
      ) : null;
      return (
        <Overlay onClose={() => setSelCase(null)} wide>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {selCase.brand && <BrandBadge code={selCase.brand} brands={config.brands} />}
              <span style={{ fontSize: 17, fontWeight: 700 }}>{selCase.defendant}</span>
              <Badge status="민사소송" />
              {selCase.caseStatus && <Badge status={selCase.caseStatus} small />}
            </div>
            <button onClick={() => setSelCase(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--tm)", padding: 4 }}><I name="close" size={18} /></button>
          </div>
          <div style={{ background: "var(--bg)", borderRadius: 10, padding: "12px 16px", marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--tm)", marginBottom: 8 }}>사건 정보</div>
            <DL label="법원"        val={selCase.court} />
            <DL label="사건번호"    val={selCase.caseNumber} />
            <DL label="원고(채권자)" val={selCase.plaintiff} />
            <DL label="피고(채무자)" val={selCase.defendant} />
            <DL label="접수일자"    val={selCase.filingDate} />
            <DL label="기일시간"    val={selCase.hearingTime} />
            <DL label="기일장소"    val={selCase.hearingLocation} />
            <DL label="진행상황"    val={selCase.progressStatus} />
          </div>
          <div style={{ background: "var(--bg)", borderRadius: 10, padding: "12px 16px", marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--tm)", marginBottom: 8 }}>진행상황 메모</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
              <KoreanTextarea
                value={noteDraft} onChange={e => setNoteDraft(e.target.value)} rows={2}
                placeholder="진행상황을 입력하세요... (날짜·작성자 자동 기재)"
                style={{ flex: 1, padding: "7px 10px", borderRadius: 7, border: "1px solid var(--brd)", background: "var(--card)", color: "var(--tp)", fontSize: 12, lineHeight: 1.6, resize: "vertical", boxSizing: "border-box" }}
              />
              <button onClick={handleAddNote} disabled={!noteDraft.trim()} style={{ padding: "0 14px", borderRadius: 7, background: noteDraft.trim() ? "var(--acc)" : "var(--bg2)", color: noteDraft.trim() ? "#fff" : "var(--tm)", border: "none", fontSize: 12, fontWeight: 600, cursor: noteDraft.trim() ? "pointer" : "default", whiteSpace: "nowrap" }}>추가</button>
            </div>
            {caseNotes.length === 0
              ? <div style={{ fontSize: 12, color: "var(--tm)", padding: "4px 0" }}>등록된 메모가 없습니다.</div>
              : <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
                  {caseNotes.map(n => (
                    <div key={n.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", background: "var(--card)", borderRadius: 8, border: "1px solid var(--brd)", padding: "8px 10px" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 3 }}>
                          <span className="mono" style={{ fontSize: 10, color: "var(--acc)", fontWeight: 600 }}>{fmtDateTime(n.createdAt)}</span>
                          <span style={{ fontSize: 10, color: "var(--tm)" }}>{n.createdBy}</span>
                        </div>
                        <div style={{ fontSize: 12, color: "var(--tp)", lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{n.content}</div>
                      </div>
                      {canDeleteRecord(n) && <button onClick={() => handleDeleteNote(n.id)} title="삭제" style={{ width: 22, height: 22, flexShrink: 0, borderRadius: 6, background: "#ef444410", color: "#ef4444", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><I name="trash" size={11} /></button>}
                    </div>
                  ))}
                </div>
            }
          </div>
          <div style={{ background: "var(--bg)", borderRadius: 10, padding: "12px 16px", marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--tm)", marginBottom: 8 }}>채무자 연동</div>
            {debtor ? (
              <>
                <DL label="이름"      val={debtor.name} />
                <DL label="브랜드"    val={debtor.brandName || debtor.brand} />
                <DL label="분류"      val={debtor.category} />
                <DL label="담당자"    val={debtor.assignee} />
                <DL label="잔액(법무)" val={fmt(debtor.finalBalanceLegal)} />
              </>
            ) : (
              <div style={{ fontSize: 13, color: "var(--tm)", padding: "6px 0" }}>채무자 관리 탭과 연결되지 않은 사건입니다.</div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            {debtor && (
              <button
                onClick={() => { navigateToDebtor(debtor, "법적절차내역"); setSelCase(null); }}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, background: "#3b82f6", color: "#fff", fontSize: 13, fontWeight: 600, border: "none", cursor: "pointer" }}
              >
                <I name="users" size={14} /> 채무자 페이지로 가기
              </button>
            )}
            <button onClick={() => setSelCase(null)} style={{ padding: "8px 16px", borderRadius: 8, background: "var(--bg2)", color: "var(--tp)", fontSize: 13, fontWeight: 500, border: "1px solid var(--brd)", cursor: "pointer" }}>닫기</button>
          </div>
        </Overlay>
      );
    };

    const brandCount = (code) => mc.filter(c => c.brand === code).length;
    const typeCount  = (type) => mc.filter(c => getCaseType(c.caseNumber) === type).length;

    return (
      <div className="anim" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {selCase && DetailModal()}

        {/* 사건번호 유형 박스 */}
        <div style={{ display: "flex", gap: 6, alignItems: "center", background: "var(--card)", border: "1px solid var(--brd)", borderRadius: 12, padding: "10px 16px" }}>
          {caseTypeTabs.map(t => {
            const count = t.k === "전체" ? mc.length : mc.filter(c => getCaseType(c.caseNumber) === t.k).length;
            const active = typeF === t.k;
            return (
              <button key={t.k} onClick={() => setTypeF(t.k)}
                style={{ padding: "7px 14px", fontSize: 13, fontWeight: active ? 700 : 500, border: "none", borderRadius: 9, background: active ? "#f59e0b" : "none", cursor: "pointer", color: active ? "#fff" : "var(--tm)", display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}
              >
                {t.label}
                {t.desc && <span style={{ fontSize: 10, color: active ? "#fff" : "var(--ts)", fontWeight: 400 }}>({t.desc})</span>}
                <span style={{ fontSize: active ? 13 : 11, color: active ? "#fff" : "var(--ts)", fontWeight: 700 }}>{count}</span>
              </button>
            );
          })}
        </div>

        {/* 필터 */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select value={brandF} onChange={e => setBrandF(e.target.value)} style={{ padding: "7px 10px", borderRadius: 8, fontSize: 13, border: "1px solid var(--brd)", background: "var(--card)", color: "var(--tp)" }}>
            <option value="전체">전체 브랜드</option>
            {config.brands.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}
          </select>
          <div style={{ position: "relative", flex: 1 }}>
            <KoreanInput
              value={searchQ} onChange={e => setSearchQ(e.target.value)}
              placeholder="채무자명·사건번호·법원 검색"
              style={{ width: "100%", padding: "7px 10px", borderRadius: 8, fontSize: 13, border: "1px solid var(--brd)", background: "var(--card)", color: "var(--tp)" }}
            />
          </div>
          <button onClick={() => setModal({ type: "addMinsa" })} style={{ display: "flex", alignItems: "center", gap: 4, padding: "7px 12px", borderRadius: 8, background: "var(--acc)", color: "#fff", fontSize: 12, fontWeight: 600, border: "none", cursor: "pointer", whiteSpace: "nowrap" }}>
            <I name="plus" size={14} />데이터 추가
          </button>
          <button onClick={() => {
            const rows = filtered.map(c => {
              const d = getDebtor(c.debtorId);
              return ["민사소송", c.brand||"", c.defendant||"", c.court, c.caseNumber, c.filingDate||"", c.progressStatus||"", d ? (d.finalBalanceLegal||0) : ""];
            });
            downloadCSV(`민사소송_${today()}.csv`, ["유형","브랜드","채무자","법원","사건번호","접수일","상태","잔액"], rows);
          }} style={{ display: "flex", alignItems: "center", gap: 4, padding: "7px 12px", borderRadius: 8, background: "#10b98118", color: "#10b981", fontSize: 12, fontWeight: 600, border: "1px solid #10b98140", whiteSpace: "nowrap" }}>
            <I name="arrowDown" size={14} />엑셀
          </button>
        </div>

        {/* 헤더 */}
        {(() => {
          const gridCols = "56px minmax(90px,1fr) minmax(100px,1.1fr) minmax(140px,1.3fr) 100px 84px 72px 130px 90px";
          return (
            <>
              <div style={{ display: "grid", gridTemplateColumns: gridCols, alignItems: "center", gap: 10, padding: "6px 16px", fontSize: 12, color: "var(--ts)", fontWeight: 700 }}>
                <span>브랜드</span><span>대상자</span><span>법원</span><span>사건번호</span>
                <span>접수일</span><span>상태</span><span>원/피고</span>
                <span style={{ textAlign: "right" }}>금액</span><span style={{ textAlign: "center" }}>매칭</span>
              </div>

              {/* 리스트 */}
              {filtered.length === 0
                ? <div style={{ padding: 32, textAlign: "center", color: "var(--tm)", background: "var(--card)", borderRadius: 12, border: "1px solid var(--brd)" }}>민사소송 사건이 없습니다.</div>
                : <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {filtered.map(c => {
                      const debtor     = getDebtor(c.debtorId);
                      const isMatching = matchingCase?.id === c.id;
                      return (
                        <div key={c.id} style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                          <div
                            onClick={() => !isMatching && setSelCase(c)}
                            style={{ background: "var(--card)", borderRadius: isMatching ? "10px 10px 0 0" : 10, border: "1px solid var(--brd)", borderBottom: isMatching ? "none" : "1px solid var(--brd)", padding: "13px 16px", cursor: "pointer", display: "grid", gridTemplateColumns: gridCols, alignItems: "center", gap: 10 }}
                            onMouseEnter={e => { if (!isMatching) e.currentTarget.style.background = "var(--hover)"; }}
                            onMouseLeave={e => { if (!isMatching) e.currentTarget.style.background = "var(--card)"; }}
                          >
                            <span>{c.brand ? <BrandBadge code={c.brand} brands={config.brands} /> : "-"}</span>
                            <span style={{ fontSize: 14, fontWeight: 600 }}>{c.defendant || "-"}</span>
                            <span style={{ fontSize: 13, color: "var(--ts)" }}>{c.court}</span>
                            <span className="mono" style={{ fontSize: 13, color: "var(--tm)" }}>{c.caseNumber}</span>
                            <span style={{ fontSize: 13, color: "var(--ts)" }}>{c.filingDate || "-"}</span>
                            <span>{c.progressStatus ? <Badge status={c.progressStatus} /> : "-"}</span>
                            <span>{c.caseStatus ? <Badge status={c.caseStatus} small /> : "-"}</span>
                            <span className="mono" style={{ fontSize: 14, color: debtor ? "var(--ok)" : "var(--tm)", fontWeight: 600, textAlign: "right" }}>{debtor ? fmt(debtor.finalBalanceLegal) : "-"}</span>
                            <span style={{ textAlign: "center" }}>
                              {debtor
                                ? <button onClick={e => { e.stopPropagation(); setMatchingCase({ id: c.id }); setMatchQ(""); }}
                                    style={{ fontSize: 11, padding: "3px 9px", borderRadius: 5, background: "var(--bg2)", color: "var(--tm)", border: "1px solid var(--brd)", cursor: "pointer" }}>재매칭</button>
                                : <button onClick={e => { e.stopPropagation(); setMatchingCase({ id: c.id }); setMatchQ(""); }}
                                    style={{ fontSize: 12, padding: "4px 10px", borderRadius: 6, background: "#eff6ff", color: "#1d4ed8", border: "1px solid #bfdbfe", cursor: "pointer", fontWeight: 600 }}>연결</button>
                              }
                            </span>
                          </div>
                          {isMatching && <ManualMatchPanel caseId={c.id} onClose={() => { setMatchingCase(null); setMatchQ(""); }} />}
                        </div>
                      );
                    })}
                  </div>
              }
            </>
          );
        })()}
      </div>
    );
  });

  // ─── Admin View ─────────────────────────────────────────
  const [adminAddUserForm, setAdminAddUserForm] = useState(null);
  const [adminResetPwId,   setAdminResetPwId]   = useState(null);
  const [adminResetPwVal,  setAdminResetPwVal]  = useState("");
  const adminView = (() => {
    const mainTab = adminMainTab, setMainTab = setAdminMainTab;
    const settingTab = adminSettingTab, setSettingTab = setAdminSettingTab;
    const newItem = adminNewItem, setNewItem = setAdminNewItem;
    const editingRule = adminEditingRule, setEditingRule = setAdminEditingRule;

    const ListEditor = useStableComponent(({ title, items, onAdd, onRemove, onEdit }) => {
      const [editIdx, setEditIdx] = useState(-1);
      const [editVal, setEditVal] = useState("");
      return (
        <div style={{ background: "var(--card)", borderRadius: 12, padding: 20, border: "1px solid var(--brd)" }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>{title}</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <KoreanInput value={newItem} onChange={e => setNewItem(e.target.value)} placeholder="새 항목 입력..." style={{ flex: 1, ...inp }} onKeyDown={e => { if (e.key === "Enter" && newItem.trim()) { onAdd(newItem.trim()); setNewItem(""); } }} />
            <button onClick={() => { if (newItem.trim()) { onAdd(newItem.trim()); setNewItem(""); } }} style={{ display: "flex", alignItems: "center", gap: 4, padding: "8px 16px", borderRadius: 8, background: "var(--acc)", color: "#fff", fontSize: 12, fontWeight: 600 }}><I name="plus" size={14} />추가</button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {items.map((item, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "var(--bg)", borderRadius: 8, gap: 8 }}>
                {editIdx === i ? (
                  <>
                    <KoreanInput value={editVal} onChange={e => setEditVal(e.target.value)} style={{ flex: 1, ...inp, padding: "4px 8px" }} autoFocus onKeyDown={e => { if (e.key === "Enter" && editVal.trim()) { onEdit(i, editVal.trim()); setEditIdx(-1); } if (e.key === "Escape") setEditIdx(-1); }} />
                    <button onClick={() => { if (editVal.trim()) { onEdit(i, editVal.trim()); setEditIdx(-1); } }} style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, background: "var(--ok)", color: "#fff", fontWeight: 600 }}>저장</button>
                    <button onClick={() => setEditIdx(-1)} style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, background: "var(--bg)", color: "var(--tm)", border: "1px solid var(--brd)" }}>취소</button>
                  </>
                ) : (
                  <>
                    <span style={{ fontSize: 13, flex: 1 }}>{item}</span>
                    <button onClick={() => { setEditIdx(i); setEditVal(item); }} style={{ background: "none", color: "var(--ts)", padding: 4 }}><I name="edit" size={14} /></button>
                    <button onClick={() => { if (confirm(`"${item}"을 삭제하시겠습니까?`)) onRemove(i); }} style={{ background: "none", color: "var(--err)", padding: 4 }}><I name="trash" size={14} /></button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      );
    });

    const DocsFolderConfig = useStableComponent(() => {
      const [rootPath, setRootPath] = useState("");
      const [saved, setSaved] = useState(null);
      const [saving, setSaving] = useState(false);
      const [indexStatus, setIndexStatus] = useState(null);
      const [reindexing, setReindexing] = useState(false);

      const loadStatus = () => {
        fetch("/api/admin/docs-config").then(r => r.json()).then(d => { setSaved(d.rootPath || ""); setRootPath(d.rootPath || ""); }).catch(() => {});
        fetch("/api/admin/index-status").then(r => r.json()).then(d => setIndexStatus(d)).catch(() => {});
      };
      useEffect(() => { loadStatus(); }, []);

      const handleSave = async () => {
        if (!rootPath.trim()) return;
        if (rootPath.trim().startsWith("http")) { showToast("URL이 아닌 로컬 폴더 경로를 입력해주세요 (예: C:\\Users\\...)", "err"); return; }
        setSaving(true);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        try {
          await fetch("/api/admin/docs-config", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rootPath: rootPath.trim() }), signal: ctrl.signal });
          clearTimeout(timer);
          setSaved(rootPath.trim()); showToast("서류 폴더 경로 저장 완료");
        } catch (e) {
          clearTimeout(timer);
          showToast(e.name === "AbortError" ? "저장 시간 초과 — 서버가 실행 중인지 확인해주세요" : "저장 실패", "err");
        }
        setSaving(false);
      };

      const handleReindex = async () => {
        if (!saved) { showToast("먼저 폴더 경로를 저장해주세요", "err"); return; }
        setReindexing(true);
        showToast("인덱스 구축 시작 — 파일 수에 따라 1~3분 소요됩니다");
        try {
          const r = await fetch("/api/admin/reindex", { method: "POST" }).then(x => x.json());
          if (r.ok) { showToast(`인덱스 완료 — ${r.indexed.toLocaleString()}개 파일 등록`); loadStatus(); }
          else showToast(`인덱스 실패: ${r.error}`, "err");
        } catch { showToast("인덱스 실패 — 서버 연결 확인", "err"); }
        setReindexing(false);
      };

      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ background: "var(--card)", borderRadius: 12, padding: 20, border: "1px solid var(--brd)" }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>서류 폴더 경로 설정</div>
            <div style={{ fontSize: 12, color: "var(--tm)", marginBottom: 16, lineHeight: 1.6 }}>
              채무자 서류가 저장된 OneDrive 폴더의 <b>서버 로컬 경로</b>를 입력하세요.<br />
              예: <code style={{ background: "var(--bg)", padding: "2px 6px", borderRadius: 4 }}>C:/Users/hjbae/OneDrive - 바로고</code>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <KoreanInput value={rootPath} onChange={e => setRootPath(e.target.value)} placeholder="폴더 경로 입력..." style={{ flex: 1 }} />
              <button onClick={handleSave} disabled={saving || !rootPath.trim()} style={{ padding: "8px 18px", borderRadius: 8, background: "var(--acc)", color: "#fff", fontSize: 12, fontWeight: 600, opacity: saving ? 0.6 : 1 }}>
                {saving ? "저장 중..." : "저장"}
              </button>
            </div>
            {saved && <div style={{ marginTop: 10, fontSize: 12, color: "var(--ok)", display: "flex", alignItems: "center", gap: 6 }}>
              <I name="check" size={13} /> 현재 경로: <span style={{ color: "var(--tp)", fontFamily: "monospace" }}>{saved}</span>
            </div>}
          </div>

          <div style={{ background: "var(--card)", borderRadius: 12, padding: 20, border: "1px solid var(--brd)" }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>파일 인덱스</div>
            <div style={{ fontSize: 12, color: "var(--tm)", marginBottom: 14, lineHeight: 1.6 }}>
              OneDrive 파일을 DB에 미리 인덱싱해두면 신용조회·서류 검색이 빨라집니다.<br />
              새 파일을 추가하거나 폴더 경로를 변경한 후 재구성을 눌러주세요.
            </div>
            {indexStatus && (
              <div style={{ marginBottom: 12, fontSize: 12, color: "var(--tm)" }}>
                {indexStatus.count > 0
                  ? <span style={{ color: "var(--ok)" }}>✓ {indexStatus.count.toLocaleString()}개 파일 인덱싱됨 · {indexStatus.lastAt?.slice(0,16)}</span>
                  : <span style={{ color: "var(--err)" }}>인덱스 없음 — 아래 버튼을 눌러 구축하세요</span>}
              </div>
            )}
            <button onClick={handleReindex} disabled={reindexing || !saved} style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 20px", borderRadius: 8, background: reindexing ? "var(--bg)" : "#3b82f6", color: reindexing ? "var(--tm)" : "#fff", fontSize: 12, fontWeight: 600, border: reindexing ? "1px solid var(--brd)" : "none", opacity: !saved ? 0.4 : 1 }}>
              {reindexing ? <><span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>⟳</span> 인덱싱 중 (1~3분)...</> : "🔄 인덱스 재구성"}
            </button>
          </div>
        </div>
      );
    });

    const BrandEditor = useStableComponent(() => {
      const [nb, setNb] = useState({ code: "", name: "", color: "#3b82f6" });
      const [editIdx, setEditIdx] = useState(-1);
      const [eb, setEb] = useState({ code: "", name: "", color: "" });
      return (
        <div style={{ background: "var(--card)", borderRadius: 12, padding: 20, border: "1px solid var(--brd)" }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>브랜드 관리</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <KoreanInput value={nb.code} onChange={e => setNb(p => ({ ...p, code: e.target.value }))} placeholder="코드 (1글자)" style={{ width: 80, ...inp }} maxLength={2} />
            <KoreanInput value={nb.name} onChange={e => setNb(p => ({ ...p, name: e.target.value }))} placeholder="브랜드명" style={{ flex: 1, ...inp }} />
            <input type="color" value={nb.color} onChange={e => setNb(p => ({ ...p, color: e.target.value }))} style={{ width: 40, height: 36, border: "none", cursor: "pointer" }} />
            <button onClick={() => { if (nb.code && nb.name) { setConfig(p => ({ ...p, brands: [...p.brands, { ...nb }] })); setNb({ code: "", name: "", color: "#3b82f6" }); showToast("브랜드 추가 완료"); } }} style={{ display: "flex", alignItems: "center", gap: 4, padding: "8px 16px", borderRadius: 8, background: "var(--acc)", color: "#fff", fontSize: 12, fontWeight: 600 }}><I name="plus" size={14} />추가</button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {config.brands.map((b, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "var(--bg)", borderRadius: 8, gap: 8 }}>
                {editIdx === i ? (
                  <>
                    <KoreanInput value={eb.code} onChange={e => setEb(p => ({ ...p, code: e.target.value }))} style={{ width: 60, ...inp, padding: "4px 8px" }} maxLength={2} />
                    <KoreanInput value={eb.name} onChange={e => setEb(p => ({ ...p, name: e.target.value }))} style={{ flex: 1, ...inp, padding: "4px 8px" }} />
                    <input type="color" value={eb.color} onChange={e => setEb(p => ({ ...p, color: e.target.value }))} style={{ width: 32, height: 28, border: "none", cursor: "pointer" }} />
                    <button onClick={() => { if (eb.code && eb.name) { const oldBrand = config.brands[i]; setConfig(p => ({ ...p, brands: p.brands.map((x, idx) => idx === i ? { ...eb } : x) })); updateBrandInDebtors(oldBrand.code, eb); setEditIdx(-1); showToast("브랜드 수정 완료"); } }} style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, background: "var(--ok)", color: "#fff", fontWeight: 600 }}>저장</button>
                    <button onClick={() => setEditIdx(-1)} style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, background: "var(--bg)", color: "var(--tm)", border: "1px solid var(--brd)" }}>취소</button>
                  </>
                ) : (
                  <>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1 }}>
                      <div style={{ width: 16, height: 16, borderRadius: 4, background: b.color }} />
                      <BrandBadge code={b.code} brands={config.brands} />
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{b.name}</span>
                      <span className="mono" style={{ fontSize: 11, color: "var(--tm)" }}>{b.code}</span>
                    </div>
                    <button onClick={() => { setEditIdx(i); setEb({ ...b }); }} style={{ background: "none", color: "var(--ts)", padding: 4 }}><I name="edit" size={14} /></button>
                    <button onClick={() => { if (confirm(`"${b.name}" 브랜드를 삭제하시겠습니까?`)) removeBrandFromConfig(i); }} style={{ background: "none", color: "var(--err)", padding: 4 }}><I name="trash" size={14} /></button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      );
    });

    const CONFIG_TO_DEBTOR_FIELD = {
      assignees: "assignee", hubNames: "hubName", debtCauses: "debtCause",
      collStatuses: "collectionStatus", categories: "category",
      activityTypes: null, paymentChannels: null, installmentTimings: null,
      courts: null, chargeTypes: null, policeStations: null,
    };
    const cascadeConfigEdit = (key, oldVal, newVal) => {
      const debtorField = CONFIG_TO_DEBTOR_FIELD[key];
      if (!debtorField) return;
      setData(prev => {
        const updateArr = (arr, field) => arr.map(item => item[field] === oldVal ? { ...item, [field]: newVal } : item);
        return {
          ...prev,
          debtors: prev.debtors.map(d => d[debtorField] === oldVal ? { ...d, [debtorField]: newVal } : d),
          payments: debtorField === "assignee" ? updateArr(prev.payments, "assignee") : prev.payments,
          activities: debtorField === "assignee" ? updateArr(prev.activities, "assignee") : prev.activities,
          installmentPlans: debtorField === "assignee" ? updateArr(prev.installmentPlans, "assignee") : prev.installmentPlans,
          complaints: debtorField === "assignee" ? updateArr(prev.complaints, "assignee") : prev.complaints,
        };
      });
      if (sel && sel[debtorField] === oldVal) setSel(prev => ({ ...prev, [debtorField]: newVal }));
    };
    const updateList = (key) => ({
      onAdd: (item) => { setConfig(p => ({ ...p, [key]: [...p[key], item] })); showToast("추가 완료"); },
      onEdit: (idx, newVal) => {
        const oldVal = config[key][idx];
        setConfig(p => ({ ...p, [key]: p[key].map((v, i) => i === idx ? newVal : v) }));
        if (oldVal !== newVal) cascadeConfigEdit(key, oldVal, newVal);
        showToast("수정 완료");
      },
      onRemove: (idx) => { setConfig(p => ({ ...p, [key]: p[key].filter((_, i) => i !== idx) })); showToast("삭제 완료"); },
    });

    const settingTabs = ["담당자","브랜드","허브/지점","채무발생원인","추심상태","분류","활동유형","입금채널","납부시기","법원","죄명","경찰서","서류 폴더"];

    return (
      <div className="anim" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* 상단 4탭 */}
        <div style={{ display: "flex", gap: 2, background: "var(--card)", borderRadius: 10, padding: 4, border: "1px solid var(--brd)" }}>
          {[{ k: "settings", l: "시스템 설정" }, { k: "users", l: `사용자 관리 (${users.length})` }, { k: "alerts", l: "알림 설정" }, { k: "slack", l: "Slack 수집" }, { k: "logs", l: `수정 로그${adminEditLogs ? ` (${adminEditLogs.length})` : ""}` }, ...(currentUser?.name === "김준원" ? [{ k: "stats", l: "통계" }] : [])].map(t => (
            <button key={t.k} onClick={() => { setMainTab(t.k); if (t.k === "logs") setAdminEditLogs(null); if (t.k === "stats") setAdminStats(null); }} style={{ flex: 1, padding: "10px 0", borderRadius: 8, fontSize: 13, fontWeight: 600, background: mainTab === t.k ? "var(--bg)" : "transparent", color: mainTab === t.k ? "var(--tp)" : "var(--tm)" }}>{t.l}</button>
          ))}
        </div>

        {/* 시스템 설정 */}
        {mainTab === "settings" && <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {settingTabs.map(t => (
              <button key={t} onClick={() => { setSettingTab(t); setNewItem(""); }} style={{ padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 500, background: settingTab === t ? "var(--acc)" : "var(--bg)", color: settingTab === t ? "#fff" : "var(--tm)" }}>{t}</button>
            ))}
          </div>
          {settingTab === "담당자" && <ListEditor title="담당자 관리" items={config.assignees} onAdd={updateList("assignees").onAdd} onEdit={updateList("assignees").onEdit} onRemove={(idx) => removeAssigneeFromConfig(idx)} />}
          {settingTab === "브랜드" && <BrandEditor />}
          {settingTab === "허브/지점" && <ListEditor title="허브/지점 관리" items={config.hubNames} {...updateList("hubNames")} />}
          {settingTab === "채무발생원인" && <ListEditor title="채무발생원인 관리" items={config.debtCauses} {...updateList("debtCauses")} />}
          {settingTab === "추심상태" && <ListEditor title="추심상태 관리" items={config.collStatuses} {...updateList("collStatuses")} />}
          {settingTab === "분류" && <ListEditor title="채권 분류 관리" items={config.categories} {...updateList("categories")} />}
          {settingTab === "활동유형" && <ListEditor title="활동 유형 관리" items={config.activityTypes} {...updateList("activityTypes")} />}
          {settingTab === "입금채널" && <ListEditor title="입금 채널 관리" items={config.paymentChannels} {...updateList("paymentChannels")} />}
          {settingTab === "납부시기" && <ListEditor title="납부 시기 관리" items={config.installmentTimings} {...updateList("installmentTimings")} />}
          {settingTab === "법원" && <ListEditor title="법원 관리" items={config.courts} {...updateList("courts")} />}
          {settingTab === "죄명" && <ListEditor title="죄명 관리" items={config.chargeTypes} {...updateList("chargeTypes")} />}
          {settingTab === "경찰서" && <ListEditor title="경찰서 관리" items={config.policeStations} {...updateList("policeStations")} />}
          {settingTab === "서류 폴더" && <DocsFolderConfig />}
        </>}

        {/* 사용자 관리 */}
        {mainTab === "users" && (() => {
          const addUserForm = adminAddUserForm, setAddUserForm = setAdminAddUserForm;
          const resetPwId   = adminResetPwId,   setResetPwId   = setAdminResetPwId;
          const resetPwVal  = adminResetPwVal,  setResetPwVal  = setAdminResetPwVal;
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {/* 사용자 초대 버튼 */}
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button onClick={() => setAddUserForm({ name:"", email:"", avatar:"", role:"member", password:"" })}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, background: "var(--acc)", color: "#fff", fontSize: 13, fontWeight: 600, border: "none", cursor: "pointer" }}>
                  <I name="userPlus" size={14} /> 사용자 추가
                </button>
              </div>

              {/* 사용자 추가 폼 */}
              {addUserForm && (
                <div style={{ background: "var(--card)", borderRadius: 12, padding: 20, border: "2px solid var(--acc)" }}>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>새 사용자 추가</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
                    {[["이름", "name", "이름"], ["이메일", "email", "이메일 주소"], ["아바타", "avatar", "1글자"], ["초기 비밀번호", "password", "비밀번호"]].map(([label, key, ph]) => (
                      <div key={key}>
                        <div style={{ fontSize: 11, color: "var(--tm)", marginBottom: 4 }}>{label}</div>
                        <KoreanInput type={key === "password" ? "password" : "text"} value={addUserForm[key]} onChange={e => setAddUserForm(p => ({ ...p, [key]: e.target.value }))} placeholder={ph} maxLength={key === "avatar" ? 1 : undefined}
                          style={{ width: "100%", padding: "7px 10px", borderRadius: 8, fontSize: 13, border: "1px solid var(--brd)", background: "var(--bg)", color: "var(--tp)", boxSizing: "border-box" }} />
                      </div>
                    ))}
                    <div>
                      <div style={{ fontSize: 11, color: "var(--tm)", marginBottom: 4 }}>역할</div>
                      <select value={addUserForm.role} onChange={e => setAddUserForm(p => ({ ...p, role: e.target.value }))} style={{ width: "100%", padding: "7px 10px", fontSize: 13, borderRadius: 8, border: "1px solid var(--brd)", background: "var(--bg)" }}>
                        {ROLES.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
                      </select>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button onClick={() => setAddUserForm(null)} style={{ padding: "7px 16px", borderRadius: 8, fontSize: 12, background: "var(--bg)", color: "var(--tm)", border: "1px solid var(--brd)", cursor: "pointer" }}>취소</button>
                    <button onClick={() => {
                      if (!addUserForm.name.trim() || !addUserForm.password.trim()) { showToast("이름과 비밀번호는 필수입니다"); return; }
                      const newUser = { id: uid("U"), name: addUserForm.name.trim(), email: addUserForm.email.trim(), avatar: addUserForm.avatar.trim() || addUserForm.name[0], role: addUserForm.role, approved: true, registeredAt: today(), password: addUserForm.password };
                      setUsers(prev => [...prev, newUser]);
                      setAddUserForm(null);
                      showToast(`${newUser.name} 추가 완료`);
                    }} style={{ padding: "7px 16px", borderRadius: 8, fontSize: 12, fontWeight: 700, background: "var(--acc)", color: "#fff", border: "none", cursor: "pointer" }}>추가</button>
                  </div>
                </div>
              )}

              {/* 사용자 목록 */}
              {users.map((u, i) => (
                <div key={u.id || u.name} style={{ background: "var(--card)", borderRadius: 12, padding: 16, border: "1px solid var(--brd)", display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ width: 44, height: 44, borderRadius: 12, background: u.approved ? "var(--acc)18" : "#64748b18", color: u.approved ? "var(--acc)" : "#64748b", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700, flexShrink: 0 }}>{u.avatar}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                        <span style={{ fontSize: 14, fontWeight: 600 }}>{u.name}</span>
                        <span style={{ fontSize: 11, color: "var(--tm)" }}>{u.email}</span>
                        {!u.approved && <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 4, background: "#f59e0b18", color: "#b45309" }}>승인 대기</span>}
                        {currentUser?.id === u.id && <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 4, background: "#3b82f618", color: "#3b82f6" }}>나</span>}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--tm)" }}>가입일: {u.registeredAt}</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {/* 역할 배지 (비관리자에게는 select 대신 텍스트로) */}
                      {isAdmin ? (
                        <select value={u.role} onChange={e => {
                          const newRole = e.target.value;
                          setUsers(prev => prev.map((x) => x.id === u.id ? { ...x, role: newRole } : x));
                          if (currentUser?.id === u.id) setCurrentUser(prev => ({ ...prev, role: newRole }));
                          showToast(`${u.name} 권한: ${ROLES.find(r => r.key === newRole)?.label}`);
                        }} style={{ padding: "6px 10px", fontSize: 12, borderRadius: 6, border: "1px solid var(--brd)", background: "var(--inp)" }}>
                          {ROLES.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
                        </select>
                      ) : (
                        <span style={{ fontSize: 12, padding: "5px 10px", borderRadius: 6, background: "var(--bg)", color: "var(--ts)", border: "1px solid var(--brd)" }}>
                          {ROLES.find(r => r.key === u.role)?.label || u.role}
                        </span>
                      )}
                      {/* 비밀번호 재설정 — 본인 또는 관리자 */}
                      {(isAdmin || currentUser?.id === u.id) && (
                        <button onClick={() => { setResetPwId(u.id); setResetPwVal(""); }} style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 10px", borderRadius: 6, fontSize: 11, background: "var(--bg)", color: "var(--ts)", border: "1px solid var(--brd)", cursor: "pointer" }}>
                          <I name="key" size={12} /> 비밀번호
                        </button>
                      )}
                      {/* 승인/비활성화/삭제 — 관리자만 */}
                      {isAdmin && !u.approved && (
                        <button onClick={() => { setUsers(prev => prev.map(x => x.id === u.id ? { ...x, approved: true } : x)); showToast(`${u.name} 승인 완료`); }} style={{ padding: "6px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: "var(--ok)", color: "#fff", cursor: "pointer", border: "none" }}>승인</button>
                      )}
                      {isAdmin && u.approved && currentUser?.id !== u.id && (
                        <button onClick={() => { setUsers(prev => prev.map(x => x.id === u.id ? { ...x, approved: false } : x)); showToast(`${u.name} 비활성화`); }} style={{ padding: "6px 12px", borderRadius: 6, fontSize: 12, background: "var(--bg)", color: "var(--tm)", border: "1px solid var(--brd)", cursor: "pointer" }}>비활성화</button>
                      )}
                      {isAdmin && currentUser?.id !== u.id && (
                        <button onClick={() => {
                          if (!confirm(`"${u.name}" 계정을 삭제하시겠습니까?`)) return;
                          setUsers(prev => prev.filter(x => x.id !== u.id));
                          showToast(`${u.name} 삭제 완료`);
                        }} style={{ padding: "6px 8px", borderRadius: 6, fontSize: 11, background: "var(--bg)", color: "var(--err)", border: "1px solid #fecaca", cursor: "pointer" }}>
                          <I name="trash" size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                  {/* 비밀번호 재설정 인라인 */}
                  {resetPwId === u.id && (
                    <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 12px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--brd)" }}>
                      <I name="key" size={14} />
                      <span style={{ fontSize: 12, color: "var(--tm)", flexShrink: 0 }}>새 비밀번호</span>
                      <input type="password" value={resetPwVal} onChange={e => setResetPwVal(e.target.value)} placeholder="새 비밀번호 입력" style={{ flex: 1, padding: "6px 10px", fontSize: 12, borderRadius: 6, border: "1px solid var(--brd)", background: "var(--card)", color: "var(--tp)" }} onKeyDown={e => { if (e.key === "Enter" && resetPwVal.trim()) { setUsers(prev => prev.map(x => x.id === u.id ? { ...x, password: resetPwVal } : x)); setResetPwId(null); showToast("비밀번호 변경 완료"); } }} />
                      <button onClick={() => { if (!resetPwVal.trim()) return; setUsers(prev => prev.map(x => x.id === u.id ? { ...x, password: resetPwVal } : x)); setResetPwId(null); showToast("비밀번호 변경 완료"); }} style={{ padding: "6px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: "var(--acc)", color: "#fff", border: "none", cursor: "pointer" }}>저장</button>
                      <button onClick={() => setResetPwId(null)} style={{ padding: "6px 10px", borderRadius: 6, fontSize: 12, background: "var(--bg)", color: "var(--tm)", border: "1px solid var(--brd)", cursor: "pointer" }}>취소</button>
                    </div>
                  )}
                </div>
              ))}

              <div style={{ background: "var(--card)", borderRadius: 12, padding: 16, border: "1px solid var(--brd)" }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>권한 안내</div>
                {ROLES.map(r => (<div key={r.key} style={{ display: "flex", gap: 10, padding: "4px 0", fontSize: 12 }}><span style={{ fontWeight: 600, minWidth: 60, color: "var(--acc)" }}>{r.label}</span><span style={{ color: "var(--ts)" }}>{r.desc}</span></div>))}
              </div>
            </div>
          );
        })()}

        {/* 알림 설정 */}
        {mainTab === "alerts" && <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>알림 규칙 ({alertRules.length}개)</span>
            <button onClick={() => { const nr = { id: uid("rule"), name: "새 알림 규칙", enabled: false, trigger: TRIGGER_TYPES[0].key, condition: "", target: "channel", channel: "#npl-알림", assignee: "", assigneeSlackId: "" }; addAlertRule(nr); setEditingRule(nr.id); }} style={{ display: "flex", alignItems: "center", gap: 4, padding: "7px 14px", borderRadius: 8, background: "var(--acc)", color: "#fff", fontSize: 12, fontWeight: 600 }}><I name="plus" size={14} />규칙 추가</button>
          </div>
          {alertRules.map((rule) => (
            <div key={rule.id} style={{ background: "var(--card)", borderRadius: 12, border: "1px solid var(--brd)", overflow: "hidden" }}>
              <div style={{ padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: editingRule === rule.id ? "1px solid var(--brd)" : "none" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <button onClick={() => patchAlertRule(rule.id, { enabled: !rule.enabled })} style={{ width: 40, height: 22, borderRadius: 11, background: rule.enabled ? "var(--ok)" : "#cbd5e1", position: "relative", border: "none", cursor: "pointer", transition: "background .2s" }}>
                    <div style={{ width: 18, height: 18, borderRadius: 9, background: "#fff", position: "absolute", top: 2, left: rule.enabled ? 20 : 2, transition: "left .2s", boxShadow: "0 1px 3px rgba(0,0,0,.2)" }} />
                  </button>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{rule.name}</span>
                  <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, background: "var(--bg)", color: "var(--tm)" }}>{TRIGGER_TYPES.find(t => t.key === rule.trigger)?.label}</span>
                  <span style={{ fontSize: 11, color: "var(--tm)" }}>→ {rule.target === "channel" ? rule.channel : `DM: ${rule.assignee}${rule.assigneeSlackId ? "" : " (Slack ID 미등록)"}`}</span>
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  <button onClick={() => setEditingRule(editingRule === rule.id ? null : rule.id)} style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, background: "var(--bg)", color: "var(--ts)", border: "1px solid var(--brd)" }}><I name="edit" size={13} /></button>
                  <button onClick={() => { if (confirm("이 규칙을 삭제하시겠습니까?")) deleteAlertRule(rule.id); }} style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, background: "#ef444410", color: "var(--err)", border: "1px solid #ef444430" }}><I name="trash" size={13} /></button>
                </div>
              </div>
              {editingRule === rule.id && (
                <div style={{ padding: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <Field label="규칙 이름"><KoreanInput value={rule.name} onChange={e => patchAlertRule(rule.id, { name: e.target.value })} style={inp} /></Field>
                  <Field label="트리거"><select value={rule.trigger} onChange={e => patchAlertRule(rule.id, { trigger: e.target.value })} style={inp}>{TRIGGER_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}</select></Field>
                  <Field label="조건 설명"><KoreanInput value={rule.condition} onChange={e => patchAlertRule(rule.id, { condition: e.target.value })} style={inp} placeholder="예: 잔액 1,000만원 초과" /></Field>
                  <Field label="알림 대상"><select value={rule.target} onChange={e => patchAlertRule(rule.id, { target: e.target.value })} style={inp}><option value="channel">Slack 채널</option><option value="dm">개인 DM</option></select></Field>
                  {rule.target === "channel" && <Field label="Slack 채널"><KoreanInput value={rule.channel} onChange={e => patchAlertRule(rule.id, { channel: e.target.value })} style={inp} placeholder="#채널명 (표시용 라벨 — 실제 발송은 서버에 설정된 알림 채널로 통합 전송됩니다)" /></Field>}
                  {rule.target === "dm" && <Field label="DM 대상자"><select value={rule.assignee} onChange={e => patchAlertRule(rule.id, { assignee: e.target.value })} style={inp}><option value="">-- 선택 --</option>{users.filter(u => u.approved).map(u => <option key={u.id || u.name} value={u.name}>{u.name}</option>)}</select></Field>}
                  {rule.target === "dm" && <Field label="DM 대상자 Slack ID"><KoreanInput value={rule.assigneeSlackId || ""} onChange={e => patchAlertRule(rule.id, { assigneeSlackId: e.target.value.trim() })} style={inp} placeholder="예: U0123ABCDE (Slack 프로필 > 멤버 ID 복사)" /></Field>}
                </div>
              )}
            </div>
          ))}
          <div style={{ background: "var(--card)", borderRadius: 12, padding: 16, border: "1px solid var(--brd)" }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>트리거 유형 안내</div>
            {TRIGGER_TYPES.map(t => (<div key={t.key} style={{ display: "flex", gap: 10, padding: "3px 0", fontSize: 12 }}><span className="mono" style={{ fontWeight: 500, minWidth: 160, color: "var(--tm)" }}>{t.key}</span><span style={{ color: "var(--ts)" }}>{t.label}</span>{t.key === "seizure_collected" && <span style={{ fontSize: 11, color: "var(--err)" }}>(아직 자동 감지 미지원)</span>}</div>))}
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px dashed var(--brd)", fontSize: 11, color: "var(--tm)", lineHeight: 1.6 }}>
              분할상환 미납/회생 변제금 미납/고액 잔액/장기 미연락은 30분마다 서버가 자동 점검해 하루 1회 요약 발송하고,
              신규 입금/신규 채권 등록/추심상태 변경은 발생 즉시 발송됩니다. DM 발송은 대상자의 Slack ID를 등록해야 실제로 개인에게 전달되며,
              등록하지 않으면 알림 채널로 대체 발송됩니다.
            </div>
          </div>
        </div>}

        {/* Slack 수집 */}
        {mainTab === "slack" && <SlackIngestView showToast={showToast} reloadFromBackend={reloadFromBackend} currentUser={currentUser} isAdmin={isAdmin} />}

        {/* 수정 로그 (DB 영구 보존) */}
        {mainTab === "logs" && (() => {
          const logs = adminEditLogs || [];
          const loadLogs = () => {
            setAdminEditLogs(null);
            setAdminEditLogsLoading(true);
            fetch("/api/edit-logs")
              .then(r => r.ok ? r.json() : [])
              .then(rows => { setAdminEditLogs(rows); setAdminEditLogsLoading(false); })
              .catch(() => { setAdminEditLogs([]); setAdminEditLogsLoading(false); });
          };
          // 로그 항목을 채무자별로 그룹핑 (같은 시각, 같은 사람의 수정을 묶음)
          const grouped = [];
          logs.forEach(l => {
            const last = grouped[grouped.length - 1];
            const sameGroup = last && last.debtorId === l.debtorId && last.changedBy === l.changedBy
              && Math.abs(new Date(last.changedAt) - new Date(l.changedAt)) < 5000; // 5초 이내 동일인 동일채무자
            if (sameGroup) {
              last.items.push(l);
            } else {
              grouped.push({ debtorId: l.debtorId, debtorName: l.debtorName, changedBy: l.changedBy, changedAt: l.changedAt, items: [l] });
            }
          });
          return (
            <div style={{ background: "var(--card)", borderRadius: 12, border: "1px solid var(--brd)", overflow: "hidden" }}>
              <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--brd)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>수정 로그 ({logs.length}건)</span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={loadLogs} style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 10px", borderRadius: 6, background: "#3b82f618", color: "#3b82f6", fontSize: 11, fontWeight: 600, border: "1px solid #3b82f640", cursor: "pointer" }}>
                    {adminEditLogsLoading ? "로딩중…" : "새로고침"}
                  </button>
                  <button onClick={() => {
                    const rows = logs.map(l => [l.changedAt, l.changedBy, l.debtorName, l.debtorId, l.fieldLabel || l.fieldName, l.oldValue, l.newValue]);
                    downloadCSV(`수정로그_${today()}.csv`, ["수정시각","수정자","채무자명","채무자ID","항목","변경전","변경후"], rows);
                  }} style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 10px", borderRadius: 6, background: "#10b98118", color: "#10b981", fontSize: 11, fontWeight: 600, border: "1px solid #10b98140", cursor: "pointer" }}>
                    <I name="arrowDown" size={12} />엑셀
                  </button>
                </div>
              </div>
              <div style={{ maxHeight: 620, overflow: "auto" }}>
                {adminEditLogsLoading && <div style={{ padding: 40, textAlign: "center", color: "var(--tm)" }}>로딩 중...</div>}
                {!adminEditLogsLoading && logs.length === 0 && <div style={{ padding: 40, textAlign: "center", color: "var(--tm)" }}>아직 기록된 수정 로그가 없습니다</div>}
                {!adminEditLogsLoading && grouped.map((g, gi) => (
                  <div key={gi} style={{ borderBottom: "1px solid var(--brd)" }}>
                    <div style={{ display: "flex", gap: 10, padding: "10px 16px", alignItems: "center", background: "var(--bg2)" }}>
                      <span className="mono" style={{ fontSize: 11, color: "var(--tm)", whiteSpace: "nowrap", flexShrink: 0 }}>{g.changedAt?.slice(0,16).replace("T"," ")}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: "#8b5cf618", color: "#8b5cf6", whiteSpace: "nowrap" }}>{g.changedBy}</span>
                      <span style={{ fontSize: 12, fontWeight: 600 }}>{g.debtorName}</span>
                      <span className="mono" style={{ fontSize: 10, color: "var(--ts)" }}>({g.debtorId})</span>
                      <span style={{ fontSize: 11, color: "var(--tm)" }}>— {g.items.length}개 항목 수정</span>
                    </div>
                    <div style={{ padding: "8px 16px 10px 16px", display: "flex", flexDirection: "column", gap: 4 }}>
                      {g.items.map((item, ii) => (
                        <div key={ii} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "3px 0" }}>
                          <span style={{ fontWeight: 600, color: "var(--tp)", minWidth: 90, flexShrink: 0 }}>{item.fieldLabel || item.fieldName}</span>
                          <span style={{ color: "var(--err)", background: "#ef444410", padding: "1px 6px", borderRadius: 4, textDecoration: "line-through", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.oldValue || "(없음)"}</span>
                          <span style={{ color: "var(--tm)", flexShrink: 0 }}>→</span>
                          <span style={{ color: "var(--ok)", background: "#10b98110", padding: "1px 6px", borderRadius: 4, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.newValue || "(없음)"}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {/* 통계 (김준원 전용) */}
        {mainTab === "stats" && currentUser?.name === "김준원" && (() => {
          const stats = adminStats || { access: { daily: [], monthly: [], yearly: [] }, volume: { daily: [], monthly: [], yearly: [] }, summary: [] };
          const loadStats = () => {
            setAdminStatsLoading(true);
            fetch("/api/admin/stats")
              .then(r => r.ok ? r.json() : null)
              .then(data => { setAdminStats(data || { access: { daily: [], monthly: [], yearly: [] }, volume: { daily: [], monthly: [], yearly: [] }, summary: [] }); setAdminStatsLoading(false); })
              .catch(() => setAdminStatsLoading(false));
          };
          const knownNames = users.map(u => u.name);
          const GRAN = [{ k: "daily", l: "일별", limit: 30 }, { k: "monthly", l: "월별", limit: 12 }, { k: "yearly", l: "연간", limit: 5 }];
          const fmtSeconds = (s) => { if (!s) return "-"; const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h > 0 ? `${h}시간 ${m}분` : `${m}분`; };
          const fmtChars = (n) => { if (!n) return "-"; return `${n.toLocaleString()}자`; };

          const renderStatTable = (rowsByGran, gran, setGran, valueKey, formatFn, title, csvNamePrefix, emptyHint) => {
            const g = GRAN.find(x => x.k === gran);
            const rows = rowsByGran[gran] || [];
            const extra = [...new Set(rows.map(r => r.user))].filter(u => !knownNames.includes(u)).sort();
            const cols = [...knownNames, ...extra];
            const periods = [...new Set(rows.map(r => r.period))].sort((a, b) => b.localeCompare(a)).slice(0, g.limit);
            const cellVal = (period, user) => { const r = rows.find(x => x.period === period && x.user === user); return r ? r[valueKey] : 0; };
            return (
              <div style={{ background: "var(--card)", borderRadius: 12, border: "1px solid var(--brd)", overflow: "hidden" }}>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--brd)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{title}</span>
                  <div style={{ display: "flex", gap: 6 }}>
                    {GRAN.map(x => (
                      <button key={x.k} onClick={() => setGran(x.k)} style={{ padding: "5px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, background: gran === x.k ? "var(--acc)" : "var(--bg)", color: gran === x.k ? "#fff" : "var(--tm)" }}>{x.l}</button>
                    ))}
                    <button onClick={() => {
                      const headers = ["기간", ...cols];
                      const csvRows = periods.map(p => [p, ...cols.map(u => cellVal(p, u))]);
                      downloadCSV(`${csvNamePrefix}_${today()}.csv`, headers, csvRows);
                    }} style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 10px", borderRadius: 6, background: "#10b98118", color: "#10b981", fontSize: 11, fontWeight: 600, border: "1px solid #10b98140", cursor: "pointer" }}>
                      <I name="arrowDown" size={12} />엑셀
                    </button>
                  </div>
                </div>
                <div style={{ overflow: "auto", maxHeight: 420 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, tableLayout: "fixed" }}>
                    <colgroup>
                      <col style={{ width: 130 }} />
                      {cols.map(u => <col key={u} style={{ width: 120 }} />)}
                    </colgroup>
                    <thead>
                      <tr style={{ background: "var(--bg2)" }}>
                        <th style={{ padding: "8px 12px", textAlign: "center", position: "sticky", left: 0, background: "var(--bg2)", borderRight: "1px solid var(--brd)" }}>기간</th>
                        {cols.map(u => <th key={u} style={{ padding: "8px 12px", textAlign: "center", whiteSpace: "nowrap", borderRight: "1px solid var(--brd)" }}>{u}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {periods.length === 0 && (
                        <tr><td colSpan={cols.length + 1} style={{ padding: 30, textAlign: "center", color: "var(--tm)" }}>{emptyHint}</td></tr>
                      )}
                      {periods.map(p => (
                        <tr key={p} style={{ borderTop: "1px solid var(--brd)" }}>
                          <td className="mono" style={{ padding: "8px 12px", textAlign: "center", position: "sticky", left: 0, background: "var(--card)", borderRight: "1px solid var(--brd)" }}>{p}</td>
                          {cols.map(u => <td key={u} style={{ padding: "8px 12px", textAlign: "center", borderRight: "1px solid var(--brd)" }}>{formatFn(cellVal(p, u))}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          };

          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button onClick={loadStats} style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 12px", borderRadius: 6, background: "#3b82f618", color: "#3b82f6", fontSize: 12, fontWeight: 600, border: "1px solid #3b82f640", cursor: "pointer" }}>
                  {adminStatsLoading ? "불러오는 중…" : "통계 새로고침"}
                </button>
              </div>
              {renderStatTable(stats.access, statsAccessGran, setStatsAccessGran, "seconds", fmtSeconds, "사용자별 접속시간", "접속시간", "오늘부터 접속시간을 수집합니다. 잠시 후 새로고침해 주세요.")}
              {renderStatTable(stats.volume, statsVolumeGran, setStatsVolumeGran, "bytes", fmtChars, "사용자별 데이터 입력량 (글자 1개 = 1바이트 가정)", "데이터입력량", "표시할 데이터가 없습니다")}
              <div style={{ background: "var(--card)", borderRadius: 12, border: "1px solid var(--brd)", overflow: "hidden" }}>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--brd)" }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>사용자별 요약</span>
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, tableLayout: "fixed" }}>
                  <colgroup>
                    <col style={{ width: 130 }} />
                    <col style={{ width: 120 }} />
                    <col />
                  </colgroup>
                  <thead>
                    <tr style={{ background: "var(--bg2)" }}>
                      <th style={{ padding: "8px 12px", textAlign: "center", borderRight: "1px solid var(--brd)" }}>사용자</th>
                      <th style={{ padding: "8px 12px", textAlign: "center", borderRight: "1px solid var(--brd)" }}>총 수정 건수</th>
                      <th style={{ padding: "8px 12px", textAlign: "center" }}>마지막 활동</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.summary.length === 0 && <tr><td colSpan={3} style={{ padding: 30, textAlign: "center", color: "var(--tm)" }}>표시할 데이터가 없습니다</td></tr>}
                    {stats.summary.map(s => (
                      <tr key={s.user} style={{ borderTop: "1px solid var(--brd)" }}>
                        <td style={{ padding: "8px 12px", textAlign: "center", fontWeight: 600, borderRight: "1px solid var(--brd)" }}>{s.user}</td>
                        <td style={{ padding: "8px 12px", textAlign: "center", borderRight: "1px solid var(--brd)" }}>{(s.totalEdits || 0).toLocaleString()}</td>
                        <td className="mono" style={{ padding: "8px 12px", textAlign: "center", color: "var(--tm)" }}>{s.lastActiveAt || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })()}
      </div>
    );
  })();

  // ─── Layout ─────────────────────────────────────────────
  const rehabSubItems = [
    { k: "회생",     cnt: (data.rehabilitations||[]).filter(r => r.type === "회생").length },
    { k: "파산/면책", cnt: (data.rehabilitations||[]).filter(r => r.type === "파산/면책").length },
  ];
  const debtorsSubItems = [
    { k: "채무자 목록", cnt: (data.debtors||[]).length },
    { k: "채무자 위치", cnt: (data.debtors||[]).filter(d => d.latestAddress).length },
  ];
  const navTabs = [
    { k: "dashboard",       l: "종합현황",        i: "dashboard" },
    { k: "issues",          l: "주요현안",         i: "flag" },
    { k: "debtors",         l: "채무자 관리",      i: "users",   sub: debtorsSubItems, subState: debtorsSubTab, setSub: (v) => { setDebtorsSubTab(v); if (v === "채무자 목록") goToDebtorList(); else { setTab("debtors"); setSel(null); } } },
    { k: "payments",        l: "입금내역",         i: "won" },
    { k: "installments",    l: "분할상환",         i: "calendar" },
    { k: "collection",      l: "추심의뢰",         i: "arrowRight" },
    { k: "legal",           l: "법적절차",         i: "gavel" },
    { k: "rehabBankruptcy", l: "회생/파산",        i: "shield",  sub: rehabSubItems,   subState: rehabSubTab,  setSub: (v) => { setRehabSubTab(v); setTab("rehabBankruptcy"); } },
    { k: "minsa",           l: "민사소송",         i: "scale" },
    { k: "aiDocs",          l: "문건 자동 생성",   i: "fileText" },
    { k: "aiAnalysis",      l: "AI 종합분석",      i: "sparkles" },
    ...(isAdmin ? [{ k: "admin", l: "어드민", i: "settings" }] : []),
  ];

  // Login gate
  if (!currentUser) return <><style>{CSS}</style><LoginScreen onLogin={handleLogin} loginError={loginError} /></>;
  const approvedUser = users.find(u => u.id === currentUser.id);
  if (!approvedUser?.approved) return <><style>{CSS}</style><PendingScreen user={currentUser} onLogout={handleLogout} /></>;

  return (
    <div style={{ display: "flex", height: "100vh", background: "#fff", overflow: "hidden" }}>
      <style>{CSS}</style>
      {/* Sidebar */}
      <div style={{ width: 220, background: "var(--bg2)", borderRight: "1px solid var(--brd)", display: "flex", flexDirection: "column", flexShrink: 0 }}>
        <div onClick={() => setTab("dashboard")} style={{ padding: "20px 16px", borderBottom: "1px solid var(--brd)", cursor: "pointer" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <BrandLogo size={30} />
            <BrandWordmark fontSize={18} />
          </div>
          <div style={{ fontSize: 10, color: "var(--tm)", marginTop: 2, letterSpacing: 1.5 }}>NPL MANAGEMENT</div>
        </div>
        <div style={{ flex: 1, padding: "8px", display: "flex", flexDirection: "column", gap: 2, overflowY: "auto" }}>
          {navTabs.map(t => {
            const isExpanded = t.sub && expandedNav.has(t.k);
            const isActive   = tab === t.k;
            return (
              <div key={t.k}>
                <button
                  onClick={() => {
                    if (t.k === "debtors") {
                      setDebtorsSubTab("채무자 목록");
                      goToDebtorList();
                      setExpandedNav(prev => {
                        const next = new Set(prev);
                        if (next.has(t.k)) next.delete(t.k); else next.add(t.k);
                        return next;
                      });
                      return;
                    }
                    setTab(t.k);
                    setSel(null);
                    if (t.sub) {
                      setExpandedNav(prev => {
                        const next = new Set(prev);
                        if (next.has(t.k)) next.delete(t.k); else next.add(t.k);
                        return next;
                      });
                    }
                  }}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 8, fontSize: 13, fontWeight: isActive ? 600 : 400, background: isActive ? "var(--hover)" : "transparent", color: isActive ? "var(--tp)" : "var(--ts)", textAlign: "left", width: "100%", border: "none", cursor: "pointer" }}
                >
                  <I name={t.i} size={16} />
                  <span style={{ flex: 1 }}>{t.l}</span>
                  {t.k === "payments" && pendingCount > 0 && <span style={{ background: "#ef4444", color: "#fff", borderRadius: 10, fontSize: 10, fontWeight: 700, padding: "1px 6px", lineHeight: "1.4" }}>{pendingCount}</span>}
                  {t.sub && <span style={{ fontSize: 10, color: "var(--tm)" }}>{isExpanded ? "▾" : "▸"}</span>}
                </button>
                {isExpanded && (
                  <div style={{ marginLeft: 8, marginTop: 2, display: "flex", flexDirection: "column", gap: 1 }}>
                    {t.sub.map(s => {
                      const isSubActive = isActive && t.subState === s.k;
                      return (
                        <button
                          key={s.k}
                          onClick={() => { t.setSub(s.k); /* 부모 expanded 상태 건드리지 않음 */ }}
                          style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px 7px 28px", borderRadius: 6, fontSize: 12, fontWeight: isSubActive ? 600 : 400, background: isSubActive ? "#ff5f0015" : "transparent", color: isSubActive ? "var(--acc)" : "var(--ts)", textAlign: "left", width: "100%", border: "none", cursor: "pointer" }}
                        >
                          <span style={{ width: 5, height: 5, borderRadius: "50%", background: isSubActive ? "var(--acc)" : "var(--tm)", flexShrink: 0 }} />
                          <span style={{ flex: 1 }}>{s.k}</span>
                          <span className="mono" style={{ fontSize: 10, color: isSubActive ? "var(--acc)" : "var(--tm)" }}>{s.cnt}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          <div style={{ height: 1, background: "var(--brd)", margin: "8px 0" }} />
        </div>
        <div style={{ padding: 16, borderTop: "1px solid var(--brd)", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#000", marginBottom: 2 }}>[CHECK 사항]</div>
          {(() => {
            const dOffset = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().split("T")[0]; };
            const yestStr = dOffset(-1), todayStr = dOffset(0), tmrwStr = dOffset(1);
            const scheds = data.installmentSchedules || [];
            const items = [
              { l: "어제 분할상환 미입금 대상자", v: `${scheds.filter(s => s.dueDate === yestStr && s.status !== "완납").length}건`, onClick: () => { setTab("installments"); setInstallmentsFocusDate(yestStr); } },
              { l: "오늘 분할상환 대상자", v: `${scheds.filter(s => s.dueDate === todayStr).length}건`, onClick: () => { setTab("installments"); setInstallmentsFocusDate(todayStr); } },
              { l: "오늘 입금 건수", v: `${data.payments.filter(p => p.paymentDate === todayStr).length}건`, onClick: () => { setTab("payments"); setPaymentsFocusDate(todayStr); } },
              { l: "내일 분할상환 대상자", v: `${scheds.filter(s => s.dueDate === tmrwStr).length}건`, onClick: () => { setTab("installments"); setInstallmentsFocusDate(tmrwStr); } },
            ];
            return items.map((x, i) => (
              <div key={i} onClick={x.onClick}
                onMouseEnter={e => e.currentTarget.style.background = "var(--hover)"}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", padding: "2px 6px", margin: "0 -6px", borderRadius: 6 }}>
                <div style={{ fontSize: 11, color: "#000" }}>{x.l}</div>
                <div className="mono" style={{ fontSize: 13, fontWeight: 700, color: "#ef4444" }}>{x.v}</div>
              </div>
            ));
          })()}
        </div>
        <div style={{ padding: "12px 16px", borderTop: "1px solid var(--brd)", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: "var(--acc)" + "18", color: "var(--acc)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, flexShrink: 0 }}>{currentUser.avatar}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentUser.name}</div>
            <div style={{ fontSize: 10, color: "var(--tm)" }}>{ROLES.find(r => r.key === currentUser.role)?.label}</div>
          </div>
          <button onClick={handleLogout} style={{ padding: "4px 8px", borderRadius: 4, fontSize: 10, background: "var(--bg)", color: "var(--tm)", border: "1px solid var(--brd)" }}>로그아웃</button>
        </div>
      </div>
      {/* Main */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ height: 56, padding: "0 24px", borderBottom: "1px solid var(--brd)", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {sel && tab === "debtors" && <button onClick={goBack} style={{ width: 32, height: 32, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)", color: "var(--ts)" }}><I name="back" size={16} /></button>}
            <span
              onClick={tab === "debtors" ? () => { setDebtorsSubTab("채무자 목록"); goToDebtorList(); } : undefined}
              style={{ fontSize: 16, fontWeight: 700, cursor: tab === "debtors" ? "pointer" : "default" }}>
              {tab !== "dashboard" && navTabs.find(t => t.k === tab)?.l}
              {tab === "debtors" && !sel && debtorsSubTab !== "채무자 목록" && <span style={{ color: "var(--tm)", fontWeight: 400 }}> / {debtorsSubTab}</span>}
              {tab === "legal" && legalTypeFilter !== "전체" && <span style={{ color: "var(--tm)", fontWeight: 400 }}> / {legalTypeFilter}</span>}
              {tab === "rehabBankruptcy" && <span style={{ color: "var(--tm)", fontWeight: 400 }}> / {rehabSubTab}</span>}
            </span>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <HeaderClock currentUser={currentUser} lastSaved={lastSaved} />
            <div style={{ width: 1, height: 28, background: "var(--brd)" }} />
            <button onClick={() => loadData()} disabled={isRefreshing} title="데이터 새로고침" style={{ width: 36, height: 36, borderRadius: 8, background: isRefreshing ? "var(--acc)" : "var(--card)", color: isRefreshing ? "#fff" : "var(--ts)", display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--brd)", cursor: isRefreshing ? "default" : "pointer" }}>
              <span className={isRefreshing ? "spinning" : ""}><I name="refresh" size={16} /></span>
            </button>
          </div>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: 24 }}>
          {tab === "dashboard" && Dashboard()}
          {tab === "issues" && issuesView}
          {tab === "debtors" && (sel ? <DebtorDetail d={sel} /> : (debtorsSubTab === "채무자 위치" ? <DebtorLocationsView /> : debtorListView))}
          {tab === "collection" && <CollectionView />}
          {tab === "payments" && <PaymentsView />}
          {tab === "installments" && <InstallmentsView />}
          {tab === "legal" && <LegalView />}
          {tab === "rehabBankruptcy" && <RehabBankruptcyView />}
          {tab === "minsa" && <MinSaView />}
          {tab === "aiDocs" && <AiDocsView />}
          {tab === "aiAnalysis" && <AiAnalysisView
            data={data}
            aiMessages={aiMessages} setAiMessages={setAiMessages}
            aiInput={aiInput} setAiInput={setAiInput}
            aiLoading={aiLoading} setAiLoading={setAiLoading}
            aiSelDebtor={aiSelDebtor} setAiSelDebtor={setAiSelDebtor}
            aiDebtorQ={aiDebtorQ} setAiDebtorQ={setAiDebtorQ}
          />}
          {tab === "admin" && adminView}
        </div>
      </div>
      {/* Modals */}
      {modal?.type === "debtor"          && <DebtorFormModal />}
      {modal?.type === "payment"         && <PaymentFormModal />}
      {modal?.type === "rematch"         && <RematchModalStandalone pay={modal.payment} debtors={data.debtors} brands={config.brands} onClose={() => setModal(null)} onReload={reloadFromBackend} showToast={showToast} />}
      {modal?.type === "activity"        && <ActivityFormModal />}
      {modal?.type === "addInstallment"  && <InstallmentAddModal />}
      {modal?.type === "rollover"        && <RolloverModal sched={modal.sched} onClose={() => setModal(null)} onReload={reloadInstallments} showToast={showToast} />}
      {modal?.type === "addRehab"        && <RehabAddModal />}
      {modal?.type === "addLegal"        && <LegalAddModal />}
      {modal?.type === "addMinsa"        && <MinsaAddModal />}
      {modal?.type === "addComplaint"    && <ComplaintAddModal />}
      {/* 중복 입금 확인 모달 */}
      {dupConfirm && (
        <div onClick={() => setDupConfirm(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 3000, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 14, padding: "28px 32px", maxWidth: 420, width: "90%", boxShadow: "0 20px 60px rgba(0,0,0,.25)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <span style={{ fontSize: 22 }}>⚠️</span>
              <span style={{ fontSize: 17, fontWeight: 700, color: "#b45309" }}>중복 입금 감지</span>
            </div>
            <p style={{ margin: "0 0 8px", fontSize: 14, color: "#374151", lineHeight: 1.6 }}>
              <b>{dupConfirm.debtorName}</b>에게 <b>{fmtDate(dupConfirm.paymentDate)}</b> /&nbsp;
              <b>{(dupConfirm.total || 0).toLocaleString()}원</b> 입금건이 이미 존재합니다.
            </p>
            <p style={{ margin: "0 0 20px", fontSize: 13, color: "#6b7280" }}>
              기존 입금 ID: <code style={{ background: "#f3f4f6", padding: "1px 6px", borderRadius: 4 }}>{dupConfirm.existingPaymentId}</code>
            </p>
            <p style={{ margin: "0 0 20px", fontSize: 13, color: "#92400e", background: "#fef3c7", borderRadius: 8, padding: "10px 14px" }}>
              실제로 동일인이 같은 날 두 번 입금한 경우에만 [중복 확인 후 등록]을 선택하세요.
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => setDupConfirm(null)} style={{ padding: "8px 20px", borderRadius: 8, border: "1.5px solid #d1d5db", background: "#fff", cursor: "pointer", fontSize: 14, fontWeight: 600, color: "#374151" }}>취소</button>
              <button onClick={() => { const p = dupConfirm.payment; setDupConfirm(null); addPayment(p, true); }} style={{ padding: "8px 20px", borderRadius: 8, border: "none", background: "#ef4444", color: "#fff", cursor: "pointer", fontSize: 14, fontWeight: 600 }}>중복 확인 후 등록</button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", padding: "12px 24px", borderRadius: 10, background: "#10b981", color: "#fff", fontSize: 13, fontWeight: 600, zIndex: 2e3, animation: "toastIn .3s ease-out", boxShadow: "0 4px 20px rgba(16,185,129,.3)" }}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><I name="check" size={16} />{toast}</div></div>}
    </div>
  );
}

function AiAnalysisView({ data, aiMessages, setAiMessages, aiInput, setAiInput, aiLoading, setAiLoading, aiSelDebtor, setAiSelDebtor, aiDebtorQ, setAiDebtorQ }) {
  // 상태는 최상위 App에서 관리 — 탭 전환해도 대화 유지, 리렌더 시 unmount 방지
  const bottomRef = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [aiMessages]);

  const filteredDebtors = aiDebtorQ.trim().length > 0
    ? data.debtors.filter(d => d.name.includes(aiDebtorQ) || (d.hubName || "").includes(aiDebtorQ))
    : [];

  const sendMessage = async () => {
    const q = aiInput.trim();
    if (!q || aiLoading) return;
    setAiInput("");
    const userMsg = { role: "user", content: aiSelDebtor ? `[${aiSelDebtor.name}] ${q}` : q };
    setAiMessages(prev => [...prev, userMsg]);
    setAiLoading(true);
    try {
      const res = await fetch("/api/ai-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, debtorId: aiSelDebtor?.id || null }),
      });
      const d2 = await res.json();
      setAiMessages(prev => [...prev, { role: "assistant", content: d2.answer || d2.error || "오류가 발생했습니다." }]);
    } catch {
      setAiMessages(prev => [...prev, { role: "assistant", content: "서버 연결 오류가 발생했습니다." }]);
    }
    setAiLoading(false);
  };

  const QUICK = [
    "이 채무자 현황을 종합적으로 분석해줘",
    "최근 입금 패턴을 분석해줘",
    "다음 법적 조치를 추천해줘",
    "압류 가능성 있어?",
  ];

  const fmtBal = v => v != null ? Number(v).toLocaleString("ko-KR") : "0";

  return (
    <div className="anim" style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 120px)", maxWidth: 860, margin: "0 auto", padding: "0 16px" }}>
      {/* 헤더 */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 0 12px" }}>
        <I name="sparkles" size={22} style={{ color: "var(--acc)" }} />
        <span style={{ fontSize: 18, fontWeight: 700, color: "var(--tp)" }}>AI 종합분석</span>
        <span style={{ fontSize: 12, color: "var(--ts)", marginLeft: 4 }}>GPT-4o mini 기반</span>
        {aiMessages.length > 1 && (
          <button onClick={() => setAiMessages([aiMessages[0]])} style={{ marginLeft: "auto", padding: "4px 10px", borderRadius: 6, border: "1px solid var(--brd)", background: "var(--card)", color: "var(--tm)", fontSize: 11, cursor: "pointer" }}>
            대화 초기화
          </button>
        )}
      </div>

      {/* 채무자 선택 */}
      <div style={{ background: "var(--card)", border: "1px solid var(--brd)", borderRadius: 10, padding: "12px 14px", marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--tm)", marginBottom: 8 }}>채무자 선택 (선택 시 해당 데이터 기반 분석)</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            value={aiDebtorQ}
            onChange={e => { setAiDebtorQ(e.target.value); if (!e.target.value) setAiSelDebtor(null); }}
            placeholder="채무자 이름 검색..."
            style={{ flex: 1, padding: "7px 10px", borderRadius: 7, border: "1px solid var(--brd)", background: "var(--bg)", color: "var(--tp)", fontSize: 13 }}
          />
          {aiSelDebtor && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--acc)", color: "#fff", borderRadius: 7, padding: "5px 10px", fontSize: 12, fontWeight: 600 }}>
              <span>{aiSelDebtor.name}</span>
              <button onClick={() => { setAiSelDebtor(null); setAiDebtorQ(""); }} style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", padding: 0, fontSize: 14, lineHeight: 1 }}>×</button>
            </div>
          )}
        </div>
        {filteredDebtors.length > 0 && !aiSelDebtor && (
          <div style={{ marginTop: 6, border: "1px solid var(--brd)", borderRadius: 7, overflow: "hidden", maxHeight: 160, overflowY: "auto" }}>
            {filteredDebtors.slice(0, 8).map(d => (
              <div key={d.id} onClick={() => { setAiSelDebtor(d); setAiDebtorQ(d.name); }}
                style={{ padding: "8px 12px", cursor: "pointer", fontSize: 13, color: "var(--tp)", borderBottom: "1px solid var(--brd)" }}
                onMouseEnter={e => e.currentTarget.style.background = "var(--hover)"}
                onMouseLeave={e => e.currentTarget.style.background = ""}>
                <span style={{ fontWeight: 600 }}>{d.name}</span>
                <span style={{ color: "var(--ts)", marginLeft: 8, fontSize: 11 }}>{d.brand} · {d.hubName || "-"}</span>
                <span className="mono" style={{ color: "#8b5cf6", marginLeft: 8, fontSize: 11 }}>재무 {fmtBal(d.finalBalanceFinance)}원</span>
                <span className="mono" style={{ color: "var(--err)", marginLeft: 6, fontSize: 11 }}>법무 {fmtBal(d.finalBalanceLegal)}원</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 채팅 영역 */}
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, paddingBottom: 8 }}>
        {aiMessages.map((m, i) => (
          <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
            <div style={{
              maxWidth: "80%", padding: "10px 14px", borderRadius: m.role === "user" ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
              background: m.role === "user" ? "var(--acc)" : "var(--card)",
              color: m.role === "user" ? "#fff" : "var(--tp)",
              border: m.role === "user" ? "none" : "1px solid var(--brd)",
              fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-wrap",
            }}>{m.content}</div>
          </div>
        ))}
        {aiLoading && (
          <div style={{ display: "flex", justifyContent: "flex-start" }}>
            <div style={{ padding: "10px 16px", borderRadius: "14px 14px 14px 4px", background: "var(--card)", border: "1px solid var(--brd)", color: "var(--ts)", fontSize: 13 }}>
              분석 중...
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 빠른 질문 */}
      {aiSelDebtor && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "8px 0 6px" }}>
          {QUICK.map(q => (
            <button key={q} onClick={() => setAiInput(q)}
              style={{ padding: "5px 10px", borderRadius: 20, border: "1px solid var(--brd)", background: "var(--card)", color: "var(--tm)", fontSize: 11, cursor: "pointer" }}>
              {q}
            </button>
          ))}
        </div>
      )}

      {/* 입력창 */}
      <div style={{ display: "flex", gap: 8, padding: "8px 0 16px", borderTop: "1px solid var(--brd)" }}>
        <input
          value={aiInput}
          onChange={e => setAiInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
          placeholder={aiSelDebtor ? `${aiSelDebtor.name}에 대해 질문하세요...` : "질문을 입력하세요..."}
          disabled={aiLoading}
          style={{ flex: 1, padding: "10px 14px", borderRadius: 10, border: "1px solid var(--brd)", background: "var(--bg)", color: "var(--tp)", fontSize: 13 }}
        />
        <button onClick={sendMessage} disabled={aiLoading || !aiInput.trim()}
          style={{ padding: "10px 18px", borderRadius: 10, background: aiLoading || !aiInput.trim() ? "var(--brd)" : "var(--acc)", color: "#fff", border: "none", cursor: aiLoading || !aiInput.trim() ? "default" : "pointer", fontSize: 13, fontWeight: 600, transition: "background 0.15s" }}>
          전송
        </button>
      </div>
    </div>
  );
}
