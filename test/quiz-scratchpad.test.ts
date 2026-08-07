import { describe, expect, it } from "vitest";
import {
  annotationStorageKey,
  decodeInkPreferences,
  decodeScratchpadState,
  encodeScratchpadState,
  recordScratchpadChange,
  redoScratchpadChange,
  scratchpadCanvasPixelRatio,
  scratchpadMidpoint,
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

    const redone = redoScratchpadChange(restored.strokes, restored.history, [cleared.strokes]);
    expect(redone.strokes).toEqual([]);
    expect(redone.history).toEqual([original]);
    expect(redone.future).toEqual([]);
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
    expect(scratchpadStrokeWidth("pen", 1, 4, false)).toBe(scratchpadStrokeWidth("pen", 0.1, 4, false));
    expect(scratchpadStrokeWidth("highlighter", 0.1, 21)).toBe(21);
  });

  it("중간점 보간으로 연속된 획의 곡선을 만든다", () => {
    const midpoint = scratchpadMidpoint(
      { x: 0.2, y: 0.4, pressure: 0.3 },
      { x: 0.6, y: 0.8, pressure: 0.9 },
    );
    expect(midpoint.x).toBeCloseTo(0.4);
    expect(midpoint.y).toBeCloseTo(0.6);
    expect(midpoint.pressure).toBeCloseTo(0.6);
  });

  it("긴 지문 캔버스는 Retina 선명도를 유지하되 메모리 상한을 넘지 않는다", () => {
    expect(scratchpadCanvasPixelRatio(800, 500, 3)).toBe(2);
    expect(scratchpadCanvasPixelRatio(800, 8_000, 3)).toBeCloseTo(Math.sqrt(12_000_000 / 6_400_000));
  });

  it("필기와 사용자 메모를 문제별 같은 로컬 저장 키로 원문 그대로 복원한다", () => {
    const memo = "∫₀¹ f(x)dx = α\n중국어 中文 / español도 번역하지 않음";
    const state = { strokes: [stroke(7)], memo };

    expect(scratchpadStorageKey(17)).toBe("studywork:quiz-scratchpad:17");
    expect(scratchpadStorageKey(18)).not.toBe(scratchpadStorageKey(17));
    expect(decodeScratchpadState(encodeScratchpadState(state))).toEqual(state);
  });

  it("문제 위 필기는 풀이판과 겹치지 않는 문제별 키를 쓴다", () => {
    expect(annotationStorageKey(17)).toBe("studywork:quiz-annotation:17");
    expect(annotationStorageKey(17)).not.toBe(scratchpadStorageKey(17));
    expect(annotationStorageKey(18)).not.toBe(annotationStorageKey(17));
  });

  it("기존 필기 배열 저장값도 메모 없이 복원한다", () => {
    expect(decodeScratchpadState(JSON.stringify([stroke(3)]))).toEqual({
      strokes: [stroke(3)],
      memo: "",
    });
  });

  it("세부 필기 설정은 경계를 검증하고 안전한 기본값으로 복구한다", () => {
    expect(decodeInkPreferences(JSON.stringify({
      penColor: "#ABCDEF",
      penSize: 99,
      highlighterColor: "not-a-color",
      highlighterSize: 4,
      eraserSize: 24,
      pressure: false,
      pencilOnly: true,
    }))).toEqual({
      penColor: "#abcdef",
      penSize: 8,
      highlighterColor: "#fff066",
      highlighterSize: 6,
      eraserSize: 24,
      pressure: false,
      pencilOnly: true,
    });
  });

  it("새 획의 도구·색·굵기·필압 설정을 문제별 저장값에 보존한다", () => {
    const styled: ScratchpadStroke = {
      tool: "highlighter",
      color: "#FF72B6",
      size: 19,
      pressure: false,
      points: [{ x: 0.2, y: 0.3, pressure: 0.7 }],
    };
    expect(decodeScratchpadState(encodeScratchpadState({ strokes: [styled], memo: "" })).strokes)
      .toEqual([{ ...styled, color: "#ff72b6" }]);
  });
});
