// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  materials: vi.fn(),
  messages: vi.fn(),
  aiStatus: vi.fn(),
  books: vi.fn(),
  uploadBookExplanations: vi.fn(),
  aiJob: vi.fn(),
  cancelAIJob: vi.fn(),
  missingExplanations: vi.fn(),
  generateExplanations: vi.fn(),
  subjectJobs: vi.fn(),
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
vi.mock("../web/src/JobTray", () => ({ default: () => null }));
vi.mock("../web/src/motion", () => ({
  Reveal: ({ children }: { children?: unknown }) => children,
}));

import { I18nProvider, type Locale } from "../web/src/i18n";
import SubjectDetail from "../web/src/pages/SubjectDetail";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const localValues = new Map<string, string>();
const sessionValues = new Map<string, string>();
Object.defineProperty(window, "localStorage", { configurable: true, value: {
  clear: () => localValues.clear(),
  getItem: (key: string) => localValues.get(key) ?? null,
  removeItem: (key: string) => localValues.delete(key),
  setItem: (key: string, value: string) => localValues.set(key, String(value)),
} });
Object.defineProperty(window, "sessionStorage", { configurable: true, value: {
  clear: () => sessionValues.clear(),
  getItem: (key: string) => sessionValues.get(key) ?? null,
  removeItem: (key: string) => sessionValues.delete(key),
  setItem: (key: string, value: string) => sessionValues.set(key, String(value)),
} });

const subject = { id: 7, name: "수학 원본", material_count: 0, created_at: "2026-07-24" };
let root: Root | null = null;

beforeEach(() => {
  api.materials.mockReset().mockResolvedValue([]);
  api.messages.mockReset().mockResolvedValue([]);
  api.aiStatus.mockReset().mockResolvedValue({ state: "ready", model: "gpt-5.6-sol" });
  api.books.mockReset().mockResolvedValue([]);
  api.aiJob.mockReset();
  api.cancelAIJob.mockReset();
  api.missingExplanations.mockReset().mockResolvedValue([]);
  api.generateExplanations.mockReset();
  api.subjectJobs.mockReset().mockResolvedValue([]);
  localValues.clear();
  sessionValues.clear();
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
});

async function renderDetail(locale: Locale, currentSubject = subject) {
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(
      I18nProvider,
      { initialLocale: locale },
      createElement(SubjectDetail, { subject: currentSubject, onBack: vi.fn() }),
    ));
    await Promise.resolve();
  });
  return container;
}

describe("workspace shell i18n", () => {
  it.each([
    ["ko", "문제", "과목 목록"],
    ["en", "Problems", "Subjects"],
    ["zh-CN", "题目", "科目列表"],
    ["es", "Problemas", "Asignaturas"],
  ] as const)("%s 탭 UI를 표시하되 과목 이름과 quiz route id는 유지한다", async (locale, problems, back) => {
    const view = await renderDetail(locale);
    const quizTab = view.querySelector("#subject-tab-quiz");
    expect(quizTab?.textContent).toContain(problems);
    expect(view.textContent).toContain(back);
    expect(view.textContent).toContain("수학 원본");
    expect(quizTab?.getAttribute("aria-controls")).toBe("subject-panel-quiz");
  });

  it("모바일은 자료 보유 시 학습 본문, 빈 과목은 자료 추가를 먼저 둔다", async () => {
    api.materials.mockResolvedValueOnce([{
      id: 11,
      subject_id: subject.id,
      kind: "pdf",
      title: "미적분 원본.pdf",
      status: "ready",
      progress: 100,
      created_at: "",
      book_status: "ready",
      book_progress: 100,
    }]);
    const returningView = await renderDetail("ko", { ...subject, material_count: 1 });
    expect(returningView.querySelector(".detail-grid")?.getAttribute("data-mobile-priority")).toBe("learning");

    act(() => root?.unmount());
    root = null;
    document.body.replaceChildren();
    api.materials.mockResolvedValueOnce([]);

    const emptyView = await renderDetail("ko", { ...subject, material_count: 0 });
    expect(emptyView.querySelector(".detail-grid")?.getAttribute("data-mobile-priority")).toBe("materials");

    const css = readFileSync("web/src/styles.css", "utf8");
    expect(css).toContain('.detail-grid[data-mobile-priority="learning"] .main-panel { order: 0; }');
    expect(css).toContain('.detail-grid[data-mobile-priority="learning"] .sidebar { order: 1; }');
  });
});
