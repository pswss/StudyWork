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
import SingleSelectPicker from "./SingleSelectPicker";
import { useI18n, type MessageKey } from "../i18n";

export const AI_SETTING_GROUPS = [
  { id: "materials", labelKey: "workspace.settings.group.materials", operations: ["material-extract", "section-map"] },
  { id: "workbook", labelKey: "workspace.settings.group.workbook", operations: ["answer-key-detect", "problem-extract", "question-extract"] },
  { id: "question", labelKey: "workspace.settings.group.question", operations: ["question-generate"] },
  { id: "consolidate", labelKey: "workspace.settings.group.consolidate", operations: ["consolidate", "consolidate-chunk", "consolidate-merge"] },
  { id: "wrong", labelKey: "workspace.settings.group.wrong", operations: ["wrong-answer-analysis"] },
  { id: "plan", labelKey: "workspace.settings.group.plan", operations: ["study-plan"] },
] as const satisfies ReadonlyArray<{
  id: string;
  labelKey: MessageKey;
  operations: readonly AIOperation[];
}>;

export function learnerModelLabel(model: string | null): string {
  if (!model) return "기본 모델";
  const matched = /^gpt-([0-9.]+)-(.+)$/i.exec(model);
  return matched ? `GPT-${matched[1]} ${matched[2]}` : model;
}

export function learnerEffortLabel(effort: string | null): string {
  return `effort ${effort || "자동"}`;
}

type SettingTarget = "default" | (typeof AI_SETTING_GROUPS)[number]["id"];
type SettingsMessage = "" | "loadError" | "saveError" | "saved" | "inherited";

export default function AISettingsPanel({ onSaved }: { onSaved?: () => void }) {
  const { t } = useI18n();
  const modelLabel = (model: string | null) =>
    model ? learnerModelLabel(model) : t("workspace.settings.defaultModel");
  const effortLabel = (effort: string | null) =>
    effort ? learnerEffortLabel(effort) : `effort ${t("workspace.settings.automatic")}`;
  const [settings, setSettings] = useState<AISettings | null>(null);
  const [target, setTarget] = useState<SettingTarget>("default");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<SettingsMessage>("");
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setMessage("");
    apiAISettings()
      .then(value => { if (active) setSettings(value); })
      .catch(() => { if (active) setMessage("loadError"); });
    return () => { active = false; };
  }, [loadAttempt]);

  if (!settings) {
    if (message) {
      return (
        <div className="chat-err" role="alert">
          {t("workspace.settings.loadError")}{" "}
          <button type="button" onClick={() => setLoadAttempt(value => value + 1)}>
            {t("workspace.settings.reload")}
          </button>
        </div>
      );
    }
    return (
      <div className="ai-settings-loading" aria-live="polite">
        <AiPending label={t("workspace.settings.loading")} />
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
      setMessage("saved");
      onSaved?.();
    } catch (error) {
      setMessage("saveError");
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
      setMessage("inherited");
      onSaved?.();
    } catch (error) {
      setMessage("saveError");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ai-settings-panel">
      <div className="ai-settings-head">
        <h2>{t("workspace.settings.heading")}</h2>
        <p>{t("workspace.settings.intro")}</p>
      </div>

      <SingleSelectPicker
        className="ai-settings-picker"
        label={t("workspace.settings.scope")}
        value={target}
        disabled={saving}
        options={[
          { value: "default", label: t("workspace.settings.commonDefault") },
          ...AI_SETTING_GROUPS.map(item => ({ value: item.id, label: t(item.labelKey) })),
        ]}
        onChange={value => { setTarget(value as SettingTarget); setMessage(""); }}
      />

      <div className="ai-settings-current">
        <div>
          <strong>{group ? t(group.labelKey) : t("workspace.settings.allCommon")}</strong>
          <span>{group
            ? (hasOverride ? t("workspace.settings.taskOverride") : t("workspace.settings.commonInUse"))
            : t("workspace.settings.defaultApplies")}</span>
          {mixed && <span className="ai-settings-warning">{t("workspace.settings.mixedWarning")}</span>}
        </div>
        {group && hasOverride && (
          <button className="btn sm" onClick={inheritDefault} disabled={saving}>
            {t("workspace.settings.useCommon")}
          </button>
        )}
      </div>

      <fieldset className="ai-settings-fieldset" disabled={saving}>
        <legend>{t("workspace.settings.modelLegend")}</legend>
        <p className="settings-help">{t("workspace.settings.modelHelp")}</p>
        <SingleSelectPicker
          className="ai-settings-select"
          label={t("workspace.settings.model")}
          value={setting.model}
          disabled={saving}
          options={settings.allowedModels.map(model => ({
            value: model,
            label: modelLabel(model),
            description: model,
          }))}
          onChange={model => void save({ ...setting, model })}
        />
      </fieldset>

      <fieldset className="ai-settings-fieldset" disabled={saving}>
        <legend>{t("workspace.settings.effortLegend")}</legend>
        <p className="settings-help">{t("workspace.settings.effortHelp")}</p>
        <SingleSelectPicker
          className="ai-settings-select"
          label={t("workspace.settings.effort")}
          value={setting.reasoningEffort}
          disabled={saving}
          options={settings.allowedEfforts.map((effort: AIReasoningEffort) => ({
            value: effort,
            label: effortLabel(effort),
          }))}
          onChange={reasoningEffort => void save({ ...setting, reasoningEffort: reasoningEffort as AIReasoningEffort })}
        />
      </fieldset>

      <div
        className="ai-settings-status"
        aria-live="polite"
        role={message === "saveError" ? "alert" : "status"}
      >
        {saving
          ? t("workspace.settings.saving")
          : message
            ? t(message === "saved"
              ? "workspace.settings.saved"
              : message === "inherited"
                ? "workspace.settings.inherited"
                : "workspace.settings.saveError")
            : `${modelLabel(setting.model)} · ${effortLabel(setting.reasoningEffort)}`}
      </div>

      <details className="context-help">
        <summary className="clickable">{t("workspace.settings.executionInfo")}</summary>
        <p>
          {t("workspace.settings.thisDevice")} · {modelLabel(setting.model)} · {effortLabel(setting.reasoningEffort)}
        </p>
      </details>
    </div>
  );
}
