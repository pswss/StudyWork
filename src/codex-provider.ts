import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { detectImageMime } from "./upload";

export const CODEX_PROVIDER = "codex-cli";
export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
export const DEFAULT_REASONING_EFFORT = "high";
export const DEFAULT_CODEX_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_CODEX_MAX_CONCURRENCY = 4;
export const AI_MAX_FILE_BYTES = 50 * 1024 * 1024;

export const ALLOWED_CODEX_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-sol-fast",
  "gpt-5.6-luna",
  "gpt-5.6-luna-fast",
  "gpt-5.6-terra",
  "gpt-5.6-terra-fast",
] as const;
export type CodexModelPreset = (typeof ALLOWED_CODEX_MODELS)[number];
export const ALLOWED_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof ALLOWED_REASONING_EFFORTS)[number];
export type AIFileInput = { path: string; kind: "pdf" | "image" };
export type AIJsonSchema = {
  name: string;
  description?: string;
  schema: Record<string, unknown>;
  /** Domain parsers consume arrays, so structured outputs wrap and then unwrap this field. */
  outputKey?: string;
};
export type AICompleteRequest = {
  operation: string;
  prompt: string;
  instructions?: string;
  file?: AIFileInput;
  schema?: AIJsonSchema;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
};
export type AICompleteResult = {
  text: string;
  provider: typeof CODEX_PROVIDER;
  model: string;
};
export type CodexProviderConfig = {
  command: string;
  pdfCommand: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  timeoutMs: number;
  maxConcurrency: number;
};

export type AIProviderErrorCode =
  | "invalid_config"
  | "invalid_file"
  | "file_too_large"
  | "auth"
  | "rate_limit"
  | "timeout"
  | "cancelled"
  | "unavailable"
  | "invalid_response"
  | "empty_response";

export class AIProviderError extends Error {
  constructor(public readonly code: AIProviderErrorCode, message: string) {
    super(message);
    this.name = "AIProviderError";
  }
}

function numberSetting(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new AIProviderError("invalid_config", `${name} 설정이 유효하지 않습니다`);
  }
  return parsed;
}

function defaultCodexCommand(): string {
  const local = join(homedir(), ".local", "bin", "codex");
  return existsSync(local) ? local : "codex";
}

function defaultPdfCommand(): string {
  const homebrew = "/opt/homebrew/bin/pdftoppm";
  return existsSync(homebrew) ? homebrew : "pdftoppm";
}

export function normalizeModelId(value: string): string {
  const model = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model)) {
    throw new AIProviderError("invalid_config", "AI 모델 ID가 유효하지 않습니다");
  }
  return model;
}

export function parseCodexModelPreset(value: string): CodexModelPreset {
  const model = normalizeModelId(value);
  if (!(ALLOWED_CODEX_MODELS as readonly string[]).includes(model)) {
    throw new AIProviderError("invalid_config", "지원하지 않는 AI 모델입니다");
  }
  return model as CodexModelPreset;
}

export function parseReasoningEffort(value: string): ReasoningEffort {
  if (!(ALLOWED_REASONING_EFFORTS as readonly string[]).includes(value)) {
    throw new AIProviderError("invalid_config", "AI reasoning effort 설정이 유효하지 않습니다");
  }
  return value as ReasoningEffort;
}

export function loadCodexProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
  setting?: { model: string; reasoningEffort: ReasoningEffort }
): CodexProviderConfig {
  const command = env.STUDYWORK_CODEX_BIN?.trim() || defaultCodexCommand();
  if (env.STUDYWORK_CODEX_BIN?.trim() && !isAbsolute(command)) {
    throw new AIProviderError("invalid_config", "STUDYWORK_CODEX_BIN은 절대 경로여야 합니다");
  }
  const model = normalizeModelId(setting?.model ?? (env.STUDYWORK_AI_MODEL?.trim() || DEFAULT_CODEX_MODEL));
  const reasoningEffort = parseReasoningEffort(
    setting?.reasoningEffort ?? (env.STUDYWORK_AI_REASONING_EFFORT?.trim() || DEFAULT_REASONING_EFFORT)
  );
  return {
    command,
    pdfCommand: defaultPdfCommand(),
    model,
    reasoningEffort,
    timeoutMs: numberSetting(env.STUDYWORK_AI_TIMEOUT_MS, DEFAULT_CODEX_TIMEOUT_MS, 1_000, 15 * 60 * 1000, "AI timeout"),
    maxConcurrency: numberSetting(
      env.STUDYWORK_AI_MAX_CONCURRENCY,
      DEFAULT_CODEX_MAX_CONCURRENCY,
      1,
      8,
      "AI concurrency"
    ),
  };
}

