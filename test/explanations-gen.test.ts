// AI 해설 채우기 — 라우트 계약(작업 생성·상태·완료 카운트), 검산(불일치는 저장 안 함),
// 배치 체크포인트 재개, 단일 문제 라우트를 검증한다. AI는 quiz.test.ts처럼 모듈 모킹.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { makeEnv, call } from "./helpers";
import { EXPLANATION_BATCH_SIZE, EXPLANATION_EFFORT_LADDER } from "../src/explanations-gen";
import { BULK_AI_PARALLELISM } from "../src/codex-provider";
import { createFigureBundlePdf } from "../src/book-page-image";

const explanationCalls = vi.hoisted(() => [] as number[][]);
const explanationEfforts = vi.hoisted(() => [] as string[]);
const figureCalls = vi.hoisted(() => [] as Array<{
  tasks: Array<{ id: number; visual_ref: string | null; figure_description: string | null }>;
  path: string;
  pageCount: number;
}>);
const control = vi.hoisted(() => ({
  callCount: 0,
  failIds: new Set<number>(),        // 이 id가 포함된 호출은 모든 effort에서 실패한다
  mismatchIds: new Set<number>(),    // 이 id들은 틀린 derived_answer를 돌려준다
  matchAtEffort: new Map<number, string>(),
  holdAll: null as Promise<void> | null, // 설정 시 모든 호출이 이 게이트를 기다린다 (동시성 테스트)
  holdCall: null as { number: number; wait: Promise<void> } | null,
}));

vi.mock("../src/claude", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/claude")>()),
  generateExplanationsForQuestions: async (
    _subjectName: string,
    tasks: { id: number; answer: string }[],
    _signal?: AbortSignal,
    _lane?: "bulk",
    reasoningEffort = "high",
    figureFilePath?: string
  ) => {
    control.callCount++;
    explanationCalls.push(tasks.map((task) => task.id));
    explanationEfforts.push(reasoningEffort);
    if (figureFilePath) {
      const document = await PDFDocument.load(readFileSync(figureFilePath));
      figureCalls.push({
        tasks: tasks.map((task) => ({
          id: task.id,
          visual_ref: "visual_ref" in task && typeof task.visual_ref === "string"
            ? task.visual_ref
            : null,
          figure_description: "figure_description" in task && typeof task.figure_description === "string"
            ? task.figure_description
            : null,
        })),
        path: figureFilePath,
        pageCount: document.getPageCount(),
      });
    }
    if (control.holdAll) await control.holdAll;
    if (control.holdCall?.number === control.callCount) await control.holdCall.wait;
    if (tasks.some((task) => control.failIds.has(task.id))) throw new Error("모의 배치 실패");
    return tasks.map((task) => ({
      id: task.id,
      derived_answer:
        control.mismatchIds.has(task.id) ||
        EXPLANATION_EFFORT_LADDER.indexOf(reasoningEffort as (typeof EXPLANATION_EFFORT_LADDER)[number]) <
          EXPLANATION_EFFORT_LADDER.indexOf(
            control.matchAtEffort.get(task.id) as (typeof EXPLANATION_EFFORT_LADDER)[number]
          )
          ? "완전히 다른 답"
          : task.answer,
      explanation: `AI 해설 ${task.id}`,
    }));
  },
}));

const env = makeEnv();
let cookie: string;
let subjectId: number;
let fileId: number;
let figureFileId: number;

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
  hasFigure?: boolean;
  srcPage?: number | null;
  figureBox?: string | null;
  figureDescription?: string | null;
}): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO questions
       (subject_id, source, qtype, difficulty, question, choices, answer, explanation,
        src_file_id, src_page, has_figure, figure_box, figure_description)
     VALUES (?, 'uploaded', 'short', '중', '문제', NULL, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(
    subjectId,
    opts.answer ?? "42",
    opts.explanation ?? "",
    opts.srcFileId ?? null,
    opts.srcPage ?? (opts.srcFileId == null ? null : 1),
    opts.hasFigure ? 1 : 0,
    opts.figureBox ?? null,
    opts.figureDescription ?? null
  )
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
  const sourcePdf = await PDFDocument.create();
  sourcePdf.addPage([100, 100]);
  const sourcePdfBytes = await sourcePdf.save();
  await env.FILES.put(
    "k",
    sourcePdfBytes.buffer.slice(
      sourcePdfBytes.byteOffset,
      sourcePdfBytes.byteOffset + sourcePdfBytes.byteLength
    ) as ArrayBuffer
  );

  const figureFile = await env.DB.prepare(
    "INSERT INTO book_files (book_id, name, r2_key, mime, status) VALUES (?, '그림.png', 'figure.png', 'image/png', 'ready') RETURNING id"
  ).bind(book!.id).first<{ id: number }>();
  figureFileId = figureFile!.id;
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  const pngBuffer = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
  await env.FILES.put("figure.png", pngBuffer);
  await env.FILES.put(`pages/${figureFileId}-1-0.1-0.9.png`, pngBuffer);
});

