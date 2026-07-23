import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { Env } from "./index";
import { generateQuestions, type QuizQuestion } from "./claude";
import { checkAndIncrementUsage } from "./usage";
import { createAIJob, readyAIJobStatement, runAIJob } from "./ai-jobs";
import { activeBookMutations, activeSolutionBooks, isCurrentJob, startJob } from "./jobs";

export const quizRoutes = new Hono<{ Bindings: Env }>();

function questionInsertStatements(
  db: Env["DB"],
  subjectId: string | number,
  source: "uploaded" | "generated",
  questions: QuizQuestion[],
  fromWrongNote: boolean,
  failIfSubjectMissing: boolean
) {
  const flag = fromWrongNote ? 1 : 0;
  return questions.map((q) => {
    const choicesJson = q.choices ? JSON.stringify(q.choices) : null;
    const sql = failIfSubjectMissing
      ? `INSERT INTO questions
         (subject_id, source, qtype, difficulty, question, choices, answer, explanation, from_wrong_note, wrong_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      : `INSERT INTO questions
         (subject_id, source, qtype, difficulty, question, choices, answer, explanation, from_wrong_note, wrong_count)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM subjects WHERE id = ?)`;
    const values: unknown[] = [
      subjectId, source, q.qtype, q.difficulty, q.question, choicesJson,
      q.answer, q.explanation, flag, flag,
    ];
    if (!failIfSubjectMissing) values.push(subjectId);
    return db.prepare(sql).bind(...values);
  });
}

// ── 공통 헬퍼: 문제 배열을 DB에 insert하고 추가된 수를 반환한다 (wrong.ts에서도 사용) ──
export async function insertQuestions(
  db: Env["DB"],
  subjectId: string | number,
  source: "uploaded" | "generated",
  questions: QuizQuestion[],
  fromWrongNote = false // true면 오답 노트 출처 표시 + wrong_count=1 로 시작
): Promise<number> {
  if (questions.length === 0) return 0;
  const statements = questionInsertStatements(db, subjectId, source, questions, fromWrongNote, false);

  // LocalDB와 D1의 batch는 단일 트랜잭션으로 실행된다. 중간 문항 하나가
  // 제약 조건을 위반해도 앞 문항만 남는 부분 저장을 허용하지 않는다.
  await db.batch(statements);
  const subject = await db.prepare("SELECT id FROM subjects WHERE id = ?").bind(subjectId).first();
  return subject ? questions.length : 0;
}

// ── GET /api/subjects/:id/questions?source=&difficulty= ──────────────────────
// 문제 은행 목록 (answer/explanation 포함 — 인쇄·편집용)
quizRoutes.get("/subjects/:id/questions", async (c) => {
  const subjectId = c.req.param("id");
  const source = c.req.query("source");
  const difficulty = c.req.query("difficulty");

  let sql =
    "SELECT q.*, (SELECT name FROM book_files bf WHERE bf.id = q.src_file_id) AS src_file_name " +
    "FROM questions q WHERE subject_id = ?";
  const params: unknown[] = [subjectId];

  if (source && ["uploaded", "generated"].includes(source)) {
    sql += " AND source = ?";
    params.push(source);
  }
  if (difficulty && ["하", "중", "상"].includes(difficulty)) {
    sql += " AND difficulty = ?";
    params.push(difficulty);
  }
  // 파일별로 묶이도록 src_file_id로 그룹핑 후 문제 번호 수치순 (프론트 드롭다운 그룹 정렬)
  sql += " ORDER BY src_file_id, CAST(book_number AS INTEGER), book_number, created_at DESC";

  const { results } = await c.env.DB.prepare(sql)
    .bind(...params)
    .all<Record<string, unknown>>();

  // choices JSON 문자열 → 배열로 파싱. 원본 파일이 삭제된 문제는 링크·파일명을 숨긴다(죽은 404 방지)
  const rows = results.map((r) => ({
    ...r,
    choices: r.choices ? JSON.parse(r.choices as string) : null,
    src_file_id: r.src_file_name != null ? r.src_file_id : null,
    src_file_name: r.src_file_name ?? null,
  }));
  return c.json(rows);
});

// 문제 파일 업로드 추출 라우트는 제거 — 문제집화(to-book)가 문제 등록을 담당한다

// ── POST /api/subjects/:id/questions/generate ────────────────────────────────
// {count, difficulty, materialIds?} → 즉시 job 반환 → 서버에서 자료 기반 AI 생성·insert
quizRoutes.post("/subjects/:id/questions/generate", async (c) => {
  const subjectId = c.req.param("id");

  const body = await c.req.json<{ count?: number; difficulty?: string; materialIds?: unknown }>().catch(
    () => ({}) as { count?: number; difficulty?: string; materialIds?: unknown }
  );

  const count = Number(body.count ?? 10);
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    return c.json({ error: "count는 1~20 사이 정수여야 합니다" }, 400);
  }

  const diff = body.difficulty ?? "혼합";
  if (!["하", "중", "상", "혼합"].includes(diff)) {
    return c.json({ error: "difficulty는 하/중/상/혼합 중 하나여야 합니다" }, 400);
  }

  let materialIds: number[] | undefined;
  if (body.materialIds !== undefined) {
    if (
      !Array.isArray(body.materialIds) ||
      body.materialIds.length < 1 ||
      body.materialIds.length > 500 ||
      body.materialIds.some((id) => !Number.isSafeInteger(id) || id < 1)
    ) {
      return c.json({ error: "materialIds는 1~500개의 양의 정수 ID여야 합니다" }, 400);
    }
    materialIds = body.materialIds as number[];
    if (new Set(materialIds).size !== materialIds.length) {
      return c.json({ error: "materialIds는 중복 없이 지정해야 합니다" }, 400);
    }
  }

  // 과목 조회
  const subject = await c.env.DB.prepare("SELECT name FROM subjects WHERE id = ?")
    .bind(subjectId)
    .first<{ name: string }>();
  if (!subject) return c.json({ error: "subject not found" }, 404);

  // 준비된 자료 필요 (≥1)
  const { results: readyMats } = await c.env.DB.prepare(
    "SELECT id, title, extracted_text FROM materials WHERE subject_id = ? AND status = 'ready' ORDER BY created_at"
  )
    .bind(subjectId)
    .all<{ id: number; title: string; extracted_text: string }>();
  const selected = materialIds ? new Set(materialIds) : null;
  const scopedMats = selected ? readyMats.filter((material) => selected.has(material.id)) : readyMats;
  if (selected && scopedMats.length !== selected.size) {
    return c.json({ error: "선택한 자료 중 이 과목에서 사용할 수 없는 파일이 있습니다" }, 400);
  }
  const mats = scopedMats.filter((material) =>
    typeof material.extracted_text === "string" && material.extracted_text.trim().length > 0
  );
  if (mats.length === 0) {
    return c.json({ error: "선택한 자료에 문제를 만들 수 있는 본문이 없습니다." }, 400);
  }

  if (!(await checkAndIncrementUsage(c.env.DB))) {
    return c.json({ error: "오늘 사용량 한도 도달" }, 429);
  }

  const jobId = await createAIJob(c.env.DB, subjectId, "question-generate");
  const job = startJob(`question-job:${jobId}`);
  runAIJob(c.env.DB, jobId, job, async () => {
    const questions = await generateQuestions(
      subject.name,
      mats,
      count,
      diff as "하" | "중" | "상" | "혼합",
      job.signal
    );
    if (!isCurrentJob(job)) throw new Error("작업이 중단되었습니다");
    return {
      // plain VALUES + FK: 과목이 삭제된 경우 전체 batch가 실패하고 문항 일부도 남지 않는다.
      writes: questionInsertStatements(c.env.DB, subjectId, "generated", questions, false, true),
      completion: readyAIJobStatement(c.env.DB, jobId, { added: questions.length }),
    };
  }, "문제 생성에 실패했습니다. AI 설정과 선택 자료를 확인한 뒤 다시 시도해 주세요.");
  return c.json({ jobId, status: "processing" as const }, 202);
});

// ── GET /api/subjects/:id/quiz ───────────────────────────────────────────────
// 출제: answer/explanation 제외, 오답 가중 랜덤 선택
// wrong=1 파라미터 시 wrong_count>0 인 문제만 출제
quizRoutes.get("/subjects/:id/quiz", async (c) => {
  const subjectId = c.req.param("id");
  const source = c.req.query("source") || "all";
  const difficulty = c.req.query("difficulty") || "all";
  const wrongOnly = c.req.query("wrong") === "1";
  const search = new URL(c.req.url).searchParams;
  const questionIdParams = search.getAll("questionIds");
  const srcFileIdParams = search.getAll("src_file_id");
  if (questionIdParams.length > 1 || srcFileIdParams.length > 1) {
    return c.json({ error: "questionIds와 src_file_id는 각각 한 번만 지정할 수 있습니다" }, 400);
  }
  if (questionIdParams.length > 0 && srcFileIdParams.length > 0) {
    return c.json({ error: "questionIds와 src_file_id는 함께 지정할 수 없습니다" }, 400);
  }

  let questionIds: number[] | null = null;
  if (questionIdParams.length > 0) {
    const tokens = questionIdParams[0].split(",").map((token) => token.trim());
    if (tokens.length < 1 || tokens.length > 50 || tokens.some((token) => !/^[1-9]\d*$/.test(token))) {
      return c.json({ error: "questionIds는 1~50개의 양의 정수 ID여야 합니다" }, 400);
    }
    questionIds = tokens.map(Number);
    if (questionIds.some((id) => !Number.isSafeInteger(id)) || new Set(questionIds).size !== questionIds.length) {
      return c.json({ error: "questionIds는 중복 없는 안전한 정수 ID여야 합니다" }, 400);
    }
  }

  let srcFileId: number | null = null;
  if (srcFileIdParams.length > 0) {
    const raw = srcFileIdParams[0].trim();
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      return c.json({ error: "src_file_id는 양의 정수여야 합니다" }, 400);
    }
    srcFileId = Number(raw);
  }
  const rawCount = c.req.query("count");
  let count = rawCount ? parseInt(rawCount, 10) : 10;
  if (isNaN(count)) count = 10;
  count = Math.max(1, Math.min(50, count));

  // src_file_id는 원본 파일이 실제로 남아 있을 때만 노출 — 삭제된 문제집의 죽은 링크(404) 방지
  let sql =
    "SELECT id, qtype, difficulty, question, choices, source, " +
    "CASE WHEN EXISTS(SELECT 1 FROM book_files bf WHERE bf.id = questions.src_file_id) THEN src_file_id ELSE NULL END AS src_file_id, " +
    "src_page, has_figure, figure_description, figure_box FROM questions WHERE subject_id = ?";
  const params: unknown[] = [subjectId];

  if (questionIds) {
    sql += ` AND questions.id IN (${questionIds.map(() => "?").join(",")})`;
    params.push(...questionIds);
  } else if (srcFileId !== null) {
    sql += " AND questions.src_file_id = ?";
    params.push(srcFileId);
  }

  if (source !== "all" && ["uploaded", "generated"].includes(source)) {
    sql += " AND source = ?";
    params.push(source);
  }
  if (difficulty !== "all" && ["하", "중", "상"].includes(difficulty)) {
    sql += " AND difficulty = ?";
    params.push(difficulty);
  }
  if (wrongOnly) {
    sql += " AND wrong_count > 0";
  }

  // SRS-lite: 오답이 정답보다 많은 것 우선 → 오래 안 본 순(미시도는 가장 오래된 취급) → 랜덤 타이브레이크
  sql +=
    " ORDER BY (wrong_count > correct_count) DESC," +
    " COALESCE((SELECT MAX(qa.created_at) FROM question_attempts qa WHERE qa.question_id = questions.id), '') ASC," +
    " RANDOM() LIMIT ?";
  params.push(count);

  const { results } = await c.env.DB.prepare(sql)
    .bind(...params)
    .all<Record<string, unknown>>();

  const rows = results.map((r) => ({
    id: r.id,
    qtype: r.qtype,
    difficulty: r.difficulty,
    question: r.question,
    choices: r.choices ? JSON.parse(r.choices as string) : null,
    source: r.source,
    src_file_id: r.src_file_id ?? null, // 문제집 자동 등록 문제의 원본 파일 (도형·그림 확인용)
    src_page: r.src_page ?? null,
    has_figure: r.has_figure === 1,
    figure_description: r.figure_description ?? null,
    figure_box: r.figure_box ?? null,
  }));
  return c.json(rows);
});

// ── POST /api/questions/:id/answer ───────────────────────────────────────────
// {answer, attemptId} → 정규화 비교 → 멱등 counts 갱신 → {correct, answer, explanation}
quizRoutes.post("/questions/:id/answer", async (c) => {
  const id = c.req.param("id");

  const body = await c.req
    .json<{ answer?: string; attemptId?: string }>()
    .catch(() => ({}) as { answer?: string; attemptId?: string });
  if (body.answer === undefined || body.answer === null || !String(body.answer).trim()) {
    return c.json({ error: "answer 필드가 필요합니다" }, 400);
  }
  const attemptId = body.attemptId === undefined ? randomUUID() : String(body.attemptId).trim();
  if (!attemptId || attemptId.length > 100) {
    return c.json({ error: "attemptId는 1~100자여야 합니다" }, 400);
  }

  const q = await c.env.DB.prepare("SELECT * FROM questions WHERE id = ?")
    .bind(id)
    .first<{
      id: number;
      qtype: string;
      choices: string | null;
      answer: string;
      explanation: string;
      correct_count: number;
      wrong_count: number;
    }>();
  if (!q) return c.json({ error: "not found" }, 404);

  const userAnswer = String(body.answer);
  const correct = gradeAnswer(q.qtype, q.answer, userAnswer, q.choices);

  // 네트워크 재시도로 같은 답안이 다시 도착해도 학습 통계는 한 번만 증가한다.
  // changes()는 바로 앞 INSERT가 실제로 행을 추가했을 때만 1이다.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO question_attempts (question_id, attempt_id, correct)
       VALUES (?, ?, ?) ON CONFLICT(question_id, attempt_id) DO NOTHING`
    ).bind(id, attemptId, correct ? 1 : 0),
    c.env.DB.prepare(
      `UPDATE questions
       SET correct_count = correct_count + CASE WHEN ? = 1 THEN 1 ELSE 0 END,
           wrong_count = wrong_count + CASE WHEN ? = 0 THEN 1 ELSE 0 END
       WHERE id = ? AND changes() = 1`
    ).bind(correct ? 1 : 0, correct ? 1 : 0, id),
  ]);
  const stored = await c.env.DB.prepare(
    "SELECT correct FROM question_attempts WHERE question_id = ? AND attempt_id = ?"
  ).bind(id, attemptId).first<{ correct: number }>();

  return c.json({
    correct: stored?.correct === 1,
    answer: displayAnswer(q.qtype, q.answer, q.choices),
    explanation: q.explanation,
  });
});

