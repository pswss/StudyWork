// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Material, Subject } from "../web/src/api";

const api = vi.hoisted(() => ({
  uploadMaterial: vi.fn(),
  retryMaterial: vi.fn(),
  deleteMaterial: vi.fn(),
  cancelMaterial: vi.fn(),
  retryBookFile: vi.fn(),
  cancelBookFile: vi.fn(),
  consolidate: vi.fn(),
  cancelConsolidate: vi.fn(),
  note: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
  deleteNoteVersion: vi.fn(),
  noteVersions: vi.fn(),
  noteVersion: vi.fn(),
  exams: vi.fn(),
  createExam: vi.fn(),
  aiJob: vi.fn(),
  togglePlanItem: vi.fn(),
  replanExam: vi.fn(),
  deleteExam: vi.fn(),
}));

vi.mock("../web/src/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../web/src/api")>(),
  ...api,
}));

import { I18nProvider, translate, type Locale } from "../web/src/i18n";
import { UndoDeleteProvider } from "../web/src/UndoDelete";
import MaterialsSidebar, { uploadValidationError } from "../web/src/pages/MaterialsSidebar";
import NotesPanel from "../web/src/pages/NotesPanel";
import Exam from "../web/src/pages/Exam";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const subject = {
  id: 7,
  name: "수학 원본 과목",
  material_count: 1,
  created_at: "2026-07-24T00:00:00Z",
} as Subject;

let root: Root | null = null;

async function render(locale: Locale, child: ReactNode) {
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(
      I18nProvider,
      { initialLocale: locale },
      createElement(UndoDeleteProvider, null, child),
    ));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  return container;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  sessionStorage.clear();
});

describe("learning UI i18n", () => {
  it("자료 UI만 영어로 바꾸고 자료 제목과 원본 파일명은 보존한다", async () => {
    const material = {
      id: 11,
      subject_id: subject.id,
      kind: "pdf",
      title: "미적분 원문 자료",
      original_filename: "교재 원본 01.pdf",
      status: "ready",
      progress: 100,
      created_at: "",
      book_status: null,
      book_progress: null,
    } as Material;
    const container = await render("en", createElement(MaterialsSidebar, {
      subject,
      mats: [material],
      reloadMats: vi.fn().mockResolvedValue(undefined),
    }));

    expect(container.textContent).toContain("Materials");
    expect(container.textContent).toContain("Add text");
    expect(container.textContent).toContain(material.title);
    expect(container.querySelector(".mat-title")?.getAttribute("title")).toBe(material.original_filename);
    expect(uploadValidationError(
      { name: "원본.txt", type: "text/plain", size: 10 },
      (key, values) => translate("en", key, values),
    )).toContain("Only PDF");
  });

  it("노트 UI만 영어로 바꾸고 저장된 노트 본문은 그대로 렌더링한다", async () => {
    api.note.mockResolvedValue({
      content: "정적분 원문 노트 — 번역 금지",
      updated_at: "2026-07-24T03:04:00Z",
      status: "ready",
      progress: 100,
    });
    api.noteVersions.mockResolvedValue([]);
    const container = await render("en", createElement(NotesPanel, {
      subject,
      readyMats: [],
      active: true,
      onBack: vi.fn(),
    }));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("Updated:");
    expect(container.textContent).toContain("Save HTML");
    expect(container.textContent).toContain("정적분 원문 노트 — 번역 금지");
  });

  it("시험 UI와 날짜만 영어화하고 제목·범위·계획 항목은 보존한다", async () => {
    api.exams.mockResolvedValue([{
      id: 9,
      subject_id: subject.id,
      title: "기말고사 원문",
      exam_date: "2099-07-30",
      scope: "1~3단원 원문 범위",
      created_at: "2026-07-24T00:00:00Z",
      done_count: 0,
      items: [{ id: 91, exam_id: 9, day: "2099-07-20", task: "1단원 원문 복습", done: 0 }],
    }]);
    const container = await render("en", createElement(Exam, { subject }));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
      (container.querySelector(".exam-card-header") as HTMLButtonElement).click();
    });

    expect(container.textContent).toContain("Add exam");
    expect(container.textContent).toContain("Adjust plan");
    expect(container.textContent).toContain("July");
    expect(container.textContent).toContain("기말고사 원문");
    expect(container.textContent).toContain("1~3단원 원문 범위");
    expect(container.textContent).toContain("1단원 원문 복습");
  });

  it("중국어와 스페인어 학습 UI 사전을 제공한다", () => {
    expect(translate("zh-CN", "learning.materials.heading")).toBe("资料");
    expect(translate("zh-CN", "learning.notes.run")).toBe("执行整合");
    expect(translate("es", "learning.exam.add")).toBe("Añadir examen");
    expect(translate("es", "learning.common.delete")).toBe("Eliminar");
  });
});
