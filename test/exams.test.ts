import { describe, it, expect, beforeAll, vi } from "vitest";
import { makeEnv, call } from "./helpers";

const planControl = vi.hoisted(() => ({
  nextGate: null as Promise<void> | null,
  nextError: null as Error | null,
  nextEmpty: false,
  lastSignal: null as AbortSignal | null,
}));

// AI 호출 전체 모킹
vi.mock("../src/claude", () => ({
  chat: async () => "응답",
  consolidate: async () => "# 단권화",
  extractFromFile: async () => "추출된 텍스트",
  buildSystemPrompt: (name: string) => `튜터 ${name}`,
  extractQuestionsFromFile: async () => [],
  generateQuestions: async () => [],
  analyzeWrongQuestions: async () => "분석 결과",
  generateStudyPlan: async (...args: unknown[]) => {
    const examDate = args[2] as string;
    const today = args[3] as string;
    planControl.lastSignal = args[7] as AbortSignal;
    const gate = planControl.nextGate;
    planControl.nextGate = null;
    if (gate) await gate;
    const error = planControl.nextError;
    planControl.nextError = null;
    if (error) throw error;
    if (planControl.nextEmpty) {
      planControl.nextEmpty = false;
      return [];
    }
    // 오늘부터 시험일까지 하루씩 태스크 생성 (테스트용 간단한 구현)
    const items: { day: string; task: string }[] = [];
    const start = new Date(today);
    const end = new Date(examDate);
    let cur = new Date(start);
    while (cur <= end) {
      const dayStr = cur.toISOString().slice(0, 10);
      items.push({ day: dayStr, task: `${dayStr} 학습` });
      cur.setDate(cur.getDate() + 1);
    }
    return items;
  },
  parsePlanJson: (text: string, today: string, examDate: string) => JSON.parse(text),
}));

const env = makeEnv();
let cookie: string;
let subjectId: number;

interface JobResult {
  id: number;
  status: "processing" | "ready" | "error";
  result: { examId: number } | null;
  error: string | null;
}

