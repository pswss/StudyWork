// Exam.tsx — 시험 탭 컴포넌트
import { useState, useEffect, useRef } from "react";
import { useEscape } from "../escape";
import {
  Subject, Exam as ExamType,
  exams as apiExams,
  createExam as apiCreateExam,
  aiJob as apiAIJob,
  togglePlanItem as apiToggleItem,
  replanExam as apiReplan,
  deleteExam as apiDeleteExam,
  NotFoundError,
} from "../api";
import { MdInline } from "../md";
import { AiPending } from "../Pending";

interface Props {
  subject: Subject;
  active?: boolean;
}

// D-day 계산
function dday(examDate: string): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exam = new Date(examDate + "T00:00:00");
  const diff = Math.round((exam.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diff < 0) return "종료";
  if (diff === 0) return "D-DAY";
  return `D-${diff}`;
}

function todayStr(): string {
  // 로컬 날짜 기준 (toISOString은 UTC라 자정~오전 9시(KST)에 어제로 계산되는 문제가 있음)
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// YYYY-MM-DD → "M/D (요일)" 형태
const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];
function formatDay(day: string): string {
  const d = new Date(day + "T00:00:00");
  return `${d.getMonth() + 1}/${d.getDate()} (${DAY_NAMES[d.getDay()]})`;
}

