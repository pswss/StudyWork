import { Hono } from "hono";
import type { Env } from "./index";
import { cancelJob } from "./jobs";
import { clearBookExtractionCache } from "./books";

export const subjects = new Hono<{ Bindings: Env }>();

subjects.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.*, COUNT(m.id) AS material_count
     FROM subjects s LEFT JOIN materials m ON m.subject_id = s.id
     GROUP BY s.id ORDER BY s.created_at`
  ).all();
  return c.json(results);
});

subjects.post("/", async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as any);
  if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
  const row = await c.env.DB.prepare(
    "INSERT INTO subjects (name) VALUES (?) RETURNING id"
  ).bind(body.name.trim()).first<{ id: number }>();
  return c.json({ id: row!.id }, 201);
});

subjects.delete("/:id", async (c) => {
  const id = c.req.param("id");
  cancelJob(`note:${id}`);
  cancelJob(`chat:${id}`);
  // 삭제 대상 키는 DB 행이 사라지기 전에 읽고, 실제 파일은 DB batch 성공 뒤 정리한다.
  const { results: mats } = await c.env.DB.prepare(
    "SELECT id, r2_key FROM materials WHERE subject_id = ? AND r2_key IS NOT NULL"
  ).bind(id).all<{ id: number; r2_key: string }>();
  for (const m of mats) {
    cancelJob(`mat:${m.id}`);
  }
  const { results: bookFiles } = await c.env.DB.prepare(
    "SELECT id, book_id, r2_key FROM book_files WHERE book_id IN (SELECT id FROM books WHERE subject_id = ?)"
  ).bind(id).all<{ id: number; book_id: number; r2_key: string }>();
  for (const bookId of new Set(bookFiles.map((file) => file.book_id))) {
    cancelJob(`book-solutions:${bookId}`);
  }
  for (const f of bookFiles) {
    cancelJob(`book:${f.id}`);
  }
  const { results: exams } = await c.env.DB.prepare(
    "SELECT id FROM exams WHERE subject_id = ?"
  ).bind(id).all<{ id: number }>();
  for (const exam of exams) cancelJob(`exam:${exam.id}`);
  const { results: examJobs } = await c.env.DB.prepare(
    "SELECT id FROM ai_jobs WHERE subject_id = ? AND kind = 'exam-plan' AND status = 'processing'"
  ).bind(id).all<{ id: number }>();
  for (const job of examJobs) cancelJob(`exam-job:${job.id}`);
  const { results: questionJobs } = await c.env.DB.prepare(
    "SELECT id FROM ai_jobs WHERE subject_id = ? AND kind = 'question-generate' AND status = 'processing'"
  ).bind(id).all<{ id: number }>();
  for (const job of questionJobs) cancelJob(`question-job:${job.id}`);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM messages WHERE subject_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM materials WHERE subject_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM questions WHERE subject_id = ?").bind(id),
    c.env.DB.prepare(
      "DELETE FROM book_items WHERE book_id IN (SELECT id FROM books WHERE subject_id = ?)"
    ).bind(id),
    c.env.DB.prepare(
      "DELETE FROM book_files WHERE book_id IN (SELECT id FROM books WHERE subject_id = ?)"
    ).bind(id),
    c.env.DB.prepare("DELETE FROM books WHERE subject_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM note_versions WHERE subject_id = ?").bind(id),
    c.env.DB.prepare(
      "DELETE FROM plan_items WHERE exam_id IN (SELECT id FROM exams WHERE subject_id = ?)"
    ).bind(id),
    c.env.DB.prepare("DELETE FROM exams WHERE subject_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM ai_jobs WHERE subject_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM subjects WHERE id = ?").bind(id)
  ]);
  for (const m of mats) {
    await c.env.FILES.delete(m.r2_key).catch(() => {});
  }
  for (const f of bookFiles) {
    clearBookExtractionCache(f.id);
    await c.env.FILES.delete(f.r2_key).catch(() => {});
    await c.env.FILES.deletePrefix(`pages/${f.id}-`).catch(() => {});
  }
  return c.json({ ok: true });
});
