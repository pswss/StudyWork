// NotesPanel.tsx — 단권화 노트 패널 (SubjectDetail에서 순수 이동)
// 노트 로드·버전 기록·수동 편집·단권화 실행·청크 렌더까지 노트 탭 전체를 소유한다.
// AI 노트 HTML은 md.tsx의 공통 DOMPurify 경계를 거쳐 렌더·다운로드한다.
import { useState, useEffect, useRef } from "react";
import { useEscape } from "../escape";
import {
  Subject, Material, Note,
  consolidate as apiConsolidate, cancelConsolidate as apiCancelConsolidate,
  note as apiNote, updateNote as apiUpdateNote,
  deleteNote as apiDeleteNote, deleteNoteVersion as apiDeleteNoteVersion,
  NoteVersion, noteVersions as apiNoteVersions, noteVersion as apiNoteVersion,
} from "../api";
import { mdHtml, splitMarkdownChunks, escapeHtmlText } from "../md";
import { AiPending } from "../Pending";
import SourcePicker from "./SourcePicker";

interface Props {
  subject: Subject;
  readyMats: Material[];
  active: boolean; // 노트 탭이 보이는 동안만 로드
  onBack: () => void;
  onError: (message: string) => void; // 페이지 상단 공용 오류 표시(부모 loadErr)
}

