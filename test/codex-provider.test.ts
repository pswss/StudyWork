import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  AI_MAX_FILE_BYTES,
  BULK_AI_PARALLELISM,
  CodexCliProvider,
  DEFAULT_CODEX_MODEL,
  loadCodexProviderConfig,
  type CodexProviderConfig,
} from "../src/codex-provider";

type SpawnCall = {
  command: string;
  args: string[];
  options: { cwd: string; env: NodeJS.ProcessEnv };
  input: string;
  schema?: unknown;
};

const tempDirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function config(overrides: Partial<CodexProviderConfig> = {}): CodexProviderConfig {
  return {
    command: "/test/bin/codex",
    pdfCommand: "/test/bin/pdftoppm",
    model: DEFAULT_CODEX_MODEL,
    reasoningEffort: "medium",
    timeoutMs: 2_000,
    maxConcurrency: 2,
    ...overrides,
  };
}

function fakeSpawner(options: { outputs?: string[]; failure?: string; hang?: boolean } = {}) {
  const calls: SpawnCall[] = [];
  const outputs = [...(options.outputs ?? ["정상 응답"])];
  const fn = vi.fn((command: string, rawArgs: readonly string[], rawOptions: any) => {
    const args = [...rawArgs];
    const child = new EventEmitter() as any;
    child.stdin = new PassThrough();
    child.stdout = null;
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = vi.fn((signal: string) => {
      child.killed = true;
      queueMicrotask(() => child.emit("close", null, signal));
      return true;
    });
    let input = "";
    child.stdin.on("data", (chunk: Buffer | string) => { input += String(chunk); });
    child.stdin.on("finish", () => {
      const schemaIndex = args.indexOf("--output-schema");
      const call: SpawnCall = {
        command,
        args,
        options: rawOptions,
        input,
        ...(schemaIndex >= 0
          ? { schema: JSON.parse(readFileSync(join(rawOptions.cwd, args[schemaIndex + 1]), "utf8")) }
          : {}),
      };
      calls.push(call);
      if (options.hang) return;
      queueMicrotask(() => {
        if (basename(command) === "pdftoppm") {
          const prefix = args.at(-1)!;
          writeFileSync(`${prefix}-2.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
          writeFileSync(`${prefix}-1.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
          child.emit("close", 0, null);
          return;
        }
        if (options.failure) {
          child.stderr.write(options.failure);
          child.emit("close", 1, null);
          return;
        }
        const outputIndex = args.indexOf("-o");
        writeFileSync(join(rawOptions.cwd, args[outputIndex + 1]), outputs.shift() ?? "정상 응답", "utf8");
        child.emit("close", 0, null);
      });
    });
    return child;
  }) as unknown as typeof spawn;
  return { fn, calls };
}

describe("Codex CLI provider config", () => {
  it("키 없이 Sol/high와 절대 CLI 경로를 사용", () => {
    expect(loadCodexProviderConfig({ STUDYWORK_CODEX_BIN: "/opt/codex" })).toMatchObject({
      command: "/opt/codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      maxConcurrency: 4,
    });
    expect(() => loadCodexProviderConfig({ STUDYWORK_CODEX_BIN: "relative/codex" })).toThrow("절대 경로");
    expect(loadCodexProviderConfig({
      STUDYWORK_AI_MODEL: "legacy-env-model",
      STUDYWORK_AI_REASONING_EFFORT: "xhigh",
    })).toMatchObject({ model: "legacy-env-model", reasoningEffort: "xhigh" });
    expect(() => loadCodexProviderConfig({ STUDYWORK_AI_REASONING_EFFORT: "pro" }))
      .toThrow("reasoning effort");
  });
});

describe("Codex CLI adapter", () => {
  it("프롬프트는 stdin으로만 전달하고 앱 비밀 환경과 모델 도구를 차단", async () => {
    vi.stubEnv("APP_PASSWORD", "must-not-reach-child");
    vi.stubEnv("AUTH_SECRET", "must-not-reach-child");
    vi.stubEnv("OPENAI_API_KEY", "must-not-reach-child");
    const fake = fakeSpawner();
    const provider = new CodexCliProvider(config(), fake.fn);

    await expect(provider.complete({
      operation: "chat",
      prompt: "긴 비공개 학습 질문",
      instructions: "StudyWork 지침",
    })).resolves.toEqual({ text: "정상 응답", provider: "codex-cli", model: DEFAULT_CODEX_MODEL });

    const call = fake.calls[0];
    expect(call.input).toBe("긴 비공개 학습 질문");
    expect(call.args.join(" ")).not.toContain("긴 비공개 학습 질문");
    expect(call.args).toEqual(expect.arrayContaining([
      "--ephemeral", "--ignore-user-config", "--ignore-rules", "read-only", "shell_snapshot", "shell_tool", "unified_exec",
    ]));
    expect(call.args.join(" ")).toContain("StudyWork 지침");
    expect(call.options.env).not.toHaveProperty("APP_PASSWORD");
    expect(call.options.env).not.toHaveProperty("AUTH_SECRET");
    expect(call.options.env).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("기존 strict schema를 파일로 넘기고 배열 envelope를 해제", async () => {
    const fake = fakeSpawner({ outputs: ['{"items":["가","나"]}'] });
    const provider = new CodexCliProvider(config(), fake.fn);
    const schema = {
      type: "object",
      properties: { items: { type: "array", items: { type: "string" } } },
      required: ["items"],
      additionalProperties: false,
    };

    await expect(provider.complete({
      operation: "schema",
      prompt: "배열 생성",
      schema: { name: "items", outputKey: "items", schema },
    })).resolves.toMatchObject({ text: '["가","나"]' });
    expect(fake.calls[0].schema).toEqual(schema);
  });

  it("요청에서 스냅샷된 모델과 effort를 해당 Codex 호출에만 적용", async () => {
    const fake = fakeSpawner();
    const provider = new CodexCliProvider(config(), fake.fn);

    await provider.complete({
      operation: "problem-extract",
      prompt: "문제 추출",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
    });

    const call = fake.calls[0];
    expect(call.args.slice(call.args.indexOf("-m"), call.args.indexOf("-m") + 2))
      .toEqual(["-m", "gpt-5.6-sol"]);
    expect(call.args).toContain('model_reasoning_effort="xhigh"');
  });

  it("이미지는 opaque 임시 이름으로 복사해 첨부하고 원본 경로를 숨김", async () => {
    const dir = mkdtempSync(join(tmpdir(), "studywork-codex-image-test-"));
    tempDirs.push(dir);
    const image = join(dir, "개인 자료.png");
    writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const fake = fakeSpawner();
    const provider = new CodexCliProvider(config(), fake.fn);

    await provider.complete({ operation: "image", prompt: "첨부를 읽으세요", file: { path: image, kind: "image" } });

    const call = fake.calls[0];
    expect(call.args.join(" ")).not.toContain(image);
    expect(call.args[call.args.indexOf("-i") + 1]).toBe("input.png");
    expect(existsSync(call.options.cwd)).toBe(false);
  });

  it("PDF는 pdftoppm 이미지로 바꿔 순서대로 첨부하며 Codex에 원본 경로를 넘기지 않음", async () => {
    const dir = mkdtempSync(join(tmpdir(), "studywork-codex-pdf-test-"));
    tempDirs.push(dir);
    const pdf = join(dir, "개인 자료.pdf");
    writeFileSync(pdf, "%PDF-1.4\n%%EOF");
    const fake = fakeSpawner();
    const provider = new CodexCliProvider(config(), fake.fn);

    await provider.complete({ operation: "pdf", prompt: "모든 쪽을 읽으세요", file: { path: pdf, kind: "pdf" } });

    expect(basename(fake.calls[0].command)).toBe("pdftoppm");
    const codex = fake.calls[1];
    expect(codex.args.join(" ")).not.toContain(pdf);
    const imageIndex = codex.args.indexOf("-i");
    expect(codex.args.slice(imageIndex + 1, imageIndex + 3).map((path) => basename(path))).toEqual(["page-1.png", "page-2.png"]);
  });

  it("50MB 초과 파일은 프로세스를 시작하기 전에 거부", async () => {
    const dir = mkdtempSync(join(tmpdir(), "studywork-codex-large-test-"));
    tempDirs.push(dir);
    const pdf = join(dir, "large.pdf");
    writeFileSync(pdf, "%PDF-");
    truncateSync(pdf, AI_MAX_FILE_BYTES + 1);
    const fake = fakeSpawner();
    const provider = new CodexCliProvider(config(), fake.fn);

    await expect(provider.complete({ operation: "pdf", prompt: "read", file: { path: pdf, kind: "pdf" } }))
      .rejects.toMatchObject({ code: "file_too_large" });
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    ["Not logged in. Run codex login", "auth"],
    ["You've hit your usage limit", "rate_limit"],
    ["You've hit your weekly limit. Resets at 9:00 PM", "rate_limit"],
    ["private prompt and /private/path", "unavailable"],
  ] as const)("CLI 실패를 원문 노출 없이 %s 상태로 변환", async (stderr, code) => {
    const fake = fakeSpawner({ failure: stderr });
    const provider = new CodexCliProvider(config(), fake.fn);
    const error = await provider.complete({ operation: "chat", prompt: "private prompt" }).catch((value) => value);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain("private prompt");
    expect(String(error)).not.toContain("/private/path");
  });

  it("외부 취소 시 Codex 프로세스를 종료하고 임시 폴더를 정리", async () => {
    const fake = fakeSpawner({ hang: true });
    const provider = new CodexCliProvider(config(), fake.fn);
    const controller = new AbortController();
    const pending = provider.complete({ operation: "chat", prompt: "cancel", signal: controller.signal });
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    const workspace = fake.calls[0].options.cwd;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(existsSync(workspace)).toBe(false);
  });

  it("배치 작업이 몰려도 채팅용 예약 슬롯 하나는 남는다", async () => {
    const fake = fakeSpawner({ hang: true });
    const provider = new CodexCliProvider(config({ maxConcurrency: 2 }), fake.fn);
    const controller = new AbortController();

    // 배치(추출·단권화)는 limit-1 = 1개까지만 동시 실행 — 두 번째는 큐 대기
    const batch1 = provider.complete({ operation: "material-extract", prompt: "배치 1", signal: controller.signal });
    const batch2 = provider.complete({ operation: "consolidate-chunk", prompt: "배치 2", signal: controller.signal });
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    expect(fake.calls[0].input).toBe("배치 1");

    // 채팅은 예약 슬롯으로 대기 중인 배치를 제치고 즉시 실행된다
    const chatRequest = provider.complete({ operation: "chat", prompt: "채팅 질문", signal: controller.signal });
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2));
    expect(fake.calls[1].input).toBe("채팅 질문");

    controller.abort();
    for (const pending of [batch1, batch2, chatRequest]) {
      await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    }
  });

  it("공용 bulk lane은 작업 종류를 합쳐 20개로 제한하고 일반·채팅 lane과 분리", async () => {
    const fake = fakeSpawner({ hang: true });
    const provider = new CodexCliProvider(config({ maxConcurrency: 2 }), fake.fn);
    const controller = new AbortController();
    const pending = [
      provider.complete({ operation: "material-extract", prompt: "일반 배치", signal: controller.signal }),
      ...Array.from({ length: BULK_AI_PARALLELISM + 1 }, (_, index) =>
        provider.complete({
          operation: ["question-generate", "material-extract", "problem-extract"][index % 3],
          prompt: `bulk ${index + 1}`,
          signal: controller.signal,
          lane: "bulk",
        })
      ),
    ];
    const guarded = pending.map((promise) => promise.catch((error: unknown) => error));

    await vi.waitFor(() => expect(fake.calls).toHaveLength(BULK_AI_PARALLELISM + 1));
    expect(fake.calls.filter((call) => call.input.startsWith("bulk "))).toHaveLength(BULK_AI_PARALLELISM);
    expect(fake.calls.map((call) => call.input)).not.toContain(`bulk ${BULK_AI_PARALLELISM + 1}`);

    const chat = provider.complete({ operation: "chat", prompt: "채팅", signal: controller.signal })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(fake.calls).toHaveLength(BULK_AI_PARALLELISM + 2));
    expect(fake.calls.at(-1)?.input).toBe("채팅");

    controller.abort();
    const errors = await Promise.all([...guarded, chat]);
    for (const error of errors) expect(error).toMatchObject({ code: "cancelled" });
  });
});
