// ESC 키 뒤로가기 — 우선순위 스택.
// 안쪽 모드(퀴즈 플레이, 노트 편집, 폼)가 높은 priority로 등록되어 먼저 닫히고,
// 아무 모드도 없으면 App 레벨(priority 0)이 과목 목록으로 복귀시킨다.
// 입력 중(ESC 1회차)에는 포커스만 해제한다 — 타이핑 도중 화면이 튀는 것 방지.

import { useEffect, useRef } from "react";

type Entry = { fn: () => void; priority: number; seq: number };
const stack: Entry[] = [];
let seqCounter = 0;

if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;

    const t = e.target as HTMLElement | null;
    if (
      t &&
      (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
    ) {
      t.blur();
      e.preventDefault();
      return;
    }

    if (stack.length === 0) return;
    const top = [...stack].sort((a, b) => b.priority - a.priority || b.seq - a.seq)[0];
    e.preventDefault();
    top.fn();
  });
}

export function useEscape(active: boolean, handler: () => void, priority = 10) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return;
    const entry: Entry = { fn: () => ref.current(), priority, seq: seqCounter++ };
    stack.push(entry);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active, priority]);
}
