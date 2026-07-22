// ChatPanel.tsx — 튜터 채팅 패널 (SubjectDetail에서 순수 이동)
// 메시지 목록(msgs)은 헤더 카운트 표시 때문에 부모 소유, 입력·모드·컨텍스트 선택은 여기 소유.
import { useState, useEffect, useRef, KeyboardEvent, Dispatch, SetStateAction } from "react";
import { Subject, Material, Message, AIStatus, chat, cancelChat, messages as apiMessages } from "../api";
import { Md } from "../md";
import { AiPending } from "../Pending";
import SourcePicker from "./SourcePicker";
import { learnerEffortLabel, learnerModelLabel } from "./AISettingsPanel";

// 채팅 컨텍스트 자료 선택(제외 집합) 과목별 영속 — 서버 재시작·새로고침에도 유지
const chatExclKey = (subjectId: number) => `studywork:chat-excl:${subjectId}`;
const pendingChatKey = (subjectId: number) => `studywork:chat-pending:${subjectId}`;

interface PendingChat {
  message: string;
  beforeId: number;
  startedAt: number;
}

function storedPendingChat(subjectId: number): PendingChat | null {
  try {
    const value = JSON.parse(localStorage.getItem(pendingChatKey(subjectId)) ?? "null") as Partial<PendingChat> | null;
    return value
      && typeof value.message === "string"
      && Number.isSafeInteger(value.beforeId)
      && typeof value.startedAt === "number"
      ? value as PendingChat
      : null;
  } catch {
    return null;
  }
}

function storedChatExcl(subjectId: number): Set<number> {
  try {
    const raw = JSON.parse(localStorage.getItem(chatExclKey(subjectId)) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((id) => Number.isSafeInteger(id)) : []);
  } catch {
    return new Set();
  }
}

interface Props {
  subject: Subject;
  msgs: Message[];
  setMsgs: Dispatch<SetStateAction<Message[]>>;
  readyMats: Material[];
  aiRuntime: AIStatus | "unavailable" | null;
  active: boolean;
  loading?: boolean;
}

