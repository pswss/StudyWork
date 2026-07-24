// ChatPanel.tsx — 튜터 채팅 패널 (SubjectDetail에서 순수 이동)
// 메시지 목록(msgs)은 헤더 카운트 표시 때문에 부모 소유, 입력·모드·컨텍스트 선택은 여기 소유.
import { useState, useEffect, useRef, KeyboardEvent, Dispatch, SetStateAction } from "react";
import {
  Subject, Material, Message, AIStatus, type AIModelSetting, type AIReasoningEffort, type AISettings,
  chat, cancelChat, messages as apiMessages,
  aiSettings as apiAISettings, updateAISettings as apiUpdateAISettings,
} from "../api";
import { Md } from "../md";
import { AiPending } from "../Pending";
import SourcePicker from "./SourcePicker";
import SingleSelectPicker from "./SingleSelectPicker";
import { learnerEffortLabel, learnerModelLabel } from "./AISettingsPanel";
import { useI18n, type MessageKey } from "../i18n";

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
  onAISettingsSaved?: () => void;
}

const CHAT_MESSAGE_KEYS = {
  recovered: "workspace.chat.recovered",
  recoveryFailed: "workspace.chat.recoveryFailed",
  recoveryRetrying: "workspace.chat.recoveryRetrying",
  selectSource: "workspace.chat.selectSource",
  error: "workspace.chat.error",
  stopped: "workspace.chat.stopped",
  stopFailed: "workspace.chat.stopFailed",
  settingsLoadError: "workspace.chat.settingsLoadError",
  settingsSaveError: "workspace.chat.settingsSaveError",
  saved: "workspace.chat.saved",
  inherited: "workspace.chat.inherited",
} as const satisfies Record<string, MessageKey>;

type ChatMessage = "" | keyof typeof CHAT_MESSAGE_KEYS;

