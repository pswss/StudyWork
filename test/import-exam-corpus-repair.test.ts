import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  CLASSIFICATION_RECOVERY_VERSION,
  CLASSIFICATION_REVISION_VERSION,
  PROBLEM_RECOVERY_VERSION,
  PROBLEM_REPAIR_VERSION,
  PROBLEM_REVISION_VERSION,
  PROBLEM_SCOPE_ADJUDICATION_PROMPT_DIGEST,
  PROBLEM_SCOPE_ADJUDICATION_VERSION,
  SOLUTION_FIDELITY_VERSION,
  SOLUTION_FIDELITY_PROMPT_DIGEST,
  TRANSCRIPTION_GATE_VERSION,
  TRANSCRIPTION_PROMPT_DIGEST,
  TARGETED_PROBLEM_REVISION_PROMPT_DIGEST,
  TARGETED_PROBLEM_RECOVERY_PROMPT_DIGEST,
  assertNoCommittedReceiptForFilteredResult,
  assertNoReceiptResultConflict,
  baseDifficultyByQuestionKey,
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
const writeCanonicalJson = (path: string, value: unknown) =>
  writeFileSync(path, `${JSON.stringify(canonicalize(value), null, 2)}\n`);

describe("exam corpus targeted problem repair", () => {
  const officialFixtureDir = join(
    process.cwd(),
    "data/import-exam-corpus/b4eeaf53cd6024aa180d1f37"
  );
  const officialProblemPath = join(officialFixtureDir, "problem.pdf");
  const officialSolutionPath = join(officialFixtureDir, "solution.pdf");

  it.runIf(existsSync(officialProblemPath) && existsSync(officialSolutionPath))(
    "recovers only Q11 after a failed revision and resumes immutable evidence",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-corpus-repair-"));
    const problemBytes = readFileSync(officialProblemPath);
    const solutionBytes = readFileSync(officialSolutionPath);
    const problemPath = join(root, "problem.pdf");
    const solutionPath = join(root, "solution.pdf");
    writeFileSync(problemPath, problemBytes);
    writeFileSync(solutionPath, solutionBytes);

    const entry = parseCorpusManifest({
      schemaVersion: 2,
      entries: [{
        id: "ebsi:5577055",
        subject: "수학",
        examTitle: "고3 3월 학평(서울)",
        rawTitle: "고3 3월 학평(서울) 수학가형",
        sourceRecordDate: "2017-03-09",
        sourceRecordYear: 2017,
        variant: "수학가형",
        form: null,
        sourcePageUrl: "https://www.ebsi.co.kr/exam/5577055",
        problemPdfUrl: "https://wdown.ebsi.co.kr/5577055-problem.pdf",
        solutionPdfUrl: "https://wdown.ebsi.co.kr/5577055-solution.pdf",
        grade: 3,
        paperId: "5577055",
      }],
    }).entries[0];
    const problem: PdfEvidence = {
      path: problemPath,
      sha256: "b4381bc3b831323375b2c4a25319d308185c930be5d2e3b07dfc28e7646a5fde",
      bytes: problemBytes.length,
      pageCount: 12,
      requestedUrl: entry.problemPdfUrl,
      resolvedUrl: entry.problemPdfUrl,
    };
    const solution: PdfEvidence = {
      path: solutionPath,
      sha256: "1753328f4b4360a9d81312d0d1610c7a11063bbefeeb1e1fd286d54c601ec5fa",
      bytes: solutionBytes.length,
      pageCount: 5,
      requestedUrl: entry.solutionPdfUrl,
      resolvedUrl: entry.solutionPdfUrl,
    };

    const questions: QuizItemEx[] = Array.from({ length: 30 }, (_, index) => {
      const number = index + 1;
      if (number === 11) return {
        number: "11",
        qtype: "mcq",
        difficulty: "중",
        question: "두 로그함수와 직선의 교점 사이 거리를 구하여라.",
        choices: [
          "① $4$",
          "② $3\\sqrt{2}$",
          "③ $5$",
          "④ $4\\sqrt{2}$",
          "⑤ $6$",
        ],
        answer: "① $4$",
        explanation: "",
        page: 4,
        figure: true,
        figure_description: "좌표평면의 그래프와 x축 눈금 1이 보인다.",
        box: [0.2, 0.8],
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
      if (question.number === "11") return {
        key,
        decision: "reject",
        canonical_subject: null,
        curriculum_course: null,
        domain: null,
        achievement_codes: [],
        confidence: 0.99,
        reason_codes: ["COORDINATE_GEOMETRY_REQUIRED"],
        transcription_status: "mismatch",
        transcription_evidence: "원본 4쪽의 부등식과 보기가 전사와 다르다.",
      };
      if (question.number === "12") return {
        key,
        decision: "accept",
        canonical_subject: "math_B",
        curriculum_course: "2015 수학Ⅰ",
        domain: "삼각함수",
        achievement_codes: ["12수학Ⅰ02-02"],
        confidence: 0.99,
        reason_codes: ["IN_SCOPE_TRIGONOMETRY"],
        transcription_status: "exact",
        transcription_evidence: "원본 문항과 전사가 일치한다.",
      };
      return {
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
        ? "4"
        : question.number === "12" ? "②" : question.number!,
      explanation: question.number === "11"
        ? "점 $A_1,B_1$의 좌표는 $(a,1),(b,1)$이다. $b-a=1$이고 중점이 $(2,1)$이므로 " +
          "$\\frac{a+b}{2}=2$, $a+b=4$이다. 따라서 $A_2B_2=b^2-a^2=(b-a)(b+a)=4$이다."
        : question.number === "12" ? "계산 결과는 2이다. [정답] ②" : `${question.number}번 공식 해설`,
      page: 1,
      complete: true,
    }));
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
      to: 5,
      ownedFrom: 1,
      ownedTo: 5,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      items: solutions,
    });

    let crashClassification = true;
    let forceBaseQ11ScopeAccept = true;
    let forceFinalQ11ScopeAccept = false;
    const calls = {
      target: 0,
      classification: 0,
      scopeAdjudication: 0,
      terminalFidelity: 0,
      solutionFidelity: 0,
      semantic: 0,
    };
    providerMock.complete.mockImplementation(async (request: {
      schema?: { name?: string };
      prompt: string;
      file?: { path: string };
    }) => {
      if (request.schema?.name === "studywork_file_quiz_items") {
        calls.target++;
        const attached = await PDFDocument.load(readFileSync(request.file!.path));
        expect(attached.getPageCount()).toBe(12);
        expect(request.prompt).toContain("bounded context for original document pages 1-12");
        expect(request.prompt).toContain("required shared passage");
        if (calls.target === 2) {
          expect(request.prompt).toContain("SECOND SOURCE-GROUNDED REVISION");
          expect(request.prompt).toContain("원문은 '만나는 점'");
          expect(request.prompt).toContain("occurrence order");
          expect(request.prompt).toContain("Never paraphrase visible text as a surrogate");
        } else if (calls.target === 3) {
          expect(request.prompt).toContain("FINAL SOURCE-GROUNDED RECOVERY");
          expect(request.prompt).toContain("x축 눈금 1");
          expect(request.prompt).toContain("Never copy or infer text from prior attempts");
        }
        return {
          text: JSON.stringify([{
            number: "11",
            qtype: "mcq",
            difficulty: "중",
            question: calls.target === 1
              ? "그림과 같이 두 곡선 $y=\\log_a x$, $y=\\log_b x\\;(1<a<b)$와 직선 $y=1$이 만나게 되는 점을 $A_1$, $B_1$이라 하고, 직선 $y=2$가 만나는 점을 $A_2$, $B_2$라 하자. 선분 $A_1B_1$의 중점은 $(2,1)$이고 $\\overline{A_1B_1}=1$일 때 $\\overline{A_2B_2}$는?"
              : "그림과 같이 두 곡선 $y=\\log_a x$, $y=\\log_b x\\;(1<a<b)$와 직선 $y=1$이 만나는 점을 $A_1$, $B_1$이라 하고, 직선 $y=2$가 만나는 점을 $A_2$, $B_2$라 하자. 선분 $A_1B_1$의 중점의 좌표는 $(2,1)$이고 $\\overline{A_1B_1}=1$일 때, $\\overline{A_2B_2}$의 값은? $[3점]$",
            choices: [
              "① $4$",
              "② $3\\sqrt{2}$",
              "③ $5$",
              "④ $4\\sqrt{2}$",
              "⑤ $6$",
            ],
            choiceCount: 5,
            answer: "① $4$",
            explanation: "",
            page: 4,
            figure: true,
            figure_description: calls.target === 2
              ? "좌표평면의 두 그래프와 교점을 표시한다."
              : "좌표평면의 두 로그함수, y=1과 y=2, 네 교점, x축 눈금 1을 표시한다.",
            box: [0.2, 0.8],
          }]),
          provider: "codex-cli",
          model: "gpt-5.6-sol",
        };
      }
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        calls.classification++;
        const attached = await PDFDocument.load(readFileSync(request.file!.path));
        expect(attached.getPageCount()).toBe(12);
        expect(request.prompt).toContain("original pages 1-12");
        expect(request.prompt).toContain('"qtype":"mcq"');
        expect(request.prompt).toContain('"figure_description":');
        expect(request.prompt).toContain('"box":[0.2,0.8]');
        if (crashClassification) throw new Error("simulated classification interruption");
        const firstRepairCheck = calls.classification === 2;
        const failedRevisionCheck = calls.classification === 3;
        const recovered = calls.classification === 4;
        return {
          text: JSON.stringify([{
            key: "4:11",
            decision: "accept",
            canonical_subject: "math_B",
            curriculum_course: "2015 수학Ⅰ",
            domain: "지수함수와 로그함수",
            achievement_codes: ["12수학Ⅰ01-07"],
            confidence: 0.99,
            reason_codes: [recovered ? "WRONGLY_IGNORED_COORDINATE_GEOMETRY" : "IN_SCOPE_LOGARITHMS"],
            transcription_status: firstRepairCheck || failedRevisionCheck ? "mismatch" : "exact",
            transcription_evidence: firstRepairCheck
              ? "원문은 '만나는 점'인데 재전사는 '만나게 되는 점'으로 바뀌었다."
              : failedRevisionCheck
                ? "원본 4쪽 그래프의 x축 눈금 1이 figure_description에서 누락됐다."
                : "원본 4쪽의 '만나는 점', x축 눈금 1, 식, 다섯 보기가 모두 일치한다.",
          }]),
          provider: "codex-cli",
          model: "gpt-5.6-sol",
        };
      }
      if (request.schema?.name === "studywork_exam_corpus_scope_adjudication") {
        calls.scopeAdjudication++;
        const attached = await PDFDocument.load(readFileSync(request.file!.path));
        expect(attached.getPageCount()).toBe(17);
        expect(request.prompt).toContain("official problem pages 1-12");
        expect(request.prompt).toContain("official solution pages 1-5");
        expect(request.prompt).toContain("No prior classifier or audit decision is supplied");
        expect(request.prompt).not.toContain("WRONGLY_IGNORED_COORDINATE_GEOMETRY");
        expect(request.prompt).not.toContain("원본 4쪽과 공식 해설에서 좌표기하와 로그가 모두 필수다");
        return {
          text: JSON.stringify([{
            key: "4:11",
            decision: "reject",
            canonical_subject: null,
            curriculum_course: null,
            domain: null,
            achievement_codes: [],
            confidence: 0.99,
            reason_codes: ["COORDINATE_GEOMETRY_REQUIRED"],
            transcription_status: "exact",
            transcription_evidence: "공식 문제 4쪽의 로그함수, 중점, 선분 길이와 보기가 모두 일치한다.",
          }]),
          provider: "codex-cli",
          model: "gpt-5.6-sol",
        };
      }
      if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
        calls.terminalFidelity++;
        const inputs = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{
          key: string;
          question: string;
          figure_description: string | null;
        }>;
        return {
          text: JSON.stringify(inputs.map((input) => ({
            key: input.key,
            status: input.key !== "4:11" || (
              input.question.includes("중점의 좌표") && input.question.includes("[3점]") &&
              input.figure_description?.includes("눈금 1")
            ) ? "exact" : "mismatch",
            evidence: input.key === "4:11"
              ? "원본 4쪽의 문구와 x축 눈금 1을 대조했다."
              : "원본 픽셀과 최종 전사가 일치한다.",
            scopeDecision: input.key === "4:12" || (
              forceBaseQ11ScopeAccept && input.key === "4:11" && !input.question.includes("그림과 같이")
            ) || (forceFinalQ11ScopeAccept && input.key === "4:11") ? "accept" : "reject",
            scopeConfidence: 0.99,
            scopeEvidence: input.key === "4:11"
              ? "원본 4쪽과 공식 해설에서 좌표기하와 로그가 모두 필수다."
              : "원본 문제의 필수 개념을 확인했다.",
          }))),
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
    expect(calls).toEqual({
      target: 1, classification: 1, scopeAdjudication: 0,
      terminalFidelity: 1, solutionFidelity: 0, semantic: 0,
    });
    expect(readdirSync(join(root, "problem-repair-batches"))).toHaveLength(1);
    expect(() => readdirSync(join(root, "classification-repair-batches"))).toThrow();

    crashClassification = false;
    const repaired = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
    expect(calls).toEqual({
      target: 3, classification: 4, scopeAdjudication: 1,
      terminalFidelity: 4, solutionFidelity: 1, semantic: 1,
    });
    expect(repaired.repairs).toHaveLength(1);
    expect(PROBLEM_REPAIR_VERSION).toBe(2);
    expect(PROBLEM_REVISION_VERSION).toBe(1);
    expect(CLASSIFICATION_REVISION_VERSION).toBe(2);
    expect(PROBLEM_RECOVERY_VERSION).toBe(1);
    expect(CLASSIFICATION_RECOVERY_VERSION).toBe(1);
    expect(PROBLEM_SCOPE_ADJUDICATION_VERSION).toBe(1);
    expect(PROBLEM_SCOPE_ADJUDICATION_PROMPT_DIGEST).toMatch(/^[a-f0-9]{64}$/u);
    expect(TARGETED_PROBLEM_REVISION_PROMPT_DIGEST).toMatch(/^[a-f0-9]{64}$/u);
    expect(TARGETED_PROBLEM_RECOVERY_PROMPT_DIGEST).toMatch(/^[a-f0-9]{64}$/u);
    expect(repaired.repairs[0]).toMatchObject({
      key: "4:11",
      printedNumber: "11",
      sourcePage: 4,
      contextFrom: 1,
      contextTo: 12,
      problemArtifact: { path: expect.stringMatching(/^problem-repair-batches\/v2-/u) },
      revision: {
        problemArtifact: { path: expect.stringMatching(/^problem-revision-batches\/v1-/u) },
        classificationArtifact: { path: expect.stringMatching(/^classification-revision-batches\/v1-/u) },
        recovery: {
          problemArtifact: { path: expect.stringMatching(/^problem-recoveries\/v1-/u) },
          classificationArtifact: { path: expect.stringMatching(/^classification-recoveries\/v1-/u) },
          baseProblemRepairItemHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          baseClassificationRepairItemHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          baseProblemRevisionItemHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          baseClassificationRevisionItemHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      },
    });
    expect(repaired.repairs[0].classificationArtifact.path).toMatch(/^classification-repair-batches\/v1-/u);
    expect(JSON.parse(readFileSync(join(root, repaired.repairs[0].problemArtifact.path), "utf8")))
      .toMatchObject({
        contextFrom: 1,
        contextTo: 12,
        targetsDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        diagnosticEvidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        members: [{ sourcePage: 4, baseTranscriptionEvidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u) }],
        items: [{ question: expect.stringContaining("만나게") }],
      });
    expect(JSON.parse(readFileSync(join(root, repaired.repairs[0].classificationArtifact.path), "utf8")))
      .toMatchObject({
        contextFrom: 1,
        contextTo: 12,
        items: [{
          transcription_status: "mismatch",
          transcription_evidence: expect.stringContaining("원문은 '만나는 점'"),
        }],
      });
    const revision = repaired.repairs[0].revision!;
    expect(JSON.parse(readFileSync(join(root, revision.problemArtifact.path), "utf8"))).toMatchObject({
      contextFrom: 1,
      contextTo: 12,
      items: [{ question: expect.stringContaining("만나는 점") }],
    });
    expect(JSON.parse(readFileSync(join(root, revision.classificationArtifact.path), "utf8"))).toMatchObject({
      contextFrom: 1,
      contextTo: 12,
      items: [{
        transcription_status: "mismatch",
        transcription_evidence: expect.stringContaining("x축 눈금 1"),
      }],
    });
    const recovery = revision.recovery!;
    expect(JSON.parse(readFileSync(join(root, recovery.problemArtifact.path), "utf8"))).toMatchObject({
      basis: {
        key: "4:11",
        sourcePage: 4,
        contextFrom: 1,
        contextTo: 12,
        baseProblemRepairArtifact: repaired.repairs[0].problemArtifact,
        baseProblemRevisionArtifact: revision.problemArtifact,
        failedClassificationEvidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      item: { figure_description: expect.stringContaining("x축 눈금 1") },
    });
    expect(JSON.parse(readFileSync(join(root, recovery.classificationArtifact.path), "utf8"))).toMatchObject({
      basis: {
        baseClassificationRevisionArtifact: {
          path: revision.classificationArtifact.path,
          sha256: revision.classificationArtifact.sha256,
        },
      },
      items: [{
        decision: "accept",
        canonical_subject: "math_B",
        transcription_status: "exact",
      }],
    });
    const scopeAdjudication = recovery.scopeAdjudication!;
    expect(scopeAdjudication).toMatchObject({
      allowlistId: "ebsi-5577055-q11-scope-v1",
      key: "4:11",
      sourcePage: 4,
      sourceHash: problem.sha256,
      solutionSourceHash: solution.sha256,
      problemContextFrom: 1,
      problemContextTo: 12,
      solutionContextFrom: 1,
      solutionContextTo: 5,
      parentRecoveryEvidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      trigger: {
        terminalCheckpoint: { path: expect.stringMatching(/^problem-terminal-fidelity\/v2-/u) },
        terminalItem: { key: "4:11", status: "exact", scopeDecision: "reject", scopeConfidence: 0.99 },
        terminalItemHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        scopeEvidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      classificationArtifact: {
        path: expect.stringMatching(/^classification-scope-adjudications\/v1-/u),
        adjudicationPromptVersion: PROBLEM_SCOPE_ADJUDICATION_VERSION,
        adjudicationPromptDigest: PROBLEM_SCOPE_ADJUDICATION_PROMPT_DIGEST,
      },
    });
    expect(JSON.parse(readFileSync(join(root, scopeAdjudication.classificationArtifact.path), "utf8")))
      .toMatchObject({
        version: PROBLEM_SCOPE_ADJUDICATION_VERSION,
        basis: {
          parentRecoveryEvidenceHash: scopeAdjudication.parentRecoveryEvidenceHash,
          baseSolutionCheckpoint: scopeAdjudication.baseSolutionCheckpoint,
          trigger: scopeAdjudication.trigger,
        },
        adjudicationPromptDigest: PROBLEM_SCOPE_ADJUDICATION_PROMPT_DIGEST,
        items: [{
          decision: "reject",
          canonical_subject: null,
          curriculum_course: null,
          domain: null,
          achievement_codes: [],
          transcription_status: "exact",
        }],
      });
    expect(repaired.auditPath).toMatch(/^answer-audit\/v5-[a-f0-9]{64}\.json$/u);
    expect(repaired.auditHash).toMatch(/^[a-f0-9]{64}$/u);
    const changedKeys = repaired.classified.flatMap((item, index) =>
      canonicalEvidenceHash(item) === canonicalEvidenceHash(classified[index]) ? [] : [item.classification.key]
    );
    expect(changedKeys).toEqual(["4:11"]);
    expect(repaired.classified[10]).toMatchObject({
      question: {
        number: "11",
        page: 4,
        question: expect.stringContaining("중점의 좌표는 $(2,1)$"),
        choices: expect.arrayContaining(["① $4$"]),
      },
      classification: { decision: "reject", canonical_subject: null },
    });
    expect(repaired.classified[10].question.question).toContain("y=\\log_a x");
    expect(repaired.classified[10].question.question).toContain("$[3점]$");
    expect(repaired.classified[10].question.question).not.toContain("만나게");
    expect(repaired.classified[10].question.figure_description).toContain("x축 눈금 1");
    const imported = matchOfficialSolutions(
      entry,
      repaired.classified,
      repaired.solutions,
      baseDifficultyByQuestionKey(classified)
    );
    expect(imported.some((item) => item.printedNumber === "11")).toBe(false);
    expect(imported).toHaveLength(1);
    expect(readdirSync(join(root, "semantic-choice-checks"))[0]).toMatch(/^v5-/u);

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
    expect(attestation.path).toMatch(/^answer-attestation\/v5-[a-f0-9]{64}\.json$/u);
    expect(attestation.sha256).toMatch(/^[a-f0-9]{64}$/u);
    const auditCheckpoint = JSON.parse(readFileSync(join(root, repaired.auditPath!), "utf8"));
    expect(auditCheckpoint).toMatchObject({
      classifierVersion: 5,
      transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
      solutionFidelityVersion: SOLUTION_FIDELITY_VERSION,
      solutionFidelityPromptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
      effectiveSolutionCorpusHash: repaired.effectiveSolutionCorpusHash,
      derivedAnswerKeys: ["4:12"],
    });
    const attestationCheckpoint = JSON.parse(readFileSync(join(root, attestation.path), "utf8"));
    expect(attestationCheckpoint).toMatchObject({
      classifierVersion: 5,
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
      repairs: [{
        key: "4:11",
        contextFrom: 1,
        contextTo: 12,
        revision: {
          problemArtifact: { path: expect.stringMatching(/^problem-revision-batches\/v1-/u) },
          recovery: {
            problemArtifact: { path: expect.stringMatching(/^problem-recoveries\/v1-/u) },
            classificationArtifact: { path: expect.stringMatching(/^classification-recoveries\/v1-/u) },
            scopeAdjudication: {
              allowlistId: "ebsi-5577055-q11-scope-v1",
              classificationArtifact: {
                path: expect.stringMatching(/^classification-scope-adjudications\/v1-/u),
              },
            },
          },
        },
      }],
    });
    expect(() => assertNoCommittedReceiptForFilteredResult(root)).toThrow("명시적 migration");

    writeFileSync(join(root, "result.json"), "{}\n");
    expect(() => assertNoReceiptResultConflict(root)).toThrow("terminal conflict");
    rmSync(join(root, "result.json"));

    forceBaseQ11ScopeAccept = false;
    const baseCorpusHash = canonicalEvidenceHash(classified);
    const baseTerminalCheckpoint = readdirSync(join(root, "problem-terminal-fidelity"))
      .map((name) => ({ name, value: JSON.parse(readFileSync(join(root, "problem-terminal-fidelity", name), "utf8")) }))
      .find(({ value }) => value.effectiveCorpusHash === baseCorpusHash);
    expect(baseTerminalCheckpoint).toBeDefined();
    rmSync(join(root, "problem-terminal-fidelity", baseTerminalCheckpoint!.name));

    const replay = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
    expect(calls).toEqual({
      target: 3, classification: 4, scopeAdjudication: 1,
      terminalFidelity: 5, solutionFidelity: 1, semantic: 1,
    });
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
    expect(canonicalEvidenceHash(replay.repairs)).toBe(canonicalEvidenceHash(repaired.repairs));
    expect(readdirSync(join(root, "problem-recoveries"))).toHaveLength(1);
    expect(readdirSync(join(root, "classification-recoveries"))).toHaveLength(1);

    const beforeSourceTamper = { ...calls };
    writeFileSync(problemPath, Buffer.concat([problemBytes, Buffer.from("\n") ]));
    await expect(repairAndAuditOfficialAnswers(
      entry, problem, solution, root, classified, solutions
    )).rejects.toThrow("공식 source bytes hash가 다릅니다");
    expect(calls).toEqual(beforeSourceTamper);
    writeFileSync(problemPath, problemBytes);

    writeFileSync(solutionPath, Buffer.concat([solutionBytes, Buffer.from("\n") ]));
    await expect(repairAndAuditOfficialAnswers(
      entry, problem, solution, root, classified, solutions
    )).rejects.toThrow("공식 source bytes hash가 다릅니다");
    expect(calls).toEqual(beforeSourceTamper);
    writeFileSync(solutionPath, solutionBytes);

    const scopePath = join(root, scopeAdjudication.classificationArtifact.path);
    const originalScopeBytes = readFileSync(scopePath);
    const invalidScope = JSON.parse(originalScopeBytes.toString("utf8"));
    invalidScope.items[0].decision = "review";
    invalidScope.items[0].canonical_subject = null;
    invalidScope.items[0].curriculum_course = null;
    invalidScope.items[0].domain = null;
    invalidScope.items[0].achievement_codes = [];
    writeCanonicalJson(scopePath, invalidScope);
    await expect(repairAndAuditOfficialAnswers(
      entry, problem, solution, root, classified, solutions
    )).rejects.toThrow("reject/null exact에 합의하지 않았습니다");
    expect(calls).toEqual(beforeSourceTamper);
    writeFileSync(scopePath, originalScopeBytes);

    const orphanScopePath = join(root, "classification-scope-adjudications", "orphan.json");
    writeFileSync(orphanScopePath, originalScopeBytes);
    await expect(repairAndAuditOfficialAnswers(
      entry, problem, solution, root, classified, solutions
    )).rejects.toThrow("problem scope adjudication orphan/conflict");
    expect(calls).toEqual(beforeSourceTamper);
    rmSync(orphanScopePath);

    const finalTerminal = repaired.problemTerminalFidelityCheckpoints[0];
    const finalTerminalPath = join(root, finalTerminal.path);
    const originalFinalTerminalBytes = readFileSync(finalTerminalPath);
    rmSync(finalTerminalPath);
    forceFinalQ11ScopeAccept = true;
    const beforeFinalDisagreement = { ...calls };
    await expect(repairAndAuditOfficialAnswers(
      entry, problem, solution, root, classified, solutions
    )).rejects.toThrow("terminal 문제 fidelity가 최종 정책을 만족하지 않습니다");
    expect(calls.scopeAdjudication).toBe(beforeFinalDisagreement.scopeAdjudication);
    expect(calls.terminalFidelity).toBe(beforeFinalDisagreement.terminalFidelity + 1);
    forceFinalQ11ScopeAccept = false;
    writeFileSync(finalTerminalPath, originalFinalTerminalBytes);

    const semanticPath = join(root, auditCheckpoint.semanticCheckpoint.path);
    const semanticCheckpoint = JSON.parse(readFileSync(semanticPath, "utf8"));
    semanticCheckpoint.effectiveCorpusHash = "0".repeat(64);
    writeCanonicalJson(semanticPath, semanticCheckpoint);
    const beforeSemanticTamperReplay = { ...calls };
    await expect(repairAndAuditOfficialAnswers(
      entry,
      problem,
      solution,
      root,
      classified,
      solutions
    )).rejects.toThrow("semantic choice 체크포인트 메타데이터가 다릅니다");
    expect(calls).toEqual(beforeSemanticTamperReplay);
    semanticCheckpoint.effectiveCorpusHash = repaired.effectiveCorpusHash;
    writeCanonicalJson(semanticPath, semanticCheckpoint);

    const recoveryClassificationPath = join(root, recovery.classificationArtifact.path);
    const recoveryClassification = JSON.parse(readFileSync(recoveryClassificationPath, "utf8"));
    recoveryClassification.items[0].transcription_status = "mismatch";
    recoveryClassification.items[0].transcription_evidence = "x축 눈금 1을 여전히 확인할 수 없다.";
    writeCanonicalJson(recoveryClassificationPath, recoveryClassification);
    const beforeFailedRecoveryReplay = { ...calls };
    await expect(repairAndAuditOfficialAnswers(
      entry,
      problem,
      solution,
      root,
      classified,
      solutions
    )).rejects.toThrow("final source-grounded recovery도 exact가 아닙니다");
    expect(calls).toEqual(beforeFailedRecoveryReplay);
    recoveryClassification.items[0].transcription_status = "exact";
    recoveryClassification.items[0].transcription_evidence =
      "원본 4쪽의 '만나는 점', x축 눈금 1, 식, 다섯 보기가 모두 일치한다.";
    writeCanonicalJson(recoveryClassificationPath, recoveryClassification);

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
    )).rejects.toThrow("classification repair batch 메타데이터가 다릅니다");
    }
  );
});
