// SubjectDetail.tsx — ~270 lines; split kept minimal per spec
// AI 노트 HTML은 md.tsx의 공통 DOMPurify 경계를 거쳐 렌더·다운로드한다.

import { useState, useEffect, useRef, KeyboardEvent } from "react";
import { useEscape } from "../escape";
import {
  Subject, Material, Message, Note, Book,
  materials as apiMaterials,
  uploadMaterial, retryMaterial, deleteMaterial, cancelMaterial,
  messages as apiMessages, chat,
  consolidate as apiConsolidate, cancelConsolidate as apiCancelConsolidate, note as apiNote, updateNote as apiUpdateNote,
  deleteNote as apiDeleteNote, deleteNoteVersion as apiDeleteNoteVersion,
  NoteVersion, noteVersions as apiNoteVersions, noteVersion as apiNoteVersion,
  AIStatus, aiStatus as apiAIStatus,
  retryBookFile, cancelBookFile,
  books as apiBooks, uploadBookExplanations, aiJob as apiAIJob, NotFoundError,
} from "../api";
import Quiz from "./Quiz";
import WrongPanel from "./Wrong";
import Exam from "./Exam";
import AISettingsPanel from "./AISettingsPanel";
import SourcePicker from "./SourcePicker";
import { Md, mdHtml, splitMarkdownChunks, escapeHtmlText } from "../md";
import { Reveal } from "../motion";
import { AiPending } from "../Pending";

interface Props {
  subject: Subject;
  onBack: () => void;
  onTabChange?: (index: number) => void;
}

type Tab = "chat" | "quiz" | "solution" | "exam" | "note" | "settings";

const TAB_ORDER: Tab[] = ["chat", "quiz", "solution", "exam", "note", "settings"];
const TAB_LABELS: Record<Tab, string> = {
  chat: "채팅", quiz: "퀴즈", solution: "해설", exam: "시험", note: "노트", settings: "설정",
};

const solutionJobKey = (subjectId: number) => `studywork:solution-job:${subjectId}`;

