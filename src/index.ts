import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { issueToken, authMiddleware, safeEqual } from "./auth";
import { subjects } from "./subjects";
import { materials } from "./materials";
import { chatRoutes } from "./chat";
import { consolidateRoutes } from "./consolidate";
import { quizRoutes } from "./quiz";
import { bookRoutes } from "./books";
import { wrongRoutes } from "./wrong";
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
  APP_PASSWORD: string;
  AUTH_SECRET: string;
  OBSIDIAN?: ObsidianVault;
  OBSIDIAN_ERROR?: string;
  OBSIDIAN_WRITE_ENABLED?: boolean;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

// 로그인 무차별 대입 방지: IP당 분당 5회 (인메모리)
const loginAttempts = new Map<string, { count: number; windowStart: number }>();

app.post("/api/login", async (c) => {
  const ip: string =
    (c.env as any).incoming?.socket?.remoteAddress ?? "local";
  const now = Date.now();
  if (loginAttempts.size > 1000) loginAttempts.clear(); // 메모리 상한
  const rec = loginAttempts.get(ip);
  if (rec && now - rec.windowStart < 60_000) {
    if (rec.count >= 5) return c.json({ error: "로그인 시도 초과 — 잠시 후 다시 시도" }, 429);
    rec.count++;
  } else {
    loginAttempts.set(ip, { count: 1, windowStart: now });
  }
  const body = await c.req.json<{ password?: string }>().catch(() => ({}) as { password?: string });
  if (!body.password || !safeEqual(body.password, c.env.APP_PASSWORD)) {
    return c.json({ error: "wrong password" }, 401);
  }
  const token = await issueToken(c.env.AUTH_SECRET);
  // Secure 속성 제거: 이 서버는 LAN/Tailscale에서 평문 http로 제공되므로,
  // Secure가 붙으면 브라우저가 쿠키를 저장/전송하지 않아 로그인이 유지되지 않는다.
  c.header("Set-Cookie", `sw_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${90 * 24 * 3600}`);
  return c.json({ ok: true });
});

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/login" || c.req.path === "/api/health") return next();
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
app.route("/api", examRoutes);
app.route("/api", obsidianRoutes);
app.route("/api", skillRoutes);
app.route("/api", aiRoutes);
app.route("/api", aiJobRoutes);

export default app;
