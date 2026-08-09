import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const providerMock = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("../src/codex-provider", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/codex-provider")>(),
  getCodexProvider: () => ({ complete: providerMock.complete }),
}));

import type { QuizItemEx, SolutionItem } from "../src/claude";
import {
  PROBLEM_REVISION_SCOPE_ADJUDICATION_ALLOWLIST,
  canonicalEvidenceHash,
  parseCorpusManifest,
  repairAndAuditOfficialAnswers,
  type ClassificationDecision,
  type PdfEvidence,
} from "../scripts/import-exam-corpus";

const LIVE_STATE = join(process.cwd(), "data/import-exam-corpus/04b5b5270f6444e7821cf95e");
const TERMINAL = "problem-terminal-fidelity/" +
  "v2-0000-080ed19498b56dbaf3ff72cf7d71f87e9560c8ff1cb3923340fba8a0237f5399-" +
  "76373bfd452f7373a32a430037f8c82448b4d70816a507974119556816e450f3.json";
const REVISION_TRIGGER_TERMINAL = "problem-terminal-fidelity/" +
  "v2-0000-7b4ea41df64c4fa386652f39877cbe1a44bdc0bf2ff5926e3afb9f3dd0dca8d9-" +
  "13be79e7d5bae9b8497d779bb6d2bf387d391a377b21b271f2206a224f5e556a.json";
const REQUIRED = [
  "entry.json",
  "problem.pdf",
  "solution.pdf",
  "problem-chunks/v2-0000.json",
  "classification-chunks/v5-0000-7bb7cb863c8c4855.json",
  "solution-chunks/v3-0000.json",
  TERMINAL,
].map((path) => join(LIVE_STATE, path));
const available = REQUIRED.every(existsSync);
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
let root = "";

afterEach(() => {
  providerMock.complete.mockReset();
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

function copyAuthority(relativePath: string): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(LIVE_STATE, relativePath), target);
}

