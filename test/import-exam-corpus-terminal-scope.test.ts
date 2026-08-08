import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  ANSWER_ATTESTATION_VERSION,
  CLASSIFIER_DIGEST,
  CLASSIFIER_VERSION,
  TRANSCRIPTION_GATE_VERSION,
  TRANSCRIPTION_PROMPT_DIGEST,
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

const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const writeJson = (path: string, value: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

async function fixture() {
  root = mkdtempSync(join(tmpdir(), "studywork-terminal-scope-"));
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
      id: "ebsi:scope-q5",
      subject: "수학",
      examTitle: "고2 학평",
      rawTitle: "고2 학평 수학",
      sourceRecordDate: "2020-01-01",
      sourceRecordYear: 2020,
      variant: null,
      form: null,
      sourcePageUrl: "https://www.ebsi.co.kr/exam/scope-q5",
      problemPdfUrl: "https://wdown.ebsi.co.kr/scope-q5-problem.pdf",
      solutionPdfUrl: "https://wdown.ebsi.co.kr/scope-q5-solution.pdf",
      grade: 2,
      paperId: "scope-q5",
    }],
  }).entries[0];
  const problem: PdfEvidence = {
    path: problemPath,
    sha256: hash(problemBytes),
    bytes: problemBytes.length,
    pageCount: 1,
    requestedUrl: entry.problemPdfUrl,
    resolvedUrl: entry.problemPdfUrl,
  };
  const solution: PdfEvidence = {
    path: solutionPath,
    sha256: hash(solutionBytes),
    bytes: solutionBytes.length,
    pageCount: 1,
    requestedUrl: entry.solutionPdfUrl,
    resolvedUrl: entry.solutionPdfUrl,
  };
  const questions: QuizItemEx[] = Array.from({ length: 30 }, (_, index) => ({
    number: String(index + 1),
    qtype: "short",
    difficulty: "중",
    question: index === 4 ? "[오전사] 5번 문제" : `${index + 1}번 범위 밖 문제`,
    choices: null,
    answer: String(index + 1),
    explanation: "",
    page: 1,
    figure: false,
    figure_description: null,
    box: null,
  }));
  const rejectDecision = (number: number, status: "exact" | "mismatch"): ClassificationDecision => ({
    key: `1:${number}`,
    decision: "reject",
    canonical_subject: null,
    curriculum_course: null,
    domain: null,
    achievement_codes: [],
    confidence: 0.99,
    reason_codes: ["OUT_OF_SCOPE"],
    transcription_status: status,
    transcription_evidence: status === "exact" ? "원본과 일치한다." : "5번 문구가 오전사됐다.",
  });
  const decisions = questions.map((_, index) => rejectDecision(index + 1, index === 4 ? "mismatch" : "exact"));
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
  return { entry, problem, solution, questions, classified, solutions, rejectDecision };
}

type Mode = "promote" | "safe-reject" | "fallback-reject" | "accept-disagreement" | "unverifiable";
function mockMode(data: Awaited<ReturnType<typeof fixture>>, mode: Mode) {
  const calls = { terminal: 0, extract: 0, classify: 0, solution: 0 };
  providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
    if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
      calls.terminal++;
      const serializedInputs = request.prompt.split("Final questions:\n")[1];
      expect(serializedInputs).not.toContain('"decision"');
      expect(serializedInputs).not.toContain("transcription_status");
      const inputs = JSON.parse(serializedInputs) as Array<{
        key: string;
        question: string;
      }>;
      return { text: JSON.stringify(inputs.map((input) => {
        const isQ5 = input.key === "1:5";
        const initial = isQ5 && input.question.includes("오전사");
        const status = !isQ5 || (!initial && mode !== "unverifiable")
          ? "exact"
          : mode === "unverifiable" ? "unverifiable" : "mismatch";
        const scopeDecision = input.key === "1:6" || (isQ5 && (
          ["promote", "fallback-reject"].includes(mode) || (mode === "accept-disagreement" && initial)
        ))
          ? "accept"
          : "reject";
        return {
          key: input.key,
          status,
          evidence: status === "exact" ? "원본 1쪽과 일치한다." : "원본 1쪽의 5번 전사를 확인할 수 없다.",
          scopeDecision,
          scopeConfidence: 0.99,
          scopeEvidence: `원본 1쪽의 ${isQ5 ? "수열" : "범위 밖"} 개념을 확인했다.`,
        };
      })) };
    }
    if (request.schema?.name === "studywork_file_quiz_items") {
      calls.extract++;
      return { text: JSON.stringify([{
        ...data.questions[4],
        question: calls.extract === 1 ? "[원문] 5번 문제" : "[원문 재검증] 5번 문제",
        choiceCount: null,
      }]) };
    }
    if (request.schema?.name === "studywork_exam_corpus_classification") {
      calls.classify++;
      const accepted = mode === "promote" || mode === "accept-disagreement";
      return { text: JSON.stringify([accepted ? {
        key: "1:5",
        decision: "accept",
        canonical_subject: "math_B",
        curriculum_course: "2015 수학Ⅰ",
        domain: "수열",
        achievement_codes: ["12수학Ⅰ03-01"],
        confidence: 0.99,
        reason_codes: ["IN_SCOPE_SEQUENCE"],
        transcription_status: "exact",
        transcription_evidence: "원본 1쪽과 일치한다.",
      } : data.rejectDecision(5, "exact")]) };
    }
    if (request.schema?.name === "studywork_exam_corpus_solution_fidelity") {
      calls.solution++;
      return { text: JSON.stringify([{
        key: "1:5",
        sourcePage: 1,
        answerStatus: "exact",
        explanationStatus: "exact",
        evidence: "원본 1쪽 공식 답과 해설이 일치한다.",
      }]) };
    }
    throw new Error(`unexpected schema ${request.schema?.name}`);
  });
  return calls;
}

