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
  TARGETED_PROBLEM_TRANSCRIPTION_RULES,
  TARGETED_PROBLEM_TRANSCRIPTION_VERSION,
  TARGETED_PROBLEM_REVISION_EVIDENCE_PREFIX,
  TARGETED_PROBLEM_REVISION_RULES,
  TARGETED_PROBLEM_REVISION_VERSION,
  TARGETED_SOLUTION_TRANSCRIPTION_RULES,
  TARGETED_SOLUTION_TRANSCRIPTION_VERSION,
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

const CLASSIFIER_VERSION = 4;
const PROBLEM_REPAIR_VERSION = 2;
const CLASSIFICATION_REPAIR_VERSION = 3;
const PROBLEM_REVISION_VERSION = 1;
const CLASSIFICATION_REVISION_VERSION = 1;
const PROBLEM_SLICE_PAGES = 20;
const SOLUTION_SLICE_PAGES = 6;
const SOLUTION_SLICE_STRIDE = 4;
const SOLUTION_FIDELITY_VERSION = 1;
const SOLUTION_FIDELITY_SLICE_PAGES = 22;
const SOLUTION_FIDELITY_SLICE_STRIDE = 18;
const SOLUTION_REPAIR_VERSION = 1;
const SOLUTION_REPAIR_FIDELITY_VERSION = 1;
const TRANSCRIPTION_GATE_VERSION = 1;
const TRANSCRIPTION_GATE_RULES = `
Independently compare every supplied transcription with the attached official source pixels. Check the complete shared passage and source material, the full stem, every answer choice and distractor, inequalities, signs, coefficients, exponents, fractions, formulas, tables, qtype, and all figure or visual dependencies including figure_description. Check that box plausibly covers the source problem and figure, without requiring pixel-perfect crop decimals. Do not infer fidelity from plausibility or from the proposed answer. Base the curriculum decision on the source pixels, not on an inaccurate supplied transcription.

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
const SEMANTIC_CHOICE_VERSION = 3;
const LEGACY_SEMANTIC_CHOICE_VERSION = 2;
const SEMANTIC_CHOICE_RULES =
  `For each item, use only its official detailed explanation and answer-choice contents to identify the one ` +
  `choice semantically supported by the reasoning. The official answer marker and the problem extractor's answer ` +
  `are intentionally hidden and must not be guessed; ordinal markers inside explanations are redacted. ` +
  `Return ambiguous when the explanation does not establish ` +
  `exactly one choice. choiceIndex is 1-based and evidence must briefly cite the decisive value or conclusion.`;
