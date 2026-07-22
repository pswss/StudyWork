import { describe, it, expect, beforeAll, vi } from "vitest";
import { makeEnv, call } from "./helpers";
import { insertQuestions } from "../src/quiz";
import type { QuizQuestion } from "../src/claude";

const generationCalls = vi.hoisted(() => [] as unknown[][]);
const generationControl = vi.hoisted(() => ({ invalidNext: false }));

// AI 호출 전체를 모킹 — claude 모듈의 모든 export를 대체한다.
vi.mock("../src/claude", () => ({
  chat: async () => "응답",
  consolidate: async () => "# 단권화",
  extractFromFile: async () => "추출된 텍스트",
  buildSystemPrompt: (name: string) => `튜터 ${name}`,
  // quiz 전용 모킹 — 파싱 없이 이미 배열을 반환한다.
  extractQuestionsFromFile: async () => [
    {
      qtype: "mcq",
      difficulty: "중",
      question: "다음 중 이차함수의 꼭짓점 형태는?",
      choices: ["y=ax+b", "y=a(x-p)^2+q", "y=ax^2+bx+c", "y=ax^3"],
      answer: "y=a(x-p)^2+q",
      explanation: "표준형(꼭짓점형)은 y=a(x-p)^2+q 이다.",
    },
    {
      qtype: "ox",
      difficulty: "하",
      question: "이차함수의 그래프는 항상 포물선이다.",
      choices: null,
      answer: "o",
      explanation: "맞다. 이차함수의 그래프는 포물선이다.",
    },
    {
      qtype: "short",
      difficulty: "상",
      question: "y=2(x-3)^2+5 의 꼭짓점 좌표를 쓰시오.",
      choices: null,
      answer: "(3, 5)",
      explanation: "꼭짓점은 (p, q) = (3, 5).",
    },
  ],
  generateQuestions: async (...args: unknown[]) => {
    generationCalls.push(args);
    if (generationControl.invalidNext) {
      generationControl.invalidNext = false;
      return [{
        qtype: "invalid",
        difficulty: "중",
        question: "저장 실패 검증",
        choices: null,
        answer: "답",
        explanation: "해설",
      }];
    }
    return [
    {
      qtype: "mcq",
      difficulty: "중",
      question: "이차함수 y=a(x-p)^2+q 에서 꼭짓점은?",
      choices: ["(a, 0)", "(p, 0)", "(p, q)", "(0, q)"],
      answer: "(p, q)",
      explanation: "꼭짓점은 (p, q) 이다.",
    },
    {
      qtype: "ox",
      difficulty: "하",
      question: "a>0 이면 포물선이 위로 열린다.",
      choices: null,
      answer: "o",
      explanation: "a>0 이면 아래로 볼록(위로 열림)이다.",
    },
    ];
  },
}));

const env = makeEnv();
let cookie: string;
let subjectId: number;
let emptySubjectId: number;
let materialId: number;

