// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../web/src/api";

const api = vi.hoisted(() => ({
  chat: vi.fn(),
  cancelChat: vi.fn(),
  messages: vi.fn(),
}));

vi.mock("../web/src/api", () => api);
vi.mock("../web/src/md", () => ({ Md: ({ text }: { text: string }) => text }));
vi.mock("../web/src/Pending", () => ({ AiPending: ({ label }: { label: string }) => label }));
vi.mock("../web/src/pages/SourcePicker", () => ({ default: () => null }));

import ChatPanel from "../web/src/pages/ChatPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const storedValues = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    clear: () => storedValues.clear(),
    getItem: (key: string) => storedValues.get(key) ?? null,
    removeItem: (key: string) => storedValues.delete(key),
    setItem: (key: string, value: string) => storedValues.set(key, String(value)),
  },
});

const subject = { id: 1, name: "수학", material_count: 0, created_at: "2026-07-23" };
const oldMessage: Message = {
  id: 1,
  role: "assistant",
  content: "기존 답변",
  mode: "general",
  created_at: "2026-07-23T00:00:00Z",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let setMessages: ((update: (current: Message[]) => Message[]) => void) | null = null;

function Harness({ active }: { active: boolean }) {
  const [msgs, setMsgs] = useState<Message[]>([oldMessage]);
  setMessages = setMsgs;
  return createElement(ChatPanel, {
    subject,
    msgs,
    setMsgs,
    readyMats: [],
    aiRuntime: null,
    active,
  });
}

async function render(active: boolean) {
  if (!container) {
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
  }
  await act(async () => {
    root?.render(createElement(Harness, { active }));
    await Promise.resolve();
  });
  return container;
}

beforeEach(() => {
  api.chat.mockReset().mockReturnValue(new Promise(() => {}));
  api.cancelChat.mockReset();
  api.messages.mockReset();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  window.localStorage.clear();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  setMessages = null;
  window.localStorage.clear();
});

describe("채팅 모션과 스크롤", () => {
  it("탭 복귀에는 움직이지 않고 하단에서 추가된 항목만 내부 로그로 이동한다", async () => {
    const view = await render(true);
    const log = view.querySelector(".chat-log") as HTMLDivElement;
    const scrollTo = vi.fn();
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, writable: true, value: 600 },
      scrollTo: { configurable: true, value: scrollTo },
    });

    await render(false);
    await render(true);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(view.querySelector(".chat-msg")?.classList.contains("entering")).toBe(false);

    await act(async () => {
      setMessages?.(current => [...current, { ...oldMessage, id: 2, content: "새 답변" }]);
      await Promise.resolve();
    });
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });

    log.scrollTop = 0;
    log.dispatchEvent(new Event("scroll", { bubbles: true }));
    await act(async () => {
      setMessages?.(current => [...current, { ...oldMessage, id: 3, content: "스크롤 중 새 답변" }]);
      await Promise.resolve();
    });
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("보내서 새로 추가한 메시지에만 등장 상태를 붙인다", async () => {
    const view = await render(true);
    const input = view.querySelector(".chat-textarea") as HTMLTextAreaElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;

    await act(async () => {
      setValue?.call(input, "새 질문");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      (view.querySelector(".send-btn") as HTMLButtonElement).click();
      await Promise.resolve();
    });

    const messages = view.querySelectorAll(".chat-msg");
    expect(messages[0].classList.contains("entering")).toBe(false);
    expect(messages[1].classList.contains("entering")).toBe(true);
  });
});
