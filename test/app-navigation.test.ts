// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";


import App from "../web/src/App";
import { detailUrl, subjectsUrl } from "../web/src/route-url";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

describe("앱 주소 이동", () => {
  it("일반 링크도 현재 필터와 해시를 보존하며 과목 주소만 바꾼다", () => {
    window.history.replaceState(null, "", "/?quizView=wrong#main-content");
    expect(detailUrl(7, "solution")).toBe("/?quizView=wrong&subject=7&tab=solution#main-content");
    expect(subjectsUrl()).toBe("/?quizView=wrong#main-content");
  });

  it("과목 전용 값만 있으면 목록 주소에 빈 물음표를 남기지 않는다", () => {
    window.history.replaceState(null, "", "/?subject=7&tab=quiz");
    expect(subjectsUrl()).toBe("/");
  });

  it("로그인이 풀린 상태에서는 스킵 링크나 뒤로가기가 과목 화면을 열지 않는다", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    });
    window.history.replaceState(null, "", "/?subject=7&tab=solution#main-content");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ownerExists: true,
      authenticated: false,
      authKind: null,
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(App));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(container.querySelector('input[name="username"]')).not.toBeNull();
    expect(container.querySelector('input[name="password"]')).not.toBeNull();
    expect(container.querySelector('input[name="current-password"]')).toBeNull();

    await act(async () => { window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(container.querySelector('input[name="username"]')).not.toBeNull();
    expect(container.querySelector('input[name="password"]')).not.toBeNull();
    expect(container.textContent).not.toContain("과목 추가");

    act(() => root.unmount());
  });

  it("첫 실행은 로그인 폼을 열고 회원가입 버튼을 눌러야 계정 생성 폼으로 바뀐다", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ownerExists: false,
      authenticated: false,
      authKind: null,
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(App));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("로그인");
    expect(container.textContent).toContain("회원가입");
    expect(container.querySelector('input[name="username"]')).not.toBeNull();
    expect(container.querySelector('input[name="current-password"]')).toBeNull();
    expect(container.querySelector('input[name="password"]')).not.toBeNull();
    expect(container.querySelector('input[name="password-confirm"]')).toBeNull();

    const signupButton = Array.from(container.querySelectorAll("button"))
      .find(button => button.textContent?.includes("회원가입"));
    expect(signupButton).toBeDefined();
    act(() => signupButton!.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(container.textContent).toContain("계정 만들기");
    expect(container.querySelector('input[name="password-confirm"]')).not.toBeNull();

    act(() => root.unmount());
  });
});
