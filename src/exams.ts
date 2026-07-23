import { Hono } from "hono";
import type { Env } from "./index";
import { generateStudyPlan } from "./claude";
import { checkAndIncrementUsage } from "./usage";
import { createAIJob, readyAIJobStatement, runAIJob } from "./ai-jobs";
import { cancelJob, claimTarget, isCurrentJob, releaseTarget, startJob } from "./jobs";

export const examRoutes = new Hono<{ Bindings: Env }>();

function todayStr(): string {
  // 로컬(서버=사용자 맥) 날짜 기준 — UTC 기준이면 자정~오전 9시(KST)에 어제로 계산된다
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function loadPlanContext(db: Env["DB"], subjectId: string | number) {
  const { results: mats } = await db.prepare(
    "SELECT title FROM materials WHERE subject_id = ? AND status = 'ready' ORDER BY created_at"
  ).bind(subjectId).all<{ title: string }>();
  const wrongRow = await db.prepare(
    "SELECT COUNT(*) as cnt, SUM(wrong_count) as total FROM questions WHERE subject_id = ? AND wrong_count > 0"
  ).bind(subjectId).first<{ cnt: number; total: number }>();
  return {
    materialTitles: mats.map((m) => m.title),
    wrongSummary: wrongRow && wrongRow.cnt > 0
      ? `오답 문제 ${wrongRow.cnt}개 (총 ${wrongRow.total}회 오답)`
      : "",
  };
}

// ── POST /api/subjects/:id/exams ─────────────────────────────────────────────
// {title, exam_date, scope?} → 서버 백그라운드 job 시작
examRoutes.post("/subjects/:id/exams", async (c) => {
  const subjectId = c.req.param("id");
  const body = await c.req.json<{ title?: string; exam_date?: string; scope?: string }>().catch(
    () => ({}) as { title?: string; exam_date?: string; scope?: string }
  );

  if (!body.title?.trim()) return c.json({ error: "title이 필요합니다" }, 400);
  if (!body.exam_date) return c.json({ error: "exam_date가 필요합니다" }, 400);

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (!DATE_RE.test(body.exam_date)) {
    return c.json({ error: "exam_date는 YYYY-MM-DD 형식이어야 합니다" }, 400);
  }

  // 형식은 맞지만 달력에 없는 날짜(예: 2026-13-45) 거부 — 시간대 영향 없는 컴포넌트 비교
  const [y, m, d] = body.exam_date.split("-").map(Number);
  const parsed = new Date(y, m - 1, d);
  if (parsed.getFullYear() !== y || parsed.getMonth() !== m - 1 || parsed.getDate() !== d) {
    return c.json({ error: "유효하지 않은 날짜입니다" }, 400);
  }

  const today = todayStr();
  if (body.exam_date < today) {
    return c.json({ error: "exam_date는 오늘 이후여야 합니다" }, 400);
  }

  const subject = await c.env.DB.prepare("SELECT name FROM subjects WHERE id = ?")
    .bind(subjectId)
    .first<{ name: string }>();
  if (!subject) return c.json({ error: "subject not found" }, 404);

  const scope = body.scope?.trim() ?? "";
  const { materialTitles, wrongSummary } = await loadPlanContext(c.env.DB, subjectId);

  if (!(await checkAndIncrementUsage(c.env.DB))) {
    return c.json({ error: "오늘 사용량 한도 도달" }, 429);
  }

  // 새 시험 생성은 매번 새로운 대상 — 중복 가드 없이 동시 생성 허용.
  const jobId = await createAIJob(c.env.DB, Number(subjectId), "exam-plan", {
    label: body.title!.trim(),
  });
  const job = startJob(`exam-job:${jobId}`);
  runAIJob(c.env.DB, jobId, job, async () => {
    const items = await generateStudyPlan(
      subject.name,
      body.title!.trim(),
      body.exam_date!,
      today,
      scope,
      materialTitles,
      wrongSummary,
      job.signal
    );
    if (!isCurrentJob(job)) throw new Error("작업이 중단되었습니다");

    if (items.length === 0) throw new Error("생성된 시험 학습 계획이 없습니다");
    return {
        // 시험·TODO·job ready를 runAIJob이 한 batch로 저장한다. FK 실패도 전체 롤백된다.
        writes: [
          c.env.DB.prepare(
            `INSERT INTO exams (subject_id, title, exam_date, scope, ai_job_id)
             VALUES (?, ?, ?, ?, ?)`
          ).bind(subjectId, body.title!.trim(), body.exam_date!, scope, jobId),
          ...items.map((item) =>
            c.env.DB.prepare(
              `INSERT INTO plan_items (exam_id, day, task)
               SELECT id, ?, ? FROM exams WHERE ai_job_id = ?`
            ).bind(item.day, item.task, jobId)
          ),
        ],
        completion: c.env.DB.prepare(
          `UPDATE ai_jobs
           SET status = 'ready',
               result = '{"examId":' || (SELECT id FROM exams WHERE ai_job_id = ?) || '}',
               error = NULL,
               updated_at = datetime('now')
           WHERE id = ?`
        ).bind(jobId, jobId),
    };
  }, "시험 학습 계획 생성에 실패했습니다.");

  return c.json({ jobId, status: "processing" }, 202);
});

// ── GET /api/subjects/:id/exams ──────────────────────────────────────────────
// 시험 목록 + 각 items + done 카운트
examRoutes.get("/subjects/:id/exams", async (c) => {
  const subjectId = c.req.param("id");
  const { results: exams } = await c.env.DB.prepare(
    "SELECT * FROM exams WHERE subject_id = ? ORDER BY exam_date"
  )
    .bind(subjectId)
    .all<Record<string, unknown>>();

  const result = [];
  for (const exam of exams) {
    const { results: items } = await c.env.DB.prepare(
      "SELECT * FROM plan_items WHERE exam_id = ? ORDER BY day, id"
    )
      .bind(exam.id)
      .all<Record<string, unknown>>();
    const doneCount = items.filter((i) => i.done === 1).length;
    result.push({ ...exam, items, done_count: doneCount });
  }

  return c.json(result);
});

// ── PATCH /api/plan-items/:id ────────────────────────────────────────────────
// {done: boolean} 토글
examRoutes.patch("/plan-items/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ done?: boolean }>().catch(() => ({}) as { done?: boolean });
  if (body.done === undefined || body.done === null) {
    return c.json({ error: "done 필드가 필요합니다" }, 400);
  }
  const doneVal = body.done ? 1 : 0;

  const item = await c.env.DB.prepare("SELECT id FROM plan_items WHERE id = ?")
    .bind(id)
    .first();
  if (!item) return c.json({ error: "not found" }, 404);

  await c.env.DB.prepare("UPDATE plan_items SET done = ? WHERE id = ?")
    .bind(doneVal, id)
    .run();

  return c.json({ ok: true });
});

