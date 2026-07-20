import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PDFDocument } from "pdf-lib";

const mock = vi.hoisted(() => ({
  calls: 0,
  failAt: new Set<number>(),
  result: ((args: any) => {
    const range = /pages (\d+)-(\d+)/.exec(String(args.prompt));
    const from = range ? Number(range[1]) : 1;
    const to = range ? Number(range[2]) : 1;
    return JSON.stringify(Array.from({ length: to - from + 1 }, (_, index) => ({
      page: from + index,
      markdown: `추출된 학습 본문 ${from + index}`,
    })));
  }) as string | ((args: any) => string),
  handler: undefined as undefined | ((args: any) => Promise<void>),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: any) => ({
    async *[Symbol.asyncIterator]() {
      const call = ++mock.calls;
      await mock.handler?.(args);
      if (mock.failAt.has(call)) throw new Error("mock failure");
      const result = typeof mock.result === "function" ? mock.result(args) : mock.result;
      yield { type: "result", subtype: "success", result };
    },
  }),
}));

import {
  consolidate,
  DEFAULT_AGENT_TIMEOUT_MS,
  detectAnswerKeyPagesFromFile,
  extractFromFile,
  extractProblemsFromFile,
  extractQuestionsFromFile,
  generateQuestions,
} from "../src/claude";