async function getJob(jobId: number): Promise<JobResult> {
  const res = await call(env, `/api/ai-jobs/${jobId}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return res.json() as Promise<JobResult>;
}

async function waitForJob(jobId: number): Promise<JobResult> {
  for (let i = 0; i < 100; i++) {
    const job = await getJob(jobId);
    if (job.status !== "processing") return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("AI job timeout");
}

async function loadExam(examId: number) {
  const res = await call(env, `/api/subjects/${subjectId}/exams`, { headers: { cookie } });
  const list = await res.json() as Array<{
    id: number;
    title: string;
    exam_date: string;
    items: Array<{ id: number; day: string; task: string; done: number }>;
  }>;
  return list.find((exam) => exam.id === examId);
}

async function createFinishedExam(title: string, examDate: string) {
  const res = await call(env, `/api/subjects/${subjectId}/exams`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ title, exam_date: examDate }),
  });
  expect(res.status).toBe(202);
  const started = await res.json() as { jobId: number; status: string };
  const job = await waitForJob(started.jobId);
  expect(job.status).toBe("ready");
  const exam = await loadExam(job.result!.examId);
  expect(exam).toBeDefined();
  return exam!;
}

// 오늘과 미래 날짜 (테스트용)
const TODAY = new Date().toISOString().slice(0, 10);
const TOMORROW = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
})();
const FUTURE_DATE = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString().slice(0, 10);
})();

beforeAll(async () => {
  const login = await call(env, "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-password" }),
  });
  cookie = login.headers.get("set-cookie")!.split(";")[0];

  const create = await call(env, "/api/subjects", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "영어" }),
  });
  subjectId = ((await create.json()) as { id: number }).id;
});

// ── POST /api/subjects/:id/exams ─────────────────────────────────────────────
describe("POST /api/subjects/:id/exams", () => {
  it("즉시 202 반환 → 별도 job이 완료하면 목록에서 재조회", async () => {
    let release!: () => void;
    planControl.nextGate = new Promise<void>((resolve) => { release = resolve; });
    const res = await call(env, `/api/subjects/${subjectId}/exams`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "중간고사", exam_date: FUTURE_DATE, scope: "1~3단원" }),
    });
    expect(res.status).toBe(202);
    const started = await res.json() as { jobId: number; status: string };
    expect(started.status).toBe("processing");
    expect((await getJob(started.jobId)).status).toBe("processing");
    release();

    const job = await waitForJob(started.jobId);
    expect(job.status).toBe("ready");
    const body = await loadExam(job.result!.examId);
    expect(body?.title).toBe("중간고사");
    expect(body?.exam_date).toBe(FUTURE_DATE);
    expect(body?.items.length).toBeGreaterThan(0);
    // 모든 items가 오늘 ~ 시험일 범위 내
    for (const item of body!.items) {
      expect(item.day >= TODAY).toBe(true);
      expect(item.day <= FUTURE_DATE).toBe(true);
      expect(item.done).toBe(0);
    }
  });

  it("계획 생성을 중단하면 모델 신호를 끊고 시험을 만들지 않음", async () => {
    const before = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM exams WHERE subject_id = ?")
      .bind(subjectId).first<{ cnt: number }>();
    let release!: () => void;
    planControl.nextGate = new Promise<void>(resolve => { release = resolve; });
    planControl.lastSignal = null;
    const res = await call(env, `/api/subjects/${subjectId}/exams`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "중단 시험", exam_date: FUTURE_DATE }),
    });
    const { jobId } = await res.json() as { jobId: number };
    for (let i = 0; i < 20 && !planControl.lastSignal; i++) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }

    const cancelled = await call(env, `/api/ai-jobs/${jobId}/cancel`, { method: "POST", headers: { cookie } });
    expect(cancelled.status).toBe(200);
    expect((planControl.lastSignal as AbortSignal | null)?.aborted).toBe(true);
    release();
    await expect(waitForJob(jobId)).resolves.toMatchObject({ status: "error", error: "사용자 중단" });
    const after = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM exams WHERE subject_id = ?")
      .bind(subjectId).first<{ cnt: number }>();
    expect(after?.cnt).toBe(before?.cnt);
  });

  it("AI 생성 실패 시 시험 행과 TODO를 하나도 남기지 않음", async () => {
    const before = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM exams WHERE subject_id = ?")
      .bind(subjectId).first<{ cnt: number }>();
    planControl.nextError = new Error("mock 계획 실패");
    const res = await call(env, `/api/subjects/${subjectId}/exams`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "실패 시험", exam_date: FUTURE_DATE }),
    });
    expect(res.status).toBe(202);
    const { jobId } = await res.json() as { jobId: number };
    await expect(waitForJob(jobId)).resolves.toMatchObject({ status: "error" });
    const after = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM exams WHERE subject_id = ?")
      .bind(subjectId).first<{ cnt: number }>();
    expect(after?.cnt).toBe(before?.cnt);
  });

  it("title 없음 → 400", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/exams`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ exam_date: FUTURE_DATE }),
    });
    expect(res.status).toBe(400);
  });

  it("exam_date 없음 → 400", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/exams`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "기말고사" }),
    });
    expect(res.status).toBe(400);
  });

  it("exam_date 형식 잘못됨 → 400", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/exams`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "기말고사", exam_date: "20260720" }),
    });
    expect(res.status).toBe(400);
  });

  it("exam_date 과거 → 400", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/exams`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "과거시험", exam_date: "2020-01-01" }),
    });
    expect(res.status).toBe(400);
  });
});

// ── GET /api/subjects/:id/exams ──────────────────────────────────────────────
describe("GET /api/subjects/:id/exams", () => {
  it("시험 목록 조회 — items, done_count 포함", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/exams`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{
      id: number;
      title: string;
      items: unknown[];
      done_count: number;
    }>;
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
    for (const exam of list) {
      expect(Array.isArray(exam.items)).toBe(true);
      expect(typeof exam.done_count).toBe("number");
    }
  });
});

