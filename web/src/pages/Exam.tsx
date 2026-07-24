// Exam.tsx — 시험 탭 컴포넌트
import { Fragment, useState, useEffect, useRef } from "react";
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
import { MdInlineText } from "../md";
import { AiPending } from "../Pending";
import { useUndoDelete } from "../UndoDelete";
import { useI18n } from "../i18n";

interface Props {
  subject: Subject;
  active?: boolean;
}

const DETAIL_EXIT_MS = 160;

type ExamActionError = {
  action: "replan" | "delete";
  message: string;
};

// D-day 계산
function daysUntil(examDate: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exam = new Date(examDate + "T00:00:00");
  return Math.round((exam.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function todayStr(): string {
  // 로컬 날짜 기준 (toISOString은 UTC라 자정~오전 9시(KST)에 어제로 계산되는 문제가 있음)
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 동시 계획 생성 지원 — 저장 형식은 [{id, examId}] 목록 (examId=null이면 새 시험 생성).
// 구버전 단일 숫자 문자열도 읽는다.
interface TrackedPlanJob { id: number; examId: number | null }

function planJobsKey(subjectId: number): string {
  return `studywork:exam-job:${subjectId}`;
}

function storedPlanJobs(subjectId: number): TrackedPlanJob[] {
  try {
    const raw = sessionStorage.getItem(planJobsKey(subjectId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "number") {
      return Number.isSafeInteger(parsed) && parsed > 0 ? [{ id: parsed, examId: null }] : [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is TrackedPlanJob => {
      if (typeof entry !== "object" || entry === null) return false;
      const { id, examId } = entry as { id?: unknown; examId?: unknown };
      return typeof id === "number" && Number.isSafeInteger(id) && id > 0
        && (examId === null || (typeof examId === "number" && Number.isSafeInteger(examId)));
    });
  } catch {
    return [];
  }
}

function writeStoredPlanJobs(subjectId: number, jobs: TrackedPlanJob[]): void {
  try {
    if (jobs.length === 0) sessionStorage.removeItem(planJobsKey(subjectId));
    else sessionStorage.setItem(planJobsKey(subjectId), JSON.stringify(jobs));
  } catch {}
}

export default function Exam({ subject, active = true }: Props) {
  const { locale, t, formatDate, formatNumber } = useI18n();
  const { pending: pendingDelete, schedule: scheduleDelete } = useUndoDelete();
  const mountedRef = useRef(true);
  const closeTimerRef = useRef<number | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  const [examList, setExamList] = useState<ExamType[]>([]);
  const [loadErr, setLoadErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [jobErr, setJobErr] = useState("");
  const [jobNotice, setJobNotice] = useState("");
  const [pendingJobs, setPendingJobs] = useState<TrackedPlanJob[]>(() => storedPlanJobs(subject.id));

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
  const [closingId, setClosingId] = useState<number | null>(null);

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
      setLoadErr(e instanceof Error ? e.message : t("learning.exam.loadFailed"));
    } finally {
      if (mountedRef.current && showLoading) setLoading(false);
    }
  }

  useEffect(() => { loadExams(); }, [subject.id]);
  useEffect(() => { setPendingJobs(storedPlanJobs(subject.id)); }, [subject.id]);
  useEffect(() => {
    setActionErrors({});
    setToggleErrors({});
    setExpandedId(null);
    setClosingId(null);
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, [subject.id]);

  function toggleExpanded(examId: number) {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (expandedId !== examId) {
      setClosingId(null);
      setExpandedId(examId);
      return;
    }
    if (closingId === examId) {
      setClosingId(null);
      return;
    }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setClosingId(null);
      setExpandedId(null);
      return;
    }
    setClosingId(examId);
    closeTimerRef.current = window.setTimeout(() => {
      setExpandedId(current => current === examId ? null : current);
      setClosingId(current => current === examId ? null : current);
      closeTimerRef.current = null;
    }, DETAIL_EXIT_MS);
  }

  // job ID들은 sessionStorage에 남아 Exam 컴포넌트가 언마운트되어도 재진입 시 상태를 이어서 확인한다.
  // 여러 작업을 한 주기에 모두 확인하고, 끝난 작업만 목록에서 제거한다.
  useEffect(() => {
    if (pendingJobs.length === 0) return;
    const polledSubjectId = subject.id;
    const ids = pendingJobs.map((job) => job.id);
    let stopped = false;

    async function checkJobs() {
      const finished: number[] = [];
      let reload = false;
      let expandId: number | null = null;
      for (const jobId of ids) {
        try {
          const job = await apiAIJob<{ examId: number }>(jobId);
          if (stopped) return;
          if (job.subject_id !== polledSubjectId) {
            finished.push(jobId);
            setJobErr(t("learning.exam.wrongSubject"));
            continue;
          }
          if (job.status === "processing") continue;
          finished.push(jobId);
          if (job.status === "error") {
            if (job.error === "사용자 중단") setJobNotice(t("learning.exam.stopped"));
            else {
              setJobErr(locale === "ko" && job.error
                ? job.error
                : t("learning.exam.generationFailed"));
            }
          } else {
            setJobErr("");
            reload = true;
            if (job.result?.examId) expandId = job.result.examId;
          }
        } catch (e) {
          if (stopped) return;
          if (e instanceof NotFoundError) {
            finished.push(jobId);
          }
          setJobErr(e instanceof Error ? e.message : t("learning.exam.statusFailed"));
        }
      }
      if (finished.length > 0) {
        writeStoredPlanJobs(polledSubjectId, storedPlanJobs(polledSubjectId).filter((job) => !finished.includes(job.id)));
        if (!stopped && mountedRef.current) {
          setPendingJobs((current) => current.filter((job) => !finished.includes(job.id)));
          if (reload) {
            await loadExams(false);
            if (!stopped && expandId !== null) setExpandedId(expandId);
          }
        }
      }
    }

    void checkJobs();
    const timer = setInterval(checkJobs, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [pendingJobs, subject.id, locale]);

  function rememberJob(jobId: number, examId: number | null) {
    writeStoredPlanJobs(subject.id, [
      ...storedPlanJobs(subject.id).filter((job) => job.id !== jobId),
      { id: jobId, examId },
    ]);
    if (mountedRef.current) {
      setPendingJobs(storedPlanJobs(subject.id));
      setJobNotice("");
    }
  }

  // 시험 생성 — 다른 계획 생성이 진행 중이어도 새 시험은 언제든 추가할 수 있다.
  async function doCreate() {
    if (!formTitle.trim() || !formDate || creating) return;
    setCreating(true);
    setCreateErr("");
    try {
      const job = await apiCreateExam(subject.id, {
        title: formTitle.trim(),
        exam_date: formDate,
        scope: formScope.trim() || undefined,
      });
      rememberJob(job.jobId, null);
      if (!mountedRef.current) return;
      setFormTitle(""); setFormDate(""); setFormScope("");
      setShowForm(false);
    } catch (e) {
      if (!mountedRef.current) return;
      setCreateErr(e instanceof Error ? e.message : t("learning.exam.createFailed"));
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
        [itemId]: e instanceof Error ? e.message : t("learning.exam.serverFallback"),
      }));
    }
  }

  // 재계획 — 같은 시험의 재계획만 잠그고, 다른 시험은 동시에 조정할 수 있다.
  async function doReplan(examId: number) {
    if (pendingJobs.some((job) => job.examId === examId)) return;
    if (!confirm(t("learning.exam.replanConfirm"))) return;
    setActionErrors(prev => ({ ...prev, [examId]: undefined }));
    setReplanningId(examId);
    try {
      const job = await apiReplan(examId);
      rememberJob(job.jobId, examId);
      if (!mountedRef.current) return;
    } catch (e) {
      if (!mountedRef.current) return;
      setActionErrors(prev => ({
        ...prev,
        [examId]: {
          action: "replan",
          message: e instanceof Error ? e.message : t("learning.exam.serverFallback"),
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
      label: exam
        ? t("learning.exam.deleteLabel", { title: exam.title })
        : t("learning.exam.deleteGeneric"),
      commit: async () => {
        try {
          await apiDeleteExam(examId);
          if (!mountedRef.current) return;
          setExamList(prev => prev.filter(ex => ex.id !== examId));
          if (expandedId === examId) {
            if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
            closeTimerRef.current = null;
            setClosingId(null);
            setExpandedId(null);
          }
        } catch (error) {
          await loadExams(false);
          if (mountedRef.current) {
            setActionErrors(prev => ({
              ...prev,
              [examId]: {
                action: "delete",
                message: error instanceof Error ? error.message : t("learning.exam.serverFallback"),
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
          {loadErr} <button type="button" onClick={() => void loadExams()}>{t("learning.exam.reload")}</button>
        </div>
      )}
      {jobErr && <div className="chat-err" role="alert" style={{ marginBottom: 12 }}>{jobErr}</div>}
      {jobNotice && <div className="quiz-status-msg" role="status" aria-live="polite" style={{ marginBottom: 12 }}>{jobNotice}</div>}
      {pendingJobs.length > 0 && (
        <div className="exam-creating-msg pending-action-row" style={{ marginBottom: 12 }}>
          <AiPending
            label={pendingJobs.length > 1
              ? t("learning.exam.pendingMany", { count: formatNumber(pendingJobs.length) })
              : t("learning.exam.pendingOne")}
          />
        </div>
      )}

      {/* 시험 추가 버튼 — 다른 계획 생성이 진행 중이어도 새 시험 추가는 가능 */}
      <div className="exam-add-row">
        <button
          className={`btn sm${showForm ? "" : " primary"}`}
          onClick={() => setShowForm(v => !v)}
          aria-expanded={showForm}
          aria-controls="exam-create-form"
        >
          {showForm ? t("learning.common.cancel") : t("learning.exam.add")}
        </button>
      </div>

      {/* 시험 추가 폼 */}
      <div id="exam-create-form" className="panel exam-form" hidden={!showForm}>
          <label className="exam-form-field">
            <span>{t("learning.exam.title")}</span>
            <input
              className="text-input"
              name="exam-title"
              autoComplete="off"
              placeholder={t("learning.exam.titlePlaceholder")}
              value={formTitle}
              onChange={e => setFormTitle(e.target.value)}
              disabled={creating}
            />
          </label>
          <label className="exam-form-field">
            <span>{t("learning.exam.date")}</span>
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
            <span>{t("learning.exam.scope")} <small>{t("learning.common.optional")}</small></span>
            <textarea
              className="text-input"
              name="exam-scope"
              autoComplete="off"
              placeholder={t("learning.exam.scopePlaceholder")}
              value={formScope}
              onChange={e => setFormScope(e.target.value)}
              disabled={creating}
              rows={2}
            />
          </label>
          {createErr && <div className="chat-err" role="alert" style={{ marginBottom: 8 }}>{createErr}</div>}
          {creating ? (
            <div className="exam-creating-msg"><AiPending label={t("learning.exam.creating")} /></div>
          ) : (
            <button
              className="btn primary sm"
              onClick={doCreate}
              disabled={!formTitle.trim() || !formDate}
            >
              {t("learning.exam.generate")}
            </button>
          )}
      </div>

      {/* 시험 목록 */}
      {loading && (
        <div className="quiz-status-msg" role="status" aria-live="polite" style={{ marginTop: 16 }}>
          {t("learning.exam.loading")}
        </div>
      )}

      {!loading && examList.length === 0 && (
        <div className="quiz-empty">{t("learning.exam.empty")}</div>
      )}

      <div className="exam-list">
        {examList.map(ex => {
          const remainingDays = daysUntil(ex.exam_date);
          const isEnd = remainingDays < 0;
          const isDay = remainingDays === 0;
          const dd = isEnd
            ? t("learning.exam.ended")
            : isDay
              ? "D-DAY"
              : `D-${formatNumber(remainingDays)}`;
          const total = ex.items.length;
          const done = ex.done_count ?? ex.items.filter(it => it.done === 1).length;
          const pct = total > 0 ? Math.round((done / total) * 100) : 0;
          const isExpanded = expandedId === ex.id;
          const isClosing = closingId === ex.id;
          const isReplanning = replanningId === ex.id || pendingJobs.some((job) => job.examId === ex.id);
          const actionError = actionErrors[ex.id];
          const grouped = isExpanded ? groupByDay(ex.items) : null;

          return (
            <div key={ex.id} className="panel exam-card">
              {/* 카드 헤더 */}
              <button
                type="button"
                className="exam-card-header"
                onClick={() => toggleExpanded(ex.id)}
                aria-expanded={isExpanded && !isClosing}
                aria-controls={`exam-detail-${ex.id}`}
              >
                <div className="exam-card-left">
                  <span className={`exam-dday${isDay ? " dday-today" : isEnd ? " dday-end" : ""}`}>
                    {dd}
                  </span>
                  <div className="exam-card-info">
                    <div className="exam-card-title">{ex.title}</div>
                    <div className="exam-card-date">
                      {formatDate(ex.exam_date + "T00:00:00", {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                        weekday: "short",
                      })}
                    </div>
                    {ex.scope && <div className="exam-card-scope">{ex.scope}</div>}
                  </div>
                </div>
                <div className="exam-card-right">
                  <div className="exam-progress-bar">
                    <div className="exam-progress-fill" style={{ transform: `scaleX(${pct / 100})` }} />
                  </div>
                  <div className="exam-progress-label">
                    {formatNumber(done)}/{formatNumber(total)} ({formatNumber(pct / 100, {
                      style: "percent",
                      maximumFractionDigits: 0,
                    })})
                  </div>
                </div>
              </button>

              {/* 확장: 일정 상세 */}
              <div
                className={`exam-card-detail${isClosing ? " closing" : ""}`}
                id={`exam-detail-${ex.id}`}
                hidden={!isExpanded}
                aria-hidden={isClosing}
              >
                {isExpanded && (
                  <>
                  {isReplanning ? (
                    <div className="exam-creating-msg"><AiPending label={t("learning.exam.replanning")} /></div>
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
                              {formatDate(day + "T00:00:00", {
                                month: "numeric",
                                day: "numeric",
                                weekday: "short",
                              })}
                              {isToday && <span className="exam-today-badge">{t("learning.exam.today")}</span>}
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
                                    {t("learning.exam.toggleRollback", { error: toggleErrors[it.id] ?? "" })}
                                    <button
                                      type="button"
                                      className="btn sm"
                                      aria-label={t("learning.exam.toggleRetryAria")}
                                      style={{ marginLeft: 8 }}
                                      onClick={() => doToggle(ex.id, it.id, it.done)}
                                    >
                                      {t("learning.common.retry")}
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
                            ? t("learning.exam.replanError", { error: actionError.message })
                            : t("learning.exam.deleteError", { error: actionError.message })}
                          <button
                            type="button"
                            className="btn sm"
                            aria-label={actionError.action === "replan"
                              ? t("learning.exam.replanRetryAria")
                              : t("learning.exam.deleteRetryAria")}
                            style={{ marginLeft: 8 }}
                            onClick={() => actionError.action === "replan" ? doReplan(ex.id) : doDelete(ex.id)}
                          >
                            {t("learning.common.retry")}
                          </button>
                        </div>
                      )}

                      <div className="exam-card-actions">
                        <button
                          className="btn sm"
                          onClick={() => doReplan(ex.id)}
                          disabled={isEnd || isReplanning}
                        >
                          {t("learning.exam.replan")}
                        </button>
                        <button
                          className="btn sm danger"
                          disabled={pendingDelete !== null}
                          onClick={() => doDelete(ex.id)}
                        >
                          {pendingDelete?.key === `exam:${ex.id}`
                            ? t("learning.common.deletePending")
                            : t("learning.common.delete")}
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