describe("Q30 exact allowlisted revision-parent scope adjudication", () => {
  it("pins the rational-function revision and rejecting terminal", () => {
    expect(PROBLEM_REVISION_SCOPE_ADJUDICATION_ALLOWLIST).toContainEqual({
      allowlistId: "ebsi-5875878-q30-revision-scope-v1",
      entryId: "ebsi:5875878",
      key: "12:30",
      sourcePage: 12,
      sourceHash: "6b554bbb4cfbe16d492c76be41793d64d5fa0fdaae1aaf109aafee3bab99ea59",
      solutionSourceHash: "223c02f244c22c598e0cb72285d611c03695c133c29000b9dceb5068c43b701d",
      parentProblemArtifactHash: "2dd552325794fc05dc07f584edc440cf7e948462e6eeb1260efee7d507c62a9e",
      parentClassificationArtifactHash: "ee67e5c39a90b391b32b1779f00e3e86e2189571cc82d50741cfec00f4d9dd81",
      terminalArtifactHash: "25f8d116b90e7a17e768a264bce2d72dc0e426e178e71ac27b37bbd650f3e521",
    });
  });

  it.skipIf(!available)("replays the exact revision and rejects the false math_A accept", async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q30-revision-scope-"));
    for (const relativePath of [
      "problem-chunks/v2-0000.json",
      "classification-chunks/v5-0000-7bb7cb863c8c4855.json",
      "solution-chunks/v3-0000.json",
      TERMINAL,
      REVISION_TRIGGER_TERMINAL,
    ]) copyAuthority(relativePath);
    for (const relativePath of [
      "problem-repair-batches/v2-0001-0012-99f3ba2f76d1f0c478fe82b62c84371e267e1a9ae0420f53d5070fc5adeed9a3.json",
      "classification-repair-batches/v1-0001-0012-e9810c8af04149ca80389581db81695fc934aeb89bfdbad0d5b6681358048891-7bb7cb863c8c4855.json",
      "problem-revision-batches/v1-0001-0012-0012-eadf22c71b85d5e3c0c60df3a990fe3dabd9b9f847d4439fe77f3843fb5e6472.json",
      "classification-revision-batches/v1-0001-0012-f9f109554b66759eb80bf0e60be8861641d8b09d2a6c3f65b993bffe7673cba4-7bb7cb863c8c4855.json",
    ]) copyAuthority(relativePath);

    const storedEntry = JSON.parse(readFileSync(REQUIRED[0], "utf8")).entry;
    const entry = parseCorpusManifest({ schemaVersion: 2, entries: [storedEntry] }).entries[0];
    const problemBytes = readFileSync(REQUIRED[1]);
    const solutionBytes = readFileSync(REQUIRED[2]);
    const problem: PdfEvidence = {
      path: REQUIRED[1], sha256: hash(problemBytes), bytes: problemBytes.length, pageCount: 12,
      requestedUrl: entry.problemPdfUrl, resolvedUrl: entry.problemPdfUrl,
    };
    const solution: PdfEvidence = {
      path: REQUIRED[2], sha256: hash(solutionBytes), bytes: solutionBytes.length, pageCount: 3,
      requestedUrl: entry.solutionPdfUrl, resolvedUrl: entry.solutionPdfUrl,
    };
    const questions = (JSON.parse(readFileSync(REQUIRED[3], "utf8")).items as QuizItemEx[])
      .map((item) => structuredClone(item));
    const decisions = (JSON.parse(readFileSync(REQUIRED[4], "utf8")).items as ClassificationDecision[])
      .map((item) => structuredClone(item));
    for (const [problemBatch, classificationBatch] of [
      [
        "problem-repair-batches/v2-0001-0012-1e4fdf616632eef450be7a8c648695cf3259bbd6422f8d91aaa2c0c4934c310a.json",
        "classification-repair-batches/v1-0001-0012-c6c317019902418361307c09084e7bc99c628e1cbbebb3e756e78c03343a5e57-7bb7cb863c8c4855.json",
      ],
      [
        "problem-repair-batches/v2-0001-0012-abbe8912bb85631556a6944a98147e92b0fc2c70ee5909d4017b23ba033625ac.json",
        "classification-repair-batches/v1-0001-0012-0796c45104fe2bf4226e73987ed3aa051c147dea4593714d7bf1f12003d62400-7bb7cb863c8c4855.json",
      ],
    ] as const) {
      const repairedQuestions = (JSON.parse(readFileSync(join(LIVE_STATE, problemBatch), "utf8")) as {
        items: QuizItemEx[];
      }).items;
      const repairedDecisions = (JSON.parse(readFileSync(join(LIVE_STATE, classificationBatch), "utf8")) as {
        items: ClassificationDecision[];
      }).items;
      for (const repairedQuestion of repairedQuestions) {
        const key = `${repairedQuestion.page}:${Number(repairedQuestion.number)}`;
        const index = questions.findIndex((item) => `${item.page}:${Number(item.number)}` === key);
        questions[index] = structuredClone(repairedQuestion);
        decisions[index] = structuredClone(repairedDecisions.find((item) => item.key === key)!);
      }
    }
    const classified = questions.map((question, index) => ({ question, classification: decisions[index] }));
    const solutions = (JSON.parse(readFileSync(REQUIRED[5], "utf8")).items as SolutionItem[])
      .map((item) => structuredClone(item));
    const answerByNumber = new Map(solutions.map((item) => [Number(item.number), item.answer]));
    const terminalItems = JSON.parse(readFileSync(REQUIRED[6], "utf8")).items as Array<{
      key: string;
      status: "exact";
      evidence: string;
      scopeDecision: "accept" | "reject" | "review";
      scopeConfidence: number;
      scopeEvidence: string;
    }>;
    const terminalByKey = new Map(terminalItems.map((item) => [item.key, item]));
    const reject: ClassificationDecision = {
      key: "12:30",
      decision: "reject",
      canonical_subject: null,
      curriculum_course: null,
      domain: null,
      achievement_codes: [],
      confidence: 0.99,
      reason_codes: ["EXCLUDED_RATIONAL_FUNCTION_GRAPH_DEPENDENCY"],
      transcription_status: "exact",
      transcription_evidence: "공식 문제와 해설은 유리함수의 그래프·점근선·교점 개수 분석을 필수로 한다.",
    };
    const calls = { scope: 0, terminal: 0, solution: 0, semantic: 0 };
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_scope_adjudication") {
        calls.scope++;
        expect(request.prompt).not.toContain("scopeDecision");
        expect(request.prompt).toContain("official solution pages");
        return { text: JSON.stringify([reject]) };
      }
      if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
        calls.terminal++;
        const inputs = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{
          key: string;
          question: string;
        }>;
        return { text: JSON.stringify(inputs.map((input) => input.key === "12:30" &&
          input.question.includes("-\\frac{ax-b+1}{ax+b}")
          ? {
              key: input.key,
              status: "mismatch",
              evidence: "공식 p.12의 분자는 -ax-b+1이다.",
              scopeDecision: "reject",
              scopeConfidence: 0.99,
              scopeEvidence: "유리함수 그래프 분석은 허용 범위 밖이다.",
            }
          : terminalByKey.get(input.key) ?? {
              key: input.key,
              status: "exact",
              evidence: "공식 source pixels와 일치한다.",
              scopeDecision: "reject",
              scopeConfidence: 0.99,
              scopeEvidence: "요청 범위 밖이다.",
            })) };
      }
      if (request.schema?.name === "studywork_exam_corpus_solution_fidelity") {
        calls.solution++;
        const inputs = JSON.parse(request.prompt.split("Accepted solutions:\n")[1]) as Array<{
          key: string;
          source_page: number;
        }>;
        return { text: JSON.stringify(inputs.map((input) => ({
          key: input.key,
          sourcePage: input.source_page,
          answerStatus: "exact",
          explanationStatus: "exact",
          evidence: "공식 정답과 완전한 해설이 일치한다.",
        }))) };
      }
      if (request.schema?.name === "studywork_exam_corpus_semantic_choice_check") {
        calls.semantic++;
        const inputs = JSON.parse(request.prompt.split("Items:\n")[1]) as Array<{ key: string }>;
        return { text: JSON.stringify(inputs.map((input) => {
          const answer = answerByNumber.get(Number(input.key.split(":")[1])) ?? "①";
          return {
            key: input.key,
            status: "resolved",
            choiceIndex: Math.max(1, "①②③④⑤".indexOf(answer.trim()[0]) + 1),
            evidence: "공식 상세 해설과 선택지 내용을 대조했다.",
          };
        })) };
      }
      throw new Error(`unexpected schema ${request.schema?.name}: ${request.prompt.slice(0, 800)}`);
    });

    const result = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
    expect(calls.scope).toBe(1);
    const repair = result.repairs.find((item) => item.key === "12:30")!;
    expect(repair.revision?.scopeAdjudication).toMatchObject({
      allowlistId: "ebsi-5875878-q30-revision-scope-v1",
      trigger: {
        terminalCheckpoint: { sha256: "25f8d116b90e7a17e768a264bce2d72dc0e426e178e71ac27b37bbd650f3e521" },
        terminalItem: { status: "exact", scopeDecision: "reject" },
      },
    });
    expect(result.classified.find((item) => item.classification.key === "12:30")).toMatchObject({
      question: { question: expect.stringContaining("\\frac{-ax-b+1}{ax+b}") },
      classification: { decision: "reject", canonical_subject: null, transcription_status: "exact" },
    });
    const beforeReplay = { ...calls };
    const replay = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
    expect(calls).toEqual(beforeReplay);
    expect(replay.auditHash).toBe(result.auditHash);
    expect(canonicalEvidenceHash(replay.repairs)).toBe(canonicalEvidenceHash(result.repairs));
  }, 120_000);
});
