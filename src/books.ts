// 문제집 라우트 — 문제집/해설지 업로드 → AI가 개념·팁·문제·해설로 분류(백그라운드),
// 문제+해설 번호가 짝지어지면 퀴즈 문제은행에 자동 등록한다.
import { Hono } from "hono";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PDFDocument } from "pdf-lib";
import type { Env } from "./index";
import {
  detectAnswerKeyPagesFromFile, detectDetailedSolutionPagesFromFile,
  extractProblemsFromFile, extractSolutionsFromFile,
  mapPool, numericPrintedLocator, slicePdf, isUsageLimitText, validatePrintedQuestionSequence,
  ProblemChunkValidationError, type QuizItemEx, type SolutionItem,
} from "./claude";
import { checkAndIncrementUsage } from "./usage";
import { detectImageMime, validateUpload, type ValidatedUpload } from "./upload";
import {
  activeBookMutations, activeSolutionBooks,
  cancelJob, finishJob, isCurrentJob, startJob, type JobToken,
} from "./jobs";
import { AIProviderError, AI_MAX_FILE_BYTES } from "./codex-provider";
import { createAIJob, readyAIJobStatement, runAIJob } from "./ai-jobs";
import { gradeAnswer } from "./quiz";

const execFileP = promisify(execFile);

export const bookRoutes = new Hono<{ Bindings: Env }>();

// ── 추출 파이프라인 ───────────────────────────────────────────────────────────

const CHUNK = 20; // 사용자 설정: 20쪽씩, 경계 문제를 위해 1쪽 겹침
const FALLBACK_CHUNK = 10; // 20쪽 응답이 구조 검증에 실패한 구간만 더 작게 재검증
const CONCURRENCY = 4; // 동시 4청크
const MAX_ANSWER_SCAN_CHUNKS = 3;
const MAX_ANSWER_REFERENCE_PAGES = 8;
export const MAX_AUTO_BOOK_RETRIES = 3;

// 같은 fileId의 구 잡과 재시도 잡이 겹치면 취소 표식을 공유해 서로의 결과를 저장할 수 있다.
// 프로세스 안에서 실행 중인 잡을 별도로 추적해, 완전히 끝나기 전 재시도를 막는다.
const activeBookJobs = new Set<number>();
const answerReferenceCache = new Map<number, number[]>();

export function clearBookExtractionCache(fileId: number): void {
  answerReferenceCache.delete(fileId);
}

const AUTO_RETRY_BLOCKED_CODES: ReadonlySet<AIProviderError["code"]> = new Set([
  "invalid_config",
  "invalid_file",
  "file_too_large",
  "auth",
  "rate_limit",
  "cancelled",
]);

class ProtectedQuestionConflictError extends Error {}

const BACKFILL_CONFLICT_WARNING =
  "자동 문제 보강 건너뜀: 학습 기록이 있는 기존 문항이 현재 추출 범위와 달라 기존 문제와 기록을 보존했습니다.";

function blocksAutomaticRetry(error: unknown): boolean {
  return error instanceof AIProviderError && AUTO_RETRY_BLOCKED_CODES.has(error.code);
}
// 검증 완료 후 DB insert 전까지 같은 과목·바이트의 동시 업로드를 직렬화한다.
// 영속 중복은 book_files.content_hash 조회로 막고, 이 Set은 그 조회와 insert 사이 경합만 닫는다.
const activeBookUploads = new Set<string>();

export function publicBookError(error: unknown): string {
  if (error instanceof ProtectedQuestionConflictError) {
    return `${error.message}. 기존 문제와 학습 기록은 그대로 보존했습니다.`;
  }
  if (error instanceof AIProviderError) {
    const messages: Partial<Record<AIProviderError["code"], string>> = {
      invalid_config: "AI 설정이 올바르지 않습니다",
      invalid_file: "AI가 파일을 읽을 수 없습니다",
      file_too_large: "AI 요청용 PDF 구간이 50MB를 초과했습니다",
      auth: "Codex CLI 로그인이 필요합니다",
      rate_limit: "Codex 사용량 한도 또는 속도 제한에 도달했습니다. 잠시 후 재시도해 주세요",
      timeout: "AI 분석 시간이 초과되었습니다. 재시도해 주세요",
      cancelled: "사용자 중단",
      unavailable: "Codex CLI가 응답하지 않습니다. 잠시 후 재시도해 주세요",
      invalid_response: "AI 응답 형식이 유효하지 않습니다. 재시도해 주세요",
      empty_response: "AI가 빈 응답을 반환했습니다. 재시도해 주세요",
    };
    return messages[error.code] ?? "문제 추출에 실패했습니다. 재시도해 주세요";
  }
  if (!(error instanceof Error)) return "문제 추출에 실패했습니다. 재시도해 주세요";
  if (error.message === "사용자 중단" || error.message === "문제를 찾지 못했습니다") return error.message;
  const chunk = /^(?:사용량 한도로 문제 추출이 중단됨|일부 구간 추출 실패|추출 실패) \(청크 (\d{1,4})\/(\d{1,4})(?: 실패)?\)/.exec(error.message);
  if (chunk) return `문제 추출 실패: 페이지 구간 ${chunk[1]}/${chunk[2]}개`;
  return "문제 추출에 실패했습니다. 재시도해 주세요";
}

function publicSolutionError(error: unknown): string {
  if (error instanceof ProblemChunkValidationError) return error.message;
  if (error instanceof Error && /^(?:상세 해설|문제집에 없는|문제 번호|문항 수|정답|해설 항목)/.test(error.message)) {
    return error.message;
  }
  return publicBookError(error).replace("문제 추출", "해설 분석");
}

function stableQuestionKey(page: number | null, question: string): string {
  return `${page ?? 0}|${question.normalize("NFKC").toLowerCase().replace(/\s+/g, "")}`;
}

