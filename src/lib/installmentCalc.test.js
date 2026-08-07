import { describe, it, expect } from "vitest";
import {
  localDateStr,
  addIntervals,
  generateInstallmentDates,
  computeInstallmentCount,
  buildScheduleAmounts,
  suggestEndDate,
} from "./installmentCalc.js";

describe("computeInstallmentCount", () => {
  it("올려서 필요한 회차 수를 계산한다", () => {
    expect(computeInstallmentCount(1000000, 300000)).toBe(4);
  });
  it("정확히 나눠지면 그만큼 회차", () => {
    expect(computeInstallmentCount(900000, 300000)).toBe(3);
  });
  it("금액이나 채권액이 0이면 0", () => {
    expect(computeInstallmentCount(0, 300000)).toBe(0);
    expect(computeInstallmentCount(1000000, 0)).toBe(0);
  });
});

describe("buildScheduleAmounts", () => {
  it("나머지를 마지막 회차에 흡수한다", () => {
    const dates = ["2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01"];
    const amounts = buildScheduleAmounts(dates, 300000, 1000000);
    expect(amounts).toEqual([300000, 300000, 300000, 100000]);
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(1000000);
  });
  it("정확히 나눠지면 나머지 조정이 없다", () => {
    const dates = ["2026-08-01", "2026-09-01", "2026-10-01"];
    const amounts = buildScheduleAmounts(dates, 300000, 900000);
    expect(amounts).toEqual([300000, 300000, 300000]);
  });
  it("회차가 1개면 나머지 흡수 로직을 타지 않는다", () => {
    const amounts = buildScheduleAmounts(["2026-08-01"], 300000, 1000000);
    expect(amounts).toEqual([300000]);
  });
  it("totalClaim이 0이면 매 회차 그대로", () => {
    const dates = ["2026-08-01", "2026-09-01"];
    expect(buildScheduleAmounts(dates, 300000, 0)).toEqual([300000, 300000]);
  });
});

describe("addIntervals", () => {
  it("매월 반복 시 월말 날짜를 다음달 말일로 클램프한다 (1월 31일 + 1개월)", () => {
    expect(addIntervals("2026-01-31", "매월", 1, true)).toBe("2026-02-28");
  });
  it("매월 반복 시 연도 경계를 넘는다 (12월 -> 다음해 1월)", () => {
    expect(addIntervals("2026-12-15", "매월", 1)).toBe("2027-01-15");
  });
  it("매주 반복", () => {
    expect(addIntervals("2026-08-01", "매주", 2)).toBe("2026-08-15");
  });
  it("격주 반복", () => {
    expect(addIntervals("2026-08-01", "격주", 2)).toBe("2026-08-29");
  });
  it("매년 반복", () => {
    expect(addIntervals("2026-08-01", "매년", 1)).toBe("2027-08-01");
  });
  it("n이 0 이하면 원래 날짜를 그대로 반환", () => {
    expect(addIntervals("2026-08-01", "매월", 0)).toBe("2026-08-01");
  });
});

describe("generateInstallmentDates", () => {
  it("반복 없음이면 첫 날짜 하나만 반환", () => {
    const dates = generateInstallmentDates({ firstDate: "2026-08-01", endDate: "2026-12-01", interval: null });
    expect(dates).toEqual(["2026-08-01"]);
  });
  it("종료일이 없으면 첫 날짜 하나만 반환", () => {
    const dates = generateInstallmentDates({ firstDate: "2026-08-01", endDate: "", interval: "매월" });
    expect(dates).toEqual(["2026-08-01"]);
  });
  it("매월 반복으로 연도 경계를 넘어 날짜를 생성한다", () => {
    const dates = generateInstallmentDates({ firstDate: "2026-11-15", endDate: "2027-02-15", interval: "매월" });
    expect(dates).toEqual(["2026-11-15", "2026-12-15", "2027-01-15", "2027-02-15"]);
  });
  it("말일 옵션을 켜면 짧은 달에서도 말일로 유지된다", () => {
    const dates = generateInstallmentDates({ firstDate: "2026-01-31", endDate: "2026-04-30", interval: "매월", useEndOfMonth: true });
    expect(dates).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });
  it("매주 반복", () => {
    const dates = generateInstallmentDates({ firstDate: "2026-08-01", endDate: "2026-08-22", interval: "매주" });
    expect(dates).toEqual(["2026-08-01", "2026-08-08", "2026-08-15", "2026-08-22"]);
  });
  it("종료일이 첫 날짜보다 이전이면 빈 배열 (기존 동작)", () => {
    const dates = generateInstallmentDates({ firstDate: "2026-08-01", endDate: "2026-07-01", interval: "매월" });
    expect(dates).toEqual([]);
  });
  it("both 옵션: 매월 지정일 + 말일로 월 2회 생성한다", () => {
    const dates = generateInstallmentDates({ firstDate: "2026-08-10", endDate: "2026-10-10", interval: "매월", useEndOfMonth: "both" });
    expect(dates).toEqual(["2026-08-10", "2026-08-31", "2026-09-10", "2026-09-30", "2026-10-10"]);
  });
  it("both 옵션: 지정일이 말일과 같아지는 달은 중복 없이 하루만", () => {
    const dates = generateInstallmentDates({ firstDate: "2026-01-30", endDate: "2026-02-28", interval: "매월", useEndOfMonth: "both" });
    expect(dates).toEqual(["2026-01-30", "2026-01-31", "2026-02-28"]);
  });
  it("maxCount로 종료일 없이 회차 수만큼 생성한다", () => {
    const dates = generateInstallmentDates({ firstDate: "2026-08-10", interval: "매월", useEndOfMonth: "both", maxCount: 3 });
    expect(dates).toEqual(["2026-08-10", "2026-08-31", "2026-09-10"]);
  });
});

describe("suggestEndDate", () => {
  it("일반 매월 모드는 addIntervals와 동일한 결과", () => {
    expect(suggestEndDate("2026-08-10", "매월", 3)).toBe(addIntervals("2026-08-10", "매월", 2));
  });
  it("both 모드는 월 2회 기준으로 종료일을 추천한다", () => {
    expect(suggestEndDate("2026-08-10", "매월", 3, "both")).toBe("2026-09-10");
  });
  it("count가 1 이하면 빈 문자열", () => {
    expect(suggestEndDate("2026-08-10", "매월", 1, "both")).toBe("");
    expect(suggestEndDate("2026-08-10", "매월", 0)).toBe("");
  });
});

describe("localDateStr", () => {
  it("YYYY-MM-DD 형식으로 포맷한다", () => {
    expect(localDateStr(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
  it("유효하지 않은 날짜는 빈 문자열", () => {
    expect(localDateStr(new Date("invalid"))).toBe("");
  });
});
