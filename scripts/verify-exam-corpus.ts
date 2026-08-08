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
const SEMANTIC_CHOICE_VERSION = 4;
const LEGACY_ANSWER_SEMANTIC_CHOICE_VERSION = 3;
const LEGACY_FILTERED_SEMANTIC_CHOICE_VERSION = 2;
const SEMANTIC_CHOICE_RULES =
  `For each item, use only its official detailed explanation and answer-choice contents to identify the one ` +
  `choice semantically supported by the reasoning. The official answer marker and the problem extractor's answer ` +
  `are intentionally hidden and must not be guessed; ordinal markers inside explanations are redacted. ` +
  `Return ambiguous when the explanation does not establish ` +
  `exactly one choice. choiceIndex is 1-based and evidence must briefly cite the decisive value or conclusion.`;
const SEMANTIC_CHOICE_PROMPT_DIGEST = sha256(`${SEMANTIC_CHOICE_VERSION}\n${SEMANTIC_CHOICE_RULES}`);
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
const TARGETED_SOLUTION_PROMPT_DIGEST = sha256(
  `${TARGETED_SOLUTION_TRANSCRIPTION_VERSION}\n${TARGETED_SOLUTION_TRANSCRIPTION_RULES}`,
);
const TARGETED_SOLUTION_REVISION_PROMPT_DIGEST = sha256(
  `${TARGETED_SOLUTION_REVISION_VERSION}\n${TARGETED_SOLUTION_REVISION_RULES}\n` +
  `${TARGETED_SOLUTION_REVISION_EVIDENCE_PREFIX}\n` +
  `${TARGETED_SOLUTION_TRANSCRIPTION_VERSION}\n${TARGETED_SOLUTION_TRANSCRIPTION_RULES}`,
);

type VerificationContract = {
  auditVersion: 2 | 3 | 4;
  attestationVersion: 2 | 3 | 4;
  classifierVersion: 4 | 5;
  transcriptionGateVersion: 1 | 2;
  transcriptionPromptDigest: string;
  semanticChoiceVersion: 3 | 4;
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
  semanticChoiceVersion: SEMANTIC_CHOICE_VERSION,
  semanticPromptDigest: SEMANTIC_CHOICE_PROMPT_DIGEST,
  problemTerminalFidelityVersion: LEGACY_PROBLEM_TERMINAL_FIDELITY_VERSION,
  problemTerminalScopePromptDigest: null,
};