function printedLocatorFromQuestionPrefix(question: string): number | null {
  const match = /^\s*(\[\s*0*\d+\s*\]|\(\s*0*\d+\s*\)|(?:문제|q(?:uestion)?|#)\s*0*\d+(?:\s*번(?:\s*문제)?)?\s*[.)]?|0*\d+\s*(?:번(?:\s*문제)?|[.)]))(?!\d)/iu
    .exec(question.normalize("NFKC"));
  return numericPrintedLocator(match?.[1]);
}

function printedLocatorKey(page: number | null, locator: number | null): string | null {
  return page === null || locator === null ? null : `${page}|${locator}`;
}

async function parkFigureBackfillConflict(
  env: Env,
  fileId: number,
  bookId: number
): Promise<boolean> {
  const material = await env.DB.prepare(
    "SELECT id FROM materials WHERE book_id = ? AND figure_backfill_pending = 1"
  ).bind(bookId).first<{ id: number }>();
  if (!material) return false;

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE materials
       SET pending_to_book = 0, book_processing = 0,
           integrity_warning = CASE
             WHEN instr(COALESCE(integrity_warning, ''), ?) > 0 THEN integrity_warning
             WHEN NULLIF(TRIM(integrity_warning), '') IS NULL THEN ?
             ELSE ? || ' · ' || integrity_warning
           END
       WHERE id = ? AND figure_backfill_pending = 1`
    ).bind(BACKFILL_CONFLICT_WARNING, BACKFILL_CONFLICT_WARNING, BACKFILL_CONFLICT_WARNING, material.id),
    env.DB.prepare(
      `UPDATE book_files
       SET status = 'ready', error = NULL, progress = 100, retry_chunk_count = 0
       WHERE id = ? AND status = 'processing'`
    ).bind(fileId),
    env.DB.prepare(
      `DELETE FROM book_extraction_chunks
       WHERE file_id = ?
         AND EXISTS (SELECT 1 FROM book_files WHERE id = ? AND status = 'ready')`
    ).bind(fileId, fileId),
  ]);
  clearBookExtractionCache(fileId);
  return true;
}

// 마지막 청크에서 자동 탐지한 공식 정답·해설 쪽만 각 본문 조각 끝에 참고용으로 붙인다.
async function appendAnswerReferences(
  absPath: string,
  slices: { path: string; from: number; to: number }[],
  answerPages: number[],
  signal?: AbortSignal,
  isCancelled?: () => boolean
): Promise<void> {
  if (answerPages.length === 0) return;
  const cancelled = () => signal?.aborted || isCancelled?.();
  if (cancelled()) throw new Error("사용자 중단");
  const source = await PDFDocument.load(readFileSync(absPath), { ignoreEncryption: true, updateMetadata: false });
  for (const slice of slices) {
    if (cancelled()) throw new Error("사용자 중단");
    const suffixFrom = slice.to - answerPages.length + 1;
    const alreadyFinal = answerPages.every((page, index) => page === suffixFrom + index);
    if (alreadyFinal) continue;
    const output = await PDFDocument.load(readFileSync(slice.path), { ignoreEncryption: true, updateMetadata: false });
    const copied = await output.copyPages(source, answerPages.map((page) => page - 1));
    for (const page of copied) output.addPage(page);
    const bytes = await output.save();
    if (bytes.byteLength > AI_MAX_FILE_BYTES) {
      throw new AIProviderError("file_too_large", "정답표를 포함한 PDF 구간이 50MB를 초과했습니다");
    }
    if (cancelled()) throw new Error("사용자 중단");
    writeFileSync(slice.path, bytes);
  }
}

// ponytail: 뒤쪽 최대 3청크만 역탐색. 답지가 더 앞에 끝나는 드문 책은 별도 답지 업로드 흐름에서 처리.
async function detectAnswerReferences(
  slices: { path: string; from: number; to: number }[],
  signal?: AbortSignal
): Promise<number[]> {
  const found = new Set<number>();
  for (let index = slices.length - 1, scanned = 0; index >= 0 && scanned < MAX_ANSWER_SCAN_CHUNKS; index--, scanned++) {
    if (signal?.aborted) throw new Error("사용자 중단");
    const slice = slices[index];
    const pages = await detectAnswerKeyPagesFromFile(slice.path, slice.from, signal);
    for (const page of pages) found.add(page);
    if (pages.length > 0 && Math.min(...pages) > slice.from) break;
    if (pages.length === 0 && found.size > 0) break;
  }
  const pages = [...found].sort((a, b) => a - b);
  if (pages.length > MAX_ANSWER_REFERENCE_PAGES) {
    throw new AIProviderError("invalid_response", "빠른 정답표 참고 페이지가 너무 많습니다");
  }
  return pages;
}

async function loadStoredAnswerReferences(env: Env, fileId: number): Promise<number[] | null> {
  const memory = answerReferenceCache.get(fileId);
  if (memory !== undefined) return memory;
  const row = await env.DB.prepare(
    "SELECT answer_key_pages, answer_key_scan_complete FROM book_files WHERE id = ?"
  ).bind(fileId).first<{ answer_key_pages: string | null; answer_key_scan_complete: number }>();
  if (!row || row.answer_key_scan_complete !== 1 || row.answer_key_pages === null) return null;
  try {
    const parsed: unknown = JSON.parse(row.answer_key_pages);
    if (
      !Array.isArray(parsed)
      || parsed.some((page) => typeof page !== "number" || !Number.isInteger(page) || page < 1)
    ) throw new Error("invalid answer-key pages");
    const pages = [...new Set(parsed as number[])].sort((a, b) => a - b);
    answerReferenceCache.set(fileId, pages);
    return pages;
  } catch {
    await env.DB.prepare(
      "UPDATE book_files SET answer_key_pages = NULL, answer_key_scan_complete = 0 WHERE id = ?"
    ).bind(fileId).run();
    return null;
  }
}

async function saveStoredAnswerReferences(env: Env, fileId: number, pages: number[]): Promise<void> {
  await env.DB.prepare(
    "UPDATE book_files SET answer_key_pages = ?, answer_key_scan_complete = 1 WHERE id = ?"
  ).bind(JSON.stringify(pages), fileId).run();
  answerReferenceCache.set(fileId, pages);
}

async function resetStoredAnswerReferences(env: Env, fileId: number): Promise<void> {
  clearBookExtractionCache(fileId);
  await env.DB.prepare(
    "UPDATE book_files SET answer_key_pages = NULL, answer_key_scan_complete = 0 WHERE id = ?"
  ).bind(fileId).run();
}

function isProblemChunkValidationError(error: unknown): boolean {
  return error instanceof ProblemChunkValidationError
    || (error instanceof AIProviderError && error.code === "invalid_response");
}

// 20쪽 전체를 먼저 읽되, 모델이 보기 누락 같은 구조 오류를 낸 구간만 10쪽 단위로 다시 읽는다.
// 잘못된 항목만 버리지 않고 해당 본문 범위 전체를 재추출하므로 원자 저장·완전성 검증을 유지한다.
async function extractProblemChunk(
  absPath: string,
  slice: { path: string; from: number; to: number },
  answerKeyPages: number[],
  signal?: AbortSignal,
  isCancelled?: () => boolean,
  shouldStop?: () => boolean
): Promise<QuizItemEx[]> {
  const contentPageCount = slice.to - slice.from + 1;
  try {
    return await extractProblemsFromFile(slice.path, "pdf", {
      sliceBase: slice.from,
      signal,
      contentPageCount,
      answerKeyPages,
    });
  } catch (error) {
    if (!isProblemChunkValidationError(error) || contentPageCount <= FALLBACK_CHUNK) throw error;
    console.warn(`[문제추출] p.${slice.from}~${slice.to} 구조 검증 실패 — 겹침 10쪽 폴백`);

    const source = await PDFDocument.load(readFileSync(absPath), { ignoreEncryption: true, updateMetadata: false });
    const boundary = Math.min(slice.from + FALLBACK_CHUNK - 1, slice.to);
    const ranges = [
      { from: slice.from, to: boundary },
      { from: boundary, to: slice.to },
    ];
    const fallbackSlices: { path: string; from: number; to: number }[] = [];
    try {
      for (const range of ranges) {
        const output = await PDFDocument.create();
        const indexes = Array.from({ length: range.to - range.from + 1 }, (_, index) => range.from - 1 + index);
        const copied = await output.copyPages(source, indexes);
        for (const page of copied) output.addPage(page);
        const path = join(dirname(slice.path), `${range.from}-${range.to}-fallback.pdf`);
        writeFileSync(path, await output.save());
        fallbackSlices.push({ path, ...range });
      }
      await appendAnswerReferences(absPath, fallbackSlices, answerKeyPages, signal, isCancelled);

      const items: QuizItemEx[] = [];
      for (let fallbackIndex = 0; fallbackIndex < fallbackSlices.length; fallbackIndex++) {
        const fallback = fallbackSlices[fallbackIndex];
        if (signal?.aborted || isCancelled?.()) throw new Error("사용자 중단");
        if (shouldStop?.()) throw new Error("다른 페이지 구간 실패로 폴백 중단");
        const fallbackPageCount = fallback.to - fallback.from + 1;
        let result: QuizItemEx[] | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (signal?.aborted || isCancelled?.()) throw new Error("사용자 중단");
          if (shouldStop?.()) throw new Error("다른 페이지 구간 실패로 폴백 중단");
          try {
            result = await extractProblemsFromFile(fallback.path, "pdf", {
              sliceBase: fallback.from,
              signal,
              contentPageCount: fallbackPageCount,
              answerKeyPages,
            });
            break;
          } catch (fallbackError) {
            if (attempt > 0 || !isProblemChunkValidationError(fallbackError)) throw fallbackError;
            console.warn(`[문제추출] p.${fallback.from}~${fallback.to} 폴백 구조 재검증`);
          }
        }
        if (!result) throw new ProblemChunkValidationError("폴백 문제 구조 검증 실패");
        if (signal?.aborted || isCancelled?.()) throw new Error("사용자 중단");
        // 겹침 경계에서 시작하는 문제는 뒤쪽 절반이 소유한다. 두 응답의 문구가 달라도 중복되지 않는다.
        if (fallbackIndex === 0) result = result.filter((item) => item.page !== boundary);
        items.push(...result);
      }
      return items;
    } finally {
      for (const fallback of fallbackSlices) rmSync(fallback.path, { force: true });
    }
  }
}

export { detectImageMime } from "./upload";

async function recordBookFailure(env: Env, bookId: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE materials
     SET book_retry_count = book_retry_count + CASE WHEN figure_backfill_pending = 1 THEN 0 ELSE 1 END,
         book_processing = 0,
         pending_to_book = CASE
           WHEN figure_backfill_pending = 1 THEN 1
           WHEN book_retry_count + 1 < ? THEN 1 ELSE 0
         END
     WHERE book_id = ?`
  ).bind(MAX_AUTO_BOOK_RETRIES, bookId).run();
}

async function recordMaterialBookFailure(env: Env, materialId: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE materials
     SET book_retry_count = book_retry_count + CASE WHEN figure_backfill_pending = 1 THEN 0 ELSE 1 END,
         book_processing = 0,
         pending_to_book = CASE
           WHEN figure_backfill_pending = 1 THEN 1
           WHEN book_retry_count + 1 < ? THEN 1 ELSE 0
         END
     WHERE id = ?`
  ).bind(MAX_AUTO_BOOK_RETRIES, materialId).run();
}

async function syncBookChunkState(
  env: Env,
  fileId: number,
  chunks: number,
  completed: number
): Promise<void> {
  await env.DB.prepare(
    `UPDATE book_files
     SET chunk_total = ?, retry_chunk_count = ?
     WHERE id = ?`
  ).bind(chunks, Math.max(0, chunks - completed), fileId).run();
}

async function loadBookChunkCache(
  env: Env,
  fileId: number,
  chunks: number
): Promise<Map<number, QuizItemEx[]>> {
  const file = await env.DB.prepare("SELECT chunk_total FROM book_files WHERE id = ?")
    .bind(fileId).first<{ chunk_total: number }>();
  if (!file) return new Map();

  if (file.chunk_total !== 0 && file.chunk_total !== chunks) {
    await env.DB.prepare("DELETE FROM book_extraction_chunks WHERE file_id = ?").bind(fileId).run();
  }

  const { results } = await env.DB.prepare(
    "SELECT chunk_index, payload FROM book_extraction_chunks WHERE file_id = ? AND chunk_index < ? ORDER BY chunk_index"
  ).bind(fileId, chunks).all<{ chunk_index: number; payload: string }>();
  const cache = new Map<number, QuizItemEx[]>();
  for (const row of results) {
    try {
      const payload: unknown = JSON.parse(row.payload);
      if (Array.isArray(payload)) cache.set(row.chunk_index, payload as QuizItemEx[]);
    } catch {
      await env.DB.prepare(
        "DELETE FROM book_extraction_chunks WHERE file_id = ? AND chunk_index = ?"
      ).bind(fileId, row.chunk_index).run();
    }
  }
  await syncBookChunkState(env, fileId, chunks, cache.size);
  return cache;
}

async function saveBookChunk(
  env: Env,
  fileId: number,
  chunkIndex: number,
  items: QuizItemEx[],
  chunks: number
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO book_extraction_chunks (file_id, chunk_index, payload)
       VALUES (?, ?, ?)
       ON CONFLICT(file_id, chunk_index) DO UPDATE SET payload = excluded.payload, created_at = datetime('now')`
    ).bind(fileId, chunkIndex, JSON.stringify(items)),
    env.DB.prepare(
      `UPDATE book_files
       SET chunk_total = ?,
           retry_chunk_count = MAX(0, ? - (
             SELECT COUNT(*) FROM book_extraction_chunks WHERE file_id = ?
           ))
       WHERE id = ?`
    ).bind(chunks, chunks, fileId, fileId),
  ]);
}

async function resetBookChunkCache(env: Env, fileId: number, chunks: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM book_extraction_chunks WHERE file_id = ?").bind(fileId),
    env.DB.prepare(
      "UPDATE book_files SET retry_chunk_count = ?, chunk_total = ? WHERE id = ?"
    ).bind(chunks, chunks, fileId),
  ]);
}

/**
 * 파일의 모든 문제를 뽑는다 (분류 없이 '모든 문제만' — v2 방식 복원).
 * 한 번에 출력시키면 출력 한도에서 잘려 대부분 누락되므로 PDF는 20쪽 임시 파일로 물리 분할
 * (1쪽 겹침)해 동시 4개씩 병렬 추출한다. 겹침 중복은 (페이지, 지문)으로 제거.
 */
