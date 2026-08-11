import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
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
  adjudicateProblemManual,
  applyAllowlistedProblemManualCorrection,
  applyAllowlistedProblemManualRevision,
  assertProblemManualAdjudicationAuthority,
  canonicalEvidenceHash,
  parseCorpusManifest,
  parseDecisions,
  repairAndAuditOfficialAnswers,
  type ClassificationDecision,
  type ClassifiedQuestion,
  type PdfEvidence,
  type ProblemRecoveryEvidence,
} from "../scripts/import-exam-corpus";

const q27LiveState = join(process.cwd(), "data/import-exam-corpus/bb876a67170089dfb2022f47");

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

function stateSnapshot(directory: string): Array<[string, string, string]> {
  const output: Array<[string, string, string]> = [];
  const visit = (path: string, prefix: string) => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(child);
      if (stat.isSymbolicLink()) output.push([relative, "symlink", readlinkSync(child)]);
      else if (stat.isDirectory()) visit(child, relative);
      else output.push([relative, "file", hash(readFileSync(child))]);
    }
  };
  visit(directory, "");
  return output;
}

function removeManualArtifacts(stateDir: string, keys: string[]): void {
  const prefixes = keys.map((key) => {
    const [page, number] = key.split(":");
    return `v1-${page.padStart(4, "0")}-${number.padStart(4, "0")}-`;
  });
  for (const directory of [
    "problem-manual-evidence",
    "problem-manual-adjudications",
    "classification-manual-adjudications",
  ]) {
    const path = join(stateDir, directory);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path)) {
      if (prefixes.some((prefix) => name.startsWith(prefix))) rmSync(join(path, name));
    }
  }
}

function q27FixtureInputs(stateDir: string) {
  const entry = parseCorpusManifest({
    schemaVersion: 2,
    entries: [JSON.parse(readFileSync(join(stateDir, "entry.json"), "utf8")).entry],
  }).entries[0];
  const downloads = JSON.parse(readFileSync(join(stateDir, "downloads.json"), "utf8"));
  const problem: PdfEvidence = {
    ...downloads.problem,
    path: join(stateDir, "problem.pdf"),
    resolvedUrl: downloads.problem.requestedUrl,
  };
  const solution: PdfEvidence = {
    ...downloads.solution,
    path: join(stateDir, "solution.pdf"),
    resolvedUrl: downloads.solution.requestedUrl,
  };
  const questions = JSON.parse(readFileSync(join(stateDir, "problem-chunks/v2-0000.json"), "utf8"))
    .items as QuizItemEx[];
  const decisions = parseDecisions(
    JSON.parse(readFileSync(
      join(stateDir, `classification-chunks/v${CLASSIFIER_VERSION}-0000-${CLASSIFIER_DIGEST}.json`),
      "utf8"
    )).items,
    questions,
    entry
  );
  const byKey = new Map(decisions.map((decision) => [decision.key, decision]));
  const classified: ClassifiedQuestion[] = questions.map((question) => ({
    question,
    classification: byKey.get(`${question.page}:${Number(question.number)}`)!,
  }));
  const solutions = readdirSync(join(stateDir, "solution-chunks"))
    .filter((name) => /^v3-\d{4}\.json$/u.test(name))
    .sort()
    .flatMap((name) => JSON.parse(readFileSync(join(stateDir, "solution-chunks", name), "utf8")).items) as
    SolutionItem[];
  return { entry, problem, solution, classified, solutions };
}

