// Cursor.tsx — 커스텀 커서 (점 + 링). 데스크톱 전용, 터치기기·모션축소 시 비활성.
import { useEffect, useRef } from "react";

export default function Cursor() {
  const dotRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 터치 기기 / 포인터 없음 / 모션 축소 → 커서 비활성
    const noHover =
      window.matchMedia("(hover: none)").matches ||
      window.matchMedia("(pointer: coarse)").matches ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (noHover) return;

    const dot = dotRef.current;
    const ring = ringRef.current;
    if (!dot || !ring) return;

    document.body.classList.add("has-custom-cursor");

    let rx = window.innerWidth / 2;
    let ry = window.innerHeight / 2;
    let mx = rx;
    let my = ry;
    let raf = 0;

    function onMove(e: MouseEvent) {
      mx = e.clientX;
      my = e.clientY;
      dot!.style.transform = `translate(${mx}px, ${my}px)`;
      // 인터랙티브 요소 위에서 링 확대
      const el = e.target as HTMLElement;
      const interactive = el.closest(
        "button, a, input, textarea, select, label, [role='button'], .clickable, .subj-card, .tab-index, .mode-chip, .choice-btn, .ox-btn"
      );
      ring!.dataset.active = interactive ? "1" : "0";
    }

    function tick() {
      rx += (mx - rx) * 0.18;
      ry += (my - ry) * 0.18;
      ring!.style.transform = `translate(${rx}px, ${ry}px)`;
      raf = requestAnimationFrame(tick);
    }

    function onDown() { ring!.dataset.down = "1"; }
    function onUp() { ring!.dataset.down = "0"; }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    raf = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      cancelAnimationFrame(raf);
      document.body.classList.remove("has-custom-cursor");
    };
  }, []);

  return (
    <>
      <div ref={ringRef} className="cursor-ring" aria-hidden />
      <div ref={dotRef} className="cursor-dot" aria-hidden />
    </>
  );
}
