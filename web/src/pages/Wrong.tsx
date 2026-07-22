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
import { AiPending } from "../Pending";
import { figureAlt, qtypeLabel } from "./Quiz";

interface Props {
  subject: Subject;
  active: boolean;
  onRelearn: () => void; // "틀린 문제 바로 풀기" → 퀴즈 뷰로 전환 + 오답만 즉시 출제
}

export default function WrongPanel({ subject, active, onRelearn }: Props) {
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
      setErr(e instanceof Error ? e.message : "오답 불러오기 실패");
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
      setStatus(`${added}문제 등록됨`);
      await load();
    } catch (error) {
      if (!mountedRef.current || subjectIdRef.current !== requestedSubjectId) return;
      setErr(error instanceof Error ? error.message : "오답 사진 등록 실패");
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
      setErr(error instanceof Error ? error.message : "약점 분석 실패");
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
        오답 <strong>{rows.length}</strong>문제{noteCount > 0 ? ` · 사진 등록 ${noteCount}` : ""}
      </div>

      <div className="wrong-actions">
        <button className="btn primary sm" onClick={onRelearn} disabled={rows.length === 0}>
          틀린 문제 바로 풀기
        </button>
        <label className={`wrong-file-label${uploading ? " disabled" : ""}`}>
          {uploading ? "사진 분석 중…" : "오답 사진 등록"}
          <input
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.webp,.gif,application/pdf,image/jpeg,image/png,image/webp,image/gif"
            onChange={onFileChange}
            disabled={uploading}
          />
        </label>
        <button className="btn sm" onClick={doAnalyze} disabled={analyzing || rows.length === 0}>
          약점 분석
        </button>
        {uploading && <AiPending label="오답 사진에서 문제 추출 중" />}
        {analyzing && <AiPending label="오답 패턴 분석 중" />}
        {status && <span className="quiz-status-msg ok" role="status" aria-live="polite">{status}</span>}
      </div>

      {err && (
        <div className="chat-err" role="alert" style={{ marginBottom: 12 }}>
          {err}
          {errKind === "load" && <button type="button" onClick={() => void load()}>오답 다시 불러오기</button>}
          {errKind === "analyze" && <button type="button" onClick={() => void doAnalyze()}>약점 분석 다시 시도</button>}
          {errKind === "upload" && <span> · 파일을 다시 선택해 주세요.</span>}
        </div>
      )}

      {analysis && (
        <div className="wrong-analysis">
          <Md text={analysis} />
        </div>
      )}

      {loading && rows.length === 0 && <div className="quiz-status-msg" role="status" aria-live="polite" style={{ marginTop: 16 }}>불러오는 중…</div>}

      {rows.length > 0 && (
        <div className="wrong-list">
          {rows.map(q => (
            <div className="wrong-row" key={q.id}>
              <div className="wrong-row-top">
                <span className="q-chip qtype">{qtypeLabel(q.qtype)}</span>
                <span className={`q-chip diff-${q.difficulty}`}>{q.difficulty}</span>
                <button
                  type="button"
                  className="wrong-q-text"
                  onClick={() => toggleExpand(q.id)}
                  aria-expanded={expanded.has(q.id)}
                  aria-controls={`wrong-detail-${q.id}`}
                  title="클릭하면 정답·해설 보기"
                ><MdInlineText text={q.question} /></button>
                <div className="wrong-row-meta">
                  {q.from_wrong_note === 1 && <span className="wrong-note-badge">사진 등록</span>}
                  <span className="wrong-count-chip">오답 {q.wrong_count}</span>
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
                  <div className="quiz-row-answer">정답: <strong><MdInline text={q.answer} /></strong></div>
                  {q.explanation && <Md className="quiz-row-explanation" text={q.explanation} />}
                  {q.src_file_id && q.has_figure === 1 && (
                    <img
                      className="quiz-figure compact"
                      width={1200}
                      height={900}
                      src={pageImageUrl(q.src_file_id, q.src_page, q.figure_box)}
                      alt={figureAlt(q.figure_description, q.src_page)}
                      loading="lazy"
                    />
                  )}
                  {q.src_file_id && (
                    <a className="q-chip qtype" href={bookFileUrl(q.src_file_id, q.src_page)} target="_blank" rel="noreferrer">
                      원본 보기{q.src_page ? ` p.${q.src_page}` : ""}
                    </a>
                  )}
                  <div className="wrong-attempt-meta">
                    정답 {q.correct_count} · 오답 {q.wrong_count}
                    {q.last_attempted_at
                      ? ` · 마지막 시도 ${new Date(q.last_attempted_at).toLocaleString("ko-KR")}`
                      : " · 아직 안 풀어봄"}
                  </div>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && rows.length === 0 && (
        <div className="quiz-empty">오답이 없습니다. 퀴즈를 풀거나 오답 사진을 등록하세요.</div>
      )}
    </div>
  );
}
