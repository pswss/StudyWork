// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  materials: vi.fn(),
  messages: vi.fn(),
  aiStatus: vi.fn(),
  books: vi.fn(),
  uploadBookExplanations: vi.fn(),
  aiJob: vi.fn(),
  cancelAIJob: vi.fn(),
}));

vi.mock("../web/src/api", () => ({
  ...api,
  NotFoundError: class NotFoundError extends Error {},
}));
vi.mock("../web/src/pages/Quiz", () => ({ default: () => null }));
vi.mock("../web/src/pages/Wrong", () => ({ default: () => null }));
vi.mock("../web/src/pages/Exam", () => ({ default: () => null }));
vi.mock("../web/src/pages/AISettingsPanel", () => ({ default: () => null }));
vi.mock("../web/src/pages/ChatPanel", () => ({ default: () => null }));
vi.mock("../web/src/pages/NotesPanel", () => ({ default: () => null }));
vi.mock("../web/src/pages/MaterialsSidebar", () => ({
  default: () => null,
  uploadValidationError: () => null,
}));
vi.mock("../web/src/motion", () => ({
  Reveal: ({ children }: { children?: unknown }) => children,
}));

import SubjectDetail from "../web/src/pages/SubjectDetail";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const storedValues = new Map<string, string>();
Object.defineProperty(window, "localStorage", { configurable: true, value: {
  clear: () => storedValues.clear(),
  getItem: (key: string) => storedValues.get(key) ?? null,
  removeItem: (key: string) => storedValues.delete(key),
  setItem: (key: string, value: string) => storedValues.set(key, String(value)),
} });

const subject = { id: 7, name: "수학", material_count: 0, created_at: "2026-07-23" };
let roots: Root[] = [];

async function renderDetail() {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(createElement(SubjectDetail, { subject, onBack: () => {} }));
    await Promise.resolve();
  });
  return container;
}

beforeEach(() => {
  window.localStorage.clear();
  api.materials.mockReset().mockResolvedValue([]);
  api.messages.mockReset().mockResolvedValue([]);
  api.aiStatus.mockReset().mockResolvedValue({ state: "ready" });
  api.books.mockReset().mockResolvedValue([]);
  api.uploadBookExplanations.mockReset();
  api.aiJob.mockReset().mockResolvedValue({
    id: 42,
    subject_id: 7,
    kind: "book-explanations",
    status: "processing",
    result: null,
    error: null,
  });
  api.cancelAIJob.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  document.body.replaceChildren();
  window.localStorage.clear();
});

describe("해설 분석 작업 복구", () => {
  it("새로고침·목록 복귀에 해당하는 재마운트 뒤에도 채팅 탭에서 작업을 계속 확인한다", async () => {
    window.localStorage.setItem("studywork:solution-job:7", "42");

    await renderDetail();
    expect(api.aiJob).toHaveBeenCalledWith(42);

    act(() => roots.shift()?.unmount());
    await renderDetail();
    expect(api.aiJob).toHaveBeenCalledTimes(2);
  });

  it("다른 브라우저 탭에서 저장된 작업 ID를 즉시 이어받는다", async () => {
    await renderDetail();
    expect(api.aiJob).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: "studywork:solution-job:7",
        newValue: "55",
      }));
      await Promise.resolve();
    });

    expect(api.aiJob).toHaveBeenCalledWith(55);
  });
});
