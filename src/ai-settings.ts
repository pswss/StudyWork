import type { LocalDB } from "./localdb";
import {
  ALLOWED_CODEX_MODELS,
  ALLOWED_REASONING_EFFORTS,
  CODEX_PROVIDER,
  DEFAULT_CODEX_MODEL,
  DEFAULT_REASONING_EFFORT,
  parseCodexModelPreset,
  parseReasoningEffort,
  type ReasoningEffort,
} from "./codex-provider";

const DEFAULT_OPERATION = "__default__";

export const AI_OPERATIONS = [
  "study",
  "material-extract",
  "consolidate",
  "consolidate-chunk",
  "consolidate-merge",
  "answer-key-detect",
  "problem-extract",
  "question-extract",
  "section-map",
  "question-generate",
  "wrong-answer-analysis",
  "study-plan",
  "chat",
] as const;

export type AIOperation = (typeof AI_OPERATIONS)[number];
export type AIModelSetting = { model: string; reasoningEffort: ReasoningEffort };
export type AISettingsUpdate = {
  default?: AIModelSetting;
  operations?: Partial<Record<AIOperation, AIModelSetting | null>>;
};
export type AISettingsView = {
  appliesTo: typeof CODEX_PROVIDER;
  default: AIModelSetting;
  overrides: Partial<Record<AIOperation, AIModelSetting>>;
  resolved: Record<AIOperation, AIModelSetting>;
  operations: readonly AIOperation[];
  allowedModels: typeof ALLOWED_CODEX_MODELS;
  allowedEfforts: readonly ReasoningEffort[];
};

type SettingRow = { operation: string; model: string; reasoning_effort: string };
type SettingsSnapshot = { default: AIModelSetting; overrides: Partial<Record<AIOperation, AIModelSetting>> };

const operationSet = new Set<string>(AI_OPERATIONS);
const fallbackSetting = (env: NodeJS.ProcessEnv = process.env): AIModelSetting => {
  try {
    return {
      model: parseCodexModelPreset(env.STUDYWORK_AI_MODEL?.trim() || DEFAULT_CODEX_MODEL),
      reasoningEffort: parseReasoningEffort(
        env.STUDYWORK_AI_REASONING_EFFORT?.trim() || DEFAULT_REASONING_EFFORT
      ),
    };
  } catch {
    return { model: DEFAULT_CODEX_MODEL, reasoningEffort: DEFAULT_REASONING_EFFORT };
  }
};

function settingFromRow(row: SettingRow | undefined): AIModelSetting | null {
  if (!row) return null;
  try {
    return {
      model: parseCodexModelPreset(row.model),
      reasoningEffort: parseReasoningEffort(row.reasoning_effort),
    };
  } catch {
    return null;
  }
}

async function loadSnapshot(
  db: LocalDB,
  env: NodeJS.ProcessEnv = process.env
): Promise<SettingsSnapshot> {
  const { results } = await db.prepare(
    "SELECT operation, model, reasoning_effort FROM ai_model_settings"
  ).all<SettingRow>();
  const byOperation = new Map(results.map((row) => [row.operation, row]));
  const defaultSetting = settingFromRow(byOperation.get(DEFAULT_OPERATION)) ?? fallbackSetting(env);
  const overrides: Partial<Record<AIOperation, AIModelSetting>> = {};
  for (const operation of AI_OPERATIONS) {
    const setting = settingFromRow(byOperation.get(operation));
    if (setting) overrides[operation] = setting;
  }
  return { default: defaultSetting, overrides };
}

function viewFromSnapshot(snapshot: SettingsSnapshot): AISettingsView {
  const resolved = {} as Record<AIOperation, AIModelSetting>;
  for (const operation of AI_OPERATIONS) {
    const setting = snapshot.overrides[operation] ?? snapshot.default;
    resolved[operation] = { ...setting };
  }
  return {
    appliesTo: CODEX_PROVIDER,
    default: { ...snapshot.default },
    overrides: Object.fromEntries(
      Object.entries(snapshot.overrides).map(([operation, setting]) => [operation, { ...setting! }])
    ) as Partial<Record<AIOperation, AIModelSetting>>,
    resolved,
    operations: AI_OPERATIONS,
    allowedModels: ALLOWED_CODEX_MODELS,
    allowedEfforts: ALLOWED_REASONING_EFFORTS,
  };
}

export async function readAISettings(
  db: LocalDB,
  env: NodeJS.ProcessEnv = process.env
): Promise<AISettingsView> {
  return viewFromSnapshot(await loadSnapshot(db, env));
}

