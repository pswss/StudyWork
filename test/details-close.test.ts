// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { installDetailsCloseAnimation } from "../web/src/details-close";

afterEach(() => document.body.replaceChildren());

function makeDetails() {
  const details = document.createElement("details");
  details.open = true;
  const summary = document.createElement("summary");
  const panel = document.createElement("p"); // summary 다음 콘텐츠 = 애니메이션 대상
  details.append(summary, panel);
  document.body.append(details);
  return { details, summary, panel };
}

describe("details 닫힘 애니메이션", () => {
  it("summary 클릭 시 헤더가 아니라 패널에만 닫힘 클래스를 붙이고 패널 animationend 뒤 open 제거", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: false }), // reduced-motion 아님
    });
    installDetailsCloseAnimation(document);
    const { details, summary, panel } = makeDetails();

    summary.click();
    // 애니메이션 중 — open 유지, 클래스는 details가 아니라 패널에 (헤더 불투명 유지)
    expect(details.open).toBe(true);
    expect(details.classList.contains("panel-closing")).toBe(false);
    expect(panel.classList.contains("panel-closing")).toBe(true);

    panel.dispatchEvent(new Event("animationend")); // jsdom엔 AnimationEvent 없음 — target만 확인

    expect(details.open).toBe(false);
    expect(panel.classList.contains("panel-closing")).toBe(false);
  });

  it("reduced-motion이면 즉시 닫힘(가로채지 않음)", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: true }),
    });
    installDetailsCloseAnimation(document);
    const { details, summary } = makeDetails();

    // 네이티브 토글을 흉내: preventDefault 안 됐으면 브라우저가 open을 끈다
    const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
    summary.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
    expect(details.classList.contains("details-closing")).toBe(false);
  });
});
