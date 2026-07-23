// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Material } from "../web/src/api";
import SourcePicker from "../web/src/pages/SourcePicker";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("SourcePicker", () => {
  it("검색 범위와 선택 상태를 알리고 닫을 때 검색 상태를 복구한다", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    });
    const container = document.body.appendChild(document.createElement("div"));
    const onSetVisible = vi.fn();
    const materials = [
      { id: 1, title: "영어 문법", original_filename: "english.pdf", kind: "pdf" },
      { id: 2, title: "한국사", original_filename: "history.pdf", kind: "pdf" },
    ] as Material[];

    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(SourcePicker, {
        label: "참고 자료",
        materials,
        excluded: new Set([2]),
        onToggle: vi.fn(),
        onSetVisible,
      }));
    });

    const details = container.querySelector("details") as HTMLDetailsElement;
    const summary = container.querySelector("summary") as HTMLElement;
    const search = container.querySelector('input[type="search"]') as HTMLInputElement;
    const bulk = container.querySelector(".note-source-all input") as HTMLInputElement;
    const status = container.querySelector(".note-source-all small") as HTMLElement;
    const setInputValue = (value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, value);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    };
    // 포인터로 열 때만 검색창 자동 포커스 — pointerdown으로 포인터 열림을 표시
    const clickSummary = async () => {
      await act(async () => {
        summary.dispatchEvent(new Event("pointerdown", { bubbles: true }));
        summary.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };

    expect(container.querySelector(".note-source-all strong")?.textContent).toBe("전체 자료");
    await clickSummary();
    expect(document.activeElement).toBe(search);
    act(() => setInputValue("영어"));

    expect(container.querySelector(".note-source-all strong")?.textContent).toBe("검색 결과 전체");
    expect(bulk.getAttribute("aria-label")).toBe("참고 자료 전체 해제 (검색 결과)");
    // 패널 카운트의 aria-live는 제거(요약 카운트만 알림) — 중복 알림 방지
    expect(status.getAttribute("aria-live")).toBe(null);
    expect(status.textContent).toContain("1개 검색됨 · 1개 선택");

    act(() => bulk.click());
    expect(onSetVisible).toHaveBeenLastCalledWith([1], false);

    await clickSummary();
    expect(details.open).toBe(false);
    expect(search.value).toBe("");

    await clickSummary();
    act(() => {
      setInputValue("영어");
      search.focus();
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });

    expect(details.open).toBe(false);
    expect(search.value).toBe("");
    expect(document.activeElement).toBe(summary);

    await clickSummary();
    act(() => {
      setInputValue("한국사");
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(details.open).toBe(false);
    expect(search.value).toBe("");
  });
});
