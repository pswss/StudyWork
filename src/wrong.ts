import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { Env } from "./index";
import { extractQuestionsFromFile, analyzeWrongQuestions, type QuizQuestion } from "./claude";
import { checkAndIncrementUsage } from "./usage";
import { validateUpload } from "./upload";
import { insertQuestions } from "./quiz";

export const wrongRoutes = new Hono<{ Bindings: Env }>();

// ── GET /api/subjects/:id/wrong ──────────────────────────────────────────────
// wrong_count > 0 인 문제 목록, 오답 횟수 내림차순. 마지막 시도 시각 포함(없으면 null)
wrongRoutes.get("/subjects/:id/wrong", async (c) => {
  const subjectId = c.req.param("id");
  const { results } = await c.env.DB.prepare(
    "SELECT q.*, (SELECT MAX(created_at) FROM question_attempts qa WHERE qa.question_id = q.id) AS last_attempted_at " +
    "FROM questions q WHERE subject_id = ? AND wrong_count > 0 ORDER BY wrong_count DESC"
  )
    .bind(subjectId)
    .all<Record<string, unknown>>();

  const rows = results.map((r) => ({
    ...r,
    choices: r.choices ? JSON.parse(r.choices as string) : null,
  }));
  return c.json(rows);
});

// ── POST /api/subjects/:id/wrong/extract ─────────────────────────────────────
// 오답 노트 사진/PDF → 문제 추출 → from_wrong_note=1, wrong_count=1 로 insert
wrongRoutes.post("/subjects/:id/wrong/extract", async (c) => {
  const subjectId = c.req.param("id");

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "multipart form 파싱 실패" }, 400);
  }

  const file = form.get("file") as File | null;
  if (!file) return c.json({ error: "file 필드가 없습니다" }, 400);

  const v = await validateUpload(file);
  if ("error" in v) return c.json({ error: v.error }, 400);

  if (!(await checkAndIncrementUsage(c.env.DB))) {
    return c.json({ error: "오늘 사용량 한도 도달" }, 429);
  }

  // 검증이 읽은 동일한 바이트와 정규화된 이름만 사용한다. 원본 File을 다시
  // 읽으면 검증 시점과 저장 시점 사이의 불일치가 생길 수 있다.
  // UUID는 동일 파일이 동시에 처리될 때 서로의 임시 파일을 지우는 경쟁을 막는다.
  const r2Key = `wrong/${subjectId}/${v.contentHash}-${randomUUID()}-${v.name}`;
  try {
    await c.env.FILES.put(r2Key, v.bytes);
    const questions: QuizQuestion[] = await extractQuestionsFromFile(
      c.env.FILES.absolutePath(r2Key),
      v.kind
    );
    const added = await insertQuestions(c.env.DB, subjectId, "uploaded", questions, true);
    return c.json({ added }, 201);
  } catch {
    // 공급자 오류에는 로컬 절대 경로나 원문 일부가 포함될 수 있어 그대로 노출하지 않는다.
    return c.json({ error: "오답 노트 문제 추출에 실패했습니다. 잠시 후 다시 시도해 주세요." }, 502);
  } finally {
    try {
      await c.env.FILES.delete(r2Key);
    } catch {
      // 응답을 뒤집거나 경로를 로그에 남기지 않되 운영자가 정리 실패를 알 수 있게 한다.
      console.error("[오답 추출] 임시 파일 정리 실패");
    }
  }
});

// ── POST /api/subjects/:id/wrong/analyze ─────────────────────────────────────
// 오답 목록 분석 → {analysis}
wrongRoutes.post("/subjects/:id/wrong/analyze", async (c) => {
  const subjectId = c.req.param("id");

  const subject = await c.env.DB.prepare("SELECT name FROM subjects WHERE id = ?")
    .bind(subjectId)
    .first<{ name: string }>();
  if (!subject) return c.json({ error: "subject not found" }, 404);

  const { results: wrongs } = await c.env.DB.prepare(
    "SELECT question, answer, qtype, difficulty, wrong_count FROM questions WHERE subject_id = ? AND wrong_count > 0 ORDER BY wrong_count DESC"
  )
    .bind(subjectId)
    .all<{ question: string; answer: string; qtype: string; difficulty: string; wrong_count: number }>();

  if (wrongs.length === 0) {
    return c.json({ error: "분석할 오답이 없습니다" }, 400);
  }

  if (!(await checkAndIncrementUsage(c.env.DB))) {
    return c.json({ error: "오늘 사용량 한도 도달" }, 429);
  }

  try {
    const analysis = await analyzeWrongQuestions(subject.name, wrongs);
    return c.json({ analysis });
  } catch {
    return c.json({ error: "오답 분석에 실패했습니다. 잠시 후 다시 시도해 주세요." }, 502);
  }
});