// ── DELETE /api/questions/:id ────────────────────────────────────────────────
quizRoutes.delete("/questions/:id", async (c) => {
  const id = c.req.param("id");
  const question = await c.env.DB.prepare("SELECT book_id FROM questions WHERE id = ?")
    .bind(id).first<{ book_id: number | null }>();
  const bookId = question?.book_id;
  if (bookId && (activeSolutionBooks.has(bookId) || activeBookMutations.has(bookId))) {
    return c.json({ error: "문제집 작업이 끝난 뒤 문제를 삭제해 주세요" }, 409);
  }
  if (bookId) activeBookMutations.add(bookId);
  try {
    await c.env.DB.prepare("DELETE FROM questions WHERE id = ?").bind(id).run();
    return c.json({ ok: true });
  } finally {
    if (bookId) activeBookMutations.delete(bookId);
  }
});

// ── 채점 로직 ────────────────────────────────────────────────────────────────
function normalizeOx(s: string): string {
  const v = s.trim().toLowerCase();
  if (["o", "맞다", "참", "true", "yes", "1"].includes(v)) return "o";
  if (["x", "틀리다", "거짓", "false", "no", "0"].includes(v)) return "x";
  return v;
}

const normalizeChoice = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const stripChoiceMarker = (s: string) =>
  s.replace(/^\s*(?:[①②③④⑤⑥⑦⑧⑨⑩]|\d{1,2}[.)])\s*/, "");

