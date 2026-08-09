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
  ANSWER_ATTESTATION_VERSION,
  CLASSIFIER_DIGEST,
  CLASSIFIER_VERSION,
  PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_ALLOWLIST,
  PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_PROMPT_DIGEST,
  PROBLEM_REPAIR_POSITIVE_SCOPE_AUTHORITY_REASON_CODE,
  PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_VERSION,
  TRANSCRIPTION_GATE_VERSION,
  TRANSCRIPTION_PROMPT_DIGEST,
  canonicalEvidenceHash,
  parseCorpusManifest,
  repairAndAuditOfficialAnswers,
  writeAnswerAttestation,
  type ClassificationDecision,
  type PdfEvidence,
} from "../scripts/import-exam-corpus";

let root = "";
afterEach(() => {
  providerMock.complete.mockReset();
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

const sourceDir = join(process.cwd(), "data/import-exam-corpus/88ece0f684366acb34508a33");
const paths = [
  "entry.json",
  "problem.pdf",
  "solution.pdf",
  "problem-chunks/v2-0000.json",
  "classification-chunks/v5-0000-7bb7cb863c8c4855.json",
  "solution-chunks/v3-0000.json",
  "problem-repair-batches/v2-0001-0012-0cf8fce1fd20ed982e20fc24be1630867ad7274f2701e4f13a35e6d139fa9a67.json",
  "classification-repair-batches/v1-0001-0012-22b1569e761ca3919b4170ce6b2cd54d89bb965a820acd70972557ad522a941b-7bb7cb863c8c4855.json",
].map((path) => join(sourceDir, path));
const available = paths.every(existsSync);
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const writeJson = (path: string, value: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const canonicalize = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]))
    : value;
const writeCanonicalJson = (path: string, value: unknown) => writeJson(path, canonicalize(value));

