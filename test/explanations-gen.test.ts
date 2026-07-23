// AI 해설 채우기 — 라우트 계약(작업 생성·상태·완료 카운트), 검산(불일치는 저장 안 함),
// 배치 체크포인트 재개, 단일 문제 라우트를 검증한다. AI는 quiz.test.ts처럼 모듈 모킹.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { makeEnv, call } from "./helpers";
import { EXPLANATION_BATCH_SIZE } from "../src/explanations-gen";

const explanationCalls = vi.hoisted(() => [] as number[][]);
const control = vi.hoisted(() => ({
  callCount: 0,
  failOnCall: null as number | null, // n번째 호출을 실패시킨다 (1-base)
  mismatchIds: new Set<number>(),    // 이 id들은 틀린 derived_answer를 돌려준다
  holdAll: null as Promise<void> | null, // 설정 시 모든 호출이 이 게이트를 기다린다 (동시성 테스트)
}));

vi.mock("../src/claude", () => ({
  generateExplanationsForQuestions: async (
    _subjectName: string,
    tasks: { id: number; answer: string }[]
  ) => {
    control.callCount++;
    explanationCalls.push(tasks.map((task) => task.id));
    if (control.holdAll) await control.holdAll;
    if (control.failOnCall === control.callCount) throw new Error("모의 배치 실패");
    return tasks.map((task) => ({
      id: task.id,
      derived_answer: control.mismatchIds.has(task.id) ? "완전히 다른 답" : task.answer,
      explanation: `AI 해설 ${task.id}`,
    }));
  },
}));

const env = makeEnv();
let cookie: string;
let subjectId: number;
let fileId: number;

