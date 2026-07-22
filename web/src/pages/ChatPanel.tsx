// ChatPanel.tsx — 튜터 채팅 패널 (SubjectDetail에서 순수 이동)
// 메시지 목록(msgs)은 헤더 카운트 표시 때문에 부모 소유, 입력·모드·컨텍스트 선택은 여기 소유.
import { useState, useEffect, useRef, KeyboardEvent, Dispatch, SetStateAction } from "react";
import { Subject, Material, Message, AIStatus, chat } from "../api";
import { Md } from "../md";
import { AiPending } from "../Pending";
import SourcePicker from "./SourcePicker";

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

interface Props {
  subject: Subject;
  msgs: Message[];
  setMsgs: Dispatch<SetStateAction<Message[]>>;
  readyMats: Material[];
  aiRuntime: AIStatus | "unavailable" | null;
}

export default function ChatPanel({ subject, msgs, setMsgs, readyMats, aiRuntime }: Props) {
  const [chatInput, setChatInput] = useState("");
  const [chatMode, setChatMode] = useState<"materials" | "general">("materials");
  // 채팅 컨텍스트 자료 선택 — 제외 집합, 과목별 localStorage 영속 (기본 전체)
  const [chatExcl, setChatExcl] = useState<Set<number>>(() => storedChatExcl(subject.id));
  const [busy, setBusy] = useState(false);
  const [chatErr, setChatErr] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => { setChatExcl(storedChatExcl(subject.id)); }, [subject.id]);

  // 탭 전환으로 다시 마운트돼도 항상 마지막 메시지가 보이게 마운트·갱신 시 스크롤
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy]);

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

  return (
    <>
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
    </>
  );
}