// ── POST /api/exams/:id/replan ───────────────────────────────────────────────
// 오늘 이후 미완료 items를 서버 백그라운드에서 재생성
examRoutes.post("/exams/:id/replan", async (c) => {
  const examId = c.req.param("id");

  const exam = await c.env.DB.prepare(
    "SELECT e.*, s.name as subject_name FROM exams e JOIN subjects s ON s.id = e.subject_id WHERE e.id = ?"
  )
    .bind(examId)
    .first<{
      id: number;
      subject_id: number;
      subject_name: string;
      title: string;
      exam_date: string;
      scope: string;
    }>();
  if (!exam) return c.json({ error: "exam not found" }, 404);

  const today = todayStr();
  if (exam.exam_date < today) {
    return c.json({ error: "이미 지난 시험은 재계획할 수 없습니다" }, 400);
  }

  // 유지할 items: done=1 OR day < today
  const { results: keepItems } = await c.env.DB.prepare(
    "SELECT * FROM plan_items WHERE exam_id = ? AND (done = 1 OR day < ?)"
  )
    .bind(examId, today)
    .all<{ id: number; day: string; task: string; done: number }>();

  // 완료된 태스크 요약
  const doneSummary =
    keepItems.filter((i) => i.done === 1).length > 0
      ? "이미 완료: " +
        keepItems
          .filter((i) => i.done === 1)
          .map((i) => `[${i.day}] ${i.task}`)
          .join(", ")
      : "";

  const { materialTitles, wrongSummary } = await loadPlanContext(c.env.DB, exam.subject_id);
  const scopeWithDone = doneSummary ? `${exam.scope}\n${doneSummary} — 완료한 내용은 계획에서 제외하라` : exam.scope;

  // 대상 단위 중복 가드 — 같은 시험의 재계획만 409, 다른 시험·새 시험 생성은 동시 허용.
  // (이전에는 같은 키 startJob이 진행 중이던 재계획을 조용히 끊었다 — 이제 명시적으로 거부한다.)
  const targetKey = `exam-replan:${exam.id}`;
  if (!claimTarget(targetKey)) {
    return c.json({ error: "이 시험의 재계획이 이미 진행 중입니다" }, 409);
  }
  let backgroundStarted = false;
  try {
  if (!(await checkAndIncrementUsage(c.env.DB))) {
    return c.json({ error: "오늘 사용량 한도 도달" }, 429);
  }

  const jobId = await createAIJob(c.env.DB, exam.subject_id, "exam-plan", {
    label: `${exam.title} 재계획`,
    target: `replan:${exam.id}`,
  });
  const job = startJob(`exam:${exam.id}`);
  runAIJob(c.env.DB, jobId, job, async () => {
    const newItems = await generateStudyPlan(
      exam.subject_name,
      exam.title,
      exam.exam_date,
      today,
      scopeWithDone,
      materialTitles,
      wrongSummary,
      job.signal
    );
    if (!isCurrentJob(job)) throw new Error("작업이 중단되었습니다");
    if (newItems.length === 0) throw new Error("생성된 시험 학습 계획이 없습니다");
    const exists = await c.env.DB.prepare("SELECT id FROM exams WHERE id = ?")
      .bind(exam.id).first();
    if (!exists) throw new Error("시험이 삭제되었습니다");

    return {
        // AI 성공 후 기존 미완료 계획 교체와 job ready를 같은 트랜잭션에 넣는다.
        writes: [
          c.env.DB.prepare("DELETE FROM plan_items WHERE exam_id = ? AND done = 0 AND day >= ?")
            .bind(exam.id, today),
          ...newItems.map((item) =>
            c.env.DB.prepare(
              `INSERT INTO plan_items (exam_id, day, task)
               VALUES (?, ?, ?)`
            ).bind(exam.id, item.day, item.task)
          ),
        ],
        completion: readyAIJobStatement(c.env.DB, jobId, { examId: exam.id }),
    };
  },
  "시험 학습 계획을 조정하지 못했습니다.",
  () => { releaseTarget(targetKey); });
  backgroundStarted = true;
  return c.json({ jobId, status: "processing" }, 202);
  } finally {
    if (!backgroundStarted) releaseTarget(targetKey);
  }
});

// ── DELETE /api/exams/:id ────────────────────────────────────────────────────
// items까지 삭제
examRoutes.delete("/exams/:id", async (c) => {
  const examId = c.req.param("id");
  cancelJob(`exam:${examId}`);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM plan_items WHERE exam_id = ?").bind(examId),
    c.env.DB.prepare("DELETE FROM exams WHERE id = ?").bind(examId),
  ]);
  return c.json({ ok: true });
});
