import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeEnv, call } from "./helpers";

const env = makeEnv();
let cookie: string;
let subjectId: number;
const originalProvider = process.env.STUDYWORK_AI_PROVIDER;

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

afterAll(() => {
  if (originalProvider === undefined) delete process.env.STUDYWORK_AI_PROVIDER;
  else process.env.STUDYWORK_AI_PROVIDER = originalProvider;
});

describe("materials API", () => {
  it("텍스트 자료 업로드 → 목록 조회", async () => {
    const form = new FormData();
    form.set("title", "시험 범위");
    form.set("text", "이차함수 전체, p.120-150");
    const res = await call(env, `/api/subjects/${subjectId}/materials`, {
      method: "POST", headers: { cookie }, body: form
    });
    expect(res.status).toBe(201);

    const list = await call(env, `/api/subjects/${subjectId}/materials`, { headers: { cookie } });
    const items = (await list.json()) as any[];
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("시험 범위");
    expect(items[0].status).toBe("ready");
  });

  it("파일도 텍스트도 없으면 400", async () => {
    const form = new FormData();
    form.set("title", "빈 자료");
    const res = await call(env, `/api/subjects/${subjectId}/materials`, {
      method: "POST", headers: { cookie }, body: form
    });
    expect(res.status).toBe(400);
  });

  it("동일한 실제 파일은 같은 과목에 중복 등록하지 않음", async () => {
    process.env.STUDYWORK_AI_PROVIDER = "invalid-test-provider";
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const upload = async (name: string) => {
      const form = new FormData();
      form.set("title", name);
      form.set("file", new File([bytes], name, { type: "application/octet-stream" }));
      return call(env, `/api/subjects/${subjectId}/materials`, { method: "POST", headers: { cookie }, body: form });
    };
    const first = await upload("원본.png");
    expect(first.status).toBe(201);
    const firstBody = await first.json() as { id: number };
    const duplicate = await upload("이름만다른.png");
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({ existingId: expect.any(Number) });
    let failed: any;
    for (let attempt = 0; attempt < 50; attempt++) {
      failed = await env.DB.prepare(
        "SELECT status, error, retry_chunk_count, chunk_total FROM materials WHERE id = ?"
      ).bind(firstBody.id).first<{
        status: string;
        error: string | null;
        retry_chunk_count: number;
        chunk_total: number;
      }>();
      if (failed?.status === "error") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(failed).toMatchObject({
      status: "error",
      error: "AI 분석에 실패했습니다. 재시도해 주세요",
      retry_chunk_count: 1,
      chunk_total: 1,
    });
  });

  it("없는 과목 업로드와 과도한 텍스트를 명시적으로 거부", async () => {
    const missing = new FormData();
    missing.set("title", "없음");
    missing.set("text", "내용");
    expect((await call(env, "/api/subjects/999999/materials", {
      method: "POST", headers: { cookie }, body: missing,
    })).status).toBe(404);

    const huge = new FormData();
    huge.set("title", "너무 큼");
    huge.set("text", "가".repeat(800_000));
    expect((await call(env, `/api/subjects/${subjectId}/materials`, {
      method: "POST", headers: { cookie }, body: huge,
    })).status).toBe(413);
  });

  it("자료 삭제", async () => {
    const list = await call(env, `/api/subjects/${subjectId}/materials`, { headers: { cookie } });
    const items = (await list.json()) as any[];
    const res = await call(env, `/api/materials/${items[0].id}`, {
      method: "DELETE", headers: { cookie }
    });
    expect(res.status).toBe(200);
  });
});
