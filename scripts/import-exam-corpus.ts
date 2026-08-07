#!/usr/bin/env tsx

import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { open as openFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractProblemsFromFile,
  extractSolutionsFromFile,
  mapPool,
  numericPrintedLocator,
  parseQuizItemsEx,
  parseSolutionItems,
  pdfPageCount,
  slicePdf,
  validatePrintedQuestionSequence,
  type QuizItemEx,
  type SolutionItem,
} from "../src/claude";
import {
  getCodexProvider,
  type AIJsonSchema,
} from "../src/codex-provider";
import { gradeAnswer } from "../src/quiz";
import { MAX_PDF_BYTES, MAX_PDF_PAGES, safeUploadName } from "../src/upload";

export const IMPORT_MODEL = "gpt-5.6-sol";
export const IMPORT_REASONING_EFFORT = "high" as const;
export const IMPORT_CONCURRENCY = 10;

export const TARGET_SUBJECTS = [
  "수학 - 수학Ⅱ·미적분Ⅰ",
  "수학 - 수학Ⅰ·대수",
  "국어 - 독서",
  "국어 - 문학",
  "과학 - 통합과학 (2022 개정)",
  "사회 - 통합사회 (2022 개정)",
] as const;

type TargetSubject = (typeof TARGET_SUBJECTS)[number];
type SourceSubject = "국어" | "수학" | "영어" | "한국사" | "통합사회" | "통합과학";
export type CanonicalSubject =
  | "korean_reading"
  | "korean_literature"
  | "math_A"
  | "math_B"
  | "integrated_science"
  | "integrated_social";

const TARGET_BY_CANONICAL: Record<CanonicalSubject, TargetSubject> = {
  korean_reading: "국어 - 독서",
  korean_literature: "국어 - 문학",
  math_A: "수학 - 수학Ⅱ·미적분Ⅰ",
  math_B: "수학 - 수학Ⅰ·대수",
  integrated_science: "과학 - 통합과학 (2022 개정)",
  integrated_social: "사회 - 통합사회 (2022 개정)",
};

function codeSet(...ranges: Array<[prefix: string, first: number, last: number]>): ReadonlySet<string> {
  return new Set(ranges.flatMap(([prefix, first, last]) =>
    Array.from({ length: last - first + 1 }, (_, index) => `${prefix}-${String(first + index).padStart(2, "0")}`)
  ));
}

const ACHIEVEMENT_CODES: Record<CanonicalSubject, ReadonlySet<string>> = {
  math_A: codeSet(
    ["12미적Ⅰ-01", 1, 4], ["12미적Ⅰ-02", 1, 10], ["12미적Ⅰ-03", 1, 6],
    ["12수학Ⅱ01", 1, 4], ["12수학Ⅱ02", 1, 11], ["12수학Ⅱ03", 1, 6]
  ),
  math_B: codeSet(
    ["12대수01", 1, 8], ["12대수02", 1, 3], ["12대수03", 1, 7],
    ["12수학Ⅰ01", 1, 8], ["12수학Ⅰ02", 1, 3], ["12수학Ⅰ03", 1, 8]
  ),
  korean_reading: codeSet(
    ["10공국1-02", 1, 2], ["10공국2-02", 1, 3],
    ["12독작01", 2, 5], ["12독작01", 7, 9], ["12독작01", 12, 14]
  ),
  korean_literature: codeSet(
    ["10공국1-05", 1, 3], ["10공국2-05", 1, 2], ["12문학01", 1, 12]
  ),
  integrated_science: codeSet(
    ["10통과1-01", 1, 4], ["10통과1-02", 1, 6], ["10통과1-03", 1, 6],
    ["10통과2-01", 1, 5], ["10통과2-02", 1, 6], ["10통과2-03", 1, 4]
  ),
  integrated_social: codeSet(
    ["10통사1-01", 1, 2], ["10통사1-02", 1, 2], ["10통사1-03", 1, 3],
    ["10통사1-04", 1, 4], ["10통사1-05", 1, 3], ["10통사2-01", 1, 3],
    ["10통사2-02", 1, 3], ["10통사2-03", 1, 4], ["10통사2-04", 1, 3],
    ["10통사2-05", 1, 3]
  ),
};

export function isAllowedAchievementCode(canonical: CanonicalSubject, code: string): boolean {
  return ACHIEVEMENT_CODES[canonical].has(code);
}

const ALLOWED_CANONICAL: Record<SourceSubject, readonly CanonicalSubject[]> = {
  국어: ["korean_reading", "korean_literature"],
  수학: ["math_A", "math_B"],
  영어: [],
  한국사: [],
  통합사회: ["integrated_social"],
  통합과학: ["integrated_science"],
};

const SUPPORTED_SOURCES = new Set<SourceSubject>(["국어", "수학", "통합사회", "통합과학"]);
const SOURCE_SUBJECTS = new Set<SourceSubject>(["국어", "수학", "영어", "한국사", "통합사회", "통합과학"]);
const CLASSIFIER_VERSION = 1;
const CHECKPOINT_VERSION = 1;

