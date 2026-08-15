import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  figureAlt,
  groupKoreanPassageQuestions,
  numberedQuestionText,
  passageQuestionText,
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
    const styles = readFileSync("web/src/styles.css", "utf8");
    expect(source).toContain('className="quiz-korean-passage-document"');
    expect(source).toContain('className="quiz-passage-question-list"');
    expect(source).toContain('className="quiz-korean-exam-sheet"');
    expect(styles).toContain("grid-template-columns: minmax(0, 1.08fr) minmax(0, .92fr)");
    expect(styles).toContain('.quiz-passage-set-toggle[aria-expanded="true"]');
  });

  it("업로드한 국어 기출도 공식 번호 범위의 지문을 한 번만 표시", () => {
    const passage = "[16 ~ 18] 다음 글을 읽고 물음에 답하시오.\n\n공통 지문 첫 문단입니다.\n\n공통 지문 둘째 문단입니다.\n\n";
    const question = (id: number, number: string, stem: string) => ({
      id,
      source: "uploaded",
      src_file_id: 42,
      printed_number: number,
      book_number: number,
      question: passage + stem,
      mock_exam_job_id: null,
      exam_section: null,
      passage_group: null,
      passage: null,
    } as Question);
    const items = [
      question(16, "16", "윗글의 주제로 적절한 것은?"),
      question(17, "17", "윗글의 내용과 일치하는 것은?"),
      question(18, "18", "윗글을 바탕으로 추론한 것은?"),
    ];

    const blocks = groupKoreanPassageQuestions(items);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: "passage",
      passageGroup: "16~18번 공통 지문",
      passage: passage.trim(),
      items: [{ id: 16 }, { id: 17 }, { id: 18 }],
    });
    if (blocks[0].kind !== "passage") throw new Error("공통 지문으로 묶이지 않았습니다");
    expect(passageQuestionText(blocks[0], items[1])).toBe("윗글의 내용과 일치하는 것은?");
  });

  it("문항별 공백이 달라도 공식 번호 범위 전체를 한 지문으로 묶음", () => {
    const question = (id: number, number: string, passage: string, stem: string) => ({
      id,
      source: "uploaded",
      src_file_id: 42,
      printed_number: number,
      book_number: number,
      question: `${passage}\n\n${number}. ${stem}`,
      mock_exam_job_id: null,
      exam_section: null,
      passage_group: null,
      passage: null,
    } as Question);
    const items = [
      question(22, "22", "[22~25] 다음 글을 읽고 물음에 답하시오.\n\n첫 문단", "설명으로 적절하지 않은 것은?"),
      question(23, "23", "[22 ~ 25] 다음 글을 읽고 물음에 답하시오.\n\n첫 문단\n\n둘째 문단", "그림의 설명으로 적절하지 않은 것은?"),
      question(24, "24", "[22～25] 다음 글을 읽고 물음에 답하시오.\n\n첫 문단", "㉠에 들어갈 내용은?"),
      question(25, "25", "[22 ∼ 25] 다음 글을 읽고 물음에 답하시오.\n\n첫 문단", "사전적 의미로 적절하지 않은 것은?"),
    ];

    const blocks = groupKoreanPassageQuestions(items);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: "passage",
      passageGroup: "22~25번 공통 지문",
      passage: "[22 ~ 25] 다음 글을 읽고 물음에 답하시오.\n\n첫 문단\n\n둘째 문단",
      items: [{ id: 22 }, { id: 23 }, { id: 24 }, { id: 25 }],
    });
    if (blocks[0].kind !== "passage") throw new Error("공통 지문으로 묶이지 않았습니다");
    expect(passageQuestionText(blocks[0], items[2])).toBe("㉠에 들어갈 내용은?");
  });
});
