import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { isIP } from "node:net";
import {
  authenticatedSession,
  authMiddleware,
  hashPassword,
  issueToken,
  normalizeUsername,
  passwordHashForUnknownUser,
  safeEqual,
  validPassword,
  validUsername,
  verifyPassword,
} from "./auth";
import { subjects } from "./subjects";
import { materials } from "./materials";
import { chatRoutes } from "./chat";
import { consolidateRoutes } from "./consolidate";
import { quizRoutes } from "./quiz";
import { bookRoutes } from "./books";
import { wrongRoutes } from "./wrong";
import { explanationGenRoutes } from "./explanations-gen";
import { examRoutes } from "./exams";
import { obsidianRoutes } from "./obsidian-routes";
import { skillRoutes } from "./skill-routes";
import { aiRoutes } from "./ai-routes";
import { aiJobRoutes } from "./ai-jobs";
import type { LocalDB } from "./localdb";
import type { FileStore } from "./filestore";
import type { ObsidianVault } from "./obsidian";
import { MAX_PDF_BYTES } from "./upload";

export type Env = {
  DB: LocalDB;
  FILES: FileStore;
  APP_PASSWORD?: string;
  AUTH_SECRET: string;
  HTTPS_ONLY?: boolean;
  SIGNUP_ENABLED?: boolean;
  incoming?: { socket?: { remoteAddress?: string } };
  OBSIDIAN?: ObsidianVault;
  OBSIDIAN_ERROR?: string;
  OBSIDIAN_WRITE_ENABLED?: boolean;
};

const app = new Hono<{ Bindings: Env }>();
type AppContext = Context<{ Bindings: Env }>;

app.use("*", secureHeaders({ xFrameOptions: "DENY" }));
app.get("/api/health", (c) => c.json({ ok: true }));

const AUTH_WINDOW_MS = 60_000;
const AUTH_FAILURE_LIMIT = 5;
const authAttempts = new WeakMap<LocalDB, Map<string, { count: number; windowStart: number }>>();
const authBodyLimit = bodyLimit({
  maxSize: 4 * 1024,
  onError: (c) => c.json({ error: "인증 요청이 너무 큽니다" }, 413),
});

function remoteAddress(c: AppContext): string {
  return c.env.incoming?.socket?.remoteAddress ?? "local";
}

function isLoopback(address: string): boolean {
  const value = address.toLowerCase();
  return value === "::1" || value.startsWith("127.") || value.startsWith("::ffff:127.");
}

function trustedProxy(c: AppContext): boolean {
  return isLoopback(remoteAddress(c));
}

function trustedForwarded(c: AppContext, name: string): string | undefined {
  if (!trustedProxy(c)) return undefined;
  return c.req.header(name)?.split(",").at(-1)?.trim() || undefined;
}

function effectiveRequest(c: AppContext): { origin: string; secure: boolean } | null {
  const direct = new URL(c.req.url);
  if (!trustedProxy(c)) {
    return { origin: direct.origin, secure: direct.protocol === "https:" };
  }

  const rawProtocol = trustedForwarded(c, "x-forwarded-proto");
  const protocol = rawProtocol ?? direct.protocol.slice(0, -1);
  if (protocol !== "http" && protocol !== "https") return null;
  const host = trustedForwarded(c, "x-forwarded-host") ?? direct.host;
  try {
    const forwarded = new URL(`${protocol}://${host}`);
    if (
      forwarded.username ||
      forwarded.password ||
      forwarded.pathname !== "/" ||
      forwarded.search ||
      forwarded.hash
    ) return null;
    return { origin: forwarded.origin, secure: protocol === "https" };
  } catch {
    return null;
  }
}

function unsafeRequest(c: AppContext): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
}

app.use("/api/*", async (c, next) => {
  const effective = effectiveRequest(c);
  if (c.env.HTTPS_ONLY && c.req.path !== "/api/health" && !effective?.secure) {
    return c.json({ error: "HTTPS 연결이 필요합니다" }, 426);
  }
  if (unsafeRequest(c)) {
    const origin = c.req.header("origin");
    const fetchSite = c.req.header("sec-fetch-site")?.toLowerCase();
    if (
      !effective ||
      fetchSite === "cross-site" ||
      (fetchSite === "same-site" && !origin)
    ) {
      return c.json({ error: "허용되지 않은 요청 출처입니다" }, 403);
    }
    if (origin) {
      try {
        if (new URL(origin).origin !== effective.origin) {
          return c.json({ error: "허용되지 않은 요청 출처입니다" }, 403);
        }
      } catch {
        return c.json({ error: "허용되지 않은 요청 출처입니다" }, 403);
      }
    }
  }
  await next();
});