async function extractAllQuestions(
  env: Env,
  fileId: number,
  absPath: string,
  isPdf: boolean,
  onProgress?: (percent: number) => void,
  isCancelled?: () => boolean,
  signal?: AbortSignal
): Promise<{
  items: QuizItemEx[];
  failed: number;
  chunks: number;
  limitHit: boolean;
  autoRetryBlocked: boolean;
  terminalError?: unknown;
}> {
  const byKey = new Map<string, QuizItemEx>();
  const collect = (items: QuizItemEx[]) => {
    for (const it of items) {
      const k = stableQuestionKey(it.page, it.question);
      const prev = byKey.get(k);
      // 겹침 중복은 더 완전한 쪽(지문+해설 길이) 유지
      if (!prev || it.question.length + it.explanation.length > prev.question.length + prev.explanation.length) byKey.set(k, it);
    }
  };

  let failed = 0;
  let chunks = 1;
  let limitHit = false; // 청크 실패가 '사용량 한도' 때문이면 표시 — 부분 성공을 완료로 오인 저장하지 않게
  let autoRetryBlocked = false;
  let terminalError: unknown;
  let stopLaunching = false; // 한 청크라도 실패하면 이번 원자 교체는 불가능하므로 새 AI 호출을 막는다
  const noteLimit = (e: unknown) => { if (isUsageLimitText(String(e))) limitHit = true; };
  const sliced = isPdf ? await slicePdf(absPath, CHUNK, CHUNK - 1) : null;

  if (sliced) {
    try {
      chunks = sliced.slices.length;
      const chunkCache = await loadBookChunkCache(env, fileId, chunks);
      let answerKeyPages = await loadStoredAnswerReferences(env, fileId);
      if (answerKeyPages === null) {
        answerKeyPages = await detectAnswerReferences(sliced.slices, signal);
        await saveStoredAnswerReferences(env, fileId, answerKeyPages);
      }
      await appendAnswerReferences(absPath, sliced.slices, answerKeyPages, signal, isCancelled);
      onProgress?.(Math.round((chunkCache.size / chunks) * 100));
      const chunkResults = await mapPool(sliced.slices, CONCURRENCY, async (s, index) => {
        if (isCancelled?.()) throw new Error("사용자 중단"); // 새 청크 발사 중단 — mapPool 전체가 reject
        if (stopLaunching) return null;
        if (chunkCache.has(index)) {
          return chunkCache.get(index)!;
        }
        try {
          let items = await extractProblemChunk(absPath, s, answerKeyPages, signal, isCancelled, () => stopLaunching);
          // 1쪽 겹침 경계는 뒤 청크가 소유한다. 같은 문항이 양쪽에서 조금 다르게
          // 전사돼도 문자열 유사도에 기대지 않고 중복을 원천 차단한다.
          const nextSlice = sliced.slices[index + 1];
          if (nextSlice?.from === s.to) items = items.filter((item) => item.page !== s.to);
          await saveBookChunk(env, fileId, index, items, chunks);
          chunkCache.set(index, items);
          onProgress?.(Math.round((chunkCache.size / chunks) * 100));
          return items;
        } catch (e) {
          stopLaunching = true;
          terminalError = e;
          console.error(`[문제추출] 청크 실패 (p.${s.from}~): ${e instanceof AIProviderError ? e.code : "unknown"}`);
          noteLimit(e);
          if (blocksAutomaticRetry(e)) autoRetryBlocked = true;
          return null;
        }
      });
      for (const cr of chunkResults) {
        if (cr !== null) collect(cr);
      }
      failed = chunks - chunkCache.size;
      await syncBookChunkState(env, fileId, chunks, chunkCache.size);
    } finally {
      sliced.cleanup();
    }
  } else {
    chunks = 1;
    await syncBookChunkState(env, fileId, chunks, 0);
    try {
      collect(await extractProblemsFromFile(absPath, isPdf ? "pdf" : "image", { signal }));
      await syncBookChunkState(env, fileId, chunks, 1);
      onProgress?.(100);
    } catch (error) {
      failed = 1;
      terminalError = error;
      noteLimit(error);
      if (blocksAutomaticRetry(error)) autoRetryBlocked = true;
    }
  }

  const items = [...byKey.values()];
  if (failed === 0) {
    try {
      validatePrintedQuestionSequence(items);
    } catch (error) {
      await resetBookChunkCache(env, fileId, chunks);
      throw new ProblemChunkValidationError(
        error instanceof Error ? error.message : "인쇄 문제 번호 검증 실패"
      );
    }
  }
  return { items, failed, chunks, limitHit, autoRetryBlocked, terminalError };
}

const SOLUTION_OWNERSHIP_PAGES = 4;
const SOLUTION_LOOKAHEAD_PAGES = 2;

async function extractSolutionSlice(
  path: string,
  from: number,
  to: number,
  signal?: AbortSignal
): Promise<SolutionItem[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await extractSolutionsFromFile(path, "pdf", {
        sliceBase: from,
        contentPageCount: to - from + 1,
        signal,
      });
    } catch (error) {
      if (attempt < 1 && !signal?.aborted && !blocksAutomaticRetry(error)) continue;
      if (error instanceof ProblemChunkValidationError) {
        throw new ProblemChunkValidationError(`해설 페이지 ${from}-${to}: ${error.message}`);
      }
      throw error;
    }
  }
}

async function detectDetailedSolutionPages(absPath: string, signal?: AbortSignal): Promise<number[]> {
  const scanned = await slicePdf(absPath, CHUNK, CHUNK);
  if (!scanned) return detectDetailedSolutionPagesFromFile(absPath, 1, signal);
  try {
    const parts = await mapPool(scanned.slices, CONCURRENCY, async (slice) => {
      if (signal?.aborted) throw new Error("사용자 중단");
      return detectDetailedSolutionPagesFromFile(slice.path, slice.from, signal);
    });
    return [...new Set(parts.flat())].sort((a, b) => a - b);
  } finally {
    scanned.cleanup();
  }
}

async function extractAllSolutions(
  absPath: string,
  isPdf: boolean,
  signal?: AbortSignal
): Promise<SolutionItem[]> {
  const detailedPages = isPdf ? await detectDetailedSolutionPages(absPath, signal) : [];
  if (isPdf && detailedPages.length === 0) {
    throw new ProblemChunkValidationError("상세 해설 페이지를 찾지 못했습니다");
  }
  const sliced = isPdf
    ? await slicePdf(
      absPath,
      SOLUTION_OWNERSHIP_PAGES + SOLUTION_LOOKAHEAD_PAGES,
      SOLUTION_OWNERSHIP_PAGES
    )
    : null;
  if (!sliced) return extractSolutionsFromFile(absPath, isPdf ? "pdf" : "image", { signal });
  try {
    const selected = sliced.slices
      .map((slice, index) => ({ slice, index }))
      .filter(({ slice }) => detailedPages.some((page) => page >= slice.from && page <= slice.to));
    const parts = await mapPool(selected, CONCURRENCY, async ({ slice, index }) => {
      const items = await extractSolutionSlice(slice.path, slice.from, slice.to, signal);
      const nextFrom = sliced.slices[index + 1]?.from;
      // 각 청크는 앞 4쪽만 소유하고 뒤 2쪽은 경계 해설 완성을 위한 lookahead로만 읽는다.
      return nextFrom === undefined ? items : items.filter((item) => item.page < nextFrom);
    });
    return parts.flat();
  } finally {
    sliced.cleanup();
  }
}

// 파일명에서 문제집 제목 도출 — "해설/정답/답지" 표기를 제거해 문제집과 해설지가 같은 책으로 합쳐지게 한다
// ("정답과해설" 같은 결합 표기를 먼저 매칭해야 "…미적분1 과" 식의 조사 잔여물이 남지 않는다)
export function bookTitleFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "");
  const stripped = base
    .replace(/정답\s*(?:과|및)?\s*해설지?|해설지|해설|정답지|정답|답지|내지|본문/g, " ")
    .replace(/[\s_\-]+/g, " ")
    .trim();
  return stripped || base;
}

/**
 * 파일 하나를 문제집에 편입하고 백그라운드 추출을 시작한다.
 * 해설 탭 업로드와 자료 사이드바 자동 라우팅(materials.ts)이 함께 사용한다.
 */
export async function ingestBookFile(
  env: Env,
  subjectId: number,
  title: string,
  file: ValidatedUpload
): Promise<{ bookId: number; fileId: number }> {
  // 같은 제목이면 기존 문제집에 합류 (문제집 본문 먼저, 해설지 나중 업로드 지원)
  let book = await env.DB.prepare(
    `INSERT INTO books (subject_id, title)
     SELECT ?, ? WHERE NOT EXISTS (
       SELECT 1 FROM books WHERE subject_id = ? AND title = ?
     )
     RETURNING id`
  ).bind(subjectId, title, subjectId, title).first<{ id: number }>();
  if (!book) {
    book = await env.DB.prepare("SELECT id FROM books WHERE subject_id = ? AND title = ?")
      .bind(subjectId, title)
      .first<{ id: number }>();
  }
  if (!book) throw new Error("문제집을 만들 수 없습니다");
  const bookId = book.id;

  const r2Key = `books/${subjectId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${file.name}`;
  await env.FILES.put(r2Key, file.bytes);
  let row: { id: number } | null;
  try {
    row = await env.DB.prepare(
      `INSERT INTO book_files (book_id, name, r2_key, mime, status, content_hash, page_count)
       VALUES (?, ?, ?, ?, 'processing', ?, ?) RETURNING id`
    ).bind(bookId, file.name, r2Key, file.mime, file.contentHash, file.pageCount).first<{ id: number }>();
  } catch (error) {
    await env.FILES.delete(r2Key);
    throw error;
  }
  const fileId = row!.id;

  // 백그라운드 추출 — 응답과 분리, 탭 이동·브라우저 종료와 무관하게 진행
  processFile(env, fileId, bookId, subjectId, r2Key, file.mime === "application/pdf");
  return { bookId, fileId };
}

// 원 표기(①~⑩) 정답을 퀴즈 채점용 숫자로 변환
function normalizeAnswer(a: string): string {
  const i = "①②③④⑤⑥⑦⑧⑨⑩".indexOf(a.trim());
  return i >= 0 ? String(i + 1) : a;
}

