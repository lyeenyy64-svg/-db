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

// 모든 채무자에 대한 검색 인덱스 구축 (in-memory)
function buildIndex(debtors) {
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
  return { byBrandCodeName, byNormalizedName, byHubCode, debtors };
}

// 매칭 시도. 4단계 — 단계별로 좁혀가다가 첫 매치 발견 시 리턴.
// criteria: { brand, hubCode, debtorName, payerName }
// 반환: { debtorId, matchedBy } 또는 null
function matchDebtor(index, criteria) {
  const { brand, hubCode, debtorName, payerName } = criteria;
  const { byBrandCodeName, byNormalizedName, byHubCode, debtors } = index;

  // 1단계: 브랜드 + 코드 + 정확한 이름
  if (brand && hubCode && debtorName) {
    const id = byBrandCodeName.get(`${brand}|${hubCode}|${debtorName}`);
    if (id) return { debtorId: id, matchedBy: "정확매칭" };
  }
  // 2단계: 정규화된 이름
  if (debtorName) {
    const candidates = byNormalizedName.get(normalizeName(debtorName)) || [];
    if (candidates.length === 1) return { debtorId: candidates[0], matchedBy: "이름정규화" };
    if (candidates.length > 1 && brand) {
      const byBrand = candidates.filter(id => {
        const d = debtors.find(x => x.id === id);
        return d && d.brand_code === brand;
      });
      if (byBrand.length === 1) return { debtorId: byBrand[0], matchedBy: "이름+브랜드" };
    }
  }
  // 3단계: 입금자명으로 (회생파산 법원 입금의 경우 이름 뒤에 00~99 숫자가 붙음)
  if (payerName) {
    const normalized = normalizeName(payerName);
    // 3a: 입금자명 그대로
    const candidates = byNormalizedName.get(normalized) || [];
    if (candidates.length === 1) return { debtorId: candidates[0], matchedBy: "입금자명" };
    if (candidates.length > 1 && brand) {
      const byBrand = candidates.filter(id => { const d = debtors.find(x => x.id === id); return d && d.brand_code === brand; });
      if (byBrand.length === 1) return { debtorId: byBrand[0], matchedBy: "입금자명+브랜드" };
    }
    // 3b: 회생파산 패턴 — 이름 뒤 1~2자리 숫자 제거 후 재시도 (예: "정웅선00" → "정웅선")
    const stripped = normalizeName(payerName.replace(/\d{1,2}$/, "").trim());
    if (stripped && stripped !== normalized) {
      const sc = byNormalizedName.get(stripped) || [];
      if (sc.length === 1) return { debtorId: sc[0], matchedBy: "입금자명(회생)" };
      if (sc.length > 1 && brand) {
        const byBrand = sc.filter(id => { const d = debtors.find(x => x.id === id); return d && d.brand_code === brand; });
        if (byBrand.length === 1) return { debtorId: byBrand[0], matchedBy: "입금자명(회생)+브랜드" };
      }
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