function storedJobId(subjectId: number): number | null {
  try {
    const id = Number(sessionStorage.getItem(`studywork:exam-job:${subjectId}`));
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

export default function Exam({ subject, active = true }: Props) {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const [examList, setExamList] = useState<ExamType[]>([]);
  const [loadErr, setLoadErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [jobErr, setJobErr] = useState("");
  const [pendingJobId, setPendingJobId] = useState<number | null>(() => storedJobId(subject.id));

  // 시험 추가 폼
  const [showForm, setShowForm] = useState(false);
  const [formTitle, setFormTitle] = useState("");
  const [formDate, setFormDate] = useState("");
  const [formScope, setFormScope] = useState("");
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState("");

  // ESC: 시험 추가 폼 닫기 (계획 생성 중에는 유지)
  useEscape(active && showForm && !creating, () => setShowForm(false));

  // 확장된 카드
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // replan 상태
  const [replanningId, setReplanningId] = useState<number | null>(null);

  async function loadExams(showLoading = true) {
    if (showLoading) setLoading(true);
    setLoadErr("");
    try {
      const list = await apiExams(subject.id);
      if (!mountedRef.current) return;
      setExamList(list);
    } catch (e) {
      if (!mountedRef.current) return;
      setLoadErr(e instanceof Error ? e.message : "시험 불러오기 실패");
    } finally {
      if (mountedRef.current && showLoading) setLoading(false);
    }
  }

  useEffect(() => { loadExams(); }, [subject.id]);
  useEffect(() => { setPendingJobId(storedJobId(subject.id)); }, [subject.id]);

  // job ID는 sessionStorage에 남아 Exam 컴포넌트가 언마운트되어도 재진입 시 상태를 이어서 확인한다.
  useEffect(() => {
    if (pendingJobId === null) return;
    let stopped = false;
    const key = `studywork:exam-job:${subject.id}`;

    async function checkJob() {
      try {
        const job = await apiAIJob<{ examId: number }>(pendingJobId!);
        if (stopped) return;
        if (job.subject_id !== subject.id) {
          try { sessionStorage.removeItem(key); } catch {}
          setPendingJobId(null);
          setJobErr("이 과목의 시험 TODO 작업이 아닙니다. 다시 생성해 주세요.");
          return;
        }
        if (job.status === "processing") {
          setJobErr("");
          return;
        }
        try { sessionStorage.removeItem(key); } catch {}
        setPendingJobId(null);
        if (job.status === "error") {
          setJobErr(job.error || "시험 TODO 계획 생성에 실패했습니다.");
          return;
        }
        setJobErr("");
        await loadExams(false);
        if (!stopped && job.result?.examId) setExpandedId(job.result.examId);
      } catch (e) {
        if (stopped) return;
        if (e instanceof NotFoundError) {
          try { sessionStorage.removeItem(key); } catch {}
          setPendingJobId(null);
        }
        setJobErr(e instanceof Error ? e.message : "계획 상태 확인 실패");
      }
    }

    void checkJob();
    const timer = setInterval(checkJob, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [pendingJobId, subject.id]);

  function rememberJob(jobId: number) {
    try { sessionStorage.setItem(`studywork:exam-job:${subject.id}`, String(jobId)); } catch {}
    if (mountedRef.current) setPendingJobId(jobId);
  }

  // 시험 생성
  async function doCreate() {
    if (!formTitle.trim() || !formDate || pendingJobId !== null) return;
    setCreating(true);
    setCreateErr("");
    try {
      const job = await apiCreateExam(subject.id, {
        title: formTitle.trim(),
        exam_date: formDate,
        scope: formScope.trim() || undefined,
      });
      rememberJob(job.jobId);
      if (!mountedRef.current) return;
      setFormTitle(""); setFormDate(""); setFormScope("");
      setShowForm(false);
    } catch (e) {
      if (!mountedRef.current) return;
      setCreateErr(e instanceof Error ? e.message : "시험 생성 실패");
    } finally {
      if (mountedRef.current) setCreating(false);
    }
  }

  // 아이템 체크 토글 (낙관적 업데이트)
  async function doToggle(examId: number, itemId: number, currentDone: number) {
    const newDone = currentDone === 1 ? 0 : 1;
    // 낙관적 업데이트
    setExamList(prev => prev.map(ex => {
      if (ex.id !== examId) return ex;
      const items = ex.items.map(it => it.id === itemId ? { ...it, done: newDone } : it);
      const done_count = items.filter(it => it.done === 1).length;
      return { ...ex, items, done_count };
    }));
    try {
      await apiToggleItem(itemId, newDone === 1);
    } catch {
      // 롤백
      setExamList(prev => prev.map(ex => {
        if (ex.id !== examId) return ex;
        const items = ex.items.map(it => it.id === itemId ? { ...it, done: currentDone } : it);
        const done_count = items.filter(it => it.done === 1).length;
        return { ...ex, items, done_count };
      }));
    }
  }

  // 재계획
  async function doReplan(examId: number) {
    if (pendingJobId !== null) return;
    if (!confirm("남은 미완료 일정을 오늘 기준으로 재계획할까요? (완료된 항목은 유지됩니다)")) return;
    setReplanningId(examId);
    try {
      const job = await apiReplan(examId);
      rememberJob(job.jobId);
      if (!mountedRef.current) return;
    } catch (e) {
      if (!mountedRef.current) return;
      alert(e instanceof Error ? e.message : "재계획 실패");
    } finally {
      if (mountedRef.current) setReplanningId(null);
    }
  }

  // 삭제
  async function doDelete(examId: number) {
    if (!confirm("시험 계획을 삭제하시겠습니까?")) return;
    try {
      await apiDeleteExam(examId);
      if (!mountedRef.current) return;
      setExamList(prev => prev.filter(ex => ex.id !== examId));
      if (expandedId === examId) setExpandedId(null);
    } catch (e) {
      alert(e instanceof Error ? e.message : "삭제 실패");
    }
  }

  const today = todayStr();
  const minDate = today;

  // 일자별 그룹핑
  function groupByDay(items: ExamType["items"]) {
    const map = new Map<string, ExamType["items"]>();
    for (const it of items) {
      const arr = map.get(it.day) ?? [];
      arr.push(it);
      map.set(it.day, arr);
    }
    return map;
  }

  return (
    <div className="exam-wrap">
      {loadErr && <div className="chat-err" style={{ marginBottom: 12 }}>{loadErr}</div>}
      {jobErr && <div className="chat-err" style={{ marginBottom: 12 }}>{jobErr}</div>}
      {pendingJobId !== null && (
        <div className="exam-creating-msg" style={{ marginBottom: 12 }}>
          <AiPending label="시험 TODO 계획 생성 중 — 다른 탭에서도 계속됩니다" />
        </div>
      )}

      {/* 시험 추가 버튼 */}
      <div className="exam-add-row">
        <button
          className={`btn sm${showForm ? "" : " primary"}`}
          onClick={() => setShowForm(v => !v)}
          disabled={pendingJobId !== null}
        >
          {showForm ? "취소" : "시험 추가"}
        </button>
      </div>

      {/* 시험 추가 폼 */}
      {showForm && (
        <div className="panel exam-form">
          <input
            className="text-input"
            placeholder="시험 제목 (예: 기말고사)"
            value={formTitle}
            onChange={e => setFormTitle(e.target.value)}
            disabled={creating}
            style={{ marginBottom: 8 }}
          />
          <input
            type="date"
            className="text-input"
            min={minDate}
            value={formDate}
            onChange={e => setFormDate(e.target.value)}
            disabled={creating}
            style={{ marginBottom: 8 }}
          />
          <textarea
            className="text-input"
            placeholder="시험 범위 (선택) — 예: 1~5단원, 공식 위주"
            value={formScope}
            onChange={e => setFormScope(e.target.value)}
            disabled={creating}
            rows={2}
            style={{ marginBottom: 12 }}
          />
          {createErr && <div className="chat-err" style={{ marginBottom: 8 }}>{createErr}</div>}
          {creating ? (
            <div className="exam-creating-msg"><AiPending label="계획 생성 중 (최대 1-2분)" /></div>
          ) : (
            <button
              className="btn primary sm"
              onClick={doCreate}
              disabled={!formTitle.trim() || !formDate || pendingJobId !== null}
            >
              계획 생성
            </button>
          )}
        </div>
      )}

      {/* 시험 목록 */}
      {loading && <div className="quiz-status-msg" style={{ marginTop: 16 }}>불러오는 중...</div>}

      {!loading && examList.length === 0 && (
        <div className="quiz-empty">시험 계획이 없습니다. 시험을 추가해 보세요.</div>
      )}

      <div className="exam-list">
        {examList.map(ex => {
          const dd = dday(ex.exam_date);
          const isEnd = dd === "종료";
          const isDay = dd === "D-DAY";
          const total = ex.items.length;
          const done = ex.done_count ?? ex.items.filter(it => it.done === 1).length;
          const pct = total > 0 ? Math.round((done / total) * 100) : 0;
          const isExpanded = expandedId === ex.id;
          const isReplanning = replanningId === ex.id;
          const grouped = isExpanded ? groupByDay(ex.items) : null;

          return (
            <div key={ex.id} className="panel exam-card">
              {/* 카드 헤더 */}
              <div
                className="exam-card-header"
                onClick={() => setExpandedId(isExpanded ? null : ex.id)}
              >
                <div className="exam-card-left">
                  <span className={`exam-dday${isDay ? " dday-today" : isEnd ? " dday-end" : ""}`}>
                    {dd}
                  </span>
                  <div className="exam-card-info">
                    <div className="exam-card-title">{ex.title}</div>
                    <div className="exam-card-date">{ex.exam_date}</div>
                    {ex.scope && <div className="exam-card-scope">{ex.scope}</div>}
                  </div>
                </div>
                <div className="exam-card-right">
                  <div className="exam-progress-bar">
                    <div className="exam-progress-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="exam-progress-label">{done}/{total} ({pct}%)</div>
                </div>
              </div>

              {/* 확장: 일정 상세 */}
              {isExpanded && (
                <div className="exam-card-detail">
                  {isReplanning ? (
                    <div className="exam-creating-msg"><AiPending label="재계획 중 (최대 1-2분)" /></div>
                  ) : (
                    <>
                      {grouped && Array.from(grouped.entries()).map(([day, items]) => {
                        const isToday = day === today;
                        const isPast = day < today;
                        return (
                          <div
                            key={day}
                            className={`exam-day-group${isToday ? " today" : isPast ? " past" : ""}`}
                          >
                            <div className="exam-day-heading">
                              {formatDay(day)}
                              {isToday && <span className="exam-today-badge">오늘</span>}
                            </div>
                            {items.map(it => (
                              <label key={it.id} className="exam-item-row">
                                <input
                                  type="checkbox"
                                  className="exam-checkbox"
                                  checked={it.done === 1}
                                  onChange={() => doToggle(ex.id, it.id, it.done)}
                                />
                                <span className={`exam-item-task${it.done === 1 ? " done" : ""}`}>
                                  <MdInline text={it.task} />
                                </span>
                              </label>
                            ))}
                          </div>
                        );
                      })}

                      <div className="exam-card-actions">
                        <button
                          className="btn sm"
                          onClick={() => doReplan(ex.id)}
                          disabled={isEnd || pendingJobId !== null}
                        >
                          계획 조정
                        </button>
                        <button
                          className="btn sm danger"
                          onClick={() => doDelete(ex.id)}
                        >
                          삭제
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
