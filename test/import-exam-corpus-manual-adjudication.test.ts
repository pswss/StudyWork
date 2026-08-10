import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  PROBLEM_MANUAL_REVISION_ALLOWLIST,
  TRANSCRIPTION_GATE_VERSION,
  TRANSCRIPTION_PROMPT_DIGEST,
  applyAllowlistedProblemManualCorrection,
  applyAllowlistedProblemManualRevision,
  assertProblemManualAdjudicationAuthority,
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

const Q43_CORRECTED_SOLUTION =
  "(가)에서는 ‘여기 하나의 상심한 사람이 있다.’와 ‘여기 하나의 굳세게 살아온 인생이 있다.’와 " +
  "같이 변주함으로써 주제 의식을 강조하고 있고, (나)에서는 ‘더 추워야겠다’와 ‘한껏 " +
  "가난해져야겠다’와 같이 유사한 시구를 변주함으로써 주제 의식을 강조하고 있다. [오답풀이] " +
  "① (가)에서는 마지막 부분에서 유사한 시구가 반복되기는 하지만 역동적 측면을 부각하는 것은 " +
  "아니며, (나)에서는 점층적 부분이 드러난다고 보기 어렵다. ② (가)에서는 의성어의 활용이 " +
  "드러나지 않고, (나)에서는 ‘카랑카랑’을 통해 새들의 목소리를 표현하고 있다. ④ 반어적 표현은 " +
  "(가)와 (나) 모두 찾기 어렵다. ⑤ 여정에 따른 공간 이동은 (가)와 (나) 모두 나타나지 않는다.";

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
}, {
  entryId: "ebsi:5577054",
  sourceHash: "d7664675fc1e39cc99f507d6cc7bf7c4a1404106d140d9a2f904726ddec4c062",
  path: join(
    process.cwd(),
    "data/import-exam-corpus/4745f3573f575a93f6adcccb/" +
      "problem-recoveries/v1-0016-0043-9f785a5c7a2c2ae2813ddce7acae5e846c5b29d63a7f37def793f9fd05e8a4d1.json"
  ),
}] as const;

const available = cases.every((item) => existsSync(item.path));
const itemAt = (index: number): QuizItemEx => JSON.parse(readFileSync(cases[index].path, "utf8")).item;
const q30ManualProblemPath = join(
  process.cwd(),
  "data/import-exam-corpus/f914a5cf8d2237d6c9319e23/" +
    "problem-manual-adjudications/v1-0012-0030-9160f0b6d43731cf2e42b1cfeb87067a4df0be2b12adae2946f12c560f1a9f64.json"
);
const q18ManualProblemPath = join(
  process.cwd(),
  "data/import-exam-corpus/714fd4581f778a9c559fd16e/" +
    "problem-manual-adjudications/v1-0007-0018-6bb09f45c9c5e829fcbcf1f47111735af9ec8269951655ff73239abc5ac16e94.json"
);

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
  manualRevisionClassificationPath: join(
    process.cwd(),
    "data/import-exam-corpus/f914a5cf8d2237d6c9319e23/" +
      "classification-manual-adjudications/v1-0012-0030-2415dd634f5b3bde1fa8113d4e6d2f6900a418dcc2d37da64067839a1ff2c9ae-7bb7cb863c8c4855.json"
  ),
  manualRevisionBeforeAnchor: "그리고 단순 명제 ‘$p$’와 ‘$q$’를 ‘만약 …이면 …이다.’",
  manualRevisionAfterAnchor: "그리고 단순 명제 ‘$p$’와 ‘$q$’는 ‘만약 …이면 …이다.’",
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
  manualRevisionClassificationPath: join(
    process.cwd(),
    "data/import-exam-corpus/714fd4581f778a9c559fd16e/" +
      "classification-manual-adjudications/v1-0007-0018-cab56b019c32271261bcb7389650c4d60fb52e22913de90a47412785e53752dc-7bb7cb863c8c4855.json"
  ),
  manualRevisionBeforeAnchor: "세 점 $L_1$, $M_1$, $N_1$이 각각 $\\overline{A_1B_1}$, " +
    "$\\overline{B_1C_1}$, $\\overline{C_1A_1}$의 중점이고,",
  manualRevisionAfterAnchor: "세 선분 $A_1B_1$, $B_1C_1$, $C_1A_1$의 중점을 각각 " +
    "$L_1$, $M_1$, $N_1$이라 하고,",
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
}, {
  index: 6,
  stateDir: join(process.cwd(), "data/import-exam-corpus/4745f3573f575a93f6adcccb"),
  classificationPath: join(
    process.cwd(),
    "data/import-exam-corpus/4745f3573f575a93f6adcccb/" +
      "classification-recoveries/v1-0016-0043-921b9df51f48b859874f6130f78341df54117e62171d973f74c7f115d64f36a7-7bb7cb863c8c4855.json"
  ),
  questionCount: 45,
  pageCount: 16,
  finalAnchor: "서로 겹치지 않는 [A], [B], [C] 순서",
  expectedDecision: "accept",
  expectedCanonicalSubject: "korean_literature",
  expectedDpi: 600,
  repairSolution: true,
}] as const;

