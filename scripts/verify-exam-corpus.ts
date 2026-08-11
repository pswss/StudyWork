#!/usr/bin/env tsx

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
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
const PROBLEM_MANUAL_REVISION_VERSION = 1;
const CLASSIFICATION_MANUAL_REVISION_VERSION = 1;
const PROBLEM_SCOPE_BOX_REVISION_VERSION = 1;
const CLASSIFICATION_SCOPE_BOX_REVISION_VERSION = 1;
const PROBLEM_SCOPE_BOX_REVISION_PROMPT_DIGEST =
  "067eea7c5d44f2e15a6f979ba016eb01c13b8aa8268c17aa33a902cf705ba04c";
const PROBLEM_SCOPE_BOX_REVISION_CORRECTION_DIGEST =
  "d9d2ddedb51a82d107e3a0d66f2263a92483a09cce20d5fde531ee9083bf88a4";
const PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_VERSION = 1;
const PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_PROMPT_DIGEST =
  "e92ed29fdd979e63d56635b2f7c99284ad01f14893384e680acd150cb2a29728";
const PROBLEM_TERMINAL_FIDELITY_POLICY_REVISION_VERSION = 1;
const PROBLEM_TERMINAL_FIDELITY_POLICY_REVISION_DIGEST =
  "bc625c2e3b1b7006d184e14a7f1fc298a3788617c639bcd131483d7c23177a06";
const CURRICULUM_RULES_SHA256 =
  "7bb7cb863c8c4855f042419fbbaac4426aafb513d8bbb00fd35f5afa1a2d1932";
const PROBLEM_MANUAL_ADJUDICATION_PROMPT_DIGEST =
  "28434a9872d33e0ef364b6030c6f32b4a51cab9182a9d6c372f225884794d7e9";
const PROBLEM_MANUAL_CORRECTION_DIGEST =
  "a116ca7dd3fb35028db717aac3aa09e78d7c7671ab5ca9ecdaa3364bdb397b46";
const PROBLEM_MANUAL_REVISION_PROMPT_DIGEST =
  "28434a9872d33e0ef364b6030c6f32b4a51cab9182a9d6c372f225884794d7e9";
const PROBLEM_MANUAL_REVISION_CORRECTION_DIGEST =
  "c186099e5b8e70f7fbcf44cbbd1e4c869036a66c4eea6f28f9d51864cac38526";
const PROBLEM_SCOPE_ADJUDICATION_VERSION = 1;
const PROBLEM_REPAIR_SCOPE_ADJUDICATION_VERSION = 1;
const PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_VERSION = 1;
const PROBLEM_REVISION_SCOPE_ADJUDICATION_VERSION = 1;
const PROBLEM_SCOPE_ADJUDICATION_PROMPT_DIGEST =
  "cec5be77bf9745d05593e497842a3642c8a30c1ef1105ba1940f0a74fad3124e";
const PROBLEM_REPAIR_SCOPE_ADJUDICATION_PROMPT_DIGEST =
  "cec5be77bf9745d05593e497842a3642c8a30c1ef1105ba1940f0a74fad3124e";
const PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_PROMPT_DIGEST =
  "aab22d3d596c15e2d4054a999e9fc90df6c46ee6fe9bdde389a88005fd1d4f7d";
const PROBLEM_REPAIR_POSITIVE_SCOPE_AUTHORITY_REASON_CODE =
  "ALLOWLISTED_POSITIVE_SCOPE_AUTHORITY";
const PROBLEM_REVISION_SCOPE_ADJUDICATION_PROMPT_DIGEST =
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
const SOLUTION_REVISION_FIDELITY_ADJUDICATION_VERSION = 1;
const SOLUTION_REVISION_FIDELITY_ADJUDICATION_PROMPT_DIGEST =
  "b38a96cf61fbbfdd0dfbc1b00c85dbf18a46a646a4aa46f9b41f0847b412e375";
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

const SOLUTION_REVISION_FIDELITY_ADJUDICATION_ALLOWLIST = [{
  allowlistId: "ebsi-5769268-q20-solution-fidelity-v1",
  entryId: "ebsi:5769268",
  key: "8:20",
  sourcePage: 6,
  sourceHash: "bb5b5d03101f67e1f56fe33870def9bd90d91892ed3ef893d9e6c7df4d90aa66",
  revisionArtifactHash: "00da6e80bdbbe87cbff4ce54b57737c77167f0e2764c64ae5c87c1972ef9c9dc",
  failedFidelityArtifactHash: "0fd860b862ad7015dfbaa52fdd899667168fd377cd770d33b4d5abbc2db8a89d",
  revisionSolutionItemHash: "7ad16feb562bc2650dc29272ca0d842e4569b512acb7ae6dae122feb30ffa94a",
  failedDecisionHash: "24a8ac10fc3d42e7ad9a852988d5b500c89fb7ad5acf56ecd4502d32c33432ce",
  failedEvidenceHash: "e9fabf2766b52183ab4c505a0e7e21eea3f0288f1dd2c7e4f4e8216b858f7edf",
  dpi: 600,
  views: [
    { sourcePage: 6, label: "p6 full", rect: [0, 0, 1, 1] },
    { sourcePage: 7, label: "p7 full", rect: [0, 0, 1, 1] },
    { sourcePage: 7, label: "p7 Q20 statement ㄴ", rect: [0.08, 0.46, 0.53, 0.67] },
  ],
  requiredTokens: ["함수 $f(x)$는 극솟값을 갖는다. (거짓)", "정답 ③"],
  literalToken: "함수 $f(x)$는 극솟값을 갖는다. (거짓)",
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
  parentProblemArtifactHash?: string;
  parentClassificationArtifactHash?: string;
  terminalArtifactHash?: string;
};

type ProblemRepairPositiveScopeAdjudicationSpec = ProblemScopeAdjudicationSpec & {
  expectedCanonicalSubject: CanonicalSubject;
  allowedAchievementCodes: readonly string[];
};

type ProblemManualReplacement = {
  field: "question" | "choices" | "figure_description";
  from: string;
  to: string;
  count: number;
};

type ProblemManualAdjudicationSpec = ProblemCropAdjudicationSpec & {
  parentKind: "recovery" | "crop";
  parentRecoveryEvidenceHash?: string;
  dpi?: number;
  failedQuestionHash: string;
  failedClassificationHash: string;
  failedClassificationEvidenceHash: string;
  replacements: readonly ProblemManualReplacement[];
  figure?: boolean;
  figureDescription?: string;
  expectedDecision?: "accept" | "reject";
  expectedCanonicalSubject?: CanonicalSubject;
};

type ProblemManualRevisionSpec = {
  allowlistId: string;
  parentAllowlistId: string;
  entryId: string;
  key: string;
  sourcePage: number;
  sourceHash: string;
  failedQuestionHash: string;
  failedClassificationHash: string;
  failedClassificationEvidenceHash: string;
  replacement: ProblemManualReplacement;
  requiredTokens: readonly string[];
  expectedDecision: "accept" | "reject";
  expectedCanonicalSubject?: CanonicalSubject;
};

type ProblemScopeBoxRevisionSpec = ProblemCropAdjudicationSpec & {
  solutionSourceHash: string;
  dpi: number;
  parentScopeAllowlistId: string;
  problemContextFrom: number;
  problemContextTo: number;
  solutionContextFrom: number;
  solutionContextTo: number;
  parentRecoveryProblemArtifactPath: string;
  parentRecoveryProblemArtifactHash: string;
  parentRecoveryClassificationArtifactPath: string;
  parentRecoveryClassificationArtifactHash: string;
  parentRecoveryClassificationHash: string;
  parentRecoveryEvidenceHash: string;
  failedScopeArtifactPath: string;
  failedScopeArtifactHash: string;
  failedScopeBasisDigest: string;
  failedScopeItemHash: string;
  failedScopeEvidenceHash: string;
  triggerTerminalPath: string;
  triggerTerminalArtifactHash: string;
  triggerEffectiveCorpusHash: string;
  triggerInputHash: string;
  triggerQuestionInputHash: string;
  triggerItemHash: string;
  triggerEvidenceHash: string;
  triggerScopeEvidenceHash: string;
  baseSolutionCheckpointPath: string;
  baseSolutionCheckpointHash: string;
  baseSolutionItemHash: string;
  failedQuestionHash: string;
  failedClassificationHash: string;
  beforeBox: readonly [number, number];
  afterBox: readonly [number, number];
  correctedQuestionHash: string;
};

type PersistedTerminalRecoveryGenerationSpec = {
  problemArtifact: EvidencePointer & { basisDigest: string; itemHash: string };
  classificationArtifact: EvidencePointer & { basisDigest: string; itemHash: string };
  questionText: string;
  terminalCheckpoint: ProblemTerminalFidelityCheckpoint;
  terminalItemHash: string;
  evidenceHash: string;
  preRecoveryEffectiveCorpusHash: string;
};

type PersistedTerminalRecoveryHydrationSpec = {
  allowlistId: string;
  entryId: string;
  key: string;
  sourcePage: number;
  sourceHash: string;
  contextFrom: number;
  contextTo: number;
  baseProblemRepairArtifact: EvidencePointer & { itemHash: string };
  baseClassificationRepairArtifact: EvidencePointer & { itemHash: string };
  revisionProblemArtifact: EvidencePointer & { itemHash: string };
  revisionClassificationArtifact: EvidencePointer & { itemHash: string };
  revisionBaseQuestionHash: string;
  revisionBaseClassificationHash: string;
  revisionTriggerEvidenceHash: string;
  selected: PersistedTerminalRecoveryGenerationSpec;
  historical: readonly PersistedTerminalRecoveryGenerationSpec[];
  companion?: {
    key: string;
    sourcePage: number;
    contextFrom: number;
    contextTo: number;
    repairHash: string;
    baseProblemRepairArtifact: EvidencePointer & { itemHash: string };
    baseClassificationRepairArtifact: EvidencePointer & { itemHash: string };
    revisionProblemArtifact: EvidencePointer & { itemHash: string };
    revisionClassificationArtifact: EvidencePointer & { itemHash: string };
    selected: PersistedTerminalRecoveryGenerationSpec;
    finalAudit: EvidencePointer & { auditDigest: string };
    finalEffectiveCorpusHash: string;
    finalTerminal: ProblemTerminalFidelityCheckpoint;
  };
};

type ProblemTerminalFidelityAdjudicationSpec = {
  allowlistId: string;
  parentKind: "manual" | "repair" | "scope-box";
  parentManualAllowlistId?: string;
  parentScopeBoxAllowlistId?: string;
  parentScopeAdjudicationHash?: string;
  parentScopeBoxEvidenceHash?: string;
  entryId: string;
  key: string;
  sourcePage: number;
  sourceHash: string;
  solutionSourceHash: string;
  parentQuestionHash: string;
  parentClassificationHash: string;
  parentProblemArtifactPath: string;
  parentProblemArtifactHash: string;
  parentClassificationArtifactPath: string;
  parentClassificationArtifactHash: string;
  baseProblemCheckpointPath?: string;
  baseProblemCheckpointHash?: string;
  baseClassificationCheckpointPath?: string;
  baseClassificationCheckpointHash?: string;
  baseSolutionCheckpointPath?: string;
  baseSolutionCheckpointHash?: string;
  baseQuestionHash?: string;
  baseClassificationHash?: string;
  baseSolutionItemHash?: string;
  officialRawAnswerHash?: string;
  solutionContextFrom?: number;
  solutionContextTo?: number;
  failedTerminalPath: string;
  failedTerminalArtifactHash: string;
  failedEffectiveCorpusHash: string;
  failedInputHash: string;
  failedTerminalInputHash: string;
  failedItemHash: string;
  failedEvidenceHash: string;
  failedScopeEvidenceHash: string;
  failedStatus?: ProblemTerminalFidelityItem["status"];
  expectedScopeDecision?: ProblemTerminalFidelityItem["scopeDecision"];
  policyRevision?: ProblemTerminalFidelityPolicyRevisionSpec;
};

type ProblemTerminalFidelityPolicyRevisionSpec = {
  allowlistId: string;
  parentAdjudicationArtifactPath: string;
  parentAdjudicationArtifactHash: string;
  parentAdjudicationBasisDigest: string;
  parentAdjudicationItemHash: string;
  parentAdjudicationEvidenceHash: string;
  parentAdjudicationScopeEvidenceHash: string;
  parentAdjudicationPromptHash: string;
  curriculumRulesHash: string;
  expectedItem: ProblemTerminalFidelityItem;
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

const PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_ALLOWLIST:
readonly ProblemRepairPositiveScopeAdjudicationSpec[] = [{
  allowlistId: "ebsi-5772822-q10-repair-positive-scope-v1",
  entryId: "ebsi:5772822",
  key: "3:10",
  sourcePage: 3,
  sourceHash: "fa4a52e9b15510c1ee3e37da0fcb509f203587e15f0baf7797ecf30608fb2f03",
  solutionSourceHash: "57002552ef8099128b23b2c336946616eded2a741a432fd41919e3e6a6bfa2a9",
  expectedCanonicalSubject: "math_A",
  allowedAchievementCodes: ["12수학Ⅱ03-04"],
}] as const;

const PROBLEM_REVISION_SCOPE_ADJUDICATION_ALLOWLIST: readonly ProblemScopeAdjudicationSpec[] = [{
  allowlistId: "ebsi-5854872-q5-revision-scope-v1",
  entryId: "ebsi:5854872",
  key: "1:5",
  sourcePage: 1,
  sourceHash: "983b160d8149a02aadc8be8e2f6791fb3ed0db7e0055f3be0929fc8029556b47",
  solutionSourceHash: "005b3a21fe032c74f63604f7d6dc68099f22dff0d2981a85a2fb6179435d5a7c",
  parentProblemArtifactHash: "da793744650ed65a79de220d4e51f746cecb39b9e932aa6829a39a977edcd7a0",
  parentClassificationArtifactHash: "84e8fb1957108e36433a5afae777dc230d0cab3dee0a5cb18481a5010247cdf5",
  terminalArtifactHash: "59fe7d9b37963f6dfc84f47815aba628492d3c468e06a8ab1fff330236aa37a4",
}, {
  allowlistId: "ebsi-5875878-q30-revision-scope-v1",
  entryId: "ebsi:5875878",
  key: "12:30",
  sourcePage: 12,
  sourceHash: "6b554bbb4cfbe16d492c76be41793d64d5fa0fdaae1aaf109aafee3bab99ea59",
  solutionSourceHash: "223c02f244c22c598e0cb72285d611c03695c133c29000b9dceb5068c43b701d",
  parentProblemArtifactHash: "2dd552325794fc05dc07f584edc440cf7e948462e6eeb1260efee7d507c62a9e",
  parentClassificationArtifactHash: "ee67e5c39a90b391b32b1779f00e3e86e2189571cc82d50741cfec00f4d9dd81",
  terminalArtifactHash: "25f8d116b90e7a17e768a264bce2d72dc0e426e178e71ac27b37bbd650f3e521",
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

const Q9_WRITING_PLAN_FIGURE_DESCRIPTION =
  "공식 4쪽 왼쪽의 스프링 노트형 ‘작문 일지’ 도식이다. 중앙 원에는 위에서부터 ‘그릿’, " +
  "‘Grit’이 적혀 있다. 중앙에서 세 갈래 곡선이 뻗는다. 왼쪽 위 ‘실천’ 가지에는 ⓐ ‘나의 경험 " +
  "제시’와 ⓑ ‘실천 권유하기’, 오른쪽 ‘개념’ 가지에는 ⓔ ‘학자들의 견해 비교’, 왼쪽 아래 ‘강연’ " +
  "가지에는 ⓒ ‘강연 핵심 요약’과 ⓓ ‘강연을 들은 후 변화된 생각’이 연결되어 있다. ⓐ, ⓑ, ⓒ, " +
  "ⓓ, ⓔ는 각각 정확히 한 번 보인다.";

const Q27_FAILED_QUESTION = [
  "(가)",
  "",
  "만약에 나라는 사람을 유심히 들여다본다고 하자",
  "그러면 나는 내가 시와는 반역된 생활을 하고 있다는 것을",
  "알 것이다",
  "",
  "먼 산정에 서 있는 마음으로 나의 자식과 나의 아내와",
  "그 주위에 놓인 잡스러운 물건들을 본다",
  "",
  "그리고",
  "나는 이미 정해진 물체만을 보기로 결심하고 있는데",
  "만약에 또 어느 나의 친구가 와서 나의 꿈을 깨워 주고",
  "나의 그릇됨을 꾸짖어 주어도 좋다",
  "",
  "함부로 흘리는 피가 싫어서",
  "이지러 낡아빠진 생활을 하는 것은 아니라라",
  "먼지 낀 잡초 우에",
  "잠자는 구름이여",
  "고생도 마음대로 할 수 없는 세상에서는",
  "철 늦은 거미같이 존재 없이 살기도 어려운 일",
  "",
  "[A]",
  "방 두 칸과 마루 한 칸과 말쑥한 부엌과 애처로운 처를",
  "거느리고",
  "외양만이라도 남과 같이 살아간다는 것이 이다지도 쑥스러울 수가 있을까",
  "",
  "시를 배반하고 사는 마음이여",
  "자기의 나체를 더듬어 보고 살펴볼 수 없는 시인처럼 비참한",
  "사람이 또 어디 있을까",
  "거리에 나와서 집을 보고 집에 앉아서 거리를 그리던 어리석음도 이제는 모두 사라졌나 보다",
  "날아간 제비와 같이",
  "",
  "날아간 제비와 같이 자국도 꿈도 없이",
  "어디로인지 알 수 없으나",
  "어디로이든 가야 할 반역의 정신",
  "",
  "나는 지금 산정에 있다 ―",
  "시를 반역한 죄로",
  "이 메마른 산정에서 오랫동안 꿈도 없이 바라보아야 할 구름",
  "그리고 그 구름의 파수병인 나.",
  "",
  "― 김수영, 「구름의 파수병」 ―",
  "",
  "(가)를 이해한 내용으로 적절하지 않은 것은?",
].join("\n");

const Q27_CORRECTED_QUESTION = [
  "[27 ~ 32] 다음 글을 읽고 물음에 답하시오.",
  "",
  "(가)",
  "만약에 나라는 사람을 유심히 들여다본다고 하자",
  "그러면 나는 내가 시와는 반역된 생활을 하고 있다는 것을",
  "알 것이다",
  "",
  "먼 산정에 서 있는 마음으로 나의 자식과 나의 아내와",
  "그 주위에 놓인 잡스러운 물건들을 본다",
  "",
  "그리고",
  "나는 이미 정해진 물체만을 보기로 결심하고 있는데",
  "만약에 또 어느 나의 친구가 와서 나의 꿈을 깨워 주고",
  "나의 그릇됨을 꾸짖어 주어도 좋다",
  "",
  "함부로 흘리는 피가 싫어서",
  "이다지 낡아빠진 생활을 하는 것은 아니리라",
  "먼지 낀 잡초 우에",
  "잠자는 구름이여",
  "고생도 마음대로 할 수 없는 세상에서는",
  "철 늦은 거미같이 존재 없이 살기도 어려운 일",
  "",
  "[A]",
  "방 두 칸과 마루 한 칸과 말쑥한 부엌과 애처로운 처를",
  "거느리고",
  "외양만이라도 남과 같이 살아간다는 것이 이다지도 쑥스러울 수가 있을까",
  "",
  "시를 배반하고 사는 마음이여",
  "자기의 나체를 더듬어 보고 살펴볼 수 없는 시인처럼 비참한",
  "사람이 또 어디 있을까",
  "거리에 나와서 집을 보고 집에 앉아서 거리를 그리던 어리석음도 이제는 모두 사라졌나 보다",
  "날아간 제비와 같이",
  "",
  "날아간 제비와 같이 자국도 꿈도 없이",
  "어디로인지 알 수 없으나",
  "어디로이든 가야 할 반역의 정신",
  "",
  "나는 지금 산정에 있다 ―",
  "시를 반역한 죄로",
  "이 메마른 산정에서 오랫동안 꿈도 없이 바라보아야 할 구름",
  "그리고 그 구름의 파수병인 나.",
  "",
  "- 김수영, ｢구름의 파수병｣ -",
  "",
  "(나)",
  "함이정 : 처녀 때 난 생각했었지. 영리하고 듬직한 아들 하나 있으면 얼마나 좋을까…… 기쁜 일 슬픈 일 뭐든지 의논할 수 있는 내 아들…… 그러다가 너를 느꼈고…… 네 느낌과 이야기하길 즐겼다. 사람들은 나 혼자 중얼중얼거린다고 괴상하게 보더라. 사실은 너와 나, 둘이서 함께 말하고 있었는데…….",
  "조숭인 : 처음부터 다시 이야기해 주세요, 어머니.",
  "함이정 : 처음부터……?",
  "조숭인 : 네. 제가 태어나기 전, 어머니의 처녀 시절부터요. 그때 두 분 아버지의 관계는 어땠죠?",
  "함이정 : 그땐 좋았다. 두 분 다 우리 집에서 가족처럼 살면서, 우리 아버님한테 불상 제작을 배우는 제자였지. 그런데 어느 날, 스승인 아버님이 불상 제작장에 가 보니까 두 제자들이 자릴 비우고 없었어. 몹시 화가 난 아버님은 집 안으로 들어와 제자들의 이름을 부르셨지. “동연아! 서연아!” 아버님 목소리가 어찌나 쩌렁쩌렁 울렸는지, 천 리 밖까지 들릴 것 같더라.",
  "",
  "(조명, 밝게 변화한다. ⓐ 한가운데 펼쳐 있던 천막이 접혀지면서 무대 천장 위로 올라간다. 함묘진의 집. 함묘진이 성난 모습으로 등장한다. 함이정과 조숭인은 서연의 관, 촛대, 향로 등을 무대 밖으로 갖고 나간다.)",
  "",
  "함묘진 : 동연아! 서연아! 어디 있느냐?",
  "함이정 : (무대 밖에서) 여긴 없어요, 아버지.",
  "함묘진 : 여기 집 안에도 없다……?",
  "함이정 : (무대 밖에서) 내가 나가서 찾아올까요?",
  "함묘진 : 넌 가만 있거라. (다시 외쳐 부른다.) 동연아! 서연아!",
  "",
  "(ⓑ 상복을 벗고 밝은 색 옷을 입은 함이정과 조숭인, 무대 안으로 나온다.)",
  "",
  "조숭인 : 할아버지 목청은 왜 저렇게 커요?",
  "함이정 : 귀머거리도 들을 정도야. 그치?",
  "함묘진 : 동연아! 서연아!",
  "",
  "(동연과 서연, 등장한다. 그들은 당황한 모습으로 함묘진 앞에 선다.)",
  "",
  "동연, 서연 : 부르셨습니까?",
  "함묘진 : 작업장엔 너희들이 없더구나!",
  "동연 : 죄송합니다. 잠깐 밖에 나가 있었습니다.",
  "함묘진 : 밖에는 왜?",
  "동연 : 말다툼 때문에…… 서로 의견이 달라서요.",
  "함묘진 : 말다툼?",
  "동연 : 네.",
  "함묘진 : 서연아, 네가 다툰 이유를 말해 봐라.",
  "서연 : 송구스럽습니다…….",
  "함묘진 : 너흰 생각도 행동도 똑같았다. 그런 너희들이 말다툼을 하다니, 도대체 다르다면 뭐가 달랐더냐?",
  "서연 : 동연은 부처의 모습을 만들면, 그 모습 속에 부처의 마음도 있다고 했습니다.",
  "함묘진 : 그런데, 너는?",
  "서연 : 그런데 저는…… 부처의 모습을 만들어도, 부처의 마음이 그 안에 없다면 무슨 소용이 있겠는가 했습니다.",
  "동연 : 사부님, 서연을 꾸짖어 주십시오. 서연은 쓸데없는 주장으로 저를 괴롭힙니다.",
  "",
  "(중략)",
  "",
  "(서연과 함이정, 일어선다. 돌부처를 만들면서 길을 따라간다. 물 흐르는 소리가 점점 가깝게 들려온다. ⓒ 조명, 개울물의 흐름을 나타낸다.)",
  "",
  "함이정 : 개울물이에요, 서연 오빠. 여기서 길은 끊겼어요.",
  "서연 : (개울가로 다가가서 두 손으로 물을 떠서 마시며) 너도 마시렴. 목마를 텐데…….",
  "[B]",
  "함이정 : (서연 곁으로 가서 개울물을 바라본다.) 물 위에 비쳐 보여요, 우리 얼굴이…… 얼굴 뒤엔 구름이…… 구름 뒤엔 하늘이……. (물을 떠서 마신다.) 물이 맑고 시원해요.",
  "",
  "(서연, 장난스럽게 개울물을 마치 눈덩이처럼 뭉치는 동작을 한다.)",
  "",
  "함이정 : 오빠…… 뭘 하는 거죠?",
  "서연 : 물부처를 만든다.",
  "함이정 : 물부처요?",
  "서연 : 돌로도 부처님을 만드는데, 물이라고 안 될 건 없지.",
  "",
  "(서연, 흐르는 물 속으로 들어가 물로 만든 부처를 세워 놓는다. 부처의 느낌은 남고 형태는 사라진다.)",
  "",
  "함이정 : 오빠, 이쪽으로 나와요.",
  "서연 : (개울물을 건너가며) 난 이제 저쪽으로 간다.",
  "함이정 : 서연 오빠…….",
  "서연 : 넌 나중에 건너와.",
  "함이정 : (손을 흔든다.) 그래요, 오빠…… 먼저 가요. 나는 나중에…….",
  "",
  "(서연과 함이정, 잠시 개울물 양쪽에서 서로를 바라본다. ⓓ 조숭인이 피아노 앞에 앉아 건반을 두드리며 작곡 중이다. 개울물 건너쪽, 눈부시도록 밝아진다. 때를 놓치지 않으려는 듯 함묘진이 다급하게 휠체어 바퀴를 굴리면서 들어온다. 그는 피아노 옆을 지나 개울물을 건너간다. / 코러스(돌부처)들, 개울물을 건너가는 서연을 배웅하듯이, 따라가듯이, 마중하듯이, 서연과 함께 어우러져 춤을 추며 간다. 개울 저쪽, 눈부시도록 빛이 밝다. ⓔ 함묘진이 다급하게 휠체어 바퀴를 굴리며 들어온다.)",
  "",
  "조숭인 : 할아버지, 어딜 그렇게 급히 가세요?",
  "함묘진 : 극락문이 열렸다! 극락문이 열렸어!",
  "",
  "(함묘진, 휠체어에서 일어난다. 그는 서연의 뒤를 따라 빛 안으로 들어간다. 무대 조명, 변화한다. 동연, 등장한다. 그는 조숭인에게 다가와서 전보 용지를 내놓는다.)",
  "",
  "- 이강백, ｢느낌, 극락같은｣ -",
  "",
  "27. (가)를 이해한 내용으로 적절하지 않은 것은?",
].join("\n");

const Q27_FIGURE_DESCRIPTION =
  "공식 10쪽 왼쪽 (가)의 ‘방 두 칸과 마루 한 칸과 말쑥한 부엌과 애처로운 처를’부터 " +
  "‘외양만이라도 남과 같이 살아간다는 것이 이다지도 쑥스러울 수가 있을까’까지의 오른쪽에는 " +
  "왼쪽으로 열린 세로 묶음 괄호 [A]가 하나 있다. 공식 11쪽 왼쪽 (나)의 함이정 대사 ‘물 위에 " +
  "비쳐 보여요, 우리 얼굴이……’부터 ‘물이 맑고 시원해요.’까지의 오른쪽에는 같은 모양의 세로 " +
  "묶음 괄호 [B]가 하나 있다. [A]와 [B]는 각각 정확히 한 번 보이며, 두 괄호는 29번에서 두 " +
  "부분을 비교하는 표지이다.";

const Q43_FAILED_QUESTION = [
  "다음 글을 읽고 물음에 답하시오.",
  "",
  "(가)",
  "시를 믿고 어떻게 살아가나",
  "서른 먹은 사내가 하나 잠을 못 잔다.",
  "먼— 기적(汽笛) 소리 차마를 스쳐가고",
  "잠들은 아내와 어린것의 베개 밑에",
  "밤눈이 내려 쌓이나 보다.",
  "무수한 손에 뺨을 얻어맞으며",
  "항시 곤두박질해 온 생활의 노래",
  "지나는 돌팔매에도 이제는 피곤하다.",
  "먹고 산다는 것,",
  "너는 언제까지 나를 쫓아오느냐.",
  "",
  "등불을 켜고 일어나 앉는다.",
  "담배를 피워 문다.",
  "쓸쓸한 것이 오장을 씻어 내린다.",
  "노신(魯迅)이여",
  "이런 밤이면 그대가 생각난다.",
  "온— 세계가 눈물에 젖어 있는 밤",
  "상해(上海) 호마로(胡馬路) 어느 뒷골목에서",
  "쓸쓸히 앉아 지키던 등불",
  "등불이 나에게 속삭거린다.",
  "여기 하나의 상심(傷心)한 사람이 있다.",
  "여기 하나의 굳세게 살아온 인생이 있다.",
  "— 김광균, 「노신」 —",
  "",
  "(나)",
  "춥고 쓸쓸하여 몽당비자루 같은 날",
  "운암댐 소줏집에 서서",
  "날개소리 가득히 내리는 청둥오리떼 본다",
  "혼자 보기는 아슴차니 미안하여",
  "그리운 그리운 이 그리며 본다",
  "우리가 춥다고 버리고 싶은 세상에",
  "내가 침 뱉고 오줌 내갈긴",
  "그것도 살얼음 깔려드는 수면 위에",
  "머언 먼 순순의 눈나라에서나 배웠음직한 몸짓이랑",
  "카랑카랑 별빛 속에서 익혔음직한 목소리들을 풀어놓는",
  "별, 별, 새, 새, 들, 을, 본다",
  "물속에 살며 물에 젖지 않는",
  "얼음과 더불어 살며 얼지 않는 저 어린 날개들이",
  "건너왔을 바다와 눈보라를 생각하며",
  "비상을 위해 뼈 속까지 비워둔 고행과",
  "한 점 기름기마저 깃털로 바꾼 새들의 가난을 생각하는데",
  "물가의 진창에도 푹푹 빠지는",
  "아, 나는 얼마나 무거운 것이냐",
  "내 관절통은 또 얼마나 호사스러운 것이냐",
  "그리운 이여,",
  "네 가슴에 못 박혀 살고 싶은 속된 내 그리움은 또",
  "얼마나 얕은 것이냐",
  "한 무리의 새떼는 또",
  "초승달에 결승문자 몇 개 그리며 가뭇없는",
  "더 먼 길 떠난다 이 밤사",
  "나는 옷을 더 벗어야겠구나",
  "저 운하의 겨울새들의 행로를 보아버린 죄로",
  "이 밤으로 돌아가",
  "더 추워야겠다 나는",
  "한껏 가난해져야겠다",
  "— 복효근, 「새에 대한 반성문」 —",
  "",
  "(가)와 (나)의 공통점에 대한 설명으로 가장 적절한 것은?",
].join("\n");

const Q43_CORRECTED_QUESTION = [
  "[43 ~ 45] 다음을 읽고 물음에 답하시오.",
  "",
  "(가)",
  "시를 믿고 어떻게 살어가나",
  "서른 먹은 사내가 하나 잠을 못 잔다.",
  "",
  "먼― 기적(汽笛) 소리 처마를 스쳐가고",
  "잠들은 아내와 어린것의 벼개 맡에",
  "밤눈이 내려 쌓이나 보다.",
  "무수한 손에 뺨을 얻어맞으며",
  "항시 곤두박질해 온 생활의 노래",
  "지나는 돌팔매에도 이제는 피곤하다.",
  "먹고 산다는 것,",
  "너는 언제까지 나를 쫓아오느냐.",
  "",
  "등불을 켜고 일어나 앉는다.",
  "담배를 피워 문다.",
  "쓸쓸한 것이 오장을 씻어 내린다.",
  "노신(魯迅)이여",
  "이런 밤이면 그대가 생각난다.",
  "온― 세계가 눈물에 젖어 있는 밤",
  "상해(上海) 호마로(胡馬路) 어느 뒷골목에서",
  "쓸쓸히 앉아 지키던 등불",
  "등불이 나에게 속삭어린다.",
  "여기 하나의 상심(傷心)한 사람이 있다.",
  "여기 하나의 굳세게 살아온 인생이 있다.",
  "- 김광균, ｢ 노신 ｣ -",
  "",
  "(나)",
  "[A]",
  "춥고 쓸쓸함이 몽당빗자루 같은 날",
  "운암댐 소롯길에 서서",
  "날개소리 가득히 내리는 청둥오리떼 본다",
  "혼자 보기는 아슴찬히 미안하여",
  "그리운 그리운 이 그리며 본다",
  "우리가 춥다고 버리고 싶은 세상에",
  "내가 침 뱉고 오줌 내갈긴",
  "그것도 살얼음 깔려드는 수면 위에",
  "머언 먼 순은의 눈나라에서나 배웠음직한 몸짓이랑",
  "카랑카랑 별빛 속에서 익혔음직한 목소리들을 풀어놓는",
  "별, 별, 새, 새, 들, 을, 본다",
  "[B]",
  "물속에 살며 물에 젖지 않는",
  "얼음과 더불어 살며 얼지 않는 저 어린 날개들이",
  "건너왔을 바다와 눈보라를 생각하며",
  "비상을 위해 뼈 속까지 비워둔 고행과",
  "한 점 기름기마저 깃털로 바꾼 새들의 가난을 생각하는데",
  "물가의 진창에도 푹푹 빠지는",
  "아, 나는 얼마나 무거운 것이냐",
  "내 관절통은 또 얼마나 호사스러운 것이냐",
  "그리운 이여,",
  "네 가슴에 못 박혀 삭고 싶은 속된 내 그리움은 또",
  "얼마나 얕은 것이냐",
  "[C]",
  "한 무리의 새떼는 또",
  "초승달에 결승문자 몇 개 그리며 가뭇없는",
  "더 먼 길 떠난다 이 밤사",
  "나는 옷을 더 벗어야겠구나",
  "저 운암의 겨울새들의 행로를 보아버린 죄로",
  "이 밤으로 돌아가",
  "더 추워야겠다 나는",
  "한껏 가난해져야겠다",
  "- 복효근, ｢ 새에 대한 반성문 ｣ -",
  "",
  "43. (가)와 (나)의 공통점에 대한 설명으로 가장 적절한 것은?",
].join("\n");

const Q43_FIGURE_DESCRIPTION =
  "공식 16쪽 왼쪽의 (나) 시 오른쪽에는 왼쪽으로 열린 세로 묶음 괄호가 정확히 3개 있고, " +
  "위에서부터 서로 겹치지 않는 [A], [B], [C] 순서이다. [A]는 ‘춥고 쓸쓸함이 몽당빗자루 " +
  "같은 날’부터 " +
  "‘별, 별, 새, 새, 들, 을, 본다’까지, [B]는 ‘물속에 살며 물에 젖지 않는’부터 ‘얼마나 얕은 " +
  "것이냐’까지, [C]는 ‘한 무리의 새떼는 또’부터 ‘한껏 가난해져야겠다’까지를 묶는다. 각 괄호는 " +
  "오른쪽 세로선 하나와 왼쪽으로 뻗은 위·아래 가로 캡으로 이루어지며, 세 구획은 45번에서 시의 " +
  "부분별 내용을 가리키는 역할을 한다.";

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
  {
    allowlistId: "ebsi-5854871-q9-manual-v1",
    entryId: "ebsi:5854871",
    key: "2:9",
    sourcePage: 2,
    sourceHash: "c41b1ee2f3897cbde107c4ffcdec493583bacba4d14299c6c3a6a749b29a80d6",
    parentKind: "recovery",
    dpi: 600,
    failedQuestionHash: "3356445be5f6d28b112a307219a83cba0fefc3a8f88c30e01e2d2319498c81c1",
    failedClassificationHash: "05631d32ad85d81966ba0d935b7b5e98858d9aa5e861d6e50f1eb0d0df7bd149",
    failedClassificationEvidenceHash: "ebd86a0ffac00b7eb2ca70f0579e27ac4cbd9bf13e409b12c0d8904d0dff4791",
    views: [
      { sourcePage: 2, label: "p2 full", rect: [0, 0, 1, 1] },
      { sourcePage: 2, label: "p2 Q9 stem and dialogue", rect: [0.49, 0.08, 0.95, 0.34] },
      { sourcePage: 2, label: "p2 Q9 map", rect: [0.49, 0.28, 0.95, 0.57] },
    ],
    requiredTokens: [
      "지도의 A~E에서", "여름 방학에 우리 어디로 여행 갈까?", "우리나라보다 덥지 않은 국가가 좋겠어.",
      "우리나라와의 시차가 작을수록 적응하기 쉬울 것 같아.", "그럼 ㉠ 이/가 좋겠네.",
      "A는 노르웨이", "B는 베트남", "C는 뉴질랜드", "D는 아르헨티나", "E는 베네수엘라",
      "세로 경선 0°와 180°", "적도", "① A", "⑤ E",
    ],
    replacements: [
      {
        field: "question",
        from: "국가를 지도에서 A~E에서 고른 것은?",
        to: "국가를 지도의 A~E에서 고른 것은?",
        count: 1,
      },
      { field: "figure_description", from: "A는 영국", to: "A는 노르웨이", count: 1 },
      { field: "figure_description", from: "B는 필리핀", to: "B는 베트남", count: 1 },
      {
        field: "figure_description",
        from: "E는 콜롬비아 서쪽의 좁은 지협에 있는 파나마",
        to: "E는 베네수엘라",
        count: 1,
      },
    ],
    figure: true,
    expectedDecision: "accept",
    expectedCanonicalSubject: "integrated_social",
  },
  {
    allowlistId: "ebsi-5594499-q9-manual-v1",
    entryId: "ebsi:5594499",
    key: "4:9",
    sourcePage: 4,
    sourceHash: "0ddccee92ce4e4ba3da53ed253e780cd7b41b5962f7e9761a920079619f81c31",
    parentKind: "recovery",
    dpi: 600,
    failedQuestionHash: "6b45bc49e5f0e87b14c8b93fc23e845b668bd8185af847c9929021235f6a8759",
    failedClassificationHash: "edcc2b22f6c3f1eaadb0c655063e5f189fb63cd032b49384ae59eb0431c1303b",
    failedClassificationEvidenceHash: "b561d9f0243616732324e197fb3bde8d2a19120e5988a003a4041389008077ce",
    views: [
      { sourcePage: 4, label: "p4 full", rect: [0, 0, 1, 1] },
      { sourcePage: 4, label: "p4 left full Q9-Q10", rect: [0.08, 0.08, 0.51, 0.98] },
      { sourcePage: 4, label: "p4 writing-plan diagram", rect: [0.09, 0.13, 0.50, 0.49] },
      { sourcePage: 4, label: "p4 draft passage", rect: [0.08, 0.47, 0.51, 0.89] },
      { sourcePage: 4, label: "p4 Q9 prompt and choices", rect: [0.08, 0.88, 0.51, 0.98] },
    ],
    requiredTokens: [
      "[9 ~ 10] 다음을 읽고 물음에 답하시오.", "[글의 구상 도식]", "그릿 / Grit",
      "ⓐ 나의 경험 제시", "ⓑ 실천 권유하기", "ⓒ 강연 핵심 요약",
      "ⓓ 강연을 들은 후 변화된 생각", "ⓔ 학자들의 견해 비교",
      "천재들만 받는다는 맥아더 펠로상의 수상자",
      "그리고 노력하면 무엇이든 할 수 있다는 주변의 막연한 충고는 마음에 와 닿지 않았다.",
      "㉠ 그릿", "㉡ 그릿", "㉢ 주목", "㉣ 그러나", "㉤ 떠올리고",
      "‘작문 일지’에 기록한 내용 중 초고에 반영되지 않은 것은?", "① ⓐ", "⑤ ⓔ",
      "ⓐ, ⓑ, ⓒ, ⓓ, ⓔ는 각각 정확히 한 번 보인다.",
    ],
    replacements: [
      {
        field: "question",
        from: "[작문 과제]",
        to: "[9 ~ 10] 다음을 읽고 물음에 답하시오.\n\n[작문 과제]",
        count: 1,
      },
      {
        field: "question",
        from: "- 중심 주제: 그릿(Grit)\n- 실천: ⓐ 나의 경험 제시, ⓑ 실천 권유하기\n" +
          "- 개념: ⓔ 학자들의 견해 비교\n- 강연: ⓒ 강연 핵심 묘사, ⓓ 강연을 들은 후 변화된 생각",
        to: "[글의 구상 도식]\n- 중앙: 그릿 / Grit\n- 실천: ⓐ 나의 경험 제시, ⓑ 실천 권유하기\n" +
          "- 개념: ⓔ 학자들의 견해 비교\n- 강연: ⓒ 강연 핵심 요약, ⓓ 강연을 들은 후 변화된 생각",
        count: 1,
      },
      {
        field: "question",
        from: "천재들만 받는다는 ‘맥아더 펠로상’의 수상자",
        to: "천재들만 받는다는 맥아더 펠로상의 수상자",
        count: 1,
      },
      {
        field: "question",
        from: "그리고 노력하면 무엇이든 할 수 있다는 주변의 말에도 쉽사리 마음에 와 닿지 않았다.",
        to: "그리고 노력하면 무엇이든 할 수 있다는 주변의 막연한 충고는 마음에 와 닿지 않았다.",
        count: 1,
      },
      { field: "question", from: "㉠그릿", to: "㉠ 그릿", count: 1 },
      { field: "question", from: "㉡그릿", to: "㉡ 그릿", count: 1 },
      { field: "question", from: "㉢주목", to: "㉢ 주목", count: 1 },
      { field: "question", from: "㉣그러나", to: "㉣ 그러나", count: 1 },
      { field: "question", from: "㉤떠올리고", to: "㉤ 떠올리고", count: 1 },
    ],
    figure: true,
    figureDescription: Q9_WRITING_PLAN_FIGURE_DESCRIPTION,
    expectedDecision: "reject",
  },
  {
    allowlistId: "ebsi-5577054-q43-manual-v1",
    entryId: "ebsi:5577054",
    key: "16:43",
    sourcePage: 16,
    sourceHash: "d7664675fc1e39cc99f507d6cc7bf7c4a1404106d140d9a2f904726ddec4c062",
    parentKind: "recovery",
    dpi: 600,
    failedQuestionHash: "59b3c10380338bed7ed9fcdcdf746d30cccddff38cce54d0c98c7b9fa4722bfb",
    failedClassificationHash: "2ab2adbb09b41ba0d2132884eced5bb7b37ac2165e78fa1af7f7035db36b754a",
    failedClassificationEvidenceHash: "2c4d68caf7e676fb28981f61fb1186ad56440a33525c46e2fc5de033ec6d8be7",
    views: [
      { sourcePage: 15, label: "p15 bottom-right shared passage start", rect: [0.50, 0.82, 0.95, 0.98] },
      { sourcePage: 16, label: "p16 left full poems and A-B-C brackets", rect: [0.07, 0.10, 0.52, 0.97] },
      { sourcePage: 16, label: "p16 right Q43 stem and choices", rect: [0.50, 0.12, 0.95, 0.32] },
    ],
    requiredTokens: [
      "[43 ~ 45]", "살어가나", "벼개 맡에", "속삭어린다", "[A]", "운암댐 소롯길",
      "순은의", "[B]", "삭고 싶은", "[C]", "저 운암의", "43.",
      "③ 유사한 시구의 변주를 통해 시상을 마무리하여 주제 의식을 강조하고 있다.",
      "- 김광균, ｢ 노신 ｣ -", "- 복효근, ｢ 새에 대한 반성문 ｣ -",
      "왼쪽으로 열린 세로 묶음 괄호가 정확히 3개", "서로 겹치지 않는 [A], [B], [C] 순서",
    ],
    replacements: [{
      field: "question",
      from: Q43_FAILED_QUESTION,
      to: Q43_CORRECTED_QUESTION,
      count: 1,
    }],
    figure: true,
    figureDescription: Q43_FIGURE_DESCRIPTION,
    expectedDecision: "accept",
    expectedCanonicalSubject: "korean_literature",
  },
  {
    allowlistId: "ebsi-5525982-q27-manual-v1",
    entryId: "ebsi:5525982",
    key: "11:27",
    sourcePage: 11,
    sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
    parentKind: "recovery",
    parentRecoveryEvidenceHash: "186e1381194aab5765fc72d88fb3e9a85901867d4a398588c7e38aa7f463dfdb",
    dpi: 600,
    failedQuestionHash: "11c3fa247bebf72d1991540323f100af892ebc44cb36c2afa945ddcadd3524fd",
    failedClassificationHash: "c3897a3e3da84d3821a60e35531c9628644c089511f7247fdebfaa474e00e533",
    failedClassificationEvidenceHash: "1dd2fef4a66d356b6887c6d07b5eec3ea226531a9b83040741b68ed63cec58fc",
    views: [
      { sourcePage: 10, label: "p10 full", rect: [0, 0, 1, 1] },
      { sourcePage: 10, label: "p10 left (가) and start of (나)", rect: [0.07, 0.11, 0.50, 0.96] },
      { sourcePage: 10, label: "p10 right (나) continuation", rect: [0.50, 0.11, 0.95, 0.97] },
      { sourcePage: 11, label: "p11 left (나) continuation and Q27", rect: [0.07, 0.10, 0.50, 0.97] },
    ],
    requiredTokens: [
      "[27 ~ 32] 다음 글을 읽고 물음에 답하시오.",
      "이다지 낡아빠진 생활을 하는 것은 아니리라", "- 김수영, ｢구름의 파수병｣ -",
      "함이정", "조숭인", "ⓐ", "ⓑ", "(중략)", "ⓒ", "ⓓ", "ⓔ",
      "때를 놓치지 않으려는 듯", "- 이강백, ｢느낌, 극락같은｣ -",
      "27. (가)를 이해한 내용으로 적절하지 않은 것은?",
      "③ 화자는 ‘고생도 마음대로 할 수 없는 세상’에서 ‘존재 없이’ 살아가는 것이 어렵다고 느끼고 있다.",
      "왼쪽으로 열린 세로 묶음 괄호 [A]", "같은 모양의 세로 묶음 괄호 [B]",
      "[A]와 [B]는 각각 정확히 한 번",
    ],
    replacements: [{
      field: "question",
      from: Q27_FAILED_QUESTION,
      to: Q27_CORRECTED_QUESTION,
      count: 1,
    }, {
      field: "choices",
      from: "③ 화자는 ‘고생도 마음대로 할 수 없는 세상’에서 ‘존재 없이 살아가는 것이 어렵다’고 느끼고 있다.",
      to: "③ 화자는 ‘고생도 마음대로 할 수 없는 세상’에서 ‘존재 없이’ 살아가는 것이 어렵다고 느끼고 있다.",
      count: 1,
    }],
    figure: true,
    figureDescription: Q27_FIGURE_DESCRIPTION,
    expectedDecision: "accept",
    expectedCanonicalSubject: "korean_literature",
  },
] as const;

const PROBLEM_MANUAL_REVISION_ALLOWLIST: readonly ProblemManualRevisionSpec[] = [{
  allowlistId: "ebsi-5578421-q30-manual-revision-v1",
  parentAllowlistId: "ebsi-5578421-q30-manual-v1",
  entryId: "ebsi:5578421",
  key: "12:30",
  sourcePage: 12,
  sourceHash: "4c9aee0ec0c15f91678bc3c179efb4c781ab0f9023ca2e5347df94060012272e",
  failedQuestionHash: "08ac10119b14fcad17f0d4f8f988198d8049d2d06d19b3b16cfd4d805e4ba010",
  failedClassificationHash: "b9134b6b9fd3cd9e274bd4883f370dd794f1c5f0d2e7d573d1d2b949dcff9ff7",
  failedClassificationEvidenceHash: "e96fd127cbadd152281d8bf436e2052d15863abdf208b06af9c650e68b3c6c13",
  replacement: {
    field: "question",
    from: "그리고 단순 명제 ‘$p$’와 ‘$q$’를 ‘만약 …이면 …이다.’에 해당하는 논리적 연결사",
    to: "그리고 단순 명제 ‘$p$’와 ‘$q$’는 ‘만약 …이면 …이다.’에 해당하는 논리적 연결사",
    count: 1,
  },
  requiredTokens: [
    "그리고 단순 명제 ‘$p$’와 ‘$q$’는 ‘만약 …이면 …이다.’에 해당하는 논리적 연결사",
    "(4′) $p \\to q$", "⇒", "가로선은 총 2개", "30. 윗글의 내용과 일치하지 않는 것은?",
  ],
  expectedDecision: "accept",
  expectedCanonicalSubject: "korean_reading",
}, {
  allowlistId: "ebsi-5656593-q18-manual-revision-v1",
  parentAllowlistId: "ebsi-5656593-q18-manual-v1",
  entryId: "ebsi:5656593",
  key: "7:18",
  sourcePage: 7,
  sourceHash: "e1b0ffd692634a4a2b1500877691cf0f4ff622fb85c6dd1dba4aff65dfd29e1d",
  failedQuestionHash: "2ee7a2fc3b6ac355c2e88de3cec5005d6f31b6caf1dd042019190d05dca06484",
  failedClassificationHash: "cd8e788264d66fb0413604efbff3b1fdfef2c968d3f79fbb377df8bbaab67c26",
  failedClassificationEvidenceHash: "1bdb0cdfbb305d5407cdb8d711efec1e2291cf2ef8a07026f2ee64781f8f8316",
  replacement: {
    field: "question",
    from: "세 점 $L_1$, $M_1$, $N_1$이 각각 $\\overline{A_1B_1}$, $\\overline{B_1C_1}$, " +
      "$\\overline{C_1A_1}$의 중점이고,",
    to: "세 선분 $A_1B_1$, $B_1C_1$, $C_1A_1$의 중점을 각각 $L_1$, $M_1$, $N_1$이라 하고,",
    count: 1,
  },
  requiredTokens: [
    "세 선분 $A_1B_1$, $B_1C_1$, $C_1A_1$의 중점을 각각 $L_1$, $M_1$, $N_1$이라 하고,",
    "호 $\\overset{\\frown}{N_1L_1}$", "호 표기는 정확히 2회",
    "읽는 순서는 단일, 단일, 복합, 복합", "$R_1$", "$R_2$", "$R_3$",
    "① $\\dfrac{3(3\\sqrt{3}-\\pi)}{11}$", "⑤ $\\dfrac{4(3\\sqrt{3}-\\pi)}{11}$",
  ],
  expectedDecision: "reject",
}] as const;

const PROBLEM_SCOPE_BOX_REVISION_ALLOWLIST: readonly ProblemScopeBoxRevisionSpec[] = [{
  allowlistId: "ebsi-5577055-q11-scope-box-v1",
  entryId: "ebsi:5577055",
  key: "4:11",
  sourcePage: 4,
  sourceHash: "b4381bc3b831323375b2c4a25319d308185c930be5d2e3b07dfc28e7646a5fde",
  solutionSourceHash: "1753328f4b4360a9d81312d0d1610c7a11063bbefeeb1e1fd286d54c601ec5fa",
  dpi: 600,
  parentScopeAllowlistId: "ebsi-5577055-q11-scope-v1",
  problemContextFrom: 1,
  problemContextTo: 12,
  solutionContextFrom: 1,
  solutionContextTo: 5,
  views: [{ sourcePage: 4, label: "p4 Q11 full stem, graph, and choices", rect: [0.07, 0.12, 0.50, 0.36] }],
  requiredTokens: [
    "그림과 같이", "$y=\\log_a x$", "$y=\\log_b x$", "$A_1$", "$B_1$", "$A_2$", "$B_2$",
    "① $4$", "② $3\\sqrt{2}$", "③ $5$", "④ $4\\sqrt{2}$", "⑤ $6$",
  ],
  parentRecoveryProblemArtifactPath:
    "problem-recoveries/v1-0004-0011-ef16b79daa0092271e08115134f3abed299876f92e55c3de40b5cd6e9f8abaa3.json",
  parentRecoveryProblemArtifactHash: "d7d890e88390a92cf57e889fa25ae5535e3f5d6a5ddbaf57297f17f1cf60ed22",
  parentRecoveryClassificationArtifactPath:
    "classification-recoveries/v1-0004-0011-725fe18532c9778f0f46f2c2feef23915ad5fcca6145d4118eefb422c7f5c98f-" +
    "7bb7cb863c8c4855.json",
  parentRecoveryClassificationArtifactHash: "a1f29437b63ad5ea709f9cd0f14bc0730f537093c66ee2d357f2c32b41385f5c",
  parentRecoveryClassificationHash: "a58607bd037bd721cc39fb2b7cf83bdc3e58bafdc9f22e21d85aff524f4dc416",
  parentRecoveryEvidenceHash: "9ccbf2036e9e1c538880595fd4ded9a874fd8765659237b65bd20384d93394ac",
  failedScopeArtifactPath:
    "classification-scope-adjudications/v1-0004-0011-421c3b33da14ad95179d2580f1576c0f5a2857484dc4f479433f87f563cb4a2a-" +
    "7bb7cb863c8c4855.json",
  failedScopeArtifactHash: "a91d5a64c9dc71d6ea1b3521d031000c9f20b6c1f9c7ce189ea208b7bb901cc4",
  failedScopeBasisDigest: "421c3b33da14ad95179d2580f1576c0f5a2857484dc4f479433f87f563cb4a2a",
  failedScopeItemHash: "696b03bb458b06aee5067cfded58c8ee6dbebfb43fc2d8a54c3e1371d1a0a50b",
  failedScopeEvidenceHash: "60bc4fbec6a51134bbb064139bc935bf171e63f061dfa0be10e5993752593145",
  triggerTerminalPath:
    "problem-terminal-fidelity/v2-0000-d985797bd348f4389b1b0c12eea3cbea40089022d0afc9f044c9fa8625ec4725-" +
    "214b88235eda18eb60cf4519d3b302f734e4bc0df0781e7a82f8d9801789c900.json",
  triggerTerminalArtifactHash: "21ffd24df607447fa062090d8fd7c075f334473060ab75b6b7072f6632004900",
  triggerEffectiveCorpusHash: "d985797bd348f4389b1b0c12eea3cbea40089022d0afc9f044c9fa8625ec4725",
  triggerInputHash: "214b88235eda18eb60cf4519d3b302f734e4bc0df0781e7a82f8d9801789c900",
  triggerQuestionInputHash: "13d9bb06b911604a684a1c0bf2bdae0622fc648825b871d54979ce89ab0bffe6",
  triggerItemHash: "1d89d848aaa442ae313dcc6772fd0d42300bddaf8f5e2185798c21a3235c6f9f",
  triggerEvidenceHash: "e4ccdc2cf4881f3607a6402b43783add4e60399c19e90259261dbec0aea445fc",
  triggerScopeEvidenceHash: "ebf198e49c21941c865b5d7b7e7c4e1ef92d366ba695ad108b0ee1c43b061996",
  baseSolutionCheckpointPath: "solution-chunks/v3-0000.json",
  baseSolutionCheckpointHash: "7e463c412565efc1a07c56dc3324da478426ad98822b31c95d586fee87391339",
  baseSolutionItemHash: "ccf1b5bb896164a0466f3b1cd7d3a32463b07b0e640f952c05d14fb04dd74646",
  failedQuestionHash: "a23bd8426e4a628a5a8265bd6f479ab5687cd53f96532ca2c496d72796724201",
  failedClassificationHash: "696b03bb458b06aee5067cfded58c8ee6dbebfb43fc2d8a54c3e1371d1a0a50b",
  beforeBox: [0.12, 0.27],
  afterBox: [0.12, 0.36],
  correctedQuestionHash: "35937a22d01677588672139e66a4e55a58a1711fa2b5ba7541d3181d009518d0",
}] as const;

const PERSISTED_TERMINAL_RECOVERY_HYDRATION_ALLOWLIST:
readonly PersistedTerminalRecoveryHydrationSpec[] = [{
  allowlistId: "ebsi-5656592-q11-terminal-recovery-hydration-v1",
  entryId: "ebsi:5656592",
  key: "4:11",
  sourcePage: 4,
  sourceHash: "b7c932cdae76d06eb9d2efd1dc52f4f48faa378c47a0c1bf573fe90bf3b88ee1",
  contextFrom: 1,
  contextTo: 12,
  baseProblemRepairArtifact: {
    path: "problem-repairs/v2-0004-0011.json",
    sha256: "1c5edf374765105550fd97352e9a7c04e2cddf9d71fa7d75de9e33cae5c55480",
    itemHash: "b0f55f67c2a8f726986b1504a1d7a3de533e698d62a2797f48f04476503aa1c9",
  },
  baseClassificationRepairArtifact: {
    path: "classification-repair-batches/" +
      "v1-0001-0012-82ff6de743dbf11fb3eb87f9462d216aa303d6324c2136f69f024cf63a72dcd7-" +
      "7bb7cb863c8c4855.json",
    sha256: "0413f739e10882f4487b8f4eff808dbf7e70b314aa84d68a6d761f15fefd8ae8",
    itemHash: "8221120aca4a3a26cbaf8d9dc2394ea9afd626c23f975e4a3ca96f5974cc51cd",
  },
  revisionProblemArtifact: {
    path: "problem-revision-batches/" +
      "v1-0001-0012-0004-d75af2aacce6cd1be02091e1bf0855a8245287d6dc0258a23e891013a28ccddb.json",
    sha256: "86ae697758f4fabcda8250d7842c0e223cd7b2da9ee2f08aa04e57fd04dc4963",
    itemHash: "37dca9aef2e093f137a4a3665dd593623ef574811e5f45b0c3b196b7669253a8",
  },
  revisionClassificationArtifact: {
    path: "classification-revision-batches/" +
      "v1-0001-0012-76226ae91e56c033c83850e7ff8695d82791e12cd905b30139c13e5c229af11b-" +
      "7bb7cb863c8c4855.json",
    sha256: "fb28835db1c7a541d4af501a6209eb313759926601d8c7acb421047d9303d8af",
    itemHash: "8fae41af9ee4d58aeca05118eabec6a8c65531870397c46f16cf1d28d1ee1980",
  },
  revisionBaseQuestionHash: "b0f55f67c2a8f726986b1504a1d7a3de533e698d62a2797f48f04476503aa1c9",
  revisionBaseClassificationHash: "8221120aca4a3a26cbaf8d9dc2394ea9afd626c23f975e4a3ca96f5974cc51cd",
  revisionTriggerEvidenceHash: "4ca695f2b7eb383a00320b6049b3ab161fb103f05761ab71852dbb780971c322",
  selected: {
    problemArtifact: {
      path: "problem-recoveries/" +
        "v2-0004-0011-a16c7f3c13454e8f23d75f4e7b53480212e5d06c4125af6c09e7e7c8f68783d8.json",
      sha256: "9c8e2891bd642e9ce9c4652d6615ee0bfcf03b9fd011b2b5ff81cc8dc10e8106",
      basisDigest: "a16c7f3c13454e8f23d75f4e7b53480212e5d06c4125af6c09e7e7c8f68783d8",
      itemHash: "e4e042f87f3264447db8177ec81c6e98958ecbb478dd572b8a233a3243d35480",
    },
    classificationArtifact: {
      path: "classification-recoveries/" +
        "v2-0004-0011-3a56ded3e11de92f106ce8d5e0690e4c8bbb495cc796a4bcec8eed9886a043a9-" +
        "7bb7cb863c8c4855.json",
      sha256: "708aa538a4192c03cb9fc56d6b362301a80c4ffd24abaf7c3865f25b99cade27",
      basisDigest: "3a56ded3e11de92f106ce8d5e0690e4c8bbb495cc796a4bcec8eed9886a043a9",
      itemHash: "3ad72ec2018e03078c46246ea17aa018a60eefd8d24b6462b62ccc05f5d18602",
    },
    questionText: "$0\\le x\\le \\pi$일 때, 방정식 $(\\sin x+\\cos x)^2=\\sqrt{3}\\sin x+1$의 모든 실근의 합은? [3점]",
    terminalCheckpoint: {
      path: "problem-terminal-fidelity/" +
        "v2-0000-b9f1d1f6130bfb155e8e1a9c6b9c399d3b763a669e7a40537f6455da7bd941bd-" +
        "c0fd4e92c73adf737bea28b839e815dddfefd6206fc79be440527e508b18eb43.json",
      sha256: "db4ab968b169a2202c510af97cf1905d7fab6d92eedcec26f04922b1312bd53d",
      from: 1,
      to: 12,
      ownedFrom: 1,
      ownedTo: 12,
      inputHash: "c0fd4e92c73adf737bea28b839e815dddfefd6206fc79be440527e508b18eb43",
    },
    terminalItemHash: "19efe1512c565231fa7664d5800fbb8f4c8ddbbcaaef8ece46c94a892924073b",
    evidenceHash: "83bc6af724504f9a513fffa9d542439c22b81a1d06edbae6ad73fd227da8f9ad",
    preRecoveryEffectiveCorpusHash: "b9f1d1f6130bfb155e8e1a9c6b9c399d3b763a669e7a40537f6455da7bd941bd",
  },
  historical: [{
    problemArtifact: {
      path: "problem-recoveries/" +
        "v2-0004-0011-189d47abd4090fb221f78c7cc9dc94df7530e47ea1b09c2d22d0c2155c93c090.json",
      sha256: "9af3842bdbee358c0786a755a72e5ac9d43e2e106ca72c8c020a5af144b91eaf",
      basisDigest: "189d47abd4090fb221f78c7cc9dc94df7530e47ea1b09c2d22d0c2155c93c090",
      itemHash: "a8367bc1a452e46c9b37a637f00d8e25059e5f92a69f69c8dddac2dd4d2d1bb2",
    },
    classificationArtifact: {
      path: "classification-recoveries/" +
        "v2-0004-0011-af846d70c50441e4974d709bd5e4dfdeccd14b622b2d9d6c2592fd97b26c2b3d-" +
        "7bb7cb863c8c4855.json",
      sha256: "277e07024cba026306206cd81ae479e8de5eca24a26556bfa4a1299bc5a66cd1",
      basisDigest: "af846d70c50441e4974d709bd5e4dfdeccd14b622b2d9d6c2592fd97b26c2b3d",
      itemHash: "3427b09c3dd15c9f66e6cd74f87fbd4879dac7918939863166e92ddd96bba9a3",
    },
    questionText: "$0<x\\leq\\pi$일 때, 방정식 $(\\sin x+\\cos x)^2=\\sqrt{3}\\sin x+1$의 모든 실근의 합은? [3점]",
    terminalCheckpoint: {
      path: "problem-terminal-fidelity/" +
        "v2-0000-7b68c83270ea7333159a52e8847430a33ce1b39c51a015e37498b0d7d2fa0925-" +
        "feb3e18ffe27340aec82ca553c221b8a9ff1a7417d57a73aa9a15fe81c717d05.json",
      sha256: "7372f085903399dd22bdfcb8399c0c42f854a8d805991a4d64a3dac78e538c9c",
      from: 1,
      to: 12,
      ownedFrom: 1,
      ownedTo: 12,
      inputHash: "feb3e18ffe27340aec82ca553c221b8a9ff1a7417d57a73aa9a15fe81c717d05",
    },
    terminalItemHash: "bf88a931ea40031ab17a5cc82e2ddfe84a676107740e7a56352f723866da50d2",
    evidenceHash: "9b8654885dfc899fd1f1ad87803089375c6da7d9a6bd2435afe8aa3b2968ddae",
    preRecoveryEffectiveCorpusHash: "7b68c83270ea7333159a52e8847430a33ce1b39c51a015e37498b0d7d2fa0925",
  }],
  companion: {
    key: "6:15",
    sourcePage: 6,
    contextFrom: 1,
    contextTo: 12,
    repairHash: "f400c07c349dfa5341073d07431c7cce953945e5e6b68c7a928b3851cde5cc6d",
    baseProblemRepairArtifact: {
      path: "problem-repair-batches/" +
        "v2-0001-0012-007bb5df9bce2181b7fa5fccfd3f8fe99d52785743397fe479f038f250ac0a66.json",
      sha256: "f1e9b3e7247ab950f66d0c6dafeecb5e3cc09ca375b9faaa6e6675cef424447b",
      itemHash: "a7f26df6fec1046aad0c031011e6954a46d16b39bb67d589c088e3da981d5fad",
    },
    baseClassificationRepairArtifact: {
      path: "classification-repair-batches/" +
        "v1-0001-0012-a6569662b081a9dd2b05734a069a43d701a727ce434427a24e38fc27e3c55963-" +
        "7bb7cb863c8c4855.json",
      sha256: "412406514265296674c8bd4db65c39da4226a8e1537e7dcbb76b7dd792c762a3",
      itemHash: "e12c52fe492fb5d459d2affde3db992491cd95f4719419483637884e352f0146",
    },
    revisionProblemArtifact: {
      path: "problem-revision-batches/" +
        "v1-0001-0012-0006-9bb41487b85aa7161eef13d1f23c2fc8da17ece5fe172b1b7eb12789ae8ee49f.json",
      sha256: "d83b220b7ccdfc91833fda18ef862b3d90922604fbac3d56d60935a8095365a4",
      itemHash: "255dfe9797e17a4665e806777c9d923f1122498efb4f39d279179cf879037bc6",
    },
    revisionClassificationArtifact: {
      path: "classification-revision-batches/" +
        "v1-0001-0012-3fa16e0f611d671f09e269e19dd95619ad52d6ddf045b71482a0d65c80112bce-" +
        "7bb7cb863c8c4855.json",
      sha256: "4176008a8d870e64fab4084560a7d903ce6b837bf172047f5c36c4394cfae379",
      itemHash: "2896324db4f7f553f05c7c2fdff6456c626972d0b3393dc4aa4f94b80f6c7e0b",
    },
    selected: {
      problemArtifact: {
        path: "problem-recoveries/" +
          "v2-0006-0015-2871fee6201e5c3ad8c5e1efedc77398b214cf99963671a5e377a68304347b7d.json",
        sha256: "71962588bd933a63b5292cfb06566899188e61f1e0a1d7909c03dd78246205c1",
        basisDigest: "2871fee6201e5c3ad8c5e1efedc77398b214cf99963671a5e377a68304347b7d",
        itemHash: "62427daf49f36c23b0c647856574822702cba2371c929a8da38cbc57c3eb2f03",
      },
      classificationArtifact: {
        path: "classification-recoveries/" +
          "v2-0006-0015-69898d0bdb86d9253bfee5590ecd733822f9ca0768b4de1df669626d9e427d58-" +
          "7bb7cb863c8c4855.json",
        sha256: "6a8c0da7b617a50d862a4330f6dce94c76da13ef249b8c4aef3ab570e077d370",
        basisDigest: "69898d0bdb86d9253bfee5590ecd733822f9ca0768b4de1df669626d9e427d58",
        itemHash: "3b38739a732cb1836be1f16aa7169f17545c59e32e78a0889540d35d485fb179",
      },
      questionText: "그림과 같이 곡선 $y=3x+\\frac{2}{x}\\;(x>0)$과 $x$축 및 직선 $x=1$, 직선 $x=2$로 " +
        "둘러싸인 도형을 밑면으로 하는 입체도형이 있다. 이 입체도형을 $x$축에 수직인 평면으로 자른 " +
        "단면이 모두 정삼각형일 때, 이 입체도형의 부피는? [4점]",
      terminalCheckpoint: {
        path: "problem-terminal-fidelity/" +
          "v2-0000-f469ad8d5e38cb71c9ab980e783a4ed92a86788e1130075bd7064682af467aa5-" +
          "16800533754aa321e63d9c11541247d8825ef91ff57cd4bf7aed1dfcf9aa094a.json",
        sha256: "e26f8b8cbe3d76173b2c1c0b0a1143b20a7825d074aee143b91407ea1099356c",
        from: 1,
        to: 12,
        ownedFrom: 1,
        ownedTo: 12,
        inputHash: "16800533754aa321e63d9c11541247d8825ef91ff57cd4bf7aed1dfcf9aa094a",
      },
      terminalItemHash: "95824cc6e89169a7ffaac25804bce0890fe4862616dd003f189237a985c2866e",
      evidenceHash: "bded99dfdd65f2c1aab75086d1c199068f9bce8fc57f76a51cc429d434d7d70f",
      preRecoveryEffectiveCorpusHash: "f469ad8d5e38cb71c9ab980e783a4ed92a86788e1130075bd7064682af467aa5",
    },
    finalAudit: {
      path: "answer-audit/v5-b8e7b69c44cf1cfb5d4527d7d25a9f062db5bdd9ce645244ccc2f46b6acbca7a.json",
      sha256: "74ed4b805d9d0055b66e91a805e55cb801fed7b92c86de8e5e07b88aea09c838",
      auditDigest: "b8e7b69c44cf1cfb5d4527d7d25a9f062db5bdd9ce645244ccc2f46b6acbca7a",
    },
    finalEffectiveCorpusHash: "fd27b3f4d9b4d9224c116326f7f5e9892d58dabf928cfecd838a260c93c14cbf",
    finalTerminal: {
      path: "problem-terminal-fidelity/" +
        "v2-0000-fd27b3f4d9b4d9224c116326f7f5e9892d58dabf928cfecd838a260c93c14cbf-" +
        "d6c42b6b5577981c398d014fe5e45171b83ec36884e47df7cf0bc853f76bff05.json",
      sha256: "32bbecff7af28b478fe7a8a723492b2637fec4c68d2d45271fe6c82639a50491",
      from: 1,
      to: 12,
      ownedFrom: 1,
      ownedTo: 12,
      inputHash: "d6c42b6b5577981c398d014fe5e45171b83ec36884e47df7cf0bc853f76bff05",
    },
  },
}] as const;

const PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST:
readonly ProblemTerminalFidelityAdjudicationSpec[] = [{
  allowlistId: "ebsi-5525984-q8-terminal-fidelity-v1",
  parentKind: "manual",
  parentManualAllowlistId: "ebsi-5525984-q8-manual-v1",
  entryId: "ebsi:5525984",
  key: "3:8",
  sourcePage: 3,
  sourceHash: "1621eca42821e5feccbb56604249cbcedd8adf6bae6109960f6c790a61c14ec1",
  solutionSourceHash: "a081092a68c797d8ae2d0becd0fd17d551c7d009f208c7ae9f32301a5531c687",
  parentQuestionHash: "fbbd4e46ac18d85ae31cbe396c236f8f7a525bc3af467bbb407323ea2a1317bb",
  parentClassificationHash: "d8e26c108aba6322e9dd8a5c633d776bbf884c07414b24dd21a58d89d44f6ee6",
  parentProblemArtifactPath: "problem-manual-adjudications/" +
    "v1-0003-0008-52fae2722d6c898a9ebe6a8ad213c4aad1dcbfd252a2958df8b6d79a0075125f.json",
  parentProblemArtifactHash: "3b90e6caca3385282163e108e8e9d43ad8200aa161fc95404335fb73c53e428f",
  parentClassificationArtifactPath: "classification-manual-adjudications/" +
    "v1-0003-0008-9e52f2d6accfc3c27b4e33c46e1f1cd00e84607380307ac1dc9d685063b5d32d-" +
    "7bb7cb863c8c4855.json",
  parentClassificationArtifactHash: "bb86bd78aab7ae0da5ed3a0f8fb219a0053cce020fc6b90d287f7c1bb71963a6",
  failedTerminalPath: "problem-terminal-fidelity/" +
    "v2-0000-1e076c1128fc58f956f12db80716af215f2cedf605c1816acc5e234d0c320021-" +
    "675077205aaed6d8807112d89b6f10750f22e0bfbef70c35ac14d2ae2eff776d.json",
  failedTerminalArtifactHash: "c4f64ef621cc454e232fa42af9605fb6af83e0fba5eb4a8c6173c774412fd8c9",
  failedEffectiveCorpusHash: "1e076c1128fc58f956f12db80716af215f2cedf605c1816acc5e234d0c320021",
  failedInputHash: "675077205aaed6d8807112d89b6f10750f22e0bfbef70c35ac14d2ae2eff776d",
  failedTerminalInputHash: "cf4cb43037dfdbdb4b39f7e52f9f261d467aae03242ba60e62759423aed0152a",
  failedItemHash: "4067ed57d53fd70705c4125f0c2ff3204efaf02885d8f8340566381a380a9db6",
  failedEvidenceHash: "293899310b6a2285b94f364aa0d11bf3243fece9218b6df792568120d6b10bac",
  failedScopeEvidenceHash: "15388959741a30d21b5515159649b2f366a4ff6879863b9e51e8d895284d90e9",
}, {
  allowlistId: "ebsi-5525984-q20-terminal-fidelity-v1",
  parentKind: "repair",
  entryId: "ebsi:5525984",
  key: "8:20",
  sourcePage: 8,
  sourceHash: "1621eca42821e5feccbb56604249cbcedd8adf6bae6109960f6c790a61c14ec1",
  solutionSourceHash: "a081092a68c797d8ae2d0becd0fd17d551c7d009f208c7ae9f32301a5531c687",
  parentQuestionHash: "d93c3421dda810dac35f5584575a144c3d8e269619a354b8e5cfa5f701f3465a",
  parentClassificationHash: "d5d57d9a6899f7790172a79547771760f1f7fd938559db6e353e2423dea60021",
  parentProblemArtifactPath: "problem-repair-batches/" +
    "v1-0001-0012-0008-b283d60bec56fb9d49910464308e02992c0e05fb34cfa398ad5ccac92efb7c7c.json",
  parentProblemArtifactHash: "ca2d3ada6660fba56fec5493f9d0d2adb27b55fab984369967e96afb30ef41c5",
  parentClassificationArtifactPath: "classification-repair-batches/" +
    "v1-0001-0012-c73ba3446e8f2bc8e3288245a78fc3fc3b6e74653c62f8c82b971d50ba26e6c6-" +
    "7bb7cb863c8c4855.json",
  parentClassificationArtifactHash: "5d080fd28ca92cfe60e163088bdce82a97102db47bbb95b38ec6caf91e0ac4a9",
  baseProblemCheckpointPath: "problem-chunks/v2-0000.json",
  baseProblemCheckpointHash: "18d658fbd7f2206944eacb12438c67a5d9885fbe99111ac0ad792d1eedd62ece",
  baseClassificationCheckpointPath: "classification-chunks/v5-0000-7bb7cb863c8c4855.json",
  baseClassificationCheckpointHash: "709cb0ee0a921ffdefaa4dfd2b53837e13751f855f1b6d9d19ac51bee74234b2",
  baseSolutionCheckpointPath: "solution-chunks/v3-0001.json",
  baseSolutionCheckpointHash: "8f0777900722b0a88164f5beb654b2de48f839f623582dc28e3596a4e989c644",
  baseQuestionHash: "c538c50fab1c502c129b6c50410e3e89fb0308ca267124804e104877c2335edf",
  baseClassificationHash: "54d9e219ec6d472588b75e4d159580429e203885ac61bc992000e93f2ecaced0",
  baseSolutionItemHash: "8297641684d9ed557cdd3d034330a171af3ae04590e3cd408e03e9e23e3e2b81",
  officialRawAnswerHash: "f3eaa647e8a4604ea6bc01c74dfb365ace6754fb867e170b933cc24eb6a81e7b",
  failedTerminalPath: "problem-terminal-fidelity/" +
    "v2-0000-1e076c1128fc58f956f12db80716af215f2cedf605c1816acc5e234d0c320021-" +
    "675077205aaed6d8807112d89b6f10750f22e0bfbef70c35ac14d2ae2eff776d.json",
  failedTerminalArtifactHash: "c4f64ef621cc454e232fa42af9605fb6af83e0fba5eb4a8c6173c774412fd8c9",
  failedEffectiveCorpusHash: "1e076c1128fc58f956f12db80716af215f2cedf605c1816acc5e234d0c320021",
  failedInputHash: "675077205aaed6d8807112d89b6f10750f22e0bfbef70c35ac14d2ae2eff776d",
  failedTerminalInputHash: "6c1e283e9507ec4ac218db6a23329177ec920f0e81bf0693d52ea26006d05bef",
  failedItemHash: "21a1875add25568fe3b26eeea03c0b2a785c524ac71c5a35d6097f2f71d58506",
  failedEvidenceHash: "644b2ad4270b75338872f1d1e0211d9297383e2e4ee0cfa6f8751f578dd219cb",
  failedScopeEvidenceHash: "cc75c4567dbac09b7ea2b7fe184aac906215c3914e46b251c442efdcdaafb4f1",
}, {
  allowlistId: "ebsi-5577055-q11-terminal-fidelity-v1",
  parentKind: "scope-box",
  parentScopeBoxAllowlistId: "ebsi-5577055-q11-scope-box-v1",
  parentScopeAdjudicationHash: "37934d8167e1c967b0f0906a6580818f1fddac9fd3641b7ae8898e132a8620bd",
  parentScopeBoxEvidenceHash: "c336b79354d5a3a3a18cc40cecb2d0bada62f8a6f37803c2a02cf3146beed7f4",
  entryId: "ebsi:5577055",
  key: "4:11",
  sourcePage: 4,
  sourceHash: "b4381bc3b831323375b2c4a25319d308185c930be5d2e3b07dfc28e7646a5fde",
  solutionSourceHash: "1753328f4b4360a9d81312d0d1610c7a11063bbefeeb1e1fd286d54c601ec5fa",
  parentQuestionHash: "35937a22d01677588672139e66a4e55a58a1711fa2b5ba7541d3181d009518d0",
  parentClassificationHash: "d9048c372b65ea1743efa80533f60babf0c825d816ac84441562f5b7884899ef",
  parentProblemArtifactPath: "problem-scope-box-revisions/" +
    "v1-0004-0011-44277b5b18dcad59f73d872eee6fb349f563eeadf93e9590f603e93532583aa7.json",
  parentProblemArtifactHash: "3ff383d6a16074679bc33cb0d3537b33599946af1732122f733ecc76f21f4618",
  parentClassificationArtifactPath: "classification-scope-box-revisions/" +
    "v1-0004-0011-480f4d397802564d27d80a188c79af42000ed85444bb2c1adc51df0ac2ff3ae6-" +
    "7bb7cb863c8c4855.json",
  parentClassificationArtifactHash: "5dc0cc4716259a2425cb82908316a3e8ee297e024309bb0061c645d8a7958f67",
  baseSolutionCheckpointPath: "solution-chunks/v3-0000.json",
  baseSolutionCheckpointHash: "7e463c412565efc1a07c56dc3324da478426ad98822b31c95d586fee87391339",
  baseSolutionItemHash: "ccf1b5bb896164a0466f3b1cd7d3a32463b07b0e640f952c05d14fb04dd74646",
  solutionContextFrom: 1,
  solutionContextTo: 5,
  failedTerminalPath: "problem-terminal-fidelity/" +
    "v2-0000-8e22bc17f58eb8cc8e9138389ec705646ccdbd8a375cd46d52a8a6c33637cafe-" +
    "a47fe46c7cb03dd93ba0c862afae8e2a6012b95bd1afa26e024a3f079c445e60.json",
  failedTerminalArtifactHash: "dcdeba5115626165988892bbe3ddcda57236e8dd5f48cb6171f3bc9092be37b6",
  failedEffectiveCorpusHash: "8e22bc17f58eb8cc8e9138389ec705646ccdbd8a375cd46d52a8a6c33637cafe",
  failedInputHash: "a47fe46c7cb03dd93ba0c862afae8e2a6012b95bd1afa26e024a3f079c445e60",
  failedTerminalInputHash: "5cddb010c8b5196168567c3261a393d0df39d95091d71bdf386067bf035e928e",
  failedItemHash: "ae7b656cae88d66a886cd484c9f08ef5f4b707a2bec7e8466f868836eea22105",
  failedEvidenceHash: "6da2099e40efdc09dd568ee1218577ee39f4ec2e2f909182b972754b147b959c",
  failedScopeEvidenceHash: "ef60f9062f16b23ec37ff90ffbbefd571f2e9fe089bee6c4e36f73fa73abb00d",
  failedStatus: "exact",
  expectedScopeDecision: "reject",
  policyRevision: {
    allowlistId: "ebsi-5577055-q11-terminal-policy-v1",
    parentAdjudicationArtifactPath: "problem-terminal-fidelity-adjudications/" +
      "v1-0004-0011-130fa62fabd4fc9a4155ee9db259f5dbf62c37388ea1c8f18b45487c616c34ec.json",
    parentAdjudicationArtifactHash: "1c9344123c2e44c087fad301f24b749e0b6cc9e073c5107747648c3115209e5b",
    parentAdjudicationBasisDigest: "130fa62fabd4fc9a4155ee9db259f5dbf62c37388ea1c8f18b45487c616c34ec",
    parentAdjudicationItemHash: "c5178e409cb5d1eb55df1bd399a28959d36c87d6ec18447b1aa6e066043ede01",
    parentAdjudicationEvidenceHash: "4961042d4ffa5e11127d5c0277725a6c20787a04f7a5ef542d30d9c449fc7c00",
    parentAdjudicationScopeEvidenceHash: "0e9cccf3e4269d1967336c5592e9940b5199e7b156a26f979cefac8873499b2e",
    parentAdjudicationPromptHash: "482e7929de8eadfc297e5e5abad97749d9308c3bb56cb6f0ccf839bc99f8442b",
    curriculumRulesHash: CURRICULUM_RULES_SHA256,
    expectedItem: {
      key: "4:11",
      status: "exact",
      evidence: "공식 문제 4쪽 픽셀의 문항·그래프·조건·선택지와 확장된 box가 모두 일치한다.",
      scopeDecision: "reject",
      scopeConfidence: 1,
      scopeEvidence: "공식 문제 4쪽과 해설 1쪽 픽셀은 로그함수와 함께 선분의 중점·길이 및 좌표 계산을 " +
        "필수로 사용한다. 적용 중인 교육과정 규칙은 좌표기하와 로그의 결합을 제외 대상으로 명시한다.",
    },
  },
}] as const;

export function manualAdjudicationAllowlistFingerprint(): string {
  return canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST);
}

export function manualRevisionAllowlistFingerprint(): string {
  return canonicalEvidenceHash(PROBLEM_MANUAL_REVISION_ALLOWLIST);
}

export function scopeBoxRevisionAllowlistFingerprint(): string {
  return canonicalEvidenceHash(PROBLEM_SCOPE_BOX_REVISION_ALLOWLIST);
}

export function persistedTerminalRecoveryHydrationAllowlistFingerprint(): string {
  return canonicalEvidenceHash(PERSISTED_TERMINAL_RECOVERY_HYDRATION_ALLOWLIST);
}

export function terminalFidelityAdjudicationAllowlistFingerprint(): string {
  return canonicalEvidenceHash(PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST);
}

export function repairScopeAdjudicationAllowlistFingerprint(): string {
  return canonicalEvidenceHash(PROBLEM_REPAIR_SCOPE_ADJUDICATION_ALLOWLIST);
}

export function positiveRepairScopeAdjudicationAllowlistFingerprint(): string {
  return canonicalEvidenceHash(PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_ALLOWLIST);
}

export function revisionScopeAdjudicationAllowlistFingerprint(): string {
  return canonicalEvidenceHash(PROBLEM_REVISION_SCOPE_ADJUDICATION_ALLOWLIST);
}

export function solutionPromptUpgradeAllowlistFingerprint(): string {
  return canonicalEvidenceHash(SOLUTION_PROMPT_UPGRADE_ALLOWLIST);
}

export function solutionFidelityAdjudicationAllowlistFingerprint(): string {
  return canonicalEvidenceHash(SOLUTION_REVISION_FIDELITY_ADJUDICATION_ALLOWLIST);
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

function problemTerminalFidelityAdjudicationBaseSpec(
  spec: ProblemTerminalFidelityAdjudicationSpec,
): Omit<ProblemTerminalFidelityAdjudicationSpec, "policyRevision"> {
  const { policyRevision: _policyRevision, ...base } = spec;
  return base;
}

function verifyProblemTerminalFidelityAdjudications(
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  effective: DecisionSummary,
  repairs: unknown[],
  solutionSourceHash: string,
  cache: EvidenceCache,
  contract: VerificationContract,
): Map<string, ProblemTerminalFidelityItem> {
  const expectedScopeDecision = (spec: ProblemTerminalFidelityAdjudicationSpec) =>
    spec.expectedScopeDecision ?? "accept";
  const isExpectedItem = (
    spec: ProblemTerminalFidelityAdjudicationSpec,
    item: ProblemTerminalFidelityItem,
  ) => item.status === "exact" && item.scopeDecision === expectedScopeDecision(spec)
    && item.scopeConfidence >= 0.9;
  const effectiveCorpusHash = canonicalEvidenceHash(effective.order.map((key) => {
    const record = effective.records.get(key)!;
    return { question: record.question.evidence, classification: record.classification };
  }));
  const specs = PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST.filter((spec) =>
    spec.entryId === entry.id && spec.sourceHash === problemEvidence.sha256
      && spec.solutionSourceHash === solutionSourceHash
      && spec.failedEffectiveCorpusHash === effectiveCorpusHash)
    .sort((left, right) => compareCorpusQuestionKeys(left.key, right.key));
  const rows = repairs.flatMap((value, index) => {
    const repair = object(value, `answer audit repairs[${index}]`);
    return repair.terminalAdjudication === undefined ? [] : [{ repair, index }];
  });
  const expectedKeys = specs.map((spec) => spec.key);
  const actualKeys = rows.map(({ repair, index }) =>
    exactString(repair.key, `answer audit repairs[${index}].key`))
    .sort(compareCorpusQuestionKeys);
  if (new Set(expectedKeys).size !== expectedKeys.length
    || new Set(actualKeys).size !== actualKeys.length
    || !isDeepStrictEqual(expectedKeys, actualKeys)) {
    throw new Error("terminal fidelity adjudication must exactly cover its allowlisted corpus generation");
  }

  const overlays = new Map<string, ProblemTerminalFidelityItem>();
  for (const { repair, index } of rows) {
    const key = exactString(repair.key, `answer audit repairs[${index}].key`);
    const current = effective.records.get(key);
    const spec = specs.find((candidate) => candidate.key === key);
    const expectedParentDecision = spec?.parentKind === "scope-box" ? "reject" : "accept";
    if (!current || !spec || current.question.page !== spec.sourcePage
      || canonicalEvidenceHash(current.question.evidence) !== spec.parentQuestionHash
      || canonicalEvidenceHash(current.classification) !== spec.parentClassificationHash
      || current.classification.transcription_status !== "exact"
      || current.classification.decision !== expectedParentDecision
      || expectedParentDecision === "reject" && (
        current.classification.canonical_subject !== null
        || current.classification.curriculum_course !== null
        || current.classification.domain !== null
        || current.classification.achievement_codes.length !== 0
      )) {
      throw new Error(`${key}: terminal fidelity adjudication current question/classification is stale`);
    }
    const { terminalAdjudication: rawAdjudication, ...parentRepair } = repair;
    const revision = parentRepair.revision === undefined
      ? undefined
      : object(parentRepair.revision, `${key}.revision`);
    if (parentRepair.scopeAdjudication !== undefined || revision?.scopeAdjudication !== undefined) {
      throw new Error(`${key}: terminal fidelity adjudication conflicts with scope adjudication`);
    }
    const recovery = revision?.recovery === undefined
      ? undefined
      : object(revision.recovery, `${key}.revision.recovery`);
    const parentManual = recovery?.manualAdjudication === undefined
      ? undefined
      : object(recovery.manualAdjudication, `${key}.revision.recovery.manualAdjudication`);
    const parentScopeAdjudication = recovery?.scopeAdjudication === undefined
      ? undefined
      : object(recovery.scopeAdjudication, `${key}.revision.recovery.scopeAdjudication`);
    const parentScopeBox = parentScopeAdjudication?.boxRevision === undefined
      ? undefined
      : object(parentScopeAdjudication.boxRevision, `${key}.revision.recovery.scopeAdjudication.boxRevision`);
    const pointerFromEnvelope = (value: unknown, label: string): EvidencePointer => {
      const envelope = object(value, label);
      return evidencePointer({ path: envelope.path, sha256: envelope.sha256 }, label);
    };
    const parentProblemArtifact = pointerFromEnvelope(
      spec.parentKind === "manual"
        ? parentManual?.problemArtifact
        : spec.parentKind === "scope-box" ? parentScopeBox?.problemArtifact : parentRepair.problemArtifact,
      `${key}.terminalAdjudication.parentProblemArtifact`,
    );
    const parentClassificationArtifact = pointerFromEnvelope(
      spec.parentKind === "manual"
        ? parentManual?.classificationArtifact
        : spec.parentKind === "scope-box"
          ? parentScopeBox?.classificationArtifact
          : parentRepair.classificationArtifact,
      `${key}.terminalAdjudication.parentClassificationArtifact`,
    );
    if (parentProblemArtifact.path !== spec.parentProblemArtifactPath
      || parentProblemArtifact.sha256 !== spec.parentProblemArtifactHash
      || parentClassificationArtifact.path !== spec.parentClassificationArtifactPath
      || parentClassificationArtifact.sha256 !== spec.parentClassificationArtifactHash) {
      throw new Error(`${key}: terminal fidelity adjudication parent artifacts are stale`);
    }
    readBoundEvidenceCached(cache, stateDir, parentProblemArtifact, `${key} terminal adjudication parent problem`);
    readBoundEvidenceCached(
      cache,
      stateDir,
      parentClassificationArtifact,
      `${key} terminal adjudication parent classification`,
    );
    if (spec.parentKind === "manual") {
      if (!parentManual || parentManual.allowlistId !== spec.parentManualAllowlistId
        || parentManual.revision !== undefined || parentManual.sourceHash !== spec.sourceHash
        || parentManual.effectiveQuestionHash !== spec.parentQuestionHash
        || parentManual.effectiveClassificationHash !== spec.parentClassificationHash) {
        throw new Error(`${key}: terminal fidelity adjudication manual parent is stale`);
      }
    } else if (spec.parentKind === "repair") {
      const baseProblemCheckpoint = evidencePointer(
        parentRepair.baseProblemCheckpoint,
        `${key}.terminalAdjudication.baseProblemCheckpoint`,
      );
      const baseClassificationCheckpoint = evidencePointer(
        parentRepair.baseClassificationCheckpoint,
        `${key}.terminalAdjudication.baseClassificationCheckpoint`,
      );
      const baseSolutionCheckpoint = evidencePointer(
        parentRepair.baseSolutionCheckpoint,
        `${key}.terminalAdjudication.baseSolutionCheckpoint`,
      );
      if (revision !== undefined
        || baseProblemCheckpoint.path !== spec.baseProblemCheckpointPath
        || baseProblemCheckpoint.sha256 !== spec.baseProblemCheckpointHash
        || baseClassificationCheckpoint.path !== spec.baseClassificationCheckpointPath
        || baseClassificationCheckpoint.sha256 !== spec.baseClassificationCheckpointHash
        || baseSolutionCheckpoint.path !== spec.baseSolutionCheckpointPath
        || baseSolutionCheckpoint.sha256 !== spec.baseSolutionCheckpointHash
        || parentRepair.baseQuestionHash !== spec.baseQuestionHash
        || parentRepair.baseClassificationHash !== spec.baseClassificationHash
        || parentRepair.baseSolutionItemHash !== spec.baseSolutionItemHash
        || parentRepair.officialRawAnswerHash !== spec.officialRawAnswerHash
        || parentRepair.problemArtifactItemHash !== spec.parentQuestionHash
        || parentRepair.classificationArtifactItemHash !== spec.parentClassificationHash
        || parentRepair.effectiveQuestionHash !== spec.parentQuestionHash
        || parentRepair.effectiveClassificationHash !== spec.parentClassificationHash) {
        throw new Error(`${key}: terminal fidelity adjudication first repair parent is stale`);
      }
      for (const [label, pointer] of [
        ["base problem", baseProblemCheckpoint],
        ["base classification", baseClassificationCheckpoint],
        ["base solution", baseSolutionCheckpoint],
      ] as const) {
        readBoundEvidenceCached(cache, stateDir, pointer, `${key} terminal adjudication ${label}`);
      }
    } else {
      if (!parentScopeAdjudication || !parentScopeBox
        || parentScopeBox.allowlistId !== spec.parentScopeBoxAllowlistId
        || canonicalEvidenceHash(parentScopeAdjudication) !== spec.parentScopeAdjudicationHash
        || canonicalEvidenceHash(parentScopeBox) !== spec.parentScopeBoxEvidenceHash
        || parentScopeBox.problemArtifactItemHash !== spec.parentQuestionHash
        || parentScopeBox.effectiveQuestionHash !== spec.parentQuestionHash
        || parentScopeBox.classificationArtifactItemHash !== spec.parentClassificationHash
        || parentScopeBox.effectiveClassificationHash !== spec.parentClassificationHash
        || parentScopeAdjudication.baseSolutionItemHash !== spec.baseSolutionItemHash
        || parentScopeAdjudication.solutionContextFrom !== spec.solutionContextFrom
        || parentScopeAdjudication.solutionContextTo !== spec.solutionContextTo) {
        throw new Error(`${key}: terminal fidelity adjudication scope box parent is stale`);
      }
      const baseSolutionCheckpoint = evidencePointer(
        parentScopeAdjudication.baseSolutionCheckpoint,
        `${key}.terminalAdjudication.baseSolutionCheckpoint`,
      );
      if (baseSolutionCheckpoint.path !== spec.baseSolutionCheckpointPath
        || baseSolutionCheckpoint.sha256 !== spec.baseSolutionCheckpointHash) {
        throw new Error(`${key}: terminal fidelity adjudication scope box solution authority is stale`);
      }
      readBoundEvidenceCached(
        cache,
        stateDir,
        baseSolutionCheckpoint,
        `${key} terminal adjudication base solution`,
      );
    }

    const adjudicationEnvelope = object(rawAdjudication, `${key}.terminalAdjudication`);
    const { policyRevision: rawPolicyRevision, ...adjudication } = adjudicationEnvelope;
    const failedTerminalCheckpoint = problemTerminalFidelityCheckpoint(
      adjudication.failedTerminalCheckpoint,
      `${key}.terminalAdjudication.failedTerminalCheckpoint`,
    );
    if (failedTerminalCheckpoint.path !== spec.failedTerminalPath
      || failedTerminalCheckpoint.sha256 !== spec.failedTerminalArtifactHash
      || failedTerminalCheckpoint.inputHash !== spec.failedInputHash) {
      throw new Error(`${key}: terminal fidelity adjudication failed checkpoint is stale`);
    }
    const failedItems = verifyProblemTerminalFidelityCheckpoint(
      stateDir,
      entry,
      problemEvidence,
      effective,
      effectiveCorpusHash,
      failedTerminalCheckpoint,
      cache,
      contract,
    );
    const failedTerminalItem = failedItems.find((item) => item.key === key);
    const failedTerminalInput = problemTerminalInput(current);
    if (!failedTerminalItem
      || canonicalEvidenceHash(failedTerminalInput) !== spec.failedTerminalInputHash
      || canonicalEvidenceHash(failedTerminalItem) !== spec.failedItemHash
      || sha256(failedTerminalItem.evidence) !== spec.failedEvidenceHash
      || failedTerminalItem.scopeEvidence === undefined
      || sha256(failedTerminalItem.scopeEvidence) !== spec.failedScopeEvidenceHash
      || failedTerminalItem.status !== (spec.failedStatus ?? "mismatch")
      || failedTerminalItem.scopeDecision !== "accept"
      || failedTerminalItem.scopeConfidence < 0.9) {
      throw new Error(`${key}: terminal fidelity adjudication failed item/input is stale`);
    }
    const parentRepairEvidenceHash = canonicalEvidenceHash(parentRepair);
    const parentManualEvidenceHash = parentManual ? canonicalEvidenceHash(parentManual) : undefined;
    const parentScopeAdjudicationHash = parentScopeAdjudication
      ? canonicalEvidenceHash(parentScopeAdjudication)
      : undefined;
    const parentScopeBoxEvidenceHash = parentScopeBox ? canonicalEvidenceHash(parentScopeBox) : undefined;
    const sourceEvidence = spec.parentKind === "manual"
      ? { ...evidencePointer(parentManual!.cropEvidencePdf, `${key}.manual.cropEvidencePdf`), kind: "manual-crop" }
      : spec.parentKind === "scope-box"
        ? {
            ...evidencePointer(parentScopeBox!.cropEvidencePdf, `${key}.scopeBox.cropEvidencePdf`),
            kind: "scope-box-crop",
          }
        : { path: "problem.pdf", sha256: problemEvidence.sha256, kind: "problem-pdf" };
    const sourcePath = confinedEvidencePath(
      stateDir,
      { path: sourceEvidence.path, sha256: sourceEvidence.sha256 },
      `${key} terminal fidelity adjudication source`,
    );
    if (hashFile(sourcePath) !== sourceEvidence.sha256) {
      throw new Error(`${key}: terminal fidelity adjudication source hash is stale`);
    }
    const commonBasis = {
      allowlistId: spec.allowlistId,
      entryId: entry.id,
      key,
      sourcePage: spec.sourcePage,
      sourceHash: problemEvidence.sha256,
      solutionSourceHash,
      parentKind: spec.parentKind,
      parentRepair,
      parentRepairEvidenceHash,
      ...(parentManual ? {
        parentManual,
        parentManualEvidenceHash,
        cropEvidenceArtifact: parentManual.cropEvidenceArtifact,
        cropEvidencePdf: parentManual.cropEvidencePdf,
        cropViews: parentManual.cropViews,
      } : {}),
      ...(parentScopeAdjudication && parentScopeBox ? {
        parentScopeAdjudication,
        parentScopeAdjudicationHash,
        parentScopeBox,
        parentScopeBoxEvidenceHash,
        cropEvidenceArtifact: parentScopeBox.cropEvidenceArtifact,
        cropEvidencePdf: parentScopeBox.cropEvidencePdf,
        cropViews: parentScopeBox.cropViews,
        baseSolutionCheckpoint: parentScopeAdjudication.baseSolutionCheckpoint,
        baseSolutionItemHash: parentScopeAdjudication.baseSolutionItemHash,
        solutionContextFrom: parentScopeAdjudication.solutionContextFrom,
        solutionContextTo: parentScopeAdjudication.solutionContextTo,
      } : {}),
      sourceEvidence,
      effectiveCorpusHash,
      failedTerminalCheckpoint,
      failedTerminalInput,
      failedTerminalInputHash: spec.failedTerminalInputHash,
      failedTerminalItem,
      failedTerminalItemHash: spec.failedItemHash,
      failedEvidenceHash: spec.failedEvidenceHash,
      failedScopeEvidenceHash: spec.failedScopeEvidenceHash,
      adjudicationSpecHash: canonicalEvidenceHash(problemTerminalFidelityAdjudicationBaseSpec(spec)),
    };
    const basisDigest = canonicalEvidenceHash(commonBasis);
    const expectedPath = `problem-terminal-fidelity-adjudications/` +
      `v${PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_VERSION}-${String(spec.sourcePage).padStart(4, "0")}-` +
      `${current.question.printedNumber.padStart(4, "0")}-${basisDigest}.json`;
    const artifactEnvelope = object(adjudication.adjudicationArtifact, `${key}.adjudicationArtifact`);
    const adjudicationArtifact = evidencePointer(
      { path: artifactEnvelope.path, sha256: artifactEnvelope.sha256 },
      `${key}.adjudicationArtifact`,
    );
    if (adjudicationArtifact.path !== expectedPath
      || artifactEnvelope.version !== PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_VERSION
      || artifactEnvelope.promptDigest !== PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_PROMPT_DIGEST) {
      throw new Error(`${key}: terminal fidelity adjudication artifact envelope is stale`);
    }
    const checkpoint = readBoundEvidenceCached(
      cache,
      stateDir,
      adjudicationArtifact,
      `${key} terminal fidelity adjudication`,
    );
    if (!Array.isArray(checkpoint.items) || checkpoint.items.length !== 1) {
      throw new Error(`${key}: terminal fidelity adjudication must contain exactly one item`);
    }
    const item = parseProblemTerminalFidelityItem(
      checkpoint.items[0],
      `${key}.terminalAdjudication.items[0]`,
      contract,
    );
    const expectedCheckpoint = {
      version: PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_VERSION,
      entryId: entry.id,
      basisDigest,
      basis: commonBasis,
      transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
      rulesDigest: effective.rulesDigest,
      scopePromptDigest: PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST,
      promptDigest: PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      input: failedTerminalInput,
      items: [item],
    };
    const expectedEvidence = {
      allowlistId: spec.allowlistId,
      key,
      sourcePage: spec.sourcePage,
      sourceHash: problemEvidence.sha256,
      solutionSourceHash,
      parentKind: spec.parentKind,
      parentRepairEvidenceHash,
      ...(parentManualEvidenceHash ? { parentManualEvidenceHash } : {}),
      ...(parentScopeAdjudication && parentScopeBox ? {
        parentScopeAdjudication,
        parentScopeAdjudicationHash,
        parentScopeBox,
        parentScopeBoxEvidenceHash,
        cropEvidenceArtifact: parentScopeBox.cropEvidenceArtifact,
        cropEvidencePdf: parentScopeBox.cropEvidencePdf,
        cropViews: parentScopeBox.cropViews,
        baseSolutionCheckpoint: parentScopeAdjudication.baseSolutionCheckpoint,
        baseSolutionItemHash: parentScopeAdjudication.baseSolutionItemHash,
        solutionContextFrom: parentScopeAdjudication.solutionContextFrom,
        solutionContextTo: parentScopeAdjudication.solutionContextTo,
      } : {}),
      sourceEvidence,
      effectiveCorpusHash,
      failedTerminalCheckpoint,
      failedTerminalInputHash: spec.failedTerminalInputHash,
      failedTerminalItemHash: spec.failedItemHash,
      failedEvidenceHash: spec.failedEvidenceHash,
      failedScopeEvidenceHash: spec.failedScopeEvidenceHash,
      adjudicationSpecHash: canonicalEvidenceHash(problemTerminalFidelityAdjudicationBaseSpec(spec)),
      adjudicationArtifact: {
        ...adjudicationArtifact,
        version: PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_VERSION,
        promptDigest: PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_PROMPT_DIGEST,
      },
      adjudicationItemHash: canonicalEvidenceHash(item),
    };
    const policy = spec.policyRevision;
    const validPolicyParent = policy !== undefined
      && adjudicationArtifact.path === policy.parentAdjudicationArtifactPath
      && adjudicationArtifact.sha256 === policy.parentAdjudicationArtifactHash
      && basisDigest === policy.parentAdjudicationBasisDigest
      && canonicalEvidenceHash(item) === policy.parentAdjudicationItemHash
      && sha256(item.evidence) === policy.parentAdjudicationEvidenceHash
      && item.scopeEvidence !== undefined
      && sha256(item.scopeEvidence) === policy.parentAdjudicationScopeEvidenceHash
      && item.status === "exact" && item.scopeDecision === "accept" && item.scopeConfidence >= 0.9;
    if (!isDeepStrictEqual(checkpoint, expectedCheckpoint)
      || !isDeepStrictEqual(adjudication, expectedEvidence)
      || item.key !== key || (!isExpectedItem(spec, item) && !validPolicyParent)) {
      throw new Error(`${key}: terminal fidelity adjudication checkpoint/evidence is stale`);
    }
    if (!policy) {
      if (rawPolicyRevision !== undefined) {
        throw new Error(`${key}: terminal fidelity policy revision is not allowlisted`);
      }
      overlays.set(key, item);
      continue;
    }
    if (!validPolicyParent || rawPolicyRevision === undefined
      || policy.curriculumRulesHash !== CURRICULUM_RULES_SHA256
      || canonicalEvidenceHash(policy.expectedItem) !==
        "de7aeb740bdd1028513cccee841db5363464896d49a7ac98ad06cb6b17460e44"
      || !isExpectedItem(spec, policy.expectedItem)) {
      throw new Error(`${key}: terminal fidelity policy revision parent/spec is stale`);
    }
    const solutionSourceEvidence = { path: "solution.pdf", sha256: solutionSourceHash };
    const solutionPath = confinedEvidencePath(
      stateDir,
      solutionSourceEvidence,
      `${key} terminal fidelity policy solution source`,
    );
    if (hashFile(solutionPath) !== solutionSourceHash || !parentScopeAdjudication || !parentScopeBox) {
      throw new Error(`${key}: terminal fidelity policy source authority is stale`);
    }
    const parentAdjudicationAuthorityHash = canonicalEvidenceHash(expectedEvidence);
    const policyBasis = {
      allowlistId: policy.allowlistId,
      entryId: entry.id,
      key,
      sourcePage: spec.sourcePage,
      sourceHash: problemEvidence.sha256,
      solutionSourceHash,
      parentAdjudication: expectedEvidence,
      parentAdjudicationAuthorityHash,
      parentAdjudicationArtifact: expectedEvidence.adjudicationArtifact,
      parentAdjudicationBasisDigest: policy.parentAdjudicationBasisDigest,
      parentAdjudicationItem: item,
      parentAdjudicationItemHash: policy.parentAdjudicationItemHash,
      parentAdjudicationEvidenceHash: policy.parentAdjudicationEvidenceHash,
      parentAdjudicationScopeEvidenceHash: policy.parentAdjudicationScopeEvidenceHash,
      parentAdjudicationPromptHash: policy.parentAdjudicationPromptHash,
      parentScopeBoxEvidenceHash: spec.parentScopeBoxEvidenceHash,
      parentClassificationHash: spec.parentClassificationHash,
      problemSourceEvidence: sourceEvidence,
      solutionSourceEvidence,
      baseSolutionCheckpoint: parentScopeAdjudication.baseSolutionCheckpoint,
      baseSolutionItemHash: parentScopeAdjudication.baseSolutionItemHash,
      solutionContextFrom: parentScopeAdjudication.solutionContextFrom,
      solutionContextTo: parentScopeAdjudication.solutionContextTo,
      curriculumRulesHash: policy.curriculumRulesHash,
      policySpecHash: canonicalEvidenceHash(policy),
      expectedItem: policy.expectedItem,
    };
    const policyBasisDigest = canonicalEvidenceHash(policyBasis);
    const expectedPolicyPath = `problem-terminal-fidelity-policy-revisions/` +
      `v${PROBLEM_TERMINAL_FIDELITY_POLICY_REVISION_VERSION}-` +
      `${String(spec.sourcePage).padStart(4, "0")}-${current.question.printedNumber.padStart(4, "0")}-` +
      `${policyBasisDigest}.json`;
    const policyEvidence = object(rawPolicyRevision, `${key}.terminalAdjudication.policyRevision`);
    const policyArtifactEnvelope = object(
      policyEvidence.policyArtifact,
      `${key}.terminalAdjudication.policyRevision.policyArtifact`,
    );
    const policyArtifact = evidencePointer({
      path: policyArtifactEnvelope.path,
      sha256: policyArtifactEnvelope.sha256,
    }, `${key}.terminalAdjudication.policyRevision.policyArtifact`);
    if (policyArtifact.path !== expectedPolicyPath
      || policyArtifactEnvelope.version !== PROBLEM_TERMINAL_FIDELITY_POLICY_REVISION_VERSION
      || policyArtifactEnvelope.policyDigest !== PROBLEM_TERMINAL_FIDELITY_POLICY_REVISION_DIGEST) {
      throw new Error(`${key}: terminal fidelity policy revision artifact envelope is stale`);
    }
    const policyCheckpoint = readBoundEvidenceCached(
      cache,
      stateDir,
      policyArtifact,
      `${key} terminal fidelity policy revision`,
    );
    const policyItem = parseProblemTerminalFidelityItem(
      policyCheckpoint.item,
      `${key}.terminalAdjudication.policyRevision.item`,
      contract,
    );
    const expectedPolicyCheckpoint = {
      version: PROBLEM_TERMINAL_FIDELITY_POLICY_REVISION_VERSION,
      entryId: entry.id,
      basisDigest: policyBasisDigest,
      basis: policyBasis,
      policyDigest: PROBLEM_TERMINAL_FIDELITY_POLICY_REVISION_DIGEST,
      item: policy.expectedItem,
    };
    const expectedPolicyEvidence = {
      allowlistId: policy.allowlistId,
      key,
      sourcePage: spec.sourcePage,
      sourceHash: problemEvidence.sha256,
      solutionSourceHash,
      parentAdjudicationArtifact: expectedEvidence.adjudicationArtifact,
      parentAdjudicationBasisDigest: policy.parentAdjudicationBasisDigest,
      parentAdjudicationItemHash: policy.parentAdjudicationItemHash,
      parentAdjudicationAuthorityHash,
      parentAdjudicationEvidenceHash: policy.parentAdjudicationEvidenceHash,
      parentAdjudicationScopeEvidenceHash: policy.parentAdjudicationScopeEvidenceHash,
      parentAdjudicationPromptHash: policy.parentAdjudicationPromptHash,
      parentScopeBoxEvidenceHash: spec.parentScopeBoxEvidenceHash,
      parentClassificationHash: spec.parentClassificationHash,
      problemSourceEvidence: sourceEvidence,
      solutionSourceEvidence,
      baseSolutionCheckpoint: parentScopeAdjudication.baseSolutionCheckpoint,
      baseSolutionItemHash: parentScopeAdjudication.baseSolutionItemHash,
      solutionContextFrom: parentScopeAdjudication.solutionContextFrom,
      solutionContextTo: parentScopeAdjudication.solutionContextTo,
      curriculumRulesHash: policy.curriculumRulesHash,
      policySpecHash: canonicalEvidenceHash(policy),
      policyArtifact: {
        ...policyArtifact,
        version: PROBLEM_TERMINAL_FIDELITY_POLICY_REVISION_VERSION,
        policyDigest: PROBLEM_TERMINAL_FIDELITY_POLICY_REVISION_DIGEST,
      },
      policyItemHash: canonicalEvidenceHash(policy.expectedItem),
    };
    if (!isDeepStrictEqual(policyCheckpoint, expectedPolicyCheckpoint)
      || !isDeepStrictEqual(policyItem, policy.expectedItem)
      || !isDeepStrictEqual(adjudicationEnvelope, {
        ...expectedEvidence,
        policyRevision: expectedPolicyEvidence,
      })) {
      throw new Error(`${key}: terminal fidelity policy revision checkpoint/evidence is stale`);
    }
    overlays.set(key, policyItem);
  }
  return overlays;
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
  if (!Array.isArray(audit.repairs)) throw new Error("answer audit repairs are missing");
  const adjudicatedItems = verifyProblemTerminalFidelityAdjudications(
    stateDir,
    entry,
    problemEvidence,
    effective,
    audit.repairs,
    exactString(audit.solutionHash, "answer audit.solutionHash"),
    cache,
    contract,
  );
  const overlaidActualItems = actualItems.map((item) => adjudicatedItems.get(item.key) ?? item);
  const items = audit.problemTerminalFidelityItems.map((value, index) =>
    parseProblemTerminalFidelityItem(value, `problemTerminalFidelityItems[${index}]`, contract));
  const sortedActual = [...overlaidActualItems]
    .sort((left, right) => compareCorpusQuestionKeys(left.key, right.key));
  const sortedExpected = [...items].sort((left, right) => compareCorpusQuestionKeys(left.key, right.key));
  const itemByKey = new Map(items.map((item) => [item.key, item]));
  const scopeAdjudicatedKeys = new Set<string>();
  const positiveScopeAuthorityKeys = new Set<string>();
  if (Array.isArray(audit.repairs)) {
    for (const [index, value] of audit.repairs.entries()) {
      const repair = object(value, `answer audit repairs[${index}]`);
      if (repair.scopeAdjudication !== undefined) {
        const key = exactString(repair.key, `answer audit repairs[${index}].key`);
        const adjudication = object(
          repair.scopeAdjudication,
          `answer audit repairs[${index}].scopeAdjudication`,
        );
        const positive = PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_ALLOWLIST.some((spec) =>
          spec.allowlistId === adjudication.allowlistId && spec.key === key
          && spec.sourcePage === adjudication.sourcePage && spec.sourceHash === adjudication.sourceHash
          && spec.solutionSourceHash === adjudication.solutionSourceHash);
        (positive ? positiveScopeAuthorityKeys : scopeAdjudicatedKeys).add(key);
      }
      if (repair.revision === undefined) continue;
      const revision = object(repair.revision, `answer audit repairs[${index}].revision`);
      if (revision.scopeAdjudication !== undefined) {
        scopeAdjudicatedKeys.add(exactString(repair.key, `answer audit repairs[${index}].key`));
      }
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
      return item.status !== "exact" || (positiveScopeAuthorityKeys.has(key)
        ? record.classification.decision !== "accept"
        : scopeAdjudicatedKeys.has(key)
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
  if (new Set(overlaidActualItems.map((item) => item.key)).size !== effective.order.length
    || overlaidActualItems.length !== effective.order.length
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

type PersistedV2ProblemRecord = {
  key: string;
  base: ClassifiedEvidence;
  solution: OfficialSolution;
  question: ProblemQuestion;
  contextFrom: number;
  contextTo: number;
  problemArtifact: EvidencePointer;
  problemArtifactItemHash: string;
};

type PersistedV2ClassificationGraph = {
  contextKey: string;
  path: string;
  pointer: EvidencePointer;
  records: PersistedV2ProblemRecord[];
  classifications: Map<string, ClassificationEvidence>;
};

type PersistedV2GraphSelection = {
  effectiveCorpusHash: string | null;
  selectedClassificationPaths: string[];
  historicalProblemBatchPaths: Set<string>;
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

function strictRepairGraphNames(
  stateDir: string,
  directory: string,
  label: string,
  validName: (name: string) => boolean,
): string[] {
  const absolute = join(stateDir, directory);
  if (!existsSync(absolute)) return [];
  const directoryStat = lstatSync(absolute);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`${label} directory is invalid`);
  }
  return readdirSync(absolute, { withFileTypes: true }).flatMap((child) => {
    if (child.isFile() && child.name.endsWith(".tmp")) return [];
    if (child.isSymbolicLink() || !child.isFile()) {
      throw new Error(`${directory}/${child.name}: ${label} artifact is invalid`);
    }
    if (!validName(child.name)) {
      throw new Error(`${directory}/${child.name}: malformed ${label} artifact name`);
    }
    return [child.name];
  }).sort();
}

function readCanonicalGraphArtifact(
  stateDir: string,
  relativePath: string,
  label: string,
): { pointer: EvidencePointer; checkpoint: Record<string, unknown> } {
  const placeholder = { path: relativePath, sha256: "0".repeat(64) };
  const absolute = confinedEvidencePath(stateDir, placeholder, label);
  const sha256 = hashFile(absolute);
  const checkpoint = object(json(absolute), label);
  if (canonicalEvidenceHash(checkpoint) !== sha256) {
    throw new Error(`${relativePath}: ${label} is not canonical immutable JSON`);
  }
  return { pointer: { path: relativePath, sha256 }, checkpoint };
}

function persistedV2ProblemBase(
  key: string,
  base: DecisionSummary,
  solutions: Map<string, OfficialSolution>,
): {
  base: ClassifiedEvidence;
  solution: OfficialSolution;
  baseQuestionHash: string;
  baseClassificationHash: string;
  baseSolutionItemHash: string;
  officialRawAnswerHash: string;
} {
  const record = base.records.get(key);
  if (!record) throw new Error(`${key}: persisted repair graph has no immutable base problem`);
  const solution = solutions.get(record.question.printedNumber);
  if (!solution) throw new Error(`${key}: persisted repair graph has no immutable base solution`);
  return {
    base: record,
    solution,
    baseQuestionHash: canonicalEvidenceHash(record.question.evidence),
    baseClassificationHash: canonicalEvidenceHash(record.classification),
    baseSolutionItemHash: canonicalEvidenceHash(solution.evidence),
    officialRawAnswerHash: sha256(solution.rawAnswer),
  };
}

function scanPersistedV2ProblemRecords(
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  base: DecisionSummary,
  solutions: Map<string, OfficialSolution>,
): {
  recordsByIdentity: Map<string, PersistedV2ProblemRecord>;
  recordsByContext: Map<string, PersistedV2ProblemRecord[]>;
  batchVersions: Map<string, 1 | 2>;
} {
  const batchNames = strictRepairGraphNames(
    stateDir,
    "problem-repair-batches",
    "problem repair batch",
    (name) => /^v1-\d{4}-\d{4}-\d{4}-[a-f0-9]{64}\.json$/u.test(name)
      || /^v2-\d{4}-\d{4}-[a-f0-9]{64}\.json$/u.test(name),
  );
  const batchVersions = new Map<string, 1 | 2>();
  for (const name of batchNames) {
    const match = /^v([12])-(\d{4})-(\d{4})-/u.exec(name)!;
    const context = `${Number(match[2])}:${Number(match[3])}`;
    const version = Number(match[1]) as 1 | 2;
    const prior = batchVersions.get(context);
    if (prior !== undefined && prior !== version) {
      throw new Error(`${context}: legacy v1 and cross-page v2 problem repair batches cannot share a context`);
    }
    batchVersions.set(context, version);
  }

  const recordsByIdentity = new Map<string, PersistedV2ProblemRecord>();
  const recordsByContext = new Map<string, PersistedV2ProblemRecord[]>();
  const identity = (path: string, key: string) => JSON.stringify([path, key]);
  const addRecord = (record: PersistedV2ProblemRecord) => {
    const recordIdentity = identity(record.problemArtifact.path, record.key);
    if (recordsByIdentity.has(recordIdentity)) {
      throw new Error(`${record.problemArtifact.path} ${record.key}: persisted problem repair member is duplicated`);
    }
    recordsByIdentity.set(recordIdentity, record);
    const context = `${record.contextFrom}:${record.contextTo}`;
    recordsByContext.set(context, [...(recordsByContext.get(context) ?? []), record]);
  };

  for (const name of batchNames) {
    const match = /^v2-(\d{4})-(\d{4})-([a-f0-9]{64})\.json$/u.exec(name);
    if (!match) continue;
    const contextFrom = Number(match[1]);
    const contextTo = Number(match[2]);
    const relativePath = `problem-repair-batches/${name}`;
    const { pointer, checkpoint } = readCanonicalGraphArtifact(
      stateDir,
      relativePath,
      "persisted v2 problem repair graph",
    );
    const rawMembers = Array.isArray(checkpoint.members)
      ? checkpoint.members.map((value, index) => object(value, `${relativePath}.members[${index}]`))
      : [];
    const memberKeys = rawMembers.map((member, index) =>
      exactString(member.key, `${relativePath}.members[${index}].key`));
    if (memberKeys.length === 0 || new Set(memberKeys).size !== memberKeys.length) {
      throw new Error(`${relativePath}: persisted v2 problem repair members are empty or duplicated`);
    }
    const members = memberKeys.map((key) => {
      const immutable = persistedV2ProblemBase(key, base, solutions);
      return {
        key,
        immutable,
        expected: {
          key,
          printedNumber: immutable.base.question.printedNumber,
          sourcePage: immutable.base.question.page,
          baseProblemCheckpoint: immutable.base.problemCheckpoint,
          baseQuestionHash: immutable.baseQuestionHash,
          baseClassificationCheckpoint: immutable.base.classificationCheckpoint,
          baseClassificationHash: immutable.baseClassificationHash,
          baseTranscriptionEvidenceHash: sha256(immutable.base.classification.transcription_evidence),
          baseSolutionCheckpoint: immutable.solution.checkpoint,
          baseSolutionItemHash: immutable.baseSolutionItemHash,
          officialRawAnswerHash: immutable.officialRawAnswerHash,
        },
      };
    }).sort((left, right) => compareCorpusQuestionKeys(left.key, right.key));
    const expectedMembers = members.map((member) => member.expected);
    const targetsDigest = canonicalEvidenceHash(expectedMembers);
    if (!Array.isArray(checkpoint.items)) {
      throw new Error(`${relativePath}: persisted v2 problem repair items are missing`);
    }
    const items = checkpoint.items.map((value, index) =>
      parseProblem(value, `${relativePath}.items[${index}]`));
    const itemByKey = new Map<string, ProblemQuestion>();
    for (const item of items) {
      if (itemByKey.has(item.key)) throw new Error(`${relativePath}: duplicate problem output ${item.key}`);
      itemByKey.set(item.key, item);
    }
    if (itemByKey.size !== members.length || members.some((member) => !itemByKey.has(member.key))) {
      throw new Error(`${relativePath}: persisted v2 problem member/output coverage is not exact`);
    }
    const expectedCheckpoint = {
      version: PROBLEM_REPAIR_BATCH_VERSION,
      entryId: entry.id,
      sourceHash: problemEvidence.sha256,
      contextFrom,
      contextTo,
      targetsDigest,
      members: expectedMembers,
      batchPromptVersion: TARGETED_PROBLEM_BATCH_VERSION,
      batchPromptDigest: TARGETED_PROBLEM_BATCH_PROMPT_DIGEST,
      revisionPromptVersion: TARGETED_PROBLEM_REVISION_VERSION,
      revisionPromptDigest: TARGETED_PROBLEM_BATCH_REVISION_PROMPT_DIGEST,
      diagnosticEvidenceHash: sha256(JSON.stringify(members.map((member) => ({
        key: member.key,
        evidence: member.immutable.base.classification.transcription_evidence,
      })))),
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      items: members.map((member) => itemByKey.get(member.key)!.evidence),
    };
    if (match[3] !== targetsDigest || !isDeepStrictEqual(checkpoint, expectedCheckpoint)
      || members.some((member) => member.immutable.base.contextFrom !== contextFrom
        || member.immutable.base.contextTo !== contextTo
        || itemByKey.get(member.key)!.page !== member.immutable.base.question.page)) {
      throw new Error(`${relativePath}: persisted v2 problem repair graph is stale`);
    }
    for (const member of members) {
      const question = itemByKey.get(member.key)!;
      addRecord({
        key: member.key,
        base: member.immutable.base,
        solution: member.immutable.solution,
        question,
        contextFrom,
        contextTo,
        problemArtifact: pointer,
        problemArtifactItemHash: canonicalEvidenceHash(question.evidence),
      });
    }
  }

  for (const name of strictRepairGraphNames(
    stateDir,
    "problem-repairs",
    "legacy problem repair graph",
    (candidate) => /^v2-\d{4}-\d{4}\.json$/u.test(candidate),
  )) {
    const relativePath = `problem-repairs/${name}`;
    const { pointer, checkpoint } = readCanonicalGraphArtifact(
      stateDir,
      relativePath,
      "persisted legacy problem repair graph",
    );
    const key = exactString(checkpoint.key, `${relativePath}.key`);
    const immutable = persistedV2ProblemBase(key, base, solutions);
    const question = parseProblem(checkpoint.item, `${relativePath}.item`);
    const expectedPath = `problem-repairs/v${PROBLEM_REPAIR_VERSION}-` +
      `${String(immutable.base.question.page).padStart(4, "0")}-` +
      `${immutable.base.question.printedNumber.padStart(4, "0")}.json`;
    const expectedCheckpoint = {
      version: PROBLEM_REPAIR_VERSION,
      entryId: entry.id,
      key,
      sourcePage: immutable.base.question.page,
      printedNumber: immutable.base.question.printedNumber,
      contextFrom: immutable.base.contextFrom,
      contextTo: immutable.base.contextTo,
      sourceHash: problemEvidence.sha256,
      baseProblemCheckpoint: immutable.base.problemCheckpoint,
      baseQuestionHash: immutable.baseQuestionHash,
      baseSolutionCheckpoint: immutable.solution.checkpoint,
      baseSolutionItemHash: immutable.baseSolutionItemHash,
      officialRawAnswerHash: immutable.officialRawAnswerHash,
      promptVersion: TARGETED_PROBLEM_TRANSCRIPTION_VERSION,
      promptDigest: TARGETED_PROBLEM_PROMPT_DIGEST,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      item: question.evidence,
    };
    if (relativePath !== expectedPath || question.key !== key || !isDeepStrictEqual(checkpoint, expectedCheckpoint)) {
      throw new Error(`${relativePath}: persisted legacy problem repair graph is stale`);
    }
    const context = `${immutable.base.contextFrom}:${immutable.base.contextTo}`;
    if (batchVersions.get(context) === 1) continue;
    addRecord({
      key,
      base: immutable.base,
      solution: immutable.solution,
      question,
      contextFrom: immutable.base.contextFrom,
      contextTo: immutable.base.contextTo,
      problemArtifact: pointer,
      problemArtifactItemHash: canonicalEvidenceHash(question.evidence),
    });
  }

  return { recordsByIdentity, recordsByContext, batchVersions };
}

function scanPersistedV2ClassificationGraphs(
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  rulesDigest: string,
  recordsByIdentity: Map<string, PersistedV2ProblemRecord>,
  batchVersions: Map<string, 1 | 2>,
  declaredPaths: Set<string>,
): PersistedV2ClassificationGraph[] {
  const graphs: PersistedV2ClassificationGraph[] = [];
  for (const name of strictRepairGraphNames(
    stateDir,
    "classification-repair-batches",
    "classification repair batch",
    (candidate) => /^v1-\d{4}-\d{4}-[a-f0-9]{64}-[a-f0-9]{16}\.json$/u.test(candidate),
  )) {
    const match = /^v1-(\d{4})-(\d{4})-([a-f0-9]{64})-([a-f0-9]{16})\.json$/u.exec(name)!;
    const contextFrom = Number(match[1]);
    const contextTo = Number(match[2]);
    const contextKey = `${contextFrom}:${contextTo}`;
    const relativePath = `classification-repair-batches/${name}`;
    if (batchVersions.get(contextKey) === 1) {
      if (!declaredPaths.has(relativePath)) {
        throw new Error(`${relativePath}: legacy classification repair graph is not declared by the terminal audit`);
      }
      continue;
    }
    const { pointer, checkpoint } = readCanonicalGraphArtifact(
      stateDir,
      relativePath,
      "persisted classification repair graph",
    );
    const rawMembers = Array.isArray(checkpoint.members)
      ? checkpoint.members.map((value, index) => object(value, `${relativePath}.members[${index}]`))
      : [];
    const memberKeys = rawMembers.map((member, index) =>
      exactString(member.key, `${relativePath}.members[${index}].key`));
    if (!Array.isArray(checkpoint.items)) {
      throw new Error(`${relativePath}: classification repair graph items are missing`);
    }
    const itemRows = checkpoint.items.map((value, index) =>
      object(value, `${relativePath}.items[${index}]`));
    const itemKeys = itemRows.map((item, index) =>
      exactString(item.key, `${relativePath}.items[${index}].key`));
    if (rawMembers.length === 0 || rawMembers.length !== itemRows.length
      || new Set(memberKeys).size !== memberKeys.length || new Set(itemKeys).size !== itemKeys.length
      || itemKeys.some((key) => !memberKeys.includes(key))) {
      throw new Error(`${relativePath}: classification repair graph member/output coverage is not exact`);
    }
    const records = rawMembers.map((member, index) => {
      const authority = object(member.problemAuthority, `${relativePath}.members[${index}].problemAuthority`);
      const problemPath = exactString(authority.path, `${relativePath}.members[${index}].problemAuthority.path`);
      const record = recordsByIdentity.get(JSON.stringify([problemPath, memberKeys[index]]));
      if (!record) throw new Error(`${relativePath}: classification repair graph references partial authority`);
      if (record.contextFrom !== contextFrom || record.contextTo !== contextTo) {
        throw new Error(`${relativePath}: classification repair graph context does not match problem authority`);
      }
      return record;
    });
    const expectedMembers = records.map((record, index) => ({
      key: memberKeys[index],
      problemAuthority: {
        key: memberKeys[index],
        path: record.problemArtifact.path,
        sha256: record.problemArtifact.sha256,
        itemHash: record.problemArtifactItemHash,
      },
      effectiveQuestionHash: canonicalEvidenceHash(record.question.evidence),
      baseClassificationCheckpoint: record.base.classificationCheckpoint,
      baseClassificationHash: canonicalEvidenceHash(record.base.classification),
    }));
    const overlayDigest = canonicalEvidenceHash(expectedMembers);
    const questionByKey = new Map(records.map((record) => [record.key, record.question]));
    const classifications = new Map<string, ClassificationEvidence>();
    const items = itemRows.map((value, index) => {
      const key = itemKeys[index];
      const question = questionByKey.get(key);
      if (!question || classifications.has(key)) {
        throw new Error(`${relativePath}: classification repair graph item ${key} is missing or duplicated`);
      }
      const classification = parseClassificationEvidence(
        value,
        question,
        entry,
        `${relativePath}.items[${index}]`,
      );
      classifications.set(key, classification);
      return classification;
    });
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
      members: expectedMembers,
      items,
    };
    if (match[3] !== overlayDigest || match[4] !== rulesDigest
      || !isDeepStrictEqual(checkpoint, expectedCheckpoint)) {
      throw new Error(`${relativePath}: classification repair graph metadata/content is stale`);
    }
    graphs.push({ contextKey, path: relativePath, pointer, records, classifications });
  }
  return graphs;
}

function existingTerminalBacksProblemCorpus(
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  effective: DecisionSummary,
  cache: EvidenceCache,
  contract: VerificationContract,
): boolean {
  if (contract.problemTerminalFidelityVersion !== PROBLEM_TERMINAL_FIDELITY_VERSION) {
    throw new Error("persisted regrouping requires terminal problem fidelity v2 authority");
  }
  const effectiveCorpusHash = canonicalEvidenceHash(effective.order.map((key) => {
    const record = effective.records.get(key)!;
    return { question: record.question.evidence, classification: record.classification };
  }));
  const targets = expectedProblemFidelitySlices(problemEvidence.pageCount).flatMap((slice) => {
    const records = effective.order.map((key) => effective.records.get(key)!)
      .filter((record) => record.question.page >= slice.ownedFrom && record.question.page <= slice.ownedTo);
    if (records.length === 0) return [];
    const inputs = records.map(problemTerminalInput);
    const inputHash = canonicalEvidenceHash(inputs);
    const relativePath = `problem-terminal-fidelity/v${PROBLEM_TERMINAL_FIDELITY_VERSION}-` +
      `${String(slice.index).padStart(4, "0")}-${effectiveCorpusHash}-${inputHash}.json`;
    return [{ slice, inputHash, relativePath }];
  });
  const existing = targets.filter((target) => existsSync(join(stateDir, target.relativePath)));
  if (existing.length === 0) return false;
  if (existing.length !== targets.length) {
    throw new Error(`${effectiveCorpusHash}: persisted regrouping terminal generation coverage is incomplete`);
  }
  for (const target of targets) {
    const placeholder = { path: target.relativePath, sha256: "0".repeat(64) };
    const absolute = confinedEvidencePath(stateDir, placeholder, "persisted regrouping terminal checkpoint");
    const pointer: ProblemTerminalFidelityCheckpoint = {
      path: target.relativePath,
      sha256: hashFile(absolute),
      from: target.slice.from,
      to: target.slice.to,
      ownedFrom: target.slice.ownedFrom,
      ownedTo: target.slice.ownedTo,
      inputHash: target.inputHash,
    };
    verifyProblemTerminalFidelityCheckpoint(
      stateDir,
      entry,
      problemEvidence,
      effective,
      effectiveCorpusHash,
      pointer,
      cache,
      contract,
    );
  }
  return true;
}

function graphRepairs(
  graph: PersistedV2ClassificationGraph,
): Array<{
  key: string;
  classified: ClassifiedEvidence;
  problemArtifact: EvidencePointer;
  problemArtifactItemHash: string;
  classificationArtifact: EvidencePointer;
  classificationArtifactItemHash: string;
}> {
  return graph.records.map((record) => {
    const classification = graph.classifications.get(record.key);
    if (!classification) throw new Error(`${graph.path}: classification graph omits ${record.key}`);
    return {
      key: record.key,
      classified: {
        question: record.question,
        classification,
        problemCheckpoint: record.base.problemCheckpoint,
        classificationCheckpoint: record.base.classificationCheckpoint,
        contextFrom: record.contextFrom,
        contextTo: record.contextTo,
      },
      problemArtifact: record.problemArtifact,
      problemArtifactItemHash: record.problemArtifactItemHash,
      classificationArtifact: graph.pointer,
      classificationArtifactItemHash: canonicalEvidenceHash(classification),
    };
  });
}

function verifyPersistedV2RepairGraphSelection(
  rows: V3RepairRow[] | null,
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  rulesDigest: string,
  base: DecisionSummary,
  solutions: Map<string, OfficialSolution>,
  cache: EvidenceCache,
  contract: VerificationContract,
): PersistedV2GraphSelection {
  const scanned = scanPersistedV2ProblemRecords(
    stateDir,
    entry,
    problemEvidence,
    base,
    solutions,
  );
  const declaredClassificationPaths = new Set((rows ?? []).map((row) => row.classificationArtifact.path));
  const graphs = scanPersistedV2ClassificationGraphs(
    stateDir,
    entry,
    problemEvidence,
    rulesDigest,
    scanned.recordsByIdentity,
    scanned.batchVersions,
    declaredClassificationPaths,
  );
  const duplicateContexts = new Set<string>();
  for (const [context, records] of scanned.recordsByContext) {
    const counts = new Map<string, number>();
    for (const record of records) counts.set(record.key, (counts.get(record.key) ?? 0) + 1);
    if ([...counts.values()].some((count) => count > 1)) duplicateContexts.add(context);
  }

  const fixedGraphs = graphs.filter((graph) => !duplicateContexts.has(graph.contextKey));
  const fixedRepairs = new Map<string, ReturnType<typeof graphRepairs>[number]>();
  for (const graph of fixedGraphs) {
    for (const repair of graphRepairs(graph)) {
      if (fixedRepairs.has(repair.key)) {
        throw new Error(`${repair.key}: non-overlapping classification repair graphs conflict`);
      }
      fixedRepairs.set(repair.key, repair);
    }
  }
  if (duplicateContexts.size === 0) {
    return {
      effectiveCorpusHash: null,
      selectedClassificationPaths: fixedGraphs.map((graph) => graph.path),
      historicalProblemBatchPaths: new Set<string>(),
    };
  }

  const coversByContext = [...duplicateContexts].sort().map((context) => {
    const records = scanned.recordsByContext.get(context) ?? [];
    const expectedKeys = new Set(records.map((record) => record.key));
    const contextGraphs = graphs.filter((graph) => graph.contextKey === context);
    const referencedIdentities = new Set(contextGraphs.flatMap((graph) => graph.records.map((record) =>
      JSON.stringify([record.problemArtifact.path, record.key]))));
    const unreferenced = records.find((record) =>
      !referencedIdentities.has(JSON.stringify([record.problemArtifact.path, record.key])));
    if (unreferenced) {
      throw new Error(
        `${unreferenced.problemArtifact.path} ${unreferenced.key}: persisted regrouping problem artifact ` +
        "is not referenced by a classification graph",
      );
    }
    if (contextGraphs.length > 24) throw new Error(`${context}: persisted regrouping has too many graphs`);
    const covers: PersistedV2ClassificationGraph[][] = [];
    let searchSteps = 0;
    const visit = (covered: ReadonlySet<string>, chosen: PersistedV2ClassificationGraph[]) => {
      searchSteps += 1;
      if (searchSteps > 4096 || covers.length > 256) {
        throw new Error(`${context}: persisted regrouping full-cover search bound exceeded`);
      }
      if (covered.size === expectedKeys.size) {
        covers.push(chosen);
        return;
      }
      const nextKey = [...expectedKeys].sort(compareCorpusQuestionKeys).find((key) => !covered.has(key));
      if (!nextKey) return;
      for (const graph of contextGraphs) {
        const keys = graph.records.map((record) => record.key);
        if (!keys.includes(nextKey) || keys.some((key) => covered.has(key))) continue;
        const next = new Set(covered);
        for (const key of keys) next.add(key);
        visit(next, [...chosen, graph]);
      }
    };
    visit(new Set(), []);
    const participatingGraphs = new Set(covers.flat());
    if (participatingGraphs.size !== contextGraphs.length) {
      const orphan = contextGraphs.find((graph) => !participatingGraphs.has(graph))!;
      throw new Error(`${orphan.path}: classification repair graph does not participate in any full cover`);
    }
    return covers;
  });
  let combinations: PersistedV2ClassificationGraph[][] = [[]];
  for (const covers of coversByContext) {
    combinations = combinations.flatMap((combination) => covers.map((cover) => [...combination, ...cover]));
    if (combinations.length > 256) throw new Error("persisted regrouping full-cover combination bound exceeded");
  }

  const terminalBacked: Array<{
    graphs: PersistedV2ClassificationGraph[];
    repairs: Map<string, ReturnType<typeof graphRepairs>[number]>;
    effectiveCorpusHash: string;
  }> = [];
  for (const combination of combinations) {
    const repairs = new Map(fixedRepairs);
    for (const graph of combination) {
      for (const repair of graphRepairs(graph)) {
        if (repairs.has(repair.key)) throw new Error(`${repair.key}: persisted regrouping cover overlaps`);
        repairs.set(repair.key, repair);
      }
    }
    const records = new Map(base.records);
    for (const [key, repair] of repairs) records.set(key, repair.classified);
    const effective = summarizeDecisions(records, base.order, rulesDigest);
    if (existingTerminalBacksProblemCorpus(
      stateDir,
      entry,
      problemEvidence,
      effective,
      cache,
      contract,
    )) {
      terminalBacked.push({
        graphs: [...fixedGraphs, ...combination],
        repairs,
        effectiveCorpusHash: canonicalEvidenceHash(effective.order.map((key) => {
          const record = effective.records.get(key)!;
          return { question: record.question.evidence, classification: record.classification };
        })),
      });
    }
  }
  if (terminalBacked.length !== 1) {
    throw new Error(`persisted regrouping terminal-backed full-cover is not unique: ${terminalBacked.length}`);
  }
  const selected = terminalBacked[0];
  if (rows !== null) {
    const rowByKey = new Map(rows.map((row) => [row.key, row]));
    for (const repair of selected.repairs.values()) {
      const row = rowByKey.get(repair.key);
      if (!row || !isDeepStrictEqual(row.problemArtifact, repair.problemArtifact)
        || row.problemArtifactItemHash !== repair.problemArtifactItemHash
        || !isDeepStrictEqual(row.classificationArtifact, repair.classificationArtifact)
        || row.classificationArtifactItemHash !== repair.classificationArtifactItemHash) {
        throw new Error(`${repair.key}: terminal-backed repair graph does not match the terminal audit pointers`);
      }
    }
    const duplicateProblemPaths = new Set(
      [...duplicateContexts].flatMap((context) =>
        (scanned.recordsByContext.get(context) ?? []).map((record) => record.problemArtifact.path)),
    );
    for (const row of rows) {
      if (!duplicateProblemPaths.has(row.problemArtifact.path)) continue;
      const repair = selected.repairs.get(row.key);
      if (!repair || !isDeepStrictEqual(row.problemArtifact, repair.problemArtifact)
        || !isDeepStrictEqual(row.classificationArtifact, repair.classificationArtifact)) {
        throw new Error(`${row.key}: terminal audit selects a non-authoritative regrouping cover`);
      }
    }
  }
  const historicalProblemBatchPaths = new Set<string>();
  for (const context of duplicateContexts) {
    for (const record of scanned.recordsByContext.get(context) ?? []) {
      if (record.problemArtifact.path.startsWith("problem-repair-batches/v2-")) {
        historicalProblemBatchPaths.add(record.problemArtifact.path);
      }
    }
  }
  return {
    effectiveCorpusHash: selected.effectiveCorpusHash,
    selectedClassificationPaths: selected.graphs.map((graph) => graph.path),
    historicalProblemBatchPaths,
  };
}

export function verifyPersistedProblemRepairOverlapForTest(stateDir: string, auditPath?: string): {
  effectiveCorpusHash: string | null;
  selectedClassificationPaths: string[];
} {
  const saved = object(json(join(stateDir, "entry.json")), "entry.json");
  const raw = object(saved.entry, "entry.json.entry");
  const subject = exactString(raw.subject, "entry.subject") as SourceSubject;
  const grade = integer(raw.grade, "entry.grade", 1) as 1 | 2 | 3;
  if (!(subject in CANONICAL_BY_SOURCE) || grade > 3) throw new Error("entry identity is invalid");
  const entry: ManifestEntry = {
    id: exactString(raw.id, "entry.id"),
    sourceRecordDate: exactString(raw.sourceRecordDate, "entry.sourceRecordDate"),
    sourceRecordYear: integer(raw.sourceRecordYear, "entry.sourceRecordYear", 2000),
    sourceRecordMonth: integer(raw.sourceRecordMonth, "entry.sourceRecordMonth", 1),
    grade,
    subject,
    examTitle: exactString(raw.examTitle, "entry.examTitle"),
    rawTitle: exactString(raw.rawTitle, "entry.rawTitle"),
    variant: raw.variant === null ? null : exactString(raw.variant, "entry.variant"),
    form: raw.form as "odd" | "even" | null,
    problemPdfUrl: exactString(raw.problemPdfUrl, "entry.problemPdfUrl"),
    solutionPdfUrl: exactString(raw.solutionPdfUrl, "entry.solutionPdfUrl"),
    raw,
  };
  const failures: Failure[] = [];
  const add: AddFailure = (failure) => failures.push(failure);
  const downloads = object(json(join(stateDir, "downloads.json")), "downloads.json");
  const problemEvidence = parseDownload(downloads.problem, "problem", entry.problemPdfUrl, entry.id, add);
  const solutionEvidence = parseDownload(downloads.solution, "solution", entry.solutionPdfUrl, entry.id, add);
  if (!problemEvidence || !solutionEvidence || failures.length > 0) {
    throw new Error(failures.map((failure) => failure.message).join("; ") || "download evidence is invalid");
  }
  for (const evidence of [problemEvidence, solutionEvidence]) {
    const absolute = join(stateDir, evidence.path);
    if (!statSync(absolute).isFile() || hashFile(absolute) !== evidence.sha256) {
      throw new Error(`${evidence.path}: source evidence hash is invalid`);
    }
  }
  const base = loadDecisions(stateDir, entry, problemEvidence, null, CURRENT_CONTRACT, add);
  const solutions = loadSolutions(stateDir, entry, solutionEvidence, add);
  if (failures.length > 0 || base.rulesDigest === null) {
    throw new Error(failures.map((failure) => failure.message).join("; ") || "base corpus is invalid");
  }
  let rows: V3RepairRow[] | null = null;
  if (auditPath !== undefined) {
    const audit = object(json(join(stateDir, auditPath)), auditPath);
    if (!Array.isArray(audit.repairs)) throw new Error(`${auditPath}: answer audit repairs are missing`);
    rows = prepareV3RepairRows(audit.repairs, stateDir, base, solutions);
  }
  const selected = verifyPersistedV2RepairGraphSelection(
    rows,
    stateDir,
    entry,
    problemEvidence,
    base.rulesDigest,
    base,
    solutions,
    new Map(),
    CURRENT_CONTRACT,
  );
  return {
    effectiveCorpusHash: selected.effectiveCorpusHash,
    selectedClassificationPaths: selected.selectedClassificationPaths,
  };
}

function problemRepairBatchVersionsByContext(
  stateDir: string,
  declaredPaths: Set<string>,
  historicalPaths: ReadonlySet<string>,
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
    if (!declaredPaths.has(candidate) && !historicalPaths.has(candidate)) {
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
  historicalProblemBatchPaths: ReadonlySet<string>,
): Map<string, ProblemQuestion> {
  const corrected = new Map<string, ProblemQuestion>();
  const batchVersions = problemRepairBatchVersionsByContext(stateDir, new Set(rows.flatMap((row) =>
    row.problemArtifact.path.startsWith("problem-repair-batches/")
      ? [row.problemArtifact.path]
      : [])), historicalProblemBatchPaths);
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

type PersistedTerminalRecoverySelection = {
  spec: PersistedTerminalRecoveryHydrationSpec;
  historicalPaths: Set<string>;
  exactRecoverySets: Array<{
    key: string;
    problemPaths: Set<string>;
    classificationPaths: Set<string>;
  }>;
};

type ProblemRecoveryCoverageAuthority = Pick<
  PersistedTerminalRecoverySelection,
  "historicalPaths" | "exactRecoverySets"
>;

type PersistedTerminalRecoveryAuditAuthority = {
  pointer: EvidencePointer;
  digest: string;
  effectiveCorpusHash: unknown;
  terminalCheckpoints: unknown;
};

function persistedTerminalRecoverySelection(
  values: unknown[],
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  auditAuthority: PersistedTerminalRecoveryAuditAuthority,
): PersistedTerminalRecoverySelection | null {
  const matches = PERSISTED_TERMINAL_RECOVERY_HYDRATION_ALLOWLIST.filter((spec) => spec.entryId === entry.id);
  if (matches.length > 1) throw new Error(`${entry.id}: persisted terminal recovery allowlist is duplicated`);
  const spec = matches[0];
  if (!spec) return null;
  if (problemEvidence.sha256 !== spec.sourceHash) {
    throw new Error(`${entry.id}: persisted terminal recovery source hash is stale`);
  }
  const repairRows = values.map((value, index) => object(value, `answer audit repairs[${index}]`));
  const targetRows = repairRows.filter((repair) => repair.key === spec.key);
  if (targetRows.length !== 1) {
    throw new Error(`${spec.key}: persisted terminal recovery audit row is not unique`);
  }
  const repair = targetRows[0];
  const revision = object(repair.revision, `${spec.key}.revision`);
  const recovery = object(revision.recovery, `${spec.key}.revision.recovery`);
  const recoveryProblem = evidencePointer(recovery.problemArtifact, `${spec.key}.recovery.problemArtifact`);
  const recoveryClassificationEnvelope = object(
    recovery.classificationArtifact,
    `${spec.key}.recovery.classificationArtifact`,
  );
  const recoveryClassification = evidencePointer({
    path: recoveryClassificationEnvelope.path,
    sha256: recoveryClassificationEnvelope.sha256,
  }, `${spec.key}.recovery.classificationArtifact`);
  const revisionProblem = evidencePointer(revision.problemArtifact, `${spec.key}.revision.problemArtifact`);
  const revisionClassificationEnvelope = object(
    revision.classificationArtifact,
    `${spec.key}.revision.classificationArtifact`,
  );
  const revisionClassification = evidencePointer({
    path: revisionClassificationEnvelope.path,
    sha256: revisionClassificationEnvelope.sha256,
  }, `${spec.key}.revision.classificationArtifact`);
  const repairProblem = evidencePointer(repair.problemArtifact, `${spec.key}.problemArtifact`);
  const repairClassificationEnvelope = object(repair.classificationArtifact, `${spec.key}.classificationArtifact`);
  const repairClassification = evidencePointer({
    path: repairClassificationEnvelope.path,
    sha256: repairClassificationEnvelope.sha256,
  }, `${spec.key}.classificationArtifact`);
  const revisionTrigger = object(revision.trigger, `${spec.key}.revision.trigger`);
  if (repair.sourcePage !== spec.sourcePage || repair.contextFrom !== spec.contextFrom
    || repair.contextTo !== spec.contextTo
    || !isDeepStrictEqual(repairProblem, {
      path: spec.baseProblemRepairArtifact.path,
      sha256: spec.baseProblemRepairArtifact.sha256,
    })
    || repair.problemArtifactItemHash !== spec.baseProblemRepairArtifact.itemHash
    || !isDeepStrictEqual(repairClassification, {
      path: spec.baseClassificationRepairArtifact.path,
      sha256: spec.baseClassificationRepairArtifact.sha256,
    })
    || repair.classificationArtifactItemHash !== spec.baseClassificationRepairArtifact.itemHash
    || !isDeepStrictEqual(revisionProblem, {
      path: spec.revisionProblemArtifact.path,
      sha256: spec.revisionProblemArtifact.sha256,
    })
    || revision.problemArtifactItemHash !== spec.revisionProblemArtifact.itemHash
    || !isDeepStrictEqual(revisionClassification, {
      path: spec.revisionClassificationArtifact.path,
      sha256: spec.revisionClassificationArtifact.sha256,
    })
    || revision.classificationArtifactItemHash !== spec.revisionClassificationArtifact.itemHash
    || revision.baseQuestionHash !== spec.revisionBaseQuestionHash
    || revision.baseClassificationHash !== spec.revisionBaseClassificationHash
    || revision.diagnosticEvidenceHash !== spec.revisionTriggerEvidenceHash
    || !isDeepStrictEqual(revisionTrigger, {
      kind: "classification",
      evidenceHash: spec.revisionTriggerEvidenceHash,
    })
    || !isDeepStrictEqual(recoveryProblem, {
      path: spec.selected.problemArtifact.path,
      sha256: spec.selected.problemArtifact.sha256,
    })
    || recovery.problemArtifactItemHash !== spec.selected.problemArtifact.itemHash
    || !isDeepStrictEqual(recoveryClassification, {
      path: spec.selected.classificationArtifact.path,
      sha256: spec.selected.classificationArtifact.sha256,
    })
    || recovery.classificationArtifactItemHash !== spec.selected.classificationArtifact.itemHash) {
    throw new Error(`${spec.key}: current audit does not select the source-authorized terminal recovery`);
  }
  const companion = spec.companion;
  if (companion) {
    const companionRows = repairRows.filter((candidate) => candidate.key === companion.key);
    if (companionRows.length !== 1) {
      throw new Error(`${companion.key}: persisted terminal recovery audit row is not unique`);
    }
    const companionRepair = companionRows[0];
    const companionRevision = object(companionRepair.revision, `${companion.key}.revision`);
    const companionRecovery = object(companionRevision.recovery, `${companion.key}.revision.recovery`);
    const companionProblem = evidencePointer(
      companionRepair.problemArtifact,
      `${companion.key}.problemArtifact`,
    );
    const companionClassificationEnvelope = object(
      companionRepair.classificationArtifact,
      `${companion.key}.classificationArtifact`,
    );
    const companionClassification = evidencePointer({
      path: companionClassificationEnvelope.path,
      sha256: companionClassificationEnvelope.sha256,
    }, `${companion.key}.classificationArtifact`);
    const companionRevisionProblem = evidencePointer(
      companionRevision.problemArtifact,
      `${companion.key}.revision.problemArtifact`,
    );
    const companionRevisionClassificationEnvelope = object(
      companionRevision.classificationArtifact,
      `${companion.key}.revision.classificationArtifact`,
    );
    const companionRevisionClassification = evidencePointer({
      path: companionRevisionClassificationEnvelope.path,
      sha256: companionRevisionClassificationEnvelope.sha256,
    }, `${companion.key}.revision.classificationArtifact`);
    const companionRecoveryProblem = evidencePointer(
      companionRecovery.problemArtifact,
      `${companion.key}.recovery.problemArtifact`,
    );
    const companionRecoveryClassificationEnvelope = object(
      companionRecovery.classificationArtifact,
      `${companion.key}.recovery.classificationArtifact`,
    );
    const companionRecoveryClassification = evidencePointer({
      path: companionRecoveryClassificationEnvelope.path,
      sha256: companionRecoveryClassificationEnvelope.sha256,
    }, `${companion.key}.recovery.classificationArtifact`);
    if (canonicalEvidenceHash(companionRepair) !== companion.repairHash
      || companionRepair.sourcePage !== companion.sourcePage
      || companionRepair.contextFrom !== companion.contextFrom
      || companionRepair.contextTo !== companion.contextTo
      || !isDeepStrictEqual(companionProblem, {
        path: companion.baseProblemRepairArtifact.path,
        sha256: companion.baseProblemRepairArtifact.sha256,
      })
      || companionRepair.problemArtifactItemHash !== companion.baseProblemRepairArtifact.itemHash
      || !isDeepStrictEqual(companionClassification, {
        path: companion.baseClassificationRepairArtifact.path,
        sha256: companion.baseClassificationRepairArtifact.sha256,
      })
      || companionRepair.classificationArtifactItemHash !== companion.baseClassificationRepairArtifact.itemHash
      || !isDeepStrictEqual(companionRevisionProblem, {
        path: companion.revisionProblemArtifact.path,
        sha256: companion.revisionProblemArtifact.sha256,
      })
      || companionRevision.problemArtifactItemHash !== companion.revisionProblemArtifact.itemHash
      || !isDeepStrictEqual(companionRevisionClassification, {
        path: companion.revisionClassificationArtifact.path,
        sha256: companion.revisionClassificationArtifact.sha256,
      })
      || companionRevision.classificationArtifactItemHash !== companion.revisionClassificationArtifact.itemHash
      || !isDeepStrictEqual(companionRecoveryProblem, {
        path: companion.selected.problemArtifact.path,
        sha256: companion.selected.problemArtifact.sha256,
      })
      || companionRecovery.problemArtifactItemHash !== companion.selected.problemArtifact.itemHash
      || !isDeepStrictEqual(companionRecoveryClassification, {
        path: companion.selected.classificationArtifact.path,
        sha256: companion.selected.classificationArtifact.sha256,
      })
      || companionRecovery.classificationArtifactItemHash !== companion.selected.classificationArtifact.itemHash) {
      throw new Error(`${companion.key}: current audit does not select the exact companion terminal recovery`);
    }
    if (!isDeepStrictEqual(auditAuthority.pointer, {
      path: companion.finalAudit.path,
      sha256: companion.finalAudit.sha256,
    })
      || auditAuthority.digest !== companion.finalAudit.auditDigest
      || auditAuthority.effectiveCorpusHash !== companion.finalEffectiveCorpusHash
      || !isDeepStrictEqual(auditAuthority.terminalCheckpoints, [companion.finalTerminal])) {
      throw new Error(`${companion.key}: persisted terminal recovery final audit authority is stale`);
    }
  }
  return {
    spec,
    historicalPaths: new Set(spec.historical.flatMap((generation) => [
      generation.problemArtifact.path,
      generation.classificationArtifact.path,
    ])),
    exactRecoverySets: [
      {
        key: spec.key,
        problemPaths: new Set([spec.selected, ...spec.historical]
          .map((generation) => generation.problemArtifact.path)),
        classificationPaths: new Set([spec.selected, ...spec.historical]
          .map((generation) => generation.classificationArtifact.path)),
      },
      ...(companion ? [{
        key: companion.key,
        problemPaths: new Set([companion.selected.problemArtifact.path]),
        classificationPaths: new Set([companion.selected.classificationArtifact.path]),
      }] : []),
    ],
  };
}

function verifyProblemManualArtifactInventory(stateDir: string, declaredManual: ReadonlySet<string>): void {
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
    ["problem-manual-revisions", [
      /^v1-\d{4}-\d{4}-[a-f0-9]{64}\.json$/u,
    ]],
    ["classification-manual-revisions", [
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

function verifyProblemRecoveryCoverage(
  values: unknown[],
  stateDir: string,
  contract: VerificationContract,
  recoveryCoverageAuthority: ProblemRecoveryCoverageAuthority | null = null,
): void {
  const historicalRecoveryPaths = recoveryCoverageAuthority?.historicalPaths ?? new Set<string>();
  const declared = new Set<string>();
  const declaredCrop = new Set<string>();
  const declaredScope = new Set<string>();
  const declaredRepairScope = new Set<string>();
  const declaredPositiveRepairScope = new Set<string>();
  const declaredRevisionScope = new Set<string>();
  const declaredManual = new Set<string>();
  const declaredScopeBox = new Set<string>();
  const declaredTerminalAdjudication = new Set<string>();
  const declaredTerminalPolicyRevision = new Set<string>();
  for (const [index, value] of values.entries()) {
    const repair = object(value, `answer audit repairs[${index}]`);
    if (repair.terminalAdjudication !== undefined) {
      if (contract.auditVersion !== 5) {
        throw new Error("terminal fidelity adjudication requires answer audit v5");
      }
      const adjudication = object(
        repair.terminalAdjudication,
        `answer audit repairs[${index}].terminalAdjudication`,
      );
      const envelope = object(
        adjudication.adjudicationArtifact,
        `answer audit repairs[${index}].terminalAdjudication.adjudicationArtifact`,
      );
      const pointer = evidencePointer(
        { path: envelope.path, sha256: envelope.sha256 },
        `answer audit repairs[${index}].terminalAdjudication.adjudicationArtifact`,
      );
      if (declaredTerminalAdjudication.has(pointer.path)) {
        throw new Error(`${pointer.path}: duplicate terminal fidelity adjudication authority`);
      }
      declaredTerminalAdjudication.add(pointer.path);
      if (adjudication.policyRevision !== undefined) {
        const policyRevision = object(
          adjudication.policyRevision,
          `answer audit repairs[${index}].terminalAdjudication.policyRevision`,
        );
        const policyEnvelope = object(
          policyRevision.policyArtifact,
          `answer audit repairs[${index}].terminalAdjudication.policyRevision.policyArtifact`,
        );
        const policyPointer = evidencePointer({
          path: policyEnvelope.path,
          sha256: policyEnvelope.sha256,
        }, `answer audit repairs[${index}].terminalAdjudication.policyRevision.policyArtifact`);
        if (declaredTerminalPolicyRevision.has(policyPointer.path)) {
          throw new Error(`${policyPointer.path}: duplicate terminal fidelity policy revision authority`);
        }
        declaredTerminalPolicyRevision.add(policyPointer.path);
      }
    }
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
      const declaredSet = pointer.path.startsWith("classification-repair-positive-scope-adjudications/")
        ? declaredPositiveRepairScope
        : declaredRepairScope;
      if (declaredSet.has(pointer.path)) {
        throw new Error(`${pointer.path}: duplicate repair scope adjudication authority`);
      }
      declaredSet.add(pointer.path);
    }
    if (repair.revision === undefined) continue;
    const revision = object(repair.revision, `answer audit repairs[${index}].revision`);
    if (revision.scopeAdjudication !== undefined) {
      if (contract.auditVersion !== 5 || repair.scopeAdjudication !== undefined
        || revision.recovery !== undefined) {
        throw new Error("problem revision scope adjudication requires answer audit v5 and no other terminal child");
      }
      const adjudication = object(
        revision.scopeAdjudication,
        `answer audit repairs[${index}].revision.scopeAdjudication`,
      );
      const envelope = object(adjudication.classificationArtifact, "problem revision scope classification artifact");
      const pointer = evidencePointer(
        { path: envelope.path, sha256: envelope.sha256 },
        "problem revision scope classification artifact",
      );
      if (declaredRevisionScope.has(pointer.path)) {
        throw new Error(`${pointer.path}: duplicate revision scope adjudication authority`);
      }
      declaredRevisionScope.add(pointer.path);
    }
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
      if (adjudication.boxRevision !== undefined) {
        const boxRevision = object(
          adjudication.boxRevision,
          `answer audit repairs[${index}].revision.recovery.scopeAdjudication.boxRevision`,
        );
        const scopeBoxPointers: Array<[string, unknown]> = [
          ["scope box crop evidence", boxRevision.cropEvidenceArtifact],
          ["scope box crop PDF", boxRevision.cropEvidencePdf],
          ["scope box problem revision", boxRevision.problemArtifact],
          ["scope box classification revision", boxRevision.classificationArtifact],
        ];
        if (!Array.isArray(boxRevision.cropViews)) {
          throw new Error(`answer audit repairs[${index}] scope box crop views are missing`);
        }
        for (const [viewIndex, raw] of boxRevision.cropViews.entries()) {
          scopeBoxPointers.push([
            `scope box crop view ${viewIndex + 1}`,
            object(raw, `answer audit repairs[${index}] scope box cropViews[${viewIndex}]`).artifact,
          ]);
        }
        for (const [label, raw] of scopeBoxPointers) {
          const envelope = object(raw, `${label} artifact`);
          const childPointer = evidencePointer(
            { path: envelope.path, sha256: envelope.sha256 },
            `${label} artifact`,
          );
          if (declaredScopeBox.has(childPointer.path)) {
            throw new Error(`${childPointer.path}: duplicate scope box revision authority`);
          }
          declaredScopeBox.add(childPointer.path);
        }
      }
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
      if (manual.revision !== undefined) {
        const manualRevision = object(
          manual.revision,
          `answer audit repairs[${index}].revision.recovery.manualAdjudication.revision`,
        );
        manualPointers.push(
          ["problem manual revision", manualRevision.problemArtifact, true],
          ["classification manual revision", manualRevision.classificationArtifact, true],
        );
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
  const recoveryPathsByDirectory = new Map<string, string[]>();
  const isPinnedRecoveryPrefix = (path: string): boolean =>
    recoveryCoverageAuthority?.exactRecoverySets.some((exactSet) => {
      const [page, number] = exactSet.key.split(":");
      return path.startsWith(`problem-recoveries/v2-${String(Number(page)).padStart(4, "0")}-` +
        `${String(Number(number)).padStart(4, "0")}-`)
        || path.startsWith(`classification-recoveries/v2-${String(Number(page)).padStart(4, "0")}-` +
          `${String(Number(number)).padStart(4, "0")}-`);
    }) === true;
  for (const [directory, pattern] of [
    ["problem-recoveries", /^v[12]-\d{4}-\d{4}-[a-f0-9]{64}\.json$/u],
    ["classification-recoveries", /^v[12]-\d{4}-\d{4}-[a-f0-9]{64}-[a-f0-9]{16}\.json$/u],
  ] as const) {
    const names = recoveryCoverageAuthority
      ? strictRepairGraphNames(
          stateDir,
          directory,
          "persisted terminal recovery",
          (name) => pattern.test(name),
        )
      : listJson(join(stateDir, directory), /\.json$/u);
    const paths = names.map((name) => `${directory}/${name}`);
    recoveryPathsByDirectory.set(directory, paths);
    for (const name of names) {
      if (!pattern.test(name)) throw new Error(`${directory}/${name}: malformed problem recovery artifact name`);
      const path = `${directory}/${name}`;
      if (!declared.has(path) && !historicalRecoveryPaths.has(path) && !isPinnedRecoveryPrefix(path)) {
        throw new Error(`${path}: problem recovery artifact is not declared by the terminal audit`);
      }
    }
  }
  for (const exactSet of recoveryCoverageAuthority?.exactRecoverySets ?? []) {
    const [page, number] = exactSet.key.split(":");
    const suffix = `${String(Number(page)).padStart(4, "0")}-${String(Number(number)).padStart(4, "0")}-`;
    for (const [directory, expected] of [
      ["problem-recoveries", exactSet.problemPaths],
      ["classification-recoveries", exactSet.classificationPaths],
    ] as const) {
      const prefix = `${directory}/v2-${suffix}`;
      const actual = new Set((recoveryPathsByDirectory.get(directory) ?? [])
        .filter((path) => path.startsWith(prefix)));
      const extra = [...actual].find((path) => !expected.has(path));
      if (extra) {
        throw new Error(`${extra}: persisted terminal recovery artifact is an unexpected third generation`);
      }
      const missing = [...expected].find((path) => !actual.has(path));
      if (missing) throw new Error(`${missing}: persisted terminal recovery artifact is missing`);
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
  for (const [directory, declaredSet] of [
    ["classification-repair-scope-adjudications", declaredRepairScope],
    ["classification-repair-positive-scope-adjudications", declaredPositiveRepairScope],
  ] as const) {
    const absolute = join(stateDir, directory);
    if (existsSync(absolute)) {
      for (const entry of readdirSync(absolute, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.isFile() && entry.name.endsWith(".tmp")) continue;
        if (!entry.isFile() || entry.isSymbolicLink()) {
          throw new Error(`${directory}/${entry.name}: repair scope artifact must be a regular file`);
        }
        if (!/^v1-\d{4}-\d{4}-[a-f0-9]{64}-[a-f0-9]{16}\.json$/u.test(entry.name)) {
          throw new Error(`${directory}/${entry.name}: malformed repair scope artifact name`);
        }
        const path = `${directory}/${entry.name}`;
        if (!declaredSet.has(path)) {
          throw new Error(`${path}: repair scope adjudication artifact is not declared by the terminal audit`);
        }
      }
    }
    for (const path of declaredSet) {
      if (!existsSync(join(stateDir, path))) {
        throw new Error(`${path}: declared repair scope adjudication artifact is missing`);
      }
    }
  }
  const revisionScopeDirectory = join(stateDir, "classification-revision-scope-adjudications");
  if (existsSync(revisionScopeDirectory)) {
    for (const entry of readdirSync(revisionScopeDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isFile() && entry.name.endsWith(".tmp")) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(
          `classification-revision-scope-adjudications/${entry.name}: revision scope artifact must be a regular file`,
        );
      }
      if (!/^v1-\d{4}-\d{4}-[a-f0-9]{64}-[a-f0-9]{16}\.json$/u.test(entry.name)) {
        throw new Error(
          `classification-revision-scope-adjudications/${entry.name}: malformed revision scope artifact name`,
        );
      }
      const path = `classification-revision-scope-adjudications/${entry.name}`;
      if (!declaredRevisionScope.has(path)) {
        throw new Error(`${path}: revision scope adjudication artifact is not declared by the terminal audit`);
      }
    }
  }
  for (const path of declaredRevisionScope) {
    if (!existsSync(join(stateDir, path))) {
      throw new Error(`${path}: declared revision scope adjudication artifact is missing`);
    }
  }
  for (const [directory, patterns] of [
    ["problem-scope-box-evidence", [
      /^v1-\d{4}-\d{4}-[a-f0-9]{64}\.json$/u,
      /^v1-\d{4}-\d{4}-[a-f0-9]{64}\.pdf$/u,
      /^v1-\d{4}-\d{4}-[a-f0-9]{64}-view-\d{2}\.png$/u,
    ]],
    ["problem-scope-box-revisions", [
      /^v1-\d{4}-\d{4}-[a-f0-9]{64}\.json$/u,
    ]],
    ["classification-scope-box-revisions", [
      /^v1-\d{4}-\d{4}-[a-f0-9]{64}-[a-f0-9]{16}\.json$/u,
    ]],
  ] as const) {
    const absolute = join(stateDir, directory);
    if (!existsSync(absolute)) continue;
    const expectedDirectory = resolve(realpathSync(stateDir), directory);
    if (lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isDirectory()
      || realpathSync(absolute) !== expectedDirectory) {
      throw new Error(`${directory}: scope box artifact directory must be a confined regular directory`);
    }
    for (const entry of readdirSync(absolute, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isFile() && entry.name.endsWith(".tmp")) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`${directory}/${entry.name}: scope box artifact must be a regular file`);
      }
      if (!patterns.some((pattern) => pattern.test(entry.name))) {
        throw new Error(`${directory}/${entry.name}: malformed scope box artifact name`);
      }
      const path = `${directory}/${entry.name}`;
      if (!declaredScopeBox.has(path)) {
        throw new Error(`${path}: scope box artifact is not declared by the terminal audit`);
      }
    }
  }
  for (const path of declaredScopeBox) {
    if (!existsSync(join(stateDir, path))) {
      throw new Error(`${path}: declared scope box artifact is missing`);
    }
  }
  verifyProblemManualArtifactInventory(stateDir, declaredManual);
  const terminalAdjudicationDirectory = join(stateDir, "problem-terminal-fidelity-adjudications");
  if (existsSync(terminalAdjudicationDirectory)) {
    for (const entry of readdirSync(terminalAdjudicationDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isFile() && entry.name.endsWith(".tmp")) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(
          `problem-terminal-fidelity-adjudications/${entry.name}: terminal fidelity adjudication artifact must be a regular file`,
        );
      }
      if (!/^v1-\d{4}-\d{4}-[a-f0-9]{64}\.json$/u.test(entry.name)) {
        throw new Error(
          `problem-terminal-fidelity-adjudications/${entry.name}: malformed terminal fidelity adjudication artifact name`,
        );
      }
      const path = `problem-terminal-fidelity-adjudications/${entry.name}`;
      if (!declaredTerminalAdjudication.has(path)) {
        throw new Error(`${path}: terminal fidelity adjudication artifact is not declared by the terminal audit`);
      }
    }
  }
  for (const path of declaredTerminalAdjudication) {
    if (!existsSync(join(stateDir, path))) {
      throw new Error(`${path}: declared terminal fidelity adjudication artifact is missing`);
    }
  }
  const policyRevisionDirectory = join(stateDir, "problem-terminal-fidelity-policy-revisions");
  if (existsSync(policyRevisionDirectory)) {
    const expectedDirectory = resolve(realpathSync(stateDir), "problem-terminal-fidelity-policy-revisions");
    if (lstatSync(policyRevisionDirectory).isSymbolicLink()
      || !lstatSync(policyRevisionDirectory).isDirectory()
      || realpathSync(policyRevisionDirectory) !== expectedDirectory) {
      throw new Error(
        "problem-terminal-fidelity-policy-revisions: policy revision directory must be a confined regular directory",
      );
    }
    for (const entry of readdirSync(policyRevisionDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isFile() && entry.name.endsWith(".tmp")) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(
          `problem-terminal-fidelity-policy-revisions/${entry.name}: policy revision artifact must be a regular file`,
        );
      }
      if (!/^v1-\d{4}-\d{4}-[a-f0-9]{64}\.json$/u.test(entry.name)) {
        throw new Error(
          `problem-terminal-fidelity-policy-revisions/${entry.name}: malformed policy revision artifact name`,
        );
      }
      const path = `problem-terminal-fidelity-policy-revisions/${entry.name}`;
      if (!declaredTerminalPolicyRevision.has(path)) {
        throw new Error(`${path}: policy revision artifact is not declared by the terminal audit`);
      }
    }
  }
  for (const path of declaredTerminalPolicyRevision) {
    if (!existsSync(join(stateDir, path))) {
      throw new Error(`${path}: declared terminal fidelity policy revision artifact is missing`);
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

function problemManualRevisionSpec(
  entry: ManifestEntry,
  key: string,
  sourcePage: number,
  sourceHash: string,
  parentAllowlistId: string,
): ProblemManualRevisionSpec {
  const matches = PROBLEM_MANUAL_REVISION_ALLOWLIST.filter((spec) =>
    spec.entryId === entry.id && spec.key === key && spec.sourcePage === sourcePage
      && spec.parentAllowlistId === parentAllowlistId);
  if (matches.length !== 1) {
    throw new Error(`${entry.id} ${key}: manual revision is not uniquely allowlisted`);
  }
  if (matches[0].sourceHash !== sourceHash) {
    throw new Error(`${entry.id} ${key}: official manual revision source hash does not match the allowlist`);
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
    ...(spec.parentRecoveryEvidenceHash
      ? { parentRecoveryEvidenceHash: spec.parentRecoveryEvidenceHash }
      : {}),
    views: spec.views,
    ...(spec.dpi ? { dpi: spec.dpi } : {}),
    requiredTokens: spec.requiredTokens,
    replacements: spec.replacements,
    figure: spec.figure,
    figureDescription: spec.figureDescription,
    ...(spec.expectedDecision ? { expectedDecision: spec.expectedDecision } : {}),
    ...(spec.expectedCanonicalSubject
      ? { expectedCanonicalSubject: spec.expectedCanonicalSubject }
      : {}),
  });
}

function problemManualRevisionCorrectionSpecHash(spec: ProblemManualRevisionSpec): string {
  return canonicalEvidenceHash({
    allowlistId: spec.allowlistId,
    parentAllowlistId: spec.parentAllowlistId,
    replacement: spec.replacement,
    requiredTokens: spec.requiredTokens,
    expectedDecision: spec.expectedDecision,
    expectedCanonicalSubject: spec.expectedCanonicalSubject,
  });
}

function matchesProblemManualExpectedDecision(
  spec: Pick<ProblemManualAdjudicationSpec, "expectedDecision" | "expectedCanonicalSubject">,
  classification: Pick<ClassificationEvidence,
    "decision" | "canonical_subject" | "curriculum_course" | "domain" | "achievement_codes">,
): boolean {
  if (!spec.expectedDecision) return true;
  if (spec.expectedDecision === "reject") {
    return classification.decision === "reject" && classification.canonical_subject === null
      && classification.curriculum_course === null && classification.domain === null
      && classification.achievement_codes.length === 0;
  }
  return classification.decision === "accept"
    && classification.canonical_subject === spec.expectedCanonicalSubject
    && classification.curriculum_course !== null && classification.domain !== null
    && classification.achievement_codes.length > 0;
}

function applyProblemManualRevision(
  failed: ProblemQuestion,
  spec: ProblemManualRevisionSpec,
): ProblemQuestion {
  if (canonicalEvidenceHash(failed.evidence) !== spec.failedQuestionHash) {
    throw new Error(`${failed.key}: manual revision failed question hash is stale`);
  }
  const corrected = structuredClone(failed.evidence);
  const replacement = spec.replacement;
  if (replacement.field === "choices") {
    const choices = Array.isArray(corrected.choices) ? corrected.choices : [];
    if (choices.reduce((count, choice) =>
      count + exactOccurrenceCount(exactString(choice, `${failed.key}.manualRevision.choice`), replacement.from), 0)
      !== replacement.count) {
      throw new Error(`${failed.key}: manual revision replacement occurrence is stale`);
    }
    corrected.choices = choices.map((choice) => choice.split(replacement.from).join(replacement.to));
  } else {
    const current = replacement.field === "question"
      ? exactString(corrected.question, `${failed.key}.manualRevision.question`)
      : corrected.figure_description === null
        ? ""
        : exactString(corrected.figure_description, `${failed.key}.manualRevision.figure_description`);
    if (exactOccurrenceCount(current, replacement.from) !== replacement.count) {
      throw new Error(`${failed.key}: manual revision replacement occurrence is stale`);
    }
    corrected[replacement.field] = current.split(replacement.from).join(replacement.to);
  }
  const question = parseProblem(corrected, `${failed.key} allowlisted manual revision`);
  if (question.key !== failed.key || question.page !== spec.sourcePage) {
    throw new Error(`${failed.key}: manual revision changed the immutable identity`);
  }
  assertProblemCropTokens(question, spec);
  return question;
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
    if (replacement.field === "choices") {
      const choices = Array.isArray(corrected.choices) ? corrected.choices : [];
      if (choices.reduce((count, choice) =>
        count + exactOccurrenceCount(exactString(choice, `${failed.key}.manual.choice`), replacement.from), 0)
        !== replacement.count) {
        throw new Error(`${failed.key}: manual replacement occurrence is stale: ${replacement.from}`);
      }
      corrected.choices = choices.map((choice) => choice.split(replacement.from).join(replacement.to));
      continue;
    }
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

function assertProblemCropTokens(
  question: ProblemQuestion,
  spec: Pick<ProblemCropAdjudicationSpec, "requiredTokens">,
): void {
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

function verifyProblemManualRevision(
  value: unknown,
  parentManual: Record<string, unknown>,
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
    throw new Error(`${key}: manual revision requires a current non-exact manual parent`);
  }
  const revision = object(value, `${key}.revision.recovery.manualAdjudication.revision`);
  const spec = problemManualRevisionSpec(
    entry,
    key,
    failedQuestion.page,
    problemEvidence.sha256,
    exactString(parentManual.allowlistId, `${key}.manualAdjudication.allowlistId`),
  );
  const parentProblemEnvelope = object(
    parentManual.problemArtifact,
    `${key}.manualAdjudication.problemArtifact`,
  );
  const parentClassificationEnvelope = object(
    parentManual.classificationArtifact,
    `${key}.manualAdjudication.classificationArtifact`,
  );
  const parentProblemArtifact = evidencePointer({
    path: parentProblemEnvelope.path,
    sha256: parentProblemEnvelope.sha256,
  }, `${key}.manualRevision.parentProblemArtifact`);
  const parentClassificationArtifact = evidencePointer({
    path: parentClassificationEnvelope.path,
    sha256: parentClassificationEnvelope.sha256,
  }, `${key}.manualRevision.parentClassificationArtifact`);
  const parentProblemArtifactItemHash = canonicalEvidenceHash(failedQuestion.evidence);
  const parentClassificationArtifactItemHash = canonicalEvidenceHash(failedClassification);
  const parentManualEvidenceHash = canonicalEvidenceHash(parentManual);
  const correctionSpecHash = problemManualRevisionCorrectionSpecHash(spec);
  if (spec.failedQuestionHash !== parentProblemArtifactItemHash
    || spec.failedClassificationHash !== parentClassificationArtifactItemHash
    || spec.failedClassificationEvidenceHash !== sha256(failedClassification.transcription_evidence)) {
    throw new Error(`${key}: manual revision parent hashes are stale`);
  }
  const cropEvidenceArtifact = evidencePointer(
    parentManual.cropEvidenceArtifact,
    `${key}.manualRevision.cropEvidenceArtifact`,
  );
  const cropEvidencePdf = evidencePointer(
    parentManual.cropEvidencePdf,
    `${key}.manualRevision.cropEvidencePdf`,
  );
  if (!Array.isArray(parentManual.cropViews)) {
    throw new Error(`${key}: manual revision parent crop views are missing`);
  }
  const cropViews = parentManual.cropViews;
  const printedNumber = exactString(parentManual.printedNumber, `${key}.manualAdjudication.printedNumber`);
  const commonBasis = {
    allowlistId: spec.allowlistId,
    parentAllowlistId: spec.parentAllowlistId,
    entryId: entry.id,
    key,
    printedNumber,
    sourcePage: spec.sourcePage,
    sourceHash: problemEvidence.sha256,
    parentManual,
    parentManualEvidenceHash,
    parentProblemArtifact,
    parentProblemArtifactItemHash,
    parentClassificationArtifact,
    parentClassificationArtifactItemHash,
    failedQuestionHash: spec.failedQuestionHash,
    failedClassificationHash: spec.failedClassificationHash,
    failedClassificationEvidenceHash: spec.failedClassificationEvidenceHash,
    correctionSpecHash,
    cropEvidenceArtifact,
    cropEvidencePdf,
    cropViews,
  };
  const basisDigest = canonicalEvidenceHash(commonBasis);
  const stem = `v${PROBLEM_MANUAL_REVISION_VERSION}-${String(spec.sourcePage).padStart(4, "0")}-` +
    `${printedNumber.padStart(4, "0")}-${basisDigest}`;
  const problemEnvelope = object(revision.problemArtifact, `${key}.manualRevision.problemArtifact`);
  if (Object.keys(problemEnvelope).sort().join(",") !== "correctionDigest,correctionVersion,path,sha256"
    || problemEnvelope.correctionVersion !== PROBLEM_MANUAL_REVISION_VERSION
    || problemEnvelope.correctionDigest !== PROBLEM_MANUAL_REVISION_CORRECTION_DIGEST) {
    throw new Error(`${key}: problem manual revision envelope is stale`);
  }
  const problemArtifact = evidencePointer({
    path: problemEnvelope.path,
    sha256: problemEnvelope.sha256,
  }, `${key}.manualRevision.problemArtifact`);
  const expectedProblemPath = `problem-manual-revisions/${stem}.json`;
  if (problemArtifact.path !== expectedProblemPath) {
    throw new Error(`${key}: problem manual revision path is stale`);
  }
  const problemCheckpoint = readBoundEvidenceCached(
    cache,
    stateDir,
    problemArtifact,
    `${key} problem manual revision`,
  );
  const question = parseProblem(problemCheckpoint.item, `${key} problem manual revision.item`);
  const expectedQuestion = applyProblemManualRevision(failedQuestion, spec);
  const problemArtifactItemHash = canonicalEvidenceHash(question.evidence);
  const expectedProblemCheckpoint = {
    version: PROBLEM_MANUAL_REVISION_VERSION,
    entryId: entry.id,
    basisDigest,
    basis: commonBasis,
    correctionVersion: PROBLEM_MANUAL_REVISION_VERSION,
    correctionDigest: PROBLEM_MANUAL_REVISION_CORRECTION_DIGEST,
    item: expectedQuestion.evidence,
  };
  if (!isDeepStrictEqual(question.evidence, expectedQuestion.evidence)
    || !isDeepStrictEqual(problemCheckpoint, expectedProblemCheckpoint)) {
    throw new Error(`${key}: problem manual revision metadata/content is stale`);
  }

  const classificationBasis = {
    ...commonBasis,
    problemArtifact,
    problemArtifactItemHash,
    effectiveQuestionHash: problemArtifactItemHash,
  };
  const classificationBasisDigest = canonicalEvidenceHash(classificationBasis);
  const classificationEnvelope = object(
    revision.classificationArtifact,
    `${key}.manualRevision.classificationArtifact`,
  );
  if (Object.keys(classificationEnvelope).sort().join(",") !==
      "path,revisionPromptDigest,revisionVersion,rulesDigest,sha256,transcriptionGateVersion,transcriptionPromptDigest"
    || classificationEnvelope.rulesDigest !== rulesDigest
    || classificationEnvelope.transcriptionGateVersion !== contract.transcriptionGateVersion
    || classificationEnvelope.transcriptionPromptDigest !== contract.transcriptionPromptDigest
    || classificationEnvelope.revisionVersion !== PROBLEM_MANUAL_REVISION_VERSION
    || classificationEnvelope.revisionPromptDigest !== PROBLEM_MANUAL_REVISION_PROMPT_DIGEST) {
    throw new Error(`${key}: classification manual revision envelope is stale`);
  }
  const classificationArtifact = evidencePointer({
    path: classificationEnvelope.path,
    sha256: classificationEnvelope.sha256,
  }, `${key}.manualRevision.classificationArtifact`);
  const expectedClassificationPath = `classification-manual-revisions/` +
    `v${CLASSIFICATION_MANUAL_REVISION_VERSION}-${String(spec.sourcePage).padStart(4, "0")}-` +
    `${printedNumber.padStart(4, "0")}-${classificationBasisDigest}-${rulesDigest}.json`;
  if (classificationArtifact.path !== expectedClassificationPath) {
    throw new Error(`${key}: classification manual revision path is stale`);
  }
  const classificationCheckpoint = readBoundEvidenceCached(
    cache,
    stateDir,
    classificationArtifact,
    `${key} classification manual revision`,
  );
  if (!Array.isArray(classificationCheckpoint.items) || classificationCheckpoint.items.length !== 1) {
    throw new Error(`${key}: classification manual revision must contain exactly one decision`);
  }
  const classification = parseClassificationEvidence(
    classificationCheckpoint.items[0],
    question,
    entry,
    `${key} classification manual revision.items[0]`,
  );
  const classificationArtifactItemHash = canonicalEvidenceHash(classification);
  const expectedClassificationCheckpoint = {
    version: CLASSIFICATION_MANUAL_REVISION_VERSION,
    entryId: entry.id,
    basisDigest: classificationBasisDigest,
    basis: classificationBasis,
    classifierVersion: contract.classifierVersion,
    rulesDigest,
    transcriptionGateVersion: contract.transcriptionGateVersion,
    transcriptionPromptDigest: contract.transcriptionPromptDigest,
    revisionVersion: PROBLEM_MANUAL_REVISION_VERSION,
    revisionPromptDigest: PROBLEM_MANUAL_REVISION_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    items: [classification],
  };
  if (!isDeepStrictEqual(classificationCheckpoint, expectedClassificationCheckpoint)
    || classification.transcription_status !== "exact"
    || !matchesProblemManualExpectedDecision(spec, classification)) {
    throw new Error(`${key}: classification manual revision is stale or non-exact`);
  }
  const evidence = {
    allowlistId: spec.allowlistId,
    key,
    printedNumber,
    sourcePage: spec.sourcePage,
    sourceHash: problemEvidence.sha256,
    parentManualEvidenceHash,
    parentProblemArtifact,
    parentProblemArtifactItemHash,
    parentClassificationArtifact,
    parentClassificationArtifactItemHash,
    failedQuestionHash: spec.failedQuestionHash,
    failedClassificationHash: spec.failedClassificationHash,
    failedClassificationEvidenceHash: spec.failedClassificationEvidenceHash,
    correctionSpecHash,
    problemArtifact: {
      ...problemArtifact,
      correctionVersion: PROBLEM_MANUAL_REVISION_VERSION,
      correctionDigest: PROBLEM_MANUAL_REVISION_CORRECTION_DIGEST,
    },
    problemArtifactItemHash,
    classificationArtifact: {
      ...classificationArtifact,
      rulesDigest,
      transcriptionGateVersion: contract.transcriptionGateVersion,
      transcriptionPromptDigest: contract.transcriptionPromptDigest,
      revisionVersion: PROBLEM_MANUAL_REVISION_VERSION,
      revisionPromptDigest: PROBLEM_MANUAL_REVISION_PROMPT_DIGEST,
    },
    classificationArtifactItemHash,
    baseQuestionHash: spec.failedQuestionHash,
    effectiveQuestionHash: problemArtifactItemHash,
    baseClassificationHash: spec.failedClassificationHash,
    effectiveClassificationHash: classificationArtifactItemHash,
  };
  if (!isDeepStrictEqual(revision, evidence)) {
    throw new Error(`${key}: manual revision evidence envelope does not match its exact chain`);
  }
  return { question, classification, evidence };
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
  const manualEnvelope = object(value, `${key}.revision.recovery.manualAdjudication`);
  const { revision: manualRevision, ...manual } = manualEnvelope;
  const parentCrop = parentRecovery.adjudication === undefined
    ? null
    : object(parentRecovery.adjudication, `${key}.manual parent crop adjudication`);
  const parentRecoveryEvidenceHash = canonicalEvidenceHash(parentRecovery);
  const parentCropAdjudicationHash = parentCrop === null ? undefined : canonicalEvidenceHash(parentCrop);
  const manualDpi = spec.dpi ?? PROBLEM_CROP_DPI;
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
    || (spec.parentRecoveryEvidenceHash !== undefined
      && parentRecoveryEvidenceHash !== spec.parentRecoveryEvidenceHash)
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
      dpi: manualDpi,
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
      dpi: manualDpi,
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
  const parentClassificationTerminal = classification.transcription_status === "exact"
    && matchesProblemManualExpectedDecision(spec, classification);
  if (!isDeepStrictEqual(classificationCheckpoint, expectedClassificationCheckpoint)
    || (manualRevision === undefined ? !parentClassificationTerminal : parentClassificationTerminal)
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
  if (manualRevision !== undefined) {
    const revised = verifyProblemManualRevision(
      manualRevision,
      evidence,
      question,
      classification,
      stateDir,
      entry,
      problemEvidence,
      rulesDigest,
      cache,
      contract,
    );
    return {
      question: revised.question,
      classification: revised.classification,
      evidence: { ...evidence, revision: revised.evidence },
    };
  }
  return { question, classification, evidence };
}

export function verifyProblemManualAdjudicationForTest(input: {
  stateDir: string;
  entry: unknown;
  problemEvidence: unknown;
  parentRecovery: Record<string, unknown>;
  failedQuestion: unknown;
  failedClassification: unknown;
  manualAdjudication: unknown;
}): { question: unknown; classification: unknown; evidence: unknown } {
  const entry = input.entry as ManifestEntry;
  const problemEvidence = input.problemEvidence as DownloadEvidence;
  const question = parseProblem(input.failedQuestion, "manual adjudication test question");
  const classification = parseClassificationEvidence(
    input.failedClassification,
    question,
    entry,
    "manual adjudication test classification",
  );
  const manual = input.manualAdjudication as Record<string, any>;
  const classificationArtifact = object(
    manual.classificationArtifact,
    "manual adjudication test classification artifact",
  );
  const verified = verifyProblemManualAdjudication(
    input.manualAdjudication,
    input.parentRecovery,
    question,
    classification,
    input.stateDir,
    entry,
    problemEvidence,
    exactString(classificationArtifact.rulesDigest, "manual adjudication test rulesDigest"),
    new Map(),
    CURRENT_CONTRACT,
  );
  const declaredManual = new Set<string>([
    manual.problemArtifact.path,
    manual.classificationArtifact.path,
    ...(String(manual.cropEvidenceArtifact.path).startsWith("problem-manual-evidence/")
      ? [
          manual.cropEvidenceArtifact.path,
          manual.cropEvidencePdf.path,
          ...manual.cropViews.map((view: Record<string, any>) => view.artifact.path),
        ]
      : []),
    ...(manual.revision
      ? [manual.revision.problemArtifact.path, manual.revision.classificationArtifact.path]
      : []),
  ]);
  verifyProblemManualArtifactInventory(input.stateDir, declaredManual);
  return {
    question: verified.question.evidence,
    classification: verified.classification,
    evidence: verified.evidence,
  };
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

function problemRepairPositiveScopeAdjudicationSpec(
  entry: ManifestEntry,
  key: string,
  sourcePage: number,
  sourceHash: string,
  solutionSourceHash: string,
): ProblemRepairPositiveScopeAdjudicationSpec | null {
  const matches = PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_ALLOWLIST.filter((spec) =>
    spec.entryId === entry.id && spec.key === key && spec.sourcePage === sourcePage);
  if (matches.length > 1) {
    throw new Error(`${entry.id} ${key}: positive repair scope adjudication allowlist is duplicated`);
  }
  if (matches[0]
    && (matches[0].sourceHash !== sourceHash || matches[0].solutionSourceHash !== solutionSourceHash)) {
    throw new Error(`${entry.id} ${key}: official positive repair scope sources do not match the allowlist`);
  }
  return matches[0] ?? null;
}

function isAllowedPositiveRepairScopeDecision(
  classification: ClassificationEvidence,
  spec: ProblemRepairPositiveScopeAdjudicationSpec,
): boolean {
  return classification.decision === "accept"
    && classification.canonical_subject === spec.expectedCanonicalSubject
    && Boolean(classification.curriculum_course)
    && Boolean(classification.domain)
    && classification.achievement_codes.length > 0
    && classification.achievement_codes.every((code) =>
      spec.allowedAchievementCodes.includes(code) && ALLOWED_CODES[spec.expectedCanonicalSubject].has(code))
    && classification.reason_codes.includes(PROBLEM_REPAIR_POSITIVE_SCOPE_AUTHORITY_REASON_CODE)
    && classification.confidence >= 0.9
    && classification.transcription_status === "exact";
}

function problemRevisionScopeAdjudicationSpec(
  entry: ManifestEntry,
  key: string,
  sourcePage: number,
  sourceHash: string,
  solutionSourceHash: string,
): ProblemScopeAdjudicationSpec {
  const matches = PROBLEM_REVISION_SCOPE_ADJUDICATION_ALLOWLIST.filter((spec) =>
    spec.entryId === entry.id && spec.key === key && spec.sourcePage === sourcePage);
  if (matches.length !== 1) {
    throw new Error(`${entry.id} ${key}: revision scope adjudication is not uniquely allowlisted`);
  }
  if (matches[0].sourceHash !== sourceHash || matches[0].solutionSourceHash !== solutionSourceHash) {
    throw new Error(`${entry.id} ${key}: official revision scope sources do not match the allowlist`);
  }
  return matches[0];
}

function problemScopeBoxRevisionSpec(
  entry: ManifestEntry,
  key: string,
  sourcePage: number,
  sourceHash: string,
  solutionSourceHash: string,
): ProblemScopeBoxRevisionSpec | null {
  const matches = PROBLEM_SCOPE_BOX_REVISION_ALLOWLIST.filter((spec) =>
    spec.entryId === entry.id && spec.key === key && spec.sourcePage === sourcePage);
  if (matches.length > 1) throw new Error(`${entry.id} ${key}: scope box revision allowlist is duplicated`);
  const spec = matches[0];
  if (spec && (spec.sourceHash !== sourceHash || spec.solutionSourceHash !== solutionSourceHash)) {
    throw new Error(`${entry.id} ${key}: official scope box sources do not match the allowlist`);
  }
  return spec ?? null;
}

function applyProblemScopeBoxRevision(
  question: ProblemQuestion,
  spec: ProblemScopeBoxRevisionSpec,
): ProblemQuestion {
  if (canonicalEvidenceHash(question.evidence) !== spec.failedQuestionHash
    || !isDeepStrictEqual(question.evidence.box, [...spec.beforeBox])) {
    throw new Error(`${question.key}: scope box revision failed question is stale`);
  }
  const correctedEvidence = structuredClone(question.evidence);
  correctedEvidence.box = [...spec.afterBox];
  const { box: _beforeBox, ...before } = question.evidence;
  const { box: _afterBox, ...after } = correctedEvidence;
  const corrected = parseProblem(correctedEvidence, `${question.key} scope box revision`);
  if (!isDeepStrictEqual(before, after)
    || canonicalEvidenceHash(corrected.evidence) !== spec.correctedQuestionHash) {
    throw new Error(`${question.key}: scope box revision changed more than the exact box`);
  }
  return corrected;
}

function verifyProblemScopeBoxRevision(
  value: unknown,
  parentRecovery: Record<string, unknown>,
  parentScope: Record<string, unknown>,
  failedQuestion: ProblemQuestion,
  failedClassification: ClassificationEvidence,
  row: V3RevisionRow,
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  solutionEvidence: DownloadEvidence,
  rulesDigest: string,
  cache: EvidenceCache,
  contract: VerificationContract,
): { question: ProblemQuestion; classification: ClassificationEvidence; evidence: Record<string, unknown> } {
  const key = failedQuestion.key;
  const spec = problemScopeBoxRevisionSpec(
    entry,
    key,
    failedQuestion.page,
    problemEvidence.sha256,
    solutionEvidence.sha256,
  );
  if (!spec || contract.auditVersion !== 5 || parentScope.boxRevision !== undefined
    || parentRecovery.adjudication !== undefined || parentRecovery.manualAdjudication !== undefined
    || canonicalEvidenceHash(parentRecovery) !== spec.parentRecoveryEvidenceHash
    || parentRecovery.key !== key || parentRecovery.printedNumber !== failedQuestion.printedNumber
    || parentRecovery.sourcePage !== spec.sourcePage || parentRecovery.sourceHash !== spec.sourceHash
    || parentRecovery.contextFrom !== spec.problemContextFrom || parentRecovery.contextTo !== spec.problemContextTo
    || canonicalEvidenceHash(failedQuestion.evidence) !== spec.failedQuestionHash
    || canonicalEvidenceHash(failedClassification) !== spec.failedClassificationHash
    || sha256(failedClassification.transcription_evidence) !== spec.failedScopeEvidenceHash
    || failedClassification.transcription_status !== "mismatch"
    || failedClassification.decision !== "reject" || failedClassification.canonical_subject !== null
    || failedClassification.curriculum_course !== null || failedClassification.domain !== null
    || failedClassification.achievement_codes.length !== 0 || failedClassification.confidence < 0.9) {
    throw new Error(`${key}: scope box revision parent/allowlist is stale`);
  }
  const recoveryProblem = evidencePointer(parentRecovery.problemArtifact, `${key}.scopeBox.parentRecoveryProblem`);
  const recoveryClassificationEnvelope = object(
    parentRecovery.classificationArtifact,
    `${key}.scopeBox.parentRecoveryClassification`,
  );
  const recoveryClassification = evidencePointer({
    path: recoveryClassificationEnvelope.path,
    sha256: recoveryClassificationEnvelope.sha256,
  }, `${key}.scopeBox.parentRecoveryClassification`);
  if (recoveryProblem.path !== spec.parentRecoveryProblemArtifactPath
    || recoveryProblem.sha256 !== spec.parentRecoveryProblemArtifactHash
    || recoveryClassification.path !== spec.parentRecoveryClassificationArtifactPath
    || recoveryClassification.sha256 !== spec.parentRecoveryClassificationArtifactHash
    || parentRecovery.problemArtifactItemHash !== spec.failedQuestionHash
    || parentRecovery.effectiveQuestionHash !== spec.failedQuestionHash
    || parentRecovery.classificationArtifactItemHash !== spec.parentRecoveryClassificationHash
    || parentRecovery.effectiveClassificationHash !== spec.parentRecoveryClassificationHash) {
    throw new Error(`${key}: scope box revision recovery authority is stale`);
  }
  readBoundEvidenceCached(cache, stateDir, recoveryProblem, `${key} scope box recovery problem`);
  const recoveryClassificationCheckpoint = readBoundEvidenceCached(
    cache,
    stateDir,
    recoveryClassification,
    `${key} scope box recovery classification`,
  );
  if (!Array.isArray(recoveryClassificationCheckpoint.items)
    || recoveryClassificationCheckpoint.items.length !== 1) {
    throw new Error(`${key}: scope box recovery classification coverage is stale`);
  }
  const preScopeClassification = parseClassificationEvidence(
    recoveryClassificationCheckpoint.items[0],
    failedQuestion,
    entry,
    `${key}.scopeBox.recoveryClassification.items[0]`,
  );
  if (canonicalEvidenceHash(preScopeClassification) !== spec.parentRecoveryClassificationHash) {
    throw new Error(`${key}: scope box recovery classification item is stale`);
  }

  const parentScopeAdjudicationHash = canonicalEvidenceHash(parentScope);
  const trigger = object(parentScope.trigger, `${key}.scopeBox.parentScope.trigger`);
  const triggerCheckpoint = problemTerminalFidelityCheckpoint(
    trigger.terminalCheckpoint,
    `${key}.scopeBox.parentScope.trigger.terminalCheckpoint`,
  );
  const baseSolutionCheckpoint = evidencePointer(
    parentScope.baseSolutionCheckpoint,
    `${key}.scopeBox.parentScope.baseSolutionCheckpoint`,
  );
  const failedScopeEnvelope = object(
    parentScope.classificationArtifact,
    `${key}.scopeBox.parentScope.classificationArtifact`,
  );
  const failedScopeArtifact = evidencePointer({
    path: failedScopeEnvelope.path,
    sha256: failedScopeEnvelope.sha256,
  }, `${key}.scopeBox.parentScope.classificationArtifact`);
  if (parentScope.allowlistId !== spec.parentScopeAllowlistId || parentScope.key !== key
    || parentScope.printedNumber !== failedQuestion.printedNumber || parentScope.sourcePage !== spec.sourcePage
    || parentScope.sourceHash !== spec.sourceHash || parentScope.solutionSourceHash !== spec.solutionSourceHash
    || parentScope.problemContextFrom !== spec.problemContextFrom
    || parentScope.problemContextTo !== spec.problemContextTo
    || parentScope.solutionContextFrom !== spec.solutionContextFrom
    || parentScope.solutionContextTo !== spec.solutionContextTo
    || parentScope.parentRecoveryEvidenceHash !== spec.parentRecoveryEvidenceHash
    || failedScopeArtifact.path !== spec.failedScopeArtifactPath
    || failedScopeArtifact.sha256 !== spec.failedScopeArtifactHash
    || parentScope.classificationArtifactItemHash !== spec.failedScopeItemHash
    || parentScope.baseQuestionHash !== spec.failedQuestionHash
    || parentScope.effectiveQuestionHash !== spec.failedQuestionHash
    || parentScope.baseClassificationHash !== spec.parentRecoveryClassificationHash
    || parentScope.effectiveClassificationHash !== spec.failedClassificationHash
    || triggerCheckpoint.path !== spec.triggerTerminalPath
    || triggerCheckpoint.sha256 !== spec.triggerTerminalArtifactHash
    || triggerCheckpoint.inputHash !== spec.triggerInputHash
    || trigger.preAdjudicationEffectiveCorpusHash !== spec.triggerEffectiveCorpusHash
    || trigger.terminalItemHash !== spec.triggerItemHash
    || trigger.evidenceHash !== spec.triggerEvidenceHash
    || trigger.scopeEvidenceHash !== spec.triggerScopeEvidenceHash
    || baseSolutionCheckpoint.path !== spec.baseSolutionCheckpointPath
    || baseSolutionCheckpoint.sha256 !== spec.baseSolutionCheckpointHash
    || parentScope.baseSolutionItemHash !== spec.baseSolutionItemHash) {
    throw new Error(`${key}: scope box revision parent scope authority is stale`);
  }
  const failedScopeCheckpoint = readBoundEvidenceCached(
    cache,
    stateDir,
    failedScopeArtifact,
    `${key} failed scope child`,
  );
  if (!Array.isArray(failedScopeCheckpoint.items) || failedScopeCheckpoint.items.length !== 1
    || failedScopeCheckpoint.version !== PROBLEM_SCOPE_ADJUDICATION_VERSION
    || failedScopeCheckpoint.entryId !== entry.id
    || failedScopeCheckpoint.basisDigest !== spec.failedScopeBasisDigest
    || canonicalEvidenceHash(failedScopeCheckpoint.basis) !== spec.failedScopeBasisDigest) {
    throw new Error(`${key}: scope box revision failed scope checkpoint is stale`);
  }
  const failedScopeItem = parseClassificationEvidence(
    failedScopeCheckpoint.items[0],
    failedQuestion,
    entry,
    `${key}.scopeBox.failedScope.items[0]`,
  );
  if (!isDeepStrictEqual(failedScopeItem, failedClassification)
    || canonicalEvidenceHash(failedScopeItem) !== spec.failedScopeItemHash
    || sha256(failedScopeItem.transcription_evidence) !== spec.failedScopeEvidenceHash) {
    throw new Error(`${key}: scope box revision failed scope item is stale`);
  }
  const terminalItem = parseProblemTerminalFidelityItem(
    trigger.terminalItem,
    `${key}.scopeBox.parentScope.trigger.terminalItem`,
    contract,
  );
  if (terminalItem.key !== key || canonicalEvidenceHash(terminalItem) !== spec.triggerItemHash
    || sha256(terminalItem.evidence) !== spec.triggerEvidenceHash
    || terminalItem.scopeEvidence === undefined
    || sha256(terminalItem.scopeEvidence) !== spec.triggerScopeEvidenceHash
    || terminalItem.status !== "exact" || terminalItem.scopeDecision !== "reject"
    || terminalItem.scopeConfidence < 0.9
    || canonicalEvidenceHash(problemTerminalInput({
      question: failedQuestion,
      classification: preScopeClassification,
      problemCheckpoint: row.first.row.base.problemCheckpoint,
      classificationCheckpoint: row.first.row.base.classificationCheckpoint,
      contextFrom: row.first.row.contextFrom,
      contextTo: row.first.row.contextTo,
    })) !== spec.triggerQuestionInputHash) {
    throw new Error(`${key}: scope box revision terminal item/input is stale`);
  }
  readBoundEvidenceCached(cache, stateDir, triggerCheckpoint, `${key} scope box trigger terminal`);
  readBoundEvidenceCached(cache, stateDir, baseSolutionCheckpoint, `${key} scope box base solution`);

  const boxRevision = object(value, `${key}.revision.recovery.scopeAdjudication.boxRevision`);
  const sourcePages = [...new Set(spec.views.map((view) => view.sourcePage))].sort((left, right) => left - right);
  const cropBasis = {
    allowlistId: spec.allowlistId,
    entryId: entry.id,
    key,
    sourcePage: spec.sourcePage,
    sourcePages,
    sourceHash: problemEvidence.sha256,
    dpi: spec.dpi,
    views: spec.views,
    requiredTokens: spec.requiredTokens,
  };
  const cropBasisDigest = canonicalEvidenceHash(cropBasis);
  const cropStem = `v${PROBLEM_SCOPE_BOX_REVISION_VERSION}-${String(spec.sourcePage).padStart(4, "0")}-` +
    `${failedQuestion.printedNumber.padStart(4, "0")}-${cropBasisDigest}`;
  const cropEvidenceArtifact = evidencePointer(
    boxRevision.cropEvidenceArtifact,
    `${key}.scopeBox.cropEvidenceArtifact`,
  );
  const cropEvidencePdf = evidencePointer(boxRevision.cropEvidencePdf, `${key}.scopeBox.cropEvidencePdf`);
  if (cropEvidenceArtifact.path !== `problem-scope-box-evidence/${cropStem}.json`
    || cropEvidencePdf.path !== `problem-scope-box-evidence/${cropStem}.pdf`) {
    throw new Error(`${key}: scope box crop canonical paths are stale`);
  }
  const cropCheckpoint = readBoundEvidenceCached(
    cache,
    stateDir,
    cropEvidenceArtifact,
    `${key} scope box crop checkpoint`,
  );
  if (!Array.isArray(cropCheckpoint.views) || cropCheckpoint.views.length !== spec.views.length) {
    throw new Error(`${key}: scope box crop view coverage is not exact`);
  }
  const cropViews = cropCheckpoint.views.map((raw, index) => {
    const view = object(raw, `${key}.scopeBox.cropViews[${index}]`);
    const expected = spec.views[index];
    const artifact = evidencePointer(view.artifact, `${key}.scopeBox.cropViews[${index}].artifact`);
    const pixelWidth = integer(view.pixelWidth, `${key}.scopeBox.cropViews[${index}].pixelWidth`, 1);
    const pixelHeight = integer(view.pixelHeight, `${key}.scopeBox.cropViews[${index}].pixelHeight`, 1);
    const pixelSha256 = digest(view.pixelSha256, `${key}.scopeBox.cropViews[${index}].pixelSha256`);
    const expectedPath = `problem-scope-box-evidence/${cropStem}-view-${String(index).padStart(2, "0")}.png`;
    if (view.sourcePage !== expected.sourcePage || view.label !== expected.label
      || !isDeepStrictEqual(view.rect, [...expected.rect])
      || artifact.path !== expectedPath || artifact.sha256 !== pixelSha256) {
      throw new Error(`${key}: scope box crop view ${index} is stale`);
    }
    const absolute = confinedEvidencePath(stateDir, artifact, `${key} scope box crop view ${index}`);
    const dimensions = cropPngDimensions(absolute, `${key} scope box crop view ${index}`);
    if (hashFile(absolute) !== pixelSha256
      || dimensions.width !== pixelWidth || dimensions.height !== pixelHeight) {
      throw new Error(`${key}: scope box crop view ${index} bytes/dimensions are stale`);
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
  const cropPdfPath = confinedEvidencePath(stateDir, cropEvidencePdf, `${key} scope box crop PDF`);
  if (hashFile(cropPdfPath) !== cropEvidencePdf.sha256) {
    throw new Error(`${key}: scope box crop PDF hash is stale`);
  }
  const expectedCropCheckpoint = {
    version: PROBLEM_SCOPE_BOX_REVISION_VERSION,
    entryId: entry.id,
    basisDigest: cropBasisDigest,
    basis: cropBasis,
    renderer: "pdftocairo-png+pdf-lib",
    dpi: spec.dpi,
    evidencePdf: cropEvidencePdf,
    views: cropViews,
  };
  if (!isDeepStrictEqual(cropCheckpoint, expectedCropCheckpoint)
    || !isDeepStrictEqual(boxRevision.cropViews, cropViews)) {
    throw new Error(`${key}: scope box crop checkpoint/envelope is stale`);
  }

  const correctionSpecHash = canonicalEvidenceHash(spec);
  const commonBasis = {
    allowlistId: spec.allowlistId,
    entryId: entry.id,
    key,
    printedNumber: failedQuestion.printedNumber,
    sourcePage: spec.sourcePage,
    sourceHash: problemEvidence.sha256,
    solutionSourceHash: solutionEvidence.sha256,
    parentRecovery,
    parentRecoveryEvidenceHash: spec.parentRecoveryEvidenceHash,
    parentScopeAdjudication: parentScope,
    parentScopeAdjudicationHash,
    failedScopeArtifact,
    failedScopeBasisDigest: spec.failedScopeBasisDigest,
    failedScopeItem,
    failedScopeItemHash: spec.failedScopeItemHash,
    failedScopeEvidenceHash: spec.failedScopeEvidenceHash,
    trigger: parentScope.trigger,
    baseSolutionCheckpoint,
    baseSolutionItemHash: spec.baseSolutionItemHash,
    correctionSpecHash,
    cropEvidenceArtifact,
    cropEvidencePdf,
    cropViews,
    baseQuestionHash: spec.failedQuestionHash,
    baseClassificationHash: spec.failedClassificationHash,
  };
  const basisDigest = canonicalEvidenceHash(commonBasis);
  const stem = `v${PROBLEM_SCOPE_BOX_REVISION_VERSION}-${String(spec.sourcePage).padStart(4, "0")}-` +
    `${failedQuestion.printedNumber.padStart(4, "0")}-${basisDigest}`;
  const problemEnvelope = object(boxRevision.problemArtifact, `${key}.scopeBox.problemArtifact`);
  const problemArtifact = evidencePointer({ path: problemEnvelope.path, sha256: problemEnvelope.sha256 },
    `${key}.scopeBox.problemArtifact`);
  if (problemEnvelope.correctionVersion !== PROBLEM_SCOPE_BOX_REVISION_VERSION
    || problemEnvelope.correctionDigest !== PROBLEM_SCOPE_BOX_REVISION_CORRECTION_DIGEST
    || problemArtifact.path !== `problem-scope-box-revisions/${stem}.json`) {
    throw new Error(`${key}: scope box problem artifact envelope/path is stale`);
  }
  const problemCheckpoint = readBoundEvidenceCached(
    cache,
    stateDir,
    problemArtifact,
    `${key} scope box problem revision`,
  );
  const corrected = applyProblemScopeBoxRevision(failedQuestion, spec);
  const expectedProblemCheckpoint = {
    version: PROBLEM_SCOPE_BOX_REVISION_VERSION,
    entryId: entry.id,
    basisDigest,
    basis: commonBasis,
    correctionVersion: PROBLEM_SCOPE_BOX_REVISION_VERSION,
    correctionDigest: PROBLEM_SCOPE_BOX_REVISION_CORRECTION_DIGEST,
    item: corrected.evidence,
  };
  if (!isDeepStrictEqual(problemCheckpoint, expectedProblemCheckpoint)
    || boxRevision.problemArtifactItemHash !== spec.correctedQuestionHash) {
    throw new Error(`${key}: scope box problem revision checkpoint is stale`);
  }

  const classificationBasis = {
    ...commonBasis,
    problemArtifact,
    problemArtifactItemHash: spec.correctedQuestionHash,
    effectiveQuestionHash: spec.correctedQuestionHash,
  };
  const classificationBasisDigest = canonicalEvidenceHash(classificationBasis);
  const classificationEnvelope = object(
    boxRevision.classificationArtifact,
    `${key}.scopeBox.classificationArtifact`,
  );
  const classificationArtifact = evidencePointer({
    path: classificationEnvelope.path,
    sha256: classificationEnvelope.sha256,
  }, `${key}.scopeBox.classificationArtifact`);
  const expectedClassificationPath = `classification-scope-box-revisions/` +
    `v${CLASSIFICATION_SCOPE_BOX_REVISION_VERSION}-${String(spec.sourcePage).padStart(4, "0")}-` +
    `${failedQuestion.printedNumber.padStart(4, "0")}-${classificationBasisDigest}-${rulesDigest}.json`;
  if (classificationArtifact.path !== expectedClassificationPath
    || classificationEnvelope.rulesDigest !== rulesDigest
    || classificationEnvelope.transcriptionGateVersion !== contract.transcriptionGateVersion
    || classificationEnvelope.transcriptionPromptDigest !== contract.transcriptionPromptDigest
    || classificationEnvelope.revisionVersion !== PROBLEM_SCOPE_BOX_REVISION_VERSION
    || classificationEnvelope.revisionPromptDigest !== PROBLEM_SCOPE_BOX_REVISION_PROMPT_DIGEST) {
    throw new Error(`${key}: scope box classification artifact envelope/path is stale`);
  }
  const classificationCheckpoint = readBoundEvidenceCached(
    cache,
    stateDir,
    classificationArtifact,
    `${key} scope box classification revision`,
  );
  if (!Array.isArray(classificationCheckpoint.items) || classificationCheckpoint.items.length !== 1) {
    throw new Error(`${key}: scope box classification revision must contain one decision`);
  }
  const classification = parseClassificationEvidence(
    classificationCheckpoint.items[0],
    corrected,
    entry,
    `${key}.scopeBox.classification.items[0]`,
  );
  const expectedClassificationCheckpoint = {
    version: CLASSIFICATION_SCOPE_BOX_REVISION_VERSION,
    entryId: entry.id,
    basisDigest: classificationBasisDigest,
    basis: classificationBasis,
    classifierVersion: contract.classifierVersion,
    rulesDigest,
    transcriptionGateVersion: contract.transcriptionGateVersion,
    transcriptionPromptDigest: contract.transcriptionPromptDigest,
    revisionVersion: PROBLEM_SCOPE_BOX_REVISION_VERSION,
    revisionPromptDigest: PROBLEM_SCOPE_BOX_REVISION_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    items: [classification],
  };
  const classificationArtifactItemHash = canonicalEvidenceHash(classification);
  const evidence = {
    allowlistId: spec.allowlistId,
    key,
    printedNumber: failedQuestion.printedNumber,
    sourcePage: spec.sourcePage,
    sourceHash: problemEvidence.sha256,
    solutionSourceHash: solutionEvidence.sha256,
    parentRecoveryEvidenceHash: spec.parentRecoveryEvidenceHash,
    parentScopeAdjudicationHash,
    failedScopeArtifact,
    failedScopeBasisDigest: spec.failedScopeBasisDigest,
    failedScopeItemHash: spec.failedScopeItemHash,
    failedScopeEvidenceHash: spec.failedScopeEvidenceHash,
    correctionSpecHash,
    cropEvidenceArtifact,
    cropEvidencePdf,
    cropViews,
    problemArtifact: {
      ...problemArtifact,
      correctionVersion: PROBLEM_SCOPE_BOX_REVISION_VERSION,
      correctionDigest: PROBLEM_SCOPE_BOX_REVISION_CORRECTION_DIGEST,
    },
    problemArtifactItemHash: spec.correctedQuestionHash,
    classificationArtifact: {
      ...classificationArtifact,
      rulesDigest,
      transcriptionGateVersion: contract.transcriptionGateVersion,
      transcriptionPromptDigest: contract.transcriptionPromptDigest,
      revisionVersion: PROBLEM_SCOPE_BOX_REVISION_VERSION,
      revisionPromptDigest: PROBLEM_SCOPE_BOX_REVISION_PROMPT_DIGEST,
    },
    classificationArtifactItemHash,
    baseQuestionHash: spec.failedQuestionHash,
    effectiveQuestionHash: spec.correctedQuestionHash,
    baseClassificationHash: spec.failedClassificationHash,
    effectiveClassificationHash: classificationArtifactItemHash,
  };
  if (!isDeepStrictEqual(classificationCheckpoint, expectedClassificationCheckpoint)
    || !isDeepStrictEqual(boxRevision, evidence)
    || classification.transcription_status !== "exact" || classification.decision !== "reject"
    || classification.canonical_subject !== null || classification.curriculum_course !== null
    || classification.domain !== null || classification.achievement_codes.length !== 0
    || classification.confidence < 0.9) {
    throw new Error(`${key}: scope box classification/evidence is not exact reject/null`);
  }
  return { question: corrected, classification, evidence };
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
  question: ProblemQuestion;
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
  const { boxRevision: rawBoxRevision, ...parentAdjudication } = adjudication;
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
  const boxRevisionSpec = problemScopeBoxRevisionSpec(
    entry,
    key,
    recoveredQuestion.page,
    problemEvidence.sha256,
    solutionEvidence.sha256,
  );
  const allowBoxRevisionMismatch = rawBoxRevision !== undefined && boxRevisionSpec !== null
    && classificationArtifact.path === boxRevisionSpec.failedScopeArtifactPath
    && classificationArtifact.sha256 === boxRevisionSpec.failedScopeArtifactHash
    && basisDigest === boxRevisionSpec.failedScopeBasisDigest
    && classificationArtifactItemHash === boxRevisionSpec.failedScopeItemHash
    && sha256(classification.transcription_evidence) === boxRevisionSpec.failedScopeEvidenceHash
    && canonicalEvidenceHash(recoveredQuestion.evidence) === boxRevisionSpec.failedQuestionHash
    && classification.transcription_status === "mismatch";
  if (!isDeepStrictEqual(checkpoint, expectedCheckpoint)
    || classification.decision !== "reject" || classification.canonical_subject !== null
    || classification.curriculum_course !== null || classification.domain !== null
    || classification.achievement_codes.length !== 0 || classification.confidence < 0.9
    || classification.transcription_status !== "exact" && !allowBoxRevisionMismatch
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
  if (!isDeepStrictEqual(parentAdjudication, evidence)) {
    throw new Error(`${key}: scope adjudication evidence envelope does not match its exact chain`);
  }
  const final = classification.transcription_status === "exact"
    ? (() => {
        if (rawBoxRevision !== undefined) {
          throw new Error(`${key}: exact scope adjudication must not declare a box revision`);
        }
        return { question: recoveredQuestion, classification, evidence };
      })()
    : (() => {
        const revised = verifyProblemScopeBoxRevision(
          rawBoxRevision,
          parentRecovery,
          evidence,
          recoveredQuestion,
          classification,
          row,
          stateDir,
          entry,
          problemEvidence,
          solutionEvidence,
          rulesDigest,
          cache,
          contract,
        );
        const nestedEvidence = { ...evidence, boxRevision: revised.evidence };
        if (!isDeepStrictEqual(adjudication, nestedEvidence)) {
          throw new Error(`${key}: scope box revision envelope does not match its exact chain`);
        }
        return { question: revised.question, classification: revised.classification, evidence: nestedEvidence };
      })();
  return {
    ...final,
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
  revisionParent?: V3RevisionVerification,
): {
  classified: ClassifiedEvidence;
  evidence: Record<string, unknown>;
  generation: { key: string; current: ClassifiedEvidence; checkpoint: ProblemTerminalFidelityCheckpoint };
} {
  const current = revisionParent?.classified ?? first.classified;
  const key = current.question.key;
  const revisionMode = revisionParent !== undefined;
  const positiveSpec = revisionMode ? null : problemRepairPositiveScopeAdjudicationSpec(
    entry,
    key,
    current.question.page,
    problemEvidence.sha256,
    solutionEvidence.sha256,
  );
  const positiveMode = positiveSpec !== null;
  const rawRevision = first.row.raw.revision === undefined
    ? null
    : object(first.row.raw.revision, `${key}.revision`);
  if (contract.auditVersion !== 5
    || contract.problemTerminalFidelityVersion !== PROBLEM_TERMINAL_FIDELITY_VERSION
    || current.classification.transcription_status !== "exact"
    || current.classification.decision !== "accept"
    || (!revisionMode && rawRevision !== null)
    || (revisionMode && (rawRevision === null || rawRevision.recovery !== undefined))) {
    throw new Error(`${key}: repair/revision scope adjudication requires one current exact accept parent`);
  }
  const spec = revisionMode
    ? problemRevisionScopeAdjudicationSpec(
        entry,
        key,
        current.question.page,
        problemEvidence.sha256,
        solutionEvidence.sha256,
      )
    : positiveSpec ?? problemRepairScopeAdjudicationSpec(
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
  const parentRevision = revisionParent?.evidence;
  const parentRepair = parentRevision === undefined
    ? first.evidence
    : { ...first.evidence, revision: parentRevision };
  const parentRepairEvidenceHash = canonicalEvidenceHash(parentRepair);
  const parentRevisionEvidenceHash = parentRevision === undefined
    ? undefined
    : canonicalEvidenceHash(parentRevision);
  if (adjudication.parentRecoveryEvidenceHash !== undefined
    || adjudication.parentRepairEvidenceHash !== parentRepairEvidenceHash
    || adjudication.parentRevisionEvidenceHash !== parentRevisionEvidenceHash
    || (parentRevision ?? parentRepair).effectiveQuestionHash !== canonicalEvidenceHash(current.question.evidence)
    || (parentRevision ?? parentRepair).effectiveClassificationHash !== canonicalEvidenceHash(current.classification)) {
    throw new Error(`${key}: repair scope adjudication parent repair hash is stale`);
  }

  const triggerRow = object(adjudication.trigger, `${key}.repairScopeAdjudication.trigger`);
  const terminalCheckpoint = problemTerminalFidelityCheckpoint(
    triggerRow.terminalCheckpoint,
    `${key}.repairScopeAdjudication.trigger.terminalCheckpoint`,
  );
  if (parentRevision !== undefined) {
    const parentProblemArtifact = evidencePointer(
      parentRevision.problemArtifact,
      `${key}.revisionScopeAdjudication.parentProblemArtifact`,
    );
    const parentClassificationEnvelope = object(
      parentRevision.classificationArtifact,
      `${key}.revisionScopeAdjudication.parentClassificationArtifact`,
    );
    const parentClassificationArtifact = evidencePointer(
      { path: parentClassificationEnvelope.path, sha256: parentClassificationEnvelope.sha256 },
      `${key}.revisionScopeAdjudication.parentClassificationArtifact`,
    );
    if (parentProblemArtifact.sha256 !== spec.parentProblemArtifactHash
      || parentClassificationArtifact.sha256 !== spec.parentClassificationArtifactHash
      || terminalCheckpoint.sha256 !== spec.terminalArtifactHash) {
      throw new Error(`${key}: revision scope pinned parent/terminal hash is stale`);
    }
  }
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
    ...(parentRevisionEvidenceHash ? { parentRevisionEvidenceHash } : {}),
    ...(positiveSpec ? {
      scopeAuthority: {
        decision: "accept",
        canonicalSubject: positiveSpec.expectedCanonicalSubject,
        allowedAchievementCodes: [...positiveSpec.allowedAchievementCodes],
        requiredReasonCode: PROBLEM_REPAIR_POSITIVE_SCOPE_AUTHORITY_REASON_CODE,
      },
    } : {}),
    trigger,
    baseQuestionHash: canonicalEvidenceHash(current.question.evidence),
    baseClassificationHash: canonicalEvidenceHash(current.classification),
  };
  const basisDigest = canonicalEvidenceHash(basis);
  const adjudicationVersion = revisionMode
    ? PROBLEM_REVISION_SCOPE_ADJUDICATION_VERSION
    : positiveMode
      ? PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_VERSION
      : PROBLEM_REPAIR_SCOPE_ADJUDICATION_VERSION;
  const adjudicationPromptDigest = revisionMode
    ? PROBLEM_REVISION_SCOPE_ADJUDICATION_PROMPT_DIGEST
    : positiveMode
      ? PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_PROMPT_DIGEST
      : PROBLEM_REPAIR_SCOPE_ADJUDICATION_PROMPT_DIGEST;
  const adjudicationDirectory = revisionMode
    ? "classification-revision-scope-adjudications"
    : positiveMode
      ? "classification-repair-positive-scope-adjudications"
      : "classification-repair-scope-adjudications";
  const classificationEnvelope = object(
    adjudication.classificationArtifact,
    `${key}.repairScopeAdjudication.classificationArtifact`,
  );
  if (Object.keys(classificationEnvelope).sort().join(",") !==
      "adjudicationPromptDigest,adjudicationPromptVersion,path,rulesDigest,sha256,transcriptionGateVersion,transcriptionPromptDigest"
    || classificationEnvelope.rulesDigest !== rulesDigest
    || classificationEnvelope.transcriptionGateVersion !== contract.transcriptionGateVersion
    || classificationEnvelope.transcriptionPromptDigest !== contract.transcriptionPromptDigest
    || classificationEnvelope.adjudicationPromptVersion !== adjudicationVersion
    || classificationEnvelope.adjudicationPromptDigest !== adjudicationPromptDigest) {
    throw new Error(`${key}: repair scope classification envelope is stale`);
  }
  const classificationArtifact = evidencePointer(
    { path: classificationEnvelope.path, sha256: classificationEnvelope.sha256 },
    `${key}.repairScopeAdjudication.classificationArtifact`,
  );
  const expectedPath = `${adjudicationDirectory}/` +
    `v${adjudicationVersion}-${String(current.question.page).padStart(4, "0")}-` +
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
    version: adjudicationVersion,
    entryId: entry.id,
    basisDigest,
    basis,
    classifierVersion: contract.classifierVersion,
    rulesDigest,
    transcriptionGateVersion: contract.transcriptionGateVersion,
    transcriptionPromptDigest: contract.transcriptionPromptDigest,
    adjudicationPromptVersion: adjudicationVersion,
    adjudicationPromptDigest,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    items: [classification],
  };
  const classificationArtifactItemHash = canonicalEvidenceHash(classification);
  const allowedDecision = positiveSpec
    ? isAllowedPositiveRepairScopeDecision(classification, positiveSpec)
      && classificationArtifactItemHash !== canonicalEvidenceHash(current.classification)
    : classification.decision === "reject" && classification.canonical_subject === null
      && classification.curriculum_course === null && classification.domain === null
      && classification.achievement_codes.length === 0 && classification.confidence >= 0.9
      && classification.transcription_status === "exact";
  if (!isDeepStrictEqual(checkpoint, expectedCheckpoint)
    || !allowedDecision
    || adjudication.classificationArtifactItemHash !== classificationArtifactItemHash) {
    throw new Error(positiveMode
      ? `${key}: positive repair scope output does not satisfy its exact allowlisted authority`
      : `${key}: repair scope output is not exact high-confidence reject/null`);
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
    ...(parentRevisionEvidenceHash ? { parentRevisionEvidenceHash } : {}),
    trigger,
    classificationArtifact: {
      ...classificationArtifact,
      rulesDigest,
      transcriptionGateVersion: contract.transcriptionGateVersion,
      transcriptionPromptDigest: contract.transcriptionPromptDigest,
      adjudicationPromptVersion: adjudicationVersion,
      adjudicationPromptDigest,
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
          question: scope.question,
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

function verifyPersistedTerminalRecoveryHistory(
  selection: PersistedTerminalRecoverySelection,
  row: V3RevisionRow,
  selectedVerification: V3RevisionVerification,
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  solutionEvidence: DownloadEvidence,
  rulesDigest: string,
  cache: EvidenceCache,
  contract: VerificationContract,
): Array<{ key: string; current: ClassifiedEvidence; checkpoint: ProblemTerminalFidelityCheckpoint }> {
  const { spec } = selection;
  const revised = selectedVerification.preRecoveryClassified;
  if (!revised || row.first.row.key !== spec.key
    || row.first.row.sourcePage !== spec.sourcePage
    || row.first.row.contextFrom !== spec.contextFrom || row.first.row.contextTo !== spec.contextTo
    || !isDeepStrictEqual(row.first.row.problemArtifact, {
      path: spec.baseProblemRepairArtifact.path,
      sha256: spec.baseProblemRepairArtifact.sha256,
    })
    || row.first.row.problemArtifactItemHash !== spec.baseProblemRepairArtifact.itemHash
    || !isDeepStrictEqual(row.first.row.classificationArtifact, {
      path: spec.baseClassificationRepairArtifact.path,
      sha256: spec.baseClassificationRepairArtifact.sha256,
    })
    || row.first.row.classificationArtifactItemHash !== spec.baseClassificationRepairArtifact.itemHash
    || !isDeepStrictEqual(row.problemArtifact, {
      path: spec.revisionProblemArtifact.path,
      sha256: spec.revisionProblemArtifact.sha256,
    })
    || row.problemArtifactItemHash !== spec.revisionProblemArtifact.itemHash
    || !isDeepStrictEqual(row.classificationArtifact, {
      path: spec.revisionClassificationArtifact.path,
      sha256: spec.revisionClassificationArtifact.sha256,
    })
    || row.classificationArtifactItemHash !== spec.revisionClassificationArtifact.itemHash
    || canonicalEvidenceHash(revised.question.evidence) !== spec.revisionProblemArtifact.itemHash
    || canonicalEvidenceHash(revised.classification) !== spec.revisionClassificationArtifact.itemHash
    || row.trigger.evidenceHash !== spec.revisionTriggerEvidenceHash
    || canonicalEvidenceHash(selectedVerification.classified.question.evidence)
      !== spec.selected.problemArtifact.itemHash
    || selectedVerification.classified.question.question !== spec.selected.questionText
    || canonicalEvidenceHash(selectedVerification.classified.classification)
      !== spec.selected.classificationArtifact.itemHash
    || selectedVerification.classified.classification.transcription_status !== "exact"
    || selectedVerification.classified.classification.decision !== "accept"
    || selectedVerification.classified.classification.canonical_subject !== "math_B"
    || selectedVerification.classified.classification.confidence < 0.9) {
    throw new Error(`${spec.key}: persisted terminal recovery selected authority is stale`);
  }

  return spec.historical.map((generation) => {
    const terminalCheckpointValue = readBoundEvidenceCached(
      cache,
      stateDir,
      generation.terminalCheckpoint,
      `${spec.key} historical terminal recovery checkpoint`,
    );
    if (!Array.isArray(terminalCheckpointValue.items)) {
      throw new Error(`${spec.key}: historical terminal recovery items are missing`);
    }
    const terminalItems = terminalCheckpointValue.items.map((value, index) =>
      parseProblemTerminalFidelityItem(
        value,
        `${spec.key} historical terminal recovery items[${index}]`,
        contract,
      ));
    const matches = terminalItems.filter((item) => item.key === spec.key);
    if (matches.length !== 1 || matches[0].status === "exact"
      || canonicalEvidenceHash(matches[0]) !== generation.terminalItemHash
      || sha256(matches[0].evidence) !== generation.evidenceHash
      || terminalCheckpointValue.effectiveCorpusHash !== generation.preRecoveryEffectiveCorpusHash
      || terminalCheckpointValue.inputHash !== generation.terminalCheckpoint.inputHash) {
      throw new Error(`${spec.key}: historical terminal recovery diagnostic authority is stale`);
    }
    const terminalItem = matches[0];
    const trigger = {
      kind: "terminal",
      evidenceHash: generation.evidenceHash,
      terminalCheckpoint: generation.terminalCheckpoint,
      terminalItemHash: generation.terminalItemHash,
      terminalItem,
      preRecoveryEffectiveCorpusHash: generation.preRecoveryEffectiveCorpusHash,
    };
    const recovery = {
      key: spec.key,
      printedNumber: row.first.row.printedNumber,
      sourcePage: spec.sourcePage,
      sourceHash: spec.sourceHash,
      contextFrom: spec.contextFrom,
      contextTo: spec.contextTo,
      baseProblemRepairArtifact: row.first.row.problemArtifact,
      baseProblemRepairItemHash: spec.baseProblemRepairArtifact.itemHash,
      baseClassificationRepairArtifact: row.first.row.classificationArtifact,
      baseClassificationRepairItemHash: spec.baseClassificationRepairArtifact.itemHash,
      baseProblemRevisionArtifact: row.problemArtifact,
      baseProblemRevisionItemHash: spec.revisionProblemArtifact.itemHash,
      baseClassificationRevisionArtifact: row.classificationArtifact,
      baseClassificationRevisionItemHash: spec.revisionClassificationArtifact.itemHash,
      problemArtifact: {
        path: generation.problemArtifact.path,
        sha256: generation.problemArtifact.sha256,
      },
      problemArtifactItemHash: generation.problemArtifact.itemHash,
      classificationArtifact: {
        path: generation.classificationArtifact.path,
        sha256: generation.classificationArtifact.sha256,
        rulesDigest,
        transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
        transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
        recoveryPromptVersion: TARGETED_PROBLEM_RECOVERY_VERSION,
        recoveryPromptDigest: TARGETED_PROBLEM_RECOVERY_PROMPT_DIGEST,
      },
      classificationArtifactItemHash: generation.classificationArtifact.itemHash,
      trigger,
      baseQuestionHash: spec.revisionProblemArtifact.itemHash,
      effectiveQuestionHash: generation.problemArtifact.itemHash,
      baseClassificationHash: spec.revisionClassificationArtifact.itemHash,
      effectiveClassificationHash: generation.classificationArtifact.itemHash,
    };
    const verified = verifyProblemRecovery(
      { ...row, raw: { ...row.raw, recovery } },
      revised.question,
      revised.classification,
      stateDir,
      entry,
      problemEvidence,
      solutionEvidence,
      rulesDigest,
      cache,
      contract,
    );
    const problemMatch = new RegExp(
      `^problem-recoveries/v${PROBLEM_TERMINAL_RECOVERY_VERSION}-\\d{4}-\\d{4}-([a-f0-9]{64})\\.json$`,
      "u",
    ).exec(generation.problemArtifact.path);
    const classificationMatch = new RegExp(
      `^classification-recoveries/v${CLASSIFICATION_TERMINAL_RECOVERY_VERSION}-\\d{4}-\\d{4}-` +
        "([a-f0-9]{64})-[a-f0-9]{16}\\.json$",
      "u",
    ).exec(generation.classificationArtifact.path);
    if (!problemMatch || problemMatch[1] !== generation.problemArtifact.basisDigest
      || !classificationMatch || classificationMatch[1] !== generation.classificationArtifact.basisDigest
      || verified.classified.question.question !== generation.questionText
      || canonicalEvidenceHash(verified.classified.question.evidence) !== generation.problemArtifact.itemHash
      || canonicalEvidenceHash(verified.classified.classification) !== generation.classificationArtifact.itemHash
      || verified.classified.classification.transcription_status !== "exact"
      || !verified.terminalGeneration) {
      throw new Error(`${spec.key}: historical terminal recovery exact authority is stale`);
    }
    return verified.terminalGeneration;
  });
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
      if (row.raw.scopeAdjudication !== undefined && recovery !== null) {
        throw new Error(`${key}: revision cannot combine recovery and scope adjudication`);
      }
      const { scopeAdjudication: _scopeAdjudication, ...parentRevision } = row.raw;
      if (!isDeepStrictEqual(parentRevision, expectedEvidence)) {
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
  historicalGenerations: ReadonlyArray<{
    key: string;
    current: ClassifiedEvidence;
    checkpoint: ProblemTerminalFidelityCheckpoint;
  }> = [],
): void {
  const generations = [
    ...[...first.values()].flatMap((value) =>
      value.scopeAdjudicationGeneration ? [value.scopeAdjudicationGeneration] : []),
    ...[...classificationRevisions.values(), ...terminalRevisions.values()]
    .flatMap((value) => [
      ...(value.terminalRecoveryGeneration ? [value.terminalRecoveryGeneration] : []),
      ...(value.scopeAdjudicationGeneration ? [value.scopeAdjudicationGeneration] : []),
    ]),
    ...historicalGenerations,
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
  auditAuthority: PersistedTerminalRecoveryAuditAuthority,
  recoveryCoverageAuthority: ProblemRecoveryCoverageAuthority | null = null,
): Map<string, ClassifiedEvidence> {
  const persistedTerminalRecovery = persistedTerminalRecoverySelection(
    values,
    entry,
    problemEvidence,
    auditAuthority,
  );
  if (persistedTerminalRecovery && contract.auditVersion !== 5) {
    throw new Error("persisted terminal recovery hydration requires answer audit v5");
  }
  verifyProblemRecoveryCoverage(
    values,
    stateDir,
    contract,
    persistedTerminalRecovery ?? recoveryCoverageAuthority,
  );
  const rows = prepareV3RepairRows(values, stateDir, base, solutions);
  const persistedGraphSelection = verifyPersistedV2RepairGraphSelection(
    rows,
    stateDir,
    entry,
    problemEvidence,
    rulesDigest,
    base,
    solutions,
    cache,
    contract,
  );
  const corrected = verifyV3FirstProblemArtifacts(
    rows,
    stateDir,
    entry,
    problemEvidence,
    cache,
    persistedGraphSelection.historicalProblemBatchPaths,
  );
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
  let historicalTerminalRecoveryGenerations: Array<{
    key: string;
    current: ClassifiedEvidence;
    checkpoint: ProblemTerminalFidelityCheckpoint;
  }> = [];
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
    if (persistedTerminalRecovery) {
      const row = prepared.find((candidate) => candidate.first.row.key === persistedTerminalRecovery.spec.key);
      const selected = classificationRevisionResults.get(persistedTerminalRecovery.spec.key);
      if (!row || !selected) {
        throw new Error(`${persistedTerminalRecovery.spec.key}: persisted terminal recovery revision is missing`);
      }
      historicalTerminalRecoveryGenerations = verifyPersistedTerminalRecoveryHistory(
        persistedTerminalRecovery,
        row,
        selected,
        stateDir,
        entry,
        problemEvidence,
        solutionEvidence,
        rulesDigest,
        cache,
        contract,
      );
    }
    for (const [key, value] of classificationRevisionResults) records.set(key, value.classified);
  } else if (persistedTerminalRecovery) {
    throw new Error(`${persistedTerminalRecovery.spec.key}: persisted terminal recovery revision is missing`);
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

  for (const value of first.values()) {
    if (value.row.raw.revision === undefined) continue;
    const rawRevision = object(value.row.raw.revision, `${value.row.key}.revision`);
    if (rawRevision.scopeAdjudication === undefined) continue;
    const revisionParent = classificationRevisionResults.get(value.row.key)
      ?? terminalRevisionResults.get(value.row.key);
    if (!revisionParent) throw new Error(`${value.row.key}: revision scope parent authority is missing`);
    const scope = verifyProblemRepairScopeAdjudication(
      rawRevision.scopeAdjudication,
      value,
      stateDir,
      entry,
      problemEvidence,
      solutionEvidence,
      rulesDigest,
      cache,
      contract,
      revisionParent,
    );
    revisionParent.preScopeClassified = revisionParent.classified;
    revisionParent.classified = scope.classified;
    revisionParent.scopeAdjudicationGeneration = scope.generation;
    revisionParent.evidence = { ...revisionParent.evidence, scopeAdjudication: scope.evidence };
    records.set(value.row.key, scope.classified);
  }

  verifyV3TerminalRecoveryGenerations(
    base,
    first,
    classificationRevisionResults,
    terminalRevisionResults,
    stateDir,
    cache,
    contract,
    historicalTerminalRecoveryGenerations,
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
    if (value.row.raw.terminalAdjudication !== undefined) {
      expected = { ...expected, terminalAdjudication: value.row.raw.terminalAdjudication };
    }
    if (!isDeepStrictEqual(value.row.raw, expected)) {
      throw new Error(`${value.row.key}: repair evidence envelope does not match its exact shared chain`);
    }
  }
  return records;
}

function verifyExistingMigrationHistoricalRecoveryAuthority(
  audit: Record<string, unknown>,
  auditPointer: EvidencePointer,
  auditDigest: string,
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  solutionEvidence: DownloadEvidence,
  rulesDigest: string,
  base: DecisionSummary,
  solutions: Map<string, OfficialSolution>,
  contract: VerificationContract,
): ProblemRecoveryCoverageAuthority | null {
  const spec = EXISTING_MIGRATION_HISTORICAL_RECOVERY;
  if (entry.id !== spec.entryId) return null;
  if (contract.auditVersion !== 5 || entryToken(entry) !== spec.entryToken
    || problemEvidence.sha256 !== spec.sourceHash
    || hashFile(confinedEvidencePath(
      stateDir,
      { path: "problem.pdf", sha256: spec.sourceHash },
      "migration historical recovery source",
    )) !== spec.sourceHash) {
    throw new Error(`${entry.id}: migration historical recovery source/contract is stale`);
  }

  const exactSet = (actual: string[], expected: readonly string[], label: string): void => {
    if (!isDeepStrictEqual(new Set(actual), new Set(expected))) {
      throw new Error(`${label} has an orphan, conflict, or missing artifact`);
    }
  };
  const problemPaths = strictRepairGraphNames(
    stateDir,
    "problem-recoveries",
    "migration historical problem recovery",
    (name) => /^v2-\d{4}-\d{4}-[a-f0-9]{64}\.json$/u.test(name),
  ).map((name) => `problem-recoveries/${name}`)
    .filter((path) => path.startsWith("problem-recoveries/v2-0005-0014-"));
  const classificationPaths = strictRepairGraphNames(
    stateDir,
    "classification-recoveries",
    "migration historical classification recovery",
    (name) => /^v2-\d{4}-\d{4}-[a-f0-9]{64}-[a-f0-9]{16}\.json$/u.test(name),
  ).map((name) => `classification-recoveries/${name}`)
    .filter((path) => path.startsWith("classification-recoveries/v2-0005-0014-"));
  const v5AuditPaths = strictRepairGraphNames(
    stateDir,
    "answer-audit",
    "migration historical answer audit",
    (name) => /^v[1-5]-[a-f0-9]{64}\.json$/u.test(name),
  ).filter((name) => name.startsWith("v5-"))
    .map((name) => `answer-audit/${name}`);
  exactSet(problemPaths, [spec.problemRecoveryArtifact.path], "migration historical problem recovery");
  exactSet(
    classificationPaths,
    [spec.classificationRecoveryArtifact.path],
    "migration historical classification recovery",
  );
  exactSet(
    v5AuditPaths,
    [spec.currentAudit.path, spec.historicalAudit.path],
    "migration historical answer audit",
  );

  const auditRepair = (value: Record<string, unknown>, label: string): Record<string, unknown> => {
    if (!Array.isArray(value.repairs)) throw new Error(`${label} repairs are missing`);
    const matches = value.repairs.map((repair, index) => object(repair, `${label}.repairs[${index}]`))
      .filter((repair) => repair.key === spec.key);
    if (matches.length !== 1) throw new Error(`${label} ${spec.key} repair is not unique`);
    return matches[0];
  };
  if (!isDeepStrictEqual(auditPointer, {
    path: spec.currentAudit.path,
    sha256: spec.currentAudit.sha256,
  }) || auditDigest !== spec.currentAudit.digest
    || audit.effectiveCorpusHash !== spec.currentAudit.effectiveCorpusHash
    || audit.effectiveSolutionCorpusHash !== spec.currentAudit.effectiveSolutionCorpusHash) {
    throw new Error(`${entry.id}: migration current answer audit is not the selected authority`);
  }
  const currentRepair = auditRepair(audit, "migration current answer audit");
  const currentRevision = object(currentRepair.revision, "migration current Q14 revision");
  const currentClassificationRevision = object(
    currentRevision.classificationArtifact,
    "migration current Q14 classification revision",
  );
  if (canonicalEvidenceHash(currentRepair) !== spec.currentAudit.repairHash
    || currentRevision.recovery !== undefined
    || !isDeepStrictEqual(evidencePointer(
      currentRevision.problemArtifact,
      "migration current Q14 problem revision",
    ), spec.currentAudit.revisionProblemArtifact)
    || !isDeepStrictEqual(evidencePointer({
      path: currentClassificationRevision.path,
      sha256: currentClassificationRevision.sha256,
    }, "migration current Q14 classification revision"), spec.currentAudit.revisionClassificationArtifact)) {
    throw new Error(`${spec.key}: migration current revision authority is stale`);
  }

  const historicalPointer = {
    path: spec.historicalAudit.path,
    sha256: spec.historicalAudit.sha256,
  };
  const historicalAudit = readBoundEvidence(
    stateDir,
    historicalPointer,
    "migration historical answer audit",
  );
  const { version: _version, auditDigest: historicalDigest, ...historicalBasis } = historicalAudit;
  if (historicalAudit.version !== 5 || historicalAudit.entryId !== entry.id
    || historicalAudit.problemHash !== spec.sourceHash
    || historicalDigest !== spec.historicalAudit.digest
    || historicalAudit.effectiveCorpusHash !== spec.historicalAudit.effectiveCorpusHash
    || historicalAudit.effectiveSolutionCorpusHash !== spec.historicalAudit.effectiveSolutionCorpusHash
    || canonicalEvidenceHash(historicalBasis) !== spec.historicalAudit.digest) {
    throw new Error(`${entry.id}: migration historical answer audit envelope is stale`);
  }
  const historicalRepair = auditRepair(historicalAudit, "migration historical answer audit");
  if (canonicalEvidenceHash(historicalRepair) !== spec.historicalAudit.repairHash) {
    throw new Error(`${spec.key}: migration historical repair authority is stale`);
  }

  const historicalCache: EvidenceCache = new Map();
  const historicalRecords = applyDeclaredRepairsV3(
    historicalAudit.repairs as unknown[],
    stateDir,
    entry,
    problemEvidence,
    solutionEvidence,
    rulesDigest,
    base,
    solutions,
    historicalCache,
    contract,
    {
      pointer: historicalPointer,
      digest: spec.historicalAudit.digest,
      effectiveCorpusHash: historicalAudit.effectiveCorpusHash,
      terminalCheckpoints: historicalAudit.problemTerminalFidelityCheckpoints,
    },
  );
  const historicalEffective = summarizeDecisions(historicalRecords, base.order, rulesDigest);
  const historicalEffectiveHash = canonicalEvidenceHash(historicalEffective.order.map((key) => {
    const record = historicalEffective.records.get(key)!;
    return { question: record.question.evidence, classification: record.classification };
  }));
  if (historicalEffectiveHash !== spec.historicalAudit.effectiveCorpusHash) {
    throw new Error(`${entry.id}: migration historical effective corpus is stale`);
  }
  const historicalRepairKeys = new Set((historicalAudit.repairs as unknown[]).map((value, index) =>
    exactString(object(value, `migration historical repairs[${index}]`).key,
      `migration historical repairs[${index}].key`)));
  const historicalTerminal = verifyProblemTerminalFidelity(
    stateDir,
    entry,
    problemEvidence,
    historicalEffective,
    historicalAudit,
    historicalCache,
    historicalRepairKeys,
    contract,
  );
  const { itemHash: historicalItemHash, ...historicalCheckpoint } = spec.historicalAudit.finalTerminal;
  const historicalItem = historicalTerminal.items.find((item) => item.key === spec.key);
  if (!isDeepStrictEqual(historicalTerminal.checkpoints, [historicalCheckpoint])
    || !historicalItem || canonicalEvidenceHash(historicalItem) !== historicalItemHash
    || historicalItem.status !== "exact" || historicalItem.scopeDecision !== "reject"
    || historicalItem.scopeConfidence < 0.9) {
    throw new Error(`${spec.key}: migration historical final terminal authority is stale`);
  }

  return {
    historicalPaths: new Set([
      spec.problemRecoveryArtifact.path,
      spec.classificationRecoveryArtifact.path,
    ]),
    exactRecoverySets: [{
      key: spec.key,
      problemPaths: new Set([spec.problemRecoveryArtifact.path]),
      classificationPaths: new Set([spec.classificationRecoveryArtifact.path]),
    }],
  };
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

type SolutionRevisionFidelityAdjudicationEvidence = {
  allowlistId: string;
  key: string;
  sourcePage: number;
  sourcePages: number[];
  sourceHash: string;
  dpi: number;
  revisionArtifact: EvidencePointer;
  failedFidelityArtifact: EvidencePointer & { promptDigest: string };
  revisionSolutionItemHash: string;
  failedDecisionHash: string;
  failedEvidenceHash: string;
  cropEvidenceArtifact: EvidencePointer;
  cropEvidencePdf: EvidencePointer;
  cropViews: Array<{
    sourcePage: number;
    label: string;
    rect: number[];
    pixelWidth: number;
    pixelHeight: number;
    pixelSha256: string;
    artifact: EvidencePointer;
  }>;
  adjudicationArtifact: EvidencePointer & { version: number; promptDigest: string };
  adjudicationDecisionHash: string;
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
  fidelityAdjudication?: SolutionRevisionFidelityAdjudicationEvidence;
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

function solutionRevisionFidelityAdjudicationEvidence(
  value: unknown,
  label: string,
): SolutionRevisionFidelityAdjudicationEvidence {
  const row = object(value, label);
  const failedFidelityRow = object(row.failedFidelityArtifact, `${label}.failedFidelityArtifact`);
  const failedFidelityArtifact = {
    ...evidencePointer(
      { path: failedFidelityRow.path, sha256: failedFidelityRow.sha256 },
      `${label}.failedFidelityArtifact`,
    ),
    promptDigest: digest(failedFidelityRow.promptDigest, `${label}.failedFidelityArtifact.promptDigest`),
  };
  const adjudicationRow = object(row.adjudicationArtifact, `${label}.adjudicationArtifact`);
  const adjudicationArtifact = {
    ...evidencePointer(
      { path: adjudicationRow.path, sha256: adjudicationRow.sha256 },
      `${label}.adjudicationArtifact`,
    ),
    version: integer(adjudicationRow.version, `${label}.adjudicationArtifact.version`, 1),
    promptDigest: digest(adjudicationRow.promptDigest, `${label}.adjudicationArtifact.promptDigest`),
  };
  if (!Array.isArray(row.sourcePages) || !Array.isArray(row.cropViews)) {
    throw new Error(`${label} sourcePages/cropViews are invalid`);
  }
  const sourcePages = row.sourcePages.map((page, index) =>
    integer(page, `${label}.sourcePages[${index}]`, 1));
  const cropViews = row.cropViews.map((value, index) => {
    const view = object(value, `${label}.cropViews[${index}]`);
    if (!Array.isArray(view.rect) || view.rect.length !== 4
      || view.rect.some((coordinate) => typeof coordinate !== "number"
        || !Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1)) {
      throw new Error(`${label}.cropViews[${index}].rect is invalid`);
    }
    return {
      sourcePage: integer(view.sourcePage, `${label}.cropViews[${index}].sourcePage`, 1),
      label: exactString(view.label, `${label}.cropViews[${index}].label`),
      rect: [...view.rect] as number[],
      pixelWidth: integer(view.pixelWidth, `${label}.cropViews[${index}].pixelWidth`, 1),
      pixelHeight: integer(view.pixelHeight, `${label}.cropViews[${index}].pixelHeight`, 1),
      pixelSha256: digest(view.pixelSha256, `${label}.cropViews[${index}].pixelSha256`),
      artifact: evidencePointer(view.artifact, `${label}.cropViews[${index}].artifact`),
    };
  });
  const evidence: SolutionRevisionFidelityAdjudicationEvidence = {
    allowlistId: exactString(row.allowlistId, `${label}.allowlistId`),
    key: exactString(row.key, `${label}.key`),
    sourcePage: integer(row.sourcePage, `${label}.sourcePage`, 1),
    sourcePages,
    sourceHash: digest(row.sourceHash, `${label}.sourceHash`),
    dpi: integer(row.dpi, `${label}.dpi`, 72),
    revisionArtifact: evidencePointer(row.revisionArtifact, `${label}.revisionArtifact`),
    failedFidelityArtifact,
    revisionSolutionItemHash: digest(
      row.revisionSolutionItemHash,
      `${label}.revisionSolutionItemHash`,
    ),
    failedDecisionHash: digest(row.failedDecisionHash, `${label}.failedDecisionHash`),
    failedEvidenceHash: digest(row.failedEvidenceHash, `${label}.failedEvidenceHash`),
    cropEvidenceArtifact: evidencePointer(row.cropEvidenceArtifact, `${label}.cropEvidenceArtifact`),
    cropEvidencePdf: evidencePointer(row.cropEvidencePdf, `${label}.cropEvidencePdf`),
    cropViews,
    adjudicationArtifact,
    adjudicationDecisionHash: digest(
      row.adjudicationDecisionHash,
      `${label}.adjudicationDecisionHash`,
    ),
  };
  if (!isDeepStrictEqual(row, evidence)) throw new Error(`${label} has unexpected fields`);
  return evidence;
}

function persistedSolutionRevisionAuthority(
  value: unknown,
  label: string,
): PersistedSolutionRevisionAuthority {
  const row = object(value, label);
  const fidelityAdjudication = row.fidelityAdjudication === undefined
    ? undefined
    : solutionRevisionFidelityAdjudicationEvidence(
      row.fidelityAdjudication,
      `${label}.fidelityAdjudication`,
    );
  const authority: PersistedSolutionRevisionAuthority = {
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
    ...(fidelityAdjudication ? { fidelityAdjudication } : {}),
  };
  if (!isDeepStrictEqual(row, authority)) throw new Error(`${label} has unexpected fields`);
  return authority;
}

function normalizedSolutionLiteral(value: string): string {
  return value.replace(/\\\(|\\\)|\$/gu, "").replace(/\s+/gu, "");
}

function verifySolutionRevisionFidelityAdjudication(
  stateDir: string,
  entry: ManifestEntry,
  solutionEvidence: DownloadEvidence,
  effectiveProblemCorpusHash: string,
  input: SolutionFidelityInput,
  solution: OfficialSolution,
  revisionArtifact: EvidencePointer,
  failedFidelityArtifact: EvidencePointer & { promptDigest: string },
  failedDecision: SolutionFidelityDecision,
  candidates: CanonicalSolutionArtifact[],
  declared?: unknown,
): {
  decision: SolutionFidelityDecision;
  artifact: EvidencePointer;
  evidence: SolutionRevisionFidelityAdjudicationEvidence;
  evidencePaths: string[];
} {
  const revisionSolutionItemHash = canonicalEvidenceHash(solution.evidence);
  const failedDecisionHash = canonicalEvidenceHash(failedDecision);
  const failedEvidenceHash = sha256(failedDecision.evidence);
  const spec = SOLUTION_REVISION_FIDELITY_ADJUDICATION_ALLOWLIST.find((candidate) =>
    candidate.entryId === entry.id && candidate.key === input.key
      && candidate.sourceHash === solutionEvidence.sha256
      && candidate.revisionArtifactHash === revisionArtifact.sha256
      && candidate.failedFidelityArtifactHash === failedFidelityArtifact.sha256
      && candidate.revisionSolutionItemHash === revisionSolutionItemHash
      && candidate.failedDecisionHash === failedDecisionHash
      && candidate.failedEvidenceHash === failedEvidenceHash);
  if (!spec || failedFidelityArtifact.promptDigest !== SOLUTION_FIDELITY_PROMPT_DIGEST
    || failedDecision.sourcePage !== solution.page || failedDecision.answerStatus !== "exact"
    || failedDecision.explanationStatus !== "mismatch"
    || isTerminalSolutionDecision(input, solution, failedDecision)
    || hashFile(confinedEvidencePath(
      stateDir,
      { path: solutionEvidence.path, sha256: solutionEvidence.sha256 },
      `${input.key} official solution PDF`,
    )) !== solutionEvidence.sha256
    || solution.rawAnswer !== "③"
    || !normalizedSolutionLiteral(solution.explanation).includes(
      normalizedSolutionLiteral(spec.literalToken),
    )) {
    throw new Error(`${input.key}: solution fidelity adjudication is not exactly allowlisted`);
  }
  for (const [label, pointer] of [
    ["solution revision", revisionArtifact],
    ["failed solution revision fidelity", failedFidelityArtifact],
  ] as const) {
    if (hashFile(confinedEvidencePath(stateDir, pointer, `${input.key} ${label}`)) !== pointer.sha256) {
      throw new Error(`${input.key}: ${label} hash mismatch`);
    }
  }
  const children = candidates.filter((candidate) => {
    const basis = object(candidate.checkpoint.basis, `${candidate.path}.basis`);
    return object(basis.revisionArtifact, `${candidate.path}.basis.revisionArtifact`).path
      === revisionArtifact.path;
  });
  if (children.length !== 1) {
    throw new Error(`${input.key}: solution fidelity adjudication child coverage is not exact`);
  }
  const child = children[0];
  const sourcePages = [...new Set(spec.views.map((view) => view.sourcePage))]
    .sort((left, right) => left - right);
  if (sourcePages.some((page) => page > solutionEvidence.pageCount)) {
    throw new Error(`${input.key}: solution fidelity adjudication source pages are out of range`);
  }
  const evidenceBasis = {
    allowlistId: spec.allowlistId,
    entryId: entry.id,
    key: input.key,
    sourcePage: spec.sourcePage,
    sourcePages,
    sourceHash: solutionEvidence.sha256,
    dpi: spec.dpi,
    views: spec.views,
    requiredTokens: spec.requiredTokens,
  };
  const evidenceDigest = canonicalEvidenceHash(evidenceBasis);
  const evidenceStem = `v${SOLUTION_REVISION_FIDELITY_ADJUDICATION_VERSION}-` +
    `${String(spec.sourcePage).padStart(4, "0")}-${input.printedNumber.padStart(4, "0")}-` +
    evidenceDigest;
  const evidencePath = `solution-fidelity-adjudication-evidence/${evidenceStem}.json`;
  const evidencePdfPath = `solution-fidelity-adjudication-evidence/${evidenceStem}.pdf`;
  const evidenceCheckpoint = readBoundEvidence(
    stateDir,
    { path: evidencePath, sha256: hashFile(confinedEvidencePath(
      stateDir,
      { path: evidencePath, sha256: "0".repeat(64) },
      `${input.key} solution fidelity adjudication evidence`,
    )) },
    `${input.key} solution fidelity adjudication evidence`,
  );
  if (!Array.isArray(evidenceCheckpoint.views) || evidenceCheckpoint.views.length !== spec.views.length) {
    throw new Error(`${input.key}: solution fidelity adjudication view coverage is not exact`);
  }
  const cropViews = evidenceCheckpoint.views.map((value, index) => {
    const row = object(value, `${evidencePath}.views[${index}]`);
    const expected = spec.views[index];
    if (!Array.isArray(row.rect) || !isDeepStrictEqual(row.rect, [...expected.rect])
      || row.sourcePage !== expected.sourcePage || row.label !== expected.label) {
      throw new Error(`${input.key}: solution fidelity adjudication view ${index} is stale`);
    }
    const artifact = evidencePointer(row.artifact, `${evidencePath}.views[${index}].artifact`);
    const pixelWidth = integer(row.pixelWidth, `${evidencePath}.views[${index}].pixelWidth`, 1);
    const pixelHeight = integer(row.pixelHeight, `${evidencePath}.views[${index}].pixelHeight`, 1);
    const pixelSha256 = digest(row.pixelSha256, `${evidencePath}.views[${index}].pixelSha256`);
    const expectedPath = `solution-fidelity-adjudication-evidence/${evidenceStem}-view-` +
      `${String(index).padStart(2, "0")}.png`;
    const absolute = confinedEvidencePath(stateDir, artifact, `${input.key} adjudication view ${index}`);
    const dimensions = cropPngDimensions(absolute, `${input.key} adjudication view ${index}`);
    const view = {
      sourcePage: expected.sourcePage,
      label: expected.label,
      rect: [...expected.rect] as number[],
      pixelWidth,
      pixelHeight,
      pixelSha256,
      artifact,
    };
    if (artifact.path !== expectedPath || artifact.sha256 !== pixelSha256
      || hashFile(absolute) !== pixelSha256 || dimensions.width !== pixelWidth
      || dimensions.height !== pixelHeight || !isDeepStrictEqual(row, view)) {
      throw new Error(`${input.key}: solution fidelity adjudication view ${index} hash/size is stale`);
    }
    return view;
  });
  const evidencePdf = evidencePointer(
    evidenceCheckpoint.evidencePdf,
    `${evidencePath}.evidencePdf`,
  );
  if (evidencePdf.path !== evidencePdfPath
    || hashFile(confinedEvidencePath(stateDir, evidencePdf, `${input.key} adjudication PDF`))
      !== evidencePdf.sha256) {
    throw new Error(`${input.key}: solution fidelity adjudication PDF is stale`);
  }
  const expectedEvidenceCheckpoint = {
    version: SOLUTION_REVISION_FIDELITY_ADJUDICATION_VERSION,
    entryId: entry.id,
    basisDigest: evidenceDigest,
    basis: evidenceBasis,
    renderer: "pdftocairo-png+pdf-lib",
    dpi: spec.dpi,
    evidencePdf,
    views: cropViews,
  };
  if (!isDeepStrictEqual(evidenceCheckpoint, expectedEvidenceCheckpoint)) {
    throw new Error(`${input.key}: solution fidelity adjudication evidence checkpoint is stale`);
  }
  const cropEvidenceArtifact = { path: evidencePath, sha256: canonicalEvidenceHash(evidenceCheckpoint) };
  const inputHash = canonicalEvidenceHash(input);
  const basis = {
    allowlistId: spec.allowlistId,
    entryId: entry.id,
    key: input.key,
    sourcePage: spec.sourcePage,
    sourcePages,
    sourceHash: solutionEvidence.sha256,
    dpi: spec.dpi,
    effectiveProblemCorpusHash,
    revisionArtifact,
    failedFidelityArtifact,
    revisionSolutionItemHash,
    failedDecision,
    failedDecisionHash,
    failedEvidenceHash,
    cropEvidenceArtifact,
    cropEvidencePdf: evidencePdf,
    cropViews,
    inputHash,
    promptDigest: SOLUTION_REVISION_FIDELITY_ADJUDICATION_PROMPT_DIGEST,
  };
  const basisDigest = canonicalEvidenceHash(basis);
  const expectedChildPath = `solution-fidelity-adjudications/` +
    `v${SOLUTION_REVISION_FIDELITY_ADJUDICATION_VERSION}-${String(solution.page).padStart(4, "0")}-` +
    `${input.printedNumber.padStart(4, "0")}-${basisDigest}.json`;
  const decision = solutionFidelityDecision(
    child.checkpoint.item,
    input,
    `${child.path}.item`,
  );
  const expectedChild = {
    version: SOLUTION_REVISION_FIDELITY_ADJUDICATION_VERSION,
    basisDigest,
    basis,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    input,
    item: decision,
  };
  if (child.path !== expectedChildPath || !isDeepStrictEqual(child.checkpoint, expectedChild)
    || decision.sourcePage !== solution.page || decision.answerStatus !== "exact"
    || decision.explanationStatus !== "exact") {
    throw new Error(`${input.key}: solution fidelity adjudication child is stale or nonterminal`);
  }
  const evidence: SolutionRevisionFidelityAdjudicationEvidence = {
    allowlistId: spec.allowlistId,
    key: input.key,
    sourcePage: spec.sourcePage,
    sourcePages,
    sourceHash: solutionEvidence.sha256,
    dpi: spec.dpi,
    revisionArtifact,
    failedFidelityArtifact,
    revisionSolutionItemHash,
    failedDecisionHash,
    failedEvidenceHash,
    cropEvidenceArtifact,
    cropEvidencePdf: evidencePdf,
    cropViews,
    adjudicationArtifact: {
      path: child.path,
      sha256: child.sha256,
      version: SOLUTION_REVISION_FIDELITY_ADJUDICATION_VERSION,
      promptDigest: SOLUTION_REVISION_FIDELITY_ADJUDICATION_PROMPT_DIGEST,
    },
    adjudicationDecisionHash: canonicalEvidenceHash(decision),
  };
  if (declared !== undefined && !isDeepStrictEqual(
    solutionRevisionFidelityAdjudicationEvidence(declared, `${input.key}.fidelityAdjudication`),
    evidence,
  )) {
    throw new Error(`${input.key}: solution fidelity adjudication envelope is stale`);
  }
  return {
    decision,
    artifact: { path: child.path, sha256: child.sha256 },
    evidence,
    evidencePaths: [evidencePath, evidencePdfPath, ...cropViews.map((view) => view.artifact.path)],
  };
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
  const revisionFidelityAdjudicationFiles = readCanonicalSolutionArtifacts(
    stateDir,
    "solution-fidelity-adjudications",
    /^v1-\d{4}-\d{4}-[a-f0-9]{64}\.json$/u,
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
  const adjudicationEvidenceDirectory = join(stateDir, "solution-fidelity-adjudication-evidence");
  const hasAdjudicationEvidence = existsSync(adjudicationEvidenceDirectory)
    && readdirSync(adjudicationEvidenceDirectory, { withFileTypes: true }).some((entry) =>
      !(entry.isFile() && entry.name.endsWith(".tmp")));
  const empty = {
    byKey: new Map<string, PersistedSolutionGeneration[]>(),
    currentByKey: new Map<string, PersistedSolutionGeneration>(),
    requiredRevisionKeys: new Set<string>(),
  };
  if (repairFiles.length + repairFidelityFiles.length + revisionFiles.length + revisionFidelityFiles.length
    + revisionFidelityAdjudicationFiles.length
    + promptUpgradeFiles.length + promptUpgradeFidelityFiles.length === 0
    && !hasAdjudicationEvidence) {
    return empty;
  }
  if ((revisionFidelityAdjudicationFiles.length > 0
    || hasAdjudicationEvidence)
    && contract.auditVersion !== 5) {
    throw new Error("solution fidelity adjudication requires answer audit v5");
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
  const assignedRevisionFidelityAdjudication = new Set<string>();
  const assignedRevisionFidelityAdjudicationEvidence = new Set<string>();
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
        const adjudicationSpec = SOLUTION_REVISION_FIDELITY_ADJUDICATION_ALLOWLIST.find((candidate) =>
          candidate.entryId === entry.id && candidate.key === key
            && candidate.sourceHash === solutionEvidence.sha256
            && candidate.revisionArtifactHash === revisionFile.sha256
            && candidate.failedFidelityArtifactHash === revisionFidelityFile.sha256
            && candidate.revisionSolutionItemHash === revisedItemHash
            && candidate.failedDecisionHash === canonicalEvidenceHash(finalDecision)
            && candidate.failedEvidenceHash === sha256(finalDecision.evidence));
        if (adjudicationSpec) {
          const adjudicated = verifySolutionRevisionFidelityAdjudication(
            stateDir,
            entry,
            solutionEvidence,
            effectiveProblemCorpusHash,
            revisedInput,
            revised,
            { path: revisionFile.path, sha256: revisionFile.sha256 },
            {
              path: revisionFidelityFile.path,
              sha256: revisionFidelityFile.sha256,
              promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
            },
            finalDecision,
            revisionFidelityAdjudicationFiles,
          );
          assignedRevisionFidelityAdjudication.add(adjudicated.artifact.path);
          for (const path of adjudicated.evidencePaths) {
            if (assignedRevisionFidelityAdjudicationEvidence.has(path)) {
              throw new Error(`${key}: duplicate solution fidelity adjudication evidence`);
            }
            assignedRevisionFidelityAdjudicationEvidence.add(path);
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
            fidelityAdjudication: adjudicated.evidence,
          };
          if (rawTrigger.kind !== "persisted") revisionTrigger = trigger;
        } else {
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
        }
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
  if (revisionFidelityAdjudicationFiles.some((file) =>
    !assignedRevisionFidelityAdjudication.has(file.path))) {
    throw new Error("orphan solution revision fidelity adjudication artifact");
  }
  const actualAdjudicationEvidence = new Set<string>();
  if (existsSync(adjudicationEvidenceDirectory)) {
    for (const child of readdirSync(adjudicationEvidenceDirectory, { withFileTypes: true })) {
      if (child.isFile() && child.name.endsWith(".tmp")) continue;
      if (!child.isFile() || child.isSymbolicLink()) {
        throw new Error(`solution fidelity adjudication evidence/${child.name} is not a regular file`);
      }
      actualAdjudicationEvidence.add(`solution-fidelity-adjudication-evidence/${child.name}`);
    }
  }
  if ([...actualAdjudicationEvidence].some((path) =>
    !assignedRevisionFidelityAdjudicationEvidence.has(path))
    || [...assignedRevisionFidelityAdjudicationEvidence].some((path) =>
      !actualAdjudicationEvidence.has(path))) {
    throw new Error("solution fidelity adjudication evidence has orphan or missing authority");
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
  fidelityArtifact: EvidencePointer & { promptDigest?: string };
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
  let terminalDecision = decision;
  let terminalFidelityArtifact: EvidencePointer & { promptDigest?: string } = contract.auditVersion >= 5
    ? { ...fidelityArtifact, promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST }
    : fidelityArtifact;
  let fidelityAdjudication: SolutionRevisionFidelityAdjudicationEvidence | undefined;
  if (!isTerminalSolutionDecision(input, revised, decision)) {
    if (revision.fidelityAdjudication === undefined || contract.auditVersion !== 5) {
      throw new Error(`${key}: solution revision did not reach terminal source fidelity`);
    }
    const candidates = readCanonicalSolutionArtifacts(
      stateDir,
      "solution-fidelity-adjudications",
      /^v1-\d{4}-\d{4}-[a-f0-9]{64}\.json$/u,
    );
    const adjudicated = verifySolutionRevisionFidelityAdjudication(
      stateDir,
      entry,
      solutionEvidence,
      effectiveProblemCorpusHash,
      revisedInput,
      revised,
      solutionArtifact,
      { ...fidelityArtifact, promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST },
      decision,
      candidates,
      revision.fidelityAdjudication,
    );
    terminalDecision = adjudicated.decision;
    terminalFidelityArtifact = adjudicated.artifact;
    fidelityAdjudication = adjudicated.evidence;
  } else if (revision.fidelityAdjudication !== undefined) {
    throw new Error(`${key}: terminal revision must not declare fidelity adjudication`);
  }
  if (promptUpgradeSpec && terminalDecision.answerStatus !== "exact") {
    throw new Error(`${key}: prompt-upgrade revision answer fidelity is not exact`);
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
    ...(fidelityAdjudication ? { fidelityAdjudication } : {}),
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
    || !isDeepStrictEqual(
      persistedGeneration.revision.fidelityAdjudication,
      fidelityAdjudication,
    )
  )) {
    throw new Error(`${key}: current revision does not match the reconstructed persisted generation`);
  }
  return {
    solution: revised,
    decision: terminalDecision,
    fidelityArtifact: terminalFidelityArtifact,
    evidence: expectedEvidence,
  };
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
    const actualItems = Array.isArray(audit.solutionFidelityItems) ? audit.solutionFidelityItems : [];
    const mismatch = items.findIndex((item, index) => !isDeepStrictEqual(actualItems[index], item));
    throw new Error(
      `answer audit terminal solution fidelity items/repairs are not exact` +
      (mismatch < 0 ? "" : ` at item ${mismatch}: ${canonicalEvidenceHash(actualItems[mismatch])}/` +
        canonicalEvidenceHash(items[mismatch])),
    );
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
  for (const directory of [
    "solution-revision-upgrades",
    "solution-fidelity-revision-upgrades",
    "solution-fidelity-adjudications",
    "solution-fidelity-adjudication-evidence",
  ]) {
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

function hasPersistedTerminalRecoveryHydrationSignal(stateDir: string): boolean {
  try {
    const state = object(json(join(stateDir, "entry.json")), "persisted terminal recovery entry state");
    const entry = object(state.entry, "persisted terminal recovery entry");
    return PERSISTED_TERMINAL_RECOVERY_HYDRATION_ALLOWLIST.some((spec) => spec.entryId === entry.id);
  } catch {
    return false;
  }
}

type VerifiedAnswerAudit = {
  decisions: DecisionSummary;
  solutions: Map<string, OfficialSolution>;
  auditPointer?: EvidencePointer;
  attestationPointer?: EvidencePointer;
  effectiveCorpusHash?: string;
  effectiveSolutionCorpusHash?: string;
};

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
  const positiveRepairScopeAdjudicationDirectory = join(
    stateDir,
    "classification-repair-positive-scope-adjudications",
  );
  const positiveRepairScopeAdjudicationSignal = existsSync(positiveRepairScopeAdjudicationDirectory)
    && readdirSync(positiveRepairScopeAdjudicationDirectory, { withFileTypes: true }).some((entry) =>
      !(entry.isFile() && entry.name.endsWith(".tmp")));
  const revisionScopeAdjudicationDirectory = join(stateDir, "classification-revision-scope-adjudications");
  const revisionScopeAdjudicationSignal = existsSync(revisionScopeAdjudicationDirectory)
    && readdirSync(revisionScopeAdjudicationDirectory, { withFileTypes: true }).some((entry) =>
      !(entry.isFile() && entry.name.endsWith(".tmp")));
  const manualAdjudicationSignal = [
    "problem-manual-evidence",
    "problem-manual-adjudications",
    "classification-manual-adjudications",
    "problem-manual-revisions",
    "classification-manual-revisions",
    "problem-scope-box-evidence",
    "problem-scope-box-revisions",
    "classification-scope-box-revisions",
    "problem-terminal-fidelity-adjudications",
    "problem-terminal-fidelity-policy-revisions",
  ].some((directory) => {
    const absolute = join(stateDir, directory);
    if (directory.startsWith("problem-scope-box-") || directory === "classification-scope-box-revisions"
      || directory === "problem-terminal-fidelity-policy-revisions") {
      try {
        const info = lstatSync(absolute);
        if (info.isSymbolicLink() || !info.isDirectory()
          || realpathSync(absolute) !== resolve(realpathSync(stateDir), directory)) return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ENOENT";
      }
    }
    return existsSync(absolute) && readdirSync(absolute, { withFileTypes: true }).some((entry) =>
      !(entry.isFile() && entry.name.endsWith(".tmp")));
  });
  const v5GenerationSignal = (
    listJson(join(stateDir, "semantic-choice-checks"), /^v5-.*\.json$/u).length > 0
    || listJson(join(stateDir, "answer-audit"), /^v5-.*\.json$/u).length > 0
    || listJson(join(stateDir, "answer-attestation"), /^v5-.*\.json$/u).length > 0
    || scopeAdjudicationSignal
    || repairScopeAdjudicationSignal
    || positiveRepairScopeAdjudicationSignal
    || revisionScopeAdjudicationSignal
    || manualAdjudicationSignal
    || hasPersistedTerminalRecoveryHydrationSignal(stateDir)
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

export function verificationContractAuditVersionForTest(stateDir: string): number {
  return selectVerificationContract(stateDir, null, null).auditVersion;
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
    const migrationHistoricalRecovery = verifyExistingMigrationHistoricalRecoveryAuthority(
      audit,
      auditPointer,
      auditDigest,
      stateDir,
      entry,
      problemEvidence,
      solutionEvidence,
      rulesDigest,
      base,
      solutions,
      contract,
    );
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
          {
            pointer: auditPointer,
            digest: auditDigest,
            effectiveCorpusHash: audit.effectiveCorpusHash,
            terminalCheckpoints: audit.problemTerminalFidelityCheckpoints,
          },
          migrationHistoricalRecovery,
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
    return {
      decisions: effective,
      solutions: effectiveSolutions,
      auditPointer,
      attestationPointer: {
        path: `answer-attestation/${name}`,
        sha256: hashFile(attestationPath),
      },
      effectiveCorpusHash,
      effectiveSolutionCorpusHash: solutionFidelity.effectiveSolutionCorpusHash,
    };
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
          {
            pointer,
            digest: auditDigest,
            effectiveCorpusHash: audit.effectiveCorpusHash,
            terminalCheckpoints: audit.problemTerminalFidelityCheckpoints,
          },
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

const EXISTING_CORPUS_MIGRATION_VERSION = 1;
const MIGRATION_QUESTION_MUTABLE_COLUMNS = [
  "subject_id", "source", "qtype", "difficulty", "question", "choices", "answer", "explanation",
  "book_id", "book_number", "printed_number", "src_file_id", "src_page", "has_figure",
  "figure_description", "figure_box",
] as const;
const MIGRATION_QUESTION_COLUMNS = [
  "id", "subject_id", "source", "qtype", "difficulty", "question", "choices", "answer", "explanation",
  "correct_count", "wrong_count", "created_at", "from_wrong_note", "book_id", "book_number", "src_file_id",
  "src_page", "has_figure", "figure_box", "figure_description", "printed_number", "mock_exam_job_id",
  "mock_exam_title", "exam_order", "exam_points", "exam_section", "passage_group", "passage",
] as const;
const MIGRATION_ITEM_COLUMNS = [
  "id", "book_id", "file_id", "category", "number", "answer", "content", "page", "created_at",
  "has_figure", "figure_box",
] as const;

type MigrationRow = Record<string, unknown> & { id: number };
type OwnedMigrationProjection = {
  books: MigrationRow[];
  files: MigrationRow[];
  questions: MigrationRow[];
  items: MigrationRow[];
  guards: {
    attempts: number;
    materials: number;
    bookExtractionChunks: number;
    materialExtractionChunks: number;
  };
};
type MigrationProjection = OwnedMigrationProjection & {
  sequences: { questions: number; bookItems: number };
};
type MigrationOperations = {
  questionUpdates: Array<{ id: number; before: MigrationRow; after: MigrationRow }>;
  questionInserts: Array<{ after: MigrationRow }>;
  itemUpdates: Array<{ id: number; before: MigrationRow; after: MigrationRow }>;
  itemInserts: Array<{ after: MigrationRow }>;
};
type ExistingMigrationPlan = {
  version: number;
  basisDigest: string;
  identity: {
    entryId: string;
    entryRaw: unknown;
    entryRawHash: string;
    oldReceipt: { path: "receipt.json"; sha256: string; value: unknown };
    receiptCore: { sha256: string; value: unknown };
    receiptHistory: EvidencePointer;
    answerAudit: EvidencePointer & { effectiveCorpusHash: string; effectiveSolutionCorpusHash: string };
    problemHash: string;
    solutionHash: string;
    ownership: {
      bookIds: number[];
      fileIds: number[];
      beforeQuestionIds: number[];
      afterQuestionIds: number[];
      beforeBookItemIds: number[];
      afterBookItemIds: number[];
    };
    beforeProjectionHash: string;
    afterProjectionHash: string;
    stableAfterProjectionHash: string;
    beforeSequences: { questions: number; bookItems: number };
    afterSequences: { questions: number; bookItems: number };
    beforeProjection: OwnedMigrationProjection;
    afterProjection: OwnedMigrationProjection;
    operations: MigrationOperations;
    backup: { sha256: string; bytes: number };
  };
  finalReceipt: { path: "receipt.json"; sha256: string; value: unknown };
  backup: { path: string; sha256: string; bytes: number };
};

const EXISTING_MIGRATION_ALLOWLIST = [{
  entryId: "ebsi:5695028",
  entryToken: "bc66d0c1b35ffd8e12edd536",
  oldReceiptSha256: "5e1fbea9c346a0e89fb21938176c21e00c19527e6369f5251a1f53e6446711a1",
  receiptCoreSha256: "0b4cad740ed82c70e15deac8568242c6fd89714672820d0526376886e4ca6efe",
  beforeProjectionHash: "58512b2d03488e009d80064082d7b230fdd1acefeea12401ca2572b670e6c996",
  afterProjectionHash: "1bedcd46e0c24a5138cd6213708680754caba6b1ae2ffed98cdd167d7a47e6f1",
  auditPath: "answer-audit/v5-b624ac400f03d3afac4d1f0d1463d40a424a9ec0e86fbc48d6c6021febed2cc6.json",
  auditSha256: "34fe8f3cd3fe79cc35cea5f33b0aa5edeaba73793130c56d404796eac8adb3fe",
  effectiveCorpusHash: "b2e4ac74b0c4e60c24926054f19bde5cb3786f7c1e229926eb288f93544c9af0",
  effectiveSolutionCorpusHash: "6f7a613784c4455377e3af3d72b5326336ff42a214a84dd959da1c3b2f982908",
  problemHash: "6cf12186b20a757ec3c3b09fa3b27df8a2583cfbeec486b828e4f6ce03aba793",
  solutionHash: "0d01dd60feabdf068b9cc81f781de4759ee426f5680e2c2fdbff64c2950de3d6",
  bookIds: [100, 101],
  fileIds: [148, 149, 150, 151],
  questionIds: Array.from({ length: 13 }, (_, index) => 3214 + index),
  bookItemIds: Array.from({ length: 26 }, (_, index) => 6958 + index),
  newKeys: ["10:26"],
  newQuestions: [{
    key: "10:26",
    targetSubject: "수학 - 수학Ⅱ·미적분Ⅰ" as TargetSubject,
    qtype: "short",
    difficulty: "중",
    question: "곡선 $y=6x^2-12x$와 $x$축으로 둘러싸인 부분의 넓이를 구하시오. $[4점]$",
    answer: "8",
    solutionPage: 8,
  }],
}, {
  entryId: "ebsi:5734412",
  entryToken: "514652aa98da96737758368d",
  oldReceiptSha256: "d8c827753975f333c387db90d17e70b9b5e7cb363730d2e602bb2c4f3176cfc0",
  receiptCoreSha256: "d8c827753975f333c387db90d17e70b9b5e7cb363730d2e602bb2c4f3176cfc0",
  beforeProjectionHash: "fb8e8647745924db4fc46cbb3bd4dd61c0bb61bf557e7c195f83d7b406f0da4a",
  afterProjectionHash: "74648286834d0b62394055b9c5b15b850aa11282428b3b0d4534e75fea664c46",
  auditPath: "answer-audit/v5-4c183e0506d125da99903d9edf897524b39cb4996ac767d4e7ff61e52968ca20.json",
  auditSha256: "6d916ada8e959d121b87e13b9f9c0ee6ca9dcbd01f2ebbf616d1b6aedd1ffe0d",
  effectiveCorpusHash: "daa75b24e9fcc676caf0e81d90aa39d24270f7233d0c64ee32ef2734d9f3519d",
  effectiveSolutionCorpusHash: "ec8f50fb80e53707a2fa43f118619fa4783c7e05869176c8155768b6a1bdf4fe",
  problemHash: "ca93efb7ed75d23685b9e1f3586ba6a9b071d79602a4e229c8f47c1d1f2415d3",
  solutionHash: "9f984d71cb1eaad8e52f7efed4b369a35e51234edf374ce7a565728c0a55d514",
  bookIds: [102],
  fileIds: [152, 153],
  questionIds: [3227],
  bookItemIds: [6984, 6985],
  newKeys: [],
  newQuestions: [],
}, {
  entryId: "ebsi:5696440",
  entryToken: "5d284ad3480f9a6552df0a23",
  oldReceiptSha256: "3bfba756aad8f86385b82f0ae2e5d215a6bd64d35b4f23b81a5293ba7e8c1631",
  receiptCoreSha256: "3bfba756aad8f86385b82f0ae2e5d215a6bd64d35b4f23b81a5293ba7e8c1631",
  beforeProjectionHash: "8dcaad674991b06c82eaf98e5fdc150a4e228d3cc4635efaf492f9358ee3ecbc",
  afterProjectionHash: "e749082f27c221efdc2d3a9a90b19fb9811565b56bae1b5b70590f8a8d2fa028",
  auditPath: "answer-audit/v5-23ab32c4ce090a1ce9ba219993ae11f80ee6b321b53458c036ba32b03044d00d.json",
  auditSha256: "16f98f43fcb49c26cbb8f03ab9d24d382c301e6d3ae3ff6d89f67f496570d566",
  effectiveCorpusHash: "7ef01c038daf171b2a9539537b15f71caa77185f35e6a65721f77947cddaff7a",
  effectiveSolutionCorpusHash: "b7b138cc3a80be0c57a160eba0dc5a9c1f441d825054194180bab83a448bda78",
  problemHash: "cbdfc892a99b4b25f4eec8c2cc8db2471e947c4cc7b968103cca7f63d969ca32",
  solutionHash: "2a9f065ecdcd5e05feff6e8fb647d065b62502ad04ad084f0f58dcf63f11182a",
  bookIds: [89, 90],
  fileIds: [126, 127, 128, 129],
  questionIds: Array.from({ length: 16 }, (_, index) => 3093 + index),
  bookItemIds: Array.from({ length: 32 }, (_, index) => 6716 + index),
  newKeys: [],
  newQuestions: [],
}, {
  entryId: "ebsi:5854175",
  entryToken: "231f0e1a573a042551a8df8e",
  oldReceiptSha256: "cbfd646f22cecc50485180b15432bdc8c0f062094d1f351180506f8707795af9",
  receiptCoreSha256: "cbfd646f22cecc50485180b15432bdc8c0f062094d1f351180506f8707795af9",
  beforeProjectionHash: "a12af7f2fc6f49314dc30532b7421ce34b1f430436964b763cc67bb3547d6338",
  afterProjectionHash: "21e9dd2731d0ffbd97b595333e5367224e59f5ae108ead4914c83e76ea1507a7",
  auditPath: "answer-audit/v5-8a3c3f73fa0cef2a12422204320d4a4abd85d6db817a6fa1e07c385f70449c70.json",
  auditSha256: "1372f262965e9f82f37b37f46aa0b26e9f10195183bf050ba74f73819e185618",
  effectiveCorpusHash: "b864530f8f724a072054222b1d05d16037b818563b069860809620b0e394d600",
  effectiveSolutionCorpusHash: "39200e18faca60c8a19316f97f4dd6956842f0c281a64fbe3ec2317d787de56a",
  problemHash: "b4b8bfcbfefabd3f96e9fe20e9717f692fcb355a20309388d0d63c6775215813",
  solutionHash: "f72909caef654112306bda47255c33dd0576c638875b3a07ce536f58f34641f0",
  bookIds: [120],
  fileIds: [188, 189],
  questionIds: [3401, 3402, 3403, 3404, 3405, 3406, 3407],
  bookItemIds: [7332, 7333, 7334, 7335, 7336, 7337, 7338, 7339, 7340, 7341, 7342, 7343, 7344, 7345],
  newKeys: [],
  newQuestions: [],
}, {
  entryId: "ebsi:5525983",
  entryToken: "428d081af34fd999140a2e32",
  oldReceiptSha256: "f3c51d807b62b08ed77034feab03312044f866da06b7971e31e0e05680fbd84c",
  receiptCoreSha256: "f3c51d807b62b08ed77034feab03312044f866da06b7971e31e0e05680fbd84c",
  beforeProjectionHash: "186f94bda8c9092003437b1c74665e89f8ae1f4b538ccb503f9023fa53db75dd",
  afterProjectionHash: "dacf6a8a09bafc79e7daa1469a6cd2932efaa6d8afd606e7cd453efff2e0e245",
  auditPath: "answer-audit/v5-35eba99bc56c84bf55c803de1cfb6d01021393a3d2426c18a0d170f1009f0883.json",
  auditSha256: "d9d06b303eec9a94ab4bf64ee4bff20abbf69a463efbd444d669c1919bdf7e71",
  effectiveCorpusHash: "32172232028ffb36bbb0705f0642ae95cbde92384296692c70e4a34509e8e344",
  effectiveSolutionCorpusHash: "0d703cd59cacc77c59879f3776f873402d9ba32a2c57eaecdef783479ce6deaf",
  problemHash: "ba2a4e104409959e7a35308caab3c29abbb8508a2ddabf73e576686e862f6374",
  solutionHash: "ce3060530378859a7df7a407667571e328fd2e33c5b2bd241ce835187b05436f",
  bookIds: [69],
  fileIds: [86, 87],
  questionIds: [2933, 2934],
  bookItemIds: [6396, 6397, 6398, 6399],
  newKeys: [],
  newQuestions: [],
}, {
  entryId: "ebsi:5578422",
  entryToken: "b2aa49772f3617352e026722",
  oldReceiptSha256: "17ca781153b8d378decaa7060c596a434db5362d61ac9351325cf69fc468fb97",
  receiptCoreSha256: "17ca781153b8d378decaa7060c596a434db5362d61ac9351325cf69fc468fb97",
  beforeProjectionHash: "2e734c47b80d6b8038f7fbba8de81dc827c552849fdb98c65c6d6c271787c538",
  afterProjectionHash: "b613496061d98f19ee89942e8e2e802e5a400992e4069119c0c4f537f90d3783",
  auditPath: "answer-audit/v5-cd4cc13f0510a5d29948c6227a8191752672db963a530917175adbf46fcad40d.json",
  auditSha256: "85e692a9ad5f16f4533562be6687a71a07776d4d9848dfba1528440a1859284e",
  effectiveCorpusHash: "135a6716cd80cfac101eb518fab4a42fbe828834f5d58f27f1367c10540d6365",
  effectiveSolutionCorpusHash: "0f878b0cc25930ad5ec55495e4d6e0b99645523f5e06dd09183a5b8a1805b978",
  problemHash: "f2a022caf29b329c89eeca438f41e4eae241b96e1adf5d875cafd311694009bc",
  solutionHash: "a2b0b1d9233085b318b706886de3fc2c646b1d59062d3c111f47c3eee7768ba3",
  bookIds: [132],
  fileIds: [212, 213],
  questionIds: Array.from({ length: 8 }, (_, index) => 3496 + index),
  bookItemIds: Array.from({ length: 16 }, (_, index) => 7522 + index),
  newKeys: [],
  newQuestions: [],
}, {
  entryId: "ebsi:5853840",
  entryToken: "2403d5972169741402cfa88f",
  oldReceiptSha256: "0fae2fbecc638343c1114941b5b47dfaf4e263b131d0031c70f2b2f6c6f541b1",
  receiptCoreSha256: "0fae2fbecc638343c1114941b5b47dfaf4e263b131d0031c70f2b2f6c6f541b1",
  beforeProjectionHash: "ccef6c3c3c7d36518ea94ad3194c0dbeb4a2bf6e5de896b63d18ab68ae14ac29",
  afterProjectionHash: "30066ee1a85339ac56a8138eee4fc242e63adcf6fccc3d9f73d3eb2a1e5fc8f2",
  auditPath: "answer-audit/v5-2e7eafea0245e2bd4c3010014dcb545a9d522eca925dc9559ad79c39c57d5e4b.json",
  auditSha256: "23247b62bb8cd73ec6811b9ca83fafb5e902e1dec0c2f72d8f2603c680edd274",
  effectiveCorpusHash: "36510f73406080403e6e3390ade88751cb1f331d235ae7a0e43e37065a3f0056",
  effectiveSolutionCorpusHash: "7cbd4e026290eb5ce0d754cbfc06feca3021a9bbca62423e761bbea66db3407f",
  problemHash: "eef94fc3a558b2e179cc00850e88cca684fcf7d9294035096827cf65cb26a4a0",
  solutionHash: "a09fce8f9ac25ccddd0cc1e9063727e72c775cfab4d6a166f291af048b4e13c4",
  bookIds: [126],
  fileIds: [200, 201],
  questionIds: [3456, 3457],
  bookItemIds: [7442, 7443, 7444, 7445],
  newKeys: [],
  newQuestions: [],
}, {
  entryId: "ebsi:5853841",
  entryToken: "b9a5b631791efd3ac315db14",
  oldReceiptSha256: "4e51de5bfa4c36dfbd492568ab74aec2fa299bc5c9963e9bfc4834b4ee667924",
  receiptCoreSha256: "a41e194f3a97d961e8d9373d5929f8534f01e343806fd1c8f79c31a1df03f7c3",
  beforeProjectionHash: "ab6c623c34c40c3b85ffe8d6b0ceeb66871d9c9ed9134b7a78e15af46f2285b7",
  afterProjectionHash: "7587b029267f704451aa589b93571f063352a938402fde3b02e9d7905f4f6668",
  auditPath: "answer-audit/v5-46f338e39964d10b4e5ba7f8c26d6a446d204b47fd81f3d64892cf462dc3fa61.json",
  auditSha256: "87567256c9e99282a5fbe647c4624abd845dcf395eb86e4923aaf7bf7a3267b0",
  effectiveCorpusHash: "4eff7358fb4f9f359a32aeaf856cd5518ee72219b9eda18e2d41af9768ba276a",
  effectiveSolutionCorpusHash: "5967dcada1beb47da8d90019fe29d1f2f90baedf910118f750321b6876a0e6a4",
  problemHash: "53e401826a43c96502b8ab0fed60de7becba1391200e9bbc6243b243a601b338",
  solutionHash: "344fff565c07ade4332eccd48d9c37daf31a2ee4d627a3d973fa7d6902b540fd",
  bookIds: [124],
  fileIds: [196, 197],
  questionIds: Array.from({ length: 8 }, (_, index) => 3443 + index),
  bookItemIds: Array.from({ length: 16 }, (_, index) => 7416 + index),
  newKeys: ["1:2"],
  newQuestions: [{
    key: "1:2",
    targetSubject: "수학 - 수학Ⅰ·대수" as TargetSubject,
    qtype: "mcq",
    difficulty: "하",
    question: "$\\sqrt{4}\\times\\sqrt[3]{8}$의 값은? [2점]",
    answer: "①",
    solutionPage: 1,
  }],
}, {
  entryId: "ebsi:5642949",
  entryToken: "a777002f3e815de129348383",
  oldReceiptSha256: "a897739814592a03661aa604da1436da727a2f937cad425f0a1e00d039f41499",
  receiptCoreSha256: "a897739814592a03661aa604da1436da727a2f937cad425f0a1e00d039f41499",
  beforeProjectionHash: "2ebee889e0f9a5bdf3bc5335fc0ead3703f3f11b1e2e47fd52e0c3bec09a6991",
  afterProjectionHash: "8b6f769c8977229721347c102733627745767d70063f256d5ebb2fe2f1e1f250",
  auditPath: "answer-audit/v5-8223edc254c50dca911ba3afcc74a023cdf764789d0dcacb2087acae6561f6d7.json",
  auditSha256: "b334628f628f14c6a96775604b3cd5614cb4a3584f40cf9aeeb76386684feed2",
  effectiveCorpusHash: "7fe237c97c08d2b4b1b843bbd6929494950c5f86cbdbd1868a5fa84ad0e0cf5f",
  effectiveSolutionCorpusHash: "36119a94ea7a88488bec11aea721261c5e651a348ab16fa3230fe44f5fdb1be9",
  problemHash: "3ee1ec7ba2d151a4d9902e00ce3ce3083f855f2a3bb5238213678cd668d1b9ad",
  solutionHash: "d0a6c187bb3ab7f135f24da4f3b671cea4dab281fd730abac2f764e26fe0d6df",
  bookIds: [86],
  fileIds: [120, 121],
  questionIds: [3061, 3062],
  bookItemIds: [6652, 6653, 6654, 6655],
  newKeys: [],
  newQuestions: [],
}, {
  entryId: "ebsi:5642950",
  entryToken: "40d2fdfdcdf6646b4adab9b5",
  oldReceiptSha256: "981e5b3a91a29a74751fe97530c66a56dbc73477c355428de03d83bfbf9004a9",
  receiptCoreSha256: "981e5b3a91a29a74751fe97530c66a56dbc73477c355428de03d83bfbf9004a9",
  beforeProjectionHash: "3e7aaaa7107bdaf9e076aae27d4df53bb3c3939fdf9540b1803eacb250944937",
  afterProjectionHash: "f3425376c1e51f0575e1bc6009edf8d48b07ce23af5f4809a6e66e0120d96b33",
  auditPath: "answer-audit/v5-7f21f1c1316d827d0524ef08933b19f00a8b7830eede5f72031ee28f1aa74057.json",
  auditSha256: "0a32d159167fc99ff046df94c95f4988ad7f86ff93b0a6b47b1aaaeba432fdeb",
  effectiveCorpusHash: "3572a1ac0f928d2ffd5ff5155b5068c4879bd7a818c108c56a7f9f78b3fd9448",
  effectiveSolutionCorpusHash: "f5c6997d6df4e450c9024ce9b5af1cae768b8fab4102274144c9881fb4a79c98",
  problemHash: "8d1f7115c9580291d0b14bd3f6979148f235abbdb64b350151310b635b69b3ec",
  solutionHash: "a6b0ff149e9ae7cd137f0e6ad3670596f2ae6c78baaf5db68163700db511724d",
  bookIds: [84, 85],
  fileIds: [116, 117, 118, 119],
  questionIds: Array.from({ length: 12 }, (_, index) => 3049 + index),
  bookItemIds: Array.from({ length: 24 }, (_, index) => 6628 + index),
  newKeys: [],
  newQuestions: [],
}, {
  entryId: "ebsi:5734413",
  entryToken: "b43e38e9dede643a532780cc",
  oldReceiptSha256: "d73c2e712fbb9ccb9a4e6e1e8a7e903805b9bd98490822d67311dae50bf3f7e6",
  receiptCoreSha256: "d73c2e712fbb9ccb9a4e6e1e8a7e903805b9bd98490822d67311dae50bf3f7e6",
  beforeProjectionHash: "8f5e2071cc49d696ec04506774a702fcaf86c3b29bd7053a01c8c4a6a398c2aa",
  afterProjectionHash: "cfc32af3a65c21749b53dc1ca1e8ac85233a9387bb5f5b607269e655ae39d425",
  auditPath: "answer-audit/v5-49c77cd436548153820210e7b9721f87233ea39fc2dd7ecd84bc3e828984766e.json",
  auditSha256: "0552a6724cfea922fc30bf35e1b53ba3b07e3fc5fe04609126856c40ba73fc54",
  effectiveCorpusHash: "77f8e8cfaa200a8d65484afc6502b72bd4f4ec3779a0653e6297d01443465dbb",
  effectiveSolutionCorpusHash: "2864d143944341c5743595a800e695fce1742d9b7b7dd7bece7fad4c298f5841",
  problemHash: "fe56f902e5b94313234a797421b9a5318833309f08ddea0a41c941f0baebe000",
  solutionHash: "ab58197b6e06e9a247a67a910946823b4d86742089d18a97347d15a7f6ff07c6",
  bookIds: [103, 104],
  fileIds: [154, 155, 156, 157],
  questionIds: Array.from({ length: 12 }, (_, index) => 3228 + index),
  bookItemIds: Array.from({ length: 24 }, (_, index) => 6986 + index),
  newKeys: [],
  newQuestions: [],
}, {
  entryId: "ebsi:5656592",
  entryToken: "c83035d36ef8d2b8f1bfe856",
  oldReceiptSha256: "39a7e7a753e8c29d9dae9bde1707fc3cab85f6614e21b8d26f46e81873874b7e",
  receiptCoreSha256: "39a7e7a753e8c29d9dae9bde1707fc3cab85f6614e21b8d26f46e81873874b7e",
  beforeProjectionHash: "a3305a7556bb63f334cf825e3ca14007b4a310cbb30e20595dd76d7e6ea7ee88",
  afterProjectionHash: "7e14938c29994f017201b9246298d1f4f3aec79c8b2a98b4e95b1a32e810244f",
  auditPath: "answer-audit/v5-b8e7b69c44cf1cfb5d4527d7d25a9f062db5bdd9ce645244ccc2f46b6acbca7a.json",
  auditSha256: "74ed4b805d9d0055b66e91a805e55cb801fed7b92c86de8e5e07b88aea09c838",
  effectiveCorpusHash: "fd27b3f4d9b4d9224c116326f7f5e9892d58dabf928cfecd838a260c93c14cbf",
  effectiveSolutionCorpusHash: "df8aeef359887dbd10d4d282f70c27aaab1091da0d78d428d0768816db835d58",
  problemHash: "b7c932cdae76d06eb9d2efd1dc52f4f48faa378c47a0c1bf573fe90bf3b88ee1",
  solutionHash: "e29e208c8d8320c0c80bea34e4b738aa5d166d9a9094f1a0f06fefef64c9cd0a",
  bookIds: [130],
  fileIds: [208, 209],
  questionIds: [3487, 3488, 3489, 3490],
  bookItemIds: [7504, 7505, 7506, 7507, 7508, 7509, 7510, 7511],
  newKeys: [],
  newQuestions: [],
}, {
  entryId: "ebsi:5577055",
  entryToken: "b4eeaf53cd6024aa180d1f37",
  oldReceiptSha256: "51f5f9415746cfbc8c87bb20bf691ae66ca15e93e4f1ca31a2746c925988bdec",
  receiptCoreSha256: "51d06f30a79670ee20019ac8ed3911d1fac73070170ca9a53a081213279f5bd2",
  beforeProjectionHash: "f9f8d0c5b200aa6e7147ff9a6f5397b04e95f9e4b59062fae64667676f9c5a3b",
  afterProjectionHash: "2fe1f7dbc05af37cf42099082dd1e80ae5fe3e91500c5ec73590b87800931030",
  auditPath: "answer-audit/v5-393814389a75988dfefa8d34407cb9652bd0700c5e213e1291fc232896047992.json",
  auditSha256: "956737ec5dfb7bd68bfda2e6b50f72b0af7cde55d29fd99b832bcf245234dfc5",
  effectiveCorpusHash: "8e22bc17f58eb8cc8e9138389ec705646ccdbd8a375cd46d52a8a6c33637cafe",
  effectiveSolutionCorpusHash: "ac739fc7566ed2daeb1740af79c518c336c7c1087f3a6414f360e8eeb8bcf84d",
  problemHash: "b4381bc3b831323375b2c4a25319d308185c930be5d2e3b07dfc28e7646a5fde",
  solutionHash: "1753328f4b4360a9d81312d0d1610c7a11063bbefeeb1e1fd286d54c601ec5fa",
  bookIds: [131],
  fileIds: [210, 211],
  questionIds: [3491, 3492, 3493, 3494, 3495],
  bookItemIds: [7512, 7513, 7514, 7515, 7516, 7517, 7518, 7519, 7520, 7521],
  newKeys: ["2:5"],
  newQuestions: [{
    key: "2:5",
    targetSubject: "수학 - 수학Ⅰ·대수" as TargetSubject,
    qtype: "mcq",
    difficulty: "중",
    question: "좌표평면에서 곡선 $y=a^x$을 직선 $y=x$에 대하여 대칭이동한 곡선이 점 $(2,3)$을 지날 때, 양수 $a$의 값은? [3점]",
    answer: "④ $\\sqrt[3]{2}$",
    solutionPage: 1,
  }],
}, {
  entryId: "ebsi:5594500",
  entryToken: "e9fcb8ccb0af1356a50a6de4",
  oldReceiptSha256: "8a5cfda41b88f36a39634f4136314015e582c8b2331413382421b576f42f356d",
  receiptCoreSha256: "8a5cfda41b88f36a39634f4136314015e582c8b2331413382421b576f42f356d",
  beforeProjectionHash: "c32e8d057c4f1b6e1398a8af37910670b6d91cd1bf4bb3c01a259c1063c4e0c6",
  afterProjectionHash: "592e077a4415fc7c8e40ffbc220cc6cd8e0234459c4aaa825d26efe9a7257c13",
  auditPath: "answer-audit/v5-1ea8994dca6c961a78178fa833c1889cc20706d64c81c11f5d8e20048e740a3e.json",
  auditSha256: "beda5895554570baa0f115d85dc68819835cdc1e3076281d2f2f5442a8bbd9dc",
  effectiveCorpusHash: "3afdc2e5f9b32575f91acf4a7d2b6a77198f61c797d2f2694c3131d63b0e7041",
  effectiveSolutionCorpusHash: "979604ac94d4de200ef6ccc48ba4a3f9bdc41efd78547b772d9fa906d64593a7",
  problemHash: "4d630cb1f52019a3d73d04ca377fe43409e34c6acdc8b86b115e4ac77c69366c",
  solutionHash: "d42af5092d32cb18ae589858af7b790df4ab0dd6758cda62d9951241a0d0cdbb",
  bookIds: [72],
  fileIds: [92, 93],
  questionIds: [2946, 2947, 2948],
  bookItemIds: [6422, 6423, 6424, 6425, 6426, 6427],
  newKeys: [],
  newQuestions: [],
}, {
  entryId: "ebsi:5525984",
  entryToken: "7755c70fefaa45f755086e2b",
  oldReceiptSha256: "b6cbf1e1874d3f996b911f0e2f9507855f5155b58b0dc31ad63b7682870fcb0f",
  receiptCoreSha256: "34c59e90557f5aff5b6fc422426a296901d0777b0d533a5d4220b5f4dc9277c1",
  beforeProjectionHash: "2c2a65902b4e0c78d35545f25a36a018a8fb61f6386eb85eef95bb4bc1946fce",
  afterProjectionHash: "74a78e48a28f366787238a8e9d901b73821ac7b4a23889002fc3e844ef2429c8",
  auditPath: "answer-audit/v5-0aa599c8caf9abc8ee2136619658466958350b7a2725b93a9f42437e03140db1.json",
  auditSha256: "a3135634f1f4c115fd284a104a4e8dd529a9b6b536c35c36da784530bff3d9b4",
  effectiveCorpusHash: "1e076c1128fc58f956f12db80716af215f2cedf605c1816acc5e234d0c320021",
  effectiveSolutionCorpusHash: "90a1214067bc39dfd0b3d20fe84bcfde48ab7923334d9d507dbdbb39bebfada9",
  problemHash: "1621eca42821e5feccbb56604249cbcedd8adf6bae6109960f6c790a61c14ec1",
  solutionHash: "a081092a68c797d8ae2d0becd0fd17d551c7d009f208c7ae9f32301a5531c687",
  bookIds: [133, 134],
  fileIds: [214, 215, 216, 217],
  questionIds: [3504, 3505, 3506, 3507, 3508, 3509, 3510, 3511, 3512, 3513, 3514],
  bookItemIds: [
    7538, 7539, 7540, 7541, 7542, 7543, 7544, 7545, 7546, 7547, 7548,
    7549, 7550, 7551, 7552, 7553, 7554, 7555, 7556, 7557, 7558, 7559,
  ],
  newKeys: ["10:25", "7:18"],
  newQuestions: [{
    key: "10:25",
    targetSubject: "수학 - 수학Ⅰ·대수" as TargetSubject,
    qtype: "short",
    difficulty: "하",
    question: "함수 $f(x)=\\dfrac{1}{2}x+2$에 대하여 $\\displaystyle\\sum_{k=1}^{15}f(2k)$의 값을 구하시오. [3점]",
    answer: "150",
    solutionPage: 8,
  }, {
    key: "7:18",
    targetSubject: "수학 - 수학Ⅱ·미적분Ⅰ" as TargetSubject,
    qtype: "mcq",
    difficulty: "중",
    question: "최고차항의 계수가 1인 이차함수 $f(x)$가\n\n" +
      "$$\\lim_{x\\to a}\\frac{f(x)-(x-a)}{f(x)+(x-a)}=\\frac{3}{5}$$\n\n" +
      "을 만족시킨다. 방정식 $f(x)=0$의 두 근을 $\\alpha$, $\\beta$라 할 때, " +
      "$|\\alpha-\\beta|$의 값은? (단, $a$는 상수이다.) [4점]",
    answer: "④",
    solutionPage: 5,
  }],
}, {
  entryId: "ebsi:5594501",
  entryToken: "b395aca2790e257b1487b455",
  oldReceiptSha256: "289407874ab8bef65e817189c07e03d55901aa44bee49deff7b9aa523dd907dc",
  receiptCoreSha256: "289407874ab8bef65e817189c07e03d55901aa44bee49deff7b9aa523dd907dc",
  beforeProjectionHash: "99c8e405ccbd20c1bfbe76c10a67ceef75b8e3d0335e0edf8317525cd2ee0fe0",
  afterProjectionHash: "834e5ab1c8c5db5e4958c49e3487754ee3de10dc3739c6d8ebe121841ca0e434",
  auditPath: "answer-audit/v5-47f3e1d06a7314a79714e1a3e2a3a729d0e0406a17f1d6ca0770f759602dac47.json",
  auditSha256: "1a233022c7ab5d61adc6b5dc4078c5447b6ad8308e24f856f989e0157d1e3aec",
  effectiveCorpusHash: "9899689cf6ebc256fbe32d7898c3cb29d0dabda066799ccbeaaf977c70894d31",
  effectiveSolutionCorpusHash: "223013f3ef086c504c766419d0f94b000276ffca7b791e6c4eb8ffeb1274ba6c",
  problemHash: "1cb11356d6410d0834283b73a3f2fdc6a26035d5639d14424e7118a07b10da87",
  solutionHash: "595dd1c702145071c137e23b6b42d6ccf1189e050cd36510049b08c2f33bff36",
  bookIds: [75, 76],
  fileIds: [98, 99, 100, 101],
  questionIds: [2957, 2958, 2959, 2960, 2961, 2962, 2963, 2964, 2965],
  bookItemIds: [
    6444, 6445, 6446, 6447, 6448, 6449, 6450, 6451, 6452,
    6453, 6454, 6455, 6456, 6457, 6458, 6459, 6460, 6461,
  ],
  newKeys: [],
  newQuestions: [],
}, {
  entryId: "ebsi:5769268",
  entryToken: "bc7655b894a573179fae1c73",
  oldReceiptSha256: "e5ab9b993ac780ffb90d8b5f52bc5234a580e68ba69e7fc8000f072a2319dea6",
  receiptCoreSha256: "e5ab9b993ac780ffb90d8b5f52bc5234a580e68ba69e7fc8000f072a2319dea6",
  beforeProjectionHash: "beff875fcbb5f8b55181fe864243cb84c79bac2c675ad3b1b0cfe11432eff701",
  afterProjectionHash: "22b67b72821fe5099dbd55ef89ce811ba1c7c3f155696e7d82210aa623c2659a",
  auditPath: "answer-audit/v5-f9f193620bfa21a32e82eb243065ab1edf814cef3a2559b7f33028edff6e089e.json",
  auditSha256: "83924d33a5806eaf8df3fc52249f5d0abcf9db83b23c0704b7f44a387b8c9207",
  effectiveCorpusHash: "3f0f4625f5ee5ba0c627c2655ae751e7fdbd334e49143b552b1280b71abbdda6",
  effectiveSolutionCorpusHash: "62281ae18f8a3f54a40bac39ee759f599d713a3843942d7f845a5177d54508cb",
  problemHash: "f0135f70b321bab2825a89c10ac97724d573793578cd2c872aaa342bd2ac179b",
  solutionHash: "bb5b5d03101f67e1f56fe33870def9bd90d91892ed3ef893d9e6c7df4d90aa66",
  bookIds: [108, 109],
  fileIds: [164, 165, 166, 167],
  questionIds: [3272, 3273, 3274, 3275, 3276, 3277, 3278, 3279, 3280, 3281, 3282, 3283, 3284],
  bookItemIds: [
    7074, 7075, 7076, 7077, 7078, 7079, 7080, 7081, 7082, 7083, 7084, 7085, 7086,
    7087, 7088, 7089, 7090, 7091, 7092, 7093, 7094, 7095, 7096, 7097, 7098, 7099,
  ],
  newKeys: [],
  newQuestions: [],
}, {
  entryId: "ebsi:5875877",
  entryToken: "2df36741f509a5d174ef8538",
  oldReceiptSha256: "3f017d124ca92ee3101fc2e79334f57b058b2f00418e2d1e272237b8a38af9ac",
  receiptCoreSha256: "3f017d124ca92ee3101fc2e79334f57b058b2f00418e2d1e272237b8a38af9ac",
  beforeProjectionHash: "8e2516d4771eb9541d85f378f0b3628aa8399417130b72fa5db3017e161e33ff",
  afterProjectionHash: "77d8e9f47fc9e85eb7cdac32f4c7608932c7a25e102893104aaf1ad3aa64af1f",
  auditPath: "answer-audit/v5-756d5760b1711c86280bf2a416b02410f3f9406825b949196dbb9dcc49a1b27a.json",
  auditSha256: "2a8ac363c05b221e3e4b94c6be256363acbc465bd048d8ae979bd7961c311568",
  effectiveCorpusHash: "17ca7ec78753ccaba65a5a5d2c764d467e14c738647f2197ad73d1db7b7cabe5",
  effectiveSolutionCorpusHash: "54d13297d357b94c864b6aab8adb6857f1ed0725760bd3654d74653b50704aa2",
  problemHash: "ff5e3ecc50294464bdab326d6ba9f8d1f8de3a1b77706a80db0ce718b98c1217",
  solutionHash: "0247df4f3d1e2cdad51c5a34db6c811489bd74df70fdb8fa99d4c65439f8fe14",
  bookIds: [125],
  fileIds: [198, 199],
  questionIds: [3451, 3452, 3453, 3454, 3455],
  bookItemIds: [7432, 7433, 7434, 7435, 7436, 7437, 7438, 7439, 7440, 7441],
  newKeys: [],
  newQuestions: [],
}, {
  entryId: "ebsi:5578423",
  entryToken: "a8beae02eaa19479bb277017",
  oldReceiptSha256: "99e7fa9f4461bb3617f15a4d150469a2e07ef44fc1c2e0c1c980d32eaa7aad57",
  receiptCoreSha256: "99e7fa9f4461bb3617f15a4d150469a2e07ef44fc1c2e0c1c980d32eaa7aad57",
  beforeProjectionHash: "23503a537254ebbe86097a178329946a6dd747122fbe67d557403aebe0aacb21",
  afterProjectionHash: "d876cdad3af19a6f91fd9feafac2c7a1ef374596f3fdad6996932ac471e490b0",
  auditPath: "answer-audit/v5-00e94aae43035db62fee1ddb79997058780a54a58b9bcdbe7350ecb36beea814.json",
  auditSha256: "4a1bcc0ca1e5d6f479ba6f316289d1ee4de7a97fd8232d32097446eae4086a87",
  effectiveCorpusHash: "e7533bb091bda78609d51dc886f4e727562e2ac4a0824b04d9bae0bd273a35a9",
  effectiveSolutionCorpusHash: "bd8bf015e9804eb15d00a30de2209f120a712fc93cb9aaafbbce0abec379b21c",
  problemHash: "7b1b90b6152f9a7f83e8ff66753b2afd46efc14637e1535c35ced65ed572f3bb",
  solutionHash: "f1d4889cd62c7266e55db807502756bc9c075abfc9dc79633a101f08713d5ee2",
  bookIds: [60],
  fileIds: [68, 69],
  questionIds: [2843, 2844, 2845, 2846, 2847, 2848, 2849],
  bookItemIds: [6216, 6217, 6218, 6219, 6220, 6221, 6222, 6223, 6224, 6225, 6226, 6227, 6228, 6229],
  newKeys: [],
  newQuestions: [],
}, {
  entryId: "ebsi:5772823",
  entryToken: "a6e8dc7eae6679300d9e03e2",
  oldReceiptSha256: "a8371657db6c96eeb34b80740272a6a8d8ae47c464725dc138246bbf2bb64a2f",
  receiptCoreSha256: "a8371657db6c96eeb34b80740272a6a8d8ae47c464725dc138246bbf2bb64a2f",
  beforeProjectionHash: "7d0a1b53be88801b1c2a2daf2c950799c5ac9f436c4142e685d64f69766d53e0",
  afterProjectionHash: "f72f894947f3fc73d13b6055bda0beafd2f4a78a8c8b8c3c5575fefca2fb1529",
  auditPath: "answer-audit/v5-68667b82446fce986db92d3c24be32331e0127efa1c584ad1475430f2cdd10ea.json",
  auditSha256: "6ce9b35df28f12176b6febab2ac106e1489a1c7aa6ccfb453cb683b6d3d47007",
  effectiveCorpusHash: "36b1b542ad89e681cd360877aa6279660dd1cd2863495ee806965096ca77386c",
  effectiveSolutionCorpusHash: "6cee9490549baedb11a4788c4ead58d4990dc89c63562a6146790ea168e3d83e",
  problemHash: "4c43873d3ee9d4daec707286d92db505918b75f9d03f0b84f7c076b646809a0a",
  solutionHash: "a32e75ae0b54c72c5d1ce1aaf2ce9b05d74c88ab9f2756b65367f31f6223c863",
  bookIds: [110, 111],
  fileIds: [168, 169, 170, 171],
  questionIds: [3285, 3286, 3287, 3288, 3289, 3290, 3291, 3292, 3293, 3294, 3295, 3296, 3297, 3298, 3299, 3300, 3301],
  bookItemIds: [
    7100, 7101, 7102, 7103, 7104, 7105, 7106, 7107, 7108, 7109, 7110, 7111, 7112, 7113,
    7114, 7115, 7116, 7117, 7118, 7119, 7120, 7121, 7122, 7123, 7124, 7125, 7126, 7127,
    7128, 7129, 7130, 7131, 7132, 7133,
  ],
  newKeys: [],
  newQuestions: [],
}] as const;

const EXISTING_MIGRATION_HISTORICAL_RECOVERY = {
  entryId: "ebsi:5578423",
  entryToken: "a8beae02eaa19479bb277017",
  key: "5:14",
  sourceHash: "7b1b90b6152f9a7f83e8ff66753b2afd46efc14637e1535c35ced65ed572f3bb",
  currentAudit: {
    path: "answer-audit/v5-00e94aae43035db62fee1ddb79997058780a54a58b9bcdbe7350ecb36beea814.json",
    sha256: "4a1bcc0ca1e5d6f479ba6f316289d1ee4de7a97fd8232d32097446eae4086a87",
    digest: "00e94aae43035db62fee1ddb79997058780a54a58b9bcdbe7350ecb36beea814",
    effectiveCorpusHash: "e7533bb091bda78609d51dc886f4e727562e2ac4a0824b04d9bae0bd273a35a9",
    effectiveSolutionCorpusHash: "bd8bf015e9804eb15d00a30de2209f120a712fc93cb9aaafbbce0abec379b21c",
    repairHash: "586755438bb766e88f55570c95ab77ae34283a987637998695ec65a583bbaa5c",
    revisionProblemArtifact: {
      path: "problem-revision-batches/" +
        "v1-0001-0012-0005-c95393fd12b3dd309dc104f8eef18cc0fcd2450c80afb9e7935ad016aa30435b.json",
      sha256: "b4d0678a23fccb09886c94de0de48299383271642bf29b1d5246b55973389097",
    },
    revisionClassificationArtifact: {
      path: "classification-revision-batches/" +
        "v1-0001-0012-e7b8a7bced05c225c663a08ecdd1cf123c0982a515f60a7546698050919595e2-" +
        "7bb7cb863c8c4855.json",
      sha256: "cb7cc97c0a994c053d7e6e0c9e802892a9126f9863a9109c45c55d01a9859d6a",
    },
  },
  historicalAudit: {
    path: "answer-audit/v5-841e6f0d22d791454ff7d37e9e702d22c981136e1408f3ef4d3af8f15213f56c.json",
    sha256: "36ca283c14f6db268c370ce0158605c2a997aab42fa2f03dccb910ddf8d5c358",
    digest: "841e6f0d22d791454ff7d37e9e702d22c981136e1408f3ef4d3af8f15213f56c",
    effectiveCorpusHash: "3f5b099d16bd0e97a5366817a187941ce9ad6343b9f58f0dd5e0083cbcece934",
    effectiveSolutionCorpusHash: "3f261d33e581a757910f4d1adcc55fdfce18b99e06f6f028cdbc7455df80a859",
    repairHash: "f9238416ca49a14e07534d93b3eae342c54b5d7d72260f67f0259d5787e94bfc",
    finalTerminal: {
      path: "problem-terminal-fidelity/" +
        "v2-0000-3f5b099d16bd0e97a5366817a187941ce9ad6343b9f58f0dd5e0083cbcece934-" +
        "63d77badb25e691a60b69459dc4f3cae5060dd694b4eb0220e6af1db2e8123a7.json",
      sha256: "edd12ebc9714abfe9f7a6fcf02e0125c9f5fd365930f840ca6d5c4ef60319d52",
      from: 1,
      to: 12,
      ownedFrom: 1,
      ownedTo: 12,
      inputHash: "63d77badb25e691a60b69459dc4f3cae5060dd694b4eb0220e6af1db2e8123a7",
      itemHash: "3be84dba08e27771c13278957d72adadbb5ad53ff02679a394a940504e8ad99f",
    },
  },
  problemRecoveryArtifact: {
    path: "problem-recoveries/" +
      "v2-0005-0014-128751e9a46e78da7afa65f5cff3c679d694a9704a06fa91c1194f375cfddb3d.json",
    sha256: "8b4673ef9d05cfd74f5f12e21a4940e1f49ed76e54b2d381041f74f866bf63dc",
  },
  classificationRecoveryArtifact: {
    path: "classification-recoveries/" +
      "v2-0005-0014-5a76003ddc1f99328f3680768b909e18fbf007f9129950ca31c5d3641463708b-" +
      "7bb7cb863c8c4855.json",
    sha256: "797c19d7909901cc90701c976e82a97ffccb4853d286575b915ab1462b31462f",
  },
} as const;

export function existingCorpusMigrationAllowlistFingerprint(): string {
  return canonicalEvidenceHash(EXISTING_MIGRATION_ALLOWLIST);
}

function assertMigrationKeys(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const row = object(value, label);
  if (!isDeepStrictEqual(Object.keys(row).sort(), [...keys].sort())) {
    throw new Error(`${label} has unexpected fields`);
  }
  return row;
}

function migrationHash(value: unknown, label: string): string {
  const digest = exactString(value, label);
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error(`${label} is not a SHA-256 digest`);
  return digest;
}

function migrationIntegerArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const values = value.map((item, index) => integer(item, `${label}[${index}]`));
  if (new Set(values).size !== values.length || !isDeepStrictEqual(values, [...values].sort((a, b) => a - b))) {
    throw new Error(`${label} must be unique and sorted`);
  }
  return values;
}

function migrationRows(value: unknown, label: string): MigrationRow[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const rows = value.map((item, index) => {
    const row = object(item, `${label}[${index}]`) as MigrationRow;
    integer(row.id, `${label}[${index}].id`, 1);
    return row;
  });
  if (new Set(rows.map((row) => row.id)).size !== rows.length
    || !isDeepStrictEqual(rows.map((row) => row.id), rows.map((row) => row.id).sort((a, b) => a - b))) {
    throw new Error(`${label} IDs must be unique and sorted`);
  }
  return rows;
}

function migrationProjection(value: unknown, label: string): OwnedMigrationProjection {
  const row = assertMigrationKeys(value, ["books", "files", "questions", "items", "guards"], label);
  const guards = assertMigrationKeys(
    row.guards,
    ["attempts", "materials", "bookExtractionChunks", "materialExtractionChunks"],
    `${label}.guards`,
  );
  const projection: OwnedMigrationProjection = {
    books: migrationRows(row.books, `${label}.books`),
    files: migrationRows(row.files, `${label}.files`),
    questions: migrationRows(row.questions, `${label}.questions`),
    items: migrationRows(row.items, `${label}.items`),
    guards: {
      attempts: integer(guards.attempts, `${label}.guards.attempts`),
      materials: integer(guards.materials, `${label}.guards.materials`),
      bookExtractionChunks: integer(guards.bookExtractionChunks, `${label}.guards.bookExtractionChunks`),
      materialExtractionChunks: integer(guards.materialExtractionChunks, `${label}.guards.materialExtractionChunks`),
    },
  };
  for (const question of projection.questions) {
    if (!isDeepStrictEqual(Object.keys(question).sort(), [...MIGRATION_QUESTION_COLUMNS].sort())) {
      throw new Error(`${label} question ${question.id} column set is invalid`);
    }
  }
  for (const item of projection.items) {
    if (!isDeepStrictEqual(Object.keys(item).sort(), [...MIGRATION_ITEM_COLUMNS].sort())) {
      throw new Error(`${label} item ${item.id} column set is invalid`);
    }
  }
  return projection;
}

function ownedMigrationProjectionHash(value: OwnedMigrationProjection | MigrationProjection): string {
  const { sequences: _sequences, ...owned } = value as MigrationProjection;
  return canonicalEvidenceHash(owned);
}

function stableMigrationProjectionHash(value: OwnedMigrationProjection): string {
  return canonicalEvidenceHash({
    books: value.books,
    files: value.files.map((row) => ({
      id: row.id,
      book_id: row.book_id,
      name: row.name,
      r2_key: row.r2_key,
      mime: row.mime,
      created_at: row.created_at,
      content_hash: row.content_hash,
      page_count: row.page_count,
    })),
    questions: value.questions.map((row) => ({
      id: row.id,
      created_at: row.created_at,
      ...Object.fromEntries(MIGRATION_QUESTION_MUTABLE_COLUMNS.map((column) => [column, row[column]])),
    })),
    items: value.items,
  });
}

function migrationQuestionKey(row: MigrationRow): string {
  const page = integer(row.src_page, `migration question ${row.id}.src_page`, 1);
  const number = Number(row.printed_number);
  if (!Number.isSafeInteger(number) || number < 1 || String(number) !== String(row.printed_number)) {
    throw new Error(`migration question ${row.id} printed_number is invalid`);
  }
  return `${page}:${number}`;
}

function assertMigrationOperationColumns(
  before: MigrationRow,
  after: MigrationRow,
  mutable: readonly string[],
  label: string,
): void {
  if (!isDeepStrictEqual(Object.keys(before).sort(), Object.keys(after).sort())) {
    throw new Error(`${label} column set changed`);
  }
  const allowed = new Set(mutable);
  for (const key of Object.keys(before)) {
    if (!allowed.has(key) && !isDeepStrictEqual(before[key], after[key])) {
      throw new Error(`${label} changed immutable column ${key}`);
    }
  }
}

function applyMigrationOperations(
  before: OwnedMigrationProjection,
  operations: MigrationOperations,
): OwnedMigrationProjection {
  const questions = new Map(before.questions.map((row) => [row.id, row]));
  const items = new Map(before.items.map((row) => [row.id, row]));
  for (const operation of operations.questionUpdates) {
    const current = questions.get(operation.id);
    if (!current || !isDeepStrictEqual(current, operation.before) || operation.after.id !== operation.id) {
      throw new Error(`migration question update ${operation.id} parent mismatch`);
    }
    assertMigrationOperationColumns(operation.before, operation.after, MIGRATION_QUESTION_MUTABLE_COLUMNS,
      `migration question update ${operation.id}`);
    questions.set(operation.id, operation.after);
  }
  for (const operation of operations.questionInserts) {
    if (questions.has(operation.after.id)) throw new Error(`migration duplicate question insert ${operation.after.id}`);
    questions.set(operation.after.id, operation.after);
  }
  for (const operation of operations.itemUpdates) {
    const current = items.get(operation.id);
    if (!current || !isDeepStrictEqual(current, operation.before) || operation.after.id !== operation.id) {
      throw new Error(`migration item update ${operation.id} parent mismatch`);
    }
    assertMigrationOperationColumns(operation.before, operation.after, [
      "book_id", "file_id", "category", "number", "answer", "content", "page", "has_figure", "figure_box",
    ], `migration item update ${operation.id}`);
    items.set(operation.id, operation.after);
  }
  for (const operation of operations.itemInserts) {
    if (items.has(operation.after.id)) throw new Error(`migration duplicate item insert ${operation.after.id}`);
    items.set(operation.after.id, operation.after);
  }
  return {
    books: before.books,
    files: before.files,
    questions: [...questions.values()].sort((left, right) => left.id - right.id),
    items: [...items.values()].sort((left, right) => left.id - right.id),
    guards: before.guards,
  };
}

function readCanonicalMigrationJson(path: string, label: string): { value: Record<string, unknown>; sha256: string } {
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  const bytes = readFileSync(path, "utf8");
  const value = object(JSON.parse(bytes), label);
  if (bytes !== canonicalJson(value)) throw new Error(`${label} is not canonical JSON`);
  return { value, sha256: sha256(bytes) };
}

function migrationArtifacts(
  stateDir: string,
  directoryName: "receipt-history" | "migration-plans" | "migration-commits",
  pattern: RegExp,
): Array<{ name: string; path: string; value: Record<string, unknown>; sha256: string }> {
  const directory = join(stateDir, directoryName);
  if (!existsSync(directory)) return [];
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()
    || !realpathSync(directory).startsWith(`${realpathSync(stateDir)}/`)) {
    throw new Error(`${directoryName} must be a confined regular directory`);
  }
  return readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      const temp = entry.name.endsWith(".tmp") || entry.name.includes(".tmp.");
      if (temp) {
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`${directoryName} temp is not a regular file`);
        return [];
      }
      if (!entry.isFile() || entry.isSymbolicLink() || !pattern.test(entry.name)) {
        throw new Error(`${directoryName} contains malformed or non-file artifact ${entry.name}`);
      }
      return [{ name: entry.name, path, ...readCanonicalMigrationJson(path, `${directoryName}/${entry.name}`) }];
    });
}

function migrationOperations(value: unknown): MigrationOperations {
  const row = assertMigrationKeys(
    value,
    ["questionUpdates", "questionInserts", "itemUpdates", "itemInserts"],
    "migration operations",
  );
  const updates = (raw: unknown, label: string) => {
    if (!Array.isArray(raw)) throw new Error(`${label} must be an array`);
    return raw.map((item, index) => {
      const operation = assertMigrationKeys(item, ["id", "before", "after"], `${label}[${index}]`);
      const before = object(operation.before, `${label}[${index}].before`) as MigrationRow;
      const after = object(operation.after, `${label}[${index}].after`) as MigrationRow;
      const id = integer(operation.id, `${label}[${index}].id`, 1);
      if (before.id !== id || after.id !== id) throw new Error(`${label}[${index}] ID mismatch`);
      return { id, before, after };
    });
  };
  const inserts = (raw: unknown, label: string) => {
    if (!Array.isArray(raw)) throw new Error(`${label} must be an array`);
    return raw.map((item, index) => {
      const operation = assertMigrationKeys(item, ["after"], `${label}[${index}]`);
      return { after: object(operation.after, `${label}[${index}].after`) as MigrationRow };
    });
  };
  return {
    questionUpdates: updates(row.questionUpdates, "migration questionUpdates"),
    questionInserts: inserts(row.questionInserts, "migration questionInserts"),
    itemUpdates: updates(row.itemUpdates, "migration itemUpdates"),
    itemInserts: inserts(row.itemInserts, "migration itemInserts"),
  };
}

function parseExistingMigrationPlan(value: Record<string, unknown>, entry: ManifestEntry): ExistingMigrationPlan {
  assertMigrationKeys(value, ["version", "basisDigest", "identity", "finalReceipt", "backup"], "migration plan");
  const identityRaw = assertMigrationKeys(value.identity, [
    "entryId", "entryRaw", "entryRawHash", "oldReceipt", "receiptCore", "receiptHistory", "answerAudit",
    "problemHash", "solutionHash", "ownership", "beforeProjectionHash", "afterProjectionHash",
    "stableAfterProjectionHash", "beforeSequences", "afterSequences", "beforeProjection", "afterProjection",
    "operations", "backup",
  ], "migration identity");
  const oldReceipt = assertMigrationKeys(identityRaw.oldReceipt, ["path", "sha256", "value"], "migration old receipt");
  const receiptCore = assertMigrationKeys(identityRaw.receiptCore, ["sha256", "value"], "migration receipt core");
  const receiptHistory = evidencePointer(identityRaw.receiptHistory, "migration receipt history pointer");
  const answerAuditRaw = assertMigrationKeys(identityRaw.answerAudit,
    ["path", "sha256", "effectiveCorpusHash", "effectiveSolutionCorpusHash"], "migration answer audit");
  const answerAuditPointer = evidencePointer(
    { path: answerAuditRaw.path, sha256: answerAuditRaw.sha256 }, "migration answer audit pointer",
  );
  const ownershipRaw = assertMigrationKeys(identityRaw.ownership, [
    "bookIds", "fileIds", "beforeQuestionIds", "afterQuestionIds", "beforeBookItemIds", "afterBookItemIds",
  ], "migration ownership");
  const beforeSequencesRaw = assertMigrationKeys(identityRaw.beforeSequences,
    ["questions", "bookItems"], "migration before sequences");
  const afterSequencesRaw = assertMigrationKeys(identityRaw.afterSequences,
    ["questions", "bookItems"], "migration after sequences");
  const identityBackup = assertMigrationKeys(identityRaw.backup, ["sha256", "bytes"], "migration identity backup");
  const finalReceiptRaw = assertMigrationKeys(value.finalReceipt, ["path", "sha256", "value"], "migration final receipt");
  const backupRaw = assertMigrationKeys(value.backup, ["path", "sha256", "bytes"], "migration backup");
  const beforeProjection = migrationProjection(identityRaw.beforeProjection, "migration before projection");
  const afterProjection = migrationProjection(identityRaw.afterProjection, "migration after projection");
  const operations = migrationOperations(identityRaw.operations);
  const plan = {
    version: integer(value.version, "migration plan.version", 1),
    basisDigest: migrationHash(value.basisDigest, "migration plan.basisDigest"),
    identity: {
      entryId: exactString(identityRaw.entryId, "migration identity.entryId"),
      entryRaw: identityRaw.entryRaw,
      entryRawHash: migrationHash(identityRaw.entryRawHash, "migration identity.entryRawHash"),
      oldReceipt: {
        path: exactString(oldReceipt.path, "migration old receipt.path") as "receipt.json",
        sha256: migrationHash(oldReceipt.sha256, "migration old receipt.sha256"),
        value: oldReceipt.value,
      },
      receiptCore: {
        sha256: migrationHash(receiptCore.sha256, "migration receipt core.sha256"),
        value: receiptCore.value,
      },
      receiptHistory,
      answerAudit: {
        ...answerAuditPointer,
        effectiveCorpusHash: migrationHash(answerAuditRaw.effectiveCorpusHash, "migration effectiveCorpusHash"),
        effectiveSolutionCorpusHash: migrationHash(
          answerAuditRaw.effectiveSolutionCorpusHash, "migration effectiveSolutionCorpusHash",
        ),
      },
      problemHash: migrationHash(identityRaw.problemHash, "migration problemHash"),
      solutionHash: migrationHash(identityRaw.solutionHash, "migration solutionHash"),
      ownership: {
        bookIds: migrationIntegerArray(ownershipRaw.bookIds, "migration ownership.bookIds"),
        fileIds: migrationIntegerArray(ownershipRaw.fileIds, "migration ownership.fileIds"),
        beforeQuestionIds: migrationIntegerArray(ownershipRaw.beforeQuestionIds, "migration ownership.beforeQuestionIds"),
        afterQuestionIds: migrationIntegerArray(ownershipRaw.afterQuestionIds, "migration ownership.afterQuestionIds"),
        beforeBookItemIds: migrationIntegerArray(ownershipRaw.beforeBookItemIds, "migration ownership.beforeBookItemIds"),
        afterBookItemIds: migrationIntegerArray(ownershipRaw.afterBookItemIds, "migration ownership.afterBookItemIds"),
      },
      beforeProjectionHash: migrationHash(identityRaw.beforeProjectionHash, "migration beforeProjectionHash"),
      afterProjectionHash: migrationHash(identityRaw.afterProjectionHash, "migration afterProjectionHash"),
      stableAfterProjectionHash: migrationHash(
        identityRaw.stableAfterProjectionHash, "migration stableAfterProjectionHash",
      ),
      beforeSequences: {
        questions: integer(beforeSequencesRaw.questions, "migration beforeSequences.questions"),
        bookItems: integer(beforeSequencesRaw.bookItems, "migration beforeSequences.bookItems"),
      },
      afterSequences: {
        questions: integer(afterSequencesRaw.questions, "migration afterSequences.questions"),
        bookItems: integer(afterSequencesRaw.bookItems, "migration afterSequences.bookItems"),
      },
      beforeProjection,
      afterProjection,
      operations,
      backup: {
        sha256: migrationHash(identityBackup.sha256, "migration identity backup.sha256"),
        bytes: integer(identityBackup.bytes, "migration identity backup.bytes", 1),
      },
    },
    finalReceipt: {
      path: exactString(finalReceiptRaw.path, "migration finalReceipt.path") as "receipt.json",
      sha256: migrationHash(finalReceiptRaw.sha256, "migration finalReceipt.sha256"),
      value: finalReceiptRaw.value,
    },
    backup: {
      path: exactString(backupRaw.path, "migration backup.path"),
      sha256: migrationHash(backupRaw.sha256, "migration backup.sha256"),
      bytes: integer(backupRaw.bytes, "migration backup.bytes", 1),
    },
  } satisfies ExistingMigrationPlan;

  const spec = EXISTING_MIGRATION_ALLOWLIST.find((candidate) => candidate.entryId === plan.identity.entryId);
  if (!spec || plan.version !== EXISTING_CORPUS_MIGRATION_VERSION || plan.identity.entryId !== entry.id
    || plan.identity.entryRawHash !== canonicalEvidenceHash(plan.identity.entryRaw)
    || !isDeepStrictEqual(plan.identity.entryRaw, entry.raw)
    || plan.basisDigest !== canonicalEvidenceHash(plan.identity)
    || plan.identity.oldReceipt.path !== "receipt.json"
    || plan.identity.oldReceipt.sha256 !== canonicalEvidenceHash(plan.identity.oldReceipt.value)
    || plan.identity.receiptCore.sha256 !== canonicalEvidenceHash(plan.identity.receiptCore.value)
    || plan.identity.receiptHistory.path !== `receipt-history/v1-${plan.identity.oldReceipt.sha256}.json`
    || plan.identity.beforeProjectionHash !== ownedMigrationProjectionHash(beforeProjection)
    || plan.identity.afterProjectionHash !== ownedMigrationProjectionHash(afterProjection)
    || plan.identity.stableAfterProjectionHash !== stableMigrationProjectionHash(afterProjection)
    || !isDeepStrictEqual(plan.identity.backup, { sha256: plan.backup.sha256, bytes: plan.backup.bytes })
    || plan.finalReceipt.path !== "receipt.json" || plan.finalReceipt.sha256 !== canonicalEvidenceHash(plan.finalReceipt.value)
    || plan.identity.beforeSequences.questions > plan.identity.afterSequences.questions
    || plan.identity.beforeSequences.bookItems > plan.identity.afterSequences.bookItems) {
    throw new Error("migration plan identity/hash binding is invalid");
  }
  if (!isDeepStrictEqual(beforeProjection.guards, {
    attempts: 0, materials: 0, bookExtractionChunks: 0, materialExtractionChunks: 0,
  }) || !isDeepStrictEqual(beforeProjection.guards, afterProjection.guards)
    || !isDeepStrictEqual(beforeProjection.books, afterProjection.books)
    || !isDeepStrictEqual(beforeProjection.files, afterProjection.files)) {
    throw new Error("migration historical projection/guards changed outside question/item authority");
  }
  const reconstructed = applyMigrationOperations(beforeProjection, operations);
  if (!isDeepStrictEqual(reconstructed, afterProjection)) {
    throw new Error("migration operations do not reconstruct the NEW projection");
  }
  const sameIds = (actual: number[], expected: readonly number[]) => isDeepStrictEqual(actual, [...expected]);
  const beforeQuestionIds = beforeProjection.questions.map((row) => row.id);
  const beforeItemIds = beforeProjection.items.map((row) => row.id);
  const afterQuestionIds = afterProjection.questions.map((row) => row.id);
  const afterItemIds = afterProjection.items.map((row) => row.id);
  const addedQuestions = afterProjection.questions.filter((row) => !beforeQuestionIds.includes(row.id));
  const addedItems = afterProjection.items.filter((row) => !beforeItemIds.includes(row.id));
  const addedKeys = addedQuestions.map(migrationQuestionKey).sort(compareCorpusQuestionKeys);
  if (plan.identity.entryId !== spec.entryId || entryToken(entry) !== spec.entryToken
    || plan.identity.oldReceipt.sha256 !== spec.oldReceiptSha256
    || plan.identity.receiptCore.sha256 !== spec.receiptCoreSha256
    || plan.identity.beforeProjectionHash !== spec.beforeProjectionHash
    || plan.identity.afterProjectionHash !== spec.afterProjectionHash
    || plan.identity.answerAudit.path !== spec.auditPath || plan.identity.answerAudit.sha256 !== spec.auditSha256
    || plan.identity.answerAudit.effectiveCorpusHash !== spec.effectiveCorpusHash
    || plan.identity.answerAudit.effectiveSolutionCorpusHash !== spec.effectiveSolutionCorpusHash
    || plan.identity.problemHash !== spec.problemHash || plan.identity.solutionHash !== spec.solutionHash
    || !sameIds(plan.identity.ownership.bookIds, spec.bookIds)
    || !sameIds(plan.identity.ownership.fileIds, spec.fileIds)
    || !sameIds(plan.identity.ownership.beforeQuestionIds, spec.questionIds)
    || !sameIds(plan.identity.ownership.beforeBookItemIds, spec.bookItemIds)
    || !sameIds(beforeQuestionIds, spec.questionIds) || !sameIds(beforeItemIds, spec.bookItemIds)
    || !sameIds(plan.identity.ownership.bookIds, beforeProjection.books.map((row) => row.id))
    || !sameIds(plan.identity.ownership.fileIds, beforeProjection.files.map((row) => row.id))
    || !sameIds(plan.identity.ownership.afterQuestionIds, afterQuestionIds)
    || !sameIds(plan.identity.ownership.afterBookItemIds, afterItemIds)
    || !isDeepStrictEqual(addedKeys, [...spec.newKeys].sort(compareCorpusQuestionKeys))) {
    throw new Error("migration plan differs from the exact allowlist");
  }
  const sortedIds = (values: number[]) => [...values].sort((left, right) => left - right);
  if (!isDeepStrictEqual(sortedIds(operations.questionUpdates.map((operation) => operation.id)), beforeQuestionIds)
    || !isDeepStrictEqual(sortedIds(operations.itemUpdates.map((operation) => operation.id)), beforeItemIds)
    || !isDeepStrictEqual(sortedIds(operations.questionInserts.map((operation) => operation.after.id)),
      plan.identity.ownership.afterQuestionIds.filter((id) => !plan.identity.ownership.beforeQuestionIds.includes(id)))
    || !isDeepStrictEqual(sortedIds(operations.itemInserts.map((operation) => operation.after.id)),
      plan.identity.ownership.afterBookItemIds.filter((id) => !plan.identity.ownership.beforeBookItemIds.includes(id)))) {
    throw new Error("migration operation/ownership coverage is invalid");
  }
  if (plan.identity.afterSequences.questions !== Math.max(plan.identity.beforeSequences.questions, ...afterQuestionIds)
    || plan.identity.afterSequences.bookItems !== Math.max(plan.identity.beforeSequences.bookItems, ...afterItemIds)) {
    throw new Error("migration allocator sequence binding is invalid");
  }
  const expectedQuestionInsertIds = Array.from(
    { length: operations.questionInserts.length },
    (_, index) => Math.max(plan.identity.beforeSequences.questions, ...beforeQuestionIds, 0) + index + 1,
  );
  const expectedItemInsertIds = Array.from(
    { length: operations.itemInserts.length },
    (_, index) => Math.max(plan.identity.beforeSequences.bookItems, ...beforeItemIds, 0) + index + 1,
  );
  if (!isDeepStrictEqual(operations.questionInserts.map((operation) => operation.after.id), expectedQuestionInsertIds)
    || !isDeepStrictEqual(operations.itemInserts.map((operation) => operation.after.id), expectedItemInsertIds)) {
    throw new Error("migration inserted IDs do not follow the bound allocator sequence");
  }
  for (const row of addedQuestions) {
    const key = migrationQuestionKey(row);
    const pinned = spec.newQuestions.find((candidate) => candidate.key === key);
    const book = afterProjection.books.find((candidate) => candidate.id === row.book_id);
    const solutions = addedItems.filter((item) => item.book_id === row.book_id
      && item.number === row.printed_number && item.category === "해설");
    if (!pinned || !book || solutions.length !== 1 || book.subject_name !== pinned.targetSubject
      || row.qtype !== pinned.qtype || row.difficulty !== pinned.difficulty || row.question !== pinned.question
      || row.answer !== pinned.answer || solutions[0].page !== pinned.solutionPage) {
      throw new Error(`${key} migration insert differs from its allowlist pin`);
    }
  }
  const receipt = object(plan.finalReceipt.value, "migration final receipt value");
  const migration = assertMigrationKeys(receipt.migration, [
    "version", "previousReceipt", "plan", "oldProjectionHash", "newProjectionHash", "receiptCoreSha256",
  ], "migration receipt envelope");
  const previous = evidencePointer(migration.previousReceipt, "migration receipt previousReceipt");
  const planPointer = assertMigrationKeys(migration.plan, ["path", "basisDigest"], "migration receipt plan");
  const { migration: _migration, ...receiptCoreValue } = receipt;
  if (migration.version !== EXISTING_CORPUS_MIGRATION_VERSION
    || !isDeepStrictEqual(previous, plan.identity.receiptHistory)
    || planPointer.path !== `migration-plans/v1-${plan.basisDigest}.json`
    || planPointer.basisDigest !== plan.basisDigest
    || migration.oldProjectionHash !== plan.identity.beforeProjectionHash
    || migration.newProjectionHash !== plan.identity.afterProjectionHash
    || migration.receiptCoreSha256 !== plan.identity.receiptCore.sha256
    || !isDeepStrictEqual(receiptCoreValue, plan.identity.receiptCore.value)) {
    throw new Error("migration final receipt envelope is invalid");
  }
  if (plan.backup.path !== `backups/exam-corpus-migration-v1-${spec.entryToken}-${plan.basisDigest}.db`) {
    throw new Error("migration backup path is invalid");
  }
  return plan;
}

function sqliteSequence(db: Database.Database, name: string): number {
  const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(name) as { seq?: number } | undefined;
  return Number(row?.seq ?? 0);
}

function readMigrationProjection(db: Database.Database, bookIds: number[]): MigrationProjection {
  const placeholders = bookIds.map(() => "?").join(",");
  const books = db.prepare(
    `SELECT b.*, s.name AS subject_name FROM books b JOIN subjects s ON s.id = b.subject_id `
    + `WHERE b.id IN (${placeholders}) ORDER BY b.id`,
  ).all(...bookIds) as MigrationRow[];
  const files = db.prepare(`SELECT * FROM book_files WHERE book_id IN (${placeholders}) ORDER BY id`)
    .all(...bookIds) as MigrationRow[];
  const questions = db.prepare(`SELECT * FROM questions WHERE book_id IN (${placeholders}) ORDER BY id`)
    .all(...bookIds) as MigrationRow[];
  const items = db.prepare(`SELECT * FROM book_items WHERE book_id IN (${placeholders}) ORDER BY id`)
    .all(...bookIds) as MigrationRow[];
  const questionIds = questions.map((row) => row.id);
  const fileIds = files.map((row) => row.id);
  const questionMarks = questionIds.length ? questionIds.map(() => "?").join(",") : "NULL";
  const fileMarks = fileIds.length ? fileIds.map(() => "?").join(",") : "NULL";
  const count = (sql: string, values: unknown[]) => Number(
    (db.prepare(sql).get(...values) as { count: number }).count,
  );
  const materials = count(`SELECT COUNT(*) AS count FROM materials WHERE book_id IN (${placeholders})`, bookIds);
  return {
    books,
    files,
    questions,
    items,
    guards: {
      attempts: count(`SELECT COUNT(*) AS count FROM question_attempts WHERE question_id IN (${questionMarks})`, questionIds),
      materials,
      bookExtractionChunks: count(
        `SELECT COUNT(*) AS count FROM book_extraction_chunks WHERE file_id IN (${fileMarks})`, fileIds,
      ),
      materialExtractionChunks: materials === 0 ? 0 : count(
        `SELECT COUNT(*) AS count FROM material_extraction_chunks `
        + `WHERE material_id IN (SELECT id FROM materials WHERE book_id IN (${placeholders}))`, bookIds,
      ),
    },
    sequences: {
      questions: sqliteSequence(db, "questions"),
      bookItems: sqliteSequence(db, "book_items"),
    },
  };
}

function verifyMigrationLinkedFiles(dataDir: string, plan: ExistingMigrationPlan): void {
  const root = join(dataDir, "files");
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) {
    throw new Error("migration files root is not a regular directory");
  }
  const realRoot = realpathSync(root);
  for (const row of plan.identity.afterProjection.files) {
    const key = exactString(row.r2_key, `migration file ${row.id}.r2_key`);
    const expectedHash = migrationHash(row.content_hash, `migration file ${row.id}.content_hash`);
    const path = resolve(root, key);
    if (!path.startsWith(`${resolve(root)}/`) || !existsSync(path) || lstatSync(path).isSymbolicLink()
      || !lstatSync(path).isFile() || !realpathSync(path).startsWith(`${realRoot}/`)
      || hashFile(path) !== expectedHash) {
      throw new Error(`migration linked source file ${key} is missing or tampered`);
    }
  }
}

function verifyMigrationBackup(dataDir: string, plan: ExistingMigrationPlan): void {
  const directory = join(dataDir, "backups");
  if (!existsSync(directory) || lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()
    || !realpathSync(directory).startsWith(`${realpathSync(dataDir)}/`)) {
    throw new Error("migration backups directory is invalid");
  }
  const path = join(dataDir, plan.backup.path);
  if (!path.startsWith(`${resolve(dataDir)}/`) || !existsSync(path) || lstatSync(path).isSymbolicLink()
    || !lstatSync(path).isFile() || !realpathSync(path).startsWith(`${realpathSync(directory)}/`)
    || statSync(path).size !== plan.backup.bytes
    || hashFile(path) !== plan.backup.sha256) {
    throw new Error("migration backup artifact is missing or tampered");
  }
  const backup = new Database(path, { readonly: true, fileMustExist: true });
  try {
    backup.pragma("query_only = ON");
    const quick = backup.pragma("quick_check") as Array<{ quick_check: string }>;
    const projection = readMigrationProjection(backup, plan.identity.ownership.bookIds);
    const journal = backup.pragma("journal_mode", { simple: true });
    const projectionHash = ownedMigrationProjectionHash(projection);
    if (quick.length !== 1 || quick[0].quick_check !== "ok" || journal !== "delete"
      || projectionHash !== plan.identity.beforeProjectionHash
      || projection.sequences.questions !== plan.identity.beforeSequences.questions
      || projection.sequences.bookItems !== plan.identity.beforeSequences.bookItems) {
      throw new Error(
        `migration backup DB does not reproduce the OLD state ` +
        `(quick=${JSON.stringify(quick)}, journal=${journal}, projection=${projectionHash}, ` +
        `sequences=${projection.sequences.questions}/${projection.sequences.bookItems})`,
      );
    }
  } finally {
    backup.close();
  }
}

function verifyExistingMigration(
  db: Database.Database,
  dataDir: string,
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  solutionEvidence: DownloadEvidence,
  receipt: Record<string, unknown>,
  answerAudit: VerifiedAnswerAudit,
  declaredBackups: Set<string>,
): void {
  const histories = migrationArtifacts(stateDir, "receipt-history", /^v1-[a-f0-9]{64}\.json$/u);
  const plans = migrationArtifacts(stateDir, "migration-plans", /^v1-[a-f0-9]{64}\.json$/u);
  const commits = migrationArtifacts(stateDir, "migration-commits", /^v1-[a-f0-9]{64}\.json$/u);
  if (receipt.migration === undefined) {
    if (histories.length || plans.length || commits.length) {
      throw new Error("migration artifacts exist without a migration receipt");
    }
    return;
  }
  if (histories.length !== 1 || plans.length !== 1 || commits.length !== 1) {
    throw new Error("migration requires exactly one history, plan, and commit artifact");
  }
  const nameDigest = /^v1-([a-f0-9]{64})\.json$/u.exec(plans[0].name)![1];
  const plan = parseExistingMigrationPlan(plans[0].value, entry);
  if (plan.basisDigest !== nameDigest || plans[0].sha256 !== canonicalEvidenceHash(plan)
    || !isDeepStrictEqual(receipt, plan.finalReceipt.value)
    || canonicalEvidenceHash(receipt) !== plan.finalReceipt.sha256
    || plan.identity.problemHash !== problemEvidence.sha256 || plan.identity.solutionHash !== solutionEvidence.sha256) {
    throw new Error("migration receipt/plan/source binding is invalid");
  }
  const history = histories[0];
  const expectedHistory = {
    version: EXISTING_CORPUS_MIGRATION_VERSION,
    entryId: entry.id,
    receipt: plan.identity.oldReceipt,
  };
  if (history.name !== `v1-${plan.identity.oldReceipt.sha256}.json`
    || history.sha256 !== plan.identity.receiptHistory.sha256
    || plan.identity.receiptHistory.path !== `receipt-history/${history.name}`
    || !isDeepStrictEqual(history.value, expectedHistory)) {
    throw new Error("migration receipt history binding is invalid");
  }
  if (!answerAudit.auditPointer || !answerAudit.attestationPointer
    || !answerAudit.effectiveCorpusHash || !answerAudit.effectiveSolutionCorpusHash
    || !isDeepStrictEqual(plan.identity.answerAudit, {
      ...answerAudit.auditPointer,
      effectiveCorpusHash: answerAudit.effectiveCorpusHash,
      effectiveSolutionCorpusHash: answerAudit.effectiveSolutionCorpusHash,
    })) {
    throw new Error("migration plan does not bind the selected current answer authority");
  }
  verifyMigrationLinkedFiles(dataDir, plan);
  declaredBackups.add(plan.backup.path);
  verifyMigrationBackup(dataDir, plan);
  const live = readMigrationProjection(db, plan.identity.ownership.bookIds);
  const stableHash = stableMigrationProjectionHash(live);
  if (stableHash !== plan.identity.stableAfterProjectionHash) {
    throw new Error("migration live DB stable projection differs from the committed NEW state");
  }
  const commit = commits[0];
  if (commit.name !== `v1-${plan.basisDigest}.json`) throw new Error("migration commit filename is invalid");
  const commitValue = assertMigrationKeys(commit.value, [
    "version", "commitDigest", "entryId", "basisDigest", "plan", "receiptHistory", "backup",
    "dbProjectionHash", "stableDbProjectionHash", "receipt", "answerAttestation",
  ], "migration commit");
  const { version: _version, commitDigest, ...commitBasis } = commitValue;
  const expectedCommitBasis = {
    entryId: entry.id,
    basisDigest: plan.basisDigest,
    plan: { path: `migration-plans/v1-${plan.basisDigest}.json`, sha256: plans[0].sha256 },
    receiptHistory: plan.identity.receiptHistory,
    backup: plan.backup,
    dbProjectionHash: plan.identity.afterProjectionHash,
    stableDbProjectionHash: plan.identity.stableAfterProjectionHash,
    receipt: plan.finalReceipt,
    answerAttestation: answerAudit.attestationPointer,
  };
  if (commitValue.version !== EXISTING_CORPUS_MIGRATION_VERSION
    || migrationHash(commitDigest, "migration commitDigest") !== canonicalEvidenceHash(commitBasis)
    || !isDeepStrictEqual(commitBasis, expectedCommitBasis)
    || commit.sha256 !== canonicalEvidenceHash(commitValue)) {
    throw new Error("migration commit marker is invalid");
  }
}

function verifyNoMigrationArtifacts(stateDir: string): void {
  const count = migrationArtifacts(stateDir, "receipt-history", /^v1-[a-f0-9]{64}\.json$/u).length
    + migrationArtifacts(stateDir, "migration-plans", /^v1-[a-f0-9]{64}\.json$/u).length
    + migrationArtifacts(stateDir, "migration-commits", /^v1-[a-f0-9]{64}\.json$/u).length;
  if (count !== 0) throw new Error("migration artifacts exist without a committed migration receipt");
}

function verifyMigrationBackupCoverage(dataDir: string, declared: Set<string>): void {
  const directory = join(dataDir, "backups");
  if (!existsSync(directory)) {
    if (declared.size) throw new Error("migration backups directory is missing");
    return;
  }
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()
    || !realpathSync(directory).startsWith(`${realpathSync(dataDir)}/`)) {
    throw new Error("migration backups directory is invalid");
  }
  const actual = new Set<string>();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const isTemp = entry.name.startsWith(".") && entry.name.includes(".tmp");
    if (isTemp) {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("migration backup temp is not a regular file");
      continue;
    }
    if (!entry.name.startsWith("exam-corpus-migration-v1-")) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("migration backup is not a regular file");
    actual.add(`backups/${entry.name}`);
  }
  if (!isDeepStrictEqual([...actual].sort(), [...declared].sort())) {
    throw new Error("migration backup coverage has an orphan, duplicate, or missing artifact");
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
    const declaredMigrationBackups = new Set<string>();
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
      if (!receipt) {
        try {
          verifyNoMigrationArtifacts(stateDir);
        } catch (error) {
          add({
            code: "MIGRATION_INVALID",
            entryId: entry.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
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
      try {
        verifyExistingMigration(
          db,
          dataDir,
          stateDir,
          entry,
          problemEvidence,
          solutionEvidence,
          receipt,
          verifiedAudit,
          declaredMigrationBackups,
        );
      } catch (error) {
        add({
          code: "MIGRATION_INVALID",
          entryId: entry.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
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
    try {
      verifyMigrationBackupCoverage(dataDir, declaredMigrationBackups);
    } catch (error) {
      add({ code: "MIGRATION_INVALID", message: error instanceof Error ? error.message : String(error) });
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
