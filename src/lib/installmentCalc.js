// 분할상환 플랜/일정 생성에 쓰이는 순수 계산 로직.
// App.jsx의 InstallmentAddModal, AddSchedModal에서 공통으로 사용한다.

// 로컬 날짜 포맷 — toISOString()은 UTC 기준이라 UTC+9에서 하루 밀림
export function localDateStr(d) {
  if (!d || isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// interval: "매월" | "매년" | "매주" | "격주"
export function addIntervals(dateStr, interval, n, useEndOfMonth = false) {
  if (!dateStr || n <= 0) return dateStr;
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return "";
  if (interval === "매주") d.setDate(d.getDate() + 7 * n);
  else if (interval === "격주") d.setDate(d.getDate() + 14 * n);
  else if (interval === "매월") {
    const origDay = useEndOfMonth ? 31 : d.getDate();
    const ny = d.getFullYear() + Math.floor((d.getMonth() + n) / 12);
    const nm = (d.getMonth() + n) % 12;
    const lastDay = new Date(ny, nm + 1, 0).getDate();
    d.setFullYear(ny, nm, Math.min(origDay, lastDay));
  } else if (interval === "매년") {
    d.setFullYear(d.getFullYear() + n);
  }
  if (isNaN(d.getTime())) return "";
  return localDateStr(d);
}

// interval이 없거나(null/"") endDate/maxCount가 모두 없으면 firstDate 하나만 반환.
// useEndOfMonth: false=지정일 고정 | true=말일 고정 | "both"=월 2회(매월에서만 유효)
// secondDay: "both"일 때 두번째 납부일(1~31). 31은 항상 그 달의 말일로 클램프된다. 생략 시 말일.
export function generateInstallmentDates({ firstDate, endDate, interval, useEndOfMonth = false, secondDay = null, maxCount }) {
  if (!firstDate) return [];
  if (!interval || (!endDate && !maxCount)) return [firstDate];
  const endD = endDate ? new Date(endDate + "T00:00:00") : null;
  if (endD && isNaN(endD.getTime())) return [firstDate];
  const dates = [];
  const MAX = Math.min(maxCount || 1200, 1200);
  if (interval === "매월" && useEndOfMonth === "both") {
    const start = new Date(firstDate + "T00:00:00");
    const day1 = start.getDate();
    const day2 = secondDay >= 1 && secondDay <= 31 ? secondDay : 31;
    let ny = start.getFullYear(), nm = start.getMonth();
    let monthsLeft = MAX + 2; // 무한루프 방지용 상한(회차 수보다 넉넉하게)
    while (dates.length < MAX && monthsLeft-- > 0) {
      const lastDay = new Date(ny, nm + 1, 0).getDate();
      const d1 = new Date(ny, nm, Math.min(day1, lastDay));
      const d2 = new Date(ny, nm, Math.min(day2, lastDay));
      const monthDates = d1.getTime() === d2.getTime() ? [d1] : [d1, d2].sort((a, b) => a - b);
      let stop = false;
      for (const dd of monthDates) {
        if (dd < start) continue;
        if (endD && dd > endD) { stop = true; break; }
        dates.push(localDateStr(dd));
        if (dates.length >= MAX) break;
      }
      if (stop) break;
      nm += 1;
      if (nm > 11) { nm = 0; ny += 1; }
    }
  } else if (interval === "매월") {
    const origDay = useEndOfMonth ? 31 : new Date(firstDate + "T00:00:00").getDate();
    let cur = new Date(firstDate + "T00:00:00");
    while (dates.length < MAX) {
      if (isNaN(cur.getTime()) || (endD && cur > endD)) break;
      dates.push(localDateStr(cur));
      const nm = (cur.getMonth() + 1) % 12;
      const ny = cur.getMonth() === 11 ? cur.getFullYear() + 1 : cur.getFullYear();
      const lastDay = new Date(ny, nm + 1, 0).getDate();
      cur = new Date(ny, nm, Math.min(origDay, lastDay));
    }
  } else if (interval === "매년") {
    const origDay = new Date(firstDate + "T00:00:00").getDate();
    const origMonth = new Date(firstDate + "T00:00:00").getMonth();
    let cur = new Date(firstDate + "T00:00:00");
    while (dates.length < MAX) {
      if (isNaN(cur.getTime()) || (endD && cur > endD)) break;
      dates.push(localDateStr(cur));
      cur = new Date(cur.getFullYear() + 1, origMonth, origDay);
    }
  } else {
    const iv = interval === "매주" ? 7 : 14;
    let cur = new Date(firstDate + "T00:00:00");
    while (dates.length < MAX) {
      if (isNaN(cur.getTime()) || (endD && cur > endD)) break;
      dates.push(localDateStr(cur));
      cur.setDate(cur.getDate() + iv);
    }
  }
  return dates;
}

// count회를 채우기 위한 종료일 추천. "both"(월 2회)는 월 단위로 addIntervals를
// 적용할 수 없으므로 generateInstallmentDates를 count 기준으로 돌려 마지막 날짜를 취한다.
export function suggestEndDate(firstDate, interval, count, useEndOfMonth = false, secondDay = null) {
  if (!firstDate || !count || count <= 1) return "";
  if (interval === "매월" && useEndOfMonth === "both") {
    const dates = generateInstallmentDates({ firstDate, interval, useEndOfMonth, secondDay, maxCount: count });
    return dates[dates.length - 1] || "";
  }
  return addIntervals(firstDate, interval, count - 1, useEndOfMonth);
}

// 채권 총액 / 회당 납부액으로부터 필요한 회차 수 계산
export function computeInstallmentCount(totalClaim, amount) {
  return totalClaim > 0 && amount > 0 ? Math.ceil(totalClaim / amount) : 0;
}

// 각 회차의 납부 예정액 배열. 마지막 회차는 나머지(remainder)를 흡수해
// 전체 합이 totalClaim을 넘지 않도록 한다.
export function buildScheduleAmounts(dates, amount, totalClaim) {
  return dates.map((_, idx) => {
    if (totalClaim > 0 && amount > 0 && dates.length > 1 && idx === dates.length - 1) {
      const remainder = totalClaim - (dates.length - 1) * amount;
      if (remainder > 0 && remainder < amount) return remainder;
    }
    return amount;
  });
}
