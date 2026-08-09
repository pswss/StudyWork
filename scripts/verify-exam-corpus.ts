#!/usr/bin/env tsx

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gradeAnswer } from "../src/quiz";
import {
  numericPrintedLocator,
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

export const TARGET_SUBJECTS = [
  "수학 - 수학Ⅱ·미적분Ⅰ",
  "수학 - 수학Ⅰ·대수",
  "국어 - 독서",
  "국어 - 문학",
  "과학 - 통합과학 (2022 개정)",
  "사회 - 통합사회 (2022 개정)",
] as const;

type TargetSubject = (typeof TARGET_SUBJECTS)[number];
type SourceSubject = "국어" | "수학" | "통합사회" | "통합과학";
type CanonicalSubject =
  | "korean_reading"
  | "korean_literature"
  | "math_A"
  | "math_B"
  | "integrated_science"
  | "integrated_social";

const TARGET_SET = new Set<string>(TARGET_SUBJECTS);
const TARGET_BY_CANONICAL: Record<CanonicalSubject, TargetSubject> = {
  korean_reading: "국어 - 독서",
  korean_literature: "국어 - 문학",
  math_A: "수학 - 수학Ⅱ·미적분Ⅰ",
  math_B: "수학 - 수학Ⅰ·대수",
  integrated_science: "과학 - 통합과학 (2022 개정)",
  integrated_social: "사회 - 통합사회 (2022 개정)",
};
const CANONICAL_BY_SOURCE: Record<SourceSubject, readonly CanonicalSubject[]> = {
  국어: ["korean_reading", "korean_literature"],
  수학: ["math_A", "math_B"],
  통합과학: ["integrated_science"],
  통합사회: ["integrated_social"],
};
const EXPECTED_SOURCE_QUESTIONS: Record<SourceSubject, number> = {
  국어: 45,
  수학: 30,
  통합과학: 20,
  통합사회: 20,
};

function codes(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(2, "0")}`);
}

const ALLOWED_CODES: Record<CanonicalSubject, Set<string>> = {
  math_A: new Set([
    ...codes("12미적Ⅰ-01-", 4), ...codes("12미적Ⅰ-02-", 10), ...codes("12미적Ⅰ-03-", 6),
    ...codes("12수학Ⅱ01-", 4), ...codes("12수학Ⅱ02-", 11), ...codes("12수학Ⅱ03-", 6),
  ]),
  math_B: new Set([
    ...codes("12대수01-", 8), ...codes("12대수02-", 3), ...codes("12대수03-", 7),
    ...codes("12수학Ⅰ01-", 8), ...codes("12수학Ⅰ02-", 3), ...codes("12수학Ⅰ03-", 8),
  ]),
  korean_reading: new Set([
    ...codes("10공국1-02-", 2), ...codes("10공국2-02-", 3),
    ...[2, 3, 4, 5, 7, 8, 9, 12, 13, 14].map((number) => `12독작01-${String(number).padStart(2, "0")}`),
  ]),
  korean_literature: new Set([
    ...codes("10공국1-05-", 3), ...codes("10공국2-05-", 2), ...codes("12문학01-", 12),
  ]),
  integrated_science: new Set([
    ...codes("10통과1-01-", 4), ...codes("10통과1-02-", 6), ...codes("10통과1-03-", 6),
    ...codes("10통과2-01-", 5), ...codes("10통과2-02-", 6), ...codes("10통과2-03-", 4),
  ]),
  integrated_social: new Set([
    ...codes("10통사1-01-", 2), ...codes("10통사1-02-", 2), ...codes("10통사1-03-", 3),
    ...codes("10통사1-04-", 4), ...codes("10통사1-05-", 3), ...codes("10통사2-01-", 3),
    ...codes("10통사2-02-", 3), ...codes("10통사2-03-", 4), ...codes("10통사2-04-", 3),
    ...codes("10통사2-05-", 3),
  ]),
};

type ManifestEntry = {
  id: string;
  sourceRecordDate: string;
  sourceRecordYear: number;
  sourceRecordMonth: number;
  grade: 1 | 2 | 3;
  subject: SourceSubject;
  examTitle: string;
  rawTitle: string;
  variant: string | null;
  form: "odd" | "even" | null;
  problemPdfUrl: string;
  solutionPdfUrl: string;
  raw: Record<string, unknown>;
};

type Failure = { code: string; message: string; entryId?: string; target?: string; questionId?: number };

export type VerificationReport = {
  ok: boolean;
  manifest: { expected: number; terminal: number; committed: number; filtered: number; review: number };
  questions: { expected: number; actual: number };
  targets: Record<TargetSubject, { expected: number; actual: number }>;
  failureCount: number;
  failures: Failure[];
};

type DownloadEvidence = {
  path: string;
  requestedUrl: string;
  sha256: string;
  bytes: number;
  pageCount: number;
};

type ProblemQuestion = {
  key: string;
  page: number;
  printedNumber: string;
  qtype: "mcq" | "short" | "ox";
  difficulty: "하" | "중" | "상";
  question: string;
  choices: string[] | null;
  answer: string;
  evidence: Record<string, unknown>;
};

type ClassificationEvidence = {
  key: string;
  decision: "accept" | "reject" | "review";
  canonical_subject: CanonicalSubject | null;
  curriculum_course: string | null;
  domain: string | null;
  achievement_codes: string[];
  confidence: number;
  reason_codes: string[];
  transcription_status: "exact" | "mismatch" | "unverifiable";
  transcription_evidence: string;
};

type EvidencePointer = { path: string; sha256: string };

type ClassifiedEvidence = {
  question: ProblemQuestion;
  classification: ClassificationEvidence;
  problemCheckpoint: EvidencePointer;
  classificationCheckpoint: EvidencePointer;
  contextFrom: number;
  contextTo: number;
};

type AcceptedQuestion = ProblemQuestion & {
  baseDifficulty: "하" | "중" | "상";
  target: TargetSubject;
  officialAnswer: string;
  officialRawAnswer: string;
  officialExplanation: string;
  solutionPage: number;
};

type TargetBook = {
  subject: TargetSubject;
  bookTitle: string;
  expectedQuestionCount: number;
  problemR2Key: string;
  solutionR2Key: string;
};

type CorpusFile = {
  id: number;
  book_id: number;
  book_title: string;
  subject_id: number;
  target: string;
  r2_key: string;
  content_hash: string | null;
  page_count: number | null;
  status: string;
};

const MAX_FAILURE_DETAILS = 20;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) throw new Error(`${label} must be a nonempty exact string`);
  return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${label} must be an integer >= ${minimum}`);
  return Number(value);
}

function json(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function canonicalEvidenceHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function compareCorpusQuestionKeys(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

const LEGACY_CLASSIFIER_VERSION = 4;
const CLASSIFIER_VERSION = 5;
const PROBLEM_REPAIR_VERSION = 2;
const CLASSIFICATION_REPAIR_VERSION = 3;
const CURRENT_CLASSIFICATION_REPAIR_VERSION = 4;
const LEGACY_PROBLEM_REPAIR_BATCH_VERSION = 1;
const PROBLEM_REPAIR_BATCH_VERSION = 2;
const CLASSIFICATION_REPAIR_BATCH_VERSION = 1;
const PROBLEM_REVISION_VERSION = 1;
const CLASSIFICATION_REVISION_VERSION = 1;
const CURRENT_CLASSIFICATION_REVISION_VERSION = 2;
const PROBLEM_REVISION_BATCH_VERSION = 1;
const CLASSIFICATION_REVISION_BATCH_VERSION = 1;
const PROBLEM_RECOVERY_VERSION = 1;
const CLASSIFICATION_RECOVERY_VERSION = 1;
const PROBLEM_TERMINAL_RECOVERY_VERSION = 2;
const CLASSIFICATION_TERMINAL_RECOVERY_VERSION = 2;
const PROBLEM_CROP_ADJUDICATION_VERSION = 1;
const CLASSIFICATION_CROP_ADJUDICATION_VERSION = 1;
const PROBLEM_MANUAL_ADJUDICATION_VERSION = 1;
const CLASSIFICATION_MANUAL_ADJUDICATION_VERSION = 1;
const PROBLEM_MANUAL_ADJUDICATION_PROMPT_DIGEST =
  "28434a9872d33e0ef364b6030c6f32b4a51cab9182a9d6c372f225884794d7e9";
const PROBLEM_MANUAL_CORRECTION_DIGEST =
  "a116ca7dd3fb35028db717aac3aa09e78d7c7671ab5ca9ecdaa3364bdb397b46";
const PROBLEM_SCOPE_ADJUDICATION_VERSION = 1;
const PROBLEM_REPAIR_SCOPE_ADJUDICATION_VERSION = 1;
const PROBLEM_SCOPE_ADJUDICATION_PROMPT_DIGEST =
  "cec5be77bf9745d05593e497842a3642c8a30c1ef1105ba1940f0a74fad3124e";
const PROBLEM_REPAIR_SCOPE_ADJUDICATION_PROMPT_DIGEST =
  "cec5be77bf9745d05593e497842a3642c8a30c1ef1105ba1940f0a74fad3124e";
const PROBLEM_CROP_DPI = 300;
const PROBLEM_SLICE_PAGES = 20;
const SOLUTION_SLICE_PAGES = 6;
const SOLUTION_SLICE_STRIDE = 4;
const SOLUTION_FIDELITY_VERSION = 1;
const SOLUTION_FIDELITY_SLICE_PAGES = 22;
const SOLUTION_FIDELITY_SLICE_STRIDE = 18;
const SOLUTION_REPAIR_VERSION = 1;
const SOLUTION_REPAIR_FIDELITY_VERSION = 1;
const SOLUTION_REVISION_VERSION = 1;
const SOLUTION_REVISION_FIDELITY_VERSION = 1;
const PERSISTED_SOLUTION_REPAIR_SEED_VERSION = 1;
const PERSISTED_SOLUTION_REVISION_TRIGGER_VERSION = 1;
const SOLUTION_PROMPT_UPGRADE_VERSION = 1;
const SOLUTION_PROMPT_UPGRADE_FIDELITY_VERSION = 1;
const LEGACY_TARGETED_SOLUTION_REVISION_VERSION = 1;
const LEGACY_TARGETED_SOLUTION_REVISION_PROMPT_DIGEST =
  "d357d4bf715cea8b712b02546272f353c31eb94accfaefa960da616f2abd7884";
const LEGACY_PROBLEM_TERMINAL_FIDELITY_VERSION = 1;
const PROBLEM_TERMINAL_FIDELITY_VERSION = 2;
const PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST =
  "ebb005195877305dc3416d3158d7bd9765c4c7fa425a3e7fd28b46280df2cbf2";
const LEGACY_TRANSCRIPTION_GATE_VERSION = 1;
const LEGACY_TRANSCRIPTION_GATE_RULES = `
Independently compare every supplied transcription with the attached official source pixels. Check the complete shared passage and source material, the full stem, every answer choice and distractor, inequalities, signs, coefficients, exponents, fractions, formulas, tables, qtype, and all figure or visual dependencies including figure_description. Check that box plausibly covers the source problem and figure, without requiring pixel-perfect crop decimals. Do not infer fidelity from plausibility or from the proposed answer. Base the curriculum decision on the source pixels, not on an inaccurate supplied transcription.

Return transcription_status exact only when all source-required content is faithfully represented. Return mismatch when any omission, substitution, changed bound/sign/value/formula/choice, wrong qtype, or inaccurate visual description is visible. Return unverifiable when the pixels or required context do not let you decide confidently; never guess exact. Give concise page-grounded transcription_evidence. Curriculum decision and transcription fidelity are independent, so reject and review items still require this source check.
`.trim();
const LEGACY_TRANSCRIPTION_PROMPT_DIGEST = sha256(
  `${LEGACY_TRANSCRIPTION_GATE_VERSION}\n${LEGACY_TRANSCRIPTION_GATE_RULES}`,
);
const TRANSCRIPTION_GATE_VERSION = 2;
const TRANSCRIPTION_GATE_RULES = `
Independently compare every supplied transcription with the attached official source pixels. Check the complete shared passage and source material, the full stem, every answer choice and distractor, inequalities, signs, coefficients, exponents, fractions, formulas, tables, qtype, and all figure or visual dependencies including figure_description. Check that box plausibly covers the source problem and figure, without requiring pixel-perfect crop decimals. Do not infer fidelity from plausibility or from the proposed answer. Base the curriculum decision on the source pixels, not on an inaccurate supplied transcription.

Any summary, abridgment, omission, or paraphrase is mismatch, even when the question remains solvable. This includes every shared passage sentence, worked example, transition, quotation, annotation, and footnote required by the printed question or source set. Exact preserves the source literally rather than merely preserving meaning.

Visible text, formulas, numbers, and labels must remain literal. Whitespace, layout, and equivalent LaTeX normalization are allowed only when every sign, value, bound, label, and source detail is preserved. Only a genuinely non-text visual glyph may use an accessibility text surrogate, and only when figure_description preserves its identity, occurrence order, orientation, count, and role in the source.

Return transcription_status exact only when all source-required content is faithfully represented. Return mismatch when any omission, substitution, changed bound/sign/value/formula/choice, wrong qtype, or inaccurate visual description is visible. Return unverifiable when the pixels or required context do not let you decide confidently; never guess exact. Give concise page-grounded transcription_evidence. Curriculum decision and transcription fidelity are independent, so reject and review items still require this source check.
`.trim();
const TRANSCRIPTION_PROMPT_DIGEST = sha256(`${TRANSCRIPTION_GATE_VERSION}\n${TRANSCRIPTION_GATE_RULES}`);
const SOLUTION_FIDELITY_RULES = `
Independently compare every supplied accepted official solution with the attached official solution PDF pixels. Report the visible page where that numbered solution starts. Check the supplied raw final answer separately from the complete explanation through its final step. Compare every sign, coefficient, exponent, root index, fraction, formula, table, diagram, and conclusion. LaTeX normalization is allowed only when it preserves every mathematical and Korean source detail.

answerStatus is exact only when an explicit final answer is visible in these pixels and faithfully matches raw_answer; mismatch when a visible official answer differs; not_visible only when no explicit answer is visible in this attached range; unverifiable when pixels are unclear. Do not call a value derived from the reasoning exact. explanationStatus is exact only when the full reasoning is faithful and complete; mismatch for any omission, substitution, changed formula/value, truncated continuation, summary, invented step, or missing source-required table/diagram description; unverifiable when the pixels or continuation context do not support a confident decision. A redundant visual need not be narrated, but explain that it is redundant in evidence. Never guess exact. Give concise page-grounded evidence and keep every input key exactly once.
`.trim();
const SOLUTION_FIDELITY_PROMPT_DIGEST = sha256(
  `${SOLUTION_FIDELITY_VERSION}\n${SOLUTION_FIDELITY_RULES}`,
);
const SEMANTIC_CHOICE_VERSION = 5;
const V4_SEMANTIC_CHOICE_VERSION = 4;
const LEGACY_ANSWER_SEMANTIC_CHOICE_VERSION = 3;
const LEGACY_FILTERED_SEMANTIC_CHOICE_VERSION = 2;
const SEMANTIC_CHOICE_RULES =
  `For each item, use only its official detailed explanation and answer-choice contents to identify the one ` +
  `choice semantically supported by the reasoning. The official answer marker and the problem extractor's answer ` +
  `are intentionally hidden and must not be guessed; ordinal markers inside explanations are redacted. ` +
  `Return ambiguous when the explanation does not establish ` +
  `exactly one choice. choiceIndex is 1-based and evidence must briefly cite the decisive value or conclusion.`;
const SEMANTIC_CHOICE_PROMPT_DIGEST = sha256(`${SEMANTIC_CHOICE_VERSION}\n${SEMANTIC_CHOICE_RULES}`);
const V4_SEMANTIC_CHOICE_PROMPT_DIGEST = sha256(
  `${V4_SEMANTIC_CHOICE_VERSION}\n${SEMANTIC_CHOICE_RULES}`,
);
const LEGACY_ANSWER_SEMANTIC_CHOICE_PROMPT_DIGEST = sha256(
  `${LEGACY_ANSWER_SEMANTIC_CHOICE_VERSION}\n${SEMANTIC_CHOICE_RULES}`,
);
const LEGACY_FILTERED_SEMANTIC_CHOICE_PROMPT_DIGEST = sha256(
  `${LEGACY_FILTERED_SEMANTIC_CHOICE_VERSION}\n${SEMANTIC_CHOICE_RULES}`,
);
const TARGETED_PROBLEM_PROMPT_DIGEST = sha256(
  `${TARGETED_PROBLEM_TRANSCRIPTION_VERSION}\n${TARGETED_PROBLEM_TRANSCRIPTION_RULES}\n${QUIZ_EXTRACT_SPEC}`,
);
const TARGETED_PROBLEM_BATCH_PROMPT_DIGEST = sha256(
  `${TARGETED_PROBLEM_BATCH_VERSION}\n${TARGETED_PROBLEM_BATCH_RULES}\n${QUIZ_EXTRACT_SPEC}`,
);
const TARGETED_PROBLEM_REVISION_PROMPT_DIGEST = sha256(
  `${TARGETED_PROBLEM_REVISION_VERSION}\n${TARGETED_PROBLEM_REVISION_RULES}\n` +
  `${TARGETED_PROBLEM_REVISION_EVIDENCE_PREFIX}\n` +
  `${TARGETED_PROBLEM_TRANSCRIPTION_VERSION}\n${TARGETED_PROBLEM_TRANSCRIPTION_RULES}\n${QUIZ_EXTRACT_SPEC}`,
);
const TARGETED_PROBLEM_BATCH_REVISION_PROMPT_DIGEST = sha256(
  `${TARGETED_PROBLEM_REVISION_VERSION}\n${TARGETED_PROBLEM_REVISION_RULES}\n` +
  `${TARGETED_PROBLEM_REVISION_EVIDENCE_PREFIX}\n` +
  `${TARGETED_PROBLEM_BATCH_VERSION}\n${TARGETED_PROBLEM_BATCH_RULES}\n${QUIZ_EXTRACT_SPEC}`,
);
const TARGETED_PROBLEM_RECOVERY_PROMPT_DIGEST = sha256(
  `${TARGETED_PROBLEM_RECOVERY_VERSION}\n${TARGETED_PROBLEM_RECOVERY_RULES}\n` +
  `${TARGETED_PROBLEM_RECOVERY_EVIDENCE_PREFIX}\n` +
  `${TARGETED_PROBLEM_TRANSCRIPTION_VERSION}\n${TARGETED_PROBLEM_TRANSCRIPTION_RULES}\n${QUIZ_EXTRACT_SPEC}`,
);
const TARGETED_PROBLEM_CROP_ADJUDICATION_PROMPT_DIGEST = sha256(
  `${TARGETED_PROBLEM_CROP_ADJUDICATION_VERSION}\n${TARGETED_PROBLEM_CROP_ADJUDICATION_RULES}\n` +
  `${TARGETED_PROBLEM_CROP_ADJUDICATION_EVIDENCE_PREFIX}\n` +
  `${TARGETED_PROBLEM_TRANSCRIPTION_VERSION}\n${TARGETED_PROBLEM_TRANSCRIPTION_RULES}\n${QUIZ_EXTRACT_SPEC}`,
);
const PROBLEM_CROP_ADJUDICATION_CLASSIFICATION_PROMPT_DIGEST =
  "ed8c7770e965f26cdbfead1b0396c9fdc3c97e0afeb40e0bf654a72894d265c0";
const TARGETED_SOLUTION_PROMPT_DIGEST = sha256(
  `${TARGETED_SOLUTION_TRANSCRIPTION_VERSION}\n${TARGETED_SOLUTION_TRANSCRIPTION_RULES}`,
);
const TARGETED_SOLUTION_REVISION_PROMPT_DIGEST = sha256(
  `${TARGETED_SOLUTION_REVISION_VERSION}\n${TARGETED_SOLUTION_REVISION_RULES}\n` +
  `${TARGETED_SOLUTION_REVISION_EVIDENCE_PREFIX}\n` +
  `${TARGETED_SOLUTION_TRANSCRIPTION_VERSION}\n${TARGETED_SOLUTION_TRANSCRIPTION_RULES}`,
);

const SOLUTION_PROMPT_UPGRADE_ALLOWLIST = [{
  allowlistId: "ebsi-5643102-q1-solution-prompt-upgrade-v1",
  entryId: "ebsi:5643102",
  key: "1:1",
  sourceHash: "1e8a8a8970bafc066a2f556309e0ca3166a713c0c197b3788cdeb43f2d3de3fb",
  legacyRevisionArtifactHash: "c8a642d7741e859cb16a6bd0bf630b0e2c06a165cb75efd0883de3c6bd63bf8b",
  legacyRevisionFidelityArtifactHash: "d314eb6f85339d733bfa98edd2e9e3283252a79bd64989b489a8f9817adb5f71",
  legacyPromptVersion: LEGACY_TARGETED_SOLUTION_REVISION_VERSION,
  legacyPromptDigest: LEGACY_TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
  expectedAnswer: "②",
}] as const;

type ProblemCropAdjudicationSpec = {
  allowlistId: string;
  entryId: string;
  key: string;
  sourcePage: number;
  sourceHash: string;
  views: ReadonlyArray<{
    sourcePage: number;
    label: string;
    rect: readonly [number, number, number, number];
  }>;
  requiredTokens: readonly string[];
};

type ProblemScopeAdjudicationSpec = {
  allowlistId: string;
  entryId: string;
  key: string;
  sourcePage: number;
  sourceHash: string;
  solutionSourceHash: string;
};

type ProblemManualReplacement = {
  field: "question" | "figure_description";
  from: string;
  to: string;
  count: number;
};

type ProblemManualAdjudicationSpec = ProblemCropAdjudicationSpec & {
  parentKind: "recovery" | "crop";
  failedQuestionHash: string;
  failedClassificationHash: string;
  failedClassificationEvidenceHash: string;
  replacements: readonly ProblemManualReplacement[];
  figure?: boolean;
  figureDescription?: string;
  expectedDecision?: "reject";
};

const PROBLEM_SCOPE_ADJUDICATION_ALLOWLIST: readonly ProblemScopeAdjudicationSpec[] = [{
  allowlistId: "ebsi-5577055-q11-scope-v1",
  entryId: "ebsi:5577055",
  key: "4:11",
  sourcePage: 4,
  sourceHash: "b4381bc3b831323375b2c4a25319d308185c930be5d2e3b07dfc28e7646a5fde",
  solutionSourceHash: "1753328f4b4360a9d81312d0d1610c7a11063bbefeeb1e1fd286d54c601ec5fa",
}] as const;

const PROBLEM_REPAIR_SCOPE_ADJUDICATION_ALLOWLIST: readonly ProblemScopeAdjudicationSpec[] = [{
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
}] as const;

const PROBLEM_CROP_ADJUDICATION_ALLOWLIST: readonly ProblemCropAdjudicationSpec[] = [
  {
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
  },
  {
    allowlistId: "ebsi-5594499-q34-p12-p13-v1",
    entryId: "ebsi:5594499",
    key: "13:34",
    sourcePage: 13,
    sourceHash: "0ddccee92ce4e4ba3da53ed253e780cd7b41b5962f7e9761a920079619f81c31",
    views: [
      { sourcePage: 12, label: "p12 left", rect: [0.09, 0.09, 0.51, 0.95] },
      { sourcePage: 12, label: "p12 right", rect: [0.50, 0.09, 0.95, 0.95] },
      { sourcePage: 13, label: "p13 left top", rect: [0.09, 0.06, 0.53, 0.74] },
      { sourcePage: 13, label: "p13 Q34 lower left", rect: [0.09, 0.77, 0.55, 0.98] },
    ],
    requiredTokens: [
      "[34~37]", "(가)", "(나)", "[A]", "[B]", "㉮", "S#58", "S#59", "S#60",
      "ⓐ", "ⓑ", "ⓒ", "ⓓ", "ⓔ", "O.L*", "* O.L", "갑월", "윤씨 부인", "치수", "월선네",
      "김 서방", "박경리, 「토지」", "박경리 원작, 이형우 각색, 「토지」",
      "① 풍자적 서술을 통해 인물의 부정적 행위를 비판하고 있다.",
      "② 작품 밖 서술자를 통해 인물의 내면 심리를 제시하고 있다.",
      "③ 시대적 배경을 제시하여 사회 현실의 문제를 드러내고 있다.",
      "④ 의식의 흐름 기법을 활용하여 인물의 내적 욕망을 드러내고 있다.",
      "⑤ 인물의 과장된 행동을 통해 비극적 분위기의 반전을 꾀하고 있다.",
    ],
  },
] as const;

const Q30_MANUAL_FIGURE_DESCRIPTION =
  "공식 11쪽 오른쪽의 (4)와 (4′) 논증 도식이 좌우로 배치되어 있다. 왼쪽 (4)는 첫째 전제 " +
  "‘만약 p이면 q이다.’와 둘째 전제 ‘p이다.’ 아래에 수평 가로선 하나가 있고, 그 아래 결론 " +
  "‘그러므로 q이다.’가 놓인다. 오른쪽 (4′)는 첫째 전제 ‘p → q’와 둘째 전제 ‘p’ 아래에 수평 " +
  "가로선 하나가 있고, 그 아래 결론 ‘q’가 놓인다. 두 도식 사이에는 왼쪽에서 오른쪽을 가리키는 " +
  "‘⇒’가 하나 있다. 가로선은 총 2개이며 각각 두 전제와 한 결론을 구분한다.";

const Q34_MANUAL_FIGURE_DESCRIPTION =
  "공식 12쪽의 (가)에는 왼쪽 세로 묶음 괄호가 3개 있다. 각 괄호는 세로선 하나와 오른쪽을 향한 " +
  "위·아래 가로 캡 2개로 이루어져 가로 캡은 모두 6개이다. 첫째 [A] 괄호는 ‘마님, 나으리께서 " +
  "드십니다.’부터 ‘치수는 어머니의 흩어진 모습을 본 일이 없었다.’까지를 묶는다. 둘째 ㉮ 괄호는 " +
  "‘앞으로 혼자 있을 수 없는 일이며’부터 ‘신랑감이 필요할 뿐이지요.’까지의 혼사 대화를 묶는다. " +
  "셋째 [B] 괄호는 ‘이듬해 이월달 꽃바람이’부터 ‘불렀을 때 어머니의 눈은 불꽃이 튀는 듯 " +
  "험악했다.’까지의 회상 장면을 묶는다. [A], ㉮, [B] 표지는 각 괄호의 왼쪽에 놓인다.";

const Q8_MANUAL_FIGURE_DESCRIPTION =
  "좌표평면에 함수 $y=f(x)$의 그래프가 그려져 있다. $x$축은 오른쪽, $y$축은 위쪽을 향하는 " +
  "화살표이며 원점 $O=(0,0)$에는 뚫린 점이 표시되어 있다. 왼쪽 위에서 뚫린 원점 $O$까지 " +
  "내려오는 직선 조각과, 뚫린 원점 $O$에서 $(1,2)$의 뚫린 점까지 올라가는 직선 조각이 있다. " +
  "$(1,3)$에는 채운 점이 있다. $y=3$, $y=2$, $y=-3$에서 각각 $y$축과 $x=1$ 사이에 수평 " +
  "점선이 그어져 있고, $x=1$에는 $y=-3$부터 $y=3$까지 수직 점선이 그어져 있다. $x$축에는 " +
  "$1$과 $3$, $y$축에는 $3$, $2$, $-2$, $-3$이 표시되어 있다. $(0,-2)$에는 채운 점이 있고, " +
  "$(1,-3)$에는 뚫린 점이 있다. $(1,-3)$에서 오른쪽 위로 올라가는 직선 조각은 $x$축의 " +
  "$x=3$을 지나며, 그 옆에 $y=f(x)$가 표시되어 있다.";

const Q18_MANUAL_FIGURE_DESCRIPTION =
  "공식 7쪽 18번 본문에는 비문자 도형문자가 정확히 4개 있고, 읽는 순서는 단일, 단일, 복합, " +
  "복합이다. 첫째 단일 도형문자는 호와 두 선분으로 둘러싸인 $T_1$의 곡선삼각형을, 둘째 단일 " +
  "도형문자는 같은 방법으로 만든 $T_2$, $T_3$ 각각의 곡선삼각형을 나타낸다. 각 단일 도형은 " +
  "위 꼭짓점에서 내려오는 좌우 두 선분과, 가운데가 두 끝점보다 위로 볼록한 아래쪽 원호 하나로 " +
  "둘러싸인 한 영역이다. 셋째 복합 도형문자는 $T_1$, $T_2$, $T_3$ 세 단일 영역이 위쪽 하나와 " +
  "아래쪽 좌우 둘로 결합된 $R_1$의 색칠 영역을, 넷째 복합 도형문자는 같은 세 영역의 결합을 " +
  "$R_2$ 안에 반복하는 역할을 한다. 본문의 $\\overset{\\frown}{N_1L_1}$ 호 표기는 정확히 2회이다. " +
  "아래에는 $R_1$, $R_2$, $R_3$ 세 단계 그림이 있다. $R_1$은 정삼각형 $A_1B_1C_1$ 안의 " +
  "$T_1$, $T_2$, $T_3$ 세 회색 곡선삼각형을 보여 준다. $R_2$는 호 " +
  "$\\overset{\\frown}{N_1L_1}$의 이등분점 $A_2$와 $B_2$, $C_2$로 만든 중앙 정삼각형 안에 " +
  "같은 구조를 한 단계 반복하고, $R_3$은 더 작은 중앙 정삼각형 안에 다시 반복한다. 각 그림 " +
  "아래의 $R_1$, $R_2$, $R_3$ 표지와 $R_3$ 오른쪽의 줄임표는 단계와 계속되는 과정을 나타낸다.";

const PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST: readonly ProblemManualAdjudicationSpec[] = [
  {
    allowlistId: "ebsi-5594499-q34-manual-v1",
    entryId: "ebsi:5594499",
    key: "13:34",
    sourcePage: 13,
    sourceHash: "0ddccee92ce4e4ba3da53ed253e780cd7b41b5962f7e9761a920079619f81c31",
    parentKind: "crop",
    failedQuestionHash: "050900567ea5583ed78cf4fbeafc6cc0e014cb3eb480222bcf2cae22ed70ec7b",
    failedClassificationHash: "8fcdb502ffaf611d5fd93f57f583974bbaf453d1ee8fb82ace1e0bab7a3d6737",
    failedClassificationEvidenceHash: "c715e00259263307b62cda0f784b13df3e38bc3c2e088c465de18884d905d8e3",
    views: [...PROBLEM_CROP_ADJUDICATION_ALLOWLIST[1].views],
    requiredTokens: [
      ...PROBLEM_CROP_ADJUDICATION_ALLOWLIST[1].requiredTokens.filter((token) => token !== "갑월"),
      "삼월이", "흩어진 모습", "뚜드려 만든 쇠붙이 같으다", "쌍방이 혼신의 힘으로 겨루는",
      "쾌적해지는", "너 생각", "어머님", "당치 않는 혹", "회피였었고", "할머니는 당혹했다",
      "아씬 절로 가시야겄십니다", "[B]", "O.L*", "왼쪽 세로 묶음 괄호가 3개", "가로 캡은 모두 6개",
    ],
    replacements: [
      { field: "question", from: "나오리께서", to: "나으리께서", count: 2 },
      { field: "question", from: "갑월이", to: "삼월이", count: 1 },
      { field: "question", from: "흐트러진 모습을", to: "흩어진 모습을", count: 1 },
      {
        field: "question",
        from: "‘여전하시다! 언제나 저 모습, 저 눈빛, 대장간에서 수천 번을 두드려 만든 쇠붙이 같다.’",
        to: "‘여전하시다! 언제나 저 모습, 저 눈빛, 대장간에서 수천 번을 뚜드려 만든 쇠붙이 같으다.’",
        count: 1,
      },
      { field: "question", from: "적과 적이 칼이", to: "적과 적의 칼이", count: 1 },
      { field: "question", from: "쌩쌩이 혼신의", to: "쌍방이 혼신의", count: 1 },
      { field: "question", from: "쾌척해지는", to: "쾌적해지는", count: 1 },
      { field: "question", from: "“네 생각이 그렇다면", to: "“너 생각이 그렇다면", count: 1 },
      { field: "question", from: "않으십니까, 어머니.’", to: "않으십니까, 어머님.’", count: 1 },
      {
        field: "question",
        from: "“그럴 리 있겠습니까. 서희에게 당치 않은 흠이 하나 생길 뿐이지요. 서희에게는 유순하고 글이나 읽으며 소일할 신랑감이 필요할 뿐이지요.”",
        to: "‘그럴 리 있겠습니까. 서희에게 당치 않는 혹이 하나 생길 뿐이지요. 서희에게는 유순하고 글이나 읽으며 소일할 신랑감이 필요할 뿐이지요.’",
        count: 1,
      },
      { field: "question", from: "자연스러운 회피였고", to: "자연스러운 회피였었고", count: 1 },
      { field: "question", from: "할머니는 당황했다.", to: "할머니는 당혹했다.", count: 1 },
      {
        field: "question",
        from: "“야싯 절로 가시야겠십니다.”",
        to: "“아씬 절로 가시야겄십니다.”",
        count: 1,
      },
      { field: "question", from: "“어머니!”", to: "“어머님!”", count: 2 },
      { field: "question", from: "\n[B]\n이듬해", to: "\n이듬해", count: 1 },
      {
        field: "question",
        from: "가마가 내려지고 어머니가 뜰에 나섰을 때,",
        to: "가마가 내려지고 어머니가 뜰에 나섰\n[B]\n을 때,",
        count: 1,
      },
      { field: "question", from: "치수의 두 눈에서 O.L*.", to: "치수의 두 눈에서 O.L*", count: 1 },
      { field: "question", from: "- 박경리, 「토지」 -", to: "― 박경리, 「토지」 ―", count: 1 },
      {
        field: "question",
        from: "- 박경리 원작, 이형우 각색, 「토지」 -",
        to: "― 박경리 원작, 이형우 각색, 「토지」 ―",
        count: 1,
      },
    ],
    figure: true,
    figureDescription: Q34_MANUAL_FIGURE_DESCRIPTION,
  },
  {
    allowlistId: "ebsi-5578421-q30-manual-v1",
    entryId: "ebsi:5578421",
    key: "12:30",
    sourcePage: 12,
    sourceHash: "4c9aee0ec0c15f91678bc3c179efb4c781ab0f9023ca2e5347df94060012272e",
    parentKind: "recovery",
    failedQuestionHash: "0bf9903e40726584efe854ea1e91984a7d8f99c4b43ff9529ed75a2903802dfc",
    failedClassificationHash: "f0155898f6972fefa7ce4d18025fbe08a785fdb98d875681173d4d7b6bdd2c32",
    failedClassificationEvidenceHash: "e5ae78fca62817761efa9cefcccb2aabf5a3065c54657878f684f8f14775f1d6",
    views: [
      { sourcePage: 11, label: "p11 full", rect: [0, 0, 1, 1] },
      { sourcePage: 11, label: "p11 right passage", rect: [0.49, 0.08, 0.94, 0.90] },
      { sourcePage: 11, label: "p11 (4) and (4-prime) diagram", rect: [0.50, 0.42, 0.92, 0.60] },
      { sourcePage: 12, label: "p12 Q30", rect: [0.08, 0.04, 0.53, 0.27] },
    ],
    requiredTokens: [
      "[29~34]", "(4)", "(4′)", "⇒", "────────", "㉢ 명제 논리학",
      "30. 윗글의 내용과 일치하지 않는 것은?",
      "③ 주어와 술어로 구성된 모든 문장은 정언 문장이다.",
    ],
    replacements: [
      { field: "question", from: "ⓒ 명제 논리학", to: "㉢ 명제 논리학", count: 1 },
      {
        field: "question",
        from: "(4) 만약 $p$이면 $q$이다.      (4′) $p \\to q$\n$p$이다.                          $p$\n그러므로 $q$이다.                 $q$",
        to: "(4) 만약 $p$이면 $q$이다.      (4′) $p \\to q$\n$p$이다.                  ⇒       $p$\n────────                         ────────\n그러므로 $q$이다.                 $q$",
        count: 1,
      },
    ],
    figure: true,
    figureDescription: Q30_MANUAL_FIGURE_DESCRIPTION,
  },
  {
    allowlistId: "ebsi-5525984-q8-manual-v1",
    entryId: "ebsi:5525984",
    key: "3:8",
    sourcePage: 3,
    sourceHash: "1621eca42821e5feccbb56604249cbcedd8adf6bae6109960f6c790a61c14ec1",
    parentKind: "recovery",
    failedQuestionHash: "9e4b37f842ef38b07710ff9ce1e358d847abadb1f57387c8a3b7174205027a78",
    failedClassificationHash: "7c2ee3c8fc9424599b974e9e0e7f0060099a6d64f94626b976662e5f8e59ef3a",
    failedClassificationEvidenceHash: "ac058745cf4b353b1c20b7faa9ee1f1f1a22221d85d2bf89769aa1eec4f2558e",
    views: [
      { sourcePage: 3, label: "p3 full", rect: [0, 0, 1, 1] },
      { sourcePage: 3, label: "p3 Q8", rect: [0.07, 0.08, 0.51, 0.44] },
      { sourcePage: 3, label: "p3 Q8 graph", rect: [0.18, 0.12, 0.43, 0.32] },
    ],
    requiredTokens: [
      "원점 $O=(0,0)$에는 뚫린 점", "$(0,-2)$에는 채운 점", "$(1,2)$의 뚫린 점",
      "$(1,3)$에는 채운 점", "$(1,-3)$에는 뚫린 점", "\\lim_{x\\to 0^-}", "\\lim_{x\\to 1^+}",
    ],
    replacements: [],
    figure: true,
    figureDescription: Q8_MANUAL_FIGURE_DESCRIPTION,
  },
  {
    allowlistId: "ebsi-5656593-q18-manual-v1",
    entryId: "ebsi:5656593",
    key: "7:18",
    sourcePage: 7,
    sourceHash: "e1b0ffd692634a4a2b1500877691cf0f4ff622fb85c6dd1dba4aff65dfd29e1d",
    parentKind: "recovery",
    failedQuestionHash: "79c49b622b055d72423e33d5a7038766173bf3923cf10d7c15a36a4bd7eb5e9e",
    failedClassificationHash: "c75e05e33c6abf21173ef7e5108ecb13f89ef42fb0a778862cc061ed223efc68",
    failedClassificationEvidenceHash: "40489cac4ba70d49a4e9279053e63a42c3bcb07e2e62e8ae77e96e72a8640dfb",
    views: [
      { sourcePage: 7, label: "p7 full", rect: [0, 0, 1, 1] },
      { sourcePage: 7, label: "p7 Q18 statement", rect: [0.50, 0.09, 0.94, 0.48] },
      { sourcePage: 7, label: "p7 Q18 R1-R3 diagrams", rect: [0.51, 0.42, 0.94, 0.88] },
    ],
    requiredTokens: [
      "호 $\\overset{\\frown}{N_1L_1}$", "호 표기는 정확히 2회",
      "[단일 곡선삼각형 도형문자]", "[세 단일 곡선삼각형이 결합된 복합 도형문자]",
      "읽는 순서는 단일, 단일, 복합, 복합", "$R_1$", "$R_2$", "$R_3$", "$T_1$", "$T_2$", "$T_3$",
      "① $\\dfrac{3(3\\sqrt{3}-\\pi)}{11}$",
      "⑤ $\\dfrac{4(3\\sqrt{3}-\\pi)}{11}$",
    ],
    replacements: [
      {
        field: "question", from: "호 $N_1L_1$", to: "호 $\\overset{\\frown}{N_1L_1}$", count: 2,
      },
      {
        field: "question",
        from: "둘러싸인 부분인 △ 모양의 도형을 $T_1$이라 하자.",
        to: "둘러싸인 부분인 [단일 곡선삼각형 도형문자] 모양의 도형을 $T_1$이라 하자.",
        count: 1,
      },
      {
        field: "question",
        from: "두 선분으로 둘러싸인 부분인 △ 모양의 도형을 각각 $T_2$, $T_3$이라 하자.",
        to: "두 선분으로 둘러싸인 부분인 [단일 곡선삼각형 도형문자] 모양의 도형을 각각 " +
          "$T_2$, $T_3$이라 하자.",
        count: 1,
      },
      {
        field: "question",
        from: "세 도형 $T_1$, $T_2$, $T_3$으로 이루어진 △ 모양의 도형에 색칠하여",
        to: "세 도형 $T_1$, $T_2$, $T_3$으로 이루어진 " +
          "[세 단일 곡선삼각형이 결합된 복합 도형문자] 모양의 도형에 색칠하여",
        count: 1,
      },
      {
        field: "question",
        from: "만들어지는 △ 모양의 도형에 색칠하여",
        to: "만들어지는 [세 단일 곡선삼각형이 결합된 복합 도형문자] 모양의 도형에 색칠하여",
        count: 1,
      },
    ],
    figure: true,
    figureDescription: Q18_MANUAL_FIGURE_DESCRIPTION,
    expectedDecision: "reject",
  },
] as const;

export function manualAdjudicationAllowlistFingerprint(): string {
  return canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST);
}

export function repairScopeAdjudicationAllowlistFingerprint(): string {
  return canonicalEvidenceHash(PROBLEM_REPAIR_SCOPE_ADJUDICATION_ALLOWLIST);
}

export function solutionPromptUpgradeAllowlistFingerprint(): string {
  return canonicalEvidenceHash(SOLUTION_PROMPT_UPGRADE_ALLOWLIST);
}

type VerificationContract = {
  auditVersion: 2 | 3 | 4 | 5;
  attestationVersion: 2 | 3 | 4 | 5;
  classifierVersion: 4 | 5;
  transcriptionGateVersion: 1 | 2;
  transcriptionPromptDigest: string;
  semanticChoiceVersion: 3 | 4 | 5;
  semanticPromptDigest: string;
  problemTerminalFidelityVersion: 1 | 2 | null;
  problemTerminalScopePromptDigest: string | null;
};

const LEGACY_CONTRACT: VerificationContract = {
  auditVersion: 2,
  attestationVersion: 2,
  classifierVersion: LEGACY_CLASSIFIER_VERSION,
  transcriptionGateVersion: LEGACY_TRANSCRIPTION_GATE_VERSION,
  transcriptionPromptDigest: LEGACY_TRANSCRIPTION_PROMPT_DIGEST,
  semanticChoiceVersion: LEGACY_ANSWER_SEMANTIC_CHOICE_VERSION,
  semanticPromptDigest: LEGACY_ANSWER_SEMANTIC_CHOICE_PROMPT_DIGEST,
  problemTerminalFidelityVersion: null,
  problemTerminalScopePromptDigest: null,
};

const V3_CONTRACT: VerificationContract = {
  auditVersion: 3,
  attestationVersion: 3,
  classifierVersion: CLASSIFIER_VERSION,
  transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
  transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
  semanticChoiceVersion: V4_SEMANTIC_CHOICE_VERSION,
  semanticPromptDigest: V4_SEMANTIC_CHOICE_PROMPT_DIGEST,
  problemTerminalFidelityVersion: LEGACY_PROBLEM_TERMINAL_FIDELITY_VERSION,
  problemTerminalScopePromptDigest: null,
};

const V4_CONTRACT: VerificationContract = {
  ...V3_CONTRACT,
  auditVersion: 4,
  attestationVersion: 4,
  problemTerminalFidelityVersion: PROBLEM_TERMINAL_FIDELITY_VERSION,
  problemTerminalScopePromptDigest: PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST,
};

const CURRENT_CONTRACT: VerificationContract = {
  ...V4_CONTRACT,
  auditVersion: 5,
  attestationVersion: 5,
  semanticChoiceVersion: SEMANTIC_CHOICE_VERSION,
  semanticPromptDigest: SEMANTIC_CHOICE_PROMPT_DIGEST,
};

const OFFICIAL_CIRCLED_ANSWERS = "①②③④⑤⑥⑦⑧⑨⑩";
const normalizedAnswerText = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
const strippedChoiceMarker = (value: string) => normalizedAnswerText(value)
  .replace(/^[①-⑩]\s*/, "")
  .replace(/^\d{1,2}\s*(?:\)|\.(?!\d))\s*/, "");

function normalizedChoiceContent(value: string): string {
  let normalized = strippedChoiceMarker(value).trim();
  if (normalized.startsWith("$") && normalized.endsWith("$") && normalized.length >= 2) {
    normalized = normalized.slice(1, -1);
  } else if (normalized.startsWith("\\(") && normalized.endsWith("\\)")) {
    normalized = normalized.slice(2, -2);
  }
  normalized = normalized.replace(/\\(?:dfrac|tfrac)/gu, "\\frac");
  normalized = normalized.replace(
    /\\frac\s*(?:\{([^{}]+)\}|([^\s{}]))\s*(?:\{([^{}]+)\}|([^\s{}]))/gu,
    (_match, numeratorGroup: string | undefined, numeratorToken: string | undefined,
      denominatorGroup: string | undefined, denominatorToken: string | undefined) =>
      `\\frac{${numeratorGroup ?? numeratorToken}}{${denominatorGroup ?? denominatorToken}}`,
  );
  normalized = normalized.replace(
    /\\frac\{([^{}]*?)\\pi\}\{([^{}]+)\}/gu,
    (_match, coefficient: string, denominator: string) =>
      `\\frac{${coefficient.trim() || "1"}}{${denominator}}\\pi`,
  );
  return normalized.toLowerCase().replace(/\s+/gu, "");
}

type OfficialAnswerResolution = {
  storedAnswer: string;
  choiceIndex: number | null;
  mode: "raw" | "choice-content" | "choice-marker";
};

function resolveOfficialAnswerForDb(
  question: { qtype: string; choices: string[] | null; printedNumber?: string },
  rawAnswer: string,
): OfficialAnswerResolution {
  const official = rawAnswer.trim();
  if (question.qtype !== "mcq") return { storedAnswer: official, choiceIndex: null, mode: "raw" };
  const choices = question.choices ?? [];
  const exact = choices.filter((choice) => normalizedAnswerText(choice) === normalizedAnswerText(official));
  if (exact.length === 1) {
    return { storedAnswer: exact[0], choiceIndex: choices.indexOf(exact[0]), mode: "choice-content" };
  }

  const officialContent = normalizedChoiceContent(official);
  const contentMatches = officialContent
    ? choices.filter((choice) => normalizedChoiceContent(choice) === officialContent)
    : [];
  if (contentMatches.length === 1) {
    return {
      storedAnswer: contentMatches[0],
      choiceIndex: choices.indexOf(contentMatches[0]),
      mode: "choice-content",
    };
  }

  const circled = /^(?:정답\s*[:：]?\s*)?([①-⑩])(?:\s*번)?$/.exec(official)?.[1];
  if (circled) {
    const index = OFFICIAL_CIRCLED_ANSWERS.indexOf(circled);
    if (index >= 0 && index < choices.length) {
      return { storedAnswer: official, choiceIndex: index, mode: "choice-marker" };
    }
    throw new Error(`${question.printedNumber ?? "?"}: official MCQ marker is outside choices`);
  }
  const numeric = /^(?:정답\s*[:：]?\s*)?(\d{1,2})(?:\s*번)?$/.exec(official)?.[1];
  if (numeric) {
    const index = Number(numeric) - 1;
    if (index >= 0 && index < choices.length) {
      return { storedAnswer: official, choiceIndex: index, mode: "choice-marker" };
    }
  }
  throw new Error(`${question.printedNumber ?? "?"}: official MCQ answer cannot resolve to choices`);
}

export function officialAnswerForDb(
  question: { qtype: string; choices: string[] | null; printedNumber?: string },
  rawAnswer: string,
): string {
  return resolveOfficialAnswerForDb(question, rawAnswer).storedAnswer;
}

function hashFile(path: string): string {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(descriptor);
  }
}

function entryToken(entry: ManifestEntry): string {
  return sha256(entry.id).slice(0, 24);
}

function subjectToken(subject: TargetSubject): string {
  return sha256(subject).slice(0, 16);
}

function bookTitle(entry: ManifestEntry): string {
  return `${entry.sourceRecordYear}년 · ${entry.rawTitle}`;
}

function emptyTargetCounts(): Record<TargetSubject, { expected: number; actual: number }> {
  return Object.fromEntries(TARGET_SUBJECTS.map((target) => [target, { expected: 0, actual: 0 }])) as Record<
    TargetSubject,
    { expected: number; actual: number }
  >;
}

function parseManifest(path: string): ManifestEntry[] {
  const manifest = object(json(path), "manifest");
  if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw new Error("manifest must have schemaVersion 2 and nonempty entries");
  }
  const seen = new Set<string>();
  const displayTitles = new Set<string>();
  const sourceTitles = new Set<string>();
  const targetTitles = new Set<string>();
  const entries = manifest.entries.map((value, index): ManifestEntry => {
    const raw = object(value, `entries[${index}]`);
    const id = exactString(raw.id, `entries[${index}].id`);
    if (seen.has(id)) throw new Error(`duplicate manifest id: ${id}`);
    seen.add(id);
    const subject = exactString(raw.subject, `entries[${index}].subject`) as SourceSubject;
    if (!(subject in CANONICAL_BY_SOURCE)) throw new Error(`unsupported manifest subject: ${subject}`);
    const grade = integer(raw.grade, `entries[${index}].grade`, 1) as 1 | 2 | 3;
    if (grade > 3) throw new Error(`entries[${index}].grade must be 1, 2, or 3`);
    if ((subject === "통합과학" || subject === "통합사회") && ![1, 2].includes(grade)) {
      throw new Error(`${id}: integrated subjects require source grade 1 or 2`);
    }
    const sourceRecordDate = exactString(raw.sourceRecordDate, `entries[${index}].sourceRecordDate`);
    const sourceRecordYear = integer(raw.sourceRecordYear, `entries[${index}].sourceRecordYear`, 2000);
    const sourceRecordMonth = integer(raw.sourceRecordMonth, `entries[${index}].sourceRecordMonth`, 1);
    if (sourceRecordYear > 2100 || sourceRecordMonth > 12) throw new Error(`${id}: invalid source record year/month`);
    const parsedDate = new Date(`${sourceRecordDate}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceRecordDate) || Number.isNaN(parsedDate.valueOf())
      || parsedDate.toISOString().slice(0, 10) !== sourceRecordDate
      || parsedDate.getUTCFullYear() !== sourceRecordYear || parsedDate.getUTCMonth() + 1 !== sourceRecordMonth) {
      throw new Error(`${id}: invalid sourceRecordDate/year/month`);
    }
    const variant = raw.variant === null ? null : exactString(raw.variant, `entries[${index}].variant`);
    const form = raw.form as "odd" | "even" | null;
    if (form !== null && form !== "odd" && form !== "even") throw new Error(`${id}: invalid form`);
    const entry = {
      id,
      sourceRecordDate,
      sourceRecordYear,
      sourceRecordMonth,
      grade,
      subject,
      examTitle: exactString(raw.examTitle, `entries[${index}].examTitle`),
      rawTitle: exactString(raw.rawTitle, `entries[${index}].rawTitle`),
      variant,
      form,
      problemPdfUrl: exactString(raw.problemPdfUrl, `entries[${index}].problemPdfUrl`),
      solutionPdfUrl: exactString(raw.solutionPdfUrl, `entries[${index}].solutionPdfUrl`),
      raw,
    };
    const title = bookTitle(entry);
    if (displayTitles.has(title)) throw new Error(`duplicate manifest display title: ${title}`);
    displayTitles.add(title);
    const sourceIdentity = `${subject}\0${title}`;
    if (sourceTitles.has(sourceIdentity)) throw new Error(`duplicate manifest source/title identity: ${subject} / ${title}`);
    sourceTitles.add(sourceIdentity);
    for (const canonical of CANONICAL_BY_SOURCE[subject]) {
      const targetIdentity = `${TARGET_BY_CANONICAL[canonical]}\0${title}`;
      if (targetTitles.has(targetIdentity)) throw new Error(`duplicate manifest target/title identity: ${TARGET_BY_CANONICAL[canonical]} / ${title}`);
      targetTitles.add(targetIdentity);
    }
    return entry;
  });

  const summary = manifest.summary && typeof manifest.summary === "object" ? manifest.summary as Record<string, unknown> : null;
  if (summary && summary.entries !== entries.length) throw new Error("manifest summary.entries does not match entries.length");
  if (summary?.bySubject && typeof summary.bySubject === "object") {
    const counts = Object.fromEntries(Object.keys(CANONICAL_BY_SOURCE).map((subject) => [
      subject,
      entries.filter((entry) => entry.subject === subject).length,
    ]));
    for (const [subject, count] of Object.entries(counts)) {
      if ((summary.bySubject as Record<string, unknown>)[subject] !== count) {
        throw new Error(`manifest summary.bySubject.${subject} does not match entries`);
      }
    }
  }
  return entries;
}

type AddFailure = (failure: Failure) => void;

function safeObject(path: string, label: string, entryId: string, add: AddFailure): Record<string, unknown> | null {
  try {
    return object(json(path), label);
  } catch (error) {
    add({ code: "SIDECAR_INVALID", entryId, message: `${label}: ${error instanceof Error ? error.message : String(error)}` });
    return null;
  }
}

function listJson(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => pattern.test(name)).sort();
}

function verifyFile(
  path: string,
  expectedHash: string,
  expectedBytes: number | null,
  code: string,
  entryId: string,
  add: AddFailure,
  hashCache: Map<string, string>,
): void {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error("not a file");
    if (expectedBytes !== null && stat.size !== expectedBytes) throw new Error(`size ${stat.size}, expected ${expectedBytes}`);
    const cacheKey = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    const actualHash = hashCache.get(cacheKey) ?? hashFile(path);
    hashCache.set(cacheKey, actualHash);
    if (actualHash !== expectedHash) throw new Error(`sha256 ${actualHash}, expected ${expectedHash}`);
  } catch (error) {
    add({ code, entryId, message: `${path}: ${error instanceof Error ? error.message : String(error)}` });
  }
}

function parseDownload(
  value: unknown,
  kind: "problem" | "solution",
  expectedUrl: string,
  entryId: string,
  add: AddFailure,
): DownloadEvidence | null {
  try {
    const row = object(value, `${kind} download`);
    const evidence = {
      path: exactString(row.path, `${kind}.path`),
      requestedUrl: exactString(row.requestedUrl, `${kind}.requestedUrl`),
      sha256: exactString(row.sha256, `${kind}.sha256`),
      bytes: integer(row.bytes, `${kind}.bytes`, 1),
      pageCount: integer(row.pageCount, `${kind}.pageCount`, 1),
    };
    if (evidence.path !== `${kind}.pdf`) throw new Error(`${kind}.path must equal ${kind}.pdf`);
    if (evidence.requestedUrl !== expectedUrl) throw new Error(`${kind}.requestedUrl does not match manifest`);
    if (!/^[a-f0-9]{64}$/.test(evidence.sha256)) throw new Error(`${kind}.sha256 is invalid`);
    return evidence;
  } catch (error) {
    add({ code: "DOWNLOAD_EVIDENCE", entryId, message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

function validateRanges(
  ranges: Array<{ from: number; to: number }>,
  pageCount: number,
  label: string,
  entryId: string,
  add: AddFailure,
): void {
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  let covered = 0;
  for (const range of ranges) {
    if (range.from < 1 || range.to < range.from || range.to > pageCount || range.from > covered + 1) {
      add({ code: "CHUNK_COVERAGE", entryId, message: `${label} chunks do not cover pages 1-${pageCount}` });
      return;
    }
    covered = Math.max(covered, range.to);
  }
  if (covered !== pageCount) {
    add({ code: "CHUNK_COVERAGE", entryId, message: `${label} chunks end at ${covered}, expected ${pageCount}` });
  }
}

function parseProblem(value: unknown, label: string): ProblemQuestion {
  const row = object(value, label);
  const rawNumber = row.number;
  const normalizedNumber = exactString(rawNumber, `${label}.number`);
  const number = numericPrintedLocator(normalizedNumber);
  if (number === null) throw new Error(`${label}.number is not a printed integer`);
  const page = integer(row.page, `${label}.page`, 1);
  const qtype = row.qtype;
  if (qtype !== "mcq" && qtype !== "short" && qtype !== "ox") throw new Error(`${label}.qtype is invalid`);
  const difficulty = row.difficulty;
  if (difficulty !== "하" && difficulty !== "중" && difficulty !== "상") {
    throw new Error(`${label}.difficulty is invalid`);
  }
  let choices: string[] | null = null;
  if (row.choices !== null) {
    if (!Array.isArray(row.choices) || row.choices.some((choice) => typeof choice !== "string" || !choice.trim())) {
      throw new Error(`${label}.choices is invalid`);
    }
    choices = (row.choices as string[]).map((choice, index) => exactString(choice, `${label}.choices[${index}]`));
  }
  if ((qtype === "mcq") !== (choices !== null && choices.length >= 2)) {
    throw new Error(`${label}.choices does not match qtype`);
  }
  const question = exactString(row.question, `${label}.question`);
  const answer = exactString(row.answer, `${label}.answer`);
  if (typeof row.explanation !== "string" || row.explanation !== row.explanation.trim()) {
    throw new Error(`${label}.explanation must be a trimmed string`);
  }
  if (typeof row.figure !== "boolean") throw new Error(`${label}.figure must be boolean`);
  let figureDescription: string | null = null;
  if (row.figure) {
    figureDescription = exactString(row.figure_description, `${label}.figure_description`);
  } else if (row.figure_description !== null) {
    throw new Error(`${label}.figure_description must be null without a figure`);
  }
  let box: [number, number] | null = null;
  if (row.figure && Array.isArray(row.box) && row.box.length === 2) {
    const top = Number(row.box[0]);
    const bottom = Number(row.box[1]);
    if (Number.isFinite(top) && Number.isFinite(bottom) && top >= 0 && bottom <= 1 && top < bottom) {
      box = [top, bottom];
    }
  } else if (row.box !== null) {
    throw new Error(`${label}.box is invalid`);
  }
  const normalizedAnswer = qtype === "ox" ? answer.toLowerCase() : answer;
  const evidence = {
    number: normalizedNumber,
    qtype,
    difficulty,
    question,
    choices,
    answer: normalizedAnswer,
    explanation: row.explanation,
    page,
    figure: row.figure,
    figure_description: figureDescription,
    box,
  };
  return {
    key: `${page}:${number}`,
    page,
    printedNumber: String(number),
    qtype,
    difficulty,
    question,
    choices,
    answer: normalizedAnswer,
    evidence,
  };
}

type DecisionSummary = {
  problems: Map<string, ProblemQuestion>;
  accepted: Array<ProblemQuestion & { target: TargetSubject }>;
  rejected: number;
  reviews: number;
  rulesDigest: string | null;
  order: string[];
  records: Map<string, ClassifiedEvidence>;
};

class CorpusValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

function parseClassificationEvidence(
  value: unknown,
  question: ProblemQuestion,
  entry: ManifestEntry,
  label: string,
): ClassificationEvidence {
  const row = object(value, label);
  const key = exactString(row.key, `${label}.key`);
  if (key !== question.key) throw new CorpusValidationError("CLASSIFICATION_INVALID", `${key}: key does not match problem`);
  const decision = row.decision;
  if (decision !== "accept" && decision !== "reject" && decision !== "review") {
    throw new CorpusValidationError("CLASSIFICATION_INVALID", `${key}: invalid decision`);
  }
  const rawCanonical = row.canonical_subject;
  if (rawCanonical !== null
    && (typeof rawCanonical !== "string" || !(rawCanonical in TARGET_BY_CANONICAL))) {
    throw new CorpusValidationError("CLASSIFICATION_INVALID", `${key}: invalid canonical subject`);
  }
  const rawCanonicalSubject = rawCanonical as CanonicalSubject | null;
  const rawCurriculumCourse = row.curriculum_course === null
    ? null
    : exactString(row.curriculum_course, `${label}.curriculum_course`);
  const rawDomain = row.domain === null ? null : exactString(row.domain, `${label}.domain`);
  if (!Array.isArray(row.achievement_codes)
    || row.achievement_codes.some((code) => typeof code !== "string" || !code.trim() || code !== code.trim())) {
    throw new CorpusValidationError("CLASSIFICATION_INVALID", `${key}: invalid achievement codes`);
  }
  if (!Array.isArray(row.reason_codes) || row.reason_codes.length === 0
    || row.reason_codes.some((code) => typeof code !== "string" || !code.trim() || code !== code.trim())) {
    throw new CorpusValidationError("CLASSIFICATION_INVALID", `${key}: invalid reason codes`);
  }
  const transcriptionStatus = row.transcription_status;
  if (transcriptionStatus !== "exact" && transcriptionStatus !== "mismatch"
    && transcriptionStatus !== "unverifiable") {
    throw new CorpusValidationError("TRANSCRIPTION_GATE", `${key}: invalid transcription status`);
  }
  const transcriptionEvidence = exactString(row.transcription_evidence, `${label}.transcription_evidence`);
  const confidence = Number(row.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new CorpusValidationError("CLASSIFICATION_INVALID", `${key}: invalid confidence`);
  }
  const rawAchievementCodes = [...new Set(row.achievement_codes as string[])];
  const reasonCodes = [...new Set(row.reason_codes as string[])];
  const canonicalSubject = decision === "accept" ? rawCanonicalSubject : null;
  const curriculumCourse = decision === "accept" ? rawCurriculumCourse : null;
  const domain = decision === "accept" ? rawDomain : null;
  const achievementCodes = decision === "accept" ? rawAchievementCodes : [];
  if (decision === "accept") {
    if (canonicalSubject === null || !CANONICAL_BY_SOURCE[entry.subject].includes(canonicalSubject)) {
      throw new CorpusValidationError("SUBJECT_EXCLUSION", `${key}: ${String(canonicalSubject)} is outside ${entry.subject}`);
    }
    if ((canonicalSubject === "integrated_science" || canonicalSubject === "integrated_social")
      && ![1, 2].includes(entry.grade)) {
      throw new CorpusValidationError("GRADE_GATE", `${key}: integrated source grade ${entry.grade} is forbidden`);
    }
    if (confidence < 0.9 || curriculumCourse === null || domain === null) {
      throw new CorpusValidationError("CLASSIFICATION_INVALID", `${key}: accept lacks confidence/course/domain evidence`);
    }
    if (achievementCodes.length === 0) {
      throw new CorpusValidationError("CURRICULUM_EXCLUSION", `${key}: accept lacks achievement codes`);
    }
    const invalidCode = achievementCodes.find((code) => !ALLOWED_CODES[canonicalSubject].has(code));
    if (invalidCode) {
      throw new CorpusValidationError("CURRICULUM_EXCLUSION", `${key}: excluded code ${invalidCode}`);
    }
  }
  return {
    key,
    decision,
    canonical_subject: canonicalSubject,
    curriculum_course: curriculumCourse,
    domain,
    achievement_codes: achievementCodes,
    confidence,
    reason_codes: reasonCodes,
    transcription_status: transcriptionStatus,
    transcription_evidence: transcriptionEvidence,
  };
}

function summarizeDecisions(
  records: Map<string, ClassifiedEvidence>,
  order: string[],
  rulesDigest: string | null,
): DecisionSummary {
  const problems = new Map<string, ProblemQuestion>();
  const accepted: DecisionSummary["accepted"] = [];
  let rejected = 0;
  let reviews = 0;
  for (const key of order) {
    const record = records.get(key);
    if (!record) continue;
    problems.set(key, record.question);
    if (record.classification.decision === "accept") {
      accepted.push({
        ...record.question,
        target: TARGET_BY_CANONICAL[record.classification.canonical_subject!],
      });
    } else if (record.classification.decision === "reject") {
      rejected += 1;
    } else {
      reviews += 1;
    }
  }
  return { problems, accepted, rejected, reviews, rulesDigest, order, records };
}

function loadDecisions(
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  terminalDigest: string | null,
  contract: VerificationContract,
  add: AddFailure,
): DecisionSummary {
  const problemDir = join(stateDir, "problem-chunks");
  const classificationDir = join(stateDir, "classification-chunks");
  const problemFiles = listJson(problemDir, /^v2-\d{4}\.json$/);
  const classificationFiles = listJson(
    classificationDir,
    new RegExp(`^v${contract.classifierVersion}-\\d{4}-[a-f0-9]{16}\\.json$`, "u"),
  );
  const records = new Map<string, ClassifiedEvidence>();
  const order: string[] = [];
  const ranges: Array<{ from: number; to: number }> = [];
  const topology: Array<{ from: number; to: number; ownedFrom: number; ownedTo: number }> = [];
  let selectedDigest: string | null = terminalDigest;

  if (problemFiles.length === 0) add({ code: "CHUNK_MISSING", entryId: entry.id, message: "problem chunks are missing" });
  for (const problemName of problemFiles) {
    const index = problemName.slice(3, 7);
    const checkpoint = safeObject(join(problemDir, problemName), problemName, entry.id, add);
    if (!checkpoint) continue;
    let from: number;
    let to: number;
    let chunkProblems: ProblemQuestion[];
    try {
      if (
        checkpoint.version !== 2 || checkpoint.sourceHash !== problemEvidence.sha256
        || checkpoint.model !== "gpt-5.6-sol" || checkpoint.reasoningEffort !== "high"
      ) {
        throw new Error("problem checkpoint metadata does not match download");
      }
      from = integer(checkpoint.from, `${problemName}.from`, 1);
      to = integer(checkpoint.to, `${problemName}.to`, from);
      const ownedFrom = integer(checkpoint.ownedFrom, `${problemName}.ownedFrom`, from);
      const ownedTo = integer(checkpoint.ownedTo, `${problemName}.ownedTo`, ownedFrom);
      if (to > problemEvidence.pageCount || ownedTo > to) throw new Error(`${problemName} page range exceeds source PDF`);
      if (!Array.isArray(checkpoint.items)) throw new Error(`${problemName}.items must be an array`);
      chunkProblems = checkpoint.items.map((item, itemIndex) => parseProblem(item, `${problemName}.items[${itemIndex}]`));
      if (chunkProblems.some((question) => question.page < ownedFrom || question.page > ownedTo)) {
        throw new Error(`${problemName} has a question outside its owned page range`);
      }
      ranges.push({ from: ownedFrom, to: ownedTo });
      topology.push({ from, to, ownedFrom, ownedTo });
    } catch (error) {
      add({ code: "PROBLEM_CHECKPOINT", entryId: entry.id, message: error instanceof Error ? error.message : String(error) });
      continue;
    }

    const candidates = classificationFiles.filter((name) => name.startsWith(`v${contract.classifierVersion}-${index}-`));
    const selected = terminalDigest
      ? candidates.find((name) => name === `v${contract.classifierVersion}-${index}-${terminalDigest}.json`)
      : candidates.length === 1 ? candidates[0] : undefined;
    if (!selected) {
      add({
        code: candidates.length > 1 ? "CLASSIFICATION_AMBIGUOUS" : "CLASSIFICATION_MISSING",
        entryId: entry.id,
        message: `${problemName} has ${candidates.length} usable classification checkpoints`,
      });
      continue;
    }
    const classification = safeObject(join(classificationDir, selected), selected, entry.id, add);
    if (!classification) continue;
    const fileDigest = selected.slice(8, -5);
    try {
      if (
        classification.version !== contract.classifierVersion || classification.sourceHash !== problemEvidence.sha256
        || classification.from !== from || classification.to !== to || classification.rulesDigest !== fileDigest
        || classification.ownedFrom !== checkpoint.ownedFrom || classification.ownedTo !== checkpoint.ownedTo
        || classification.transcriptionGateVersion !== contract.transcriptionGateVersion
        || classification.transcriptionPromptDigest !== contract.transcriptionPromptDigest
        || classification.model !== "gpt-5.6-sol" || classification.reasoningEffort !== "high"
      ) throw new Error(`${selected} metadata does not match problem checkpoint`);
      if (selectedDigest !== null && selectedDigest !== fileDigest) throw new Error(`${selected} rules digest does not match terminal record`);
      selectedDigest = fileDigest;
      if (!Array.isArray(classification.items)) throw new Error(`${selected}.items must be an array`);
      const expectedKeys = new Set(chunkProblems.map((question) => question.key));
      const seen = new Set<string>();
      const byKey = new Map(chunkProblems.map((question) => [question.key, question]));
      const decisionsByKey = new Map<string, ClassificationEvidence>();
      for (const [decisionIndex, value] of classification.items.entries()) {
        const rawDecision = object(value, `${selected}.items[${decisionIndex}]`);
        const key = exactString(rawDecision.key, `${selected}.items[${decisionIndex}].key`);
        if (!expectedKeys.has(key) || seen.has(key)) throw new Error(`${selected} has missing, extra, or duplicate key ${key}`);
        seen.add(key);
        const question = byKey.get(key)!;
        const decision = parseClassificationEvidence(
          rawDecision,
          question,
          entry,
          `${selected}.items[${decisionIndex}]`,
        );
        decisionsByKey.set(key, decision);
      }
      if (seen.size !== expectedKeys.size) throw new Error(`${selected} omits ${expectedKeys.size - seen.size} questions`);
      const problemCheckpoint = {
        path: `problem-chunks/${problemName}`,
        sha256: hashFile(join(problemDir, problemName)),
      };
      const classificationCheckpoint = {
        path: `classification-chunks/${selected}`,
        sha256: hashFile(join(classificationDir, selected)),
      };
      for (const question of chunkProblems) {
        const key = question.key;
        if (records.has(key)) throw new Error(`duplicate extracted question key ${key}`);
        records.set(key, {
          question,
          classification: decisionsByKey.get(key)!,
          problemCheckpoint,
          classificationCheckpoint,
          contextFrom: from,
          contextTo: to,
        });
        order.push(key);
      }
    } catch (error) {
      add({
        code: error instanceof CorpusValidationError ? error.code : "CLASSIFICATION_INVALID",
        entryId: entry.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  order.sort((left, right) => {
    const a = records.get(left)!.question;
    const b = records.get(right)!.question;
    return a.page - b.page || Number(a.printedNumber) - Number(b.printedNumber);
  });
  validateRanges(ranges, problemEvidence.pageCount, "problem", entry.id, add);
  for (const [index, slice] of topology.entries()) {
    const next = topology[index + 1];
    const expectedOwnedFrom = index === 0 ? slice.from : slice.from + 1;
    const expectedOwnedTo = next?.from ?? slice.to;
    if (
      (index === 0 && slice.from !== 1) || (next && next.from !== slice.to - 1)
      || slice.ownedFrom !== expectedOwnedFrom || slice.ownedTo !== expectedOwnedTo
      || (!next && slice.to !== problemEvidence.pageCount)
    ) {
      add({ code: "CHUNK_TOPOLOGY", entryId: entry.id, message: "problem chunks do not have exact two-page-overlap ownership" });
      break;
    }
  }
  const expectedCount = EXPECTED_SOURCE_QUESTIONS[entry.subject];
  const summary = summarizeDecisions(records, order, selectedDigest);
  const printed = new Set([...summary.problems.values()].map((question) => Number(question.printedNumber)));
  if (printed.size !== expectedCount || Array.from({ length: expectedCount }, (_, index) => index + 1).some((number) => !printed.has(number))) {
    add({ code: "PROBLEM_NUMBER_SET", entryId: entry.id, message: `${entry.subject} must contain printed numbers 1-${expectedCount} exactly once` });
  }
  return summary;
}

type OfficialSolution = {
  printedNumber: string;
  rawAnswer: string;
  explanation: string;
  page: number;
  evidence: Record<string, unknown>;
  checkpoint: EvidencePointer;
  contextFrom: number;
  contextTo: number;
  ownedFrom: number;
  ownedTo: number;
};

function loadSolutions(
  stateDir: string,
  entry: ManifestEntry,
  evidence: DownloadEvidence,
  add: AddFailure,
): Map<string, OfficialSolution> {
  const dir = join(stateDir, "solution-chunks");
  const files = listJson(dir, /^v3-\d{4}\.json$/);
  const solutions = new Map<string, OfficialSolution>();
  const ranges: Array<{ from: number; to: number }> = [];
  const topology: Array<{ from: number; to: number; ownedFrom: number; ownedTo: number }> = [];
  if (files.length === 0) add({ code: "CHUNK_MISSING", entryId: entry.id, message: "solution chunks are missing" });
  for (const [fileIndex, name] of files.entries()) {
    if (name !== `v3-${String(fileIndex).padStart(4, "0")}.json`) {
      add({ code: "SOLUTION_TOPOLOGY", entryId: entry.id, message: "solution checkpoint indexes are not contiguous" });
    }
    const checkpoint = safeObject(join(dir, name), name, entry.id, add);
    if (!checkpoint) continue;
    try {
      if (checkpoint.version !== 3 || checkpoint.sourceHash !== evidence.sha256
        || checkpoint.model !== "gpt-5.6-sol" || checkpoint.reasoningEffort !== "high") {
        throw new Error(`${name} metadata does not match solution download/import contract`);
      }
      const from = integer(checkpoint.from, `${name}.from`, 1);
      const to = integer(checkpoint.to, `${name}.to`, from);
      const ownedFrom = integer(checkpoint.ownedFrom, `${name}.ownedFrom`, from);
      const ownedTo = integer(checkpoint.ownedTo, `${name}.ownedTo`, ownedFrom);
      if (to > evidence.pageCount || ownedTo > to) throw new Error(`${name} page range exceeds solution PDF`);
      if (!Array.isArray(checkpoint.items)) throw new Error(`${name}.items must be an array`);
      ranges.push({ from: ownedFrom, to: ownedTo });
      topology.push({ from, to, ownedFrom, ownedTo });
      for (const [index, value] of checkpoint.items.entries()) {
        const item = object(value, `${name}.items[${index}]`);
        const normalizedNumber = exactString(item.number, `${name}.items[${index}].number`);
        const number = numericPrintedLocator(normalizedNumber);
        if (number === null) throw new Error(`${name}.items[${index}].number is invalid`);
        const page = integer(item.page, `${name}.items[${index}].page`, 1);
        if (item.complete !== true || page < ownedFrom || page > ownedTo) {
          throw new Error(`${name}.items[${index}] is incomplete or outside owned start pages`);
        }
        const rawAnswer = exactString(item.answer, `${name}.items[${index}].answer`);
        if (typeof item.explanation !== "string" || item.explanation !== item.explanation.trim()) {
          throw new Error(`${name}.items[${index}].explanation must be a trimmed string`);
        }
        const printedNumber = String(number);
        if (solutions.has(printedNumber)) throw new Error(`duplicate official solution number ${printedNumber}`);
        solutions.set(printedNumber, {
          printedNumber,
          rawAnswer,
          explanation: item.explanation,
          page,
          evidence: {
            number: normalizedNumber,
            answer: rawAnswer,
            explanation: item.explanation,
            page,
            complete: true,
          },
          checkpoint: {
            path: `solution-chunks/${name}`,
            sha256: hashFile(join(dir, name)),
          },
          contextFrom: from,
          contextTo: to,
          ownedFrom,
          ownedTo,
        });
      }
    } catch (error) {
      add({ code: "SOLUTION_CHECKPOINT", entryId: entry.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  validateRanges(ranges, evidence.pageCount, "solution", entry.id, add);
  for (const [index, slice] of topology.entries()) {
    const next = topology[index + 1];
    const expectedFrom = index * SOLUTION_SLICE_STRIDE + 1;
    const expectedTo = Math.min(expectedFrom + SOLUTION_SLICE_PAGES - 1, evidence.pageCount);
    const expectedOwnedTo = next ? next.from - 1 : slice.to;
    if (
      slice.from !== expectedFrom || slice.to !== expectedTo || (next && next.from !== slice.to - 1)
      || slice.ownedFrom !== slice.from || slice.ownedTo !== expectedOwnedTo
      || (!next && slice.to !== evidence.pageCount)
    ) {
      add({ code: "SOLUTION_TOPOLOGY", entryId: entry.id, message: "solution chunks do not have exact 6/4 owned-start coverage" });
      break;
    }
  }
  return solutions;
}

function evidencePointer(value: unknown, label: string): EvidencePointer {
  const row = object(value, label);
  if (Object.keys(row).sort().join(",") !== "path,sha256") throw new Error(`${label} has unexpected fields`);
  const path = exactString(row.path, `${label}.path`);
  const digest = exactString(row.sha256, `${label}.sha256`);
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error(`${label}.sha256 is invalid`);
  if (path.includes("\\") || path.startsWith("/")
    || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label}.path is not a confined relative path`);
  }
  return { path, sha256: digest };
}

function confinedEvidencePath(stateDir: string, pointer: EvidencePointer, label: string): string {
  const root = realpathSync(stateDir);
  const path = resolve(root, pointer.path);
  if (!path.startsWith(`${root}/`)) throw new Error(`${label} escapes entry state`);
  const actual = realpathSync(path);
  if (actual !== path || !statSync(actual).isFile()) throw new Error(`${label} must be a regular non-symlink file`);
  return actual;
}

function readBoundEvidence(stateDir: string, pointer: EvidencePointer, label: string): Record<string, unknown> {
  const path = confinedEvidencePath(stateDir, pointer, label);
  const actualHash = hashFile(path);
  if (actualHash !== pointer.sha256) throw new Error(`${label} file hash mismatch`);
  const value = object(json(path), label);
  if (canonicalEvidenceHash(value) !== actualHash) throw new Error(`${label} is not canonical immutable JSON`);
  return value;
}

function sameEvidencePointer(actual: EvidencePointer, expected: EvidencePointer, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`${label} does not bind the selected base checkpoint`);
}

function semanticExplanationWithoutMarkers(value: string): string {
  return value
    .replace(/\[\s*(?:정답|답)\s*\]\s*(?:[①-⑩]|(?:10|[1-9])(?!\d)(?:\s*번)?)/gu, "[CHOICE MARKER HIDDEN]")
    .replace(/(?:[①-⑩]|(?:10|[1-9])(?!\d))\s*번\s*(?:선택지\s*)?(?:이|가)?\s*(?:정답|답)(?:이다|입니다)?/gu, "[CHOICE MARKER HIDDEN]")
    .replace(/선택지\s*(?:[①-⑩]|(?:10|[1-9])(?!\d))(?:\s*번)?\s*(?:이|가)?\s*(?:정답|답)(?:이다|입니다)?/gu, "[CHOICE MARKER HIDDEN]")
    .replace(/(?:정답|답)\s+(?:[①-⑩]|(?:10|[1-9])(?!\d))\s*번/gu, "[CHOICE MARKER HIDDEN]")
    .replace(/(?:정답|답)\s*(?:은|는|이|가|:|：|=)\s*(?:[①-⑩]|(?:10|[1-9])(?!\d))(?:\s*번)?/gu, "[CHOICE MARKER HIDDEN]")
    .replace(/[①-⑩]/gu, "[CHOICE MARKER HIDDEN]");
}

function applyDeclaredProblemRevision(
  value: unknown,
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  rulesDigest: string,
  base: ClassifiedEvidence,
  currentQuestion: ProblemQuestion,
  currentClassification: ClassificationEvidence,
  expectedProblemRepairArtifact: EvidencePointer,
  expectedClassificationRepairArtifact: EvidencePointer,
  contract: VerificationContract,
): { classified: ClassifiedEvidence; evidence: Record<string, unknown> } {
  const revision = object(value, `${base.question.key}.revision`);
  const key = base.question.key;
  const printedNumber = base.question.printedNumber;
  const sourcePage = base.question.page;
  const baseProblemRepairArtifact = evidencePointer(
    revision.baseProblemRepairArtifact,
    `${key}.revision.baseProblemRepairArtifact`,
  );
  const baseClassificationRepairArtifact = evidencePointer(
    revision.baseClassificationRepairArtifact,
    `${key}.revision.baseClassificationRepairArtifact`,
  );
  sameEvidencePointer(
    baseProblemRepairArtifact,
    expectedProblemRepairArtifact,
    `${key}.revision.baseProblemRepairArtifact`,
  );
  sameEvidencePointer(
    baseClassificationRepairArtifact,
    expectedClassificationRepairArtifact,
    `${key}.revision.baseClassificationRepairArtifact`,
  );
  const diagnosticEvidence = currentClassification.transcription_evidence;
  const diagnosticEvidenceHash = sha256(diagnosticEvidence);
  const baseQuestionHash = canonicalEvidenceHash(currentQuestion.evidence);
  const baseClassificationHash = canonicalEvidenceHash(currentClassification);
  if (revision.diagnosticEvidenceHash !== diagnosticEvidenceHash
    || revision.baseQuestionHash !== baseQuestionHash
    || revision.baseClassificationHash !== baseClassificationHash) {
    throw new Error(`${key}: revision does not bind the first repair diagnostic and effective hashes`);
  }
  const revisionBasisHash = canonicalEvidenceHash({
    baseProblemRepairArtifact,
    baseClassificationRepairArtifact,
    diagnosticEvidenceHash,
    revisionPromptDigest: TARGETED_PROBLEM_REVISION_PROMPT_DIGEST,
  });

  const problemArtifact = evidencePointer(revision.problemArtifact, `${key}.revision.problemArtifact`);
  const expectedProblemPath =
    `problem-revisions/v${PROBLEM_REVISION_VERSION}-${String(sourcePage).padStart(4, "0")}-` +
    `${printedNumber.padStart(4, "0")}-${revisionBasisHash}.json`;
  if (problemArtifact.path !== expectedProblemPath) throw new Error(`${key}: problem revision path is invalid`);
  const problemCheckpoint = readBoundEvidence(stateDir, problemArtifact, `${key} problem revision`);
  const revised = parseProblem(problemCheckpoint.item, `${key} problem revision.item`);
  if (revised.key !== key || revised.page !== sourcePage || revised.printedNumber !== printedNumber) {
    throw new Error(`${key}: problem revision changed page/number identity`);
  }
  const effectiveQuestionHash = canonicalEvidenceHash(revised.evidence);
  const expectedProblemCheckpoint = {
    version: PROBLEM_REVISION_VERSION,
    entryId: entry.id,
    key,
    sourcePage,
    printedNumber,
    contextFrom: base.contextFrom,
    contextTo: base.contextTo,
    sourceHash: problemEvidence.sha256,
    baseProblemRepairArtifact,
    baseClassificationRepairArtifact,
    baseQuestionHash,
    baseClassificationHash,
    diagnosticEvidence,
    diagnosticEvidenceHash,
    promptVersion: TARGETED_PROBLEM_REVISION_VERSION,
    promptDigest: TARGETED_PROBLEM_REVISION_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    item: revised.evidence,
  };
  if (!isDeepStrictEqual(problemCheckpoint, expectedProblemCheckpoint)) {
    throw new Error(`${key}: problem revision metadata/content is stale or incomplete`);
  }

  const classificationArtifactRow = object(
    revision.classificationArtifact,
    `${key}.revision.classificationArtifact`,
  );
  const classificationArtifact = evidencePointer({
    path: classificationArtifactRow.path,
    sha256: classificationArtifactRow.sha256,
  }, `${key}.revision.classificationArtifact`);
  if (classificationArtifactRow.rulesDigest !== rulesDigest
    || classificationArtifactRow.transcriptionGateVersion !== contract.transcriptionGateVersion
    || classificationArtifactRow.transcriptionPromptDigest !== contract.transcriptionPromptDigest
    || classificationArtifactRow.revisionPromptVersion !== TARGETED_PROBLEM_REVISION_VERSION
    || classificationArtifactRow.revisionPromptDigest !== TARGETED_PROBLEM_REVISION_PROMPT_DIGEST) {
    throw new Error(`${key}: classification revision metadata is stale`);
  }
  const expectedClassificationPath =
    `classification-revisions/v${CLASSIFICATION_REVISION_VERSION}-${String(sourcePage).padStart(4, "0")}-` +
    `${printedNumber.padStart(4, "0")}-${problemArtifact.sha256}-${rulesDigest}.json`;
  if (classificationArtifact.path !== expectedClassificationPath) {
    throw new Error(`${key}: classification revision path is invalid`);
  }
  const classificationCheckpoint = readBoundEvidence(
    stateDir,
    classificationArtifact,
    `${key} classification revision`,
  );
  const revisedClassification = parseClassificationEvidence(
    classificationCheckpoint.item,
    revised,
    entry,
    `${key} classification revision.item`,
  );
  if (revisedClassification.transcription_status !== "exact") {
    throw new Error(`${key}: second source-grounded revision is not exact`);
  }
  const effectiveClassificationHash = canonicalEvidenceHash(revisedClassification);
  const expectedClassificationCheckpoint = {
    version: CLASSIFICATION_REVISION_VERSION,
    entryId: entry.id,
    key,
    sourceHash: problemEvidence.sha256,
    contextFrom: base.contextFrom,
    contextTo: base.contextTo,
    problemArtifact,
    baseProblemRepairArtifact,
    baseClassificationRepairArtifact,
    baseQuestionHash,
    baseClassificationHash,
    diagnosticEvidenceHash,
    effectiveQuestionHash,
    classifierVersion: contract.classifierVersion,
    rulesDigest,
    transcriptionGateVersion: contract.transcriptionGateVersion,
    transcriptionPromptDigest: contract.transcriptionPromptDigest,
    revisionPromptVersion: TARGETED_PROBLEM_REVISION_VERSION,
    revisionPromptDigest: TARGETED_PROBLEM_REVISION_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    item: revisedClassification,
  };
  if (!isDeepStrictEqual(classificationCheckpoint, expectedClassificationCheckpoint)) {
    throw new Error(`${key}: classification revision metadata/content is stale or incomplete`);
  }
  const expectedRevision = {
    baseProblemRepairArtifact,
    baseClassificationRepairArtifact,
    problemArtifact,
    classificationArtifact: {
      ...classificationArtifact,
      rulesDigest,
      transcriptionGateVersion: contract.transcriptionGateVersion,
      transcriptionPromptDigest: contract.transcriptionPromptDigest,
      revisionPromptVersion: TARGETED_PROBLEM_REVISION_VERSION,
      revisionPromptDigest: TARGETED_PROBLEM_REVISION_PROMPT_DIGEST,
    },
    diagnosticEvidenceHash,
    baseQuestionHash,
    effectiveQuestionHash,
    baseClassificationHash,
    effectiveClassificationHash,
  };
  if (!isDeepStrictEqual(revision, expectedRevision)) {
    throw new Error(`${key}: revision evidence envelope does not match its exact chain`);
  }
  return {
    classified: {
      question: revised,
      classification: revisedClassification,
      problemCheckpoint: base.problemCheckpoint,
      classificationCheckpoint: base.classificationCheckpoint,
      contextFrom: base.contextFrom,
      contextTo: base.contextTo,
    },
    evidence: expectedRevision,
  };
}

function applyDeclaredRepair(
  value: unknown,
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  rulesDigest: string,
  base: ClassifiedEvidence,
  solution: OfficialSolution,
  contract: VerificationContract,
): ClassifiedEvidence {
  const repair = object(value, "answer audit repair");
  const key = exactString(repair.key, "repair.key");
  const printedNumber = exactString(repair.printedNumber, "repair.printedNumber");
  const sourcePage = integer(repair.sourcePage, "repair.sourcePage", 1);
  const contextFrom = integer(repair.contextFrom, "repair.contextFrom", 1);
  const contextTo = integer(repair.contextTo, "repair.contextTo", contextFrom);
  if (key !== base.question.key || printedNumber !== base.question.printedNumber
    || sourcePage !== base.question.page || solution.printedNumber !== printedNumber) {
    throw new Error(`${key}: repair identity does not match base problem/solution`);
  }
  if (contextFrom !== base.contextFrom || contextTo !== base.contextTo
    || sourcePage < contextFrom || sourcePage > contextTo
    || contextTo - contextFrom + 1 > PROBLEM_SLICE_PAGES) {
    throw new Error(`${key}: repair context does not match its owning bounded base chunk`);
  }
  const baseProblemCheckpoint = evidencePointer(repair.baseProblemCheckpoint, `${key}.baseProblemCheckpoint`);
  const baseClassificationCheckpoint = evidencePointer(
    repair.baseClassificationCheckpoint,
    `${key}.baseClassificationCheckpoint`,
  );
  const baseSolutionCheckpoint = evidencePointer(repair.baseSolutionCheckpoint, `${key}.baseSolutionCheckpoint`);
  sameEvidencePointer(baseProblemCheckpoint, base.problemCheckpoint, `${key}.baseProblemCheckpoint`);
  sameEvidencePointer(baseClassificationCheckpoint, base.classificationCheckpoint, `${key}.baseClassificationCheckpoint`);
  sameEvidencePointer(baseSolutionCheckpoint, solution.checkpoint, `${key}.baseSolutionCheckpoint`);
  for (const [label, pointer] of [
    ["base problem", baseProblemCheckpoint],
    ["base classification", baseClassificationCheckpoint],
    ["base solution", baseSolutionCheckpoint],
  ] as const) {
    const path = confinedEvidencePath(stateDir, pointer, `${key} ${label}`);
    if (hashFile(path) !== pointer.sha256) throw new Error(`${key} ${label} hash mismatch`);
  }

  const baseQuestionHash = canonicalEvidenceHash(base.question.evidence);
  const baseClassificationHash = canonicalEvidenceHash(base.classification);
  const baseSolutionItemHash = canonicalEvidenceHash(solution.evidence);
  const officialRawAnswerHash = sha256(solution.rawAnswer);
  if (repair.baseQuestionHash !== baseQuestionHash
    || repair.baseClassificationHash !== baseClassificationHash
    || repair.baseSolutionItemHash !== baseSolutionItemHash
    || repair.officialRawAnswerHash !== officialRawAnswerHash) {
    throw new Error(`${key}: repair base item hashes do not match immutable checkpoints`);
  }

  const problemArtifact = evidencePointer(repair.problemArtifact, `${key}.problemArtifact`);
  const expectedProblemPath =
    `problem-repairs/v${PROBLEM_REPAIR_VERSION}-${String(sourcePage).padStart(4, "0")}-` +
    `${printedNumber.padStart(4, "0")}.json`;
  if (problemArtifact.path !== expectedProblemPath) throw new Error(`${key}: problem repair path is invalid`);
  const problemCheckpoint = readBoundEvidence(stateDir, problemArtifact, `${key} problem repair`);
  const corrected = parseProblem(problemCheckpoint.item, `${key} problem repair.item`);
  if (corrected.key !== key || corrected.page !== sourcePage || corrected.printedNumber !== printedNumber) {
    throw new Error(`${key}: problem repair changed page/number identity`);
  }
  const effectiveQuestionHash = canonicalEvidenceHash(corrected.evidence);
  const expectedProblemCheckpoint = {
    version: PROBLEM_REPAIR_VERSION,
    entryId: entry.id,
    key,
    sourcePage,
    printedNumber,
    contextFrom,
    contextTo,
    sourceHash: problemEvidence.sha256,
    baseProblemCheckpoint,
    baseQuestionHash,
    baseSolutionCheckpoint,
    baseSolutionItemHash,
    officialRawAnswerHash,
    promptVersion: TARGETED_PROBLEM_TRANSCRIPTION_VERSION,
    promptDigest: TARGETED_PROBLEM_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    item: corrected.evidence,
  };
  if (!isDeepStrictEqual(problemCheckpoint, expectedProblemCheckpoint)) {
    throw new Error(`${key}: problem repair metadata/content is stale or incomplete`);
  }

  const classificationArtifactRow = object(repair.classificationArtifact, `${key}.classificationArtifact`);
  if (Object.keys(classificationArtifactRow).sort().join(",")
    !== "path,rulesDigest,sha256,transcriptionGateVersion,transcriptionPromptDigest") {
    throw new Error(`${key}.classificationArtifact has unexpected fields`);
  }
  const classificationArtifact = evidencePointer({
    path: classificationArtifactRow.path,
    sha256: classificationArtifactRow.sha256,
  }, `${key}.classificationArtifact`);
  if (classificationArtifactRow.rulesDigest !== rulesDigest) {
    throw new Error(`${key}: classification repair rules digest is stale`);
  }
  if (classificationArtifactRow.transcriptionGateVersion !== contract.transcriptionGateVersion
    || classificationArtifactRow.transcriptionPromptDigest !== contract.transcriptionPromptDigest) {
    throw new Error(`${key}: classification repair transcription gate is stale`);
  }
  const expectedClassificationPath =
    `classification-repairs/v${CLASSIFICATION_REPAIR_VERSION}-${String(sourcePage).padStart(4, "0")}-` +
    `${printedNumber.padStart(4, "0")}-${rulesDigest}.json`;
  if (classificationArtifact.path !== expectedClassificationPath) {
    throw new Error(`${key}: classification repair path is invalid`);
  }
  const classificationCheckpoint = readBoundEvidence(
    stateDir,
    classificationArtifact,
    `${key} classification repair`,
  );
  const correctedClassification = parseClassificationEvidence(
    classificationCheckpoint.item,
    corrected,
    entry,
    `${key} classification repair.item`,
  );
  const effectiveClassificationHash = canonicalEvidenceHash(correctedClassification);
  const expectedClassificationCheckpoint = {
    version: CLASSIFICATION_REPAIR_VERSION,
    entryId: entry.id,
    key,
    sourceHash: problemEvidence.sha256,
    contextFrom,
    contextTo,
    problemArtifact,
    baseClassificationCheckpoint,
    baseClassificationHash,
    effectiveQuestionHash,
    classifierVersion: contract.classifierVersion,
    rulesDigest,
    transcriptionGateVersion: contract.transcriptionGateVersion,
    transcriptionPromptDigest: contract.transcriptionPromptDigest,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    item: correctedClassification,
  };
  if (!isDeepStrictEqual(classificationCheckpoint, expectedClassificationCheckpoint)) {
    throw new Error(`${key}: classification repair metadata/content is stale or incomplete`);
  }
  const expectedRepair = {
    key,
    printedNumber,
    sourcePage,
    contextFrom,
    contextTo,
    baseProblemCheckpoint,
    baseClassificationCheckpoint,
    baseSolutionCheckpoint,
    problemArtifact,
    classificationArtifact: {
      ...classificationArtifact,
      rulesDigest,
      transcriptionGateVersion: contract.transcriptionGateVersion,
      transcriptionPromptDigest: contract.transcriptionPromptDigest,
    },
    baseQuestionHash,
    effectiveQuestionHash,
    baseClassificationHash,
    effectiveClassificationHash,
    baseSolutionItemHash,
    officialRawAnswerHash,
  };
  const firstRepair = {
    question: corrected,
    classification: correctedClassification,
    problemCheckpoint: base.problemCheckpoint,
    classificationCheckpoint: base.classificationCheckpoint,
    contextFrom: base.contextFrom,
    contextTo: base.contextTo,
  };
  if (correctedClassification.transcription_status === "exact") {
    if (repair.revision !== undefined) throw new Error(`${key}: exact first repair must not declare a revision`);
    if (!isDeepStrictEqual(repair, expectedRepair)) {
      throw new Error(`${key}: repair evidence envelope does not match artifacts`);
    }
    return firstRepair;
  }
  if (repair.revision === undefined) {
    throw new Error(`${key}: non-exact first repair has no attested second revision`);
  }
  const revised = applyDeclaredProblemRevision(
    repair.revision,
    stateDir,
    entry,
    problemEvidence,
    rulesDigest,
    base,
    corrected,
    correctedClassification,
    problemArtifact,
    classificationArtifact,
    contract,
  );
  const expectedRevisedRepair = { ...expectedRepair, revision: revised.evidence };
  if (!isDeepStrictEqual(repair, expectedRevisedRepair)) {
    throw new Error(`${key}: repair revision envelope does not match its exact chain`);
  }
  return revised.classified;
}

type ProblemTerminalFidelityItem = {
  key: string;
  status: "exact" | "mismatch" | "unverifiable";
  evidence: string;
} & ({
  scopeDecision: "accept" | "reject" | "review";
  scopeConfidence: number;
  scopeEvidence: string;
} | {
  scopeDecision?: never;
  scopeConfidence?: never;
  scopeEvidence?: never;
});

type ProblemTerminalFidelityCheckpoint = EvidencePointer & {
  from: number;
  to: number;
  ownedFrom: number;
  ownedTo: number;
  inputHash: string;
};

type EvidenceCache = Map<string, { pointer: EvidencePointer; value: Record<string, unknown> }>;

function digest(value: unknown, label: string): string {
  const result = exactString(value, label);
  if (!/^[a-f0-9]{64}$/u.test(result)) throw new Error(`${label} is not a sha256 digest`);
  return result;
}

function readBoundEvidenceCached(
  cache: EvidenceCache,
  stateDir: string,
  pointer: EvidencePointer,
  label: string,
): Record<string, unknown> {
  const cached = cache.get(pointer.path);
  if (cached) {
    sameEvidencePointer(pointer, cached.pointer, `${label} cached pointer`);
    return cached.value;
  }
  const value = readBoundEvidence(stateDir, pointer, label);
  cache.set(pointer.path, { pointer, value });
  return value;
}

function problemTerminalFidelityCheckpoint(
  value: unknown,
  label: string,
): ProblemTerminalFidelityCheckpoint {
  const row = object(value, label);
  if (Object.keys(row).sort().join(",") !== "from,inputHash,ownedFrom,ownedTo,path,sha256,to") {
    throw new Error(`${label} has unexpected fields`);
  }
  return {
    ...evidencePointer({ path: row.path, sha256: row.sha256 }, label),
    from: integer(row.from, `${label}.from`, 1),
    to: integer(row.to, `${label}.to`, 1),
    ownedFrom: integer(row.ownedFrom, `${label}.ownedFrom`, 1),
    ownedTo: integer(row.ownedTo, `${label}.ownedTo`, 1),
    inputHash: digest(row.inputHash, `${label}.inputHash`),
  };
}

function expectedProblemFidelitySlices(pageCount: number): Array<{
  index: number;
  from: number;
  to: number;
  ownedFrom: number;
  ownedTo: number;
}> {
  const slices: Array<{ index: number; from: number; to: number }> = [];
  let from = 1;
  while (from <= pageCount) {
    const to = Math.min(pageCount, from + PROBLEM_SLICE_PAGES - 1);
    slices.push({ index: slices.length, from, to });
    if (to === pageCount) break;
    from += PROBLEM_SLICE_PAGES - 2;
  }
  return slices.map((slice, index) => ({
    ...slice,
    ownedFrom: index === 0 ? slice.from : slice.from + 1,
    ownedTo: slices[index + 1]?.from ?? slice.to,
  }));
}

function problemTerminalInput(record: ClassifiedEvidence): Record<string, unknown> {
  return {
    key: record.question.key,
    printed_number: record.question.printedNumber,
    source_page: record.question.page,
    qtype: record.question.qtype,
    question: record.question.question,
    choices: record.question.choices,
    figure: record.question.evidence.figure,
    figure_description: record.question.evidence.figure_description,
    box: record.question.evidence.box,
  };
}

function parseProblemTerminalFidelityItem(
  value: unknown,
  label: string,
  contract: VerificationContract,
): ProblemTerminalFidelityItem {
  const row = object(value, label);
  const scoped = contract.problemTerminalFidelityVersion === PROBLEM_TERMINAL_FIDELITY_VERSION;
  const expectedFields = scoped
    ? "evidence,key,scopeConfidence,scopeDecision,scopeEvidence,status"
    : "evidence,key,status";
  if (Object.keys(row).sort().join(",") !== expectedFields) {
    throw new Error(`${label} has unexpected fields`);
  }
  const status = row.status;
  if (status !== "exact" && status !== "mismatch" && status !== "unverifiable") {
    throw new Error(`${label}.status is invalid`);
  }
  const base = {
    key: exactString(row.key, `${label}.key`),
    status: status as ProblemTerminalFidelityItem["status"],
    evidence: exactString(row.evidence, `${label}.evidence`),
  };
  if (!scoped) return base;
  if (row.scopeDecision !== "accept" && row.scopeDecision !== "reject" && row.scopeDecision !== "review") {
    throw new Error(`${label}.scopeDecision is invalid`);
  }
  if (typeof row.scopeConfidence !== "number" || !Number.isFinite(row.scopeConfidence)
    || row.scopeConfidence < 0 || row.scopeConfidence > 1) {
    throw new Error(`${label}.scopeConfidence is invalid`);
  }
  return {
    ...base,
    scopeDecision: row.scopeDecision,
    scopeConfidence: row.scopeConfidence,
    scopeEvidence: exactString(row.scopeEvidence, `${label}.scopeEvidence`),
  };
}

function verifyProblemTerminalFidelityCheckpoint(
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  effective: DecisionSummary,
  effectiveCorpusHash: string,
  pointer: ProblemTerminalFidelityCheckpoint,
  cache: EvidenceCache,
  contract: VerificationContract,
): ProblemTerminalFidelityItem[] {
  const pathMatch = new RegExp(
    `^problem-terminal-fidelity/v${contract.problemTerminalFidelityVersion}-(\\d{4})-` +
      "([a-f0-9]{64})-([a-f0-9]{64})\\.json$",
    "u",
  ).exec(pointer.path);
  if (!pathMatch || pathMatch[2] !== effectiveCorpusHash || pathMatch[3] !== pointer.inputHash) {
    throw new Error(`${pointer.path}: terminal problem fidelity path is stale`);
  }
  const slice = expectedProblemFidelitySlices(problemEvidence.pageCount)[Number(pathMatch[1])];
  if (!slice || pointer.from !== slice.from || pointer.to !== slice.to
    || pointer.ownedFrom !== slice.ownedFrom || pointer.ownedTo !== slice.ownedTo) {
    throw new Error(`${pointer.path}: terminal problem fidelity slice is invalid`);
  }
  const records = effective.order.map((key) => effective.records.get(key)!)
    .filter((record) => record.question.page >= slice.ownedFrom && record.question.page <= slice.ownedTo);
  if (records.length === 0) throw new Error(`${pointer.path}: terminal problem fidelity slice has no owned questions`);
  const inputs = records.map(problemTerminalInput);
  const inputHash = canonicalEvidenceHash(inputs);
  if (pointer.inputHash !== inputHash) throw new Error(`${pointer.path}: terminal problem fidelity input hash is stale`);
  const checkpoint = readBoundEvidenceCached(cache, stateDir, pointer, pointer.path);
  if (!Array.isArray(checkpoint.inputs) || !Array.isArray(checkpoint.items)) {
    throw new Error(`${pointer.path}: terminal problem fidelity arrays are missing`);
  }
  const expectedKeys = records.map((record) => record.question.key);
  const inputKeys = checkpoint.inputs.map((value, index) =>
    exactString(object(value, `${pointer.path}.inputs[${index}]`).key, `${pointer.path}.inputs[${index}].key`));
  const items = checkpoint.items.map((value, index) =>
    parseProblemTerminalFidelityItem(value, `${pointer.path}.items[${index}]`, contract));
  const itemKeys = items.map((item) => item.key);
  const sortedExpected = [...expectedKeys].sort(compareCorpusQuestionKeys);
  const exactCoverage = (keys: string[]) => keys.length === sortedExpected.length
    && new Set(keys).size === keys.length
    && isDeepStrictEqual([...keys].sort(compareCorpusQuestionKeys), sortedExpected);
  if (!exactCoverage(inputKeys) || !exactCoverage(itemKeys)) {
    throw new Error(`${pointer.path}: terminal problem fidelity child key coverage is not exact`);
  }
  const expectedCheckpoint = {
    version: contract.problemTerminalFidelityVersion,
    entryId: entry.id,
    sourceHash: problemEvidence.sha256,
    from: slice.from,
    to: slice.to,
    ownedFrom: slice.ownedFrom,
    ownedTo: slice.ownedTo,
    effectiveCorpusHash,
    inputHash,
    transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
    transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
    ...(contract.problemTerminalScopePromptDigest === null ? {} : {
      rulesDigest: effective.rulesDigest,
      scopePromptDigest: contract.problemTerminalScopePromptDigest,
    }),
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    inputs,
    items,
  };
  if (!isDeepStrictEqual(checkpoint, expectedCheckpoint)) {
    throw new Error(`${pointer.path}: terminal problem fidelity metadata/input/output is stale`);
  }
  return items;
}

function verifyProblemTerminalFidelity(
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  effective: DecisionSummary,
  audit: Record<string, unknown>,
  cache: EvidenceCache,
  repairKeys: Set<string>,
  contract: VerificationContract,
): { checkpoints: ProblemTerminalFidelityCheckpoint[]; items: ProblemTerminalFidelityItem[] } {
  if (!Array.isArray(audit.problemTerminalFidelityCheckpoints)
    || !Array.isArray(audit.problemTerminalFidelityItems)) {
    throw new Error("answer audit terminal problem fidelity arrays are missing");
  }
  const effectiveCorpusHash = canonicalEvidenceHash(effective.order.map((key) => {
    const record = effective.records.get(key)!;
    return { question: record.question.evidence, classification: record.classification };
  }));
  const expectedSlices = expectedProblemFidelitySlices(problemEvidence.pageCount)
    .filter((slice) => effective.order.some((key) => {
      const page = effective.records.get(key)!.question.page;
      return page >= slice.ownedFrom && page <= slice.ownedTo;
    }));
  const checkpoints = audit.problemTerminalFidelityCheckpoints.map((value, index) =>
    problemTerminalFidelityCheckpoint(value, `problemTerminalFidelityCheckpoints[${index}]`));
  if (checkpoints.length !== expectedSlices.length) {
    throw new Error("terminal problem fidelity checkpoint coverage is incomplete");
  }
  const actualItems = checkpoints.flatMap((pointer) => verifyProblemTerminalFidelityCheckpoint(
    stateDir,
    entry,
    problemEvidence,
    effective,
    effectiveCorpusHash,
    pointer,
    cache,
    contract,
  ));
  const items = audit.problemTerminalFidelityItems.map((value, index) =>
    parseProblemTerminalFidelityItem(value, `problemTerminalFidelityItems[${index}]`, contract));
  const sortedActual = [...actualItems].sort((left, right) => compareCorpusQuestionKeys(left.key, right.key));
  const sortedExpected = [...items].sort((left, right) => compareCorpusQuestionKeys(left.key, right.key));
  const itemByKey = new Map(items.map((item) => [item.key, item]));
  const scopeAdjudicatedKeys = new Set<string>();
  if (Array.isArray(audit.repairs)) {
    for (const [index, value] of audit.repairs.entries()) {
      const repair = object(value, `answer audit repairs[${index}]`);
      if (repair.scopeAdjudication !== undefined) {
        scopeAdjudicatedKeys.add(exactString(repair.key, `answer audit repairs[${index}].key`));
      }
      if (repair.revision === undefined) continue;
      const revision = object(repair.revision, `answer audit repairs[${index}].revision`);
      if (revision.recovery === undefined) continue;
      const recovery = object(revision.recovery, `answer audit repairs[${index}].revision.recovery`);
      if (recovery.scopeAdjudication !== undefined || recovery.manualAdjudication !== undefined) {
        scopeAdjudicatedKeys.add(exactString(repair.key, `answer audit repairs[${index}].key`));
      }
    }
  }
  const policyInvalid = effective.order.some((key) => {
    const record = effective.records.get(key)!;
    const item = itemByKey.get(key);
    if (!item) return true;
    if (record.classification.transcription_status === "exact") {
      return item.status !== "exact" || (scopeAdjudicatedKeys.has(key)
        ? item.scopeDecision !== record.classification.decision || item.scopeConfidence < 0.9
        :
        contract.problemTerminalFidelityVersion === PROBLEM_TERMINAL_FIDELITY_VERSION
        && record.classification.decision === "accept"
        && (item.scopeDecision !== "accept" || item.scopeConfidence < 0.9));
    }
    return contract.problemTerminalFidelityVersion !== PROBLEM_TERMINAL_FIDELITY_VERSION
      || repairKeys.has(key)
      || record.classification.decision !== "reject"
      || record.classification.transcription_status !== "mismatch"
      || item.status !== "mismatch"
      || item.scopeDecision !== "reject"
      || item.scopeConfidence < 0.9;
  });
  if (new Set(actualItems.map((item) => item.key)).size !== effective.order.length
    || actualItems.length !== effective.order.length
    || !isDeepStrictEqual(sortedActual, sortedExpected)
    || policyInvalid) {
    throw new Error(
      "terminal problem fidelity must cover every source key exactly once and satisfy exact-or-independent-reject policy",
    );
  }
  if (!isDeepStrictEqual(checkpoints, audit.problemTerminalFidelityCheckpoints)
    || !isDeepStrictEqual(items, audit.problemTerminalFidelityItems)) {
    throw new Error("terminal problem fidelity evidence envelope is not exact");
  }
  return { checkpoints, items };
}

type V3RepairRow = {
  raw: Record<string, unknown>;
  key: string;
  printedNumber: string;
  sourcePage: number;
  contextFrom: number;
  contextTo: number;
  base: ClassifiedEvidence;
  solution: OfficialSolution;
  baseProblemCheckpoint: EvidencePointer;
  baseClassificationCheckpoint: EvidencePointer;
  baseSolutionCheckpoint: EvidencePointer;
  problemArtifact: EvidencePointer;
  problemArtifactItemHash: string;
  classificationArtifact: EvidencePointer;
  classificationArtifactEnvelope: Record<string, unknown>;
  classificationArtifactItemHash: string;
  baseQuestionHash: string;
  baseClassificationHash: string;
  baseSolutionItemHash: string;
  officialRawAnswerHash: string;
};

type V3FirstRepair = {
  row: V3RepairRow;
  classified: ClassifiedEvidence;
  evidence: Record<string, unknown>;
  preScopeClassified?: ClassifiedEvidence;
  scopeAdjudicationGeneration?: {
    key: string;
    current: ClassifiedEvidence;
    checkpoint: ProblemTerminalFidelityCheckpoint;
  };
};

function groupByArtifact<T>(
  values: T[],
  pointer: (value: T) => EvidencePointer,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  const hashes = new Map<string, string>();
  for (const value of values) {
    const artifact = pointer(value);
    const priorHash = hashes.get(artifact.path);
    if (priorHash !== undefined && priorHash !== artifact.sha256) {
      throw new Error(`${artifact.path}: shared artifact has conflicting whole-file hashes`);
    }
    hashes.set(artifact.path, artifact.sha256);
    const group = groups.get(artifact.path) ?? [];
    group.push(value);
    groups.set(artifact.path, group);
  }
  return groups;
}

function prepareV3RepairRows(
  values: unknown[],
  stateDir: string,
  base: DecisionSummary,
  solutions: Map<string, OfficialSolution>,
): V3RepairRow[] {
  const seen = new Set<string>();
  return values.map((value, index) => {
    const raw = object(value, `answer audit repairs[${index}]`);
    const key = exactString(raw.key, `answer audit repairs[${index}].key`);
    if (seen.has(key)) throw new Error(`duplicate declared repair: ${key}`);
    seen.add(key);
    const baseRecord = base.records.get(key);
    if (!baseRecord) throw new Error(`${key}: repair has no base problem`);
    const solution = solutions.get(baseRecord.question.printedNumber);
    if (!solution) throw new Error(`${key}: repair has no base official solution`);
    const printedNumber = exactString(raw.printedNumber, `${key}.printedNumber`);
    const sourcePage = integer(raw.sourcePage, `${key}.sourcePage`, 1);
    const contextFrom = integer(raw.contextFrom, `${key}.contextFrom`, 1);
    const contextTo = integer(raw.contextTo, `${key}.contextTo`, contextFrom);
    if (key !== baseRecord.question.key || printedNumber !== baseRecord.question.printedNumber
      || sourcePage !== baseRecord.question.page || printedNumber !== solution.printedNumber
      || contextFrom !== baseRecord.contextFrom || contextTo !== baseRecord.contextTo
      || sourcePage < contextFrom || sourcePage > contextTo
      || contextTo - contextFrom + 1 > PROBLEM_SLICE_PAGES) {
      throw new Error(`${key}: repair identity/context does not match its immutable base evidence`);
    }
    const baseProblemCheckpoint = evidencePointer(raw.baseProblemCheckpoint, `${key}.baseProblemCheckpoint`);
    const baseClassificationCheckpoint = evidencePointer(
      raw.baseClassificationCheckpoint,
      `${key}.baseClassificationCheckpoint`,
    );
    const baseSolutionCheckpoint = evidencePointer(raw.baseSolutionCheckpoint, `${key}.baseSolutionCheckpoint`);
    sameEvidencePointer(baseProblemCheckpoint, baseRecord.problemCheckpoint, `${key}.baseProblemCheckpoint`);
    sameEvidencePointer(
      baseClassificationCheckpoint,
      baseRecord.classificationCheckpoint,
      `${key}.baseClassificationCheckpoint`,
    );
    sameEvidencePointer(baseSolutionCheckpoint, solution.checkpoint, `${key}.baseSolutionCheckpoint`);
    for (const [label, pointer] of [
      ["base problem", baseProblemCheckpoint],
      ["base classification", baseClassificationCheckpoint],
      ["base solution", baseSolutionCheckpoint],
    ] as const) {
      const path = confinedEvidencePath(stateDir, pointer, `${key} ${label}`);
      if (hashFile(path) !== pointer.sha256) throw new Error(`${key} ${label} hash mismatch`);
    }
    const baseQuestionHash = canonicalEvidenceHash(baseRecord.question.evidence);
    const baseClassificationHash = canonicalEvidenceHash(baseRecord.classification);
    const baseSolutionItemHash = canonicalEvidenceHash(solution.evidence);
    const officialRawAnswerHash = sha256(solution.rawAnswer);
    if (raw.baseQuestionHash !== baseQuestionHash || raw.baseClassificationHash !== baseClassificationHash
      || raw.baseSolutionItemHash !== baseSolutionItemHash || raw.officialRawAnswerHash !== officialRawAnswerHash) {
      throw new Error(`${key}: repair base hashes do not match immutable evidence`);
    }
    const problemArtifact = evidencePointer(raw.problemArtifact, `${key}.problemArtifact`);
    const problemArtifactItemHash = digest(raw.problemArtifactItemHash, `${key}.problemArtifactItemHash`);
    const classificationArtifactEnvelope = object(raw.classificationArtifact, `${key}.classificationArtifact`);
    if (Object.keys(classificationArtifactEnvelope).sort().join(",")
      !== "path,rulesDigest,sha256,transcriptionGateVersion,transcriptionPromptDigest") {
      throw new Error(`${key}.classificationArtifact has unexpected fields`);
    }
    const classificationArtifact = evidencePointer(
      { path: classificationArtifactEnvelope.path, sha256: classificationArtifactEnvelope.sha256 },
      `${key}.classificationArtifact`,
    );
    const classificationArtifactItemHash = digest(
      raw.classificationArtifactItemHash,
      `${key}.classificationArtifactItemHash`,
    );
    return {
      raw,
      key,
      printedNumber,
      sourcePage,
      contextFrom,
      contextTo,
      base: baseRecord,
      solution,
      baseProblemCheckpoint,
      baseClassificationCheckpoint,
      baseSolutionCheckpoint,
      problemArtifact,
      problemArtifactItemHash,
      classificationArtifact,
      classificationArtifactEnvelope,
      classificationArtifactItemHash,
      baseQuestionHash,
      baseClassificationHash,
      baseSolutionItemHash,
      officialRawAnswerHash,
    };
  });
}

function problemRepairBatchVersionsByContext(
  stateDir: string,
  declaredPaths: Set<string>,
): Map<string, 1 | 2> {
  const versions = new Map<string, 1 | 2>();
  const names = listJson(join(stateDir, "problem-repair-batches"), /\.json$/u);
  const candidates: string[] = [];
  for (const name of names) {
    const legacy = /^v1-(\d{4})-(\d{4})-\d{4}-[a-f0-9]{64}\.json$/u.exec(name);
    const current = /^v2-(\d{4})-(\d{4})-[a-f0-9]{64}\.json$/u.exec(name);
    const matched = legacy ?? current;
    if (!matched) throw new Error(`${name}: malformed problem repair batch artifact name`);
    const context = `${Number(matched[1])}:${Number(matched[2])}`;
    const version = legacy ? 1 : 2;
    const prior = versions.get(context);
    if (prior !== undefined && prior !== version) {
      throw new Error(`${context}: legacy v1 and cross-page v2 problem repair batches cannot share a context`);
    }
    versions.set(context, version);
    candidates.push(`problem-repair-batches/${name}`);
  }
  for (const candidate of candidates) {
    if (!declaredPaths.has(candidate)) {
      throw new Error(`${candidate}: problem repair batch is not declared by the terminal audit`);
    }
  }
  return versions;
}

function verifyV3FirstProblemArtifacts(
  rows: V3RepairRow[],
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  cache: EvidenceCache,
): Map<string, ProblemQuestion> {
  const corrected = new Map<string, ProblemQuestion>();
  const batchVersions = problemRepairBatchVersionsByContext(stateDir, new Set(rows.flatMap((row) =>
    row.problemArtifact.path.startsWith("problem-repair-batches/")
      ? [row.problemArtifact.path]
      : [])));
  for (const [path, group] of groupByArtifact(rows, (row) => row.problemArtifact)) {
    const pointer = group[0].problemArtifact;
    if (/^problem-repairs\/v2-\d{4}-\d{4}\.json$/u.test(path)) {
      if (group.length !== 1) throw new Error(`${path}: legacy single repair has multiple key authorities`);
      const row = group[0];
      const expectedPath = `problem-repairs/v${PROBLEM_REPAIR_VERSION}-` +
        `${String(row.sourcePage).padStart(4, "0")}-${row.printedNumber.padStart(4, "0")}.json`;
      if (path !== expectedPath) throw new Error(`${row.key}: legacy problem repair path is invalid`);
      const checkpoint = readBoundEvidenceCached(cache, stateDir, pointer, `${row.key} legacy problem repair`);
      const question = parseProblem(checkpoint.item, `${row.key} legacy problem repair.item`);
      const expectedCheckpoint = {
        version: PROBLEM_REPAIR_VERSION,
        entryId: entry.id,
        key: row.key,
        sourcePage: row.sourcePage,
        printedNumber: row.printedNumber,
        contextFrom: row.contextFrom,
        contextTo: row.contextTo,
        sourceHash: problemEvidence.sha256,
        baseProblemCheckpoint: row.baseProblemCheckpoint,
        baseQuestionHash: row.baseQuestionHash,
        baseSolutionCheckpoint: row.baseSolutionCheckpoint,
        baseSolutionItemHash: row.baseSolutionItemHash,
        officialRawAnswerHash: row.officialRawAnswerHash,
        promptVersion: TARGETED_PROBLEM_TRANSCRIPTION_VERSION,
        promptDigest: TARGETED_PROBLEM_PROMPT_DIGEST,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        item: question.evidence,
      };
      if (!isDeepStrictEqual(checkpoint, expectedCheckpoint)) {
        throw new Error(`${row.key}: legacy problem repair metadata/content is stale`);
      }
      if (question.key !== row.key || canonicalEvidenceHash(question.evidence) !== row.problemArtifactItemHash) {
        throw new Error(`${row.key}: legacy problem repair per-item hash or identity is invalid`);
      }
      corrected.set(row.key, question);
      continue;
    }
    const ordered = [...group].sort((left, right) => compareCorpusQuestionKeys(left.key, right.key));
    if (ordered.length > 6) throw new Error(`${path}: shared problem repair exceeds six members`);
    const contextFrom = ordered[0].contextFrom;
    const contextTo = ordered[0].contextTo;
    if (ordered.some((row) => row.contextFrom !== contextFrom || row.contextTo !== contextTo)) {
      throw new Error(`${path}: shared problem repair members do not share context`);
    }
    const context = `${contextFrom}:${contextTo}`;
    const legacy = path.startsWith(`problem-repair-batches/v${LEGACY_PROBLEM_REPAIR_BATCH_VERSION}-`);
    const version = legacy ? LEGACY_PROBLEM_REPAIR_BATCH_VERSION : PROBLEM_REPAIR_BATCH_VERSION;
    if (batchVersions.get(context) !== version) {
      throw new Error(`${path}: problem repair batch version conflicts with its context`);
    }
    const sourcePage = ordered[0].sourcePage;
    if (legacy && ordered.some((row) => row.sourcePage !== sourcePage)) {
      throw new Error(`${path}: legacy shared problem repair members do not share a page`);
    }
    const members = ordered.map((row) => legacy ? {
      key: row.key,
      printedNumber: row.printedNumber,
      baseProblemCheckpoint: row.baseProblemCheckpoint,
      baseQuestionHash: row.baseQuestionHash,
      baseClassificationCheckpoint: row.baseClassificationCheckpoint,
      baseClassificationHash: row.baseClassificationHash,
      baseSolutionCheckpoint: row.baseSolutionCheckpoint,
      baseSolutionItemHash: row.baseSolutionItemHash,
      officialRawAnswerHash: row.officialRawAnswerHash,
    } : {
      key: row.key,
      printedNumber: row.printedNumber,
      sourcePage: row.sourcePage,
      baseProblemCheckpoint: row.baseProblemCheckpoint,
      baseQuestionHash: row.baseQuestionHash,
      baseClassificationCheckpoint: row.baseClassificationCheckpoint,
      baseClassificationHash: row.baseClassificationHash,
      baseTranscriptionEvidenceHash: sha256(row.base.classification.transcription_evidence),
      baseSolutionCheckpoint: row.baseSolutionCheckpoint,
      baseSolutionItemHash: row.baseSolutionItemHash,
      officialRawAnswerHash: row.officialRawAnswerHash,
    });
    const membersDigest = canonicalEvidenceHash(members);
    const expectedPath = legacy
      ? `problem-repair-batches/v${LEGACY_PROBLEM_REPAIR_BATCH_VERSION}-` +
        `${String(contextFrom).padStart(4, "0")}-${String(contextTo).padStart(4, "0")}-` +
        `${String(sourcePage).padStart(4, "0")}-${membersDigest}.json`
      : `problem-repair-batches/v${PROBLEM_REPAIR_BATCH_VERSION}-` +
        `${String(contextFrom).padStart(4, "0")}-${String(contextTo).padStart(4, "0")}-${membersDigest}.json`;
    if (path !== expectedPath) throw new Error(`${path}: shared problem repair path/member set is invalid`);
    const checkpoint = readBoundEvidenceCached(cache, stateDir, pointer, path);
    if (!Array.isArray(checkpoint.items)) throw new Error(`${path}: shared problem repair items are missing`);
    const items = checkpoint.items.map((value, index) => parseProblem(value, `${path}.items[${index}]`));
    const byKey = new Map<string, ProblemQuestion>();
    for (const item of items) {
      if (byKey.has(item.key)) throw new Error(`${path}: duplicate shared problem output ${item.key}`);
      byKey.set(item.key, item);
    }
    if (byKey.size !== ordered.length || ordered.some((row) => !byKey.has(row.key))) {
      throw new Error(`${path}: shared problem member/output/reference coverage is not exact`);
    }
    const commonCheckpoint = {
      version,
      entryId: entry.id,
      sourceHash: problemEvidence.sha256,
      contextFrom,
      contextTo,
    };
    const expectedCheckpoint = legacy ? {
      ...commonCheckpoint,
      sourcePage,
      membersDigest,
      members,
      promptVersion: TARGETED_PROBLEM_BATCH_VERSION,
      promptDigest: TARGETED_PROBLEM_BATCH_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      items: items.map((item) => item.evidence),
    } : {
      ...commonCheckpoint,
      targetsDigest: membersDigest,
      members,
      batchPromptVersion: TARGETED_PROBLEM_BATCH_VERSION,
      batchPromptDigest: TARGETED_PROBLEM_BATCH_PROMPT_DIGEST,
      revisionPromptVersion: TARGETED_PROBLEM_REVISION_VERSION,
      revisionPromptDigest: TARGETED_PROBLEM_BATCH_REVISION_PROMPT_DIGEST,
      diagnosticEvidenceHash: sha256(JSON.stringify(ordered.map((row) => ({
        key: row.key,
        evidence: row.base.classification.transcription_evidence,
      })))),
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      items: ordered.map((row) => byKey.get(row.key)!.evidence),
    };
    if (!isDeepStrictEqual(checkpoint, expectedCheckpoint)) {
      throw new Error(`${path}: shared problem repair metadata/content is stale`);
    }
    for (const row of ordered) {
      const item = byKey.get(row.key)!;
      if (item.page !== row.sourcePage || item.printedNumber !== row.printedNumber
        || canonicalEvidenceHash(item.evidence) !== row.problemArtifactItemHash) {
        throw new Error(`${row.key}: shared problem repair per-item hash or identity is invalid`);
      }
      corrected.set(row.key, item);
    }
  }
  return corrected;
}

function verifyV3FirstClassificationArtifacts(
  rows: V3RepairRow[],
  corrected: Map<string, ProblemQuestion>,
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  rulesDigest: string,
  cache: EvidenceCache,
): Map<string, V3FirstRepair> {
  const result = new Map<string, V3FirstRepair>();
  for (const [path, group] of groupByArtifact(rows, (row) => row.classificationArtifact)) {
    const ordered = [...group].sort((left, right) => compareCorpusQuestionKeys(left.key, right.key));
    const contextFrom = ordered[0].contextFrom;
    const contextTo = ordered[0].contextTo;
    if (ordered.some((row) => row.contextFrom !== contextFrom || row.contextTo !== contextTo)) {
      throw new Error(`${path}: shared classification members do not share context`);
    }
    for (const row of ordered) {
      if (row.classificationArtifactEnvelope.rulesDigest !== rulesDigest
        || row.classificationArtifactEnvelope.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION
        || row.classificationArtifactEnvelope.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST) {
        throw new Error(`${row.key}: classification repair envelope is stale`);
      }
    }
    const members = ordered.map((row) => ({
      key: row.key,
      problemAuthority: {
        key: row.key,
        path: row.problemArtifact.path,
        sha256: row.problemArtifact.sha256,
        itemHash: row.problemArtifactItemHash,
      },
      effectiveQuestionHash: canonicalEvidenceHash(corrected.get(row.key)!.evidence),
      baseClassificationCheckpoint: row.baseClassificationCheckpoint,
      baseClassificationHash: row.baseClassificationHash,
    }));
    const overlayDigest = canonicalEvidenceHash(members);
    const expectedPath = `classification-repair-batches/v${CLASSIFICATION_REPAIR_BATCH_VERSION}-` +
      `${String(contextFrom).padStart(4, "0")}-${String(contextTo).padStart(4, "0")}-` +
      `${overlayDigest}-${rulesDigest}.json`;
    if (path !== expectedPath) throw new Error(`${path}: shared classification path/member set is invalid`);
    const checkpoint = readBoundEvidenceCached(cache, stateDir, ordered[0].classificationArtifact, path);
    if (!Array.isArray(checkpoint.items)) throw new Error(`${path}: shared classification items are missing`);
    const byKey = new Map<string, ClassificationEvidence>();
    const items = checkpoint.items.map((value, index) => {
      const key = exactString(object(value, `${path}.items[${index}]`).key, `${path}.items[${index}].key`);
      const row = ordered.find((candidate) => candidate.key === key);
      if (!row || byKey.has(key)) throw new Error(`${path}: missing, extra, or duplicate classification key ${key}`);
      const parsed = parseClassificationEvidence(value, corrected.get(key)!, entry, `${path}.items[${index}]`);
      byKey.set(key, parsed);
      return parsed;
    });
    if (byKey.size !== ordered.length) throw new Error(`${path}: shared classification coverage is incomplete`);
    const expectedCheckpoint = {
      version: CLASSIFICATION_REPAIR_BATCH_VERSION,
      entryId: entry.id,
      sourceHash: problemEvidence.sha256,
      contextFrom,
      contextTo,
      overlayDigest,
      classifierVersion: CLASSIFIER_VERSION,
      rulesDigest,
      transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      members,
      items,
    };
    if (!isDeepStrictEqual(checkpoint, expectedCheckpoint)) {
      throw new Error(`${path}: shared classification metadata/content is stale`);
    }
    for (const row of ordered) {
      const question = corrected.get(row.key)!;
      const classification = byKey.get(row.key)!;
      const effectiveQuestionHash = canonicalEvidenceHash(question.evidence);
      const effectiveClassificationHash = canonicalEvidenceHash(classification);
      if (row.raw.effectiveQuestionHash !== effectiveQuestionHash
        || row.problemArtifactItemHash !== effectiveQuestionHash
        || row.raw.effectiveClassificationHash !== effectiveClassificationHash
        || row.classificationArtifactItemHash !== effectiveClassificationHash) {
        throw new Error(`${row.key}: repair effective/per-item hashes do not match shared outputs`);
      }
      const evidence = {
        key: row.key,
        printedNumber: row.printedNumber,
        sourcePage: row.sourcePage,
        contextFrom: row.contextFrom,
        contextTo: row.contextTo,
        baseProblemCheckpoint: row.baseProblemCheckpoint,
        baseClassificationCheckpoint: row.baseClassificationCheckpoint,
        baseSolutionCheckpoint: row.baseSolutionCheckpoint,
        problemArtifact: row.problemArtifact,
        problemArtifactItemHash: row.problemArtifactItemHash,
        classificationArtifact: {
          ...row.classificationArtifact,
          rulesDigest,
          transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
          transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
        },
        classificationArtifactItemHash: row.classificationArtifactItemHash,
        baseQuestionHash: row.baseQuestionHash,
        effectiveQuestionHash,
        baseClassificationHash: row.baseClassificationHash,
        effectiveClassificationHash,
        baseSolutionItemHash: row.baseSolutionItemHash,
        officialRawAnswerHash: row.officialRawAnswerHash,
      };
      result.set(row.key, {
        row,
        classified: {
          question,
          classification,
          problemCheckpoint: row.base.problemCheckpoint,
          classificationCheckpoint: row.base.classificationCheckpoint,
          contextFrom: row.contextFrom,
          contextTo: row.contextTo,
        },
        evidence,
      });
    }
  }
  return result;
}

type V3RevisionRow = {
  first: V3FirstRepair;
  raw: Record<string, unknown>;
  current: ClassifiedEvidence;
  trigger: Record<string, unknown>;
  problemArtifact: EvidencePointer;
  problemArtifactItemHash: string;
  classificationArtifact: EvidencePointer;
  classificationArtifactEnvelope: Record<string, unknown>;
  classificationArtifactItemHash: string;
};

function verifyProblemRecoveryCoverage(
  values: unknown[],
  stateDir: string,
  contract: VerificationContract,
): void {
  const declared = new Set<string>();
  const declaredCrop = new Set<string>();
  const declaredScope = new Set<string>();
  const declaredRepairScope = new Set<string>();
  const declaredManual = new Set<string>();
  for (const [index, value] of values.entries()) {
    const repair = object(value, `answer audit repairs[${index}]`);
    if (repair.scopeAdjudication !== undefined) {
      if (contract.auditVersion !== 5 || repair.revision !== undefined) {
        throw new Error("problem repair scope adjudication requires answer audit v5 and no revision");
      }
      const adjudication = object(
        repair.scopeAdjudication,
        `answer audit repairs[${index}].scopeAdjudication`,
      );
      const envelope = object(adjudication.classificationArtifact, "problem repair scope classification artifact");
      const pointer = evidencePointer(
        { path: envelope.path, sha256: envelope.sha256 },
        "problem repair scope classification artifact",
      );
      if (declaredRepairScope.has(pointer.path)) {
        throw new Error(`${pointer.path}: duplicate repair scope adjudication authority`);
      }
      declaredRepairScope.add(pointer.path);
    }
    if (repair.revision === undefined) continue;
    const revision = object(repair.revision, `answer audit repairs[${index}].revision`);
    if (revision.recovery === undefined) continue;
    if (contract.auditVersion < 4) throw new Error("problem recovery requires answer audit v4 or newer");
    const recovery = object(revision.recovery, `answer audit repairs[${index}].revision.recovery`);
    for (const [label, raw] of [
      ["problem", recovery.problemArtifact],
      ["classification", recovery.classificationArtifact],
    ] as const) {
      const envelope = object(raw, `problem recovery ${label} artifact`);
      const pointer = evidencePointer(
        label === "classification" ? { path: envelope.path, sha256: envelope.sha256 } : envelope,
        `problem recovery ${label} artifact`,
      );
      if (declared.has(pointer.path)) throw new Error(`${pointer.path}: duplicate problem recovery authority`);
      declared.add(pointer.path);
    }
    if ((recovery.adjudication !== undefined && recovery.scopeAdjudication !== undefined)
      || (recovery.manualAdjudication !== undefined && recovery.scopeAdjudication !== undefined)) {
      throw new Error("problem recovery cannot combine scope adjudication with another terminal child");
    }
    if (recovery.scopeAdjudication !== undefined) {
      if (contract.auditVersion !== 5) throw new Error("problem scope adjudication requires answer audit v5");
      const adjudication = object(
        recovery.scopeAdjudication,
        `answer audit repairs[${index}].revision.recovery.scopeAdjudication`,
      );
      const envelope = object(adjudication.classificationArtifact, "problem scope classification artifact");
      const pointer = evidencePointer(
        { path: envelope.path, sha256: envelope.sha256 },
        "problem scope classification artifact",
      );
      if (declaredScope.has(pointer.path)) {
        throw new Error(`${pointer.path}: duplicate scope adjudication authority`);
      }
      declaredScope.add(pointer.path);
    }
    if (recovery.manualAdjudication !== undefined) {
      if (contract.auditVersion !== 5) throw new Error("problem manual adjudication requires answer audit v5");
      const manual = object(
        recovery.manualAdjudication,
        `answer audit repairs[${index}].revision.recovery.manualAdjudication`,
      );
      const manualPointers: Array<[string, unknown, boolean]> = [
        ["manual crop evidence", manual.cropEvidenceArtifact, false],
        ["manual crop evidence PDF", manual.cropEvidencePdf, false],
        ["problem manual adjudication", manual.problemArtifact, true],
        ["classification manual adjudication", manual.classificationArtifact, true],
      ];
      if (!Array.isArray(manual.cropViews)) {
        throw new Error(`answer audit repairs[${index}] manual adjudication views are missing`);
      }
      for (const [viewIndex, raw] of manual.cropViews.entries()) {
        manualPointers.push([
          `manual crop view ${viewIndex + 1}`,
          object(raw, `answer audit repairs[${index}] manual cropViews[${viewIndex}]`).artifact,
          false,
        ]);
      }
      for (const [label, raw, alwaysManual] of manualPointers) {
        const envelope = object(raw, `${label} artifact`);
        const pointer = evidencePointer(
          { path: envelope.path, sha256: envelope.sha256 },
          `${label} artifact`,
        );
        if (!alwaysManual && !pointer.path.startsWith("problem-manual-evidence/")) continue;
        if (declaredManual.has(pointer.path)) {
          throw new Error(`${pointer.path}: duplicate manual adjudication authority`);
        }
        declaredManual.add(pointer.path);
      }
    }
    if (recovery.adjudication === undefined) continue;
    if (contract.auditVersion !== 5) throw new Error("problem crop adjudication requires answer audit v5");
    const adjudication = object(
      recovery.adjudication,
      `answer audit repairs[${index}].revision.recovery.adjudication`,
    );
    const cropPointers: Array<[string, unknown]> = [
      ["crop evidence", adjudication.cropEvidenceArtifact],
      ["crop evidence PDF", adjudication.cropEvidencePdf],
      ["problem adjudication", adjudication.problemArtifact],
      ["classification adjudication", adjudication.classificationArtifact],
    ];
    if (!Array.isArray(adjudication.cropViews)) {
      throw new Error(`answer audit repairs[${index}] crop adjudication views are missing`);
    }
    for (const [viewIndex, raw] of adjudication.cropViews.entries()) {
      cropPointers.push([
        `crop view ${viewIndex + 1}`,
        object(raw, `answer audit repairs[${index}] cropViews[${viewIndex}]`).artifact,
      ]);
    }
    for (const [label, raw] of cropPointers) {
      const envelope = object(raw, `problem crop ${label} artifact`);
      const pointer = evidencePointer(
        { path: envelope.path, sha256: envelope.sha256 },
        `problem crop ${label} artifact`,
      );
      if (declaredCrop.has(pointer.path)) throw new Error(`${pointer.path}: duplicate crop adjudication authority`);
      declaredCrop.add(pointer.path);
    }
  }
  for (const [directory, pattern] of [
    ["problem-recoveries", /^v[12]-\d{4}-\d{4}-[a-f0-9]{64}\.json$/u],
    ["classification-recoveries", /^v[12]-\d{4}-\d{4}-[a-f0-9]{64}-[a-f0-9]{16}\.json$/u],
  ] as const) {
    for (const name of listJson(join(stateDir, directory), /\.json$/u)) {
      if (!pattern.test(name)) throw new Error(`${directory}/${name}: malformed problem recovery artifact name`);
      const path = `${directory}/${name}`;
      if (!declared.has(path)) throw new Error(`${path}: problem recovery artifact is not declared by the terminal audit`);
    }
  }
  for (const [directory, patterns] of [
    ["problem-crop-evidence", [
      /^v1-\d{4}-\d{4}-[a-f0-9]{64}\.json$/u,
      /^v1-\d{4}-\d{4}-[a-f0-9]{64}\.pdf$/u,
      /^v1-\d{4}-\d{4}-[a-f0-9]{64}-view-\d{2}\.png$/u,
    ]],
    ["problem-crop-adjudications", [
      /^v1-\d{4}-\d{4}-[a-f0-9]{64}\.json$/u,
    ]],
    ["classification-crop-adjudications", [
      /^v1-\d{4}-\d{4}-[a-f0-9]{64}-[a-f0-9]{16}\.json$/u,
    ]],
  ] as const) {
    const absolute = join(stateDir, directory);
    if (!existsSync(absolute)) continue;
    for (const entry of readdirSync(absolute, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isFile() && entry.name.endsWith(".tmp")) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`${directory}/${entry.name}: crop adjudication artifact must be a regular file`);
      }
      if (!patterns.some((pattern) => pattern.test(entry.name))) {
        throw new Error(`${directory}/${entry.name}: malformed crop adjudication artifact name`);
      }
      const path = `${directory}/${entry.name}`;
      if (!declaredCrop.has(path)) {
        throw new Error(`${path}: crop adjudication artifact is not declared by the terminal audit`);
      }
    }
  }
  const scopeDirectory = join(stateDir, "classification-scope-adjudications");
  if (existsSync(scopeDirectory)) {
    for (const entry of readdirSync(scopeDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isFile() && entry.name.endsWith(".tmp")) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`classification-scope-adjudications/${entry.name}: scope adjudication artifact must be a regular file`);
      }
      if (!/^v1-\d{4}-\d{4}-[a-f0-9]{64}-[a-f0-9]{16}\.json$/u.test(entry.name)) {
        throw new Error(`classification-scope-adjudications/${entry.name}: malformed scope adjudication artifact name`);
      }
      const path = `classification-scope-adjudications/${entry.name}`;
      if (!declaredScope.has(path)) {
        throw new Error(`${path}: scope adjudication artifact is not declared by the terminal audit`);
      }
    }
  }
  for (const path of declaredScope) {
    if (!existsSync(join(stateDir, path))) {
      throw new Error(`${path}: declared scope adjudication artifact is missing`);
    }
  }
  const repairScopeDirectory = join(stateDir, "classification-repair-scope-adjudications");
  if (existsSync(repairScopeDirectory)) {
    for (const entry of readdirSync(repairScopeDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isFile() && entry.name.endsWith(".tmp")) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(
          `classification-repair-scope-adjudications/${entry.name}: repair scope artifact must be a regular file`,
        );
      }
      if (!/^v1-\d{4}-\d{4}-[a-f0-9]{64}-[a-f0-9]{16}\.json$/u.test(entry.name)) {
        throw new Error(
          `classification-repair-scope-adjudications/${entry.name}: malformed repair scope artifact name`,
        );
      }
      const path = `classification-repair-scope-adjudications/${entry.name}`;
      if (!declaredRepairScope.has(path)) {
        throw new Error(`${path}: repair scope adjudication artifact is not declared by the terminal audit`);
      }
    }
  }
  for (const path of declaredRepairScope) {
    if (!existsSync(join(stateDir, path))) {
      throw new Error(`${path}: declared repair scope adjudication artifact is missing`);
    }
  }
  for (const [directory, patterns] of [
    ["problem-manual-evidence", [
      /^v1-\d{4}-\d{4}-[a-f0-9]{64}\.json$/u,
      /^v1-\d{4}-\d{4}-[a-f0-9]{64}\.pdf$/u,
      /^v1-\d{4}-\d{4}-[a-f0-9]{64}-view-\d{2}\.png$/u,
    ]],
    ["problem-manual-adjudications", [
      /^v1-\d{4}-\d{4}-[a-f0-9]{64}\.json$/u,
    ]],
    ["classification-manual-adjudications", [
      /^v1-\d{4}-\d{4}-[a-f0-9]{64}-[a-f0-9]{16}\.json$/u,
    ]],
  ] as const) {
    const absolute = join(stateDir, directory);
    if (!existsSync(absolute)) continue;
    for (const entry of readdirSync(absolute, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isFile() && entry.name.endsWith(".tmp")) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`${directory}/${entry.name}: manual adjudication artifact must be a regular file`);
      }
      if (!patterns.some((pattern) => pattern.test(entry.name))) {
        throw new Error(`${directory}/${entry.name}: malformed manual adjudication artifact name`);
      }
      const path = `${directory}/${entry.name}`;
      if (!declaredManual.has(path)) {
        throw new Error(`${path}: manual adjudication artifact is not declared by the terminal audit`);
      }
    }
  }
  for (const path of declaredManual) {
    if (!existsSync(join(stateDir, path))) {
      throw new Error(`${path}: declared manual adjudication artifact is missing`);
    }
  }
}

function prepareV3RevisionRows(
  values: V3FirstRepair[],
  kind: "classification" | "terminal",
  current: Map<string, ClassifiedEvidence>,
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  rulesDigest: string,
  cache: EvidenceCache,
  contract: VerificationContract,
): V3RevisionRow[] {
  return values.map((first) => {
    const key = first.row.key;
    const revision = object(first.row.raw.revision, `${key}.revision`);
    const triggerRow = object(revision.trigger, `${key}.revision.trigger`);
    const record = current.get(key);
    if (!record) throw new Error(`${key}: revision has no current first-stage record`);
    let trigger: Record<string, unknown>;
    if (kind === "classification") {
      if (triggerRow.kind !== "classification" || record.classification.transcription_status === "exact") {
        throw new Error(`${key}: classification revision trigger does not match first decision`);
      }
      trigger = {
        kind: "classification",
        evidenceHash: sha256(record.classification.transcription_evidence),
      };
    } else {
      if (triggerRow.kind !== "terminal" || record.classification.transcription_status !== "exact"
      ) {
        throw new Error(`${key}: terminal revision trigger does not match the pre-revision corpus`);
      }
      const terminalCheckpoint = problemTerminalFidelityCheckpoint(
        triggerRow.terminalCheckpoint,
        `${key}.revision.trigger.terminalCheckpoint`,
      );
      const pathMatch = new RegExp(
        `^problem-terminal-fidelity/v${contract.problemTerminalFidelityVersion}-(\\d{4})-` +
          "([a-f0-9]{64})-([a-f0-9]{64})\\.json$",
        "u",
      ).exec(terminalCheckpoint.path);
      const slice = pathMatch && expectedProblemFidelitySlices(problemEvidence.pageCount)[Number(pathMatch[1])];
      if (!pathMatch || !slice || pathMatch[3] !== terminalCheckpoint.inputHash
        || terminalCheckpoint.from !== slice.from || terminalCheckpoint.to !== slice.to
        || terminalCheckpoint.ownedFrom !== slice.ownedFrom || terminalCheckpoint.ownedTo !== slice.ownedTo
        || record.question.page < slice.ownedFrom || record.question.page > slice.ownedTo) {
        throw new Error(`${key}: terminal revision checkpoint path/slice is invalid`);
      }
      const checkpoint = readBoundEvidenceCached(
        cache,
        stateDir,
        terminalCheckpoint,
        `${key} terminal revision checkpoint`,
      );
      if (checkpoint.version !== contract.problemTerminalFidelityVersion || checkpoint.entryId !== entry.id
        || checkpoint.sourceHash !== problemEvidence.sha256 || checkpoint.from !== slice.from
        || checkpoint.to !== slice.to || checkpoint.ownedFrom !== slice.ownedFrom
        || checkpoint.ownedTo !== slice.ownedTo || checkpoint.effectiveCorpusHash !== pathMatch[2]
        || checkpoint.inputHash !== terminalCheckpoint.inputHash
        || checkpoint.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION
        || checkpoint.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST
        || contract.problemTerminalScopePromptDigest !== null && (
          checkpoint.rulesDigest !== rulesDigest
          || checkpoint.scopePromptDigest !== contract.problemTerminalScopePromptDigest
        )
        || checkpoint.model !== "gpt-5.6-sol" || checkpoint.reasoningEffort !== "high"
        || !Array.isArray(checkpoint.inputs) || !Array.isArray(checkpoint.items)
        || canonicalEvidenceHash(checkpoint.inputs) !== terminalCheckpoint.inputHash) {
        throw new Error(`${key}: terminal revision checkpoint metadata is stale`);
      }
      const inputKeys = checkpoint.inputs.map((value, index) => exactString(
        object(value, `${key} terminal inputs[${index}]`).key,
        `${key} terminal inputs[${index}].key`,
      ));
      const terminalItems = checkpoint.items.map((value, index) =>
        parseProblemTerminalFidelityItem(value, `${key} terminal items[${index}]`, contract));
      const itemKeys = terminalItems.map((item) => item.key);
      if (new Set(inputKeys).size !== inputKeys.length || new Set(itemKeys).size !== itemKeys.length
        || !isDeepStrictEqual(
          [...inputKeys].sort(compareCorpusQuestionKeys),
          [...itemKeys].sort(compareCorpusQuestionKeys),
        )) {
        throw new Error(`${key}: terminal revision checkpoint input/item coverage is not exact`);
      }
      const terminalItem = terminalItems.find((item) => item.key === key);
      if (!terminalItem || terminalItem.status === "exact") {
        throw new Error(`${key}: terminal revision lacks a bound non-exact diagnostic`);
      }
      const terminalItemHash = canonicalEvidenceHash(terminalItem);
      if (triggerRow.terminalItemHash !== terminalItemHash) {
        throw new Error(`${key}: terminal revision item hash is invalid`);
      }
      trigger = {
        kind: "terminal",
        evidenceHash: sha256(terminalItem.evidence),
        terminalCheckpoint,
        terminalItemHash,
      };
    }
    if (!isDeepStrictEqual(triggerRow, trigger) || revision.diagnosticEvidenceHash !== trigger.evidenceHash) {
      throw new Error(`${key}: revision trigger/evidence hash is stale`);
    }
    const baseProblemRepairArtifact = evidencePointer(
      revision.baseProblemRepairArtifact,
      `${key}.revision.baseProblemRepairArtifact`,
    );
    const baseClassificationRepairArtifact = evidencePointer(
      revision.baseClassificationRepairArtifact,
      `${key}.revision.baseClassificationRepairArtifact`,
    );
    sameEvidencePointer(baseProblemRepairArtifact, first.row.problemArtifact, `${key}.revision base problem repair`);
    sameEvidencePointer(
      baseClassificationRepairArtifact,
      first.row.classificationArtifact,
      `${key}.revision base classification repair`,
    );
    const baseQuestionHash = canonicalEvidenceHash(record.question.evidence);
    const baseClassificationHash = canonicalEvidenceHash(record.classification);
    if (revision.baseQuestionHash !== baseQuestionHash || revision.baseClassificationHash !== baseClassificationHash) {
      throw new Error(`${key}: revision base hashes do not match its first repair generation`);
    }
    const problemArtifact = evidencePointer(revision.problemArtifact, `${key}.revision.problemArtifact`);
    const problemArtifactItemHash = digest(
      revision.problemArtifactItemHash,
      `${key}.revision.problemArtifactItemHash`,
    );
    const classificationArtifactEnvelope = object(
      revision.classificationArtifact,
      `${key}.revision.classificationArtifact`,
    );
    if (Object.keys(classificationArtifactEnvelope).sort().join(",")
      !== "path,rulesDigest,sha256,transcriptionGateVersion,transcriptionPromptDigest") {
      throw new Error(`${key}.revision.classificationArtifact has unexpected fields`);
    }
    const classificationArtifact = evidencePointer(
      { path: classificationArtifactEnvelope.path, sha256: classificationArtifactEnvelope.sha256 },
      `${key}.revision.classificationArtifact`,
    );
    const classificationArtifactItemHash = digest(
      revision.classificationArtifactItemHash,
      `${key}.revision.classificationArtifactItemHash`,
    );
    return {
      first,
      raw: revision,
      current: record,
      trigger,
      problemArtifact,
      problemArtifactItemHash,
      classificationArtifact,
      classificationArtifactEnvelope,
      classificationArtifactItemHash,
    };
  });
}

function problemCropAdjudicationSpec(
  entry: ManifestEntry,
  key: string,
  sourcePage: number,
  sourceHash: string,
): ProblemCropAdjudicationSpec {
  const matches = PROBLEM_CROP_ADJUDICATION_ALLOWLIST.filter((spec) =>
    spec.entryId === entry.id && spec.key === key && spec.sourcePage === sourcePage);
  if (matches.length !== 1) {
    throw new Error(`${entry.id} ${key}: crop adjudication is not uniquely allowlisted`);
  }
  if (matches[0].sourceHash !== sourceHash) {
    throw new Error(`${entry.id} ${key}: official crop source hash does not match the allowlist`);
  }
  return matches[0];
}

function problemManualAdjudicationSpec(
  entry: ManifestEntry,
  key: string,
  sourcePage: number,
  sourceHash: string,
): ProblemManualAdjudicationSpec {
  const matches = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.filter((spec) =>
    spec.entryId === entry.id && spec.key === key && spec.sourcePage === sourcePage);
  if (matches.length !== 1) {
    throw new Error(`${entry.id} ${key}: manual adjudication is not uniquely allowlisted`);
  }
  if (matches[0].sourceHash !== sourceHash) {
    throw new Error(`${entry.id} ${key}: official manual source hash does not match the allowlist`);
  }
  return matches[0];
}

function exactOccurrenceCount(source: string, target: string): number {
  if (!target) throw new Error("manual adjudication replacement target is empty");
  let count = 0;
  let offset = 0;
  for (;;) {
    const index = source.indexOf(target, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + target.length;
  }
}

function problemManualCorrectionSpecHash(spec: ProblemManualAdjudicationSpec): string {
  return canonicalEvidenceHash({
    allowlistId: spec.allowlistId,
    parentKind: spec.parentKind,
    views: spec.views,
    requiredTokens: spec.requiredTokens,
    replacements: spec.replacements,
    figure: spec.figure,
    figureDescription: spec.figureDescription,
    ...(spec.expectedDecision ? { expectedDecision: spec.expectedDecision } : {}),
  });
}

function matchesProblemManualExpectedDecision(
  spec: ProblemManualAdjudicationSpec,
  classification: Pick<ClassificationEvidence,
    "decision" | "canonical_subject" | "curriculum_course" | "domain" | "achievement_codes">,
): boolean {
  if (!spec.expectedDecision) return true;
  return classification.decision === "reject" && classification.canonical_subject === null
    && classification.curriculum_course === null && classification.domain === null
    && classification.achievement_codes.length === 0;
}

function applyProblemManualCorrection(
  failed: ProblemQuestion,
  spec: ProblemManualAdjudicationSpec,
): ProblemQuestion {
  if (canonicalEvidenceHash(failed.evidence) !== spec.failedQuestionHash) {
    throw new Error(`${failed.key}: manual adjudication failed question hash is stale`);
  }
  const corrected = structuredClone(failed.evidence);
  for (const replacement of spec.replacements) {
    const current = replacement.field === "question"
      ? exactString(corrected.question, `${failed.key}.manual.question`)
      : corrected.figure_description === null
        ? ""
        : exactString(corrected.figure_description, `${failed.key}.manual.figure_description`);
    if (exactOccurrenceCount(current, replacement.from) !== replacement.count) {
      throw new Error(`${failed.key}: manual replacement occurrence is stale: ${replacement.from}`);
    }
    corrected[replacement.field] = current.split(replacement.from).join(replacement.to);
  }
  if (spec.figure !== undefined) corrected.figure = spec.figure;
  if (spec.figureDescription !== undefined) corrected.figure_description = spec.figureDescription;
  const question = parseProblem(corrected, `${failed.key} allowlisted manual correction`);
  if (question.key !== failed.key || question.page !== spec.sourcePage) {
    throw new Error(`${failed.key}: manual correction changed the immutable identity`);
  }
  assertProblemCropTokens(question, spec);
  if (canonicalEvidenceHash(question.evidence) === spec.failedQuestionHash) {
    throw new Error(`${failed.key}: manual correction did not change the failed item`);
  }
  return question;
}

function cropPngDimensions(path: string, label: string): { width: number; height: number } {
  const header = Buffer.alloc(24);
  const descriptor = openSync(path, "r");
  try {
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length
      || header.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
      || header.subarray(12, 16).toString("ascii") !== "IHDR") {
      throw new Error(`${label}: invalid PNG header`);
    }
  } finally {
    closeSync(descriptor);
  }
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  if (width < 1 || height < 1) throw new Error(`${label}: invalid PNG dimensions`);
  return { width, height };
}

function assertProblemCropTokens(question: ProblemQuestion, spec: ProblemCropAdjudicationSpec): void {
  const figureDescription = question.evidence.figure_description;
  const source = [
    question.question,
    ...(question.choices ?? []),
    typeof figureDescription === "string" ? figureDescription : "",
  ].join("\n").replace(/\s+/gu, "");
  const missing = spec.requiredTokens.filter((token) =>
    !source.includes(token.replace(/\s+/gu, "")));
  if (missing.length > 0) {
    throw new Error(`${question.key}: crop adjudication is missing required source tokens: ${missing.join(", ")}`);
  }
}

function verifyProblemCropAdjudication(
  value: unknown,
  parentRecovery: Record<string, unknown>,
  failedQuestion: ProblemQuestion,
  failedClassification: ClassificationEvidence,
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  rulesDigest: string,
  cache: EvidenceCache,
  contract: VerificationContract,
  allowNonExact = false,
): { question: ProblemQuestion; classification: ClassificationEvidence; evidence: Record<string, unknown> } {
  const key = failedQuestion.key;
  if (contract.auditVersion !== 5 || failedClassification.transcription_status === "exact") {
    throw new Error(`${key}: crop adjudication requires a current non-exact recovery`);
  }
  const spec = problemCropAdjudicationSpec(
    entry,
    key,
    failedQuestion.page,
    problemEvidence.sha256,
  );
  const sourcePages = [...new Set(spec.views.map((view) => view.sourcePage))].sort((left, right) => left - right);
  if (sourcePages.some((page) => page < 1 || page > problemEvidence.pageCount)) {
    throw new Error(`${key}: crop adjudication source pages escape the official PDF`);
  }
  const adjudication = object(value, `${key}.revision.recovery.adjudication`);
  if (parentRecovery.adjudication !== undefined
    || parentRecovery.key !== key || parentRecovery.sourcePage !== failedQuestion.page
    || parentRecovery.sourceHash !== problemEvidence.sha256
    || parentRecovery.effectiveQuestionHash !== canonicalEvidenceHash(failedQuestion.evidence)
    || parentRecovery.effectiveClassificationHash !== canonicalEvidenceHash(failedClassification)) {
    throw new Error(`${key}: crop adjudication does not bind the latest failed recovery`);
  }
  const parentRecoveryEvidenceHash = canonicalEvidenceHash(parentRecovery);
  if (adjudication.parentRecoveryEvidenceHash !== parentRecoveryEvidenceHash) {
    throw new Error(`${key}: crop adjudication parent recovery hash is stale`);
  }

  const evidenceBasis = {
    allowlistId: spec.allowlistId,
    entryId: entry.id,
    key,
    sourcePage: spec.sourcePage,
    sourcePages,
    sourceHash: problemEvidence.sha256,
    dpi: PROBLEM_CROP_DPI,
    views: spec.views,
    requiredTokens: spec.requiredTokens,
  };
  const evidenceBasisDigest = canonicalEvidenceHash(evidenceBasis);
  const stem = `v${PROBLEM_CROP_ADJUDICATION_VERSION}-${String(spec.sourcePage).padStart(4, "0")}-` +
    `${failedQuestion.printedNumber.padStart(4, "0")}-${evidenceBasisDigest}`;
  const cropEvidenceArtifact = evidencePointer(
    adjudication.cropEvidenceArtifact,
    `${key}.adjudication.cropEvidenceArtifact`,
  );
  const cropEvidencePdf = evidencePointer(
    adjudication.cropEvidencePdf,
    `${key}.adjudication.cropEvidencePdf`,
  );
  if (cropEvidenceArtifact.path !== `problem-crop-evidence/${stem}.json`
    || cropEvidencePdf.path !== `problem-crop-evidence/${stem}.pdf`) {
    throw new Error(`${key}: crop evidence paths are stale`);
  }
  const cropCheckpoint = readBoundEvidenceCached(
    cache,
    stateDir,
    cropEvidenceArtifact,
    `${key} crop evidence checkpoint`,
  );
  if (!Array.isArray(cropCheckpoint.views) || cropCheckpoint.views.length !== spec.views.length) {
    throw new Error(`${key}: crop evidence view coverage is not exact`);
  }
  const cropViews = cropCheckpoint.views.map((raw, index) => {
    const row = object(raw, `${key} crop evidence views[${index}]`);
    const expected = spec.views[index];
    if (!Array.isArray(row.rect) || row.rect.length !== 4
      || !isDeepStrictEqual(row.rect, [...expected.rect])
      || row.sourcePage !== expected.sourcePage || row.label !== expected.label) {
      throw new Error(`${key}: crop evidence view ${index} does not match the allowlist`);
    }
    const pixelWidth = integer(row.pixelWidth, `${key}.cropViews[${index}].pixelWidth`, 1);
    const pixelHeight = integer(row.pixelHeight, `${key}.cropViews[${index}].pixelHeight`, 1);
    const pixelSha256 = digest(row.pixelSha256, `${key}.cropViews[${index}].pixelSha256`);
    const artifact = evidencePointer(row.artifact, `${key}.cropViews[${index}].artifact`);
    const expectedPath = `problem-crop-evidence/${stem}-view-${String(index).padStart(2, "0")}.png`;
    if (artifact.path !== expectedPath || artifact.sha256 !== pixelSha256) {
      throw new Error(`${key}: crop evidence view ${index} path/hash is stale`);
    }
    const absolute = confinedEvidencePath(stateDir, artifact, `${key} crop evidence view ${index}`);
    if (hashFile(absolute) !== pixelSha256) throw new Error(`${key}: crop evidence view ${index} hash mismatch`);
    const dimensions = cropPngDimensions(absolute, `${key} crop evidence view ${index}`);
    if (dimensions.width !== pixelWidth || dimensions.height !== pixelHeight) {
      throw new Error(`${key}: crop evidence view ${index} dimensions are stale`);
    }
    return {
      sourcePage: expected.sourcePage,
      label: expected.label,
      rect: [...expected.rect],
      pixelWidth,
      pixelHeight,
      pixelSha256,
      artifact,
    };
  });
  const cropPdfPath = confinedEvidencePath(stateDir, cropEvidencePdf, `${key} crop evidence PDF`);
  if (hashFile(cropPdfPath) !== cropEvidencePdf.sha256) throw new Error(`${key}: crop evidence PDF hash mismatch`);
  const expectedCropCheckpoint = {
    version: PROBLEM_CROP_ADJUDICATION_VERSION,
    entryId: entry.id,
    basisDigest: evidenceBasisDigest,
    basis: evidenceBasis,
    renderer: "pdftocairo-png+pdf-lib",
    dpi: PROBLEM_CROP_DPI,
    evidencePdf: cropEvidencePdf,
    views: cropViews,
  };
  if (!isDeepStrictEqual(cropCheckpoint, expectedCropCheckpoint)
    || !isDeepStrictEqual(adjudication.cropViews, cropViews)) {
    throw new Error(`${key}: crop evidence checkpoint/envelope is stale or incomplete`);
  }

  const commonBasis = {
    allowlistId: spec.allowlistId,
    entryId: entry.id,
    key,
    printedNumber: failedQuestion.printedNumber,
    sourcePage: spec.sourcePage,
    sourcePages,
    sourceHash: problemEvidence.sha256,
    parentRecovery,
    parentRecoveryEvidenceHash,
    failedRecoveryQuestionHash: canonicalEvidenceHash(failedQuestion.evidence),
    failedRecoveryClassificationHash: canonicalEvidenceHash(failedClassification),
    failedRecoveryEvidenceHash: sha256(failedClassification.transcription_evidence),
    cropEvidenceArtifact,
    cropEvidencePdf,
    cropViews,
    requiredTokensHash: canonicalEvidenceHash(spec.requiredTokens),
  };
  const basisDigest = canonicalEvidenceHash(commonBasis);
  const adjudicationStem = `v${PROBLEM_CROP_ADJUDICATION_VERSION}-` +
    `${String(spec.sourcePage).padStart(4, "0")}-${failedQuestion.printedNumber.padStart(4, "0")}-${basisDigest}`;
  const problemArtifactEnvelope = object(adjudication.problemArtifact, `${key}.adjudication.problemArtifact`);
  if (Object.keys(problemArtifactEnvelope).sort().join(",") !== "path,promptDigest,promptVersion,sha256"
    || problemArtifactEnvelope.promptVersion !== TARGETED_PROBLEM_CROP_ADJUDICATION_VERSION
    || problemArtifactEnvelope.promptDigest !== TARGETED_PROBLEM_CROP_ADJUDICATION_PROMPT_DIGEST) {
    throw new Error(`${key}: problem crop adjudication prompt envelope is stale`);
  }
  const problemArtifact = evidencePointer(
    { path: problemArtifactEnvelope.path, sha256: problemArtifactEnvelope.sha256 },
    `${key}.adjudication.problemArtifact`,
  );
  if (problemArtifact.path !== `problem-crop-adjudications/${adjudicationStem}.json`) {
    throw new Error(`${key}: problem crop adjudication path is stale`);
  }
  const problemCheckpoint = readBoundEvidenceCached(
    cache,
    stateDir,
    problemArtifact,
    `${key} problem crop adjudication`,
  );
  const question = parseProblem(problemCheckpoint.item, `${key} problem crop adjudication.item`);
  if (question.key !== key || question.page !== spec.sourcePage
    || question.printedNumber !== failedQuestion.printedNumber) {
    throw new Error(`${key}: problem crop adjudication changed page/number identity`);
  }
  assertProblemCropTokens(question, spec);
  const problemArtifactItemHash = canonicalEvidenceHash(question.evidence);
  const expectedProblemCheckpoint = {
    version: PROBLEM_CROP_ADJUDICATION_VERSION,
    entryId: entry.id,
    basisDigest,
    basis: commonBasis,
    promptVersion: TARGETED_PROBLEM_CROP_ADJUDICATION_VERSION,
    promptDigest: TARGETED_PROBLEM_CROP_ADJUDICATION_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    item: question.evidence,
  };
  if (!isDeepStrictEqual(problemCheckpoint, expectedProblemCheckpoint)
    || adjudication.problemArtifactItemHash !== problemArtifactItemHash) {
    throw new Error(`${key}: problem crop adjudication metadata/content is stale`);
  }

  const classificationBasis = {
    ...commonBasis,
    problemArtifact,
    problemArtifactItemHash,
    effectiveQuestionHash: problemArtifactItemHash,
  };
  const classificationBasisDigest = canonicalEvidenceHash(classificationBasis);
  const classificationEnvelope = object(
    adjudication.classificationArtifact,
    `${key}.adjudication.classificationArtifact`,
  );
  if (Object.keys(classificationEnvelope).sort().join(",") !==
      "adjudicationPromptDigest,adjudicationPromptVersion,classificationPromptDigest,path,rulesDigest,sha256,transcriptionGateVersion,transcriptionPromptDigest"
    || classificationEnvelope.rulesDigest !== rulesDigest
    || classificationEnvelope.transcriptionGateVersion !== contract.transcriptionGateVersion
    || classificationEnvelope.transcriptionPromptDigest !== contract.transcriptionPromptDigest
    || classificationEnvelope.adjudicationPromptVersion !== TARGETED_PROBLEM_CROP_ADJUDICATION_VERSION
    || classificationEnvelope.adjudicationPromptDigest !== TARGETED_PROBLEM_CROP_ADJUDICATION_PROMPT_DIGEST
    || classificationEnvelope.classificationPromptDigest !==
      PROBLEM_CROP_ADJUDICATION_CLASSIFICATION_PROMPT_DIGEST) {
    throw new Error(`${key}: classification crop adjudication envelope is stale`);
  }
  const classificationArtifact = evidencePointer(
    { path: classificationEnvelope.path, sha256: classificationEnvelope.sha256 },
    `${key}.adjudication.classificationArtifact`,
  );
  const expectedClassificationPath = `classification-crop-adjudications/` +
    `v${CLASSIFICATION_CROP_ADJUDICATION_VERSION}-${String(spec.sourcePage).padStart(4, "0")}-` +
    `${failedQuestion.printedNumber.padStart(4, "0")}-${classificationBasisDigest}-${rulesDigest}.json`;
  if (classificationArtifact.path !== expectedClassificationPath) {
    throw new Error(`${key}: classification crop adjudication path is stale`);
  }
  const classificationCheckpoint = readBoundEvidenceCached(
    cache,
    stateDir,
    classificationArtifact,
    `${key} classification crop adjudication`,
  );
  if (!Array.isArray(classificationCheckpoint.items) || classificationCheckpoint.items.length !== 1) {
    throw new Error(`${key}: classification crop adjudication must contain exactly one decision`);
  }
  const classification = parseClassificationEvidence(
    classificationCheckpoint.items[0],
    question,
    entry,
    `${key} classification crop adjudication.items[0]`,
  );
  const expectedClassificationCheckpoint = {
    version: CLASSIFICATION_CROP_ADJUDICATION_VERSION,
    entryId: entry.id,
    basisDigest: classificationBasisDigest,
    basis: classificationBasis,
    classifierVersion: contract.classifierVersion,
    rulesDigest,
    transcriptionGateVersion: contract.transcriptionGateVersion,
    transcriptionPromptDigest: contract.transcriptionPromptDigest,
    adjudicationPromptVersion: TARGETED_PROBLEM_CROP_ADJUDICATION_VERSION,
    adjudicationPromptDigest: TARGETED_PROBLEM_CROP_ADJUDICATION_PROMPT_DIGEST,
    classificationPromptDigest: PROBLEM_CROP_ADJUDICATION_CLASSIFICATION_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    items: [classification],
  };
  const classificationArtifactItemHash = canonicalEvidenceHash(classification);
  if (!isDeepStrictEqual(classificationCheckpoint, expectedClassificationCheckpoint)
    || (!allowNonExact && classification.transcription_status !== "exact")
    || adjudication.classificationArtifactItemHash !== classificationArtifactItemHash) {
    throw new Error(`${key}: classification crop adjudication is stale or non-exact`);
  }
  const evidence = {
    allowlistId: spec.allowlistId,
    key,
    printedNumber: failedQuestion.printedNumber,
    sourcePage: spec.sourcePage,
    sourcePages,
    sourceHash: problemEvidence.sha256,
    parentRecoveryEvidenceHash,
    cropEvidenceArtifact,
    cropEvidencePdf,
    cropViews,
    problemArtifact: {
      ...problemArtifact,
      promptVersion: TARGETED_PROBLEM_CROP_ADJUDICATION_VERSION,
      promptDigest: TARGETED_PROBLEM_CROP_ADJUDICATION_PROMPT_DIGEST,
    },
    problemArtifactItemHash,
    classificationArtifact: {
      ...classificationArtifact,
      rulesDigest,
      transcriptionGateVersion: contract.transcriptionGateVersion,
      transcriptionPromptDigest: contract.transcriptionPromptDigest,
      adjudicationPromptVersion: TARGETED_PROBLEM_CROP_ADJUDICATION_VERSION,
      adjudicationPromptDigest: TARGETED_PROBLEM_CROP_ADJUDICATION_PROMPT_DIGEST,
      classificationPromptDigest: PROBLEM_CROP_ADJUDICATION_CLASSIFICATION_PROMPT_DIGEST,
    },
    classificationArtifactItemHash,
    baseQuestionHash: canonicalEvidenceHash(failedQuestion.evidence),
    effectiveQuestionHash: problemArtifactItemHash,
    baseClassificationHash: canonicalEvidenceHash(failedClassification),
    effectiveClassificationHash: classificationArtifactItemHash,
  };
  if (!isDeepStrictEqual(adjudication, evidence)) {
    throw new Error(`${key}: crop adjudication evidence envelope does not match its exact chain`);
  }
  return { question, classification, evidence };
}

function verifyProblemManualAdjudication(
  value: unknown,
  parentRecovery: Record<string, unknown>,
  failedQuestion: ProblemQuestion,
  failedClassification: ClassificationEvidence,
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  rulesDigest: string,
  cache: EvidenceCache,
  contract: VerificationContract,
): { question: ProblemQuestion; classification: ClassificationEvidence; evidence: Record<string, unknown> } {
  const key = failedQuestion.key;
  if (contract.auditVersion !== 5 || failedClassification.transcription_status === "exact") {
    throw new Error(`${key}: manual adjudication requires a current non-exact exhausted recovery`);
  }
  const spec = problemManualAdjudicationSpec(entry, key, failedQuestion.page, problemEvidence.sha256);
  const manual = object(value, `${key}.revision.recovery.manualAdjudication`);
  const parentCrop = parentRecovery.adjudication === undefined
    ? null
    : object(parentRecovery.adjudication, `${key}.manual parent crop adjudication`);
  const parentRecoveryEvidenceHash = canonicalEvidenceHash(parentRecovery);
  const parentCropAdjudicationHash = parentCrop === null ? undefined : canonicalEvidenceHash(parentCrop);
  const sourcePages = [...new Set(spec.views.map((view) => view.sourcePage))].sort((left, right) => left - right);
  if (sourcePages.some((page) => page < 1 || page > problemEvidence.pageCount)
    || parentRecovery.manualAdjudication !== undefined || parentRecovery.scopeAdjudication !== undefined
    || parentRecovery.key !== key || parentRecovery.printedNumber !== failedQuestion.printedNumber
    || parentRecovery.sourcePage !== failedQuestion.page || parentRecovery.sourceHash !== problemEvidence.sha256
    || (spec.parentKind === "crop") !== (parentCrop !== null)
    || manual.allowlistId !== spec.allowlistId || manual.key !== key
    || manual.printedNumber !== failedQuestion.printedNumber || manual.sourcePage !== spec.sourcePage
    || manual.sourceHash !== problemEvidence.sha256
    || manual.parentRecoveryEvidenceHash !== parentRecoveryEvidenceHash
    || manual.parentCropAdjudicationHash !== parentCropAdjudicationHash
    || manual.failedQuestionHash !== spec.failedQuestionHash
    || manual.failedQuestionHash !== canonicalEvidenceHash(failedQuestion.evidence)
    || manual.failedClassificationHash !== spec.failedClassificationHash
    || manual.failedClassificationHash !== canonicalEvidenceHash(failedClassification)
    || manual.failedClassificationEvidenceHash !== spec.failedClassificationEvidenceHash
    || manual.failedClassificationEvidenceHash !== sha256(failedClassification.transcription_evidence)
    || manual.correctionSpecHash !== problemManualCorrectionSpecHash(spec)
    || !isDeepStrictEqual(manual.sourcePages, sourcePages)) {
    throw new Error(`${key}: manual adjudication allowlist/parent authority is stale`);
  }

  const cropEvidenceArtifact = evidencePointer(
    manual.cropEvidenceArtifact,
    `${key}.manualAdjudication.cropEvidenceArtifact`,
  );
  const cropEvidencePdf = evidencePointer(
    manual.cropEvidencePdf,
    `${key}.manualAdjudication.cropEvidencePdf`,
  );
  if (!Array.isArray(manual.cropViews) || manual.cropViews.length !== spec.views.length) {
    throw new Error(`${key}: manual crop view coverage is not exact`);
  }
  let cropViews: Array<{
    sourcePage: number;
    label: string;
    rect: number[];
    pixelWidth: number;
    pixelHeight: number;
    pixelSha256: string;
    artifact: EvidencePointer;
  }>;
  if (spec.parentKind === "recovery") {
    const evidenceBasis = {
      allowlistId: spec.allowlistId,
      entryId: entry.id,
      key,
      sourcePage: spec.sourcePage,
      sourcePages,
      sourceHash: problemEvidence.sha256,
      dpi: PROBLEM_CROP_DPI,
      views: spec.views,
      requiredTokens: spec.requiredTokens,
    };
    const evidenceDigest = canonicalEvidenceHash(evidenceBasis);
    const evidenceStem = `v${PROBLEM_MANUAL_ADJUDICATION_VERSION}-` +
      `${String(spec.sourcePage).padStart(4, "0")}-${failedQuestion.printedNumber.padStart(4, "0")}-` +
      evidenceDigest;
    if (cropEvidenceArtifact.path !== `problem-manual-evidence/${evidenceStem}.json`
      || cropEvidencePdf.path !== `problem-manual-evidence/${evidenceStem}.pdf`) {
      throw new Error(`${key}: manual crop evidence paths are stale`);
    }
    const cropCheckpoint = readBoundEvidenceCached(
      cache,
      stateDir,
      cropEvidenceArtifact,
      `${key} manual crop evidence checkpoint`,
    );
    if (!Array.isArray(cropCheckpoint.views) || cropCheckpoint.views.length !== spec.views.length) {
      throw new Error(`${key}: manual crop evidence checkpoint has incomplete views`);
    }
    cropViews = cropCheckpoint.views.map((raw, index) => {
      const row = object(raw, `${key}.manual crop views[${index}]`);
      const expected = spec.views[index];
      if (!Array.isArray(row.rect) || row.rect.length !== 4
        || !isDeepStrictEqual(row.rect, [...expected.rect])
        || row.sourcePage !== expected.sourcePage || row.label !== expected.label) {
        throw new Error(`${key}: manual crop view ${index} does not match the allowlist`);
      }
      const pixelWidth = integer(row.pixelWidth, `${key}.manual.cropViews[${index}].pixelWidth`, 1);
      const pixelHeight = integer(row.pixelHeight, `${key}.manual.cropViews[${index}].pixelHeight`, 1);
      const pixelSha256 = digest(row.pixelSha256, `${key}.manual.cropViews[${index}].pixelSha256`);
      const artifact = evidencePointer(row.artifact, `${key}.manual.cropViews[${index}].artifact`);
      const expectedPath = `problem-manual-evidence/${evidenceStem}-view-${String(index).padStart(2, "0")}.png`;
      if (artifact.path !== expectedPath || artifact.sha256 !== pixelSha256) {
        throw new Error(`${key}: manual crop view ${index} path/hash is stale`);
      }
      const absolute = confinedEvidencePath(stateDir, artifact, `${key} manual crop view ${index}`);
      if (hashFile(absolute) !== pixelSha256) throw new Error(`${key}: manual crop view ${index} hash mismatch`);
      const dimensions = cropPngDimensions(absolute, `${key} manual crop view ${index}`);
      if (dimensions.width !== pixelWidth || dimensions.height !== pixelHeight) {
        throw new Error(`${key}: manual crop view ${index} dimensions are stale`);
      }
      return {
        sourcePage: expected.sourcePage,
        label: expected.label,
        rect: [...expected.rect],
        pixelWidth,
        pixelHeight,
        pixelSha256,
        artifact,
      };
    });
    const cropPdfPath = confinedEvidencePath(stateDir, cropEvidencePdf, `${key} manual crop evidence PDF`);
    if (hashFile(cropPdfPath) !== cropEvidencePdf.sha256) {
      throw new Error(`${key}: manual crop evidence PDF hash mismatch`);
    }
    const expectedCropCheckpoint = {
      version: PROBLEM_MANUAL_ADJUDICATION_VERSION,
      entryId: entry.id,
      basisDigest: evidenceDigest,
      basis: evidenceBasis,
      renderer: "pdftocairo-png+pdf-lib",
      dpi: PROBLEM_CROP_DPI,
      evidencePdf: cropEvidencePdf,
      views: cropViews,
    };
    if (!isDeepStrictEqual(cropCheckpoint, expectedCropCheckpoint)
      || !isDeepStrictEqual(manual.cropViews, cropViews)) {
      throw new Error(`${key}: manual crop evidence checkpoint/envelope is stale or incomplete`);
    }
  } else {
    if (parentCrop === null || !isDeepStrictEqual(manual.cropEvidenceArtifact, parentCrop.cropEvidenceArtifact)
      || !isDeepStrictEqual(manual.cropEvidencePdf, parentCrop.cropEvidencePdf)
      || !isDeepStrictEqual(manual.cropViews, parentCrop.cropViews)) {
      throw new Error(`${key}: manual adjudication changed the attested parent crop evidence`);
    }
    cropViews = manual.cropViews.map((raw, index) => {
      const row = object(raw, `${key}.manual crop views[${index}]`);
      const expected = spec.views[index];
      const artifact = evidencePointer(row.artifact, `${key}.manual.cropViews[${index}].artifact`);
      const pixelWidth = integer(row.pixelWidth, `${key}.manual.cropViews[${index}].pixelWidth`, 1);
      const pixelHeight = integer(row.pixelHeight, `${key}.manual.cropViews[${index}].pixelHeight`, 1);
      const pixelSha256 = digest(row.pixelSha256, `${key}.manual.cropViews[${index}].pixelSha256`);
      if (!Array.isArray(row.rect) || !isDeepStrictEqual(row.rect, [...expected.rect])
        || row.sourcePage !== expected.sourcePage || row.label !== expected.label
        || artifact.sha256 !== pixelSha256) {
        throw new Error(`${key}: reused crop view ${index} is stale`);
      }
      return {
        sourcePage: expected.sourcePage,
        label: expected.label,
        rect: [...expected.rect],
        pixelWidth,
        pixelHeight,
        pixelSha256,
        artifact,
      };
    });
  }

  const commonBasis = {
    allowlistId: spec.allowlistId,
    entryId: entry.id,
    key,
    printedNumber: failedQuestion.printedNumber,
    sourcePage: spec.sourcePage,
    sourcePages,
    sourceHash: problemEvidence.sha256,
    parentRecovery,
    parentRecoveryEvidenceHash,
    ...(parentCropAdjudicationHash ? { parentCropAdjudicationHash } : {}),
    failedQuestionHash: spec.failedQuestionHash,
    failedClassificationHash: spec.failedClassificationHash,
    failedClassificationEvidenceHash: spec.failedClassificationEvidenceHash,
    correctionSpecHash: problemManualCorrectionSpecHash(spec),
    cropEvidenceArtifact,
    cropEvidencePdf,
    cropViews,
  };
  const basisDigest = canonicalEvidenceHash(commonBasis);
  const stem = `v${PROBLEM_MANUAL_ADJUDICATION_VERSION}-${String(spec.sourcePage).padStart(4, "0")}-` +
    `${failedQuestion.printedNumber.padStart(4, "0")}-${basisDigest}`;
  const problemEnvelope = object(manual.problemArtifact, `${key}.manualAdjudication.problemArtifact`);
  if (Object.keys(problemEnvelope).sort().join(",") !== "correctionDigest,correctionVersion,path,sha256"
    || problemEnvelope.correctionVersion !== PROBLEM_MANUAL_ADJUDICATION_VERSION
    || problemEnvelope.correctionDigest !== PROBLEM_MANUAL_CORRECTION_DIGEST) {
    throw new Error(`${key}: problem manual adjudication envelope is stale`);
  }
  const problemArtifact = evidencePointer(
    { path: problemEnvelope.path, sha256: problemEnvelope.sha256 },
    `${key}.manualAdjudication.problemArtifact`,
  );
  const expectedProblemPath = `problem-manual-adjudications/${stem}.json`;
  if (problemArtifact.path !== expectedProblemPath) {
    throw new Error(`${key}: problem manual adjudication path is stale`);
  }
  const problemCheckpoint = readBoundEvidenceCached(
    cache,
    stateDir,
    problemArtifact,
    `${key} problem manual adjudication`,
  );
  const question = parseProblem(problemCheckpoint.item, `${key} problem manual adjudication.item`);
  const expectedQuestion = applyProblemManualCorrection(failedQuestion, spec);
  const problemArtifactItemHash = canonicalEvidenceHash(question.evidence);
  const expectedProblemCheckpoint = {
    version: PROBLEM_MANUAL_ADJUDICATION_VERSION,
    entryId: entry.id,
    basisDigest,
    basis: commonBasis,
    correctionVersion: PROBLEM_MANUAL_ADJUDICATION_VERSION,
    correctionDigest: PROBLEM_MANUAL_CORRECTION_DIGEST,
    item: expectedQuestion.evidence,
  };
  if (!isDeepStrictEqual(question.evidence, expectedQuestion.evidence)
    || !isDeepStrictEqual(problemCheckpoint, expectedProblemCheckpoint)
    || manual.problemArtifactItemHash !== problemArtifactItemHash
    || manual.baseQuestionHash !== spec.failedQuestionHash
    || manual.effectiveQuestionHash !== problemArtifactItemHash) {
    throw new Error(`${key}: problem manual adjudication metadata/content is stale`);
  }

  const classificationBasis = {
    ...commonBasis,
    problemArtifact,
    problemArtifactItemHash,
    effectiveQuestionHash: problemArtifactItemHash,
  };
  const classificationBasisDigest = canonicalEvidenceHash(classificationBasis);
  const classificationEnvelope = object(
    manual.classificationArtifact,
    `${key}.manualAdjudication.classificationArtifact`,
  );
  if (Object.keys(classificationEnvelope).sort().join(",") !==
      "adjudicationPromptDigest,adjudicationVersion,path,rulesDigest,sha256,transcriptionGateVersion,transcriptionPromptDigest"
    || classificationEnvelope.rulesDigest !== rulesDigest
    || classificationEnvelope.transcriptionGateVersion !== contract.transcriptionGateVersion
    || classificationEnvelope.transcriptionPromptDigest !== contract.transcriptionPromptDigest
    || classificationEnvelope.adjudicationVersion !== PROBLEM_MANUAL_ADJUDICATION_VERSION
    || classificationEnvelope.adjudicationPromptDigest !== PROBLEM_MANUAL_ADJUDICATION_PROMPT_DIGEST) {
    throw new Error(`${key}: classification manual adjudication envelope is stale`);
  }
  const classificationArtifact = evidencePointer(
    { path: classificationEnvelope.path, sha256: classificationEnvelope.sha256 },
    `${key}.manualAdjudication.classificationArtifact`,
  );
  const expectedClassificationPath = `classification-manual-adjudications/` +
    `v${CLASSIFICATION_MANUAL_ADJUDICATION_VERSION}-${String(spec.sourcePage).padStart(4, "0")}-` +
    `${failedQuestion.printedNumber.padStart(4, "0")}-${classificationBasisDigest}-${rulesDigest}.json`;
  if (classificationArtifact.path !== expectedClassificationPath) {
    throw new Error(`${key}: classification manual adjudication path is stale`);
  }
  const classificationCheckpoint = readBoundEvidenceCached(
    cache,
    stateDir,
    classificationArtifact,
    `${key} classification manual adjudication`,
  );
  if (!Array.isArray(classificationCheckpoint.items) || classificationCheckpoint.items.length !== 1) {
    throw new Error(`${key}: classification manual adjudication must contain exactly one decision`);
  }
  const classification = parseClassificationEvidence(
    classificationCheckpoint.items[0],
    question,
    entry,
    `${key} classification manual adjudication.items[0]`,
  );
  const classificationArtifactItemHash = canonicalEvidenceHash(classification);
  const expectedClassificationCheckpoint = {
    version: CLASSIFICATION_MANUAL_ADJUDICATION_VERSION,
    entryId: entry.id,
    basisDigest: classificationBasisDigest,
    basis: classificationBasis,
    classifierVersion: contract.classifierVersion,
    rulesDigest,
    transcriptionGateVersion: contract.transcriptionGateVersion,
    transcriptionPromptDigest: contract.transcriptionPromptDigest,
    adjudicationVersion: PROBLEM_MANUAL_ADJUDICATION_VERSION,
    adjudicationPromptDigest: PROBLEM_MANUAL_ADJUDICATION_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    items: [classification],
  };
  if (!isDeepStrictEqual(classificationCheckpoint, expectedClassificationCheckpoint)
    || classification.transcription_status !== "exact"
    || !matchesProblemManualExpectedDecision(spec, classification)
    || manual.classificationArtifactItemHash !== classificationArtifactItemHash
    || manual.baseClassificationHash !== spec.failedClassificationHash
    || manual.effectiveClassificationHash !== classificationArtifactItemHash) {
    throw new Error(`${key}: classification manual adjudication is stale or non-exact`);
  }
  const evidence = {
    allowlistId: spec.allowlistId,
    key,
    printedNumber: failedQuestion.printedNumber,
    sourcePage: spec.sourcePage,
    sourcePages,
    sourceHash: problemEvidence.sha256,
    parentRecoveryEvidenceHash,
    ...(parentCropAdjudicationHash ? { parentCropAdjudicationHash } : {}),
    failedQuestionHash: spec.failedQuestionHash,
    failedClassificationHash: spec.failedClassificationHash,
    failedClassificationEvidenceHash: spec.failedClassificationEvidenceHash,
    correctionSpecHash: problemManualCorrectionSpecHash(spec),
    cropEvidenceArtifact,
    cropEvidencePdf,
    cropViews,
    problemArtifact: {
      ...problemArtifact,
      correctionVersion: PROBLEM_MANUAL_ADJUDICATION_VERSION,
      correctionDigest: PROBLEM_MANUAL_CORRECTION_DIGEST,
    },
    problemArtifactItemHash,
    classificationArtifact: {
      ...classificationArtifact,
      rulesDigest,
      transcriptionGateVersion: contract.transcriptionGateVersion,
      transcriptionPromptDigest: contract.transcriptionPromptDigest,
      adjudicationVersion: PROBLEM_MANUAL_ADJUDICATION_VERSION,
      adjudicationPromptDigest: PROBLEM_MANUAL_ADJUDICATION_PROMPT_DIGEST,
    },
    classificationArtifactItemHash,
    baseQuestionHash: spec.failedQuestionHash,
    effectiveQuestionHash: problemArtifactItemHash,
    baseClassificationHash: spec.failedClassificationHash,
    effectiveClassificationHash: classificationArtifactItemHash,
  };
  if (!isDeepStrictEqual(manual, evidence)) {
    throw new Error(`${key}: manual adjudication evidence envelope does not match its exact chain`);
  }
  return { question, classification, evidence };
}

function problemScopeAdjudicationSpec(
  entry: ManifestEntry,
  key: string,
  sourcePage: number,
  sourceHash: string,
  solutionSourceHash: string,
): ProblemScopeAdjudicationSpec {
  const matches = PROBLEM_SCOPE_ADJUDICATION_ALLOWLIST.filter((spec) =>
    spec.entryId === entry.id && spec.key === key && spec.sourcePage === sourcePage);
  if (matches.length !== 1) {
    throw new Error(`${entry.id} ${key}: scope adjudication is not uniquely allowlisted`);
  }
  if (matches[0].sourceHash !== sourceHash || matches[0].solutionSourceHash !== solutionSourceHash) {
    throw new Error(`${entry.id} ${key}: official scope sources do not match the allowlist`);
  }
  return matches[0];
}

function problemRepairScopeAdjudicationSpec(
  entry: ManifestEntry,
  key: string,
  sourcePage: number,
  sourceHash: string,
  solutionSourceHash: string,
): ProblemScopeAdjudicationSpec {
  const matches = PROBLEM_REPAIR_SCOPE_ADJUDICATION_ALLOWLIST.filter((spec) =>
    spec.entryId === entry.id && spec.key === key && spec.sourcePage === sourcePage);
  if (matches.length !== 1) {
    throw new Error(`${entry.id} ${key}: repair scope adjudication is not uniquely allowlisted`);
  }
  if (matches[0].sourceHash !== sourceHash || matches[0].solutionSourceHash !== solutionSourceHash) {
    throw new Error(`${entry.id} ${key}: official repair scope sources do not match the allowlist`);
  }
  return matches[0];
}

function verifyProblemScopeAdjudication(
  value: unknown,
  parentRecovery: Record<string, unknown>,
  recoveredQuestion: ProblemQuestion,
  recoveredClassification: ClassificationEvidence,
  row: V3RevisionRow,
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  solutionEvidence: DownloadEvidence,
  rulesDigest: string,
  cache: EvidenceCache,
  contract: VerificationContract,
): {
  classification: ClassificationEvidence;
  evidence: Record<string, unknown>;
  generation: {
    key: string;
    current: ClassifiedEvidence;
    checkpoint: ProblemTerminalFidelityCheckpoint;
  };
} {
  const key = recoveredQuestion.key;
  if (contract.auditVersion !== 5 || contract.problemTerminalFidelityVersion !== PROBLEM_TERMINAL_FIDELITY_VERSION
    || recoveredClassification.transcription_status !== "exact"
    || recoveredClassification.decision !== "accept" || parentRecovery.adjudication !== undefined
    || parentRecovery.scopeAdjudication !== undefined) {
    throw new Error(`${key}: scope adjudication requires one current exact accept recovery`);
  }
  const spec = problemScopeAdjudicationSpec(
    entry,
    key,
    recoveredQuestion.page,
    problemEvidence.sha256,
    solutionEvidence.sha256,
  );
  if (problemEvidence.pageCount > PROBLEM_SLICE_PAGES
    || row.first.row.contextFrom !== 1 || row.first.row.contextTo !== problemEvidence.pageCount) {
    throw new Error(`${key}: scope adjudication problem context is not the exact bounded source`);
  }
  const adjudication = object(value, `${key}.revision.recovery.scopeAdjudication`);
  if (parentRecovery.key !== key || parentRecovery.printedNumber !== recoveredQuestion.printedNumber
    || parentRecovery.sourcePage !== recoveredQuestion.page || parentRecovery.sourceHash !== problemEvidence.sha256
    || parentRecovery.effectiveQuestionHash !== canonicalEvidenceHash(recoveredQuestion.evidence)
    || parentRecovery.effectiveClassificationHash !== canonicalEvidenceHash(recoveredClassification)) {
    throw new Error(`${key}: scope adjudication does not bind the latest exact recovery`);
  }
  const parentRecoveryEvidenceHash = canonicalEvidenceHash(parentRecovery);
  if (adjudication.parentRecoveryEvidenceHash !== parentRecoveryEvidenceHash) {
    throw new Error(`${key}: scope adjudication parent recovery hash is stale`);
  }

  const triggerRow = object(adjudication.trigger, `${key}.scopeAdjudication.trigger`);
  const terminalCheckpoint = problemTerminalFidelityCheckpoint(
    triggerRow.terminalCheckpoint,
    `${key}.scopeAdjudication.trigger.terminalCheckpoint`,
  );
  const pathMatch = new RegExp(
    `^problem-terminal-fidelity/v${PROBLEM_TERMINAL_FIDELITY_VERSION}-(\\d{4})-` +
      "([a-f0-9]{64})-([a-f0-9]{64})\\.json$",
    "u",
  ).exec(terminalCheckpoint.path);
  const slice = pathMatch && expectedProblemFidelitySlices(problemEvidence.pageCount)[Number(pathMatch[1])];
  if (!pathMatch || Number(pathMatch[1]) !== 0 || !slice
    || terminalCheckpoint.from !== slice.from || terminalCheckpoint.to !== slice.to
    || terminalCheckpoint.ownedFrom !== slice.ownedFrom || terminalCheckpoint.ownedTo !== slice.ownedTo
    || terminalCheckpoint.inputHash !== pathMatch[3]
    || recoveredQuestion.page < slice.ownedFrom || recoveredQuestion.page > slice.ownedTo) {
    throw new Error(`${key}: scope adjudication terminal checkpoint path/slice is invalid`);
  }
  const terminalArtifact = readBoundEvidenceCached(
    cache,
    stateDir,
    terminalCheckpoint,
    `${key} scope adjudication terminal checkpoint`,
  );
  if (!Array.isArray(terminalArtifact.inputs) || !Array.isArray(terminalArtifact.items)
    || terminalArtifact.version !== PROBLEM_TERMINAL_FIDELITY_VERSION
    || terminalArtifact.entryId !== entry.id || terminalArtifact.sourceHash !== problemEvidence.sha256
    || terminalArtifact.from !== slice.from || terminalArtifact.to !== slice.to
    || terminalArtifact.ownedFrom !== slice.ownedFrom || terminalArtifact.ownedTo !== slice.ownedTo
    || terminalArtifact.effectiveCorpusHash !== pathMatch[2]
    || terminalArtifact.inputHash !== terminalCheckpoint.inputHash
    || canonicalEvidenceHash(terminalArtifact.inputs) !== terminalCheckpoint.inputHash
    || terminalArtifact.transcriptionGateVersion !== contract.transcriptionGateVersion
    || terminalArtifact.transcriptionPromptDigest !== contract.transcriptionPromptDigest
    || terminalArtifact.rulesDigest !== rulesDigest
    || terminalArtifact.scopePromptDigest !== contract.problemTerminalScopePromptDigest
    || terminalArtifact.model !== "gpt-5.6-sol" || terminalArtifact.reasoningEffort !== "high") {
    throw new Error(`${key}: scope adjudication terminal checkpoint metadata is stale`);
  }
  const terminalInputs = terminalArtifact.inputs.map((raw, index) =>
    object(raw, `${key}.scopeAdjudication.terminal.inputs[${index}]`));
  const terminalItems = terminalArtifact.items.map((raw, index) =>
    parseProblemTerminalFidelityItem(raw, `${key}.scopeAdjudication.terminal.items[${index}]`, contract));
  const inputKeys = terminalInputs.map((input, index) =>
    exactString(input.key, `${key}.scopeAdjudication.terminal.inputs[${index}].key`));
  const itemKeys = terminalItems.map((item) => item.key);
  if (new Set(inputKeys).size !== inputKeys.length || new Set(itemKeys).size !== itemKeys.length
    || !isDeepStrictEqual(
      [...inputKeys].sort(compareCorpusQuestionKeys),
      [...itemKeys].sort(compareCorpusQuestionKeys),
    )) {
    throw new Error(`${key}: scope adjudication terminal input/item coverage is not exact`);
  }
  const expectedTerminalArtifact = {
    version: PROBLEM_TERMINAL_FIDELITY_VERSION,
    entryId: entry.id,
    sourceHash: problemEvidence.sha256,
    from: slice.from,
    to: slice.to,
    ownedFrom: slice.ownedFrom,
    ownedTo: slice.ownedTo,
    effectiveCorpusHash: pathMatch[2],
    inputHash: terminalCheckpoint.inputHash,
    transcriptionGateVersion: contract.transcriptionGateVersion,
    transcriptionPromptDigest: contract.transcriptionPromptDigest,
    rulesDigest,
    scopePromptDigest: contract.problemTerminalScopePromptDigest,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    inputs: terminalInputs,
    items: terminalItems,
  };
  if (!isDeepStrictEqual(terminalArtifact, expectedTerminalArtifact)) {
    throw new Error(`${key}: scope adjudication terminal checkpoint envelope is not exact`);
  }
  const terminalItem = parseProblemTerminalFidelityItem(
    triggerRow.terminalItem,
    `${key}.scopeAdjudication.trigger.terminalItem`,
    contract,
  );
  const checkpointItem = terminalItems.find((item) => item.key === key);
  const terminalItemHash = canonicalEvidenceHash(terminalItem);
  const preAdjudicationEffectiveCorpusHash = digest(
    triggerRow.preAdjudicationEffectiveCorpusHash,
    `${key}.scopeAdjudication.trigger.preAdjudicationEffectiveCorpusHash`,
  );
  const trigger = {
    terminalCheckpoint,
    terminalItemHash,
    terminalItem,
    evidenceHash: sha256(terminalItem.evidence),
    scopeEvidenceHash: sha256(terminalItem.scopeEvidence ?? ""),
    preAdjudicationEffectiveCorpusHash,
  };
  if (!checkpointItem || !isDeepStrictEqual(checkpointItem, terminalItem)
    || terminalItem.status !== "exact" || terminalItem.scopeDecision !== "reject"
    || terminalItem.scopeConfidence < 0.9 || terminalItemHash !== triggerRow.terminalItemHash
    || preAdjudicationEffectiveCorpusHash !== pathMatch[2]
    || !isDeepStrictEqual(triggerRow, trigger)) {
    throw new Error(`${key}: scope adjudication terminal conflict authority is stale`);
  }

  const baseSolution = row.first.row.solution;
  const baseSolutionCheckpoint = evidencePointer(
    adjudication.baseSolutionCheckpoint,
    `${key}.scopeAdjudication.baseSolutionCheckpoint`,
  );
  sameEvidencePointer(baseSolutionCheckpoint, baseSolution.checkpoint, `${key}.scopeAdjudication base solution`);
  if (adjudication.baseSolutionItemHash !== canonicalEvidenceHash(baseSolution.evidence)
    || adjudication.solutionContextFrom !== baseSolution.contextFrom
    || adjudication.solutionContextTo !== baseSolution.contextTo
    || adjudication.problemContextFrom !== row.first.row.contextFrom
    || adjudication.problemContextTo !== row.first.row.contextTo) {
    throw new Error(`${key}: scope adjudication official solution/context binding is stale`);
  }
  const basis = {
    allowlistId: spec.allowlistId,
    entryId: entry.id,
    key,
    printedNumber: recoveredQuestion.printedNumber,
    sourcePage: recoveredQuestion.page,
    sourceHash: problemEvidence.sha256,
    solutionSourceHash: solutionEvidence.sha256,
    problemContextFrom: row.first.row.contextFrom,
    problemContextTo: row.first.row.contextTo,
    solutionContextFrom: baseSolution.contextFrom,
    solutionContextTo: baseSolution.contextTo,
    baseSolutionCheckpoint,
    baseSolutionItemHash: canonicalEvidenceHash(baseSolution.evidence),
    parentRecovery,
    parentRecoveryEvidenceHash,
    trigger,
    baseQuestionHash: canonicalEvidenceHash(recoveredQuestion.evidence),
    baseClassificationHash: canonicalEvidenceHash(recoveredClassification),
  };
  const basisDigest = canonicalEvidenceHash(basis);
  const classificationEnvelope = object(
    adjudication.classificationArtifact,
    `${key}.scopeAdjudication.classificationArtifact`,
  );
  if (Object.keys(classificationEnvelope).sort().join(",") !==
    "adjudicationPromptDigest,adjudicationPromptVersion,path,rulesDigest,sha256,transcriptionGateVersion,transcriptionPromptDigest"
    || classificationEnvelope.rulesDigest !== rulesDigest
    || classificationEnvelope.transcriptionGateVersion !== contract.transcriptionGateVersion
    || classificationEnvelope.transcriptionPromptDigest !== contract.transcriptionPromptDigest
    || classificationEnvelope.adjudicationPromptVersion !== PROBLEM_SCOPE_ADJUDICATION_VERSION
    || classificationEnvelope.adjudicationPromptDigest !== PROBLEM_SCOPE_ADJUDICATION_PROMPT_DIGEST) {
    throw new Error(`${key}: scope adjudication classification envelope is stale`);
  }
  const classificationArtifact = evidencePointer(
    { path: classificationEnvelope.path, sha256: classificationEnvelope.sha256 },
    `${key}.scopeAdjudication.classificationArtifact`,
  );
  const expectedPath = `classification-scope-adjudications/v${PROBLEM_SCOPE_ADJUDICATION_VERSION}-` +
    `${String(recoveredQuestion.page).padStart(4, "0")}-` +
    `${recoveredQuestion.printedNumber.padStart(4, "0")}-${basisDigest}-${rulesDigest}.json`;
  if (classificationArtifact.path !== expectedPath) {
    throw new Error(`${key}: scope adjudication classification path is stale`);
  }
  const checkpoint = readBoundEvidenceCached(
    cache,
    stateDir,
    classificationArtifact,
    `${key} scope adjudication classification`,
  );
  if (!Array.isArray(checkpoint.items) || checkpoint.items.length !== 1) {
    throw new Error(`${key}: scope adjudication classification must contain one decision`);
  }
  const classification = parseClassificationEvidence(
    checkpoint.items[0],
    recoveredQuestion,
    entry,
    `${key}.scopeAdjudication.classification.items[0]`,
  );
  const expectedCheckpoint = {
    version: PROBLEM_SCOPE_ADJUDICATION_VERSION,
    entryId: entry.id,
    basisDigest,
    basis,
    classifierVersion: contract.classifierVersion,
    rulesDigest,
    transcriptionGateVersion: contract.transcriptionGateVersion,
    transcriptionPromptDigest: contract.transcriptionPromptDigest,
    adjudicationPromptVersion: PROBLEM_SCOPE_ADJUDICATION_VERSION,
    adjudicationPromptDigest: PROBLEM_SCOPE_ADJUDICATION_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    items: [classification],
  };
  const classificationArtifactItemHash = canonicalEvidenceHash(classification);
  if (!isDeepStrictEqual(checkpoint, expectedCheckpoint)
    || classification.decision !== "reject" || classification.canonical_subject !== null
    || classification.curriculum_course !== null || classification.domain !== null
    || classification.achievement_codes.length !== 0 || classification.confidence < 0.9
    || classification.transcription_status !== "exact"
    || adjudication.classificationArtifactItemHash !== classificationArtifactItemHash) {
    throw new Error(`${key}: scope adjudication output is not exact high-confidence reject/null`);
  }
  const evidence = {
    allowlistId: spec.allowlistId,
    key,
    printedNumber: recoveredQuestion.printedNumber,
    sourcePage: recoveredQuestion.page,
    sourceHash: problemEvidence.sha256,
    solutionSourceHash: solutionEvidence.sha256,
    problemContextFrom: row.first.row.contextFrom,
    problemContextTo: row.first.row.contextTo,
    solutionContextFrom: baseSolution.contextFrom,
    solutionContextTo: baseSolution.contextTo,
    baseSolutionCheckpoint,
    baseSolutionItemHash: canonicalEvidenceHash(baseSolution.evidence),
    parentRecoveryEvidenceHash,
    trigger,
    classificationArtifact: {
      ...classificationArtifact,
      rulesDigest,
      transcriptionGateVersion: contract.transcriptionGateVersion,
      transcriptionPromptDigest: contract.transcriptionPromptDigest,
      adjudicationPromptVersion: PROBLEM_SCOPE_ADJUDICATION_VERSION,
      adjudicationPromptDigest: PROBLEM_SCOPE_ADJUDICATION_PROMPT_DIGEST,
    },
    classificationArtifactItemHash,
    baseQuestionHash: canonicalEvidenceHash(recoveredQuestion.evidence),
    effectiveQuestionHash: canonicalEvidenceHash(recoveredQuestion.evidence),
    baseClassificationHash: canonicalEvidenceHash(recoveredClassification),
    effectiveClassificationHash: classificationArtifactItemHash,
  };
  if (!isDeepStrictEqual(adjudication, evidence)) {
    throw new Error(`${key}: scope adjudication evidence envelope does not match its exact chain`);
  }
  return {
    classification,
    evidence,
    generation: {
      key,
      current: {
        question: recoveredQuestion,
        classification: recoveredClassification,
        problemCheckpoint: row.first.row.base.problemCheckpoint,
        classificationCheckpoint: row.first.row.base.classificationCheckpoint,
        contextFrom: row.first.row.contextFrom,
        contextTo: row.first.row.contextTo,
      },
      checkpoint: terminalCheckpoint,
    },
  };
}

function verifyProblemRepairScopeAdjudication(
  value: unknown,
  first: V3FirstRepair,
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  solutionEvidence: DownloadEvidence,
  rulesDigest: string,
  cache: EvidenceCache,
  contract: VerificationContract,
): {
  classified: ClassifiedEvidence;
  evidence: Record<string, unknown>;
  generation: { key: string; current: ClassifiedEvidence; checkpoint: ProblemTerminalFidelityCheckpoint };
} {
  const current = first.classified;
  const key = current.question.key;
  if (contract.auditVersion !== 5
    || contract.problemTerminalFidelityVersion !== PROBLEM_TERMINAL_FIDELITY_VERSION
    || current.classification.transcription_status !== "exact"
    || current.classification.decision !== "accept" || first.row.raw.revision !== undefined) {
    throw new Error(`${key}: repair scope adjudication requires one current exact accept first repair`);
  }
  const spec = problemRepairScopeAdjudicationSpec(
    entry,
    key,
    current.question.page,
    problemEvidence.sha256,
    solutionEvidence.sha256,
  );
  if (problemEvidence.pageCount > PROBLEM_SLICE_PAGES
    || first.row.contextFrom !== 1 || first.row.contextTo !== problemEvidence.pageCount) {
    throw new Error(`${key}: repair scope problem context is not the exact bounded source`);
  }
  const adjudication = object(value, `${key}.scopeAdjudication`);
  const parentRepair = first.evidence;
  const parentRepairEvidenceHash = canonicalEvidenceHash(parentRepair);
  if (adjudication.parentRecoveryEvidenceHash !== undefined
    || adjudication.parentRepairEvidenceHash !== parentRepairEvidenceHash
    || parentRepair.effectiveQuestionHash !== canonicalEvidenceHash(current.question.evidence)
    || parentRepair.effectiveClassificationHash !== canonicalEvidenceHash(current.classification)) {
    throw new Error(`${key}: repair scope adjudication parent repair hash is stale`);
  }

  const triggerRow = object(adjudication.trigger, `${key}.repairScopeAdjudication.trigger`);
  const terminalCheckpoint = problemTerminalFidelityCheckpoint(
    triggerRow.terminalCheckpoint,
    `${key}.repairScopeAdjudication.trigger.terminalCheckpoint`,
  );
  const pathMatch = new RegExp(
    `^problem-terminal-fidelity/v${PROBLEM_TERMINAL_FIDELITY_VERSION}-(\\d{4})-` +
      "([a-f0-9]{64})-([a-f0-9]{64})\\.json$",
    "u",
  ).exec(terminalCheckpoint.path);
  const slice = pathMatch && expectedProblemFidelitySlices(problemEvidence.pageCount)[Number(pathMatch[1])];
  if (!pathMatch || Number(pathMatch[1]) !== 0 || !slice
    || terminalCheckpoint.from !== slice.from || terminalCheckpoint.to !== slice.to
    || terminalCheckpoint.ownedFrom !== slice.ownedFrom || terminalCheckpoint.ownedTo !== slice.ownedTo
    || terminalCheckpoint.inputHash !== pathMatch[3]
    || current.question.page < slice.ownedFrom || current.question.page > slice.ownedTo) {
    throw new Error(`${key}: repair scope terminal checkpoint path/slice is invalid`);
  }
  const terminalArtifact = readBoundEvidenceCached(
    cache,
    stateDir,
    terminalCheckpoint,
    `${key} repair scope terminal checkpoint`,
  );
  if (!Array.isArray(terminalArtifact.inputs) || !Array.isArray(terminalArtifact.items)
    || terminalArtifact.version !== PROBLEM_TERMINAL_FIDELITY_VERSION
    || terminalArtifact.entryId !== entry.id || terminalArtifact.sourceHash !== problemEvidence.sha256
    || terminalArtifact.from !== slice.from || terminalArtifact.to !== slice.to
    || terminalArtifact.ownedFrom !== slice.ownedFrom || terminalArtifact.ownedTo !== slice.ownedTo
    || terminalArtifact.effectiveCorpusHash !== pathMatch[2]
    || terminalArtifact.inputHash !== terminalCheckpoint.inputHash
    || canonicalEvidenceHash(terminalArtifact.inputs) !== terminalCheckpoint.inputHash
    || terminalArtifact.transcriptionGateVersion !== contract.transcriptionGateVersion
    || terminalArtifact.transcriptionPromptDigest !== contract.transcriptionPromptDigest
    || terminalArtifact.rulesDigest !== rulesDigest
    || terminalArtifact.scopePromptDigest !== contract.problemTerminalScopePromptDigest
    || terminalArtifact.model !== "gpt-5.6-sol" || terminalArtifact.reasoningEffort !== "high") {
    throw new Error(`${key}: repair scope terminal checkpoint metadata is stale`);
  }
  const terminalInputs = terminalArtifact.inputs.map((raw, index) =>
    object(raw, `${key}.repairScopeAdjudication.terminal.inputs[${index}]`));
  const terminalItems = terminalArtifact.items.map((raw, index) =>
    parseProblemTerminalFidelityItem(
      raw,
      `${key}.repairScopeAdjudication.terminal.items[${index}]`,
      contract,
    ));
  const inputKeys = terminalInputs.map((input, index) =>
    exactString(input.key, `${key}.repairScopeAdjudication.terminal.inputs[${index}].key`));
  const itemKeys = terminalItems.map((item) => item.key);
  if (new Set(inputKeys).size !== inputKeys.length || new Set(itemKeys).size !== itemKeys.length
    || !isDeepStrictEqual(
      [...inputKeys].sort(compareCorpusQuestionKeys),
      [...itemKeys].sort(compareCorpusQuestionKeys),
    )) {
    throw new Error(`${key}: repair scope terminal input/item coverage is not exact`);
  }
  const expectedTerminalArtifact = {
    version: PROBLEM_TERMINAL_FIDELITY_VERSION,
    entryId: entry.id,
    sourceHash: problemEvidence.sha256,
    from: slice.from,
    to: slice.to,
    ownedFrom: slice.ownedFrom,
    ownedTo: slice.ownedTo,
    effectiveCorpusHash: pathMatch[2],
    inputHash: terminalCheckpoint.inputHash,
    transcriptionGateVersion: contract.transcriptionGateVersion,
    transcriptionPromptDigest: contract.transcriptionPromptDigest,
    rulesDigest,
    scopePromptDigest: contract.problemTerminalScopePromptDigest,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    inputs: terminalInputs,
    items: terminalItems,
  };
  if (!isDeepStrictEqual(terminalArtifact, expectedTerminalArtifact)) {
    throw new Error(`${key}: repair scope terminal checkpoint envelope is not exact`);
  }
  const terminalItem = parseProblemTerminalFidelityItem(
    triggerRow.terminalItem,
    `${key}.repairScopeAdjudication.trigger.terminalItem`,
    contract,
  );
  const checkpointItem = terminalItems.find((item) => item.key === key);
  const terminalItemHash = canonicalEvidenceHash(terminalItem);
  const preAdjudicationEffectiveCorpusHash = digest(
    triggerRow.preAdjudicationEffectiveCorpusHash,
    `${key}.repairScopeAdjudication.trigger.preAdjudicationEffectiveCorpusHash`,
  );
  const trigger = {
    terminalCheckpoint,
    terminalItemHash,
    terminalItem,
    evidenceHash: sha256(terminalItem.evidence),
    scopeEvidenceHash: sha256(terminalItem.scopeEvidence ?? ""),
    preAdjudicationEffectiveCorpusHash,
  };
  if (!checkpointItem || !isDeepStrictEqual(checkpointItem, terminalItem)
    || terminalItem.status !== "exact" || terminalItem.scopeDecision !== "reject"
    || terminalItem.scopeConfidence < 0.9 || terminalItemHash !== triggerRow.terminalItemHash
    || preAdjudicationEffectiveCorpusHash !== pathMatch[2]
    || !isDeepStrictEqual(triggerRow, trigger)) {
    throw new Error(`${key}: repair scope terminal conflict authority is stale`);
  }

  const baseSolution = first.row.solution;
  const baseSolutionCheckpoint = evidencePointer(
    adjudication.baseSolutionCheckpoint,
    `${key}.repairScopeAdjudication.baseSolutionCheckpoint`,
  );
  sameEvidencePointer(baseSolutionCheckpoint, first.row.baseSolutionCheckpoint, `${key} repair scope solution repair`);
  sameEvidencePointer(baseSolutionCheckpoint, baseSolution.checkpoint, `${key} repair scope base solution`);
  if (adjudication.baseSolutionItemHash !== first.row.baseSolutionItemHash
    || adjudication.baseSolutionItemHash !== canonicalEvidenceHash(baseSolution.evidence)
    || adjudication.solutionContextFrom !== baseSolution.contextFrom
    || adjudication.solutionContextTo !== baseSolution.contextTo
    || adjudication.problemContextFrom !== first.row.contextFrom
    || adjudication.problemContextTo !== first.row.contextTo) {
    throw new Error(`${key}: repair scope official solution/context binding is stale`);
  }
  const basis = {
    allowlistId: spec.allowlistId,
    entryId: entry.id,
    key,
    printedNumber: current.question.printedNumber,
    sourcePage: current.question.page,
    sourceHash: problemEvidence.sha256,
    solutionSourceHash: solutionEvidence.sha256,
    problemContextFrom: first.row.contextFrom,
    problemContextTo: first.row.contextTo,
    solutionContextFrom: baseSolution.contextFrom,
    solutionContextTo: baseSolution.contextTo,
    baseSolutionCheckpoint,
    baseSolutionItemHash: canonicalEvidenceHash(baseSolution.evidence),
    parentRepair,
    parentRepairEvidenceHash,
    trigger,
    baseQuestionHash: canonicalEvidenceHash(current.question.evidence),
    baseClassificationHash: canonicalEvidenceHash(current.classification),
  };
  const basisDigest = canonicalEvidenceHash(basis);
  const classificationEnvelope = object(
    adjudication.classificationArtifact,
    `${key}.repairScopeAdjudication.classificationArtifact`,
  );
  if (Object.keys(classificationEnvelope).sort().join(",") !==
      "adjudicationPromptDigest,adjudicationPromptVersion,path,rulesDigest,sha256,transcriptionGateVersion,transcriptionPromptDigest"
    || classificationEnvelope.rulesDigest !== rulesDigest
    || classificationEnvelope.transcriptionGateVersion !== contract.transcriptionGateVersion
    || classificationEnvelope.transcriptionPromptDigest !== contract.transcriptionPromptDigest
    || classificationEnvelope.adjudicationPromptVersion !== PROBLEM_REPAIR_SCOPE_ADJUDICATION_VERSION
    || classificationEnvelope.adjudicationPromptDigest !== PROBLEM_REPAIR_SCOPE_ADJUDICATION_PROMPT_DIGEST) {
    throw new Error(`${key}: repair scope classification envelope is stale`);
  }
  const classificationArtifact = evidencePointer(
    { path: classificationEnvelope.path, sha256: classificationEnvelope.sha256 },
    `${key}.repairScopeAdjudication.classificationArtifact`,
  );
  const expectedPath = `classification-repair-scope-adjudications/` +
    `v${PROBLEM_REPAIR_SCOPE_ADJUDICATION_VERSION}-${String(current.question.page).padStart(4, "0")}-` +
    `${current.question.printedNumber.padStart(4, "0")}-${basisDigest}-${rulesDigest}.json`;
  if (classificationArtifact.path !== expectedPath) {
    throw new Error(`${key}: repair scope classification path is stale`);
  }
  const checkpoint = readBoundEvidenceCached(
    cache,
    stateDir,
    classificationArtifact,
    `${key} repair scope classification`,
  );
  if (!Array.isArray(checkpoint.items) || checkpoint.items.length !== 1) {
    throw new Error(`${key}: repair scope classification must contain one decision`);
  }
  const classification = parseClassificationEvidence(
    checkpoint.items[0],
    current.question,
    entry,
    `${key}.repairScopeAdjudication.classification.items[0]`,
  );
  const expectedCheckpoint = {
    version: PROBLEM_REPAIR_SCOPE_ADJUDICATION_VERSION,
    entryId: entry.id,
    basisDigest,
    basis,
    classifierVersion: contract.classifierVersion,
    rulesDigest,
    transcriptionGateVersion: contract.transcriptionGateVersion,
    transcriptionPromptDigest: contract.transcriptionPromptDigest,
    adjudicationPromptVersion: PROBLEM_REPAIR_SCOPE_ADJUDICATION_VERSION,
    adjudicationPromptDigest: PROBLEM_REPAIR_SCOPE_ADJUDICATION_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    items: [classification],
  };
  const classificationArtifactItemHash = canonicalEvidenceHash(classification);
  if (!isDeepStrictEqual(checkpoint, expectedCheckpoint)
    || classification.decision !== "reject" || classification.canonical_subject !== null
    || classification.curriculum_course !== null || classification.domain !== null
    || classification.achievement_codes.length !== 0 || classification.confidence < 0.9
    || classification.transcription_status !== "exact"
    || adjudication.classificationArtifactItemHash !== classificationArtifactItemHash) {
    throw new Error(`${key}: repair scope output is not exact high-confidence reject/null`);
  }
  const evidence = {
    allowlistId: spec.allowlistId,
    key,
    printedNumber: current.question.printedNumber,
    sourcePage: current.question.page,
    sourceHash: problemEvidence.sha256,
    solutionSourceHash: solutionEvidence.sha256,
    problemContextFrom: first.row.contextFrom,
    problemContextTo: first.row.contextTo,
    solutionContextFrom: baseSolution.contextFrom,
    solutionContextTo: baseSolution.contextTo,
    baseSolutionCheckpoint,
    baseSolutionItemHash: canonicalEvidenceHash(baseSolution.evidence),
    parentRepairEvidenceHash,
    trigger,
    classificationArtifact: {
      ...classificationArtifact,
      rulesDigest,
      transcriptionGateVersion: contract.transcriptionGateVersion,
      transcriptionPromptDigest: contract.transcriptionPromptDigest,
      adjudicationPromptVersion: PROBLEM_REPAIR_SCOPE_ADJUDICATION_VERSION,
      adjudicationPromptDigest: PROBLEM_REPAIR_SCOPE_ADJUDICATION_PROMPT_DIGEST,
    },
    classificationArtifactItemHash,
    baseQuestionHash: canonicalEvidenceHash(current.question.evidence),
    effectiveQuestionHash: canonicalEvidenceHash(current.question.evidence),
    baseClassificationHash: canonicalEvidenceHash(current.classification),
    effectiveClassificationHash: classificationArtifactItemHash,
  };
  if (!isDeepStrictEqual(adjudication, evidence)) {
    throw new Error(`${key}: repair scope evidence envelope does not match its exact chain`);
  }
  return {
    classified: { ...current, classification },
    evidence,
    generation: { key, current, checkpoint: terminalCheckpoint },
  };
}

function verifyProblemRecovery(
  row: V3RevisionRow,
  revisedQuestion: ProblemQuestion,
  revisedClassification: ClassificationEvidence,
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  solutionEvidence: DownloadEvidence,
  rulesDigest: string,
  cache: EvidenceCache,
  contract: VerificationContract,
): {
  classified: ClassifiedEvidence;
  evidence: Record<string, unknown>;
  terminalGeneration?: {
    key: string;
    current: ClassifiedEvidence;
    checkpoint: ProblemTerminalFidelityCheckpoint;
  };
  scopeGeneration?: {
    key: string;
    current: ClassifiedEvidence;
    checkpoint: ProblemTerminalFidelityCheckpoint;
  };
} {
  const key = row.first.row.key;
  const recovery = object(row.raw.recovery, `${key}.revision.recovery`);
  const rawTerminalTrigger = recovery.trigger === undefined
    ? null
    : object(recovery.trigger, `${key}.revision.recovery.trigger`);
  if (rawTerminalTrigger === null && revisedClassification.transcription_status === "exact") {
    throw new Error(`${key}: exact problem revision cannot have a classification recovery`);
  }
  if (rawTerminalTrigger !== null && revisedClassification.transcription_status !== "exact") {
    throw new Error(`${key}: terminal recovery requires one exact prior revision`);
  }
  const baseProblemRepairArtifact = row.first.row.problemArtifact;
  const baseClassificationRepairArtifact = row.first.row.classificationArtifact;
  const baseProblemRevisionArtifact = row.problemArtifact;
  const baseClassificationRevisionArtifact = row.classificationArtifact;
  const commonProblemBasis = {
    key,
    printedNumber: row.first.row.printedNumber,
    sourcePage: row.first.row.sourcePage,
    sourceHash: problemEvidence.sha256,
    contextFrom: row.first.row.contextFrom,
    contextTo: row.first.row.contextTo,
    baseProblemRepairArtifact,
    baseProblemRepairItemHash: row.first.row.problemArtifactItemHash,
    baseClassificationRepairArtifact,
    baseClassificationRepairItemHash: row.first.row.classificationArtifactItemHash,
    baseProblemRevisionArtifact,
    baseProblemRevisionItemHash: row.problemArtifactItemHash,
    baseClassificationRevisionArtifact,
    baseClassificationRevisionItemHash: row.classificationArtifactItemHash,
    baseQuestionHash: canonicalEvidenceHash(revisedQuestion.evidence),
    baseClassificationHash: canonicalEvidenceHash(revisedClassification),
  };
  let terminalTrigger: Record<string, unknown> | null = null;
  let terminalGeneration: {
    key: string;
    current: ClassifiedEvidence;
    checkpoint: ProblemTerminalFidelityCheckpoint;
  } | undefined;
  if (rawTerminalTrigger !== null) {
    if (contract.problemTerminalFidelityVersion !== PROBLEM_TERMINAL_FIDELITY_VERSION
      || rawTerminalTrigger.kind !== "terminal") {
      throw new Error(`${key}: terminal recovery requires the current terminal fidelity contract`);
    }
    const terminalCheckpoint = problemTerminalFidelityCheckpoint(
      rawTerminalTrigger.terminalCheckpoint,
      `${key}.revision.recovery.trigger.terminalCheckpoint`,
    );
    const match = new RegExp(
      `^problem-terminal-fidelity/v${PROBLEM_TERMINAL_FIDELITY_VERSION}-(\\d{4})-` +
        "([a-f0-9]{64})-([a-f0-9]{64})\\.json$",
      "u",
    ).exec(terminalCheckpoint.path);
    const slice = match && expectedProblemFidelitySlices(problemEvidence.pageCount)[Number(match[1])];
    if (!match || !slice || terminalCheckpoint.inputHash !== match[3]
      || terminalCheckpoint.from !== slice.from || terminalCheckpoint.to !== slice.to
      || terminalCheckpoint.ownedFrom !== slice.ownedFrom || terminalCheckpoint.ownedTo !== slice.ownedTo
      || revisedQuestion.page < slice.ownedFrom || revisedQuestion.page > slice.ownedTo) {
      throw new Error(`${key}: terminal recovery checkpoint path/slice is invalid`);
    }
    const checkpoint = readBoundEvidenceCached(
      cache,
      stateDir,
      terminalCheckpoint,
      `${key} terminal recovery checkpoint`,
    );
    if (checkpoint.version !== PROBLEM_TERMINAL_FIDELITY_VERSION || checkpoint.entryId !== entry.id
      || checkpoint.sourceHash !== problemEvidence.sha256 || checkpoint.from !== slice.from
      || checkpoint.to !== slice.to || checkpoint.ownedFrom !== slice.ownedFrom
      || checkpoint.ownedTo !== slice.ownedTo || checkpoint.effectiveCorpusHash !== match[2]
      || checkpoint.inputHash !== terminalCheckpoint.inputHash
      || checkpoint.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION
      || checkpoint.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST
      || checkpoint.rulesDigest !== rulesDigest
      || checkpoint.scopePromptDigest !== PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST
      || checkpoint.model !== "gpt-5.6-sol" || checkpoint.reasoningEffort !== "high"
      || !Array.isArray(checkpoint.inputs) || !Array.isArray(checkpoint.items)
      || canonicalEvidenceHash(checkpoint.inputs) !== terminalCheckpoint.inputHash) {
      throw new Error(`${key}: terminal recovery checkpoint metadata is stale`);
    }
    const inputs = checkpoint.inputs.map((value, index) =>
      object(value, `${key} terminal recovery inputs[${index}]`));
    const inputKeys = inputs.map((value, index) => exactString(
      value.key,
      `${key} terminal recovery inputs[${index}].key`,
    ));
    const terminalItems = checkpoint.items.map((value, index) =>
      parseProblemTerminalFidelityItem(
        value,
        `${key} terminal recovery items[${index}]`,
        contract,
      ));
    const itemKeys = terminalItems.map((item) => item.key);
    if (new Set(inputKeys).size !== inputKeys.length || new Set(itemKeys).size !== itemKeys.length
      || !isDeepStrictEqual(
        [...inputKeys].sort(compareCorpusQuestionKeys),
        [...itemKeys].sort(compareCorpusQuestionKeys),
      )) {
      throw new Error(`${key}: terminal recovery checkpoint input/item coverage is not exact`);
    }
    const expectedTerminalCheckpoint = {
      version: PROBLEM_TERMINAL_FIDELITY_VERSION,
      entryId: entry.id,
      sourceHash: problemEvidence.sha256,
      from: slice.from,
      to: slice.to,
      ownedFrom: slice.ownedFrom,
      ownedTo: slice.ownedTo,
      effectiveCorpusHash: match[2],
      inputHash: terminalCheckpoint.inputHash,
      transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
      rulesDigest,
      scopePromptDigest: PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      inputs,
      items: terminalItems,
    };
    if (!isDeepStrictEqual(checkpoint, expectedTerminalCheckpoint)) {
      throw new Error(`${key}: terminal recovery checkpoint envelope is not exact`);
    }
    const checkpointItem = terminalItems.find((item) => item.key === key);
    const terminalItem = parseProblemTerminalFidelityItem(
      rawTerminalTrigger.terminalItem,
      `${key}.revision.recovery.trigger.terminalItem`,
      contract,
    );
    const terminalItemHash = canonicalEvidenceHash(terminalItem);
    if (!checkpointItem || checkpointItem.status === "exact"
      || !isDeepStrictEqual(checkpointItem, terminalItem)
      || rawTerminalTrigger.terminalItemHash !== terminalItemHash
      || rawTerminalTrigger.evidenceHash !== sha256(terminalItem.evidence)
      || rawTerminalTrigger.preRecoveryEffectiveCorpusHash !== match[2]) {
      throw new Error(`${key}: terminal recovery diagnostic authority is stale`);
    }
    terminalTrigger = {
      kind: "terminal",
      evidenceHash: sha256(terminalItem.evidence),
      terminalCheckpoint,
      terminalItemHash,
      terminalItem,
      preRecoveryEffectiveCorpusHash: match[2],
    };
    if (!isDeepStrictEqual(rawTerminalTrigger, terminalTrigger)) {
      throw new Error(`${key}: terminal recovery trigger envelope is not exact`);
    }
    terminalGeneration = {
      key,
      current: {
        question: revisedQuestion,
        classification: revisedClassification,
        problemCheckpoint: row.first.row.base.problemCheckpoint,
        classificationCheckpoint: row.first.row.base.classificationCheckpoint,
        contextFrom: row.first.row.contextFrom,
        contextTo: row.first.row.contextTo,
      },
      checkpoint: terminalCheckpoint,
    };
  }
  const problemBasis = terminalTrigger === null
    ? {
        ...commonProblemBasis,
        failedClassificationEvidenceHash: sha256(revisedClassification.transcription_evidence),
      }
    : { ...commonProblemBasis, trigger: terminalTrigger };
  const problemRecoveryVersion = terminalTrigger === null
    ? PROBLEM_RECOVERY_VERSION
    : PROBLEM_TERMINAL_RECOVERY_VERSION;
  const classificationRecoveryVersion = terminalTrigger === null
    ? CLASSIFICATION_RECOVERY_VERSION
    : CLASSIFICATION_TERMINAL_RECOVERY_VERSION;
  const basisDigest = canonicalEvidenceHash(problemBasis);
  const problemArtifact = evidencePointer(recovery.problemArtifact, `${key}.recovery.problemArtifact`);
  const expectedProblemPath = `problem-recoveries/v${problemRecoveryVersion}-` +
    `${String(row.first.row.sourcePage).padStart(4, "0")}-` +
    `${row.first.row.printedNumber.padStart(4, "0")}-${basisDigest}.json`;
  if (problemArtifact.path !== expectedProblemPath) throw new Error(`${key}: problem recovery path is stale`);
  const problemCheckpoint = readBoundEvidenceCached(cache, stateDir, problemArtifact, expectedProblemPath);
  const recoveredQuestion = parseProblem(problemCheckpoint.item, `${key}.problem recovery.item`);
  const expectedProblemCheckpoint = {
    version: problemRecoveryVersion,
    entryId: entry.id,
    basisDigest,
    basis: problemBasis,
    promptVersion: TARGETED_PROBLEM_RECOVERY_VERSION,
    promptDigest: TARGETED_PROBLEM_RECOVERY_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    item: recoveredQuestion.evidence,
  };
  if (!isDeepStrictEqual(problemCheckpoint, expectedProblemCheckpoint)
    || recoveredQuestion.key !== key || recoveredQuestion.page !== row.first.row.sourcePage
    || recoveredQuestion.printedNumber !== row.first.row.printedNumber) {
    throw new Error(`${key}: problem recovery metadata/content is stale`);
  }
  const problemArtifactItemHash = canonicalEvidenceHash(recoveredQuestion.evidence);
  const classificationBasis = {
    ...problemBasis,
    problemArtifact,
    problemArtifactItemHash,
    effectiveQuestionHash: problemArtifactItemHash,
  };
  const classificationBasisDigest = canonicalEvidenceHash(classificationBasis);
  const classificationEnvelope = object(recovery.classificationArtifact, `${key}.recovery.classificationArtifact`);
  if (Object.keys(classificationEnvelope).sort().join(",") !==
    "path,recoveryPromptDigest,recoveryPromptVersion,rulesDigest,sha256,transcriptionGateVersion,transcriptionPromptDigest") {
    throw new Error(`${key}: recovery classification artifact has unexpected fields`);
  }
  const classificationArtifact = evidencePointer({
    path: classificationEnvelope.path,
    sha256: classificationEnvelope.sha256,
  }, `${key}.recovery.classificationArtifact`);
  const expectedClassificationPath = `classification-recoveries/v${classificationRecoveryVersion}-` +
    `${String(row.first.row.sourcePage).padStart(4, "0")}-` +
    `${row.first.row.printedNumber.padStart(4, "0")}-${classificationBasisDigest}-${rulesDigest}.json`;
  if (classificationArtifact.path !== expectedClassificationPath) {
    throw new Error(`${key}: classification recovery path is stale`);
  }
  const classificationCheckpoint = readBoundEvidenceCached(
    cache,
    stateDir,
    classificationArtifact,
    expectedClassificationPath,
  );
  if (!Array.isArray(classificationCheckpoint.items) || classificationCheckpoint.items.length !== 1) {
    throw new Error(`${key}: classification recovery must contain exactly one decision`);
  }
  const recoveredClassification = parseClassificationEvidence(
    classificationCheckpoint.items[0],
    recoveredQuestion,
    entry,
    `${key}.classification recovery.items[0]`,
  );
  const expectedClassificationCheckpoint = {
    version: classificationRecoveryVersion,
    entryId: entry.id,
    basisDigest: classificationBasisDigest,
    basis: classificationBasis,
    classifierVersion: CLASSIFIER_VERSION,
    rulesDigest,
    transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
    transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
    recoveryPromptVersion: TARGETED_PROBLEM_RECOVERY_VERSION,
    recoveryPromptDigest: TARGETED_PROBLEM_RECOVERY_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    items: [recoveredClassification],
  };
  if (!isDeepStrictEqual(classificationCheckpoint, expectedClassificationCheckpoint)) {
    throw new Error(`${key}: classification recovery metadata/content is stale`);
  }
  const classificationArtifactItemHash = canonicalEvidenceHash(recoveredClassification);
  const recoveryEvidence = {
    key,
    printedNumber: row.first.row.printedNumber,
    sourcePage: row.first.row.sourcePage,
    sourceHash: problemEvidence.sha256,
    contextFrom: row.first.row.contextFrom,
    contextTo: row.first.row.contextTo,
    baseProblemRepairArtifact,
    baseProblemRepairItemHash: row.first.row.problemArtifactItemHash,
    baseClassificationRepairArtifact,
    baseClassificationRepairItemHash: row.first.row.classificationArtifactItemHash,
    baseProblemRevisionArtifact,
    baseProblemRevisionItemHash: row.problemArtifactItemHash,
    baseClassificationRevisionArtifact,
    baseClassificationRevisionItemHash: row.classificationArtifactItemHash,
    problemArtifact,
    problemArtifactItemHash,
    classificationArtifact: {
      ...classificationArtifact,
      rulesDigest,
      transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
      recoveryPromptVersion: TARGETED_PROBLEM_RECOVERY_VERSION,
      recoveryPromptDigest: TARGETED_PROBLEM_RECOVERY_PROMPT_DIGEST,
    },
    classificationArtifactItemHash,
    ...(terminalTrigger === null
      ? { failedClassificationEvidenceHash: sha256(revisedClassification.transcription_evidence) }
      : { trigger: terminalTrigger }),
    baseQuestionHash: problemBasis.baseQuestionHash,
    effectiveQuestionHash: problemArtifactItemHash,
    baseClassificationHash: problemBasis.baseClassificationHash,
    effectiveClassificationHash: classificationArtifactItemHash,
  };
  if (recoveredClassification.transcription_status === "exact") {
    if (recovery.manualAdjudication !== undefined) {
      throw new Error(`${key}: exact classification recovery must not declare manual adjudication`);
    }
    if (recovery.adjudication !== undefined) {
      throw new Error(`${key}: exact classification recovery must not declare crop adjudication`);
    }
    if (recovery.scopeAdjudication !== undefined) {
      const scope = verifyProblemScopeAdjudication(
        recovery.scopeAdjudication,
        recoveryEvidence,
        recoveredQuestion,
        recoveredClassification,
        row,
        stateDir,
        entry,
        problemEvidence,
        solutionEvidence,
        rulesDigest,
        cache,
        contract,
      );
      const evidence = { ...recoveryEvidence, scopeAdjudication: scope.evidence };
      if (!isDeepStrictEqual(recovery, evidence)) {
        throw new Error(`${key}: scope adjudication recovery envelope does not match its exact chain`);
      }
      return {
        classified: {
          question: recoveredQuestion,
          classification: scope.classification,
          problemCheckpoint: row.first.row.base.problemCheckpoint,
          classificationCheckpoint: row.first.row.base.classificationCheckpoint,
          contextFrom: row.first.row.contextFrom,
          contextTo: row.first.row.contextTo,
        },
        evidence,
        terminalGeneration,
        scopeGeneration: scope.generation,
      };
    }
    if (!isDeepStrictEqual(recovery, recoveryEvidence)) {
      throw new Error(`${key}: exact classification recovery envelope is not exact`);
    }
    return {
      classified: {
        question: recoveredQuestion,
        classification: recoveredClassification,
        problemCheckpoint: row.first.row.base.problemCheckpoint,
        classificationCheckpoint: row.first.row.base.classificationCheckpoint,
        contextFrom: row.first.row.contextFrom,
        contextTo: row.first.row.contextTo,
      },
      evidence: recoveryEvidence,
      terminalGeneration,
    };
  }
  let failedQuestion = recoveredQuestion;
  let failedClassification = recoveredClassification;
  let parentRecoveryEvidence: Record<string, unknown> = recoveryEvidence;
  if (recovery.adjudication !== undefined) {
    const adjudicated = verifyProblemCropAdjudication(
      recovery.adjudication,
      recoveryEvidence,
      recoveredQuestion,
      recoveredClassification,
      stateDir,
      entry,
      problemEvidence,
      rulesDigest,
      cache,
      contract,
      recovery.manualAdjudication !== undefined,
    );
    failedQuestion = adjudicated.question;
    failedClassification = adjudicated.classification;
    parentRecoveryEvidence = { ...recoveryEvidence, adjudication: adjudicated.evidence };
  }
  if (failedClassification.transcription_status === "exact") {
    if (recovery.manualAdjudication !== undefined) {
      throw new Error(`${key}: exact crop adjudication must not declare manual adjudication`);
    }
    if (!isDeepStrictEqual(recovery, parentRecoveryEvidence)) {
      throw new Error(`${key}: problem recovery evidence envelope does not match its exact chain`);
    }
    return {
      classified: {
        question: failedQuestion,
        classification: failedClassification,
        problemCheckpoint: row.first.row.base.problemCheckpoint,
        classificationCheckpoint: row.first.row.base.classificationCheckpoint,
        contextFrom: row.first.row.contextFrom,
        contextTo: row.first.row.contextTo,
      },
      evidence: parentRecoveryEvidence,
      terminalGeneration,
    };
  }
  if (recovery.manualAdjudication === undefined) {
    throw new Error(`${key}: non-exact exhausted recovery lacks allowlisted manual adjudication`);
  }
  const manual = verifyProblemManualAdjudication(
    recovery.manualAdjudication,
    parentRecoveryEvidence,
    failedQuestion,
    failedClassification,
    stateDir,
    entry,
    problemEvidence,
    rulesDigest,
    cache,
    contract,
  );
  const evidence = { ...parentRecoveryEvidence, manualAdjudication: manual.evidence };
  if (!isDeepStrictEqual(recovery, evidence)) {
    throw new Error(`${key}: problem recovery evidence envelope does not match its exact chain`);
  }
  return {
    classified: {
      question: manual.question,
      classification: manual.classification,
      problemCheckpoint: row.first.row.base.problemCheckpoint,
      classificationCheckpoint: row.first.row.base.classificationCheckpoint,
      contextFrom: row.first.row.contextFrom,
      contextTo: row.first.row.contextTo,
    },
    evidence,
    terminalGeneration,
  };
}

type V3RevisionVerification = {
  classified: ClassifiedEvidence;
  evidence: Record<string, unknown>;
  preRecoveryClassified?: ClassifiedEvidence;
  preScopeClassified?: ClassifiedEvidence;
  terminalRecoveryGeneration?: {
    key: string;
    current: ClassifiedEvidence;
    checkpoint: ProblemTerminalFidelityCheckpoint;
  };
  scopeAdjudicationGeneration?: {
    key: string;
    current: ClassifiedEvidence;
    checkpoint: ProblemTerminalFidelityCheckpoint;
  };
};

function verifyV3RevisionArtifacts(
  rows: V3RevisionRow[],
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  solutionEvidence: DownloadEvidence,
  rulesDigest: string,
  cache: EvidenceCache,
  contract: VerificationContract,
): Map<string, V3RevisionVerification> {
  const revisedQuestions = new Map<string, ProblemQuestion>();
  for (const [path, group] of groupByArtifact(rows, (row) => row.problemArtifact)) {
    const ordered = [...group].sort((left, right) =>
      compareCorpusQuestionKeys(left.first.row.key, right.first.row.key));
    if (ordered.length > 6) throw new Error(`${path}: shared problem revision exceeds six members`);
    const contextFrom = ordered[0].first.row.contextFrom;
    const contextTo = ordered[0].first.row.contextTo;
    const sourcePage = ordered[0].first.row.sourcePage;
    if (ordered.some((row) => row.first.row.contextFrom !== contextFrom
      || row.first.row.contextTo !== contextTo || row.first.row.sourcePage !== sourcePage)) {
      throw new Error(`${path}: shared problem revision members do not share context/page`);
    }
    const members = ordered.map((row) => ({
      key: row.first.row.key,
      printedNumber: row.first.row.printedNumber,
      sourcePage: row.first.row.sourcePage,
      baseProblemRepairArtifact: row.first.row.problemArtifact,
      baseProblemRepairItemHash: row.first.row.problemArtifactItemHash,
      baseClassificationRepairArtifact: row.first.row.classificationArtifact,
      baseClassificationRepairItemHash: row.first.row.classificationArtifactItemHash,
      baseQuestionHash: canonicalEvidenceHash(row.current.question.evidence),
      baseClassificationHash: canonicalEvidenceHash(row.current.classification),
      trigger: row.trigger,
    }));
    const membersDigest = canonicalEvidenceHash(members);
    const expectedPath = `problem-revision-batches/v${PROBLEM_REVISION_BATCH_VERSION}-` +
      `${String(contextFrom).padStart(4, "0")}-${String(contextTo).padStart(4, "0")}-` +
      `${String(sourcePage).padStart(4, "0")}-${membersDigest}.json`;
    if (path !== expectedPath) throw new Error(`${path}: shared problem revision path/member set is invalid`);
    const checkpoint = readBoundEvidenceCached(cache, stateDir, ordered[0].problemArtifact, path);
    if (!Array.isArray(checkpoint.items)) throw new Error(`${path}: shared problem revision items are missing`);
    const items = checkpoint.items.map((value, index) => parseProblem(value, `${path}.items[${index}]`));
    const byKey = new Map<string, ProblemQuestion>();
    for (const item of items) {
      if (byKey.has(item.key)) throw new Error(`${path}: duplicate shared problem revision output ${item.key}`);
      byKey.set(item.key, item);
    }
    if (byKey.size !== ordered.length || ordered.some((row) => !byKey.has(row.first.row.key))) {
      throw new Error(`${path}: shared problem revision member/output/reference coverage is not exact`);
    }
    const expectedCheckpoint = {
      version: PROBLEM_REVISION_BATCH_VERSION,
      entryId: entry.id,
      sourceHash: problemEvidence.sha256,
      contextFrom,
      contextTo,
      sourcePage,
      membersDigest,
      members,
      batchPromptVersion: TARGETED_PROBLEM_BATCH_VERSION,
      batchPromptDigest: TARGETED_PROBLEM_BATCH_PROMPT_DIGEST,
      revisionPromptVersion: TARGETED_PROBLEM_REVISION_VERSION,
      revisionPromptDigest: TARGETED_PROBLEM_BATCH_REVISION_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      items: items.map((item) => item.evidence),
    };
    if (!isDeepStrictEqual(checkpoint, expectedCheckpoint)) {
      throw new Error(`${path}: shared problem revision metadata/content is stale`);
    }
    for (const row of ordered) {
      const item = byKey.get(row.first.row.key)!;
      if (item.page !== row.first.row.sourcePage || item.printedNumber !== row.first.row.printedNumber
        || canonicalEvidenceHash(item.evidence) !== row.problemArtifactItemHash) {
        throw new Error(`${row.first.row.key}: problem revision per-item hash or identity is invalid`);
      }
      revisedQuestions.set(row.first.row.key, item);
    }
  }

  const result = new Map<string, V3RevisionVerification>();
  for (const [path, group] of groupByArtifact(rows, (row) => row.classificationArtifact)) {
    const ordered = [...group].sort((left, right) =>
      compareCorpusQuestionKeys(left.first.row.key, right.first.row.key));
    const contextFrom = ordered[0].first.row.contextFrom;
    const contextTo = ordered[0].first.row.contextTo;
    if (ordered.some((row) => row.first.row.contextFrom !== contextFrom
      || row.first.row.contextTo !== contextTo)) {
      throw new Error(`${path}: shared classification revision members do not share context`);
    }
    for (const row of ordered) {
      if (row.classificationArtifactEnvelope.rulesDigest !== rulesDigest
        || row.classificationArtifactEnvelope.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION
        || row.classificationArtifactEnvelope.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST) {
        throw new Error(`${row.first.row.key}: classification revision envelope is stale`);
      }
    }
    const members = ordered.map((row) => ({
      key: row.first.row.key,
      problemAuthority: {
        key: row.first.row.key,
        path: row.problemArtifact.path,
        sha256: row.problemArtifact.sha256,
        itemHash: row.problemArtifactItemHash,
      },
      effectiveQuestionHash: canonicalEvidenceHash(revisedQuestions.get(row.first.row.key)!.evidence),
      baseClassificationRepairArtifact: row.first.row.classificationArtifact,
      baseClassificationRepairItemHash: row.first.row.classificationArtifactItemHash,
      triggerHash: canonicalEvidenceHash(row.trigger),
    }));
    const overlayDigest = canonicalEvidenceHash(members);
    const expectedPath = `classification-revision-batches/v${CLASSIFICATION_REVISION_BATCH_VERSION}-` +
      `${String(contextFrom).padStart(4, "0")}-${String(contextTo).padStart(4, "0")}-` +
      `${overlayDigest}-${rulesDigest}.json`;
    if (path !== expectedPath) throw new Error(`${path}: shared classification revision path/member set is invalid`);
    const checkpoint = readBoundEvidenceCached(cache, stateDir, ordered[0].classificationArtifact, path);
    if (!Array.isArray(checkpoint.items)) throw new Error(`${path}: shared classification revision items are missing`);
    const byKey = new Map<string, ClassificationEvidence>();
    const items = checkpoint.items.map((value, index) => {
      const key = exactString(object(value, `${path}.items[${index}]`).key, `${path}.items[${index}].key`);
      const row = ordered.find((candidate) => candidate.first.row.key === key);
      if (!row || byKey.has(key)) throw new Error(`${path}: missing, extra, or duplicate revision key ${key}`);
      const parsed = parseClassificationEvidence(
        value,
        revisedQuestions.get(key)!,
        entry,
        `${path}.items[${index}]`,
      );
      byKey.set(key, parsed);
      return parsed;
    });
    if (byKey.size !== ordered.length) throw new Error(`${path}: classification revision coverage is incomplete`);
    const expectedCheckpoint = {
      version: CLASSIFICATION_REVISION_BATCH_VERSION,
      entryId: entry.id,
      sourceHash: problemEvidence.sha256,
      contextFrom,
      contextTo,
      overlayDigest,
      classifierVersion: CLASSIFIER_VERSION,
      rulesDigest,
      transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      members,
      items,
    };
    if (!isDeepStrictEqual(checkpoint, expectedCheckpoint)) {
      throw new Error(`${path}: shared classification revision metadata/content is stale`);
    }
    for (const row of ordered) {
      const key = row.first.row.key;
      const question = revisedQuestions.get(key)!;
      const classification = byKey.get(key)!;
      const effectiveQuestionHash = canonicalEvidenceHash(question.evidence);
      const effectiveClassificationHash = canonicalEvidenceHash(classification);
      if (row.raw.effectiveQuestionHash !== effectiveQuestionHash
        || row.problemArtifactItemHash !== effectiveQuestionHash
        || row.raw.effectiveClassificationHash !== effectiveClassificationHash
        || row.classificationArtifactItemHash !== effectiveClassificationHash) {
        throw new Error(`${key}: revision effective/per-item hashes do not match shared outputs`);
      }
      const evidence = {
        baseProblemRepairArtifact: row.first.row.problemArtifact,
        baseClassificationRepairArtifact: row.first.row.classificationArtifact,
        problemArtifact: row.problemArtifact,
        classificationArtifact: {
          ...row.classificationArtifact,
          rulesDigest,
          transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
          transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
        },
        diagnosticEvidenceHash: row.trigger.evidenceHash,
        baseQuestionHash: canonicalEvidenceHash(row.current.question.evidence),
        effectiveQuestionHash,
        baseClassificationHash: canonicalEvidenceHash(row.current.classification),
        effectiveClassificationHash,
        problemArtifactItemHash: row.problemArtifactItemHash,
        classificationArtifactItemHash: row.classificationArtifactItemHash,
        trigger: row.trigger,
      };
      const recovery = row.raw.recovery === undefined ? null : verifyProblemRecovery(
        row,
        question,
        classification,
        stateDir,
        entry,
        problemEvidence,
        solutionEvidence,
        rulesDigest,
        cache,
        contract,
      );
      if (classification.transcription_status === "exact" && recovery !== null
        && recovery.terminalGeneration === undefined) {
        throw new Error(`${key}: exact problem revision can only have a terminal recovery`);
      }
      if (classification.transcription_status !== "exact" && recovery === null) {
        throw new Error(`${key}: non-exact problem revision has no recovery`);
      }
      const expectedEvidence = recovery === null ? evidence : { ...evidence, recovery: recovery.evidence };
      if (!isDeepStrictEqual(row.raw, expectedEvidence)) {
        throw new Error(`${key}: revision evidence envelope does not match its exact shared chain`);
      }
      result.set(key, {
        classified: recovery?.classified ?? {
          question,
          classification,
          problemCheckpoint: row.first.row.base.problemCheckpoint,
          classificationCheckpoint: row.first.row.base.classificationCheckpoint,
          contextFrom: row.first.row.contextFrom,
          contextTo: row.first.row.contextTo,
        },
        evidence: expectedEvidence,
        ...(recovery?.terminalGeneration ? {
          preRecoveryClassified: {
            question,
            classification,
            problemCheckpoint: row.first.row.base.problemCheckpoint,
            classificationCheckpoint: row.first.row.base.classificationCheckpoint,
            contextFrom: row.first.row.contextFrom,
            contextTo: row.first.row.contextTo,
          },
          terminalRecoveryGeneration: recovery.terminalGeneration,
        } : {}),
        ...(recovery?.scopeGeneration ? {
          preScopeClassified: recovery.scopeGeneration.current,
          scopeAdjudicationGeneration: recovery.scopeGeneration,
        } : {}),
      });
    }
  }
  return result;
}

export function assertTerminalGenerationSearchBound(optionCounts: number[]): number {
  const combinations = optionCounts.reduce((count, value) => count * value, 1);
  if (!Number.isSafeInteger(combinations) || combinations > 65_536) {
    throw new Error("terminal trigger generation is too ambiguous to verify safely");
  }
  return combinations;
}

type TerminalGenerationCandidate = { record: ClassifiedEvidence; repaired: boolean };

function terminalGenerationCandidateAllowed(
  candidate: TerminalGenerationCandidate,
  item: ProblemTerminalFidelityItem | undefined,
  terminalVersion: number,
): boolean {
  const classification = candidate.record.classification;
  if (classification.transcription_status === "exact") return true;
  return terminalVersion === PROBLEM_TERMINAL_FIDELITY_VERSION
    && !candidate.repaired
    && classification.decision === "reject"
    && classification.transcription_status === "mismatch"
    && item?.status === "mismatch"
    && item.scopeDecision === "reject"
    && item.scopeConfidence >= 0.9;
}

function verifyV3TerminalTriggerGenerations(
  rows: V3RevisionRow[],
  base: DecisionSummary,
  first: Map<string, V3FirstRepair>,
  classificationRevisions: Map<string, V3RevisionVerification>,
  terminalRevisions: Map<string, V3RevisionVerification>,
  stateDir: string,
  cache: EvidenceCache,
  contract: VerificationContract,
): void {
  const groups = groupByArtifact(rows, (row) => problemTerminalFidelityCheckpoint(
    row.trigger.terminalCheckpoint,
    `${row.first.row.key}.revision.trigger.terminalCheckpoint`,
  ));
  for (const [path, triggerRows] of groups) {
    const pointer = problemTerminalFidelityCheckpoint(
      triggerRows[0].trigger.terminalCheckpoint,
      `${triggerRows[0].first.row.key}.revision.trigger.terminalCheckpoint`,
    );
    const checkpoint = readBoundEvidenceCached(cache, stateDir, pointer, path);
    if (!Array.isArray(checkpoint.inputs)) throw new Error(`${path}: terminal trigger inputs are missing`);
    const inputs = checkpoint.inputs.map((value) => object(value, `${path}.input`));
    const inputByKey = new Map(inputs.map((input) => [exactString(input.key, `${path}.input.key`), input]));
    if (!Array.isArray(checkpoint.items)) throw new Error(`${path}: terminal trigger items are missing`);
    const terminalItems = checkpoint.items.map((value, index) =>
      parseProblemTerminalFidelityItem(value, `${path}.items[${index}]`, contract));
    const terminalItemByKey = new Map(terminalItems.map((item) => [item.key, item]));
    const expectedSliceKeys = base.order.filter((key) => {
      const page = base.records.get(key)!.question.page;
      return page >= pointer.ownedFrom && page <= pointer.ownedTo;
    });
    if (inputByKey.size !== expectedSliceKeys.length
      || expectedSliceKeys.some((key) => !inputByKey.has(key))) {
      throw new Error(`${path}: terminal trigger input coverage does not match the immutable key set`);
    }
    const sameGenerationKeys = new Set(triggerRows.map((row) => row.first.row.key));
    const sameGenerationCurrent = new Map(triggerRows.map((row) => [row.first.row.key, row.current]));
    const options = base.order.map((key) => {
      const forced = sameGenerationKeys.has(key) ? sameGenerationCurrent.get(key) : undefined;
      const candidates: TerminalGenerationCandidate[] = forced ? [{ record: forced, repaired: true }] : [
        { record: base.records.get(key)!, repaired: false },
        ...[
          first.get(key)?.preScopeClassified,
          first.get(key)?.classified,
          classificationRevisions.get(key)?.preRecoveryClassified,
          classificationRevisions.get(key)?.preScopeClassified,
          classificationRevisions.get(key)?.classified,
          terminalRevisions.get(key)?.preRecoveryClassified,
          terminalRevisions.get(key)?.preScopeClassified,
          terminalRevisions.get(key)?.classified,
        ].filter((value): value is ClassifiedEvidence => value !== undefined)
          .map((record) => ({ record, repaired: true })),
      ];
      const allowed = candidates.filter((candidate) => terminalGenerationCandidateAllowed(
        candidate,
        terminalItemByKey.get(key),
        Number(checkpoint.version),
      ));
      const unique = new Map(allowed.map((candidate) => [canonicalEvidenceHash({
        question: candidate.record.question.evidence,
        classification: candidate.record.classification,
      }), candidate.record]));
      const input = inputByKey.get(key);
      const matching = [...unique.values()].filter((value) =>
        input === undefined || isDeepStrictEqual(problemTerminalInput(value), input));
      if (matching.length === 0) throw new Error(`${path}: no attested problem generation matches ${key}`);
      return matching;
    });
    assertTerminalGenerationSearchBound(options.map((values) => values.length));
    const targetHash = exactString(checkpoint.effectiveCorpusHash, `${path}.effectiveCorpusHash`);
    let matches = 0;
    const chosen: ClassifiedEvidence[] = [];
    const visit = (index: number): void => {
      if (matches > 1) return;
      if (index < options.length) {
        for (const candidate of options[index]) {
          chosen.push(candidate);
          visit(index + 1);
          chosen.pop();
        }
        return;
      }
      const corpus = chosen.map((record) => ({
        question: record.question.evidence,
        classification: record.classification,
      }));
      if (canonicalEvidenceHash(corpus) !== targetHash) return;
      const expectedInputs = chosen.filter((record) =>
        record.question.page >= pointer.ownedFrom && record.question.page <= pointer.ownedTo)
        .map(problemTerminalInput);
      if (isDeepStrictEqual(expectedInputs, inputs)) matches += 1;
    };
    visit(0);
    if (matches !== 1) {
      throw new Error(`${path}: terminal trigger does not bind one exact prior corpus generation`);
    }
  }
}

function verifyV3TerminalRecoveryGenerations(
  base: DecisionSummary,
  first: Map<string, V3FirstRepair>,
  classificationRevisions: Map<string, V3RevisionVerification>,
  terminalRevisions: Map<string, V3RevisionVerification>,
  stateDir: string,
  cache: EvidenceCache,
  contract: VerificationContract,
): void {
  const generations = [
    ...[...first.values()].flatMap((value) =>
      value.scopeAdjudicationGeneration ? [value.scopeAdjudicationGeneration] : []),
    ...[...classificationRevisions.values(), ...terminalRevisions.values()]
    .flatMap((value) => [
      ...(value.terminalRecoveryGeneration ? [value.terminalRecoveryGeneration] : []),
      ...(value.scopeAdjudicationGeneration ? [value.scopeAdjudicationGeneration] : []),
    ]),
  ];
  const groups = groupByArtifact(generations, (generation) => generation.checkpoint);
  for (const [path, triggerGenerations] of groups) {
    const pointer = triggerGenerations[0].checkpoint;
    const checkpoint = readBoundEvidenceCached(cache, stateDir, pointer, path);
    if (!Array.isArray(checkpoint.inputs)) throw new Error(`${path}: terminal recovery inputs are missing`);
    const inputs = checkpoint.inputs.map((value) => object(value, `${path}.input`));
    const inputByKey = new Map(inputs.map((input) => [exactString(input.key, `${path}.input.key`), input]));
    if (!Array.isArray(checkpoint.items)) throw new Error(`${path}: terminal recovery items are missing`);
    const terminalItems = checkpoint.items.map((value, index) =>
      parseProblemTerminalFidelityItem(value, `${path}.items[${index}]`, contract));
    const terminalItemByKey = new Map(terminalItems.map((item) => [item.key, item]));
    const expectedSliceKeys = base.order.filter((key) => {
      const page = base.records.get(key)!.question.page;
      return page >= pointer.ownedFrom && page <= pointer.ownedTo;
    });
    if (inputByKey.size !== expectedSliceKeys.length
      || expectedSliceKeys.some((key) => !inputByKey.has(key))) {
      throw new Error(`${path}: terminal recovery input coverage does not match the immutable key set`);
    }
    const sameGeneration = new Map(triggerGenerations.map((generation) => [generation.key, generation.current]));
    if (sameGeneration.size !== triggerGenerations.length) {
      throw new Error(`${path}: duplicate terminal recovery generation authority`);
    }
    const options = base.order.map((key) => {
      const forced = sameGeneration.get(key);
      const candidates: TerminalGenerationCandidate[] = forced ? [{ record: forced, repaired: true }] : [
        { record: base.records.get(key)!, repaired: false },
        ...[
          first.get(key)?.preScopeClassified,
          first.get(key)?.classified,
          classificationRevisions.get(key)?.preRecoveryClassified,
          classificationRevisions.get(key)?.preScopeClassified,
          classificationRevisions.get(key)?.classified,
          terminalRevisions.get(key)?.preRecoveryClassified,
          terminalRevisions.get(key)?.preScopeClassified,
          terminalRevisions.get(key)?.classified,
        ].filter((value): value is ClassifiedEvidence => value !== undefined)
          .map((record) => ({ record, repaired: true })),
      ];
      const allowed = candidates.filter((candidate) => terminalGenerationCandidateAllowed(
        candidate,
        terminalItemByKey.get(key),
        Number(checkpoint.version),
      ));
      const unique = new Map(allowed.map((candidate) => [canonicalEvidenceHash({
        question: candidate.record.question.evidence,
        classification: candidate.record.classification,
      }), candidate.record]));
      const input = inputByKey.get(key);
      const matching = [...unique.values()].filter((value) =>
        input === undefined || isDeepStrictEqual(problemTerminalInput(value), input));
      if (matching.length === 0) throw new Error(`${path}: no attested recovery generation matches ${key}`);
      return matching;
    });
    assertTerminalGenerationSearchBound(options.map((values) => values.length));
    const targetHash = exactString(checkpoint.effectiveCorpusHash, `${path}.effectiveCorpusHash`);
    let matches = 0;
    const chosen: ClassifiedEvidence[] = [];
    const visit = (index: number): void => {
      if (matches > 1) return;
      if (index < options.length) {
        for (const candidate of options[index]) {
          chosen.push(candidate);
          visit(index + 1);
          chosen.pop();
        }
        return;
      }
      const corpus = chosen.map((record) => ({
        question: record.question.evidence,
        classification: record.classification,
      }));
      if (canonicalEvidenceHash(corpus) !== targetHash) return;
      const expectedInputs = chosen.filter((record) =>
        record.question.page >= pointer.ownedFrom && record.question.page <= pointer.ownedTo)
        .map(problemTerminalInput);
      if (isDeepStrictEqual(expectedInputs, inputs)) matches += 1;
    };
    visit(0);
    if (matches !== 1) {
      throw new Error(`${path}: terminal recovery does not bind one exact prior corpus generation`);
    }
  }
}

function applyDeclaredRepairsV3(
  values: unknown[],
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  solutionEvidence: DownloadEvidence,
  rulesDigest: string,
  base: DecisionSummary,
  solutions: Map<string, OfficialSolution>,
  cache: EvidenceCache,
  contract: VerificationContract,
): Map<string, ClassifiedEvidence> {
  verifyProblemRecoveryCoverage(values, stateDir, contract);
  const rows = prepareV3RepairRows(values, stateDir, base, solutions);
  const corrected = verifyV3FirstProblemArtifacts(rows, stateDir, entry, problemEvidence, cache);
  const first = verifyV3FirstClassificationArtifacts(
    rows,
    corrected,
    stateDir,
    entry,
    problemEvidence,
    rulesDigest,
    cache,
  );
  for (const value of first.values()) {
    if (value.row.raw.scopeAdjudication === undefined) continue;
    const scope = verifyProblemRepairScopeAdjudication(
      value.row.raw.scopeAdjudication,
      value,
      stateDir,
      entry,
      problemEvidence,
      solutionEvidence,
      rulesDigest,
      cache,
      contract,
    );
    value.preScopeClassified = value.classified;
    value.classified = scope.classified;
    value.scopeAdjudicationGeneration = scope.generation;
    value.evidence = { ...value.evidence, scopeAdjudication: scope.evidence };
  }
  const records = new Map(base.records);
  for (const [key, value] of first) records.set(key, value.classified);

  const classificationRevisions = [...first.values()].filter((value) => {
    if (value.row.raw.revision === undefined) return false;
    return object(object(value.row.raw.revision, `${value.row.key}.revision`).trigger,
      `${value.row.key}.revision.trigger`).kind === "classification";
  });
  const nonExactWithoutRevision = [...first.values()].filter((value) =>
    value.classified.classification.transcription_status !== "exact"
    && !classificationRevisions.some((candidate) => candidate.row.key === value.row.key));
  if (nonExactWithoutRevision.length > 0) {
    throw new Error(`${nonExactWithoutRevision[0].row.key}: non-exact first repair has no attested revision`);
  }
  let classificationRevisionResults = new Map<string, V3RevisionVerification>();
  if (classificationRevisions.length > 0) {
    const prepared = prepareV3RevisionRows(
      classificationRevisions,
      "classification",
      records,
      stateDir,
      entry,
      problemEvidence,
      rulesDigest,
      cache,
      contract,
    );
    classificationRevisionResults = verifyV3RevisionArtifacts(
      prepared,
      stateDir,
      entry,
      problemEvidence,
      solutionEvidence,
      rulesDigest,
      cache,
      contract,
    );
    for (const [key, value] of classificationRevisionResults) records.set(key, value.classified);
  }

  const terminalRevisions = [...first.values()].filter((value) => {
    if (value.row.raw.revision === undefined) return false;
    return object(object(value.row.raw.revision, `${value.row.key}.revision`).trigger,
      `${value.row.key}.revision.trigger`).kind === "terminal";
  });
  let terminalRevisionResults = new Map<string, V3RevisionVerification>();
  if (terminalRevisions.length > 0) {
    const prepared = prepareV3RevisionRows(
      terminalRevisions,
      "terminal",
      records,
      stateDir,
      entry,
      problemEvidence,
      rulesDigest,
      cache,
      contract,
    );
    terminalRevisionResults = verifyV3RevisionArtifacts(
      prepared,
      stateDir,
      entry,
      problemEvidence,
      solutionEvidence,
      rulesDigest,
      cache,
      contract,
    );
    verifyV3TerminalTriggerGenerations(
      prepared,
      base,
      first,
      classificationRevisionResults,
      terminalRevisionResults,
      stateDir,
      cache,
      contract,
    );
    for (const [key, value] of terminalRevisionResults) records.set(key, value.classified);
  }

  verifyV3TerminalRecoveryGenerations(
    base,
    first,
    classificationRevisionResults,
    terminalRevisionResults,
    stateDir,
    cache,
    contract,
  );

  for (const value of first.values()) {
    const rawRevision = value.row.raw.revision;
    let expected = value.evidence;
    if (rawRevision !== undefined) {
      const triggerKind = object(object(rawRevision, `${value.row.key}.revision`).trigger,
        `${value.row.key}.revision.trigger`).kind;
      const revisionEvidence = triggerKind === "classification"
        ? classificationRevisionResults.get(value.row.key)?.evidence
        : terminalRevisionResults.get(value.row.key)?.evidence;
      if (!revisionEvidence) throw new Error(`${value.row.key}: revision authority is missing`);
      expected = { ...value.evidence, revision: revisionEvidence };
    }
    if (!isDeepStrictEqual(value.row.raw, expected)) {
      throw new Error(`${value.row.key}: repair evidence envelope does not match its exact shared chain`);
    }
  }
  return records;
}

type SolutionFidelityInput = {
  key: string;
  printedNumber: string;
  qtype: ProblemQuestion["qtype"];
  allowDerivedMarkerAnswer: boolean;
  sourcePage: number;
  rawAnswer: string;
  explanation: string;
  complete: true;
  baseSolutionCheckpoint: EvidencePointer;
  baseSolutionItemHash: string;
  baseContextFrom: number;
  baseContextTo: number;
  baseOwnedFrom: number;
  baseOwnedTo: number;
};

type SolutionFidelityDecision = {
  key: string;
  sourcePage: number;
  answerStatus: "exact" | "mismatch" | "not_visible" | "unverifiable";
  explanationStatus: "exact" | "mismatch" | "unverifiable";
  evidence: string;
};

type SolutionFidelityCheckpointEvidence = EvidencePointer & {
  from: number;
  to: number;
  ownedFrom: number;
  ownedTo: number;
  inputHash: string;
};

type VerifiedSolutionFidelity = {
  solutions: Map<string, OfficialSolution>;
  checkpoints: SolutionFidelityCheckpointEvidence[];
  items: Record<string, unknown>[];
  repairs: Record<string, unknown>[];
  acceptedSolutionKeys: string[];
  solutionRepairKeys: string[];
  derivedAnswerKeys: string[];
  effectiveSolutionCorpusHash: string;
};

function solutionFidelityCheckpointEvidence(value: unknown, label: string): SolutionFidelityCheckpointEvidence {
  const row = object(value, label);
  if (Object.keys(row).sort().join(",") !== "from,inputHash,ownedFrom,ownedTo,path,sha256,to") {
    throw new Error(`${label} has unexpected fields`);
  }
  const pointer = evidencePointer({ path: row.path, sha256: row.sha256 }, label);
  const inputHash = exactString(row.inputHash, `${label}.inputHash`);
  if (!/^[a-f0-9]{64}$/u.test(inputHash)) throw new Error(`${label}.inputHash is invalid`);
  return {
    ...pointer,
    from: integer(row.from, `${label}.from`, 1),
    to: integer(row.to, `${label}.to`, 1),
    ownedFrom: integer(row.ownedFrom, `${label}.ownedFrom`, 1),
    ownedTo: integer(row.ownedTo, `${label}.ownedTo`, 1),
    inputHash,
  };
}

function solutionFidelityDecision(
  value: unknown,
  input: SolutionFidelityInput,
  label: string,
): SolutionFidelityDecision {
  const row = object(value, label);
  const key = exactString(row.key, `${label}.key`);
  if (key !== input.key) throw new Error(`${label}.key does not match its accepted solution`);
  const answerStatus = row.answerStatus;
  if (answerStatus !== "exact" && answerStatus !== "mismatch"
    && answerStatus !== "not_visible" && answerStatus !== "unverifiable") {
    throw new Error(`${key}: invalid solution answerStatus`);
  }
  const explanationStatus = row.explanationStatus;
  if (explanationStatus !== "exact" && explanationStatus !== "mismatch"
    && explanationStatus !== "unverifiable") {
    throw new Error(`${key}: invalid solution explanationStatus`);
  }
  return {
    key,
    sourcePage: integer(row.sourcePage, `${label}.sourcePage`, 1),
    answerStatus,
    explanationStatus,
    evidence: exactString(row.evidence, `${label}.evidence`),
  };
}

function expectedSolutionFidelitySlices(pageCount: number): Array<{
  index: number;
  from: number;
  to: number;
  ownedFrom: number;
  ownedTo: number;
}> {
  const slices: Array<{ index: number; from: number; to: number; ownedFrom: number; ownedTo: number }> = [];
  for (let index = 0, from = 1; from <= pageCount; index += 1, from += SOLUTION_FIDELITY_SLICE_STRIDE) {
    const to = Math.min(from + SOLUTION_FIDELITY_SLICE_PAGES - 1, pageCount);
    const nextFrom = to === pageCount ? null : from + SOLUTION_FIDELITY_SLICE_STRIDE;
    slices.push({ index, from, to, ownedFrom: from, ownedTo: nextFrom === null ? to : nextFrom - 1 });
    if (to === pageCount) break;
  }
  return slices;
}

function fidelityInput(
  record: ClassifiedEvidence,
  solution: OfficialSolution,
): SolutionFidelityInput {
  let allowDerivedMarkerAnswer = false;
  if (record.question.qtype === "mcq") {
    try {
      allowDerivedMarkerAnswer = resolveOfficialAnswerForDb(record.question, solution.rawAnswer).mode === "choice-marker";
    } catch {
      // A problem repair may be required for an unresolved value; it must not authorize a derived marker answer.
    }
  }
  return {
    key: record.question.key,
    printedNumber: record.question.printedNumber,
    qtype: record.question.qtype,
    allowDerivedMarkerAnswer,
    sourcePage: solution.page,
    rawAnswer: solution.rawAnswer,
    explanation: solution.explanation,
    complete: true,
    baseSolutionCheckpoint: solution.checkpoint,
    baseSolutionItemHash: canonicalEvidenceHash(solution.evidence),
    baseContextFrom: solution.contextFrom,
    baseContextTo: solution.contextTo,
    baseOwnedFrom: solution.ownedFrom,
    baseOwnedTo: solution.ownedTo,
  };
}

function parseRepairedSolution(
  value: unknown,
  label: string,
  base: OfficialSolution,
): OfficialSolution {
  const row = object(value, label);
  const rawNumber = exactString(row.number, `${label}.number`);
  const number = numericPrintedLocator(rawNumber);
  const page = integer(row.page, `${label}.page`, 1);
  if (number === null || row.complete !== true) throw new Error(`${label} is not a complete numbered solution`);
  const rawAnswer = exactString(row.answer, `${label}.answer`);
  const explanation = exactString(row.explanation, `${label}.explanation`);
  return {
    printedNumber: String(number),
    rawAnswer,
    explanation,
    page,
    evidence: { number: rawNumber, answer: rawAnswer, explanation, page, complete: true },
    checkpoint: base.checkpoint,
    contextFrom: base.contextFrom,
    contextTo: base.contextTo,
    ownedFrom: base.ownedFrom,
    ownedTo: base.ownedTo,
  };
}

type CanonicalSolutionArtifact = {
  path: string;
  sha256: string;
  checkpoint: Record<string, unknown>;
};

type PersistedSolutionRevisionAuthority = {
  generationId: string;
  key: string;
  repairArtifact: EvidencePointer;
  repairFidelityArtifact: EvidencePointer;
  revisionArtifact: EvidencePointer;
  revisionFidelityArtifact: EvidencePointer;
  finalSolutionItemHash: string;
  diagnosticDecisionHash: string;
  diagnosticEvidence: string;
};

type LegacySolutionRevisionPredecessor = {
  allowlistId: string;
  generationId: string;
  key: string;
  effectiveProblemCorpusHash: string;
  repairArtifact: EvidencePointer;
  repairFidelityArtifact: EvidencePointer;
  revisionArtifact: EvidencePointer & { promptVersion: number; promptDigest: string };
  revisionFidelityArtifact: EvidencePointer;
  revisionSolutionItemHash: string;
  failedDecisionHash: string;
  failedEvidenceHash: string;
  failedEvidence: string;
};

type PersistedSolutionGeneration = {
  generationId: string;
  key: string;
  effectiveProblemCorpusHash: string;
  baseFidelityCheckpoint: EvidencePointer;
  repairArtifact: EvidencePointer;
  repairFidelityArtifact: EvidencePointer;
  repairedItemHash: string;
  persistedSeed?: Record<string, unknown>;
  seededFromGenerationId?: string;
  revision?: PersistedSolutionRevisionAuthority;
  revisionTrigger?: Record<string, unknown>;
};

type PersistedSolutionHistory = {
  byKey: Map<string, PersistedSolutionGeneration[]>;
  currentByKey: Map<string, PersistedSolutionGeneration>;
  requiredRevisionKeys: Set<string>;
};

function readCanonicalSolutionArtifacts(
  stateDir: string,
  directory: string,
  pattern: RegExp,
): CanonicalSolutionArtifact[] {
  const absolute = join(stateDir, directory);
  if (!existsSync(absolute)) return [];
  const result: CanonicalSolutionArtifact[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isFile() && entry.name.endsWith(".tmp")) continue;
    if (!entry.isFile() || entry.isSymbolicLink() || !pattern.test(entry.name)) {
      throw new Error(`${directory}/${entry.name}: malformed persisted solution authority`);
    }
    const path = `${directory}/${entry.name}`;
    const absolutePath = realpathSync(join(stateDir, path));
    const expectedAbsolute = resolve(realpathSync(stateDir), path);
    if (absolutePath !== expectedAbsolute || !statSync(absolutePath).isFile()) {
      throw new Error(`${path}: persisted solution authority must be a confined regular file`);
    }
    const checkpoint = object(json(absolutePath), path);
    const sha256Value = hashFile(absolutePath);
    if (canonicalEvidenceHash(checkpoint) !== sha256Value) {
      throw new Error(`${path}: persisted solution authority is not canonical immutable JSON`);
    }
    result.push({ path, sha256: sha256Value, checkpoint });
  }
  return result;
}

function historicalTranscriptionBinding(
  checkpoint: Record<string, unknown>,
  rulesDigest: string,
): boolean {
  if (checkpoint.rulesDigest !== rulesDigest) return false;
  if (checkpoint.classifierVersion === CLASSIFIER_VERSION
    && checkpoint.transcriptionGateVersion === TRANSCRIPTION_GATE_VERSION
    && checkpoint.transcriptionPromptDigest === TRANSCRIPTION_PROMPT_DIGEST) return true;
  return checkpoint.classifierVersion === LEGACY_CLASSIFIER_VERSION
    && checkpoint.transcriptionGateVersion === LEGACY_TRANSCRIPTION_GATE_VERSION
    && checkpoint.transcriptionPromptDigest === LEGACY_TRANSCRIPTION_PROMPT_DIGEST;
}

function historicalSolutionFidelityInput(value: unknown, label: string): SolutionFidelityInput {
  const row = object(value, label);
  if (Object.keys(row).sort().join(",") !==
      "allowDerivedMarkerAnswer,baseContextFrom,baseContextTo,baseOwnedFrom,baseOwnedTo,baseSolutionCheckpoint,baseSolutionItemHash,complete,explanation,key,printedNumber,qtype,rawAnswer,sourcePage") {
    throw new Error(`${label} has unexpected fields`);
  }
  const qtype = row.qtype;
  if (qtype !== "mcq" && qtype !== "short" && qtype !== "ox") throw new Error(`${label}.qtype is invalid`);
  if (typeof row.allowDerivedMarkerAnswer !== "boolean" || row.complete !== true) {
    throw new Error(`${label} marker/complete fields are invalid`);
  }
  return {
    key: exactString(row.key, `${label}.key`),
    printedNumber: exactString(row.printedNumber, `${label}.printedNumber`),
    qtype,
    allowDerivedMarkerAnswer: row.allowDerivedMarkerAnswer,
    sourcePage: integer(row.sourcePage, `${label}.sourcePage`, 1),
    rawAnswer: exactString(row.rawAnswer, `${label}.rawAnswer`),
    explanation: exactString(row.explanation, `${label}.explanation`),
    complete: true,
    baseSolutionCheckpoint: evidencePointer(row.baseSolutionCheckpoint, `${label}.baseSolutionCheckpoint`),
    baseSolutionItemHash: digest(row.baseSolutionItemHash, `${label}.baseSolutionItemHash`),
    baseContextFrom: integer(row.baseContextFrom, `${label}.baseContextFrom`, 1),
    baseContextTo: integer(row.baseContextTo, `${label}.baseContextTo`, 1),
    baseOwnedFrom: integer(row.baseOwnedFrom, `${label}.baseOwnedFrom`, 1),
    baseOwnedTo: integer(row.baseOwnedTo, `${label}.baseOwnedTo`, 1),
  };
}

function persistedSolutionRevisionAuthority(
  value: unknown,
  label: string,
): PersistedSolutionRevisionAuthority {
  const row = object(value, label);
  const authority = {
    generationId: digest(row.generationId, `${label}.generationId`),
    key: exactString(row.key, `${label}.key`),
    repairArtifact: evidencePointer(row.repairArtifact, `${label}.repairArtifact`),
    repairFidelityArtifact: evidencePointer(row.repairFidelityArtifact, `${label}.repairFidelityArtifact`),
    revisionArtifact: evidencePointer(row.revisionArtifact, `${label}.revisionArtifact`),
    revisionFidelityArtifact: evidencePointer(
      row.revisionFidelityArtifact,
      `${label}.revisionFidelityArtifact`,
    ),
    finalSolutionItemHash: digest(row.finalSolutionItemHash, `${label}.finalSolutionItemHash`),
    diagnosticDecisionHash: digest(row.diagnosticDecisionHash, `${label}.diagnosticDecisionHash`),
    diagnosticEvidence: exactString(row.diagnosticEvidence, `${label}.diagnosticEvidence`),
  };
  if (!isDeepStrictEqual(row, authority)) throw new Error(`${label} has unexpected fields`);
  return authority;
}

function legacySolutionRevisionPredecessor(
  value: unknown,
  label: string,
): LegacySolutionRevisionPredecessor {
  const row = object(value, label);
  const revisionArtifactRow = object(row.revisionArtifact, `${label}.revisionArtifact`);
  const revisionArtifact = {
    path: exactString(revisionArtifactRow.path, `${label}.revisionArtifact.path`),
    sha256: digest(revisionArtifactRow.sha256, `${label}.revisionArtifact.sha256`),
    promptVersion: integer(revisionArtifactRow.promptVersion, `${label}.revisionArtifact.promptVersion`, 1),
    promptDigest: digest(revisionArtifactRow.promptDigest, `${label}.revisionArtifact.promptDigest`),
  };
  const predecessor = {
    allowlistId: exactString(row.allowlistId, `${label}.allowlistId`),
    generationId: digest(row.generationId, `${label}.generationId`),
    key: exactString(row.key, `${label}.key`),
    effectiveProblemCorpusHash: digest(
      row.effectiveProblemCorpusHash,
      `${label}.effectiveProblemCorpusHash`,
    ),
    repairArtifact: evidencePointer(row.repairArtifact, `${label}.repairArtifact`),
    repairFidelityArtifact: evidencePointer(row.repairFidelityArtifact, `${label}.repairFidelityArtifact`),
    revisionArtifact,
    revisionFidelityArtifact: evidencePointer(
      row.revisionFidelityArtifact,
      `${label}.revisionFidelityArtifact`,
    ),
    revisionSolutionItemHash: digest(
      row.revisionSolutionItemHash,
      `${label}.revisionSolutionItemHash`,
    ),
    failedDecisionHash: digest(row.failedDecisionHash, `${label}.failedDecisionHash`),
    failedEvidenceHash: digest(row.failedEvidenceHash, `${label}.failedEvidenceHash`),
    failedEvidence: exactString(row.failedEvidence, `${label}.failedEvidence`),
  };
  if (!isDeepStrictEqual(row, predecessor)) throw new Error(`${label} has unexpected fields`);
  return predecessor;
}

function verifyHistoricalSemanticTrigger(
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  solutionEvidence: DownloadEvidence,
  rulesDigest: string,
  effectiveProblemCorpusHash: string,
  key: string,
  fidelityDecisionHash: string,
  rawTrigger: Record<string, unknown>,
  rawDecision: unknown,
): { trigger: Record<string, unknown>; diagnosticEvidence: string } {
  const pointerRow = object(rawTrigger.semanticCheckpoint, `${key}.persistedSemanticCheckpoint`);
  const pointer = {
    path: exactString(pointerRow.path, `${key}.persistedSemanticCheckpoint.path`),
    sha256: digest(pointerRow.sha256, `${key}.persistedSemanticCheckpoint.sha256`),
    inputHash: digest(pointerRow.inputHash, `${key}.persistedSemanticCheckpoint.inputHash`),
    effectiveCorpusHash: digest(
      pointerRow.effectiveCorpusHash,
      `${key}.persistedSemanticCheckpoint.effectiveCorpusHash`,
    ),
    effectiveSolutionCorpusHash: digest(
      pointerRow.effectiveSolutionCorpusHash,
      `${key}.persistedSemanticCheckpoint.effectiveSolutionCorpusHash`,
    ),
  };
  if (!isDeepStrictEqual(pointerRow, pointer)) throw new Error(`${key}: persisted semantic pointer is not exact`);
  const checkpoint = readBoundEvidence(
    stateDir,
    { path: pointer.path, sha256: pointer.sha256 },
    `${key} persisted semantic checkpoint`,
  );
  const version = integer(checkpoint.version, `${key}.persistedSemantic.version`, 3);
  if (![3, 4, 5].includes(version) || !Array.isArray(checkpoint.inputs) || !Array.isArray(checkpoint.items)) {
    throw new Error(`${key}: persisted semantic checkpoint version/schema is invalid`);
  }
  const inputs = checkpoint.inputs.map((value, index) => {
    const row = object(value, `${pointer.path}.inputs[${index}]`);
    if (Object.keys(row).sort().join(",") !== "choices,detailedExplanation,key"
      || !Array.isArray(row.choices) || row.choices.length === 0) {
      throw new Error(`${pointer.path}.inputs[${index}] is invalid`);
    }
    return {
      key: exactString(row.key, `${pointer.path}.inputs[${index}].key`),
      choices: row.choices.map((choice, choiceIndex) =>
        exactString(choice, `${pointer.path}.inputs[${index}].choices[${choiceIndex}]`)),
      detailedExplanation: exactString(
        row.detailedExplanation,
        `${pointer.path}.inputs[${index}].detailedExplanation`,
      ),
    };
  });
  const inputByKey = new Map(inputs.map((input) => [input.key, input]));
  const decisions = checkpoint.items.map((value, index) => {
    const row = object(value, `${pointer.path}.items[${index}]`);
    const decisionKey = exactString(row.key, `${pointer.path}.items[${index}].key`);
    const input = inputByKey.get(decisionKey);
    if (!input) throw new Error(`${pointer.path}: semantic decision has no input ${decisionKey}`);
    const status = row.status;
    if (status !== "resolved" && status !== "ambiguous") throw new Error(`${decisionKey}: invalid semantic status`);
    const choiceIndex = row.choiceIndex === null
      ? null
      : integer(row.choiceIndex, `${decisionKey}.choiceIndex`, 1);
    if (status === "resolved"
      ? choiceIndex === null || choiceIndex > input.choices.length
      : choiceIndex !== null) {
      throw new Error(`${decisionKey}: invalid persisted semantic choice index`);
    }
    return {
      key: decisionKey,
      status,
      choiceIndex,
      evidence: exactString(row.evidence, `${decisionKey}.semanticEvidence`),
    };
  });
  if (new Set(inputs.map((input) => input.key)).size !== inputs.length
    || new Set(decisions.map((decision) => decision.key)).size !== decisions.length
    || decisions.length !== inputs.length) {
    throw new Error(`${pointer.path}: persisted semantic key coverage is not exact`);
  }
  const inputHash = canonicalEvidenceHash(inputs);
  const effectiveSolutionCorpusHash = digest(
    checkpoint.effectiveSolutionCorpusHash,
    `${pointer.path}.effectiveSolutionCorpusHash`,
  );
  const simplePath = `semantic-choice-checks/v${version}-${inputHash}.json`;
  const boundPath = `semantic-choice-checks/v${version}-${effectiveProblemCorpusHash}-` +
    `${effectiveSolutionCorpusHash}-${inputHash}.json`;
  if (pointer.path !== boundPath && (version === 5 || pointer.path !== simplePath)) {
    throw new Error(`${key}: persisted semantic path is not canonical`);
  }
  const decision = decisions.find((candidate) => candidate.key === key);
  if (!decision || decisions.filter((candidate) => candidate.key === key).length !== 1) {
    throw new Error(`${key}: persisted semantic decision is not unique`);
  }
  const semanticDecision = object(rawDecision, `${key}.persistedSemanticDecision`);
  const semanticDecisionHash = canonicalEvidenceHash(decision);
  const expectedCheckpoint = {
    version,
    entryId: entry.id,
    problemHash: problemEvidence.sha256,
    solutionHash: solutionEvidence.sha256,
    classifierVersion: checkpoint.classifierVersion,
    rulesDigest,
    transcriptionGateVersion: checkpoint.transcriptionGateVersion,
    transcriptionPromptDigest: checkpoint.transcriptionPromptDigest,
    effectiveCorpusHash: effectiveProblemCorpusHash,
    effectiveSolutionCorpusHash,
    inputHash,
    promptDigest: sha256(`${version}\n${SEMANTIC_CHOICE_RULES}`),
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    inputs,
    items: decisions,
  };
  const trigger = {
    kind: "semantic",
    fidelityDecisionHash,
    semanticCheckpoint: pointer,
    semanticDecisionHash,
  };
  if (pointer.inputHash !== inputHash || pointer.effectiveCorpusHash !== effectiveProblemCorpusHash
    || pointer.effectiveSolutionCorpusHash !== effectiveSolutionCorpusHash
    || !historicalTranscriptionBinding(checkpoint, rulesDigest)
    || !isDeepStrictEqual(checkpoint, expectedCheckpoint)
    || !isDeepStrictEqual(semanticDecision, decision)
    || rawTrigger.semanticDecisionHash !== semanticDecisionHash
    || !isDeepStrictEqual(rawTrigger, trigger)) {
    throw new Error(`${key}: persisted semantic checkpoint/decision envelope is stale`);
  }
  return { trigger, diagnosticEvidence: decision.evidence };
}

function verifyPersistedSolutionHistory(
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  solutionEvidence: DownloadEvidence,
  rulesDigest: string,
  effective: DecisionSummary,
  baseSolutions: Map<string, OfficialSolution>,
  currentEffectiveProblemCorpusHash: string,
  contract: VerificationContract,
): PersistedSolutionHistory {
  const repairFiles = readCanonicalSolutionArtifacts(
    stateDir,
    "solution-repairs",
    /^v1-\d{4}-\d{4}-[a-f0-9]{64}\.json$/u,
  );
  const repairFidelityFiles = readCanonicalSolutionArtifacts(
    stateDir,
    "solution-fidelity-repairs",
    /^v1-\d{4}-\d{4}-[a-f0-9]{64}-[a-f0-9]{64}\.json$/u,
  );
  const revisionFiles = readCanonicalSolutionArtifacts(
    stateDir,
    "solution-revisions",
    /^v1-\d{4}-\d{4}-[a-f0-9]{64}\.json$/u,
  );
  const revisionFidelityFiles = readCanonicalSolutionArtifacts(
    stateDir,
    "solution-fidelity-revisions",
    /^v1-\d{4}-\d{4}-[a-f0-9]{64}-[a-f0-9]{64}\.json$/u,
  );
  const promptUpgradeFiles = readCanonicalSolutionArtifacts(
    stateDir,
    "solution-revision-upgrades",
    /^v1-\d{4}-\d{4}-[a-f0-9]{64}\.json$/u,
  );
  const promptUpgradeFidelityFiles = readCanonicalSolutionArtifacts(
    stateDir,
    "solution-fidelity-revision-upgrades",
    /^v1-\d{4}-\d{4}-[a-f0-9]{64}-[a-f0-9]{64}\.json$/u,
  );
  const empty = {
    byKey: new Map<string, PersistedSolutionGeneration[]>(),
    currentByKey: new Map<string, PersistedSolutionGeneration>(),
    requiredRevisionKeys: new Set<string>(),
  };
  if (repairFiles.length + repairFidelityFiles.length + revisionFiles.length + revisionFidelityFiles.length
    + promptUpgradeFiles.length + promptUpgradeFidelityFiles.length === 0) {
    return empty;
  }

  const recordByNumber = new Map<string, ClassifiedEvidence>();
  for (const key of effective.order) {
    const record = effective.records.get(key)!;
    if (recordByNumber.has(record.question.printedNumber)) {
      throw new Error(`duplicate current problem number ${record.question.printedNumber}`);
    }
    recordByNumber.set(record.question.printedNumber, record);
  }
  const assignedRepairFidelity = new Set<string>();
  const assignedRevision = new Set<string>();
  const assignedRevisionFidelity = new Set<string>();
  const assignedPromptUpgrade = new Set<string>();
  const assignedPromptUpgradeFidelity = new Set<string>();
  const generations = new Map<string, PersistedSolutionGeneration>();
  const generationContexts = new Map<string, {
    input: SolutionFidelityInput;
    baseSolution: OfficialSolution;
    baseSolutionCheckpoint: EvidencePointer;
    repairFile: CanonicalSolutionArtifact;
    fidelityFile: CanonicalSolutionArtifact;
    firstDecision: SolutionFidelityDecision;
    repaired: OfficialSolution;
    repairedItemHash: string;
  }>();
  const legacyPromptUpgradePredecessors = new Map<string, LegacySolutionRevisionPredecessor>();

  for (const repairFile of repairFiles) {
    const repair = repairFile.checkpoint;
    const pathMatch = /^solution-repairs\/v1-(\d{4})-(\d{4})-([a-f0-9]{64})\.json$/u.exec(
      repairFile.path,
    )!;
    const basePage = Number(pathMatch[1]);
    const printedNumber = String(Number(pathMatch[2]));
    const baseFidelitySha = pathMatch[3];
    const record = recordByNumber.get(printedNumber);
    const baseSolution = baseSolutions.get(printedNumber);
    const key = exactString(repair.key, `${repairFile.path}.key`);
    if (!record || !baseSolution || record.question.key !== key) {
      throw new Error(`${repairFile.path}: persisted repair points to an unknown or renumbered solution`);
    }
    const baseFidelityCheckpoint = evidencePointer(
      repair.baseFidelityCheckpoint,
      `${repairFile.path}.baseFidelityCheckpoint`,
    );
    if (baseFidelityCheckpoint.sha256 !== baseFidelitySha) {
      throw new Error(`${repairFile.path}: filename does not bind its base fidelity hash`);
    }
    const baseFidelity = readBoundEvidence(
      stateDir,
      baseFidelityCheckpoint,
      `${repairFile.path} persisted base fidelity`,
    );
    const effectiveProblemCorpusHash = digest(
      repair.effectiveProblemCorpusHash,
      `${repairFile.path}.effectiveProblemCorpusHash`,
    );
    const baseName = /^solution-fidelity\/v1-(\d{4})-([a-f0-9]{64})-([a-f0-9]{64})\.json$/u.exec(
      baseFidelityCheckpoint.path,
    );
    const sliceIndex = baseName ? Number(baseName[1]) : -1;
    const slice = expectedSolutionFidelitySlices(solutionEvidence.pageCount)[sliceIndex];
    if (!baseName || !slice || baseName[2] !== effectiveProblemCorpusHash
      || baseName[3] !== baseFidelity.inputHash
      || baseFidelityCheckpoint.path !== `solution-fidelity/v${SOLUTION_FIDELITY_VERSION}-` +
        `${String(sliceIndex).padStart(4, "0")}-${effectiveProblemCorpusHash}-${baseFidelity.inputHash}.json`
      || baseFidelity.version !== SOLUTION_FIDELITY_VERSION || baseFidelity.entryId !== entry.id
      || baseFidelity.sourceHash !== solutionEvidence.sha256 || baseFidelity.from !== slice.from
      || baseFidelity.to !== slice.to || baseFidelity.ownedFrom !== slice.ownedFrom
      || baseFidelity.ownedTo !== slice.ownedTo
      || baseFidelity.effectiveProblemCorpusHash !== effectiveProblemCorpusHash
      || baseFidelity.promptDigest !== SOLUTION_FIDELITY_PROMPT_DIGEST
      || baseFidelity.model !== "gpt-5.6-sol" || baseFidelity.reasoningEffort !== "high"
      || !historicalTranscriptionBinding(baseFidelity, rulesDigest)
      || !Array.isArray(baseFidelity.inputs) || !Array.isArray(baseFidelity.items)) {
      throw new Error(`${baseFidelityCheckpoint.path}: persisted base fidelity metadata is stale`);
    }
    const baseInputs = baseFidelity.inputs.map((value, index) =>
      historicalSolutionFidelityInput(value, `${baseFidelityCheckpoint.path}.inputs[${index}]`));
    const inputByKey = new Map<string, SolutionFidelityInput>();
    for (const input of baseInputs) {
      if (inputByKey.has(input.key)) throw new Error(`${baseFidelityCheckpoint.path}: duplicate input ${input.key}`);
      inputByKey.set(input.key, input);
    }
    const baseDecisions = baseFidelity.items.map((value, index) => {
      const decisionKey = exactString(
        object(value, `${baseFidelityCheckpoint.path}.items[${index}]`).key,
        `${baseFidelityCheckpoint.path}.items[${index}].key`,
      );
      const input = inputByKey.get(decisionKey);
      if (!input) throw new Error(`${baseFidelityCheckpoint.path}: decision has no input ${decisionKey}`);
      return solutionFidelityDecision(value, input, `${baseFidelityCheckpoint.path}.items[${index}]`);
    });
    if (new Set(baseDecisions.map((decision) => decision.key)).size !== baseDecisions.length
      || baseDecisions.length !== baseInputs.length
      || baseFidelity.inputHash !== canonicalEvidenceHash(baseInputs)) {
      throw new Error(`${baseFidelityCheckpoint.path}: persisted base fidelity coverage is not exact`);
    }
    const expectedBaseFidelity = {
      version: SOLUTION_FIDELITY_VERSION,
      entryId: entry.id,
      sourceHash: solutionEvidence.sha256,
      from: slice.from,
      to: slice.to,
      ownedFrom: slice.ownedFrom,
      ownedTo: slice.ownedTo,
      classifierVersion: baseFidelity.classifierVersion,
      rulesDigest,
      transcriptionGateVersion: baseFidelity.transcriptionGateVersion,
      transcriptionPromptDigest: baseFidelity.transcriptionPromptDigest,
      effectiveProblemCorpusHash,
      inputHash: canonicalEvidenceHash(baseInputs),
      promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      inputs: baseInputs,
      items: baseDecisions,
    };
    if (!isDeepStrictEqual(baseFidelity, expectedBaseFidelity)) {
      throw new Error(`${baseFidelityCheckpoint.path}: persisted base fidelity envelope is stale`);
    }
    const input = inputByKey.get(key);
    const baseDecision = baseDecisions.find((decision) => decision.key === key);
    const expectedBaseInput = fidelityInput(record, baseSolution);
    if (!input || !baseDecision || !isDeepStrictEqual(input, expectedBaseInput)
      || input.sourcePage < slice.ownedFrom || input.sourcePage > slice.ownedTo) {
      throw new Error(`${baseFidelityCheckpoint.path}: persisted target input is not exact`);
    }

    const baseSolutionCheckpoint = evidencePointer(
      repair.baseSolutionCheckpoint,
      `${repairFile.path}.baseSolutionCheckpoint`,
    );
    sameEvidencePointer(baseSolutionCheckpoint, baseSolution.checkpoint, `${repairFile.path}.baseSolutionCheckpoint`);
    const baseSolutionPath = confinedEvidencePath(
      stateDir,
      baseSolutionCheckpoint,
      `${repairFile.path} base solution checkpoint`,
    );
    if (hashFile(baseSolutionPath) !== baseSolutionCheckpoint.sha256) {
      throw new Error(`${repairFile.path}: base solution checkpoint hash mismatch`);
    }
    const repaired = parseRepairedSolution(repair.item, `${repairFile.path}.item`, baseSolution);
    const repairedItemHash = canonicalEvidenceHash(repaired.evidence);
    const effectivePage = integer(repair.effectivePage, `${repairFile.path}.effectivePage`, 1);
    if (repaired.printedNumber !== printedNumber || repaired.page !== effectivePage
      || repaired.page < input.baseContextFrom || repaired.page > input.baseContextTo) {
      throw new Error(`${repairFile.path}: persisted repaired solution identity/context is invalid`);
    }
    const generationId = canonicalEvidenceHash({
      key,
      effectiveProblemCorpusHash,
      baseFidelityCheckpointSha256: baseFidelityCheckpoint.sha256,
    });
    if (generations.has(generationId)) throw new Error(`${key}: duplicate persisted solution generation`);
    let persistedSeed: Record<string, unknown> | undefined;
    let seededFromGenerationId: string | undefined;
    if (repair.persistedSeed !== undefined) {
      if (contract.auditVersion !== 5) {
        throw new Error(`${repairFile.path}: persisted solution seed requires answer audit v5`);
      }
      persistedSeed = object(repair.persistedSeed, `${repairFile.path}.persistedSeed`);
      seededFromGenerationId = digest(
        persistedSeed.generationId,
        `${repairFile.path}.persistedSeed.generationId`,
      );
      if (persistedSeed.version !== PERSISTED_SOLUTION_REPAIR_SEED_VERSION
        || digest(
          persistedSeed.effectiveProblemCorpusHash,
          `${repairFile.path}.persistedSeed.effectiveProblemCorpusHash`,
        ) === effectiveProblemCorpusHash
        || persistedSeed.repairedItemHash !== repairedItemHash) {
        throw new Error(`${repairFile.path}: persisted seed metadata is invalid`);
      }
      for (const [label, raw] of [
        ["base fidelity", persistedSeed.baseFidelityCheckpoint],
        ["repair", persistedSeed.repairArtifact],
        ["repair fidelity", persistedSeed.repairFidelityArtifact],
      ] as const) {
        const pointer = evidencePointer(raw, `${repairFile.path}.persistedSeed.${label}`);
        const path = confinedEvidencePath(stateDir, pointer, `${repairFile.path} persisted seed ${label}`);
        if (hashFile(path) !== pointer.sha256) throw new Error(`${repairFile.path}: persisted seed ${label} hash mismatch`);
      }
    }
    const expectedRepair = {
      version: SOLUTION_REPAIR_VERSION,
      entryId: entry.id,
      key,
      printedNumber,
      basePage,
      contextFrom: input.baseContextFrom,
      contextTo: input.baseContextTo,
      baseOwnedFrom: input.baseOwnedFrom,
      baseOwnedTo: input.baseOwnedTo,
      sourceHash: solutionEvidence.sha256,
      effectiveProblemCorpusHash,
      baseSolutionCheckpoint,
      baseFidelityCheckpoint,
      baseSolutionItemHash: input.baseSolutionItemHash,
      baseRawAnswerHash: sha256(input.rawAnswer),
      baseExplanationHash: sha256(input.explanation),
      promptVersion: TARGETED_SOLUTION_TRANSCRIPTION_VERSION,
      promptDigest: TARGETED_SOLUTION_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      ...(persistedSeed ? { persistedSeed } : {}),
      effectivePage,
      item: repaired.evidence,
    };
    if (!isDeepStrictEqual(repair, expectedRepair)
      || basePage !== input.sourcePage
      || repair.baseSolutionItemHash !== input.baseSolutionItemHash
      || repair.baseRawAnswerHash !== sha256(input.rawAnswer)
      || repair.baseExplanationHash !== sha256(input.explanation)
      || isTerminalSolutionDecision(input, baseSolution, baseDecision)
        && input.baseContextTo <= slice.to && persistedSeed === undefined) {
      throw new Error(`${repairFile.path}: persisted repair metadata is stale or not source-required`);
    }

    const fidelityChildren = repairFidelityFiles.filter((candidate) =>
      object(candidate.checkpoint.repairArtifact, `${candidate.path}.repairArtifact`).path === repairFile.path);
    if (fidelityChildren.length !== 1) {
      throw new Error(`${repairFile.path}: persisted repair fidelity child coverage is not exact`);
    }
    const fidelityFile = fidelityChildren[0];
    assignedRepairFidelity.add(fidelityFile.path);
    const repairedInput: SolutionFidelityInput = {
      ...input,
      sourcePage: repaired.page,
      rawAnswer: repaired.rawAnswer,
      explanation: repaired.explanation,
    };
    const repairedInputHash = canonicalEvidenceHash(repairedInput);
    const fidelity = fidelityFile.checkpoint;
    const firstDecision = solutionFidelityDecision(
      fidelity.item,
      repairedInput,
      `${fidelityFile.path}.item`,
    );
    const expectedFidelityPath = `solution-fidelity-repairs/v${SOLUTION_REPAIR_FIDELITY_VERSION}-` +
      `${String(basePage).padStart(4, "0")}-${printedNumber.padStart(4, "0")}-` +
      `${baseFidelityCheckpoint.sha256}-${repairedItemHash}.json`;
    const expectedFidelity = {
      version: SOLUTION_REPAIR_FIDELITY_VERSION,
      entryId: entry.id,
      key,
      sourceHash: solutionEvidence.sha256,
      from: input.baseContextFrom,
      to: input.baseContextTo,
      basePage,
      effectivePage: repaired.page,
      baseOwnedFrom: input.baseOwnedFrom,
      baseOwnedTo: input.baseOwnedTo,
      effectiveProblemCorpusHash,
      baseSolutionCheckpoint,
      baseFidelityCheckpoint,
      repairArtifact: { path: repairFile.path, sha256: repairFile.sha256 },
      effectiveSolutionItemHash: repairedItemHash,
      inputHash: repairedInputHash,
      promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      input: repairedInput,
      item: firstDecision,
    };
    if (fidelityFile.path !== expectedFidelityPath || !isDeepStrictEqual(fidelity, expectedFidelity)) {
      throw new Error(`${fidelityFile.path}: persisted repair fidelity metadata is stale`);
    }
    const firstTerminal = isTerminalSolutionDecision(repairedInput, repaired, firstDecision);
    const revisionChildren = revisionFiles.filter((candidate) =>
      object(candidate.checkpoint.baseRepairArtifact, `${candidate.path}.baseRepairArtifact`).path === repairFile.path);
    if (revisionChildren.length > 1 || (!firstTerminal && revisionChildren.length !== 1)) {
      throw new Error(`${repairFile.path}: persisted revision child coverage is not exact`);
    }

    let revisionAuthority: PersistedSolutionRevisionAuthority | undefined;
    let revisionTrigger: Record<string, unknown> | undefined;
    if (revisionChildren.length === 1) {
      const revisionFile = revisionChildren[0];
      assignedRevision.add(revisionFile.path);
      const revision = revisionFile.checkpoint;
      const rawTrigger = object(revision.trigger, `${revisionFile.path}.trigger`);
      const diagnosticDecisionHash = canonicalEvidenceHash(firstDecision);
      let trigger: Record<string, unknown>;
      let diagnosticEvidence: string;
      let semanticDecision: Record<string, unknown> | undefined;
      if (rawTrigger.kind === "fidelity") {
        if (firstTerminal) throw new Error(`${revisionFile.path}: terminal first repair has a fidelity revision`);
        trigger = { kind: "fidelity", fidelityDecisionHash: diagnosticDecisionHash };
        diagnosticEvidence = firstDecision.evidence;
      } else if (rawTrigger.kind === "semantic") {
        if (!firstTerminal) throw new Error(`${revisionFile.path}: nonterminal first repair has a semantic revision`);
        const semantic = verifyHistoricalSemanticTrigger(
          stateDir,
          entry,
          problemEvidence,
          solutionEvidence,
          rulesDigest,
          effectiveProblemCorpusHash,
          key,
          diagnosticDecisionHash,
          rawTrigger,
          revision.semanticDecision,
        );
        trigger = semantic.trigger;
        diagnosticEvidence = semantic.diagnosticEvidence;
        semanticDecision = object(revision.semanticDecision, `${revisionFile.path}.semanticDecision`);
      } else if (rawTrigger.kind === "persisted") {
        if (contract.auditVersion !== 5) {
          throw new Error(`${revisionFile.path}: persisted solution trigger requires answer audit v5`);
        }
        const predecessor = persistedSolutionRevisionAuthority(
          rawTrigger.predecessor,
          `${revisionFile.path}.trigger.predecessor`,
        );
        trigger = {
          kind: "persisted",
          fidelityDecisionHash: diagnosticDecisionHash,
          persistedTriggerVersion: PERSISTED_SOLUTION_REVISION_TRIGGER_VERSION,
          predecessor,
        };
        if (rawTrigger.persistedTriggerVersion !== PERSISTED_SOLUTION_REVISION_TRIGGER_VERSION) {
          throw new Error(`${revisionFile.path}: persisted trigger version is stale`);
        }
        diagnosticEvidence = predecessor.diagnosticEvidence;
        revisionTrigger = trigger;
      } else {
        throw new Error(`${revisionFile.path}: persisted revision trigger kind is invalid`);
      }
      if (!isDeepStrictEqual(rawTrigger, trigger)) throw new Error(`${revisionFile.path}: revision trigger is stale`);
      const revised = parseRepairedSolution(revision.item, `${revisionFile.path}.item`, baseSolution);
      const revisedItemHash = canonicalEvidenceHash(revised.evidence);
      if (revised.printedNumber !== printedNumber
        || revised.page !== integer(revision.effectivePage, `${revisionFile.path}.effectivePage`, 1)
        || revised.page < input.baseContextFrom || revised.page > input.baseContextTo) {
        throw new Error(`${revisionFile.path}: persisted revised solution identity/context is invalid`);
      }
      const baseRepairFidelityArtifact = {
        path: fidelityFile.path,
        sha256: fidelityFile.sha256,
        promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
      };
      const legacyPromptUpgradeSpec = SOLUTION_PROMPT_UPGRADE_ALLOWLIST.find((candidate) =>
        candidate.entryId === entry.id && candidate.key === key
        && candidate.sourceHash === solutionEvidence.sha256
        && candidate.legacyRevisionArtifactHash === revisionFile.sha256
        && revision.promptVersion === candidate.legacyPromptVersion
        && revision.promptDigest === candidate.legacyPromptDigest);
      const revisionPromptVersion = legacyPromptUpgradeSpec?.legacyPromptVersion
        ?? TARGETED_SOLUTION_REVISION_VERSION;
      const revisionPromptDigest = legacyPromptUpgradeSpec?.legacyPromptDigest
        ?? TARGETED_SOLUTION_REVISION_PROMPT_DIGEST;
      const revisionBasisHash = canonicalEvidenceHash({
        key,
        sourceHash: solutionEvidence.sha256,
        basePage: input.sourcePage,
        contextFrom: input.baseContextFrom,
        contextTo: input.baseContextTo,
        baseSolutionCheckpoint,
        baseSolutionItemHash: input.baseSolutionItemHash,
        baseRepairArtifact: { path: repairFile.path, sha256: repairFile.sha256 },
        baseRepairFidelityArtifact,
        baseRepairSolutionItemHash: repairedItemHash,
        trigger,
        revisionPromptDigest,
      });
      const expectedRevisionPath = `solution-revisions/v${SOLUTION_REVISION_VERSION}-` +
        `${String(repaired.page).padStart(4, "0")}-${printedNumber.padStart(4, "0")}-${revisionBasisHash}.json`;
      const expectedRevision = {
        version: SOLUTION_REVISION_VERSION,
        entryId: entry.id,
        key,
        printedNumber,
        sourceHash: solutionEvidence.sha256,
        basePage: input.sourcePage,
        contextFrom: input.baseContextFrom,
        contextTo: input.baseContextTo,
        baseOwnedFrom: input.baseOwnedFrom,
        baseOwnedTo: input.baseOwnedTo,
        effectiveProblemCorpusHash,
        baseSolutionCheckpoint,
        baseSolutionItemHash: input.baseSolutionItemHash,
        baseRepairArtifact: { path: repairFile.path, sha256: repairFile.sha256 },
        baseRepairFidelityArtifact,
        baseRepairPage: repaired.page,
        baseRepairSolutionItemHash: repairedItemHash,
        trigger,
        diagnosticDecision: firstDecision,
        diagnosticDecisionHash,
        ...(semanticDecision ? { semanticDecision } : {}),
        promptVersion: revisionPromptVersion,
        promptDigest: revisionPromptDigest,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        effectivePage: revised.page,
        item: revised.evidence,
      };
      if (revisionFile.path !== expectedRevisionPath || !isDeepStrictEqual(revision, expectedRevision)) {
        throw new Error(`${revisionFile.path}: persisted revision metadata is stale`);
      }
      const revisionFidelityChildren = revisionFidelityFiles.filter((candidate) =>
        object(candidate.checkpoint.revisionArtifact, `${candidate.path}.revisionArtifact`).path === revisionFile.path);
      if (revisionFidelityChildren.length !== 1) {
        throw new Error(`${revisionFile.path}: persisted revision fidelity child coverage is not exact`);
      }
      const revisionFidelityFile = revisionFidelityChildren[0];
      assignedRevisionFidelity.add(revisionFidelityFile.path);
      const revisedInput: SolutionFidelityInput = {
        ...input,
        sourcePage: revised.page,
        rawAnswer: revised.rawAnswer,
        explanation: revised.explanation,
      };
      const finalDecision = solutionFidelityDecision(
        revisionFidelityFile.checkpoint.item,
        revisedInput,
        `${revisionFidelityFile.path}.item`,
      );
      const expectedRevisionFidelityPath = `solution-fidelity-revisions/v${SOLUTION_REVISION_FIDELITY_VERSION}-` +
        `${String(repaired.page).padStart(4, "0")}-${printedNumber.padStart(4, "0")}-` +
        `${revisionFile.sha256}-${revisedItemHash}.json`;
      const expectedRevisionFidelity = {
        version: SOLUTION_REVISION_FIDELITY_VERSION,
        entryId: entry.id,
        key,
        sourceHash: solutionEvidence.sha256,
        from: input.baseContextFrom,
        to: input.baseContextTo,
        basePage: input.sourcePage,
        baseRepairPage: repaired.page,
        effectivePage: revised.page,
        baseOwnedFrom: input.baseOwnedFrom,
        baseOwnedTo: input.baseOwnedTo,
        effectiveProblemCorpusHash,
        baseSolutionCheckpoint,
        baseSolutionItemHash: input.baseSolutionItemHash,
        baseRepairArtifact: { path: repairFile.path, sha256: repairFile.sha256 },
        baseRepairFidelityArtifact,
        baseRepairSolutionItemHash: repairedItemHash,
        diagnosticDecisionHash,
        trigger,
        revisionArtifact: { path: revisionFile.path, sha256: revisionFile.sha256 },
        effectiveSolutionItemHash: revisedItemHash,
        inputHash: canonicalEvidenceHash(revisedInput),
        promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        input: revisedInput,
        item: finalDecision,
      };
      if (revisionFidelityFile.path !== expectedRevisionFidelityPath
        || !isDeepStrictEqual(revisionFidelityFile.checkpoint, expectedRevisionFidelity)) {
        throw new Error(`${revisionFidelityFile.path}: persisted revision fidelity is stale`);
      }
      if (!isTerminalSolutionDecision(revisedInput, revised, finalDecision)) {
        if (!legacyPromptUpgradeSpec
          || revisionFidelityFile.sha256 !== legacyPromptUpgradeSpec.legacyRevisionFidelityArtifactHash
          || finalDecision.answerStatus !== "mismatch" || finalDecision.explanationStatus !== "exact"
          || finalDecision.sourcePage !== revised.page) {
          throw new Error(`${revisionFidelityFile.path}: persisted revision fidelity is nonterminal`);
        }
        const predecessor = {
          allowlistId: legacyPromptUpgradeSpec.allowlistId,
          generationId,
          key,
          effectiveProblemCorpusHash,
          repairArtifact: { path: repairFile.path, sha256: repairFile.sha256 },
          repairFidelityArtifact: { path: fidelityFile.path, sha256: fidelityFile.sha256 },
          revisionArtifact: {
            path: revisionFile.path,
            sha256: revisionFile.sha256,
            promptVersion: legacyPromptUpgradeSpec.legacyPromptVersion,
            promptDigest: legacyPromptUpgradeSpec.legacyPromptDigest,
          },
          revisionFidelityArtifact: {
            path: revisionFidelityFile.path,
            sha256: revisionFidelityFile.sha256,
          },
          revisionSolutionItemHash: revisedItemHash,
          failedDecisionHash: canonicalEvidenceHash(finalDecision),
          failedEvidenceHash: sha256(finalDecision.evidence),
          failedEvidence: finalDecision.evidence,
        };
        if (legacyPromptUpgradePredecessors.has(revisionFile.path)) {
          throw new Error(`${key}: duplicate legacy solution prompt predecessor`);
        }
        legacyPromptUpgradePredecessors.set(revisionFile.path, predecessor);
      } else {
        if (legacyPromptUpgradeSpec) {
          throw new Error(`${revisionFidelityFile.path}: legacy prompt revision cannot be terminal authority`);
        }
        revisionAuthority = {
          generationId,
          key,
          repairArtifact: { path: repairFile.path, sha256: repairFile.sha256 },
          repairFidelityArtifact: { path: fidelityFile.path, sha256: fidelityFile.sha256 },
          revisionArtifact: { path: revisionFile.path, sha256: revisionFile.sha256 },
          revisionFidelityArtifact: {
            path: revisionFidelityFile.path,
            sha256: revisionFidelityFile.sha256,
          },
          finalSolutionItemHash: revisedItemHash,
          diagnosticDecisionHash,
          diagnosticEvidence,
        };
        if (rawTrigger.kind !== "persisted") revisionTrigger = trigger;
      }
    }
    if (!revisionAuthority && !firstTerminal) {
      throw new Error(`${fidelityFile.path}: persisted first repair is nonterminal without a revision`);
    }
    generations.set(generationId, {
      generationId,
      key,
      effectiveProblemCorpusHash,
      baseFidelityCheckpoint,
      repairArtifact: { path: repairFile.path, sha256: repairFile.sha256 },
      repairFidelityArtifact: { path: fidelityFile.path, sha256: fidelityFile.sha256 },
      repairedItemHash,
      ...(persistedSeed ? { persistedSeed, seededFromGenerationId } : {}),
      ...(revisionAuthority ? { revision: revisionAuthority } : {}),
      ...(revisionTrigger ? { revisionTrigger } : {}),
    });
    generationContexts.set(generationId, {
      input,
      baseSolution,
      baseSolutionCheckpoint,
      repairFile,
      fidelityFile,
      firstDecision,
      repaired,
      repairedItemHash,
    });
  }

  const usedLegacyPromptUpgradePredecessors = new Set<string>();
  const generationByRepairPath = new Map([...generationContexts.entries()].map(([generationId, context]) => [
    context.repairFile.path,
    { generationId, context, generation: generations.get(generationId)! },
  ] as const));
  for (const upgradeFile of promptUpgradeFiles) {
    if (contract.auditVersion !== 5) {
      throw new Error(`${upgradeFile.path}: solution prompt upgrade requires answer audit v5`);
    }
    const upgrade = upgradeFile.checkpoint;
    const baseRepairArtifact = evidencePointer(
      upgrade.baseRepairArtifact,
      `${upgradeFile.path}.baseRepairArtifact`,
    );
    const parent = generationByRepairPath.get(baseRepairArtifact.path);
    if (!parent) throw new Error(`${upgradeFile.path}: solution prompt upgrade parent is missing`);
    const { generationId, context, generation } = parent;
    const {
      input,
      baseSolution,
      baseSolutionCheckpoint,
      repairFile,
      fidelityFile,
      firstDecision,
      repaired,
      repairedItemHash,
    } = context;
    if (generation.revision) throw new Error(`${input.key}: duplicate solution revision authority`);
    const rawTrigger = object(upgrade.trigger, `${upgradeFile.path}.trigger`);
    const predecessor = legacySolutionRevisionPredecessor(
      rawTrigger.legacyPredecessor,
      `${upgradeFile.path}.trigger.legacyPredecessor`,
    );
    const registeredPredecessor = legacyPromptUpgradePredecessors.get(predecessor.revisionArtifact.path);
    if (!registeredPredecessor || !isDeepStrictEqual(registeredPredecessor, predecessor)
      || usedLegacyPromptUpgradePredecessors.has(predecessor.revisionArtifact.path)) {
      throw new Error(`${upgradeFile.path}: legacy prompt predecessor is invalid or duplicated`);
    }
    const spec = SOLUTION_PROMPT_UPGRADE_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === predecessor.allowlistId && candidate.entryId === entry.id
      && candidate.key === input.key && candidate.sourceHash === solutionEvidence.sha256
      && candidate.legacyRevisionArtifactHash === predecessor.revisionArtifact.sha256
      && candidate.legacyRevisionFidelityArtifactHash === predecessor.revisionFidelityArtifact.sha256
      && predecessor.revisionArtifact.promptVersion === candidate.legacyPromptVersion
      && predecessor.revisionArtifact.promptDigest === candidate.legacyPromptDigest);
    if (!spec || predecessor.generationId !== generationId
      || predecessor.effectiveProblemCorpusHash !== generation.effectiveProblemCorpusHash
      || !isDeepStrictEqual(predecessor.repairArtifact, generation.repairArtifact)
      || !isDeepStrictEqual(predecessor.repairFidelityArtifact, generation.repairFidelityArtifact)) {
      throw new Error(`${upgradeFile.path}: solution prompt upgrade allowlist/generation is stale`);
    }
    const diagnosticDecisionHash = canonicalEvidenceHash(firstDecision);
    const trigger = {
      kind: "prompt-upgrade",
      fidelityDecisionHash: diagnosticDecisionHash,
      promptUpgradeVersion: SOLUTION_PROMPT_UPGRADE_VERSION,
      legacyPredecessor: predecessor,
    };
    if (!isDeepStrictEqual(rawTrigger, trigger)) {
      throw new Error(`${upgradeFile.path}: solution prompt upgrade trigger is stale`);
    }
    const revised = parseRepairedSolution(upgrade.item, `${upgradeFile.path}.item`, baseSolution);
    const revisedItemHash = canonicalEvidenceHash(revised.evidence);
    const baseRepairFidelityArtifact = {
      path: fidelityFile.path,
      sha256: fidelityFile.sha256,
      promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    };
    const revisionBasisHash = canonicalEvidenceHash({
      key: input.key,
      sourceHash: solutionEvidence.sha256,
      basePage: input.sourcePage,
      contextFrom: input.baseContextFrom,
      contextTo: input.baseContextTo,
      baseSolutionCheckpoint,
      baseSolutionItemHash: input.baseSolutionItemHash,
      baseRepairArtifact,
      baseRepairFidelityArtifact,
      baseRepairSolutionItemHash: repairedItemHash,
      trigger,
      revisionPromptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
    });
    const expectedUpgradePath = `solution-revision-upgrades/v${SOLUTION_PROMPT_UPGRADE_VERSION}-` +
      `${String(repaired.page).padStart(4, "0")}-${input.printedNumber.padStart(4, "0")}-` +
      `${revisionBasisHash}.json`;
    const expectedUpgrade = {
      version: SOLUTION_PROMPT_UPGRADE_VERSION,
      entryId: entry.id,
      key: input.key,
      printedNumber: input.printedNumber,
      sourceHash: solutionEvidence.sha256,
      basePage: input.sourcePage,
      contextFrom: input.baseContextFrom,
      contextTo: input.baseContextTo,
      baseOwnedFrom: input.baseOwnedFrom,
      baseOwnedTo: input.baseOwnedTo,
      effectiveProblemCorpusHash: generation.effectiveProblemCorpusHash,
      baseSolutionCheckpoint,
      baseSolutionItemHash: input.baseSolutionItemHash,
      baseRepairArtifact,
      baseRepairFidelityArtifact,
      baseRepairPage: repaired.page,
      baseRepairSolutionItemHash: repairedItemHash,
      trigger,
      diagnosticDecision: firstDecision,
      diagnosticDecisionHash,
      promptVersion: TARGETED_SOLUTION_REVISION_VERSION,
      promptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      effectivePage: revised.page,
      item: revised.evidence,
    };
    if (upgradeFile.path !== expectedUpgradePath || revised.printedNumber !== input.printedNumber
      || revised.page !== integer(upgrade.effectivePage, `${upgradeFile.path}.effectivePage`, 1)
      || revised.page < input.baseContextFrom || revised.page > input.baseContextTo
      || revised.rawAnswer !== spec.expectedAnswer || !isDeepStrictEqual(upgrade, expectedUpgrade)) {
      throw new Error(`${upgradeFile.path}: solution prompt upgrade is stale or not allowlisted`);
    }
    assignedPromptUpgrade.add(upgradeFile.path);
    usedLegacyPromptUpgradePredecessors.add(predecessor.revisionArtifact.path);
    const fidelityChildren = promptUpgradeFidelityFiles.filter((candidate) =>
      object(candidate.checkpoint.revisionArtifact, `${candidate.path}.revisionArtifact`).path === upgradeFile.path);
    if (fidelityChildren.length !== 1) {
      throw new Error(`${upgradeFile.path}: solution prompt upgrade fidelity child coverage is not exact`);
    }
    const fidelityChild = fidelityChildren[0];
    assignedPromptUpgradeFidelity.add(fidelityChild.path);
    const revisedInput: SolutionFidelityInput = {
      ...input,
      sourcePage: revised.page,
      rawAnswer: revised.rawAnswer,
      explanation: revised.explanation,
    };
    const decision = solutionFidelityDecision(
      fidelityChild.checkpoint.item,
      revisedInput,
      `${fidelityChild.path}.item`,
    );
    const expectedFidelityPath =
      `solution-fidelity-revision-upgrades/v${SOLUTION_PROMPT_UPGRADE_FIDELITY_VERSION}-` +
      `${String(repaired.page).padStart(4, "0")}-${input.printedNumber.padStart(4, "0")}-` +
      `${upgradeFile.sha256}-${revisedItemHash}.json`;
    const expectedFidelity = {
      version: SOLUTION_PROMPT_UPGRADE_FIDELITY_VERSION,
      entryId: entry.id,
      key: input.key,
      sourceHash: solutionEvidence.sha256,
      from: input.baseContextFrom,
      to: input.baseContextTo,
      basePage: input.sourcePage,
      baseRepairPage: repaired.page,
      effectivePage: revised.page,
      baseOwnedFrom: input.baseOwnedFrom,
      baseOwnedTo: input.baseOwnedTo,
      effectiveProblemCorpusHash: generation.effectiveProblemCorpusHash,
      baseSolutionCheckpoint,
      baseSolutionItemHash: input.baseSolutionItemHash,
      baseRepairArtifact,
      baseRepairFidelityArtifact,
      baseRepairSolutionItemHash: repairedItemHash,
      diagnosticDecisionHash,
      trigger,
      revisionArtifact: { path: upgradeFile.path, sha256: upgradeFile.sha256 },
      effectiveSolutionItemHash: revisedItemHash,
      inputHash: canonicalEvidenceHash(revisedInput),
      promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      input: revisedInput,
      item: decision,
    };
    if (fidelityChild.path !== expectedFidelityPath
      || !isDeepStrictEqual(fidelityChild.checkpoint, expectedFidelity)
      || decision.sourcePage !== revised.page || decision.answerStatus !== "exact"
      || decision.explanationStatus !== "exact") {
      throw new Error(`${fidelityChild.path}: solution prompt upgrade fidelity is stale or nonterminal`);
    }
    generation.revision = {
      generationId,
      key: input.key,
      repairArtifact: { path: repairFile.path, sha256: repairFile.sha256 },
      repairFidelityArtifact: { path: fidelityFile.path, sha256: fidelityFile.sha256 },
      revisionArtifact: { path: upgradeFile.path, sha256: upgradeFile.sha256 },
      revisionFidelityArtifact: { path: fidelityChild.path, sha256: fidelityChild.sha256 },
      finalSolutionItemHash: revisedItemHash,
      diagnosticDecisionHash,
      diagnosticEvidence: predecessor.failedEvidence,
    };
    generation.revisionTrigger = trigger;
  }
  for (const predecessor of legacyPromptUpgradePredecessors.values()) {
    if (!usedLegacyPromptUpgradePredecessors.has(predecessor.revisionArtifact.path)) {
      throw new Error(`${predecessor.key}: legacy solution revision prompt upgrade is missing`);
    }
  }

  if (repairFidelityFiles.some((file) => !assignedRepairFidelity.has(file.path))) {
    throw new Error("orphan persisted solution repair fidelity artifact");
  }
  if (revisionFiles.some((file) => !assignedRevision.has(file.path))) {
    throw new Error("orphan persisted solution revision artifact");
  }
  if (revisionFidelityFiles.some((file) => !assignedRevisionFidelity.has(file.path))) {
    throw new Error("orphan persisted solution revision fidelity artifact");
  }
  if (promptUpgradeFiles.some((file) => !assignedPromptUpgrade.has(file.path))) {
    throw new Error("orphan solution prompt upgrade artifact");
  }
  if (promptUpgradeFidelityFiles.some((file) => !assignedPromptUpgradeFidelity.has(file.path))) {
    throw new Error("orphan solution prompt upgrade fidelity artifact");
  }
  for (const generation of generations.values()) {
    if (!generation.seededFromGenerationId) continue;
    const seed = generations.get(generation.seededFromGenerationId);
    const expectedSeed = seed && {
      version: PERSISTED_SOLUTION_REPAIR_SEED_VERSION,
      generationId: seed.generationId,
      effectiveProblemCorpusHash: seed.effectiveProblemCorpusHash,
      baseFidelityCheckpoint: seed.baseFidelityCheckpoint,
      repairArtifact: seed.repairArtifact,
      repairFidelityArtifact: seed.repairFidelityArtifact,
      repairedItemHash: seed.repairedItemHash,
    };
    if (!seed || seed === generation || seed.key !== generation.key
      || seed.repairedItemHash !== generation.repairedItemHash
      || !generation.persistedSeed || !isDeepStrictEqual(generation.persistedSeed, expectedSeed)) {
      throw new Error(`${generation.key}: persisted repair seed generation is invalid`);
    }
  }
  for (const generation of generations.values()) {
    if (generation.revisionTrigger?.kind !== "persisted") continue;
    const predecessor = persistedSolutionRevisionAuthority(
      generation.revisionTrigger.predecessor,
      `${generation.key}.persistedPredecessor`,
    );
    const candidates = [...generations.values()].filter((candidate) =>
      candidate.revision && isDeepStrictEqual(candidate.revision, predecessor));
    if (candidates.length !== 1 || candidates[0] === generation
      || candidates[0].generationId !== predecessor.generationId
      || candidates[0].key !== generation.key) {
      throw new Error(`${generation.key}: persisted revision predecessor is invalid`);
    }
  }

  const byKey = new Map<string, PersistedSolutionGeneration[]>();
  for (const generation of generations.values()) {
    const values = byKey.get(generation.key) ?? [];
    values.push(generation);
    byKey.set(generation.key, values);
  }
  const currentByKey = new Map<string, PersistedSolutionGeneration>();
  const requiredRevisionKeys = new Set<string>();
  for (const [key, values] of byKey) {
    values.sort((left, right) => {
      const leftCurrent = left.effectiveProblemCorpusHash === currentEffectiveProblemCorpusHash ? 1 : 0;
      const rightCurrent = right.effectiveProblemCorpusHash === currentEffectiveProblemCorpusHash ? 1 : 0;
      return rightCurrent - leftCurrent || left.generationId.localeCompare(right.generationId, "en");
    });
    const current = values.find((value) => value.effectiveProblemCorpusHash === currentEffectiveProblemCorpusHash);
    if (current) currentByKey.set(key, current);
    if (values.some((value) => value.revision)) requiredRevisionKeys.add(key);
  }
  return { byKey, currentByKey, requiredRevisionKeys };
}

type VerifiedFirstSolutionRepair = {
  solution: OfficialSolution;
  decision: SolutionFidelityDecision;
  repairArtifact: EvidencePointer;
  fidelityArtifact: EvidencePointer;
  effectiveSolutionItemHash: string;
  evidence: Record<string, unknown>;
};

function isTerminalSolutionDecision(
  input: SolutionFidelityInput,
  solution: OfficialSolution,
  decision: SolutionFidelityDecision,
): boolean {
  const terminalAnswer = decision.answerStatus === "exact"
    || decision.answerStatus === "not_visible" && input.allowDerivedMarkerAnswer;
  return decision.sourcePage === solution.page && decision.explanationStatus === "exact" && terminalAnswer;
}

function verifyFirstSolutionRepair(
  stateDir: string,
  entry: ManifestEntry,
  solutionEvidence: DownloadEvidence,
  effectiveProblemCorpusHash: string,
  input: SolutionFidelityInput,
  baseSolution: OfficialSolution,
  baseFidelityArtifact: EvidencePointer,
  repair: Record<string, unknown>,
  persistedGeneration?: PersistedSolutionGeneration,
): VerifiedFirstSolutionRepair {
  const key = input.key;
  const printedNumber = exactString(repair.printedNumber, `${key}.printedNumber`);
  const basePage = integer(repair.basePage, `${key}.basePage`, 1);
  const effectivePage = integer(repair.effectivePage, `${key}.effectivePage`, 1);
  const contextFrom = integer(repair.contextFrom, `${key}.contextFrom`, 1);
  const contextTo = integer(repair.contextTo, `${key}.contextTo`, contextFrom);
  const baseOwnedFrom = integer(repair.baseOwnedFrom, `${key}.baseOwnedFrom`, contextFrom);
  const baseOwnedTo = integer(repair.baseOwnedTo, `${key}.baseOwnedTo`, baseOwnedFrom);
  if (printedNumber !== input.printedNumber || basePage !== input.sourcePage
    || contextFrom !== input.baseContextFrom || contextTo !== input.baseContextTo
    || baseOwnedFrom !== input.baseOwnedFrom || baseOwnedTo !== input.baseOwnedTo
    || basePage < baseOwnedFrom || basePage > baseOwnedTo
    || effectivePage < contextFrom || effectivePage > contextTo
    || contextTo - contextFrom + 1 > SOLUTION_SLICE_PAGES) {
    throw new Error(`${key}: solution repair identity/context does not match owning base 6/4 chunk`);
  }
  const baseSolutionCheckpoint = evidencePointer(repair.baseSolutionCheckpoint, `${key}.baseSolutionCheckpoint`);
  const baseFidelityCheckpoint = evidencePointer(repair.baseFidelityCheckpoint, `${key}.baseFidelityCheckpoint`);
  sameEvidencePointer(baseSolutionCheckpoint, input.baseSolutionCheckpoint, `${key}.baseSolutionCheckpoint`);
  sameEvidencePointer(baseFidelityCheckpoint, baseFidelityArtifact, `${key}.baseFidelityCheckpoint`);
  const baseSolutionPath = confinedEvidencePath(stateDir, baseSolutionCheckpoint, `${key} base solution checkpoint`);
  if (hashFile(baseSolutionPath) !== baseSolutionCheckpoint.sha256) {
    throw new Error(`${key}: base solution checkpoint hash mismatch`);
  }
  readBoundEvidence(stateDir, baseFidelityCheckpoint, `${key} base fidelity checkpoint`);
  if (repair.baseSolutionItemHash !== input.baseSolutionItemHash
    || repair.baseRawAnswerHash !== sha256(input.rawAnswer)
    || repair.baseExplanationHash !== sha256(input.explanation)) {
    throw new Error(`${key}: solution repair base hashes do not match immutable evidence`);
  }

  const repairArtifact = evidencePointer(repair.repairArtifact, `${key}.repairArtifact`);
  const expectedRepairPath = `solution-repairs/v${SOLUTION_REPAIR_VERSION}-${String(basePage).padStart(4, "0")}-` +
    `${printedNumber.padStart(4, "0")}-${baseFidelityArtifact.sha256}.json`;
  if (repairArtifact.path !== expectedRepairPath) throw new Error(`${key}: solution repair path is invalid`);
  const repairCheckpoint = readBoundEvidence(stateDir, repairArtifact, `${key} solution repair`);
  const corrected = parseRepairedSolution(repairCheckpoint.item, `${key} solution repair.item`, baseSolution);
  if (corrected.printedNumber !== printedNumber || corrected.page !== effectivePage
    || corrected.page < contextFrom || corrected.page > contextTo) {
    throw new Error(`${key}: repaired solution changed printed number or escaped its bounded context`);
  }
  const effectiveSolutionItemHash = canonicalEvidenceHash(corrected.evidence);
  const expectedRepairCheckpoint = {
    version: SOLUTION_REPAIR_VERSION,
    entryId: entry.id,
    key,
    printedNumber,
    basePage,
    contextFrom,
    contextTo,
    baseOwnedFrom,
    baseOwnedTo,
    sourceHash: solutionEvidence.sha256,
    effectiveProblemCorpusHash,
    baseSolutionCheckpoint,
    baseFidelityCheckpoint,
    baseSolutionItemHash: input.baseSolutionItemHash,
    baseRawAnswerHash: sha256(input.rawAnswer),
    baseExplanationHash: sha256(input.explanation),
    promptVersion: TARGETED_SOLUTION_TRANSCRIPTION_VERSION,
    promptDigest: TARGETED_SOLUTION_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    ...(persistedGeneration?.persistedSeed
      ? { persistedSeed: persistedGeneration.persistedSeed }
      : {}),
    effectivePage,
    item: corrected.evidence,
  };
  if (!isDeepStrictEqual(repairCheckpoint, expectedRepairCheckpoint)) {
    throw new Error(`${key}: solution repair metadata/content is stale or incomplete`);
  }

  const fidelityArtifactRow = object(repair.fidelityArtifact, `${key}.fidelityArtifact`);
  if (Object.keys(fidelityArtifactRow).sort().join(",") !== "path,promptDigest,sha256") {
    throw new Error(`${key}.fidelityArtifact has unexpected fields`);
  }
  const fidelityArtifact = evidencePointer(
    { path: fidelityArtifactRow.path, sha256: fidelityArtifactRow.sha256 },
    `${key}.fidelityArtifact`,
  );
  if (fidelityArtifactRow.promptDigest !== SOLUTION_FIDELITY_PROMPT_DIGEST) {
    throw new Error(`${key}: repaired solution fidelity prompt is stale`);
  }
  const repairedInput: SolutionFidelityInput = {
    ...input,
    sourcePage: corrected.page,
    rawAnswer: corrected.rawAnswer,
    explanation: corrected.explanation,
  };
  const repairedInputHash = canonicalEvidenceHash(repairedInput);
  const expectedFidelityPath = `solution-fidelity-repairs/v${SOLUTION_REPAIR_FIDELITY_VERSION}-` +
    `${String(basePage).padStart(4, "0")}-${printedNumber.padStart(4, "0")}-` +
    `${baseFidelityArtifact.sha256}-${effectiveSolutionItemHash}.json`;
  if (fidelityArtifact.path !== expectedFidelityPath) {
    throw new Error(`${key}: repaired solution fidelity path is invalid`);
  }
  const fidelityCheckpoint = readBoundEvidence(stateDir, fidelityArtifact, `${key} repaired solution fidelity`);
  const repairedDecision = solutionFidelityDecision(
    fidelityCheckpoint.item,
    repairedInput,
    `${key} repaired solution fidelity.item`,
  );
  const expectedFidelityCheckpoint = {
    version: SOLUTION_REPAIR_FIDELITY_VERSION,
    entryId: entry.id,
    key,
    sourceHash: solutionEvidence.sha256,
    from: contextFrom,
    to: contextTo,
    basePage,
    effectivePage,
    baseOwnedFrom,
    baseOwnedTo,
    effectiveProblemCorpusHash,
    baseSolutionCheckpoint,
    baseFidelityCheckpoint,
    repairArtifact,
    effectiveSolutionItemHash,
    inputHash: repairedInputHash,
    promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    input: repairedInput,
    item: repairedDecision,
  };
  if (!isDeepStrictEqual(fidelityCheckpoint, expectedFidelityCheckpoint)) {
    throw new Error(`${key}: repaired solution fidelity metadata/content is stale or incomplete`);
  }
  if (persistedGeneration && (
    persistedGeneration.effectiveProblemCorpusHash !== effectiveProblemCorpusHash
    || persistedGeneration.key !== key
    || !isDeepStrictEqual(persistedGeneration.repairArtifact, repairArtifact)
    || !isDeepStrictEqual(persistedGeneration.repairFidelityArtifact, fidelityArtifact)
  )) {
    throw new Error(`${key}: current repair does not match the reconstructed persisted generation`);
  }
  const evidence = {
    key,
    printedNumber,
    basePage,
    effectivePage,
    contextFrom,
    contextTo,
    baseOwnedFrom,
    baseOwnedTo,
    baseSolutionCheckpoint,
    baseFidelityCheckpoint,
    repairArtifact,
    fidelityArtifact: { ...fidelityArtifact, promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST },
    baseSolutionItemHash: input.baseSolutionItemHash,
    effectiveSolutionItemHash,
    baseRawAnswerHash: sha256(input.rawAnswer),
    effectiveRawAnswerHash: sha256(corrected.rawAnswer),
    baseExplanationHash: sha256(input.explanation),
    effectiveExplanationHash: sha256(corrected.explanation),
  };
  return {
    solution: corrected,
    decision: repairedDecision,
    repairArtifact,
    fidelityArtifact,
    effectiveSolutionItemHash,
    evidence,
  };
}

type RevisionSemanticContext = {
  inputs: Array<{ key: string; choices: string[]; detailedExplanation: string }>;
  effectiveSolutionCorpusHash: string;
  solutionRevisionApplied: boolean;
};

function verifySolutionRevision(
  value: unknown,
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  solutionEvidence: DownloadEvidence,
  rulesDigest: string,
  effectiveProblemCorpusHash: string,
  input: SolutionFidelityInput,
  baseSolution: OfficialSolution,
  first: VerifiedFirstSolutionRepair,
  record: ClassifiedEvidence,
  semanticContext: RevisionSemanticContext | null,
  contract: VerificationContract,
  persistedGeneration?: PersistedSolutionGeneration,
): {
  solution: OfficialSolution;
  decision: SolutionFidelityDecision;
  fidelityArtifact: EvidencePointer;
  evidence: Record<string, unknown>;
} {
  const key = input.key;
  const revision = object(value, `${key}.revision`);
  const trigger = object(revision.trigger, `${key}.revision.trigger`);
  const fidelityDecisionHash = canonicalEvidenceHash(first.decision);
  if (trigger.fidelityDecisionHash !== fidelityDecisionHash) {
    throw new Error(`${key}: solution revision does not bind the first fidelity decision`);
  }
  const firstTerminal = isTerminalSolutionDecision(input, first.solution, first.decision);
  let semanticDecision: SemanticDecision | undefined;
  let promptUpgradeSpec: (typeof SOLUTION_PROMPT_UPGRADE_ALLOWLIST)[number] | undefined;
  let expectedTrigger: Record<string, unknown>;
  if (trigger.kind === "fidelity") {
    if (firstTerminal) throw new Error(`${key}: terminal first repair must not declare a fidelity revision`);
    expectedTrigger = { kind: "fidelity", fidelityDecisionHash };
  } else if (trigger.kind === "semantic") {
    if (!firstTerminal || !semanticContext) {
      throw new Error(`${key}: semantic revision lacks a terminal first repair or pre-revision corpus`);
    }
    const semanticCheckpointRow = object(trigger.semanticCheckpoint, `${key}.revision.trigger.semanticCheckpoint`);
    const semanticCheckpoint = {
      ...evidencePointer(
        { path: semanticCheckpointRow.path, sha256: semanticCheckpointRow.sha256 },
        `${key}.revision.trigger.semanticCheckpoint`,
      ),
      inputHash: exactString(
        semanticCheckpointRow.inputHash,
        `${key}.revision.trigger.semanticCheckpoint.inputHash`,
      ),
      effectiveCorpusHash: exactString(
        semanticCheckpointRow.effectiveCorpusHash,
        `${key}.revision.trigger.semanticCheckpoint.effectiveCorpusHash`,
      ),
      effectiveSolutionCorpusHash: exactString(
        semanticCheckpointRow.effectiveSolutionCorpusHash,
        `${key}.revision.trigger.semanticCheckpoint.effectiveSolutionCorpusHash`,
      ),
    };
    if (semanticCheckpoint.effectiveCorpusHash !== effectiveProblemCorpusHash
      || semanticCheckpoint.effectiveSolutionCorpusHash !== semanticContext.effectiveSolutionCorpusHash) {
      throw new Error(`${key}: semantic revision points to a stale corpus generation`);
    }
    const semanticByKey = verifySemanticCheckpoint(
      {
        path: semanticCheckpoint.path,
        sha256: semanticCheckpoint.sha256,
        inputHash: semanticCheckpoint.inputHash,
        ...(contract.semanticChoiceVersion === SEMANTIC_CHOICE_VERSION
          ? { effectiveCorpusHash: semanticCheckpoint.effectiveCorpusHash }
          : {}),
        effectiveSolutionCorpusHash: semanticCheckpoint.effectiveSolutionCorpusHash,
      },
      stateDir,
      entry,
      problemEvidence,
      solutionEvidence,
      rulesDigest,
      effectiveProblemCorpusHash,
      semanticContext.effectiveSolutionCorpusHash,
      semanticContext.inputs,
      semanticContext.solutionRevisionApplied,
      contract,
    );
    semanticDecision = semanticByKey.get(key);
    if (!semanticDecision) throw new Error(`${key}: semantic revision checkpoint has no diagnostic decision`);
    const semanticDecisionHash = canonicalEvidenceHash(semanticDecision);
    if (trigger.semanticDecisionHash !== semanticDecisionHash) {
      throw new Error(`${key}: semantic revision decision hash is stale`);
    }
    if (record.question.qtype !== "mcq") throw new Error(`${key}: semantic revision is not an MCQ`);
    const resolution = resolveOfficialAnswerForDb(record.question, first.solution.rawAnswer);
    if (resolution.mode !== "choice-marker" || resolution.choiceIndex === null) {
      throw new Error(`${key}: semantic revision does not originate from a marker-only answer`);
    }
    if (semanticDecision.status === "resolved" && semanticDecision.choiceIndex === resolution.choiceIndex + 1) {
      throw new Error(`${key}: matching semantic proof must not trigger a solution revision`);
    }
    expectedTrigger = {
      kind: "semantic",
      fidelityDecisionHash,
      semanticCheckpoint,
      semanticDecisionHash,
    };
  } else if (trigger.kind === "persisted") {
    const predecessor = persistedSolutionRevisionAuthority(
      trigger.predecessor,
      `${key}.revision.trigger.predecessor`,
    );
    expectedTrigger = {
      kind: "persisted",
      fidelityDecisionHash,
      persistedTriggerVersion: PERSISTED_SOLUTION_REVISION_TRIGGER_VERSION,
      predecessor,
    };
    if (trigger.persistedTriggerVersion !== PERSISTED_SOLUTION_REVISION_TRIGGER_VERSION
      || !persistedGeneration?.revision
      || !isDeepStrictEqual(persistedGeneration.revisionTrigger, expectedTrigger)) {
      throw new Error(`${key}: persisted solution revision trigger is stale or lacks its predecessor`);
    }
  } else if (trigger.kind === "prompt-upgrade") {
    const predecessor = legacySolutionRevisionPredecessor(
      trigger.legacyPredecessor,
      `${key}.revision.trigger.legacyPredecessor`,
    );
    expectedTrigger = {
      kind: "prompt-upgrade",
      fidelityDecisionHash,
      promptUpgradeVersion: SOLUTION_PROMPT_UPGRADE_VERSION,
      legacyPredecessor: predecessor,
    };
    promptUpgradeSpec = SOLUTION_PROMPT_UPGRADE_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === predecessor.allowlistId && candidate.entryId === entry.id
      && candidate.key === key && candidate.sourceHash === solutionEvidence.sha256
      && candidate.legacyRevisionArtifactHash === predecessor.revisionArtifact.sha256
      && candidate.legacyRevisionFidelityArtifactHash === predecessor.revisionFidelityArtifact.sha256
      && predecessor.revisionArtifact.promptVersion === candidate.legacyPromptVersion
      && predecessor.revisionArtifact.promptDigest === candidate.legacyPromptDigest);
    if (contract.auditVersion !== 5 || trigger.promptUpgradeVersion !== SOLUTION_PROMPT_UPGRADE_VERSION
      || !promptUpgradeSpec || !persistedGeneration?.revision
      || !isDeepStrictEqual(persistedGeneration.revisionTrigger, expectedTrigger)) {
      throw new Error(`${key}: solution prompt upgrade trigger is stale or lacks its legacy predecessor`);
    }
  } else {
    throw new Error(`${key}: solution revision trigger kind is invalid`);
  }

  const solutionArtifactRow = object(revision.solutionArtifact, `${key}.revision.solutionArtifact`);
  const solutionArtifact = evidencePointer(
    { path: solutionArtifactRow.path, sha256: solutionArtifactRow.sha256 },
    `${key}.revision.solutionArtifact`,
  );
  if (solutionArtifactRow.revisionPromptVersion !== TARGETED_SOLUTION_REVISION_VERSION
    || solutionArtifactRow.revisionPromptDigest !== TARGETED_SOLUTION_REVISION_PROMPT_DIGEST) {
    throw new Error(`${key}: solution revision prompt is stale`);
  }
  const revisionBasisHash = canonicalEvidenceHash({
    key,
    sourceHash: solutionEvidence.sha256,
    basePage: input.sourcePage,
    contextFrom: input.baseContextFrom,
    contextTo: input.baseContextTo,
    baseSolutionCheckpoint: input.baseSolutionCheckpoint,
    baseSolutionItemHash: input.baseSolutionItemHash,
    baseRepairArtifact: first.repairArtifact,
    baseRepairFidelityArtifact: {
      ...first.fidelityArtifact,
      promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    },
    baseRepairSolutionItemHash: first.effectiveSolutionItemHash,
    trigger: expectedTrigger,
    revisionPromptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
  });
  const revisionDirectory = promptUpgradeSpec ? "solution-revision-upgrades" : "solution-revisions";
  const expectedSolutionPath = `${revisionDirectory}/v${SOLUTION_REVISION_VERSION}-` +
    `${String(first.solution.page).padStart(4, "0")}-${input.printedNumber.padStart(4, "0")}-` +
    `${revisionBasisHash}.json`;
  if (solutionArtifact.path !== expectedSolutionPath) {
    throw new Error(`${key}: solution revision path is invalid`);
  }
  const revisionCheckpoint = readBoundEvidence(stateDir, solutionArtifact, `${key} solution revision`);
  const revised = parseRepairedSolution(
    revisionCheckpoint.item,
    `${key} solution revision.item`,
    baseSolution,
  );
  if (revised.printedNumber !== input.printedNumber
    || revised.page < input.baseContextFrom || revised.page > input.baseContextTo
    || promptUpgradeSpec && revised.rawAnswer !== promptUpgradeSpec.expectedAnswer) {
    throw new Error(`${key}: solution revision changed number or escaped bounded context`);
  }
  const effectiveSolutionItemHash = canonicalEvidenceHash(revised.evidence);
  const expectedRevisionCheckpoint = {
    version: SOLUTION_REVISION_VERSION,
    entryId: entry.id,
    key,
    printedNumber: input.printedNumber,
    sourceHash: solutionEvidence.sha256,
    basePage: input.sourcePage,
    contextFrom: input.baseContextFrom,
    contextTo: input.baseContextTo,
    baseOwnedFrom: input.baseOwnedFrom,
    baseOwnedTo: input.baseOwnedTo,
    effectiveProblemCorpusHash,
    baseSolutionCheckpoint: input.baseSolutionCheckpoint,
    baseSolutionItemHash: input.baseSolutionItemHash,
    baseRepairArtifact: first.repairArtifact,
    baseRepairFidelityArtifact: {
      ...first.fidelityArtifact,
      promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    },
    baseRepairPage: first.solution.page,
    baseRepairSolutionItemHash: first.effectiveSolutionItemHash,
    trigger: expectedTrigger,
    diagnosticDecision: first.decision,
    diagnosticDecisionHash: fidelityDecisionHash,
    ...(semanticDecision ? { semanticDecision } : {}),
    promptVersion: TARGETED_SOLUTION_REVISION_VERSION,
    promptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    effectivePage: revised.page,
    item: revised.evidence,
  };
  if (!isDeepStrictEqual(revisionCheckpoint, expectedRevisionCheckpoint)) {
    throw new Error(`${key}: solution revision metadata/content is stale or incomplete`);
  }

  const fidelityArtifactRow = object(revision.fidelityArtifact, `${key}.revision.fidelityArtifact`);
  if (Object.keys(fidelityArtifactRow).sort().join(",") !== "path,promptDigest,sha256"
    || fidelityArtifactRow.promptDigest !== SOLUTION_FIDELITY_PROMPT_DIGEST) {
    throw new Error(`${key}: solution revision fidelity envelope or prompt is stale`);
  }
  const fidelityArtifact = evidencePointer(
    { path: fidelityArtifactRow.path, sha256: fidelityArtifactRow.sha256 },
    `${key}.revision.fidelityArtifact`,
  );
  const revisedInput: SolutionFidelityInput = {
    ...input,
    sourcePage: revised.page,
    rawAnswer: revised.rawAnswer,
    explanation: revised.explanation,
  };
  const revisedInputHash = canonicalEvidenceHash(revisedInput);
  const fidelityDirectory = promptUpgradeSpec
    ? "solution-fidelity-revision-upgrades"
    : "solution-fidelity-revisions";
  const expectedFidelityPath = `${fidelityDirectory}/v${SOLUTION_REVISION_FIDELITY_VERSION}-` +
    `${String(first.solution.page).padStart(4, "0")}-${input.printedNumber.padStart(4, "0")}-` +
    `${solutionArtifact.sha256}-${effectiveSolutionItemHash}.json`;
  if (fidelityArtifact.path !== expectedFidelityPath) {
    throw new Error(`${key}: solution revision fidelity path is invalid`);
  }
  const fidelityCheckpoint = readBoundEvidence(
    stateDir,
    fidelityArtifact,
    `${key} solution revision fidelity`,
  );
  const decision = solutionFidelityDecision(
    fidelityCheckpoint.item,
    revisedInput,
    `${key} solution revision fidelity.item`,
  );
  const expectedFidelityCheckpoint = {
    version: SOLUTION_REVISION_FIDELITY_VERSION,
    entryId: entry.id,
    key,
    sourceHash: solutionEvidence.sha256,
    from: input.baseContextFrom,
    to: input.baseContextTo,
    basePage: input.sourcePage,
    baseRepairPage: first.solution.page,
    effectivePage: revised.page,
    baseOwnedFrom: input.baseOwnedFrom,
    baseOwnedTo: input.baseOwnedTo,
    effectiveProblemCorpusHash,
    baseSolutionCheckpoint: input.baseSolutionCheckpoint,
    baseSolutionItemHash: input.baseSolutionItemHash,
    baseRepairArtifact: first.repairArtifact,
    baseRepairFidelityArtifact: {
      ...first.fidelityArtifact,
      promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    },
    baseRepairSolutionItemHash: first.effectiveSolutionItemHash,
    diagnosticDecisionHash: fidelityDecisionHash,
    trigger: expectedTrigger,
    revisionArtifact: solutionArtifact,
    effectiveSolutionItemHash,
    inputHash: revisedInputHash,
    promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    input: revisedInput,
    item: decision,
  };
  if (!isDeepStrictEqual(fidelityCheckpoint, expectedFidelityCheckpoint)) {
    throw new Error(`${key}: solution revision fidelity metadata/content is stale or incomplete`);
  }
  if (!isTerminalSolutionDecision(input, revised, decision)
    || promptUpgradeSpec && decision.answerStatus !== "exact") {
    throw new Error(`${key}: solution revision did not reach terminal source fidelity`);
  }
  const expectedEvidence = {
    trigger: expectedTrigger,
    baseRepairPage: first.solution.page,
    effectivePage: revised.page,
    baseRepairArtifact: first.repairArtifact,
    baseRepairFidelityArtifact: {
      ...first.fidelityArtifact,
      promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    },
    solutionArtifact: {
      ...solutionArtifact,
      revisionPromptVersion: TARGETED_SOLUTION_REVISION_VERSION,
      revisionPromptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
    },
    fidelityArtifact: {
      ...fidelityArtifact,
      promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    },
    diagnosticDecisionHash: fidelityDecisionHash,
    baseSolutionItemHash: input.baseSolutionItemHash,
    baseRepairSolutionItemHash: first.effectiveSolutionItemHash,
    effectiveSolutionItemHash,
    baseRepairRawAnswerHash: sha256(first.solution.rawAnswer),
    effectiveRawAnswerHash: sha256(revised.rawAnswer),
    baseRepairExplanationHash: sha256(first.solution.explanation),
    effectiveExplanationHash: sha256(revised.explanation),
  };
  if (!isDeepStrictEqual(revision, expectedEvidence)) {
    throw new Error(`${key}: solution revision evidence envelope does not match its exact chain`);
  }
  if (persistedGeneration?.revision && (
    !isDeepStrictEqual(persistedGeneration.revision.revisionArtifact, solutionArtifact)
    || !isDeepStrictEqual(persistedGeneration.revision.revisionFidelityArtifact, fidelityArtifact)
    || persistedGeneration.revision.finalSolutionItemHash !== effectiveSolutionItemHash
  )) {
    throw new Error(`${key}: current revision does not match the reconstructed persisted generation`);
  }
  return { solution: revised, decision, fidelityArtifact, evidence: expectedEvidence };
}

function verifySolutionFidelity(
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  solutionEvidence: DownloadEvidence,
  rulesDigest: string,
  effective: DecisionSummary,
  baseSolutions: Map<string, OfficialSolution>,
  audit: Record<string, unknown>,
  contract: VerificationContract,
): VerifiedSolutionFidelity {
  if (!Array.isArray(audit.solutionFidelityCheckpoints) || !Array.isArray(audit.solutionFidelityItems)
    || !Array.isArray(audit.solutionRepairs)) {
    throw new Error("answer audit solution fidelity arrays are missing");
  }
  const acceptedRecords = effective.order.map((key) => effective.records.get(key)!)
    .filter((record) => record.classification.decision === "accept");
  const effectiveProblemCorpusHash = canonicalEvidenceHash(effective.order.map((key) => {
    const record = effective.records.get(key)!;
    return { question: record.question.evidence, classification: record.classification };
  }));
  const accepted = acceptedRecords.map((record) => {
    const solution = baseSolutions.get(record.question.printedNumber);
    if (!solution || !solution.rawAnswer.trim() || !solution.explanation.trim()) {
      throw new Error(`${record.question.key}: accepted question has no complete base official solution`);
    }
    return { record, solution, input: fidelityInput(record, solution) };
  });
  const acceptedSolutionKeys = accepted.map(({ record }) => record.question.key).sort(compareCorpusQuestionKeys);
  const acceptedKeySet = new Set(acceptedSolutionKeys);
  const persistedHistory = verifyPersistedSolutionHistory(
    stateDir,
    entry,
    problemEvidence,
    solutionEvidence,
    rulesDigest,
    effective,
    baseSolutions,
    effectiveProblemCorpusHash,
    contract,
  );
  for (const key of persistedHistory.byKey.keys()) {
    if (acceptedKeySet.has(key) && !persistedHistory.currentByKey.has(key)) {
      throw new Error(`${key}: accepted sticky solution authority has no complete current generation`);
    }
  }
  const declaredCheckpoints = new Map<string, SolutionFidelityCheckpointEvidence>();
  for (const [index, value] of audit.solutionFidelityCheckpoints.entries()) {
    const checkpoint = solutionFidelityCheckpointEvidence(value, `solutionFidelityCheckpoints[${index}]`);
    if (declaredCheckpoints.has(checkpoint.path)) throw new Error(`duplicate solution fidelity checkpoint ${checkpoint.path}`);
    declaredCheckpoints.set(checkpoint.path, checkpoint);
  }

  const baseResults = new Map<string, {
    input: SolutionFidelityInput;
    solution: OfficialSolution;
    decision: SolutionFidelityDecision;
    artifact: EvidencePointer;
    sliceTo: number;
  }>();
  const expectedCheckpoints: SolutionFidelityCheckpointEvidence[] = [];
  for (const slice of expectedSolutionFidelitySlices(solutionEvidence.pageCount)) {
    const owned = accepted.filter(({ input }) => input.sourcePage >= slice.ownedFrom && input.sourcePage <= slice.ownedTo);
    if (owned.length === 0) continue;
    const inputs = owned.map(({ input }) => input);
    const inputHash = canonicalEvidenceHash(inputs);
    const relativePath = `solution-fidelity/v${SOLUTION_FIDELITY_VERSION}-${String(slice.index).padStart(4, "0")}-` +
      `${effectiveProblemCorpusHash}-${inputHash}.json`;
    const expectedEvidence = {
      path: relativePath,
      sha256: declaredCheckpoints.get(relativePath)?.sha256 ?? "",
      from: slice.from,
      to: slice.to,
      ownedFrom: slice.ownedFrom,
      ownedTo: slice.ownedTo,
      inputHash,
    };
    const declared = declaredCheckpoints.get(relativePath);
    if (!declared || !isDeepStrictEqual(declared, expectedEvidence)) {
      throw new Error(`${relativePath}: missing or stale solution fidelity checkpoint evidence`);
    }
    const pointer = { path: declared.path, sha256: declared.sha256 };
    const checkpoint = readBoundEvidence(stateDir, pointer, relativePath);
    if (!Array.isArray(checkpoint.items)) throw new Error(`${relativePath}.items must be an array`);
    const inputByKey = new Map(inputs.map((input) => [input.key, input]));
    const decisions = new Map<string, SolutionFidelityDecision>();
    const items = checkpoint.items.map((value, index) => {
      const key = exactString(object(value, `${relativePath}.items[${index}]`).key, `${relativePath}.items[${index}].key`);
      const input = inputByKey.get(key);
      if (!input || decisions.has(key)) throw new Error(`${relativePath}: missing, extra, or duplicate key ${key}`);
      const decision = solutionFidelityDecision(value, input, `${relativePath}.items[${index}]`);
      if (decision.sourcePage < slice.from || decision.sourcePage > slice.to) {
        throw new Error(`${key}: fidelity sourcePage is outside its attached 22/18 slice`);
      }
      decisions.set(key, decision);
      return decision;
    });
    if (decisions.size !== inputs.length) throw new Error(`${relativePath}: accepted solution key coverage is incomplete`);
    const expectedCheckpoint = {
      version: SOLUTION_FIDELITY_VERSION,
      entryId: entry.id,
      sourceHash: solutionEvidence.sha256,
      from: slice.from,
      to: slice.to,
      ownedFrom: slice.ownedFrom,
      ownedTo: slice.ownedTo,
      classifierVersion: contract.classifierVersion,
      rulesDigest,
      transcriptionGateVersion: contract.transcriptionGateVersion,
      transcriptionPromptDigest: contract.transcriptionPromptDigest,
      effectiveProblemCorpusHash,
      inputHash,
      promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      inputs,
      items,
    };
    if (!isDeepStrictEqual(checkpoint, expectedCheckpoint)) {
      throw new Error(`${relativePath}: metadata/input/output is stale or incomplete`);
    }
    for (const { solution, input } of owned) {
      if (baseResults.has(input.key)) throw new Error(`${input.key}: duplicate solution fidelity ownership`);
      baseResults.set(input.key, {
        input,
        solution,
        decision: decisions.get(input.key)!,
        artifact: pointer,
        sliceTo: slice.to,
      });
    }
    expectedCheckpoints.push(expectedEvidence);
  }
  if (baseResults.size !== accepted.length) {
    throw new Error(`solution fidelity accepted-key coverage is ${baseResults.size}/${accepted.length}`);
  }
  expectedCheckpoints.sort((left, right) => left.path.localeCompare(right.path));
  if (!isDeepStrictEqual(audit.solutionFidelityCheckpoints, expectedCheckpoints)) {
    throw new Error("answer audit solution fidelity checkpoint set/order is not exact");
  }

  const expectedRepairKeys = new Set([...baseResults].flatMap(([key, result]) => {
    const terminalAnswer = result.decision.answerStatus === "exact"
      || result.decision.answerStatus === "not_visible" && result.input.allowDerivedMarkerAnswer;
    return result.decision.sourcePage !== result.input.sourcePage
      || result.decision.explanationStatus !== "exact" || !terminalAnswer
      || result.input.baseContextTo > result.sliceTo ? [key] : [];
  }));
  for (const key of persistedHistory.byKey.keys()) {
    if (acceptedKeySet.has(key)) expectedRepairKeys.add(key);
  }
  const declaredRepairs = new Map<string, Record<string, unknown>>();
  for (const value of audit.solutionRepairs) {
    const repair = object(value, "solution repair evidence");
    const key = exactString(repair.key, "solution repair.key");
    if (declaredRepairs.has(key)) throw new Error(`duplicate declared solution repair ${key}`);
    declaredRepairs.set(key, repair);
  }
  if (declaredRepairs.size !== expectedRepairKeys.size
    || [...declaredRepairs].some(([key]) => !expectedRepairKeys.has(key))) {
    throw new Error("declared solution repair keys do not exactly match non-terminal fidelity keys");
  }

  const firstRepairs = new Map<string, VerifiedFirstSolutionRepair>();
  const firstRepairSolutions = new Map(baseSolutions);
  for (const key of expectedRepairKeys) {
    const result = baseResults.get(key)!;
    const first = verifyFirstSolutionRepair(
      stateDir,
      entry,
      solutionEvidence,
      effectiveProblemCorpusHash,
      result.input,
      result.solution,
      result.artifact,
      declaredRepairs.get(key)!,
      persistedHistory.currentByKey.get(key),
    );
    firstRepairs.set(key, first);
    firstRepairSolutions.set(result.input.printedNumber, first.solution);
  }
  const stagedFidelityRevisions = new Map<string, ReturnType<typeof verifySolutionRevision>>();
  const semanticStageSolutions = new Map(firstRepairSolutions);
  for (const [key, repair] of declaredRepairs) {
    if (repair.revision === undefined) continue;
    const revision = object(repair.revision, `${key}.revision`);
    const trigger = object(revision.trigger, `${key}.revision.trigger`);
    if (trigger.kind === "semantic") continue;
    if (trigger.kind !== "fidelity" && trigger.kind !== "persisted"
      && trigger.kind !== "prompt-upgrade") {
      throw new Error(`${key}: solution revision trigger kind is invalid`);
    }
    const result = baseResults.get(key)!;
    const revised = verifySolutionRevision(
      repair.revision,
      stateDir,
      entry,
      problemEvidence,
      solutionEvidence,
      rulesDigest,
      effectiveProblemCorpusHash,
      result.input,
      result.solution,
      firstRepairs.get(key)!,
      effective.records.get(key)!,
      null,
      contract,
      persistedHistory.currentByKey.get(key),
    );
    stagedFidelityRevisions.set(key, revised);
    semanticStageSolutions.set(result.input.printedNumber, revised.solution);
  }
  const semanticStageSolutionCorpus = acceptedRecords.map((record) => ({
    key: record.question.key,
    solution: semanticStageSolutions.get(record.question.printedNumber)!.evidence,
  })).sort((left, right) => compareCorpusQuestionKeys(left.key, right.key));
  const semanticStageSolutionCorpusHash = canonicalEvidenceHash(semanticStageSolutionCorpus);
  const hasSemanticRevision = [...declaredRepairs.values()].some((repair) => {
    if (repair.revision === undefined) return false;
    return object(object(repair.revision, "solution revision").trigger, "solution revision trigger").kind === "semantic";
  });
  const semanticContext: RevisionSemanticContext | null = hasSemanticRevision ? {
    effectiveSolutionCorpusHash: semanticStageSolutionCorpusHash,
    solutionRevisionApplied: stagedFidelityRevisions.size > 0,
    inputs: acceptedRecords.flatMap((record) => {
      if (record.question.qtype !== "mcq") return [];
      const solution = semanticStageSolutions.get(record.question.printedNumber)!;
      const resolution = resolveOfficialAnswerForDb(record.question, solution.rawAnswer);
      return resolution.mode === "choice-marker" ? [{
        key: record.question.key,
        choices: record.question.choices!,
        detailedExplanation: semanticExplanationWithoutMarkers(solution.explanation),
      }] : [];
    }),
  } : null;

  const effectiveSolutions = new Map(baseSolutions);
  const terminalItems = new Map<string, Record<string, unknown>>();
  const expectedRepairs: Record<string, unknown>[] = [];
  for (const [key, result] of baseResults) {
    const { input, solution: baseSolution, decision, artifact } = result;
    if (!expectedRepairKeys.has(key)) {
      terminalItems.set(key, {
        key,
        printedNumber: input.printedNumber,
        qtype: input.qtype,
        basePage: input.sourcePage,
        effectivePage: input.sourcePage,
        answerStatus: decision.answerStatus,
        explanationStatus: decision.explanationStatus,
        evidence: decision.evidence,
        fidelityArtifact: artifact,
        baseSolutionItemHash: input.baseSolutionItemHash,
        effectiveSolutionItemHash: input.baseSolutionItemHash,
        baseRawAnswerHash: sha256(input.rawAnswer),
        effectiveRawAnswerHash: sha256(input.rawAnswer),
        baseExplanationHash: sha256(input.explanation),
        effectiveExplanationHash: sha256(input.explanation),
      });
      continue;
    }

    const repair = declaredRepairs.get(key)!;
    const first = firstRepairs.get(key)!;
    let terminal = {
      solution: first.solution,
      decision: first.decision,
      fidelityArtifact: first.fidelityArtifact,
    };
    let expectedRepair: Record<string, unknown> = first.evidence;
    if (repair.revision === undefined) {
      if (persistedHistory.requiredRevisionKeys.has(key)) {
        throw new Error(`${key}: sticky solution revision authority is omitted from the current audit`);
      }
      if (!isTerminalSolutionDecision(input, first.solution, first.decision)) {
        throw new Error(`${key}: non-terminal first solution repair has no attested revision`);
      }
    } else {
      const revised = stagedFidelityRevisions.get(key) ?? verifySolutionRevision(
          repair.revision,
          stateDir,
          entry,
          problemEvidence,
          solutionEvidence,
          rulesDigest,
          effectiveProblemCorpusHash,
          input,
          baseSolution,
          first,
          effective.records.get(key)!,
          semanticContext,
          contract,
          persistedHistory.currentByKey.get(key),
        );
      terminal = revised;
      expectedRepair = { ...first.evidence, revision: revised.evidence };
    }
    if (!isDeepStrictEqual(repair, expectedRepair)) {
      throw new Error(`${key}: solution repair evidence envelope does not match its exact chain`);
    }
    expectedRepairs.push(expectedRepair);
    effectiveSolutions.set(input.printedNumber, terminal.solution);
    terminalItems.set(key, {
      key,
      printedNumber: input.printedNumber,
      qtype: input.qtype,
      basePage: input.sourcePage,
      effectivePage: terminal.solution.page,
      answerStatus: terminal.decision.answerStatus,
      explanationStatus: terminal.decision.explanationStatus,
      evidence: terminal.decision.evidence,
      fidelityArtifact: terminal.fidelityArtifact,
      baseSolutionItemHash: input.baseSolutionItemHash,
      effectiveSolutionItemHash: canonicalEvidenceHash(terminal.solution.evidence),
      baseRawAnswerHash: sha256(input.rawAnswer),
      effectiveRawAnswerHash: sha256(terminal.solution.rawAnswer),
      baseExplanationHash: sha256(input.explanation),
      effectiveExplanationHash: sha256(terminal.solution.explanation),
    });
  }
  const items = [...terminalItems.values()].sort((left, right) =>
    compareCorpusQuestionKeys(String(left.key), String(right.key)));
  expectedRepairs.sort((left, right) => compareCorpusQuestionKeys(String(left.key), String(right.key)));
  if (items.length !== accepted.length || !isDeepStrictEqual(audit.solutionFidelityItems, items)
    || !isDeepStrictEqual(audit.solutionRepairs, expectedRepairs)) {
    throw new Error("answer audit terminal solution fidelity items/repairs are not exact");
  }
  const effectiveSolutionCorpus = acceptedRecords.map((record) => ({
    key: record.question.key,
    solution: effectiveSolutions.get(record.question.printedNumber)!.evidence,
  })).sort((left, right) => compareCorpusQuestionKeys(left.key, right.key));
  return {
    solutions: effectiveSolutions,
    checkpoints: expectedCheckpoints,
    items,
    repairs: expectedRepairs,
    acceptedSolutionKeys,
    solutionRepairKeys: expectedRepairs.map((repair) => String(repair.key)).sort(compareCorpusQuestionKeys),
    derivedAnswerKeys: items.filter((item) => item.answerStatus === "not_visible")
      .map((item) => String(item.key)).sort(compareCorpusQuestionKeys),
    effectiveSolutionCorpusHash: canonicalEvidenceHash(effectiveSolutionCorpus),
  };
}

type SemanticDecision = {
  key: string;
  status: "resolved" | "ambiguous";
  choiceIndex: number | null;
  evidence: string;
};

function verifySemanticCheckpoint(
  value: unknown,
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  solutionEvidence: DownloadEvidence,
  rulesDigest: string,
  effectiveCorpusHash: string,
  effectiveSolutionCorpusHash: string,
  inputs: Array<{ key: string; choices: string[]; detailedExplanation: string }>,
  solutionRevisionApplied = false,
  contract: VerificationContract,
): Map<string, SemanticDecision> {
  const inputHash = canonicalEvidenceHash(inputs);
  if (value === null) {
    if (inputs.length > 0) throw new Error("marker-only MCQs have no semantic checkpoint");
    return new Map();
  }
  const envelope = object(value, "answer audit semanticCheckpoint");
  const currentSemantic = contract.semanticChoiceVersion === SEMANTIC_CHOICE_VERSION;
  const expectedEnvelopeFields = currentSemantic
    ? "effectiveCorpusHash,effectiveSolutionCorpusHash,inputHash,path,sha256"
    : "effectiveSolutionCorpusHash,inputHash,path,sha256";
  if (Object.keys(envelope).sort().join(",") !== expectedEnvelopeFields) {
    throw new Error("semanticCheckpoint has unexpected fields");
  }
  if (envelope.inputHash !== inputHash) throw new Error("semanticCheckpoint input hash does not match marker inputs");
  if (currentSemantic && envelope.effectiveCorpusHash !== effectiveCorpusHash) {
    throw new Error("semanticCheckpoint effective problem corpus hash is stale");
  }
  if (envelope.effectiveSolutionCorpusHash !== effectiveSolutionCorpusHash) {
    throw new Error("semanticCheckpoint effective solution corpus hash is stale");
  }
  const pointer = evidencePointer({ path: envelope.path, sha256: envelope.sha256 }, "semanticCheckpoint");
  const expectedPath = currentSemantic || solutionRevisionApplied
    ? `semantic-choice-checks/v${contract.semanticChoiceVersion}-${effectiveCorpusHash}-` +
      `${effectiveSolutionCorpusHash}-${inputHash}.json`
    : `semantic-choice-checks/v${contract.semanticChoiceVersion}-${inputHash}.json`;
  if (pointer.path !== expectedPath) {
    throw new Error("semantic checkpoint path does not match input hash");
  }
  const checkpoint = readBoundEvidence(stateDir, pointer, "semantic choice checkpoint");
  if (!Array.isArray(checkpoint.items)) throw new Error("semantic choice checkpoint items must be an array");
  const expectedInputs = new Map(inputs.map((input) => [input.key, input]));
  const decisions = new Map<string, SemanticDecision>();
  const items = checkpoint.items.map((raw, index) => {
    const row = object(raw, `semantic choice items[${index}]`);
    const key = exactString(row.key, `semantic choice items[${index}].key`);
    const input = expectedInputs.get(key);
    if (!input || decisions.has(key)) throw new Error(`semantic choice key is missing/extra/duplicate: ${key}`);
    const status = row.status;
    if (status !== "resolved" && status !== "ambiguous") throw new Error(`${key}: invalid semantic status`);
    const choiceIndex = row.choiceIndex === null ? null : integer(row.choiceIndex, `${key}.choiceIndex`, 1);
    if (status === "resolved"
      ? choiceIndex === null || choiceIndex > input.choices.length
      : choiceIndex !== null) {
      throw new Error(`${key}: invalid semantic choice index`);
    }
    const decision = {
      key,
      status,
      choiceIndex,
      evidence: exactString(row.evidence, `${key}.semantic evidence`),
    } as SemanticDecision;
    decisions.set(key, decision);
    return decision;
  });
  if (decisions.size !== inputs.length) throw new Error("semantic choice checkpoint omits marker inputs");
  const expectedCheckpoint = {
    version: contract.semanticChoiceVersion,
    entryId: entry.id,
    problemHash: problemEvidence.sha256,
    solutionHash: solutionEvidence.sha256,
    classifierVersion: contract.classifierVersion,
    rulesDigest,
    transcriptionGateVersion: contract.transcriptionGateVersion,
    transcriptionPromptDigest: contract.transcriptionPromptDigest,
    effectiveCorpusHash,
    effectiveSolutionCorpusHash,
    inputHash,
    promptDigest: contract.semanticPromptDigest,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    inputs,
    items,
  };
  if (!isDeepStrictEqual(checkpoint, expectedCheckpoint)) {
    throw new Error("semantic choice checkpoint metadata/input/output is stale or incomplete");
  }
  return decisions;
}

function hasPersistedSolutionGenerationSignal(stateDir: string): boolean {
  for (const directory of ["solution-revision-upgrades", "solution-fidelity-revision-upgrades"]) {
    const absolute = join(stateDir, directory);
    if (existsSync(absolute) && readdirSync(absolute, { withFileTypes: true }).some((entry) =>
      !(entry.isFile() && entry.name.endsWith(".tmp")))) return true;
  }
  for (const [directory, pattern, kind] of [
    ["solution-repairs", /^v1-\d{4}-\d{4}-[a-f0-9]{64}\.json$/u, "repair"],
    ["solution-revisions", /^v1-\d{4}-\d{4}-[a-f0-9]{64}\.json$/u, "revision"],
  ] as const) {
    const absolute = join(stateDir, directory);
    if (!existsSync(absolute)) continue;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !pattern.test(entry.name)) continue;
      try {
        const checkpoint = object(json(join(absolute, entry.name)), `${directory}/${entry.name}`);
        if (kind === "repair" ? checkpoint.persistedSeed !== undefined
          : checkpoint.trigger !== undefined
            && object(checkpoint.trigger, `${directory}/${entry.name}.trigger`).kind === "persisted") {
          return true;
        }
      } catch {
        // The strict history scan reports malformed evidence; it is not sufficient to claim a current signal.
      }
    }
  }
  return false;
}

type VerifiedAnswerAudit = { decisions: DecisionSummary; solutions: Map<string, OfficialSolution> };

function selectVerificationContract(
  stateDir: string,
  receipt: Record<string, unknown> | null,
  result: Record<string, unknown> | null,
): VerificationContract {
  if (result?.version === 5) return CURRENT_CONTRACT;
  const scopeAdjudicationDirectory = join(stateDir, "classification-scope-adjudications");
  const scopeAdjudicationSignal = existsSync(scopeAdjudicationDirectory)
    && readdirSync(scopeAdjudicationDirectory, { withFileTypes: true }).some((entry) =>
      !(entry.isFile() && entry.name.endsWith(".tmp")));
  const repairScopeAdjudicationDirectory = join(stateDir, "classification-repair-scope-adjudications");
  const repairScopeAdjudicationSignal = existsSync(repairScopeAdjudicationDirectory)
    && readdirSync(repairScopeAdjudicationDirectory, { withFileTypes: true }).some((entry) =>
      !(entry.isFile() && entry.name.endsWith(".tmp")));
  const manualAdjudicationSignal = [
    "problem-manual-evidence",
    "problem-manual-adjudications",
    "classification-manual-adjudications",
  ].some((directory) => {
    const absolute = join(stateDir, directory);
    return existsSync(absolute) && readdirSync(absolute, { withFileTypes: true }).some((entry) =>
      !(entry.isFile() && entry.name.endsWith(".tmp")));
  });
  const v5GenerationSignal = (
    listJson(join(stateDir, "semantic-choice-checks"), /^v5-.*\.json$/u).length > 0
    || listJson(join(stateDir, "answer-audit"), /^v5-.*\.json$/u).length > 0
    || listJson(join(stateDir, "answer-attestation"), /^v5-.*\.json$/u).length > 0
    || scopeAdjudicationSignal
    || repairScopeAdjudicationSignal
    || manualAdjudicationSignal
    || hasPersistedSolutionGenerationSignal(stateDir)
  );
  if (v5GenerationSignal) return CURRENT_CONTRACT;
  if (result?.version === 4) return V4_CONTRACT;
  const v4GenerationSignal = (
    listJson(join(stateDir, "problem-terminal-fidelity"), /^v2-.*\.json$/u).length > 0
    || listJson(join(stateDir, "problem-recoveries"), /\.json$/u).length > 0
    || listJson(join(stateDir, "classification-recoveries"), /\.json$/u).length > 0
    || listJson(join(stateDir, "answer-audit"), /^v4-.*\.json$/u).length > 0
    || listJson(join(stateDir, "answer-attestation"), /^v4-.*\.json$/u).length > 0
  );
  if (v4GenerationSignal) return V4_CONTRACT;
  if (result?.version === 3) return V3_CONTRACT;
  const v3GenerationSignal = (
    listJson(join(stateDir, "classification-chunks"), /^v5-\d{4}-[a-f0-9]{16}\.json$/u).length > 0
    || listJson(join(stateDir, "problem-repair-batches"), /^v[12]-.*\.json$/u).length > 0
    || listJson(join(stateDir, "classification-repair-batches"), /^v1-.*\.json$/u).length > 0
    || listJson(join(stateDir, "problem-revision-batches"), /^v1-.*\.json$/u).length > 0
    || listJson(join(stateDir, "classification-revision-batches"), /^v1-.*\.json$/u).length > 0
    || listJson(join(stateDir, "problem-terminal-fidelity"), /^v1-.*\.json$/u).length > 0
    || listJson(join(stateDir, "answer-audit"), /^v3-[a-f0-9]{64}\.json$/u).length > 0
    || listJson(join(stateDir, "answer-attestation"), /^v3-[a-f0-9]{64}\.json$/u).length > 0
  );
  if (v3GenerationSignal) return V3_CONTRACT;
  if (!receipt) return LEGACY_CONTRACT;
  return LEGACY_CONTRACT;
}

function verifyAnswerAudit(
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  solutionEvidence: DownloadEvidence,
  base: DecisionSummary,
  solutions: Map<string, OfficialSolution>,
  terminal: Record<string, unknown>,
  contract: VerificationContract,
  add: AddFailure,
): VerifiedAnswerAudit {
  const rulesDigest = base.rulesDigest;
  if (!rulesDigest) {
    add({ code: "ANSWER_AUDIT_INVALID", entryId: entry.id, message: "selected classification rules digest is missing" });
    return { decisions: base, solutions };
  }
  const receiptHash = canonicalEvidenceHash(terminal);
  try {
    const receiptPath = confinedEvidencePath(
      stateDir,
      { path: "receipt.json", sha256: receiptHash },
      "committed receipt",
    );
    if (hashFile(receiptPath) !== receiptHash) throw new Error("receipt file is not canonical immutable JSON");
  } catch (error) {
    add({
      code: "ANSWER_ATTESTATION_INVALID",
      entryId: entry.id,
      message: error instanceof Error ? error.message : String(error),
    });
    return { decisions: base, solutions };
  }
  const attestationDir = join(stateDir, "answer-attestation");
  const names = listJson(
    attestationDir,
    new RegExp(`^v${contract.attestationVersion}-[a-f0-9]{64}\\.json$`, "u"),
  );
  const candidates: Array<{ name: string; path: string; value: Record<string, unknown> }> = [];
  for (const name of names) {
    try {
      const path = confinedEvidencePath(
        stateDir,
        { path: `answer-attestation/${name}`, sha256: "0".repeat(64) },
        name,
      );
      const value = object(json(path), name);
      const receipt = object(value.receipt, `${name}.receipt`);
      const looksCurrent = value.entryId === entry.id
        && value.problemHash === problemEvidence.sha256
        && value.solutionHash === solutionEvidence.sha256
        && value.classifierVersion === contract.classifierVersion
        && value.rulesDigest === rulesDigest
        && value.transcriptionGateVersion === contract.transcriptionGateVersion
        && value.transcriptionPromptDigest === contract.transcriptionPromptDigest
        && value.solutionFidelityVersion === SOLUTION_FIDELITY_VERSION
        && value.solutionFidelityPromptDigest === SOLUTION_FIDELITY_PROMPT_DIGEST
        && (contract.problemTerminalFidelityVersion === null || (
          value.problemTerminalFidelityVersion === contract.problemTerminalFidelityVersion
          && (contract.problemTerminalScopePromptDigest === null
            || value.problemTerminalScopePromptDigest === contract.problemTerminalScopePromptDigest)
        ))
        && receipt.path === "receipt.json"
        && receipt.sha256 === receiptHash;
      if (looksCurrent) candidates.push({ name, path, value });
    } catch (error) {
      add({ code: "ANSWER_ATTESTATION_INVALID", entryId: entry.id, message: `${name}: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  if (candidates.length !== 1) {
    add({
      code: candidates.length === 0 ? "ANSWER_ATTESTATION_MISSING" : "ANSWER_ATTESTATION_AMBIGUOUS",
      entryId: entry.id,
      message: `expected one current post-commit answer attestation, found ${candidates.length}`,
    });
    return { decisions: base, solutions };
  }

  try {
    const { name, path: attestationPath, value: attestation } = candidates[0];
    const attestationDigest = exactString(attestation.attestationDigest, "answer attestation.digest");
    if (attestation.version !== contract.attestationVersion
      || name !== `v${contract.attestationVersion}-${attestationDigest}.json`
      || !/^[a-f0-9]{64}$/u.test(attestationDigest)) {
      throw new Error("answer attestation version/name/digest is invalid");
    }
    const { version: _attestationVersion, attestationDigest: _attestationDigest, ...attestationBasis } = attestation;
    if (canonicalEvidenceHash(attestationBasis) !== attestationDigest
      || hashFile(attestationPath) !== canonicalEvidenceHash(attestation)) {
      throw new Error("answer attestation canonical digest or file hash is invalid");
    }
    const receiptPointer = evidencePointer(attestation.receipt, "answer attestation receipt");
    if (receiptPointer.path !== "receipt.json" || receiptPointer.sha256 !== receiptHash) {
      throw new Error("answer attestation does not bind the committed canonical receipt");
    }
    const auditEnvelope = object(attestation.answerAudit, "answer attestation audit");
    if (Object.keys(auditEnvelope).sort().join(",")
      !== "effectiveCorpusHash,effectiveSolutionCorpusHash,path,sha256") {
      throw new Error("answer attestation audit pointer has unexpected fields");
    }
    const auditPointer = evidencePointer(
      { path: auditEnvelope.path, sha256: auditEnvelope.sha256 },
      "answer attestation audit",
    );
    const auditPathMatch = new RegExp(
      `^answer-audit/v${contract.auditVersion}-([a-f0-9]{64})\\.json$`,
      "u",
    ).exec(auditPointer.path);
    if (!auditPathMatch || !/^[a-f0-9]{64}$/u.test(String(auditEnvelope.effectiveCorpusHash))
      || !/^[a-f0-9]{64}$/u.test(String(auditEnvelope.effectiveSolutionCorpusHash))) {
      throw new Error("answer attestation audit path/effective corpus hash is invalid");
    }
    const audit = readBoundEvidence(stateDir, auditPointer, "attested answer audit");
    const auditDigest = exactString(audit.auditDigest, "answer audit.digest");
    if (audit.version !== contract.auditVersion || auditPathMatch[1] !== auditDigest
      || !/^[a-f0-9]{64}$/u.test(auditDigest)) {
      throw new Error("answer audit version/name/digest is invalid");
    }
    const { version: _version, auditDigest: _auditDigest, ...auditBasis } = audit;
    if (canonicalEvidenceHash(auditBasis) !== auditDigest) {
      throw new Error("answer audit canonical digest or file hash is invalid");
    }
    if (!Array.isArray(audit.repairs) || !Array.isArray(audit.solutionFidelityCheckpoints)
      || !Array.isArray(audit.solutionFidelityItems) || !Array.isArray(audit.solutionRepairs)
      || contract.problemTerminalFidelityVersion !== null && (!Array.isArray(audit.problemTerminalFidelityCheckpoints)
        || !Array.isArray(audit.problemTerminalFidelityItems))) {
      throw new Error("answer audit repair/fidelity arrays are missing");
    }
    if (auditEnvelope.effectiveCorpusHash !== audit.effectiveCorpusHash
      || auditEnvelope.effectiveSolutionCorpusHash !== audit.effectiveSolutionCorpusHash) {
      throw new Error("answer attestation effective corpus hashes do not match its audit");
    }
    const expectedAttestationBasis = {
      entryId: entry.id,
      problemHash: problemEvidence.sha256,
      solutionHash: solutionEvidence.sha256,
      classifierVersion: contract.classifierVersion,
      rulesDigest,
      transcriptionGateVersion: contract.transcriptionGateVersion,
      transcriptionPromptDigest: contract.transcriptionPromptDigest,
      solutionFidelityVersion: SOLUTION_FIDELITY_VERSION,
      solutionFidelityPromptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
      ...(contract.problemTerminalFidelityVersion === null ? {} : {
        problemTerminalFidelityVersion: contract.problemTerminalFidelityVersion,
        ...(contract.problemTerminalScopePromptDigest === null ? {} : {
          problemTerminalScopePromptDigest: contract.problemTerminalScopePromptDigest,
        }),
      }),
      receipt: receiptPointer,
      answerAudit: {
        ...auditPointer,
        effectiveCorpusHash: auditEnvelope.effectiveCorpusHash,
        effectiveSolutionCorpusHash: auditEnvelope.effectiveSolutionCorpusHash,
      },
      repairs: audit.repairs,
      solutionFidelityCheckpoints: audit.solutionFidelityCheckpoints,
      solutionFidelityItems: audit.solutionFidelityItems,
      solutionRepairs: audit.solutionRepairs,
      ...(contract.problemTerminalFidelityVersion !== null ? {
        problemTerminalFidelityCheckpoints: audit.problemTerminalFidelityCheckpoints,
        problemTerminalFidelityItems: audit.problemTerminalFidelityItems,
      } : {}),
    };
    if (!isDeepStrictEqual(attestationBasis, expectedAttestationBasis)) {
      throw new Error("answer attestation does not exactly bind receipt/audit/repairs");
    }
    const evidenceCache: EvidenceCache = new Map();
    const records = contract.auditVersion >= 3
      ? applyDeclaredRepairsV3(
          audit.repairs,
          stateDir,
          entry,
          problemEvidence,
          solutionEvidence,
          rulesDigest,
          base,
          solutions,
          evidenceCache,
          contract,
        )
      : (() => {
          const legacy = new Map(base.records);
          const repairedKeys = new Set<string>();
          for (const rawRepair of audit.repairs) {
            const repair = object(rawRepair, "answer audit repair");
            const key = exactString(repair.key, "answer audit repair.key");
            if (repairedKeys.has(key)) throw new Error(`duplicate declared repair: ${key}`);
            const baseRecord = base.records.get(key);
            const solution = baseRecord && solutions.get(baseRecord.question.printedNumber);
            if (!baseRecord || !solution) throw new Error(`repair has no base problem/solution: ${key}`);
            legacy.set(key, applyDeclaredRepair(
              repair,
              stateDir,
              entry,
              problemEvidence,
              rulesDigest,
              baseRecord,
              solution,
              contract,
            ));
            repairedKeys.add(key);
          }
          return legacy;
        })();
    const effective = summarizeDecisions(records, base.order, rulesDigest);
    if (effective.order.length !== base.order.length || effective.records.size !== base.records.size
      || effective.order.some((key) => !base.records.has(key))) {
      throw new Error("repair changed the immutable base key set");
    }
    const effectiveCorpus = effective.order.map((key) => {
      const record = effective.records.get(key)!;
      return { question: record.question.evidence, classification: record.classification };
    });
    const effectiveCorpusHash = canonicalEvidenceHash(effectiveCorpus);
    const nonExact = effective.order.filter((key) =>
      effective.records.get(key)!.classification.transcription_status !== "exact");
    if (contract.problemTerminalFidelityVersion === null && nonExact.length > 0) {
      throw new Error(`terminal corpus has non-exact source transcriptions: ${nonExact.join(", ")}`);
    }
    if (auditEnvelope.effectiveCorpusHash !== effectiveCorpusHash) {
      throw new Error(
        `attested effective corpus hash ${auditEnvelope.effectiveCorpusHash} does not match ` +
        `reconstructed corpus ${effectiveCorpusHash}`,
      );
    }
    const repairKeys = new Set(audit.repairs.map((value, index) =>
      exactString(object(value, `answer audit repairs[${index}]`).key, `answer audit repairs[${index}].key`)));
    const problemTerminalFidelity = contract.problemTerminalFidelityVersion !== null
      ? verifyProblemTerminalFidelity(
          stateDir,
          entry,
          problemEvidence,
          effective,
          audit,
          evidenceCache,
          repairKeys,
          contract,
        )
      : null;
    const solutionFidelity = verifySolutionFidelity(
      stateDir,
      entry,
      problemEvidence,
      solutionEvidence,
      rulesDigest,
      effective,
      solutions,
      audit,
      contract,
    );
    if (auditEnvelope.effectiveSolutionCorpusHash !== solutionFidelity.effectiveSolutionCorpusHash) {
      throw new Error("attested effective solution corpus hash does not match reconstructed overlay");
    }
    const effectiveSolutions = solutionFidelity.solutions;
    const acceptedRecords = effective.order.map((key) => effective.records.get(key)!)
      .filter((record) => record.classification.decision === "accept");
    const acceptedMcq = acceptedRecords.filter((record) => record.question.qtype === "mcq");
    const markerInputs: Array<{ key: string; choices: string[]; detailedExplanation: string }> = [];
    const resolutions = new Map<string, OfficialAnswerResolution>();
    for (const record of acceptedMcq) {
      const solution = effectiveSolutions.get(record.question.printedNumber);
      if (!solution) throw new Error(`${record.question.key}: official solution is missing`);
      const resolution = resolveOfficialAnswerForDb(record.question, solution.rawAnswer);
      if (resolution.choiceIndex === null) throw new Error(`${record.question.key}: MCQ has no resolved choice index`);
      resolutions.set(record.question.key, resolution);
      if (resolution.mode === "choice-marker") {
        markerInputs.push({
          key: record.question.key,
          choices: record.question.choices!,
          detailedExplanation: semanticExplanationWithoutMarkers(solution.explanation),
        });
      }
    }
    const semanticByKey = verifySemanticCheckpoint(
      audit.semanticCheckpoint,
      stateDir,
      entry,
      problemEvidence,
      solutionEvidence,
      rulesDigest,
      effectiveCorpusHash,
      solutionFidelity.effectiveSolutionCorpusHash,
      markerInputs,
      solutionFidelity.repairs.some((repair) => repair.revision !== undefined),
      contract,
    );
    const terminalFidelityByKey = new Map(solutionFidelity.items.map((item) => [String(item.key), item]));
    for (const record of acceptedRecords) {
      const fidelity = terminalFidelityByKey.get(record.question.key);
      if (!fidelity || fidelity.explanationStatus !== "exact") {
        throw new Error(`${record.question.key}: accepted solution lacks exact explanation fidelity`);
      }
      if (fidelity.answerStatus === "exact") continue;
      const resolution = resolutions.get(record.question.key);
      const semantic = semanticByKey.get(record.question.key);
      if (fidelity.answerStatus !== "not_visible" || record.question.qtype !== "mcq"
        || resolution?.mode !== "choice-marker" || semantic?.status !== "resolved"
        || semantic.choiceIndex !== resolution.choiceIndex! + 1) {
        throw new Error(`${record.question.key}: not_visible answer lacks final marker semantic authority`);
      }
    }
    const auditItems = acceptedMcq.map((record) => {
      const solution = effectiveSolutions.get(record.question.printedNumber)!;
      const resolution = resolutions.get(record.question.key)!;
      const semantic = semanticByKey.get(record.question.key) ?? null;
      if (resolution.mode === "choice-marker" && (
        semantic?.status !== "resolved" || semantic.choiceIndex !== resolution.choiceIndex! + 1
      )) throw new Error(`${record.question.key}: marker-only answer lacks matching semantic proof`);
      return {
        key: record.question.key,
        printedNumber: record.question.printedNumber,
        sourcePage: record.question.page,
        officialRawAnswerHash: sha256(solution.rawAnswer),
        storedAnswerHash: sha256(resolution.storedAnswer),
        mode: resolution.mode,
        choiceIndex: resolution.choiceIndex! + 1,
        semantic: semantic && {
          status: semantic.status,
          choiceIndex: semantic.choiceIndex,
          evidence: semantic.evidence,
        },
      };
    }).sort((left, right) => compareCorpusQuestionKeys(left.key, right.key));
    const targetQuestionCounts = Object.fromEntries(TARGET_SUBJECTS.flatMap((target) => {
      const count = acceptedRecords.filter((record) =>
        TARGET_BY_CANONICAL[record.classification.canonical_subject!] === target).length;
      return count === 0 ? [] : [[target, count]];
    }));
    const semanticEnvelope = audit.semanticCheckpoint === null ? null : object(audit.semanticCheckpoint, "semanticCheckpoint");
    const expectedBasis = {
      entryId: entry.id,
      problemHash: problemEvidence.sha256,
      solutionHash: solutionEvidence.sha256,
      classifierVersion: contract.classifierVersion,
      rulesDigest,
      transcriptionGateVersion: contract.transcriptionGateVersion,
      transcriptionPromptDigest: contract.transcriptionPromptDigest,
      solutionFidelityVersion: SOLUTION_FIDELITY_VERSION,
      solutionFidelityPromptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
      ...(contract.problemTerminalFidelityVersion === null ? {} : {
        problemTerminalFidelityVersion: contract.problemTerminalFidelityVersion,
        ...(contract.problemTerminalScopePromptDigest === null ? {} : {
          problemTerminalScopePromptDigest: contract.problemTerminalScopePromptDigest,
        }),
      }),
      semanticChoiceVersion: contract.semanticChoiceVersion,
      semanticPromptDigest: contract.semanticPromptDigest,
      sourceQuestionCount: effective.problems.size,
      acceptedQuestionCount: effective.accepted.length,
      rejectedQuestionCount: effective.rejected,
      reviewQuestionCount: effective.reviews,
      targetQuestionCounts,
      acceptedSolutionKeys: solutionFidelity.acceptedSolutionKeys,
      solutionRepairKeys: solutionFidelity.solutionRepairKeys,
      derivedAnswerKeys: solutionFidelity.derivedAnswerKeys,
      acceptedMcqKeys: auditItems.map((item) => item.key).sort(compareCorpusQuestionKeys),
      effectiveCorpusHash,
      effectiveSolutionCorpusHash: solutionFidelity.effectiveSolutionCorpusHash,
      solutionFidelityCheckpoints: solutionFidelity.checkpoints,
      solutionFidelityItems: solutionFidelity.items,
      solutionRepairs: solutionFidelity.repairs,
      ...(problemTerminalFidelity ? {
        problemTerminalFidelityCheckpoints: problemTerminalFidelity.checkpoints,
        problemTerminalFidelityItems: problemTerminalFidelity.items,
      } : {}),
      semanticCheckpoint: semanticEnvelope,
      repairs: [...audit.repairs].sort((left, right) => compareCorpusQuestionKeys(
        exactString(object(left, "repair").key, "repair.key"),
        exactString(object(right, "repair").key, "repair.key"),
      )),
      items: auditItems,
    };
    if (!isDeepStrictEqual(auditBasis, expectedBasis)) {
      const mismatches = Object.keys(expectedBasis).filter((key) => !isDeepStrictEqual(
        auditBasis[key],
        expectedBasis[key as keyof typeof expectedBasis],
      ));
      throw new Error(
        `answer audit metadata/counts/items do not match the effective corpus: ${mismatches.join(", ")}`,
      );
    }
    if (terminal.sourceQuestionCount !== effective.problems.size
      || terminal.acceptedQuestionCount !== effective.accepted.length
      || terminal.rejectedQuestionCount !== effective.rejected
      || terminal.reviewQuestionCount !== effective.reviews) {
      throw new Error("terminal receipt/result counts do not match answer audit effective corpus");
    }
    return { decisions: effective, solutions: effectiveSolutions };
  } catch (error) {
    add({
      code: error instanceof CorpusValidationError ? error.code : "ANSWER_AUDIT_INVALID",
      entryId: entry.id,
      message: error instanceof Error ? error.message : String(error),
    });
    return { decisions: base, solutions };
  }
}

function verifyFilteredAnswerAudit(
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  solutionEvidence: DownloadEvidence,
  base: DecisionSummary,
  solutions: Map<string, OfficialSolution>,
  result: Record<string, unknown>,
  contract: VerificationContract,
  add: AddFailure,
): DecisionSummary {
  const nonExactBase = base.order.filter((key) =>
    base.records.get(key)!.classification.transcription_status !== "exact");
  if (result.answerAudit === undefined) {
    try {
      const rulesDigest = base.rulesDigest;
      if (!rulesDigest) throw new Error("selected classification rules digest is missing");
      const effectiveCorpusHash = canonicalEvidenceHash(base.order.map((key) => {
        const record = base.records.get(key)!;
        return { question: record.question.evidence, classification: record.classification };
      }));
      verifyPersistedSolutionHistory(
        stateDir,
        entry,
        problemEvidence,
        solutionEvidence,
        rulesDigest,
        base,
        solutions,
        effectiveCorpusHash,
        contract,
      );
    } catch (error) {
      add({
        code: error instanceof CorpusValidationError ? error.code : "ANSWER_AUDIT_INVALID",
        entryId: entry.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (contract.problemTerminalFidelityVersion !== null || nonExactBase.length > 0) {
      add({
        code: "TRANSCRIPTION_GATE",
        entryId: entry.id,
        message: contract.problemTerminalFidelityVersion !== null
          ? `current filtered result has no terminal v${contract.auditVersion} answer audit`
          : `filtered result has unverified source transcriptions: ${nonExactBase.join(", ")}`,
      });
    }
    return base;
  }
  try {
    const rulesDigest = base.rulesDigest;
    if (!rulesDigest) throw new Error("selected classification rules digest is missing");
    const problemNumbers = new Set([...base.problems.values()].map((question) => question.printedNumber));
    if (solutions.size !== problemNumbers.size || [...problemNumbers].some((number) => !solutions.has(number))
      || [...solutions].some(([number]) => !problemNumbers.has(number))) {
      throw new Error("filtered repair audit problem/solution number sets differ");
    }
    const pointer = evidencePointer(result.answerAudit, "filtered result answerAudit");
    const pathMatch = (contract.auditVersion >= 3
      ? new RegExp(`^answer-audit/v(${contract.auditVersion})-([a-f0-9]{64})\\.json$`, "u")
      : /^answer-audit\/v([12])-([a-f0-9]{64})\.json$/u).exec(pointer.path);
    if (!pathMatch) throw new Error("filtered answer audit path is invalid");
    const version = Number(pathMatch[1]);
    const audit = readBoundEvidence(stateDir, pointer, "filtered answer audit");
    const auditDigest = exactString(audit.auditDigest, "filtered answer audit.digest");
    if (audit.version !== version || pathMatch[2] !== auditDigest) {
      throw new Error("filtered answer audit version/name/digest is invalid");
    }
    const { version: _version, auditDigest: _digest, ...auditBasis } = audit;
    if (canonicalEvidenceHash(auditBasis) !== auditDigest || !Array.isArray(audit.repairs)) {
      throw new Error("filtered answer audit canonical digest/repairs are invalid");
    }
    const evidenceCache: EvidenceCache = new Map();
    const records = contract.auditVersion >= 3
      ? applyDeclaredRepairsV3(
          audit.repairs,
          stateDir,
          entry,
          problemEvidence,
          solutionEvidence,
          rulesDigest,
          base,
          solutions,
          evidenceCache,
          contract,
        )
      : (() => {
          const legacy = new Map(base.records);
          const repaired = new Set<string>();
          for (const rawRepair of audit.repairs) {
            const repair = object(rawRepair, "filtered answer audit repair");
            const key = exactString(repair.key, "filtered answer audit repair.key");
            if (repaired.has(key)) throw new Error(`duplicate declared repair: ${key}`);
            const baseRecord = base.records.get(key);
            const solution = baseRecord && solutions.get(baseRecord.question.printedNumber);
            if (!baseRecord || !solution) throw new Error(`repair has no base problem/solution: ${key}`);
            legacy.set(key, applyDeclaredRepair(
              repair,
              stateDir,
              entry,
              problemEvidence,
              rulesDigest,
              baseRecord,
              solution,
              contract,
            ));
            repaired.add(key);
          }
          return legacy;
        })();
    const effective = summarizeDecisions(records, base.order, rulesDigest);
    const effectiveCorpusHash = canonicalEvidenceHash(effective.order.map((key) => {
      const record = effective.records.get(key)!;
      return { question: record.question.evidence, classification: record.classification };
    }));
    const nonExact = effective.order.filter((key) =>
      effective.records.get(key)!.classification.transcription_status !== "exact");
    if (contract.problemTerminalFidelityVersion === null && nonExact.length > 0) {
      throw new Error(`filtered corpus remains non-exact: ${nonExact.join(", ")}`);
    }
    const repairKeys = new Set(audit.repairs.map((value, index) =>
      exactString(object(value, `filtered answer audit repairs[${index}]`).key,
        `filtered answer audit repairs[${index}].key`)));
    const problemTerminalFidelity = contract.problemTerminalFidelityVersion !== null
      ? verifyProblemTerminalFidelity(
          stateDir,
          entry,
          problemEvidence,
          effective,
          audit,
          evidenceCache,
          repairKeys,
          contract,
        )
      : null;
    if (contract.auditVersion === CURRENT_CONTRACT.auditVersion) {
      verifyPersistedSolutionHistory(
        stateDir,
        entry,
        problemEvidence,
        solutionEvidence,
        rulesDigest,
        effective,
        solutions,
        effectiveCorpusHash,
        contract,
      );
    }
    const expectedBasis = {
      entryId: entry.id,
      problemHash: problemEvidence.sha256,
      solutionHash: solutionEvidence.sha256,
      classifierVersion: contract.classifierVersion,
      rulesDigest,
      transcriptionGateVersion: contract.transcriptionGateVersion,
      transcriptionPromptDigest: contract.transcriptionPromptDigest,
      ...(version >= 2 ? {
        solutionFidelityVersion: SOLUTION_FIDELITY_VERSION,
        solutionFidelityPromptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
        ...(contract.problemTerminalFidelityVersion === null ? {} : {
          problemTerminalFidelityVersion: contract.problemTerminalFidelityVersion,
          ...(contract.problemTerminalScopePromptDigest === null ? {} : {
            problemTerminalScopePromptDigest: contract.problemTerminalScopePromptDigest,
          }),
        }),
        semanticChoiceVersion: contract.semanticChoiceVersion,
        semanticPromptDigest: contract.semanticPromptDigest,
      } : {
        semanticChoiceVersion: LEGACY_FILTERED_SEMANTIC_CHOICE_VERSION,
        semanticPromptDigest: LEGACY_FILTERED_SEMANTIC_CHOICE_PROMPT_DIGEST,
      }),
      sourceQuestionCount: effective.problems.size,
      acceptedQuestionCount: 0,
      rejectedQuestionCount: effective.rejected,
      reviewQuestionCount: effective.reviews,
      targetQuestionCounts: {},
      ...(version >= 2 ? {
        acceptedSolutionKeys: [],
        solutionRepairKeys: [],
        derivedAnswerKeys: [],
      } : {}),
      acceptedMcqKeys: [],
      effectiveCorpusHash,
      ...(version >= 2 ? {
        effectiveSolutionCorpusHash: canonicalEvidenceHash([]),
        solutionFidelityCheckpoints: [],
        solutionFidelityItems: [],
        solutionRepairs: [],
      } : {}),
      ...(problemTerminalFidelity ? {
        problemTerminalFidelityCheckpoints: problemTerminalFidelity.checkpoints,
        problemTerminalFidelityItems: problemTerminalFidelity.items,
      } : {}),
      semanticCheckpoint: null,
      repairs: [...audit.repairs].sort((left, right) => compareCorpusQuestionKeys(
        exactString(object(left, "repair").key, "repair.key"),
        exactString(object(right, "repair").key, "repair.key"),
      )),
      items: [],
    };
    if (!isDeepStrictEqual(auditBasis, expectedBasis)
      || effective.accepted.length !== 0 || effective.reviews !== 0
      || result.sourceQuestionCount !== effective.problems.size
      || result.acceptedQuestionCount !== 0
      || result.rejectedQuestionCount !== effective.rejected
      || result.reviewQuestionCount !== 0
      || contract.problemTerminalFidelityVersion !== null && result.effectiveCorpusHash !== effectiveCorpusHash
      || contract.problemTerminalScopePromptDigest !== null && (
        result.problemTerminalFidelityVersion !== contract.problemTerminalFidelityVersion
        || result.problemTerminalScopePromptDigest !== contract.problemTerminalScopePromptDigest
      )) {
      throw new Error("filtered answer audit/result does not match the exact effective corpus");
    }
    return effective;
  } catch (error) {
    add({
      code: error instanceof CorpusValidationError ? error.code : "ANSWER_AUDIT_INVALID",
      entryId: entry.id,
      message: error instanceof Error ? error.message : String(error),
    });
    return base;
  }
}

const REQUIRED_SCHEMA: Record<string, readonly string[]> = {
  subjects: ["id", "name"],
  books: ["id", "subject_id", "title"],
  book_files: ["id", "book_id", "r2_key", "content_hash", "page_count", "status"],
  book_items: ["id", "book_id", "file_id", "category", "number", "answer", "content", "page"],
  questions: [
    "id", "subject_id", "source", "qtype", "question", "choices", "answer", "explanation", "book_id",
    "book_number", "printed_number", "src_file_id", "src_page",
  ],
};

function schemaReady(db: Database.Database, add: AddFailure): boolean {
  let ready = true;
  for (const [table, required] of Object.entries(REQUIRED_SCHEMA)) {
    const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name));
    for (const column of required) {
      if (!columns.has(column)) {
        ready = false;
        add({ code: "SCHEMA_MISSING", message: `${table}.${column} is missing` });
      }
    }
  }
  return ready;
}

function corpusFiles(db: Database.Database): CorpusFile[] {
  return db.prepare(
    `SELECT bf.id, bf.book_id, b.title AS book_title, b.subject_id, s.name AS target,
            bf.r2_key, bf.content_hash, bf.page_count, bf.status
     FROM book_files bf
     JOIN books b ON b.id = bf.book_id
     JOIN subjects s ON s.id = b.subject_id
     WHERE bf.r2_key LIKE 'corpus/%'
     ORDER BY bf.r2_key, bf.id`,
  ).all() as CorpusFile[];
}

type DbQuestion = {
  id: number;
  subject_id: number;
  source: string;
  qtype: string;
  difficulty: string;
  question: string;
  choices: string | null;
  answer: string;
  explanation: string;
  book_id: number | null;
  book_number: string | null;
  printed_number: string | null;
  src_file_id: number | null;
  src_page: number | null;
};

type DbBookItem = {
  id: number;
  file_id: number;
  category: string;
  number: string;
  answer: string;
  content: string;
  page: number | null;
};

function questionsFor(db: Database.Database, bookId: number): DbQuestion[] {
  return db.prepare(
    `SELECT id, subject_id, source, qtype, difficulty, question, choices, answer, explanation, book_id,
            book_number, printed_number, src_file_id, src_page
     FROM questions WHERE book_id = ? ORDER BY id`,
  ).all(bookId) as DbQuestion[];
}

function itemsFor(db: Database.Database, bookId: number): DbBookItem[] {
  return db.prepare(
    `SELECT id, file_id, category, number, answer, content, page
     FROM book_items WHERE book_id = ? ORDER BY id`,
  ).all(bookId) as DbBookItem[];
}

function verifyTargetBook(
  db: Database.Database,
  dataDir: string,
  entry: ManifestEntry,
  targetBook: TargetBook,
  expected: AcceptedQuestion[],
  problemEvidence: DownloadEvidence,
  solutionEvidence: DownloadEvidence,
  filesByKey: Map<string, CorpusFile[]>,
  add: AddFailure,
  hashCache: Map<string, string>,
): void {
  const problemFiles = filesByKey.get(targetBook.problemR2Key) ?? [];
  const solutionFiles = filesByKey.get(targetBook.solutionR2Key) ?? [];
  if (problemFiles.length !== 1 || solutionFiles.length !== 1) {
    add({
      code: "DB_FILE_EVIDENCE",
      entryId: entry.id,
      target: targetBook.subject,
      message: `expected one problem and solution DB file, got ${problemFiles.length}/${solutionFiles.length}`,
    });
    return;
  }
  const problemFile = problemFiles[0];
  const solutionFile = solutionFiles[0];
  if (
    problemFile.book_id !== solutionFile.book_id || problemFile.target !== targetBook.subject
    || solutionFile.target !== targetBook.subject || problemFile.book_title !== targetBook.bookTitle
    || solutionFile.book_title !== targetBook.bookTitle
  ) {
    add({ code: "BOOK_IDENTITY", entryId: entry.id, target: targetBook.subject, message: "DB book target/title/file ownership mismatch" });
    return;
  }
  for (const [kind, file, evidence] of [
    ["problem", problemFile, problemEvidence],
    ["solution", solutionFile, solutionEvidence],
  ] as const) {
    if (file.status !== "ready" || file.content_hash !== evidence.sha256 || file.page_count !== evidence.pageCount) {
      add({
        code: "DB_FILE_EVIDENCE",
        entryId: entry.id,
        target: targetBook.subject,
        message: `${kind} DB hash/page/status does not match downloads.json`,
      });
    }
    const filesRoot = resolve(dataDir, "files");
    const path = resolve(filesRoot, file.r2_key);
    if (!path.startsWith(`${filesRoot}/`)) {
      add({ code: "DB_FILE_EVIDENCE", entryId: entry.id, target: targetBook.subject, message: `${file.r2_key} escapes files root` });
    } else {
      verifyFile(path, evidence.sha256, evidence.bytes, "DB_FILE_EVIDENCE", entry.id, add, hashCache);
    }
  }

  const actual = questionsFor(db, problemFile.book_id);
  const items = itemsFor(db, problemFile.book_id);
  const byKey = new Map<string, DbQuestion>();
  for (const question of actual) {
    const number = numericPrintedLocator(question.printed_number);
    if (number === null || !Number.isSafeInteger(question.src_page) || question.src_page! < 1) {
      add({
        code: "QUESTION_EVIDENCE",
        entryId: entry.id,
        target: targetBook.subject,
        questionId: question.id,
        message: "printed_number/src_page is missing or invalid",
      });
      continue;
    }
    const key = `${question.src_page}:${number}`;
    if (byKey.has(key)) {
      add({ code: "DUPLICATE_QUESTION", entryId: entry.id, target: targetBook.subject, message: `duplicate page:number ${key}` });
    } else {
      byKey.set(key, question);
    }
  }
  if (actual.length !== targetBook.expectedQuestionCount) {
    add({
      code: "COUNT_MISMATCH",
      entryId: entry.id,
      target: targetBook.subject,
      message: `DB has ${actual.length} questions, receipt/classification expects ${targetBook.expectedQuestionCount}`,
    });
  }

  for (const expectedQuestion of expected) {
    const question = byKey.get(expectedQuestion.key);
    if (!question) {
      add({ code: "QUESTION_MISSING", entryId: entry.id, target: targetBook.subject, message: `${expectedQuestion.key} is missing from DB` });
      continue;
    }
    const expectedChoices = expectedQuestion.choices === null ? null : JSON.stringify(expectedQuestion.choices);
    const mismatches: string[] = [];
    if (question.subject_id !== problemFile.subject_id) mismatches.push("subject_id");
    if (question.source !== "uploaded") mismatches.push("source");
    if (question.qtype !== expectedQuestion.qtype) mismatches.push("qtype");
    if (question.difficulty !== expectedQuestion.baseDifficulty) mismatches.push("base difficulty");
    if (question.question !== expectedQuestion.question) mismatches.push("question");
    if (question.choices !== expectedChoices) mismatches.push("choices");
    if (question.answer !== expectedQuestion.officialAnswer) mismatches.push("answer");
    if (question.explanation !== expectedQuestion.officialExplanation) mismatches.push("explanation");
    if (question.book_id !== problemFile.book_id) mismatches.push("book_id");
    if (question.book_number !== expectedQuestion.printedNumber || question.printed_number !== expectedQuestion.printedNumber) {
      mismatches.push("printed_number");
    }
    if (question.src_file_id !== problemFile.id || question.src_page !== expectedQuestion.page) mismatches.push("source evidence");
    if (!question.answer.trim()) mismatches.push("nonempty answer");
    if (!question.explanation.trim()) {
      add({
        code: "OFFICIAL_EXPLANATION",
        entryId: entry.id,
        target: targetBook.subject,
        questionId: question.id,
        message: `${expectedQuestion.printedNumber}: official explanation is empty`,
      });
    }
    if (mismatches.length > 0) {
      add({
        code: "QUESTION_MISMATCH",
        entryId: entry.id,
        target: targetBook.subject,
        questionId: question.id,
        message: `${expectedQuestion.printedNumber}: ${mismatches.join(", ")}`,
      });
    }

    const problemItems = items.filter((item) => item.category === "문제" && numericPrintedLocator(item.number) === Number(expectedQuestion.printedNumber));
    const solutionItems = items.filter((item) => item.category === "해설" && numericPrintedLocator(item.number) === Number(expectedQuestion.printedNumber));
    if (
      problemItems.length !== 1 || problemItems[0].file_id !== problemFile.id
      || problemItems[0].page !== expectedQuestion.page || problemItems[0].answer !== expectedQuestion.officialAnswer
      || problemItems[0].content !== expectedQuestion.question
    ) {
      add({ code: "PROBLEM_EVIDENCE", entryId: entry.id, target: targetBook.subject, questionId: question.id, message: `${expectedQuestion.printedNumber}: problem book_item mismatch` });
    }
    if (
      solutionItems.length !== 1 || solutionItems[0].file_id !== solutionFile.id
      || solutionItems[0].page !== expectedQuestion.solutionPage || solutionItems[0].answer !== expectedQuestion.officialAnswer
      || solutionItems[0].content !== expectedQuestion.officialExplanation
    ) {
      add({ code: "SOLUTION_EVIDENCE", entryId: entry.id, target: targetBook.subject, questionId: question.id, message: `${expectedQuestion.printedNumber}: official solution book_item mismatch` });
    }
  }
}

function parseTargetBooks(
  value: unknown,
  entry: ManifestEntry,
  expectedCounts: Map<TargetSubject, number>,
  add: AddFailure,
): TargetBook[] {
  if (!Array.isArray(value)) {
    add({ code: "RECEIPT_INVALID", entryId: entry.id, message: "receipt.targetBooks must be an array" });
    return [];
  }
  const books: TargetBook[] = [];
  const seen = new Set<TargetSubject>();
  for (const [index, raw] of value.entries()) {
    try {
      const row = object(raw, `targetBooks[${index}]`);
      const subject = exactString(row.subject, `targetBooks[${index}].subject`) as TargetSubject;
      if (!TARGET_SET.has(subject) || seen.has(subject)) throw new Error(`invalid or duplicate target ${subject}`);
      seen.add(subject);
      const expectedQuestionCount = integer(row.expectedQuestionCount, `targetBooks[${index}].expectedQuestionCount`, 1);
      const expectedPrefix = `corpus/${entryToken(entry)}/${subjectToken(subject)}`;
      const targetBook = {
        subject,
        bookTitle: exactString(row.bookTitle, `targetBooks[${index}].bookTitle`),
        expectedQuestionCount,
        problemR2Key: exactString(row.problemR2Key, `targetBooks[${index}].problemR2Key`),
        solutionR2Key: exactString(row.solutionR2Key, `targetBooks[${index}].solutionR2Key`),
      };
      if (
        row.examTitle !== entry.examTitle || targetBook.bookTitle !== bookTitle(entry)
        || targetBook.problemR2Key !== `${expectedPrefix}/problem.pdf`
        || targetBook.solutionR2Key !== `${expectedPrefix}/solution.pdf`
        || expectedCounts.get(subject) !== expectedQuestionCount
      ) throw new Error(`${subject}: receipt target book identity/count mismatch`);
      books.push(targetBook);
    } catch (error) {
      add({ code: "RECEIPT_INVALID", entryId: entry.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const [target, count] of expectedCounts) {
    if (count > 0 && !seen.has(target)) {
      add({ code: "RECEIPT_INVALID", entryId: entry.id, target, message: "receipt omits accepted target book" });
    }
  }
  for (const target of seen) {
    if (!expectedCounts.get(target)) {
      add({ code: "RECEIPT_INVALID", entryId: entry.id, target, message: "receipt includes target with no accepted questions" });
    }
  }
  return books;
}

export function verifyExamCorpus(options: {
  manifestPath: string;
  dbPath: string;
  dataDir: string;
}): VerificationReport {
  const entries = parseManifest(resolve(options.manifestPath));
  const dataDir = resolve(options.dataDir);
  const report: VerificationReport = {
    ok: false,
    manifest: { expected: entries.length, terminal: 0, committed: 0, filtered: 0, review: 0 },
    questions: { expected: 0, actual: 0 },
    targets: emptyTargetCounts(),
    failureCount: 0,
    failures: [],
  };
  const add: AddFailure = (failure) => {
    report.failureCount += 1;
    if (report.failures.length < MAX_FAILURE_DETAILS) report.failures.push(failure);
  };
  const finish = () => {
    report.questions.expected = TARGET_SUBJECTS.reduce((sum, target) => sum + report.targets[target].expected, 0);
    report.questions.actual = TARGET_SUBJECTS.reduce((sum, target) => sum + report.targets[target].actual, 0);
    report.ok = report.failureCount === 0;
    return report;
  };

  if (existsSync(join(dataDir, "import-exam-corpus", ".lock"))) {
    add({ code: "IMPORT_RUNNING", message: "import lock exists; verify a stable completed run" });
    return finish();
  }

  const db = new Database(resolve(options.dbPath), { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    db.pragma("busy_timeout = 5000");
    if (!schemaReady(db, add)) return finish();

    for (const target of TARGET_SUBJECTS) {
      const rows = db.prepare("SELECT id FROM subjects WHERE name = ? ORDER BY id").all(target) as { id: number }[];
      if (rows.length !== 1) {
        add({
          code: rows.length === 0 ? "TARGET_SUBJECT_MISSING" : "TARGET_SUBJECT_DUPLICATE",
          target,
          message: `expected one canonical subject row, found ${rows.length}`,
        });
      }
    }

    const files = corpusFiles(db);
    const filesByKey = new Map<string, CorpusFile[]>();
    for (const file of files) {
      const group = filesByKey.get(file.r2_key) ?? [];
      group.push(file);
      filesByKey.set(file.r2_key, group);
      if (!TARGET_SET.has(file.target)) {
        add({ code: "OUTSIDE_TARGET", target: file.target, message: `${file.r2_key} belongs to noncanonical subject` });
      }
    }
    for (const [key, group] of filesByKey) {
      if (group.length > 1) add({ code: "DUPLICATE_FILE_EVIDENCE", message: `${key} appears ${group.length} times in DB` });
    }

    const actualBookIds = new Set<number>();
    const duplicateIdentity = new Map<string, number>();
    for (const file of files) {
      if (!TARGET_SET.has(file.target) || actualBookIds.has(file.book_id)) continue;
      actualBookIds.add(file.book_id);
      const target = file.target as TargetSubject;
      const questions = questionsFor(db, file.book_id);
      report.targets[target].actual += questions.length;
      for (const question of questions) {
        const number = numericPrintedLocator(question.printed_number);
        if (number === null) {
          add({ code: "QUESTION_EVIDENCE", target, questionId: question.id, message: "corpus question lacks printed_number" });
          continue;
        }
        const identity = `${file.book_title}\0${number}\0${target}`;
        const previous = duplicateIdentity.get(identity);
        if (previous !== undefined) {
          add({
            code: "DUPLICATE_QUESTION",
            target,
            questionId: question.id,
            message: `duplicate (exam, printed number, target); first question ${previous}`,
          });
        } else {
          duplicateIdentity.set(identity, question.id);
        }
      }
    }

    const expectedFiles = new Set<string>();
    const hashCache = new Map<string, string>();
    for (const entry of entries) {
      const stateDir = join(dataDir, "import-exam-corpus", entryToken(entry));
      const entryPath = join(stateDir, "entry.json");
      let entrySchemaVersion: number | null = null;
      if (!existsSync(entryPath)) {
        add({ code: "ENTRY_STATE_MISSING", entryId: entry.id, message: "entry.json is missing" });
      } else {
        const saved = safeObject(entryPath, "entry.json", entry.id, add);
        if (saved) {
          entrySchemaVersion = Number(saved.schemaVersion);
          if (![1, 2].includes(entrySchemaVersion) || !isDeepStrictEqual(saved.entry, entry.raw)) {
            add({ code: "ENTRY_MISMATCH", entryId: entry.id, message: "entry.json does not exactly match manifest entry" });
          }
        }
      }

      const receiptPath = join(stateDir, "receipt.json");
      const resultPath = join(stateDir, "result.json");
      const hasReceipt = existsSync(receiptPath);
      const hasResult = existsSync(resultPath);
      if (hasReceipt === hasResult) {
        add({
          code: hasReceipt ? "TERMINAL_CONFLICT" : "TERMINAL_MISSING",
          entryId: entry.id,
          message: hasReceipt ? "receipt.json and result.json both exist" : "receipt.json/result.json is missing",
        });
      } else {
        report.manifest.terminal += 1;
        if (hasReceipt) report.manifest.committed += 1;
        else report.manifest.filtered += 1;
      }
      const receipt = hasReceipt ? safeObject(receiptPath, "receipt.json", entry.id, add) : null;
      const result = hasResult ? safeObject(resultPath, "result.json", entry.id, add) : null;
      const terminalDigestValue = receipt?.rulesDigest ?? result?.rulesDigest;
      const terminalDigest = typeof terminalDigestValue === "string" && /^[a-f0-9]{16}$/.test(terminalDigestValue)
        ? terminalDigestValue
        : null;

      const downloadsPath = join(stateDir, "downloads.json");
      const downloads = existsSync(downloadsPath) ? safeObject(downloadsPath, "downloads.json", entry.id, add) : null;
      if (!downloads) {
        add({ code: "DOWNLOAD_EVIDENCE", entryId: entry.id, message: "downloads.json is missing or invalid" });
        continue;
      }
      if (downloads.version !== 2) add({ code: "DOWNLOAD_EVIDENCE", entryId: entry.id, message: "downloads.json version must be 2" });
      const problemEvidence = parseDownload(downloads.problem, "problem", entry.problemPdfUrl, entry.id, add);
      const solutionEvidence = parseDownload(downloads.solution, "solution", entry.solutionPdfUrl, entry.id, add);
      if (!problemEvidence || !solutionEvidence) continue;
      verifyFile(join(stateDir, problemEvidence.path), problemEvidence.sha256, problemEvidence.bytes, "DOWNLOAD_EVIDENCE", entry.id, add, hashCache);
      verifyFile(join(stateDir, solutionEvidence.path), solutionEvidence.sha256, solutionEvidence.bytes, "DOWNLOAD_EVIDENCE", entry.id, add, hashCache);

      const contract = selectVerificationContract(
        stateDir,
        receipt,
        result,
      );
      if (contract.auditVersion >= 3 && entrySchemaVersion !== null && entrySchemaVersion !== 2) {
        add({
          code: "ENTRY_MISMATCH",
          entryId: entry.id,
          message: "entry.json schemaVersion must be 2 for the current terminal contract",
        });
      }
      let decisions = loadDecisions(stateDir, entry, problemEvidence, terminalDigest, contract, add);

      if (result) {
        const needsFilteredAudit = Number(result.version) >= 3 || result.answerAudit !== undefined || decisions.order.some((key) =>
          decisions.records.get(key)!.classification.transcription_status !== "exact");
        if (needsFilteredAudit) {
          const filteredSolutions = loadSolutions(stateDir, entry, solutionEvidence, add);
          decisions = verifyFilteredAnswerAudit(
            stateDir,
            entry,
            problemEvidence,
            solutionEvidence,
            decisions,
            filteredSolutions,
            result,
            contract,
            add,
          );
        }
        if (decisions.reviews > 0) {
          report.manifest.review += 1;
          add({ code: "REVIEW_COMMITTED", entryId: entry.id, message: "review decisions must have no terminal result" });
        }
        const noScopeGateMatches = result.reason === "NO_IN_SCOPE_QUESTIONS" && (
          result.classifierVersion === contract.classifierVersion
          && result.transcriptionGateVersion === contract.transcriptionGateVersion
          && result.transcriptionPromptDigest === contract.transcriptionPromptDigest
          && (contract.problemTerminalScopePromptDigest === null || (
            result.problemTerminalFidelityVersion === contract.problemTerminalFidelityVersion
            && result.problemTerminalScopePromptDigest === contract.problemTerminalScopePromptDigest
          ))
        );
        const sourceGradeResult = result.reason === "SOURCE_GRADE_OUT_OF_SCOPE" && result.version === 2
          && result.sourceQuestionCount === null && result.rejectedQuestionCount === null;
        const currentAuditPointer = result.answerAudit && typeof result.answerAudit === "object"
          && !Array.isArray(result.answerAudit) ? result.answerAudit as Record<string, unknown> : null;
        const currentFilteredBinding = contract.problemTerminalFidelityVersion === null || (
          typeof result.effectiveCorpusHash === "string" && /^[a-f0-9]{64}$/u.test(result.effectiveCorpusHash)
          && typeof currentAuditPointer?.path === "string" && typeof currentAuditPointer.sha256 === "string"
        );
        if (
          result.status !== "filtered" || result.entryId !== entry.id
          || result.acceptedQuestionCount !== 0 || result.reviewQuestionCount !== 0
          || !sourceGradeResult && (
            result.version !== contract.auditVersion
            || result.sourceQuestionCount !== decisions.problems.size
            || result.rejectedQuestionCount !== decisions.rejected
            || decisions.accepted.length !== 0 || decisions.reviews !== 0
            || result.rulesDigest !== decisions.rulesDigest || !noScopeGateMatches
            || !currentFilteredBinding
          )
        ) {
          add({ code: "RESULT_INVALID", entryId: entry.id, message: "filtered result does not match complete classifications" });
        }
        continue;
      }

      if (!receipt) {
        if (decisions.reviews > 0) {
          report.manifest.review += 1;
          add({ code: "REVIEW_PENDING", entryId: entry.id, message: `${decisions.reviews} questions require review` });
        }
        for (const question of decisions.accepted) report.targets[question.target].expected += 1;
        if (decisions.accepted.length > 0) add({ code: "RECEIPT_MISSING", entryId: entry.id, message: "accepted questions have no receipt" });
        continue;
      }

      const solutions = loadSolutions(stateDir, entry, solutionEvidence, add);
      const baseProblemNumbers = new Set([...decisions.problems.values()].map((question) => question.printedNumber));
      if (
        solutions.size !== baseProblemNumbers.size || [...baseProblemNumbers].some((number) => !solutions.has(number))
        || [...solutions].some(([number]) => !baseProblemNumbers.has(number))
      ) {
        add({
          code: "SOLUTION_NUMBER_SET",
          entryId: entry.id,
          message: "problem and official solution printed-number sets differ",
        });
      }
      const baseDifficultyByKey = new Map(decisions.order.map((key) => [
        key,
        decisions.records.get(key)!.question.difficulty,
      ]));
      const verifiedAudit = verifyAnswerAudit(
        stateDir,
        entry,
        problemEvidence,
        solutionEvidence,
        decisions,
        solutions,
        receipt,
        contract,
        add,
      );
      decisions = verifiedAudit.decisions;
      const effectiveSolutions = verifiedAudit.solutions;
      if (decisions.reviews > 0) {
        report.manifest.review += 1;
        add({ code: "REVIEW_COMMITTED", entryId: entry.id, message: "effective repair classifications require review" });
      }
      const acceptedCounts = new Map<TargetSubject, number>();
      for (const question of decisions.accepted) {
        acceptedCounts.set(question.target, (acceptedCounts.get(question.target) ?? 0) + 1);
        report.targets[question.target].expected += 1;
      }
      if (
        receipt.version !== 2 || receipt.status !== "committed" || receipt.entryId !== entry.id
        || receipt.examTitle !== entry.examTitle || receipt.rawTitle !== entry.rawTitle
        || receipt.bookTitle !== bookTitle(entry) || receipt.sourceRecordYear !== entry.sourceRecordYear
        || receipt.variant !== entry.variant || receipt.form !== entry.form
        || receipt.sourceSubject !== entry.subject || receipt.grade !== entry.grade
        || receipt.rulesDigest !== decisions.rulesDigest || receipt.sourceQuestionCount !== decisions.problems.size
        || receipt.acceptedQuestionCount !== decisions.accepted.length || receipt.rejectedQuestionCount !== decisions.rejected
        || receipt.reviewQuestionCount !== 0 || decisions.reviews !== 0
        || receipt.problemHash !== problemEvidence.sha256 || receipt.solutionHash !== solutionEvidence.sha256
        || !isDeepStrictEqual(receipt.problemChunking, { pages: 20, stride: 18, overlap: 2 })
      ) {
        add({ code: "RECEIPT_INVALID", entryId: entry.id, message: "receipt metadata/counts/hashes do not match manifest and sidecars" });
      }
      if (decisions.accepted.length === 0) {
        add({ code: "RECEIPT_INVALID", entryId: entry.id, message: "committed receipt has no accepted questions" });
      }

      const problemNumbers = new Set([...decisions.problems.values()].map((question) => question.printedNumber));
      if (
        effectiveSolutions.size !== problemNumbers.size
        || [...problemNumbers].some((number) => !effectiveSolutions.has(number))
        || [...effectiveSolutions].some(([number]) => !problemNumbers.has(number))
      ) {
        add({
          code: "SOLUTION_NUMBER_SET",
          entryId: entry.id,
          message: "problem and official solution printed-number sets differ",
        });
      }
      const expectedByTarget = new Map<TargetSubject, AcceptedQuestion[]>();
      for (const question of decisions.accepted) {
        const solution = effectiveSolutions.get(question.printedNumber);
        if (!solution) {
          add({ code: "OFFICIAL_SOLUTION_MISSING", entryId: entry.id, target: question.target, message: `${question.printedNumber}: official solution missing` });
          continue;
        }
        if (!solution.rawAnswer.trim() || !solution.explanation.trim()) {
          add({ code: "OFFICIAL_EXPLANATION", entryId: entry.id, target: question.target, message: `${question.printedNumber}: official answer/explanation empty` });
        }
        const choices = question.choices === null ? null : JSON.stringify(question.choices);
        let officialAnswer: string;
        try {
          officialAnswer = officialAnswerForDb(question, solution.rawAnswer);
        } catch (error) {
          add({
            code: "OFFICIAL_ANSWER_UNRESOLVED",
            entryId: entry.id,
            target: question.target,
            message: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (question.qtype === "mcq") {
          const gradingMatches = (question.choices ?? []).filter((choice) =>
            gradeAnswer("mcq", officialAnswer, choice, choices),
          );
          if (gradingMatches.length !== 1) {
            add({ code: "OFFICIAL_ANSWER_UNGRADABLE", entryId: entry.id, target: question.target, message: `${question.printedNumber}: mapped DB answer does not grade one exact choice` });
          }
        }
        const group = expectedByTarget.get(question.target) ?? [];
        group.push({
          ...question,
          baseDifficulty: baseDifficultyByKey.get(question.key)!,
          officialAnswer,
          officialRawAnswer: solution.rawAnswer,
          officialExplanation: solution.explanation,
          solutionPage: solution.page,
        });
        expectedByTarget.set(question.target, group);
      }

      const targetBooks = parseTargetBooks(receipt.targetBooks, entry, acceptedCounts, add);
      for (const targetBook of targetBooks) {
        expectedFiles.add(targetBook.problemR2Key);
        expectedFiles.add(targetBook.solutionR2Key);
        verifyTargetBook(
          db,
          dataDir,
          entry,
          targetBook,
          expectedByTarget.get(targetBook.subject) ?? [],
          problemEvidence,
          solutionEvidence,
          filesByKey,
          add,
          hashCache,
        );
      }
    }

    for (const file of files) {
      if (!expectedFiles.has(file.r2_key)) {
        add({ code: "UNEXPECTED_CORPUS_FILE", target: file.target, message: `${file.r2_key} is not owned by a committed manifest receipt` });
      }
    }
    for (const target of TARGET_SUBJECTS) {
      const counts = report.targets[target];
      if (counts.expected !== counts.actual) {
        add({ code: "COUNT_MISMATCH", target, message: `manifest/receipts expect ${counts.expected}; DB has ${counts.actual}` });
      }
    }
    return finish();
  } finally {
    db.close();
  }
}

function usage(): string {
  return "npx tsx scripts/verify-exam-corpus.ts [--data-dir data] [--manifest data/ebsi-exam-manifest.json] [--db data/studywork.db]";
}

function options(argv: string[]): { manifestPath: string; dbPath: string; dataDir: string } | null {
  let dataDir = process.env.DATA_DIR || "./data";
  let manifestPath = "";
  let dbPath = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return null;
    if (arg !== "--data-dir" && arg !== "--manifest" && arg !== "--db") throw new Error(`unknown option: ${arg}`);
    const value = argv[++index];
    if (!value) throw new Error(`${arg} requires a path`);
    if (arg === "--data-dir") dataDir = value;
    else if (arg === "--manifest") manifestPath = value;
    else dbPath = value;
  }
  dataDir = resolve(dataDir);
  return {
    dataDir,
    manifestPath: resolve(manifestPath || join(dataDir, "ebsi-exam-manifest.json")),
    dbPath: resolve(dbPath || join(dataDir, "studywork.db")),
  };
}

export function humanSummary(report: VerificationReport): string {
  const status = report.ok ? "PASS" : "FAIL";
  const lines = [
    `${status} corpus: manifest ${report.manifest.terminal}/${report.manifest.expected} terminal; questions ${report.questions.actual}/${report.questions.expected}; review ${report.manifest.review}; failures ${report.failureCount}`,
    TARGET_SUBJECTS.map((target) => `${target} ${report.targets[target].actual}/${report.targets[target].expected}`).join(" | "),
  ];
  if (!report.ok) lines.push(...report.failures.slice(0, 5).map((failure) => `- ${failure.code}: ${failure.message}`));
  return lines.join("\n");
}

export function runCli(
  argv = process.argv.slice(2),
  output: { stdout: (value: string) => void; stderr: (value: string) => void } = {
    stdout: (value) => console.log(value),
    stderr: (value) => console.error(value),
  },
): number {
  try {
    const parsed = options(argv);
    if (!parsed) {
      output.stdout(usage());
      return 0;
    }
    const report = verifyExamCorpus(parsed);
    output.stdout(JSON.stringify(report));
    output.stderr(humanSummary(report));
    return report.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.stdout(JSON.stringify({ ok: false, error: message }));
    output.stderr(`FAIL corpus: ${message}`);
    return 1;
  }
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli();
}