describe("Q10 exact allowlisted positive first-repair scope adjudication", () => {
  it("pins the one positive authority to the official sources and integral code", () => {
    expect(PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_VERSION).toBe(1);
    expect(PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_PROMPT_DIGEST).toMatch(/^[a-f0-9]{64}$/u);
    expect(PROBLEM_REPAIR_POSITIVE_SCOPE_AUTHORITY_REASON_CODE).toBe("ALLOWLISTED_POSITIVE_SCOPE_AUTHORITY");
    expect(PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_ALLOWLIST).toEqual([{
      allowlistId: "ebsi-5772822-q10-repair-positive-scope-v1",
      entryId: "ebsi:5772822",
      key: "3:10",
      sourcePage: 3,
      sourceHash: "fa4a52e9b15510c1ee3e37da0fcb509f203587e15f0baf7797ecf30608fb2f03",
      solutionSourceHash: "57002552ef8099128b23b2c336946616eded2a741a432fd41919e3e6a6bfa2a9",
      expectedCanonicalSubject: "math_A",
      allowedAchievementCodes: ["12수학Ⅱ03-04"],
    }]);
  });

  it.skipIf(!available)(
    "keeps exact Q10 as math_A despite the terminal Riemann-sum false reject", async () => {
      root = mkdtempSync(join(tmpdir(), "studywork-q10-positive-scope-"));
      const storedEntry = JSON.parse(readFileSync(paths[0], "utf8")).entry;
      const entry = parseCorpusManifest({ schemaVersion: 2, entries: [storedEntry] }).entries[0];
      const problemBytes = readFileSync(paths[1]);
      const solutionBytes = readFileSync(paths[2]);
      const problemPath = join(root, "official-problem.pdf");
      const solutionPath = join(root, "official-solution.pdf");
      writeFileSync(problemPath, problemBytes);
      writeFileSync(solutionPath, solutionBytes);
      const problem: PdfEvidence = {
        path: problemPath, sha256: hash(problemBytes), bytes: problemBytes.length, pageCount: 12,
        requestedUrl: entry.problemPdfUrl, resolvedUrl: entry.problemPdfUrl,
      };
      const solution: PdfEvidence = {
        path: solutionPath, sha256: hash(solutionBytes), bytes: solutionBytes.length, pageCount: 4,
        requestedUrl: entry.solutionPdfUrl, resolvedUrl: entry.solutionPdfUrl,
      };
      const questions = (JSON.parse(readFileSync(paths[3], "utf8")).items as QuizItemEx[])
        .map((item) => structuredClone(item));
      const baseDecision = (JSON.parse(readFileSync(paths[4], "utf8")).items as ClassificationDecision[])
        .find((item) => item.key === "3:10")!;
      const solutions = (JSON.parse(readFileSync(paths[5], "utf8")).items as SolutionItem[])
        .map((item) => structuredClone(item));
      const repairedQuestion = (JSON.parse(readFileSync(paths[6], "utf8")).items as QuizItemEx[])
        .find((item) => Number(item.number) === 10)!;
      const repairAccept = (JSON.parse(readFileSync(paths[7], "utf8")).items as ClassificationDecision[])
        .find((item) => item.key === "3:10")!;
      expect(repairAccept.reason_codes).not.toContain(PROBLEM_REPAIR_POSITIVE_SCOPE_AUTHORITY_REASON_CODE);
      const decisions: ClassificationDecision[] = questions.map((question) => Number(question.number) === 10
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

      const positiveAccept: ClassificationDecision = {
        ...repairAccept,
        confidence: 0.99,
        reason_codes: ["IN_SCOPE_RIEMANN_SUM_DEFINITION", PROBLEM_REPAIR_POSITIVE_SCOPE_AUTHORITY_REASON_CODE],
        transcription_evidence: "공식 3쪽의 함수, 리만 합, [3점], 선택지가 모두 일치한다.",
      };
      const calls = { extraction: 0, classification: 0, scope: 0, terminal: 0, fidelity: 0, semantic: 0 };
      providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
        if (request.schema?.name === "studywork_file_quiz_items") {
          calls.extraction++;
          return { text: JSON.stringify([{ ...repairedQuestion, choiceCount: 5 }]) };
        }
        if (request.schema?.name === "studywork_exam_corpus_classification") {
          calls.classification++;
          return { text: JSON.stringify([repairAccept]) };
        }
        if (request.schema?.name === "studywork_exam_corpus_scope_adjudication") {
          calls.scope++;
          expect(request.prompt).toContain("owning official solution");
          expect(request.prompt).toContain("standard definition of an in-scope concept");
          expect(request.prompt).not.toContain("scopeDecision");
          expect(request.prompt).not.toContain("리만합을 처리하려면 n→∞인 수열의 극한이 필요");
          return { text: JSON.stringify([positiveAccept]) };
        }
        if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
          calls.terminal++;
          const inputs = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{
            key: string; question: string;
          }>;
          return { text: JSON.stringify(inputs.map((input) => {
            const target = input.key === "3:10";
            const exact = !target || input.question.includes("[3점]");
            return {
              key: input.key,
              status: exact ? "exact" : "mismatch",
              evidence: exact ? "공식 source pixels와 일치한다." : "공식 3쪽의 [3점]이 누락됐다.",
              scopeDecision: target && exact ? "reject" : target ? "accept" : "reject",
              scopeConfidence: 0.98,
              scopeEvidence: target
                ? "n→∞ 표기를 독립적인 수열의 극한 의존으로 판정했다."
                : "요청 범위 밖이다.",
            };
          })) };
        }
        if (request.schema?.name === "studywork_exam_corpus_solution_fidelity") {
          calls.fidelity++;
          return { text: JSON.stringify([{
            key: "3:10", sourcePage: 1, answerStatus: "exact", explanationStatus: "exact",
            evidence: "공식 해설의 리만 합과 정적분 계산이 일치한다.",
          }]) };
        }
        if (request.schema?.name === "studywork_exam_corpus_semantic_choice_check") {
          calls.semantic++;
          return { text: JSON.stringify([{
            key: "3:10", status: "resolved", choiceIndex: 1,
            evidence: "공식 해설의 값 9는 선택지 ①이다.",
          }]) };
        }
        throw new Error(`unexpected schema ${request.schema?.name}`);
      });

      const result = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
      expect(calls).toEqual({ extraction: 1, classification: 1, scope: 1, terminal: 3, fidelity: 1, semantic: 1 });
      const repair = result.repairs.find((item) => item.key === "3:10")!;
      expect(repair.revision).toBeUndefined();
      expect(repair.scopeAdjudication).toMatchObject({
        allowlistId: "ebsi-5772822-q10-repair-positive-scope-v1",
        key: "3:10",
        classificationArtifact: {
          path: expect.stringMatching(/^classification-repair-positive-scope-adjudications\/v1-/u),
        },
      });
      expect(repair.scopeAdjudication!.baseClassificationHash)
        .not.toBe(repair.scopeAdjudication!.effectiveClassificationHash);
      expect(result.classified.find((item) => item.classification.key === "3:10")).toMatchObject({
        question: { question: expect.stringContaining("[3점]") },
        classification: {
          decision: "accept", canonical_subject: "math_A", achievement_codes: ["12수학Ⅱ03-04"],
          transcription_status: "exact",
        },
      });
      expect(result.problemTerminalFidelityItems.find((item) => item.key === "3:10")).toMatchObject({
        status: "exact", scopeDecision: "reject", scopeConfidence: 0.98,
      });
      expect(result.auditPath).toMatch(/^answer-audit\/v5-/u);
      const attestation = await writeAnswerAttestation(
        root, entry.id, problem.sha256, solution.sha256,
        { version: 2, status: "committed", entryId: entry.id }, result
      );
      expect(attestation.path).toMatch(new RegExp(`^answer-attestation/v${ANSWER_ATTESTATION_VERSION}-`, "u"));

      const beforeReplay = { ...calls };
      const replay = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
      expect(calls).toEqual(beforeReplay);
      expect(replay.auditHash).toBe(result.auditHash);
      expect(canonicalEvidenceHash(replay.repairs)).toBe(canonicalEvidenceHash(result.repairs));

      const childPath = join(root, repair.scopeAdjudication!.classificationArtifact.path);
      const originalChild = readFileSync(childPath);
      const staleResult = structuredClone(result);
      const staleRepair = staleResult.repairs.find((item) => item.key === "3:10")!;
      const staleAdjudication = staleRepair.scopeAdjudication!;
      const staleTerminalCheckpoint = JSON.parse(readFileSync(
        join(root, staleAdjudication.trigger.terminalCheckpoint.path),
        "utf8"
      ));
      const stalePreCorpus = result.classified.map((item) => item.classification.key === "3:10"
        ? { ...item, classification: { ...repairAccept, reason_codes: ["STALE_SAME_QUESTION_GENERATION"] } }
        : item);
      const staleEffectiveCorpusHash = canonicalEvidenceHash(stalePreCorpus);
      staleTerminalCheckpoint.effectiveCorpusHash = staleEffectiveCorpusHash;
      const staleTerminalRelativePath = `problem-terminal-fidelity/v2-0000-${staleEffectiveCorpusHash}-` +
        `${staleTerminalCheckpoint.inputHash}.json`;
      writeCanonicalJson(join(root, staleTerminalRelativePath), staleTerminalCheckpoint);
      staleAdjudication.trigger.preAdjudicationEffectiveCorpusHash = staleEffectiveCorpusHash;
      staleAdjudication.trigger.terminalCheckpoint = {
        ...staleAdjudication.trigger.terminalCheckpoint,
        path: staleTerminalRelativePath,
        sha256: canonicalEvidenceHash(staleTerminalCheckpoint),
      };
      const staleChild = JSON.parse(originalChild.toString());
      staleChild.basis.trigger = staleAdjudication.trigger;
      staleChild.basisDigest = canonicalEvidenceHash(staleChild.basis);
      const staleChildRelativePath = "classification-repair-positive-scope-adjudications/" +
        `v1-0003-0010-${staleChild.basisDigest}-${CLASSIFIER_DIGEST}.json`;
      writeCanonicalJson(join(root, staleChildRelativePath), staleChild);
      staleAdjudication.classificationArtifact.path = staleChildRelativePath;
      staleAdjudication.classificationArtifact.sha256 = canonicalEvidenceHash(staleChild);
      rmSync(childPath);
      await expect(writeAnswerAttestation(
        root, entry.id, problem.sha256, solution.sha256,
        { version: 2, status: "committed", entryId: entry.id }, staleResult
      )).rejects.toThrow("positive repair scope terminal checkpoint가 다릅니다");
      expect(calls).toEqual(beforeReplay);
      rmSync(join(root, staleChildRelativePath));
      rmSync(join(root, staleTerminalRelativePath));
      writeFileSync(childPath, originalChild);

      writeFileSync(problem.path, Buffer.concat([problemBytes, Buffer.from("tamper")]));
      await expect(repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions))
        .rejects.toThrow("공식 source bytes hash가 다릅니다");
      expect(calls).toEqual(beforeReplay);
      writeFileSync(problem.path, problemBytes);

      writeFileSync(solution.path, Buffer.concat([solutionBytes, Buffer.from("tamper")]));
      await expect(repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions))
        .rejects.toThrow("공식 source bytes hash가 다릅니다");
      expect(calls).toEqual(beforeReplay);
      writeFileSync(solution.path, solutionBytes);

      const tamperedChild = JSON.parse(originalChild.toString()) as { items: ClassificationDecision[] };
      tamperedChild.items[0].achievement_codes = ["12수학Ⅱ03-03"];
      writeJson(childPath, tamperedChild);
      await expect(repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions))
        .rejects.toThrow(/scope adjudication hash|허용된 final scope|허용 범위 밖 성취기준/u);
      expect(calls).toEqual(beforeReplay);
      writeFileSync(childPath, originalChild);

      writeFileSync(join(root, "classification-repair-positive-scope-adjudications", "orphan.json"), "{}\n");
      await expect(repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions))
        .rejects.toThrow("problem repair scope adjudication orphan/conflict");
      expect(calls).toEqual(beforeReplay);
    },
    90_000
  );
});
