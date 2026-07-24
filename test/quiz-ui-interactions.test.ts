import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { figureAlt, quizShortcutChoice } from "../web/src/pages/Quiz";

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
  });

  it("uses extracted figure descriptions with a legacy fallback", () => {
    expect(figureAlt("x축의 2와 y축의 3을 지나는 점 A", 4)).toBe("x축의 2와 y축의 3을 지나는 점 A");
    expect(figureAlt(null, 4, 2)).toContain("2번 문제");

    const source = readFileSync("web/src/pages/Quiz.tsx", "utf8");
    expect(source.match(/figureAlt\(/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
