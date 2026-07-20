# StudyWork MVP (1단계) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 과목별 자료(사진/PDF/텍스트) 업로드 + 자료 기반 AI 튜터 채팅이 동작하는 StudyWork MVP를 Cloudflare Workers에 구축한다.

**Architecture:** Worker 하나(Hono)가 React SPA(정적 에셋)와 REST API를 서빙. D1에 과목/자료/채팅 저장, R2에 원본 파일 저장, Claude API(`claude-opus-4-8`)로 텍스트 추출·채팅. 비밀번호 1개 인증(HMAC 토큰 쿠키), 일일 호출 상한 200회.

**Tech Stack:** Cloudflare Workers, Hono, D1, R2, `@anthropic-ai/sdk`, React + Vite, Vitest (`@cloudflare/vitest-pool-workers`)

**Spec:** `docs/superpowers/specs/2026-07-08-studywork-design.md`
**UI 목업(스타일 기준):** `.superpowers/brainstorm/*/content/studywork-tabs-v3.html` — 다크 잉크(#060a13), 시안/민트 포인트, 마우스 추적 글로우 카드, 캔버스 별밭

**빌드/테스트 명령 (모든 태스크 공통):**
- 테스트: `npx vitest run` (프로젝트 루트)
- 로컬 실행: `npx wrangler dev` (프론트는 `npm run build:web` 후)
- 커밋 메시지는 한국어, 論理적 변경 1개당 1커밋

---

### Task 1: 프로젝트 스캐폴딩

**Files:**
- Create: `package.json`, `wrangler.jsonc`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `web/dist/.gitkeep`

- [ ] **Step 1: package.json 작성**

```json
{
  "name": "studywork",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "build:web": "vite build web",
    "test": "vitest run",
    "deploy": "npm run build:web && wrangler deploy"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "latest",
    "hono": "^4"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "latest",
    "@types/react": "^18",
    "@types/react-dom": "^18",
    "@vitejs/plugin-react": "^4",
    "react": "^18",
    "react-dom": "^18",
    "typescript": "^5",
    "vite": "^6",
    "vitest": "~3.0",
    "wrangler": "latest"
  }
}
```

- [ ] **Step 2: wrangler.jsonc 작성**

```jsonc
{
  "name": "studywork",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "web/dist",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "d1_databases": [
    { "binding": "DB", "database_name": "studywork", "database_id": "PLACEHOLDER" }
  ],
  "r2_buckets": [
    { "binding": "FILES", "bucket_name": "studywork-files" }
  ],
  "observability": { "enabled": true }
}
```

(`database_id`는 Task 9에서 `wrangler d1 create` 후 채움. 로컬 dev/테스트는 PLACEHOLDER여도 동작.)

- [ ] **Step 3: tsconfig.json 작성**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "types": ["@cloudflare/workers-types"],
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "web/src", "test"]
}
```

`@cloudflare/workers-types`를 devDependencies에 추가: `npm i -D @cloudflare/workers-types`

- [ ] **Step 4: vitest.config.ts 작성**

```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["test/**/*.test.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            APP_PASSWORD: "test-password",
            AUTH_SECRET: "test-secret",
            ANTHROPIC_API_KEY: "test-key"
          }
        }
      }
    }
  }
});
```

- [ ] **Step 5: 최소 Worker 엔트리 작성 (`src/index.ts`)**

```ts
import { Hono } from "hono";

export type Env = {
  DB: D1Database;
  FILES: R2Bucket;
  ANTHROPIC_API_KEY: string;
  APP_PASSWORD: string;
  AUTH_SECRET: string;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

export default app;
```

- [ ] **Step 6: 설치·타입체크 확인**

Run: `npm install && npx tsc --noEmit`
Expected: 에러 없음

- [ ] **Step 7: 커밋**

```bash
git add -A && git commit -m "프로젝트 스캐폴딩: Workers+Hono+Vite 기본 구조"
```

---

### Task 2: D1 스키마

**Files:**
- Create: `migrations/0001_init.sql`
- Create: `test/db.test.ts`

- [ ] **Step 1: 마이그레이션 SQL 작성**

```sql
CREATE TABLE subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6cd8ff',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('image','pdf','text')),
  title TEXT NOT NULL,
  r2_key TEXT,
  extracted_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('processing','ready','error')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE usage_daily (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0
);
```

- [ ] **Step 2: 실패하는 테스트 작성 (`test/db.test.ts`)**

```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { readD1Migrations, applyD1Migrations } from "@cloudflare/vitest-pool-workers/config";
```

주의: 마이그레이션 적용은 vitest-pool-workers의 권장 패턴을 쓴다 — `vitest.config.ts`에 setup 추가:

```ts
// vitest.config.ts 수정: defineWorkersConfig에 아래 추가
// test.setupFiles: ["./test/apply-migrations.ts"],
// poolOptions.workers.miniflare.bindings에 TEST_MIGRATIONS 추가는 config 상단에서:
import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              APP_PASSWORD: "test-password",
              AUTH_SECRET: "test-secret",
              ANTHROPIC_API_KEY: "test-key",
              TEST_MIGRATIONS: migrations
            }
          }
        }
      }
    }
  };
});
```

```ts
// test/apply-migrations.ts
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

```ts
// test/db.test.ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("D1 schema", () => {
  it("subjects 테이블에 삽입/조회 가능", async () => {
    await env.DB.prepare("INSERT INTO subjects (name, color) VALUES (?, ?)")
      .bind("수학", "#6cd8ff").run();
    const row = await env.DB.prepare("SELECT * FROM subjects WHERE name = ?")
      .bind("수학").first();
    expect(row).not.toBeNull();
    expect(row!.color).toBe("#6cd8ff");
  });

  it("materials가 subject에 연결됨", async () => {
    const s = await env.DB.prepare("INSERT INTO subjects (name) VALUES ('과학') RETURNING id").first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO materials (subject_id, kind, title, extracted_text) VALUES (?, 'text', '필기', 'F=ma')"
    ).bind(s!.id).run();
    const m = await env.DB.prepare("SELECT * FROM materials WHERE subject_id = ?").bind(s!.id).first();
    expect(m!.kind).toBe("text");
  });
});
```

