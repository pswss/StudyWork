// GET /api/subjects/:id/jobs — 작업 트레이 목록 계약.
// 진행 중 작업의 kind·label·target·elapsed_s 노출, 완료 후 recent 잔류,
// 단권화(notes.status) 합성 행, 인증 401을 검증한다. AI는 모듈 모킹.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { makeEnv, call } from "./helpers";

const control = vi.hoisted(() => ({ hold: null as Promise<void> | null }));

vi.mock("../src/claude", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/claude")>()),
  generateExplanationsForQuestions: async (
    _subjectName: string,
    tasks: { id: number; answer: string }[]
  ) => {
    if (control.hold) await control.hold;
    return tasks.map((task) => ({ id: task.id, derived_answer: task.answer, explanation: "해설" }));
  },
}));

interface JobRow {
  id: number | null;
  kind: string;
  label: string | null;
  target: string | null;
  status: "processing" | "ready" | "error";
  elapsed_s: number;
  progress: number | null;
}

const env = makeEnv();
let cookie: string;
let subjectId: number;
let fileId: number;

async function listJobs(): Promise<JobRow[]> {
  const res = await call(env, `/api/subjects/${subjectId}/jobs`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return res.json() as Promise<JobRow[]>;
}

async function waitAIJob(jobId: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const res = await call(env, `/api/ai-jobs/${jobId}`, { headers: { cookie } });
    const job = await res.json() as { status: string };
    if (job.status !== "processing") return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("AI job timeout");
}

beforeAll(async () => {
  const login = await call(env, "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-password" }),
  });
  cookie = login.headers.get("set-cookie")!.split(";")[0];

  const created = await call(env, "/api/subjects", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "과학" }),
  });
  subjectId = ((await created.json()) as { id: number }).id;

  const book = await env.DB.prepare(
    "INSERT INTO books (subject_id, title) VALUES (?, '문제집') RETURNING id"
  ).bind(subjectId).first<{ id: number }>();
  fileId = (await env.DB.prepare(
    "INSERT INTO book_files (book_id, name, r2_key, mime, status) VALUES (?, '문제집.pdf', 'k', 'application/pdf', 'ready') RETURNING id"
  ).bind(book!.id).first<{ id: number }>())!.id;
});

describe("GET /api/subjects/:id/jobs", () => {
  it("인증 없이는 401", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/jobs`);
    expect(res.status).toBe(401);
  });

  it("진행 중 작업을 kind·label·target·elapsed_s와 함께 나열하고, 완료 후에는 ready로 남는다", async () => {
    await env.DB.prepare(
      `INSERT INTO questions (subject_id, source, qtype, difficulty, question, choices, answer, explanation, src_file_id)
       VALUES (?, 'uploaded', 'short', '중', '문제', NULL, '42', '', ?)`
    ).bind(subjectId, fileId).run();

    let release!: () => void;
    control.hold = new Promise<void>((resolve) => { release = resolve; });
    const started = await call(env, `/api/subjects/${subjectId}/explanations/generate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ srcFileId: fileId }),
    });
    expect(started.status).toBe(202);
    const { jobId } = await started.json() as { jobId: number };

    const running = (await listJobs()).find((row) => row.id === jobId);
    expect(running).toMatchObject({
      id: jobId,
      kind: "explanation-generate",
      label: "문제집.pdf",
      target: `file:${fileId}`,
      status: "processing",
      progress: 0,
    });
    expect(typeof running!.elapsed_s).toBe("number");
    expect(running!.elapsed_s).toBeGreaterThanOrEqual(0);

    release();
    control.hold = null;
    await waitAIJob(jobId);

    // 최근(5분) 완료 작업은 상태만 ready로 바뀐 채 목록에 남는다
    const done = (await listJobs()).find((row) => row.id === jobId);
    expect(done?.status).toBe("ready");
  });

  it("단권화 진행은 id 없는 합성 행으로 나타난다", async () => {
    await env.DB.prepare(
      "INSERT INTO notes (subject_id, content, status, progress, updated_at) VALUES (?, '', 'processing', 40, datetime('now'))"
    ).bind(subjectId).run();
    try {
      const note = (await listJobs()).find((row) => row.kind === "consolidate");
      expect(note).toMatchObject({
        id: null,
        kind: "consolidate",
        label: "단권화 노트",
        target: "note",
        status: "processing",
        progress: 40,
      });
      expect(note!.elapsed_s).toBeGreaterThanOrEqual(0);
    } finally {
      await env.DB.prepare("DELETE FROM notes WHERE subject_id = ?").bind(subjectId).run();
    }
  });
});
