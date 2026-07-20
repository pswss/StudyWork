// motion.tsx — 경량 모션 유틸: 마그네틱 버튼 훅 + 라인마스크 텍스트 리빌
import { useEffect, useRef, ReactNode } from "react";

const canHover =
  typeof window !== "undefined" &&
  window.matchMedia("(hover: hover)").matches &&
  !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// 커서를 향해 살짝 끌려가는 버튼 (데스크톱 전용)
export function useMagnetic<T extends HTMLElement>(strength = 0.32) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!canHover) return;
    const el = ref.current;
    if (!el) return;

    function onMove(e: MouseEvent) {
      const r = el!.getBoundingClientRect();
      const x = e.clientX - (r.left + r.width / 2);
      const y = e.clientY - (r.top + r.height / 2);
      el!.style.transform = `translate(${x * strength}px, ${y * strength}px)`;
    }
    function onLeave() {
      el!.style.transform = "translate(0px, 0px)";
    }
    el.addEventListener("mousemove", onMove);
    el.addEventListener("mouseleave", onLeave);
    return () => {
      el.removeEventListener("mousemove", onMove);
      el.removeEventListener("mouseleave", onLeave);
    };
  }, [strength]);
  return ref;
}

// 라인마스크 리빌 — 진입 시 아래에서 위로 나타난다. delay(초)로 스태거.
export function Reveal({
  children,
  delay = 0,
  as = "div",
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  as?: "div" | "span" | "h1" | "h2" | "p";
  className?: string;
}) {
  const Tag = as as any;
  return (
    <Tag className={`reveal ${className}`} style={{ ["--rd" as any]: `${delay}s` }}>
      <span className="reveal-inner">{children}</span>
    </Tag>
  );
}
