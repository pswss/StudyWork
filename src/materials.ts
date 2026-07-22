// 자료 라우트 — 파일을 한 번 전사하고, 문제·해설 페이지가 있으면 퀴즈 문제도 자동 추출한다.
import { Hono } from "hono";
import type { Env } from "./index";
import {
  extractFromFile,
  mapSections,
  MATERIAL_EXTRACT_CHUNK_PAGES,
  type MaterialChunkCheckpoint,
} from "./claude";
import { startMaterialToBook, deleteBookCascade, publicBookError } from "./books";
import { checkAndIncrementUsage } from "./usage";
import { validateUpload } from "./upload";
import { cancelJob, finishJob, isCurrentJob, startJob, type JobToken } from "./jobs";
import { AIProviderError } from "./codex-provider";

export const materials = new Hono<{ Bindings: Env }>();
const activeMaterialUploads = new Set<string>();

function materialChunkTotal(kind: "image" | "pdf", pageCount: number): number {
  return kind === "pdf" ? Math.max(1, Math.ceil(pageCount / MATERIAL_EXTRACT_CHUNK_PAGES)) : 1;
}

// 백그라운드 추출 — 탭 이동·브라우저 종료와 무관하게 진행. 진행률(%)은 청크 완료 기준.
async function processMaterial(
  env: Env,
  id: number,
  r2Key: string,
  kind: "image" | "pdf",
  job: JobToken,
  source: { name: string; pageCount: number }
): Promise<void> {
  let chunkTotal = materialChunkTotal(kind, source.pageCount);
  let retryChunkCount = 0;
  let retryMode = false;
  try {
    const prior = await env.DB.prepare(
      "SELECT retry_chunk_count, chunk_total FROM materials WHERE id = ?"
    ).bind(id).first<{ retry_chunk_count: number; chunk_total: number }>();
    retryMode = Boolean(prior && prior.retry_chunk_count > 0 && prior.chunk_total > 0);
    if (retryMode && prior) {
      chunkTotal = prior.chunk_total;
      retryChunkCount = prior.retry_chunk_count;
    }
    await env.DB.prepare(
      `UPDATE materials SET chunk_total = ?, retry_chunk_count = ?
       WHERE id = ? AND status = 'processing'`
    ).bind(chunkTotal, retryChunkCount, id).run();
    const onProgress = (p: number) => {
      if (!isCurrentJob(job)) return;
      env.DB.prepare(
        "UPDATE materials SET progress = ? WHERE id = ? AND status = 'processing'"
      ).bind(p, id).run().catch(() => {});
    };
    const checkpoint: MaterialChunkCheckpoint | undefined = kind === "pdf" ? {
      async onPlan(completed, total) {
        if (!isCurrentJob(job)) return;
        chunkTotal = total;
        retryChunkCount = retryMode ? Math.max(0, total - completed) : 0;
        await env.DB.prepare(
          `UPDATE materials SET retry_chunk_count = ?, chunk_total = ?
           WHERE id = ? AND status = 'processing'`
        ).bind(retryChunkCount, total, id).run();
      },
      async load(index, from, to) {
        const row = await env.DB.prepare(
          `SELECT content FROM material_extraction_chunks
           WHERE material_id = ? AND chunk_index = ? AND page_from = ? AND page_to = ?`
        ).bind(id, index, from, to).first<{ content: string }>();
        return row?.content ?? null;
      },
      async save(index, from, to, content) {
        if (!isCurrentJob(job)) return;
        await env.DB.prepare(
          `INSERT INTO material_extraction_chunks
             (material_id, chunk_index, page_from, page_to, content)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(material_id, chunk_index) DO UPDATE SET
             page_from = excluded.page_from,
             page_to = excluded.page_to,
             content = excluded.content`
        ).bind(id, index, from, to, content).run();
      },
      async onRetry(count, total) {
        if (!isCurrentJob(job)) return;
        chunkTotal = total;
        retryChunkCount = count;
        if (count > 0) retryMode = true;
        await env.DB.prepare(
          `UPDATE materials SET retry_chunk_count = ?, chunk_total = ?
           WHERE id = ? AND status = 'processing'`
        ).bind(count, total, id).run();
      },
    } : undefined;
    const extracted = await extractFromFile(
      env.FILES.absolutePath(r2Key),
      kind,
      onProgress,
      () => !isCurrentJob(job),
      job.signal,
      source,
      checkpoint
    );
    // 세대가 바뀌었으면 저장하지 않는다 — cancel 직후 retry가 구 작업을 되살리는 것 방지.
    if (!isCurrentJob(job)) return;
    // 파트 지도: 페이지 미리보기로 개념/문제/해설/기타 범위를 1회 분류 —
    // 이후 단권화·문제 추출이 자기 파트만 읽는다. 실패해도 추출 결과는 살린다.
    let map: Awaited<ReturnType<typeof mapSections>> = [];
    try {
      map = await mapSections(extracted, job.signal);
    } catch (e) {
      if (!isCurrentJob(job)) return;
      // 전사는 이미 성공했다. 보조 파트 지도 실패 때문에 원문까지 버리고 재과금하지 않는다.
      console.error(`[파트 지도] 자료 ${id} 분류 실패 — 전사본은 보존:`, e);
    }
    if (!isCurrentJob(job)) return;
    // 추출 도중 자료가 삭제됐으면 저장하지 않는다
    const alive = await env.DB.prepare("SELECT id FROM materials WHERE id = ?").bind(id).first();
    if (!alive || !isCurrentJob(job)) return;
    const provider = process.env.STUDYWORK_AI_PROVIDER?.trim() || "codex-cli";
    const extractionMethod = provider === "codex-cli"
      ? (kind === "pdf" ? "codex-cli-pdf-images" : "codex-cli-image")
      : "claude-cli-read";
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE materials
         SET extracted_text = ?, section_map = ?, status = 'ready', error = NULL,
             extraction_method = ?, ocr_used = ?, integrity_warning = NULL,
             integrity_checked_at = datetime('now'), retry_chunk_count = 0,
             chunk_total = ?
         WHERE id = ? AND status = 'processing'`
      ).bind(
        extracted,
        map.length > 0 ? JSON.stringify(map) : null,
        extractionMethod,
        kind === "image" ? 1 : null,
        chunkTotal,
        id
      ),
      env.DB.prepare(
        `DELETE FROM material_extraction_chunks
         WHERE material_id = ?
           AND EXISTS (SELECT 1 FROM materials WHERE id = ? AND status = 'ready')`
      ).bind(id, id),
    ]);
    const finalized = await env.DB.prepare(
      "SELECT status FROM materials WHERE id = ?"
    ).bind(id).first<{ status: string }>();
    if (!isCurrentJob(job) || finalized?.status !== "ready") return;
    // 파트 지도에 문제·해설 페이지가 있으면 원본을 비전으로 읽어 문제를 '문제 칸'에 자동 등록
    if (map.some((r) => r.part === "문제" || r.part === "해설")) {
      const res = await startMaterialToBook(env, id).catch((e) => ({ error: publicBookError(e), code: 500 as const }));
      if ("error" in res) {
        // 한도·일시 오류면 보류 표시 — 상주 재시도 루프(retryPendingToBook)가 이어서 처리
        await env.DB.prepare("UPDATE materials SET pending_to_book = 1 WHERE id = ?").bind(id).run();
        console.error(`[자동 문제 추출] 자료 ${id} 보류 (재시도 예정):`, res.error);
      }
    }
  } catch (error) {
    if (isCurrentJob(job)) {
      const message = publicMaterialError(error);
      const checkpointState = await env.DB.prepare(
        "SELECT retry_chunk_count, chunk_total FROM materials WHERE id = ?"
      ).bind(id).first<{ retry_chunk_count: number; chunk_total: number }>();
      const remaining = kind === "image"
        ? 1
        : checkpointState?.retry_chunk_count ?? retryChunkCount;
      const total = checkpointState?.chunk_total || chunkTotal;
      await env.DB.prepare(
        `UPDATE materials SET status = 'error', error = ?, retry_chunk_count = ?, chunk_total = ?
         WHERE id = ? AND status = 'processing'`
      )
        .bind(message, remaining, total, id).run();
    }
  } finally {
    finishJob(job);
  }
}

function publicMaterialError(error: unknown): string {
  if (error instanceof AIProviderError) {
    switch (error.code) {
      case "invalid_config":
        return "AI 설정이 올바르지 않습니다";
      case "auth":
        return "Codex CLI 로그인이 필요합니다";
      case "rate_limit":
        return "Codex 사용량 한도 또는 속도 제한에 도달했습니다. 잠시 후 재시도해 주세요";
      case "timeout":
        return "AI 분석 시간이 초과되었습니다. 재시도해 주세요";
      case "cancelled":
        return "사용자 중단";
      case "file_too_large":
        return "AI 요청용 PDF 구간이 50MB를 초과했습니다";
      case "invalid_file":
        return "AI가 파일을 읽을 수 없습니다";
      case "unavailable":
        return "Codex CLI가 응답하지 않습니다. 잠시 후 재시도해 주세요";
      case "invalid_response":
      case "empty_response":
        return "AI 응답이 완전하지 않습니다. 재시도해 주세요";
      default:
        return "AI 분석에 실패했습니다. 재시도해 주세요";
    }
  }
  if (!(error instanceof Error)) return "AI 분석에 실패했습니다. 재시도해 주세요";

  const exactMessages = new Map<string, string>([
    ["사용자 중단", "사용자 중단"],
    ["파일 읽기에 실패했습니다", "파일 읽기에 실패했습니다"],
    ["모델이 전사를 거부했습니다 — 재시도해 주세요", "AI가 자료 분석 요청을 처리하지 못했습니다"],
    ["사용량 한도로 자료 추출이 중단됨 — 한도 리셋 후 재시도하세요", "사용량 한도로 자료 추출이 중단되었습니다. 한도 리셋 후 재시도해 주세요"],
  ]);
  const exact = exactMessages.get(error.message);
  if (exact) return exact;

  // 숫자만 다시 조립해 반환한다. 원본 오류 문자열에는 절대 경로나 파일명이
  // 포함될 수 있으므로 알려지지 않은 메시지를 그대로 사용자에게 노출하지 않는다.
  const chunkFailure = /^자료 추출 실패: 페이지 구간 (\d{1,4})\/(\d{1,4})개가 실패했습니다$/.exec(error.message);
  if (chunkFailure) {
    return `자료 추출 실패: 페이지 구간 ${chunkFailure[1]}/${chunkFailure[2]}개가 실패했습니다`;
  }
  return "AI 분석에 실패했습니다. 재시도해 주세요";
}

materials.get("/subjects/:id/materials", async (c) => {
  // book_status/book_progress: 자료에서 뽑는 문제 추출 진행 상태 (연결된 내부 book_files 1건)
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.subject_id, m.kind, m.title, m.status, m.error, m.progress, m.created_at,
            m.retry_chunk_count, m.chunk_total,
            m.original_filename, m.page_count, m.extraction_method, m.ocr_used, m.integrity_warning,
            m.source_type, m.source_path, m.source_modified_at,
            bf.id AS book_file_id, bf.status AS book_status,
            bf.progress AS book_progress, bf.error AS book_error,
            bf.retry_chunk_count AS book_retry_chunk_count,
            bf.chunk_total AS book_chunk_total
     FROM materials m
     LEFT JOIN book_files bf ON bf.id = (
       SELECT id FROM book_files WHERE book_id = m.book_id ORDER BY id DESC LIMIT 1
     )
     WHERE m.subject_id = ? ORDER BY m.created_at DESC`
  ).bind(c.req.param("id")).all();
  return c.json(results);
});

