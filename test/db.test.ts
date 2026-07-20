import { describe, it, expect } from "vitest";
import { makeEnv } from "./helpers";

describe("D1 schema", () => {
  it("subjects 테이블에 삽입/조회 가능", async () => {
    const { DB } = makeEnv();
    await DB.prepare("INSERT INTO subjects (name, color) VALUES (?, ?)")
      .bind("수학", "#6cd8ff").run();
    const row = await DB.prepare("SELECT * FROM subjects WHERE name = ?")
      .bind("수학").first<{ color: string }>();
    expect(row).not.toBeNull();
    expect(row!.color).toBe("#6cd8ff");
  });

  it("materials가 subject에 연결됨", async () => {
    const { DB } = makeEnv();
    const s = await DB.prepare("INSERT INTO subjects (name) VALUES ('과학') RETURNING id").first<{ id: number }>();
    await DB.prepare(
      "INSERT INTO materials (subject_id, kind, title, extracted_text) VALUES (?, 'text', '필기', 'F=ma')"
    ).bind(s!.id).run();
    const m = await DB.prepare("SELECT * FROM materials WHERE subject_id = ?").bind(s!.id).first<{ kind: string }>();
    expect(m!.kind).toBe("text");
  });
});