export default function NotesPanel({ subject, readyMats, active, onBack, onError }: Props) {
  const [currentNote, setCurrentNote] = useState<Note | null | undefined>(undefined);
  const [instr, setInstr] = useState("");
  const [versions, setVersions] = useState<NoteVersion[]>([]);
  const [viewVersion, setViewVersion] = useState<{ id: number; content: string; created_at: string } | null>(null); // null = 현재 노트
  const [editMode, setEditMode] = useState(false);
  const [editText, setEditText] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [exclMats, setExclMats] = useState<Set<number>>(new Set());
  const [renderedNote, setRenderedNote] = useState<{
    source: string;
    chunks: string[];
    total: number;
    complete: boolean;
  }>({
    source: "",
    chunks: [],
    total: 0,
    complete: true,
  });

  // ESC: 노트 편집부터 닫는다 (App의 뒤로가기보다 우선)
  useEscape(editMode, () => setEditMode(false));
  const mountedRef = useRef(true);
  const subjectIdRef = useRef(subject.id);
  const noteRequestRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    subjectIdRef.current = subject.id;
    noteRequestRef.current++;
    setCurrentNote(undefined);
    setVersions([]);
    setViewVersion(null);
    setExclMats(new Set());
  }, [subject.id]);

  useEffect(() => {
    if (active && currentNote === undefined) void loadNote(subject.id);
  }, [active, subject.id, currentNote]);

  // 단권화는 서버 백그라운드 — processing이면 5초마다 노트 상태 갱신
  const consolidating = currentNote?.status === "processing";
  useEffect(() => {
    if (!consolidating) return;
    const t = setInterval(loadNote, 5000);
    return () => clearInterval(t);
  }, [consolidating, subject.id]);

  async function loadNote(subjectId = subject.id) {
    const request = ++noteRequestRef.current;
    try {
      const [n, vs] = await Promise.all([
        apiNote(subjectId),
        apiNoteVersions(subjectId),
      ]);
      if (
        !mountedRef.current
        || subjectIdRef.current !== subjectId
        || request !== noteRequestRef.current
      ) return;
      setCurrentNote(n);
      setVersions(vs);
    } catch (err) {
      if (
        mountedRef.current
        && subjectIdRef.current === subjectId
        && request === noteRequestRef.current
      ) onError(err instanceof Error ? err.message : "노트 불러오기 실패");
    }
  }

  // 기록 셀렉트에서 버전 선택 (빈 값 = 현재)
  async function selectVersion(idStr: string) {
    if (!idStr) { setViewVersion(null); return; }
    try {
      const v = await apiNoteVersion(Number(idStr));
      if (mountedRef.current) setViewVersion(v);
    } catch (err) {
      alert(err instanceof Error ? err.message : "기록 불러오기 실패");
    }
  }

  // 보고 있는 내용을 .html 파일로 저장 — KaTeX 수식이 렌더된 상태 그대로 보이게 (MD는 수식이 원문으로 남음)
  function downloadHtml() {
    const content = viewVersion ? viewVersion.content : currentNote?.content;
    if (!content) return;
    const stamp = (viewVersion?.created_at ?? new Date().toISOString()).slice(0, 10);
    const title = `${subject.name} 단권화 ${stamp}`;
    const htmlTitle = escapeHtmlText(title);
    const html =
      `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${htmlTitle}</title>` +
      `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">` +
      `<style>:root{color-scheme:dark}body{max-width:72ch;margin:2rem auto;padding:0 1rem;background:#0e0e10;color:#edeae0;font-family:-apple-system,'Apple SD Gothic Neo',sans-serif;font-size:16px;line-height:1.85}h1,h2,h3{color:#edeae0}h2{margin:34px 0 14px;padding-bottom:8px;border-bottom:1px solid rgba(237,234,224,.14)}h3{margin:30px 0 12px;padding-top:24px;border-top:1px solid rgba(237,234,224,.28)}p{margin:0 0 15px}.katex:has(>math[display="block"]){display:block;box-sizing:border-box;width:100%;margin:24px 0;padding:16px 24px;overflow-x:auto;text-align:center;border:1px solid rgba(237,234,224,.28);border-radius:4px;background:rgba(217,255,63,.035)}.katex:has(>math[display="block"])+.katex:has(>math[display="block"]){margin-top:32px}.katex:has(>math[display="block"])>math[display="block"]{margin:0 auto}strong{color:#edeae0;font-weight:700}em{color:#d9ff3f;font-style:normal;font-weight:600}mark{padding:.05em .28em;border-radius:3px;background:#d9ff3f;color:#0e0e10;font-weight:700}blockquote{margin:18px 0;padding:13px 16px;border:1px solid rgba(224,163,54,.38);border-radius:6px;color:#edeae0;background:rgba(224,163,54,.08)}blockquote p:last-child{margin-bottom:0}table{border-collapse:collapse;width:100%;margin:18px 0}td,th{border:1px solid rgba(237,234,224,.14);padding:9px 14px;text-align:left;font-size:13.5px}th{color:#edeae0;background:#0b0b0d;font-weight:600}tbody tr:nth-child(even){background:rgba(217,255,63,.025)}ul,ol{padding-left:22px;margin-bottom:15px}li{margin-bottom:5px}li::marker{color:#d9ff3f}code,pre{background:#0b0b0d;border:1px solid rgba(237,234,224,.14);border-radius:4px}code{padding:1px 6px;color:#d9ff3f}pre{padding:16px 18px;overflow-x:auto}pre code{border:0;padding:0;color:rgba(237,234,224,.62)}hr{border:0;border-top:1px solid rgba(237,234,224,.14);margin:24px 0}</style>` +
      `</head><body>${mdHtml(content)}</body></html>`;
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${title}.html`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // consolidate — 서버 백그라운드로 실행되고 note.status 폴링으로 완료를 감지한다.
  // 소스 선택: 자료. 제외 집합 방식 — 기본 전체 포함, 새로 올린 것도 자동 포함
  const selMatIds = readyMats.filter(m => !exclMats.has(m.id)).map(m => m.id);
  const srcCount = readyMats.length;

  function toggleMat(id: number) {
    setExclMats(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  function setVisibleMats(ids: number[], included: boolean) {
    setExclMats(prev => {
      const next = new Set(prev);
      for (const id of ids) included ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function doConsolidate() {
    if (selMatIds.length === 0) { alert("단권화할 자료를 하나 이상 선택하세요."); return; }
    setEditMode(false);
    try {
      await apiConsolidate(subject.id, instr, selMatIds, []);
      if (!mountedRef.current) return;
      setInstr("");
      await loadNote(subject.id); // status=processing 반영 → 폴링 시작
    } catch (err) {
      alert(err instanceof Error ? err.message : "단권화 실패");
    }
  }

  // note manual edit — 기록을 보던 중이면 그 내용을 바탕으로 수정 (저장 시 현재 노트 + 새 기록)
  function startEdit() {
    const content = viewVersion ? viewVersion.content : currentNote?.content;
    if (!content) return;
    setEditText(content);
    setEditMode(true);
  }
  async function saveNote() {
    const content = editText.trim();
    if (!content || savingNote) return;
    setSavingNote(true);
    try {
      await apiUpdateNote(subject.id, content);
      if (!mountedRef.current) return;
      setCurrentNote({ content, updated_at: new Date().toISOString(), status: "ready", progress: 100 });
      setViewVersion(null); // 저장하면 현재 노트를 본다
      setEditMode(false);
      void loadNote(subject.id); // 기록 목록 갱신
    } catch (err) {
      alert(err instanceof Error ? err.message : "저장 실패");
    } finally {
      if (mountedRef.current) setSavingNote(false);
    }
  }

  const displayedNoteContent = viewVersion?.content ?? currentNote?.content ?? "";
  useEffect(() => {
    if (!displayedNoteContent) {
      setRenderedNote({ source: "", chunks: [], total: 0, complete: true });
      return;
    }
    let cancelled = false;
    let timer = 0;
    let next = 0;
    const sourceChunks = splitMarkdownChunks(displayedNoteContent);
    setRenderedNote({ source: displayedNoteContent, chunks: [], total: sourceChunks.length, complete: false });

    // 한 조각씩 브라우저에 제어권을 돌려줘 KaTeX·DOMPurify가 긴 단일 메인 스레드 작업이 되지 않게 한다.
    const renderNext = () => {
      if (cancelled) return;
      const html = mdHtml(sourceChunks[next]);
      next++;
      setRenderedNote(previous => previous.source === displayedNoteContent
        ? {
            ...previous,
            chunks: [...previous.chunks, html],
            complete: next >= sourceChunks.length,
          }
        : previous);
      if (next < sourceChunks.length) timer = window.setTimeout(renderNext, 0);
    };
    timer = window.setTimeout(renderNext, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [displayedNoteContent]);
  const noteRenderPending = Boolean(displayedNoteContent) && renderedNote.source !== displayedNoteContent;

  return (
    <div className="note-wrap" style={{ display: "flex", flexDirection: "column", flex: 1 }}>
      {consolidating ? (
        <div className="note-spinning" style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12, alignItems: "center", justifyContent: "center" }}>
          <AiPending label={`단권화 진행 중 ${currentNote?.progress ?? 0}% · 이 화면을 나가도 계속됩니다`} />
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn sm primary" onClick={onBack}>다른 과목 선택</button>
            <button
              className="btn sm"
              onClick={async () => {
                if (!confirm("단권화를 중단할까요?")) return;
                await apiCancelConsolidate(subject.id);
                await loadNote(subject.id);
              }}
            >중단</button>
          </div>
        </div>
      ) : editMode && currentNote ? (
        <>
          <div className="note-header">
            <span className="note-updated">노트 수정 (마크다운)</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn sm primary" onClick={saveNote} disabled={savingNote || !editText.trim()}>
                {savingNote ? "저장 중..." : "저장"}
              </button>
              <button className="btn sm" onClick={() => setEditMode(false)} disabled={savingNote}>취소</button>
            </div>
          </div>
          <textarea
            className="note-editor"
            value={editText}
            onChange={e => setEditText(e.target.value)}
            spellCheck={false}
          />
        </>
      ) : currentNote ? (
        <>
          {currentNote.status === "error" && !viewVersion && (
            <div className="chat-err" style={{ marginBottom: 10 }}>
              단권화 실패 — "새로 단권화"로 재시도해 주세요
            </div>
          )}
          <div className="note-header">
            <span className="note-updated">
              {viewVersion
                ? `기록: ${new Date(viewVersion.created_at).toLocaleString("ko-KR")}`
                : `업데이트: ${new Date(currentNote.updated_at).toLocaleString("ko-KR")}`}
            </span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {versions.length > 0 && (
                <select
                  className="quiz-select"
                  aria-label="단권화 기록"
                  value={viewVersion?.id ?? ""}
                  onChange={e => selectVersion(e.target.value)}
                >
                  <option value="">현재 노트</option>
                  {versions.map(v => (
                    <option key={v.id} value={v.id}>
                      {new Date(v.created_at).toLocaleString("ko-KR")} ({Math.round(v.len / 1000)}k자)
                    </option>
                  ))}
                </select>
              )}
              <button className="btn sm" onClick={downloadHtml}>HTML 저장</button>
              <button className="btn sm" onClick={startEdit}>수정</button>
              <button
                className="btn sm"
                onClick={() => {
                  if (confirm("새 기록으로 추가됩니다 (기존 기록은 보존). 단권화를 실행할까요?")) doConsolidate();
                }}
              >새로 단권화</button>
              {viewVersion ? (
                <button
                  className="btn sm"
                  onClick={async () => {
                    if (!confirm("이 기록을 삭제할까요?")) return;
                    await apiDeleteNoteVersion(viewVersion.id);
                    setViewVersion(null);
                    await loadNote(subject.id);
                  }}
                >기록 삭제</button>
              ) : (
                <button
                  className="btn sm"
                  onClick={async () => {
                    if (!confirm("현재 노트와 모든 단권화 기록을 삭제합니다. 계속할까요?")) return;
                    await apiDeleteNote(subject.id);
                    noteRequestRef.current++;
                    setCurrentNote(null);
                    setVersions([]);
                    setViewVersion(null);
                  }}
                >노트 삭제</button>
              )}
            </div>
          </div>
          {srcCount > 0 && (
            <SourcePicker
              label="단권화 소스"
              materials={readyMats}
              excluded={exclMats}
              onToggle={toggleMat}
              onSetVisible={setVisibleMats}
            />
          )}
          <input
            className="text-input instr-input"
            placeholder="추가 요청 (선택) — 예: 공식 위주로, 3단원은 빼줘"
            value={instr}
            onChange={e => setInstr(e.target.value)}
          />
          {noteRenderPending ? (
            <div className="note-rendering"><AiPending label="노트 표시 준비 중" /></div>
          ) : (
            <>
              {!renderedNote.complete && (
                <div className="note-render-progress" aria-live="polite">
                  노트 표시 중 {renderedNote.chunks.length}/{renderedNote.total}
                </div>
              )}
              <div className="note-content">
                {renderedNote.chunks.map((html, index) => (
                  <section
                    className="note-render-chunk"
                    key={index}
                    dangerouslySetInnerHTML={{ __html: html }}
                  />
                ))}
              </div>
            </>
          )}
        </>
      ) : (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
          <div className="note-empty">자료를 올리고 단권화를 실행하세요.</div>
          {srcCount > 0 && (
            <SourcePicker
              label="단권화 소스"
              materials={readyMats}
              excluded={exclMats}
              onToggle={toggleMat}
              onSetVisible={setVisibleMats}
            />
          )}
          <textarea
            className="text-input"
            style={{ maxWidth: 420, width: "100%" }}
            rows={2}
            placeholder="추가 요청 (선택) — 예: 공식 위주로 정리해줘"
            value={instr}
            onChange={e => setInstr(e.target.value)}
          />
          <button
            className="btn primary"
            onClick={doConsolidate}
            disabled={selMatIds.length === 0}
          >
            단권화 실행
          </button>
        </div>
      )}
    </div>
  );
}
