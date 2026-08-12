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
  renameSync,
  rmSync,
  symlinkSync,
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
  PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST,
  TRANSCRIPTION_GATE_VERSION,
  TRANSCRIPTION_PROMPT_DIGEST,
  actionableTerminalFidelityIssues,
  adjudicateProblemManual,
  applyAllowlistedProblemManualCorrection,
  applyAllowlistedProblemManualRevision,
  applyAllowlistedProblemManualSourceRevision,
  assertProblemManualAdjudicationAuthority,
  canonicalEvidenceHash,
  parseCorpusManifest,
  parseDecisions,
  repairAndAuditOfficialAnswers,
  type ClassificationDecision,
  type ClassifiedQuestion,
  type PdfEvidence,
  type ProblemRepairEvidence,
  type ProblemRecoveryEvidence,
} from "../scripts/import-exam-corpus";

const q27LiveState = join(process.cwd(), "data/import-exam-corpus/bb876a67170089dfb2022f47");
const q30Q42ManualKeys: readonly string[] = [
  "11:30", "12:31", "12:32", "14:37", "15:38", "15:40", "15:41", "15:42",
];
const newTrueRepairManualKeys: readonly string[] = ["7:18", "7:19", "15:39"];

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

function removeManualRevisionArtifacts(stateDir: string, keys: string[]): void {
  const prefixes = keys.map((key) => {
    const [page, number] = key.split(":");
    return `v1-${page.padStart(4, "0")}-${number.padStart(4, "0")}-`;
  });
  for (const directory of [
    "problem-manual-revisions",
    "classification-manual-revisions",
    "problem-manual-second-revisions",
    "classification-manual-second-revisions",
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

function exactRecoveryParent(
  stateDir: string,
  problemRelativePath: string,
  classificationRelativePath: string,
  expectedParentHash: string
): {
  failed: ClassifiedQuestion;
  parent: ProblemRecoveryEvidence;
} {
  const problemBytes = readFileSync(join(stateDir, problemRelativePath));
  const classificationBytes = readFileSync(join(stateDir, classificationRelativePath));
  const problemCheckpoint = JSON.parse(problemBytes.toString("utf8"));
  const classificationCheckpoint = JSON.parse(classificationBytes.toString("utf8"));
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
      sha256: hash(problemBytes),
    },
    problemArtifactItemHash: canonicalEvidenceHash(question),
    classificationArtifact: {
      path: classificationRelativePath,
      sha256: hash(classificationBytes),
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
  expect(canonicalEvidenceHash(parent)).toBe(expectedParentHash);
  return { failed: { question, classification }, parent };
}

function q27ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0011-0027-e2d59ea1699886f21ab5218fd221a8fa05f0beb46a1782ed48c9ec9cb583541c.json",
    "classification-recoveries/v1-0011-0027-9cae9db11869c6adbd575b6ee6b08ce51d75c483e3897a8afe1b698044223551-" +
      "7bb7cb863c8c4855.json",
    "186e1381194aab5765fc72d88fb3e9a85901867d4a398588c7e38aa7f463dfdb"
  );
}

function q8ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0004-0008-2a1df1d1f5ce36c0a0c1953ffea79eadeaf7362fd0cfbee30dfd349fe0c97916.json",
    "classification-recoveries/v1-0004-0008-77436837e9a53cf4cc6c7bdfad9def301a9475e363bdca1d756161c92ad45718-" +
      "7bb7cb863c8c4855.json",
    "7d39ae1a99aa29102479ab0be361e01a364f2bf655bb770b81ccedec0f2f45a7"
  );
}

function q17ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0007-0017-f25fce5f04790b62b61851a6ce8771dd77d224dc962dd41f6d22bf037799b596.json",
    "classification-recoveries/v1-0007-0017-b609c64191307f85e8aefbc953a9facef111e0ecb4c4f0af1dff915210706ff8-" +
      "7bb7cb863c8c4855.json",
    "b9964bc828b45a8bb91ab4526563ffb8060cb197afb34581485673858507f6e6"
  );
}

function q18ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0007-0018-06e7d73768f018b14074754f24be4edcd44a0a827db48396f395f94619ff3295.json",
    "classification-recoveries/v1-0007-0018-95b1d6ac2ac315fed53bda0ecabd427e47b721b40a535d93d2a61aee091a863c-" +
      "7bb7cb863c8c4855.json",
    "c6e1102de25e6a751905958d31ea19375646a90d5d7e3b717d7d55bddaffbb70"
  );
}

function q19ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0007-0019-bbe87d7965f3ce7da4bfa1293717753d036729a8e02e8646c2ebf471518ca7f9.json",
    "classification-recoveries/v1-0007-0019-0389ce2367e4a98832a6f3fc9f7e75f54866d4110cc4528a16f4273a24025765-" +
      "7bb7cb863c8c4855.json",
    "dab952b2960c489006f15751116dcc7b1e8d6e9326a4278a0fd81991f8b5a50c"
  );
}

function q20ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0007-0020-bf8c01e2e30c975b6d417768d8f2fc75a0068a8c1e61ca3d1f8a7d541d9deaa6.json",
    "classification-recoveries/v1-0007-0020-417cece824faacd34b28f4b57b364033b84b39c461d0efe232d98c244cbfdab5-" +
      "7bb7cb863c8c4855.json",
    "720f3d723b4939d8d80b7a8e21e10a0559a1034872510206e3b91469d7dbe830"
  );
}

function q23ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0009-0023-fdf51b0ee15625b69b22a576c6e19e511cac3ae9916d16d88b581ef99de64dc6.json",
    "classification-recoveries/v1-0009-0023-9071e71519b2e6558466d6854af91d0b130bb5d42d02c4ac708f34723057ab68-" +
      "7bb7cb863c8c4855.json",
    "4183a4c0cceaa734b74198e0e4a78293035356fb2b53d9242c6863a2163be69f"
  );
}

function q28ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0011-0028-022c16b87254619033c6eebd32fa3777c5c80de1e314cbb92b823e85c5ec9776.json",
    "classification-recoveries/v1-0011-0028-5ad78252e58876eb4de4f041d514873c8bdd1ade2b63b0413e9b32cc91a28d5c-" +
      "7bb7cb863c8c4855.json",
    "ee49e74062dcd59bfa32d8c82b530f8de940c695da9afd364ccf174394b95fea"
  );
}

function q29ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0011-0029-d3a3866762b6cfb0894b1f74e4bb7227fec6f09109c9b66a3eaecd0cbe1313fd.json",
    "classification-recoveries/v1-0011-0029-334f8c6b9e9dbcd1203157a4c95d991692f7b7d7d4b11259623ef4d38429954e-" +
      "7bb7cb863c8c4855.json",
    "d88f9f50cdd2dfd34d7d74404027698347ffed38b98b8bb318f7d1be581d8ac2"
  );
}

function q30ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0011-0030-202d87d595e07f66b1284ec1648ff3fe3eecbb7d32274deb4e3532742d4cd262.json",
    "classification-recoveries/v1-0011-0030-c7a93c185f146d3b057945c3ed1c7be2f776c9c9698dfbf1e4e02c7f13f35fbd-" +
      "7bb7cb863c8c4855.json",
    "9d4f40e2325e13e6dd9c10f959962da421ee5a7b73bd1a7dd30c82af10cdf93b"
  );
}

function q31ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0012-0031-c07e95883d400b182b1a0ccebb4f94686df7d84207a77002fb030e9aabb326ec.json",
    "classification-recoveries/v1-0012-0031-60045db54855fe093ed30f42bc8898060e81ba88e148468ceceb36b187c76ebc-" +
      "7bb7cb863c8c4855.json",
    "a364a2fedaf9bffdba72022c2c51a2e9d672621f26c9bf723c046624d1365582"
  );
}

function q32ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0012-0032-3ceee04ce83231deaf7f91481e420fd649394a440b8c75a2c2ddd6be8563e069.json",
    "classification-recoveries/v1-0012-0032-da4e7c721ad769546d645a5538a8d4fdd577e22d9632b2a6f633d15d61e7379b-" +
      "7bb7cb863c8c4855.json",
    "10e903e5122357717cc01a3aa3a1eb86afd96f852c8deb4d2e20cf3b259926f7"
  );
}

function q37ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0014-0037-49354bf57e1ea9f037c416d839bb255905edc00c465707416482ee1c1ce54c07.json",
    "classification-recoveries/v1-0014-0037-98d4135e2f22fc494c1f0c2b9e9d11a59799af24562ebf58abfcb9b4d5b27da2-" +
      "7bb7cb863c8c4855.json",
    "d68f9a06514bb3af3d08ce4da864945d2df29c62c6152a08b457ca5067bad373"
  );
}

function q38ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0015-0038-f0a111b56171db4b4cd6d942cc4972629fccbdcadfbfbfe9757d7ff2762c8ebf.json",
    "classification-recoveries/v1-0015-0038-d19e2d9e8533fb8b35cd703c2bbf78763c3366a5bcc08ab94a2d745936355de9-" +
      "7bb7cb863c8c4855.json",
    "59a322acdb5c3211a6a26e34c906b1510533f08d7ca95cccf756d01b3e5604a8"
  );
}

function q39ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0015-0039-5f748be0e1d0c6866ae0bfa5cb116ba08d55c50ba907341481a590f04f90a195.json",
    "classification-recoveries/v1-0015-0039-1814765b3829514aeca357a4ab758b8c0a3172ac73db22bab914b5a590b7f60f-" +
      "7bb7cb863c8c4855.json",
    "c4f86ad116cf248fafcb360795081c949cd2442ed9c5375c56d5748385fdf25f"
  );
}

function q40ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0015-0040-f93efdcc07898d408ad1c4c89c2d6d57dcf96bdb6e68bd11ad6015ad15eeb24e.json",
    "classification-recoveries/v1-0015-0040-ee12e615bbaf0889c90dde6094a59607904c3b60fc85bbaebe0c74e7e89fecc3-" +
      "7bb7cb863c8c4855.json",
    "100910415cd507b1063d67a2741d3308f1543f04184fc646db245e9cbfb56d59"
  );
}

function q41ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0015-0041-89531809a502161b3e4fcea7802e0ccfca53b58938bb70e329d1c4f3c5107e63.json",
    "classification-recoveries/v1-0015-0041-ca6c2f969b6257a06b79a9ec28c8329e33d9925f0a79a5387d1a1bbcbaec6337-" +
      "7bb7cb863c8c4855.json",
    "58093bfe2be0b5b93c0495c450cb46f04c8e50df94607026f39fd42699a26e0d"
  );
}