function q27ExactRecoveryParent(stateDir: string): {
  failed: ClassifiedQuestion;
  parent: ProblemRecoveryEvidence;
} {
  const problemRelativePath =
    "problem-recoveries/v1-0011-0027-e2d59ea1699886f21ab5218fd221a8fa05f0beb46a1782ed48c9ec9cb583541c.json";
  const classificationRelativePath =
    "classification-recoveries/v1-0011-0027-9cae9db11869c6adbd575b6ee6b08ce51d75c483e3897a8afe1b698044223551-" +
    "7bb7cb863c8c4855.json";
  const problemCheckpoint = JSON.parse(readFileSync(join(stateDir, problemRelativePath), "utf8"));
  const classificationCheckpoint = JSON.parse(readFileSync(join(stateDir, classificationRelativePath), "utf8"));
  const basis = problemCheckpoint.basis;
  const question = problemCheckpoint.item as QuizItemEx;
  const classification = classificationCheckpoint.items[0] as ClassificationDecision;
  const parent: ProblemRecoveryEvidence = {
    key: basis.key,
    printedNumber: basis.printedNumber,
    sourcePage: basis.sourcePage,
    sourceHash: basis.sourceHash,
    contextFrom: basis.contextFrom,
    contextTo: basis.contextTo,
    baseProblemRepairArtifact: basis.baseProblemRepairArtifact,
    baseProblemRepairItemHash: basis.baseProblemRepairItemHash,
    baseClassificationRepairArtifact: basis.baseClassificationRepairArtifact,
    baseClassificationRepairItemHash: basis.baseClassificationRepairItemHash,
    baseProblemRevisionArtifact: basis.baseProblemRevisionArtifact,
    baseProblemRevisionItemHash: basis.baseProblemRevisionItemHash,
    baseClassificationRevisionArtifact: basis.baseClassificationRevisionArtifact,
    baseClassificationRevisionItemHash: basis.baseClassificationRevisionItemHash,
    problemArtifact: {
      path: problemRelativePath,
      sha256: "28ed8a585e6bac2b0de42cc1a252b780b75c7c8dfc171ff5e19569b97d865ffe",
    },
    problemArtifactItemHash: canonicalEvidenceHash(question),
    classificationArtifact: {
      path: classificationRelativePath,
      sha256: "7d6c1b764a2b3d9e4e4c777c2d3a2c06ff930f9f7c329b9309ef9dd3a80d0454",
      rulesDigest: classificationCheckpoint.rulesDigest,
      transcriptionGateVersion: classificationCheckpoint.transcriptionGateVersion,
      transcriptionPromptDigest: classificationCheckpoint.transcriptionPromptDigest,
      recoveryPromptVersion: classificationCheckpoint.recoveryPromptVersion,
      recoveryPromptDigest: classificationCheckpoint.recoveryPromptDigest,
    },
    classificationArtifactItemHash: canonicalEvidenceHash(classification),
    failedClassificationEvidenceHash: basis.failedClassificationEvidenceHash,
    baseQuestionHash: basis.baseQuestionHash,
    effectiveQuestionHash: canonicalEvidenceHash(question),
    baseClassificationHash: basis.baseClassificationHash,
    effectiveClassificationHash: canonicalEvidenceHash(classification),
  };
  expect(canonicalEvidenceHash(parent))
    .toBe("186e1381194aab5765fc72d88fb3e9a85901867d4a398588c7e38aa7f463dfdb");
  return { failed: { question, classification }, parent };
}

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
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(
    process.cwd(),
    "data/import-exam-corpus/bb876a67170089dfb2022f47/" +
      "problem-recoveries/v1-0011-0027-e2d59ea1699886f21ab5218fd221a8fa05f0beb46a1782ed48c9ec9cb583541c.json"
  ),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0016-0043-893ea8236c5d881c819d3336605183440bb53c94389a89db67589152ebf828d7.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0016-0044-c8841b55f41bfad8201f8aaff2df9a526b2400e2f125f0c22295b8d9d4c37ebb.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0016-0045-a3e22855003d515e214638d7d00f7ef2aa383e5310cc1c92b074fd226cacb15a.json"),
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
  it("pins the eleven audited sources and exhausted child hashes", () => {
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
    }, {
      entryId: "ebsi:5525982",
      key: "11:27",
      sourcePage: 11,
      sourceHash: cases[7].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "11c3fa247bebf72d1991540323f100af892ebc44cb36c2afa945ddcadd3524fd",
    }, {
      entryId: "ebsi:5525982",
      key: "16:43",
      sourcePage: 16,
      sourceHash: cases[8].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "40fbcf1de1b8b75e83c7844f7dbc7d344f07bb4ddea4f4d6276fc4f33d2fdc64",
    }, {
      entryId: "ebsi:5525982",
      key: "16:44",
      sourcePage: 16,
      sourceHash: cases[9].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "1a9a5ffba8dc8f7fe71ce7f334f59c319024de355592e64484e552934f9473f1",
    }, {
      entryId: "ebsi:5525982",
      key: "16:45",
      sourcePage: 16,
      sourceHash: cases[10].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "ba0d851b6048c4de5f86240cda0f054a66f2c54408d47ca284abf596da4198db",
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

  it.skipIf(!available)("replaces the whole Q27 passage and its one source-wrong choice", () => {
    const failed = itemAt(7);
    const spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[7];
    expect(spec.replacements).toEqual([expect.objectContaining({
      field: "question",
      from: failed.question,
      count: 1,
    }), expect.objectContaining({
      field: "choices",
      from: failed.choices?.[2],
      count: 1,
    })]);
    const corrected = applyAllowlistedProblemManualCorrection(cases[7].entryId, cases[7].sourceHash, failed);
    expect(canonicalEvidenceHash(corrected))
      .toBe("0364d049bef73773465b13f09fa2f234e9c7fc4ef4f9f9bdefeef0a8692c457b");
    expect(corrected.question).toContain("[27 ~ 32] 다음 글을 읽고 물음에 답하시오.");
    expect(corrected.question).toContain("이다지 낡아빠진 생활을 하는 것은 아니리라");
    expect(corrected.question).toContain("함이정 : 처녀 때 난 생각했었지.");
    expect(corrected.question).toContain("때를 놓치지 않으려는 듯 함묘진이 다급하게");
    expect(corrected.question).toContain("27. (가)를 이해한 내용으로 적절하지 않은 것은?");
    expect(corrected.question).not.toMatch(/이지러 낡아빠진|아니라라/u);
    expect(corrected.choices?.[2]).toBe(
      "③ 화자는 ‘고생도 마음대로 할 수 없는 세상’에서 ‘존재 없이’ 살아가는 것이 어렵다고 느끼고 있다."
    );
    expect(corrected.figure).toBe(true);
    expect(corrected.figure_description).toContain("왼쪽으로 열린 세로 묶음 괄호 [A]");
    expect(corrected.figure_description).toContain("같은 모양의 세로 묶음 괄호 [B]");
  });

  it.skipIf(!available)("replaces the exact Q43-Q45 source items without changing their answers", () => {
    const expected = [
      [8, "87113019baba8982c876c340bc9f85cfdc2196c2c8bff520495ec09fca91e0b4"],
      [9, "d1442d6b9b32e207e702dbfb8c4135ceb992d54b48b599f423eb70812bf10086"],
      [10, "ac66722a22fa15b19ba54228b4f13a341e8a0c57ef69e738ddb922f9bec92732"],
    ] as const;
    for (const [index, hash] of expected) {
      const failed = itemAt(index);
      const corrected = applyAllowlistedProblemManualCorrection(cases[index].entryId, cases[index].sourceHash, failed);
      expect(canonicalEvidenceHash(corrected)).toBe(hash);
      expect(corrected.answer).toBe(failed.answer);
      expect(corrected.question).toContain("[43 ~ 45] 다음 글을 읽고 물음에 답하시오.");
      expect(corrected.question).toContain("흥정 외상 셈하려 주주리는 지저귄다");
      expect(corrected.question).toContain("- 홍순학, ｢연행가｣ -");
      expect(corrected.figure).toBe(true);
      expect(corrected.figure_description).toContain("오른쪽으로 열린 세로 묶음 괄호가 정확히 두 개");
      expect(corrected.figure_description).toContain("관소로 돌아와서 회환(回還) 날짜 택일하니");
    }
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[8].failedStatus).toBe("exact");
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[9].failedStatus).toBeUndefined();
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[10].failedStatus).toBeUndefined();
    expect(applyAllowlistedProblemManualCorrection(cases[8].entryId, cases[8].sourceHash, itemAt(8)).choices?.[3])
      .toContain("외양과 감정");
    expect(applyAllowlistedProblemManualCorrection(cases[9].entryId, cases[9].sourceHash, itemAt(9)).choices?.[3])
      .toContain("새로운 계책");
    expect(applyAllowlistedProblemManualCorrection(cases[10].entryId, cases[10].sourceHash, itemAt(10)).choices?.[4])
      .toContain("겉밤");
  });

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "crash-resumes only Q27 before the unrelated Q43-Q45 blocker",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q27-manual-live-"));
    cpSync(q27LiveState, root, { recursive: true });
    for (const directory of [
      "problem-manual-evidence",
      "problem-manual-adjudications",
      "classification-manual-adjudications",
      "answer-audit",
      "answer-attestation",
    ]) rmSync(join(root, directory), { recursive: true, force: true });
    q27FixtureInputs(root);
    const calls = { extraction: [] as string[], classification: 0, unrelated: [] as string[] };
    let crashClassification = true;
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_file_quiz_items") {
        const single = request.prompt.match(/printed problem (\d+) starting on page (\d+)/u);
        const target = single
          ? `${single[2]}:${single[1]}`
          : request.prompt.match(/printed problems: ([^.]+)/u)?.[1] ?? "unknown";
        calls.extraction.push(target);
        if (target.includes("11:27")) throw new Error("Q27 extraction must not run");
        throw new Error(`unrelated persisted blocker: ${target}`);
      }
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        const inputs = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{ key: string }>;
        expect(inputs).toHaveLength(1);
        if (inputs[0].key !== "11:27") {
          calls.unrelated.push(inputs[0].key);
          throw new Error("unrelated persisted Q43-Q45 blocker");
        }
        calls.classification++;
        expect(request.prompt).toContain("이다지 낡아빠진 생활을 하는 것은 아니리라");
        expect(request.prompt).toContain("‘존재 없이’ 살아가는 것이 어렵다고");
        expect(request.prompt).not.toContain("공식 10쪽의 (가)에서 원문은");
        if (crashClassification) throw new Error("seeded Q27 manual classification crash");
        return { text: JSON.stringify([{
          key: "11:27",
          decision: "accept",
          canonical_subject: "korean_literature",
          curriculum_course: "문학",
          domain: "현대시의 화자와 자기 성찰 및 시어의 의미 이해",
          achievement_codes: ["12문학01-01", "12문학01-03"],
          confidence: 0.99,
          reason_codes: ["IN_SCOPE_KOREAN_LITERATURE", "MODERN_POETRY_COMPREHENSION"],
          transcription_status: "exact",
          transcription_evidence: "공식 10~11쪽의 (가), (나), Q27과 다섯 선택지가 모두 일치한다.",
        }]) };
      }
      throw new Error(`unexpected AI call: ${request.schema?.name ?? "unknown"}: ${request.prompt.slice(0, 500)}`);
    });
    const run = () => {
      const input = q27FixtureInputs(root);
      return repairAndAuditOfficialAnswers(
        input.entry,
        input.problem,
        input.solution,
        root,
        input.classified,
        input.solutions
      );
    };

    await expect(run()).rejects.toThrow(/seeded Q27 manual classification crash|unrelated persisted Q43-Q45 blocker/u);
    expect(calls.extraction).toEqual([]);
    expect(calls.classification).toBe(1);
    expect(calls.unrelated.length).toBeGreaterThan(0);
    expect(calls.unrelated.every((key) => ["16:43", "16:44", "16:45"].includes(key))).toBe(true);
    expect(readdirSync(join(root, "problem-manual-evidence"))
      .filter((name) => name.startsWith("v1-0011-0027-"))).toHaveLength(6);
    const q27ProblemNames = readdirSync(join(root, "problem-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0011-0027-"));
    expect(q27ProblemNames).toHaveLength(1);
    expect(existsSync(join(root, "classification-manual-adjudications"))
      ? readdirSync(join(root, "classification-manual-adjudications"))
        .filter((name) => name.startsWith("v1-0011-0027-")).length
      : 0).toBe(0);
    const problemName = q27ProblemNames[0];
    const problemPath = join(root, "problem-manual-adjudications", problemName);
    const problemBytes = readFileSync(problemPath);

    crashClassification = false;
    calls.classification = 0;
    calls.unrelated = [];
    await expect(run()).rejects.toThrow("unrelated persisted Q43-Q45 blocker");
    expect(calls.extraction).toEqual([]);
    expect(calls.classification).toBe(1);
    expect(calls.unrelated.length).toBeGreaterThan(0);
    expect(calls.unrelated.every((key) => ["16:43", "16:44", "16:45"].includes(key))).toBe(true);
    const q27ClassificationNames = readdirSync(join(root, "classification-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0011-0027-"));
    expect(q27ClassificationNames).toHaveLength(1);
    const classificationName = q27ClassificationNames[0];
    const classificationPath = join(root, "classification-manual-adjudications", classificationName);
    const classificationBytes = readFileSync(classificationPath);
    const problemCheckpoint = JSON.parse(problemBytes.toString("utf8"));
    const classificationCheckpoint = JSON.parse(classificationBytes.toString("utf8"));
    expect(canonicalEvidenceHash(problemCheckpoint.item))
      .toBe("0364d049bef73773465b13f09fa2f234e9c7fc4ef4f9f9bdefeef0a8692c457b");
    expect(classificationCheckpoint.items).toEqual([expect.objectContaining({
      key: "11:27",
      decision: "accept",
      canonical_subject: "korean_literature",
      curriculum_course: "문학",
      domain: expect.any(String),
      achievement_codes: expect.arrayContaining(["12문학01-01"]),
      transcription_status: "exact",
    })]);
    expect(problemCheckpoint.basis).toMatchObject({
      parentRecoveryEvidenceHash: "186e1381194aab5765fc72d88fb3e9a85901867d4a398588c7e38aa7f463dfdb",
      parentRecovery: {
      problemArtifact: {
        path: "problem-recoveries/v1-0011-0027-e2d59ea1699886f21ab5218fd221a8fa05f0beb46a1782ed48c9ec9cb583541c.json",
        sha256: "28ed8a585e6bac2b0de42cc1a252b780b75c7c8dfc171ff5e19569b97d865ffe",
      },
      classificationArtifact: {
        path: "classification-recoveries/v1-0011-0027-9cae9db11869c6adbd575b6ee6b08ce51d75c483e3897a8afe1b698044223551-7bb7cb863c8c4855.json",
        sha256: "7d6c1b764a2b3d9e4e4c777c2d3a2c06ff930f9f7c329b9309ef9dd3a80d0454",
      },
      },
    });
    expect(existsSync(join(root, "answer-audit"))).toBe(false);
    expect(existsSync(join(root, "answer-attestation"))).toBe(false);

    calls.extraction = [];
    calls.unrelated = [];
    const beforeReplayClassification = calls.classification;
    await expect(run()).rejects.toThrow("unrelated persisted Q43-Q45 blocker");
    expect(calls.extraction).toEqual([]);
    expect(calls.classification).toBe(beforeReplayClassification);
    expect(calls.unrelated.length).toBeGreaterThan(0);
    expect(calls.unrelated.every((key) => ["16:43", "16:44", "16:45"].includes(key))).toBe(true);
    expect(readFileSync(problemPath)).toEqual(problemBytes);
    expect(readFileSync(classificationPath)).toEqual(classificationBytes);
  }, 120_000);

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "preflights and crash-resumes Q43-Q45 before the unrelated Q8 blocker",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q43-45-manual-live-"));
    cpSync(q27LiveState, root, { recursive: true });
    removeManualArtifacts(root, ["16:43", "16:44", "16:45"]);
    for (const directory of ["answer-audit", "answer-attestation"]) {
      rmSync(join(root, directory), { recursive: true, force: true });
    }
    const calls = { classification: [] as string[], extraction: [] as string[], terminal: 0 };
    let crashKey: string | null = "16:44";
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        const inputs = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
          key: string;
          question: string;
          figure_description: string | null;
        }>;
        expect(inputs).toHaveLength(1);
        const item = inputs[0];
        const key = item.key;
        calls.classification.push(key);
        expect(["16:43", "16:44", "16:45"]).toContain(key);
        expect(item.question).toContain("[43 ~ 45] 다음 글을 읽고 물음에 답하시오.");
        expect(item.question).toContain("흥정 외상 셈하려 주주리는 지저귄다");
        expect(item.figure_description).toContain("오른쪽으로 열린 세로 묶음 괄호가 정확히 두 개");
        if (key === crashKey) throw new Error(`seeded ${key} manual classification crash`);
        return { text: JSON.stringify([{
          key,
          decision: "accept",
          canonical_subject: "korean_literature",
          curriculum_course: "문학",
          domain: "고전 기행 가사의 내용과 표현 및 부분별 감상",
          achievement_codes: ["12문학01-02", "12문학01-03"],
          confidence: 0.99,
          reason_codes: ["CLASSICAL_GASA", "LITERARY_COMPREHENSION"],
          transcription_status: "exact",
          transcription_evidence: `공식 16쪽 전체 제시문과 ${key} 발문·선택지가 일치한다.`,
        }]) };
      }
      if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
        calls.terminal++;
        const inputs = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{ key: string }>;
        expect(inputs).toHaveLength(45);
        expect(new Set(inputs.map((input) => input.key)).size).toBe(45);
        return { text: JSON.stringify(inputs.map(({ key }) => ({
          key,
          status: "exact",
          evidence: ["16:43", "16:44", "16:45"].includes(key)
            ? "공식 16쪽 전체 제시문·괄호·발문·선택지와 일치한다."
            : "공식 source pixels와 일치한다.",
          scopeDecision: "accept",
          scopeConfidence: 0.99,
          scopeEvidence: "교육과정 문학 또는 기존 단일 교과 범위이다.",
        }))) };
      }
      if (request.schema?.name === "studywork_file_quiz_items") {
        const single = request.prompt.match(/printed problem (\d+) starting on page (\d+)/u);
        const target = single
          ? `${single[2]}:${single[1]}`
          : request.prompt.match(/printed problems: ([^.]+)/u)?.[1] ?? "unknown";
        calls.extraction.push(target);
        throw new Error(`unrelated persisted blocker: ${target}`);
      }
      throw new Error(`unexpected AI call: ${request.schema?.name ?? "unknown"}`);
    });
    const run = () => {
      const input = q27FixtureInputs(root);
      return repairAndAuditOfficialAnswers(
        input.entry,
        input.problem,
        input.solution,
        root,
        input.classified,
        input.solutions
      );
    };

    await expect(run()).rejects.toThrow(/seeded 16:44 manual classification crash|unrelated persisted blocker: (?:4:8|6:15)/u);
    expect(calls.extraction).toContain("4:8");
    expect(calls.extraction.every((key) => ["4:8", "6:15"].includes(key))).toBe(true);
    expect(calls.terminal).toBe(0);
    expect([...calls.classification].sort()).toEqual(["16:43", "16:44", "16:45"]);
    const q43Problem = readdirSync(join(root, "problem-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0016-0043-"));
    const q43Classification = readdirSync(join(root, "classification-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0016-0043-"));
    const q44Problem = readdirSync(join(root, "problem-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0016-0044-"));
    expect(q43Problem).toHaveLength(1);
    expect(q43Classification).toHaveLength(1);
    expect(q44Problem).toHaveLength(1);
    expect(readdirSync(join(root, "classification-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0016-0044-"))).toHaveLength(0);
    expect(readdirSync(join(root, "problem-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0016-0045-"))).toHaveLength(1);
    expect(readdirSync(join(root, "classification-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0016-0045-"))).toHaveLength(1);
    const q43Bytes = readFileSync(join(root, "problem-manual-adjudications", q43Problem[0]));

    crashKey = null;
    calls.classification = [];
    calls.extraction = [];
    await expect(run()).rejects.toThrow(/unrelated persisted blocker: (?:4:8|6:15)/u);
    expect(calls.classification).toEqual(["16:44"]);
    expect(calls.extraction).toContain("4:8");
    expect(calls.extraction.every((key) => ["4:8", "6:15"].includes(key))).toBe(true);
    expect(calls.terminal).toBe(0);
    expect(readFileSync(join(root, "problem-manual-adjudications", q43Problem[0]))).toEqual(q43Bytes);
    for (const [key, hash] of [
      ["16:43", "87113019baba8982c876c340bc9f85cfdc2196c2c8bff520495ec09fca91e0b4"],
      ["16:44", "d1442d6b9b32e207e702dbfb8c4135ceb992d54b48b599f423eb70812bf10086"],
      ["16:45", "ac66722a22fa15b19ba54228b4f13a341e8a0c57ef69e738ddb922f9bec92732"],
    ] as const) {
      const [page, number] = key.split(":").map(Number);
      const problemName = readdirSync(join(root, "problem-manual-adjudications"))
        .find((name) => name.startsWith(`v1-${String(page).padStart(4, "0")}-${String(number).padStart(4, "0")}-`))!;
      const classificationName = readdirSync(join(root, "classification-manual-adjudications"))
        .find((name) => name.startsWith(`v1-${String(page).padStart(4, "0")}-${String(number).padStart(4, "0")}-`))!;
      expect(canonicalEvidenceHash(JSON.parse(readFileSync(
        join(root, "problem-manual-adjudications", problemName),
        "utf8"
      )).item)).toBe(hash);
      expect(JSON.parse(readFileSync(
        join(root, "classification-manual-adjudications", classificationName),
        "utf8"
      )).items).toEqual([expect.objectContaining({
        key,
        decision: "accept",
        canonical_subject: "korean_literature",
        curriculum_course: "문학",
        transcription_status: "exact",
      })]);
    }
    expect(existsSync(join(root, "answer-audit"))).toBe(false);

    const childSnapshot = stateSnapshot(root).filter(([path]) => path.includes("manual"));
    calls.classification = [];
    calls.extraction = [];
    await expect(run()).rejects.toThrow(/unrelated persisted blocker: (?:4:8|6:15)/u);
    expect(calls.classification).toEqual([]);
    expect(calls.extraction).toContain("4:8");
    expect(calls.extraction.every((key) => ["4:8", "6:15"].includes(key))).toBe(true);
    expect(calls.terminal).toBe(0);
    expect(stateSnapshot(root).filter(([path]) => path.includes("manual"))).toEqual(childSnapshot);

    const q43ProblemPath = join(root, "problem-manual-adjudications", q43Problem[0]);
    const q43ProblemCheckpoint = JSON.parse(readFileSync(q43ProblemPath, "utf8"));
    const q43Parent = q43ProblemCheckpoint.basis.parentRecovery as ProblemRecoveryEvidence;
    const q43Failed: ClassifiedQuestion = {
      question: JSON.parse(readFileSync(join(root, q43Parent.problemArtifact.path), "utf8")).item,
      classification: JSON.parse(readFileSync(join(root, q43Parent.classificationArtifact.path), "utf8")).items[0],
    };
    for (const name of readdirSync(join(root, "problem-manual-evidence"))) {
      if (name.startsWith("v1-0016-0043-")) rmSync(join(root, "problem-manual-evidence", name));
    }
    rmSync(q43ProblemPath);
    rmSync(join(root, "classification-manual-adjudications", q43Classification[0]));
    const q45ProblemName = readdirSync(join(root, "problem-manual-adjudications"))
      .find((name) => name.startsWith("v1-0016-0045-"))!;
    const q45ProblemPath = join(root, "problem-manual-adjudications", q45ProblemName);
    writeFileSync(q45ProblemPath, Buffer.concat([readFileSync(q45ProblemPath), Buffer.from(" ")]));
    const beforeCrossRowPreflight = stateSnapshot(root);
    providerMock.complete.mockClear();
    const input = q27FixtureInputs(root);
    await expect(adjudicateProblemManual(input.entry, input.problem, root, q43Failed, q43Parent))
      .rejects.toThrow(/16:45 manual adjudication hash가 다릅니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(beforeCrossRowPreflight);
  }, 180_000);

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "rejects Q27 parent, source, orphan, and max-one drift before manual writes or AI",
    async () => {
    const cases: Array<{
      label: string;
      mutate: (stateDir: string, parent: ProblemRecoveryEvidence) => void;
      error: RegExp;
    }> = [{
      label: "self-consistent alternate parent pointer",
      mutate: (stateDir, parent) => {
        const alias = `problem-recoveries/v1-0011-0027-${"0".repeat(64)}.json`;
        cpSync(join(stateDir, parent.problemArtifact.path), join(stateDir, alias));
        parent.problemArtifact = { ...parent.problemArtifact, path: alias };
        expect(canonicalEvidenceHash(parent))
          .not.toBe("186e1381194aab5765fc72d88fb3e9a85901867d4a398588c7e38aa7f463dfdb");
      },
      error: /manual adjudication 입력이 exhausted recovery/u,
    }, {
      label: "tampered official problem source",
      mutate: (stateDir) => writeFileSync(
        join(stateDir, "problem.pdf"),
        Buffer.concat([readFileSync(join(stateDir, "problem.pdf")), Buffer.from("tampered")])
      ),
      error: /공식 source bytes hash/u,
    }, {
      label: "orphan manual child",
      mutate: (stateDir) => {
        mkdirSync(join(stateDir, "problem-manual-adjudications"), { recursive: true });
        writeFileSync(join(stateDir, "problem-manual-adjudications", "orphan.json"), "{}\n");
      },
      error: /problem manual adjudication filename/u,
    }, {
      label: "two manual children",
      mutate: (stateDir) => {
        mkdirSync(join(stateDir, "problem-manual-adjudications"), { recursive: true });
        for (const digest of ["0".repeat(64), "1".repeat(64)]) {
          writeFileSync(
            join(stateDir, "problem-manual-adjudications", `v1-0011-0027-${digest}.json`),
            "{}\n"
          );
        }
      },
      error: /manual adjudication preflight orphan\/conflict/u,
    }];

    for (const testCase of cases) {
      const stateDir = mkdtempSync(join(tmpdir(), "studywork-q27-manual-prewrite-"));
      try {
        cpSync(q27LiveState, stateDir, { recursive: true });
        removeManualArtifacts(stateDir, ["11:27"]);
        const input = q27FixtureInputs(stateDir);
        const { failed, parent } = q27ExactRecoveryParent(stateDir);
        testCase.mutate(stateDir, parent);
        const before = stateSnapshot(stateDir);
        providerMock.complete.mockRejectedValue(new Error("AI must not run"));
        await expect(
          adjudicateProblemManual(input.entry, input.problem, stateDir, failed, parent),
          testCase.label
        ).rejects.toThrow(testCase.error);
        expect(providerMock.complete, testCase.label).not.toHaveBeenCalled();
        expect(stateSnapshot(stateDir), testCase.label).toEqual(before);
        providerMock.complete.mockReset();
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "validates every existing Q27 crop byte before resuming a missing earlier view",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q27-manual-partial-"));
    cpSync(q27LiveState, root, { recursive: true });
    removeManualArtifacts(root, ["11:27"]);
    const input = q27FixtureInputs(root);
    const { failed, parent } = q27ExactRecoveryParent(root);
    providerMock.complete.mockRejectedValue(new Error("seeded Q27 classification crash"));
    await expect(adjudicateProblemManual(input.entry, input.problem, root, failed, parent))
      .rejects.toThrow("seeded Q27 classification crash");
    const evidenceDirectory = join(root, "problem-manual-evidence");
    const checkpoint = readdirSync(evidenceDirectory)
      .find((name) => name.startsWith("v1-0011-0027-") && name.endsWith(".json"))!;
    const views = readdirSync(evidenceDirectory)
      .filter((name) => name.startsWith("v1-0011-0027-") && name.endsWith(".png"))
      .sort();
    expect(views).toHaveLength(4);
    rmSync(join(evidenceDirectory, checkpoint));
    rmSync(join(evidenceDirectory, views[0]));
    writeFileSync(
      join(evidenceDirectory, views[1]),
      Buffer.concat([readFileSync(join(evidenceDirectory, views[1])), Buffer.from("tampered")])
    );
    for (const directory of ["problem-manual-adjudications", "classification-manual-adjudications"]) {
      const path = join(root, directory);
      if (!existsSync(path)) continue;
      for (const name of readdirSync(path)) {
        if (name.startsWith("v1-0011-0027-")) rmSync(join(path, name));
      }
    }
    providerMock.complete.mockReset();
    providerMock.complete.mockRejectedValue(new Error("AI must not run"));
    const before = stateSnapshot(root);
    await expect(adjudicateProblemManual(input.entry, input.problem, root, failed, parent))
      .rejects.toThrow(/기존 binary evidence가 다릅니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(before);
  }, 120_000);

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
