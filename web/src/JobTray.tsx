// 작업 트레이 — 과목의 진행 중·최근 AI 작업을 탭과 무관하게 한 줄씩 보여준다.
// 데이터는 SubjectDetail이 폴링해 내려주고, 여기서는 초 단위 경과 표시만 자체 틱한다.
import { useEffect, useState } from "react";
import type { SubjectJob } from "./api";

const KIND_LABELS: Record<string, string> = {
  "explanation-generate": "AI 해설",
  "question-generate": "문제 생성",
  "book-explanations": "해설 연결",
  "exam-plan": "시험 계획",
  consolidate: "단권화",
};

export function jobKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

interface Props {
  jobs: SubjectJob[];
  fetchedAt: number; // Date.now() 기준 목록 수신 시각 — elapsed_s에 로컬 틱을 더한다
  cancellingIds: Set<number>;
  onCancel: (jobId: number) => void;
}

export default function JobTray({ jobs, fetchedAt, cancellingIds, onCancel }: Props) {
  const hasRunning = jobs.some((job) => job.status === "processing");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hasRunning]);

  if (jobs.length === 0) return null;
  const drift = Math.max(0, (now - fetchedAt) / 1000);

  return (
    <section className="job-tray" aria-label="AI 작업 현황">
      <span className="job-tray-title">작업</span>
      <ul className="job-tray-list">
        {jobs.map((job) => {
          const running = job.status === "processing";
          return (
            <li className="job-tray-row" key={job.id ?? "consolidate"}>
              <span className="job-tray-kind">{jobKindLabel(job.kind)}</span>
              <span className="job-tray-label">{job.label ?? ""}</span>
              {running && job.progress !== null && (
                <span className="job-tray-progress">{job.progress}%</span>
              )}
              {running ? (
                <>
                  <span className="job-tray-elapsed" aria-hidden="true">
                    {formatElapsed(job.elapsed_s + drift)}
                  </span>
                  <span className="ai-pending-dots" aria-hidden="true"><i /><i /><i /></span>
                  {job.id !== null && (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => onCancel(job.id!)}
                      disabled={cancellingIds.has(job.id)}
                    >
                      {cancellingIds.has(job.id) ? "중단 중…" : "중단"}
                    </button>
                  )}
                </>
              ) : (
                <span className={`job-tray-state${job.status === "error" ? " bad" : ""}`}>
                  {job.status === "ready" ? "완료" : "실패"}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
