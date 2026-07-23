import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { makeEnv, call, pauseNextUsageIncrement } from "./helpers";
import { isUsageLimitText } from "../src/claude";
import {
  detectImageMime,
  clearBookExtractionCache,
  ingestBookFile,
  MAX_AUTO_BOOK_RETRIES,
  retryPendingToBook,
  startMaterialToBook,
} from "../src/books";
import { DAILY_LIMIT } from "../src/usage";
import { validateUpload } from "../src/upload";
import { PDFDocument } from "pdf-lib";

// 추출 모킹 상태 (vi.mock은 호이스팅되므로 vi.hoisted 사용)
const mockState = vi.hoisted(() => ({
  delay: 0,
  materialDelay: 0,
  failProblems: false,
  failProblemCall: null as number | null,
  failProblemSliceBase: null as number | null,
  failProblemContentPageCount: null as number | null,
  changedAnswerMode: false,
  problemNumberOffset: 0,
  failProblemProviderCode: null as "auth" | "invalid_config" | "invalid_file" | "file_too_large" | "rate_limit" | null,
  boundaryVariantMode: false,
  outerBoundaryVariantMode: false,
  failMap: false,
  problemCalls: 0,
  materialCalls: 0,
  answerDetectionCalls: 0,
  detailedSolutionDetectionCalls: 0,
  detailedSolutionPages: null as number[] | null,
  solutionCalls: 0,
  solutionDelay: 0,
  solutionBoundaryMode: false,
  failSolutionSliceBaseOnce: null as number | null,
  failedSolutionSliceBases: new Set<number>(),
  solutionInputs: [] as { sliceBase: number; contentPageCount: number }[],
  solutions: [
    { number: "①", answer: "3", explanation: "공식 해설 1", page: 1, complete: true as const },
    { number: "２번", answer: "o", explanation: "공식 해설 2", page: 1, complete: true as const },
    { number: "문제 3.", answer: "3", explanation: "공식 해설 3", page: 1, complete: true as const },
  ],
  lastProblemSignal: null as AbortSignal | null,
  lastSolutionSignal: null as AbortSignal | null,
  problemInputs: [] as { sliceBase: number; pageCount: number; contentPageCount: number; answerKeyPages: number[] }[],
  sections: [] as { part: string; from: number; to: number }[],
}));

// AI 호출 모킹 — 파일에서 '모든 문제'를 뽑아 정답까지 채운 결과(QuizItemEx)를 반환한다.
vi.mock("../src/claude", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/claude")>();
  const { AIProviderError } = await import("../src/codex-provider");
  return {
  ...original,
  extractFromFile: async () => {
    mockState.materialCalls++;
    if (mockState.materialDelay) await new Promise((resolve) => setTimeout(resolve, mockState.materialDelay));
    return "추출된 텍스트 (모킹)";
  },
  mapSections: async () => {
    if (mockState.failMap) throw new Error("파트 지도 실패");
    return mockState.sections;
  },
  detectAnswerKeyPagesFromFile: async (path: string, sliceBase: number) => {
    mockState.answerDetectionCalls++;
    const pdf = await PDFDocument.load(readFileSync(path));
    const last = sliceBase + pdf.getPageCount() - 1;
    return last > sliceBase ? [last - 1, last] : [last];
  },
  detectDetailedSolutionPagesFromFile: async (path: string, sliceBase: number) => {
    mockState.detailedSolutionDetectionCalls++;
    const pdf = await PDFDocument.load(readFileSync(path));
    const last = sliceBase + pdf.getPageCount() - 1;
    const pages = mockState.detailedSolutionPages
      ?? Array.from({ length: last - sliceBase + 1 }, (_, index) => sliceBase + index);
    return pages.filter((page) => page >= sliceBase && page <= last);
  },
  extractSolutionsFromFile: async (
    _path: string,
    _kind: string,
    opts?: { signal?: AbortSignal; sliceBase?: number; contentPageCount?: number }
  ) => {
    mockState.solutionCalls++;
    mockState.lastSolutionSignal = opts?.signal ?? null;
    if (opts?.sliceBase !== undefined) {
      mockState.solutionInputs.push({
        sliceBase: opts.sliceBase,
        contentPageCount: opts.contentPageCount ?? 0,
      });
    }
    if (mockState.solutionDelay) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, mockState.solutionDelay);
        opts?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("사용자 중단"));
        }, { once: true });
      });
    }
    if (
      opts?.sliceBase === mockState.failSolutionSliceBaseOnce
      && !mockState.failedSolutionSliceBases.has(opts.sliceBase)
    ) {
      mockState.failedSolutionSliceBases.add(opts.sliceBase);
      throw new original.ProblemChunkValidationError("해설 청크 구조 오류");
    }
    if (mockState.solutionBoundaryMode) {
      if (opts?.sliceBase === 1) return [
        { number: "1", answer: "3", explanation: "경계 해설 1", page: 1, complete: true as const },
        { number: "2", answer: "o", explanation: "lookahead로 완성한 해설", page: 4, complete: true as const },
        { number: "3", answer: "3", explanation: "다음 청크 소유", page: 5, complete: true as const },
      ];
      if (opts?.sliceBase === 5) return [
        { number: "3", answer: "3", explanation: "경계 해설 3", page: 5, complete: true as const },
      ];
    }
    return mockState.solutions;
  },
  extractProblemsFromFile: async (
    path: string,
    kind: string,
    opts?: { signal?: AbortSignal; sliceBase?: number; contentPageCount?: number; answerKeyPages?: number[] }
  ) => {
    mockState.problemCalls++;
    const currentCall = mockState.problemCalls;
    mockState.lastProblemSignal = opts?.signal ?? null;
    if (kind === "pdf") {
      const pdf = await PDFDocument.load(readFileSync(path));
      mockState.problemInputs.push({
        sliceBase: opts?.sliceBase ?? 1,
        pageCount: pdf.getPageCount(),
        contentPageCount: opts?.contentPageCount ?? pdf.getPageCount(),
        answerKeyPages: opts?.answerKeyPages ?? [],
      });
    }
    if (mockState.delay > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, mockState.delay);
        opts?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("사용자 중단"));
        }, { once: true });
      });
    }
    if (
      mockState.failProblems
      || mockState.failProblemCall === currentCall
      || mockState.failProblemSliceBase === opts?.sliceBase
    ) throw new Error("영구 파싱 실패");
    if (mockState.failProblemProviderCode) {
      throw new AIProviderError(mockState.failProblemProviderCode, "provider failure");
    }
    if (mockState.failProblemContentPageCount === opts?.contentPageCount) {
      throw new original.ProblemChunkValidationError("항목 13: mcq choices는 2개 이상의 문자열 배열이어야 합니다.");
    }
    if (mockState.boundaryVariantMode && opts?.contentPageCount === 10) {
      return [{ qtype: "short", difficulty: "중", question: "경계 앞쪽 문구", choices: null, answer: "1", explanation: "", page: 10, figure: false, figure_description: null, box: null }];
    }
    if (mockState.boundaryVariantMode && opts?.contentPageCount === 11) {
      return [{ qtype: "short", difficulty: "중", question: "경계 뒤쪽 문구", choices: null, answer: "1", explanation: "", page: 10, figure: false, figure_description: null, box: null }];
    }
    if (mockState.outerBoundaryVariantMode && opts?.sliceBase === 1) {
      return [{ qtype: "short", difficulty: "중", question: "앞 청크가 다르게 읽은 경계 문항", choices: null, answer: "1", explanation: "", page: 20, figure: false, figure_description: null, box: null }];
    }
    if (mockState.outerBoundaryVariantMode && opts?.sliceBase === 20) {
      return [{ qtype: "short", difficulty: "중", question: "뒤 청크가 온전히 읽은 경계 문항", choices: null, answer: "1", explanation: "", page: 20, figure: false, figure_description: null, box: null }];
    }
    const suffix = opts?.sliceBase ? ` ${opts.sliceBase}` : "";
    return [
      { number: String(mockState.problemNumberOffset + 1), qtype: "short", difficulty: "중", question: `y=2(x-3)^2+5 의 꼭짓점은?${suffix}`, choices: null, answer: mockState.changedAnswerMode ? "②" : "③", explanation: mockState.changedAnswerMode ? "" : "꼭짓점은 (3,5).", page: 2, figure: true, figure_description: "x축과 y축이 있는 좌표평면에 꼭짓점 (3, 5)인 위로 열린 포물선이 표시되어 있다.", box: [0.2, 0.5] },
      { number: String(mockState.problemNumberOffset + 2), qtype: "ox", difficulty: "하", question: `a>0 이면 포물선은 위로 열린다.${suffix}`, choices: null, answer: "o", explanation: "", page: 2, figure: false, figure_description: null, box: null },
      { number: String(mockState.problemNumberOffset + 3), qtype: "mcq", difficulty: "상", question: `다음 중 옳은 것은?${suffix}`, choices: ["①x", "②y", "③z"], answer: "③", explanation: "z가 옳다.", page: 3, figure: false, figure_description: null, box: null },
    ];
  },
  };
});

const env = makeEnv();
let cookie: string;
let subjectId: number;
let bookId: number;
let fileId: number;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
let pngNonce = 0;

function pngBytes(nonce = ++pngNonce): Uint8Array<ArrayBuffer> {
  return new Uint8Array([...PNG_SIGNATURE, nonce & 0xff, (nonce >>> 8) & 0xff]);
}

function png(name = "쎈 수학(상).png", bytes = pngBytes()): File {
  return new File([bytes], name, { type: "image/png" });
}

describe("detectImageMime", () => {
  it.each([
    ["PNG", new Uint8Array(PNG_SIGNATURE), "image/png"],
    ["JPEG", new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
    ["WebP", new TextEncoder().encode("RIFF1234WEBP"), "image/webp"],
    ["GIF87a", new TextEncoder().encode("GIF87a"), "image/gif"],
    ["GIF89a", new TextEncoder().encode("GIF89a"), "image/gif"],
  ])("%s magic bytes를 원래 MIME으로 보존", (_label, bytes, expected) => {
    expect(detectImageMime(bytes)).toBe(expected);
  });
});

async function getBooks(): Promise<any[]> {
  const res = await call(env, `/api/subjects/${subjectId}/books`, { headers: { cookie } });
  return (await res.json()) as any[];
}

// 백그라운드 추출 완료 대기
async function waitReady(id: number): Promise<any> {
  for (let i = 0; i < 200; i++) {
    const books = await getBooks();
    const b = books.find((x) => x.id === id);
    if (b && b.files.length > 0 && b.files.every((f: any) => f.status !== "processing")) return b;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("백그라운드 처리 대기 시간 초과");
}

async function waitBookReady(id: number): Promise<any> {
  for (let i = 0; i < 200; i++) {
    const res = await call(env, `/api/books/${id}`, { headers: { cookie } });
    if (res.status === 200) {
      const book = await res.json() as any;
      if (book.files.length > 0 && book.files.every((file: any) => file.status !== "processing")) return book;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("문제집 처리 대기 시간 초과");
}

beforeAll(async () => {
  const login = await call(env, "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-password" }),
  });
  cookie = login.headers.get("set-cookie")!.split(";")[0];

  const res = await call(env, "/api/subjects", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "수학" }),
  });
  subjectId = ((await res.json()) as { id: number }).id;
});

async function questionsOf(bid: number): Promise<any[]> {
  const res = await call(env, `/api/subjects/${subjectId}/questions`, { headers: { cookie } });
  return ((await res.json()) as any[]).filter((q) => q.book_id === bid);
}

