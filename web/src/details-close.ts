// 닫힘 애니메이션을 <details> 전체가 아니라 "패널(summary 다음 콘텐츠)"에만 재생한다.
// 예전엔 details 자체에 contentOut을 걸어 헤더(summary)까지 페이드/상승했다(헤더 깜빡임 버그).
// closeDetails() 하나로 모든 닫힘 경로(summary 클릭·Escape·바깥 클릭)를 통일한다. reduced-motion은 즉시.
const reduceMotion = () =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// summary 다음의 콘텐츠 요소만 애니메이션 대상 (헤더는 불투명 유지)
function panelOf(details: HTMLDetailsElement): HTMLElement | null {
  const summary = details.querySelector(":scope > summary");
  const panel = summary?.nextElementSibling as HTMLElement | null;
  return panel ?? null;
}

export function closeDetails(details: HTMLDetailsElement, after?: () => void) {
  const panel = panelOf(details);
  if (reduceMotion() || !panel) {
    details.open = false;
    after?.();
    return;
  }
  panel.classList.add("panel-closing");
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    panel.removeEventListener("animationend", onEnd);
    panel.classList.remove("panel-closing");
    details.open = false;
    after?.();
  };
  const onEnd = (e: AnimationEvent) => { if (e.target === panel) finish(); };
  panel.addEventListener("animationend", onEnd);
  const timer = setTimeout(finish, 240); // fallback (애니메이션 미발화 대비)
}

// 문서 위임 — 열려 있는 <details>를 summary 클릭으로 닫을 때만 가로챈다.
// SourcePicker의 Escape·바깥 클릭 경로는 closeDetails()를 직접 호출한다.
export function installDetailsCloseAnimation(doc: Document = document) {
  doc.addEventListener(
    "click",
    (event) => {
      const summary = (event.target as Element | null)?.closest?.("summary");
      const details = summary?.parentElement as HTMLDetailsElement | undefined;
      if (!summary || !details || details.tagName !== "DETAILS" || !details.open) return;
      if (reduceMotion()) return; // 즉시 닫힘
      event.preventDefault();
      closeDetails(details);
    },
    true // capture — React onToggle 등보다 먼저
  );
}
