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

  it("내부 문제집 삭제가 실패하면 자료 삭제도 롤백하고 파일을 보존", async () => {
    const book = await env.DB.prepare(
      "INSERT INTO books (subject_id, title) VALUES (?, '원자성 테스트') RETURNING id"
    ).bind(subjectId).first<{ id: number }>();
    const bookKey = `books/${subjectId}/atomic.pdf`;
    await env.DB.prepare(
      `INSERT INTO book_files (book_id, name, r2_key, mime, status)
       VALUES (?, 'atomic.pdf', ?, 'application/pdf', 'ready')`
    ).bind(book!.id, bookKey).run();
    const materialKey = `materials/${subjectId}/atomic.pdf`;
    const material = await env.DB.prepare(
      `INSERT INTO materials (subject_id, kind, title, r2_key, status, book_id)
       VALUES (?, 'pdf', '원자성 자료', ?, 'ready', ?) RETURNING id`
    ).bind(subjectId, materialKey, book!.id).first<{ id: number }>();
    await env.FILES.put(bookKey, new Uint8Array([1]).buffer);
    await env.FILES.put(materialKey, new Uint8Array([2]).buffer);

    await env.DB.prepare(
      `CREATE TRIGGER fail_material_book_delete BEFORE DELETE ON books
       WHEN OLD.id = ${book!.id}
       BEGIN SELECT RAISE(ABORT, 'forced book delete failure'); END`
    ).run();
    try {
      const res = await call(env, `/api/materials/${material!.id}`, {
        method: "DELETE", headers: { cookie },
      });
      expect(res.status).toBe(500);
      await expect(env.DB.prepare("SELECT id FROM materials WHERE id = ?").bind(material!.id).first())
        .resolves.toMatchObject({ id: material!.id });
      await expect(env.DB.prepare("SELECT id FROM books WHERE id = ?").bind(book!.id).first())
        .resolves.toMatchObject({ id: book!.id });
      expect(env.FILES.exists(materialKey)).toBe(true);
      expect(env.FILES.exists(bookKey)).toBe(true);
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS fail_material_book_delete").run();
      await call(env, `/api/materials/${material!.id}`, { method: "DELETE", headers: { cookie } });
      await env.FILES.delete(materialKey);
      await env.FILES.delete(bookKey);
    }
  });

  it("파일 정리 실패는 완료된 DB 삭제를 되돌리지 않음", async () => {
    const key = `materials/${subjectId}/cleanup-failure.pdf`;
    const material = await env.DB.prepare(
      `INSERT INTO materials (subject_id, kind, title, r2_key, status)
       VALUES (?, 'pdf', '파일 정리 실패', ?, 'ready') RETURNING id`
    ).bind(subjectId, key).first<{ id: number }>();
    await env.FILES.put(key, new Uint8Array([3]).buffer);
    const originalDelete = env.FILES.delete.bind(env.FILES);
    env.FILES.delete = async (target: string) => {
      if (target === key) throw new Error("forced file cleanup failure");
      return originalDelete(target);
    };
    try {
      const res = await call(env, `/api/materials/${material!.id}`, {
        method: "DELETE", headers: { cookie },
      });
      expect(res.status).toBe(200);
      await expect(env.DB.prepare("SELECT id FROM materials WHERE id = ?").bind(material!.id).first())
        .resolves.toBeNull();
      expect(env.FILES.exists(key)).toBe(true);
    } finally {
      env.FILES.delete = originalDelete;
      await env.FILES.delete(key);
    }
  });
});