async function waitAIJob(jobId: number): Promise<{
  status: "processing" | "ready" | "error";
  result: { added: number } | null;
  error: string | null;
}> {
  for (let i = 0; i < 50; i++) {
    const res = await call(env, `/api/ai-jobs/${jobId}`, { headers: { cookie } });
    const job = await res.json() as {
      status: "processing" | "ready" | "error";
      result: { added: number } | null;
      error: string | null;
    };
    if (job.status !== "processing") return job;
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

  const create = async (name: string): Promise<number> => {
    const res = await call(env, "/api/subjects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return ((await res.json()) as { id: number }).id;
  };

  subjectId = await create("수학");
  emptySubjectId = await create("빈과목");

  // 자료 추가 (generate에서 사용)
  const form = new FormData();
  form.set("title", "필기");
  form.set("text", "이차함수 y=a(x-p)^2+q");
  const materialRes = await call(env, `/api/subjects/${subjectId}/materials`, {
    method: "POST",
    headers: { cookie },
    body: form,
  });
  materialId = ((await materialRes.json()) as { id: number }).id;
});

// ── generate 라우트 ──────────────────────────────────────────────────────────
describe("POST /api/subjects/:id/questions/generate", () => {
  it("정상 생성은 즉시 job을 반환하고 화면 요청과 분리되어 완료", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/questions/generate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ count: 2, difficulty: "혼합" }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: number; status: string };
    expect(body.status).toBe("processing");
    await expect(waitAIJob(body.jobId)).resolves.toMatchObject({
      status: "ready",
      result: { added: 2 },
      error: null,
    });
  });

  it("문항 저장 batch 실패 시 문제와 ready 상태를 함께 롤백", async () => {
    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM questions WHERE subject_id = ? AND source = 'generated'"
    ).bind(subjectId).first<{ cnt: number }>();
    generationControl.invalidNext = true;

    const res = await call(env, `/api/subjects/${subjectId}/questions/generate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ count: 1, difficulty: "중" }),
    });
    expect(res.status).toBe(202);
    const { jobId } = await res.json() as { jobId: number };
    await expect(waitAIJob(jobId)).resolves.toMatchObject({ status: "error", result: null });
    const after = await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM questions WHERE subject_id = ? AND source = 'generated'"
    ).bind(subjectId).first<{ cnt: number }>();
    expect(after?.cnt).toBe(before?.cnt);
  });

  it("materialIds로 선택한 이 과목의 준비된 자료만 AI에 전달", async () => {
    await env.DB.prepare(
      `INSERT INTO materials (subject_id, kind, title, extracted_text, status)
       VALUES (?, 'text', '제외 자료', '사용하지 않을 본문', 'ready')`
    ).bind(subjectId).run();
    const res = await call(env, `/api/subjects/${subjectId}/questions/generate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ count: 2, difficulty: "혼합", materialIds: [materialId] }),
    });
    expect(res.status).toBe(202);
    const { jobId } = await res.json() as { jobId: number };
    await expect(waitAIJob(jobId)).resolves.toMatchObject({ status: "ready" });
    const materials = generationCalls.at(-1)?.[1] as Array<{ id: number; title: string }>;
    expect(materials.map((material) => material.id)).toEqual([materialId]);
  });

  it.each([
    { materialIds: [] },
    { materialIds: [1, 1] },
    { materialIds: ["1"] },
    { materialIds: [999_999] },
  ])("잘못되거나 사용할 수 없는 materialIds를 거부: %j", async (body) => {
    const res = await call(env, `/api/subjects/${subjectId}/questions/generate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ count: 2, difficulty: "중", ...body }),
    });
    expect(res.status).toBe(400);
  });

  it("본문이 빈 자료만 생성 범위로 고르면 작업 시작 전에 거부", async () => {
    const emptyMaterial = await env.DB.prepare(
      `INSERT INTO materials (subject_id, kind, title, extracted_text, status)
       VALUES (?, 'text', '빈 자료', '', 'ready') RETURNING id`
    ).bind(subjectId).first<{ id: number }>();
    const res = await call(env, `/api/subjects/${subjectId}/questions/generate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ count: 1, difficulty: "하", materialIds: [emptyMaterial!.id] }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining("본문") });

    const mixed = await call(env, `/api/subjects/${subjectId}/questions/generate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ count: 2, difficulty: "혼합", materialIds: [materialId, emptyMaterial!.id] }),
    });
    expect(mixed.status).toBe(202);
    const { jobId } = await mixed.json() as { jobId: number };
    await expect(waitAIJob(jobId)).resolves.toMatchObject({ status: "ready" });
    const passedMaterials = generationCalls.at(-1)?.[1] as Array<{ id: number }>;
    expect(passedMaterials.map((material) => material.id)).toEqual([materialId]);
  });

  it("준비된 자료가 50개를 넘어도 전체 생성 범위로 받을 수 있음", async () => {
    const { results } = await env.DB.prepare(
      `WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM nums WHERE n < 51)
       INSERT INTO materials (subject_id, kind, title, extracted_text, status)
       SELECT ?, 'text', '대량 자료 ' || n, '본문 ' || n, 'ready' FROM nums
       RETURNING id`
    ).bind(subjectId).all<{ id: number }>();
    const res = await call(env, `/api/subjects/${subjectId}/questions/generate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ count: 2, difficulty: "혼합", materialIds: results.map((row) => row.id) }),
    });
    expect(res.status).toBe(202);
    const { jobId } = await res.json() as { jobId: number };
    await expect(waitAIJob(jobId)).resolves.toMatchObject({ status: "ready" });
    const passedMaterials = generationCalls.at(-1)?.[1] as unknown[];
    expect(passedMaterials).toHaveLength(51);
  });

  it("자료 없는 과목 → 400", async () => {
    const res = await call(env, `/api/subjects/${emptySubjectId}/questions/generate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ count: 5, difficulty: "중" }),
    });
    expect(res.status).toBe(400);
  });

  it("count 범위 초과 → 400", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/questions/generate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ count: 25, difficulty: "중" }),
    });
    expect(res.status).toBe(400);
  });

  it("count=0 → 400", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/questions/generate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ count: 0, difficulty: "중" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("insertQuestions", () => {
  it("중간 문항이 DB 제약을 위반하면 앞 문항도 남기지 않음", async () => {
    const marker = `atomic-${Date.now()}`;
    const questions = [
      {
        qtype: "short",
        difficulty: "하",
        question: `${marker}-valid`,
        choices: null,
        answer: "정답",
        explanation: "해설",
      },
      {
        qtype: "short",
        difficulty: "지원하지않음",
        question: `${marker}-invalid`,
        choices: null,
        answer: "정답",
        explanation: "해설",
      },
    ] as unknown as QuizQuestion[];

    await expect(
      insertQuestions(env.DB, subjectId, "generated", questions)
    ).rejects.toThrow();

    const { results } = await env.DB.prepare(
      "SELECT id FROM questions WHERE subject_id = ? AND question LIKE ?"
    ).bind(subjectId, `${marker}%`).all<{ id: number }>();
    expect(results).toEqual([]);
  });

  it("빈 배열은 DB 작업 없이 0을 반환", async () => {
    await expect(insertQuestions(env.DB, subjectId, "generated", [])).resolves.toBe(0);
  });
});

// extract 라우트는 제거됨 — 파일에서의 문제 등록은 문제집화(to-book, books.test)가 담당한다

// ── 목록 조회 ────────────────────────────────────────────────────────────────
describe("GET /api/subjects/:id/questions", () => {
  it("저장된 문제 목록 조회 (choices 배열로 파싱됨)", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/questions`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    // mcq 문항의 choices가 배열인지 확인
    const mcq = rows.find((r) => r.qtype === "mcq");
    expect(Array.isArray(mcq?.choices)).toBe(true);
  });

  it("source 필터: generated만 조회", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/questions?source=generated`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ source: string }>;
    for (const row of rows) {
      expect(row.source).toBe("generated");
    }
  });

  it("difficulty 필터: 하만 조회", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/questions?difficulty=하`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ difficulty: string }>;
    for (const row of rows) {
      expect(row.difficulty).toBe("하");
    }
  });
});

