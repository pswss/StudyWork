import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";

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

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const writeJson = (path: string, value: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

describe("exam corpus page-batch problem repair", () => {
  it("resumes a frozen three-key batch, maps shuffled decisions by key, and revises one terminal mismatch once", async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-problem-batch-"));
    const problemDocument = await PDFDocument.create();
    problemDocument.addPage([100, 100]);
    const solutionDocument = await PDFDocument.create();
    solutionDocument.addPage([100, 100]);
    const problemBytes = await problemDocument.save();
    const solutionBytes = await solutionDocument.save();
    const problemPath = join(root, "problem.pdf");
    const solutionPath = join(root, "solution.pdf");
    writeFileSync(problemPath, problemBytes);
    writeFileSync(solutionPath, solutionBytes);

    const entry = parseCorpusManifest({
      schemaVersion: 2,
      entries: [{
        id: "ebsi:5696439",
        subject: "수학",
        examTitle: "고2 학평",
        rawTitle: "고2 학평 수학",
        sourceRecordDate: "2020-01-01",
        sourceRecordYear: 2020,
        variant: null,
        form: null,
        sourcePageUrl: "https://www.ebsi.co.kr/exam/5696439",
        problemPdfUrl: "https://wdown.ebsi.co.kr/5696439-problem.pdf",
        solutionPdfUrl: "https://wdown.ebsi.co.kr/5696439-solution.pdf",
        grade: 2,
        paperId: "5696439",
      }],
    }).entries[0];
    const problem: PdfEvidence = {
      path: problemPath,
      sha256: sha256(problemBytes),
      bytes: problemBytes.length,
      pageCount: 1,
      requestedUrl: entry.problemPdfUrl,
      resolvedUrl: entry.problemPdfUrl,
    };
    const solution: PdfEvidence = {
      path: solutionPath,
      sha256: sha256(solutionBytes),
      bytes: solutionBytes.length,
      pageCount: 1,
      requestedUrl: entry.solutionPdfUrl,
      resolvedUrl: entry.solutionPdfUrl,
    };
    const repairNumbers = new Set([1, 3, 24]);
    const questions: QuizItemEx[] = Array.from({ length: 30 }, (_, index) => ({
      number: String(index + 1),
      qtype: "short",
      difficulty: "중",
      question: repairNumbers.has(index + 1)
        ? `[축약된 공유 지문] ${index + 1}번`
        : `${index + 1}번 범위 밖 문제`,
      choices: null,
      answer: String(index + 1),
      explanation: "",
      page: 1,
      figure: false,
      figure_description: null,
      box: null,
    }));
    const decision = (number: number, status: "exact" | "mismatch"): ClassificationDecision => ({
      key: `1:${number}`,
      decision: number === 3 ? "accept" : "reject",
      canonical_subject: number === 3 ? "math_B" : null,
      curriculum_course: number === 3 ? "2015 수학Ⅰ" : null,
      domain: number === 3 ? "수열" : null,
      achievement_codes: number === 3 ? ["12수학Ⅰ03-01"] : [],
      confidence: 0.99,
      reason_codes: [number === 3 ? "IN_SCOPE_SEQUENCE" : "OUT_OF_SCOPE"],
      transcription_status: status,
      transcription_evidence: status === "exact" ? "원본과 일치한다." : "공유 지문이 축약됐다.",
    });
    const decisions = questions.map((_, index) => decision(
      index + 1,
      repairNumbers.has(index + 1) ? "mismatch" : "exact"
    ));
    const classified = questions.map((question, index) => ({ question, classification: decisions[index] }));
    const solutions: SolutionItem[] = questions.map((question) => ({
      number: question.number!,
      answer: question.number!,
      explanation: `${question.number}번 공식 해설`,
      page: 1,
      complete: true,
    }));
    writeJson(join(root, "problem-chunks", "v2-0000.json"), {
      version: 2,
      sourceHash: problem.sha256,
      from: 1,
      to: 1,
      ownedFrom: 1,
      ownedTo: 1,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      items: questions,
    });
    writeJson(join(root, "classification-chunks", `v${CLASSIFIER_VERSION}-0000-${CLASSIFIER_DIGEST}.json`), {
      version: CLASSIFIER_VERSION,
      sourceHash: problem.sha256,
      from: 1,
      to: 1,
      ownedFrom: 1,
      ownedTo: 1,
      rulesDigest: CLASSIFIER_DIGEST,
      transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      items: decisions,
    });
    writeJson(join(root, "solution-chunks", "v3-0000.json"), {
      version: 3,
      sourceHash: solution.sha256,
      from: 1,
      to: 1,
      ownedFrom: 1,
      ownedTo: 1,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      items: solutions,
    });

    let crashClassification = true;
    const calls = { extract: 0, classify: 0, terminal: 0, solution: 0 };
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_file_quiz_items") {
        calls.extract++;
        const numberList = calls.extract === 1 ? [24, 3, 1] : [24];
        if (calls.extract === 1) {
          expect(request.prompt).toContain("1:1, 1:24, 1:3");
          expect(request.prompt).toContain("Emit EVERY listed page:number target exactly once");
        } else {
          expect(request.prompt).toContain("SECOND SOURCE-GROUNDED REVISION");
          expect(request.prompt).toContain("Q24의 전환 문장이 축약됐다");
        }
        return { text: JSON.stringify(numberList.map((number) => ({
          ...questions[number - 1],
          question: `[공유 지문 전체와 전환 문장] ${number}번${calls.extract === 2 ? " 최종" : ""}`,
          choiceCount: null,
        }))) };
      }
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        calls.classify++;
        if (crashClassification) throw new Error("simulated batch classification interruption");
        const numbers = calls.classify === 2 ? [24, 3, 1] : [24];
        return { text: JSON.stringify(numbers.map((number) => decision(number, "exact"))) };
      }
      if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
        calls.terminal++;
        const inputs = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{ key: string }>;
        return { text: JSON.stringify(inputs.map((input) => ({
          key: input.key,
          status: calls.terminal === 1 && input.key === "1:24" ? "mismatch" : "exact",
          evidence: calls.terminal === 1 && input.key === "1:24"
            ? "Q24의 전환 문장이 축약됐다."
            : "원본 픽셀과 일치한다.",
        }))) };
      }
      if (request.schema?.name === "studywork_exam_corpus_solution_fidelity") {
        calls.solution++;
        return { text: JSON.stringify([{
          key: "1:3",
          sourcePage: 1,
          answerStatus: "exact",
          explanationStatus: "exact",
          evidence: "공식 정답과 전체 해설이 일치한다.",
        }]) };
      }
      throw new Error(`unexpected schema ${request.schema?.name}`);
    });

    await expect(repairAndAuditOfficialAnswers(
      entry, problem, solution, root, classified, solutions
    )).rejects.toThrow("simulated batch classification interruption");
    expect(calls).toEqual({ extract: 1, classify: 1, terminal: 0, solution: 0 });

    crashClassification = false;
    const repaired = await repairAndAuditOfficialAnswers(
      entry, problem, solution, root, classified, solutions
    );
    expect(calls).toEqual({ extract: 2, classify: 3, terminal: 2, solution: 1 });
    expect(repaired.repairs.map((repair) => repair.key)).toEqual(["1:1", "1:24", "1:3"]);
    expect(new Set(repaired.repairs.map((repair) => repair.problemArtifact.path)).size).toBe(1);
    expect(new Set(repaired.repairs.map((repair) => repair.classificationArtifact.path)).size).toBe(1);
    expect(repaired.repairs.find((repair) => repair.key === "1:24")?.revision).toMatchObject({
      trigger: {
        kind: "terminal",
        terminalCheckpoint: { path: expect.stringMatching(/^problem-terminal-fidelity\/v1-/u) },
        terminalItemHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      problemArtifact: { path: expect.stringMatching(/^problem-revision-batches\/v1-/u) },
      classificationArtifact: { path: expect.stringMatching(/^classification-revision-batches\/v1-/u) },
    });
    expect(repaired.classified.find((item) => item.classification.key === "1:3")?.classification.decision).toBe("accept");
    expect(repaired.classified.find((item) => item.classification.key === "1:24")?.classification.decision).toBe("reject");
    expect(repaired.problemTerminalFidelityItems).toHaveLength(30);
    expect(repaired.problemTerminalFidelityItems.every((item) => item.status === "exact")).toBe(true);
    expect(repaired.auditPath).toMatch(/^answer-audit\/v3-/u);

    const beforeReplay = { ...calls };
    const replay = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
    expect(calls).toEqual(beforeReplay);
    expect(replay.auditHash).toBe(repaired.auditHash);
    expect(canonicalEvidenceHash(replay.classified)).toBe(canonicalEvidenceHash(repaired.classified));

    const receipt = { version: 2, status: "committed", entryId: entry.id };
    await writeAnswerAttestation(root, entry.id, problem.sha256, solution.sha256, receipt, repaired);
    const childPath = join(root, repaired.problemTerminalFidelityCheckpoints[0].path);
    const child = JSON.parse(readFileSync(childPath, "utf8"));
    child.items[0].evidence = "tampered";
    writeFileSync(childPath, `${JSON.stringify(child, null, 2)}\n`);
    await expect(writeAnswerAttestation(
      root, entry.id, problem.sha256, solution.sha256, receipt, repaired
    )).rejects.toThrow("problem terminal fidelity child hash가 다릅니다");
  });
});