beforeEach(async () => {
  explanationCalls.length = 0;
  explanationEfforts.length = 0;
  figureCalls.length = 0;
  control.callCount = 0;
  control.failIds.clear();
  control.mismatchIds.clear();
  control.matchAtEffort.clear();
  control.holdAll = null;
  control.holdCall = null;
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

  it("삭제된 원본 파일의 일반 문제는 직접 생성·기타(null)로 합쳐 텍스트만으로 처리한다", async () => {
    const id = await insertQuestion({ srcFileId: 999_999 });
    const res = await call(env, `/api/subjects/${subjectId}/explanations/missing`, { headers: { cookie } });
    const groups = await res.json() as { src_file_id: number | null; missing: number }[];
    expect(groups).toEqual([{ src_file_id: null, src_file_name: null, missing: 1 }]);

    const generated = await call(env, `/api/subjects/${subjectId}/explanations/generate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ manual: true }),
    });
    expect((await waitAIJob(((await generated.json()) as { jobId: number }).jobId)).status).toBe("ready");
    expect(figureCalls).toHaveLength(0);
    expect(await explanationOf(id)).toBe(`AI 해설 ${id}`);
  });

  it("인증 없이는 401", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/explanations/missing`);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/subjects/:id/explanations/generate", () => {
  it("같은 원본 페이지의 서로 다른 crop을 별도 라벨 페이지로 묶는다", async () => {
    const png = await env.FILES.get(`pages/${figureFileId}-1-0.1-0.9.png`);
    if (!png) throw new Error("그림 fixture 없음");
    await env.FILES.put(
      `pages/${figureFileId}-1-0.1-0.4.png`,
      png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer
    );
    await env.FILES.put(
      `pages/${figureFileId}-1-0.6-0.9.png`,
      png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer
    );
    const source = { id: figureFileId, r2_key: "없는-원본", mime: "image/png" };
    const bundle = await createFigureBundlePdf(env.FILES, [
      { id: 101, source, page: 1, box: [0.1, 0.4] },
      { id: 102, source, page: 1, box: [0.6, 0.9] },
    ]);
    if (!bundle) throw new Error("그림 묶음 없음");

    expect((await PDFDocument.load(readFileSync(bundle.path))).getPageCount()).toBe(2);
    bundle.cleanup();
    expect(existsSync(bundle.path)).toBe(false);
  });

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

  it("불일치 문항만 high → xhigh → max → ultra로 올려 다시 푼다", async () => {
    const high = await insertQuestion({ answer: "정답A" });
    const xhigh = await insertQuestion({ answer: "정답B" });
    const ultra = await insertQuestion({
      answer: "정답C",
      srcFileId: figureFileId,
      hasFigure: true,
      srcPage: 1,
      figureBox: "0.1,0.9",
      figureDescription: "좌표평면의 그래프",
    });
    for (let i = 0; i < BULK_AI_PARALLELISM * 2 - 2; i++) {
      await insertQuestion({ answer: `정답${i}` });
    }
    control.matchAtEffort.set(xhigh, "xhigh");
    control.matchAtEffort.set(ultra, "ultra");

    const res = await call(env, `/api/subjects/${subjectId}/explanations/generate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const job = await waitAIJob(((await res.json()) as { jobId: number }).jobId);

    expect(job.result).toEqual({
      filled: BULK_AI_PARALLELISM * 2 + 1,
      skippedMismatch: 0,
      skippedIds: [],
    });
    expect(explanationCalls.map((ids, index) => ({
      ids,
      effort: explanationEfforts[index],
    })).filter(({ ids }) => ids.some((id) => id === high || id === xhigh || id === ultra))).toEqual([
      { ids: [high, xhigh, ultra], effort: "high" },
      { ids: [xhigh, ultra], effort: "xhigh" },
      { ids: [ultra], effort: "max" },
      { ids: [ultra], effort: "ultra" },
    ]);
    expect(figureCalls).toHaveLength(EXPLANATION_EFFORT_LADDER.length);
    expect(figureCalls.every((call) =>
      call.pageCount === 1 &&
      call.tasks.find((task) => task.id === ultra)?.visual_ref === `QUESTION_ID ${ultra}` &&
      !existsSync(call.path)
    )).toBe(true);
  });

  it("figureOnly는 그림 문항만 20개 섹션으로 처리하고 crop 묶음을 첨부", async () => {
    const figureIds: number[] = [];
    for (let i = 0; i < BULK_AI_PARALLELISM + 1; i++) {
      figureIds.push(await insertQuestion({
        answer: `그림답${i}`,
        srcFileId: figureFileId,
        hasFigure: true,
        srcPage: 1,
        figureBox: "0.1,0.9",
        figureDescription: `그림 설명 ${i}`,
      }));
    }
    const nonFigure = await insertQuestion({ answer: "일반답", srcFileId: figureFileId });

    const res = await call(env, `/api/subjects/${subjectId}/explanations/generate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ figureOnly: true }),
    });
    expect(res.status).toBe(202);
    const job = await waitAIJob(((await res.json()) as { jobId: number }).jobId);

    expect(job.result).toEqual({ filled: figureIds.length, skippedMismatch: 0, skippedIds: [] });
    expect(await explanationOf(nonFigure)).toBe("");
    expect(explanationCalls).toHaveLength(BULK_AI_PARALLELISM);
    expect(figureCalls.map((call) => call.pageCount).sort((a, b) => a - b)).toEqual([
      ...Array(BULK_AI_PARALLELISM - 1).fill(1),
      2,
    ]);
    expect(figureCalls.flatMap((call) => call.tasks.map((task) => task.id)).sort((a, b) => a - b))
      .toEqual([...figureIds].sort((a, b) => a - b));
    expect(figureCalls.every((call) =>
      call.tasks.every((task) =>
        task.visual_ref === `QUESTION_ID ${task.id}` &&
        task.figure_description?.startsWith("그림 설명")
      ) && !existsSync(call.path)
    )).toBe(true);
  });

  it("한 섹션 실패 시 성공 섹션은 저장되고, 재실행은 실패 문항만 이어서 처리한다", async () => {
    const ids: number[] = [];
    for (let i = 0; i < BULK_AI_PARALLELISM * EXPLANATION_BATCH_SIZE + 1; i++) {
      ids.push(await insertQuestion({ answer: `답${i}` }));
    }
    // 첫 섹션의 20문항 체크포인트 뒤 남은 1문항을 모든 effort에서 실패시킨다.
    const failedIds = [ids[EXPLANATION_BATCH_SIZE]];
    control.failIds.add(failedIds[0]);

    const first = await call(env, `/api/subjects/${subjectId}/explanations/generate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const firstJob = await waitAIJob(((await first.json()) as { jobId: number }).jobId);
    expect(firstJob.status).toBe("error");
    expect(explanationCalls).toHaveLength(BULK_AI_PARALLELISM + EXPLANATION_EFFORT_LADDER.length);
    expect(explanationCalls.slice(-EXPLANATION_EFFORT_LADDER.length)).toEqual(
      EXPLANATION_EFFORT_LADDER.map(() => failedIds)
    );
    for (const id of ids) {
      expect(await explanationOf(id)).toBe(failedIds.includes(id) ? "" : `AI 해설 ${id}`);
    }

    // 재실행 — 빈 해설 조회가 실패 섹션 문항만 뽑아 이어서 진행한다.
    control.failIds.clear();
    const callsBeforeRetry = explanationCalls.length;
    const second = await call(env, `/api/subjects/${subjectId}/explanations/generate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const secondJob = await waitAIJob(((await second.json()) as { jobId: number }).jobId);
    expect(secondJob.status).toBe("ready");
    expect(secondJob.result).toEqual({ filled: failedIds.length, skippedMismatch: 0, skippedIds: [] });
    expect(explanationCalls.slice(callsBeforeRetry).flat()).toEqual(failedIds);
    for (const id of ids) expect(await explanationOf(id)).toBe(`AI 해설 ${id}`);
  });

  it("전체 문항을 20개 균형 섹션으로 나눠 동시에 시작", async () => {
    const ids: number[] = [];
    for (let i = 0; i < BULK_AI_PARALLELISM * 2 + 1; i++) {
      ids.push(await insertQuestion({ answer: `답${i}` }));
    }
    let release!: () => void;
    control.holdAll = new Promise<void>((resolve) => { release = resolve; });
    let jobId: number | null = null;
    try {
      const started = await call(env, `/api/subjects/${subjectId}/explanations/generate`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      jobId = ((await started.json()) as { jobId: number }).jobId;
      await vi.waitFor(() => expect(control.callCount).toBe(BULK_AI_PARALLELISM));
      expect(explanationCalls.map((call) => call.length)).toEqual([
        3,
        ...Array(BULK_AI_PARALLELISM - 1).fill(2),
      ]);
      expect(explanationCalls.flat()).toEqual(ids);
    } finally {
      release();
      control.holdAll = null;
      if (jobId !== null) await waitAIJob(jobId);
    }
  });

  it("완료한 배치 수를 작업 진행 퍼센트로 노출", async () => {
    for (let i = 0; i < EXPLANATION_BATCH_SIZE + 1; i++) {
      await insertQuestion({ answer: `답${i}` });
    }
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    control.holdCall = { number: 2, wait };
    let jobId: number | null = null;
    try {
      const started = await call(env, `/api/subjects/${subjectId}/explanations/generate`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      jobId = ((await started.json()) as { jobId: number }).jobId;
      let progress: number | null | undefined;
      for (let i = 0; i < 100 && progress !== 95; i++) {
        const jobs = await call(env, `/api/subjects/${subjectId}/jobs`, { headers: { cookie } });
        progress = ((await jobs.json()) as Array<{ id: number; progress: number | null }>)
          .find((job) => job.id === jobId)?.progress;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      expect(progress).toBe(95);
    } finally {
      release();
      control.holdCall = null;
      if (jobId !== null) await waitAIJob(jobId);
    }
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
    expect(figureCalls).toEqual([expect.objectContaining({
      pageCount: 1,
      tasks: [{
        id: fromFile,
        visual_ref: `QUESTION_ID ${fromFile}`,
        figure_description: null,
      }],
    })]);
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
    const sourcePdfBytes = await env.FILES.get("k");
    if (!sourcePdfBytes) throw new Error("원본 PDF fixture 없음");
    await env.FILES.put(
      "k2",
      sourcePdfBytes.buffer.slice(
        sourcePdfBytes.byteOffset,
        sourcePdfBytes.byteOffset + sourcePdfBytes.byteLength
      ) as ArrayBuffer
    );
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

    const badFigureOnly = await call(env, `/api/subjects/${subjectId}/explanations/generate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ figureOnly: false }),
    });
    expect(badFigureOnly.status).toBe(400);

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

  it("단일 그림 문항도 원본 crop을 첨부해 푼다", async () => {
    const id = await insertQuestion({
      answer: "정답",
      srcFileId: figureFileId,
      hasFigure: true,
      srcPage: 1,
      figureBox: "0.1,0.9",
      figureDescription: "삼각형 ABC",
    });
    const res = await call(env, `/api/questions/${id}/explanation/generate`, {
      method: "POST",
      headers: { cookie },
    });

    expect(res.status).toBe(200);
    expect(figureCalls).toHaveLength(1);
    expect(figureCalls[0]).toMatchObject({
      pageCount: 1,
      tasks: [{ id, visual_ref: `QUESTION_ID ${id}`, figure_description: "삼각형 ABC" }],
    });
    expect(existsSync(figureCalls[0].path)).toBe(false);
  });

  it("그림 원본이 없으면 텍스트만으로 해설을 만들지 않는다", async () => {
    const id = await insertQuestion({
      answer: "정답",
      srcFileId: 999_999,
      hasFigure: true,
      srcPage: 1,
      figureBox: "0.1,0.9",
    });
    const res = await call(env, `/api/questions/${id}/explanation/generate`, {
      method: "POST",
      headers: { cookie },
    });

    expect(res.status).toBe(502);
    expect(explanationCalls).toHaveLength(0);
    expect(await explanationOf(id)).toBe("");
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
    control.failIds.add(id);
    expect((await call(env, `/api/questions/${id}/explanation/generate`, {
      method: "POST", headers: { cookie },
    })).status).toBe(502);
    expect(await explanationOf(id)).toBe("");
  });
});
