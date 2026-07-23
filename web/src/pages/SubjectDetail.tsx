// SubjectDetail.tsx — 과목 상세 탭 셸: 헤더·자료 목록 로드·탭 전환·해설 탭.
// 채팅은 ChatPanel, 사이드바는 MaterialsSidebar, 노트는 NotesPanel로 분리(순수 이동).

import { useState, useEffect, useRef } from "react";
import {
  Subject, Material, Message, Book,
  materials as apiMaterials,
  messages as apiMessages,
  AIStatus, aiStatus as apiAIStatus,
  books as apiBooks, uploadBookExplanations, aiJob as apiAIJob, cancelAIJob, NotFoundError,
  missingExplanations as apiMissingExplanations, generateExplanations as apiGenerateExplanations,
  subjectJobs as apiSubjectJobs, type SubjectJob,
  type MissingExplanationGroup,
} from "../api";
import JobTray from "../JobTray";
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

// AI 해설 채우기 작업 추적 — 이제 대상(target)별로 여러 작업을 동시에 굴린다.
// sessionStorage에는 [{id, target}] 목록을 저장한다 (구버전 단일 숫자도 읽는다).
const explanationJobsKey = (subjectId: number) => `studywork:explanation-gen:${subjectId}`;

export interface TrackedExplanationJob { id: number; target: string }

export function explanationTargetOf(scope: { srcFileId?: number; manual?: boolean }): string {
  return scope.srcFileId ? `file:${scope.srcFileId}` : scope.manual ? "manual" : "all";
}

