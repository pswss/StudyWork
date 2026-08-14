import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  figureAlt,
  groupKoreanPassageQuestions,
  numberedQuestionText,
  quizResultScore,
  quizShortcutChoice,
} from "../web/src/pages/Quiz";
import type { Question } from "../web/src/api";

describe("quiz interaction polish", () => {
  it("maps answer shortcuts and keeps setup progressively disclosed", () => {
    expect(quizShortcutChoice({ qtype: "mcq", choices: ["가", "나", "다"] }, "2")).toBe("나");
    expect(quizShortcutChoice({ qtype: "mcq", choices: ["가"] }, "2")).toBeNull();
    expect(quizShortcutChoice({ qtype: "ox", choices: null }, "x")).toBe("X");
    expect(quizShortcutChoice({ qtype: "short", choices: null }, "1")).toBeNull();

    const source = readFileSync("web/src/pages/Quiz.tsx", "utf8");
    expect(source).toContain('className="quiz-generate-disclosure"');
    expect(source).toContain("eligibleStartCount");
    expect(source).toContain('aria-keyshortcuts="Enter"');
    expect(source).toContain('t("problems.bank.noEligible")');
    expect(source).toContain("questionFrameRef.current?.focus()");
    expect(source).toContain("resultRef.current?.focus()");
    expect(source).toContain("doGenerateMockExam");
    expect(source).toContain('"problems.mock.generate"');
    expect(source).toContain("ordered: true");
    expect(source).toContain('className="quiz-passage"');
    expect(source).toContain("points: item.exam_points");
    expect(source).toContain("quizResultScore(resultScores)");
    expect(source).toContain('<TranscriptNarration text={item.passage} />');
  });

  it("모의고사는 문항 수가 아니라 배점으로 결과를 계산", () => {
    expect(quizResultScore([
      { correct: true, points: 4 },
      { correct: false, points: 2 },
    ])).toEqual({ weighted: true, score: 4, total: 6, pct: 67 });
    expect(quizResultScore([
      { correct: true, points: null },
      { correct: false, points: null },
    ])).toEqual({ weighted: false, score: 1, total: 2, pct: 50 });
  });

  it("uses extracted figure descriptions with a legacy fallback", () => {
    expect(figureAlt("x축의 2와 y축의 3을 지나는 점 A", 4)).toBe("x축의 2와 y축의 3을 지나는 점 A");
    expect(figureAlt(null, 4, 2)).toContain("2번 문제");

    const source = readFileSync("web/src/pages/Quiz.tsx", "utf8");
    expect(source.match(/figureAlt\(/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps the workbook number in front without duplicating an existing prefix", () => {
    expect(numberedQuestionText({ question: "함수의 값을 구하시오.", printed_number: "17" }))
      .toBe("17. 함수의 값을 구하시오.");
    expect(numberedQuestionText({ question: "17. 함수의 값을 구하시오.", printed_number: "17" }))
      .toBe("17. 함수의 값을 구하시오.");
    expect(numberedQuestionText({ question: "레거시 문항", book_number: "8" }))
      .toBe("8. 레거시 문항");
    expect(numberedQuestionText({ question: "AI 생성 문항" })).toBe("AI 생성 문항");
  });

  it("국어 공통 지문은 펼침 단위 하나에 연결 문항을 모두 묶음", () => {
    const question = (id: number, section: string, group: string | null, passage: string | null) => ({
      id,
      mock_exam_job_id: 8,
      exam_section: section,
      passage_group: group,
      passage,
    } as Question);
    const blocks = groupKoreanPassageQuestions([
      question(11, "독서와 작문", "인문·예술", "긴 공통 지문"),
      question(12, "독서와 작문", "인문·예술", "긴 공통 지문"),
      question(13, "독서와 작문", "인문·예술", "긴 공통 지문"),
      question(14, "영어", "독해", "English passage"),
    ]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      kind: "passage",
      passageGroup: "인문·예술",
      passage: "긴 공통 지문",
      items: [{ id: 11 }, { id: 12 }, { id: 13 }],
    });
    expect(blocks[1]).toMatchObject({ kind: "question", item: { id: 14 } });

    const source = readFileSync("web/src/pages/Quiz.tsx", "utf8");
    expect(source).toContain('className="quiz-korean-passage-document"');
    expect(source).toContain('className="quiz-passage-question-list"');
  });
});