const CURRICULUM_RULES = `
Classify each question from the complete attached passage, stem, choices, tables, and figures. Never classify from the filename or exam label alone.

Return decision accept, reject, or review. Ambiguous, mixed-scope, insufficient-evidence, or cross-target questions are review, never accept. An accept needs confidence >= 0.90, one canonical_subject, a curriculum_course, a domain, at least one achievement code, and reason codes. Emit achievement codes as exact bare codes shown below, without brackets, spaces, abbreviations, or invented ranges. Non-accept decisions use canonical_subject null. Keep every input key exactly once.

MATH_A aliases 2015 수학Ⅱ and 2022 미적분Ⅰ. Accept 함수의 극한과 연속 [12미적Ⅰ-01-01..04] or legacy [12수학Ⅱ01-01..04], 미분 [12미적Ⅰ-02-01..10] or legacy [12수학Ⅱ02-01..11], 적분 [12미적Ⅰ-03-01..06] or legacy [12수학Ⅱ03-01..06]. Reject 2015 선택 미적분/2022 미적분Ⅱ-only content: 수열의 극한·급수, 지수·로그·삼각함수 미분, 합성·매개·음함수 미분, 치환·부분적분. 미적분Ⅰ differentiation/integration stays polynomial scope; motion applications stay straight-line.

MATH_B aliases 2015 수학Ⅰ and 2022 대수. Accept 지수함수와 로그함수 [12대수01-01..08] or [12수학Ⅰ01-01..08], 삼각함수 [12대수02-01..03] or [12수학Ⅰ02-01..03], 수열 [12대수03-01..07] or [12수학Ⅰ03-01..08]. Reject common-math polynomial/equations/matrices/probability, advanced trigonometry, sequence limits, and infinite series. In-scope trigonometry is general angle/radian, sin/cos/tan graphs, and sine/cosine laws. In-scope sequences are arithmetic/geometric, sigma/sums, recursive definition, and induction; finding a general term from a recursive definition is out of scope.

KOREAN_READING accepts nonfiction comprehension whose tested construct is factual, inferential, or critical reading; argument, structure, evidence, cross-text synthesis, or contextual vocabulary. Anchors: [10공국1-02-01..02], [10공국2-02-01..03], [12독작01-03..04]. For mixed 독서와 작문 codes 02,05,07-09,12-14, accept only when the answer requires comprehension/evaluation of the supplied text, not planning, producing, or revising writing. Reject speech/listening/presentation/discussion/debate/negotiation, composition/draft/revision, grammar/phonology/morphology/syntax/semantics/history/spelling, and media as the assessed construct. Incidental charts/images remain reading. Contextual word meaning remains reading; word formation or grammar rules reject.

KOREAN_LITERATURE accepts literary comprehension and interpretation across poetry, sijo/classical verse, modern/classical fiction, drama, and literary essay: speaker/narrator/character, imagery/figurative/form, plot/conflict, theme, context/comparison/criticism. Anchors: [10공국1-05-01..03], [10공국2-05-01..02], [12문학01-01..08,10..12]. For [12문학01-09], accept only when literary meaning is assessed; media form, camera, editing, or platform effect rejects or reviews. Shared sets may split: accept in-scope siblings and reject excluded siblings while retaining the shared passage in the question evidence.

INTEGRATED_SCIENCE accepts only source school grade 1 or 2 and one of: 통합과학1 과학의 기초 [10통과1-01-01..04], 물질과 규칙성 [10통과1-02-01..06], 시스템과 상호작용 [10통과1-03-01..06]; 통합과학2 변화와 다양성 [10통과2-01-01..05], 환경과 에너지 [10통과2-02-01..06], 과학과 미래 사회 [10통과2-03-01..04]. Numerals 1/2 in course names are course halves, not school grades. Reject elective-depth dependencies. Hard bounds: no sensor operating principle; bonding property only conductivity; no detailed silicate/protein/nucleic structures; no semiconductor junction; redox without oxidation numbers; Arrhenius acid/base only; neutralization temperature/indicator only; no thermochemical equations/enthalpy; solar fusion and induction qualitative only.

INTEGRATED_SOCIAL accepts only source school grade 1 or 2 and one of: 통합사회1 통합적 관점 [10통사1-01-01..02], 인간·사회·환경과 행복 [10통사1-02-01..02], 자연환경과 인간 [10통사1-03-01..03], 문화와 다양성 [10통사1-04-01..04], 생활공간과 사회 [10통사1-05-01..03]; 통합사회2 인권보장과 헌법 [10통사2-01-01..03], 사회정의와 불평등 [10통사2-02-01..03], 시장경제와 지속가능발전 [10통사2-03-01..04], 세계화와 평화 [10통사2-04-01..03], 미래와 지속가능한 삶 [10통사2-05-01..03]. Reject elective-depth-only geography/history/sociology/politics/law/economics. Detailed macro/micro models, elasticity calculations, advanced legal doctrine/procedure, named-region factual recall, sociology research methods, or philosopher-specific doctrine not supplied in the stimulus reject or review.
`.trim();

const CLASSIFIER_DIGEST = createHash("sha256").update(CURRICULUM_RULES).digest("hex").slice(0, 16);

const CLASSIFICATION_SCHEMA: AIJsonSchema = {
  name: "studywork_exam_corpus_classification",
  description: "Conservative curriculum classification for extracted official exam questions.",
  outputKey: "items",
  schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            decision: { type: "string", enum: ["accept", "reject", "review"] },
            canonical_subject: {
              type: ["string", "null"],
              enum: [
                "korean_reading",
                "korean_literature",
                "math_A",
                "math_B",
                "integrated_science",
                "integrated_social",
                null,
              ],
            },
            curriculum_course: { type: ["string", "null"] },
            domain: { type: ["string", "null"] },
            achievement_codes: { type: "array", items: { type: "string" } },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            reason_codes: { type: "array", items: { type: "string" } },
          },
          required: [
            "key",
            "decision",
            "canonical_subject",
            "curriculum_course",
            "domain",
            "achievement_codes",
            "confidence",
            "reason_codes",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
};

export type CorpusManifestEntry = {
  id: string;
  subject: SourceSubject;
  examTitle: string;
  rawTitle: string;
  administrationDate: string;
  variant: string | null;
  form: "odd" | "even" | null;
  sourcePageUrl: string;
  problemPdfUrl: string;
  solutionPdfUrl: string;
  grade: number | null;
  raw: Record<string, unknown>;
};

export type CorpusManifest = {
  schemaVersion: 1;
  entries: CorpusManifestEntry[];
  raw: Record<string, unknown>;
};

export type ClassificationDecision = {
  key: string;
  decision: "accept" | "reject" | "review";
  canonical_subject: CanonicalSubject | null;
  curriculum_course: string | null;
  domain: string | null;
  achievement_codes: string[];
  confidence: number;
  reason_codes: string[];
};

export type PdfEvidence = {
  path: string;
  sha256: string;
  bytes: number;
  pageCount: number;
  requestedUrl: string;
  resolvedUrl: string;
};

export type ImportedQuestion = QuizItemEx & {
  printedNumber: string;
  officialAnswer: string;
  officialExplanation: string;
  solutionPage: number;
  targetSubject: TargetSubject;
  classification: ClassificationDecision;
};

type ClassifiedQuestion = {
  question: QuizItemEx;
  classification: ClassificationDecision;
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: 객체가 아닙니다`);
  return value as Record<string, unknown>;
}

function exactString(value: unknown, label: string, max = 1000): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.includes("\0") || value.length > max) {
    throw new Error(`${label}: 유효한 문자열이 아닙니다`);
  }
  return value;
}

function httpsUrl(value: unknown, label: string, hostname: "www.ebsi.co.kr" | "wdown.ebsi.co.kr"): string {
  const text = exactString(value, label, 4096);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label}: URL이 유효하지 않습니다`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hostname !== hostname || url.port) {
    throw new Error(`${label}: ${hostname}의 자격 증명 없는 표준 HTTPS URL이어야 합니다`);
  }
  return url.href;
}

function manifestGrade(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const match = /^(?:고\s*)?([123])$/.exec(String(value).trim());
  if (!match) throw new Error("grade: 1, 2, 3 중 하나여야 합니다");
  return Number(match[1]);
}

function administrationDate(value: unknown, label: string): string {
  const date = exactString(value, label, 10);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`${label}: YYYY-MM-DD 날짜가 아닙니다`);
  }
  return date;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null || value === undefined ? null : exactString(value, label, 100);
}

export function examBookTitle(entry: Pick<CorpusManifestEntry, "administrationDate" | "rawTitle">): string {
  return `${entry.administrationDate} · ${entry.rawTitle}`;
}

