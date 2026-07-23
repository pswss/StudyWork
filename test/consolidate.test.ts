import { describe, it, expect, beforeAll, vi } from "vitest";
import { makeEnv, call, pauseNextUsageIncrement } from "./helpers";

const mockState = vi.hoisted(() => ({ delay: 0, calls: 0 }));

// AI 호출은 모킹 (canned reply). 나머지 실제 export는 원본을 유지한다.
vi.mock("../src/claude", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/claude")>()),
  chat: async () => "응답",
  consolidate: async () => {
    mockState.calls++;
    if (mockState.delay) await new Promise((resolve) => setTimeout(resolve, mockState.delay));
    return "# 단권화 노트\n이차함수 y=a(x-p)^2+q";
  },
  extractFromFile: async () => "추출된 텍스트",
  buildSystemPrompt: (name: string) => `튜터 ${name}`,
}));

const env = makeEnv();
let cookie: string;
let subjectId: number;
let parallelSubjectId: number;
let emptySubjectId: number;

beforeAll(async () => {
  const login = await call(env, "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-password" })
  });
  cookie = login.headers.get("set-cookie")!.split(";")[0];

  const create = async (name: string) => {
    const res = await call(env, "/api/subjects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name })
    });
    return ((await res.json()) as { id: number }).id;
  };
  subjectId = await create("수학");
  parallelSubjectId = await create("병렬과목");
  emptySubjectId = await create("빈과목");

  const form = new FormData();
  form.set("title", "필기");
  form.set("text", "이차함수 y=a(x-p)^2+q");
  await call(env, `/api/subjects/${subjectId}/materials`, {
    method: "POST", headers: { cookie }, body: form
  });

  const parallelForm = new FormData();
  parallelForm.set("title", "병렬 필기");
  parallelForm.set("text", "등차수열의 일반항은 a_n=a_1+(n-1)d");
  await call(env, `/api/subjects/${parallelSubjectId}/materials`, {
    method: "POST", headers: { cookie }, body: parallelForm
  });
});

