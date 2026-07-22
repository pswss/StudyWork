import { describe, it, expect, beforeAll, vi } from "vitest";
import { makeEnv, call } from "./helpers";

// AI 호출은 모킹 — 노드 풀에서는 라우트와 같은 모듈 그래프이므로 vi.mock이 적용된다.
// capMaterialExcerpts는 실제 구현 유지 — 라우트를 통과한 컨텍스트 예산을 그대로 검증한다.
const aiMocks = vi.hoisted(() => ({
  chat: vi.fn(async () => "꼭짓점은 (2, 9)입니다."),
}));
vi.mock("../src/claude", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/claude")>();
  return {
    chat: aiMocks.chat,
    consolidate: async () => "# 단권화 노트",
    extractFromFile: async () => "추출된 텍스트",
    buildSystemPrompt: (name: string) => `튜터 ${name}`,
    capMaterialExcerpts: actual.capMaterialExcerpts,
    QUIZ_SOURCE_MAX_CHARS: actual.QUIZ_SOURCE_MAX_CHARS,
  };
});

const env = makeEnv();
let cookie: string;
let subjectId: number;

beforeAll(async () => {
  const login = await call(env, "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-password" })
  });
  cookie = login.headers.get("set-cookie")!.split(";")[0];
  const create = await call(env, "/api/subjects", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "수학" })
  });
  subjectId = ((await create.json()) as { id: number }).id;
});

describe("chat API", () => {
  it("메시지 전송(일반 모드) → 서버 AI 설정으로 응답 저장·반환", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/chat`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      // 구버전 클라이언트가 보내는 override 값도 서버 AI 설정을 바꾸면 안 된다.
      body: JSON.stringify({
        message: "이차함수 꼭짓점?",
        mode: "general",
        model: "haiku",
        effort: "max",
        thinking: "disabled",
      })
    });
    expect(res.status).toBe(200);
    const { reply } = (await res.json()) as { reply: string };
    expect(reply).toContain("꼭짓점");

    const hist = await call(env, `/api/subjects/${subjectId}/messages`, { headers: { cookie } });
    const msgs = (await hist.json()) as any[];
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
    expect(aiMocks.chat).toHaveBeenCalledTimes(1);
    expect(aiMocks.chat.mock.calls[0]).toHaveLength(4);
  });

  it("자료 기반 모드 + 자료 0개 → AI 미호출, 안내 반환", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/chat`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ message: "페르마의 마지막 정리는?" })
    });
    expect(res.status).toBe(200);
    const { reply } = (await res.json()) as { reply: string };
    expect(reply).toContain("자료");
    expect(reply).not.toContain("꼭짓점"); // 모킹된 AI 응답이 아니어야 함

    const hist = await call(env, `/api/subjects/${subjectId}/messages`, { headers: { cookie } });
    const msgs = (await hist.json()) as any[];
    expect(msgs).toHaveLength(4); // 안내도 대화 기록에 남는다
    expect(msgs[3].role).toBe("assistant");
  });

  it("빈 메시지는 400", async () => {
    const res = await call(env, `/api/subjects/${subjectId}/chat`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ message: "" })
    });
    expect(res.status).toBe(400);
  });
});

describe("chat 컨텍스트 예산·자료 선택", () => {
  let bigId: number;
  let smallId: number;

  beforeAll(async () => {
    const insert = async (title: string, text: string) =>
      (await env.DB.prepare(
        `INSERT INTO materials (subject_id, kind, title, extracted_text, status)
         VALUES (?, 'text', ?, ?, 'ready') RETURNING id`
      ).bind(subjectId, title, text).first<{ id: number }>())!.id;
    bigId = await insert("큰 자료", "가".repeat(200_000));
    smallId = await insert("작은 자료", "이차함수 y=a(x-p)^2+q");
  });

  it("자료 전체 본문을 그대로 주입하지 않고 96k 예산으로 발췌", async () => {
    aiMocks.chat.mockClear();
    const res = await call(env, `/api/subjects/${subjectId}/chat`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ message: "요약해줘" }),
    });
    expect(res.status).toBe(200);
    const materials = aiMocks.chat.mock.calls[0][1] as Array<{ title: string; extracted_text: string }>;
    expect(materials.map((m) => m.title)).toEqual(["큰 자료", "작은 자료"]);
    const total = materials.reduce((sum, m) => sum + m.extracted_text.length, 0);
    expect(total).toBeLessThanOrEqual(96_000);
  });

  it("materialIds로 선택한 자료만 컨텍스트로 전달", async () => {
    aiMocks.chat.mockClear();
    const res = await call(env, `/api/subjects/${subjectId}/chat`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ message: "이것만 봐줘", materialIds: [smallId] }),
    });
    expect(res.status).toBe(200);
    const materials = aiMocks.chat.mock.calls[0][1] as Array<{ title: string }>;
    expect(materials.map((m) => m.title)).toEqual(["작은 자료"]);
  });

  it.each([
    { materialIds: [] },
    { materialIds: [1, 1] },
    { materialIds: ["1"] },
    { materialIds: [999_999] },
  ])("잘못되거나 사용할 수 없는 materialIds를 400으로 거부: %j", async (body) => {
    const res = await call(env, `/api/subjects/${subjectId}/chat`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ message: "질문", ...body }),
    });
    expect(res.status).toBe(400);
  });
});