class Semaphore {
  private active = 0;
  private readonly queue: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    abort?: () => void;
  }> = [];

  constructor(private readonly limit: number) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new AIProviderError("cancelled", "사용자 중단"));
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise((resolve, reject) => {
      const queued = { resolve, reject, signal } as (typeof this.queue)[number];
      if (signal) {
        queued.abort = () => {
          const index = this.queue.indexOf(queued);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new AIProviderError("cancelled", "사용자 중단"));
        };
        signal.addEventListener("abort", queued.abort, { once: true });
      }
      this.queue.push(queued);
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      while (this.queue.length > 0) {
        const next = this.queue.shift()!;
        next.signal?.removeEventListener("abort", next.abort!);
        if (next.signal?.aborted) continue;
        this.active++;
        next.resolve(this.releaseOnce());
        break;
      }
    };
  }
}

class ProcessFailure extends Error {
  constructor(readonly stderr: string, readonly cause?: NodeJS.ErrnoException) {
    super("local process failed");
  }
}

function childEnvironment(workspace: string): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "USER", "LOGNAME", "CODEX_HOME", "LANG", "LC_ALL", "LC_CTYPE",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "CODEX_CA_CERTIFICATE", "SSL_CERT_FILE",
  ];
  const env: NodeJS.ProcessEnv = {
    HOME: homedir(),
    TMPDIR: workspace,
    NO_COLOR: "1",
    RUST_LOG: "error",
    CODEX_NON_INTERACTIVE: "1",
  };
  for (const name of allowed) if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}

function runProcess(
  spawnProcess: typeof spawn,
  command: string,
  args: string[],
  workspace: string,
  input: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) return Promise.reject(new AIProviderError("cancelled", "사용자 중단"));
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnProcess(command, args, {
        cwd: workspace,
        env: childEnvironment(workspace),
        stdio: ["pipe", "ignore", "pipe"],
      });
    } catch (error) {
      reject(new ProcessFailure("", error as NodeJS.ErrnoException));
      return;
    }

    let settled = false;
    let terminalError: Error | undefined;
    let stderr = "";
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      try { child.kill("SIGTERM"); } catch {}
      killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2_000);
      killTimer.unref?.();
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      if (terminalError) return;
      terminalError = new AIProviderError("cancelled", "사용자 중단");
      stop();
    };
    const timer = setTimeout(() => {
      if (terminalError) return;
      terminalError = new AIProviderError("timeout", "Codex 응답 시간 초과");
      stop();
    }, timeoutMs);
    timer.unref?.();

    signal?.addEventListener("abort", abort, { once: true });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 64 * 1024) stderr += String(chunk).slice(0, 64 * 1024 - stderr.length);
    });
    child.once("error", (error) => finish(terminalError ?? new ProcessFailure(stderr, error)));
    child.once("close", (code) => finish(terminalError ?? (code === 0 ? undefined : new ProcessFailure(stderr))));
    child.stdin?.once("error", (error) => {
      if (settled || terminalError) return;
      terminalError = new ProcessFailure(stderr, error);
      stop();
    });
    child.stdin?.end(input);
  });
}

function validatedFile(input: AIFileInput): string {
  try {
    const path = realpathSync(input.path);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size <= 0) throw new Error("not file");
    if (stat.size > AI_MAX_FILE_BYTES) {
      throw new AIProviderError("file_too_large", "AI 요청용 파일이 50MB를 초과했습니다");
    }
    const bytes = readFileSync(path);
    if (input.kind === "pdf") {
      if (bytes.length < 5 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
        throw new AIProviderError("invalid_file", "유효한 PDF 파일이 아닙니다");
      }
    } else if (!detectImageMime(bytes)) {
      throw new AIProviderError("invalid_file", "지원하는 이미지 형식이 아닙니다");
    }
    return path;
  } catch (error) {
    if (error instanceof AIProviderError) throw error;
    throw new AIProviderError("invalid_file", "AI에 전달할 파일을 읽을 수 없습니다");
  }
}

function imageExtension(path: string): string {
  const mime = detectImageMime(readFileSync(path));
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  return ".gif";
}

function mapCodexFailure(error: unknown): AIProviderError {
  if (error instanceof AIProviderError) return error;
  if (!(error instanceof ProcessFailure)) return new AIProviderError("unavailable", "Codex CLI 호출 실패");
  if (error.cause?.code === "ENOENT") return new AIProviderError("unavailable", "Codex CLI를 찾을 수 없습니다");
  if (/not logged in|login required|unauthorized|authentication|\b401\b/i.test(error.stderr)) {
    return new AIProviderError("auth", "Codex CLI 로그인이 필요합니다");
  }
  if (/usage limit|rate limit|quota|weekly limit|session limit|account limit|you'?ve hit[^.\n]*limit|\b429\b/i.test(error.stderr)) {
    return new AIProviderError("rate_limit", "Codex 사용량 한도 또는 속도 제한에 도달했습니다");
  }
  return new AIProviderError("unavailable", "Codex CLI가 응답하지 않았습니다");
}

