import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEnv, call } from "./helpers";
import { ObsidianVault } from "../src/obsidian";

const env = makeEnv();
const root = mkdtempSync(join(tmpdir(), "studywork-route-vault-한글 "));
let cookie: string;
let subjectId: number;

beforeAll(async () => {
  env.OBSIDIAN = new ObsidianVault(root);
  env.OBSIDIAN_WRITE_ENABLED = false;
  const login = await call(env, "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-password" }),
  });
  cookie = login.headers.get("set-cookie")!.split(";")[0];
  const subject = await call(env, "/api/subjects", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "수학/심화" }),
  });
  subjectId = ((await subject.json()) as { id: number }).id;
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("Obsidian routes", () => {
  it("상태는 절대 경로 없이 읽기 전용 연결을 반환", async () => {
    const res = await call(env, "/api/obsidian/status", { headers: { cookie } });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "ready", vaultName: expect.any(String), canRead: true, canWrite: false, mode: "read-only" });
    expect(JSON.stringify(body)).not.toContain(root);
  });

  it("가져오기·파일 검색 API를 노출하지 않음", async () => {
    const files = await call(env, "/api/obsidian/files?q=%ED%95%99%EC%8A%B5", { headers: { cookie } });
    expect(files.status).toBe(404);
    const importNote = await call(env, `/api/subjects/${subjectId}/obsidian/import`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ path: "학습 노트.md" }),
    });
    expect(importNote.status).toBe(404);
  });

  it("preview는 무쓰기, read-only export는 403, 허용 후 create-only export", async () => {
    await env.DB.prepare(
      `INSERT INTO notes (subject_id, content, status, progress)
       VALUES (?, '# 단권화\n내용', 'ready', 100)
       ON CONFLICT(subject_id) DO UPDATE SET content = excluded.content, status = 'ready'`
    ).bind(subjectId).run();
    const path = "내보내기/수학 단권화.md";
    const preview = await call(env, `/api/subjects/${subjectId}/obsidian/export/preview`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    expect(preview.status).toBe(200);
    await expect(preview.clone().json()).resolves.toMatchObject({ canWrite: false });
    expect(existsSync(join(root, path))).toBe(false);

    const exportNote = () => call(env, `/api/subjects/${subjectId}/obsidian/export`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    expect((await exportNote()).status).toBe(403);
    env.OBSIDIAN_WRITE_ENABLED = true;
    const vault = env.OBSIDIAN!;
    const status = vault.status.bind(vault);
    vault.status = () => ({ ...status(), canWrite: false });
    try {
      const readOnlyPreview = await call(env, `/api/subjects/${subjectId}/obsidian/export/preview`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ path }),
      });
      await expect(readOnlyPreview.json()).resolves.toMatchObject({ canWrite: false });
      expect((await exportNote()).status).toBe(403);
    } finally {
      vault.status = status;
    }
    expect((await exportNote()).status).toBe(201);
    const content = readFileSync(join(root, path), "utf8");
    expect(content).toContain("type: studywork-note");
    expect(content).toContain("# 단권화");
    expect((await exportNote()).status).toBe(409);
  });

  it("미설정 상태와 잘못된 설정 상태를 구분", async () => {
    const other = makeEnv();
    const login = await call(other, "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-password" }),
    });
    const auth = login.headers.get("set-cookie")!.split(";")[0];
    expect(await (await call(other, "/api/obsidian/status", { headers: { cookie: auth } })).json())
      .toMatchObject({ status: "unconfigured" });
    other.OBSIDIAN_ERROR = "unavailable";
    expect(await (await call(other, "/api/obsidian/status", { headers: { cookie: auth } })).json())
      .toMatchObject({ status: "unavailable" });
  });
});
