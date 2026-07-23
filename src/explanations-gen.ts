// AI 해설 채우기 — 해설이 빈 기존 문제를 AI가 직접 풀어 해설을 만든다.
// 검산 계약: 모델이 도출한 정답(derived_answer)이 등록된 공식 정답과 일치할 때만
// questions.explanation에 저장한다. 불일치 항목은 건너뛰고 개수로만 보고한다.

import { Hono } from "hono";
import type { Env } from "./index";
import { generateExplanationsForQuestions, type ExplanationTask } from "./claude";
import { checkAndIncrementUsage } from "./usage";
import { createAIJob, readyAIJobStatement, runAIJob } from "./ai-jobs";
import { isCurrentJob, startJob } from "./jobs";
import { gradeAnswer } from "./quiz";

export const explanationGenRoutes = new Hono<{ Bindings: Env }>();

// 한 모델 호출당 문항 수 — 5~8 사이. 6이면 밀도 높은 서술 해설도 출력 한도 안에 안전.
export const EXPLANATION_BATCH_SIZE = 6;

// 과목당 동시 1개 벌크 작업 — 같은 문제를 두 작업이 이중 처리하지 않게 한다.
const activeExplanationSubjects = new Set<number>();

interface MissingQuestion {
  id: number;
  qtype: string;
  question: string;
  choices: string | null;
  answer: string;
}

function parseStoredChoices(choicesJson: string | null): string[] | null {
  if (!choicesJson) return null;
  try {
    const parsed: unknown = JSON.parse(choicesJson);
    return Array.isArray(parsed) && parsed.every((choice) => typeof choice === "string") ? parsed : null;
  } catch {
    return null;
  }
}

// 삭제된 원본 파일의 문제는 퀴즈 은행과 동일하게 "직접 생성·기타" 그룹으로 합친다.
const EFFECTIVE_SRC_FILE =
  "CASE WHEN EXISTS(SELECT 1 FROM book_files bf WHERE bf.id = q.src_file_id) THEN q.src_file_id ELSE NULL END";

// ── GET /api/subjects/:id/explanations/missing ───────────────────────────────
// 해설이 빈 문제 수를 출처(자료/문제집 파일 + 직접 생성 그룹)별로 집계한다.
explanationGenRoutes.get("/subjects/:id/explanations/missing", async (c) => {
  const subjectId = c.req.param("id");
  const { results } = await c.env.DB.prepare(
    `SELECT ${EFFECTIVE_SRC_FILE} AS src_file_id,
            (SELECT name FROM book_files bf WHERE bf.id = ${EFFECTIVE_SRC_FILE}) AS src_file_name,
            COUNT(*) AS missing
     FROM questions q
     WHERE q.subject_id = ? AND trim(q.explanation) = ''
     GROUP BY 1
     ORDER BY src_file_id IS NULL, src_file_name`
  ).bind(subjectId).all<{ src_file_id: number | null; src_file_name: string | null; missing: number }>();
  return c.json(results);
});

