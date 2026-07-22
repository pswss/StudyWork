import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { makeEnv, call } from "./helpers";

const aiMocks = vi.hoisted(() => ({
  extractQuestionsFromFile: vi.fn(),
  analyzeWrongQuestions: vi.fn(),
}));

function extractedQuestions() {
  return [
    {
      qtype: "mcq",
      difficulty: "중",
      question: "오답 노트 문제 1",
      choices: ["A", "B", "C", "D"],
      answer: "B",
      explanation: "해설 1",
    },
    {
      qtype: "ox",
      difficulty: "하",
      question: "오답 노트 문제 2",
      choices: null,
      answer: "o",
      explanation: "해설 2",
    },
  ];
}

function jpegFile(name = "wrong.jpg"): File {
  return new File([Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])], name, {
    // 선언 MIME이 아니라 검증된 시그니처가 사용되는지도 함께 확인한다.
    type: "application/octet-stream",
  });
}

// AI 호출 전체 모킹
vi.mock("../src/claude", () => ({
  chat: async () => "응답",
  consolidate: async () => "# 단권화",
  extractFromFile: async () => "추출된 텍스트",
  buildSystemPrompt: (name: string) => `튜터 ${name}`,
  extractQuestionsFromFile: (path: string, kind: "pdf" | "image") =>
    aiMocks.extractQuestionsFromFile(path, kind),
  generateQuestions: async () => [],
  analyzeWrongQuestions: (...args: unknown[]) => aiMocks.analyzeWrongQuestions(...args),
  generateStudyPlan: async () => [],
  parsePlanJson: (text: string) => JSON.parse(text),
}));

const env = makeEnv();
let cookie: string;
let subjectId: number;

beforeEach(() => {
  aiMocks.extractQuestionsFromFile.mockReset().mockResolvedValue(extractedQuestions());
  aiMocks.analyzeWrongQuestions
    .mockReset()
    .mockResolvedValue("## 약점 분석\n1. 계산 실수 많음\n2. 개념 혼동");
});

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
    body: JSON.stringify({ name: "국어" }),
  });
  subjectId = ((await create.json()) as { id: number }).id;
});