function q42ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0015-0042-eadb7da9224ee4be24a7fed107de0e4251cfeab4346bb83ed32839388c0c9458.json",
    "classification-recoveries/v1-0015-0042-b5e4a0d83309d7265085ae387c1cc0ecfc7905ebf587c546e85e7d91eae43a9e-" +
      "7bb7cb863c8c4855.json",
    "6abad04cb27498469134ea70ad3f872b8a69e5f009905f223ec52211ca3185c1"
  );
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
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0004-0008-2a1df1d1f5ce36c0a0c1953ffea79eadeaf7362fd0cfbee30dfd349fe0c97916.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0006-0016-0034825317e678c15add0b4805f1d433ac8ce58f1182414daeb82278b7ee4c2f.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0007-0017-f25fce5f04790b62b61851a6ce8771dd77d224dc962dd41f6d22bf037799b596.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0007-0020-bf8c01e2e30c975b6d417768d8f2fc75a0068a8c1e61ca3d1f8a7d541d9deaa6.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0009-0023-fdf51b0ee15625b69b22a576c6e19e511cac3ae9916d16d88b581ef99de64dc6.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0011-0028-022c16b87254619033c6eebd32fa3777c5c80de1e314cbb92b823e85c5ec9776.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0011-0029-d3a3866762b6cfb0894b1f74e4bb7227fec6f09109c9b66a3eaecd0cbe1313fd.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0011-0030-202d87d595e07f66b1284ec1648ff3fe3eecbb7d32274deb4e3532742d4cd262.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0012-0031-c07e95883d400b182b1a0ccebb4f94686df7d84207a77002fb030e9aabb326ec.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0012-0032-3ceee04ce83231deaf7f91481e420fd649394a440b8c75a2c2ddd6be8563e069.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0014-0037-49354bf57e1ea9f037c416d839bb255905edc00c465707416482ee1c1ce54c07.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0015-0038-f0a111b56171db4b4cd6d942cc4972629fccbdcadfbfbfe9757d7ff2762c8ebf.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0015-0040-f93efdcc07898d408ad1c4c89c2d6d57dcf96bdb6e68bd11ad6015ad15eeb24e.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0015-0041-89531809a502161b3e4fcea7802e0ccfca53b58938bb70e329d1c4f3c5107e63.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0015-0042-eadb7da9224ee4be24a7fed107de0e4251cfeab4346bb83ed32839388c0c9458.json"),
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
const q32ManualProblemPath = join(
  q27LiveState,
  "problem-manual-adjudications/v1-0012-0032-6709751f073d010e1292ae92fd604d052055fc3aef358acad94a0a27e18d7e39.json"
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
  it("pins the twenty-nine audited sources and exhausted child hashes", () => {
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
    }, {
      entryId: "ebsi:5525982",
      key: "4:8",
      sourcePage: 4,
      sourceHash: cases[11].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "36e1747efaf51d29ed27eda862928d50f00b8705e30bc427b50ceffbe5389d3f",
    }, {
      entryId: "ebsi:5525982",
      key: "6:16",
      sourcePage: 6,
      sourceHash: cases[12].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "24a18e38193f474dc03c320cf23acdf0c9d65119cf6dbb544f7a087aa0bc37e8",
    }, {
      entryId: "ebsi:5525982",
      key: "7:17",
      sourcePage: 7,
      sourceHash: cases[13].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "2961d438f823a77f24b5d2a557d1a458b3fb9e4059d61ce1784cf426b7d61a3b",
    }, {
      entryId: "ebsi:5525982",
      key: "7:20",
      sourcePage: 7,
      sourceHash: cases[14].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "08d90afec9e8002f03d8e7ed6edcfbf6a7a38330a93db371499d1557157b8c33",
    }, {
      entryId: "ebsi:5525982",
      key: "9:23",
      sourcePage: 9,
      sourceHash: cases[15].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "91a7b3510abe21512465ac1636f6b582d242c1f2bf455f63e57a7694d689f1f5",
    }, {
      entryId: "ebsi:5525982",
      key: "11:28",
      sourcePage: 11,
      sourceHash: cases[16].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "6ed99a926dd0b20613490e79e79743d762e6235237359bae97c546f44f1db123",
    }, {
      entryId: "ebsi:5525982",
      key: "11:29",
      sourcePage: 11,
      sourceHash: cases[17].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "8125959ebccf15cb44344a2d3ce04b3d53f4a3665411f82ab2da6b4b62569c63",
    }, {
      entryId: "ebsi:5525982",
      key: "11:30",
      sourcePage: 11,
      sourceHash: cases[18].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "aa9ea468897a9e81ce965dae0d7d5045787aee721330279b6918326eb81ad191",
    }, {
      entryId: "ebsi:5525982",
      key: "12:31",
      sourcePage: 12,
      sourceHash: cases[19].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "b51b5c9e1d35d7cd60e90a47a8445ac091731395bb67eca0a33d7d0db2dbab02",
    }, {
      entryId: "ebsi:5525982",
      key: "12:32",
      sourcePage: 12,
      sourceHash: cases[20].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "0303cb02dc9e96fbabbf6f9eb565af80cf83f68c50cbf52baf7406ebeccbeb98",
    }, {
      entryId: "ebsi:5525982",
      key: "14:37",
      sourcePage: 14,
      sourceHash: cases[21].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "6a672fafc65c97a5d38e24027442a39c38ab28b64ca63d54a4140a75f1cfe993",
    }, {
      entryId: "ebsi:5525982",
      key: "15:38",
      sourcePage: 15,
      sourceHash: cases[22].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "d02b6e53c873d404b58c318dc36659415b52367099bb75832e2e20266a83baa0",
    }, {
      entryId: "ebsi:5525982",
      key: "15:40",
      sourcePage: 15,
      sourceHash: cases[23].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "538abfffe335301267fbd4d7421782946db6431b38f2209ae0b8d8aa6059e52b",
    }, {
      entryId: "ebsi:5525982",
      key: "15:41",
      sourcePage: 15,
      sourceHash: cases[24].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "d495f0be4c13ab152663bd673f5809497588661cbfd68d67acd987e98665106b",
    }, {
      entryId: "ebsi:5525982",
      key: "15:42",
      sourcePage: 15,
      sourceHash: cases[25].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "190871a47391d12bc13e3cba9fadc51f92640021482be78947420e95d89fe34d",
    }, {
      entryId: "ebsi:5525982",
      key: "7:18",
      sourcePage: 7,
      sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
      parentKind: "recovery",
      failedQuestionHash: "745287373aa1ae4b0b3b722379531007f6dcac703bebddbb3305b32bdfc0163c",
    }, {
      entryId: "ebsi:5525982",
      key: "7:19",
      sourcePage: 7,
      sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
      parentKind: "recovery",
      failedQuestionHash: "f6442fc7394763ffb573b62c1294bb25aba603bbadcd4bc332447aa2c426f46e",
    }, {
      entryId: "ebsi:5525982",
      key: "15:39",
      sourcePage: 15,
      sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
      parentKind: "recovery",
      failedQuestionHash: "b0f2287b7c860d7e5141198fb5f343a4f2498cc001e5bd16956f5ccc0f6987da",
    }]);
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 11)))
      .toBe("7851318ea1e176be603db1f2679081e16ef222d90ff704e39dce8d47db446268");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 13)))
      .toBe("fe8516451df56c3030a821886a42a93d1fa88dc87529060bd608f835bc0dc990");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 15)))
      .toBe("219a859d0ab52014822efa602cc0e090f5d0f31551502386d8ab6e775ed7c53a");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 26)))
      .toBe("4d844c71cc01ae752974edb5941ed475d80e76dd03bb5ee1a51a7b256512bb80");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST))
      .toBe("0b5d7d19255cd91566a55b289b11f8a9460a3014a06f255f9a266ebd62980cf9");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 18)))
      .toBe("463fceef246487e1ec791ffb0489048f874cd5944d946f9c6d819f3fd3c76eda");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[11]))
      .toBe("106ddb3c73dd5a2f12005c1bfe51eaa15830a89ee8dabaa82f14fe3ef5384cdf");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[12]))
      .toBe("9e0a7e81200e3187cf951dbc22282237166d897a7ff9eb2b5c69aaff726b1d0c");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[13]))
      .toBe("3b387191b6f43e3d83babbf0068ce1fb3a9e52bd3c9ba7f835964ee543facb64");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[14]))
      .toBe("4aad2f6a1d34af97338b72d86559472a0de7c6641d7ef643aae7819a1f0c232b");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[15]))
      .toBe("6be4f4fbb1848c327beb38415b8d2faf0193bbad4ae9e31d286803096862e540");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[16]))
      .toBe("b82020b2dd5fae081a3031887b345b337b5860156b75d6d7ce6137eb7bf40beb");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[17]))
      .toBe("fb9f306bf484870e7a355e6bd59dae03430d12c855acda631d8f7a191e74ef60");
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(18).map(canonicalEvidenceHash)).toEqual([
      "0d5d73306f77fc61f30ccde3e970f80499e4db7be3fbefc646350170cde9696e",
      "a68cbd6c6b2c4f27f2db4784b2b15a1e45f2255a764a2df7b48840514bf4abd4",
      "974562dc407ca854aebb49fb2fe9a56df97383a9f44407bd54ae949d2a85a796",
      "3002ecd3c82d2ee9e4927228ef082c58e317c88a103f0cf2d29317848813006c",
      "274ff9d1bab3e2b8adaaeca6a50cbd6ebab4d8efc9ce98f241531e554f5a7fbf",
      "352f1f625a2b842cd8cfb55b3b16442aa7610cba84e9134f8cb234ecf0c20eca",
      "17d17089a45be6edc291d7d5489176dcd18d00007589089db657ae618e71f593",
      "44900a00af38a5de0486bf115b0f1e928b5ee111f9df7f9ce3749b9beb416b83",
      "27f57efde1618ebb4403d334979d92d525b274e891d5be9c6f87b1299c9a0628",
      "a694fcf5c3308d1b4b4938cbae48325ad675722cb4e467ed0c39188b99632c7a",
      "a7dbfce35c74df5e429cf0acbda8289bb5210e043202eb674775d2d200e042bd",
    ]);
  });

  it.skipIf(!existsSync(q30ManualProblemPath) || !existsSync(q18ManualProblemPath) ||
    !existsSync(q32ManualProblemPath))(
    "pins and applies the Q30/Q18/Q32 nested manual revisions and Q32 source reversion",
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
    }), expect.objectContaining({
      allowlistId: "ebsi-5525982-q32-manual-revision-v1",
      parentAllowlistId: "ebsi-5525982-q32-manual-v1",
      entryId: "ebsi:5525982",
      key: "12:32",
      sourcePage: 12,
      sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
      failedQuestionHash: "e3f26787b00f65c346910a688088f941dce1b8b872e330491da0b61a8e3f5269",
      failedClassificationHash: "cf31dadc1233e5aef9e940d882a54c316fb1398c18f520d242103a40c8033ae3",
      failedClassificationEvidenceHash: "5ee5ce7694d4178d8047f9d1e30e326058c1af244e43eaacb11aad257d0abc18",
      expectedDecision: "accept",
      expectedCanonicalSubject: "korean_literature",
    })]);
    expect(PROBLEM_MANUAL_REVISION_ALLOWLIST.map(canonicalEvidenceHash)).toEqual([
      "479ebd4d7b57bd6ead1a4082b29d8c8c2cba1c7ebdb21634a3eda063986480b4",
      "9c38bfeaa57af0929eb5ec4f4a466588a5be42e59ff7be77576778d11a985792",
      "465a68f6f512ddc4e288552122287f9772ce3bddf63099b776dc5ab47663c943",
    ]);
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

    const q32Parent = JSON.parse(readFileSync(q32ManualProblemPath, "utf8")).item as QuizItemEx;
    expect(canonicalEvidenceHash(q32Parent)).toBe(PROBLEM_MANUAL_REVISION_ALLOWLIST[2].failedQuestionHash);
    const q32Revised = applyAllowlistedProblemManualRevision(
      "ebsi:5525982",
      "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
      "ebsi-5525982-q32-manual-v1",
      q32Parent
    );
    expect(q32Revised.question).toContain("(서연 곁으로 가서 개울물을 바라본다). 물 위에 비쳐 보여요");
    expect(q32Revised.question).toContain("(물을 떠서 마신다). 물이 맑고 시원해요.");
    expect(q32Revised.question).not.toContain("개울물을 바라본다.)");
    expect(q32Revised.question).not.toContain("물을 떠서 마신다.)");
    expect(canonicalEvidenceHash(q32Revised))
      .toBe("e3649d8930138bdc731c8642e24507e5d98f12da8d83503877ef92c3f31981bb");
    expect(PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST).toEqual([expect.objectContaining({
      allowlistId: "ebsi-5525982-q32-manual-source-revision-v1",
      parentRevisionAllowlistId: "ebsi-5525982-q32-manual-revision-v1",
      parentRevisionEvidenceHash: "944ad7e2ab07ffff727e3ac8923cfbee5b9e0499610a82eca37ccd7309c0abbd",
      failedQuestionHash: "e3649d8930138bdc731c8642e24507e5d98f12da8d83503877ef92c3f31981bb",
      failedClassificationHash: "e052bfaae96839742bad356f8235d214202d18baeb4bf3cc24d7e485b8042e2b",
      failedClassificationEvidenceHash: "d403219ab15a4d2584fb01f1abbed234cc824de7a7ef2df1e75f433c7442b205",
    })]);
    expect(PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST.map(canonicalEvidenceHash)).toEqual([
      "e6287eb8f4eaef8f24099c08afc13d077ad7792a1345f0296b7ce39fa4b07d39",
    ]);
    const q32SourceRevised = applyAllowlistedProblemManualSourceRevision(
      "ebsi:5525982",
      "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
      "ebsi-5525982-q32-manual-revision-v1",
      q32Revised
    );
    expect(canonicalEvidenceHash(q32SourceRevised))
      .toBe("e3f26787b00f65c346910a688088f941dce1b8b872e330491da0b61a8e3f5269");
    expect(q32SourceRevised).toEqual(q32Parent);
  });

  it.skipIf(!existsSync(join(
    q27LiveState,
    "problem-terminal-fidelity/v2-0000-01acbf628ec2f45a8c7024b7851c396c3e9b5ad12c59480ec573ecb8e6d5028e-" +
      "4bc1636d679f790075a71a3f79c5a35e522dac90ccb5c40d60137fadb952dd22.json"
  )))("partitions only Q8 and Q23 out of the pinned 01ac terminal issues", () => {
    const terminal = JSON.parse(readFileSync(join(
      q27LiveState,
      "problem-terminal-fidelity/v2-0000-01acbf628ec2f45a8c7024b7851c396c3e9b5ad12c59480ec573ecb8e6d5028e-" +
        "4bc1636d679f790075a71a3f79c5a35e522dac90ccb5c40d60137fadb952dd22.json"
    ), "utf8")) as { items: Array<{ key: string; status: string }> };
    const terminalIssues = terminal.items.filter((item) => item.status !== "exact").map((item) => item.key);
    expect(terminalIssues).toEqual([
      "4:8", "7:18", "7:19", "9:21", "9:22", "9:23", "9:24", "9:25", "9:26", "12:32", "15:39",
    ]);
    const deferred = new Set(["4:8", "9:23"]);
    expect(actionableTerminalFidelityIssues(terminalIssues, deferred)).toEqual([
      "7:18", "7:19", "9:21", "9:22", "9:24", "9:25", "9:26", "12:32", "15:39",
    ]);
    expect(() => actionableTerminalFidelityIssues(["4:8", "9:23"], deferred))
      .toThrow("terminal fidelity 최종 adjudication 대기: 4:8, 9:23");
    expect(() => actionableTerminalFidelityIssues(["4:8"], deferred))
      .toThrow("deferred terminal fidelity issue가 terminal issue 집합에 없습니다");
  });

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "completes true repairs without touching Q8 or Q23 before the fresh terminal boundary",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-terminal-defer-live-"));
    cpSync(q27LiveState, root, { recursive: true });
    const terminalRelativePath =
      "problem-terminal-fidelity/v2-0000-01acbf628ec2f45a8c7024b7851c396c3e9b5ad12c59480ec573ecb8e6d5028e-" +
      "4bc1636d679f790075a71a3f79c5a35e522dac90ccb5c40d60137fadb952dd22.json";
    expect(hash(readFileSync(join(root, terminalRelativePath))))
      .toBe("3a44b3aaf83126f90c7ec8f5fd7cc1d15f5c9e9d48420fc9bd2f21b542765b48");
    const deferredSnapshot = () => stateSnapshot(root).filter(([path]) =>
      /v1-0004-0008-|v1-0009-0023-/u.test(path) ||
      path.startsWith("problem-terminal-fidelity-adjudications/") ||
      path.startsWith("problem-terminal-fidelity-policy-revisions/")
    );
    const before = deferredSnapshot();
    const terminalBefore = stateSnapshot(join(root, "problem-terminal-fidelity"));
    const providerCalls: Array<{ schema: string; requested: string[] }> = [];
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      const schema = request.schema?.name ?? "unknown";
      if (schema === "studywork_exam_corpus_classification") {
        const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
          key: string;
          question: string;
        }>;
        const requested = items.map((item) => item.key);
        providerCalls.push({ schema, requested });
        expect(requested.every((key) => ["7:18", "7:19", "12:32", "15:39"].includes(key))).toBe(true);
        return { text: JSON.stringify(items.map((item) => ({
          key: item.key,
          decision: "accept",
          canonical_subject: item.key === "12:32" ? "korean_literature" : "korean_reading",
          curriculum_course: item.key === "12:32" ? "문학" : "독서와 작문",
          domain: item.key === "12:32" ? "희곡의 인물과 극적 기능" : "비문학 제시문의 추론적 읽기",
          achievement_codes: [item.key === "12:32" ? "12문학01-03" : "12독작01-04"],
          confidence: 0.99,
          reason_codes: ["SOURCE_EXACT"],
          transcription_status: "exact",
          transcription_evidence: `공식 source pixel과 ${item.key} 전체 문항이 일치한다.`,
        }))) };
      }
      if (schema === "studywork_exam_corpus_problem_terminal_fidelity") {
        providerCalls.push({ schema, requested: [] });
        const items = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{
          key: string;
          question: string;
        }>;
        expect(items).toHaveLength(45);
        expect(new Set(items.map((item) => item.key)).size).toBe(45);
        expect(items.find((item) => item.key === "4:8")?.question)
          .toContain("기사형 광고는 기사처럼 보이는 광고를 말한다.");
        expect(items.find((item) => item.key === "7:18")?.question)
          .toContain("경험을 통한 시험의 대상");
        expect(items.find((item) => item.key === "7:19")?.question)
          .toContain("선택하겠지만 실용적 필요");
        expect(items.find((item) => item.key === "12:32")?.question)
          .toContain("(물을 떠서 마신다.) 물이 맑고 시원해요.");
        expect(items.find((item) => item.key === "15:39")?.question)
          .toContain("39. [가]를 바탕으로 <보기>의 상황을 이해한 내용으로 적절한 것은?");
        expect(items.find((item) => item.key === "9:23")?.question)
          .toContain("이들 간의 대립 구도 하에서 전개되는 이야기는");
        expect(items.find((item) => item.key === "9:23")?.question)
          .toContain("외적의 침략이나 이념 갈등과 같은 공동체 사이의 갈등");
        throw new Error("seeded fresh true-repair terminal boundary");
      }
      if (schema !== "studywork_file_quiz_items") {
        providerCalls.push({ schema, requested: [] });
        throw new Error(`unexpected defer-gate provider call: ${schema}`);
      }
      const single = request.prompt.match(/printed problem (\d+) starting on page (\d+)/u);
      const batch = request.prompt.match(/printed problems: ([^\n.]+)/u);
      const requested = single
        ? [`${single[2]}:${single[1]}`]
        : (batch?.[1].match(/\d+/gu) ?? []).map((number) => `9:${number}`);
      providerCalls.push({ schema, requested });
      throw new Error("unexpected generic recovery before fresh true-repair terminal");
    });
    const input = q27FixtureInputs(root);
    await expect(repairAndAuditOfficialAnswers(
      input.entry,
      input.problem,
      input.solution,
      root,
      input.classified,
      input.solutions
    )).rejects.toThrow("seeded fresh true-repair terminal boundary");
    expect(providerCalls.length).toBeGreaterThan(0);
    const requested = [...new Set(providerCalls
      .filter((call) => call.schema === "studywork_exam_corpus_classification")
      .flatMap((call) => call.requested))].sort();
    expect(requested).toEqual([
      "12:32", "15:39", "7:18", "7:19",
    ]);
    expect(requested).not.toContain("4:8");
    expect(requested).not.toContain("9:23");
    expect(deferredSnapshot()).toEqual(before);
    expect(stateSnapshot(join(root, "problem-terminal-fidelity"))).toEqual(terminalBefore);
  }, 300_000);

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

  it.skipIf(!available)("restores the exact Q8 writing set and Q16 reading passage", () => {
    const q8Failed = itemAt(11);
    const q8 = applyAllowlistedProblemManualCorrection(cases[11].entryId, cases[11].sourceHash, q8Failed);
    expect(canonicalEvidenceHash(q8))
      .toBe("e5e1b8c0afdb43aa2bf537c2ecfb0b60b770979c8522c692db09002c3cf4680d");
    expect(q8.answer).toBe(q8Failed.answer);
    expect(q8.choices).toEqual(q8Failed.choices);
    expect(q8.question).toContain("[6 ~ 8] 다음을 읽고 물음에 답하시오.");
    expect(q8.question).toContain("매체 이용자들이 거부감 없이");
    expect(q8.question).toContain("기사형 광고는 기사처럼 보이는 광고를 말한다.");
    expect(q8.figure).toBe(true);
    expect(q8.figure_description).toContain("오른쪽으로 열린 세로 묶음 괄호가 정확히 두 개");
    expect(q8.figure_description).toContain("위에서 아래로 [A], [B] 순서");

    const q16Failed = itemAt(12);
    const q16 = applyAllowlistedProblemManualCorrection(cases[12].entryId, cases[12].sourceHash, q16Failed);
    expect(canonicalEvidenceHash(q16))
      .toBe("dd277b1ef288b108943920a59656bc3bc8c68f23c0cfad64296753248d375ea1");
    expect(q16.answer).toBe(q16Failed.answer);
    expect(q16.choices).toEqual(q16Failed.choices);
    expect(q16.question).toContain("[16 ~ 20] 다음 글을 읽고 물음에 답하시오.");
    expect(q16.question.match(/논리학 지식/gu)).toHaveLength(3);
    expect(q16.question).toContain("경험을 통한 시험의 대상");
    expect(q16.question).toContain("㉢ 도달한다");
    expect(q16.question).toContain("선택하겠지만 실용적 필요");
    expect(q16.figure).toBe(false);
    expect(q16.figure_description).toBeNull();
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.some((item) => item.key === "6:15")).toBe(false);
  });

  it.skipIf(!available)("restores the exact Q17 and Q20 reading items", () => {
    const q17Failed = itemAt(13);
    const q17 = applyAllowlistedProblemManualCorrection(cases[13].entryId, cases[13].sourceHash, q17Failed);
    expect(canonicalEvidenceHash(q17))
      .toBe("3d94de928dd1b8d443edcc908486bc81af356e352ea7edea32ee1f43166ef0be");
    expect(q17.answer).toBe(q17Failed.answer);
    expect(q17.question).toContain("[16 ~ 20] 다음 글을 읽고 물음에 답하시오.");
    expect(q17.question.match(/논리학 지식/gu)).toHaveLength(3);
    expect(q17.question).toContain("경험을 통한 시험의 대상");
    expect(q17.question).toContain("이 둘을 서로 대체하더라도");
    expect(q17.question).toContain("선택하겠지만 실용적 필요");
    expect(q17.choices?.[2]).toContain("근본적으로 다르다고 한다.");
    expect(q17.figure).toBe(false);

    const q20Failed = itemAt(14);
    const q20 = applyAllowlistedProblemManualCorrection(cases[14].entryId, cases[14].sourceHash, q20Failed);
    expect(canonicalEvidenceHash(q20))
      .toBe("1106e5ec6656305c38b4b58770b4acfa0e3e7a6a6d2ee412d10e86e8b99f75c0");
    expect(q20.answer).toBe(q20Failed.answer);
    expect(q20.choices).toEqual(q20Failed.choices);
    expect(q20.question).toContain("[16 ~ 20] 다음 글을 읽고 물음에 답하시오.");
    expect(q20.question).toContain("문맥상 ㉢과 바꿔 쓰기에 가장 적절한 것은?");
    expect(q20.figure).toBe(false);
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.filter((item) =>
      item.entryId === "ebsi:5525982" && ["7:18", "7:19"].includes(item.key)
    ).every((item) => item.failedStatus === "exact")).toBe(true);
  });

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "restores the source-exact Q18, Q19, and Q39 from exact recovery parents",
    () => {
    const rows = [
      [q18ExactRecoveryParent(q27LiveState).failed, "e6f77c8aa3a10c5549e95eb6d3b3974587b2b3a16db009fb483ad9099943417f"],
      [q19ExactRecoveryParent(q27LiveState).failed, "64e29a3f28bad8602f35bcbf89542202e7b5cc4a587ed586474626a0085090d4"],
      [q39ExactRecoveryParent(q27LiveState).failed, "45089f6c171df3fa64b68ec782741ee58212d249566ce43837941f204e9780cf"],
    ] as const;
    for (const [failed, expectedHash] of rows) {
      const corrected = applyAllowlistedProblemManualCorrection(
        "ebsi:5525982",
        "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
        failed.question
      );
      expect(canonicalEvidenceHash(corrected)).toBe(expectedHash);
      expect(corrected.choices).toEqual(failed.question.choices);
      expect(corrected.answer).toBe(failed.question.answer);
      expect(corrected.figure).toBe(false);
    }
    const q18 = applyAllowlistedProblemManualCorrection(
      "ebsi:5525982",
      "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
      rows[0][0].question
    );
    expect(q18.question).toContain("기존의 지식과 M에 열을 가했다는 조건");
    expect(q18.question).toContain("경험을 통한 시험의 대상");
    expect(q18.question).toContain("선택하겠지만 실용적 필요");
    const q39 = applyAllowlistedProblemManualCorrection(
      "ebsi:5525982",
      "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
      rows[2][0].question
    );
    expect(q39.question).toContain("[37~42] 다음 글을 읽고 물음에 답하시오.");
    expect(q39.question).toContain("39. [가]를 바탕으로 <보기>의 상황을 이해한 내용으로 적절한 것은?");
  });

  it.skipIf(!available)("restores the exact Q23, Q28, and Q29 literature items", () => {
    const expected = [
      [15, "e4886fd0c2386eba4d4f84d0ef6f1954fc92b8d3a5ddfe99788d533f69f8cb56"],
      [16, "a15e214e36dd59e6275e46afcb15b84b13102a55c3545dd0d25eeedfd94bb86e"],
      [17, "573a51fae9eb3e4c5ea2aa6697fcf5ad01e0aa4826645865d2e5b012416e1618"],
    ] as const;
    for (const [index, expectedHash] of expected) {
      const failed = itemAt(index);
      const corrected = applyAllowlistedProblemManualCorrection(cases[index].entryId, cases[index].sourceHash, failed);
      expect(canonicalEvidenceHash(corrected)).toBe(expectedHash);
      expect(corrected.answer).toBe(failed.answer);
    }

    const q23 = applyAllowlistedProblemManualCorrection(cases[15].entryId, cases[15].sourceHash, itemAt(15));
    expect(q23.question).toContain("[21 ~ 26] 다음 글을 읽고 물음에 답하시오.");
    expect(q23.question).toContain("그렇게들 안 할 거예요.");
    expect(q23.question).toContain("짊어지고 일어섰다.");
    expect(q23.question).toContain("“애기 엄마…….”");
    expect(q23.question).toContain("23. (가)를 바탕으로 (나)를 설명한 것으로 적절하지 않은 것은?");
    expect(q23.question).not.toMatch(/외적인 침략|범하며 벽력|구름을 드리우고|밟혀 죽으매|바탕으로,/u);
    expect(q23.figure).toBe(false);

    const q28 = applyAllowlistedProblemManualCorrection(cases[16].entryId, cases[16].sourceHash, itemAt(16));
    expect(q28.question).toContain("[27 ~ 32] 다음 글을 읽고 물음에 답하시오.");
    expect(q28.question).toContain("이다지 낡아빠진 생활을 하는 것은 아니리라");
    expect(q28.question).toContain("함이정 : 처녀 때 난 생각했었지.");
    expect(q28.question).toContain("28. <보기>를 고려하여 (가)를 감상한 내용으로 적절하지 않은 것은?");
    expect(q28.figure).toBe(true);
    expect(q28.figure_description).toBe(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[7].figureDescription);

    const q29 = applyAllowlistedProblemManualCorrection(cases[17].entryId, cases[17].sourceHash, itemAt(17));
    expect(q29.question).toContain("나의 그릇됨을 꾸짖어 주어도 좋다");
    expect(q29.question.match(/날아간 제비와 같이/gu)).toHaveLength(2);
    expect(q29.question).toContain("때를 놓치지 않으려는 듯");
    expect(q29.choices?.[4]).toBe(
      "⑤ [A]와 [B]는 대상의 속성을 반어적으로 표현함으로써 화자나 인물의 심리적 상황을 드러내고 있다."
    );
    expect(q29.figure).toBe(true);
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.some((item) =>
      item.entryId === "ebsi:5525982" && ["9:21", "9:22", "9:24", "9:25", "9:26"].includes(item.key)
    )).toBe(false);
  });

  it.skipIf(!available)("restores the exact Q30-Q42 literature and reading items", () => {
    const expected = [
      [18, "e6e694a660190ad645dcd3cbaf1549281bdd056c04802907c04db2c061784897"],
      [19, "5ab49dec77f4e47ae71671c2ebd38e16a1e387cece768bbdd45ace55cde2f6fa"],
      [20, "e3f26787b00f65c346910a688088f941dce1b8b872e330491da0b61a8e3f5269"],
      [21, "ceea23fac5375f0d514c61a3a0a49754ea67796458365b3c17de6f67ad5837fd"],
      [22, "3a84154e36d6a7a703afecb37e7e090e46ea5c9b6aa6cf6235d96718a4416c57"],
      [23, "b7fdf4136ce89e411f5e65c7e4cc2a98ef30ea97f3aae7d3098a9556884aed3d"],
      [24, "371eba06e9adf7dec40b792dd060a10fa87237384dd6b7f20c2b4629eec8a876"],
      [25, "4e708254da01f6edf7b57bde696ef5af8faec1116dfb3ebf8eb7e1a3b5daabe8"],
    ] as const;
    const corrected = expected.map(([index, expectedHash]) => {
      const item = applyAllowlistedProblemManualCorrection(cases[index].entryId, cases[index].sourceHash, itemAt(index));
      expect(canonicalEvidenceHash(item)).toBe(expectedHash);
      return item;
    });
    expect(corrected[0].question).toContain("30. 무대 상연을 전제로 하는 희곡의 특성을");
    expect(corrected[0].figure).toBe(true);
    expect(corrected[1].answer).toContain("조숭인");
    expect(corrected[1].answer).not.toContain("조승인");
    expect(corrected[2].choices?.[1]).toContain("이야기 속의 인물들을");
    expect(corrected[2].answer).toContain("조숭인");
    expect(corrected[3].question).toContain("이미 보험금을 지급했다면");
    expect(corrected[3].question).toContain("37. 윗글에 대한 설명으로 가장 적절한 것은?");
    expect(corrected.slice(3).every((item) => item.figure === false && item.figure_description === null)).toBe(true);
    expect(corrected[6].choices?.[1]).toContain("없다 하더라도 A는");
    expect(corrected[6].answer).toContain("고지하지 않은 중요한 사항");
    expect(corrected[6].answer).not.toContain("‘중요한 사항’");
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.filter((item) =>
      item.entryId === "ebsi:5525982" && item.failedStatus === "exact").map((item) => item.key).sort())
      .toEqual(["11:30", "14:37", "15:39", "16:43", "7:18", "7:19"]);
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.some((item) => item.key === "15:39")).toBe(true);
  });

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "crash-resumes Q30-Q42 children and opens the fresh 45-key terminal",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q30-q42-manual-live-"));
    cpSync(q27LiveState, root, { recursive: true });
    const keys = [...q30Q42ManualKeys, ...newTrueRepairManualKeys];
    removeManualArtifacts(root, keys);
    removeManualRevisionArtifacts(root, ["12:32"]);
    for (const directory of ["answer-audit", "answer-attestation"]) {
      rmSync(join(root, directory), { recursive: true, force: true });
    }
    const input = q27FixtureInputs(root);
    const parents = [
      q30ExactRecoveryParent(root), q31ExactRecoveryParent(root), q32ExactRecoveryParent(root),
      q37ExactRecoveryParent(root), q38ExactRecoveryParent(root), q40ExactRecoveryParent(root),
      q41ExactRecoveryParent(root), q42ExactRecoveryParent(root), q18ExactRecoveryParent(root),
      q19ExactRecoveryParent(root), q39ExactRecoveryParent(root),
    ];
    const calls = { classification: [] as string[], terminal: 0, downstream: [] as string[] };
    let crashKey: string | null = "12:31";
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
          key: string;
          question: string;
          figure_description: string | null;
        }>;
        expect(items).toHaveLength(1);
        const item = items[0];
        expect(keys).toContain(item.key);
        calls.classification.push(item.key);
        if (item.key === crashKey) throw new Error("seeded Q31 manual classification crash");
        const literature = ["11:30", "12:31", "12:32"].includes(item.key);
        if (!newTrueRepairManualKeys.includes(item.key)) {
          expect(item.question).toContain(`${item.key.split(":")[1]}.`);
        }
        if (literature) expect(item.figure_description).toContain("세로 묶음 괄호 [A]");
        else expect(item.figure_description).toBeNull();
        return { text: JSON.stringify([{
          key: item.key,
          decision: "accept",
          canonical_subject: literature ? "korean_literature" : "korean_reading",
          curriculum_course: literature ? "문학" : "독서와 작문",
          domain: literature ? "현대시와 희곡의 표현 및 감상" : "보험의 경제 원리와 고지 의무",
          achievement_codes: literature ? ["12문학01-03"] : ["12독작01-03"],
          confidence: 0.99,
          reason_codes: ["SOURCE_EXACT", "IN_SCOPE_KOREAN"],
          transcription_status: "exact",
          transcription_evidence: `공식 source의 ${item.key} 전체 지문·발문·선택지가 일치한다.`,
        }]) };
      }
      if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
        calls.terminal++;
        const items = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{
          key: string;
          question: string;
          choices: string[] | null;
          figure: boolean;
          figure_description: string | null;
        }>;
        expect(items).toHaveLength(45);
        expect(new Set(items.map((item) => item.key)).size).toBe(45);
        expect(keys.every((key) => items.some((item) => item.key === key))).toBe(true);
        const byKey = new Map(items.map((item) => [item.key, item]));
        expect(byKey.get("11:30")).toMatchObject({
          figure: true,
          question: expect.stringContaining("이다지 낡아빠진 생활을 하는 것은 아니리라"),
          figure_description: expect.stringContaining("세로 묶음 괄호 [A]"),
        });
        expect(byKey.get("12:32")?.question).toContain("조숭인 : 처음부터 다시 이야기해 주세요");
        expect(byKey.get("12:32")?.choices?.[1]).toContain("이야기 속의 인물들을");
        expect(byKey.get("14:37")?.question).toContain("이미 보험금을 지급했다면");
        expect(byKey.get("14:37")?.question).not.toContain("이미 보험금을 지급하였다면");
        expect(byKey.get("15:41")?.choices?.[1]).toContain("없다 하더라도 A는");
        expect(byKey.get("15:41")?.choices?.[3]).toContain("고지하지 않은 중요한 사항");
        expect(byKey.get("15:41")?.choices?.[3]).not.toContain("‘중요한 사항’");
        throw new Error("seeded fresh Q30-Q42 terminal boundary");
      }
      const schema = request.schema?.name ?? "unknown";
      calls.downstream.push(schema);
      throw new Error(`honest downstream blocker: ${schema}`);
    });
    const runChild = (row: ReturnType<typeof q30ExactRecoveryParent>) =>
      adjudicateProblemManual(input.entry, input.problem, root, row.failed, row.parent);

    await expect(runChild(parents[0])).resolves.toBeDefined();
    await expect(runChild(parents[1])).rejects.toThrow("seeded Q31 manual classification crash");
    expect(calls.classification).toEqual(["11:30", "12:31"]);
    crashKey = null;
    calls.classification = [];
    for (const row of parents) await expect(runChild(row)).resolves.toBeDefined();
    expect(calls.classification).toEqual([
      "12:31", "12:32", "14:37", "15:38", "15:40", "15:41", "15:42", "7:18", "7:19", "15:39",
    ]);

    const beforeReplay = stateSnapshot(root).filter(([path]) => path.includes("manual"));
    calls.classification = [];
    for (const row of parents) await expect(runChild(row)).resolves.toBeDefined();
    expect(calls.classification).toEqual([]);
    expect(stateSnapshot(root).filter(([path]) => path.includes("manual"))).toEqual(beforeReplay);

    const beforeTerminal = stateSnapshot(join(root, "problem-terminal-fidelity"));
    await expect(repairAndAuditOfficialAnswers(
      input.entry, input.problem, input.solution, root, input.classified, input.solutions
    )).rejects.toThrow("seeded fresh Q30-Q42 terminal boundary");
    expect(calls.terminal).toBe(1);
    expect(calls.downstream).toEqual([]);
    expect(stateSnapshot(join(root, "problem-terminal-fidelity"))).toEqual(beforeTerminal);
    expect(existsSync(join(root, "answer-audit"))).toBe(false);
    expect(existsSync(join(root, "answer-attestation"))).toBe(false);

    const literatureViews = [
      "5292aacb2170ebb8ae9c70ba089bce6ce689ff9276e9d997b0f3d16c3cb3d665",
      "c534698ffb42c13ef9642bdd930e2b7ddd8b54c907bed0a5dd69ed960d7013e6",
      "581577c6aba6368e2e807d3491debc8bda2c27e4e891a734a374077ba9909376",
      "f4a0912b56ff5f19180cd6701e1b9e8a1760903869fa5284ba364f854d0587e0",
    ];
    const readingViews = [
      "f040b886b1427ed078054e833d489891f27b0d99b5c16cd70e7e4066e766483a",
      "53a758c22f1823ff10bbc7361f9f37e40c46bdd2f57d353feb01bb2c6c8b2a3d",
      "f9638782429e6b95df53473a371cda77c80ad1e3a283f57cd9a2ee4635f42343",
    ];
    const expected = [
      ["11:30", "e6e694a660190ad645dcd3cbaf1549281bdd056c04802907c04db2c061784897", "문학",
        [...literatureViews, "7d92443eaa6f0ac4f34a537e127ca54b55fb968bf64fa5cfc7bb5f777df4646c"]],
      ["12:31", "5ab49dec77f4e47ae71671c2ebd38e16a1e387cece768bbdd45ace55cde2f6fa", "문학",
        [...literatureViews, "763af66685e7abed5840a675c484ffd1cef68207475c3b12f77c8498b00bbfc6"]],
      ["12:32", "e3f26787b00f65c346910a688088f941dce1b8b872e330491da0b61a8e3f5269", "문학",
        [...literatureViews, "3ceee6f7e00d9030cc8bc8b972b0660dd0aa4abad1bd610ca5b3ae9588cdbc33"]],
      ["14:37", "ceea23fac5375f0d514c61a3a0a49754ea67796458365b3c17de6f67ad5837fd", "독서와 작문",
        readingViews],
      ["15:38", "3a84154e36d6a7a703afecb37e7e090e46ea5c9b6aa6cf6235d96718a4416c57", "독서와 작문",
        [...readingViews, "119d571b4bf6c495fa6a8a7ad05df04a569c0fed673fc8890959a8837c80bd48"]],
      ["15:40", "b7fdf4136ce89e411f5e65c7e4cc2a98ef30ea97f3aae7d3098a9556884aed3d", "독서와 작문",
        [...readingViews, "34a46f0aebac0098b64feb0cddf4370866945614b38483dcaaf12c97d6de1198"]],
      ["15:41", "371eba06e9adf7dec40b792dd060a10fa87237384dd6b7f20c2b4629eec8a876", "독서와 작문",
        [...readingViews, "a0dad8b265040dcda0ac223e8382f4dd447be0a0501571d70b6b4187b060d2a5"]],
      ["15:42", "4e708254da01f6edf7b57bde696ef5af8faec1116dfb3ebf8eb7e1a3b5daabe8", "독서와 작문",
        [...readingViews, "4f2a482f02360ef1953238997f6ff7f6a18801f7d36b8382090b8f3ce3c634f2"]],
    ] as const;
    for (const [key, itemHash, course, cropHashes] of expected) {
      const [page, number] = key.split(":");
      const prefix = `v1-${page.padStart(4, "0")}-${number.padStart(4, "0")}-`;
      const problemName = readdirSync(join(root, "problem-manual-adjudications"))
        .find((name) => name.startsWith(prefix))!;
      const classificationName = readdirSync(join(root, "classification-manual-adjudications"))
        .find((name) => name.startsWith(prefix))!;
      const problemCheckpoint = JSON.parse(readFileSync(
        join(root, "problem-manual-adjudications", problemName), "utf8"
      ));
      const classificationCheckpoint = JSON.parse(readFileSync(
        join(root, "classification-manual-adjudications", classificationName), "utf8"
      ));
      expect(canonicalEvidenceHash(problemCheckpoint.item)).toBe(itemHash);
      expect(problemCheckpoint.basis.cropViews.map((view: { pixelSha256: string }) => view.pixelSha256))
        .toEqual(cropHashes);
      expect(classificationCheckpoint.items).toEqual([expect.objectContaining({
        key, decision: "accept", curriculum_course: course, transcription_status: "exact",
      })]);
    }
    expect(readdirSync(join(root, "problem-manual-adjudications"))
      .some((name) => name.startsWith("v1-0015-0039-"))).toBe(true);

    removeManualArtifacts(root, ["12:31"]);
    const q32Child = join(root, "problem-manual-adjudications", readdirSync(
      join(root, "problem-manual-adjudications")
    ).find((name) => name.startsWith("v1-0012-0032-"))!);
    writeFileSync(q32Child, Buffer.concat([readFileSync(q32Child), Buffer.from(" ")]));
    let before = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(runChild(parents[1])).rejects.toThrow(/12:32 manual adjudication hash가 다릅니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(before);

    removeManualArtifacts(root, ["15:38"]);
    const q42Child = join(root, "problem-manual-adjudications", readdirSync(
      join(root, "problem-manual-adjudications")
    ).find((name) => name.startsWith("v1-0015-0042-"))!);
    writeFileSync(q42Child, Buffer.concat([readFileSync(q42Child), Buffer.from(" ")]));
    before = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(runChild(parents[4])).rejects.toThrow(/15:42 manual adjudication hash가 다릅니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(before);

    const q30ParentClassification = join(root,
      "classification-recoveries/v1-0011-0030-c7a93c185f146d3b057945c3ed1c7be2f776c9c9698dfbf1e4e02c7f13f35fbd-" +
      "7bb7cb863c8c4855.json");
    writeFileSync(q30ParentClassification, Buffer.concat([
      readFileSync(q30ParentClassification), Buffer.from(" "),
    ]));
    before = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(runChild(parents[0])).rejects.toThrow(/11:30 manual batch classification recovery envelope가 다릅니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(before);
  }, 300_000);

  it.skipIf(!existsSync(q32ManualProblemPath))(
    "crash-resumes the pinned Q32 source reversion before the next true repair without sibling writes",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q32-manual-revision-live-"));
    cpSync(q27LiveState, root, { recursive: true });
    removeManualRevisionArtifacts(root, ["12:32"]);
    for (const directory of ["answer-audit", "answer-attestation"]) {
      rmSync(join(root, directory), { recursive: true, force: true });
    }
    const input = q27FixtureInputs(root);
    const q31 = q31ExactRecoveryParent(root);
    const q32 = q32ExactRecoveryParent(root);
    const expectedProblemRelativePath =
      "problem-manual-revisions/v1-0012-0032-e2ba87a93ce39e57d13f35edea17a11c72721b20fc0201d3dadfc466dd73801c.json";
    const expectedClassificationRelativePath =
      "classification-manual-revisions/v1-0012-0032-e0cf084146f55db4994304b3ddb21a1a57e563ea052d32951ebd2be286c4f860-" +
      "7bb7cb863c8c4855.json";
    const firstRevisionClassification = JSON.parse(readFileSync(
      join(q27LiveState, expectedClassificationRelativePath), "utf8"
    )).items[0] as ClassificationDecision;
    expect(canonicalEvidenceHash(firstRevisionClassification))
      .toBe("e052bfaae96839742bad356f8235d214202d18baeb4bf3cc24d7e485b8042e2b");
    const calls = { firstRevision: 0, sourceRevision: 0, terminal: 0 };
    let crashStage: "first" | "source" | null = "first";
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
          key: string;
          question: string;
          choices: string[] | null;
        }>;
        expect(items).toHaveLength(1);
        if (["7:18", "7:19", "15:39"].includes(items[0].key)) {
          throw new Error(`seeded next true repair boundary: ${items[0].key}`);
        }
        expect(items[0].key).toBe("12:32");
        expect(items[0].choices?.[1]).toContain("이야기 속의 인물들을");
        expect(request.prompt).not.toContain("parent manual classification");
        const sourceCorrect = items[0].question.includes("개울물을 바라본다.)");
        if (!sourceCorrect) {
          expect(items[0].question).toContain("(서연 곁으로 가서 개울물을 바라본다). 물 위에 비쳐 보여요");
          expect(items[0].question).toContain("(물을 떠서 마신다). 물이 맑고 시원해요.");
          calls.firstRevision++;
          if (crashStage === "first") throw new Error("seeded Q32 first revision classification crash");
          return { text: JSON.stringify([firstRevisionClassification]) };
        }
        expect(items[0].question).toContain("(서연 곁으로 가서 개울물을 바라본다.) 물 위에 비쳐 보여요");
        expect(items[0].question).toContain("(물을 떠서 마신다.) 물이 맑고 시원해요.");
        calls.sourceRevision++;
        if (crashStage === "source") throw new Error("seeded Q32 source revision classification crash");
        return { text: JSON.stringify([{
          key: "12:32",
          decision: "accept",
          canonical_subject: "korean_literature",
          curriculum_course: "문학",
          domain: "희곡의 인물과 극적 기능",
          achievement_codes: ["12문학01-03"],
          confidence: 0.99,
          reason_codes: ["SOURCE_EXACT", "IN_SCOPE_KOREAN_LITERATURE"],
          transcription_status: "exact",
          transcription_evidence: "공식 p10~p12의 전체 지문과 괄호 안 마침표, 32번 발문·선택지가 일치한다.",
        }]) };
      }
      if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
        calls.terminal++;
        const items = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{
          key: string;
          question: string;
        }>;
        expect(items).toHaveLength(45);
        expect(new Set(items.map((item) => item.key)).size).toBe(45);
        const q32Input = items.find((item) => item.key === "12:32")!;
        expect(q32Input.question).toContain("(서연 곁으로 가서 개울물을 바라본다.) 물 위에 비쳐 보여요");
        expect(q32Input.question).toContain("(물을 떠서 마신다.) 물이 맑고 시원해요.");
        expect(q32Input.question).not.toContain("개울물을 바라본다). 물 위에");
        expect(q32Input.question).not.toContain("물을 떠서 마신다). 물이");
        throw new Error("seeded fresh Q32 revision terminal boundary");
      }
      throw new Error(`unexpected Q32 revision AI call: ${request.schema?.name ?? "unknown"}`);
    });
    const runQ32 = () => adjudicateProblemManual(
      input.entry, input.problem, root, q32.failed, q32.parent
    );

    await expect(runQ32()).rejects.toThrow("seeded Q32 first revision classification crash");
    expect(calls).toEqual({ firstRevision: 1, sourceRevision: 0, terminal: 0 });
    expect(readdirSync(join(root, "problem-manual-revisions"))
      .filter((name) => name.startsWith("v1-0012-0032-"))).toEqual([
        expectedProblemRelativePath.slice(expectedProblemRelativePath.lastIndexOf("/") + 1),
      ]);
    expect(existsSync(join(root, "classification-manual-revisions"))
      ? readdirSync(join(root, "classification-manual-revisions"))
        .filter((name) => name.startsWith("v1-0012-0032-"))
      : []).toEqual([]);
    expect(hash(readFileSync(join(root, expectedProblemRelativePath))))
      .toBe("61e238a6d6456ce690cd951c6a6572dc3c8b1821bb1bbbd60ae6bbdff180b85d");

    const partialSnapshot = stateSnapshot(root).filter(([path]) => path.includes("manual"));
    calls.firstRevision = 0;
    calls.sourceRevision = 0;
    providerMock.complete.mockClear();
    await expect(adjudicateProblemManual(
      input.entry, input.problem, root, q31.failed, q31.parent
    )).resolves.toBeDefined();
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(calls).toEqual({ firstRevision: 0, sourceRevision: 0, terminal: 0 });
    expect(stateSnapshot(root).filter(([path]) => path.includes("manual"))).toEqual(partialSnapshot);

    crashStage = "source";
    calls.firstRevision = 0;
    calls.sourceRevision = 0;
    await expect(runQ32()).rejects.toThrow("seeded Q32 source revision classification crash");
    expect(calls).toEqual({ firstRevision: 1, sourceRevision: 1, terminal: 0 });
    const sourceProblemNames = readdirSync(join(root, "problem-manual-second-revisions"))
      .filter((name) => name.startsWith("v1-0012-0032-"));
    expect(sourceProblemNames).toHaveLength(1);
    expect(existsSync(join(root, "classification-manual-second-revisions"))
      ? readdirSync(join(root, "classification-manual-second-revisions"))
        .filter((name) => name.startsWith("v1-0012-0032-"))
      : []).toEqual([]);

    const sourcePartialSnapshot = stateSnapshot(root).filter(([path]) => path.includes("manual"));
    calls.firstRevision = 0;
    calls.sourceRevision = 0;
    providerMock.complete.mockClear();
    await expect(adjudicateProblemManual(
      input.entry, input.problem, root, q31.failed, q31.parent
    )).resolves.toBeDefined();
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root).filter(([path]) => path.includes("manual"))).toEqual(sourcePartialSnapshot);

    crashStage = null;
    calls.firstRevision = 0;
    calls.sourceRevision = 0;
    const completed = await runQ32();
    expect(calls).toEqual({ firstRevision: 0, sourceRevision: 1, terminal: 0 });
    expect(completed).toMatchObject({
      classified: {
        question: { question: expect.stringContaining("(물을 떠서 마신다.) 물이 맑고 시원해요.") },
        classification: {
          key: "12:32", decision: "accept", canonical_subject: "korean_literature",
          curriculum_course: "문학", transcription_status: "exact",
        },
      },
      evidence: {
        allowlistId: "ebsi-5525982-q32-manual-v1",
        revision: {
          allowlistId: "ebsi-5525982-q32-manual-revision-v1",
          parentManualEvidenceHash: "16774aa8f262afb4be3e751736789f475766364e58a4f1bcdb88f84d654bd2f8",
          failedQuestionHash: "e3f26787b00f65c346910a688088f941dce1b8b872e330491da0b61a8e3f5269",
          failedClassificationHash: "cf31dadc1233e5aef9e940d882a54c316fb1398c18f520d242103a40c8033ae3",
          correctionSpecHash: "cfb59de468a6066bf277f62f2f858f8ac00e3a04fca7856e8294b271d1c186f8",
          problemArtifact: {
            path: expectedProblemRelativePath,
            sha256: "61e238a6d6456ce690cd951c6a6572dc3c8b1821bb1bbbd60ae6bbdff180b85d",
          },
          problemArtifactItemHash: "e3649d8930138bdc731c8642e24507e5d98f12da8d83503877ef92c3f31981bb",
          classificationArtifact: { path: expectedClassificationRelativePath },
          sourceRevision: {
            allowlistId: "ebsi-5525982-q32-manual-source-revision-v1",
            parentRevisionAllowlistId: "ebsi-5525982-q32-manual-revision-v1",
            parentRevisionEvidenceHash: "944ad7e2ab07ffff727e3ac8923cfbee5b9e0499610a82eca37ccd7309c0abbd",
            failedQuestionHash: "e3649d8930138bdc731c8642e24507e5d98f12da8d83503877ef92c3f31981bb",
            failedClassificationHash: "e052bfaae96839742bad356f8235d214202d18baeb4bf3cc24d7e485b8042e2b",
            problemArtifact: {
              path: "problem-manual-second-revisions/v1-0012-0032-" +
                "e552ab3ccd06391eea7e158d8ebe790e89d43c2d948ac37ce23b2f8e26f98908.json",
              sha256: "ef11be1c9a5f89ef09b8ef5b2dc8c3c0a2c77e15235cafd5e8f72a17512aab48",
            },
            problemArtifactItemHash: "e3f26787b00f65c346910a688088f941dce1b8b872e330491da0b61a8e3f5269",
            classificationArtifact: {
              path: "classification-manual-second-revisions/v1-0012-0032-" +
                "b6ec6b2d5612e39892068bb88795cd99f41a7677a2d0a6245899f43e70d873f6-" +
                "7bb7cb863c8c4855.json",
              sha256: "aa3166e4d66c67062b2ad7242523485f55dae112ec6da4d598e39aa4a2a5e55f",
            },
            classificationArtifactItemHash:
              "bf7df2cec149ca24ef79b89754d21c4906621e4c02a2314ca215ff336be1cc47",
          },
        },
      },
    });

    const completedSnapshot = stateSnapshot(root).filter(([path]) => path.includes("manual"));
    calls.firstRevision = 0;
    calls.sourceRevision = 0;
    await expect(runQ32()).resolves.toEqual(completed);
    expect(calls).toEqual({ firstRevision: 0, sourceRevision: 0, terminal: 0 });
    expect(stateSnapshot(root).filter(([path]) => path.includes("manual"))).toEqual(completedSnapshot);

    const sourceEvidence = completed.evidence.revision?.sourceRevision;
    expect(sourceEvidence).toBeDefined();
    const sourceProblemPath = join(root, sourceEvidence!.problemArtifact.path);
    const sourceClassificationPath = join(root, sourceEvidence!.classificationArtifact.path);
    const sourceProblemBytes = readFileSync(sourceProblemPath);
    const sourceClassificationBytes = readFileSync(sourceClassificationPath);
    writeFileSync(sourceProblemPath, Buffer.concat([sourceProblemBytes, Buffer.from(" ")]));
    let sourceBefore = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(adjudicateProblemManual(
      input.entry, input.problem, root, q31.failed, q31.parent
    )).rejects.toThrow(/problem manual second revision/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(sourceBefore);
    writeFileSync(sourceProblemPath, sourceProblemBytes);

    writeFileSync(sourceClassificationPath, Buffer.concat([
      sourceClassificationBytes,
      Buffer.from(" "),
    ]));
    sourceBefore = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(runQ32()).rejects.toThrow(/classification manual second revision hash/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(sourceBefore);
    writeFileSync(sourceClassificationPath, sourceClassificationBytes);

    const sourceProblemDirectory = join(root, "problem-manual-second-revisions");
    const relocatedSourceProblemDirectory = join(root, "problem-manual-second-revisions-relocated");
    renameSync(sourceProblemDirectory, relocatedSourceProblemDirectory);
    symlinkSync(relocatedSourceProblemDirectory, sourceProblemDirectory);
    sourceBefore = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(runQ32()).rejects.toThrow(/problem manual second revision 디렉터리가 유효하지 않습니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(sourceBefore);
    unlinkSync(sourceProblemDirectory);
    renameSync(relocatedSourceProblemDirectory, sourceProblemDirectory);

    const sourceAlias = join(
      root,
      "problem-manual-second-revisions",
      `v1-0012-0032-${"f".repeat(64)}.json`
    );
    writeFileSync(sourceAlias, sourceProblemBytes);
    sourceBefore = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(runQ32()).rejects.toThrow(/12:32 manual adjudication preflight orphan\/conflict/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(sourceBefore);
    unlinkSync(sourceAlias);

    symlinkSync(sourceProblemPath, sourceAlias);
    sourceBefore = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(runQ32()).rejects.toThrow(/problem manual second revision 파일이 유효하지 않습니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(sourceBefore);
    unlinkSync(sourceAlias);

    unlinkSync(sourceProblemPath);
    sourceBefore = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(runQ32()).rejects.toThrow(/manual adjudication preflight orphan\/conflict/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(sourceBefore);
    writeFileSync(sourceProblemPath, sourceProblemBytes);
    writeFileSync(sourceClassificationPath, sourceClassificationBytes);

    const beforeTerminal = stateSnapshot(join(root, "problem-terminal-fidelity"));
    await expect(repairAndAuditOfficialAnswers(
      input.entry, input.problem, input.solution, root, input.classified, input.solutions
    )).rejects.toThrow(/^seeded next true repair boundary: (?:7:18|7:19|15:39)$/u);
    expect(calls).toEqual({ firstRevision: 0, sourceRevision: 0, terminal: 0 });
    expect(stateSnapshot(join(root, "problem-terminal-fidelity"))).toEqual(beforeTerminal);
    expect(existsSync(join(root, "answer-audit"))).toBe(false);
    expect(existsSync(join(root, "answer-attestation"))).toBe(false);

    const revisionProblemPath = join(root, expectedProblemRelativePath);
    const revisionProblemBytes = readFileSync(revisionProblemPath);
    removeManualArtifacts(root, ["12:31"]);
    writeFileSync(revisionProblemPath, Buffer.concat([revisionProblemBytes, Buffer.from(" ")]));
    let before = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(adjudicateProblemManual(
      input.entry, input.problem, root, q31.failed, q31.parent
    )).rejects.toThrow("12:32 problem manual revision hash가 다릅니다");
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(before);

    writeFileSync(revisionProblemPath, revisionProblemBytes);
    const aliasPath = join(root, "problem-manual-revisions", `v1-0012-0032-${"f".repeat(64)}.json`);
    writeFileSync(aliasPath, revisionProblemBytes);
    before = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(runQ32()).rejects.toThrow(/12:32 manual adjudication preflight orphan\/conflict/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(before);
    unlinkSync(aliasPath);

    unlinkSync(revisionProblemPath);
    before = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(runQ32()).rejects.toThrow(/12:32 manual adjudication preflight orphan\/conflict/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(before);
    writeFileSync(revisionProblemPath, revisionProblemBytes);

    const q32Prefix = "v1-0012-0032-";
    for (const directory of [
      "problem-manual-evidence",
      "problem-manual-adjudications",
      "classification-manual-adjudications",
      "problem-manual-revisions",
      "classification-manual-revisions",
      "problem-manual-second-revisions",
      "classification-manual-second-revisions",
    ]) {
      const path = join(root, directory);
      if (!existsSync(path)) continue;
      for (const name of readdirSync(path)) {
        if (!name.startsWith(q32Prefix)) rmSync(join(path, name));
      }
    }
    const authorityRepair = {
      key: "12:32",
      revision: {
        recovery: {
          ...q32.parent,
          manualAdjudication: completed.evidence,
        },
      },
    } as unknown as ProblemRepairEvidence;
    await expect(assertProblemManualAdjudicationAuthority(root, [authorityRepair])).resolves.toBeUndefined();
    const tamperedAuthorityRepair = structuredClone(authorityRepair);
    tamperedAuthorityRepair.revision!.recovery!.manualAdjudication!.revision!.sourceRevision!
      .parentRevisionEvidenceHash = "0".repeat(64);
    await expect(assertProblemManualAdjudicationAuthority(root, [tamperedAuthorityRepair]))
      .rejects.toThrow("12:32 manual source revision evidence가 parent/allowlist와 다릅니다");
  }, 300_000);

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "crash-resumes exact-parent Q18-Q19-Q39 children and preflights the whole true-repair set",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q18-q19-q39-manual-live-"));
    cpSync(q27LiveState, root, { recursive: true });
    removeManualArtifacts(root, ["7:18", "7:19", "15:39"]);
    const input = q27FixtureInputs(root);
    const rows = [q18ExactRecoveryParent(root), q19ExactRecoveryParent(root), q39ExactRecoveryParent(root)];
    const calls: string[] = [];
    let crashKey: string | null = "7:19";
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      expect(request.schema?.name).toBe("studywork_exam_corpus_classification");
      const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
        key: string;
        question: string;
        choices: string[] | null;
      }>;
      expect(items).toHaveLength(1);
      const item = items[0];
      expect(["7:18", "7:19", "15:39"]).toContain(item.key);
      calls.push(item.key);
      if (item.key === "7:18" || item.key === "7:19") {
        expect(item.question).toContain("[16 ~ 20] 다음 글을 읽고 물음에 답하시오.");
        expect(item.question).toContain("기존의 지식과 M에 열을 가했다는 조건");
        expect(item.question).toContain("경험을 통한 시험의 대상");
        expect(item.question).toContain("선택하겠지만 실용적 필요");
      } else {
        expect(item.question).toContain("[37~42] 다음 글을 읽고 물음에 답하시오.");
        expect(item.question).toContain("39. [가]를 바탕으로 <보기>의 상황을 이해한 내용으로 적절한 것은?");
      }
      if (item.key === crashKey) throw new Error("seeded exact-parent true repair classification crash");
      return { text: JSON.stringify([{
        key: item.key,
        decision: "accept",
        canonical_subject: "korean_reading",
        curriculum_course: "독서와 작문",
        domain: "비문학 제시문의 추론적·비판적 읽기",
        achievement_codes: ["12독작01-04"],
        confidence: 0.99,
        reason_codes: ["SOURCE_EXACT", "IN_SCOPE_KOREAN_READING"],
        transcription_status: "exact",
        transcription_evidence: `공식 source pixel과 ${item.key} 전체 지문·발문·선지가 일치한다.`,
      }]) };
    });
    const run = (index: number) => adjudicateProblemManual(
      input.entry,
      input.problem,
      root,
      rows[index].failed,
      rows[index].parent
    );

    await expect(run(0)).resolves.toMatchObject({
      classified: { classification: { key: "7:18", transcription_status: "exact", decision: "accept" } },
    });
    await expect(run(1)).rejects.toThrow("seeded exact-parent true repair classification crash");
    expect(calls).toEqual(["7:18", "7:19"]);
    expect(readdirSync(join(root, "problem-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0007-0019-"))).toHaveLength(1);
    expect(readdirSync(join(root, "classification-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0007-0019-"))).toHaveLength(0);

    crashKey = null;
    await expect(run(2)).resolves.toMatchObject({
      classified: { classification: { key: "15:39", transcription_status: "exact", decision: "accept" } },
    });
    await expect(run(1)).resolves.toMatchObject({
      classified: { classification: { key: "7:19", transcription_status: "exact", decision: "accept" } },
    });
    expect(calls).toEqual(["7:18", "7:19", "15:39", "7:19"]);

    const expected = new Map<string, { itemHash: string; views: string[] }>([
      ["7:18", {
        itemHash: "e6f77c8aa3a10c5549e95eb6d3b3974587b2b3a16db009fb483ad9099943417f",
        views: [
          "af81d940bb74a611b249ff861be8a8e95eaa719f8a1978258f37e37ffd3d347e",
          "c52268ed7672f99284b07b36a6bfc7375d5cb203a651c0fa90a25edd06e353d1",
          "3ddfb710dfa5d8576496b6b37d43c90e53b2eab196db181439f60343e7da6d95",
          "e72ccd39610a51f98718e7b542d3c5d91f9354f1eb10b53d39ca6af88ac0d525",
        ],
      }],
      ["7:19", {
        itemHash: "64e29a3f28bad8602f35bcbf89542202e7b5cc4a587ed586474626a0085090d4",
        views: [
          "af81d940bb74a611b249ff861be8a8e95eaa719f8a1978258f37e37ffd3d347e",
          "c52268ed7672f99284b07b36a6bfc7375d5cb203a651c0fa90a25edd06e353d1",
          "3ddfb710dfa5d8576496b6b37d43c90e53b2eab196db181439f60343e7da6d95",
          "abd329f03c55a66e582ca236eeba453f7c214315abefb41fdbd5dd36cab7f9a9",
        ],
      }],
      ["15:39", {
        itemHash: "45089f6c171df3fa64b68ec782741ee58212d249566ce43837941f204e9780cf",
        views: [
          "f040b886b1427ed078054e833d489891f27b0d99b5c16cd70e7e4066e766483a",
          "53a758c22f1823ff10bbc7361f9f37e40c46bdd2f57d353feb01bb2c6c8b2a3d",
          "f9638782429e6b95df53473a371cda77c80ad1e3a283f57cd9a2ee4635f42343",
          "2a6bbacc283df55dacf030d892013dcf9c7a62fdc543f8fd58fea9d97f8575a5",
        ],
      }],
    ]);
    for (const [key, authority] of expected) {
      const [page, number] = key.split(":");
      const prefix = `v1-${page.padStart(4, "0")}-${number.padStart(4, "0")}-`;
      const name = readdirSync(join(root, "problem-manual-adjudications"))
        .find((candidate) => candidate.startsWith(prefix))!;
      const checkpoint = JSON.parse(readFileSync(join(root, "problem-manual-adjudications", name), "utf8"));
      expect(canonicalEvidenceHash(checkpoint.item)).toBe(authority.itemHash);
      expect(checkpoint.basis.cropViews.map((view: { pixelSha256: string }) => view.pixelSha256))
        .toEqual(authority.views);
    }

    const completedSnapshot = stateSnapshot(root).filter(([path]) => path.includes("manual"));
    calls.length = 0;
    for (let index = 0; index < rows.length; index++) await expect(run(index)).resolves.toBeDefined();
    expect(calls).toEqual([]);
    expect(stateSnapshot(root).filter(([path]) => path.includes("manual"))).toEqual(completedSnapshot);

    const q39ProblemPath = join(root, "problem-manual-adjudications", readdirSync(
      join(root, "problem-manual-adjudications")
    ).find((name) => name.startsWith("v1-0015-0039-"))!);
    const q39Bytes = readFileSync(q39ProblemPath);
    removeManualArtifacts(root, ["7:18"]);
    writeFileSync(q39ProblemPath, Buffer.concat([q39Bytes, Buffer.from(" ")]));
    const before = stateSnapshot(root);
    calls.length = 0;
    providerMock.complete.mockClear();
    await expect(run(0)).rejects.toThrow(/15:39 manual adjudication hash가 다릅니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(stateSnapshot(root)).toEqual(before);
  }, 300_000);

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "crash-resumes Q8-Q16 children before unrelated Q17-Q18 blockers",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q8-q16-manual-live-"));
    cpSync(q27LiveState, root, { recursive: true });
    removeManualArtifacts(root, ["4:8", "6:16"]);
    for (const directory of ["answer-audit", "answer-attestation"]) {
      rmSync(join(root, directory), { recursive: true, force: true });
    }
    const calls = { classification: [] as string[], extraction: [] as string[], terminal: 0 };
    const laterManualKeys = [
      "7:17", "7:20", "9:23", "11:28", "11:29", ...q30Q42ManualKeys, ...newTrueRepairManualKeys,
    ];
    let crashKey: string | null = "6:16";
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        const inputs = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
          key: string;
          question: string;
          figure_description: string | null;
        }>;
        expect(inputs).toHaveLength(1);
        const item = inputs[0];
        if (laterManualKeys.includes(item.key)) {
          calls.extraction.push(item.key);
          throw new Error(`unrelated persisted manual blocker: ${item.key}`);
        }
        calls.classification.push(item.key);
        expect(["4:8", "6:16"]).toContain(item.key);
        expect(request.prompt).not.toContain("원문 3쪽의 세트 표제");
        expect(request.prompt).not.toContain("원문 6쪽의 묶음 지시문");
        if (item.key === "4:8") {
          expect(item.question).toContain("[6 ~ 8] 다음을 읽고 물음에 답하시오.");
          expect(item.question).toContain("기사형 광고는 기사처럼 보이는 광고를 말한다.");
          expect(item.figure_description).toContain("오른쪽으로 열린 세로 묶음 괄호가 정확히 두 개");
        } else {
          expect(item.question).toContain("[16 ~ 20] 다음 글을 읽고 물음에 답하시오.");
          expect(item.question).toContain("선택하겠지만 실용적 필요");
          expect(item.figure_description).toBeNull();
        }
        if (item.key === crashKey) throw new Error("seeded Q16 manual classification crash");
        return { text: JSON.stringify([item.key === "4:8" ? {
          key: item.key,
          decision: "reject",
          canonical_subject: null,
          curriculum_course: null,
          domain: null,
          achievement_codes: [],
          confidence: 0.99,
          reason_codes: ["ASSESSED_CONSTRUCT_WRITING", "OUT_OF_SCOPE_KOREAN_READING"],
          transcription_status: "exact",
          transcription_evidence: "공식 3~4쪽의 작문 계획·초고·괄호·8번 발문과 선택지가 일치한다.",
        } : {
          key: item.key,
          decision: "accept",
          canonical_subject: "korean_reading",
          curriculum_course: "독서와 작문",
          domain: "인문·철학 제재의 관점 비교와 추론",
          achievement_codes: ["12독작01-03"],
          confidence: 0.99,
          reason_codes: ["NONFICTION_READING", "VIEWPOINT_COMPARISON"],
          transcription_status: "exact",
          transcription_evidence: "공식 6쪽의 전체 지문·16번 발문과 선택지가 일치한다.",
        }]) };
      }
      if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
        calls.terminal++;
        const inputs = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{
          key: string;
          question: string;
        }>;
        expect(inputs).toHaveLength(45);
        expect(new Set(inputs.map((item) => item.key)).size).toBe(45);
        expect(inputs.find((item) => item.key === "4:8")?.question)
          .toContain("기사형 광고는 기사처럼 보이는 광고를 말한다.");
        expect(inputs.find((item) => item.key === "6:16")?.question)
          .toContain("[16 ~ 20] 다음 글을 읽고 물음에 답하시오.");
        throw new Error("seeded fresh terminal boundary");
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

    await expect(run()).rejects.toThrow(
      /seeded Q16 manual classification crash|unrelated persisted (?:manual )?blocker: (?:7:(?:17|18|19|20)|9:23|11:(?:28|29|30)|12:(?:31|32)|14:37|15:(?:38|39|40|41|42))/u
    );
    expect([...calls.classification].sort()).toEqual(["4:8", "6:16"]);
    expect(calls.extraction.length).toBeGreaterThan(0);
    expect(calls.extraction.every((key) => laterManualKeys.includes(key))).toBe(true);
    expect(calls.terminal).toBe(0);
    const q8Problem = readdirSync(join(root, "problem-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0004-0008-"));
    const q8Classification = readdirSync(join(root, "classification-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0004-0008-"));
    const q16Problem = readdirSync(join(root, "problem-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0006-0016-"));
    expect(q8Problem).toHaveLength(1);
    expect(q8Classification).toHaveLength(1);
    expect(q16Problem).toHaveLength(1);
    expect(readdirSync(join(root, "classification-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0006-0016-"))).toHaveLength(0);

    crashKey = null;
    calls.classification = [];
    calls.extraction = [];
    await expect(run()).rejects.toThrow(
      /unrelated persisted (?:manual )?blocker: (?:7:(?:17|18|19|20)|9:23|11:(?:28|29|30)|12:(?:31|32)|14:37|15:(?:38|39|40|41|42))/u
    );
    expect(calls.classification).toEqual(["6:16"]);
    expect(calls.extraction.length).toBeGreaterThan(0);
    expect(calls.extraction.every((key) => laterManualKeys.includes(key))).toBe(true);
    expect(calls.terminal).toBe(0);
    const q16Classification = readdirSync(join(root, "classification-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0006-0016-"));
    expect(q16Classification).toHaveLength(1);
    for (const [key, expectedHash, expectedSpecHash, expectedDecision, expectedSubject] of [
      [
        "4:8", "e5e1b8c0afdb43aa2bf537c2ecfb0b60b770979c8522c692db09002c3cf4680d",
        "764545d31c96a9bf525791206c81b136b74f07ffb9b974fe1e9e6a1e27a8a79a", "reject", null,
      ],
      [
        "6:16", "dd277b1ef288b108943920a59656bc3bc8c68f23c0cfad64296753248d375ea1",
        "a4e52e1bf05c24a3aca3bea7ed81b74031c9b8017067074091b17702e31ad8da", "accept", "korean_reading",
      ],
    ] as const) {
      const [page, number] = key.split(":").map(Number);
      const prefix = `v1-${String(page).padStart(4, "0")}-${String(number).padStart(4, "0")}-`;
      const problemName = readdirSync(join(root, "problem-manual-adjudications"))
        .find((name) => name.startsWith(prefix))!;
      const classificationName = readdirSync(join(root, "classification-manual-adjudications"))
        .find((name) => name.startsWith(prefix))!;
      const problemCheckpoint = JSON.parse(readFileSync(
        join(root, "problem-manual-adjudications", problemName),
        "utf8"
      ));
      expect(canonicalEvidenceHash(problemCheckpoint.item)).toBe(expectedHash);
      expect(problemCheckpoint.basis.correctionSpecHash).toBe(expectedSpecHash);
      expect(problemCheckpoint.basis.cropViews.map((view: {
        pixelSha256: string;
        pixelWidth: number;
        pixelHeight: number;
      }) => ({
        pixelSha256: view.pixelSha256,
        pixelWidth: view.pixelWidth,
        pixelHeight: view.pixelHeight,
      }))).toEqual(key === "4:8" ? [{
        pixelSha256: "d712b1f65224ad29c5cf1ce98031ef221f8508a36f7a01ad69b270cca5809a0a",
        pixelWidth: 7017,
        pixelHeight: 9925,
      }, {
        pixelSha256: "8c65b3526f5acd98fc1ba51e0cf0b0437cf2518437ee4990c504905cff9f07b8",
        pixelWidth: 3018,
        pixelHeight: 8040,
      }, {
        pixelSha256: "f726265d0f701cad0c9e9942ac09e7430cae60f5f5190e276c17446784e0b8ef",
        pixelWidth: 3018,
        pixelHeight: 3078,
      }] : [{
        pixelSha256: "af81d940bb74a611b249ff861be8a8e95eaa719f8a1978258f37e37ffd3d347e",
        pixelWidth: 7017,
        pixelHeight: 9925,
      }, {
        pixelSha256: "c52268ed7672f99284b07b36a6bfc7375d5cb203a651c0fa90a25edd06e353d1",
        pixelWidth: 3018,
        pixelHeight: 5360,
      }, {
        pixelSha256: "3ddfb710dfa5d8576496b6b37d43c90e53b2eab196db181439f60343e7da6d95",
        pixelWidth: 3159,
        pixelHeight: 7345,
      }]);
      const decision = JSON.parse(readFileSync(
        join(root, "classification-manual-adjudications", classificationName),
        "utf8"
      )).items[0];
      expect(decision).toMatchObject({
        key,
        decision: expectedDecision,
        canonical_subject: expectedSubject,
        transcription_status: "exact",
      });
      if (key === "4:8") {
        expect(decision).toMatchObject({ curriculum_course: null, domain: null, achievement_codes: [] });
      } else {
        expect(decision).toMatchObject({ curriculum_course: "독서와 작문" });
      }
    }
    expect(readdirSync(join(root, "problem-manual-adjudications"))
      .some((name) => name.startsWith("v1-0006-0015-"))).toBe(false);
    expect(readdirSync(join(root, "classification-manual-adjudications"))
      .some((name) => name.startsWith("v1-0006-0015-"))).toBe(false);

    const childSnapshot = stateSnapshot(root).filter(([path]) => path.includes("manual"));
    calls.classification = [];
    calls.extraction = [];
    calls.terminal = 0;
    await expect(run()).rejects.toThrow(
      /unrelated persisted (?:manual )?blocker: (?:7:(?:17|18|19|20)|9:23|11:(?:28|29|30)|12:(?:31|32)|14:37|15:(?:38|39|40|41|42))/u
    );
    expect(calls.classification).toEqual([]);
    expect(calls.extraction.length).toBeGreaterThan(0);
    expect(calls.extraction.every((key) => laterManualKeys.includes(key))).toBe(true);
    expect(calls.terminal).toBe(0);
    expect(stateSnapshot(root).filter(([path]) => path.includes("manual"))).toEqual(childSnapshot);

    const { failed: q8Failed, parent: q8Parent } = q8ExactRecoveryParent(root);
    removeManualArtifacts(root, ["4:8"]);
    const q16ProblemPath = join(root, "problem-manual-adjudications", q16Problem[0]);
    writeFileSync(q16ProblemPath, Buffer.concat([readFileSync(q16ProblemPath), Buffer.from(" ")]));
    const beforeCrossRowPreflight = stateSnapshot(root);
    providerMock.complete.mockClear();
    const input = q27FixtureInputs(root);
    await expect(adjudicateProblemManual(input.entry, input.problem, root, q8Failed, q8Parent))
      .rejects.toThrow(/6:16 manual adjudication hash가 다릅니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(beforeCrossRowPreflight);
  }, 180_000);

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "rejects a missing Q16 parent before Q8 writes or AI",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q8-q16-manual-missing-"));
    cpSync(q27LiveState, root, { recursive: true });
    removeManualArtifacts(root, ["4:8", "6:16"]);
    const input = q27FixtureInputs(root);
    const { failed, parent } = q8ExactRecoveryParent(root);
    rmSync(join(
      root,
      "classification-recoveries/v1-0006-0016-c3c9b85bbbe986dfd32468b1d82bd474b69ef84cf38200e7d700ef2adea16011-" +
        "7bb7cb863c8c4855.json"
    ));
    const before = stateSnapshot(root);
    providerMock.complete.mockRejectedValue(new Error("AI must not run"));
    await expect(adjudicateProblemManual(input.entry, input.problem, root, failed, parent))
      .rejects.toThrow(/6:16 manual batch recovery exact-set가 다릅니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(before);
  }, 120_000);

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "crash-resumes Q17-Q20 children before the next honest boundary",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q17-q20-manual-live-"));
    cpSync(q27LiveState, root, { recursive: true });
    removeManualArtifacts(root, ["7:17", "7:20"]);
    for (const directory of ["answer-audit", "answer-attestation"]) {
      rmSync(join(root, directory), { recursive: true, force: true });
    }
    const input = q27FixtureInputs(root);
    const q17Parent = q17ExactRecoveryParent(root);
    const q20Parent = q20ExactRecoveryParent(root);
    const calls = {
      classification: [] as string[],
      unrelated: [] as string[],
      terminal: 0,
    };
    let crashKey: string | null = "7:20";
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        const inputs = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
          key: string;
          question: string;
          figure_description: string | null;
        }>;
        if (inputs.some((item) => !["7:17", "7:20"].includes(item.key))) {
          calls.unrelated.push(...inputs.map((item) => item.key));
          throw new Error(`unrelated classification blocker: ${inputs.map((item) => item.key).join(",")}`);
        }
        expect(inputs).toHaveLength(1);
        const item = inputs[0];
        calls.classification.push(item.key);
        expect(item.question).toContain("[16 ~ 20] 다음 글을 읽고 물음에 답하시오.");
        expect(item.question.match(/논리학 지식/gu)).toHaveLength(3);
        expect(item.question).toContain("경험을 통한 시험의 대상");
        expect(item.question).toContain("이 둘을 서로 대체하더라도");
        expect(item.question).toContain("선택하겠지만 실용적 필요");
        expect(item.figure_description).toBeNull();
        expect(request.prompt).not.toMatch(/공통 지문 머리말|공식 6쪽의 세트 표기/u);
        if (item.key === "7:17") expect(item.question).toContain("윗글에 대해 이해한 내용으로");
        else expect(item.question).toContain("문맥상 ㉢과 바꿔 쓰기에");
        if (item.key === crashKey) throw new Error("seeded Q20 manual classification crash");
        return { text: JSON.stringify([{
          key: item.key,
          decision: "accept",
          canonical_subject: "korean_reading",
          curriculum_course: "독서와 작문",
          domain: item.key === "7:17"
            ? "독서: 사실적·추론적 읽기 및 논증의 개념 관계 파악"
            : "독서·문맥적 어휘 의미 파악",
          achievement_codes: item.key === "7:17" ? ["12독작01-03", "12독작01-04"] : ["12독작01-03"],
          confidence: 0.99,
          reason_codes: ["NONFICTION_READING", "SOURCE_EXACT"],
          transcription_status: "exact",
          transcription_evidence: item.key === "7:17"
            ? "공식 6~7쪽의 공통 지문, 17번 발문과 다섯 선택지가 일치한다."
            : "공식 6~7쪽의 공통 지문, 20번 발문과 다섯 선택지가 일치한다.",
        }]) };
      }
      if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
        calls.terminal++;
        const inputs = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{
          key: string;
          question: string;
          choices: string[] | null;
        }>;
        expect(inputs).toHaveLength(45);
        expect(new Set(inputs.map((item) => item.key)).size).toBe(45);
        expect(inputs.find((item) => item.key === "7:17")?.choices?.[2])
          .toContain("근본적으로 다르다고 한다.");
        expect(inputs.find((item) => item.key === "7:20")?.question)
          .toContain("문맥상 ㉢과 바꿔 쓰기에 가장 적절한 것은?");
        throw new Error("seeded fresh Q17-Q20 terminal boundary");
      }
      if (request.schema?.name === "studywork_file_quiz_items") {
        const single = request.prompt.match(/printed problem (\d+) starting on page (\d+)/u);
        const target = single
          ? `${single[2]}:${single[1]}`
          : request.prompt.match(/printed problems: ([^.]+)/u)?.[1] ?? "unknown";
        calls.unrelated.push(target);
        throw new Error(`unrelated extraction blocker: ${target}`);
      }
      throw new Error(`unexpected AI call: ${request.schema?.name ?? "unknown"}`);
    });
    const runChild = (row: ReturnType<typeof q17ExactRecoveryParent>) =>
      adjudicateProblemManual(input.entry, input.problem, root, row.failed, row.parent);
    const run = () => repairAndAuditOfficialAnswers(
      input.entry,
      input.problem,
      input.solution,
      root,
      input.classified,
      input.solutions
    );

    await expect(runChild(q17Parent)).resolves.toMatchObject({ classified: { classification: { key: "7:17" } } });
    await expect(runChild(q20Parent)).rejects.toThrow(/seeded Q20 manual classification crash/u);
    expect([...calls.classification].sort()).toEqual(["7:17", "7:20"]);
    expect(calls.terminal).toBe(0);
    expect(calls.unrelated).toEqual([]);

    crashKey = null;
    calls.classification = [];
    await expect(runChild(q17Parent)).resolves.toMatchObject({ classified: { classification: { key: "7:17" } } });
    await expect(runChild(q20Parent)).resolves.toMatchObject({ classified: { classification: { key: "7:20" } } });
    expect(calls.classification).toEqual(["7:20"]);
    const boundaryMessage = await run().then(
      () => "resolved unexpectedly",
      (error: unknown) => error instanceof Error ? error.message : String(error)
    );
    expect([
      "unrelated extraction blocker: 9:23",
      "unrelated classification blocker: 9:23",
      "unrelated classification blocker: 11:28",
      "unrelated classification blocker: 11:29",
      "11:28 final source-grounded recovery도 exact가 아닙니다",
      ...q30Q42ManualKeys.map((key) => `unrelated classification blocker: ${key}`),
      ...newTrueRepairManualKeys.map((key) => `unrelated classification blocker: ${key}`),
    ]).toContain(boundaryMessage);
    expect(calls.unrelated.length).toBeGreaterThan(0);
    expect(calls.unrelated.every((key) => [
      "9:23", "11:28", "11:29", ...q30Q42ManualKeys, ...newTrueRepairManualKeys,
    ].includes(key)))
      .toBe(true);
    expect(calls.terminal).toBe(0);

    const expected = [{
      key: "7:17",
      itemHash: "3d94de928dd1b8d443edcc908486bc81af356e352ea7edea32ee1f43166ef0be",
      specHash: "7bdf1e88f8f56e2c1a581afa6bd529a8dea7f43bd7a56e94125fa482c209fe96",
      lastCropHash: "b69ac51723f8e8e62ac7fa4f0404e522ed15a818eab2074ea70c450d11da85dd",
      lastCropHeight: 2680,
    }, {
      key: "7:20",
      itemHash: "1106e5ec6656305c38b4b58770b4acfa0e3e7a6a6d2ee412d10e86e8b99f75c0",
      specHash: "2fa15fb8b4490a51b19e8c1a71591694d9049cecb83b5cf952b858633b5d76d5",
      lastCropHash: "082e73f5f9917837562c97b338381be35acf16a6501a8fe510ec8827a3063211",
      lastCropHeight: 894,
    }] as const;
    for (const row of expected) {
      const [page, number] = row.key.split(":");
      const prefix = `v1-${page.padStart(4, "0")}-${number.padStart(4, "0")}-`;
      const problemName = readdirSync(join(root, "problem-manual-adjudications"))
        .find((name) => name.startsWith(prefix))!;
      const classificationName = readdirSync(join(root, "classification-manual-adjudications"))
        .find((name) => name.startsWith(prefix))!;
      const checkpoint = JSON.parse(readFileSync(
        join(root, "problem-manual-adjudications", problemName),
        "utf8"
      ));
      expect(canonicalEvidenceHash(checkpoint.item)).toBe(row.itemHash);
      expect(checkpoint.basis.correctionSpecHash).toBe(row.specHash);
      expect(checkpoint.basis.cropViews.map((view: { pixelSha256: string }) => view.pixelSha256)).toEqual([
        "af81d940bb74a611b249ff861be8a8e95eaa719f8a1978258f37e37ffd3d347e",
        "c52268ed7672f99284b07b36a6bfc7375d5cb203a651c0fa90a25edd06e353d1",
        "3ddfb710dfa5d8576496b6b37d43c90e53b2eab196db181439f60343e7da6d95",
        row.lastCropHash,
      ]);
      expect(checkpoint.basis.cropViews[3]).toMatchObject({ pixelWidth: 3018, pixelHeight: row.lastCropHeight });
      expect(JSON.parse(readFileSync(
        join(root, "classification-manual-adjudications", classificationName),
        "utf8"
      )).items[0]).toMatchObject({
        key: row.key,
        decision: "accept",
        canonical_subject: "korean_reading",
        curriculum_course: "독서와 작문",
        transcription_status: "exact",
      });
    }
    const trueRepairProblemKeys = ["7:18", "7:19"].filter((key) => {
      const number = key.split(":")[1].padStart(4, "0");
      return readdirSync(join(root, "problem-manual-adjudications"))
        .some((name) => name.startsWith(`v1-0007-${number}-`));
    });
    expect(trueRepairProblemKeys).toEqual([
      ...new Set(calls.unrelated.filter((key) => ["7:18", "7:19"].includes(key))),
    ].sort());
    expect(readdirSync(join(root, "classification-manual-adjudications"))
      .some((name) => /v1-0007-001[89]-/u.test(name))).toBe(false);

    const childSnapshot = stateSnapshot(root).filter(([path]) => path.includes("manual"));
    calls.classification = [];
    calls.unrelated = [];
    calls.terminal = 0;
    await expect(runChild(q17Parent)).resolves.toMatchObject({ classified: { classification: { key: "7:17" } } });
    await expect(runChild(q20Parent)).resolves.toMatchObject({ classified: { classification: { key: "7:20" } } });
    expect(calls.classification).toEqual([]);
    expect(stateSnapshot(root).filter(([path]) => path.includes("manual"))).toEqual(childSnapshot);
    expect(calls.terminal).toBe(0);

    const { failed: q17Failed, parent: q17Recovery } = q17ExactRecoveryParent(root);
    removeManualArtifacts(root, ["7:17"]);
    const q20ProblemName = readdirSync(join(root, "problem-manual-adjudications"))
      .find((name) => name.startsWith("v1-0007-0020-"))!;
    const q20ProblemPath = join(root, "problem-manual-adjudications", q20ProblemName);
    writeFileSync(q20ProblemPath, Buffer.concat([readFileSync(q20ProblemPath), Buffer.from(" ")]));
    const beforeCrossRowPreflight = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(adjudicateProblemManual(input.entry, input.problem, root, q17Failed, q17Recovery))
      .rejects.toThrow(/7:20 manual adjudication hash가 다릅니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(beforeCrossRowPreflight);
  }, 180_000);

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "rejects a missing Q20 parent before Q17 writes or AI",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q17-q20-manual-missing-"));
    cpSync(q27LiveState, root, { recursive: true });
    removeManualArtifacts(root, ["7:17", "7:20"]);
    const input = q27FixtureInputs(root);
    const { failed, parent } = q17ExactRecoveryParent(root);
    rmSync(join(
      root,
      "classification-recoveries/v1-0007-0020-417cece824faacd34b28f4b57b364033b84b39c461d0efe232d98c244cbfdab5-" +
        "7bb7cb863c8c4855.json"
    ));
    const before = stateSnapshot(root);
    providerMock.complete.mockRejectedValue(new Error("AI must not run"));
    await expect(adjudicateProblemManual(input.entry, input.problem, root, failed, parent))
      .rejects.toThrow(/7:20 manual batch recovery exact-set가 다릅니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(before);
  }, 120_000);

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "crash-resumes Q23-Q29 children before the next honest boundary",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q23-q29-manual-live-"));
    cpSync(q27LiveState, root, { recursive: true });
    removeManualArtifacts(root, ["9:23", "11:28", "11:29"]);
    for (const directory of ["answer-audit", "answer-attestation"]) {
      rmSync(join(root, directory), { recursive: true, force: true });
    }
    const input = q27FixtureInputs(root);
    const parents = [q23ExactRecoveryParent(root), q28ExactRecoveryParent(root), q29ExactRecoveryParent(root)];
    const calls = { classification: [] as string[], unrelated: [] as string[], terminal: 0 };
    let crashKey: string | null = "11:28";
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
          key: string;
          question: string;
          figure_description: string | null;
        }>;
        if (items.some((item) => !["9:23", "11:28", "11:29"].includes(item.key))) {
          calls.unrelated.push(...items.map((item) => item.key));
          throw new Error(`unrelated classification blocker: ${items.map((item) => item.key).join(",")}`);
        }
        expect(items).toHaveLength(1);
        const item = items[0];
        calls.classification.push(item.key);
        expect(request.prompt).not.toContain("전사에서 '[21~26]'이 누락되었다");
        if (item.key === "9:23") {
          expect(item.question).toContain("그렇게들 안 할 거예요.");
          expect(item.question).toContain("“애기 엄마…….”");
          expect(item.figure_description).toBeNull();
        } else {
          expect(item.question).toContain("이다지 낡아빠진 생활을 하는 것은 아니리라");
          expect(item.question).toContain("함이정 : 처녀 때 난 생각했었지.");
          expect(item.figure_description).toContain("왼쪽으로 열린 세로 묶음 괄호 [A]");
        }
        if (item.key === crashKey) throw new Error("seeded Q28 manual classification crash");
        return { text: JSON.stringify([{
          key: item.key,
          decision: "accept",
          canonical_subject: "korean_literature",
          curriculum_course: "문학",
          domain: item.key === "9:23"
            ? "전쟁 소설의 사회·역사적 맥락과 비평적 감상"
            : "현대시와 희곡의 표현 방식 및 의미 해석",
          achievement_codes: ["12문학01-03", "12문학01-04"],
          confidence: 0.99,
          reason_codes: ["IN_SCOPE_KOREAN_LITERATURE", "SOURCE_EXACT"],
          transcription_status: "exact",
          transcription_evidence: `공식 source의 ${item.key} 전체 지문·발문·선택지가 일치한다.`,
        }]) };
      }
      if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
        calls.terminal++;
        throw new Error("unexpected fresh terminal before remaining source repairs");
      }
      if (request.schema?.name === "studywork_file_quiz_items") {
        const single = request.prompt.match(/printed problem (\d+) starting on page (\d+)/u);
        const target = single
          ? `${single[2]}:${single[1]}`
          : request.prompt.match(/printed problems: ([^.]+)/u)?.[1] ?? "unknown";
        calls.unrelated.push(target);
        throw new Error(`unrelated extraction blocker: ${target}`);
      }
      throw new Error(`unexpected AI call: ${request.schema?.name ?? "unknown"}`);
    });
    const runChild = (row: ReturnType<typeof q23ExactRecoveryParent>) =>
      adjudicateProblemManual(input.entry, input.problem, root, row.failed, row.parent);
    const run = () => repairAndAuditOfficialAnswers(
      input.entry,
      input.problem,
      input.solution,
      root,
      input.classified,
      input.solutions
    );

    await expect(runChild(parents[0])).resolves.toMatchObject({ classified: { classification: { key: "9:23" } } });
    await expect(runChild(parents[1])).rejects.toThrow("seeded Q28 manual classification crash");
    expect(calls.classification).toEqual(["9:23", "11:28"]);
    expect(calls.terminal).toBe(0);

    crashKey = null;
    calls.classification = [];
    for (const row of parents) await expect(runChild(row)).resolves.toBeDefined();
    expect(calls.classification).toEqual(["11:28", "11:29"]);
    const boundary = await run().then(
      () => "resolved unexpectedly",
      (error: unknown) => error instanceof Error ? error.message : String(error)
    );
    expect([
      "12:31 final source-grounded recovery도 exact가 아닙니다",
      "12:32 final source-grounded recovery도 exact가 아닙니다",
      "15:38 final source-grounded recovery도 exact가 아닙니다",
      "15:40 final source-grounded recovery도 exact가 아닙니다",
      "15:41 final source-grounded recovery도 exact가 아닙니다",
      "15:42 final source-grounded recovery도 exact가 아닙니다",
      ...q30Q42ManualKeys.map((key) => `unrelated classification blocker: ${key}`),
      ...newTrueRepairManualKeys.map((key) => `unrelated classification blocker: ${key}`),
    ]).toContain(boundary);
    expect(calls.unrelated.every((key) => [...q30Q42ManualKeys, ...newTrueRepairManualKeys].includes(key)))
      .toBe(true);
    expect(calls.terminal).toBe(0);

    const expected = [{
      key: "9:23",
      itemHash: "e4886fd0c2386eba4d4f84d0ef6f1954fc92b8d3a5ddfe99788d533f69f8cb56",
      specHash: "96368c6e161643bdfcfaef63e14ce6cbb3fc183fe32709ca746a018a4132a8bb",
      cropHashes: [
        "c4a3f7ada8aba20a634c7859328d22cab7bd6cb60df921d3b76423b3a45c91a2",
        "689ecb925a36bce576051f72a82ba52392eaebb18ead1b303c7eab65d658f737",
        "9d7b19a1c3201d7aafa074faa0ee73d65639afa846d7065116df7ab21f0f2dc9",
      ],
      lastSize: [3159, 2184],
    }, {
      key: "11:28",
      itemHash: "a15e214e36dd59e6275e46afcb15b84b13102a55c3545dd0d25eeedfd94bb86e",
      specHash: "53f4829e4f8279336872abe5d140e75463121cf664b3c0afe35c465a55ace04d",
      cropHashes: [
        "5292aacb2170ebb8ae9c70ba089bce6ce689ff9276e9d997b0f3d16c3cb3d665",
        "c534698ffb42c13ef9642bdd930e2b7ddd8b54c907bed0a5dd69ed960d7013e6",
        "581577c6aba6368e2e807d3491debc8bda2c27e4e891a734a374077ba9909376",
        "f4a0912b56ff5f19180cd6701e1b9e8a1760903869fa5284ba364f854d0587e0",
        "bcf9877f718ffb78a638ccde04f1525ae15d15dd0d948790344d6d7e22ea23fb",
      ],
      lastSize: [3159, 3970],
    }, {
      key: "11:29",
      itemHash: "573a51fae9eb3e4c5ea2aa6697fcf5ad01e0aa4826645865d2e5b012416e1618",
      specHash: "1fe98d0353b33fd15520a9c62f7ab18572716044597cc731bcc227cb0a9dfc20",
      cropHashes: [
        "5292aacb2170ebb8ae9c70ba089bce6ce689ff9276e9d997b0f3d16c3cb3d665",
        "c534698ffb42c13ef9642bdd930e2b7ddd8b54c907bed0a5dd69ed960d7013e6",
        "581577c6aba6368e2e807d3491debc8bda2c27e4e891a734a374077ba9909376",
        "f4a0912b56ff5f19180cd6701e1b9e8a1760903869fa5284ba364f854d0587e0",
        "31dd633179ce6373e82db5ef005052dd994d72cf0651b1b543873530b3ba952f",
      ],
      lastSize: [3159, 2382],
    }] as const;
    for (const row of expected) {
      const [page, number] = row.key.split(":");
      const prefix = `v1-${page.padStart(4, "0")}-${number.padStart(4, "0")}-`;
      const problemName = readdirSync(join(root, "problem-manual-adjudications"))
        .find((name) => name.startsWith(prefix))!;
      const classificationName = readdirSync(join(root, "classification-manual-adjudications"))
        .find((name) => name.startsWith(prefix))!;
      const checkpoint = JSON.parse(readFileSync(join(root, "problem-manual-adjudications", problemName), "utf8"));
      expect(canonicalEvidenceHash(checkpoint.item)).toBe(row.itemHash);
      expect(checkpoint.basis.correctionSpecHash).toBe(row.specHash);
      expect(checkpoint.basis.cropViews.map((view: { pixelSha256: string }) => view.pixelSha256))
        .toEqual(row.cropHashes);
      expect(checkpoint.basis.cropViews.at(-1)).toMatchObject({
        pixelWidth: row.lastSize[0],
        pixelHeight: row.lastSize[1],
      });
      expect(JSON.parse(readFileSync(
        join(root, "classification-manual-adjudications", classificationName),
        "utf8"
      )).items[0]).toMatchObject({
        key: row.key,
        decision: "accept",
        canonical_subject: "korean_literature",
        curriculum_course: "문학",
        transcription_status: "exact",
      });
    }

    const childSnapshot = stateSnapshot(root).filter(([path]) => path.includes("manual"));
    calls.classification = [];
    calls.unrelated = [];
    for (const row of parents) await expect(runChild(row)).resolves.toBeDefined();
    expect(calls.classification).toEqual([]);
    expect(stateSnapshot(root).filter(([path]) => path.includes("manual"))).toEqual(childSnapshot);

    const { failed: q23Failed, parent: q23Parent } = q23ExactRecoveryParent(root);
    removeManualArtifacts(root, ["9:23"]);
    const q29ProblemName = readdirSync(join(root, "problem-manual-adjudications"))
      .find((name) => name.startsWith("v1-0011-0029-"))!;
    const q29ProblemPath = join(root, "problem-manual-adjudications", q29ProblemName);
    writeFileSync(q29ProblemPath, Buffer.concat([readFileSync(q29ProblemPath), Buffer.from(" ")]));
    const beforeCrossRowPreflight = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(adjudicateProblemManual(input.entry, input.problem, root, q23Failed, q23Parent))
      .rejects.toThrow(/11:29 manual adjudication hash가 다릅니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(beforeCrossRowPreflight);
  }, 180_000);

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "rejects missing or orphaned Q29 authority before Q23 writes or AI",
    async () => {
    for (const mode of ["missing parent", "orphan child"] as const) {
      const stateDir = mkdtempSync(join(tmpdir(), "studywork-q23-q29-manual-prewrite-"));
      try {
        cpSync(q27LiveState, stateDir, { recursive: true });
        removeManualArtifacts(stateDir, ["9:23", "11:28", "11:29"]);
        const input = q27FixtureInputs(stateDir);
        const { failed, parent } = q23ExactRecoveryParent(stateDir);
        if (mode === "missing parent") {
          rmSync(join(
            stateDir,
            "classification-recoveries/v1-0011-0029-334f8c6b9e9dbcd1203157a4c95d991692f7b7d7d4b11259623ef4d38429954e-" +
              "7bb7cb863c8c4855.json"
          ));
        } else {
          mkdirSync(join(stateDir, "problem-manual-adjudications"), { recursive: true });
          writeFileSync(
            join(stateDir, "problem-manual-adjudications", `v1-0011-0029-${"0".repeat(64)}.json`),
            "{}\n"
          );
        }
        const before = stateSnapshot(stateDir);
        providerMock.complete.mockRejectedValue(new Error("AI must not run"));
        await expect(adjudicateProblemManual(input.entry, input.problem, stateDir, failed, parent))
          .rejects.toThrow(mode === "missing parent"
            ? /11:29 manual batch recovery exact-set가 다릅니다/u
            : /11:29 manual adjudication preflight orphan\/conflict/u);
        expect(providerMock.complete).not.toHaveBeenCalled();
        expect(stateSnapshot(stateDir)).toEqual(before);
        providerMock.complete.mockReset();
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "crash-resumes only Q27 before unrelated manual blockers",
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
    const otherManualKeys = [
      "4:8", "6:16", "9:23", "11:28", "11:29", "16:43", "16:44", "16:45", ...q30Q42ManualKeys,
    ];
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
          throw new Error("unrelated persisted manual blocker");
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

    await expect(run()).rejects.toThrow(/seeded Q27 manual classification crash|unrelated persisted manual blocker/u);
    expect(calls.extraction).toEqual([]);
    expect(calls.classification).toBe(1);
    expect(calls.unrelated.length).toBeGreaterThan(0);
    expect(calls.unrelated.every((key) => otherManualKeys.includes(key))).toBe(true);
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
    await expect(run()).rejects.toThrow("unrelated persisted manual blocker");
    expect(calls.extraction).toEqual([]);
    expect(calls.classification).toBe(1);
    expect(calls.unrelated.length).toBeGreaterThan(0);
    expect(calls.unrelated.every((key) => otherManualKeys.includes(key))).toBe(true);
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
    await expect(run()).rejects.toThrow("unrelated persisted manual blocker");
    expect(calls.extraction).toEqual([]);
    expect(calls.classification).toBe(beforeReplayClassification);
    expect(calls.unrelated.length).toBeGreaterThan(0);
    expect(calls.unrelated.every((key) => otherManualKeys.includes(key))).toBe(true);
    expect(readFileSync(problemPath)).toEqual(problemBytes);
    expect(readFileSync(classificationPath)).toEqual(classificationBytes);
  }, 120_000);

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "preflights and crash-resumes Q43-Q45 before unrelated later blockers",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q43-45-manual-live-"));
    cpSync(q27LiveState, root, { recursive: true });
    removeManualArtifacts(root, ["16:43", "16:44", "16:45"]);
    for (const directory of ["answer-audit", "answer-attestation"]) {
      rmSync(join(root, directory), { recursive: true, force: true });
    }
    const calls = {
      classification: [] as string[],
      unrelatedClassification: [] as string[],
      extraction: [] as string[],
      terminal: 0,
    };
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
        if ([
          "4:8", "6:16", "7:17", "7:20", "9:23", "11:28", "11:29",
          ...q30Q42ManualKeys,
          ...newTrueRepairManualKeys,
        ].includes(key)) {
          calls.unrelatedClassification.push(key);
          throw new Error(`unrelated persisted manual blocker: ${key}`);
        }
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

    await expect(run()).rejects.toThrow(
      /seeded 16:44 manual classification crash|unrelated persisted (?:manual )?blocker: (?:4:8|6:16|7:(?:17|18|19|20)|9:23|11:(?:28|29|30)|12:(?:31|32)|14:37|15:(?:38|39|40|41|42))/u
    );
    expect(calls.extraction.every((key) => !["16:43", "16:44", "16:45"].includes(key))).toBe(true);
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
    calls.unrelatedClassification = [];
    calls.extraction = [];
    await expect(run()).rejects.toThrow(
      /unrelated persisted (?:manual )?blocker: (?:4:8|6:16|7:(?:17|18|19|20)|9:23|11:(?:28|29|30)|12:(?:31|32)|14:37|15:(?:38|39|40|41|42))/u
    );
    expect(calls.classification).toEqual(["16:44"]);
    expect(calls.unrelatedClassification.length + calls.extraction.length).toBeGreaterThan(0);
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
    calls.unrelatedClassification = [];
    calls.extraction = [];
    await expect(run()).rejects.toThrow(
      /unrelated persisted (?:manual )?blocker: (?:4:8|6:16|7:(?:17|18|19|20)|9:23|11:(?:28|29|30)|12:(?:31|32)|14:37|15:(?:38|39|40|41|42))/u
    );
    expect(calls.classification).toEqual([]);
    expect(calls.unrelatedClassification.length + calls.extraction.length).toBeGreaterThan(0);
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