// ── POST /api/subjects/:id/explanations/generate ─────────────────────────────
// {srcFileId?: number, manual?: true} → ai_jobs 생성 → 배치(6문항)로 해설 생성.
// 배치마다 검산 통과분을 즉시 저장(체크포인트) — 중단돼도 다음 실행이 남은(빈 해설) 문제만 처리한다.
explanationGenRoutes.post("/subjects/:id/explanations/generate", async (c) => {
  const rawSubjectId = c.req.param("id");
  if (!/^[1-9]\d*$/.test(rawSubjectId) || !Number.isSafeInteger(Number(rawSubjectId))) {
    return c.json({ error: "잘못된 과목입니다" }, 400);
  }
  const subjectId = Number(rawSubjectId);

  const body = await c.req.json<{ srcFileId?: unknown; manual?: unknown }>().catch(
    () => ({}) as { srcFileId?: unknown; manual?: unknown }
  );
  if (body.srcFileId !== undefined && body.manual !== undefined) {
    return c.json({ error: "srcFileId와 manual은 함께 지정할 수 없습니다" }, 400);
  }
  if (body.srcFileId !== undefined && (!Number.isSafeInteger(body.srcFileId) || (body.srcFileId as number) < 1)) {
    return c.json({ error: "srcFileId는 양의 정수여야 합니다" }, 400);
  }
  if (body.manual !== undefined && body.manual !== true) {
    return c.json({ error: "manual은 true만 지정할 수 있습니다" }, 400);
  }
  const srcFileId = body.srcFileId as number | undefined;
  const manualOnly = body.manual === true;

  const subject = await c.env.DB.prepare("SELECT name FROM subjects WHERE id = ?")
    .bind(subjectId)
    .first<{ name: string }>();
  if (!subject) return c.json({ error: "subject not found" }, 404);

  let scopeSql = "";
  const params: unknown[] = [subjectId];
  if (srcFileId !== undefined) {
    scopeSql = " AND q.src_file_id = ?";
    params.push(srcFileId);
  } else if (manualOnly) {
    scopeSql = ` AND ${EFFECTIVE_SRC_FILE} IS NULL`;
  }
  const { results: missing } = await c.env.DB.prepare(
    `SELECT q.id, q.qtype, q.question, q.choices, q.answer
     FROM questions q
     WHERE q.subject_id = ? AND trim(q.explanation) = ''${scopeSql}
     ORDER BY q.id`
  ).bind(...params).all<MissingQuestion>();
  if (missing.length === 0) {
    return c.json({ error: "해설이 비어 있는 문제가 없습니다" }, 400);
  }

  if (activeExplanationSubjects.has(subjectId)) {
    return c.json({ error: "이 과목의 AI 해설 생성이 이미 진행 중입니다" }, 409);
  }
  if (!(await checkAndIncrementUsage(c.env.DB))) {
    return c.json({ error: "오늘 사용량 한도 도달" }, 429);
  }

  activeExplanationSubjects.add(subjectId);
  let backgroundStarted = false;
  try {
    const jobId = await createAIJob(c.env.DB, subjectId, "explanation-generate");
    const job = startJob(`explanation-job:${jobId}`);
    runAIJob(c.env.DB, jobId, job, async () => {
      let filled = 0;
      let skippedMismatch = 0;
      const skippedIds: number[] = [];
      for (let start = 0; start < missing.length; start += EXPLANATION_BATCH_SIZE) {
        if (!isCurrentJob(job)) throw new Error("사용자 중단");
        const batch = missing.slice(start, start + EXPLANATION_BATCH_SIZE);
        const tasks: ExplanationTask[] = batch.map((question) => ({
          id: question.id,
          qtype: question.qtype,
          question: question.question,
          choices: parseStoredChoices(question.choices),
          answer: question.answer,
        }));
        const items = await generateExplanationsForQuestions(subject.name, tasks, job.signal);
        if (!isCurrentJob(job)) throw new Error("사용자 중단");

        const byId = new Map(batch.map((question) => [question.id, question]));
        const writes = [];
        for (const item of items) {
          const question = byId.get(item.id)!;
          if (gradeAnswer(question.qtype, question.answer, item.derived_answer, question.choices)) {
            // trim(explanation)='' 가드: 그 사이 해설 업로드 등이 먼저 채웠으면 덮지 않는다.
            writes.push(
              c.env.DB.prepare(
                "UPDATE questions SET explanation = ? WHERE id = ? AND trim(explanation) = ''"
              ).bind(item.explanation, item.id)
            );
            filled++;
          } else {
            skippedMismatch++;
            skippedIds.push(item.id);
          }
        }
        // 배치 체크포인트 — 검산 통과분을 즉시 커밋한다. 이후 배치가 실패해도 여기까지는
        // 저장되고, 재실행 시 빈 해설 조회가 남은 문제만 다시 뽑아 자연히 이어서 진행된다.
        if (writes.length > 0) await c.env.DB.batch(writes);
      }
      return {
        writes: [],
        completion: readyAIJobStatement(c.env.DB, jobId, { filled, skippedMismatch, skippedIds }),
      };
    },
    "AI 해설 생성에 실패했습니다. 이미 저장된 해설은 유지되며, 다시 시도하면 남은 문제만 처리합니다.",
    () => { activeExplanationSubjects.delete(subjectId); });
    backgroundStarted = true;
    return c.json({ jobId, status: "processing" as const }, 202);
  } finally {
    if (!backgroundStarted) activeExplanationSubjects.delete(subjectId);
  }
});

// ── POST /api/questions/:id/explanation/generate ─────────────────────────────
// 단일 문제 즉시 생성 — 같은 검산 경로. 일치하면 저장 후 해설 반환, 불일치면 filled:false.
explanationGenRoutes.post("/questions/:id/explanation/generate", async (c) => {
  const id = c.req.param("id");
  const question = await c.env.DB.prepare(
    `SELECT q.id, q.qtype, q.question, q.choices, q.answer, q.explanation, s.name AS subject_name
     FROM questions q JOIN subjects s ON s.id = q.subject_id
     WHERE q.id = ?`
  ).bind(id).first<MissingQuestion & { explanation: string; subject_name: string }>();
  if (!question) return c.json({ error: "not found" }, 404);
  if (question.explanation.trim()) {
    return c.json({ error: "이미 해설이 있는 문제입니다" }, 409);
  }

  if (!(await checkAndIncrementUsage(c.env.DB))) {
    return c.json({ error: "오늘 사용량 한도 도달" }, 429);
  }

  try {
    const [item] = await generateExplanationsForQuestions(question.subject_name, [{
      id: question.id,
      qtype: question.qtype,
      question: question.question,
      choices: parseStoredChoices(question.choices),
      answer: question.answer,
    }]);
    if (!gradeAnswer(question.qtype, question.answer, item.derived_answer, question.choices)) {
      return c.json({ filled: false });
    }
    await c.env.DB.prepare(
      "UPDATE questions SET explanation = ? WHERE id = ? AND trim(explanation) = ''"
    ).bind(item.explanation, question.id).run();
    return c.json({ filled: true, explanation: item.explanation });
  } catch {
    // 공급자 오류에는 로컬 경로나 원문 일부가 포함될 수 있어 그대로 노출하지 않는다.
    return c.json({ error: "AI 해설 생성에 실패했습니다. 잠시 후 다시 시도해 주세요." }, 502);
  }
});
