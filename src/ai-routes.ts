import { Hono } from "hono";
import type { Env } from "./index";
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_REASONING_EFFORT,
  loadCodexProviderConfig,
} from "./codex-provider";
import {
  AI_OPERATIONS,
  parseAISettingsUpdate,
  readAISettings,
  updateAISettings,
  type AIOperation,
  type AIModelSetting,
} from "./ai-settings";

export type AIStatus = {
  provider: "codex-cli" | "claude-cli" | "invalid";
  model: string | null;
  reasoningMode: null;
  reasoningEffort: string | null;
  state: "ready" | "rollback" | "invalid";
};

/** 공개 가능한 AI 런타임 설정만 반환한다. 로컬 경로나 인증 정보는 응답에 포함하지 않는다. */
export function readAIStatus(
  env: NodeJS.ProcessEnv = process.env,
  setting?: AIModelSetting
): AIStatus {
  const provider = env.STUDYWORK_AI_PROVIDER?.trim() || "codex-cli";
  if (provider === "codex-cli") {
    try {
      const config = loadCodexProviderConfig(env, setting);
      return {
        provider,
        model: setting?.model ?? config.model,
        reasoningMode: null,
        reasoningEffort: setting?.reasoningEffort ?? config.reasoningEffort,
        state: "ready",
      };
    } catch {
      return {
        provider,
        model: setting?.model ?? (env.STUDYWORK_AI_MODEL?.trim() || DEFAULT_CODEX_MODEL),
        reasoningMode: null,
        reasoningEffort: setting?.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
        state: "invalid",
      };
    }
  }
  if (provider === "claude-cli") {
    return {
      provider,
      model: env.STUDYWORK_CLAUDE_MODEL?.trim() || "opus",
      reasoningMode: null,
      reasoningEffort: null,
      state: "rollback",
    };
  }
  return {
    provider: "invalid",
    model: null,
    reasoningMode: null,
    reasoningEffort: null,
    state: "invalid",
  };
}

export const aiRoutes = new Hono<{ Bindings: Env }>();

aiRoutes.get("/ai/status", async (c) => {
  const settings = await readAISettings(c.env.DB);
  const requestedOperation = c.req.query("operation");
  if (requestedOperation && !(AI_OPERATIONS as readonly string[]).includes(requestedOperation)) {
    return c.json({ error: "지원하지 않는 AI 작업입니다" }, 400);
  }
  const setting = requestedOperation
    ? settings.resolved[requestedOperation as AIOperation]
    : settings.default;
  return c.json(readAIStatus(process.env, setting));
});

aiRoutes.get("/ai/settings", async (c) => c.json(await readAISettings(c.env.DB)));

aiRoutes.put("/ai/settings", async (c) => {
  let update;
  try {
    const input = await c.req.json<unknown>();
    update = parseAISettingsUpdate(input);
  } catch {
    return c.json({ error: "AI 설정 요청이 유효하지 않습니다" }, 400);
  }
  return c.json(await updateAISettings(c.env.DB, update));
});