// 백그라운드 잡: 파일에서 모든 문제 추출 → questions 직접 등록 → 상태 갱신.
// 요청과 분리돼 실행되므로 탭을 떠나거나 브라우저를 닫아도 계속 진행된다.
async function processFile(
  env: Env,
  fileId: number,
  bookId: number,
  subjectId: number,
  r2Key: string,
  isPdf: boolean,
  claimedJob?: JobToken
): Promise<void> {
  const cancelKey = `book:${fileId}`;
  if (activeBookJobs.has(fileId)) {
    if (claimedJob) finishJob(claimedJob);
    return;
  }
  activeBookJobs.add(fileId);
  const job = claimedJob ?? startJob(cancelKey);
  let automaticLinkedRetryAllowed = true;
  try {
    // 진행률(%)은 청크(≈페이지) 완료 기준 — 폴링 UI가 book_files.progress를 읽는다
    const onProgress = (p: number) => {
      if (!isCurrentJob(job)) return;
      env.DB.prepare(
        "UPDATE book_files SET progress = CASE WHEN progress < ? THEN ? ELSE progress END WHERE id = ?"
      ).bind(p, p, fileId).run().catch(() => {});
    };
    let extraction = await extractAllQuestions(
      env,
      fileId,
      env.FILES.absolutePath(r2Key),
      isPdf,
      onProgress,
      () => !isCurrentJob(job),
      job.signal
    );
    // 일반 응답 오류는 성공 청크를 DB에 남겨두고 누락 구간만 즉시 1회 재시도한다.
    // 취소·사용량 한도는 추가 호출을 막아야 하므로 즉시 실패 처리한다.
    if (
      extraction.failed > 0
      && !extraction.limitHit
      && !extraction.autoRetryBlocked
      && isCurrentJob(job)
    ) {
      await env.DB.prepare(
        `UPDATE book_files SET error = ? WHERE id = ? AND status = 'processing'`
      ).bind(
        `페이지 구간 ${extraction.failed}/${extraction.chunks}개 오류·미완료 — 해당 구간만 자동 재시도 중`,
        fileId
      ).run();
      extraction = await extractAllQuestions(
        env,
        fileId,
        env.FILES.absolutePath(r2Key),
        isPdf,
        onProgress,
        () => !isCurrentJob(job),
        job.signal
      );
    }
    const { items, failed, chunks, limitHit, autoRetryBlocked, terminalError } = extraction;
    automaticLinkedRetryAllowed = !limitHit && !autoRetryBlocked;
    // 사용량 한도로 청크가 끊겼으면 부분 결과를 '완료'로 저장하지 않는다 — 한도 리셋 후
    // 재시도 루프가 처음부터 다시 뽑도록 실패로 처리한다(대부분 문제가 빠진 채 완료로 남던 사고).
    if (limitHit) {
      if (terminalError instanceof AIProviderError) throw terminalError;
      throw new Error(`사용량 한도로 문제 추출이 중단됨 (청크 ${failed}/${chunks}) — 한도 리셋 후 자동 재시도됩니다`);
    }
    // 일부 청크만 성공한 결과로 기존 문제를 교체하면 누락이 영구 확정된다.
    // 모든 청크가 성공한 경우에만 아래 원자 교체를 수행한다.
    if (failed > 0) {
      if (autoRetryBlocked && terminalError) throw terminalError;
      throw new Error(`일부 구간 추출 실패 (청크 ${failed}/${chunks}) — 기존 문제를 보존합니다`);
    }
    if (items.length === 0) {
      await resetBookChunkCache(env, fileId, chunks);
      clearBookExtractionCache(fileId);
      throw new Error(failed > 0 ? `추출 실패 (청크 ${failed}/${chunks} 실패)` : "문제를 찾지 못했습니다");
    }
    // 중단됐으면 저장하지 않는다 — 완료가 취소 상태(error)를 ready로 덮어쓰는 것 방지
    if (!isCurrentJob(job)) return;
    // 추출 도중 파일·자료가 삭제됐으면 저장하지 않는다 (고아 항목 insert 사고 방지)
    const alive = await env.DB.prepare("SELECT id FROM book_files WHERE id = ?").bind(fileId).first();
    if (!alive) return;
    // alive 조회를 기다리는 동안 취소가 들어올 수 있으므로 교체 직전에 다시 확인한다.
    if (!isCurrentJob(job)) return;

    // 재추출 전 기존 문제는 계속 제공한다. 새 결과가 완성된 지금 안정키(페이지+정규화 지문)로
    // 같은 행을 갱신해야 question_attempts FK와 학습 이력이 유지된다.
    const { results: existing } = await env.DB.prepare(
      `SELECT id, qtype, choices, answer, question, src_page, book_number, printed_number,
              correct_count, wrong_count, explanation,
              (SELECT COUNT(*) FROM question_attempts qa WHERE qa.question_id = questions.id) AS attempt_count
       FROM questions WHERE src_file_id = ?`
    ).bind(fileId).all<{
      id: number;
      qtype: string;
      choices: string | null;
      answer: string;
      question: string;
      src_page: number | null;
      book_number: string | null;
      printed_number: string | null;
      correct_count: number;
      wrong_count: number;
      explanation: string;
      attempt_count: number;
    }>();
    if (!isCurrentJob(job)) return;

    const existingByKey = new Map<string, (typeof existing)[number]>();
    const existingByLocator = new Map<string, (typeof existing)[number] | null>();
    for (const q of existing) {
      const key = stableQuestionKey(q.src_page, q.question);
      if (existingByKey.has(key)) throw new Error("기존 문제에 중복 안정키가 있어 재추출을 안전하게 적용할 수 없습니다");
      existingByKey.set(key, q);
      const locatorKey = printedLocatorKey(
        q.src_page,
        numericPrintedLocator(q.printed_number) ?? printedLocatorFromQuestionPrefix(q.question)
      );
      if (locatorKey) existingByLocator.set(locatorKey, existingByLocator.has(locatorKey) ? null : q);
    }

    const matchedIds = new Set<number>();
    const freshLocatorCounts = new Map<string, number>();
    for (const item of items) {
      const key = printedLocatorKey(item.page, numericPrintedLocator(item.number));
      if (key) freshLocatorCounts.set(key, (freshLocatorCounts.get(key) ?? 0) + 1);
    }
    const statements = items.map((it, i) => {
      let previous = existingByKey.get(stableQuestionKey(it.page, it.question));
      const locatorKey = printedLocatorKey(it.page, numericPrintedLocator(it.number));
      if (!previous && locatorKey && freshLocatorCounts.get(locatorKey) === 1) {
        const candidate = existingByLocator.get(locatorKey);
        if (candidate && !matchedIds.has(candidate.id)) previous = candidate;
      }
      const answer = normalizeAnswer(it.answer);
      const answerCompatible = previous?.qtype === it.qtype
        && gradeAnswer(it.qtype, previous.answer, answer, previous.choices);
      if (
        previous && (previous.correct_count > 0 || previous.wrong_count > 0 || previous.attempt_count > 0)
        && !answerCompatible
      ) {
        throw new ProtectedQuestionConflictError(
          `학습 이력이 있는 ${previous.book_number ?? previous.id}번 문항의 정답이 달라 재추출을 중단했습니다`
        );
      }
      const preservedExplanation = previous?.explanation && answerCompatible
        ? previous.explanation
        : "";
      const choices = it.choices ? JSON.stringify(it.choices) : null;
      const printedNumber = numericPrintedLocator(it.number)?.toString() ?? null;
      const bookNumber = printedNumber ?? previous?.book_number ?? String(i + 1);
      if (previous) {
        matchedIds.add(previous.id);
        return env.DB.prepare(
          `UPDATE questions
           SET qtype = ?, difficulty = ?, question = ?, choices = ?, answer = ?, explanation = ?,
               book_number = ?, printed_number = ?, src_page = ?, has_figure = ?, figure_description = ?, figure_box = ?
           WHERE id = ?
             AND (? = 1 OR (
               correct_count = 0 AND wrong_count = 0
               AND NOT EXISTS (SELECT 1 FROM question_attempts qa WHERE qa.question_id = questions.id)
             ))
             AND EXISTS (SELECT 1 FROM book_files WHERE id = ? AND status = 'processing')`
        ).bind(
          it.qtype, it.difficulty, it.question, choices, answer, preservedExplanation || it.explanation,
          bookNumber, printedNumber, it.page, it.figure ? 1 : 0, it.figure_description, it.box ? it.box.join(",") : null,
          previous.id, answerCompatible ? 1 : 0, fileId
        );
      }
      return env.DB.prepare(
        `INSERT INTO questions
           (subject_id, source, qtype, difficulty, question, choices, answer, explanation,
            book_id, book_number, printed_number, src_file_id, src_page, has_figure, figure_description, figure_box)
         SELECT ?, 'uploaded', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM book_files WHERE id = ? AND status = 'processing')`
      ).bind(
        subjectId, it.qtype, it.difficulty, it.question, choices, answer, it.explanation,
        bookId, bookNumber, printedNumber, fileId, it.page,
        it.figure ? 1 : 0, it.figure_description, it.box ? it.box.join(",") : null, fileId
      );
    });

    const unmatched = existing.filter((question) => !matchedIds.has(question.id));
    const protectedUnmatched = unmatched.find(
      (question) => question.correct_count > 0 || question.wrong_count > 0 || question.attempt_count > 0
    );
    if (protectedUnmatched) {
      throw new ProtectedQuestionConflictError(
        `학습 이력이 있는 ${protectedUnmatched.book_number ?? protectedUnmatched.id}번 문항을 새 추출에서 찾지 못했습니다`
      );
    }
    if (unmatched.length > 0) {
      const placeholders = unmatched.map(() => "?").join(",");
      statements.push(
        env.DB.prepare(
          `DELETE FROM questions WHERE id IN (${placeholders})
           AND correct_count = 0 AND wrong_count = 0
           AND NOT EXISTS (SELECT 1 FROM question_attempts qa WHERE qa.question_id = questions.id)
           AND EXISTS (SELECT 1 FROM book_files WHERE id = ? AND status = 'processing')`
        ).bind(...unmatched.map((q) => q.id), fileId)
      );
    }
    // book_files를 ready로 바꾸기 전에 연결 자료의 재시도 상태를 먼저 정리한다.
    statements.push(
      env.DB.prepare(
        `UPDATE materials
         SET pending_to_book = 0, book_retry_count = 0, book_processing = 0,
             figure_backfill_pending = 0,
             integrity_warning = CASE
               WHEN integrity_warning = ? THEN NULL
               WHEN instr(COALESCE(integrity_warning, ''), ? || ' · ') = 1
                 THEN substr(integrity_warning, length(?) + 4)
               ELSE integrity_warning
             END
         WHERE book_id = ?
           AND EXISTS (SELECT 1 FROM book_files WHERE id = ? AND status = 'processing')`
      ).bind(BACKFILL_CONFLICT_WARNING, BACKFILL_CONFLICT_WARNING, BACKFILL_CONFLICT_WARNING, bookId, fileId),
      env.DB.prepare(
        `UPDATE book_files
         SET status = 'ready', error = NULL, progress = 100, retry_chunk_count = 0, chunk_total = ?
         WHERE id = ? AND status = 'processing'`
      ).bind(chunks, fileId),
      env.DB.prepare(
        `DELETE FROM book_extraction_chunks
         WHERE file_id = ?
           AND EXISTS (SELECT 1 FROM book_files WHERE id = ? AND status = 'ready')`
      ).bind(fileId, fileId)
    );
    if (!isCurrentJob(job)) return;
    await env.DB.batch(statements);
    clearBookExtractionCache(fileId);
  } catch (e) {
    const cancelled = !isCurrentJob(job);
    if (!cancelled && e instanceof ProtectedQuestionConflictError) {
      console.warn(`[문제추출] file ${fileId}: ${e.message}`);
      if (!claimedJob && await parkFigureBackfillConflict(env, fileId, bookId).catch(() => false)) return;
    }
    const msg = cancelled ? "사용자 중단" : publicBookError(e);
    // 취소 뒤 새 세대가 시작됐다면 구 세대는 새 상태를 덮어쓰지 않는다.
    if (cancelled) {
      await env.DB.prepare(
        "UPDATE book_files SET status = 'error', error = ? WHERE id = ? AND status = 'processing'"
      ).bind(msg, fileId).run();
    } else {
      await env.DB.prepare("UPDATE book_files SET status = 'error', error = ? WHERE id = ?")
        .bind(msg, fileId).run();
    }
    if (!cancelled && claimedJob && e instanceof ProtectedQuestionConflictError) {
      await env.DB.prepare("UPDATE materials SET pending_to_book = 0 WHERE book_id = ?")
        .bind(bookId).run().catch(() => {});
    // 자료에서 온 자동 추출 실패는 최대 3회까지만 보류 재시도한다.
    } else if (!cancelled && automaticLinkedRetryAllowed && !blocksAutomaticRetry(e) && !isUsageLimitText(String(e))) {
      await recordBookFailure(env, bookId).catch(() => {});
    }
  } finally {
    await env.DB.prepare("UPDATE materials SET book_processing = 0 WHERE book_id = ?")
      .bind(bookId).run().catch(() => {});
    activeBookJobs.delete(fileId);
    finishJob(job);
  }
}