// ── PATCH /api/plan-items/:id ────────────────────────────────────────────────
describe("PATCH /api/plan-items/:id", () => {
  let itemId: number;
  let examId: number;

  beforeAll(async () => {
    const listRes = await call(env, `/api/subjects/${subjectId}/exams`, {
      headers: { cookie },
    });
    const list = (await listRes.json()) as Array<{
      id: number;
      items: Array<{ id: number; done: number }>;
    }>;
    examId = list[0].id;
    itemId = list[0].items[0].id;
  });

  it("done=true 토글 → ok:true", async () => {
    const res = await call(env, `/api/plan-items/${itemId}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ done: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("토글 후 done_count 증가 확인", async () => {
    const listRes = await call(env, `/api/subjects/${subjectId}/exams`, {
      headers: { cookie },
    });
    const list = (await listRes.json()) as Array<{
      id: number;
      done_count: number;
      items: Array<{ id: number; done: number }>;
    }>;
    const exam = list.find((e) => e.id === examId)!;
    expect(exam.done_count).toBeGreaterThan(0);
    const item = exam.items.find((i) => i.id === itemId)!;
    expect(item.done).toBe(1);
  });

  it("done=false 로 되돌리기", async () => {
    const res = await call(env, `/api/plan-items/${itemId}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ done: false }),
    });
    expect(res.status).toBe(200);
  });

  it("done 필드 없음 → 400", async () => {
    const res = await call(env, `/api/plan-items/${itemId}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("존재하지 않는 item → 404", async () => {
    const res = await call(env, `/api/plan-items/99999`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ done: true }),
    });
    expect(res.status).toBe(404);
  });
});

// ── POST /api/exams/:id/replan ───────────────────────────────────────────────
describe("POST /api/exams/:id/replan", () => {
  let examId: number;
  let itemId: number;

  beforeAll(async () => {
    // 새 시험 생성
    const exam = await createFinishedExam("재계획 시험", FUTURE_DATE);
    examId = exam.id;
    itemId = exam.items[0]?.id;

    // 첫 항목 완료 처리
    if (itemId) {
      await call(env, `/api/plan-items/${itemId}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ done: true }),
      });
    }
  });

  it("replan → 202, 완료 항목 유지, 새 items 추가", async () => {
    const res = await call(env, `/api/exams/${examId}/replan`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(202);
    const started = await res.json() as { jobId: number };
    const job = await waitForJob(started.jobId);
    expect(job.status).toBe("ready");
    const body = await loadExam(examId);
    expect(body?.id).toBe(examId);
    expect(Array.isArray(body?.items)).toBe(true);
    // 완료된 항목이 유지되어야 한다
    if (itemId) {
      const kept = body!.items.find((i) => i.id === itemId);
      expect(kept).toBeDefined();
      expect(kept?.done).toBe(1);
    }
  });

  it("빈 재계획 결과는 오류 처리하고 기존 TODO를 그대로 보존", async () => {
    const before = (await loadExam(examId))!.items.map((item) => ({
      id: item.id, day: item.day, task: item.task, done: item.done,
    }));
    planControl.nextEmpty = true;

    const res = await call(env, `/api/exams/${examId}/replan`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(202);
    const { jobId } = await res.json() as { jobId: number };
    await expect(waitForJob(jobId)).resolves.toMatchObject({ status: "error" });
    const after = (await loadExam(examId))!.items.map((item) => ({
      id: item.id, day: item.day, task: item.task, done: item.done,
    }));
    expect(after).toEqual(before);
  });

  it("존재하지 않는 exam → 404", async () => {
    const res = await call(env, `/api/exams/99999/replan`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });
});

// ── DELETE /api/exams/:id ────────────────────────────────────────────────────
describe("DELETE /api/exams/:id", () => {
  let deleteExamId: number;

  beforeAll(async () => {
    deleteExamId = (await createFinishedExam("삭제할 시험", TOMORROW)).id;
  });

  it("시험 삭제 실패 시 앞선 계획 삭제도 롤백", async () => {
    const before = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM plan_items WHERE exam_id = ?")
      .bind(deleteExamId).first<{ cnt: number }>();
    await env.DB.prepare(
      `CREATE TRIGGER fail_exam_delete BEFORE DELETE ON exams
       WHEN OLD.id = ${deleteExamId}
       BEGIN SELECT RAISE(ABORT, 'forced exam delete failure'); END`
    ).run();
    try {
      const res = await call(env, `/api/exams/${deleteExamId}`, {
        method: "DELETE",
        headers: { cookie },
      });
      expect(res.status).toBe(500);
      await expect(env.DB.prepare("SELECT id FROM exams WHERE id = ?").bind(deleteExamId).first())
        .resolves.toMatchObject({ id: deleteExamId });
      await expect(env.DB.prepare("SELECT COUNT(*) AS cnt FROM plan_items WHERE exam_id = ?")
        .bind(deleteExamId).first<{ cnt: number }>()).resolves.toEqual(before);
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS fail_exam_delete").run();
    }
  });

  it("삭제 → ok:true", async () => {
    const res = await call(env, `/api/exams/${deleteExamId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("삭제 후 목록에서 제거됨", async () => {
    const listRes = await call(env, `/api/subjects/${subjectId}/exams`, {
      headers: { cookie },
    });
    const list = (await listRes.json()) as Array<{ id: number }>;
    expect(list.find((e) => e.id === deleteExamId)).toBeUndefined();
  });
});
