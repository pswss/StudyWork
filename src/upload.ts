// 업로드 파일 공통 검증 — materials / books / wrong 라우트에서 사용.
// 브라우저가 보낸 MIME/확장자는 신뢰하지 않고 실제 바이트와 PDF 구조를 확인한다.

import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";

export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
// 큰 PDF는 AI 요청 전에 6쪽 이하 slice로 분할하므로 원본 자체는 50MB를 넘을 수 있다.
export const MAX_PDF_BYTES = 200 * 1024 * 1024;
export const MAX_PDF_PAGES = 500;
// The longest FileStore leaf prefix is "<sha256>-<uuid>-". Keeping the
// user-controlled suffix at 150 UTF-8 bytes stays below NAME_MAX=255.
export const MAX_UPLOAD_NAME_BYTES = 150;

export type ValidatedUpload = {
  kind: "pdf" | "image";
  mime: "application/pdf" | "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  name: string;
  bytes: ArrayBuffer;
  contentHash: string;
  pageCount: number;
};

export type UploadValidationResult = ValidatedUpload | { error: string };

function truncateUtf8(value: string, maxBytes: number): string {
  let out = "";
  let bytes = 0;
  for (const codePoint of value) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (bytes + size > maxBytes) break;
    out += codePoint;
    bytes += size;
  }
  return out;
}

export function safeUploadName(input: string): string {
  const leaf = input.split(/[\\/]/).pop() ?? "";
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned) return "upload";
  const normalized = cleaned.normalize("NFC");
  const dot = normalized.lastIndexOf(".");
  const extension = dot > 0 && Buffer.byteLength(normalized.slice(dot), "utf8") <= 20
    ? normalized.slice(dot)
    : "";
  const stem = extension ? normalized.slice(0, dot) : normalized;
  const stemBudget = MAX_UPLOAD_NAME_BYTES - Buffer.byteLength(extension, "utf8");
  return truncateUtf8(stem, stemBudget) + extension;
}

export function detectImageMime(bytes: Uint8Array): ValidatedUpload["mime"] | null {
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)
  ) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  ) return "image/webp";
  if (bytes.length >= 6) {
    const signature = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  return null;
}

function hasPdfHeader(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 1024))).toString("latin1");
  return head.includes("%PDF-");
}

export async function validateUpload(file: File): Promise<UploadValidationResult> {
  if (file.size <= 0) return { error: "빈 파일은 업로드할 수 없습니다" };
  if (file.size > MAX_PDF_BYTES) return { error: "파일은 200MB 이하만 지원합니다" };

  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    return { error: "업로드 파일을 읽을 수 없습니다" };
  }
  const view = new Uint8Array(bytes);
  const contentHash = createHash("sha256").update(view).digest("hex");
  const name = safeUploadName(file.name);

  if (hasPdfHeader(view)) {
    if (view.byteLength > MAX_PDF_BYTES) return { error: "PDF는 200MB 이하만 지원합니다" };
    try {
      const pdf = await PDFDocument.load(view, { ignoreEncryption: true, updateMetadata: false });
      if (pdf.isEncrypted) return { error: "암호화된 PDF는 지원하지 않습니다. 암호를 해제한 사본을 사용해 주세요" };
      const pageCount = pdf.getPageCount();
      if (pageCount < 1) return { error: "페이지가 없는 PDF입니다" };
      if (pageCount > MAX_PDF_PAGES) {
        return { error: `PDF는 ${MAX_PDF_PAGES}페이지 이하만 지원합니다` };
      }
      return { kind: "pdf", mime: "application/pdf", name, bytes, contentHash, pageCount };
    } catch {
      return { error: "손상되었거나 지원하지 않는 PDF입니다" };
    }
  }

  const mime = detectImageMime(view);
  if (!mime) return { error: "지원하는 PDF 또는 이미지 파일이 아닙니다" };
  if (view.byteLength > MAX_IMAGE_BYTES) return { error: "이미지는 30MB 이하만 지원합니다" };
  return { kind: "image", mime, name, bytes, contentHash, pageCount: 1 };
}