materials.post("/subjects/:id/materials", async (c) => {
  const subjectId = c.req.param("id");
  const subject = await c.env.DB.prepare("SELECT id FROM subjects WHERE id = ?")
    .bind(subjectId).first<{ id: number }>();
  if (!subject) return c.json({ error: "과목을 찾을 수 없습니다" }, 404);
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "multipart form 파싱 실패" }, 400);
  }
  const title = (form.get("title") as string | null)?.trim() || "제목 없음";
  const text = form.get("text") as string | null;
  const file = form.get("file") as File | null;

  if (text && Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) {
    return c.json({ error: "텍스트 자료는 2MB 이하만 지원합니다" }, 413);
  }
  if (text?.trim()) {
    const row = await c.env.DB.prepare(
      "INSERT INTO materials (subject_id, kind, title, extracted_text, status) VALUES (?, 'text', ?, ?, 'ready') RETURNING id"
    ).bind(subjectId, title, text.trim()).first<{ id: number }>();
    return c.json({ id: row!.id, status: "ready" }, 201);
  }

  if (!file) return c.json({ error: "file 또는 text 필요" }, 400);

  const v = await validateUpload(file);
  if ("error" in v) return c.json({ error: v.error }, 400);

  const claimKey = `${subjectId}:${v.contentHash}`;
  if (activeMaterialUploads.has(claimKey)) {
    return c.json({ error: "동일한 파일 업로드가 이미 진행 중입니다" }, 409);
  }
  activeMaterialUploads.add(claimKey);

  const r2Key = `materials/${subjectId}/${v.contentHash.slice(0, 16)}-${v.name}`;
  let stored = false;
  try {
    const duplicate = await c.env.DB.prepare(
      "SELECT id, status FROM materials WHERE subject_id = ? AND content_hash = ? LIMIT 1"
    ).bind(subjectId, v.contentHash).first<{ id: number; status: string }>();
    if (duplicate) {
      return c.json({ error: "동일한 파일이 이미 등록되어 있습니다", existingId: duplicate.id, status: duplicate.status }, 409);
    }

    if (!(await checkAndIncrementUsage(c.env.DB))) {
      return c.json({ error: "오늘 사용량 한도 도달" }, 429);
    }

    const kind = v.kind;

    // 모든 업로드는 자료로 처리한다 — 추출 후 파트 지도에 문제·해설이 있으면 문제를 자동으로
    // 뽑아 '문제 칸'(퀴즈)에 등록한다(processMaterial). 별도의 '문제집' 개념·수동 단계는 없다.
    // 추출은 전부 백그라운드 — 업로드 응답이 AI를 기다리지 않아 브라우저 타임아웃이 없다.
    await c.env.FILES.put(r2Key, v.bytes);
    stored = true;
    const row = await c.env.DB.prepare(
      `INSERT INTO materials
         (subject_id, kind, title, r2_key, status, content_hash, original_filename, page_count)
       VALUES (?, ?, ?, ?, 'processing', ?, ?, ?) RETURNING id`
    ).bind(subjectId, kind, title, r2Key, v.contentHash, v.name, v.pageCount).first<{ id: number }>();
    const id = row!.id;

    processMaterial(c.env, id, r2Key, kind, startJob(`mat:${id}`), {
      name: v.name,
      pageCount: v.pageCount,
    }); // fire-and-forget

    return c.json({ id, status: "processing" }, 201);
  } catch {
    const winner = await c.env.DB.prepare(
      "SELECT id, status FROM materials WHERE subject_id = ? AND content_hash = ? LIMIT 1"
    ).bind(subjectId, v.contentHash).first<{ id: number; status: string }>();
    if (winner) {
      return c.json({ error: "동일한 파일이 이미 등록되어 있습니다", existingId: winner.id, status: winner.status }, 409);
    }
    if (stored) await c.env.FILES.delete(r2Key).catch(() => {});
    return c.json({ error: "자료 파일을 저장하지 못했습니다" }, 500);
  } finally {
    activeMaterialUploads.delete(claimKey);
  }
});