`cloudflare:test`의 env 타입 선언 (`test/env.d.ts`):

```ts
declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    FILES: R2Bucket;
    APP_PASSWORD: string;
    AUTH_SECRET: string;
    ANTHROPIC_API_KEY: string;
    TEST_MIGRATIONS: import("@cloudflare/vitest-pool-workers/config").D1Migration[];
  }
}
```

- [ ] **Step 3: 테스트 실행 → 통과 확인**

Run: `npx vitest run test/db.test.ts`
Expected: PASS (마이그레이션이 setup에서 적용되므로 바로 통과)

- [ ] **Step 4: 커밋**

```bash
git add -A && git commit -m "D1 스키마: subjects/materials/messages/usage_daily"
```

---

### Task 3: 인증 (비밀번호 → HMAC 토큰 쿠키)

**Files:**
- Create: `src/auth.ts`
- Modify: `src/index.ts`
- Create: `test/auth.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성 (`test/auth.test.ts`)**

```ts
import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("auth", () => {
  it("잘못된 비밀번호는 401", async () => {
    const res = await SELF.fetch("https://x/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong" })
    });
    expect(res.status).toBe(401);
  });

  it("올바른 비밀번호는 200 + 쿠키 발급", async () => {
    const res = await SELF.fetch("https://x/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-password" })
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("sw_token=");
  });

  it("토큰 없이 보호된 API 접근시 401", async () => {
    const res = await SELF.fetch("https://x/api/subjects");
    expect(res.status).toBe(401);
  });

  it("발급된 토큰으로 보호된 API 접근 가능", async () => {
    const login = await SELF.fetch("https://x/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-password" })
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const res = await SELF.fetch("https://x/api/subjects", { headers: { cookie } });
    expect(res.status).not.toBe(401); // subjects 라우트는 Task 4에서 구현 — 404여도 무방
  });
});
```

- [ ] **Step 2: 실행 → 실패 확인**

Run: `npx vitest run test/auth.test.ts`
Expected: FAIL (라우트 없음 → 404 ≠ 401 등)

- [ ] **Step 3: `src/auth.ts` 구현**

```ts
import type { Context, Next } from "hono";
import type { Env } from "./index";

const encoder = new TextEncoder();

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replaceAll("+", "-").replaceAll("/", "_");
}

// 토큰 = exp타임스탬프.서명
export async function issueToken(secret: string, ttlMs = 90 * 24 * 3600 * 1000): Promise<string> {
  const exp = Date.now() + ttlMs;
  return `${exp}.${await hmac(secret, String(exp))}`;
}

export async function verifyToken(secret: string, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig) return false;
  if (Number(exp) < Date.now()) return false;
  return (await hmac(secret, exp)) === sig;
}

export function authMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const cookie = c.req.header("cookie") ?? "";
    const token = cookie.match(/sw_token=([^;]+)/)?.[1];
    if (!(await verifyToken(c.env.AUTH_SECRET, token))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}
```

- [ ] **Step 4: `src/index.ts`에 로그인 라우트 + 미들웨어 연결**

```ts
import { Hono } from "hono";
import { authMiddleware, issueToken } from "./auth";

export type Env = {
  DB: D1Database;
  FILES: R2Bucket;
  ANTHROPIC_API_KEY: string;
  APP_PASSWORD: string;
  AUTH_SECRET: string;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

app.post("/api/login", async (c) => {
  const { password } = await c.req.json<{ password: string }>();
  if (password !== c.env.APP_PASSWORD) return c.json({ error: "wrong password" }, 401);
  const token = await issueToken(c.env.AUTH_SECRET);
  c.header("Set-Cookie", `sw_token=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${90 * 24 * 3600}`);
  return c.json({ ok: true });
});

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/login" || c.req.path === "/api/health") return next();
  return authMiddleware()(c, next);
});

export default app;
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx vitest run test/auth.test.ts`
Expected: PASS (4개)

- [ ] **Step 6: 커밋**

```bash
git add -A && git commit -m "인증: 비밀번호 로그인 + HMAC 토큰 쿠키 미들웨어"
```

---

### Task 4: 과목 CRUD API

**Files:**
- Create: `src/subjects.ts`
- Modify: `src/index.ts`
- Create: `test/subjects.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성 (`test/subjects.test.ts`)**

```ts
import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";

let cookie: string;

beforeAll(async () => {
  const login = await SELF.fetch("https://x/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-password" })
  });
  cookie = login.headers.get("set-cookie")!.split(";")[0];
});

const authed = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://x${path}`, { ...init, headers: { ...init.headers, cookie, "content-type": "application/json" } });