export default function ChatPanel({
  subject,
  msgs,
  setMsgs,
  readyMats,
  aiRuntime,
  active,
  loading = false,
  onAISettingsSaved,
}: Props) {
  const { t } = useI18n();
  const modelLabel = (model: string | null) =>
    model ? learnerModelLabel(model) : t("workspace.settings.defaultModel");
  const effortLabel = (effort: string | null) =>
    effort ? learnerEffortLabel(effort) : `effort ${t("workspace.settings.automatic")}`;
  const [chatInput, setChatInput] = useState("");
  const [chatMode, setChatMode] = useState<"materials" | "general">("materials");
  // 채팅 컨텍스트 자료 선택 — 제외 집합, 과목별 localStorage 영속 (기본 전체)
  const [chatExcl, setChatExcl] = useState<Set<number>>(() => storedChatExcl(subject.id));
  const [recoveringChat, setRecoveringChat] = useState<PendingChat | null>(() => storedPendingChat(subject.id));
  const [busy, setBusy] = useState(() => storedPendingChat(subject.id) !== null);
  const [cancelling, setCancelling] = useState(false);
  const [chatErr, setChatErr] = useState<ChatMessage>("");
  const [chatNotice, setChatNotice] = useState<ChatMessage>("");
  const [chatAISettings, setChatAISettings] = useState<AISettings | null>(null);
  const [chatAISettingsSaving, setChatAISettingsSaving] = useState(false);
  const [chatAISettingsMessage, setChatAISettingsMessage] = useState<ChatMessage>("");
  const [enteringMessageIds, setEnteringMessageIds] = useState<Set<number>>(new Set());
  const chatLogRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const previousLogItemsRef = useRef(msgs.length + Number(busy));
  const enterTimersRef = useRef<Set<number>>(new Set());
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const restoreComposerRef = useRef(false);
  const mountedRef = useRef(true);
  const cancelRequestedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const timer of enterTimersRef.current) window.clearTimeout(timer);
      enterTimersRef.current.clear();
    };
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
    if (active) void loadChatAISettings();
  }, [active]);

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
          setChatNotice("recovered");
          return;
        }
        if (Date.now() - recoveringChat.startedAt > 10 * 60 * 1000) {
          localStorage.removeItem(pendingChatKey(subject.id));
          setRecoveringChat(null);
          setBusy(false);
          setChatInput(recoveringChat.message);
          setChatErr("recoveryFailed");
          return;
        }
      } catch {
        if (!stopped && mountedRef.current) setChatErr("recoveryRetrying");
      }
      timer = window.setTimeout(poll, 2500);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [recoveringChat, setMsgs, subject.id]);

  // 단일 페이지 스크롤에서 사용자가 채팅 하단을 보고 있는지 추적한다.
  useEffect(() => {
    if (!active) return;
    const updateNearBottom = () => {
      const log = chatLogRef.current;
      if (!log) return;
      nearBottomRef.current = log.getBoundingClientRect().bottom - window.innerHeight <= 120;
    };
    updateNearBottom();
    window.addEventListener("scroll", updateNearBottom, { passive: true });
    window.addEventListener("resize", updateNearBottom);
    return () => {
      window.removeEventListener("scroll", updateNearBottom);
      window.removeEventListener("resize", updateNearBottom);
    };
  }, [active]);

  // 새 항목이 생겼고 사용자가 이미 하단을 보고 있을 때만 페이지의 입력창까지 이동한다.
  // active를 의존성에서 제외해 다른 탭에서 돌아오는 동작 자체로는 스크롤하지 않는다.
  useEffect(() => {
    const nextItems = msgs.length + Number(busy);
    const added = nextItems > previousLogItemsRef.current;
    previousLogItemsRef.current = nextItems;
    if (!active || !added || !nearBottomRef.current) return;
    const composer = composerRef.current;
    if (!composer || typeof composer.scrollIntoView !== "function") return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    composer.scrollIntoView({ block: "end", behavior: reduceMotion ? "auto" : "smooth" });
  }, [msgs.length, busy]);

  function markMessageEntering(id: number) {
    if (!active) return;
    setEnteringMessageIds(current => new Set(current).add(id));
    const timer = window.setTimeout(() => {
      enterTimersRef.current.delete(timer);
      setEnteringMessageIds(current => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }, 240);
    enterTimersRef.current.add(timer);
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
      setChatErr("selectSource");
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
    markMessageEntering(optimistic.id);
    setMsgs(prev => [...prev, optimistic]);
    setBusy(true);
    try {
      const { reply } = await chat(subject.id, msg, chatMode, chatMatIds);
      try { localStorage.removeItem(pendingChatKey(subject.id)); } catch {}
      if (!mountedRef.current) return;
      const asst: Message = { id: Date.now() + 1, role: "assistant", content: reply, mode: chatMode, created_at: new Date().toISOString() };
      markMessageEntering(asst.id);
      setMsgs(prev => [...prev, asst]);
    } catch (err) {
      if (!mountedRef.current) return;
      try { localStorage.removeItem(pendingChatKey(subject.id)); } catch {}
      setMsgs(prev => prev.filter(m => m.id !== optimistic.id));
      setChatInput(msg);
      if (!cancelRequestedRef.current) setChatErr("error");
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
      setChatNotice("stopped");
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
        setChatErr("stopFailed");
      }
    }
  }

  async function loadChatAISettings() {
    setChatAISettingsMessage("");
    try {
      const settings = await apiAISettings();
      if (mountedRef.current) setChatAISettings(settings);
    } catch (error) {
      if (mountedRef.current) {
        setChatAISettingsMessage("settingsLoadError");
      }
    }
  }

  async function saveChatAISetting(next: AIModelSetting) {
    if (chatAISettingsSaving) return;
    setChatAISettingsSaving(true);
    setChatAISettingsMessage("");
    try {
      const settings = await apiUpdateAISettings({ operations: { chat: next } });
      if (!mountedRef.current) return;
      setChatAISettings(settings);
      setChatAISettingsMessage("saved");
      onAISettingsSaved?.();
    } catch (error) {
      if (mountedRef.current) {
        setChatAISettingsMessage("settingsSaveError");
      }
    } finally {
      if (mountedRef.current) setChatAISettingsSaving(false);
    }
  }

  async function inheritChatAISetting() {
    if (chatAISettingsSaving) return;
    setChatAISettingsSaving(true);
    setChatAISettingsMessage("");
    try {
      const settings = await apiUpdateAISettings({ operations: { chat: null } });
      if (!mountedRef.current) return;
      setChatAISettings(settings);
      setChatAISettingsMessage("inherited");
      onAISettingsSaved?.();
    } catch (error) {
      if (mountedRef.current) {
        setChatAISettingsMessage("settingsSaveError");
      }
    } finally {
      if (mountedRef.current) setChatAISettingsSaving(false);
    }
  }

  function onChatKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
  }

  const chatAISetting = chatAISettings?.resolved.chat ?? null;
  let chatAISettingsLabel = t("workspace.chat.checking");
  if (aiRuntime === "unavailable") chatAISettingsLabel = t("workspace.chat.unavailable");
  else if (aiRuntime?.state === "invalid") chatAISettingsLabel = t("workspace.chat.invalid");
  else if (aiRuntime?.state === "rollback") {
    chatAISettingsLabel = t("workspace.chat.rollback", {
      model: modelLabel(aiRuntime.model),
    });
  }
  else if (chatAISetting) {
    chatAISettingsLabel = `${modelLabel(chatAISetting.model)} · ${effortLabel(chatAISetting.reasoningEffort)}`;
  } else if (aiRuntime?.model) {
    chatAISettingsLabel = `${modelLabel(aiRuntime.model)} · ${effortLabel(aiRuntime.reasoningEffort)}`;
  }
  const chatAISettingsWarning = Boolean(
    chatAISettingsMessage === "settingsLoadError" || chatAISettingsMessage === "settingsSaveError"
  )
    || aiRuntime === "unavailable"
    || aiRuntime !== null && aiRuntime.state !== "ready";

  return (
    <>
      <div
        ref={chatLogRef}
        className="chat-log"
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
      >
        {msgs.length === 0 && !busy && (loading
          ? <AiPending label={t("workspace.chat.loading")} />
          : <div className="chat-empty">{t("workspace.chat.empty")}</div>)}
        {msgs.map(m => (
          <div key={m.id} className={`chat-msg ${m.role}${enteringMessageIds.has(m.id) ? " entering" : ""}`}>
            <div className="msg-bubble">
              {m.mode && m.role === "assistant" && (
                <span className={`msg-mode-badge ${m.mode}`}>
                  {m.mode === "materials" ? t("workspace.chat.materialsMode") : t("workspace.chat.generalMode")}
                </span>
              )}
              {m.role === "assistant" ? <Md text={m.content} /> : m.content}
            </div>
          </div>
        ))}
        {busy && (
          <div className="chat-msg assistant">
            <div className="msg-bubble">
              <AiPending label={t("workspace.chat.generating")} />
              <button type="button" className="btn sm" onClick={() => void stopChat()} disabled={cancelling}>
                {/* 기존 한국어 표시 계약: 답변 중단 */}
                {cancelling ? t("workspace.chat.cancelling") : t("workspace.chat.stop")}
              </button>
            </div>
          </div>
        )}
        {chatErr && <div className="chat-err" role="alert">{t(CHAT_MESSAGE_KEYS[chatErr])}</div>}
        {chatNotice && (
          <div className="quiz-status-msg" role="status" aria-live="polite">
            {t(CHAT_MESSAGE_KEYS[chatNotice])}
          </div>
        )}
      </div>
      <div className="chat-mode-row">
        <button
          className={`mode-chip${chatMode === "materials" ? " active" : ""}`}
          aria-pressed={chatMode === "materials"}
          onClick={() => setChatMode("materials")}
        >{t("workspace.chat.materialsMode")}</button>
        <button
          className={`mode-chip${chatMode === "general" ? " active" : ""}`}
          aria-pressed={chatMode === "general"}
          onClick={() => setChatMode("general")}
        >{t("workspace.chat.generalQuestion")}</button>
      </div>
      <details className="chat-ai-settings">
        <summary>
          <span>{t("workspace.chat.settings")}</span>
          <strong className={chatAISettingsWarning ? "warning" : undefined} aria-live="polite">
            {chatAISettingsLabel}
          </strong>
        </summary>
        <div className="chat-ai-settings-panel">
          {chatAISettings ? (
            <>
              <div className="chat-ai-settings-controls">
                <SingleSelectPicker
                  label={t("workspace.chat.model")}
                  value={chatAISetting!.model}
                  disabled={chatAISettingsSaving}
                  options={chatAISettings.allowedModels.map(model => ({
                    value: model,
                    label: modelLabel(model),
                    description: model,
                  }))}
                  onChange={model => void saveChatAISetting({ ...chatAISetting!, model })}
                />
                <SingleSelectPicker
                  label={t("workspace.chat.effort")}
                  value={chatAISetting!.reasoningEffort}
                  disabled={chatAISettingsSaving}
                  options={chatAISettings.allowedEfforts.map((effort: AIReasoningEffort) => ({
                    value: effort,
                    label: effortLabel(effort),
                  }))}
                  onChange={reasoningEffort => void saveChatAISetting({
                    ...chatAISetting!,
                    reasoningEffort: reasoningEffort as AIReasoningEffort,
                  })}
                />
              </div>
              {chatAISettings.overrides.chat && (
                <button className="btn sm" type="button" onClick={() => void inheritChatAISetting()} disabled={chatAISettingsSaving}>
                  {t("workspace.chat.useCommon")}
                </button>
              )}
            </>
          ) : chatAISettingsMessage ? (
            <button className="btn sm" type="button" onClick={() => void loadChatAISettings()}>
              {t("workspace.chat.reloadSettings")}
            </button>
          ) : (
            <AiPending label={t("workspace.chat.loadingSettings")} />
          )}
          {(chatAISettingsSaving || chatAISettingsMessage) && (
            <p className={chatAISettingsWarning ? "chat-ai-settings-status warning" : "chat-ai-settings-status"} role={chatAISettingsWarning ? "alert" : "status"}>
              {chatAISettingsSaving
                ? t("workspace.chat.saving")
                : chatAISettingsMessage ? t(CHAT_MESSAGE_KEYS[chatAISettingsMessage]) : ""}
            </p>
          )}
        </div>
      </details>
      {chatMode === "materials" && readyMats.length > 0 && (
        <SourcePicker
          label={t("workspace.chat.context")}
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
            ? t("workspace.chat.materialsPlaceholder")
            : t("workspace.chat.generalPlaceholder")}
          value={chatInput}
          onChange={e => setChatInput(e.target.value)}
          onKeyDown={onChatKey}
          aria-label={t("workspace.chat.questionAria")}
          rows={1}
          disabled={busy}
        />
        <button
          className="send-btn"
          aria-label={t("workspace.chat.sendAria")}
          onClick={sendChat}
          disabled={busy || !chatInput.trim()}
        >↑</button>
      </div>
    </>
  );
}
