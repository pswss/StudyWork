import { describe, it, expect, beforeAll } from "vitest";
import { makeEnv, call } from "./helpers";

const env = makeEnv();
let cookie: string;

beforeAll(async () => {
  const login = await call(env, "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-password" })
  });
  cookie = login.headers.get("set-cookie")!.split(";")[0];
});

const authed = (path: string, init: RequestInit = {}) =>
  call(env, path, { ...init, headers: { ...(init.headers as any), cookie, "content-type": "application/json" } });

describe("subjects API", () => {
  it("과목 생성 → 목록 조회", async () => {
    const create = await authed("/api/subjects", {
      method: "POST", body: JSON.stringify({ name: "수학", color: "#6cd8ff" })
    });
    expect(create.status).toBe(201);
    const { id } = await create.json() as { id: number };
    expect(id).toBeGreaterThan(0);

    const list = await authed("/api/subjects");
    const subjects = await list.json() as any[];
    expect(subjects.some((s) => s.name === "수학")).toBe(true);
  });

  it("이름 없으면 400", async () => {
    const res = await authed("/api/subjects", { method: "POST", body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });

  it("과목 삭제", async () => {
    const create = await authed("/api/subjects", {
      method: "POST", body: JSON.stringify({ name: "임시" })
    });
    const { id } = await create.json() as { id: number };
    const book = await env.DB.prepare("INSERT INTO books (subject_id, title) VALUES (?, '삭제 테스트') RETURNING id")
      .bind(id).first<{ id: number }>();
    const file = await env.DB.prepare(
      `INSERT INTO book_files (book_id, name, r2_key, mime, status)
       VALUES (?, '원본.pdf', 'books/delete.pdf', 'application/pdf', 'ready') RETURNING id`
    ).bind(book!.id).first<{ id: number }>();
    await env.FILES.put("books/delete.pdf", new Uint8Array([1]).buffer);
    await env.FILES.put(`pages/${file!.id}-1.png`, new Uint8Array([2]).buffer);
    const del = await authed(`/api/subjects/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(env.FILES.exists("books/delete.pdf")).toBe(false);
    expect(env.FILES.exists(`pages/${file!.id}-1.png`)).toBe(false);
  });
});
