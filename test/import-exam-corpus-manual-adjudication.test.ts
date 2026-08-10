import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
  PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST,
  TRANSCRIPTION_GATE_VERSION,
  TRANSCRIPTION_PROMPT_DIGEST,
  applyAllowlistedProblemManualCorrection,
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
const writeJson = (path: string, value: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

const cases = [{
  entryId: "ebsi:5594499",
  sourceHash: "0ddccee92ce4e4ba3da53ed253e780cd7b41b5962f7e9761a920079619f81c31",
  path: join(
    process.cwd(),
    "data/import-exam-corpus/4142baa37330a6d3d470294a/" +
      "problem-crop-adjudications/v1-0013-0034-3ee24c800c83bb2f3b7c235749076619e564edc51120a003f59e0d57e7b511fb.json"
  ),
}, {
  entryId: "ebsi:5578421",
  sourceHash: "4c9aee0ec0c15f91678bc3c179efb4c781ab0f9023ca2e5347df94060012272e",
  path: join(
    process.cwd(),
    "data/import-exam-corpus/f914a5cf8d2237d6c9319e23/" +
      "problem-recoveries/v1-0012-0030-20741052441e79627764f61577085ececd18660f475b4a29a4860b98175ef1d7.json"
  ),
}, {
  entryId: "ebsi:5525984",
  sourceHash: "1621eca42821e5feccbb56604249cbcedd8adf6bae6109960f6c790a61c14ec1",
  path: join(
    process.cwd(),
    "data/import-exam-corpus/7755c70fefaa45f755086e2b/" +
      "problem-recoveries/v1-0003-0008-8a81b3c4948de9fe7211cd8db475f5858850e48d88de6dda267d3538cdebf7ad.json"
  ),
}, {
  entryId: "ebsi:5656593",
  sourceHash: "e1b0ffd692634a4a2b1500877691cf0f4ff622fb85c6dd1dba4aff65dfd29e1d",
  path: join(
    process.cwd(),
    "data/import-exam-corpus/714fd4581f778a9c559fd16e/" +
      "problem-recoveries/v1-0007-0018-8dc9e3101914ced2b5380528cdf56f5c607f0911f8a4f4460835260ae4cd6b3a.json"
  ),
}, {
  entryId: "ebsi:5854871",
  sourceHash: "c41b1ee2f3897cbde107c4ffcdec493583bacba4d14299c6c3a6a749b29a80d6",
  path: join(
    process.cwd(),
    "data/import-exam-corpus/a915803b3da3a6ea056eecd6/" +
      "problem-recoveries/v1-0002-0009-ce5a6650673a79cd5cebf9a1d0593bcc75f9acd7fc5a57551ea1becf69e443d5.json"
  ),
}, {
  entryId: "ebsi:5594499",
  sourceHash: "0ddccee92ce4e4ba3da53ed253e780cd7b41b5962f7e9761a920079619f81c31",
  path: join(
    process.cwd(),
    "data/import-exam-corpus/4142baa37330a6d3d470294a/" +
      "problem-recoveries/v1-0004-0009-bddde1723f11b47836bb403b1415e8663a05efb246e6d6d51157be0a9c1b5cf0.json"
  ),
}] as const;

const available = cases.every((item) => existsSync(item.path));
const itemAt = (index: number): QuizItemEx => JSON.parse(readFileSync(cases[index].path, "utf8")).item;

const recoveryCases = [{
  index: 1,
  stateDir: join(process.cwd(), "data/import-exam-corpus/f914a5cf8d2237d6c9319e23"),
  classificationPath: join(
    process.cwd(),
    "data/import-exam-corpus/f914a5cf8d2237d6c9319e23/" +
      "classification-recoveries/v1-0012-0030-7cc21907e44db72c61eb6a182cdd540f771bbc0efab4cae799c5bd681b53819c-7bb7cb863c8c4855.json"
  ),
  questionCount: 45,
  pageCount: 16,
  finalAnchor: "가로선은 총 2개",
  expectedDecision: "accept",
}, {
  index: 2,
  stateDir: join(process.cwd(), "data/import-exam-corpus/7755c70fefaa45f755086e2b"),
  classificationPath: join(
    process.cwd(),
    "data/import-exam-corpus/7755c70fefaa45f755086e2b/" +
      "classification-recoveries/v1-0003-0008-8d9fd17fd4f756f2fe7ede1a8557d4f6f42c6b498c0bb4e6d9dc693f7f7b6ca9-7bb7cb863c8c4855.json"
  ),
  questionCount: 30,
  pageCount: 12,
  finalAnchor: "원점 $O=(0,0)$에는 뚫린 점",
  expectedDecision: "accept",
}, {
  index: 3,
  stateDir: join(process.cwd(), "data/import-exam-corpus/714fd4581f778a9c559fd16e"),
  classificationPath: join(
    process.cwd(),
    "data/import-exam-corpus/714fd4581f778a9c559fd16e/" +
      "classification-recoveries/v1-0007-0018-eadc507490e4723cf09f622b2231222ff5cb12db3609ab381b79951dc1de3144-7bb7cb863c8c4855.json"
  ),
  questionCount: 30,
  pageCount: 12,
  finalAnchor: "읽는 순서는 단일, 단일, 복합, 복합",
  expectedDecision: "reject",
}, {
  index: 4,
  stateDir: join(process.cwd(), "data/import-exam-corpus/a915803b3da3a6ea056eecd6"),
  classificationPath: join(
    process.cwd(),
    "data/import-exam-corpus/a915803b3da3a6ea056eecd6/" +
      "classification-recoveries/v1-0002-0009-284f685922e94c9eca6aef2dc7cb776f8ee4fc04601b32ecf959f840d264fc34-7bb7cb863c8c4855.json"
  ),
  questionCount: 20,
  pageCount: 4,
  finalAnchor: "A는 노르웨이",
  expectedDecision: "accept",
  expectedCanonicalSubject: "integrated_social",
  expectedDpi: 600,
}, {
  index: 5,
  stateDir: join(process.cwd(), "data/import-exam-corpus/4142baa37330a6d3d470294a"),
  classificationPath: join(
    process.cwd(),
    "data/import-exam-corpus/4142baa37330a6d3d470294a/" +
      "classification-recoveries/v1-0004-0009-fecdbfac299fdcff5ae6e0aea267b5f41cdad60c684639b8d2e2160e937de6d2-7bb7cb863c8c4855.json"
  ),
  questionCount: 45,
  pageCount: 16,
  finalAnchor: "ⓐ, ⓑ, ⓒ, ⓓ, ⓔ는 각각 정확히 한 번 보인다.",
  expectedDecision: "reject",
  expectedDpi: 600,
}] as const;

const recoveryCasesAvailable = recoveryCases.every((item) =>
  existsSync(join(item.stateDir, "problem.pdf")) && existsSync(join(item.stateDir, "entry.json")) &&
  existsSync(item.classificationPath) && existsSync(cases[item.index].path)
);

async function runRecoveryManualCase(testCase: typeof recoveryCases[number]) {
  root = mkdtempSync(join(tmpdir(), "studywork-manual-recovery-"));
  const storedEntry = JSON.parse(readFileSync(join(testCase.stateDir, "entry.json"), "utf8")).entry;
  const entry = parseCorpusManifest({ schemaVersion: 2, entries: [storedEntry] }).entries[0];
  const officialProblemPath = join(testCase.stateDir, "problem.pdf");
  const problemBytes = readFileSync(officialProblemPath);
  const solutionDocument = await PDFDocument.create({ updateMetadata: false });
  solutionDocument.addPage([100, 100]);
  const solutionBytes = await solutionDocument.save();
  const solutionPath = join(root, "solution.pdf");
  writeFileSync(solutionPath, solutionBytes);
  const problem: PdfEvidence = {
    path: officialProblemPath,
    sha256: hash(problemBytes),
    bytes: problemBytes.length,
    pageCount: testCase.pageCount,
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
  const exhausted = itemAt(testCase.index);
  const exhaustedClassification = JSON.parse(
    readFileSync(testCase.classificationPath, "utf8")
  ).items[0] as ClassificationDecision;
  const targetNumber = Number(exhausted.number);
  const targetKey = `${exhausted.page}:${targetNumber}`;
  const questions: QuizItemEx[] = Array.from({ length: testCase.questionCount }, (_, index) => {
    const number = index + 1;
    if (number === targetNumber) {
      return { ...structuredClone(exhausted), question: `${exhausted.question}\n[base transcription]` };
    }
    return {
      number: String(number),
      qtype: "short",
      difficulty: "중",
      question: `${number}번 범위 밖 문제`,
      choices: null,
      answer: String(number),
      explanation: "",
      page: Math.min(testCase.pageCount, Math.max(1, Math.ceil(number / 3))),
      figure: false,
      figure_description: null,
      box: null,
    };
  });
  const targetDecision = (
    question: QuizItemEx,
    status: "exact" | "mismatch",
    evidence = status === "exact" ? "공식 source pixels와 일치한다." : "공식 source 시각 세부가 누락됐다."
  ): ClassificationDecision => ({
    ...exhaustedClassification,
    key: `${question.page}:${question.number}`,
    transcription_status: status,
    transcription_evidence: evidence,
  });
  const decisions = questions.map((question) => Number(question.number) === targetNumber
    ? targetDecision(question, "mismatch")
    : {
        key: `${question.page}:${question.number}`,
        decision: "reject" as const,
        canonical_subject: null,
        curriculum_course: null,
        domain: null,
        achievement_codes: [],
        confidence: 0.99,
        reason_codes: ["OUT_OF_SCOPE"],
        transcription_status: "exact" as const,
        transcription_evidence: "공식 source pixels와 일치한다.",
      });
  const classified = questions.map((question, index) => ({ question, classification: decisions[index] }));
  const solutions: SolutionItem[] = questions.map((question) => ({
    number: question.number!,
    answer: Number(question.number) === targetNumber ? exhausted.answer : question.answer,
    explanation: `${question.number}번 공식 해설`,
    page: 1,
    complete: true,
  }));
  writeJson(join(root, "problem-chunks", "v2-0000.json"), {
    version: 2,
    sourceHash: problem.sha256,
    from: 1,
    to: testCase.pageCount,
    ownedFrom: 1,
    ownedTo: testCase.pageCount,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    items: questions,
  });
  writeJson(join(root, "classification-chunks", `v${CLASSIFIER_VERSION}-0000-${CLASSIFIER_DIGEST}.json`), {
    version: CLASSIFIER_VERSION,
    sourceHash: problem.sha256,
    from: 1,
    to: testCase.pageCount,
    ownedFrom: 1,
    ownedTo: testCase.pageCount,
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

  const calls = { extraction: 0, classification: 0, terminal: 0, solution: 0 };
  providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
    if (request.schema?.name === "studywork_file_quiz_items") {
      calls.extraction++;
      const recovery = request.prompt.includes("FINAL SOURCE-GROUNDED RECOVERY");
      const item = structuredClone(exhausted);
      if (!recovery) item.question += calls.extraction === 1 ? "\n[first repair]" : "\n[first revision]";
      return { text: JSON.stringify([{ ...item, choiceCount: item.choices?.length ?? null }]) };
    }
    if (request.schema?.name === "studywork_exam_corpus_classification") {
      calls.classification++;
      const inputs = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{ question: string }>;
      if (calls.classification === 3) return { text: JSON.stringify([exhaustedClassification]) };
      return { text: JSON.stringify([targetDecision(
        exhausted,
        calls.classification === 1 ? "mismatch" : "exact",
        inputs[0].question.includes(testCase.finalAnchor)
          ? "수동 source evidence의 시각 세부까지 exact다."
          : "공식 source 시각 세부를 재검증했다."
      )]) };
    }
    if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
      calls.terminal++;
      const inputs = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{
        key: string;
        figure_description: string | null;
      }>;
      const targetScopeDecision = testCase.expectedDecision === "reject" && calls.terminal === 1
        ? "accept"
        : testCase.expectedDecision;
      return { text: JSON.stringify(inputs.map((input) => ({
        key: input.key,
        status: input.key !== targetKey || input.figure_description?.includes(testCase.finalAnchor)
          ? "exact"
          : "mismatch",
        evidence: input.key === targetKey && !input.figure_description?.includes(testCase.finalAnchor)
          ? "공식 source의 시각 세부가 누락됐다."
          : "공식 source pixels와 일치한다.",
        scopeDecision: input.key === targetKey ? targetScopeDecision : "reject",
        scopeConfidence: 0.99,
        scopeEvidence: input.key === targetKey && targetScopeDecision === "accept"
          ? "요청 교과 범위이다."
          : "요청 범위 밖이다.",
      }))) };
    }
    if (request.schema?.name === "studywork_exam_corpus_solution_fidelity") {
      calls.solution++;
      return { text: JSON.stringify([{
        key: targetKey,
        sourcePage: 1,
        answerStatus: "exact",
        explanationStatus: "exact",
        evidence: "공식 답과 해설이 일치한다.",
      }]) };
    }
    throw new Error(`unexpected schema ${request.schema?.name}`);
  });

  const result = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
  const repair = result.repairs.find((item) => item.key === targetKey)!;
  const manual = repair.revision!.recovery!.manualAdjudication!;
  expect(manual).toMatchObject({
    key: targetKey,
    cropEvidenceArtifact: { path: expect.stringMatching(/^problem-manual-evidence\/v1-/u) },
    cropEvidencePdf: { path: expect.stringMatching(/^problem-manual-evidence\/v1-/u) },
    problemArtifact: { path: expect.stringMatching(/^problem-manual-adjudications\/v1-/u) },
    classificationArtifact: { path: expect.stringMatching(/^classification-manual-adjudications\/v1-/u) },
  });
  expect(result.classified.find((item) => item.classification.key === targetKey)).toMatchObject({
    question: { figure_description: expect.stringContaining(testCase.finalAnchor) },
    classification: {
      decision: testCase.expectedDecision,
      transcription_status: "exact",
      ...("expectedCanonicalSubject" in testCase
        ? { canonical_subject: testCase.expectedCanonicalSubject }
        : {}),
    },
  });
  expect(result.problemTerminalFidelityItems.find((item) => item.key === targetKey)).toMatchObject({
    status: "exact",
    scopeDecision: testCase.expectedDecision,
  });
  expect(result.auditPath).toMatch(/^answer-audit\/v5-/u);
  const cropCheckpoint = JSON.parse(readFileSync(join(root, manual.cropEvidenceArtifact.path), "utf8"));
  expect(cropCheckpoint.dpi).toBe("expectedDpi" in testCase ? testCase.expectedDpi : 300);

  const beforeReplay = { ...calls };
  const replay = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
  expect(calls).toEqual(beforeReplay);
  expect(replay.auditHash).toBe(result.auditHash);

  const checkpointPath = join(root, manual.cropEvidenceArtifact.path);
  const checkpointBytes = readFileSync(checkpointPath);
  unlinkSync(checkpointPath);
  const beforeCrashReplay = { ...calls };
  const resumed = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
  expect(calls).toEqual(beforeCrashReplay);
  expect(readFileSync(checkpointPath)).toEqual(checkpointBytes);
  expect(resumed.auditHash).toBe(result.auditHash);

  const viewPath = join(root, manual.cropViews[0].artifact.path);
  const viewBytes = readFileSync(viewPath);
  writeFileSync(viewPath, Buffer.concat([viewBytes, Buffer.from("tampered")]));
  await expect(repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions))
    .rejects.toThrow(/crop evidence view file hash/u);
  expect(calls).toEqual(beforeCrashReplay);
  writeFileSync(viewPath, viewBytes);

  writeFileSync(join(root, "classification-manual-adjudications", "orphan.json"), "{}\n");
  await expect(repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions))
    .rejects.toThrow("manual adjudication orphan/conflict");
}

