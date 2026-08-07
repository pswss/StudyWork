#!/usr/bin/env tsx

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gradeAnswer } from "../src/quiz";
import { numericPrintedLocator } from "../src/claude";

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
};

type AcceptedQuestion = ProblemQuestion & {
  target: TargetSubject;
  officialAnswer: string;
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
  const number = numericPrintedLocator(typeof rawNumber === "string" ? rawNumber : null);
  if (number === null) throw new Error(`${label}.number is not a printed integer`);
  const page = integer(row.page, `${label}.page`, 1);
  const qtype = row.qtype;
  if (qtype !== "mcq" && qtype !== "short" && qtype !== "ox") throw new Error(`${label}.qtype is invalid`);
  let choices: string[] | null = null;
  if (row.choices !== null) {
    if (!Array.isArray(row.choices) || row.choices.some((choice) => typeof choice !== "string" || !choice.trim())) {
      throw new Error(`${label}.choices is invalid`);
    }
    choices = row.choices as string[];
  }
  return {
    key: `${page}:${number}`,
    page,
    printedNumber: String(number),
    qtype,
    question: exactString(row.question, `${label}.question`),
    choices,
    answer: exactString(row.answer, `${label}.answer`),
  };
}

type DecisionSummary = {
  problems: Map<string, ProblemQuestion>;
  accepted: Array<ProblemQuestion & { target: TargetSubject }>;
  rejected: number;
  reviews: number;
  rulesDigest: string | null;
};

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
  const classificationFiles = listJson(classificationDir, /^v2-\d{4}-[a-f0-9]{16}\.json$/);
  const problems = new Map<string, ProblemQuestion>();
  const accepted: DecisionSummary["accepted"] = [];
  const ranges: Array<{ from: number; to: number }> = [];
  const topology: Array<{ from: number; to: number; ownedFrom: number; ownedTo: number }> = [];
  let rejected = 0;
  let reviews = 0;
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

    const candidates = classificationFiles.filter((name) => name.startsWith(`v2-${index}-`));
    const selected = terminalDigest
      ? candidates.find((name) => name === `v2-${index}-${terminalDigest}.json`)
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
        classification.version !== 2 || classification.sourceHash !== problemEvidence.sha256
        || classification.from !== from || classification.to !== to || classification.rulesDigest !== fileDigest
        || classification.ownedFrom !== checkpoint.ownedFrom || classification.ownedTo !== checkpoint.ownedTo
        || classification.model !== "gpt-5.6-sol" || classification.reasoningEffort !== "high"
      ) throw new Error(`${selected} metadata does not match problem checkpoint`);
      if (selectedDigest !== null && selectedDigest !== fileDigest) throw new Error(`${selected} rules digest does not match terminal record`);
      selectedDigest = fileDigest;
      if (!Array.isArray(classification.items)) throw new Error(`${selected}.items must be an array`);
      const expectedKeys = new Set(chunkProblems.map((question) => question.key));
      const seen = new Set<string>();
      const byKey = new Map(chunkProblems.map((question) => [question.key, question]));
      for (const [decisionIndex, value] of classification.items.entries()) {
        const decision = object(value, `${selected}.items[${decisionIndex}]`);
        const key = exactString(decision.key, `${selected}.items[${decisionIndex}].key`);
        if (!expectedKeys.has(key) || seen.has(key)) throw new Error(`${selected} has missing, extra, or duplicate key ${key}`);
        seen.add(key);
        const kind = decision.decision;
        if (kind !== "accept" && kind !== "reject" && kind !== "review") throw new Error(`${key}: invalid decision`);
        if (kind === "review") {
          reviews += 1;
          add({ code: "REVIEW_PENDING", entryId: entry.id, message: `${key} requires review` });
          continue;
        }
        if (kind === "reject") {
          rejected += 1;
          if (decision.canonical_subject !== null) {
            add({ code: "CLASSIFICATION_INVALID", entryId: entry.id, message: `${key}: reject must not assign a target` });
          }
          continue;
        }

        const canonical = decision.canonical_subject as CanonicalSubject;
        if (!(canonical in TARGET_BY_CANONICAL) || !CANONICAL_BY_SOURCE[entry.subject].includes(canonical)) {
          add({ code: "SUBJECT_EXCLUSION", entryId: entry.id, message: `${key}: ${String(canonical)} is outside ${entry.subject}` });
          continue;
        }
        if ((canonical === "integrated_science" || canonical === "integrated_social") && ![1, 2].includes(entry.grade)) {
          add({ code: "GRADE_GATE", entryId: entry.id, message: `${key}: integrated source grade ${entry.grade} is forbidden` });
        }
        const confidence = Number(decision.confidence);
        if (!Number.isFinite(confidence) || confidence < 0.9 || typeof decision.curriculum_course !== "string"
          || !decision.curriculum_course.trim() || typeof decision.domain !== "string" || !decision.domain.trim()) {
          add({ code: "CLASSIFICATION_INVALID", entryId: entry.id, message: `${key}: accept lacks confidence/course/domain evidence` });
        }
        if (!Array.isArray(decision.reason_codes) || decision.reason_codes.length === 0
          || decision.reason_codes.some((code) => typeof code !== "string" || !code.trim())) {
          add({ code: "CLASSIFICATION_INVALID", entryId: entry.id, message: `${key}: accept lacks reason codes` });
        }
        if (!Array.isArray(decision.achievement_codes) || decision.achievement_codes.length === 0) {
          add({ code: "CURRICULUM_EXCLUSION", entryId: entry.id, message: `${key}: accept lacks achievement codes` });
        } else {
          for (const code of decision.achievement_codes) {
            if (typeof code !== "string" || !ALLOWED_CODES[canonical].has(code)) {
              add({ code: "CURRICULUM_EXCLUSION", entryId: entry.id, message: `${key}: excluded code ${String(code)}` });
            }
          }
        }
        accepted.push({ ...byKey.get(key)!, target: TARGET_BY_CANONICAL[canonical] });
      }
      if (seen.size !== expectedKeys.size) throw new Error(`${selected} omits ${expectedKeys.size - seen.size} questions`);
      for (const question of chunkProblems) {
        if (problems.has(question.key)) throw new Error(`duplicate extracted question key ${question.key}`);
        problems.set(question.key, question);
      }
    } catch (error) {
      add({ code: "CLASSIFICATION_INVALID", entryId: entry.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
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
  const printed = new Set([...problems.values()].map((question) => Number(question.printedNumber)));
  if (printed.size !== expectedCount || Array.from({ length: expectedCount }, (_, index) => index + 1).some((number) => !printed.has(number))) {
    add({ code: "PROBLEM_NUMBER_SET", entryId: entry.id, message: `${entry.subject} must contain printed numbers 1-${expectedCount} exactly once` });
  }
  return { problems, accepted, rejected, reviews, rulesDigest: selectedDigest };
}

type OfficialSolution = { printedNumber: string; answer: string; explanation: string; page: number };

function loadSolutions(
  stateDir: string,
  entry: ManifestEntry,
  evidence: DownloadEvidence,
  add: AddFailure,
): Map<string, OfficialSolution> {
  const dir = join(stateDir, "solution-chunks");
  const files = listJson(dir, /^v2-\d{4}\.json$/);
  const solutions = new Map<string, OfficialSolution>();
  const ranges: Array<{ from: number; to: number }> = [];
  if (files.length === 0) add({ code: "CHUNK_MISSING", entryId: entry.id, message: "solution chunks are missing" });
  for (const name of files) {
    const checkpoint = safeObject(join(dir, name), name, entry.id, add);
    if (!checkpoint) continue;
    try {
      if (checkpoint.version !== 2 || checkpoint.sourceHash !== evidence.sha256
        || checkpoint.model !== "gpt-5.6-sol" || checkpoint.reasoningEffort !== "high") {
        throw new Error(`${name} metadata does not match solution download/import contract`);
      }
      const from = integer(checkpoint.from, `${name}.from`, 1);
      const to = integer(checkpoint.to, `${name}.to`, from);
      if (!Array.isArray(checkpoint.items)) throw new Error(`${name}.items must be an array`);
      ranges.push({ from, to });
      for (const [index, value] of checkpoint.items.entries()) {
        const item = object(value, `${name}.items[${index}]`);
        const number = numericPrintedLocator(typeof item.number === "string" ? item.number : null);
        if (number === null) throw new Error(`${name}.items[${index}].number is invalid`);
        const page = integer(item.page, `${name}.items[${index}].page`, 1);
        if (page < from || page > to) throw new Error(`${name}.items[${index}] is outside chunk pages`);
        const printedNumber = String(number);
        if (solutions.has(printedNumber)) throw new Error(`duplicate official solution number ${printedNumber}`);
        solutions.set(printedNumber, {
          printedNumber,
          answer: typeof item.answer === "string" ? item.answer : "",
          explanation: typeof item.explanation === "string" ? item.explanation : "",
          page,
        });
      }
    } catch (error) {
      add({ code: "SOLUTION_CHECKPOINT", entryId: entry.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  validateRanges(ranges, evidence.pageCount, "solution", entry.id, add);
  return solutions;
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

      const decisions = loadDecisions(stateDir, entry, problemEvidence, terminalDigest, add);
      if (decisions.reviews > 0) {
        report.manifest.review += 1;
        if (hasReceipt || hasResult) add({ code: "REVIEW_COMMITTED", entryId: entry.id, message: "review decisions must have no terminal commit/result" });
      }
      const acceptedCounts = new Map<TargetSubject, number>();
      for (const question of decisions.accepted) {
        acceptedCounts.set(question.target, (acceptedCounts.get(question.target) ?? 0) + 1);
        report.targets[question.target].expected += 1;
      }

      if (result) {
        if (
          result.version !== 2 || result.status !== "filtered" || result.entryId !== entry.id
          || result.acceptedQuestionCount !== 0 || result.reviewQuestionCount !== 0
          || result.sourceQuestionCount !== decisions.problems.size || result.rejectedQuestionCount !== decisions.rejected
          || decisions.accepted.length !== 0 || decisions.reviews !== 0
          || result.rulesDigest !== decisions.rulesDigest
        ) {
          add({ code: "RESULT_INVALID", entryId: entry.id, message: "filtered result does not match complete classifications" });
        }
        continue;
      }

      if (!receipt) {
        if (decisions.accepted.length > 0) add({ code: "RECEIPT_MISSING", entryId: entry.id, message: "accepted questions have no receipt" });
        continue;
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

      const solutions = loadSolutions(stateDir, entry, solutionEvidence, add);
      const problemNumbers = new Set([...decisions.problems.values()].map((question) => question.printedNumber));
      if (
        solutions.size !== problemNumbers.size || [...problemNumbers].some((number) => !solutions.has(number))
        || [...solutions].some(([number]) => !problemNumbers.has(number))
      ) {
        add({
          code: "SOLUTION_NUMBER_SET",
          entryId: entry.id,
          message: "problem and official solution printed-number sets differ",
        });
      }
      const expectedByTarget = new Map<TargetSubject, AcceptedQuestion[]>();
      for (const question of decisions.accepted) {
        const solution = solutions.get(question.printedNumber);
        if (!solution) {
          add({ code: "OFFICIAL_SOLUTION_MISSING", entryId: entry.id, target: question.target, message: `${question.printedNumber}: official solution missing` });
          continue;
        }
        if (!solution.answer.trim() || !solution.explanation.trim()) {
          add({ code: "OFFICIAL_EXPLANATION", entryId: entry.id, target: question.target, message: `${question.printedNumber}: official answer/explanation empty` });
        }
        const choices = question.choices === null ? null : JSON.stringify(question.choices);
        if (!gradeAnswer(question.qtype, question.answer, solution.answer, choices)) {
          add({ code: "OFFICIAL_ANSWER_MISMATCH", entryId: entry.id, target: question.target, message: `${question.printedNumber}: extracted and official answers disagree` });
        }
        const group = expectedByTarget.get(question.target) ?? [];
        group.push({
          ...question,
          officialAnswer: solution.answer,
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
