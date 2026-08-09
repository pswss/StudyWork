import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  QUIZ_EXTRACT_SPEC,
  TARGETED_PROBLEM_BATCH_RULES,
  TARGETED_PROBLEM_BATCH_VERSION,
  TARGETED_PROBLEM_TRANSCRIPTION_RULES,
  TARGETED_PROBLEM_TRANSCRIPTION_VERSION,
  TARGETED_PROBLEM_REVISION_EVIDENCE_PREFIX,
  TARGETED_PROBLEM_REVISION_RULES,
  TARGETED_PROBLEM_REVISION_VERSION,
  TARGETED_PROBLEM_RECOVERY_EVIDENCE_PREFIX,
  TARGETED_PROBLEM_RECOVERY_RULES,
  TARGETED_PROBLEM_RECOVERY_VERSION,
  TARGETED_PROBLEM_CROP_ADJUDICATION_EVIDENCE_PREFIX,
  TARGETED_PROBLEM_CROP_ADJUDICATION_RULES,
  TARGETED_PROBLEM_CROP_ADJUDICATION_VERSION,
  TARGETED_SOLUTION_TRANSCRIPTION_RULES,
  TARGETED_SOLUTION_TRANSCRIPTION_VERSION,
  TARGETED_SOLUTION_REVISION_EVIDENCE_PREFIX,
  TARGETED_SOLUTION_REVISION_RULES,
  TARGETED_SOLUTION_REVISION_VERSION,
} from "../src/claude";
import {
  assertTerminalGenerationSearchBound,
  canonicalEvidenceHash,
  compareCorpusQuestionKeys,
  existingCorpusMigrationAllowlistFingerprint,
  manualAdjudicationAllowlistFingerprint,
  officialAnswerForDb,
  positiveRepairScopeAdjudicationAllowlistFingerprint,
  repairScopeAdjudicationAllowlistFingerprint,
  revisionScopeAdjudicationAllowlistFingerprint,
  runCli,
  solutionFidelityAdjudicationAllowlistFingerprint,
  solutionPromptUpgradeAllowlistFingerprint,
  TARGET_SUBJECTS,
  verifyExamCorpus,
  verifyPersistedProblemRepairOverlapForTest,
} from "../scripts/verify-exam-corpus";
import {
  applyAllowlistedProblemManualCorrection,
  auditAcceptedSolutions,
  EXISTING_CORPUS_MIGRATION_ALLOWLIST,
  parseCorpusManifest,
  PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST,
  PROBLEM_MANUAL_ADJUDICATION_PROMPT_DIGEST,
  PROBLEM_MANUAL_CORRECTION_DIGEST,
  PROBLEM_REPAIR_SCOPE_ADJUDICATION_ALLOWLIST,
  PROBLEM_REPAIR_SCOPE_ADJUDICATION_PROMPT_DIGEST,
  PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_ALLOWLIST,
  PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_PROMPT_DIGEST,
  PROBLEM_REPAIR_POSITIVE_SCOPE_AUTHORITY_REASON_CODE,
  PROBLEM_REVISION_SCOPE_ADJUDICATION_ALLOWLIST,
  PROBLEM_REVISION_SCOPE_ADJUDICATION_PROMPT_DIGEST,
  SOLUTION_PROMPT_UPGRADE_ALLOWLIST,
  SOLUTION_PROMPT_UPGRADE_FIDELITY_VERSION,
  SOLUTION_PROMPT_UPGRADE_VERSION,
  SOLUTION_REVISION_FIDELITY_ADJUDICATION_ALLOWLIST,
  SOLUTION_REVISION_FIDELITY_ADJUDICATION_PROMPT_DIGEST,
  SOLUTION_REVISION_FIDELITY_ADJUDICATION_VERSION,
  LEGACY_TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
  resolveOfficialAnswer,
} from "../scripts/import-exam-corpus";

type Target = (typeof TARGET_SUBJECTS)[number];
type Accepted = { canonical: string; target: Target; code: string };
type AnswerCase = {
  qtype: "mcq" | "short";
  choices: string[] | null;
  problemAnswer: string;
  officialRaw: string;
  storedAnswer: string;
};

const DIGEST = "7bb7cb863c8c4855";
const SEMANTIC_RULES =
  `For each item, use only its official detailed explanation and answer-choice contents to identify the one ` +
  `choice semantically supported by the reasoning. The official answer marker and the problem extractor's answer ` +
  `are intentionally hidden and must not be guessed; ordinal markers inside explanations are redacted. ` +
  `Return ambiguous when the explanation does not establish ` +
  `exactly one choice. choiceIndex is 1-based and evidence must briefly cite the decisive value or conclusion.`;
const SEMANTIC_PROMPT_DIGEST = hash(`3\n${SEMANTIC_RULES}`);
const CURRENT_SEMANTIC_PROMPT_DIGEST = hash(`4\n${SEMANTIC_RULES}`);
const V5_SEMANTIC_PROMPT_DIGEST = hash(`5\n${SEMANTIC_RULES}`);
const SOLUTION_FIDELITY_RULES = `
Independently compare every supplied accepted official solution with the attached official solution PDF pixels. Report the visible page where that numbered solution starts. Check the supplied raw final answer separately from the complete explanation through its final step. Compare every sign, coefficient, exponent, root index, fraction, formula, table, diagram, and conclusion. LaTeX normalization is allowed only when it preserves every mathematical and Korean source detail.

answerStatus is exact only when an explicit final answer is visible in these pixels and faithfully matches raw_answer; mismatch when a visible official answer differs; not_visible only when no explicit answer is visible in this attached range; unverifiable when pixels are unclear. Do not call a value derived from the reasoning exact. explanationStatus is exact only when the full reasoning is faithful and complete; mismatch for any omission, substitution, changed formula/value, truncated continuation, summary, invented step, or missing source-required table/diagram description; unverifiable when the pixels or continuation context do not support a confident decision. A redundant visual need not be narrated, but explain that it is redundant in evidence. Never guess exact. Give concise page-grounded evidence and keep every input key exactly once.
`.trim();
const SOLUTION_FIDELITY_PROMPT_DIGEST = hash(`1\n${SOLUTION_FIDELITY_RULES}`);
const TRANSCRIPTION_GATE_RULES = `
Independently compare every supplied transcription with the attached official source pixels. Check the complete shared passage and source material, the full stem, every answer choice and distractor, inequalities, signs, coefficients, exponents, fractions, formulas, tables, qtype, and all figure or visual dependencies including figure_description. Check that box plausibly covers the source problem and figure, without requiring pixel-perfect crop decimals. Do not infer fidelity from plausibility or from the proposed answer. Base the curriculum decision on the source pixels, not on an inaccurate supplied transcription.

Return transcription_status exact only when all source-required content is faithfully represented. Return mismatch when any omission, substitution, changed bound/sign/value/formula/choice, wrong qtype, or inaccurate visual description is visible. Return unverifiable when the pixels or required context do not let you decide confidently; never guess exact. Give concise page-grounded transcription_evidence. Curriculum decision and transcription fidelity are independent, so reject and review items still require this source check.
`.trim();
const TRANSCRIPTION_PROMPT_DIGEST = hash(`1\n${TRANSCRIPTION_GATE_RULES}`);
const CURRENT_TRANSCRIPTION_GATE_RULES = `
Independently compare every supplied transcription with the attached official source pixels. Check the complete shared passage and source material, the full stem, every answer choice and distractor, inequalities, signs, coefficients, exponents, fractions, formulas, tables, qtype, and all figure or visual dependencies including figure_description. Check that box plausibly covers the source problem and figure, without requiring pixel-perfect crop decimals. Do not infer fidelity from plausibility or from the proposed answer. Base the curriculum decision on the source pixels, not on an inaccurate supplied transcription.

Any summary, abridgment, omission, or paraphrase is mismatch, even when the question remains solvable. This includes every shared passage sentence, worked example, transition, quotation, annotation, and footnote required by the printed question or source set. Exact preserves the source literally rather than merely preserving meaning.

Visible text, formulas, numbers, and labels must remain literal. Whitespace, layout, and equivalent LaTeX normalization are allowed only when every sign, value, bound, label, and source detail is preserved. Only a genuinely non-text visual glyph may use an accessibility text surrogate, and only when figure_description preserves its identity, occurrence order, orientation, count, and role in the source.

Return transcription_status exact only when all source-required content is faithfully represented. Return mismatch when any omission, substitution, changed bound/sign/value/formula/choice, wrong qtype, or inaccurate visual description is visible. Return unverifiable when the pixels or required context do not let you decide confidently; never guess exact. Give concise page-grounded transcription_evidence. Curriculum decision and transcription fidelity are independent, so reject and review items still require this source check.
`.trim();
const CURRENT_TRANSCRIPTION_PROMPT_DIGEST = hash(`2\n${CURRENT_TRANSCRIPTION_GATE_RULES}`);
const PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST =
  "ebb005195877305dc3416d3158d7bd9765c4c7fa425a3e7fd28b46280df2cbf2";
const TARGETED_BATCH_PROMPT_DIGEST = hash(
  `${TARGETED_PROBLEM_BATCH_VERSION}\n${TARGETED_PROBLEM_BATCH_RULES}\n${QUIZ_EXTRACT_SPEC}`,
);
const TARGETED_BATCH_REVISION_PROMPT_DIGEST = hash(
  `${TARGETED_PROBLEM_REVISION_VERSION}\n${TARGETED_PROBLEM_REVISION_RULES}\n` +
  `${TARGETED_PROBLEM_REVISION_EVIDENCE_PREFIX}\n` +
  `${TARGETED_PROBLEM_BATCH_VERSION}\n${TARGETED_PROBLEM_BATCH_RULES}\n${QUIZ_EXTRACT_SPEC}`,
);
const TARGETED_RECOVERY_PROMPT_DIGEST = hash(
  `${TARGETED_PROBLEM_RECOVERY_VERSION}\n${TARGETED_PROBLEM_RECOVERY_RULES}\n` +
  `${TARGETED_PROBLEM_RECOVERY_EVIDENCE_PREFIX}\n` +
  `${TARGETED_PROBLEM_TRANSCRIPTION_VERSION}\n${TARGETED_PROBLEM_TRANSCRIPTION_RULES}\n${QUIZ_EXTRACT_SPEC}`,
);
const TARGETED_CROP_ADJUDICATION_PROMPT_DIGEST = hash(
  `${TARGETED_PROBLEM_CROP_ADJUDICATION_VERSION}\n${TARGETED_PROBLEM_CROP_ADJUDICATION_RULES}\n` +
  `${TARGETED_PROBLEM_CROP_ADJUDICATION_EVIDENCE_PREFIX}\n` +
  `${TARGETED_PROBLEM_TRANSCRIPTION_VERSION}\n${TARGETED_PROBLEM_TRANSCRIPTION_RULES}\n${QUIZ_EXTRACT_SPEC}`,
);
const CROP_ADJUDICATION_CLASSIFICATION_PROMPT_DIGEST =
  "ed8c7770e965f26cdbfead1b0396c9fdc3c97e0afeb40e0bf654a72894d265c0";
const Q29_CROP_SPEC = {
  allowlistId: "ebsi-5578421-q29-p11-v1",
  entryId: "ebsi:5578421",
  key: "11:29",
  sourcePage: 11,
  sourceHash: "4c9aee0ec0c15f91678bc3c179efb4c781ab0f9023ca2e5347df94060012272e",
  views: [
    { sourcePage: 11, label: "p11 full", rect: [0, 0, 1, 1] },
    { sourcePage: 11, label: "p11 left article", rect: [0.075, 0.10, 0.50, 0.92] },
    { sourcePage: 11, label: "p11 right article", rect: [0.49, 0.10, 0.92, 0.80] },
    { sourcePage: 11, label: "p11 Q29", rect: [0.49, 0.74, 0.92, 0.92] },
  ],
  requiredTokens: [
    "[29~34]", "ⓐ 전통 논리학", "ⓑ 명제 논리학", "㉠ 정언 삼단 논증", "㉡ 전건 긍정",
    "㉢ 명제 논리학", "전제에만", "‘p’와 ‘q’는", "선행 조건", "(1)", "(2)", "(3)", "(4)",
    "명사(名辭)",
    "① 논리학의 발전 과정을 개괄적으로 소개하고 있다.",
    "② 논리학의 의의를 다양한 관점에서 고찰하고 있다.",
    "③ 논리학의 특징을 인접 학문과 비교하여 분석하고 있다.",
    "④ 논리학의 논증 방식이 단순화된 배경을 설명하고 있다.",
    "⑤ 논리학의 변화에 영향을 준 여러 학문을 고찰하고 있다.",
  ],
} as const;
const Q29_OFFICIAL_PROBLEM_PATH = join(
  process.cwd(),
  "data/import-exam-corpus/f914a5cf8d2237d6c9319e23/problem.pdf",
);
const Q30_MANUAL_STATE = join(process.cwd(), "data/import-exam-corpus/f914a5cf8d2237d6c9319e23");
const Q30_MANUAL_SPEC = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((spec) =>
  spec.entryId === "ebsi:5578421" && spec.key === "12:30")!;
const Q30_FAILED_PROBLEM_PATH = join(
  Q30_MANUAL_STATE,
  "problem-recoveries/v1-0012-0030-20741052441e79627764f61577085ececd18660f475b4a29a4860b98175ef1d7.json",
);
const Q30_FAILED_CLASSIFICATION_PATH = join(
  Q30_MANUAL_STATE,
  "classification-recoveries/v1-0012-0030-7cc21907e44db72c61eb6a182cdd540f771bbc0efab4cae799c5bd681b53819c-7bb7cb863c8c4855.json",
);
const Q18_MANUAL_STATE = join(process.cwd(), "data/import-exam-corpus/714fd4581f778a9c559fd16e");
const Q18_MANUAL_SPEC = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((spec) =>
  spec.entryId === "ebsi:5656593" && spec.key === "7:18")!;
const Q9_MANUAL_STATE = join(process.cwd(), "data/import-exam-corpus/a915803b3da3a6ea056eecd6");
const Q9_MANUAL_SPEC = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((spec) =>
  spec.entryId === "ebsi:5854871" && spec.key === "2:9")!;
const MANUAL_FAILED_ARTIFACTS = new Map([
  [Q30_MANUAL_SPEC.entryId, {
    problem: Q30_FAILED_PROBLEM_PATH,
    classification: Q30_FAILED_CLASSIFICATION_PATH,
  }],
  [Q18_MANUAL_SPEC.entryId, {
    problem: join(
      Q18_MANUAL_STATE,
      "problem-recoveries/v1-0007-0018-8dc9e3101914ced2b5380528cdf56f5c607f0911f8a4f4460835260ae4cd6b3a.json",
    ),
    classification: join(
      Q18_MANUAL_STATE,
      "classification-recoveries/v1-0007-0018-eadc507490e4723cf09f622b2231222ff5cb12db3609ab381b79951dc1de3144-7bb7cb863c8c4855.json",
    ),
  }],
  [Q9_MANUAL_SPEC.entryId, {
    problem: join(
      Q9_MANUAL_STATE,
      "problem-recoveries/v1-0002-0009-ce5a6650673a79cd5cebf9a1d0593bcc75f9acd7fc5a57551ea1becf69e443d5.json",
    ),
    classification: join(
      Q9_MANUAL_STATE,
      "classification-recoveries/v1-0002-0009-284f685922e94c9eca6aef2dc7cb776f8ee4fc04601b32ecf959f840d264fc34-7bb7cb863c8c4855.json",
    ),
  }],
]);
const Q11_SCOPE_SPEC = {
  allowlistId: "ebsi-5577055-q11-scope-v1",
  entryId: "ebsi:5577055",
  key: "4:11",
  sourcePage: 4,
  sourceHash: "b4381bc3b831323375b2c4a25319d308185c930be5d2e3b07dfc28e7646a5fde",
  solutionSourceHash: "1753328f4b4360a9d81312d0d1610c7a11063bbefeeb1e1fd286d54c601ec5fa",
  promptDigest: "cec5be77bf9745d05593e497842a3642c8a30c1ef1105ba1940f0a74fad3124e",
} as const;
const Q11_SCOPE_STATE = join(process.cwd(), "data/import-exam-corpus/b4eeaf53cd6024aa180d1f37");
const Q11_OFFICIAL_PROBLEM_PATH = join(Q11_SCOPE_STATE, "problem.pdf");
const Q11_OFFICIAL_SOLUTION_PATH = join(Q11_SCOPE_STATE, "solution.pdf");
const Q26_REPAIR_SCOPE_SPEC = PROBLEM_REPAIR_SCOPE_ADJUDICATION_ALLOWLIST.find((spec) =>
  spec.entryId === "ebsi:5643101")!;
const Q30_REPAIR_SCOPE_SPEC = PROBLEM_REPAIR_SCOPE_ADJUDICATION_ALLOWLIST.find((spec) =>
  spec.entryId === "ebsi:5696441")!;
const Q10_POSITIVE_REPAIR_SCOPE_SPEC = PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_ALLOWLIST[0];
const REPAIR_SCOPE_STATES = new Map([
  [Q26_REPAIR_SCOPE_SPEC.entryId, join(process.cwd(), "data/import-exam-corpus/5a72e90edfe68c75f79ce8ef")],
  [Q30_REPAIR_SCOPE_SPEC.entryId, join(process.cwd(), "data/import-exam-corpus/8166de955e4bb324c5a7b92b")],
  [Q10_POSITIVE_REPAIR_SCOPE_SPEC.entryId,
    join(process.cwd(), "data/import-exam-corpus/88ece0f684366acb34508a33")],
]);
const REVISION_SCOPE_CASES = [{
  id: "science" as const,
  spec: PROBLEM_REVISION_SCOPE_ADJUDICATION_ALLOWLIST.find((spec) => spec.entryId === "ebsi:5854872")!,
  stateDir: join(process.cwd(), "data/import-exam-corpus/7a91a9795ad1d977e6772a42"),
  firstPairs: [[
    "problem-repair-batches/v2-0001-0004-cbe8d8bf1fdae66b7d27e998aaf2ee807d88efbd3f50d249f49b4414642397e6.json",
    "classification-repair-batches/" +
      `v1-0001-0004-18ceb86725d9f3c05bb735e662d603d694528b6323d0faef008c15926f4dcda9-${DIGEST}.json`,
  ], [
    "problem-repair-batches/v2-0001-0004-870fc56c36523b42f8859f76ff767abbdc2f7ccf3ef2aba2001c226c8905d96d.json",
    "classification-repair-batches/" +
      `v1-0001-0004-a475c52e67348c553e74d13934b996bb4d79504f1561821292ca9117d607d5ec-${DIGEST}.json`,
  ], [
    "problem-repair-batches/v2-0001-0004-4bb840d42ee1616c1d1e8516474475fc1d0e0908c18e3352d3cd7a467902568a.json",
    "classification-repair-batches/" +
      `v1-0001-0004-14ea19a28281a0ac248d28a3547b9f79c5f3a019dc7bce912a5231b67bb96e15-${DIGEST}.json`,
  ]],
  revisionProblems: [
    "problem-revision-batches/v1-0001-0004-0001-a79e4ceb18a340585d399c519f4209e1b8a9d1a79e0346ac8fcbc0ea24ff8dac.json",
    "problem-revision-batches/v1-0001-0004-0002-e30a9d836fed09479e85a5afa744c443a624fe40f8151e19d50cb1006a41685c.json",
  ],
  revisionClassification: "classification-revision-batches/" +
    `v1-0001-0004-ca35fe8c4d6c9323dc7be3618c2393393ac92bc396cd4164fa842ceec542937e-${DIGEST}.json`,
  supportingTerminals: [],
  triggerTerminal: "problem-terminal-fidelity/" +
    "v2-0000-4a746a86d66e5e199fbd26ba64b79656abc9cc79f16a37c4ab85674f5a439d1e-" +
    "a6772cf04df9ea73ecdd492d7db12772a0bcc546d4f65afc266ed1aac6ffbb20.json",
}, {
  id: "math" as const,
  spec: PROBLEM_REVISION_SCOPE_ADJUDICATION_ALLOWLIST.find((spec) => spec.entryId === "ebsi:5875878")!,
  stateDir: join(process.cwd(), "data/import-exam-corpus/04b5b5270f6444e7821cf95e"),
  firstPairs: [[
    "problem-repair-batches/v2-0001-0012-1e4fdf616632eef450be7a8c648695cf3259bbd6422f8d91aaa2c0c4934c310a.json",
    "classification-repair-batches/" +
      `v1-0001-0012-c6c317019902418361307c09084e7bc99c628e1cbbebb3e756e78c03343a5e57-${DIGEST}.json`,
  ], [
    "problem-repair-batches/v2-0001-0012-abbe8912bb85631556a6944a98147e92b0fc2c70ee5909d4017b23ba033625ac.json",
    "classification-repair-batches/" +
      `v1-0001-0012-0796c45104fe2bf4226e73987ed3aa051c147dea4593714d7bf1f12003d62400-${DIGEST}.json`,
  ], [
    "problem-repair-batches/v2-0001-0012-99f3ba2f76d1f0c478fe82b62c84371e267e1a9ae0420f53d5070fc5adeed9a3.json",
    "classification-repair-batches/" +
      `v1-0001-0012-e9810c8af04149ca80389581db81695fc934aeb89bfdbad0d5b6681358048891-${DIGEST}.json`,
  ]],
  revisionProblems: [
    "problem-revision-batches/v1-0001-0012-0012-eadf22c71b85d5e3c0c60df3a990fe3dabd9b9f847d4439fe77f3843fb5e6472.json",
  ],
  revisionClassification: "classification-revision-batches/" +
    `v1-0001-0012-f9f109554b66759eb80bf0e60be8861641d8b09d2a6c3f65b993bffe7673cba4-${DIGEST}.json`,
  supportingTerminals: ["problem-terminal-fidelity/" +
    "v2-0000-7b4ea41df64c4fa386652f39877cbe1a44bdc0bf2ff5926e3afb9f3dd0dca8d9-" +
    "13be79e7d5bae9b8497d779bb6d2bf387d391a377b21b271f2206a224f5e556a.json"],
  triggerTerminal: "problem-terminal-fidelity/" +
    "v2-0000-080ed19498b56dbaf3ff72cf7d71f87e9560c8ff1cb3923340fba8a0237f5399-" +
    "76373bfd452f7373a32a430037f8c82448b4d70816a507974119556816e450f3.json",
}] as const;
const SOLUTION_PROMPT_UPGRADE_SPEC = SOLUTION_PROMPT_UPGRADE_ALLOWLIST[0];
const SOLUTION_PROMPT_UPGRADE_STATE = join(
  process.cwd(),
  "data/import-exam-corpus/887df3e562b3dab6874de994",
);
const SOLUTION_FIDELITY_ADJUDICATION_SPEC = SOLUTION_REVISION_FIDELITY_ADJUDICATION_ALLOWLIST[0];
const SOLUTION_FIDELITY_ADJUDICATION_STATE = join(
  process.cwd(),
  "data/import-exam-corpus/bc7655b894a573179fae1c73",
);
const PERSISTED_REGROUPING_CASES = [{
  entryId: "ebsi:5594500",
  stateDir: join(process.cwd(), "data/import-exam-corpus/e9fcb8ccb0af1356a50a6de4"),
  effectiveCorpusHash: "b987fa87a2159fb4b2cfcb99993560a9490307ef0358f302605af605869f9b17",
  selectedClassificationPaths: [
    "classification-repair-batches/" +
      `v1-0001-0012-45da6057257be9c8dd99a51e446a9a9bb10185352a80c9547d2422d926ede434-${DIGEST}.json`,
  ],
  auditPath: "answer-audit/v5-1ea8994dca6c961a78178fa833c1889cc20706d64c81c11f5d8e20048e740a3e.json",
}, {
  entryId: "ebsi:5594501",
  stateDir: join(process.cwd(), "data/import-exam-corpus/b395aca2790e257b1487b455"),
  effectiveCorpusHash: "9899689cf6ebc256fbe32d7898c3cb29d0dabda066799ccbeaaf977c70894d31",
  selectedClassificationPaths: [
    "classification-repair-batches/" +
      `v1-0001-0012-4079b0d5cd668c23d07ca0792d4cdbaa5c2f3f5950f4bb0097c423a7c593f7d0-${DIGEST}.json`,
  ],
  auditPath: null,
}, {
  entryId: "ebsi:5643101",
  stateDir: join(process.cwd(), "data/import-exam-corpus/5a72e90edfe68c75f79ce8ef"),
  effectiveCorpusHash: "7f4dd66d75a99e1b3b595184bcebb8e60fff1aebdd43fac9a32fbf787d75a168",
  selectedClassificationPaths: [
    "classification-repair-batches/" +
      `v1-0001-0012-e00d25b291379897841f4123592aeb1c278d3f157e89ac759b3a5219468353ab-${DIGEST}.json`,
  ],
  auditPath: null,
}, {
  entryId: "ebsi:5643102",
  stateDir: join(process.cwd(), "data/import-exam-corpus/887df3e562b3dab6874de994"),
  effectiveCorpusHash: "854ffad3fac0dd3f0c89e4cd275a8d043da15aaa2ea1c36c0aab69e2892a7721",
  selectedClassificationPaths: [
    "classification-repair-batches/" +
      `v1-0001-0012-5e7df2f90052672c32558f747b24737db76778adcc4cf676c2a8d6b1646763fe-${DIGEST}.json`,
    "classification-repair-batches/" +
      `v1-0001-0012-2772d412366370a9eaf4eb143619f76e0d2a7e9eb482badc5c314b21ae9d405d-${DIGEST}.json`,
  ],
  auditPath: null,
}] as const;
const TARGETED_PROMPT_DIGEST = hash(
  `${TARGETED_PROBLEM_TRANSCRIPTION_VERSION}\n${TARGETED_PROBLEM_TRANSCRIPTION_RULES}\n${QUIZ_EXTRACT_SPEC}`,
);
const TARGETED_REVISION_PROMPT_DIGEST = hash(
  `${TARGETED_PROBLEM_REVISION_VERSION}\n${TARGETED_PROBLEM_REVISION_RULES}\n` +
  `${TARGETED_PROBLEM_REVISION_EVIDENCE_PREFIX}\n` +
  `${TARGETED_PROBLEM_TRANSCRIPTION_VERSION}\n${TARGETED_PROBLEM_TRANSCRIPTION_RULES}\n${QUIZ_EXTRACT_SPEC}`,
);
const TARGETED_SOLUTION_PROMPT_DIGEST = hash(
  `${TARGETED_SOLUTION_TRANSCRIPTION_VERSION}\n${TARGETED_SOLUTION_TRANSCRIPTION_RULES}`,
);
const TARGETED_SOLUTION_REVISION_PROMPT_DIGEST = hash(
  `${TARGETED_SOLUTION_REVISION_VERSION}\n${TARGETED_SOLUTION_REVISION_RULES}\n` +
  `${TARGETED_SOLUTION_REVISION_EVIDENCE_PREFIX}\n` +
  `${TARGETED_SOLUTION_TRANSCRIPTION_VERSION}\n${TARGETED_SOLUTION_TRANSCRIPTION_RULES}`,
);
const SOURCE_COUNTS: Record<string, number> = { 국어: 45, 수학: 30, 통합과학: 20, 통합사회: 20 };
const CASES: Array<{
  id: string;
  entryId?: string;
  subject: string;
  grade: number;
  rawTitle: string;
  accepted: Accepted[];
}> = [
  {
    id: "math",
    subject: "수학",
    grade: 3,
    rawTitle: "2025 수능 수학 미적분",
    accepted: [
      { canonical: "math_A", target: "수학 - 수학Ⅱ·미적분Ⅰ", code: "12미적Ⅰ-01-01" },
      { canonical: "math_B", target: "수학 - 수학Ⅰ·대수", code: "12대수01-01" },
    ],
  },
  {
    id: "korean",
    entryId: "5578421",
    subject: "국어",
    grade: 3,
    rawTitle: "2025 수능 국어 언어와 매체",
    accepted: [
      { canonical: "korean_reading", target: "국어 - 독서", code: "12독작01-03" },
      { canonical: "korean_literature", target: "국어 - 문학", code: "12문학01-01" },
    ],
  },
  {
    id: "science",
    subject: "통합과학",
    grade: 1,
    rawTitle: "2025 고1 학평 통합과학",
    accepted: [{ canonical: "integrated_science", target: "과학 - 통합과학 (2022 개정)", code: "10통과1-01-01" }],
  },
  {
    id: "social",
    subject: "통합사회",
    grade: 1,
    rawTitle: "2025 고1 학평 통합사회",
    accepted: [{ canonical: "integrated_social", target: "사회 - 통합사회 (2022 개정)", code: "10통사1-01-01" }],
  },
];

function answerCase(id: string, index: number): AnswerCase {
  if (id === "math" && index === 0) return {
    qtype: "mcq",
    choices: ["① 6", "② 9", "③ 12", "④ 15", "⑤ 18"],
    problemAnswer: "⑤ 18",
    officialRaw: "18",
    storedAnswer: "⑤ 18",
  };
  if (id === "math" && index === 1) return {
    qtype: "mcq",
    choices: ["① $5$", "② $6$", "③ $7$", "④ $8$", "⑤ $9$"],
    problemAnswer: "④ $8$",
    officialRaw: "8",
    storedAnswer: "④ $8$",
  };
  if (id === "korean" && index === 0) return {
    qtype: "mcq",
    choices: ["① $\\frac76$", "② $\\frac43$", "③ $\\frac32$", "④ $\\frac53$", "⑤ $\\frac{11}{6}$"],
    problemAnswer: "② $\\frac43$",
    officialRaw: "$\\dfrac{4}{3}$",
    storedAnswer: "② $\\frac43$",
  };
  if (id === "korean" && index === 1) return {
    qtype: "mcq",
    choices: ["① 6", "② 9", "③ 12", "④ 15", "⑤ 18"],
    problemAnswer: "⑤ 18",
    officialRaw: "⑤",
    storedAnswer: "⑤",
  };
  const answer = `${id}-answer-${index + 1}`;
  return { qtype: "short", choices: null, problemAnswer: answer, officialRaw: answer, storedAnswer: answer };
}

function explanationCase(id: string, index: number): string {
  return id === "korean" && index === 1
    ? "계산 결과는 18이다. 답은 20개. 정답은 1359. 5번 선택지가 정답이다. 답 5번."
    : `${id} official explanation ${index + 1}`;
}

function redactedExplanation(value: string): string {
  return value
    .replace(/\[\s*(?:정답|답)\s*\]\s*(?:[①-⑩]|(?:10|[1-9])(?!\d)(?:\s*번)?)/gu, "[CHOICE MARKER HIDDEN]")
    .replace(/(?:[①-⑩]|(?:10|[1-9])(?!\d))\s*번\s*(?:선택지\s*)?(?:이|가)?\s*(?:정답|답)(?:이다|입니다)?/gu, "[CHOICE MARKER HIDDEN]")
    .replace(/선택지\s*(?:[①-⑩]|(?:10|[1-9])(?!\d))(?:\s*번)?\s*(?:이|가)?\s*(?:정답|답)(?:이다|입니다)?/gu, "[CHOICE MARKER HIDDEN]")
    .replace(/(?:정답|답)\s+(?:[①-⑩]|(?:10|[1-9])(?!\d))\s*번/gu, "[CHOICE MARKER HIDDEN]")
    .replace(/(?:정답|답)\s*(?:은|는|이|가|:|：|=)\s*(?:[①-⑩]|(?:10|[1-9])(?!\d))(?:\s*번)?/gu, "[CHOICE MARKER HIDDEN]")
    .replace(/[①-⑩]/gu, "[CHOICE MARKER HIDDEN]");
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function token(value: string, length: number): string {
  return hash(value).slice(0, length);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

function writeEvidence(path: string, value: unknown): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(canonicalize(value), null, 2)}\n`);
  return canonicalEvidenceHash(value);
}

type RegroupingClassified = {
  question: Record<string, any>;
  classification: Record<string, any>;
};

function regroupingQuestionKey(question: Record<string, any>): string {
  return `${Number(question.page)}:${Number(question.number)}`;
}

function regroupingBaseCorpus(stateDir: string): RegroupingClassified[] {
  const result: RegroupingClassified[] = [];
  for (const problemName of readdirSync(join(stateDir, "problem-chunks"))
    .filter((name) => /^v2-\d{4}\.json$/u.test(name)).sort()) {
    const index = problemName.slice(3, 7);
    const problem = JSON.parse(readFileSync(join(stateDir, "problem-chunks", problemName), "utf8"));
    const classificationName = readdirSync(join(stateDir, "classification-chunks"))
      .find((name) => name.startsWith(`v5-${index}-`))!;
    const classification = JSON.parse(
      readFileSync(join(stateDir, "classification-chunks", classificationName), "utf8"),
    );
    const byKey = new Map<string, Record<string, any>>(
      classification.items.map((item: Record<string, any>) => [item.key, item]),
    );
    for (const question of problem.items as Array<Record<string, any>>) {
      result.push({ question, classification: byKey.get(regroupingQuestionKey(question))! });
    }
  }
  return result.sort((left, right) =>
    Number(left.question.page) - Number(right.question.page)
    || Number(left.question.number) - Number(right.question.number));
}

function regroupingCorpusFromGraphs(stateDir: string, graphDigests: string[]): RegroupingClassified[] {
  const base = regroupingBaseCorpus(stateDir);
  const overlay = new Map<string, RegroupingClassified>();
  for (const digest of graphDigests) {
    const name = readdirSync(join(stateDir, "classification-repair-batches"))
      .find((candidate) => candidate.includes(digest))!;
    const checkpoint = JSON.parse(
      readFileSync(join(stateDir, "classification-repair-batches", name), "utf8"),
    );
    const classificationByKey = new Map<string, Record<string, any>>(
      checkpoint.items.map((item: Record<string, any>) => [item.key, item]),
    );
    for (const member of checkpoint.members as Array<Record<string, any>>) {
      const problem = JSON.parse(readFileSync(join(stateDir, member.problemAuthority.path), "utf8"));
      const question = (problem.items ?? [problem.item]).find(
        (item: Record<string, any>) => regroupingQuestionKey(item) === member.key,
      );
      overlay.set(member.key, { question, classification: classificationByKey.get(member.key)! });
    }
  }
  return base.map((item) => overlay.get(regroupingQuestionKey(item.question)) ?? item);
}

function addRegroupingTerminal(
  stateDir: string,
  classified: RegroupingClassified[],
  templateCorpusHash: string,
): string {
  const directory = join(stateDir, "problem-terminal-fidelity");
  const templateName = readdirSync(directory).find((name) => name.includes(templateCorpusHash))!;
  const template = JSON.parse(readFileSync(join(directory, templateName), "utf8"));
  const inputs = classified
    .filter(({ question }) => Number(question.page) >= template.ownedFrom && Number(question.page) <= template.ownedTo)
    .map(({ question }) => ({
      key: regroupingQuestionKey(question),
      printed_number: String(Number(question.number)),
      source_page: question.page,
      qtype: question.qtype,
      question: question.question,
      choices: question.choices,
      figure: question.figure,
      figure_description: question.figure_description,
      box: question.box,
    }));
  const effectiveCorpusHash = canonicalEvidenceHash(classified);
  const inputHash = canonicalEvidenceHash(inputs);
  const checkpoint = { ...template, effectiveCorpusHash, inputHash, inputs };
  const index = /^v2-(\d{4})-/u.exec(templateName)![1];
  const name = `v2-${index}-${effectiveCorpusHash}-${inputHash}.json`;
  writeEvidence(join(directory, name), checkpoint);
  return name;
}

function installSyntheticRegroupingHistory(
  stateDir: string,
  selectedProblemArtifact: string,
  selectedClassificationArtifact: string,
): Array<{
  key: string;
  problemArtifact: { path: string; sha256: string };
  problemArtifactItemHash: string;
  classificationArtifact: { path: string; sha256: string };
  classificationArtifactItemHash: string;
  effectiveQuestionHash: string;
  effectiveClassificationHash: string;
}> {
  const selectedProblem = JSON.parse(readFileSync(selectedProblemArtifact, "utf8"));
  const selectedClassification = JSON.parse(readFileSync(selectedClassificationArtifact, "utf8"));
  return selectedProblem.members.map((member: Record<string, any>) => {
    const selectedQuestion = selectedProblem.items.find(
      (item: Record<string, any>) => regroupingQuestionKey(item) === member.key,
    );
    const question = {
      ...selectedQuestion,
      question: `${selectedQuestion.question} [historical alternate ${member.key}]`,
    };
    const members = [member];
    const targetsDigest = canonicalEvidenceHash(members);
    const baseClassification = JSON.parse(
      readFileSync(join(stateDir, member.baseClassificationCheckpoint.path), "utf8"),
    );
    const baseDecision = baseClassification.items.find(
      (item: Record<string, any>) => item.key === member.key,
    );
    const problemRelativePath = `problem-repair-batches/v2-` +
      `${String(selectedProblem.contextFrom).padStart(4, "0")}-` +
      `${String(selectedProblem.contextTo).padStart(4, "0")}-${targetsDigest}.json`;
    const problemSha = writeEvidence(join(stateDir, problemRelativePath), {
      ...selectedProblem,
      targetsDigest,
      members,
      diagnosticEvidenceHash: hash(JSON.stringify([{
        key: member.key,
        evidence: baseDecision.transcription_evidence,
      }])),
      items: [question],
    });
    const classification = selectedClassification.items.find(
      (item: Record<string, any>) => item.key === member.key,
    );
    const classificationMembers = [{
      key: member.key,
      problemAuthority: {
        key: member.key,
        path: problemRelativePath,
        sha256: problemSha,
        itemHash: canonicalEvidenceHash(question),
      },
      effectiveQuestionHash: canonicalEvidenceHash(question),
      baseClassificationCheckpoint: member.baseClassificationCheckpoint,
      baseClassificationHash: member.baseClassificationHash,
    }];
    const overlayDigest = canonicalEvidenceHash(classificationMembers);
    const classificationRelativePath = `classification-repair-batches/v1-` +
      `${String(selectedClassification.contextFrom).padStart(4, "0")}-` +
      `${String(selectedClassification.contextTo).padStart(4, "0")}-` +
      `${overlayDigest}-${DIGEST}.json`;
    const classificationSha = writeEvidence(join(stateDir, classificationRelativePath), {
      ...selectedClassification,
      overlayDigest,
      members: classificationMembers,
      items: [classification],
    });
    return {
      key: member.key,
      problemArtifact: { path: problemRelativePath, sha256: problemSha },
      problemArtifactItemHash: canonicalEvidenceHash(question),
      classificationArtifact: { path: classificationRelativePath, sha256: classificationSha },
      classificationArtifactItemHash: canonicalEvidenceHash(classification),
      effectiveQuestionHash: canonicalEvidenceHash(question),
      effectiveClassificationHash: canonicalEvidenceHash(classification),
    };
  });
}

const execFileP = promisify(execFile);
const migrationRepository = resolve(import.meta.dirname, "..");
const migrationSourceData = join(migrationRepository, "data");
const migrationEntryId = "ebsi:5695028";
const migrationEntryToken = "bc66d0c1b35ffd8e12edd536";
const migrationOldReceiptSha = "5e1fbea9c346a0e89fb21938176c21e00c19527e6369f5251a1f53e6446711a1";

async function migratedVerifierFixture(): Promise<{
  root: string;
  dataDir: string;
  dbPath: string;
  manifestPath: string;
  stateDir: string;
  planPath: string;
  plan: Record<string, any>;
}> {
  const root = mkdtempSync(join(tmpdir(), "verify-exam-corpus-migration-"));
  const dataDir = join(root, "data");
  const stateDir = join(dataDir, "import-exam-corpus", migrationEntryToken);
  const sourceState = join(migrationSourceData, "import-exam-corpus", migrationEntryToken);
  mkdirSync(join(dataDir, "import-exam-corpus"), { recursive: true });
  cpSync(sourceState, stateDir, { recursive: true });
  mkdirSync(join(dataDir, "files", "corpus"), { recursive: true });
  cpSync(
    join(migrationSourceData, "files", "corpus", migrationEntryToken),
    join(dataDir, "files", "corpus", migrationEntryToken),
    { recursive: true },
  );
  const sourcePlanDir = join(stateDir, "migration-plans");
  const sourcePlanName = existsSync(sourcePlanDir)
    ? readdirSync(sourcePlanDir).find((name) => /^v1-[a-f0-9]{64}\.json$/u.test(name))
    : undefined;
  if (sourcePlanName) {
    const sourcePlan = JSON.parse(readFileSync(join(sourcePlanDir, sourcePlanName), "utf8"));
    const sourceBackup = join(migrationSourceData, sourcePlan.backup.path);
    const targetBackup = join(dataDir, sourcePlan.backup.path);
    mkdirSync(resolve(targetBackup, ".."), { recursive: true });
    cpSync(sourceBackup, targetBackup);
    cpSync(sourceBackup, join(dataDir, "studywork.db"));
    const history = JSON.parse(readFileSync(
      join(stateDir, "receipt-history", `v1-${migrationOldReceiptSha}.json`), "utf8",
    ));
    writeEvidence(join(stateDir, "receipt.json"), history.receipt.value);
    rmSync(join(stateDir, "migration-commits"), { recursive: true, force: true });
    rmSync(join(stateDir, "answer-attestation"), { recursive: true, force: true });
  } else {
    const source = new Database(join(migrationSourceData, "studywork.db"), { readonly: true, fileMustExist: true });
    try {
      await source.backup(join(dataDir, "studywork.db"));
    } finally {
      source.close();
    }
    expect(hash(readFileSync(join(stateDir, "receipt.json")))).toBe(migrationOldReceiptSha);
  }
  await execFileP(process.execPath, [
    "--import", "tsx", "scripts/import-exam-corpus.ts",
    "--manifest", "data/ebsi-exam-manifest.json",
    "--data-dir", dataDir,
    "--commit",
    "--migrate-existing", migrationEntryId,
    "--expect-receipt-sha256", migrationOldReceiptSha,
  ], { cwd: migrationRepository, timeout: 60_000 });

  const dbPath = join(dataDir, "studywork.db");
  const db = new Database(dbPath);
  try {
    db.prepare(
      "DELETE FROM book_files WHERE r2_key LIKE 'corpus/%' AND id NOT IN (148, 149, 150, 151)",
    ).run();
  } finally {
    db.close();
  }
  const sourceManifest = JSON.parse(readFileSync(join(migrationSourceData, "ebsi-exam-manifest.json"), "utf8"));
  const manifestPath = join(dataDir, "single-migration-manifest.json");
  writeEvidence(manifestPath, {
    schemaVersion: 2,
    entries: sourceManifest.entries.filter((entry: { id: string }) => entry.id === migrationEntryId),
  });
  const planName = readdirSync(join(stateDir, "migration-plans"))
    .find((name) => /^v1-[a-f0-9]{64}\.json$/u.test(name))!;
  const planPath = join(stateDir, "migration-plans", planName);
  return {
    root,
    dataDir,
    dbPath,
    manifestPath,
    stateDir,
    planPath,
    plan: JSON.parse(readFileSync(planPath, "utf8")),
  };
}

function pngHeader(width: number, height: number): Buffer {
  const value = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(value, 0);
  value.write("IHDR", 12, "ascii");
  value.writeUInt32BE(width, 16);
  value.writeUInt32BE(height, 20);
  return value;
}

function schema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE subjects (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE books (id INTEGER PRIMARY KEY, subject_id INTEGER NOT NULL, title TEXT NOT NULL);
    CREATE TABLE book_files (
      id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL, r2_key TEXT NOT NULL,
      content_hash TEXT, page_count INTEGER, status TEXT NOT NULL
    );
    CREATE TABLE book_items (
      id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL, file_id INTEGER NOT NULL,
      category TEXT NOT NULL, number TEXT NOT NULL, answer TEXT NOT NULL,
      content TEXT NOT NULL, page INTEGER
    );
    CREATE TABLE questions (
      id INTEGER PRIMARY KEY, subject_id INTEGER NOT NULL, source TEXT NOT NULL,
      qtype TEXT NOT NULL, question TEXT NOT NULL, choices TEXT, answer TEXT NOT NULL,
      explanation TEXT NOT NULL, difficulty TEXT NOT NULL, book_id INTEGER, book_number TEXT, printed_number TEXT,
      src_file_id INTEGER, src_page INTEGER
    );
  `);
}

function fixture(): { root: string; dataDir: string; dbPath: string; manifestPath: string; stateDirs: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "verify-exam-corpus-"));
  const dataDir = join(root, "data");
  const dbPath = join(dataDir, "studywork.db");
  const manifestPath = join(dataDir, "ebsi-exam-manifest.json");
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(dbPath);
  schema(db);
  const subjectIds = new Map<Target, number>();
  for (const [index, subject] of TARGET_SUBJECTS.entries()) {
    const id = index + 1;
    db.prepare("INSERT INTO subjects (id, name) VALUES (?, ?)").run(id, subject);
    subjectIds.set(subject, id);
  }

  const stateDirs: Record<string, string> = {};
  const manifestEntries: Record<string, unknown>[] = [];
  let bookId = 0;
  let fileId = 0;
  let questionId = 0;
  let itemId = 0;
  for (const testCase of CASES) {
    const entry = {
      id: `ebsi:${testCase.entryId ?? testCase.id}`,
      paperId: testCase.id,
      irecord: "202511130",
      sourceRecordDate: "2025-11-13",
      sourceRecordYear: 2025,
      sourceRecordMonth: 11,
      grade: testCase.grade,
      examKind: "mock",
      subject: testCase.subject,
      variant: null,
      form: null,
      examTitle: `${testCase.rawTitle} 시험`,
      rawTitle: testCase.rawTitle,
      sourcePageUrl: "https://www.ebsi.co.kr/source",
      problemPdfUrl: `https://wdown.ebsi.co.kr/${testCase.id}-problem.pdf`,
      solutionPdfUrl: `https://wdown.ebsi.co.kr/${testCase.id}-solution.pdf`,
    };
    manifestEntries.push(entry);
    const stateDir = join(dataDir, "import-exam-corpus", token(entry.id, 24));
    stateDirs[testCase.id] = stateDir;
    const problem = `problem-${testCase.id}`;
    const solution = `solution-${testCase.id}`;
    const problemHash = hash(problem);
    const solutionHash = hash(solution);
    const solutionPageCount = testCase.id === "math" ? 13 : 1;
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "problem.pdf"), problem);
    writeFileSync(join(stateDir, "solution.pdf"), solution);
    writeJson(join(stateDir, "entry.json"), { schemaVersion: 1, entry });
    writeJson(join(stateDir, "downloads.json"), {
      version: 2,
      problem: { path: "problem.pdf", requestedUrl: entry.problemPdfUrl, sha256: problemHash, bytes: problem.length, pageCount: 1 },
      solution: { path: "solution.pdf", requestedUrl: entry.solutionPdfUrl, sha256: solutionHash, bytes: solution.length, pageCount: solutionPageCount },
    });
    const answerCases = Array.from({ length: SOURCE_COUNTS[testCase.subject] }, (_, index) => answerCase(testCase.id, index));
    const problems = answerCases.map((answer, index) => ({
      number: String(index + 1),
      qtype: answer.qtype,
      difficulty: "중",
      question: `${testCase.id} question ${index + 1}`,
      choices: answer.choices,
      answer: answer.problemAnswer,
      explanation: "",
      page: 1,
      figure: false,
      figure_description: null,
      box: null,
    }));
    writeJson(join(stateDir, "problem-chunks", "v2-0000.json"), {
      version: 2,
      sourceHash: problemHash,
      from: 1,
      to: 1,
      ownedFrom: 1,
      ownedTo: 1,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      items: problems,
    });
    writeJson(join(stateDir, "classification-chunks", `v4-0000-${DIGEST}.json`), {
      version: 4,
      sourceHash: problemHash,
      from: 1,
      to: 1,
      ownedFrom: 1,
      ownedTo: 1,
      rulesDigest: DIGEST,
      transcriptionGateVersion: 1,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      items: problems.map((_problem, index) => {
        const accepted = testCase.accepted[index];
        return accepted ? {
          key: `1:${index + 1}`,
          decision: "accept",
          canonical_subject: accepted.canonical,
          curriculum_course: "course",
          domain: "domain",
          achievement_codes: [accepted.code],
          confidence: 0.99,
          reason_codes: ["IN_SCOPE"],
          transcription_status: "exact",
          transcription_evidence: "source pixels match the complete transcription",
        } : {
          key: `1:${index + 1}`,
          decision: "reject",
          canonical_subject: null,
          curriculum_course: null,
          domain: null,
          achievement_codes: [],
          confidence: 0.99,
          reason_codes: ["OUT_OF_SCOPE"],
          transcription_status: "exact",
          transcription_evidence: "source pixels match the complete transcription",
        };
      }),
    });
    const solutionItems = problems.map((_problemItem, index) => ({
        number: String(index + 1),
        answer: answerCases[index].officialRaw,
        explanation: explanationCase(testCase.id, index),
        page: solutionPageCount === 1 ? 1 : index % solutionPageCount + 1,
        complete: true,
    }));
    const solutionRanges = solutionPageCount === 1
      ? [{ from: 1, to: 1, ownedFrom: 1, ownedTo: 1 }]
      : [
          { from: 1, to: 6, ownedFrom: 1, ownedTo: 4 },
          { from: 5, to: 10, ownedFrom: 5, ownedTo: 8 },
          { from: 9, to: 13, ownedFrom: 9, ownedTo: 13 },
        ];
    for (const [index, range] of solutionRanges.entries()) {
      writeJson(join(stateDir, "solution-chunks", `v3-${String(index).padStart(4, "0")}.json`), {
        version: 3,
        sourceHash: solutionHash,
        ...range,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        items: solutionItems.filter((item) => item.page >= range.ownedFrom && item.page <= range.ownedTo),
      });
    }

    const effectiveCorpus = problems.map((question, index) => ({
      question,
      classification: testCase.accepted[index] ? {
        key: `1:${index + 1}`,
        decision: "accept",
        canonical_subject: testCase.accepted[index].canonical,
        curriculum_course: "course",
        domain: "domain",
        achievement_codes: [testCase.accepted[index].code],
        confidence: 0.99,
        reason_codes: ["IN_SCOPE"],
        transcription_status: "exact",
        transcription_evidence: "source pixels match the complete transcription",
      } : {
        key: `1:${index + 1}`,
        decision: "reject",
        canonical_subject: null,
        curriculum_course: null,
        domain: null,
        achievement_codes: [],
        confidence: 0.99,
        reason_codes: ["OUT_OF_SCOPE"],
        transcription_status: "exact",
        transcription_evidence: "source pixels match the complete transcription",
      },
    }));
    const effectiveCorpusHash = canonicalEvidenceHash(effectiveCorpus);
    const acceptedFidelity = testCase.accepted.map((_accepted, index) => {
      const solutionItem = solutionItems[index];
      const rangeIndex = solutionRanges.findIndex((range) =>
        solutionItem.page >= range.ownedFrom && solutionItem.page <= range.ownedTo);
      const range = solutionRanges[rangeIndex];
      const basePath = `solution-chunks/v3-${String(rangeIndex).padStart(4, "0")}.json`;
      const marker = /^([①-⑩])$/u.exec(answerCases[index].officialRaw)?.[1];
      const input = {
        key: `1:${index + 1}`,
        printedNumber: String(index + 1),
        qtype: answerCases[index].qtype,
        allowDerivedMarkerAnswer: marker !== undefined,
        sourcePage: solutionItem.page,
        rawAnswer: solutionItem.answer,
        explanation: solutionItem.explanation,
        complete: true,
        baseSolutionCheckpoint: { path: basePath, sha256: hash(readFileSync(join(stateDir, basePath))) },
        baseSolutionItemHash: canonicalEvidenceHash(solutionItem),
        baseContextFrom: range.from,
        baseContextTo: range.to,
        baseOwnedFrom: range.ownedFrom,
        baseOwnedTo: range.ownedTo,
      };
      const decision = {
        key: input.key,
        sourcePage: input.sourcePage,
        answerStatus: marker ? "not_visible" : "exact",
        explanationStatus: "exact",
        evidence: marker
          ? "the complete explanation is exact; its ordinal raw answer is not visible in this range"
          : "the explicit raw answer and complete explanation match the official pixels",
      };
      return { input, decision, solutionItem };
    });
    const fidelityInputs = acceptedFidelity.map(({ input }) => input);
    const fidelityInputHash = canonicalEvidenceHash(fidelityInputs);
    const fidelityRelativePath =
      `solution-fidelity/v1-0000-${effectiveCorpusHash}-${fidelityInputHash}.json`;
    const fidelityCheckpoint = {
      version: 1,
      entryId: entry.id,
      sourceHash: solutionHash,
      from: 1,
      to: solutionPageCount,
      ownedFrom: 1,
      ownedTo: solutionPageCount,
      classifierVersion: 4,
      rulesDigest: DIGEST,
      transcriptionGateVersion: 1,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
      effectiveProblemCorpusHash: effectiveCorpusHash,
      inputHash: fidelityInputHash,
      promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      inputs: fidelityInputs,
      items: acceptedFidelity.map(({ decision }) => decision),
    };
    const fidelityHash = writeEvidence(join(stateDir, fidelityRelativePath), fidelityCheckpoint);
    const solutionFidelityCheckpoints = [{
      path: fidelityRelativePath,
      sha256: fidelityHash,
      from: 1,
      to: solutionPageCount,
      ownedFrom: 1,
      ownedTo: solutionPageCount,
      inputHash: fidelityInputHash,
    }];
    const solutionFidelityItems = acceptedFidelity.map(({ input, decision }) => ({
      key: input.key,
      printedNumber: input.printedNumber,
      qtype: input.qtype,
      basePage: input.sourcePage,
      effectivePage: input.sourcePage,
      answerStatus: decision.answerStatus,
      explanationStatus: decision.explanationStatus,
      evidence: decision.evidence,
      fidelityArtifact: { path: fidelityRelativePath, sha256: fidelityHash },
      baseSolutionItemHash: input.baseSolutionItemHash,
      effectiveSolutionItemHash: input.baseSolutionItemHash,
      baseRawAnswerHash: hash(input.rawAnswer),
      effectiveRawAnswerHash: hash(input.rawAnswer),
      baseExplanationHash: hash(input.explanation),
      effectiveExplanationHash: hash(input.explanation),
    })).sort((left, right) => left.key.localeCompare(right.key));
    const effectiveSolutionCorpusHash = canonicalEvidenceHash(acceptedFidelity.map(({ input, solutionItem }) => ({
      key: input.key,
      solution: solutionItem,
    })).sort((left, right) => left.key.localeCompare(right.key)));
    const markerInputs: Array<{ key: string; choices: string[]; detailedExplanation: string }> = [];
    const auditItems = testCase.accepted.flatMap((_accepted, index) => {
      const answer = answerCases[index];
      if (answer.qtype !== "mcq") return [];
      const marker = /^([①-⑩])$/u.exec(answer.officialRaw)?.[1];
      const choiceIndex = marker
        ? "①②③④⑤⑥⑦⑧⑨⑩".indexOf(marker) + 1
        : answer.choices!.indexOf(answer.storedAnswer) + 1;
      const mode = marker ? "choice-marker" : "choice-content";
      const semantic = marker ? {
        status: "resolved",
        choiceIndex,
        evidence: `official explanation resolves choice ${choiceIndex}`,
      } : null;
      if (marker) {
        markerInputs.push({
          key: `1:${index + 1}`,
          choices: answer.choices!,
          detailedExplanation: redactedExplanation(explanationCase(testCase.id, index)),
        });
      }
      return [{
        key: `1:${index + 1}`,
        printedNumber: String(index + 1),
        sourcePage: 1,
        officialRawAnswerHash: hash(answer.officialRaw),
        storedAnswerHash: hash(answer.storedAnswer),
        mode,
        choiceIndex,
        semantic,
      }];
    }).sort((left, right) => left.key.localeCompare(right.key));
    let semanticCheckpoint: {
      path: string;
      sha256: string;
      inputHash: string;
      effectiveSolutionCorpusHash: string;
    } | null = null;
    if (markerInputs.length > 0) {
      const inputHash = canonicalEvidenceHash(markerInputs);
      const relativePath = `semantic-choice-checks/v3-${inputHash}.json`;
      const checkpoint = {
        version: 3,
        entryId: entry.id,
        problemHash,
        solutionHash,
        classifierVersion: 4,
        rulesDigest: DIGEST,
        transcriptionGateVersion: 1,
        transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
        effectiveCorpusHash,
        effectiveSolutionCorpusHash,
        inputHash,
        promptDigest: SEMANTIC_PROMPT_DIGEST,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        inputs: markerInputs,
        items: markerInputs.map((input) => ({
          key: input.key,
          status: "resolved",
          choiceIndex: auditItems.find((item) => item.key === input.key)!.choiceIndex,
          evidence: `official explanation resolves choice ${auditItems.find((item) => item.key === input.key)!.choiceIndex}`,
        })),
      };
      semanticCheckpoint = {
        path: relativePath,
        sha256: writeEvidence(join(stateDir, relativePath), checkpoint),
        inputHash,
        effectiveSolutionCorpusHash,
      };
    }
    const targetQuestionCounts = Object.fromEntries(testCase.accepted.map((accepted) => [accepted.target, 1]));
    const auditBasis = {
      entryId: entry.id,
      problemHash,
      solutionHash,
      classifierVersion: 4,
      rulesDigest: DIGEST,
      transcriptionGateVersion: 1,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
      solutionFidelityVersion: 1,
      solutionFidelityPromptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
      semanticChoiceVersion: 3,
      semanticPromptDigest: SEMANTIC_PROMPT_DIGEST,
      sourceQuestionCount: problems.length,
      acceptedQuestionCount: testCase.accepted.length,
      rejectedQuestionCount: problems.length - testCase.accepted.length,
      reviewQuestionCount: 0,
      targetQuestionCounts,
      acceptedSolutionKeys: solutionFidelityItems.map((item) => item.key),
      solutionRepairKeys: [],
      derivedAnswerKeys: solutionFidelityItems
        .filter((item) => item.answerStatus === "not_visible").map((item) => item.key),
      acceptedMcqKeys: auditItems.map((item) => item.key).sort(),
      effectiveCorpusHash,
      effectiveSolutionCorpusHash,
      solutionFidelityCheckpoints,
      solutionFidelityItems,
      solutionRepairs: [],
      semanticCheckpoint,
      repairs: [],
      items: auditItems,
    };
    const auditDigest = canonicalEvidenceHash(auditBasis);
    const auditRelativePath = `answer-audit/v2-${auditDigest}.json`;
    const auditHash = writeEvidence(join(stateDir, auditRelativePath), {
      version: 2,
      auditDigest,
      ...auditBasis,
    });

    const displayTitle = `2025년 · ${testCase.rawTitle}`;
    const targetBooks = testCase.accepted.map((accepted, index) => {
      const prefix = `corpus/${token(entry.id, 24)}/${token(accepted.target, 16)}`;
      const problemR2Key = `${prefix}/problem.pdf`;
      const solutionR2Key = `${prefix}/solution.pdf`;
      const targetDir = join(dataDir, "files", prefix);
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, "problem.pdf"), problem);
      writeFileSync(join(targetDir, "solution.pdf"), solution);
      const targetBookId = ++bookId;
      const problemFileId = ++fileId;
      const solutionFileId = ++fileId;
      db.prepare("INSERT INTO books (id, subject_id, title) VALUES (?, ?, ?)")
        .run(targetBookId, subjectIds.get(accepted.target), displayTitle);
      db.prepare("INSERT INTO book_files (id, book_id, r2_key, content_hash, page_count, status) VALUES (?, ?, ?, ?, 1, 'ready')")
        .run(problemFileId, targetBookId, problemR2Key, problemHash);
      db.prepare("INSERT INTO book_files (id, book_id, r2_key, content_hash, page_count, status) VALUES (?, ?, ?, ?, ?, 'ready')")
        .run(solutionFileId, targetBookId, solutionR2Key, solutionHash, solutionPageCount);
      const officialExplanation = explanationCase(testCase.id, index);
      const answer = answerCases[index];
      const id = ++questionId;
      db.prepare(
        `INSERT INTO questions
         (id, subject_id, source, qtype, question, choices, answer, explanation, book_id,
          difficulty, book_number, printed_number, src_file_id, src_page)
         VALUES (?, ?, 'uploaded', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(
        id,
        subjectIds.get(accepted.target),
        answer.qtype,
        problems[index].question,
        answer.choices ? JSON.stringify(answer.choices) : null,
        answer.storedAnswer,
        officialExplanation,
        targetBookId,
        problems[index].difficulty,
        String(index + 1),
        String(index + 1),
        problemFileId,
      );
      db.prepare("INSERT INTO book_items (id, book_id, file_id, category, number, answer, content, page) VALUES (?, ?, ?, '문제', ?, ?, ?, 1)")
        .run(++itemId, targetBookId, problemFileId, String(index + 1), answer.storedAnswer, problems[index].question);
      db.prepare("INSERT INTO book_items (id, book_id, file_id, category, number, answer, content, page) VALUES (?, ?, ?, '해설', ?, ?, ?, ?)")
        .run(++itemId, targetBookId, solutionFileId, String(index + 1), answer.storedAnswer, officialExplanation, solutionItems[index].page);
      return {
        subject: accepted.target,
        examTitle: entry.examTitle,
        bookTitle: displayTitle,
        expectedQuestionCount: 1,
        problemR2Key,
        solutionR2Key,
      };
    });
    const receipt = {
      version: 2,
      status: "committed",
      entryId: entry.id,
      examTitle: entry.examTitle,
      rawTitle: entry.rawTitle,
      bookTitle: displayTitle,
      sourceRecordYear: 2025,
      variant: null,
      form: null,
      sourceSubject: entry.subject,
      grade: entry.grade,
      rulesDigest: DIGEST,
      sourceQuestionCount: problems.length,
      acceptedQuestionCount: testCase.accepted.length,
      rejectedQuestionCount: problems.length - testCase.accepted.length,
      reviewQuestionCount: 0,
      problemHash,
      solutionHash,
      problemChunking: { pages: 20, stride: 18, overlap: 2 },
      targetBooks,
    };
    const receiptHash = writeEvidence(join(stateDir, "receipt.json"), receipt);
    const attestationBasis = {
      entryId: entry.id,
      problemHash,
      solutionHash,
      classifierVersion: 4,
      rulesDigest: DIGEST,
      transcriptionGateVersion: 1,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
      solutionFidelityVersion: 1,
      solutionFidelityPromptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
      receipt: { path: "receipt.json", sha256: receiptHash },
      answerAudit: {
        path: auditRelativePath,
        sha256: auditHash,
        effectiveCorpusHash,
        effectiveSolutionCorpusHash,
      },
      repairs: [],
      solutionFidelityCheckpoints,
      solutionFidelityItems,
      solutionRepairs: [],
    };
    const attestationDigest = canonicalEvidenceHash(attestationBasis);
    writeEvidence(join(stateDir, "answer-attestation", `v2-${attestationDigest}.json`), {
      version: 2,
      attestationDigest,
      ...attestationBasis,
    });
  }
  db.close();

  const bySubject = Object.fromEntries(["국어", "수학", "통합사회", "통합과학"].map((subject) => [
    subject,
    manifestEntries.filter((entry) => entry.subject === subject).length,
  ]));
  writeJson(manifestPath, { schemaVersion: 2, summary: { entries: manifestEntries.length, bySubject }, entries: manifestEntries });
  return { root, dataDir, dbPath, manifestPath, stateDirs };
}

function q20EffectiveClassified(): Array<{
  question: Record<string, any>;
  classification: Record<string, any>;
}> {
  const terminal = JSON.parse(readFileSync(join(
    SOLUTION_FIDELITY_ADJUDICATION_STATE,
    "problem-terminal-fidelity/" +
      "v2-0000-3f0f4625f5ee5ba0c627c2655ae751e7fdbd334e49143b552b1280b71abbdda6-" +
      "15bcf83cec42ceb2f2fa4d0640538b6b29825938998e2f8dbf095bbd940afe66.json",
  ), "utf8"));
  const baseQuestions = JSON.parse(readFileSync(join(
    SOLUTION_FIDELITY_ADJUDICATION_STATE,
    "problem-chunks/v2-0000.json",
  ), "utf8")).items as Array<Record<string, any>>;
  const baseDecisions = new Map<string, Record<string, any>>(
    JSON.parse(readFileSync(join(
      SOLUTION_FIDELITY_ADJUDICATION_STATE,
      `classification-chunks/v5-0000-${DIGEST}.json`,
    ), "utf8")).items.map((decision: Record<string, any>) => [decision.key, decision]),
  );
  const repairedByQuestionHash = new Map<string, Record<string, any>>();
  const classificationRepairDir = join(
    SOLUTION_FIDELITY_ADJUDICATION_STATE,
    "classification-repair-batches",
  );
  for (const name of readdirSync(classificationRepairDir)) {
    const checkpoint = JSON.parse(readFileSync(join(classificationRepairDir, name), "utf8"));
    const itemByKey = new Map<string, Record<string, any>>(
      checkpoint.items.map((item: Record<string, any>) => [item.key, item]),
    );
    for (const member of checkpoint.members) {
      repairedByQuestionHash.set(member.effectiveQuestionHash, itemByKey.get(member.key)!);
    }
  }
  const repairedQuestions = readdirSync(join(
    SOLUTION_FIDELITY_ADJUDICATION_STATE,
    "problem-repair-batches",
  )).flatMap((name) => JSON.parse(readFileSync(join(
    SOLUTION_FIDELITY_ADJUDICATION_STATE,
    "problem-repair-batches",
    name,
  ), "utf8")).items as Array<Record<string, any>>);
  const projection = (question: Record<string, any>) => ({
    page: question.page,
    number: question.number,
    qtype: question.qtype,
    question: question.question,
    choices: question.choices,
    box: question.box,
    figure: question.figure,
    figure_description: question.figure_description,
  });
  const questions = terminal.inputs.map((input: Record<string, any>) => {
    const shared = {
      page: input.source_page,
      number: input.printed_number,
      qtype: input.qtype,
      question: input.question,
      choices: input.choices,
      box: input.box,
      figure: input.figure,
      figure_description: input.figure_description,
    };
    const repaired = repairedQuestions.find((candidate) =>
      canonicalEvidenceHash(projection(candidate)) === canonicalEvidenceHash(shared)
        && repairedByQuestionHash.has(canonicalEvidenceHash(candidate)));
    if (repaired) return structuredClone(repaired);
    const base = baseQuestions.find((candidate) => `${candidate.page}:${candidate.number}` === input.key);
    if (!base || canonicalEvidenceHash(projection(base)) !== canonicalEvidenceHash(shared)) {
      throw new Error(`${input.key} Q20 effective question reconstruction failed`);
    }
    return structuredClone(base);
  });
  const classified = questions.map((question: Record<string, any>) => ({
    question,
    classification: repairedByQuestionHash.get(canonicalEvidenceHash(question))
      ?? baseDecisions.get(`${question.page}:${question.number}`)!,
  }));
  expect(canonicalEvidenceHash(classified)).toBe(terminal.effectiveCorpusHash);
  return classified;
}

function prepareQ11ScopeFixture(files: ReturnType<typeof fixture>): void {
  const oldStateDir = files.stateDirs.math;
  const entryPath = join(oldStateDir, "entry.json");
  const entryState = JSON.parse(readFileSync(entryPath, "utf8"));
  const oldEntryId = entryState.entry.id;
  const officialDownloads = JSON.parse(readFileSync(join(Q11_SCOPE_STATE, "downloads.json"), "utf8"));
  Object.assign(entryState.entry, {
    id: Q11_SCOPE_SPEC.entryId,
    paperId: "5577055",
    sourcePageUrl: "https://www.ebsi.co.kr/ebs/xip/xipc/previousPaperList.ebs",
    problemPdfUrl: officialDownloads.problem.requestedUrl,
    solutionPdfUrl: officialDownloads.solution.requestedUrl,
  });
  const stateDir = join(files.dataDir, "import-exam-corpus", token(Q11_SCOPE_SPEC.entryId, 24));
  renameSync(oldStateDir, stateDir);
  files.stateDirs.math = stateDir;
  writeJson(join(stateDir, "entry.json"), entryState);

  const manifest = JSON.parse(readFileSync(files.manifestPath, "utf8"));
  const manifestEntry = manifest.entries.find((entry: { id: string }) => entry.id === oldEntryId);
  Object.assign(manifestEntry, entryState.entry);
  writeJson(files.manifestPath, manifest);

  const problemBytes = readFileSync(Q11_OFFICIAL_PROBLEM_PATH);
  const solutionBytes = readFileSync(Q11_OFFICIAL_SOLUTION_PATH);
  expect(hash(problemBytes)).toBe(Q11_SCOPE_SPEC.sourceHash);
  expect(hash(solutionBytes)).toBe(Q11_SCOPE_SPEC.solutionSourceHash);
  writeFileSync(join(stateDir, "problem.pdf"), problemBytes);
  writeFileSync(join(stateDir, "solution.pdf"), solutionBytes);
  writeJson(join(stateDir, "downloads.json"), {
    version: 2,
    problem: { ...officialDownloads.problem, path: "problem.pdf" },
    solution: { ...officialDownloads.solution, path: "solution.pdf" },
  });

  const solutionChunkDir = join(stateDir, "solution-chunks");
  const syntheticSolutionItems = readdirSync(solutionChunkDir)
    .filter((name) => /^v3-\d{4}\.json$/u.test(name))
    .sort()
    .flatMap((name) => JSON.parse(readFileSync(join(solutionChunkDir, name), "utf8")).items)
    .sort((left: { number: string }, right: { number: string }) => Number(left.number) - Number(right.number));
  const officialSolutionCheckpoint = JSON.parse(readFileSync(
    join(Q11_SCOPE_STATE, "solution-chunks", "v3-0000.json"),
    "utf8",
  ));
  const officialQ11 = officialSolutionCheckpoint.items.find(
    (item: { number: string }) => item.number === "11",
  );
  const solutionCheckpointPath = join(solutionChunkDir, "v3-0000.json");
  const solutionCheckpoint = JSON.parse(readFileSync(solutionCheckpointPath, "utf8"));
  Object.assign(solutionCheckpoint, {
    sourceHash: Q11_SCOPE_SPEC.solutionSourceHash,
    from: 1,
    to: 5,
    ownedFrom: 1,
    ownedTo: 5,
    items: syntheticSolutionItems.map((item: Record<string, unknown>) => ({
      ...item,
      ...(item.number === "11" ? officialQ11 : {}),
      page: (Number(item.number) - 1) % 5 + 1,
    })),
  });
  writeJson(solutionCheckpointPath, solutionCheckpoint);
  for (const name of readdirSync(solutionChunkDir)) {
    if (/^v3-(?!0000)\d{4}\.json$/u.test(name)) rmSync(join(solutionChunkDir, name));
  }

  const receiptPath = join(stateDir, "receipt.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  receipt.entryId = Q11_SCOPE_SPEC.entryId;
  receipt.problemHash = Q11_SCOPE_SPEC.sourceHash;
  receipt.solutionHash = Q11_SCOPE_SPEC.solutionSourceHash;
  const db = new Database(files.dbPath);
  for (const target of receipt.targetBooks as Array<{
    subject: Target;
    problemR2Key: string;
    solutionR2Key: string;
  }>) {
    const prefix = `corpus/${token(Q11_SCOPE_SPEC.entryId, 24)}/${token(target.subject, 16)}`;
    const problemR2Key = `${prefix}/problem.pdf`;
    const solutionR2Key = `${prefix}/solution.pdf`;
    mkdirSync(join(files.dataDir, "files", prefix), { recursive: true });
    writeFileSync(join(files.dataDir, "files", problemR2Key), problemBytes);
    writeFileSync(join(files.dataDir, "files", solutionR2Key), solutionBytes);
    db.prepare("UPDATE book_files SET r2_key = ?, content_hash = ?, page_count = 12 WHERE r2_key = ?")
      .run(problemR2Key, Q11_SCOPE_SPEC.sourceHash, target.problemR2Key);
    db.prepare("UPDATE book_files SET r2_key = ?, content_hash = ?, page_count = 5 WHERE r2_key = ?")
      .run(solutionR2Key, Q11_SCOPE_SPEC.solutionSourceHash, target.solutionR2Key);
    target.problemR2Key = problemR2Key;
    target.solutionR2Key = solutionR2Key;
  }
  db.close();
  writeJson(receiptPath, receipt);
}

function prepareRepairScopeFixture(
  files: ReturnType<typeof fixture>,
  spec: (typeof PROBLEM_REPAIR_SCOPE_ADJUDICATION_ALLOWLIST)[number]
    | (typeof PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_ALLOWLIST)[number],
): void {
  const officialState = REPAIR_SCOPE_STATES.get(spec.entryId);
  if (!officialState) throw new Error(`missing repair-scope fixture state for ${spec.entryId}`);
  const oldStateDir = files.stateDirs.math;
  const entryState = JSON.parse(readFileSync(join(oldStateDir, "entry.json"), "utf8"));
  const oldEntryId = entryState.entry.id;
  const officialEntry = JSON.parse(readFileSync(join(officialState, "entry.json"), "utf8")).entry;
  const officialDownloads = JSON.parse(readFileSync(join(officialState, "downloads.json"), "utf8"));
  Object.assign(entryState.entry, {
    id: spec.entryId,
    paperId: officialEntry.paperId,
    sourcePageUrl: officialEntry.sourcePageUrl,
    problemPdfUrl: officialDownloads.problem.requestedUrl,
    solutionPdfUrl: officialDownloads.solution.requestedUrl,
  });
  const stateDir = join(files.dataDir, "import-exam-corpus", token(spec.entryId, 24));
  renameSync(oldStateDir, stateDir);
  files.stateDirs.math = stateDir;
  writeJson(join(stateDir, "entry.json"), entryState);

  const manifest = JSON.parse(readFileSync(files.manifestPath, "utf8"));
  Object.assign(manifest.entries.find((entry: { id: string }) => entry.id === oldEntryId), entryState.entry);
  writeJson(files.manifestPath, manifest);

  const problemBytes = readFileSync(join(officialState, "problem.pdf"));
  const solutionBytes = readFileSync(join(officialState, "solution.pdf"));
  expect(hash(problemBytes)).toBe(spec.sourceHash);
  expect(hash(solutionBytes)).toBe(spec.solutionSourceHash);
  writeFileSync(join(stateDir, "problem.pdf"), problemBytes);
  writeFileSync(join(stateDir, "solution.pdf"), solutionBytes);
  writeJson(join(stateDir, "downloads.json"), {
    version: 2,
    problem: { ...officialDownloads.problem, path: "problem.pdf" },
    solution: { ...officialDownloads.solution, path: "solution.pdf" },
  });

  const solutionChunkDir = join(stateDir, "solution-chunks");
  const syntheticItems = readdirSync(solutionChunkDir)
    .filter((name) => /^v3-\d{4}\.json$/u.test(name))
    .sort()
    .flatMap((name) => JSON.parse(readFileSync(join(solutionChunkDir, name), "utf8")).items)
    .sort((left: { number: string }, right: { number: string }) => Number(left.number) - Number(right.number));
  const officialCheckpoint = JSON.parse(readFileSync(
    join(officialState, "solution-chunks", "v3-0000.json"),
    "utf8",
  ));
  const printedNumber = spec.key.split(":")[1];
  const officialItem = officialCheckpoint.items.find(
    (item: { number: string }) => item.number === printedNumber,
  );
  const solutionCheckpointPath = join(solutionChunkDir, "v3-0000.json");
  const solutionCheckpoint = JSON.parse(readFileSync(solutionCheckpointPath, "utf8"));
  Object.assign(solutionCheckpoint, {
    sourceHash: spec.solutionSourceHash,
    from: 1,
    to: 4,
    ownedFrom: 1,
    ownedTo: 4,
    items: syntheticItems.map((item: Record<string, unknown>) => ({
      ...item,
      ...(item.number === printedNumber ? officialItem : {}),
      page: item.number === printedNumber ? officialItem.page : (Number(item.number) - 1) % 4 + 1,
    })),
  });
  writeJson(solutionCheckpointPath, solutionCheckpoint);
  for (const name of readdirSync(solutionChunkDir)) {
    if (/^v3-(?!0000)\d{4}\.json$/u.test(name)) rmSync(join(solutionChunkDir, name));
  }

  const receiptPath = join(stateDir, "receipt.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  receipt.entryId = spec.entryId;
  receipt.problemHash = spec.sourceHash;
  receipt.solutionHash = spec.solutionSourceHash;
  const db = new Database(files.dbPath);
  for (const target of receipt.targetBooks as Array<{
    subject: Target;
    problemR2Key: string;
    solutionR2Key: string;
  }>) {
    const prefix = `corpus/${token(spec.entryId, 24)}/${token(target.subject, 16)}`;
    const problemR2Key = `${prefix}/problem.pdf`;
    const solutionR2Key = `${prefix}/solution.pdf`;
    mkdirSync(join(files.dataDir, "files", prefix), { recursive: true });
    writeFileSync(join(files.dataDir, "files", problemR2Key), problemBytes);
    writeFileSync(join(files.dataDir, "files", solutionR2Key), solutionBytes);
    db.prepare("UPDATE book_files SET r2_key = ?, content_hash = ?, page_count = 12 WHERE r2_key = ?")
      .run(problemR2Key, spec.sourceHash, target.problemR2Key);
    db.prepare("UPDATE book_files SET r2_key = ?, content_hash = ?, page_count = 4 WHERE r2_key = ?")
      .run(solutionR2Key, spec.solutionSourceHash, target.solutionR2Key);
    target.problemR2Key = problemR2Key;
    target.solutionR2Key = solutionR2Key;
  }
  db.close();
  writeJson(receiptPath, receipt);
}

function prepareSolutionPromptUpgradeFixture(files: ReturnType<typeof fixture>): void {
  const oldStateDir = files.stateDirs.math;
  const entryState = JSON.parse(readFileSync(join(oldStateDir, "entry.json"), "utf8"));
  const oldEntryId = entryState.entry.id;
  const officialEntry = JSON.parse(readFileSync(
    join(SOLUTION_PROMPT_UPGRADE_STATE, "entry.json"),
    "utf8",
  )).entry;
  const officialDownloads = JSON.parse(readFileSync(
    join(SOLUTION_PROMPT_UPGRADE_STATE, "downloads.json"),
    "utf8",
  ));
  Object.assign(entryState.entry, {
    id: SOLUTION_PROMPT_UPGRADE_SPEC.entryId,
    paperId: officialEntry.paperId,
    sourcePageUrl: officialEntry.sourcePageUrl,
    problemPdfUrl: officialDownloads.problem.requestedUrl,
    solutionPdfUrl: officialDownloads.solution.requestedUrl,
  });
  const stateDir = join(
    files.dataDir,
    "import-exam-corpus",
    token(SOLUTION_PROMPT_UPGRADE_SPEC.entryId, 24),
  );
  renameSync(oldStateDir, stateDir);
  files.stateDirs.math = stateDir;
  writeJson(join(stateDir, "entry.json"), entryState);
  const manifest = JSON.parse(readFileSync(files.manifestPath, "utf8"));
  Object.assign(manifest.entries.find((entry: { id: string }) => entry.id === oldEntryId), entryState.entry);
  writeJson(files.manifestPath, manifest);

  const problemBytes = readFileSync(join(SOLUTION_PROMPT_UPGRADE_STATE, "problem.pdf"));
  const solutionBytes = readFileSync(join(SOLUTION_PROMPT_UPGRADE_STATE, "solution.pdf"));
  expect(hash(solutionBytes)).toBe(SOLUTION_PROMPT_UPGRADE_SPEC.sourceHash);
  writeFileSync(join(stateDir, "problem.pdf"), problemBytes);
  writeFileSync(join(stateDir, "solution.pdf"), solutionBytes);
  writeJson(join(stateDir, "downloads.json"), {
    version: 2,
    problem: { ...officialDownloads.problem, path: "problem.pdf" },
    solution: { ...officialDownloads.solution, path: "solution.pdf" },
  });

  const officialProblem = JSON.parse(readFileSync(
    join(SOLUTION_PROMPT_UPGRADE_STATE, "problem-chunks", "v2-0000.json"),
    "utf8",
  ));
  const problemPath = join(stateDir, "problem-chunks", "v2-0000.json");
  const problemCheckpoint = JSON.parse(readFileSync(problemPath, "utf8"));
  Object.assign(problemCheckpoint, {
    sourceHash: officialDownloads.problem.sha256,
    from: 1,
    to: 12,
    ownedFrom: 1,
    ownedTo: 12,
  });
  problemCheckpoint.items[0] = officialProblem.items[0];
  problemCheckpoint.items[1] = officialProblem.items[1];
  writeJson(problemPath, problemCheckpoint);

  const officialSolution = JSON.parse(readFileSync(
    join(SOLUTION_PROMPT_UPGRADE_STATE, "solution-chunks", "v3-0000.json"),
    "utf8",
  ));
  const solutionDir = join(stateDir, "solution-chunks");
  const solutionPath = join(solutionDir, "v3-0000.json");
  writeJson(solutionPath, officialSolution);
  for (const name of readdirSync(solutionDir)) {
    if (/^v3-(?!0000)\d{4}\.json$/u.test(name)) rmSync(join(solutionDir, name));
  }

  const receiptPath = join(stateDir, "receipt.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  receipt.entryId = SOLUTION_PROMPT_UPGRADE_SPEC.entryId;
  receipt.problemHash = officialDownloads.problem.sha256;
  receipt.solutionHash = officialDownloads.solution.sha256;
  const db = new Database(files.dbPath);
  for (const target of receipt.targetBooks as Array<{
    subject: Target;
    problemR2Key: string;
    solutionR2Key: string;
  }>) {
    const prefix = `corpus/${token(SOLUTION_PROMPT_UPGRADE_SPEC.entryId, 24)}/${token(target.subject, 16)}`;
    const problemR2Key = `${prefix}/problem.pdf`;
    const solutionR2Key = `${prefix}/solution.pdf`;
    mkdirSync(join(files.dataDir, "files", prefix), { recursive: true });
    writeFileSync(join(files.dataDir, "files", problemR2Key), problemBytes);
    writeFileSync(join(files.dataDir, "files", solutionR2Key), solutionBytes);
    db.prepare("UPDATE book_files SET r2_key = ?, content_hash = ?, page_count = 12 WHERE r2_key = ?")
      .run(problemR2Key, officialDownloads.problem.sha256, target.problemR2Key);
    db.prepare("UPDATE book_files SET r2_key = ?, content_hash = ?, page_count = 4 WHERE r2_key = ?")
      .run(solutionR2Key, officialDownloads.solution.sha256, target.solutionR2Key);
    target.problemR2Key = problemR2Key;
    target.solutionR2Key = solutionR2Key;
  }
  for (const [index, rawAnswer] of ["②", "⑤"].entries()) {
    const problem = officialProblem.items[index];
    const printedNumber = String(index + 1);
    db.prepare(
      "UPDATE questions SET qtype = ?, difficulty = ?, question = ?, choices = ?, answer = ? " +
      "WHERE printed_number = ? AND book_id IN (SELECT id FROM books WHERE title = ?)",
    ).run(
      problem.qtype,
      problem.difficulty,
      problem.question,
      JSON.stringify(problem.choices),
      rawAnswer,
      printedNumber,
      "2025년 · 2025 수능 수학 미적분",
    );
    db.prepare(
      "UPDATE book_items SET answer = ?, content = ? WHERE category = '문제' AND number = ? " +
      "AND book_id IN (SELECT id FROM books WHERE title = ?)",
    ).run(rawAnswer, problem.question, printedNumber, "2025년 · 2025 수능 수학 미적분");
  }
  db.close();
  writeJson(receiptPath, receipt);
}

function prepareManualFixture(
  files: ReturnType<typeof fixture>,
  id: keyof ReturnType<typeof fixture>["stateDirs"],
  spec: typeof Q30_MANUAL_SPEC,
  officialState: string,
): void {
  const oldStateDir = files.stateDirs[id];
  const entryState = JSON.parse(readFileSync(join(oldStateDir, "entry.json"), "utf8"));
  const oldEntryId = entryState.entry.id;
  const officialEntry = JSON.parse(readFileSync(join(officialState, "entry.json"), "utf8")).entry;
  const officialDownloads = JSON.parse(readFileSync(join(officialState, "downloads.json"), "utf8"));
  Object.assign(entryState.entry, {
    id: spec.entryId,
    paperId: officialEntry.paperId,
    sourcePageUrl: officialEntry.sourcePageUrl,
    problemPdfUrl: officialDownloads.problem.requestedUrl,
  });
  const stateDir = join(files.dataDir, "import-exam-corpus", token(spec.entryId, 24));
  renameSync(oldStateDir, stateDir);
  files.stateDirs[id] = stateDir;
  writeJson(join(stateDir, "entry.json"), entryState);

  const manifest = JSON.parse(readFileSync(files.manifestPath, "utf8"));
  const manifestEntry = manifest.entries.find((entry: { id: string }) => entry.id === oldEntryId);
  Object.assign(manifestEntry, entryState.entry);
  writeJson(files.manifestPath, manifest);

  const problemBytes = readFileSync(join(officialState, "problem.pdf"));
  expect(hash(problemBytes)).toBe(spec.sourceHash);
  writeFileSync(join(stateDir, "problem.pdf"), problemBytes);
  const downloads = JSON.parse(readFileSync(join(stateDir, "downloads.json"), "utf8"));
  downloads.problem = { ...officialDownloads.problem, path: "problem.pdf" };
  writeJson(join(stateDir, "downloads.json"), downloads);

  const receiptPath = join(stateDir, "receipt.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  receipt.entryId = spec.entryId;
  receipt.problemHash = spec.sourceHash;
  const solutionBytes = readFileSync(join(stateDir, "solution.pdf"));
  const db = new Database(files.dbPath);
  for (const target of receipt.targetBooks as Array<{
    subject: Target;
    problemR2Key: string;
    solutionR2Key: string;
  }>) {
    const prefix = `corpus/${token(spec.entryId, 24)}/${token(target.subject, 16)}`;
    const problemR2Key = `${prefix}/problem.pdf`;
    const solutionR2Key = `${prefix}/solution.pdf`;
    mkdirSync(join(files.dataDir, "files", prefix), { recursive: true });
    writeFileSync(join(files.dataDir, "files", problemR2Key), problemBytes);
    writeFileSync(join(files.dataDir, "files", solutionR2Key), solutionBytes);
    db.prepare("UPDATE book_files SET r2_key = ?, content_hash = ?, page_count = ? WHERE r2_key = ?")
      .run(problemR2Key, spec.sourceHash, officialDownloads.problem.pageCount, target.problemR2Key);
    db.prepare("UPDATE book_files SET r2_key = ? WHERE r2_key = ?")
      .run(solutionR2Key, target.solutionR2Key);
    target.problemR2Key = problemR2Key;
    target.solutionR2Key = solutionR2Key;
  }
  db.close();
  writeJson(receiptPath, receipt);
}

function prepareQ30ManualFixture(files: ReturnType<typeof fixture>): void {
  prepareManualFixture(files, "korean", Q30_MANUAL_SPEC, Q30_MANUAL_STATE);
}

function targetForCanonical(canonical: string): Target {
  const target = new Map<string, Target>([
    ["math_A", "수학 - 수학Ⅱ·미적분Ⅰ"],
    ["math_B", "수학 - 수학Ⅰ·대수"],
    ["integrated_science", "과학 - 통합과학 (2022 개정)"],
    ["integrated_social", "사회 - 통합사회 (2022 개정)"],
    ["korean_reading", "국어 - 독서"],
    ["korean_literature", "국어 - 문학"],
  ]).get(canonical);
  if (!target) throw new Error(`unsupported canonical subject ${canonical}`);
  return target;
}

function installRevisionScopeFixture(
  files: ReturnType<typeof fixture>,
  testCase: (typeof REVISION_SCOPE_CASES)[number],
): { childArtifact: string; stateDir: string } {
  const priorStateDir = files.stateDirs[testCase.id];
  const priorEntry = JSON.parse(readFileSync(join(priorStateDir, "entry.json"), "utf8")).entry;
  const priorReceipt = JSON.parse(readFileSync(join(priorStateDir, "receipt.json"), "utf8"));
  const entry = JSON.parse(readFileSync(join(testCase.stateDir, "entry.json"), "utf8")).entry;
  const downloads = JSON.parse(readFileSync(join(testCase.stateDir, "downloads.json"), "utf8"));
  const stateDir = join(files.dataDir, "import-exam-corpus", token(entry.id, 24));
  rmSync(priorStateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  files.stateDirs[testCase.id] = stateDir;
  writeJson(join(stateDir, "entry.json"), { schemaVersion: 2, entry });
  writeJson(join(stateDir, "downloads.json"), downloads);
  const copy = (relativePath: string): void => {
    const target = join(stateDir, relativePath);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, readFileSync(join(testCase.stateDir, relativePath)));
  };
  for (const relativePath of [
    "problem.pdf",
    "solution.pdf",
    "problem-chunks/v2-0000.json",
    `classification-chunks/v5-0000-${DIGEST}.json`,
    "solution-chunks/v3-0000.json",
    ...testCase.firstPairs.flat(),
    ...testCase.revisionProblems,
    testCase.revisionClassification,
    ...testCase.supportingTerminals,
    testCase.triggerTerminal,
  ]) copy(relativePath);

  const manifest = JSON.parse(readFileSync(files.manifestPath, "utf8"));
  Object.assign(manifest.entries.find((value: { id: string }) => value.id === priorEntry.id), entry);
  writeJson(files.manifestPath, manifest);

  const problemPath = join(stateDir, "problem-chunks/v2-0000.json");
  const classificationPath = join(stateDir, `classification-chunks/v5-0000-${DIGEST}.json`);
  const solutionPath = join(stateDir, "solution-chunks/v3-0000.json");
  const problemCheckpoint = JSON.parse(readFileSync(problemPath, "utf8"));
  const classificationCheckpoint = JSON.parse(readFileSync(classificationPath, "utf8"));
  const solutionCheckpoint = JSON.parse(readFileSync(solutionPath, "utf8"));
  const effectiveQuestions: Array<Record<string, any>> = problemCheckpoint.items.map(
    (value: Record<string, any>) => structuredClone(value),
  );
  const effectiveClassifications: Array<Record<string, any>> = classificationCheckpoint.items.map(
    (value: Record<string, any>) => structuredClone(value),
  );
  const indexByKey = new Map<string, number>(effectiveQuestions.map((question, index) => [
    `${question.page}:${Number(question.number)}`,
    index,
  ]));
  const solutionByNumber = new Map<string, Record<string, any>>(solutionCheckpoint.items.map(
    (solution: Record<string, any>) => [
    String(Number(solution.number)),
    solution,
  ]));
  const firstRows = new Map<string, Record<string, any>>();
  for (const [problemRelativePath, classificationRelativePath] of testCase.firstPairs) {
    const problemBatch = JSON.parse(readFileSync(join(stateDir, problemRelativePath), "utf8"));
    const classificationBatch = JSON.parse(readFileSync(join(stateDir, classificationRelativePath), "utf8"));
    const problemArtifact = { path: problemRelativePath, sha256: hash(readFileSync(join(stateDir, problemRelativePath))) };
    const classificationPointer = {
      path: classificationRelativePath,
      sha256: hash(readFileSync(join(stateDir, classificationRelativePath))),
    };
    for (const member of problemBatch.members as Array<Record<string, any>>) {
      const question = problemBatch.items.find((value: Record<string, any>) =>
        `${value.page}:${Number(value.number)}` === member.key)!;
      const classification = classificationBatch.items.find((value: { key: string }) => value.key === member.key)!;
      const row = {
        key: member.key,
        printedNumber: member.printedNumber,
        sourcePage: member.sourcePage,
        contextFrom: problemBatch.contextFrom,
        contextTo: problemBatch.contextTo,
        baseProblemCheckpoint: member.baseProblemCheckpoint,
        baseClassificationCheckpoint: member.baseClassificationCheckpoint,
        baseSolutionCheckpoint: member.baseSolutionCheckpoint,
        problemArtifact,
        problemArtifactItemHash: canonicalEvidenceHash(question),
        classificationArtifact: {
          ...classificationPointer,
          rulesDigest: DIGEST,
          transcriptionGateVersion: 2,
          transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
        },
        classificationArtifactItemHash: canonicalEvidenceHash(classification),
        baseQuestionHash: member.baseQuestionHash,
        effectiveQuestionHash: canonicalEvidenceHash(question),
        baseClassificationHash: member.baseClassificationHash,
        effectiveClassificationHash: canonicalEvidenceHash(classification),
        baseSolutionItemHash: member.baseSolutionItemHash,
        officialRawAnswerHash: member.officialRawAnswerHash,
      };
      firstRows.set(member.key, row);
      const index = indexByKey.get(member.key)!;
      effectiveQuestions[index] = structuredClone(question);
      effectiveClassifications[index] = structuredClone(classification);
    }
  }

  const revisionClassification = JSON.parse(readFileSync(
    join(stateDir, testCase.revisionClassification),
    "utf8",
  ));
  const revisionClassificationPointer = {
    path: testCase.revisionClassification,
    sha256: hash(readFileSync(join(stateDir, testCase.revisionClassification))),
  };
  for (const problemRelativePath of testCase.revisionProblems) {
    const problemRevision = JSON.parse(readFileSync(join(stateDir, problemRelativePath), "utf8"));
    const problemPointer = {
      path: problemRelativePath,
      sha256: hash(readFileSync(join(stateDir, problemRelativePath))),
    };
    for (const member of problemRevision.members as Array<Record<string, any>>) {
      const first = firstRows.get(member.key)!;
      const question = problemRevision.items.find((value: Record<string, any>) =>
        `${value.page}:${Number(value.number)}` === member.key)!;
      const classification = revisionClassification.items.find(
        (value: { key: string }) => value.key === member.key,
      )!;
      const revision = {
        baseProblemRepairArtifact: first.problemArtifact,
        baseClassificationRepairArtifact: {
          path: first.classificationArtifact.path,
          sha256: first.classificationArtifact.sha256,
        },
        problemArtifact: problemPointer,
        classificationArtifact: {
          ...revisionClassificationPointer,
          rulesDigest: DIGEST,
          transcriptionGateVersion: 2,
          transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
        },
        diagnosticEvidenceHash: member.trigger.evidenceHash,
        baseQuestionHash: canonicalEvidenceHash(effectiveQuestions[indexByKey.get(member.key)!]),
        effectiveQuestionHash: canonicalEvidenceHash(question),
        baseClassificationHash: canonicalEvidenceHash(effectiveClassifications[indexByKey.get(member.key)!]),
        effectiveClassificationHash: canonicalEvidenceHash(classification),
        problemArtifactItemHash: canonicalEvidenceHash(question),
        classificationArtifactItemHash: canonicalEvidenceHash(classification),
        trigger: member.trigger,
      };
      first.revision = revision;
      const index = indexByKey.get(member.key)!;
      effectiveQuestions[index] = structuredClone(question);
      effectiveClassifications[index] = structuredClone(classification);
    }
  }

  const targetFirst = firstRows.get(testCase.spec.key)!;
  const targetRevision = targetFirst.revision as Record<string, any>;
  const terminalCheckpoint = JSON.parse(readFileSync(join(stateDir, testCase.triggerTerminal), "utf8"));
  const terminalPointer = {
    path: testCase.triggerTerminal,
    sha256: hash(readFileSync(join(stateDir, testCase.triggerTerminal))),
    from: terminalCheckpoint.from,
    to: terminalCheckpoint.to,
    ownedFrom: terminalCheckpoint.ownedFrom,
    ownedTo: terminalCheckpoint.ownedTo,
    inputHash: terminalCheckpoint.inputHash,
  };
  const terminalItem = terminalCheckpoint.items.find((value: { key: string }) => value.key === testCase.spec.key)!;
  const trigger = {
    terminalCheckpoint: terminalPointer,
    terminalItemHash: canonicalEvidenceHash(terminalItem),
    terminalItem,
    evidenceHash: hash(terminalItem.evidence),
    scopeEvidenceHash: hash(terminalItem.scopeEvidence),
    preAdjudicationEffectiveCorpusHash: terminalCheckpoint.effectiveCorpusHash,
  };
  const targetIndex = indexByKey.get(testCase.spec.key)!;
  const targetQuestion = effectiveQuestions[targetIndex];
  const targetClassification = effectiveClassifications[targetIndex];
  const targetSolution = solutionByNumber.get(String(Number(targetQuestion.number)))!;
  const baseSolutionCheckpoint = {
    path: "solution-chunks/v3-0000.json",
    sha256: hash(readFileSync(solutionPath)),
  };
  const parentRevisionEvidenceHash = canonicalEvidenceHash(targetRevision);
  const parentRepair = structuredClone(targetFirst);
  const parentRepairEvidenceHash = canonicalEvidenceHash(parentRepair);
  const basis = {
    allowlistId: testCase.spec.allowlistId,
    entryId: entry.id,
    key: testCase.spec.key,
    printedNumber: targetFirst.printedNumber,
    sourcePage: testCase.spec.sourcePage,
    sourceHash: downloads.problem.sha256,
    solutionSourceHash: downloads.solution.sha256,
    problemContextFrom: targetFirst.contextFrom,
    problemContextTo: targetFirst.contextTo,
    solutionContextFrom: solutionCheckpoint.from,
    solutionContextTo: solutionCheckpoint.to,
    baseSolutionCheckpoint,
    baseSolutionItemHash: canonicalEvidenceHash(targetSolution),
    parentRepair,
    parentRepairEvidenceHash,
    parentRevisionEvidenceHash,
    trigger,
    baseQuestionHash: canonicalEvidenceHash(targetQuestion),
    baseClassificationHash: canonicalEvidenceHash(targetClassification),
  };
  const basisDigest = canonicalEvidenceHash(basis);
  const childRelativePath = `classification-revision-scope-adjudications/v1-` +
    `${String(testCase.spec.sourcePage).padStart(4, "0")}-` +
    `${targetFirst.printedNumber.padStart(4, "0")}-${basisDigest}-${DIGEST}.json`;
  const childClassification = {
    ...targetClassification,
    decision: "reject",
    canonical_subject: null,
    curriculum_course: null,
    domain: null,
    achievement_codes: [],
    confidence: 0.99,
    reason_codes: ["EXCLUDED_OUTSIDE_TARGET_CURRICULUM"],
    transcription_status: "exact",
    transcription_evidence: "the official problem transcription remains exact",
  };
  const childHash = writeEvidence(join(stateDir, childRelativePath), {
    version: 1,
    entryId: entry.id,
    basisDigest,
    basis,
    classifierVersion: 5,
    rulesDigest: DIGEST,
    transcriptionGateVersion: 2,
    transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
    adjudicationPromptVersion: 1,
    adjudicationPromptDigest: PROBLEM_REVISION_SCOPE_ADJUDICATION_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    items: [childClassification],
  });
  const childEvidence = {
    allowlistId: testCase.spec.allowlistId,
    key: testCase.spec.key,
    printedNumber: targetFirst.printedNumber,
    sourcePage: testCase.spec.sourcePage,
    sourceHash: downloads.problem.sha256,
    solutionSourceHash: downloads.solution.sha256,
    problemContextFrom: targetFirst.contextFrom,
    problemContextTo: targetFirst.contextTo,
    solutionContextFrom: solutionCheckpoint.from,
    solutionContextTo: solutionCheckpoint.to,
    baseSolutionCheckpoint,
    baseSolutionItemHash: canonicalEvidenceHash(targetSolution),
    parentRepairEvidenceHash,
    parentRevisionEvidenceHash,
    trigger,
    classificationArtifact: {
      path: childRelativePath,
      sha256: childHash,
      rulesDigest: DIGEST,
      transcriptionGateVersion: 2,
      transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
      adjudicationPromptVersion: 1,
      adjudicationPromptDigest: PROBLEM_REVISION_SCOPE_ADJUDICATION_PROMPT_DIGEST,
    },
    classificationArtifactItemHash: canonicalEvidenceHash(childClassification),
    baseQuestionHash: canonicalEvidenceHash(targetQuestion),
    effectiveQuestionHash: canonicalEvidenceHash(targetQuestion),
    baseClassificationHash: canonicalEvidenceHash(targetClassification),
    effectiveClassificationHash: canonicalEvidenceHash(childClassification),
  };
  targetRevision.scopeAdjudication = childEvidence;
  effectiveClassifications[targetIndex] = childClassification;

  const classified: Array<{ question: Record<string, any>; classification: Record<string, any> }> =
    effectiveQuestions.map((question, index) => ({
    question,
    classification: effectiveClassifications[index],
  })).sort((left, right) => Number(left.question.page) - Number(right.question.page)
    || Number(left.question.number) - Number(right.question.number));
  const effectiveCorpusHash = canonicalEvidenceHash(classified);
  const terminalInputs = classified.map(({ question }) => ({
    key: `${question.page}:${Number(question.number)}`,
    printed_number: String(Number(question.number)),
    source_page: question.page,
    qtype: question.qtype,
    question: question.question,
    choices: question.choices,
    figure: question.figure,
    figure_description: question.figure_description,
    box: question.box,
  }));
  const terminalItems = classified.map(({ question, classification }) => ({
    key: `${question.page}:${Number(question.number)}`,
    status: classification.transcription_status === "exact" ? "exact" : "mismatch",
    evidence: classification.transcription_status === "exact"
      ? "the final transcription exactly matches every official source pixel"
      : "the independent terminal check confirms this rejected transcription mismatch",
    scopeDecision: classification.decision,
    scopeConfidence: 0.99,
    scopeEvidence: "the official source independently establishes the final curriculum scope",
  })).sort((left, right) => compareCorpusQuestionKeys(left.key, right.key));
  const terminalInputHash = canonicalEvidenceHash(terminalInputs);
  const terminalRelativePath = `problem-terminal-fidelity/v2-0000-${effectiveCorpusHash}-${terminalInputHash}.json`;
  const terminalHash = writeEvidence(join(stateDir, terminalRelativePath), {
    version: 2,
    entryId: entry.id,
    sourceHash: downloads.problem.sha256,
    from: 1,
    to: downloads.problem.pageCount,
    ownedFrom: 1,
    ownedTo: downloads.problem.pageCount,
    effectiveCorpusHash,
    inputHash: terminalInputHash,
    transcriptionGateVersion: 2,
    transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
    rulesDigest: DIGEST,
    scopePromptDigest: PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    inputs: terminalInputs,
    items: terminalItems,
  });
  const finalTerminalPointer = {
    path: terminalRelativePath,
    sha256: terminalHash,
    from: 1,
    to: downloads.problem.pageCount,
    ownedFrom: 1,
    ownedTo: downloads.problem.pageCount,
    inputHash: terminalInputHash,
  };

  const accepted = classified.filter(({ classification }) => classification.decision === "accept");
  const solutionInputs = accepted.map(({ question, classification }) => {
    const solution = solutionByNumber.get(String(Number(question.number)))!;
    const allowDerivedMarkerAnswer = question.qtype === "mcq"
      && resolveOfficialAnswer(question as any, solution.answer).mode === "choice-marker";
    return {
      key: classification.key,
      printedNumber: String(Number(question.number)),
      qtype: question.qtype,
      allowDerivedMarkerAnswer,
      sourcePage: solution.page,
      rawAnswer: solution.answer,
      explanation: solution.explanation,
      complete: true,
      baseSolutionCheckpoint,
      baseSolutionItemHash: canonicalEvidenceHash(solution),
      baseContextFrom: solutionCheckpoint.from,
      baseContextTo: solutionCheckpoint.to,
      baseOwnedFrom: solutionCheckpoint.ownedFrom,
      baseOwnedTo: solutionCheckpoint.ownedTo,
    };
  });
  const solutionDecisions = solutionInputs.map((input) => ({
    key: input.key,
    sourcePage: input.sourcePage,
    answerStatus: "exact",
    explanationStatus: "exact",
    evidence: "the explicit answer and complete explanation match the official solution pixels",
  }));
  const solutionInputHash = canonicalEvidenceHash(solutionInputs);
  const fidelityRelativePath = `solution-fidelity/v1-0000-${effectiveCorpusHash}-${solutionInputHash}.json`;
  const fidelityHash = writeEvidence(join(stateDir, fidelityRelativePath), {
    version: 1,
    entryId: entry.id,
    sourceHash: downloads.solution.sha256,
    from: solutionCheckpoint.from,
    to: solutionCheckpoint.to,
    ownedFrom: solutionCheckpoint.ownedFrom,
    ownedTo: solutionCheckpoint.ownedTo,
    classifierVersion: 5,
    rulesDigest: DIGEST,
    transcriptionGateVersion: 2,
    transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
    effectiveProblemCorpusHash: effectiveCorpusHash,
    inputHash: solutionInputHash,
    promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    inputs: solutionInputs,
    items: solutionDecisions,
  });
  const solutionFidelityCheckpoints = [{
    path: fidelityRelativePath,
    sha256: fidelityHash,
    from: solutionCheckpoint.from,
    to: solutionCheckpoint.to,
    ownedFrom: solutionCheckpoint.ownedFrom,
    ownedTo: solutionCheckpoint.ownedTo,
    inputHash: solutionInputHash,
  }];
  const solutionFidelityItems = solutionInputs.map((input, index) => ({
    key: input.key,
    printedNumber: input.printedNumber,
    qtype: input.qtype,
    basePage: input.sourcePage,
    effectivePage: input.sourcePage,
    answerStatus: "exact",
    explanationStatus: "exact",
    evidence: solutionDecisions[index].evidence,
    fidelityArtifact: { path: fidelityRelativePath, sha256: fidelityHash },
    baseSolutionItemHash: input.baseSolutionItemHash,
    effectiveSolutionItemHash: input.baseSolutionItemHash,
    baseRawAnswerHash: hash(input.rawAnswer),
    effectiveRawAnswerHash: hash(input.rawAnswer),
    baseExplanationHash: hash(input.explanation),
    effectiveExplanationHash: hash(input.explanation),
  })).sort((left, right) => compareCorpusQuestionKeys(left.key, right.key));
  const effectiveSolutionCorpusHash = canonicalEvidenceHash(solutionInputs.map((input) => ({
    key: input.key,
    solution: solutionByNumber.get(input.printedNumber),
  })).sort((left, right) => compareCorpusQuestionKeys(left.key, right.key)));
  const markerInputs: Array<{ key: string; choices: string[]; detailedExplanation: string }> = [];
  const auditItems = accepted.flatMap(({ question, classification }) => {
    if (question.qtype !== "mcq") return [];
    const solution = solutionByNumber.get(String(Number(question.number)))!;
    const resolution = resolveOfficialAnswer(question as any, solution.answer);
    const semantic = resolution.mode === "choice-marker" ? {
      status: "resolved" as const,
      choiceIndex: resolution.choiceIndex! + 1,
      evidence: "the official explanation resolves this one answer choice",
    } : null;
    if (semantic) markerInputs.push({
      key: classification.key,
      choices: question.choices,
      detailedExplanation: redactedExplanation(solution.explanation),
    });
    return [{
      key: classification.key,
      printedNumber: String(Number(question.number)),
      sourcePage: question.page,
      officialRawAnswerHash: hash(solution.answer),
      storedAnswerHash: hash(resolution.storedAnswer),
      mode: resolution.mode,
      choiceIndex: resolution.choiceIndex! + 1,
      semantic,
    }];
  }).sort((left, right) => compareCorpusQuestionKeys(left.key, right.key));
  const semanticCheckpoint = markerInputs.length === 0 ? null : (() => {
    const inputHash = canonicalEvidenceHash(markerInputs);
    const items = markerInputs.map((input) => ({
      key: input.key,
      ...auditItems.find((item) => item.key === input.key)!.semantic!,
    }));
    const relativePath = `semantic-choice-checks/v5-${effectiveCorpusHash}-` +
      `${effectiveSolutionCorpusHash}-${inputHash}.json`;
    return {
      path: relativePath,
      sha256: writeEvidence(join(stateDir, relativePath), {
        version: 5,
        entryId: entry.id,
        problemHash: downloads.problem.sha256,
        solutionHash: downloads.solution.sha256,
        classifierVersion: 5,
        rulesDigest: DIGEST,
        transcriptionGateVersion: 2,
        transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
        effectiveCorpusHash,
        effectiveSolutionCorpusHash,
        inputHash,
        promptDigest: V5_SEMANTIC_PROMPT_DIGEST,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        inputs: markerInputs,
        items,
      }),
      inputHash,
      effectiveCorpusHash,
      effectiveSolutionCorpusHash,
    };
  })();
  const targetQuestionCounts = Object.fromEntries(accepted.reduce((counts, value) => {
    const target = targetForCanonical(value.classification.canonical_subject);
    counts.set(target, (counts.get(target) ?? 0) + 1);
    return counts;
  }, new Map<Target, number>()));
  const repairs = [...firstRows.values()].sort((left, right) => compareCorpusQuestionKeys(left.key, right.key));
  const auditBasis = {
    entryId: entry.id,
    problemHash: downloads.problem.sha256,
    solutionHash: downloads.solution.sha256,
    classifierVersion: 5,
    rulesDigest: DIGEST,
    transcriptionGateVersion: 2,
    transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
    solutionFidelityVersion: 1,
    solutionFidelityPromptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    problemTerminalFidelityVersion: 2,
    problemTerminalScopePromptDigest: PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST,
    semanticChoiceVersion: 5,
    semanticPromptDigest: V5_SEMANTIC_PROMPT_DIGEST,
    sourceQuestionCount: classified.length,
    acceptedQuestionCount: accepted.length,
    rejectedQuestionCount: classified.length - accepted.length,
    reviewQuestionCount: 0,
    targetQuestionCounts,
    acceptedSolutionKeys: solutionFidelityItems.map((item) => item.key),
    solutionRepairKeys: [],
    derivedAnswerKeys: [],
    acceptedMcqKeys: auditItems.map((item) => item.key),
    effectiveCorpusHash,
    effectiveSolutionCorpusHash,
    solutionFidelityCheckpoints,
    solutionFidelityItems,
    solutionRepairs: [],
    problemTerminalFidelityCheckpoints: [finalTerminalPointer],
    problemTerminalFidelityItems: terminalItems,
    semanticCheckpoint,
    repairs,
    items: auditItems,
  };
  const auditDigest = canonicalEvidenceHash(auditBasis);
  const auditRelativePath = `answer-audit/v5-${auditDigest}.json`;
  const auditHash = writeEvidence(join(stateDir, auditRelativePath), { version: 5, auditDigest, ...auditBasis });

  const displayTitle = `${entry.sourceRecordYear}년 · ${entry.rawTitle}`;
  const problemBytes = readFileSync(join(stateDir, "problem.pdf"));
  const solutionBytes = readFileSync(join(stateDir, "solution.pdf"));
  const db = new Database(files.dbPath);
  const targetBooks: Array<Record<string, unknown>> = [];
  let nextQuestionId = (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM questions").get() as { id: number }).id;
  let nextItemId = (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM book_items").get() as { id: number }).id;
  for (const priorTarget of priorReceipt.targetBooks as Array<{ subject: Target; problemR2Key: string }>) {
    const book = db.prepare("SELECT book_id FROM book_files WHERE r2_key = ?")
      .get(priorTarget.problemR2Key) as { book_id: number };
    const rows = accepted.filter((value) =>
      targetForCanonical(value.classification.canonical_subject) === priorTarget.subject);
    db.prepare("DELETE FROM questions WHERE book_id = ?").run(book.book_id);
    db.prepare("DELETE FROM book_items WHERE book_id = ?").run(book.book_id);
    if (rows.length === 0) {
      db.prepare("DELETE FROM book_files WHERE book_id = ?").run(book.book_id);
      db.prepare("DELETE FROM books WHERE id = ?").run(book.book_id);
      continue;
    }
    db.prepare("UPDATE books SET title = ? WHERE id = ?").run(displayTitle, book.book_id);
    const bookFiles = db.prepare("SELECT id FROM book_files WHERE book_id = ? ORDER BY id")
      .all(book.book_id) as Array<{ id: number }>;
    const prefix = `corpus/${token(entry.id, 24)}/${token(priorTarget.subject, 16)}`;
    const problemR2Key = `${prefix}/problem.pdf`;
    const solutionR2Key = `${prefix}/solution.pdf`;
    db.prepare("UPDATE book_files SET r2_key = ?, content_hash = ?, page_count = ? WHERE id = ?")
      .run(problemR2Key, downloads.problem.sha256, downloads.problem.pageCount, bookFiles[0].id);
    db.prepare("UPDATE book_files SET r2_key = ?, content_hash = ?, page_count = ? WHERE id = ?")
      .run(solutionR2Key, downloads.solution.sha256, downloads.solution.pageCount, bookFiles[1].id);
    mkdirSync(join(files.dataDir, "files", prefix), { recursive: true });
    writeFileSync(join(files.dataDir, "files", problemR2Key), problemBytes);
    writeFileSync(join(files.dataDir, "files", solutionR2Key), solutionBytes);
    for (const value of rows) {
      const number = String(Number(value.question.number));
      const solution = solutionByNumber.get(number)!;
      const storedAnswer = resolveOfficialAnswer(value.question as any, solution.answer).storedAnswer;
      db.prepare(
        `INSERT INTO questions
         (id, subject_id, source, qtype, question, choices, answer, explanation, difficulty,
          book_id, book_number, printed_number, src_file_id, src_page)
         VALUES (?, (SELECT id FROM subjects WHERE name = ?), 'uploaded', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ++nextQuestionId,
        priorTarget.subject,
        value.question.qtype,
        value.question.question,
        value.question.choices ? JSON.stringify(value.question.choices) : null,
        storedAnswer,
        solution.explanation,
        problemCheckpoint.items[Number(number) - 1].difficulty,
        book.book_id,
        number,
        number,
        bookFiles[0].id,
        value.question.page,
      );
      db.prepare(
        "INSERT INTO book_items (id, book_id, file_id, category, number, answer, content, page) " +
        "VALUES (?, ?, ?, '문제', ?, ?, ?, ?)",
      ).run(++nextItemId, book.book_id, bookFiles[0].id, number, storedAnswer, value.question.question, value.question.page);
      db.prepare(
        "INSERT INTO book_items (id, book_id, file_id, category, number, answer, content, page) " +
        "VALUES (?, ?, ?, '해설', ?, ?, ?, ?)",
      ).run(++nextItemId, book.book_id, bookFiles[1].id, number, storedAnswer, solution.explanation, solution.page);
    }
    targetBooks.push({
      subject: priorTarget.subject,
      examTitle: entry.examTitle,
      bookTitle: displayTitle,
      expectedQuestionCount: rows.length,
      problemR2Key,
      solutionR2Key,
    });
  }
  db.close();
  const receipt = {
    version: 2,
    status: "committed",
    entryId: entry.id,
    examTitle: entry.examTitle,
    rawTitle: entry.rawTitle,
    bookTitle: displayTitle,
    sourceRecordYear: entry.sourceRecordYear,
    variant: entry.variant,
    form: entry.form,
    sourceSubject: entry.subject,
    grade: entry.grade,
    rulesDigest: DIGEST,
    sourceQuestionCount: classified.length,
    acceptedQuestionCount: accepted.length,
    rejectedQuestionCount: classified.length - accepted.length,
    reviewQuestionCount: 0,
    problemHash: downloads.problem.sha256,
    solutionHash: downloads.solution.sha256,
    problemChunking: { pages: 20, stride: 18, overlap: 2 },
    targetBooks,
  };
  const receiptHash = writeEvidence(join(stateDir, "receipt.json"), receipt);
  const attestationBasis = {
    entryId: entry.id,
    problemHash: downloads.problem.sha256,
    solutionHash: downloads.solution.sha256,
    classifierVersion: 5,
    rulesDigest: DIGEST,
    transcriptionGateVersion: 2,
    transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
    solutionFidelityVersion: 1,
    solutionFidelityPromptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    problemTerminalFidelityVersion: 2,
    problemTerminalScopePromptDigest: PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST,
    receipt: { path: "receipt.json", sha256: receiptHash },
    answerAudit: {
      path: auditRelativePath,
      sha256: auditHash,
      effectiveCorpusHash,
      effectiveSolutionCorpusHash,
    },
    repairs,
    solutionFidelityCheckpoints,
    solutionFidelityItems,
    solutionRepairs: [],
    problemTerminalFidelityCheckpoints: [finalTerminalPointer],
    problemTerminalFidelityItems: terminalItems,
  };
  const attestationDigest = canonicalEvidenceHash(attestationBasis);
  writeEvidence(join(stateDir, "answer-attestation", `v5-${attestationDigest}.json`), {
    version: 5,
    attestationDigest,
    ...attestationBasis,
  });
  return { childArtifact: join(stateDir, childRelativePath), stateDir };
}

function upgradeEntryToV3(
  files: ReturnType<typeof fixture>,
  id: keyof ReturnType<typeof fixture>["stateDirs"] = "math",
  options: {
    batchRepair?: boolean;
    terminalRevision?: boolean;
    classificationRevision?: boolean;
    mixedTerminal?: boolean;
    staleTriggerBase?: boolean;
    crossPageBatchRepair?: boolean;
    problemRecovery?: boolean;
    cropAdjudication?: boolean;
    scopeAdjudication?: boolean;
    repairScopeAdjudication?: boolean;
    manualAdjudication?: boolean;
    manualInvalidDecision?: boolean;
    difficultyRepair?: boolean;
    promptUpgrade?: boolean;
    terminalRecovery?: boolean;
    mixedTerminalRecovery?: boolean;
    answerV5?: boolean;
    terminalScope?: "authorized-reject" | "scope-accept" | "terminal-exact" | "low-confidence"
      | "accepted-scope-reject";
  } = {},
): {
  terminalArtifact: string;
  auditArtifact: string;
  attestationArtifact: string;
  problemBatchArtifact?: string;
  classificationBatchArtifact?: string;
  problemRevisionArtifact?: string;
  classificationRevisionArtifact?: string;
  problemRecoveryArtifact?: string;
  classificationRecoveryArtifact?: string;
  cropEvidenceArtifact?: string;
  cropEvidencePdf?: string;
  cropViewArtifacts?: string[];
  problemCropAdjudicationArtifact?: string;
  classificationCropAdjudicationArtifact?: string;
  classificationScopeAdjudicationArtifact?: string;
  manualEvidenceArtifact?: string;
  manualEvidencePdf?: string;
  manualViewArtifacts?: string[];
  problemManualAdjudicationArtifact?: string;
  classificationManualAdjudicationArtifact?: string;
} {
  const stateDir = files.stateDirs[id];
  const entryStatePath = join(stateDir, "entry.json");
  const entryState = JSON.parse(readFileSync(entryStatePath, "utf8"));
  entryState.schemaVersion = 2;
  writeJson(entryStatePath, entryState);
  const entry = entryState.entry;
  const downloads = JSON.parse(readFileSync(join(stateDir, "downloads.json"), "utf8"));
  if (options.scopeAdjudication && entry.id !== Q11_SCOPE_SPEC.entryId) {
    throw new Error("scope adjudication fixture requires the exact Q11 entry");
  }
  const positiveRepairScopeSpec = options.repairScopeAdjudication
    ? PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_ALLOWLIST.find((spec) => spec.entryId === entry.id)
    : undefined;
  const repairScopeSpec = options.repairScopeAdjudication
    ? PROBLEM_REPAIR_SCOPE_ADJUDICATION_ALLOWLIST.find((spec) => spec.entryId === entry.id)
      ?? positiveRepairScopeSpec
    : undefined;
  if (options.repairScopeAdjudication && !repairScopeSpec) {
    throw new Error("repair scope adjudication fixture requires an exact allowlisted entry");
  }
  const manualSpec = options.manualAdjudication
    ? PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((spec) => spec.entryId === entry.id)
    : undefined;
  const manualFailedArtifacts = manualSpec && MANUAL_FAILED_ARTIFACTS.get(manualSpec.entryId);
  if (options.manualAdjudication && (!manualSpec || !manualFailedArtifacts)) {
    throw new Error("manual adjudication fixture requires an exact supported entry");
  }
  if (options.cropAdjudication) {
    if (entry.id !== "ebsi:5578421") throw new Error("crop adjudication fixture requires Q29 entry");
    const bytes = readFileSync(Q29_OFFICIAL_PROBLEM_PATH);
    const sourceHash = hash(bytes);
    if (sourceHash !== "4c9aee0ec0c15f91678bc3c179efb4c781ab0f9023ca2e5347df94060012272e") {
      throw new Error("crop adjudication fixture official source hash is stale");
    }
    writeFileSync(join(stateDir, "problem.pdf"), bytes);
    Object.assign(downloads.problem, { sha256: sourceHash, bytes: bytes.length, pageCount: 16 });
    const receiptPath = join(stateDir, "receipt.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    receipt.problemHash = sourceHash;
    writeJson(receiptPath, receipt);
    const db = new Database(files.dbPath);
    for (const target of receipt.targetBooks as Array<{ problemR2Key: string }>) {
      writeFileSync(join(files.dataDir, "files", target.problemR2Key), bytes);
      db.prepare("UPDATE book_files SET content_hash = ?, page_count = 16 WHERE r2_key = ?")
        .run(sourceHash, target.problemR2Key);
    }
    db.close();
  }
  const problemName = readdirSync(join(stateDir, "problem-chunks"))[0];
  const problemCheckpointPath = join(stateDir, "problem-chunks", problemName);
  const problemCheckpoint = JSON.parse(readFileSync(problemCheckpointPath, "utf8"));
  const repairScopeKey = repairScopeSpec?.key.split(":");
  const recoveryTargetNumber = repairScopeKey ? Number(repairScopeKey[1]) : manualSpec
    ? Number(manualSpec.key.split(":")[1])
    : options.cropAdjudication ? 29 : options.scopeAdjudication ? 11 : 3;
  const recoveryTargetPage = repairScopeSpec?.sourcePage ?? (manualSpec ? manualSpec.sourcePage
    : options.cropAdjudication ? 11 : options.scopeAdjudication ? 4 : 1);
  const contextTo = manualSpec ? Number(downloads.problem.pageCount)
    : options.cropAdjudication ? 16
      : options.scopeAdjudication || options.repairScopeAdjudication || options.promptUpgrade ? 12
    : options.crossPageBatchRepair ? 2 : 1;
  if (options.crossPageBatchRepair || options.cropAdjudication || options.scopeAdjudication
    || options.repairScopeAdjudication || options.manualAdjudication || options.promptUpgrade) {
    downloads.problem.pageCount = contextTo;
    writeJson(join(stateDir, "downloads.json"), downloads);
    problemCheckpoint.to = contextTo;
    problemCheckpoint.ownedTo = contextTo;
    if (options.cropAdjudication || options.scopeAdjudication || options.repairScopeAdjudication
      || options.manualAdjudication || options.promptUpgrade) {
      problemCheckpoint.sourceHash = downloads.problem.sha256;
    }
    if (options.crossPageBatchRepair) {
      for (const item of problemCheckpoint.items.slice(9)) item.page = 2;
    }
    if (options.cropAdjudication || options.scopeAdjudication || options.repairScopeAdjudication
      || options.manualAdjudication || options.promptUpgrade) {
      problemCheckpoint.items[recoveryTargetNumber - 1].page = recoveryTargetPage;
    }
    writeJson(problemCheckpointPath, problemCheckpoint);
  }
  const legacyClassificationName = readdirSync(join(stateDir, "classification-chunks"))
    .find((name) => name.startsWith("v4-"))!;
  const legacyClassificationPath = join(stateDir, "classification-chunks", legacyClassificationName);
  const classification = JSON.parse(readFileSync(legacyClassificationPath, "utf8"));
  classification.version = 5;
  classification.transcriptionGateVersion = 2;
  classification.transcriptionPromptDigest = CURRENT_TRANSCRIPTION_PROMPT_DIGEST;
  classification.to = contextTo;
  classification.ownedTo = contextTo;
  if (options.cropAdjudication || options.scopeAdjudication || options.repairScopeAdjudication
    || options.manualAdjudication || options.promptUpgrade) {
    classification.sourceHash = downloads.problem.sha256;
  }
  if (options.crossPageBatchRepair) {
    for (const [index, item] of classification.items.entries()) {
      if (index >= 9) item.key = `2:${index + 1}`;
    }
  }
  if (options.cropAdjudication || options.scopeAdjudication || options.repairScopeAdjudication
    || options.manualAdjudication || options.promptUpgrade) {
    classification.items[recoveryTargetNumber - 1].key = `${recoveryTargetPage}:${recoveryTargetNumber}`;
  }
  if (options.scopeAdjudication) {
    Object.assign(classification.items[recoveryTargetNumber - 1], {
      decision: "accept",
      canonical_subject: "math_B",
      curriculum_course: "2015 수학Ⅰ",
      domain: "지수함수와 로그함수",
      achievement_codes: ["12수학Ⅰ01-07"],
      reason_codes: ["IN_SCOPE_LOGARITHMS"],
      confidence: 0.99,
    });
  }
  if (manualSpec?.expectedDecision === "accept") {
    Object.assign(classification.items[0], {
      decision: "reject",
      canonical_subject: null,
      curriculum_course: null,
      domain: null,
      achievement_codes: [],
      reason_codes: ["OUT_OF_SCOPE"],
      transcription_status: "exact",
      transcription_evidence: "the literal source transcription is exact and outside the selected scope",
    });
    const solutionPath = join(stateDir, "solution-chunks", "v3-0000.json");
    const solutionCheckpoint = JSON.parse(readFileSync(solutionPath, "utf8"));
    solutionCheckpoint.items[recoveryTargetNumber - 1] = {
      ...solutionCheckpoint.items[recoveryTargetNumber - 1],
      answer: "③ C",
      explanation: "서울보다 여름이 덥지 않고 시차가 작은 C 뉴질랜드가 조건에 맞는다.",
      page: 1,
      complete: true,
    };
    writeJson(solutionPath, solutionCheckpoint);
  }
  const mixedTerminal = options.mixedTerminal || options.staleTriggerBase;
  const repairNumbers = options.cropAdjudication || options.scopeAdjudication
    || options.repairScopeAdjudication || options.manualAdjudication
    ? [recoveryTargetNumber]
    : options.difficultyRepair ? [1]
    : options.batchRepair || options.crossPageBatchRepair || options.problemRecovery
    || options.terminalRecovery || options.mixedTerminalRecovery
    || options.terminalRevision || options.classificationRevision || mixedTerminal
      ? [3, 10]
      : [];
  for (const number of repairNumbers) {
    const falseExactBase = mixedTerminal && number === 10;
    classification.items[number - 1].transcription_status = falseExactBase ? "exact" : "mismatch";
    classification.items[number - 1].transcription_evidence = falseExactBase
      ? "the initial classifier incorrectly considered the abbreviated source exact"
      : "shared source text was abbreviated";
  }
  if (options.terminalScope && options.terminalScope !== "accepted-scope-reject") {
    classification.items[2].transcription_status = "mismatch";
    classification.items[2].transcription_evidence = "base transcription omitted source detail for rejected Q3";
  }
  if (options.mixedTerminalRecovery) {
    Object.assign(classification.items[19], {
      decision: "reject",
      canonical_subject: null,
      curriculum_course: null,
      domain: null,
      achievement_codes: [],
      reason_codes: ["OUT_OF_SCOPE"],
      transcription_status: "mismatch",
      transcription_evidence: "the unrepaired rejected sibling remains intentionally abbreviated",
    });
  }
  const classificationName = legacyClassificationName.replace(/^v4-/u, "v5-");
  const classificationPath = join(stateDir, "classification-chunks", classificationName);
  writeJson(classificationPath, classification);
  rmSync(legacyClassificationPath);

  const effectiveProblems = problemCheckpoint.items.map((question: Record<string, unknown>) => ({ ...question }));
  const effectiveClassifications = classification.items.map((item: Record<string, unknown>) => ({ ...item }));
  const repairs: Record<string, unknown>[] = [];
  let problemBatchArtifact: string | undefined;
  let classificationBatchArtifact: string | undefined;
  let problemRevisionArtifact: string | undefined;
  let classificationRevisionArtifact: string | undefined;
  let problemRecoveryArtifact: string | undefined;
  let classificationRecoveryArtifact: string | undefined;
  let cropEvidenceArtifact: string | undefined;
  let cropEvidencePdf: string | undefined;
  let cropViewArtifacts: string[] | undefined;
  let problemCropAdjudicationArtifact: string | undefined;
  let classificationCropAdjudicationArtifact: string | undefined;
  let classificationScopeAdjudicationArtifact: string | undefined;
  let manualEvidenceArtifact: string | undefined;
  let manualEvidencePdf: string | undefined;
  let manualViewArtifacts: string[] | undefined;
  let problemManualAdjudicationArtifact: string | undefined;
  let classificationManualAdjudicationArtifact: string | undefined;
  if (repairNumbers.length > 0) {
    const baseProblemCheckpoint = {
      path: `problem-chunks/${problemName}`,
      sha256: hash(readFileSync(problemCheckpointPath)),
    };
    const baseClassificationCheckpoint = {
      path: `classification-chunks/${classificationName}`,
      sha256: hash(readFileSync(classificationPath)),
    };
    const members = repairNumbers.map((number) => {
      const sourcePage = Number(problemCheckpoint.items[number - 1].page);
      const key = `${sourcePage}:${number}`;
      const solutionName = readdirSync(join(stateDir, "solution-chunks")).find((name) => {
        const checkpoint = JSON.parse(readFileSync(join(stateDir, "solution-chunks", name), "utf8"));
        return checkpoint.items.some((item: { number: string }) => item.number === String(number));
      })!;
      const solutionPath = join(stateDir, "solution-chunks", solutionName);
      const solutionCheckpoint = JSON.parse(readFileSync(solutionPath, "utf8"));
      const solutionItem = solutionCheckpoint.items.find((item: { number: string }) => item.number === String(number));
      const member = {
        key,
        printedNumber: String(number),
        ...(options.crossPageBatchRepair ? { sourcePage } : {}),
        baseProblemCheckpoint,
        baseQuestionHash: canonicalEvidenceHash(problemCheckpoint.items[number - 1]),
        baseClassificationCheckpoint,
        baseClassificationHash: canonicalEvidenceHash(classification.items[number - 1]),
        ...(options.crossPageBatchRepair ? {
          baseTranscriptionEvidenceHash: hash(classification.items[number - 1].transcription_evidence),
        } : {}),
        baseSolutionCheckpoint: {
          path: `solution-chunks/${solutionName}`,
          sha256: hash(readFileSync(solutionPath)),
        },
        baseSolutionItemHash: canonicalEvidenceHash(solutionItem),
        officialRawAnswerHash: hash(solutionItem.answer),
      };
      return member;
    }).sort((left, right) => compareCorpusQuestionKeys(left.key, right.key));
    const positiveOfficialQuestion = positiveRepairScopeSpec ? readdirSync(join(
      REPAIR_SCOPE_STATES.get(positiveRepairScopeSpec.entryId)!,
      "problem-repair-batches",
    )).sort().map((name) => JSON.parse(readFileSync(join(
      REPAIR_SCOPE_STATES.get(positiveRepairScopeSpec.entryId)!,
      "problem-repair-batches",
      name,
    ), "utf8")).items as Array<Record<string, unknown>>).flat()
      .find((item) => String(item.number) === String(recoveryTargetNumber)
        && item.qtype === "mcq" && String(item.question).includes("[3점]")) : undefined;
    const corrected = members.map((member) => {
      const number = Number(member.printedNumber);
      if (positiveOfficialQuestion && number === recoveryTargetNumber) {
        return structuredClone(positiveOfficialQuestion);
      }
      return {
        ...problemCheckpoint.items[number - 1],
        question: options.difficultyRepair
          ? problemCheckpoint.items[number - 1].question
          : `${problemCheckpoint.items[number - 1].question} [full literal source]`,
        ...(options.difficultyRepair && number === 1 ? { difficulty: "상" } : {}),
      };
    });
    const membersDigest = canonicalEvidenceHash(members);
    const problemRelativePath = options.crossPageBatchRepair
      ? `problem-repair-batches/v2-0001-${String(contextTo).padStart(4, "0")}-${membersDigest}.json`
      : `problem-repair-batches/v1-0001-${String(contextTo).padStart(4, "0")}-` +
        `${String(options.cropAdjudication || options.scopeAdjudication
          || options.repairScopeAdjudication || options.manualAdjudication
          ? recoveryTargetPage : 1).padStart(4, "0")}-${membersDigest}.json`;
    const diagnosticEvidence = JSON.stringify(members.map((member) => ({
      key: member.key,
      evidence: classification.items[Number(member.printedNumber) - 1].transcription_evidence,
    })));
    const problemHash = writeEvidence(join(stateDir, problemRelativePath), options.crossPageBatchRepair ? {
      version: 2,
      entryId: entry.id,
      sourceHash: downloads.problem.sha256,
      contextFrom: 1,
      contextTo,
      targetsDigest: membersDigest,
      members,
      batchPromptVersion: TARGETED_PROBLEM_BATCH_VERSION,
      batchPromptDigest: TARGETED_BATCH_PROMPT_DIGEST,
      revisionPromptVersion: TARGETED_PROBLEM_REVISION_VERSION,
      revisionPromptDigest: TARGETED_BATCH_REVISION_PROMPT_DIGEST,
      diagnosticEvidenceHash: hash(diagnosticEvidence),
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      items: corrected,
    } : {
      version: 1,
      entryId: entry.id,
      sourceHash: downloads.problem.sha256,
      contextFrom: 1,
      contextTo,
      sourcePage: options.cropAdjudication || options.scopeAdjudication
        || options.repairScopeAdjudication || options.manualAdjudication
        ? recoveryTargetPage : 1,
      membersDigest,
      members,
      promptVersion: TARGETED_PROBLEM_BATCH_VERSION,
      promptDigest: TARGETED_BATCH_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      items: corrected,
    });
    problemBatchArtifact = join(stateDir, problemRelativePath);
    const problemAuthorities = members.map((member, index) => ({
      key: member.key,
      path: problemRelativePath,
      sha256: problemHash,
      itemHash: canonicalEvidenceHash(corrected[index]),
    }));
    const correctedClassifications = members.map((member) => {
      const number = Number(member.printedNumber);
      return {
        ...classification.items[number - 1],
        ...(options.repairScopeAdjudication && number === recoveryTargetNumber
          ? positiveRepairScopeSpec ? {
              decision: "accept",
              canonical_subject: "math_A",
              curriculum_course: "2015 수학Ⅱ",
              domain: "적분",
              achievement_codes: ["12수학Ⅱ03-04"],
              reason_codes: ["IN_SCOPE_RIEMANN_SUM_DEFINITION"],
              confidence: 0.99,
            } : {
              decision: "accept",
              canonical_subject: "math_B",
              curriculum_course: "2015 수학Ⅰ",
              domain: "지수함수와 로그함수",
              achievement_codes: ["12수학Ⅰ01-07"],
              reason_codes: ["IN_SCOPE_LOGARITHMS"],
              confidence: 0.99,
            }
          : {}),
        transcription_status: (options.classificationRevision || options.problemRecovery || options.cropAdjudication
          || options.scopeAdjudication || options.manualAdjudication)
          && number === recoveryTargetNumber
          ? "mismatch" : "exact",
        transcription_evidence: (options.classificationRevision || options.problemRecovery || options.cropAdjudication
          || options.scopeAdjudication || options.manualAdjudication)
          && number === recoveryTargetNumber
          ? "the first repaired classification still found an omitted literal transition"
          : "the repaired full literal source exactly matches the official pixels",
      };
    });
    const classificationMembers = members.map((member, index) => ({
      key: member.key,
      problemAuthority: problemAuthorities[index],
      effectiveQuestionHash: canonicalEvidenceHash(corrected[index]),
      baseClassificationCheckpoint,
      baseClassificationHash: member.baseClassificationHash,
    }));
    const overlayDigest = canonicalEvidenceHash(classificationMembers);
    const classificationRelativePath =
      `classification-repair-batches/v1-0001-${String(contextTo).padStart(4, "0")}-${overlayDigest}-${DIGEST}.json`;
    const classificationHash = writeEvidence(join(stateDir, classificationRelativePath), {
      version: 1,
      entryId: entry.id,
      sourceHash: downloads.problem.sha256,
      contextFrom: 1,
      contextTo,
      overlayDigest,
      classifierVersion: 5,
      rulesDigest: DIGEST,
      transcriptionGateVersion: 2,
      transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      members: classificationMembers,
      items: correctedClassifications,
    });
    classificationBatchArtifact = join(stateDir, classificationRelativePath);
    for (const [index, member] of members.entries()) {
      const number = Number(member.printedNumber);
      effectiveProblems[number - 1] = corrected[index];
      effectiveClassifications[number - 1] = correctedClassifications[index];
      repairs.push({
        key: member.key,
        printedNumber: member.printedNumber,
        sourcePage: Number(problemCheckpoint.items[number - 1].page),
        contextFrom: 1,
        contextTo,
        baseProblemCheckpoint,
        baseClassificationCheckpoint,
        baseSolutionCheckpoint: member.baseSolutionCheckpoint,
        problemArtifact: { path: problemRelativePath, sha256: problemHash },
        problemArtifactItemHash: problemAuthorities[index].itemHash,
        classificationArtifact: {
          path: classificationRelativePath,
          sha256: classificationHash,
          rulesDigest: DIGEST,
          transcriptionGateVersion: 2,
          transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
        },
        classificationArtifactItemHash: canonicalEvidenceHash(correctedClassifications[index]),
        baseQuestionHash: member.baseQuestionHash,
        effectiveQuestionHash: canonicalEvidenceHash(corrected[index]),
        baseClassificationHash: member.baseClassificationHash,
        effectiveClassificationHash: canonicalEvidenceHash(correctedClassifications[index]),
        baseSolutionItemHash: member.baseSolutionItemHash,
        officialRawAnswerHash: member.officialRawAnswerHash,
      });
    }
    repairs.sort((left, right) => compareCorpusQuestionKeys(String(left.key), String(right.key)));
  }

  if (repairScopeSpec) {
    const targetIndex = recoveryTargetNumber - 1;
    const targetKey = repairScopeSpec.key;
    const targetRepair = repairs.find((repair) => repair.key === targetKey)!;
    const parentRepair = { ...targetRepair };
    const parentRepairEvidenceHash = canonicalEvidenceHash(parentRepair);
    const preAdjudicationCorpus = effectiveProblems.map((question: Record<string, unknown>, index: number) => ({
      question,
      classification: effectiveClassifications[index],
    })).sort((left: { question: Record<string, unknown> }, right: { question: Record<string, unknown> }) =>
      Number(left.question.page) - Number(right.question.page)
      || Number(left.question.number) - Number(right.question.number));
    const preAdjudicationEffectiveCorpusHash = canonicalEvidenceHash(preAdjudicationCorpus);
    const preAdjudicationInputs = preAdjudicationCorpus.map(({ question }: {
      question: Record<string, unknown>;
    }) => ({
      key: `${question.page}:${question.number}`,
      printed_number: String(question.number),
      source_page: question.page,
      qtype: question.qtype,
      question: question.question,
      choices: question.choices,
      figure: question.figure,
      figure_description: question.figure_description,
      box: question.box,
    }));
    const preAdjudicationItems = preAdjudicationInputs.map((input: { key: string }) => {
      const number = Number(input.key.split(":")[1]);
      const currentClassification = effectiveClassifications[number - 1];
      const target = input.key === targetKey;
      const authorizedRejectMismatch = currentClassification.decision === "reject"
        && currentClassification.transcription_status === "mismatch";
      return {
        key: input.key,
        status: authorizedRejectMismatch ? "mismatch" : "exact",
        evidence: authorizedRejectMismatch
          ? "the independent scope gate authorizes this unrepaired rejected mismatch"
          : "official pixels exactly match the repaired literal transcription",
        scopeDecision: target ? "reject" : currentClassification.decision,
        scopeConfidence: 0.99,
        scopeEvidence: target
          ? "the official problem and solution contexts independently establish out-of-scope content"
          : "the official source page independently establishes the curriculum scope",
      };
    }).sort((left: { key: string }, right: { key: string }) =>
      compareCorpusQuestionKeys(left.key, right.key));
    const preAdjudicationInputHash = canonicalEvidenceHash(preAdjudicationInputs);
    const terminalRelativePath = `problem-terminal-fidelity/v2-0000-` +
      `${preAdjudicationEffectiveCorpusHash}-${preAdjudicationInputHash}.json`;
    const terminalHash = writeEvidence(join(stateDir, terminalRelativePath), {
      version: 2,
      entryId: entry.id,
      sourceHash: downloads.problem.sha256,
      from: 1,
      to: contextTo,
      ownedFrom: 1,
      ownedTo: contextTo,
      effectiveCorpusHash: preAdjudicationEffectiveCorpusHash,
      inputHash: preAdjudicationInputHash,
      transcriptionGateVersion: 2,
      transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
      rulesDigest: DIGEST,
      scopePromptDigest: PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      inputs: preAdjudicationInputs,
      items: preAdjudicationItems,
    });
    const terminalCheckpoint = {
      path: terminalRelativePath,
      sha256: terminalHash,
      from: 1,
      to: contextTo,
      ownedFrom: 1,
      ownedTo: contextTo,
      inputHash: preAdjudicationInputHash,
    };
    const terminalItem = preAdjudicationItems.find((item: { key: string }) => item.key === targetKey)!;
    const trigger = {
      terminalCheckpoint,
      terminalItemHash: canonicalEvidenceHash(terminalItem),
      terminalItem,
      evidenceHash: hash(terminalItem.evidence),
      scopeEvidenceHash: hash(terminalItem.scopeEvidence),
      preAdjudicationEffectiveCorpusHash,
    };
    const baseSolutionCheckpoint = targetRepair.baseSolutionCheckpoint as { path: string; sha256: string };
    const baseSolutionArtifact = JSON.parse(readFileSync(join(stateDir, baseSolutionCheckpoint.path), "utf8"));
    const baseSolutionItem = baseSolutionArtifact.items.find(
      (item: { number: string }) => item.number === String(recoveryTargetNumber),
    );
    const currentQuestion = effectiveProblems[targetIndex];
    const currentClassification = effectiveClassifications[targetIndex];
    const basis = {
      allowlistId: repairScopeSpec.allowlistId,
      entryId: entry.id,
      key: targetKey,
      printedNumber: String(recoveryTargetNumber),
      sourcePage: recoveryTargetPage,
      sourceHash: downloads.problem.sha256,
      solutionSourceHash: downloads.solution.sha256,
      problemContextFrom: 1,
      problemContextTo: contextTo,
      solutionContextFrom: baseSolutionArtifact.from,
      solutionContextTo: baseSolutionArtifact.to,
      baseSolutionCheckpoint,
      baseSolutionItemHash: canonicalEvidenceHash(baseSolutionItem),
      parentRepair,
      parentRepairEvidenceHash,
      ...(positiveRepairScopeSpec ? {
        scopeAuthority: {
          decision: "accept",
          canonicalSubject: positiveRepairScopeSpec.expectedCanonicalSubject,
          allowedAchievementCodes: [...positiveRepairScopeSpec.allowedAchievementCodes],
          requiredReasonCode: PROBLEM_REPAIR_POSITIVE_SCOPE_AUTHORITY_REASON_CODE,
        },
      } : {}),
      trigger,
      baseQuestionHash: canonicalEvidenceHash(currentQuestion),
      baseClassificationHash: canonicalEvidenceHash(currentClassification),
    };
    const basisDigest = canonicalEvidenceHash(basis);
    const finalClassification = {
      ...currentClassification,
      ...(positiveRepairScopeSpec ? {
        decision: "accept",
        canonical_subject: positiveRepairScopeSpec.expectedCanonicalSubject,
        curriculum_course: "2015 수학Ⅱ",
        domain: "적분",
        achievement_codes: [...positiveRepairScopeSpec.allowedAchievementCodes],
        reason_codes: [
          "IN_SCOPE_RIEMANN_SUM_DEFINITION",
          PROBLEM_REPAIR_POSITIVE_SCOPE_AUTHORITY_REASON_CODE,
        ],
      } : {
        decision: "reject",
        canonical_subject: null,
        curriculum_course: null,
        domain: null,
        achievement_codes: [],
        reason_codes: ["OUT_OF_SCOPE"],
      }),
      confidence: 0.99,
      transcription_status: "exact",
      transcription_evidence: positiveRepairScopeSpec
        ? "the exact source states the in-scope Riemann-sum definition"
        : "the exact source is outside the canonical target curriculum",
    };
    const classificationDirectory = positiveRepairScopeSpec
      ? "classification-repair-positive-scope-adjudications"
      : "classification-repair-scope-adjudications";
    const adjudicationPromptDigest = positiveRepairScopeSpec
      ? PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_PROMPT_DIGEST
      : PROBLEM_REPAIR_SCOPE_ADJUDICATION_PROMPT_DIGEST;
    const classificationRelativePath = `${classificationDirectory}/v1-` +
      `${String(recoveryTargetPage).padStart(4, "0")}-` +
      `${String(recoveryTargetNumber).padStart(4, "0")}-${basisDigest}-${DIGEST}.json`;
    const classificationHash = writeEvidence(join(stateDir, classificationRelativePath), {
      version: 1,
      entryId: entry.id,
      basisDigest,
      basis,
      classifierVersion: 5,
      rulesDigest: DIGEST,
      transcriptionGateVersion: 2,
      transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
      adjudicationPromptVersion: 1,
      adjudicationPromptDigest,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      items: [finalClassification],
    });
    classificationScopeAdjudicationArtifact = join(stateDir, classificationRelativePath);
    const classificationArtifactItemHash = canonicalEvidenceHash(finalClassification);
    targetRepair.scopeAdjudication = {
      allowlistId: repairScopeSpec.allowlistId,
      key: targetKey,
      printedNumber: String(recoveryTargetNumber),
      sourcePage: recoveryTargetPage,
      sourceHash: downloads.problem.sha256,
      solutionSourceHash: downloads.solution.sha256,
      problemContextFrom: 1,
      problemContextTo: contextTo,
      solutionContextFrom: baseSolutionArtifact.from,
      solutionContextTo: baseSolutionArtifact.to,
      baseSolutionCheckpoint,
      baseSolutionItemHash: canonicalEvidenceHash(baseSolutionItem),
      parentRepairEvidenceHash,
      trigger,
      classificationArtifact: {
        path: classificationRelativePath,
        sha256: classificationHash,
        rulesDigest: DIGEST,
        transcriptionGateVersion: 2,
        transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
        adjudicationPromptVersion: 1,
        adjudicationPromptDigest,
      },
      classificationArtifactItemHash,
      baseQuestionHash: canonicalEvidenceHash(currentQuestion),
      effectiveQuestionHash: canonicalEvidenceHash(currentQuestion),
      baseClassificationHash: canonicalEvidenceHash(currentClassification),
      effectiveClassificationHash: classificationArtifactItemHash,
    };
    effectiveClassifications[targetIndex] = finalClassification;
  }

  if (mixedTerminal) {
    const priorRepairs = new Map(repairs.map((repair) => [String(repair.key), repair]));
    if (problemBatchArtifact) rmSync(problemBatchArtifact);
    if (classificationBatchArtifact) rmSync(classificationBatchArtifact);
    const rebuilt: Record<string, unknown>[] = [];
    for (const number of [3, 10]) {
      const key = `1:${number}`;
      const prior = priorRepairs.get(key)!;
      const correctedQuestion = effectiveProblems[number - 1];
      const correctedClassification = effectiveClassifications[number - 1];
      let problemArtifact: { path: string; sha256: string };
      let problemArtifactItemHash: string;
      if (number === 3) {
        const relativePath = "problem-repairs/v2-0001-0003.json";
        const sha256 = writeEvidence(join(stateDir, relativePath), {
          version: 2,
          entryId: entry.id,
          key,
          sourcePage: 1,
          printedNumber: "3",
          contextFrom: 1,
          contextTo: 1,
          sourceHash: downloads.problem.sha256,
          baseProblemCheckpoint: prior.baseProblemCheckpoint,
          baseQuestionHash: prior.baseQuestionHash,
          baseSolutionCheckpoint: prior.baseSolutionCheckpoint,
          baseSolutionItemHash: prior.baseSolutionItemHash,
          officialRawAnswerHash: prior.officialRawAnswerHash,
          promptVersion: TARGETED_PROBLEM_TRANSCRIPTION_VERSION,
          promptDigest: TARGETED_PROMPT_DIGEST,
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          item: correctedQuestion,
        });
        problemArtifact = { path: relativePath, sha256 };
        problemArtifactItemHash = canonicalEvidenceHash(correctedQuestion);
      } else {
        const members = [{
          key,
          printedNumber: "10",
          baseProblemCheckpoint: prior.baseProblemCheckpoint,
          baseQuestionHash: prior.baseQuestionHash,
          baseClassificationCheckpoint: prior.baseClassificationCheckpoint,
          baseClassificationHash: prior.baseClassificationHash,
          baseSolutionCheckpoint: prior.baseSolutionCheckpoint,
          baseSolutionItemHash: prior.baseSolutionItemHash,
          officialRawAnswerHash: prior.officialRawAnswerHash,
        }];
        const membersDigest = canonicalEvidenceHash(members);
        const relativePath = `problem-repair-batches/v1-0001-0001-0001-${membersDigest}.json`;
        const sha256 = writeEvidence(join(stateDir, relativePath), {
          version: 1,
          entryId: entry.id,
          sourceHash: downloads.problem.sha256,
          contextFrom: 1,
          contextTo: 1,
          sourcePage: 1,
          membersDigest,
          members,
          promptVersion: TARGETED_PROBLEM_BATCH_VERSION,
          promptDigest: TARGETED_BATCH_PROMPT_DIGEST,
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          items: [correctedQuestion],
        });
        problemArtifact = { path: relativePath, sha256 };
        problemArtifactItemHash = canonicalEvidenceHash(correctedQuestion);
        problemBatchArtifact = join(stateDir, relativePath);
      }
      const classificationMembers = [{
        key,
        problemAuthority: { key, ...problemArtifact, itemHash: problemArtifactItemHash },
        effectiveQuestionHash: problemArtifactItemHash,
        baseClassificationCheckpoint: prior.baseClassificationCheckpoint,
        baseClassificationHash: prior.baseClassificationHash,
      }];
      const overlayDigest = canonicalEvidenceHash(classificationMembers);
      const relativePath = `classification-repair-batches/v1-0001-0001-${overlayDigest}-${DIGEST}.json`;
      const classificationHash = writeEvidence(join(stateDir, relativePath), {
        version: 1,
        entryId: entry.id,
        sourceHash: downloads.problem.sha256,
        contextFrom: 1,
        contextTo: 1,
        overlayDigest,
        classifierVersion: 5,
        rulesDigest: DIGEST,
        transcriptionGateVersion: 2,
        transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        members: classificationMembers,
        items: [correctedClassification],
      });
      classificationBatchArtifact = join(stateDir, relativePath);
      rebuilt.push({
        ...prior,
        problemArtifact,
        problemArtifactItemHash,
        classificationArtifact: {
          path: relativePath,
          sha256: classificationHash,
          rulesDigest: DIGEST,
          transcriptionGateVersion: 2,
          transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
        },
        classificationArtifactItemHash: canonicalEvidenceHash(correctedClassification),
      });
    }
    repairs.splice(0, repairs.length, ...rebuilt.sort((left, right) =>
      compareCorpusQuestionKeys(String(left.key), String(right.key))));
  }

  if (options.terminalRevision || options.classificationRevision || options.problemRecovery
    || options.cropAdjudication || options.scopeAdjudication || options.manualAdjudication
    || options.terminalRecovery || options.mixedTerminalRecovery || mixedTerminal) {
    const targetKey = `${recoveryTargetPage}:${recoveryTargetNumber}`;
    const targetIndex = recoveryTargetNumber - 1;
    const targetRepair = repairs.find((repair) => repair.key === targetKey)!;
    let trigger: Record<string, unknown>;
    if (options.classificationRevision || options.problemRecovery || options.cropAdjudication
      || options.scopeAdjudication || options.manualAdjudication) {
      trigger = {
        kind: "classification",
        evidenceHash: hash(String(effectiveClassifications[targetIndex].transcription_evidence)),
      };
    } else {
      const triggerCorpus = effectiveProblems.map((question: Record<string, unknown>, index: number) => ({
        question: options.staleTriggerBase && index === 2 || mixedTerminal && index === 9
          ? problemCheckpoint.items[index]
          : question,
        classification: options.staleTriggerBase && index === 2 || mixedTerminal && index === 9
          ? classification.items[index]
          : effectiveClassifications[index],
      }));
      const triggerCorpusHash = canonicalEvidenceHash(triggerCorpus);
      const triggerInputs = triggerCorpus.map(({ question }: { question: Record<string, unknown> }) => ({
        key: `${question.page}:${question.number}`,
        printed_number: String(question.number),
        source_page: question.page,
        qtype: question.qtype,
        question: question.question,
        choices: question.choices,
        figure: question.figure,
        figure_description: question.figure_description,
        box: question.box,
      }));
      const triggerInputHash = canonicalEvidenceHash(triggerInputs);
      const triggerItems = triggerInputs.map((input: { key: string }) => ({
        key: input.key,
        status: input.key === targetKey || mixedTerminal && input.key === "1:10"
          || options.mixedTerminalRecovery && input.key === "1:20" ? "mismatch" : "exact",
        evidence: input.key === targetKey
          ? "the terminal source gate found one omitted literal transition"
          : mixedTerminal && input.key === "1:10"
            ? "the terminal source gate found an abbreviated sibling source"
          : options.mixedTerminalRecovery && input.key === "1:20"
            ? "the independent scope gate authorizes this unrepaired rejected mismatch"
          : "the final transcription is exact",
        ...(options.terminalScope ? {
          scopeDecision: effectiveClassifications[Number(input.key.split(":")[1]) - 1].decision,
          scopeConfidence: 0.99,
          scopeEvidence: "the official source page independently establishes the curriculum scope",
        } : {}),
      })).sort((left: { key: string }, right: { key: string }) => compareCorpusQuestionKeys(left.key, right.key));
      const triggerTerminalVersion = options.terminalScope ? 2 : 1;
      const triggerPath =
        `problem-terminal-fidelity/v${triggerTerminalVersion}-0000-${triggerCorpusHash}-${triggerInputHash}.json`;
      const triggerHash = writeEvidence(join(stateDir, triggerPath), {
        version: triggerTerminalVersion,
        entryId: entry.id,
        sourceHash: downloads.problem.sha256,
        from: 1,
        to: 1,
        ownedFrom: 1,
        ownedTo: 1,
        effectiveCorpusHash: triggerCorpusHash,
        inputHash: triggerInputHash,
        transcriptionGateVersion: 2,
        transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
        ...(options.terminalScope ? {
          rulesDigest: DIGEST,
          scopePromptDigest: PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST,
        } : {}),
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        inputs: triggerInputs,
        items: triggerItems,
      });
      const terminalCheckpoint = {
        path: triggerPath,
        sha256: triggerHash,
        from: 1,
        to: 1,
        ownedFrom: 1,
        ownedTo: 1,
        inputHash: triggerInputHash,
      };
      const terminalItem = triggerItems.find((item: { key: string }) => item.key === targetKey)!;
      trigger = {
        kind: "terminal",
        evidenceHash: hash(terminalItem.evidence),
        terminalCheckpoint,
        terminalItemHash: canonicalEvidenceHash(terminalItem),
      };
    }
    const baseProblemRepairArtifact = targetRepair.problemArtifact as { path: string; sha256: string };
    const baseClassificationEnvelope = targetRepair.classificationArtifact as Record<string, unknown>;
    const baseClassificationRepairArtifact = {
      path: baseClassificationEnvelope.path,
      sha256: baseClassificationEnvelope.sha256,
    };
    const revisionMember = {
      key: targetKey,
      printedNumber: String(recoveryTargetNumber),
      sourcePage: recoveryTargetPage,
      baseProblemRepairArtifact,
      baseProblemRepairItemHash: targetRepair.problemArtifactItemHash,
      baseClassificationRepairArtifact,
      baseClassificationRepairItemHash: targetRepair.classificationArtifactItemHash,
      baseQuestionHash: canonicalEvidenceHash(effectiveProblems[targetIndex]),
      baseClassificationHash: canonicalEvidenceHash(effectiveClassifications[targetIndex]),
      trigger,
    };
    const revisionMembers = [revisionMember];
    const revisionMembersDigest = canonicalEvidenceHash(revisionMembers);
    const revisionQuestion = {
      ...effectiveProblems[targetIndex],
      question: `${effectiveProblems[targetIndex].question} [second source-grounded literal revision]`,
    };
    const revisionProblemPath = `problem-revision-batches/v1-0001-` +
      `${String(contextTo).padStart(4, "0")}-${String(recoveryTargetPage).padStart(4, "0")}-` +
      `${revisionMembersDigest}.json`;
    const revisionProblemHash = writeEvidence(join(stateDir, revisionProblemPath), {
      version: 1,
      entryId: entry.id,
      sourceHash: downloads.problem.sha256,
      contextFrom: 1,
      contextTo,
      sourcePage: recoveryTargetPage,
      membersDigest: revisionMembersDigest,
      members: revisionMembers,
      batchPromptVersion: TARGETED_PROBLEM_BATCH_VERSION,
      batchPromptDigest: TARGETED_BATCH_PROMPT_DIGEST,
      revisionPromptVersion: TARGETED_PROBLEM_REVISION_VERSION,
      revisionPromptDigest: TARGETED_BATCH_REVISION_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      items: [revisionQuestion],
    });
    problemRevisionArtifact = join(stateDir, revisionProblemPath);
    const revisionQuestionHash = canonicalEvidenceHash(revisionQuestion);
    const revisionClassificationMember = {
      key: targetKey,
      problemAuthority: {
        key: targetKey,
        path: revisionProblemPath,
        sha256: revisionProblemHash,
        itemHash: revisionQuestionHash,
      },
      effectiveQuestionHash: revisionQuestionHash,
      baseClassificationRepairArtifact,
      baseClassificationRepairItemHash: targetRepair.classificationArtifactItemHash,
      triggerHash: canonicalEvidenceHash(trigger),
    };
    const revisionOverlayDigest = canonicalEvidenceHash([revisionClassificationMember]);
    const revisionClassification = {
      ...effectiveClassifications[targetIndex],
      transcription_status: options.problemRecovery || options.cropAdjudication || options.scopeAdjudication
        || options.manualAdjudication
        ? "mismatch" : "exact",
      transcription_evidence: options.problemRecovery || options.cropAdjudication || options.scopeAdjudication
        || options.manualAdjudication
        ? "the second source-grounded revision still omitted one literal source clause"
        : "the second source-grounded literal revision is exact",
    };
    const revisionClassificationPath =
      `classification-revision-batches/v1-0001-${String(contextTo).padStart(4, "0")}-` +
      `${revisionOverlayDigest}-${DIGEST}.json`;
    const revisionClassificationHash = writeEvidence(join(stateDir, revisionClassificationPath), {
      version: 1,
      entryId: entry.id,
      sourceHash: downloads.problem.sha256,
      contextFrom: 1,
      contextTo,
      overlayDigest: revisionOverlayDigest,
      classifierVersion: 5,
      rulesDigest: DIGEST,
      transcriptionGateVersion: 2,
      transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      members: [revisionClassificationMember],
      items: [revisionClassification],
    });
    classificationRevisionArtifact = join(stateDir, revisionClassificationPath);
    targetRepair.revision = {
      baseProblemRepairArtifact,
      baseClassificationRepairArtifact,
      problemArtifact: { path: revisionProblemPath, sha256: revisionProblemHash },
      classificationArtifact: {
        path: revisionClassificationPath,
        sha256: revisionClassificationHash,
        rulesDigest: DIGEST,
        transcriptionGateVersion: 2,
        transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
      },
      diagnosticEvidenceHash: trigger.evidenceHash,
      baseQuestionHash: revisionMember.baseQuestionHash,
      effectiveQuestionHash: revisionQuestionHash,
      baseClassificationHash: revisionMember.baseClassificationHash,
      effectiveClassificationHash: canonicalEvidenceHash(revisionClassification),
      problemArtifactItemHash: revisionQuestionHash,
      classificationArtifactItemHash: canonicalEvidenceHash(revisionClassification),
      trigger,
    };
    if (options.problemRecovery || options.cropAdjudication || options.scopeAdjudication
      || options.manualAdjudication) {
      const baseProblemRevisionArtifact = { path: revisionProblemPath, sha256: revisionProblemHash };
      const baseClassificationRevisionArtifact = {
        path: revisionClassificationPath,
        sha256: revisionClassificationHash,
      };
      const failedClassificationEvidenceHash = hash(revisionClassification.transcription_evidence);
      const problemBasis = {
        key: targetKey,
        printedNumber: String(recoveryTargetNumber),
        sourcePage: recoveryTargetPage,
        sourceHash: downloads.problem.sha256,
        contextFrom: 1,
        contextTo,
        baseProblemRepairArtifact,
        baseProblemRepairItemHash: targetRepair.problemArtifactItemHash,
        baseClassificationRepairArtifact,
        baseClassificationRepairItemHash: targetRepair.classificationArtifactItemHash,
        baseProblemRevisionArtifact,
        baseProblemRevisionItemHash: revisionQuestionHash,
        baseClassificationRevisionArtifact,
        baseClassificationRevisionItemHash: canonicalEvidenceHash(revisionClassification),
        baseQuestionHash: revisionQuestionHash,
        baseClassificationHash: canonicalEvidenceHash(revisionClassification),
        failedClassificationEvidenceHash,
      };
      const basisDigest = canonicalEvidenceHash(problemBasis);
      const recoveredQuestion = manualSpec
        ? JSON.parse(readFileSync(manualFailedArtifacts!.problem, "utf8")).item
        : {
            ...revisionQuestion,
            question: `${revisionQuestion.question} [final recovery preserves the omitted official clause]`,
          };
      const problemRecoveryPath = `problem-recoveries/v1-${String(recoveryTargetPage).padStart(4, "0")}-` +
        `${String(recoveryTargetNumber).padStart(4, "0")}-${basisDigest}.json`;
      const problemRecoveryHash = writeEvidence(join(stateDir, problemRecoveryPath), {
        version: 1,
        entryId: entry.id,
        basisDigest,
        basis: problemBasis,
        promptVersion: TARGETED_PROBLEM_RECOVERY_VERSION,
        promptDigest: TARGETED_RECOVERY_PROMPT_DIGEST,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        item: recoveredQuestion,
      });
      problemRecoveryArtifact = join(stateDir, problemRecoveryPath);
      const problemRecoveryPointer = { path: problemRecoveryPath, sha256: problemRecoveryHash };
      const recoveredQuestionHash = canonicalEvidenceHash(recoveredQuestion);
      const classificationBasis = {
        ...problemBasis,
        problemArtifact: problemRecoveryPointer,
        problemArtifactItemHash: recoveredQuestionHash,
        effectiveQuestionHash: recoveredQuestionHash,
      };
      const classificationBasisDigest = canonicalEvidenceHash(classificationBasis);
      const recoveredClassification = manualSpec
        ? JSON.parse(readFileSync(manualFailedArtifacts!.classification, "utf8")).items[0]
        : {
            ...revisionClassification,
            transcription_status: options.cropAdjudication ? "mismatch" : "exact",
            transcription_evidence: options.cropAdjudication
              ? "the latest bounded recovery still omits allowlisted source-pixel details"
              : "the bounded recovery exactly matches every official source clause",
          };
      const classificationRecoveryPath =
        `classification-recoveries/v1-${String(recoveryTargetPage).padStart(4, "0")}-` +
        `${String(recoveryTargetNumber).padStart(4, "0")}-${classificationBasisDigest}-${DIGEST}.json`;
      const classificationRecoveryHash = writeEvidence(join(stateDir, classificationRecoveryPath), {
        version: 1,
        entryId: entry.id,
        basisDigest: classificationBasisDigest,
        basis: classificationBasis,
        classifierVersion: 5,
        rulesDigest: DIGEST,
        transcriptionGateVersion: 2,
        transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
        recoveryPromptVersion: TARGETED_PROBLEM_RECOVERY_VERSION,
        recoveryPromptDigest: TARGETED_RECOVERY_PROMPT_DIGEST,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        items: [recoveredClassification],
      });
      classificationRecoveryArtifact = join(stateDir, classificationRecoveryPath);
      const recoveredClassificationHash = canonicalEvidenceHash(recoveredClassification);
      (targetRepair.revision as Record<string, unknown>).recovery = {
        key: targetKey,
        printedNumber: String(recoveryTargetNumber),
        sourcePage: recoveryTargetPage,
        sourceHash: downloads.problem.sha256,
        contextFrom: 1,
        contextTo,
        baseProblemRepairArtifact,
        baseProblemRepairItemHash: targetRepair.problemArtifactItemHash,
        baseClassificationRepairArtifact,
        baseClassificationRepairItemHash: targetRepair.classificationArtifactItemHash,
        baseProblemRevisionArtifact,
        baseProblemRevisionItemHash: revisionQuestionHash,
        baseClassificationRevisionArtifact,
        baseClassificationRevisionItemHash: canonicalEvidenceHash(revisionClassification),
        problemArtifact: problemRecoveryPointer,
        problemArtifactItemHash: recoveredQuestionHash,
        classificationArtifact: {
          path: classificationRecoveryPath,
          sha256: classificationRecoveryHash,
          rulesDigest: DIGEST,
          transcriptionGateVersion: 2,
          transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
          recoveryPromptVersion: TARGETED_PROBLEM_RECOVERY_VERSION,
          recoveryPromptDigest: TARGETED_RECOVERY_PROMPT_DIGEST,
        },
        classificationArtifactItemHash: recoveredClassificationHash,
        failedClassificationEvidenceHash,
        baseQuestionHash: revisionQuestionHash,
        effectiveQuestionHash: recoveredQuestionHash,
        baseClassificationHash: canonicalEvidenceHash(revisionClassification),
        effectiveClassificationHash: recoveredClassificationHash,
      };
      let terminalQuestion = recoveredQuestion;
      let terminalClassification = recoveredClassification;
      if (options.cropAdjudication) {
        const parentRecovery = (targetRepair.revision as Record<string, unknown>).recovery as Record<string, unknown>;
        const sourcePages = [11];
        const cropEvidenceBasis = {
          allowlistId: Q29_CROP_SPEC.allowlistId,
          entryId: entry.id,
          key: targetKey,
          sourcePage: recoveryTargetPage,
          sourcePages,
          sourceHash: downloads.problem.sha256,
          dpi: 300,
          views: Q29_CROP_SPEC.views,
          requiredTokens: Q29_CROP_SPEC.requiredTokens,
        };
        const cropEvidenceBasisDigest = canonicalEvidenceHash(cropEvidenceBasis);
        const cropStem = `v1-${String(recoveryTargetPage).padStart(4, "0")}-` +
          `${String(recoveryTargetNumber).padStart(4, "0")}-${cropEvidenceBasisDigest}`;
        const fullWidth = 3508;
        const fullHeight = 4961;
        const cropViews = Q29_CROP_SPEC.views.map((view, index) => {
          const [left, top, right, bottom] = view.rect;
          const pixelWidth = Math.ceil(right * fullWidth) - Math.floor(left * fullWidth);
          const pixelHeight = Math.ceil(bottom * fullHeight) - Math.floor(top * fullHeight);
          const relativePath = `problem-crop-evidence/${cropStem}-view-${String(index).padStart(2, "0")}.png`;
          const absolutePath = join(stateDir, relativePath);
          const bytes = pngHeader(pixelWidth, pixelHeight);
          mkdirSync(join(absolutePath, ".."), { recursive: true });
          writeFileSync(absolutePath, bytes);
          const sha256 = hash(bytes);
          return {
            sourcePage: view.sourcePage,
            label: view.label,
            rect: [...view.rect],
            pixelWidth,
            pixelHeight,
            pixelSha256: sha256,
            artifact: { path: relativePath, sha256 },
          };
        });
        cropViewArtifacts = cropViews.map((view) => join(stateDir, view.artifact.path));
        const cropPdfRelativePath = `problem-crop-evidence/${cropStem}.pdf`;
        const cropPdfBytes = Buffer.from("%PDF-1.4\n% immutable ordered crop evidence fixture\n");
        cropEvidencePdf = join(stateDir, cropPdfRelativePath);
        mkdirSync(join(cropEvidencePdf, ".."), { recursive: true });
        writeFileSync(cropEvidencePdf, cropPdfBytes);
        const cropPdfPointer = { path: cropPdfRelativePath, sha256: hash(cropPdfBytes) };
        const cropEvidenceRelativePath = `problem-crop-evidence/${cropStem}.json`;
        cropEvidenceArtifact = join(stateDir, cropEvidenceRelativePath);
        const cropEvidenceHash = writeEvidence(cropEvidenceArtifact, {
          version: 1,
          entryId: entry.id,
          basisDigest: cropEvidenceBasisDigest,
          basis: cropEvidenceBasis,
          renderer: "pdftocairo-png+pdf-lib",
          dpi: 300,
          evidencePdf: cropPdfPointer,
          views: cropViews,
        });
        const cropEvidencePointer = { path: cropEvidenceRelativePath, sha256: cropEvidenceHash };
        const parentRecoveryEvidenceHash = canonicalEvidenceHash(parentRecovery);
        const commonBasis = {
          allowlistId: Q29_CROP_SPEC.allowlistId,
          entryId: entry.id,
          key: targetKey,
          printedNumber: String(recoveryTargetNumber),
          sourcePage: recoveryTargetPage,
          sourcePages,
          sourceHash: downloads.problem.sha256,
          parentRecovery,
          parentRecoveryEvidenceHash,
          failedRecoveryQuestionHash: canonicalEvidenceHash(recoveredQuestion),
          failedRecoveryClassificationHash: canonicalEvidenceHash(recoveredClassification),
          failedRecoveryEvidenceHash: hash(recoveredClassification.transcription_evidence),
          cropEvidenceArtifact: cropEvidencePointer,
          cropEvidencePdf: cropPdfPointer,
          cropViews,
          requiredTokensHash: canonicalEvidenceHash(Q29_CROP_SPEC.requiredTokens),
        };
        const cropBasisDigest = canonicalEvidenceHash(commonBasis);
        const adjudicationStem = `v1-${String(recoveryTargetPage).padStart(4, "0")}-` +
          `${String(recoveryTargetNumber).padStart(4, "0")}-${cropBasisDigest}`;
        const adjudicatedQuestion = {
          ...recoveredQuestion,
          question: `${recoveredQuestion.question}\n${Q29_CROP_SPEC.requiredTokens.join("\n")}`,
        };
        const adjudicatedQuestionHash = canonicalEvidenceHash(adjudicatedQuestion);
        const problemCropRelativePath = `problem-crop-adjudications/${adjudicationStem}.json`;
        problemCropAdjudicationArtifact = join(stateDir, problemCropRelativePath);
        const problemCropHash = writeEvidence(problemCropAdjudicationArtifact, {
          version: 1,
          entryId: entry.id,
          basisDigest: cropBasisDigest,
          basis: commonBasis,
          promptVersion: TARGETED_PROBLEM_CROP_ADJUDICATION_VERSION,
          promptDigest: TARGETED_CROP_ADJUDICATION_PROMPT_DIGEST,
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          item: adjudicatedQuestion,
        });
        const problemCropPointer = { path: problemCropRelativePath, sha256: problemCropHash };
        const classificationBasis = {
          ...commonBasis,
          problemArtifact: problemCropPointer,
          problemArtifactItemHash: adjudicatedQuestionHash,
          effectiveQuestionHash: adjudicatedQuestionHash,
        };
        const classificationBasisDigest = canonicalEvidenceHash(classificationBasis);
        const adjudicatedClassification = {
          ...recoveredClassification,
          transcription_status: "exact",
          transcription_evidence: "all allowlisted full-page and crop source pixels match exactly",
        };
        const adjudicatedClassificationHash = canonicalEvidenceHash(adjudicatedClassification);
        const classificationCropRelativePath = `classification-crop-adjudications/` +
          `v1-${String(recoveryTargetPage).padStart(4, "0")}-` +
          `${String(recoveryTargetNumber).padStart(4, "0")}-${classificationBasisDigest}-${DIGEST}.json`;
        classificationCropAdjudicationArtifact = join(stateDir, classificationCropRelativePath);
        const classificationCropHash = writeEvidence(classificationCropAdjudicationArtifact, {
          version: 1,
          entryId: entry.id,
          basisDigest: classificationBasisDigest,
          basis: classificationBasis,
          classifierVersion: 5,
          rulesDigest: DIGEST,
          transcriptionGateVersion: 2,
          transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
          adjudicationPromptVersion: TARGETED_PROBLEM_CROP_ADJUDICATION_VERSION,
          adjudicationPromptDigest: TARGETED_CROP_ADJUDICATION_PROMPT_DIGEST,
          classificationPromptDigest: CROP_ADJUDICATION_CLASSIFICATION_PROMPT_DIGEST,
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          items: [adjudicatedClassification],
        });
        parentRecovery.adjudication = {
          allowlistId: Q29_CROP_SPEC.allowlistId,
          key: targetKey,
          printedNumber: String(recoveryTargetNumber),
          sourcePage: recoveryTargetPage,
          sourcePages,
          sourceHash: downloads.problem.sha256,
          parentRecoveryEvidenceHash,
          cropEvidenceArtifact: cropEvidencePointer,
          cropEvidencePdf: cropPdfPointer,
          cropViews,
          problemArtifact: {
            ...problemCropPointer,
            promptVersion: TARGETED_PROBLEM_CROP_ADJUDICATION_VERSION,
            promptDigest: TARGETED_CROP_ADJUDICATION_PROMPT_DIGEST,
          },
          problemArtifactItemHash: adjudicatedQuestionHash,
          classificationArtifact: {
            path: classificationCropRelativePath,
            sha256: classificationCropHash,
            rulesDigest: DIGEST,
            transcriptionGateVersion: 2,
            transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
            adjudicationPromptVersion: TARGETED_PROBLEM_CROP_ADJUDICATION_VERSION,
            adjudicationPromptDigest: TARGETED_CROP_ADJUDICATION_PROMPT_DIGEST,
            classificationPromptDigest: CROP_ADJUDICATION_CLASSIFICATION_PROMPT_DIGEST,
          },
          classificationArtifactItemHash: adjudicatedClassificationHash,
          baseQuestionHash: canonicalEvidenceHash(recoveredQuestion),
          effectiveQuestionHash: adjudicatedQuestionHash,
          baseClassificationHash: canonicalEvidenceHash(recoveredClassification),
          effectiveClassificationHash: adjudicatedClassificationHash,
        };
        terminalQuestion = adjudicatedQuestion;
        terminalClassification = adjudicatedClassification;
      }
      if (manualSpec) {
        const parentRecovery = (targetRepair.revision as Record<string, unknown>).recovery as Record<string, unknown>;
        expect(canonicalEvidenceHash(recoveredQuestion)).toBe(manualSpec.failedQuestionHash);
        expect(canonicalEvidenceHash(recoveredClassification)).toBe(manualSpec.failedClassificationHash);
        expect(hash(recoveredClassification.transcription_evidence)).toBe(
          manualSpec.failedClassificationEvidenceHash,
        );
        const sourcePages = [...new Set(manualSpec.views.map((view) => view.sourcePage))]
          .sort((left, right) => left - right);
        const manualDpi = manualSpec.dpi ?? 300;
        const evidenceBasis = {
          allowlistId: manualSpec.allowlistId,
          entryId: entry.id,
          key: targetKey,
          sourcePage: recoveryTargetPage,
          sourcePages,
          sourceHash: downloads.problem.sha256,
          dpi: manualDpi,
          views: manualSpec.views,
          requiredTokens: manualSpec.requiredTokens,
        };
        const evidenceDigest = canonicalEvidenceHash(evidenceBasis);
        const evidenceStem = `v1-${String(recoveryTargetPage).padStart(4, "0")}-` +
          `${String(recoveryTargetNumber).padStart(4, "0")}-${evidenceDigest}`;
        const cropViews = manualSpec.views.map((view, index) => {
          const [left, top, right, bottom] = view.rect;
          const pageWidth = Math.round(3508 * manualDpi / 300);
          const pageHeight = Math.round(4961 * manualDpi / 300);
          const pixelWidth = Math.ceil(right * pageWidth) - Math.floor(left * pageWidth);
          const pixelHeight = Math.ceil(bottom * pageHeight) - Math.floor(top * pageHeight);
          const relativePath = `problem-manual-evidence/${evidenceStem}-view-` +
            `${String(index).padStart(2, "0")}.png`;
          const absolutePath = join(stateDir, relativePath);
          const bytes = pngHeader(pixelWidth, pixelHeight);
          mkdirSync(join(absolutePath, ".."), { recursive: true });
          writeFileSync(absolutePath, bytes);
          const sha256 = hash(bytes);
          return {
            sourcePage: view.sourcePage,
            label: view.label,
            rect: [...view.rect],
            pixelWidth,
            pixelHeight,
            pixelSha256: sha256,
            artifact: { path: relativePath, sha256 },
          };
        });
        manualViewArtifacts = cropViews.map((view) => join(stateDir, view.artifact.path));
        const pdfRelativePath = `problem-manual-evidence/${evidenceStem}.pdf`;
        manualEvidencePdf = join(stateDir, pdfRelativePath);
        const pdfBytes = Buffer.from("%PDF-1.4\n% deterministic manual evidence fixture\n");
        mkdirSync(join(manualEvidencePdf, ".."), { recursive: true });
        writeFileSync(manualEvidencePdf, pdfBytes);
        const pdfPointer = { path: pdfRelativePath, sha256: hash(pdfBytes) };
        const evidenceRelativePath = `problem-manual-evidence/${evidenceStem}.json`;
        manualEvidenceArtifact = join(stateDir, evidenceRelativePath);
        const evidenceHash = writeEvidence(manualEvidenceArtifact, {
          version: 1,
          entryId: entry.id,
          basisDigest: evidenceDigest,
          basis: evidenceBasis,
          renderer: "pdftocairo-png+pdf-lib",
          dpi: manualDpi,
          evidencePdf: pdfPointer,
          views: cropViews,
        });
        const evidencePointer = { path: evidenceRelativePath, sha256: evidenceHash };
        const parentRecoveryEvidenceHash = canonicalEvidenceHash(parentRecovery);
        const correctionSpecHash = canonicalEvidenceHash({
          allowlistId: manualSpec.allowlistId,
          parentKind: manualSpec.parentKind,
          views: manualSpec.views,
          ...(manualSpec.dpi ? { dpi: manualSpec.dpi } : {}),
          requiredTokens: manualSpec.requiredTokens,
          replacements: manualSpec.replacements,
          figure: manualSpec.figure,
          figureDescription: manualSpec.figureDescription,
          ...(manualSpec.expectedDecision ? { expectedDecision: manualSpec.expectedDecision } : {}),
          ...(manualSpec.expectedCanonicalSubject
            ? { expectedCanonicalSubject: manualSpec.expectedCanonicalSubject }
            : {}),
        });
        const commonBasis = {
          allowlistId: manualSpec.allowlistId,
          entryId: entry.id,
          key: targetKey,
          printedNumber: String(recoveryTargetNumber),
          sourcePage: recoveryTargetPage,
          sourcePages,
          sourceHash: downloads.problem.sha256,
          parentRecovery,
          parentRecoveryEvidenceHash,
          failedQuestionHash: manualSpec.failedQuestionHash,
          failedClassificationHash: manualSpec.failedClassificationHash,
          failedClassificationEvidenceHash: manualSpec.failedClassificationEvidenceHash,
          correctionSpecHash,
          cropEvidenceArtifact: evidencePointer,
          cropEvidencePdf: pdfPointer,
          cropViews,
        };
        const manualBasisDigest = canonicalEvidenceHash(commonBasis);
        const correctedQuestion = applyAllowlistedProblemManualCorrection(
          entry.id,
          downloads.problem.sha256,
          recoveredQuestion,
        );
        const correctedQuestionHash = canonicalEvidenceHash(correctedQuestion);
        const problemRelativePath = `problem-manual-adjudications/v1-` +
          `${String(recoveryTargetPage).padStart(4, "0")}-` +
          `${String(recoveryTargetNumber).padStart(4, "0")}-${manualBasisDigest}.json`;
        problemManualAdjudicationArtifact = join(stateDir, problemRelativePath);
        const problemHash = writeEvidence(problemManualAdjudicationArtifact, {
          version: 1,
          entryId: entry.id,
          basisDigest: manualBasisDigest,
          basis: commonBasis,
          correctionVersion: 1,
          correctionDigest: PROBLEM_MANUAL_CORRECTION_DIGEST,
          item: correctedQuestion,
        });
        const problemPointer = { path: problemRelativePath, sha256: problemHash };
        const classificationBasis = {
          ...commonBasis,
          problemArtifact: problemPointer,
          problemArtifactItemHash: correctedQuestionHash,
          effectiveQuestionHash: correctedQuestionHash,
        };
        const classificationBasisDigest = canonicalEvidenceHash(classificationBasis);
        const expectedAccept = manualSpec.expectedDecision === "accept";
        const finalClassification = {
          ...recoveredClassification,
          ...(options.manualInvalidDecision ? {
            ...(expectedAccept ? {
              decision: "reject",
              canonical_subject: null,
              curriculum_course: null,
              domain: null,
              achievement_codes: [],
              reason_codes: ["OUT_OF_SCOPE"],
            } : {
              decision: "accept",
              canonical_subject: "math_B",
              curriculum_course: "2015 수학Ⅰ",
              domain: "지수함수와 로그함수",
              achievement_codes: ["12수학Ⅰ01-07"],
              reason_codes: ["IN_SCOPE_LOGARITHMS"],
            }),
          } : expectedAccept ? {
            decision: "accept",
            canonical_subject: manualSpec.expectedCanonicalSubject,
            curriculum_course: recoveredClassification.curriculum_course,
            domain: recoveredClassification.domain,
            achievement_codes: recoveredClassification.achievement_codes,
            reason_codes: recoveredClassification.reason_codes,
          } : {
            decision: "reject",
            canonical_subject: null,
            curriculum_course: null,
            domain: null,
            achievement_codes: [],
            reason_codes: ["OUT_OF_SCOPE"],
          }),
          transcription_status: "exact",
          transcription_evidence: "all ordered manual evidence views match the corrected literal item exactly",
        };
        const finalClassificationHash = canonicalEvidenceHash(finalClassification);
        const classificationRelativePath = `classification-manual-adjudications/v1-` +
          `${String(recoveryTargetPage).padStart(4, "0")}-` +
          `${String(recoveryTargetNumber).padStart(4, "0")}-${classificationBasisDigest}-${DIGEST}.json`;
        classificationManualAdjudicationArtifact = join(stateDir, classificationRelativePath);
        const classificationHash = writeEvidence(classificationManualAdjudicationArtifact, {
          version: 1,
          entryId: entry.id,
          basisDigest: classificationBasisDigest,
          basis: classificationBasis,
          classifierVersion: 5,
          rulesDigest: DIGEST,
          transcriptionGateVersion: 2,
          transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
          adjudicationVersion: 1,
          adjudicationPromptDigest: PROBLEM_MANUAL_ADJUDICATION_PROMPT_DIGEST,
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          items: [finalClassification],
        });
        parentRecovery.manualAdjudication = {
          allowlistId: manualSpec.allowlistId,
          key: targetKey,
          printedNumber: String(recoveryTargetNumber),
          sourcePage: recoveryTargetPage,
          sourcePages,
          sourceHash: downloads.problem.sha256,
          parentRecoveryEvidenceHash,
          failedQuestionHash: manualSpec.failedQuestionHash,
          failedClassificationHash: manualSpec.failedClassificationHash,
          failedClassificationEvidenceHash: manualSpec.failedClassificationEvidenceHash,
          correctionSpecHash,
          cropEvidenceArtifact: evidencePointer,
          cropEvidencePdf: pdfPointer,
          cropViews,
          problemArtifact: {
            ...problemPointer,
            correctionVersion: 1,
            correctionDigest: PROBLEM_MANUAL_CORRECTION_DIGEST,
          },
          problemArtifactItemHash: correctedQuestionHash,
          classificationArtifact: {
            path: classificationRelativePath,
            sha256: classificationHash,
            rulesDigest: DIGEST,
            transcriptionGateVersion: 2,
            transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
            adjudicationVersion: 1,
            adjudicationPromptDigest: PROBLEM_MANUAL_ADJUDICATION_PROMPT_DIGEST,
          },
          classificationArtifactItemHash: finalClassificationHash,
          baseQuestionHash: manualSpec.failedQuestionHash,
          effectiveQuestionHash: correctedQuestionHash,
          baseClassificationHash: manualSpec.failedClassificationHash,
          effectiveClassificationHash: finalClassificationHash,
        };
        terminalQuestion = correctedQuestion;
        terminalClassification = finalClassification;
      }
      if (options.scopeAdjudication) {
        const parentRecovery = (targetRepair.revision as Record<string, unknown>).recovery as Record<string, unknown>;
        const preAdjudicationProblems = effectiveProblems.map(
          (question: Record<string, unknown>) => ({ ...question }),
        );
        const preAdjudicationClassifications = effectiveClassifications.map(
          (item: Record<string, unknown>) => ({ ...item }),
        );
        preAdjudicationProblems[targetIndex] = recoveredQuestion;
        preAdjudicationClassifications[targetIndex] = recoveredClassification;
        const preAdjudicationCorpus = preAdjudicationProblems.map(
          (question: Record<string, unknown>, index: number) => ({
          question,
          classification: preAdjudicationClassifications[index],
          }),
        ).sort((
          left: { question: Record<string, unknown> },
          right: { question: Record<string, unknown> },
        ) => Number(left.question.page) - Number(right.question.page)
          || Number(left.question.number) - Number(right.question.number));
        const preAdjudicationEffectiveCorpusHash = canonicalEvidenceHash(preAdjudicationCorpus);
        const preTerminalInputs = preAdjudicationCorpus.map(({ question }: {
          question: Record<string, unknown>;
        }) => ({
          key: `${question.page}:${question.number}`,
          printed_number: String(question.number),
          source_page: question.page,
          qtype: question.qtype,
          question: question.question,
          choices: question.choices,
          figure: question.figure,
          figure_description: question.figure_description,
          box: question.box,
        }));
        const preTerminalItems = preTerminalInputs.map((input: Record<string, unknown>) => {
          const number = Number(input.printed_number);
          const current = preAdjudicationClassifications[number - 1];
          const conflict = input.key === targetKey;
          const independentlyRejectedMismatch = current.decision === "reject"
            && current.transcription_status === "mismatch";
          return {
            key: input.key,
            status: independentlyRejectedMismatch ? "mismatch" : "exact",
            evidence: conflict
              ? "the final transcription exactly matches the official problem pixels"
              : independentlyRejectedMismatch
                ? "the independent terminal check confirms the rejected abbreviated source"
              : "the final transcription is exact",
            scopeDecision: conflict ? "reject" : current.decision,
            scopeConfidence: 0.99,
            scopeEvidence: conflict
              ? "the official problem and solution require excluded coordinate geometry"
              : "the official source independently establishes the curriculum scope",
          };
        }).sort((left: { key: string }, right: { key: string }) =>
          compareCorpusQuestionKeys(left.key, right.key));
        const preTerminalInputHash = canonicalEvidenceHash(preTerminalInputs);
        const preTerminalPath = `problem-terminal-fidelity/v2-0000-` +
          `${preAdjudicationEffectiveCorpusHash}-${preTerminalInputHash}.json`;
        const preTerminalHash = writeEvidence(join(stateDir, preTerminalPath), {
          version: 2,
          entryId: entry.id,
          sourceHash: downloads.problem.sha256,
          from: 1,
          to: contextTo,
          ownedFrom: 1,
          ownedTo: contextTo,
          effectiveCorpusHash: preAdjudicationEffectiveCorpusHash,
          inputHash: preTerminalInputHash,
          transcriptionGateVersion: 2,
          transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
          rulesDigest: DIGEST,
          scopePromptDigest: PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST,
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          inputs: preTerminalInputs,
          items: preTerminalItems,
        });
        const terminalCheckpoint = {
          path: preTerminalPath,
          sha256: preTerminalHash,
          from: 1,
          to: contextTo,
          ownedFrom: 1,
          ownedTo: contextTo,
          inputHash: preTerminalInputHash,
        };
        const terminalItem = preTerminalItems.find((item: { key: string }) => item.key === targetKey)!;
        const trigger = {
          terminalCheckpoint,
          terminalItemHash: canonicalEvidenceHash(terminalItem),
          terminalItem,
          evidenceHash: hash(terminalItem.evidence),
          scopeEvidenceHash: hash(terminalItem.scopeEvidence),
          preAdjudicationEffectiveCorpusHash,
        };
        const solutionCheckpointPath = join(stateDir, "solution-chunks", "v3-0000.json");
        const solutionCheckpoint = JSON.parse(readFileSync(solutionCheckpointPath, "utf8"));
        const solutionItem = solutionCheckpoint.items.find(
          (item: { number: string }) => item.number === String(recoveryTargetNumber),
        );
        const baseSolutionCheckpoint = {
          path: "solution-chunks/v3-0000.json",
          sha256: hash(readFileSync(solutionCheckpointPath)),
        };
        const parentRecoveryEvidenceHash = canonicalEvidenceHash(parentRecovery);
        const basis = {
          allowlistId: Q11_SCOPE_SPEC.allowlistId,
          entryId: entry.id,
          key: targetKey,
          printedNumber: String(recoveryTargetNumber),
          sourcePage: recoveryTargetPage,
          sourceHash: downloads.problem.sha256,
          solutionSourceHash: downloads.solution.sha256,
          problemContextFrom: 1,
          problemContextTo: contextTo,
          solutionContextFrom: 1,
          solutionContextTo: 5,
          baseSolutionCheckpoint,
          baseSolutionItemHash: canonicalEvidenceHash(solutionItem),
          parentRecovery,
          parentRecoveryEvidenceHash,
          trigger,
          baseQuestionHash: canonicalEvidenceHash(recoveredQuestion),
          baseClassificationHash: canonicalEvidenceHash(recoveredClassification),
        };
        const basisDigest = canonicalEvidenceHash(basis);
        const adjudicatedClassification = {
          ...recoveredClassification,
          decision: "reject",
          canonical_subject: null,
          curriculum_course: null,
          domain: null,
          achievement_codes: [],
          confidence: 0.99,
          reason_codes: ["COORDINATE_GEOMETRY_REQUIRED"],
          transcription_status: "exact",
          transcription_evidence: "the official problem transcription remains exact",
        };
        const classificationPath = `classification-scope-adjudications/v1-` +
          `${String(recoveryTargetPage).padStart(4, "0")}-` +
          `${String(recoveryTargetNumber).padStart(4, "0")}-${basisDigest}-${DIGEST}.json`;
        classificationScopeAdjudicationArtifact = join(stateDir, classificationPath);
        const classificationHash = writeEvidence(classificationScopeAdjudicationArtifact, {
          version: 1,
          entryId: entry.id,
          basisDigest,
          basis,
          classifierVersion: 5,
          rulesDigest: DIGEST,
          transcriptionGateVersion: 2,
          transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
          adjudicationPromptVersion: 1,
          adjudicationPromptDigest: Q11_SCOPE_SPEC.promptDigest,
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          items: [adjudicatedClassification],
        });
        const adjudicatedClassificationHash = canonicalEvidenceHash(adjudicatedClassification);
        parentRecovery.scopeAdjudication = {
          allowlistId: Q11_SCOPE_SPEC.allowlistId,
          key: targetKey,
          printedNumber: String(recoveryTargetNumber),
          sourcePage: recoveryTargetPage,
          sourceHash: downloads.problem.sha256,
          solutionSourceHash: downloads.solution.sha256,
          problemContextFrom: 1,
          problemContextTo: contextTo,
          solutionContextFrom: 1,
          solutionContextTo: 5,
          baseSolutionCheckpoint,
          baseSolutionItemHash: canonicalEvidenceHash(solutionItem),
          parentRecoveryEvidenceHash,
          trigger,
          classificationArtifact: {
            path: classificationPath,
            sha256: classificationHash,
            rulesDigest: DIGEST,
            transcriptionGateVersion: 2,
            transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
            adjudicationPromptVersion: 1,
            adjudicationPromptDigest: Q11_SCOPE_SPEC.promptDigest,
          },
          classificationArtifactItemHash: adjudicatedClassificationHash,
          baseQuestionHash: canonicalEvidenceHash(recoveredQuestion),
          effectiveQuestionHash: canonicalEvidenceHash(recoveredQuestion),
          baseClassificationHash: canonicalEvidenceHash(recoveredClassification),
          effectiveClassificationHash: adjudicatedClassificationHash,
        };
        terminalQuestion = recoveredQuestion;
        terminalClassification = adjudicatedClassification;
      }
      effectiveProblems[targetIndex] = terminalQuestion;
      effectiveClassifications[targetIndex] = terminalClassification;
    } else if (options.terminalRecovery || options.mixedTerminalRecovery) {
      if (!options.terminalScope) throw new Error("terminal recovery fixture requires terminal scope v2");
      effectiveProblems[targetIndex] = revisionQuestion;
      effectiveClassifications[targetIndex] = revisionClassification;
      const preRecoveryCorpus = effectiveProblems.map((question: Record<string, unknown>, index: number) => ({
        question,
        classification: effectiveClassifications[index],
      }));
      const preRecoveryEffectiveCorpusHash = canonicalEvidenceHash(preRecoveryCorpus);
      const recoveryTerminalInputs = effectiveProblems.map((question: Record<string, unknown>) => ({
        key: `${question.page}:${question.number}`,
        printed_number: String(question.number),
        source_page: question.page,
        qtype: question.qtype,
        question: question.question,
        choices: question.choices,
        figure: question.figure,
        figure_description: question.figure_description,
        box: question.box,
      }));
      const recoveryTerminalItems = recoveryTerminalInputs.map((input: { key: string }) => ({
        key: input.key,
        status: input.key === targetKey || options.mixedTerminalRecovery && ["1:10", "1:20"].includes(input.key)
          ? "mismatch" : "exact",
        evidence: input.key === targetKey
          ? "the fresh terminal gate found one remaining source-pixel mismatch"
          : options.mixedTerminalRecovery && input.key === "1:10"
            ? "the same terminal gate found a new sibling source-pixel mismatch"
          : options.mixedTerminalRecovery && input.key === "1:20"
            ? "the independent scope gate authorizes this unrepaired rejected mismatch"
          : "the final transcription is exact",
        scopeDecision: effectiveClassifications[Number(input.key.split(":")[1]) - 1].decision,
        scopeConfidence: 0.99,
        scopeEvidence: "the official source page independently establishes the curriculum scope",
      })).sort((left: { key: string }, right: { key: string }) =>
        compareCorpusQuestionKeys(left.key, right.key));
      const recoveryTerminalInputHash = canonicalEvidenceHash(recoveryTerminalInputs);
      const recoveryTerminalPath = `problem-terminal-fidelity/v2-0000-` +
        `${preRecoveryEffectiveCorpusHash}-${recoveryTerminalInputHash}.json`;
      const recoveryTerminalHash = writeEvidence(join(stateDir, recoveryTerminalPath), {
        version: 2,
        entryId: entry.id,
        sourceHash: downloads.problem.sha256,
        from: 1,
        to: contextTo,
        ownedFrom: 1,
        ownedTo: contextTo,
        effectiveCorpusHash: preRecoveryEffectiveCorpusHash,
        inputHash: recoveryTerminalInputHash,
        transcriptionGateVersion: 2,
        transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
        rulesDigest: DIGEST,
        scopePromptDigest: PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        inputs: recoveryTerminalInputs,
        items: recoveryTerminalItems,
      });
      const recoveryTerminalItem = recoveryTerminalItems.find((item: { key: string }) =>
        item.key === targetKey)!;
      const recoveryTerminalPointer = {
        path: recoveryTerminalPath,
        sha256: recoveryTerminalHash,
        from: 1,
        to: contextTo,
        ownedFrom: 1,
        ownedTo: contextTo,
        inputHash: recoveryTerminalInputHash,
      };
      const recoveryTrigger = {
        kind: "terminal",
        evidenceHash: hash(recoveryTerminalItem.evidence),
        terminalCheckpoint: recoveryTerminalPointer,
        terminalItemHash: canonicalEvidenceHash(recoveryTerminalItem),
        terminalItem: recoveryTerminalItem,
        preRecoveryEffectiveCorpusHash,
      };
      const baseProblemRevisionArtifact = { path: revisionProblemPath, sha256: revisionProblemHash };
      const baseClassificationRevisionArtifact = {
        path: revisionClassificationPath,
        sha256: revisionClassificationHash,
      };
      const problemBasis = {
        key: targetKey,
        printedNumber: "3",
        sourcePage: 1,
        sourceHash: downloads.problem.sha256,
        contextFrom: 1,
        contextTo: 1,
        baseProblemRepairArtifact,
        baseProblemRepairItemHash: targetRepair.problemArtifactItemHash,
        baseClassificationRepairArtifact,
        baseClassificationRepairItemHash: targetRepair.classificationArtifactItemHash,
        baseProblemRevisionArtifact,
        baseProblemRevisionItemHash: revisionQuestionHash,
        baseClassificationRevisionArtifact,
        baseClassificationRevisionItemHash: canonicalEvidenceHash(revisionClassification),
        baseQuestionHash: revisionQuestionHash,
        baseClassificationHash: canonicalEvidenceHash(revisionClassification),
        trigger: recoveryTrigger,
      };
      const basisDigest = canonicalEvidenceHash(problemBasis);
      const recoveredQuestion = {
        ...revisionQuestion,
        question: `${revisionQuestion.question} [terminal recovery restores the final source pixels]`,
      };
      const problemRecoveryPath = `problem-recoveries/v2-0001-0003-${basisDigest}.json`;
      const problemRecoveryHash = writeEvidence(join(stateDir, problemRecoveryPath), {
        version: 2,
        entryId: entry.id,
        basisDigest,
        basis: problemBasis,
        promptVersion: TARGETED_PROBLEM_RECOVERY_VERSION,
        promptDigest: TARGETED_RECOVERY_PROMPT_DIGEST,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        item: recoveredQuestion,
      });
      problemRecoveryArtifact = join(stateDir, problemRecoveryPath);
      const problemRecoveryPointer = { path: problemRecoveryPath, sha256: problemRecoveryHash };
      const recoveredQuestionHash = canonicalEvidenceHash(recoveredQuestion);
      const classificationBasis = {
        ...problemBasis,
        problemArtifact: problemRecoveryPointer,
        problemArtifactItemHash: recoveredQuestionHash,
        effectiveQuestionHash: recoveredQuestionHash,
      };
      const classificationBasisDigest = canonicalEvidenceHash(classificationBasis);
      const recoveredClassification = {
        ...revisionClassification,
        transcription_evidence: "the terminal recovery exactly matches every official source pixel",
      };
      const classificationRecoveryPath =
        `classification-recoveries/v2-0001-0003-${classificationBasisDigest}-${DIGEST}.json`;
      const classificationRecoveryHash = writeEvidence(join(stateDir, classificationRecoveryPath), {
        version: 2,
        entryId: entry.id,
        basisDigest: classificationBasisDigest,
        basis: classificationBasis,
        classifierVersion: 5,
        rulesDigest: DIGEST,
        transcriptionGateVersion: 2,
        transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
        recoveryPromptVersion: TARGETED_PROBLEM_RECOVERY_VERSION,
        recoveryPromptDigest: TARGETED_RECOVERY_PROMPT_DIGEST,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        items: [recoveredClassification],
      });
      classificationRecoveryArtifact = join(stateDir, classificationRecoveryPath);
      const recoveredClassificationHash = canonicalEvidenceHash(recoveredClassification);
      (targetRepair.revision as Record<string, unknown>).recovery = {
        key: targetKey,
        printedNumber: "3",
        sourcePage: 1,
        sourceHash: downloads.problem.sha256,
        contextFrom: 1,
        contextTo: 1,
        baseProblemRepairArtifact,
        baseProblemRepairItemHash: targetRepair.problemArtifactItemHash,
        baseClassificationRepairArtifact,
        baseClassificationRepairItemHash: targetRepair.classificationArtifactItemHash,
        baseProblemRevisionArtifact,
        baseProblemRevisionItemHash: revisionQuestionHash,
        baseClassificationRevisionArtifact,
        baseClassificationRevisionItemHash: canonicalEvidenceHash(revisionClassification),
        problemArtifact: problemRecoveryPointer,
        problemArtifactItemHash: recoveredQuestionHash,
        classificationArtifact: {
          path: classificationRecoveryPath,
          sha256: classificationRecoveryHash,
          rulesDigest: DIGEST,
          transcriptionGateVersion: 2,
          transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
          recoveryPromptVersion: TARGETED_PROBLEM_RECOVERY_VERSION,
          recoveryPromptDigest: TARGETED_RECOVERY_PROMPT_DIGEST,
        },
        classificationArtifactItemHash: recoveredClassificationHash,
        trigger: recoveryTrigger,
        baseQuestionHash: revisionQuestionHash,
        effectiveQuestionHash: recoveredQuestionHash,
        baseClassificationHash: canonicalEvidenceHash(revisionClassification),
        effectiveClassificationHash: recoveredClassificationHash,
      };
      effectiveProblems[targetIndex] = recoveredQuestion;
      effectiveClassifications[targetIndex] = recoveredClassification;
      if (options.mixedTerminalRecovery) {
        const siblingIndex = 9;
        const siblingKey = "1:10";
        const siblingRepair = repairs.find((repair) => repair.key === siblingKey)!;
        const siblingTerminalItem = recoveryTerminalItems.find((item: { key: string }) =>
          item.key === siblingKey)!;
        const siblingTrigger = {
          kind: "terminal",
          evidenceHash: hash(siblingTerminalItem.evidence),
          terminalCheckpoint: recoveryTerminalPointer,
          terminalItemHash: canonicalEvidenceHash(siblingTerminalItem),
        };
        const siblingBaseQuestion = effectiveProblems[siblingIndex];
        const siblingBaseClassification = effectiveClassifications[siblingIndex];
        const siblingProblemRepairArtifact = siblingRepair.problemArtifact as { path: string; sha256: string };
        const siblingClassificationRepairArtifact = {
          path: (siblingRepair.classificationArtifact as Record<string, unknown>).path,
          sha256: (siblingRepair.classificationArtifact as Record<string, unknown>).sha256,
        };
        const siblingMember = {
          key: siblingKey,
          printedNumber: "10",
          sourcePage: 1,
          baseProblemRepairArtifact: siblingProblemRepairArtifact,
          baseProblemRepairItemHash: siblingRepair.problemArtifactItemHash,
          baseClassificationRepairArtifact: siblingClassificationRepairArtifact,
          baseClassificationRepairItemHash: siblingRepair.classificationArtifactItemHash,
          baseQuestionHash: canonicalEvidenceHash(siblingBaseQuestion),
          baseClassificationHash: canonicalEvidenceHash(siblingBaseClassification),
          trigger: siblingTrigger,
        };
        const siblingMembersDigest = canonicalEvidenceHash([siblingMember]);
        const siblingQuestion = {
          ...siblingBaseQuestion,
          question: `${siblingBaseQuestion.question} [same-pass terminal revision]`,
        };
        const siblingProblemPath =
          `problem-revision-batches/v1-0001-0001-0001-${siblingMembersDigest}.json`;
        const siblingProblemHash = writeEvidence(join(stateDir, siblingProblemPath), {
          version: 1,
          entryId: entry.id,
          sourceHash: downloads.problem.sha256,
          contextFrom: 1,
          contextTo: 1,
          sourcePage: 1,
          membersDigest: siblingMembersDigest,
          members: [siblingMember],
          batchPromptVersion: TARGETED_PROBLEM_BATCH_VERSION,
          batchPromptDigest: TARGETED_BATCH_PROMPT_DIGEST,
          revisionPromptVersion: TARGETED_PROBLEM_REVISION_VERSION,
          revisionPromptDigest: TARGETED_BATCH_REVISION_PROMPT_DIGEST,
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          items: [siblingQuestion],
        });
        const siblingQuestionHash = canonicalEvidenceHash(siblingQuestion);
        const siblingClassificationMember = {
          key: siblingKey,
          problemAuthority: {
            key: siblingKey,
            path: siblingProblemPath,
            sha256: siblingProblemHash,
            itemHash: siblingQuestionHash,
          },
          effectiveQuestionHash: siblingQuestionHash,
          baseClassificationRepairArtifact: siblingClassificationRepairArtifact,
          baseClassificationRepairItemHash: siblingRepair.classificationArtifactItemHash,
          triggerHash: canonicalEvidenceHash(siblingTrigger),
        };
        const siblingOverlayDigest = canonicalEvidenceHash([siblingClassificationMember]);
        const siblingClassification = {
          ...siblingBaseClassification,
          transcription_status: "exact",
          transcription_evidence: "the same-pass terminal revision is exact",
        };
        const siblingClassificationPath =
          `classification-revision-batches/v1-0001-0001-${siblingOverlayDigest}-${DIGEST}.json`;
        const siblingClassificationHash = writeEvidence(join(stateDir, siblingClassificationPath), {
          version: 1,
          entryId: entry.id,
          sourceHash: downloads.problem.sha256,
          contextFrom: 1,
          contextTo: 1,
          overlayDigest: siblingOverlayDigest,
          classifierVersion: 5,
          rulesDigest: DIGEST,
          transcriptionGateVersion: 2,
          transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          members: [siblingClassificationMember],
          items: [siblingClassification],
        });
        siblingRepair.revision = {
          baseProblemRepairArtifact: siblingProblemRepairArtifact,
          baseClassificationRepairArtifact: siblingClassificationRepairArtifact,
          problemArtifact: { path: siblingProblemPath, sha256: siblingProblemHash },
          classificationArtifact: {
            path: siblingClassificationPath,
            sha256: siblingClassificationHash,
            rulesDigest: DIGEST,
            transcriptionGateVersion: 2,
            transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
          },
          diagnosticEvidenceHash: siblingTrigger.evidenceHash,
          baseQuestionHash: siblingMember.baseQuestionHash,
          effectiveQuestionHash: siblingQuestionHash,
          baseClassificationHash: siblingMember.baseClassificationHash,
          effectiveClassificationHash: canonicalEvidenceHash(siblingClassification),
          problemArtifactItemHash: siblingQuestionHash,
          classificationArtifactItemHash: canonicalEvidenceHash(siblingClassification),
          trigger: siblingTrigger,
        };
        effectiveProblems[siblingIndex] = siblingQuestion;
        effectiveClassifications[siblingIndex] = siblingClassification;
      }
    } else {
      effectiveProblems[targetIndex] = revisionQuestion;
      effectiveClassifications[targetIndex] = revisionClassification;
    }
  }

  const effectiveCorpus = effectiveProblems.map((question: Record<string, unknown>, index: number) => ({
    question,
    classification: effectiveClassifications[index],
  })).sort((
    left: { question: Record<string, unknown> },
    right: { question: Record<string, unknown> },
  ) =>
    Number(left.question.page) - Number(right.question.page)
    || Number(left.question.number) - Number(right.question.number));
  const effectiveCorpusHash = canonicalEvidenceHash(effectiveCorpus);
  const terminalVersion = options.terminalScope ? 2 : 1;
  if (options.answerV5 && !options.terminalScope) throw new Error("answer v5 fixture requires terminal scope v2");
  const answerAuditVersion = options.answerV5 ? 5 : options.terminalScope ? 4 : 3;
  const terminalInputs = effectiveCorpus.map(({
    question,
  }: { question: Record<string, unknown> }) => ({
    key: `${question.page}:${question.number}`,
    printed_number: String(question.number),
    source_page: question.page,
    qtype: question.qtype,
    question: question.question,
    choices: question.choices,
    figure: question.figure,
    figure_description: question.figure_description,
    box: question.box,
  }));
  const terminalItems = terminalInputs.map((input: { key: string }) => {
    const number = Number(input.key.split(":")[1]);
    const classificationItem = effectiveClassifications[number - 1];
    if (!options.terminalScope) return {
      key: input.key,
      status: "exact",
      evidence: "final transcription exactly matches every official source pixel",
    };
    const targetReject = (
      number === 3 && classificationItem.transcription_status === "mismatch"
      && options.terminalScope !== "accepted-scope-reject"
    ) || Boolean(options.mixedTerminalRecovery && number === 20);
    const acceptedScopeReject = number === 1 && options.terminalScope === "accepted-scope-reject";
    const positiveScopeReject = positiveRepairScopeSpec?.key === input.key;
    const scopeDecision = targetReject && options.terminalScope === "scope-accept"
      ? "accept"
      : acceptedScopeReject || positiveScopeReject ? "reject" : classificationItem.decision;
    return {
      key: input.key,
      status: targetReject && options.terminalScope !== "terminal-exact" ? "mismatch" : "exact",
      evidence: targetReject
        ? "official pixels confirm the omitted detail"
        : "final transcription exactly matches every official source pixel",
      scopeDecision,
      scopeConfidence: targetReject && options.terminalScope === "low-confidence" ? 0.89 : 0.99,
      scopeEvidence: "the official source page independently establishes the required curriculum scope",
    };
  }).sort((left: { key: string }, right: { key: string }) => compareCorpusQuestionKeys(left.key, right.key));
  const terminalInputHash = canonicalEvidenceHash(terminalInputs);
  const terminalRelativePath =
    `problem-terminal-fidelity/v${terminalVersion}-0000-${effectiveCorpusHash}-${terminalInputHash}.json`;
  const terminalCheckpoint = {
    version: terminalVersion,
    entryId: entry.id,
    sourceHash: downloads.problem.sha256,
    from: 1,
    to: contextTo,
    ownedFrom: 1,
    ownedTo: contextTo,
    effectiveCorpusHash,
    inputHash: terminalInputHash,
    transcriptionGateVersion: 2,
    transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
    ...(options.terminalScope ? {
      rulesDigest: DIGEST,
      scopePromptDigest: PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST,
    } : {}),
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    inputs: terminalInputs,
    items: terminalItems,
  };
  const terminalHash = writeEvidence(join(stateDir, terminalRelativePath), terminalCheckpoint);
  const problemTerminalFidelityCheckpoints = [{
    path: terminalRelativePath,
    sha256: terminalHash,
    from: 1,
    to: contextTo,
    ownedFrom: 1,
    ownedTo: contextTo,
    inputHash: terminalInputHash,
  }];

  const manualAcceptedSolution = manualSpec?.expectedDecision === "accept" ? (() => {
    const key = `${recoveryTargetPage}:${recoveryTargetNumber}`;
    const relativePath = "solution-chunks/v3-0000.json";
    const absolutePath = join(stateDir, relativePath);
    const checkpoint = JSON.parse(readFileSync(absolutePath, "utf8"));
    const solution = checkpoint.items[recoveryTargetNumber - 1];
    const baseSolutionCheckpoint = { path: relativePath, sha256: hash(readFileSync(absolutePath)) };
    const input = {
      key,
      printedNumber: String(recoveryTargetNumber),
      qtype: "mcq",
      allowDerivedMarkerAnswer: false,
      sourcePage: solution.page,
      rawAnswer: solution.answer,
      explanation: solution.explanation,
      complete: true,
      baseSolutionCheckpoint,
      baseSolutionItemHash: canonicalEvidenceHash(solution),
      baseContextFrom: checkpoint.from,
      baseContextTo: checkpoint.to,
      baseOwnedFrom: checkpoint.ownedFrom,
      baseOwnedTo: checkpoint.ownedTo,
    };
    const decision = {
      key,
      sourcePage: solution.page,
      answerStatus: "exact",
      explanationStatus: "exact",
      evidence: "the explicit answer and complete explanation match the official solution pixels",
    };
    return { key, solution, input, decision };
  })() : null;
  const positiveAcceptedSolution = positiveRepairScopeSpec ? (() => {
    const key = positiveRepairScopeSpec.key;
    const relativePath = "solution-chunks/v3-0000.json";
    const absolutePath = join(stateDir, relativePath);
    const checkpoint = JSON.parse(readFileSync(absolutePath, "utf8"));
    const solution = checkpoint.items.find(
      (item: { number: string }) => item.number === String(recoveryTargetNumber),
    );
    const question = effectiveProblems[recoveryTargetNumber - 1];
    const baseSolutionCheckpoint = { path: relativePath, sha256: hash(readFileSync(absolutePath)) };
    const input = {
      key,
      printedNumber: String(recoveryTargetNumber),
      qtype: question.qtype,
      allowDerivedMarkerAnswer: true,
      sourcePage: solution.page,
      rawAnswer: solution.answer,
      explanation: solution.explanation,
      complete: true,
      baseSolutionCheckpoint,
      baseSolutionItemHash: canonicalEvidenceHash(solution),
      baseContextFrom: checkpoint.from,
      baseContextTo: checkpoint.to,
      baseOwnedFrom: checkpoint.ownedFrom,
      baseOwnedTo: checkpoint.ownedTo,
    };
    const decision = {
      key,
      sourcePage: solution.page,
      answerStatus: "not_visible",
      explanationStatus: "exact",
      evidence: "the complete explanation is exact; its ordinal raw answer is not visible in this range",
    };
    return { key, question, solution, input, decision };
  })() : null;

  const legacyAuditName = readdirSync(join(stateDir, "answer-audit"))
    .find((name) => name.startsWith("v2-"))!;
  const legacyAudit = JSON.parse(readFileSync(join(stateDir, "answer-audit", legacyAuditName), "utf8"));
  const fidelityPointerByLegacyPath = new Map<string, Record<string, unknown>>();
  const fidelityInputByKey = new Map<string, Record<string, unknown>>();
  const officialSolutionContextTo = options.scopeAdjudication ? 5
    : options.repairScopeAdjudication || options.promptUpgrade ? 4 : undefined;
  const solutionFidelityCheckpoints = legacyAudit.solutionFidelityCheckpoints.map(
    (pointer: Record<string, unknown>) => {
      const childPath = join(stateDir, String(pointer.path));
      const child = JSON.parse(readFileSync(childPath, "utf8"));
      child.classifierVersion = 5;
      child.transcriptionGateVersion = 2;
      child.transcriptionPromptDigest = CURRENT_TRANSCRIPTION_PROMPT_DIGEST;
      child.effectiveProblemCorpusHash = effectiveCorpusHash;
      child.entryId = entry.id;
      child.sourceHash = downloads.solution.sha256;
      if (manualAcceptedSolution !== null) {
        child.inputs = [manualAcceptedSolution.input];
        child.items = [manualAcceptedSolution.decision];
        child.inputHash = canonicalEvidenceHash(child.inputs);
        fidelityInputByKey.set(manualAcceptedSolution.key, manualAcceptedSolution.input);
      } else if (officialSolutionContextTo !== undefined) {
        const baseSolutionPath = join(stateDir, "solution-chunks", "v3-0000.json");
        const baseSolutionPointer = {
          path: "solution-chunks/v3-0000.json",
          sha256: hash(readFileSync(baseSolutionPath)),
        };
        child.from = 1;
        child.to = officialSolutionContextTo;
        child.ownedFrom = 1;
        child.ownedTo = officialSolutionContextTo;
        child.inputs = child.inputs.map((input: Record<string, unknown>) => ({
          ...(() => {
            const solution = JSON.parse(readFileSync(baseSolutionPath, "utf8")).items.find(
              (item: { number: string }) => item.number === input.printedNumber,
            );
            return {
              ...input,
              ...(options.promptUpgrade ? {
                qtype: effectiveProblems[Number(input.printedNumber) - 1].qtype,
                allowDerivedMarkerAnswer: /^[①-⑩]$/u.test(solution.answer),
              } : {}),
              sourcePage: solution.page,
              rawAnswer: solution.answer,
              explanation: solution.explanation,
              complete: solution.complete,
              baseSolutionCheckpoint: baseSolutionPointer,
              baseSolutionItemHash: canonicalEvidenceHash(solution),
              baseContextFrom: 1,
              baseContextTo: officialSolutionContextTo,
              baseOwnedFrom: 1,
              baseOwnedTo: officialSolutionContextTo,
            };
          })(),
        }));
        if (positiveAcceptedSolution
          && !child.inputs.some((input: Record<string, unknown>) => input.key === positiveAcceptedSolution.key)) {
          child.inputs.push(positiveAcceptedSolution.input);
          child.items.push(positiveAcceptedSolution.decision);
          child.inputs.sort((left: { key: string }, right: { key: string }) =>
            compareCorpusQuestionKeys(left.key, right.key));
          child.items.sort((left: { key: string }, right: { key: string }) =>
            compareCorpusQuestionKeys(left.key, right.key));
        }
        for (const input of child.inputs as Array<Record<string, unknown>>) {
          fidelityInputByKey.set(String(input.key), input);
        }
        child.items = child.items.map((item: Record<string, unknown>) => ({
          ...item,
          sourcePage: fidelityInputByKey.get(String(item.key))!.sourcePage,
        }));
        child.inputHash = canonicalEvidenceHash(child.inputs);
      }
      const index = /^solution-fidelity\/v1-(\d{4})-/u.exec(String(pointer.path))![1];
      const relativePath = `solution-fidelity/v1-${index}-${effectiveCorpusHash}-${child.inputHash}.json`;
      const sha256 = writeEvidence(join(stateDir, relativePath), child);
      if (manualAcceptedSolution !== null && childPath !== join(stateDir, relativePath)) rmSync(childPath);
      const current = {
        ...pointer,
        path: relativePath,
        sha256,
        ...(officialSolutionContextTo !== undefined ? {
          from: 1,
          to: officialSolutionContextTo,
          ownedFrom: 1,
          ownedTo: officialSolutionContextTo,
        } : {}),
        inputHash: child.inputHash,
      };
      fidelityPointerByLegacyPath.set(String(pointer.path), current);
      return current;
    },
  );
  const solutionFidelityItems = manualAcceptedSolution === null
    ? legacyAudit.solutionFidelityItems.map((item: Record<string, unknown>) => {
    const input = fidelityInputByKey.get(String(item.key));
    return {
      ...item,
      ...(input ? {
        basePage: input.sourcePage,
        effectivePage: input.sourcePage,
        baseSolutionItemHash: input.baseSolutionItemHash,
        effectiveSolutionItemHash: input.baseSolutionItemHash,
        baseRawAnswerHash: hash(String(input.rawAnswer)),
        effectiveRawAnswerHash: hash(String(input.rawAnswer)),
        baseExplanationHash: hash(String(input.explanation)),
        effectiveExplanationHash: hash(String(input.explanation)),
      } : {}),
      fidelityArtifact: (() => {
      const pointer = fidelityPointerByLegacyPath.get(
        String((item.fidelityArtifact as Record<string, unknown>).path),
      )!;
      return { path: pointer.path, sha256: pointer.sha256 };
      })(),
    };
    })
    : [{
      key: manualAcceptedSolution.key,
      printedNumber: String(recoveryTargetNumber),
      qtype: "mcq",
      basePage: manualAcceptedSolution.solution.page,
      effectivePage: manualAcceptedSolution.solution.page,
      answerStatus: manualAcceptedSolution.decision.answerStatus,
      explanationStatus: manualAcceptedSolution.decision.explanationStatus,
      evidence: manualAcceptedSolution.decision.evidence,
      fidelityArtifact: {
        path: solutionFidelityCheckpoints[0].path,
        sha256: solutionFidelityCheckpoints[0].sha256,
      },
      baseSolutionItemHash: manualAcceptedSolution.input.baseSolutionItemHash,
      effectiveSolutionItemHash: manualAcceptedSolution.input.baseSolutionItemHash,
      baseRawAnswerHash: hash(manualAcceptedSolution.solution.answer),
      effectiveRawAnswerHash: hash(manualAcceptedSolution.solution.answer),
      baseExplanationHash: hash(manualAcceptedSolution.solution.explanation),
      effectiveExplanationHash: hash(manualAcceptedSolution.solution.explanation),
    }];
  if (positiveAcceptedSolution) {
    solutionFidelityItems.push({
      key: positiveAcceptedSolution.key,
      printedNumber: String(recoveryTargetNumber),
      qtype: "mcq",
      basePage: positiveAcceptedSolution.solution.page,
      effectivePage: positiveAcceptedSolution.solution.page,
      answerStatus: positiveAcceptedSolution.decision.answerStatus,
      explanationStatus: positiveAcceptedSolution.decision.explanationStatus,
      evidence: positiveAcceptedSolution.decision.evidence,
      fidelityArtifact: {
        path: solutionFidelityCheckpoints[0].path,
        sha256: solutionFidelityCheckpoints[0].sha256,
      },
      baseSolutionItemHash: positiveAcceptedSolution.input.baseSolutionItemHash,
      effectiveSolutionItemHash: positiveAcceptedSolution.input.baseSolutionItemHash,
      baseRawAnswerHash: hash(positiveAcceptedSolution.solution.answer),
      effectiveRawAnswerHash: hash(positiveAcceptedSolution.solution.answer),
      baseExplanationHash: hash(positiveAcceptedSolution.solution.explanation),
      effectiveExplanationHash: hash(positiveAcceptedSolution.solution.explanation),
    });
    solutionFidelityItems.sort((left: { key: string }, right: { key: string }) =>
      compareCorpusQuestionKeys(left.key, right.key));
  }
  const currentSolutionItems = readdirSync(join(stateDir, "solution-chunks"))
    .filter((name) => /^v3-\d{4}\.json$/u.test(name))
    .sort()
    .flatMap((name) => JSON.parse(readFileSync(join(stateDir, "solution-chunks", name), "utf8")).items);
  const effectiveSolutionCorpusHash = canonicalEvidenceHash(solutionFidelityItems.map(
    (item: Record<string, unknown>) => ({
      key: item.key,
      solution: currentSolutionItems.find(
        (solution: { number: string }) => solution.number === item.printedNumber,
      ),
    }),
  ).sort((left: { key: string }, right: { key: string }) =>
    compareCorpusQuestionKeys(left.key, right.key)));
  const semanticCheckpoint = (() => {
    if (legacyAudit.semanticCheckpoint === null && !positiveAcceptedSolution) return null;
    const child = legacyAudit.semanticCheckpoint === null ? {
      inputs: [],
      items: [],
    } : JSON.parse(readFileSync(
      join(stateDir, String((legacyAudit.semanticCheckpoint as Record<string, unknown>).path)),
      "utf8",
    ));
    if (positiveAcceptedSolution) {
      child.inputs.push({
        key: positiveAcceptedSolution.key,
        choices: positiveAcceptedSolution.question.choices,
        detailedExplanation: redactedExplanation(positiveAcceptedSolution.solution.explanation),
      });
      child.items.push({
        key: positiveAcceptedSolution.key,
        status: "resolved",
        choiceIndex: 1,
        evidence: "the official explanation evaluates the Riemann sum to 9, which is choice 1",
      });
      child.inputs.sort((left: { key: string }, right: { key: string }) =>
        compareCorpusQuestionKeys(left.key, right.key));
      child.items.sort((left: { key: string }, right: { key: string }) =>
        compareCorpusQuestionKeys(left.key, right.key));
      child.inputHash = canonicalEvidenceHash(child.inputs);
    }
    const semanticVersion = options.answerV5 ? 5 : 4;
    child.version = semanticVersion;
    child.entryId = entry.id;
    child.problemHash = downloads.problem.sha256;
    child.solutionHash = downloads.solution.sha256;
    child.classifierVersion = 5;
    child.rulesDigest = DIGEST;
    child.transcriptionGateVersion = 2;
    child.transcriptionPromptDigest = CURRENT_TRANSCRIPTION_PROMPT_DIGEST;
    child.effectiveCorpusHash = effectiveCorpusHash;
    child.effectiveSolutionCorpusHash = effectiveSolutionCorpusHash;
    child.promptDigest = options.answerV5 ? V5_SEMANTIC_PROMPT_DIGEST : CURRENT_SEMANTIC_PROMPT_DIGEST;
    child.model = "gpt-5.6-sol";
    child.reasoningEffort = "high";
    const relativePath = options.answerV5
      ? `semantic-choice-checks/v5-${effectiveCorpusHash}-` +
        `${effectiveSolutionCorpusHash}-${child.inputHash}.json`
      : `semantic-choice-checks/v4-${child.inputHash}.json`;
    return {
      path: relativePath,
      sha256: writeEvidence(join(stateDir, relativePath), child),
      inputHash: child.inputHash,
      ...(options.answerV5 ? { effectiveCorpusHash } : {}),
      effectiveSolutionCorpusHash,
    };
  })();
  const acceptedSolutionKeys = solutionFidelityItems.map((item: { key: string }) => item.key)
    .sort((left: string, right: string) => compareCorpusQuestionKeys(left, right));
  const acceptedMcqKeys = (manualAcceptedSolution === null
    ? legacyAudit.acceptedMcqKeys
    : [manualAcceptedSolution.key]) as string[];
  if (positiveAcceptedSolution) {
    acceptedMcqKeys.push(positiveAcceptedSolution.key);
    acceptedMcqKeys.sort(compareCorpusQuestionKeys);
  }
  const auditItems = (manualAcceptedSolution === null
    ? legacyAudit.items
    : [{
      key: manualAcceptedSolution.key,
      printedNumber: String(recoveryTargetNumber),
      sourcePage: recoveryTargetPage,
      officialRawAnswerHash: hash(manualAcceptedSolution.solution.answer),
      storedAnswerHash: hash(manualAcceptedSolution.solution.answer),
      mode: "choice-content",
      choiceIndex: 3,
      semantic: null,
    }]) as Array<Record<string, unknown>>;
  if (positiveAcceptedSolution) {
    auditItems.push({
      key: positiveAcceptedSolution.key,
      printedNumber: String(recoveryTargetNumber),
      sourcePage: recoveryTargetPage,
      officialRawAnswerHash: hash(positiveAcceptedSolution.solution.answer),
      storedAnswerHash: hash(positiveAcceptedSolution.solution.answer),
      mode: "choice-marker",
      choiceIndex: 1,
      semantic: {
        status: "resolved",
        choiceIndex: 1,
        evidence: "the official explanation evaluates the Riemann sum to 9, which is choice 1",
      },
    });
    auditItems.sort((left, right) =>
      compareCorpusQuestionKeys(String(left.key), String(right.key)));
  }
  const auditBasis = {
    entryId: entry.id,
    problemHash: downloads.problem.sha256,
    solutionHash: downloads.solution.sha256,
    classifierVersion: 5,
    rulesDigest: DIGEST,
    transcriptionGateVersion: 2,
    transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
    solutionFidelityVersion: 1,
    solutionFidelityPromptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    problemTerminalFidelityVersion: terminalVersion,
    ...(options.terminalScope ? {
      problemTerminalScopePromptDigest: PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST,
    } : {}),
    semanticChoiceVersion: options.answerV5 ? 5 : 4,
    semanticPromptDigest: options.answerV5 ? V5_SEMANTIC_PROMPT_DIGEST : CURRENT_SEMANTIC_PROMPT_DIGEST,
    sourceQuestionCount: legacyAudit.sourceQuestionCount,
    acceptedQuestionCount: legacyAudit.acceptedQuestionCount + (positiveAcceptedSolution ? 1 : 0),
    rejectedQuestionCount: legacyAudit.rejectedQuestionCount - (positiveAcceptedSolution ? 1 : 0),
    reviewQuestionCount: 0,
    targetQuestionCounts: positiveAcceptedSolution ? {
      ...legacyAudit.targetQuestionCounts,
      "수학 - 수학Ⅱ·미적분Ⅰ": legacyAudit.targetQuestionCounts["수학 - 수학Ⅱ·미적분Ⅰ"] + 1,
    } : legacyAudit.targetQuestionCounts,
    acceptedSolutionKeys,
    solutionRepairKeys: [],
    derivedAnswerKeys: positiveAcceptedSolution
      ? [...legacyAudit.derivedAnswerKeys, positiveAcceptedSolution.key].sort(compareCorpusQuestionKeys)
      : manualAcceptedSolution === null ? legacyAudit.derivedAnswerKeys : [],
    acceptedMcqKeys,
    effectiveCorpusHash,
    effectiveSolutionCorpusHash,
    solutionFidelityCheckpoints,
    solutionFidelityItems,
    solutionRepairs: [],
    problemTerminalFidelityCheckpoints,
    problemTerminalFidelityItems: terminalItems,
    semanticCheckpoint,
    repairs,
    items: auditItems,
  };
  const auditDigest = canonicalEvidenceHash(auditBasis);
  const auditRelativePath = `answer-audit/v${answerAuditVersion}-${auditDigest}.json`;
  const auditHash = writeEvidence(join(stateDir, auditRelativePath), {
    version: answerAuditVersion,
    auditDigest,
    ...auditBasis,
  });
  const receipt = JSON.parse(readFileSync(join(stateDir, "receipt.json"), "utf8"));
  if (positiveAcceptedSolution) {
    const target = receipt.targetBooks.find(
      (value: { subject: string }) => value.subject === "수학 - 수학Ⅱ·미적분Ⅰ",
    ) as { expectedQuestionCount: number; problemR2Key: string; solutionR2Key: string };
    target.expectedQuestionCount += 1;
    receipt.acceptedQuestionCount += 1;
    receipt.rejectedQuestionCount -= 1;
    const question = positiveAcceptedSolution.question;
    const db = new Database(files.dbPath);
    const problemFile = db.prepare("SELECT id, book_id FROM book_files WHERE r2_key = ?")
      .get(target.problemR2Key) as { id: number; book_id: number };
    const solutionFile = db.prepare("SELECT id FROM book_files WHERE r2_key = ?")
      .get(target.solutionR2Key) as { id: number };
    const subject = db.prepare("SELECT subject_id FROM books WHERE id = ?")
      .get(problemFile.book_id) as { subject_id: number };
    const questionId = Number((db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM questions")
      .get() as { id: number }).id);
    const firstItemId = Number((db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM book_items")
      .get() as { id: number }).id);
    db.prepare(
      `INSERT INTO questions
       (id, subject_id, source, qtype, question, choices, answer, explanation, book_id,
        difficulty, book_number, printed_number, src_file_id, src_page)
       VALUES (?, ?, 'uploaded', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      questionId,
      subject.subject_id,
      question.qtype,
      question.question,
      JSON.stringify(question.choices),
      positiveAcceptedSolution.solution.answer,
      positiveAcceptedSolution.solution.explanation,
      problemFile.book_id,
      question.difficulty,
      String(recoveryTargetNumber),
      String(recoveryTargetNumber),
      problemFile.id,
      recoveryTargetPage,
    );
    db.prepare(
      "INSERT INTO book_items (id, book_id, file_id, category, number, answer, content, page) " +
      "VALUES (?, ?, ?, '문제', ?, ?, ?, ?)",
    ).run(
      firstItemId,
      problemFile.book_id,
      problemFile.id,
      String(recoveryTargetNumber),
      positiveAcceptedSolution.solution.answer,
      question.question,
      recoveryTargetPage,
    );
    db.prepare(
      "INSERT INTO book_items (id, book_id, file_id, category, number, answer, content, page) " +
      "VALUES (?, ?, ?, '해설', ?, ?, ?, ?)",
    ).run(
      firstItemId + 1,
      problemFile.book_id,
      solutionFile.id,
      String(recoveryTargetNumber),
      positiveAcceptedSolution.solution.answer,
      positiveAcceptedSolution.solution.explanation,
      positiveAcceptedSolution.solution.page,
    );
    db.close();
    writeEvidence(join(stateDir, "receipt.json"), receipt);
  }
  if (manualAcceptedSolution !== null) {
    const target = receipt.targetBooks[0] as { problemR2Key: string; solutionR2Key: string };
    const question = effectiveProblems[recoveryTargetNumber - 1];
    const db = new Database(files.dbPath);
    const problemFile = db.prepare("SELECT id, book_id FROM book_files WHERE r2_key = ?")
      .get(target.problemR2Key) as { id: number; book_id: number };
    const solutionFile = db.prepare("SELECT id FROM book_files WHERE r2_key = ?")
      .get(target.solutionR2Key) as { id: number };
    db.prepare(
      "UPDATE questions SET qtype = ?, question = ?, choices = ?, answer = ?, explanation = ?, " +
      "difficulty = ?, book_number = ?, printed_number = ?, src_file_id = ?, src_page = ? WHERE book_id = ?",
    ).run(
      question.qtype,
      question.question,
      JSON.stringify(question.choices),
      manualAcceptedSolution.solution.answer,
      manualAcceptedSolution.solution.explanation,
      question.difficulty,
      String(recoveryTargetNumber),
      String(recoveryTargetNumber),
      problemFile.id,
      recoveryTargetPage,
      problemFile.book_id,
    );
    db.prepare(
      "UPDATE book_items SET file_id = ?, number = ?, answer = ?, content = ?, page = ? " +
      "WHERE book_id = ? AND category = '문제'",
    ).run(
      problemFile.id,
      String(recoveryTargetNumber),
      manualAcceptedSolution.solution.answer,
      question.question,
      recoveryTargetPage,
      problemFile.book_id,
    );
    db.prepare(
      "UPDATE book_items SET file_id = ?, number = ?, answer = ?, content = ?, page = ? " +
      "WHERE book_id = ? AND category = '해설'",
    ).run(
      solutionFile.id,
      String(recoveryTargetNumber),
      manualAcceptedSolution.solution.answer,
      manualAcceptedSolution.solution.explanation,
      manualAcceptedSolution.solution.page,
      problemFile.book_id,
    );
    db.close();
  }
  const attestationBasis = {
    entryId: entry.id,
    problemHash: downloads.problem.sha256,
    solutionHash: downloads.solution.sha256,
    classifierVersion: 5,
    rulesDigest: DIGEST,
    transcriptionGateVersion: 2,
    transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
    solutionFidelityVersion: 1,
    solutionFidelityPromptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    problemTerminalFidelityVersion: terminalVersion,
    ...(options.terminalScope ? {
      problemTerminalScopePromptDigest: PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST,
    } : {}),
    receipt: { path: "receipt.json", sha256: canonicalEvidenceHash(receipt) },
    answerAudit: {
      path: auditRelativePath,
      sha256: auditHash,
      effectiveCorpusHash,
      effectiveSolutionCorpusHash,
    },
    repairs,
    solutionFidelityCheckpoints,
    solutionFidelityItems,
    solutionRepairs: [],
    problemTerminalFidelityCheckpoints,
    problemTerminalFidelityItems: terminalItems,
  };
  const attestationDigest = canonicalEvidenceHash(attestationBasis);
  const attestationRelativePath = `answer-attestation/v${answerAuditVersion}-${attestationDigest}.json`;
  writeEvidence(join(stateDir, attestationRelativePath), {
    version: answerAuditVersion,
    attestationDigest,
    ...attestationBasis,
  });
  if (options.crossPageBatchRepair) {
    const db = new Database(files.dbPath);
    db.prepare("UPDATE book_files SET page_count = 2 WHERE content_hash = ?").run(downloads.problem.sha256);
    db.close();
  }
  return {
    terminalArtifact: join(stateDir, terminalRelativePath),
    auditArtifact: join(stateDir, auditRelativePath),
    attestationArtifact: join(stateDir, attestationRelativePath),
    problemBatchArtifact,
    classificationBatchArtifact,
    problemRevisionArtifact,
    classificationRevisionArtifact,
    problemRecoveryArtifact,
    classificationRecoveryArtifact,
    cropEvidenceArtifact,
    cropEvidencePdf,
    cropViewArtifacts,
    problemCropAdjudicationArtifact,
    classificationCropAdjudicationArtifact,
    classificationScopeAdjudicationArtifact,
    manualEvidenceArtifact,
    manualEvidencePdf,
    manualViewArtifacts,
    problemManualAdjudicationArtifact,
    classificationManualAdjudicationArtifact,
  };
}

function convertMathToFilteredV3(
  files: ReturnType<typeof fixture>,
  current = false,
  authorizedMismatch = false,
  answerV5 = false,
): string {
  upgradeEntryToV3(files, "math", current ? {
    terminalScope: "authorized-reject",
    answerV5,
  } : {});
  const terminalVersion = current ? 2 : 1;
  const auditVersion = answerV5 ? 5 : current ? 4 : 3;
  const stateDir = files.stateDirs.math;
  const entry = JSON.parse(readFileSync(join(stateDir, "entry.json"), "utf8")).entry;
  const downloads = JSON.parse(readFileSync(join(stateDir, "downloads.json"), "utf8"));
  const problemName = readdirSync(join(stateDir, "problem-chunks"))[0];
  const problems = JSON.parse(readFileSync(join(stateDir, "problem-chunks", problemName), "utf8")).items;
  const classificationName = readdirSync(join(stateDir, "classification-chunks"))
    .find((name) => name.startsWith("v5-"))!;
  const classificationPath = join(stateDir, "classification-chunks", classificationName);
  const classification = JSON.parse(readFileSync(classificationPath, "utf8"));
  classification.items = classification.items.map((item: Record<string, unknown>) => ({
    ...item,
    decision: "reject",
    canonical_subject: null,
    curriculum_course: null,
    domain: null,
    achievement_codes: [],
    reason_codes: ["OUT_OF_SCOPE"],
    transcription_status: "exact",
    transcription_evidence: "the literal source transcription is exact",
  }));
  if (current && authorizedMismatch) {
    classification.items[2].transcription_status = "mismatch";
    classification.items[2].transcription_evidence = "the rejected source was intentionally not fully transcribed";
  }
  writeJson(classificationPath, classification);
  const effectiveCorpus = problems.map((question: Record<string, unknown>, index: number) => ({
    question,
    classification: classification.items[index],
  }));
  const effectiveCorpusHash = canonicalEvidenceHash(effectiveCorpus);
  const inputs = problems.map((question: Record<string, unknown>) => ({
    key: `${question.page}:${question.number}`,
    printed_number: String(question.number),
    source_page: question.page,
    qtype: question.qtype,
    question: question.question,
    choices: question.choices,
    figure: question.figure,
    figure_description: question.figure_description,
    box: question.box,
  }));
  const items = inputs.map((input: { key: string }) => ({
    key: input.key,
    status: current && authorizedMismatch && input.key === "1:3" ? "mismatch" : "exact",
    evidence: current && authorizedMismatch && input.key === "1:3"
      ? "official pixels confirm the omitted rejected detail"
      : "the final literal transcription exactly matches official pixels",
    ...(current ? {
      scopeDecision: "reject",
      scopeConfidence: 0.99,
      scopeEvidence: "the official source page independently establishes out-of-scope content",
    } : {}),
  })).sort((left: { key: string }, right: { key: string }) => compareCorpusQuestionKeys(left.key, right.key));
  const inputHash = canonicalEvidenceHash(inputs);
  const terminalPath =
    `problem-terminal-fidelity/v${terminalVersion}-0000-${effectiveCorpusHash}-${inputHash}.json`;
  const terminalHash = writeEvidence(join(stateDir, terminalPath), {
    version: terminalVersion,
    entryId: entry.id,
    sourceHash: downloads.problem.sha256,
    from: 1,
    to: 1,
    ownedFrom: 1,
    ownedTo: 1,
    effectiveCorpusHash,
    inputHash,
    transcriptionGateVersion: 2,
    transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
    ...(current ? {
      rulesDigest: DIGEST,
      scopePromptDigest: PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST,
    } : {}),
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    inputs,
    items,
  });
  const checkpoints = [{
    path: terminalPath,
    sha256: terminalHash,
    from: 1,
    to: 1,
    ownedFrom: 1,
    ownedTo: 1,
    inputHash,
  }];
  const auditBasis = {
    entryId: entry.id,
    problemHash: downloads.problem.sha256,
    solutionHash: downloads.solution.sha256,
    classifierVersion: 5,
    rulesDigest: DIGEST,
    transcriptionGateVersion: 2,
    transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
    solutionFidelityVersion: 1,
    solutionFidelityPromptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    problemTerminalFidelityVersion: terminalVersion,
    ...(current ? { problemTerminalScopePromptDigest: PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST } : {}),
    semanticChoiceVersion: answerV5 ? 5 : 4,
    semanticPromptDigest: answerV5 ? V5_SEMANTIC_PROMPT_DIGEST : CURRENT_SEMANTIC_PROMPT_DIGEST,
    sourceQuestionCount: problems.length,
    acceptedQuestionCount: 0,
    rejectedQuestionCount: problems.length,
    reviewQuestionCount: 0,
    targetQuestionCounts: {},
    acceptedSolutionKeys: [],
    solutionRepairKeys: [],
    derivedAnswerKeys: [],
    acceptedMcqKeys: [],
    effectiveCorpusHash,
    effectiveSolutionCorpusHash: canonicalEvidenceHash([]),
    solutionFidelityCheckpoints: [],
    solutionFidelityItems: [],
    solutionRepairs: [],
    problemTerminalFidelityCheckpoints: checkpoints,
    problemTerminalFidelityItems: items,
    semanticCheckpoint: null,
    repairs: [],
    items: [],
  };
  const auditDigest = canonicalEvidenceHash(auditBasis);
  const auditPath = `answer-audit/v${auditVersion}-${auditDigest}.json`;
  const auditHash = writeEvidence(join(stateDir, auditPath), { version: auditVersion, auditDigest, ...auditBasis });
  rmSync(join(stateDir, "receipt.json"));
  writeJson(join(stateDir, "result.json"), {
    version: auditVersion,
    status: "filtered",
    entryId: entry.id,
    reason: "NO_IN_SCOPE_QUESTIONS",
    rulesDigest: DIGEST,
    classifierVersion: 5,
    transcriptionGateVersion: 2,
    transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
    ...(current ? {
      problemTerminalFidelityVersion: terminalVersion,
      problemTerminalScopePromptDigest: PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST,
    } : {}),
    sourceQuestionCount: problems.length,
    acceptedQuestionCount: 0,
    rejectedQuestionCount: problems.length,
    reviewQuestionCount: 0,
    effectiveCorpusHash,
    answerAudit: { path: auditPath, sha256: auditHash },
  });
  const db = new Database(files.dbPath);
  const title = `2025년 · ${entry.rawTitle}`;
  const bookIds = (db.prepare("SELECT id FROM books WHERE title = ?").all(title) as Array<{ id: number }>).map((row) => row.id);
  for (const bookId of bookIds) {
    db.prepare("DELETE FROM book_items WHERE book_id = ?").run(bookId);
    db.prepare("DELETE FROM questions WHERE book_id = ?").run(bookId);
    db.prepare("DELETE FROM book_files WHERE book_id = ?").run(bookId);
    db.prepare("DELETE FROM books WHERE id = ?").run(bookId);
  }
  db.close();
  return join(stateDir, "result.json");
}

function rewriteCurrentV3Authority(
  files: ReturnType<typeof fixture>,
  mutate: (audit: Record<string, any>) => void,
  id = "math",
): void {
  const stateDir = files.stateDirs[id];
  const attestationName = readdirSync(join(stateDir, "answer-attestation"))
    .find((name) => name.startsWith("v5-"))
    ?? readdirSync(join(stateDir, "answer-attestation")).find((name) => name.startsWith("v4-"))
    ?? readdirSync(join(stateDir, "answer-attestation")).find((name) => name.startsWith("v3-"))!;
  const attestationPath = join(stateDir, "answer-attestation", attestationName);
  const attestation = JSON.parse(readFileSync(attestationPath, "utf8"));
  const audit = JSON.parse(readFileSync(join(stateDir, attestation.answerAudit.path), "utf8"));
  const version = Number(attestation.version);
  mutate(audit);
  const { version: _auditVersion, auditDigest: _auditDigest, ...auditBasis } = audit;
  const nextAuditDigest = canonicalEvidenceHash(auditBasis);
  const nextAuditPath = `answer-audit/v${version}-${nextAuditDigest}.json`;
  const nextAuditHash = writeEvidence(join(stateDir, nextAuditPath), {
    version,
    auditDigest: nextAuditDigest,
    ...auditBasis,
  });
  const { version: _attestationVersion, attestationDigest: _attestationDigest, ...attestationBasis } = attestation;
  Object.assign(attestationBasis, {
    answerAudit: {
      path: nextAuditPath,
      sha256: nextAuditHash,
      effectiveCorpusHash: audit.effectiveCorpusHash,
      effectiveSolutionCorpusHash: audit.effectiveSolutionCorpusHash,
    },
    repairs: audit.repairs,
    solutionFidelityCheckpoints: audit.solutionFidelityCheckpoints,
    solutionFidelityItems: audit.solutionFidelityItems,
    solutionRepairs: audit.solutionRepairs,
    problemTerminalFidelityCheckpoints: audit.problemTerminalFidelityCheckpoints,
    problemTerminalFidelityItems: audit.problemTerminalFidelityItems,
  });
  const nextAttestationDigest = canonicalEvidenceHash(attestationBasis);
  writeEvidence(join(stateDir, "answer-attestation", `v${version}-${nextAttestationDigest}.json`), {
    version,
    attestationDigest: nextAttestationDigest,
    ...attestationBasis,
  });
  rmSync(attestationPath);
}

function installSyntheticRepair(
  files: ReturnType<typeof fixture>,
  withRevision = false,
): {
  classificationArtifact: string;
  revisionProblemArtifact: string | null;
  revisionClassificationArtifact: string | null;
} {
  const stateDir = files.stateDirs.math;
  const entry = JSON.parse(readFileSync(join(stateDir, "entry.json"), "utf8")).entry;
  const downloads = JSON.parse(readFileSync(join(stateDir, "downloads.json"), "utf8"));
  const problemPath = join(stateDir, "problem-chunks", "v2-0000.json");
  const classificationPath = join(stateDir, "classification-chunks", `v4-0000-${DIGEST}.json`);
  const solutionPath = join(stateDir, "solution-chunks", "v3-0000.json");
  const problemCheckpoint = JSON.parse(readFileSync(problemPath, "utf8"));
  const classificationCheckpoint = JSON.parse(readFileSync(classificationPath, "utf8"));
  const solutionCheckpoint = JSON.parse(readFileSync(solutionPath, "utf8"));
  const baseQuestion = problemCheckpoint.items[0];
  const baseClassification = classificationCheckpoint.items[0];
  downloads.problem.pageCount = 2;
  problemCheckpoint.to = 2;
  problemCheckpoint.ownedTo = 2;
  baseQuestion.page = 2;
  classificationCheckpoint.to = 2;
  classificationCheckpoint.ownedTo = 2;
  baseClassification.key = "2:1";
  writeJson(join(stateDir, "downloads.json"), downloads);
  writeJson(problemPath, problemCheckpoint);
  const finalClassification = JSON.parse(JSON.stringify(baseClassification));
  baseClassification.decision = "review";
  baseClassification.canonical_subject = null;
  baseClassification.curriculum_course = null;
  baseClassification.domain = null;
  baseClassification.achievement_codes = [];
  baseClassification.reason_codes = ["TRANSCRIPTION_MISMATCH"];
  baseClassification.transcription_status = "mismatch";
  baseClassification.transcription_evidence = "source pixels show a different stem";
  writeJson(classificationPath, classificationCheckpoint);
  finalClassification.transcription_status = "exact";
  finalClassification.transcription_evidence = "bounded-context reread matches the corrected complete transcription";
  const baseSolution = solutionCheckpoint.items.find((item: { number: string }) => item.number === "1");
  const finalQuestion = {
    ...baseQuestion,
    question: withRevision
      ? "Q17의 상징 모양과 순서를 모두 보존한 second source-grounded transcription"
      : "1쪽의 공유 지문 전체를 포함한 math corrected source transcription 1",
  };
  const firstQuestion = withRevision ? {
    ...baseQuestion,
    question: "Q17의 상징을 문자로 잘못 바꾼 first targeted transcription",
  } : finalQuestion;
  const firstClassification = withRevision ? {
    ...finalClassification,
    transcription_status: "mismatch",
    transcription_evidence: "Q17 source pixels retain a non-text glyph that the first repair paraphrased",
  } : finalClassification;
  const baseProblemPointer = { path: "problem-chunks/v2-0000.json", sha256: hash(readFileSync(problemPath)) };
  const baseClassificationPointer = {
    path: `classification-chunks/v4-0000-${DIGEST}.json`,
    sha256: hash(readFileSync(classificationPath)),
  };
  const baseSolutionPointer = { path: "solution-chunks/v3-0000.json", sha256: hash(readFileSync(solutionPath)) };
  const problemArtifactPath = "problem-repairs/v2-0002-0001.json";
  const problemArtifact = {
    version: 2,
    entryId: entry.id,
    key: "2:1",
    sourcePage: 2,
    printedNumber: "1",
    contextFrom: 1,
    contextTo: 2,
    sourceHash: downloads.problem.sha256,
    baseProblemCheckpoint: baseProblemPointer,
    baseQuestionHash: canonicalEvidenceHash(baseQuestion),
    baseSolutionCheckpoint: baseSolutionPointer,
    baseSolutionItemHash: canonicalEvidenceHash(baseSolution),
    officialRawAnswerHash: hash(baseSolution.answer),
    promptVersion: TARGETED_PROBLEM_TRANSCRIPTION_VERSION,
    promptDigest: TARGETED_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    item: firstQuestion,
  };
  const problemArtifactPointer = {
    path: problemArtifactPath,
    sha256: writeEvidence(join(stateDir, problemArtifactPath), problemArtifact),
  };
  const classificationArtifactPath = `classification-repairs/v3-0002-0001-${DIGEST}.json`;
  const classificationArtifact = {
    version: 3,
    entryId: entry.id,
    key: "2:1",
    sourceHash: downloads.problem.sha256,
    contextFrom: 1,
    contextTo: 2,
    problemArtifact: problemArtifactPointer,
    baseClassificationCheckpoint: baseClassificationPointer,
    baseClassificationHash: canonicalEvidenceHash(baseClassification),
    effectiveQuestionHash: canonicalEvidenceHash(firstQuestion),
    classifierVersion: 4,
    rulesDigest: DIGEST,
    transcriptionGateVersion: 1,
    transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    item: firstClassification,
  };
  const classificationArtifactPointer = {
    path: classificationArtifactPath,
    sha256: writeEvidence(join(stateDir, classificationArtifactPath), classificationArtifact),
    rulesDigest: DIGEST,
    transcriptionGateVersion: 1,
    transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
  };
  const baseClassificationRepairPointer = {
    path: classificationArtifactPointer.path,
    sha256: classificationArtifactPointer.sha256,
  };
  let revision: Record<string, unknown> | null = null;
  let revisionProblemArtifact: string | null = null;
  let revisionClassificationArtifact: string | null = null;
  if (withRevision) {
    const diagnosticEvidence = firstClassification.transcription_evidence;
    const diagnosticEvidenceHash = hash(diagnosticEvidence);
    const firstQuestionHash = canonicalEvidenceHash(firstQuestion);
    const firstClassificationHash = canonicalEvidenceHash(firstClassification);
    const revisionBasisHash = canonicalEvidenceHash({
      baseProblemRepairArtifact: problemArtifactPointer,
      baseClassificationRepairArtifact: baseClassificationRepairPointer,
      diagnosticEvidenceHash,
      revisionPromptDigest: TARGETED_REVISION_PROMPT_DIGEST,
    });
    const revisionProblemPath = `problem-revisions/v1-0002-0001-${revisionBasisHash}.json`;
    const revisionProblem = {
      version: 1,
      entryId: entry.id,
      key: "2:1",
      sourcePage: 2,
      printedNumber: "1",
      contextFrom: 1,
      contextTo: 2,
      sourceHash: downloads.problem.sha256,
      baseProblemRepairArtifact: problemArtifactPointer,
      baseClassificationRepairArtifact: baseClassificationRepairPointer,
      baseQuestionHash: firstQuestionHash,
      baseClassificationHash: firstClassificationHash,
      diagnosticEvidence,
      diagnosticEvidenceHash,
      promptVersion: TARGETED_PROBLEM_REVISION_VERSION,
      promptDigest: TARGETED_REVISION_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      item: finalQuestion,
    };
    const revisionProblemPointer = {
      path: revisionProblemPath,
      sha256: writeEvidence(join(stateDir, revisionProblemPath), revisionProblem),
    };
    const revisionClassificationPath =
      `classification-revisions/v1-0002-0001-${revisionProblemPointer.sha256}-${DIGEST}.json`;
    const revisionClassification = {
      version: 1,
      entryId: entry.id,
      key: "2:1",
      sourceHash: downloads.problem.sha256,
      contextFrom: 1,
      contextTo: 2,
      problemArtifact: revisionProblemPointer,
      baseProblemRepairArtifact: problemArtifactPointer,
      baseClassificationRepairArtifact: baseClassificationRepairPointer,
      baseQuestionHash: firstQuestionHash,
      baseClassificationHash: firstClassificationHash,
      diagnosticEvidenceHash,
      effectiveQuestionHash: canonicalEvidenceHash(finalQuestion),
      classifierVersion: 4,
      rulesDigest: DIGEST,
      transcriptionGateVersion: 1,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
      revisionPromptVersion: TARGETED_PROBLEM_REVISION_VERSION,
      revisionPromptDigest: TARGETED_REVISION_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      item: finalClassification,
    };
    const revisionClassificationPointer = {
      path: revisionClassificationPath,
      sha256: writeEvidence(join(stateDir, revisionClassificationPath), revisionClassification),
    };
    revision = {
      baseProblemRepairArtifact: problemArtifactPointer,
      baseClassificationRepairArtifact: baseClassificationRepairPointer,
      problemArtifact: revisionProblemPointer,
      classificationArtifact: {
        ...revisionClassificationPointer,
        rulesDigest: DIGEST,
        transcriptionGateVersion: 1,
        transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
        revisionPromptVersion: TARGETED_PROBLEM_REVISION_VERSION,
        revisionPromptDigest: TARGETED_REVISION_PROMPT_DIGEST,
      },
      diagnosticEvidenceHash,
      baseQuestionHash: firstQuestionHash,
      effectiveQuestionHash: canonicalEvidenceHash(finalQuestion),
      baseClassificationHash: firstClassificationHash,
      effectiveClassificationHash: canonicalEvidenceHash(finalClassification),
    };
    revisionProblemArtifact = join(stateDir, revisionProblemPath);
    revisionClassificationArtifact = join(stateDir, revisionClassificationPath);
  }
  const repair = {
    key: "2:1",
    printedNumber: "1",
    sourcePage: 2,
    contextFrom: 1,
    contextTo: 2,
    baseProblemCheckpoint: baseProblemPointer,
    baseClassificationCheckpoint: baseClassificationPointer,
    baseSolutionCheckpoint: baseSolutionPointer,
    problemArtifact: problemArtifactPointer,
    classificationArtifact: classificationArtifactPointer,
    baseQuestionHash: canonicalEvidenceHash(baseQuestion),
    effectiveQuestionHash: canonicalEvidenceHash(firstQuestion),
    baseClassificationHash: canonicalEvidenceHash(baseClassification),
    effectiveClassificationHash: canonicalEvidenceHash(firstClassification),
    baseSolutionItemHash: canonicalEvidenceHash(baseSolution),
    officialRawAnswerHash: hash(baseSolution.answer),
    ...(revision ? { revision } : {}),
  };
  const effectiveQuestions = problemCheckpoint.items.map((question: Record<string, unknown>, index: number) => ({
    question: index === 0 ? finalQuestion : question,
    classification: index === 0 ? finalClassification : classificationCheckpoint.items[index],
  })).sort((left: { question: Record<string, unknown> }, right: { question: Record<string, unknown> }) =>
    Number(left.question.page) - Number(right.question.page)
    || Number(left.question.number) - Number(right.question.number));
  const effectiveCorpusHash = canonicalEvidenceHash(effectiveQuestions);
  const answers = [answerCase("math", 0), answerCase("math", 1)];
  const acceptedSolutions = [0, 1].map((index) =>
    solutionCheckpoint.items.find((item: { number: string }) => item.number === String(index + 1)));
  const fidelityInputs = acceptedSolutions.map((solutionItem, index) => ({
    key: index === 0 ? "2:1" : "1:2",
    printedNumber: String(index + 1),
    qtype: "mcq",
    allowDerivedMarkerAnswer: false,
    sourcePage: solutionItem.page,
    rawAnswer: solutionItem.answer,
    explanation: solutionItem.explanation,
    complete: true,
    baseSolutionCheckpoint: baseSolutionPointer,
    baseSolutionItemHash: canonicalEvidenceHash(solutionItem),
    baseContextFrom: 1,
    baseContextTo: 6,
    baseOwnedFrom: 1,
    baseOwnedTo: 4,
  })).sort((left, right) => left.key.localeCompare(right.key));
  const fidelityInputHash = canonicalEvidenceHash(fidelityInputs);
  const fidelityRelativePath = `solution-fidelity/v1-0000-${effectiveCorpusHash}-${fidelityInputHash}.json`;
  const fidelityDecisions = fidelityInputs.map((input) => ({
    key: input.key,
    sourcePage: input.sourcePage,
    answerStatus: "exact",
    explanationStatus: "exact",
    evidence: "the explicit raw answer and complete explanation match the official pixels",
  }));
  const fidelityCheckpoint = {
    version: 1,
    entryId: entry.id,
    sourceHash: downloads.solution.sha256,
    from: 1,
    to: 13,
    ownedFrom: 1,
    ownedTo: 13,
    classifierVersion: 4,
    rulesDigest: DIGEST,
    transcriptionGateVersion: 1,
    transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
    effectiveProblemCorpusHash: effectiveCorpusHash,
    inputHash: fidelityInputHash,
    promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    inputs: fidelityInputs,
    items: fidelityDecisions,
  };
  const fidelityHash = writeEvidence(join(stateDir, fidelityRelativePath), fidelityCheckpoint);
  const solutionFidelityCheckpoints = [{
    path: fidelityRelativePath,
    sha256: fidelityHash,
    from: 1,
    to: 13,
    ownedFrom: 1,
    ownedTo: 13,
    inputHash: fidelityInputHash,
  }];
  const solutionFidelityItems = fidelityInputs.map((input, index) => ({
    key: input.key,
    printedNumber: input.printedNumber,
    qtype: input.qtype,
    basePage: input.sourcePage,
    effectivePage: input.sourcePage,
    answerStatus: "exact",
    explanationStatus: "exact",
    evidence: fidelityDecisions[index].evidence,
    fidelityArtifact: { path: fidelityRelativePath, sha256: fidelityHash },
    baseSolutionItemHash: input.baseSolutionItemHash,
    effectiveSolutionItemHash: input.baseSolutionItemHash,
    baseRawAnswerHash: hash(input.rawAnswer),
    effectiveRawAnswerHash: hash(input.rawAnswer),
    baseExplanationHash: hash(input.explanation),
    effectiveExplanationHash: hash(input.explanation),
  })).sort((left, right) => left.key.localeCompare(right.key));
  const effectiveSolutionCorpusHash = canonicalEvidenceHash(fidelityInputs.map((input) => ({
    key: input.key,
    solution: solutionCheckpoint.items.find(
      (item: { number: string }) => item.number === input.printedNumber,
    ),
  })).sort((left, right) => left.key.localeCompare(right.key)));
  const items = answers.map((answer, index) => ({
    key: index === 0 ? "2:1" : "1:2",
    printedNumber: String(index + 1),
    sourcePage: index === 0 ? 2 : 1,
    officialRawAnswerHash: hash(answer.officialRaw),
    storedAnswerHash: hash(answer.storedAnswer),
    mode: "choice-content",
    choiceIndex: answer.choices!.indexOf(answer.storedAnswer) + 1,
    semantic: null,
  })).sort((left, right) => left.key.localeCompare(right.key));
  const auditBasis = {
    entryId: entry.id,
    problemHash: downloads.problem.sha256,
    solutionHash: downloads.solution.sha256,
    classifierVersion: 4,
    rulesDigest: DIGEST,
    transcriptionGateVersion: 1,
    transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
    solutionFidelityVersion: 1,
    solutionFidelityPromptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    semanticChoiceVersion: 3,
    semanticPromptDigest: SEMANTIC_PROMPT_DIGEST,
    sourceQuestionCount: 30,
    acceptedQuestionCount: 2,
    rejectedQuestionCount: 28,
    reviewQuestionCount: 0,
    targetQuestionCounts: {
      "수학 - 수학Ⅱ·미적분Ⅰ": 1,
      "수학 - 수학Ⅰ·대수": 1,
    },
    acceptedSolutionKeys: ["1:2", "2:1"],
    solutionRepairKeys: [],
    derivedAnswerKeys: [],
    acceptedMcqKeys: ["1:2", "2:1"],
    effectiveCorpusHash,
    effectiveSolutionCorpusHash,
    solutionFidelityCheckpoints,
    solutionFidelityItems,
    solutionRepairs: [],
    semanticCheckpoint: null,
    repairs: [repair],
    items,
  };
  const auditDir = join(stateDir, "answer-audit");
  for (const name of readdirSync(auditDir)) rmSync(join(auditDir, name));
  const auditDigest = canonicalEvidenceHash(auditBasis);
  const auditRelativePath = `answer-audit/v2-${auditDigest}.json`;
  const auditHash = writeEvidence(join(stateDir, auditRelativePath), { version: 2, auditDigest, ...auditBasis });
  const attestationDir = join(stateDir, "answer-attestation");
  for (const name of readdirSync(attestationDir)) rmSync(join(attestationDir, name));
  const receiptHash = hash(readFileSync(join(stateDir, "receipt.json")));
  const attestationBasis = {
    entryId: entry.id,
    problemHash: downloads.problem.sha256,
    solutionHash: downloads.solution.sha256,
    classifierVersion: 4,
    rulesDigest: DIGEST,
    transcriptionGateVersion: 1,
    transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
    solutionFidelityVersion: 1,
    solutionFidelityPromptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    receipt: { path: "receipt.json", sha256: receiptHash },
    answerAudit: {
      path: auditRelativePath,
      sha256: auditHash,
      effectiveCorpusHash,
      effectiveSolutionCorpusHash,
    },
    repairs: [repair],
    solutionFidelityCheckpoints,
    solutionFidelityItems,
    solutionRepairs: [],
  };
  const attestationDigest = canonicalEvidenceHash(attestationBasis);
  writeEvidence(join(attestationDir, `v2-${attestationDigest}.json`), {
    version: 2,
    attestationDigest,
    ...attestationBasis,
  });

  const db = new Database(files.dbPath);
  db.prepare("UPDATE questions SET question = ?, src_page = 2 WHERE question = 'math question 1'")
    .run(finalQuestion.question);
  db.prepare("UPDATE book_items SET content = ?, page = 2 WHERE category = '문제' AND content = 'math question 1'")
    .run(finalQuestion.question);
  db.prepare("UPDATE book_files SET page_count = 2 WHERE r2_key LIKE 'corpus/%/problem.pdf' AND book_id IN (SELECT id FROM books WHERE title LIKE '%수학 미적분')")
    .run();
  db.close();
  return {
    classificationArtifact: join(stateDir, classificationArtifactPath),
    revisionProblemArtifact,
    revisionClassificationArtifact,
  };
}

function installQ27SolutionRepair(
  files: ReturnType<typeof fixture>,
  targetNumber = 27,
  markerMode = false,
): {
  repairArtifact: string;
  fidelityArtifact: string;
} {
  const stateDir = files.stateDirs.math;
  const entry = JSON.parse(readFileSync(join(stateDir, "entry.json"), "utf8")).entry;
  const downloads = JSON.parse(readFileSync(join(stateDir, "downloads.json"), "utf8"));
  const problemPath = join(stateDir, "problem-chunks", "v2-0000.json");
  const classificationPath = join(stateDir, "classification-chunks", `v4-0000-${DIGEST}.json`);
  const solutionPath = join(stateDir, "solution-chunks", "v3-0000.json");
  const problemCheckpoint = JSON.parse(readFileSync(problemPath, "utf8"));
  const classificationCheckpoint = JSON.parse(readFileSync(classificationPath, "utf8"));
  const solutionCheckpoint = JSON.parse(readFileSync(solutionPath, "utf8"));
  const targetIndex = targetNumber - 1;
  const targetKey = `1:${targetNumber}`;
  const targetIsFirst = targetNumber === 1;
  const companionNumber = targetIsFirst ? 2 : 1;
  const companionKey = `1:${companionNumber}`;
  const targetProblem = problemCheckpoint.items[targetIndex];
  const targetChoices = markerMode ? ["① 2", "② 3", "③ 4", "④ 5", "⑤ 6"] : null;
  const targetStoredAnswer = markerMode ? "②" : "72";
  Object.assign(targetProblem, {
    qtype: markerMode ? "mcq" : "short",
    question: markerMode
      ? "$3^{(\\frac12)\\times2}$의 값을 고르시오."
      : "두 수 $\\sqrt{2m}$, $\\sqrt[3]{3m}$이 모두 자연수가 되게 하는 자연수 $m$의 최솟값을 구하시오.",
    choices: targetChoices,
    answer: markerMode ? "② 3" : "$72$",
  });
  if (!targetIsFirst) {
    Object.assign(classificationCheckpoint.items[1], {
      decision: "reject",
      canonical_subject: null,
      curriculum_course: null,
      domain: null,
      achievement_codes: [],
      reason_codes: ["OUT_OF_SCOPE"],
    });
  }
  Object.assign(classificationCheckpoint.items[targetIndex], {
    decision: "accept",
    canonical_subject: targetIsFirst ? "math_A" : "math_B",
    curriculum_course: targetIsFirst ? "2015 미적분Ⅰ" : "2015 수학Ⅰ",
    domain: "거듭제곱근",
    achievement_codes: [targetIsFirst ? "12미적Ⅰ-01-01" : "12수학Ⅰ01-01"],
    confidence: 0.99,
    reason_codes: ["IN_SCOPE_ROOTS_AND_POWERS"],
    transcription_status: "exact",
    transcription_evidence: `${targetNumber}번 거듭제곱근 조건이 공식 문제 픽셀과 정확히 일치한다`,
  });
  const targetBaseSolution = solutionCheckpoint.items.find(
    (item: { number: string }) => item.number === String(targetNumber),
  );
  Object.assign(targetBaseSolution, {
    answer: targetStoredAnswer,
    explanation: "$m=3q^3$이어야 하고 결국 $m=2^3\\times3^2=72$이다.",
    page: 1,
    complete: true,
  });
  const basePage = targetBaseSolution.page;
  writeJson(problemPath, problemCheckpoint);
  writeJson(classificationPath, classificationCheckpoint);
  writeJson(solutionPath, solutionCheckpoint);

  const effectiveCorpus = problemCheckpoint.items.map((question: Record<string, unknown>, index: number) => ({
    question,
    classification: classificationCheckpoint.items[index],
  }));
  const effectiveCorpusHash = canonicalEvidenceHash(effectiveCorpus);
  const baseSolutionPointer = {
    path: "solution-chunks/v3-0000.json",
    sha256: hash(readFileSync(solutionPath)),
  };
  const companionProblem = problemCheckpoint.items[companionNumber - 1];
  const companionSolution = solutionCheckpoint.items.find(
    (item: { number: string }) => item.number === String(companionNumber),
  );
  const fidelityRows = [
    { key: companionKey, printedNumber: String(companionNumber), question: companionProblem, solution: companionSolution },
    { key: targetKey, printedNumber: String(targetNumber), question: targetProblem, solution: targetBaseSolution },
  ].sort((left, right) => Number(left.printedNumber) - Number(right.printedNumber));
  const fidelityInputs = fidelityRows.map(({ key, printedNumber, question, solution }) => ({
    key,
    printedNumber,
    qtype: question.qtype,
    allowDerivedMarkerAnswer: markerMode && key === targetKey,
    sourcePage: solution.page,
    rawAnswer: solution.answer,
    explanation: solution.explanation,
    complete: true,
    baseSolutionCheckpoint: baseSolutionPointer,
    baseSolutionItemHash: canonicalEvidenceHash(solution),
    baseContextFrom: 1,
    baseContextTo: 6,
    baseOwnedFrom: 1,
    baseOwnedTo: 4,
  }));
  const fidelityInputHash = canonicalEvidenceHash(fidelityInputs);
  const fidelityRelativePath = `solution-fidelity/v1-0000-${effectiveCorpusHash}-${fidelityInputHash}.json`;
  const fidelityDecisions = fidelityInputs.map((input) => input.key === targetKey ? {
    key: targetKey,
    sourcePage: targetBaseSolution.page,
    answerStatus: "exact",
    explanationStatus: "mismatch",
    evidence: "공식 해설은 m=3^2q^3인데 전사는 m=3q^3이다",
  } : {
    key: companionKey,
    sourcePage: companionSolution.page,
    answerStatus: "exact",
    explanationStatus: "exact",
    evidence: `${companionNumber}번 답과 전체 해설이 공식 픽셀과 정확히 일치한다`,
  });
  const fidelityCheckpoint = {
    version: 1,
    entryId: entry.id,
    sourceHash: downloads.solution.sha256,
    from: 1,
    to: 13,
    ownedFrom: 1,
    ownedTo: 13,
    classifierVersion: 4,
    rulesDigest: DIGEST,
    transcriptionGateVersion: 1,
    transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
    effectiveProblemCorpusHash: effectiveCorpusHash,
    inputHash: fidelityInputHash,
    promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    inputs: fidelityInputs,
    items: fidelityDecisions,
  };
  const fidelityHash = writeEvidence(join(stateDir, fidelityRelativePath), fidelityCheckpoint);
  const baseFidelityPointer = { path: fidelityRelativePath, sha256: fidelityHash };
  const solutionFidelityCheckpoints = [{
    ...baseFidelityPointer,
    from: 1,
    to: 13,
    ownedFrom: 1,
    ownedTo: 13,
    inputHash: fidelityInputHash,
  }];

  const targetInput = fidelityInputs.find((input) => input.key === targetKey)!;
  const companionInput = fidelityInputs.find((input) => input.key === companionKey)!;
  const correctedSolution = {
    number: String(targetNumber),
    answer: targetStoredAnswer,
    explanation: markerMode
      ? "$\\left(\\frac{1}{3^2}\\right)^2=\\frac{1}{81}$이다."
      : "$m=3^2q^3$이어야 하므로 $m=2^3\\times3^2=72$이다.",
    page: 2,
    complete: true,
  };
  const repairRelativePath = `solution-repairs/v1-${String(basePage).padStart(4, "0")}-` +
    `${String(targetNumber).padStart(4, "0")}-${fidelityHash}.json`;
  const repairCheckpoint = {
    version: 1,
    entryId: entry.id,
    key: targetKey,
    printedNumber: String(targetNumber),
    basePage,
    contextFrom: 1,
    contextTo: 6,
    baseOwnedFrom: 1,
    baseOwnedTo: 4,
    sourceHash: downloads.solution.sha256,
    effectiveProblemCorpusHash: effectiveCorpusHash,
    baseSolutionCheckpoint: baseSolutionPointer,
    baseFidelityCheckpoint: baseFidelityPointer,
    baseSolutionItemHash: targetInput.baseSolutionItemHash,
    baseRawAnswerHash: hash(targetInput.rawAnswer),
    baseExplanationHash: hash(targetInput.explanation),
    promptVersion: TARGETED_SOLUTION_TRANSCRIPTION_VERSION,
    promptDigest: TARGETED_SOLUTION_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    effectivePage: 2,
    item: correctedSolution,
  };
  const repairHash = writeEvidence(join(stateDir, repairRelativePath), repairCheckpoint);
  const repairPointer = { path: repairRelativePath, sha256: repairHash };
  const effectiveSolutionItemHash = canonicalEvidenceHash(correctedSolution);
  const repairedInput = {
    ...targetInput,
    sourcePage: 2,
    rawAnswer: correctedSolution.answer,
    explanation: correctedSolution.explanation,
  };
  const repairedInputHash = canonicalEvidenceHash(repairedInput);
  const repairFidelityRelativePath =
    `solution-fidelity-repairs/v1-${String(basePage).padStart(4, "0")}-` +
    `${String(targetNumber).padStart(4, "0")}-${fidelityHash}-${effectiveSolutionItemHash}.json`;
  const repairDecision = {
    key: targetKey,
    sourcePage: 2,
    answerStatus: "exact",
    explanationStatus: "exact",
    evidence: "2쪽의 m=3^2q^3과 마지막 값 72가 모두 정확히 일치한다",
  };
  const repairFidelityCheckpoint = {
    version: 1,
    entryId: entry.id,
    key: targetKey,
    sourceHash: downloads.solution.sha256,
    from: 1,
    to: 6,
    basePage,
    effectivePage: 2,
    baseOwnedFrom: 1,
    baseOwnedTo: 4,
    effectiveProblemCorpusHash: effectiveCorpusHash,
    baseSolutionCheckpoint: baseSolutionPointer,
    baseFidelityCheckpoint: baseFidelityPointer,
    repairArtifact: repairPointer,
    effectiveSolutionItemHash,
    inputHash: repairedInputHash,
    promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    input: repairedInput,
    item: repairDecision,
  };
  const repairFidelityHash = writeEvidence(
    join(stateDir, repairFidelityRelativePath),
    repairFidelityCheckpoint,
  );
  const repairFidelityPointer = { path: repairFidelityRelativePath, sha256: repairFidelityHash };
  const solutionRepair = {
    key: targetKey,
    printedNumber: String(targetNumber),
    basePage,
    effectivePage: 2,
    contextFrom: 1,
    contextTo: 6,
    baseOwnedFrom: 1,
    baseOwnedTo: 4,
    baseSolutionCheckpoint: baseSolutionPointer,
    baseFidelityCheckpoint: baseFidelityPointer,
    repairArtifact: repairPointer,
    fidelityArtifact: { ...repairFidelityPointer, promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST },
    baseSolutionItemHash: targetInput.baseSolutionItemHash,
    effectiveSolutionItemHash,
    baseRawAnswerHash: hash(targetInput.rawAnswer),
    effectiveRawAnswerHash: hash(correctedSolution.answer),
    baseExplanationHash: hash(targetInput.explanation),
    effectiveExplanationHash: hash(correctedSolution.explanation),
  };
  const companionDecision = fidelityDecisions.find((decision) => decision.key === companionKey)!;
  const solutionFidelityItems = [{
    key: companionKey,
    printedNumber: String(companionNumber),
    qtype: companionInput.qtype,
    basePage: companionSolution.page,
    effectivePage: companionSolution.page,
    answerStatus: "exact",
    explanationStatus: "exact",
    evidence: companionDecision.evidence,
    fidelityArtifact: baseFidelityPointer,
    baseSolutionItemHash: companionInput.baseSolutionItemHash,
    effectiveSolutionItemHash: companionInput.baseSolutionItemHash,
    baseRawAnswerHash: hash(companionSolution.answer),
    effectiveRawAnswerHash: hash(companionSolution.answer),
    baseExplanationHash: hash(companionSolution.explanation),
    effectiveExplanationHash: hash(companionSolution.explanation),
  }, {
    key: targetKey,
    printedNumber: String(targetNumber),
    qtype: targetProblem.qtype,
    basePage,
    effectivePage: 2,
    answerStatus: "exact",
    explanationStatus: "exact",
    evidence: repairDecision.evidence,
    fidelityArtifact: repairFidelityPointer,
    baseSolutionItemHash: targetInput.baseSolutionItemHash,
    effectiveSolutionItemHash,
    baseRawAnswerHash: hash(targetInput.rawAnswer),
    effectiveRawAnswerHash: hash(correctedSolution.answer),
    baseExplanationHash: hash(targetInput.explanation),
    effectiveExplanationHash: hash(correctedSolution.explanation),
  }].sort((left, right) => compareCorpusQuestionKeys(left.key, right.key));
  const effectiveSolutionCorpusHash = canonicalEvidenceHash([{
    key: companionKey,
    solution: companionSolution,
  }, {
    key: targetKey,
    solution: correctedSolution,
  }].sort((left, right) => compareCorpusQuestionKeys(left.key, right.key)));
  const answer = answerCase("math", companionNumber - 1);
  const auditItems: Array<Record<string, unknown>> = [{
    key: companionKey,
    printedNumber: String(companionNumber),
    sourcePage: companionProblem.page,
    officialRawAnswerHash: hash(answer.officialRaw),
    storedAnswerHash: hash(answer.storedAnswer),
    mode: "choice-content",
    choiceIndex: answer.choices!.indexOf(answer.storedAnswer) + 1,
    semantic: null,
  }];
  if (markerMode) {
    auditItems.push({
      key: targetKey,
      printedNumber: String(targetNumber),
      sourcePage: targetProblem.page,
      officialRawAnswerHash: hash(targetStoredAnswer),
      storedAnswerHash: hash(targetStoredAnswer),
      mode: "choice-marker",
      choiceIndex: 2,
      semantic: null,
    });
    auditItems.sort((left, right) => compareCorpusQuestionKeys(String(left.key), String(right.key)));
  }
  const auditBasis = {
    entryId: entry.id,
    problemHash: downloads.problem.sha256,
    solutionHash: downloads.solution.sha256,
    classifierVersion: 4,
    rulesDigest: DIGEST,
    transcriptionGateVersion: 1,
    transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
    solutionFidelityVersion: 1,
    solutionFidelityPromptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    semanticChoiceVersion: 3,
    semanticPromptDigest: SEMANTIC_PROMPT_DIGEST,
    sourceQuestionCount: 30,
    acceptedQuestionCount: 2,
    rejectedQuestionCount: 28,
    reviewQuestionCount: 0,
    targetQuestionCounts: {
      "수학 - 수학Ⅱ·미적분Ⅰ": 1,
      "수학 - 수학Ⅰ·대수": 1,
    },
    acceptedSolutionKeys: [companionKey, targetKey].sort(compareCorpusQuestionKeys),
    solutionRepairKeys: [targetKey],
    derivedAnswerKeys: [],
    acceptedMcqKeys: auditItems.map((item) => String(item.key)).sort(compareCorpusQuestionKeys),
    effectiveCorpusHash,
    effectiveSolutionCorpusHash,
    solutionFidelityCheckpoints,
    solutionFidelityItems,
    solutionRepairs: [solutionRepair],
    semanticCheckpoint: null,
    repairs: [],
    items: auditItems,
  };
  const auditDir = join(stateDir, "answer-audit");
  for (const name of readdirSync(auditDir)) rmSync(join(auditDir, name));
  const auditDigest = canonicalEvidenceHash(auditBasis);
  const auditRelativePath = `answer-audit/v2-${auditDigest}.json`;
  const auditHash = writeEvidence(join(stateDir, auditRelativePath), {
    version: 2,
    auditDigest,
    ...auditBasis,
  });
  const attestationDir = join(stateDir, "answer-attestation");
  for (const name of readdirSync(attestationDir)) rmSync(join(attestationDir, name));
  const receiptHash = hash(readFileSync(join(stateDir, "receipt.json")));
  const attestationBasis = {
    entryId: entry.id,
    problemHash: downloads.problem.sha256,
    solutionHash: downloads.solution.sha256,
    classifierVersion: 4,
    rulesDigest: DIGEST,
    transcriptionGateVersion: 1,
    transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
    solutionFidelityVersion: 1,
    solutionFidelityPromptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    receipt: { path: "receipt.json", sha256: receiptHash },
    answerAudit: {
      path: auditRelativePath,
      sha256: auditHash,
      effectiveCorpusHash,
      effectiveSolutionCorpusHash,
    },
    repairs: [],
    solutionFidelityCheckpoints,
    solutionFidelityItems,
    solutionRepairs: [solutionRepair],
  };
  const attestationDigest = canonicalEvidenceHash(attestationBasis);
  writeEvidence(join(attestationDir, `v2-${attestationDigest}.json`), {
    version: 2,
    attestationDigest,
    ...attestationBasis,
  });

  const db = new Database(files.dbPath);
  const targetBook = db.prepare(`
    SELECT books.id
    FROM books JOIN subjects ON subjects.id = books.subject_id
    WHERE subjects.name = ?
  `).get(targetIsFirst ? "수학 - 수학Ⅱ·미적분Ⅰ" : "수학 - 수학Ⅰ·대수") as { id: number };
  db.prepare(`
    UPDATE questions
    SET qtype = ?, question = ?, choices = ?, answer = ?, explanation = ?,
        book_number = ?, printed_number = ?, src_page = ?
    WHERE book_id = ?
  `).run(
    targetProblem.qtype,
    targetProblem.question,
    targetChoices === null ? null : JSON.stringify(targetChoices),
    targetStoredAnswer,
    correctedSolution.explanation,
    String(targetNumber),
    String(targetNumber),
    targetProblem.page,
    targetBook.id,
  );
  db.prepare(`
    UPDATE book_items
    SET number = ?, answer = ?, content = ?, page = 1
    WHERE book_id = ? AND category = '문제'
  `).run(String(targetNumber), targetStoredAnswer, targetProblem.question, targetBook.id);
  db.prepare(`
    UPDATE book_items
    SET number = ?, answer = ?, content = ?, page = 2
    WHERE book_id = ? AND category = '해설'
  `).run(String(targetNumber), targetStoredAnswer, correctedSolution.explanation, targetBook.id);
  db.close();
  return {
    repairArtifact: join(stateDir, repairRelativePath),
    fidelityArtifact: join(stateDir, repairFidelityRelativePath),
  };
}

function installQ28SolutionRevision(files: ReturnType<typeof fixture>, firstTerminal = false): {
  firstFidelityArtifact: string;
  revisionArtifact: string;
  revisionFidelityArtifact: string;
} {
  installQ27SolutionRepair(files, 28);
  const stateDir = files.stateDirs.math;
  const entry = JSON.parse(readFileSync(join(stateDir, "entry.json"), "utf8")).entry;
  const downloads = JSON.parse(readFileSync(join(stateDir, "downloads.json"), "utf8"));
  const attestationDir = join(stateDir, "answer-attestation");
  const attestationName = readdirSync(attestationDir).find((name) => /^v2-/u.test(name))!;
  const attestation = JSON.parse(readFileSync(join(attestationDir, attestationName), "utf8"));
  const audit = JSON.parse(readFileSync(join(stateDir, attestation.answerAudit.path), "utf8"));
  const repair = audit.solutionRepairs[0];
  const firstRepairCheckpoint = JSON.parse(
    readFileSync(join(stateDir, repair.repairArtifact.path), "utf8"),
  );
  const firstSolution = firstRepairCheckpoint.item;
  const firstFidelityPath = join(stateDir, repair.fidelityArtifact.path);
  const firstFidelityCheckpoint = JSON.parse(readFileSync(firstFidelityPath, "utf8"));
  const firstDecision = {
    key: "1:28",
    sourcePage: firstSolution.page,
    answerStatus: "exact",
    explanationStatus: firstTerminal ? "exact" : "mismatch",
    evidence: firstTerminal
      ? "첫 repair가 이미 원본과 완전히 일치한다"
      : "x→-2 두 극한과 '크거나 같아야' 문구가 누락됐다",
  };
  firstFidelityCheckpoint.item = firstDecision;
  const firstFidelityHash = writeEvidence(firstFidelityPath, firstFidelityCheckpoint);
  repair.fidelityArtifact.sha256 = firstFidelityHash;

  const trigger = {
    kind: "fidelity",
    fidelityDecisionHash: canonicalEvidenceHash(firstDecision),
  };
  const revisionBasisHash = canonicalEvidenceHash({
    key: "1:28",
    sourceHash: downloads.solution.sha256,
    basePage: repair.basePage,
    contextFrom: repair.contextFrom,
    contextTo: repair.contextTo,
    baseSolutionCheckpoint: repair.baseSolutionCheckpoint,
    baseSolutionItemHash: repair.baseSolutionItemHash,
    baseRepairArtifact: repair.repairArtifact,
    baseRepairFidelityArtifact: repair.fidelityArtifact,
    baseRepairSolutionItemHash: repair.effectiveSolutionItemHash,
    trigger,
    revisionPromptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
  });
  const revisionRelativePath = `solution-revisions/v1-${String(firstSolution.page).padStart(4, "0")}-` +
    `0028-${revisionBasisHash}.json`;
  const finalExplanation =
    "$\\lim_{x\\to2}f(x)=0$, $\\lim_{x\\to-2}f(x)=0$, " +
    "$\\lim_{x\\to2}g(x)=0$, $\\lim_{x\\to-2}g(x)=0$이고 함수값이 크거나 같아야 한다.";
  const finalSolution = {
    number: "28",
    answer: "72",
    explanation: finalExplanation,
    page: 2,
    complete: true,
  };
  const revisionCheckpoint = {
    version: 1,
    entryId: entry.id,
    key: "1:28",
    printedNumber: "28",
    sourceHash: downloads.solution.sha256,
    basePage: repair.basePage,
    contextFrom: repair.contextFrom,
    contextTo: repair.contextTo,
    baseOwnedFrom: repair.baseOwnedFrom,
    baseOwnedTo: repair.baseOwnedTo,
    effectiveProblemCorpusHash: audit.effectiveCorpusHash,
    baseSolutionCheckpoint: repair.baseSolutionCheckpoint,
    baseSolutionItemHash: repair.baseSolutionItemHash,
    baseRepairArtifact: repair.repairArtifact,
    baseRepairFidelityArtifact: repair.fidelityArtifact,
    baseRepairPage: firstSolution.page,
    baseRepairSolutionItemHash: repair.effectiveSolutionItemHash,
    trigger,
    diagnosticDecision: firstDecision,
    diagnosticDecisionHash: trigger.fidelityDecisionHash,
    promptVersion: TARGETED_SOLUTION_REVISION_VERSION,
    promptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    effectivePage: finalSolution.page,
    item: finalSolution,
  };
  const revisionHash = writeEvidence(join(stateDir, revisionRelativePath), revisionCheckpoint);
  const revisionPointer = { path: revisionRelativePath, sha256: revisionHash };
  const finalSolutionItemHash = canonicalEvidenceHash(finalSolution);
  const finalInput = {
    ...firstFidelityCheckpoint.input,
    sourcePage: finalSolution.page,
    rawAnswer: finalSolution.answer,
    explanation: finalSolution.explanation,
  };
  const revisionFidelityRelativePath = `solution-fidelity-revisions/v1-` +
    `${String(firstSolution.page).padStart(4, "0")}-0028-${revisionHash}-${finalSolutionItemHash}.json`;
  const finalDecision = {
    key: "1:28",
    sourcePage: finalSolution.page,
    answerStatus: "exact",
    explanationStatus: "exact",
    evidence: "±2 네 극한 줄과 '크거나 같아야'가 모두 공식 픽셀과 일치한다",
  };
  const revisionFidelityCheckpoint = {
    version: 1,
    entryId: entry.id,
    key: "1:28",
    sourceHash: downloads.solution.sha256,
    from: repair.contextFrom,
    to: repair.contextTo,
    basePage: repair.basePage,
    baseRepairPage: firstSolution.page,
    effectivePage: finalSolution.page,
    baseOwnedFrom: repair.baseOwnedFrom,
    baseOwnedTo: repair.baseOwnedTo,
    effectiveProblemCorpusHash: audit.effectiveCorpusHash,
    baseSolutionCheckpoint: repair.baseSolutionCheckpoint,
    baseSolutionItemHash: repair.baseSolutionItemHash,
    baseRepairArtifact: repair.repairArtifact,
    baseRepairFidelityArtifact: repair.fidelityArtifact,
    baseRepairSolutionItemHash: repair.effectiveSolutionItemHash,
    diagnosticDecisionHash: trigger.fidelityDecisionHash,
    trigger,
    revisionArtifact: revisionPointer,
    effectiveSolutionItemHash: finalSolutionItemHash,
    inputHash: canonicalEvidenceHash(finalInput),
    promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    input: finalInput,
    item: finalDecision,
  };
  const revisionFidelityHash = writeEvidence(
    join(stateDir, revisionFidelityRelativePath),
    revisionFidelityCheckpoint,
  );
  const revisionFidelityPointer = {
    path: revisionFidelityRelativePath,
    sha256: revisionFidelityHash,
  };
  repair.revision = {
    trigger,
    baseRepairPage: firstSolution.page,
    effectivePage: finalSolution.page,
    baseRepairArtifact: repair.repairArtifact,
    baseRepairFidelityArtifact: repair.fidelityArtifact,
    solutionArtifact: {
      ...revisionPointer,
      revisionPromptVersion: TARGETED_SOLUTION_REVISION_VERSION,
      revisionPromptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
    },
    fidelityArtifact: {
      ...revisionFidelityPointer,
      promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    },
    diagnosticDecisionHash: trigger.fidelityDecisionHash,
    baseSolutionItemHash: repair.baseSolutionItemHash,
    baseRepairSolutionItemHash: repair.effectiveSolutionItemHash,
    effectiveSolutionItemHash: finalSolutionItemHash,
    baseRepairRawAnswerHash: hash(firstSolution.answer),
    effectiveRawAnswerHash: hash(finalSolution.answer),
    baseRepairExplanationHash: hash(firstSolution.explanation),
    effectiveExplanationHash: hash(finalSolution.explanation),
  };
  const terminalItem = audit.solutionFidelityItems.find((item: { key: string }) => item.key === "1:28");
  Object.assign(terminalItem, {
    effectivePage: finalSolution.page,
    answerStatus: finalDecision.answerStatus,
    explanationStatus: finalDecision.explanationStatus,
    evidence: finalDecision.evidence,
    fidelityArtifact: revisionFidelityPointer,
    effectiveSolutionItemHash: finalSolutionItemHash,
    effectiveRawAnswerHash: hash(finalSolution.answer),
    effectiveExplanationHash: hash(finalSolution.explanation),
  });
  const solutionCheckpoint = JSON.parse(
    readFileSync(join(stateDir, "solution-chunks", "v3-0000.json"), "utf8"),
  );
  const q1Solution = solutionCheckpoint.items.find((item: { number: string }) => item.number === "1");
  audit.effectiveSolutionCorpusHash = canonicalEvidenceHash([{
    key: "1:1",
    solution: q1Solution,
  }, {
    key: "1:28",
    solution: finalSolution,
  }]);

  const { version: _auditVersion, auditDigest: _oldAuditDigest, ...auditBasis } = audit;
  const auditDigest = canonicalEvidenceHash(auditBasis);
  const auditRelativePath = `answer-audit/v2-${auditDigest}.json`;
  for (const name of readdirSync(join(stateDir, "answer-audit"))) rmSync(join(stateDir, "answer-audit", name));
  const auditHash = writeEvidence(join(stateDir, auditRelativePath), {
    version: 2,
    auditDigest,
    ...auditBasis,
  });
  const { version: _attestationVersion, attestationDigest: _oldAttestationDigest, ...attestationBasis } = attestation;
  attestationBasis.answerAudit = {
    path: auditRelativePath,
    sha256: auditHash,
    effectiveCorpusHash: audit.effectiveCorpusHash,
    effectiveSolutionCorpusHash: audit.effectiveSolutionCorpusHash,
  };
  attestationBasis.solutionFidelityItems = audit.solutionFidelityItems;
  attestationBasis.solutionRepairs = audit.solutionRepairs;
  const attestationDigest = canonicalEvidenceHash(attestationBasis);
  for (const name of readdirSync(attestationDir)) rmSync(join(attestationDir, name));
  writeEvidence(join(attestationDir, `v2-${attestationDigest}.json`), {
    version: 2,
    attestationDigest,
    ...attestationBasis,
  });

  const db = new Database(files.dbPath);
  db.prepare("UPDATE questions SET explanation = ? WHERE printed_number = '28'")
    .run(finalSolution.explanation);
  db.prepare("UPDATE book_items SET content = ?, page = 2 WHERE category = '해설' AND number = '28'")
    .run(finalSolution.explanation);
  db.close();
  return {
    firstFidelityArtifact: firstFidelityPath,
    revisionArtifact: join(stateDir, revisionRelativePath),
    revisionFidelityArtifact: join(stateDir, revisionFidelityRelativePath),
  };
}

function migratePersistedSolutionGeneration(
  files: ReturnType<typeof fixture>,
  targetNumber: 27 | 28,
  q1SemanticPending = false,
): {
  repairArtifact: string;
  repairFidelityArtifact: string;
  revisionArtifact?: string;
  revisionFidelityArtifact?: string;
  historicalRepairArtifact: string;
  historicalRevisionArtifact?: string;
} {
  if (targetNumber === 27) installQ27SolutionRepair(files, 27);
  else installQ28SolutionRevision(files);
  const stateDir = files.stateDirs.math;
  const entry = JSON.parse(readFileSync(join(stateDir, "entry.json"), "utf8")).entry;
  const downloads = JSON.parse(readFileSync(join(stateDir, "downloads.json"), "utf8"));
  const attestationName = readdirSync(join(stateDir, "answer-attestation"))
    .find((name) => /^v2-/u.test(name))!;
  const attestation = JSON.parse(
    readFileSync(join(stateDir, "answer-attestation", attestationName), "utf8"),
  );
  const historicalAudit = JSON.parse(readFileSync(join(stateDir, attestation.answerAudit.path), "utf8"));
  const historicalClassificationPath = join(stateDir, "classification-chunks", `v4-0000-${DIGEST}.json`);
  const historicalClassification = JSON.parse(readFileSync(historicalClassificationPath, "utf8"));
  const oldRepair = structuredClone(historicalAudit.solutionRepairs[0]);
  const oldRepairCheckpoint = JSON.parse(
    readFileSync(join(stateDir, oldRepair.repairArtifact.path), "utf8"),
  );
  const oldBaseFidelity = JSON.parse(
    readFileSync(join(stateDir, oldRepair.baseFidelityCheckpoint.path), "utf8"),
  );
  const oldEffectiveCorpusHash = historicalAudit.effectiveCorpusHash;
  const oldGenerationId = canonicalEvidenceHash({
    key: oldRepair.key,
    effectiveProblemCorpusHash: oldEffectiveCorpusHash,
    baseFidelityCheckpointSha256: oldRepair.baseFidelityCheckpoint.sha256,
  });

  const key = `1:${targetNumber}`;
  const historicalTargetInput = oldBaseFidelity.inputs.find((input: { key: string }) => input.key === key);
  const historicalTargetDecision = oldBaseFidelity.items.find((item: { key: string }) => item.key === key);
  const baseSolutionCheckpoint = JSON.parse(
    readFileSync(join(stateDir, "solution-chunks", "v3-0000.json"), "utf8"),
  );
  const historicalBaseSolution = baseSolutionCheckpoint.items.find(
    (item: { number: string }) => item.number === String(targetNumber),
  );
  const baselineAudit = structuredClone(historicalAudit);
  const baselineTargetItem = baselineAudit.solutionFidelityItems.find(
    (item: { key: string }) => item.key === key,
  );
  Object.assign(baselineTargetItem, {
    effectivePage: historicalBaseSolution.page,
    answerStatus: historicalTargetDecision.answerStatus,
    explanationStatus: historicalTargetDecision.explanationStatus,
    evidence: historicalTargetDecision.evidence,
    fidelityArtifact: oldRepair.baseFidelityCheckpoint,
    effectiveSolutionItemHash: historicalTargetInput.baseSolutionItemHash,
    effectiveRawAnswerHash: hash(historicalBaseSolution.answer),
    effectiveExplanationHash: hash(historicalBaseSolution.explanation),
  });
  baselineAudit.solutionRepairs = [];
  baselineAudit.solutionRepairKeys = [];
  const historicalCompanion = baseSolutionCheckpoint.items.find(
    (item: { number: string }) => item.number === "1",
  );
  baselineAudit.effectiveSolutionCorpusHash = canonicalEvidenceHash([{
    key: "1:1",
    solution: historicalCompanion,
  }, {
    key,
    solution: historicalBaseSolution,
  }].sort((left, right) => compareCorpusQuestionKeys(left.key, right.key)));
  rewriteSolutionAuditAuthority(files, (currentAudit) => Object.assign(currentAudit, baselineAudit));
  upgradeEntryToV3(files, "math", {
    terminalScope: "authorized-reject",
    answerV5: true,
  });
  const currentAttestationName = readdirSync(join(stateDir, "answer-attestation"))
    .find((name) => /^v5-/u.test(name))!;
  const currentAttestation = JSON.parse(
    readFileSync(join(stateDir, "answer-attestation", currentAttestationName), "utf8"),
  );
  const audit = JSON.parse(readFileSync(join(stateDir, currentAttestation.answerAudit.path), "utf8"));
  const effectiveCorpusHash = audit.effectiveCorpusHash;
  const currentBaseEvidence = audit.solutionFidelityCheckpoints[0];
  const currentBaseFidelity = JSON.parse(
    readFileSync(join(stateDir, currentBaseEvidence.path), "utf8"),
  );
  const targetInput = currentBaseFidelity.inputs.find((input: { key: string }) => input.key === key);
  const targetBaseDecision = currentBaseFidelity.items.find((item: { key: string }) => item.key === key);
  Object.assign(targetBaseDecision, {
    sourcePage: targetInput.sourcePage,
    answerStatus: "exact",
    explanationStatus: "exact",
    evidence: "fresh stochastic fidelity incorrectly treats the historical omission as exact",
  });
  if (q1SemanticPending) {
    Object.assign(
      currentBaseFidelity.items.find((item: { key: string }) => item.key === "1:1"),
      {
        answerStatus: "exact",
        explanationStatus: "mismatch",
        evidence: "Q1 base explanation remains semantically corrupted and requires repair",
      },
    );
  }
  const baseFidelityRelativePath = `solution-fidelity/v1-0000-${effectiveCorpusHash}-` +
    `${currentBaseFidelity.inputHash}.json`;
  const baseFidelityHash = writeEvidence(
    join(stateDir, baseFidelityRelativePath),
    currentBaseFidelity,
  );
  const baseFidelityPointer = { path: baseFidelityRelativePath, sha256: baseFidelityHash };
  const baseFidelityEvidence = {
    ...baseFidelityPointer,
    from: currentBaseFidelity.from,
    to: currentBaseFidelity.to,
    ownedFrom: currentBaseFidelity.ownedFrom,
    ownedTo: currentBaseFidelity.ownedTo,
    inputHash: currentBaseFidelity.inputHash,
  };
  const repairedSolution = oldRepairCheckpoint.item;
  const repairedItemHash = canonicalEvidenceHash(repairedSolution);
  const persistedSeed = {
    version: 1,
    generationId: oldGenerationId,
    effectiveProblemCorpusHash: oldEffectiveCorpusHash,
    baseFidelityCheckpoint: oldRepair.baseFidelityCheckpoint,
    repairArtifact: oldRepair.repairArtifact,
    repairFidelityArtifact: {
      path: oldRepair.fidelityArtifact.path,
      sha256: oldRepair.fidelityArtifact.sha256,
    },
    repairedItemHash,
  };
  const repairRelativePath = `solution-repairs/v1-${String(oldRepair.basePage).padStart(4, "0")}-` +
    `${String(targetNumber).padStart(4, "0")}-${baseFidelityHash}.json`;
  const repairCheckpoint = {
    ...oldRepairCheckpoint,
    effectiveProblemCorpusHash: effectiveCorpusHash,
    baseFidelityCheckpoint: baseFidelityPointer,
    persistedSeed,
  };
  const repairHash = writeEvidence(join(stateDir, repairRelativePath), repairCheckpoint);
  const repairPointer = { path: repairRelativePath, sha256: repairHash };
  const repairedInput = {
    ...targetInput,
    sourcePage: repairedSolution.page,
    rawAnswer: repairedSolution.answer,
    explanation: repairedSolution.explanation,
  };
  const currentFirstDecision = {
    key,
    sourcePage: repairedSolution.page,
    answerStatus: "exact",
    explanationStatus: "exact",
    evidence: "current repaired solution appears exact but remains bound to persisted authority",
  };
  const repairFidelityRelativePath = `solution-fidelity-repairs/v1-` +
    `${String(oldRepair.basePage).padStart(4, "0")}-${String(targetNumber).padStart(4, "0")}-` +
    `${baseFidelityHash}-${repairedItemHash}.json`;
  const repairFidelityCheckpoint = {
    version: 1,
    entryId: entry.id,
    key,
    sourceHash: downloads.solution.sha256,
    from: oldRepair.contextFrom,
    to: oldRepair.contextTo,
    basePage: oldRepair.basePage,
    effectivePage: repairedSolution.page,
    baseOwnedFrom: oldRepair.baseOwnedFrom,
    baseOwnedTo: oldRepair.baseOwnedTo,
    effectiveProblemCorpusHash: effectiveCorpusHash,
    baseSolutionCheckpoint: oldRepair.baseSolutionCheckpoint,
    baseFidelityCheckpoint: baseFidelityPointer,
    repairArtifact: repairPointer,
    effectiveSolutionItemHash: repairedItemHash,
    inputHash: canonicalEvidenceHash(repairedInput),
    promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    input: repairedInput,
    item: currentFirstDecision,
  };
  const repairFidelityHash = writeEvidence(
    join(stateDir, repairFidelityRelativePath),
    repairFidelityCheckpoint,
  );
  const repairFidelityPointer = {
    path: repairFidelityRelativePath,
    sha256: repairFidelityHash,
  };
  const currentRepair: Record<string, any> = {
    ...oldRepair,
    baseFidelityCheckpoint: baseFidelityPointer,
    repairArtifact: repairPointer,
    fidelityArtifact: {
      ...repairFidelityPointer,
      promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    },
  };
  delete currentRepair.revision;

  let revisionRelativePath: string | undefined;
  let revisionFidelityRelativePath: string | undefined;
  if (oldRepair.revision) {
    const oldRevisionCheckpoint = JSON.parse(
      readFileSync(join(stateDir, oldRepair.revision.solutionArtifact.path), "utf8"),
    );
    const oldFinalSolution = oldRevisionCheckpoint.item;
    const predecessor = {
      generationId: oldGenerationId,
      key,
      repairArtifact: oldRepair.repairArtifact,
      repairFidelityArtifact: {
        path: oldRepair.fidelityArtifact.path,
        sha256: oldRepair.fidelityArtifact.sha256,
      },
      revisionArtifact: {
        path: oldRepair.revision.solutionArtifact.path,
        sha256: oldRepair.revision.solutionArtifact.sha256,
      },
      revisionFidelityArtifact: {
        path: oldRepair.revision.fidelityArtifact.path,
        sha256: oldRepair.revision.fidelityArtifact.sha256,
      },
      finalSolutionItemHash: oldRepair.revision.effectiveSolutionItemHash,
      diagnosticDecisionHash: oldRepair.revision.diagnosticDecisionHash,
      diagnosticEvidence: oldRevisionCheckpoint.diagnosticDecision.evidence,
    };
    const trigger = {
      kind: "persisted",
      fidelityDecisionHash: canonicalEvidenceHash(currentFirstDecision),
      persistedTriggerVersion: 1,
      predecessor,
    };
    const baseRepairFidelityArtifact = {
      ...repairFidelityPointer,
      promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    };
    const revisionBasisHash = canonicalEvidenceHash({
      key,
      sourceHash: downloads.solution.sha256,
      basePage: oldRepair.basePage,
      contextFrom: oldRepair.contextFrom,
      contextTo: oldRepair.contextTo,
      baseSolutionCheckpoint: oldRepair.baseSolutionCheckpoint,
      baseSolutionItemHash: oldRepair.baseSolutionItemHash,
      baseRepairArtifact: repairPointer,
      baseRepairFidelityArtifact,
      baseRepairSolutionItemHash: repairedItemHash,
      trigger,
      revisionPromptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
    });
    revisionRelativePath = `solution-revisions/v1-${String(repairedSolution.page).padStart(4, "0")}-` +
      `${String(targetNumber).padStart(4, "0")}-${revisionBasisHash}.json`;
    const revisionCheckpoint = {
      version: 1,
      entryId: entry.id,
      key,
      printedNumber: String(targetNumber),
      sourceHash: downloads.solution.sha256,
      basePage: oldRepair.basePage,
      contextFrom: oldRepair.contextFrom,
      contextTo: oldRepair.contextTo,
      baseOwnedFrom: oldRepair.baseOwnedFrom,
      baseOwnedTo: oldRepair.baseOwnedTo,
      effectiveProblemCorpusHash: effectiveCorpusHash,
      baseSolutionCheckpoint: oldRepair.baseSolutionCheckpoint,
      baseSolutionItemHash: oldRepair.baseSolutionItemHash,
      baseRepairArtifact: repairPointer,
      baseRepairFidelityArtifact,
      baseRepairPage: repairedSolution.page,
      baseRepairSolutionItemHash: repairedItemHash,
      trigger,
      diagnosticDecision: currentFirstDecision,
      diagnosticDecisionHash: trigger.fidelityDecisionHash,
      promptVersion: TARGETED_SOLUTION_REVISION_VERSION,
      promptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      effectivePage: oldFinalSolution.page,
      item: oldFinalSolution,
    };
    const revisionHash = writeEvidence(join(stateDir, revisionRelativePath), revisionCheckpoint);
    const revisionPointer = { path: revisionRelativePath, sha256: revisionHash };
    const finalItemHash = canonicalEvidenceHash(oldFinalSolution);
    const finalInput = {
      ...targetInput,
      sourcePage: oldFinalSolution.page,
      rawAnswer: oldFinalSolution.answer,
      explanation: oldFinalSolution.explanation,
    };
    const oldFinalFidelity = JSON.parse(
      readFileSync(join(stateDir, oldRepair.revision.fidelityArtifact.path), "utf8"),
    );
    revisionFidelityRelativePath = `solution-fidelity-revisions/v1-` +
      `${String(repairedSolution.page).padStart(4, "0")}-${String(targetNumber).padStart(4, "0")}-` +
      `${revisionHash}-${finalItemHash}.json`;
    const revisionFidelityCheckpoint = {
      version: 1,
      entryId: entry.id,
      key,
      sourceHash: downloads.solution.sha256,
      from: oldRepair.contextFrom,
      to: oldRepair.contextTo,
      basePage: oldRepair.basePage,
      baseRepairPage: repairedSolution.page,
      effectivePage: oldFinalSolution.page,
      baseOwnedFrom: oldRepair.baseOwnedFrom,
      baseOwnedTo: oldRepair.baseOwnedTo,
      effectiveProblemCorpusHash: effectiveCorpusHash,
      baseSolutionCheckpoint: oldRepair.baseSolutionCheckpoint,
      baseSolutionItemHash: oldRepair.baseSolutionItemHash,
      baseRepairArtifact: repairPointer,
      baseRepairFidelityArtifact,
      baseRepairSolutionItemHash: repairedItemHash,
      diagnosticDecisionHash: trigger.fidelityDecisionHash,
      trigger,
      revisionArtifact: revisionPointer,
      effectiveSolutionItemHash: finalItemHash,
      inputHash: canonicalEvidenceHash(finalInput),
      promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      input: finalInput,
      item: oldFinalFidelity.item,
    };
    const revisionFidelityHash = writeEvidence(
      join(stateDir, revisionFidelityRelativePath),
      revisionFidelityCheckpoint,
    );
    const revisionFidelityPointer = {
      path: revisionFidelityRelativePath,
      sha256: revisionFidelityHash,
    };
    currentRepair.revision = {
      trigger,
      baseRepairPage: repairedSolution.page,
      effectivePage: oldFinalSolution.page,
      baseRepairArtifact: repairPointer,
      baseRepairFidelityArtifact,
      solutionArtifact: {
        ...revisionPointer,
        revisionPromptVersion: TARGETED_SOLUTION_REVISION_VERSION,
        revisionPromptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
      },
      fidelityArtifact: {
        ...revisionFidelityPointer,
        promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
      },
      diagnosticDecisionHash: trigger.fidelityDecisionHash,
      baseSolutionItemHash: oldRepair.baseSolutionItemHash,
      baseRepairSolutionItemHash: repairedItemHash,
      effectiveSolutionItemHash: finalItemHash,
      baseRepairRawAnswerHash: hash(repairedSolution.answer),
      effectiveRawAnswerHash: hash(oldFinalSolution.answer),
      baseRepairExplanationHash: hash(repairedSolution.explanation),
      effectiveExplanationHash: hash(oldFinalSolution.explanation),
    };
  }

  audit.effectiveCorpusHash = effectiveCorpusHash;
  audit.effectiveSolutionCorpusHash = historicalAudit.effectiveSolutionCorpusHash;
  audit.acceptedSolutionKeys = historicalAudit.acceptedSolutionKeys;
  audit.solutionRepairKeys = historicalAudit.solutionRepairKeys;
  audit.derivedAnswerKeys = historicalAudit.derivedAnswerKeys;
  audit.acceptedMcqKeys = historicalAudit.acceptedMcqKeys;
  audit.items = historicalAudit.items;
  audit.solutionFidelityCheckpoints = [baseFidelityEvidence];
  audit.solutionRepairs = [currentRepair];
  const historicalTargetTerminal = structuredClone(
    historicalAudit.solutionFidelityItems.find((item: { key: string }) => item.key === key),
  );
  for (const [index, item] of audit.solutionFidelityItems.entries()) {
    if (item.key === key) {
      historicalTargetTerminal.fidelityArtifact = currentRepair.revision
        ? currentRepair.revision.fidelityArtifact
        : repairFidelityPointer;
      if (!currentRepair.revision) historicalTargetTerminal.evidence = currentFirstDecision.evidence;
      audit.solutionFidelityItems[index] = historicalTargetTerminal;
    } else {
      item.fidelityArtifact = baseFidelityPointer;
    }
  }
  rewriteSolutionAuditAuthority(files, (currentAudit) => Object.assign(currentAudit, audit));
  writeJson(historicalClassificationPath, historicalClassification);
  writeEvidence(join(stateDir, attestation.answerAudit.path), historicalAudit);
  writeEvidence(join(stateDir, "answer-attestation", attestationName), attestation);
  return {
    repairArtifact: join(stateDir, repairRelativePath),
    repairFidelityArtifact: join(stateDir, repairFidelityRelativePath),
    ...(revisionRelativePath ? { revisionArtifact: join(stateDir, revisionRelativePath) } : {}),
    ...(revisionFidelityRelativePath
      ? { revisionFidelityArtifact: join(stateDir, revisionFidelityRelativePath) }
      : {}),
    historicalRepairArtifact: join(stateDir, oldRepair.repairArtifact.path),
    ...(oldRepair.revision
      ? { historicalRevisionArtifact: join(stateDir, oldRepair.revision.solutionArtifact.path) }
      : {}),
  };
}

function cloneHistoricalFirstSolutionGeneration(
  files: ReturnType<typeof fixture>,
  sourceRepairArtifact: string,
  label: string,
): { repairArtifact: string; fidelityArtifact: string } {
  const stateDir = files.stateDirs.math;
  const repair = JSON.parse(readFileSync(sourceRepairArtifact, "utf8"));
  const sourceRepairRelativePath = sourceRepairArtifact.split(`${stateDir}/`)[1];
  const sourceFidelityName = readdirSync(join(stateDir, "solution-fidelity-repairs")).find((name) => {
    const checkpoint = JSON.parse(
      readFileSync(join(stateDir, "solution-fidelity-repairs", name), "utf8"),
    );
    return checkpoint.repairArtifact.path === sourceRepairRelativePath;
  })!;
  const sourceFidelity = JSON.parse(
    readFileSync(join(stateDir, "solution-fidelity-repairs", sourceFidelityName), "utf8"),
  );
  const baseFidelity = JSON.parse(
    readFileSync(join(stateDir, repair.baseFidelityCheckpoint.path), "utf8"),
  );
  const effectiveProblemCorpusHash = hash(`historical solution generation ${label}`);
  baseFidelity.effectiveProblemCorpusHash = effectiveProblemCorpusHash;
  const baseFidelityPath = `solution-fidelity/v1-0000-${effectiveProblemCorpusHash}-` +
    `${baseFidelity.inputHash}.json`;
  const baseFidelityHash = writeEvidence(join(stateDir, baseFidelityPath), baseFidelity);
  const baseFidelityPointer = { path: baseFidelityPath, sha256: baseFidelityHash };
  repair.effectiveProblemCorpusHash = effectiveProblemCorpusHash;
  repair.baseFidelityCheckpoint = baseFidelityPointer;
  repair.item.explanation += ` [${label}]`;
  const itemHash = canonicalEvidenceHash(repair.item);
  const repairPath = `solution-repairs/v1-${String(repair.basePage).padStart(4, "0")}-` +
    `${String(repair.printedNumber).padStart(4, "0")}-${baseFidelityHash}.json`;
  const repairHash = writeEvidence(join(stateDir, repairPath), repair);
  const repairPointer = { path: repairPath, sha256: repairHash };
  sourceFidelity.effectiveProblemCorpusHash = effectiveProblemCorpusHash;
  sourceFidelity.baseFidelityCheckpoint = baseFidelityPointer;
  sourceFidelity.repairArtifact = repairPointer;
  sourceFidelity.effectiveSolutionItemHash = itemHash;
  sourceFidelity.input.explanation = repair.item.explanation;
  sourceFidelity.inputHash = canonicalEvidenceHash(sourceFidelity.input);
  const fidelityPath = `solution-fidelity-repairs/v1-${String(repair.basePage).padStart(4, "0")}-` +
    `${String(repair.printedNumber).padStart(4, "0")}-${baseFidelityHash}-${itemHash}.json`;
  writeEvidence(join(stateDir, fidelityPath), sourceFidelity);
  return {
    repairArtifact: join(stateDir, repairPath),
    fidelityArtifact: join(stateDir, fidelityPath),
  };
}

function installCurrentQ1SemanticSibling(files: ReturnType<typeof fixture>): void {
  const stateDir = files.stateDirs.math;
  const entry = JSON.parse(readFileSync(join(stateDir, "entry.json"), "utf8")).entry;
  const downloads = JSON.parse(readFileSync(join(stateDir, "downloads.json"), "utf8"));
  const attestationName = readdirSync(join(stateDir, "answer-attestation"))
    .find((name) => /^v5-/u.test(name))!;
  const attestation = JSON.parse(
    readFileSync(join(stateDir, "answer-attestation", attestationName), "utf8"),
  );
  const audit = JSON.parse(readFileSync(join(stateDir, attestation.answerAudit.path), "utf8"));
  const baseFidelityEvidence = audit.solutionFidelityCheckpoints[0];
  const baseFidelity = JSON.parse(
    readFileSync(join(stateDir, baseFidelityEvidence.path), "utf8"),
  );
  const baseInput = baseFidelity.inputs.find((input: { key: string }) => input.key === "1:1");
  const problemCheckpoint = JSON.parse(
    readFileSync(join(stateDir, "problem-chunks", "v2-0000.json"), "utf8"),
  );
  const problem = problemCheckpoint.items[0];
  const firstSolution = {
    number: "1",
    answer: "②",
    explanation: "$1/81$이므로 선택지를 확정할 수 없다.",
    page: 2,
    complete: true,
  };
  const firstItemHash = canonicalEvidenceHash(firstSolution);
  const repairPath = `solution-repairs/v1-${String(baseInput.sourcePage).padStart(4, "0")}-` +
    `0001-${baseFidelityEvidence.sha256}.json`;
  const repairCheckpoint = {
    version: 1,
    entryId: entry.id,
    key: "1:1",
    printedNumber: "1",
    basePage: baseInput.sourcePage,
    contextFrom: baseInput.baseContextFrom,
    contextTo: baseInput.baseContextTo,
    baseOwnedFrom: baseInput.baseOwnedFrom,
    baseOwnedTo: baseInput.baseOwnedTo,
    sourceHash: downloads.solution.sha256,
    effectiveProblemCorpusHash: audit.effectiveCorpusHash,
    baseSolutionCheckpoint: baseInput.baseSolutionCheckpoint,
    baseFidelityCheckpoint: {
      path: baseFidelityEvidence.path,
      sha256: baseFidelityEvidence.sha256,
    },
    baseSolutionItemHash: baseInput.baseSolutionItemHash,
    baseRawAnswerHash: hash(baseInput.rawAnswer),
    baseExplanationHash: hash(baseInput.explanation),
    promptVersion: TARGETED_SOLUTION_TRANSCRIPTION_VERSION,
    promptDigest: TARGETED_SOLUTION_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    effectivePage: firstSolution.page,
    item: firstSolution,
  };
  const repairHash = writeEvidence(join(stateDir, repairPath), repairCheckpoint);
  const repairPointer = { path: repairPath, sha256: repairHash };
  const firstInput = {
    ...baseInput,
    sourcePage: firstSolution.page,
    rawAnswer: firstSolution.answer,
    explanation: firstSolution.explanation,
  };
  const firstDecision = {
    key: "1:1",
    sourcePage: firstSolution.page,
    answerStatus: "exact",
    explanationStatus: "exact",
    evidence: "first repaired answer and explanation exactly match the bounded pixels",
  };
  const firstFidelityPath = `solution-fidelity-repairs/v1-` +
    `${String(baseInput.sourcePage).padStart(4, "0")}-0001-` +
    `${baseFidelityEvidence.sha256}-${firstItemHash}.json`;
  const firstFidelityCheckpoint = {
    version: 1,
    entryId: entry.id,
    key: "1:1",
    sourceHash: downloads.solution.sha256,
    from: baseInput.baseContextFrom,
    to: baseInput.baseContextTo,
    basePage: baseInput.sourcePage,
    effectivePage: firstSolution.page,
    baseOwnedFrom: baseInput.baseOwnedFrom,
    baseOwnedTo: baseInput.baseOwnedTo,
    effectiveProblemCorpusHash: audit.effectiveCorpusHash,
    baseSolutionCheckpoint: baseInput.baseSolutionCheckpoint,
    baseFidelityCheckpoint: {
      path: baseFidelityEvidence.path,
      sha256: baseFidelityEvidence.sha256,
    },
    repairArtifact: repairPointer,
    effectiveSolutionItemHash: firstItemHash,
    inputHash: canonicalEvidenceHash(firstInput),
    promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    input: firstInput,
    item: firstDecision,
  };
  const firstFidelityHash = writeEvidence(join(stateDir, firstFidelityPath), firstFidelityCheckpoint);
  const firstFidelityPointer = { path: firstFidelityPath, sha256: firstFidelityHash };

  const persistedRepair = audit.solutionRepairs.find((repair: { key: string }) => repair.key === "1:28");
  const persistedFinal = JSON.parse(
    readFileSync(join(stateDir, persistedRepair.revision.solutionArtifact.path), "utf8"),
  ).item;
  const preliminarySolutionHash = canonicalEvidenceHash([{
    key: "1:1",
    solution: firstSolution,
  }, {
    key: "1:28",
    solution: persistedFinal,
  }].sort((left, right) => compareCorpusQuestionKeys(left.key, right.key)));
  const preliminaryInputs = [{
    key: "1:1",
    choices: problem.choices,
    detailedExplanation: redactedExplanation(firstSolution.explanation),
  }];
  const preliminaryInputHash = canonicalEvidenceHash(preliminaryInputs);
  const preliminarySemanticPath = `semantic-choice-checks/v5-${audit.effectiveCorpusHash}-` +
    `${preliminarySolutionHash}-${preliminaryInputHash}.json`;
  const preliminaryDecision = {
    key: "1:1",
    status: "ambiguous",
    choiceIndex: null,
    evidence: "the repaired explanation does not identify one listed value",
  };
  const preliminarySemanticCheckpoint = {
    version: 5,
    entryId: entry.id,
    problemHash: downloads.problem.sha256,
    solutionHash: downloads.solution.sha256,
    classifierVersion: 5,
    rulesDigest: DIGEST,
    transcriptionGateVersion: 2,
    transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
    effectiveCorpusHash: audit.effectiveCorpusHash,
    effectiveSolutionCorpusHash: preliminarySolutionHash,
    inputHash: preliminaryInputHash,
    promptDigest: V5_SEMANTIC_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    inputs: preliminaryInputs,
    items: [preliminaryDecision],
  };
  const preliminarySemanticHash = writeEvidence(
    join(stateDir, preliminarySemanticPath),
    preliminarySemanticCheckpoint,
  );
  const preliminarySemanticPointer = {
    path: preliminarySemanticPath,
    sha256: preliminarySemanticHash,
    inputHash: preliminaryInputHash,
    effectiveCorpusHash: audit.effectiveCorpusHash,
    effectiveSolutionCorpusHash: preliminarySolutionHash,
  };
  const trigger = {
    kind: "semantic",
    fidelityDecisionHash: canonicalEvidenceHash(firstDecision),
    semanticCheckpoint: preliminarySemanticPointer,
    semanticDecisionHash: canonicalEvidenceHash(preliminaryDecision),
  };
  const firstFidelityEnvelope = {
    ...firstFidelityPointer,
    promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
  };
  const revisionBasisHash = canonicalEvidenceHash({
    key: "1:1",
    sourceHash: downloads.solution.sha256,
    basePage: baseInput.sourcePage,
    contextFrom: baseInput.baseContextFrom,
    contextTo: baseInput.baseContextTo,
    baseSolutionCheckpoint: baseInput.baseSolutionCheckpoint,
    baseSolutionItemHash: baseInput.baseSolutionItemHash,
    baseRepairArtifact: repairPointer,
    baseRepairFidelityArtifact: firstFidelityEnvelope,
    baseRepairSolutionItemHash: firstItemHash,
    trigger,
    revisionPromptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
  });
  const revisionPath = `solution-revisions/v1-${String(firstSolution.page).padStart(4, "0")}-` +
    `0001-${revisionBasisHash}.json`;
  const finalSolution = {
    number: "1",
    answer: "②",
    explanation: "공식 계산 결과가 두 번째 선택지와 일치하므로 답은 ②이다.",
    page: 2,
    complete: true,
  };
  const finalItemHash = canonicalEvidenceHash(finalSolution);
  const revisionCheckpoint = {
    version: 1,
    entryId: entry.id,
    key: "1:1",
    printedNumber: "1",
    sourceHash: downloads.solution.sha256,
    basePage: baseInput.sourcePage,
    contextFrom: baseInput.baseContextFrom,
    contextTo: baseInput.baseContextTo,
    baseOwnedFrom: baseInput.baseOwnedFrom,
    baseOwnedTo: baseInput.baseOwnedTo,
    effectiveProblemCorpusHash: audit.effectiveCorpusHash,
    baseSolutionCheckpoint: baseInput.baseSolutionCheckpoint,
    baseSolutionItemHash: baseInput.baseSolutionItemHash,
    baseRepairArtifact: repairPointer,
    baseRepairFidelityArtifact: firstFidelityEnvelope,
    baseRepairPage: firstSolution.page,
    baseRepairSolutionItemHash: firstItemHash,
    trigger,
    diagnosticDecision: firstDecision,
    diagnosticDecisionHash: trigger.fidelityDecisionHash,
    semanticDecision: preliminaryDecision,
    promptVersion: TARGETED_SOLUTION_REVISION_VERSION,
    promptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    effectivePage: finalSolution.page,
    item: finalSolution,
  };
  const revisionHash = writeEvidence(join(stateDir, revisionPath), revisionCheckpoint);
  const revisionPointer = { path: revisionPath, sha256: revisionHash };
  const finalInput = {
    ...baseInput,
    sourcePage: finalSolution.page,
    rawAnswer: finalSolution.answer,
    explanation: finalSolution.explanation,
  };
  const finalFidelityPath = `solution-fidelity-revisions/v1-` +
    `${String(firstSolution.page).padStart(4, "0")}-0001-${revisionHash}-${finalItemHash}.json`;
  const finalDecision = {
    key: "1:1",
    sourcePage: finalSolution.page,
    answerStatus: "exact",
    explanationStatus: "exact",
    evidence: "the revised marker and complete explanation exactly match official pixels",
  };
  const finalFidelityCheckpoint = {
    version: 1,
    entryId: entry.id,
    key: "1:1",
    sourceHash: downloads.solution.sha256,
    from: baseInput.baseContextFrom,
    to: baseInput.baseContextTo,
    basePage: baseInput.sourcePage,
    baseRepairPage: firstSolution.page,
    effectivePage: finalSolution.page,
    baseOwnedFrom: baseInput.baseOwnedFrom,
    baseOwnedTo: baseInput.baseOwnedTo,
    effectiveProblemCorpusHash: audit.effectiveCorpusHash,
    baseSolutionCheckpoint: baseInput.baseSolutionCheckpoint,
    baseSolutionItemHash: baseInput.baseSolutionItemHash,
    baseRepairArtifact: repairPointer,
    baseRepairFidelityArtifact: firstFidelityEnvelope,
    baseRepairSolutionItemHash: firstItemHash,
    diagnosticDecisionHash: trigger.fidelityDecisionHash,
    trigger,
    revisionArtifact: revisionPointer,
    effectiveSolutionItemHash: finalItemHash,
    inputHash: canonicalEvidenceHash(finalInput),
    promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    input: finalInput,
    item: finalDecision,
  };
  const finalFidelityHash = writeEvidence(join(stateDir, finalFidelityPath), finalFidelityCheckpoint);
  const finalFidelityPointer = { path: finalFidelityPath, sha256: finalFidelityHash };
  const solutionRepair = {
    key: "1:1",
    printedNumber: "1",
    basePage: baseInput.sourcePage,
    effectivePage: firstSolution.page,
    contextFrom: baseInput.baseContextFrom,
    contextTo: baseInput.baseContextTo,
    baseOwnedFrom: baseInput.baseOwnedFrom,
    baseOwnedTo: baseInput.baseOwnedTo,
    baseSolutionCheckpoint: baseInput.baseSolutionCheckpoint,
    baseFidelityCheckpoint: {
      path: baseFidelityEvidence.path,
      sha256: baseFidelityEvidence.sha256,
    },
    repairArtifact: repairPointer,
    fidelityArtifact: firstFidelityEnvelope,
    baseSolutionItemHash: baseInput.baseSolutionItemHash,
    effectiveSolutionItemHash: firstItemHash,
    baseRawAnswerHash: hash(baseInput.rawAnswer),
    effectiveRawAnswerHash: hash(firstSolution.answer),
    baseExplanationHash: hash(baseInput.explanation),
    effectiveExplanationHash: hash(firstSolution.explanation),
    revision: {
      trigger,
      baseRepairPage: firstSolution.page,
      effectivePage: finalSolution.page,
      baseRepairArtifact: repairPointer,
      baseRepairFidelityArtifact: firstFidelityEnvelope,
      solutionArtifact: {
        ...revisionPointer,
        revisionPromptVersion: TARGETED_SOLUTION_REVISION_VERSION,
        revisionPromptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
      },
      fidelityArtifact: {
        ...finalFidelityPointer,
        promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
      },
      diagnosticDecisionHash: trigger.fidelityDecisionHash,
      baseSolutionItemHash: baseInput.baseSolutionItemHash,
      baseRepairSolutionItemHash: firstItemHash,
      effectiveSolutionItemHash: finalItemHash,
      baseRepairRawAnswerHash: hash(firstSolution.answer),
      effectiveRawAnswerHash: hash(finalSolution.answer),
      baseRepairExplanationHash: hash(firstSolution.explanation),
      effectiveExplanationHash: hash(finalSolution.explanation),
    },
  };
  audit.solutionRepairs.push(solutionRepair);
  audit.solutionRepairs.sort((left: { key: string }, right: { key: string }) =>
    compareCorpusQuestionKeys(left.key, right.key));
  audit.solutionRepairKeys = audit.solutionRepairs.map((repair: { key: string }) => repair.key);
  const q1Terminal = audit.solutionFidelityItems.find((item: { key: string }) => item.key === "1:1");
  Object.assign(q1Terminal, {
    effectivePage: finalSolution.page,
    answerStatus: finalDecision.answerStatus,
    explanationStatus: finalDecision.explanationStatus,
    evidence: finalDecision.evidence,
    fidelityArtifact: {
      ...finalFidelityPointer,
      promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    },
    effectiveSolutionItemHash: finalItemHash,
    effectiveRawAnswerHash: hash(finalSolution.answer),
    effectiveExplanationHash: hash(finalSolution.explanation),
  });
  const finalSolutionHash = canonicalEvidenceHash([{
    key: "1:1",
    solution: finalSolution,
  }, {
    key: "1:28",
    solution: persistedFinal,
  }].sort((left, right) => compareCorpusQuestionKeys(left.key, right.key)));
  audit.effectiveSolutionCorpusHash = finalSolutionHash;
  const finalSemanticInputs = [{
    key: "1:1",
    choices: problem.choices,
    detailedExplanation: redactedExplanation(finalSolution.explanation),
  }];
  const finalSemanticInputHash = canonicalEvidenceHash(finalSemanticInputs);
  const finalSemanticPath = `semantic-choice-checks/v5-${audit.effectiveCorpusHash}-` +
    `${finalSolutionHash}-${finalSemanticInputHash}.json`;
  const finalSemanticDecision = {
    key: "1:1",
    status: "resolved",
    choiceIndex: 2,
    evidence: "the official explanation resolves the second choice",
  };
  const finalSemanticCheckpoint = {
    ...preliminarySemanticCheckpoint,
    effectiveSolutionCorpusHash: finalSolutionHash,
    inputHash: finalSemanticInputHash,
    inputs: finalSemanticInputs,
    items: [finalSemanticDecision],
  };
  const finalSemanticHash = writeEvidence(join(stateDir, finalSemanticPath), finalSemanticCheckpoint);
  audit.semanticCheckpoint = {
    path: finalSemanticPath,
    sha256: finalSemanticHash,
    inputHash: finalSemanticInputHash,
    effectiveCorpusHash: audit.effectiveCorpusHash,
    effectiveSolutionCorpusHash: finalSolutionHash,
  };
  const auditItem = audit.items.find((item: { key: string }) => item.key === "1:1");
  Object.assign(auditItem, {
    officialRawAnswerHash: hash(finalSolution.answer),
    storedAnswerHash: hash("②"),
    mode: "choice-marker",
    choiceIndex: 2,
    semantic: {
      status: finalSemanticDecision.status,
      choiceIndex: finalSemanticDecision.choiceIndex,
      evidence: finalSemanticDecision.evidence,
    },
  });
  const db = new Database(files.dbPath);
  db.prepare(`
    UPDATE questions SET answer = '②', explanation = ?
    WHERE printed_number = '1' AND book_id = (
      SELECT books.id FROM books JOIN subjects ON subjects.id = books.subject_id
      WHERE subjects.name = '수학 - 수학Ⅱ·미적분Ⅰ'
    )
  `)
    .run(finalSolution.explanation);
  db.prepare(`
    UPDATE book_items SET answer = '②', content = ?, page = 2
    WHERE category = '해설' AND number = '1' AND book_id = (
      SELECT books.id FROM books JOIN subjects ON subjects.id = books.subject_id
      WHERE subjects.name = '수학 - 수학Ⅱ·미적분Ⅰ'
    )
  `)
    .run(finalSolution.explanation);
  db.prepare(`
    UPDATE book_items SET answer = '②'
    WHERE category = '문제' AND number = '1' AND book_id = (
      SELECT books.id FROM books JOIN subjects ON subjects.id = books.subject_id
      WHERE subjects.name = '수학 - 수학Ⅱ·미적분Ⅰ'
    )
  `).run();
  db.close();
  rewriteSolutionAuditAuthority(files, (currentAudit) => Object.assign(currentAudit, audit));
}

function makeQ27HistoricalAuthorityDormant(files: ReturnType<typeof fixture>): void {
  installQ27SolutionRepair(files, 27);
  const stateDir = files.stateDirs.math;
  const attestationName = readdirSync(join(stateDir, "answer-attestation"))
    .find((name) => /^v2-/u.test(name))!;
  const attestation = JSON.parse(
    readFileSync(join(stateDir, "answer-attestation", attestationName), "utf8"),
  );
  const audit = JSON.parse(readFileSync(join(stateDir, attestation.answerAudit.path), "utf8"));
  const problemCheckpoint = JSON.parse(
    readFileSync(join(stateDir, "problem-chunks", "v2-0000.json"), "utf8"),
  );
  const classificationPath = join(stateDir, "classification-chunks", `v4-0000-${DIGEST}.json`);
  const classificationCheckpoint = JSON.parse(readFileSync(classificationPath, "utf8"));
  Object.assign(classificationCheckpoint.items[26], {
    decision: "reject",
    canonical_subject: null,
    curriculum_course: null,
    domain: null,
    achievement_codes: [],
    reason_codes: ["OUT_OF_SCOPE"],
  });
  writeJson(classificationPath, classificationCheckpoint);
  const effectiveCorpusHash = canonicalEvidenceHash(problemCheckpoint.items.map(
    (question: Record<string, unknown>, index: number) => ({
      question,
      classification: classificationCheckpoint.items[index],
    }),
  ));
  const historicalBase = JSON.parse(
    readFileSync(join(stateDir, audit.solutionFidelityCheckpoints[0].path), "utf8"),
  );
  const inputs = historicalBase.inputs.filter((input: { key: string }) => input.key === "1:1");
  const items = historicalBase.items.filter((item: { key: string }) => item.key === "1:1");
  const inputHash = canonicalEvidenceHash(inputs);
  const currentBase = {
    ...historicalBase,
    effectiveProblemCorpusHash: effectiveCorpusHash,
    inputHash,
    inputs,
    items,
  };
  const basePath = `solution-fidelity/v1-0000-${effectiveCorpusHash}-${inputHash}.json`;
  const baseHash = writeEvidence(join(stateDir, basePath), currentBase);
  const basePointer = { path: basePath, sha256: baseHash };
  audit.effectiveCorpusHash = effectiveCorpusHash;
  audit.acceptedQuestionCount = 1;
  audit.rejectedQuestionCount = 29;
  audit.targetQuestionCounts = { "수학 - 수학Ⅱ·미적분Ⅰ": 1 };
  audit.acceptedSolutionKeys = ["1:1"];
  audit.solutionRepairKeys = [];
  audit.acceptedMcqKeys = ["1:1"];
  audit.solutionFidelityCheckpoints = [{
    ...basePointer,
    from: currentBase.from,
    to: currentBase.to,
    ownedFrom: currentBase.ownedFrom,
    ownedTo: currentBase.ownedTo,
    inputHash,
  }];
  const q1Terminal = audit.solutionFidelityItems.find((item: { key: string }) => item.key === "1:1");
  q1Terminal.fidelityArtifact = basePointer;
  audit.solutionFidelityItems = [q1Terminal];
  audit.solutionRepairs = [];
  const solutionCheckpoint = JSON.parse(
    readFileSync(join(stateDir, "solution-chunks", "v3-0000.json"), "utf8"),
  );
  const q1Solution = solutionCheckpoint.items.find((item: { number: string }) => item.number === "1");
  audit.effectiveSolutionCorpusHash = canonicalEvidenceHash([{ key: "1:1", solution: q1Solution }]);
  audit.items = audit.items.filter((item: { key: string }) => item.key === "1:1");

  const receiptPath = join(stateDir, "receipt.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  receipt.acceptedQuestionCount = 1;
  receipt.rejectedQuestionCount = 29;
  receipt.targetBooks = receipt.targetBooks.filter(
    (target: { subject: string }) => target.subject === "수학 - 수학Ⅱ·미적분Ⅰ",
  );
  writeJson(receiptPath, receipt);
  const db = new Database(files.dbPath);
  const dormantBook = db.prepare(`
    SELECT books.id
    FROM books JOIN subjects ON subjects.id = books.subject_id
    WHERE subjects.name = '수학 - 수학Ⅰ·대수'
  `).get() as { id: number } | undefined;
  if (dormantBook) {
    db.prepare("DELETE FROM book_items WHERE book_id = ?").run(dormantBook.id);
    db.prepare("DELETE FROM questions WHERE book_id = ?").run(dormantBook.id);
    db.prepare("DELETE FROM book_files WHERE book_id = ?").run(dormantBook.id);
    db.prepare("DELETE FROM books WHERE id = ?").run(dormantBook.id);
  }
  db.close();
  rewriteSolutionAuditAuthority(files, (currentAudit) => Object.assign(currentAudit, audit));
}

function installQ1SemanticSolutionRevision(files: ReturnType<typeof fixture>): {
  preliminarySemanticArtifact: string;
  finalSemanticArtifact: string;
  revisionArtifact: string;
} {
  installQ27SolutionRepair(files, 1, true);
  const stateDir = files.stateDirs.math;
  const entry = JSON.parse(readFileSync(join(stateDir, "entry.json"), "utf8")).entry;
  const downloads = JSON.parse(readFileSync(join(stateDir, "downloads.json"), "utf8"));
  const attestationDir = join(stateDir, "answer-attestation");
  const attestationName = readdirSync(attestationDir).find((name) => /^v2-/u.test(name))!;
  const attestation = JSON.parse(readFileSync(join(attestationDir, attestationName), "utf8"));
  const audit = JSON.parse(readFileSync(join(stateDir, attestation.answerAudit.path), "utf8"));
  const repair = audit.solutionRepairs[0];
  const firstSolution = JSON.parse(
    readFileSync(join(stateDir, repair.repairArtifact.path), "utf8"),
  ).item;
  const firstFidelityCheckpoint = JSON.parse(
    readFileSync(join(stateDir, repair.fidelityArtifact.path), "utf8"),
  );
  const firstDecision = firstFidelityCheckpoint.item;
  const problemCheckpoint = JSON.parse(
    readFileSync(join(stateDir, "problem-chunks", "v2-0000.json"), "utf8"),
  );
  const targetProblem = problemCheckpoint.items[0];
  const preliminaryInputs = [{
    key: "1:1",
    choices: targetProblem.choices,
    detailedExplanation: redactedExplanation(firstSolution.explanation),
  }];
  const preliminaryInputHash = canonicalEvidenceHash(preliminaryInputs);
  const preliminarySemanticRelativePath = `semantic-choice-checks/v3-${preliminaryInputHash}.json`;
  const preliminaryDecision = {
    key: "1:1",
    status: "ambiguous",
    choiceIndex: null,
    evidence: "계산값 1/81은 어떤 보기에도 대응하지 않는다",
  };
  const preliminarySemanticCheckpoint = {
    version: 3,
    entryId: entry.id,
    problemHash: downloads.problem.sha256,
    solutionHash: downloads.solution.sha256,
    classifierVersion: 4,
    rulesDigest: DIGEST,
    transcriptionGateVersion: 1,
    transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
    effectiveCorpusHash: audit.effectiveCorpusHash,
    effectiveSolutionCorpusHash: audit.effectiveSolutionCorpusHash,
    inputHash: preliminaryInputHash,
    promptDigest: SEMANTIC_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    inputs: preliminaryInputs,
    items: [preliminaryDecision],
  };
  const preliminarySemanticHash = writeEvidence(
    join(stateDir, preliminarySemanticRelativePath),
    preliminarySemanticCheckpoint,
  );
  const preliminarySemanticPointer = {
    path: preliminarySemanticRelativePath,
    sha256: preliminarySemanticHash,
    inputHash: preliminaryInputHash,
    effectiveCorpusHash: audit.effectiveCorpusHash,
    effectiveSolutionCorpusHash: audit.effectiveSolutionCorpusHash,
  };
  const trigger = {
    kind: "semantic",
    fidelityDecisionHash: canonicalEvidenceHash(firstDecision),
    semanticCheckpoint: preliminarySemanticPointer,
    semanticDecisionHash: canonicalEvidenceHash(preliminaryDecision),
  };
  const revisionBasisHash = canonicalEvidenceHash({
    key: "1:1",
    sourceHash: downloads.solution.sha256,
    basePage: repair.basePage,
    contextFrom: repair.contextFrom,
    contextTo: repair.contextTo,
    baseSolutionCheckpoint: repair.baseSolutionCheckpoint,
    baseSolutionItemHash: repair.baseSolutionItemHash,
    baseRepairArtifact: repair.repairArtifact,
    baseRepairFidelityArtifact: repair.fidelityArtifact,
    baseRepairSolutionItemHash: repair.effectiveSolutionItemHash,
    trigger,
    revisionPromptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
  });
  const revisionRelativePath = `solution-revisions/v1-${String(firstSolution.page).padStart(4, "0")}-` +
    `0001-${revisionBasisHash}.json`;
  const finalSolution = {
    number: "1",
    answer: "②",
    explanation: "$3^{(\\frac{1}{2})\\times2}=3$이므로 값은 3이다.",
    page: 2,
    complete: true,
  };
  const revisionCheckpoint = {
    version: 1,
    entryId: entry.id,
    key: "1:1",
    printedNumber: "1",
    sourceHash: downloads.solution.sha256,
    basePage: repair.basePage,
    contextFrom: repair.contextFrom,
    contextTo: repair.contextTo,
    baseOwnedFrom: repair.baseOwnedFrom,
    baseOwnedTo: repair.baseOwnedTo,
    effectiveProblemCorpusHash: audit.effectiveCorpusHash,
    baseSolutionCheckpoint: repair.baseSolutionCheckpoint,
    baseSolutionItemHash: repair.baseSolutionItemHash,
    baseRepairArtifact: repair.repairArtifact,
    baseRepairFidelityArtifact: repair.fidelityArtifact,
    baseRepairPage: firstSolution.page,
    baseRepairSolutionItemHash: repair.effectiveSolutionItemHash,
    trigger,
    diagnosticDecision: firstDecision,
    diagnosticDecisionHash: trigger.fidelityDecisionHash,
    semanticDecision: preliminaryDecision,
    promptVersion: TARGETED_SOLUTION_REVISION_VERSION,
    promptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    effectivePage: finalSolution.page,
    item: finalSolution,
  };
  const revisionHash = writeEvidence(join(stateDir, revisionRelativePath), revisionCheckpoint);
  const revisionPointer = { path: revisionRelativePath, sha256: revisionHash };
  const finalSolutionItemHash = canonicalEvidenceHash(finalSolution);
  const finalInput = {
    ...firstFidelityCheckpoint.input,
    sourcePage: finalSolution.page,
    rawAnswer: finalSolution.answer,
    explanation: finalSolution.explanation,
  };
  const revisionFidelityRelativePath = `solution-fidelity-revisions/v1-` +
    `${String(firstSolution.page).padStart(4, "0")}-0001-${revisionHash}-${finalSolutionItemHash}.json`;
  const finalDecision = {
    key: "1:1",
    sourcePage: finalSolution.page,
    answerStatus: "not_visible",
    explanationStatus: "exact",
    evidence: "공식 식과 값 3은 일치하고 marker는 이 범위에 직접 보이지 않는다",
  };
  const revisionFidelityCheckpoint = {
    version: 1,
    entryId: entry.id,
    key: "1:1",
    sourceHash: downloads.solution.sha256,
    from: repair.contextFrom,
    to: repair.contextTo,
    basePage: repair.basePage,
    baseRepairPage: firstSolution.page,
    effectivePage: finalSolution.page,
    baseOwnedFrom: repair.baseOwnedFrom,
    baseOwnedTo: repair.baseOwnedTo,
    effectiveProblemCorpusHash: audit.effectiveCorpusHash,
    baseSolutionCheckpoint: repair.baseSolutionCheckpoint,
    baseSolutionItemHash: repair.baseSolutionItemHash,
    baseRepairArtifact: repair.repairArtifact,
    baseRepairFidelityArtifact: repair.fidelityArtifact,
    baseRepairSolutionItemHash: repair.effectiveSolutionItemHash,
    diagnosticDecisionHash: trigger.fidelityDecisionHash,
    trigger,
    revisionArtifact: revisionPointer,
    effectiveSolutionItemHash: finalSolutionItemHash,
    inputHash: canonicalEvidenceHash(finalInput),
    promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    input: finalInput,
    item: finalDecision,
  };
  const revisionFidelityHash = writeEvidence(
    join(stateDir, revisionFidelityRelativePath),
    revisionFidelityCheckpoint,
  );
  const revisionFidelityPointer = {
    path: revisionFidelityRelativePath,
    sha256: revisionFidelityHash,
  };
  repair.revision = {
    trigger,
    baseRepairPage: firstSolution.page,
    effectivePage: finalSolution.page,
    baseRepairArtifact: repair.repairArtifact,
    baseRepairFidelityArtifact: repair.fidelityArtifact,
    solutionArtifact: {
      ...revisionPointer,
      revisionPromptVersion: TARGETED_SOLUTION_REVISION_VERSION,
      revisionPromptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
    },
    fidelityArtifact: {
      ...revisionFidelityPointer,
      promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    },
    diagnosticDecisionHash: trigger.fidelityDecisionHash,
    baseSolutionItemHash: repair.baseSolutionItemHash,
    baseRepairSolutionItemHash: repair.effectiveSolutionItemHash,
    effectiveSolutionItemHash: finalSolutionItemHash,
    baseRepairRawAnswerHash: hash(firstSolution.answer),
    effectiveRawAnswerHash: hash(finalSolution.answer),
    baseRepairExplanationHash: hash(firstSolution.explanation),
    effectiveExplanationHash: hash(finalSolution.explanation),
  };
  const terminalItem = audit.solutionFidelityItems.find((item: { key: string }) => item.key === "1:1");
  Object.assign(terminalItem, {
    effectivePage: finalSolution.page,
    answerStatus: finalDecision.answerStatus,
    explanationStatus: finalDecision.explanationStatus,
    evidence: finalDecision.evidence,
    fidelityArtifact: revisionFidelityPointer,
    effectiveSolutionItemHash: finalSolutionItemHash,
    effectiveRawAnswerHash: hash(finalSolution.answer),
    effectiveExplanationHash: hash(finalSolution.explanation),
  });
  const solutionCheckpoint = JSON.parse(
    readFileSync(join(stateDir, "solution-chunks", "v3-0000.json"), "utf8"),
  );
  const companionSolution = solutionCheckpoint.items.find((item: { number: string }) => item.number === "2");
  audit.effectiveSolutionCorpusHash = canonicalEvidenceHash([{
    key: "1:1",
    solution: finalSolution,
  }, {
    key: "1:2",
    solution: companionSolution,
  }]);
  const finalInputs = [{
    key: "1:1",
    choices: targetProblem.choices,
    detailedExplanation: redactedExplanation(finalSolution.explanation),
  }];
  const finalInputHash = canonicalEvidenceHash(finalInputs);
  const finalSemanticRelativePath = `semantic-choice-checks/v3-${audit.effectiveCorpusHash}-` +
    `${audit.effectiveSolutionCorpusHash}-${finalInputHash}.json`;
  const finalSemanticDecision = {
    key: "1:1",
    status: "resolved",
    choiceIndex: 2,
    evidence: "계산값 3은 ②이다",
  };
  const finalSemanticCheckpoint = {
    version: 3,
    entryId: entry.id,
    problemHash: downloads.problem.sha256,
    solutionHash: downloads.solution.sha256,
    classifierVersion: 4,
    rulesDigest: DIGEST,
    transcriptionGateVersion: 1,
    transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
    effectiveCorpusHash: audit.effectiveCorpusHash,
    effectiveSolutionCorpusHash: audit.effectiveSolutionCorpusHash,
    inputHash: finalInputHash,
    promptDigest: SEMANTIC_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    inputs: finalInputs,
    items: [finalSemanticDecision],
  };
  const finalSemanticHash = writeEvidence(
    join(stateDir, finalSemanticRelativePath),
    finalSemanticCheckpoint,
  );
  audit.semanticCheckpoint = {
    path: finalSemanticRelativePath,
    sha256: finalSemanticHash,
    inputHash: finalInputHash,
    effectiveSolutionCorpusHash: audit.effectiveSolutionCorpusHash,
  };
  audit.derivedAnswerKeys = ["1:1"];
  const targetAuditItem = audit.items.find((item: { key: string }) => item.key === "1:1");
  targetAuditItem.officialRawAnswerHash = hash(finalSolution.answer);
  targetAuditItem.storedAnswerHash = hash("②");
  targetAuditItem.mode = "choice-marker";
  targetAuditItem.choiceIndex = 2;
  targetAuditItem.semantic = {
    status: finalSemanticDecision.status,
    choiceIndex: finalSemanticDecision.choiceIndex,
    evidence: finalSemanticDecision.evidence,
  };

  const { version: _auditVersion, auditDigest: _oldAuditDigest, ...auditBasis } = audit;
  const auditDigest = canonicalEvidenceHash(auditBasis);
  const auditRelativePath = `answer-audit/v2-${auditDigest}.json`;
  for (const name of readdirSync(join(stateDir, "answer-audit"))) rmSync(join(stateDir, "answer-audit", name));
  const auditHash = writeEvidence(join(stateDir, auditRelativePath), {
    version: 2,
    auditDigest,
    ...auditBasis,
  });
  const { version: _attestationVersion, attestationDigest: _oldAttestationDigest, ...attestationBasis } = attestation;
  attestationBasis.answerAudit = {
    path: auditRelativePath,
    sha256: auditHash,
    effectiveCorpusHash: audit.effectiveCorpusHash,
    effectiveSolutionCorpusHash: audit.effectiveSolutionCorpusHash,
  };
  attestationBasis.solutionFidelityItems = audit.solutionFidelityItems;
  attestationBasis.solutionRepairs = audit.solutionRepairs;
  const attestationDigest = canonicalEvidenceHash(attestationBasis);
  for (const name of readdirSync(attestationDir)) rmSync(join(attestationDir, name));
  writeEvidence(join(attestationDir, `v2-${attestationDigest}.json`), {
    version: 2,
    attestationDigest,
    ...attestationBasis,
  });

  const db = new Database(files.dbPath);
  db.prepare("UPDATE questions SET answer = '②', explanation = ? WHERE printed_number = '1' AND question = ?")
    .run(finalSolution.explanation, targetProblem.question);
  db.prepare("UPDATE book_items SET answer = '②', content = ?, page = 2 WHERE category = '해설' AND number = '1' AND book_id = (SELECT id FROM books WHERE title LIKE '%수학 미적분')")
    .run(finalSolution.explanation);
  db.close();
  return {
    preliminarySemanticArtifact: join(stateDir, preliminarySemanticRelativePath),
    finalSemanticArtifact: join(stateDir, finalSemanticRelativePath),
    revisionArtifact: join(stateDir, revisionRelativePath),
  };
}

function rewriteSolutionAuditAuthority(
  files: ReturnType<typeof fixture>,
  mutateAudit: (audit: Record<string, any>) => void,
): void {
  const stateDir = files.stateDirs.math;
  const attestationDir = join(stateDir, "answer-attestation");
  const attestationName = readdirSync(attestationDir)
    .sort((left, right) => right.localeCompare(left, "en"))
    .find((name) => /^v[2-5]-/u.test(name))!;
  const attestation = JSON.parse(readFileSync(join(attestationDir, attestationName), "utf8"));
  const audit = JSON.parse(readFileSync(join(stateDir, attestation.answerAudit.path), "utf8"));
  const version = Number(attestation.version);
  mutateAudit(audit);
  const { version: _auditVersion, auditDigest: _oldAuditDigest, ...auditBasis } = audit;
  const auditDigest = canonicalEvidenceHash(auditBasis);
  const auditPath = `answer-audit/v${version}-${auditDigest}.json`;
  for (const name of readdirSync(join(stateDir, "answer-audit"))) rmSync(join(stateDir, "answer-audit", name));
  const auditHash = writeEvidence(join(stateDir, auditPath), { version, auditDigest, ...auditBasis });
  const { version: _attestationVersion, attestationDigest: _oldAttestationDigest, ...attestationBasis } = attestation;
  attestationBasis.receipt = {
    path: "receipt.json",
    sha256: canonicalEvidenceHash(JSON.parse(readFileSync(join(stateDir, "receipt.json"), "utf8"))),
  };
  attestationBasis.answerAudit = {
    path: auditPath,
    sha256: auditHash,
    effectiveCorpusHash: audit.effectiveCorpusHash,
    effectiveSolutionCorpusHash: audit.effectiveSolutionCorpusHash,
  };
  attestationBasis.solutionFidelityCheckpoints = audit.solutionFidelityCheckpoints;
  attestationBasis.solutionFidelityItems = audit.solutionFidelityItems;
  attestationBasis.solutionRepairs = audit.solutionRepairs;
  const attestationDigest = canonicalEvidenceHash(attestationBasis);
  for (const name of readdirSync(attestationDir)) rmSync(join(attestationDir, name));
  writeEvidence(join(attestationDir, `v${version}-${attestationDigest}.json`), {
    version,
    attestationDigest,
    ...attestationBasis,
  });
}

function installSolutionPromptUpgrade(files: ReturnType<typeof fixture>): {
  upgradeArtifact: string;
  upgradeFidelityArtifact: string;
  currentRevisionArtifact: string;
  legacyRevisionArtifact: string;
} {
  prepareSolutionPromptUpgradeFixture(files);
  const stateDir = files.stateDirs.math;
  upgradeEntryToV3(files, "math", {
    promptUpgrade: true,
    terminalScope: "authorized-reject",
    answerV5: true,
  });
  const copyAuthority = (relativePath: string): string => {
    const target = join(stateDir, relativePath);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, readFileSync(join(SOLUTION_PROMPT_UPGRADE_STATE, relativePath)));
    return target;
  };
  const legacyRevisionName = readdirSync(join(SOLUTION_PROMPT_UPGRADE_STATE, "solution-revisions"))
    .find((name) => hash(readFileSync(join(
      SOLUTION_PROMPT_UPGRADE_STATE,
      "solution-revisions",
      name,
    ))) === SOLUTION_PROMPT_UPGRADE_SPEC.legacyRevisionArtifactHash)!;
  const legacyRevisionPath = `solution-revisions/${legacyRevisionName}`;
  const legacyRevision = JSON.parse(readFileSync(
    join(SOLUTION_PROMPT_UPGRADE_STATE, legacyRevisionPath),
    "utf8",
  ));
  const legacyRepairPath = legacyRevision.baseRepairArtifact.path;
  const legacyRepair = JSON.parse(readFileSync(
    join(SOLUTION_PROMPT_UPGRADE_STATE, legacyRepairPath),
    "utf8",
  ));
  const legacyRepairFidelityPath = readdirSync(
    join(SOLUTION_PROMPT_UPGRADE_STATE, "solution-fidelity-repairs"),
  ).map((name) => `solution-fidelity-repairs/${name}`).find((relativePath) =>
    JSON.parse(readFileSync(join(SOLUTION_PROMPT_UPGRADE_STATE, relativePath), "utf8"))
      .repairArtifact.path === legacyRepairPath)!;
  const legacyRevisionFidelityPath = readdirSync(
    join(SOLUTION_PROMPT_UPGRADE_STATE, "solution-fidelity-revisions"),
  ).map((name) => `solution-fidelity-revisions/${name}`).find((relativePath) =>
    hash(readFileSync(join(SOLUTION_PROMPT_UPGRADE_STATE, relativePath))) ===
      SOLUTION_PROMPT_UPGRADE_SPEC.legacyRevisionFidelityArtifactHash)!;
  const legacyBaseFidelityPath = legacyRepair.baseFidelityCheckpoint.path;
  const legacySemanticPath = legacyRevision.trigger.semanticCheckpoint.path;
  for (const relativePath of [
    legacyBaseFidelityPath,
    legacyRepairPath,
    legacyRepairFidelityPath,
    legacyRevisionPath,
    legacyRevisionFidelityPath,
    legacySemanticPath,
  ]) copyAuthority(relativePath);

  const legacyBaseFidelity = JSON.parse(readFileSync(join(stateDir, legacyBaseFidelityPath), "utf8"));
  const legacyRepairFidelity = JSON.parse(readFileSync(join(stateDir, legacyRepairFidelityPath), "utf8"));
  const legacyRevisionFidelity = JSON.parse(readFileSync(join(stateDir, legacyRevisionFidelityPath), "utf8"));
  const legacyInput = legacyBaseFidelity.inputs.find((input: { key: string }) => input.key === "1:1");
  const legacyFirstDecision = legacyRepairFidelity.item;
  const legacyRepaired = legacyRepair.item;
  const legacyRepairedHash = canonicalEvidenceHash(legacyRepaired);
  const generationId = canonicalEvidenceHash({
    key: "1:1",
    effectiveProblemCorpusHash: legacyRepair.effectiveProblemCorpusHash,
    baseFidelityCheckpointSha256: legacyRepair.baseFidelityCheckpoint.sha256,
  });
  const predecessor = {
    allowlistId: SOLUTION_PROMPT_UPGRADE_SPEC.allowlistId,
    generationId,
    key: "1:1",
    effectiveProblemCorpusHash: legacyRepair.effectiveProblemCorpusHash,
    repairArtifact: { path: legacyRepairPath, sha256: hash(readFileSync(join(stateDir, legacyRepairPath))) },
    repairFidelityArtifact: {
      path: legacyRepairFidelityPath,
      sha256: hash(readFileSync(join(stateDir, legacyRepairFidelityPath))),
    },
    revisionArtifact: {
      path: legacyRevisionPath,
      sha256: SOLUTION_PROMPT_UPGRADE_SPEC.legacyRevisionArtifactHash,
      promptVersion: 1,
      promptDigest: LEGACY_TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
    },
    revisionFidelityArtifact: {
      path: legacyRevisionFidelityPath,
      sha256: SOLUTION_PROMPT_UPGRADE_SPEC.legacyRevisionFidelityArtifactHash,
    },
    revisionSolutionItemHash: canonicalEvidenceHash(legacyRevision.item),
    failedDecisionHash: canonicalEvidenceHash(legacyRevisionFidelity.item),
    failedEvidenceHash: hash(legacyRevisionFidelity.item.evidence),
    failedEvidence: legacyRevisionFidelity.item.evidence,
  };
  const upgradeTrigger = {
    kind: "prompt-upgrade",
    fidelityDecisionHash: canonicalEvidenceHash(legacyFirstDecision),
    promptUpgradeVersion: SOLUTION_PROMPT_UPGRADE_VERSION,
    legacyPredecessor: predecessor,
  };
  const finalSolution = {
    number: "1",
    answer: "②",
    explanation: "[출제의도] 지수 계산하기\n\n" +
      "\\(\\left(3^{\\frac{1}{2}}\\right)^2=3^{\\frac{1}{2}\\times 2}=3^1=3\\)이다.",
    page: 1,
    complete: true,
  };
  const baseRepairFidelityArtifact = {
    path: legacyRepairFidelityPath,
    sha256: predecessor.repairFidelityArtifact.sha256,
    promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
  };
  const upgradeBasisHash = canonicalEvidenceHash({
    key: "1:1",
    sourceHash: SOLUTION_PROMPT_UPGRADE_SPEC.sourceHash,
    basePage: legacyInput.sourcePage,
    contextFrom: legacyInput.baseContextFrom,
    contextTo: legacyInput.baseContextTo,
    baseSolutionCheckpoint: legacyInput.baseSolutionCheckpoint,
    baseSolutionItemHash: legacyInput.baseSolutionItemHash,
    baseRepairArtifact: predecessor.repairArtifact,
    baseRepairFidelityArtifact,
    baseRepairSolutionItemHash: legacyRepairedHash,
    trigger: upgradeTrigger,
    revisionPromptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
  });
  const upgradeRelativePath = `solution-revision-upgrades/v1-0001-0001-${upgradeBasisHash}.json`;
  const upgradeCheckpoint = {
    version: 1,
    entryId: SOLUTION_PROMPT_UPGRADE_SPEC.entryId,
    key: "1:1",
    printedNumber: "1",
    sourceHash: SOLUTION_PROMPT_UPGRADE_SPEC.sourceHash,
    basePage: legacyInput.sourcePage,
    contextFrom: legacyInput.baseContextFrom,
    contextTo: legacyInput.baseContextTo,
    baseOwnedFrom: legacyInput.baseOwnedFrom,
    baseOwnedTo: legacyInput.baseOwnedTo,
    effectiveProblemCorpusHash: legacyRepair.effectiveProblemCorpusHash,
    baseSolutionCheckpoint: legacyInput.baseSolutionCheckpoint,
    baseSolutionItemHash: legacyInput.baseSolutionItemHash,
    baseRepairArtifact: predecessor.repairArtifact,
    baseRepairFidelityArtifact,
    baseRepairPage: legacyRepaired.page,
    baseRepairSolutionItemHash: legacyRepairedHash,
    trigger: upgradeTrigger,
    diagnosticDecision: legacyFirstDecision,
    diagnosticDecisionHash: canonicalEvidenceHash(legacyFirstDecision),
    promptVersion: TARGETED_SOLUTION_REVISION_VERSION,
    promptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    effectivePage: 1,
    item: finalSolution,
  };
  const upgradeHash = writeEvidence(join(stateDir, upgradeRelativePath), upgradeCheckpoint);
  const finalSolutionHash = canonicalEvidenceHash(finalSolution);
  const upgradeInput = {
    ...legacyInput,
    sourcePage: 1,
    rawAnswer: finalSolution.answer,
    explanation: finalSolution.explanation,
  };
  const upgradeDecision = {
    key: "1:1",
    sourcePage: 1,
    answerStatus: "exact",
    explanationStatus: "exact",
    evidence: "정답표 1번 ②와 전체 지수 계산 해설이 공식 픽셀과 일치한다.",
  };
  const upgradeFidelityRelativePath =
    `solution-fidelity-revision-upgrades/v1-0001-0001-${upgradeHash}-${finalSolutionHash}.json`;
  const upgradeFidelityCheckpoint = {
    version: 1,
    entryId: SOLUTION_PROMPT_UPGRADE_SPEC.entryId,
    key: "1:1",
    sourceHash: SOLUTION_PROMPT_UPGRADE_SPEC.sourceHash,
    from: legacyInput.baseContextFrom,
    to: legacyInput.baseContextTo,
    basePage: legacyInput.sourcePage,
    baseRepairPage: legacyRepaired.page,
    effectivePage: 1,
    baseOwnedFrom: legacyInput.baseOwnedFrom,
    baseOwnedTo: legacyInput.baseOwnedTo,
    effectiveProblemCorpusHash: legacyRepair.effectiveProblemCorpusHash,
    baseSolutionCheckpoint: legacyInput.baseSolutionCheckpoint,
    baseSolutionItemHash: legacyInput.baseSolutionItemHash,
    baseRepairArtifact: predecessor.repairArtifact,
    baseRepairFidelityArtifact,
    baseRepairSolutionItemHash: legacyRepairedHash,
    diagnosticDecisionHash: canonicalEvidenceHash(legacyFirstDecision),
    trigger: upgradeTrigger,
    revisionArtifact: { path: upgradeRelativePath, sha256: upgradeHash },
    effectiveSolutionItemHash: finalSolutionHash,
    inputHash: canonicalEvidenceHash(upgradeInput),
    promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    input: upgradeInput,
    item: upgradeDecision,
  };
  const upgradeFidelityHash = writeEvidence(
    join(stateDir, upgradeFidelityRelativePath),
    upgradeFidelityCheckpoint,
  );
  const historicalAuthority = {
    generationId,
    key: "1:1",
    repairArtifact: predecessor.repairArtifact,
    repairFidelityArtifact: predecessor.repairFidelityArtifact,
    revisionArtifact: { path: upgradeRelativePath, sha256: upgradeHash },
    revisionFidelityArtifact: { path: upgradeFidelityRelativePath, sha256: upgradeFidelityHash },
    finalSolutionItemHash: finalSolutionHash,
    diagnosticDecisionHash: canonicalEvidenceHash(legacyFirstDecision),
    diagnosticEvidence: predecessor.failedEvidence,
  };

  const attestationName = readdirSync(join(stateDir, "answer-attestation"))
    .find((name) => /^v5-/u.test(name))!;
  const attestation = JSON.parse(readFileSync(join(stateDir, "answer-attestation", attestationName), "utf8"));
  const audit = JSON.parse(readFileSync(join(stateDir, attestation.answerAudit.path), "utf8"));
  const currentBasePointer = audit.solutionFidelityCheckpoints.find((pointer: Record<string, unknown>) => {
    const checkpoint = JSON.parse(readFileSync(join(stateDir, String(pointer.path)), "utf8"));
    return checkpoint.inputs.some((input: { key: string }) => input.key === "1:1");
  });
  const currentBase = JSON.parse(readFileSync(join(stateDir, currentBasePointer.path), "utf8"));
  const currentInput = currentBase.inputs.find((input: { key: string }) => input.key === "1:1");
  const currentEffectiveProblemCorpusHash = audit.effectiveCorpusHash;
  const currentGenerationId = canonicalEvidenceHash({
    key: "1:1",
    effectiveProblemCorpusHash: currentEffectiveProblemCorpusHash,
    baseFidelityCheckpointSha256: currentBasePointer.sha256,
  });
  const persistedSeed = {
    version: 1,
    generationId,
    effectiveProblemCorpusHash: legacyRepair.effectiveProblemCorpusHash,
    baseFidelityCheckpoint: legacyRepair.baseFidelityCheckpoint,
    repairArtifact: predecessor.repairArtifact,
    repairFidelityArtifact: predecessor.repairFidelityArtifact,
    repairedItemHash: legacyRepairedHash,
  };
  const currentRepairRelativePath = `solution-repairs/v1-0001-0001-${currentBasePointer.sha256}.json`;
  const currentRepairCheckpoint = {
    version: 1,
    entryId: SOLUTION_PROMPT_UPGRADE_SPEC.entryId,
    key: "1:1",
    printedNumber: "1",
    basePage: 1,
    contextFrom: 1,
    contextTo: 4,
    baseOwnedFrom: 1,
    baseOwnedTo: 4,
    sourceHash: SOLUTION_PROMPT_UPGRADE_SPEC.sourceHash,
    effectiveProblemCorpusHash: currentEffectiveProblemCorpusHash,
    baseSolutionCheckpoint: currentInput.baseSolutionCheckpoint,
    baseFidelityCheckpoint: { path: currentBasePointer.path, sha256: currentBasePointer.sha256 },
    baseSolutionItemHash: currentInput.baseSolutionItemHash,
    baseRawAnswerHash: hash(currentInput.rawAnswer),
    baseExplanationHash: hash(currentInput.explanation),
    promptVersion: TARGETED_SOLUTION_TRANSCRIPTION_VERSION,
    promptDigest: TARGETED_SOLUTION_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    persistedSeed,
    effectivePage: legacyRepaired.page,
    item: legacyRepaired,
  };
  const currentRepairHash = writeEvidence(join(stateDir, currentRepairRelativePath), currentRepairCheckpoint);
  const currentRepairPointer = { path: currentRepairRelativePath, sha256: currentRepairHash };
  const currentRepairedInput = {
    ...currentInput,
    sourcePage: legacyRepaired.page,
    rawAnswer: legacyRepaired.answer,
    explanation: legacyRepaired.explanation,
  };
  const currentFirstDecision = {
    key: "1:1",
    sourcePage: legacyRepaired.page,
    answerStatus: "exact",
    explanationStatus: "exact",
    evidence: "현재 첫 수리는 기존 공식 정답표와 해설을 정확히 보존한다.",
  };
  const currentRepairFidelityRelativePath = `solution-fidelity-repairs/v1-0001-0001-` +
    `${currentBasePointer.sha256}-${legacyRepairedHash}.json`;
  const currentRepairFidelityCheckpoint = {
    version: 1,
    entryId: SOLUTION_PROMPT_UPGRADE_SPEC.entryId,
    key: "1:1",
    sourceHash: SOLUTION_PROMPT_UPGRADE_SPEC.sourceHash,
    from: 1,
    to: 4,
    basePage: 1,
    effectivePage: legacyRepaired.page,
    baseOwnedFrom: 1,
    baseOwnedTo: 4,
    effectiveProblemCorpusHash: currentEffectiveProblemCorpusHash,
    baseSolutionCheckpoint: currentInput.baseSolutionCheckpoint,
    baseFidelityCheckpoint: { path: currentBasePointer.path, sha256: currentBasePointer.sha256 },
    repairArtifact: currentRepairPointer,
    effectiveSolutionItemHash: legacyRepairedHash,
    inputHash: canonicalEvidenceHash(currentRepairedInput),
    promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    input: currentRepairedInput,
    item: currentFirstDecision,
  };
  const currentRepairFidelityHash = writeEvidence(
    join(stateDir, currentRepairFidelityRelativePath),
    currentRepairFidelityCheckpoint,
  );
  const currentRepairFidelityPointer = {
    path: currentRepairFidelityRelativePath,
    sha256: currentRepairFidelityHash,
  };
  const persistedTrigger = {
    kind: "persisted",
    fidelityDecisionHash: canonicalEvidenceHash(currentFirstDecision),
    persistedTriggerVersion: 1,
    predecessor: historicalAuthority,
  };
  const currentBaseRepairFidelityArtifact = {
    ...currentRepairFidelityPointer,
    promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
  };
  const currentRevisionBasisHash = canonicalEvidenceHash({
    key: "1:1",
    sourceHash: SOLUTION_PROMPT_UPGRADE_SPEC.sourceHash,
    basePage: 1,
    contextFrom: 1,
    contextTo: 4,
    baseSolutionCheckpoint: currentInput.baseSolutionCheckpoint,
    baseSolutionItemHash: currentInput.baseSolutionItemHash,
    baseRepairArtifact: currentRepairPointer,
    baseRepairFidelityArtifact: currentBaseRepairFidelityArtifact,
    baseRepairSolutionItemHash: legacyRepairedHash,
    trigger: persistedTrigger,
    revisionPromptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
  });
  const currentRevisionRelativePath = `solution-revisions/v1-0001-0001-${currentRevisionBasisHash}.json`;
  const currentRevisionCheckpoint = {
    version: 1,
    entryId: SOLUTION_PROMPT_UPGRADE_SPEC.entryId,
    key: "1:1",
    printedNumber: "1",
    sourceHash: SOLUTION_PROMPT_UPGRADE_SPEC.sourceHash,
    basePage: 1,
    contextFrom: 1,
    contextTo: 4,
    baseOwnedFrom: 1,
    baseOwnedTo: 4,
    effectiveProblemCorpusHash: currentEffectiveProblemCorpusHash,
    baseSolutionCheckpoint: currentInput.baseSolutionCheckpoint,
    baseSolutionItemHash: currentInput.baseSolutionItemHash,
    baseRepairArtifact: currentRepairPointer,
    baseRepairFidelityArtifact: currentBaseRepairFidelityArtifact,
    baseRepairPage: 1,
    baseRepairSolutionItemHash: legacyRepairedHash,
    trigger: persistedTrigger,
    diagnosticDecision: currentFirstDecision,
    diagnosticDecisionHash: canonicalEvidenceHash(currentFirstDecision),
    promptVersion: TARGETED_SOLUTION_REVISION_VERSION,
    promptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    effectivePage: 1,
    item: finalSolution,
  };
  const currentRevisionHash = writeEvidence(
    join(stateDir, currentRevisionRelativePath),
    currentRevisionCheckpoint,
  );
  const currentRevisionPointer = { path: currentRevisionRelativePath, sha256: currentRevisionHash };
  const currentFinalInput = {
    ...currentInput,
    sourcePage: 1,
    rawAnswer: finalSolution.answer,
    explanation: finalSolution.explanation,
  };
  const currentFinalDecision = {
    key: "1:1",
    sourcePage: 1,
    answerStatus: "exact",
    explanationStatus: "exact",
    evidence: "현재 세대도 정답표 ②와 완전한 지수 해설에 일치한다.",
  };
  const currentRevisionFidelityRelativePath = `solution-fidelity-revisions/v1-0001-0001-` +
    `${currentRevisionHash}-${finalSolutionHash}.json`;
  const currentRevisionFidelityCheckpoint = {
    version: 1,
    entryId: SOLUTION_PROMPT_UPGRADE_SPEC.entryId,
    key: "1:1",
    sourceHash: SOLUTION_PROMPT_UPGRADE_SPEC.sourceHash,
    from: 1,
    to: 4,
    basePage: 1,
    baseRepairPage: 1,
    effectivePage: 1,
    baseOwnedFrom: 1,
    baseOwnedTo: 4,
    effectiveProblemCorpusHash: currentEffectiveProblemCorpusHash,
    baseSolutionCheckpoint: currentInput.baseSolutionCheckpoint,
    baseSolutionItemHash: currentInput.baseSolutionItemHash,
    baseRepairArtifact: currentRepairPointer,
    baseRepairFidelityArtifact: currentBaseRepairFidelityArtifact,
    baseRepairSolutionItemHash: legacyRepairedHash,
    diagnosticDecisionHash: canonicalEvidenceHash(currentFirstDecision),
    trigger: persistedTrigger,
    revisionArtifact: currentRevisionPointer,
    effectiveSolutionItemHash: finalSolutionHash,
    inputHash: canonicalEvidenceHash(currentFinalInput),
    promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    input: currentFinalInput,
    item: currentFinalDecision,
  };
  const currentRevisionFidelityHash = writeEvidence(
    join(stateDir, currentRevisionFidelityRelativePath),
    currentRevisionFidelityCheckpoint,
  );
  const currentRevisionFidelityPointer = {
    path: currentRevisionFidelityRelativePath,
    sha256: currentRevisionFidelityHash,
  };
  const currentRepairEvidence = {
    key: "1:1",
    printedNumber: "1",
    basePage: 1,
    effectivePage: 1,
    contextFrom: 1,
    contextTo: 4,
    baseOwnedFrom: 1,
    baseOwnedTo: 4,
    baseSolutionCheckpoint: currentInput.baseSolutionCheckpoint,
    baseFidelityCheckpoint: { path: currentBasePointer.path, sha256: currentBasePointer.sha256 },
    repairArtifact: currentRepairPointer,
    fidelityArtifact: {
      ...currentRepairFidelityPointer,
      promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    },
    baseSolutionItemHash: currentInput.baseSolutionItemHash,
    effectiveSolutionItemHash: legacyRepairedHash,
    baseRawAnswerHash: hash(currentInput.rawAnswer),
    effectiveRawAnswerHash: hash(legacyRepaired.answer),
    baseExplanationHash: hash(currentInput.explanation),
    effectiveExplanationHash: hash(legacyRepaired.explanation),
    revision: {
      trigger: persistedTrigger,
      baseRepairPage: 1,
      effectivePage: 1,
      baseRepairArtifact: currentRepairPointer,
      baseRepairFidelityArtifact: currentBaseRepairFidelityArtifact,
      solutionArtifact: {
        ...currentRevisionPointer,
        revisionPromptVersion: TARGETED_SOLUTION_REVISION_VERSION,
        revisionPromptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
      },
      fidelityArtifact: {
        ...currentRevisionFidelityPointer,
        promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
      },
      diagnosticDecisionHash: canonicalEvidenceHash(currentFirstDecision),
      baseSolutionItemHash: currentInput.baseSolutionItemHash,
      baseRepairSolutionItemHash: legacyRepairedHash,
      effectiveSolutionItemHash: finalSolutionHash,
      baseRepairRawAnswerHash: hash(legacyRepaired.answer),
      effectiveRawAnswerHash: hash(finalSolution.answer),
      baseRepairExplanationHash: hash(legacyRepaired.explanation),
      effectiveExplanationHash: hash(finalSolution.explanation),
    },
  };

  const solutionCheckpoint = JSON.parse(readFileSync(join(stateDir, "solution-chunks", "v3-0000.json"), "utf8"));
  const q2Solution = solutionCheckpoint.items.find((item: { number: string }) => item.number === "2");
  const effectiveSolutionCorpusHash = canonicalEvidenceHash([{
    key: "1:1",
    solution: finalSolution,
  }, {
    key: "1:2",
    solution: q2Solution,
  }].sort((left, right) => compareCorpusQuestionKeys(left.key, right.key)));
  const problemCheckpoint = JSON.parse(readFileSync(join(stateDir, "problem-chunks", "v2-0000.json"), "utf8"));
  const semanticInputs = [0, 1].map((index) => ({
    key: `1:${index + 1}`,
    choices: problemCheckpoint.items[index].choices,
    detailedExplanation: redactedExplanation(index === 0 ? finalSolution.explanation : q2Solution.explanation),
  }));
  const semanticDecisions = [2, 5].map((choiceIndex, index) => ({
    key: `1:${index + 1}`,
    status: "resolved",
    choiceIndex,
    evidence: `공식 해설의 결론은 선택지 ${choiceIndex}와 유일하게 일치한다.`,
  }));
  const semanticInputHash = canonicalEvidenceHash(semanticInputs);
  const semanticRelativePath = `semantic-choice-checks/v5-${currentEffectiveProblemCorpusHash}-` +
    `${effectiveSolutionCorpusHash}-${semanticInputHash}.json`;
  const semanticHash = writeEvidence(join(stateDir, semanticRelativePath), {
    version: 5,
    entryId: SOLUTION_PROMPT_UPGRADE_SPEC.entryId,
    problemHash: JSON.parse(readFileSync(join(stateDir, "downloads.json"), "utf8")).problem.sha256,
    solutionHash: SOLUTION_PROMPT_UPGRADE_SPEC.sourceHash,
    classifierVersion: 5,
    rulesDigest: DIGEST,
    transcriptionGateVersion: 2,
    transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
    effectiveCorpusHash: currentEffectiveProblemCorpusHash,
    effectiveSolutionCorpusHash,
    inputHash: semanticInputHash,
    promptDigest: V5_SEMANTIC_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    inputs: semanticInputs,
    items: semanticDecisions,
  });
  rewriteSolutionAuditAuthority(files, (currentAudit) => {
    const q1Item = currentAudit.solutionFidelityItems.find((item: { key: string }) => item.key === "1:1");
    Object.assign(q1Item, {
      effectivePage: 1,
      answerStatus: currentFinalDecision.answerStatus,
      explanationStatus: currentFinalDecision.explanationStatus,
      evidence: currentFinalDecision.evidence,
      fidelityArtifact: {
        ...currentRevisionFidelityPointer,
        promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
      },
      effectiveSolutionItemHash: finalSolutionHash,
      effectiveRawAnswerHash: hash(finalSolution.answer),
      effectiveExplanationHash: hash(finalSolution.explanation),
    });
    currentAudit.solutionRepairs = [currentRepairEvidence];
    currentAudit.solutionRepairKeys = ["1:1"];
    currentAudit.effectiveSolutionCorpusHash = effectiveSolutionCorpusHash;
    currentAudit.semanticCheckpoint = {
      path: semanticRelativePath,
      sha256: semanticHash,
      inputHash: semanticInputHash,
      effectiveCorpusHash: currentEffectiveProblemCorpusHash,
      effectiveSolutionCorpusHash,
    };
    currentAudit.items = ["②", "⑤"].map((rawAnswer, index) => ({
      key: `1:${index + 1}`,
      printedNumber: String(index + 1),
      sourcePage: 1,
      officialRawAnswerHash: hash(rawAnswer),
      storedAnswerHash: hash(rawAnswer),
      mode: "choice-marker",
      choiceIndex: semanticDecisions[index].choiceIndex,
      semantic: {
        status: semanticDecisions[index].status,
        choiceIndex: semanticDecisions[index].choiceIndex,
        evidence: semanticDecisions[index].evidence,
      },
    }));
  });
  const db = new Database(files.dbPath);
  for (const [number, answer, explanation] of [
    ["1", "②", finalSolution.explanation],
    ["2", "⑤", q2Solution.explanation],
  ]) {
    db.prepare(
      "UPDATE questions SET answer = ?, explanation = ? WHERE printed_number = ? " +
      "AND book_id IN (SELECT id FROM books WHERE title = ?)",
    ).run(answer, explanation, number, "2025년 · 2025 수능 수학 미적분");
    db.prepare(
      "UPDATE book_items SET answer = ?, content = ?, page = 1 WHERE category = '해설' AND number = ? " +
      "AND book_id IN (SELECT id FROM books WHERE title = ?)",
    ).run(answer, explanation, number, "2025년 · 2025 수능 수학 미적분");
  }
  db.close();
  return {
    upgradeArtifact: join(stateDir, upgradeRelativePath),
    upgradeFidelityArtifact: join(stateDir, upgradeFidelityRelativePath),
    currentRevisionArtifact: join(stateDir, currentRevisionRelativePath),
    legacyRevisionArtifact: join(stateDir, legacyRevisionPath),
  };
}

async function installSolutionFidelityAdjudication(files: ReturnType<typeof fixture>): Promise<{
  childArtifact: string;
  evidenceArtifact: string;
  failedFidelityArtifact: string;
}> {
  const oldStateDir = files.stateDirs.math;
  const storedEntry = JSON.parse(readFileSync(join(
    SOLUTION_FIDELITY_ADJUDICATION_STATE,
    "entry.json",
  ), "utf8")).entry;
  const entry = parseCorpusManifest({ schemaVersion: 2, entries: [storedEntry] }).entries[0];
  const stateDir = join(files.dataDir, "import-exam-corpus", token(entry.id, 24));
  renameSync(oldStateDir, stateDir);
  files.stateDirs.math = stateDir;
  writeJson(join(stateDir, "entry.json"), { schemaVersion: 2, entry: storedEntry });
  const manifest = JSON.parse(readFileSync(files.manifestPath, "utf8"));
  const oldEntryId = manifest.entries.find((value: { subject: string }) => value.subject === "수학").id;
  Object.assign(manifest.entries.find((value: { id: string }) => value.id === oldEntryId), storedEntry);
  writeJson(files.manifestPath, manifest);

  const downloads = JSON.parse(readFileSync(join(
    SOLUTION_FIDELITY_ADJUDICATION_STATE,
    "downloads.json",
  ), "utf8"));
  const problemBytes = readFileSync(join(SOLUTION_FIDELITY_ADJUDICATION_STATE, "problem.pdf"));
  const solutionBytes = readFileSync(join(SOLUTION_FIDELITY_ADJUDICATION_STATE, "solution.pdf"));
  expect(hash(problemBytes)).toBe(downloads.problem.sha256);
  expect(hash(solutionBytes)).toBe(SOLUTION_FIDELITY_ADJUDICATION_SPEC.sourceHash);
  writeFileSync(join(stateDir, "problem.pdf"), problemBytes);
  writeFileSync(join(stateDir, "solution.pdf"), solutionBytes);
  writeJson(join(stateDir, "downloads.json"), downloads);

  const classified = q20EffectiveClassified();
  const problemDir = join(stateDir, "problem-chunks");
  for (const name of readdirSync(problemDir)) rmSync(join(problemDir, name));
  const problemCheckpoint = JSON.parse(readFileSync(join(
    SOLUTION_FIDELITY_ADJUDICATION_STATE,
    "problem-chunks/v2-0000.json",
  ), "utf8"));
  problemCheckpoint.items = classified.map((value) => value.question);
  writeJson(join(problemDir, "v2-0000.json"), problemCheckpoint);
  const classificationDir = join(stateDir, "classification-chunks");
  for (const name of readdirSync(classificationDir)) rmSync(join(classificationDir, name));
  const classificationCheckpoint = JSON.parse(readFileSync(join(
    SOLUTION_FIDELITY_ADJUDICATION_STATE,
    `classification-chunks/v5-0000-${DIGEST}.json`,
  ), "utf8"));
  classificationCheckpoint.items = classified.map((value) => value.classification);
  writeJson(join(classificationDir, `v5-0000-${DIGEST}.json`), classificationCheckpoint);

  const terminalDir = join(stateDir, "problem-terminal-fidelity");
  mkdirSync(terminalDir, { recursive: true });
  for (const name of readdirSync(terminalDir)) rmSync(join(terminalDir, name));
  const terminalName =
    "v2-0000-3f0f4625f5ee5ba0c627c2655ae751e7fdbd334e49143b552b1280b71abbdda6-" +
    "15bcf83cec42ceb2f2fa4d0640538b6b29825938998e2f8dbf095bbd940afe66.json";
  writeFileSync(
    join(terminalDir, terminalName),
    readFileSync(join(SOLUTION_FIDELITY_ADJUDICATION_STATE, "problem-terminal-fidelity", terminalName)),
  );

  const solutionChunkDir = join(stateDir, "solution-chunks");
  for (const name of readdirSync(solutionChunkDir)) rmSync(join(solutionChunkDir, name));
  for (const name of ["v3-0000.json", "v3-0001.json", "v3-0002.json"]) {
    writeFileSync(
      join(solutionChunkDir, name),
      readFileSync(join(SOLUTION_FIDELITY_ADJUDICATION_STATE, "solution-chunks", name)),
    );
  }
  const authorityPaths = [
    "solution-fidelity/v1-0000-3f0f4625f5ee5ba0c627c2655ae751e7fdbd334e49143b552b1280b71abbdda6-" +
      "07041f5c4c306e5cccea957f29035517be45f115a975ebcf8329009b4407816f.json",
    "solution-repairs/v1-0006-0020-6a1bcd6840735026cb442ce830c4264d9918f245a36bf54be159b77f958afd48.json",
    "solution-fidelity-repairs/v1-0006-0020-6a1bcd6840735026cb442ce830c4264d9918f245a36bf54be159b77f958afd48-" +
      "08a3140a57921a9c64e95ac4b069114c5502db37e8cd060574ffc84ab1804021.json",
    "solution-revisions/v1-0006-0020-e3583527616f630a8814e871bc7c46c0d2bb4b9a86a7eb0959ccaa9ce4164717.json",
    "solution-fidelity-revisions/v1-0006-0020-00da6e80bdbbe87cbff4ce54b57737c77167f0e2764c64ae5c87c1972ef9c9dc-" +
      "7ad16feb562bc2650dc29272ca0d842e4569b512acb7ae6dae122feb30ffa94a.json",
  ];
  for (const relativePath of authorityPaths) {
    const destination = join(stateDir, relativePath);
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, readFileSync(join(SOLUTION_FIDELITY_ADJUDICATION_STATE, relativePath)));
  }

  const revisionRelativePath = authorityPaths[3];
  const failedFidelityRelativePath = authorityPaths[4];
  const revision = JSON.parse(readFileSync(join(stateDir, revisionRelativePath), "utf8"));
  const failedFidelity = JSON.parse(readFileSync(join(stateDir, failedFidelityRelativePath), "utf8"));
  const revisionArtifact = { path: revisionRelativePath, sha256: hash(readFileSync(join(stateDir, revisionRelativePath))) };
  const failedFidelityArtifact = {
    path: failedFidelityRelativePath,
    sha256: hash(readFileSync(join(stateDir, failedFidelityRelativePath))),
    promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
  };
  const sourcePages = [...new Set(SOLUTION_FIDELITY_ADJUDICATION_SPEC.views.map((view) => view.sourcePage))]
    .sort((left, right) => left - right);
  const evidenceBasis = {
    allowlistId: SOLUTION_FIDELITY_ADJUDICATION_SPEC.allowlistId,
    entryId: entry.id,
    key: SOLUTION_FIDELITY_ADJUDICATION_SPEC.key,
    sourcePage: SOLUTION_FIDELITY_ADJUDICATION_SPEC.sourcePage,
    sourcePages,
    sourceHash: downloads.solution.sha256,
    dpi: SOLUTION_FIDELITY_ADJUDICATION_SPEC.dpi,
    views: SOLUTION_FIDELITY_ADJUDICATION_SPEC.views,
    requiredTokens: SOLUTION_FIDELITY_ADJUDICATION_SPEC.requiredTokens,
  };
  const evidenceDigest = canonicalEvidenceHash(evidenceBasis);
  const evidenceStem = `v1-0006-0020-${evidenceDigest}`;
  const cropViews = SOLUTION_FIDELITY_ADJUDICATION_SPEC.views.map((view, index) => {
    const width = Math.max(1, Math.ceil((view.rect[2] - view.rect[0]) * 4961));
    const height = Math.max(1, Math.ceil((view.rect[3] - view.rect[1]) * 7016));
    const relativePath = `solution-fidelity-adjudication-evidence/${evidenceStem}-view-` +
      `${String(index).padStart(2, "0")}.png`;
    const bytes = pngHeader(width, height);
    mkdirSync(join(stateDir, relativePath, ".."), { recursive: true });
    writeFileSync(join(stateDir, relativePath), bytes);
    const sha256 = hash(bytes);
    return {
      sourcePage: view.sourcePage,
      label: view.label,
      rect: [...view.rect],
      pixelWidth: width,
      pixelHeight: height,
      pixelSha256: sha256,
      artifact: { path: relativePath, sha256 },
    };
  });
  const evidencePdfRelativePath = `solution-fidelity-adjudication-evidence/${evidenceStem}.pdf`;
  const evidencePdfBytes = Buffer.from("%PDF-1.4\n% deterministic solution fidelity adjudication fixture\n");
  writeFileSync(join(stateDir, evidencePdfRelativePath), evidencePdfBytes);
  const evidencePdf = { path: evidencePdfRelativePath, sha256: hash(evidencePdfBytes) };
  const evidenceRelativePath = `solution-fidelity-adjudication-evidence/${evidenceStem}.json`;
  const evidenceCheckpoint = {
    version: 1,
    entryId: entry.id,
    basisDigest: evidenceDigest,
    basis: evidenceBasis,
    renderer: "pdftocairo-png+pdf-lib",
    dpi: SOLUTION_FIDELITY_ADJUDICATION_SPEC.dpi,
    evidencePdf,
    views: cropViews,
  };
  const evidenceHash = writeEvidence(join(stateDir, evidenceRelativePath), evidenceCheckpoint);
  const cropEvidenceArtifact = { path: evidenceRelativePath, sha256: evidenceHash };
  const childBasis = {
    allowlistId: SOLUTION_FIDELITY_ADJUDICATION_SPEC.allowlistId,
    entryId: entry.id,
    key: SOLUTION_FIDELITY_ADJUDICATION_SPEC.key,
    sourcePage: SOLUTION_FIDELITY_ADJUDICATION_SPEC.sourcePage,
    sourcePages,
    sourceHash: downloads.solution.sha256,
    dpi: SOLUTION_FIDELITY_ADJUDICATION_SPEC.dpi,
    effectiveProblemCorpusHash: failedFidelity.effectiveProblemCorpusHash,
    revisionArtifact,
    failedFidelityArtifact,
    revisionSolutionItemHash: canonicalEvidenceHash(revision.item),
    failedDecision: failedFidelity.item,
    failedDecisionHash: canonicalEvidenceHash(failedFidelity.item),
    failedEvidenceHash: hash(failedFidelity.item.evidence),
    cropEvidenceArtifact,
    cropEvidencePdf: evidencePdf,
    cropViews,
    inputHash: canonicalEvidenceHash(failedFidelity.input),
    promptDigest: SOLUTION_REVISION_FIDELITY_ADJUDICATION_PROMPT_DIGEST,
  };
  const childBasisDigest = canonicalEvidenceHash(childBasis);
  const childRelativePath = `solution-fidelity-adjudications/v1-0006-0020-${childBasisDigest}.json`;
  const adjudicatedDecision = {
    key: SOLUTION_FIDELITY_ADJUDICATION_SPEC.key,
    sourcePage: 6,
    answerStatus: "exact",
    explanationStatus: "exact",
    evidence: "p6-p7 공식 픽셀은 정답 ③과 극솟값 문구를 포함한 revision 전체 해설에 일치한다.",
  };
  writeEvidence(join(stateDir, childRelativePath), {
    version: 1,
    basisDigest: childBasisDigest,
    basis: childBasis,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    input: failedFidelity.input,
    item: adjudicatedDecision,
  });

  const problemEvidence = {
    ...downloads.problem,
    path: join(stateDir, "problem.pdf"),
    resolvedUrl: downloads.problem.requestedUrl,
  };
  const solutionEvidence = {
    ...downloads.solution,
    path: join(stateDir, "solution.pdf"),
    resolvedUrl: downloads.solution.requestedUrl,
  };
  const baseSolutions = ["v3-0000.json", "v3-0001.json", "v3-0002.json"].flatMap((name) =>
    JSON.parse(readFileSync(join(solutionChunkDir, name), "utf8")).items);
  const solutionAudit = await auditAcceptedSolutions(
    entry,
    problemEvidence,
    solutionEvidence,
    stateDir,
    classified as any,
    baseSolutions,
  );
  const solutionByNumber = new Map(solutionAudit.solutions.map((solution: Record<string, any>) => [
    String(Number(solution.number)),
    solution,
  ]));
  const accepted = classified.filter((value) => value.classification.decision === "accept");
  const markerInputs: Array<{ key: string; choices: string[]; detailedExplanation: string }> = [];
  const auditItems = accepted.flatMap((value) => {
    if (value.question.qtype !== "mcq") return [];
    const solution = solutionByNumber.get(String(Number(value.question.number)))!;
    const resolution = resolveOfficialAnswer(value.question as any, solution.answer);
    const semantic = resolution.mode === "choice-marker" ? {
      status: "resolved" as const,
      choiceIndex: resolution.choiceIndex! + 1,
      evidence: `공식 해설 결론은 ${resolution.choiceIndex! + 1}번 선택지와 유일하게 일치한다.`,
    } : null;
    if (semantic) markerInputs.push({
      key: value.classification.key,
      choices: value.question.choices,
      detailedExplanation: redactedExplanation(solution.explanation),
    });
    return [{
      key: value.classification.key,
      printedNumber: String(Number(value.question.number)),
      sourcePage: value.question.page,
      officialRawAnswerHash: hash(solution.answer),
      storedAnswerHash: hash(resolution.storedAnswer),
      mode: resolution.mode,
      choiceIndex: resolution.choiceIndex! + 1,
      semantic,
    }];
  }).sort((left, right) => compareCorpusQuestionKeys(left.key, right.key));
  markerInputs.sort((left, right) => compareCorpusQuestionKeys(left.key, right.key));
  const semanticCheckpoint = markerInputs.length === 0 ? null : (() => {
    const inputHash = canonicalEvidenceHash(markerInputs);
    const semanticItems = markerInputs.map((input) => auditItems.find((item) => item.key === input.key)!.semantic!);
    const relativePath = `semantic-choice-checks/v5-${failedFidelity.effectiveProblemCorpusHash}-` +
      `${solutionAudit.effectiveSolutionCorpusHash}-${inputHash}.json`;
    const checkpoint = {
      version: 5,
      entryId: entry.id,
      problemHash: downloads.problem.sha256,
      solutionHash: downloads.solution.sha256,
      classifierVersion: 5,
      rulesDigest: DIGEST,
      transcriptionGateVersion: 2,
      transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
      effectiveCorpusHash: failedFidelity.effectiveProblemCorpusHash,
      effectiveSolutionCorpusHash: solutionAudit.effectiveSolutionCorpusHash,
      inputHash,
      promptDigest: V5_SEMANTIC_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      inputs: markerInputs,
      items: markerInputs.map((input, index) => ({ key: input.key, ...semanticItems[index] })),
    };
    return {
      path: relativePath,
      sha256: writeEvidence(join(stateDir, relativePath), checkpoint),
      inputHash,
      effectiveCorpusHash: failedFidelity.effectiveProblemCorpusHash,
      effectiveSolutionCorpusHash: solutionAudit.effectiveSolutionCorpusHash,
    };
  })();

  const canonicalTarget = new Map([
    ["math_A", "수학 - 수학Ⅱ·미적분Ⅰ"],
    ["math_B", "수학 - 수학Ⅰ·대수"],
  ]);
  const targetQuestionCounts = Object.fromEntries([...canonicalTarget.values()].flatMap((target) => {
    const count = accepted.filter((value) => canonicalTarget.get(value.classification.canonical_subject) === target).length;
    return count > 0 ? [[target, count]] : [];
  }));
  const terminalPath = join(terminalDir, terminalName);
  const terminal = JSON.parse(readFileSync(terminalPath, "utf8"));
  const terminalPointer = {
    path: `problem-terminal-fidelity/${terminalName}`,
    sha256: hash(readFileSync(terminalPath)),
    from: terminal.from,
    to: terminal.to,
    ownedFrom: terminal.ownedFrom,
    ownedTo: terminal.ownedTo,
    inputHash: terminal.inputHash,
  };
  const auditBasis = {
    entryId: entry.id,
    problemHash: downloads.problem.sha256,
    solutionHash: downloads.solution.sha256,
    classifierVersion: 5,
    rulesDigest: DIGEST,
    transcriptionGateVersion: 2,
    transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
    solutionFidelityVersion: 1,
    solutionFidelityPromptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    problemTerminalFidelityVersion: 2,
    problemTerminalScopePromptDigest: PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST,
    semanticChoiceVersion: 5,
    semanticPromptDigest: V5_SEMANTIC_PROMPT_DIGEST,
    sourceQuestionCount: classified.length,
    acceptedQuestionCount: accepted.length,
    rejectedQuestionCount: classified.filter((value) => value.classification.decision === "reject").length,
    reviewQuestionCount: 0,
    targetQuestionCounts,
    acceptedSolutionKeys: solutionAudit.items.map((item) => item.key).sort(compareCorpusQuestionKeys),
    solutionRepairKeys: solutionAudit.repairs.map((item) => item.key).sort(compareCorpusQuestionKeys),
    derivedAnswerKeys: solutionAudit.items.filter((item) => item.answerStatus === "not_visible")
      .map((item) => item.key).sort(compareCorpusQuestionKeys),
    acceptedMcqKeys: auditItems.map((item) => item.key).sort(compareCorpusQuestionKeys),
    effectiveCorpusHash: failedFidelity.effectiveProblemCorpusHash,
    effectiveSolutionCorpusHash: solutionAudit.effectiveSolutionCorpusHash,
    solutionFidelityCheckpoints: solutionAudit.checkpoints,
    solutionFidelityItems: solutionAudit.items,
    solutionRepairs: solutionAudit.repairs,
    problemTerminalFidelityCheckpoints: [terminalPointer],
    problemTerminalFidelityItems: terminal.items,
    semanticCheckpoint,
    repairs: [],
    items: auditItems,
  };
  const auditDigest = canonicalEvidenceHash(auditBasis);
  const auditRelativePath = `answer-audit/v5-${auditDigest}.json`;
  for (const name of readdirSync(join(stateDir, "answer-audit"))) rmSync(join(stateDir, "answer-audit", name));
  const auditHash = writeEvidence(join(stateDir, auditRelativePath), {
    version: 5,
    auditDigest,
    ...auditBasis,
  });

  const displayTitle = `${entry.sourceRecordYear}년 · ${entry.rawTitle}`;
  const db = new Database(files.dbPath);
  const targetBooks = [] as Array<Record<string, unknown>>;
  let nextQuestionId = (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM questions").get() as { id: number }).id;
  let nextItemId = (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM book_items").get() as { id: number }).id;
  for (const [canonical, target] of canonicalTarget) {
    const rows = accepted.filter((value) => value.classification.canonical_subject === canonical);
    if (rows.length === 0) continue;
    const book = db.prepare(
      "SELECT b.id FROM books b JOIN subjects s ON s.id = b.subject_id WHERE s.name = ?",
    ).get(target) as { id: number };
    db.prepare("DELETE FROM questions WHERE book_id = ?").run(book.id);
    db.prepare("DELETE FROM book_items WHERE book_id = ?").run(book.id);
    db.prepare("UPDATE books SET title = ? WHERE id = ?").run(displayTitle, book.id);
    const bookFiles = db.prepare("SELECT id, r2_key FROM book_files WHERE book_id = ? ORDER BY id")
      .all(book.id) as Array<{ id: number; r2_key: string }>;
    const prefix = `corpus/${token(entry.id, 24)}/${token(target, 16)}`;
    const problemR2Key = `${prefix}/problem.pdf`;
    const solutionR2Key = `${prefix}/solution.pdf`;
    const problemFile = bookFiles[0];
    const solutionFile = bookFiles[1];
    db.prepare("UPDATE book_files SET r2_key = ?, content_hash = ?, page_count = ?, status = 'ready' WHERE id = ?")
      .run(problemR2Key, downloads.problem.sha256, downloads.problem.pageCount, problemFile.id);
    db.prepare("UPDATE book_files SET r2_key = ?, content_hash = ?, page_count = ?, status = 'ready' WHERE id = ?")
      .run(solutionR2Key, downloads.solution.sha256, downloads.solution.pageCount, solutionFile.id);
    mkdirSync(join(files.dataDir, "files", prefix), { recursive: true });
    writeFileSync(join(files.dataDir, "files", problemR2Key), problemBytes);
    writeFileSync(join(files.dataDir, "files", solutionR2Key), solutionBytes);
    for (const value of rows) {
      const number = String(Number(value.question.number));
      const solution = solutionByNumber.get(number)!;
      const storedAnswer = resolveOfficialAnswer(value.question as any, solution.answer).storedAnswer;
      db.prepare(
        `INSERT INTO questions
         (id, subject_id, source, qtype, question, choices, answer, explanation, difficulty,
          book_id, book_number, printed_number, src_file_id, src_page)
         VALUES (?, (SELECT id FROM subjects WHERE name = ?), 'uploaded', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ++nextQuestionId,
        target,
        value.question.qtype,
        value.question.question,
        value.question.choices ? JSON.stringify(value.question.choices) : null,
        storedAnswer,
        solution.explanation,
        value.question.difficulty,
        book.id,
        number,
        number,
        problemFile.id,
        value.question.page,
      );
      db.prepare(
        "INSERT INTO book_items (id, book_id, file_id, category, number, answer, content, page) " +
        "VALUES (?, ?, ?, '문제', ?, ?, ?, ?)",
      ).run(++nextItemId, book.id, problemFile.id, number, storedAnswer, value.question.question, value.question.page);
      db.prepare(
        "INSERT INTO book_items (id, book_id, file_id, category, number, answer, content, page) " +
        "VALUES (?, ?, ?, '해설', ?, ?, ?, ?)",
      ).run(++nextItemId, book.id, solutionFile.id, number, storedAnswer, solution.explanation, solution.page);
    }
    targetBooks.push({
      subject: target,
      examTitle: entry.examTitle,
      bookTitle: displayTitle,
      expectedQuestionCount: rows.length,
      problemR2Key,
      solutionR2Key,
    });
  }
  db.close();
  const receipt = {
    version: 2,
    status: "committed",
    entryId: entry.id,
    examTitle: entry.examTitle,
    rawTitle: entry.rawTitle,
    bookTitle: displayTitle,
    sourceRecordYear: entry.sourceRecordYear,
    variant: entry.variant,
    form: entry.form,
    sourceSubject: entry.subject,
    grade: entry.grade,
    rulesDigest: DIGEST,
    sourceQuestionCount: classified.length,
    acceptedQuestionCount: accepted.length,
    rejectedQuestionCount: classified.filter((value) => value.classification.decision === "reject").length,
    reviewQuestionCount: 0,
    problemHash: downloads.problem.sha256,
    solutionHash: downloads.solution.sha256,
    problemChunking: { pages: 20, stride: 18, overlap: 2 },
    targetBooks,
  };
  const receiptHash = writeEvidence(join(stateDir, "receipt.json"), receipt);
  const attestationBasis = {
    entryId: entry.id,
    problemHash: downloads.problem.sha256,
    solutionHash: downloads.solution.sha256,
    classifierVersion: 5,
    rulesDigest: DIGEST,
    transcriptionGateVersion: 2,
    transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
    solutionFidelityVersion: 1,
    solutionFidelityPromptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    problemTerminalFidelityVersion: 2,
    problemTerminalScopePromptDigest: PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST,
    receipt: { path: "receipt.json", sha256: receiptHash },
    answerAudit: {
      path: auditRelativePath,
      sha256: auditHash,
      effectiveCorpusHash: failedFidelity.effectiveProblemCorpusHash,
      effectiveSolutionCorpusHash: solutionAudit.effectiveSolutionCorpusHash,
    },
    repairs: [],
    solutionFidelityCheckpoints: solutionAudit.checkpoints,
    solutionFidelityItems: solutionAudit.items,
    solutionRepairs: solutionAudit.repairs,
    problemTerminalFidelityCheckpoints: [terminalPointer],
    problemTerminalFidelityItems: terminal.items,
  };
  const attestationDigest = canonicalEvidenceHash(attestationBasis);
  for (const name of readdirSync(join(stateDir, "answer-attestation"))) {
    rmSync(join(stateDir, "answer-attestation", name));
  }
  writeEvidence(join(stateDir, "answer-attestation", `v5-${attestationDigest}.json`), {
    version: 5,
    attestationDigest,
    ...attestationBasis,
  });
  return {
    childArtifact: join(stateDir, childRelativePath),
    evidenceArtifact: join(stateDir, evidenceRelativePath),
    failedFidelityArtifact: join(stateDir, failedFidelityRelativePath),
  };
}

function rewriteSolutionRepairAuthority(
  files: ReturnType<typeof fixture>,
  mutateRepair: (repair: Record<string, any>) => void,
): void {
  rewriteSolutionAuditAuthority(files, (audit) => mutateRepair(audit.solutionRepairs[0]));
}

function rewriteBaselineFidelityAuthority(
  files: ReturnType<typeof fixture>,
  id: keyof ReturnType<typeof fixture>["stateDirs"],
  mutateCheckpoint: (checkpoint: Record<string, any>) => void,
  mutateAudit: (audit: Record<string, any>) => void = () => undefined,
): void {
  const stateDir = files.stateDirs[id];
  const attestationDir = join(stateDir, "answer-attestation");
  const attestationName = readdirSync(attestationDir).find((name) => /^v2-/u.test(name))!;
  const attestation = JSON.parse(readFileSync(join(attestationDir, attestationName), "utf8"));
  const audit = JSON.parse(readFileSync(join(stateDir, attestation.answerAudit.path), "utf8"));
  const checkpointEvidence = audit.solutionFidelityCheckpoints[0];
  const checkpoint = JSON.parse(readFileSync(join(stateDir, checkpointEvidence.path), "utf8"));
  mutateCheckpoint(checkpoint);
  const checkpointHash = writeEvidence(join(stateDir, checkpointEvidence.path), checkpoint);
  checkpointEvidence.sha256 = checkpointHash;
  for (const item of audit.solutionFidelityItems) {
    if (item.fidelityArtifact.path === checkpointEvidence.path) item.fidelityArtifact.sha256 = checkpointHash;
  }
  mutateAudit(audit);

  const { version: _auditVersion, auditDigest: _oldAuditDigest, ...auditBasis } = audit;
  const nextAuditDigest = canonicalEvidenceHash(auditBasis);
  const nextAuditPath = `answer-audit/v2-${nextAuditDigest}.json`;
  for (const name of readdirSync(join(stateDir, "answer-audit"))) {
    rmSync(join(stateDir, "answer-audit", name));
  }
  const nextAuditHash = writeEvidence(join(stateDir, nextAuditPath), {
    version: 2,
    auditDigest: nextAuditDigest,
    ...auditBasis,
  });

  const { version: _attestationVersion, attestationDigest: _oldAttestationDigest, ...attestationBasis } = attestation;
  attestationBasis.answerAudit = {
    path: nextAuditPath,
    sha256: nextAuditHash,
    effectiveCorpusHash: audit.effectiveCorpusHash,
    effectiveSolutionCorpusHash: audit.effectiveSolutionCorpusHash,
  };
  attestationBasis.solutionFidelityCheckpoints = audit.solutionFidelityCheckpoints;
  attestationBasis.solutionFidelityItems = audit.solutionFidelityItems;
  attestationBasis.solutionRepairs = audit.solutionRepairs;
  const nextAttestationDigest = canonicalEvidenceHash(attestationBasis);
  for (const name of readdirSync(attestationDir)) rmSync(join(attestationDir, name));
  writeEvidence(join(attestationDir, `v2-${nextAttestationDigest}.json`), {
    version: 2,
    attestationDigest: nextAttestationDigest,
    ...attestationBasis,
  });
}

function rewriteProblemRepairAuthority(
  files: ReturnType<typeof fixture>,
  mutateRepair: (repair: Record<string, any>) => void,
): void {
  const stateDir = files.stateDirs.math;
  const attestationDir = join(stateDir, "answer-attestation");
  const attestationName = readdirSync(attestationDir).find((name) => /^v2-/u.test(name))!;
  const attestation = JSON.parse(readFileSync(join(attestationDir, attestationName), "utf8"));
  const audit = JSON.parse(readFileSync(join(stateDir, attestation.answerAudit.path), "utf8"));
  mutateRepair(audit.repairs[0]);
  const { version: _auditVersion, auditDigest: _oldAuditDigest, ...auditBasis } = audit;
  const auditDigest = canonicalEvidenceHash(auditBasis);
  const auditPath = `answer-audit/v2-${auditDigest}.json`;
  for (const name of readdirSync(join(stateDir, "answer-audit"))) rmSync(join(stateDir, "answer-audit", name));
  const auditHash = writeEvidence(join(stateDir, auditPath), { version: 2, auditDigest, ...auditBasis });

  const { version: _attestationVersion, attestationDigest: _oldAttestationDigest, ...attestationBasis } = attestation;
  attestationBasis.answerAudit = {
    path: auditPath,
    sha256: auditHash,
    effectiveCorpusHash: audit.effectiveCorpusHash,
    effectiveSolutionCorpusHash: audit.effectiveSolutionCorpusHash,
  };
  attestationBasis.repairs = audit.repairs;
  const attestationDigest = canonicalEvidenceHash(attestationBasis);
  for (const name of readdirSync(attestationDir)) rmSync(join(attestationDir, name));
  writeEvidence(join(attestationDir, `v2-${attestationDigest}.json`), {
    version: 2,
    attestationDigest,
    ...attestationBasis,
  });
}

describe("exam corpus verifier", () => {
  it("keeps the exact existing-corpus migration allowlist aligned with the importer", () => {
    expect(existingCorpusMigrationAllowlistFingerprint())
      .toBe("0abbd09ef538608e0fab27420f07281d7d29a8c88fff6a7148ce28222561a98f");
    expect(existingCorpusMigrationAllowlistFingerprint())
      .toBe(canonicalEvidenceHash(EXISTING_CORPUS_MIGRATION_ALLOWLIST));
    expect(EXISTING_CORPUS_MIGRATION_ALLOWLIST.map((spec) => spec.entryId)).toEqual([
      "ebsi:5695028",
      "ebsi:5734412",
      "ebsi:5696440",
      "ebsi:5854175",
    ]);
    expect(EXISTING_CORPUS_MIGRATION_ALLOWLIST.slice(1).every((spec) =>
      spec.newKeys.length === 0 && spec.newQuestions.length === 0)).toBe(true);
    expect(EXISTING_CORPUS_MIGRATION_ALLOWLIST.some((spec) => spec.entryId === "ebsi:5656592"))
      .toBe(false);
  });

  it("verifies one complete migration chain while tolerating post-import study state", async () => {
    const files = await migratedVerifierFixture();
    const verify = () => verifyExamCorpus({
      manifestPath: files.manifestPath,
      dbPath: files.dbPath,
      dataDir: files.dataDir,
    });
    try {
      const initial = verify();
      expect(initial, JSON.stringify(initial.failures, null, 2))
        .toMatchObject({ ok: true, failureCount: 0, questions: { expected: 14, actual: 14 } });

      let db = new Database(files.dbPath);
      try {
        const q26 = db.prepare(
          "SELECT id FROM questions WHERE book_id = 101 AND printed_number = '26'",
        ).get() as { id: number };
        db.prepare(
          "UPDATE questions SET correct_count = 3, wrong_count = 2, from_wrong_note = 1 WHERE id = ?",
        ).run(q26.id);
        db.prepare(
          "INSERT INTO question_attempts (question_id, attempt_id, correct) VALUES (?, 'verify-migration', 1)",
        ).run(q26.id);
        db.prepare(
          "UPDATE book_files SET progress = 88, retry_chunk_count = 3, answer_key_pages = '[2]', "
          + "answer_key_scan_complete = 1 WHERE id = 148",
        ).run();
        db.prepare(
          "INSERT INTO materials (id, subject_id, kind, title, book_id) VALUES (999999, 1, 'pdf', 'post-use', 100)",
        ).run();
        db.prepare(
          "INSERT INTO material_extraction_chunks (material_id, chunk_index, page_from, page_to, content) "
          + "VALUES (999999, 0, 1, 1, 'post-use')",
        ).run();
      } finally {
        db.close();
      }
      expect(verify()).toMatchObject({ ok: true, failureCount: 0 });

      for (const directory of ["receipt-history", "migration-plans", "migration-commits"]) {
        writeFileSync(join(files.stateDir, directory, `.residue-${directory}.tmp`), "incomplete");
      }
      writeFileSync(join(files.dataDir, "backups", ".migration-residue.tmp"), "incomplete");
      expect(verify()).toMatchObject({ ok: true, failureCount: 0 });

      const planBytes = readFileSync(files.planPath);
      const tamperedPlan = structuredClone(files.plan);
      tamperedPlan.identity.problemHash = "f".repeat(64);
      writeEvidence(files.planPath, tamperedPlan);
      expect(verify().failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "MIGRATION_INVALID" }),
      ]));
      writeFileSync(files.planPath, planBytes);

      const historyPath = join(files.stateDir, files.plan.identity.receiptHistory.path);
      const historyBytes = readFileSync(historyPath);
      const tamperedHistory = JSON.parse(historyBytes.toString());
      tamperedHistory.entryId = "ebsi:tampered";
      writeEvidence(historyPath, tamperedHistory);
      expect(verify().failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "MIGRATION_INVALID" }),
      ]));
      writeFileSync(historyPath, historyBytes);

      const commitPath = join(
        files.stateDir,
        "migration-commits",
        `v1-${files.plan.basisDigest}.json`,
      );
      const commitBytes = readFileSync(commitPath);
      rmSync(commitPath);
      expect(verify().failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "MIGRATION_INVALID" }),
      ]));
      writeFileSync(commitPath, commitBytes);

      const backupPath = join(files.dataDir, files.plan.backup.path);
      const backupBytes = readFileSync(backupPath);
      writeFileSync(backupPath, "tampered backup");
      expect(verify().failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "MIGRATION_INVALID" }),
      ]));
      writeFileSync(backupPath, backupBytes);

      const orphanCommit = join(files.stateDir, "migration-commits", `v1-${"e".repeat(64)}.json`);
      writeEvidence(orphanCommit, { version: 1, orphan: true });
      expect(verify().failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "MIGRATION_INVALID" }),
      ]));
      rmSync(orphanCommit);

      const orphanBackup = join(files.dataDir, "backups", `exam-corpus-migration-v1-${"e".repeat(64)}.db`);
      writeFileSync(orphanBackup, "orphan");
      expect(verify().failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "MIGRATION_INVALID" }),
      ]));
      rmSync(orphanBackup);

      db = new Database(files.dbPath);
      try {
        db.prepare("UPDATE questions SET question = 'stable field tampered' WHERE id = 3528").run();
      } finally {
        db.close();
      }
      expect(verify().failures).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "MIGRATION_INVALID",
          message: expect.stringContaining("stable projection"),
        }),
      ]));
    } finally {
      rmSync(files.root, { recursive: true, force: true });
    }
  }, 120_000);

  it("rejects migration sidecars without a migration receipt envelope", () => {
    const files = fixture();
    try {
      writeEvidence(
        join(files.stateDirs.math, "migration-plans", `v1-${"d".repeat(64)}.json`),
        { version: 1, orphan: true },
      );
      expect(verifyExamCorpus({
        manifestPath: files.manifestPath,
        dbPath: files.dbPath,
        dataDir: files.dataDir,
      }).failures).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "MIGRATION_INVALID",
          entryId: "ebsi:math",
          message: expect.stringContaining("without a migration receipt"),
        }),
      ]));
    } finally {
      rmSync(files.root, { recursive: true, force: true });
    }
  });

  it("uses localeCompare order for multi-digit page question keys", () => {
    const keys = ["10:25", "2:6", "1:1"];
    expect([...keys].sort(compareCorpusQuestionKeys)).toEqual(["1:1", "10:25", "2:6"]);
    expect([...keys].sort()).toEqual(["10:25", "1:1", "2:6"]);
  });

  it("independently maps official MCQ values, fractions, and markers to DB answers", () => {
    expect(canonicalEvidenceHash({ b: 1, a: ["x", null] }))
      .toBe("2dccb31ca7d4b9dc00ebe9e1b2fca5314ca2563469fbf6ba1c69752939768835");
    const mcq = (choices: string[]) => ({ qtype: "mcq", choices, printedNumber: "1" });
    expect(officialAnswerForDb(mcq(["① 6", "② 9", "③ 12", "④ 15", "⑤ 18"]), "18")).toBe("⑤ 18");
    expect(officialAnswerForDb(mcq(["① $5$", "② $6$", "③ $7$", "④ $8$", "⑤ $9$"]), "8")).toBe("④ $8$");
    expect(officialAnswerForDb(
      mcq(["① $\\frac76$", "② $\\frac43$", "③ $\\frac32$", "④ $\\frac53$", "⑤ $\\frac{11}{6}$"]),
      "$\\dfrac{4}{3}$",
    )).toBe("② $\\frac43$");
    expect(officialAnswerForDb(mcq(["① 5", "② 0.5"]), "0.5")).toBe("② 0.5");
    expect(() => officialAnswerForDb(mcq(["① 5", "② 7"]), "0.5"))
      .toThrow("cannot resolve to choices");
    expect(officialAnswerForDb(
      mcq([
        "① $\\frac{7}{6}\\pi$",
        "② $\\frac{4}{3}\\pi$",
        "③ $\\frac{3}{2}\\pi$",
        "④ $\\frac{5}{3}\\pi$",
        "⑤ $\\frac{11}{6}\\pi$",
      ]),
      "\\(\\frac{7\\pi}{6}\\)",
    )).toBe("① $\\frac{7}{6}\\pi$");
    expect(officialAnswerForDb(mcq(["① 6", "② 9", "③ 12", "④ 15", "⑤ 18"]), "⑤")).toBe("⑤");
  });

  it("verifies six targets, official evidence, hashes, counts, and stays read-only", () => {
    const files = fixture();
    const legacySchema2Path = join(files.stateDirs.math, "entry.json");
    const legacySchema2 = JSON.parse(readFileSync(legacySchema2Path, "utf8"));
    legacySchema2.schemaVersion = 2;
    writeJson(legacySchema2Path, legacySchema2);
    const modifiedBefore = statSync(files.dbPath).mtimeMs;
    const report = verifyExamCorpus(files);

    expect(report.ok).toBe(true);
    expect(report.manifest).toEqual({ expected: 4, terminal: 4, committed: 4, filtered: 0, review: 0 });
    expect(report.questions).toEqual({ expected: 6, actual: 6 });
    expect(Object.values(report.targets)).toEqual(Array.from({ length: 6 }, () => ({ expected: 1, actual: 1 })));
    expect(statSync(files.dbPath).mtimeMs).toBe(modifiedBefore);
  });

  it("prefers one current v3 attestation and verifies all-source terminal fidelity", () => {
    const files = fixture();
    const artifacts = upgradeEntryToV3(files);
    const report = verifyExamCorpus(files);
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true });

    const tamperedFiles = fixture();
    const tamperedArtifacts = upgradeEntryToV3(tamperedFiles);
    const terminal = JSON.parse(readFileSync(tamperedArtifacts.terminalArtifact, "utf8"));
    terminal.items[0].status = "mismatch";
    terminal.items[0].evidence = "tampered terminal decision";
    writeJson(tamperedArtifacts.terminalArtifact, terminal);
    const tampered = verifyExamCorpus(tamperedFiles);
    expect(tampered.ok).toBe(false);
    expect(tampered.failures.some((failure) => failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const duplicateFiles = fixture();
    upgradeEntryToV3(duplicateFiles);
    rewriteCurrentV3Authority(duplicateFiles, (audit) => {
      audit.problemTerminalFidelityItems.push(structuredClone(audit.problemTerminalFidelityItems[0]));
    });
    const duplicate = verifyExamCorpus(duplicateFiles);
    expect(duplicate.ok).toBe(false);
    expect(duplicate.failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID"
      && failure.message.includes("cover every source key exactly once"))).toBe(true);
    expect(artifacts.auditArtifact).toContain("answer-audit/v3-");
    expect(artifacts.attestationArtifact).toContain("answer-attestation/v3-");
  });

  it("accepts only terminal-v2 independent reject authority and high-confidence accepted scope agreement", () => {
    const authorizedFiles = fixture();
    const authorizedArtifacts = upgradeEntryToV3(authorizedFiles, "math", { terminalScope: "authorized-reject" });
    const authorized = verifyExamCorpus(authorizedFiles);
    expect(authorized, JSON.stringify(authorized.failures)).toMatchObject({ ok: true });
    expect(authorizedArtifacts.auditArtifact).toContain("answer-audit/v4-");
    expect(authorizedArtifacts.attestationArtifact).toContain("answer-attestation/v4-");
    expect(authorizedArtifacts.terminalArtifact).toContain("problem-terminal-fidelity/v2-");

    for (const repairOptions of [
      { batchRepair: true, terminalScope: "authorized-reject" as const },
      { terminalRevision: true, terminalScope: "authorized-reject" as const },
    ]) {
      const files = fixture();
      upgradeEntryToV3(files, "math", repairOptions);
      const report = verifyExamCorpus(files);
      expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true });
    }

    for (const terminalScope of ["scope-accept", "terminal-exact", "low-confidence", "accepted-scope-reject"] as const) {
      const files = fixture();
      upgradeEntryToV3(files, "math", { terminalScope });
      const report = verifyExamCorpus(files);
      expect(report.ok, terminalScope).toBe(false);
      expect(report.failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID"
        && failure.message.includes("exact-or-independent-reject policy")), terminalScope).toBe(true);
    }
  });

  it("uses semantic v5 triple-hash authority while preserving read-only v4 terminals", () => {
    const legacyFiles = fixture();
    const legacyArtifacts = upgradeEntryToV3(legacyFiles, "korean", {
      terminalScope: "authorized-reject",
    });
    const legacy = verifyExamCorpus(legacyFiles);
    expect(legacy, JSON.stringify(legacy.failures)).toMatchObject({ ok: true });
    expect(legacyArtifacts.auditArtifact).toContain("answer-audit/v4-");
    const legacyAudit = JSON.parse(readFileSync(legacyArtifacts.auditArtifact, "utf8"));
    expect(legacyAudit.semanticCheckpoint.path)
      .toBe(`semantic-choice-checks/v4-${legacyAudit.semanticCheckpoint.inputHash}.json`);

    const currentFiles = fixture();
    const currentArtifacts = upgradeEntryToV3(currentFiles, "korean", {
      terminalScope: "authorized-reject",
      answerV5: true,
    });
    const current = verifyExamCorpus(currentFiles);
    expect(current, JSON.stringify(current.failures)).toMatchObject({ ok: true });
    expect(currentArtifacts.auditArtifact).toContain("answer-audit/v5-");
    expect(currentArtifacts.attestationArtifact).toContain("answer-attestation/v5-");
    const audit = JSON.parse(readFileSync(currentArtifacts.auditArtifact, "utf8"));
    expect(audit.semanticChoiceVersion).toBe(5);
    expect(audit.semanticCheckpoint.path).toBe(
      `semantic-choice-checks/v5-${audit.effectiveCorpusHash}-` +
      `${audit.effectiveSolutionCorpusHash}-${audit.semanticCheckpoint.inputHash}.json`,
    );
    expect(audit.semanticCheckpoint.effectiveCorpusHash).toBe(audit.effectiveCorpusHash);

    const tamperedFiles = fixture();
    const tamperedArtifacts = upgradeEntryToV3(tamperedFiles, "korean", {
      terminalScope: "authorized-reject",
      answerV5: true,
    });
    const tamperedAudit = JSON.parse(readFileSync(tamperedArtifacts.auditArtifact, "utf8"));
    const semanticPath = join(tamperedFiles.stateDirs.korean, tamperedAudit.semanticCheckpoint.path);
    const semantic = JSON.parse(readFileSync(semanticPath, "utf8"));
    semantic.effectiveCorpusHash = "0".repeat(64);
    writeJson(semanticPath, semantic);
    expect(verifyExamCorpus(tamperedFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const partialFiles = fixture();
    upgradeEntryToV3(partialFiles, "math", { terminalScope: "authorized-reject" });
    writeJson(join(
      partialFiles.stateDirs.math,
      "semantic-choice-checks",
      `v5-${"1".repeat(64)}-${"2".repeat(64)}-${"3".repeat(64)}.json`,
    ), {});
    const partial = verifyExamCorpus(partialFiles);
    expect(partial.ok).toBe(false);
    expect(partial.failures.some((failure) => failure.code === "ANSWER_ATTESTATION_MISSING")).toBe(true);
  });

  it("reconstructs one shared v3 problem/classification repair batch", () => {
    const files = fixture();
    const artifacts = upgradeEntryToV3(files, "math", { batchRepair: true });
    const report = verifyExamCorpus(files);
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true });
    expect(artifacts.problemBatchArtifact).toContain("problem-repair-batches/v1-");
    expect(artifacts.classificationBatchArtifact).toContain("classification-repair-batches/v1-");

    const tamperedFiles = fixture();
    const tamperedArtifacts = upgradeEntryToV3(tamperedFiles, "math", { batchRepair: true });
    const batch = JSON.parse(readFileSync(tamperedArtifacts.problemBatchArtifact!, "utf8"));
    batch.items[0].question = "tampered shared output";
    writeJson(tamperedArtifacts.problemBatchArtifact!, batch);
    const tampered = verifyExamCorpus(tamperedFiles);
    expect(tampered.ok).toBe(false);
    expect(tampered.failures.some((failure) => failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const orphanFiles = fixture();
    upgradeEntryToV3(orphanFiles, "math", { batchRepair: true });
    rewriteCurrentV3Authority(orphanFiles, (audit) => audit.repairs.pop());
    const orphan = verifyExamCorpus(orphanFiles);
    expect(orphan.ok).toBe(false);
    expect(orphan.failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("member set"))).toBe(true);

    const duplicateFiles = fixture();
    upgradeEntryToV3(duplicateFiles, "math", { batchRepair: true });
    rewriteCurrentV3Authority(duplicateFiles, (audit) => audit.repairs.push(structuredClone(audit.repairs[0])));
    const duplicate = verifyExamCorpus(duplicateFiles);
    expect(duplicate.ok).toBe(false);
    expect(duplicate.failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("duplicate declared repair"))).toBe(true);
  });

  it("reconstructs cross-page v2 repair batches without mixing legacy v1 authority", () => {
    const files = fixture();
    const artifacts = upgradeEntryToV3(files, "math", { crossPageBatchRepair: true });
    const checkpoint = JSON.parse(readFileSync(artifacts.problemBatchArtifact!, "utf8"));
    expect(artifacts.problemBatchArtifact).toContain("problem-repair-batches/v2-0001-0002-");
    expect(checkpoint.members.map((member: { sourcePage: number }) => member.sourcePage)).toEqual([1, 2]);
    const report = verifyExamCorpus(files);
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true });

    const tamperedFiles = fixture();
    const tamperedArtifacts = upgradeEntryToV3(tamperedFiles, "math", { crossPageBatchRepair: true });
    const tampered = JSON.parse(readFileSync(tamperedArtifacts.problemBatchArtifact!, "utf8"));
    tampered.members[0].baseTranscriptionEvidenceHash = "0".repeat(64);
    writeJson(tamperedArtifacts.problemBatchArtifact!, tampered);
    expect(verifyExamCorpus(tamperedFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const mixedFiles = fixture();
    upgradeEntryToV3(mixedFiles, "math", { crossPageBatchRepair: true });
    writeJson(join(
      mixedFiles.stateDirs.math,
      "problem-repair-batches",
      `v1-0001-0002-0001-${"0".repeat(64)}.json`,
    ), {});
    const mixed = verifyExamCorpus(mixedFiles);
    expect(mixed.failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("cannot share a context"))).toBe(true);

    const conflictingFiles = fixture();
    upgradeEntryToV3(conflictingFiles, "math", { crossPageBatchRepair: true });
    rewriteCurrentV3Authority(conflictingFiles, (audit) => {
      audit.repairs[1].problemArtifact.sha256 = "f".repeat(64);
    });
    const conflicting = verifyExamCorpus(conflictingFiles);
    expect(conflicting.failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("conflicting whole-file hashes"))).toBe(true);

    const malformedFiles = fixture();
    upgradeEntryToV3(malformedFiles, "math", { crossPageBatchRepair: true });
    writeJson(join(malformedFiles.stateDirs.math, "problem-repair-batches", "v2-0001-0002-bad.json"), {});
    const malformed = verifyExamCorpus(malformedFiles);
    expect(malformed.failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("malformed"))).toBe(true);

    const orphanFiles = fixture();
    upgradeEntryToV3(orphanFiles, "math", { crossPageBatchRepair: true });
    writeJson(join(
      orphanFiles.stateDirs.math,
      "problem-repair-batches",
      `v2-0001-0002-${"1".repeat(64)}.json`,
    ), {});
    const orphan = verifyExamCorpus(orphanFiles);
    expect(orphan.failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);
  });

  it.each(PERSISTED_REGROUPING_CASES)(
    "selects the unique terminal-backed persisted v2 repair cover for $entryId",
    (testCase) => {
      if (!existsSync(join(testCase.stateDir, "problem.pdf"))) return;
      const selected = verifyPersistedProblemRepairOverlapForTest(
        testCase.stateDir,
        testCase.auditPath ?? undefined,
      );
      expect(selected.effectiveCorpusHash).toBe(testCase.effectiveCorpusHash);
      expect(selected.selectedClassificationPaths).toEqual(testCase.selectedClassificationPaths);
    },
  );

  it("verifies a full current audit with one terminal-backed cover and retained alternate history", () => {
    const files = fixture();
    const artifacts = upgradeEntryToV3(files, "math", {
      crossPageBatchRepair: true,
      terminalScope: "authorized-reject",
      answerV5: true,
    });
    const alternate = installSyntheticRegroupingHistory(
      files.stateDirs.math,
      artifacts.problemBatchArtifact!,
      artifacts.classificationBatchArtifact!,
    );
    expect(alternate).toHaveLength(2);
    const report = verifyExamCorpus(files);
    expect(report, JSON.stringify(report.failures, null, 2)).toMatchObject({ ok: true, failureCount: 0 });
    expect(alternate.every((value) => existsSync(join(files.stateDirs.math, value.problemArtifact.path))))
      .toBe(true);

    const tamperedFiles = fixture();
    const tamperedArtifacts = upgradeEntryToV3(tamperedFiles, "math", {
      crossPageBatchRepair: true,
      terminalScope: "authorized-reject",
      answerV5: true,
    });
    const tamperedAlternate = installSyntheticRegroupingHistory(
      tamperedFiles.stateDirs.math,
      tamperedArtifacts.problemBatchArtifact!,
      tamperedArtifacts.classificationBatchArtifact!,
    );
    const dormantPath = join(tamperedFiles.stateDirs.math, tamperedAlternate[0].problemArtifact.path);
    const dormant = JSON.parse(readFileSync(dormantPath, "utf8"));
    dormant.items[0].question += " tampered";
    writeEvidence(dormantPath, dormant);
    expect(verifyExamCorpus(tamperedFiles).failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ANSWER_AUDIT_INVALID" }),
    ]));

    const alternateAuditFiles = fixture();
    const alternateAuditArtifacts = upgradeEntryToV3(alternateAuditFiles, "math", {
      crossPageBatchRepair: true,
      terminalScope: "authorized-reject",
      answerV5: true,
    });
    const alternateAuthority = installSyntheticRegroupingHistory(
      alternateAuditFiles.stateDirs.math,
      alternateAuditArtifacts.problemBatchArtifact!,
      alternateAuditArtifacts.classificationBatchArtifact!,
    );
    rewriteCurrentV3Authority(alternateAuditFiles, (audit) => {
      const replacement = alternateAuthority[0];
      const repair = audit.repairs.find((value: Record<string, any>) => value.key === replacement.key)!;
      repair.problemArtifact = replacement.problemArtifact;
      repair.problemArtifactItemHash = replacement.problemArtifactItemHash;
      repair.classificationArtifact = {
        ...replacement.classificationArtifact,
        rulesDigest: DIGEST,
        transcriptionGateVersion: 2,
        transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
      };
      repair.classificationArtifactItemHash = replacement.classificationArtifactItemHash;
      repair.effectiveQuestionHash = replacement.effectiveQuestionHash;
      repair.effectiveClassificationHash = replacement.effectiveClassificationHash;
    });
    expect(verifyExamCorpus(alternateAuditFiles).failures).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "ANSWER_AUDIT_INVALID",
        message: expect.stringContaining("terminal-backed repair graph"),
      }),
    ]));
  });

  it.each([
    "tampered-terminal",
    "terminal-symlink",
    "no-terminal",
    "ambiguous-terminal",
    "unreferenced-parent",
    "orphan-junk",
    "graph-without-cover",
    "audit-selects-alternate",
  ] as const)("fails closed for persisted regrouping %s", (mode) => {
    const testCase = PERSISTED_REGROUPING_CASES[0];
    if (!existsSync(join(testCase.stateDir, "problem.pdf"))) return;
    const root = mkdtempSync(join(tmpdir(), `verify-persisted-regrouping-${mode}-`));
    cpSync(testCase.stateDir, root, { recursive: true });
    try {
      const terminalDirectory = join(root, "problem-terminal-fidelity");
      const terminalName = readdirSync(terminalDirectory)
        .find((name) => name.includes(testCase.effectiveCorpusHash))!;
      let auditPath: string | undefined;
      if (mode === "tampered-terminal") {
        const path = join(terminalDirectory, terminalName);
        const checkpoint = JSON.parse(readFileSync(path, "utf8"));
        checkpoint.unexpected = true;
        writeEvidence(path, checkpoint);
      } else if (mode === "terminal-symlink") {
        const path = join(terminalDirectory, terminalName);
        const copy = join(root, "terminal-authority-copy.json");
        cpSync(path, copy);
        rmSync(path);
        symlinkSync(copy, path);
      } else if (mode === "no-terminal") {
        rmSync(join(terminalDirectory, terminalName));
      } else if (mode === "ambiguous-terminal") {
        const alternate = regroupingCorpusFromGraphs(root, ["5f3c70fa", "65ec252e"]);
        addRegroupingTerminal(root, alternate, testCase.effectiveCorpusHash);
      } else if (mode === "unreferenced-parent") {
        const directory = join(root, "classification-repair-batches");
        const name = readdirSync(directory).find((candidate) => candidate.includes("5f3c70fa"))!;
        rmSync(join(directory, name));
      } else if (mode === "orphan-junk") {
        writeFileSync(join(root, "classification-repair-batches", "undeclared.txt"), "orphan\n");
      } else if (mode === "graph-without-cover") {
        const directory = join(root, "classification-repair-batches");
        const sourceName = readdirSync(directory).find((candidate) => candidate.includes("45da6057"))!;
        const checkpoint = JSON.parse(readFileSync(join(directory, sourceName), "utf8"));
        const keys = new Set(["1:2", "10:25"]);
        checkpoint.members = checkpoint.members.filter((member: Record<string, any>) => keys.has(member.key));
        checkpoint.items = checkpoint.items.filter((item: Record<string, any>) => keys.has(item.key));
        checkpoint.overlayDigest = canonicalEvidenceHash(checkpoint.members);
        const name = `v1-0001-0012-${checkpoint.overlayDigest}-${DIGEST}.json`;
        writeEvidence(join(directory, name), checkpoint);
      } else {
        const sourceAudit = JSON.parse(readFileSync(join(root, testCase.auditPath!), "utf8"));
        const repair = sourceAudit.repairs.find((value: Record<string, any>) => value.key === "10:25")!;
        const problemName = readdirSync(join(root, "problem-repair-batches"))
          .find((candidate) => candidate.includes("f6c1496a"))!;
        const problemPath = `problem-repair-batches/${problemName}`;
        const problem = JSON.parse(readFileSync(join(root, problemPath), "utf8"));
        const question = problem.items.find(
          (item: Record<string, any>) => regroupingQuestionKey(item) === "10:25",
        );
        const classificationName = readdirSync(join(root, "classification-repair-batches"))
          .find((candidate) => candidate.includes("5f3c70fa"))!;
        const classificationPath = `classification-repair-batches/${classificationName}`;
        const classification = JSON.parse(readFileSync(join(root, classificationPath), "utf8"));
        const decision = classification.items.find((item: Record<string, any>) => item.key === "10:25");
        repair.problemArtifact = { path: problemPath, sha256: hash(readFileSync(join(root, problemPath))) };
        repair.problemArtifactItemHash = canonicalEvidenceHash(question);
        repair.classificationArtifact = {
          path: classificationPath,
          sha256: hash(readFileSync(join(root, classificationPath))),
          rulesDigest: DIGEST,
          transcriptionGateVersion: 2,
          transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
        };
        repair.classificationArtifactItemHash = canonicalEvidenceHash(decision);
        repair.effectiveQuestionHash = canonicalEvidenceHash(question);
        repair.effectiveClassificationHash = canonicalEvidenceHash(decision);
        auditPath = "tampered-audit.json";
        writeEvidence(join(root, auditPath), sourceAudit);
      }
      expect(() => verifyPersistedProblemRepairOverlapForTest(root, auditPath)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconstructs one terminal-triggered shared problem revision generation", () => {
    const files = fixture();
    const artifacts = upgradeEntryToV3(files, "math", { terminalRevision: true });
    const report = verifyExamCorpus(files);
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true });
    expect(artifacts.problemRevisionArtifact).toContain("problem-revision-batches/v1-");
    expect(artifacts.classificationRevisionArtifact).toContain("classification-revision-batches/v1-");

    const staleFiles = fixture();
    const staleArtifacts = upgradeEntryToV3(staleFiles, "math", { terminalRevision: true });
    const revision = JSON.parse(readFileSync(staleArtifacts.problemRevisionArtifact!, "utf8"));
    revision.members[0].trigger.evidenceHash = "0".repeat(64);
    writeJson(staleArtifacts.problemRevisionArtifact!, revision);
    const stale = verifyExamCorpus(staleFiles);
    expect(stale.ok).toBe(false);
    expect(stale.failures.some((failure) => failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const classificationFiles = fixture();
    upgradeEntryToV3(classificationFiles, "math", { classificationRevision: true });
    const classificationRevision = verifyExamCorpus(classificationFiles);
    expect(classificationRevision, JSON.stringify(classificationRevision.failures)).toMatchObject({ ok: true });
  });

  it("reconstructs one final problem recovery and rejects tamper, stale, orphan, or repeated chains", () => {
    const files = fixture();
    const artifacts = upgradeEntryToV3(files, "math", {
      problemRecovery: true,
      terminalScope: "authorized-reject",
    });
    const report = verifyExamCorpus(files);
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true });
    expect(artifacts.problemRecoveryArtifact).toContain("problem-recoveries/v1-");
    expect(artifacts.classificationRecoveryArtifact).toContain("classification-recoveries/v1-");

    const tamperedFiles = fixture();
    const tamperedArtifacts = upgradeEntryToV3(tamperedFiles, "math", {
      problemRecovery: true,
      terminalScope: "authorized-reject",
    });
    const tampered = JSON.parse(readFileSync(tamperedArtifacts.problemRecoveryArtifact!, "utf8"));
    tampered.item.question = "tampered recovery output";
    writeJson(tamperedArtifacts.problemRecoveryArtifact!, tampered);
    expect(verifyExamCorpus(tamperedFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const staleFiles = fixture();
    upgradeEntryToV3(staleFiles, "math", { problemRecovery: true, terminalScope: "authorized-reject" });
    rewriteCurrentV3Authority(staleFiles, (audit) => {
      audit.repairs.find((repair: Record<string, any>) => repair.revision?.recovery)
        .revision.recovery.failedClassificationEvidenceHash = "0".repeat(64);
    });
    expect(verifyExamCorpus(staleFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const orphanFiles = fixture();
    upgradeEntryToV3(orphanFiles, "math", { problemRecovery: true, terminalScope: "authorized-reject" });
    writeJson(join(
      orphanFiles.stateDirs.math,
      "problem-recoveries",
      `v1-0001-0004-${"1".repeat(64)}.json`,
    ), {});
    expect(verifyExamCorpus(orphanFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("not declared"))).toBe(true);

    const repeatedFiles = fixture();
    upgradeEntryToV3(repeatedFiles, "math", { problemRecovery: true, terminalScope: "authorized-reject" });
    rewriteCurrentV3Authority(repeatedFiles, (audit) => {
      audit.repairs.find((repair: Record<string, any>) => repair.revision?.recovery)
        .revision.recovery.recovery = {};
    });
    expect(verifyExamCorpus(repeatedFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);
  });

  it("reconstructs one terminal-triggered v2 recovery and rejects stale trigger authority", () => {
    const files = fixture();
    const artifacts = upgradeEntryToV3(files, "math", {
      terminalRecovery: true,
      terminalScope: "authorized-reject",
    });
    const report = verifyExamCorpus(files);
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true });
    expect(artifacts.problemRecoveryArtifact).toContain("problem-recoveries/v2-");
    expect(artifacts.classificationRecoveryArtifact).toContain("classification-recoveries/v2-");

    const mixedFiles = fixture();
    upgradeEntryToV3(mixedFiles, "math", {
      mixedTerminalRecovery: true,
      terminalScope: "authorized-reject",
    });
    const mixed = verifyExamCorpus(mixedFiles);
    expect(mixed, JSON.stringify(mixed.failures)).toMatchObject({ ok: true });

    const tamperedFiles = fixture();
    const tamperedArtifacts = upgradeEntryToV3(tamperedFiles, "math", {
      terminalRecovery: true,
      terminalScope: "authorized-reject",
    });
    const tampered = JSON.parse(readFileSync(tamperedArtifacts.problemRecoveryArtifact!, "utf8"));
    tampered.basis.trigger.terminalItem.scopeEvidence = "tampered terminal source evidence";
    writeJson(tamperedArtifacts.problemRecoveryArtifact!, tampered);
    expect(verifyExamCorpus(tamperedFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const staleFiles = fixture();
    upgradeEntryToV3(staleFiles, "math", {
      terminalRecovery: true,
      terminalScope: "authorized-reject",
    });
    rewriteCurrentV3Authority(staleFiles, (audit) => {
      audit.repairs.find((repair: Record<string, any>) => repair.revision?.recovery?.trigger)
        .revision.recovery.trigger.preRecoveryEffectiveCorpusHash = "0".repeat(64);
    });
    expect(verifyExamCorpus(staleFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const orphanFiles = fixture();
    upgradeEntryToV3(orphanFiles, "math", {
      terminalRecovery: true,
      terminalScope: "authorized-reject",
    });
    writeJson(join(
      orphanFiles.stateDirs.math,
      "classification-recoveries",
      `v2-0001-0004-${"1".repeat(64)}-${DIGEST}.json`,
    ), {});
    expect(verifyExamCorpus(orphanFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("not declared"))).toBe(true);

    const overrideFiles = fixture();
    installRevisionScopeFixture(overrideFiles, REVISION_SCOPE_CASES[1]);
    rewriteCurrentV3Authority(overrideFiles, (audit) => {
      const repair = audit.repairs.find((value: Record<string, any>) =>
        value.revision?.scopeAdjudication);
      repair.revision.recovery = {};
    }, "math");
    expect(verifyExamCorpus(overrideFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const terminalFiles = fixture();
    installRevisionScopeFixture(terminalFiles, REVISION_SCOPE_CASES[0]);
    rewriteCurrentV3Authority(terminalFiles, (audit) => {
      const pointer = audit.problemTerminalFidelityCheckpoints[0];
      const checkpointPath = join(terminalFiles.stateDirs.science, pointer.path);
      const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
      const item = checkpoint.items.find((value: { key: string }) => value.key === "1:5");
      item.scopeDecision = "accept";
      item.scopeEvidence = "stale final scope output overrides the attested rejection";
      pointer.sha256 = writeEvidence(checkpointPath, checkpoint);
      Object.assign(audit.problemTerminalFidelityItems.find(
        (value: { key: string }) => value.key === "1:5",
      ), item);
    }, "science");
    expect(verifyExamCorpus(terminalFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("terminal problem fidelity"))).toBe(true);
  });

  it.skipIf(!existsSync(Q29_OFFICIAL_PROBLEM_PATH))(
  "reconstructs only allowlisted Q29 crop evidence and rejects tamper, orphan, stale parent, or a fifth authority",
  () => {
    const files = fixture();
    const artifacts = upgradeEntryToV3(files, "korean", {
      cropAdjudication: true,
      terminalScope: "authorized-reject",
      answerV5: true,
    });
    const modifiedBefore = statSync(files.dbPath).mtimeMs;
    const report = verifyExamCorpus(files);
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true });
    expect(statSync(files.dbPath).mtimeMs).toBe(modifiedBefore);
    expect(artifacts.auditArtifact).toContain("answer-audit/v5-");
    expect(artifacts.cropEvidenceArtifact).toContain("problem-crop-evidence/v1-0011-0029-");
    expect(artifacts.cropEvidencePdf).toContain("problem-crop-evidence/v1-0011-0029-");
    expect(artifacts.cropViewArtifacts).toHaveLength(4);
    expect(artifacts.problemCropAdjudicationArtifact).toContain("problem-crop-adjudications/v1-0011-0029-");
    expect(artifacts.classificationCropAdjudicationArtifact)
      .toContain("classification-crop-adjudications/v1-0011-0029-");
    const audit = JSON.parse(readFileSync(artifacts.auditArtifact, "utf8"));
    const cropRepair = audit.repairs.find((repair: Record<string, any>) =>
      repair.revision?.recovery?.adjudication);
    expect(cropRepair).toBeDefined();
    expect(cropRepair.revision.recovery.adjudication).toMatchObject({
      allowlistId: Q29_CROP_SPEC.allowlistId,
      key: Q29_CROP_SPEC.key,
      sourcePage: Q29_CROP_SPEC.sourcePage,
      sourceHash: Q29_CROP_SPEC.sourceHash,
      cropViews: Q29_CROP_SPEC.views.map((view) => ({
        sourcePage: view.sourcePage,
        label: view.label,
        rect: [...view.rect],
      })),
    });
    const terminal = JSON.parse(readFileSync(artifacts.terminalArtifact, "utf8"));
    const q29Input = terminal.inputs.find((input: { key: string }) => input.key === Q29_CROP_SPEC.key);
    expect(q29Input.question).toContain("‘p’와 ‘q’는");
    expect(terminal.items.find((item: { key: string }) => item.key === Q29_CROP_SPEC.key))
      .toMatchObject({ status: "exact" });
    writeFileSync(`${artifacts.cropEvidenceArtifact}.123.crash.tmp`, Buffer.from("interrupted immutable write"));
    expect(verifyExamCorpus(files), "regular .tmp residue must remain resume-compatible")
      .toMatchObject({ ok: true });

    const pngTamperFiles = fixture();
    const pngTamperArtifacts = upgradeEntryToV3(pngTamperFiles, "korean", {
      cropAdjudication: true,
      terminalScope: "authorized-reject",
      answerV5: true,
    });
    writeFileSync(pngTamperArtifacts.cropViewArtifacts![0], Buffer.from("not a png"));
    expect(verifyExamCorpus(pngTamperFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("hash mismatch"))).toBe(true);

    const pdfTamperFiles = fixture();
    const pdfTamperArtifacts = upgradeEntryToV3(pdfTamperFiles, "korean", {
      cropAdjudication: true,
      terminalScope: "authorized-reject",
      answerV5: true,
    });
    writeFileSync(pdfTamperArtifacts.cropEvidencePdf!, Buffer.from("not the attested evidence PDF"));
    expect(verifyExamCorpus(pdfTamperFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("PDF hash mismatch"))).toBe(true);

    const parentTamperFiles = fixture();
    upgradeEntryToV3(parentTamperFiles, "korean", {
      cropAdjudication: true,
      terminalScope: "authorized-reject",
      answerV5: true,
    });
    rewriteCurrentV3Authority(parentTamperFiles, (currentAudit) => {
      currentAudit.repairs.find((repair: Record<string, any>) => repair.revision?.recovery?.adjudication)
        .revision.recovery.adjudication.parentRecoveryEvidenceHash = "0".repeat(64);
    }, "korean");
    expect(verifyExamCorpus(parentTamperFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("parent recovery hash"))).toBe(true);

    const fifthFiles = fixture();
    upgradeEntryToV3(fifthFiles, "korean", {
      cropAdjudication: true,
      terminalScope: "authorized-reject",
      answerV5: true,
    });
    rewriteCurrentV3Authority(fifthFiles, (currentAudit) => {
      currentAudit.repairs.find((repair: Record<string, any>) => repair.revision?.recovery?.adjudication)
        .revision.recovery.adjudication.key = "11:30";
    }, "korean");
    expect(verifyExamCorpus(fifthFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const orphanFiles = fixture();
    upgradeEntryToV3(orphanFiles, "korean", {
      cropAdjudication: true,
      terminalScope: "authorized-reject",
      answerV5: true,
    });
    writeJson(join(
      orphanFiles.stateDirs.korean,
      "problem-crop-evidence",
      `v1-0011-0030-${"1".repeat(64)}.json`,
    ), {});
    expect(verifyExamCorpus(orphanFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("not declared"))).toBe(true);
  });

  it.skipIf(
    !existsSync(Q30_FAILED_PROBLEM_PATH)
      || !existsSync(Q30_FAILED_CLASSIFICATION_PATH)
      || !existsSync(join(Q30_MANUAL_STATE, "problem.pdf")),
  )("reconstructs the exact Q30 manual child and rejects tamper, orphan, stale parent, or a fifth authority", () => {
    expect(manualAdjudicationAllowlistFingerprint())
      .toBe(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST));
    const manualFixture = () => {
      const files = fixture();
      prepareQ30ManualFixture(files);
      const artifacts = upgradeEntryToV3(files, "korean", {
        manualAdjudication: true,
        terminalScope: "authorized-reject",
        answerV5: true,
      });
      return { files, artifacts };
    };

    const { files, artifacts } = manualFixture();
    const modifiedBefore = statSync(files.dbPath).mtimeMs;
    const report = verifyExamCorpus(files);
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true });
    expect(statSync(files.dbPath).mtimeMs).toBe(modifiedBefore);
    expect(artifacts.manualEvidenceArtifact).toContain("problem-manual-evidence/v1-0012-0030-");
    expect(artifacts.problemManualAdjudicationArtifact)
      .toContain("problem-manual-adjudications/v1-0012-0030-");
    expect(artifacts.classificationManualAdjudicationArtifact)
      .toContain("classification-manual-adjudications/v1-0012-0030-");
    const audit = JSON.parse(readFileSync(artifacts.auditArtifact, "utf8"));
    const manual = audit.repairs.find((value: Record<string, any>) =>
      value.revision?.recovery?.manualAdjudication).revision.recovery.manualAdjudication;
    expect(manual).toMatchObject({
      allowlistId: Q30_MANUAL_SPEC.allowlistId,
      key: Q30_MANUAL_SPEC.key,
      sourcePage: Q30_MANUAL_SPEC.sourcePage,
      sourceHash: Q30_MANUAL_SPEC.sourceHash,
      correctionSpecHash: canonicalEvidenceHash({
        allowlistId: Q30_MANUAL_SPEC.allowlistId,
        parentKind: Q30_MANUAL_SPEC.parentKind,
        views: Q30_MANUAL_SPEC.views,
        requiredTokens: Q30_MANUAL_SPEC.requiredTokens,
        replacements: Q30_MANUAL_SPEC.replacements,
        figure: Q30_MANUAL_SPEC.figure,
        figureDescription: Q30_MANUAL_SPEC.figureDescription,
      }),
    });
    const corrected = JSON.parse(readFileSync(artifacts.problemManualAdjudicationArtifact!, "utf8")).item;
    expect(corrected.question).toContain("㉢ 명제 논리학");
    expect(corrected.question).toContain("⇒");
    expect(corrected.question).toContain("────────");
    expect(corrected.figure_description).toContain("가로선은 총 2개");

    const pixelTamper = manualFixture();
    writeFileSync(pixelTamper.artifacts.manualViewArtifacts![0], Buffer.from("not the attested PNG"));
    expect(verifyExamCorpus(pixelTamper.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("hash mismatch"))).toBe(true);

    const parentTamper = manualFixture();
    rewriteCurrentV3Authority(parentTamper.files, (currentAudit) => {
      currentAudit.repairs.find((value: Record<string, any>) =>
        value.revision?.recovery?.manualAdjudication)
        .revision.recovery.manualAdjudication.parentRecoveryEvidenceHash = "0".repeat(64);
    }, "korean");
    expect(verifyExamCorpus(parentTamper.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("allowlist/parent"))).toBe(true);

    const finalTerminalTamper = manualFixture();
    rewriteCurrentV3Authority(finalTerminalTamper.files, (currentAudit) => {
      const pointer = currentAudit.problemTerminalFidelityCheckpoints[0];
      const checkpointPath = join(finalTerminalTamper.files.stateDirs.korean, pointer.path);
      const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
      const item = checkpoint.items.find((value: { key: string }) => value.key === Q30_MANUAL_SPEC.key);
      item.scopeDecision = "accept";
      item.scopeEvidence = "stale scope output conflicts with the final manual rejection";
      pointer.sha256 = writeEvidence(checkpointPath, checkpoint);
      Object.assign(currentAudit.problemTerminalFidelityItems.find(
        (value: { key: string }) => value.key === Q30_MANUAL_SPEC.key,
      ), item);
    }, "korean");
    expect(verifyExamCorpus(finalTerminalTamper.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("terminal"))).toBe(true);

    const fifth = manualFixture();
    rewriteCurrentV3Authority(fifth.files, (currentAudit) => {
      currentAudit.repairs.find((value: Record<string, any>) =>
        value.revision?.recovery?.manualAdjudication).revision.recovery.scopeAdjudication = {};
    }, "korean");
    expect(verifyExamCorpus(fifth.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const orphan = manualFixture();
    writeJson(join(
      orphan.files.stateDirs.korean,
      "problem-manual-adjudications",
      `v1-0012-0030-${"1".repeat(64)}.json`,
    ), {});
    expect(verifyExamCorpus(orphan.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("not declared"))).toBe(true);

    const crash = manualFixture();
    rmSync(crash.artifacts.classificationManualAdjudicationArtifact!);
    expect(verifyExamCorpus(crash.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("missing"))).toBe(true);

    const residue = manualFixture();
    writeFileSync(`${residue.artifacts.problemManualAdjudicationArtifact}.123.tmp`, "partial");
    expect(verifyExamCorpus(residue.files), "regular immutable-write residue should be ignored")
      .toMatchObject({ ok: true });
  });

  it.skipIf(
    !existsSync(MANUAL_FAILED_ARTIFACTS.get(Q18_MANUAL_SPEC.entryId)!.problem)
      || !existsSync(MANUAL_FAILED_ARTIFACTS.get(Q18_MANUAL_SPEC.entryId)!.classification)
      || !existsSync(join(Q18_MANUAL_STATE, "problem.pdf")),
  )("requires the exact Q18 manual child to remain an out-of-scope rejection", () => {
    const manualFixture = (manualInvalidDecision = false) => {
      const files = fixture();
      prepareManualFixture(files, "math", Q18_MANUAL_SPEC, Q18_MANUAL_STATE);
      const artifacts = upgradeEntryToV3(files, "math", {
        manualAdjudication: true,
        manualInvalidDecision,
        terminalScope: "authorized-reject",
        answerV5: true,
      });
      return { files, artifacts };
    };

    const { files, artifacts } = manualFixture();
    const modifiedBefore = statSync(files.dbPath).mtimeMs;
    const report = verifyExamCorpus(files);
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true });
    expect(statSync(files.dbPath).mtimeMs).toBe(modifiedBefore);
    const corrected = JSON.parse(readFileSync(artifacts.problemManualAdjudicationArtifact!, "utf8")).item;
    expect(corrected.question).toContain("[단일 곡선삼각형 도형문자]");
    expect(corrected.question).toContain("[세 단일 곡선삼각형이 결합된 복합 도형문자]");
    expect(corrected.figure_description).toContain("읽는 순서는 단일, 단일, 복합, 복합");
    const classification = JSON.parse(readFileSync(
      artifacts.classificationManualAdjudicationArtifact!,
      "utf8",
    )).items[0];
    expect(classification).toMatchObject({
      decision: "reject",
      canonical_subject: null,
      curriculum_course: null,
      domain: null,
      achievement_codes: [],
      transcription_status: "exact",
    });

    const invalid = manualFixture(true);
    expect(verifyExamCorpus(invalid.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID"
        && failure.message.includes("manual adjudication is stale or non-exact"))).toBe(true);
  });

  it.skipIf(
    !existsSync(MANUAL_FAILED_ARTIFACTS.get(Q9_MANUAL_SPEC.entryId)!.problem)
      || !existsSync(MANUAL_FAILED_ARTIFACTS.get(Q9_MANUAL_SPEC.entryId)!.classification)
      || !existsSync(join(Q9_MANUAL_STATE, "problem.pdf")),
  )("reconstructs the 600dpi Q9 map correction and requires an integrated-social acceptance", () => {
    const manualFixture = (manualInvalidDecision = false) => {
      const files = fixture();
      prepareManualFixture(files, "social", Q9_MANUAL_SPEC, Q9_MANUAL_STATE);
      const artifacts = upgradeEntryToV3(files, "social", {
        manualAdjudication: true,
        manualInvalidDecision,
        terminalScope: "authorized-reject",
        answerV5: true,
      });
      return { files, artifacts };
    };

    const { files, artifacts } = manualFixture();
    const modifiedBefore = statSync(files.dbPath).mtimeMs;
    const report = verifyExamCorpus(files);
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true });
    expect(statSync(files.dbPath).mtimeMs).toBe(modifiedBefore);
    const evidence = JSON.parse(readFileSync(artifacts.manualEvidenceArtifact!, "utf8"));
    expect(evidence).toMatchObject({ dpi: 600, basis: { dpi: 600 } });
    const corrected = JSON.parse(readFileSync(artifacts.problemManualAdjudicationArtifact!, "utf8")).item;
    expect(corrected.question).toContain("국가를 지도의 A~E에서 고른 것은?");
    expect(corrected.question).not.toContain("국가를 지도에서 A~E에서 고른 것은?");
    expect(corrected.figure_description).toContain("A는 노르웨이");
    expect(corrected.figure_description).toContain("B는 베트남");
    expect(corrected.figure_description).toContain("C는 뉴질랜드");
    expect(corrected.figure_description).toContain("D는 아르헨티나");
    expect(corrected.figure_description).toContain("E는 베네수엘라");
    expect(corrected.figure_description).not.toContain("A는 영국");
    expect(corrected.figure_description).not.toContain("B는 필리핀");
    expect(corrected.figure_description).not.toContain("파나마");
    const classification = JSON.parse(readFileSync(
      artifacts.classificationManualAdjudicationArtifact!,
      "utf8",
    )).items[0];
    expect(classification).toMatchObject({
      decision: "accept",
      canonical_subject: "integrated_social",
      curriculum_course: "통합사회1",
      domain: "자연환경과 인간",
      achievement_codes: ["10통사1-03-01"],
      transcription_status: "exact",
    });

    const invalid = manualFixture(true);
    expect(verifyExamCorpus(invalid.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID"
        && failure.message.includes("manual adjudication is stale or non-exact"))).toBe(true);
  });

  it("keeps the repair-scope allowlist byte-aligned with the importer", () => {
    expect(repairScopeAdjudicationAllowlistFingerprint())
      .toBe(canonicalEvidenceHash(PROBLEM_REPAIR_SCOPE_ADJUDICATION_ALLOWLIST));
  });

  it("keeps the positive repair-scope authority byte-aligned with the importer", () => {
    expect(positiveRepairScopeAdjudicationAllowlistFingerprint())
      .toBe(canonicalEvidenceHash(PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_ALLOWLIST));
    expect(PROBLEM_REPAIR_POSITIVE_SCOPE_AUTHORITY_REASON_CODE)
      .toBe("ALLOWLISTED_POSITIVE_SCOPE_AUTHORITY");
    expect(PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_PROMPT_DIGEST)
      .toBe("aab22d3d596c15e2d4054a999e9fc90df6c46ee6fe9bdde389a88005fd1d4f7d");
  });

  it.skipIf(!existsSync(join(REPAIR_SCOPE_STATES.get(Q10_POSITIVE_REPAIR_SCOPE_SPEC.entryId)!, "problem.pdf")))(
  "reconstructs the exact Q10 positive repair-scope authority and rejects missing or orphan authority",
  () => {
    const scopedFixture = () => {
      const files = fixture();
      prepareRepairScopeFixture(files, Q10_POSITIVE_REPAIR_SCOPE_SPEC);
      const artifacts = upgradeEntryToV3(files, "math", {
        repairScopeAdjudication: true,
        terminalScope: "authorized-reject",
        answerV5: true,
      });
      return { files, artifacts };
    };

    const valid = scopedFixture();
    const modifiedBefore = statSync(valid.files.dbPath).mtimeMs;
    const report = verifyExamCorpus(valid.files);
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true });
    expect(statSync(valid.files.dbPath).mtimeMs).toBe(modifiedBefore);
    expect(valid.artifacts.classificationScopeAdjudicationArtifact).toContain(
      "classification-repair-positive-scope-adjudications/v1-0003-0010-",
    );
    const validAudit = JSON.parse(readFileSync(valid.artifacts.auditArtifact, "utf8"));
    const validRepair = validAudit.repairs.find(
      (value: { key: string }) => value.key === Q10_POSITIVE_REPAIR_SCOPE_SPEC.key,
    );
    expect(validRepair.revision).toBeUndefined();
    expect(validRepair).toMatchObject({
      scopeAdjudication: {
        allowlistId: Q10_POSITIVE_REPAIR_SCOPE_SPEC.allowlistId,
        classificationArtifact: {
          adjudicationPromptDigest: PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_PROMPT_DIGEST,
        },
      },
    });
    const decision = JSON.parse(readFileSync(
      valid.artifacts.classificationScopeAdjudicationArtifact!,
      "utf8",
    )).items[0];
    expect(decision).toMatchObject({
      decision: "accept",
      canonical_subject: "math_A",
      achievement_codes: ["12수학Ⅱ03-04"],
      transcription_status: "exact",
    });
    expect(decision.reason_codes).toContain(PROBLEM_REPAIR_POSITIVE_SCOPE_AUTHORITY_REASON_CODE);
    expect(validAudit.problemTerminalFidelityItems.find(
      (item: { key: string }) => item.key === Q10_POSITIVE_REPAIR_SCOPE_SPEC.key,
    )).toMatchObject({ status: "exact", scopeDecision: "reject" });

    const transcriptionOnly = scopedFixture();
    rewriteCurrentV3Authority(transcriptionOnly.files, (audit) => {
      const pointer = audit.problemTerminalFidelityCheckpoints[0];
      const checkpointPath = join(transcriptionOnly.files.stateDirs.math, pointer.path);
      const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
      const item = checkpoint.items.find(
        (value: { key: string }) => value.key === Q10_POSITIVE_REPAIR_SCOPE_SPEC.key,
      );
      item.scopeDecision = "accept";
      item.scopeEvidence = "the fresh terminal scope observation differs but transcription remains exact";
      pointer.sha256 = writeEvidence(checkpointPath, checkpoint);
      Object.assign(audit.problemTerminalFidelityItems.find(
        (value: { key: string }) => value.key === Q10_POSITIVE_REPAIR_SCOPE_SPEC.key,
      ), item);
    });
    const transcriptionOnlyReport = verifyExamCorpus(transcriptionOnly.files);
    expect(transcriptionOnlyReport, JSON.stringify(transcriptionOnlyReport.failures)).toMatchObject({ ok: true });

    const childTamper = scopedFixture();
    const child = JSON.parse(readFileSync(
      childTamper.artifacts.classificationScopeAdjudicationArtifact!,
      "utf8",
    ));
    child.items[0].reason_codes = ["IN_SCOPE_RIEMANN_SUM_DEFINITION"];
    const childHash = writeEvidence(childTamper.artifacts.classificationScopeAdjudicationArtifact!, child);
    const childItemHash = canonicalEvidenceHash(child.items[0]);
    rewriteCurrentV3Authority(childTamper.files, (audit) => {
      const scope = audit.repairs.find(
        (value: { key: string }) => value.key === Q10_POSITIVE_REPAIR_SCOPE_SPEC.key,
      ).scopeAdjudication;
      scope.classificationArtifact.sha256 = childHash;
      scope.classificationArtifactItemHash = childItemHash;
      scope.effectiveClassificationHash = childItemHash;
    });
    expect(verifyExamCorpus(childTamper.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID"
        && failure.message.includes("exact allowlisted authority"))).toBe(true);

    const stale = scopedFixture();
    rewriteCurrentV3Authority(stale.files, (audit) => {
      const repair = audit.repairs.find(
        (value: { key: string }) => value.key === Q10_POSITIVE_REPAIR_SCOPE_SPEC.key,
      );
      const scope = repair.scopeAdjudication;
      const oldTerminalPath = join(stale.files.stateDirs.math, scope.trigger.terminalCheckpoint.path);
      const terminal = JSON.parse(readFileSync(oldTerminalPath, "utf8"));
      const staleCorpusHash = "a".repeat(64);
      terminal.effectiveCorpusHash = staleCorpusHash;
      const terminalRelativePath = `problem-terminal-fidelity/v2-0000-${staleCorpusHash}-` +
        `${terminal.inputHash}.json`;
      const terminalHash = writeEvidence(join(stale.files.stateDirs.math, terminalRelativePath), terminal);
      scope.trigger.preAdjudicationEffectiveCorpusHash = staleCorpusHash;
      scope.trigger.terminalCheckpoint = {
        ...scope.trigger.terminalCheckpoint,
        path: terminalRelativePath,
        sha256: terminalHash,
      };
      const oldChildPath = join(stale.files.stateDirs.math, scope.classificationArtifact.path);
      const staleChild = JSON.parse(readFileSync(oldChildPath, "utf8"));
      staleChild.basis.trigger = scope.trigger;
      staleChild.basisDigest = canonicalEvidenceHash(staleChild.basis);
      const childRelativePath = `classification-repair-positive-scope-adjudications/v1-0003-0010-` +
        `${staleChild.basisDigest}-${DIGEST}.json`;
      const childHash = writeEvidence(join(stale.files.stateDirs.math, childRelativePath), staleChild);
      scope.classificationArtifact.path = childRelativePath;
      scope.classificationArtifact.sha256 = childHash;
      rmSync(oldTerminalPath);
      rmSync(oldChildPath);
    });
    expect(verifyExamCorpus(stale.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID"
        && failure.message.includes("does not bind one exact prior corpus generation"))).toBe(true);

    const missing = scopedFixture();
    rmSync(missing.artifacts.classificationScopeAdjudicationArtifact!);
    expect(verifyExamCorpus(missing.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("missing"))).toBe(true);

    const orphan = scopedFixture();
    writeJson(join(
      orphan.files.stateDirs.math,
      "classification-repair-positive-scope-adjudications",
      `v1-0003-0010-${"1".repeat(64)}-${DIGEST}.json`,
    ), {});
    expect(verifyExamCorpus(orphan.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("not declared"))).toBe(true);
  });

  it.skipIf([...REPAIR_SCOPE_STATES.values()].some((stateDir) =>
    !existsSync(join(stateDir, "problem.pdf")) || !existsSync(join(stateDir, "solution.pdf"))))(
  "reconstructs both exact first-repair scope children and rejects stale or extra authority",
  () => {
    const scopedFixture = (spec = Q26_REPAIR_SCOPE_SPEC) => {
      const files = fixture();
      prepareRepairScopeFixture(files, spec);
      const artifacts = upgradeEntryToV3(files, "math", {
        repairScopeAdjudication: true,
        terminalScope: "authorized-reject",
        answerV5: true,
      });
      return { files, artifacts };
    };

    for (const spec of [Q26_REPAIR_SCOPE_SPEC, Q30_REPAIR_SCOPE_SPEC]) {
      const { files, artifacts } = scopedFixture(spec);
      const modifiedBefore = statSync(files.dbPath).mtimeMs;
      const report = verifyExamCorpus(files);
      expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true });
      expect(statSync(files.dbPath).mtimeMs).toBe(modifiedBefore);
      expect(artifacts.classificationScopeAdjudicationArtifact).toContain(
        `classification-repair-scope-adjudications/v1-${String(spec.sourcePage).padStart(4, "0")}-` +
        `${spec.key.split(":")[1].padStart(4, "0")}-`,
      );
      const audit = JSON.parse(readFileSync(artifacts.auditArtifact, "utf8"));
      const repair = audit.repairs.find((value: Record<string, unknown>) => value.key === spec.key);
      expect(repair.revision).toBeUndefined();
      expect(repair.scopeAdjudication).toMatchObject({
        allowlistId: spec.allowlistId,
        key: spec.key,
        sourcePage: spec.sourcePage,
        sourceHash: spec.sourceHash,
        solutionSourceHash: spec.solutionSourceHash,
        problemContextFrom: 1,
        problemContextTo: 12,
        solutionContextFrom: 1,
        solutionContextTo: 4,
      });
    }

    const parentTamper = scopedFixture();
    rewriteCurrentV3Authority(parentTamper.files, (audit) => {
      audit.repairs.find((value: Record<string, unknown>) => value.key === Q26_REPAIR_SCOPE_SPEC.key)
        .scopeAdjudication.parentRepairEvidenceHash = "0".repeat(64);
    });
    expect(verifyExamCorpus(parentTamper.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("parent repair hash"))).toBe(true);

    const contextTamper = scopedFixture();
    rewriteCurrentV3Authority(contextTamper.files, (audit) => {
      audit.repairs.find((value: Record<string, unknown>) => value.key === Q26_REPAIR_SCOPE_SPEC.key)
        .scopeAdjudication.solutionContextTo = 3;
    });
    expect(verifyExamCorpus(contextTamper.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("solution/context"))).toBe(true);

    const outputTamper = scopedFixture();
    const outputCheckpoint = JSON.parse(readFileSync(
      outputTamper.artifacts.classificationScopeAdjudicationArtifact!,
      "utf8",
    ));
    Object.assign(outputCheckpoint.items[0], {
      decision: "accept",
      canonical_subject: "math_B",
      curriculum_course: "2015 수학Ⅰ",
      domain: "지수함수와 로그함수",
      achievement_codes: ["12수학Ⅰ01-07"],
      reason_codes: ["IN_SCOPE_LOGARITHMS"],
    });
    const outputHash = writeEvidence(outputTamper.artifacts.classificationScopeAdjudicationArtifact!, outputCheckpoint);
    const outputItemHash = canonicalEvidenceHash(outputCheckpoint.items[0]);
    rewriteCurrentV3Authority(outputTamper.files, (audit) => {
      const scope = audit.repairs.find(
        (value: Record<string, unknown>) => value.key === Q26_REPAIR_SCOPE_SPEC.key,
      ).scopeAdjudication;
      scope.classificationArtifact.sha256 = outputHash;
      scope.classificationArtifactItemHash = outputItemHash;
      scope.effectiveClassificationHash = outputItemHash;
    });
    expect(verifyExamCorpus(outputTamper.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("reject/null"))).toBe(true);

    const finalTerminalTamper = scopedFixture();
    rewriteCurrentV3Authority(finalTerminalTamper.files, (audit) => {
      const pointer = audit.problemTerminalFidelityCheckpoints[0];
      const checkpointPath = join(finalTerminalTamper.files.stateDirs.math, pointer.path);
      const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
      const item = checkpoint.items.find((value: { key: string }) => value.key === Q26_REPAIR_SCOPE_SPEC.key);
      item.scopeDecision = "accept";
      item.scopeEvidence = "stale final scope output conflicts with the repair-scope rejection";
      pointer.sha256 = writeEvidence(checkpointPath, checkpoint);
      Object.assign(audit.problemTerminalFidelityItems.find(
        (value: { key: string }) => value.key === Q26_REPAIR_SCOPE_SPEC.key,
      ), item);
    });
    expect(verifyExamCorpus(finalTerminalTamper.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("terminal"))).toBe(true);

    const revision = scopedFixture();
    rewriteCurrentV3Authority(revision.files, (audit) => {
      audit.repairs.find((value: Record<string, unknown>) => value.key === Q26_REPAIR_SCOPE_SPEC.key)
        .revision = {};
    });
    expect(verifyExamCorpus(revision.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const orphan = scopedFixture();
    writeJson(join(
      orphan.files.stateDirs.math,
      "classification-repair-scope-adjudications",
      `v1-0010-0026-${"1".repeat(64)}-${DIGEST}.json`,
    ), {});
    expect(verifyExamCorpus(orphan.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("not declared"))).toBe(true);

    const crash = scopedFixture();
    rmSync(crash.artifacts.classificationScopeAdjudicationArtifact!);
    expect(verifyExamCorpus(crash.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("missing"))).toBe(true);
  });

  it("compares DB difficulty with the immutable base problem instead of a repaired overlay", () => {
    const files = fixture();
    upgradeEntryToV3(files, "math", {
      difficultyRepair: true,
      terminalScope: "authorized-reject",
      answerV5: true,
    });
    const report = verifyExamCorpus(files);
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true });

    const db = new Database(files.dbPath);
    db.prepare("UPDATE questions SET difficulty = '상' WHERE printed_number = '1'").run();
    db.close();
    expect(verifyExamCorpus(files).failures.some((failure) =>
      failure.code === "QUESTION_MISMATCH" && failure.message.includes("base difficulty"))).toBe(true);
  });

  it.skipIf(!existsSync(Q11_OFFICIAL_PROBLEM_PATH) || !existsSync(Q11_OFFICIAL_SOLUTION_PATH))(
  "reconstructs the exact Q11 scope adjudication chain",
  () => {
    const scopedFixture = () => {
      const files = fixture();
      prepareQ11ScopeFixture(files);
      const artifacts = upgradeEntryToV3(files, "math", {
        scopeAdjudication: true,
        terminalScope: "authorized-reject",
        answerV5: true,
      });
      return { files, artifacts };
    };
    const { files, artifacts } = scopedFixture();
    const modifiedBefore = statSync(files.dbPath).mtimeMs;
    const report = verifyExamCorpus(files);
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true });
    expect(statSync(files.dbPath).mtimeMs).toBe(modifiedBefore);
    expect(artifacts.classificationScopeAdjudicationArtifact)
      .toContain("classification-scope-adjudications/v1-0004-0011-");
    const audit = JSON.parse(readFileSync(artifacts.auditArtifact, "utf8"));
    const repair = audit.repairs.find((value: Record<string, any>) =>
      value.revision?.recovery?.scopeAdjudication);
    expect(repair.revision.recovery.scopeAdjudication).toMatchObject({
      allowlistId: Q11_SCOPE_SPEC.allowlistId,
      key: Q11_SCOPE_SPEC.key,
      sourcePage: Q11_SCOPE_SPEC.sourcePage,
      sourceHash: Q11_SCOPE_SPEC.sourceHash,
      solutionSourceHash: Q11_SCOPE_SPEC.solutionSourceHash,
    });

    const sourceTamper = scopedFixture();
    rewriteCurrentV3Authority(sourceTamper.files, (currentAudit) => {
      currentAudit.repairs.find((value: Record<string, any>) =>
        value.revision?.recovery?.scopeAdjudication)
        .revision.recovery.scopeAdjudication.sourceHash = "0".repeat(64);
    });
    expect(verifyExamCorpus(sourceTamper.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const parentTamper = scopedFixture();
    rewriteCurrentV3Authority(parentTamper.files, (currentAudit) => {
      currentAudit.repairs.find((value: Record<string, any>) =>
        value.revision?.recovery?.scopeAdjudication)
        .revision.recovery.scopeAdjudication.parentRecoveryEvidenceHash = "0".repeat(64);
    });
    expect(verifyExamCorpus(parentTamper.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("parent recovery hash"))).toBe(true);

    const terminalTamper = scopedFixture();
    rewriteCurrentV3Authority(terminalTamper.files, (currentAudit) => {
      currentAudit.repairs.find((value: Record<string, any>) =>
        value.revision?.recovery?.scopeAdjudication)
        .revision.recovery.scopeAdjudication.trigger.scopeEvidenceHash = "0".repeat(64);
    });
    expect(verifyExamCorpus(terminalTamper.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("terminal conflict"))).toBe(true);

    const contextTamper = scopedFixture();
    rewriteCurrentV3Authority(contextTamper.files, (currentAudit) => {
      currentAudit.repairs.find((value: Record<string, any>) =>
        value.revision?.recovery?.scopeAdjudication)
        .revision.recovery.scopeAdjudication.solutionContextTo = 4;
    });
    expect(verifyExamCorpus(contextTamper.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("solution/context"))).toBe(true);

    const outputTamper = scopedFixture();
    const outputCheckpoint = JSON.parse(readFileSync(
      outputTamper.artifacts.classificationScopeAdjudicationArtifact!,
      "utf8",
    ));
    Object.assign(outputCheckpoint.items[0], {
      decision: "accept",
      canonical_subject: "math_B",
      curriculum_course: "2015 수학Ⅰ",
      domain: "지수함수와 로그함수",
      achievement_codes: ["12수학Ⅰ01-07"],
      reason_codes: ["IN_SCOPE_LOGARITHMS"],
    });
    const outputHash = writeEvidence(
      outputTamper.artifacts.classificationScopeAdjudicationArtifact!,
      outputCheckpoint,
    );
    const outputItemHash = canonicalEvidenceHash(outputCheckpoint.items[0]);
    rewriteCurrentV3Authority(outputTamper.files, (currentAudit) => {
      const scope = currentAudit.repairs.find((value: Record<string, any>) =>
        value.revision?.recovery?.scopeAdjudication).revision.recovery.scopeAdjudication;
      scope.classificationArtifact.sha256 = outputHash;
      scope.classificationArtifactItemHash = outputItemHash;
      scope.effectiveClassificationHash = outputItemHash;
    });
    expect(verifyExamCorpus(outputTamper.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("reject/null"))).toBe(true);

    const finalTerminalTamper = scopedFixture();
    rewriteCurrentV3Authority(finalTerminalTamper.files, (currentAudit) => {
      const pointer = currentAudit.problemTerminalFidelityCheckpoints[0];
      const checkpointPath = join(finalTerminalTamper.files.stateDirs.math, pointer.path);
      const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
      checkpoint.items.find((item: { key: string }) => item.key === Q11_SCOPE_SPEC.key).scopeDecision = "accept";
      pointer.sha256 = writeEvidence(checkpointPath, checkpoint);
      currentAudit.problemTerminalFidelityItems.find(
        (item: { key: string }) => item.key === Q11_SCOPE_SPEC.key,
      ).scopeDecision = "accept";
    });
    expect(verifyExamCorpus(finalTerminalTamper.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("terminal"))).toBe(true);

    const noThird = scopedFixture();
    rewriteCurrentV3Authority(noThird.files, (currentAudit) => {
      currentAudit.repairs.find((value: Record<string, any>) =>
        value.revision?.recovery?.scopeAdjudication).revision.recovery.adjudication = {};
    });
    expect(verifyExamCorpus(noThird.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const orphan = scopedFixture();
    writeJson(join(
      orphan.files.stateDirs.math,
      "classification-scope-adjudications",
      `v1-0004-0011-${"1".repeat(64)}-${DIGEST}.json`,
    ), {});
    expect(verifyExamCorpus(orphan.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("not declared"))).toBe(true);

    const staleFallback = fixture();
    const staleScopeDirectory = join(staleFallback.stateDirs.math, "classification-scope-adjudications");
    mkdirSync(staleScopeDirectory, { recursive: true });
    writeJson(join(staleScopeDirectory, "malformed.json"), {});
    expect(verifyExamCorpus(staleFallback).failures.some((failure) =>
      failure.code === "ANSWER_ATTESTATION_MISSING")).toBe(true);
  });

  it("reconstructs a mixed same-pass first repair plus terminal revision generation", () => {
    const files = fixture();
    const artifacts = upgradeEntryToV3(files, "math", { mixedTerminal: true });
    const report = verifyExamCorpus(files);
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true });
    expect(artifacts.problemRevisionArtifact).toContain("problem-revision-batches/v1-");

    const staleFiles = fixture();
    upgradeEntryToV3(staleFiles, "math", { staleTriggerBase: true });
    const stale = verifyExamCorpus(staleFiles);
    expect(stale.ok).toBe(false);
    expect(stale.failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID"
      && failure.message.includes("no attested problem generation matches 1:3"))).toBe(true);
    expect(() => assertTerminalGenerationSearchBound(Array.from({ length: 17 }, () => 2)))
      .toThrow("too ambiguous to verify safely");
  });

  it("requires the current terminal audit for filtered and partially migrated states", () => {
    const files = fixture();
    const resultPath = convertMathToFilteredV3(files);
    const report = verifyExamCorpus(files);
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true });
    expect(report.manifest.filtered).toBe(1);

    const missingFiles = fixture();
    const missingResultPath = convertMathToFilteredV3(missingFiles);
    const missing = JSON.parse(readFileSync(missingResultPath, "utf8"));
    delete missing.answerAudit;
    writeJson(missingResultPath, missing);
    const missingReport = verifyExamCorpus(missingFiles);
    expect(missingReport.ok).toBe(false);
    expect(missingReport.failures.some((failure) =>
      failure.message.includes("no terminal v3 answer audit"))).toBe(true);

    const missingAuditHistoryFiles = fixture();
    const missingAuditHistoryResultPath = convertMathToFilteredV3(missingAuditHistoryFiles);
    const missingAuditHistoryResult = JSON.parse(readFileSync(missingAuditHistoryResultPath, "utf8"));
    delete missingAuditHistoryResult.answerAudit;
    writeJson(missingAuditHistoryResultPath, missingAuditHistoryResult);
    writeJson(join(
      missingAuditHistoryFiles.stateDirs.math,
      "solution-repairs",
      `v1-0001-0027-${"3".repeat(64)}.json`,
    ), {});
    const missingAuditHistory = verifyExamCorpus(missingAuditHistoryFiles);
    expect(missingAuditHistory.ok).toBe(false);
    expect(missingAuditHistory.failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const currentFiles = fixture();
    const currentResultPath = convertMathToFilteredV3(currentFiles, true, true);
    const current = verifyExamCorpus(currentFiles);
    expect(current, JSON.stringify(current.failures)).toMatchObject({ ok: true });
    const staleCurrent = JSON.parse(readFileSync(currentResultPath, "utf8"));
    staleCurrent.problemTerminalScopePromptDigest = "0".repeat(64);
    writeJson(currentResultPath, staleCurrent);
    expect(verifyExamCorpus(currentFiles).failures.some((failure) =>
      failure.code === "RESULT_INVALID" || failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const currentV5Files = fixture();
    const currentV5ResultPath = convertMathToFilteredV3(currentV5Files, true, true, true);
    const currentV5 = verifyExamCorpus(currentV5Files);
    expect(currentV5, JSON.stringify(currentV5.failures)).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(currentV5ResultPath, "utf8")).version).toBe(5);

    const filteredWithDormantHistory = () => {
      const donor = fixture();
      installQ27SolutionRepair(donor, 27);
      const files = fixture();
      for (const directory of ["problem-chunks", "solution-chunks"]) {
        for (const name of readdirSync(join(donor.stateDirs.math, directory))) {
          writeFileSync(
            join(files.stateDirs.math, directory, name),
            readFileSync(join(donor.stateDirs.math, directory, name)),
          );
        }
      }
      convertMathToFilteredV3(files, true, false, true);
      for (const directory of [
        "solution-fidelity",
        "solution-repairs",
        "solution-fidelity-repairs",
        "solution-revisions",
        "solution-fidelity-revisions",
      ]) {
        const source = join(donor.stateDirs.math, directory);
        if (!existsSync(source)) continue;
        const target = join(files.stateDirs.math, directory);
        mkdirSync(target, { recursive: true });
        for (const name of readdirSync(source)) {
          writeFileSync(join(target, name), readFileSync(join(source, name)));
        }
      }
      const repairName = readdirSync(join(files.stateDirs.math, "solution-repairs"))[0];
      const fidelityName = readdirSync(join(files.stateDirs.math, "solution-fidelity-repairs"))[0];
      return {
        files,
        repairArtifact: join(files.stateDirs.math, "solution-repairs", repairName),
        fidelityArtifact: join(files.stateDirs.math, "solution-fidelity-repairs", fidelityName),
      };
    };

    const dormantFixture = filteredWithDormantHistory();
    const dormantFiles = dormantFixture.files;
    const dormant = verifyExamCorpus(dormantFiles);
    expect(dormant, JSON.stringify(dormant.failures)).toMatchObject({ ok: true });

    const partialDormant = filteredWithDormantHistory();
    const partialDormantFiles = partialDormant.files;
    rmSync(partialDormant.fidelityArtifact);
    expect(verifyExamCorpus(partialDormantFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID"
      && failure.message.includes("child coverage"))).toBe(true);

    const tamperedDormant = filteredWithDormantHistory();
    const tamperedDormantFiles = tamperedDormant.files;
    const tamperedDormantCheckpoint = JSON.parse(readFileSync(tamperedDormant.repairArtifact, "utf8"));
    tamperedDormantCheckpoint.item.explanation = "tampered dormant explanation";
    writeJson(tamperedDormant.repairArtifact, tamperedDormantCheckpoint);
    expect(verifyExamCorpus(tamperedDormantFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const malformedDormant = filteredWithDormantHistory();
    const malformedDormantFiles = malformedDormant.files;
    writeJson(join(
      malformedDormantFiles.stateDirs.math,
      "solution-repairs",
      `v1-0001-0027-${"1".repeat(64)}.json`,
    ), {});
    expect(verifyExamCorpus(malformedDormantFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const orphanDormant = filteredWithDormantHistory();
    const orphanDormantFiles = orphanDormant.files;
    const orphanName = `v1-0001-0027-${"1".repeat(64)}-${"2".repeat(64)}.json`;
    writeFileSync(
      join(orphanDormantFiles.stateDirs.math, "solution-fidelity-repairs", orphanName),
      readFileSync(orphanDormant.fidelityArtifact),
    );
    expect(verifyExamCorpus(orphanDormantFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID"
      && failure.message.includes("child coverage"))).toBe(true);

    const mixedVersionFiles = fixture();
    convertMathToFilteredV3(mixedVersionFiles, true, true);
    writeJson(join(
      mixedVersionFiles.stateDirs.math,
      "semantic-choice-checks",
      `v5-${"1".repeat(64)}-${"2".repeat(64)}-${"3".repeat(64)}.json`,
    ), {});
    const mixedVersion = verifyExamCorpus(mixedVersionFiles);
    expect(mixedVersion.ok).toBe(false);
    expect(mixedVersion.failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" || failure.code === "RESULT_INVALID")).toBe(true);

    const staleGenerationFiles = fixture();
    convertMathToFilteredV3(staleGenerationFiles);
    writeJson(join(
      staleGenerationFiles.stateDirs.math,
      "problem-terminal-fidelity",
      `v2-0000-${"1".repeat(64)}-${"2".repeat(64)}.json`,
    ), {});
    const staleGeneration = verifyExamCorpus(staleGenerationFiles);
    expect(staleGeneration.ok).toBe(false);
    expect(staleGeneration.failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" || failure.code === "RESULT_INVALID")).toBe(true);

    const partialFiles = fixture();
    const partial = upgradeEntryToV3(partialFiles);
    rmSync(partial.attestationArtifact!);
    const partialReport = verifyExamCorpus(partialFiles);
    expect(partialReport.ok).toBe(false);
    expect(partialReport.failures.some((failure) => failure.code === "ANSWER_ATTESTATION_MISSING")).toBe(true);
    expect(resultPath).toContain("result.json");
  });

  it("overlays one declared immutable repair and rejects artifact tampering", () => {
    const files = fixture();
    const { classificationArtifact } = installSyntheticRepair(files);
    const repaired = verifyExamCorpus(files);
    expect(repaired, JSON.stringify(repaired.failures)).toMatchObject({ ok: true });

    const tampered = JSON.parse(readFileSync(classificationArtifact, "utf8"));
    tampered.item.domain = "tampered";
    writeJson(classificationArtifact, tampered);
    const report = verifyExamCorpus(files);
    expect(report.ok).toBe(false);
    expect(report.failures.some((failure) => failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);
  });

  it("reconstructs one Q17 problem revision and rejects orphan, stale, tampered, or repeated chains", () => {
    const files = fixture();
    installSyntheticRepair(files, true);
    const revised = verifyExamCorpus(files);
    expect(revised, JSON.stringify(revised.failures)).toMatchObject({ ok: true });
    const db = new Database(files.dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT question FROM questions WHERE printed_number = '1' AND question LIKE 'Q17%'")
      .get() as { question: string };
    db.close();
    expect(row.question).toContain("second source-grounded transcription");

    const priorTamperFiles = fixture();
    const priorArtifacts = installSyntheticRepair(priorTamperFiles, true);
    const prior = JSON.parse(readFileSync(priorArtifacts.classificationArtifact, "utf8"));
    prior.item.transcription_evidence = "tampered prior mismatch";
    writeJson(priorArtifacts.classificationArtifact, prior);
    expect(verifyExamCorpus(priorTamperFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const revisionTamperFiles = fixture();
    const revisionArtifacts = installSyntheticRepair(revisionTamperFiles, true);
    const revision = JSON.parse(readFileSync(revisionArtifacts.revisionProblemArtifact!, "utf8"));
    revision.item.question = "tampered second revision";
    writeJson(revisionArtifacts.revisionProblemArtifact!, revision);
    expect(verifyExamCorpus(revisionTamperFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const orphanFiles = fixture();
    installSyntheticRepair(orphanFiles, true);
    rewriteProblemRepairAuthority(orphanFiles, (repair) => delete repair.revision);
    expect(verifyExamCorpus(orphanFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("no attested second revision"))).toBe(true);

    const staleFiles = fixture();
    installSyntheticRepair(staleFiles, true);
    rewriteProblemRepairAuthority(staleFiles, (repair) => {
      repair.revision.classificationArtifact.revisionPromptDigest = "0".repeat(64);
    });
    expect(verifyExamCorpus(staleFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("stale"))).toBe(true);

    const repeatedFiles = fixture();
    installSyntheticRepair(repeatedFiles, true);
    rewriteProblemRepairAuthority(repeatedFiles, (repair) => {
      repair.revision.revision = { unexpected: "second revision" };
    });
    expect(verifyExamCorpus(repeatedFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("exact chain"))).toBe(true);

    const exactFirstFiles = fixture();
    installSyntheticRepair(exactFirstFiles);
    rewriteProblemRepairAuthority(exactFirstFiles, (repair) => {
      repair.revision = { forbidden: true };
    });
    expect(verifyExamCorpus(exactFirstFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("must not declare"))).toBe(true);
  });

  it("overlays the Q27 3-squared solution repair into DB evidence and rejects tampering", () => {
    const files = fixture();
    const artifacts = installQ27SolutionRepair(files);
    const repaired = verifyExamCorpus(files);
    expect(repaired, JSON.stringify(repaired.failures)).toMatchObject({ ok: true });

    const db = new Database(files.dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT answer, explanation, printed_number FROM questions WHERE printed_number = '27'")
      .get() as { answer: string; explanation: string; printed_number: string };
    db.close();
    expect(row).toEqual({
      answer: "72",
      explanation: "$m=3^2q^3$이어야 하므로 $m=2^3\\times3^2=72$이다.",
      printed_number: "27",
    });

    const tampered = JSON.parse(readFileSync(artifacts.repairArtifact, "utf8"));
    tampered.item.explanation = "$m=3q^3$이어야 하므로 72이다.";
    writeJson(artifacts.repairArtifact, tampered);
    const report = verifyExamCorpus(files);
    expect(report.ok).toBe(false);
    expect(report.failures.some((failure) => failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);
  });

  it("keeps a complete Q27 repair sticky across problem-corpus generations", () => {
    const files = fixture();
    const artifacts = migratePersistedSolutionGeneration(files, 27);
    cloneHistoricalFirstSolutionGeneration(files, artifacts.historicalRepairArtifact, "historical generation two");
    cloneHistoricalFirstSolutionGeneration(files, artifacts.historicalRepairArtifact, "historical generation three");
    const report = verifyExamCorpus(files);
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true });
    const currentRepair = JSON.parse(readFileSync(artifacts.repairArtifact, "utf8"));
    expect(currentRepair.persistedSeed).toMatchObject({
      version: 1,
      repairArtifact: {
        path: artifacts.historicalRepairArtifact.split(`${files.stateDirs.math}/`)[1],
      },
      repairedItemHash: canonicalEvidenceHash(currentRepair.item),
    });

    const dormantFiles = fixture();
    makeQ27HistoricalAuthorityDormant(dormantFiles);
    const dormant = verifyExamCorpus(dormantFiles);
    expect(dormant, JSON.stringify(dormant.failures)).toMatchObject({ ok: true });

    const staleFallbackFiles = fixture();
    migratePersistedSolutionGeneration(staleFallbackFiles, 27);
    const staleState = staleFallbackFiles.stateDirs.math;
    for (const name of readdirSync(join(staleState, "answer-audit"))) {
      if (name.startsWith("v5-")) rmSync(join(staleState, "answer-audit", name));
    }
    for (const name of readdirSync(join(staleState, "answer-attestation"))) {
      if (name.startsWith("v5-")) rmSync(join(staleState, "answer-attestation", name));
    }
    for (const name of readdirSync(join(staleState, "classification-chunks"))) {
      if (name.startsWith("v5-")) rmSync(join(staleState, "classification-chunks", name));
    }
    for (const name of readdirSync(join(staleState, "problem-terminal-fidelity"))) {
      if (name.startsWith("v2-")) rmSync(join(staleState, "problem-terminal-fidelity", name));
    }
    const staleSemanticDir = join(staleState, "semantic-choice-checks");
    if (existsSync(staleSemanticDir)) {
      for (const name of readdirSync(staleSemanticDir)) {
        if (name.startsWith("v5-")) rmSync(join(staleSemanticDir, name));
      }
    }
    if (existsSync(join(staleState, "result.json"))) rmSync(join(staleState, "result.json"));
    expect(readdirSync(join(staleState, "answer-audit")).some((name) => name.startsWith("v5-"))).toBe(false);
    expect(readdirSync(join(staleState, "answer-attestation")).some((name) => name.startsWith("v5-"))).toBe(false);
    expect(readdirSync(join(staleState, "classification-chunks")).some((name) => name.startsWith("v5-"))).toBe(false);
    expect(readdirSync(join(staleState, "problem-terminal-fidelity")).some((name) => name.startsWith("v2-"))).toBe(false);
    expect(existsSync(staleSemanticDir)
      && readdirSync(staleSemanticDir).some((name) => name.startsWith("v5-"))).toBe(false);
    const staleFallback = verifyExamCorpus(staleFallbackFiles);
    expect(staleFallback.ok).toBe(false);
    expect(staleFallback.failures.some((failure) =>
      failure.code === "ANSWER_ATTESTATION_MISSING")).toBe(true);

    const omittedFiles = fixture();
    migratePersistedSolutionGeneration(omittedFiles, 27);
    rewriteSolutionAuditAuthority(omittedFiles, (audit) => {
      audit.solutionRepairs = [];
      audit.solutionRepairKeys = [];
    });
    expect(verifyExamCorpus(omittedFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID"
      && failure.message.includes("declared solution repair keys"))).toBe(true);

    const partialFiles = fixture();
    const partial = migratePersistedSolutionGeneration(partialFiles, 27);
    rmSync(partial.repairFidelityArtifact);
    expect(verifyExamCorpus(partialFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID"
      && failure.message.includes("child coverage"))).toBe(true);

    const historicalPartialFiles = fixture();
    const historicalPartial = migratePersistedSolutionGeneration(historicalPartialFiles, 27);
    const extraHistorical = cloneHistoricalFirstSolutionGeneration(
      historicalPartialFiles,
      historicalPartial.historicalRepairArtifact,
      "historical child removal",
    );
    rmSync(extraHistorical.fidelityArtifact);
    expect(verifyExamCorpus(historicalPartialFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID"
      && failure.message.includes("child coverage"))).toBe(true);

    const seedTamperFiles = fixture();
    const seedTamper = migratePersistedSolutionGeneration(seedTamperFiles, 27);
    const tamperedSeed = JSON.parse(readFileSync(seedTamper.repairArtifact, "utf8"));
    tamperedSeed.persistedSeed.repairedItemHash = "0".repeat(64);
    writeJson(seedTamper.repairArtifact, tamperedSeed);
    expect(verifyExamCorpus(seedTamperFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID"
      && failure.message.includes("persisted seed"))).toBe(true);

    const malformedFiles = fixture();
    migratePersistedSolutionGeneration(malformedFiles, 27);
    writeJson(join(malformedFiles.stateDirs.math, "solution-repairs", "malformed.json"), {});
    expect(verifyExamCorpus(malformedFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID"
      && failure.message.includes("malformed persisted solution authority"))).toBe(true);

    const orphanFiles = fixture();
    const orphan = migratePersistedSolutionGeneration(orphanFiles, 27);
    const orphanCheckpoint = JSON.parse(readFileSync(orphan.repairFidelityArtifact, "utf8"));
    orphanCheckpoint.repairArtifact = {
      path: `solution-repairs/v1-0001-0027-${"f".repeat(64)}.json`,
      sha256: "e".repeat(64),
    };
    writeEvidence(join(
      orphanFiles.stateDirs.math,
      "solution-fidelity-repairs",
      `v1-9999-9999-${"d".repeat(64)}-${"c".repeat(64)}.json`,
    ), orphanCheckpoint);
    expect(verifyExamCorpus(orphanFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID"
      && failure.message.includes("orphan persisted solution repair fidelity"))).toBe(true);
  });

  it("keeps the legacy solution prompt-upgrade allowlist byte-aligned with the importer", () => {
    expect(solutionPromptUpgradeAllowlistFingerprint())
      .toBe(canonicalEvidenceHash(SOLUTION_PROMPT_UPGRADE_ALLOWLIST));
    expect([SOLUTION_PROMPT_UPGRADE_VERSION, SOLUTION_PROMPT_UPGRADE_FIDELITY_VERSION])
      .toEqual([1, 1]);
  });

  it("keeps the Q20 solution-fidelity adjudication allowlist byte-aligned with the importer", () => {
    expect(solutionFidelityAdjudicationAllowlistFingerprint())
      .toBe(canonicalEvidenceHash(SOLUTION_REVISION_FIDELITY_ADJUDICATION_ALLOWLIST));
    expect(SOLUTION_REVISION_FIDELITY_ADJUDICATION_VERSION).toBe(1);
    expect(SOLUTION_REVISION_FIDELITY_ADJUDICATION_PROMPT_DIGEST)
      .toBe("b38a96cf61fbbfdd0dfbc1b00c85dbf18a46a646a4aa46f9b41f0847b412e375");
    const residue = fixture();
    const evidenceDir = join(residue.stateDirs.math, "solution-fidelity-adjudication-evidence");
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, "checkpoint.123.tmp"), "partial immutable write");
    expect(verifyExamCorpus(residue), "tmp-only evidence directory must not force a new authority generation")
      .toMatchObject({ ok: true });
  });

  it.skipIf(!existsSync(join(SOLUTION_FIDELITY_ADJUDICATION_STATE, "problem.pdf"))
    || !existsSync(join(SOLUTION_FIDELITY_ADJUDICATION_STATE, "solution.pdf")))(
  "reconstructs Q20 fidelity adjudication and rejects partial, tampered, or orphan authority",
  async () => {
    const adjudicatedFixture = async () => {
      const files = fixture();
      const artifacts = await installSolutionFidelityAdjudication(files);
      return { files, artifacts };
    };
    const { files, artifacts } = await adjudicatedFixture();
    const modifiedBefore = statSync(files.dbPath).mtimeMs;
    const report = verifyExamCorpus(files);
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true });
    expect(statSync(files.dbPath).mtimeMs).toBe(modifiedBefore);
    const stateDir = files.stateDirs.math;
    const attestationName = readdirSync(join(stateDir, "answer-attestation"))
      .find((name) => /^v5-/u.test(name))!;
    const attestation = JSON.parse(readFileSync(join(stateDir, "answer-attestation", attestationName), "utf8"));
    const audit = JSON.parse(readFileSync(join(stateDir, attestation.answerAudit.path), "utf8"));
    const q20 = audit.solutionRepairs.find((repair: Record<string, any>) => repair.key === "8:20");
    expect(q20.revision).toMatchObject({
      fidelityArtifact: { path: expect.stringMatching(/^solution-fidelity-revisions\/v1-/u) },
      fidelityAdjudication: {
        allowlistId: SOLUTION_FIDELITY_ADJUDICATION_SPEC.allowlistId,
        sourceHash: SOLUTION_FIDELITY_ADJUDICATION_SPEC.sourceHash,
        adjudicationArtifact: { path: expect.stringMatching(/^solution-fidelity-adjudications\/v1-/u) },
      },
    });
    expect(audit.solutionFidelityItems.find((item: Record<string, unknown>) => item.key === "8:20"))
      .toMatchObject({
        answerStatus: "exact",
        explanationStatus: "exact",
        fidelityArtifact: { path: expect.stringMatching(/^solution-fidelity-adjudications\/v1-/u) },
      });
    const db = new Database(files.dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT answer, explanation FROM questions WHERE printed_number = '20'")
      .get() as { answer: string; explanation: string };
    db.close();
    expect(row.answer).toBe("③");
    expect(row.explanation).toContain("극솟값을 갖는다. (거짓)");

    const partial = await adjudicatedFixture();
    rmSync(partial.artifacts.childArtifact);
    expect(verifyExamCorpus(partial.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID"
        && failure.message.includes("adjudication child coverage"))).toBe(true);

    const tampered = await adjudicatedFixture();
    const child = JSON.parse(readFileSync(tampered.artifacts.childArtifact, "utf8"));
    child.item.explanationStatus = "mismatch";
    writeJson(tampered.artifacts.childArtifact, child);
    expect(verifyExamCorpus(tampered.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const pixelTamper = await adjudicatedFixture();
    const evidence = JSON.parse(readFileSync(pixelTamper.artifacts.evidenceArtifact, "utf8"));
    writeFileSync(
      join(pixelTamper.files.stateDirs.math, evidence.views[0].artifact.path),
      Buffer.from("not the attested PNG"),
    );
    expect(verifyExamCorpus(pixelTamper.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const orphan = await adjudicatedFixture();
    writeFileSync(
      join(
        orphan.files.stateDirs.math,
        "solution-fidelity-adjudications",
        `v1-0006-0020-${"f".repeat(64)}.json`,
      ),
      readFileSync(orphan.artifacts.childArtifact),
    );
    expect(verifyExamCorpus(orphan.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID"
        && (failure.message.includes("coverage") || failure.message.includes("orphan")))).toBe(true);

    const omitted = await adjudicatedFixture();
    rewriteSolutionRepairAuthority(omitted.files, (repair) => {
      delete repair.revision.fidelityAdjudication;
    });
    expect(verifyExamCorpus(omitted.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);
  }, 30_000);

  it.skipIf(!existsSync(join(SOLUTION_PROMPT_UPGRADE_STATE, "problem.pdf"))
    || !existsSync(join(SOLUTION_PROMPT_UPGRADE_STATE, "solution.pdf")))(
  "replays the pinned legacy prompt failure through one exact upgrade and rejects partial or extra chains",
  () => {
    const upgradedFixture = () => {
      const files = fixture();
      const artifacts = installSolutionPromptUpgrade(files);
      return { files, artifacts };
    };
    const { files, artifacts } = upgradedFixture();
    const modifiedBefore = statSync(files.dbPath).mtimeMs;
    const report = verifyExamCorpus(files);
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true });
    expect(statSync(files.dbPath).mtimeMs).toBe(modifiedBefore);
    expect(artifacts.upgradeArtifact).toContain("solution-revision-upgrades/v1-0001-0001-");
    expect(artifacts.upgradeFidelityArtifact)
      .toContain("solution-fidelity-revision-upgrades/v1-0001-0001-");
    expect(existsSync(artifacts.legacyRevisionArtifact)).toBe(true);
    const db = new Database(files.dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT answer, explanation FROM questions WHERE printed_number = '1'")
      .get() as { answer: string; explanation: string };
    db.close();
    expect(row.answer).toBe("②");
    expect(row.explanation).toContain("=3^1=3");
    const attestationName = readdirSync(join(files.stateDirs.math, "answer-attestation"))
      .find((name) => /^v5-/u.test(name))!;
    const attestation = JSON.parse(readFileSync(
      join(files.stateDirs.math, "answer-attestation", attestationName),
      "utf8",
    ));
    const audit = JSON.parse(readFileSync(
      join(files.stateDirs.math, attestation.answerAudit.path),
      "utf8",
    ));
    const semantic = JSON.parse(readFileSync(
      join(files.stateDirs.math, audit.semanticCheckpoint.path),
      "utf8",
    ));
    expect(audit.semanticCheckpoint.path).toBe(
      `semantic-choice-checks/v5-${audit.effectiveCorpusHash}-` +
      `${audit.effectiveSolutionCorpusHash}-${audit.semanticCheckpoint.inputHash}.json`,
    );
    expect(semantic.inputs.find((input: { key: string }) => input.key === "1:1"))
      .toMatchObject({ detailedExplanation: redactedExplanation(row.explanation) });
    expect(semantic.effectiveSolutionCorpusHash).toBe(audit.effectiveSolutionCorpusHash);

    const partial = upgradedFixture();
    rmSync(partial.artifacts.upgradeFidelityArtifact);
    expect(verifyExamCorpus(partial.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("child coverage"))).toBe(true);

    const tampered = upgradedFixture();
    const tamperedCheckpoint = JSON.parse(readFileSync(tampered.artifacts.upgradeArtifact, "utf8"));
    tamperedCheckpoint.item.answer = "3";
    writeJson(tampered.artifacts.upgradeArtifact, tamperedCheckpoint);
    expect(verifyExamCorpus(tampered.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const stale = upgradedFixture();
    const staleCheckpoint = JSON.parse(readFileSync(stale.artifacts.upgradeArtifact, "utf8"));
    staleCheckpoint.trigger.legacyPredecessor.failedEvidenceHash = "0".repeat(64);
    writeJson(stale.artifacts.upgradeArtifact, staleCheckpoint);
    expect(verifyExamCorpus(stale.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const orphan = upgradedFixture();
    writeFileSync(
      join(orphan.files.stateDirs.math, "solution-revision-upgrades", `v1-0001-0001-${"f".repeat(64)}.json`),
      readFileSync(orphan.artifacts.upgradeArtifact),
    );
    expect(verifyExamCorpus(orphan.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const missing = upgradedFixture();
    rmSync(missing.artifacts.upgradeArtifact);
    rmSync(missing.artifacts.upgradeFidelityArtifact);
    expect(verifyExamCorpus(missing.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID"
      && failure.message.includes("prompt upgrade is missing"))).toBe(true);
  });

  it("reconstructs one Q28 solution revision and rejects broken or repeated chains", () => {
    const files = fixture();
    const artifacts = installQ28SolutionRevision(files);
    const setupDb = new Database(files.dbPath, { readonly: true, fileMustExist: true });
    const setupRows = setupDb.prepare("SELECT printed_number, src_page FROM questions").all();
    setupDb.close();
    expect(setupRows).toContainEqual({ printed_number: "28", src_page: 1 });
    const revised = verifyExamCorpus(files);
    expect(revised, JSON.stringify(revised.failures)).toMatchObject({ ok: true });
    const db = new Database(files.dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT explanation FROM questions WHERE printed_number = '28'")
      .get() as { explanation: string };
    db.close();
    expect(row.explanation).toContain("\\lim_{x\\to-2}f(x)");
    expect(row.explanation).toContain("\\lim_{x\\to-2}g(x)");
    expect(row.explanation).toContain("크거나 같아야");

    const tamperedFiles = fixture();
    const tamperedArtifacts = installQ28SolutionRevision(tamperedFiles);
    const tampered = JSON.parse(readFileSync(tamperedArtifacts.revisionArtifact, "utf8"));
    tampered.item.explanation = "x→-2 줄을 다시 누락했다";
    writeJson(tamperedArtifacts.revisionArtifact, tampered);
    expect(verifyExamCorpus(tamperedFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const orphanFiles = fixture();
    installQ28SolutionRevision(orphanFiles);
    rewriteSolutionRepairAuthority(orphanFiles, (repair) => delete repair.revision);
    expect(verifyExamCorpus(orphanFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID"
      && failure.message.includes("sticky solution revision authority"))).toBe(true);

    const staleFiles = fixture();
    installQ28SolutionRevision(staleFiles);
    rewriteSolutionRepairAuthority(staleFiles, (repair) => {
      repair.revision.solutionArtifact.revisionPromptDigest = "0".repeat(64);
    });
    expect(verifyExamCorpus(staleFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("stale"))).toBe(true);

    const repeatedFiles = fixture();
    installQ28SolutionRevision(repeatedFiles);
    rewriteSolutionRepairAuthority(repeatedFiles, (repair) => {
      repair.revision.revision = { forbidden: true };
    });
    expect(verifyExamCorpus(repeatedFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("exact chain"))).toBe(true);

    const exactFirstFiles = fixture();
    installQ28SolutionRevision(exactFirstFiles, true);
    expect(verifyExamCorpus(exactFirstFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID"
      && failure.message.includes("terminal first repair"))).toBe(true);
    expect(artifacts.firstFidelityArtifact).toContain("solution-fidelity-repairs/v1-");
  });

  it("replays one persisted Q28 revision and rejects predecessor or partial-chain corruption", () => {
    const files = fixture();
    const artifacts = migratePersistedSolutionGeneration(files, 28);
    const report = verifyExamCorpus(files);
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true });
    const currentRevision = JSON.parse(readFileSync(artifacts.revisionArtifact!, "utf8"));
    expect(currentRevision.trigger).toMatchObject({
      kind: "persisted",
      persistedTriggerVersion: 1,
      predecessor: {
        revisionArtifact: {
          path: artifacts.historicalRevisionArtifact!.split(`${files.stateDirs.math}/`)[1],
        },
      },
    });

    const predecessorTamperFiles = fixture();
    const predecessorTamper = migratePersistedSolutionGeneration(predecessorTamperFiles, 28);
    const tampered = JSON.parse(readFileSync(predecessorTamper.revisionArtifact!, "utf8"));
    tampered.trigger.predecessor.diagnosticEvidence = "unbound predecessor evidence";
    writeJson(predecessorTamper.revisionArtifact!, tampered);
    expect(verifyExamCorpus(predecessorTamperFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const partialFiles = fixture();
    const partial = migratePersistedSolutionGeneration(partialFiles, 28);
    rmSync(partial.revisionFidelityArtifact!);
    expect(verifyExamCorpus(partialFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID"
      && failure.message.includes("child coverage"))).toBe(true);
  });

  it("stages a persisted Q28 revision before a sibling Q1 semantic revision", () => {
    const files = fixture();
    migratePersistedSolutionGeneration(files, 28, true);
    installCurrentQ1SemanticSibling(files);
    const report = verifyExamCorpus(files);
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true });
  });

  it("rejects a resolved current semantic decision with a null choice index", () => {
    const files = fixture();
    const artifacts = installQ1SemanticSolutionRevision(files);
    const semantic = JSON.parse(readFileSync(artifacts.finalSemanticArtifact, "utf8"));
    semantic.items[0].choiceIndex = null;
    const semanticHash = writeEvidence(artifacts.finalSemanticArtifact, semantic);
    rewriteSolutionAuditAuthority(files, (audit) => {
      audit.semanticCheckpoint.sha256 = semanticHash;
      audit.items.find((item: { key: string }) => item.key === "1:1").semantic.choiceIndex = null;
    });
    expect(verifyExamCorpus(files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID"
      && failure.message.includes("invalid semantic choice index"))).toBe(true);
  });

  it("reconstructs Q1 semantic-conflict revision with fresh marker authority", () => {
    const files = fixture();
    const artifacts = installQ1SemanticSolutionRevision(files);
    const report = verifyExamCorpus(files);
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true });
    expect(artifacts.preliminarySemanticArtifact).not.toBe(artifacts.finalSemanticArtifact);
    const stateDir = files.stateDirs.math;
    const attestationName = readdirSync(join(stateDir, "answer-attestation"))[0];
    const attestation = JSON.parse(
      readFileSync(join(stateDir, "answer-attestation", attestationName), "utf8"),
    );
    const audit = JSON.parse(readFileSync(join(stateDir, attestation.answerAudit.path), "utf8"));
    expect(audit.semanticCheckpoint.path).toBe(
      `semantic-choice-checks/v3-${audit.effectiveCorpusHash}-` +
      `${audit.effectiveSolutionCorpusHash}-${audit.semanticCheckpoint.inputHash}.json`,
    );
    expect(audit.derivedAnswerKeys).toEqual(["1:1"]);
    expect(audit.items.find((item: { key: string }) => item.key === "1:1").semantic).toEqual({
      status: "resolved",
      choiceIndex: 2,
      evidence: "계산값 3은 ②이다",
    });
    const db = new Database(files.dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT answer, explanation FROM questions WHERE printed_number = '1' AND question LIKE '$3%'")
      .get() as { answer: string; explanation: string };
    db.close();
    expect(row.answer).toBe("②");
    expect(row.explanation).toContain("=3");

    const staleGenerationFiles = fixture();
    installQ1SemanticSolutionRevision(staleGenerationFiles);
    rewriteSolutionRepairAuthority(staleGenerationFiles, (repair) => {
      repair.revision.trigger.semanticCheckpoint.effectiveCorpusHash = "0".repeat(64);
    });
    expect(verifyExamCorpus(staleGenerationFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("stale corpus generation"))).toBe(true);

    const tamperedSemanticFiles = fixture();
    const semanticArtifacts = installQ1SemanticSolutionRevision(tamperedSemanticFiles);
    const semantic = JSON.parse(readFileSync(semanticArtifacts.preliminarySemanticArtifact, "utf8"));
    semantic.items[0].evidence = "tampered diagnostic";
    writeJson(semanticArtifacts.preliminarySemanticArtifact, semantic);
    expect(verifyExamCorpus(tamperedSemanticFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const repeatedFiles = fixture();
    installQ1SemanticSolutionRevision(repeatedFiles);
    rewriteSolutionRepairAuthority(repeatedFiles, (repair) => {
      repair.revision.revision = { forbidden: true };
    });
    expect(verifyExamCorpus(repeatedFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("exact chain"))).toBe(true);
  });

  it("rejects stale fidelity metadata and non-marker not_visible answer authority", () => {
    const staleFiles = fixture();
    rewriteBaselineFidelityAuthority(staleFiles, "math", (checkpoint) => {
      checkpoint.promptDigest = "0".repeat(64);
    });
    const stale = verifyExamCorpus(staleFiles);
    expect(stale.ok).toBe(false);
    expect(stale.failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("stale"))).toBe(true);

    const derivedFiles = fixture();
    rewriteBaselineFidelityAuthority(derivedFiles, "math", (checkpoint) => {
      checkpoint.items[0].answerStatus = "not_visible";
      checkpoint.items[0].evidence = "the content answer is not visible";
    }, (audit) => {
      const item = audit.solutionFidelityItems.find((candidate: { key: string }) => candidate.key === "1:1");
      item.answerStatus = "not_visible";
      item.evidence = "the content answer is not visible";
      audit.derivedAnswerKeys = ["1:1"];
    });
    const derived = verifyExamCorpus(derivedFiles);
    expect(derived.ok).toBe(false);
    expect(derived.failures.some((failure) => failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);
  });

  it("requires exactly one post-commit answer attestation for every receipt", () => {
    const files = fixture();
    const attestationDir = join(files.stateDirs.math, "answer-attestation");
    for (const name of readdirSync(attestationDir)) rmSync(join(attestationDir, name));
    const report = verifyExamCorpus(files);
    expect(report.ok).toBe(false);
    expect(report.failures.some((failure) => failure.code === "ANSWER_ATTESTATION_MISSING")).toBe(true);

    const legacyFiles = fixture();
    const legacyDir = join(legacyFiles.stateDirs.math, "answer-attestation");
    const currentName = readdirSync(legacyDir)[0];
    const legacy = JSON.parse(readFileSync(join(legacyDir, currentName), "utf8"));
    legacy.version = 1;
    renameSync(join(legacyDir, currentName), join(legacyDir, currentName.replace(/^v2-/u, "v1-")));
    writeJson(join(legacyDir, currentName.replace(/^v2-/u, "v1-")), legacy);
    const legacyReport = verifyExamCorpus(legacyFiles);
    expect(legacyReport.failures.some((failure) =>
      failure.code === "ANSWER_ATTESTATION_MISSING")).toBe(true);
  });

  it("rejects legacy v3 classifications instead of bypassing the source-fidelity gate", () => {
    const files = fixture();
    const current = join(files.stateDirs.math, "classification-chunks", `v4-0000-${DIGEST}.json`);
    const legacy = join(files.stateDirs.math, "classification-chunks", `v3-0000-${DIGEST}.json`);
    renameSync(current, legacy);
    const checkpoint = JSON.parse(readFileSync(legacy, "utf8"));
    checkpoint.version = 3;
    writeJson(legacy, checkpoint);
    const report = verifyExamCorpus(files);
    expect(report.ok).toBe(false);
    expect(report.failures.some((failure) => failure.code === "CLASSIFICATION_MISSING")).toBe(true);
  });

  it("normalizes well-formed non-accept assignments but keeps accept validation strict", () => {
    const rejectedFiles = fixture();
    const rejectedPath = join(
      rejectedFiles.stateDirs.math,
      "classification-chunks",
      `v4-0000-${DIGEST}.json`,
    );
    const rejected = JSON.parse(readFileSync(rejectedPath, "utf8"));
    const rejectedItem = rejected.items.find((item: { decision: string }) => item.decision === "reject");
    Object.assign(rejectedItem, {
      canonical_subject: "math_B",
      curriculum_course: "ignored course",
      domain: "ignored domain",
      achievement_codes: ["12수학Ⅰ01-01"],
    });
    writeJson(rejectedPath, rejected);
    const normalizedReject = verifyExamCorpus(rejectedFiles);
    expect(normalizedReject, JSON.stringify(normalizedReject.failures)).toMatchObject({ ok: true });

    const reviewFiles = fixture();
    const reviewPath = join(
      reviewFiles.stateDirs.math,
      "classification-chunks",
      `v4-0000-${DIGEST}.json`,
    );
    const review = JSON.parse(readFileSync(reviewPath, "utf8"));
    const reviewItem = review.items.find((item: { decision: string }) => item.decision === "reject");
    Object.assign(reviewItem, {
      decision: "review",
      canonical_subject: "math_B",
      curriculum_course: "ignored course",
      domain: "ignored domain",
      achievement_codes: ["12수학Ⅰ01-01"],
    });
    writeJson(reviewPath, review);
    const normalizedReview = verifyExamCorpus(reviewFiles);
    expect(normalizedReview.failures.some((failure) => failure.code === "CLASSIFICATION_INVALID")).toBe(false);
    expect(normalizedReview.failures.some((failure) => failure.code === "REVIEW_COMMITTED")).toBe(true);

    const invalidAcceptFiles = fixture();
    const invalidAcceptPath = join(
      invalidAcceptFiles.stateDirs.math,
      "classification-chunks",
      `v4-0000-${DIGEST}.json`,
    );
    const invalidAccept = JSON.parse(readFileSync(invalidAcceptPath, "utf8"));
    const acceptedItem = invalidAccept.items.find((item: { decision: string }) => item.decision === "accept");
    acceptedItem.canonical_subject = "math_Z";
    writeJson(invalidAcceptPath, invalidAccept);
    const invalid = verifyExamCorpus(invalidAcceptFiles);
    expect(invalid.failures.some((failure) => failure.code === "CLASSIFICATION_INVALID")).toBe(true);
  });

  it("keeps the revision-parent scope allowlist byte-aligned with the importer", () => {
    expect(revisionScopeAdjudicationAllowlistFingerprint())
      .toBe(canonicalEvidenceHash(PROBLEM_REVISION_SCOPE_ADJUDICATION_ALLOWLIST));
  });

  it.skipIf(REVISION_SCOPE_CASES.some((testCase) => [
    "entry.json",
    "downloads.json",
    "problem.pdf",
    "solution.pdf",
    "problem-chunks/v2-0000.json",
    `classification-chunks/v5-0000-${DIGEST}.json`,
    "solution-chunks/v3-0000.json",
    ...testCase.firstPairs.flat(),
    ...testCase.revisionProblems,
    testCase.revisionClassification,
    ...testCase.supportingTerminals,
    testCase.triggerTerminal,
  ].some((relativePath) => !existsSync(join(testCase.stateDir, relativePath)))))
  ("reconstructs exact Q5/Q30 revision-parent scope children and rejects tamper or orphan authority", () => {
    for (const testCase of REVISION_SCOPE_CASES) {
      const files = fixture();
      const artifacts = installRevisionScopeFixture(files, testCase);
      const modifiedBefore = statSync(files.dbPath).mtimeMs;
      const report = verifyExamCorpus(files);
      expect(report, `${testCase.spec.key}: ${JSON.stringify(report.failures)}`).toMatchObject({ ok: true });
      expect(statSync(files.dbPath).mtimeMs).toBe(modifiedBefore);
      const child = JSON.parse(readFileSync(artifacts.childArtifact, "utf8"));
      expect(child).toMatchObject({
        version: 1,
        basis: {
          allowlistId: testCase.spec.allowlistId,
          key: testCase.spec.key,
          sourceHash: testCase.spec.sourceHash,
          solutionSourceHash: testCase.spec.solutionSourceHash,
          parentRevisionEvidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          trigger: {
            terminalCheckpoint: { sha256: testCase.spec.terminalArtifactHash },
            terminalItem: { status: "exact", scopeDecision: "reject" },
          },
        },
        items: [{
          decision: "reject",
          canonical_subject: null,
          curriculum_course: null,
          domain: null,
          achievement_codes: [],
          transcription_status: "exact",
        }],
      });
    }

    const tamperFiles = fixture();
    const tamper = installRevisionScopeFixture(tamperFiles, REVISION_SCOPE_CASES[1]);
    const child = JSON.parse(readFileSync(tamper.childArtifact, "utf8"));
    child.items[0].decision = "accept";
    writeJson(tamper.childArtifact, child);
    expect(verifyExamCorpus(tamperFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("hash mismatch"))).toBe(true);

    const orphanFiles = fixture();
    const orphan = installRevisionScopeFixture(orphanFiles, REVISION_SCOPE_CASES[0]);
    writeJson(join(
      orphan.stateDir,
      "classification-revision-scope-adjudications",
      `v1-0001-0005-${"1".repeat(64)}-${DIGEST}.json`,
    ), {});
    expect(verifyExamCorpus(orphanFiles).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("not declared"))).toBe(true);
  });

  it("fails closed on exclusions, review rows, missing official explanation, duplicates, and count drift", () => {
    const files = fixture();
    const mathClassification = join(files.stateDirs.math, "classification-chunks", `v4-0000-${DIGEST}.json`);
    const math = JSON.parse(readFileSync(mathClassification, "utf8"));
    math.items[0].achievement_codes = ["12미적Ⅱ-01-01"];
    writeJson(mathClassification, math);
    const mathSolution = join(files.stateDirs.math, "solution-chunks", "v3-0001.json");
    const solutionCheckpoint = JSON.parse(readFileSync(mathSolution, "utf8"));
    solutionCheckpoint.ownedTo = 9;
    writeJson(mathSolution, solutionCheckpoint);
    const koreanClassification = join(files.stateDirs.korean, "classification-chunks", `v4-0000-${DIGEST}.json`);
    const korean = JSON.parse(readFileSync(koreanClassification, "utf8"));
    Object.assign(korean.items[0], {
      decision: "review",
      canonical_subject: null,
      curriculum_course: null,
      domain: null,
      achievement_codes: [],
    });
    writeJson(koreanClassification, korean);
    const mathReceipt = JSON.parse(readFileSync(join(files.stateDirs.math, "receipt.json"), "utf8"));
    writeFileSync(join(files.dataDir, "files", mathReceipt.targetBooks[0].problemR2Key), "corrupt");

    const db = new Database(files.dbPath);
    db.prepare("UPDATE questions SET explanation = '' WHERE question = 'science question 1'").run();
    db.exec(`
      INSERT INTO questions
      (subject_id, source, qtype, question, choices, answer, explanation, difficulty, book_id,
       book_number, printed_number, src_file_id, src_page)
      SELECT subject_id, source, qtype, question, choices, answer, explanation, difficulty, book_id,
             book_number, printed_number, src_file_id, src_page
      FROM questions WHERE id = 2;
    `);
    db.close();

    const report = verifyExamCorpus(files);
    const codes = new Set(report.failures.map((failure) => failure.code));
    expect(report.ok).toBe(false);
    expect(codes.has("CURRICULUM_EXCLUSION")).toBe(true);
    expect(codes.has("REVIEW_COMMITTED")).toBe(true);
    expect(codes.has("OFFICIAL_EXPLANATION")).toBe(true);
    expect(codes.has("DUPLICATE_QUESTION")).toBe(true);
    expect(report.failureCount).toBeGreaterThan(codes.size);

    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(runCli(["--manifest", files.manifestPath, "--db", files.dbPath, "--data-dir", files.dataDir], {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    })).toBe(1);
    expect(JSON.parse(stdout[0]).ok).toBe(false);
    expect(stderr[0]).toMatch(/^FAIL corpus:/);
  });

  it("rejects grade-gate and duplicate display-title manifest drift before reading DB", () => {
    const gradeFiles = fixture();
    const gradeManifest = JSON.parse(readFileSync(gradeFiles.manifestPath, "utf8"));
    gradeManifest.entries.find((entry: { subject: string }) => entry.subject === "통합과학").grade = 3;
    writeJson(gradeFiles.manifestPath, gradeManifest);
    expect(() => verifyExamCorpus(gradeFiles)).toThrow(/integrated subjects require source grade 1 or 2/);

    const titleFiles = fixture();
    const titleManifest = JSON.parse(readFileSync(titleFiles.manifestPath, "utf8"));
    titleManifest.entries[1].rawTitle = titleManifest.entries[0].rawTitle;
    writeJson(titleFiles.manifestPath, titleManifest);
    expect(() => verifyExamCorpus(titleFiles)).toThrow(/duplicate manifest display title/);
  });
});