export function parseAISettingsUpdate(value: unknown): AISettingsUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AI 설정 요청 형식이 유효하지 않습니다");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "default" && key !== "operations")) {
    throw new Error("AI 설정 요청 형식이 유효하지 않습니다");
  }
  const parseSetting = (raw: unknown): AIModelSetting => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("AI 모델 설정 형식이 유효하지 않습니다");
    }
    const record = raw as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => key !== "model" && key !== "reasoningEffort") ||
      typeof record.model !== "string" ||
      typeof record.reasoningEffort !== "string"
    ) {
      throw new Error("AI 모델 설정 형식이 유효하지 않습니다");
    }
    return {
      model: parseCodexModelPreset(record.model),
      reasoningEffort: parseReasoningEffort(record.reasoningEffort),
    };
  };

  const update: AISettingsUpdate = {};
  if (Object.prototype.hasOwnProperty.call(input, "default")) {
    update.default = parseSetting(input.default);
  }
  if (Object.prototype.hasOwnProperty.call(input, "operations")) {
    if (!input.operations || typeof input.operations !== "object" || Array.isArray(input.operations)) {
      throw new Error("AI 작업별 설정 형식이 유효하지 않습니다");
    }
    const operations: Partial<Record<AIOperation, AIModelSetting | null>> = {};
    for (const [operation, raw] of Object.entries(input.operations as Record<string, unknown>)) {
      if (!operationSet.has(operation)) throw new Error("지원하지 않는 AI 작업입니다");
      operations[operation as AIOperation] = raw === null ? null : parseSetting(raw);
    }
    update.operations = operations;
  }
  if (!update.default && (!update.operations || Object.keys(update.operations).length === 0)) {
    throw new Error("변경할 AI 설정이 없습니다");
  }
  return update;
}

export async function updateAISettings(db: LocalDB, update: AISettingsUpdate): Promise<AISettingsView> {
  const statements = [];
  if (update.default) {
    statements.push(db.prepare(
      `INSERT INTO ai_model_settings (operation, model, reasoning_effort)
       VALUES (?, ?, ?)
       ON CONFLICT(operation) DO UPDATE SET
         model = excluded.model,
         reasoning_effort = excluded.reasoning_effort,
         updated_at = datetime('now')`
    ).bind(DEFAULT_OPERATION, update.default.model, update.default.reasoningEffort));
  }
  for (const [operation, setting] of Object.entries(update.operations ?? {})) {
    if (setting === null) {
      statements.push(db.prepare(
        "DELETE FROM ai_model_settings WHERE operation = ? AND operation != ?"
      ).bind(operation, DEFAULT_OPERATION));
    } else {
      statements.push(db.prepare(
        `INSERT INTO ai_model_settings (operation, model, reasoning_effort)
         VALUES (?, ?, ?)
         ON CONFLICT(operation) DO UPDATE SET
           model = excluded.model,
           reasoning_effort = excluded.reasoning_effort,
           updated_at = datetime('now')`
      ).bind(operation, setting.model, setting.reasoningEffort));
    }
  }
  if (statements.length === 0) throw new Error("변경할 AI 설정이 없습니다");
  await db.batch(statements);
  return readAISettings(db);
}

export class AISettingsResolver {
  private snapshots = new WeakMap<AbortSignal, Promise<SettingsSnapshot>>();

  constructor(
    private readonly db: LocalDB,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  async resolve(operation: string, signal?: AbortSignal): Promise<AIModelSetting> {
    let snapshotPromise: Promise<SettingsSnapshot>;
    if (signal) {
      snapshotPromise = this.snapshots.get(signal) ?? loadSnapshot(this.db, this.env);
      this.snapshots.set(signal, snapshotPromise);
    } else {
      snapshotPromise = loadSnapshot(this.db, this.env);
    }
    const snapshot = await snapshotPromise;
    const override = operationSet.has(operation)
      ? snapshot.overrides[operation as AIOperation]
      : undefined;
    return { ...(override ?? snapshot.default) };
  }
}

let runtimeResolver: AISettingsResolver | undefined;

export function configureAISettings(
  db?: LocalDB,
  env: NodeJS.ProcessEnv = process.env
): void {
  runtimeResolver = db ? new AISettingsResolver(db, env) : undefined;
}

export async function resolveAIExecutionSettings(
  operation: string,
  signal?: AbortSignal
): Promise<AIModelSetting> {
  return runtimeResolver?.resolve(operation, signal) ?? fallbackSetting();
}
