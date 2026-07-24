// 로컬 Node 서버 엔트리.
// AI 호출은 기본적으로 저장된 ChatGPT 로그인을 쓰는 로컬 Codex CLI를 사용한다.

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import app, { type Env } from "./index";
import { LocalDB } from "./localdb";
import { FileStore } from "./filestore";
import { retryPendingToBook } from "./books";
import { recoverInterruptedJobs } from "./recovery";
import { ObsidianVault } from "./obsidian";
import { auditStoredFileEvidence } from "./file-evidence";
import { configureAISettings } from "./ai-settings";

// .env 가 있으면 로드(없어도 무시).
try {
  process.loadEnvFile();
} catch {
  // .env 없음 — 환경변수로 직접 넘겼을 수 있으니 계속 진행
}

const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = resolve(process.env.DATA_DIR ?? "./data");
const APP_PASSWORD = process.env.APP_PASSWORD || undefined;
const AUTH_SECRET = process.env.AUTH_SECRET;
const HTTPS_ONLY = process.env.STUDYWORK_HTTPS_ONLY === "true";
const OBSIDIAN_VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH?.trim();
const OBSIDIAN_WRITE_ENABLED = process.env.OBSIDIAN_WRITE_ENABLED === "true";

if (!AUTH_SECRET || Buffer.byteLength(AUTH_SECRET, "utf8") < 32) {
  console.error(
    "환경변수 AUTH_SECRET은 UTF-8 기준 32바이트 이상이어야 합니다.\n" +
      ".env 파일을 만들어 주세요: cp .env.example .env 후 긴 임의 값을 입력"
  );
  process.exit(1);
}
if (
  APP_PASSWORD &&
  ([...APP_PASSWORD].length < 10 || Buffer.byteLength(APP_PASSWORD, "utf8") < 10)
) {
  console.error("환경변수 APP_PASSWORD는 설정할 경우 10자·10바이트 이상이어야 합니다.");
  process.exit(1);
}

// 데이터 디렉터리 준비
mkdirSync(DATA_DIR, { recursive: true });
const migrationsDir = resolve(import.meta.dirname, "..", "migrations");
const db = new LocalDB(join(DATA_DIR, "studywork.db"), { migrationsDir });
const files = new FileStore(join(DATA_DIR, "files"));
configureAISettings(db);

// 프로세스와 함께 사라진 백그라운드 잡을 명시적인 복구 상태로 전환한다.
await recoverInterruptedJobs(db);
const evidenceAudit = await auditStoredFileEvidence(db, files);
if (evidenceAudit.materials > 0 || evidenceAudit.bookFiles > 0 || evidenceAudit.prunedPageCaches > 0) {
  console.log(
    `[파일 근거 점검] 자료 ${evidenceAudit.materials}개, 문제 원본 ${evidenceAudit.bookFiles}개, ` +
    `경고 ${evidenceAudit.warnings}개, stale 페이지 캐시 정리 ${evidenceAudit.prunedPageCaches}개`
  );
}

let obsidian: ObsidianVault | undefined;
let obsidianError: string | undefined;
if (OBSIDIAN_VAULT_PATH) {
  try {
    obsidian = new ObsidianVault(OBSIDIAN_VAULT_PATH);
  } catch {
    // 서버 전체는 계속 제공하고 status API에서 unavailable로 구분한다. 절대 경로는 로그/응답에 싣지 않는다.
    obsidianError = "configured vault unavailable";
  }
}

const env: Env = {
  DB: db,
  FILES: files,
  ...(APP_PASSWORD ? { APP_PASSWORD } : {}),
  AUTH_SECRET,
  HTTPS_ONLY,
  ...(obsidian ? { OBSIDIAN: obsidian } : {}),
  ...(obsidianError ? { OBSIDIAN_ERROR: obsidianError } : {}),
  OBSIDIAN_WRITE_ENABLED,
};

// 한도 등으로 보류된 자동 문제집화를 상주 재시도 — 부팅 직후 1회 + 10분마다 (빠짐없이 처리)
retryPendingToBook(env).catch((e) => console.error("[문제집화 재시도]", e));
setInterval(() => retryPendingToBook(env).catch((e) => console.error("[문제집화 재시도]", e)), 10 * 60 * 1000);

// 일일 자동 백업 — launchd 상시 구동 전제, 부팅 직후 1회 + 24시간마다. 최근 14개 유지.
const BACKUP_DIR = join(DATA_DIR, "backups");
function runDailyBackup() {
  try {
    const created = db.backupDaily(BACKUP_DIR, 14);
    if (created) console.log(`[백업] ${created}`);
  } catch (e) {
    console.error("[백업 실패]", e);
  }
}
runDailyBackup();
setInterval(runDailyBackup, 24 * 60 * 60 * 1000);

// 정적 파일(web/dist) 서빙 — /api 이외 경로. SPA fallback → index.html.
const WEB_DIST = resolve(import.meta.dirname, "..", "web", "dist");
app.use("/*", async (c, next) => {
  if (c.req.path.startsWith("/api")) return next();
  return serveStatic({ root: WEB_DIST })(c, next);
});
// SPA fallback: 정적 파일이 없으면 index.html 반환(비 /api 경로).
app.get("*", async (c, next) => {
  if (c.req.path.startsWith("/api")) return next();
  const indexPath = join(WEB_DIST, "index.html");
  if (existsSync(indexPath)) return c.html(readFileSync(indexPath, "utf8"));
  return next();
});

// env를 app.fetch에 주입해서 서빙.
const server = serve(
  {
    // nodeEnv(incoming 소켓)를 함께 넘겨 로그인 rate limit이 실제 IP를 보게 한다
    fetch: (req: Request, nodeEnv?: object) => app.fetch(req, { ...nodeEnv, ...env }),
    port: PORT,
    hostname: HTTPS_ONLY ? "127.0.0.1" : "0.0.0.0",
  },
  () => {
    console.log(`\nRemap 서버 실행 중`);
    if (HTTPS_ONLY) {
      console.log(`  HTTPS 프록시 upstream: http://127.0.0.1:${PORT}`);
      console.log("  직접 HTTP 인증/API 접속: 차단");
    } else {
      console.log(`  로컬:  http://localhost:${PORT}`);
      for (const ip of lanIPs()) {
        console.log(`  LAN:   http://${ip}:${PORT}`);
      }
    }
    console.log(`  데이터: ${DATA_DIR}\n`);
  }
);

// 대용량 업로드 시간을 허용하되 무제한 slow upload로 연결을 점유하지 못하게 한다.
// 본문 크기는 index.ts의 streaming bodyLimit에서 별도로 제한한다.
(server as unknown as import("node:http").Server).requestTimeout = 10 * 60 * 1000;

function lanIPs(): string[] {
  const out: string[] = [];
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] ?? []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function shutdown() {
  server.close();
  db.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
