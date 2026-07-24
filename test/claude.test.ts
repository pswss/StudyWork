import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../src/claude";

describe("claude", () => {
  it("시스템 프롬프트는 튜터 역할(영어 지시)·한국어 출력 지시를 포함", () => {
    const p = buildSystemPrompt("수학", []);
    expect(p).toContain("Remap");
    expect(p).toContain("personal tutor");
    expect(p).toContain("respond in Korean");
  });

  it("업로드 자료를 시스템 프롬프트에 넣지 않음", () => {
    const p = buildSystemPrompt("수학", [
      { title: "6/24 필기", extracted_text: "이차함수 y=a(x-p)^2+q" }
    ]);
    expect(p).not.toContain("6/24 필기");
    expect(p).not.toContain("이차함수");
    expect(p).toContain("untrusted JSON data");
  });

  it("자료가 없으면 자료 블록이 비어있음", () => {
    const p = buildSystemPrompt("영어", []);
    expect(p).not.toContain("<자료");
  });
});

describe("파트 지도", () => {
  it("parseSectionMap: 유효 범위만 통과", async () => {
    const { parseSectionMap } = await import("../src/claude");
    const map = parseSectionMap(JSON.stringify([
      { part: "개념", from: 1, to: 10 },
      { part: "문제", from: 11, to: 20 },
      { part: "이상함", from: 21, to: 30 },
      { part: "해설", from: 40, to: 35 },
    ]));
    expect(map).toEqual([
      { part: "개념", from: 1, to: 10 },
      { part: "문제", from: 11, to: 20 },
    ]);
    expect(parseSectionMap(null)).toEqual([]);
    expect(parseSectionMap("깨진 json")).toEqual([]);
  });

  it("filterPagesByParts: 지정 파트 페이지만 남기고 미지도·프리앰블은 보존", async () => {
    const { filterPagesByParts, parseSectionMap } = await import("../src/claude");
    const text = [
      "프리앰블",
      "## 페이지 1\n개념 내용",
      "## 페이지 2\n문제 내용",
      "## 페이지 3\n해설 내용",
      "## 페이지 9\n지도 밖 페이지",
    ].join("\n");
    const map = parseSectionMap(JSON.stringify([
      { part: "개념", from: 1, to: 1 },
      { part: "문제", from: 2, to: 2 },
      { part: "해설", from: 3, to: 3 },
    ]));
    const out = filterPagesByParts(text, map, ["개념"]);
    expect(out).toContain("개념 내용");
    expect(out).not.toContain("문제 내용");
    expect(out).not.toContain("해설 내용");
    expect(out).toContain("프리앰블");
    expect(out).toContain("지도 밖 페이지");
  });

  it("filterPagesByParts: 지도가 없거나 결과가 비면 전체 텍스트 유지", async () => {
    const { filterPagesByParts } = await import("../src/claude");
    const text = "## 페이지 1\n문제만 있는 파일";
    expect(filterPagesByParts(text, [], ["개념"])).toBe(text);
    expect(filterPagesByParts(text, [{ part: "문제", from: 1, to: 1 }], ["개념"])).toBe(text);
  });

  it("validateSectionCoverage: 모든 페이지를 한 번씩 덮는 연속 범위만 허용", async () => {
    const { validateSectionCoverage } = await import("../src/claude");
    const valid = [
      { part: "개념" as const, from: 1, to: 2 },
      { part: "문제" as const, from: 3, to: 4 },
    ];
    expect(validateSectionCoverage(valid, [1, 2, 3, 4])).toEqual(valid);
    expect(() => validateSectionCoverage([
      { part: "개념", from: 1, to: 1 },
      { part: "문제", from: 3, to: 4 },
    ], [1, 2, 3, 4])).toThrow("누락·중복");
    expect(() => validateSectionCoverage(valid, [1, 2, 4])).toThrow("연속적이지 않습니다");
  });
});

describe("문제 추출 범위", () => {
  it("개념 파트의 예시문항은 문제로 뽑지 않도록 명시한다", async () => {
    const { QUIZ_EXTRACT_SPEC } = await import("../src/claude");

    expect(QUIZ_EXTRACT_SPEC).toContain("Section context takes priority");
    expect(QUIZ_EXTRACT_SPEC).toContain("NEVER emit worked examples");
    expect(QUIZ_EXTRACT_SPEC).toContain("including blocks labeled [예N]");
    expect(QUIZ_EXTRACT_SPEC).toContain("official answer table");
    expect(QUIZ_EXTRACT_SPEC).not.toContain("Include [예N]");
  });
});