function clientKey(c: AppContext, action: "login" | "signup"): string {
  const forwarded = trustedForwarded(c, "x-forwarded-for");
  const ip = forwarded && isIP(forwarded) ? forwarded : remoteAddress(c);
  return `${action}:${ip}`;
}

function attemptMap(c: AppContext): Map<string, { count: number; windowStart: number }> {
  let attempts = authAttempts.get(c.env.DB);
  if (!attempts) {
    attempts = new Map();
    authAttempts.set(c.env.DB, attempts);
  }
  if (attempts.size > 1000) attempts.clear();
  return attempts;
}

function reserveAttempt(c: AppContext, action: "login" | "signup"): boolean {
  const attempts = attemptMap(c);
  const key = clientKey(c, action);
  const rec = attempts.get(key);
  const now = Date.now();
  if (!rec || now - rec.windowStart >= AUTH_WINDOW_MS) {
    attempts.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (rec.count >= AUTH_FAILURE_LIMIT) return false;
  rec.count += 1;
  return true;
}

function clearFailures(c: AppContext, action: "login" | "signup"): void {
  attemptMap(c).delete(clientKey(c, action));
}

function setSessionCookie(c: AppContext, token: string, maxAge = 90 * 24 * 3600): void {
  const secure = c.env.HTTPS_ONLY || effectiveRequest(c)?.secure ? "; Secure" : "";
  const name = c.env.HTTPS_ONLY ? "__Host-sw_token" : "sw_token";
  c.header(
    "Set-Cookie",
    `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`
  );
  if (maxAge === 0 && name !== "sw_token") {
    c.header(
      "Set-Cookie",
      `sw_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure`,
      { append: true }
    );
  }
}

async function owner(c: AppContext): Promise<{
  id: 1;
  username: string;
  password_hash: string;
  session_version: number;
} | null> {
  return c.env.DB.prepare(
    "SELECT id, username, password_hash, session_version FROM users WHERE id = 1"
  ).first();
}

app.get("/api/auth/status", async (c) => {
  c.header("Cache-Control", "no-store");
  const account = await owner(c);
  const session = await authenticatedSession(c);
  return c.json({
    ownerExists: Boolean(account),
    authenticated: Boolean(session),
    authKind: session?.kind ?? null,
    ...(session?.kind === "owner" && account ? { username: account.username } : {}),
  });
});

app.use("/api/signup", authBodyLimit);
app.post("/api/signup", async (c) => {
  // 비싼 scrypt 전에 슬롯을 선점해 동시 요청도 제한한다.
  if (!reserveAttempt(c, "signup")) {
    return c.json({ error: "가입 시도 초과 — 잠시 후 다시 시도해 주세요" }, 429);
  }
  if (await owner(c)) {
    return c.json({ error: "이미 소유자 계정이 설정되었습니다" }, 409);
  }
  if (c.env.HTTPS_ONLY && !c.env.SIGNUP_ENABLED) {
    return c.json({ error: "HTTPS 공개 모드에서는 첫 가입이 잠겨 있습니다" }, 403);
  }

  const body = await c.req.json<{
    username?: unknown;
    password?: unknown;
  }>().catch((): {
    username?: unknown;
    password?: unknown;
  } => ({}));
  if (typeof body.username !== "string" || !validUsername(body.username)) {
    return c.json({ error: "아이디는 한글·영문·숫자·점·밑줄·하이픈으로 3~64자여야 합니다" }, 400);
  }
  if (typeof body.password !== "string" || !validPassword(body.password)) {
    return c.json({ error: "비밀번호는 10~128자로 입력해 주세요" }, 400);
  }

  const username = normalizeUsername(body.username);
  const passwordHash = await hashPassword(body.password);
  try {
    await c.env.DB.prepare(
      "INSERT INTO users (id, username, password_hash) VALUES (1, ?, ?)"
    ).bind(username, passwordHash).run();
  } catch (error) {
    if (await owner(c)) {
      return c.json({ error: "이미 소유자 계정이 설정되었습니다" }, 409);
    }
    throw error;
  }

  clearFailures(c, "signup");
  const token = await issueToken(c.env.AUTH_SECRET, {
    kind: "owner",
    userId: 1,
    sessionVersion: 1,
  });
  setSessionCookie(c, token);
  return c.json({
    ownerExists: true,
    authenticated: true,
    authKind: "owner" as const,
    username,
  }, 201);
});

app.use("/api/login", authBodyLimit);
app.post("/api/login", async (c) => {
  if (!reserveAttempt(c, "login")) {
    return c.json({ error: "로그인 시도 초과 — 잠시 후 다시 시도해 주세요" }, 429);
  }
  const body = await c.req.json<{ username?: unknown; password?: unknown }>()
    .catch((): { username?: unknown; password?: unknown } => ({}));
  const account = await owner(c);

  if (!account) {
    if (
      typeof body.password === "string" &&
      c.env.APP_PASSWORD &&
      safeEqual(body.password, c.env.APP_PASSWORD)
    ) {
      clearFailures(c, "login");
      const token = await issueToken(c.env.AUTH_SECRET, { kind: "legacy" });
      setSessionCookie(c, token);
      return c.json({ ownerExists: false, authenticated: true, authKind: "legacy" as const });
    }
  } else if (
    typeof body.username === "string" &&
    typeof body.password === "string" &&
    body.password.length <= 128 &&
    Buffer.byteLength(body.password, "utf8") <= 512
  ) {
    const username = normalizeUsername(body.username);
    const candidateHash = username === account.username
      ? account.password_hash
      : passwordHashForUnknownUser();
    const passwordMatches = await verifyPassword(body.password, candidateHash);
    if (username === account.username && passwordMatches) {
      clearFailures(c, "login");
      const token = await issueToken(c.env.AUTH_SECRET, {
        kind: "owner",
        userId: 1,
        sessionVersion: account.session_version,
      });
      setSessionCookie(c, token);
      return c.json({
        ownerExists: true,
        authenticated: true,
        authKind: "owner" as const,
        username: account.username,
      });
    }
  }

  return c.json({ error: "아이디 또는 비밀번호가 올바르지 않습니다" }, 401);
});

app.post("/api/logout", async (c) => {
  const session = await authenticatedSession(c);
  if (session?.kind === "owner") {
    await c.env.DB.prepare(
      "UPDATE users SET session_version = session_version + 1 WHERE id = 1 AND session_version = ?"
    ).bind(session.sessionVersion).run();
  }
  setSessionCookie(c, "", 0);
  return c.json({ ok: true });
});

app.use("/api/*", async (c, next) => {
  if (
    c.req.path === "/api/login" ||
    c.req.path === "/api/signup" ||
    c.req.path === "/api/logout" ||
    c.req.path === "/api/auth/status" ||
    c.req.path === "/api/health"
  ) return next();
  return authMiddleware()(c, next);
});

// multipart 파서가 메모리에 전체 요청을 올리기 전에 총 요청 크기를 제한한다.
// 최대 200MiB PDF 한 개와 multipart 메타데이터 여유분만 허용한다.
export const MAX_UPLOAD_REQUEST_BYTES = MAX_PDF_BYTES + 2 * 1024 * 1024;
app.use("/api/*", bodyLimit({
  maxSize: MAX_UPLOAD_REQUEST_BYTES,
  onError: (c) => c.json({ error: "업로드 요청 전체 크기는 202MB 이하만 지원합니다" }, 413),
}));

app.route("/api/subjects", subjects);
app.route("/api", materials);
app.route("/api", chatRoutes);
app.route("/api", consolidateRoutes);
app.route("/api", quizRoutes);
app.route("/api", bookRoutes);
app.route("/api", wrongRoutes);
app.route("/api", explanationGenRoutes);
app.route("/api", examRoutes);
app.route("/api", obsidianRoutes);
app.route("/api", skillRoutes);
app.route("/api", aiRoutes);
app.route("/api", aiJobRoutes);

export default app;
