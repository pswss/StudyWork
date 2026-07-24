// @vitest-environment jsdom

import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AISettings, Material, Message, Subject } from "../web/src/api";

const api = vi.hoisted(() => ({
  aiSettings: vi.fn(),
  updateAISettings: vi.fn(),
  chat: vi.fn(),
  cancelChat: vi.fn(),
  messages: vi.fn(),
}));

vi.mock("../web/src/api", () => api);
vi.mock("../web/src/md", () => ({ Md: ({ text }: { text: string }) => text }));
vi.mock("../web/src/Pending", () => ({ AiPending: ({ label }: { label: string }) => label }));

import { I18nProvider, type Locale } from "../web/src/i18n";
import AISettingsPanel from "../web/src/pages/AISettingsPanel";
import ChatPanel from "../web/src/pages/ChatPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const storage = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    clear: () => storage.clear(),
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => storage.delete(key),
    setItem: (key: string, value: string) => storage.set(key, String(value)),
  },
});

const subject: Subject = {
  id: 1,
  name: "수학 원본",
  material_count: 1,
  created_at: "2026-07-24",
};
const material = {
  id: 11,
  subject_id: 1,
  title: "미적분 원본.pdf",
  original_filename: "교재 원본.pdf",
  kind: "pdf",
  status: "ready",
} as Material;
const message: Message = {
  id: 21,
  role: "assistant",
  content: "원문 해설: 极限은 그대로",
  mode: "materials",
  created_at: "2026-07-24T00:00:00Z",
};
const setting = { model: "gpt-5.6-sol", reasoningEffort: "high" as const };
const settings = {
  appliesTo: "codex-cli",
  default: setting,
  overrides: {},
  resolved: { chat: setting },
  operations: ["chat"],
  allowedModels: [setting.model],
  allowedEfforts: [setting.reasoningEffort],
} as AISettings;

let root: Root | null = null;

beforeEach(() => {
  api.aiSettings.mockReset().mockResolvedValue(settings);
  api.updateAISettings.mockReset().mockResolvedValue(settings);
  api.chat.mockReset();
  api.cancelChat.mockReset();
  api.messages.mockReset().mockResolvedValue([message]);
  window.localStorage.clear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  window.localStorage.clear();
});

async function renderWorkspace(locale: Locale) {
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(
      I18nProvider,
      { initialLocale: locale },
      createElement(Fragment, null,
        createElement(ChatPanel, {
          subject,
          msgs: [message],
          setMsgs: vi.fn(),
          readyMats: [material],
          aiRuntime: {
            provider: "codex-cli",
            model: setting.model,
            reasoningMode: null,
            reasoningEffort: setting.reasoningEffort,
            state: "ready",
          },
          active: false,
        }),
        createElement(AISettingsPanel),
      ),
    ));
    await Promise.resolve();
  });
  return container;
}

describe("workspace UI i18n", () => {
  it.each([
    ["ko", "자료 기반", "AI 실행 설정"],
    ["en", "Materials", "AI runtime settings"],
    ["zh-CN", "基于资料", "AI 运行设置"],
    ["es", "Basado en materiales", "Ajustes de ejecución de IA"],
  ] as const)("%s UI를 표시하고 학습 자료·메시지는 번역하지 않는다", async (locale, mode, heading) => {
    const view = await renderWorkspace(locale);
    expect(view.textContent).toContain(mode);
    expect(view.textContent).toContain(heading);
    expect(view.textContent).toContain("미적분 원본");
    expect(view.textContent).toContain("교재 원본.pdf");
    expect(view.textContent).toContain("원문 해설: 极限은 그대로");
    expect(view.textContent).toContain("GPT-5.6 sol");
    expect(view.textContent).toContain("effort high");
  });
});