// "페이지 N" 표제 경계를 살려 추출 텍스트를 배치로 나눈다 (배치당 최대 max자)
// 표제가 드문 추출본은 파트 하나가 max를 훌쩍 넘을 수 있다 — 그대로 보내면 분류 JSON
// 출력이 잘려 파싱 실패로 구간(주로 문제 파트)이 통째로 소실되므로 문단 경계로 강제 분할.
export function chunkTextByPages(text: string, max = 25_000): string[] {
  const parts = text.split(/(?=^#{1,4}\s*페이지\s*\d+)/m).flatMap((p) => {
    if (p.length <= max) return [p];
    // 파트 첫 표제를 이어지는 조각에도 붙여 page 귀속을 유지한다
    const heading = /^#{1,4}\s*페이지\s*\d+.*/.exec(p)?.[0] ?? "";
    const pieces: string[] = [];
    let cur = "";
    for (let para of p.split(/(?<=\n\n)/)) {
      while (para.length > max) {
        if (cur) { pieces.push(cur); cur = ""; }
        pieces.push(para.slice(0, max));
        para = para.slice(max);
      }
      if (cur && cur.length + para.length > max) { pieces.push(cur); cur = para; }
      else cur += para;
    }
    if (cur.trim()) pieces.push(cur);
    return pieces.map((piece, i) => (i > 0 && heading ? `${heading} (이어짐)\n${piece}` : piece));
  });
  const out: string[] = [];
  let cur = "";
  for (const p of parts) {
    if (cur && cur.length + p.length > max) { out.push(cur); cur = p; }
    else cur += p;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// ── 자료 → 문제 추출 (자동) ────────────────────────────────────────────────────
// 자료 원본 PDF를 비전으로 읽어 문제·해설을 뽑고, 번호로 짝지어 questions(문제 칸)에 등록한다.
// 자료 추출 완료 시 파트 지도에 문제·해설 페이지가 있으면 자동 실행된다(materials.ts). 사용자에게
// '문제집'은 노출되지 않는다 — book_*은 문제↔해설 짝맞춤·원본 그림 표시용 내부 스테이징일 뿐이다.
export async function startMaterialToBook(
  env: Env,
  matId: number
): Promise<{ bookId: number; fileId: number } | { error: string; code: 400 | 404 | 409 | 429 }> {
  const m = await env.DB.prepare("SELECT * FROM materials WHERE id = ?").bind(matId)
    .first<{
      id: number;
      subject_id: number;
      title: string;
      original_filename: string | null;
      kind: string;
      status: string;
      r2_key: string | null;
      extracted_text: string | null;
      section_map: string | null;
      book_id: number | null;
      book_processing: number;
      content_hash: string | null;
      page_count: number | null;
  }>();
  if (!m || m.status !== "ready" || !m.extracted_text) return { error: "추출이 완료된 자료가 아닙니다", code: 400 };
  if (!m.r2_key) return { error: "원본 파일이 있는 자료만 문제 추출할 수 있습니다", code: 400 };
  if (m.book_id && activeSolutionBooks.has(m.book_id)) {
    return { error: "해설 추가가 끝난 뒤 문제를 다시 추출해 주세요", code: 409 };
  }

  // 기존 문제를 건드리기 전에 원본부터 검증한다. 원본이 사라진 재시도 때문에 정상 문제와
  // 학습 통계를 먼저 삭제하던 데이터 손실을 막는다.
  const buf = await env.FILES.get(m.r2_key);
  if (!buf) return { error: "원본 파일이 없습니다", code: 404 };

  // 파일 확인과 DB 작업 사이에 중복 요청·자료 삭제가 끼어들 수 있으므로 자료 행 자체를 원자 claim한다.
  const claimed = await env.DB.prepare(
    `UPDATE materials SET book_processing = 1
     WHERE id = ? AND status = 'ready' AND book_processing = 0 RETURNING id`
  ).bind(matId).first<{ id: number }>();
  if (!claimed) {
    const stillExists = await env.DB.prepare("SELECT id FROM materials WHERE id = ?")
      .bind(matId).first<{ id: number }>();
    return stillExists
      ? { error: "문제 추출이 이미 진행 중입니다", code: 409 }
      : { error: "자료가 삭제되었습니다", code: 404 };
  }
  const releaseClaim = () => env.DB.prepare(
    "UPDATE materials SET book_processing = 0 WHERE id = ? AND book_processing = 1"
  ).bind(matId).run();
  if (m.book_id && activeSolutionBooks.has(m.book_id)) {
    await releaseClaim();
    return { error: "해설 추가가 끝난 뒤 문제를 다시 추출해 주세요", code: 409 };
  }

  const subjectId = m.subject_id;
  const title = bookTitleFromFilename(m.title);
  let bookId = 0;
  let createdBook = false;
  try {
    const subjectAlive = await env.DB.prepare("SELECT id FROM subjects WHERE id = ?")
      .bind(subjectId).first<{ id: number }>();
    if (!subjectAlive) {
      await releaseClaim();
      return { error: "과목 또는 자료가 삭제되었습니다", code: 404 };
    }

    // 자료당 book/file 1:1. 이전 추출 컨테이너가 있으면 삭제하지 않고 재사용해, 새 추출이
    // 실패하거나 취소돼도 기존 questions가 그대로 남게 한다.
    let reusable: {
      id: number;
      r2_key: string;
      status: string;
      content_hash: string | null;
      retry_chunk_count: number;
      chunk_total: number;
    } | null = null;
    if (m.book_id) {
      const linked = await env.DB.prepare("SELECT id FROM books WHERE id = ? AND subject_id = ?")
        .bind(m.book_id, subjectId).first<{ id: number }>();
      if (linked) {
        bookId = linked.id;
        const { results: files } = await env.DB.prepare(
          `SELECT id, r2_key, status, content_hash, retry_chunk_count, chunk_total
           FROM book_files WHERE book_id = ? ORDER BY id DESC`
        ).bind(bookId).all<{
          id: number;
          r2_key: string;
          status: string;
          content_hash: string | null;
          retry_chunk_count: number;
          chunk_total: number;
        }>();
        if (files.some((f) => f.status === "processing" || activeBookJobs.has(f.id))) {
          await releaseClaim();
          return { error: "문제 추출이 이미 진행 중입니다", code: 409 };
        }
        reusable = files[0] ?? null;
      }
    }

    if (!(await checkAndIncrementUsage(env.DB))) {
      await releaseClaim();
      return { error: "오늘 사용량 한도 도달", code: 429 };
    }

    if (!bookId) {
      // Book creation and material linking share one transaction so a process
      // crash cannot leave a claimed material with no retryable book_id.
      await env.DB.batch([
        env.DB.prepare(
        `INSERT INTO books (subject_id, title)
         SELECT ?, ? WHERE EXISTS (SELECT 1 FROM materials WHERE id = ? AND book_processing = 1)
        `
        ).bind(subjectId, title, matId),
        env.DB.prepare(
          `UPDATE materials SET book_id = last_insert_rowid()
           WHERE id = ? AND book_processing = 1
             AND EXISTS (
               SELECT 1 FROM books
               WHERE id = last_insert_rowid() AND subject_id = ?
             )`
        ).bind(matId, subjectId),
      ]);
      const linked = await env.DB.prepare(
        "SELECT book_id FROM materials WHERE id = ? AND book_processing = 1"
      ).bind(matId).first<{ book_id: number | null }>();
      if (!linked?.book_id) {
        await releaseClaim();
        return { error: "자료가 삭제되었습니다", code: 404 };
      }
      bookId = linked.book_id;
      createdBook = true;
    } else {
      await env.DB.prepare("UPDATE books SET title = ? WHERE id = ?").bind(title, bookId).run();
    }

    const mime = m.kind === "pdf" ? "application/pdf" : detectImageMime(buf) ?? "application/octet-stream";
    const sourceName = m.original_filename || m.title;
    const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const contentHash = m.content_hash ?? createHash("sha256").update(buf).digest("hex");
    const pageCount = m.page_count ?? (m.kind === "pdf" ? null : 1);
    let fileId: number;
    let r2Key: string;
    if (reusable) {
      fileId = reusable.id;
      r2Key = reusable.r2_key;
      const sameSource = reusable.content_hash === contentHash;
      if (!sameSource) {
        await resetBookChunkCache(env, fileId, 0);
        await resetStoredAnswerReferences(env, fileId);
      }
      const retryMessage = sameSource && reusable.retry_chunk_count > 0
        ? `페이지 구간 ${reusable.retry_chunk_count}/${reusable.chunk_total}개 오류·미완료 — 해당 구간만 다시 추출 중`
        : null;
      const resumeProgress = sameSource && reusable.chunk_total > 0
        ? Math.round(((reusable.chunk_total - reusable.retry_chunk_count) / reusable.chunk_total) * 100)
        : 0;
      await env.FILES.deletePrefix(`pages/${fileId}-`);
      await env.FILES.put(r2Key, arrayBuffer);
      await env.DB.prepare(
        `UPDATE book_files
         SET name = ?, mime = ?, status = 'processing', error = ?, progress = ?,
             content_hash = ?, page_count = ?
         WHERE id = ? AND EXISTS (SELECT 1 FROM materials WHERE id = ? AND book_processing = 1)`
      ).bind(sourceName, mime, retryMessage, resumeProgress, contentHash, pageCount, fileId, matId).run();
    } else {
      r2Key = `books/${subjectId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${sourceName}`;
      await env.FILES.put(r2Key, arrayBuffer);
      const row = await env.DB.prepare(
        `INSERT INTO book_files (book_id, name, r2_key, mime, status, content_hash, page_count)
         SELECT ?, ?, ?, ?, 'processing', ?, ?
         WHERE EXISTS (SELECT 1 FROM materials WHERE id = ? AND book_processing = 1)
         RETURNING id`
      ).bind(bookId, sourceName, r2Key, mime, contentHash, pageCount, matId).first<{ id: number }>();
      if (!row) {
        await env.FILES.delete(r2Key);
        await deleteBookCascade(env, bookId);
        return { error: "자료가 삭제되었습니다", code: 404 };
      }
      fileId = row.id;
    }

    // 삭제와 경합해 연결이 실패하면 방금 만든 내부 컨테이너를 즉시 회수한다.
    const linkedMaterial = await env.DB.prepare(
      `UPDATE materials
       SET pending_to_book = CASE WHEN figure_backfill_pending = 1 THEN 1 ELSE 0 END,
           book_id = ?
       WHERE id = ? AND book_processing = 1 RETURNING id`
    ).bind(bookId, matId).first<{ id: number }>();
    if (!linkedMaterial) {
      // 재사용 파일을 쓰는 동안 자료 삭제가 book cascade를 끝냈다면,
      // DB 행 없이 방금 다시 생긴 파일을 명시적으로 회수해야 한다.
      await env.FILES.delete(r2Key);
      await deleteBookCascade(env, bookId);
      return { error: "자료가 삭제되었습니다", code: 404 };
    }

    // 원본 PDF를 그대로 비전 추출 — processFile이 성공/실패 시 book_processing claim을 해제한다.
    processFile(env, fileId, bookId, subjectId, r2Key, m.kind === "pdf");
    return { bookId, fileId };
  } catch (e) {
    await releaseClaim().catch(() => {});
    if (createdBook && bookId) await deleteBookCascade(env, bookId).catch(() => {});
    throw e;
  }
}

/**
 * 보류된(pending_to_book=1) 자료의 문제 추출 재시도 — 서버가 부팅 시 + 주기적으로 호출.
 * 한도(429)면 이번 주기는 중단(다음 주기·내일 리셋 후 재시도), 영구 실패만 보류 해제.
 */
export async function retryPendingToBook(env: Env): Promise<void> {
  const activeBackfill = await env.DB.prepare(
    `SELECT id FROM materials
     WHERE figure_backfill_pending = 1 AND book_processing = 1 LIMIT 1`
  ).first<{ id: number }>();
  let backfillHandled = activeBackfill !== null;
  const { results } = await env.DB.prepare(
    `SELECT id, figure_backfill_pending FROM materials
     WHERE pending_to_book = 1 AND status = 'ready' AND book_processing = 0
       AND book_retry_count < ?
     ORDER BY figure_backfill_pending DESC, id`
  ).bind(MAX_AUTO_BOOK_RETRIES).all<{ id: number; figure_backfill_pending: number }>();
  for (const r of results) {
    if (r.figure_backfill_pending === 1) {
      if (backfillHandled) continue;
      backfillHandled = true;
    }
    const res = await startMaterialToBook(env, r.id).catch((e) => ({ error: publicBookError(e), code: 500 as const }));
    if (!("error" in res)) {
      console.log(`[문제 추출 재시도] 자료 ${r.id} 처리 시작 (book ${res.bookId})`);
      continue; // 성공 — startMaterialToBook이 보류 해제
    }
    if (res.code === 429) return; // 오늘 한도 소진 — 나머지도 전부 막히므로 이번 주기는 종료
    if (res.code === 409) continue; // 기존 잡이 끝나면 그 잡이 보류/완료 상태를 결정한다
    if (res.code === 500) {
      await recordMaterialBookFailure(env, r.id);
      continue;
    }
    // 400/404 = 영구 실패(원본 없음 등) — 무한 재시도 방지
    await env.DB.prepare("UPDATE materials SET pending_to_book = 0 WHERE id = ?").bind(r.id).run();
    console.error(`[문제 추출 재시도] 자료 ${r.id} 포기:`, res.error);
  }
}

// ── GET /api/subjects/:id/books ───────────────────────────────────────────────
// (내부용) 문제집 목록 + 파일 상태 + 분류별 항목 수 — 프론트 사이드바에서는 더 이상 쓰지 않음
bookRoutes.get("/subjects/:id/books", async (c) => {
  const subjectId = c.req.param("id");
  const { results: books } = await c.env.DB.prepare(
    "SELECT id, title, created_at FROM books WHERE subject_id = ? ORDER BY created_at DESC"
  ).bind(subjectId).all<{ id: number; title: string; created_at: string }>();
  const { results: files } = await c.env.DB.prepare(
    `SELECT id, book_id, name, mime, status, error, progress, retry_chunk_count, chunk_total
     FROM book_files WHERE book_id IN (SELECT id FROM books WHERE subject_id = ?) ORDER BY id`
  ).bind(subjectId).all<{
    id: number;
    book_id: number;
    name: string;
    mime: string;
    status: string;
    error: string | null;
    progress: number;
    retry_chunk_count: number;
    chunk_total: number;
  }>();
  const { results: counts } = await c.env.DB.prepare(
    `SELECT book_id, COUNT(*) AS question_count,
            SUM(CASE WHEN trim(explanation) != '' THEN 1 ELSE 0 END) AS explained_count
     FROM questions
     WHERE book_id IN (SELECT id FROM books WHERE subject_id = ?)
     GROUP BY book_id`
  ).bind(subjectId).all<{ book_id: number; question_count: number; explained_count: number }>();
  const { results: itemCounts } = await c.env.DB.prepare(
    `SELECT book_id, category, COUNT(*) AS n
     FROM book_items
     WHERE book_id IN (SELECT id FROM books WHERE subject_id = ?)
     GROUP BY book_id, category`
  ).bind(subjectId).all<{ book_id: number; category: string; n: number }>();

  return c.json(
    books.map((b) => {
      const count = counts.find((row) => row.book_id === b.id);
      const questionCount = count?.question_count ?? 0;
      const explainedCount = count?.explained_count ?? 0;
      return {
        ...b,
        files: files.filter((f) => f.book_id === b.id),
        question_count: questionCount,
        explained_count: explainedCount,
        counts: Object.fromEntries(
          ["개념", "팁", "문제", "해설"].map((category) => [
            category,
            itemCounts.find((row) => row.book_id === b.id && row.category === category)?.n ?? 0,
          ])
        ),
      };
    })
  );
});

// ── POST /api/subjects/:id/books ──────────────────────────────────────────────
// multipart: title(선택) + file(여러 개 가능 — 문제집·해설지 동시 업로드).
// 같은 제목의 문제집이 있으면 그 문제집에 파일을 추가한다.
bookRoutes.post("/subjects/:id/books", async (c) => {
  const subjectId = Number(c.req.param("id"));
  if (!Number.isInteger(subjectId) || subjectId < 1) return c.json({ error: "잘못된 과목" }, 400);

  const subject = await c.env.DB.prepare("SELECT id FROM subjects WHERE id = ?")
    .bind(subjectId).first<{ id: number }>();
  if (!subject) return c.json({ error: "과목을 찾을 수 없습니다" }, 404);

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "multipart form 파싱 실패" }, 400);
  }

  const uploaded = form.getAll("file").filter((f): f is File => f instanceof File);
  if (uploaded.length === 0) return c.json({ error: "file 필드가 없습니다" }, 400);

  const validated: ValidatedUpload[] = [];
  const requestHashes = new Set<string>();
  for (const f of uploaded) {
    const v = await validateUpload(f);
    if ("error" in v) return c.json({ error: `${f.name}: ${v.error}` }, 400);
    if (requestHashes.has(v.contentHash)) {
      return c.json({ error: `${v.name}: 같은 요청에 동일한 파일이 중복되었습니다` }, 409);
    }
    requestHashes.add(v.contentHash);
    validated.push(v);
  }

  for (const file of validated) {
    const duplicate = await c.env.DB.prepare(
      `SELECT bf.id FROM book_files bf
       JOIN books b ON b.id = bf.book_id
       WHERE b.subject_id = ? AND bf.content_hash = ? LIMIT 1`
    ).bind(subjectId, file.contentHash).first<{ id: number }>();
    if (duplicate) return c.json({ error: `${file.name}: 같은 과목에 동일한 파일이 이미 있습니다` }, 409);
  }

  const claimKeys = validated.map((file) => `${subjectId}:${file.contentHash}`);
  if (claimKeys.some((key) => activeBookUploads.has(key))) {
    return c.json({ error: "같은 과목에 동일한 파일 업로드가 이미 진행 중입니다" }, 409);
  }
  for (const key of claimKeys) activeBookUploads.add(key);

  const title = String(form.get("title") ?? "").trim() || bookTitleFromFilename(validated[0].name);
  let claimedBookId: number | null = null;

  try {
    const targetBook = await c.env.DB.prepare(
      "SELECT id FROM books WHERE subject_id = ? AND title = ?"
    ).bind(subjectId, title).first<{ id: number }>();
    if (targetBook) {
      if (activeSolutionBooks.has(targetBook.id) || activeBookMutations.has(targetBook.id)) {
        return c.json({ error: "이 문제집의 다른 작업이 끝난 뒤 문제 파일을 추가해 주세요" }, 409);
      }
      activeBookMutations.add(targetBook.id);
      claimedBookId = targetBook.id;
    }
    // ponytail: 청크·다중 파일도 사용량 1회로 계산 — 실제 호출 수 기준 과금이 필요해지면 파일·청크 단위로 증가
    if (!(await checkAndIncrementUsage(c.env.DB))) {
      return c.json({ error: "오늘 사용량 한도 도달" }, 429);
    }

    let bookId = 0;
    const fileIds: number[] = [];
    for (const file of validated) {
      const result = await ingestBookFile(c.env, subjectId, title, file);
      bookId = result.bookId;
      fileIds.push(result.fileId);
    }

    return c.json({ id: bookId, files: fileIds, status: "processing" }, 201);
  } finally {
    if (claimedBookId !== null) activeBookMutations.delete(claimedBookId);
    for (const key of claimKeys) activeBookUploads.delete(key);
  }
});