// 단권화는 백그라운드 처리 — note.status가 processing에서 벗어날 때까지 대기
async function waitNote(sid: number): Promise<{ content: string; status: string; progress: number }> {
  for (let i = 0; i < 200; i++) {
    const res = await call(env, `/api/subjects/${sid}/note`, { headers: { cookie } });
    if (res.status === 200) {
      const n = (await res.json()) as { content: string; status: string; progress: number };
      if (n.status !== "processing") return n;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("단권화 대기 시간 초과");
}

describe("consolidate API", () => {
  it("단권화 시작(202) → 백그라운드 완료 → 노트 저장·조회", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/consolidate`, {
      method: "POST", headers: { cookie }
    });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { status: string }).status).toBe("processing");

    const saved = await waitNote(subjectId);
    expect(saved.status).toBe("ready");
    expect(saved.progress).toBe(100);
    expect(saved.content).toContain("단권화 노트");
  });

  it("재생성 시 노트가 교체됨(과목당 1개)", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/consolidate`, {
      method: "POST", headers: { cookie }
    });
    expect(res.status).toBe(202);
    const saved = await waitNote(subjectId);
    expect(saved.status).toBe("ready");
  });

  it("이미 처리 중인 단권화 중복 요청은 409", async () => {
    mockState.delay = 80;
    try {
      const before = await env.DB.prepare("SELECT COALESCE(SUM(calls), 0) AS n FROM usage_daily")
        .first<{ n: number }>();
      const responses = await Promise.all([
        call(env, `/api/subjects/${subjectId}/consolidate`, { method: "POST", headers: { cookie } }),
        call(env, `/api/subjects/${subjectId}/consolidate`, { method: "POST", headers: { cookie } }),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
      const after = await env.DB.prepare("SELECT COALESCE(SUM(calls), 0) AS n FROM usage_daily")
        .first<{ n: number }>();
      expect(after!.n).toBe(before!.n + 1);
      await waitNote(subjectId);
    } finally {
      mockState.delay = 0;
    }
  });

  it("서로 다른 과목 단권화는 동시에 진행", async () => {
    mockState.delay = 80;
    try {
      const responses = await Promise.all([
        call(env, `/api/subjects/${subjectId}/consolidate`, { method: "POST", headers: { cookie } }),
        call(env, `/api/subjects/${parallelSubjectId}/consolidate`, { method: "POST", headers: { cookie } }),
      ]);
      expect(responses.map((response) => response.status)).toEqual([202, 202]);

      const running = await Promise.all([
        call(env, `/api/subjects/${subjectId}/note`, { headers: { cookie } }),
        call(env, `/api/subjects/${parallelSubjectId}/note`, { headers: { cookie } }),
      ]);
      const runningNotes = await Promise.all(running.map((response) => response.json())) as { status: string }[];
      expect(runningNotes.map((note) => note.status)).toEqual(["processing", "processing"]);

      const completed = await Promise.all([waitNote(subjectId), waitNote(parallelSubjectId)]);
      expect(completed.map((note) => note.status)).toEqual(["ready", "ready"]);
    } finally {
      mockState.delay = 0;
    }
  });

  it("자료가 없으면 400", async () => {
    const res = await call(env, `/api/subjects/${emptySubjectId}/consolidate`, {
      method: "POST", headers: { cookie }
    });
    expect(res.status).toBe(400);
  });

  it("노트가 없으면 404", async () => {
    const res = await call(env, `/api/subjects/${emptySubjectId}/note`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it("추가 요청(instructions)을 담아 단권화 요청 가능", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/consolidate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ instructions: "공식 위주로 정리" })
    });
    expect(res.status).toBe(202);
    await waitNote(subjectId);
  });

  it("materialIds 선택 단권화 — 존재하지 않는 id만 주면 400", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/consolidate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ materialIds: [99999] })
    });
    expect(res.status).toBe(400);
  });

  it("노트 직접 수정(PUT) → 저장 반영", async () => {
    const put = await call(env, `/api/subjects/${subjectId}/note`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ content: "# 내가 고친 노트" })
    });
    expect(put.status).toBe(200);
    const note = await call(env, `/api/subjects/${subjectId}/note`, { headers: { cookie } });
    const saved = (await note.json()) as { content: string };
    expect(saved.content).toBe("# 내가 고친 노트");
  });

  it("사용량 확인 중 수동 수정해도 오래된 단권화가 다시 시작되지 않음", async () => {
    const paused = pauseNextUsageIncrement(env.DB);
    const callsBefore = mockState.calls;
    try {
      const pending = call(env, `/api/subjects/${subjectId}/consolidate`, {
        method: "POST",
        headers: { cookie },
      });
      await paused.entered;
      const manual = await call(env, `/api/subjects/${subjectId}/note`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ content: "# 경합 중 수동 저장" }),
      });
      expect(manual.status).toBe(200);
      paused.release();
      expect((await pending).status).toBe(409);
      expect(mockState.calls).toBe(callsBefore);
      const saved = await call(env, `/api/subjects/${subjectId}/note`, { headers: { cookie } });
      await expect(saved.json()).resolves.toMatchObject({
        content: "# 경합 중 수동 저장",
        status: "ready",
      });
    } finally {
      paused.restore();
    }
  });

  it("빈 내용으로 노트 수정 시 400", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/note`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ content: "  " })
    });
    expect(res.status).toBe(400);
  });

  it("단권화·수정이 기록(버전)으로 쌓이고 개별 조회 가능", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/note-versions`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const vs = (await res.json()) as { id: number; created_at: string; len: number }[];
    expect(vs.length).toBeGreaterThanOrEqual(5); // 단권화 4회 + 수동 저장 1회
    const full = await call(env, `/api/note-versions/${vs[0].id}`, { headers: { cookie } });
    expect(full.status).toBe(200);
    expect(((await full.json()) as { content: string }).content.length).toBeGreaterThan(0);
  });

  it("문제집 개념·팁 항목도 단권화 소스가 된다 (자료 0개여도 202)", async () => {
    const create = await call(env, "/api/subjects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "문제집만" })
    });
    const sid = ((await create.json()) as { id: number }).id;
    await env.DB.prepare("INSERT INTO books (subject_id, title) VALUES (?, '뉴런')").bind(sid).run();
    const b = await env.DB.prepare("SELECT id FROM books WHERE subject_id = ?").bind(sid).first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO book_items (book_id, file_id, category, number, answer, content, page) VALUES (?, 0, '개념', '', '', '수열의 극한 정의', 1)"
    ).bind(b!.id).run();

    const res = await call(env, `/api/subjects/${sid}/consolidate`, { method: "POST", headers: { cookie } });
    expect(res.status).toBe(202);
    const saved = await waitNote(sid);
    expect(saved.status).toBe("ready");
  });

  it("기록 하나 삭제 + 노트 전체 삭제(기록 포함)", async () => {
    const vres = await call(env, `/api/subjects/${subjectId}/note-versions`, { headers: { cookie } });
    const vs = (await vres.json()) as { id: number }[];
    const before = vs.length;
    const del = await call(env, `/api/note-versions/${vs[0].id}`, { method: "DELETE", headers: { cookie } });
    expect(del.status).toBe(200);
    const after = ((await (await call(env, `/api/subjects/${subjectId}/note-versions`, { headers: { cookie } })).json()) as unknown[]).length;
    expect(after).toBe(before - 1);

    const delAll = await call(env, `/api/subjects/${subjectId}/note`, { method: "DELETE", headers: { cookie } });
    expect(delAll.status).toBe(200);
    expect((await call(env, `/api/subjects/${subjectId}/note`, { headers: { cookie } })).status).toBe(404);
    const none = ((await (await call(env, `/api/subjects/${subjectId}/note-versions`, { headers: { cookie } })).json()) as unknown[]).length;
    expect(none).toBe(0);
  });
});
