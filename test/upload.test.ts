import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PDFDocument, PDFHexString } from "pdf-lib";
import {
  MAX_IMAGE_BYTES,
  MAX_PDF_BYTES,
  MAX_PDF_PAGES,
  MAX_UPLOAD_NAME_BYTES,
  safeUploadName,
  validateUpload,
} from "../src/upload";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

function toOwnedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function makePdf(pageCount = 1): Promise<ArrayBuffer> {
  const document = await PDFDocument.create();
  for (let page = 0; page < pageCount; page++) document.addPage([100, 100]);
  return toOwnedArrayBuffer(await document.save({ useObjectStreams: false }));
}

async function makeEncryptionMarkedPdf(): Promise<ArrayBuffer> {
  const document = await PDFDocument.create();
  document.addPage([100, 100]);
  const placeholder = PDFHexString.of("00".repeat(32));
  const encryption = document.context.obj({
    Filter: "Standard",
    V: 1,
    R: 2,
    O: placeholder,
    U: placeholder,
    P: -4,
  });
  document.context.trailerInfo.Encrypt = document.context.register(encryption);
  return toOwnedArrayBuffer(await document.save({ useObjectStreams: false }));
}

describe("upload validation", () => {
  it("uses PDF bytes rather than the declared MIME and preserves evidence", async () => {
    const bytes = await makePdf(2);
    const file = new File([bytes], "한글 교재.pdf", { type: "image/jpeg" });

    const result = await validateUpload(file);

    expect(result).toEqual({
      kind: "pdf",
      mime: "application/pdf",
      name: "한글 교재.pdf",
      bytes: expect.any(ArrayBuffer),
      contentHash: createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
      pageCount: 2,
    });
  });

  it("accepts a real PNG by magic bytes even when the MIME is spoofed", async () => {
    const result = await validateUpload(
      new File([ONE_PIXEL_PNG], "필기.png", { type: "application/pdf" })
    );

    expect(result).toMatchObject({
      kind: "image",
      mime: "image/png",
      name: "필기.png",
      pageCount: 1,
    });
  });

  it("rejects empty and MIME-only fake files", async () => {
    await expect(
      validateUpload(new File([], "empty.pdf", { type: "application/pdf" }))
    ).resolves.toEqual({ error: "빈 파일은 업로드할 수 없습니다" });
    await expect(
      validateUpload(new File(["not a pdf"], "fake.pdf", { type: "application/pdf" }))
    ).resolves.toEqual({ error: "지원하는 PDF 또는 이미지 파일이 아닙니다" });
  });

  it("rejects a corrupt file that only carries a PDF header", async () => {
    const file = new File(["%PDF-1.7\nnot a valid document"], "broken.pdf", {
      type: "application/pdf",
    });

    await expect(validateUpload(file)).resolves.toEqual({
      error: "손상되었거나 지원하지 않는 PDF입니다",
    });
  });

  it("rejects PDFs above the configured page cap", async () => {
    const bytes = await makePdf(MAX_PDF_PAGES + 1);

    await expect(
      validateUpload(new File([bytes], "too-many-pages.pdf", { type: "application/pdf" }))
    ).resolves.toEqual({ error: `PDF는 ${MAX_PDF_PAGES}페이지 이하만 지원합니다` });
  });

  it("detects encryption from the PDF trailer instead of attempting analysis", async () => {
    const bytes = await makeEncryptionMarkedPdf();

    await expect(
      validateUpload(new File([bytes], "locked.pdf", { type: "application/pdf" }))
    ).resolves.toEqual({
      error: "암호화된 PDF는 지원하지 않습니다. 암호를 해제한 사본을 사용해 주세요",
    });
  });

  it("rejects byte-size limits before or after content detection as appropriate", async () => {
    const oversizedPdf = {
      size: MAX_PDF_BYTES + 1,
      arrayBuffer: () => {
        throw new Error("size guard must run before reading");
      },
    } as unknown as File;
    await expect(validateUpload(oversizedPdf)).resolves.toEqual({
      error: "파일은 200MB 이하만 지원합니다",
    });

    const oversizedPng = new File(
      [ONE_PIXEL_PNG, new Uint8Array(MAX_IMAGE_BYTES + 1 - ONE_PIXEL_PNG.byteLength)],
      "huge.png",
      { type: "image/png" }
    );
    await expect(validateUpload(oversizedPng)).resolves.toEqual({
      error: "이미지는 30MB 이하만 지원합니다",
    });
  });

  it("normalizes path-like names without breaking Korean filenames", () => {
    expect(safeUploadName("../private/수학\u0000 필기.pdf")).toBe("수학 필기.pdf");
    expect(safeUploadName("   ")).toBe("upload");
    const long = safeUploadName(`${"가".repeat(180)}.pdf`);
    expect(Buffer.byteLength(long, "utf8")).toBeLessThanOrEqual(MAX_UPLOAD_NAME_BYTES);
    expect(long.endsWith(".pdf")).toBe(true);
    expect(Buffer.byteLength(`${"a".repeat(102)}${long}`, "utf8")).toBeLessThanOrEqual(255);
  });
});