let dir: string;
const originalProvider = process.env.STUDYWORK_AI_PROVIDER;
beforeEach(() => {
  process.env.STUDYWORK_AI_PROVIDER = "claude-cli";
  dir = mkdtempSync(join(tmpdir(), "studywork-agent-test-"));
  mock.calls = 0;
  mock.failAt.clear();
  mock.result = (args: any) => {
    const range = /pages (\d+)-(\d+)/.exec(String(args.prompt));
    const from = range ? Number(range[1]) : 1;
    const to = range ? Number(range[2]) : 1;
    return JSON.stringify(Array.from({ length: to - from + 1 }, (_, index) => ({
      page: from + index,
      markdown: `추출된 학습 본문 ${from + index}`,
    })));
  };
  mock.handler = undefined;
});
afterEach(() => {
  if (originalProvider === undefined) delete process.env.STUDYWORK_AI_PROVIDER;
  else process.env.STUDYWORK_AI_PROVIDER = originalProvider;
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("Agent 실행 경계", () => {
  it("대용량 선택 자료를 제한된 균등 발췌로 생성한 뒤 독립 검산", async () => {
    const prompts: string[] = [];
    const validQuiz = [
      {
        qtype: "mcq", difficulty: "하", question: "1+1은?",
        choices: ["1", "2", "3", "4"], answer: "2", explanation: "1+1=2이다.",
      },
      {
        qtype: "ox", difficulty: "중", question: "짝수와 짝수의 합은 짝수이다.",
        choices: null, answer: "O", explanation: "2a+2b=2(a+b)이다.",
      },
      {
        qtype: "short", difficulty: "상", question: "x+1=3의 해는?",
        choices: null, answer: "2", explanation: "양변에서 1을 빼면 x=2이다.",
      },
    ];
    mock.result = JSON.stringify(validQuiz);
    mock.handler = async ({ prompt }) => { prompts.push(String(prompt)); };

    await expect(generateQuestions("수학", [
      { title: "상권", extracted_text: "가".repeat(300_000) },
      { title: "하권", extracted_text: "나".repeat(300_000) },
    ], 3, "혼합")).resolves.toHaveLength(3);

    expect(prompts).toHaveLength(2);
    expect(prompts.every((prompt) => prompt.length < 120_000)).toBe(true);
    expect(prompts[0]).toContain("상권");
    expect(prompts[0]).toContain("하권");
    expect(prompts[0]).toContain("fenced ASCII diagram");
    expect(prompts[1]).toContain("independently solve every item");
  });

  it("모호한 객관식 출력을 거부하고 새 배열로 재시도", async () => {
    const invalid = [{
      qtype: "mcq", difficulty: "중", question: "2+2는?",
      choices: ["1", "2", "3", "4"], answer: "5", explanation: "잘못된 해설",
    }];
    const valid = [{
      qtype: "mcq", difficulty: "중", question: "2+2는?",
      choices: ["1", "2", "3", "4"], answer: "4", explanation: "2+2=4이다.",
    }];
    mock.result = () => JSON.stringify(mock.calls === 1 ? invalid : valid);

    await expect(generateQuestions("수학", [
      { title: "산수", extracted_text: "2+2=4" },
    ], 1, "중")).resolves.toEqual([expect.objectContaining({ answer: "4" })]);
    expect(mock.calls).toBe(3); // 초안 실패 1회 + 초안 성공 + 독립 검산
  });

  it("작은·긴 단권화의 모든 단계에 같은 시각 가독성 규칙을 적용", async () => {
    const prompts: string[] = [];
    mock.result = "## 정리\n\n핵심";
    mock.handler = async ({ prompt }) => { prompts.push(String(prompt)); };

    await consolidate("수학", [{ title: "짧은 자료", extracted_text: "개념" }]);
    await consolidate("수학", [{ title: "긴 자료", extracted_text: "개념".repeat(15_001) }]);

    expect(prompts).toHaveLength(4); // 짧은 1회 + 긴 청크 2회·병합 1회
    for (const prompt of prompts) {
      expect(prompt).toContain("<mark>...</mark>");
      expect(prompt).toContain("> **주의/함정**");
      expect(prompt).toContain("at most two sentences");
      expect(prompt).toContain("one canonical entry");
      expect(prompt).toContain("rectangular formula box");
      expect(prompt).toContain("blank line before and after every display formula");
      expect(prompt).toContain("never use a literal | character");
      expect(prompt).toContain("Do not include source labels");
    }
  });

  it("긴 단권화 하나가 AI 슬롯을 2개까지만 사용", async () => {
    let active = 0;
    let peak = 0;
    mock.result = "## 정리\n\n핵심";
    mock.handler = async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    };

    await consolidate("수학", [{ title: "긴 자료", extracted_text: "개념".repeat(30_001) }]);
    expect(peak).toBe(2);
  });

  it("단권화 결과의 표 안 수식 파이프를 저장 전에 안전한 LaTeX로 바꾼다", async () => {
    mock.result = String.raw`| 구분 | 계산 |
|---|---|
| 거리 | $\int_a^b|v(t)|\,dt$ |`;

    const note = await consolidate("수학", [{ title: "운동", extracted_text: "속력" }]);
    expect(note).toContain(String.raw`\int_a^b\vert{}v(t)\vert{}\,dt`);
  });

  it("Read를 지정 파일 하나로 제한하고 사용자 설정을 격리", async () => {
    const allowed = join(dir, "자료 이미지.png");
    const secret = join(dir, "secret.txt");
    writeFileSync(allowed, "image");
    writeFileSync(secret, "secret");
    mock.handler = async ({ prompt, options }) => {
      expect(options.permissionMode).toBeUndefined();
      expect(options.allowDangerouslySkipPermissions).toBeUndefined();
      expect(options.allowedTools).toBeUndefined();
      expect(options.settingSources).toEqual([]);
      expect(options.skills).toEqual([]);
      expect(options.mcpServers).toEqual({});
      expect(options.plugins).toEqual([]);
      expect(options.strictMcpConfig).toBe(true);
      expect(options.cwd).toBe(dirname(realpathSync(allowed)));
      expect(prompt).not.toContain(dir);
      expect(prompt).toContain(basename(allowed));
      await expect(options.canUseTool("Read", { file_path: basename(allowed) })).resolves.toMatchObject({
        behavior: "allow",
        updatedInput: { file_path: basename(allowed) },
      });
      await expect(options.canUseTool("Read", { file_path: secret })).resolves.toMatchObject({ behavior: "deny" });
      await expect(options.canUseTool("Bash", { command: "pwd" })).resolves.toMatchObject({ behavior: "deny" });
    };

    await expect(extractFromFile(allowed, "image")).resolves.toContain("## 페이지 1");
  });

  it("외부 취소 신호가 진행 중 Agent를 중단하고 타이머를 정리", async () => {
    vi.useFakeTimers();
    const file = join(dir, "자료.png");
    writeFileSync(file, "image");
    mock.handler = async ({ options }) => {
      const signal: AbortSignal = options.abortController.signal;
      if (signal.aborted) throw new Error("aborted");
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      );
    };
    const controller = new AbortController();
    const pending = expect(extractFromFile(file, "image", undefined, undefined, controller.signal)).rejects.toThrow("사용자 중단");
    controller.abort();
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("시간 초과 시 Agent를 중단", async () => {
    vi.useFakeTimers();
    const file = join(dir, "자료.png");
    writeFileSync(file, "image");
    mock.handler = async ({ options }) => {
      const signal: AbortSignal = options.abortController.signal;
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      );
    };
    const pending = expect(extractFromFile(file, "image")).rejects.toThrow("응답 시간 초과");
    await vi.advanceTimersByTimeAsync(DEFAULT_AGENT_TIMEOUT_MS);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("PDF 구간 하나라도 실패하면 부분 결과를 반환하지 않음", async () => {
    const pdf = await PDFDocument.create();
    for (let i = 0; i < 7; i++) pdf.addPage();
    const file = join(dir, "긴 자료.pdf");
    writeFileSync(file, await pdf.save());
    mock.failAt.add(2);
    mock.failAt.add(3); // 실패 청크 1회 자동 재시도도 실패
    await expect(extractFromFile(file, "pdf")).rejects.toThrow("페이지 구간 1/2개");
  });

  it("자료 재시도는 영속 체크포인트의 성공 청크를 건너뛰고 실패 청크만 호출", async () => {
    const pdf = await PDFDocument.create();
    for (let i = 0; i < 7; i++) pdf.addPage();
    const file = join(dir, "청크 이어하기.pdf");
    writeFileSync(file, await pdf.save());
    const cache = new Map<number, string>();
    const retryCounts: number[] = [];
    const plans: Array<[number, number]> = [];
    const checkpoint = {
      load: async (index: number) => cache.get(index) ?? null,
      save: async (index: number, _from: number, _to: number, content: string) => {
        cache.set(index, content);
      },
      onPlan: async (completed: number, total: number) => { plans.push([completed, total]); },
      onRetry: async (count: number) => { retryCounts.push(count); },
    };

    mock.failAt.add(2);
    mock.failAt.add(3);
    await expect(extractFromFile(
      file,
      "pdf",
      undefined,
      undefined,
      undefined,
      undefined,
      checkpoint
    )).rejects.toThrow("페이지 구간 1/2개");
    expect(cache.size).toBe(1);
    expect(mock.calls).toBe(3);
    expect(plans).toEqual([[0, 2]]);

    mock.failAt.clear();
    const result = await extractFromFile(
      file,
      "pdf",
      undefined,
      undefined,
      undefined,
      undefined,
      checkpoint
    );
    expect(mock.calls).toBe(4);
    expect(result).toContain("## 페이지 1");
    expect(result).toContain("## 페이지 7");
    expect(plans).toEqual([[0, 2], [1, 2]]);
    expect(retryCounts).toEqual([1, 1, 0]);
  });

  it("문제 출처 페이지가 실제 파일 범위를 벗어나면 저장 전에 거부", async () => {
    const image = join(dir, "문제.jpg");
    writeFileSync(image, "image");
    mock.handler = async ({ prompt }) => {
      expect(prompt).not.toContain(dir);
      expect(prompt).toContain(basename(image));
    };
    mock.result = JSON.stringify([{
      qtype: "short",
      difficulty: "중",
      question: "문제",
      choices: null,
      choiceCount: null,
      answer: "답",
      explanation: "해설",
      page: 99,
      figure: false,
      box: null,
    }]);
    await expect(extractProblemsFromFile(image, "image")).rejects.toThrow("범위를 벗어났습니다");
  });

  it("본문 쪽과 끝 정답표 참고 쪽을 구분해 문제 추출", async () => {
    const pdf = await PDFDocument.create();
    for (let i = 0; i < 4; i++) pdf.addPage();
    const file = join(dir, "본문과 정답표.pdf");
    writeFileSync(file, await pdf.save());
    mock.handler = async ({ prompt }) => {
      expect(prompt).toContain("first 2 attached page image(s)");
      expect(prompt).toContain("original document pages 8-9");
      expect(prompt).toContain("official answer-table pages from original PDF pages 361, 362");
      expect(prompt).toContain("exactly ONE item per printed problem block");
      expect(prompt).toContain("NEVER emit worked examples or illustrative question blocks from concept");
    };
    mock.result = JSON.stringify([{
      qtype: "mcq",
      difficulty: "중",
      question: "옳은 것을 고르시오.",
      choices: ["① A", "② B", "③ C", "④ D", "⑤ E"],
      choiceCount: 5,
      answer: "③",
      explanation: "",
      page: 8,
      figure: false,
      box: null,
    }]);

    await expect(extractProblemsFromFile(file, "pdf", {
      sliceBase: 8,
      contentPageCount: 2,
      answerKeyPages: [361, 362],
    })).resolves.toEqual([
      expect.objectContaining({ page: 8, answer: "③ C", explanation: "", choices: expect.any(Array) }),
    ]);
  });

  it("마지막 청크에서 실제 공식 정답표 쪽만 탐지", async () => {
    const pdf = await PDFDocument.create();
    for (let i = 0; i < 4; i++) pdf.addPage();
    const file = join(dir, "끝부분.pdf");
    writeFileSync(file, await pdf.save());
    mock.handler = async ({ prompt }) => {
      expect(prompt).toContain("original PDF pages 359-362");
      expect(prompt).toContain("official answer table");
    };
    mock.result = JSON.stringify([{ page: 362 }, { page: 361 }, { page: 361 }]);

    await expect(detectAnswerKeyPagesFromFile(file, 359)).resolves.toEqual([361, 362]);
  });

  it("오답 PDF도 한 구간 실패 시 일부 문제만 반환하지 않음", async () => {
    const pdf = await PDFDocument.create();
    for (let i = 0; i < 7; i++) pdf.addPage();
    const file = join(dir, "오답.pdf");
    writeFileSync(file, await pdf.save());
    mock.result = JSON.stringify([{
      qtype: "short",
      difficulty: "중",
      question: "문제",
      choices: null,
      answer: "답",
      explanation: "해설",
    }]);
    mock.failAt.add(2);
    await expect(extractQuestionsFromFile(file, "pdf")).rejects.toThrow("페이지 구간 1/2개");
  });

  it("긴 단권화의 부분 청크 하나라도 실패하면 불완전 노트를 반환하지 않음", async () => {
    mock.failAt.add(2);
    await expect(consolidate("수학", [
      { title: "상", extracted_text: "가".repeat(31_000) },
      { title: "하", extracted_text: "나".repeat(31_000) },
    ])).rejects.toThrow("단권화 부분 정리 실패");
  });
});
