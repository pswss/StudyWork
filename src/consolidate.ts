import { Hono } from "hono";
import type { Env } from "./index";
import { consolidate, parseSectionMap, filterPagesByParts } from "./claude";
import { checkAndIncrementUsage } from "./usage";
import { cancelJob, finishJob, isCurrentJob, startJob } from "./jobs";

export const consolidateRoutes = new Hono<{ Bindings: Env }>();

consolidateRoutes.post("/subjects/:id/consolidate", async (c) => {
  const subjectId = c.req.param("id");
  type Body = { instructions?: string; materialIds?: number[]; bookIds?: number[] };
  const { instructions, materialIds, bookIds } = await c.req.json<Body>().catch(() => ({}) as Body);
  const subject = await c.env.DB.prepare("SELECT name FROM subjects WHERE id = ?")
    .bind(subjectId).first<{ name: string }>();
  if (!subject) return c.json({ error: "subject not found" }, 404);

  const { results: allMats } = await c.env.DB.prepare(
    "SELECT id, title, extracted_text, section_map FROM materials WHERE subject_id = ? AND status = 'ready' ORDER BY created_at"
  ).bind(subjectId).all<{ id: number; title: string; extracted_text: string; section_map: string | null }>();
  // 파일 선택: 배열이 오면(빈 배열 포함) 그 목록만, 아예 없으면 전체
  // 파트 지도가 있으면 개념(코멘트·팁 포함) 페이지만 읽는다 — 문제·해설·잡페이지 토큰 낭비 제거
  const mats: { title: string; extracted_text: string }[] =
    (Array.isArray(materialIds) ? allMats.filter((m) => materialIds.includes(m.id)) : allMats)
      .map((m) => ({
        title: m.title,
        extracted_text: filterPagesByParts(m.extracted_text, parseSectionMap(m.section_map), ["개념"]),
      }));

  // 문제집의 개념·팁 항목도 단권화 소스로 쓴다 — 문제집 하나로 해설·퀴즈·단권화를 모두 해결
  const { results: allBooks } = await c.env.DB.prepare(
    "SELECT id, title FROM books WHERE subject_id = ? ORDER BY created_at"
  ).bind(subjectId).all<{ id: number; title: string }>();
  const wantedBooks = Array.isArray(bookIds)
    ? allBooks.filter((b) => bookIds.includes(b.id))
    : allBooks;
  for (const b of wantedBooks) {
    const { results: items } = await c.env.DB.prepare(
      "SELECT category, content FROM book_items WHERE book_id = ? AND category IN ('개념','팁') ORDER BY page, id"
    ).bind(b.id).all<{ category: string; content: string }>();
    if (items.length === 0) continue;
    mats.push({
      title: b.title,
      extracted_text: items.map((it) => (it.category === "팁" ? "[팁] " : "") + it.content).join("\n\n"),
    });
  }

  if (mats.length === 0) return c.json({ error: "단권화할 자료가 없습니다" }, 400);

  const existingNote = await c.env.DB.prepare("SELECT status, progress FROM notes WHERE subject_id = ?")
    .bind(subjectId).first<{ status: string; progress: number }>();
  const claimed = await c.env.DB.prepare(
    `INSERT INTO notes (subject_id, content, status, progress, updated_at)
     VALUES (?, '', 'processing', 0, datetime('now'))
     ON CONFLICT(subject_id) DO UPDATE SET status = 'processing', progress = 0, updated_at = datetime('now')
     WHERE notes.status != 'processing'
     RETURNING subject_id`
  ).bind(subjectId).first<{ subject_id: number }>();
  if (!claimed) {
    return c.json({ error: "이미 단권화 중입니다" }, 409);
  }

  const job = startJob(`note:${subjectId}`);
  const restoreClaim = async () => {
    if (!isCurrentJob(job)) return;
    if (existingNote) {
      await c.env.DB.prepare(
        "UPDATE notes SET status = ?, progress = ? WHERE subject_id = ? AND status = 'processing'"
      ).bind(existingNote.status, existingNote.progress, subjectId).run();
    } else {
      await c.env.DB.prepare(
        "DELETE FROM notes WHERE subject_id = ? AND status = 'processing' AND content = ''"
      ).bind(subjectId).run();
    }
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
    return c.json({ error: "단권화가 중단되었습니다" }, 409);
  }

  // 백그라운드 실행 — 노트 status로 진행 표시. 탭 이동·브라우저 종료·타임아웃과 무관하게 끝까지 진행.
  (async () => {
    try {
      const onProgress = (p: number) => {
        if (!isCurrentJob(job)) return;
        c.env.DB.prepare(
          "UPDATE notes SET progress = ? WHERE subject_id = ? AND status = 'processing'"
        ).bind(p, subjectId).run().catch(() => {});
      };
      const content = await consolidate(
        subject.name,
        mats,
        instructions,
        onProgress,
        () => !isCurrentJob(job),
        job.signal
      );
      // 구 세대 결과가 cancel/retry/수동 편집을 덮어쓰지 못하게 한다.
      if (!isCurrentJob(job)) return;
      // 새 버전으로 쌓고(기록 보존) 현재 노트도 갱신
      await c.env.DB.batch([
        c.env.DB.prepare(
          "INSERT INTO note_versions (subject_id, content) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM notes WHERE subject_id = ? AND status = 'processing')"
        ).bind(subjectId, content, subjectId),
        c.env.DB.prepare(
          "UPDATE notes SET content = ?, status = 'ready', progress = 100, updated_at = datetime('now') WHERE subject_id = ? AND status = 'processing'"
        ).bind(content, subjectId),
      ]);
    } catch {
      // 기존 노트 내용은 보존하고 상태만 실패로
      if (isCurrentJob(job)) {
        await c.env.DB.prepare(
          "UPDATE notes SET status = 'error' WHERE subject_id = ? AND status = 'processing'"
        ).bind(subjectId).run();
      }
    } finally {
      finishJob(job);
    }
  })();

  return c.json({ status: "processing" }, 202);
});