describe("exam corpus independent terminal scope", () => {
  it("repairs Q5 when independent source scope changes reject to accept", async () => {
    const data = await fixture();
    const calls = mockMode(data, "promote");
    const result = await repairAndAuditOfficialAnswers(
      data.entry, data.problem, data.solution, root, data.classified, data.solutions
    );
    expect(calls).toEqual({ terminal: 2, extract: 1, classify: 1, solution: 1 });
    expect(result.classified[4].classification).toMatchObject({
      decision: "accept",
      transcription_status: "exact",
    });
    expect(result.repairs.map((repair) => repair.key)).toEqual(["1:5"]);
    expect(result.auditPath).toMatch(/^answer-audit\/v4-/u);
    const attestation = await writeAnswerAttestation(
      root, data.entry.id, data.problem.sha256, data.solution.sha256,
      { version: 2, status: "committed", entryId: data.entry.id }, result
    );
    expect(attestation.path).toMatch(new RegExp(`^answer-attestation/v${ANSWER_ATTESTATION_VERSION}-`, "u"));
  });

  it("skips repair only for a high-confidence independent reject of the same mismatch", async () => {
    const data = await fixture();
    const calls = mockMode(data, "safe-reject");
    const result = await repairAndAuditOfficialAnswers(
      data.entry, data.problem, data.solution, root, data.classified, data.solutions
    );
    expect(calls).toEqual({ terminal: 1, extract: 0, classify: 0, solution: 0 });
    expect(result.repairs).toEqual([]);
    expect(result.classified[4].classification).toMatchObject({ decision: "reject", transcription_status: "mismatch" });
    expect(result.classified[5].classification.decision).toBe("reject");
    expect(result.problemTerminalFidelityItems.find((item) => item.key === "1:6")?.scopeDecision).toBe("accept");
    expect(result.problemTerminalFidelityItems.find((item) => item.key === "1:5")).toMatchObject({
      status: "mismatch",
      scopeDecision: "reject",
      scopeConfidence: 0.99,
    });
    expect(result.auditPath).toMatch(/^answer-audit\/v4-/u);
    await expect(writeAnswerAttestation(
      root, data.entry.id, data.problem.sha256, data.solution.sha256,
      { version: 2, status: "committed", entryId: data.entry.id },
      {
        ...result,
        problemTerminalFidelityItems: result.problemTerminalFidelityItems.map((item) =>
          item.key === "1:5" ? { ...item, status: "exact" as const } : item
        ),
      }
    )).rejects.toThrow("terminal 문제 fidelity가 최종 정책을 만족하지 않습니다");
  });

  it("falls back to repair when independent scope disagrees with the current reject", async () => {
    const data = await fixture();
    const calls = mockMode(data, "fallback-reject");
    const result = await repairAndAuditOfficialAnswers(
      data.entry, data.problem, data.solution, root, data.classified, data.solutions
    );
    expect(calls).toEqual({ terminal: 2, extract: 1, classify: 1, solution: 0 });
    expect(result.repairs.map((repair) => repair.key)).toEqual(["1:5"]);
    expect(result.classified[4].classification).toMatchObject({ decision: "reject", transcription_status: "exact" });
  });

  it("fails closed when an exact accepted classification disagrees with terminal scope", async () => {
    const data = await fixture();
    const calls = mockMode(data, "accept-disagreement");
    await expect(repairAndAuditOfficialAnswers(
      data.entry, data.problem, data.solution, root, data.classified, data.solutions
    )).rejects.toThrow("terminal 문제 fidelity가 최종 정책을 만족하지 않습니다");
    expect(calls).toEqual({ terminal: 2, extract: 1, classify: 1, solution: 0 });
  });

  it("fails closed when source fidelity remains unverifiable after the one allowed recovery", async () => {
    const data = await fixture();
    const calls = mockMode(data, "unverifiable");
    await expect(repairAndAuditOfficialAnswers(
      data.entry, data.problem, data.solution, root, data.classified, data.solutions
    )).rejects.toThrow("problem recovery는 한 번만 허용됩니다");
    expect(calls).toEqual({ terminal: 3, extract: 3, classify: 3, solution: 0 });
  });
});
