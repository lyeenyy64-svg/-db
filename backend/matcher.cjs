// ============================================================
// 채무자 매칭 로직 — 엑셀 임포트와 Slack 자동 수집에서 공용으로 사용
// ============================================================

// 이름 정규화: ㈜ / (주) / 주식회사 / 공백 / 괄호안 별칭 차이를 무시
function normalizeName(name) {
  if (!name) return "";
  return String(name)
    .replace(/㈜/g, "")
    .replace(/\(주\)/g, "")
    .replace(/주식회사/g, "")
    .replace(/\([^)]*\)/g, "")  // "송봉은(송채안)" → "송봉은"
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

// 한글 뒤에 붙은 숫자 suffix 제거 (예: "홍길동00" → "홍길동", "정웅선01" → "정웅선")
// 한글 자모가 포함된 경우에만 적용
function stripKoreanSuffix(name) {
  if (!name) return name;
  const s = String(name).trim();
  if (/[가-힣]/.test(s)) {
    return s.replace(/\d+$/, "").trim();
  }
  return s;
}

// 여러 후보 중 원코드(하이픈 없는 hub_code) 우선 선택
// 하이픈 없는 것이 1개면 그것을, 아니면 코드 길이 짧은 순 첫 번째
function pickByOriginalCode(candidates, debtors) {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const sorted = [...candidates].sort((a, b) => {
    const da = debtors.find(x => x.id === a);
    const db_d = debtors.find(x => x.id === b);
    const aHC = da?.hub_code || "";
    const bHC = db_d?.hub_code || "";
    const aHyphen = aHC.includes("-") ? 1 : 0;
    const bHyphen = bHC.includes("-") ? 1 : 0;
    if (aHyphen !== bHyphen) return aHyphen - bHyphen;
    return aHC.length - bHC.length;
  });
  return sorted[0];
}

// 모든 채무자에 대한 검색 인덱스 구축 (in-memory)
// guarantors: [{ debtor_id, name }] 배열 (선택)
function buildIndex(debtors, guarantors = []) {
  const byBrandCodeName = new Map();   // "B|4134|㈜에스플러스" → id
  const byNormalizedName = new Map();  // "에스플러스" → [id, ...]
  const byHubCode = new Map();         // "4134" → [id, ...]

  for (const d of debtors) {
    const key1 = `${d.brand_code}|${d.hub_code || ""}|${d.name}`;
    byBrandCodeName.set(key1, d.id);
    const nn = normalizeName(d.name);
    if (nn) {
      if (!byNormalizedName.has(nn)) byNormalizedName.set(nn, []);
      byNormalizedName.get(nn).push(d.id);
    }
    if (d.hub_code) {
      if (!byHubCode.has(d.hub_code)) byHubCode.set(d.hub_code, []);
      byHubCode.get(d.hub_code).push(d.id);
    }
  }

  // 연대보증인 인덱스: 정규화된 보증인 이름 → [debtor_id, ...]
  const byGuarantorName = new Map();
  for (const g of guarantors) {
    const nn = normalizeName(g.name);
    if (!nn) continue;
    if (!byGuarantorName.has(nn)) byGuarantorName.set(nn, []);
    if (!byGuarantorName.get(nn).includes(g.debtor_id)) {
      byGuarantorName.get(nn).push(g.debtor_id);
    }
    // 한글+숫자 suffix 제거 버전도 등록
    const stripped = normalizeName(stripKoreanSuffix(g.name));
    if (stripped && stripped !== nn) {
      if (!byGuarantorName.has(stripped)) byGuarantorName.set(stripped, []);
      if (!byGuarantorName.get(stripped).includes(g.debtor_id)) {
        byGuarantorName.get(stripped).push(g.debtor_id);
      }
    }
  }

  return { byBrandCodeName, byNormalizedName, byHubCode, byGuarantorName, debtors };
}

// 매칭 시도 — 단계별로 좁혀가다가 첫 매치 발견 시 리턴.
// criteria: { brand, hubCode, debtorName, payerName }
// 반환: { debtorId, matchedBy } 또는 null
function matchDebtor(index, criteria) {
  const { brand, hubCode, debtorName, payerName } = criteria;
  const { byBrandCodeName, byNormalizedName, byHubCode, byGuarantorName, debtors } = index;

  // ── 후보 목록에서 브랜드 필터 + 원코드 우선 적용해 1개 추출 ──────
  function resolve(candidates, label) {
    if (!candidates || candidates.length === 0) return null;
    let pool = candidates;
    if (brand) {
      // 브랜드가 주어졌으면 후보 개수와 무관하게 항상 적용한다.
      // 일치하는 후보가 하나도 없으면 다른 브랜드 채무자로 오매칭되지 않도록 매칭 실패로 처리(fail closed).
      pool = pool.filter(id => {
        const d = debtors.find(x => x.id === id);
        return d && d.brand_code === brand;
      });
      if (pool.length === 0) return null;
    }
    const picked = pickByOriginalCode(pool, debtors);
    return picked ? { debtorId: picked, matchedBy: label } : null;
  }

  // 1단계: 브랜드 + 코드 + 정확한 이름
  if (brand && hubCode && debtorName) {
    const id = byBrandCodeName.get(`${brand}|${hubCode}|${debtorName}`);
    if (id) return { debtorId: id, matchedBy: "정확매칭" };
  }

  // 2단계: 채무자명 정규화
  if (debtorName) {
    const r = resolve(byNormalizedName.get(normalizeName(debtorName)), "이름정규화");
    if (r) return r;
  }

  // 3단계: 입금자명으로
  if (payerName) {
    const normalized = normalizeName(payerName);

    // 3a: 입금자명 그대로 → 채무자 검색
    const r3a = resolve(byNormalizedName.get(normalized), "입금자명");
    if (r3a) return r3a;

    // 3b: 입금자명 → 연대보증인 검색
    const r3b = resolve(byGuarantorName.get(normalized), "입금자명(보증인)");
    if (r3b) return r3b;

    // 3c: 한글+숫자 suffix 제거 후 → 채무자 검색 (예: "홍길동00" → "홍길동")
    const strippedName = normalizeName(stripKoreanSuffix(payerName));
    if (strippedName && strippedName !== normalized) {
      const r3c = resolve(byNormalizedName.get(strippedName), "입금자명(숫자제거)");
      if (r3c) return r3c;

      // 3d: 한글+숫자 제거 후 → 연대보증인 검색
      const r3d = resolve(byGuarantorName.get(strippedName), "입금자명(숫자제거+보증인)");
      if (r3d) return r3d;
    }
  }

  // 4단계: 코드만으로 (유일한 경우만)
  if (hubCode) {
    const candidates = byHubCode.get(hubCode) || [];
    if (candidates.length === 1) return { debtorId: candidates[0], matchedBy: "코드유일" };
  }

  return null;
}

module.exports = { normalizeName, buildIndex, matchDebtor };
