import { useEffect, useState } from "react";
import {
  type AIModelSetting,
  type AIOperation,
  type AIReasoningEffort,
  type AISettings,
  aiSettings as apiAISettings,
  updateAISettings as apiUpdateAISettings,
} from "../api";
import { AiPending } from "../Pending";

export const AI_SETTING_GROUPS = [
  { id: "chat", label: "AI 질문", operations: ["chat"] },
  { id: "materials", label: "자료 추출", operations: ["material-extract", "section-map"] },
  { id: "workbook", label: "문제집 추출", operations: ["answer-key-detect", "problem-extract", "question-extract"] },
  { id: "question", label: "문제 생성", operations: ["question-generate"] },
  { id: "consolidate", label: "단권화", operations: ["consolidate", "consolidate-chunk", "consolidate-merge"] },
  { id: "wrong", label: "오답 분석", operations: ["wrong-answer-analysis"] },
  { id: "plan", label: "학습 계획", operations: ["study-plan"] },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  operations: readonly AIOperation[];
}>;

const AI_MODEL_LABELS: Record<string, string> = {
  "gpt-5.6-sol": "정밀",
  "gpt-5.6-sol-fast": "정밀 · 빠른 응답",
  "gpt-5.6-luna": "균형",
  "gpt-5.6-luna-fast": "균형 · 빠른 응답",
  "gpt-5.6-terra": "빠름",
  "gpt-5.6-terra-fast": "가장 빠름",
};

const AI_EFFORT_LABELS: Record<AIReasoningEffort, string> = {
  low: "빠름",
  medium: "가볍게",
  high: "균형",
  xhigh: "정밀",
  max: "최대 정밀",
  ultra: "최고 정밀",
};

export function learnerModelLabel(model: string | null): string {
  if (!model) return "기본 모델";
  return Object.hasOwn(AI_MODEL_LABELS, model) ? AI_MODEL_LABELS[model]! : "사용자 지정";
}

export function learnerEffortLabel(effort: string | null): string {
  return effort && Object.hasOwn(AI_EFFORT_LABELS, effort)
    ? AI_EFFORT_LABELS[effort as AIReasoningEffort]
    : "자동";
}

type SettingTarget = "default" | (typeof AI_SETTING_GROUPS)[number]["id"];

export default function AISettingsPanel({ onSaved }: { onSaved?: () => void }) {
  const [settings, setSettings] = useState<AISettings | null>(null);
  const [target, setTarget] = useState<SettingTarget>("default");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setMessage("");
    apiAISettings()
      .then(value => { if (active) setSettings(value); })
      .catch(error => { if (active) setMessage(error instanceof Error ? error.message : "AI 설정을 불러오지 못했습니다"); });
    return () => { active = false; };
  }, [loadAttempt]);

  if (!settings) {
    if (message) {
      return (
        <div className="chat-err" role="alert">
          {message} <button type="button" onClick={() => setLoadAttempt(value => value + 1)}>설정 다시 불러오기</button>
        </div>
      );
    }
    return (
      <div className="ai-settings-loading" aria-live="polite">
        <AiPending label="AI 설정 불러오는 중" />
      </div>
    );
  }

  const group = target === "default" ? null : AI_SETTING_GROUPS.find(item => item.id === target)!;
  const operations = group?.operations ?? [];
  const setting = group ? settings.resolved[operations[0]!] : settings.default;
  const hasOverride = group ? operations.some(operation => settings.overrides[operation] !== undefined) : false;
  const mixed = group
    ? operations.some(operation => {
        const current = settings.resolved[operation];
        return current.model !== setting.model || current.reasoningEffort !== setting.reasoningEffort;
      })
    : false;

  async function save(next: AIModelSetting) {
    if (saving) return;
    setSaving(true);
    setMessage("");
    try {
      const update = group
        ? { operations: Object.fromEntries(operations.map(operation => [operation, next])) }
        : { default: next };
      setSettings(await apiUpdateAISettings(update));
      setMessage("저장됨");
      onSaved?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "AI 설정 저장 실패");
    } finally {
      setSaving(false);
    }
  }

  async function inheritDefault() {
    if (!group || saving) return;
    setSaving(true);
    setMessage("");
    try {
      setSettings(await apiUpdateAISettings({
        operations: Object.fromEntries(operations.map(operation => [operation, null])),
      }));
      setMessage("공통값 사용");
      onSaved?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "AI 설정 저장 실패");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ai-settings-panel">
      <div className="ai-settings-head">
        <h2>AI 답변 방식</h2>
        <p>작업마다 답변 속도와 검토 깊이를 고릅니다. 변경한 설정은 다음 작업부터 적용됩니다.</p>
      </div>

      <label className="solution-field ai-settings-picker">
        <span>설정할 학습 작업</span>
        <select
          className="quiz-select"
          value={target}
          disabled={saving}
          onChange={event => { setTarget(event.target.value as SettingTarget); setMessage(""); }}
        >
          <option value="default">공통 기본</option>
          {AI_SETTING_GROUPS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>

      <div className="ai-settings-current">
        <div>
          <strong>{group?.label ?? "모든 작업의 공통 기본값"}</strong>
          <span>{group ? (hasOverride ? "작업별 설정" : "공통값 사용 중") : "작업별 설정이 없을 때 적용"}</span>
          {mixed && <span className="ai-settings-warning">이 기능에 서로 다른 설정이 적용돼 있습니다. 새로 고르면 하나로 맞춰집니다.</span>}
        </div>
        {group && hasOverride && (
          <button className="btn sm" onClick={inheritDefault} disabled={saving}>공통값 사용</button>
        )}
      </div>

      <fieldset className="ai-settings-fieldset" disabled={saving}>
        <legend>답변 모델</legend>
        <p className="settings-help">정밀 모델은 긴 자료와 복잡한 풀이에, 빠른 모델은 짧은 질문과 반복 작업에 잘 맞습니다.</p>
        <select
          className="quiz-select ai-settings-select"
          aria-label="답변 모델"
          value={mixed ? "" : setting.model}
          onChange={event => void save({ ...setting, model: event.target.value })}
        >
          {mixed && <option value="">서로 다른 설정</option>}
          {settings.allowedModels.map(model => <option key={model} value={model}>{learnerModelLabel(model)}</option>)}
        </select>
      </fieldset>

      <fieldset className="ai-settings-fieldset" disabled={saving}>
        <legend>사고 깊이</legend>
        <p className="settings-help">깊게 생각할수록 복잡한 문제를 더 오래 검토하지만 답변이 늦어집니다. 간단한 질문은 빠름, 풀이 검증은 정밀이 잘 맞습니다.</p>
        <select
          className="quiz-select ai-settings-select"
          aria-label="사고 깊이"
          value={mixed ? "" : setting.reasoningEffort}
          onChange={event => void save({ ...setting, reasoningEffort: event.target.value as AIReasoningEffort })}
        >
          {mixed && <option value="">서로 다른 설정</option>}
          {settings.allowedEfforts.map((effort: AIReasoningEffort) => (
            <option key={effort} value={effort}>{learnerEffortLabel(effort)}</option>
          ))}
        </select>
      </fieldset>

      <div className="ai-settings-status" aria-live="polite">
        {saving ? "저장 중…" : message || `${learnerModelLabel(setting.model)} · ${learnerEffortLabel(setting.reasoningEffort)}`}
      </div>

      <details className="context-help">
        <summary className="clickable">실행 정보</summary>
        <p>이 기기에서 실행 · {learnerModelLabel(setting.model)} · 검토 깊이 {learnerEffortLabel(setting.reasoningEffort)}</p>
      </details>
    </div>
  );
}
