import { describe, expect, it } from "vitest";
import { makeEnv } from "./helpers";
import { recoverInterruptedJobs } from "../src/recovery";

describe("server restart recovery", () => {
  it("중단된 자료·문제 추출·단권화를 error/retry 상태로 복구한다", async () => {
    const env = makeEnv();
    const subject = await env.DB.prepare("INSERT INTO subjects (name) VALUES ('복구') RETURNING id")
      .first<{ id: number }>();
    const book = await env.DB.prepare("INSERT INTO books (subject_id, title) VALUES (?, '교재') RETURNING id")
      .bind(subject!.id).first<{ id: number }>();
    const processingFile = await env.DB.prepare(
      `INSERT INTO book_files (book_id, name, r2_key, mime, status)
       VALUES (?, 'a.pdf', 'a.pdf', 'application/pdf', 'processing') RETURNING id`
    ).bind(book!.id).first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO materials (subject_id, kind, title, r2_key, status, book_id) VALUES (?, 'pdf', '교재', 'a.pdf', 'ready', ?)"
    ).bind(subject!.id, book!.id).run();
    const interruptedMaterialRow = await env.DB.prepare(
      `INSERT INTO materials (subject_id, kind, title, r2_key, status)
       VALUES (?, 'pdf', '추출 중', 'b.pdf', 'processing') RETURNING id`
    ).bind(subject!.id).first<{ id: number }>();
    await env.DB.prepare(
      "UPDATE materials SET chunk_total = 3 WHERE id = ?"
    ).bind(interruptedMaterialRow!.id).run();
    await env.DB.prepare(
      `INSERT INTO material_extraction_chunks
       (material_id, chunk_index, page_from, page_to, content)
       VALUES (?, 0, 1, 6, '성공 청크')`
    ).bind(interruptedMaterialRow!.id).run();
    await env.DB.prepare(
      "UPDATE book_files SET chunk_total = 4 WHERE id = ?"
    ).bind(processingFile!.id).run();
    await env.DB.prepare(
      "INSERT INTO book_extraction_chunks (file_id, chunk_index, payload) VALUES (?, 0, '[]')"
    ).bind(processingFile!.id).run();
    await env.DB.prepare(
      `INSERT INTO materials
       (subject_id, kind, title, r2_key, extracted_text, status, book_processing)
       VALUES (?, 'pdf', '연결 전 중단', 'claim.pdf', '본문', 'ready', 1)`
    ).bind(subject!.id).run();
    const cancelledBook = await env.DB.prepare(
      "INSERT INTO books (subject_id, title) VALUES (?, '취소 교재') RETURNING id"
    ).bind(subject!.id).first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO book_files (book_id, name, r2_key, mime, status, error)
       VALUES (?, 'cancel.pdf', 'cancel.pdf', 'application/pdf', 'error', '사용자 중단')`
    ).bind(cancelledBook!.id).run();
    await env.DB.prepare(
      `INSERT INTO materials
       (subject_id, kind, title, r2_key, extracted_text, status, book_id, book_processing)
       VALUES (?, 'pdf', '취소 유지', 'cancel.pdf', '본문', 'ready', ?, 1)`
    ).bind(subject!.id, cancelledBook!.id).run();
    await env.DB.prepare(
      "INSERT INTO notes (subject_id, content, status) VALUES (?, '기존 내용', 'processing')"
    ).bind(subject!.id).run();
    const job = await env.DB.prepare(
      "INSERT INTO ai_jobs (subject_id, kind) VALUES (?, 'question-generate') RETURNING id"
    ).bind(subject!.id).first<{ id: number }>();

    await recoverInterruptedJobs(env.DB);

    const material = await env.DB.prepare("SELECT status, pending_to_book FROM materials WHERE title = '교재'")
      .first<{ status: string; pending_to_book: number }>();
    const interruptedMaterial = await env.DB.prepare(
      "SELECT status, error, retry_chunk_count, chunk_total FROM materials WHERE title = '추출 중'"
    ).first<{ status: string; error: string; retry_chunk_count: number; chunk_total: number }>();
    const claimOnly = await env.DB.prepare(
      "SELECT pending_to_book, book_processing FROM materials WHERE title = '연결 전 중단'"
    ).first<{ pending_to_book: number; book_processing: number }>();
    const cancelled = await env.DB.prepare(
      "SELECT pending_to_book, book_processing FROM materials WHERE title = '취소 유지'"
    ).first<{ pending_to_book: number; book_processing: number }>();
    const file = await env.DB.prepare(
      "SELECT status, error, retry_chunk_count, chunk_total FROM book_files WHERE book_id = ?"
    ).bind(book!.id).first<{
      status: string;
      error: string;
      retry_chunk_count: number;
      chunk_total: number;
    }>();
    const note = await env.DB.prepare("SELECT status, content FROM notes WHERE subject_id = ?")
      .bind(subject!.id).first<{ status: string; content: string }>();
    const interruptedJob = await env.DB.prepare("SELECT status, error FROM ai_jobs WHERE id = ?")
      .bind(job!.id).first<{ status: string; error: string }>();

    expect(material).toEqual({ status: "ready", pending_to_book: 1 });
    expect(interruptedMaterial).toEqual({
      status: "error",
      error: "서버 재시작으로 중단됨",
      retry_chunk_count: 2,
      chunk_total: 3,
    });
    expect(claimOnly).toEqual({ pending_to_book: 1, book_processing: 0 });
    expect(cancelled).toEqual({ pending_to_book: 0, book_processing: 0 });
    expect(file).toEqual({
      status: "error",
      error: "서버 재시작으로 중단됨",
      retry_chunk_count: 3,
      chunk_total: 4,
    });
    expect(note).toEqual({ status: "error", content: "기존 내용" });
    expect(interruptedJob).toEqual({
      status: "error",
      error: "서버 재시작으로 작업이 중단되었습니다. 다시 시도해 주세요.",
    });
  });
});