// ── POST /api/subjects/:subjectId/books/:bookId/explanations ─────────────────
// 공식 상세 해설을 인쇄 번호·정답으로 검증한 뒤 해당 번호의 빈 해설만 채운다.
bookRoutes.post("/subjects/:subjectId/books/:bookId/explanations", async (c) => {
  const rawSubjectId = c.req.param("subjectId");
  const rawBookId = c.req.param("bookId");
  if (
    !/^[1-9]\d*$/.test(rawSubjectId) || !Number.isSafeInteger(Number(rawSubjectId))
    || !/^[1-9]\d*$/.test(rawBookId) || !Number.isSafeInteger(Number(rawBookId))
  ) return c.json({ error: "잘못된 과목 또는 문제집" }, 400);
  const subjectId = Number(rawSubjectId);
  const bookId = Number(rawBookId);

  const book = await c.env.DB.prepare(
    "SELECT id FROM books WHERE id = ? AND subject_id = ?"
  ).bind(bookId, subjectId).first<{ id: number }>();
  if (!book) return c.json({ error: "문제집을 찾을 수 없습니다" }, 404);

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "multipart form 파싱 실패" }, 400);
  }
  const uploaded = form.getAll("file").filter((value): value is File => value instanceof File);
  if (uploaded.length !== 1) return c.json({ error: "해설 파일을 하나만 선택해 주세요" }, 400);
  const file = await validateUpload(uploaded[0]);
  if ("error" in file) return c.json({ error: `${uploaded[0].name}: ${file.error}` }, 400);
  if (activeSolutionBooks.has(bookId)) {
    return c.json({ error: "이 문제집의 해설 추가가 이미 진행 중입니다" }, 409);
  }
  if (activeBookMutations.has(bookId)) {
    return c.json({ error: "문제 파일 추가가 끝난 뒤 해설을 추가해 주세요" }, 409);
  }
  activeSolutionBooks.add(bookId);
  let backgroundStarted = false;
  try {
    const processing = await c.env.DB.prepare(
      `SELECT 1 AS busy
       WHERE EXISTS (
         SELECT 1 FROM book_files WHERE book_id = ? AND status = 'processing'
       ) OR EXISTS (
         SELECT 1 FROM materials WHERE book_id = ? AND book_processing = 1
       )`
    ).bind(bookId, bookId).first<{ busy: number }>();
    if (processing) return c.json({ error: "문제 추출이 끝난 뒤 해설을 추가해 주세요" }, 409);

    const { results: questions } = await c.env.DB.prepare(
      `SELECT id, qtype, choices, answer, explanation, book_number, printed_number, src_file_id, src_page
       FROM questions WHERE book_id = ?
       ORDER BY COALESCE(src_page, 2147483647), id`
    ).bind(bookId).all<{
      id: number;
      qtype: string;
      choices: string | null;
      answer: string;
      explanation: string;
      book_number: string | null;
      printed_number: string | null;
      src_file_id: number | null;
      src_page: number | null;
    }>();
    if (questions.length === 0) return c.json({ error: "먼저 문제 추출을 완료해 주세요" }, 409);
    if (questions[0].src_file_id === null || new Set(questions.map((question) => question.src_file_id)).size !== 1) {
      return c.json({ error: "여러 문제 파일을 합친 문제집은 아직 해설 자동 연결을 지원하지 않습니다" }, 409);
    }
    const questionsByLocator = new Map<number, (typeof questions)[number]>();
    let hasDuplicateLocators = false;
    for (const question of questions) {
      const locator = numericPrintedLocator(question.printed_number);
      if (locator === null) {
        return c.json({ error: "문제 원본을 재추출해 실제 인쇄 번호를 확인한 뒤 해설을 추가해 주세요" }, 409);
      }
      if (questionsByLocator.has(locator)) hasDuplicateLocators = true;
      else questionsByLocator.set(locator, question);
    }
    if (hasDuplicateLocators) {
      const positions = new Set<string>();
      for (const question of questions) {
        const locator = numericPrintedLocator(question.printed_number)!;
        const position = question.src_page === null ? null : `${question.src_page}|${locator}`;
        if (position === null || positions.has(position)) {
          return c.json({ error: "반복되는 문제 번호의 원본 페이지 순서를 확인할 수 없습니다" }, 409);
        }
        positions.add(position);
      }
    }

    if (!(await checkAndIncrementUsage(c.env.DB))) {
      return c.json({ error: "오늘 사용량 한도 도달" }, 429);
    }
    const jobId = await createAIJob(c.env.DB, subjectId, "book-explanations");
    const job = startJob(`book-solutions:${bookId}`);
    runAIJob(c.env.DB, jobId, job, async () => {
      let dir: string | undefined;
      try {
        dir = mkdtempSync(join(tmpdir(), "studywork-solutions-"));
        const path = join(dir, file.name);
        writeFileSync(path, Buffer.from(file.bytes));
        const solutions = await extractAllSolutions(
          path,
          file.mime === "application/pdf",
          job.signal
        );
        if (!isCurrentJob(job)) throw new Error("사용자 중단");
        if (solutions.length === 0) throw new Error("해설 항목을 찾지 못했습니다");
        let matched: { question: (typeof questions)[number]; solution: SolutionItem }[];
        if (hasDuplicateLocators) {
          if (solutions.length !== questions.length) {
            throw new Error(`문항 수 불일치: 문제 ${questions.length}개, 검증된 해설 ${solutions.length}개`);
          }
          const orderedSolutions = [...solutions].sort((a, b) => a.page - b.page);
          const positions = new Set<string>();
          matched = orderedSolutions.map((solution, index) => {
            const locator = numericPrintedLocator(solution.number);
            if (locator === null) throw new Error(`문제 번호를 읽을 수 없습니다: ${solution.number}`);
            const position = `${solution.page}|${locator}`;
            if (positions.has(position)) {
              throw new Error(`문제 번호 위치가 모호합니다: 해설 ${solution.page}쪽 ${locator}번`);
            }
            positions.add(position);
            const question = questions[index];
            const expected = numericPrintedLocator(question.printed_number);
            if (locator !== expected) {
              throw new Error(`문제 번호 순서 불일치: ${index + 1}번째 해설은 ${expected}번이어야 합니다`);
            }
            if (!gradeAnswer(question.qtype, question.answer, solution.answer, question.choices)) {
              throw new Error(`정답 불일치: ${index + 1}번째 ${locator}번 문항`);
            }
            return { question, solution };
          });
        } else {
          const solutionsByLocator = new Map<number, SolutionItem>();
          for (const solution of solutions) {
            const locator = numericPrintedLocator(solution.number);
            if (locator === null) throw new Error(`문제 번호를 읽을 수 없습니다: ${solution.number}`);
            const question = questionsByLocator.get(locator);
            if (!question) throw new Error(`문제집에 없는 ${locator}번 해설이 포함되어 있습니다`);
            if (!gradeAnswer(question.qtype, question.answer, solution.answer, question.choices)) {
              throw new Error(`정답 불일치: ${locator}번 문항`);
            }
            const previous = solutionsByLocator.get(locator);
            if (!previous || solution.explanation.trim().length > previous.explanation.trim().length) {
              solutionsByLocator.set(locator, solution);
            }
          }
          if (solutionsByLocator.size !== questions.length) {
            throw new Error(`문항 수 불일치: 문제 ${questions.length}개, 검증된 해설 ${solutionsByLocator.size}개`);
          }
          matched = [...solutionsByLocator.entries()].map(([locator, solution]) => ({
            question: questionsByLocator.get(locator)!,
            solution,
          }));
        }
        const detailed = matched.filter(({ solution }) => solution.explanation.trim());
        if (detailed.length === 0) throw new Error("상세 해설 내용을 찾지 못했습니다");

        const writes = detailed.flatMap(({ question, solution }) => {
          return question.explanation.trim() ? [] : [
            c.env.DB.prepare(
              "UPDATE questions SET explanation = ? WHERE id = ? AND book_id = ? AND trim(explanation) = ''"
            ).bind(solution.explanation.trim(), question.id, bookId),
          ];
        });
        return {
          writes,
          completion: readyAIJobStatement(c.env.DB, jobId, {
            updated: writes.length,
            matched: matched.length,
            answerOnly: matched.length - detailed.length,
            bookId,
          }),
        };
      } finally {
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    }, (error) => `${file.name}: ${publicSolutionError(error)}`, () => {
      activeSolutionBooks.delete(bookId);
    });
    backgroundStarted = true;
    return c.json({ jobId, status: "processing" as const }, 202);
  } finally {
    if (!backgroundStarted) activeSolutionBooks.delete(bookId);
  }
});