async function waitAIJob(jobId: number): Promise<{
  status: "processing" | "ready" | "error";
  result: { filled: number; skippedMismatch: number; skippedIds: number[] } | null;
  error: string | null;
}> {
  for (let i = 0; i < 100; i++) {
    const res = await call(env, `/api/ai-jobs/${jobId}`, { headers: { cookie } });
    const job = await res.json() as {
      status: "processing" | "ready" | "error";
      result: { filled: number; skippedMismatch: number; skippedIds: number[] } | null;
      error: string | null;
    };
    if (job.status !== "processing") return job;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("AI job timeout");
}

async function insertQuestion(opts: {
  answer?: string;
  explanation?: string;
  srcFileId?: number | null;
}): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO questions (subject_id, source, qtype, difficulty, question, choices, answer, explanation, src_file_id)
     VALUES (?, 'uploaded', 'short', '중', '문제', NULL, ?, ?, ?) RETURNING id`
  ).bind(subjectId, opts.answer ?? "42", opts.explanation ?? "", opts.srcFileId ?? null)
    .first<{ id: number }>();
  return row!.id;
}

async function explanationOf(id: number): Promise<string> {
  const row = await env.DB.prepare("SELECT explanation FROM questions WHERE id = ?")
    .bind(id).first<{ explanation: string }>();
  return row!.explanation;
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
    body: JSON.stringify({ name: "수학" }),
  });
  subjectId = ((await created.json()) as { id: number }).id;

  const book = await env.DB.prepare(
    "INSERT INTO books (subject_id, title) VALUES (?, '문제집') RETURNING id"
  ).bind(subjectId).first<{ id: number }>();
  const file = await env.DB.prepare(
    "INSERT INTO book_files (book_id, name, r2_key, mime, status) VALUES (?, '문제집.pdf', 'k', 'application/pdf', 'ready') RETURNING id"
  ).bind(book!.id).first<{ id: number }>();
  fileId = file!.id;
});

beforeEach(async () => {
  explanationCalls.length = 0;
  control.callCount = 0;
  control.failOnCall = null;
  control.mismatchIds.clear();
  control.holdAll = null;
  await env.DB.prepare("DELETE FROM questions").run();
});

describe("GET /api/subjects/:id/explanations/missing", () => {
  it("출처별로 빈 해설 수를 집계하고, 해설 있는 문제는 세지 않는다", async () => {
    await insertQuestion({ srcFileId: fileId });
    await insertQuestion({ srcFileId: fileId });
    await insertQuestion({});
    await insertQuestion({ explanation: "이미 있음", srcFileId: fileId });

    const res = await call(env, `/api/subjects/${subjectId}/explanations/missing`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const groups = await res.json() as { src_file_id: number | null; src_file_name: string | null; missing: number }[];
    expect(groups).toEqual([
      { src_file_id: fileId, src_file_name: "문제집.pdf", missing: 2 },
      { src_file_id: null, src_file_name: null, missing: 1 },
    ]);
  });

  it("삭제된 원본 파일의 문제는 직접 생성·기타(null) 그룹으로 합친다", async () => {
    await insertQuestion({ srcFileId: 999_999 });
    const res = await call(env, `/api/subjects/${subjectId}/explanations/missing`, { headers: { cookie } });
    const groups = await res.json() as { src_file_id: number | null; missing: number }[];
    expect(groups).toEqual([{ src_file_id: null, src_file_name: null, missing: 1 }]);
  });

  it("인증 없이는 401", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/explanations/missing`);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/subjects/:id/explanations/generate", () => {
  it("작업을 만들고, 검산 일치분만 저장하며 불일치는 건너뛰어 카운트한다", async () => {
    const ok1 = await insertQuestion({ answer: "정답A" });
    const bad = await insertQuestion({ answer: "정답B" });
    const ok2 = await insertQuestion({ answer: "정답C" });
    control.mismatchIds.add(bad);

    const res = await call(env, `/api/subjects/${subjectId}/explanations/generate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(202);
    const { jobId } = await res.json() as { jobId: number };

    const job = await waitAIJob(jobId);
    expect(job.status).toBe("ready");
    expect(job.result).toEqual({ filled: 2, skippedMismatch: 1, skippedIds: [bad] });
    expect(await explanationOf(ok1)).toBe(`AI 해설 ${ok1}`);
    expect(await explanationOf(ok2)).toBe(`AI 해설 ${ok2}`);
    expect(await explanationOf(bad)).toBe(""); // 불일치 해설은 DB에 절대 들어가지 않는다
  });

  it("배치 실패 시 앞 배치까지는 저장되고, 재실행은 남은 문제만 이어서 처리한다", async () => {
    const ids: number[] = [];
    for (let i = 0; i < EXPLANATION_BATCH_SIZE + 2; i++) ids.push(await insertQuestion({ answer: `답${i}` }));
    control.failOnCall = 2; // 1차 배치 저장 후 2차 배치에서 실패

    const first = await call(env, `/api/subjects/${subjectId}/explanations/generate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const firstJob = await waitAIJob(((await first.json()) as { jobId: number }).jobId);
    expect(firstJob.status).toBe("error");
    expect(explanationCalls).toEqual([ids.slice(0, EXPLANATION_BATCH_SIZE), ids.slice(EXPLANATION_BATCH_SIZE)]);
    for (const id of ids.slice(0, EXPLANATION_BATCH_SIZE)) expect(await explanationOf(id)).toBe(`AI 해설 ${id}`); // 체크포인트
    for (const id of ids.slice(EXPLANATION_BATCH_SIZE)) expect(await explanationOf(id)).toBe("");

    // 재실행 — 빈 해설 조회가 남은 2문항만 뽑아 이어서 진행한다
    const second = await call(env, `/api/subjects/${subjectId}/explanations/generate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const secondJob = await waitAIJob(((await second.json()) as { jobId: number }).jobId);
    expect(secondJob.status).toBe("ready");
    expect(secondJob.result).toEqual({ filled: 2, skippedMismatch: 0, skippedIds: [] });
    expect(explanationCalls[2]).toEqual(ids.slice(EXPLANATION_BATCH_SIZE));
    for (const id of ids) expect(await explanationOf(id)).toBe(`AI 해설 ${id}`);
  });

  it("srcFileId 범위는 해당 파일 문제만, manual은 파일 없는 문제만 처리한다", async () => {
    const fromFile = await insertQuestion({ srcFileId: fileId });
    const manual = await insertQuestion({});

    const scoped = await call(env, `/api/subjects/${subjectId}/explanations/generate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ srcFileId: fileId }),
    });
    expect((await waitAIJob(((await scoped.json()) as { jobId: number }).jobId)).status).toBe("ready");
    expect(explanationCalls).toEqual([[fromFile]]);
    expect(await explanationOf(manual)).toBe("");

    const manualRun = await call(env, `/api/subjects/${subjectId}/explanations/generate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ manual: true }),
    });
    expect((await waitAIJob(((await manualRun.json()) as { jobId: number }).jobId)).status).toBe("ready");
    expect(explanationCalls[1]).toEqual([manual]);
    expect(await explanationOf(manual)).toBe(`AI 해설 ${manual}`);
  });

  it("다른 파일 두 개는 동시에 돌고, 같은 파일 중복 요청만 409", async () => {
    const book = await env.DB.prepare(
      "INSERT INTO books (subject_id, title) VALUES (?, '문제집2') RETURNING id"
    ).bind(subjectId).first<{ id: number }>();
    const file2 = (await env.DB.prepare(
      "INSERT INTO book_files (book_id, name, r2_key, mime, status) VALUES (?, '문제집2.pdf', 'k2', 'application/pdf', 'ready') RETURNING id"
    ).bind(book!.id).first<{ id: number }>())!.id;
    const q1 = await insertQuestion({ srcFileId: fileId, answer: "답1" });
    const q2 = await insertQuestion({ srcFileId: file2, answer: "답2" });

    let release!: () => void;
    control.holdAll = new Promise<void>((resolve) => { release = resolve; });

    const startFor = (srcFileId: number) => call(env, `/api/subjects/${subjectId}/explanations/generate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ srcFileId }),
    });

    const first = await startFor(fileId);
    expect(first.status).toBe(202);
    const firstJobId = ((await first.json()) as { jobId: number }).jobId;

    // 같은 파일 → 409, 다른 파일 → 202 (동시 실행)
    expect((await startFor(fileId)).status).toBe(409);
    const second = await startFor(file2);
    expect(second.status).toBe(202);
    const secondJobId = ((await second.json()) as { jobId: number }).jobId;

    release();
    control.holdAll = null;
    const firstJob = await waitAIJob(firstJobId);
    const secondJob = await waitAIJob(secondJobId);
    expect(firstJob.status).toBe("ready");
    expect(firstJob.result).toEqual({ filled: 1, skippedMismatch: 0, skippedIds: [] });
    expect(secondJob.status).toBe("ready");
    expect(secondJob.result).toEqual({ filled: 1, skippedMismatch: 0, skippedIds: [] });
    expect(await explanationOf(q1)).toBe(`AI 해설 ${q1}`);
    expect(await explanationOf(q2)).toBe(`AI 해설 ${q2}`);

    // 작업이 끝나면 같은 파일 대상도 다시 시작할 수 있다
    await insertQuestion({ srcFileId: fileId, answer: "답3" });
    const again = await startFor(fileId);
    expect(again.status).toBe(202);
    expect((await waitAIJob(((await again.json()) as { jobId: number }).jobId)).status).toBe("ready");
  });

  it("빈 해설 문제가 없으면 400, 없는 과목은 404, 잘못된 본문은 400", async () => {
    await insertQuestion({ explanation: "있음" });
    const empty = await call(env, `/api/subjects/${subjectId}/explanations/generate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);

    const missingSubject = await call(env, "/api/subjects/999999/explanations/generate", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missingSubject.status).toBe(404);

    const badSrc = await call(env, `/api/subjects/${subjectId}/explanations/generate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ srcFileId: 0 }),
    });
    expect(badSrc.status).toBe(400);

    const bothScopes = await call(env, `/api/subjects/${subjectId}/explanations/generate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ srcFileId: 1, manual: true }),
    });
    expect(bothScopes.status).toBe(400);
  });
});

describe("POST /api/questions/:id/explanation/generate", () => {
  it("검산이 일치하면 저장하고 해설을 돌려준다", async () => {
    const id = await insertQuestion({ answer: "정답" });
    const res = await call(env, `/api/questions/${id}/explanation/generate`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ filled: true, explanation: `AI 해설 ${id}` });
    expect(await explanationOf(id)).toBe(`AI 해설 ${id}`);
  });

  it("정답 불일치면 filled:false로 답하고 DB에 저장하지 않는다", async () => {
    const id = await insertQuestion({ answer: "정답" });
    control.mismatchIds.add(id);
    const res = await call(env, `/api/questions/${id}/explanation/generate`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ filled: false });
    expect(await explanationOf(id)).toBe("");
  });

  it("이미 해설이 있으면 409, 없는 문제는 404, AI 실패는 502", async () => {
    const has = await insertQuestion({ explanation: "있음" });
    expect((await call(env, `/api/questions/${has}/explanation/generate`, {
      method: "POST", headers: { cookie },
    })).status).toBe(409);

    expect((await call(env, "/api/questions/999999/explanation/generate", {
      method: "POST", headers: { cookie },
    })).status).toBe(404);

    const id = await insertQuestion({});
    control.failOnCall = 1;
    expect((await call(env, `/api/questions/${id}/explanation/generate`, {
      method: "POST", headers: { cookie },
    })).status).toBe(502);
    expect(await explanationOf(id)).toBe("");
  });
});
