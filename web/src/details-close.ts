// 열림은 애니메이션(fade+rise), 닫힘은 네이티브 즉시 스냅 — 이 비대칭을 없앤다.
// summary 클릭으로 <details>를 닫을 때 닫힘 애니메이션을 재생한 뒤 open을 제거.
// 문서 위임 하나로 앱의 모든 <details>에 적용 (reduced-motion은 즉시).
const reduceMotion = () =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function installDetailsCloseAnimation(doc: Document = document) {
  doc.addEventListener(
    "click",
    (event) => {
      const summary = (event.target as Element | null)?.closest?.("summary");
      const details = summary?.parentElement as HTMLDetailsElement | undefined;
      // 열려 있는 <details>를 summary 클릭으로 닫는 경우만 가로챈다
      if (!summary || !details || details.tagName !== "DETAILS" || !details.open) return;
      if (reduceMotion()) return; // 즉시 닫힘
      event.preventDefault();
      details.classList.add("details-closing");
      const done = (e: AnimationEvent) => {
        if (e.target !== details) return; // 자식 애니메이션 버블 무시
        details.removeEventListener("animationend", done);
        details.classList.remove("details-closing");
        details.open = false;
      };
      details.addEventListener("animationend", done);
    },
    true // capture — React onToggle 등보다 먼저
  );
}