describe("subjects API", () => {
  it("과목 생성 → 목록 조회", async () => {
    const create = await authed("/api/subjects", {
      method: "POST", body: JSON.stringify({ name: "수학", color: "#6cd8ff" })
    });
    expect(create.status).toBe(201);
    const { id } = await create.json<{ id: number }>();
    expect(id).toBeGreaterThan(0);

    const list = await authed("/api/subjects");
    const subjects = await list.json<any[]>();
    expect(subjects.some((s) => s.name === "수학")).toBe(true);
  });

  it("이름 없으면 400", async () => {
    const res = await authed("/api/subjects", { method: "POST", body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });

  it("과목 삭제", async () => {
    const create = await authed("/api/subjects", {
      method: "POST", body: JSON.stringify({ name: "임시" })
    });
    const { id } = await create.json<{ id: number }>();
    const del = await authed(`/api/subjects/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
  });
});
```

- [ ] **Step 2: 실행 → 실패 확인**

Run: `npx vitest run test/subjects.test.ts`
Expected: FAIL (404)

- [ ] **Step 3: `src/subjects.ts` 구현**

```ts
import { Hono } from "hono";
import type { Env } from "./index";

export const subjects = new Hono<{ Bindings: Env }>();

subjects.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.*, COUNT(m.id) AS material_count
     FROM subjects s LEFT JOIN materials m ON m.subject_id = s.id
     GROUP BY s.id ORDER BY s.created_at`
  ).all();
  return c.json(results);
});

subjects.post("/", async (c) => {
  const body = await c.req.json<{ name?: string; color?: string }>().catch(() => ({}) as any);
  if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
  const row = await c.env.DB.prepare(
    "INSERT INTO subjects (name, color) VALUES (?, ?) RETURNING id"
  ).bind(body.name.trim(), body.color ?? "#6cd8ff").first<{ id: number }>();
  return c.json({ id: row!.id }, 201);
});

subjects.delete("/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM subjects WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});
```

`src/index.ts`에 연결 (auth 미들웨어 아래):

```ts
import { subjects } from "./subjects";
app.route("/api/subjects", subjects);
```

주의: D1은 기본적으로 FK를 강제하지 않을 수 있음 — CASCADE 동작을 위해 마이그레이션에 의존하지 말고, 삭제 시 명시적으로 지운다. `subjects.delete`를 다음으로 교체:

```ts
subjects.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM messages WHERE subject_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM materials WHERE subject_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM subjects WHERE id = ?").bind(id)
  ]);
  return c.json({ ok: true });
});
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run test/subjects.test.ts`
Expected: PASS (3개)

- [ ] **Step 5: 커밋**

```bash
git add -A && git commit -m "과목 CRUD API"
```

---

### Task 5: Claude 클라이언트 (추출·채팅) + 비용 가드

**Files:**
- Create: `src/claude.ts`
- Create: `src/usage.ts`
- Create: `test/usage.test.ts`
- Create: `test/claude.test.ts`

- [ ] **Step 1: 비용 가드 실패 테스트 (`test/usage.test.ts`)**

```ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { checkAndIncrementUsage, DAILY_LIMIT } from "../src/usage";

describe("usage guard", () => {
  it("한도 내에서는 허용하고 카운트 증가", async () => {
    const ok = await checkAndIncrementUsage(env.DB);
    expect(ok).toBe(true);
    const row = await env.DB.prepare("SELECT calls FROM usage_daily").first<{ calls: number }>();
    expect(row!.calls).toBe(1);
  });

  it("한도 도달 시 거부", async () => {
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare("INSERT OR REPLACE INTO usage_daily (day, calls) VALUES (?, ?)")
      .bind(day, DAILY_LIMIT).run();
    expect(await checkAndIncrementUsage(env.DB)).toBe(false);
  });
});
```

- [ ] **Step 2: 실행 → 실패 확인**

Run: `npx vitest run test/usage.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: `src/usage.ts` 구현**

```ts
export const DAILY_LIMIT = 200;

export async function checkAndIncrementUsage(db: D1Database): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  await db.prepare(
    "INSERT INTO usage_daily (day, calls) VALUES (?, 0) ON CONFLICT(day) DO NOTHING"
  ).bind(day).run();
  const row = await db.prepare(
    "UPDATE usage_daily SET calls = calls + 1 WHERE day = ? AND calls < ? RETURNING calls"
  ).bind(day, DAILY_LIMIT).first();
  return row !== null;
}
```

- [ ] **Step 4: usage 테스트 통과 확인**

Run: `npx vitest run test/usage.test.ts`
Expected: PASS (2개)

- [ ] **Step 5: `src/claude.ts` 구현 (테스트는 Step 6에서 fetchMock으로)**

```ts
import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-opus-4-8";

export function makeClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey });
}

const EXTRACT_PROMPT =
  "이 자료의 내용을 전부 텍스트로 추출해 정리해줘. 수식은 일반 텍스트(x^2, 1/2 형태)로. " +
  "구조(제목·목록·표)를 유지하고, 내용 요약이나 생략 없이 전체를 옮겨 적어. 다른 말 없이 추출 결과만 출력해.";

export async function extractFromImage(client: Anthropic, base64: string, mediaType: string): Promise<string> {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType as any, data: base64 } },
        { type: "text", text: EXTRACT_PROMPT }
      ]
    }]
  });
  return res.content.filter((b) => b.type === "text").map((b: any) => b.text).join("\n");
}

export async function extractFromPdf(client: Anthropic, base64: string): Promise<string> {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 32000,
    stream: false,
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
        { type: "text", text: EXTRACT_PROMPT }
      ]
    }]
  });
  return res.content.filter((b) => b.type === "text").map((b: any) => b.text).join("\n");
}

export function buildSystemPrompt(subjectName: string, materials: { title: string; extracted_text: string }[]): string {
  const docs = materials
    .map((m) => `<자료 제목="${m.title}">\n${m.extracted_text}\n</자료>`)
    .join("\n\n");
  return (
    `너는 StudyWork의 개인 튜터다. 학생의 "${subjectName}" 과목을 돕는다.\n` +
    `아래는 학생이 업로드한 수업 자료 전체다. 답변은 이 자료를 최우선 근거로 하고, ` +
    `자료에 있는 내용이면 어떤 자료(제목)에서 나왔는지 밝혀라. 자료에 없는 내용은 일반 지식으로 답하되 그 사실을 표시하라.\n` +
    `한국어로, 군더더기 없이 사실 위주로 답하라.\n\n${docs}`
  );
}

export async function chat(
  client: Anthropic,
  subjectName: string,
  materials: { title: string; extracted_text: string }[],
  history: { role: "user" | "assistant"; content: string }[]
): Promise<string> {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: [{ type: "text", text: buildSystemPrompt(subjectName, materials), cache_control: { type: "ephemeral" } }],
    messages: history
  });
  return res.content.filter((b) => b.type === "text").map((b: any) => b.text).join("\n");
}
```

- [ ] **Step 6: 프롬프트 조립 단위 테스트 (`test/claude.test.ts`)**

Claude API 호출 자체는 모킹 비용이 크므로, 순수 함수인 `buildSystemPrompt`만 검증:

```ts
import { describe, it, expect } from "vitest";
import { buildSystemPrompt, MODEL } from "../src/claude";

describe("claude", () => {
  it("모델은 claude-opus-4-8", () => {
    expect(MODEL).toBe("claude-opus-4-8");
  });

  it("시스템 프롬프트에 과목명과 자료가 포함됨", () => {
    const p = buildSystemPrompt("수학", [
      { title: "6/24 필기", extracted_text: "이차함수 y=a(x-p)^2+q" }
    ]);
    expect(p).toContain("수학");
    expect(p).toContain("6/24 필기");
    expect(p).toContain("이차함수");
  });

  it("자료가 없으면 자료 블록이 비어있음", () => {
    const p = buildSystemPrompt("영어", []);
    expect(p).not.toContain("<자료");
  });
});
```

- [ ] **Step 7: 테스트 통과 확인**

Run: `npx vitest run test/claude.test.ts`
Expected: PASS (3개)

- [ ] **Step 8: 커밋**

```bash
git add -A && git commit -m "Claude 클라이언트(추출·채팅 프롬프트)와 일일 비용 가드"
```

---

### Task 6: 자료 업로드 API

**Files:**
- Create: `src/materials.ts`
- Modify: `src/index.ts`
- Create: `test/materials.test.ts`

**동작:** `POST /api/subjects/:id/materials` — multipart(`file` 또는 `text`, `title`).
- text: 즉시 저장 (Claude 호출 없음)
- image/pdf: R2에 원본 저장 → Claude로 추출 → D1 저장. 추출 실패 시 status='error'로 저장하고 사용자가 재시도 가능.
- 크기 제한: 이미지 10MB, PDF 20MB.

- [ ] **Step 1: 실패하는 테스트 작성 (`test/materials.test.ts`)**

텍스트 자료(외부 API 안 타는 경로)만 통합 테스트:

```ts
import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";

let cookie: string;
let subjectId: number;

beforeAll(async () => {
  const login = await SELF.fetch("https://x/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-password" })
  });
  cookie = login.headers.get("set-cookie")!.split(";")[0];
  const create = await SELF.fetch("https://x/api/subjects", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "수학" })
  });
  subjectId = (await create.json<{ id: number }>()).id;
});

describe("materials API", () => {
  it("텍스트 자료 업로드 → 목록 조회", async () => {
    const form = new FormData();
    form.set("title", "시험 범위");
    form.set("text", "이차함수 전체, p.120-150");
    const res = await SELF.fetch(`https://x/api/subjects/${subjectId}/materials`, {
      method: "POST", headers: { cookie }, body: form
    });
    expect(res.status).toBe(201);

    const list = await SELF.fetch(`https://x/api/subjects/${subjectId}/materials`, { headers: { cookie } });
    const items = await list.json<any[]>();
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("시험 범위");
    expect(items[0].status).toBe("ready");
  });

  it("파일도 텍스트도 없으면 400", async () => {
    const form = new FormData();
    form.set("title", "빈 자료");
    const res = await SELF.fetch(`https://x/api/subjects/${subjectId}/materials`, {
      method: "POST", headers: { cookie }, body: form
    });
    expect(res.status).toBe(400);
  });

  it("자료 삭제", async () => {
    const list = await SELF.fetch(`https://x/api/subjects/${subjectId}/materials`, { headers: { cookie } });
    const items = await list.json<any[]>();
    const res = await SELF.fetch(`https://x/api/materials/${items[0].id}`, {
      method: "DELETE", headers: { cookie }
    });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: 실행 → 실패 확인**

Run: `npx vitest run test/materials.test.ts`
Expected: FAIL (404)

- [ ] **Step 3: `src/materials.ts` 구현**

```ts
import { Hono } from "hono";
import type { Env } from "./index";
import { makeClient, extractFromImage, extractFromPdf } from "./claude";
import { checkAndIncrementUsage } from "./usage";

export const materials = new Hono<{ Bindings: Env }>();

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_PDF = 20 * 1024 * 1024;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// GET /api/subjects/:id/materials
materials.get("/subjects/:id/materials", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, subject_id, kind, title, status, created_at FROM materials WHERE subject_id = ? ORDER BY created_at DESC"
  ).bind(c.req.param("id")).all();
  return c.json(results);
});

// POST /api/subjects/:id/materials
materials.post("/subjects/:id/materials", async (c) => {
  const subjectId = c.req.param("id");
  const form = await c.req.formData();
  const title = (form.get("title") as string | null)?.trim() || "제목 없음";
  const text = form.get("text") as string | null;
  const file = form.get("file") as File | null;

  if (text?.trim()) {
    const row = await c.env.DB.prepare(
      "INSERT INTO materials (subject_id, kind, title, extracted_text, status) VALUES (?, 'text', ?, ?, 'ready') RETURNING id"
    ).bind(subjectId, title, text.trim()).first<{ id: number }>();
    return c.json({ id: row!.id, status: "ready" }, 201);
  }

  if (!file) return c.json({ error: "file 또는 text 필요" }, 400);

  const isPdf = file.type === "application/pdf";
  const isImage = IMAGE_TYPES.includes(file.type);
  if (!isPdf && !isImage) return c.json({ error: `지원하지 않는 형식: ${file.type}` }, 400);
  if (isImage && file.size > MAX_IMAGE) return c.json({ error: "이미지는 10MB 이하" }, 400);
  if (isPdf && file.size > MAX_PDF) return c.json({ error: "PDF는 20MB 이하" }, 400);

  if (!(await checkAndIncrementUsage(c.env.DB))) {
    return c.json({ error: "오늘 사용량 한도 도달" }, 429);
  }

  const buf = await file.arrayBuffer();
  const r2Key = `materials/${subjectId}/${Date.now()}-${file.name}`;
  await c.env.FILES.put(r2Key, buf, { httpMetadata: { contentType: file.type } });

  const kind = isPdf ? "pdf" : "image";
  const row = await c.env.DB.prepare(
    "INSERT INTO materials (subject_id, kind, title, r2_key, status) VALUES (?, ?, ?, ?, 'processing') RETURNING id"
  ).bind(subjectId, kind, title, r2Key).first<{ id: number }>();
  const id = row!.id;

  try {
    const client = makeClient(c.env.ANTHROPIC_API_KEY);
    const base64 = toBase64(buf);
    const extracted = isPdf
      ? await extractFromPdf(client, base64)
      : await extractFromImage(client, base64, file.type);
    await c.env.DB.prepare("UPDATE materials SET extracted_text = ?, status = 'ready' WHERE id = ?")
      .bind(extracted, id).run();
    return c.json({ id, status: "ready" }, 201);
  } catch (e) {
    await c.env.DB.prepare("UPDATE materials SET status = 'error' WHERE id = ?").bind(id).run();
    return c.json({ id, status: "error", error: String(e) }, 502);
  }
});

// POST /api/materials/:id/retry — 추출 재시도
materials.post("/materials/:id/retry", async (c) => {
  const id = c.req.param("id");
  const m = await c.env.DB.prepare("SELECT * FROM materials WHERE id = ?").bind(id)
    .first<{ id: number; kind: string; r2_key: string | null }>();
  if (!m?.r2_key) return c.json({ error: "재시도할 파일 없음" }, 404);
  if (!(await checkAndIncrementUsage(c.env.DB))) return c.json({ error: "오늘 사용량 한도 도달" }, 429);

  const obj = await c.env.FILES.get(m.r2_key);
  if (!obj) return c.json({ error: "원본 파일 없음" }, 404);
  const buf = await obj.arrayBuffer();
  const contentType = obj.httpMetadata?.contentType ?? "image/jpeg";

  try {
    const client = makeClient(c.env.ANTHROPIC_API_KEY);
    const base64 = toBase64(buf);
    const extracted = m.kind === "pdf"
      ? await extractFromPdf(client, base64)
      : await extractFromImage(client, base64, contentType);
    await c.env.DB.prepare("UPDATE materials SET extracted_text = ?, status = 'ready' WHERE id = ?")
      .bind(extracted, id).run();
    return c.json({ id: m.id, status: "ready" });
  } catch (e) {
    return c.json({ id: m.id, status: "error", error: String(e) }, 502);
  }
});

// GET /api/materials/:id — 추출 텍스트 포함 상세
materials.get("/materials/:id", async (c) => {
  const m = await c.env.DB.prepare("SELECT * FROM materials WHERE id = ?").bind(c.req.param("id")).first();
  if (!m) return c.json({ error: "not found" }, 404);
  return c.json(m);
});

// DELETE /api/materials/:id
materials.delete("/materials/:id", async (c) => {
  const m = await c.env.DB.prepare("SELECT r2_key FROM materials WHERE id = ?")
    .bind(c.req.param("id")).first<{ r2_key: string | null }>();
  if (m?.r2_key) await c.env.FILES.delete(m.r2_key);
  await c.env.DB.prepare("DELETE FROM materials WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});
```

`src/index.ts`에 연결:

```ts
import { materials } from "./materials";
app.route("/api", materials);
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run test/materials.test.ts`
Expected: PASS (3개)

- [ ] **Step 5: 커밋**

```bash
git add -A && git commit -m "자료 업로드 API: R2 저장 + Claude 텍스트 추출 + 재시도"
```

---

### Task 7: 채팅 API

**Files:**
- Create: `src/chat.ts`
- Modify: `src/index.ts`
- Create: `test/chat.test.ts`

**동작:**
- `GET /api/subjects/:id/messages` — 대화 기록
- `POST /api/subjects/:id/chat` — `{ message }` → user 메시지 저장 → 과목 자료 전체 + 최근 대화 30개로 Claude 호출 → assistant 응답 저장·반환

- [ ] **Step 1: 실패하는 테스트 작성 (`test/chat.test.ts`)**

Claude 호출은 `fetchMock`(cloudflare:test 제공)으로 api.anthropic.com을 모킹:

```ts
import { SELF, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach } from "vitest";

let cookie: string;
let subjectId: number;

beforeAll(async () => {
  fetchMock.activate();
  const login = await SELF.fetch("https://x/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-password" })
  });
  cookie = login.headers.get("set-cookie")!.split(";")[0];
  const create = await SELF.fetch("https://x/api/subjects", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "수학" })
  });
  subjectId = (await create.json<{ id: number }>()).id;
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("chat API", () => {
  it("메시지 전송 → Claude 응답 저장·반환", async () => {
    fetchMock.get("https://api.anthropic.com")
      .intercept({ path: "/v1/messages", method: "POST" })
      .reply(200, {
        id: "msg_1", type: "message", role: "assistant", model: "claude-opus-4-8",
        content: [{ type: "text", text: "꼭짓점은 (2, 9)입니다." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 10 }
      });

    const res = await SELF.fetch(`https://x/api/subjects/${subjectId}/chat`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ message: "이차함수 꼭짓점?" })
    });
    expect(res.status).toBe(200);
    const { reply } = await res.json<{ reply: string }>();
    expect(reply).toContain("꼭짓점");

    const hist = await SELF.fetch(`https://x/api/subjects/${subjectId}/messages`, { headers: { cookie } });
    const msgs = await hist.json<any[]>();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
  });

  it("빈 메시지는 400", async () => {
    const res = await SELF.fetch(`https://x/api/subjects/${subjectId}/chat`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ message: "" })
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: 실행 → 실패 확인**

Run: `npx vitest run test/chat.test.ts`
Expected: FAIL (404)

- [ ] **Step 3: `src/chat.ts` 구현**

```ts
import { Hono } from "hono";
import type { Env } from "./index";
import { makeClient, chat as claudeChat } from "./claude";
import { checkAndIncrementUsage } from "./usage";

export const chatRoutes = new Hono<{ Bindings: Env }>();

chatRoutes.get("/subjects/:id/messages", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, role, content, created_at FROM messages WHERE subject_id = ? ORDER BY id"
  ).bind(c.req.param("id")).all();
  return c.json(results);
});

chatRoutes.post("/subjects/:id/chat", async (c) => {
  const subjectId = c.req.param("id");
  const { message } = await c.req.json<{ message?: string }>().catch(() => ({}) as any);
  if (!message?.trim()) return c.json({ error: "message required" }, 400);

  const subject = await c.env.DB.prepare("SELECT name FROM subjects WHERE id = ?")
    .bind(subjectId).first<{ name: string }>();
  if (!subject) return c.json({ error: "subject not found" }, 404);

  if (!(await checkAndIncrementUsage(c.env.DB))) {
    return c.json({ error: "오늘 사용량 한도 도달" }, 429);
  }

  await c.env.DB.prepare("INSERT INTO messages (subject_id, role, content) VALUES (?, 'user', ?)")
    .bind(subjectId, message.trim()).run();

  const { results: mats } = await c.env.DB.prepare(
    "SELECT title, extracted_text FROM materials WHERE subject_id = ? AND status = 'ready' ORDER BY created_at"
  ).bind(subjectId).all<{ title: string; extracted_text: string }>();

  const { results: hist } = await c.env.DB.prepare(
    "SELECT role, content FROM (SELECT id, role, content FROM messages WHERE subject_id = ? ORDER BY id DESC LIMIT 30) ORDER BY id"
  ).bind(subjectId).all<{ role: "user" | "assistant"; content: string }>();

  try {
    const client = makeClient(c.env.ANTHROPIC_API_KEY);
    const reply = await claudeChat(client, subject.name, mats, hist);
    await c.env.DB.prepare("INSERT INTO messages (subject_id, role, content) VALUES (?, 'assistant', ?)")
      .bind(subjectId, reply).run();
    return c.json({ reply });
  } catch (e) {
    return c.json({ error: `AI 응답 실패: ${String(e)}` }, 502);
  }
});
```

`src/index.ts`에 연결:

```ts
import { chatRoutes } from "./chat";
app.route("/api", chatRoutes);
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run`
Expected: 전체 PASS

- [ ] **Step 5: 커밋**

```bash
git add -A && git commit -m "채팅 API: 자료 컨텍스트 주입 + 대화 기록"
```

---

### Task 8: 프론트엔드 (React SPA)

**Files:**
- Create: `web/index.html`, `web/vite.config.ts`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/api.ts`, `web/src/Sky.tsx`, `web/src/styles.css`
- Create: `web/src/pages/Login.tsx`, `web/src/pages/Subjects.tsx`, `web/src/pages/SubjectDetail.tsx`

**스타일 기준:** 목업 `studywork-tabs-v3.html`의 CSS를 그대로 이식 (다크 잉크 배경, Gowun Batang + Pretendard, 마우스 추적 글로우 카드 `.card`, 캔버스 별밭·유성·성운). 카피는 건조하게 수치·사실만.

프론트 테스트는 생략(수동 검증). 빌드 통과 + `wrangler dev` 수동 확인으로 대체.

- [ ] **Step 1: Vite 설정 (`web/vite.config.ts`)**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:8787" } }
});
```

- [ ] **Step 2: `web/index.html`**

```html
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>StudyWork</title>
  <link href="https://fonts.googleapis.com/css2?family=Gowun+Batang:wght@400;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

- [ ] **Step 3: `web/src/styles.css`**

목업 `studywork-tabs-v3.html`의 `<style>` 블록을 기반으로 작성. 필수 클래스: `:root` 변수(--ink/--star/--cyan/--mint/--warn/--bad/--dim/--dimmer/--line), `nav`/`.brand`/`.nav-links`, `.page`, `.crumb`/`h1`/`.sub`, `.card`(글로우 보더 ::before + 스포트라이트 ::after), `.grid`, `.chat-*`, `.btn`, `.grain`. 목업 파일에서 복사해 React 클래스명에 맞게 정리한다. 추가로:

```css
/* 로그인 */
.login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
.login-box { width: 320px; padding: 40px 32px; text-align: center; }
.login-box input {
  width: 100%; margin: 24px 0 16px; padding: 14px 18px;
  background: rgba(16,24,40,.8); border: 1px solid var(--line); border-radius: 14px;
  color: var(--star); font-family: inherit; font-size: 15px; outline: none;
}
.login-box input:focus { border-color: var(--cyan); }
/* 채팅 */
.chat-log { display: flex; flex-direction: column; gap: 20px; padding: 24px 0; min-height: 300px; }
.msg-user { align-self: flex-end; background: rgba(108,216,255,.12); border: 1px solid rgba(108,216,255,.25); border-radius: 18px 18px 4px 18px; padding: 12px 18px; max-width: 80%; font-size: 14.5px; }
.msg-ai { max-width: 92%; font-size: 14.5px; line-height: 1.85; color: var(--dim); white-space: pre-wrap; }
.msg-ai b, .msg-ai strong { color: var(--star); }
.chat-input-row { display: flex; gap: 10px; position: sticky; bottom: 24px; }
.chat-input-row textarea {
  flex: 1; resize: none; padding: 14px 18px; border-radius: 16px;
  background: rgba(16,24,40,.9); border: 1px solid var(--line); color: var(--star);
  font-family: inherit; font-size: 14.5px; outline: none;
}
```

- [ ] **Step 4: API 클라이언트 (`web/src/api.ts`)**

```ts
async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, credentials: "include" });
  if (res.status === 401) { location.hash = "#/login"; throw new Error("unauthorized"); }
  const data = await res.json();
  if (!res.ok) throw new Error((data as any).error ?? res.statusText);
  return data as T;
}

