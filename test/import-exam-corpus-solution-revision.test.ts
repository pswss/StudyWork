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

import {
  TARGETED_SOLUTION_REVISION_RULES,
  TARGETED_SOLUTION_REVISION_VERSION,
  type QuizItemEx,
  type SolutionItem,
} from "../src/claude";
import {
  SOLUTION_REVISION_FIDELITY_VERSION,
  SOLUTION_REVISION_VERSION,
  TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
  commitSemanticSolutionRevisionTriggers,
  invalidateSemanticSolutionRevisionTriggers,
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

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

async function fixture(id: string, targetNumber: number, mcq = false) {
  root = mkdtempSync(join(tmpdir(), "studywork-solution-revision-"));
  const problemDocument = await PDFDocument.create();
  problemDocument.addPage([100, 100]);
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
      id,
      subject: "수학",
      examTitle: "고2 학평",
      rawTitle: "고2 학평 수학",
      sourceRecordDate: "2017-03-09",
      sourceRecordYear: 2017,
      variant: null,
      form: null,
      sourcePageUrl: `https://www.ebsi.co.kr/exam/${id.slice(5)}`,
      problemPdfUrl: `https://wdown.ebsi.co.kr/${id.slice(5)}-problem.pdf`,
      solutionPdfUrl: `https://wdown.ebsi.co.kr/${id.slice(5)}-solution.pdf`,
      grade: 2,
      paperId: id.slice(5),
    }],
  }).entries[0];
  const problem: PdfEvidence = {
    path: problemPath, sha256: sha256(problemBytes), bytes: problemBytes.length, pageCount: 1,
    requestedUrl: entry.problemPdfUrl, resolvedUrl: entry.problemPdfUrl,
  };
  const solution: PdfEvidence = {
    path: solutionPath, sha256: sha256(solutionBytes), bytes: solutionBytes.length, pageCount: 22,
    requestedUrl: entry.solutionPdfUrl, resolvedUrl: entry.solutionPdfUrl,
  };
  const questions: QuizItemEx[] = Array.from({ length: 30 }, (_, index) => {
    const number = index + 1;
    return {
      number: String(number),
      qtype: number === targetNumber && mcq ? "mcq" : "short",
      difficulty: "중",
      question: `${number}번 문제`,
      choices: number === targetNumber && mcq ? ["① 2", "② 3", "③ 4", "④ 5", "⑤ 6"] : null,
      answer: number === targetNumber && mcq ? "②" : String(number),
      explanation: "",
      page: number === targetNumber ? 11 : Math.min(10, Math.ceil(number / 3)),
      figure: false,
      figure_description: null,
      box: null,
    };
  });
  const decisions: ClassificationDecision[] = questions.map((question) => ({
    key: `${question.page}:${question.number}`,
    decision: question.number === String(targetNumber) ? "accept" : "reject",
    canonical_subject: question.number === String(targetNumber) ? "math_B" : null,
    curriculum_course: question.number === String(targetNumber) ? "2015 수학Ⅰ" : null,
    domain: question.number === String(targetNumber) ? "지수함수와 로그함수" : null,
    achievement_codes: question.number === String(targetNumber) ? ["12수학Ⅰ01-01"] : [],
    confidence: 0.99,
    reason_codes: [question.number === String(targetNumber) ? "IN_SCOPE" : "OUT_OF_SCOPE"],
    transcription_status: "exact",
    transcription_evidence: "공식 문제 원문과 정확히 일치한다.",
  }));
  const classified = questions.map((question, index) => ({ question, classification: decisions[index] }));
  const solutions: SolutionItem[] = questions.map((question) => ({
    number: question.number!,
    answer: question.number === String(targetNumber) && mcq ? "②" : question.number!,
    explanation: question.number === String(targetNumber) ? "잘못 전사된 공식 해설" : `${question.number}번 공식 해설`,
    page: question.number === String(targetNumber) ? 17 : 1,
    complete: true,
  }));
  const chunkPath = join(root, "solution-chunks", "v3-0004.json");
  mkdirSync(join(root, "solution-chunks"), { recursive: true });
  writeFileSync(chunkPath, `${JSON.stringify({
    version: 3,
    sourceHash: solution.sha256,
    from: 17,
    to: 22,
    ownedFrom: 17,
    ownedTo: 22,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    items: [solutions[targetNumber - 1]],
  }, null, 2)}\n`);
  return { entry, problem, solution, classified, solutions };
}