// ── GET /api/subjects/:id/wrong ──────────────────────────────────────────────
describe("GET /api/subjects/:id/wrong", () => {
  it("오답 없으면 빈 배열 반환", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/wrong`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as unknown[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(0);
  });
});

// ── POST /api/subjects/:id/wrong/extract ─────────────────────────────────────
describe("POST /api/subjects/:id/wrong/extract", () => {
  it("검증된 이미지 바이트·해시·이름·종류를 사용하고 성공 후 임시 파일을 삭제", async () => {
    const file = jpegFile("folder\\wrong.jpg");
    const expectedHash = createHash("sha256")
      .update(new Uint8Array(await file.arrayBuffer()))
      .digest("hex");
    let observedPath = "";
    let observedBytes = Buffer.alloc(0);
    aiMocks.extractQuestionsFromFile.mockImplementationOnce(async (path: string) => {
      observedPath = path;
      observedBytes = readFileSync(path);
      return extractedQuestions();
    });

    const form = new FormData();
    form.set("file", file);
    const res = await call(env, `/api/subjects/${subjectId}/wrong/extract`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { added: number };
    expect(body.added).toBe(2); // 모킹 반환값 2개
    expect(aiMocks.extractQuestionsFromFile).toHaveBeenCalledWith(expect.any(String), "image");
    expect(basename(observedPath)).toMatch(
      new RegExp(`^${expectedHash}-[0-9a-f-]{36}-wrong\\.jpg$`)
    );
    expect(observedBytes).toEqual(Buffer.from(await file.arrayBuffer()));
    expect(existsSync(observedPath)).toBe(false);
  });

  it("삽입된 문제가 wrong 목록에 나타남", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/wrong`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{
      wrong_count: number;
      from_wrong_note: number;
      qtype: string;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.wrong_count).toBeGreaterThan(0);
      expect(row.from_wrong_note).toBe(1);
    }
  });

  it("wrong_count=1 확인", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/wrong`, {
      headers: { cookie },
    });
    const rows = (await res.json()) as Array<{ wrong_count: number }>;
    for (const row of rows) {
      expect(row.wrong_count).toBe(1);
    }
  });

  it("file 없음 → 400", async () => {
    const form = new FormData();
    const res = await call(env, `/api/subjects/${subjectId}/wrong/extract`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    expect(res.status).toBe(400);
  });

  it("지원하지 않는 형식 → 400", async () => {
    const form = new FormData();
    form.set("file", new File(["data"], "test.txt", { type: "text/plain" }));
    const res = await call(env, `/api/subjects/${subjectId}/wrong/extract`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    expect(res.status).toBe(400);
  });

  it("AI 실패 시에도 임시 파일을 삭제하고 원시 오류·절대 경로를 노출하지 않음", async () => {
    aiMocks.extractQuestionsFromFile.mockRejectedValueOnce(
      new Error("provider failed at /Users/private/오답.jpg with secret-response")
    );
    const form = new FormData();
    form.set("file", jpegFile("실패.jpg"));
    const res = await call(env, `/api/subjects/${subjectId}/wrong/extract`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("오답 노트 문제 추출에 실패했습니다. 잠시 후 다시 시도해 주세요.");
    expect(body.error).not.toContain("/Users");
    expect(body.error).not.toContain("secret-response");
    const temporaryPath = aiMocks.extractQuestionsFromFile.mock.calls[0]?.[0] as string;
    expect(temporaryPath).toBeTruthy();
    expect(existsSync(temporaryPath)).toBe(false);
  });
});

// ── GET /api/subjects/:id/quiz?wrong=1 ──────────────────────────────────────
describe("GET /api/subjects/:id/quiz?wrong=1", () => {
  it("wrong=1 → 오답 문제만 반환", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/quiz?wrong=1`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ id: number }>;
    // wrong/extract로 추가된 2개 문제가 wrong_count=1 이므로 반환되어야 함
    expect(rows.length).toBeGreaterThan(0);
  });

  it("wrong=1 결과에는 answer/explanation 필드 없음", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/quiz?wrong=1`, {
      headers: { cookie },
    });
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    for (const row of rows) {
      expect(row).not.toHaveProperty("answer");
      expect(row).not.toHaveProperty("explanation");
    }
  });
});

// ── 마지막 시도 시각 ──────────────────────────────────────────────────────────
describe("GET /api/subjects/:id/wrong — last_attempted_at", () => {
  it("시도가 없으면 null, 채점 후에는 시각을 반환", async () => {
    const before = await call(env, `/api/subjects/${subjectId}/wrong`, { headers: { cookie } });
    const rowsBefore = (await before.json()) as Array<{ id: number; last_attempted_at: string | null }>;
    expect(rowsBefore.length).toBeGreaterThan(0);
    for (const row of rowsBefore) expect(row.last_attempted_at).toBeNull();

    const target = rowsBefore[0];
    const answer = await call(env, `/api/questions/${target.id}/answer`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ answer: "일부러 틀린 답", attemptId: "attempt-last-at" }),
    });
    expect(answer.status).toBe(200);

    const after = await call(env, `/api/subjects/${subjectId}/wrong`, { headers: { cookie } });
    const rowsAfter = (await after.json()) as Array<{ id: number; last_attempted_at: string | null }>;
    expect(rowsAfter.find((row) => row.id === target.id)?.last_attempted_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });
});

// ── POST /api/subjects/:id/wrong/analyze ─────────────────────────────────────
describe("POST /api/subjects/:id/wrong/analyze", () => {
  it("오답 있으면 200, analysis 반환", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/wrong/analyze`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { analysis: string };
    expect(typeof body.analysis).toBe("string");
    expect(body.analysis.length).toBeGreaterThan(0);
  });

  it("오답 없는 과목 → 400", async () => {
    const createRes = await call(env, "/api/subjects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "빈과목" }),
    });
    const { id: emptyId } = (await createRes.json()) as { id: number };

    const res = await call(env, `/api/subjects/${emptyId}/wrong/analyze`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(400);
  });

  it("AI 분석 오류의 원문과 경로를 응답에 포함하지 않음", async () => {
    aiMocks.analyzeWrongQuestions.mockRejectedValueOnce(
      new Error("sensitive prompt at /Users/private/study-note.md")
    );
    const res = await call(env, `/api/subjects/${subjectId}/wrong/analyze`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("오답 분석에 실패했습니다. 잠시 후 다시 시도해 주세요.");
    expect(body.error).not.toContain("/Users");
    expect(body.error).not.toContain("sensitive prompt");
  });
});