// 분석 중단 — 새 청크 발사를 멈춘다 (이미 진행 중이던 호출은 마저 끝난다)
materials.post("/materials/:id/cancel", async (c) => {
  const id = Number(c.req.param("id"));
  cancelJob(`mat:${id}`);
  await c.env.DB.prepare(
    "UPDATE materials SET status = 'error', error = '사용자 중단' WHERE id = ? AND status = 'processing'"
  ).bind(id).run();
  return c.json({ id, status: "cancelled" });
});

materials.post("/materials/:id/retry", async (c) => {
  const id = Number(c.req.param("id"));
  const m = await c.env.DB.prepare("SELECT * FROM materials WHERE id = ?").bind(id)
    .first<{
      id: number;
      kind: string;
      title: string;
      original_filename: string | null;
      r2_key: string | null;
      status: string;
      error: string | null;
      progress: number;
      page_count: number | null;
      retry_chunk_count: number;
      chunk_total: number;
    }>();
  if (!m?.r2_key) return c.json({ error: "재시도할 파일 없음" }, 404);
  if (!c.env.FILES.exists(m.r2_key)) return c.json({ error: "원본 파일 없음" }, 404);

  const kind = m.kind === "pdf" ? "pdf" : "image";
  const hasRetryState = m.retry_chunk_count > 0 && m.chunk_total > 0;
  const chunkTotal = hasRetryState
    ? m.chunk_total
    : materialChunkTotal(kind, m.page_count ?? (kind === "pdf" ? 0 : 1));
  const retryChunkCount = hasRetryState ? m.retry_chunk_count : chunkTotal;
  const resumeProgress = Math.round(((chunkTotal - retryChunkCount) / chunkTotal) * 100);
  const claimed = await c.env.DB.prepare(
    `UPDATE materials
     SET status = 'processing', error = NULL, progress = ?, retry_chunk_count = ?, chunk_total = ?
     WHERE id = ? AND status != 'processing' RETURNING id`
  ).bind(resumeProgress, retryChunkCount, chunkTotal, id).first<{ id: number }>();
  if (!claimed) return c.json({ error: "이미 분석 중입니다" }, 409);
  const job = startJob(`mat:${id}`);
  const restoreClaim = async () => {
    if (!isCurrentJob(job)) return;
    await c.env.DB.prepare(
      `UPDATE materials SET status = ?, error = ?, progress = ?, retry_chunk_count = ?, chunk_total = ?
       WHERE id = ? AND status = 'processing'`
    ).bind(m.status, m.error, m.progress, m.retry_chunk_count, m.chunk_total, id).run();
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
    return c.json({ error: "자료 분석이 중단되었습니다" }, 409);
  }

  processMaterial(
    c.env,
    id,
    m.r2_key,
    kind,
    job,
    {
      name: m.original_filename?.trim() || m.title,
      pageCount: m.page_count ?? (m.kind === "pdf" ? 0 : 1),
    }
  );
  return c.json({ id, status: "processing" });
});

materials.get("/materials/:id", async (c) => {
  const m = await c.env.DB.prepare("SELECT * FROM materials WHERE id = ?").bind(c.req.param("id")).first();
  if (!m) return c.json({ error: "not found" }, 404);
  return c.json(m);
});

materials.delete("/materials/:id", async (c) => {
  const id = Number(c.req.param("id"));
  cancelJob(`mat:${id}`); // 진행 중이던 추출 잡 중지
  const m = await c.env.DB.prepare(
    "SELECT r2_key, book_id FROM materials WHERE id = ?"
  )
    .bind(id).first<{ r2_key: string | null; book_id: number | null }>();
  const deleteMaterial = c.env.DB.prepare("DELETE FROM materials WHERE id = ?").bind(id);
  // 자료와 내부 book을 한 batch에서 지워 둘 중 하나만 남는 부분 실패를 막는다.
  if (m?.book_id) await deleteBookCascade(c.env, m.book_id, [deleteMaterial]);
  else await c.env.DB.batch([deleteMaterial]);
  if (m?.r2_key) await c.env.FILES.delete(m.r2_key).catch(() => {});
  return c.json({ ok: true });
});
