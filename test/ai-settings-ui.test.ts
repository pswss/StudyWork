import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AI_SETTING_GROUPS } from "../web/src/pages/AISettingsPanel";

describe("AI settings task groups", () => {
  it("maps each visible AI task exactly once", () => {
    const operations = AI_SETTING_GROUPS.flatMap(group => [...group.operations]);
    expect(new Set(operations).size).toBe(operations.length);
    expect(operations).not.toContain("chat");
    expect(operations).toEqual(expect.arrayContaining([
      "material-extract",
      "section-map",
      "answer-key-detect",
      "problem-extract",
      "question-extract",
      "question-generate",
      "consolidate",
      "consolidate-chunk",
      "consolidate-merge",
      "wrong-answer-analysis",
      "study-plan",
    ]));
  });

  it("설정 탭과 채팅이 검색 없는 공용 선택기를 사용한다", () => {
    const settings = readFileSync("web/src/pages/AISettingsPanel.tsx", "utf8");
    const chat = readFileSync("web/src/pages/ChatPanel.tsx", "utf8");
    const detail = readFileSync("web/src/pages/SubjectDetail.tsx", "utf8");

    expect(settings).not.toContain("<select");
    expect(settings.match(/<SingleSelectPicker/g)).toHaveLength(3);
    expect(chat).toContain("apiUpdateAISettings({ operations: { chat: next } })");
    expect(chat).toContain('className="chat-ai-settings"');
    expect(detail).toContain('quiz: "문제"');
    expect(detail).toContain('id="subject-panel-quiz"');
  });
});
