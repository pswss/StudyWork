import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { AI_MAX_FILE_BYTES, AIProviderError } from "./codex-provider";
import type { FileStore } from "./filestore";
import { detectImageMime } from "./upload";

const execFileP = promisify(execFile);

export type BookPageSource = {
  id: number;
  r2_key: string;
  mime: string;
};

export type FigureBundleItem = {
  id: number;
  source: BookPageSource;
  page: number;
  box: [number, number] | null;
};

export class BookPageNotFoundError extends Error {}

export function parseFigureBox(value: string | null | undefined): [number, number] | null {
  if (!value) return null;
  const [top, bottom] = value.split(",").map(Number);
  return Number.isFinite(top) && Number.isFinite(bottom) && top >= 0 && bottom <= 1 && top < bottom
    ? [top, bottom]
    : null;
}

function exactArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AIProviderError("cancelled", "사용자 중단");
}

async function runSips(args: string[], signal?: AbortSignal): Promise<{ stdout: string }> {
  throwIfAborted(signal);
  try {
    const result = await execFileP("sips", args, signal ? { signal } : undefined);
    throwIfAborted(signal);
    return { stdout: String(result.stdout) };
  } catch (error) {
    if (signal?.aborted) throw new AIProviderError("cancelled", "사용자 중단");
    throw error;
  }
}

async function cropPng(path: string, box: [number, number] | null, signal?: AbortSignal): Promise<void> {
  if (!box) return;
  const { stdout } = await runSips(["-g", "pixelHeight", "-g", "pixelWidth", path], signal);
  const height = Number(/pixelHeight: (\d+)/.exec(stdout)?.[1]);
  const width = Number(/pixelWidth: (\d+)/.exec(stdout)?.[1]);
  const top = Math.max(0, Math.floor((box[0] - 0.02) * height));
  const bottom = Math.min(height, Math.ceil((box[1] + 0.02) * height));
  if (height > 0 && width > 0 && bottom - top >= 40) {
    await runSips(["--cropOffset", String(top), "0", "-c", String(bottom - top), String(width), path], signal);
  }
}

/** 화면과 AI가 공유하는 원본 페이지/crop 렌더 경로. */
export async function renderBookPageImage(
  files: FileStore,
  source: BookPageSource,
  page: number,
  box: [number, number] | null,
  signal?: AbortSignal
): Promise<{ bytes: Buffer; mime: string }> {
  if (!Number.isInteger(page) || page < 1) throw new BookPageNotFoundError("페이지 범위 초과");
  if (source.mime !== "application/pdf" && page !== 1) {
    throw new BookPageNotFoundError("페이지 범위 초과");
  }

  // 이미지 원본 전체는 변환 없이 반환한다. crop이 있거나 PDF이면 PNG 캐시를 공유한다.
  if (source.mime !== "application/pdf" && !box) {
    const bytes = await files.get(source.r2_key);
    if (!bytes) throw new BookPageNotFoundError("원본 파일이 없습니다");
    return { bytes, mime: source.mime };
  }

  const cacheKey = box
    ? `pages/${source.id}-${page}-${box[0]}-${box[1]}.png`
    : `pages/${source.id}-${page}.png`;
  const cached = await files.get(cacheKey);
  if (cached) return { bytes: cached, mime: "image/png" };

  const dir = mkdtempSync(join(tmpdir(), "studywork-page-"));
  try {
    throwIfAborted(signal);
    let inputPath: string;
    if (source.mime === "application/pdf") {
      const src = await PDFDocument.load(readFileSync(files.absolutePath(source.r2_key)), {
        ignoreEncryption: true,
        updateMetadata: false,
      });
      if (page > src.getPageCount()) throw new BookPageNotFoundError("페이지 범위 초과");
      const out = await PDFDocument.create();
      const [copied] = await out.copyPages(src, [page - 1]);
      out.addPage(copied);
      inputPath = join(dir, "page.pdf");
      writeFileSync(inputPath, await out.save());
    } else {
      inputPath = files.absolutePath(source.r2_key);
    }

    const pngPath = join(dir, "page.png");
    await runSips(["-s", "format", "png", "-Z", "1600", inputPath, "--out", pngPath], signal);
    await cropPng(pngPath, box, signal);
    const bytes = readFileSync(pngPath);
    throwIfAborted(signal);
    await files.put(cacheKey, exactArrayBuffer(bytes));
    return { bytes, mime: "image/png" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 원본 근거 task마다 QUESTION_ID 라벨과 crop/페이지 한 장을 넣은 단일 AI 첨부 PDF를 만든다. */
export async function createFigureBundlePdf(
  files: FileStore,
  items: FigureBundleItem[],
  signal?: AbortSignal
): Promise<{ path: string; cleanup: () => void } | null> {
  if (items.length === 0) return null;
  const dir = mkdtempSync(join(tmpdir(), "studywork-figures-"));
  try {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.HelveticaBold);
    for (const [index, item] of items.entries()) {
      throwIfAborted(signal);
      const rendered = await renderBookPageImage(files, item.source, item.page, item.box, signal);
      let bytes = rendered.bytes;
      let mime = detectImageMime(bytes);
      if (mime !== "image/png" && mime !== "image/jpeg") {
        const rawPath = join(dir, `source-${index}`);
        const pngPath = join(dir, `source-${index}.png`);
        writeFileSync(rawPath, bytes);
        await runSips(["-s", "format", "png", rawPath, "--out", pngPath], signal);
        bytes = readFileSync(pngPath);
        mime = "image/png";
      }
      const image = mime === "image/jpeg"
        ? await document.embedJpg(bytes)
        : await document.embedPng(bytes);
      const scale = Math.min(800 / image.width, 1200 / image.height);
      const width = image.width * scale;
      const height = image.height * scale;
      const page = document.addPage([Math.max(400, width + 32), height + 64]);
      page.drawImage(image, { x: 16, y: 16, width, height });
      page.drawText(`QUESTION_ID ${item.id}`, {
        x: 16,
        y: height + 36,
        size: 16,
        font,
      });
    }
    const bytes = await document.save();
    if (bytes.byteLength > AI_MAX_FILE_BYTES) {
      throw new AIProviderError("file_too_large", "원본 근거 묶음이 AI 파일 입력 한도(50MB)를 초과했습니다");
    }
    throwIfAborted(signal);
    const path = join(dir, "figures.pdf");
    writeFileSync(path, bytes);
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    if (error instanceof AIProviderError) throw error;
    throw new AIProviderError("invalid_file", "문항 원본을 준비할 수 없습니다");
  }
}