describe("exact allowlisted problem manual adjudication", () => {
  it("pins the six audited sources and exhausted child hashes", () => {
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.map((item) => ({
      entryId: item.entryId,
      key: item.key,
      sourcePage: item.sourcePage,
      sourceHash: item.sourceHash,
      parentKind: item.parentKind,
      failedQuestionHash: item.failedQuestionHash,
    }))).toEqual([{
      entryId: "ebsi:5594499",
      key: "13:34",
      sourcePage: 13,
      sourceHash: cases[0].sourceHash,
      parentKind: "crop",
      failedQuestionHash: "050900567ea5583ed78cf4fbeafc6cc0e014cb3eb480222bcf2cae22ed70ec7b",
    }, {
      entryId: "ebsi:5578421",
      key: "12:30",
      sourcePage: 12,
      sourceHash: cases[1].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "0bf9903e40726584efe854ea1e91984a7d8f99c4b43ff9529ed75a2903802dfc",
    }, {
      entryId: "ebsi:5525984",
      key: "3:8",
      sourcePage: 3,
      sourceHash: cases[2].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "9e4b37f842ef38b07710ff9ce1e358d847abadb1f57387c8a3b7174205027a78",
    }, {
      entryId: "ebsi:5656593",
      key: "7:18",
      sourcePage: 7,
      sourceHash: cases[3].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "79c49b622b055d72423e33d5a7038766173bf3923cf10d7c15a36a4bd7eb5e9e",
    }, {
      entryId: "ebsi:5854871",
      key: "2:9",
      sourcePage: 2,
      sourceHash: cases[4].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "3356445be5f6d28b112a307219a83cba0fefc3a8f88c30e01e2d2319498c81c1",
    }, {
      entryId: "ebsi:5594499",
      key: "4:9",
      sourcePage: 4,
      sourceHash: cases[5].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "6b45bc49e5f0e87b14c8b93fc23e845b668bd8185af847c9929021235f6a8759",
    }]);
  });

  it.skipIf(!available)("applies the exhaustive Q34 literal correction to the pinned crop child", () => {
    const corrected = applyAllowlistedProblemManualCorrection(cases[0].entryId, cases[0].sourceHash, itemAt(0));
    expect(corrected.question).toContain("문밖에서 삼월이 아뢰었다");
    expect(corrected.question).toContain("수천 번을 뚜드려 만든 쇠붙이 같으다");
    expect(corrected.question).toContain("적과 적의 칼이");
    expect(corrected.question).toContain("아씬 절로 가시야겄십니다");
    expect(corrected.question).toContain("가마가 내려지고 어머니가 뜰에 나섰\n[B]\n을 때");
    expect(corrected.question).toContain("치수의 두 눈에서 O.L*\n");
    expect(corrected.question).not.toMatch(/갑월|나오리|쌩쌩이|쾌척|회피였고|당황했다/u);
    expect(corrected.question.match(/^― /gmu)).toHaveLength(2);
    expect(corrected.figure_description).toContain("왼쪽 세로 묶음 괄호가 3개");
    expect(corrected.figure_description).toContain("가로 캡은 모두 6개");
    expect(corrected.figure_description).toContain("[A], ㉮, [B] 표지");
  });

  it.skipIf(!available)("preserves Q30/Q18 diagram roles and Q8 open/filled graph states", () => {
    const q30 = applyAllowlistedProblemManualCorrection(cases[1].entryId, cases[1].sourceHash, itemAt(1));
    expect(q30.question).toContain("㉢ 명제 논리학");
    expect(q30.question).toContain("$p$이다.                  ⇒       $p$");
    expect(q30.question).toContain("────────                         ────────");
    expect(q30.figure_description).toContain("가로선은 총 2개");
    expect(q30.figure_description).toContain("두 전제와 한 결론");

    const q8 = applyAllowlistedProblemManualCorrection(cases[2].entryId, cases[2].sourceHash, itemAt(2));
    expect(q8.figure_description).toContain("원점 $O=(0,0)$에는 뚫린 점");
    expect(q8.figure_description).toContain("$(0,-2)$에는 채운 점");
    expect(q8.figure_description).toContain("$(1,-3)$에는 뚫린 점");

    const q18 = applyAllowlistedProblemManualCorrection(cases[3].entryId, cases[3].sourceHash, itemAt(3));
    expect(q18.question.match(/호 \$\\overset\{\\frown\}\{N_1L_1\}\$/gu)).toHaveLength(2);
    expect(q18.question.match(/\[단일 곡선삼각형 도형문자\]/gu)).toHaveLength(2);
    expect(q18.question.match(/\[세 단일 곡선삼각형이 결합된 복합 도형문자\]/gu)).toHaveLength(2);
    expect(q18.question).not.toContain("△ 모양의 도형");
    expect(q18.figure_description).toContain("읽는 순서는 단일, 단일, 복합, 복합");
    expect(q18.figure_description).toContain("호 표기는 정확히 2회");
    expect(q18.figure_description).toContain("$R_1$, $R_2$, $R_3$ 세 단계 그림");
  });

  it.skipIf(!available)("corrects Q9 stem and all three wrong map labels while preserving C/D", () => {
    const q9 = applyAllowlistedProblemManualCorrection(cases[4].entryId, cases[4].sourceHash, itemAt(4));
    expect(q9.question).toContain("국가를 지도의 A~E에서 고른 것은?");
    expect(q9.question).not.toContain("지도에서 A~E에서");
    expect(q9.figure_description).toContain("A는 노르웨이");
    expect(q9.figure_description).toContain("B는 베트남");
    expect(q9.figure_description).toContain("C는 뉴질랜드");
    expect(q9.figure_description).toContain("D는 아르헨티나");
    expect(q9.figure_description).toContain("E는 베네수엘라");
    expect(q9.figure_description).not.toMatch(/영국|필리핀|파나마/u);
  });

  it.skipIf(!available)("applies all nine source-exact Q9 writing-plan corrections", () => {
    const q9 = applyAllowlistedProblemManualCorrection(cases[5].entryId, cases[5].sourceHash, itemAt(5));
    expect(q9.question).toContain("[9 ~ 10] 다음을 읽고 물음에 답하시오.");
    expect(q9.question).toContain("[글의 구상 도식]\n- 중앙: 그릿 / Grit");
    expect(q9.question).toContain("- 강연: ⓒ 강연 핵심 요약, ⓓ 강연을 들은 후 변화된 생각");
    expect(q9.question).toContain("천재들만 받는다는 맥아더 펠로상의 수상자");
    expect(q9.question).toContain("주변의 막연한 충고는 마음에 와 닿지 않았다.");
    for (const marker of ["㉠ 그릿", "㉡ 그릿", "㉢ 주목", "㉣ 그러나", "㉤ 떠올리고"]) {
      expect(q9.question).toContain(marker);
    }
    expect(q9.question).not.toMatch(/중심 주제:|강연 핵심 묘사|‘맥아더 펠로상’|㉠그릿|㉡그릿|㉢주목|㉣그러나|㉤떠올리고/u);
    expect(q9.figure_description).toContain("중앙에서 세 갈래 곡선이 뻗는다");
    expect(q9.figure_description).toContain("ⓐ, ⓑ, ⓒ, ⓓ, ⓔ는 각각 정확히 한 번 보인다");
  });

  it.skipIf(!available)("rejects a changed parent item before applying any correction", () => {
    const item = structuredClone(itemAt(2));
    item.question += " tampered";
    expect(canonicalEvidenceHash(item)).not.toBe(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[2].failedQuestionHash);
    expect(() => applyAllowlistedProblemManualCorrection(cases[2].entryId, cases[2].sourceHash, item))
      .toThrow(/failed question hash/u);
  });

  for (const testCase of recoveryCases) {
    it.skipIf(!recoveryCasesAvailable)(
      `replays ${cases[testCase.index].entryId} recovery-parent manual evidence without AI`,
      async () => runRecoveryManualCase(testCase),
      90_000
    );
  }
});