export class CodexCliProvider {
  private readonly semaphore: Semaphore;

  constructor(readonly config: CodexProviderConfig, private readonly spawnProcess: typeof spawn = spawn) {
    this.semaphore = new Semaphore(config.maxConcurrency);
  }

  async complete(request: AICompleteRequest): Promise<AICompleteResult> {
    if (!request.operation || !request.prompt.trim()) {
      throw new AIProviderError("invalid_config", "AI 요청 내용이 비어 있습니다");
    }
    const model = normalizeModelId(request.model ?? this.config.model);
    const reasoningEffort = parseReasoningEffort(request.reasoningEffort ?? this.config.reasoningEffort);
    const release = await this.semaphore.acquire(request.signal);
    let workspace: string;
    try {
      workspace = mkdtempSync(join(tmpdir(), "studywork-codex-"));
    } catch (error) {
      release();
      throw error;
    }
    try {
      const images: string[] = [];
      if (request.file) {
        const source = validatedFile(request.file);
        if (request.file.kind === "image") {
          const target = join(workspace, `input${imageExtension(source)}`);
          copyFileSync(source, target);
          images.push(target);
        } else {
          const prefix = join(workspace, "page");
          try {
            await runProcess(
              this.spawnProcess,
              this.config.pdfCommand,
              ["-png", "-r", "180", source, prefix],
              workspace,
              "",
              this.config.timeoutMs,
              request.signal
            );
          } catch (error) {
            if (error instanceof AIProviderError) throw error;
            if (error instanceof ProcessFailure && error.cause?.code === "ENOENT") {
              throw new AIProviderError("invalid_file", "PDF 변환기(pdftoppm)를 찾을 수 없습니다");
            }
            throw new AIProviderError("invalid_file", "PDF를 이미지로 변환할 수 없습니다");
          }
          images.push(...readdirSync(workspace)
            .filter((name) => /^page-\d+\.png$/.test(name))
            .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
            .map((name) => join(workspace, name)));
          if (images.length === 0) throw new AIProviderError("invalid_file", "PDF 페이지를 읽을 수 없습니다");
        }
      }

      const outputPath = join(workspace, "result.txt");
      const schemaPath = join(workspace, "schema.json");
      if (request.schema) writeFileSync(schemaPath, JSON.stringify(request.schema.schema), "utf8");
      const args = [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--strict-config",
        "--skip-git-repo-check",
        "--sandbox", "read-only",
        "--disable", "apps",
        "--disable", "goals",
        "--disable", "multi_agent",
        "--disable", "shell_snapshot",
        "--disable", "shell_tool",
        "--disable", "unified_exec",
        "-c", "web_search=\"disabled\"",
        "-c", "approval_policy=\"never\"",
        "-c", "project_doc_max_bytes=0",
        "-c", `developer_instructions=${JSON.stringify(request.instructions ?? "")}`,
        "-m", model,
        "-c", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
        "--color", "never",
        ...(images.length > 0 ? ["-i", ...images.map((path) => path.slice(workspace.length + 1))] : []),
        ...(request.schema ? ["--output-schema", "schema.json"] : []),
        "-o", "result.txt",
        "-",
      ];
      try {
        await runProcess(
          this.spawnProcess,
          this.config.command,
          args,
          workspace,
          request.prompt,
          this.config.timeoutMs,
          request.signal
        );
      } catch (error) {
        throw mapCodexFailure(error);
      }

      if (!existsSync(outputPath) || statSync(outputPath).size > 8 * 1024 * 1024) {
        throw new AIProviderError("invalid_response", "Codex 응답 형식이 유효하지 않습니다");
      }
      const responseText = readFileSync(outputPath, "utf8").trim();
      if (!responseText) throw new AIProviderError("empty_response", "Codex가 빈 응답을 반환했습니다");
      let text = responseText;
      if (request.schema?.outputKey) {
        try {
          const parsed: unknown = JSON.parse(responseText);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
          if (!Object.prototype.hasOwnProperty.call(parsed, request.schema.outputKey)) throw new Error("missing key");
          text = JSON.stringify((parsed as Record<string, unknown>)[request.schema.outputKey]);
        } catch {
          throw new AIProviderError("invalid_response", "Codex 구조화 응답 형식이 유효하지 않습니다");
        }
      }
      return { text, provider: CODEX_PROVIDER, model };
    } finally {
      try {
        rmSync(workspace, { recursive: true, force: true });
      } finally {
        release();
      }
    }
  }
}

let cachedProvider: CodexCliProvider | undefined;

export function getCodexProvider(setting?: { model: string; reasoningEffort: ReasoningEffort }): CodexCliProvider {
  if (!cachedProvider) cachedProvider = new CodexCliProvider(loadCodexProviderConfig(process.env, setting));
  return cachedProvider;
}