function parseChoices(choicesJson: string | null): string[] {
  if (!choicesJson) return [];
  try {
    const parsed: unknown = JSON.parse(choicesJson);
    return Array.isArray(parsed) && parsed.every((choice) => typeof choice === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function answerIndex(answer: string, choiceCount: number): number | null {
  const trimmed = answer.trim();
  const circled = "①②③④⑤⑥⑦⑧⑨⑩".indexOf(trimmed[0] ?? "");
  if (circled >= 0 && circled < choiceCount) return circled;
  const labeled = /^(\d{1,2})[.)](?!\d)/.exec(trimmed);
  if (labeled) {
    const n = Number(labeled[1]);
    if (n >= 1 && n <= choiceCount) return n - 1;
  }
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= 1 && n <= choiceCount ? n - 1 : null;
}

function displayAnswer(qtype: string, answer: string, choicesJson: string | null): string {
  if (qtype !== "mcq") return answer;
  const choices = parseChoices(choicesJson);
  if (choices.length === 0) return answer;
  const normalized = normalizeChoice(answer);
  const exact = choices.find((choice) => normalizeChoice(choice) === normalized);
  if (exact !== undefined) return exact;
  const stripped = normalizeChoice(stripChoiceMarker(answer));
  const textMatches = choices.filter(
    (choice) => normalizeChoice(stripChoiceMarker(choice)) === stripped
  );
  if (textMatches.length === 1) return textMatches[0];
  const index = answerIndex(answer, choices.length);
  return index === null ? answer : choices[index];
}

export function gradeAnswer(
  qtype: string,
  correctAnswer: string,
  userAnswer: string,
  choicesJson: string | null
): boolean {
  const normalize = normalizeChoice;

  if (qtype === "ox") {
    return normalizeOx(correctAnswer) === normalizeOx(userAnswer);
  }

  if (qtype === "mcq" && choicesJson) {
    const choices = parseChoices(choicesJson);
    if (choices.length === 0) return normalize(correctAnswer) === normalize(userAnswer);
    const normalizedUser = normalize(userAnswer);
    const normalizedCorrect = normalize(correctAnswer);

    // 직접 텍스트 일치가 최우선 — 보기가 숫자 문자열일 때 인덱스 해석과 충돌하지 않도록.
    if (normalizedUser === normalizedCorrect) return true;
    // AI가 정답에는 보기 본문만, choices에는 ①~⑤/"1." 접두사를 넣는 흔한 형식도 허용한다.
    if (normalize(stripChoiceMarker(userAnswer)) === normalize(stripChoiceMarker(correctAnswer))) return true;

    // 자동 추출은 정답 ③을 저장 시 3으로 정규화한다. UI는 숫자가 아니라 선택지 전체
    // 텍스트("③ z")를 보내므로, 정답 인덱스를 실제 선택지로 되돌려 비교한다.
    const correctIdx = answerIndex(correctAnswer, choices.length);
    if (correctIdx !== null) {
      const target = choices[correctIdx];
      if (
        normalizedUser === normalize(target) ||
        normalize(stripChoiceMarker(userAnswer)) === normalize(stripChoiceMarker(target))
      ) return true;
    }

    // 1-based 인덱스 숫자 허용 (예: "1", "2" 등)
    const userIdx = answerIndex(userAnswer, choices.length);
    if (userIdx !== null) {
      if (correctIdx !== null) return userIdx === correctIdx;
      return (
        normalize(choices[userIdx]) === normalizedCorrect ||
        normalize(stripChoiceMarker(choices[userIdx])) === normalize(stripChoiceMarker(correctAnswer))
      );
    }
    return false;
  }

  // short: trim + 소문자 + 공백 정규화
  return normalize(correctAnswer) === normalize(userAnswer);
}