// ── GET /api/books/:id ────────────────────────────────────────────────────────
// 문제집 상세: 파일 목록 + 항목 전체 (개념→팁→문제→해설, 번호 수치순)
bookRoutes.get("/books/:id", async (c) => {
  const id = c.req.param("id");
  const book = await c.env.DB.prepare("SELECT * FROM books WHERE id = ?").bind(id).first();
  if (!book) return c.json({ error: "not found" }, 404);

  const { results: files } = await c.env.DB.prepare(
    `SELECT id, name, mime, status, error, progress, retry_chunk_count, chunk_total
     FROM book_files WHERE book_id = ? ORDER BY id`
  ).bind(id).all();
  // '정답'(빠른답표)은 열람 대상이 아니다 — 퀴즈 정답 매칭에만 쓰인다
  const { results: items } = await c.env.DB.prepare(
    `SELECT id, file_id, category, number, answer, content, page, has_figure, figure_box FROM book_items
     WHERE book_id = ? AND category != '정답'
     ORDER BY CASE category WHEN '개념' THEN 0 WHEN '팁' THEN 1 WHEN '문제' THEN 2 ELSE 3 END,
              (CAST(number AS INTEGER) = 0), CAST(number AS INTEGER), number, page, id`
  ).bind(id).all();
  const { results: countRows } = await c.env.DB.prepare(
    "SELECT category, COUNT(*) AS n FROM book_items WHERE book_id = ? GROUP BY category"
  ).bind(id).all<{ category: string; n: number }>();
  const questionCounts = await c.env.DB.prepare(
    `SELECT COUNT(*) AS question_count,
            SUM(CASE WHEN trim(explanation) != '' THEN 1 ELSE 0 END) AS explained_count
     FROM questions WHERE book_id = ?`
  ).bind(id).first<{ question_count: number; explained_count: number | null }>();
  const questionCount = questionCounts?.question_count ?? 0;
  const explainedCount = questionCounts?.explained_count ?? 0;
  const counts = Object.fromEntries(
    ["개념", "팁", "문제", "해설"].map((cat) => [cat, countRows.find((r) => r.category === cat)?.n ?? 0])
  );

  return c.json({
    ...book,
    files,
    items,
    counts,
    question_count: questionCount,
    explained_count: explainedCount,
  });
});

// ── GET /api/book-files/:id/file ──────────────────────────────────────────────
// 원본 파일 서빙 — 그림·도형은 원본 페이지로 확인 (PDF는 #page=N 앵커로 이동)
bookRoutes.get("/book-files/:id/file", async (c) => {
  const f = await c.env.DB.prepare("SELECT r2_key, mime FROM book_files WHERE id = ?")
    .bind(c.req.param("id"))
    .first<{ r2_key: string; mime: string }>();
  if (!f) return c.json({ error: "not found" }, 404);
  const buf = await c.env.FILES.get(f.r2_key);
  if (!buf) return c.json({ error: "원본 파일이 없습니다" }, 404);
  c.header("Content-Type", f.mime || "application/octet-stream");
  return c.body(new Uint8Array(buf));
});

