// SubjectDetail.tsx — 과목 상세 탭 셸: 헤더·자료 목록 로드·탭 전환·해설 탭.
// 채팅은 ChatPanel, 사이드바는 MaterialsSidebar, 노트는 NotesPanel로 분리(순수 이동).

import { useState, useEffect, useRef } from "react";
import {
  Subject, Material, Message, Book,
  materials as apiMaterials,
  messages as apiMessages,
  AIStatus, aiStatus as apiAIStatus,
  books as apiBooks, uploadBookExplanations, aiJob as apiAIJob, cancelAIJob, NotFoundError,
} from "../api";
import Quiz from "./Quiz";
import WrongPanel from "./Wrong";
import Exam from "./Exam";
import AISettingsPanel from "./AISettingsPanel";
import ChatPanel from "./ChatPanel";
import MaterialsSidebar, { uploadValidationError } from "./MaterialsSidebar";
import NotesPanel from "./NotesPanel";
import { Reveal } from "../motion";
import { AiPending } from "../Pending";
import { subjectsUrl } from "../route-url";

export { uploadValidationError }; // 기존 테스트·소비처 호환 재수출

interface Props {
  subject: Subject;
  onBack: () => void;
  initialTab?: SubjectTab;
  onTabChange?: (tab: SubjectTab) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export type SubjectTab = "chat" | "quiz" | "solution" | "exam" | "note" | "settings";

const TAB_ORDER: SubjectTab[] = ["chat", "quiz", "solution", "exam", "note", "settings"];
const TAB_LABELS: Record<SubjectTab, string> = {
  chat: "채팅", quiz: "퀴즈", solution: "해설", exam: "시험", note: "노트", settings: "설정",
};

const solutionJobKey = (subjectId: number) => `studywork:solution-job:${subjectId}`;

export function storedSolutionJob(subjectId: number): number | null {
  try {
    const id = Number(window.localStorage.getItem(solutionJobKey(subjectId)));
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

export default function SubjectDetail({ subject, onBack, initialTab = "chat", onTabChange, onDirtyChange }: Props) {
  const [mats, setMats] = useState<Material[]>([]);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [tab, setTab] = useState<SubjectTab>(initialTab);
  const [materialsLoading, setMaterialsLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(true);
  // 퀴즈 탭 보조 뷰(문제 은행 / 오답 노트) + 오답 즉시 출제 트리거 카운터
  const [quizView, setQuizView] = useState<"bank" | "wrong">(() =>
    new URLSearchParams(window.location.search).get("quizView") === "wrong" ? "wrong" : "bank"
  );
  const [wrongKick, setWrongKick] = useState(0);
  const [aiRuntime, setAIRuntime] = useState<AIStatus | "unavailable" | null>(null);
  const [materialsErr, setMaterialsErr] = useState("");
  const [messagesErr, setMessagesErr] = useState("");
  const [bookList, setBookList] = useState<Book[]>([]);
  const [solutionBookId, setSolutionBookId] = useState<number | null>(null);
  const [solutionUploading, setSolutionUploading] = useState(false);
  const [solutionCancelling, setSolutionCancelling] = useState(false);
  const [solutionJob, setSolutionJob] = useState<{ subjectId: number; id: number } | null>(() => {
    const id = storedSolutionJob(subject.id);
    return id === null ? null : { subjectId: subject.id, id };
  });
  const [solutionStatus, setSolutionStatus] = useState("");
  const [solutionBooksLoading, setSolutionBooksLoading] = useState(false);
  const [solutionBooksError, setSolutionBooksError] = useState("");

  // 언마운트 후 setState 방지 가드
  const mountedRef = useRef(true);
  const subjectIdRef = useRef(subject.id);
  const matsPendingRef = useRef<Map<number, Promise<void>>>(new Map());
  const booksRequestRef = useRef(0);
  const solutionUploadRequestRef = useRef(0);
  const solutionJobId = solutionJob?.subjectId === subject.id ? solutionJob.id : null;
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    subjectIdRef.current = subject.id;
    setTab(initialTab);
    setQuizView(new URLSearchParams(window.location.search).get("quizView") === "wrong" ? "wrong" : "bank");
    setMats([]);
    setMsgs([]);
    setMaterialsLoading(true);
    setMessagesLoading(true);
    setBookList([]);
    setSolutionBookId(null);
    const storedJobId = storedSolutionJob(subject.id);
    setSolutionJob((current) => {
      if (storedJobId === null) return null;
      return current?.subjectId === subject.id && current.id === storedJobId
        ? current
        : { subjectId: subject.id, id: storedJobId };
    });
    setSolutionStatus("");
    setSolutionBooksLoading(false);
    setSolutionBooksError("");
    setMaterialsErr("");
    setMessagesErr("");
    setSolutionUploading(false);
    setSolutionCancelling(false);
    booksRequestRef.current++;
    solutionUploadRequestRef.current++;
    void loadMats(subject.id);
  }, [subject.id]);
  useEffect(() => { void loadMsgs(subject.id); }, [subject.id]);
  useEffect(() => { setTab(initialTab); }, [initialTab]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (quizView === "wrong") params.set("quizView", "wrong"); else params.delete("quizView");
    window.history.replaceState(null, "", `${window.location.pathname}?${params}${window.location.hash}`);
  }, [quizView]);
  useEffect(() => {
    apiAIStatus("chat")
      .then((status) => { if (mountedRef.current) setAIRuntime(status); })
      .catch(() => { if (mountedRef.current) setAIRuntime("unavailable"); });
  }, []);
  // 추출은 서버 백그라운드에서 진행 — 자료 추출 중이거나 문제 추출 중이면 5초마다 상태 갱신
  const matsProcessing = mats.some(m => m.status === "processing" || m.book_status === "processing");
  useEffect(() => {
    if (!matsProcessing) return;
    const t = setInterval(loadMats, 5000);
    return () => clearInterval(t);
  }, [matsProcessing, subject.id]);
  useEffect(() => {
    if (tab === "solution") void loadBooks(subject.id);
  }, [tab, subject.id]);

  // 다른 브라우저 탭에서 시작한 작업도 같은 과목 화면에서 즉시 이어서 확인한다.
  useEffect(() => {
    const key = solutionJobKey(subject.id);
    const syncJob = (event: StorageEvent) => {
      if (event.key !== key || event.newValue === null) return;
      const id = Number(event.newValue);
      if (Number.isSafeInteger(id) && id > 0) {
        setSolutionJob((current) => current?.subjectId === subject.id && current.id === id
          ? current
          : { subjectId: subject.id, id });
        setSolutionStatus("");
      }
    };
    window.addEventListener("storage", syncJob);
    return () => window.removeEventListener("storage", syncJob);
  }, [subject.id]);

  useEffect(() => {
    if (solutionJob === null || solutionJob.subjectId !== subject.id) return;
    const jobId = solutionJob.id;
    const polledSubjectId = solutionJob.subjectId;
    const key = solutionJobKey(polledSubjectId);
    let stopped = false;
    let timer: number | undefined;
    const check = async () => {
      try {
        const job = await apiAIJob<{ updated: number }>(jobId);
        if (stopped || !mountedRef.current) return;
        if (job.subject_id !== polledSubjectId || job.kind !== "book-explanations") {
          try { window.localStorage.removeItem(key); } catch {}
          setSolutionJob(null);
          setSolutionStatus("이 과목의 해설 추가 작업이 아닙니다. 다시 업로드해 주세요.");
          return;
        }
        if (job.status === "processing") {
          setSolutionStatus("");
          timer = window.setTimeout(check, 2500);
          return;
        }
        try { window.localStorage.removeItem(key); } catch {}
        setSolutionJob(null);
        if (job.status === "ready") {
          setSolutionStatus(`해설 ${job.result?.updated ?? 0}개를 추가했습니다.`);
          await loadBooks(polledSubjectId);
        } else {
          setSolutionStatus(job.error === "사용자 중단" ? "해설 분석을 중단했습니다." : job.error ?? "해설 추가에 실패했습니다.");
        }
      } catch (error) {
        if (stopped || !mountedRef.current) return;
        if (error instanceof NotFoundError) {
          try { window.localStorage.removeItem(key); } catch {}
          setSolutionJob(null);
          setSolutionStatus("이전 해설 추가 작업을 찾을 수 없습니다. 다시 업로드해 주세요.");
          return;
        }
        setSolutionStatus(error instanceof Error
          ? `${error.message} · 작업 상태를 다시 확인합니다.`
          : "해설 작업 상태를 확인하지 못했습니다. 다시 확인합니다.");
        timer = window.setTimeout(check, 5000);
      }
    };
    void check();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [solutionJob, subject.id]);

  // 탭 전환 시 3D 조형물에 활성 인덱스를 알린다.
  function selectTab(t: SubjectTab) {
    setTab(t);
    onTabChange?.(t);
  }

  async function loadMats(subjectId = subject.id, refreshAfterPending = false) {
    const pending = matsPendingRef.current.get(subjectId);
    if (pending) {
      await pending;
      if (refreshAfterPending) await loadMats(subjectId);
      return;
    }
    if (mountedRef.current && subjectIdRef.current === subjectId) setMaterialsLoading(true);
    const request = (async () => {
      try {
        const m = await apiMaterials(subjectId);
        if (mountedRef.current && subjectIdRef.current === subjectId) {
          setMats(m);
          setMaterialsErr("");
        }
      } catch (err) {
        if (mountedRef.current && subjectIdRef.current === subjectId) {
          setMaterialsErr(err instanceof Error ? err.message : "자료 불러오기 실패");
        }
      } finally {
        if (mountedRef.current && subjectIdRef.current === subjectId) setMaterialsLoading(false);
      }
    })();
    matsPendingRef.current.set(subjectId, request);
    try {
      await request;
    } finally {
      if (matsPendingRef.current.get(subjectId) === request) {
        matsPendingRef.current.delete(subjectId);
      }
    }
  }
  async function loadBooks(subjectId = subject.id) {
    if (subjectIdRef.current !== subjectId) return;
    const request = ++booksRequestRef.current;
    setSolutionBooksLoading(true);
    setSolutionBooksError("");
    try {
      const next = await apiBooks(subjectId);
      if (
        !mountedRef.current
        || subjectIdRef.current !== subjectId
        || request !== booksRequestRef.current
      ) return;
      setBookList(next);
      setSolutionBookId((current) =>
        current !== null && next.some((book) => book.id === current && book.question_count > 0)
          ? current
          : next.find((book) => book.question_count > 0)?.id ?? null
      );
    } catch (error) {
      if (
        mountedRef.current
        && subjectIdRef.current === subjectId
        && request === booksRequestRef.current
      ) {
        setSolutionBooksError(error instanceof Error ? error.message : "문제집을 불러오지 못했습니다.");
      }
    } finally {
      if (
        mountedRef.current
        && subjectIdRef.current === subjectId
        && request === booksRequestRef.current
      ) setSolutionBooksLoading(false);
    }
  }
  async function loadMsgs(subjectId = subject.id) {
    if (mountedRef.current && subjectIdRef.current === subjectId) setMessagesLoading(true);
    try {
      const m = await apiMessages(subjectId);
      if (mountedRef.current && subjectIdRef.current === subjectId) {
        setMsgs(m);
        setMessagesErr("");
      }
    } catch (err) {
      if (mountedRef.current && subjectIdRef.current === subjectId) {
        setMessagesErr(err instanceof Error ? err.message : "대화 불러오기 실패");
      }
    } finally {
      if (mountedRef.current && subjectIdRef.current === subjectId) setMessagesLoading(false);
    }
  }

  async function onSolutionFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || solutionBookId === null || solutionUploading || solutionJobId !== null) return;
    const validationError = uploadValidationError(file);
    if (validationError) {
      setSolutionStatus(`${file.name}: ${validationError}`);
      return;
    }
    const requestedSubjectId = subject.id;
    const requestedBookId = solutionBookId;
    const request = ++solutionUploadRequestRef.current;
    setSolutionUploading(true);
    setSolutionStatus("");
    try {
      const form = new FormData();
      form.append("file", file);
      const job = await uploadBookExplanations(requestedSubjectId, requestedBookId, form);
      try { window.localStorage.setItem(solutionJobKey(requestedSubjectId), String(job.jobId)); } catch {}
      if (
        !mountedRef.current
        || subjectIdRef.current !== requestedSubjectId
        || request !== solutionUploadRequestRef.current
      ) return;
      setSolutionJob({ subjectId: requestedSubjectId, id: job.jobId });
    } catch (error) {
      if (
        mountedRef.current
        && subjectIdRef.current === requestedSubjectId
        && request === solutionUploadRequestRef.current
      ) {
        setSolutionStatus(error instanceof Error ? error.message : "해설 업로드에 실패했습니다.");
      }
    } finally {
      if (
        mountedRef.current
        && subjectIdRef.current === requestedSubjectId
        && request === solutionUploadRequestRef.current
      ) setSolutionUploading(false);
    }
  }

