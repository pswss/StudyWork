// AI 요청 진행 표시 공용 컴포넌트 — 바운스 점 + 라벨 + 경과 시간(mm:ss).
// 채팅/퀴즈/오답/시험/단권화 전 화면에서 사용.
import { useEffect, useState } from "react";

export function AiPending({ label }: { label: string }) {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSec(s => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  const displayLabel = /[…!?]$/.test(label.trim()) ? label : `${label}…`;
  return (
    <span className="ai-pending" role="status" aria-live="polite">
      <span className="ai-pending-dots" aria-hidden="true"><i /><i /><i /></span>
      <span>{displayLabel}</span>
      <span className="ai-pending-sec" aria-hidden="true">{elapsed}</span>
    </span>
  );
}