const recoveryCasesAvailable = recoveryCases.every((item) =>
  existsSync(join(item.stateDir, "problem.pdf")) && existsSync(join(item.stateDir, "entry.json")) &&
  existsSync(item.classificationPath) && existsSync(cases[item.index].path) &&
  (!("manualRevisionClassificationPath" in item) || existsSync(item.manualRevisionClassificationPath))
);

async function runRecoveryManualCase(testCase: typeof recoveryCases[number]) {
  root = mkdtempSync(join(tmpdir(), "studywork-manual-recovery-"));
  const storedEntry = JSON.parse(readFileSync(join(testCase.stateDir, "entry.json"), "utf8")).entry;
  const entry = parseCorpusManifest({ schemaVersion: 2, entries: [storedEntry] }).entries[0];
  const officialProblemPath = join(testCase.stateDir, "problem.pdf");
  const problemBytes = readFileSync(officialProblemPath);
  const repairSolution = "repairSolution" in testCase;
  let solutionBytes: Uint8Array;
  let solutionPath: string;
  let solutionPageCount: number;
  if (repairSolution) {
    solutionPath = join(testCase.stateDir, "solution.pdf");
    solutionBytes = readFileSync(solutionPath);
    solutionPageCount = 5;
  } else {
    const solutionDocument = await PDFDocument.create({ updateMetadata: false });
    solutionDocument.addPage([100, 100]);
    solutionBytes = await solutionDocument.save();
    solutionPath = join(root, "solution.pdf");
    solutionPageCount = 1;
    writeFileSync(solutionPath, solutionBytes);
  }
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
    pageCount: solutionPageCount,
    requestedUrl: entry.solutionPdfUrl,
    resolvedUrl: entry.solutionPdfUrl,
  };
  const exhausted = itemAt(testCase.index);
  const exhaustedClassification = JSON.parse(
    readFileSync(testCase.classificationPath, "utf8")
  ).items[0] as ClassificationDecision;
  const failedManualClassification = "manualRevisionClassificationPath" in testCase
    ? JSON.parse(readFileSync(testCase.manualRevisionClassificationPath, "utf8")).items[0] as ClassificationDecision
    : null;
  const manualRevisionBeforeAnchor = "manualRevisionBeforeAnchor" in testCase
    ? testCase.manualRevisionBeforeAnchor
    : null;
  const manualRevisionAfterAnchor = "manualRevisionAfterAnchor" in testCase
    ? testCase.manualRevisionAfterAnchor
    : null;
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
  const baseTargetSolution = repairSolution
    ? (JSON.parse(readFileSync(join(testCase.stateDir, "solution-chunks/v3-0000.json"), "utf8"))
      .items as SolutionItem[]).find((item) => Number(item.number) === targetNumber)!
    : undefined;
  if (repairSolution) {
    expect(solution.sha256).toBe("2abfea3ad57f76b754720050839da1698222201359f290054d3c5564d3121f8a");
    expect(baseTargetSolution?.explanation).toMatch(/근세게|더 추워하겠다|여성어|가랑가랑/u);
  }
  const solutions: SolutionItem[] = questions.map((question) => Number(question.number) === targetNumber &&
      baseTargetSolution
    ? structuredClone(baseTargetSolution)
    : {
        number: question.number!,
        answer: Number(question.number) === targetNumber ? exhausted.answer : question.answer,
        explanation: `${question.number}번 공식 해설`,
        page: 1,
        complete: true,
      });
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
    to: solutionPageCount,
    ownedFrom: 1,
    ownedTo: solutionPageCount,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    items: solutions,
  });

  const calls = { extraction: 0, classification: 0, terminal: 0, solution: 0, solutionRepair: 0, semantic: 0 };
  let resumingManualRevision = false;
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
      if (failedManualClassification && resumingManualRevision) {
        expect(inputs).toHaveLength(1);
        expect(inputs[0].question).toContain(manualRevisionAfterAnchor);
        expect(request.prompt).not.toContain(failedManualClassification.transcription_evidence);
        return { text: JSON.stringify([targetDecision(
          exhausted,
          "exact",
          "공식 source pixels와 deterministic manual revision을 포함해 전체 문항이 일치한다."
        )]) };
      }
      if (calls.classification === 3) return { text: JSON.stringify([exhaustedClassification]) };
      if (failedManualClassification && calls.classification === 4) {
        expect(inputs[0].question).toContain(manualRevisionBeforeAnchor);
        return { text: JSON.stringify([failedManualClassification]) };
      }
      if (failedManualClassification && calls.classification === 5) {
        expect(inputs[0].question).toContain(manualRevisionAfterAnchor);
        expect(request.prompt).not.toContain(failedManualClassification.transcription_evidence);
        throw new Error("seeded manual revision crash");
      }
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
      const targetScopeDecision = testCase.expectedDecision === "reject" && calls.terminal === 1 &&
        !resumingManualRevision
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
        sourcePage: baseTargetSolution?.page ?? 1,
        answerStatus: "exact",
        explanationStatus: repairSolution && calls.solution === 1 ? "mismatch" : "exact",
        evidence: repairSolution && calls.solution === 1
          ? "공식 5쪽은 굳세게, 더 추워야겠다, 의성어, 카랑카랑인데 base 해설이 다르다."
          : "공식 답과 전체 해설이 일치한다.",
      }]) };
    }
    if (request.schema?.name === "studywork_solution_file_items") {
      calls.solutionRepair++;
      return { text: JSON.stringify([{
        number: String(targetNumber),
        answer: "③",
        explanation: Q43_CORRECTED_SOLUTION,
        page: 5,
        complete: true,
      }]) };
    }
    if (request.schema?.name === "studywork_exam_corpus_semantic_choice_check") {
      calls.semantic++;
      return { text: JSON.stringify([{
        key: targetKey,
        status: "resolved",
        choiceIndex: 3,
        evidence: "두 작품 모두 유사 시구를 변주해 주제 의식을 강조한다.",
      }]) };
    }
    throw new Error(`unexpected schema ${request.schema?.name}`);
  });

  if (failedManualClassification) {
    await expect(repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions))
      .rejects.toThrow("seeded manual revision crash");
    expect(calls).toMatchObject({
      extraction: 3,
      classification: 5,
      solution: 0,
      solutionRepair: 0,
      semantic: 0,
    });
    expect(calls.terminal).toBeGreaterThan(0);
    expect(readdirSync(join(root, "problem-manual-revisions"))).toHaveLength(1);
    expect(existsSync(join(root, "classification-manual-revisions"))).toBe(false);
    resumingManualRevision = true;
    Object.assign(calls, {
      extraction: 0,
      classification: 0,
      terminal: 0,
      solution: 0,
      solutionRepair: 0,
      semantic: 0,
    });
  }
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
  if (failedManualClassification) {
    const revisionSpec = PROBLEM_MANUAL_REVISION_ALLOWLIST.find((candidate) =>
      candidate.entryId === entry.id && candidate.key === targetKey
    )!;
    expect(manual.revision).toMatchObject({
      allowlistId: revisionSpec.allowlistId,
      failedQuestionHash: revisionSpec.failedQuestionHash,
      failedClassificationHash: revisionSpec.failedClassificationHash,
      failedClassificationEvidenceHash: revisionSpec.failedClassificationEvidenceHash,
      problemArtifact: { path: expect.stringMatching(/^problem-manual-revisions\/v1-/u) },
      classificationArtifact: { path: expect.stringMatching(/^classification-manual-revisions\/v1-/u) },
    });
    expect(result.classified.find((item) => item.classification.key === targetKey)?.question.question)
      .toContain(manualRevisionAfterAnchor);
    expect(calls).toMatchObject({
      extraction: 0,
      classification: 1,
      terminal: 1,
      solution: testCase.expectedDecision === "accept" ? 1 : 0,
    });
    const terminalKeys = result.problemTerminalFidelityItems.map((item) => item.key);
    expect(terminalKeys).toHaveLength(testCase.questionCount);
    expect(new Set(terminalKeys).size).toBe(testCase.questionCount);
    expect(result.problemTerminalFidelityItems.find((item) => item.key === targetKey)).toMatchObject({
      status: "exact",
      scopeDecision: testCase.expectedDecision,
    });
    const persistedTerminalKeys = result.problemTerminalFidelityCheckpoints.flatMap((pointer) => {
      const checkpoint = JSON.parse(readFileSync(join(root, pointer.path), "utf8"));
      expect(checkpoint.inputs).toHaveLength(checkpoint.items.length);
      return checkpoint.items.map((item: { key: string }) => item.key) as string[];
    });
    expect(new Set(persistedTerminalKeys).size).toBe(testCase.questionCount);
  }
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
  if (repairSolution) {
    expect(calls.solution).toBe(2);
    expect(calls.solutionRepair).toBe(1);
    expect(calls.semantic).toBe(1);
    expect(result.solutionRepairs).toEqual([expect.objectContaining({
      key: targetKey,
      repairArtifact: expect.objectContaining({ path: expect.stringMatching(/^solution-repairs\/v1-/u) }),
      fidelityArtifact: expect.objectContaining({
        path: expect.stringMatching(/^solution-fidelity-repairs\/v1-/u),
      }),
    })]);
    expect(result.solutions.find((item) => Number(item.number) === targetNumber)?.explanation)
      .toBe(Q43_CORRECTED_SOLUTION);
    expect(result.solutionFidelityItems).toEqual([expect.objectContaining({
      key: targetKey,
      answerStatus: "exact",
      explanationStatus: "exact",
    })]);
    expect(result.effectiveSolutionCorpusHash).not.toBe(canonicalEvidenceHash([{
      key: targetKey,
      solution: baseTargetSolution,
    }]));
  }
  const cropCheckpoint = JSON.parse(readFileSync(join(root, manual.cropEvidenceArtifact.path), "utf8"));
  expect(cropCheckpoint.dpi).toBe("expectedDpi" in testCase ? testCase.expectedDpi : 300);

  const beforeReplay = { ...calls };
  const replay = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
  expect(calls).toEqual(beforeReplay);
  expect(replay.auditHash).toBe(result.auditHash);

  if (manual.revision) {
    const revisionClassificationPath = join(root, manual.revision.classificationArtifact.path);
    const revisionClassificationBytes = readFileSync(revisionClassificationPath);
    unlinkSync(revisionClassificationPath);
    const beforeRevisionResume = { ...calls };
    const revisionResumed = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
    expect(calls).toEqual({ ...beforeRevisionResume, classification: beforeRevisionResume.classification + 1 });
    expect(readFileSync(revisionClassificationPath)).toEqual(revisionClassificationBytes);
    expect(revisionResumed.auditHash).toBe(result.auditHash);

    const tamperedRevision = JSON.parse(revisionClassificationBytes.toString("utf8"));
    tamperedRevision.unexpected = true;
    writeJson(revisionClassificationPath, tamperedRevision);
    const beforeRevisionTamper = { ...calls };
    await expect(repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions))
      .rejects.toThrow(/classification manual revision|exact envelope|manual revision classification/u);
    expect(calls).toEqual(beforeRevisionTamper);
    writeFileSync(revisionClassificationPath, revisionClassificationBytes);

    const extraChildRepairs = structuredClone(result.repairs);
    const extraChild = extraChildRepairs.find((item) => item.key === targetKey)!
      .revision!.recovery!.manualAdjudication!.revision! as unknown as Record<string, unknown>;
    extraChild.revision = {
      problemArtifact: manual.revision.problemArtifact,
      classificationArtifact: manual.revision.classificationArtifact,
    };
    const beforeExtraChild = { ...calls };
    await expect(assertProblemManualAdjudicationAuthority(root, extraChildRepairs))
      .rejects.toThrow(/classification manual revision checkpoint/u);
    expect(calls).toEqual(beforeExtraChild);
  }

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
  it("pins the seven audited sources and exhausted child hashes", () => {
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
    }, {
      entryId: "ebsi:5577054",
      key: "16:43",
      sourcePage: 16,
      sourceHash: cases[6].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "59b3c10380338bed7ed9fcdcdf746d30cccddff38cce54d0c98c7b9fa4722bfb",
    }]);
  });

  it.skipIf(!existsSync(q30ManualProblemPath) || !existsSync(q18ManualProblemPath))(
    "pins and applies the Q30/Q18 nested manual revisions",
    () => {
    expect(PROBLEM_MANUAL_REVISION_ALLOWLIST).toEqual([expect.objectContaining({
      allowlistId: "ebsi-5578421-q30-manual-revision-v1",
      parentAllowlistId: "ebsi-5578421-q30-manual-v1",
      entryId: "ebsi:5578421",
      key: "12:30",
      sourcePage: 12,
      sourceHash: cases[1].sourceHash,
      failedQuestionHash: "08ac10119b14fcad17f0d4f8f988198d8049d2d06d19b3b16cfd4d805e4ba010",
      failedClassificationHash: "b9134b6b9fd3cd9e274bd4883f370dd794f1c5f0d2e7d573d1d2b949dcff9ff7",
      failedClassificationEvidenceHash: "e96fd127cbadd152281d8bf436e2052d15863abdf208b06af9c650e68b3c6c13",
      expectedDecision: "accept",
      expectedCanonicalSubject: "korean_reading",
    }), expect.objectContaining({
      allowlistId: "ebsi-5656593-q18-manual-revision-v1",
      parentAllowlistId: "ebsi-5656593-q18-manual-v1",
      entryId: "ebsi:5656593",
      key: "7:18",
      sourcePage: 7,
      sourceHash: cases[3].sourceHash,
      failedQuestionHash: "2ee7a2fc3b6ac355c2e88de3cec5005d6f31b6caf1dd042019190d05dca06484",
      failedClassificationHash: "cd8e788264d66fb0413604efbff3b1fdfef2c968d3f79fbb377df8bbaab67c26",
      failedClassificationEvidenceHash: "1bdb0cdfbb305d5407cdb8d711efec1e2291cf2ef8a07026f2ee64781f8f8316",
      expectedDecision: "reject",
    })]);
    const parent = JSON.parse(readFileSync(q30ManualProblemPath, "utf8")).item as QuizItemEx;
    expect(canonicalEvidenceHash(parent)).toBe(PROBLEM_MANUAL_REVISION_ALLOWLIST[0].failedQuestionHash);
    const revised = applyAllowlistedProblemManualRevision(
      "ebsi:5578421",
      cases[1].sourceHash,
      "ebsi-5578421-q30-manual-v1",
      parent
    );
    expect(revised).toEqual({
      ...parent,
      question: parent.question.replace(
        "그리고 단순 명제 ‘$p$’와 ‘$q$’를 ‘만약 …이면 …이다.’에 해당하는 논리적 연결사",
        "그리고 단순 명제 ‘$p$’와 ‘$q$’는 ‘만약 …이면 …이다.’에 해당하는 논리적 연결사"
      ),
    });
    expect(revised.question.match(/‘\$p\$’와 ‘\$q\$’는 ‘만약/gu)).toHaveLength(1);
    expect(revised.question).not.toContain("‘$p$’와 ‘$q$’를 ‘만약");

    const q18Parent = JSON.parse(readFileSync(q18ManualProblemPath, "utf8")).item as QuizItemEx;
    expect(canonicalEvidenceHash(q18Parent)).toBe(PROBLEM_MANUAL_REVISION_ALLOWLIST[1].failedQuestionHash);
    const q18Revised = applyAllowlistedProblemManualRevision(
      "ebsi:5656593",
      cases[3].sourceHash,
      "ebsi-5656593-q18-manual-v1",
      q18Parent
    );
    expect(q18Revised).toEqual({
      ...q18Parent,
      question: q18Parent.question.replace(
        "세 점 $L_1$, $M_1$, $N_1$이 각각 $\\overline{A_1B_1}$, $\\overline{B_1C_1}$, " +
          "$\\overline{C_1A_1}$의 중점이고,",
        "세 선분 $A_1B_1$, $B_1C_1$, $C_1A_1$의 중점을 각각 $L_1$, $M_1$, $N_1$이라 하고,"
      ),
    });
    expect(canonicalEvidenceHash(q18Revised))
      .toBe("b67987dc571ad92d8c456cd7b6936a26e9434e42ce3dddb5f78057748e99717b");
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

  it.skipIf(!available)("replaces the whole failed Q43 passage with the exact p15-p16 source", () => {
    const failed = itemAt(6);
    const spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[6];
    expect(spec.replacements).toEqual([expect.objectContaining({
      field: "question",
      from: failed.question,
      count: 1,
    })]);
    const corrected = applyAllowlistedProblemManualCorrection(cases[6].entryId, cases[6].sourceHash, failed);
    expect(corrected.question).toContain("[43 ~ 45] 다음을 읽고 물음에 답하시오.");
    expect(corrected.question).toContain("시를 믿고 어떻게 살어가나");
    expect(corrected.question).toContain("먼― 기적(汽笛) 소리 처마를 스쳐가고");
    expect(corrected.question).toContain("잠들은 아내와 어린것의 벼개 맡에");
    expect(corrected.question).toContain("등불이 나에게 속삭어린다.");
    expect(corrected.question).toContain("운암댐 소롯길에 서서");
    expect(corrected.question).toContain("머언 먼 순은의 눈나라에서나 배웠음직한 몸짓이랑");
    expect(corrected.question).toContain("네 가슴에 못 박혀 삭고 싶은 속된 내 그리움은 또");
    expect(corrected.question).toContain("저 운암의 겨울새들의 행로를 보아버린 죄로");
    expect(corrected.question).toContain("- 김광균, ｢ 노신 ｣ -");
    expect(corrected.question).toContain("- 복효근, ｢ 새에 대한 반성문 ｣ -");
    expect(corrected.question).toContain("43. (가)와 (나)의 공통점에 대한 설명으로 가장 적절한 것은?");
    expect(corrected.question).not.toMatch(/살아가나|차마를|베개 밑에|속삭거린다|몽당비자루|소줏집|아슴차니|순순의|살고 싶은|저 운하의/u);
    expect(corrected.question.match(/^\[[ABC]\]$/gmu)).toEqual(["[A]", "[B]", "[C]"]);
    expect(corrected.choices).toEqual(failed.choices);
    expect(corrected.figure_description).toContain("왼쪽으로 열린 세로 묶음 괄호가 정확히 3개");
    expect(corrected.figure_description).toContain("서로 겹치지 않는 [A], [B], [C] 순서");
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
