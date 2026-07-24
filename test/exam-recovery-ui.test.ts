// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  exams: vi.fn(),
  createExam: vi.fn(),
  aiJob: vi.fn(),
  cancelAIJob: vi.fn(),
  togglePlanItem: vi.fn(),
  replanExam: vi.fn(),
  deleteExam: vi.fn(),
}));

vi.mock("../web/src/api", () => ({
  ...api,
  NotFoundError: class NotFoundError extends Error {},
}));

import Exam from "../web/src/pages/Exam";
import { UndoDeleteProvider } from "../web/src/UndoDelete";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

const subject = {
  id: 1,
  name: "수학",
  material_count: 0,
  created_at: "2026-07-23T00:00:00Z",
};

function examFixture() {
  return {
    id: 9,
    subject_id: 1,
    title: "기말고사",
    exam_date: "2099-07-30",
    scope: "1~3단원",
    created_at: "2026-07-23T00:00:00Z",
    done_count: 0,
    items: [{ id: 91, exam_id: 9, day: "2099-07-20", task: "1단원 복습", done: 0 }],
  };
}

async function renderExam() {
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(UndoDeleteProvider, null, createElement(Exam, { subject })));
    await Promise.resolve();
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  await act(async () => { (container.querySelector(".exam-card-header") as HTMLElement).click(); });
  return container;
}

async function click(element: Element) {
  await act(async () => {
    (element as HTMLElement).click();
    await Promise.resolve();
  });
}

function button(container: ParentNode, text: string) {
  const match = Array.from(container.querySelectorAll("button")).find(node => node.textContent?.trim() === text);
  if (!match) throw new Error(`button not found: ${text}`);
  return match;
}

beforeEach(() => {
  sessionStorage.clear();
  api.exams.mockReset().mockResolvedValue([examFixture()]);
  api.createExam.mockReset();
  api.aiJob.mockReset().mockResolvedValue({
    id: 44,
    subject_id: 1,
    kind: "exam_replan",
    status: "processing",
    result: null,
    error: null,
  });
  api.cancelAIJob.mockReset().mockResolvedValue(undefined);
  api.togglePlanItem.mockReset();
  api.replanExam.mockReset();
  api.deleteExam.mockReset();
  vi.stubGlobal("confirm", vi.fn(() => true));
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("시험 계획 실패 복구", () => {
  it("접을 때 상세를 바로 없애지 않고 짧은 퇴장 뒤 숨긴다", async () => {
    const container = await renderExam();
    vi.useFakeTimers();

    await click(container.querySelector(".exam-card-header")!);

    const detail = container.querySelector(".exam-card-detail") as HTMLElement;
    expect(detail.classList.contains("closing")).toBe(true);
    expect(detail.hidden).toBe(false);
    expect(container.querySelector(".exam-card-header")?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      vi.advanceTimersByTime(160);
      await Promise.resolve();
    });

    expect(detail.hidden).toBe(true);
    expect(detail.textContent).toBe("");
  });

  it("체크 저장 실패를 롤백하고 같은 항목을 다시 시도한다", async () => {
    api.togglePlanItem
      .mockRejectedValueOnce(new Error("연결이 끊겼습니다"))
      .mockResolvedValueOnce({ ok: true });
    const container = await renderExam();

    await click(container.querySelector(".exam-checkbox")!);

    const error = container.querySelector('[role="alert"]')!;
    expect((container.querySelector(".exam-checkbox") as HTMLInputElement).checked).toBe(false);
    expect(error.textContent).toContain("이전 상태로 되돌렸습니다");
    expect(error.textContent).toContain("연결이 끊겼습니다");

    await click(button(error, "다시 시도"));

    expect(api.togglePlanItem).toHaveBeenNthCalledWith(1, 91, true);
    expect(api.togglePlanItem).toHaveBeenNthCalledWith(2, 91, true);
    expect((container.querySelector(".exam-checkbox") as HTMLInputElement).checked).toBe(true);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("재계획 실패 후 기존 일정을 보존하고 다시 시작한다", async () => {
    api.replanExam
      .mockRejectedValueOnce(new Error("AI가 응답하지 않았습니다"))
      .mockResolvedValueOnce({ jobId: 44, status: "processing" });
    const container = await renderExam();

    await click(button(container, "계획 조정"));

    const error = container.querySelector('[role="alert"]')!;
    expect(error.textContent).toContain("기존 일정은 그대로 유지됐습니다");
    expect(container.textContent).toContain("1단원 복습");

    await click(button(error, "다시 시도"));

    expect(api.replanExam).toHaveBeenCalledTimes(2);
    // 다중 작업 추적: 저장 형식이 단일 숫자 → [{id, examId}] 목록으로 바뀌었다
    expect(sessionStorage.getItem("studywork:exam-job:1")).toBe(JSON.stringify([{ id: 44, examId: 9 }]));
    expect(container.querySelector(".exam-card")).not.toBeNull();
    expect(container.textContent).toContain("시험 학습 계획 생성 중");
  });

  it("삭제 실패 시 목록을 보존하고 재시도 성공 뒤에만 제거한다", async () => {
    api.deleteExam
      .mockRejectedValueOnce(new Error("삭제 권한이 없습니다"))
      .mockResolvedValueOnce(undefined);
    const container = await renderExam();
    vi.useFakeTimers();

    await click(button(container, "삭제"));
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });

    const error = container.querySelector('[role="alert"]')!;
    expect(error.textContent).toContain("목록과 일정은 그대로 유지됐습니다");
    expect(container.querySelectorAll(".exam-card")).toHaveLength(1);

    await click(button(error, "다시 시도"));
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });

    expect(api.deleteExam).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll(".exam-card")).toHaveLength(0);
  });
});