export default function ChatPanel({ subject, msgs, setMsgs, readyMats, aiRuntime, active, loading = false }: Props) {
  const [chatInput, setChatInput] = useState("");
  const [chatMode, setChatMode] = useState<"materials" | "general">("materials");
  // 채팅 컨텍스트 자료 선택 — 제외 집합, 과목별 localStorage 영속 (기본 전체)
  const [chatExcl, setChatExcl] = useState<Set<number>>(() => storedChatExcl(subject.id));
  const [recoveringChat, setRecoveringChat] = useState<PendingChat | null>(() => storedPendingChat(subject.id));
  const [busy, setBusy] = useState(() => storedPendingChat(subject.id) !== null);
  const [cancelling, setCancelling] = useState(false);
  const [chatErr, setChatErr] = useState("");
  const [chatNotice, setChatNotice] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const restoreComposerRef = useRef(false);
  const mountedRef = useRef(true);
  const cancelRequestedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    if (busy || !active || !restoreComposerRef.current) return;
    const focused = document.activeElement as HTMLElement | null;
    if (focused === document.body || focused?.closest(".chat-input-row")) composerRef.current?.focus();
    restoreComposerRef.current = false;
  }, [active, busy]);
  useEffect(() => {
    setChatExcl(storedChatExcl(subject.id));
    const pending = storedPendingChat(subject.id);
    setRecoveringChat(pending);
    setBusy(pending !== null);
    setCancelling(false);
  }, [subject.id]);

  useEffect(() => {
    if (!recoveringChat) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const loaded = await apiMessages(subject.id);
        if (stopped || !mountedRef.current) return;
        const userIndex = loaded.findIndex(message =>
          message.id > recoveringChat.beforeId
          && message.role === "user"
          && message.content === recoveringChat.message
        );
        if (userIndex >= 0 && loaded.slice(userIndex + 1).some(message => message.role === "assistant")) {
          localStorage.removeItem(pendingChatKey(subject.id));
          setMsgs(loaded);
          setRecoveringChat(null);
          setBusy(false);
          setChatErr("");
          setChatNotice("새로고침 전 답변을 이어받았습니다.");
          return;
        }
        if (Date.now() - recoveringChat.startedAt > 10 * 60 * 1000) {
          localStorage.removeItem(pendingChatKey(subject.id));
          setRecoveringChat(null);
          setBusy(false);
          setChatInput(recoveringChat.message);
          setChatErr("이전 답변 상태를 확인하지 못했습니다. 질문을 다시 보내 주세요.");
          return;
        }
      } catch {
        if (!stopped && mountedRef.current) setChatErr("이전 답변 상태를 다시 확인하고 있습니다.");
      }
      timer = window.setTimeout(poll, 2500);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [recoveringChat, setMsgs, subject.id]);

  // 보이는 채팅에서만 마지막 메시지로 이동한다. 모션 축소 설정이면 즉시 이동한다.
  useEffect(() => {
    if (!active) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    chatEndRef.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
  }, [msgs, busy, active]);

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
    restoreComposerRef.current = Boolean((document.activeElement as HTMLElement | null)?.closest(".chat-input-row"));
    setChatInput("");
    setChatErr("");
    setChatNotice("");
    cancelRequestedRef.current = false;
    const pending: PendingChat = {
      message: msg,
      beforeId: msgs.reduce((max, item) => Math.max(max, item.id), 0),
      startedAt: Date.now(),
    };
    try { localStorage.setItem(pendingChatKey(subject.id), JSON.stringify(pending)); } catch {}
    const optimistic: Message = { id: Date.now(), role: "user", content: msg, mode: chatMode, created_at: new Date().toISOString() };
    setMsgs(prev => [...prev, optimistic]);
    setBusy(true);
    try {
      const { reply } = await chat(subject.id, msg, chatMode, chatMatIds);
      try { localStorage.removeItem(pendingChatKey(subject.id)); } catch {}
      if (!mountedRef.current) return;
      const asst: Message = { id: Date.now() + 1, role: "assistant", content: reply, mode: chatMode, created_at: new Date().toISOString() };
      setMsgs(prev => [...prev, asst]);
    } catch (err) {
      if (!mountedRef.current) return;
      try { localStorage.removeItem(pendingChatKey(subject.id)); } catch {}
      setMsgs(prev => prev.filter(m => m.id !== optimistic.id));
      setChatInput(msg);
      if (!cancelRequestedRef.current) setChatErr(err instanceof Error ? err.message : "오류 발생");
    } finally {
      cancelRequestedRef.current = false;
      if (mountedRef.current) { setBusy(false); setCancelling(false); }
    }
  }

  async function stopChat() {
    if (!busy || cancelling) return;
    cancelRequestedRef.current = true;
    setCancelling(true);
    setChatErr("");
    try {
      await cancelChat(subject.id);
      setChatNotice("답변 생성을 중단했습니다.");
      if (recoveringChat) {
        try { localStorage.removeItem(pendingChatKey(subject.id)); } catch {}
        setChatInput(recoveringChat.message);
        setRecoveringChat(null);
        setBusy(false);
        setCancelling(false);
      }
    } catch (error) {
      cancelRequestedRef.current = false;
      if (mountedRef.current) {
        setCancelling(false);
        setChatErr(error instanceof Error ? error.message : "답변 생성을 중단하지 못했습니다.");
      }
    }
  }

  function onChatKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
  }

  const runtime = aiRuntime !== null && aiRuntime !== "unavailable" ? aiRuntime : null;
  const runtimeSummary = runtime?.state === "ready"
    ? `${learnerModelLabel(runtime.model)} · ${learnerEffortLabel(runtime.reasoningEffort)}`
    : runtime?.state === "rollback"
      ? "이전 방식으로 실행 중"
      : "설정 확인 필요";

  return (
    <>
      <div className="chat-log" role="log" aria-live="polite" aria-relevant="additions text">
        {msgs.length === 0 && !busy && (loading
          ? <AiPending label="대화 불러오는 중" />
          : <div className="chat-empty">자료를 올리고 질문해 보세요.</div>)}
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
              <button type="button" className="btn sm" onClick={() => void stopChat()} disabled={cancelling}>
                {cancelling ? "중단 중…" : "답변 중단"}
              </button>
            </div>
          </div>
        )}
        {chatErr && <div className="chat-err" role="alert">{chatErr}</div>}
        {chatNotice && <div className="quiz-status-msg" role="status" aria-live="polite">{chatNotice}</div>}
        <div ref={chatEndRef} />
      </div>
      <div className="chat-mode-row">
        <button
          className={`mode-chip${chatMode === "materials" ? " active" : ""}`}
          aria-pressed={chatMode === "materials"}
          onClick={() => setChatMode("materials")}
        >자료 기반</button>
        <button
          className={`mode-chip${chatMode === "general" ? " active" : ""}`}
          aria-pressed={chatMode === "general"}
          onClick={() => setChatMode("general")}
        >일반 질문</button>
        {runtime ? (
          <details
            className={`ai-config-badge${runtime.state !== "ready" ? " warning" : ""}`}
            aria-live="polite"
          >
            <summary className="clickable">AI · {runtimeSummary}</summary>
            <small>이 기기에서 실행 · {learnerModelLabel(runtime.model)} · 검토 깊이 {learnerEffortLabel(runtime.reasoningEffort)}</small>
          </details>
        ) : (
          <span className="ai-config-badge" aria-live="polite">
            {aiRuntime === null ? "AI 설정 확인 중…" : "AI 설정 확인 불가"}
          </span>
        )}
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
          ref={composerRef}
          className="chat-textarea"
          name="chat-question"
          autoComplete="off"
          placeholder={chatMode === "materials"
            ? "예: 이 자료의 핵심 공식을 설명해 줘…"
            : "예: 푸리에 변환을 쉽게 설명해 줘…"}
          value={chatInput}
          onChange={e => setChatInput(e.target.value)}
          onKeyDown={onChatKey}
          aria-label="채팅 질문"
          rows={1}
          disabled={busy}
        />
        <button className="send-btn" aria-label="질문 보내기" onClick={sendChat} disabled={busy || !chatInput.trim()}>↑</button>
      </div>
    </>
  );
}
