// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

let storedSolutionJob: (subjectId: number) => number | null;
let uploadValidationError: (file: Pick<File, "name" | "type" | "size">) => string | null;

beforeAll(async () => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  ({ storedSolutionJob, uploadValidationError } = await import("../web/src/pages/SubjectDetail"));
});

afterEach(() => sessionStorage.clear());

describe("해설 탭 브라우저 경계", () => {
  it("과목별 진행 작업만 복구한다", () => {
    sessionStorage.setItem("studywork:solution-job:7", "42");
    sessionStorage.setItem("studywork:solution-job:8", "invalid");

    expect(storedSolutionJob(7)).toBe(42);
    expect(storedSolutionJob(8)).toBeNull();
    expect(storedSolutionJob(9)).toBeNull();
  });

  it("서버 전송 전에 파일 형식·크기를 거른다", () => {
    expect(uploadValidationError({ name: "해설.pdf", type: "application/pdf", size: 200 * 1024 * 1024 })).toBeNull();
    expect(uploadValidationError({ name: "해설.pdf", type: "application/pdf", size: 200 * 1024 * 1024 + 1 })).toBe(
      "200MB 이하 파일만 지원합니다"
    );
    expect(uploadValidationError({ name: "해설.png", type: "image/png", size: 30 * 1024 * 1024 + 1 })).toBe(
      "30MB 이하 파일만 지원합니다"
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

  it("자료가 하나뿐이어도 단권화 소스 선택을 다시 열 수 있다", () => {
    const detail = readFileSync("web/src/pages/SubjectDetail.tsx", "utf8");

    expect(detail.match(/\{srcCount > 0 && \(/g)).toHaveLength(2);
    expect(detail).not.toContain("{srcCount > 1 && (");
  });
});