async function waitAIJob(id: number): Promise<any> {
  for (let i = 0; i < 200; i++) {
    const res = await call(env, `/api/ai-jobs/${id}`, { headers: { cookie } });
    const job = await res.json() as any;
    if (job.status !== "processing") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("AI 작업 대기 시간 초과");
}

describe("문제 추출 라우트 (파일 → questions 직행)", () => {
  it("업로드 → 즉시 응답(processing) → 백그라운드로 모든 문제를 등록", async () => {
    const fd = new FormData();
    fd.append("title", "쎈 수학(상)");
    fd.append("file", png());
    const res = await call(env, `/api/subjects/${subjectId}/books`, { method: "POST", headers: { cookie }, body: fd });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number; files: number[]; status: string };
    expect(body.status).toBe("processing");
    bookId = body.id;
    fileId = body.files[0];

    const book = await waitReady(bookId);
    expect(book.files[0].status).toBe("ready");
    expect((await questionsOf(bookId)).length).toBe(3); // 모든 문제 등록(정답 포함)

    const evidence = await env.DB.prepare(
      "SELECT name, mime, content_hash, page_count FROM book_files WHERE id = ?"
    ).bind(fileId).first<{ name: string; mime: string; content_hash: string; page_count: number }>();
    expect(evidence).toMatchObject({ name: "쎈 수학(상).png", mime: "image/png", page_count: 1 });
    expect(evidence?.content_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("등록된 문제: 정답 정규화(③→3)·보기·그림·원본 페이지 전파", async () => {
    const qs = await questionsOf(bookId);
    const mcq = qs.find((q) => q.qtype === "mcq");
    expect(mcq.answer).toBe("3"); // ③ → 3
    expect(mcq.choices.length).toBe(3);
    const fig = qs.find((q) => q.has_figure === 1);
    expect(fig).toBeTruthy();
    expect(fig.src_page).toBe(2);
    expect(fig.src_file_id).toBe(fileId);
    expect(fig.figure_box).toBe("0.2,0.5");
    expect(fig.figure_description).toContain("좌표평면");
    // 퀴즈 플레이에도 그림 전파
    const quiz = (await (await call(env, `/api/subjects/${subjectId}/quiz?count=50`, { headers: { cookie } })).json()) as any[];
    expect(quiz.some((q) => q.has_figure === true && q.figure_description.includes("좌표평면"))).toBe(true);
  });

  it("추출한 실제 인쇄 번호를 합성 배열 순번 대신 저장", async () => {
    mockState.problemNumberOffset = 10;
    try {
      const fd = new FormData();
      fd.append("title", `인쇄 번호 ${Date.now()}`);
      fd.append("file", png("인쇄-번호.png", pngBytes(713)));
      const res = await call(env, `/api/subjects/${subjectId}/books`, {
        method: "POST",
        headers: { cookie },
        body: fd,
      });
      const target = await res.json() as { id: number };
      await waitReady(target.id);
      expect((await questionsOf(target.id)).map((question) => ({
        book: question.book_number,
        printed: question.printed_number,
      }))).toEqual([
        { book: "11", printed: "11" },
        { book: "12", printed: "12" },
        { book: "13", printed: "13" },
      ]);
      await call(env, `/api/books/${target.id}`, { method: "DELETE", headers: { cookie } });
    } finally {
      mockState.problemNumberOffset = 0;
    }
  });

  it("선택한 기존 문제집에 공식 해설만 원자적으로 추가", async () => {
    const before = await questionsOf(bookId);
    await env.DB.prepare(
      "UPDATE questions SET correct_count = 4, wrong_count = 2 WHERE id = ?"
    ).bind(before[1].id).run();
    const fd = new FormData();
    fd.append("file", png("쎈 수학(상) 해설.png", pngBytes(720)));
    const res = await call(env, `/api/subjects/${subjectId}/books/${bookId}/explanations`, {
      method: "POST",
      headers: { cookie },
      body: fd,
    });
    expect(res.status).toBe(202);
    const { jobId } = await res.json() as { jobId: number };
    const job = await waitAIJob(jobId);
    expect(job).toMatchObject({ status: "ready", result: { updated: 1, bookId } });

    const after = await questionsOf(bookId);
    expect(after.map((question) => question.id)).toEqual(before.map((question) => question.id));
    expect(after[1]).toMatchObject({
      answer: before[1].answer,
      explanation: "공식 해설 2",
      correct_count: 4,
      wrong_count: 2,
      src_file_id: before[1].src_file_id,
      src_page: before[1].src_page,
    });
    const listed = (await getBooks()).find((book) => book.id === bookId);
    expect(listed).toMatchObject({ question_count: 3, explained_count: 3 });
  });

  it("단원마다 번호가 다시 시작하면 원문 순서·번호·정답을 전부 확인해 원자 연결", async () => {
    const upload = new FormData();
    upload.append("title", `반복 번호 해설 ${Date.now()}`);
    upload.append("file", png("반복-번호-문제.png", pngBytes(725)));
    const uploaded = await call(env, `/api/subjects/${subjectId}/books`, {
      method: "POST",
      headers: { cookie },
      body: upload,
    });
    const target = await uploaded.json() as { id: number };
    await waitReady(target.id);
    const questions = (await questionsOf(target.id)).sort((a, b) => a.id - b.id);
    await env.DB.batch(questions.map((question, index) => env.DB.prepare(
      "UPDATE questions SET printed_number = ?, src_page = ?, explanation = '' WHERE id = ?"
    ).bind(["1", "2", "1"][index], index + 1, question.id)));

    try {
      mockState.solutions = [
        { number: "1", answer: "3", explanation: "다음 단원 1번 풀이", page: 3, complete: true },
        { number: "1", answer: "3", explanation: "첫 단원 1번 풀이", page: 1, complete: true },
        { number: "2", answer: "o", explanation: "첫 단원 2번 풀이", page: 2, complete: true },
      ];
      const success = new FormData();
      success.append("file", png("반복-번호-해설.png", pngBytes(726)));
      const accepted = await call(env, `/api/subjects/${subjectId}/books/${target.id}/explanations`, {
        method: "POST",
        headers: { cookie },
        body: success,
      });
      expect(accepted.status).toBe(202);
      const { jobId } = await accepted.json() as { jobId: number };
      expect(await waitAIJob(jobId)).toMatchObject({
        status: "ready",
        result: { updated: 3, matched: 3 },
      });
      expect((await questionsOf(target.id)).sort((a, b) => a.id - b.id)
        .map((question) => question.explanation)).toEqual([
        "첫 단원 1번 풀이",
        "첫 단원 2번 풀이",
        "다음 단원 1번 풀이",
      ]);

      await env.DB.prepare("UPDATE questions SET explanation = '' WHERE book_id = ?").bind(target.id).run();
      mockState.solutions = [
        { number: "1", answer: "3", explanation: "저장되면 안 됨 1", page: 1, complete: true },
        { number: "1", answer: "o", explanation: "저장되면 안 됨 2", page: 2, complete: true },
        { number: "2", answer: "3", explanation: "저장되면 안 됨 3", page: 3, complete: true },
      ];
      const mismatch = new FormData();
      mismatch.append("file", png("반복-번호-순서-오류.png", pngBytes(727)));
      const rejected = await call(env, `/api/subjects/${subjectId}/books/${target.id}/explanations`, {
        method: "POST",
        headers: { cookie },
        body: mismatch,
      });
      const failedJob = await rejected.json() as { jobId: number };
      expect(await waitAIJob(failedJob.jobId)).toMatchObject({
        status: "error",
        error: expect.stringContaining("문제 번호 순서 불일치"),
      });
      expect((await questionsOf(target.id)).every((question) => question.explanation === "")).toBe(true);

      mockState.solutions = [
        { number: "1", answer: "3", explanation: "저장되면 안 됨 1", page: 1, complete: true },
        { number: "2", answer: "x", explanation: "저장되면 안 됨 2", page: 2, complete: true },
        { number: "1", answer: "3", explanation: "저장되면 안 됨 3", page: 3, complete: true },
      ];
      const wrongAnswer = new FormData();
      wrongAnswer.append("file", png("반복-번호-정답-오류.png", pngBytes(728)));
      const wrongAnswerAccepted = await call(env, `/api/subjects/${subjectId}/books/${target.id}/explanations`, {
        method: "POST",
        headers: { cookie },
        body: wrongAnswer,
      });
      const wrongAnswerJob = await wrongAnswerAccepted.json() as { jobId: number };
      expect(await waitAIJob(wrongAnswerJob.jobId)).toMatchObject({
        status: "error",
        error: expect.stringContaining("정답 불일치"),
      });
      expect((await questionsOf(target.id)).every((question) => question.explanation === "")).toBe(true);

      await env.DB.prepare("UPDATE questions SET src_page = 1 WHERE id = ?").bind(questions[2].id).run();
      const ambiguous = new FormData();
      ambiguous.append("file", png("반복-번호-위치-모호.png", pngBytes(729)));
      const blocked = await call(env, `/api/subjects/${subjectId}/books/${target.id}/explanations`, {
        method: "POST",
        headers: { cookie },
        body: ambiguous,
      });
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toEqual({
        error: "반복되는 문제 번호의 원본 페이지 순서를 확인할 수 없습니다",
      });
    } finally {
      mockState.solutions = [
        { number: "①", answer: "3", explanation: "공식 해설 1", page: 1, complete: true },
        { number: "２번", answer: "o", explanation: "공식 해설 2", page: 1, complete: true },
        { number: "문제 3.", answer: "3", explanation: "공식 해설 3", page: 1, complete: true },
      ];
      await call(env, `/api/books/${target.id}`, { method: "DELETE", headers: { cookie } });
    }
  });

  it("해설 분석 중인 문제집의 문항 삭제를 막아 스냅샷을 보존", async () => {
    const target = (await questionsOf(bookId))[0];
    let jobId: number | null = null;
    mockState.solutionDelay = 50;
    try {
      const fd = new FormData();
      fd.append("file", png("삭제-경합-해설.png", pngBytes(730)));
      const accepted = await call(env, `/api/subjects/${subjectId}/books/${bookId}/explanations`, {
        method: "POST",
        headers: { cookie },
        body: fd,
      });
      expect(accepted.status).toBe(202);
      jobId = ((await accepted.json()) as { jobId: number }).jobId;

      const blocked = await call(env, `/api/questions/${target.id}`, {
        method: "DELETE",
        headers: { cookie },
      });
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toEqual({
        error: "문제집 작업이 끝난 뒤 문제를 삭제해 주세요",
      });
      expect((await questionsOf(bookId)).some((question) => question.id === target.id)).toBe(true);
      expect(await waitAIJob(jobId)).toMatchObject({ status: "ready" });
    } finally {
      mockState.solutionDelay = 0;
      if (jobId !== null) await waitAIJob(jobId);
    }
  });

  it("정답-only 항목은 저장 수에 포함하지 않고 실제 해설만 채움", async () => {
    const upload = new FormData();
    upload.append("title", `정답-only 해설 ${Date.now()}`);
    upload.append("file", png("정답-only-문제.png", pngBytes(719)));
    const uploaded = await call(env, `/api/subjects/${subjectId}/books`, {
      method: "POST",
      headers: { cookie },
      body: upload,
    });
    const target = await uploaded.json() as { id: number };
    await waitReady(target.id);
    await env.DB.prepare("UPDATE questions SET explanation = '' WHERE book_id = ?").bind(target.id).run();

    mockState.solutions = [
      { number: "1", answer: "3", explanation: "", page: 1, complete: true },
      { number: "2", answer: "o", explanation: "공식 상세 풀이", page: 1, complete: true },
      { number: "3", answer: "3", explanation: "", page: 1, complete: true },
    ];
    try {
      const fd = new FormData();
      fd.append("file", png("정답-only-해설.png", pngBytes(718)));
      const res = await call(env, `/api/subjects/${subjectId}/books/${target.id}/explanations`, {
        method: "POST",
        headers: { cookie },
        body: fd,
      });
      const { jobId } = await res.json() as { jobId: number };
      expect(await waitAIJob(jobId)).toMatchObject({
        status: "ready",
        result: { updated: 1, matched: 3, answerOnly: 2 },
      });
      expect((await questionsOf(target.id)).map((question) => question.explanation)).toEqual([
        "",
        "공식 상세 풀이",
        "",
      ]);
    } finally {
      mockState.solutions = [
        { number: "①", answer: "3", explanation: "공식 해설 1", page: 1, complete: true },
        { number: "２번", answer: "o", explanation: "공식 해설 2", page: 1, complete: true },
        { number: "문제 3.", answer: "3", explanation: "공식 해설 3", page: 1, complete: true },
      ];
      await call(env, `/api/books/${target.id}`, { method: "DELETE", headers: { cookie } });
    }
  });

  it("정답-only 번호가 섞여도 번호 기준으로 밀림 없이 실제 해설만 연결", async () => {
    const upload = new FormData();
    upload.append("title", `부분 해설 ${Date.now()}`);
    upload.append("file", png("부분-해설-문제.png", pngBytes(717)));
    const uploaded = await call(env, `/api/subjects/${subjectId}/books`, {
      method: "POST",
      headers: { cookie },
      body: upload,
    });
    const target = await uploaded.json() as { id: number };
    await waitReady(target.id);
    await env.DB.prepare("UPDATE questions SET explanation = '' WHERE book_id = ?").bind(target.id).run();

    mockState.solutions = [
      { number: "3", answer: "3", explanation: "3번 상세 풀이", page: 1, complete: true },
      { number: "1", answer: "3", explanation: "", page: 1, complete: true },
      { number: "2", answer: "o", explanation: "2번 상세 풀이", page: 1, complete: true },
    ];
    try {
      const fd = new FormData();
      fd.append("file", png("부분-해설.png", pngBytes(716)));
      const res = await call(env, `/api/subjects/${subjectId}/books/${target.id}/explanations`, {
        method: "POST",
        headers: { cookie },
        body: fd,
      });
      const { jobId } = await res.json() as { jobId: number };
      expect(await waitAIJob(jobId)).toMatchObject({
        status: "ready",
        result: { updated: 2, matched: 3, answerOnly: 1 },
      });
      expect((await questionsOf(target.id)).map((question) => question.explanation)).toEqual([
        "",
        "2번 상세 풀이",
        "3번 상세 풀이",
      ]);
    } finally {
      mockState.solutions = [
        { number: "①", answer: "3", explanation: "공식 해설 1", page: 1, complete: true },
        { number: "２번", answer: "o", explanation: "공식 해설 2", page: 1, complete: true },
        { number: "문제 3.", answer: "3", explanation: "공식 해설 3", page: 1, complete: true },
      ];
      await call(env, `/api/books/${target.id}`, { method: "DELETE", headers: { cookie } });
    }
  });

  it("일부 번호·정답만 맞는 불완전 파일은 해설로 연결하지 않음", async () => {
    const before = (await questionsOf(bookId)).map((question) => question.explanation);
    mockState.solutions = [
      { number: "2", answer: "o", explanation: "다른 책에서 우연히 맞은 풀이", page: 1, complete: true },
    ];
    try {
      const fd = new FormData();
      fd.append("file", png("부분-오탐-해설.png", pngBytes(714)));
      const res = await call(env, `/api/subjects/${subjectId}/books/${bookId}/explanations`, {
        method: "POST",
        headers: { cookie },
        body: fd,
      });
      const { jobId } = await res.json() as { jobId: number };
      expect(await waitAIJob(jobId)).toMatchObject({
        status: "error",
        error: expect.stringContaining("문항 수 불일치"),
      });
      expect((await questionsOf(bookId)).map((question) => question.explanation)).toEqual(before);
    } finally {
      mockState.solutions = [
        { number: "①", answer: "3", explanation: "공식 해설 1", page: 1, complete: true },
        { number: "２번", answer: "o", explanation: "공식 해설 2", page: 1, complete: true },
        { number: "문제 3.", answer: "3", explanation: "공식 해설 3", page: 1, complete: true },
      ];
    }
  });

  it("과거 합성 순번은 인쇄 번호 provenance로 신뢰하지 않음", async () => {
    await env.DB.prepare("UPDATE questions SET printed_number = NULL WHERE book_id = ?").bind(bookId).run();
    try {
      const fd = new FormData();
      fd.append("file", png("합성-순번-해설.png", pngBytes(712)));
      const res = await call(env, `/api/subjects/${subjectId}/books/${bookId}/explanations`, {
        method: "POST",
        headers: { cookie },
        body: fd,
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "문제 원본을 재추출해 실제 인쇄 번호를 확인한 뒤 해설을 추가해 주세요",
      });
    } finally {
      await env.DB.prepare(
        "UPDATE questions SET printed_number = book_number WHERE book_id = ?"
      ).bind(bookId).run();
    }
  });

  it("해설 수나 정답 순서가 다르면 기존 해설을 하나도 바꾸지 않음", async () => {
    const before = (await questionsOf(bookId)).map((question) => question.explanation);
    mockState.solutions = [
      { number: "1", answer: "3", explanation: "바뀌면 안 됨 1", page: 1, complete: true },
      { number: "2", answer: "x", explanation: "바뀌면 안 됨 2", page: 1, complete: true },
      { number: "3", answer: "3", explanation: "바뀌면 안 됨 3", page: 1, complete: true },
    ];
    try {
      const fd = new FormData();
      fd.append("file", png("다른 책 해설.png", pngBytes(721)));
      const res = await call(env, `/api/subjects/${subjectId}/books/${bookId}/explanations`, {
        method: "POST",
        headers: { cookie },
        body: fd,
      });
      expect(res.status).toBe(202);
      const { jobId } = await res.json() as { jobId: number };
      expect(await waitAIJob(jobId)).toMatchObject({ status: "error" });
      expect((await questionsOf(bookId)).map((question) => question.explanation)).toEqual(before);
    } finally {
      mockState.solutions = [
        { number: "①", answer: "3", explanation: "공식 해설 1", page: 1, complete: true },
        { number: "２번", answer: "o", explanation: "공식 해설 2", page: 1, complete: true },
        { number: "문제 3.", answer: "3", explanation: "공식 해설 3", page: 1, complete: true },
      ];
    }
  });

  it("정답이 같아도 인쇄 번호 순서가 다르면 해설을 연결하지 않음", async () => {
    const before = (await questionsOf(bookId)).map((question) => question.explanation);
    mockState.solutions = [
      { number: "1", answer: "3", explanation: "번호 검증 1", page: 1, complete: true },
      { number: "3", answer: "o", explanation: "번호 검증 2", page: 1, complete: true },
      { number: "2", answer: "3", explanation: "번호 검증 3", page: 1, complete: true },
    ];
    try {
      const fd = new FormData();
      fd.append("file", png("번호가 뒤바뀐 해설.png", pngBytes(723)));
      const res = await call(env, `/api/subjects/${subjectId}/books/${bookId}/explanations`, {
        method: "POST",
        headers: { cookie },
        body: fd,
      });
      expect(res.status).toBe(202);
      const { jobId } = await res.json() as { jobId: number };
      expect(await waitAIJob(jobId)).toMatchObject({ status: "error" });
      expect((await questionsOf(bookId)).map((question) => question.explanation)).toEqual(before);
    } finally {
      mockState.solutions = [
        { number: "①", answer: "3", explanation: "공식 해설 1", page: 1, complete: true },
        { number: "２번", answer: "o", explanation: "공식 해설 2", page: 1, complete: true },
        { number: "문제 3.", answer: "3", explanation: "공식 해설 3", page: 1, complete: true },
      ];
    }
  });

  it("PDF 해설은 4쪽 소유+2쪽 lookahead로 경계를 완성하고 실패 청크만 한 번 재시도", async () => {
    const upload = new FormData();
    upload.append("title", `경계 해설 대상 ${Date.now()}`);
    upload.append("file", png("경계-문제.png", pngBytes(724)));
    const uploaded = await call(env, `/api/subjects/${subjectId}/books`, {
      method: "POST",
      headers: { cookie },
      body: upload,
    });
    const target = await uploaded.json() as { id: number };
    await waitReady(target.id);

    const pdf = await PDFDocument.create();
    for (let page = 0; page < 10; page++) pdf.addPage([100, 100]);
    const bytes = await pdf.save();
    mockState.solutionBoundaryMode = true;
    mockState.failSolutionSliceBaseOnce = 5;
    mockState.failedSolutionSliceBases.clear();
    mockState.solutionInputs = [];
    try {
      const fd = new FormData();
      fd.append("file", new File([new Uint8Array(bytes).buffer], "경계-해설.pdf", { type: "application/pdf" }));
      const res = await call(env, `/api/subjects/${subjectId}/books/${target.id}/explanations`, {
        method: "POST",
        headers: { cookie },
        body: fd,
      });
      expect(res.status).toBe(202);
      const { jobId } = await res.json() as { jobId: number };
      expect(await waitAIJob(jobId)).toMatchObject({ status: "ready", result: { updated: 1 } });

      const questions = await questionsOf(target.id);
      expect(questions[1].explanation).toBe("lookahead로 완성한 해설");
      expect(mockState.solutionInputs).toEqual(expect.arrayContaining([
        { sliceBase: 1, contentPageCount: 6 },
        { sliceBase: 5, contentPageCount: 6 },
      ]));
      expect(mockState.solutionInputs.filter((input) => input.sliceBase === 5)).toHaveLength(2);
    } finally {
      mockState.solutionBoundaryMode = false;
      mockState.failSolutionSliceBaseOnce = null;
      mockState.failedSolutionSliceBases.clear();
      mockState.solutionInputs = [];
      await call(env, `/api/books/${target.id}`, { method: "DELETE", headers: { cookie } });
    }
  });

  it("문제+해설 합본 PDF는 실제 상세 해설이 있는 뒤쪽 구간만 분석", async () => {
    const upload = new FormData();
    upload.append("title", `합본 해설 대상 ${Date.now()}`);
    upload.append("file", png("합본-문제.png", pngBytes(715)));
    const uploaded = await call(env, `/api/subjects/${subjectId}/books`, {
      method: "POST",
      headers: { cookie },
      body: upload,
    });
    const target = await uploaded.json() as { id: number };
    await waitReady(target.id);

    const pdf = await PDFDocument.create();
    for (let page = 0; page < 30; page++) pdf.addPage([100, 100]);
    const bytes = await pdf.save();
    mockState.detailedSolutionPages = [25, 26, 27, 28, 29, 30];
    mockState.solutionInputs = [];
    try {
      const fd = new FormData();
      fd.append("file", new File([new Uint8Array(bytes).buffer], "문제와-해설-합본.pdf", { type: "application/pdf" }));
      const res = await call(env, `/api/subjects/${subjectId}/books/${target.id}/explanations`, {
        method: "POST",
        headers: { cookie },
        body: fd,
      });
      const { jobId } = await res.json() as { jobId: number };
      expect(await waitAIJob(jobId)).toMatchObject({ status: "ready" });
      expect(mockState.detailedSolutionDetectionCalls).toBeGreaterThan(0);
      expect(mockState.solutionInputs.every((input) => input.sliceBase >= 21)).toBe(true);
      expect(mockState.solutionInputs.map((input) => input.sliceBase)).toEqual([21, 25]);
    } finally {
      mockState.detailedSolutionPages = null;
      mockState.solutionInputs = [];
      await call(env, `/api/books/${target.id}`, { method: "DELETE", headers: { cookie } });
    }
  });

  it("상세 풀이가 없는 PDF는 해설 AI 추출 없이 파일명과 원인을 알림", async () => {
    const pdf = await PDFDocument.create();
    for (let page = 0; page < 10; page++) pdf.addPage([100, 100]);
    const bytes = await pdf.save();
    mockState.detailedSolutionPages = [];
    mockState.solutionCalls = 0;
    try {
      const fd = new FormData();
      fd.append("file", new File([new Uint8Array(bytes).buffer], "빠른정답만.pdf", { type: "application/pdf" }));
      const res = await call(env, `/api/subjects/${subjectId}/books/${bookId}/explanations`, {
        method: "POST",
        headers: { cookie },
        body: fd,
      });
      const { jobId } = await res.json() as { jobId: number };
      expect(await waitAIJob(jobId)).toMatchObject({
        status: "error",
        error: expect.stringContaining("빠른정답만.pdf: 상세 해설 페이지를 찾지 못했습니다"),
      });
      expect(mockState.solutionCalls).toBe(0);
    } finally {
      mockState.detailedSolutionPages = null;
      mockState.solutionCalls = 0;
    }
  });

  it("해설 병합과 자료 자동 재추출이 서로의 claim을 막음", async () => {
    const sourceKey = `test/solution-lock-${Date.now()}.png`;
    await env.FILES.put(sourceKey, pngBytes(725).buffer);
    const material = await env.DB.prepare(
      `INSERT INTO materials
         (subject_id, kind, title, r2_key, extracted_text, status, book_id, book_processing)
       VALUES (?, 'image', '해설 락 자료', ?, '문제 본문', 'ready', ?, 1) RETURNING id`
    ).bind(subjectId, sourceKey, bookId).first<{ id: number }>();
    try {
      const busyForm = new FormData();
      busyForm.append("file", png("재추출-진행중-해설.png", pngBytes(726)));
      const busy = await call(env, `/api/subjects/${subjectId}/books/${bookId}/explanations`, {
        method: "POST",
        headers: { cookie },
        body: busyForm,
      });
      expect(busy.status).toBe(409);

      await env.DB.prepare("UPDATE materials SET book_processing = 0 WHERE id = ?").bind(material!.id).run();
      mockState.solutionDelay = 80;
      const activeForm = new FormData();
      activeForm.append("file", png("해설-진행중.png", pngBytes(727)));
      const active = await call(env, `/api/subjects/${subjectId}/books/${bookId}/explanations`, {
        method: "POST",
        headers: { cookie },
        body: activeForm,
      });
      expect(active.status).toBe(202);
      const { jobId } = await active.json() as { jobId: number };
      await expect(startMaterialToBook(env, material!.id)).resolves.toMatchObject({ code: 409 });
      expect(await env.DB.prepare("SELECT book_processing FROM materials WHERE id = ?")
        .bind(material!.id).first()).toEqual({ book_processing: 0 });
      expect(await waitAIJob(jobId)).toMatchObject({ status: "ready" });
    } finally {
      mockState.solutionDelay = 0;
      await env.DB.prepare("DELETE FROM materials WHERE id = ?").bind(material!.id).run();
      await env.FILES.delete(sourceKey);
    }
  });

  it("기존 문제집 파일 추가와 해설 병합을 book 단위로 상호 배제", async () => {
    const title = `파일-해설-lock-${Date.now()}`;
    const initialForm = new FormData();
    initialForm.append("title", title);
    initialForm.append("file", png("lock-원본.png", pngBytes(730)));
    const initial = await call(env, `/api/subjects/${subjectId}/books`, {
      method: "POST",
      headers: { cookie },
      body: initialForm,
    });
    expect(initial.status).toBe(201);
    const target = await initial.json() as { id: number };
    await waitBookReady(target.id);

    const originalPut = env.FILES.put.bind(env.FILES);
    let releasePut!: () => void;
    let markPutEntered!: () => void;
    const putGate = new Promise<void>((resolve) => { releasePut = resolve; });
    const putEntered = new Promise<void>((resolve) => { markPutEntered = resolve; });
    let intercepted = false;
    let pendingMutation: Promise<Response> | null = null;
    try {
      mockState.solutionDelay = 80;
      mockState.lastSolutionSignal = null;
      const solutionForm = new FormData();
      solutionForm.append("file", png("lock-해설.png", pngBytes(731)));
      const solution = await call(env, `/api/subjects/${subjectId}/books/${target.id}/explanations`, {
        method: "POST",
        headers: { cookie },
        body: solutionForm,
      });
      expect(solution.status).toBe(202);
      const { jobId } = await solution.json() as { jobId: number };
      for (let i = 0; i < 50 && mockState.lastSolutionSignal === null; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const blockedFileForm = new FormData();
      blockedFileForm.append("title", title);
      blockedFileForm.append("file", png("해설중-추가.png", pngBytes(732)));
      expect((await call(env, `/api/subjects/${subjectId}/books`, {
        method: "POST",
        headers: { cookie },
        body: blockedFileForm,
      })).status).toBe(409);
      expect(await waitAIJob(jobId)).toMatchObject({ status: "ready" });
      mockState.solutionDelay = 0;

      env.FILES.put = async (key: string, data: ArrayBuffer) => {
        if (!intercepted && key.startsWith(`books/${subjectId}/`)) {
          intercepted = true;
          markPutEntered();
          await putGate;
        }
        await originalPut(key, data);
      };
      const mutationForm = new FormData();
      mutationForm.append("title", title);
      mutationForm.append("file", png("추가중-파일.png", pngBytes(733)));
      pendingMutation = call(env, `/api/subjects/${subjectId}/books`, {
        method: "POST",
        headers: { cookie },
        body: mutationForm,
      });
      await putEntered;

      const blockedSolutionForm = new FormData();
      blockedSolutionForm.append("file", png("파일추가중-해설.png", pngBytes(734)));
      expect((await call(env, `/api/subjects/${subjectId}/books/${target.id}/explanations`, {
        method: "POST",
        headers: { cookie },
        body: blockedSolutionForm,
      })).status).toBe(409);

      releasePut();
      expect((await pendingMutation).status).toBe(201);
      await waitBookReady(target.id);
    } finally {
      mockState.solutionDelay = 0;
      mockState.lastSolutionSignal = null;
      releasePut();
      env.FILES.put = originalPut;
      await pendingMutation?.catch(() => undefined);
      await call(env, `/api/books/${target.id}`, { method: "DELETE", headers: { cookie } });
    }
  });

  it("해설 lock은 질문과 AI ready 상태의 DB batch가 끝난 뒤 해제", async () => {
    const title = `해설-commit-lock-${Date.now()}`;
    const initialForm = new FormData();
    initialForm.append("title", title);
    initialForm.append("file", png("commit-원본.png", pngBytes(735)));
    const initial = await call(env, `/api/subjects/${subjectId}/books`, {
      method: "POST",
      headers: { cookie },
      body: initialForm,
    });
    expect(initial.status).toBe(201);
    const target = await initial.json() as { id: number };
    await waitBookReady(target.id);

    const originalBatch = env.DB.batch.bind(env.DB);
    let releaseBatch!: () => void;
    let markBatchEntered!: () => void;
    const batchGate = new Promise<void>((resolve) => { releaseBatch = resolve; });
    const batchEntered = new Promise<void>((resolve) => { markBatchEntered = resolve; });
    let intercepted = false;
    env.DB.batch = async (statements) => {
      if (!intercepted) {
        intercepted = true;
        markBatchEntered();
        await batchGate;
      }
      return originalBatch(statements);
    };
    try {
      const firstForm = new FormData();
      firstForm.append("file", png("commit-해설-1.png", pngBytes(736)));
      const first = await call(env, `/api/subjects/${subjectId}/books/${target.id}/explanations`, {
        method: "POST",
        headers: { cookie },
        body: firstForm,
      });
      expect(first.status).toBe(202);
      const { jobId } = await first.json() as { jobId: number };
      await batchEntered;

      const secondForm = new FormData();
      secondForm.append("file", png("commit-해설-2.png", pngBytes(737)));
      expect((await call(env, `/api/subjects/${subjectId}/books/${target.id}/explanations`, {
        method: "POST",
        headers: { cookie },
        body: secondForm,
      })).status).toBe(409);

      releaseBatch();
      expect(await waitAIJob(jobId)).toMatchObject({ status: "ready" });
    } finally {
      releaseBatch();
      env.DB.batch = originalBatch;
      await call(env, `/api/books/${target.id}`, { method: "DELETE", headers: { cookie } });
    }
  });

  it("과목 삭제는 진행 중인 해설 AI 작업도 취소", async () => {
    const subjectRes = await call(env, "/api/subjects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: `삭제 해설 ${Date.now()}` }),
    });
    const targetSubject = await subjectRes.json() as { id: number };
    const upload = new FormData();
    upload.append("title", "삭제 중 해설 문제집");
    upload.append("file", png("삭제-문제.png", pngBytes(728)));
    const uploaded = await call(env, `/api/subjects/${targetSubject.id}/books`, {
      method: "POST",
      headers: { cookie },
      body: upload,
    });
    const targetBook = await uploaded.json() as { id: number };
    await waitBookReady(targetBook.id);

    mockState.solutionDelay = 200;
    mockState.lastSolutionSignal = null;
    try {
      const fd = new FormData();
      fd.append("file", png("삭제-해설.png", pngBytes(729)));
      const started = await call(
        env,
        `/api/subjects/${targetSubject.id}/books/${targetBook.id}/explanations`,
        { method: "POST", headers: { cookie }, body: fd }
      );
      expect(started.status).toBe(202);
      for (let i = 0; i < 50 && mockState.lastSolutionSignal === null; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(mockState.lastSolutionSignal).not.toBeNull();

      const deleted = await call(env, `/api/subjects/${targetSubject.id}`, {
        method: "DELETE",
        headers: { cookie },
      });
      expect(deleted.status).toBe(200);
      expect((mockState.lastSolutionSignal as AbortSignal | null)?.aborted).toBe(true);
    } finally {
      mockState.solutionDelay = 0;
      mockState.lastSolutionSignal = null;
    }
  });

  it("문제 재추출 뒤에도 업로드한 공식 해설을 보존", async () => {
    const res = await call(env, `/api/book-files/${fileId}/retry`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    await waitReady(bookId);
    expect((await questionsOf(bookId))[1].explanation).toBe("공식 해설 2");
  });

  it("다른 과목 경로에서는 선택한 문제집을 찾지 않음", async () => {
    const fd = new FormData();
    fd.append("file", png("해설.png", pngBytes(722)));
    const res = await call(env, `/api/subjects/${subjectId + 999}/books/${bookId}/explanations`, {
      method: "POST",
      headers: { cookie },
      body: fd,
    });
    expect(res.status).toBe(404);
  });

  it("원본 파일 서빙", async () => {
    const res = await call(env, `/api/book-files/${fileId}/file`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect((await res.arrayBuffer()).byteLength).toBe(10);
  });

  it("file 없이 업로드하면 400", async () => {
    const fd = new FormData();
    fd.append("title", "빈 업로드");
    const res = await call(env, `/api/subjects/${subjectId}/books`, { method: "POST", headers: { cookie }, body: fd });
    expect(res.status).toBe(400);
  });

  it("브라우저 MIME·경로형 파일명을 신뢰하지 않고 실제 바이트와 안전한 이름을 저장", async () => {
    const fd = new FormData();
    fd.append("title", "위장 업로드");
    fd.append("file", new File([pngBytes(700)], "../위장.jpg", { type: "text/plain" }));
    const res = await call(env, `/api/subjects/${subjectId}/books`, {
      method: "POST",
      headers: { cookie },
      body: fd,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number; files: number[] };
    await waitReady(body.id);

    const saved = await env.DB.prepare(
      "SELECT name, mime, page_count FROM book_files WHERE id = ?"
    ).bind(body.files[0]).first<{ name: string; mime: string; page_count: number }>();
    expect(saved).toEqual({ name: "위장.jpg", mime: "image/png", page_count: 1 });
  });

  it("동시 동일 제목 업로드를 한 문제집의 두 파일로 원자 합류", async () => {
    const title = `동시 합류 ${Date.now()}`;
    const first = await validateUpload(png("동시-1.png", pngBytes(710)));
    const second = await validateUpload(png("동시-2.png", pngBytes(711)));
    if ("error" in first || "error" in second) throw new Error("테스트 업로드 검증 실패");

    const uploaded = await Promise.all([
      ingestBookFile(env, subjectId, title, first),
      ingestBookFile(env, subjectId, title, second),
    ]);
    expect(new Set(uploaded.map((item) => item.bookId)).size).toBe(1);
    await waitReady(uploaded[0].bookId);
    const books = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM books WHERE subject_id = ? AND title = ?"
    ).bind(subjectId, title).first<{ n: number }>();
    const files = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM book_files WHERE book_id = ?"
    ).bind(uploaded[0].bookId).first<{ n: number }>();
    expect(books?.n).toBe(1);
    expect(files?.n).toBe(2);
  });

  it("이미지 MIME으로 위장한 비지원 바이트는 400", async () => {
    const fd = new FormData();
    fd.append("title", "가짜 이미지");
    fd.append("file", new File(["not an image"], "가짜.png", { type: "image/png" }));
    const res = await call(env, `/api/subjects/${subjectId}/books`, {
      method: "POST",
      headers: { cookie },
      body: fd,
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining("지원하는 PDF 또는 이미지") });
  });

  it("같은 요청 안의 byte-identical 파일은 전체 요청을 409로 거부", async () => {
    const bytes = pngBytes(701);
    const fd = new FormData();
    fd.append("title", "요청 중복");
    fd.append("file", png("첫째.png", bytes));
    fd.append("file", png("둘째.png", bytes));
    const res = await call(env, `/api/subjects/${subjectId}/books`, {
      method: "POST",
      headers: { cookie },
      body: fd,
    });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining("같은 요청") });
  });

  it("같은 과목의 byte-identical 재업로드는 제목·파일명이 달라도 409", async () => {
    const bytes = pngBytes(702);
    const firstForm = new FormData();
    firstForm.append("title", "중복 원본");
    firstForm.append("file", png("원본.png", bytes));
    const first = await call(env, `/api/subjects/${subjectId}/books`, {
      method: "POST",
      headers: { cookie },
      body: firstForm,
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { id: number; files: number[] };
    await waitReady(firstBody.id);

    const secondForm = new FormData();
    secondForm.append("title", "전혀 다른 제목");
    secondForm.append("file", png("복사본.png", bytes));
    const second = await call(env, `/api/subjects/${subjectId}/books`, {
      method: "POST",
      headers: { cookie },
      body: secondForm,
    });
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ error: expect.stringContaining("같은 과목") });
  });

  it("PDF 첫 청크 실패 뒤 새 AI 호출을 멈추고 provider 재시도 정책에 위임", async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 96; i++) doc.addPage([613, 793]);
    const saved = await doc.save();
    const bytes = saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer;
    const fd = new FormData();
    fd.append("title", "청크 실패");
    fd.append("file", new File([bytes], "청크실패.pdf", { type: "application/pdf" }));

    mockState.problemCalls = 0;
    mockState.failProblems = true;
    try {
      const res = await call(env, `/api/subjects/${subjectId}/books`, {
        method: "POST",
        headers: { cookie },
        body: fd,
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: number };
      const book = await waitReady(body.id);
      expect(book.files[0].status).toBe("error");
      expect(book.files[0].error).toBe("문제 추출 실패: 페이지 구간 5/5개");
      // 최초 병렬 4청크 실패 후 누락 청크만 자동 1회 재시도하고 멈춘다.
      expect(mockState.problemCalls).toBe(8);
    } finally {
      mockState.failProblems = false;
      mockState.problemCalls = 0;
    }
  });

  it("마지막 청크에서 탐지한 정답표 쪽만 20쪽 본문 청크에 참고용으로 첨부", async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 41; i++) doc.addPage([613, 793]);
    const saved = await doc.save();
    const bytes = saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer;
    const fd = new FormData();
    fd.append("title", "정답표 첨부 검증");
    fd.append("file", new File([bytes], "정답표-검증.pdf", { type: "application/pdf" }));
    mockState.problemCalls = 0;
    mockState.problemInputs = [];
    mockState.answerDetectionCalls = 0;
    try {
      const res = await call(env, `/api/subjects/${subjectId}/books`, {
        method: "POST",
        headers: { cookie },
        body: fd,
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: number };
      expect((await waitReady(body.id)).files[0].status).toBe("ready");
      expect([...mockState.problemInputs].sort((a, b) => a.sliceBase - b.sliceBase)).toEqual([
        { sliceBase: 1, pageCount: 22, contentPageCount: 20, answerKeyPages: [40, 41] },
        { sliceBase: 20, pageCount: 22, contentPageCount: 20, answerKeyPages: [40, 41] },
        { sliceBase: 39, pageCount: 3, contentPageCount: 3, answerKeyPages: [40, 41] },
      ]);
      expect(mockState.answerDetectionCalls).toBe(1);
    } finally {
      mockState.problemCalls = 0;
      mockState.problemInputs = [];
      mockState.answerDetectionCalls = 0;
    }
  });

  it("20쪽 응답의 구조 검증 실패 구간만 10쪽씩 다시 읽음", async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 21; i++) doc.addPage([613, 793]);
    const saved = await doc.save();
    const bytes = saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer;
    const fd = new FormData();
    fd.append("title", "구조 오류 폴백");
    fd.append("file", new File([bytes], "구조오류-폴백.pdf", { type: "application/pdf" }));
    mockState.problemCalls = 0;
    mockState.problemInputs = [];
    mockState.failProblemContentPageCount = 20;
    mockState.boundaryVariantMode = true;
    try {
      const res = await call(env, `/api/subjects/${subjectId}/books`, {
        method: "POST",
        headers: { cookie },
        body: fd,
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: number };
      expect((await waitReady(body.id)).files[0].status).toBe("ready");
      const fallbackInputs = mockState.problemInputs
        .filter((input) => input.contentPageCount === 10 || input.contentPageCount === 11)
        .sort((a, b) => a.sliceBase - b.sliceBase);
      expect(fallbackInputs).toEqual([
        { sliceBase: 1, pageCount: 13, contentPageCount: 10, answerKeyPages: [19, 20, 21] },
        { sliceBase: 10, pageCount: 14, contentPageCount: 11, answerKeyPages: [19, 20, 21] },
      ]);
      const boundaryQuestions = (await questionsOf(body.id)).filter((question) => question.src_page === 10);
      expect(boundaryQuestions).toHaveLength(1);
      expect(boundaryQuestions[0].question).toBe("경계 뒤쪽 문구");
    } finally {
      mockState.failProblemContentPageCount = null;
      mockState.boundaryVariantMode = false;
      mockState.problemCalls = 0;
      mockState.problemInputs = [];
    }
  });

  it("20쪽 청크의 1쪽 겹침은 뒤 청크가 소유해 전사 문구가 달라도 중복하지 않음", async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 39; i++) doc.addPage([613, 793]);
    const saved = await doc.save();
    const bytes = saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer;
    const fd = new FormData();
    fd.append("title", "바깥 경계 중복 방지");
    fd.append("file", new File([bytes], "바깥-경계.pdf", { type: "application/pdf" }));
    mockState.outerBoundaryVariantMode = true;
    try {
      const res = await call(env, `/api/subjects/${subjectId}/books`, {
        method: "POST",
        headers: { cookie },
        body: fd,
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: number };
      expect((await waitReady(body.id)).files[0].status).toBe("ready");
      const boundaryQuestions = (await questionsOf(body.id)).filter((question) => question.src_page === 20);
      expect(boundaryQuestions).toHaveLength(1);
      expect(boundaryQuestions[0].question).toBe("뒤 청크가 온전히 읽은 경계 문항");
    } finally {
      mockState.outerBoundaryVariantMode = false;
    }
  });

  it("PDF 재시도는 DB의 성공 청크를 제외하고 누락 청크만 AI에 보냄", async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 77; i++) doc.addPage([614, 794]);
    const saved = await doc.save();
    const bytes = saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer;
    const fd = new FormData();
    fd.append("title", "청크 이어하기");
    fd.append("file", new File([bytes], "청크이어하기.pdf", { type: "application/pdf" }));

    mockState.problemCalls = 0;
    mockState.failProblemSliceBase = 1;
    try {
      const res = await call(env, `/api/subjects/${subjectId}/books`, {
        method: "POST",
        headers: { cookie },
        body: fd,
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: number; files: number[] };
      expect((await waitReady(body.id)).files[0].status).toBe("error");
      expect(mockState.problemCalls).toBe(5); // 최초 4청크 + 실패 1청크 자동 재시도
      expect(await env.DB.prepare(
        "SELECT retry_chunk_count, chunk_total FROM book_files WHERE id = ?"
      ).bind(body.files[0]).first()).toEqual({ retry_chunk_count: 1, chunk_total: 4 });
      expect(await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM book_extraction_chunks WHERE file_id = ?"
      ).bind(body.files[0]).first()).toEqual({ n: 3 });
      const answerScans = mockState.answerDetectionCalls;
      clearBookExtractionCache(body.files[0]); // 서버 재시작으로 메모리 캐시가 사라진 상황

      mockState.failProblemSliceBase = null;
      expect((await call(env, `/api/book-files/${body.files[0]}/retry`, {
        method: "POST",
        headers: { cookie },
      })).status).toBe(200);
      expect((await waitReady(body.id)).files[0].status).toBe("ready");
      expect(mockState.problemCalls).toBe(6); // 성공 3청크는 DB에서 복원, 누락 1청크만 호출
      expect(mockState.answerDetectionCalls).toBe(answerScans); // 정답표 탐지 결과도 DB에서 복원
      expect(await questionsOf(body.id)).toHaveLength(12);
      expect(await env.DB.prepare(
        "SELECT retry_chunk_count, chunk_total FROM book_files WHERE id = ?"
      ).bind(body.files[0]).first()).toEqual({ retry_chunk_count: 0, chunk_total: 4 });
      expect(await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM book_extraction_chunks WHERE file_id = ?"
      ).bind(body.files[0]).first()).toEqual({ n: 0 });

      expect((await call(env, `/api/book-files/${body.files[0]}/retry`, {
        method: "POST",
        headers: { cookie },
      })).status).toBe(200);
      expect((await waitReady(body.id)).files[0].status).toBe("ready");
      expect(mockState.problemCalls).toBe(10); // 완료 후 캐시는 정리되어 의도한 전체 재추출
    } finally {
      mockState.failProblemCall = null;
      mockState.failProblemSliceBase = null;
      mockState.problemCalls = 0;
    }
  });

  it("DB에 없는 fileId는 stale 페이지 캐시가 있어도 404", async () => {
    const staleKey = "pages/999999-1.png";
    await env.FILES.put(staleKey, new Uint8Array(PNG_SIGNATURE).buffer);
    try {
      const res = await call(env, "/api/book-files/999999/page/1/image", { headers: { cookie } });
      expect(res.status).toBe(404);
      expect(env.FILES.exists(staleKey)).toBe(true);
    } finally {
      await env.FILES.delete(staleKey);
    }
  });

  it("단일 이미지 원본은 1쪽 밖의 페이지 요청을 거부", async () => {
    const res = await call(env, `/api/book-files/${fileId}/page/2/image`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it("재추출 실패 시 기존 문제·학습 통계를 보존하고, 성공 시 원자 교체해 통계를 승계", async () => {
    const before = await questionsOf(bookId);
    const target = before.find((q) => q.question.includes("꼭짓점"));
    await env.DB.prepare("UPDATE questions SET correct_count = 4, wrong_count = 2 WHERE id = ?")
      .bind(target.id).run();
    await env.DB.prepare(
      "INSERT INTO question_attempts (question_id, attempt_id, correct) VALUES (?, ?, 1)"
    ).bind(target.id, `재추출-ID-${Date.now()}`).run();

    mockState.failProblems = true;
    try {
      const failedRetry = await call(env, `/api/book-files/${fileId}/retry`, { method: "POST", headers: { cookie } });
      expect(failedRetry.status).toBe(200);
      const failedBook = await waitReady(bookId);
      expect(failedBook.files[0].status).toBe("error");
      const afterFailure = await questionsOf(bookId);
      expect(afterFailure).toHaveLength(3);
      expect(afterFailure.find((q) => q.question === target.question)).toMatchObject({ correct_count: 4, wrong_count: 2 });
    } finally {
      mockState.failProblems = false;
    }

    const successRetry = await call(env, `/api/book-files/${fileId}/retry`, { method: "POST", headers: { cookie } });
    expect(successRetry.status).toBe(200);
    const readyBook = await waitReady(bookId);
    expect(readyBook.files[0].status).toBe("ready");
    const afterSuccess = await questionsOf(bookId);
    expect(afterSuccess).toHaveLength(3);
    expect(afterSuccess.find((q) => q.question === target.question)).toMatchObject({
      id: target.id,
      correct_count: 4,
      wrong_count: 2,
    });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM question_attempts WHERE question_id = ?"
    ).bind(target.id).first()).toEqual({ n: 1 });
  });

  it("레거시 지문이 달라도 페이지와 실제 인쇄 번호가 같으면 학습 이력을 승계", async () => {
    const fd = new FormData();
    fd.append("title", `레거시-인쇄번호-${Date.now()}`);
    fd.append("file", png("레거시-인쇄번호.png"));
    const uploaded = await call(env, `/api/subjects/${subjectId}/books`, {
      method: "POST",
      headers: { cookie },
      body: fd,
    });
    const target = await uploaded.json() as { id: number; files: number[] };
    await waitBookReady(target.id);
    const legacy = (await questionsOf(target.id)).find((question) => question.printed_number === "1");
    await env.DB.prepare(
      `UPDATE questions
       SET question = '221. 레거시 OCR 지문', printed_number = NULL, book_number = '9999', wrong_count = 1
       WHERE id = ?`
    ).bind(legacy.id).run();
    await env.DB.prepare(
      "INSERT INTO question_attempts (question_id, attempt_id, correct) VALUES (?, ?, 0)"
    ).bind(legacy.id, `레거시-인쇄번호-${Date.now()}`).run();

    mockState.problemNumberOffset = 220;
    try {
      expect((await call(env, `/api/book-files/${target.files[0]}/retry`, {
        method: "POST",
        headers: { cookie },
      })).status).toBe(200);
      expect((await waitBookReady(target.id)).files[0].status).toBe("ready");
      const preserved = (await questionsOf(target.id)).find((question) => question.id === legacy.id);
      expect(preserved).toMatchObject({
        book_number: "221",
        printed_number: "221",
        wrong_count: 1,
      });
      expect(preserved.question).toContain("꼭짓점");
      expect(await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM question_attempts WHERE question_id = ?"
      ).bind(legacy.id).first()).toEqual({ n: 1 });
    } finally {
      mockState.problemNumberOffset = 0;
      await call(env, `/api/books/${target.id}`, { method: "DELETE", headers: { cookie } });
    }
  });

  it("재추출 스냅샷 뒤 생긴 풀이 기록도 stale 문항과 함께 삭제하지 않음", async () => {
    const fd = new FormData();
    fd.append("title", `재추출-풀이경합-${Date.now()}`);
    fd.append("file", png("재추출-풀이경합.png"));
    const uploaded = await call(env, `/api/subjects/${subjectId}/books`, {
      method: "POST",
      headers: { cookie },
      body: fd,
    });
    const target = await uploaded.json() as { id: number; files: number[] };
    await waitBookReady(target.id);
    const stale = (await questionsOf(target.id))[0];
    await env.DB.prepare(
      "UPDATE questions SET question = '[예1] 스냅샷 뒤 풀이할 문항', printed_number = NULL WHERE id = ?"
    ).bind(stale.id).run();

    const originalBatch = env.DB.batch.bind(env.DB);
    let injected = false;
    env.DB.batch = async (statements) => {
      const isMerge = statements.some((statement) =>
        String((statement as unknown as { sql: string }).sql).includes("DELETE FROM questions WHERE id IN")
      );
      if (isMerge && !injected) {
        injected = true;
        await env.DB.prepare("UPDATE questions SET wrong_count = 1 WHERE id = ?").bind(stale.id).run();
        await env.DB.prepare(
          "INSERT INTO question_attempts (question_id, attempt_id, correct) VALUES (?, ?, 0)"
        ).bind(stale.id, `재추출-풀이경합-${Date.now()}`).run();
      }
      return originalBatch(statements);
    };
    try {
      expect((await call(env, `/api/book-files/${target.files[0]}/retry`, {
        method: "POST",
        headers: { cookie },
      })).status).toBe(200);
      expect((await waitBookReady(target.id)).files[0].status).toBe("ready");
      expect((await questionsOf(target.id)).find((question) => question.id === stale.id))
        .toMatchObject({ wrong_count: 1 });
      expect(await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM question_attempts WHERE question_id = ?"
      ).bind(stale.id).first()).toEqual({ n: 1 });
    } finally {
      env.DB.batch = originalBatch;
      await call(env, `/api/books/${target.id}`, { method: "DELETE", headers: { cookie } });
    }
  });

  it("재추출 지문이 같아도 정답이 바뀌면 기존 공식 해설을 승계하지 않음", async () => {
    const fd = new FormData();
    fd.append("title", `답변경-해설승계-${Date.now()}`);
    fd.append("file", png("답변경-원본.png"));
    const uploaded = await call(env, `/api/subjects/${subjectId}/books`, {
      method: "POST",
      headers: { cookie },
      body: fd,
    });
    expect(uploaded.status).toBe(201);
    const target = await uploaded.json() as { id: number; files: number[] };
    await waitBookReady(target.id);

    try {
      const before = (await questionsOf(target.id)).find((question) => question.question.includes("꼭짓점"));
      await env.DB.prepare("UPDATE questions SET explanation = ? WHERE id = ?")
        .bind("이전 정답용 공식 해설", before.id).run();

      mockState.changedAnswerMode = true;
      const retry = await call(env, `/api/book-files/${target.files[0]}/retry`, {
        method: "POST",
        headers: { cookie },
      });
      expect(retry.status).toBe(200);
      await waitBookReady(target.id);

      const after = (await questionsOf(target.id)).find((question) => question.question === before.question);
      expect(after).toMatchObject({ answer: "2", explanation: "" });
    } finally {
      mockState.changedAnswerMode = false;
      await call(env, `/api/books/${target.id}`, { method: "DELETE", headers: { cookie } });
    }
  });

  it("processing 중 중복 재추출은 409", async () => {
    mockState.delay = 80;
    try {
      const first = await call(env, `/api/book-files/${fileId}/retry`, { method: "POST", headers: { cookie } });
      expect(first.status).toBe(200);
      const duplicate = await call(env, `/api/book-files/${fileId}/retry`, { method: "POST", headers: { cookie } });
      expect(duplicate.status).toBe(409);
      await waitReady(bookId);
    } finally {
      mockState.delay = 0;
    }
  });

  it("파일 재추출과 해설 추가는 book claim으로 양방향 배제", async () => {
    mockState.solutionDelay = 80;
    mockState.lastSolutionSignal = null;
    const solutionForm = new FormData();
    solutionForm.append("file", png("재추출-배제-해설.png"));
    const solution = await call(env, `/api/subjects/${subjectId}/books/${bookId}/explanations`, {
      method: "POST",
      headers: { cookie },
      body: solutionForm,
    });
    expect(solution.status).toBe(202);
    const { jobId } = await solution.json() as { jobId: number };
    for (let i = 0; i < 50 && mockState.lastSolutionSignal === null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await call(env, `/api/book-files/${fileId}/retry`, {
      method: "POST",
      headers: { cookie },
    })).status).toBe(409);
    expect(await waitAIJob(jobId)).toMatchObject({ status: "ready" });
    mockState.solutionDelay = 0;
    mockState.lastSolutionSignal = null;

    const originalPrepare = env.DB.prepare.bind(env.DB);
    let releaseClaim!: () => void;
    let markClaimEntered!: () => void;
    const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const claimEntered = new Promise<void>((resolve) => { markClaimEntered = resolve; });
    let intercepted = false;
    let pendingRetry: Promise<Response> | null = null;
    env.DB.prepare = ((sql: string) => {
      const statement = originalPrepare(sql);
      if (!intercepted && sql.includes("UPDATE book_files SET status = 'processing'")) {
        intercepted = true;
        const first = statement.first.bind(statement);
        statement.first = (async <T>() => {
          markClaimEntered();
          await claimGate;
          return first<T>();
        }) as typeof statement.first;
      }
      return statement;
    }) as typeof env.DB.prepare;
    mockState.delay = 80;
    try {
      pendingRetry = call(env, `/api/book-files/${fileId}/retry`, {
        method: "POST",
        headers: { cookie },
      });
      await claimEntered;

      const blockedSolutionForm = new FormData();
      blockedSolutionForm.append("file", png("재추출-claim중-해설.png"));
      expect((await call(env, `/api/subjects/${subjectId}/books/${bookId}/explanations`, {
        method: "POST",
        headers: { cookie },
        body: blockedSolutionForm,
      })).status).toBe(409);

      releaseClaim();
      expect((await pendingRetry).status).toBe(200);
      expect((await waitReady(bookId)).files[0].status).toBe("ready");
    } finally {
      releaseClaim();
      env.DB.prepare = originalPrepare;
      await pendingRetry?.catch(() => undefined);
      mockState.delay = 0;
      mockState.solutionDelay = 0;
      mockState.lastSolutionSignal = null;
    }
  });

  it("파일 삭제: 그 파일의 문제까지 제거", async () => {
    const fullPageKey = `pages/${fileId}-1.png`;
    const croppedPageKey = `pages/${fileId}-1-0.2-0.5.png`;
    const unrelatedKey = "pages/unrelated-1.png";
    for (const key of [fullPageKey, croppedPageKey, unrelatedKey]) {
      await env.FILES.put(key, new Uint8Array(PNG_SIGNATURE).buffer);
    }

    const res = await call(env, `/api/book-files/${fileId}`, { method: "DELETE", headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await questionsOf(bookId)).length).toBe(0);
    expect(env.FILES.exists(fullPageKey)).toBe(false);
    expect(env.FILES.exists(croppedPageKey)).toBe(false);
    expect(env.FILES.exists(unrelatedKey)).toBe(true);
    await env.FILES.delete(unrelatedKey);
  });

  it("문제집 삭제: 파일·등록 문제까지 정리", async () => {
    const fd = new FormData();
    fd.append("title", "삭제용");
    fd.append("file", png("삭제.png"));
    const up = (await (await call(env, `/api/subjects/${subjectId}/books`, { method: "POST", headers: { cookie }, body: fd })).json()) as { id: number; files: number[] };
    await waitReady(up.id);
    expect((await questionsOf(up.id)).length).toBe(3);
    const cacheKey = `pages/${up.files[0]}-3.png`;
    await env.FILES.put(cacheKey, new Uint8Array(PNG_SIGNATURE).buffer);
    const res = await call(env, `/api/books/${up.id}`, { method: "DELETE", headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await call(env, `/api/books/${up.id}`, { headers: { cookie } })).status).toBe(404);
    expect((await questionsOf(up.id)).length).toBe(0);
    expect(env.FILES.exists(cacheKey)).toBe(false);
  });

  it("분석 중단: cancel → '사용자 중단' error, 문제 저장 안 됨", async () => {
    mockState.delay = 80; // 추출이 진행 중인 상태를 만든다
    mockState.lastProblemSignal = null;
    try {
      const fd = new FormData();
      fd.append("title", "중단 테스트");
      fd.append("file", png("중단.png"));
      const body = (await (await call(env, `/api/subjects/${subjectId}/books`, { method: "POST", headers: { cookie }, body: fd })).json()) as { id: number; files: number[] };

      const cres = await call(env, `/api/book-files/${body.files[0]}/cancel`, { method: "POST", headers: { cookie } });
      expect(cres.status).toBe(200);
      expect((mockState.lastProblemSignal as AbortSignal | null)?.aborted).toBe(true);

      const b = await waitReady(body.id);
      expect(b.files[0].status).toBe("error");
      expect(b.files[0].error).toBe("사용자 중단");

      // 뒤늦게 완료된 추출이 문제를 저장하면 안 된다
      await new Promise((r) => setTimeout(r, 150));
      expect((await questionsOf(body.id)).length).toBe(0);
    } finally {
      mockState.delay = 0;
    }
  });

  it("사용량 확인 중 취소한 재추출은 provider를 시작하거나 ready로 부활하지 않음", async () => {
    const fd = new FormData();
    fd.append("title", "재추출 경합");
    fd.append("file", png("재추출-경합.png"));
    const uploaded = (await (await call(env, `/api/subjects/${subjectId}/books`, {
      method: "POST",
      headers: { cookie },
      body: fd,
    })).json()) as { id: number; files: number[] };
    await waitReady(uploaded.id);

    const paused = pauseNextUsageIncrement(env.DB);
    const callsBefore = mockState.problemCalls;
    try {
      const pending = call(env, `/api/book-files/${uploaded.files[0]}/retry`, {
        method: "POST",
        headers: { cookie },
      });
      await paused.entered;
      const cancelled = await call(env, `/api/book-files/${uploaded.files[0]}/cancel`, {
        method: "POST",
        headers: { cookie },
      });
      expect(cancelled.status).toBe(200);
      paused.release();
      expect((await pending).status).toBe(409);
      expect(mockState.problemCalls).toBe(callsBefore);
      const row = await env.DB.prepare(
        "SELECT status, error FROM book_files WHERE id = ?"
      ).bind(uploaded.files[0]).first<{ status: string; error: string | null }>();
      expect(row).toEqual({ status: "error", error: "사용자 중단" });
    } finally {
      paused.restore();
    }
  });
});

