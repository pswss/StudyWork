import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";

const providerMock = vi.hoisted(() => ({ complete: vi.fn() }));

vi.mock("../src/codex-provider", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/codex-provider")>();
  return {
    ...original,
    getCodexProvider: () => ({ complete: providerMock.complete }),
  };
});

import type { QuizItemEx, SolutionItem } from "../src/claude";
import {
  CLASSIFIER_DIGEST,
  CLASSIFIER_VERSION,
  PROBLEM_REPAIR_VERSION,
  SOLUTION_FIDELITY_VERSION,
  SOLUTION_FIDELITY_PROMPT_DIGEST,
  TRANSCRIPTION_GATE_VERSION,
  TRANSCRIPTION_PROMPT_DIGEST,
  assertNoCommittedReceiptForFilteredResult,
  assertNoReceiptResultConflict,
  canonicalEvidenceHash,
  matchOfficialSolutions,
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

describe("exam corpus targeted problem repair", () => {
  it("repairs only Q11, resumes after classification interruption, and rejects stale replay", async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-corpus-repair-"));
    const problemDocument = await PDFDocument.create();
    for (let page = 0; page < 4; page++) problemDocument.addPage([100, 100]);
    problemDocument.getPage(2).drawText("SHARED PASSAGE START", { x: 5, y: 50, size: 6 });
    problemDocument.getPage(3).drawText("11 QUESTION", { x: 5, y: 50, size: 6 });
    const problemBytes = await problemDocument.save();
    const solutionDocument = await PDFDocument.create();
    solutionDocument.addPage([100, 100]);
    const solutionBytes = await solutionDocument.save();
    const problemPath = join(root, "problem.pdf");
    const solutionPath = join(root, "solution.pdf");
    writeFileSync(problemPath, problemBytes);
    writeFileSync(solutionPath, solutionBytes);

    const entry = parseCorpusManifest({
      schemaVersion: 2,
      entries: [{
        id: "ebsi:q11-repair",
        subject: "수학",
        examTitle: "고3 7월 학평(인천)",
        rawTitle: "고3 7월 학평(인천) 수학가형",
        sourceRecordDate: "2017-07-12",
        sourceRecordYear: 2017,
        variant: "수학가형",
        form: null,
        sourcePageUrl: "https://www.ebsi.co.kr/exam/q11",
        problemPdfUrl: "https://wdown.ebsi.co.kr/q11-problem.pdf",
        solutionPdfUrl: "https://wdown.ebsi.co.kr/q11-solution.pdf",
        grade: 3,
        paperId: "q11-repair",
      }],
    }).entries[0];
    const problem: PdfEvidence = {
      path: problemPath,
      sha256: hash(problemBytes),
      bytes: problemBytes.length,
      pageCount: 4,
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
      if (number === 11) return {
        number: "11",
        qtype: "mcq",
        difficulty: "중",
        question: "$0<x<\\pi$일 때 모든 실근의 합은?",
        choices: [
          "① $\\frac{1}{6}\\pi$",
          "② $\\frac{1}{3}\\pi$",
          "③ $\\frac{1}{2}\\pi$",
          "④ $\\frac{2}{3}\\pi$",
          "⑤ $\\frac{5}{6}\\pi$",
        ],
        answer: "① $\\frac{1}{6}\\pi$",
        explanation: "",
        page: 4,
        figure: false,
        figure_description: null,
        box: null,
      };
      if (number === 12) return {
        number: "12",
        qtype: "mcq",
        difficulty: "중",
        question: "상세 해설로 값 2를 고르는 문제",
        choices: ["① 1", "② 2", "③ 3", "④ 4", "⑤ 5"],
        answer: "②",
        explanation: "",
        page: 4,
        figure: false,
        figure_description: null,
        box: null,
      };
      return {
        number: String(number),
        qtype: "short",
        difficulty: "중",
        question: `${number}번 범위 밖 문제`,
        choices: null,
        answer: String(number),
        explanation: "",
        page: Math.min(4, Math.max(1, Math.ceil(number / 8))),
        figure: false,
        figure_description: null,
        box: null,
      };
    });
    const decisions: ClassificationDecision[] = questions.map((question) => {
      const key = `${question.page}:${question.number}`;
      return question.number === "11" || question.number === "12" ? {
        key,
        decision: "accept",
        canonical_subject: "math_B",
        curriculum_course: "2015 수학Ⅰ",
        domain: "삼각함수",
        achievement_codes: ["12수학Ⅰ02-02"],
        confidence: 0.99,
        reason_codes: ["IN_SCOPE_TRIGONOMETRY"],
        transcription_status: question.number === "11" ? "mismatch" : "exact",
        transcription_evidence: question.number === "11"
          ? "원본 4쪽의 부등식과 보기가 전사와 다르다."
          : "원본 문항과 전사가 일치한다.",
      } : {
        key,
        decision: "reject",
        canonical_subject: null,
        curriculum_course: null,
        domain: null,
        achievement_codes: [],
        confidence: 0.99,
        reason_codes: ["OUT_OF_SCOPE"],
        transcription_status: "exact",
        transcription_evidence: "원본 문항과 전사가 일치한다.",
      };
    });
    const classified = questions.map((question, index) => ({ question, classification: decisions[index] }));
    const solutions: SolutionItem[] = questions.map((question) => ({
      number: question.number!,
      answer: question.number === "11"
        ? "\\(\\frac{7\\pi}{6}\\)"
        : question.number === "12" ? "②" : question.number!,
      explanation: question.number === "11"
        ? "근은 0, \\pi, \\frac{\\pi}{6}이므로 합은 \\frac{7\\pi}{6}이다."
        : question.number === "12" ? "계산 결과는 2이다. [정답] ②" : `${question.number}번 공식 해설`,
      page: 1,
      complete: true,
    }));
    writeJson(join(root, "problem-chunks", "v2-0000.json"), {
      version: 2,
      sourceHash: problem.sha256,
      from: 1,
      to: 4,
      ownedFrom: 1,
      ownedTo: 4,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      items: questions,
    });
    writeJson(join(root, "classification-chunks", `v${CLASSIFIER_VERSION}-0000-${CLASSIFIER_DIGEST}.json`), {
      version: CLASSIFIER_VERSION,
      sourceHash: problem.sha256,
      from: 1,
      to: 4,
      ownedFrom: 1,
      ownedTo: 4,
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
    const calls = { target: 0, classification: 0, solutionFidelity: 0, semantic: 0 };
    providerMock.complete.mockImplementation(async (request: {
      schema?: { name?: string };
      prompt: string;
      file?: { path: string };
    }) => {
      if (request.schema?.name === "studywork_file_quiz_items") {
        calls.target++;
        const attached = await PDFDocument.load(readFileSync(request.file!.path));
        expect(attached.getPageCount()).toBe(4);
        expect(request.prompt).toContain("bounded context for original document pages 1-4");
        expect(request.prompt).toContain("required shared passage");
        return {
          text: JSON.stringify([{
            number: "11",
            qtype: "mcq",
            difficulty: "중",
            question: "[공유 지문: 원본 3쪽에서 시작한 조건]\n$0\\le x\\le\\pi$일 때 모든 실근의 합은?",
            choices: [
              "① $\\frac{7}{6}\\pi$",
              "② $\\frac{4}{3}\\pi$",
              "③ $\\frac{3}{2}\\pi$",
              "④ $\\frac{5}{3}\\pi$",
              "⑤ $\\frac{11}{6}\\pi$",
            ],
            choiceCount: 5,
            answer: "① $\\frac{7}{6}\\pi$",
            explanation: "",
            page: 4,
            figure: false,
            figure_description: null,
            box: null,
          }]),
          provider: "codex-cli",
          model: "gpt-5.6-sol",
        };
      }
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        calls.classification++;
        const attached = await PDFDocument.load(readFileSync(request.file!.path));
        expect(attached.getPageCount()).toBe(4);
        expect(request.prompt).toContain("original pages 1-4");
        expect(request.prompt).toContain('"qtype":"mcq"');
        expect(request.prompt).toContain('"figure_description":null');
        expect(request.prompt).toContain('"box":null');
        if (crashClassification) throw new Error("simulated classification interruption");
        return {
          text: JSON.stringify([{
            key: "4:11",
            decision: "accept",
            canonical_subject: "math_B",
            curriculum_course: "2015 수학Ⅰ",
            domain: "삼각함수",
            achievement_codes: ["12수학Ⅰ02-02"],
            confidence: 0.99,
            reason_codes: ["IN_SCOPE_TRIGONOMETRY"],
            transcription_status: "exact",
            transcription_evidence: "원본 4쪽의 부등식, 식, 다섯 보기가 모두 일치한다.",
          }]),
          provider: "codex-cli",
          model: "gpt-5.6-sol",
        };
      }
      if (request.schema?.name === "studywork_exam_corpus_solution_fidelity") {
        calls.solutionFidelity++;
        const inputs = JSON.parse(request.prompt.split("Accepted solutions:\n")[1]) as Array<{
          key: string;
          source_page: number;
        }>;
        return {
          text: JSON.stringify(inputs.map((input) => ({
            key: input.key,
            sourcePage: input.source_page,
            answerStatus: input.key === "4:12" ? "not_visible" : "exact",
            explanationStatus: "exact",
            evidence: `원본 ${input.source_page}쪽 공식 정답과 전체 해설이 일치한다.`,
          }))),
          provider: "codex-cli",
          model: "gpt-5.6-sol",
        };
      }
      if (request.schema?.name === "studywork_exam_corpus_semantic_choice_check") {
        calls.semantic++;
        expect(request.prompt).not.toContain("problemAnswer");
        expect(request.prompt).not.toContain("officialAnswer");
        expect(request.prompt).not.toContain("[정답] ②");
        expect(request.prompt).toContain("[CHOICE MARKER HIDDEN]");
        return {
          text: JSON.stringify([{
            key: "4:12",
            status: "resolved",
            choiceIndex: 2,
            evidence: "공식 상세 해설의 계산 결과가 2이다.",
          }]),
          provider: "codex-cli",
          model: "gpt-5.6-sol",
        };
      }
      throw new Error(`unexpected schema ${request.schema?.name}`);
    });

    await expect(repairAndAuditOfficialAnswers(
      entry,
      problem,
      solution,
      root,
      classified,
      solutions
    )).rejects.toThrow("simulated classification interruption");
    expect(calls).toEqual({ target: 1, classification: 1, solutionFidelity: 0, semantic: 0 });
    expect(readdirSync(join(root, "problem-repairs"))).toHaveLength(1);
    expect(() => readdirSync(join(root, "classification-repairs"))).toThrow();

    crashClassification = false;
    const repaired = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
    expect(calls).toEqual({ target: 1, classification: 2, solutionFidelity: 1, semantic: 1 });
    expect(repaired.repairs).toHaveLength(1);
    expect(PROBLEM_REPAIR_VERSION).toBe(2);
    expect(repaired.repairs[0]).toMatchObject({
      key: "4:11",
      printedNumber: "11",
      sourcePage: 4,
      contextFrom: 1,
      contextTo: 4,
      problemArtifact: { path: expect.stringMatching(/^problem-repairs\/v2-/u) },
    });
    expect(repaired.repairs[0].classificationArtifact.path).toMatch(/^classification-repairs\/v3-/u);
    expect(JSON.parse(readFileSync(join(root, repaired.repairs[0].problemArtifact.path), "utf8")))
      .toMatchObject({ contextFrom: 1, contextTo: 4, sourcePage: 4, printedNumber: "11" });
    expect(JSON.parse(readFileSync(join(root, repaired.repairs[0].classificationArtifact.path), "utf8")))
      .toMatchObject({ contextFrom: 1, contextTo: 4, key: "4:11" });
    expect(repaired.auditPath).toMatch(/^answer-audit\/v2-[a-f0-9]{64}\.json$/u);
    expect(repaired.auditHash).toMatch(/^[a-f0-9]{64}$/u);
    const changedKeys = repaired.classified.flatMap((item, index) =>
      canonicalEvidenceHash(item) === canonicalEvidenceHash(classified[index]) ? [] : [item.classification.key]
    );
    expect(changedKeys).toEqual(["4:11"]);
    expect(repaired.classified[10]).toMatchObject({
      question: {
        number: "11",
        page: 4,
        question: expect.stringContaining("공유 지문"),
        choices: expect.arrayContaining(["① $\\frac{7}{6}\\pi$"]),
      },
      classification: { decision: "accept", canonical_subject: "math_B" },
    });
    expect(repaired.classified[10].question.question).toContain("0\\le x\\le\\pi");
    const imported = matchOfficialSolutions(entry, repaired.classified, repaired.solutions);
    expect(imported.find((item) => item.printedNumber === "11")?.officialAnswer)
      .toBe("① $\\frac{7}{6}\\pi$");
    expect(imported).toHaveLength(2);
    expect(readdirSync(join(root, "semantic-choice-checks"))[0]).toMatch(/^v3-/u);

    expect(() => assertNoCommittedReceiptForFilteredResult(root)).not.toThrow();
    const receipt = { version: 2, status: "committed", entryId: entry.id };
    const attestation = await writeAnswerAttestation(
      root,
      entry.id,
      problem.sha256,
      solution.sha256,
      receipt,
      repaired
    );
    expect(attestation.path).toMatch(/^answer-attestation\/v2-[a-f0-9]{64}\.json$/u);
    expect(attestation.sha256).toMatch(/^[a-f0-9]{64}$/u);
    const auditCheckpoint = JSON.parse(readFileSync(join(root, repaired.auditPath!), "utf8"));
    expect(auditCheckpoint).toMatchObject({
      classifierVersion: 4,
      transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
      solutionFidelityVersion: SOLUTION_FIDELITY_VERSION,
      solutionFidelityPromptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
      effectiveSolutionCorpusHash: repaired.effectiveSolutionCorpusHash,
      derivedAnswerKeys: ["4:12"],
    });
    const attestationCheckpoint = JSON.parse(readFileSync(join(root, attestation.path), "utf8"));
    expect(attestationCheckpoint).toMatchObject({
      classifierVersion: 4,
      transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
      receipt: { path: "receipt.json" },
      answerAudit: {
        path: repaired.auditPath,
        sha256: repaired.auditHash,
        effectiveCorpusHash: repaired.effectiveCorpusHash,
        effectiveSolutionCorpusHash: repaired.effectiveSolutionCorpusHash,
      },
      solutionFidelityCheckpoints: [{ path: expect.stringMatching(/^solution-fidelity\/v1-/u) }],
      repairs: [{ key: "4:11", contextFrom: 1, contextTo: 4 }],
    });
    expect(() => assertNoCommittedReceiptForFilteredResult(root)).toThrow("명시적 migration");

    writeFileSync(join(root, "result.json"), "{}\n");
    expect(() => assertNoReceiptResultConflict(root)).toThrow("terminal conflict");
    rmSync(join(root, "result.json"));

    const replay = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
    expect(calls).toEqual({ target: 1, classification: 2, solutionFidelity: 1, semantic: 1 });
    expect(replay.auditHash).toBe(repaired.auditHash);
    await expect(writeAnswerAttestation(
      root,
      entry.id,
      problem.sha256,
      solution.sha256,
      receipt,
      replay
    )).resolves.toEqual(attestation);
    expect(canonicalEvidenceHash(replay.classified)).toBe(canonicalEvidenceHash(repaired.classified));

    const classificationArtifact = join(root, repaired.repairs[0].classificationArtifact.path);
    const stale = JSON.parse(readFileSync(classificationArtifact, "utf8"));
    stale.rulesDigest = "stale";
    writeFileSync(classificationArtifact, `${JSON.stringify(stale, null, 2)}\n`);
    await expect(repairAndAuditOfficialAnswers(
      entry,
      problem,
      solution,
      root,
      classified,
      solutions
    )).rejects.toThrow("classification repair 체크포인트 메타데이터가 다릅니다");
  });
});
