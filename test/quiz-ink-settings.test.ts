// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../web/src/i18n";
import QuizScratchpad, { QuizQuestionAnnotation } from "../web/src/pages/QuizScratchpad";

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
    value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
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

describe("iPad 필기 세부 설정", () => {
  it("활성 도구를 다시 누르면 해당 설정을 열고 Pencil 전용 값을 저장한다", () => {
    const container = render(createElement(QuizScratchpad, { questionId: 42 }));
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
    act(() => pencilOnly?.click());
    expect(JSON.parse(window.localStorage.getItem("studywork:ink-preferences") ?? "{}").pencilOnly).toBe(true);
    expect(button(container, "다시 실행").disabled).toBe(true);
  });

  it("문제 필기 모드가 캔버스 입력 상태를 명시적으로 전환한다", () => {
    const container = render(createElement(QuizQuestionAnnotation, {
      questionId: 7,
      children: createElement("p", null, "지문과 도형"),
    }));
    const canvas = container.querySelector("canvas");
    expect(canvas?.getAttribute("aria-hidden")).toBe("true");

    act(() => button(container, "문제에 필기").click());
    expect(canvas?.getAttribute("aria-hidden")).toBe("false");
    expect(container.querySelector(".quiz-annotation")?.classList.contains("active")).toBe(true);
  });
});
