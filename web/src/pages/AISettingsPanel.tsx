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

type SettingTarget = "default" | (typeof AI_SETTING_GROUPS)[number]["id"];

export default function AISettingsPanel({ onSaved }: { onSaved?: () => void }) {
  const [settings, setSettings] = useState<AISettings | null>(null);
  const [target, setTarget] = useState<SettingTarget>("default");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    apiAISettings()
      .then(value => { if (active) setSettings(value); })
      .catch(error => { if (active) setMessage(error instanceof Error ? error.message : "AI 설정을 불러오지 못했습니다"); });
    return () => { active = false; };
  }, []);

  if (!settings) {
    return (
      <div className="ai-settings-loading" aria-live="polite">
        {message || <AiPending label="AI 설정 불러오는 중" />}
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
        <h2>AI 실행 설정</h2>
        <p>API 키 없이 로컬 Codex CLI를 호출합니다. 작업 시작 시 선택된 모델과 노력치가 고정됩니다.</p>
      </div>

      <div className="ai-settings-targets" aria-label="설정할 AI 작업">
        <button
          className={`mode-chip${target === "default" ? " active" : ""}`}
          aria-pressed={target === "default"}
          disabled={saving}
          onClick={() => { setTarget("default"); setMessage(""); }}
        >공통 기본</button>
        {AI_SETTING_GROUPS.map(item => (
          <button
            key={item.id}
            className={`mode-chip${target === item.id ? " active" : ""}`}
            aria-pressed={target === item.id}
            disabled={saving}
            onClick={() => { setTarget(item.id); setMessage(""); }}
          >{item.label}</button>
        ))}
      </div>

      <div className="ai-settings-current">
        <div>
          <strong>{group?.label ?? "모든 작업의 공통 기본값"}</strong>
          <span>{group ? (hasOverride ? "작업별 설정" : "공통값 사용 중") : "작업별 설정이 없을 때 적용"}</span>
          {mixed && <span className="ai-settings-warning">내부 작업 설정이 서로 달라 새 선택 시 하나로 맞춰집니다.</span>}
        </div>
        {group && hasOverride && (
          <button className="btn sm" onClick={inheritDefault} disabled={saving}>공통값 사용</button>
        )}
      </div>

      <fieldset className="ai-settings-fieldset" disabled={saving}>
        <legend>모델</legend>
        <div className="ai-settings-options">
          {settings.allowedModels.map(model => (
            <button
              key={model}
              type="button"
              className={`mode-chip${setting.model === model && !mixed ? " active" : ""}`}
              aria-pressed={setting.model === model && !mixed}
              onClick={() => save({ ...setting, model })}
            >{model}</button>
          ))}
        </div>
      </fieldset>

      <fieldset className="ai-settings-fieldset" disabled={saving}>
        <legend>노력치</legend>
        <div className="ai-settings-options">
          {settings.allowedEfforts.map((effort: AIReasoningEffort) => (
            <button
              key={effort}
              type="button"
              className={`mode-chip${setting.reasoningEffort === effort && !mixed ? " active" : ""}`}
              aria-pressed={setting.reasoningEffort === effort && !mixed}
              onClick={() => save({ ...setting, reasoningEffort: effort })}
            >{effort}</button>
          ))}
        </div>
      </fieldset>

      <div className="ai-settings-status" aria-live="polite">
        {saving ? "저장 중..." : message || `${setting.model} · ${setting.reasoningEffort}`}
      </div>
    </div>
  );
}
