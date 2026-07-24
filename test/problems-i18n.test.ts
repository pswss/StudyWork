import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider, LOCALES, translate, type Locale } from "../web/src/i18n";
import { figureAlt } from "../web/src/pages/Quiz";
import QuizScratchpad from "../web/src/pages/QuizScratchpad";

const expected = {
  ko: { start: "문제 풀기", scratch: "풀이판" },
  en: { start: "Start problems", scratch: "Scratchpad" },
  "zh-CN": { start: "开始答题", scratch: "草稿板" },
  es: { start: "Empezar", scratch: "Pizarra" },
} satisfies Record<Locale, { start: string; scratch: string }>;

describe("문제 도메인 다국어", () => {
  it.each(LOCALES)("%s UI 사전과 실제 풀이판을 해당 언어로 렌더링한다", locale => {
    expect(translate(locale, "problems.bank.start")).toBe(expected[locale].start);
    const html = renderToStaticMarkup(createElement(I18nProvider, {
      initialLocale: locale,
      children: createElement(QuizScratchpad, { questionId: 42 }),
    }));
    expect(html).toContain(expected[locale].scratch);
    expect(html).toContain(translate(locale, "problems.scratch.pen"));
    expect(html).toContain(translate(locale, "problems.scratch.undo"));
    expect(html).toContain(translate(locale, "problems.scratch.memoLabel"));
    expect(html).toContain("<textarea");
  });

  it("문제·보기·정답·해설·파일명은 번역하지 않고 UI 보간값으로 그대로 둔다", () => {
    const sourceDescription = "좌표평면의 점 A(α, β) — 원문 그대로";
    for (const locale of LOCALES) {
      const t = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) =>
        translate(locale, key, values);
      expect(figureAlt(sourceDescription, 7, undefined, t)).toBe(sourceDescription);

      const sourceText = "문제 본문 Δ(x)=α+β";
      expect(translate(locale, "problems.delete.aria", { question: sourceText })).toContain(sourceText);
    }

    const quiz = readFileSync("web/src/pages/Quiz.tsx", "utf8");
    const scratchpad = readFileSync("web/src/pages/QuizScratchpad.tsx", "utf8");
    const wrong = readFileSync("web/src/pages/Wrong.tsx", "utf8");
    for (const contentBinding of [
      "text={item.question}",
      "text={submittedAnswer}",
      "text={play.result.answer}",
      "text={q.question}",
      "text={q.answer}",
      "text={q.explanation}",
      "text={c}",
    ]) {
      expect(`${quiz}\n${wrong}`).toContain(contentBinding);
    }
    expect(quiz).not.toMatch(/t\((?:item|q|play)\.(?:question|answer|explanation)/);
    expect(scratchpad).toContain("value={memo}");
    expect(scratchpad).not.toMatch(/t\(memo(?:Ref)?/);
    for (const value of ["하", "중", "상", "혼합"]) {
      expect(quiz).toMatch(new RegExp(`value(?:=|:)\\s*"${value}"`));
    }
  });
});
