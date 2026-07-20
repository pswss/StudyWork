import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { auditStoredFileEvidence } from "../src/file-evidence";
import { makeEnv } from "./helpers";

async function pdfBytes(pages: number): Promise<ArrayBuffer> {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < pages; index++) pdf.addPage();
  const bytes = await pdf.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("legacy file evidence audit", () => {
  it("기존 PDF의 hash/page를 backfill하고 불완전 페이지 근거만 비파괴 경고", async () => {
    const env = makeEnv();
    const subject = await env.DB.prepare("INSERT INTO subjects (name) VALUES ('근거 점검') RETURNING id")
      .first<{ id: number }>();
    const incompleteKey = "materials/1/1700000000000-누락.pdf";
    const completeKey = "materials/1/1700000000001-완전.pdf";
    await env.FILES.put(incompleteKey, await pdfBytes(3));
    await env.FILES.put(completeKey, await pdfBytes(2));
    await env.FILES.put("pages/999-1.png", new Uint8Array([1]).buffer);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO materials (subject_id, kind, title, r2_key, extracted_text, status)
         VALUES (?, 'pdf', '누락', ?, '## 페이지 1\n본문', 'ready')`
      ).bind(subject!.id, incompleteKey),
      env.DB.prepare(
        `INSERT INTO materials (subject_id, kind, title, r2_key, extracted_text, status)
         VALUES (?, 'pdf', '완전', ?, '## 페이지 1\n가\n\n## 페이지 2\n나', 'ready')`
      ).bind(subject!.id, completeKey),
    ]);

    const result = await auditStoredFileEvidence(env.DB, env.FILES);
    expect(result).toMatchObject({ materials: 2, warnings: 1, prunedPageCaches: 1 });
    expect(env.FILES.exists("pages/999-1.png")).toBe(false);

    const { results } = await env.DB.prepare(
      `SELECT title, original_filename, content_hash, page_count, integrity_warning, integrity_checked_at,
              extracted_text, status
       FROM materials ORDER BY id`
    ).all<{
      title: string;
      original_filename: string;
      content_hash: string;
      page_count: number;
      integrity_warning: string | null;
      integrity_checked_at: string;
      extracted_text: string;
      status: string;
    }>();
    expect(results[0]).toMatchObject({
      original_filename: "누락.pdf",
      page_count: 3,
      integrity_warning: "페이지 근거 불완전: 1/3쪽. 재분석을 권장합니다",
      extracted_text: "## 페이지 1\n본문",
      status: "ready",
    });
    expect(results[0].content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(results[0].integrity_checked_at).toBeTruthy();
    expect(results[1].integrity_warning).toBeNull();

    // checked_at이 있는 행은 다음 부팅 점검에서 다시 대용량 파일을 읽지 않는다.
    await expect(auditStoredFileEvidence(env.DB, env.FILES)).resolves.toMatchObject({ materials: 0 });
  });
});
