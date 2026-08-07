import { describe, expect, it } from "vitest";
import { narrationSegments } from "../web/src/TranscriptNarration";

describe("영어 듣기 대본 내레이션", () => {
  it("마크다운 화자 라벨을 제거하고 서로 다른 음성 역할로 나눔", () => {
    expect(narrationSegments(
      "다음을 듣고 답하시오.\n**Woman:** Good morning. **Man:** Hi there.\n> Narrator: Listen carefully.\n[Door opens] **A:** Welcome!",
    )).toEqual([
      { text: "Good morning.", role: "female" },
      { text: "Hi there.", role: "male" },
      { text: "Listen carefully.", role: "neutral" },
      { text: "Welcome!", role: "female" },
    ]);
  });
});
