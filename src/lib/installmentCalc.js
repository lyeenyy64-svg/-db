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

// interval이 없거나(null/"") endDate가 없으면 firstDate 하나만 반환
export function generateInstallmentDates({ firstDate, endDate, interval, useEndOfMonth = false }) {
  if (!firstDate) return [];
  if (!interval || !endDate) return [firstDate];
  const endD = new Date(endDate + "T00:00:00");
  if (isNaN(endD.getTime())) return [firstDate];
  const dates = [];
  const MAX = 1200;
  if (interval === "매월") {
    const origDay = useEndOfMonth ? 31 : new Date(firstDate + "T00:00:00").getDate();
    let cur = new Date(firstDate + "T00:00:00");
    while (dates.length < MAX) {
      if (isNaN(cur.getTime()) || cur > endD) break;
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
      if (isNaN(cur.getTime()) || cur > endD) break;
      dates.push(localDateStr(cur));
      cur = new Date(cur.getFullYear() + 1, origMonth, origDay);
    }
  } else {
    const iv = interval === "매주" ? 7 : 14;
    let cur = new Date(firstDate + "T00:00:00");
    while (dates.length < MAX) {
      if (isNaN(cur.getTime()) || cur > endD) break;
      dates.push(localDateStr(cur));
      cur.setDate(cur.getDate() + iv);
    }
  }
  return dates;
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
