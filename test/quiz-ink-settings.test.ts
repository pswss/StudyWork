// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../web/src/i18n";
import QuizInkWorkspace from "../web/src/pages/QuizScratchpad";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return Array.from(this.values.keys())[index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
}

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => { callback(0); return 1; },
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      observe() {}
      disconnect() {}
    },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

function render(child: ReturnType<typeof createElement>) {
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  act(() => root?.render(createElement(I18nProvider, { initialLocale: "ko", children: child })));
  return container;
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(item => item.textContent?.trim() === label);
  if (!found) throw new Error(`${label} button missing`);
  return found;
}

function workspace(questionId = 42) {
  return createElement(QuizInkWorkspace, {
    questionId,
    children: createElement("div", { className: "source-problem" },
      createElement("p", null, "지문과 문제"),
      createElement("img", { src: "/figure.png", alt: "문제 그림" }),
    ),
  });
}

describe("통합 문제 필기 워크스페이스", () => {
  it("iPad에서는 Pencil 필기를 바로 켜고 손가락 스크롤 설정을 기본으로 쓴다", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    });
    const container = render(workspace(3));
    const canvases = Array.from(container.querySelectorAll("canvas"));

    expect(container.querySelector(".quiz-ink-workspace")?.classList.contains("writing")).toBe(true);
    expect(canvases.every(canvas => canvas.classList.contains("pencil-only"))).toBe(true);
    expect(canvases.every(canvas => canvas.getAttribute("aria-hidden") === "false")).toBe(true);
  });

  it("활성 도구를 다시 누르면 해당 설정을 열고 Pencil 전용 값을 저장한다", () => {
    const container = render(workspace());
    const highlighter = button(container, "형광펜");

    act(() => highlighter.click());
    expect(container.querySelector(".quiz-ink-settings-panel")).toBeNull();
    act(() => highlighter.click());

    const panel = container.querySelector<HTMLElement>(".quiz-ink-settings-panel");
    expect(panel?.getAttribute("aria-label")).toBe("형광펜 세부 설정");
    const width = panel?.querySelector<HTMLInputElement>('input[type="range"]');
    expect([width?.min, width?.max, width?.value]).toEqual(["6", "32", "16"]);

    const pencilOnly = Array.from(panel?.querySelectorAll<HTMLLabelElement>(".quiz-ink-toggle") ?? [])
      .find(label => label.textContent?.includes("Pencil만 쓰기"))
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(pencilOnly).toBeTruthy();
    expect(pencilOnly?.checked).toBe(true);
    act(() => pencilOnly?.click());
    expect(JSON.parse(window.localStorage.getItem("studywork:ink-preferences") ?? "{}").pencilOnly).toBe(false);
    expect(button(container, "다시 실행").disabled).toBe(true);
  });

  it("한 도구막대가 문제와 풀이 캔버스를 함께 필기·스크롤 전환한다", () => {
    const container = render(workspace(7));
    const canvases = Array.from(container.querySelectorAll("canvas"));
    expect(container.querySelectorAll('[role="toolbar"]')).toHaveLength(1);
    expect(canvases).toHaveLength(2);
    expect(canvases.every(canvas => canvas.getAttribute("aria-hidden") === "true")).toBe(true);

    act(() => button(container, "필기").click());
    expect(canvases.every(canvas => canvas.getAttribute("aria-hidden") === "false")).toBe(true);
    expect(container.querySelector(".quiz-ink-workspace")?.classList.contains("writing")).toBe(true);

    act(() => button(container, "스크롤").click());
    expect(canvases.every(canvas => canvas.getAttribute("aria-hidden") === "true")).toBe(true);
  });

  it("전체 화면에서도 문제와 문제 그림과 풀이 공간을 한 워크스페이스로 유지한다", () => {
    const container = render(workspace(9));

    act(() => button(container, "전체 화면").click());
    const fullscreen = document.body.querySelector<HTMLElement>(".quiz-ink-workspace.is-fullscreen");
    expect(fullscreen?.getAttribute("role")).toBe("dialog");
    expect(fullscreen?.querySelector(".source-problem")?.textContent).toContain("지문과 문제");
    expect(fullscreen?.querySelector('img[alt="문제 그림"]')).toBeTruthy();
    expect(fullscreen?.querySelector(".quiz-ink-solution")).toBeTruthy();
    expect(document.body.classList.contains("quiz-ink-fullscreen-open")).toBe(true);

    act(() => button(document.body, "전체 화면 닫기").click());
    expect(container.querySelector(".quiz-ink-workspace")?.classList.contains("is-fullscreen")).toBe(false);
    expect(document.body.classList.contains("quiz-ink-fullscreen-open")).toBe(false);
  });
});
