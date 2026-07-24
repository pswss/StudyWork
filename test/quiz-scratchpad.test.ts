import { describe, expect, it } from "vitest";
import {
  decodeScratchpadState,
  encodeScratchpadState,
  recordScratchpadChange,
  scratchpadStorageKey,
  scratchpadStrokeWidth,
  undoScratchpadChange,
  type ScratchpadStroke,
} from "../web/src/pages/QuizScratchpad";

function stroke(index: number): ScratchpadStroke {
  return {
    tool: "pen",
    points: [{ x: index / 200, y: 0.5, pressure: 0.5 }],
  };
}

describe("문제 풀이판 기록", () => {
  it("전체 지우기도 한 번의 되돌리기로 복구한다", () => {
    const original = [stroke(1), stroke(2)];
    const cleared = recordScratchpadChange(original, [], []);
    expect(cleared.strokes).toEqual([]);

    const restored = undoScratchpadChange(cleared.strokes, cleared.history);
    expect(restored.strokes).toEqual(original);
    expect(restored.history).toEqual([]);
  });

  it("오래 쓴 풀이에서도 획과 되돌리기 기록 상한을 지킨다", () => {
    const tooMany = Array.from({ length: 200 }, (_, index) => stroke(index));
    let model = recordScratchpadChange([], [], tooMany);
    expect(model.strokes).toHaveLength(160);
    expect(model.strokes[0]).toBe(tooMany[40]);

    for (let index = 0; index < 60; index++) {
      model = recordScratchpadChange(model.strokes, model.history, [...model.strokes, stroke(index)]);
    }
    expect(model.history).toHaveLength(50);
  });

  it("필압이 높을수록 선이 굵고 지우개는 펜보다 넓다", () => {
    expect(scratchpadStrokeWidth("pen", 1)).toBeGreaterThan(scratchpadStrokeWidth("pen", 0.1));
    expect(scratchpadStrokeWidth("eraser", 0.5)).toBeGreaterThan(scratchpadStrokeWidth("pen", 0.5));
  });

  it("필기와 사용자 메모를 문제별 같은 로컬 저장 키로 원문 그대로 복원한다", () => {
    const memo = "∫₀¹ f(x)dx = α\n중국어 中文 / español도 번역하지 않음";
    const state = { strokes: [stroke(7)], memo };

    expect(scratchpadStorageKey(17)).toBe("studywork:quiz-scratchpad:17");
    expect(scratchpadStorageKey(18)).not.toBe(scratchpadStorageKey(17));
    expect(decodeScratchpadState(encodeScratchpadState(state))).toEqual(state);
  });

  it("기존 필기 배열 저장값도 메모 없이 복원한다", () => {
    expect(decodeScratchpadState(JSON.stringify([stroke(3)]))).toEqual({
      strokes: [stroke(3)],
      memo: "",
    });
  });
});