export function storedExplanationJobs(subjectId: number): TrackedExplanationJob[] {
  try {
    const raw = window.sessionStorage.getItem(explanationJobsKey(subjectId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "number") {
      return Number.isSafeInteger(parsed) && parsed > 0 ? [{ id: parsed, target: "" }] : [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is TrackedExplanationJob => {
      if (typeof entry !== "object" || entry === null) return false;
      const { id, target } = entry as { id?: unknown; target?: unknown };
      return typeof id === "number" && Number.isSafeInteger(id) && id > 0 && typeof target === "string";
    });
  } catch {
    return [];
  }
}

function writeStoredExplanationJobs(subjectId: number, jobs: TrackedExplanationJob[]): void {
  try {
    if (jobs.length === 0) window.sessionStorage.removeItem(explanationJobsKey(subjectId));
    else window.sessionStorage.setItem(explanationJobsKey(subjectId), JSON.stringify(jobs));
  } catch {}
}

export function explanationGroupLabel(group: Pick<MissingExplanationGroup, "src_file_id" | "src_file_name">): string {
  return group.src_file_id ? (group.src_file_name ?? `파일 #${group.src_file_id}`) : "직접 생성·기타";
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
  // AI 해설 채우기 — 출처별 빈 해설 집계 + 대상별 다중 작업 추적
  const [missingGroups, setMissingGroups] = useState<MissingExplanationGroup[]>([]);
  const [missingErr, setMissingErr] = useState("");
  const [explJobs, setExplJobs] = useState<TrackedExplanationJob[]>(() => storedExplanationJobs(subject.id));
  const [explStatuses, setExplStatuses] = useState<string[]>([]);
  const [explStartingTargets, setExplStartingTargets] = useState<Set<string>>(new Set());
  // 작업 트레이 — 과목 전체 진행 작업 목록 (탭과 무관하게 표시)
  const [trayJobs, setTrayJobs] = useState<SubjectJob[]>([]);
  const [trayFetchedAt, setTrayFetchedAt] = useState(() => Date.now());
  const [cancellingJobIds, setCancellingJobIds] = useState<Set<number>>(new Set());
  const trayRequestRef = useRef(0);

  // 언마운트 후 setState 방지 가드
  const mountedRef = useRef(true);
  const subjectIdRef = useRef(subject.id);
  const matsPendingRef = useRef<Map<number, Promise<void>>>(new Map());
  const booksRequestRef = useRef(0);
  const solutionUploadRequestRef = useRef(0);
  const missingRequestRef = useRef(0);
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
    setMissingGroups([]);
    setMissingErr("");
    setExplJobs(storedExplanationJobs(subject.id));
    setExplStatuses([]);
    setExplStartingTargets(new Set());
    booksRequestRef.current++;
    solutionUploadRequestRef.current++;
    missingRequestRef.current++;
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
    if (tab === "solution") {
      void loadBooks(subject.id);
      void loadMissing(subject.id);
    }
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

  // AI 해설 채우기 작업 폴링 — 추적 목록의 모든 작업을 한 주기에 확인하고,
  // 끝난 작업만 목록·sessionStorage에서 제거한다. 다른 작업 행은 계속 돈다.
  useEffect(() => {
    if (explJobs.length === 0) return;
    const polledSubjectId = subject.id;
    const ids = explJobs.map((job) => job.id);
    let stopped = false;
    let timer: number | undefined;
    const check = async () => {
      const finished: number[] = [];
      const messages: string[] = [];
      for (const jobId of ids) {
        try {
          const job = await apiAIJob<{ filled: number; skippedMismatch: number; skippedIds: number[] }>(jobId);
          if (stopped || !mountedRef.current) return;
          if (job.subject_id !== polledSubjectId || job.kind !== "explanation-generate") {
            finished.push(jobId);
            messages.push("이 과목의 해설 생성 작업이 아닙니다. 다시 시도해 주세요.");
            continue;
          }
          if (job.status === "processing") continue;
          finished.push(jobId);
          if (job.status === "ready") {
            const filled = job.result?.filled ?? 0;
            const skipped = job.result?.skippedMismatch ?? 0;
            messages.push(
              `해설 ${filled}개를 채웠습니다.${skipped > 0 ? ` 정답 불일치 ${skipped}개는 저장하지 않았습니다.` : ""}`
            );
          } else {
            messages.push(job.error === "사용자 중단" ? "해설 생성을 중단했습니다." : job.error ?? "AI 해설 생성에 실패했습니다.");
          }
        } catch (error) {
          if (stopped || !mountedRef.current) return;
          if (error instanceof NotFoundError) {
            finished.push(jobId);
            messages.push("이전 해설 생성 작업을 찾을 수 없습니다. 다시 시도해 주세요.");
          }
          // 일시적 네트워크 오류는 다음 주기에 다시 확인한다.
        }
      }
      if (finished.length > 0) {
        const remaining = storedExplanationJobs(polledSubjectId).filter((job) => !finished.includes(job.id));
        writeStoredExplanationJobs(polledSubjectId, remaining);
        if (!stopped && mountedRef.current && subjectIdRef.current === polledSubjectId) {
          setExplJobs((current) => current.filter((job) => !finished.includes(job.id)));
          if (messages.length > 0) setExplStatuses((prev) => [...prev, ...messages].slice(-3));
          void loadJobs(polledSubjectId);
          await loadMissing(polledSubjectId);
          await loadBooks(polledSubjectId);
        }
      }
      if (stopped) return;
      timer = window.setTimeout(check, 2500);
    };
    void check();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [explJobs, subject.id]);

  // 작업 트레이 폴링 — 과목 화면이 열려 있는 동안 5초마다 목록 갱신
  useEffect(() => {
    setTrayJobs([]);
    void loadJobs(subject.id);
    const t = setInterval(() => void loadJobs(subject.id), 5000);
    return () => clearInterval(t);
  }, [subject.id]);

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
  async function loadJobs(subjectId = subject.id) {
    if (subjectIdRef.current !== subjectId) return;
    const request = ++trayRequestRef.current;
    try {
      const list = await apiSubjectJobs(subjectId);
      if (!mountedRef.current || subjectIdRef.current !== subjectId || request !== trayRequestRef.current) return;
      setTrayJobs(list);
      setTrayFetchedAt(Date.now());
    } catch {
      // 트레이는 보조 표시 — 실패는 다음 폴링 주기가 자연히 재시도한다.
    }
  }

  async function cancelTrayJob(jobId: number) {
    if (cancellingJobIds.has(jobId)) return;
    setCancellingJobIds((prev) => new Set(prev).add(jobId));
    try {
      await cancelAIJob(jobId);
    } catch {
      // 취소 실패 시 행이 그대로 남아 다시 시도할 수 있다.
    } finally {
      if (mountedRef.current) {
        setCancellingJobIds((prev) => {
          const next = new Set(prev);
          next.delete(jobId);
          return next;
        });
        void loadJobs();
      }
    }
  }

  async function loadMissing(subjectId = subject.id) {
    if (subjectIdRef.current !== subjectId) return;
    const request = ++missingRequestRef.current;
    try {
      const groups = await apiMissingExplanations(subjectId);
      if (!mountedRef.current || subjectIdRef.current !== subjectId || request !== missingRequestRef.current) return;
      setMissingGroups(groups);
      setMissingErr("");
    } catch (error) {
      if (!mountedRef.current || subjectIdRef.current !== subjectId || request !== missingRequestRef.current) return;
      setMissingErr(error instanceof Error ? error.message : "해설 현황을 불러오지 못했습니다.");
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

  // 대상별 시작 — 같은 대상만 잠그고 다른 대상은 언제든 함께 시작할 수 있다.
  async function startExplanationFill(scope: { srcFileId?: number; manual?: boolean }) {
    const target = explanationTargetOf(scope);
    if (explTargetBusy(target)) return;
    const requestedSubjectId = subject.id;
    setExplStartingTargets((prev) => new Set(prev).add(target));
    try {
      const job = await apiGenerateExplanations(requestedSubjectId, scope);
      writeStoredExplanationJobs(requestedSubjectId, [
        ...storedExplanationJobs(requestedSubjectId).filter((tracked) => tracked.id !== job.jobId),
        { id: job.jobId, target },
      ]);
      if (!mountedRef.current || subjectIdRef.current !== requestedSubjectId) return;
      setExplJobs(storedExplanationJobs(requestedSubjectId));
      void loadJobs(requestedSubjectId);
    } catch (error) {
      if (mountedRef.current && subjectIdRef.current === requestedSubjectId) {
        setExplStatuses((prev) => [
          ...prev,
          error instanceof Error ? error.message : "AI 해설 생성을 시작하지 못했습니다.",
        ].slice(-3));
      }
    } finally {
      if (mountedRef.current) {
        setExplStartingTargets((prev) => {
          const next = new Set(prev);
          next.delete(target);
          return next;
        });
      }
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
  const missingTotal = missingGroups.reduce((sum, group) => sum + group.missing, 0);
  // 실행 중 대상 = 이 탭이 추적하는 작업 ∪ 서버 목록(다른 탭·창에서 시작한 작업 포함)
  const trayExplTargets = new Set(
    trayJobs
      .filter((job) => job.kind === "explanation-generate" && job.status === "processing")
      .map((job) => job.target ?? "")
  );
  function explTargetBusy(target: string): boolean {
    return explStartingTargets.has(target)
      || explJobs.some((job) => job.target === target)
      || trayExplTargets.has(target);
  }
  const explRunningCount = new Set([...explJobs.map((job) => job.target), ...trayExplTargets]).size;

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

      {/* 작업 트레이 — 어느 탭에 있어도 진행 중 AI 작업이 보인다 */}
      <JobTray
        jobs={trayJobs}
        fetchedAt={trayFetchedAt}
        cancellingIds={cancellingJobIds}
        onCancel={(jobId) => void cancelTrayJob(jobId)}
      />

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
            {TAB_ORDER.map((t, i) => (
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
                <span className="tab-num">{String(i + 1).padStart(2, "0")}</span>
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

              {/* AI 해설 채우기 — 해설 PDF가 없을 때 AI가 직접 풀어 검산 후 저장 */}
              <div className="expl-gen">
                <div className="solution-head">
                  <h2>AI로 해설 채우기</h2>
                  <p>해설이 빈 문제를 AI가 직접 풀고, 도출한 정답이 등록된 정답과 일치할 때만 저장합니다.</p>
                </div>
                {missingErr && (
                  <p className="solution-status" role="alert">
                    {missingErr} <button type="button" className="btn sm" onClick={() => void loadMissing()}>해설 현황 다시 불러오기</button>
                  </p>
                )}
                {!missingErr && missingTotal === 0 && (
                  <p className="expl-gen-empty">해설이 빈 문제가 없습니다.</p>
                )}
                {missingTotal > 0 && (
                  <div className="expl-gen-list">
                    {missingGroups.length > 1 && (
                      <div className="expl-gen-row">
                        <span className="expl-gen-name">전체</span>
                        <span className="expl-gen-count">해설 없는 문제 {missingTotal}개</span>
                        <button
                          type="button"
                          className="btn sm"
                          disabled={explTargetBusy("all")}
                          onClick={() => void startExplanationFill({})}
                        >{explTargetBusy("all") ? "생성 중…" : "AI로 채우기"}</button>
                      </div>
                    )}
                    {missingGroups.map((group) => {
                      const scope = group.src_file_id ? { srcFileId: group.src_file_id } : { manual: true };
                      const busy = explTargetBusy(explanationTargetOf(scope));
                      return (
                        <div className="expl-gen-row" key={group.src_file_id ?? 0}>
                          <span className="expl-gen-name">{explanationGroupLabel(group)}</span>
                          <span className="expl-gen-count">해설 없는 문제 {group.missing}개</span>
                          <button
                            type="button"
                            className="btn sm"
                            disabled={busy}
                            onClick={() => void startExplanationFill(scope)}
                          >{busy ? "생성 중…" : "AI로 채우기"}</button>
                        </div>
                      );
                    })}
                  </div>
                )}
                {explRunningCount > 0 && (
                  <AiPending
                    label={`AI 해설 생성 ${explRunningCount}건 진행 중 · 다른 탭으로 이동해도 계속됩니다. 중단은 위 작업 목록에서`}
                  />
                )}
                {explStatuses.map((status, index) => (
                  <p
                    key={`${index}-${status}`}
                    className={status.includes("채웠습니다") ? "solution-status ok" : "solution-status"}
                    role={status.includes("채웠습니다") || status.includes("중단했습니다") ? "status" : "alert"}
                  >
                    {status}
                  </p>
                ))}
              </div>
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
