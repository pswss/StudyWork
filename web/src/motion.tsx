// motion.tsx — 기존 호출부를 유지하는 정적 래퍼.
// 중요한 콘텐츠가 지연 애니메이션 실행에 의존하지 않도록 즉시 렌더한다.
import { ReactNode } from "react";

export function Reveal({
  children,
  as = "div",
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  as?: "div" | "span" | "h1" | "h2" | "p";
  className?: string;
}) {
  const Tag = as as any;
  return <Tag className={className}>{children}</Tag>;
}
