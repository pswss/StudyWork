import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";

const providerMock = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("../src/codex-provider", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/codex-provider")>(),
  getCodexProvider: () => ({ complete: providerMock.complete }),
}));

import {
  TARGETED_PROBLEM_BATCH_VERSION,
  TARGETED_PROBLEM_TRANSCRIPTION_VERSION,
  type QuizItemEx,
  type SolutionItem,
} from "../src/claude";
import {
  CLASSIFIER_DIGEST,
  CLASSIFIER_VERSION,
  TRANSCRIPTION_GATE_VERSION,
  TRANSCRIPTION_PROMPT_DIGEST,
  TARGETED_PROBLEM_BATCH_PROMPT_DIGEST,
  TARGETED_PROBLEM_PROMPT_DIGEST,
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
const canonicalize = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]))
    : value;
const writeCanonicalJson = (path: string, value: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(canonicalize(value), null, 2)}\n`);
};

describe("exam corpus page-batch problem repair", () => {
  it("resumes a frozen three-key batch, maps shuffled decisions by key, and revises one terminal mismatch once", async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-problem-batch-"));
    const problemDocument = await PDFDocument.create();
    problemDocument.addPage([100, 100]);
    problemDocument.addPage([100, 100]);
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
      pageCount: 3,
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
    const repairNumbers = new Set([17, 22, 23]);
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
      page: index + 1 === 22 ? 2 : index + 1 === 23 ? 3 : 1,
      figure: false,
      figure_description: null,
      box: null,
    }));
    const decision = (number: number, status: "exact" | "mismatch"): ClassificationDecision => ({
      key: `${questions[number - 1].page}:${number}`,
      decision: number === 22 ? "accept" : "reject",
      canonical_subject: number === 22 ? "math_B" : null,
      curriculum_course: number === 22 ? "2015 수학Ⅰ" : null,
      domain: number === 22 ? "수열" : null,
      achievement_codes: number === 22 ? ["12수학Ⅰ03-01"] : [],
      confidence: 0.99,
      reason_codes: [number === 22 ? "IN_SCOPE_SEQUENCE" : "OUT_OF_SCOPE"],
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
      to: 3,
      ownedFrom: 1,
      ownedTo: 3,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      items: questions,
    });
    writeJson(join(root, "classification-chunks", `v${CLASSIFIER_VERSION}-0000-${CLASSIFIER_DIGEST}.json`), {
      version: CLASSIFIER_VERSION,
      sourceHash: problem.sha256,
      from: 1,
      to: 3,
      ownedFrom: 1,
      ownedTo: 3,
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
        const numberList = calls.extract === 1 ? [23, 22, 17] : [23];
        if (calls.extract === 1) {
          expect(request.prompt).toContain("1:17, 2:22, 3:23");
          expect(request.prompt).toContain("Emit EVERY listed page:number target exactly once");
          expect(request.prompt).toContain("Previous fidelity diagnostic");
          expect(request.prompt).toContain("공유 지문이 축약됐다");
        } else {
          expect(request.prompt).toContain("SECOND SOURCE-GROUNDED REVISION");
          expect(request.prompt).toContain("Q23의 전환 문장이 축약됐다");
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
        const numbers = calls.classify === 2 ? [1] : calls.classify === 3 ? [23, 22, 17] : [23];
        return { text: JSON.stringify(numbers.map((number) => decision(number, "exact"))) };
      }
      if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
        calls.terminal++;
        const inputs = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{ key: string; question: string }>;
        return { text: JSON.stringify(inputs.map((input) => ({
          key: input.key,
          status: input.key === "3:23" && !input.question.includes("최종") ? "mismatch" : "exact",
          evidence: input.key === "3:23" && !input.question.includes("최종")
            ? "Q23의 전환 문장이 축약됐다."
            : "원본 픽셀과 일치한다.",
          scopeDecision: input.key === "2:22" || (input.key === "3:23" && !input.question.includes("최종"))
            ? "accept"
            : "reject",
          scopeConfidence: 0.99,
          scopeEvidence: "원본 문제의 필수 개념을 페이지 픽셀에서 확인했다.",
        }))) };
      }
      if (request.schema?.name === "studywork_exam_corpus_solution_fidelity") {
        calls.solution++;
        return { text: JSON.stringify([{
          key: "2:22",
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
    expect(calls).toEqual({ extract: 1, classify: 1, terminal: 1, solution: 0 });
    const [v2Name] = readdirSync(join(root, "problem-repair-batches"));
    expect(v2Name).toMatch(/^v2-0001-0003-[a-f0-9]{64}\.json$/u);
    const v2Checkpoint = JSON.parse(readFileSync(join(root, "problem-repair-batches", v2Name), "utf8"));
    expect(v2Checkpoint).toMatchObject({
      version: 2,
      contextFrom: 1,
      contextTo: 3,
      targetsDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      diagnosticEvidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      members: [
        { key: "1:17", sourcePage: 1, baseTranscriptionEvidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u) },
        { key: "2:22", sourcePage: 2, baseTranscriptionEvidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u) },
        { key: "3:23", sourcePage: 3, baseTranscriptionEvidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      ],
    });
    expect(v2Checkpoint).not.toHaveProperty("sourcePage");
    const legacySinglePath = join(root, "problem-repairs", "v2-0001-0001.json");
    const baseProblemPath = join(root, "problem-chunks", "v2-0000.json");
    const baseSolutionPath = join(root, "solution-chunks", "v3-0000.json");
    writeCanonicalJson(legacySinglePath, {
      version: 2,
      entryId: entry.id,
      sourceHash: problem.sha256,
      key: "1:1",
      sourcePage: 1,
      printedNumber: "1",
      contextFrom: 1,
      contextTo: 3,
      baseProblemCheckpoint: { path: "problem-chunks/v2-0000.json", sha256: sha256(readFileSync(baseProblemPath)) },
      baseQuestionHash: canonicalEvidenceHash(questions[0]),
      baseSolutionCheckpoint: { path: "solution-chunks/v3-0000.json", sha256: sha256(readFileSync(baseSolutionPath)) },
      baseSolutionItemHash: canonicalEvidenceHash(solutions[0]),
      officialRawAnswerHash: sha256(solutions[0].answer),
      promptVersion: TARGETED_PROBLEM_TRANSCRIPTION_VERSION,
      promptDigest: TARGETED_PROBLEM_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      item: questions[0],
    });

    crashClassification = false;
    const repaired = await repairAndAuditOfficialAnswers(
      entry, problem, solution, root, classified, solutions
    );
    expect(calls).toEqual({ extract: 2, classify: 4, terminal: 3, solution: 1 });
    expect(repaired.repairs.map((repair) => repair.key)).toEqual(["1:1", "1:17", "2:22", "3:23"]);
    expect(new Set(repaired.repairs.map((repair) => repair.problemArtifact.path)).size).toBe(2);
    expect(new Set(repaired.repairs.map((repair) => repair.classificationArtifact.path)).size).toBe(2);
    expect(repaired.repairs.find((repair) => repair.key === "1:1")?.classificationArtifact.path)
      .toMatch(/^classification-repair-batches\/v1-/u);
    expect(existsSync(join(root, "classification-repairs"))).toBe(false);
    expect(repaired.repairs.find((repair) => repair.key === "3:23")?.revision).toMatchObject({
      trigger: {
        kind: "terminal",
        terminalCheckpoint: { path: expect.stringMatching(/^problem-terminal-fidelity\/v2-/u) },
        terminalItemHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      problemArtifact: { path: expect.stringMatching(/^problem-revision-batches\/v1-/u) },
      classificationArtifact: { path: expect.stringMatching(/^classification-revision-batches\/v1-/u) },
    });
    expect(repaired.classified.find((item) => item.classification.key === "2:22")?.classification.decision).toBe("accept");
    expect(repaired.classified.find((item) => item.classification.key === "3:23")?.classification.decision).toBe("reject");
    expect(repaired.problemTerminalFidelityItems).toHaveLength(30);
    expect(repaired.problemTerminalFidelityItems.every((item) => item.status === "exact")).toBe(true);
    expect(repaired.auditPath).toMatch(/^answer-audit\/v5-/u);

    const beforeReplay = { ...calls };
    const replay = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
    expect(calls).toEqual(beforeReplay);
    expect(replay.auditHash).toBe(repaired.auditHash);
    expect(canonicalEvidenceHash(replay.classified)).toBe(canonicalEvidenceHash(repaired.classified));

    const copiedSinglePath = join(root, "problem-repairs", "v2-9999-9999.json");
    writeFileSync(copiedSinglePath, readFileSync(legacySinglePath));
    await expect(repairAndAuditOfficialAnswers(
      entry, problem, solution, root, classified, solutions
    )).rejects.toThrow("persisted problem repair가 유효하지 않습니다");
    expect(calls).toEqual(beforeReplay);
    rmSync(copiedSinglePath);

    const overlapPath = join(root, "problem-repairs", "v2-0001-0017.json");
    const overlapMember = v2Checkpoint.members.find((member: { key: string }) => member.key === "1:17");
    writeCanonicalJson(overlapPath, {
      version: 2,
      entryId: entry.id,
      sourceHash: problem.sha256,
      key: "1:17",
      sourcePage: 1,
      printedNumber: "17",
      contextFrom: 1,
      contextTo: 3,
      baseProblemCheckpoint: overlapMember.baseProblemCheckpoint,
      baseQuestionHash: overlapMember.baseQuestionHash,
      baseSolutionCheckpoint: overlapMember.baseSolutionCheckpoint,
      baseSolutionItemHash: overlapMember.baseSolutionItemHash,
      officialRawAnswerHash: overlapMember.officialRawAnswerHash,
      promptVersion: TARGETED_PROBLEM_TRANSCRIPTION_VERSION,
      promptDigest: TARGETED_PROBLEM_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      item: v2Checkpoint.items.find((item: QuizItemEx) => item.page === 1 && item.number === "17"),
    });
    await expect(repairAndAuditOfficialAnswers(
      entry, problem, solution, root, classified, solutions
    )).rejects.toThrow("problem repair key가 중복되었습니다");
    expect(calls).toEqual(beforeReplay);
    rmSync(overlapPath);

    const mixedClassificationPath = join(
      root,
      repaired.repairs.find((repair) => repair.key === "1:17")!.classificationArtifact.path
    );
    const originalClassificationBytes = readFileSync(mixedClassificationPath);
    const mixedClassification = JSON.parse(originalClassificationBytes.toString("utf8"));
    mixedClassification.members[0].problemAuthority.path = "problem-repairs/v2-0001-0001.json";
    writeCanonicalJson(mixedClassificationPath, mixedClassification);
    await expect(repairAndAuditOfficialAnswers(
      entry, problem, solution, root, classified, solutions
    )).rejects.toThrow("classification repair graph가 유효하지 않습니다");
    expect(calls).toEqual(beforeReplay);
    writeFileSync(mixedClassificationPath, originalClassificationBytes);

    const receipt = { version: 2, status: "committed", entryId: entry.id };
    await writeAnswerAttestation(root, entry.id, problem.sha256, solution.sha256, receipt, repaired);
    const childPath = join(root, repaired.problemTerminalFidelityCheckpoints[0].path);
    const child = JSON.parse(readFileSync(childPath, "utf8"));
    const originalEvidence = child.items[0].evidence;
    child.items[0].evidence = "tampered";
    writeFileSync(childPath, `${JSON.stringify(child, null, 2)}\n`);
    await expect(writeAnswerAttestation(
      root, entry.id, problem.sha256, solution.sha256, receipt, repaired
    )).rejects.toThrow("problem terminal fidelity child hash가 다릅니다");
    child.items[0].evidence = originalEvidence;
    writeCanonicalJson(childPath, child);

    const malformedName = "v1-0001-0003-bad.json";
    writeJson(join(root, "problem-repair-batches", malformedName), {});
    await expect(repairAndAuditOfficialAnswers(
      entry, problem, solution, root, classified, solutions
    )).rejects.toThrow("problem repair batch filename이 유효하지 않습니다");
    rmSync(join(root, "problem-repair-batches", malformedName));

    const [{ sourcePage: _sourcePage, baseTranscriptionEvidenceHash: _evidenceHash, ...legacyMember }] =
      v2Checkpoint.members;
    const legacyMembers = [legacyMember];
    const legacyDigest = canonicalEvidenceHash(legacyMembers);
    const legacyName = `v1-0001-0003-0001-${legacyDigest}.json`;
    writeCanonicalJson(join(root, "problem-repair-batches", legacyName), {
      version: 1,
      entryId: entry.id,
      sourceHash: problem.sha256,
      contextFrom: 1,
      contextTo: 3,
      sourcePage: 1,
      membersDigest: legacyDigest,
      members: legacyMembers,
      promptVersion: TARGETED_PROBLEM_BATCH_VERSION,
      promptDigest: TARGETED_PROBLEM_BATCH_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      items: [v2Checkpoint.items.find((item: QuizItemEx) => item.page === 1 && item.number === "17")],
    });
    await expect(repairAndAuditOfficialAnswers(
      entry, problem, solution, root, classified, solutions
    )).rejects.toThrow("problem repair key가 중복되었습니다");

    rmSync(join(root, "problem-repair-batches", v2Name));
    rmSync(legacySinglePath);
    rmSync(join(root, "classification-repairs"), { recursive: true, force: true });
    rmSync(join(root, "classification-repair-batches"), { recursive: true, force: true });
    rmSync(join(root, "problem-revision-batches"), { recursive: true, force: true });
    rmSync(join(root, "classification-revision-batches"), { recursive: true, force: true });
    const legacyCalls = { extract: 0, classify: 0 };
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_file_quiz_items") {
        legacyCalls.extract++;
        const number = request.prompt.includes("2:22") ? 22 : 23;
        const revisedSuffix = request.prompt.includes("SECOND SOURCE-GROUNDED REVISION") ? " 최종" : "";
        return { text: JSON.stringify([{
          ...questions[number - 1],
          question: `[공유 지문 전체와 전환 문장] ${number}번${revisedSuffix}`,
          choiceCount: null,
        }]) };
      }
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        legacyCalls.classify++;
        const inputs = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{ key: string }>;
        return { text: JSON.stringify(inputs.map(({ key }) => decision(Number(key.split(":")[1]), "exact"))) };
      }
      throw new Error(`unexpected legacy schema ${request.schema?.name}`);
    });
    const legacyReplay = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
    expect(legacyCalls).toEqual({ extract: 3, classify: 2 });
    expect(new Set(legacyReplay.repairs.map((repair) => repair.problemArtifact.path)).size).toBe(3);
    expect(legacyReplay.repairs.every((repair) => /^problem-repair-batches\/v1-/u.test(repair.problemArtifact.path)))
      .toBe(true);
    expect(readdirSync(join(root, "problem-repair-batches")).every((name) => name.startsWith("v1-"))).toBe(true);
  });
});