  async function stopSolutionJob() {
    if (solutionJobId === null || solutionCancelling) return;
    setSolutionCancelling(true);
    setSolutionStatus("");
    try {
      await cancelAIJob(solutionJobId);
      setSolutionStatus("해설 분석 중단 요청을 보냈습니다.");
    } catch (error) {
      setSolutionStatus(error instanceof Error ? error.message : "해설 분석을 중단하지 못했습니다.");
    } finally {
      if (mountedRef.current) setSolutionCancelling(false);
    }
  }

  const readyMats = mats.filter(m => m.status === "ready");
  const matCount = mats.length;
  const msgCount = msgs.length;
  const solutionBooks = bookList.filter((book) => book.question_count > 0);
  const selectedSolutionBook = solutionBooks.find((book) => book.id === solutionBookId) ?? null;

  return (
    <div className="page detail-page">
      <div className="detail-header">
        <a
          className="back-btn"
          href={subjectsUrl()}
          onClick={event => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            onBack();
          }}
          aria-label="과목 목록으로 이동"
        >
          <span className="back-arrow" aria-hidden="true">←</span>
          <span className="back-word">과목 목록</span>
        </a>
        <div className="detail-head-main">
          <Reveal delay={0.1} as="h1" className="detail-title">{subject.name}</Reveal>
        </div>
        <span className="detail-meta">자료 {matCount} · 대화 {msgCount}</span>
      </div>