const CURRENT_CONTRACT: VerificationContract = {
  ...V3_CONTRACT,
  auditVersion: 4,
  attestationVersion: 4,
  problemTerminalFidelityVersion: PROBLEM_TERMINAL_FIDELITY_VERSION,
  problemTerminalScopePromptDigest: PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST,
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
  const policyInvalid = effective.order.some((key) => {
    const record = effective.records.get(key)!;
    const item = itemByKey.get(key);
    if (!item) return true;
    if (record.classification.transcription_status === "exact") {
      return item.status !== "exact" || (
        contract.problemTerminalFidelityVersion === PROBLEM_TERMINAL_FIDELITY_VERSION
        && record.classification.decision === "accept"
        && (item.scopeDecision !== "accept" || item.scopeConfidence < 0.9)
      );
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
  for (const [index, value] of values.entries()) {
    const repair = object(value, `answer audit repairs[${index}]`);
    if (repair.revision === undefined) continue;
    const revision = object(repair.revision, `answer audit repairs[${index}].revision`);
    if (revision.recovery === undefined) continue;
    if (contract.auditVersion !== 4) throw new Error("problem recovery requires answer audit v4");
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
  }
  for (const [directory, pattern] of [
    ["problem-recoveries", /^v1-\d{4}-\d{4}-[a-f0-9]{64}\.json$/u],
    ["classification-recoveries", /^v1-\d{4}-\d{4}-[a-f0-9]{64}-[a-f0-9]{16}\.json$/u],
  ] as const) {
    for (const name of listJson(join(stateDir, directory), /\.json$/u)) {
      if (!pattern.test(name)) throw new Error(`${directory}/${name}: malformed problem recovery artifact name`);
      const path = `${directory}/${name}`;
      if (!declared.has(path)) throw new Error(`${path}: problem recovery artifact is not declared by the terminal audit`);
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

function verifyProblemRecovery(
  row: V3RevisionRow,
  revisedQuestion: ProblemQuestion,
  revisedClassification: ClassificationEvidence,
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  rulesDigest: string,
  cache: EvidenceCache,
): { classified: ClassifiedEvidence; evidence: Record<string, unknown> } {
  const key = row.first.row.key;
  if (revisedClassification.transcription_status === "exact") {
    throw new Error(`${key}: exact problem revision cannot have a recovery`);
  }
  const recovery = object(row.raw.recovery, `${key}.revision.recovery`);
  const baseProblemRepairArtifact = row.first.row.problemArtifact;
  const baseClassificationRepairArtifact = row.first.row.classificationArtifact;
  const baseProblemRevisionArtifact = row.problemArtifact;
  const baseClassificationRevisionArtifact = row.classificationArtifact;
  const problemBasis = {
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
    failedClassificationEvidenceHash: sha256(revisedClassification.transcription_evidence),
  };
  const basisDigest = canonicalEvidenceHash(problemBasis);
  const problemArtifact = evidencePointer(recovery.problemArtifact, `${key}.recovery.problemArtifact`);
  const expectedProblemPath = `problem-recoveries/v${PROBLEM_RECOVERY_VERSION}-` +
    `${String(row.first.row.sourcePage).padStart(4, "0")}-` +
    `${row.first.row.printedNumber.padStart(4, "0")}-${basisDigest}.json`;
  if (problemArtifact.path !== expectedProblemPath) throw new Error(`${key}: problem recovery path is stale`);
  const problemCheckpoint = readBoundEvidenceCached(cache, stateDir, problemArtifact, expectedProblemPath);
  const recoveredQuestion = parseProblem(problemCheckpoint.item, `${key}.problem recovery.item`);
  const expectedProblemCheckpoint = {
    version: PROBLEM_RECOVERY_VERSION,
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
  const expectedClassificationPath = `classification-recoveries/v${CLASSIFICATION_RECOVERY_VERSION}-` +
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
    version: CLASSIFICATION_RECOVERY_VERSION,
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
  if (!isDeepStrictEqual(classificationCheckpoint, expectedClassificationCheckpoint)
    || recoveredClassification.transcription_status !== "exact") {
    throw new Error(`${key}: classification recovery metadata/content is stale or non-exact`);
  }
  const classificationArtifactItemHash = canonicalEvidenceHash(recoveredClassification);
  const evidence = {
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
    failedClassificationEvidenceHash: problemBasis.failedClassificationEvidenceHash,
    baseQuestionHash: problemBasis.baseQuestionHash,
    effectiveQuestionHash: problemArtifactItemHash,
    baseClassificationHash: problemBasis.baseClassificationHash,
    effectiveClassificationHash: classificationArtifactItemHash,
  };
  if (!isDeepStrictEqual(recovery, evidence)) {
    throw new Error(`${key}: problem recovery evidence envelope does not match its exact chain`);
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
    evidence,
  };
}

function verifyV3RevisionArtifacts(
  rows: V3RevisionRow[],
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  rulesDigest: string,
  cache: EvidenceCache,
): Map<string, { classified: ClassifiedEvidence; evidence: Record<string, unknown> }> {
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

  const result = new Map<string, { classified: ClassifiedEvidence; evidence: Record<string, unknown> }>();
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
        rulesDigest,
        cache,
      );
      if (classification.transcription_status === "exact" && recovery !== null) {
        throw new Error(`${key}: exact problem revision cannot have a recovery`);
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

function verifyV3TerminalTriggerGenerations(
  rows: V3RevisionRow[],
  base: DecisionSummary,
  first: Map<string, V3FirstRepair>,
  classificationRevisions: Map<string, { classified: ClassifiedEvidence }>,
  terminalRevisions: Map<string, { classified: ClassifiedEvidence }>,
  stateDir: string,
  cache: EvidenceCache,
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
      const candidates = (sameGenerationKeys.has(key) ? [sameGenerationCurrent.get(key)] : [
        base.records.get(key),
        first.get(key)?.classified,
        classificationRevisions.get(key)?.classified,
        terminalRevisions.get(key)?.classified,
      ]).filter((value): value is ClassifiedEvidence => value !== undefined)
        .filter((value) => value.classification.transcription_status === "exact");
      const unique = new Map(candidates.map((value) => [canonicalEvidenceHash({
        question: value.question.evidence,
        classification: value.classification,
      }), value]));
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

function applyDeclaredRepairsV3(
  values: unknown[],
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
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
  let classificationRevisionResults = new Map<
    string,
    { classified: ClassifiedEvidence; evidence: Record<string, unknown> }
  >();
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
      rulesDigest,
      cache,
    );
    for (const [key, value] of classificationRevisionResults) records.set(key, value.classified);
  }

  const terminalRevisions = [...first.values()].filter((value) => {
    if (value.row.raw.revision === undefined) return false;
    return object(object(value.row.raw.revision, `${value.row.key}.revision`).trigger,
      `${value.row.key}.revision.trigger`).kind === "terminal";
  });
  let terminalRevisionResults = new Map<
    string,
    { classified: ClassifiedEvidence; evidence: Record<string, unknown> }
  >();
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
      rulesDigest,
      cache,
    );
    verifyV3TerminalTriggerGenerations(
      prepared,
      base,
      first,
      classificationRevisionResults,
      terminalRevisionResults,
      stateDir,
      cache,
    );
    for (const [key, value] of terminalRevisionResults) records.set(key, value.classified);
  }

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
  const expectedSolutionPath = `solution-revisions/v${SOLUTION_REVISION_VERSION}-` +
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
    || revised.page < input.baseContextFrom || revised.page > input.baseContextTo) {
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
  const expectedFidelityPath = `solution-fidelity-revisions/v${SOLUTION_REVISION_FIDELITY_VERSION}-` +
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
  if (!isTerminalSolutionDecision(input, revised, decision)) {
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
    if (trigger.kind !== "fidelity") continue;
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
  if (Object.keys(envelope).sort().join(",") !== "effectiveSolutionCorpusHash,inputHash,path,sha256") {
    throw new Error("semanticCheckpoint has unexpected fields");
  }
  if (envelope.inputHash !== inputHash) throw new Error("semanticCheckpoint input hash does not match marker inputs");
  if (envelope.effectiveSolutionCorpusHash !== effectiveSolutionCorpusHash) {
    throw new Error("semanticCheckpoint effective solution corpus hash is stale");
  }
  const pointer = evidencePointer({ path: envelope.path, sha256: envelope.sha256 }, "semanticCheckpoint");
  const expectedPath = solutionRevisionApplied
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
    if (status === "resolved" ? choiceIndex! > input.choices.length : choiceIndex !== null) {
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

type VerifiedAnswerAudit = { decisions: DecisionSummary; solutions: Map<string, OfficialSolution> };

function selectVerificationContract(
  stateDir: string,
  receipt: Record<string, unknown> | null,
  result: Record<string, unknown> | null,
): VerificationContract {
  if (result?.version === 4) return CURRENT_CONTRACT;
  const v4GenerationSignal = (
    listJson(join(stateDir, "problem-terminal-fidelity"), /^v2-.*\.json$/u).length > 0
    || listJson(join(stateDir, "problem-recoveries"), /\.json$/u).length > 0
    || listJson(join(stateDir, "classification-recoveries"), /\.json$/u).length > 0
    || listJson(join(stateDir, "answer-audit"), /^v4-.*\.json$/u).length > 0
    || listJson(join(stateDir, "answer-attestation"), /^v4-.*\.json$/u).length > 0
  );
  if (v4GenerationSignal) return CURRENT_CONTRACT;
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
      throw new Error("attested effective corpus hash does not match reconstructed corpus");
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
      throw new Error("answer audit metadata/counts/items do not match the effective corpus");
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
    `SELECT id, subject_id, source, qtype, question, choices, answer, explanation, book_id,
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
