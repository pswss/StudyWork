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
  canonicalEvidenceHash,
  matchOfficialSolutions,
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
const writeJson = (path: string, value: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

describe("exam corpus targeted problem repair", () => {
  it("repairs only Q11, resumes after classification interruption, and rejects stale replay", async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-corpus-repair-"));
    const problemDocument = await PDFDocument.create();
    for (let page = 0; page < 4; page++) problemDocument.addPage([100, 100]);
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
      } : {
        key,
        decision: "reject",
        canonical_subject: null,
        curriculum_course: null,
        domain: null,
        achievement_codes: [],
        confidence: 0.99,
        reason_codes: ["OUT_OF_SCOPE"],
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
    writeJson(join(root, "classification-chunks", `v3-0000-${CLASSIFIER_DIGEST}.json`), {
      version: 3,
      sourceHash: problem.sha256,
      from: 1,
      to: 4,
      ownedFrom: 1,
      ownedTo: 4,
      rulesDigest: CLASSIFIER_DIGEST,
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
    const calls = { target: 0, classification: 0, semantic: 0 };
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_file_quiz_items") {
        calls.target++;
        return {
          text: JSON.stringify([{
            number: "11",
            qtype: "mcq",
            difficulty: "중",
            question: "$0\\le x\\le\\pi$일 때 모든 실근의 합은?",
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
          }]),
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
    expect(calls).toEqual({ target: 1, classification: 1, semantic: 0 });
    expect(readdirSync(join(root, "problem-repairs"))).toHaveLength(1);
    expect(() => readdirSync(join(root, "classification-repairs"))).toThrow();

    crashClassification = false;
    const repaired = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
    expect(calls).toEqual({ target: 1, classification: 2, semantic: 1 });
    expect(repaired.repairs).toHaveLength(1);
    expect(repaired.repairs[0]).toMatchObject({ key: "4:11", printedNumber: "11", sourcePage: 4 });
    expect(repaired.auditPath).toMatch(/^answer-audit\/v1-[a-f0-9]{64}\.json$/u);
    expect(repaired.auditHash).toMatch(/^[a-f0-9]{64}$/u);
    const changedKeys = repaired.classified.flatMap((item, index) =>
      canonicalEvidenceHash(item) === canonicalEvidenceHash(classified[index]) ? [] : [item.classification.key]
    );
    expect(changedKeys).toEqual(["4:11"]);
    expect(repaired.classified[10]).toMatchObject({
      question: {
        number: "11",
        page: 4,
        question: expect.stringContaining("0\\le x\\le\\pi"),
        choices: expect.arrayContaining(["① $\\frac{7}{6}\\pi$"]),
      },
      classification: { decision: "accept", canonical_subject: "math_B" },
    });
    const imported = matchOfficialSolutions(entry, repaired.classified, solutions);
    expect(imported.find((item) => item.printedNumber === "11")?.officialAnswer)
      .toBe("① $\\frac{7}{6}\\pi$");
    expect(imported).toHaveLength(2);

    const replay = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
    expect(calls).toEqual({ target: 1, classification: 2, semantic: 1 });
    expect(replay.auditHash).toBe(repaired.auditHash);
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
