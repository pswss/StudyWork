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
import { describe, expect, it, vi } from "vitest";

const providerMock = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("../src/codex-provider", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/codex-provider")>(),
  getCodexProvider: () => ({ complete: providerMock.complete }),
}));
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
  manualClassificationPolicyRevisionAllowlistFingerprint,
  manualRevisionAllowlistFingerprint,
  manualSourceRevisionAllowlistFingerprint,
  officialAnswerForDb,
  persistedTerminalRecoveryHydrationAllowlistFingerprint,
  problemManualAdjudicationAllowlistForTest,
  positiveRepairScopeAdjudicationAllowlistFingerprint,
  repairScopeAdjudicationAllowlistFingerprint,
  revisionScopeAdjudicationAllowlistFingerprint,
  runCli,
  solutionFalseNegativeRepairAllowlistFingerprint,
  solutionSourceRevisionAllowlistFingerprint,
  solutionFidelityAdjudicationAllowlistFingerprint,
  solutionPromptUpgradeAllowlistFingerprint,
  scopeBoxRevisionAllowlistFingerprint,
  terminalFidelityAdjudicationAllowlistFingerprint,
  TARGET_SUBJECTS,
  verifyExamCorpus,
  verifyProblemManualAdjudicationForTest,
  verifyPersistedProblemRepairOverlapForTest,
  verifyCurrentSolutionFalseNegativeRepairForTest,
  verifyCurrentSolutionFidelityForTest,
  verifySolutionFalseNegativeRepairAuthorityForTest,
  verifyPersistedSolutionFalseNegativeStateForTest,
  verificationContractAuditVersionForTest,
} from "../scripts/verify-exam-corpus";
import {
  applyAllowlistedProblemManualCorrection,
  applyAllowlistedProblemManualRevision,
  applyAllowlistedProblemManualSourceRevision,
  adjudicateProblemManual,
  auditAcceptedSolutions,
  baseDifficultyByQuestionKey,
  buildCorpusReceipt,
  CLASSIFIER_DIGEST,
  CLASSIFIER_VERSION,
  CURRICULUM_RULES_SHA256,
  commitCorpusEntry,
  EXISTING_CORPUS_MIGRATION_ALLOWLIST,
  parseCorpusManifest,
  parseDecisions,
  PERSISTED_TERMINAL_RECOVERY_HYDRATION_ALLOWLIST,
  PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST,
  PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_PROMPT_DIGEST,
  PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_VERSION,
  PROBLEM_TERMINAL_FIDELITY_POLICY_REVISION_DIGEST,
  PROBLEM_TERMINAL_FIDELITY_POLICY_REVISION_VERSION,
  PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST,
  PROBLEM_MANUAL_ADJUDICATION_PROMPT_DIGEST,
  PROBLEM_MANUAL_CORRECTION_DIGEST,
  PROBLEM_MANUAL_CLASSIFICATION_POLICY_REVISION_ALLOWLIST,
  PROBLEM_MANUAL_CLASSIFICATION_POLICY_REVISION_DIGEST,
  PROBLEM_MANUAL_CLASSIFICATION_POLICY_REVISION_VERSION,
  PROBLEM_MANUAL_REVISION_ALLOWLIST,
  PROBLEM_MANUAL_REVISION_CORRECTION_DIGEST,
  PROBLEM_MANUAL_REVISION_PROMPT_DIGEST,
  PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST,
  PROBLEM_MANUAL_SOURCE_REVISION_CORRECTION_DIGEST,
  PROBLEM_MANUAL_SOURCE_REVISION_PROMPT_DIGEST,
  PROBLEM_REPAIR_SCOPE_ADJUDICATION_ALLOWLIST,
  PROBLEM_REPAIR_SCOPE_ADJUDICATION_PROMPT_DIGEST,
  PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_ALLOWLIST,
  PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_PROMPT_DIGEST,
  PROBLEM_REPAIR_POSITIVE_SCOPE_AUTHORITY_REASON_CODE,
  PROBLEM_REVISION_SCOPE_ADJUDICATION_ALLOWLIST,
  PROBLEM_REVISION_SCOPE_ADJUDICATION_PROMPT_DIGEST,
  applyAllowlistedProblemScopeBoxRevision,
  matchOfficialSolutions,
  PROBLEM_SCOPE_BOX_REVISION_ALLOWLIST,
  PROBLEM_SCOPE_BOX_REVISION_CORRECTION_DIGEST,
  PROBLEM_SCOPE_BOX_REVISION_PROMPT_DIGEST,
  PROBLEM_SCOPE_BOX_REVISION_VERSION,
  repairAndAuditOfficialAnswers,
  SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST,
  SOLUTION_SOURCE_REVISION_ALLOWLIST,
  SOLUTION_PROMPT_UPGRADE_ALLOWLIST,
  SOLUTION_PROMPT_UPGRADE_FIDELITY_VERSION,
  SOLUTION_PROMPT_UPGRADE_VERSION,
  SOLUTION_REVISION_FIDELITY_ADJUDICATION_ALLOWLIST,
  SOLUTION_REVISION_FIDELITY_ADJUDICATION_PROMPT_DIGEST,
  SOLUTION_REVISION_FIDELITY_ADJUDICATION_VERSION,
  LEGACY_TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
  resolveOfficialAnswer,
  writeAnswerAttestation,
  type ClassifiedQuestion,
  type ClassificationDecision,
  type PdfEvidence,
  type ProblemRecoveryEvidence,
} from "../scripts/import-exam-corpus";
import type { QuizItemEx, SolutionItem } from "../src/claude";

const Q5525982_STATE = join(process.cwd(), "data/import-exam-corpus/bb876a67170089dfb2022f47");
const Q5525982_FIDELITY_ROWS = [
  ["6:16", 10, "exact", "exact", "10쪽에 ‘16. 세부 내용 추론’과 ‘정답 ②’가 명시되어 있다. 해설은 10쪽에서 시작해 11쪽의 ⑤ 설명까지 이어지며, supplied explanation과 빠짐없이 일치한다."],
  ["7:17", 11, "exact", "exact", "11쪽에 ‘17. 핵심 정보 파악’과 ‘정답 ④’가 보인다. 분석 명제·동의적 표현의 순환론 설명과 오답 ①·②·③·⑤가 모두 supplied explanation과 일치한다."],
  ["7:18", 11, "exact", "exact", "11쪽에 ‘18. 반응의 적절성 평가’와 ‘정답 ⑤’가 명시되어 있다. 해설은 12쪽의 오답 ④까지 계속되며 전체 내용이 supplied explanation과 일치한다."],
  ["7:19", 12, "exact", "exact", "12쪽에 ‘19. 내용의 비판적 이해’와 ‘정답 ⑤’가 보인다. 총체주의에 대한 비판 및 오답 ①~④의 설명이 모두 정확히 일치한다."],
  ["7:20", 12, "exact", "exact", "12쪽에서 ‘20. 어휘의 문맥적 의미 파악’이 시작되고, 13쪽에 결론 ‘다다르다’, ‘정답 ②’ 및 오답 ①·③·④·⑤가 보인다. supplied explanation과 일치한다."],
  ["9:21", 14, "exact", "exact", "14쪽에 ‘21. 외적 준거에 따른 작품 감상’과 ‘정답 ④’가 명시되어 있다. 윤씨와 지영에 관한 정답 해설부터 오답 ⑤까지 모두 supplied explanation과 일치한다."],
  ["9:22", 14, "exact", "exact", "14쪽에 ‘22. 작품의 종합적 이해’와 ‘정답 ④’가 보인다. 해설은 15쪽의 오답 ③·⑤까지 이어지며 supplied explanation 전체와 일치한다."],
  ["9:23", 15, "exact", "exact", "15쪽에 ‘23. 감상의 적절성 평가’와 ‘정답 ⑤’가 명시되어 있다. 용골대의 발언에 대한 판단과 오답 ①~④가 모두 일치한다."],
  ["9:24", 15, "exact", "exact", "15쪽에서 ‘24. 구절의 의미 파악’이 시작되고 ‘정답 ③’이 명시되어 있다. 해설은 16쪽의 오답 ④·⑤까지 이어지며 supplied explanation과 일치한다."],
  ["9:25", 16, "exact", "exact", "16쪽에 ‘25. 작품의 내용 파악’과 ‘정답 ③’이 보인다. 김씨 부인의 만류와 지영의 행동을 설명한 정답 해설 및 오답 ①·②·④·⑤가 모두 일치한다."],
  ["9:26", 16, "exact", "exact", "16쪽에 ‘26. 서술상의 특징 파악’과 ‘정답 ⑤’가 명시되어 있다. 현재형 시제와 긴박감에 관한 해설 및 오답 ①~④가 supplied explanation과 일치한다."],
  ["11:27", 17, "exact", "exact", "17쪽에 ‘27. 작품의 내용 파악’과 ‘정답 ②’가 보인다. 해설은 18쪽에서 오답 ⑤의 마지막 결론까지 계속되며 supplied explanation과 완전히 일치한다."],
  ["11:28", 18, "exact", "exact", "18쪽에 ‘28. 외적 준거에 따른 작품 감상’과 ‘정답 ②’가 명시되어 있다. ㉠·㉡의 갈등에 관한 정답 해설과 오답 ①·③·④·⑤가 모두 일치한다."],
  ["11:29", 18, "exact", "exact", "18쪽에 ‘29. 작품 간의 공통점, 차이점 파악’과 ‘정답 ①’이 보인다. 오답 해설은 19쪽의 ②·③·④·⑤까지 이어지며 supplied explanation 전체와 일치한다."],
  ["11:30", 19, "exact", "exact", "19쪽에서 30번이 시작하며 명시적 정답은 ②이다. 정답해설과 오답 ①·③·④·⑤의 설명이 모두 공급본과 일치한다."],
  ["12:31", 19, "exact", "exact", "31번은 19쪽에서 시작해 20쪽으로 이어진다. 명시적 정답 ④와 정답해설 및 오답 ①·②·③·⑤ 전체가 일치한다."],
  ["12:32", 20, "exact", "exact", "20쪽에서 32번이 시작하며 명시적 정답은 ③이다. 정답해설과 오답 ①·②·④·⑤ 설명이 모두 일치한다."],
  ["13:33", 21, "exact", "exact", "21쪽에서 33번이 시작하며 명시적 정답은 ⑤이다. F의 셀룰로스 분해 설명과 오답 ①~④의 근거가 모두 일치한다."],
  ["13:34", 22, "exact", "exact", "22쪽에서 34번이 시작하며 명시적 정답은 ④이다. ⓐ·ⓑ·ⓒ, pH 5.8·5.5·5.0·6.0 등 모든 값과 결론이 일치한다."],
  ["13:35", 22, "exact", "exact", "35번은 22쪽에서 시작해 23쪽 첫 부분까지 이어진다. 명시적 정답 ①과 정답해설 및 오답 ②의 끝 문장까지 일치한다."],
  ["13:36", 23, "exact", "exact", "23쪽에서 36번이 시작하며 명시적 정답은 ③이다. 숙신산·젖산의 배출 조건과 오답 ①·②·④·⑤ 설명이 모두 일치한다."],
  ["14:37", 24, "exact", "exact", "24쪽에서 37번이 시작하며 명시적 정답은 ③이다. 문단별 중심 내용과 오답 ①·②·④·⑤ 설명이 모두 일치한다."],
  ["15:38", 24, "exact", "exact", "24쪽에서 38번이 시작하며 명시적 정답은 ④이다. ‘중요한 사항’에 관한 추론과 오답 ①·②·③·⑤ 설명이 모두 일치한다."],
  ["15:39", 24, "exact", "exact", "39번은 24쪽에서 시작해 25쪽으로 이어진다. 명시적 정답 ⑤와 보험료율=보험료/보험금, 두 배 관계, 기댓값 및 오답 설명 전체가 일치한다."],
  ["15:40", 25, "exact", "mismatch", "25쪽의 명시적 정답은 ①이고 공급된 정답해설 문단도 일치한다. 그러나 PDF에 이어지는 [오답피하기] ②·③·④·⑤ 전체가 공급 설명에서 누락되었다."],
  ["15:41", 26, "exact", "mismatch", "26쪽의 명시적 정답은 ④이고 공급된 정답해설 문단도 일치한다. 그러나 PDF의 [오답피하기] ①·②·③·⑤가 전부 누락되었다."],
  ["15:42", 26, "exact", "mismatch", "42번은 26쪽에서 시작하며 명시적 정답은 ①이다. 공급된 정답해설은 일치하지만, 26~27쪽의 [오답피하기] ②·③·④·⑤가 누락되었다."],
  ["16:43", 27, "exact", "mismatch", "27쪽의 명시적 정답은 ③이고 공급된 정답해설 문단도 일치한다. 그러나 PDF의 [오답피하기] ①·②·④·⑤가 누락되었다."],
  ["16:44", 27, "exact", "mismatch", "44번은 27쪽에서 시작해 28쪽으로 이어지며 명시적 정답은 ⑤이다. 공급된 정답해설은 일치하지만 28쪽의 [오답피하기] ①·②·③·④가 누락되었다."],
  ["16:45", 28, "exact", "mismatch", "28쪽의 명시적 정답은 ①이고 공급된 정답해설 문단도 일치한다. 그러나 PDF의 [오답피하기] ②·③·④·⑤가 누락되었다."],
] as const;

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
const Q31_Q32_5578421_MANUAL_SPECS = ["12:31", "12:32"].map((key) =>
  PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((spec) =>
    spec.entryId === "ebsi:5578421" && spec.key === key)!,
);
const Q19_Q21_5578421_MANUAL_SPECS = ["8:19", "8:20", "8:21"].map((key) =>
  PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((spec) =>
    spec.entryId === "ebsi:5578421" && spec.key === key)!,
);
const Q44_Q45_5578421_MANUAL_SPECS = ["16:44", "16:45"].map((key) =>
  PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((spec) =>
    spec.entryId === "ebsi:5578421" && spec.key === key)!,
);
const Q14_5578421_MANUAL_SPEC = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((spec) =>
  spec.entryId === "ebsi:5578421" && spec.key === "5:14")!;
const Q12_5578421_MANUAL_SPEC = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((spec) =>
  spec.entryId === "ebsi:5578421" && spec.key === "4:12")!;
const Q43_5578421_MANUAL_SPEC = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((spec) =>
  spec.entryId === "ebsi:5578421" && spec.key === "16:43")!;
const Q38_5578421_MANUAL_SPEC = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((spec) =>
  spec.entryId === "ebsi:5578421" && spec.key === "15:38")!;
const Q3_V2_5578421_MANUAL_SPEC = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((spec) =>
  spec.allowlistId === "ebsi-5578421-q3-manual-v2")!;
const Q2_5578421_MANUAL_SPEC = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((spec) =>
  spec.entryId === "ebsi:5578421" && spec.key === "1:2")!;
const Q2_5578421_MANUAL_REVISION_SPEC = PROBLEM_MANUAL_REVISION_ALLOWLIST.find((spec) =>
  spec.entryId === "ebsi:5578421" && spec.key === "1:2")!;
const Q2_5578421_MANUAL_SOURCE_REVISION_SPEC = PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST.find((spec) =>
  spec.entryId === "ebsi:5578421" && spec.key === "1:2")!;
const Q30_MANUAL_REVISION_SPEC = PROBLEM_MANUAL_REVISION_ALLOWLIST.find((spec) =>
  spec.entryId === "ebsi:5578421" && spec.key === "12:30")!;
const Q18_MANUAL_REVISION_SPEC = PROBLEM_MANUAL_REVISION_ALLOWLIST.find((spec) =>
  spec.entryId === "ebsi:5656593" && spec.key === "7:18")!;
const Q32_MANUAL_REVISION_SPEC = PROBLEM_MANUAL_REVISION_ALLOWLIST.find((spec) =>
  spec.entryId === "ebsi:5525982" && spec.key === "12:32")!;
const Q18_MANUAL_STATE = join(process.cwd(), "data/import-exam-corpus/714fd4581f778a9c559fd16e");
const Q18_MANUAL_SPEC = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((spec) =>
  spec.entryId === "ebsi:5656593" && spec.key === "7:18")!;
const Q30_FAILED_PROBLEM_PATH = join(
  Q30_MANUAL_STATE,
  "problem-recoveries/v1-0012-0030-20741052441e79627764f61577085ececd18660f475b4a29a4860b98175ef1d7.json",
);
const Q30_FAILED_CLASSIFICATION_PATH = join(
  Q30_MANUAL_STATE,
  "classification-recoveries/v1-0012-0030-7cc21907e44db72c61eb6a182cdd540f771bbc0efab4cae799c5bd681b53819c-7bb7cb863c8c4855.json",
);
const Q30_PARENT_MANUAL_CLASSIFICATION_PATH = join(
  Q30_MANUAL_STATE,
  "classification-manual-adjudications/" +
    "v1-0012-0030-2415dd634f5b3bde1fa8113d4e6d2f6900a418dcc2d37da64067839a1ff2c9ae-" +
    "7bb7cb863c8c4855.json",
);
const Q18_PARENT_MANUAL_CLASSIFICATION_PATH = join(
  Q18_MANUAL_STATE,
  "classification-manual-adjudications/" +
    "v1-0007-0018-cab56b019c32271261bcb7389650c4d60fb52e22913de90a47412785e53752dc-" +
    "7bb7cb863c8c4855.json",
);
const Q27_MANUAL_STATE = join(process.cwd(), "data/import-exam-corpus/bb876a67170089dfb2022f47");
const Q32_PARENT_MANUAL_CLASSIFICATION_PATH = join(
  Q27_MANUAL_STATE,
  "classification-manual-adjudications/" +
    "v1-0012-0032-c6e839e3df8530932fb31a0f4b5544686d45ce0e8cff5c3222104fa320be531f-" +
    "7bb7cb863c8c4855.json",
);
const Q32_FIRST_MANUAL_REVISION_CLASSIFICATION_PATH = join(
  Q27_MANUAL_STATE,
  "classification-manual-revisions/" +
    "v1-0012-0032-e0cf084146f55db4994304b3ddb21a1a57e563ea052d32951ebd2be286c4f860-" +
    "7bb7cb863c8c4855.json",
);
const MANUAL_REVISION_PARENT_CLASSIFICATIONS = new Map([
  [Q30_MANUAL_REVISION_SPEC.allowlistId, Q30_PARENT_MANUAL_CLASSIFICATION_PATH],
  [Q18_MANUAL_REVISION_SPEC.allowlistId, Q18_PARENT_MANUAL_CLASSIFICATION_PATH],
  [Q32_MANUAL_REVISION_SPEC.allowlistId, Q32_PARENT_MANUAL_CLASSIFICATION_PATH],
]);
const Q9_MANUAL_STATE = join(process.cwd(), "data/import-exam-corpus/a915803b3da3a6ea056eecd6");
const Q9_MANUAL_SPEC = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((spec) =>
  spec.entryId === "ebsi:5854871" && spec.key === "2:9")!;
const Q9_WRITING_MANUAL_STATE = join(process.cwd(), "data/import-exam-corpus/4142baa37330a6d3d470294a");
const Q9_WRITING_MANUAL_SPEC = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((spec) =>
  spec.entryId === "ebsi:5594499" && spec.key === "4:9")!;
const Q43_MANUAL_STATE = join(process.cwd(), "data/import-exam-corpus/4745f3573f575a93f6adcccb");
const Q43_MANUAL_SPEC = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((spec) =>
  spec.entryId === "ebsi:5577054" && spec.key === "16:43")!;
const Q27_MANUAL_SPEC = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((spec) =>
  spec.entryId === "ebsi:5525982" && spec.key === "11:27")!;
const Q43_TO_45_MANUAL_SPECS = ["16:43", "16:44", "16:45"].map((key) =>
  PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((spec) =>
    spec.entryId === "ebsi:5525982" && spec.key === key)!,
);
const Q8_Q16_MANUAL_SPECS = ["4:8", "6:16"].map((key) =>
  PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((spec) =>
    spec.entryId === "ebsi:5525982" && spec.key === key)!,
);
const Q17_Q20_MANUAL_SPECS = ["7:17", "7:18", "7:19", "7:20"].map((key) =>
  PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((spec) =>
    spec.entryId === "ebsi:5525982" && spec.key === key)!,
);
const Q23_Q29_MANUAL_SPECS = ["9:23", "11:28", "11:29"].map((key) =>
  PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((spec) =>
    spec.entryId === "ebsi:5525982" && spec.key === key)!,
);
const Q30_Q42_MANUAL_GROUPS = [
  ["11:30"],
  ["12:31", "12:32"],
  ["14:37"],
  ["15:38", "15:39", "15:40", "15:41", "15:42"],
] as const;
const Q30_Q42_MANUAL_SPECS = Q30_Q42_MANUAL_GROUPS.flat().map((key) =>
  PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((spec) =>
    spec.entryId === "ebsi:5525982" && spec.key === key)!,
);
const Q6_Q26_MANUAL_SPECS = ["3:6", "3:7", "9:21", "9:22", "9:24", "9:25", "9:26"]
  .map((key) => PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((spec) =>
    spec.entryId === "ebsi:5525982" && spec.key === key)!,
  );
const Q32_MANUAL_SOURCE_REVISION_SPEC = PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST[0];
const Q8_TERMINAL_ADJUDICATION_STATE = join(
  process.cwd(),
  "data/import-exam-corpus/7755c70fefaa45f755086e2b",
);
const PERSISTED_TERMINAL_RECOVERY_STATE = join(
  process.cwd(),
  "data/import-exam-corpus/c83035d36ef8d2b8f1bfe856",
);
const Q8_TERMINAL_ADJUDICATION_DB = join(process.cwd(), "data/studywork.db");
const Q43_CORRECTED_SOLUTION =
  "(가)에서는 ‘여기 하나의 상심한 사람이 있다.’와 ‘여기 하나의 굳세게 살아온 인생이 있다.’와 " +
  "같이 변주함으로써 주제 의식을 강조하고 있고, (나)에서는 ‘더 추워야겠다’와 ‘한껏 " +
  "가난해져야겠다’와 같이 유사한 시구를 변주함으로써 주제 의식을 강조하고 있다. [오답풀이] " +
  "① (가)에서는 마지막 부분에서 유사한 시구가 반복되기는 하지만 역동적 측면을 부각하는 것은 " +
  "아니며, (나)에서는 점층적 부분이 드러난다고 보기 어렵다. ② (가)에서는 의성어의 활용이 " +
  "드러나지 않고, (나)에서는 ‘카랑카랑’을 통해 새들의 목소리를 표현하고 있다. ④ 반어적 표현은 " +
  "(가)와 (나) 모두 찾기 어렵다. ⑤ 여정에 따른 공간 이동은 (가)와 (나) 모두 나타나지 않는다.";
const MANUAL_FAILED_ARTIFACTS = new Map([
  [Q30_MANUAL_SPEC.allowlistId, {
    problem: Q30_FAILED_PROBLEM_PATH,
    classification: Q30_FAILED_CLASSIFICATION_PATH,
  }],
  [Q18_MANUAL_SPEC.allowlistId, {
    problem: join(
      Q18_MANUAL_STATE,
      "problem-recoveries/v1-0007-0018-8dc9e3101914ced2b5380528cdf56f5c607f0911f8a4f4460835260ae4cd6b3a.json",
    ),
    classification: join(
      Q18_MANUAL_STATE,
      "classification-recoveries/v1-0007-0018-eadc507490e4723cf09f622b2231222ff5cb12db3609ab381b79951dc1de3144-7bb7cb863c8c4855.json",
    ),
  }],
  [Q9_MANUAL_SPEC.allowlistId, {
    problem: join(
      Q9_MANUAL_STATE,
      "problem-recoveries/v1-0002-0009-ce5a6650673a79cd5cebf9a1d0593bcc75f9acd7fc5a57551ea1becf69e443d5.json",
    ),
    classification: join(
      Q9_MANUAL_STATE,
      "classification-recoveries/v1-0002-0009-284f685922e94c9eca6aef2dc7cb776f8ee4fc04601b32ecf959f840d264fc34-7bb7cb863c8c4855.json",
    ),
  }],
  [Q9_WRITING_MANUAL_SPEC.allowlistId, {
    problem: join(
      Q9_WRITING_MANUAL_STATE,
      "problem-recoveries/v1-0004-0009-bddde1723f11b47836bb403b1415e8663a05efb246e6d6d51157be0a9c1b5cf0.json",
    ),
    classification: join(
      Q9_WRITING_MANUAL_STATE,
      "classification-recoveries/v1-0004-0009-fecdbfac299fdcff5ae6e0aea267b5f41cdad60c684639b8d2e2160e937de6d2-7bb7cb863c8c4855.json",
    ),
  }],
  [Q43_MANUAL_SPEC.allowlistId, {
    problem: join(
      Q43_MANUAL_STATE,
      "problem-recoveries/v1-0016-0043-9f785a5c7a2c2ae2813ddce7acae5e846c5b29d63a7f37def793f9fd05e8a4d1.json",
    ),
    classification: join(
      Q43_MANUAL_STATE,
      "classification-recoveries/v1-0016-0043-921b9df51f48b859874f6130f78341df54117e62171d973f74c7f115d64f36a7-7bb7cb863c8c4855.json",
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

function q5525982FidelityDecisions(prompt: string) {
  const inputs = JSON.parse(prompt.split("Accepted solutions:\n")[1]) as Array<{ key: string }>;
  const byKey = new Map<string, { key: string; sourcePage: number; answerStatus: "exact"; explanationStatus: "exact" | "mismatch"; evidence: string }>(Q5525982_FIDELITY_ROWS.map(([key, sourcePage, answerStatus, explanationStatus, evidence]) =>
    [key, { key, sourcePage, answerStatus, explanationStatus, evidence }]));
  return inputs.map(({ key }) => {
    const decision = byKey.get(key);
    if (!decision) throw new Error(`missing frozen solution fidelity row: ${key}`);
    return decision;
  });
}

function q5525982CorrectedSolution(solutions: SolutionItem[], key: string): SolutionItem {
  const spec = SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0].items.find((item) => item.key === key);
  if (!spec) throw new Error(`missing forced solution repair row: ${key}`);
  const number = Number(key.split(":")[1]);
  const base = structuredClone(solutions.find((solution) => Number(solution.number) === number)!);
  for (const replacement of spec.replacements) {
    expect(base.explanation.split(replacement.from)).toHaveLength(replacement.count + 1);
    base.explanation = base.explanation.split(replacement.from).join(replacement.to);
  }
  if ("appendExplanation" in spec) base.explanation += `\n\n${spec.appendExplanation}`;
  expect(canonicalEvidenceHash(base)).toBe(spec.expectedSolutionItemHash);
  return base;
}

function q5525982FixtureInputs(stateDir: string) {
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
      "utf8",
    )).items,
    questions,
    entry,
  );
  const byKey = new Map(decisions.map((decision) => [decision.key, decision]));
  const classified: ClassifiedQuestion[] = questions.map((question) => ({
    question,
    classification: byKey.get(`${question.page}:${Number(question.number)}`)!,
  }));
  const solutions = readdirSync(join(stateDir, "solution-chunks"))
    .filter((name) => /^v3-\d{4}\.json$/u.test(name)).sort()
    .flatMap((name) => JSON.parse(readFileSync(join(stateDir, "solution-chunks", name), "utf8")).items) as
    SolutionItem[];
  return { entry, problem, solution, classified, solutions };
}

function q5525982VerifierAuthorityInput(
  stateDir: string,
  effectiveClassified?: ClassifiedQuestion[],
) {
  const input = q5525982FixtureInputs(stateDir);
  if (effectiveClassified) input.classified = effectiveClassified;
  const terminalName = readdirSync(join(stateDir, "problem-terminal-fidelity"))
    .find((name) => name.includes(SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0].effectiveProblemCorpusHash))!;
  const terminal = JSON.parse(readFileSync(join(stateDir, "problem-terminal-fidelity", terminalName), "utf8"));
  const byKey = new Map(input.classified.map((record) => [
    `${record.question.page}:${Number(record.question.number)}`,
    record,
  ]));
  for (const [index, value] of (effectiveClassified
    ? []
    : terminal.inputs as Array<Record<string, unknown>>).entries()) {
    const key = String(value.key);
    const current = byKey.get(key);
    if (!current) throw new Error(`missing terminal effective row: ${key}`);
    current.question = {
      ...current.question,
      question: String(value.question),
      choices: value.choices as string[] | null,
      qtype: value.qtype as QuizItemEx["qtype"],
      figure: Boolean(value.figure),
      figure_description: value.figure_description as string | null,
      box: value.box as [number, number] | null,
    };
    const item = terminal.items[index] as Record<string, unknown>;
    current.classification = {
      ...current.classification,
      transcription_status: item.status as ClassificationDecision["transcription_status"],
      transcription_evidence: String(item.evidence),
      decision: item.scopeDecision as ClassificationDecision["decision"],
      confidence: Number(item.scopeConfidence),
      ...(item.scopeDecision === "accept" ? {} : {
        canonical_subject: null,
        curriculum_course: null,
        domain: null,
        achievement_codes: [],
      }),
    };
  }
  return {
    stateDir,
    entry: input.entry,
    problemEvidence: { ...input.problem, path: "problem.pdf", requestedUrl: input.problem.resolvedUrl },
    solutionEvidence: { ...input.solution, path: "solution.pdf", requestedUrl: input.solution.resolvedUrl },
    rulesDigest: String(terminal.rulesDigest),
    effective: {
      problems: new Map(input.classified.map((record) => [
        `${record.question.page}:${Number(record.question.number)}`,
        {
          key: `${record.question.page}:${Number(record.question.number)}`,
          page: record.question.page,
          printedNumber: String(Number(record.question.number)),
          qtype: record.question.qtype,
          difficulty: record.question.difficulty,
          question: record.question.question,
          choices: record.question.choices,
          answer: record.question.answer,
          evidence: record.question,
        },
      ])),
      accepted: [],
      rejected: 0,
      reviews: 0,
      rulesDigest: String(terminal.rulesDigest),
      order: input.classified.map((record) => `${record.question.page}:${Number(record.question.number)}`),
      records: new Map(input.classified.map((record) => {
        const key = `${record.question.page}:${Number(record.question.number)}`;
        const problem = {
          key,
          page: record.question.page,
          printedNumber: String(Number(record.question.number)),
          qtype: record.question.qtype,
          difficulty: record.question.difficulty,
          question: record.question.question,
          choices: record.question.choices,
          answer: record.question.answer,
          evidence: record.question,
        };
        return [key, {
          question: problem,
          classification: record.classification,
          problemCheckpoint: { path: "test", sha256: "0".repeat(64) },
          classificationCheckpoint: { path: "test", sha256: "0".repeat(64) },
          contextFrom: 1,
          contextTo: 16,
        }];
      })),
    },
    baseSolutions: new Map(input.solutions.map((solution) => {
      const checkpointName = readdirSync(join(stateDir, "solution-chunks")).find((name) => {
        const checkpoint = JSON.parse(readFileSync(join(stateDir, "solution-chunks", name), "utf8"));
        return checkpoint.items.some((item: SolutionItem) => Number(item.number) === Number(solution.number));
      })!;
      const checkpoint = JSON.parse(readFileSync(join(stateDir, "solution-chunks", checkpointName), "utf8"));
      return [String(Number(solution.number)), {
        printedNumber: String(Number(solution.number)),
        rawAnswer: solution.answer,
        explanation: solution.explanation,
        page: solution.page,
        evidence: solution,
        checkpoint: {
          path: `solution-chunks/${checkpointName}`,
          sha256: hash(readFileSync(join(stateDir, "solution-chunks", checkpointName))),
        },
        contextFrom: checkpoint.from,
        contextTo: checkpoint.to,
        ownedFrom: checkpoint.ownedFrom,
        ownedTo: checkpoint.ownedTo,
      }];
    })),
    effectiveProblemCorpusHash: SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0].effectiveProblemCorpusHash,
  };
}

function q5525982BaseAuthorityInput(stateDir: string) {
  const persisted = q5525982VerifierAuthorityInput(stateDir);
  const checkpoints = SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0].checkpoints.map((checkpoint) => ({
    path: checkpoint.path,
    sha256: hash(readFileSync(join(stateDir, checkpoint.path))),
    from: checkpoint.from,
    to: checkpoint.to,
    ownedFrom: checkpoint.ownedFrom,
    ownedTo: checkpoint.ownedTo,
    inputHash: checkpoint.inputHash,
  }));
  const items = checkpoints.flatMap((pointer) => {
    const checkpoint = JSON.parse(readFileSync(join(stateDir, pointer.path), "utf8"));
    const decisionByKey = new Map(checkpoint.items.map((item: Record<string, unknown>) => [item.key, item]));
    return checkpoint.inputs.flatMap((rawInput: Record<string, unknown>) => {
      const spec = SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0].items.find((item) => item.key === rawInput.key);
      if (!spec) return [];
      return [{
        input: rawInput,
        solution: persisted.baseSolutions.get(String(rawInput.printedNumber))!,
        decision: decisionByKey.get(rawInput.key)!,
        artifact: { path: pointer.path, sha256: pointer.sha256 },
        sliceTo: pointer.to,
      }];
    });
  });
  return {
    stateDir,
    entry: persisted.entry,
    solutionEvidence: persisted.solutionEvidence,
    effectiveProblemCorpusHash: persisted.effectiveProblemCorpusHash,
    checkpoints,
    items,
  };
}

function q5525982CurrentRepairAuthorityInput(stateDir: string, key: string) {
  const base = q5525982BaseAuthorityInput(stateDir);
  let item = base.items.find((candidate) => (candidate.input as { key: string }).key === key);
  if (!item && key === SOLUTION_SOURCE_REVISION_ALLOWLIST[0].key) {
    const persisted = q5525982VerifierAuthorityInput(stateDir);
    const checkpointSpec = SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0].checkpoints
      .find((candidate) => candidate.decisions.some((decision) => decision.key === key))!;
    const checkpoint = JSON.parse(readFileSync(join(stateDir, checkpointSpec.path), "utf8"));
    const input = checkpoint.inputs.find((candidate: Record<string, unknown>) => candidate.key === key)!;
    item = {
      input,
      solution: persisted.baseSolutions.get(String(input.printedNumber))!,
      decision: checkpoint.items.find((candidate: Record<string, unknown>) => candidate.key === key)!,
      artifact: { path: checkpointSpec.path, sha256: hash(readFileSync(join(stateDir, checkpointSpec.path))) },
      sliceTo: checkpointSpec.to,
    };
  }
  if (!item) throw new Error(`missing current solution repair authority input: ${key}`);
  const repairName = readdirSync(join(stateDir, "solution-repairs"))
    .find((name) => name.includes(`-${String(Number(key.split(":")[1])).padStart(4, "0")}-`))!;
  const repairPath = `solution-repairs/${repairName}`;
  const repairCheckpoint = JSON.parse(readFileSync(join(stateDir, repairPath), "utf8"));
  const fidelityName = readdirSync(join(stateDir, "solution-fidelity-repairs")).find((name) => {
    const checkpoint = JSON.parse(readFileSync(join(stateDir, "solution-fidelity-repairs", name), "utf8"));
    return checkpoint.repairArtifact.path === repairPath;
  })!;
  const fidelityPath = `solution-fidelity-repairs/${fidelityName}`;
  const sourceRevisionName = key === "15:40"
    ? readdirSync(join(stateDir, "solution-source-revisions"))[0]
    : undefined;
  const sourceFidelityName = key === "15:40"
    ? readdirSync(join(stateDir, "solution-fidelity-source-revisions"))[0]
    : undefined;
  const sourceRevision = sourceRevisionName && sourceFidelityName ? {
    solutionArtifact: {
      path: `solution-source-revisions/${sourceRevisionName}`,
      sha256: hash(readFileSync(join(stateDir, "solution-source-revisions", sourceRevisionName))),
      authorityKind: "source-literal-revision",
    },
    fidelityArtifact: {
      path: `solution-fidelity-source-revisions/${sourceFidelityName}`,
      sha256: hash(readFileSync(join(stateDir, "solution-fidelity-source-revisions", sourceFidelityName))),
      authorityKind: "source-literal-revision-fidelity",
    },
    correctionSpecHash: canonicalEvidenceHash(SOLUTION_SOURCE_REVISION_ALLOWLIST[0]),
    parentRepairSolutionItemHash: SOLUTION_SOURCE_REVISION_ALLOWLIST[0].parentRepairSolutionItemHash,
    effectiveSolutionItemHash: SOLUTION_SOURCE_REVISION_ALLOWLIST[0].expectedSolutionItemHash,
    parentRepairExplanationHash: SOLUTION_SOURCE_REVISION_ALLOWLIST[0].parentRepairExplanationHash,
    effectiveExplanationHash: SOLUTION_SOURCE_REVISION_ALLOWLIST[0].expectedExplanationHash,
  } : undefined;
  const sourceItem = sourceRevisionName
    ? JSON.parse(readFileSync(join(stateDir, "solution-source-revisions", sourceRevisionName), "utf8")).item
    : undefined;
  const repair = {
    key,
    printedNumber: repairCheckpoint.printedNumber,
    basePage: repairCheckpoint.basePage,
    effectivePage: sourceItem?.page ?? repairCheckpoint.effectivePage,
    contextFrom: repairCheckpoint.contextFrom,
    contextTo: repairCheckpoint.contextTo,
    baseOwnedFrom: repairCheckpoint.baseOwnedFrom,
    baseOwnedTo: repairCheckpoint.baseOwnedTo,
    baseSolutionCheckpoint: repairCheckpoint.baseSolutionCheckpoint,
    baseFidelityCheckpoint: repairCheckpoint.baseFidelityCheckpoint,
    repairArtifact: { path: repairPath, sha256: hash(readFileSync(join(stateDir, repairPath))) },
    fidelityArtifact: {
      path: sourceRevision?.fidelityArtifact.path ?? fidelityPath,
      sha256: sourceRevision?.fidelityArtifact.sha256 ?? hash(readFileSync(join(stateDir, fidelityPath))),
      ...(sourceRevision
        ? { authorityKind: "source-literal-revision-fidelity" }
        : fidelityName.startsWith("v2-")
        ? { authorityKind: "source-literal-fidelity" }
        : { promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST }),
    },
    baseSolutionItemHash: repairCheckpoint.baseSolutionItemHash,
    effectiveSolutionItemHash: canonicalEvidenceHash(sourceItem ?? repairCheckpoint.item),
    baseRawAnswerHash: repairCheckpoint.baseRawAnswerHash,
    effectiveRawAnswerHash: hash(Buffer.from((sourceItem ?? repairCheckpoint.item).answer)),
    baseExplanationHash: repairCheckpoint.baseExplanationHash,
    effectiveExplanationHash: hash(Buffer.from((sourceItem ?? repairCheckpoint.item).explanation)),
    ...(sourceRevision ? { sourceRevision } : {}),
  };
  return {
    stateDir,
    entry: base.entry,
    solutionEvidence: base.solutionEvidence,
    effectiveProblemCorpusHash: base.effectiveProblemCorpusHash,
    baseInput: item.input,
    baseSolution: item.solution,
    baseFidelityArtifact: item.artifact,
    repair,
  };
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

async function migratedVerifierFixture(entryId = migrationEntryId): Promise<{
  root: string;
  dataDir: string;
  dbPath: string;
  manifestPath: string;
  stateDir: string;
  planPath: string;
  plan: Record<string, any>;
}> {
  const migrationSpec = EXISTING_CORPUS_MIGRATION_ALLOWLIST.find((candidate) => candidate.entryId === entryId);
  if (!migrationSpec) throw new Error(`${entryId}: migration fixture has no allowlisted spec`);
  const entryToken = migrationSpec.entryToken;
  const oldReceiptSha256 = migrationSpec.oldReceiptSha256;
  const root = mkdtempSync(join(tmpdir(), "verify-exam-corpus-migration-"));
  const dataDir = join(root, "data");
  const stateDir = join(dataDir, "import-exam-corpus", entryToken);
  const sourceState = join(migrationSourceData, "import-exam-corpus", entryToken);
  mkdirSync(join(dataDir, "import-exam-corpus"), { recursive: true });
  cpSync(sourceState, stateDir, { recursive: true });
  mkdirSync(join(dataDir, "files", "corpus"), { recursive: true });
  cpSync(
    join(migrationSourceData, "files", "corpus", entryToken),
    join(dataDir, "files", "corpus", entryToken),
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
      join(stateDir, "receipt-history", `v1-${oldReceiptSha256}.json`), "utf8",
    ));
    writeEvidence(join(stateDir, "receipt.json"), history.receipt.value);
    if (entryId === "ebsi:5578423") {
      cpSync(
        join(
          migrationSourceData,
          "backups/exam-corpus-migration-v1-7755c70fefaa45f755086e2b-" +
            "d1fb3cb33d9920c9975b6eb7862a52fe59a7534191f4193772a352bce00ee102.db",
        ),
        join(dataDir, "studywork.db"),
      );
      rmSync(join(stateDir, "migration-plans"), { recursive: true, force: true });
      rmSync(join(stateDir, "receipt-history"), { recursive: true, force: true });
      rmSync(join(dataDir, "backups"), { recursive: true, force: true });
    }
    rmSync(join(stateDir, "migration-commits"), { recursive: true, force: true });
    rmSync(join(stateDir, "answer-attestation"), { recursive: true, force: true });
  } else {
    const source = new Database(join(migrationSourceData, "studywork.db"), { readonly: true, fileMustExist: true });
    try {
      await source.backup(join(dataDir, "studywork.db"));
    } finally {
      source.close();
    }
    expect(hash(readFileSync(join(stateDir, "receipt.json")))).toBe(oldReceiptSha256);
  }
  await execFileP(process.execPath, [
    "--import", "tsx", "scripts/import-exam-corpus.ts",
    "--manifest", "data/ebsi-exam-manifest.json",
    "--data-dir", dataDir,
    "--commit",
    "--migrate-existing", entryId,
    "--expect-receipt-sha256", oldReceiptSha256,
  ], {
    cwd: migrationRepository,
    timeout: 60_000,
    env: { ...process.env, STUDYWORK_CODEX_BIN: "/usr/bin/false" },
  });

  const dbPath = join(dataDir, "studywork.db");
  const db = new Database(dbPath);
  try {
    const placeholders = migrationSpec.fileIds.map(() => "?").join(", ");
    db.prepare(`DELETE FROM book_files WHERE r2_key LIKE 'corpus/%' AND id NOT IN (${placeholders})`)
      .run(...migrationSpec.fileIds);
  } finally {
    db.close();
  }
  const sourceManifest = JSON.parse(readFileSync(join(migrationSourceData, "ebsi-exam-manifest.json"), "utf8"));
  const manifestPath = join(dataDir, "single-migration-manifest.json");
  writeEvidence(manifestPath, {
    schemaVersion: 2,
    entries: sourceManifest.entries.filter((entry: { id: string }) => entry.id === entryId),
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
  copyOfficialSolution = false,
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
    ...(copyOfficialSolution ? { solutionPdfUrl: officialDownloads.solution.requestedUrl } : {}),
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
  const solutionBytes = copyOfficialSolution
    ? readFileSync(join(officialState, "solution.pdf"))
    : readFileSync(join(stateDir, "solution.pdf"));
  if (copyOfficialSolution) {
    writeFileSync(join(stateDir, "solution.pdf"), solutionBytes);
    const officialSolutionChunk = join(officialState, "solution-chunks", "v3-0000.json");
    const solutionChunkDir = join(stateDir, "solution-chunks");
    for (const name of readdirSync(solutionChunkDir)) rmSync(join(solutionChunkDir, name));
    writeFileSync(join(solutionChunkDir, "v3-0000.json"), readFileSync(officialSolutionChunk));
  }
  const downloads = JSON.parse(readFileSync(join(stateDir, "downloads.json"), "utf8"));
  downloads.problem = { ...officialDownloads.problem, path: "problem.pdf" };
  if (copyOfficialSolution) downloads.solution = { ...officialDownloads.solution, path: "solution.pdf" };
  writeJson(join(stateDir, "downloads.json"), downloads);

  const receiptPath = join(stateDir, "receipt.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  receipt.entryId = spec.entryId;
  receipt.problemHash = spec.sourceHash;
  if (copyOfficialSolution) receipt.solutionHash = officialDownloads.solution.sha256;
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
    if (copyOfficialSolution) {
      db.prepare("UPDATE book_files SET r2_key = ?, content_hash = ?, page_count = ? WHERE r2_key = ?")
        .run(solutionR2Key, officialDownloads.solution.sha256, officialDownloads.solution.pageCount,
          target.solutionR2Key);
    } else {
      db.prepare("UPDATE book_files SET r2_key = ? WHERE r2_key = ?")
        .run(solutionR2Key, target.solutionR2Key);
    }
    target.problemR2Key = problemR2Key;
    target.solutionR2Key = solutionR2Key;
  }
  db.close();
  writeJson(receiptPath, receipt);
}

function prepareQ30ManualFixture(files: ReturnType<typeof fixture>, copyOfficialSolution = false): void {
  prepareManualFixture(files, "korean", Q30_MANUAL_SPEC, Q30_MANUAL_STATE, copyOfficialSolution);
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
    manualAdjudicationKey?: string;
    manualRevision?: boolean;
    manualRevisionInvalidDecision?: boolean;
    manualInvalidDecision?: boolean;
    manualSolutionRepair?: boolean;
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
  problemManualRevisionArtifact?: string;
  classificationManualRevisionArtifact?: string;
  solutionRepairArtifact?: string;
  solutionRepairFidelityArtifact?: string;
  semanticArtifact?: string;
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
  const manualSpecs = options.manualAdjudication
    ? PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.filter((spec) =>
        spec.entryId === entry.id
          && (options.manualAdjudicationKey === undefined || spec.key === options.manualAdjudicationKey))
    : [];
  const manualSpec = manualSpecs.length === 1 ? manualSpecs[0] : undefined;
  const manualRevisionSpec = options.manualRevision
    ? PROBLEM_MANUAL_REVISION_ALLOWLIST.find((spec) =>
        spec.entryId === entry.id && spec.key === manualSpec?.key &&
        spec.parentAllowlistId === manualSpec?.allowlistId)
    : undefined;
  const manualRevisionParentClassificationPath = manualRevisionSpec
    ? MANUAL_REVISION_PARENT_CLASSIFICATIONS.get(manualRevisionSpec.allowlistId)
    : undefined;
  const manualFailedArtifacts = manualSpec && MANUAL_FAILED_ARTIFACTS.get(manualSpec.allowlistId);
  if (options.manualAdjudication && (!manualSpec || !manualFailedArtifacts)) {
    throw new Error("manual adjudication fixture requires an exact supported entry");
  }
  if (options.manualRevision && (!manualRevisionSpec || !manualRevisionParentClassificationPath
    || !existsSync(manualRevisionParentClassificationPath))) {
    throw new Error("manual revision fixture requires an exact parent authority");
  }
  if (options.manualSolutionRepair && manualSpec?.allowlistId !== Q43_MANUAL_SPEC.allowlistId) {
    throw new Error("manual solution repair fixture requires the exact Q43 allowlist");
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
  if ((manualRevisionSpec?.expectedDecision ?? manualSpec?.expectedDecision) === "accept") {
    for (const [index, item] of classification.items.entries()) {
      const preserve = options.manualRevision
        ? index === recoveryTargetNumber - 1
        : (!options.manualSolutionRepair && index !== 0) || index === recoveryTargetNumber - 1;
      if (preserve) continue;
      Object.assign(item, {
        decision: "reject",
        canonical_subject: null,
        curriculum_course: null,
        domain: null,
        achievement_codes: [],
        reason_codes: ["OUT_OF_SCOPE"],
        transcription_status: "exact",
        transcription_evidence: "the literal source transcription is exact and outside the selected scope",
      });
    }
    if (!options.manualSolutionRepair && !options.manualRevision) {
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
  let problemManualRevisionArtifact: string | undefined;
  let classificationManualRevisionArtifact: string | undefined;
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
        const generatedClassification = {
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
              canonical_subject: entry.subject === "국어" ? "korean_reading" : "math_B",
              curriculum_course: entry.subject === "국어" ? "독서와 작문" : "2015 수학Ⅰ",
              domain: entry.subject === "국어" ? "작문" : "지수함수와 로그함수",
              achievement_codes: entry.subject === "국어" ? ["12독작01-03"] : ["12수학Ⅰ01-07"],
              reason_codes: entry.subject === "국어" ? ["IN_SCOPE_WRITING"] : ["IN_SCOPE_LOGARITHMS"],
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
        const finalClassification = manualRevisionSpec
          ? structuredClone(JSON.parse(
              readFileSync(manualRevisionParentClassificationPath!, "utf8"),
            ).items[0])
          : generatedClassification;
        if (manualRevisionSpec) {
          expect(canonicalEvidenceHash(correctedQuestion)).toBe(manualRevisionSpec.failedQuestionHash);
          expect(canonicalEvidenceHash(finalClassification)).toBe(manualRevisionSpec.failedClassificationHash);
          expect(hash(finalClassification.transcription_evidence))
            .toBe(manualRevisionSpec.failedClassificationEvidenceHash);
        }
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
        if (manualRevisionSpec) {
          const parentManual = parentRecovery.manualAdjudication as Record<string, any>;
          const revisionCorrectionSpecHash = canonicalEvidenceHash({
            allowlistId: manualRevisionSpec.allowlistId,
            parentAllowlistId: manualRevisionSpec.parentAllowlistId,
            replacement: manualRevisionSpec.replacement,
            requiredTokens: manualRevisionSpec.requiredTokens,
            expectedDecision: manualRevisionSpec.expectedDecision,
            expectedCanonicalSubject: manualRevisionSpec.expectedCanonicalSubject,
          });
          const revisionCommonBasis = {
            allowlistId: manualRevisionSpec.allowlistId,
            parentAllowlistId: manualRevisionSpec.parentAllowlistId,
            entryId: entry.id,
            key: targetKey,
            printedNumber: String(recoveryTargetNumber),
            sourcePage: recoveryTargetPage,
            sourceHash: downloads.problem.sha256,
            parentManual,
            parentManualEvidenceHash: canonicalEvidenceHash(parentManual),
            parentProblemArtifact: problemPointer,
            parentProblemArtifactItemHash: correctedQuestionHash,
            parentClassificationArtifact: {
              path: classificationRelativePath,
              sha256: classificationHash,
            },
            parentClassificationArtifactItemHash: finalClassificationHash,
            failedQuestionHash: manualRevisionSpec.failedQuestionHash,
            failedClassificationHash: manualRevisionSpec.failedClassificationHash,
            failedClassificationEvidenceHash: manualRevisionSpec.failedClassificationEvidenceHash,
            correctionSpecHash: revisionCorrectionSpecHash,
            cropEvidenceArtifact: evidencePointer,
            cropEvidencePdf: pdfPointer,
            cropViews,
          };
          const revisionBasisDigest = canonicalEvidenceHash(revisionCommonBasis);
          const revisionStem = `v1-${String(recoveryTargetPage).padStart(4, "0")}-` +
            `${String(recoveryTargetNumber).padStart(4, "0")}-${revisionBasisDigest}`;
          const revisionQuestion = applyAllowlistedProblemManualRevision(
            entry.id,
            downloads.problem.sha256,
            manualSpec.allowlistId,
            correctedQuestion,
          );
          const revisionQuestionHash = canonicalEvidenceHash(revisionQuestion);
          const revisionProblemRelativePath = `problem-manual-revisions/${revisionStem}.json`;
          problemManualRevisionArtifact = join(stateDir, revisionProblemRelativePath);
          const revisionProblemHash = writeEvidence(problemManualRevisionArtifact, {
            version: 1,
            entryId: entry.id,
            basisDigest: revisionBasisDigest,
            basis: revisionCommonBasis,
            correctionVersion: 1,
            correctionDigest: PROBLEM_MANUAL_REVISION_CORRECTION_DIGEST,
            item: revisionQuestion,
          });
          const revisionProblemPointer = {
            path: revisionProblemRelativePath,
            sha256: revisionProblemHash,
          };
          const revisionClassificationBasis = {
            ...revisionCommonBasis,
            problemArtifact: revisionProblemPointer,
            problemArtifactItemHash: revisionQuestionHash,
            effectiveQuestionHash: revisionQuestionHash,
          };
          const revisionClassificationBasisDigest = canonicalEvidenceHash(revisionClassificationBasis);
          const revisionClassification = {
            ...finalClassification,
            ...(options.manualRevisionInvalidDecision
              ? manualRevisionSpec.expectedDecision === "accept" ? {
                  decision: "reject",
                  canonical_subject: null,
                  curriculum_course: null,
                  domain: null,
                  achievement_codes: [],
                  reason_codes: ["OUT_OF_SCOPE"],
                } : {
                  decision: "accept",
                  canonical_subject: "math_A",
                  curriculum_course: "2015 수학Ⅱ",
                  domain: "적분",
                  achievement_codes: ["12수학Ⅱ03-04"],
                  reason_codes: ["IN_SCOPE_RIEMANN_SUM_DEFINITION"],
                }
              : {}),
            transcription_status: "exact",
            transcription_evidence: "all source pixels match the count-checked nested manual revision exactly",
          };
          const revisionClassificationHash = canonicalEvidenceHash(revisionClassification);
          const revisionClassificationRelativePath = `classification-manual-revisions/` +
            `v1-${String(recoveryTargetPage).padStart(4, "0")}-` +
            `${String(recoveryTargetNumber).padStart(4, "0")}-` +
            `${revisionClassificationBasisDigest}-${DIGEST}.json`;
          classificationManualRevisionArtifact = join(stateDir, revisionClassificationRelativePath);
          const revisionClassificationCheckpointHash = writeEvidence(
            classificationManualRevisionArtifact,
            {
              version: 1,
              entryId: entry.id,
              basisDigest: revisionClassificationBasisDigest,
              basis: revisionClassificationBasis,
              classifierVersion: 5,
              rulesDigest: DIGEST,
              transcriptionGateVersion: 2,
              transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
              revisionVersion: 1,
              revisionPromptDigest: PROBLEM_MANUAL_REVISION_PROMPT_DIGEST,
              model: "gpt-5.6-sol",
              reasoningEffort: "high",
              items: [revisionClassification],
            },
          );
          parentManual.revision = {
            allowlistId: manualRevisionSpec.allowlistId,
            key: targetKey,
            printedNumber: String(recoveryTargetNumber),
            sourcePage: recoveryTargetPage,
            sourceHash: downloads.problem.sha256,
            parentManualEvidenceHash: canonicalEvidenceHash(parentManual),
            parentProblemArtifact: problemPointer,
            parentProblemArtifactItemHash: correctedQuestionHash,
            parentClassificationArtifact: {
              path: classificationRelativePath,
              sha256: classificationHash,
            },
            parentClassificationArtifactItemHash: finalClassificationHash,
            failedQuestionHash: manualRevisionSpec.failedQuestionHash,
            failedClassificationHash: manualRevisionSpec.failedClassificationHash,
            failedClassificationEvidenceHash: manualRevisionSpec.failedClassificationEvidenceHash,
            correctionSpecHash: revisionCorrectionSpecHash,
            problemArtifact: {
              ...revisionProblemPointer,
              correctionVersion: 1,
              correctionDigest: PROBLEM_MANUAL_REVISION_CORRECTION_DIGEST,
            },
            problemArtifactItemHash: revisionQuestionHash,
            classificationArtifact: {
              path: revisionClassificationRelativePath,
              sha256: revisionClassificationCheckpointHash,
              rulesDigest: DIGEST,
              transcriptionGateVersion: 2,
              transcriptionPromptDigest: CURRENT_TRANSCRIPTION_PROMPT_DIGEST,
              revisionVersion: 1,
              revisionPromptDigest: PROBLEM_MANUAL_REVISION_PROMPT_DIGEST,
            },
            classificationArtifactItemHash: revisionClassificationHash,
            baseQuestionHash: manualRevisionSpec.failedQuestionHash,
            effectiveQuestionHash: revisionQuestionHash,
            baseClassificationHash: manualRevisionSpec.failedClassificationHash,
            effectiveClassificationHash: revisionClassificationHash,
          };
          terminalQuestion = revisionQuestion;
          terminalClassification = revisionClassification;
        }
        if (!manualRevisionSpec) {
          terminalQuestion = correctedQuestion;
          terminalClassification = finalClassification;
        }
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

  const manualExpectedDecision = manualRevisionSpec?.expectedDecision ?? manualSpec?.expectedDecision;
  const manualExpectedCanonicalSubject = manualRevisionSpec?.expectedCanonicalSubject
    ?? manualSpec?.expectedCanonicalSubject;
  const manualAcceptedSolution = manualExpectedDecision === "accept" ? (() => {
    const key = `${recoveryTargetPage}:${recoveryTargetNumber}`;
    const relativePath = "solution-chunks/v3-0000.json";
    const absolutePath = join(stateDir, relativePath);
    const checkpoint = JSON.parse(readFileSync(absolutePath, "utf8"));
    const solution = checkpoint.items.find(
      (item: { number: string }) => Number(item.number) === recoveryTargetNumber,
    );
    const effectiveSolution = options.manualSolutionRepair
      ? { ...solution, explanation: Q43_CORRECTED_SOLUTION }
      : solution;
    const baseSolutionCheckpoint = { path: relativePath, sha256: hash(readFileSync(absolutePath)) };
    const input = {
      key,
      printedNumber: String(recoveryTargetNumber),
      qtype: "mcq",
      allowDerivedMarkerAnswer: /^[①-⑩]$/u.test(solution.answer),
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
      explanationStatus: options.manualSolutionRepair ? "mismatch" : "exact",
      evidence: options.manualSolutionRepair
        ? "the official p5 explanation says 굳세게, 더 추워야겠다, 의성어, and 카랑카랑"
        : "the explicit answer and complete explanation match the official solution pixels",
    };
    return { key, solution, effectiveSolution, input, decision };
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
  const officialSolutionContextTo = options.scopeAdjudication || options.manualSolutionRepair
    || manualRevisionSpec?.expectedDecision === "accept" ? 5
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
      if (officialSolutionContextTo !== undefined) {
        child.from = 1;
        child.to = officialSolutionContextTo;
        child.ownedFrom = 1;
        child.ownedTo = officialSolutionContextTo;
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
  const manualSolutionRepair = options.manualSolutionRepair && manualAcceptedSolution !== null ? (() => {
    const input = manualAcceptedSolution.input;
    const effectiveSolution = manualAcceptedSolution.effectiveSolution;
    const baseFidelityCheckpoint = {
      path: String(solutionFidelityCheckpoints[0].path),
      sha256: String(solutionFidelityCheckpoints[0].sha256),
    };
    const repairRelativePath = `solution-repairs/v1-${String(input.sourcePage).padStart(4, "0")}-` +
      `${String(recoveryTargetNumber).padStart(4, "0")}-${baseFidelityCheckpoint.sha256}.json`;
    const repairCheckpoint = {
      version: 1,
      entryId: entry.id,
      key: manualAcceptedSolution.key,
      printedNumber: String(recoveryTargetNumber),
      basePage: input.sourcePage,
      contextFrom: input.baseContextFrom,
      contextTo: input.baseContextTo,
      baseOwnedFrom: input.baseOwnedFrom,
      baseOwnedTo: input.baseOwnedTo,
      sourceHash: downloads.solution.sha256,
      effectiveProblemCorpusHash: effectiveCorpusHash,
      baseSolutionCheckpoint: input.baseSolutionCheckpoint,
      baseFidelityCheckpoint,
      baseSolutionItemHash: input.baseSolutionItemHash,
      baseRawAnswerHash: hash(input.rawAnswer),
      baseExplanationHash: hash(input.explanation),
      promptVersion: TARGETED_SOLUTION_TRANSCRIPTION_VERSION,
      promptDigest: TARGETED_SOLUTION_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      effectivePage: effectiveSolution.page,
      item: effectiveSolution,
    };
    const repairSha256 = writeEvidence(join(stateDir, repairRelativePath), repairCheckpoint);
    const repairArtifact = { path: repairRelativePath, sha256: repairSha256 };
    const effectiveSolutionItemHash = canonicalEvidenceHash(effectiveSolution);
    const repairedInput = {
      ...input,
      sourcePage: effectiveSolution.page,
      rawAnswer: effectiveSolution.answer,
      explanation: effectiveSolution.explanation,
    };
    const repairedInputHash = canonicalEvidenceHash(repairedInput);
    const fidelityRelativePath = `solution-fidelity-repairs/v1-` +
      `${String(input.sourcePage).padStart(4, "0")}-${String(recoveryTargetNumber).padStart(4, "0")}-` +
      `${baseFidelityCheckpoint.sha256}-${effectiveSolutionItemHash}.json`;
    const fidelityDecision = {
      key: manualAcceptedSolution.key,
      sourcePage: effectiveSolution.page,
      answerStatus: "exact",
      explanationStatus: "exact",
      evidence: "official p5 exactly matches 굳세게, 더 추워야겠다, 의성어, and 카랑카랑",
    };
    const fidelityCheckpoint = {
      version: 1,
      entryId: entry.id,
      key: manualAcceptedSolution.key,
      sourceHash: downloads.solution.sha256,
      from: input.baseContextFrom,
      to: input.baseContextTo,
      basePage: input.sourcePage,
      effectivePage: effectiveSolution.page,
      baseOwnedFrom: input.baseOwnedFrom,
      baseOwnedTo: input.baseOwnedTo,
      effectiveProblemCorpusHash: effectiveCorpusHash,
      baseSolutionCheckpoint: input.baseSolutionCheckpoint,
      baseFidelityCheckpoint,
      repairArtifact,
      effectiveSolutionItemHash,
      inputHash: repairedInputHash,
      promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      input: repairedInput,
      item: fidelityDecision,
    };
    const fidelitySha256 = writeEvidence(join(stateDir, fidelityRelativePath), fidelityCheckpoint);
    const fidelityArtifact = { path: fidelityRelativePath, sha256: fidelitySha256 };
    const evidence = {
      key: manualAcceptedSolution.key,
      printedNumber: String(recoveryTargetNumber),
      basePage: input.sourcePage,
      effectivePage: effectiveSolution.page,
      contextFrom: input.baseContextFrom,
      contextTo: input.baseContextTo,
      baseOwnedFrom: input.baseOwnedFrom,
      baseOwnedTo: input.baseOwnedTo,
      baseSolutionCheckpoint: input.baseSolutionCheckpoint,
      baseFidelityCheckpoint,
      repairArtifact,
      fidelityArtifact: { ...fidelityArtifact, promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST },
      baseSolutionItemHash: input.baseSolutionItemHash,
      effectiveSolutionItemHash,
      baseRawAnswerHash: hash(input.rawAnswer),
      effectiveRawAnswerHash: hash(effectiveSolution.answer),
      baseExplanationHash: hash(input.explanation),
      effectiveExplanationHash: hash(effectiveSolution.explanation),
    };
    return { evidence, repairArtifact, fidelityArtifact, fidelityDecision, effectiveSolutionItemHash };
  })() : null;
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
      effectivePage: manualAcceptedSolution.effectiveSolution.page,
      answerStatus: manualSolutionRepair?.fidelityDecision.answerStatus
        ?? manualAcceptedSolution.decision.answerStatus,
      explanationStatus: manualSolutionRepair?.fidelityDecision.explanationStatus
        ?? manualAcceptedSolution.decision.explanationStatus,
      evidence: manualSolutionRepair?.fidelityDecision.evidence ?? manualAcceptedSolution.decision.evidence,
      fidelityArtifact: manualSolutionRepair?.fidelityArtifact ?? {
        path: solutionFidelityCheckpoints[0].path,
        sha256: solutionFidelityCheckpoints[0].sha256,
      },
      baseSolutionItemHash: manualAcceptedSolution.input.baseSolutionItemHash,
      effectiveSolutionItemHash: manualSolutionRepair?.effectiveSolutionItemHash
        ?? manualAcceptedSolution.input.baseSolutionItemHash,
      baseRawAnswerHash: hash(manualAcceptedSolution.solution.answer),
      effectiveRawAnswerHash: hash(manualAcceptedSolution.effectiveSolution.answer),
      baseExplanationHash: hash(manualAcceptedSolution.solution.explanation),
      effectiveExplanationHash: hash(manualAcceptedSolution.effectiveSolution.explanation),
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
      solution: manualAcceptedSolution !== null && item.key === manualAcceptedSolution.key
        ? manualAcceptedSolution.effectiveSolution
        : currentSolutionItems.find(
            (solution: { number: string }) => solution.number === item.printedNumber,
          ),
    }),
  ).sort((left: { key: string }, right: { key: string }) =>
    compareCorpusQuestionKeys(left.key, right.key)));
  const manualMarkerMode = manualAcceptedSolution !== null
    && /^[①-⑩]$/u.test(manualAcceptedSolution.solution.answer);
  const manualSemanticEvidence = options.manualSolutionRepair
    ? "both poems vary similar closing lines to emphasize their themes"
    : "the official explanation establishes that choice 3 is the one inconsistent statement";
  const semanticCheckpoint = (() => {
    if (legacyAudit.semanticCheckpoint === null && !positiveAcceptedSolution && !manualMarkerMode) return null;
    const child = manualMarkerMode && manualAcceptedSolution !== null ? (() => {
      const inputs = [{
        key: manualAcceptedSolution.key,
        choices: effectiveProblems[recoveryTargetNumber - 1].choices,
        detailedExplanation: redactedExplanation(manualAcceptedSolution.effectiveSolution.explanation),
      }];
      return {
        inputs,
        items: [{
          key: manualAcceptedSolution.key,
          status: "resolved",
          choiceIndex: 3,
          evidence: manualSemanticEvidence,
        }],
        inputHash: canonicalEvidenceHash(inputs),
      };
    })() : legacyAudit.semanticCheckpoint === null ? {
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
      storedAnswerHash: hash(manualAcceptedSolution.effectiveSolution.answer),
      mode: manualMarkerMode ? "choice-marker" : "choice-content",
      choiceIndex: 3,
      semantic: manualMarkerMode ? {
        status: "resolved",
        choiceIndex: 3,
        evidence: manualSemanticEvidence,
      } : null,
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
  const singleManualAcceptedProjection = Boolean(
    options.manualSolutionRepair || manualRevisionSpec?.expectedDecision === "accept",
  );
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
    acceptedQuestionCount: singleManualAcceptedProjection
      ? 1 : legacyAudit.acceptedQuestionCount + (positiveAcceptedSolution ? 1 : 0),
    rejectedQuestionCount: singleManualAcceptedProjection
      ? legacyAudit.sourceQuestionCount - 1
      : legacyAudit.rejectedQuestionCount - (positiveAcceptedSolution ? 1 : 0),
    reviewQuestionCount: 0,
    targetQuestionCounts: singleManualAcceptedProjection ? {
      [targetForCanonical(manualExpectedCanonicalSubject!)]: 1,
    } : positiveAcceptedSolution ? {
      ...legacyAudit.targetQuestionCounts,
      "수학 - 수학Ⅱ·미적분Ⅰ": legacyAudit.targetQuestionCounts["수학 - 수학Ⅱ·미적분Ⅰ"] + 1,
    } : legacyAudit.targetQuestionCounts,
    acceptedSolutionKeys,
    solutionRepairKeys: manualSolutionRepair ? [manualAcceptedSolution!.key] : [],
    derivedAnswerKeys: positiveAcceptedSolution
      ? [...legacyAudit.derivedAnswerKeys, positiveAcceptedSolution.key].sort(compareCorpusQuestionKeys)
      : manualAcceptedSolution === null ? legacyAudit.derivedAnswerKeys : [],
    acceptedMcqKeys,
    effectiveCorpusHash,
    effectiveSolutionCorpusHash,
    solutionFidelityCheckpoints,
    solutionFidelityItems,
    solutionRepairs: manualSolutionRepair ? [manualSolutionRepair.evidence] : [],
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
  if ((options.manualSolutionRepair || options.manualRevision) && manualExpectedCanonicalSubject) {
    const expectedTarget = targetForCanonical(manualExpectedCanonicalSubject);
    const selectedTarget = receipt.targetBooks.find(
      (value: { subject: string }) => value.subject === expectedTarget,
    ) as { subject: string; expectedQuestionCount: number; problemR2Key: string; solutionR2Key: string };
    if (!selectedTarget) throw new Error("manual solution repair fixture has no canonical target book");
    const discardedTargets = receipt.targetBooks.filter(
      (value: { subject: string }) => value.subject !== expectedTarget,
    ) as Array<{ problemR2Key: string; solutionR2Key: string }>;
    const db = new Database(files.dbPath);
    for (const discarded of discardedTargets) {
      const row = db.prepare("SELECT book_id FROM book_files WHERE r2_key = ?")
        .get(discarded.problemR2Key) as { book_id: number };
      db.prepare("DELETE FROM questions WHERE book_id = ?").run(row.book_id);
      db.prepare("DELETE FROM book_items WHERE book_id = ?").run(row.book_id);
      db.prepare("DELETE FROM book_files WHERE book_id = ?").run(row.book_id);
      db.prepare("DELETE FROM books WHERE id = ?").run(row.book_id);
      rmSync(join(files.dataDir, "files", discarded.problemR2Key));
      rmSync(join(files.dataDir, "files", discarded.solutionR2Key));
    }
    db.close();
    selectedTarget.expectedQuestionCount = 1;
    receipt.targetBooks = [selectedTarget];
    receipt.acceptedQuestionCount = 1;
    receipt.rejectedQuestionCount = receipt.sourceQuestionCount - 1;
    writeEvidence(join(stateDir, "receipt.json"), receipt);
  }
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
    const expectedTarget = manualExpectedCanonicalSubject
      ? targetForCanonical(manualExpectedCanonicalSubject)
      : receipt.targetBooks[0].subject;
    const target = receipt.targetBooks.find(
      (value: { subject: string }) => value.subject === expectedTarget,
    ) as { problemR2Key: string; solutionR2Key: string };
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
      manualAcceptedSolution.effectiveSolution.answer,
      manualAcceptedSolution.effectiveSolution.explanation,
      options.manualRevision
        ? problemCheckpoint.items[recoveryTargetNumber - 1].difficulty
        : question.difficulty,
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
      manualAcceptedSolution.effectiveSolution.answer,
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
      manualAcceptedSolution.effectiveSolution.answer,
      manualAcceptedSolution.effectiveSolution.explanation,
      manualAcceptedSolution.effectiveSolution.page,
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
    solutionRepairs: manualSolutionRepair ? [manualSolutionRepair.evidence] : [],
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
    problemManualRevisionArtifact,
    classificationManualRevisionArtifact,
    solutionRepairArtifact: manualSolutionRepair
      ? join(stateDir, manualSolutionRepair.repairArtifact.path) : undefined,
    solutionRepairFidelityArtifact: manualSolutionRepair
      ? join(stateDir, manualSolutionRepair.fidelityArtifact.path) : undefined,
    semanticArtifact: semanticCheckpoint ? join(stateDir, semanticCheckpoint.path) : undefined,
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

function terminalAdjudicationInputs(stateDir: string) {
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
      "utf8",
    )).items,
    questions,
    entry,
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
  input: ReturnType<typeof terminalAdjudicationInputs>;
  failed: ClassifiedQuestion;
  parent: ProblemRecoveryEvidence;
} {
  const input = terminalAdjudicationInputs(stateDir);
  const problemRelativePath =
    "problem-recoveries/v1-0011-0027-e2d59ea1699886f21ab5218fd221a8fa05f0beb46a1782ed48c9ec9cb583541c.json";
  const classificationRelativePath =
    "classification-recoveries/v1-0011-0027-9cae9db11869c6adbd575b6ee6b08ce51d75c483e3897a8afe1b698044223551-" +
    "7bb7cb863c8c4855.json";
  const problemCheckpoint = JSON.parse(readFileSync(join(stateDir, problemRelativePath), "utf8"));
  const classificationCheckpoint = JSON.parse(
    readFileSync(join(stateDir, classificationRelativePath), "utf8"),
  );
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
  return { input, failed: { question, classification }, parent };
}

function pinnedTerminalManualRecoveryParent(
  stateDir: string,
  spec: (typeof PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST)[number],
): ReturnType<typeof pinnedManualRecoveryParent> {
  const pins = new Map([
    ["3:6", [
      "problem-recoveries/v2-0003-0006-227bcbbcf6c2d079d0e34505aeed49afd8f8fe915ce78b732334ec06f94f2a70.json",
      "classification-recoveries/v2-0003-0006-91db1fa140d7e958866bba2856e5349613e6411b6051c24f9f89bb347827bb95-7bb7cb863c8c4855.json",
    ]],
    ["3:7", [
      "problem-recoveries/v2-0003-0007-c8c061be14a5acfc2c58eaa7f4fdaa2fc80f7bb77766dff21c0424a0992bb069.json",
      "classification-recoveries/v2-0003-0007-2f8ef852b405bebdc0b0f03f191e881d7b56d47648f13eaea3e315ddf29fac7f-7bb7cb863c8c4855.json",
    ]],
    ["9:21", [
      "problem-recoveries/v2-0009-0021-86445e34deae577f301f2ce4b325ff53fc284ac874a0b8de2a861ca4e7500a95.json",
      "classification-recoveries/v2-0009-0021-73d3e7cd0552f6b10ef91b6993b5b674096489acc34a5db24170760507278c82-7bb7cb863c8c4855.json",
    ]],
    ["9:22", [
      "problem-recoveries/v2-0009-0022-eb6ff38dc6647dd838948efdcff5e4b42f44692cb44b8af0cb6814129672f0d2.json",
      "classification-recoveries/v2-0009-0022-cbf2099be1ed1a53a1c87db10bb8beefb993cc69ac80478e34c41684b8f5b1f7-7bb7cb863c8c4855.json",
    ]],
    ["9:24", [
      "problem-recoveries/v2-0009-0024-005ba132b7a8c2d9fd6e954ee527c3dfd23aeeb844f560c7d145a94382254891.json",
      "classification-recoveries/v2-0009-0024-19c8337edf550ed436519c34aa6cce2ac47dd112c029ed666a1a948099fbc630-7bb7cb863c8c4855.json",
    ]],
    ["9:25", [
      "problem-recoveries/v2-0009-0025-4f584a486703c10dfbd89e2cbdc601a21d0b9ec790c04e526ae439af08230c32.json",
      "classification-recoveries/v2-0009-0025-e5926551e837ba4dfc4c7a955b633e0ab248824083e1fcc226cde759cd2083b2-7bb7cb863c8c4855.json",
    ]],
    ["9:26", [
      "problem-recoveries/v2-0009-0026-b5e39f2045ab18db27873b8abb75b058f7f2cd9b03cf84ffc237ee494ec91b29.json",
      "classification-recoveries/v2-0009-0026-163fa9a8dba0114be2c92c2c32b9b405a54ce87212c93979e11c01523a0bc0b8-7bb7cb863c8c4855.json",
    ]],
  ] as const);
  const [problemRelativePath, classificationRelativePath] = pins.get(
    spec.key as "3:6" | "3:7" | "9:21" | "9:22" | "9:24" | "9:25" | "9:26",
  )!;
  const input = terminalAdjudicationInputs(stateDir);
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
    problemArtifact: { path: problemRelativePath, sha256: hash(problemBytes) },
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
    trigger: basis.trigger,
    baseQuestionHash: basis.baseQuestionHash,
    effectiveQuestionHash: canonicalEvidenceHash(question),
    baseClassificationHash: basis.baseClassificationHash,
    effectiveClassificationHash: canonicalEvidenceHash(classification),
  };
  expect(canonicalEvidenceHash(parent)).toBe(spec.parentRecoveryEvidenceHash);
  return { input, failed: { question, classification }, parent };
}

function pinnedManualRecoveryParent(
  stateDir: string,
  spec: (typeof PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST)[number],
  pinnedNames?: { problem: string; classification: string },
): {
  input: ReturnType<typeof terminalAdjudicationInputs>;
  failed: ClassifiedQuestion;
  parent: ProblemRecoveryEvidence;
} {
  const input = terminalAdjudicationInputs(stateDir);
  const page = String(spec.sourcePage).padStart(4, "0");
  const number = spec.key.split(":")[1]!.padStart(4, "0");
  const prefix = new RegExp(`^v\\d+-${page}-${number}-`, "u");
  const problemNames = pinnedNames ? [pinnedNames.problem] :
    readdirSync(join(stateDir, "problem-recoveries"))
      .filter((name) => prefix.test(name) && name.endsWith(".json"));
  const classificationNames = pinnedNames ? [pinnedNames.classification] :
    readdirSync(join(stateDir, "classification-recoveries"))
      .filter((name) => prefix.test(name) && name.endsWith(`-${DIGEST}.json`));
  expect(problemNames).toHaveLength(1);
  expect(classificationNames).toHaveLength(1);
  const problemRelativePath = `problem-recoveries/${problemNames[0]}`;
  const classificationRelativePath = `classification-recoveries/${classificationNames[0]}`;
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
    problemArtifact: { path: problemRelativePath, sha256: hash(problemBytes) },
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
    ...(basis.trigger ? { trigger: basis.trigger } : {
      failedClassificationEvidenceHash: basis.failedClassificationEvidenceHash,
    }),
    baseQuestionHash: basis.baseQuestionHash,
    effectiveQuestionHash: canonicalEvidenceHash(question),
    baseClassificationHash: basis.baseClassificationHash,
    effectiveClassificationHash: canonicalEvidenceHash(classification),
  };
  expect(canonicalEvidenceHash(parent)).toBe(spec.parentRecoveryEvidenceHash);
  return { input, failed: { question, classification }, parent };
}

function stripManualAuthorityFixtureAnswerBoundary(stateDir: string): void {
  for (const directory of ["answer-audit", "answer-attestation"]) {
    rmSync(join(stateDir, directory), { recursive: true, force: true });
  }
}

async function q31Q32ManualAuthorityFixture5578421() {
  const stateDir = mkdtempSync(join(tmpdir(), "verify-5578421-q31-q32-manual-authority-"));
  cpSync(Q30_MANUAL_STATE, stateDir, { recursive: true });
  stripManualAuthorityFixtureAnswerBoundary(stateDir);
  for (const directory of [
    "problem-manual-evidence",
    "problem-manual-adjudications",
    "classification-manual-adjudications",
    "problem-manual-revisions",
    "classification-manual-revisions",
  ]) rmSync(join(stateDir, directory), { recursive: true, force: true });
  const rows = Q31_Q32_5578421_MANUAL_SPECS.map((spec) => ({
    spec,
    ...pinnedManualRecoveryParent(stateDir, spec),
  }));
  providerMock.complete.mockReset();
  for (const row of rows) {
    providerMock.complete.mockResolvedValueOnce({ text: JSON.stringify([{
      key: row.spec.key,
      decision: "accept",
      canonical_subject: "korean_reading",
      curriculum_course: "독서와 작문",
      domain: "독서—논리 개념의 이해와 적용",
      achievement_codes: ["12독작01-03"],
      confidence: 0.99,
      reason_codes: ["SOURCE_EXACT", "NONFICTION_COMPREHENSION"],
      transcription_status: "exact",
      transcription_evidence: `공식 11~12쪽의 ${row.spec.key} 지문·도식·발문·선택지가 일치한다.`,
    }]) });
    const adjudicated = await adjudicateProblemManual(
      row.input.entry,
      row.input.problem,
      stateDir,
      row.failed,
      row.parent,
    );
    Object.assign(row, { adjudicated });
  }
  expect(providerMock.complete).toHaveBeenCalledTimes(2);
  providerMock.complete.mockReset();
  return rows.map((row) => ({
    ...row,
    adjudicated: (row as typeof row & {
      adjudicated: Awaited<ReturnType<typeof adjudicateProblemManual>>;
    }).adjudicated,
    stateDir,
  }));
}

async function q3V2ManualAuthorityFixture5578421() {
  const stateDir = mkdtempSync(join(tmpdir(), "verify-5578421-q3-v2-manual-authority-"));
  cpSync(Q30_MANUAL_STATE, stateDir, { recursive: true });
  stripManualAuthorityFixtureAnswerBoundary(stateDir);
  const prefix = "v1-0001-0003-";
  for (const directory of [
    "problem-manual-evidence",
    "problem-manual-adjudications",
    "classification-manual-adjudications",
  ]) {
    const path = join(stateDir, directory);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path)) {
      if (name.startsWith(prefix)) rmSync(join(path, name));
    }
  }
  const row = {
    spec: Q3_V2_5578421_MANUAL_SPEC,
    ...pinnedManualRecoveryParent(stateDir, Q3_V2_5578421_MANUAL_SPEC, {
      problem: "v1-0001-0003-d0679133d0fc5d5deb25c345aca9cf84f7e162e46ca6b03805dfa3f188f12981.json",
      classification: "v1-0001-0003-59f7879d4adca4dcdea88649854cd840fdd812448869705fb086e8e9de023583-" +
        "7bb7cb863c8c4855.json",
    }),
  };
  providerMock.complete.mockReset();
  providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
    expect(request.schema?.name).toBe("studywork_exam_corpus_classification");
    const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
      key: string;
      question: string;
      figure_description: string | null;
    }>;
    expect(items).toHaveLength(1);
    expect(canonicalEvidenceHash(items[0].question))
      .toBe("cfe6baeade037b4a96a2494a922c4f4d1f608420f80619a160933da7cafbb4c1");
    expect(items[0].figure_description).toContain("각 게시물 오른쪽에는 ①부터 ⑤까지");
    return { text: JSON.stringify([{
      key: "1:3",
      decision: "reject",
      canonical_subject: null,
      curriculum_course: null,
      domain: null,
      achievement_codes: [],
      confidence: 0.99,
      reason_codes: ["SOURCE_EXACT", "OUT_OF_SCOPE_SPEAKING_LISTENING"],
      transcription_status: "exact",
      transcription_evidence: "공식 1쪽 [1~3] 대담, 3번 발문, 공지와 게시판이 모두 일치한다.",
    }]) };
  });
  const adjudicated = await adjudicateProblemManual(
    row.input.entry,
    row.input.problem,
    stateDir,
    row.failed,
    row.parent,
  );
  expect(providerMock.complete).toHaveBeenCalledTimes(1);
  providerMock.complete.mockReset();
  return { ...row, adjudicated, stateDir };
}

async function q19Q21ManualRevisionAuthorityFixture5578421() {
  const stateDir = mkdtempSync(join(tmpdir(), "verify-5578421-q19-q21-manual-revision-"));
  cpSync(Q30_MANUAL_STATE, stateDir, { recursive: true });
  stripManualAuthorityFixtureAnswerBoundary(stateDir);
  for (const directory of ["problem-manual-revisions", "classification-manual-revisions"]) {
    rmSync(join(stateDir, directory), { recursive: true, force: true });
  }
  const rows = Q19_Q21_5578421_MANUAL_SPECS.map((spec) => ({
    spec,
    ...pinnedManualRecoveryParent(stateDir, spec),
  }));
  providerMock.complete.mockReset();
  providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
    expect(request.schema?.name).toBe("studywork_exam_corpus_classification");
    const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
      key: string;
      question: string;
    }>;
    expect(items).toHaveLength(1);
    expect(items[0].question).toContain("곱새담*의 짚날을 뽑아 오고….");
    return { text: JSON.stringify([{
      key: items[0].key,
      decision: "accept",
      canonical_subject: "korean_literature",
      curriculum_course: "문학",
      domain: "현대시의 표현과 감상",
      achievement_codes: ["12문학01-03"],
      confidence: 0.99,
      reason_codes: ["SOURCE_EXACT", "IN_SCOPE_KOREAN_LITERATURE"],
      transcription_status: "exact",
      transcription_evidence: `공식 7~8쪽의 ${items[0].key} 공통 지문·각주·발문·선지가 일치한다.`,
    }]) };
  });
  for (const row of rows) {
    const adjudicated = await adjudicateProblemManual(
      row.input.entry,
      row.input.problem,
      stateDir,
      row.failed,
      row.parent,
    );
    Object.assign(row, { adjudicated });
  }
  expect(providerMock.complete).toHaveBeenCalledTimes(3);
  providerMock.complete.mockReset();
  return rows.map((row) => ({
    ...row,
    adjudicated: (row as typeof row & {
      adjudicated: Awaited<ReturnType<typeof adjudicateProblemManual>>;
    }).adjudicated,
    stateDir,
  }));
}

async function q44Q45ManualAuthorityFixture5578421() {
  const stateDir = mkdtempSync(join(tmpdir(), "verify-5578421-q44-q45-manual-authority-"));
  cpSync(Q30_MANUAL_STATE, stateDir, { recursive: true });
  stripManualAuthorityFixtureAnswerBoundary(stateDir);
  for (const directory of [
    "problem-manual-revisions",
    "classification-manual-revisions",
    "problem-manual-second-revisions",
    "classification-manual-second-revisions",
  ]) rmSync(join(stateDir, directory), { recursive: true, force: true });
  const rows = Q44_Q45_5578421_MANUAL_SPECS.map((spec) => ({
    spec,
    ...pinnedManualRecoveryParent(stateDir, spec),
  }));
  const q45TerminalSpec = PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST.find((spec) =>
    spec.allowlistId === "ebsi-5578421-q45-terminal-fidelity-v1"
  )!;
  const q45FailedClassification = JSON.parse(readFileSync(join(
    Q30_MANUAL_STATE,
    q45TerminalSpec.parentClassificationArtifactPath,
  ), "utf8")).items[0];
  providerMock.complete.mockReset();
  providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
    expect(request.schema?.name).toBe("studywork_exam_corpus_classification");
    const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
      key: string;
      question: string;
      figure_description: string | null;
    }>;
    expect(items).toHaveLength(1);
    expect(items[0].question).toContain("※ <보기>를 읽고 44번과 45번 두 물음에 답하시오.");
    expect(items[0].question).toContain("소멸과 생성의 이미지를");
    expect(items[0].question).toContain("열없이 붙어서서 입김을 흐리우니");
    if (items[0].key === "16:45" && items[0].figure_description?.includes("C의 두 판단 근거")) {
      expect(items[0].figure_description).toContain("C의 두 판단 근거는 하나의 선택지 ⑤로 묶여 있다.");
      return { text: JSON.stringify([q45FailedClassification]) };
    }
    return { text: JSON.stringify([{
      key: items[0].key,
      decision: "accept",
      canonical_subject: "korean_literature",
      curriculum_course: "문학",
      domain: "현대시의 소재와 표현 효과",
      achievement_codes: ["12문학01-03"],
      confidence: 0.99,
      reason_codes: ["SOURCE_EXACT", "IN_SCOPE_KOREAN_LITERATURE"],
      transcription_status: "exact",
      transcription_evidence: items[0].key === "16:45"
        ? "공식 16쪽의 Q45 표는 B-(가)·B-(나)가 ③, C-(가)가 ④, C-(나)가 ⑤인 배치이며 교정본과 일치한다."
        : `공식 15~16쪽의 ${items[0].key} 공통 시·보기·발문·선지가 일치한다.`,
    }]) };
  });
  for (const row of rows) {
    const adjudicated = await adjudicateProblemManual(
      row.input.entry,
      row.input.problem,
      stateDir,
      row.failed,
      row.parent,
    );
    Object.assign(row, { adjudicated });
  }
  expect(providerMock.complete).toHaveBeenCalledTimes(3);
  providerMock.complete.mockReset();
  return rows.map((row) => ({
    ...row,
    adjudicated: (row as typeof row & {
      adjudicated: Awaited<ReturnType<typeof adjudicateProblemManual>>;
    }).adjudicated,
    stateDir,
  }));
}

async function q14ManualAuthorityFixture5578421() {
  const stateDir = mkdtempSync(join(tmpdir(), "verify-5578421-q14-manual-authority-"));
  cpSync(Q30_MANUAL_STATE, stateDir, { recursive: true });
  stripManualAuthorityFixtureAnswerBoundary(stateDir);
  const prefix = "v1-0005-0014-";
  for (const directory of [
    "problem-manual-revisions",
    "classification-manual-revisions",
  ]) {
    const path = join(stateDir, directory);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path)) {
      if (name.startsWith(prefix)) rmSync(join(path, name));
    }
  }
  const row = {
    spec: Q14_5578421_MANUAL_SPEC,
    ...pinnedManualRecoveryParent(stateDir, Q14_5578421_MANUAL_SPEC),
  };
  providerMock.complete.mockReset();
  providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
    expect(request.schema?.name).toBe("studywork_exam_corpus_classification");
    const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
      key: string;
      question: string;
      figure_description: string | null;
    }>;
    expect(items).toHaveLength(1);
    expect(items[0].question).toContain("불·휘기·픈남·ᄀᆞᆫᄇᆞᄅᆞ·매 ⓐ 아·니:뮐·ᄊᆡ");
    expect(items[0].question).toContain("- 『 용비어천가(龍飛御天歌) 』 제2장 중에서");
    expect(items[0].figure_description).toContain("⑤는 낮음－상승－높음－상승");
    return { text: JSON.stringify([{
      key: items[0].key,
      decision: "reject",
      canonical_subject: null,
      curriculum_course: null,
      domain: null,
      achievement_codes: [],
      confidence: 0.99,
      reason_codes: ["SOURCE_EXACT", "OUT_OF_SCOPE_KOREAN_GRAMMAR", "MIDDLE_KOREAN_PHONOLOGY"],
      transcription_status: "exact",
      transcription_evidence: "공식 5쪽 14번의 중세 국어 표기·ⓐ·성조 도식·정답 ②가 모두 일치한다.",
    }]) };
  });
  const adjudicated = await adjudicateProblemManual(
    row.input.entry,
    row.input.problem,
    stateDir,
    row.failed,
    row.parent,
  );
  expect(providerMock.complete).toHaveBeenCalledTimes(1);
  providerMock.complete.mockReset();
  return { ...row, adjudicated, stateDir };
}

async function q12ManualAuthorityFixture5578421() {
  const stateDir = mkdtempSync(join(tmpdir(), "verify-5578421-q12-manual-authority-"));
  cpSync(Q30_MANUAL_STATE, stateDir, { recursive: true });
  stripManualAuthorityFixtureAnswerBoundary(stateDir);
  const row = {
    spec: Q12_5578421_MANUAL_SPEC,
    ...pinnedManualRecoveryParent(stateDir, Q12_5578421_MANUAL_SPEC),
  };
  providerMock.complete.mockReset();
  providerMock.complete.mockRejectedValue(new Error("unexpected Q12 verifier fixture provider"));
  const adjudicated = await adjudicateProblemManual(
    row.input.entry,
    row.input.problem,
    stateDir,
    row.failed,
    row.parent,
  );
  expect(providerMock.complete).not.toHaveBeenCalled();
  providerMock.complete.mockReset();
  return { ...row, adjudicated, stateDir };
}

async function q43ManualAuthorityFixture5578421() {
  const stateDir = mkdtempSync(join(tmpdir(), "verify-5578421-q43-manual-authority-"));
  cpSync(Q30_MANUAL_STATE, stateDir, { recursive: true });
  stripManualAuthorityFixtureAnswerBoundary(stateDir);
  const prefix = "v1-0016-0043-";
  for (const directory of [
    "problem-manual-evidence",
    "problem-manual-adjudications",
    "classification-manual-adjudications",
    "problem-manual-revisions",
    "classification-manual-revisions",
    "problem-manual-second-revisions",
    "classification-manual-second-revisions",
  ]) {
    const path = join(stateDir, directory);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path)) {
      if (name.startsWith(prefix)) rmSync(join(path, name));
    }
  }
  const row = {
    spec: Q43_5578421_MANUAL_SPEC,
    ...pinnedManualRecoveryParent(stateDir, Q43_5578421_MANUAL_SPEC),
  };
  providerMock.complete.mockReset();
  providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
    expect(request.schema?.name).toBe("studywork_exam_corpus_classification");
    const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
      key: string;
      question: string;
    }>;
    expect(items).toHaveLength(1);
    expect(canonicalEvidenceHash(items[0].question))
      .toBe("80bfbfb6b31c769a54d9c52a11a83a5d8a24b22c16b2361ab041110608830eb6");
    return { text: JSON.stringify([{
      key: "16:43",
      decision: "accept",
      canonical_subject: "korean_literature",
      curriculum_course: "문학",
      domain: "현대시의 표현 방식과 작품 간 비교 감상",
      achievement_codes: ["12문학01-02"],
      confidence: 0.99,
      reason_codes: ["SOURCE_EXACT", "IN_SCOPE_KOREAN_LITERATURE"],
      transcription_status: "exact",
      transcription_evidence: "공식 15~16쪽의 [43~45] 공통 시, 43번 발문과 선택지가 일치한다.",
    }]) };
  });
  const adjudicated = await adjudicateProblemManual(
    row.input.entry,
    row.input.problem,
    stateDir,
    row.failed,
    row.parent,
  );
  expect(providerMock.complete).toHaveBeenCalledTimes(1);
  providerMock.complete.mockReset();
  return { ...row, adjudicated, stateDir };
}

async function q38ManualAuthorityFixture5578421() {
  const stateDir = mkdtempSync(join(tmpdir(), "verify-5578421-q38-manual-authority-"));
  cpSync(Q30_MANUAL_STATE, stateDir, { recursive: true });
  stripManualAuthorityFixtureAnswerBoundary(stateDir);
  const prefix = "v1-0015-0038-";
  for (const directory of [
    "problem-manual-evidence",
    "problem-manual-adjudications",
    "classification-manual-adjudications",
    "problem-manual-revisions",
    "classification-manual-revisions",
    "problem-manual-second-revisions",
    "classification-manual-second-revisions",
  ]) {
    const path = join(stateDir, directory);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path)) {
      if (name.startsWith(prefix)) rmSync(join(path, name));
    }
  }
  const row = {
    spec: Q38_5578421_MANUAL_SPEC,
    ...pinnedManualRecoveryParent(stateDir, Q38_5578421_MANUAL_SPEC, {
      problem: "v1-0015-0038-20de903b4712cf3bf362331d56a2059622d5b78dccb5806b9a94b5c21094c876.json",
      classification:
        "v1-0015-0038-e1c28ad60aaad2b3a08d95f41817cf0a002bcc780b04077cd8be07a43746a105-" +
        "7bb7cb863c8c4855.json",
    }),
  };
  providerMock.complete.mockReset();
  providerMock.complete.mockResolvedValue({ text: JSON.stringify([{
    key: "15:38",
    decision: "accept",
    canonical_subject: "korean_literature",
    curriculum_course: "문학",
    domain: "고전 소설의 서사와 인물 형상화",
    achievement_codes: ["12문학01-02"],
    confidence: 0.99,
    reason_codes: ["SOURCE_EXACT", "IN_SCOPE_KOREAN_LITERATURE"],
    transcription_status: "exact",
    transcription_evidence: "공식 13~15쪽의 [37~42] 공통 지문과 38번 발문·선택지가 일치한다.",
  }]) });
  const adjudicated = await adjudicateProblemManual(
    row.input.entry,
    row.input.problem,
    stateDir,
    row.failed,
    row.parent,
  );
  expect(providerMock.complete).toHaveBeenCalledTimes(1);
  providerMock.complete.mockReset();
  return { ...row, adjudicated, stateDir };
}

async function q2ManualAuthorityFixture5578421() {
  const stateDir = mkdtempSync(join(tmpdir(), "verify-5578421-q2-manual-authority-"));
  cpSync(Q30_MANUAL_STATE, stateDir, { recursive: true });
  stripManualAuthorityFixtureAnswerBoundary(stateDir);
  for (const directory of [
    "problem-manual-evidence",
    "problem-manual-adjudications",
    "classification-manual-adjudications",
    "problem-manual-revisions",
    "classification-manual-revisions",
    "problem-manual-second-revisions",
    "classification-manual-second-revisions",
  ]) {
    const path = join(stateDir, directory);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path)) {
      if (name.startsWith("v1-0001-0002-")) rmSync(join(path, name));
    }
  }
  const row = {
    spec: Q2_5578421_MANUAL_SPEC,
    ...pinnedManualRecoveryParent(stateDir, Q2_5578421_MANUAL_SPEC),
  };
  providerMock.complete.mockReset();
  providerMock.complete.mockImplementation(async (request: { prompt: string }) => {
    const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
      key: string;
      question: string;
    }>;
    expect(items).toHaveLength(1);
    const hasOfficialHeader = items[0].question.startsWith("[1~3] ");
    const hasOfficialHonorific = items[0].question.includes("최 교수님께서 제기하신 문제에 대해서는");
    return { text: JSON.stringify([{
      key: "1:2",
      decision: "reject",
      canonical_subject: null,
      curriculum_course: null,
      domain: null,
      achievement_codes: [],
      confidence: 0.99,
      reason_codes: hasOfficialHeader
        ? hasOfficialHonorific
          ? ["SOURCE_EXACT", "OUT_OF_SCOPE_SPEAKING_LISTENING"]
          : ["OUT_OF_SCOPE_SPEAKING_LISTENING", "RADIO_DIALOGUE_ANALYSIS"]
        : [
            "OUT_OF_SCOPE_LISTENING_SPEAKING",
            "ASSESSED_CONSTRUCT_RADIO_INTERVIEW_ANALYSIS",
            "TRANSCRIPTION_OMITS_VISIBLE_SET_LABEL",
          ],
      transcription_status: hasOfficialHeader ? "exact" : "mismatch",
      transcription_evidence: hasOfficialHeader
        ? hasOfficialHonorific
          ? "공식 1쪽의 [1~3] 머리·대담·발문·선택지와 문자 그대로 일치한다."
          : "원본 1쪽의 [1~3] 공통 라디오 대담 전체와 2번 문항의 발문 및 ①~⑤ 선지를 대조한 " +
            "결과, 문장·수치(46.9%, 500억 원, 1,000억 원, 990원/1,000원, 94%, 85%)·기호(○○, " +
            "□□, △△)·구두점과 선택지 내용이 모두 일치한다. 문항은 대담의 진행 과정과 두 " +
            "대담자의 발화 기능을 파악하는 화법·듣기 평가이므로 국어 독서 범위에서는 제외된다."
        : "원문 1·2뷰의 공통 대담과 ‘비용을 줄일 수는 있습니다’, ‘최 교수께서 제기하신 " +
          "문제에 대해서는’, ‘동전을 교환해 주고 관리하는 데 들어가는 비용을 줄일 수 있어서’가 " +
          "일치하고, 1·3뷰의 문항 2 발문과 ①~⑤도 일치한다. 다만 원문 머리의 문항군 표지 ‘[1～3]’이 " +
          "전사에서 누락되어 완전한 문자 그대로의 전사가 아니다. 문항은 라디오 대담의 진행 및 " +
          "대담자 발화를 이해하는 듣기·말하기 평가이므로 독서·문학 범위에서 제외된다.",
    }]) };
  });
  const adjudicated = await adjudicateProblemManual(
    row.input.entry,
    row.input.problem,
    stateDir,
    row.failed,
    row.parent,
  );
  expect(providerMock.complete).toHaveBeenCalledTimes(3);
  providerMock.complete.mockReset();
  return { ...row, adjudicated, stateDir };
}

async function q27ManualAuthorityFixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "verify-q27-manual-authority-"));
  cpSync(Q27_MANUAL_STATE, stateDir, { recursive: true });
  stripManualAuthorityFixtureAnswerBoundary(stateDir);
  for (const directory of [
    "problem-manual-evidence",
    "problem-manual-adjudications",
    "classification-manual-adjudications",
    "problem-manual-revisions",
    "classification-manual-revisions",
    "problem-manual-second-revisions",
    "classification-manual-second-revisions",
    "classification-manual-policy-revisions",
  ]) rmSync(join(stateDir, directory), { recursive: true, force: true });
  const { input, failed, parent } = q27ExactRecoveryParent(stateDir);
  providerMock.complete.mockReset();
  providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
    expect(request.schema?.name).toBe("studywork_exam_corpus_classification");
    expect(request.prompt).toContain("이다지 낡아빠진 생활을 하는 것은 아니리라");
    expect(request.prompt).toContain("‘존재 없이’ 살아가는 것이 어렵다고");
    return { text: JSON.stringify([{
      key: Q27_MANUAL_SPEC.key,
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
  });
  const adjudicated = await adjudicateProblemManual(
    input.entry,
    input.problem,
    stateDir,
    failed,
    parent,
  );
  providerMock.complete.mockReset();
  return { stateDir, input, failed, parent, adjudicated };
}

async function q43To45ManualAuthorityFixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "verify-q43-45-manual-authority-"));
  cpSync(Q27_MANUAL_STATE, stateDir, { recursive: true });
  stripManualAuthorityFixtureAnswerBoundary(stateDir);
  for (const directory of [
    "problem-manual-evidence",
    "problem-manual-adjudications",
    "classification-manual-adjudications",
    "problem-manual-revisions",
    "classification-manual-revisions",
  ]) rmSync(join(stateDir, directory), { recursive: true, force: true });
  const rows = Q43_TO_45_MANUAL_SPECS.map((spec) => ({
    spec,
    ...pinnedManualRecoveryParent(stateDir, spec),
  }));
  providerMock.complete.mockReset();
  for (const row of rows) {
    providerMock.complete.mockResolvedValueOnce({ text: JSON.stringify([{
      key: row.spec.key,
      decision: "accept",
      canonical_subject: "korean_literature",
      curriculum_course: "문학",
      domain: "고전 기행 가사의 표현과 상황 이해",
      achievement_codes: ["12문학01-02", "12문학01-03"],
      confidence: 0.99,
      reason_codes: ["IN_SCOPE_KOREAN_LITERATURE", "CLASSICAL_VERSE_COMPREHENSION"],
      transcription_status: "exact",
      transcription_evidence: `공식 16쪽의 공유 제시문과 문항 ${row.spec.key.split(":")[1]}이 모두 일치한다.`,
    }]) });
    const adjudicated = await adjudicateProblemManual(
      row.input.entry,
      row.input.problem,
      stateDir,
      row.failed,
      row.parent,
    );
    Object.assign(row, { adjudicated });
  }
  expect(providerMock.complete).toHaveBeenCalledTimes(3);
  providerMock.complete.mockReset();
  return rows.map((row) => ({
    ...row,
    adjudicated: (row as typeof row & {
      adjudicated: Awaited<ReturnType<typeof adjudicateProblemManual>>;
    }).adjudicated,
    stateDir,
  }));
}

async function q8Q16ManualAuthorityFixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "verify-q8-q16-manual-authority-"));
  cpSync(Q27_MANUAL_STATE, stateDir, { recursive: true });
  stripManualAuthorityFixtureAnswerBoundary(stateDir);
  for (const directory of [
    "problem-manual-evidence",
    "problem-manual-adjudications",
    "classification-manual-adjudications",
    "problem-manual-revisions",
    "classification-manual-revisions",
  ]) rmSync(join(stateDir, directory), { recursive: true, force: true });
  const rows = Q8_Q16_MANUAL_SPECS.map((spec) => ({
    spec,
    ...pinnedManualRecoveryParent(stateDir, spec),
  }));
  providerMock.complete.mockReset();
  for (const row of rows) {
    const accepted = row.spec.expectedDecision === "accept";
    providerMock.complete.mockResolvedValueOnce({ text: JSON.stringify([{
      key: row.spec.key,
      decision: accepted ? "accept" : "reject",
      canonical_subject: accepted ? "korean_reading" : null,
      curriculum_course: accepted ? "독서와 작문" : null,
      domain: accepted ? "철학 제재의 관점 비교와 추론적 읽기" : null,
      achievement_codes: accepted ? ["12독작01-03", "12독작01-04"] : [],
      confidence: 0.99,
      reason_codes: accepted
        ? ["IN_SCOPE_KOREAN_READING", "VIEWPOINT_COMPARISON"]
        : ["WRITING_PRODUCTION_EXCLUDED"],
      transcription_status: "exact",
      transcription_evidence: accepted
        ? "공식 6쪽의 [16~20] 공유 지문 전체와 16번 발문·선택지가 일치한다."
        : "공식 3~4쪽의 [6~8] 작문 계획·초고·A/B 괄호와 8번 발문·선택지가 일치한다.",
    }]) });
    const adjudicated = await adjudicateProblemManual(
      row.input.entry,
      row.input.problem,
      stateDir,
      row.failed,
      row.parent,
    );
    Object.assign(row, { adjudicated });
  }
  expect(providerMock.complete).toHaveBeenCalledTimes(2);
  providerMock.complete.mockReset();
  return rows.map((row) => ({
    ...row,
    adjudicated: (row as typeof row & {
      adjudicated: Awaited<ReturnType<typeof adjudicateProblemManual>>;
    }).adjudicated,
    stateDir,
  }));
}

async function q17Q20ManualAuthorityFixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "verify-q17-q20-manual-authority-"));
  cpSync(Q27_MANUAL_STATE, stateDir, { recursive: true });
  stripManualAuthorityFixtureAnswerBoundary(stateDir);
  for (const directory of [
    "problem-manual-evidence",
    "problem-manual-adjudications",
    "classification-manual-adjudications",
    "problem-manual-revisions",
    "classification-manual-revisions",
    "problem-manual-second-revisions",
    "classification-manual-second-revisions",
    "classification-manual-policy-revisions",
  ]) rmSync(join(stateDir, directory), { recursive: true, force: true });
  const rows = Q17_Q20_MANUAL_SPECS.map((spec) => ({
    spec,
    ...pinnedManualRecoveryParent(stateDir, spec),
  }));
  providerMock.complete.mockReset();
  for (const row of rows) {
    providerMock.complete.mockResolvedValueOnce({ text: JSON.stringify([{
      key: row.spec.key,
      decision: "accept",
      canonical_subject: "korean_reading",
      curriculum_course: "독서와 작문",
      domain: row.spec.key === "7:17"
        ? "독서: 사실적·추론적 읽기 및 논증의 개념 관계 파악"
        : "독서·문맥적 어휘 의미 파악",
      achievement_codes: row.spec.key === "7:17" ? ["12독작01-03", "12독작01-04"] : ["12독작01-03"],
      confidence: 0.99,
      reason_codes: ["NONFICTION_READING", "SOURCE_EXACT"],
      transcription_status: "exact",
      transcription_evidence: `공식 6~7쪽의 공통 지문, ${row.spec.key.split(":")[1]}번 발문과 다섯 선택지가 일치한다.`,
    }]) });
    const adjudicated = await adjudicateProblemManual(
      row.input.entry,
      row.input.problem,
      stateDir,
      row.failed,
      row.parent,
    );
    Object.assign(row, { adjudicated });
  }
  expect(providerMock.complete).toHaveBeenCalledTimes(4);
  providerMock.complete.mockReset();
  return rows.map((row) => ({
    ...row,
    adjudicated: (row as typeof row & {
      adjudicated: Awaited<ReturnType<typeof adjudicateProblemManual>>;
    }).adjudicated,
    stateDir,
  }));
}

async function q23Q29ManualAuthorityFixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "verify-q23-q29-manual-authority-"));
  cpSync(Q27_MANUAL_STATE, stateDir, { recursive: true });
  stripManualAuthorityFixtureAnswerBoundary(stateDir);
  for (const directory of [
    "problem-manual-evidence",
    "problem-manual-adjudications",
    "classification-manual-adjudications",
    "problem-manual-revisions",
    "classification-manual-revisions",
  ]) rmSync(join(stateDir, directory), { recursive: true, force: true });
  const rows = Q23_Q29_MANUAL_SPECS.map((spec) => ({
    spec,
    ...pinnedManualRecoveryParent(stateDir, spec),
  }));
  providerMock.complete.mockReset();
  for (const row of rows) {
    providerMock.complete.mockResolvedValueOnce({ text: JSON.stringify([{
      key: row.spec.key,
      decision: "accept",
      canonical_subject: "korean_literature",
      curriculum_course: "문학",
      domain: row.spec.key === "9:23"
        ? "전쟁 소설의 사회·역사적 맥락과 비평적 감상"
        : "현대시와 희곡의 표현 방식 및 의미 해석",
      achievement_codes: ["12문학01-03", "12문학01-04"],
      confidence: 0.99,
      reason_codes: ["IN_SCOPE_KOREAN_LITERATURE", "SOURCE_EXACT"],
      transcription_status: "exact",
      transcription_evidence: `공식 source의 ${row.spec.key} 전체 지문·발문·선택지가 일치한다.`,
    }]) });
    const adjudicated = await adjudicateProblemManual(
      row.input.entry,
      row.input.problem,
      stateDir,
      row.failed,
      row.parent,
    );
    Object.assign(row, { adjudicated });
  }
  expect(providerMock.complete).toHaveBeenCalledTimes(3);
  providerMock.complete.mockReset();
  return rows.map((row) => ({
    ...row,
    adjudicated: (row as typeof row & {
      adjudicated: Awaited<ReturnType<typeof adjudicateProblemManual>>;
    }).adjudicated,
    stateDir,
  }));
}

async function q30Q42ManualAuthorityFixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "verify-q30-q42-manual-authority-"));
  cpSync(Q27_MANUAL_STATE, stateDir, { recursive: true });
  stripManualAuthorityFixtureAnswerBoundary(stateDir);
  for (const directory of [
    "problem-manual-evidence",
    "problem-manual-adjudications",
    "classification-manual-adjudications",
    "problem-manual-revisions",
    "classification-manual-revisions",
    "problem-manual-second-revisions",
    "classification-manual-second-revisions",
  ]) rmSync(join(stateDir, directory), { recursive: true, force: true });
  const rows = Q30_Q42_MANUAL_SPECS.map((spec) => ({
    spec,
    ...pinnedManualRecoveryParent(stateDir, spec),
  }));
  providerMock.complete.mockReset();
  for (const row of rows) {
    const literature = ["11:30", "12:31", "12:32"].includes(row.spec.key);
    if (row.spec.key === Q32_MANUAL_REVISION_SPEC.key) {
      const parentClassification = JSON.parse(readFileSync(
        Q32_PARENT_MANUAL_CLASSIFICATION_PATH,
        "utf8",
      )).items[0];
      providerMock.complete.mockResolvedValueOnce({ text: JSON.stringify([parentClassification]) });
      const firstRevisionClassification = JSON.parse(readFileSync(
        Q32_FIRST_MANUAL_REVISION_CLASSIFICATION_PATH,
        "utf8",
      )).items[0];
      providerMock.complete.mockResolvedValueOnce({ text: JSON.stringify([firstRevisionClassification]) });
      providerMock.complete.mockResolvedValueOnce({ text: JSON.stringify([{
        key: row.spec.key,
        decision: "accept",
        canonical_subject: "korean_literature",
        curriculum_course: "문학",
        domain: "희곡의 인물과 극적 기능",
        achievement_codes: ["12문학01-03"],
        confidence: 0.99,
        reason_codes: ["SOURCE_EXACT", "IN_SCOPE_KOREAN_LITERATURE"],
        transcription_status: "exact",
        transcription_evidence: "공식 p10~p12의 전체 지문과 괄호 안 마침표, 32번 발문·선택지가 일치한다.",
      }]) });
    } else {
      providerMock.complete.mockResolvedValueOnce({ text: JSON.stringify([{
        key: row.spec.key,
        decision: "accept",
        canonical_subject: literature ? "korean_literature" : "korean_reading",
        curriculum_course: literature ? "문학" : "독서와 작문",
        domain: literature ? "현대시와 희곡의 표현 및 감상" : "보험의 경제 원리와 고지 의무",
        achievement_codes: literature ? ["12문학01-03"] : ["12독작01-03"],
        confidence: 0.99,
        reason_codes: ["IN_SCOPE_KOREAN", "SOURCE_EXACT"],
        transcription_status: "exact",
        transcription_evidence: `공식 source의 ${row.spec.key} 전체 지문·발문·선택지가 일치한다.`,
      }]) });
    }
    const adjudicated = await adjudicateProblemManual(
      row.input.entry,
      row.input.problem,
      stateDir,
      row.failed,
      row.parent,
    );
    Object.assign(row, { adjudicated });
  }
  expect(providerMock.complete).toHaveBeenCalledTimes(11);
  providerMock.complete.mockReset();
  return rows.map((row) => ({
    ...row,
    adjudicated: (row as typeof row & {
      adjudicated: Awaited<ReturnType<typeof adjudicateProblemManual>>;
    }).adjudicated,
    stateDir,
  }));
}

async function q6Q26ManualAuthorityFixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "verify-q6-q26-manual-authority-"));
  cpSync(Q27_MANUAL_STATE, stateDir, { recursive: true });
  stripManualAuthorityFixtureAnswerBoundary(stateDir);
  for (const directory of [
    "problem-manual-evidence",
    "problem-manual-adjudications",
    "classification-manual-adjudications",
    "problem-manual-revisions",
    "classification-manual-revisions",
    "problem-manual-second-revisions",
    "classification-manual-second-revisions",
    "classification-manual-policy-revisions",
  ]) rmSync(join(stateDir, directory), { recursive: true, force: true });
  const rows = Q6_Q26_MANUAL_SPECS.map((spec) => ({
    spec,
    ...pinnedTerminalManualRecoveryParent(stateDir, spec),
  }));
  providerMock.complete.mockReset();
  for (const row of rows) {
    const rejected = row.spec.expectedDecision === "reject";
    const q7Parent = row.spec.key === "3:7" ? {
      key: "3:7",
      decision: "accept",
      canonical_subject: "korean_reading",
      curriculum_course: "독서와 작문",
      domain: "독서—비문학 정보의 사실적·추론적 이해와 자료 적용",
      achievement_codes: ["12독작01-03"],
      confidence: 0.99,
      reason_codes: [
        "NONFICTION_COMPREHENSION",
        "TEXT_VISUAL_EVIDENCE_COMPARISON",
        "SINGLE_CANONICAL_SUBJECT",
      ],
      transcription_status: "exact",
      transcription_evidence: "원본 3쪽 왼쪽의 작문 계획과 초고 전체, [A]·[B]를 표시하는 오른쪽으로 열린 " +
        "세로 묶음괄호 2개, ㉠·㉡이 모두 일치한다. 오른쪽의 7번 발문과 5개 선택지, 물결 모양 위쪽 " +
        "가장자리·□□신문·두 가로 구분선·회색 제목 띠, 광고 본문의 모든 문장 및 ‘11월 2일’, ‘제품 용량 " +
        "500 ml. 1,000원’도 원본 픽셀과 일치한다.",
    } : null;
    providerMock.complete.mockResolvedValueOnce({ text: JSON.stringify([q7Parent ?? {
      key: row.spec.key,
      decision: rejected ? "reject" : "accept",
      canonical_subject: rejected ? null : "korean_literature",
      curriculum_course: rejected ? null : "문학",
      domain: rejected ? null : "전쟁 소설의 사회·역사적 맥락과 비평적 감상",
      achievement_codes: rejected ? [] : ["12문학01-03"],
      confidence: 0.99,
      reason_codes: [rejected ? "EXCLUDED_WRITING_MEDIA" : "IN_SCOPE_KOREAN_LITERATURE"],
      transcription_status: "exact",
      transcription_evidence: `공식 source pixels와 ${row.spec.key} 전체 문항이 일치한다.`,
    }]) });
    const adjudicated = await adjudicateProblemManual(
      row.input.entry,
      row.input.problem,
      stateDir,
      row.failed,
      row.parent,
    );
    Object.assign(row, { adjudicated });
  }
  expect(providerMock.complete).toHaveBeenCalledTimes(7);
  providerMock.complete.mockReset();
  return rows.map((row) => ({
    ...row,
    adjudicated: (row as typeof row & {
      adjudicated: Awaited<ReturnType<typeof adjudicateProblemManual>>;
    }).adjudicated,
    stateDir,
  }));
}

function withOnlyManualArtifactsForKey<T>(stateDir: string, key: string, run: () => T): T {
  const number = key.split(":")[1]!.padStart(4, "0");
  const keyPrefix = new RegExp(`^v\\d+-\\d{4}-${number}-`, "u");
  const renamed: Array<{ from: string; to: string }> = [];
  for (const directory of [
    "problem-manual-evidence",
    "problem-manual-adjudications",
    "classification-manual-adjudications",
    "problem-manual-revisions",
    "classification-manual-revisions",
    "problem-manual-second-revisions",
    "classification-manual-second-revisions",
    "classification-manual-policy-revisions",
  ]) {
    const absolute = join(stateDir, directory);
    if (!existsSync(absolute)) continue;
    for (const name of readdirSync(absolute)) {
      if (keyPrefix.test(name) || name.endsWith(".tmp")) continue;
      const from = join(absolute, name);
      const to = `${from}.tmp`;
      renameSync(from, to);
      renamed.push({ from, to });
    }
  }
  try {
    return run();
  } finally {
    for (const { from, to } of renamed.reverse()) renameSync(to, from);
  }
}

async function terminalAdjudicationFixture() {
  const root = mkdtempSync(join(tmpdir(), "verify-terminal-adjudication-"));
  const dataDir = join(root, "data");
  const dbPath = join(dataDir, "studywork.db");
  const manifestPath = join(dataDir, "ebsi-exam-manifest.json");
  mkdirSync(join(dataDir, "import-exam-corpus"), { recursive: true });
  const entryValue = JSON.parse(readFileSync(join(Q8_TERMINAL_ADJUDICATION_STATE, "entry.json"), "utf8"));
  const stateDir = join(dataDir, "import-exam-corpus", token(entryValue.entry.id, 24));
  cpSync(Q8_TERMINAL_ADJUDICATION_STATE, stateDir, { recursive: true });
  rmSync(join(stateDir, "receipt.json"), { force: true });
  for (const directory of [
    "problem-terminal-fidelity-adjudications",
    "migration-plans",
    "migration-commits",
    "receipt-history",
  ]) rmSync(join(stateDir, directory), { recursive: true, force: true });
  for (const [directory, pattern] of [
    ["answer-audit", /^v5-/u],
    ["answer-attestation", /^v5-/u],
  ] as const) {
    const path = join(stateDir, directory);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path)) if (pattern.test(name)) rmSync(join(path, name));
  }
  writeJson(manifestPath, { schemaVersion: 2, entries: [entryValue.entry] });

  const sourceDb = new Database(Q8_TERMINAL_ADJUDICATION_DB, { readonly: true, fileMustExist: true });
  await sourceDb.backup(dbPath);
  sourceDb.close();
  const db = new Database(dbPath);
  db.pragma("foreign_keys = OFF");
  db.exec(`
    DELETE FROM question_attempts;
    DELETE FROM book_items;
    DELETE FROM questions;
    DELETE FROM book_extraction_chunks;
    DELETE FROM book_files;
    DELETE FROM books;
  `);

  const input = terminalAdjudicationInputs(stateDir);
  const answerByNumber = new Map(input.solutions.map((item) => [String(Number(item.number)), item.answer]));
  providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
    if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
      const [item] = JSON.parse(request.prompt.split("Final question:\n")[1]) as Array<{ key: string }>;
      return { text: JSON.stringify([{
        key: item.key,
        status: "exact",
        evidence: `${item.key} 공식 문제 pixels와 최종 전사가 일치한다.`,
        scopeDecision: "accept",
        scopeConfidence: 0.99,
        scopeEvidence: `${item.key} 수학 교육과정 범위 문항이다.`,
      }]) };
    }
    if (request.schema?.name === "studywork_exam_corpus_solution_fidelity") {
      const items = JSON.parse(request.prompt.split("Accepted solutions:\n")[1]) as Array<{
        key: string;
        source_page: number;
      }>;
      return { text: JSON.stringify(items.map((item) => ({
        key: item.key,
        sourcePage: item.source_page,
        answerStatus: "exact",
        explanationStatus: "exact",
        evidence: "공식 해설의 정답과 전체 풀이가 일치한다.",
      }))) };
    }
    if (request.schema?.name === "studywork_exam_corpus_semantic_choice_check") {
      const items = JSON.parse(request.prompt.split("Items:\n")[1]) as Array<{ key: string }>;
      const markers = ["①", "②", "③", "④", "⑤"];
      return { text: JSON.stringify(items.map((item) => ({
        key: item.key,
        status: "resolved",
        choiceIndex: markers.indexOf(answerByNumber.get(item.key.split(":")[1])!) + 1,
        evidence: "공식 해설 결론과 유일한 선택지가 일치한다.",
      }))) };
    }
    throw new Error(`unexpected AI call: ${request.schema?.name ?? "unknown"}`);
  });

  const result = await repairAndAuditOfficialAnswers(
    input.entry,
    input.problem,
    input.solution,
    stateDir,
    input.classified,
    input.solutions,
  );
  const imported = matchOfficialSolutions(
    input.entry,
    result.classified,
    result.solutions,
    baseDifficultyByQuestionKey(input.classified),
  );
  const receipt = buildCorpusReceipt(
    input.entry,
    input.problem,
    input.solution,
    result.classified,
    imported,
  );
  await commitCorpusEntry(db, join(dataDir, "files"), input.entry, input.problem, input.solution, imported);
  db.close();
  await writeAnswerAttestation(
    stateDir,
    input.entry.id,
    input.problem.sha256,
    input.solution.sha256,
    receipt,
    result,
  );
  providerMock.complete.mockReset();
  return { root, dataDir, dbPath, manifestPath, stateDir, result, receipt };
}

async function persistedTerminalRecoveryFixture() {
  const root = mkdtempSync(join(tmpdir(), "verify-persisted-terminal-recovery-"));
  const dataDir = join(root, "data");
  const dbPath = join(dataDir, "studywork.db");
  const manifestPath = join(dataDir, "ebsi-exam-manifest.json");
  mkdirSync(join(dataDir, "import-exam-corpus"), { recursive: true });
  const entryValue = JSON.parse(readFileSync(join(PERSISTED_TERMINAL_RECOVERY_STATE, "entry.json"), "utf8"));
  const stateDir = join(dataDir, "import-exam-corpus", token(entryValue.entry.id, 24));
  cpSync(PERSISTED_TERMINAL_RECOVERY_STATE, stateDir, { recursive: true });
  rmSync(join(stateDir, "receipt.json"), { force: true });
  for (const directory of ["migration-plans", "migration-commits", "receipt-history"]) {
    rmSync(join(stateDir, directory), { recursive: true, force: true });
  }
  const attestationDirectory = join(stateDir, "answer-attestation");
  if (existsSync(attestationDirectory)) {
    for (const name of readdirSync(attestationDirectory)) {
      if (/^v5-/u.test(name)) rmSync(join(attestationDirectory, name));
    }
  }
  writeJson(manifestPath, { schemaVersion: 2, entries: [entryValue.entry] });

  const sourceDb = new Database(Q8_TERMINAL_ADJUDICATION_DB, { readonly: true, fileMustExist: true });
  await sourceDb.backup(dbPath);
  sourceDb.close();
  const db = new Database(dbPath);
  db.pragma("foreign_keys = OFF");
  db.exec(`
    DELETE FROM question_attempts;
    DELETE FROM book_items;
    DELETE FROM questions;
    DELETE FROM book_extraction_chunks;
    DELETE FROM book_files;
    DELETE FROM books;
  `);

  const input = terminalAdjudicationInputs(stateDir);
  providerMock.complete.mockRejectedValue(new Error("unexpected persisted terminal replay AI call"));

  const result = await repairAndAuditOfficialAnswers(
    input.entry,
    input.problem,
    input.solution,
    stateDir,
    input.classified,
    input.solutions,
  );
  const imported = matchOfficialSolutions(
    input.entry,
    result.classified,
    result.solutions,
    baseDifficultyByQuestionKey(input.classified),
  );
  const receipt = buildCorpusReceipt(input.entry, input.problem, input.solution, result.classified, imported);
  await commitCorpusEntry(db, join(dataDir, "files"), input.entry, input.problem, input.solution, imported);
  db.close();
  await writeAnswerAttestation(
    stateDir,
    input.entry.id,
    input.problem.sha256,
    input.solution.sha256,
    receipt,
    result,
  );
  expect(providerMock.complete).not.toHaveBeenCalled();
  providerMock.complete.mockReset();
  return { root, dataDir, dbPath, manifestPath, stateDir, result, receipt };
}

function rewriteTerminalAdjudicationAuthority(
  files: Awaited<ReturnType<typeof terminalAdjudicationFixture>>,
  mutate: (audit: Record<string, any>) => void,
): void {
  const auditPath = join(files.stateDir, files.result.auditPath!);
  const audit = JSON.parse(readFileSync(auditPath, "utf8"));
  mutate(audit);
  const { version: _version, auditDigest: _digest, ...auditBasis } = audit;
  const nextAuditDigest = canonicalEvidenceHash(auditBasis);
  const nextAuditRelativePath = `answer-audit/v5-${nextAuditDigest}.json`;
  for (const name of readdirSync(join(files.stateDir, "answer-audit"))) {
    if (/^v5-/u.test(name)) rmSync(join(files.stateDir, "answer-audit", name));
  }
  const nextAuditHash = writeEvidence(join(files.stateDir, nextAuditRelativePath), {
    version: 5,
    auditDigest: nextAuditDigest,
    ...auditBasis,
  });

  const attestationDirectory = join(files.stateDir, "answer-attestation");
  const attestationName = readdirSync(attestationDirectory).find((name) => /^v5-/u.test(name))!;
  const attestation = JSON.parse(readFileSync(join(attestationDirectory, attestationName), "utf8"));
  const {
    version: _attestationVersion,
    attestationDigest: _attestationDigest,
    ...attestationBasis
  } = attestation;
  attestationBasis.answerAudit = {
    path: nextAuditRelativePath,
    sha256: nextAuditHash,
    effectiveCorpusHash: audit.effectiveCorpusHash,
    effectiveSolutionCorpusHash: audit.effectiveSolutionCorpusHash,
  };
  attestationBasis.repairs = audit.repairs;
  attestationBasis.problemTerminalFidelityCheckpoints = audit.problemTerminalFidelityCheckpoints;
  attestationBasis.problemTerminalFidelityItems = audit.problemTerminalFidelityItems;
  const nextAttestationDigest = canonicalEvidenceHash(attestationBasis);
  rmSync(join(attestationDirectory, attestationName));
  writeEvidence(join(attestationDirectory, `v5-${nextAttestationDigest}.json`), {
    version: 5,
    attestationDigest: nextAttestationDigest,
    ...attestationBasis,
  });
}

async function scopeBoxRevisionFixture() {
  const root = mkdtempSync(join(tmpdir(), "verify-scope-box-revision-"));
  const dataDir = join(root, "data");
  const dbPath = join(dataDir, "studywork.db");
  const manifestPath = join(dataDir, "ebsi-exam-manifest.json");
  mkdirSync(join(dataDir, "import-exam-corpus"), { recursive: true });
  const entryValue = JSON.parse(readFileSync(join(Q11_SCOPE_STATE, "entry.json"), "utf8"));
  const stateDir = join(dataDir, "import-exam-corpus", token(entryValue.entry.id, 24));
  cpSync(Q11_SCOPE_STATE, stateDir, { recursive: true });
  rmSync(join(stateDir, "receipt.json"), { force: true });
  for (const directory of [
    "problem-scope-box-evidence",
    "problem-scope-box-revisions",
    "classification-scope-box-revisions",
    "problem-terminal-fidelity-policy-revisions",
    "solution-repairs",
    "solution-fidelity-repairs",
    "problem-manual-evidence",
    "problem-manual-adjudications",
    "classification-manual-adjudications",
    "classification-manual-policy-revisions",
    "migration-plans",
    "migration-commits",
    "receipt-history",
  ]) rmSync(join(stateDir, directory), { recursive: true, force: true });
  for (const [directory, pattern] of [
    ["answer-audit", /^v5-/u],
    ["answer-attestation", /^v5-/u],
    ["semantic-choice-checks", /^v5-/u],
  ] as const) {
    const path = join(stateDir, directory);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path)) if (pattern.test(name)) rmSync(join(path, name));
  }
  writeJson(manifestPath, { schemaVersion: 2, entries: [entryValue.entry] });
  const sourceDb = new Database(Q8_TERMINAL_ADJUDICATION_DB, { readonly: true, fileMustExist: true });
  await sourceDb.backup(dbPath);
  sourceDb.close();
  const db = new Database(dbPath);
  db.pragma("foreign_keys = OFF");
  db.exec(`
    DELETE FROM question_attempts;
    DELETE FROM book_items;
    DELETE FROM questions;
    DELETE FROM book_extraction_chunks;
    DELETE FROM book_files;
    DELETE FROM books;
  `);

  const input = terminalAdjudicationInputs(stateDir);
  const terminalTemplate = JSON.parse(readFileSync(join(
    stateDir,
    PROBLEM_SCOPE_BOX_REVISION_ALLOWLIST[0].triggerTerminalPath,
  ), "utf8"));
  const scopeByKey = new Map<string, Record<string, any>>(
    terminalTemplate.items.map((item: Record<string, any>) => [item.key, item]),
  );
  const q11TerminalSpec = PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST.find((spec) =>
    spec.entryId === "ebsi:5577055" && spec.key === "4:11")!;
  const q11ScopeBoxDecision = JSON.parse(readFileSync(join(
    Q11_SCOPE_STATE,
    q11TerminalSpec.parentClassificationArtifactPath,
  ), "utf8")).items[0];
  const solutionByNumber = new Map(input.solutions.map((item) => [String(Number(item.number)), item]));
  let solutionFidelityCalls = 0;
  providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
    if (request.schema?.name === "studywork_exam_corpus_classification") {
      expect(request.prompt).toContain('"box":[0.12,0.36]');
      return { text: JSON.stringify([q11ScopeBoxDecision]) };
    }
    if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
      if (request.prompt.includes("Final question:\n")) {
        throw new Error("persisted Q11 terminal child must be revised without AI");
      }
      const items = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{ key: string }>;
      return { text: JSON.stringify(items.map((item) => {
        const scope = scopeByKey.get(item.key)!;
        return {
          key: item.key,
          status: "exact",
          evidence: item.key === "4:11"
            ? "공식 4쪽의 stem, graph, labels, choices와 확장 box가 모두 일치한다."
            : "공식 source pixels와 일치한다.",
          scopeDecision: scope.scopeDecision,
          scopeConfidence: scope.scopeConfidence,
          scopeEvidence: scope.scopeEvidence,
        };
      })) };
    }
    if (request.schema?.name === "studywork_exam_corpus_solution_fidelity") {
      solutionFidelityCalls++;
      const items = JSON.parse(request.prompt.split("Accepted solutions:\n")[1]) as Array<{
        key: string;
        source_page: number;
      }>;
      return { text: JSON.stringify(items.map((item) => ({
        key: item.key,
        sourcePage: item.source_page,
        answerStatus: item.key === "2:5" && solutionFidelityCalls === 1 ? "mismatch" : "exact",
        explanationStatus: "exact",
        evidence: item.key === "2:5" && solutionFidelityCalls === 1
          ? "공식 1쪽은 a=세제곱근 2인데 base raw answer는 제곱근 2다."
          : "공식 해설의 답과 전체 설명이 일치한다.",
      }))) };
    }
    if (request.schema?.name === "studywork_solution_file_items") {
      return { text: JSON.stringify([{ ...solutionByNumber.get("5")!, answer: "$\\sqrt[3]{2}$" }]) };
    }
    if (request.schema?.name === "studywork_exam_corpus_semantic_choice_check") {
      const items = JSON.parse(request.prompt.split("Items:\n")[1]) as Array<{ key: string; choices: string[] }>;
      return { text: JSON.stringify(items.map((item) => ({
        key: item.key,
        status: "resolved",
        choiceIndex: resolveOfficialAnswer(
          { qtype: "mcq", choices: item.choices } as QuizItemEx,
          solutionByNumber.get(item.key.split(":")[1])!.answer,
        ).choiceIndex! + 1,
        evidence: "공식 해설 결론과 한 선택지가 유일하게 일치한다.",
      }))) };
    }
    throw new Error(`unexpected AI call: ${request.schema?.name ?? "unknown"}`);
  });
  const result = await repairAndAuditOfficialAnswers(
    input.entry,
    input.problem,
    input.solution,
    stateDir,
    input.classified,
    input.solutions,
  );
  const imported = matchOfficialSolutions(
    input.entry,
    result.classified,
    result.solutions,
    baseDifficultyByQuestionKey(input.classified),
  );
  const receipt = buildCorpusReceipt(input.entry, input.problem, input.solution, result.classified, imported);
  await commitCorpusEntry(db, join(dataDir, "files"), input.entry, input.problem, input.solution, imported);
  db.close();
  await writeAnswerAttestation(
    stateDir,
    input.entry.id,
    input.problem.sha256,
    input.solution.sha256,
    receipt,
    result,
  );
  providerMock.complete.mockReset();
  return { root, dataDir, dbPath, manifestPath, stateDir, result, receipt };
}

describe("exam corpus verifier", () => {
  it.skipIf(!existsSync(join(PERSISTED_TERMINAL_RECOVERY_STATE, "problem.pdf")))(
  "hydrates Q11 selected/history plus the exact current Q15 companion recovery",
  async () => {
    expect(persistedTerminalRecoveryHydrationAllowlistFingerprint())
      .toBe("ebd0be1ee016550a669c4f3164c85048f79ebeadba5e702b1d6aa2c8352bcd50");
    expect(persistedTerminalRecoveryHydrationAllowlistFingerprint())
      .toBe(canonicalEvidenceHash(PERSISTED_TERMINAL_RECOVERY_HYDRATION_ALLOWLIST));
    const spec = PERSISTED_TERMINAL_RECOVERY_HYDRATION_ALLOWLIST[0];
    const companion = spec.companion!;
    const files = await persistedTerminalRecoveryFixture();
    try {
      const report = verifyExamCorpus(files);
      expect(report, JSON.stringify(report.failures, null, 2)).toMatchObject({
        ok: true,
        failureCount: 0,
        questions: { expected: 4, actual: 4 },
      });
      expect(verifyExamCorpus(files).ok).toBe(true);
      const audit = JSON.parse(readFileSync(join(files.stateDir, files.result.auditPath!), "utf8"));
      expect(files.result).toMatchObject({
        auditPath: companion.finalAudit.path,
        auditHash: companion.finalAudit.sha256,
        effectiveCorpusHash: companion.finalEffectiveCorpusHash,
      });
      expect(audit.problemTerminalFidelityCheckpoints).toEqual([companion.finalTerminal]);
      const recovery = audit.repairs.find((repair: { key: string }) => repair.key === spec.key)
        .revision.recovery;
      expect(recovery).toMatchObject({
        problemArtifact: {
          path: spec.selected.problemArtifact.path,
          sha256: spec.selected.problemArtifact.sha256,
        },
        classificationArtifact: {
          path: spec.selected.classificationArtifact.path,
          sha256: spec.selected.classificationArtifact.sha256,
        },
        effectiveQuestionHash: spec.selected.problemArtifact.itemHash,
        effectiveClassificationHash: spec.selected.classificationArtifact.itemHash,
      });
      expect(recovery.problemArtifact.path).not.toBe(spec.historical[0].problemArtifact.path);
      expect(audit.problemTerminalFidelityItems.find((item: { key: string }) => item.key === spec.key))
        .toMatchObject({ status: "exact", scopeDecision: "accept" });
      const companionRepair = audit.repairs.find((repair: { key: string }) => repair.key === companion.key);
      expect(canonicalEvidenceHash(companionRepair)).toBe(companion.repairHash);
      expect(companionRepair.revision.recovery).toMatchObject({
        problemArtifact: {
          path: companion.selected.problemArtifact.path,
          sha256: companion.selected.problemArtifact.sha256,
        },
        classificationArtifact: {
          path: companion.selected.classificationArtifact.path,
          sha256: companion.selected.classificationArtifact.sha256,
        },
        effectiveQuestionHash: companion.selected.problemArtifact.itemHash,
        effectiveClassificationHash: companion.selected.classificationArtifact.itemHash,
      });
      expect(audit.problemTerminalFidelityItems.find((item: { key: string }) => item.key === companion.key))
        .toMatchObject({ status: "exact", scopeDecision: "reject" });
      const db = new Database(files.dbPath, { readonly: true });
      expect(db.prepare("SELECT question FROM questions WHERE printed_number = '11'").get())
        .toEqual({ question: spec.selected.questionText });
      expect(db.prepare("SELECT COUNT(*) AS count FROM questions WHERE printed_number = '15'").get())
        .toEqual({ count: 0 });
      db.close();

      const historicalProblemPath = join(files.stateDir, spec.historical[0].problemArtifact.path);
      const historicalProblemBytes = readFileSync(historicalProblemPath);
      writeFileSync(historicalProblemPath, Buffer.concat([historicalProblemBytes, Buffer.from("tampered")]));
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);
      writeFileSync(historicalProblemPath, historicalProblemBytes);

      const selectedClassificationPath = join(files.stateDir, spec.selected.classificationArtifact.path);
      const selectedClassificationBytes = readFileSync(selectedClassificationPath);
      writeFileSync(selectedClassificationPath, Buffer.concat([selectedClassificationBytes, Buffer.from("tampered")]));
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);
      writeFileSync(selectedClassificationPath, selectedClassificationBytes);

      const historicalClassificationPath = join(files.stateDir, spec.historical[0].classificationArtifact.path);
      const historicalClassificationBytes = readFileSync(historicalClassificationPath);
      rmSync(historicalClassificationPath);
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("missing"))).toBe(true);
      writeFileSync(historicalClassificationPath, historicalClassificationBytes);

      const thirdPath = join(
        files.stateDir,
        "problem-recoveries",
        `v2-0004-0011-${"0".repeat(64)}.json`,
      );
      cpSync(join(files.stateDir, spec.selected.problemArtifact.path), thirdPath);
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("third generation"))).toBe(true);
      rmSync(thirdPath);

      const historicalCopy = join(files.stateDir, "historical-classification-copy.json");
      cpSync(historicalClassificationPath, historicalCopy);
      rmSync(historicalClassificationPath);
      symlinkSync(historicalCopy, historicalClassificationPath);
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);
      rmSync(historicalClassificationPath);
      writeFileSync(historicalClassificationPath, historicalClassificationBytes);
      rmSync(historicalCopy);

      const historicalTriggerPath = join(files.stateDir, spec.historical[0].terminalCheckpoint.path);
      const historicalTriggerBytes = readFileSync(historicalTriggerPath);
      writeFileSync(historicalTriggerPath, Buffer.concat([historicalTriggerBytes, Buffer.from("tampered")]));
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);
      writeFileSync(historicalTriggerPath, historicalTriggerBytes);

      const companionProblemPath = join(files.stateDir, companion.selected.problemArtifact.path);
      const companionProblemBytes = readFileSync(companionProblemPath);
      writeFileSync(companionProblemPath, Buffer.concat([companionProblemBytes, Buffer.from("tampered")]));
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);
      writeFileSync(companionProblemPath, companionProblemBytes);

      const companionClassificationPath = join(files.stateDir, companion.selected.classificationArtifact.path);
      const companionClassificationBytes = readFileSync(companionClassificationPath);
      rmSync(companionClassificationPath);
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("missing"))).toBe(true);
      writeFileSync(companionClassificationPath, companionClassificationBytes);

      const companionOrphanPath = join(
        files.stateDir,
        "problem-recoveries",
        `v2-0006-0015-${"0".repeat(64)}.json`,
      );
      cpSync(companionProblemPath, companionOrphanPath);
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("third generation"))).toBe(true);
      rmSync(companionOrphanPath);

      const recoveryDirectory = join(files.stateDir, "problem-recoveries");
      const recoveryDirectoryCopy = join(files.stateDir, "problem-recoveries-copy");
      cpSync(recoveryDirectory, recoveryDirectoryCopy, { recursive: true });
      rmSync(recoveryDirectory, { recursive: true });
      symlinkSync(recoveryDirectoryCopy, recoveryDirectory);
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);
      rmSync(recoveryDirectory);
      renameSync(recoveryDirectoryCopy, recoveryDirectory);

      const oldAuditName = readdirSync(join(PERSISTED_TERMINAL_RECOVERY_STATE, "answer-audit"))
        .find((name) => /^v5-/u.test(name))!;
      const oldAudit = JSON.parse(readFileSync(join(
        PERSISTED_TERMINAL_RECOVERY_STATE,
        "answer-audit",
        oldAuditName,
      ), "utf8"));
      const badRecovery = oldAudit.repairs.find((repair: { key: string }) => repair.key === spec.key)
        .revision.recovery;
      rewriteTerminalAdjudicationAuthority(files, (currentAudit) => {
        currentAudit.repairs.find((repair: { key: string }) => repair.key === spec.key)
          .revision.recovery = structuredClone(badRecovery);
      });
      const badAudit = verifyExamCorpus(files);
      expect(badAudit.failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID"
        && failure.message.includes("source-authorized terminal recovery"))).toBe(true);

      for (const directory of ["answer-audit", "answer-attestation"]) {
        for (const name of readdirSync(join(files.stateDir, directory))) {
          if (/^v5-/u.test(name)) rmSync(join(files.stateDir, directory, name));
        }
      }
      expect(verificationContractAuditVersionForTest(files.stateDir)).toBe(5);
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_ATTESTATION_MISSING")).toBe(true);
    } finally {
      providerMock.complete.mockReset();
      rmSync(files.root, { recursive: true, force: true });
    }
  }, 180_000);

  it("keeps the exact existing-corpus migration allowlist aligned with the importer", () => {
    expect(existingCorpusMigrationAllowlistFingerprint())
      .toBe("0c6efd85302d9cf50e390df5281b78e7995314dac351e2005dc4da20947128a2");
    expect(existingCorpusMigrationAllowlistFingerprint())
      .toBe(canonicalEvidenceHash(EXISTING_CORPUS_MIGRATION_ALLOWLIST));
    expect(EXISTING_CORPUS_MIGRATION_ALLOWLIST.map((spec) => spec.entryId)).toEqual([
      "ebsi:5695028",
      "ebsi:5734412",
      "ebsi:5696440",
      "ebsi:5854175",
      "ebsi:5525983",
      "ebsi:5578422",
      "ebsi:5853840",
      "ebsi:5853841",
      "ebsi:5642949",
      "ebsi:5642950",
      "ebsi:5734413",
      "ebsi:5656592",
      "ebsi:5577055",
      "ebsi:5594500",
      "ebsi:5525984",
      "ebsi:5594501",
      "ebsi:5769268",
      "ebsi:5875877",
      "ebsi:5578423",
      "ebsi:5772823",
      "ebsi:5525982",
    ]);
    expect(EXISTING_CORPUS_MIGRATION_ALLOWLIST.filter((spec) =>
      !["ebsi:5695028", "ebsi:5853841", "ebsi:5577055", "ebsi:5525984"].includes(spec.entryId)
    ).every((spec) => spec.newKeys.length === 0 && spec.newQuestions.length === 0)).toBe(true);
    expect(EXISTING_CORPUS_MIGRATION_ALLOWLIST.find((spec) => spec.entryId === "ebsi:5853841"))
      .toMatchObject({
        newKeys: ["1:2"],
        newQuestions: [expect.objectContaining({
          key: "1:2",
          targetSubject: "수학 - 수학Ⅰ·대수",
          answer: "①",
        })],
      });
    expect(EXISTING_CORPUS_MIGRATION_ALLOWLIST.find((spec) => spec.entryId === "ebsi:5656592"))
      .toMatchObject({
        entryToken: "c83035d36ef8d2b8f1bfe856",
        oldReceiptSha256: "39a7e7a753e8c29d9dae9bde1707fc3cab85f6614e21b8d26f46e81873874b7e",
        beforeProjectionHash: "a3305a7556bb63f334cf825e3ca14007b4a310cbb30e20595dd76d7e6ea7ee88",
        afterProjectionHash: "7e14938c29994f017201b9246298d1f4f3aec79c8b2a98b4e95b1a32e810244f",
        auditSha256: "74ed4b805d9d0055b66e91a805e55cb801fed7b92c86de8e5e07b88aea09c838",
        questionIds: [3487, 3488, 3489, 3490],
        bookItemIds: [7504, 7505, 7506, 7507, 7508, 7509, 7510, 7511],
        newKeys: [],
        newQuestions: [],
      });
    expect(EXISTING_CORPUS_MIGRATION_ALLOWLIST.find((spec) => spec.entryId === "ebsi:5577055"))
      .toMatchObject({
        entryToken: "b4eeaf53cd6024aa180d1f37",
        oldReceiptSha256: "51f5f9415746cfbc8c87bb20bf691ae66ca15e93e4f1ca31a2746c925988bdec",
        receiptCoreSha256: "51d06f30a79670ee20019ac8ed3911d1fac73070170ca9a53a081213279f5bd2",
        beforeProjectionHash: "f9f8d0c5b200aa6e7147ff9a6f5397b04e95f9e4b59062fae64667676f9c5a3b",
        afterProjectionHash: "2fe1f7dbc05af37cf42099082dd1e80ae5fe3e91500c5ec73590b87800931030",
        questionIds: [3491, 3492, 3493, 3494, 3495],
        bookItemIds: [7512, 7513, 7514, 7515, 7516, 7517, 7518, 7519, 7520, 7521],
        newKeys: ["2:5"],
        newQuestions: [expect.objectContaining({
          key: "2:5",
          difficulty: "중",
          answer: "④ $\\sqrt[3]{2}$",
        })],
      });
    expect(EXISTING_CORPUS_MIGRATION_ALLOWLIST.find((spec) => spec.entryId === "ebsi:5525984"))
      .toMatchObject({
        entryToken: "7755c70fefaa45f755086e2b",
        receiptCoreSha256: "34c59e90557f5aff5b6fc422426a296901d0777b0d533a5d4220b5f4dc9277c1",
        beforeProjectionHash: "2c2a65902b4e0c78d35545f25a36a018a8fb61f6386eb85eef95bb4bc1946fce",
        afterProjectionHash: "74a78e48a28f366787238a8e9d901b73821ac7b4a23889002fc3e844ef2429c8",
        newKeys: ["10:25", "7:18"],
        newQuestions: [
          expect.objectContaining({ key: "10:25", difficulty: "하", answer: "150" }),
          expect.objectContaining({ key: "7:18", difficulty: "중", answer: "④" }),
        ],
      });
    const koreanMigration = EXISTING_CORPUS_MIGRATION_ALLOWLIST.find((spec) => spec.entryId === "ebsi:5525982")!;
    expect(koreanMigration).toMatchObject({
      entryToken: "bb876a67170089dfb2022f47",
      receiptCoreSha256: "7e2a247ab9d1e4bed7db8fdd56486cc25b68441ac1213a8cee69391917dabf48",
      beforeProjectionHash: "460b040f3fe396e3cf4086d94132c77db66fd1b46a3498fa44afde2b03384a81",
      afterProjectionHash: "7e981e83d9a81a2cb07f603ecbc6dfdb6ae7df590b492e5e5ab12851e817647a",
      newKeys: [],
      newQuestions: [],
    });
    expect(koreanMigration.answerChoiceRevisions).toHaveLength(10);
    expect(canonicalEvidenceHash(koreanMigration.answerChoiceRevisions))
      .toBe("994bf57c028f32483050547cefa5baba67d2ec831e953318b86f7702fba600e3");
  });

  it.skipIf(
    !existsSync(join(Q8_TERMINAL_ADJUDICATION_STATE, "problem.pdf"))
      || !existsSync(join(Q8_TERMINAL_ADJUDICATION_STATE, "solution.pdf"))
      || !existsSync(Q8_TERMINAL_ADJUDICATION_DB),
  )("reconstructs both Q8/Q20 terminal children and rejects missing, tampered, or orphan authority", async () => {
    expect(PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_VERSION).toBe(1);
    expect(PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_PROMPT_DIGEST)
      .toBe("e92ed29fdd979e63d56635b2f7c99284ad01f14893384e680acd150cb2a29728");
    expect(terminalFidelityAdjudicationAllowlistFingerprint())
      .toBe("2391e658b51e40410bf242bdfd6c113383d97c8cbde86d02ca2f6499a9ab904e");
    expect(terminalFidelityAdjudicationAllowlistFingerprint())
      .toBe(canonicalEvidenceHash(PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST));

    const files = await terminalAdjudicationFixture();
    try {
      const report = verifyExamCorpus(files);
      expect(report, JSON.stringify(report.failures, null, 2)).toMatchObject({
        ok: true,
        failureCount: 0,
        questions: { expected: 13, actual: 13 },
      });
      expect(files.result.effectiveCorpusHash)
        .toBe("1e076c1128fc58f956f12db80716af215f2cedf605c1816acc5e234d0c320021");
      expect(files.result.problemTerminalFidelityItems).toHaveLength(30);
      const audit = JSON.parse(readFileSync(join(files.stateDir, files.result.auditPath!), "utf8"));
      const adjudicated = audit.repairs.filter((repair: Record<string, any>) => repair.terminalAdjudication);
      expect(adjudicated.map((repair: { key: string }) => repair.key).sort()).toEqual(["3:8", "8:20"]);
      for (const spec of PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST.filter((candidate) =>
        candidate.entryId === "ebsi:5525984")) {
        const repair = adjudicated.find((value: { key: string }) => value.key === spec.key);
        expect(repair.terminalAdjudication).toMatchObject({
          allowlistId: spec.allowlistId,
          key: spec.key,
          parentKind: spec.parentKind,
          failedTerminalCheckpoint: {
            path: spec.failedTerminalPath,
            sha256: spec.failedTerminalArtifactHash,
          },
        });
        const current = files.result.classified.find((value) => value.classification.key === spec.key)!;
        expect(canonicalEvidenceHash(current.question)).toBe(spec.parentQuestionHash);
        expect(canonicalEvidenceHash(current.classification)).toBe(spec.parentClassificationHash);
        expect(audit.problemTerminalFidelityItems.find((item: { key: string }) => item.key === spec.key))
          .toMatchObject({ status: "exact", scopeDecision: "accept", scopeConfidence: 0.99 });
      }
      const failedTerminal = JSON.parse(readFileSync(join(
        files.stateDir,
        PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST[0].failedTerminalPath,
      ), "utf8"));
      expect(failedTerminal.inputs).toHaveLength(30);
      expect(failedTerminal.items.filter((item: { key: string }) => item.key === "3:8" || item.key === "8:20"))
        .toEqual([
          expect.objectContaining({ key: "3:8", status: "mismatch", scopeDecision: "accept" }),
          expect.objectContaining({ key: "8:20", status: "mismatch", scopeDecision: "accept" }),
        ]);
      expect(audit.solutionFidelityItems.find((item: { key: string }) => item.key === "3:8"))
        .toMatchObject({ answerStatus: "exact", explanationStatus: "exact" });
      expect(audit.semanticCheckpoint.path).toBe(
        `semantic-choice-checks/v5-${audit.effectiveCorpusHash}-` +
          `${audit.effectiveSolutionCorpusHash}-${audit.semanticCheckpoint.inputHash}.json`,
      );
      const db = new Database(files.dbPath, { readonly: true });
      const q8 = db.prepare(
        `SELECT s.name AS subject, q.answer, q.explanation
         FROM questions q JOIN subjects s ON s.id = q.subject_id
         WHERE q.printed_number = '8'`,
      ).get() as { subject: string; answer: string; explanation: string };
      db.close();
      expect(q8).toMatchObject({ subject: "수학 - 수학Ⅱ·미적분Ⅰ" });
      expect(q8.answer).not.toBe("");
      expect(q8.explanation).not.toBe("");

      const swapped = await terminalAdjudicationFixture();
      try {
        rewriteTerminalAdjudicationAuthority(swapped, (swappedAudit) => {
          const byKey = new Map<string, Record<string, any>>(
            swappedAudit.repairs.map((repair: Record<string, any>) => [repair.key, repair]),
          );
          const q8Repair = byKey.get("3:8")!;
          const q20Repair = byKey.get("8:20")!;
          const q8Path = join(
            swapped.stateDir,
            q8Repair.terminalAdjudication.adjudicationArtifact.path,
          );
          const q20Path = join(
            swapped.stateDir,
            q20Repair.terminalAdjudication.adjudicationArtifact.path,
          );
          const q8Checkpoint = JSON.parse(readFileSync(q8Path, "utf8"));
          const q20Checkpoint = JSON.parse(readFileSync(q20Path, "utf8"));
          q8Checkpoint.items[0].key = "8:20";
          q20Checkpoint.items[0].key = "3:8";
          q8Repair.terminalAdjudication.adjudicationArtifact.sha256 = writeEvidence(q8Path, q8Checkpoint);
          q20Repair.terminalAdjudication.adjudicationArtifact.sha256 = writeEvidence(q20Path, q20Checkpoint);
          q8Repair.terminalAdjudication.adjudicationItemHash = canonicalEvidenceHash(q8Checkpoint.items[0]);
          q20Repair.terminalAdjudication.adjudicationItemHash = canonicalEvidenceHash(q20Checkpoint.items[0]);
          swappedAudit.problemTerminalFidelityItems = swappedAudit.problemTerminalFidelityItems.map(
            (item: { key: string }) => item.key === "3:8"
              ? q20Checkpoint.items[0]
              : item.key === "8:20" ? q8Checkpoint.items[0] : item,
          );
        });
        const swappedReport = verifyExamCorpus(swapped);
        expect(swappedReport.failures.some((failure) =>
          failure.code === "ANSWER_AUDIT_INVALID"
            && failure.message.includes("terminal fidelity adjudication checkpoint/evidence")),
        JSON.stringify(swappedReport.failures, null, 2)).toBe(true);
      } finally {
        rmSync(swapped.root, { recursive: true, force: true });
      }

      const q8Child = join(files.stateDir, adjudicated.find(
        (value: { key: string }) => value.key === "3:8",
      ).terminalAdjudication.adjudicationArtifact.path);
      const q20Child = join(files.stateDir, adjudicated.find(
        (value: { key: string }) => value.key === "8:20",
      ).terminalAdjudication.adjudicationArtifact.path);
      const q8Bytes = readFileSync(q8Child);
      const q20Bytes = readFileSync(q20Child);

      writeFileSync(q8Child, Buffer.concat([q8Bytes, Buffer.from("tampered")]));
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);
      writeFileSync(q8Child, q8Bytes);

      rmSync(q20Child);
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("missing"))).toBe(true);
      writeFileSync(q20Child, q20Bytes);

      const orphan = join(
        files.stateDir,
        "problem-terminal-fidelity-adjudications",
        `v1-0003-0008-${"1".repeat(64)}.json`,
      );
      writeJson(orphan, {});
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("not declared"))).toBe(true);
      rmSync(orphan);

      const failedTerminalPath = join(
        files.stateDir,
        PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST[0].failedTerminalPath,
      );
      const failedTerminalBytes = readFileSync(failedTerminalPath);
      writeFileSync(failedTerminalPath, Buffer.concat([failedTerminalBytes, Buffer.from("tampered")]));
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);
      writeFileSync(failedTerminalPath, failedTerminalBytes);

      const q8Fidelity = audit.solutionFidelityItems.find((item: { key: string }) => item.key === "3:8")
        .fidelityArtifact.path;
      const q8FidelityPath = join(files.stateDir, q8Fidelity);
      const q8FidelityBytes = readFileSync(q8FidelityPath);
      rmSync(q8FidelityPath);
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);
      writeFileSync(q8FidelityPath, q8FidelityBytes);
    } finally {
      providerMock.complete.mockReset();
      rmSync(files.root, { recursive: true, force: true });
    }
  }, 180_000);

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

  it("verifies the completed 5853841 count-changing migration and stable replay", async () => {
    const entryId = "ebsi:5853841";
    const spec = EXISTING_CORPUS_MIGRATION_ALLOWLIST.find((candidate) => candidate.entryId === entryId)!;
    const files = await migratedVerifierFixture(entryId);
    const verify = () => verifyExamCorpus({
      manifestPath: files.manifestPath,
      dbPath: files.dbPath,
      dataDir: files.dataDir,
    });
    try {
      expect(files.plan.identity).toMatchObject({
        beforeProjectionHash: spec.beforeProjectionHash,
        afterProjectionHash: spec.afterProjectionHash,
        stableAfterProjectionHash: "1f8a27732840bb54f25f177769f0837c73533156c58ce930d690946585e0fe53",
        afterSequences: { questions: 3529, bookItems: 7589 },
      });
      expect(files.plan.identity.operations.questionUpdates).toHaveLength(8);
      expect(files.plan.identity.operations.itemUpdates).toHaveLength(16);
      expect(files.plan.identity.operations.questionInserts).toHaveLength(1);
      expect(files.plan.identity.operations.itemInserts).toHaveLength(2);
      expect(files.plan.identity.operations.questionInserts[0].after).toMatchObject({
        id: 3529,
        src_page: 1,
        printed_number: "2",
        question: "$\\sqrt{4}\\times\\sqrt[3]{8}$의 값은? [2점]",
        answer: "①",
      });
      expect(files.plan.identity.operations.itemInserts.map(
        (item: { after: { id: number } }) => item.after.id,
      )).toEqual([7588, 7589]);
      expect(verify(), JSON.stringify(verify().failures, null, 2))
        .toMatchObject({ ok: true, failureCount: 0, questions: { expected: 9, actual: 9 } });

      let db = new Database(files.dbPath);
      try {
        expect(db.prepare(
          "SELECT id, printed_number, src_page, answer FROM questions WHERE id = 3529",
        ).get()).toEqual({ id: 3529, printed_number: "2", src_page: 1, answer: "①" });
        expect((db.prepare("SELECT id FROM book_items WHERE id IN (7588, 7589) ORDER BY id")
          .all() as Array<{ id: number }>).map((row) => row.id)).toEqual([7588, 7589]);
        db.prepare(
          "UPDATE questions SET correct_count = 4, wrong_count = 3, from_wrong_note = 1 WHERE id = 3529",
        ).run();
        db.prepare(
          "INSERT INTO question_attempts (question_id, attempt_id, correct) VALUES (3529, 'verify-5853841', 1)",
        ).run();
      } finally {
        db.close();
      }

      const explicit = await execFileP(process.execPath, [
        "--import", "tsx", "scripts/import-exam-corpus.ts",
        "--manifest", "data/ebsi-exam-manifest.json",
        "--data-dir", files.dataDir,
        "--commit",
        "--migrate-existing", entryId,
        "--expect-receipt-sha256", spec.oldReceiptSha256,
      ], {
        cwd: migrationRepository,
        timeout: 60_000,
        env: { ...process.env, STUDYWORK_CODEX_BIN: "/usr/bin/false" },
      });
      expect(explicit.stdout).toContain("existing ebsi:5853841 9");
      const normal = await execFileP(process.execPath, [
        "--import", "tsx", "scripts/import-exam-corpus.ts",
        "--manifest", files.manifestPath,
        "--data-dir", files.dataDir,
        "--commit",
      ], {
        cwd: migrationRepository,
        timeout: 60_000,
        env: { ...process.env, STUDYWORK_CODEX_BIN: "/usr/bin/false" },
      });
      expect(normal.stdout).toContain("existing ebsi:5853841 9");
      expect(verify()).toMatchObject({ ok: true, failureCount: 0 });
      db = new Database(files.dbPath, { readonly: true });
      try {
        expect(db.prepare(
          "SELECT correct_count, wrong_count, from_wrong_note FROM questions WHERE id = 3529",
        ).get()).toEqual({ correct_count: 4, wrong_count: 3, from_wrong_note: 1 });
        expect((db.prepare(
          "SELECT COUNT(*) AS count FROM question_attempts WHERE attempt_id = 'verify-5853841'",
        ).get() as { count: number }).count).toBe(1);
      } finally {
        db.close();
      }

      const originalPlan = readFileSync(files.planPath);
      const tamperedPlan = structuredClone(files.plan);
      tamperedPlan.identity.operations.questionInserts[0].after.question = "tampered inserted question";
      writeEvidence(files.planPath, tamperedPlan);
      expect(verify().failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "MIGRATION_INVALID" }),
      ]));
      writeFileSync(files.planPath, originalPlan);
    } finally {
      rmSync(files.root, { recursive: true, force: true });
    }
  }, 120_000);

  it("verifies the completed 5525984 two-question migration and stable replay", async () => {
    const entryId = "ebsi:5525984";
    const spec = EXISTING_CORPUS_MIGRATION_ALLOWLIST.find((candidate) => candidate.entryId === entryId)!;
    const files = await migratedVerifierFixture(entryId);
    const verify = () => verifyExamCorpus({
      manifestPath: files.manifestPath,
      dbPath: files.dbPath,
      dataDir: files.dataDir,
    });
    try {
      expect(files.plan.identity).toMatchObject({
        receiptCore: { sha256: spec.receiptCoreSha256 },
        beforeProjectionHash: spec.beforeProjectionHash,
        afterProjectionHash: spec.afterProjectionHash,
        stableAfterProjectionHash: "648bdd1108934d0840df9d6e235f7d24b3ad0a4b2688b40cba58e359ae1f15d0",
        beforeSequences: { questions: 3649, bookItems: 7829 },
        afterSequences: { questions: 3651, bookItems: 7833 },
        answerAudit: {
          path: spec.auditPath,
          sha256: spec.auditSha256,
          effectiveCorpusHash: spec.effectiveCorpusHash,
          effectiveSolutionCorpusHash: spec.effectiveSolutionCorpusHash,
        },
        ownership: {
          bookIds: [133, 134],
          fileIds: [214, 215, 216, 217],
          beforeQuestionIds: [3504, 3505, 3506, 3507, 3508, 3509, 3510, 3511, 3512, 3513, 3514],
          afterQuestionIds: [
            3504, 3505, 3506, 3507, 3508, 3509, 3510, 3511, 3512, 3513, 3514, 3650, 3651,
          ],
          beforeBookItemIds: [
            7538, 7539, 7540, 7541, 7542, 7543, 7544, 7545, 7546, 7547, 7548,
            7549, 7550, 7551, 7552, 7553, 7554, 7555, 7556, 7557, 7558, 7559,
          ],
          afterBookItemIds: [
            7538, 7539, 7540, 7541, 7542, 7543, 7544, 7545, 7546, 7547, 7548,
            7549, 7550, 7551, 7552, 7553, 7554, 7555, 7556, 7557, 7558, 7559,
            7830, 7831, 7832, 7833,
          ],
        },
      });
      expect(files.plan.identity.operations.questionUpdates).toHaveLength(11);
      expect(files.plan.identity.operations.itemUpdates).toHaveLength(22);
      expect(files.plan.identity.operations.questionInserts).toHaveLength(2);
      expect(files.plan.identity.operations.itemInserts).toHaveLength(4);
      expect(files.plan.identity.operations.questionInserts.map(
        (operation: { after: Record<string, unknown> }) => operation.after,
      )).toEqual([
        expect.objectContaining({
          id: 3650,
          src_page: 10,
          printed_number: "25",
          difficulty: "하",
          question: "함수 $f(x)=\\dfrac{1}{2}x+2$에 대하여 " +
            "$\\displaystyle\\sum_{k=1}^{15}f(2k)$의 값을 구하시오. [3점]",
          answer: "150",
        }),
        expect.objectContaining({
          id: 3651,
          src_page: 7,
          printed_number: "18",
          difficulty: "중",
          answer: "④",
        }),
      ]);
      expect(files.plan.identity.operations.itemInserts.map(
        (operation: { after: { id: number } }) => operation.after.id,
      )).toEqual([7830, 7831, 7832, 7833]);

      const initial = verify();
      expect(initial, JSON.stringify(initial.failures, null, 2))
        .toMatchObject({ ok: true, failureCount: 0, questions: { expected: 13, actual: 13 } });

      let db = new Database(files.dbPath);
      try {
        expect(db.prepare(
          "SELECT id, src_page, printed_number, difficulty, answer FROM questions " +
          "WHERE id IN (3650, 3651) ORDER BY id",
        ).all()).toEqual([
          { id: 3650, src_page: 10, printed_number: "25", difficulty: "하", answer: "150" },
          { id: 3651, src_page: 7, printed_number: "18", difficulty: "중", answer: "④" },
        ]);
        expect((db.prepare("SELECT id FROM book_items WHERE id BETWEEN 7830 AND 7833 ORDER BY id")
          .all() as Array<{ id: number }>).map((row) => row.id)).toEqual([7830, 7831, 7832, 7833]);
        db.prepare(
          "UPDATE questions SET correct_count = 7, wrong_count = 4, from_wrong_note = 1 WHERE id = 3650",
        ).run();
        db.prepare(
          "INSERT INTO question_attempts (question_id, attempt_id, correct) " +
          "VALUES (3650, 'verify-5525984', 1)",
        ).run();
      } finally {
        db.close();
      }

      const explicit = await execFileP(process.execPath, [
        "--import", "tsx", "scripts/import-exam-corpus.ts",
        "--manifest", "data/ebsi-exam-manifest.json",
        "--data-dir", files.dataDir,
        "--commit",
        "--migrate-existing", entryId,
        "--expect-receipt-sha256", spec.oldReceiptSha256,
      ], {
        cwd: migrationRepository,
        timeout: 60_000,
        env: { ...process.env, STUDYWORK_CODEX_BIN: "/usr/bin/false" },
      });
      expect(explicit.stdout).toContain("existing ebsi:5525984 13");
      const normal = await execFileP(process.execPath, [
        "--import", "tsx", "scripts/import-exam-corpus.ts",
        "--manifest", files.manifestPath,
        "--data-dir", files.dataDir,
        "--commit",
      ], {
        cwd: migrationRepository,
        timeout: 60_000,
        env: { ...process.env, STUDYWORK_CODEX_BIN: "/usr/bin/false" },
      });
      expect(normal.stdout).toContain("existing ebsi:5525984 13");
      expect(verify()).toMatchObject({ ok: true, failureCount: 0 });

      db = new Database(files.dbPath, { readonly: true });
      try {
        expect(db.prepare(
          "SELECT correct_count, wrong_count, from_wrong_note FROM questions WHERE id = 3650",
        ).get()).toEqual({ correct_count: 7, wrong_count: 4, from_wrong_note: 1 });
        expect((db.prepare(
          "SELECT COUNT(*) AS count FROM question_attempts WHERE attempt_id = 'verify-5525984'",
        ).get() as { count: number }).count).toBe(1);
      } finally {
        db.close();
      }

      const originalPlan = readFileSync(files.planPath);
      const tamperedPlan = structuredClone(files.plan);
      tamperedPlan.identity.operations.questionInserts[1].after.answer = "③";
      writeEvidence(files.planPath, tamperedPlan);
      expect(verify().failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "MIGRATION_INVALID" }),
      ]));
      writeFileSync(files.planPath, originalPlan);
    } finally {
      rmSync(files.root, { recursive: true, force: true });
    }
  }, 120_000);

  it("selects the exact 5578423 same-key audit during migration", async () => {
    const entryId = "ebsi:5578423";
    const spec = EXISTING_CORPUS_MIGRATION_ALLOWLIST.find((candidate) => candidate.entryId === entryId)!;
    const files = await migratedVerifierFixture(entryId);
    const verify = () => verifyExamCorpus({
      manifestPath: files.manifestPath,
      dbPath: files.dbPath,
      dataDir: files.dataDir,
    });
    try {
      expect(files.plan.identity).toMatchObject({
        beforeProjectionHash: spec.beforeProjectionHash,
        afterProjectionHash: spec.afterProjectionHash,
        stableAfterProjectionHash: "1624dda2e68cb2d901732286ac8bb0ad92740856fcde5e13ac4b374453a530c8",
        afterSequences: { questions: 3649, bookItems: 7829 },
        answerAudit: {
          path: "answer-audit/v5-00e94aae43035db62fee1ddb79997058780a54a58b9bcdbe7350ecb36beea814.json",
          sha256: "4a1bcc0ca1e5d6f479ba6f316289d1ee4de7a97fd8232d32097446eae4086a87",
          effectiveCorpusHash: spec.effectiveCorpusHash,
          effectiveSolutionCorpusHash: spec.effectiveSolutionCorpusHash,
        },
      });
      expect(files.plan.identity.operations.questionUpdates).toHaveLength(7);
      expect(files.plan.identity.operations.itemUpdates).toHaveLength(14);
      expect(files.plan.identity.operations.questionInserts).toHaveLength(0);
      expect(files.plan.identity.operations.itemInserts).toHaveLength(0);
      const report = verify();
      expect(report, JSON.stringify(report.failures, null, 2))
        .toMatchObject({ ok: true, failureCount: 0, questions: { expected: 7, actual: 7 } });

      const historicalProblemPath = join(
        files.stateDir,
        "problem-recoveries/" +
          "v2-0005-0014-128751e9a46e78da7afa65f5cff3c679d694a9704a06fa91c1194f375cfddb3d.json",
      );
      const historicalProblemBytes = readFileSync(historicalProblemPath);
      writeFileSync(historicalProblemPath, Buffer.concat([historicalProblemBytes, Buffer.from("tampered")]));
      expect(verify().failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "ANSWER_AUDIT_INVALID" }),
      ]));
      writeFileSync(historicalProblemPath, historicalProblemBytes);

      const historicalClassificationPath = join(
        files.stateDir,
        "classification-recoveries/" +
          "v2-0005-0014-5a76003ddc1f99328f3680768b909e18fbf007f9129950ca31c5d3641463708b-" +
          "7bb7cb863c8c4855.json",
      );
      const historicalClassificationBytes = readFileSync(historicalClassificationPath);
      rmSync(historicalClassificationPath);
      expect(verify().failures).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "ANSWER_AUDIT_INVALID",
          message: expect.stringContaining("missing artifact"),
        }),
      ]));
      writeFileSync(historicalClassificationPath, historicalClassificationBytes);

      const thirdRecoveryPath = join(
        files.stateDir,
        "problem-recoveries",
        `v2-0005-0014-${"f".repeat(64)}.json`,
      );
      writeEvidence(thirdRecoveryPath, { version: 2, unexpected: true });
      expect(verify().failures).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "ANSWER_AUDIT_INVALID",
          message: expect.stringContaining("orphan, conflict, or missing"),
        }),
      ]));
      rmSync(thirdRecoveryPath);

      const historicalAuditPath = join(
        files.stateDir,
        "answer-audit/v5-841e6f0d22d791454ff7d37e9e702d22c981136e1408f3ef4d3af8f15213f56c.json",
      );
      const historicalAuditBytes = readFileSync(historicalAuditPath);
      writeFileSync(historicalAuditPath, Buffer.concat([historicalAuditBytes, Buffer.from("tampered")]));
      expect(verify().failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "ANSWER_AUDIT_INVALID" }),
      ]));
      writeFileSync(historicalAuditPath, historicalAuditBytes);

      const originalPlan = readFileSync(files.planPath);
      const tamperedPlan = structuredClone(files.plan);
      tamperedPlan.identity.answerAudit.path =
        "answer-audit/v5-841e6f0d22d791454ff7d37e9e702d22c981136e1408f3ef4d3af8f15213f56c.json";
      tamperedPlan.identity.answerAudit.sha256 =
        "36ca283c14f6db268c370ce0158605c2a997aab42fa2f03dccb910ddf8d5c358";
      writeEvidence(files.planPath, tamperedPlan);
      expect(verify().failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "MIGRATION_INVALID" }),
      ]));
      writeFileSync(files.planPath, originalPlan);
    } finally {
      rmSync(files.root, { recursive: true, force: true });
    }
  }, 120_000);

  it("verifies the completed 5577055 Q5 migration and stable replay", async () => {
    const entryId = "ebsi:5577055";
    const spec = EXISTING_CORPUS_MIGRATION_ALLOWLIST.find((candidate) => candidate.entryId === entryId)!;
    const files = await migratedVerifierFixture(entryId);
    const verify = () => verifyExamCorpus({
      manifestPath: files.manifestPath,
      dbPath: files.dbPath,
      dataDir: files.dataDir,
    });
    try {
      expect(files.plan.identity).toMatchObject({
        receiptCore: { sha256: spec.receiptCoreSha256 },
        beforeProjectionHash: spec.beforeProjectionHash,
        afterProjectionHash: spec.afterProjectionHash,
        stableAfterProjectionHash: "e0eed6170c486eb248909bb422905caf569f9246f8b9fa75c5df6e5d796f4947",
        afterSequences: { questions: 3649, bookItems: 7829 },
        answerAudit: {
          path: spec.auditPath,
          sha256: spec.auditSha256,
          effectiveCorpusHash: spec.effectiveCorpusHash,
          effectiveSolutionCorpusHash: spec.effectiveSolutionCorpusHash,
        },
        ownership: {
          bookIds: [131],
          fileIds: [210, 211],
          beforeQuestionIds: [3491, 3492, 3493, 3494, 3495],
          afterQuestionIds: [3491, 3492, 3493, 3494, 3495, 3649],
          beforeBookItemIds: [7512, 7513, 7514, 7515, 7516, 7517, 7518, 7519, 7520, 7521],
          afterBookItemIds: [7512, 7513, 7514, 7515, 7516, 7517, 7518, 7519, 7520, 7521, 7828, 7829],
        },
      });
      expect(files.plan.identity.operations.questionUpdates).toHaveLength(5);
      expect(files.plan.identity.operations.itemUpdates).toHaveLength(10);
      expect(files.plan.identity.operations.questionInserts).toHaveLength(1);
      expect(files.plan.identity.operations.itemInserts).toHaveLength(2);
      expect(files.plan.identity.operations.questionInserts[0].after).toMatchObject({
        id: 3649,
        src_page: 2,
        printed_number: "5",
        difficulty: "중",
        question: "좌표평면에서 곡선 $y=a^x$을 직선 $y=x$에 대하여 대칭이동한 곡선이 점 $(2,3)$을 지날 때, 양수 $a$의 값은? [3점]",
        answer: "④ $\\sqrt[3]{2}$",
      });
      expect(files.plan.identity.operations.itemInserts.map(
        (item: { after: { id: number } }) => item.after.id,
      )).toEqual([7828, 7829]);

      const attestationPath = join(
        files.stateDir,
        "answer-attestation/v5-b452290f13f1ebd058630975a6dd21594c414c5af9d92412fca9a77720874140.json",
      );
      expect(hash(readFileSync(attestationPath)))
        .toBe("8225980875926868843160fc1695a16dd26ce6361443abfa459ff110c8d46b96");
      expect(JSON.parse(readFileSync(attestationPath, "utf8")).answerAudit).toMatchObject({
        path: spec.auditPath,
        sha256: spec.auditSha256,
        effectiveCorpusHash: spec.effectiveCorpusHash,
        effectiveSolutionCorpusHash: spec.effectiveSolutionCorpusHash,
      });
      const initial = verify();
      expect(initial, JSON.stringify(initial.failures, null, 2))
        .toMatchObject({ ok: true, failureCount: 0, questions: { expected: 6, actual: 6 } });

      let db = new Database(files.dbPath);
      try {
        expect(db.prepare(
          "SELECT id, book_id, src_page, printed_number, difficulty, question, answer "
          + "FROM questions WHERE id = 3649",
        ).get()).toEqual({
          id: 3649,
          book_id: 131,
          src_page: 2,
          printed_number: "5",
          difficulty: "중",
          question: "좌표평면에서 곡선 $y=a^x$을 직선 $y=x$에 대하여 대칭이동한 곡선이 "
            + "점 $(2,3)$을 지날 때, 양수 $a$의 값은? [3점]",
          answer: "④ $\\sqrt[3]{2}$",
        });
        expect((db.prepare("SELECT id FROM book_items WHERE id IN (7828, 7829) ORDER BY id")
          .all() as Array<{ id: number }>).map((row) => row.id)).toEqual([7828, 7829]);
        expect((db.prepare(
          "SELECT COUNT(*) AS count FROM questions WHERE book_id = 131 AND src_page = 4 AND printed_number = '11'",
        ).get() as { count: number }).count).toBe(0);
        db.prepare(
          "UPDATE questions SET correct_count = 6, wrong_count = 2, from_wrong_note = 1 WHERE id = 3649",
        ).run();
        db.prepare(
          "INSERT INTO question_attempts (question_id, attempt_id, correct) "
          + "VALUES (3649, 'verify-5577055', 1)",
        ).run();
      } finally {
        db.close();
      }

      const explicit = await execFileP(process.execPath, [
        "--import", "tsx", "scripts/import-exam-corpus.ts",
        "--manifest", "data/ebsi-exam-manifest.json",
        "--data-dir", files.dataDir,
        "--commit",
        "--migrate-existing", entryId,
        "--expect-receipt-sha256", spec.oldReceiptSha256,
      ], {
        cwd: migrationRepository,
        timeout: 60_000,
        env: { ...process.env, STUDYWORK_CODEX_BIN: "/usr/bin/false" },
      });
      expect(explicit.stdout).toContain("existing ebsi:5577055 6");
      const normal = await execFileP(process.execPath, [
        "--import", "tsx", "scripts/import-exam-corpus.ts",
        "--manifest", files.manifestPath,
        "--data-dir", files.dataDir,
        "--commit",
      ], {
        cwd: migrationRepository,
        timeout: 60_000,
        env: { ...process.env, STUDYWORK_CODEX_BIN: "/usr/bin/false" },
      });
      expect(normal.stdout).toContain("existing ebsi:5577055 6");
      expect(verify()).toMatchObject({ ok: true, failureCount: 0 });

      db = new Database(files.dbPath, { readonly: true });
      try {
        expect(db.prepare(
          "SELECT correct_count, wrong_count, from_wrong_note FROM questions WHERE id = 3649",
        ).get()).toEqual({ correct_count: 6, wrong_count: 2, from_wrong_note: 1 });
        expect((db.prepare(
          "SELECT COUNT(*) AS count FROM question_attempts WHERE attempt_id = 'verify-5577055'",
        ).get() as { count: number }).count).toBe(1);
      } finally {
        db.close();
      }

      const originalPlan = readFileSync(files.planPath);
      const tamperedPlan = structuredClone(files.plan);
      tamperedPlan.identity.operations.questionInserts[0].after.difficulty = "하";
      writeEvidence(files.planPath, tamperedPlan);
      expect(verify().failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "MIGRATION_INVALID" }),
      ]));
      writeFileSync(files.planPath, originalPlan);
    } finally {
      rmSync(files.root, { recursive: true, force: true });
    }
  }, 120_000);

  it("verifies one completed same-key migration from the expanded allowlist", async () => {
    const files = await migratedVerifierFixture("ebsi:5734413");
    try {
      expect(files.plan.identity.operations.questionUpdates).toHaveLength(12);
      expect(files.plan.identity.operations.itemUpdates).toHaveLength(24);
      expect(files.plan.identity.operations.questionInserts).toHaveLength(0);
      expect(files.plan.identity.operations.itemInserts).toHaveLength(0);
      expect(files.plan.identity).toMatchObject({
        beforeProjectionHash: "8f5e2071cc49d696ec04506774a702fcaf86c3b29bd7053a01c8c4a6a398c2aa",
        afterProjectionHash: "cfc32af3a65c21749b53dc1ca1e8ac85233a9387bb5f5b607269e655ae39d425",
        stableAfterProjectionHash: "26dc5162061716a98b85a3d22468a0c92c3d897d95eaa11b39c26cc2878acb1e",
      });
      const report = verifyExamCorpus({
        manifestPath: files.manifestPath,
        dbPath: files.dbPath,
        dataDir: files.dataDir,
      });
      expect(report, JSON.stringify(report.failures, null, 2))
        .toMatchObject({ ok: true, failureCount: 0, questions: { expected: 12, actual: 12 } });
    } finally {
      rmSync(files.root, { recursive: true, force: true });
    }
  }, 120_000);

  it("verifies the completed 5525982 migration authority graph and exact selected-choice revisions", async () => {
    const entryId = "ebsi:5525982";
    const spec = EXISTING_CORPUS_MIGRATION_ALLOWLIST.find((candidate) => candidate.entryId === entryId)!;
    const answerChoiceRevisions = spec.answerChoiceRevisions!;
    const files = await migratedVerifierFixture(entryId);
    const verify = () => verifyExamCorpus({
      manifestPath: files.manifestPath,
      dbPath: files.dbPath,
      dataDir: files.dataDir,
    });
    const questionIds = Array.from({ length: 30 }, (_, index) => 3003 + index);
    const itemIds = Array.from({ length: 60 }, (_, index) => 6536 + index);
    try {
      expect(files.plan.identity).toMatchObject({
        receiptCore: { sha256: spec.receiptCoreSha256 },
        beforeProjectionHash: spec.beforeProjectionHash,
        afterProjectionHash: spec.afterProjectionHash,
        stableAfterProjectionHash: "151811cfa19fadbcc99381123df01916c0c6008653b0173efef189f7e32d0317",
        beforeSequences: { questions: 3651, bookItems: 7833 },
        afterSequences: { questions: 3651, bookItems: 7833 },
        answerAudit: {
          path: spec.auditPath,
          sha256: spec.auditSha256,
          effectiveCorpusHash: spec.effectiveCorpusHash,
          effectiveSolutionCorpusHash: spec.effectiveSolutionCorpusHash,
        },
        ownership: {
          bookIds: [80, 81],
          fileIds: [108, 109, 110, 111],
          beforeQuestionIds: questionIds,
          afterQuestionIds: questionIds,
          beforeBookItemIds: itemIds,
          afterBookItemIds: itemIds,
        },
      });
      expect(files.plan.identity.beforeProjection.guards).toEqual({
        attempts: 0,
        materials: 0,
        bookExtractionChunks: 0,
        materialExtractionChunks: 0,
      });
      expect(files.plan.identity.operations.questionUpdates).toHaveLength(30);
      expect(files.plan.identity.operations.itemUpdates).toHaveLength(60);
      expect(files.plan.identity.operations.questionInserts).toHaveLength(0);
      expect(files.plan.identity.operations.itemInserts).toHaveLength(0);

      for (const revision of answerChoiceRevisions) {
        const [page, number] = revision.key.split(":").map(Number);
        const operation = files.plan.identity.operations.questionUpdates.find(
          ({ before }: { before: Record<string, unknown> }) =>
            before.src_page === page && Number(before.printed_number) === number,
        );
        expect(operation, revision.key).toBeDefined();
        const beforeChoices = JSON.parse(operation.before.choices) as string[];
        const afterChoices = JSON.parse(operation.after.choices) as string[];
        expect(hash(beforeChoices[revision.choiceIndex - 1]), `${revision.key} OLD selected choice`)
          .toBe(revision.beforeSelectedChoiceHash);
        expect(hash(afterChoices[revision.choiceIndex - 1]), `${revision.key} NEW selected choice`)
          .toBe(revision.afterSelectedChoiceHash);
      }
      expect(answerChoiceRevisions.map(({ key }) => key)).not.toContain("16:44");

      const artifactNames = (directory: string, pattern: RegExp) =>
        readdirSync(join(files.stateDir, directory)).filter((name) => pattern.test(name));
      expect(artifactNames("receipt-history", /^v1-[a-f0-9]{64}\.json$/u)).toHaveLength(1);
      expect(artifactNames("migration-plans", /^v1-[a-f0-9]{64}\.json$/u)).toHaveLength(1);
      expect(artifactNames("migration-commits", /^v1-[a-f0-9]{64}\.json$/u)).toHaveLength(1);
      expect(artifactNames("answer-attestation", /^v5-[a-f0-9]{64}\.json$/u)).toHaveLength(1);
      expect(hash(readFileSync(join(files.stateDir, spec.auditPath)))).toBe(spec.auditSha256);
      expect(existsSync(join(files.dataDir, files.plan.backup.path))).toBe(true);

      const initial = verify();
      expect(initial, JSON.stringify(initial.failures, null, 2))
        .toMatchObject({ ok: true, failureCount: 0, questions: { expected: 30, actual: 30 } });

      const db = new Database(files.dbPath, { readonly: true, fileMustExist: true });
      try {
        expect((db.prepare("SELECT id FROM questions WHERE book_id IN (80, 81) ORDER BY id")
          .all() as Array<{ id: number }>).map(({ id }) => id)).toEqual(questionIds);
        expect((db.prepare("SELECT id FROM book_items WHERE book_id IN (80, 81) ORDER BY id")
          .all() as Array<{ id: number }>).map(({ id }) => id)).toEqual(itemIds);
        expect(db.prepare("SELECT name, seq FROM sqlite_sequence WHERE name IN ('questions', 'book_items') ORDER BY name")
          .all()).toEqual([
          { name: "book_items", seq: 7833 },
          { name: "questions", seq: 3651 },
        ]);
      } finally {
        db.close();
      }

      const planBytes = readFileSync(files.planPath);
      const tamperedPlan = structuredClone(files.plan);
      const selectedChoiceUpdate = tamperedPlan.identity.operations.questionUpdates.find(
        ({ before }: { before: Record<string, unknown> }) =>
          before.src_page === 7 && Number(before.printed_number) === 17,
      );
      const tamperedChoices = JSON.parse(selectedChoiceUpdate.after.choices) as string[];
      tamperedChoices[3] = `${tamperedChoices[3]} tampered`;
      selectedChoiceUpdate.after.choices = JSON.stringify(tamperedChoices);
      writeEvidence(files.planPath, tamperedPlan);
      expect(verify().failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "MIGRATION_INVALID" }),
      ]));
      writeFileSync(files.planPath, planBytes);

      const orphanCommit = join(files.stateDir, "migration-commits", `v1-${"d".repeat(64)}.json`);
      writeEvidence(orphanCommit, { version: 1, orphan: true });
      expect(verify().failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "MIGRATION_INVALID" }),
      ]));
      rmSync(orphanCommit);

      const mutableDb = new Database(files.dbPath);
      try {
        mutableDb.prepare("UPDATE questions SET question = 'tampered current migration row' WHERE id = 3003").run();
      } finally {
        mutableDb.close();
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
  }, 180_000);

  it("verifies the completed 5656592 hydrated-recovery migration and stable replay", async () => {
    const entryId = "ebsi:5656592";
    const spec = EXISTING_CORPUS_MIGRATION_ALLOWLIST.find((candidate) => candidate.entryId === entryId)!;
    const files = await migratedVerifierFixture(entryId);
    const verify = () => verifyExamCorpus({
      manifestPath: files.manifestPath,
      dbPath: files.dbPath,
      dataDir: files.dataDir,
    });
    try {
      expect(files.plan.identity).toMatchObject({
        beforeProjectionHash: spec.beforeProjectionHash,
        afterProjectionHash: spec.afterProjectionHash,
        stableAfterProjectionHash: "c252907104678e4473da17a3fc3f2810745f36645f1400af5ff203e72901bb21",
        answerAudit: {
          path: spec.auditPath,
          sha256: spec.auditSha256,
          effectiveCorpusHash: spec.effectiveCorpusHash,
          effectiveSolutionCorpusHash: spec.effectiveSolutionCorpusHash,
        },
        ownership: {
          bookIds: [130],
          fileIds: [208, 209],
          beforeQuestionIds: [3487, 3488, 3489, 3490],
          afterQuestionIds: [3487, 3488, 3489, 3490],
          beforeBookItemIds: [7504, 7505, 7506, 7507, 7508, 7509, 7510, 7511],
          afterBookItemIds: [7504, 7505, 7506, 7507, 7508, 7509, 7510, 7511],
        },
      });
      expect(files.plan.identity.operations.questionUpdates).toHaveLength(4);
      expect(files.plan.identity.operations.itemUpdates).toHaveLength(8);
      expect(files.plan.identity.operations.questionInserts).toHaveLength(0);
      expect(files.plan.identity.operations.itemInserts).toHaveLength(0);

      const initial = verify();
      expect(initial, JSON.stringify(initial.failures, null, 2))
        .toMatchObject({ ok: true, failureCount: 0, questions: { expected: 4, actual: 4 } });

      let db = new Database(files.dbPath);
      try {
        expect(db.prepare(
          "SELECT id, book_id, src_page, printed_number, difficulty, question, answer "
          + "FROM questions WHERE id = 3488",
        ).get()).toEqual({
          id: 3488,
          book_id: 130,
          src_page: 4,
          printed_number: "11",
          difficulty: "중",
          question: "$0\\le x\\le \\pi$일 때, 방정식 "
            + "$(\\sin x+\\cos x)^2=\\sqrt{3}\\sin x+1$의 모든 실근의 합은? [3점]",
          answer: "① $\\frac{7}{6}\\pi$",
        });
        expect((db.prepare(
          "SELECT COUNT(*) AS count FROM questions WHERE book_id = 130 AND printed_number = '15'",
        ).get() as { count: number }).count).toBe(0);
        db.prepare(
          "UPDATE questions SET correct_count = 5, wrong_count = 2, from_wrong_note = 1 WHERE id = 3488",
        ).run();
        db.prepare(
          "INSERT INTO question_attempts (question_id, attempt_id, correct) "
          + "VALUES (3488, 'verify-5656592', 1)",
        ).run();
      } finally {
        db.close();
      }

      const explicit = await execFileP(process.execPath, [
        "--import", "tsx", "scripts/import-exam-corpus.ts",
        "--manifest", "data/ebsi-exam-manifest.json",
        "--data-dir", files.dataDir,
        "--commit",
        "--migrate-existing", entryId,
        "--expect-receipt-sha256", spec.oldReceiptSha256,
      ], {
        cwd: migrationRepository,
        timeout: 60_000,
        env: { ...process.env, STUDYWORK_CODEX_BIN: "/usr/bin/false" },
      });
      expect(explicit.stdout).toContain("existing ebsi:5656592 4");
      const normal = await execFileP(process.execPath, [
        "--import", "tsx", "scripts/import-exam-corpus.ts",
        "--manifest", files.manifestPath,
        "--data-dir", files.dataDir,
        "--commit",
      ], {
        cwd: migrationRepository,
        timeout: 60_000,
        env: { ...process.env, STUDYWORK_CODEX_BIN: "/usr/bin/false" },
      });
      expect(normal.stdout).toContain("existing ebsi:5656592 4");
      expect(verify()).toMatchObject({ ok: true, failureCount: 0 });

      db = new Database(files.dbPath, { readonly: true });
      try {
        expect(db.prepare(
          "SELECT correct_count, wrong_count, from_wrong_note FROM questions WHERE id = 3488",
        ).get()).toEqual({ correct_count: 5, wrong_count: 2, from_wrong_note: 1 });
        expect((db.prepare(
          "SELECT COUNT(*) AS count FROM question_attempts WHERE attempt_id = 'verify-5656592'",
        ).get() as { count: number }).count).toBe(1);
      } finally {
        db.close();
      }

      const originalPlan = readFileSync(files.planPath);
      const tamperedPlan = structuredClone(files.plan);
      tamperedPlan.identity.answerAudit.effectiveCorpusHash = "0".repeat(64);
      writeEvidence(files.planPath, tamperedPlan);
      expect(verify().failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "MIGRATION_INVALID" }),
      ]));
      writeFileSync(files.planPath, originalPlan);
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
    expect(PROBLEM_MANUAL_CLASSIFICATION_POLICY_REVISION_ALLOWLIST).toHaveLength(1);
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_CLASSIFICATION_POLICY_REVISION_ALLOWLIST[0]))
      .toBe("ab0b239fa1e63a0b41a9e510259b9b3047246534ee980b9bbc95ff1f253c8a89");
    expect(manualClassificationPolicyRevisionAllowlistFingerprint())
      .toBe(canonicalEvidenceHash(PROBLEM_MANUAL_CLASSIFICATION_POLICY_REVISION_ALLOWLIST));
    const manualFixture = () => {
      const files = fixture();
      prepareQ30ManualFixture(files);
      const artifacts = upgradeEntryToV3(files, "korean", {
        manualAdjudication: true,
        manualAdjudicationKey: Q30_MANUAL_SPEC.key,
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
    !existsSync(Q30_FAILED_PROBLEM_PATH)
      || !existsSync(Q30_FAILED_CLASSIFICATION_PATH)
      || !existsSync(Q30_PARENT_MANUAL_CLASSIFICATION_PATH)
      || !existsSync(join(Q30_MANUAL_STATE, "problem.pdf")),
  )("reconstructs the exact nested Q30 manual revision and rejects missing, tampered, or repeated children", () => {
    expect(manualRevisionAllowlistFingerprint())
      .toBe(canonicalEvidenceHash(PROBLEM_MANUAL_REVISION_ALLOWLIST));
    const manualRevisionFixture = (manualRevisionInvalidDecision = false) => {
      const files = fixture();
      prepareQ30ManualFixture(files, true);
      const artifacts = upgradeEntryToV3(files, "korean", {
        manualAdjudication: true,
        manualAdjudicationKey: Q30_MANUAL_SPEC.key,
        manualRevision: true,
        manualRevisionInvalidDecision,
        terminalScope: "authorized-reject",
        answerV5: true,
      });
      return { files, artifacts };
    };

    const valid = manualRevisionFixture();
    const modifiedBefore = statSync(valid.files.dbPath).mtimeMs;
    const preparedAudit = JSON.parse(readFileSync(valid.artifacts.auditArtifact, "utf8"));
    expect(preparedAudit.solutionFidelityCheckpoints.map((pointer: { path: string }) => ({
      path: pointer.path,
      exists: existsSync(join(valid.files.stateDirs.korean, pointer.path)),
    }))).toEqual(preparedAudit.solutionFidelityCheckpoints.map((pointer: { path: string }) => ({
      path: pointer.path,
      exists: true,
    })));
    const report = verifyExamCorpus(valid.files);
    expect(report, JSON.stringify(report.failures, null, 2)).toMatchObject({ ok: true });
    expect(statSync(valid.files.dbPath).mtimeMs).toBe(modifiedBefore);
    const audit = preparedAudit;
    const manual = audit.repairs.find((value: Record<string, any>) =>
      value.revision?.recovery?.manualAdjudication?.revision)
      .revision.recovery.manualAdjudication;
    expect(manual.revision).toMatchObject({
      allowlistId: Q30_MANUAL_REVISION_SPEC.allowlistId,
      parentManualEvidenceHash: canonicalEvidenceHash((({ revision: _revision, ...parent }) => parent)(manual)),
      failedQuestionHash: Q30_MANUAL_REVISION_SPEC.failedQuestionHash,
      failedClassificationHash: Q30_MANUAL_REVISION_SPEC.failedClassificationHash,
      correctionSpecHash: canonicalEvidenceHash({
        allowlistId: Q30_MANUAL_REVISION_SPEC.allowlistId,
        parentAllowlistId: Q30_MANUAL_REVISION_SPEC.parentAllowlistId,
        replacement: Q30_MANUAL_REVISION_SPEC.replacement,
        requiredTokens: Q30_MANUAL_REVISION_SPEC.requiredTokens,
        expectedDecision: Q30_MANUAL_REVISION_SPEC.expectedDecision,
        expectedCanonicalSubject: Q30_MANUAL_REVISION_SPEC.expectedCanonicalSubject,
      }),
    });
    const parentQuestion = JSON.parse(
      readFileSync(valid.artifacts.problemManualAdjudicationArtifact!, "utf8"),
    ).item.question;
    const revisedQuestion = JSON.parse(
      readFileSync(valid.artifacts.problemManualRevisionArtifact!, "utf8"),
    ).item.question;
    expect(parentQuestion).toContain("‘$p$’와 ‘$q$’를 ‘만약 …이면 …이다.’");
    expect(revisedQuestion).toContain("‘$p$’와 ‘$q$’는 ‘만약 …이면 …이다.’");
    expect(revisedQuestion).not.toContain("‘$p$’와 ‘$q$’를 ‘만약 …이면 …이다.’");
    const parentClassification = JSON.parse(readFileSync(
      valid.artifacts.classificationManualAdjudicationArtifact!,
      "utf8",
    )).items[0];
    const revisedClassification = JSON.parse(readFileSync(
      valid.artifacts.classificationManualRevisionArtifact!,
      "utf8",
    )).items[0];
    expect(parentClassification).toMatchObject({ transcription_status: "mismatch" });
    expect(revisedClassification).toMatchObject({
      decision: "accept",
      canonical_subject: "korean_reading",
      transcription_status: "exact",
    });
    const terminal = JSON.parse(readFileSync(valid.artifacts.terminalArtifact, "utf8"));
    expect(terminal.inputs).toHaveLength(45);
    expect(terminal.items).toHaveLength(45);
    expect(terminal.items.find((item: { key: string }) => item.key === Q30_MANUAL_REVISION_SPEC.key))
      .toMatchObject({ status: "exact", scopeDecision: "accept", scopeConfidence: 0.99 });
    expect(audit.solutionFidelityItems).toEqual([expect.objectContaining({
      key: Q30_MANUAL_REVISION_SPEC.key,
      answerStatus: "exact",
      explanationStatus: "exact",
    })]);
    expect(audit.semanticCheckpoint.path).toBe(
      `semantic-choice-checks/v5-${audit.effectiveCorpusHash}-` +
        `${audit.effectiveSolutionCorpusHash}-${audit.semanticCheckpoint.inputHash}.json`,
    );
    const db = new Database(valid.files.dbPath, { readonly: true });
    const stored = db.prepare(
      "SELECT question, answer FROM questions WHERE printed_number = '30'",
    ).get() as { question: string; answer: string };
    db.close();
    expect(stored.answer).toBe("③");
    expect(stored.question).toContain("‘$p$’와 ‘$q$’는 ‘만약 …이면 …이다.’");

    const invalidDecision = manualRevisionFixture(true);
    const invalidDecisionReport = verifyExamCorpus(invalidDecision.files);
    expect(invalidDecisionReport.failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("manual revision")),
    JSON.stringify(invalidDecisionReport.failures, null, 2)).toBe(true);

    const tampered = manualRevisionFixture();
    writeFileSync(tampered.artifacts.problemManualRevisionArtifact!, "{}");
    expect(verifyExamCorpus(tampered.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const missing = manualRevisionFixture();
    rmSync(missing.artifacts.classificationManualRevisionArtifact!);
    expect(verifyExamCorpus(missing.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("missing"))).toBe(true);

    const parentTamper = manualRevisionFixture();
    rewriteCurrentV3Authority(parentTamper.files, (currentAudit) => {
      currentAudit.repairs.find((value: Record<string, any>) =>
        value.revision?.recovery?.manualAdjudication?.revision)
        .revision.recovery.manualAdjudication.revision.parentManualEvidenceHash = "0".repeat(64);
    }, "korean");
    expect(verifyExamCorpus(parentTamper.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("manual revision"))).toBe(true);

    const terminalTamper = manualRevisionFixture();
    rewriteCurrentV3Authority(terminalTamper.files, (currentAudit) => {
      const pointer = currentAudit.problemTerminalFidelityCheckpoints[0];
      const path = join(terminalTamper.files.stateDirs.korean, pointer.path);
      const checkpoint = JSON.parse(readFileSync(path, "utf8"));
      const item = checkpoint.items.find(
        (value: { key: string }) => value.key === Q30_MANUAL_REVISION_SPEC.key,
      );
      item.scopeDecision = "reject";
      item.scopeEvidence = "self-consistent stale terminal scope rejects the allowlisted final acceptance";
      pointer.sha256 = writeEvidence(path, checkpoint);
      Object.assign(currentAudit.problemTerminalFidelityItems.find(
        (value: { key: string }) => value.key === Q30_MANUAL_REVISION_SPEC.key,
      ), item);
    }, "korean");
    expect(verifyExamCorpus(terminalTamper.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("terminal"))).toBe(true);

    const missingSolutionFidelity = manualRevisionFixture();
    const missingSolutionAudit = JSON.parse(readFileSync(
      missingSolutionFidelity.artifacts.auditArtifact,
      "utf8",
    ));
    rmSync(join(
      missingSolutionFidelity.files.stateDirs.korean,
      missingSolutionAudit.solutionFidelityCheckpoints[0].path,
    ));
    expect(verifyExamCorpus(missingSolutionFidelity.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const repeated = manualRevisionFixture();
    rewriteCurrentV3Authority(repeated.files, (currentAudit) => {
      const nested = currentAudit.repairs.find((value: Record<string, any>) =>
        value.revision?.recovery?.manualAdjudication?.revision)
        .revision.recovery.manualAdjudication.revision;
      nested.revision = {};
    }, "korean");
    expect(verifyExamCorpus(repeated.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const orphan = manualRevisionFixture();
    writeJson(join(
      orphan.files.stateDirs.korean,
      "problem-manual-revisions",
      `v1-0012-0030-${"1".repeat(64)}.json`,
    ), {});
    expect(verifyExamCorpus(orphan.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("not declared"))).toBe(true);
  });

  it.skipIf(
    !existsSync(MANUAL_FAILED_ARTIFACTS.get(Q18_MANUAL_SPEC.allowlistId)!.problem)
      || !existsSync(MANUAL_FAILED_ARTIFACTS.get(Q18_MANUAL_SPEC.allowlistId)!.classification)
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
    !existsSync(MANUAL_FAILED_ARTIFACTS.get(Q18_MANUAL_SPEC.allowlistId)!.problem)
      || !existsSync(MANUAL_FAILED_ARTIFACTS.get(Q18_MANUAL_SPEC.allowlistId)!.classification)
      || !existsSync(Q18_PARENT_MANUAL_CLASSIFICATION_PATH)
      || !existsSync(join(Q18_MANUAL_STATE, "problem.pdf")),
  )("reconstructs the exact nested Q18 manual revision as a terminal rejection", () => {
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_REVISION_ALLOWLIST.slice(0, 2)))
      .toBe("9e728f6796dbb0ed32652ea84b97e6870fba0ff88a7354a0b406749c90a706c3");
    expect(manualRevisionAllowlistFingerprint())
      .toBe(canonicalEvidenceHash(PROBLEM_MANUAL_REVISION_ALLOWLIST));
    const manualRevisionFixture = (manualRevisionInvalidDecision = false) => {
      const files = fixture();
      prepareManualFixture(files, "math", Q18_MANUAL_SPEC, Q18_MANUAL_STATE);
      const artifacts = upgradeEntryToV3(files, "math", {
        manualAdjudication: true,
        manualRevision: true,
        manualRevisionInvalidDecision,
        terminalScope: "authorized-reject",
        answerV5: true,
      });
      return { files, artifacts };
    };

    const valid = manualRevisionFixture();
    const modifiedBefore = statSync(valid.files.dbPath).mtimeMs;
    const report = verifyExamCorpus(valid.files);
    expect(report, JSON.stringify(report.failures, null, 2)).toMatchObject({ ok: true });
    expect(statSync(valid.files.dbPath).mtimeMs).toBe(modifiedBefore);
    const audit = JSON.parse(readFileSync(valid.artifacts.auditArtifact, "utf8"));
    const manual = audit.repairs.find((value: Record<string, any>) =>
      value.revision?.recovery?.manualAdjudication?.revision)
      .revision.recovery.manualAdjudication;
    expect(manual.revision).toMatchObject({
      allowlistId: Q18_MANUAL_REVISION_SPEC.allowlistId,
      failedQuestionHash: Q18_MANUAL_REVISION_SPEC.failedQuestionHash,
      failedClassificationHash: Q18_MANUAL_REVISION_SPEC.failedClassificationHash,
      correctionSpecHash: "5ff886eb7e8fe190409bb81f4b9cc4e2235db0735b6fd73748d32a35acbd26e3",
    });
    const parentQuestion = JSON.parse(readFileSync(
      valid.artifacts.problemManualAdjudicationArtifact!,
      "utf8",
    )).item.question;
    const revisedQuestion = JSON.parse(readFileSync(
      valid.artifacts.problemManualRevisionArtifact!,
      "utf8",
    )).item.question;
    expect(parentQuestion).toContain(
      "세 점 $L_1$, $M_1$, $N_1$이 각각 $\\overline{A_1B_1}$, $\\overline{B_1C_1}$, " +
        "$\\overline{C_1A_1}$의 중점이고,",
    );
    expect(revisedQuestion).toContain(
      "세 선분 $A_1B_1$, $B_1C_1$, $C_1A_1$의 중점을 각각 $L_1$, $M_1$, $N_1$이라 하고,",
    );
    expect(revisedQuestion).not.toContain("세 점 $L_1$, $M_1$, $N_1$이 각각");
    const parentClassification = JSON.parse(readFileSync(
      valid.artifacts.classificationManualAdjudicationArtifact!,
      "utf8",
    )).items[0];
    const revisedClassification = JSON.parse(readFileSync(
      valid.artifacts.classificationManualRevisionArtifact!,
      "utf8",
    )).items[0];
    expect(parentClassification).toMatchObject({ decision: "reject", transcription_status: "mismatch" });
    expect(revisedClassification).toMatchObject({
      decision: "reject",
      canonical_subject: null,
      curriculum_course: null,
      domain: null,
      achievement_codes: [],
      transcription_status: "exact",
    });
    const terminal = JSON.parse(readFileSync(valid.artifacts.terminalArtifact, "utf8"));
    expect(terminal.inputs).toHaveLength(30);
    expect(terminal.items).toHaveLength(30);
    expect(terminal.items.find((item: { key: string }) => item.key === Q18_MANUAL_REVISION_SPEC.key))
      .toMatchObject({ status: "exact", scopeDecision: "reject", scopeConfidence: 0.99 });
    expect(audit.acceptedSolutionKeys).not.toContain(Q18_MANUAL_REVISION_SPEC.key);
    const db = new Database(valid.files.dbPath, { readonly: true });
    const storedCount = db.prepare(
      "SELECT COUNT(*) AS count FROM questions WHERE printed_number = '18'",
    ).get() as { count: number };
    db.close();
    expect(storedCount.count).toBe(0);

    const invalidDecision = manualRevisionFixture(true);
    expect(verifyExamCorpus(invalidDecision.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("manual revision"))).toBe(true);

    const parentTamper = manualRevisionFixture();
    rewriteCurrentV3Authority(parentTamper.files, (currentAudit) => {
      currentAudit.repairs.find((value: Record<string, any>) =>
        value.revision?.recovery?.manualAdjudication?.revision)
        .revision.recovery.manualAdjudication.revision.parentManualEvidenceHash = "0".repeat(64);
    }, "math");
    expect(verifyExamCorpus(parentTamper.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("manual revision"))).toBe(true);

    const childTamper = manualRevisionFixture();
    writeFileSync(childTamper.artifacts.problemManualRevisionArtifact!, "{}");
    expect(verifyExamCorpus(childTamper.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const missing = manualRevisionFixture();
    rmSync(missing.artifacts.classificationManualRevisionArtifact!);
    expect(verifyExamCorpus(missing.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("missing"))).toBe(true);

    const repeated = manualRevisionFixture();
    rewriteCurrentV3Authority(repeated.files, (currentAudit) => {
      currentAudit.repairs.find((value: Record<string, any>) =>
        value.revision?.recovery?.manualAdjudication?.revision)
        .revision.recovery.manualAdjudication.revision.revision = {};
    }, "math");
    expect(verifyExamCorpus(repeated.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const staleTerminal = manualRevisionFixture();
    rewriteCurrentV3Authority(staleTerminal.files, (currentAudit) => {
      const pointer = currentAudit.problemTerminalFidelityCheckpoints[0];
      const path = join(staleTerminal.files.stateDirs.math, pointer.path);
      const checkpoint = JSON.parse(readFileSync(path, "utf8"));
      const item = checkpoint.items.find(
        (value: { key: string }) => value.key === Q18_MANUAL_REVISION_SPEC.key,
      );
      item.scopeDecision = "accept";
      item.scopeEvidence = "self-consistent stale terminal scope accepts the allowlisted final rejection";
      pointer.sha256 = writeEvidence(path, checkpoint);
      Object.assign(currentAudit.problemTerminalFidelityItems.find(
        (value: { key: string }) => value.key === Q18_MANUAL_REVISION_SPEC.key,
      ), item);
    }, "math");
    expect(verifyExamCorpus(staleTerminal.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("terminal"))).toBe(true);

    const orphan = manualRevisionFixture();
    writeJson(join(
      orphan.files.stateDirs.math,
      "problem-manual-revisions",
      `v1-0007-0018-${"1".repeat(64)}.json`,
    ), {});
    expect(verifyExamCorpus(orphan.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("not declared"))).toBe(true);
  });

  it.skipIf(
    !existsSync(MANUAL_FAILED_ARTIFACTS.get(Q9_MANUAL_SPEC.allowlistId)!.problem)
      || !existsSync(MANUAL_FAILED_ARTIFACTS.get(Q9_MANUAL_SPEC.allowlistId)!.classification)
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

  it.skipIf(
    !existsSync(MANUAL_FAILED_ARTIFACTS.get(Q9_WRITING_MANUAL_SPEC.allowlistId)!.problem)
      || !existsSync(MANUAL_FAILED_ARTIFACTS.get(Q9_WRITING_MANUAL_SPEC.allowlistId)!.classification)
      || !existsSync(join(Q9_WRITING_MANUAL_STATE, "problem.pdf")),
  )("reconstructs the exact Q9 writing-plan correction and requires an out-of-scope rejection", () => {
    const manualFixture = (manualInvalidDecision = false) => {
      const files = fixture();
      prepareManualFixture(files, "korean", Q9_WRITING_MANUAL_SPEC, Q9_WRITING_MANUAL_STATE);
      const artifacts = upgradeEntryToV3(files, "korean", {
        manualAdjudication: true,
        manualAdjudicationKey: Q9_WRITING_MANUAL_SPEC.key,
        manualInvalidDecision,
        terminalScope: "authorized-reject",
        answerV5: true,
      });
      return { files, artifacts };
    };

    const valid = manualFixture();
    const modifiedBefore = statSync(valid.files.dbPath).mtimeMs;
    const report = verifyExamCorpus(valid.files);
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true });
    expect(statSync(valid.files.dbPath).mtimeMs).toBe(modifiedBefore);
    const audit = JSON.parse(readFileSync(valid.artifacts.auditArtifact, "utf8"));
    const manual = audit.repairs.find((value: Record<string, any>) =>
      value.revision?.recovery?.manualAdjudication?.allowlistId === Q9_WRITING_MANUAL_SPEC.allowlistId)
      .revision.recovery.manualAdjudication;
    expect(manual.correctionSpecHash).toBe(canonicalEvidenceHash({
      allowlistId: Q9_WRITING_MANUAL_SPEC.allowlistId,
      parentKind: Q9_WRITING_MANUAL_SPEC.parentKind,
      views: Q9_WRITING_MANUAL_SPEC.views,
      dpi: Q9_WRITING_MANUAL_SPEC.dpi,
      requiredTokens: Q9_WRITING_MANUAL_SPEC.requiredTokens,
      replacements: Q9_WRITING_MANUAL_SPEC.replacements,
      figure: Q9_WRITING_MANUAL_SPEC.figure,
      figureDescription: Q9_WRITING_MANUAL_SPEC.figureDescription,
      expectedDecision: Q9_WRITING_MANUAL_SPEC.expectedDecision,
    }));
    expect(JSON.parse(readFileSync(valid.artifacts.manualEvidenceArtifact!, "utf8")))
      .toMatchObject({ dpi: 600, basis: { dpi: 600, views: Q9_WRITING_MANUAL_SPEC.views } });
    const corrected = JSON.parse(
      readFileSync(valid.artifacts.problemManualAdjudicationArtifact!, "utf8"),
    ).item;
    expect(corrected.question).toContain("[9 ~ 10] 다음을 읽고 물음에 답하시오.");
    expect(corrected.question).toContain("[글의 구상 도식]");
    expect(corrected.question).toContain("ⓒ 강연 핵심 요약");
    expect(corrected.question).toContain(
      "그리고 노력하면 무엇이든 할 수 있다는 주변의 막연한 충고는 마음에 와 닿지 않았다.",
    );
    expect(corrected.question).not.toContain("- 중심 주제: 그릿(Grit)");
    expect(corrected.question).not.toContain("ⓒ 강연 핵심 묘사");
    expect(corrected.question).not.toContain("주변의 말에도 쉽사리 마음에 와 닿지 않았다.");
    expect(corrected.figure_description).toBe(Q9_WRITING_MANUAL_SPEC.figureDescription);
    const classification = JSON.parse(readFileSync(
      valid.artifacts.classificationManualAdjudicationArtifact!,
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
    expect(audit.problemTerminalFidelityItems.find(
      (item: { key: string }) => item.key === Q9_WRITING_MANUAL_SPEC.key,
    )).toMatchObject({ status: "exact", scopeDecision: "reject" });

    const invalidDecision = manualFixture(true);
    const invalidDecisionReport = verifyExamCorpus(invalidDecision.files);
    expect(invalidDecisionReport.failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID"
        && failure.message.includes("manual adjudication is stale or non-exact")),
    JSON.stringify(invalidDecisionReport.failures, null, 2)).toBe(true);

    const tampered = manualFixture();
    writeFileSync(tampered.artifacts.problemManualAdjudicationArtifact!, "{}");
    expect(verifyExamCorpus(tampered.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("hash mismatch"))).toBe(true);

    const orphan = manualFixture();
    writeJson(join(
      orphan.files.stateDirs.korean,
      "problem-manual-adjudications",
      `v1-0004-0009-${"1".repeat(64)}.json`,
    ), {});
    expect(verifyExamCorpus(orphan.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("not declared"))).toBe(true);
  });

  it.skipIf(
    !existsSync(MANUAL_FAILED_ARTIFACTS.get(Q43_MANUAL_SPEC.allowlistId)!.problem)
      || !existsSync(MANUAL_FAILED_ARTIFACTS.get(Q43_MANUAL_SPEC.allowlistId)!.classification)
      || !existsSync(join(Q43_MANUAL_STATE, "problem.pdf"))
      || !existsSync(join(Q43_MANUAL_STATE, "solution.pdf")),
  )("reconstructs Q43 and requires its exact repaired solution and semantic authority", () => {
    const manualFixture = (manualInvalidDecision = false) => {
      const files = fixture();
      prepareManualFixture(files, "korean", Q43_MANUAL_SPEC, Q43_MANUAL_STATE, true);
      const artifacts = upgradeEntryToV3(files, "korean", {
        manualAdjudication: true,
        manualAdjudicationKey: Q43_MANUAL_SPEC.key,
        manualInvalidDecision,
        manualSolutionRepair: true,
        terminalScope: "authorized-reject",
        answerV5: true,
      });
      return { files, artifacts };
    };

    const valid = manualFixture();
    const modifiedBefore = statSync(valid.files.dbPath).mtimeMs;
    const report = verifyExamCorpus(valid.files);
    expect(report, JSON.stringify(report.failures, null, 2)).toMatchObject({ ok: true });
    expect(statSync(valid.files.dbPath).mtimeMs).toBe(modifiedBefore);
    const audit = JSON.parse(readFileSync(valid.artifacts.auditArtifact, "utf8"));
    const terminal = JSON.parse(readFileSync(valid.artifacts.terminalArtifact, "utf8"));
    expect(terminal.inputs).toHaveLength(45);
    expect(terminal.items).toHaveLength(45);
    expect(new Set(terminal.items.map((item: { key: string }) => item.key)).size).toBe(45);
    expect(terminal.items.find((item: { key: string }) => item.key === Q43_MANUAL_SPEC.key))
      .toMatchObject({ status: "exact", scopeDecision: "accept", scopeConfidence: 0.99 });
    const corrected = JSON.parse(
      readFileSync(valid.artifacts.problemManualAdjudicationArtifact!, "utf8"),
    ).item;
    expect(corrected.question).toContain("[43 ~ 45] 다음을 읽고 물음에 답하시오.");
    expect(corrected.question).toContain("먼― 기적(汽笛) 소리 처마를 스쳐가고");
    expect(corrected.question).toContain("저 운암의 겨울새들의 행로를 보아버린 죄로");
    expect(corrected.question).not.toMatch(/살아가나|차마를|베개 밑에|저 운하의/u);
    const classification = JSON.parse(readFileSync(
      valid.artifacts.classificationManualAdjudicationArtifact!,
      "utf8",
    )).items[0];
    expect(classification).toMatchObject({
      decision: "accept",
      canonical_subject: "korean_literature",
      curriculum_course: "문학",
      achievement_codes: ["12문학01-02"],
      transcription_status: "exact",
    });

    expect(audit.solutionRepairKeys).toEqual([Q43_MANUAL_SPEC.key]);
    const repair = audit.solutionRepairs[0];
    expect(repair).toMatchObject({
      key: Q43_MANUAL_SPEC.key,
      repairArtifact: { path: expect.stringMatching(/^solution-repairs\/v1-/u) },
      fidelityArtifact: { path: expect.stringMatching(/^solution-fidelity-repairs\/v1-/u) },
    });
    const baseFidelity = JSON.parse(readFileSync(
      join(valid.files.stateDirs.korean, repair.baseFidelityCheckpoint.path),
      "utf8",
    ));
    expect(baseFidelity.items).toEqual([expect.objectContaining({
      key: Q43_MANUAL_SPEC.key,
      answerStatus: "exact",
      explanationStatus: "mismatch",
    })]);
    const repairedSolution = JSON.parse(readFileSync(valid.artifacts.solutionRepairArtifact!, "utf8"));
    expect(repairedSolution.item).toMatchObject({ answer: "③", page: 5, complete: true });
    expect(repairedSolution.item.explanation).toBe(Q43_CORRECTED_SOLUTION);
    const repairedFidelity = JSON.parse(
      readFileSync(valid.artifacts.solutionRepairFidelityArtifact!, "utf8"),
    );
    expect(repairedFidelity.item).toMatchObject({
      key: Q43_MANUAL_SPEC.key,
      answerStatus: "exact",
      explanationStatus: "exact",
    });
    expect(audit.solutionFidelityItems).toEqual([expect.objectContaining({
      key: Q43_MANUAL_SPEC.key,
      answerStatus: "exact",
      explanationStatus: "exact",
      fidelityArtifact: {
        path: repair.fidelityArtifact.path,
        sha256: repair.fidelityArtifact.sha256,
      },
    })]);
    expect(audit.items).toEqual([expect.objectContaining({
      key: Q43_MANUAL_SPEC.key,
      mode: "choice-marker",
      choiceIndex: 3,
      semantic: expect.objectContaining({ status: "resolved", choiceIndex: 3 }),
    })]);
    const semantic = JSON.parse(readFileSync(valid.artifacts.semanticArtifact!, "utf8"));
    expect(semantic.inputs).toEqual([expect.objectContaining({
      key: Q43_MANUAL_SPEC.key,
      detailedExplanation: redactedExplanation(Q43_CORRECTED_SOLUTION),
    })]);
    expect(semantic.items).toEqual([expect.objectContaining({
      key: Q43_MANUAL_SPEC.key,
      status: "resolved",
      choiceIndex: 3,
    })]);
    expect(audit.semanticCheckpoint.path).toBe(
      `semantic-choice-checks/v5-${audit.effectiveCorpusHash}-` +
        `${audit.effectiveSolutionCorpusHash}-${semantic.inputHash}.json`,
    );
    const db = new Database(valid.files.dbPath, { readonly: true });
    const stored = db.prepare(
      "SELECT answer, explanation, question FROM questions WHERE printed_number = '43'",
    ).get() as { answer: string; explanation: string; question: string };
    db.close();
    expect(stored).toMatchObject({ answer: "③", explanation: Q43_CORRECTED_SOLUTION });
    expect(stored.question).toContain("[43 ~ 45] 다음을 읽고 물음에 답하시오.");

    const invalidDecision = manualFixture(true);
    expect(verifyExamCorpus(invalidDecision.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID"
        && failure.message.includes("manual adjudication is stale or non-exact"))).toBe(true);

    const tamperedRepair = manualFixture();
    writeFileSync(tamperedRepair.artifacts.solutionRepairArtifact!, "{}");
    const tamperedRepairReport = verifyExamCorpus(tamperedRepair.files);
    expect(tamperedRepairReport.failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID"
        && failure.message.includes("persisted solution authority is not canonical immutable JSON")),
    JSON.stringify(tamperedRepairReport.failures, null, 2)).toBe(true);

    const missingFidelity = manualFixture();
    rmSync(missingFidelity.artifacts.solutionRepairFidelityArtifact!);
    const missingFidelityReport = verifyExamCorpus(missingFidelity.files);
    expect(missingFidelityReport.failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID"
        && failure.message.includes("persisted repair fidelity child coverage is not exact")),
    JSON.stringify(missingFidelityReport.failures, null, 2)).toBe(true);

    const omittedRepair = manualFixture();
    rewriteCurrentV3Authority(omittedRepair.files, (currentAudit) => {
      currentAudit.solutionRepairKeys = [];
      currentAudit.solutionRepairs = [];
    }, "korean");
    expect(verifyExamCorpus(omittedRepair.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);

    const orphan = manualFixture();
    writeJson(join(
      orphan.files.stateDirs.korean,
      "problem-manual-adjudications",
      `v1-0016-0043-${"1".repeat(64)}.json`,
    ), {});
    expect(verifyExamCorpus(orphan.files).failures.some((failure) =>
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("not declared"))).toBe(true);
  });

  it.skipIf(
    !existsSync(join(Q27_MANUAL_STATE, "problem.pdf"))
      || !existsSync(join(Q27_MANUAL_STATE, "solution.pdf")),
  )("verifies the exact Q27 recovery-parent manual authority without claiming downstream completion", async () => {
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 29)))
      .toBe("0b5d7d19255cd91566a55b289b11f8a9460a3014a06f255f9a266ebd62980cf9");
    expect(manualAdjudicationAllowlistFingerprint())
      .toBe(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST));
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 11)))
      .toBe("7851318ea1e176be603db1f2679081e16ef222d90ff704e39dce8d47db446268");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 13)))
      .toBe("fe8516451df56c3030a821886a42a93d1fa88dc87529060bd608f835bc0dc990");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 15)))
      .toBe("219a859d0ab52014822efa602cc0e090f5d0f31551502386d8ab6e775ed7c53a");
    const files = await q27ManualAuthorityFixture();
    const verify = (
      manualAdjudication: unknown = files.adjudicated.evidence,
      parentRecovery: Record<string, unknown> = files.parent as unknown as Record<string, unknown>,
      failedQuestion: unknown = files.failed.question,
    ) => verifyProblemManualAdjudicationForTest({
      stateDir: files.stateDir,
      entry: files.input.entry,
      problemEvidence: files.input.problem,
      parentRecovery,
      failedQuestion,
      failedClassification: files.failed.classification,
      manualAdjudication,
    });

    try {
      const verified = verify() as {
        question: QuizItemEx;
        classification: ClassificationDecision;
        evidence: Record<string, any>;
      };
      expect(canonicalEvidenceHash(verified.question))
        .toBe("0364d049bef73773465b13f09fa2f234e9c7fc4ef4f9f9bdefeef0a8692c457b");
      expect(verified.question.question).toContain("[27 ~ 32] 다음 글을 읽고 물음에 답하시오.");
      expect(verified.question.question).toContain("이다지 낡아빠진 생활을 하는 것은 아니리라");
      expect(verified.question.question).toContain("함이정 : 처녀 때 난 생각했었지.");
      expect(verified.question.question).not.toMatch(/이지러 낡아빠진|아니라라/u);
      expect(verified.question.choices?.[2]).toBe(
        "③ 화자는 ‘고생도 마음대로 할 수 없는 세상’에서 ‘존재 없이’ 살아가는 것이 어렵다고 느끼고 있다.",
      );
      expect(verified.question.figure_description).toContain("왼쪽으로 열린 세로 묶음 괄호 [A]");
      expect(verified.question.figure_description).toContain("같은 모양의 세로 묶음 괄호 [B]");
      expect(verified.classification).toMatchObject({
        key: Q27_MANUAL_SPEC.key,
        decision: "accept",
        canonical_subject: "korean_literature",
        curriculum_course: "문학",
        transcription_status: "exact",
      });
      expect(verified.evidence).toMatchObject({
        allowlistId: Q27_MANUAL_SPEC.allowlistId,
        parentRecoveryEvidenceHash: Q27_MANUAL_SPEC.parentRecoveryEvidenceHash,
        problemArtifactItemHash: "0364d049bef73773465b13f09fa2f234e9c7fc4ef4f9f9bdefeef0a8692c457b",
        cropViews: Q27_MANUAL_SPEC.views.map((view) => expect.objectContaining(view)),
      });
      expect(verified.evidence.problemArtifact.path)
        .toMatch(/^problem-manual-adjudications\/v1-0011-0027-[a-f0-9]{64}\.json$/u);
      expect(verified.evidence.classificationArtifact.path)
        .toMatch(/^classification-manual-adjudications\/v1-0011-0027-[a-f0-9]{64}-7bb7cb863c8c4855\.json$/u);
      expect(readdirSync(join(files.stateDir, "problem-manual-evidence"))
        .filter((name) => !name.endsWith(".tmp"))).toHaveLength(6);

      const wrongParent = structuredClone(files.parent) as unknown as Record<string, unknown>;
      wrongParent.effectiveQuestionHash = "0".repeat(64);
      expect(() => verify(files.adjudicated.evidence, wrongParent))
        .toThrow(/allowlist\/parent authority/u);

      const wrongChoiceSpec = structuredClone(files.adjudicated.evidence) as Record<string, any>;
      wrongChoiceSpec.correctionSpecHash = "0".repeat(64);
      expect(() => verify(wrongChoiceSpec)).toThrow(/allowlist\/parent authority/u);

      const problemPath = join(files.stateDir, files.adjudicated.evidence.problemArtifact.path);
      const problemBytes = readFileSync(problemPath);
      writeFileSync(problemPath, Buffer.concat([problemBytes, Buffer.from("tampered")]));
      expect(() => verify()).toThrow(/hash mismatch/u);
      writeFileSync(problemPath, problemBytes);

      const cropPath = join(files.stateDir, files.adjudicated.evidence.cropViews[0].artifact.path);
      const cropBytes = readFileSync(cropPath);
      writeFileSync(cropPath, Buffer.concat([cropBytes, Buffer.from("tampered")]));
      expect(() => verify()).toThrow(/hash mismatch/u);
      writeFileSync(cropPath, cropBytes);

      const classificationPath = join(
        files.stateDir,
        files.adjudicated.evidence.classificationArtifact.path,
      );
      const classificationBytes = readFileSync(classificationPath);
      rmSync(classificationPath);
      expect(() => verify()).toThrow();
      writeFileSync(classificationPath, classificationBytes);

      const orphanPath = join(
        files.stateDir,
        "problem-manual-adjudications",
        `v1-0011-0027-${"1".repeat(64)}.json`,
      );
      writeJson(orphanPath, {});
      expect(() => verify()).toThrow(/not declared/u);
      rmSync(orphanPath);

      const secondChildPath = join(
        files.stateDir,
        "classification-manual-adjudications",
        `v1-0011-0027-${"2".repeat(64)}-${DIGEST}.json`,
      );
      writeJson(secondChildPath, {});
      expect(() => verify()).toThrow(/not declared/u);
      rmSync(secondChildPath);

      expect(existsSync(join(files.stateDir, "answer-audit"))).toBe(false);
      expect(existsSync(join(files.stateDir, "answer-attestation"))).toBe(false);
    } finally {
      providerMock.complete.mockReset();
      rmSync(files.stateDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("forces current verification for invalid manual directories but ignores confined temp residue", () => {
    const directories = [
      "problem-manual-evidence",
      "problem-manual-adjudications",
      "classification-manual-adjudications",
      "problem-manual-revisions",
      "classification-manual-revisions",
      "problem-manual-second-revisions",
      "classification-manual-second-revisions",
      "classification-manual-policy-revisions",
    ];
    for (const directory of directories) {
      const files = fixture();
      const outside = mkdtempSync(join(tmpdir(), "verify-manual-empty-signal-"));
      const signalPath = join(files.stateDirs.math, directory);
      symlinkSync(outside, signalPath);
      try {
        expect(verificationContractAuditVersionForTest(files.stateDirs.math)).toBe(5);
        expect(verifyExamCorpus(files).failures.some((failure) =>
          failure.code === "ANSWER_ATTESTATION_MISSING")).toBe(true);
      } finally {
        rmSync(signalPath);
        rmSync(outside, { recursive: true, force: true });
      }
    }

    const residue = fixture();
    const previousContract = verificationContractAuditVersionForTest(residue.stateDirs.math);
    for (const directory of directories) {
      const absolute = join(residue.stateDirs.math, directory);
      mkdirSync(absolute, { recursive: true });
      writeFileSync(join(absolute, "crash-resume.tmp"), "partial immutable write");
    }
    expect(verificationContractAuditVersionForTest(residue.stateDirs.math)).toBe(previousContract);
    expect(verifyExamCorpus(residue), "regular temp-only manual directories must remain inert")
      .toMatchObject({ ok: true });

    const current = fixture();
    upgradeEntryToV3(current, "math", { terminalScope: "authorized-reject", answerV5: true });
    const danglingPolicyDirectory = join(
      current.stateDirs.math,
      "classification-manual-policy-revisions",
    );
    symlinkSync(join(current.stateDirs.math, "missing-policy-directory"), danglingPolicyDirectory);
    try {
      const report = verifyExamCorpus(current);
      expect(report.failures.some((failure) => failure.code === "ANSWER_AUDIT_INVALID"
        && failure.message.includes("confined regular directory"))).toBe(true);
    } finally {
      rmSync(danglingPolicyDirectory);
    }
  });

  it.skipIf(
    !existsSync(join(Q27_MANUAL_STATE, "problem.pdf"))
      || !existsSync(join(Q27_MANUAL_STATE, "solution.pdf")),
  )("verifies the exact Q43-Q45 shared-passage manual authorities without inventing a terminal", async () => {
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 29)))
      .toBe("0b5d7d19255cd91566a55b289b11f8a9460a3014a06f255f9a266ebd62980cf9");
    expect(manualAdjudicationAllowlistFingerprint())
      .toBe(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST));
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 11)))
      .toBe("7851318ea1e176be603db1f2679081e16ef222d90ff704e39dce8d47db446268");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 13)))
      .toBe("fe8516451df56c3030a821886a42a93d1fa88dc87529060bd608f835bc0dc990");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 15)))
      .toBe("219a859d0ab52014822efa602cc0e090f5d0f31551502386d8ab6e775ed7c53a");
    const expectedRows = new Map([
      ["16:43", {
        row: "fc841055b1d90f58e118b165cc00b356aff8f0ead1de89b30bdeee54a61846f1",
        spec: "48a46e5183398c07c9207706cff83cf1fea85a441777b6a81223186976eddc72",
        status: "exact",
      }],
      ["16:44", {
        row: "14ac8dc295ca946619aa61c9e83e9dd5fe11b5bd7eea3cfdb8e44b0ff1a65a49",
        spec: "57b3f8211b1d65489be9c677b7c5a32503f72e2b2711f535a1c04097111c5bb0",
        status: "mismatch",
      }],
      ["16:45", {
        row: "0cf6173c1aee8aa61d6d57af5b7665af207e864438a73d78eb93a7a3543f00fd",
        spec: "43f159475ecbbd6d3ecdd8d031abc0903f9bee5783145afb6a92c8a13e989055",
        status: "mismatch",
      }],
    ]);
    for (const spec of Q43_TO_45_MANUAL_SPECS) {
      expect(canonicalEvidenceHash(spec)).toBe(expectedRows.get(spec.key)!.row);
    }
    const rows = await q43To45ManualAuthorityFixture();
    const verify = (
      row: (typeof rows)[number],
      manualAdjudication: unknown = row.adjudicated.evidence,
      parentRecovery: Record<string, unknown> = row.parent as unknown as Record<string, unknown>,
      failedClassification: unknown = row.failed.classification,
    ) => withOnlyManualArtifactsForKey(row.stateDir, row.spec.key, () =>
      verifyProblemManualAdjudicationForTest({
        stateDir: row.stateDir,
        entry: row.input.entry,
        problemEvidence: row.input.problem,
        parentRecovery,
        failedQuestion: row.failed.question,
        failedClassification,
        manualAdjudication,
      }));

    try {
      for (const row of rows) {
        expect(row.failed.classification.transcription_status).toBe(expectedRows.get(row.spec.key)!.status);
        const verified = verify(row) as {
          question: QuizItemEx;
          classification: ClassificationDecision;
          evidence: Record<string, any>;
        };
        const expectedQuestion = applyAllowlistedProblemManualCorrection(
          row.input.entry.id,
          row.input.problem.sha256,
          row.failed.question,
        );
        expect(canonicalEvidenceHash(verified.question)).toBe(canonicalEvidenceHash(expectedQuestion));
        expect(verified.question.question).toContain("[43 ~ 45] 다음 글을 읽고 물음에 답하시오.");
        expect(verified.question.question).toContain("천하의 글은 같아 필담이나 하오리라");
        expect(verified.question.question).toContain("흥정 외상 셈하려 주주리는 지저귄다");
        expect(verified.question.figure_description).toContain("오른쪽으로 열린 세로 묶음 괄호가 정확히 두 개");
        expect(verified.classification).toMatchObject({
          key: row.spec.key,
          decision: "accept",
          canonical_subject: "korean_literature",
          transcription_status: "exact",
        });
        expect(verified.evidence).toMatchObject({
          allowlistId: row.spec.allowlistId,
          parentRecoveryEvidenceHash: row.spec.parentRecoveryEvidenceHash,
          correctionSpecHash: expectedRows.get(row.spec.key)!.spec,
        });
      }
      expect((verify(rows[0]) as { question: QuizItemEx }).question.choices?.[3])
        .toContain("외양과 감정을");
      expect((verify(rows[1]) as { question: QuizItemEx }).question.choices?.[3])
        .toContain("새로운 계책을 마련한 기쁨");
      expect((verify(rows[2]) as { question: QuizItemEx }).question.choices?.[4])
        .toContain("메밀떡에 밀다식에 겉밤");

      expect(() => verify(rows[0], rows[1].adjudicated.evidence))
        .toThrow(/allowlist\/parent authority/u);
      expect(() => verify(rows[0], rows[0].adjudicated.evidence,
        rows[1].parent as unknown as Record<string, unknown>))
        .toThrow(/allowlist\/parent authority/u);

      const wrongExactStatus = structuredClone(rows[0].failed.classification);
      wrongExactStatus.transcription_status = "mismatch";
      expect(() => verify(rows[0], rows[0].adjudicated.evidence,
        rows[0].parent as unknown as Record<string, unknown>, wrongExactStatus))
        .toThrow(/allowlisted exhausted recovery status/u);
      const wrongDefaultStatus = structuredClone(rows[1].failed.classification);
      wrongDefaultStatus.transcription_status = "exact";
      expect(() => verify(rows[1], rows[1].adjudicated.evidence,
        rows[1].parent as unknown as Record<string, unknown>, wrongDefaultStatus))
        .toThrow(/allowlisted exhausted recovery status/u);

      const missingPath = join(rows[2].stateDir, rows[2].adjudicated.evidence.classificationArtifact.path);
      const missingBytes = readFileSync(missingPath);
      rmSync(missingPath);
      expect(() => verify(rows[2])).toThrow();
      writeFileSync(missingPath, missingBytes);

      const tamperedPath = join(rows[1].stateDir, rows[1].adjudicated.evidence.problemArtifact.path);
      const tamperedBytes = readFileSync(tamperedPath);
      writeFileSync(tamperedPath, Buffer.concat([tamperedBytes, Buffer.from("tampered")]));
      expect(() => verify(rows[1])).toThrow(/hash mismatch/u);
      writeFileSync(tamperedPath, tamperedBytes);

      withOnlyManualArtifactsForKey(rows[0].stateDir, rows[0].spec.key, () => {
        const orphanPath = join(
          rows[0].stateDir,
          "problem-manual-adjudications",
          `v1-0016-0043-${"1".repeat(64)}.json`,
        );
        writeJson(orphanPath, {});
        try {
          expect(() => verifyProblemManualAdjudicationForTest({
            stateDir: rows[0].stateDir,
            entry: rows[0].input.entry,
            problemEvidence: rows[0].input.problem,
            parentRecovery: rows[0].parent as unknown as Record<string, unknown>,
            failedQuestion: rows[0].failed.question,
            failedClassification: rows[0].failed.classification,
            manualAdjudication: rows[0].adjudicated.evidence,
          })).toThrow(/not declared/u);
        } finally {
          rmSync(orphanPath);
        }
      });

      const outside = mkdtempSync(join(tmpdir(), "verify-manual-inventory-symlink-"));
      const symlinkPath = join(rows[0].stateDir, "problem-manual-revisions");
      symlinkSync(outside, symlinkPath);
      try {
        expect(() => verify(rows[0])).toThrow(/confined regular directory/u);
      } finally {
        rmSync(symlinkPath);
        rmSync(outside, { recursive: true, force: true });
      }

      expect(existsSync(join(rows[0].stateDir, "answer-audit"))).toBe(false);
      expect(existsSync(join(rows[0].stateDir, "answer-attestation"))).toBe(false);
    } finally {
      providerMock.complete.mockReset();
      rmSync(rows[0].stateDir, { recursive: true, force: true });
    }
  }, 180_000);

  it.skipIf(!existsSync(join(Q30_MANUAL_STATE, "problem.pdf")))(
    "mirrors and verifies the exact 5578421 Q44-Q45 shared-passage authority",
    async () => {
    expect(problemManualAdjudicationAllowlistForTest()).toEqual(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST);
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST).toHaveLength(75);
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 46)))
      .toBe("918b9267faab3d394cf64e5b9f02e9621024c5c6ad5d17d233fd8940fd1dac82");
    expect(manualAdjudicationAllowlistFingerprint())
      .toBe("c2d72629f59f1bf4b0c4f8651deb80284e56002eadbd4a395dcfb926172ceaa2");
    expect(manualRevisionAllowlistFingerprint())
      .toBe("c08c7c4b8865cebdfc6df49ac917f3e010f39d505f4a222e9b4b4c46ab09d275");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_REVISION_ALLOWLIST.slice(0, 6)))
      .toBe("33741ecff318e2d58cc2c0614a718d41171a0629f792d062c63df876e23ffa5c");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_REVISION_ALLOWLIST.slice(0, 8)))
      .toBe("1e10a56d615f8323979ecfe72bccd6f8ac2b58850545ac3beb7a409344651fd6");
    expect(manualRevisionAllowlistFingerprint())
      .toBe("c08c7c4b8865cebdfc6df49ac917f3e010f39d505f4a222e9b4b4c46ab09d275");
    expect(PROBLEM_MANUAL_REVISION_ALLOWLIST.slice(6, 8).map((spec) => ({
      key: spec.key,
      rowHash: canonicalEvidenceHash(spec),
    }))).toEqual([{
      key: "16:44",
      rowHash: "41d2518dfff51233a9604956b19ea7cfe8d53a7257f80958a05565ddadcadaaf",
    }, {
      key: "16:45",
      rowHash: "b3742ae0758ddba275a8131de206fc86e3bea2f0bfdfde9dadb0eb10be8baa00",
    }]);
    expect(Q44_Q45_5578421_MANUAL_SPECS.map((spec) => ({
      key: spec.key,
      rowHash: canonicalEvidenceHash(spec),
      replacementsHash: canonicalEvidenceHash(spec.replacements),
      failedStatus: spec.failedStatus,
    }))).toEqual([{
      key: "16:44",
      rowHash: "a218df41070334840e83c6ca5a7bc689716ba892102764a32e90249c1ee95e4c",
      replacementsHash: "2f54cb0fb33d67b812ddfc834849a52389fc7671babd287ae22cb874e9d5418c",
      failedStatus: undefined,
    }, {
      key: "16:45",
      rowHash: "1c6ba6d0191e25b6991175ebf57c6dfb07f650c7969e1c335ba4a361549a8bb5",
      replacementsHash: "092952d05ee949af0b029d4ff7fd011edeeda8276e31cc0c04081f5a67d4f7cf",
      failedStatus: "exact",
    }]);
    const rows = await q44Q45ManualAuthorityFixture5578421();
    const verify = (row: (typeof rows)[number]) => withOnlyManualArtifactsForKey(
      row.stateDir,
      row.spec.key,
      () => verifyProblemManualAdjudicationForTest({
        stateDir: row.stateDir,
        entry: row.input.entry,
        problemEvidence: row.input.problem,
        parentRecovery: row.parent as unknown as Record<string, unknown>,
        failedQuestion: row.failed.question,
        failedClassification: row.failed.classification,
        manualAdjudication: row.adjudicated.evidence,
      }),
    ) as { question: QuizItemEx; classification: ClassificationDecision; evidence: Record<string, any> };
    try {
      const verified = rows.map(verify);
      expect(verified.map((row) => canonicalEvidenceHash(row.question))).toEqual([
        "9c38330638950ef2e46c3748001b36d2c7f8ddd86249f9c859581a6dec54a93c",
        "06bc483a24e118a3b41c2da971bffeef560fb491c5b9625928dfce214b9b4a02",
      ]);
      expect(verified.map((row) => row.evidence.revision.allowlistId)).toEqual([
        "ebsi-5578421-q44-manual-revision-v1",
        "ebsi-5578421-q45-manual-revision-v1",
      ]);
      expect(verified[1].evidence.revision.sourceRevision.allowlistId)
        .toBe("ebsi-5578421-q45-manual-source-revision-v1");
      expect(verified.map((row) => row.classification)).toEqual([
        expect.objectContaining({ key: "16:44", decision: "accept", transcription_status: "exact" }),
        expect.objectContaining({ key: "16:45", decision: "accept", transcription_status: "exact" }),
      ]);
      expect(verified[1].question.figure_description)
        .toContain("B-(가)와 B-(나)의 두 판단 근거는 선택지 ③ 하나로 묶여 있다.");
      const q45ProblemPath = join(
        rows[1].stateDir,
        rows[1].adjudicated.evidence.revision!.sourceRevision!.problemArtifact.path,
      );
      const q45ProblemBytes = readFileSync(q45ProblemPath);
      writeFileSync(q45ProblemPath, Buffer.concat([q45ProblemBytes, Buffer.from("tampered")]));
      expect(() => verify(rows[1])).toThrow(/hash mismatch/u);
      writeFileSync(q45ProblemPath, q45ProblemBytes);
    } finally {
      providerMock.complete.mockReset();
      rmSync(rows[0].stateDir, { recursive: true, force: true });
    }
  }, 240_000);

  it.skipIf(!existsSync(join(Q30_MANUAL_STATE, "problem.pdf")))(
    "mirrors and verifies the exact 5578421 Q2 terminal-trigger authority",
    async () => {
    expect(problemManualAdjudicationAllowlistForTest()).toEqual(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST);
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST).toHaveLength(75);
    expect(manualAdjudicationAllowlistFingerprint())
      .toBe("c2d72629f59f1bf4b0c4f8651deb80284e56002eadbd4a395dcfb926172ceaa2");
    expect({
      rowHash: canonicalEvidenceHash(Q2_5578421_MANUAL_SPEC),
      replacementsHash: canonicalEvidenceHash(Q2_5578421_MANUAL_SPEC.replacements),
      terminalTriggerHash: canonicalEvidenceHash(Q2_5578421_MANUAL_SPEC.terminalTrigger),
      parentRecoveryEvidenceHash: Q2_5578421_MANUAL_SPEC.parentRecoveryEvidenceHash,
    }).toEqual({
      rowHash: "d5bb10bb3abb82af482a85fd00fadca842c18286e4d06d77b93ee311f204767c",
      replacementsHash: "90e41ab9bc78e737301960082df32ae7a4bbc0b312a673baaf0d91193649be8e",
      terminalTriggerHash: "e24c26d81a7d288ef6a44abe4e1ed3cdecb61e22fdc8a40aabf34b9b58377b6b",
      parentRecoveryEvidenceHash: "c09674a75c0e93955440fe4094943cdddedaff96fc355e76620bf1b5ed86043c",
    });
    expect({
      rowHash: canonicalEvidenceHash(Q2_5578421_MANUAL_REVISION_SPEC),
      replacementHash: canonicalEvidenceHash(Q2_5578421_MANUAL_REVISION_SPEC.replacement),
    }).toEqual({
      rowHash: "7fec9a6782faf9cc6e59837c3528335963319fabc58ea1b7adfaeb25651028e5",
      replacementHash: "da53d25545e236eadc2e0c064463a171d4678f640160ee3acb6be0928c805770",
    });
    expect({
      allowlistHash: manualSourceRevisionAllowlistFingerprint(),
      rowHash: canonicalEvidenceHash(Q2_5578421_MANUAL_SOURCE_REVISION_SPEC),
      replacementHash: canonicalEvidenceHash(Q2_5578421_MANUAL_SOURCE_REVISION_SPEC.replacement),
      triggerHash: canonicalEvidenceHash(Q2_5578421_MANUAL_SOURCE_REVISION_SPEC.terminalTrigger),
    }).toEqual({
      allowlistHash: "aca473b2b0a319390e5e6ce18d9a18149f68d5bc53fa27a86e8dac7b6ae94a9c",
      rowHash: "99ec8e696ea73ba0c61d31df0df9f657bcb29e62fa6ff43e8db1389542e821aa",
      replacementHash: "b0751915ae3df15620b51fcbccf08d95e0b29abb6edc28c8ae68333a4bbbe90a",
      triggerHash: "240e0e1d3617c2d0de839ea55687ed7efb658037c62d4608f934c3426cfd4704",
    });
    const row = await q2ManualAuthorityFixture5578421();
    const verify = () => withOnlyManualArtifactsForKey(
      row.stateDir,
      row.spec.key,
      () => verifyProblemManualAdjudicationForTest({
        stateDir: row.stateDir,
        entry: row.input.entry,
        problemEvidence: row.input.problem,
        parentRecovery: row.parent as unknown as Record<string, unknown>,
        failedQuestion: row.failed.question,
        failedClassification: row.failed.classification,
        manualAdjudication: row.adjudicated.evidence,
      }),
    ) as { question: QuizItemEx; classification: ClassificationDecision; evidence: Record<string, any> };
    try {
      const verified = verify();
      expect(canonicalEvidenceHash(verified.question))
        .toBe("b3d4ca3602e31cff626c4f461c2f4929adf8be4ee5ad0b31f9a73c789780cd30");
      expect(verified.question.question.startsWith("[1~3] 다음은 라디오 대담의 일부이다.")).toBe(true);
      expect(verified.question.question).toContain("최 교수님께서 제기하신 문제에 대해서는");
      expect(verified.question.question).toContain("비용을 줄일 수 있어서");
      expect(verified.classification).toEqual(expect.objectContaining({
        key: "1:2",
        decision: "reject",
        canonical_subject: null,
        transcription_status: "exact",
      }));
      expect(verified.evidence.terminalTrigger.kind).toBe("checkpoint");
      expect(verified.evidence.revision.allowlistId)
        .toBe("ebsi-5578421-q2-manual-revision-v1");
      expect(verified.evidence.revision.sourceRevision.allowlistId)
        .toBe("ebsi-5578421-q2-manual-source-revision-v1");
      const triggerPath = join(row.stateDir, row.adjudicated.evidence.terminalTrigger!.artifact.path);
      const triggerBytes = readFileSync(triggerPath);
      writeFileSync(triggerPath, Buffer.concat([triggerBytes, Buffer.from("tampered")]));
      expect(() => verify()).toThrow(/hash mismatch|checkpoint trigger authority/u);
      writeFileSync(triggerPath, triggerBytes);
    } finally {
      providerMock.complete.mockReset();
      rmSync(row.stateDir, { recursive: true, force: true });
    }
  }, 180_000);

  it.skipIf(!existsSync(join(Q30_MANUAL_STATE, "problem.pdf")))(
    "mirrors and verifies the exact 5578421 Q14 tone-diagram authority",
    async () => {
    expect(problemManualAdjudicationAllowlistForTest()).toEqual(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST);
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST).toHaveLength(75);
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 48)))
      .toBe("66ff6014e0969fa9a2f13b53c9157eb8a5ca945097cba7ee1d6416cf93e0cc8d");
    expect(manualAdjudicationAllowlistFingerprint())
      .toBe("c2d72629f59f1bf4b0c4f8651deb80284e56002eadbd4a395dcfb926172ceaa2");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_REVISION_ALLOWLIST.slice(0, 8)))
      .toBe("1e10a56d615f8323979ecfe72bccd6f8ac2b58850545ac3beb7a409344651fd6");
    expect(manualRevisionAllowlistFingerprint())
      .toBe("c08c7c4b8865cebdfc6df49ac917f3e010f39d505f4a222e9b4b4c46ab09d275");
    expect({
      rowHash: canonicalEvidenceHash(PROBLEM_MANUAL_REVISION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5578421-q14-manual-revision-v1"
      )),
      replacementHash: canonicalEvidenceHash(PROBLEM_MANUAL_REVISION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5578421-q14-manual-revision-v1"
      )?.replacement),
    }).toEqual({
      rowHash: "30bdb578aac86abb60471c18d06a6f5231101a46d7c3ab753a266789e2613d25",
      replacementHash: "e0266a2e3c9f7f4129877618f4d1674dea689b064fba64115527cb7ea3b5b8ed",
    });
    expect({
      rowHash: canonicalEvidenceHash(Q14_5578421_MANUAL_SPEC),
      replacementsHash: canonicalEvidenceHash(Q14_5578421_MANUAL_SPEC.replacements),
      parentRecoveryEvidenceHash: Q14_5578421_MANUAL_SPEC.parentRecoveryEvidenceHash,
    }).toEqual({
      rowHash: "94087546341d55e4056f2b2a0421a4376db3188824972abe9ab6bb2fc11a817c",
      replacementsHash: "17b4d68ff2c352af8424f360b206e2688260549354c04c6a9e05e39b678c6fd5",
      parentRecoveryEvidenceHash: "1186ce8d805522044fe8fbfba39c5c2f5529988e2000e09532c8201b30593ca1",
    });
    const row = await q14ManualAuthorityFixture5578421();
    const verify = () => withOnlyManualArtifactsForKey(
      row.stateDir,
      row.spec.key,
      () => verifyProblemManualAdjudicationForTest({
        stateDir: row.stateDir,
        entry: row.input.entry,
        problemEvidence: row.input.problem,
        parentRecovery: row.parent as unknown as Record<string, unknown>,
        failedQuestion: row.failed.question,
        failedClassification: row.failed.classification,
        manualAdjudication: row.adjudicated.evidence,
      }),
    ) as { question: QuizItemEx; classification: ClassificationDecision; evidence: Record<string, any> };
    try {
      const verified = verify();
      expect(canonicalEvidenceHash(verified.question))
        .toBe("b06ec23b682071105a7103f5987efaf1e9f1ff2a0161133c774ab6004c30873b");
      expect(verified.question.answer).toContain("② ‘아’ 낮음 → ‘니’ 높음");
      expect(verified.question.question).toContain("- 『 용비어천가(龍飛御天歌) 』 제2장 중에서");
      expect(verified.question.figure_description).toContain("⑤는 낮음－상승－높음－상승");
      expect(verified.evidence.revision.allowlistId)
        .toBe("ebsi-5578421-q14-manual-revision-v1");
      expect(verified.classification).toEqual(expect.objectContaining({
        key: "5:14",
        decision: "reject",
        canonical_subject: null,
        transcription_status: "exact",
      }));
      const problemPath = join(row.stateDir, row.adjudicated.evidence.revision!.problemArtifact.path);
      const problemBytes = readFileSync(problemPath);
      writeFileSync(problemPath, Buffer.concat([problemBytes, Buffer.from("tampered")]));
      expect(() => verify()).toThrow(/hash mismatch/u);
      writeFileSync(problemPath, problemBytes);
    } finally {
      providerMock.complete.mockReset();
      rmSync(row.stateDir, { recursive: true, force: true });
    }
  }, 180_000);

  it.skipIf(!existsSync(join(Q30_MANUAL_STATE, "problem.pdf")))(
    "mirrors and verifies the second source-exact 5578421 Q3 recovery",
    async () => {
    expect(problemManualAdjudicationAllowlistForTest()).toEqual(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST);
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST).toHaveLength(75);
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 53)))
      .toBe("0ccd51016dcfc75b0fe1e9f5ed88216b02aa305911b232a9f7f90eb68cc6544c");
    expect(manualAdjudicationAllowlistFingerprint())
      .toBe("c2d72629f59f1bf4b0c4f8651deb80284e56002eadbd4a395dcfb926172ceaa2");
    expect({
      rowHash: canonicalEvidenceHash(Q3_V2_5578421_MANUAL_SPEC),
      replacementsHash: canonicalEvidenceHash(Q3_V2_5578421_MANUAL_SPEC.replacements),
      parentRecoveryEvidenceHash: Q3_V2_5578421_MANUAL_SPEC.parentRecoveryEvidenceHash,
    }).toEqual({
      rowHash: "19f644e345b0cf31411eccad2fe6f9569378a89427f9e1e3285bf12c57545a61",
      replacementsHash: "c7b05841ac72ee461dd73897e5b0421c5daeffaae1f1c23ff0b712f287844d07",
      parentRecoveryEvidenceHash: "b2a2d24967a85e0dca3a6042d2fec44a4950e00c4c9b05beb6d07bd6b009f7a8",
    });
    const row = await q3V2ManualAuthorityFixture5578421();
    const verify = () => withOnlyManualArtifactsForKey(
      row.stateDir,
      row.spec.key,
      () => verifyProblemManualAdjudicationForTest({
        stateDir: row.stateDir,
        entry: row.input.entry,
        problemEvidence: row.input.problem,
        parentRecovery: row.parent as unknown as Record<string, unknown>,
        failedQuestion: row.failed.question,
        failedClassification: row.failed.classification,
        manualAdjudication: row.adjudicated.evidence,
      }),
    ) as { question: QuizItemEx; classification: ClassificationDecision };
    try {
      const verified = verify();
      expect(canonicalEvidenceHash(verified.question))
        .toBe("2bed2f68fb0acf13e9a3ac5040e2074d004e332dafb9c9037ec8104074b41f9b");
      expect(verified.question.question).toContain("[1~3] 다음은 라디오 대담의 일부이다.");
      expect(verified.question.question).toContain("최 교수님께서 제기하신 문제에 대해서는");
      expect(verified.question.figure_description).toContain("각 게시물 오른쪽에는 ①부터 ⑤까지");
      expect(verified.classification).toEqual(expect.objectContaining({
        key: "1:3",
        decision: "reject",
        canonical_subject: null,
        transcription_status: "exact",
      }));
      const problemPath = join(row.stateDir, row.adjudicated.evidence.problemArtifact.path);
      const problemBytes = readFileSync(problemPath);
      writeFileSync(problemPath, Buffer.concat([problemBytes, Buffer.from("tampered")]));
      expect(() => verify()).toThrow(/hash mismatch/u);
      writeFileSync(problemPath, problemBytes);
    } finally {
      providerMock.complete.mockReset();
      rmSync(row.stateDir, { recursive: true, force: true });
    }
  }, 180_000);

  it.skipIf(!existsSync(join(Q30_MANUAL_STATE, "problem.pdf")))(
    "mirrors and verifies the exact 5578421 Q12 grammar-table authority",
    async () => {
    expect(problemManualAdjudicationAllowlistForTest()).toEqual(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST);
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST).toHaveLength(75);
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 51)))
      .toBe("8377e380ffebc05e5e74bcf04896ff495c93630378b30f2051cc5c2e896c9e23");
    expect(manualAdjudicationAllowlistFingerprint())
      .toBe("c2d72629f59f1bf4b0c4f8651deb80284e56002eadbd4a395dcfb926172ceaa2");
    expect({
      rowHash: canonicalEvidenceHash(Q12_5578421_MANUAL_SPEC),
      replacementsHash: canonicalEvidenceHash(Q12_5578421_MANUAL_SPEC.replacements),
      parentRecoveryEvidenceHash: Q12_5578421_MANUAL_SPEC.parentRecoveryEvidenceHash,
    }).toEqual({
      rowHash: "024132dc5e89e982054fd889aa4b53364425af85c6e947e53e220ed924d18645",
      replacementsHash: "d60e37bd3a376cce498db0378b60f199255276496a69fac1662446ed80780693",
      parentRecoveryEvidenceHash: "2cec6cbd5de6b7795867c7b1897ce4c7dd35adbbc34e6be17f445e060dee9207",
    });
    const row = await q12ManualAuthorityFixture5578421();
    const verify = () => withOnlyManualArtifactsForKey(
      row.stateDir,
      row.spec.key,
      () => verifyProblemManualAdjudicationForTest({
        stateDir: row.stateDir,
        entry: row.input.entry,
        problemEvidence: row.input.problem,
        parentRecovery: row.parent as unknown as Record<string, unknown>,
        failedQuestion: row.failed.question,
        failedClassification: row.failed.classification,
        manualAdjudication: row.adjudicated.evidence,
      }),
    ) as { question: QuizItemEx; classification: ClassificationDecision };
    try {
      const verified = verify();
      expect(canonicalEvidenceHash(verified.question))
        .toBe("c6459fb8755e7e48af2c74ac051ce62ebc8413f1b2a9c2192cd78996cd0fea47");
      expect(verified.question.question)
        .toContain("관형어는 체언을, 부사어는 용언을 한정하는 기능을 함.");
      expect(verified.question.question)
        .not.toContain("관형어는 체언을, 부사는 용언을 한정하는 기능을 함.");
      expect(verified.question.figure_description)
        .toContain("관형어는 체언을, 부사어는 용언을 한정하는 기능을 함.");
      expect(verified.classification).toEqual(expect.objectContaining({
        key: "4:12",
        decision: "reject",
        canonical_subject: null,
        transcription_status: "exact",
      }));
      const problemPath = join(row.stateDir, row.adjudicated.evidence.problemArtifact.path);
      const problemBytes = readFileSync(problemPath);
      writeFileSync(problemPath, Buffer.concat([problemBytes, Buffer.from("tampered")]));
      expect(() => verify()).toThrow(/hash mismatch/u);
      writeFileSync(problemPath, problemBytes);
    } finally {
      providerMock.complete.mockReset();
      rmSync(row.stateDir, { recursive: true, force: true });
    }
  }, 180_000);

  it.skipIf(!existsSync(join(Q30_MANUAL_STATE, "problem.pdf")))(
    "mirrors and verifies the exact 5578421 Q43 shared-passage authority",
    async () => {
    expect(problemManualAdjudicationAllowlistForTest()).toEqual(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST);
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST).toHaveLength(75);
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 52)))
      .toBe("d33bde802507edbe74051f14a89b6182714cbc675f3838d0245a91f405562a87");
    expect(manualAdjudicationAllowlistFingerprint())
      .toBe("c2d72629f59f1bf4b0c4f8651deb80284e56002eadbd4a395dcfb926172ceaa2");
    expect({
      rowHash: canonicalEvidenceHash(Q43_5578421_MANUAL_SPEC),
      replacementsHash: canonicalEvidenceHash(Q43_5578421_MANUAL_SPEC.replacements),
      parentRecoveryEvidenceHash: Q43_5578421_MANUAL_SPEC.parentRecoveryEvidenceHash,
    }).toEqual({
      rowHash: "c6937a3be30deaf2d7e9f9bad31abacae6513f4a8b9815e2a06adb2f8ec5c6f3",
      replacementsHash: "82767a2c63ea8197bc8197bbb6062c53a4c9f876a5619dd247e455e6265a820e",
      parentRecoveryEvidenceHash: "a2fd297236204de0e51cae9b8a40192b01eafd98aea39e7e2ff83d46e5ea2ffc",
    });
    const row = await q43ManualAuthorityFixture5578421();
    const verify = () => withOnlyManualArtifactsForKey(
      row.stateDir,
      row.spec.key,
      () => verifyProblemManualAdjudicationForTest({
        stateDir: row.stateDir,
        entry: row.input.entry,
        problemEvidence: row.input.problem,
        parentRecovery: row.parent as unknown as Record<string, unknown>,
        failedQuestion: row.failed.question,
        failedClassification: row.failed.classification,
        manualAdjudication: row.adjudicated.evidence,
      }),
    ) as { question: QuizItemEx; classification: ClassificationDecision };
    try {
      const verified = verify();
      expect(canonicalEvidenceHash(verified.question))
        .toBe("49e6d4ac17c0aa0fe2952b9e30fd3734c9d4b0f3ae880b72e811d64aa061c676");
      expect(verified.question.question)
        .toContain("㉠ 유리(琉璃)에 차고 슬픈 것이 어린거린다.");
      expect(verified.question.question).toContain("열없이 붙어서서 입김을 흐리우니");
      expect(verified.question.question).toContain("길들은 양 언 날개를 파다거린다.");
      expect(verified.question.question).toContain("아아, 너는 산(山)ㅅ새처럼 날러갔구나!");
      expect(verified.question.question).toContain("푸른 날개를 마악 펴들고 있다");
      expect(verified.classification).toEqual(expect.objectContaining({
        key: "16:43",
        decision: "accept",
        canonical_subject: "korean_literature",
        transcription_status: "exact",
      }));
      const problemPath = join(row.stateDir, row.adjudicated.evidence.problemArtifact.path);
      const problemBytes = readFileSync(problemPath);
      writeFileSync(problemPath, Buffer.concat([problemBytes, Buffer.from("tampered")]));
      expect(() => verify()).toThrow(/hash mismatch/u);
      writeFileSync(problemPath, problemBytes);
    } finally {
      providerMock.complete.mockReset();
      rmSync(row.stateDir, { recursive: true, force: true });
    }
  }, 180_000);

  it.skipIf(!existsSync(join(Q30_MANUAL_STATE, "problem.pdf")))(
    "mirrors and verifies the exact 5578421 Q38 shared-passage authority",
    async () => {
    expect(problemManualAdjudicationAllowlistForTest()).toEqual(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST);
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST).toHaveLength(75);
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 54)))
      .toBe("3f9a653666b0b3b9e3d61ee0ce29700cd68f86ea98ca148a8280a22d9ec95769");
    expect(manualAdjudicationAllowlistFingerprint())
      .toBe("c2d72629f59f1bf4b0c4f8651deb80284e56002eadbd4a395dcfb926172ceaa2");
    expect({
      rowHash: canonicalEvidenceHash(Q38_5578421_MANUAL_SPEC),
      replacementsHash: canonicalEvidenceHash(Q38_5578421_MANUAL_SPEC.replacements),
      parentRecoveryEvidenceHash: Q38_5578421_MANUAL_SPEC.parentRecoveryEvidenceHash,
    }).toEqual({
      rowHash: "3616144e39fa2ca271a7bb4798e537f896de4f350db7faf9251c3fe4d67f0ca2",
      replacementsHash: "35cbba8850e38a3823ce8fc7b5277d410c7db6842c1097c1fc74980014267dc9",
      parentRecoveryEvidenceHash: "fcedb565f4bb9c107733c378cef32039e458be2f33ee8ce3071eaff8297593b2",
    });
    const row = await q38ManualAuthorityFixture5578421();
    const verify = () => withOnlyManualArtifactsForKey(
      row.stateDir,
      row.spec.key,
      () => verifyProblemManualAdjudicationForTest({
        stateDir: row.stateDir,
        entry: row.input.entry,
        problemEvidence: row.input.problem,
        parentRecovery: row.parent as unknown as Record<string, unknown>,
        failedQuestion: row.failed.question,
        failedClassification: row.failed.classification,
        manualAdjudication: row.adjudicated.evidence,
      }),
    ) as { question: QuizItemEx; classification: ClassificationDecision };
    try {
      const verified = verify();
      expect(canonicalEvidenceHash(verified.question))
        .toBe("65b5123c09f1be751e46472803126fbb2f8243c433ac761fb3f7ebc60e302ee2");
      expect(verified.question.question).toContain("[37 ~ 42] 다음 글을 읽고 물음에 답하시오.");
      expect(verified.question.question).toContain("항려(巷閭)");
      expect(verified.question.question).not.toContain("향려(若閭)");
      expect(verified.classification).toEqual(expect.objectContaining({
        key: "15:38",
        decision: "accept",
        canonical_subject: "korean_literature",
        transcription_status: "exact",
      }));
      const problemPath = join(row.stateDir, row.adjudicated.evidence.problemArtifact.path);
      const problemBytes = readFileSync(problemPath);
      writeFileSync(problemPath, Buffer.concat([problemBytes, Buffer.from("tampered")]));
      expect(() => verify()).toThrow(/hash mismatch/u);
      writeFileSync(problemPath, problemBytes);
    } finally {
      providerMock.complete.mockReset();
      rmSync(row.stateDir, { recursive: true, force: true });
    }
  }, 180_000);

  it.skipIf(
    !existsSync(join(Q27_MANUAL_STATE, "problem.pdf"))
      || !existsSync(join(Q27_MANUAL_STATE, "solution.pdf")),
  )("verifies the exact Q8/Q16 manual pair while Q15 remains normal exact rejection authority", async () => {
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 29)))
      .toBe("0b5d7d19255cd91566a55b289b11f8a9460a3014a06f255f9a266ebd62980cf9");
    expect(manualAdjudicationAllowlistFingerprint())
      .toBe(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST));
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 11)))
      .toBe("7851318ea1e176be603db1f2679081e16ef222d90ff704e39dce8d47db446268");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 13)))
      .toBe("fe8516451df56c3030a821886a42a93d1fa88dc87529060bd608f835bc0dc990");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 15)))
      .toBe("219a859d0ab52014822efa602cc0e090f5d0f31551502386d8ab6e775ed7c53a");
    const expectedRows = new Map([
      ["4:8", {
        row: "106ddb3c73dd5a2f12005c1bfe51eaa15830a89ee8dabaa82f14fe3ef5384cdf",
        spec: "764545d31c96a9bf525791206c81b136b74f07ffb9b974fe1e9e6a1e27a8a79a",
        item: "e5e1b8c0afdb43aa2bf537c2ecfb0b60b770979c8522c692db09002c3cf4680d",
      }],
      ["6:16", {
        row: "9e0a7e81200e3187cf951dbc22282237166d897a7ff9eb2b5c69aaff726b1d0c",
        spec: "a4e52e1bf05c24a3aca3bea7ed81b74031c9b8017067074091b17702e31ad8da",
        item: "dd277b1ef288b108943920a59656bc3bc8c68f23c0cfad64296753248d375ea1",
      }],
    ]);
    for (const spec of Q8_Q16_MANUAL_SPECS) {
      expect(canonicalEvidenceHash(spec)).toBe(expectedRows.get(spec.key)!.row);
    }
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.some((spec) =>
      spec.entryId === "ebsi:5525982" && spec.key === "6:15")).toBe(false);

    const rows = await q8Q16ManualAuthorityFixture();
    const verify = (
      row: (typeof rows)[number],
      manualAdjudication: unknown = row.adjudicated.evidence,
      parentRecovery: Record<string, unknown> = row.parent as unknown as Record<string, unknown>,
      failedClassification: unknown = row.failed.classification,
    ) => withOnlyManualArtifactsForKey(row.stateDir, row.spec.key, () =>
      verifyProblemManualAdjudicationForTest({
        stateDir: row.stateDir,
        entry: row.input.entry,
        problemEvidence: row.input.problem,
        parentRecovery,
        failedQuestion: row.failed.question,
        failedClassification,
        manualAdjudication,
      }));

    try {
      for (const row of rows) {
        expect(row.failed.classification.transcription_status).toBe("mismatch");
        const verified = verify(row) as {
          question: QuizItemEx;
          classification: ClassificationDecision;
          evidence: Record<string, any>;
        };
        expect(canonicalEvidenceHash(verified.question)).toBe(expectedRows.get(row.spec.key)!.item);
        expect(verified.evidence).toMatchObject({
          allowlistId: row.spec.allowlistId,
          parentRecoveryEvidenceHash: row.spec.parentRecoveryEvidenceHash,
          correctionSpecHash: expectedRows.get(row.spec.key)!.spec,
          problemArtifactItemHash: expectedRows.get(row.spec.key)!.item,
        });
        expect(verified.classification).toMatchObject({
          key: row.spec.key,
          decision: row.spec.expectedDecision,
          canonical_subject: row.spec.expectedCanonicalSubject ?? null,
          transcription_status: "exact",
        });
      }

      const q8 = verify(rows[0]) as { question: QuizItemEx; classification: ClassificationDecision };
      expect(q8.question.question).toContain("[6 ~ 8] 다음을 읽고 물음에 답하시오.");
      expect(q8.question.question).toContain("기사형 광고는 기사처럼 보이는 광고를 말한다.");
      expect(q8.question.figure).toBe(true);
      expect(q8.question.figure_description).toContain("오른쪽으로 열린 세로 묶음 괄호가 정확히 두 개");
      expect(q8.classification).toMatchObject({ decision: "reject", canonical_subject: null });

      const q16 = verify(rows[1]) as { question: QuizItemEx; classification: ClassificationDecision };
      expect(q16.question.question).toContain("[16 ~ 20] 다음 글을 읽고 물음에 답하시오.");
      expect(q16.question.question).toContain("논리학 지식처럼");
      expect(q16.question.question).toContain("㉢ 도달한다");
      expect(q16.question.question).toContain("선택하겠지만 실용적 필요");
      expect(q16.classification).toMatchObject({
        decision: "accept",
        canonical_subject: "korean_reading",
      });

      expect(() => verify(rows[0], rows[1].adjudicated.evidence))
        .toThrow(/allowlist\/parent authority/u);
      expect(() => verify(rows[1], rows[1].adjudicated.evidence,
        rows[0].parent as unknown as Record<string, unknown>))
        .toThrow(/allowlist\/parent authority/u);

      const wrongStatus = structuredClone(rows[0].failed.classification);
      wrongStatus.transcription_status = "exact";
      expect(() => verify(rows[0], rows[0].adjudicated.evidence,
        rows[0].parent as unknown as Record<string, unknown>, wrongStatus))
        .toThrow(/allowlisted exhausted recovery status/u);

      const missingPath = join(rows[1].stateDir, rows[1].adjudicated.evidence.classificationArtifact.path);
      const missingBytes = readFileSync(missingPath);
      rmSync(missingPath);
      expect(() => verify(rows[1])).toThrow();
      writeFileSync(missingPath, missingBytes);

      const cropPath = join(rows[0].stateDir, rows[0].adjudicated.evidence.cropViews[0].artifact.path);
      const cropBytes = readFileSync(cropPath);
      writeFileSync(cropPath, Buffer.concat([cropBytes, Buffer.from("tampered")]));
      expect(() => verify(rows[0])).toThrow(/hash mismatch/u);
      writeFileSync(cropPath, cropBytes);

      withOnlyManualArtifactsForKey(rows[0].stateDir, rows[0].spec.key, () => {
        const orphanPath = join(
          rows[0].stateDir,
          "classification-manual-adjudications",
          `v1-0004-0008-${"1".repeat(64)}-${DIGEST}.json`,
        );
        writeJson(orphanPath, {});
        try {
          expect(() => verifyProblemManualAdjudicationForTest({
            stateDir: rows[0].stateDir,
            entry: rows[0].input.entry,
            problemEvidence: rows[0].input.problem,
            parentRecovery: rows[0].parent as unknown as Record<string, unknown>,
            failedQuestion: rows[0].failed.question,
            failedClassification: rows[0].failed.classification,
            manualAdjudication: rows[0].adjudicated.evidence,
          })).toThrow(/not declared/u);
        } finally {
          rmSync(orphanPath);
        }
      });

      const q15Problem = readdirSync(join(rows[0].stateDir, "problem-recoveries"))
        .find((name) => name.startsWith("v1-0006-0015-"))!;
      const q15 = JSON.parse(readFileSync(join(rows[0].stateDir, "problem-recoveries", q15Problem), "utf8"));
      expect(() => applyAllowlistedProblemManualCorrection(
        rows[0].input.entry.id,
        rows[0].input.problem.sha256,
        q15.item,
      )).toThrow(/allowlist/u);
      expect(readdirSync(join(rows[0].stateDir, "problem-manual-adjudications"))
        .some((name) => name.includes("-0015-"))).toBe(false);
      expect(existsSync(join(rows[0].stateDir, "answer-audit"))).toBe(false);
      expect(existsSync(join(rows[0].stateDir, "answer-attestation"))).toBe(false);
    } finally {
      providerMock.complete.mockReset();
      rmSync(rows[0].stateDir, { recursive: true, force: true });
    }
  }, 180_000);

  it.skipIf(
    !existsSync(join(Q27_MANUAL_STATE, "problem.pdf"))
      || !existsSync(join(Q27_MANUAL_STATE, "solution.pdf")),
  )("verifies the Q17-Q20 manual group including exact-parent Q18/Q19", async () => {
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 29)))
      .toBe("0b5d7d19255cd91566a55b289b11f8a9460a3014a06f255f9a266ebd62980cf9");
    expect(manualAdjudicationAllowlistFingerprint())
      .toBe(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST));
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 13)))
      .toBe("fe8516451df56c3030a821886a42a93d1fa88dc87529060bd608f835bc0dc990");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 15)))
      .toBe("219a859d0ab52014822efa602cc0e090f5d0f31551502386d8ab6e775ed7c53a");
    const expectedRows = new Map([
      ["7:17", {
        row: "3b387191b6f43e3d83babbf0068ce1fb3a9e52bd3c9ba7f835964ee543facb64",
        spec: "7bdf1e88f8f56e2c1a581afa6bd529a8dea7f43bd7a56e94125fa482c209fe96",
        item: "3d94de928dd1b8d443edcc908486bc81af356e352ea7edea32ee1f43166ef0be",
        lastCropHash: "b69ac51723f8e8e62ac7fa4f0404e522ed15a818eab2074ea70c450d11da85dd",
        lastCropHeight: 2680,
      }],
      ["7:18", {
        row: "27f57efde1618ebb4403d334979d92d525b274e891d5be9c6f87b1299c9a0628",
        spec: "80eee1c931712b65b213f571ab79bd970149f07e9f8e5767e3d30df4887b57f9",
        item: "e6f77c8aa3a10c5549e95eb6d3b3974587b2b3a16db009fb483ad9099943417f",
        lastCropHash: "e72ccd39610a51f98718e7b542d3c5d91f9354f1eb10b53d39ca6af88ac0d525",
        lastCropHeight: 2085,
      }],
      ["7:19", {
        row: "a694fcf5c3308d1b4b4938cbae48325ad675722cb4e467ed0c39188b99632c7a",
        spec: "0d55ad6fb87a5f46af1ffe17ec187fbb2e611b150b12c05621011b2ce875f918",
        item: "64e29a3f28bad8602f35bcbf89542202e7b5cc4a587ed586474626a0085090d4",
        lastCropHash: "abd329f03c55a66e582ca236eeba453f7c214315abefb41fdbd5dd36cab7f9a9",
        lastCropHeight: 2382,
      }],
      ["7:20", {
        row: "4aad2f6a1d34af97338b72d86559472a0de7c6641d7ef643aae7819a1f0c232b",
        spec: "2fa15fb8b4490a51b19e8c1a71591694d9049cecb83b5cf952b858633b5d76d5",
        item: "1106e5ec6656305c38b4b58770b4acfa0e3e7a6a6d2ee412d10e86e8b99f75c0",
        lastCropHash: "082e73f5f9917837562c97b338381be35acf16a6501a8fe510ec8827a3063211",
        lastCropHeight: 894,
      }],
    ]);
    for (const spec of Q17_Q20_MANUAL_SPECS) {
      expect(canonicalEvidenceHash(spec)).toBe(expectedRows.get(spec.key)!.row);
    }
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 26)))
      .toBe("4d844c71cc01ae752974edb5941ed475d80e76dd03bb5ee1a51a7b256512bb80");

    const rows = await q17Q20ManualAuthorityFixture();
    const verify = (
      row: (typeof rows)[number],
      manualAdjudication: unknown = row.adjudicated.evidence,
      parentRecovery: Record<string, unknown> = row.parent as unknown as Record<string, unknown>,
      failedClassification: unknown = row.failed.classification,
    ) => withOnlyManualArtifactsForKey(row.stateDir, row.spec.key, () =>
      verifyProblemManualAdjudicationForTest({
        stateDir: row.stateDir,
        entry: row.input.entry,
        problemEvidence: row.input.problem,
        parentRecovery,
        failedQuestion: row.failed.question,
        failedClassification,
        manualAdjudication,
      }));

    try {
      for (const row of rows) {
        const expected = expectedRows.get(row.spec.key)!;
        expect(row.failed.classification.transcription_status)
          .toBe(row.spec.failedStatus === "exact" ? "exact" : "mismatch");
        const verified = verify(row) as {
          question: QuizItemEx;
          classification: ClassificationDecision;
          evidence: Record<string, any>;
        };
        expect(canonicalEvidenceHash(verified.question)).toBe(expected.item);
        expect(verified.evidence).toMatchObject({
          allowlistId: row.spec.allowlistId,
          parentRecoveryEvidenceHash: row.spec.parentRecoveryEvidenceHash,
          correctionSpecHash: expected.spec,
          problemArtifactItemHash: expected.item,
        });
        expect(verified.evidence.cropViews.map((view: { pixelSha256: string }) => view.pixelSha256)).toEqual([
          "af81d940bb74a611b249ff861be8a8e95eaa719f8a1978258f37e37ffd3d347e",
          "c52268ed7672f99284b07b36a6bfc7375d5cb203a651c0fa90a25edd06e353d1",
          "3ddfb710dfa5d8576496b6b37d43c90e53b2eab196db181439f60343e7da6d95",
          expected.lastCropHash,
        ]);
        expect(verified.evidence.cropViews[3]).toMatchObject({
          pixelWidth: 3018,
          pixelHeight: expected.lastCropHeight,
        });
        expect(verified.classification).toMatchObject({
          key: row.spec.key,
          decision: "accept",
          canonical_subject: "korean_reading",
          transcription_status: "exact",
        });
      }

      const q17 = verify(rows[0]) as { question: QuizItemEx };
      expect(q17.question.question).toContain("[16 ~ 20] 다음 글을 읽고 물음에 답하시오.");
      expect(q17.question.question.match(/논리학 지식/gu)).toHaveLength(3);
      expect(q17.question.question).toContain("경험을 통한 시험의 대상");
      expect(q17.question.question).toContain("이 둘을 서로 대체하더라도");
      expect(q17.question.question).toContain("선택하겠지만 실용적 필요");
      expect(q17.question.choices?.[2]).toContain("근본적으로 다르다고 한다.");

      const q20Row = rows.find((row) => row.spec.key === "7:20")!;
      const q20 = verify(q20Row) as { question: QuizItemEx };
      expect(q20.question.question).toContain("[16 ~ 20] 다음 글을 읽고 물음에 답하시오.");
      expect(q20.question.question).toContain("문맥상 ㉢과 바꿔 쓰기에 가장 적절한 것은?");
      expect(q20.question.answer).toBe(q20Row.failed.question.answer);
      expect(q20.question.choices).toEqual(q20Row.failed.question.choices);

      const q18Row = rows.find((row) => row.spec.key === "7:18")!;
      const q19Row = rows.find((row) => row.spec.key === "7:19")!;
      expect((verify(q18Row) as { question: QuizItemEx }).question.question)
        .toContain("㉢ 도달한다");
      expect((verify(q19Row) as { question: QuizItemEx }).question.question)
        .toContain("선택하겠지만 실용적 필요");

      expect(() => verify(rows[0], rows[1].adjudicated.evidence))
        .toThrow(/allowlist\/parent authority/u);
      expect(() => verify(rows[1], rows[1].adjudicated.evidence,
        rows[0].parent as unknown as Record<string, unknown>))
        .toThrow(/allowlist\/parent authority/u);

      const wrongStatus = structuredClone(rows[0].failed.classification);
      wrongStatus.transcription_status = "exact";
      expect(() => verify(rows[0], rows[0].adjudicated.evidence,
        rows[0].parent as unknown as Record<string, unknown>, wrongStatus))
        .toThrow(/allowlisted exhausted recovery status/u);

      const exactWrongStatus = structuredClone(q18Row.failed.classification);
      exactWrongStatus.transcription_status = "mismatch";
      expect(() => verify(q18Row, q18Row.adjudicated.evidence,
        q18Row.parent as unknown as Record<string, unknown>, exactWrongStatus))
        .toThrow(/allowlisted exhausted recovery status/u);

      const missingPath = join(rows[1].stateDir, rows[1].adjudicated.evidence.classificationArtifact.path);
      const missingBytes = readFileSync(missingPath);
      rmSync(missingPath);
      expect(() => verify(rows[1])).toThrow();
      writeFileSync(missingPath, missingBytes);

      const cropPath = join(rows[0].stateDir, rows[0].adjudicated.evidence.cropViews[3].artifact.path);
      const cropBytes = readFileSync(cropPath);
      writeFileSync(cropPath, Buffer.concat([cropBytes, Buffer.from("tampered")]));
      expect(() => verify(rows[0])).toThrow(/hash mismatch/u);
      writeFileSync(cropPath, cropBytes);

      withOnlyManualArtifactsForKey(rows[0].stateDir, rows[0].spec.key, () => {
        const orphanPath = join(
          rows[0].stateDir,
          "classification-manual-adjudications",
          `v1-0007-0017-${"1".repeat(64)}-${DIGEST}.json`,
        );
        writeJson(orphanPath, {});
        try {
          expect(() => verifyProblemManualAdjudicationForTest({
            stateDir: rows[0].stateDir,
            entry: rows[0].input.entry,
            problemEvidence: rows[0].input.problem,
            parentRecovery: rows[0].parent as unknown as Record<string, unknown>,
            failedQuestion: rows[0].failed.question,
            failedClassification: rows[0].failed.classification,
            manualAdjudication: rows[0].adjudicated.evidence,
          })).toThrow(/not declared/u);
        } finally {
          rmSync(orphanPath);
        }
      });

      expect(readdirSync(join(rows[0].stateDir, "problem-manual-adjudications"))
        .some((name) => name.includes("-0023-"))).toBe(false);
      expect(existsSync(join(rows[0].stateDir, "answer-audit"))).toBe(false);
      expect(existsSync(join(rows[0].stateDir, "answer-attestation"))).toBe(false);
    } finally {
      providerMock.complete.mockReset();
      rmSync(rows[0].stateDir, { recursive: true, force: true });
    }
  }, 180_000);

  it.skipIf(
    !existsSync(join(Q27_MANUAL_STATE, "problem.pdf"))
      || !existsSync(join(Q27_MANUAL_STATE, "solution.pdf")),
  )("verifies the exact Q23/Q28/Q29 manual triple without crossing the Q31/Q42 boundary", async () => {
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 29)))
      .toBe("0b5d7d19255cd91566a55b289b11f8a9460a3014a06f255f9a266ebd62980cf9");
    expect(manualAdjudicationAllowlistFingerprint())
      .toBe(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST));
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 15)))
      .toBe("219a859d0ab52014822efa602cc0e090f5d0f31551502386d8ab6e775ed7c53a");
    const expectedRows = new Map([
      ["9:23", {
        row: "6be4f4fbb1848c327beb38415b8d2faf0193bbad4ae9e31d286803096862e540",
        spec: "96368c6e161643bdfcfaef63e14ce6cbb3fc183fe32709ca746a018a4132a8bb",
        item: "e4886fd0c2386eba4d4f84d0ef6f1954fc92b8d3a5ddfe99788d533f69f8cb56",
        cropHashes: [
          "c4a3f7ada8aba20a634c7859328d22cab7bd6cb60df921d3b76423b3a45c91a2",
          "689ecb925a36bce576051f72a82ba52392eaebb18ead1b303c7eab65d658f737",
          "9d7b19a1c3201d7aafa074faa0ee73d65639afa846d7065116df7ab21f0f2dc9",
        ],
        lastSize: [3159, 2184],
      }],
      ["11:28", {
        row: "b82020b2dd5fae081a3031887b345b337b5860156b75d6d7ce6137eb7bf40beb",
        spec: "53f4829e4f8279336872abe5d140e75463121cf664b3c0afe35c465a55ace04d",
        item: "a15e214e36dd59e6275e46afcb15b84b13102a55c3545dd0d25eeedfd94bb86e",
        cropHashes: [
          "5292aacb2170ebb8ae9c70ba089bce6ce689ff9276e9d997b0f3d16c3cb3d665",
          "c534698ffb42c13ef9642bdd930e2b7ddd8b54c907bed0a5dd69ed960d7013e6",
          "581577c6aba6368e2e807d3491debc8bda2c27e4e891a734a374077ba9909376",
          "f4a0912b56ff5f19180cd6701e1b9e8a1760903869fa5284ba364f854d0587e0",
          "bcf9877f718ffb78a638ccde04f1525ae15d15dd0d948790344d6d7e22ea23fb",
        ],
        lastSize: [3159, 3970],
      }],
      ["11:29", {
        row: "fb9f306bf484870e7a355e6bd59dae03430d12c855acda631d8f7a191e74ef60",
        spec: "1fe98d0353b33fd15520a9c62f7ab18572716044597cc731bcc227cb0a9dfc20",
        item: "573a51fae9eb3e4c5ea2aa6697fcf5ad01e0aa4826645865d2e5b012416e1618",
        cropHashes: [
          "5292aacb2170ebb8ae9c70ba089bce6ce689ff9276e9d997b0f3d16c3cb3d665",
          "c534698ffb42c13ef9642bdd930e2b7ddd8b54c907bed0a5dd69ed960d7013e6",
          "581577c6aba6368e2e807d3491debc8bda2c27e4e891a734a374077ba9909376",
          "f4a0912b56ff5f19180cd6701e1b9e8a1760903869fa5284ba364f854d0587e0",
          "31dd633179ce6373e82db5ef005052dd994d72cf0651b1b543873530b3ba952f",
        ],
        lastSize: [3159, 2382],
      }],
    ]);
    for (const spec of Q23_Q29_MANUAL_SPECS) {
      expect(canonicalEvidenceHash(spec)).toBe(expectedRows.get(spec.key)!.row);
    }
    const exactSiblingKeys = ["9:21", "9:22", "9:24", "9:25", "9:26"];
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.filter((spec) =>
      spec.entryId === "ebsi:5525982" && exactSiblingKeys.includes(spec.key)).map((spec) => spec.key))
      .toEqual(exactSiblingKeys);

    const rows = await q23Q29ManualAuthorityFixture();
    expect(exactSiblingKeys.every((key) => !readdirSync(
      join(rows[0].stateDir, "problem-manual-adjudications"),
    ).some((name) => name.includes(`-${key.split(":")[1]!.padStart(4, "0")}-`)))).toBe(true);
    const verify = (
      row: (typeof rows)[number],
      manualAdjudication: unknown = row.adjudicated.evidence,
      parentRecovery: Record<string, unknown> = row.parent as unknown as Record<string, unknown>,
      failedClassification: unknown = row.failed.classification,
    ) => withOnlyManualArtifactsForKey(row.stateDir, row.spec.key, () =>
      verifyProblemManualAdjudicationForTest({
        stateDir: row.stateDir,
        entry: row.input.entry,
        problemEvidence: row.input.problem,
        parentRecovery,
        failedQuestion: row.failed.question,
        failedClassification,
        manualAdjudication,
      }));

    try {
      for (const row of rows) {
        const expected = expectedRows.get(row.spec.key)!;
        expect(row.failed.classification.transcription_status).toBe("mismatch");
        const verified = verify(row) as {
          question: QuizItemEx;
          classification: ClassificationDecision;
          evidence: Record<string, any>;
        };
        expect(canonicalEvidenceHash(verified.question)).toBe(expected.item);
        expect(verified.evidence).toMatchObject({
          allowlistId: row.spec.allowlistId,
          parentRecoveryEvidenceHash: row.spec.parentRecoveryEvidenceHash,
          correctionSpecHash: expected.spec,
          problemArtifactItemHash: expected.item,
        });
        expect(verified.evidence.cropViews.map((view: { pixelSha256: string }) => view.pixelSha256))
          .toEqual(expected.cropHashes);
        expect(verified.evidence.cropViews.at(-1)).toMatchObject({
          pixelWidth: expected.lastSize[0],
          pixelHeight: expected.lastSize[1],
        });
        expect(verified.classification).toMatchObject({
          key: row.spec.key,
          decision: "accept",
          canonical_subject: "korean_literature",
          curriculum_course: "문학",
          transcription_status: "exact",
        });
      }

      const q23 = verify(rows[0]) as { question: QuizItemEx };
      expect(q23.question.question).toContain("[21 ~ 26] 다음 글을 읽고 물음에 답하시오.");
      expect(q23.question.question).toContain("외적의 침략");
      expect(q23.question.question).toContain("박씨가 주렴을 드리우고");
      expect(q23.question.question).toContain("“애기 엄마…….”");
      expect(q23.question.figure).toBe(false);

      const q28 = verify(rows[1]) as { question: QuizItemEx };
      expect(q28.question.question).toContain("[27 ~ 32] 다음 글을 읽고 물음에 답하시오.");
      expect(q28.question.question).toContain("이다지 낡아빠진 생활을 하는 것은 아니리라");
      expect(q28.question.question).toContain("함이정 : 처녀 때 난 생각했었지.");
      expect(q28.question.figure_description).toContain("왼쪽으로 열린 세로 묶음 괄호 [A]");

      const q29 = verify(rows[2]) as { question: QuizItemEx };
      expect(q29.question.question).toContain("29. [A]와 [B]에 대한 설명으로 가장 적절한 것은?");
      expect(q29.question.choices?.[4]).toContain("반어적으로 표현함으로써");
      expect(q29.question.choices?.[4]).toContain("심리적 상황을 드러내고 있다.");

      expect(() => verify(rows[0], rows[1].adjudicated.evidence))
        .toThrow(/allowlist\/parent authority/u);
      expect(() => verify(rows[2], rows[2].adjudicated.evidence,
        rows[0].parent as unknown as Record<string, unknown>))
        .toThrow(/allowlist\/parent authority/u);

      const wrongStatus = structuredClone(rows[0].failed.classification);
      wrongStatus.transcription_status = "exact";
      expect(() => verify(rows[0], rows[0].adjudicated.evidence,
        rows[0].parent as unknown as Record<string, unknown>, wrongStatus))
        .toThrow(/allowlisted exhausted recovery status/u);

      const missingPath = join(rows[2].stateDir, rows[2].adjudicated.evidence.classificationArtifact.path);
      const missingBytes = readFileSync(missingPath);
      rmSync(missingPath);
      expect(() => verify(rows[2])).toThrow();
      writeFileSync(missingPath, missingBytes);

      const cropPath = join(rows[1].stateDir, rows[1].adjudicated.evidence.cropViews.at(-1)!.artifact.path);
      const cropBytes = readFileSync(cropPath);
      writeFileSync(cropPath, Buffer.concat([cropBytes, Buffer.from("tampered")]));
      expect(() => verify(rows[1])).toThrow(/hash mismatch/u);
      writeFileSync(cropPath, cropBytes);

      withOnlyManualArtifactsForKey(rows[0].stateDir, rows[0].spec.key, () => {
        const orphanPath = join(
          rows[0].stateDir,
          "classification-manual-adjudications",
          `v1-0009-0023-${"1".repeat(64)}-${DIGEST}.json`,
        );
        writeJson(orphanPath, {});
        try {
          expect(() => verifyProblemManualAdjudicationForTest({
            stateDir: rows[0].stateDir,
            entry: rows[0].input.entry,
            problemEvidence: rows[0].input.problem,
            parentRecovery: rows[0].parent as unknown as Record<string, unknown>,
            failedQuestion: rows[0].failed.question,
            failedClassification: rows[0].failed.classification,
            manualAdjudication: rows[0].adjudicated.evidence,
          })).toThrow(/not declared/u);
        } finally {
          rmSync(orphanPath);
        }
      });

      const revisionPath = join(
        rows[0].stateDir,
        (rows[0].parent.baseClassificationRevisionArtifact as { path: string }).path,
      );
      const revisionItems = JSON.parse(readFileSync(revisionPath, "utf8")).items as ClassificationDecision[];
      for (const key of exactSiblingKeys) {
        expect(revisionItems.find((item) => item.key === key)?.transcription_status).toBe("exact");
        const number = key.split(":")[1]!.padStart(4, "0");
        expect(readdirSync(join(rows[0].stateDir, "problem-manual-adjudications"))
          .some((name) => name.includes(`-${number}-`))).toBe(false);
      }
      for (const key of ["12:31", "15:42"]) {
        expect(revisionItems.find((item) => item.key === key)?.transcription_status).toBe("mismatch");
        expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.some((spec) =>
          spec.entryId === "ebsi:5525982" && spec.key === key)).toBe(true);
        const number = key.split(":")[1]!.padStart(4, "0");
        expect(readdirSync(join(rows[0].stateDir, "problem-manual-adjudications"))
          .some((name) => name.includes(`-${number}-`))).toBe(false);
      }
      expect(existsSync(join(rows[0].stateDir, "answer-audit"))).toBe(false);
      expect(existsSync(join(rows[0].stateDir, "answer-attestation"))).toBe(false);
    } finally {
      providerMock.complete.mockReset();
      rmSync(rows[0].stateDir, { recursive: true, force: true });
    }
  }, 180_000);

  it.skipIf(
    !existsSync(join(Q27_MANUAL_STATE, "problem.pdf"))
      || !existsSync(join(Q27_MANUAL_STATE, "solution.pdf"))
      || !existsSync(Q32_PARENT_MANUAL_CLASSIFICATION_PATH),
  )("verifies the final Q30-Q42 manual groups before the fresh terminal input", async () => {
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 29)))
      .toBe("0b5d7d19255cd91566a55b289b11f8a9460a3014a06f255f9a266ebd62980cf9");
    expect(manualAdjudicationAllowlistFingerprint())
      .toBe(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST));
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 18)))
      .toBe("463fceef246487e1ec791ffb0489048f874cd5944d946f9c6d819f3fd3c76eda");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 26)))
      .toBe("4d844c71cc01ae752974edb5941ed475d80e76dd03bb5ee1a51a7b256512bb80");
    expect(manualRevisionAllowlistFingerprint())
      .toBe(canonicalEvidenceHash(PROBLEM_MANUAL_REVISION_ALLOWLIST));
    expect(manualSourceRevisionAllowlistFingerprint())
      .toBe("aca473b2b0a319390e5e6ce18d9a18149f68d5bc53fa27a86e8dac7b6ae94a9c");
    expect(manualSourceRevisionAllowlistFingerprint())
      .toBe(canonicalEvidenceHash(PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST));
    expect(canonicalEvidenceHash(Q32_MANUAL_SOURCE_REVISION_SPEC))
      .toBe("e6287eb8f4eaef8f24099c08afc13d077ad7792a1345f0296b7ce39fa4b07d39");
    expect(PROBLEM_MANUAL_SOURCE_REVISION_PROMPT_DIGEST)
      .toBe("8000e31577ac3001eaaaef243ba7ada2eb951cf28296763eef061b39f69465cf");
    expect(PROBLEM_MANUAL_SOURCE_REVISION_CORRECTION_DIGEST)
      .toBe("3d9f532d3bf7ba98cadf8697ba32a9feaa43104e5270e4d900349d23ba581036");
    expect(canonicalEvidenceHash(Q32_MANUAL_REVISION_SPEC))
      .toBe("465a68f6f512ddc4e288552122287f9772ce3bddf63099b776dc5ab47663c943");
    expect(Q30_Q42_MANUAL_GROUPS.map((group) => [...group])).toEqual([
      ["11:30"],
      ["12:31", "12:32"],
      ["14:37"],
      ["15:38", "15:39", "15:40", "15:41", "15:42"],
    ]);
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
    const expected = new Map([
      ["11:30", {
        row: "0d5d73306f77fc61f30ccde3e970f80499e4db7be3fbefc646350170cde9696e",
        spec: "dd55aabf3be8fd6f23043a29e4b9032734bb6b5edbe551745a6de88e4088225e",
        item: "e6e694a660190ad645dcd3cbaf1549281bdd056c04802907c04db2c061784897",
        status: "exact", subject: "korean_literature", course: "문학",
        crops: [...literatureViews, "7d92443eaa6f0ac4f34a537e127ca54b55fb968bf64fa5cfc7bb5f777df4646c"],
      }],
      ["12:31", {
        row: "a68cbd6c6b2c4f27f2db4784b2b15a1e45f2255a764a2df7b48840514bf4abd4",
        spec: "cc956ab4878e26788b2892f9a98d6b473bceaae9589207ba542c6f07311cf5c5",
        item: "5ab49dec77f4e47ae71671c2ebd38e16a1e387cece768bbdd45ace55cde2f6fa",
        status: "mismatch", subject: "korean_literature", course: "문학",
        crops: [...literatureViews, "763af66685e7abed5840a675c484ffd1cef68207475c3b12f77c8498b00bbfc6"],
      }],
      ["12:32", {
        row: "974562dc407ca854aebb49fb2fe9a56df97383a9f44407bd54ae949d2a85a796",
        spec: "b83d9d387214b64ec20bc885e5159f1afdf3b110c11d8c09c4aa65aa3b09e740",
        item: "e3f26787b00f65c346910a688088f941dce1b8b872e330491da0b61a8e3f5269",
        finalItem: "e3f26787b00f65c346910a688088f941dce1b8b872e330491da0b61a8e3f5269",
        status: "mismatch", subject: "korean_literature", course: "문학",
        crops: [...literatureViews, "3ceee6f7e00d9030cc8bc8b972b0660dd0aa4abad1bd610ca5b3ae9588cdbc33"],
      }],
      ["14:37", {
        row: "3002ecd3c82d2ee9e4927228ef082c58e317c88a103f0cf2d29317848813006c",
        spec: "2fedd6fd825dc06bc5c64c0ec8dc369d9cb79ffd10b348488950c18b22e1cace",
        item: "ceea23fac5375f0d514c61a3a0a49754ea67796458365b3c17de6f67ad5837fd",
        status: "exact", subject: "korean_reading", course: "독서와 작문", crops: readingViews,
      }],
      ["15:38", {
        row: "274ff9d1bab3e2b8adaaeca6a50cbd6ebab4d8efc9ce98f241531e554f5a7fbf",
        spec: "2ce1c09fd085da6830a5fc1e9498bd970e8d97457c49b4e2a8744650fc861e27",
        item: "3a84154e36d6a7a703afecb37e7e090e46ea5c9b6aa6cf6235d96718a4416c57",
        status: "mismatch", subject: "korean_reading", course: "독서와 작문",
        crops: [...readingViews, "119d571b4bf6c495fa6a8a7ad05df04a569c0fed673fc8890959a8837c80bd48"],
      }],
      ["15:39", {
        row: "a7dbfce35c74df5e429cf0acbda8289bb5210e043202eb674775d2d200e042bd",
        spec: "7653c5c625a93167dcc9289920fc9c6f1819b3885e6d5c65aa78bc8ab71885d4",
        item: "45089f6c171df3fa64b68ec782741ee58212d249566ce43837941f204e9780cf",
        status: "exact", subject: "korean_reading", course: "독서와 작문",
        crops: [...readingViews, "2a6bbacc283df55dacf030d892013dcf9c7a62fdc543f8fd58fea9d97f8575a5"],
      }],
      ["15:40", {
        row: "352f1f625a2b842cd8cfb55b3b16442aa7610cba84e9134f8cb234ecf0c20eca",
        spec: "e724b7230999c32d092bc4ccbef893ae106132b9d3d768780cc42670cc2d7bde",
        item: "b7fdf4136ce89e411f5e65c7e4cc2a98ef30ea97f3aae7d3098a9556884aed3d",
        status: "mismatch", subject: "korean_reading", course: "독서와 작문",
        crops: [...readingViews, "34a46f0aebac0098b64feb0cddf4370866945614b38483dcaaf12c97d6de1198"],
      }],
      ["15:41", {
        row: "17d17089a45be6edc291d7d5489176dcd18d00007589089db657ae618e71f593",
        spec: "244193365a2b911e6383b505abadaee0de6d374f4d9f45b11ca769685e3cb9f1",
        item: "371eba06e9adf7dec40b792dd060a10fa87237384dd6b7f20c2b4629eec8a876",
        status: "mismatch", subject: "korean_reading", course: "독서와 작문",
        crops: [...readingViews, "a0dad8b265040dcda0ac223e8382f4dd447be0a0501571d70b6b4187b060d2a5"],
      }],
      ["15:42", {
        row: "44900a00af38a5de0486bf115b0f1e928b5ee111f9df7f9ce3749b9beb416b83",
        spec: "c84aa86ee78524be5f342365eb0541461cff6ab845e0e48b0dd1a759f972a6e0",
        item: "4e708254da01f6edf7b57bde696ef5af8faec1116dfb3ebf8eb7e1a3b5daabe8",
        status: "mismatch", subject: "korean_reading", course: "독서와 작문",
        crops: [...readingViews, "4f2a482f02360ef1953238997f6ff7f6a18801f7d36b8382090b8f3ce3c634f2"],
      }],
    ]);
    for (const spec of Q30_Q42_MANUAL_SPECS) {
      expect(canonicalEvidenceHash(spec)).toBe(expected.get(spec.key)!.row);
    }

    const rows = await q30Q42ManualAuthorityFixture();
    const verify = (
      row: (typeof rows)[number],
      manualAdjudication: unknown = row.adjudicated.evidence,
      parentRecovery: Record<string, unknown> = row.parent as unknown as Record<string, unknown>,
      failedClassification: unknown = row.failed.classification,
    ) => withOnlyManualArtifactsForKey(row.stateDir, row.spec.key, () =>
      verifyProblemManualAdjudicationForTest({
        stateDir: row.stateDir,
        entry: row.input.entry,
        problemEvidence: row.input.problem,
        parentRecovery,
        failedQuestion: row.failed.question,
        failedClassification,
        manualAdjudication,
      }));

    try {
      const verifiedByKey = new Map<string, { question: QuizItemEx; classification: ClassificationDecision }>();
      for (const row of rows) {
        const pin = expected.get(row.spec.key)!;
        expect(row.failed.classification.transcription_status).toBe(pin.status);
        const verified = verify(row) as {
          question: QuizItemEx;
          classification: ClassificationDecision;
          evidence: Record<string, any>;
        };
        expect(canonicalEvidenceHash(verified.question)).toBe("finalItem" in pin ? pin.finalItem : pin.item);
        expect(verified.evidence).toMatchObject({
          allowlistId: row.spec.allowlistId,
          parentRecoveryEvidenceHash: row.spec.parentRecoveryEvidenceHash,
          correctionSpecHash: pin.spec,
          problemArtifactItemHash: pin.item,
        });
        expect(verified.evidence.cropViews.map((view: { pixelSha256: string }) => view.pixelSha256))
          .toEqual(pin.crops);
        expect(verified.classification).toMatchObject({
          key: row.spec.key,
          decision: "accept",
          canonical_subject: pin.subject,
          curriculum_course: pin.course,
          transcription_status: "exact",
        });
        verifiedByKey.set(row.spec.key, verified);
      }

      expect(verifiedByKey.get("11:30")!.question).toMatchObject({ figure: true });
      expect(verifiedByKey.get("11:30")!.question.question)
        .toContain("30. 무대 상연을 전제로 하는 희곡의 특성을");
      for (const key of ["12:31", "12:32"]) {
        expect(verifiedByKey.get(key)!.question.answer).toContain("조숭인");
        expect(verifiedByKey.get(key)!.question.answer).not.toContain("조승인");
      }
      expect(verifiedByKey.get("12:32")!.question.choices?.[1]).toContain("이야기 속의 인물들을");
      expect(verifiedByKey.get("12:32")!.question.question)
        .toContain("(서연 곁으로 가서 개울물을 바라본다.) 물 위에 비쳐 보여요");
      expect(verifiedByKey.get("12:32")!.question.question)
        .toContain("(물을 떠서 마신다.) 물이 맑고 시원해요.");
      expect(verifiedByKey.get("12:32")!.question.question).not.toContain("개울물을 바라본다). 물 위에");
      const q32Row = rows.find((row) => row.spec.key === Q32_MANUAL_REVISION_SPEC.key)!;
      expect(q32Row.adjudicated.evidence.revision).toMatchObject({
        allowlistId: Q32_MANUAL_REVISION_SPEC.allowlistId,
        parentManualEvidenceHash: "16774aa8f262afb4be3e751736789f475766364e58a4f1bcdb88f84d654bd2f8",
        correctionSpecHash: "cfb59de468a6066bf277f62f2f858f8ac00e3a04fca7856e8294b271d1c186f8",
        problemArtifact: {
          path: "problem-manual-revisions/" +
            "v1-0012-0032-e2ba87a93ce39e57d13f35edea17a11c72721b20fc0201d3dadfc466dd73801c.json",
          sha256: "61e238a6d6456ce690cd951c6a6572dc3c8b1821bb1bbbd60ae6bbdff180b85d",
        },
        problemArtifactItemHash: "e3649d8930138bdc731c8642e24507e5d98f12da8d83503877ef92c3f31981bb",
        classificationArtifact: {
          path: "classification-manual-revisions/" +
            "v1-0012-0032-e0cf084146f55db4994304b3ddb21a1a57e563ea052d32951ebd2be286c4f860-" +
            "7bb7cb863c8c4855.json",
        },
        sourceRevision: {
          allowlistId: Q32_MANUAL_SOURCE_REVISION_SPEC.allowlistId,
          parentRevisionAllowlistId: Q32_MANUAL_REVISION_SPEC.allowlistId,
          parentRevisionEvidenceHash: "944ad7e2ab07ffff727e3ac8923cfbee5b9e0499610a82eca37ccd7309c0abbd",
          correctionSpecHash: "313aa233a2d8f43d3cdc0f03fe036d72231bb16fb90275551f72b52463e34223",
          problemArtifact: {
            path: "problem-manual-second-revisions/" +
              "v1-0012-0032-e552ab3ccd06391eea7e158d8ebe790e89d43c2d948ac37ce23b2f8e26f98908.json",
            sha256: "ef11be1c9a5f89ef09b8ef5b2dc8c3c0a2c77e15235cafd5e8f72a17512aab48",
          },
          problemArtifactItemHash: "e3f26787b00f65c346910a688088f941dce1b8b872e330491da0b61a8e3f5269",
          classificationArtifact: {
            path: "classification-manual-second-revisions/" +
              "v1-0012-0032-b6ec6b2d5612e39892068bb88795cd99f41a7677a2d0a6245899f43e70d873f6-" +
              "7bb7cb863c8c4855.json",
            sha256: "aa3166e4d66c67062b2ad7242523485f55dae112ec6da4d598e39aa4a2a5e55f",
          },
          classificationArtifactItemHash:
            "bf7df2cec149ca24ef79b89754d21c4906621e4c02a2314ca215ff336be1cc47",
        },
      });
      expect(rows.find((row) => row.spec.key === "12:31")!.adjudicated.evidence.revision)
        .toBeUndefined();
      expect(verifiedByKey.get("14:37")!.question.question).toContain("이미 보험금을 지급했다면");
      expect(verifiedByKey.get("15:41")!.question.answer).toContain("고지하지 않은 중요한 사항");
      expect(verifiedByKey.get("15:41")!.question.answer).not.toContain("‘중요한 사항’");
      expect(verifiedByKey.get("15:39")!.question.question)
        .toContain("39. [가]를 바탕으로 <보기>의 상황을 이해한 내용으로 적절한 것은?");
      expect(new Set(verifiedByKey.keys()).size).toBe(9);

      expect(() => verify(rows[0], rows[3].adjudicated.evidence))
        .toThrow(/allowlist\/parent authority/u);
      expect(() => verify(rows[1], rows[1].adjudicated.evidence,
        rows[4].parent as unknown as Record<string, unknown>))
        .toThrow(/allowlist\/parent authority/u);

      const q30WrongStatus = structuredClone(rows[0].failed.classification);
      q30WrongStatus.transcription_status = "mismatch";
      expect(() => verify(rows[0], rows[0].adjudicated.evidence,
        rows[0].parent as unknown as Record<string, unknown>, q30WrongStatus))
        .toThrow(/allowlisted exhausted recovery status/u);
      const q31WrongStatus = structuredClone(rows[1].failed.classification);
      q31WrongStatus.transcription_status = "exact";
      expect(() => verify(rows[1], rows[1].adjudicated.evidence,
        rows[1].parent as unknown as Record<string, unknown>, q31WrongStatus))
        .toThrow(/allowlisted exhausted recovery status/u);

      const missingPath = join(rows[2].stateDir, rows[2].adjudicated.evidence.classificationArtifact.path);
      const missingBytes = readFileSync(missingPath);
      rmSync(missingPath);
      expect(() => verify(rows[2])).toThrow();
      writeFileSync(missingPath, missingBytes);

      const missingRevisionPath = join(
        q32Row.stateDir,
        q32Row.adjudicated.evidence.revision!.classificationArtifact.path,
      );
      const missingRevisionBytes = readFileSync(missingRevisionPath);
      rmSync(missingRevisionPath);
      expect(() => verify(q32Row)).toThrow();
      writeFileSync(missingRevisionPath, missingRevisionBytes);

      const parentTamper = structuredClone(q32Row.adjudicated.evidence) as Record<string, any>;
      parentTamper.revision.parentManualEvidenceHash = "0".repeat(64);
      expect(() => verify(q32Row, parentTamper)).toThrow(/manual revision/u);

      const sourceRevision = q32Row.adjudicated.evidence.revision!.sourceRevision!;
      const noSourceRevision = structuredClone(q32Row.adjudicated.evidence) as Record<string, any>;
      delete noSourceRevision.revision.sourceRevision;
      expect(() => verify(q32Row, noSourceRevision)).toThrow(/manual source revision evidence is missing/u);

      const sourceMetadataTamper = structuredClone(q32Row.adjudicated.evidence) as Record<string, any>;
      sourceMetadataTamper.revision.sourceRevision.parentRevisionEvidenceHash = "0".repeat(64);
      expect(() => verify(q32Row, sourceMetadataTamper)).toThrow(/manual source revision/u);

      const sourceProblemPath = join(q32Row.stateDir, sourceRevision.problemArtifact.path);
      const sourceClassificationPath = join(q32Row.stateDir, sourceRevision.classificationArtifact.path);
      const sourceProblemBytes = readFileSync(sourceProblemPath);
      const sourceClassificationBytes = readFileSync(sourceClassificationPath);
      rmSync(sourceProblemPath);
      expect(() => verify(q32Row)).toThrow(
        /ENOENT.*problem-manual-second-revisions\/v1-0012-0032-e552ab3c/u,
      );
      writeFileSync(sourceProblemPath, sourceProblemBytes);
      writeFileSync(sourceProblemPath, Buffer.concat([sourceProblemBytes, Buffer.from("tampered")]));
      expect(() => verify(q32Row)).toThrow(/hash mismatch/u);
      writeFileSync(sourceProblemPath, sourceProblemBytes);
      writeFileSync(sourceClassificationPath, Buffer.concat([
        sourceClassificationBytes,
        Buffer.from("tampered"),
      ]));
      expect(() => verify(q32Row)).toThrow(/hash mismatch/u);
      writeFileSync(sourceClassificationPath, sourceClassificationBytes);

      rmSync(sourceClassificationPath);
      expect(() => verify(q32Row)).toThrow(
        /ENOENT.*classification-manual-second-revisions\/v1-0012-0032-b6ec6b2d/u,
      );
      writeFileSync(sourceClassificationPath, sourceClassificationBytes);

      const sourceAlias = join(
        q32Row.stateDir,
        "problem-manual-second-revisions",
        `v1-0012-0032-${"1".repeat(64)}.json`,
      );
      writeJson(sourceAlias, {});
      expect(() => verify(q32Row)).toThrow(/not declared/u);
      rmSync(sourceAlias);
      symlinkSync(sourceProblemPath, sourceAlias);
      expect(() => verify(q32Row)).toThrow(/regular file/u);
      rmSync(sourceAlias);

      const sourceProblemDirectory = join(q32Row.stateDir, "problem-manual-second-revisions");
      const relocatedSourceProblemDirectory = join(q32Row.stateDir, "problem-manual-second-revisions-relocated");
      renameSync(sourceProblemDirectory, relocatedSourceProblemDirectory);
      symlinkSync(relocatedSourceProblemDirectory, sourceProblemDirectory);
      try {
        expect(() => verify(q32Row)).toThrow(/problem manual source revision must be a regular non-symlink file/u);
      } finally {
        rmSync(sourceProblemDirectory);
        renameSync(relocatedSourceProblemDirectory, sourceProblemDirectory);
      }

      const orphanRevisionPath = join(
        q32Row.stateDir,
        "problem-manual-revisions",
        `v1-0012-0032-${"1".repeat(64)}.json`,
      );
      writeJson(orphanRevisionPath, {});
      expect(() => verify(q32Row)).toThrow(/not declared/u);
      rmSync(orphanRevisionPath);

      const cropPath = join(rows[6].stateDir, rows[6].adjudicated.evidence.cropViews.at(-1)!.artifact.path);
      const cropBytes = readFileSync(cropPath);
      writeFileSync(cropPath, Buffer.concat([cropBytes, Buffer.from("tampered")]));
      expect(() => verify(rows[6])).toThrow(/hash mismatch/u);
      writeFileSync(cropPath, cropBytes);

      withOnlyManualArtifactsForKey(rows[7].stateDir, rows[7].spec.key, () => {
        const orphanPath = join(
          rows[7].stateDir,
          "classification-manual-adjudications",
          `v1-0015-0042-${"1".repeat(64)}-${DIGEST}.json`,
        );
        writeJson(orphanPath, {});
        try {
          expect(() => verifyProblemManualAdjudicationForTest({
            stateDir: rows[7].stateDir,
            entry: rows[7].input.entry,
            problemEvidence: rows[7].input.problem,
            parentRecovery: rows[7].parent as unknown as Record<string, unknown>,
            failedQuestion: rows[7].failed.question,
            failedClassification: rows[7].failed.classification,
            manualAdjudication: rows[7].adjudicated.evidence,
          })).toThrow(/not declared/u);
        } finally {
          rmSync(orphanPath);
        }
      });

      const q39Classification = readdirSync(join(rows[0].stateDir, "classification-recoveries"))
        .find((name) => name.startsWith("v1-0015-0039-"))!;
      expect(JSON.parse(readFileSync(
        join(rows[0].stateDir, "classification-recoveries", q39Classification), "utf8",
      )).items[0].transcription_status).toBe("exact");
      expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.some((spec) =>
        spec.entryId === "ebsi:5525982" && spec.key === "15:39")).toBe(true);
      expect(readdirSync(join(rows[0].stateDir, "problem-manual-adjudications"))
        .some((name) => name.startsWith("v1-0015-0039-"))).toBe(true);
      expect(existsSync(join(rows[0].stateDir, "answer-audit"))).toBe(false);
      expect(existsSync(join(rows[0].stateDir, "answer-attestation"))).toBe(false);
    } finally {
      providerMock.complete.mockReset();
      rmSync(rows[0].stateDir, { recursive: true, force: true });
    }
  }, 300_000);

  it.skipIf(!existsSync(join(Q30_MANUAL_STATE, "problem.pdf")))(
    "verifies the exact 5578421 Q31-Q32 manual pair and rejects tamper, orphan, or symlink",
    async () => {
      expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST).toHaveLength(75);
      expect(problemManualAdjudicationAllowlistForTest())
        .toEqual(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST);
      expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 36)))
        .toBe("e260bb5cd9c24507cb1c434e19b03a63961ef07a29392b28fc49f6897040dd64");
      expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 46)))
        .toBe("918b9267faab3d394cf64e5b9f02e9621024c5c6ad5d17d233fd8940fd1dac82");
      expect(manualAdjudicationAllowlistFingerprint())
        .toBe("c2d72629f59f1bf4b0c4f8651deb80284e56002eadbd4a395dcfb926172ceaa2");
      expect(Q31_Q32_5578421_MANUAL_SPECS.map((spec) => canonicalEvidenceHash(spec))).toEqual([
        "b5c5cfd215a05bb6f55f88aff21fae146465e33056a42a8c7cfff831148a51ca",
        "3aed2606c06fcdd6e45647693d4cb251196aa8b4653b8c6378fd8f9a480e336d",
      ]);
      const rows = await q31Q32ManualAuthorityFixture5578421();
      const verify = (row: (typeof rows)[number]) => withOnlyManualArtifactsForKey(
        row.stateDir,
        row.spec.key,
        () => verifyProblemManualAdjudicationForTest({
          stateDir: row.stateDir,
          entry: row.input.entry,
          problemEvidence: row.input.problem,
          parentRecovery: row.parent as unknown as Record<string, unknown>,
          failedQuestion: row.failed.question,
          failedClassification: row.failed.classification,
          manualAdjudication: row.adjudicated.evidence,
        }),
      ) as { question: QuizItemEx; classification: ClassificationDecision; evidence: Record<string, any> };

      try {
        const q31 = verify(rows[0]);
        const q32 = verify(rows[1]);
        expect(canonicalEvidenceHash(q31.question))
          .toBe("784b252cb42674978f332dc741bbca77366b1f7c72f7b60b24c235086b855f1f");
        expect(canonicalEvidenceHash(q32.question))
          .toBe("ec5a2c62639228e94c405ce9f5624fe7bb88c16d3e6add611f559edea9a9a804");
        expect(q31.question.question).toContain("<결론>인 $q$");
        expect(q31.question.figure_description).toContain("가로선은 총 2개");
        expect(q32.question.question).toContain("㉢ 명제 논리학");
        expect(q32.question.figure_description).toContain("가로선은 총 5개");
        expect([q31, q32].map((row) => row.classification)).toEqual([
          expect.objectContaining({ key: "12:31", decision: "accept", transcription_status: "exact" }),
          expect.objectContaining({ key: "12:32", decision: "accept", transcription_status: "exact" }),
        ]);
        expect([q31, q32].map((row) => row.evidence.allowlistId)).toEqual(
          Q31_Q32_5578421_MANUAL_SPECS.map((spec) => spec.allowlistId),
        );

        const q31ProblemPath = join(rows[0].stateDir, rows[0].adjudicated.evidence.problemArtifact.path);
        const q31ProblemBytes = readFileSync(q31ProblemPath);
        writeFileSync(q31ProblemPath, Buffer.concat([q31ProblemBytes, Buffer.from("tampered")]));
        expect(() => verify(rows[0])).toThrow(/hash mismatch/u);
        writeFileSync(q31ProblemPath, q31ProblemBytes);

        withOnlyManualArtifactsForKey(rows[1].stateDir, rows[1].spec.key, () => {
          const orphanPath = join(
            rows[1].stateDir,
            "problem-manual-adjudications",
            `v1-0012-0032-${"1".repeat(64)}.json`,
          );
          writeJson(orphanPath, {});
          try {
            expect(() => verifyProblemManualAdjudicationForTest({
              stateDir: rows[1].stateDir,
              entry: rows[1].input.entry,
              problemEvidence: rows[1].input.problem,
              parentRecovery: rows[1].parent as unknown as Record<string, unknown>,
              failedQuestion: rows[1].failed.question,
              failedClassification: rows[1].failed.classification,
              manualAdjudication: rows[1].adjudicated.evidence,
            })).toThrow(/not declared/u);
          } finally {
            rmSync(orphanPath);
          }
        });

        const q32ClassificationPath = join(
          rows[1].stateDir,
          rows[1].adjudicated.evidence.classificationArtifact.path,
        );
        const q32ClassificationBytes = readFileSync(q32ClassificationPath);
        rmSync(q32ClassificationPath);
        symlinkSync(join(rows[1].stateDir, "problem.pdf"), q32ClassificationPath);
        expect(() => verify(rows[1])).toThrow(/regular non-symlink file/u);
        rmSync(q32ClassificationPath);
        writeFileSync(q32ClassificationPath, q32ClassificationBytes);
      } finally {
        providerMock.complete.mockReset();
        rmSync(rows[0].stateDir, { recursive: true, force: true });
      }
    },
    300_000,
  );

  it.skipIf(!existsSync(join(Q30_MANUAL_STATE, "problem.pdf")))(
    "mirrors and verifies the exact 5578421 Q19-Q21 shared-passage authority",
    async () => {
    expect(problemManualAdjudicationAllowlistForTest()).toEqual(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST);
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST).toHaveLength(75);
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 43)))
      .toBe("e7dfb4cb4e9985bfc3d3077b96baa9f1f7e2ff7f5b8dee6fb26b342d301b04fc");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 46)))
      .toBe("918b9267faab3d394cf64e5b9f02e9621024c5c6ad5d17d233fd8940fd1dac82");
    expect(manualAdjudicationAllowlistFingerprint())
      .toBe("c2d72629f59f1bf4b0c4f8651deb80284e56002eadbd4a395dcfb926172ceaa2");
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(43, 46).map((spec) => ({
      key: spec.key,
      rowHash: canonicalEvidenceHash(spec),
      replacementsHash: canonicalEvidenceHash(spec.replacements),
    }))).toEqual([{
      key: "8:19",
      rowHash: "43e3e986c08cbe180a0c82f0819e069579b44169bf52b997967172e4fa12b686",
      replacementsHash: "1ccf6153d57617ff2b299d674cc0c5c1d26584601242e53b473f80986f8e8a8d",
    }, {
      key: "8:20",
      rowHash: "4afb635290ca5aa3233abc2c543c4a89cc0bc5d29faeb14a4ab6201da6fd9391",
      replacementsHash: "b3ef39251c4b771162400a3049af0e00d6495397bf51f9e594a74b8a54a330e1",
    }, {
      key: "8:21",
      rowHash: "845d4e3b15dad5a08333fb92302cc46cb140a8f3d92a30b61e06d45b4841b502",
      replacementsHash: "8151710a3959e4acb075ade0db51e002e1783302e4df09119ea39db63a124f7f",
    }]);
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_REVISION_ALLOWLIST.slice(0, 6)))
      .toBe("33741ecff318e2d58cc2c0614a718d41171a0629f792d062c63df876e23ffa5c");
    expect(manualRevisionAllowlistFingerprint())
      .toBe("c08c7c4b8865cebdfc6df49ac917f3e010f39d505f4a222e9b4b4c46ab09d275");
    expect(PROBLEM_MANUAL_REVISION_ALLOWLIST.slice(3, 6).map((spec) => ({
      key: spec.key,
      rowHash: canonicalEvidenceHash(spec),
      failedStatus: spec.failedStatus,
    }))).toEqual([{
      key: "8:19",
      rowHash: "e27383cba8efdb66d85ac3e5c0c2632ec646182c54764039aff3687da458c2cc",
      failedStatus: "exact",
    }, {
      key: "8:20",
      rowHash: "647a2d54b19dc3e2b47e46f6b2905c84bd5f36d257b9378a78bedc229c6073c6",
      failedStatus: undefined,
    }, {
      key: "8:21",
      rowHash: "bb73db45feca8b695f6865792b5a86567bc0e6dda426bba14276c57867eb9cf4",
      failedStatus: "exact",
    }]);
    const rows = await q19Q21ManualRevisionAuthorityFixture5578421();
    const verify = (row: (typeof rows)[number]) => withOnlyManualArtifactsForKey(
      row.stateDir,
      row.spec.key,
      () => verifyProblemManualAdjudicationForTest({
        stateDir: row.stateDir,
        entry: row.input.entry,
        problemEvidence: row.input.problem,
        parentRecovery: row.parent as unknown as Record<string, unknown>,
        failedQuestion: row.failed.question,
        failedClassification: row.failed.classification,
        manualAdjudication: row.adjudicated.evidence,
      }),
    ) as { question: QuizItemEx; classification: ClassificationDecision; evidence: Record<string, any> };
    try {
      const verified = rows.map(verify);
      expect(verified.map((row) => canonicalEvidenceHash(row.question))).toEqual([
        "9e97c0a2578c2f7006e3a56dcb85c2cad3fdedc960e6eda520826c65fa673950",
        "644b9b2b70de017d86ea1eea7502809a6a803a8cf6f16a8910256c85b44afc82",
        "8ed4e485cb98c1c585106ad934abaa97a6b73871a3ad4b6dc721ffb605e58a11",
      ]);
      expect(verified.map((row) => row.evidence.revision.allowlistId)).toEqual([
        "ebsi-5578421-q19-manual-revision-v1",
        "ebsi-5578421-q20-manual-revision-v1",
        "ebsi-5578421-q21-manual-revision-v1",
      ]);
      const { revision: _requiredRevision, ...missingExactRevision } = rows[0].adjudicated.evidence;
      expect(() => withOnlyManualArtifactsForKey(rows[0].stateDir, rows[0].spec.key, () =>
        verifyProblemManualAdjudicationForTest({
          stateDir: rows[0].stateDir,
          entry: rows[0].input.entry,
          problemEvidence: rows[0].input.problem,
          parentRecovery: rows[0].parent as unknown as Record<string, unknown>,
          failedQuestion: rows[0].failed.question,
          failedClassification: rows[0].failed.classification,
          manualAdjudication: missingExactRevision,
        }))).toThrow(/stale or non-exact/u);
      const problemPath = join(
        rows[0].stateDir,
        rows[0].adjudicated.evidence.revision!.problemArtifact.path,
      );
      const problemBytes = readFileSync(problemPath);
      writeFileSync(problemPath, Buffer.concat([problemBytes, Buffer.from("tampered")]));
      expect(() => verify(rows[0])).toThrow(/hash mismatch/u);
      writeFileSync(problemPath, problemBytes);
    } finally {
      providerMock.complete.mockReset();
      rmSync(rows[0].stateDir, { recursive: true, force: true });
    }
  }, 180_000);

  it.skipIf(
    !existsSync(join(Q27_MANUAL_STATE, "problem.pdf"))
      || !existsSync(join(Q27_MANUAL_STATE, "solution.pdf")),
  )("verifies the terminal-recovery Q6-Q7 and Q21-Q26 manual authority", async () => {
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST).toHaveLength(75);
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 29)))
      .toBe("0b5d7d19255cd91566a55b289b11f8a9460a3014a06f255f9a266ebd62980cf9");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 36)))
      .toBe("e260bb5cd9c24507cb1c434e19b03a63961ef07a29392b28fc49f6897040dd64");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 46)))
      .toBe("918b9267faab3d394cf64e5b9f02e9621024c5c6ad5d17d233fd8940fd1dac82");
    expect(manualAdjudicationAllowlistFingerprint())
      .toBe("c2d72629f59f1bf4b0c4f8651deb80284e56002eadbd4a395dcfb926172ceaa2");
    expect(manualAdjudicationAllowlistFingerprint())
      .toBe(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST));
    const expected = new Map([
      ["3:6", {
        row: "61bdf7c236673015c1fe47c727bf0b64315242c12d7b271d0c4849f99d115569",
        item: "cad8ee9729b41ecbd7317b94e7a9e12a1433c573ed04352321c518f063b0968b",
        status: "exact", decision: "reject", subject: null,
      }],
      ["3:7", {
        row: "910582e47939b506c4752b732461fe3c2d8395438122b3effef03d7c1506bedf",
        item: "12c693c31541967de63e3b19e413e088c09eb4e8f5ebe6311a8070b4750d6dac",
        status: "mismatch", decision: "reject", subject: null,
      }],
      ["9:21", {
        row: "62cca0160f98b7edd9dc72df0494192241b9459ed2560dfeb5a6269e5f59313f",
        item: "8d6d3f7980acee3f467acebcfc684da0ba69c801cbc734e9e8ae10d59477a28a",
        status: "exact", decision: "accept", subject: "korean_literature",
      }],
      ["9:22", {
        row: "53880789c730dd79aad96464d993cf2060153b48032da54356ef32e6760e1049",
        item: "f1ef2ea1220621b550ba81993986ae75e155af93dd67034edc5a3bae3bd2b648",
        status: "mismatch", decision: "accept", subject: "korean_literature",
      }],
      ["9:24", {
        row: "7c9e953027cc58010fc8ff35f249b6c6a8ca4c0bc0e30a3791d38477031c62e8",
        item: "3644bdfa7c1b94fed356c4bcf7fd1adc5632ae199f4ac90771efd560f78f0e39",
        status: "mismatch", decision: "accept", subject: "korean_literature",
      }],
      ["9:25", {
        row: "0a60f910e1a7fdcc1d81769a12a638584ebf9f29f657c35c0c09700e88cafaeb",
        item: "1a9438c01f5a5be624a31f6004260e0407a5923cf44ec9f718d1226f1684c417",
        status: "mismatch", decision: "accept", subject: "korean_literature",
      }],
      ["9:26", {
        row: "9a0a740b0f41c36f825f5bf699227245f14919897a1cb3eec75050123cf58127",
        item: "1498565bab625f4417c144c442e81ea0f7e566ce4807fa977678ac26a589c27c",
        status: "exact", decision: "accept", subject: "korean_literature",
      }],
    ]);
    for (const spec of Q6_Q26_MANUAL_SPECS) {
      expect(canonicalEvidenceHash(spec)).toBe(expected.get(spec.key)!.row);
    }

    const rows = await q6Q26ManualAuthorityFixture();
    const verify = (
      row: (typeof rows)[number],
      manualAdjudication: unknown = row.adjudicated.evidence,
      parentRecovery: Record<string, unknown> = row.parent as unknown as Record<string, unknown>,
      failedClassification: unknown = row.failed.classification,
    ) => withOnlyManualArtifactsForKey(row.stateDir, row.spec.key, () =>
      verifyProblemManualAdjudicationForTest({
        stateDir: row.stateDir,
        entry: row.input.entry,
        problemEvidence: row.input.problem,
        parentRecovery,
        failedQuestion: row.failed.question,
        failedClassification,
        manualAdjudication,
      }));

    try {
      const verifiedByKey = new Map<string, { question: QuizItemEx; classification: ClassificationDecision }>();
      for (const row of rows) {
        const pin = expected.get(row.spec.key)!;
        expect(row.failed.classification.transcription_status).toBe(pin.status);
        const verified = verify(row) as {
          question: QuizItemEx;
          classification: ClassificationDecision;
          evidence: Record<string, any>;
        };
        expect(canonicalEvidenceHash(verified.question)).toBe(pin.item);
        expect(verified.evidence).toMatchObject({
          allowlistId: row.spec.allowlistId,
          parentRecoveryEvidenceHash: row.spec.parentRecoveryEvidenceHash,
          problemArtifactItemHash: pin.item,
        });
        expect(verified.classification).toMatchObject({
          key: row.spec.key,
          decision: pin.decision,
          canonical_subject: pin.subject,
          transcription_status: "exact",
        });
        verifiedByKey.set(row.spec.key, verified);
      }
      expect(verifiedByKey.get("3:6")!.question).toMatchObject({ figure: true, box: null });
      expect(verifiedByKey.get("3:7")!.question).toMatchObject({ figure: true, box: [0.42, 0.88] });
      expect(verifiedByKey.get("3:7")!.question.figure_description)
        .toContain("두 개의 가로 구분선 아래 회색 제목 띠");
      const q7 = rows.find((row) => row.spec.key === "3:7")!;
      expect((verifiedByKey.get("3:7") as unknown as {
        classification: ClassificationDecision;
      }).classification).toMatchObject({
        decision: "reject",
        canonical_subject: null,
        reason_codes: ["EXCLUDED_PRESENTATION_MEDIA_ASSESSED"],
      });
      expect(q7.adjudicated.evidence.policyRevision).toMatchObject({
        parentManualEvidenceHash: "50ca6cdacfa0215bceb57685fafb4a873772739659519df6a864f4e26d063404",
        policyArtifact: {
          path: "classification-manual-policy-revisions/" +
            "v1-0003-0007-81ab9f4c66829d951249d2bb2eb297ed3c33cd65b587d4c242c95749162cdd8b.json",
          sha256: "71a627aa8433c793bc8ec7d7270ea5097e5fc1abb8187e52236e80b168917ae4",
          version: PROBLEM_MANUAL_CLASSIFICATION_POLICY_REVISION_VERSION,
          policyDigest: PROBLEM_MANUAL_CLASSIFICATION_POLICY_REVISION_DIGEST,
        },
        policyItemHash: "3fafa64dd3d16182d72a5f7a68f9fca8f9e057a376606064b0bd5cf0b228ceb4",
      });
      expect(verifiedByKey.get("9:24")!.question.answer).toMatch(/^③ /u);
      expect(verifiedByKey.get("9:26")!.question.question)
        .toContain("26. (다)의 서술상의 특징에 대한 설명으로 가장 적절한 것은?");
      const q26 = rows.find((row) => row.spec.key === "9:26")!;
      expect(q26.adjudicated.evidence.cropViews.at(-1)).toMatchObject({
        rect: [0.50, 0.74, 0.95, 0.91],
        pixelSha256: "7b43f579da32b8126104df583d17ff02e64e33cbfb90604325431730a0f95cf2",
        pixelWidth: 3159,
        pixelHeight: 1688,
      });

      expect(() => verify(rows[0], rows[1].adjudicated.evidence))
        .toThrow(/allowlist\/parent authority/u);
      expect(() => verify(rows[1], rows[1].adjudicated.evidence,
        rows[0].parent as unknown as Record<string, unknown>))
        .toThrow(/allowlist\/parent authority/u);

      const exactWrongStatus = structuredClone(rows[0].failed.classification);
      exactWrongStatus.transcription_status = "mismatch";
      expect(() => verify(rows[0], rows[0].adjudicated.evidence,
        rows[0].parent as unknown as Record<string, unknown>, exactWrongStatus))
        .toThrow(/allowlisted exhausted recovery status/u);
      const mismatchWrongStatus = structuredClone(rows[1].failed.classification);
      mismatchWrongStatus.transcription_status = "exact";
      expect(() => verify(rows[1], rows[1].adjudicated.evidence,
        rows[1].parent as unknown as Record<string, unknown>, mismatchWrongStatus))
        .toThrow(/allowlisted exhausted recovery status/u);

      const parentTamper = structuredClone(rows[2].parent) as unknown as Record<string, any>;
      parentTamper.trigger.terminalItemHash = "0".repeat(64);
      expect(() => verify(rows[2], rows[2].adjudicated.evidence, parentTamper))
        .toThrow(/allowlist\/parent authority/u);

      const missingPath = join(rows[3].stateDir, rows[3].adjudicated.evidence.classificationArtifact.path);
      const missingBytes = readFileSync(missingPath);
      rmSync(missingPath);
      expect(() => verify(rows[3])).toThrow();
      writeFileSync(missingPath, missingBytes);

      const cropPath = join(q26.stateDir, q26.adjudicated.evidence.cropViews.at(-1)!.artifact.path);
      const cropBytes = readFileSync(cropPath);
      writeFileSync(cropPath, Buffer.concat([cropBytes, Buffer.from("tampered")]));
      expect(() => verify(q26)).toThrow(/hash mismatch/u);
      writeFileSync(cropPath, cropBytes);

      const q7PolicyPath = join(q7.stateDir, q7.adjudicated.evidence.policyRevision!.policyArtifact.path);
      const q7PolicyBytes = readFileSync(q7PolicyPath);
      rmSync(q7PolicyPath);
      expect(() => verify(q7)).toThrow();
      writeFileSync(q7PolicyPath, q7PolicyBytes);

      const policyMetadataTamper = structuredClone(q7.adjudicated.evidence);
      policyMetadataTamper.policyRevision!.policyArtifact.policyDigest = "0".repeat(64);
      expect(() => verify(q7, policyMetadataTamper)).toThrow(/artifact envelope is stale/u);

      const policyBytesTamper = Buffer.from(q7PolicyBytes);
      policyBytesTamper[policyBytesTamper.length - 2] ^= 1;
      writeFileSync(q7PolicyPath, policyBytesTamper);
      expect(() => verify(q7)).toThrow(/hash mismatch/u);
      writeFileSync(q7PolicyPath, q7PolicyBytes);

      const solutionCheckpointPath = join(q7.stateDir, "solution-chunks/v3-0000.json");
      const solutionCheckpointBytes = readFileSync(solutionCheckpointPath);
      writeFileSync(solutionCheckpointPath, Buffer.concat([
        solutionCheckpointBytes,
        Buffer.from("tampered"),
      ]));
      expect(() => verify(q7)).toThrow(/hash mismatch/u);
      writeFileSync(solutionCheckpointPath, solutionCheckpointBytes);

      const q7PolicyDirectory = join(q7.stateDir, "classification-manual-policy-revisions");
      const orphanPolicyPath = join(q7PolicyDirectory, `v1-0003-0007-${"1".repeat(64)}.json`);
      writeJson(orphanPolicyPath, {});
      expect(() => verify(q7)).toThrow(/conflicting generations/u);
      rmSync(orphanPolicyPath);

      const policyFileTarget = `${q7PolicyPath}.target`;
      renameSync(q7PolicyPath, policyFileTarget);
      symlinkSync(policyFileTarget, q7PolicyPath);
      expect(() => verify(q7)).toThrow(/regular non-symlink file/u);
      rmSync(q7PolicyPath);
      renameSync(policyFileTarget, q7PolicyPath);

      withOnlyManualArtifactsForKey(rows[4].stateDir, rows[4].spec.key, () => {
        const orphanPath = join(
          rows[4].stateDir,
          "classification-manual-adjudications",
          `v1-0009-0024-${"1".repeat(64)}-${DIGEST}.json`,
        );
        writeJson(orphanPath, {});
        try {
          expect(() => verifyProblemManualAdjudicationForTest({
            stateDir: rows[4].stateDir,
            entry: rows[4].input.entry,
            problemEvidence: rows[4].input.problem,
            parentRecovery: rows[4].parent as unknown as Record<string, unknown>,
            failedQuestion: rows[4].failed.question,
            failedClassification: rows[4].failed.classification,
            manualAdjudication: rows[4].adjudicated.evidence,
          })).toThrow(/not declared/u);
        } finally {
          rmSync(orphanPath);
        }
      });

      expect(existsSync(join(rows[0].stateDir, "answer-audit"))).toBe(false);
      expect(existsSync(join(rows[0].stateDir, "answer-attestation"))).toBe(false);
    } finally {
      providerMock.complete.mockReset();
      rmSync(rows[0].stateDir, { recursive: true, force: true });
    }
  }, 300_000);

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

  it.skipIf(!existsSync(Q11_OFFICIAL_PROBLEM_PATH) || !existsSync(Q11_OFFICIAL_SOLUTION_PATH))(
  "reconstructs the exact Q11 scope box revision and honest Q5 solution chain",
  async () => {
    expect(PROBLEM_SCOPE_BOX_REVISION_VERSION).toBe(1);
    expect(PROBLEM_SCOPE_BOX_REVISION_PROMPT_DIGEST)
      .toBe("067eea7c5d44f2e15a6f979ba016eb01c13b8aa8268c17aa33a902cf705ba04c");
    expect(PROBLEM_SCOPE_BOX_REVISION_CORRECTION_DIGEST)
      .toBe("d9d2ddedb51a82d107e3a0d66f2263a92483a09cce20d5fde531ee9083bf88a4");
    expect(scopeBoxRevisionAllowlistFingerprint())
      .toBe("6006e177f56f72c29cac9f5051ebbfd0b397c7309e1d0f8e059a3a78eaf181ec");
    expect(scopeBoxRevisionAllowlistFingerprint())
      .toBe(canonicalEvidenceHash(PROBLEM_SCOPE_BOX_REVISION_ALLOWLIST));
    expect(terminalFidelityAdjudicationAllowlistFingerprint())
      .toBe("2391e658b51e40410bf242bdfd6c113383d97c8cbde86d02ca2f6499a9ab904e");
    const terminalSpec = PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST.find((spec) =>
      spec.entryId === "ebsi:5577055" && spec.key === "4:11")!;
    const policySpec = terminalSpec.policyRevision!;
    expect(canonicalEvidenceHash(terminalSpec))
      .toBe("a531a5213f2f9e4a53efde1dede0eb33795a4bd0ee47f18799520e2b98a4b9de");
    expect(PROBLEM_TERMINAL_FIDELITY_POLICY_REVISION_VERSION).toBe(1);
    expect(PROBLEM_TERMINAL_FIDELITY_POLICY_REVISION_DIGEST)
      .toBe("bc625c2e3b1b7006d184e14a7f1fc298a3788617c639bcd131483d7c23177a06");
    expect(CURRICULUM_RULES_SHA256)
      .toBe("7bb7cb863c8c4855f042419fbbaac4426aafb513d8bbb00fd35f5afa1a2d1932");
    expect(canonicalEvidenceHash(policySpec))
      .toBe("455633dfd7fddebed531ba15e5b5609c898f511e0e4b86e6fe39b691ddb1a037");
    expect(canonicalEvidenceHash(policySpec.expectedItem))
      .toBe("de7aeb740bdd1028513cccee841db5363464896d49a7ac98ad06cb6b17460e44");
    const parentQuestion = JSON.parse(readFileSync(join(
      Q11_SCOPE_STATE,
      PROBLEM_SCOPE_BOX_REVISION_ALLOWLIST[0].parentRecoveryProblemArtifactPath,
    ), "utf8")).item as QuizItemEx;
    expect(applyAllowlistedProblemScopeBoxRevision(
      Q11_SCOPE_SPEC.entryId,
      Q11_SCOPE_SPEC.sourceHash,
      parentQuestion,
    )).toEqual({ ...parentQuestion, box: [0.12, 0.36] });

    const files = await scopeBoxRevisionFixture();
    try {
      const report = verifyExamCorpus(files);
      expect(report, JSON.stringify(report.failures, null, 2)).toMatchObject({
        ok: true,
        failureCount: 0,
        questions: { expected: 6, actual: 6 },
      });
      const audit = JSON.parse(readFileSync(join(files.stateDir, files.result.auditPath!), "utf8"));
      const q11Repair = audit.repairs.find((repair: { key: string }) => repair.key === "4:11");
      expect(files.result.effectiveCorpusHash).toBe(terminalSpec.failedEffectiveCorpusHash);
      const boxRevision = q11Repair.revision.recovery.scopeAdjudication.boxRevision;
      expect(boxRevision).toMatchObject({
        allowlistId: PROBLEM_SCOPE_BOX_REVISION_ALLOWLIST[0].allowlistId,
        key: "4:11",
        effectiveQuestionHash: PROBLEM_SCOPE_BOX_REVISION_ALLOWLIST[0].correctedQuestionHash,
        baseClassificationHash: PROBLEM_SCOPE_BOX_REVISION_ALLOWLIST[0].failedClassificationHash,
      });
      const problemCheckpoint = JSON.parse(readFileSync(
        join(files.stateDir, boxRevision.problemArtifact.path),
        "utf8",
      ));
      expect(problemCheckpoint.item.box).toEqual([0.12, 0.36]);
      expect(canonicalEvidenceHash(problemCheckpoint.item))
        .toBe(PROBLEM_SCOPE_BOX_REVISION_ALLOWLIST[0].correctedQuestionHash);
      const cropCheckpoint = JSON.parse(readFileSync(
        join(files.stateDir, boxRevision.cropEvidenceArtifact.path),
        "utf8",
      ));
      expect(cropCheckpoint.views).toEqual([expect.objectContaining({
        rect: [0.07, 0.12, 0.50, 0.36],
        pixelWidth: 3017,
        pixelHeight: 2382,
      })]);
      expect(q11Repair.terminalAdjudication).toMatchObject({
        allowlistId: terminalSpec.allowlistId,
        parentKind: "scope-box",
        parentScopeAdjudicationHash: terminalSpec.parentScopeAdjudicationHash,
        parentScopeBoxEvidenceHash: terminalSpec.parentScopeBoxEvidenceHash,
        sourceEvidence: {
          path: boxRevision.cropEvidencePdf.path,
          sha256: boxRevision.cropEvidencePdf.sha256,
          kind: "scope-box-crop",
        },
        cropEvidenceArtifact: boxRevision.cropEvidenceArtifact,
        cropEvidencePdf: boxRevision.cropEvidencePdf,
        cropViews: boxRevision.cropViews,
        baseSolutionCheckpoint: {
          path: terminalSpec.baseSolutionCheckpointPath,
          sha256: terminalSpec.baseSolutionCheckpointHash,
        },
        baseSolutionItemHash: terminalSpec.baseSolutionItemHash,
        solutionContextFrom: 1,
        solutionContextTo: 5,
        failedTerminalCheckpoint: {
          path: terminalSpec.failedTerminalPath,
          sha256: terminalSpec.failedTerminalArtifactHash,
        },
      });
      const terminalChildPath = join(
        files.stateDir,
        q11Repair.terminalAdjudication.adjudicationArtifact.path,
      );
      const terminalChildBytes = readFileSync(terminalChildPath);
      const terminalChild = JSON.parse(terminalChildBytes.toString("utf8"));
      expect(terminalChild).toMatchObject({
        basis: {
          parentScopeAdjudicationHash: terminalSpec.parentScopeAdjudicationHash,
          parentScopeBoxEvidenceHash: terminalSpec.parentScopeBoxEvidenceHash,
          baseSolutionCheckpoint: {
            path: terminalSpec.baseSolutionCheckpointPath,
            sha256: terminalSpec.baseSolutionCheckpointHash,
          },
          solutionContextFrom: 1,
          solutionContextTo: 5,
        },
        items: [{ key: "4:11", status: "exact", scopeDecision: "accept" }],
      });
      expect(canonicalEvidenceHash(terminalChild)).toBe(policySpec.parentAdjudicationArtifactHash);
      const policyEvidence = q11Repair.terminalAdjudication.policyRevision;
      expect(policyEvidence).toMatchObject({
        allowlistId: policySpec.allowlistId,
        parentAdjudicationArtifact: {
          path: policySpec.parentAdjudicationArtifactPath,
          sha256: policySpec.parentAdjudicationArtifactHash,
        },
        parentAdjudicationItemHash: policySpec.parentAdjudicationItemHash,
        parentAdjudicationPromptHash: policySpec.parentAdjudicationPromptHash,
        parentClassificationHash: terminalSpec.parentClassificationHash,
        curriculumRulesHash: CURRICULUM_RULES_SHA256,
        policyArtifact: {
          path: "problem-terminal-fidelity-policy-revisions/" +
            "v1-0004-0011-11a179d21a920cd7fada79aa98a3f448c4aaef000ec690f5e60133366b09b748.json",
          sha256: "b2ae59bbaa67a9d762000865bc4ef34af97267e9064dd0adedd17e46802a1cdd",
          version: 1,
          policyDigest: PROBLEM_TERMINAL_FIDELITY_POLICY_REVISION_DIGEST,
        },
        policyItemHash: canonicalEvidenceHash(policySpec.expectedItem),
      });
      const policyPath = join(files.stateDir, policyEvidence.policyArtifact.path);
      const policyBytes = readFileSync(policyPath);
      const policyCheckpoint = JSON.parse(policyBytes.toString("utf8"));
      expect(policyCheckpoint).toMatchObject({
        version: 1,
        policyDigest: PROBLEM_TERMINAL_FIDELITY_POLICY_REVISION_DIGEST,
        item: policySpec.expectedItem,
        basis: {
          parentAdjudicationItemHash: policySpec.parentAdjudicationItemHash,
          parentAdjudicationPromptHash: policySpec.parentAdjudicationPromptHash,
          parentClassificationHash: terminalSpec.parentClassificationHash,
          curriculumRulesHash: CURRICULUM_RULES_SHA256,
          baseSolutionItemHash: terminalSpec.baseSolutionItemHash,
          solutionContextFrom: 1,
          solutionContextTo: 5,
        },
      });
      expect(canonicalEvidenceHash(policyCheckpoint))
        .toBe("b2ae59bbaa67a9d762000865bc4ef34af97267e9064dd0adedd17e46802a1cdd");
      expect(JSON.stringify(policyCheckpoint)).not.toContain("1=a-b");
      const failedTerminal = JSON.parse(readFileSync(join(files.stateDir, terminalSpec.failedTerminalPath), "utf8"));
      expect(failedTerminal.items.find((item: { key: string }) => item.key === "4:11"))
        .toMatchObject({ status: "exact", scopeDecision: "accept" });
      expect(audit.problemTerminalFidelityItems).toHaveLength(30);
      expect(audit.problemTerminalFidelityItems.find((item: { key: string }) => item.key === "4:11"))
        .toMatchObject({ status: "exact", scopeDecision: "reject" });
      const q5Repair = audit.solutionRepairs.find((repair: { key: string }) => repair.key === "2:5");
      expect(q5Repair).toMatchObject({
        baseSolutionItemHash: "b674ac8edb4c2dece403bdd09c28e5e4ab11832c024468e72964f90136b805a7",
        effectiveSolutionItemHash: "6fd09d50cd90a6e59e7a39a7fa298d3df7b330826138f2b295c26bdcaae087b6",
        baseRawAnswerHash: "1b65c648e3566876e3af03395e859b3c4d2ff8768568d590f7cf76172b2d5839",
        effectiveRawAnswerHash: "18eb660efcd50dde8e19c9c890afe1d9b15fb7a53f6746488c65e9468ecc9cf9",
        repairArtifact: {
          path: "solution-repairs/v1-0001-0005-503522063111526052881ef4eb8db6478fe722378a5929e7f1f291ddd332c89c.json",
          sha256: "7c1b9043891bc1518420dc91cc243a4ed26fd3c58fcc4a0387448296d334d7da",
        },
        fidelityArtifact: {
          path: "solution-fidelity-repairs/v1-0001-0005-503522063111526052881ef4eb8db6478fe722378a5929e7f1f291ddd332c89c-" +
            "6fd09d50cd90a6e59e7a39a7fa298d3df7b330826138f2b295c26bdcaae087b6.json",
          sha256: "5eca6afeb6edd5d5f24eda35b74d9505428b2b3a9c0a7337fdd8581aed959755",
        },
      });
      expect(audit.solutionFidelityItems.find((item: { key: string }) => item.key === "2:5"))
        .toMatchObject({ answerStatus: "exact", explanationStatus: "exact" });
      expect(audit.semanticCheckpoint).toBeNull();
      const db = new Database(files.dbPath, { readonly: true });
      expect(db.prepare("SELECT COUNT(*) AS count FROM questions WHERE printed_number = '11'").get())
        .toEqual({ count: 0 });
      expect(db.prepare("SELECT answer FROM questions WHERE printed_number = '5'").get())
        .toEqual({ answer: "④ $\\sqrt[3]{2}$" });
      db.close();

      const classificationPath = join(files.stateDir, boxRevision.classificationArtifact.path);
      const classificationBytes = readFileSync(classificationPath);
      writeFileSync(classificationPath, Buffer.concat([classificationBytes, Buffer.from("tampered")]));
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);
      writeFileSync(classificationPath, classificationBytes);

      const cropViewPath = join(files.stateDir, boxRevision.cropViews[0].artifact.path);
      const cropViewBytes = readFileSync(cropViewPath);
      writeFileSync(cropViewPath, Buffer.concat([cropViewBytes, Buffer.from("tampered")]));
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);
      writeFileSync(cropViewPath, cropViewBytes);

      const cropPdfPath = join(files.stateDir, boxRevision.cropEvidencePdf.path);
      const cropPdfBytes = readFileSync(cropPdfPath);
      writeFileSync(cropPdfPath, Buffer.concat([cropPdfBytes, Buffer.from("tampered")]));
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);
      writeFileSync(cropPdfPath, cropPdfBytes);

      writeFileSync(policyPath, Buffer.concat([policyBytes, Buffer.from("tampered")]));
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("policy revision"))).toBe(true);
      writeFileSync(policyPath, policyBytes);

      rmSync(policyPath);
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("missing"))).toBe(true);
      writeFileSync(policyPath, policyBytes);

      const policyDirectory = join(files.stateDir, "problem-terminal-fidelity-policy-revisions");
      const policyOrphan = join(
        policyDirectory,
        `v1-0004-0011-${"4".repeat(64)}.json`,
      );
      writeJson(policyOrphan, {});
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("not declared"))).toBe(true);
      rmSync(policyOrphan);

      const policySymlink = join(
        policyDirectory,
        `v1-0004-0011-${"5".repeat(64)}.json`,
      );
      symlinkSync(policyPath, policySymlink);
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("regular file"))).toBe(true);
      rmSync(policySymlink);

      rmSync(terminalChildPath);
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("missing"))).toBe(true);
      writeFileSync(terminalChildPath, terminalChildBytes);

      const terminalOrphan = join(
        files.stateDir,
        "problem-terminal-fidelity-adjudications",
        `v1-0004-0011-${"2".repeat(64)}.json`,
      );
      writeJson(terminalOrphan, {});
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("not declared"))).toBe(true);
      rmSync(terminalOrphan);

      const terminalChildCopy = join(files.stateDir, "terminal-child-copy.json");
      writeFileSync(terminalChildCopy, terminalChildBytes);
      rmSync(terminalChildPath);
      symlinkSync(terminalChildCopy, terminalChildPath);
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);
      rmSync(terminalChildPath);
      writeFileSync(terminalChildPath, terminalChildBytes);
      rmSync(terminalChildCopy);

      const problemPath = join(files.stateDir, boxRevision.problemArtifact.path);
      const problemBytes = readFileSync(problemPath);
      rmSync(problemPath);
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("missing"))).toBe(true);
      writeFileSync(problemPath, problemBytes);

      const orphan = join(
        files.stateDir,
        "problem-scope-box-revisions",
        `v1-0004-0011-${"1".repeat(64)}.json`,
      );
      writeJson(orphan, {});
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("not declared"))).toBe(true);
      rmSync(orphan);

      const malformed = join(files.stateDir, "problem-scope-box-revisions", "malformed.json");
      writeJson(malformed, {});
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("malformed"))).toBe(true);
      rmSync(malformed);

      const triggerPath = join(files.stateDir, PROBLEM_SCOPE_BOX_REVISION_ALLOWLIST[0].triggerTerminalPath);
      const triggerBytes = readFileSync(triggerPath);
      writeFileSync(triggerPath, Buffer.concat([triggerBytes, Buffer.from("tampered")]));
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);
      writeFileSync(triggerPath, triggerBytes);

      const fidelityPath = join(files.stateDir, q5Repair.fidelityArtifact.path);
      const fidelityBytes = readFileSync(fidelityPath);
      rmSync(fidelityPath);
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);
      writeFileSync(fidelityPath, fidelityBytes);

      const auditPath = join(files.stateDir, files.result.auditPath!);
      const auditBytes = readFileSync(auditPath);
      rmSync(auditPath);
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_ATTESTATION_INVALID" || failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);
      writeFileSync(auditPath, auditBytes);

      const attestationDirectory = join(files.stateDir, "answer-attestation");
      const attestationPath = join(
        attestationDirectory,
        readdirSync(attestationDirectory).find((name) => /^v5-/u.test(name))!,
      );
      const attestationBytes = readFileSync(attestationPath);
      writeFileSync(attestationPath, Buffer.concat([attestationBytes, Buffer.from("tampered")]));
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_ATTESTATION_INVALID")).toBe(true);
      writeFileSync(attestationPath, attestationBytes);
      rmSync(attestationPath);
      expect(verifyExamCorpus(files).failures.some((failure) =>
        failure.code === "ANSWER_ATTESTATION_MISSING")).toBe(true);
      writeFileSync(attestationPath, attestationBytes);

      const problemDirectory = join(files.stateDir, "problem-scope-box-revisions");
      rmSync(problemDirectory, { recursive: true });
      const outside = mkdtempSync(join(tmpdir(), "verify-scope-box-outside-"));
      symlinkSync(outside, problemDirectory);
      const symlinkReport = verifyExamCorpus(files);
      expect(symlinkReport.failures.some((failure) => failure.code === "ANSWER_AUDIT_INVALID"),
        JSON.stringify(symlinkReport.failures, null, 2)).toBe(true);
      rmSync(problemDirectory);
      rmSync(outside, { recursive: true, force: true });
    } finally {
      providerMock.complete.mockReset();
      rmSync(files.root, { recursive: true, force: true });
    }

    const invalidScope = await scopeBoxRevisionFixture();
    try {
      rewriteTerminalAdjudicationAuthority(invalidScope, (currentAudit) => {
        const repair = currentAudit.repairs.find((value: { key: string }) => value.key === "4:11");
        const adjudication = repair.terminalAdjudication;
        const childPath = join(invalidScope.stateDir, adjudication.adjudicationArtifact.path);
        const child = JSON.parse(readFileSync(childPath, "utf8"));
        const item = child.items[0];
        item.scopeDecision = "accept";
        item.scopeEvidence = "self-consistent but allowlist-forbidden Q11 scope acceptance";
        adjudication.adjudicationArtifact.sha256 = writeEvidence(childPath, child);
        adjudication.adjudicationItemHash = canonicalEvidenceHash(item);
        Object.assign(currentAudit.problemTerminalFidelityItems.find(
          (value: { key: string }) => value.key === "4:11",
        ), item);
      });
      const invalidReport = verifyExamCorpus(invalidScope);
      expect(invalidReport.failures.some((failure) => failure.code === "ANSWER_AUDIT_INVALID"),
        JSON.stringify(invalidReport.failures, null, 2)).toBe(true);
    } finally {
      providerMock.complete.mockReset();
      rmSync(invalidScope.root, { recursive: true, force: true });
    }

    const omittedChild = await scopeBoxRevisionFixture();
    try {
      rewriteTerminalAdjudicationAuthority(omittedChild, (currentAudit) => {
        delete currentAudit.repairs.find((value: { key: string }) => value.key === "4:11")
          .terminalAdjudication;
      });
      expect(verifyExamCorpus(omittedChild).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID")).toBe(true);
    } finally {
      providerMock.complete.mockReset();
      rmSync(omittedChild.root, { recursive: true, force: true });
    }

    const stalePolicy = await scopeBoxRevisionFixture();
    try {
      rewriteTerminalAdjudicationAuthority(stalePolicy, (currentAudit) => {
        currentAudit.repairs.find((value: { key: string }) => value.key === "4:11")
          .terminalAdjudication.policyRevision.parentAdjudicationPromptHash = "0".repeat(64);
      });
      expect(verifyExamCorpus(stalePolicy).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("policy revision"))).toBe(true);
    } finally {
      providerMock.complete.mockReset();
      rmSync(stalePolicy.root, { recursive: true, force: true });
    }

    const noThirdPolicy = await scopeBoxRevisionFixture();
    try {
      rewriteTerminalAdjudicationAuthority(noThirdPolicy, (currentAudit) => {
        currentAudit.repairs.find((value: { key: string }) => value.key === "4:11")
          .terminalAdjudication.policyRevision.policyRevision = {};
      });
      expect(verifyExamCorpus(noThirdPolicy).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("policy revision"))).toBe(true);
    } finally {
      providerMock.complete.mockReset();
      rmSync(noThirdPolicy.root, { recursive: true, force: true });
    }

    const parentTamper = await scopeBoxRevisionFixture();
    try {
      rewriteTerminalAdjudicationAuthority(parentTamper, (currentAudit) => {
        currentAudit.repairs.find((repair: { key: string }) => repair.key === "4:11")
          .revision.recovery.scopeAdjudication.boxRevision.parentScopeAdjudicationHash = "0".repeat(64);
      });
      expect(verifyExamCorpus(parentTamper).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("scope box"))).toBe(true);
    } finally {
      providerMock.complete.mockReset();
      rmSync(parentTamper.root, { recursive: true, force: true });
    }

    const pathAlias = await scopeBoxRevisionFixture();
    try {
      const audit = JSON.parse(readFileSync(join(pathAlias.stateDir, pathAlias.result.auditPath!), "utf8"));
      const boxRevision = audit.repairs.find((repair: { key: string }) => repair.key === "4:11")
        .revision.recovery.scopeAdjudication.boxRevision;
      const aliasRelativePath = "scope-box-alias/crop.json";
      const aliasPath = join(pathAlias.stateDir, aliasRelativePath);
      mkdirSync(join(aliasPath, ".."), { recursive: true });
      cpSync(join(pathAlias.stateDir, boxRevision.cropEvidenceArtifact.path), aliasPath);
      rewriteTerminalAdjudicationAuthority(pathAlias, (currentAudit) => {
        currentAudit.repairs.find((repair: { key: string }) => repair.key === "4:11")
          .revision.recovery.scopeAdjudication.boxRevision.cropEvidenceArtifact.path = aliasRelativePath;
      });
      expect(verifyExamCorpus(pathAlias).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("scope box"))).toBe(true);
    } finally {
      providerMock.complete.mockReset();
      rmSync(pathAlias.root, { recursive: true, force: true });
    }

    const finalTerminalTamper = await scopeBoxRevisionFixture();
    try {
      rewriteTerminalAdjudicationAuthority(finalTerminalTamper, (currentAudit) => {
        const pointer = currentAudit.problemTerminalFidelityCheckpoints[0];
        const checkpointPath = join(finalTerminalTamper.stateDir, pointer.path);
        const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
        const item = checkpoint.items.find((value: { key: string }) => value.key === "4:11");
        item.scopeDecision = "accept";
        item.scopeEvidence = "self-consistent stale final scope acceptance";
        pointer.sha256 = writeEvidence(checkpointPath, checkpoint);
        Object.assign(currentAudit.problemTerminalFidelityItems.find(
          (value: { key: string }) => value.key === "4:11",
        ), item);
      });
      expect(verifyExamCorpus(finalTerminalTamper).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("terminal"))).toBe(true);
    } finally {
      providerMock.complete.mockReset();
      rmSync(finalTerminalTamper.root, { recursive: true, force: true });
    }

    const repeated = await scopeBoxRevisionFixture();
    try {
      rewriteTerminalAdjudicationAuthority(repeated, (currentAudit) => {
        currentAudit.repairs.find((repair: { key: string }) => repair.key === "4:11")
          .revision.recovery.scopeAdjudication.boxRevision.boxRevision = {};
      });
      expect(verifyExamCorpus(repeated).failures.some((failure) =>
        failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("scope box"))).toBe(true);
    } finally {
      providerMock.complete.mockReset();
      rmSync(repeated.root, { recursive: true, force: true });
    }

    const staleFallback = fixture();
    writeJson(join(
      staleFallback.stateDirs.math,
      "problem-scope-box-revisions",
      `v1-0004-0011-${"1".repeat(64)}.json`,
    ), {});
    expect(verifyExamCorpus(staleFallback).failures.some((failure) =>
      failure.code === "ANSWER_ATTESTATION_MISSING")).toBe(true);

    const terminalChildFallback = fixture();
    const terminalChildSignalDirectory = join(
      terminalChildFallback.stateDirs.math,
      "problem-terminal-fidelity-adjudications",
    );
    mkdirSync(terminalChildSignalDirectory, { recursive: true });
    writeJson(join(
      terminalChildSignalDirectory,
      `v1-0004-0011-${"3".repeat(64)}.json`,
    ), {});
    expect(verificationContractAuditVersionForTest(terminalChildFallback.stateDirs.math)).toBe(5);
    expect(verifyExamCorpus(terminalChildFallback).failures.some((failure) =>
      failure.code === "ANSWER_ATTESTATION_MISSING")).toBe(true);

    const policyFallback = fixture();
    const policySignalDirectory = join(
      policyFallback.stateDirs.math,
      "problem-terminal-fidelity-policy-revisions",
    );
    mkdirSync(policySignalDirectory, { recursive: true });
    writeJson(join(policySignalDirectory, `v1-0004-0011-${"6".repeat(64)}.json`), {});
    expect(verificationContractAuditVersionForTest(policyFallback.stateDirs.math)).toBe(5);
    expect(verifyExamCorpus(policyFallback).failures.some((failure) =>
      failure.code === "ANSWER_ATTESTATION_MISSING")).toBe(true);

    const policySymlinkFallback = fixture();
    const policyOutside = mkdtempSync(join(tmpdir(), "verify-policy-empty-signal-"));
    const policySignalPath = join(
      policySymlinkFallback.stateDirs.math,
      "problem-terminal-fidelity-policy-revisions",
    );
    symlinkSync(policyOutside, policySignalPath);
    expect(verificationContractAuditVersionForTest(policySymlinkFallback.stateDirs.math)).toBe(5);
    expect(verifyExamCorpus(policySymlinkFallback).failures.some((failure) =>
      failure.code === "ANSWER_ATTESTATION_MISSING")).toBe(true);
    rmSync(policySignalPath);
    rmSync(policyOutside, { recursive: true, force: true });

    const emptySymlinkFallback = fixture();
    const outside = mkdtempSync(join(tmpdir(), "verify-scope-box-empty-signal-"));
    const signalPath = join(emptySymlinkFallback.stateDirs.math, "problem-scope-box-revisions");
    symlinkSync(outside, signalPath);
    expect(verifyExamCorpus(emptySymlinkFallback).failures.some((failure) =>
      failure.code === "ANSWER_ATTESTATION_MISSING")).toBe(true);
    rmSync(signalPath);
    rmSync(outside, { recursive: true, force: true });
  }, 180_000);

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

  it("forces current verification for orphan or invalid v2 fidelity authority", () => {
    const orphan = fixture();
    const directory = join(orphan.stateDirs.math, "solution-fidelity-repairs");
    mkdirSync(directory, { recursive: true });
    writeJson(join(
      directory,
      `v2-0001-0001-${"1".repeat(64)}-${"2".repeat(64)}.json`,
    ), {});
    expect(verificationContractAuditVersionForTest(orphan.stateDirs.math)).toBe(5);
    expect(verifyExamCorpus(orphan).ok).toBe(false);

    for (const dangling of [false, true]) {
      const files = fixture();
      const target = mkdtempSync(join(tmpdir(), "verify-v2-fidelity-dir-signal-"));
      if (dangling) rmSync(target, { recursive: true, force: true });
      const signalPath = join(files.stateDirs.math, "solution-fidelity-repairs");
      symlinkSync(target, signalPath);
      try {
        expect(verificationContractAuditVersionForTest(files.stateDirs.math)).toBe(5);
        expect(verifyExamCorpus(files).ok).toBe(false);
      } finally {
        rmSync(signalPath);
        rmSync(target, { recursive: true, force: true });
      }
    }

    const residue = fixture();
    const prior = verificationContractAuditVersionForTest(residue.stateDirs.math);
    const residueDir = join(residue.stateDirs.math, "solution-fidelity-repairs");
    mkdirSync(residueDir, { recursive: true });
    writeFileSync(join(residueDir, "v2-crash-resume.tmp"), "partial immutable write");
    expect(verificationContractAuditVersionForTest(residue.stateDirs.math)).toBe(prior);
  });

  it("forces current verification for orphan or invalid solution source revision authority", () => {
    for (const directory of ["solution-source-revisions", "solution-fidelity-source-revisions"]) {
      const orphan = fixture();
      mkdirSync(join(orphan.stateDirs.math, directory), { recursive: true });
      writeJson(join(orphan.stateDirs.math, directory, `v1-0001-0001-${"1".repeat(64)}-${"2".repeat(64)}.json`), {});
      expect(verificationContractAuditVersionForTest(orphan.stateDirs.math)).toBe(5);
      expect(verifyExamCorpus(orphan).ok).toBe(false);

      for (const dangling of [false, true]) {
        const files = fixture();
        const target = mkdtempSync(join(tmpdir(), "verify-source-revision-dir-signal-"));
        if (dangling) rmSync(target, { recursive: true, force: true });
        const signalPath = join(files.stateDirs.math, directory);
        symlinkSync(target, signalPath);
        try {
          expect(verificationContractAuditVersionForTest(files.stateDirs.math)).toBe(5);
          expect(verifyExamCorpus(files).ok).toBe(false);
        } finally {
          rmSync(signalPath);
          rmSync(target, { recursive: true, force: true });
        }
      }
    }
  });

  it.skipIf(!existsSync(join(Q5525982_STATE, "solution.pdf")))(
    "reconstructs all sixteen forced exact solution repairs and Q40 source revision",
    async () => {
      expect(solutionFalseNegativeRepairAllowlistFingerprint())
        .toBe(canonicalEvidenceHash(SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST));
      expect(solutionFalseNegativeRepairAllowlistFingerprint())
        .toBe("90a2a84b2813204915a0e2df9daceabbd4b3a65e410838c590264752ec3a7015");
      expect(canonicalEvidenceHash([{ ...SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0],
        items: SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0].items.slice(0, 11) }]))
        .toBe("8f780112dc37cf0cd67b29fd3237c36a8a2dad4d81201f5f030a155f2303d8ad");
      expect(SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0].items.map((item) => canonicalEvidenceHash(item)))
        .toEqual([
          "e17b1ed3f0ed2c3c155fee47fd0ce1db65b01aac36ddfc152551839085854980",
          "56be79294489fde849507d2f6a792331d8541e127fa65a42e55e8e3542365dd0",
          "e144bac17721cd9bc5ebf19dbbd0cefbb18975fe80be000a595cdb50b80c2095",
          "612c6ef1b6d77e58c171c3a2c42d6404cd72603a8e4964d2928a5a0344854e74",
          "aaa638b3e3f56ebc38dcc8b1f35bdd40655fc492208761a88305a83db9fb84ee",
          "72443e38d0a07797e7193dda0dd750a1bfda1f8a3f2e898aca2dcda918f719ea",
          "75fdb9bc2568ca86975675c0f079f7f1bc91abb4b1dd1038cc7d92ea512c40b7",
          "54cebc963a81df797998a4e368b9b06e97f16e5dcd4e84bd81e1e9702f83959d",
          "a4bbeb2eedf1e5ce27e51fdd229ed2e9f8b291aa322c4d433cf325122d49b454",
          "55673d5bf35b4ad22deae1b0c20fa9b97a41b4bbed858e5bd5cee992c09fde30",
          "e7132199776a4979ebfd4e0cdc1103556ee7ef3c0b4433a4fa1c916c82693802",
          "5de3213d9a314946ff9cc1e4899ea942a1e77d9fd0ae35971f94763cbba562d2",
          "307af384fd2bce21dbad093f76e4d1ede7f027d108de4fffa8fee3830affd453",
          "95a8609ae3b4486eb2d8d9fb6be4ca975ceb8f18759a48a23bf99ec9016dd023",
          "164a1e36e9d18368e16bab527cb32e1a74a737b3661a109aa80a40c0ed1282c0",
          "4a151d50050918237ce384f106e519a925af67679c3250140131b963dae3d983",
        ]);
      expect(solutionSourceRevisionAllowlistFingerprint())
        .toBe("f4aa29744628e0699be8c1abdcfbc2f330bf4f5376085882ac6cc2d13d529ed3");
      expect(canonicalEvidenceHash(SOLUTION_SOURCE_REVISION_ALLOWLIST[0]))
        .toBe("afaf8a15ee23d5f6bf0d6a3a6ad7c7679a2d15813a23ddfb07f3ca51b43afd7e");
      const seed = async (evidenceSuffix = "") => {
        const stateDir = mkdtempSync(join(tmpdir(), "verify-solution-false-negative-"));
        cpSync(Q5525982_STATE, stateDir, { recursive: true });
        const oldReceiptSha256 = "7e2a247ab9d1e4bed7db8fdd56486cc25b68441ac1213a8cee69391917dabf48";
        const historyName = `v1-${oldReceiptSha256}.json`;
        const migrationName = "v1-26f264ee3533bc89f02589cb2735cc3e03c5d2dd199192708624be0caa6d3fad.json";
        const migratedAttestationName = "v5-55eaaa5a4d9544803c35a918b64b6832a64a962b7e04204d5083d4dc842238aa.json";
        const historyDirectory = join(stateDir, "receipt-history");
        expect(readdirSync(historyDirectory)).toEqual([historyName]);
        const history = JSON.parse(readFileSync(join(historyDirectory, historyName), "utf8"));
        expect(Object.keys(history).sort()).toEqual(["entryId", "receipt", "version"]);
        expect(Object.keys(history.receipt).sort()).toEqual(["path", "sha256", "value"]);
        expect(history).toMatchObject({
          version: 1,
          entryId: "ebsi:5525982",
          receipt: { path: "receipt.json", sha256: oldReceiptSha256 },
        });
        expect(canonicalEvidenceHash(history.receipt.value)).toBe(oldReceiptSha256);
        expect(writeEvidence(join(stateDir, "receipt.json"), history.receipt.value)).toBe(oldReceiptSha256);
        for (const [directory, name] of [
          ["answer-attestation", migratedAttestationName],
          ["migration-plans", migrationName],
          ["migration-commits", migrationName],
          ["receipt-history", historyName],
        ] as const) {
          expect(readdirSync(join(stateDir, directory))).toEqual([name]);
          rmSync(join(stateDir, directory, name));
        }
        const input = q5525982FixtureInputs(stateDir);
        providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
          if (request.schema?.name === "studywork_exam_corpus_solution_fidelity") {
            return { text: JSON.stringify(q5525982FidelityDecisions(request.prompt).map((decision) => ({
              ...decision,
              evidence: `${decision.evidence}${evidenceSuffix}`,
            }))) };
          }
          if (request.schema?.name === "studywork_solution_file_items") {
            const number = Number(request.prompt.match(/printed solution (\d+)/u)?.[1]);
            const key = SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0].items
              .find((item) => Number(item.key.split(":")[1]) === number)?.key ?? `15:${number}`;
            if (number === 40) return { text: JSON.stringify([
              input.solutions.find((solution) => Number(solution.number) === 40),
            ]) };
            return { text: JSON.stringify([q5525982CorrectedSolution(input.solutions, key)]) };
          }
          if (request.schema?.name === "studywork_exam_corpus_semantic_choice_check") {
            const items = JSON.parse(request.prompt.split("Items:\n")[1]) as Array<{ key: string }>;
            return { text: JSON.stringify(items.map(({ key }) => {
              const number = Number(key.split(":")[1]);
              const question = input.classified.find((record) => Number(record.question.number) === number)!.question;
              const solution = input.solutions.find((candidate) => Number(candidate.number) === number)!;
              const resolution = resolveOfficialAnswer(question, solution.answer);
              return {
                key,
                status: "resolved",
                choiceIndex: resolution.choiceIndex! + 1,
                evidence: "frozen official answer resolves one exact choice",
              };
            })) };
          }
          throw new Error(`unexpected AI call: ${request.schema?.name ?? "unknown"}`);
        });
        const result = await repairAndAuditOfficialAnswers(
          input.entry,
          input.problem,
          input.solution,
          stateDir,
          input.classified,
          input.solutions,
        );
        const imported = matchOfficialSolutions(
          input.entry,
          result.classified,
          result.solutions,
          baseDifficultyByQuestionKey(input.classified),
        );
        const receipt = buildCorpusReceipt(
          input.entry,
          input.problem,
          input.solution,
          result.classified,
          imported,
        );
        await writeAnswerAttestation(
          stateDir,
          input.entry.id,
          input.problem.sha256,
          input.solution.sha256,
          receipt,
          result,
        );
        providerMock.complete.mockReset();
        return { stateDir, result };
      };
      const expectedKeys = SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0].items.map((item) => item.key)
        .sort(compareCorpusQuestionKeys);
      const seeded = await seed();
      const valid = seeded.stateDir;
      try {
        expect(verifySolutionFalseNegativeRepairAuthorityForTest(q5525982BaseAuthorityInput(valid)))
          .toEqual(expectedKeys);
        expect(verifyPersistedSolutionFalseNegativeStateForTest(q5525982VerifierAuthorityInput(valid)))
          .toEqual(expectedKeys);
        const currentAuthority = q5525982VerifierAuthorityInput(valid, seeded.result.classified);
        const auditName = readdirSync(join(valid, "answer-audit")).find((name) => /^v5-/u.test(name))!;
        const audit = JSON.parse(readFileSync(join(valid, "answer-audit", auditName), "utf8"));
        expect(verifyCurrentSolutionFidelityForTest({ ...currentAuthority, audit })).toMatchObject({
          solutionRepairKeys: [
            ...expectedKeys,
            SOLUTION_SOURCE_REVISION_ALLOWLIST[0].key,
          ].sort(compareCorpusQuestionKeys),
          effectiveSolutionCorpusHash: audit.effectiveSolutionCorpusHash,
        });
        const repairs = readdirSync(join(valid, "solution-repairs"));
        expect(repairs).toHaveLength(17);
        expect(repairs.filter((name) => /^v2-\d{4}-\d{4}-[a-f0-9]{64}-[a-f0-9]{64}\.json$/u.test(name)))
          .toHaveLength(16);
        const firstRepair = JSON.parse(readFileSync(
          join(valid, "solution-repairs", repairs.find((name) => name.startsWith("v2-"))!),
          "utf8",
        ));
        expect(firstRepair).toMatchObject({ version: 2, authorityKind: "source-literal-replacement" });
        for (const field of ["promptVersion", "promptDigest", "model", "reasoningEffort"]) {
          expect(firstRepair).not.toHaveProperty(field);
        }
        const fidelities = readdirSync(join(valid, "solution-fidelity-repairs")).sort();
        expect(fidelities).toHaveLength(17);
        expect(fidelities.filter((name) => name.startsWith("v1-")))
          .toEqual([
            expect.stringMatching(/^v1-0011-0017-/u),
            expect.stringMatching(/^v1-0025-0040-/u),
          ]);
        expect(fidelities.filter((name) => name.startsWith("v2-"))).toHaveLength(15);
        expect(readdirSync(join(valid, "solution-source-revisions"))).toEqual([
          expect.stringMatching(/^v1-0025-0040-/u),
        ]);
        expect(readdirSync(join(valid, "solution-fidelity-source-revisions"))).toEqual([
          expect.stringMatching(/^v1-0025-0040-/u),
        ]);
        const q18FidelityName = fidelities.find((name) => /^v2-0011-0018-/u.test(name))!;
        const q18Fidelity = JSON.parse(readFileSync(
          join(valid, "solution-fidelity-repairs", q18FidelityName),
          "utf8",
        ));
        expect(q18Fidelity).toMatchObject({
          version: 2,
          authorityKind: "source-literal-fidelity",
          key: "7:18",
          item: {
            answerStatus: "exact",
            explanationStatus: "exact",
            evidence: "SOURCE_LITERAL_REPLACEMENT_AUTHORITY",
          },
        });
        for (const field of ["promptDigest", "model", "reasoningEffort"]) {
          expect(q18Fidelity).not.toHaveProperty(field);
        }
        expect(verifyCurrentSolutionFalseNegativeRepairForTest(
          q5525982CurrentRepairAuthorityInput(valid, "7:18"),
        )).toMatchObject({
          key: "7:18",
          fidelityArtifact: {
            authorityKind: "source-literal-fidelity",
            path: `solution-fidelity-repairs/${q18FidelityName}`,
          },
        });
        const extraDiscriminator = q5525982CurrentRepairAuthorityInput(valid, "7:18");
        (extraDiscriminator.repair.fidelityArtifact as Record<string, unknown>).promptDigest = "0".repeat(64);
        expect(() => verifyCurrentSolutionFalseNegativeRepairForTest(extraDiscriminator))
          .toThrow(/fidelityArtifact has unexpected fields/u);
        expect(verifyCurrentSolutionFalseNegativeRepairForTest(
          q5525982CurrentRepairAuthorityInput(valid, "7:17"),
        )).toMatchObject({
          key: "7:17",
          fidelityArtifact: {
            promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
            path: expect.stringMatching(/^solution-fidelity-repairs\/v1-0011-0017-/u),
          },
        });
        expect(verifyCurrentSolutionFalseNegativeRepairForTest(
          q5525982CurrentRepairAuthorityInput(valid, "15:40"),
        )).toMatchObject({
          key: "15:40",
          sourceRevision: {
            correctionSpecHash: "afaf8a15ee23d5f6bf0d6a3a6ad7c7679a2d15813a23ddfb07f3ca51b43afd7e",
            effectiveSolutionItemHash: "8ca162b33a434c13885293a46cb20351022c07f0d79c1a2d43a407d73c61a69d",
            solutionArtifact: { authorityKind: "source-literal-revision" },
            fidelityArtifact: { authorityKind: "source-literal-revision-fidelity" },
          },
          fidelityArtifact: { authorityKind: "source-literal-revision-fidelity" },
        });
        const sourceRevisionName = readdirSync(join(valid, "solution-source-revisions"))[0];
        const sourceFidelityName = readdirSync(join(valid, "solution-fidelity-source-revisions"))[0];
        expect(`solution-source-revisions/${sourceRevisionName}`).toBe(
          "solution-source-revisions/v1-0025-0040-" +
          "09962f7d4b7ca05fcaec236021792af644c1a3565d8a7c8abecd38e3d4e31c62-" +
          "afaf8a15ee23d5f6bf0d6a3a6ad7c7679a2d15813a23ddfb07f3ca51b43afd7e.json",
        );
        expect(hash(readFileSync(join(valid, "solution-source-revisions", sourceRevisionName))))
          .toBe("5edaf315941096a05c7f77e6e3d2d5af74c01c5602cea3fbaf81b04bee2780f7");
        expect(`solution-fidelity-source-revisions/${sourceFidelityName}`).toBe(
          "solution-fidelity-source-revisions/v1-0025-0040-" +
          "5edaf315941096a05c7f77e6e3d2d5af74c01c5602cea3fbaf81b04bee2780f7-" +
          "afaf8a15ee23d5f6bf0d6a3a6ad7c7679a2d15813a23ddfb07f3ca51b43afd7e.json",
        );
        expect(hash(readFileSync(join(valid, "solution-fidelity-source-revisions", sourceFidelityName))))
          .toBe("09049a9f46f71a25919863a8d74871b96bf179f1387f291b63de710756210801");
        const sourceCases: Array<{
          label: string;
          mutate: (stateDir: string) => void;
          error: RegExp;
        }> = [{
          label: "missing source fidelity",
          mutate: (stateDir) => rmSync(join(stateDir, "solution-fidelity-source-revisions", sourceFidelityName)),
          error: /source revision child coverage/u,
        }, {
          label: "source revision item tamper",
          mutate: (stateDir) => {
            const path = join(stateDir, "solution-source-revisions", sourceRevisionName);
            const checkpoint = JSON.parse(readFileSync(path, "utf8"));
            checkpoint.item.explanation += " altered";
            writeEvidence(path, checkpoint);
          },
          error: /source revision envelope/u,
        }, {
          label: "source fidelity status tamper",
          mutate: (stateDir) => {
            const path = join(stateDir, "solution-fidelity-source-revisions", sourceFidelityName);
            const checkpoint = JSON.parse(readFileSync(path, "utf8"));
            checkpoint.item.explanationStatus = "mismatch";
            writeEvidence(path, checkpoint);
          },
          error: /source revision fidelity envelope/u,
        }, {
          label: "source revision third child",
          mutate: (stateDir) => {
            const name = sourceRevisionName.replace(/-[a-f0-9]{64}\.json$/u, `-${"f".repeat(64)}.json`);
            writeFileSync(
              join(stateDir, "solution-source-revisions", name),
              readFileSync(join(stateDir, "solution-source-revisions", sourceRevisionName)),
            );
          },
          error: /source revision child coverage/u,
        }, {
          label: "source revision leaf symlink",
          mutate: (stateDir) => {
            const path = join(stateDir, "solution-source-revisions", sourceRevisionName);
            renameSync(path, `${path}.tmp`);
            symlinkSync(`${sourceRevisionName}.tmp`, path);
          },
          error: /malformed persisted solution authority/u,
        }, {
          label: "source revision directory symlink",
          mutate: (stateDir) => {
            const directory = join(stateDir, "solution-source-revisions");
            const target = join(stateDir, "solution-source-revisions-target");
            renameSync(directory, target);
            symlinkSync("solution-source-revisions-target", directory);
          },
          error: /directory must be confined and non-symlink/u,
        }, {
          label: "source fidelity directory symlink",
          mutate: (stateDir) => {
            const directory = join(stateDir, "solution-fidelity-source-revisions");
            const target = join(stateDir, "solution-fidelity-source-revisions-target");
            renameSync(directory, target);
            symlinkSync("solution-fidelity-source-revisions-target", directory);
          },
          error: /directory must be confined and non-symlink/u,
        }];
        const q41RepairName = repairs.find((name) => /-0041-/u.test(name))!;
        const q45FidelityName = fidelities.find((name) => /-0045-/u.test(name))!;
        sourceCases.push({
          label: "Q40 pinned fidelity path with alternate SHA",
          mutate: (stateDir) => {
            rmSync(join(stateDir, "solution-source-revisions"), { recursive: true });
            rmSync(join(stateDir, "solution-fidelity-source-revisions"), { recursive: true });
            const path = join(stateDir, SOLUTION_SOURCE_REVISION_ALLOWLIST[0].parentFidelityArtifact.path);
            const checkpoint = JSON.parse(readFileSync(path, "utf8"));
            checkpoint.item.evidence += " alternate";
            writeEvidence(path, checkpoint);
          },
          error: /source revision child coverage|parent fidelity hash mismatch|parent authority/u,
        }, {
          label: "Q40 generic revision XOR",
          mutate: (stateDir) => {
            mkdirSync(join(stateDir, "solution-revisions"), { recursive: true });
            writeEvidence(join(
              stateDir,
              "solution-revisions",
              `v1-0025-0040-${"1".repeat(64)}.json`,
            ), {
              baseRepairArtifact: SOLUTION_SOURCE_REVISION_ALLOWLIST[0].parentRepairArtifact,
            });
          },
          error: /revision child coverage|source revision/u,
        }, {
          label: "Q41 coherent v1 repair",
          mutate: (stateDir) => {
            const path = join(stateDir, "solution-repairs", q41RepairName);
            const checkpoint = JSON.parse(readFileSync(path, "utf8"));
            const v1Name = `v1-${String(checkpoint.basePage).padStart(4, "0")}-` +
              `${checkpoint.printedNumber.padStart(4, "0")}-${checkpoint.baseFidelityCheckpoint.sha256}.json`;
            const { authorityKind: _authorityKind, allowlistId: _allowlistId,
              correctionSpecHash: _correctionSpecHash, ...v1 } = checkpoint;
            Object.assign(v1, {
              version: 1,
              promptVersion: TARGETED_SOLUTION_TRANSCRIPTION_VERSION,
              promptDigest: TARGETED_SOLUTION_PROMPT_DIGEST,
              model: "gpt-5.6-sol",
              reasoningEffort: "high",
            });
            rmSync(path);
            writeEvidence(join(stateDir, "solution-repairs", v1Name), v1);
          },
          error: /deterministic v2|child coverage|version\/path authority/u,
        }, {
          label: "Q45 coherent v1 fidelity",
          mutate: (stateDir) => {
            const path = join(stateDir, "solution-fidelity-repairs", q45FidelityName);
            const checkpoint = JSON.parse(readFileSync(path, "utf8"));
            const v1Name = `v1-${String(checkpoint.basePage).padStart(4, "0")}-` +
              `${checkpoint.printedNumber.padStart(4, "0")}-${checkpoint.baseFidelityCheckpoint.sha256}-` +
              `${checkpoint.effectiveSolutionItemHash}.json`;
            const { authorityKind: _authorityKind, allowlistId: _allowlistId,
              correctionSpecHash: _correctionSpecHash, expectedSolutionItemHash: _expected,
              baseRawAnswerHash: _raw, baseExplanationHash: _explanation, ...v1 } = checkpoint;
            Object.assign(v1, {
              version: 1,
              promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
              model: "gpt-5.6-sol",
              reasoningEffort: "high",
            });
            rmSync(path);
            writeEvidence(join(stateDir, "solution-fidelity-repairs", v1Name), v1);
          },
          error: /deterministic v2|fidelity metadata/u,
        });
        for (const testCase of sourceCases) {
          const tampered = mkdtempSync(join(tmpdir(), "verify-solution-source-revision-"));
          try {
            cpSync(valid, tampered, { recursive: true });
            testCase.mutate(tampered);
            expect(() => verifyPersistedSolutionFalseNegativeStateForTest(
              q5525982VerifierAuthorityInput(tampered),
            ), testCase.label).toThrow(testCase.error);
          } finally {
            rmSync(tampered, { recursive: true, force: true });
          }
        }
        expect(existsSync(join(valid, "solution-revisions"))
          ? readdirSync(join(valid, "solution-revisions")).length
          : 0).toBe(0);
      } finally {
        rmSync(valid, { recursive: true, force: true });
      }

      const alternateSeed = await seed(" alternate diagnostic wording");
      const alternateEvidence = alternateSeed.stateDir;
      try {
        expect(verifySolutionFalseNegativeRepairAuthorityForTest(
          q5525982BaseAuthorityInput(alternateEvidence),
        )).toEqual(expectedKeys);
        expect(verifyPersistedSolutionFalseNegativeStateForTest(
          q5525982VerifierAuthorityInput(alternateEvidence),
        )).toEqual(expectedKeys);
        const checkpoints = SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0].checkpoints.map((checkpoint) => {
          const bytes = readFileSync(join(alternateEvidence, checkpoint.path));
          return { sha256: hash(bytes), canonical: canonicalEvidenceHash(JSON.parse(bytes.toString("utf8"))) };
        });
        expect(checkpoints.every(({ sha256, canonical }) => sha256 === canonical)).toBe(true);
      } finally {
        rmSync(alternateEvidence, { recursive: true, force: true });
      }

      const persistedCases: Array<{
        label: string;
        mutate: (stateDir: string, name: string) => void;
        error: RegExp;
      }> = [{
        label: "same-parent v1 and v2",
        mutate: (stateDir, name) => {
          const repair = JSON.parse(readFileSync(join(stateDir, "solution-repairs", name), "utf8"));
          const v1 = `v1-${String(repair.basePage).padStart(4, "0")}-` +
            `${repair.printedNumber.padStart(4, "0")}-${repair.baseFidelityCheckpoint.sha256}.json`;
          writeFileSync(join(stateDir, "solution-repairs", v1), readFileSync(join(stateDir, "solution-repairs", name)));
        },
        error: /v1\/v2 parent coverage/u,
      }, {
        label: "v2 extra envelope field",
        mutate: (stateDir, name) => {
          const path = join(stateDir, "solution-repairs", name);
          const repair = JSON.parse(readFileSync(path, "utf8"));
          repair.unexpected = true;
          writeEvidence(path, repair);
        },
        error: /repair metadata/u,
      }, {
        label: "v2 dynamic parent filename",
        mutate: (stateDir, name) => {
          const changed = name.replace(
            /-([a-f0-9]{64})-([a-f0-9]{64}\.json)$/u,
            `-${"0".repeat(64)}-$2`,
          );
          renameSync(join(stateDir, "solution-repairs", name), join(stateDir, "solution-repairs", changed));
        },
        error: /filename does not bind|version\/path authority/u,
      }, {
        label: "v2 leaf symlink",
        mutate: (stateDir, name) => {
          const path = join(stateDir, "solution-repairs", name);
          renameSync(path, `${path}.tmp`);
          symlinkSync(`${name}.tmp`, path);
        },
        error: /malformed persisted solution authority/u,
      }, {
        label: "v2 directory symlink",
        mutate: (stateDir) => {
          const directory = join(stateDir, "solution-repairs");
          const target = join(stateDir, "solution-repairs-target");
          renameSync(directory, target);
          symlinkSync("solution-repairs-target", directory);
        },
        error: /directory must be confined and non-symlink/u,
      }];
      for (const testCase of persistedCases) {
        const tampered = (await seed()).stateDir;
        try {
          const name = readdirSync(join(tampered, "solution-repairs")).find((candidate) => /-0017-/u.test(candidate))!;
          testCase.mutate(tampered, name);
          expect(() => verifyPersistedSolutionFalseNegativeStateForTest(q5525982VerifierAuthorityInput(tampered)),
            testCase.label).toThrow(testCase.error);
        } finally {
          rmSync(tampered, { recursive: true, force: true });
        }
      }

      for (const testCase of [{
        label: "semantic status",
        mutate: (checkpoint: Record<string, any>) => { checkpoint.items[0].answerStatus = "mismatch"; },
        error: /semantic projection/u,
      }, {
        label: "semantic source page",
        mutate: (checkpoint: Record<string, any>) => { checkpoint.items[0].sourcePage += 1; },
        error: /semantic projection/u,
      }, {
        label: "semantic key",
        mutate: (checkpoint: Record<string, any>) => {
          checkpoint.items[0].key = "99:99";
          checkpoint.inputs[0].key = "99:99";
        },
        error: /projection|extra key/u,
      }, {
        label: "checkpoint extra field",
        mutate: (checkpoint: Record<string, any>) => { checkpoint.unexpected = true; },
        error: /envelope/u,
      }]) {
        const tampered = (await seed()).stateDir;
        try {
          const path = join(tampered, SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0].checkpoints[0].path);
          const checkpoint = JSON.parse(readFileSync(path, "utf8"));
          testCase.mutate(checkpoint);
          writeEvidence(path, checkpoint);
          expect(() => verifySolutionFalseNegativeRepairAuthorityForTest(
            q5525982BaseAuthorityInput(tampered),
          ), testCase.label).toThrow(testCase.error);
        } finally {
          rmSync(tampered, { recursive: true, force: true });
        }
      }

      const wrongRepair = (await seed()).stateDir;
      try {
        const path = join(wrongRepair, "solution-repairs", readdirSync(join(wrongRepair, "solution-repairs"))
          .find((name) => /-0017-/u.test(name))!);
        const checkpoint = JSON.parse(readFileSync(path, "utf8"));
        checkpoint.item.explanation += " altered";
        writeEvidence(path, checkpoint);
        expect(() => verifyPersistedSolutionFalseNegativeStateForTest(q5525982VerifierAuthorityInput(wrongRepair)))
          .toThrow(/forced false-negative repair item|repair metadata/u);
      } finally {
        rmSync(wrongRepair, { recursive: true, force: true });
      }

      const nonterminal = (await seed()).stateDir;
      try {
        const path = join(nonterminal, "solution-fidelity-repairs", readdirSync(
          join(nonterminal, "solution-fidelity-repairs"),
        ).find((name) => /^v2-\d{4}-0018-/u.test(name))!);
        const checkpoint = JSON.parse(readFileSync(path, "utf8"));
        checkpoint.item.explanationStatus = "mismatch";
        writeEvidence(path, checkpoint);
        expect(() => verifyPersistedSolutionFalseNegativeStateForTest(q5525982VerifierAuthorityInput(nonterminal)))
          .toThrow(/terminal exact\/exact|metadata is stale/u);
      } finally {
        rmSync(nonterminal, { recursive: true, force: true });
      }

      const missing = (await seed()).stateDir;
      try {
        const name = readdirSync(join(missing, "solution-fidelity-repairs"))
          .find((candidate) => /^v2-\d{4}-0018-/u.test(candidate))!;
        rmSync(join(missing, "solution-fidelity-repairs", name));
        expect(() => verifyPersistedSolutionFalseNegativeStateForTest(q5525982VerifierAuthorityInput(missing)))
          .toThrow(/child coverage/u);
      } finally {
        rmSync(missing, { recursive: true, force: true });
      }

      const fidelityCases: Array<{
        label: string;
        mutate: (stateDir: string, name: string) => void;
        error: RegExp;
      }> = [{
        label: "same-parent fidelity v1 and v2",
        mutate: (stateDir, name) => {
          const checkpoint = JSON.parse(readFileSync(
            join(stateDir, "solution-fidelity-repairs", name),
            "utf8",
          ));
          const v1Name = `v1-${String(checkpoint.basePage).padStart(4, "0")}-` +
            `${checkpoint.printedNumber.padStart(4, "0")}-${checkpoint.baseFidelityCheckpoint.sha256}-` +
            `${checkpoint.effectiveSolutionItemHash}.json`;
          writeFileSync(
            join(stateDir, "solution-fidelity-repairs", v1Name),
            readFileSync(join(stateDir, "solution-fidelity-repairs", name)),
          );
        },
        error: /fidelity child coverage/u,
      }, {
        label: "v2 fidelity extra envelope field",
        mutate: (stateDir, name) => {
          const path = join(stateDir, "solution-fidelity-repairs", name);
          const checkpoint = JSON.parse(readFileSync(path, "utf8"));
          checkpoint.unexpected = true;
          writeEvidence(path, checkpoint);
        },
        error: /fidelity metadata/u,
      }, {
        label: "v2 fidelity dynamic repair hash filename",
        mutate: (stateDir, name) => {
          const changed = name.replace(
            /-([a-f0-9]{64})-([a-f0-9]{64}\.json)$/u,
            `-${"0".repeat(64)}-$2`,
          );
          renameSync(
            join(stateDir, "solution-fidelity-repairs", name),
            join(stateDir, "solution-fidelity-repairs", changed),
          );
        },
        error: /fidelity metadata/u,
      }, {
        label: "v2 fidelity leaf symlink",
        mutate: (stateDir, name) => {
          const path = join(stateDir, "solution-fidelity-repairs", name);
          renameSync(path, `${path}.tmp`);
          symlinkSync(`${name}.tmp`, path);
        },
        error: /malformed persisted solution authority/u,
      }, {
        label: "v2 fidelity orphan",
        mutate: (stateDir, name) => {
          const checkpoint = JSON.parse(readFileSync(
            join(stateDir, "solution-fidelity-repairs", name),
            "utf8",
          ));
          checkpoint.repairArtifact.path = "solution-repairs/missing.json";
          const orphanName = name.replace(
            /^(v2-\d{4}-0018-)[a-f0-9]{64}(-[a-f0-9]{64}\.json)$/u,
            `$1${"f".repeat(64)}$2`,
          );
          writeEvidence(join(stateDir, "solution-fidelity-repairs", orphanName), checkpoint);
        },
        error: /orphan persisted solution repair fidelity/u,
      }, {
        label: "v2 fidelity directory symlink",
        mutate: (stateDir) => {
          const directory = join(stateDir, "solution-fidelity-repairs");
          const target = join(stateDir, "solution-fidelity-repairs-target");
          renameSync(directory, target);
          symlinkSync("solution-fidelity-repairs-target", directory);
        },
        error: /directory must be confined and non-symlink/u,
      }];
      for (const testCase of fidelityCases) {
        const tampered = (await seed()).stateDir;
        try {
          const name = readdirSync(join(tampered, "solution-fidelity-repairs"))
            .find((candidate) => /^v2-\d{4}-0018-/u.test(candidate))!;
          testCase.mutate(tampered, name);
          expect(() => verifyPersistedSolutionFalseNegativeStateForTest(
            q5525982VerifierAuthorityInput(tampered),
          ), testCase.label).toThrow(testCase.error);
        } finally {
          rmSync(tampered, { recursive: true, force: true });
        }
      }

      const revision = (await seed()).stateDir;
      try {
        mkdirSync(join(revision, "solution-revisions"), { recursive: true });
        const repair = readdirSync(join(revision, "solution-repairs")).find((name) => /-0017-/u.test(name))!;
        writeJson(join(revision, "solution-revisions", `v1-0011-0017-${"1".repeat(64)}.json`), {
          baseRepairArtifact: { path: `solution-repairs/${repair}`, sha256: "0".repeat(64) },
        });
        expect(() => verifyPersistedSolutionFalseNegativeStateForTest(q5525982VerifierAuthorityInput(revision)))
          .toThrow(/revision child coverage|persisted solution authority/u);
      } finally {
        rmSync(revision, { recursive: true, force: true });
      }

      const extraCheckpoint = (await seed()).stateDir;
      try {
        const checkpoint = SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0].checkpoints[0];
        writeFileSync(join(
          extraCheckpoint,
          "solution-fidelity",
          `v1-0002-${SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0].effectiveProblemCorpusHash}-${"0".repeat(64)}.json`,
        ), readFileSync(join(extraCheckpoint, checkpoint.path)));
        expect(() => verifySolutionFalseNegativeRepairAuthorityForTest(
          q5525982BaseAuthorityInput(extraCheckpoint),
        ))
          .toThrow(/checkpoint current-generation set|path authority/u);
      } finally {
        rmSync(extraCheckpoint, { recursive: true, force: true });
      }
    },
    420_000,
  );

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