// ── quiz 출제 ────────────────────────────────────────────────────────────────
describe("GET /api/subjects/:id/quiz", () => {
  let selectedUploadedId: number;
  let selectedGeneratedId: number;
  let selectedEasyId: number;
  let otherFileId: number;
  let otherSubjectQuestionId: number;

  beforeAll(async () => {
    const book = await env.DB.prepare(
      "INSERT INTO books (subject_id, title) VALUES (?, '범위 테스트') RETURNING id"
    ).bind(subjectId).first<{ id: number }>();
    const file = await env.DB.prepare(
      `INSERT INTO book_files (book_id, name, r2_key, mime, status)
       VALUES (?, '선택.pdf', 'quiz-scope-selected.pdf', 'application/pdf', 'ready') RETURNING id`
    ).bind(book!.id).first<{ id: number }>();
    const otherFile = await env.DB.prepare(
      `INSERT INTO book_files (book_id, name, r2_key, mime, status)
       VALUES (?, '다른.pdf', 'quiz-scope-other.pdf', 'application/pdf', 'ready') RETURNING id`
    ).bind(book!.id).first<{ id: number }>();
    otherFileId = otherFile!.id;

    const add = async (
      targetSubject: number,
      source: "uploaded" | "generated",
      difficulty: "하" | "중" | "상",
      marker: string,
      srcFileId: number,
      wrongCount: number
    ) => (await env.DB.prepare(
      `INSERT INTO questions
         (subject_id, source, qtype, difficulty, question, answer, src_file_id, wrong_count)
       VALUES (?, ?, 'short', ?, ?, '정답', ?, ?) RETURNING id`
    ).bind(targetSubject, source, difficulty, marker, srcFileId, wrongCount).first<{ id: number }>())!.id;

    selectedUploadedId = await add(subjectId, "uploaded", "상", "범위-업로드-상-오답", file!.id, 1);
    selectedGeneratedId = await add(subjectId, "generated", "상", "범위-생성-상-오답", file!.id, 1);
    selectedEasyId = await add(subjectId, "uploaded", "하", "범위-업로드-하", file!.id, 0);
    await add(subjectId, "uploaded", "상", "범위-다른파일", otherFileId, 1);

    const otherBook = await env.DB.prepare(
      "INSERT INTO books (subject_id, title) VALUES (?, '다른 과목 범위') RETURNING id"
    ).bind(emptySubjectId).first<{ id: number }>();
    const otherSubjectFile = await env.DB.prepare(
      `INSERT INTO book_files (book_id, name, r2_key, mime, status)
       VALUES (?, '타과목.pdf', 'quiz-scope-foreign.pdf', 'application/pdf', 'ready') RETURNING id`
    ).bind(otherBook!.id).first<{ id: number }>();
    otherSubjectQuestionId = await add(
      emptySubjectId,
      "uploaded",
      "상",
      "범위-타과목",
      otherSubjectFile!.id,
      1
    );
  });

  it("기본 출제 — answer 필드 없음", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/quiz`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    // answer, explanation 필드가 없어야 한다
    for (const row of rows) {
      expect(row).not.toHaveProperty("answer");
      expect(row).not.toHaveProperty("explanation");
    }
  });

  it("count=2 → 최대 2개 반환", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/quiz?count=2`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as unknown[];
    expect(rows.length).toBeLessThanOrEqual(2);
  });

  it("count=60 → 오류 없이 응답 (최대 50으로 클램프)", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/quiz?count=60`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as unknown[];
    expect(Array.isArray(rows)).toBe(true);
  });

  it("source=generated 필터", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/quiz?source=generated`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ source: string }>;
    for (const row of rows) {
      expect(row.source).toBe("generated");
    }
  });

  it("questionIds는 과목 범위 안의 선택 문항만 출제", async () => {
    const ids = [selectedUploadedId, selectedGeneratedId, otherSubjectQuestionId].join(",");
    const res = await call(env, `/api/subjects/${subjectId}/quiz?questionIds=${ids}&count=50`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ id: number }>;
    expect(new Set(rows.map((row) => row.id))).toEqual(new Set([selectedUploadedId, selectedGeneratedId]));
  });

  it("questionIds와 기존 필터·count는 모두 교집합", async () => {
    const ids = [selectedUploadedId, selectedGeneratedId, selectedEasyId].join(",");
    const res = await call(
      env,
      `/api/subjects/${subjectId}/quiz?questionIds=${ids}&source=uploaded&difficulty=상&wrong=1&count=1`,
      { headers: { cookie } }
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([expect.objectContaining({ id: selectedUploadedId })]);
  });

  it("src_file_id는 해당 과목·파일 문제에 기존 필터를 교차 적용", async () => {
    const res = await call(
      env,
      `/api/subjects/${subjectId}/quiz?src_file_id=${otherFileId}&source=uploaded&difficulty=상&wrong=1&count=50`,
      { headers: { cookie } }
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ question: string }>;
    expect(rows.map((row) => row.question)).toEqual(["범위-다른파일"]);
  });

  it.each([
    "questionIds=",
    "questionIds=1,,2",
    "questionIds=abc",
    "questionIds=0",
    "questionIds=1,1",
    "questionIds=1&questionIds=2",
    "src_file_id=",
    "src_file_id=-1",
    "src_file_id=abc",
    "src_file_id=1&src_file_id=2",
    "questionIds=1&src_file_id=1",
  ])("잘못된 퀴즈 범위를 400으로 거부: %s", async (query) => {
    const res = await call(env, `/api/subjects/${subjectId}/quiz?${query}`, { headers: { cookie } });
    expect(res.status).toBe(400);
  });

  it("questionIds 50개 초과를 400으로 거부", async () => {
    const ids = Array.from({ length: 51 }, (_, index) => index + 1).join(",");
    const res = await call(env, `/api/subjects/${subjectId}/quiz?questionIds=${ids}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(400);
  });
});

// ── SRS-lite 정렬 — 오답 우선 → 오래 안 본 순 → 랜덤 ──────────────────────────
describe("GET /api/subjects/:id/quiz — SRS-lite 정렬", () => {
  let srsSubjectId: number;
  let neverTriedWrong: number; // 오답 우세 + 미시도 → 1순위 (미시도 = 가장 오래된 취급)
  let staleWrong: number;      // 오답 우세 + 오래 전 시도 → 2순위
  let recentWrong: number;     // 오답 우세 + 최근 시도 → 3순위
  let neverTriedOk: number;    // 비오답 + 미시도 → 4순위
  let recentOk: number;        // 비오답 + 최근 시도 → 5순위

  beforeAll(async () => {
    const res = await call(env, "/api/subjects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "SRS정렬" }),
    });
    srsSubjectId = ((await res.json()) as { id: number }).id;

    const add = async (marker: string, wrong: number, correct: number) =>
      (await env.DB.prepare(
        `INSERT INTO questions (subject_id, source, qtype, difficulty, question, answer, wrong_count, correct_count)
         VALUES (?, 'uploaded', 'short', '중', ?, '정답', ?, ?) RETURNING id`
      ).bind(srsSubjectId, marker, wrong, correct).first<{ id: number }>())!.id;
    const attempt = (questionId: number, at: string) =>
      env.DB.prepare(
        "INSERT INTO question_attempts (question_id, attempt_id, correct, created_at) VALUES (?, ?, 0, ?)"
      ).bind(questionId, `srs-${questionId}-${at}`, at).run();

    neverTriedWrong = await add("srs-오답-미시도", 2, 0);
    staleWrong = await add("srs-오답-오래됨", 2, 0);
    recentWrong = await add("srs-오답-최근", 2, 0);
    neverTriedOk = await add("srs-정상-미시도", 0, 1);
    recentOk = await add("srs-정상-최근", 0, 1);
    await attempt(staleWrong, "2026-01-01 00:00:00");
    await attempt(recentWrong, "2026-07-01 00:00:00");
    await attempt(recentOk, "2026-07-02 00:00:00");
    // 최근 시도한 오답의 과거 기록 — MAX(created_at)만 반영되는지 확인
    await attempt(recentWrong, "2025-12-01 00:00:00");
  });

  it("오답 우선 → 오래 안 본 순, 미시도는 가장 오래된 취급", async () => {
    const res = await call(env, `/api/subjects/${srsSubjectId}/quiz?count=50`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as Array<{ id: number }>).map((row) => row.id);
    expect(ids).toEqual([neverTriedWrong, staleWrong, recentWrong, neverTriedOk, recentOk]);
  });

  it("wrong=1 필터 시멘틱 유지 — wrong_count>0만, 같은 정렬", async () => {
    const res = await call(env, `/api/subjects/${srsSubjectId}/quiz?wrong=1&count=50`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as Array<{ id: number }>).map((row) => row.id);
    expect(ids).toEqual([neverTriedWrong, staleWrong, recentWrong]);
  });
});

// ── 채점 전용 과목 + 문제 세트 ──────────────────────────────────────────────
// 채점 테스트는 별도 과목에 DB 직접 삽입해 ID를 예측 가능하게 유지한다.
describe("POST /api/questions/:id/answer", () => {
  let gradingSubjectId: number;
  let mcqId: number;
  let extractedMarkerMcqId: number;
  let oxId: number;
  let shortId: number;

  beforeAll(async () => {
    // 채점 전용 과목 생성
    const res = await call(env, "/api/subjects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "채점테스트" }),
    });
    gradingSubjectId = ((await res.json()) as { id: number }).id;

    const insert = async (
      qtype: string, difficulty: string, question: string,
      choices: string[] | null, answer: string, explanation: string
    ): Promise<number> => {
      await env.DB.prepare(
        "INSERT INTO questions (subject_id, source, qtype, difficulty, question, choices, answer, explanation) VALUES (?, 'uploaded', ?, ?, ?, ?, ?, ?)"
      ).bind(gradingSubjectId, qtype, difficulty, question, choices ? JSON.stringify(choices) : null, answer, explanation).run();
      const row = await env.DB.prepare("SELECT id FROM questions WHERE subject_id = ? AND question = ?")
        .bind(gradingSubjectId, question).first<{ id: number }>();
      return row!.id;
    };
    mcqId = await insert("mcq", "중", "다음 중 이차함수의 꼭짓점 형태는?",
      ["y=ax+b", "y=a(x-p)^2+q", "y=ax^2+bx+c", "y=ax^3"], "y=a(x-p)^2+q", "표준형(꼭짓점형)은 y=a(x-p)^2+q 이다.");
    // 자동 추출 저장 계약: 정답 ③은 books.ts에서 "3"으로 정규화되지만 UI는 선택지 전체를 보낸다.
    extractedMarkerMcqId = await insert("mcq", "중", "자동 추출 객관식",
      ["① x", "② y", "③ z"], "3", "세 번째 보기가 정답이다.");
    oxId = await insert("ox", "하", "이차함수의 그래프는 항상 포물선이다.", null, "o", "맞다.");
    shortId = await insert("short", "상", "y=2(x-3)^2+5 의 꼭짓점 좌표를 쓰시오.", null, "(3, 5)", "꼭짓점은 (3, 5).");
  });

  it("mcq 정답(텍스트 일치) → correct:true, answer/explanation 포함", async () => {
    // extract mock MCQ: answer = "y=a(x-p)^2+q"
    const res = await call(env, `/api/questions/${mcqId}/answer`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ answer: "y=a(x-p)^2+q" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { correct: boolean; answer: string; explanation: string };
    expect(body.correct).toBe(true);
    expect(typeof body.answer).toBe("string");
    expect(typeof body.explanation).toBe("string");
  });

  it("mcq 오답 → correct:false", async () => {
    const res = await call(env, `/api/questions/${mcqId}/answer`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ answer: "y=ax+b" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { correct: boolean };
    expect(body.correct).toBe(false);
  });

  it("mcq 인덱스 입력(1-based) → 정답 처리", async () => {
    // extract mock MCQ choices: ["y=ax+b", "y=a(x-p)^2+q", "y=ax^2+bx+c", "y=ax^3"]
    // answer: "y=a(x-p)^2+q" → 1-based index 2
    const res = await call(env, `/api/questions/${mcqId}/answer`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ answer: "2" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { correct: boolean };
    expect(body.correct).toBe(true);
  });

  it("자동 추출 정답 ③→3 계약에서도 UI 선택지 텍스트 '③ z'를 정답 처리", async () => {
    const res = await call(env, `/api/questions/${extractedMarkerMcqId}/answer`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ answer: "③ z" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { correct: boolean; answer: string };
    expect(body.correct).toBe(true);
    expect(body.answer).toBe("③ z");
  });

  it("같은 attemptId 재전송은 통계를 한 번만 증가시키고 첫 결과를 반환", async () => {
    const attemptId = "retry-safe-attempt";
    const before = await env.DB.prepare(
      "SELECT correct_count, wrong_count FROM questions WHERE id = ?"
    ).bind(shortId).first<{ correct_count: number; wrong_count: number }>();

    const first = await call(env, `/api/questions/${shortId}/answer`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ answer: "(3, 5)", attemptId }),
    });
    const retried = await call(env, `/api/questions/${shortId}/answer`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ answer: "오답", attemptId }),
    });
    expect(first.status).toBe(200);
    expect(retried.status).toBe(200);
    expect((await first.json()) as { correct: boolean }).toEqual(expect.objectContaining({ correct: true }));
    expect((await retried.json()) as { correct: boolean }).toEqual(expect.objectContaining({ correct: true }));

    const after = await env.DB.prepare(
      "SELECT correct_count, wrong_count FROM questions WHERE id = ?"
    ).bind(shortId).first<{ correct_count: number; wrong_count: number }>();
    expect(after!.correct_count).toBe(before!.correct_count + 1);
    expect(after!.wrong_count).toBe(before!.wrong_count);
  });

  it("비어 있거나 과도하게 긴 attemptId는 거부", async () => {
    for (const attemptId of ["", "x".repeat(101)]) {
      const res = await call(env, `/api/questions/${shortId}/answer`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ answer: "(3, 5)", attemptId }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("correct_count 증가 확인", async () => {
    // 위에서 correct 응답이 있었으므로 correct_count > 0 이어야 한다
    const res = await call(env, `/api/subjects/${gradingSubjectId}/questions`, {
      headers: { cookie },
    });
    const rows = (await res.json()) as Array<{ id: number; correct_count: number; wrong_count: number }>;
    const mcq = rows.find((r) => r.id === mcqId)!;
    expect(mcq.correct_count).toBeGreaterThan(0);
  });

  it("wrong_count 증가 확인", async () => {
    // 위에서 오답 응답이 있었으므로 wrong_count > 0 이어야 한다
    const res = await call(env, `/api/subjects/${gradingSubjectId}/questions`, {
      headers: { cookie },
    });
    const rows = (await res.json()) as Array<{ id: number; correct_count: number; wrong_count: number }>;
    const mcq = rows.find((r) => r.id === mcqId)!;
    expect(mcq.wrong_count).toBeGreaterThan(0);
  });

  it("ox 정규화: 'o' → correct:true", async () => {
    // extract mock OX: answer = "o"
    const res = await call(env, `/api/questions/${oxId}/answer`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ answer: "o" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { correct: boolean };
    expect(body.correct).toBe(true);
  });

  it("ox 정규화: '맞다' → correct:true", async () => {
    const res = await call(env, `/api/questions/${oxId}/answer`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ answer: "맞다" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { correct: boolean };
    expect(body.correct).toBe(true);
  });

  it("ox 정규화: 'O' (대문자) → correct:true", async () => {
    const res = await call(env, `/api/questions/${oxId}/answer`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ answer: "O" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { correct: boolean };
    expect(body.correct).toBe(true);
  });

  it("ox 정규화: 'x' → correct:false", async () => {
    const res = await call(env, `/api/questions/${oxId}/answer`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ answer: "x" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { correct: boolean };
    expect(body.correct).toBe(false);
  });

  it("short 정답(공백·대소문자 무시) → correct:true", async () => {
    // extract mock short: answer = "(3, 5)"
    const res = await call(env, `/api/questions/${shortId}/answer`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ answer: " (3, 5) " }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { correct: boolean };
    expect(body.correct).toBe(true);
  });

  it("answer 필드 누락 → 400", async () => {
    const res = await call(env, `/api/questions/${mcqId}/answer`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("보기가 숫자 문자열이면 텍스트 일치가 인덱스 해석보다 우선", async () => {
    // 회귀: choices ["2","1","3"], answer "1" — "1" 입력은 인덱스(→"2")가 아니라 값 "1"로 채점돼야 한다
    await env.DB.prepare(
      "INSERT INTO questions (subject_id, source, qtype, difficulty, question, choices, answer) VALUES (?, 'generated', 'mcq', '하', '숫자보기 회귀', ?, '1')"
    ).bind(gradingSubjectId, JSON.stringify(["2", "1", "3"])).run();
    const row = await env.DB.prepare("SELECT id FROM questions WHERE question = '숫자보기 회귀'")
      .first<{ id: number }>();
    const res = await call(env, `/api/questions/${row!.id}/answer`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ answer: "1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { correct: boolean };
    expect(body.correct).toBe(true);
  });

  it("빈 문자열 answer → 400", async () => {
    const res = await call(env, `/api/questions/${mcqId}/answer`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ answer: "  " }),
    });
    expect(res.status).toBe(400);
  });

  it("존재하지 않는 문제 → 404", async () => {
    const res = await call(env, `/api/questions/99999/answer`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ answer: "test" }),
    });
    expect(res.status).toBe(404);
  });
});

// ── 삭제 ─────────────────────────────────────────────────────────────────────
describe("DELETE /api/questions/:id", () => {
  it("문제 삭제 → ok:true, 이후 목록에서 제거됨", async () => {
    // 먼저 목록에서 첫 번째 문제 ID 가져오기
    const listRes = await call(env, `/api/subjects/${subjectId}/questions`, {
      headers: { cookie },
    });
    const rows = (await listRes.json()) as Array<{ id: number }>;
    expect(rows.length).toBeGreaterThan(0);
    const targetId = rows[0].id;

    const delRes = await call(env, `/api/questions/${targetId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(delRes.status).toBe(200);
    const body = (await delRes.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // 삭제 후 목록에서 없어야 함
    const afterRes = await call(env, `/api/subjects/${subjectId}/questions`, {
      headers: { cookie },
    });
    const afterRows = (await afterRes.json()) as Array<{ id: number }>;
    expect(afterRows.find((r) => r.id === targetId)).toBeUndefined();
  });
});