describe("통합 업로드 라우팅 (자료 사이드바)", () => {
  async function uploadToMaterials(name: string, input: File = png(name)): Promise<any> {
    const fd = new FormData();
    fd.append("title", name);
    fd.append("file", input);
    const res = await call(env, `/api/subjects/${subjectId}/materials`, {
      method: "POST",
      headers: { cookie },
      body: fd,
    });
    expect(res.status).toBe(201);
    return res.json();
  }

  async function waitMatBook(id: number, want: string): Promise<any> {
    for (let i = 0; i < 300; i++) {
      const res = await call(env, `/api/subjects/${subjectId}/materials`, { headers: { cookie } });
      const m = ((await res.json()) as any[]).find((x) => x.id === id);
      if (m?.book_status === want) return m;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`자료 ${id} book_status=${want} 대기 시간 초과`);
  }

  async function waitMaterial(id: number, want: string): Promise<any> {
    for (let i = 0; i < 200; i++) {
      const res = await call(env, `/api/materials/${id}`, { headers: { cookie } });
      const material = (await res.json()) as any;
      if (material.status === want) return material;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`자료 ${id} status=${want} 대기 시간 초과`);
  }

  async function createReadyMaterial(title: string): Promise<{ id: number; key: string }> {
    const key = `test/${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    await env.FILES.put(key, new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer);
    const row = await env.DB.prepare(
      `INSERT INTO materials (subject_id, kind, title, r2_key, extracted_text, status)
       VALUES (?, 'image', ?, ?, '문제 본문', 'ready') RETURNING id`
    ).bind(subjectId, title, key).first<{ id: number }>();
    return { id: row!.id, key };
  }

  it("자료 업로드 → 파트 지도에 문제·해설이 있으면 모든 문제·그림이 자동으로 문제 칸에 등록된다", async () => {
    mockState.sections = [{ part: "개념", from: 1, to: 1 }, { part: "문제", from: 2, to: 3 }, { part: "해설", from: 10, to: 12 }];
    try {
      const mat = await uploadToMaterials("자동교재.png");
      await waitMatBook(mat.id, "ready"); // 자료 추출 → 자동 비전 문제 추출 완료
      const { book_id } = (await env.DB.prepare("SELECT book_id FROM materials WHERE id = ?").bind(mat.id).first<{ book_id: number }>())!;
      // 문제 칸(questions): 뽑힌 문제 3개가 모두 등록(정답 AI가 채움)
      const qres = await call(env, `/api/subjects/${subjectId}/questions`, { headers: { cookie } });
      const qs = ((await qres.json()) as any[]).filter((q) => q.book_id === book_id);
      expect(qs.length).toBe(3);
      expect(qs.some((q) => q.has_figure === 1)).toBe(true); // 그림 문제 → 원본 페이지 이미지 표시 플래그
    } finally {
      mockState.sections = [];
    }
  });

  it("자료 이미지 자동 문제 추출 복사본이 JPEG/WebP/GIF MIME을 보존", async () => {
    mockState.sections = [{ part: "문제", from: 1, to: 1 }];
    const cases = [
      { name: "교재.jpg", type: "image/jpeg", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) },
      { name: "교재.webp", type: "image/webp", bytes: new TextEncoder().encode("RIFF1234WEBP") },
      { name: "교재.gif", type: "image/gif", bytes: new TextEncoder().encode("GIF89a") },
    ];
    try {
      for (const sample of cases) {
        const mat = await uploadToMaterials(
          sample.name,
          new File([sample.bytes], sample.name, { type: sample.type })
        );
        await waitMatBook(mat.id, "ready");
        const row = await env.DB.prepare(
          `SELECT bf.mime FROM materials m
           JOIN book_files bf ON bf.book_id = m.book_id
           WHERE m.id = ? ORDER BY bf.id DESC LIMIT 1`
        ).bind(mat.id).first<{ mime: string }>();
        expect(row?.mime).toBe(sample.type);
      }
    } finally {
      mockState.sections = [];
    }
  });

  it("자료 원본이 사라진 재추출은 기존 book·questions를 삭제하지 않음", async () => {
    mockState.sections = [{ part: "문제", from: 1, to: 1 }];
    try {
      const mat = await uploadToMaterials("원본보존.png");
      await waitMatBook(mat.id, "ready");
      const linked = await env.DB.prepare(
        "SELECT book_id, r2_key FROM materials WHERE id = ?"
      ).bind(mat.id).first<{ book_id: number; r2_key: string }>();
      const before = await questionsOf(linked!.book_id);
      expect(before).toHaveLength(3);

      await env.FILES.delete(linked!.r2_key);
      const result = await startMaterialToBook(env, mat.id);
      expect(result).toMatchObject({ code: 404 });
      expect(await questionsOf(linked!.book_id)).toHaveLength(3);
      expect(await env.DB.prepare("SELECT id FROM books WHERE id = ?").bind(linked!.book_id).first()).not.toBeNull();
    } finally {
      mockState.sections = [];
    }
  });

  it("동일 자료 문제 추출 동시 요청은 한 번만 claim·사용량 집계", async () => {
    const material = await createReadyMaterial("동시요청");
    const before = await env.DB.prepare("SELECT COALESCE(SUM(calls), 0) AS n FROM usage_daily")
      .first<{ n: number }>();
    mockState.delay = 80;
    try {
      const results = await Promise.all([
        startMaterialToBook(env, material.id),
        startMaterialToBook(env, material.id),
      ]);
      const started = results.filter((result) => "bookId" in result);
      const rejected = results.filter((result) => "error" in result);
      expect(started).toHaveLength(1);
      expect(rejected).toEqual([expect.objectContaining({ code: 409 })]);
      const after = await env.DB.prepare("SELECT COALESCE(SUM(calls), 0) AS n FROM usage_daily")
        .first<{ n: number }>();
      expect(after!.n).toBe(before!.n + 1);
      await waitReady((started[0] as { bookId: number }).bookId);
    } finally {
      mockState.delay = 0;
    }
  });

  it("자료 재분석 동시 요청은 provider 작업과 사용량을 하나만 시작", async () => {
    const material = await createReadyMaterial("자료재시도동시");
    const before = await env.DB.prepare("SELECT COALESCE(SUM(calls), 0) AS n FROM usage_daily")
      .first<{ n: number }>();
    mockState.materialDelay = 80;
    try {
      const responses = await Promise.all([
        call(env, `/api/materials/${material.id}/retry`, { method: "POST", headers: { cookie } }),
        call(env, `/api/materials/${material.id}/retry`, { method: "POST", headers: { cookie } }),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      const after = await env.DB.prepare("SELECT COALESCE(SUM(calls), 0) AS n FROM usage_daily")
        .first<{ n: number }>();
      expect(after!.n).toBe(before!.n + 1);
      await waitMaterial(material.id, "ready");
    } finally {
      mockState.materialDelay = 0;
    }
  });

  it("자료 재분석 claim 뒤 취소해도 provider를 시작하거나 ready로 부활하지 않음", async () => {
    const material = await createReadyMaterial("자료재시도취소경합");
    await env.DB.prepare(
      "UPDATE materials SET status = 'error', error = '이전 실패', progress = 37 WHERE id = ?"
    ).bind(material.id).run();
    const paused = pauseNextUsageIncrement(env.DB);
    const callsBefore = mockState.materialCalls;
    try {
      const pending = call(env, `/api/materials/${material.id}/retry`, {
        method: "POST",
        headers: { cookie },
      });
      await paused.entered;
      expect((await call(env, `/api/materials/${material.id}/cancel`, {
        method: "POST",
        headers: { cookie },
      })).status).toBe(200);
      paused.release();
      expect((await pending).status).toBe(409);
      expect(mockState.materialCalls).toBe(callsBefore);
      const row = await env.DB.prepare(
        "SELECT status, error FROM materials WHERE id = ?"
      ).bind(material.id).first<{ status: string; error: string | null }>();
      expect(row).toEqual({ status: "error", error: "사용자 중단" });
    } finally {
      paused.restore();
      await env.FILES.delete(material.key);
    }
  });

  it("자료 재분석 한도 실패는 기존 상태·오류·진행률을 완전 복원", async () => {
    const material = await createReadyMaterial("자료재시도한도복원");
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    try {
      await env.DB.prepare(
        "UPDATE materials SET status = 'error', error = '원래 오류', progress = 41 WHERE id = ?"
      ).bind(material.id).run();
      await env.DB.prepare(
        "INSERT INTO usage_daily (day, calls) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET calls = ?"
      ).bind(day, DAILY_LIMIT, DAILY_LIMIT).run();
      const response = await call(env, `/api/materials/${material.id}/retry`, {
        method: "POST",
        headers: { cookie },
      });
      expect(response.status).toBe(429);
      const restored = await env.DB.prepare(
        "SELECT status, error, progress FROM materials WHERE id = ?"
      ).bind(material.id).first<{ status: string; error: string | null; progress: number }>();
      expect(restored).toEqual({ status: "error", error: "원래 오류", progress: 41 });
    } finally {
      await env.DB.prepare("UPDATE usage_daily SET calls = 0 WHERE day = ?").bind(day).run();
      await env.FILES.delete(material.key);
    }
  });

  it("자료 연동 문제 추출 취소는 재시도 claim을 원자 해제", async () => {
    const material = await createReadyMaterial("문제추출취소claim");
    mockState.delay = 80;
    try {
      const started = await startMaterialToBook(env, material.id);
      if ("error" in started) throw new Error(started.error);
      expect((await call(env, `/api/book-files/${started.fileId}/cancel`, {
        method: "POST",
        headers: { cookie },
      })).status).toBe(200);
      const row = await env.DB.prepare(
        "SELECT book_processing, pending_to_book FROM materials WHERE id = ?"
      ).bind(material.id).first<{ book_processing: number; pending_to_book: number }>();
      expect(row).toEqual({ book_processing: 0, pending_to_book: 0 });
      await waitMatBook(material.id, "error");
    } finally {
      mockState.delay = 0;
      await env.FILES.delete(material.key);
    }
  });

  it("원본 확인 직후 자료가 삭제돼도 고아 book/file을 만들지 않음", async () => {
    const material = await createReadyMaterial("삭제경합");
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM books").first<{ n: number }>();
    const originalGet = env.FILES.get.bind(env.FILES);
    env.FILES.get = async (key: string) => {
      const value = await originalGet(key);
      await env.DB.prepare("DELETE FROM materials WHERE id = ?").bind(material.id).run();
      return value;
    };
    try {
      await expect(startMaterialToBook(env, material.id)).resolves.toMatchObject({ code: 404 });
      const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM books").first<{ n: number }>();
      expect(after).toEqual(before);
    } finally {
      env.FILES.get = originalGet;
      await env.FILES.delete(material.key);
    }
  });

  it("자료 삭제와 문제 추출 시작이 겹쳐도 내부 book을 남기지 않음", async () => {
    const material = await createReadyMaterial("라우트삭제경합");
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM books").first<{ n: number }>();
    const originalDelete = env.FILES.delete.bind(env.FILES);
    let raced: Awaited<ReturnType<typeof startMaterialToBook>> | undefined;
    env.FILES.delete = async (key: string) => {
      if (key === material.key) raced = await startMaterialToBook(env, material.id);
      await originalDelete(key);
    };
    try {
      const response = await call(env, `/api/materials/${material.id}`, {
        method: "DELETE",
        headers: { cookie },
      });
      expect(response.status).toBe(200);
      expect(raced).toMatchObject({ code: 400 });
      expect(await env.DB.prepare("SELECT id FROM materials WHERE id = ?")
        .bind(material.id).first()).toBeNull();
      const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM books").first<{ n: number }>();
      expect(after).toEqual(before);
    } finally {
      env.FILES.delete = originalDelete;
      await originalDelete(material.key);
    }
  });

  it("기존 book 파일 재사용 중 자료 삭제가 끝나도 고아 파일을 남기지 않음", async () => {
    const material = await createReadyMaterial("재사용삭제경합");
    const initial = await startMaterialToBook(env, material.id);
    if ("error" in initial) throw new Error(initial.error);
    await waitReady(initial.bookId);
    const file = await env.DB.prepare(
      "SELECT r2_key FROM book_files WHERE id = ?"
    ).bind(initial.fileId).first<{ r2_key: string }>();
    const originalPut = env.FILES.put.bind(env.FILES);
    let raced = false;
    let deletionStatus = 0;
    env.FILES.put = async (key: string, data: ArrayBuffer) => {
      if (!raced && key === file!.r2_key) {
        raced = true;
        deletionStatus = (await call(env, `/api/materials/${material.id}`, {
          method: "DELETE",
          headers: { cookie },
        })).status;
      }
      await originalPut(key, data);
    };
    try {
      const retried = await startMaterialToBook(env, material.id);
      expect(deletionStatus).toBe(200);
      expect(retried).toMatchObject({ code: 404 });
      expect(env.FILES.exists(file!.r2_key)).toBe(false);
      expect(await env.DB.prepare("SELECT id FROM books WHERE id = ?")
        .bind(initial.bookId).first()).toBeNull();
    } finally {
      env.FILES.put = originalPut;
      await env.FILES.delete(file!.r2_key);
      await env.FILES.delete(material.key);
    }
  });

  it("파트 지도만 실패하면 성공한 전사본을 보존하고 ready로 완료", async () => {
    mockState.failMap = true;
    try {
      const material = await uploadToMaterials("지도실패.png");
      const saved = await waitMaterial(material.id, "ready");
      expect(saved.extracted_text).toBe("추출된 텍스트 (모킹)");
      expect(saved.section_map).toBeNull();
    } finally {
      mockState.failMap = false;
    }
  });

  it("영구 문제 추출 실패는 자동 재시도를 총 3회로 제한", async () => {
    mockState.sections = [{ part: "문제", from: 1, to: 1 }];
    mockState.failProblems = true;
    const waitRetryCount = async (id: number, expected: number) => {
      for (let i = 0; i < 200; i++) {
        const row = await env.DB.prepare(
          "SELECT book_retry_count, pending_to_book FROM materials WHERE id = ?"
        ).bind(id).first<{ book_retry_count: number; pending_to_book: number }>();
        if (row && row.book_retry_count >= expected) return row;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`재시도 횟수 ${expected} 대기 시간 초과`);
    };
    try {
      const mat = await uploadToMaterials("영구실패.png");
      expect((await waitRetryCount(mat.id, 1)).pending_to_book).toBe(1);

      for (let expected = 2; expected <= MAX_AUTO_BOOK_RETRIES; expected++) {
        await retryPendingToBook(env);
        await waitRetryCount(mat.id, expected);
      }
      const exhausted = await env.DB.prepare(
        "SELECT book_retry_count, pending_to_book FROM materials WHERE id = ?"
      ).bind(mat.id).first<{ book_retry_count: number; pending_to_book: number }>();
      expect(exhausted).toEqual({ book_retry_count: MAX_AUTO_BOOK_RETRIES, pending_to_book: 0 });
      const files = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM book_files WHERE book_id = (SELECT book_id FROM materials WHERE id = ?)"
      ).bind(mat.id).first<{ n: number }>();
      expect(files?.n).toBe(1); // error book_file을 매번 새로 만들지 않고 안전하게 재사용

      await retryPendingToBook(env);
      await new Promise((r) => setTimeout(r, 30));
      const unchanged = await env.DB.prepare(
        "SELECT book_retry_count, pending_to_book FROM materials WHERE id = ?"
      ).bind(mat.id).first<{ book_retry_count: number; pending_to_book: number }>();
      expect(unchanged).toEqual(exhausted);
    } finally {
      mockState.failProblems = false;
      mockState.sections = [];
    }
  });

  it("인증 같은 영구 provider 오류는 자동 재호출하지 않고 원인과 청크 수를 표시", async () => {
    const material = await createReadyMaterial("인증오류자동차단");
    mockState.failProblemProviderCode = "auth";
    const callsBefore = mockState.problemCalls;
    try {
      const started = await startMaterialToBook(env, material.id);
      if ("error" in started) throw new Error(started.error);
      const visible = await waitMatBook(material.id, "error");
      expect(visible).toMatchObject({
        book_error: "Codex CLI 로그인이 필요합니다",
        book_retry_chunk_count: 1,
        book_chunk_total: 1,
      });
      expect(mockState.problemCalls).toBe(callsBefore + 1);
      expect(await env.DB.prepare(
        "SELECT book_retry_count, pending_to_book FROM materials WHERE id = ?"
      ).bind(material.id).first()).toEqual({ book_retry_count: 0, pending_to_book: 0 });

      await retryPendingToBook(env);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(mockState.problemCalls).toBe(callsBefore + 1);
    } finally {
      mockState.failProblemProviderCode = null;
      await env.FILES.delete(material.key);
    }
  });

  it("그림 설명 backfill은 하나씩 실행하고 인증 실패 뒤에도 재시도 표식을 보존", async () => {
    const first = await createReadyMaterial("그림설명백필1");
    const second = await createReadyMaterial("그림설명백필2");
    await env.DB.prepare(
      `UPDATE materials
       SET pending_to_book = 1, figure_backfill_pending = 1
       WHERE id IN (?, ?)`
    ).bind(first.id, second.id).run();
    const callsBefore = mockState.problemCalls;
    mockState.delay = 80;
    try {
      await retryPendingToBook(env);
      await retryPendingToBook(env); // 첫 backfill 진행 중에는 두 번째를 시작하지 않는다.
      expect(mockState.problemCalls).toBe(callsBefore + 1);
      await waitMatBook(first.id, "ready");
      expect(await env.DB.prepare(
        "SELECT pending_to_book, figure_backfill_pending FROM materials WHERE id = ?"
      ).bind(first.id).first()).toEqual({ pending_to_book: 0, figure_backfill_pending: 0 });
      expect(await env.DB.prepare(
        "SELECT pending_to_book, figure_backfill_pending, book_processing FROM materials WHERE id = ?"
      ).bind(second.id).first()).toEqual({ pending_to_book: 1, figure_backfill_pending: 1, book_processing: 0 });

      mockState.delay = 0;
      mockState.failProblemProviderCode = "auth";
      await retryPendingToBook(env);
      await waitMatBook(second.id, "error");
      expect(await env.DB.prepare(
        `SELECT pending_to_book, figure_backfill_pending, book_retry_count
         FROM materials WHERE id = ?`
      ).bind(second.id).first()).toEqual({ pending_to_book: 1, figure_backfill_pending: 1, book_retry_count: 0 });

      mockState.failProblemProviderCode = null;
      await retryPendingToBook(env);
      await waitMatBook(second.id, "ready");
      expect(await env.DB.prepare(
        "SELECT pending_to_book, figure_backfill_pending FROM materials WHERE id = ?"
      ).bind(second.id).first()).toEqual({ pending_to_book: 0, figure_backfill_pending: 0 });
    } finally {
      mockState.delay = 0;
      mockState.failProblemProviderCode = null;
      await env.FILES.delete(first.key);
      await env.FILES.delete(second.key);
    }
  });

  it("추출 범위에서 빠진 학습 문항은 자동 backfill을 비파괴 종료하고 반복하지 않음", async () => {
    const material = await createReadyMaterial("학습문항-백필충돌");
    try {
      const started = await startMaterialToBook(env, material.id);
      if ("error" in started) throw new Error(started.error);
      await waitMatBook(material.id, "ready");
      const protectedQuestion = (await questionsOf(started.bookId))[0];
      await env.DB.prepare(
        `UPDATE questions
         SET question = '[예1] 기존 개념 예제', printed_number = NULL, book_number = '4', wrong_count = 1
         WHERE id = ?`
      ).bind(protectedQuestion.id).run();
      await env.DB.prepare(
        "INSERT INTO question_attempts (question_id, attempt_id, correct) VALUES (?, ?, 0)"
      ).bind(protectedQuestion.id, `백필-보존-${Date.now()}`).run();
      await env.DB.prepare(
        `UPDATE materials
         SET pending_to_book = 1, figure_backfill_pending = 1,
             integrity_warning = '페이지 근거 불완전: 1/1쪽'
         WHERE id = ?`
      ).bind(material.id).run();

      const callsBefore = mockState.problemCalls;
      await retryPendingToBook(env);
      let parked: Record<string, unknown> | null = null;
      for (let i = 0; i < 200; i++) {
        parked = await env.DB.prepare(
          `SELECT m.pending_to_book, m.figure_backfill_pending, m.book_processing, m.integrity_warning,
                  bf.status AS book_status, bf.error AS book_error
           FROM materials m JOIN book_files bf ON bf.book_id = m.book_id
           WHERE m.id = ?`
        ).bind(material.id).first<Record<string, unknown>>();
        if (parked?.pending_to_book === 0 && parked.book_processing === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(parked).toMatchObject({
        pending_to_book: 0,
        figure_backfill_pending: 1,
        book_processing: 0,
        book_status: "ready",
        book_error: null,
      });
      expect(String(parked?.integrity_warning)).toContain("자동 문제 보강 건너뜀");
      expect(String(parked?.integrity_warning)).toContain("페이지 근거 불완전");
      expect((await questionsOf(started.bookId)).find((question) => question.id === protectedQuestion.id))
        .toMatchObject({ question: "[예1] 기존 개념 예제", wrong_count: 1 });
      expect(await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM question_attempts WHERE question_id = ?"
      ).bind(protectedQuestion.id).first()).toEqual({ n: 1 });

      await retryPendingToBook(env);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(mockState.problemCalls).toBe(callsBefore + 1);

      expect((await call(env, `/api/book-files/${started.fileId}/retry`, {
        method: "POST",
        headers: { cookie },
      })).status).toBe(200);
      const failed = await waitMatBook(material.id, "error");
      expect(failed.book_error).toContain("학습 이력이 있는 4번 문항");
      expect(failed.book_error).toContain("그대로 보존했습니다");
      expect(await env.DB.prepare(
        "SELECT pending_to_book FROM materials WHERE id = ?"
      ).bind(material.id).first()).toEqual({ pending_to_book: 0 });

      await env.DB.prepare(
        "UPDATE questions SET question = ?, printed_number = '1', book_number = '1' WHERE id = ?"
      ).bind(protectedQuestion.question, protectedQuestion.id).run();
      expect((await call(env, `/api/book-files/${started.fileId}/retry`, {
        method: "POST",
        headers: { cookie },
      })).status).toBe(200);
      const recovered = await waitMatBook(material.id, "ready");
      expect(recovered.integrity_warning).toBe("페이지 근거 불완전: 1/1쪽");
      expect(await env.DB.prepare(
        "SELECT pending_to_book, figure_backfill_pending FROM materials WHERE id = ?"
      ).bind(material.id).first()).toEqual({ pending_to_book: 0, figure_backfill_pending: 0 });
    } finally {
      await call(env, `/api/materials/${material.id}`, { method: "DELETE", headers: { cookie } });
      await env.FILES.delete(material.key);
    }
  });

  it("순수 개념 자료(문제 파트 없음)는 문제 추출을 건너뛴다 (문제 칸에 아무것도 안 들어감)", async () => {
    mockState.sections = [{ part: "개념", from: 1, to: 5 }];
    try {
      const body = await uploadToMaterials("개념정리.png");
      // 자료 추출 완료 대기
      for (let i = 0; i < 200; i++) {
        const res = await call(env, `/api/subjects/${subjectId}/materials`, { headers: { cookie } });
        const m = ((await res.json()) as any[]).find((x) => x.id === body.id);
        if (m?.status === "ready") break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const res = await call(env, `/api/subjects/${subjectId}/materials`, { headers: { cookie } });
      const m = ((await res.json()) as any[]).find((x) => x.id === body.id);
      expect(m.book_status).toBeNull(); // 문제 추출이 아예 안 돌았다
    } finally {
      mockState.sections = [];
    }
  });

  it("한도로 못 돈 자동 문제 추출은 보류됐다가 재시도 루프가 끝까지 처리한다", async () => {
    mockState.sections = [{ part: "문제", from: 1, to: 5 }];
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    try {
      // 업로드(사용량 1)는 통과하되 직후 자동 문제집화는 한도에 걸리게 세팅
      await env.DB.prepare(
        "INSERT INTO usage_daily (day, calls) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET calls = ?"
      ).bind(day, DAILY_LIMIT - 1, DAILY_LIMIT - 1).run();
      const body = await uploadToMaterials("보류교재.png");
      // 자동 문제 추출이 429로 보류될 때까지 대기
      for (let i = 0; i < 200; i++) {
        const row = await env.DB.prepare("SELECT pending_to_book FROM materials WHERE id = ?")
          .bind(body.id).first<{ pending_to_book: number }>();
        if (row?.pending_to_book === 1) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const flagged = await env.DB.prepare("SELECT pending_to_book FROM materials WHERE id = ?")
        .bind(body.id).first<{ pending_to_book: number }>();
      expect(flagged?.pending_to_book).toBe(1);

      // 한도 리셋(다음 날 상황) → 재시도 루프가 이어서 처리
      await env.DB.prepare("UPDATE usage_daily SET calls = 0 WHERE day = ?").bind(day).run();
      await retryPendingToBook(env);
      for (let i = 0; i < 200; i++) {
        const books = await getBooks();
        const b = books.find((x) => x.title === "보류교재");
        if (b?.files?.[0]?.status === "ready") {
          expect((await questionsOf(b.id)).length).toBe(3); // 뽑힌 문제 3개 등록
          const cleared = await env.DB.prepare("SELECT pending_to_book FROM materials WHERE id = ?")
            .bind(body.id).first<{ pending_to_book: number }>();
          expect(cleared?.pending_to_book).toBe(0);
          return;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("재시도 문제 추출 대기 시간 초과");
    } finally {
      mockState.sections = [];
      await env.DB.prepare("UPDATE usage_daily SET calls = 0 WHERE day = ?").bind(day).run();
    }
  });

  it("업로드는 자료로 처리되고 텍스트 추출이 저장된다", async () => {
    const body = await uploadToMaterials("개념 필기.png");
    expect(body.routed).toBeUndefined();
    expect(body.status).toBe("processing");
    // 백그라운드 추출 완료 대기
    for (let i = 0; i < 200; i++) {
      const res = await call(env, `/api/subjects/${subjectId}/materials`, { headers: { cookie } });
      const mats = (await res.json()) as any[];
      const m = mats.find((x) => x.id === body.id);
      if (m?.status === "ready") {
        const detail = await call(env, `/api/materials/${body.id}`, { headers: { cookie } });
        expect(((await detail.json()) as any).extracted_text).toBe("추출된 텍스트 (모킹)");
        return;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("자료 추출 대기 시간 초과");
  });
});

describe("isUsageLimitText", () => {
  it("isUsageLimitText: 세션/사용량 한도 문구를 부분 출력 뒤에 붙어 있어도 잡는다", () => {
    // 실제 사고 패턴 — 부분 JSON 뒤에 한도 안내가 붙어 완료로 통과하던 케이스
    expect(isUsageLimitText('[{"category":"문제"}] You\'ve hit your session limit · resets 3pm')).toBe(true);
    expect(isUsageLimitText("You've reached your usage limit")).toBe(true);
    expect(isUsageLimitText("Claude usage limit reached")).toBe(true);
    expect(isUsageLimitText("weekly limit reached, resets Monday")).toBe(true);
    // 정상 학습 본문은 오탐하지 않는다
    expect(isUsageLimitText("이차함수의 극한값을 구하는 문제. 정답은 ③.")).toBe(false);
    expect(isUsageLimitText('[{"category":"문제","number":"1","content":"limit of f(x)"}]')).toBe(false);
  });

});

describe("chunkTextByPages", () => {
  it("표제 없는 거대 파트도 max 이하 조각으로 강제 분할한다", async () => {
    const { chunkTextByPages } = await import("../src/books");
    const big = Array.from({ length: 50 }, (_, i) => `문단 ${i} ${"가".repeat(400)}`).join("\n\n");
    const chunks = chunkTextByPages(big, 5000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(5000);
    expect(chunks.join("").replace(/\n/g, "")).toContain("문단 49");
  });

  it("거대 파트 분할 시 페이지 표제를 이어지는 조각에 붙인다", async () => {
    const { chunkTextByPages } = await import("../src/books");
    const big = `## 페이지 37\n` + Array.from({ length: 30 }, (_, i) => `문단 ${i} ${"가".repeat(400)}`).join("\n\n");
    const chunks = chunkTextByPages(big, 5000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c).toContain("페이지 37");
  });

  it("작은 파트들은 max까지 묶는다", async () => {
    const { chunkTextByPages } = await import("../src/books");
    const text = ["## 페이지 1\n짧은 내용", "## 페이지 2\n짧은 내용", "## 페이지 3\n짧은 내용"].join("\n");
    expect(chunkTextByPages(text, 25000)).toHaveLength(1);
  });
});
