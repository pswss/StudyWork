// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";


import App from "../web/src/App";
import { UndoDeleteProvider } from "../web/src/UndoDelete";
import type { Subject } from "../web/src/api";
import {
  I18nProvider,
  LOCALES,
  LOCALE_STORAGE_KEY,
  formatDate,
  formatNumber,
  messages,
  resolveLocale,
  translate,
  useI18n,
} from "../web/src/i18n";
import Subjects from "../web/src/pages/Subjects";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
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

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  document.documentElement.lang = "ko";
  document.title = "";
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

function TextHarness({ switchTo }: { switchTo?: "zh-CN" }) {
  const { locale, setLocale, t } = useI18n();
  return createElement(
    "button",
    { type: "button", onClick: () => switchTo && setLocale(switchTo) },
    `${locale}:${t("shell.subjects.title")}`,
  );
}

describe("UI i18n", () => {
  it("모든 사전이 한국어 키와 정확히 같은 키를 가진다", () => {
    const koKeys = Object.keys(messages.ko).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(messages[locale]).sort()).toEqual(koKeys);
    }
  });

  it("저장값, 브라우저 선호, 한국어 순으로 locale을 고른다", () => {
    expect(resolveLocale("en", ["es-ES"])).toBe("en");
    expect(resolveLocale("unknown", ["zh-Hans-CN", "es-ES"])).toBe("zh-CN");
    expect(resolveLocale(null, ["fr-FR"])).toBe("ko");
  });

  it("날짜와 숫자를 선택한 locale의 Intl 규칙으로 표시한다", () => {
    expect(formatNumber("en", 1234.5)).toBe("1,234.5");
    expect(formatDate("en", "2026-07-24T00:00:00Z", {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    })).toBe("Jul 24, 2026");
  });

  it("보간하고, Provider가 locale과 html lang을 저장·동기화한다", async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "es");
    const container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(I18nProvider, null, createElement(TextHarness, { switchTo: "zh-CN" })));
    });
    expect(container.textContent).toBe("es:Asignaturas");
    expect(document.documentElement.lang).toBe("es");
    expect(translate("en", "shell.subjects.openAria", { name: "수학" })).toBe("Open 수학");

    await act(async () => {
      (container.querySelector("button") as HTMLButtonElement).click();
    });
    expect(container.textContent).toBe("zh-CN:科目");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("zh-CN");
  });

  it("Provider 밖의 기본 UI는 한국어로 렌더링한다", () => {
    const container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    act(() => root?.render(createElement(TextHarness)));
    expect(container.textContent).toBe("ko:과목");
  });

  it("영어 UI에서도 사용자 과목 이름은 번역하지 않는다", () => {
    const container = document.body.appendChild(document.createElement("div"));
    const subject = {
      id: 7,
      name: "수학 원본",
      material_count: 2,
      created_at: "2026-07-24T00:00:00Z",
    } satisfies Subject;
    root = createRoot(container);
    act(() => root?.render(
      createElement(I18nProvider, { initialLocale: "en" },
        createElement(UndoDeleteProvider, null,
          createElement(Subjects, {
            list: [subject],
            onOpen: vi.fn(),
            onRefresh: vi.fn(),
          })
        )
      )
    ));
    expect(container.textContent).toContain("Subjects");
    expect(container.textContent).toContain("수학 원본");
  });

  it("locale 변경에 맞춰 로그인 문서 제목을 바꾼다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ownerExists: false,
      authenticated: false,
      authKind: null,
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(I18nProvider, { initialLocale: "en" }, createElement(App)));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(document.documentElement.lang).toBe("en");
    expect(document.title).toBe("Sign in — Remap");
    expect(container.textContent).toContain("Create account");
    expect(container.textContent).toContain("简体中文");
    expect(container.querySelector(".single-select-picker input[type='search']")).toBeNull();
  });

  it("로그인 뒤에도 nav에서 언어를 바꿀 수 있고 사용자 이름은 원문을 유지한다", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/auth/status") {
        return new Response(JSON.stringify({
          ownerExists: true,
          authenticated: true,
          authKind: "owner",
          username: "원본사용자",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }));
    const container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(I18nProvider, { initialLocale: "es" }, createElement(App)));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    const nav = container.querySelector("nav");
    expect(nav?.querySelector(".single-select-picker")).not.toBeNull();
    expect(nav?.textContent).toContain("Español");
    expect(nav?.textContent).toContain("원본사용자");
  });
});
