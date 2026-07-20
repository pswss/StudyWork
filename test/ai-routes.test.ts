import { beforeAll, describe, expect, it } from "vitest";
import { readAIStatus } from "../src/ai-routes";
import { AISettingsResolver, AI_OPERATIONS, readAISettings, updateAISettings } from "../src/ai-settings";
import { ALLOWED_CODEX_MODELS } from "../src/codex-provider";
import { call, makeEnv } from "./helpers";
import type { Env } from "../src/index";

describe("AI runtime status", () => {
  it("기본 로컬 Codex 모델과 effort를 경로·인증정보 없이 공개", () => {
    const status = readAIStatus({} as NodeJS.ProcessEnv);
    expect(status).toEqual({
      provider: "codex-cli",
      model: "gpt-5.6-sol",
      reasoningMode: null,
      reasoningEffort: "high",
      state: "ready",
    });
    expect(JSON.stringify(status)).not.toContain("command");
  });

  it("로컬 CLI 절대 경로를 응답에 노출하지 않음", () => {
    const status = readAIStatus({ STUDYWORK_CODEX_BIN: "/private/local/codex" } as NodeJS.ProcessEnv);
    expect(status.state).toBe("ready");
    expect(JSON.stringify(status)).not.toContain("/private/local/codex");
  });

  it("Claude CLI 롤백 상태는 실제 provider로 표시한다", () => {
    expect(readAIStatus({ STUDYWORK_AI_PROVIDER: "claude-cli" } as NodeJS.ProcessEnv)).toEqual({
      provider: "claude-cli",
      model: "opus",
      reasoningMode: null,
      reasoningEffort: null,
      state: "rollback",
    });
  });
});

describe("AI model settings API", () => {
  const env = makeEnv();
  let cookie: string;

  beforeAll(async () => {
    const response = await call(env, "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-password" }),
    });
    cookie = response.headers.get("set-cookie")!.split(";")[0];
  });

  it("기본값과 모든 작업별 resolved 설정만 공개", async () => {
    const response = await call(env, "/api/ai/settings", { headers: { cookie } });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.appliesTo).toBe("codex-cli");
    expect(body.default).toEqual({ model: "gpt-5.6-sol", reasoningEffort: "high" });
    expect(body.allowedModels).toEqual(ALLOWED_CODEX_MODELS);
    expect(body.operations).toEqual(AI_OPERATIONS);
    expect(Object.keys(body.resolved).sort()).toEqual([...AI_OPERATIONS].sort());
    expect(body.resolved["problem-extract"]).toEqual(body.default);
    expect(JSON.stringify(body)).not.toMatch(/command|password|secret|api.?key|\/private\//i);
  });

  it("공통값과 작업 override를 저장하고 null로 상속 복원", async () => {
    const changed = await call(env, "/api/ai/settings", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        default: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
        operations: {
          "problem-extract": { model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
          chat: { model: "gpt-5.6-sol-fast", reasoningEffort: "max" },
        },
      }),
    });
    expect(changed.status).toBe(200);
    const changedBody = await changed.json() as any;
    expect(changedBody.resolved["chat"].reasoningEffort).toBe("max");
    expect(changedBody.resolved["problem-extract"].reasoningEffort).toBe("xhigh");
    const chatStatus = await call(env, "/api/ai/status?operation=chat", { headers: { cookie } });
    expect(chatStatus.status).toBe(200);
    expect(await chatStatus.json()).toMatchObject({
      model: "gpt-5.6-sol-fast",
      reasoningEffort: "max",
    });

    const inherited = await call(env, "/api/ai/settings", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ operations: { "problem-extract": null } }),
    });
    expect((await inherited.json() as any).resolved["problem-extract"].reasoningEffort).toBe("medium");
  });

  it.each([
    { default: { model: "../../secret", reasoningEffort: "high" } },
    { default: { model: "made-up-model", reasoningEffort: "high" } },
    { default: { model: "gpt-5.6-sol", reasoningEffort: "ultra" } },
    { operations: { "unknown-operation": { model: "gpt-5.6-sol", reasoningEffort: "high" } } },
  ])("모델·effort·operation allowlist 밖 설정을 거부", async (body) => {
    const response = await call(env, "/api/ai/settings", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "AI 설정 요청이 유효하지 않습니다" });
  });

  it("DB 기본값이 없으면 유효한 기존 env를 이어받고 잘못된 env는 Sol/high로 안전 복귀", async () => {
    const legacy = makeEnv();
    await expect(readAISettings(legacy.DB, {
      STUDYWORK_AI_MODEL: "gpt-5.6-luna",
      STUDYWORK_AI_REASONING_EFFORT: "xhigh",
    } as NodeJS.ProcessEnv)).resolves.toMatchObject({
      default: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
    });
    await expect(readAISettings(legacy.DB, {
      STUDYWORK_AI_MODEL: "legacy-local-model",
      STUDYWORK_AI_REASONING_EFFORT: "pro",
    } as NodeJS.ProcessEnv)).resolves.toMatchObject({
      default: { model: "gpt-5.6-sol", reasoningEffort: "high" },
    });
  });
});

describe("AI settings task snapshot", () => {
  it("같은 실행 signal은 변경 전 설정을 유지하고 새 작업부터 변경값 적용", async () => {
    const env = makeEnv() as Env;
    const resolver = new AISettingsResolver(env.DB);
    const running = new AbortController();

    expect(await resolver.resolve("problem-extract", running.signal)).toEqual({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    await updateAISettings(env.DB, {
      operations: {
        "problem-extract": { model: "gpt-5.6-sol", reasoningEffort: "max" },
      },
    });
    expect((await resolver.resolve("problem-extract", running.signal)).reasoningEffort).toBe("high");
    expect((await resolver.resolve("problem-extract", new AbortController().signal)).reasoningEffort).toBe("max");
  });
});