export type Subject = { id: number; name: string; color: string; material_count: number };
export type Material = { id: number; kind: string; title: string; status: string; created_at: string; extracted_text?: string };
export type Message = { id: number; role: "user" | "assistant"; content: string };

export const api = {
  login: (password: string) =>
    req("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) }),
  subjects: () => req<Subject[]>("/api/subjects"),
  createSubject: (name: string, color: string) =>
    req<{ id: number }>("/api/subjects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, color }) }),
  deleteSubject: (id: number) => req(`/api/subjects/${id}`, { method: "DELETE" }),
  materials: (subjectId: number) => req<Material[]>(`/api/subjects/${subjectId}/materials`),
  uploadMaterial: (subjectId: number, form: FormData) =>
    req<{ id: number; status: string }>(`/api/subjects/${subjectId}/materials`, { method: "POST", body: form }),
  retryMaterial: (id: number) => req(`/api/materials/${id}/retry`, { method: "POST" }),
  deleteMaterial: (id: number) => req(`/api/materials/${id}`, { method: "DELETE" }),
  messages: (subjectId: number) => req<Message[]>(`/api/subjects/${subjectId}/messages`),
  chat: (subjectId: number, message: string) =>
    req<{ reply: string }>(`/api/subjects/${subjectId}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) })
};
```

- [ ] **Step 5: 배경 캔버스 (`web/src/Sky.tsx`)**

목업 v3의 sky 캔버스 코드(별 150개 트윙클, 성운 그라데이션 2개, 유성, 마우스 패럴랙스)를 React 컴포넌트로 이식. 별자리 노드/링크 부분은 제외(2단계 개념 탭에서 추가). `useEffect`로 rAF 루프 시작, cleanup에서 `cancelAnimationFrame`. `position: fixed; inset: 0; z-index: 0`.

- [ ] **Step 6: 페이지 컴포넌트**

`web/src/pages/Login.tsx`:

```tsx
import { useState } from "react";
import { api } from "../api";

export function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const submit = async () => {
    try { await api.login(pw); onDone(); }
    catch { setErr("비밀번호가 틀렸습니다"); }
  };
  return (
    <div className="login-wrap">
      <div className="card login-box">
        <div className="brand">Study<em>Work</em></div>
        <input type="password" value={pw} placeholder="비밀번호"
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()} autoFocus />
        {err && <div style={{ color: "var(--bad)", fontSize: 13, marginBottom: 12 }}>{err}</div>}
        <button className="btn" onClick={submit} style={{ width: "100%" }}>들어가기</button>
      </div>
    </div>
  );
}
```

`web/src/pages/Subjects.tsx` — 과목 글로우 카드 그리드 + 추가/삭제:

```tsx
import { useEffect, useState } from "react";
import { api, Subject } from "../api";

const COLORS = ["#6cd8ff", "#7ef0c3", "#ffb37d", "#ff8fb8", "#c9a2ff", "#ffe08a"];

export function Subjects({ onOpen }: { onOpen: (s: Subject) => void }) {
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");

  const load = () => api.subjects().then(setSubjects);
  useEffect(() => { load(); }, []);

  const add = async () => {
    if (!name.trim()) return;
    await api.createSubject(name.trim(), COLORS[subjects.length % COLORS.length]);
    setName(""); setAdding(false); load();
  };

  return (
    <section className="page on">
      <div className="crumb">과목</div>
      <h1>과목 {subjects.length}</h1>
      <div className="grid">
        {subjects.map((s) => (
          <div key={s.id} className="card clickable subj-card" onClick={() => onOpen(s)}>
            <div className="c-dot" style={{ background: s.color }} />
            <div className="c-title">{s.name}</div>
            <div className="c-meta"><span>자료 {s.material_count}</span></div>
          </div>
        ))}
        <div className="card clickable subj-card add" onClick={() => setAdding(true)}>
          {adding ? (
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()} placeholder="과목 이름"
              onClick={(e) => e.stopPropagation()} />
          ) : <span>+ 과목 추가</span>}
        </div>
      </div>
    </section>
  );
}
```

(`.subj-card`, `.c-dot` 스타일은 styles.css에 추가: 카드 패딩 24px, `.c-dot`은 12px 원형.)

`web/src/pages/SubjectDetail.tsx` — 자료 목록/업로드 + 채팅. 상단에 과목명, 좌측(또는 상단 토글) 자료 패널, 본문 채팅:

```tsx
import { useEffect, useRef, useState } from "react";
import { api, Subject, Material, Message } from "../api";

export function SubjectDetail({ subject, onBack }: { subject: Subject; onBack: () => void }) {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const load = () => {
    api.materials(subject.id).then(setMaterials);
    api.messages(subject.id).then(setMessages);
  };
  useEffect(() => { load(); }, [subject.id]);
  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight); }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true); setError(""); setInput("");
    setMessages((m) => [...m, { id: -1, role: "user", content: text }]);
    try {
      const { reply } = await api.chat(subject.id, text);
      setMessages((m) => [...m, { id: -2, role: "assistant", content: reply }]);
    } catch (e: any) {
      setError(e.message); setInput(text);
      setMessages((m) => m.slice(0, -1));
    } finally { setBusy(false); }
  };

  const upload = async (file?: File, text?: string, title?: string) => {
    setUploading(true); setError("");
    const form = new FormData();
    form.set("title", title || file?.name || "제목 없음");
    if (file) form.set("file", file);
    if (text) form.set("text", text);
    try { await api.uploadMaterial(subject.id, form); load(); }
    catch (e: any) { setError(e.message); }
    finally { setUploading(false); }
  };

  return (
    <section className="page on">
      <div className="crumb clickable" onClick={onBack}>← 과목</div>
      <h1>{subject.name}</h1>
      <div className="sub">자료 {materials.length} · 대화 {messages.length}</div>

      <div className="detail-grid">
        <aside className="card panel">
          <h3>자료</h3>
          {materials.map((m) => (
            <div key={m.id} className="mat-row">
              <span className="mat-kind">{m.kind === "image" ? "사진" : m.kind === "pdf" ? "PDF" : "텍스트"}</span>
              <span className="mat-title">{m.title}</span>
              {m.status === "error" && (
                <button className="mini" onClick={() => api.retryMaterial(m.id).then(load)}>재시도</button>
              )}
              <button className="mini" onClick={() => api.deleteMaterial(m.id).then(load)}>✕</button>
            </div>
          ))}
          <input ref={fileRef} type="file" accept="image/*,application/pdf" hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
          <button className="btn" style={{ width: "100%", marginTop: 12 }}
            disabled={uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? "분석 중..." : "사진/PDF 업로드"}
          </button>
          <button className="btn" style={{ width: "100%", marginTop: 8 }}
            onClick={() => {
              const text = prompt("텍스트 자료 내용");
              if (text) upload(undefined, text, prompt("제목") || undefined);
            }}>텍스트 추가</button>
        </aside>

        <div className="chat-col">
          <div className="chat-log" ref={logRef}>
            {messages.map((m, i) =>
              m.role === "user"
                ? <div key={i} className="msg-user">{m.content}</div>
                : <div key={i} className="msg-ai">{m.content}</div>
            )}
            {busy && <div className="msg-ai">…</div>}
          </div>
          {error && <div style={{ color: "var(--bad)", fontSize: 13, margin: "8px 0" }}>{error}</div>}
          <div className="chat-input-row">
            <textarea rows={2} value={input} placeholder="질문 입력"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
            <button className="btn" disabled={busy} onClick={send}>전송</button>
          </div>
        </div>
      </div>
    </section>
  );
}
```

(`.detail-grid { display:grid; grid-template-columns: 300px 1fr; gap: 20px; margin-top: 30px; align-items: start; }`, `.mat-row`/`.mini` 스타일 추가. 모바일(≤720px)에서는 `grid-template-columns: 1fr`.)

- [ ] **Step 7: `web/src/App.tsx` + `main.tsx`**

```tsx
// App.tsx
import { useEffect, useState } from "react";
import { Sky } from "./Sky";
import { Login } from "./pages/Login";
import { Subjects } from "./pages/Subjects";
import { SubjectDetail } from "./pages/SubjectDetail";
import { api, Subject } from "./api";

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [current, setCurrent] = useState<Subject | null>(null);

  useEffect(() => {
    api.subjects().then(() => setAuthed(true)).catch(() => setAuthed(false));
  }, []);

  // 글로우 카드 마우스 추적 (목업 v3와 동일)
  useEffect(() => {
    const fn = (e: MouseEvent) => {
      document.querySelectorAll<HTMLElement>(".card").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (e.clientX >= r.left - 60 && e.clientX <= r.right + 60 && e.clientY >= r.top - 60 && e.clientY <= r.bottom + 60) {
          el.style.setProperty("--mx", e.clientX - r.left + "px");
          el.style.setProperty("--my", e.clientY - r.top + "px");
        }
      });
    };
    document.addEventListener("mousemove", fn);
    return () => document.removeEventListener("mousemove", fn);
  }, []);

  if (authed === null) return null;
  return (
    <>
      <Sky />
      <div className="grain" />
      {!authed ? (
        <Login onDone={() => setAuthed(true)} />
      ) : (
        <>
          <nav>
            <div className="brand clickable" onClick={() => setCurrent(null)}>Study<em>Work</em></div>
          </nav>
          {current
            ? <SubjectDetail subject={current} onBack={() => setCurrent(null)} />
            : <Subjects onOpen={setCurrent} />}
        </>
      )}
    </>
  );
}
```

```tsx
// main.tsx
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
```

- [ ] **Step 8: 빌드 확인**

Run: `npm run build:web && npx tsc --noEmit`
Expected: 빌드 성공, 타입 에러 없음

- [ ] **Step 9: 로컬 수동 검증**

Run: `npx wrangler dev` 후 브라우저에서 http://localhost:8787
확인 항목: 로그인 → 과목 추가 → 텍스트 자료 추가 → (dev에선 D1/R2 로컬 에뮬레이션) 카드 글로우 호버 동작
(Claude 호출 경로는 시크릿 없으면 에러 표시가 정상 — 에러 UI가 뜨는지만 확인)

로컬 시크릿: 프로젝트 루트에 `.dev.vars` 생성 (gitignore 대상):

```
ANTHROPIC_API_KEY=sk-ant-...
APP_PASSWORD=원하는비밀번호
AUTH_SECRET=랜덤긴문자열
```

`.gitignore`에 `.dev.vars`, `node_modules/`, `web/dist/` 추가.

- [ ] **Step 10: 커밋**

```bash
git add -A && git commit -m "프론트엔드: 로그인·과목 그리드·자료 업로드·채팅 (별자리 다크 UI)"
```

---

### Task 9: 배포

**Files:**
- Modify: `wrangler.jsonc` (database_id 반영)

- [ ] **Step 1: 리소스 생성**

```bash
npx wrangler d1 create studywork          # 출력된 database_id를 wrangler.jsonc에 반영
npx wrangler r2 bucket create studywork-files
npx wrangler d1 migrations apply studywork --remote
```

- [ ] **Step 2: 시크릿 등록** (사용자에게 API 키·비밀번호 입력 요청)

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put APP_PASSWORD
npx wrangler secret put AUTH_SECRET   # 랜덤: openssl rand -hex 32
```

- [ ] **Step 3: 배포 + 확인**

```bash
npm run deploy
```

배포 URL 접속 → 로그인 → 과목 생성 → 사진 업로드 → 추출 확인 → 채팅 1회 왕복 확인.

- [ ] **Step 4: 커밋**

```bash
git add -A && git commit -m "배포 설정: D1 database_id 반영"
```

---

## 이후 단계 (이 계획 범위 밖)

- 2단계: 퀴즈 (출제 소스 선택·난이도·PDF 내보내기) — 별도 계획
- 3단계: 오답 노트 — 별도 계획
- 4단계: 시험 계획 — 별도 계획
- 개선 후보: 채팅 스트리밍(SSE), 자료 많아질 때 Vectorize 검색, 개념 별자리 탭
