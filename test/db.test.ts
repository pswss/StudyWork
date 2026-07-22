import { cpSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { makeEnv } from "./helpers";
import { LocalDB } from "../src/localdb";

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

  it("0027이 기존 그림 문항 원본을 대체 설명 재추출 대기열에 넣는다", async () => {
    const sourceDir = resolve(import.meta.dirname, "..", "migrations");
    const migrationDir = mkdtempSync(join(tmpdir(), "studywork-migrations-"));
    for (const file of readdirSync(sourceDir).filter(name => name.endsWith(".sql") && name < "0027")) {
      cpSync(join(sourceDir, file), join(migrationDir, file));
    }
    const dbPath = join(migrationDir, "legacy.db");
    let db = new LocalDB(dbPath, { migrationsDir: migrationDir });
    const subject = await db.prepare("INSERT INTO subjects (name) VALUES ('수학') RETURNING id").first<{ id: number }>();
    const book = await db.prepare("INSERT INTO books (subject_id, title) VALUES (?, '도형') RETURNING id").bind(subject!.id).first<{ id: number }>();
    await db.prepare(
      "INSERT INTO materials (subject_id, kind, title, r2_key, extracted_text, status, book_id) VALUES (?, 'pdf', '도형', 'source.pdf', '본문', 'ready', ?)"
    ).bind(subject!.id, book!.id).run();
    await db.prepare(
      "INSERT INTO questions (subject_id, source, qtype, difficulty, question, answer, has_figure, book_id) VALUES (?, 'uploaded', 'short', '중', '그림 문제', '1', 1, ?)"
    ).bind(subject!.id, book!.id).run();
    db.close();

    cpSync(join(sourceDir, "0027_question_figure_description.sql"), join(migrationDir, "0027_question_figure_description.sql"));
    db = new LocalDB(dbPath, { migrationsDir: migrationDir });
    const material = await db.prepare(
      "SELECT pending_to_book, book_retry_count, figure_backfill_pending FROM materials WHERE book_id = ?"
    ).bind(book!.id).first<{ pending_to_book: number; book_retry_count: number; figure_backfill_pending: number }>();
    const question = await db.prepare("SELECT figure_description FROM questions WHERE book_id = ?")
      .bind(book!.id).first<{ figure_description: string | null }>();
    expect(material).toEqual({ pending_to_book: 1, book_retry_count: 0, figure_backfill_pending: 1 });
    expect(question?.figure_description).toBeNull();
    db.close();
  });
});

describe("backupDaily", () => {
  const migrationsDir = resolve(import.meta.dirname, "..", "migrations");

  it("VACUUM INTO 스냅샷 생성 + 같은 날 중복 생성 안 함 + 오래된 백업 정리", async () => {
    const dir = mkdtempSync(join(tmpdir(), "studywork-backup-test-"));
    const db = new LocalDB(join(dir, "studywork.db"), { migrationsDir });
    await db.prepare("INSERT INTO subjects (name) VALUES ('백업과목')").run();

    const backupDir = join(dir, "backups");
    // 오래된 백업 파일 — keep=2면 최신 2개(가짜 1개 + 오늘)만 남아야 한다
    // (mkdir은 backupDaily가 함) 먼저 한 번 실행해 폴더를 만든 뒤 심는다
    const created = db.backupDaily(backupDir, 2);
    expect(created).not.toBeNull();
    expect(basename(created!)).toMatch(/^\d{4}-\d{2}-\d{2}\.db$/);

    // 스냅샷을 실제로 열어 데이터가 들어있는지 확인
    const snapshot = new LocalDB(created!);
    const row = await snapshot.prepare("SELECT name FROM subjects WHERE name = '백업과목'").first<{ name: string }>();
    expect(row?.name).toBe("백업과목");
    snapshot.close();

    // 같은 날 재실행은 멱등 — 새로 만들지 않는다
    expect(db.backupDaily(backupDir, 2)).toBeNull();

    // 오래된 백업을 심고 정리 확인 (keep=2: 오늘 + 가장 최근 과거 1개만 유지)
    writeFileSync(join(backupDir, "2020-01-01.db"), "old");
    writeFileSync(join(backupDir, "2020-01-02.db"), "old");
    writeFileSync(join(backupDir, "not-a-backup.txt"), "keep");
    db.backupDaily(backupDir, 2);
    const names = readdirSync(backupDir).sort();
    expect(names).toContain("not-a-backup.txt"); // 백업 패턴 아닌 파일은 건드리지 않음
    const backups = names.filter((name) => /^\d{4}-\d{2}-\d{2}\.db$/.test(name));
    expect(backups).toHaveLength(2);
    expect(backups).toContain(basename(created!));
    expect(backups).toContain("2020-01-02.db");
    db.close();
  });
});
