// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UndoDeleteProvider, useUndoDelete } from "../web/src/UndoDelete";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

function Harness({ commit }: { commit: () => Promise<void> }) {
  const { schedule } = useUndoDelete();
  return createElement("button", {
    type: "button",
    onClick: () => schedule({ key: "question:1", label: "문제 삭제", commit }),
  }, "삭제");
}

describe("undo delete manager", () => {
  it("삭제 전에는 취소하고, 실행 실패 뒤에는 같은 작업을 재시도한다", async () => {
    vi.useFakeTimers();
    const commit = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("네트워크 오류"))
      .mockResolvedValueOnce();
    const container = document.body.appendChild(document.createElement("div"));
    container.id = "main-content";
    container.tabIndex = -1;
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(UndoDeleteProvider, null, createElement(Harness, { commit })));
    });

    const schedule = container.querySelector("button") as HTMLButtonElement;
    act(() => schedule.click());
    act(() => vi.advanceTimersByTime(4999));
    expect(commit).not.toHaveBeenCalled();

    const undo = document.querySelector(".undo-delete-bar button") as HTMLButtonElement;
    expect(document.activeElement).toBe(undo);
    act(() => undo.click());
    act(() => vi.advanceTimersByTime(1));
    expect(commit).not.toHaveBeenCalled();

    act(() => schedule.click());
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".undo-delete-bar.failed")?.textContent).toContain("네트워크 오류");

    const retry = document.querySelector(".undo-delete-bar button") as HTMLButtonElement;
    await act(async () => {
      retry.click();
      await Promise.resolve();
    });
    expect(commit).toHaveBeenCalledTimes(2);
    expect(document.querySelector(".undo-delete-bar")).toBeNull();
    expect(document.activeElement).toBe(container);
  });
});
