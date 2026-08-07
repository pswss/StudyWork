import { describe, expect, it } from "vitest";
import { getMockExamBlueprint, MOCK_EXAM_AREAS, validateMockExamChunk } from "../src/mock-exam";

describe("2028 수능형 모의고사 청사진", () => {
  it.each(MOCK_EXAM_AREAS)("%s 문항 번호·총점·청크가 완결됨", (area) => {
    const blueprint = getMockExamBlueprint(area);
    expect(blueprint.specs).toHaveLength(blueprint.count);
    expect(blueprint.specs.map((spec) => spec.number)).toEqual(
      Array.from({ length: blueprint.count }, (_, index) => index + 1),
    );
    expect(blueprint.specs.reduce((sum, spec) => sum + spec.points, 0)).toBe(blueprint.totalPoints);
    expect(blueprint.chunks.flatMap(([from, to]) =>
      Array.from({ length: to - from + 1 }, (_, index) => from + index)
    )).toEqual(Array.from({ length: blueprint.count }, (_, index) => index + 1));
  });

  it("국어는 화법·언어 10, 독서·작문 20, 문학 15문항", () => {
    const specs = getMockExamBlueprint("korean").specs;
    expect(specs.filter((spec) => spec.section === "화법과 언어")).toHaveLength(10);
    expect(specs.filter((spec) => spec.section === "독서와 작문")).toHaveLength(20);
    expect(specs.filter((spec) => spec.section === "문학")).toHaveLength(15);
    expect(specs.every((spec) => spec.qtype === "mcq")).toBe(true);
  });

  it("수학은 1~21번 5지선다, 22~30번 단답형", () => {
    const specs = getMockExamBlueprint("math").specs;
    expect(specs.slice(0, 21).every((spec) => spec.qtype === "mcq")).toBe(true);
    expect(specs.slice(21).every((spec) => spec.qtype === "short")).toBe(true);
    expect(specs.map((spec) => spec.points)).toEqual([
      2, 2, 2, 3, 3, 3, 3, 3, 3, 3,
      3, 3, 3, 4, 4, 4, 4, 4, 4, 4,
      4, 3, 3, 3, 3, 4, 4, 4, 4, 4,
    ]);
  });

  it("수학 단답형은 수능 답란 범위의 정수만 허용", () => {
    const spec = getMockExamBlueprint("math").specs[21];
    expect(() => validateMockExamChunk([{
      number: spec.number,
      section: spec.section,
      passage_group: null,
      passage: null,
      qtype: "short",
      difficulty: spec.difficulty,
      question: "조건을 만족하는 값을 구하시오.",
      choices: null,
      answer: "1/2",
      explanation: "계산 결과는 1/2이다.",
    }], [spec])).toThrow("0~999 정수");
  });

  it("영어는 45문항 중 앞 17문항이 듣기", () => {
    const specs = getMockExamBlueprint("english").specs;
    expect(specs.slice(0, 17).every((spec) => spec.section === "듣기")).toBe(true);
    expect(specs.slice(17).every((spec) => spec.section === "읽기")).toBe(true);
    expect(specs[0].passage_brief).toContain("Woman:");
  });
});
