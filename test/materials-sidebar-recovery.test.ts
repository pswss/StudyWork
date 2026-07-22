// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Material, Subject } from "../web/src/api";

const api = vi.hoisted(() => ({
  uploadMaterial: vi.fn(),
  retryMaterial: vi.fn(),
  cancelMaterial: vi.fn(),
  deleteMaterial: vi.fn(),
  retryBookFile: vi.fn(),
  cancelBookFile: vi.fn(),
}));

vi.mock("../web/src/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../web/src/api")>(),
  ...api,
}));

import MaterialsSidebar from "../web/src/pages/MaterialsSidebar";
import { UndoDeleteProvider } from "../web/src/UndoDelete";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const subject = { id: 7, name: "영어", material_count: 1, created_at: "" } as Subject;
const material = {
  id: 11,
  subject_id: subject.id,
  kind: "pdf",
  title: "문법 노트",
  status: "error",
  progress: 0,
  created_at: "",
  book_status: null,
  book_progress: null,
} as Material;

let root: Root | null = null;

async function renderSidebar(mats: Material[] = []) {
  const container = document.body.appendChild(document.createElement("div"));
  const reloadMats = vi.fn().mockResolvedValue(undefined);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(
      UndoDeleteProvider,
      null,
      createElement(MaterialsSidebar, { subject, mats, reloadMats }),
    ));
  });
  return { container, reloadMats };
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "alert", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("MaterialsSidebar inline recovery", () => {
  it("여러 파일 실패를 파일명별로 보여 주고 다시 선택을 안내한다", async () => {
    api.uploadMaterial.mockRejectedValueOnce(new Error("서버 연결 끊김"));
    const { container } = await renderSidebar();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [
        new File(["text"], "지원안됨.txt", { type: "text/plain" }),
        new File(["image"], "업로드실패.png", { type: "image/png" }),
      ],
    });

    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    const error = container.querySelector('[role="alert"]')?.textContent ?? "";
    expect(error).toContain("지원안됨.txt");
    expect(error).toContain("업로드실패.png");
    expect(error).toContain("다시 선택");
    expect(window.alert).not.toHaveBeenCalled();
  });

  it("텍스트 저장 실패 뒤 제목과 내용을 보존한다", async () => {
    api.uploadMaterial.mockRejectedValueOnce(new Error("저장소 응답 없음"));
    const { container } = await renderSidebar();
    await click(Array.from(container.querySelectorAll("button")).find(button => button.textContent === "텍스트 추가")!);
    const title = container.querySelector('input[aria-label="텍스트 자료 제목"]') as HTMLInputElement;
    const body = container.querySelector('textarea[aria-label="텍스트 자료 내용"]') as HTMLTextAreaElement;
    act(() => {
      setValue(title, "시제 요약");
      setValue(body, "현재완료와 과거시제 비교");
    });

    await click(Array.from(container.querySelectorAll("button")).find(button => button.textContent === "저장")!);

    expect(title.value).toBe("시제 요약");
    expect(body.value).toBe("현재완료와 과거시제 비교");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("제목과 내용은 그대로 유지했습니다");
    expect(window.alert).not.toHaveBeenCalled();
  });

  it("재시도·중단·삭제 실패에 작업 맥락과 재실행을 제공하고 매번 목록을 갱신한다", async () => {
    api.retryMaterial.mockRejectedValueOnce(new Error("재시도 실패")).mockResolvedValueOnce({ id: 11, status: "processing" });
    api.cancelMaterial.mockRejectedValueOnce(new Error("중단 실패")).mockResolvedValueOnce(undefined);
    api.deleteMaterial.mockRejectedValueOnce(new Error("삭제 실패")).mockResolvedValueOnce(undefined);
    const { container, reloadMats } = await renderSidebar([material]);
    const retryRecovery = () => Array.from(container.querySelectorAll("button"))
      .find(button => button.textContent === "다시 시도")!;

    await click(Array.from(container.querySelectorAll("button")).find(button => button.textContent === "재시도")!);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("문법 노트” 자료 분석 재시도 실패");
    await click(retryRecovery());
    expect(api.retryMaterial).toHaveBeenCalledTimes(2);

    await act(async () => {
      root?.render(createElement(
        UndoDeleteProvider,
        null,
        createElement(MaterialsSidebar, {
          subject,
          mats: [{ ...material, status: "processing" }],
          reloadMats,
        }),
      ));
    });
    await click(Array.from(container.querySelectorAll("button")).find(button => button.textContent === "중단")!);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("문법 노트” 자료 분석 중단 실패");
    await click(retryRecovery());
    expect(api.cancelMaterial).toHaveBeenCalledTimes(2);

    vi.spyOn(window, "prompt").mockReturnValue("삭제");
    vi.useFakeTimers();
    act(() => (container.querySelector(".del-btn") as HTMLButtonElement).click());
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    vi.useRealTimers();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("문법 노트” 자료 · 삭제 실패");
    await click(retryRecovery());
    expect(api.deleteMaterial).toHaveBeenCalledTimes(2);
    expect(reloadMats).toHaveBeenCalledTimes(6);
    expect(window.alert).not.toHaveBeenCalled();
  });
});
