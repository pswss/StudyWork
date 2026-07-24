// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

let storedSolutionJob: (subjectId: number) => number | null;
let uploadValidationError: (file: Pick<File, "name" | "type" | "size">) => string | null;

beforeAll(async () => {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, String(value)),
  } });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  ({ storedSolutionJob, uploadValidationError } = await import("../web/src/pages/SubjectDetail"));
});

afterEach(() => {
  window.localStorage.clear();
  sessionStorage.clear();
});

describe("해설 탭 브라우저 경계", () => {
  it("과목별 진행 작업만 복구한다", () => {
    window.localStorage.setItem("studywork:solution-job:7", "42");
    window.localStorage.setItem("studywork:solution-job:8", "invalid");
    sessionStorage.setItem("studywork:solution-job:9", "99");

    expect(storedSolutionJob(7)).toBe(42);
    expect(storedSolutionJob(8)).toBeNull();
    expect(storedSolutionJob(9)).toBeNull();
  });

  it("서버 전송 전에 파일 형식·크기를 거른다", () => {
    expect(uploadValidationError({ name: "해설.pdf", type: "application/pdf", size: 200 * 1024 * 1024 })).toBeNull();
    expect(uploadValidationError({ name: "해설.pdf", type: "application/pdf", size: 200 * 1024 * 1024 + 1 })).toBe(
      "200 MB 이하 파일만 지원합니다"
    );
    expect(uploadValidationError({ name: "해설.png", type: "image/png", size: 30 * 1024 * 1024 + 1 })).toBe(
      "30 MB 이하 파일만 지원합니다"
    );
    expect(uploadValidationError({ name: "해설.txt", type: "text/plain", size: 10 })).toBe(
      "PDF, JPEG, PNG, WebP, GIF만 지원합니다"
    );
  });

  it("해설 탭·파일 입력 접근성 계약을 유지한다", () => {
    const detail = readFileSync("web/src/pages/SubjectDetail.tsx", "utf8");
    const pending = readFileSync("web/src/Pending.tsx", "utf8");
    const css = readFileSync("web/src/styles.css", "utf8");

    expect(detail).toContain('aria-controls={`subject-panel-${t}`}');
    expect(detail).toContain('id="subject-panel-solution"');
    expect(detail).toContain('role="tabpanel"');
    expect(css).not.toMatch(/\.file-label input\s*\{\s*display:\s*none/);
    expect(css).toMatch(/\.file-label:has\(input:focus-visible\)/);
    expect(pending).toContain('className="ai-pending-sec" aria-hidden="true"');
  });

  it("다섯 학습 탭의 roving 포커스와 독립 설정 유틸리티를 분리한다", () => {
    const detail = readFileSync("web/src/pages/SubjectDetail.tsx", "utf8");

    expect(detail).toContain(
      'const LEARNING_TAB_ORDER: LearningTab[] = ["chat", "quiz", "solution", "exam", "note"]'
    );
    expect(detail).toContain("LEARNING_TAB_ORDER.indexOf(rovingLearningTab)");
    expect(detail).toContain("selectTab(LEARNING_TAB_ORDER[next], \"instant\")");
    expect(detail).toContain("tabIndex={rovingLearningTab === t ? 0 : -1}");
    expect(detail).toContain('id="subject-settings-control"');
    expect(detail).toContain('aria-controls="subject-panel-settings"');
    expect(detail).toContain('aria-pressed={tab === "settings"}');
    expect(detail).toContain('aria-labelledby="subject-settings-control"');
    expect(detail).not.toContain('id="subject-tab-settings"');
  });

  it("자료가 하나뿐이어도 단권화 소스 선택을 다시 열 수 있다", () => {
    const notes = readFileSync("web/src/pages/NotesPanel.tsx", "utf8");

    expect(notes.match(/\{srcCount > 0 && \(/g)).toHaveLength(2);
    expect(notes).not.toContain("{srcCount > 1 && (");
    expect(notes).toContain("editorRef.current?.focus()");
    expect(notes).toContain("editButtonRef.current?.focus()");
  });

  it("자료 선택을 유지하고 색 외의 체크 피드백을 제공한다", () => {
    const quiz = readFileSync("web/src/pages/Quiz.tsx", "utf8");
    const picker = readFileSync("web/src/pages/SourcePicker.tsx", "utf8");
    const css = readFileSync("web/src/styles.css", "utf8");

    expect(quiz).toContain("const [genExcluded, setGenExcluded]");
    expect(quiz).not.toContain("readyMaterialKey");
    expect(picker).toContain('aria-live="polite"');
    expect(css).toContain('.note-source-row:has(input:checked)::before { content: "✓"');
    expect(css).toContain("html { color-scheme: dark;");
  });
});