      {materialsErr && (
        <div className="chat-err" role="alert">
          {materialsErr} <button type="button" onClick={() => void loadMats()}>자료 다시 불러오기</button>
        </div>
      )}
      {messagesErr && (
        <div className="chat-err" role="alert">
          {messagesErr} <button type="button" onClick={() => void loadMsgs()}>대화 다시 불러오기</button>
        </div>
      )}

      <details className="context-help subject-guide">
        <summary>처음 사용하는 분을 위한 순서</summary>
        <p>자료를 먼저 추가한 뒤 채팅이나 퀴즈로 확인하고, 필요할 때 노트와 시험 계획을 만드세요. 해설 탭에서는 문제집과 같은 책의 공식 해설을 연결할 수 있습니다.</p>
      </details>

      <div className="detail-grid">
        {/* ===== sidebar ===== */}
        <MaterialsSidebar
          subject={subject}
          mats={mats}
          loading={materialsLoading}
          reloadMats={(subjectId) => loadMats(subjectId, true)}
        />

        {/* ===== main area ===== */}
        <div className="main-panel">
          <div
            className="tabs"
            role="tablist"
            onKeyDown={e => {
              // WAI-ARIA tabs: 좌우 화살표로 이동 (roving tabindex)
              if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) return;
              e.preventDefault();
              const next = e.key === "Home"
                ? 0
                : e.key === "End"
                  ? TAB_ORDER.length - 1
                  : (TAB_ORDER.indexOf(tab) + (e.key === "ArrowRight" ? 1 : -1) + TAB_ORDER.length) % TAB_ORDER.length;
              selectTab(TAB_ORDER[next]);
              (e.currentTarget.children[next] as HTMLElement | undefined)?.focus();
            }}
          >
            {TAB_ORDER.map((t) => (
              <button
                key={t}
                id={`subject-tab-${t}`}
                role="tab"
                aria-selected={tab === t}
                aria-controls={`subject-panel-${t}`}
                tabIndex={tab === t ? 0 : -1}
                className={`tab-index${tab === t ? " active" : ""}`}
                onClick={() => selectTab(t)}
              >
                <span className="tab-word">{TAB_LABELS[t]}</span>
              </button>
            ))}
          </div>

          <div
            id="subject-panel-chat"
            className="panel main-card"
            role="tabpanel"
            aria-labelledby="subject-tab-chat"
            hidden={tab !== "chat"}
            aria-hidden={tab !== "chat"}
          >
            <ChatPanel
              subject={subject}
              msgs={msgs}
              setMsgs={setMsgs}
              readyMats={readyMats}
              aiRuntime={aiRuntime}
              active={tab === "chat"}
              loading={messagesLoading}
            />
          </div>

          <div
            id="subject-panel-quiz"
            className="panel main-card"
            role="tabpanel"
            aria-labelledby="subject-tab-quiz"
            hidden={tab !== "quiz"}
            aria-hidden={tab !== "quiz"}
          >
            <div className="quiz-view-row">
              <button
                className={`mode-chip${quizView === "bank" ? " active" : ""}`}
                aria-pressed={quizView === "bank"}
                onClick={() => setQuizView("bank")}
              >문제 은행</button>
              <button
                className={`mode-chip${quizView === "wrong" ? " active" : ""}`}
                aria-pressed={quizView === "wrong"}
                onClick={() => setQuizView("wrong")}
              >오답 노트</button>
            </div>
            {/* Quiz는 은행·플레이 상태 유지를 위해 항상 마운트, 오답 뷰일 땐 숨긴다 */}
            <div className="quiz-subview" hidden={quizView !== "bank"}>
              <Quiz
                key={subject.id}
                subject={subject}
                materials={mats}
                active={tab === "quiz" && quizView === "bank"}
                kickWrongQuiz={wrongKick}
              />
            </div>
            {quizView === "wrong" && (
              <WrongPanel
                subject={subject}
                active={tab === "quiz" && quizView === "wrong"}
                onRelearn={() => {
                  setQuizView("bank");
                  setWrongKick(k => k + 1);
                }}
              />
            )}
          </div>

          <div
            id="subject-panel-solution"
            className="panel main-card solution-panel"
            role="tabpanel"
            aria-labelledby="subject-tab-solution"
            hidden={tab !== "solution"}
            aria-hidden={tab !== "solution"}
          >
              <div className="solution-head">
                <h2>기존 문제집에 해설 추가</h2>
                <p>문제집을 고르고 같은 책의 공식 해설 PDF나 이미지를 올리세요.</p>
              </div>
              {solutionBooksError && (
                <p className="solution-status" role="alert">
                  {solutionBooksError} <button type="button" className="btn sm" onClick={() => void loadBooks()}>문제집 다시 불러오기</button>
                </p>
              )}
              {solutionBooksLoading && solutionBooks.length === 0 ? (
                <AiPending label="문제집 불러오는 중" />
              ) : solutionBooks.length > 0 ? (
                <>
                  <label className="solution-field">
                    <span>문제집</span>
                    <select
                      className="quiz-select"
                      value={solutionBookId ?? ""}
                      onChange={(event) => setSolutionBookId(Number(event.target.value))}
                      disabled={solutionUploading || solutionJobId !== null}
                    >
                      {solutionBooks.map((book) => (
                        <option key={book.id} value={book.id}>
                          {book.title} · 해설 {book.explained_count}/{book.question_count}
                        </option>
                      ))}
                    </select>
                  </label>
                  {selectedSolutionBook && (
                    <div className="solution-summary">
                      <div>
                        <strong>{selectedSolutionBook.title}</strong>
                        <span>{selectedSolutionBook.question_count}문제 중 {selectedSolutionBook.explained_count}문제 해설 있음</span>
                      </div>
                      <progress
                        max={selectedSolutionBook.question_count}
                        value={selectedSolutionBook.explained_count}
                        aria-label="해설 등록률"
                      />
                    </div>
                  )}
                  <label className={`file-label solution-upload${solutionJobId !== null ? " disabled" : ""}`}>
                    {solutionUploading ? "업로드 중…" : solutionJobId !== null ? "해설 분석 중…" : "해설 파일 선택"}
                    <input
                      type="file"
                      accept=".pdf,.jpg,.jpeg,.png,.webp,.gif,application/pdf,image/jpeg,image/png,image/webp,image/gif"
                      onChange={onSolutionFileChange}
                      disabled={solutionUploading || solutionJobId !== null || solutionBookId === null}
                    />
                  </label>
                  <p className="solution-help">
                    문제집 문항 번호가 1번부터 빠짐없이 이어지고, 전체 해설지가 같은 순서로 모든 문항을 포함해야 합니다. 문항 수와 정답이 하나라도 다르면 기존 문제는 바꾸지 않습니다.
                  </p>
                </>
              ) : !solutionBooksError ? (
                <div className="quiz-empty">먼저 자료에서 문제 추출을 완료하세요.</div>
              ) : null}
              {solutionJobId !== null && (
                <div className="pending-action-row">
                  <AiPending label="해설 분석 중 · 새로고침하거나 다른 탭으로 이동해도 계속됩니다" />
                  <button type="button" className="btn sm" onClick={() => void stopSolutionJob()} disabled={solutionCancelling}>
                    {solutionCancelling ? "중단 중…" : "분석 중단"}
                  </button>
                </div>
              )}
              {solutionStatus && (
                <p
                  className={solutionStatus.includes("추가했습니다") ? "solution-status ok" : "solution-status"}
                  role={solutionStatus.includes("추가했습니다") || solutionStatus.includes("중단했습니다") || solutionStatus.includes("요청을 보냈습니다") ? "status" : "alert"}
                >
                  {solutionStatus}
                </p>
              )}
          </div>

          <div
            id="subject-panel-exam"
            className="panel main-card"
            role="tabpanel"
            aria-labelledby="subject-tab-exam"
            hidden={tab !== "exam"}
            aria-hidden={tab !== "exam"}
          >
            <Exam subject={subject} active={tab === "exam"} />
          </div>

          <div
            id="subject-panel-note"
            className="panel main-card"
            role="tabpanel"
            aria-labelledby="subject-tab-note"
            hidden={tab !== "note"}
            aria-hidden={tab !== "note"}
          >
            <NotesPanel
              subject={subject}
              readyMats={readyMats}
              active={tab === "note"}
              onBack={onBack}
              onDirtyChange={onDirtyChange}
            />
          </div>

          <div
            id="subject-panel-settings"
            className="panel main-card"
            role="tabpanel"
            aria-labelledby="subject-tab-settings"
            hidden={tab !== "settings"}
            aria-hidden={tab !== "settings"}
          >
              <AISettingsPanel
                onSaved={() => {
                  apiAIStatus("chat")
                    .then(status => { if (mountedRef.current) setAIRuntime(status); })
                    .catch(() => { if (mountedRef.current) setAIRuntime("unavailable"); });
                }}
              />
          </div>
        </div>
      </div>
    </div>
  );
}