// 단권화 중단 — 새 청크·병합 라운드 발사를 멈춘다 (진행 중이던 호출은 마저 끝난다)
consolidateRoutes.post("/subjects/:id/consolidate/cancel", async (c) => {
  const subjectId = c.req.param("id");
  cancelJob(`note:${subjectId}`);
  await c.env.DB.prepare(
    "UPDATE notes SET status = 'error' WHERE subject_id = ? AND status = 'processing'"
  ).bind(subjectId).run();
  return c.json({ status: "cancelled" });
});

// 단권화 기록 목록 (최신순)
consolidateRoutes.get("/subjects/:id/note-versions", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, created_at, length(content) AS len FROM note_versions WHERE subject_id = ? ORDER BY id DESC"
  ).bind(c.req.param("id")).all();
  return c.json(results);
});

// 특정 버전 전체 내용
consolidateRoutes.get("/note-versions/:id", async (c) => {
  const v = await c.env.DB.prepare("SELECT id, content, created_at FROM note_versions WHERE id = ?")
    .bind(c.req.param("id")).first();
  if (!v) return c.json({ error: "not found" }, 404);
  return c.json(v);
});

// 기록(버전) 하나 삭제
consolidateRoutes.delete("/note-versions/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM note_versions WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

// 현재 노트 + 모든 기록 삭제
consolidateRoutes.delete("/subjects/:id/note", async (c) => {
  const subjectId = c.req.param("id");
  cancelJob(`note:${subjectId}`);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM note_versions WHERE subject_id = ?").bind(subjectId),
    c.env.DB.prepare("DELETE FROM notes WHERE subject_id = ?").bind(subjectId),
  ]);
  return c.json({ ok: true });
});

// 노트 직접 수정 (웹에서 편집 저장)
consolidateRoutes.put("/subjects/:id/note", async (c) => {
  const subjectId = c.req.param("id");
  const { content } = await c.req.json<{ content?: string }>().catch(() => ({}) as { content?: string });
  if (!content?.trim()) return c.json({ error: "content required" }, 400);
  const subject = await c.env.DB.prepare("SELECT id FROM subjects WHERE id = ?")
    .bind(subjectId).first();
  if (!subject) return c.json({ error: "subject not found" }, 404);
  cancelJob(`note:${subjectId}`);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO notes (subject_id, content, status, updated_at) VALUES (?, ?, 'ready', datetime('now'))
       ON CONFLICT(subject_id) DO UPDATE SET content = excluded.content, status = 'ready', updated_at = excluded.updated_at`
    ).bind(subjectId, content),
    // 손수 고친 내용도 기록으로 남긴다
    c.env.DB.prepare("INSERT INTO note_versions (subject_id, content) VALUES (?, ?)").bind(subjectId, content),
  ]);
  return c.json({ ok: true });
});

consolidateRoutes.get("/subjects/:id/note", async (c) => {
  const note = await c.env.DB.prepare("SELECT content, updated_at, status, progress FROM notes WHERE subject_id = ?")
    .bind(c.req.param("id")).first();
  if (!note) return c.json({ error: "not found" }, 404);
  return c.json(note);
});
