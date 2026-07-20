import { createHash } from "node:crypto";
import { basename } from "node:path";
import { PDFDocument } from "pdf-lib";
import type { FileStore } from "./filestore";
import type { LocalDB } from "./localdb";

function originalNameFromKey(key: string, fallback: string): string {
  const leaf = basename(key);
  const prefixed = /^(?:\d{10,}|[0-9a-f]{16})-(.+)$/i.exec(leaf);
  return (prefixed?.[1] || fallback || leaf).normalize("NFC");
}

async function inspectPdf(buffer: Buffer, extractedText: string | null): Promise<{
  pageCount: number | null;
  warning: string | null;
}> {
  try {
    const pdf = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
    if (pdf.isEncrypted) {
      return { pageCount: pdf.getPageCount() || null, warning: "암호화된 원본 PDF는 재분석이 필요합니다" };
    }
    const pageCount = pdf.getPageCount();
    if (pageCount < 1) return { pageCount: null, warning: "원본 PDF의 페이지 수를 확인할 수 없습니다" };
    const headings = [...(extractedText ?? "").matchAll(/^#{1,4}\s*페이지\s*(\d+)\s*$/gm)]
      .map((match) => Number(match[1]));
    const valid = new Set(headings.filter((page) => Number.isInteger(page) && page >= 1 && page <= pageCount));
    const complete = headings.length === pageCount && valid.size === pageCount &&
      Array.from({ length: pageCount }, (_, index) => index + 1).every((page) => valid.has(page));
    return {
      pageCount,
      warning: complete
        ? null
        : `페이지 근거 불완전: ${valid.size}/${pageCount}쪽. 재분석을 권장합니다`,
    };
  } catch {
    return { pageCount: null, warning: "원본 PDF 구조를 확인할 수 없어 재분석이 필요합니다" };
  }
}

/**
 * 0022 이전에 저장된 파일의 hash/page evidence를 한 번만 비파괴 backfill한다.
 * 기존 추출 텍스트는 지우지 않고, 페이지 근거가 불완전하면 UI 경고만 기록한다.
 */
export async function auditStoredFileEvidence(
  db: LocalDB,
  files: FileStore
): Promise<{ materials: number; warnings: number; bookFiles: number; prunedPageCaches: number }> {
  const { results: materials } = await db.prepare(
    `SELECT id, kind, title, r2_key, extracted_text
     FROM materials
     WHERE r2_key IS NOT NULL AND integrity_checked_at IS NULL`
  ).all<{
    id: number;
    kind: string;
    title: string;
    r2_key: string;
    extracted_text: string | null;
  }>();

  let warnings = 0;
  for (const material of materials) {
    const buffer = await files.get(material.r2_key);
    const digest = buffer ? createHash("sha256").update(buffer).digest("hex") : null;
    let pageCount = material.kind === "pdf" ? null : 1;
    let warning = buffer ? null : "저장된 원본 파일을 찾을 수 없습니다";
    if (buffer && material.kind === "pdf") {
      const inspected = await inspectPdf(buffer, material.extracted_text);
      pageCount = inspected.pageCount;
      warning = inspected.warning;
    }
    if (warning) warnings++;
    const name = originalNameFromKey(material.r2_key, material.title);
    try {
      await db.prepare(
        `UPDATE materials
         SET content_hash = COALESCE(content_hash, ?), original_filename = COALESCE(original_filename, ?),
             page_count = COALESCE(?, page_count), integrity_warning = ?, integrity_checked_at = datetime('now')
         WHERE id = ?`
      ).bind(digest, name, pageCount, warning, material.id).run();
    } catch {
      // 같은 과목의 기존 중복 파일이 unique hash를 먼저 차지한 경우에도 경고·페이지 근거는 남긴다.
      await db.prepare(
        `UPDATE materials
         SET original_filename = COALESCE(original_filename, ?), page_count = COALESCE(?, page_count),
             integrity_warning = COALESCE(?, '동일한 파일이 같은 과목에 이미 등록되어 있습니다'),
             integrity_checked_at = datetime('now')
         WHERE id = ?`
      ).bind(name, pageCount, warning, material.id).run();
    }
  }

  const { results: bookFiles } = await db.prepare(
    `SELECT id, r2_key, mime FROM book_files
     WHERE content_hash IS NULL OR page_count IS NULL`
  ).all<{ id: number; r2_key: string; mime: string }>();
  for (const file of bookFiles) {
    const buffer = await files.get(file.r2_key);
    if (!buffer) continue;
    const digest = createHash("sha256").update(buffer).digest("hex");
    let pageCount = file.mime === "application/pdf" ? null : 1;
    if (file.mime === "application/pdf") pageCount = (await inspectPdf(buffer, null)).pageCount;
    try {
      await db.prepare(
        "UPDATE book_files SET content_hash = COALESCE(content_hash, ?), page_count = COALESCE(?, page_count) WHERE id = ?"
      ).bind(digest, pageCount, file.id).run();
    } catch {
      await db.prepare("UPDATE book_files SET page_count = COALESCE(?, page_count) WHERE id = ?")
        .bind(pageCount, file.id).run();
    }
  }

  const { results: liveFiles } = await db.prepare("SELECT id FROM book_files").all<{ id: number }>();
  const prunedPageCaches = await files.prunePageCache(new Set(liveFiles.map((file) => file.id)));
  return { materials: materials.length, warnings, bookFiles: bookFiles.length, prunedPageCaches };
}