const SEMANTIC_CHOICE_PROMPT_DIGEST = sha256(`${SEMANTIC_CHOICE_VERSION}\n${SEMANTIC_CHOICE_RULES}`);
const LEGACY_SEMANTIC_CHOICE_PROMPT_DIGEST = sha256(
  `${LEGACY_SEMANTIC_CHOICE_VERSION}\n${SEMANTIC_CHOICE_RULES}`,
);
const TARGETED_PROBLEM_PROMPT_DIGEST = sha256(
  `${TARGETED_PROBLEM_TRANSCRIPTION_VERSION}\n${TARGETED_PROBLEM_TRANSCRIPTION_RULES}\n${QUIZ_EXTRACT_SPEC}`,
);
const TARGETED_PROBLEM_REVISION_PROMPT_DIGEST = sha256(
  `${TARGETED_PROBLEM_REVISION_VERSION}\n${TARGETED_PROBLEM_REVISION_RULES}\n` +
  `${TARGETED_PROBLEM_REVISION_EVIDENCE_PREFIX}\n` +
  `${TARGETED_PROBLEM_TRANSCRIPTION_VERSION}\n${TARGETED_PROBLEM_TRANSCRIPTION_RULES}\n${QUIZ_EXTRACT_SPEC}`,
);
const TARGETED_SOLUTION_PROMPT_DIGEST = sha256(
  `${TARGETED_SOLUTION_TRANSCRIPTION_VERSION}\n${TARGETED_SOLUTION_TRANSCRIPTION_RULES}`,
);

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
  const canonical = row.canonical_subject;
  const canonicalSubject = canonical === null ? null : canonical as CanonicalSubject;
  if (canonicalSubject !== null && !(canonicalSubject in TARGET_BY_CANONICAL)) {
    throw new CorpusValidationError("CLASSIFICATION_INVALID", `${key}: invalid canonical subject`);
  }
  const curriculumCourse = row.curriculum_course === null
    ? null
    : exactString(row.curriculum_course, `${label}.curriculum_course`);
  const domain = row.domain === null ? null : exactString(row.domain, `${label}.domain`);
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
  const achievementCodes = [...new Set(row.achievement_codes as string[])];
  const reasonCodes = [...new Set(row.reason_codes as string[])];
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
  } else if (canonicalSubject !== null || curriculumCourse !== null || domain !== null || achievementCodes.length > 0) {
    throw new CorpusValidationError("CLASSIFICATION_INVALID", `${key}: reject/review must not assign a target`);
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
  add: AddFailure,
): DecisionSummary {
  const problemDir = join(stateDir, "problem-chunks");
  const classificationDir = join(stateDir, "classification-chunks");
  const problemFiles = listJson(problemDir, /^v2-\d{4}\.json$/);
  const classificationFiles = listJson(classificationDir, /^v4-\d{4}-[a-f0-9]{16}\.json$/);
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

    const candidates = classificationFiles.filter((name) => name.startsWith(`v${CLASSIFIER_VERSION}-${index}-`));
    const selected = terminalDigest
      ? candidates.find((name) => name === `v4-${index}-${terminalDigest}.json`)
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
        classification.version !== CLASSIFIER_VERSION || classification.sourceHash !== problemEvidence.sha256
        || classification.from !== from || classification.to !== to || classification.rulesDigest !== fileDigest
        || classification.ownedFrom !== checkpoint.ownedFrom || classification.ownedTo !== checkpoint.ownedTo
        || classification.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION
        || classification.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST
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
    || classificationArtifactRow.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION
    || classificationArtifactRow.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST
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
    classifierVersion: CLASSIFIER_VERSION,
    rulesDigest,
    transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
    transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
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
      transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
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
  if (classificationArtifactRow.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION
    || classificationArtifactRow.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST) {
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
    classifierVersion: CLASSIFIER_VERSION,
    rulesDigest,
    transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
    transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
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
      transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
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
  );
  const expectedRevisedRepair = { ...expectedRepair, revision: revised.evidence };
  if (!isDeepStrictEqual(repair, expectedRevisedRepair)) {
    throw new Error(`${key}: repair revision envelope does not match its exact chain`);
  }
  return revised.classified;
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

function verifySolutionFidelity(
  stateDir: string,
  entry: ManifestEntry,
  solutionEvidence: DownloadEvidence,
  rulesDigest: string,
  effective: DecisionSummary,
  baseSolutions: Map<string, OfficialSolution>,
  audit: Record<string, unknown>,
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
      classifierVersion: CLASSIFIER_VERSION,
      rulesDigest,
      transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
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
    sameEvidencePointer(baseFidelityCheckpoint, artifact, `${key}.baseFidelityCheckpoint`);
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
      `${printedNumber.padStart(4, "0")}-${artifact.sha256}.json`;
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
      `${artifact.sha256}-${effectiveSolutionItemHash}.json`;
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
    const terminalAnswer = repairedDecision.answerStatus === "exact"
      || repairedDecision.answerStatus === "not_visible" && input.allowDerivedMarkerAnswer;
    if (repairedDecision.sourcePage !== effectivePage || repairedDecision.explanationStatus !== "exact"
      || !terminalAnswer) {
      throw new Error(`${key}: repaired solution did not reach terminal source fidelity`);
    }
    const expectedRepair = {
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
    if (!isDeepStrictEqual(repair, expectedRepair)) {
      throw new Error(`${key}: solution repair evidence envelope does not match its artifacts`);
    }
    expectedRepairs.push(expectedRepair);
    effectiveSolutions.set(printedNumber, corrected);
    terminalItems.set(key, {
      key,
      printedNumber,
      qtype: input.qtype,
      basePage,
      effectivePage,
      answerStatus: repairedDecision.answerStatus,
      explanationStatus: repairedDecision.explanationStatus,
      evidence: repairedDecision.evidence,
      fidelityArtifact,
      baseSolutionItemHash: input.baseSolutionItemHash,
      effectiveSolutionItemHash,
      baseRawAnswerHash: sha256(input.rawAnswer),
      effectiveRawAnswerHash: sha256(corrected.rawAnswer),
      baseExplanationHash: sha256(input.explanation),
      effectiveExplanationHash: sha256(corrected.explanation),
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
  if (pointer.path !== `semantic-choice-checks/v${SEMANTIC_CHOICE_VERSION}-${inputHash}.json`) {
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
    version: SEMANTIC_CHOICE_VERSION,
    entryId: entry.id,
    problemHash: problemEvidence.sha256,
    solutionHash: solutionEvidence.sha256,
    classifierVersion: CLASSIFIER_VERSION,
    rulesDigest,
    transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
    transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
    effectiveCorpusHash,
    effectiveSolutionCorpusHash,
    inputHash,
    promptDigest: SEMANTIC_CHOICE_PROMPT_DIGEST,
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

function verifyAnswerAudit(
  stateDir: string,
  entry: ManifestEntry,
  problemEvidence: DownloadEvidence,
  solutionEvidence: DownloadEvidence,
  base: DecisionSummary,
  solutions: Map<string, OfficialSolution>,
  terminal: Record<string, unknown>,
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
  const names = listJson(attestationDir, /^v2-[a-f0-9]{64}\.json$/u);
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
        && value.classifierVersion === CLASSIFIER_VERSION
        && value.rulesDigest === rulesDigest
        && value.transcriptionGateVersion === TRANSCRIPTION_GATE_VERSION
        && value.transcriptionPromptDigest === TRANSCRIPTION_PROMPT_DIGEST
        && value.solutionFidelityVersion === SOLUTION_FIDELITY_VERSION
        && value.solutionFidelityPromptDigest === SOLUTION_FIDELITY_PROMPT_DIGEST
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
    if (attestation.version !== 2 || name !== `v2-${attestationDigest}.json`
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
    const auditPathMatch = /^answer-audit\/v2-([a-f0-9]{64})\.json$/u.exec(auditPointer.path);
    if (!auditPathMatch || !/^[a-f0-9]{64}$/u.test(String(auditEnvelope.effectiveCorpusHash))
      || !/^[a-f0-9]{64}$/u.test(String(auditEnvelope.effectiveSolutionCorpusHash))) {
      throw new Error("answer attestation audit path/effective corpus hash is invalid");
    }
    const audit = readBoundEvidence(stateDir, auditPointer, "attested answer audit");
    const auditDigest = exactString(audit.auditDigest, "answer audit.digest");
    if (audit.version !== 2 || auditPathMatch[1] !== auditDigest || !/^[a-f0-9]{64}$/u.test(auditDigest)) {
      throw new Error("answer audit version/name/digest is invalid");
    }
    const { version: _version, auditDigest: _auditDigest, ...auditBasis } = audit;
    if (canonicalEvidenceHash(auditBasis) !== auditDigest) {
      throw new Error("answer audit canonical digest or file hash is invalid");
    }
    if (!Array.isArray(audit.repairs) || !Array.isArray(audit.solutionFidelityCheckpoints)
      || !Array.isArray(audit.solutionFidelityItems) || !Array.isArray(audit.solutionRepairs)) {
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
      classifierVersion: CLASSIFIER_VERSION,
      rulesDigest,
      transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
      solutionFidelityVersion: SOLUTION_FIDELITY_VERSION,
      solutionFidelityPromptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
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
    };
    if (!isDeepStrictEqual(attestationBasis, expectedAttestationBasis)) {
      throw new Error("answer attestation does not exactly bind receipt/audit/repairs");
    }
    const records = new Map(base.records);
    const repairedKeys = new Set<string>();
    for (const rawRepair of audit.repairs) {
      const repair = object(rawRepair, "answer audit repair");
      const key = exactString(repair.key, "answer audit repair.key");
      if (repairedKeys.has(key)) throw new Error(`duplicate declared repair: ${key}`);
      const baseRecord = base.records.get(key);
      const solution = baseRecord && solutions.get(baseRecord.question.printedNumber);
      if (!baseRecord || !solution) throw new Error(`repair has no base problem/solution: ${key}`);
      records.set(key, applyDeclaredRepair(
        repair,
        stateDir,
        entry,
        problemEvidence,
        rulesDigest,
        baseRecord,
        solution,
      ));
      repairedKeys.add(key);
    }
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
    if (nonExact.length > 0) {
      throw new Error(`terminal corpus has non-exact source transcriptions: ${nonExact.join(", ")}`);
    }
    if (auditEnvelope.effectiveCorpusHash !== effectiveCorpusHash) {
      throw new Error("attested effective corpus hash does not match reconstructed corpus");
    }
    const solutionFidelity = verifySolutionFidelity(
      stateDir,
      entry,
      solutionEvidence,
      rulesDigest,
      effective,
      solutions,
      audit,
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
      classifierVersion: CLASSIFIER_VERSION,
      rulesDigest,
      transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
      solutionFidelityVersion: SOLUTION_FIDELITY_VERSION,
      solutionFidelityPromptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
      semanticChoiceVersion: SEMANTIC_CHOICE_VERSION,
      semanticPromptDigest: SEMANTIC_CHOICE_PROMPT_DIGEST,
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
  add: AddFailure,
): DecisionSummary {
  const nonExactBase = base.order.filter((key) =>
    base.records.get(key)!.classification.transcription_status !== "exact");
  if (result.answerAudit === undefined) {
    if (nonExactBase.length > 0) {
      add({
        code: "TRANSCRIPTION_GATE",
        entryId: entry.id,
        message: `filtered result has unverified source transcriptions: ${nonExactBase.join(", ")}`,
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
    const pathMatch = /^answer-audit\/v([12])-([a-f0-9]{64})\.json$/u.exec(pointer.path);
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
    const records = new Map(base.records);
    const repaired = new Set<string>();
    for (const rawRepair of audit.repairs) {
      const repair = object(rawRepair, "filtered answer audit repair");
      const key = exactString(repair.key, "filtered answer audit repair.key");
      if (repaired.has(key)) throw new Error(`duplicate declared repair: ${key}`);
      const baseRecord = base.records.get(key);
      const solution = baseRecord && solutions.get(baseRecord.question.printedNumber);
      if (!baseRecord || !solution) throw new Error(`repair has no base problem/solution: ${key}`);
      records.set(key, applyDeclaredRepair(
        repair,
        stateDir,
        entry,
        problemEvidence,
        rulesDigest,
        baseRecord,
        solution,
      ));
      repaired.add(key);
    }
    const effective = summarizeDecisions(records, base.order, rulesDigest);
    const effectiveCorpusHash = canonicalEvidenceHash(effective.order.map((key) => {
      const record = effective.records.get(key)!;
      return { question: record.question.evidence, classification: record.classification };
    }));
    const nonExact = effective.order.filter((key) =>
      effective.records.get(key)!.classification.transcription_status !== "exact");
    if (nonExact.length > 0) throw new Error(`filtered corpus remains non-exact: ${nonExact.join(", ")}`);
    const expectedBasis = {
      entryId: entry.id,
      problemHash: problemEvidence.sha256,
      solutionHash: solutionEvidence.sha256,
      classifierVersion: CLASSIFIER_VERSION,
      rulesDigest,
      transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
      ...(version === 2 ? {
        solutionFidelityVersion: SOLUTION_FIDELITY_VERSION,
        solutionFidelityPromptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
        semanticChoiceVersion: SEMANTIC_CHOICE_VERSION,
        semanticPromptDigest: SEMANTIC_CHOICE_PROMPT_DIGEST,
      } : {
        semanticChoiceVersion: LEGACY_SEMANTIC_CHOICE_VERSION,
        semanticPromptDigest: LEGACY_SEMANTIC_CHOICE_PROMPT_DIGEST,
      }),
      sourceQuestionCount: effective.problems.size,
      acceptedQuestionCount: 0,
      rejectedQuestionCount: effective.rejected,
      reviewQuestionCount: effective.reviews,
      targetQuestionCounts: {},
      ...(version === 2 ? {
        acceptedSolutionKeys: [],
        solutionRepairKeys: [],
        derivedAnswerKeys: [],
      } : {}),
      acceptedMcqKeys: [],
      effectiveCorpusHash,
      ...(version === 2 ? {
        effectiveSolutionCorpusHash: canonicalEvidenceHash([]),
        solutionFidelityCheckpoints: [],
        solutionFidelityItems: [],
        solutionRepairs: [],
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
      || result.reviewQuestionCount !== 0) {
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
      if (!existsSync(entryPath)) {
        add({ code: "ENTRY_STATE_MISSING", entryId: entry.id, message: "entry.json is missing" });
      } else {
        const saved = safeObject(entryPath, "entry.json", entry.id, add);
        if (saved && (saved.schemaVersion !== 1 || !isDeepStrictEqual(saved.entry, entry.raw))) {
          add({ code: "ENTRY_MISMATCH", entryId: entry.id, message: "entry.json does not exactly match manifest entry" });
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

      let decisions = loadDecisions(stateDir, entry, problemEvidence, terminalDigest, add);

      if (result) {
        const needsFilteredAudit = result.answerAudit !== undefined || decisions.order.some((key) =>
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
            add,
          );
        }
        if (decisions.reviews > 0) {
          report.manifest.review += 1;
          add({ code: "REVIEW_COMMITTED", entryId: entry.id, message: "review decisions must have no terminal result" });
        }
        const noScopeGateMatches = result.reason === "NO_IN_SCOPE_QUESTIONS" && (
          result.classifierVersion === CLASSIFIER_VERSION
          && result.transcriptionGateVersion === TRANSCRIPTION_GATE_VERSION
          && result.transcriptionPromptDigest === TRANSCRIPTION_PROMPT_DIGEST
        );
        if (
          result.version !== 2 || result.status !== "filtered" || result.entryId !== entry.id
          || result.acceptedQuestionCount !== 0 || result.reviewQuestionCount !== 0
          || result.sourceQuestionCount !== decisions.problems.size || result.rejectedQuestionCount !== decisions.rejected
          || decisions.accepted.length !== 0 || decisions.reviews !== 0
          || result.rulesDigest !== decisions.rulesDigest || !noScopeGateMatches
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
