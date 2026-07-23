import { Hono } from "hono";
import type { Env } from "./index";
import type { LocalDB, PreparedStatement } from "./localdb";
import { cancelJob, finishJob, isCurrentJob, type JobToken } from "./jobs";

export const aiJobRoutes = new Hono<{ Bindings: Env }>();
const activeAIJobs = new Map<number, JobToken>();

export async function createAIJob(db: LocalDB, subjectId: string | number, kind: string): Promise<number> {
  const row = await db.prepare(
    "INSERT INTO ai_jobs (subject_id, kind) VALUES (?, ?) RETURNING id"
  ).bind(subjectId, kind).first<{ id: number }>();
  if (!row) throw new Error("AI 작업을 생성하지 못했습니다");
  return row.id;
}

export interface AIJobCommit {
  writes: PreparedStatement[];
  completion: PreparedStatement;
}

export function readyAIJobStatement(db: LocalDB, jobId: number, result: unknown): PreparedStatement {
  return db.prepare(
    "UPDATE ai_jobs SET status = 'ready', result = ?, error = NULL, updated_at = datetime('now') WHERE id = ?"
  ).bind(JSON.stringify(result), jobId);
}

export function runAIJob(
  db: LocalDB,
  jobId: number,
  job: JobToken,
  task: () => Promise<AIJobCommit>,
  publicError: string | ((error: unknown) => string) = "AI 작업에 실패했습니다. 잠시 후 다시 시도해 주세요.",
  onSettled?: () => void | Promise<void>
): void {
  activeAIJobs.set(jobId, job);
  setImmediate(() => {
    void (async () => {
      try {
        const commit = await task();
        if (!isCurrentJob(job)) throw new Error("사용자 중단");
        // 도메인 결과와 ready/result를 한 트랜잭션으로 저장해 재시작 틈의 중복을 막는다.
        await db.batch([...commit.writes, commit.completion]);
      } catch (error: unknown) {
        console.error(`[AI 작업 ${jobId}] ${error instanceof Error ? error.message : "unknown error"}`);
        try {
          const message = job.signal.aborted || !isCurrentJob(job)
            ? "사용자 중단"
            : typeof publicError === "function" ? publicError(error) : publicError;
          await db.prepare(
            "UPDATE ai_jobs SET status = 'error', result = NULL, error = ?, updated_at = datetime('now') WHERE id = ?"
          ).bind(message, jobId).run();
        } catch (saveError: unknown) {
          console.error(`[AI 작업 ${jobId} 상태 저장 실패] ${saveError instanceof Error ? saveError.message : "unknown error"}`);
        }
      } finally {
        if (activeAIJobs.get(jobId) === job) activeAIJobs.delete(jobId);
        finishJob(job);
        try {
          await onSettled?.();
        } catch (settleError: unknown) {
          console.error(`[AI 작업 ${jobId} 정리 실패] ${settleError instanceof Error ? settleError.message : "unknown error"}`);
        }
      }
    })();
  });
}

aiJobRoutes.get("/ai-jobs/:id", async (c) => {
  const rawId = c.req.param("id");
  if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(Number(rawId))) {
    return c.json({ error: "유효하지 않은 작업 ID입니다" }, 400);
  }
  const row = await c.env.DB.prepare(
    "SELECT id, subject_id, kind, status, result, error, created_at, updated_at FROM ai_jobs WHERE id = ?"
  ).bind(Number(rawId)).first<{
    id: number;
    subject_id: number;
    kind: string;
    status: "processing" | "ready" | "error";
    result: string | null;
    error: string | null;
    created_at: string;
    updated_at: string;
  }>();
  if (!row) return c.json({ error: "작업을 찾을 수 없습니다" }, 404);
  return c.json({
    ...row,
    result: row.result ? JSON.parse(row.result) as unknown : null,
  });
});

aiJobRoutes.post("/ai-jobs/:id/cancel", async (c) => {
  const rawId = c.req.param("id");
  if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(Number(rawId))) {
    return c.json({ error: "유효하지 않은 작업 ID입니다" }, 400);
  }
  const id = Number(rawId);
  const row = await c.env.DB.prepare("SELECT status FROM ai_jobs WHERE id = ?")
    .bind(id).first<{ status: "processing" | "ready" | "error" }>();
  if (!row) return c.json({ error: "작업을 찾을 수 없습니다" }, 404);
  if (row.status !== "processing") return c.json({ status: row.status });

  const job = activeAIJobs.get(id);
  if (job) cancelJob(job.key);
  await c.env.DB.prepare(
    "UPDATE ai_jobs SET status = 'error', result = NULL, error = '사용자 중단', updated_at = datetime('now') WHERE id = ? AND status = 'processing'"
  ).bind(id).run();
  return c.json({ status: "error" as const });
});
