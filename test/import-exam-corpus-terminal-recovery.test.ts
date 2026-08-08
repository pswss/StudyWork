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
  CLASSIFICATION_TERMINAL_RECOVERY_VERSION,
  CLASSIFIER_DIGEST,
  CLASSIFIER_VERSION,
  PROBLEM_TERMINAL_RECOVERY_VERSION,
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

const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const canonicalize = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]))
    : value;
const writeJson = (path: string, value: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const writeCanonicalJson = (path: string, value: unknown) =>
  writeFileSync(path, `${JSON.stringify(canonicalize(value), null, 2)}\n`);

describe("exam corpus terminal-trigger problem recovery", () => {
  it("recovers Q15's right panel once after a false-exact revision and replays immutable evidence", async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-terminal-recovery-"));
    const problemDocument = await PDFDocument.create();
    for (let page = 0; page < 6; page++) problemDocument.addPage([100, 100]);
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
        id: "ebsi:5578422",
        subject: "수학",
        examTitle: "고3 10월 학평",
        rawTitle: "고3 10월 학평 수학 나형",
        sourceRecordDate: "2019-10-15",
        sourceRecordYear: 2019,
        variant: "수학 나형",
        form: null,
        sourcePageUrl: "https://www.ebsi.co.kr/exam/5578422",
        problemPdfUrl: "https://wdown.ebsi.co.kr/5578422-problem.pdf",
        solutionPdfUrl: "https://wdown.ebsi.co.kr/5578422-solution.pdf",
        grade: 3,
        paperId: "5578422",
      }],
    }).entries[0];
    const problem: PdfEvidence = {
      path: problemPath,
      sha256: hash(problemBytes),
      bytes: problemBytes.length,
      pageCount: 6,
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

    const questions: QuizItemEx[] = Array.from({ length: 30 }, (_, index) => {
      const number = index + 1;
      return {
        number: String(number),
        qtype: "short",
        difficulty: "중",
        question: number === 15 ? "원본 Q15 축약" : `${number}번 범위 밖 문제`,
        choices: null,
        answer: String(number),
        explanation: "",
        page: number === 15 ? 6 : Math.min(6, Math.ceil(number / 5)),
        figure: number === 15,
        figure_description: number === 15 ? "오른쪽 패널에 큰 가방 모양 물건이 있다." : null,
        box: number === 15 ? [0.2, 0.8] : null,
      };
    });
    const decision = (question: QuizItemEx, status: "exact" | "mismatch"): ClassificationDecision => ({
      key: `${question.page}:${question.number}`,
      decision: "reject",
      canonical_subject: null,
      curriculum_course: null,
      domain: null,
      achievement_codes: [],
      confidence: 0.99,
      reason_codes: ["OUT_OF_SCOPE_COMBINATORICS"],
      transcription_status: status,
      transcription_evidence: status === "exact"
        ? "원본 문구와 오른쪽 패널을 모두 확인했다."
        : "원본 문구가 달라 source-grounded revision이 필요하다.",
    });
    const decisions = questions.map((question) => decision(question, question.number === "15" ? "mismatch" : "exact"));
    const classified = questions.map((question, index) => ({ question, classification: decisions[index] }));
    const solutions: SolutionItem[] = questions.map((question) => ({
      number: question.number!,
      answer: question.answer,
      explanation: `${question.number}번 공식 해설`,
      page: 1,
      complete: true,
    }));
    writeJson(join(root, "problem-chunks", "v2-0000.json"), {
      version: 2,
      sourceHash: problem.sha256,
      from: 1,
      to: 6,
      ownedFrom: 1,
      ownedTo: 6,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      items: questions,
    });
    writeJson(join(root, "classification-chunks", `v${CLASSIFIER_VERSION}-0000-${CLASSIFIER_DIGEST}.json`), {
      version: CLASSIFIER_VERSION,
      sourceHash: problem.sha256,
      from: 1,
      to: 6,
      ownedFrom: 1,
      ownedTo: 6,
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

    const calls = { first: 0, revision: 0, recovery: 0, classification: 0, terminal: 0 };
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_file_quiz_items") {
        const isRecovery = request.prompt.includes("FINAL SOURCE-GROUNDED RECOVERY");
        const isRevision = !isRecovery && calls.first > 0;
        if (isRecovery) calls.recovery++;
        else if (isRevision) calls.revision++;
        else calls.first++;
        if (isRecovery) {
          expect(request.prompt).toContain("학생 3명이 여러 장의 연탄");
        }
        return { text: JSON.stringify([{
          ...questions[14],
          question: isRevision || isRecovery
            ? "학생 세 명이 연탄을 나누며 운반하는 경우의 수를 구하여라."
            : "학생 세 명이 연탄을 나누게 운반하는 경우의 수를 구하여라.",
          figure_description: isRecovery
            ? "오른쪽 패널에서 학생 3명이 각자 여러 장의 연탄을 나누어 들고 운반한다."
            : "오른쪽 패널에서 학생 3명이 큰 가방 모양 물건을 들고 있다.",
          choiceCount: null,
        }]) };
      }
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        calls.classification++;
        const mismatch = request.prompt.includes("나누게 운반");
        const corrected = {
          ...questions[14],
          question: mismatch
            ? "학생 세 명이 연탄을 나누게 운반하는 경우의 수를 구하여라."
            : "학생 세 명이 연탄을 나누며 운반하는 경우의 수를 구하여라.",
        };
        return { text: JSON.stringify([decision(corrected, mismatch ? "mismatch" : "exact")]) };
      }
      if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
        calls.terminal++;
        const inputs = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{
          key: string;
          question: string;
          figure_description: string | null;
        }>;
        return { text: JSON.stringify(inputs.map((input) => {
          const q15 = input.key === "6:15";
          const exact = !q15 || input.figure_description?.includes("여러 장의 연탄");
          return {
            key: input.key,
            status: exact ? "exact" : "mismatch",
            evidence: q15 && !exact
              ? "원본 6쪽 오른쪽 패널은 학생 3명이 여러 장의 연탄을 들고 있으나 전사는 큰 가방으로 바꿨다."
              : "원본 픽셀과 최종 전사가 일치한다.",
            scopeDecision: q15 && input.question === "원본 Q15 축약" ? "accept" : "reject",
            scopeConfidence: 0.99,
            scopeEvidence: q15
              ? "원본은 조합 영역이며 요청한 math_A/math_B 범위 밖이다."
              : "요청 범위 밖임을 원본에서 확인했다.",
          };
        })) };
      }
      throw new Error(`unexpected schema ${request.schema?.name}`);
    });

    const repaired = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
    expect(calls).toEqual({ first: 1, revision: 1, recovery: 1, classification: 3, terminal: 4 });
    expect(PROBLEM_TERMINAL_RECOVERY_VERSION).toBe(2);
    expect(CLASSIFICATION_TERMINAL_RECOVERY_VERSION).toBe(2);
    expect(repaired.repairs).toHaveLength(1);
    const repair = repaired.repairs[0];
    expect(repair).toMatchObject({
      key: "6:15",
      revision: {
        recovery: {
          problemArtifact: { path: expect.stringMatching(/^problem-recoveries\/v2-/u) },
          classificationArtifact: { path: expect.stringMatching(/^classification-recoveries\/v2-/u) },
          trigger: {
            kind: "terminal",
            evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
            terminalCheckpoint: { path: expect.stringMatching(/^problem-terminal-fidelity\/v2-/u) },
            terminalItemHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
            terminalItem: { key: "6:15", status: "mismatch", scopeDecision: "reject", scopeConfidence: 0.99 },
            preRecoveryEffectiveCorpusHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          },
        },
      },
    });
    const recovery = repair.revision!.recovery!;
    const recoveryProblemPath = join(root, recovery.problemArtifact.path);
    const recoveryProblem = JSON.parse(readFileSync(recoveryProblemPath, "utf8"));
    expect(recoveryProblem).toMatchObject({
      version: 2,
      basis: {
        trigger: recovery.trigger,
        baseProblemRevisionArtifact: repair.revision!.problemArtifact,
        baseClassificationRevisionArtifact: {
          path: repair.revision!.classificationArtifact.path,
          sha256: repair.revision!.classificationArtifact.sha256,
        },
      },
      item: { figure_description: expect.stringContaining("학생 3명이 각자 여러 장의 연탄") },
    });
    expect(JSON.parse(readFileSync(join(root, recovery.classificationArtifact.path), "utf8"))).toMatchObject({
      version: 2,
      items: [{ decision: "reject", canonical_subject: null, transcription_status: "exact" }],
    });
    expect(repaired.classified[14]).toMatchObject({
      question: { figure_description: expect.stringContaining("여러 장의 연탄") },
      classification: { decision: "reject", canonical_subject: null, transcription_status: "exact" },
    });
    expect(repaired.problemTerminalFidelityItems.find((item) => item.key === "6:15")).toMatchObject({
      status: "exact",
      scopeDecision: "reject",
    });
    expect(repaired.auditPath).toMatch(/^answer-audit\/v4-/u);

    const beforeReplay = { ...calls };
    const replay = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
    expect(calls).toEqual(beforeReplay);
    expect(replay.auditHash).toBe(repaired.auditHash);
    expect(canonicalEvidenceHash(replay.repairs)).toBe(canonicalEvidenceHash(repaired.repairs));

    const originalRecoveryProblem = structuredClone(recoveryProblem);
    recoveryProblem.basis.trigger.terminalItem.scopeEvidence = "tampered";
    writeCanonicalJson(recoveryProblemPath, recoveryProblem);
    await expect(repairAndAuditOfficialAnswers(
      entry, problem, solution, root, classified, solutions
    )).rejects.toThrow("기존 problem recovery 메타데이터가 다릅니다");
    writeCanonicalJson(recoveryProblemPath, originalRecoveryProblem);

    const finalTerminal = repaired.problemTerminalFidelityCheckpoints.find((checkpoint) =>
      repaired.classified[14].question.page! >= checkpoint.ownedFrom &&
      repaired.classified[14].question.page! <= checkpoint.ownedTo
    )!;
    const finalTerminalPath = join(root, finalTerminal.path);
    const finalTerminalCheckpoint = JSON.parse(readFileSync(finalTerminalPath, "utf8"));
    const q15 = finalTerminalCheckpoint.items.find((item: { key: string }) => item.key === "6:15");
    q15.status = "mismatch";
    q15.evidence = "복구 후에도 오른쪽 패널이 다르다.";
    writeCanonicalJson(finalTerminalPath, finalTerminalCheckpoint);
    await expect(repairAndAuditOfficialAnswers(
      entry, problem, solution, root, classified, solutions
    )).rejects.toThrow("problem recovery는 한 번만 허용됩니다");
  });
});
