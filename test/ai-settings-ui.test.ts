import { describe, expect, it } from "vitest";
import { AI_SETTING_GROUPS } from "../web/src/pages/AISettingsPanel";

describe("AI settings task groups", () => {
  it("maps each visible AI task exactly once", () => {
    const operations = AI_SETTING_GROUPS.flatMap(group => [...group.operations]);
    expect(new Set(operations).size).toBe(operations.length);
    expect(operations).toEqual(expect.arrayContaining([
      "chat",
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
});
