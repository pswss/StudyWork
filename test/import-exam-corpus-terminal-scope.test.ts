import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  PROBLEM_REPAIR_SCOPE_ADJUDICATION_ALLOWLIST,
  PROBLEM_REPAIR_SCOPE_ADJUDICATION_PROMPT_DIGEST,
  PROBLEM_REPAIR_SCOPE_ADJUDICATION_VERSION,
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
    expect(result.auditPath).toMatch(/^answer-audit\/v5-/u);
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
    expect(result.auditPath).toMatch(/^answer-audit\/v5-/u);
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

const Q26_STATE_DIR = join(process.cwd(), "data/import-exam-corpus/5a72e90edfe68c75f79ce8ef");
const Q26_REQUIRED_PATHS = [
  "entry.json",
  "problem.pdf",
  "solution.pdf",
  "problem-chunks/v2-0000.json",
  "classification-chunks/v5-0000-7bb7cb863c8c4855.json",
  "solution-chunks/v3-0000.json",
  "problem-repair-batches/v2-0001-0012-98976660e9a8d3ce521855232d13bd3214a62a48fa49b66bb807e39603fe1529.json",
].map((path) => join(Q26_STATE_DIR, path));

describe("exact allowlisted first-repair scope adjudication", () => {
  it("pins Q26 to the official problem and solution sources", () => {
    expect(PROBLEM_REPAIR_SCOPE_ADJUDICATION_VERSION).toBe(1);
    expect(PROBLEM_REPAIR_SCOPE_ADJUDICATION_PROMPT_DIGEST).toMatch(/^[a-f0-9]{64}$/u);
    expect(PROBLEM_REPAIR_SCOPE_ADJUDICATION_ALLOWLIST).toEqual([{
      allowlistId: "ebsi-5643101-q26-repair-scope-v1",
      entryId: "ebsi:5643101",
      key: "10:26",
      sourcePage: 10,
      sourceHash: "1e15589c2682dbabcbddea62b48fb218658fb15d000de1daf96be52e7d92386d",
      solutionSourceHash: "d7e8497ec003f0eca0d1023c5179ecd8d621ca519c513baab6481a3c3e06e5d0",
    }, {
      allowlistId: "ebsi-5696441-q30-repair-scope-v1",
      entryId: "ebsi:5696441",
      key: "12:30",
      sourcePage: 12,
      sourceHash: "b164d4dc867f0790525ca7ddae3c1003113f454c4d015f161db3d5ec4a1c9fc2",
      solutionSourceHash: "1aff1dcfcb4954d355661ebe03f823d1d4227db1339f604f2391ce0673552557",
    }]);
  });

  it.skipIf(Q26_REQUIRED_PATHS.some((path) => !existsSync(path)))(
    "reclassifies exact Q26 accept to reject from hidden-label problem and solution pixels", async () => {
      root = mkdtempSync(join(tmpdir(), "studywork-q26-repair-scope-"));
      const storedEntry = JSON.parse(readFileSync(Q26_REQUIRED_PATHS[0], "utf8")).entry;
      const entry = parseCorpusManifest({ schemaVersion: 2, entries: [storedEntry] }).entries[0];
      const problemBytes = readFileSync(Q26_REQUIRED_PATHS[1]);
      const solutionBytes = readFileSync(Q26_REQUIRED_PATHS[2]);
      const problem: PdfEvidence = {
        path: Q26_REQUIRED_PATHS[1],
        sha256: hash(problemBytes),
        bytes: problemBytes.length,
        pageCount: 12,
        requestedUrl: entry.problemPdfUrl,
        resolvedUrl: entry.problemPdfUrl,
      };
      const solution: PdfEvidence = {
        path: Q26_REQUIRED_PATHS[2],
        sha256: hash(solutionBytes),
        bytes: solutionBytes.length,
        pageCount: 4,
        requestedUrl: entry.solutionPdfUrl,
        resolvedUrl: entry.solutionPdfUrl,
      };
      const questions = (JSON.parse(readFileSync(Q26_REQUIRED_PATHS[3], "utf8")).items as QuizItemEx[])
        .map((item) => structuredClone(item));
      const baseQ26 = questions.find((item) => Number(item.number) === 26)!;
      const baseQ26Decision = (JSON.parse(readFileSync(Q26_REQUIRED_PATHS[4], "utf8"))
        .items as ClassificationDecision[]).find((item) => item.key === "10:26")!;
      const repairedQ26 = (JSON.parse(readFileSync(Q26_REQUIRED_PATHS[6], "utf8")).items as QuizItemEx[])
        .find((item) => Number(item.number) === 26)!;
      const solutions = (JSON.parse(readFileSync(Q26_REQUIRED_PATHS[5], "utf8")).items as SolutionItem[])
        .map((item) => structuredClone(item));
      const decisions: ClassificationDecision[] = questions.map((question) => Number(question.number) === 26
        ? baseQ26Decision
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
        version: 2,
        sourceHash: problem.sha256,
        from: 1,
        to: 12,
        ownedFrom: 1,
        ownedTo: 12,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        items: questions,
      });
      writeJson(join(root, "classification-chunks", `v${CLASSIFIER_VERSION}-0000-${CLASSIFIER_DIGEST}.json`), {
        version: CLASSIFIER_VERSION,
        sourceHash: problem.sha256,
        from: 1,
        to: 12,
        ownedFrom: 1,
        ownedTo: 12,
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
        to: 4,
        ownedFrom: 1,
        ownedTo: 4,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        items: solutions,
      });

      const accept: ClassificationDecision = {
        key: "10:26",
        decision: "accept",
        canonical_subject: "math_B",
        curriculum_course: "2015 수학Ⅰ",
        domain: "지수함수와 로그함수—로그의 성질",
        achievement_codes: ["12수학Ⅰ01-04"],
        confidence: 0.99,
        reason_codes: ["IN_SCOPE_LOGARITHM_PROPERTIES"],
        transcription_status: "exact",
        transcription_evidence: "공식 10쪽의 27k, 답 36, [4점]까지 일치한다.",
      };
      const reject: ClassificationDecision = {
        key: "10:26",
        decision: "reject",
        canonical_subject: null,
        curriculum_course: null,
        domain: null,
        achievement_codes: [],
        confidence: 0.99,
        reason_codes: ["EXCLUDED_COMMON_MATH_EQUATION_DEPENDENCY"],
        transcription_status: "exact",
        transcription_evidence: "공식 10쪽의 27k, 답 36, [4점]까지 일치한다.",
      };
      const calls = { extraction: 0, classification: 0, terminal: 0 };
      providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
        if (request.schema?.name === "studywork_file_quiz_items") {
          calls.extraction++;
          return { text: JSON.stringify([{ ...repairedQ26, choiceCount: null }]) };
        }
        if (request.schema?.name === "studywork_exam_corpus_scope_adjudication") {
          calls.classification++;
          expect(request.prompt).not.toContain("scopeDecision");
          expect(request.prompt).not.toContain("IN_SCOPE_LOGARITHM_PROPERTIES");
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
            const q26 = input.key === "10:26";
            const exact = !q26 || input.question.includes("[4점]");
            return {
              key: input.key,
              status: exact ? "exact" : "mismatch",
              evidence: exact ? "공식 source pixels와 일치한다." : "공식 10쪽의 [4점]이 누락됐다.",
              scopeDecision: q26 && !exact ? "accept" : "reject",
              scopeConfidence: 0.99,
              scopeEvidence: q26
                ? "x²−4xy+y²=0을 반드시 이용하므로 공통수학 방정식 의존이다."
                : "요청 범위 밖이다.",
            };
          })) };
        }
        throw new Error(`unexpected schema ${request.schema?.name}`);
      });

      const result = await repairAndAuditOfficialAnswers(
        entry, problem, solution, root, classified, solutions
      );
      expect(calls).toEqual({ extraction: 1, classification: 2, terminal: 3 });
      const repair = result.repairs.find((item) => item.key === "10:26")!;
      expect(repair.revision).toBeUndefined();
      expect(repair.scopeAdjudication).toMatchObject({
        allowlistId: "ebsi-5643101-q26-repair-scope-v1",
        key: "10:26",
        parentRepairEvidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        classificationArtifact: {
          path: expect.stringMatching(/^classification-repair-scope-adjudications\/v1-/u),
        },
      });
      expect(result.classified.find((item) => item.classification.key === "10:26")).toMatchObject({
        question: { question: expect.stringContaining("27k") },
        classification: {
          decision: "reject",
          canonical_subject: null,
          transcription_status: "exact",
        },
      });
      expect(result.problemTerminalFidelityItems.find((item) => item.key === "10:26")).toMatchObject({
        status: "exact",
        scopeDecision: "reject",
      });
      expect(result.auditPath).toMatch(/^answer-audit\/v5-/u);

      const beforeReplay = { ...calls };
      const replay = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
      expect(calls).toEqual(beforeReplay);
      expect(replay.auditHash).toBe(result.auditHash);
      expect(canonicalEvidenceHash(replay.repairs)).toBe(canonicalEvidenceHash(result.repairs));

      const childPath = join(root, repair.scopeAdjudication!.classificationArtifact.path);
      const originalChild = readFileSync(childPath);
      const tamperedChild = JSON.parse(originalChild.toString()) as {
        items: Array<ClassificationDecision>;
      };
      tamperedChild.items[0] = { ...accept };
      writeJson(childPath, tamperedChild);
      await expect(repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions))
        .rejects.toThrow(/scope adjudication hash|accept 근거|reject\/null exact/u);
      expect(calls).toEqual(beforeReplay);
      writeFileSync(childPath, originalChild);

      writeFileSync(join(root, "classification-repair-scope-adjudications", "orphan.json"), "{}\n");
      await expect(repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions))
        .rejects.toThrow("problem repair scope adjudication orphan/conflict");
    },
    90_000
  );
});
