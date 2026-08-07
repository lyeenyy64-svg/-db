import { describe, it, expect } from "vitest";
import { parseKoreanDates } from "./koreanDateParse.cjs";

const asYmd = (results) => results.map(r => `${r.date.getFullYear()}-${String(r.date.getMonth() + 1).padStart(2, "0")}-${String(r.date.getDate()).padStart(2, "0")}`);

describe("parseKoreanDates", () => {
  it("절대 날짜 8.11 을 인식한다", () => {
    const ref = new Date(2026, 7, 5); // 2026-08-05
    const found = parseKoreanDates("8.11에 30만원 입금하겠다고 함", ref);
    expect(asYmd(found)).toContain("2026-08-11");
  });
  it("8월 11일 형태도 인식한다", () => {
    const ref = new Date(2026, 7, 5);
    const found = parseKoreanDates("8월 11일에 입금 예정", ref);
    expect(asYmd(found)).toContain("2026-08-11");
  });
  it("다음주 화요일을 기록일 기준으로 해석한다 (2026-08-05는 수요일)", () => {
    const ref = new Date(2026, 7, 5); // 2026-08-05 수요일
    const found = parseKoreanDates("다음주 화요일에 입금하겠다고 함", ref);
    // 화요일(2) - 수요일(3) = -1 -> (+7)%7=6, +7(다음주) = 13일 뒤 = 8/18
    expect(asYmd(found)).toContain("2026-08-18");
  });
  it("이번주 X요일은 다음주를 더하지 않는다", () => {
    const ref = new Date(2026, 7, 5); // 수요일
    const found = parseKoreanDates("이번주 금요일까지 드리겠습니다", ref);
    expect(asYmd(found)).toContain("2026-08-07");
  });
  it("내일/모레를 인식한다", () => {
    const ref = new Date(2026, 7, 5);
    expect(asYmd(parseKoreanDates("내일 입금", ref))).toContain("2026-08-06");
    expect(asYmd(parseKoreanDates("모레까지 넣겠음", ref))).toContain("2026-08-07");
  });
  it("다음달 초/중순/말을 인식한다", () => {
    const ref = new Date(2026, 7, 25); // 2026-08-25
    const found = parseKoreanDates("다음달 초에 입금, 다음달 중순에 재확인, 다음달 말일까지 완납", ref);
    const ys = asYmd(found);
    expect(ys).toContain("2026-09-03");
    expect(ys).toContain("2026-09-15");
    expect(ys).toContain("2026-09-30");
  });
  it("입금 관련 단어 없이 단독 'N일에'는 무시한다 (노이즈 방지)", () => {
    const ref = new Date(2026, 7, 5);
    const found = parseKoreanDates("30일 이상 연락 없음", ref);
    expect(found.length).toBe(0);
  });
  it("입금 관련 단어가 근처에 있으면 단독 'N일에'도 인식한다", () => {
    const ref = new Date(2026, 7, 5); // 8/5, day(5) < 15 이므로 이번달
    const found = parseKoreanDates("15일에 입금하겠다고 함", ref);
    expect(asYmd(found)).toContain("2026-08-15");
  });
  it("refDate 없으면 상대 표현은 무시하고 절대 날짜만 인식한다", () => {
    const found = parseKoreanDates("내일 8.11 입금", null);
    expect(found.length).toBe(1);
    expect(found[0].date.getMonth()).toBe(7); // 8월 (0-indexed)
    expect(found[0].date.getDate()).toBe(11);
  });
});
