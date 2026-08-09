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
  ANSWER_ATTESTATION_VERSION,
  ANSWER_AUDIT_VERSION,
  CLASSIFIER_DIGEST,
  CLASSIFIER_VERSION,
  SOLUTION_FIDELITY_PROMPT_DIGEST,
  SOLUTION_FIDELITY_SLICE_PAGES,
  SOLUTION_FIDELITY_SLICE_STRIDE,
  SOLUTION_FIDELITY_VERSION,
  SOLUTION_REPAIR_FIDELITY_VERSION,
  SOLUTION_REPAIR_VERSION,
  baseDifficultyByQuestionKey,
  canonicalEvidenceHash,
  matchOfficialSolutions,
  parseCorpusManifest,
  repairAndAuditOfficialAnswers,
  validateSolutionSliceTopology,
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

describe("exam corpus official solution repair", () => {
  it("repairs Q27 from its owning 6-page context and resumes without overwriting base evidence", async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-solution-repair-"));
    const problemDocument = await PDFDocument.create();
    for (let page = 0; page < 12; page++) problemDocument.addPage([100, 100]);
    const solutionDocument = await PDFDocument.create();
    for (let page = 0; page < 22; page++) solutionDocument.addPage([100, 100]);
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
        examTitle: "고2 3월 학평(서울)",
        rawTitle: "고2 3월 학평(서울) 수학가형",
        sourceRecordDate: "2017-03-09",
        sourceRecordYear: 2017,
        variant: "수학가형",
        form: null,
        sourcePageUrl: "https://www.ebsi.co.kr/exam/5578422",
        problemPdfUrl: "https://wdown.ebsi.co.kr/5578422-problem.pdf",
        solutionPdfUrl: "https://wdown.ebsi.co.kr/5578422-solution.pdf",
        grade: 2,
        paperId: "5578422",
      }],
    }).entries[0];
    const problem: PdfEvidence = {
      path: problemPath,
      sha256: sha256(problemBytes),
      bytes: problemBytes.length,
      pageCount: 12,
      requestedUrl: entry.problemPdfUrl,
      resolvedUrl: entry.problemPdfUrl,
    };
    const solution: PdfEvidence = {
      path: solutionPath,
      sha256: sha256(solutionBytes),
      bytes: solutionBytes.length,
      pageCount: 22,
      requestedUrl: entry.solutionPdfUrl,
      resolvedUrl: entry.solutionPdfUrl,
    };

    const questions: QuizItemEx[] = Array.from({ length: 30 }, (_, index) => {
      const number = index + 1;
      return {
        number: String(number),
        qtype: "short",
        difficulty: "중",
        question: number === 27
          ? "$\\sqrt{2m}$과 $\\sqrt[3]{3m}$이 모두 자연수가 되게 하는 $m$의 최솟값을 구하시오."
          : `${number}번 범위 밖 문제`,
        choices: null,
        answer: number === 27 ? "72" : String(number),
        explanation: "",
        page: number === 27 ? 11 : Math.min(12, Math.ceil(number / 3)),
        figure: false,
        figure_description: null,
        box: null,
      };
    });
    const decisions: ClassificationDecision[] = questions.map((question) => ({
      key: `${question.page}:${question.number}`,
      decision: question.number === "27" ? "accept" : "reject",
      canonical_subject: question.number === "27" ? "math_B" : null,
      curriculum_course: question.number === "27" ? "2015 수학Ⅰ" : null,
      domain: question.number === "27" ? "지수함수와 로그함수" : null,
      achievement_codes: question.number === "27" ? ["12수학Ⅰ01-01"] : [],
      confidence: 0.99,
      reason_codes: [question.number === "27" ? "IN_SCOPE_ROOTS" : "OUT_OF_SCOPE"],
      transcription_status: "exact",
      transcription_evidence: "공식 문제 원문과 정확히 일치한다.",
    }));
    const classified = questions.map((question, index) => ({ question, classification: decisions[index] }));
    const solutions: SolutionItem[] = questions.map((question) => ({
      number: question.number!,
      answer: question.number === "27" ? "72" : question.number!,
      explanation: question.number === "27"
        ? "$m=2p^2$, $m=3q^3$이고 $m=2^3\\times3^2\\times r^6$이므로 최솟값은 72이다."
        : `${question.number}번 공식 해설`,
      page: question.number === "27" ? 17 : 1,
      complete: true,
    }));
    const baseChunkPath = join(root, "solution-chunks", "v3-0004.json");
    writeJson(baseChunkPath, {
      version: 3,
      sourceHash: solution.sha256,
      from: 17,
      to: 22,
      ownedFrom: 17,
      ownedTo: 22,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      items: [solutions[26]],
    });
    const baseChunkHash = sha256(readFileSync(baseChunkPath));

    let targetAttempt = 0;
    let repairFidelityAttempt = 0;
    const calls = { bulkFidelity: 0, target: 0, repairFidelity: 0 };
    providerMock.complete.mockImplementation(async (request: {
      schema?: { name?: string };
      prompt: string;
      file?: { path: string };
      reasoningEffort?: string;
    }) => {
      expect(request.reasoningEffort).toBe("high");
      if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
        const inputs = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{ key: string }>;
        return {
          text: JSON.stringify(inputs.map((input) => ({
            key: input.key,
            status: "exact",
            evidence: "공식 문제 픽셀과 최종 전사가 일치한다.",
            scopeDecision: "accept",
            scopeConfidence: 0.99,
            scopeEvidence: "원본 17쪽 수열 문제 범위를 확인했다.",
          }))),
          provider: "codex-cli",
          model: "gpt-5.6-sol",
        };
      }
      if (request.schema?.name === "studywork_exam_corpus_solution_fidelity") {
        const attached = await PDFDocument.load(readFileSync(request.file!.path));
        if (attached.getPageCount() === 22) {
          calls.bulkFidelity++;
          expect(request.prompt).toContain("original pages 1-22");
          if (calls.bulkFidelity > 1) {
            return {
              text: JSON.stringify([{
                key: "11:27",
                sourcePage: 17,
                answerStatus: "exact",
                explanationStatus: "exact",
                evidence: "새 세대 bulk 판독은 잘못된 base 해설도 exact로 보았다.",
              }]),
              provider: "codex-cli",
              model: "gpt-5.6-sol",
            };
          }
          return {
            text: JSON.stringify([{
              key: "11:27",
              sourcePage: 17,
              answerStatus: "not_visible",
              explanationStatus: "mismatch",
              evidence: "원본은 m=3^2 q^3인데 전사는 m=3 q^3이다.",
            }]),
            provider: "codex-cli",
            model: "gpt-5.6-sol",
          };
        }
        calls.repairFidelity++;
        repairFidelityAttempt++;
        expect(attached.getPageCount()).toBe(6);
        expect(request.prompt).toContain("original pages 17-22");
        if (repairFidelityAttempt === 1) throw new Error("simulated solution fidelity interruption");
        return {
          text: JSON.stringify([{
            key: "11:27",
            sourcePage: 18,
            answerStatus: "exact",
            explanationStatus: "exact",
            evidence: "원본 18쪽의 m=3^2 q^3과 최종값 72까지 완전한 결론이 모두 일치한다.",
          }]),
          provider: "codex-cli",
          model: "gpt-5.6-sol",
        };
      }
      if (request.schema?.name === "studywork_solution_file_items") {
        calls.target++;
        targetAttempt++;
        const attached = await PDFDocument.load(readFileSync(request.file!.path));
        expect(attached.getPageCount()).toBe(6);
        expect(request.prompt).toContain("original document pages 17-22");
        expect(request.prompt).toContain("printed solution 27");
        return {
          text: JSON.stringify([{
            number: "27",
            answer: "72",
            explanation: targetAttempt === 1
              ? "18쪽 다음 줄에 계속"
              : "$m=2p^2$, $m=3^2q^3$이고 $m=2^3\\times3^2\\times r^6$이므로 최솟값은 72이다.",
            page: 18,
            complete: targetAttempt !== 1,
          }]),
          provider: "codex-cli",
          model: "gpt-5.6-sol",
        };
      }
      throw new Error(`unexpected schema ${request.schema?.name}`);
    });

    await expect(repairAndAuditOfficialAnswers(
      entry, problem, solution, root, classified, solutions
    )).rejects.toThrow("청크 경계에서 내용이 잘렸습니다");
    expect(calls).toEqual({ bulkFidelity: 1, target: 1, repairFidelity: 0 });
    expect(() => readdirSync(join(root, "solution-repairs"))).toThrow();

    await expect(repairAndAuditOfficialAnswers(
      entry, problem, solution, root, classified, solutions
    )).rejects.toThrow("simulated solution fidelity interruption");
    expect(calls).toEqual({ bulkFidelity: 1, target: 2, repairFidelity: 1 });
    expect(readdirSync(join(root, "solution-repairs"))).toHaveLength(1);

    const repaired = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
    expect(calls).toEqual({ bulkFidelity: 1, target: 2, repairFidelity: 2 });
    expect(SOLUTION_FIDELITY_VERSION).toBe(1);
    expect(SOLUTION_FIDELITY_SLICE_PAGES).toBe(22);
    expect(SOLUTION_FIDELITY_SLICE_STRIDE).toBe(18);
    expect(SOLUTION_REPAIR_VERSION).toBe(1);
    expect(SOLUTION_REPAIR_FIDELITY_VERSION).toBe(1);
    expect(ANSWER_AUDIT_VERSION).toBe(5);
    expect(ANSWER_ATTESTATION_VERSION).toBe(5);
    expect(SOLUTION_FIDELITY_PROMPT_DIGEST).toMatch(/^[a-f0-9]{64}$/u);
    expect(sha256(readFileSync(baseChunkPath))).toBe(baseChunkHash);
    expect(repaired.solutionRepairs).toHaveLength(1);
    expect(repaired.solutionRepairs[0]).toMatchObject({
      key: "11:27",
      printedNumber: "27",
      basePage: 17,
      effectivePage: 18,
      contextFrom: 17,
      contextTo: 22,
      baseOwnedFrom: 17,
      baseOwnedTo: 22,
      repairArtifact: { path: expect.stringMatching(/^solution-repairs\/v1-/u) },
      fidelityArtifact: { path: expect.stringMatching(/^solution-fidelity-repairs\/v1-/u) },
    });
    expect(repaired.solutionFidelityItems).toEqual([expect.objectContaining({
      key: "11:27",
      basePage: 17,
      effectivePage: 18,
      answerStatus: "exact",
      explanationStatus: "exact",
    })]);
    expect(repaired.auditPath).toMatch(/^answer-audit\/v5-[a-f0-9]{64}\.json$/u);

    const imported = matchOfficialSolutions(
      entry,
      repaired.classified,
      repaired.solutions,
      baseDifficultyByQuestionKey(classified)
    );
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({
      printedNumber: "27",
      officialAnswer: "72",
      solutionPage: 18,
      officialExplanation: "$m=2p^2$, $m=3^2q^3$이고 $m=2^3\\times3^2\\times r^6$이므로 최솟값은 72이다.",
    });
    const expectedSolutionCorpusHash = canonicalEvidenceHash([{
      key: "11:27",
      solution: repaired.solutions.find((item) => item.number === "27"),
    }]);
    expect(repaired.effectiveSolutionCorpusHash).toBe(expectedSolutionCorpusHash);

    const attestation = await writeAnswerAttestation(
      root,
      entry.id,
      problem.sha256,
      solution.sha256,
      { version: 2, status: "committed", entryId: entry.id },
      repaired
    );
    expect(attestation.path).toMatch(/^answer-attestation\/v5-[a-f0-9]{64}\.json$/u);
    const attested = JSON.parse(readFileSync(join(root, attestation.path), "utf8"));
    expect(attested).toMatchObject({
      solutionFidelityVersion: 1,
      solutionFidelityPromptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
      answerAudit: { effectiveSolutionCorpusHash: repaired.effectiveSolutionCorpusHash },
      solutionRepairs: [{ key: "11:27", basePage: 17, effectivePage: 18 }],
    });

    const replay = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
    expect(calls).toEqual({ bulkFidelity: 1, target: 2, repairFidelity: 2 });
    expect(replay.auditHash).toBe(repaired.auditHash);

    const changed = structuredClone(classified);
    changed[0].question.question = "1번 범위 밖 문제의 무관한 표현만 바뀌었다.";
    const migrated = await repairAndAuditOfficialAnswers(entry, problem, solution, root, changed, solutions);
    expect(calls).toEqual({ bulkFidelity: 2, target: 2, repairFidelity: 3 });
    expect(migrated.solutionRepairs).toHaveLength(1);
    expect(migrated.solutionRepairs[0].repairArtifact.path).not.toBe(repaired.solutionRepairs[0].repairArtifact.path);
    expect(migrated.solutions[26].explanation).toContain("m=3^2q^3");
    const migratedRepair = JSON.parse(readFileSync(join(root, migrated.solutionRepairs[0].repairArtifact.path), "utf8"));
    expect(migratedRepair.persistedSeed).toMatchObject({
      version: 1,
      generationId: expect.stringMatching(/^[a-f0-9]{64}$/u),
      repairArtifact: repaired.solutionRepairs[0].repairArtifact,
      repairedItemHash: repaired.solutionRepairs[0].effectiveSolutionItemHash,
    });
    const migratedReplay = await repairAndAuditOfficialAnswers(entry, problem, solution, root, changed, solutions);
    expect(calls).toEqual({ bulkFidelity: 2, target: 2, repairFidelity: 3 });
    expect(migratedReplay.auditHash).toBe(migrated.auditHash);

    const fidelityPath = join(root, repaired.solutionRepairs[0].fidelityArtifact.path);
    const stale = JSON.parse(readFileSync(fidelityPath, "utf8"));
    stale.promptDigest = "stale";
    writeFileSync(fidelityPath, `${JSON.stringify(stale, null, 2)}\n`);
    await expect(repairAndAuditOfficialAnswers(
      entry, problem, solution, root, classified, solutions
    )).rejects.toThrow(/hash가 다릅니다|repair 해설 fidelity 메타데이터가 다릅니다/u);
  });

  it("uses exact 22/18 fidelity ownership without start-page gaps or duplicates", () => {
    expect(validateSolutionSliceTopology([{ from: 1, to: 22 }, { from: 19, to: 24 }])).toEqual([
      { from: 1, to: 18 },
      { from: 19, to: 24 },
    ]);
    expect(validateSolutionSliceTopology([{ from: 1, to: 22 }, { from: 19, to: 28 }])).toEqual([
      { from: 1, to: 18 },
      { from: 19, to: 28 },
    ]);
    expect(() => validateSolutionSliceTopology([{ from: 1, to: 20 }, { from: 19, to: 38 }]))
      .toThrow("정확한 4쪽 overlap");
  });
});
