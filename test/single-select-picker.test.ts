// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SingleSelectPicker from "../web/src/pages/SingleSelectPicker";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => { callback(0); return 1; },
  });
  scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

function renderPicker(
  value: string,
  onChange = vi.fn(),
  options = [
    { value: "1", label: "1문제" },
    { value: "2", label: "2문제" },
    { value: "20", label: "20문제" },
  ],
) {
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  act(() => root?.render(createElement(SingleSelectPicker, {
    label: "문항 수",
    value,
    options,
    onChange,
  })));
  return { container, onChange };
}

describe("SingleSelectPicker", () => {
  it("잘못된 값에서도 첫 옵션을 탭 대상으로 두고 숫자 typeahead로 이동한다", async () => {
    const { container } = renderPicker("missing");
    const summary = container.querySelector("summary") as HTMLElement;
    const options = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'));

    expect(summary.getAttribute("aria-haspopup")).toBe("listbox");
    expect(options.map(option => option.tabIndex)).toEqual([0, -1, -1]);

    await act(async () => {
      summary.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(scrollIntoView).toHaveBeenCalled();
    options[0].focus();
    act(() => options[0].dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(options[1]);
    act(() => options[1].dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(options[2]);
  });

  it("선택과 Escape 모두 패널을 닫고 요약으로 포커스를 돌린다", () => {
    const onChange = vi.fn();
    const { container } = renderPicker("2", onChange);
    const details = container.querySelector("details") as HTMLDetailsElement;
    const summary = container.querySelector("summary") as HTMLElement;
    const options = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'));

    act(() => summary.click());
    act(() => options[2].click());
    expect(onChange).toHaveBeenCalledWith("20");
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(summary);

    act(() => summary.click());
    act(() => details.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(summary);
  });

  it("문자 typeahead와 바깥 클릭 닫기를 지원한다", () => {
    const { container } = renderPicker("all", vi.fn(), [
      { value: "all", label: "All" },
      { value: "book", label: "Book" },
      { value: "chat", label: "Chat" },
    ]);
    const details = container.querySelector("details") as HTMLDetailsElement;
    const summary = container.querySelector("summary") as HTMLElement;
    const options = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'));

    act(() => summary.click());
    options[0].focus();
    act(() => options[0].dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(options[1]);

    act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(details.open).toBe(false);
  });
});
