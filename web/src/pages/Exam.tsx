// Exam.tsx — 시험 탭 컴포넌트
import { Fragment, useState, useEffect, useRef } from "react";
import { useEscape } from "../escape";
import {
  Subject, Exam as ExamType,
  exams as apiExams,
  createExam as apiCreateExam,
  aiJob as apiAIJob,
  cancelAIJob,
  togglePlanItem as apiToggleItem,
  replanExam as apiReplan,
  deleteExam as apiDeleteExam,
  NotFoundError,
} from "../api";
import { MdInlineText } from "../md";
import { AiPending } from "../Pending";
import { useUndoDelete } from "../UndoDelete";

interface Props {
  subject: Subject;
  active?: boolean;
}

type ExamActionError = {
  action: "replan" | "delete";
  message: string;
};

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

const DAY_FORMATTER = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", weekday: "short" });
const EXAM_DATE_FORMATTER = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
function formatDay(day: string): string {
  return DAY_FORMATTER.format(new Date(day + "T00:00:00"));
}
function formatExamDate(day: string): string {
  return EXAM_DATE_FORMATTER.format(new Date(day + "T00:00:00"));
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
  const { pending: pendingDelete, schedule: scheduleDelete } = useUndoDelete();
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const [examList, setExamList] = useState<ExamType[]>([]);
  const [loadErr, setLoadErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [jobErr, setJobErr] = useState("");
  const [jobNotice, setJobNotice] = useState("");
  const [cancellingJob, setCancellingJob] = useState(false);
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
  const [actionErrors, setActionErrors] = useState<Partial<Record<number, ExamActionError>>>({});
  const [toggleErrors, setToggleErrors] = useState<Partial<Record<number, string>>>({});

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
  useEffect(() => {
    setActionErrors({});
    setToggleErrors({});
  }, [subject.id]);

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
          setJobErr("이 과목의 시험 학습 계획 작업이 아닙니다. 다시 생성해 주세요.");
          return;
        }
        if (job.status === "processing") {
          setJobErr("");
          return;
        }
        try { sessionStorage.removeItem(key); } catch {}
        setPendingJobId(null);
        if (job.status === "error") {
          if (job.error === "사용자 중단") {
            setJobErr("");
            setJobNotice("시험 학습 계획 생성을 중단했습니다.");
          } else {
            setJobErr(job.error || "시험 학습 계획 생성에 실패했습니다.");
          }
          return;
        }
        setJobErr("");
        setJobNotice("");
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
    if (mountedRef.current) {
      setPendingJobId(jobId);
      setJobNotice("");
    }
  }

  async function stopPlanning() {
    if (pendingJobId === null || cancellingJob) return;
    setCancellingJob(true);
    setJobErr("");
    try {
      await cancelAIJob(pendingJobId);
      setJobNotice("학습 계획 생성 중단 요청을 보냈습니다.");
    } catch (error) {
      setJobErr(error instanceof Error ? error.message : "학습 계획 생성을 중단하지 못했습니다.");
    } finally {
      if (mountedRef.current) setCancellingJob(false);
    }
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
    setToggleErrors(prev => ({ ...prev, [itemId]: undefined }));
    // 낙관적 업데이트
    setExamList(prev => prev.map(ex => {
      if (ex.id !== examId) return ex;
      const items = ex.items.map(it => it.id === itemId ? { ...it, done: newDone } : it);
      const done_count = items.filter(it => it.done === 1).length;
      return { ...ex, items, done_count };
    }));
    try {
      await apiToggleItem(itemId, newDone === 1);
    } catch (e) {
      if (!mountedRef.current) return;
      // 롤백
      setExamList(prev => prev.map(ex => {
        if (ex.id !== examId) return ex;
        const items = ex.items.map(it => it.id === itemId ? { ...it, done: currentDone } : it);
        const done_count = items.filter(it => it.done === 1).length;
        return { ...ex, items, done_count };
      }));
      setToggleErrors(prev => ({
        ...prev,
        [itemId]: e instanceof Error ? e.message : "서버 응답을 확인하지 못했습니다.",
      }));
    }
  }

  // 재계획
  async function doReplan(examId: number) {
    if (pendingJobId !== null) return;
    if (!confirm("남은 미완료 일정을 오늘 기준으로 재계획할까요? (완료된 항목은 유지됩니다)")) return;
    setActionErrors(prev => ({ ...prev, [examId]: undefined }));
    setReplanningId(examId);
    try {
      const job = await apiReplan(examId);
      rememberJob(job.jobId);
      if (!mountedRef.current) return;
    } catch (e) {
      if (!mountedRef.current) return;
      setActionErrors(prev => ({
        ...prev,
        [examId]: {
          action: "replan",
          message: e instanceof Error ? e.message : "서버 응답을 확인하지 못했습니다.",
        },
      }));
    } finally {
      if (mountedRef.current) setReplanningId(null);
    }
  }

  // 삭제
  function doDelete(examId: number) {
    const exam = examList.find(item => item.id === examId);
    setActionErrors(prev => ({ ...prev, [examId]: undefined }));
    scheduleDelete({
      key: `exam:${examId}`,
      label: exam ? `“${exam.title}” 시험 계획` : "시험 계획",
      commit: async () => {
        try {
          await apiDeleteExam(examId);
          if (!mountedRef.current) return;
          setExamList(prev => prev.filter(ex => ex.id !== examId));
          if (expandedId === examId) setExpandedId(null);
        } catch (error) {
          await loadExams(false);
          if (mountedRef.current) {
            setActionErrors(prev => ({
              ...prev,
              [examId]: {
                action: "delete",
                message: error instanceof Error ? error.message : "서버 응답을 확인하지 못했습니다.",
              },
            }));
          }
        }
      },
    });
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
      {loadErr && (
        <div className="chat-err" role="alert" style={{ marginBottom: 12 }}>
          {loadErr} <button type="button" onClick={() => void loadExams()}>시험 목록 다시 불러오기</button>
        </div>
      )}
      {jobErr && <div className="chat-err" role="alert" style={{ marginBottom: 12 }}>{jobErr}</div>}
      {jobNotice && <div className="quiz-status-msg" role="status" aria-live="polite" style={{ marginBottom: 12 }}>{jobNotice}</div>}
      {pendingJobId !== null && (
        <div className="exam-creating-msg pending-action-row" style={{ marginBottom: 12 }}>
          <AiPending label="시험 학습 계획 생성 중 — 다른 탭에서도 계속됩니다" />
          <button type="button" className="btn sm" onClick={() => void stopPlanning()} disabled={cancellingJob}>
            {cancellingJob ? "중단 중…" : "생성 중단"}
          </button>
        </div>
      )}

      {/* 시험 추가 버튼 */}
      <div className="exam-add-row">
        <button
          className={`btn sm${showForm ? "" : " primary"}`}
          onClick={() => setShowForm(v => !v)}
          disabled={pendingJobId !== null}
          aria-expanded={showForm}
          aria-controls="exam-create-form"
        >
          {showForm ? "취소" : "시험 추가"}
        </button>
      </div>

      {/* 시험 추가 폼 */}
      <div id="exam-create-form" className="panel exam-form" hidden={!showForm}>
          <label className="exam-form-field">
            <span>시험 제목</span>
            <input
              className="text-input"
              name="exam-title"
              autoComplete="off"
              placeholder="예: 기말고사…"
              value={formTitle}
              onChange={e => setFormTitle(e.target.value)}
              disabled={creating}
            />
          </label>
          <label className="exam-form-field">
            <span>시험 날짜</span>
            <input
              type="date"
              className="text-input"
              name="exam-date"
              autoComplete="off"
              min={minDate}
              value={formDate}
              onChange={e => setFormDate(e.target.value)}
              disabled={creating}
            />
          </label>
          <label className="exam-form-field">
            <span>시험 범위 <small>선택</small></span>
            <textarea
              className="text-input"
              name="exam-scope"
              autoComplete="off"
              placeholder="예: 1~5단원, 공식 위주…"
              value={formScope}
              onChange={e => setFormScope(e.target.value)}
              disabled={creating}
              rows={2}
            />
          </label>
          {createErr && <div className="chat-err" role="alert" style={{ marginBottom: 8 }}>{createErr}</div>}
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

      {/* 시험 목록 */}
      {loading && <div className="quiz-status-msg" role="status" aria-live="polite" style={{ marginTop: 16 }}>불러오는 중…</div>}

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
          const actionError = actionErrors[ex.id];
          const grouped = isExpanded ? groupByDay(ex.items) : null;

          return (
            <div key={ex.id} className="panel exam-card">
              {/* 카드 헤더 */}
              <button
                type="button"
                className="exam-card-header"
                onClick={() => setExpandedId(isExpanded ? null : ex.id)}
                aria-expanded={isExpanded}
                aria-controls={`exam-detail-${ex.id}`}
              >
                <div className="exam-card-left">
                  <span className={`exam-dday${isDay ? " dday-today" : isEnd ? " dday-end" : ""}`}>
                    {dd}
                  </span>
                  <div className="exam-card-info">
                    <div className="exam-card-title">{ex.title}</div>
                    <div className="exam-card-date">{formatExamDate(ex.exam_date)}</div>
                    {ex.scope && <div className="exam-card-scope">{ex.scope}</div>}
                  </div>
                </div>
                <div className="exam-card-right">
                  <div className="exam-progress-bar">
                    <div className="exam-progress-fill" style={{ transform: `scaleX(${pct / 100})` }} />
                  </div>
                  <div className="exam-progress-label">{done}/{total} ({pct}%)</div>
                </div>
              </button>

              {/* 확장: 일정 상세 */}
              <div className="exam-card-detail" id={`exam-detail-${ex.id}`} hidden={!isExpanded}>
                {isExpanded && (
                  <>
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
                              <Fragment key={it.id}>
                                <label className="exam-item-row">
                                  <input
                                    type="checkbox"
                                    className="exam-checkbox"
                                    checked={it.done === 1}
                                    onChange={() => doToggle(ex.id, it.id, it.done)}
                                  />
                                  <span className={`exam-item-task${it.done === 1 ? " done" : ""}`}>
                                    <MdInlineText text={it.task} />
                                  </span>
                                </label>
                                {toggleErrors[it.id] && (
                                  <div className="chat-err" role="alert" style={{ textAlign: "left", margin: "4px 0 8px" }}>
                                    완료 상태를 저장하지 못해 이전 상태로 되돌렸습니다. {toggleErrors[it.id]}
                                    <button
                                      type="button"
                                      className="btn sm"
                                      aria-label="완료 상태 저장 다시 시도"
                                      style={{ marginLeft: 8 }}
                                      onClick={() => doToggle(ex.id, it.id, it.done)}
                                    >
                                      다시 시도
                                    </button>
                                  </div>
                                )}
                              </Fragment>
                            ))}
                          </div>
                        );
                      })}

                      {actionError && (
                        <div className="chat-err" role="alert" style={{ textAlign: "left", marginTop: 14 }}>
                          {actionError.action === "replan"
                            ? `계획을 조정하지 못했습니다. 완료 상태와 기존 일정은 그대로 유지됐습니다. ${actionError.message}`
                            : `시험 계획을 삭제하지 못했습니다. 목록과 일정은 그대로 유지됐습니다. ${actionError.message}`}
                          <button
                            type="button"
                            className="btn sm"
                            aria-label={actionError.action === "replan" ? "계획 조정 다시 시도" : "시험 계획 삭제 다시 시도"}
                            style={{ marginLeft: 8 }}
                            onClick={() => actionError.action === "replan" ? doReplan(ex.id) : doDelete(ex.id)}
                          >
                            다시 시도
                          </button>
                        </div>
                      )}

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
                          disabled={pendingDelete !== null}
                          onClick={() => doDelete(ex.id)}
                        >
                          {pendingDelete?.key === `exam:${ex.id}` ? "삭제 예정" : "삭제"}
                        </button>
                      </div>
                    </>
                  )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