export function storedSolutionJob(subjectId: number): number | null {
  try {
    const id = Number(sessionStorage.getItem(solutionJobKey(subjectId)));
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

export function uploadValidationError(file: Pick<File, "name" | "type" | "size">): string | null {
  const lower = file.name.toLowerCase();
  const isPdf = file.type === "application/pdf" || lower.endsWith(".pdf");
  const isImage = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)
    || /\.(jpe?g|png|webp|gif)$/.test(lower);
  if (!isPdf && !isImage) return "PDF, JPEG, PNG, WebP, GIF만 지원합니다";
  const maxBytes = isPdf ? 200 * 1024 * 1024 : 30 * 1024 * 1024;
  if (file.size <= 0 || file.size > maxBytes) {
    return `${isPdf ? "200MB" : "30MB"} 이하 파일만 지원합니다`;
  }
  return null;
}

// 채팅 컨텍스트 자료 선택(제외 집합) 과목별 영속 — 서버 재시작·새로고침에도 유지
const chatExclKey = (subjectId: number) => `studywork:chat-excl:${subjectId}`;

function storedChatExcl(subjectId: number): Set<number> {
  try {
    const raw = JSON.parse(localStorage.getItem(chatExclKey(subjectId)) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((id) => Number.isSafeInteger(id)) : []);
  } catch {
    return new Set();
  }
}

export default function SubjectDetail({ subject, onBack, onTabChange }: Props) {
  const [mats, setMats] = useState<Material[]>([]);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [currentNote, setCurrentNote] = useState<Note | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>("chat");
  // 퀴즈 탭 보조 뷰(문제 은행 / 오답 노트) + 오답 즉시 출제 트리거 카운터
  const [quizView, setQuizView] = useState<"bank" | "wrong">("bank");
  const [wrongKick, setWrongKick] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const [materialActionId, setMaterialActionId] = useState<number | null>(null);
  const [showTextForm, setShowTextForm] = useState(false);
  const [textTitle, setTextTitle] = useState("");
  const [textBody, setTextBody] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [chatMode, setChatMode] = useState<"materials" | "general">("materials");
  // 채팅 컨텍스트 자료 선택 — 제외 집합, 과목별 localStorage 영속 (기본 전체)
  const [chatExcl, setChatExcl] = useState<Set<number>>(() => storedChatExcl(subject.id));
  const [aiRuntime, setAIRuntime] = useState<AIStatus | "unavailable" | null>(null);
  const [busy, setBusy] = useState(false);
  const [chatErr, setChatErr] = useState("");
  const [instr, setInstr] = useState("");
  const [versions, setVersions] = useState<NoteVersion[]>([]);
  const [viewVersion, setViewVersion] = useState<{ id: number; content: string; created_at: string } | null>(null); // null = 현재 노트
  const [editMode, setEditMode] = useState(false);
  const [editText, setEditText] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const [bookList, setBookList] = useState<Book[]>([]);
  const [solutionBookId, setSolutionBookId] = useState<number | null>(null);
  const [solutionUploading, setSolutionUploading] = useState(false);
  const [solutionJob, setSolutionJob] = useState<{ subjectId: number; id: number } | null>(() => {
    const id = storedSolutionJob(subject.id);
    return id === null ? null : { subjectId: subject.id, id };
  });
  const [solutionStatus, setSolutionStatus] = useState("");
  const [solutionBooksLoading, setSolutionBooksLoading] = useState(false);
  const [solutionBooksError, setSolutionBooksError] = useState("");
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

  // ESC: 노트 편집·텍스트 폼부터 닫는다 (App의 뒤로가기보다 우선)
  useEscape(editMode, () => setEditMode(false));
  useEscape(showTextForm, () => setShowTextForm(false));
  const chatEndRef = useRef<HTMLDivElement>(null);
  // 언마운트 후 setState 방지 가드
  const mountedRef = useRef(true);
  const subjectIdRef = useRef(subject.id);
  const matsPendingRef = useRef<Map<number, Promise<void>>>(new Map());
  const noteRequestRef = useRef(0);
  const materialActionRef = useRef<number | null>(null);
  const booksRequestRef = useRef(0);
  const solutionUploadRequestRef = useRef(0);
  const solutionJobId = solutionJob?.subjectId === subject.id ? solutionJob.id : null;
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    subjectIdRef.current = subject.id;
    noteRequestRef.current++;
    setQuizView("bank");
    setChatExcl(storedChatExcl(subject.id));
    setMats([]);
    setCurrentNote(undefined);
    setVersions([]);
    setViewVersion(null);
    setBookList([]);
    setSolutionBookId(null);
    const storedJobId = storedSolutionJob(subject.id);
    setSolutionJob(storedJobId === null ? null : { subjectId: subject.id, id: storedJobId });
    setSolutionStatus("");
    setSolutionBooksLoading(false);
    setSolutionBooksError("");
    setSolutionUploading(false);
    booksRequestRef.current++;
    solutionUploadRequestRef.current++;
    void loadMats(subject.id);
  }, [subject.id]);
  useEffect(() => { loadMsgs(); }, [subject.id]);
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
    if (tab === "note" && currentNote === undefined) void loadNote(subject.id);
  }, [tab, subject.id, currentNote]);
  useEffect(() => {
    if (tab === "solution") void loadBooks(subject.id);
  }, [tab, subject.id]);

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
          try { sessionStorage.removeItem(key); } catch {}
          setSolutionJob(null);
          setSolutionStatus("이 과목의 해설 추가 작업이 아닙니다. 다시 업로드해 주세요.");
          return;
        }
        if (job.status === "processing") {
          setSolutionStatus("");
          timer = window.setTimeout(check, 2500);
          return;
        }
        try { sessionStorage.removeItem(key); } catch {}
        setSolutionJob(null);
        if (job.status === "ready") {
          setSolutionStatus(`해설 ${job.result?.updated ?? 0}개를 추가했습니다.`);
          await loadBooks(polledSubjectId);
        } else {
          setSolutionStatus(job.error ?? "해설 추가에 실패했습니다.");
        }
      } catch (error) {
        if (stopped || !mountedRef.current) return;
        if (error instanceof NotFoundError) {
          try { sessionStorage.removeItem(key); } catch {}
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

  // 단권화는 서버 백그라운드 — processing이면 5초마다 노트 상태 갱신
  const consolidating = currentNote?.status === "processing";
  useEffect(() => {
    if (!consolidating) return;
    const t = setInterval(loadNote, 5000);
    return () => clearInterval(t);
  }, [consolidating, subject.id]);

  // 탭 전환 시 3D 조형물에 활성 인덱스를 알린다.
  function selectTab(t: Tab) {
    setTab(t);
    onTabChange?.(TAB_ORDER.indexOf(t));
  }

  async function loadMats(subjectId = subject.id, refreshAfterPending = false) {
    const pending = matsPendingRef.current.get(subjectId);
    if (pending) {
      await pending;
      if (refreshAfterPending) await loadMats(subjectId);
      return;
    }
    const request = (async () => {
      try {
        const m = await apiMaterials(subjectId);
        if (mountedRef.current && subjectIdRef.current === subjectId) {
          setMats(m);
          setLoadErr("");
        }
      } catch (err) {
        if (mountedRef.current && subjectIdRef.current === subjectId) {
          setLoadErr(err instanceof Error ? err.message : "자료 불러오기 실패");
        }
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
  async function loadMsgs() {
    try {
      const m = await apiMessages(subject.id);
      if (mountedRef.current) setMsgs(m);
    } catch (err) {
      if (mountedRef.current) setLoadErr(err instanceof Error ? err.message : "대화 불러오기 실패");
    }
  }
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
      ) setLoadErr(err instanceof Error ? err.message : "노트 불러오기 실패");
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

  // 채팅 탭으로 돌아왔을 때도 항상 마지막 메시지가 보이게 tab을 의존성에 포함
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy, tab]);

  // file upload — 여러 파일 가능. 모두 자료로 처리되고, 문제가 있으면 서버가 자동으로 문제 칸에 등록한다.
  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (files.length === 0) return;
    e.target.value = "";
    const uploadSubjectId = subject.id;
    const errors: string[] = [];
    setUploading(true);
    setUploadStatus(`0/${files.length}`);
    try {
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        const validationError = uploadValidationError(file);
        if (validationError) {
          errors.push(`${file.name}: ${validationError}`);
          if (subjectIdRef.current === uploadSubjectId) setUploadStatus(`${index + 1}/${files.length}`);
          continue;
        }
        const fd = new FormData();
        fd.append("title", file.name);
        fd.append("file", file);
        try {
          await uploadMaterial(uploadSubjectId, fd);
        } catch (error) {
          errors.push(`${file.name}: ${error instanceof Error ? error.message : "업로드 실패"}`);
        } finally {
          if (mountedRef.current && subjectIdRef.current === uploadSubjectId) {
            setUploadStatus(`${index + 1}/${files.length}`);
          }
          await loadMats(uploadSubjectId, true);
        }
      }
      if (errors.length > 0 && mountedRef.current && subjectIdRef.current === uploadSubjectId) {
        alert(errors.join("\n"));
      }
    } finally {
      if (mountedRef.current) {
        setUploading(false);
        setUploadStatus("");
      }
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
      try { sessionStorage.setItem(solutionJobKey(requestedSubjectId), String(job.jobId)); } catch {}
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

  // text upload
  async function submitText() {
    const title = textTitle.trim();
    const text = textBody.trim();
    if (!title || !text) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("title", title);
      fd.append("text", text);
      await uploadMaterial(subject.id, fd);
      if (!mountedRef.current) return;
      setTextTitle(""); setTextBody(""); setShowTextForm(false);
      await loadMats(subject.id, true);
    } catch (err) {
      alert(err instanceof Error ? err.message : "저장 실패");
    } finally {
      if (mountedRef.current) setUploading(false);
    }
  }

  async function runMaterialAction(id: number, action: () => Promise<unknown>) {
    if (materialActionRef.current !== null) return;
    materialActionRef.current = id;
    setMaterialActionId(id);
    try {
      await action();
    } catch (error) {
      alert(error instanceof Error ? error.message : "자료 작업에 실패했습니다");
    } finally {
      await loadMats(subject.id, true);
      materialActionRef.current = null;
      if (mountedRef.current) setMaterialActionId(null);
    }
  }

  // retry material
  async function retry(id: number) {
    await runMaterialAction(id, () => retryMaterial(id));
  }

  // cancel material analysis
  async function doCancelMat(id: number) {
    await runMaterialAction(id, () => cancelMaterial(id));
  }

  async function doRetryBook(id: number, fileId: number) {
    await runMaterialAction(id, () => retryBookFile(fileId));
  }

  async function doCancelBook(id: number, fileId: number) {
    await runMaterialAction(id, () => cancelBookFile(fileId));
  }

  // delete material
  async function doDeleteMat(material: Material) {
    const confirmation = prompt(
      `"${material.title}" 자료를 삭제하면 이 자료에서 추출된 문제와 원본 그림도 모두 삭제됩니다.\n\n계속하려면 "삭제"를 입력하세요.`
    );
    if (confirmation?.trim() !== "삭제") return;
    await runMaterialAction(material.id, () => deleteMaterial(material.id));
  }

  // 채팅 컨텍스트 선택 갱신 + 과목별 영속
  function updateChatExcl(update: (prev: Set<number>) => Set<number>) {
    setChatExcl(prev => {
      const next = update(prev);
      try { localStorage.setItem(chatExclKey(subject.id), JSON.stringify([...next])); } catch {}
      return next;
    });
  }

  // send chat
  async function sendChat() {
    const msg = chatInput.trim();
    if (!msg || busy) return;
    // 자료 기반 모드: 일부만 선택했으면 그 목록을 명시적으로 보낸다 (기본 전체 = 생략)
    const someExcluded = chatMode === "materials" && readyMats.some(m => chatExcl.has(m.id));
    const chatMatIds = someExcluded
      ? readyMats.filter(m => !chatExcl.has(m.id)).map(m => m.id)
      : undefined;
    if (someExcluded && chatMatIds!.length === 0) {
      setChatErr("컨텍스트로 쓸 자료를 하나 이상 선택하세요.");
      return;
    }
    setChatInput("");
    setChatErr("");
    const optimistic: Message = { id: Date.now(), role: "user", content: msg, mode: chatMode, created_at: new Date().toISOString() };
    setMsgs(prev => [...prev, optimistic]);
    setBusy(true);
    try {
      const { reply } = await chat(subject.id, msg, chatMode, chatMatIds);
      if (!mountedRef.current) return;
      const asst: Message = { id: Date.now() + 1, role: "assistant", content: reply, mode: chatMode, created_at: new Date().toISOString() };
      setMsgs(prev => [...prev, asst]);
    } catch (err) {
      if (!mountedRef.current) return;
      setMsgs(prev => prev.filter(m => m.id !== optimistic.id));
      setChatInput(msg);
      setChatErr(err instanceof Error ? err.message : "오류 발생");
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  function onChatKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
  }

  // consolidate — 서버 백그라운드로 실행되고 note.status 폴링으로 완료를 감지한다.
  // 소스 선택: 자료. 제외 집합 방식 — 기본 전체 포함, 새로 올린 것도 자동 포함
  const readyMats = mats.filter(m => m.status === "ready");
  const [exclMats, setExclMats] = useState<Set<number>>(new Set());
  const selMatIds = readyMats.filter(m => !exclMats.has(m.id)).map(m => m.id);
  const srcCount = readyMats.length;
  useEffect(() => setExclMats(new Set()), [subject.id]);

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

  function kindLabel(k: Material["kind"]) {
    return k === "image" ? "사진" : k === "pdf" ? "PDF" : "텍스트";
  }

  const matCount = mats.length;
  const msgCount = msgs.length;
  const solutionBooks = bookList.filter((book) => book.question_count > 0);
  const selectedSolutionBook = solutionBooks.find((book) => book.id === solutionBookId) ?? null;
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
    <div className="page detail-page">
      <div className="detail-header">
        <button className="back-btn" onClick={onBack} aria-label="뒤로">
          <span className="back-arrow">←</span>
          <span className="back-word">ARCHIVE</span>
        </button>
        <div className="detail-head-main">
          <Reveal delay={0.04} className="micro-label">과목 / {subject.name}</Reveal>
          <Reveal delay={0.1} as="h1" className="detail-title">{subject.name}</Reveal>
        </div>
        <span className="detail-meta">자료 {matCount} · 대화 {msgCount}</span>
      </div>

      {loadErr && <div className="chat-err">{loadErr}</div>}

      <div className="detail-grid">
        {/* ===== sidebar ===== */}
        <div className="sidebar">
          <div className="panel sidebar-panel">
            <div className="sidebar-title">자료</div>
            {matCount === 0 && <p style={{ color: "var(--ink-3)", fontSize: 13 }}>자료가 없습니다.</p>}
            <div className="mat-list">
              {mats.map(m => (
                <div className="mat-entry" key={m.id}>
                  <div className="mat-row">
                    <span className="kind-chip">{kindLabel(m.kind)}</span>
                    {m.source_type === "obsidian" && (
                      <span className="kind-chip" title={m.source_path ?? "Obsidian"}>OBS</span>
                    )}
                    <span className="mat-title" title={m.original_filename ?? m.title}>{m.title}</span>
                    {m.status === "processing" && (
                      <>
                        <span className="status-dot processing" />
                        <span className="quiz-status-msg">
                          {m.retry_chunk_count
                            ? `${m.progress}% · 오류·미완료 ${m.retry_chunk_count}개 청크만 재시도 중`
                            : `${m.progress}%`}
                        </span>
                        <button
                          className="retry-btn"
                          title="분석 중단"
                          disabled={materialActionId !== null}
                          onClick={() => doCancelMat(m.id)}
                        >중단</button>
                      </>
                    )}
                    {m.status === "ready" && (
                      <>
                        <span className="status-dot ready" />
                        {m.book_status === "processing" && (
                          <>
                            <span className="quiz-status-msg" title="문제·해설을 뽑아 문제 칸에 등록 중">
                              {m.book_retry_chunk_count && m.book_error?.includes("오류·미완료")
                                ? `문제 추출 ${m.book_progress ?? 0}% · 오류·미완료 ${m.book_retry_chunk_count}개 청크만 재시도 중`
                                : `문제 추출 ${m.book_progress ?? 0}%`}
                            </span>
                            {m.book_file_id && (
                              <button
                                className="retry-btn"
                                disabled={materialActionId !== null}
                                onClick={() => doCancelBook(m.id, m.book_file_id!)}
                              >중단</button>
                            )}
                          </>
                        )}
                        {m.book_status === "error" && m.book_file_id && (
                          <button
                            className="retry-btn"
                            title={m.book_error ?? "문제 추출 실패"}
                            disabled={materialActionId !== null}
                            onClick={() => doRetryBook(m.id, m.book_file_id!)}
                          >문제 재시도</button>
                        )}
                      </>
                    )}
                    {m.status === "error" && (
                      <>
                        <span className="status-dot error" />
                        <button
                          className="retry-btn"
                          disabled={materialActionId !== null}
                          onClick={() => retry(m.id)}
                        >재시도</button>
                      </>
                    )}
                    <button
                      className="del-btn"
                      aria-label={`${m.title} 삭제`}
                      disabled={materialActionId !== null}
                      onClick={() => doDeleteMat(m)}
                    >✕</button>
                  </div>
                  {m.status === "error" && m.error && <div className="mat-error">{m.error}</div>}
                  {m.status === "error" && Boolean(m.retry_chunk_count) && (
                    <div className="mat-warning">
                      오류·미완료 {m.retry_chunk_count}/{m.chunk_total ?? "?"}개 청크. 재시도하면 이 청크만 다시 분석합니다.
                    </div>
                  )}
                  {m.integrity_warning && !m.integrity_warning.startsWith("페이지 근거 불완전:") && (
                    <div className="mat-warning">{m.integrity_warning}</div>
                  )}
                  {m.book_status === "error" && (
                    <>
                      <div className="mat-error">{m.book_error ?? "문제 추출에 실패했습니다. 재시도해 주세요."}</div>
                      {Boolean(m.book_retry_chunk_count) && (
                        <div className="mat-warning">
                          오류·미완료 {m.book_retry_chunk_count}/{m.book_chunk_total ?? "?"}개 청크. 다음 재시도에서는 이 청크만 다시 추출합니다.
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>

            <div className="upload-area">
              <label className="file-label">
                자료 추가 (문제·해설 있으면 자동으로 문제 칸에 등록)
                <input
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png,.webp,.gif,application/pdf,image/jpeg,image/png,image/webp,image/gif"
                  multiple
                  onChange={onFileChange}
                  disabled={uploading}
                />
              </label>
              <div className="upload-help">PDF 200MB·500쪽 이하 / 이미지 30MB 이하</div>
              {uploading && <div className="upload-status">업로드 중 {uploadStatus}</div>}
              <button
                className="btn sm"
                style={{ width: "100%" }}
                onClick={() => setShowTextForm(v => !v)}
              >
                텍스트 추가
              </button>
              {showTextForm && (
                <div className="text-form">
                  <input
                    className="text-input"
                    placeholder="제목"
                    value={textTitle}
                    onChange={e => setTextTitle(e.target.value)}
                  />
                  <textarea
                    className="text-input"
                    placeholder="내용"
                    value={textBody}
                    onChange={e => setTextBody(e.target.value)}
                  />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn sm primary" style={{ flex: 1 }} onClick={submitText} disabled={uploading}>저장</button>
                    <button className="btn sm" onClick={() => setShowTextForm(false)}>취소</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ===== main area ===== */}
        <div className="main-panel">
          <div
            className="tabs"
            role="tablist"
            onKeyDown={e => {
              // WAI-ARIA tabs: 좌우 화살표로 이동 (roving tabindex)
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              e.preventDefault();
              const delta = e.key === "ArrowRight" ? 1 : -1;
              const next = (TAB_ORDER.indexOf(tab) + delta + TAB_ORDER.length) % TAB_ORDER.length;
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

          {tab === "chat" && (
            <div
              id="subject-panel-chat"
              className="panel main-card"
              key="chat"
              role="tabpanel"
              aria-labelledby="subject-tab-chat"
            >
              <div className="chat-log">
                {msgs.length === 0 && !busy && (
                  <div className="chat-empty">자료를 올리고 질문해 보세요.</div>
                )}
                {msgs.map(m => (
                  <div key={m.id} className={`chat-msg ${m.role}`}>
                    <div className="msg-bubble">
                      {m.mode && m.role === "assistant" && (
                        <span className={`msg-mode-badge ${m.mode}`}>
                          {m.mode === "materials" ? "자료 기반" : "일반"}
                        </span>
                      )}
                      {m.role === "assistant" ? <Md text={m.content} /> : m.content}
                    </div>
                  </div>
                ))}
                {busy && (
                  <div className="chat-msg assistant">
                    <div className="msg-bubble">
                      <AiPending label="AI 답변 생성 중" />
                    </div>
                  </div>
                )}
                {chatErr && <div className="chat-err">{chatErr}</div>}
                <div ref={chatEndRef} />
              </div>
              <div className="chat-mode-row">
                <button
                  className={`mode-chip${chatMode === "materials" ? " active" : ""}`}
                  onClick={() => setChatMode("materials")}
                >자료 기반</button>
                <button
                  className={`mode-chip${chatMode === "general" ? " active" : ""}`}
                  onClick={() => setChatMode("general")}
                >일반 질문</button>
                <span
                  className={`ai-config-badge${aiRuntime !== null && aiRuntime !== "unavailable" && aiRuntime.state !== "ready" ? " warning" : ""}`}
                  aria-live="polite"
                  title={aiRuntime !== null && aiRuntime !== "unavailable"
                    ? `서버 설정 · provider ${aiRuntime.provider} · effort ${aiRuntime.reasoningEffort ?? "해당 없음"}`
                    : undefined}
                >
                  {aiRuntime === null && "AI 설정 확인 중"}
                  {aiRuntime === "unavailable" && "AI 설정 확인 불가"}
                  {aiRuntime !== null && aiRuntime !== "unavailable" && aiRuntime.state === "invalid" && "AI 설정 오류"}
                  {aiRuntime !== null && aiRuntime !== "unavailable" && aiRuntime.state === "rollback" && `${aiRuntime.model} · 롤백`}
                  {aiRuntime !== null && aiRuntime !== "unavailable" && aiRuntime.state === "ready" && `${aiRuntime.model} · ${aiRuntime.reasoningEffort} · 로컬 CLI`}
                </span>
              </div>
              {chatMode === "materials" && readyMats.length > 0 && (
                <SourcePicker
                  label="채팅 컨텍스트"
                  materials={readyMats}
                  excluded={chatExcl}
                  onToggle={(id) => updateChatExcl(prev => {
                    const next = new Set(prev);
                    next.has(id) ? next.delete(id) : next.add(id);
                    return next;
                  })}
                  onSetVisible={(ids, included) => updateChatExcl(prev => {
                    const next = new Set(prev);
                    for (const id of ids) included ? next.delete(id) : next.add(id);
                    return next;
                  })}
                />
              )}
              <div className="chat-input-row">
                <textarea
                  className="chat-textarea"
                  placeholder={chatMode === "materials"
                    ? "질문을 입력하세요 (자료 기반 답변 · Enter 전송)"
                    : "질문을 입력하세요 (일반 지식 답변 · Enter 전송)"}
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={onChatKey}
                  rows={1}
                  disabled={busy}
                />
                <button className="send-btn" onClick={sendChat} disabled={busy || !chatInput.trim()}>↑</button>
              </div>
            </div>
          )}

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
                onClick={() => setQuizView("bank")}
              >문제 은행</button>
              <button
                className={`mode-chip${quizView === "wrong" ? " active" : ""}`}
                onClick={() => setQuizView("wrong")}
              >오답 노트</button>
            </div>
            {/* Quiz는 은행·플레이 상태 유지를 위해 항상 마운트, 오답 뷰일 땐 숨긴다 */}
            <div className="quiz-subview" hidden={quizView !== "bank"}>
              <Quiz
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

          {tab === "solution" && (
            <div
              id="subject-panel-solution"
              className="panel main-card solution-panel"
              role="tabpanel"
              aria-labelledby="subject-tab-solution"
            >
              <div className="solution-head">
                <h2>기존 문제집에 해설 추가</h2>
                <p>문제집을 고르고 같은 책의 공식 해설 PDF나 이미지를 올리세요.</p>
              </div>
              {solutionBooksError && (
                <p className="solution-status" role="alert">{solutionBooksError}</p>
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
                    {solutionUploading ? "업로드 중" : solutionJobId !== null ? "해설 분석 중" : "해설 파일 선택"}
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
              {solutionJobId !== null && <AiPending label="문항 순서와 정답을 확인하며 해설 추가 중" />}
              {solutionStatus && (
                <p className={solutionStatus.includes("추가했습니다") ? "solution-status ok" : "solution-status"} role="status">
                  {solutionStatus}
                </p>
              )}
            </div>
          )}

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
            </div>

          {tab === "settings" && (
            <div
              id="subject-panel-settings"
              className="panel main-card"
              key="settings"
              role="tabpanel"
              aria-labelledby="subject-tab-settings"
            >
              <AISettingsPanel
                onSaved={() => {
                  apiAIStatus("chat")
                    .then(status => { if (mountedRef.current) setAIRuntime(status); })
                    .catch(() => { if (mountedRef.current) setAIRuntime("unavailable"); });
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
