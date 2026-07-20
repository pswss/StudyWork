// parsePlanJson 유닛 테스트 — vi.mock 없이 실제 구현을 테스트한다.
import { describe, it, expect } from "vitest";
import { parsePlanJson } from "../src/claude";

const TODAY = "2026-07-09";
const EXAM_DATE = "2026-07-20";

const VALID_ITEMS = JSON.stringify([
  { day: "2026-07-09", task: "1단원 정리" },
  { day: "2026-07-10", task: "2단원 문제 풀기" },
]);

describe("parsePlanJson", () => {
  it("유효한 배열 → 파싱 성공", () => {
    const result = parsePlanJson(VALID_ITEMS, TODAY, EXAM_DATE);
    expect(result).toHaveLength(2);
    expect(result[0].day).toBe("2026-07-09");
    expect(result[0].task).toBe("1단원 정리");
    expect(result[1].day).toBe("2026-07-10");
  });

  it("마크다운 코드 펜스(```json) 제거 후 파싱", () => {
    const fenced = "```json\n" + VALID_ITEMS + "\n```";
    const result = parsePlanJson(fenced, TODAY, EXAM_DATE);
    expect(result).toHaveLength(2);
  });

  it("마크다운 코드 펜스(```) 제거 후 파싱", () => {
    const fenced = "```\n" + VALID_ITEMS + "\n```";
    const result = parsePlanJson(fenced, TODAY, EXAM_DATE);
    expect(result).toHaveLength(2);
  });

  it("배열 앞뒤에 여분 텍스트 있어도 첫 [ ~ 마지막 ] 추출", () => {
    const withPreamble = "계획입니다:\n" + VALID_ITEMS + "\n이상.";
    const result = parsePlanJson(withPreamble, TODAY, EXAM_DATE);
    expect(result).toHaveLength(2);
  });

  it("task 앞뒤 공백 trim", () => {
    const spaced = JSON.stringify([{ day: "2026-07-09", task: "  정리  " }]);
    const result = parsePlanJson(spaced, TODAY, EXAM_DATE);
    expect(result[0].task).toBe("정리");
  });

  it("JSON 배열 없음 → 에러 throw", () => {
    expect(() => parsePlanJson("아무 텍스트", TODAY, EXAM_DATE)).toThrow();
  });

  it("배열이 아닌 객체 → 에러 throw", () => {
    const obj = JSON.stringify({ day: TODAY, task: "단원" });
    expect(() => parsePlanJson(obj, TODAY, EXAM_DATE)).toThrow();
  });

  it("day 형식 잘못됨 → 에러 throw", () => {
    const bad = JSON.stringify([{ day: "20260709", task: "공부" }]);
    expect(() => parsePlanJson(bad, TODAY, EXAM_DATE)).toThrow();
  });

  it("day가 오늘보다 이전 → 에러 throw", () => {
    const bad = JSON.stringify([{ day: "2026-07-08", task: "과거 공부" }]);
    expect(() => parsePlanJson(bad, TODAY, EXAM_DATE)).toThrow();
  });

  it("day가 시험일보다 이후 → 에러 throw", () => {
    const bad = JSON.stringify([{ day: "2026-07-21", task: "시험 후" }]);
    expect(() => parsePlanJson(bad, TODAY, EXAM_DATE)).toThrow();
  });

  it("task 비어있음 → 에러 throw", () => {
    const bad = JSON.stringify([{ day: TODAY, task: "  " }]);
    expect(() => parsePlanJson(bad, TODAY, EXAM_DATE)).toThrow();
  });

  it("task 누락 → 에러 throw", () => {
    const bad = JSON.stringify([{ day: TODAY }]);
    expect(() => parsePlanJson(bad, TODAY, EXAM_DATE)).toThrow();
  });

  it("항목이 객체가 아닌 경우 → 에러 throw", () => {
    const bad = JSON.stringify(["2026-07-09"]);
    expect(() => parsePlanJson(bad, TODAY, EXAM_DATE)).toThrow();
  });

  it("시험일 당일 포함 가능", () => {
    const onExamDate = JSON.stringify([{ day: EXAM_DATE, task: "총정리" }]);
    const result = parsePlanJson(onExamDate, TODAY, EXAM_DATE);
    expect(result[0].day).toBe(EXAM_DATE);
  });

  it("오늘 = 시험일인 경우도 가능", () => {
    const sameDay = JSON.stringify([{ day: TODAY, task: "총정리" }]);
    const result = parsePlanJson(sameDay, TODAY, TODAY);
    expect(result[0].day).toBe(TODAY);
  });
});