export function parseCorpusManifest(value: unknown): CorpusManifest {
  const raw = object(value, "manifest");
  if (raw.schemaVersion !== 1) throw new Error("manifest.schemaVersion은 1이어야 합니다");
  if (!Array.isArray(raw.entries) || raw.entries.length === 0) throw new Error("manifest.entries가 비어 있습니다");

  const ids = new Set<string>();
  const entries = raw.entries.map((entryValue, index): CorpusManifestEntry => {
    const entry = object(entryValue, `entries[${index}]`);
    const id = exactString(entry.id, `entries[${index}].id`, 200);
    const subject = exactString(entry.subject, `entries[${index}].subject`, 20) as SourceSubject;
    if (!SOURCE_SUBJECTS.has(subject)) throw new Error(`entries[${index}].subject: 지원하지 않는 원본 과목입니다`);
    const examTitle = exactString(entry.examTitle, `entries[${index}].examTitle`, 500);
    const rawTitle = exactString(entry.rawTitle, `entries[${index}].rawTitle`, 500);
    const heldOn = administrationDate(entry.administrationDate, `entries[${index}].administrationDate`);
    const variant = nullableString(entry.variant, `entries[${index}].variant`);
    const form = nullableString(entry.form, `entries[${index}].form`);
    if (form !== null && form !== "odd" && form !== "even") {
      throw new Error(`entries[${index}].form: odd/even/null 중 하나여야 합니다`);
    }
    const sourcePageUrl = httpsUrl(
      entry.sourcePageUrl ?? entry.officialSourcePageUrl,
      `entries[${index}].sourcePageUrl`,
      "www.ebsi.co.kr"
    );
    const problemPdfUrl = httpsUrl(
      entry.problemPdfUrl ?? entry.problemUrl,
      `entries[${index}].problemPdfUrl`,
      "wdown.ebsi.co.kr"
    );
    const solutionPdfUrl = httpsUrl(
      entry.solutionPdfUrl ?? entry.solutionUrl,
      `entries[${index}].solutionPdfUrl`,
      "wdown.ebsi.co.kr"
    );
    if (problemPdfUrl === solutionPdfUrl) throw new Error(`entries[${index}]: 문제와 해설 URL이 같습니다`);
    if (ids.has(id)) throw new Error(`중복 manifest id: ${id}`);
    ids.add(id);
    return {
      id,
      subject,
      examTitle,
      rawTitle,
      administrationDate: heldOn,
      variant,
      form,
      sourcePageUrl,
      problemPdfUrl,
      solutionPdfUrl,
      grade: manifestGrade(entry.grade),
      raw: entry,
    };
  });
  return { schemaVersion: 1, entries, raw };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function writeImmutableJson(path: string, value: unknown): void {
  const next = canonicalJson(value);
  if (existsSync(path)) {
    const current = canonicalJson(JSON.parse(readFileSync(path, "utf8")));
    if (current !== next) throw new Error(`기존 체크포인트와 내용이 다릅니다: ${path}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, next, { encoding: "utf8", flag: "wx" });
  renameSync(temp, path);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const file = await openFile(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await file.close();
  }
}

async function inspectPdf(path: string, requestedUrl: string, resolvedUrl = requestedUrl): Promise<PdfEvidence> {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size < 5 || stat.size > MAX_PDF_BYTES) {
    throw new Error(`PDF 크기가 유효하지 않습니다: ${path}`);
  }
  const file = openSync(path, "r");
  try {
    const header = Buffer.alloc(5);
    if (readSync(file, header, 0, header.length, 0) !== header.length || header.toString("ascii") !== "%PDF-") {
      throw new Error(`PDF 헤더가 없습니다: ${path}`);
    }
  } finally {
    closeSync(file);
  }
  const pageCount = await pdfPageCount(path);
  if (!pageCount || pageCount > MAX_PDF_PAGES) throw new Error(`PDF 페이지 수가 유효하지 않습니다: ${path}`);
  return {
    path,
    sha256: await sha256File(path),
    bytes: stat.size,
    pageCount,
    requestedUrl,
    resolvedUrl,
  };
}

async function downloadPdf(url: string, referer: string, path: string): Promise<PdfEvidence> {
  if (existsSync(path)) return inspectPdf(path, url);
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  rmSync(partial, { force: true });
  const signal = AbortSignal.timeout(5 * 60 * 1000);
  let currentUrl = url;
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects++) {
    response = await fetch(currentUrl, {
      redirect: "manual",
      signal,
      headers: {
        referer,
        "user-agent": "StudyWork/1.0 personal-study-corpus-importer",
      },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => {});
    if (!location || redirects === 5) throw new Error("PDF 리디렉션이 너무 많거나 목적지가 없습니다");
    currentUrl = httpsUrl(new URL(location, currentUrl).href, "PDF redirect", "wdown.ebsi.co.kr");
  }
  if (!response) throw new Error("PDF 다운로드 응답이 없습니다");
  if (!response.ok || !response.body) throw new Error(`PDF 다운로드 실패: HTTP ${response.status}`);
  httpsUrl(response.url, "PDF response", "wdown.ebsi.co.kr");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PDF_BYTES) throw new Error("PDF가 200MB를 초과합니다");

  const file = await openFile(partial, "wx");
  let bytes = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength;
      if (bytes > MAX_PDF_BYTES) throw new Error("PDF가 200MB를 초과합니다");
      await file.write(chunk);
    }
    await file.sync();
  } catch (error) {
    await file.close().catch(() => {});
    rmSync(partial, { force: true });
    throw error;
  }
  await file.close();
  try {
    const evidence = await inspectPdf(partial, url, response.url);
    renameSync(partial, path);
    return { ...evidence, path };
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
}

function questionKey(question: QuizItemEx): string {
  const number = numericPrintedLocator(question.number);
  if (number === null) throw new Error(`인쇄 문제 번호가 없거나 숫자가 아닙니다: page ${question.page ?? "?"}`);
  if (question.page === null) throw new Error(`${number}번 문제의 원본 페이지가 없습니다`);
  return `${question.page}:${number}`;
}

function restoredQuizItems(value: unknown): QuizItemEx[] {
  if (!Array.isArray(value)) throw new Error("문제 체크포인트 items가 배열이 아닙니다");
  return parseQuizItemsEx(JSON.stringify(value.map((item) => {
    const row = object(item, "문제 체크포인트 항목");
    return {
      ...row,
      choiceCount: row.qtype === "mcq" && Array.isArray(row.choices) ? row.choices.length : null,
    };
  })));
}

function parseDecisions(
  value: unknown,
  questions: QuizItemEx[],
  entry: CorpusManifestEntry
): ClassificationDecision[] {
  if (!Array.isArray(value)) throw new Error("분류 결과가 배열이 아닙니다");
  const expected = new Set(questions.map(questionKey));
  const seen = new Set<string>();
  const allowed = new Set(ALLOWED_CANONICAL[entry.subject]);
  const decisions = value.map((raw, index): ClassificationDecision => {
    const row = object(raw, `분류 ${index + 1}`);
    const key = exactString(row.key, `분류 ${index + 1}.key`, 100);
    if (!expected.has(key) || seen.has(key)) throw new Error(`분류 key가 없거나 중복입니다: ${key}`);
    seen.add(key);
    if (!(["accept", "reject", "review"] as unknown[]).includes(row.decision)) {
      throw new Error(`분류 ${key}: decision이 유효하지 않습니다`);
    }
    const decision = row.decision as ClassificationDecision["decision"];
    const canonical = row.canonical_subject;
    const canonicalSubject = canonical === null ? null : exactString(canonical, `분류 ${key}.canonical_subject`) as CanonicalSubject;
    if (canonicalSubject !== null && !(canonicalSubject in TARGET_BY_CANONICAL)) {
      throw new Error(`분류 ${key}: canonical_subject가 유효하지 않습니다`);
    }
    const curriculumCourse = row.curriculum_course === null
      ? null
      : exactString(row.curriculum_course, `분류 ${key}.curriculum_course`, 200);
    const domain = row.domain === null ? null : exactString(row.domain, `분류 ${key}.domain`, 200);
    if (!Array.isArray(row.achievement_codes) || row.achievement_codes.some((code) => typeof code !== "string" || !code.trim())) {
      throw new Error(`분류 ${key}: achievement_codes가 유효하지 않습니다`);
    }
    if (!Array.isArray(row.reason_codes) || row.reason_codes.length === 0 || row.reason_codes.some((code) => typeof code !== "string" || !code.trim())) {
      throw new Error(`분류 ${key}: reason_codes가 유효하지 않습니다`);
    }
    const confidence = Number(row.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error(`분류 ${key}: confidence가 유효하지 않습니다`);
    }
    if (decision === "accept") {
      if (
        canonicalSubject === null || !allowed.has(canonicalSubject) || confidence < 0.9 ||
        !curriculumCourse || !domain || row.achievement_codes.length === 0
      ) throw new Error(`분류 ${key}: accept 근거가 부족하거나 원본 과목 범위를 벗어났습니다`);
      const invalidCode = (row.achievement_codes as string[]).find(
        (code) => !isAllowedAchievementCode(canonicalSubject, code)
      );
      if (invalidCode) throw new Error(`분류 ${key}: 허용 범위 밖 성취기준 코드입니다: ${invalidCode}`);
      if (["통합과학", "통합사회"].includes(entry.subject) && ![1, 2].includes(entry.grade ?? 0)) {
        throw new Error(`분류 ${key}: 통합과학/통합사회는 고1·고2 원본만 accept할 수 있습니다`);
      }
    } else if (canonicalSubject !== null || curriculumCourse !== null || domain !== null || row.achievement_codes.length > 0) {
      throw new Error(`분류 ${key}: reject/review는 교과 배정을 비워야 합니다`);
    }
    return {
      key,
      decision,
      canonical_subject: canonicalSubject,
      curriculum_course: curriculumCourse,
      domain,
      achievement_codes: [...new Set(row.achievement_codes as string[])],
      confidence,
      reason_codes: [...new Set(row.reason_codes as string[])],
    };
  });
  if (seen.size !== expected.size) throw new Error(`분류 결과 누락: ${expected.size - seen.size}문항`);
  return decisions;
}

async function classifyQuestions(
  entry: CorpusManifestEntry,
  path: string,
  from: number,
  to: number,
  questions: QuizItemEx[]
): Promise<ClassificationDecision[]> {
  if (questions.length === 0) return [];
  const input = questions.map((question) => ({
    key: questionKey(question),
    printed_number: String(numericPrintedLocator(question.number)),
    source_page: question.page,
    question: question.question,
    choices: question.choices,
  }));
  const allowedCodes = ALLOWED_CANONICAL[entry.subject]
    .flatMap((canonical) => [...ACHIEVEMENT_CODES[canonical]])
    .sort();
  const prompt =
    `Attached official problem PDF slice contains original pages ${from}-${to}. ` +
    `Exam source subject is ${entry.subject}; source school grade is ${entry.grade ?? "unknown"}. ` +
    `Inspect complete source passages and visual evidence, then classify every supplied question.\n\n` +
    `${CURRICULUM_RULES}\n\nAllowed exact achievement codes for this source: ${allowedCodes.join(", ")}\n\n` +
    `Questions:\n${JSON.stringify(input)}`;
  const result = await getCodexProvider({ model: IMPORT_MODEL, reasoningEffort: IMPORT_REASONING_EFFORT }).complete({
    operation: "problem-extract",
    prompt,
    file: { path, kind: "pdf" },
    schema: CLASSIFICATION_SCHEMA,
    model: IMPORT_MODEL,
    reasoningEffort: IMPORT_REASONING_EFFORT,
    lane: "bulk",
  });
  return parseDecisions(JSON.parse(result.text), questions, entry);
}

type SourceSlice = { path: string; from: number; to: number };

async function withSlices<T>(
  evidence: PdfEvidence,
  chunkPages: number,
  stride: number,
  run: (slices: SourceSlice[]) => Promise<T>
): Promise<T> {
  const sliced = await slicePdf(evidence.path, chunkPages, stride);
  if (!sliced) return run([{ path: evidence.path, from: 1, to: evidence.pageCount }]);
  try {
    return await run(sliced.slices);
  } finally {
    sliced.cleanup();
  }
}

async function extractAndClassifyProblems(
  entry: CorpusManifestEntry,
  evidence: PdfEvidence,
  stateDir: string
): Promise<ClassifiedQuestion[]> {
  return withSlices(evidence, 20, 19, async (slices) => {
    const combined: ClassifiedQuestion[] = [];
    for (const [index, slice] of slices.entries()) {
      const extractionPath = join(stateDir, "problem-chunks", `${String(index).padStart(4, "0")}.json`);
      let questions: QuizItemEx[];
      if (existsSync(extractionPath)) {
        const checkpoint = object(JSON.parse(readFileSync(extractionPath, "utf8")), "문제 체크포인트");
        if (
          checkpoint.version !== CHECKPOINT_VERSION || checkpoint.sourceHash !== evidence.sha256 ||
          checkpoint.from !== slice.from || checkpoint.to !== slice.to || checkpoint.model !== IMPORT_MODEL ||
          checkpoint.reasoningEffort !== IMPORT_REASONING_EFFORT
        ) throw new Error(`문제 체크포인트 메타데이터가 다릅니다: ${extractionPath}`);
        questions = restoredQuizItems(checkpoint.items);
      } else {
        questions = await extractProblemsFromFile(slice.path, "pdf", {
          sliceBase: slice.from,
          contentPageCount: slice.to - slice.from + 1,
          selfContained: true,
        });
        const nextFrom = slices[index + 1]?.from;
        if (nextFrom !== undefined) questions = questions.filter((question) => question.page !== nextFrom);
        for (const question of questions) questionKey(question);
        writeImmutableJson(extractionPath, {
          version: CHECKPOINT_VERSION,
          sourceHash: evidence.sha256,
          from: slice.from,
          to: slice.to,
          model: IMPORT_MODEL,
          reasoningEffort: IMPORT_REASONING_EFFORT,
          items: questions,
        });
      }
      if (questions.some((question) => question.page! < slice.from || question.page! > slice.to)) {
        throw new Error(`문제 체크포인트가 ${slice.from}-${slice.to} 페이지를 벗어났습니다`);
      }

      const classificationPath = join(
        stateDir,
        "classification-chunks",
        `${String(index).padStart(4, "0")}-${CLASSIFIER_DIGEST}.json`
      );
      let decisions: ClassificationDecision[];
      if (existsSync(classificationPath)) {
        const checkpoint = object(JSON.parse(readFileSync(classificationPath, "utf8")), "분류 체크포인트");
        if (
          checkpoint.version !== CLASSIFIER_VERSION || checkpoint.sourceHash !== evidence.sha256 ||
          checkpoint.from !== slice.from || checkpoint.to !== slice.to || checkpoint.rulesDigest !== CLASSIFIER_DIGEST ||
          checkpoint.model !== IMPORT_MODEL || checkpoint.reasoningEffort !== IMPORT_REASONING_EFFORT
        ) throw new Error(`분류 체크포인트 메타데이터가 다릅니다: ${classificationPath}`);
        decisions = parseDecisions(checkpoint.items, questions, entry);
      } else {
        decisions = await classifyQuestions(entry, slice.path, slice.from, slice.to, questions);
        writeImmutableJson(classificationPath, {
          version: CLASSIFIER_VERSION,
          sourceHash: evidence.sha256,
          from: slice.from,
          to: slice.to,
          rulesDigest: CLASSIFIER_DIGEST,
          model: IMPORT_MODEL,
          reasoningEffort: IMPORT_REASONING_EFFORT,
          items: decisions,
        });
      }
      const byKey = new Map(decisions.map((decision) => [decision.key, decision]));
      combined.push(...questions.map((question) => ({ question, classification: byKey.get(questionKey(question))! })));
    }

    combined.sort((a, b) => a.question.page! - b.question.page! || numericPrintedLocator(a.question.number)! - numericPrintedLocator(b.question.number)!);
    const keys = combined.map(({ question }) => questionKey(question));
    if (new Set(keys).size !== keys.length) throw new Error("같은 원본 페이지와 인쇄 번호가 중복되었습니다");
    validatePrintedQuestionSequence(combined.map(({ question }) => question));
    return combined;
  });
}

async function extractSolutions(evidence: PdfEvidence, stateDir: string): Promise<SolutionItem[]> {
  return withSlices(evidence, 6, 4, async (slices) => {
    const combined: SolutionItem[] = [];
    for (const [index, slice] of slices.entries()) {
      const checkpointPath = join(stateDir, "solution-chunks", `${String(index).padStart(4, "0")}.json`);
      let items: SolutionItem[];
      if (existsSync(checkpointPath)) {
        const checkpoint = object(JSON.parse(readFileSync(checkpointPath, "utf8")), "해설 체크포인트");
        if (
          checkpoint.version !== CHECKPOINT_VERSION || checkpoint.sourceHash !== evidence.sha256 ||
          checkpoint.from !== slice.from || checkpoint.to !== slice.to || checkpoint.model !== IMPORT_MODEL ||
          checkpoint.reasoningEffort !== IMPORT_REASONING_EFFORT
        ) throw new Error(`해설 체크포인트 메타데이터가 다릅니다: ${checkpointPath}`);
        items = parseSolutionItems(JSON.stringify(checkpoint.items));
      } else {
        items = await extractSolutionsFromFile(slice.path, "pdf", {
          sliceBase: slice.from,
          contentPageCount: slice.to - slice.from + 1,
        });
        const nextFrom = slices[index + 1]?.from;
        if (nextFrom !== undefined) items = items.filter((item) => item.page < nextFrom);
        writeImmutableJson(checkpointPath, {
          version: CHECKPOINT_VERSION,
          sourceHash: evidence.sha256,
          from: slice.from,
          to: slice.to,
          model: IMPORT_MODEL,
          reasoningEffort: IMPORT_REASONING_EFFORT,
          items,
        });
      }
      combined.push(...items);
    }
    combined.sort((a, b) => a.page - b.page || numericPrintedLocator(a.number)! - numericPrintedLocator(b.number)!);
    return combined;
  });
}

export function matchOfficialSolutions(
  classified: ClassifiedQuestion[],
  solutions: SolutionItem[]
): ImportedQuestion[] {
  const byNumber = new Map<number, SolutionItem>();
  for (const solution of solutions) {
    const number = numericPrintedLocator(solution.number);
    if (number === null || byNumber.has(number)) throw new Error(`해설 인쇄 번호가 없거나 중복입니다: ${solution.number}`);
    byNumber.set(number, solution);
  }
  if (byNumber.size !== classified.length) {
    throw new Error(`문제/해설 수 불일치: 문제 ${classified.length}, 해설 ${byNumber.size}`);
  }
  return classified.flatMap(({ question, classification }) => {
    const number = numericPrintedLocator(question.number)!;
    const solution = byNumber.get(number);
    if (!solution) throw new Error(`${number}번 공식 해설이 없습니다`);
    const choices = question.choices ? JSON.stringify(question.choices) : null;
    if (!gradeAnswer(question.qtype, question.answer, solution.answer, choices)) {
      throw new Error(`${number}번 추출 정답과 공식 해설 정답이 다릅니다`);
    }
    if (classification.decision !== "accept") return [];
    if (!solution.explanation.trim()) throw new Error(`${number}번 공식 해설 본문이 비어 있습니다`);
    return [{
      ...question,
      printedNumber: String(number),
      officialAnswer: solution.answer,
      officialExplanation: solution.explanation,
      solutionPage: solution.page,
      targetSubject: TARGET_BY_CANONICAL[classification.canonical_subject!],
      classification,
    }];
  });
}

function entryToken(entry: CorpusManifestEntry): string {
  return sha256Text(entry.id).slice(0, 24);
}

function subjectToken(subject: TargetSubject): string {
  return sha256Text(subject).slice(0, 16);
}

function evidenceKeys(entry: CorpusManifestEntry, subject: TargetSubject): { problem: string; solution: string } {
  const prefix = `corpus/${entryToken(entry)}/${subjectToken(subject)}`;
  return { problem: `${prefix}/problem.pdf`, solution: `${prefix}/solution.pdf` };
}

async function linkEvidence(source: PdfEvidence, filesDir: string, key: string): Promise<void> {
  const target = resolve(filesDir, key);
  const root = resolve(filesDir);
  if (target !== root && !target.startsWith(`${root}/`)) throw new Error("파일 저장 경로가 범위를 벗어났습니다");
  if (existsSync(target)) {
    if (await sha256File(target) !== source.sha256) throw new Error(`기존 corpus 파일 해시가 다릅니다: ${key}`);
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  try {
    copyFileSync(source.path, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      if (await sha256File(target) !== source.sha256) throw new Error(`기존 corpus 파일 해시가 다릅니다: ${key}`);
      return;
    }
    throw error;
  }
}

function schemaColumns(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name));
}

export function assertImportSchema(db: Database.Database): void {
  const required: Record<string, string[]> = {
    subjects: ["id", "name"],
    books: ["id", "subject_id", "title"],
    book_files: ["id", "book_id", "r2_key", "content_hash", "page_count", "progress"],
    book_items: ["book_id", "file_id", "category", "number", "answer", "content", "page", "has_figure", "figure_box"],
    questions: [
      "subject_id", "source", "book_id", "book_number", "printed_number", "src_file_id", "src_page",
      "has_figure", "figure_description", "figure_box",
    ],
  };
  for (const [table, columns] of Object.entries(required)) {
    const actual = schemaColumns(db, table);
    for (const column of columns) if (!actual.has(column)) throw new Error(`DB 스키마가 오래되었습니다: ${table}.${column}`);
  }
}

export function ensureCanonicalSubjects(db: Database.Database): Map<TargetSubject, number> {
  return db.transaction(() => {
    const ids = new Map<TargetSubject, number>();
    for (const name of TARGET_SUBJECTS) {
      const rows = db.prepare("SELECT id FROM subjects WHERE name = ? ORDER BY id").all(name) as { id: number }[];
      if (rows.length > 1) throw new Error(`같은 이름의 과목이 여러 개입니다: ${name}`);
      const id = rows[0]?.id ?? Number(db.prepare("INSERT INTO subjects (name) VALUES (?)").run(name).lastInsertRowid);
      ids.set(name, id);
    }
    return ids;
  }).immediate();
}

type ExistingBook = { id: number; problemFileId: number; solutionFileId: number };

function expectedQuestionRows(questions: ImportedQuestion[], problemKey: string) {
  return questions.map((question) => ({
    source: "uploaded",
    qtype: question.qtype,
    difficulty: question.difficulty,
    question: question.question,
    choices: question.choices ? JSON.stringify(question.choices) : null,
    answer: question.officialAnswer,
    explanation: question.officialExplanation,
    book_number: question.printedNumber,
    printed_number: question.printedNumber,
    src_page: question.page,
    has_figure: question.figure ? 1 : 0,
    figure_description: question.figure_description,
    figure_box: question.box ? question.box.join(",") : null,
    src_key: problemKey,
  }));
}

function expectedBookItems(questions: ImportedQuestion[], problemKey: string, solutionKey: string) {
  return questions.flatMap((question) => [
    {
      category: "문제",
      number: question.printedNumber,
      answer: question.officialAnswer,
      content: question.question,
      page: question.page,
      has_figure: question.figure ? 1 : 0,
      figure_box: question.box ? question.box.join(",") : null,
      file_key: problemKey,
    },
    {
      category: "해설",
      number: question.printedNumber,
      answer: question.officialAnswer,
      content: question.officialExplanation,
      page: question.solutionPage,
      has_figure: 0,
      figure_box: null,
      file_key: solutionKey,
    },
  ]);
}

function assertExistingBook(
  db: Database.Database,
  bookId: number,
  questions: ImportedQuestion[],
  keys: { problem: string; solution: string },
  problem: PdfEvidence,
  solution: PdfEvidence
): ExistingBook {
  const files = db.prepare(
    "SELECT id, r2_key, content_hash, page_count, status FROM book_files WHERE book_id = ? ORDER BY r2_key"
  ).all(bookId) as { id: number; r2_key: string; content_hash: string | null; page_count: number | null; status: string }[];
  if (files.length !== 2) throw new Error("기존 동일 제목 책은 importer 소유가 아닙니다");
  const problemFile = files.find((file) => file.r2_key === keys.problem);
  const solutionFile = files.find((file) => file.r2_key === keys.solution);
  if (
    !problemFile || !solutionFile || problemFile.status !== "ready" || solutionFile.status !== "ready" ||
    problemFile.content_hash !== problem.sha256 || solutionFile.content_hash !== solution.sha256 ||
    problemFile.page_count !== problem.pageCount || solutionFile.page_count !== solution.pageCount
  ) throw new Error("기존 동일 제목 책의 원본 근거가 importer 체크포인트와 다릅니다");

  const actualQuestions = db.prepare(
    `SELECT q.source, q.qtype, q.difficulty, q.question, q.choices, q.answer, q.explanation,
            q.book_number, q.printed_number, q.src_page, q.has_figure, q.figure_description, q.figure_box,
            bf.r2_key AS src_key
     FROM questions q LEFT JOIN book_files bf ON bf.id = q.src_file_id
     WHERE q.book_id = ? ORDER BY q.src_page, CAST(q.printed_number AS INTEGER), q.id`
  ).all(bookId);
  const expectedQuestions = expectedQuestionRows(questions, keys.problem);
  if (canonicalJson(actualQuestions) !== canonicalJson(expectedQuestions)) {
    throw new Error("기존 importer 문항이 변경되었거나 일부 삭제되었습니다; 덮어쓰지 않습니다");
  }

  const actualItems = db.prepare(
    `SELECT bi.category, bi.number, bi.answer, bi.content, bi.page, bi.has_figure, bi.figure_box,
            bf.r2_key AS file_key
     FROM book_items bi LEFT JOIN book_files bf ON bf.id = bi.file_id
     WHERE bi.book_id = ?`
  ).all(bookId);
  const expectedItems = expectedBookItems(questions, keys.problem, keys.solution);
  const sortedRows = (rows: unknown[]) => rows.map((row) => canonicalJson(row)).sort();
  if (canonicalJson(sortedRows(actualItems)) !== canonicalJson(sortedRows(expectedItems))) {
    throw new Error("기존 importer 근거 항목이 변경되었거나 일부 삭제되었습니다; 덮어쓰지 않습니다");
  }
  return { id: bookId, problemFileId: problemFile.id, solutionFileId: solutionFile.id };
}

function findBook(
  db: Database.Database,
  subjectId: number,
  title: string,
  keys: { problem: string; solution: string }
): number | null {
  const rows = db.prepare(
    `SELECT b.id,
            SUM(CASE WHEN bf.r2_key = ? THEN 1 ELSE 0 END) AS problem_files,
            SUM(CASE WHEN bf.r2_key = ? THEN 1 ELSE 0 END) AS solution_files
     FROM books b LEFT JOIN book_files bf ON bf.book_id = b.id
     WHERE b.subject_id = ? AND b.title = ?
     GROUP BY b.id ORDER BY b.id`
  ).all(keys.problem, keys.solution, subjectId, title) as {
    id: number;
    problem_files: number;
    solution_files: number;
  }[];
  const exact = rows.filter((row) => row.problem_files === 1 && row.solution_files === 1);
  if (exact.length > 1) throw new Error(`같은 manifest entry가 여러 번 저장되었습니다: ${title}`);
  if (exact.length === 1) return exact[0].id;
  if (rows.some((row) => row.problem_files > 0 || row.solution_files > 0)) {
    throw new Error(`기존 importer 책의 원본 근거가 일부 삭제되었습니다: ${title}`);
  }
  return null;
}

export async function commitCorpusEntry(
  db: Database.Database,
  filesDir: string,
  entry: CorpusManifestEntry,
  problem: PdfEvidence,
  solution: PdfEvidence,
  questions: ImportedQuestion[],
  previouslyCommitted = false
): Promise<{ insertedTargets: TargetSubject[]; existingTargets: TargetSubject[] }> {
  if (questions.length === 0) throw new Error("저장할 corpus 문항이 없습니다");
  const groups = new Map<TargetSubject, ImportedQuestion[]>();
  for (const question of questions) {
    if (!question.officialAnswer.trim() || !question.officialExplanation.trim()) {
      throw new Error(`${question.printedNumber}번 공식 정답 또는 해설이 비어 있습니다`);
    }
    const group = groups.get(question.targetSubject) ?? [];
    group.push(question);
    groups.set(question.targetSubject, group);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.page! - b.page! || Number(a.printedNumber) - Number(b.printedNumber));
  }
  const subjectIds = ensureCanonicalSubjects(db);

  for (const [subject, group] of groups) {
    const keys = evidenceKeys(entry, subject);
    const title = examBookTitle(entry);
    const id = findBook(db, subjectIds.get(subject)!, title, keys);
    if (previouslyCommitted && id === null) {
      throw new Error(`이전 import 책이 삭제되었습니다; 자동 복원하지 않습니다: ${subject} / ${title}`);
    }
    if (id !== null) {
      assertExistingBook(db, id, group, keys, problem, solution);
    }
  }

  for (const subject of groups.keys()) {
    const keys = evidenceKeys(entry, subject);
    await linkEvidence(problem, filesDir, keys.problem);
    await linkEvidence(solution, filesDir, keys.solution);
  }

  return db.transaction(() => {
    const insertedTargets: TargetSubject[] = [];
    const existingTargets: TargetSubject[] = [];
    for (const [subject, group] of groups) {
      const subjectId = subjectIds.get(subject)!;
      const keys = evidenceKeys(entry, subject);
      const title = examBookTitle(entry);
      const existing = findBook(db, subjectId, title, keys);
      if (existing !== null) {
        assertExistingBook(db, existing, group, keys, problem, solution);
        existingTargets.push(subject);
        continue;
      }

      const bookId = Number(db.prepare("INSERT INTO books (subject_id, title) VALUES (?, ?)").run(subjectId, title).lastInsertRowid);
      const problemFileId = Number(db.prepare(
        `INSERT INTO book_files
         (book_id, name, r2_key, mime, status, error, progress, content_hash, page_count, chunk_total)
         VALUES (?, ?, ?, 'application/pdf', 'ready', NULL, 100, ?, ?, ?)`
      ).run(
        bookId,
        safeUploadName(`${title} 문제.pdf`),
        keys.problem,
        problem.sha256,
        problem.pageCount,
        Math.max(1, Math.ceil((problem.pageCount - 1) / 19)),
      ).lastInsertRowid);
      const solutionFileId = Number(db.prepare(
        `INSERT INTO book_files
         (book_id, name, r2_key, mime, status, error, progress, content_hash, page_count, chunk_total)
         VALUES (?, ?, ?, 'application/pdf', 'ready', NULL, 100, ?, ?, 0)`
      ).run(
        bookId,
        safeUploadName(`${title} 해설.pdf`),
        keys.solution,
        solution.sha256,
        solution.pageCount,
      ).lastInsertRowid);

      const insertQuestion = db.prepare(
        `INSERT INTO questions
         (subject_id, source, qtype, difficulty, question, choices, answer, explanation,
          book_id, book_number, printed_number, src_file_id, src_page, has_figure,
          figure_description, figure_box)
         VALUES (?, 'uploaded', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insertItem = db.prepare(
        `INSERT INTO book_items
         (book_id, file_id, category, number, answer, content, page, has_figure, figure_box)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const question of group) {
        const choices = question.choices ? JSON.stringify(question.choices) : null;
        insertQuestion.run(
          subjectId,
          question.qtype,
          question.difficulty,
          question.question,
          choices,
          question.officialAnswer,
          question.officialExplanation,
          bookId,
          question.printedNumber,
          question.printedNumber,
          problemFileId,
          question.page,
          question.figure ? 1 : 0,
          question.figure_description,
          question.box ? question.box.join(",") : null,
        );
        insertItem.run(
          bookId,
          problemFileId,
          "문제",
          question.printedNumber,
          question.officialAnswer,
          question.question,
          question.page,
          question.figure ? 1 : 0,
          question.box ? question.box.join(",") : null,
        );
        insertItem.run(
          bookId,
          solutionFileId,
          "해설",
          question.printedNumber,
          question.officialAnswer,
          question.officialExplanation,
          question.solutionPage,
          0,
          null,
        );
      }
      insertedTargets.push(subject);
    }
    return { insertedTargets, existingTargets };
  }).immediate();
}

type EntryResult = {
  id: string;
  status: "imported" | "existing" | "filtered" | "review" | "skipped" | "error";
  accepted: number;
  message?: string;
};

async function processEntry(
  db: Database.Database,
  dataDir: string,
  entry: CorpusManifestEntry
): Promise<EntryResult> {
  if (!SUPPORTED_SOURCES.has(entry.subject)) return { id: entry.id, status: "skipped", accepted: 0 };
  const stateDir = join(dataDir, "import-exam-corpus", entryToken(entry));
  mkdirSync(stateDir, { recursive: true });
  writeImmutableJson(join(stateDir, "entry.json"), { schemaVersion: 1, entry: entry.raw });
  const resultPath = join(stateDir, "result.json");
  if (existsSync(resultPath)) {
    const result = object(JSON.parse(readFileSync(resultPath, "utf8")), "result.json");
    if (result.version !== 1 || result.status !== "filtered" || result.entryId !== entry.id) {
      throw new Error("기존 result.json이 유효하지 않습니다");
    }
    return { id: entry.id, status: "filtered", accepted: 0, message: String(result.reason ?? "filtered") };
  }
  if (["통합과학", "통합사회"].includes(entry.subject) && ![1, 2].includes(entry.grade ?? 0)) {
    writeImmutableJson(resultPath, {
      version: 1,
      status: "filtered",
      entryId: entry.id,
      reason: "SOURCE_GRADE_OUT_OF_SCOPE",
      sourceQuestionCount: null,
      acceptedQuestionCount: 0,
      rejectedQuestionCount: null,
      reviewQuestionCount: 0,
    });
    return { id: entry.id, status: "filtered", accepted: 0, message: "통합과학/통합사회 고1·고2 원본만 허용" };
  }
  const problem = await downloadPdf(entry.problemPdfUrl, entry.sourcePageUrl, join(stateDir, "problem.pdf"));
  const solution = await downloadPdf(entry.solutionPdfUrl, entry.sourcePageUrl, join(stateDir, "solution.pdf"));
  writeImmutableJson(join(stateDir, "downloads.json"), {
    version: 1,
    problem: {
      path: "problem.pdf",
      requestedUrl: problem.requestedUrl,
      sha256: problem.sha256,
      bytes: problem.bytes,
      pageCount: problem.pageCount,
    },
    solution: {
      path: "solution.pdf",
      requestedUrl: solution.requestedUrl,
      sha256: solution.sha256,
      bytes: solution.bytes,
      pageCount: solution.pageCount,
    },
  });

  const classified = await extractAndClassifyProblems(entry, problem, stateDir);
  const reviews = classified.filter(({ classification }) => classification.decision === "review");
  if (reviews.length > 0) {
    return { id: entry.id, status: "review", accepted: 0, message: `${reviews.length}문항 수동 검토 필요` };
  }
  const acceptedCount = classified.filter(({ classification }) => classification.decision === "accept").length;
  if (acceptedCount === 0) {
    writeImmutableJson(resultPath, {
      version: 1,
      status: "filtered",
      entryId: entry.id,
      reason: "NO_IN_SCOPE_QUESTIONS",
      rulesDigest: CLASSIFIER_DIGEST,
      sourceQuestionCount: classified.length,
      acceptedQuestionCount: 0,
      rejectedQuestionCount: classified.length,
      reviewQuestionCount: 0,
    });
    return { id: entry.id, status: "filtered", accepted: 0 };
  }

  const solutions = await extractSolutions(solution, stateDir);
  const imported = matchOfficialSolutions(classified, solutions);
  const receiptPath = join(stateDir, "receipt.json");
  const receipt = {
    version: 1,
    status: "committed",
    entryId: entry.id,
    examTitle: entry.examTitle,
    rawTitle: entry.rawTitle,
    bookTitle: examBookTitle(entry),
    variant: entry.variant,
    form: entry.form,
    sourceSubject: entry.subject,
    grade: entry.grade,
    rulesDigest: CLASSIFIER_DIGEST,
    sourceQuestionCount: classified.length,
    acceptedQuestionCount: imported.length,
    rejectedQuestionCount: classified.length - imported.length,
    reviewQuestionCount: 0,
    problemHash: problem.sha256,
    solutionHash: solution.sha256,
    targetBooks: [...new Set(imported.map((question) => question.targetSubject))].sort().map((subject) => {
      const keys = evidenceKeys(entry, subject);
      return {
        subject,
        examTitle: entry.examTitle,
        bookTitle: examBookTitle(entry),
        expectedQuestionCount: imported.filter((question) => question.targetSubject === subject).length,
        problemR2Key: keys.problem,
        solutionR2Key: keys.solution,
      };
    }),
  };
  if (existsSync(receiptPath)) writeImmutableJson(receiptPath, receipt);
  const commit = await commitCorpusEntry(db, join(dataDir, "files"), entry, problem, solution, imported, existsSync(receiptPath));
  writeImmutableJson(receiptPath, receipt);
  return {
    id: entry.id,
    status: commit.insertedTargets.length > 0 ? "imported" : "existing",
    accepted: imported.length,
  };
}

function acquireRunLock(stateRoot: string): () => void {
  mkdirSync(stateRoot, { recursive: true });
  const path = join(stateRoot, ".lock");
  const token = randomUUID();
  const claim = () => {
    const descriptor = openSync(path, "wx");
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token }));
    closeSync(descriptor);
  };
  try {
    claim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let active = true;
    try {
      const owner = object(JSON.parse(readFileSync(path, "utf8")), "import lock");
      const pid = Number(owner.pid);
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("invalid pid");
      try {
        process.kill(pid, 0);
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === "ESRCH") active = false;
      }
    } catch {
      active = false;
    }
    if (active) throw new Error("다른 corpus importer가 실행 중입니다");
    unlinkSync(path);
    claim();
  }
  return () => {
    try {
      const owner = object(JSON.parse(readFileSync(path, "utf8")), "import lock");
      if (owner.token === token) unlinkSync(path);
    } catch {
      // Another process or manual recovery owns the path now.
    }
  };
}

function usage(): string {
  return "npx tsx scripts/import-exam-corpus.ts --manifest data/ebsi-exam-manifest.json [--data-dir ./data] [--commit]";
}

function cliOptions(argv: string[]): { manifest: string; dataDir: string; commit: boolean } {
  let manifest = "";
  let dataDir = process.env.DATA_DIR || "./data";
  let commit = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--manifest") manifest = argv[++index] ?? "";
    else if (arg === "--data-dir") dataDir = argv[++index] ?? "";
    else if (arg === "--commit") commit = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else throw new Error(`알 수 없는 옵션: ${arg}`);
  }
  if (!manifest) throw new Error(`--manifest가 필요합니다\n${usage()}`);
  if (!dataDir) throw new Error("--data-dir가 비어 있습니다");
  return { manifest: resolve(manifest), dataDir: resolve(dataDir), commit };
}

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* optional */ }
  const options = cliOptions(process.argv.slice(2));
  const manifest = parseCorpusManifest(JSON.parse(readFileSync(options.manifest, "utf8")));
  const supported = manifest.entries.filter((entry) => SUPPORTED_SOURCES.has(entry.subject));
  console.log(`manifest ${manifest.entries.length}개, 대상 ${supported.length}개, 제외 ${manifest.entries.length - supported.length}개`);
  console.log(`AI ${IMPORT_MODEL} / ${IMPORT_REASONING_EFFORT}, 동시 작업 ${IMPORT_CONCURRENCY}개`);
  if (!options.commit) {
    console.log("dry-run 완료. 다운로드·AI·DB 쓰기 없음. 실제 실행은 --commit 추가.");
    return;
  }

  process.env.STUDYWORK_AI_MODEL = IMPORT_MODEL;
  process.env.STUDYWORK_AI_REASONING_EFFORT = IMPORT_REASONING_EFFORT;
  process.env.STUDYWORK_AI_MAX_CONCURRENCY = String(IMPORT_CONCURRENCY);
  const dbPath = join(options.dataDir, "studywork.db");
  if (!existsSync(dbPath)) throw new Error(`StudyWork DB가 없습니다: ${dbPath}`);
  const releaseLock = acquireRunLock(join(options.dataDir, "import-exam-corpus"));
  const db = new Database(dbPath);
  try {
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    assertImportSchema(db);
    ensureCanonicalSubjects(db);
    const results = await mapPool(manifest.entries, IMPORT_CONCURRENCY, async (entry) => {
      try {
        const result = await processEntry(db, options.dataDir, entry);
        console.log(`${result.status.padEnd(8)} ${entry.id} ${result.accepted}`);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`error    ${entry.id} ${message}`);
        return { id: entry.id, status: "error", accepted: 0, message } satisfies EntryResult;
      }
    });
    const failed = results.filter((result) => result.status === "error" || result.status === "review");
    const accepted = results.reduce((sum, result) => sum + result.accepted, 0);
    console.log(`완료: ${accepted}문항, 보류/오류 ${failed.length}시험`);
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    db.close();
    releaseLock();
  }
}

const mainPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (mainPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
