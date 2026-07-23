import { describe, expect, it } from "vitest";
import { learnerEffortLabel, learnerModelLabel } from "../web/src/pages/AISettingsPanel";

describe("AI settings learner language", () => {
  it("turns runtime codes into distinct learner-facing choices", () => {
    const models = [
      "gpt-5.6-sol",
      "gpt-5.6-sol-fast",
      "gpt-5.6-luna",
      "gpt-5.6-luna-fast",
      "gpt-5.6-terra",
      "gpt-5.6-terra-fast",
    ].map(learnerModelLabel);

    expect(new Set(models).size).toBe(models.length);
    expect(learnerEffortLabel("low")).toBe("빠름");
    expect(learnerEffortLabel("high")).toBe("균형");
    expect(learnerEffortLabel("max")).toBe("최대 정밀");
    expect(learnerEffortLabel("ultra")).toBe("최고 정밀");
    expect(learnerModelLabel("unknown-model")).toBe("사용자 지정");
    expect(learnerEffortLabel("toString")).toBe("자동");
  });
});
