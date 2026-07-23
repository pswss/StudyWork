// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { installDetailsCloseAnimation } from "../web/src/details-close";

afterEach(() => document.body.replaceChildren());

function makeDetails() {
  const details = document.createElement("details");
  details.open = true;
  const summary = document.createElement("summary");
  details.append(summary, document.createElement("p"));
  document.body.append(details);
  return { details, summary };
}

describe("details 닫힘 애니메이션", () => {
  it("summary 클릭 시 닫힘 클래스를 붙이고 animationend 뒤에 open 제거", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: false }), // reduced-motion 아님
    });
    installDetailsCloseAnimation(document);
    const { details, summary } = makeDetails();

    summary.click();
    // 아직 애니메이션 중 — open 유지, 닫힘 클래스 부착
    expect(details.open).toBe(true);
    expect(details.classList.contains("details-closing")).toBe(true);

    details.dispatchEvent(new Event("animationend"));
    expect(details.open).toBe(false);
    expect(details.classList.contains("details-closing")).toBe(false);
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