describe("exam corpus official solution revision", () => {
  it("defers tentative semantic revisions when the same pass needs a problem repair", () => {
    const committed = new Map<string, string>();
    expect(commitSemanticSolutionRevisionTriggers(committed, new Map([["11:1", "stale"]]), 1)).toBe(false);
    expect(committed.size).toBe(0);
    expect(commitSemanticSolutionRevisionTriggers(committed, new Map([["11:1", "fresh"]]), 0)).toBe(true);
    expect(committed.get("11:1")).toBe("fresh");
    invalidateSemanticSolutionRevisionTriggers(committed, true);
    expect(committed.size).toBe(0);
  });

  it("revises Q28 once after a failed repair audit and replays immutable evidence", async () => {
    const data = await fixture("ebsi:5643101", 28, true);
    const firstExplanation =
      "$\\lim_{x\\to2}f(x)=0$, $\\lim_{x\\to2}g(x)=0$이고 함수값이 크게 나와야 한다.";
    const finalExplanation =
      "$\\lim_{x\\to2}f(x)=0$, $\\lim_{x\\to-2}f(x)=0$, " +
      "$\\lim_{x\\to2}g(x)=0$, $\\lim_{x\\to-2}g(x)=0$이고 함수값이 크거나 같아야 한다.";
    const calls = { bulk: 0, repair: 0, repairAudit: 0, revision: 0, revisionAudit: 0 };
    providerMock.complete.mockImplementation(async (request: {
      schema?: { name?: string }; prompt: string; file?: { path: string };
    }) => {
      if (request.schema?.name === "studywork_exam_corpus_solution_fidelity") {
        const pages = (await PDFDocument.load(readFileSync(request.file!.path))).getPageCount();
        if (pages === 22) {
          calls.bulk++;
          return { text: JSON.stringify([{ key: "11:28", sourcePage: 17, answerStatus: "not_visible", explanationStatus: "mismatch", evidence: "x→-2 극한 줄이 누락됐다." }]) };
        }
        if (calls.repairAudit === 0) {
          calls.repairAudit++;
          return { text: JSON.stringify([{ key: "11:28", sourcePage: 17, answerStatus: "not_visible", explanationStatus: "mismatch", evidence: "분모·분자의 x→-2 극한과 '크거나 같아야'가 누락됐다." }]) };
        }
        calls.revisionAudit++;
        return { text: JSON.stringify([{ key: "11:28", sourcePage: 17, answerStatus: "not_visible", explanationStatus: "exact", evidence: "±2 네 극한 줄과 문구가 모두 일치한다." }]) };
      }
      if (request.schema?.name === "studywork_solution_file_items") {
        if (request.prompt.includes("SECOND SOURCE-GROUNDED SOLUTION REVISION")) {
          calls.revision++;
          if (calls.revision === 1) throw new Error("simulated solution revision interruption");
          return { text: JSON.stringify([{ number: "28", answer: "②", explanation: `${finalExplanation} 따라서 값은 3이다.`, page: 17, complete: true }]) };
        }
        calls.repair++;
        return { text: JSON.stringify([{ number: "28", answer: "②", explanation: firstExplanation, page: 17, complete: true }]) };
      }
      if (request.schema?.name === "studywork_exam_corpus_semantic_choice_check") {
        return { text: JSON.stringify([{ key: "11:28", status: "resolved", choiceIndex: 2, evidence: "결론의 값 3은 ②이다." }]) };
      }
      throw new Error(`unexpected schema ${request.schema?.name}`);
    });

    await expect(repairAndAuditOfficialAnswers(
      data.entry, data.problem, data.solution, root, data.classified, data.solutions
    )).rejects.toThrow("simulated solution revision interruption");
    const repaired = await repairAndAuditOfficialAnswers(
      data.entry, data.problem, data.solution, root, data.classified, data.solutions
    );
    expect([SOLUTION_REVISION_VERSION, SOLUTION_REVISION_FIDELITY_VERSION]).toEqual([1, 1]);
    expect(TARGETED_SOLUTION_REVISION_VERSION).toBe(2);
    expect(TARGETED_SOLUTION_REVISION_RULES).toContain('answer must be "②"');
    expect(TARGETED_SOLUTION_REVISION_RULES).toContain("Never emit a table row as a separate solution item");
    expect(TARGETED_SOLUTION_REVISION_PROMPT_DIGEST).toMatch(/^[a-f0-9]{64}$/u);
    expect(repaired.solutionRepairs).toHaveLength(1);
    expect(repaired.solutionRepairs[0].revision).toMatchObject({
      trigger: { kind: "fidelity" },
      solutionArtifact: { path: expect.stringMatching(/^solution-revisions\/v1-/u) },
      fidelityArtifact: { path: expect.stringMatching(/^solution-fidelity-revisions\/v1-/u) },
    });
    expect(repaired.solutions[27].explanation).toBe(`${finalExplanation} 따라서 값은 3이다.`);
    expect(repaired.solutions[27].explanation).toContain("\\lim_{x\\to-2}f(x)");
    expect(repaired.solutions[27].explanation).toContain("\\lim_{x\\to-2}g(x)");
    expect(repaired.solutions[27].explanation).toContain("크거나 같아야");
    const beforeReplay = { ...calls };
    const replay = await repairAndAuditOfficialAnswers(
      data.entry, data.problem, data.solution, root, data.classified, data.solutions
    );
    expect(calls).toEqual(beforeReplay);
    expect(replay.auditHash).toBe(repaired.auditHash);

    const revisionPath = join(root, repaired.solutionRepairs[0].revision!.solutionArtifact.path);
    const stale = JSON.parse(readFileSync(revisionPath, "utf8"));
    stale.promptDigest = "stale";
    writeFileSync(revisionPath, `${JSON.stringify(stale, null, 2)}\n`);
    await expect(repairAndAuditOfficialAnswers(
      data.entry, data.problem, data.solution, root, data.classified, data.solutions
    )).rejects.toThrow("solution revision 체크포인트 메타데이터가 다릅니다");
  });

  it("revises Q1 after false-exact fidelity conflicts with hidden-marker semantics", async () => {
    const data = await fixture("ebsi:5643102", 1, true);
    const correct = "$3^{(\\frac{1}{2})\\times2}=3$이므로 정답은 ②이다.";
    const calls = { bulk: 0, repair: 0, repairAudit: 0, revision: 0, revisionAudit: 0, semantic: 0 };
    providerMock.complete.mockImplementation(async (request: {
      schema?: { name?: string }; prompt: string; file?: { path: string };
    }) => {
      if (request.schema?.name === "studywork_exam_corpus_solution_fidelity") {
        const pages = (await PDFDocument.load(readFileSync(request.file!.path))).getPageCount();
        if (pages === 22) {
          calls.bulk++;
          return { text: JSON.stringify([{ key: "11:1", sourcePage: 18, answerStatus: "not_visible", explanationStatus: "exact", evidence: "공식 marker는 이 범위에 보이지 않지만 해설은 일치한다." }]) };
        }
        if (calls.repairAudit === 0) {
          calls.repairAudit++;
          return { text: JSON.stringify([{ key: "11:1", sourcePage: 18, answerStatus: "exact", explanationStatus: "exact", evidence: "일치한다." }]) };
        }
        calls.revisionAudit++;
        return { text: JSON.stringify([{ key: "11:1", sourcePage: 18, answerStatus: "not_visible", explanationStatus: "exact", evidence: "공식 식과 값 3이 일치한다." }]) };
      }
      if (request.schema?.name === "studywork_solution_file_items") {
        if (request.prompt.includes("SECOND SOURCE-GROUNDED SOLUTION REVISION")) {
          calls.revision++;
          expect(request.prompt).toContain('answer must be "②"');
          return { text: JSON.stringify([{ number: "1", answer: "②", explanation: correct, page: 18, complete: true }]) };
        }
        calls.repair++;
        return { text: JSON.stringify([{ number: "1", answer: "①", explanation: correct, page: 18, complete: true }]) };
      }
      if (request.schema?.name === "studywork_exam_corpus_semantic_choice_check") {
        calls.semantic++;
        expect(request.prompt).toContain("3^{(\\\\frac{1}{2})\\\\times2}=3");
        return { text: JSON.stringify([calls.semantic === 1
          ? { key: "11:1", status: "resolved", choiceIndex: 2, evidence: "계산값 3은 ②이므로 marker ①과 충돌한다." }
          : { key: "11:1", status: "resolved", choiceIndex: 2, evidence: "계산값 3은 ②이다." }]) };
      }
      throw new Error(`unexpected schema ${request.schema?.name}`);
    });

    const repaired = await repairAndAuditOfficialAnswers(
      data.entry, data.problem, data.solution, root, data.classified, data.solutions
    );
    const revision = repaired.solutionRepairs[0].revision!;
    expect(revision.trigger).toMatchObject({
      kind: "semantic",
      semanticCheckpoint: { path: expect.stringMatching(/^semantic-choice-checks\/v3-/u) },
      semanticDecisionHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const revisionArtifact = JSON.parse(readFileSync(join(root, revision.solutionArtifact.path), "utf8"));
    expect(revisionArtifact).toMatchObject({
      promptVersion: 2,
      promptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
      item: { answer: "②" },
    });
    expect(repaired.solutions[0].explanation).toBe(correct);
    expect(calls.semantic).toBe(2);
    const audit = JSON.parse(readFileSync(join(root, repaired.auditPath!), "utf8"));
    expect(audit.semanticCheckpoint.path).not.toBe(revision.trigger.semanticCheckpoint!.path);
    const priorSemantic = JSON.parse(readFileSync(join(root, revision.trigger.semanticCheckpoint!.path), "utf8"));
    const finalSemantic = JSON.parse(readFileSync(join(root, audit.semanticCheckpoint.path), "utf8"));
    expect(finalSemantic.inputHash).toBe(priorSemantic.inputHash);
    expect(audit.semanticCheckpoint.path).toContain(
      `${audit.effectiveCorpusHash}-${repaired.effectiveSolutionCorpusHash}`
    );
    const beforeReplay = { ...calls };
    const replay = await repairAndAuditOfficialAnswers(
      data.entry, data.problem, data.solution, root, data.classified, data.solutions
    );
    expect(calls).toEqual(beforeReplay);
    expect(replay.auditHash).toBe(repaired.auditHash);
  });
});
