import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const providerMock = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("../src/codex-provider", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/codex-provider")>(),
  getCodexProvider: () => ({ complete: providerMock.complete }),
}));

import type { QuizItemEx, SolutionItem } from "../src/claude";
import {
  CLASSIFIER_DIGEST,
  CLASSIFIER_VERSION,
  TRANSCRIPTION_GATE_VERSION,
  TRANSCRIPTION_PROMPT_DIGEST,
  canonicalEvidenceHash,
  parseCorpusManifest,
  repairAndAuditOfficialAnswers,
  type ClassificationDecision,
  type PdfEvidence,
} from "../scripts/import-exam-corpus";

let root = "";
afterEach(() => {
  providerMock.complete.mockReset();
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

const stateDir = join(process.cwd(), "data/import-exam-corpus/8166de955e4bb324c5a7b92b");
const paths = [
  "entry.json",
  "problem.pdf",
  "solution.pdf",
  "problem-chunks/v2-0000.json",
  "classification-chunks/v5-0000-7bb7cb863c8c4855.json",
  "solution-chunks/v3-0000.json",
  "problem-repair-batches/v2-0001-0012-887a45cf23efa9803a062b29c0b1c135b8ba15f2c9d9398bcef50dd45bedb96f.json",
].map((path) => join(stateDir, path));
const available = paths.every(existsSync);
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const writeJson = (path: string, value: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

describe("Q30 exact allowlisted first-repair scope adjudication", () => {
  it.skipIf(!available)(
    "rejects the false math_A accept from six indispensable quadratic graph cases", async () => {
      root = mkdtempSync(join(tmpdir(), "studywork-q30-repair-scope-"));
      const storedEntry = JSON.parse(readFileSync(paths[0], "utf8")).entry;
      const entry = parseCorpusManifest({ schemaVersion: 2, entries: [storedEntry] }).entries[0];
      const problemBytes = readFileSync(paths[1]);
      const solutionBytes = readFileSync(paths[2]);
      const problem: PdfEvidence = {
        path: paths[1],
        sha256: hash(problemBytes),
        bytes: problemBytes.length,
        pageCount: 12,
        requestedUrl: entry.problemPdfUrl,
        resolvedUrl: entry.problemPdfUrl,
      };
      const solution: PdfEvidence = {
        path: paths[2],
        sha256: hash(solutionBytes),
        bytes: solutionBytes.length,
        pageCount: 4,
        requestedUrl: entry.solutionPdfUrl,
        resolvedUrl: entry.solutionPdfUrl,
      };
      const questions = (JSON.parse(readFileSync(paths[3], "utf8")).items as QuizItemEx[])
        .map((item) => structuredClone(item));
      const baseDecision = (JSON.parse(readFileSync(paths[4], "utf8")).items as ClassificationDecision[])
        .find((item) => item.key === "12:30")!;
      const repairedQuestion = (JSON.parse(readFileSync(paths[6], "utf8")).items as QuizItemEx[])
        .find((item) => Number(item.number) === 30)!;
      const solutions = (JSON.parse(readFileSync(paths[5], "utf8")).items as SolutionItem[])
        .map((item) => structuredClone(item));
      const decisions: ClassificationDecision[] = questions.map((question) => Number(question.number) === 30
        ? baseDecision
        : {
            key: `${question.page}:${question.number}`,
            decision: "reject",
            canonical_subject: null,
            curriculum_course: null,
            domain: null,
            achievement_codes: [],
            confidence: 0.99,
            reason_codes: ["OUT_OF_SCOPE"],
            transcription_status: "exact",
            transcription_evidence: "공식 source pixels와 일치한다.",
          });
      const classified = questions.map((question, index) => ({ question, classification: decisions[index] }));
      writeJson(join(root, "problem-chunks", "v2-0000.json"), {
        version: 2, sourceHash: problem.sha256, from: 1, to: 12, ownedFrom: 1, ownedTo: 12,
        model: "gpt-5.6-sol", reasoningEffort: "high", items: questions,
      });
      writeJson(join(root, "classification-chunks", `v${CLASSIFIER_VERSION}-0000-${CLASSIFIER_DIGEST}.json`), {
        version: CLASSIFIER_VERSION, sourceHash: problem.sha256, from: 1, to: 12, ownedFrom: 1, ownedTo: 12,
        rulesDigest: CLASSIFIER_DIGEST, transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
        transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST, model: "gpt-5.6-sol",
        reasoningEffort: "high", items: decisions,
      });
      writeJson(join(root, "solution-chunks", "v3-0000.json"), {
        version: 3, sourceHash: solution.sha256, from: 1, to: 4, ownedFrom: 1, ownedTo: 4,
        model: "gpt-5.6-sol", reasoningEffort: "high", items: solutions,
      });

      const accept: ClassificationDecision = {
        key: "12:30",
        decision: "accept",
        canonical_subject: "math_A",
        curriculum_course: "미적분Ⅰ",
        domain: "함수의 극한과 연속",
        achievement_codes: ["12미적Ⅰ-01-03"],
        confidence: 0.99,
        reason_codes: ["IN_SCOPE_CONTINUITY"],
        transcription_status: "exact",
        transcription_evidence: "공식 12쪽의 f, g, h, 두 조건, 80f(1/2), [4점]까지 일치한다.",
      };
      const reject: ClassificationDecision = {
        key: "12:30",
        decision: "reject",
        canonical_subject: null,
        curriculum_course: null,
        domain: null,
        achievement_codes: [],
        confidence: 0.99,
        reason_codes: ["EXCLUDED_QUADRATIC_GRAPH_DEPENDENCY"],
        transcription_status: "exact",
        transcription_evidence: accept.transcription_evidence,
      };
      const calls = { extraction: 0, classification: 0, terminal: 0 };
      providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
        if (request.schema?.name === "studywork_file_quiz_items") {
          calls.extraction++;
          return { text: JSON.stringify([{ ...repairedQuestion, choiceCount: null }]) };
        }
        if (request.schema?.name === "studywork_exam_corpus_scope_adjudication") {
          calls.classification++;
          expect(request.prompt).not.toContain("scopeDecision");
          expect(request.prompt).not.toContain("IN_SCOPE_CONTINUITY");
          expect(request.prompt).toContain("official solution pages");
          return { text: JSON.stringify([reject]) };
        }
        if (request.schema?.name === "studywork_exam_corpus_classification") {
          calls.classification++;
          return { text: JSON.stringify([accept]) };
        }
        if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
          calls.terminal++;
          const inputs = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{
            key: string;
            question: string;
          }>;
          return { text: JSON.stringify(inputs.map((input) => {
            const target = input.key === "12:30";
            const exact = !target || input.question.includes("[4점]");
            return {
              key: input.key,
              status: exact ? "exact" : "mismatch",
              evidence: exact ? "공식 source pixels와 일치한다." : "공식 12쪽의 [4점]이 누락됐다.",
              scopeDecision: target && !exact ? "accept" : "reject",
              scopeConfidence: 1,
              scopeEvidence: target
                ? "공식 풀이가 이차함수 6개 그래프 개형과 교점 수 분석을 반드시 사용한다."
                : "요청 범위 밖이다.",
            };
          })) };
        }
        throw new Error(`unexpected schema ${request.schema?.name}`);
      });

      const result = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
      expect(calls).toEqual({ extraction: 1, classification: 2, terminal: 3 });
      const repair = result.repairs.find((item) => item.key === "12:30")!;
      expect(repair.revision).toBeUndefined();
      expect(repair.scopeAdjudication).toMatchObject({
        allowlistId: "ebsi-5696441-q30-repair-scope-v1",
        key: "12:30",
        classificationArtifact: { path: expect.stringMatching(/^classification-repair-scope-adjudications\/v1-/u) },
      });
      expect(result.classified.find((item) => item.classification.key === "12:30")).toMatchObject({
        question: { question: expect.stringContaining("80f") },
        classification: { decision: "reject", canonical_subject: null, transcription_status: "exact" },
      });
      expect(result.problemTerminalFidelityItems.find((item) => item.key === "12:30")).toMatchObject({
        status: "exact", scopeDecision: "reject", scopeConfidence: 1,
      });
      const beforeReplay = { ...calls };
      const replay = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
      expect(calls).toEqual(beforeReplay);
      expect(replay.auditHash).toBe(result.auditHash);
      expect(canonicalEvidenceHash(replay.repairs)).toBe(canonicalEvidenceHash(result.repairs));
    },
    90_000
  );
});