// ── GET /api/book-files/:id/page/:n/image ─────────────────────────────────────
// 원본 PDF의 한 페이지를 PNG로 렌더 — 그림·도형 딸린 항목을 화면에 인라인 표시.
// pdf-lib로 1쪽 슬라이스 → macOS sips로 래스터화, filestore에 캐시.
bookRoutes.get("/book-files/:id/page/:n/image", async (c) => {
  const fileId = c.req.param("id");
  const n = Number(c.req.param("n"));
  if (!Number.isInteger(n) || n < 1) return c.json({ error: "잘못된 페이지" }, 400);

  // 캐시는 DB 행의 수명에 종속된다. 행 확인 전 캐시를 반환하면 삭제된 파일의 페이지가
  // 계속 노출되고 임의 fileId의 stale cache도 인증 사용자에게 서빙될 수 있다.
  const f = await c.env.DB.prepare("SELECT r2_key, mime FROM book_files WHERE id = ?")
    .bind(fileId).first<{ r2_key: string; mime: string }>();
  if (!f) return c.json({ error: "not found" }, 404);

  // box="top,bottom" (페이지 높이 비율) — 페이지 전체 대신 항목 구간만 잘라 반환
  let box: [number, number] | null = null;
  const boxParam = c.req.query("box");
  if (boxParam) {
    const [t, b] = boxParam.split(",").map(Number);
    if (Number.isFinite(t) && Number.isFinite(b) && t >= 0 && b <= 1 && t < b) box = [t, b];
  }

  const cacheKey = box ? `pages/${fileId}-${n}-${box[0]}-${box[1]}.png` : `pages/${fileId}-${n}.png`;
  let png = await c.env.FILES.get(cacheKey);
  if (!png) {
    if (f.mime !== "application/pdf") {
      // 이미지 파일은 원본이 곧 그림
      if (n !== 1) return c.json({ error: "페이지 범위 초과" }, 404);
      const buf = await c.env.FILES.get(f.r2_key);
      if (!buf) return c.json({ error: "원본 파일이 없습니다" }, 404);
      c.header("Content-Type", f.mime);
      return c.body(new Uint8Array(buf));
    }
    const dir = mkdtempSync(join(tmpdir(), "studywork-page-"));
    try {
      const src = await PDFDocument.load(readFileSync(c.env.FILES.absolutePath(f.r2_key)), { ignoreEncryption: true });
      if (n > src.getPageCount()) return c.json({ error: "페이지 범위 초과" }, 404);
      const out = await PDFDocument.create();
      const [p] = await out.copyPages(src, [n - 1]);
      out.addPage(p);
      const pdfPath = join(dir, "p.pdf");
      writeFileSync(pdfPath, await out.save());
      const pngPath = join(dir, "p.png");
      await execFileP("sips", ["-s", "format", "png", "-Z", "1600", pdfPath, "--out", pngPath]);
      if (box) {
        const { stdout } = await execFileP("sips", ["-g", "pixelHeight", "-g", "pixelWidth", pngPath]);
        const H = Number(/pixelHeight: (\d+)/.exec(stdout)?.[1]);
        const W = Number(/pixelWidth: (\d+)/.exec(stdout)?.[1]);
        // 위아래 2% 여유 — 추정 구간이 살짝 어긋나도 내용이 잘리지 않게
        const top = Math.max(0, Math.floor((box[0] - 0.02) * H));
        const bottom = Math.min(H, Math.ceil((box[1] + 0.02) * H));
        if (H > 0 && W > 0 && bottom - top >= 40) {
          await execFileP("sips", ["--cropOffset", String(top), "0", "-c", String(bottom - top), String(W), pngPath]);
        }
      }
      png = readFileSync(pngPath);
      await c.env.FILES.put(cacheKey, png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer);
    } catch {
      return c.json({ error: "페이지 렌더 실패" }, 500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  c.header("Content-Type", "image/png");
  c.header("Cache-Control", "private, max-age=86400");
  return c.body(new Uint8Array(png));
});

// ── POST /api/book-files/:id/cancel ───────────────────────────────────────────
// 분석 중단 — 새 청크 발사를 멈춘다 (이미 진행 중이던 호출은 마저 끝난다)
bookRoutes.post("/book-files/:id/cancel", async (c) => {
  const fileId = Number(c.req.param("id"));
  cancelJob(`book:${fileId}`);
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE book_files SET status = 'error', error = '사용자 중단' WHERE id = ? AND status = 'processing'"
    ).bind(fileId),
    c.env.DB.prepare(
      `UPDATE materials SET pending_to_book = 0, book_processing = 0
       WHERE book_id = (SELECT book_id FROM book_files WHERE id = ?)`
    ).bind(fileId),
  ]);
  return c.json({ id: fileId, status: "cancelled" });
});

// ── POST /api/book-files/:id/retry ────────────────────────────────────────────
// 재추출: 기존 문제는 유지하고, 새 결과가 완성됐을 때만 원자적으로 교체
bookRoutes.post("/book-files/:id/retry", async (c) => {
  const fileId = Number(c.req.param("id"));
  const f = await c.env.DB.prepare(
    `SELECT bf.id, bf.book_id, bf.r2_key, bf.mime, bf.status, bf.error, bf.progress,
            bf.retry_chunk_count, bf.chunk_total, b.subject_id
     FROM book_files bf JOIN books b ON b.id = bf.book_id WHERE bf.id = ?`
  ).bind(fileId).first<{
    id: number;
    book_id: number;
    r2_key: string;
    mime: string;
    status: string;
    error: string | null;
    progress: number;
    retry_chunk_count: number;
    chunk_total: number;
    subject_id: number;
  }>();
  if (!f) return c.json({ error: "not found" }, 404);
  if (activeSolutionBooks.has(f.book_id)) {
    return c.json({ error: "해설 추가가 끝난 뒤 문제를 다시 추출해 주세요" }, 409);
  }
  if (activeBookMutations.has(f.book_id)) {
    return c.json({ error: "이 문제집의 다른 작업이 끝난 뒤 다시 추출해 주세요" }, 409);
  }
  activeBookMutations.add(f.book_id);
  try {
    if (f.status === "processing" || activeBookJobs.has(fileId)) {
      return c.json({ error: "문제 추출이 이미 진행 중입니다" }, 409);
    }
    if (!c.env.FILES.exists(f.r2_key)) return c.json({ error: "원본 파일 없음" }, 404);

    const retryMessage = f.retry_chunk_count > 0
      ? `페이지 구간 ${f.retry_chunk_count}/${f.chunk_total}개 오류·미완료 — 해당 구간만 다시 추출 중`
      : null;
    const resumeProgress = f.chunk_total > 0 && f.retry_chunk_count > 0
      ? Math.round(((f.chunk_total - f.retry_chunk_count) / f.chunk_total) * 100)
      : 0;
    const claimed = await c.env.DB.prepare(
      `UPDATE book_files SET status = 'processing', error = ?, progress = ?
       WHERE id = ? AND status != 'processing' RETURNING id`
    ).bind(retryMessage, resumeProgress, fileId).first<{ id: number }>();
    if (!claimed) return c.json({ error: "문제 추출이 이미 진행 중입니다" }, 409);

    const job = startJob(`book:${fileId}`);
    const restoreClaim = async () => {
      if (!isCurrentJob(job)) return;
      await c.env.DB.prepare(
        `UPDATE book_files SET status = ?, error = ?, progress = ?
         WHERE id = ? AND status = 'processing'`
      ).bind(f.status, f.error, f.progress, fileId).run();
    };
    let usageAllowed: boolean;
    try {
      usageAllowed = await checkAndIncrementUsage(c.env.DB);
    } catch (error) {
      await restoreClaim();
      finishJob(job);
      throw error;
    }
    if (!usageAllowed) {
      await restoreClaim();
      finishJob(job);
      return c.json({ error: "오늘 사용량 한도 도달" }, 429);
    }
    if (!isCurrentJob(job)) {
      finishJob(job);
      return c.json({ error: "문제 추출이 중단되었습니다" }, 409);
    }

    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE materials
         SET pending_to_book = CASE WHEN figure_backfill_pending = 1 THEN 1 ELSE 0 END,
             book_retry_count = CASE WHEN figure_backfill_pending = 1 THEN book_retry_count ELSE 0 END
         WHERE book_id = ?`
      ).bind(f.book_id),
    ]);

    processFile(c.env, fileId, f.book_id, f.subject_id, f.r2_key, f.mime === "application/pdf", job);
    return c.json({ id: fileId, status: "processing" });
  } finally {
    activeBookMutations.delete(f.book_id);
  }
});

// ── DELETE /api/book-files/:id ────────────────────────────────────────────────
// 파일 하나 삭제 — 이 파일에서 뽑은 문제도 함께 제거(문제가 곧 파일의 내용이다).
bookRoutes.delete("/book-files/:id", async (c) => {
  const fileId = c.req.param("id");
  cancelJob(`book:${fileId}`); // 진행 중이던 provider 호출까지 중지
  const f = await c.env.DB.prepare("SELECT book_id, r2_key FROM book_files WHERE id = ?")
    .bind(fileId)
    .first<{ book_id: number; r2_key: string }>();
  if (f) cancelJob(`book-solutions:${f.book_id}`);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM questions WHERE src_file_id = ?").bind(fileId),
    c.env.DB.prepare("DELETE FROM book_files WHERE id = ?").bind(fileId),
  ]);
  clearBookExtractionCache(Number(fileId));
  if (f) await c.env.FILES.delete(f.r2_key).catch(() => {});
  await c.env.FILES.deletePrefix(`pages/${fileId}-`).catch(() => {});
  return c.json({ ok: true });
});

// 내부 book(문제 추출 컨테이너) 연쇄 삭제 — 파일·항목·자동 등록된 퀴즈 문제까지 정리.
// 자료 삭제(materials.ts)와 DELETE /books/:id 라우트가 공유한다.
export async function deleteBookCascade(
  env: Env,
  bookId: number,
  extraStatements: ReturnType<Env["DB"]["prepare"]>[] = []
): Promise<void> {
  cancelJob(`book-solutions:${bookId}`);
  const { results: files } = await env.DB.prepare("SELECT id, r2_key FROM book_files WHERE book_id = ?")
    .bind(bookId)
    .all<{ id: number; r2_key: string }>();
  for (const f of files) {
    cancelJob(`book:${f.id}`); // 진행 중이던 provider 호출까지 중지
  }
  await env.DB.batch([
    ...extraStatements,
    env.DB.prepare(
      "UPDATE materials SET book_id = NULL, book_processing = 0, pending_to_book = 0 WHERE book_id = ?"
    ).bind(bookId),
    env.DB.prepare("DELETE FROM book_items WHERE book_id = ?").bind(bookId),
    env.DB.prepare("DELETE FROM book_files WHERE book_id = ?").bind(bookId),
    env.DB.prepare("DELETE FROM questions WHERE book_id = ?").bind(bookId),
    env.DB.prepare("DELETE FROM books WHERE id = ?").bind(bookId),
  ]);
  for (const f of files) {
    clearBookExtractionCache(f.id);
    await env.FILES.delete(f.r2_key).catch(() => {});
    await env.FILES.deletePrefix(`pages/${f.id}-`).catch(() => {});
  }
}

// ── DELETE /api/books/:id ─────────────────────────────────────────────────────
bookRoutes.delete("/books/:id", async (c) => {
  await deleteBookCascade(c.env, Number(c.req.param("id")));
  return c.json({ ok: true });
});
