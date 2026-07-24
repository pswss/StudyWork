import { describe, expect, it } from "vitest";
import { learnerEffortLabel, learnerModelLabel } from "../web/src/pages/AISettingsPanel";

describe("AI settings learner language", () => {
  it("shows the actual server model and effort values without abstract aliases", () => {
    const models = [
      "gpt-5.6-sol",
      "gpt-5.6-sol-fast",
      "gpt-5.6-luna",
      "gpt-5.6-luna-fast",
      "gpt-5.6-terra",
      "gpt-5.6-terra-fast",
    ].map(learnerModelLabel);

    expect(new Set(models).size).toBe(models.length);
    expect(learnerModelLabel("gpt-5.6-sol")).toBe("GPT-5.6 sol");
    expect(learnerModelLabel("gpt-5.6-sol-fast")).toBe("GPT-5.6 sol-fast");
    expect(learnerEffortLabel("low")).toBe("effort low");
    expect(learnerEffortLabel("high")).toBe("effort high");
    expect(learnerEffortLabel("max")).toBe("effort max");
    expect(learnerEffortLabel("ultra")).toBe("effort ultra");
    expect(learnerModelLabel("unknown-model")).toBe("unknown-model");
    expect(learnerEffortLabel("toString")).toBe("effort toString");
  });
});
