// Wrong.tsx — 오답 노트 패널 (퀴즈 탭 안의 보조 뷰)
// 목록·사진 등록·약점 분석 + "틀린 문제 바로 풀기"(kickWrongQuiz 트리거)
import { useState, useEffect, useRef } from "react";
import {
  Subject, WrongQuestion,
  wrongQuestions as apiWrongQuestions,
  extractWrong as apiExtractWrong,
  analyzeWrong as apiAnalyzeWrong,
  bookFileUrl,
  pageImageUrl,
} from "../api";
import { Md, MdInline, MdInlineText } from "../md";
import { useI18n } from "../i18n";
import { AiPending } from "../Pending";
import { difficultyLabel, figureAlt, qtypeLabel } from "./Quiz";

interface Props {
  subject: Subject;
  active: boolean;
  onRelearn: () => void; // "틀린 문제 바로 풀기" → 퀴즈 뷰로 전환 + 오답만 즉시 출제
}

export default function WrongPanel({ subject, active, onRelearn }: Props) {
  const { locale, t, formatDate, formatNumber } = useI18n();
  const [rows, setRows] = useState<WrongQuestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [errKind, setErrKind] = useState<"load" | "upload" | "analyze" | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState("");
  const [analysis, setAnalysis] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);
  const subjectIdRef = useRef(subject.id);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    subjectIdRef.current = subject.id;
    requestRef.current++;
    setRows([]);
    setExpanded(new Set());
    setStatus("");
    setAnalysis("");
    setErr("");
    setErrKind(null);
  }, [subject.id]);

  // 패널이 보일 때마다 갱신 — 방금 퀴즈에서 틀린 문제도 바로 반영
  useEffect(() => {
    if (active) void load();
  }, [active, subject.id]);

  async function load() {
    const request = ++requestRef.current;
    setLoading(true);
    setErr("");
    setErrKind(null);
    try {
      const list = await apiWrongQuestions(subject.id);
      if (!mountedRef.current || request !== requestRef.current) return;
      setRows(list);
    } catch (e) {
      if (!mountedRef.current || request !== requestRef.current) return;
      setErr(locale === "ko" && e instanceof Error ? e.message : t("problems.wrong.loadFailed"));
      setErrKind("load");
    } finally {
      if (mountedRef.current && request === requestRef.current) setLoading(false);
    }
  }

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || uploading) return;
    const requestedSubjectId = subject.id;
    setUploading(true);
    setStatus("");
    setErr("");
    setErrKind(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const { added } = await apiExtractWrong(requestedSubjectId, fd);
      if (!mountedRef.current || subjectIdRef.current !== requestedSubjectId) return;
      setStatus(t("problems.wrong.registered", {
        count: t(added === 1 ? "problems.count.one" : "problems.count.many", {
          count: formatNumber(added),
        }),
      }));
      await load();
    } catch (error) {
      if (!mountedRef.current || subjectIdRef.current !== requestedSubjectId) return;
      setErr(locale === "ko" && error instanceof Error ? error.message : t("problems.wrong.uploadFailed"));
      setErrKind("upload");
    } finally {
      if (mountedRef.current && subjectIdRef.current === requestedSubjectId) setUploading(false);
    }
  }

  async function doAnalyze() {
    if (analyzing || rows.length === 0) return;
    const requestedSubjectId = subject.id;
    setAnalyzing(true);
    setErr("");
    setErrKind(null);
    try {
      const { analysis: result } = await apiAnalyzeWrong(requestedSubjectId);
      if (!mountedRef.current || subjectIdRef.current !== requestedSubjectId) return;
      setAnalysis(result);
    } catch (error) {
      if (!mountedRef.current || subjectIdRef.current !== requestedSubjectId) return;
      setErr(locale === "ko" && error instanceof Error ? error.message : t("problems.wrong.analyzeFailed"));
      setErrKind("analyze");
    } finally {
      if (mountedRef.current && subjectIdRef.current === requestedSubjectId) setAnalyzing(false);
    }
  }

  function toggleExpand(id: number) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const noteCount = rows.filter(q => q.from_wrong_note === 1).length;

  return (
    <div className="wrong-wrap">
      <div className="wrong-summary">
        {noteCount > 0
          ? t("problems.wrong.summaryWithPhoto", {
            count: formatNumber(rows.length),
            photoCount: formatNumber(noteCount),
          })
          : t("problems.wrong.summary", { count: formatNumber(rows.length) })}
      </div>

      <div className="wrong-actions">
        <button className="btn primary sm" onClick={onRelearn} disabled={rows.length === 0}>
          {t("problems.wrong.relearn")}
        </button>
        <label className={`wrong-file-label${uploading ? " disabled" : ""}`}>
          {t(uploading ? "problems.wrong.uploading" : "problems.wrong.upload")}
          <input
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.webp,.gif,application/pdf,image/jpeg,image/png,image/webp,image/gif"
            onChange={onFileChange}
            disabled={uploading}
          />
        </label>
        <button className="btn sm" onClick={doAnalyze} disabled={analyzing || rows.length === 0}>
          {t("problems.wrong.analyze")}
        </button>
        {uploading && <AiPending label={t("problems.wrong.extracting")} />}
        {analyzing && <AiPending label={t("problems.wrong.analyzing")} />}
        {status && <span className="quiz-status-msg ok" role="status" aria-live="polite">{status}</span>}
      </div>

      {err && (
        <div className="chat-err" role="alert" style={{ marginBottom: 12 }}>
          {err}
          {errKind === "load" && (
            <button type="button" onClick={() => void load()}>{t("problems.wrong.retryLoad")}</button>
          )}
          {errKind === "analyze" && (
            <button type="button" onClick={() => void doAnalyze()}>{t("problems.wrong.retryAnalyze")}</button>
          )}
          {errKind === "upload" && <span>{t("problems.wrong.reselectFile")}</span>}
        </div>
      )}

      {analysis && (
        <div className="wrong-analysis">
          <Md text={analysis} />
        </div>
      )}

      {loading && rows.length === 0 && (
        <div className="quiz-status-msg" role="status" aria-live="polite" style={{ marginTop: 16 }}>
          {t("problems.bank.loading")}
        </div>
      )}

      {rows.length > 0 && (
        <div className="wrong-list">
          {rows.map(q => (
            <div className="wrong-row" key={q.id}>
              <div className="wrong-row-top">
                <span className="q-chip qtype">{qtypeLabel(q.qtype, t)}</span>
                <span className={`q-chip diff-${q.difficulty}`}>{difficultyLabel(q.difficulty, t)}</span>
                <button
                  type="button"
                  className="wrong-q-text"
                  onClick={() => toggleExpand(q.id)}
                  aria-expanded={expanded.has(q.id)}
                  aria-controls={`wrong-detail-${q.id}`}
                  title={t("problems.wrong.detailsTitle")}
                ><MdInlineText text={q.question} /></button>
                <div className="wrong-row-meta">
                  {q.from_wrong_note === 1 && (
                    <span className="wrong-note-badge">{t("problems.wrong.photoBadge")}</span>
                  )}
                  <span className="wrong-count-chip">
                    {t("problems.wrong.wrongCount", { count: formatNumber(q.wrong_count) })}
                  </span>
                </div>
              </div>
              <div className="wrong-row-detail" id={`wrong-detail-${q.id}`} hidden={!expanded.has(q.id)}>
                {expanded.has(q.id) && (
                  <>
                  <Md className="quiz-row-full-q" text={q.question} />
                  {q.choices && (
                    <ol className="quiz-row-choices">
                      {q.choices.map((c, i) => <li key={i}><MdInline text={c} /></li>)}
                    </ol>
                  )}
                  <div className="quiz-row-answer">
                    {t("problems.run.answer")} <strong><MdInline text={q.answer} /></strong>
                  </div>
                  {q.explanation && <Md className="quiz-row-explanation" text={q.explanation} />}
                  {q.src_file_id && q.has_figure === 1 && (
                    <img
                      className="quiz-figure compact"
                      width={1200}
                      height={900}
                      src={pageImageUrl(q.src_file_id, q.src_page, q.figure_box)}
                      alt={figureAlt(q.figure_description, q.src_page, undefined, t, formatNumber)}
                      loading="lazy"
                    />
                  )}
                  {q.src_file_id && (
                    <a className="q-chip qtype" href={bookFileUrl(q.src_file_id, q.src_page)} target="_blank" rel="noreferrer">
                      {t("problems.run.originalView")}
                      {q.src_page ? ` p.${formatNumber(q.src_page)}` : ""}
                    </a>
                  )}
                  <div className="wrong-attempt-meta">
                    {t(q.last_attempted_at
                      ? "problems.wrong.attemptLast"
                      : "problems.wrong.attemptNever", {
                      correct: formatNumber(q.correct_count),
                      wrong: formatNumber(q.wrong_count),
                      ...(q.last_attempted_at
                        ? {
                          date: formatDate(q.last_attempted_at, {
                            dateStyle: "medium",
                            timeStyle: "short",
                          }),
                        }
                        : {}),
                    })}
                  </div>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && rows.length === 0 && (
        <div className="quiz-empty">{t("problems.wrong.empty")}</div>
      )}
    </div>
  );
}
