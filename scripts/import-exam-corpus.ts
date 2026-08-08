#!/usr/bin/env tsx

import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { open as openFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PDFDocument } from "pdf-lib";
import {
  extractProblemsFromFile,
  extractSolutionsFromFile,
  mapPool,
  numericPrintedLocator,
  parseQuizItemsEx,
  parseSolutionItems,
  pdfPageCount,
  QUIZ_EXTRACT_SPEC,
  slicePdf,
  TARGETED_PROBLEM_BATCH_RULES,
  TARGETED_PROBLEM_BATCH_VERSION,
  TARGETED_PROBLEM_TRANSCRIPTION_RULES,
  TARGETED_PROBLEM_TRANSCRIPTION_VERSION,
  TARGETED_PROBLEM_REVISION_RULES,
  TARGETED_PROBLEM_REVISION_VERSION,
  TARGETED_PROBLEM_REVISION_EVIDENCE_PREFIX,
  TARGETED_PROBLEM_RECOVERY_RULES,
  TARGETED_PROBLEM_RECOVERY_VERSION,
  TARGETED_PROBLEM_RECOVERY_EVIDENCE_PREFIX,
  TARGETED_SOLUTION_TRANSCRIPTION_RULES,
  TARGETED_SOLUTION_TRANSCRIPTION_VERSION,
  TARGETED_SOLUTION_REVISION_RULES,
  TARGETED_SOLUTION_REVISION_VERSION,
  TARGETED_SOLUTION_REVISION_EVIDENCE_PREFIX,
  validatePrintedQuestionSequence,
  type QuizItemEx,
  type SolutionItem,
} from "../src/claude";
import {
  getCodexProvider,
  type AIJsonSchema,
} from "../src/codex-provider";
import { MAX_PDF_BYTES, MAX_PDF_PAGES, safeUploadName } from "../src/upload";

export const IMPORT_MODEL = "gpt-5.6-sol";
export const IMPORT_REASONING_EFFORT = "high" as const;
export const IMPORT_CONCURRENCY = 15;
export function parseImporterFullContextConcurrency(value: string | undefined): number {
  const parsed = value?.trim() ? Number(value) : 8;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > IMPORT_CONCURRENCY) {
    throw new Error(`STUDYWORK_IMPORT_FULL_CONCURRENCY는 1-${IMPORT_CONCURRENCY} 정수여야 합니다`);
  }
  return parsed;
}
export const FULL_CONTEXT_CONCURRENCY = parseImporterFullContextConcurrency(
  process.env.STUDYWORK_IMPORT_FULL_CONCURRENCY
);
export const PROBLEM_SLICE_PAGES = 20;
export const PROBLEM_SLICE_STRIDE = 18;
export const SOLUTION_SLICE_PAGES = 6;
export const SOLUTION_SLICE_STRIDE = 4;
export const PROBLEM_REPAIR_VERSION = 2;
export const CLASSIFICATION_REPAIR_VERSION = 4;
export const PROBLEM_REPAIR_BATCH_VERSION = 2;
export const CLASSIFICATION_REPAIR_BATCH_VERSION = 1;
export const PROBLEM_REVISION_VERSION = 1;
export const CLASSIFICATION_REVISION_VERSION = 2;
export const PROBLEM_REVISION_BATCH_VERSION = 1;
export const CLASSIFICATION_REVISION_BATCH_VERSION = 1;
export const PROBLEM_RECOVERY_VERSION = 1;
export const CLASSIFICATION_RECOVERY_VERSION = 1;
export const SOLUTION_FIDELITY_VERSION = 1;
export const SOLUTION_FIDELITY_SLICE_PAGES = 22;
export const SOLUTION_FIDELITY_SLICE_STRIDE = 18;
export const SOLUTION_REPAIR_VERSION = 1;
export const SOLUTION_REPAIR_FIDELITY_VERSION = 1;
export const SOLUTION_REVISION_VERSION = 1;
export const SOLUTION_REVISION_FIDELITY_VERSION = 1;
export const PROBLEM_TERMINAL_FIDELITY_VERSION = 2;
export const SEMANTIC_CHOICE_CHECK_VERSION = 4;
export const ANSWER_AUDIT_VERSION = 4;
export const ANSWER_ATTESTATION_VERSION = 4;

const execFileP = promisify(execFile);

function semaphore(max: number): () => Promise<() => void> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async () => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiting.shift();
      if (next) next();
      else active--;
    };
  };
}

export function createImporterAiScheduler(totalMax: number, fullMax: number) {
  const acquireTotal = semaphore(totalMax);
  const acquireFull = semaphore(fullMax);
  const targeted = async <T>(run: () => Promise<T>): Promise<T> => {
    const releaseTotal = await acquireTotal();
    try { return await run(); } finally { releaseTotal(); }
  };
  const full = async <T>(run: () => Promise<T>): Promise<T> => {
    const releaseFull = await acquireFull();
    const releaseTotal = await acquireTotal();
    try { return await run(); } finally {
      releaseTotal();
      releaseFull();
    }
  };
  return { full, targeted };
}

const importerAi = createImporterAiScheduler(IMPORT_CONCURRENCY, FULL_CONTEXT_CONCURRENCY);
const withFullContextAi = importerAi.full;
const withTargetedAi = importerAi.targeted;

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
const EXPECTED_QUESTION_COUNT: Record<SourceSubject, number> = {
  국어: 45,
  수학: 30,
  영어: 45,
  한국사: 20,
  통합사회: 20,
  통합과학: 20,
};
export const CLASSIFIER_VERSION = 5;
export const TRANSCRIPTION_GATE_VERSION = 2;
const CHECKPOINT_VERSION = 2;
export const SOLUTION_CHECKPOINT_VERSION = 3;

export const CURRICULUM_RULES = `
Classify each question from the complete attached passage, stem, choices, tables, and figures. Never classify from the filename or exam label alone.

Return decision accept, reject, or review. Scope is determined by every concept necessary to solve the question, not by the number of domains or achievement codes. If every necessary concept belongs to one canonical subject, accept under that canonical subject even when multiple domains or codes are required; combine the domain names in one descriptive string and return every applicable allowed achievement code. This is not mixed scope. For example, logarithms plus a finite sequence sum accepts as math_B.

If solving necessarily depends on even one excluded or out-of-target concept, reject the whole question, even when another necessary component is in scope. If necessary concepts span two canonical subjects, reject because no single target contains the whole question. Examples that reject include coordinate geometry plus a sequence or logarithm; rational functions plus a sequence; binomial theorem or combinatorial counting plus math_A or math_B; and finite-set or bijection reasoning plus logarithms.

Use review only for genuine ambiguity, missing or unclear visual/passage context, or uncertainty about whether an excluded concept is actually necessary. Do not use review merely because multiple domains or codes are required, and do not use it when a required excluded dependency is clear. An accept needs confidence >= 0.90, one canonical_subject, a curriculum_course, a domain, at least one achievement code, and reason codes. Emit achievement codes as exact bare codes shown below, without brackets, spaces, abbreviations, or invented ranges. Non-accept decisions use canonical_subject null. Keep every input key exactly once.

MATH_A aliases 2015 수학Ⅱ and 2022 미적분Ⅰ. Accept 함수의 극한과 연속 [12미적Ⅰ-01-01..04] or legacy [12수학Ⅱ01-01..04], 미분 [12미적Ⅰ-02-01..10] or legacy [12수학Ⅱ02-01..11], 적분 [12미적Ⅰ-03-01..06] or legacy [12수학Ⅱ03-01..06]. Reject 2015 선택 미적분/2022 미적분Ⅱ-only content: 수열의 극한·급수, 지수·로그·삼각함수 미분, 합성·매개·음함수 미분, 치환·부분적분. 미적분Ⅰ differentiation/integration stays polynomial scope; motion applications stay straight-line.

MATH_B aliases 2015 수학Ⅰ and 2022 대수. Accept 지수함수와 로그함수 [12대수01-01..08] or [12수학Ⅰ01-01..08], 삼각함수 [12대수02-01..03] or [12수학Ⅰ02-01..03], 수열 [12대수03-01..07] or [12수학Ⅰ03-01..08]. Reject common-math polynomial/equations/matrices/probability, advanced trigonometry, sequence limits, and infinite series. In-scope trigonometry is general angle/radian, sin/cos/tan graphs, and sine/cosine laws. In-scope sequences are arithmetic/geometric, sigma/sums, recursive definition, and induction; finding a general term from a recursive definition is out of scope.

KOREAN_READING accepts nonfiction comprehension whose tested construct is factual, inferential, or critical reading; argument, structure, evidence, cross-text synthesis, or contextual vocabulary. Anchors: [10공국1-02-01..02], [10공국2-02-01..03], [12독작01-03..04]. For mixed 독서와 작문 codes 02,05,07-09,12-14, accept only when the answer requires comprehension/evaluation of the supplied text, not planning, producing, or revising writing. Reject speech/listening/presentation/discussion/debate/negotiation, composition/draft/revision, grammar/phonology/morphology/syntax/semantics/history/spelling, and media as the assessed construct. Incidental charts/images remain reading. Contextual word meaning remains reading; word formation or grammar rules reject.

KOREAN_LITERATURE accepts literary comprehension and interpretation across poetry, sijo/classical verse, modern/classical fiction, drama, and literary essay: speaker/narrator/character, imagery/figurative/form, plot/conflict, theme, context/comparison/criticism. Anchors: [10공국1-05-01..03], [10공국2-05-01..02], [12문학01-01..08,10..12]. For [12문학01-09], accept only when literary meaning is assessed; media form, camera, editing, or platform effect rejects or reviews. Shared sets may split: accept in-scope siblings and reject excluded siblings while retaining the shared passage in the question evidence.

INTEGRATED_SCIENCE accepts only source school grade 1 or 2 and one of: 통합과학1 과학의 기초 [10통과1-01-01..04], 물질과 규칙성 [10통과1-02-01..06], 시스템과 상호작용 [10통과1-03-01..06]; 통합과학2 변화와 다양성 [10통과2-01-01..05], 환경과 에너지 [10통과2-02-01..06], 과학과 미래 사회 [10통과2-03-01..04]. Numerals 1/2 in course names are course halves, not school grades. Reject elective-depth dependencies. Hard bounds: no sensor operating principle; bonding property only conductivity; no detailed silicate/protein/nucleic structures; no semiconductor junction; redox without oxidation numbers; Arrhenius acid/base only; neutralization temperature/indicator only; no thermochemical equations/enthalpy; solar fusion and induction qualitative only.

INTEGRATED_SOCIAL accepts only source school grade 1 or 2 and one of: 통합사회1 통합적 관점 [10통사1-01-01..02], 인간·사회·환경과 행복 [10통사1-02-01..02], 자연환경과 인간 [10통사1-03-01..03], 문화와 다양성 [10통사1-04-01..04], 생활공간과 사회 [10통사1-05-01..03]; 통합사회2 인권보장과 헌법 [10통사2-01-01..03], 사회정의와 불평등 [10통사2-02-01..03], 시장경제와 지속가능발전 [10통사2-03-01..04], 세계화와 평화 [10통사2-04-01..03], 미래와 지속가능한 삶 [10통사2-05-01..03]. Reject elective-depth-only geography/history/sociology/politics/law/economics. Detailed macro/micro models, elasticity calculations, advanced legal doctrine/procedure, named-region factual recall, sociology research methods, or philosopher-specific doctrine not supplied in the stimulus reject or review.
`.trim();

export const CLASSIFIER_DIGEST = createHash("sha256").update(CURRICULUM_RULES).digest("hex").slice(0, 16);

export const TRANSCRIPTION_GATE_RULES = `
Independently compare every supplied transcription with the attached official source pixels. Check the complete shared passage and source material, the full stem, every answer choice and distractor, inequalities, signs, coefficients, exponents, fractions, formulas, tables, qtype, and all figure or visual dependencies including figure_description. Check that box plausibly covers the source problem and figure, without requiring pixel-perfect crop decimals. Do not infer fidelity from plausibility or from the proposed answer. Base the curriculum decision on the source pixels, not on an inaccurate supplied transcription.

Any summary, abridgment, omission, or paraphrase is mismatch, even when the question remains solvable. This includes every shared passage sentence, worked example, transition, quotation, annotation, and footnote required by the printed question or source set. Exact preserves the source literally rather than merely preserving meaning.

Visible text, formulas, numbers, and labels must remain literal. Whitespace, layout, and equivalent LaTeX normalization are allowed only when every sign, value, bound, label, and source detail is preserved. Only a genuinely non-text visual glyph may use an accessibility text surrogate, and only when figure_description preserves its identity, occurrence order, orientation, count, and role in the source.

Return transcription_status exact only when all source-required content is faithfully represented. Return mismatch when any omission, substitution, changed bound/sign/value/formula/choice, wrong qtype, or inaccurate visual description is visible. Return unverifiable when the pixels or required context do not let you decide confidently; never guess exact. Give concise page-grounded transcription_evidence. Curriculum decision and transcription fidelity are independent, so reject and review items still require this source check.
`.trim();

export const TRANSCRIPTION_PROMPT_DIGEST = createHash("sha256")
  .update(`${TRANSCRIPTION_GATE_VERSION}\n${TRANSCRIPTION_GATE_RULES}`)
  .digest("hex");

export const PROBLEM_TERMINAL_SCOPE_RULES = `
The prior curriculum decision is intentionally hidden. Independently decide whether each source-pixel problem is
accept, reject, or review under the supplied curriculum rules. Keep this scope decision independent from transcription
fidelity: a mistranscribed item can still have a clear source-pixel scope. Give confidence from 0 through 1 and concise
evidence grounded in the original source page and the decisive required concept. Never infer scope from the supplied
transcription when it disagrees with the pixels. Scope output for an exact transcription is an audit observation only;
it never overrides the existing classifier decision.
`.trim();

export const PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST = createHash("sha256")
  .update(`${PROBLEM_TERMINAL_FIDELITY_VERSION}\n${PROBLEM_TERMINAL_SCOPE_RULES}\n${CURRICULUM_RULES}`)
  .digest("hex");

export const SOLUTION_FIDELITY_RULES = `
Independently compare every supplied accepted official solution with the attached official solution PDF pixels. Report the visible page where that numbered solution starts. Check the supplied raw final answer separately from the complete explanation through its final step. Compare every sign, coefficient, exponent, root index, fraction, formula, table, diagram, and conclusion. LaTeX normalization is allowed only when it preserves every mathematical and Korean source detail.

answerStatus is exact only when an explicit final answer is visible in these pixels and faithfully matches raw_answer; mismatch when a visible official answer differs; not_visible only when no explicit answer is visible in this attached range; unverifiable when pixels are unclear. Do not call a value derived from the reasoning exact. explanationStatus is exact only when the full reasoning is faithful and complete; mismatch for any omission, substitution, changed formula/value, truncated continuation, summary, invented step, or missing source-required table/diagram description; unverifiable when the pixels or continuation context do not support a confident decision. A redundant visual need not be narrated, but explain that it is redundant in evidence. Never guess exact. Give concise page-grounded evidence and keep every input key exactly once.
`.trim();

export const SOLUTION_FIDELITY_PROMPT_DIGEST = createHash("sha256")
  .update(`${SOLUTION_FIDELITY_VERSION}\n${SOLUTION_FIDELITY_RULES}`)
  .digest("hex");

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
            transcription_status: { type: "string", enum: ["exact", "mismatch", "unverifiable"] },
            transcription_evidence: { type: "string" },
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
            "transcription_status",
            "transcription_evidence",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
};

const PROBLEM_TERMINAL_FIDELITY_SCHEMA: AIJsonSchema = {
  name: "studywork_exam_corpus_problem_terminal_fidelity",
  description: "Independent source-pixel fidelity audit for every final problem transcription.",
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
            status: { type: "string", enum: ["exact", "mismatch", "unverifiable"] },
            evidence: { type: "string" },
            scopeDecision: { type: "string", enum: ["accept", "reject", "review"] },
            scopeConfidence: { type: "number", minimum: 0, maximum: 1 },
            scopeEvidence: { type: "string" },
          },
          required: ["key", "status", "evidence", "scopeDecision", "scopeConfidence", "scopeEvidence"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
};

const SEMANTIC_CHOICE_RULES =
  `For each item, use only its official detailed explanation and answer-choice contents to identify the one ` +
  `choice semantically supported by the reasoning. The official answer marker and the problem extractor's answer ` +
  `are intentionally hidden and must not be guessed; ordinal markers inside explanations are redacted. ` +
  `Return ambiguous when the explanation does not establish ` +
  `exactly one choice. choiceIndex is 1-based and evidence must briefly cite the decisive value or conclusion.`;

const SEMANTIC_CHOICE_SCHEMA: AIJsonSchema = {
  name: "studywork_exam_corpus_semantic_choice_check",
  description: "Semantic choice indexes grounded only in official detailed explanations.",
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
            status: { type: "string", enum: ["resolved", "ambiguous"] },
            choiceIndex: { type: ["integer", "null"], minimum: 1, maximum: 10 },
            evidence: { type: "string" },
          },
          required: ["key", "status", "choiceIndex", "evidence"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
};

const SOLUTION_FIDELITY_SCHEMA: AIJsonSchema = {
  name: "studywork_exam_corpus_solution_fidelity",
  description: "Source-pixel fidelity decisions for accepted official solution transcriptions.",
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
            sourcePage: { type: "integer", minimum: 1 },
            answerStatus: { type: "string", enum: ["exact", "mismatch", "not_visible", "unverifiable"] },
            explanationStatus: { type: "string", enum: ["exact", "mismatch", "unverifiable"] },
            evidence: { type: "string" },
          },
          required: ["key", "sourcePage", "answerStatus", "explanationStatus", "evidence"],
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
  sourceRecordDate: string;
  sourceRecordYear: number;
  variant: string | null;
  form: "odd" | "even" | null;
  sourcePageUrl: string;
  problemPdfUrl: string;
  solutionPdfUrl: string;
  grade: number | null;
  raw: Record<string, unknown>;
};

export type CorpusManifest = {
  schemaVersion: 2;
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
  transcription_status: "exact" | "mismatch" | "unverifiable";
  transcription_evidence: string;
};

export type ProblemTerminalFidelityItem = {
  key: string;
  status: "exact" | "mismatch" | "unverifiable";
  evidence: string;
  scopeDecision: "accept" | "reject" | "review";
  scopeConfidence: number;
  scopeEvidence: string;
};

export type ProblemTerminalFidelityCheckpoint = EvidencePointer & {
  from: number;
  to: number;
  ownedFrom: number;
  ownedTo: number;
  inputHash: string;
};

export type PdfEvidence = {
  path: string;
  sha256: string;
  bytes: number;
  pageCount: number;
  requestedUrl: string;
  resolvedUrl: string;
  requiresNormalization?: boolean;
};

export type ImportedQuestion = QuizItemEx & {
  printedNumber: string;
  officialAnswer: string;
  officialExplanation: string;
  solutionPage: number;
  targetSubject: TargetSubject;
  classification: ClassificationDecision;
};

export type ClassifiedQuestion = {
  question: QuizItemEx;
  classification: ClassificationDecision;
};

export function transcriptionRepairKeys(classified: ClassifiedQuestion[]): string[] {
  return classified.flatMap(({ question, classification }) =>
    classification.transcription_status === "exact" ? [] : [questionKey(question)]
  );
}

export type ProblemRepairEvidence = {
  key: string;
  printedNumber: string;
  sourcePage: number;
  contextFrom: number;
  contextTo: number;
  baseProblemCheckpoint: { path: string; sha256: string };
  baseClassificationCheckpoint: { path: string; sha256: string };
  baseSolutionCheckpoint: { path: string; sha256: string };
  problemArtifact: { path: string; sha256: string };
  problemArtifactItemHash?: string;
  classificationArtifact: {
    path: string;
    sha256: string;
    rulesDigest: string;
    transcriptionGateVersion: number;
    transcriptionPromptDigest: string;
  };
  classificationArtifactItemHash?: string;
  baseQuestionHash: string;
  effectiveQuestionHash: string;
  baseClassificationHash: string;
  effectiveClassificationHash: string;
  baseSolutionItemHash: string;
  officialRawAnswerHash: string;
  revision?: ProblemRevisionEvidence;
};

export type ProblemRevisionEvidence = {
  baseProblemRepairArtifact: { path: string; sha256: string };
  baseClassificationRepairArtifact: { path: string; sha256: string };
  problemArtifact: { path: string; sha256: string };
  classificationArtifact: {
    path: string;
    sha256: string;
    rulesDigest: string;
    transcriptionGateVersion: number;
    transcriptionPromptDigest: string;
    revisionPromptVersion?: number;
    revisionPromptDigest?: string;
  };
  diagnosticEvidenceHash: string;
  baseQuestionHash: string;
  effectiveQuestionHash: string;
  baseClassificationHash: string;
  effectiveClassificationHash: string;
  problemArtifactItemHash?: string;
  classificationArtifactItemHash?: string;
  trigger?: {
    kind: "classification" | "terminal";
    evidenceHash: string;
    terminalCheckpoint?: ProblemTerminalFidelityCheckpoint;
    terminalItemHash?: string;
  };
  recovery?: ProblemRecoveryEvidence;
};

export type ProblemRecoveryEvidence = {
  key: string;
  printedNumber: string;
  sourcePage: number;
  sourceHash: string;
  contextFrom: number;
  contextTo: number;
  baseProblemRepairArtifact: EvidencePointer;
  baseProblemRepairItemHash: string;
  baseClassificationRepairArtifact: EvidencePointer;
  baseClassificationRepairItemHash: string;
  baseProblemRevisionArtifact: EvidencePointer;
  baseProblemRevisionItemHash: string;
  baseClassificationRevisionArtifact: EvidencePointer;
  baseClassificationRevisionItemHash: string;
  problemArtifact: EvidencePointer;
  problemArtifactItemHash: string;
  classificationArtifact: EvidencePointer & {
    rulesDigest: string;
    transcriptionGateVersion: number;
    transcriptionPromptDigest: string;
    recoveryPromptVersion: number;
    recoveryPromptDigest: string;
  };
  classificationArtifactItemHash: string;
  failedClassificationEvidenceHash: string;
  baseQuestionHash: string;
  effectiveQuestionHash: string;
  baseClassificationHash: string;
  effectiveClassificationHash: string;
};

type ProblemRevisionTrigger =
  | { kind: "classification"; evidence: string }
  | {
      kind: "terminal";
      evidence: string;
      checkpoint: ProblemTerminalFidelityCheckpoint;
      itemHash: string;
    };

type EvidencePointer = { path: string; sha256: string };

type SolutionFidelityDecision = {
  key: string;
  sourcePage: number;
  answerStatus: "exact" | "mismatch" | "not_visible" | "unverifiable";
  explanationStatus: "exact" | "mismatch" | "unverifiable";
  evidence: string;
};

export type SolutionFidelityCheckpointEvidence = EvidencePointer & {
  from: number;
  to: number;
  ownedFrom: number;
  ownedTo: number;
  inputHash: string;
};

export type SolutionRepairEvidence = {
  key: string;
  printedNumber: string;
  basePage: number;
  effectivePage: number;
  contextFrom: number;
  contextTo: number;
  baseOwnedFrom: number;
  baseOwnedTo: number;
  baseSolutionCheckpoint: EvidencePointer;
  baseFidelityCheckpoint: EvidencePointer;
  repairArtifact: EvidencePointer;
  fidelityArtifact: EvidencePointer & { promptDigest: string };
  baseSolutionItemHash: string;
  effectiveSolutionItemHash: string;
  baseRawAnswerHash: string;
  effectiveRawAnswerHash: string;
  baseExplanationHash: string;
  effectiveExplanationHash: string;
  revision?: SolutionRevisionEvidence;
};

export type SolutionRevisionEvidence = {
  trigger: {
    kind: "fidelity" | "semantic";
    fidelityDecisionHash: string;
    semanticCheckpoint?: EvidencePointer & {
      inputHash: string;
      effectiveCorpusHash: string;
      effectiveSolutionCorpusHash: string;
    };
    semanticDecisionHash?: string;
  };
  baseRepairPage: number;
  effectivePage: number;
  baseRepairArtifact: EvidencePointer;
  baseRepairFidelityArtifact: EvidencePointer & { promptDigest: string };
  solutionArtifact: EvidencePointer & {
    revisionPromptVersion: number;
    revisionPromptDigest: string;
  };
  fidelityArtifact: EvidencePointer & { promptDigest: string };
  diagnosticDecisionHash: string;
  baseSolutionItemHash: string;
  baseRepairSolutionItemHash: string;
  effectiveSolutionItemHash: string;
  baseRepairRawAnswerHash: string;
  effectiveRawAnswerHash: string;
  baseRepairExplanationHash: string;
  effectiveExplanationHash: string;
};

export type SolutionFidelityTerminalItem = {
  key: string;
  printedNumber: string;
  qtype: QuizItemEx["qtype"];
  basePage: number;
  effectivePage: number;
  answerStatus: SolutionFidelityDecision["answerStatus"];
  explanationStatus: SolutionFidelityDecision["explanationStatus"];
  evidence: string;
  fidelityArtifact: EvidencePointer;
  baseSolutionItemHash: string;
  effectiveSolutionItemHash: string;
  baseRawAnswerHash: string;
  effectiveRawAnswerHash: string;
  baseExplanationHash: string;
  effectiveExplanationHash: string;
};

type SemanticChoiceDecision = {
  key: string;
  status: "resolved" | "ambiguous";
  choiceIndex: number | null;
  evidence: string;
};

type SolutionRevisionTrigger =
  | { kind: "fidelity" }
  | {
      kind: "semantic";
      semanticCheckpoint: EvidencePointer & {
        inputHash: string;
        effectiveCorpusHash: string;
        effectiveSolutionCorpusHash: string;
      };
      semanticDecision: SemanticChoiceDecision;
    };

type AnswerAuditResult = {
  classified: ClassifiedQuestion[];
  solutions: SolutionItem[];
  repairs: ProblemRepairEvidence[];
  solutionFidelityCheckpoints: SolutionFidelityCheckpointEvidence[];
  solutionFidelityItems: SolutionFidelityTerminalItem[];
  solutionRepairs: SolutionRepairEvidence[];
  auditPath: string | null;
  auditHash: string | null;
  effectiveCorpusHash: string | null;
  effectiveSolutionCorpusHash: string | null;
  problemTerminalFidelityCheckpoints: ProblemTerminalFidelityCheckpoint[];
  problemTerminalFidelityItems: ProblemTerminalFidelityItem[];
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

function sourceRecordDate(value: unknown, label: string): string {
  const date = exactString(value, label, 10);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`${label}: YYYY-MM-DD 날짜가 아닙니다`);
  }
  return date;
}

function sourceRecordYear(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 2000 || Number(value) > 2100) {
    throw new Error(`${label}: 2000-2100 사이 정수 연도가 아닙니다`);
  }
  return Number(value);
}

function nullableString(value: unknown, label: string): string | null {
  return value === null || value === undefined ? null : exactString(value, label, 100);
}

export function examBookTitle(entry: Pick<CorpusManifestEntry, "sourceRecordYear" | "rawTitle">): string {
  return `${entry.sourceRecordYear}년 · ${entry.rawTitle}`;
}

export function problemOwnedRange(
  slice: { from: number; to: number },
  index: number,
  nextFrom?: number
): { from: number; to: number } {
  return {
    from: index === 0 ? slice.from : slice.from + 1,
    to: nextFrom ?? slice.to,
  };
}

export function solutionOwnedStartRange(
  slice: { from: number; to: number },
  nextFrom?: number
): { from: number; to: number } {
  const to = nextFrom === undefined ? slice.to : nextFrom - 1;
  if (
    !Number.isInteger(slice.from) || !Number.isInteger(slice.to) || slice.from < 1 || slice.to < slice.from ||
    (nextFrom !== undefined && !Number.isInteger(nextFrom)) || to < slice.from || to > slice.to
  ) throw new Error("해설 PDF slice 시작 페이지 소유 범위가 유효하지 않습니다");
  return { from: slice.from, to };
}

export function validateSolutionSliceTopology(
  slices: Array<{ from: number; to: number }>
): Array<{ from: number; to: number }> {
  if (slices.length === 0) throw new Error("해설 PDF slice가 비어 있습니다");
  const ownership = slices.map((slice, index) => {
    const next = slices[index + 1];
    if (next && (
      slice.to - slice.from + 1 !== SOLUTION_FIDELITY_SLICE_PAGES ||
      next.from !== slice.from + SOLUTION_FIDELITY_SLICE_STRIDE
    )) {
      throw new Error("해설 fidelity PDF slice가 정확한 4쪽 overlap topology가 아닙니다");
    }
    return solutionOwnedStartRange(slice, next?.from);
  });
  for (let index = 1; index < ownership.length; index++) {
    if (ownership[index].from !== ownership[index - 1].to + 1) {
      throw new Error("해설 PDF slice ownership에 누락 또는 중복이 있습니다");
    }
  }
  return ownership;
}

export function validateProblemSliceTopology(
  slices: Array<{ from: number; to: number }>
): Array<{ from: number; to: number }> {
  if (slices.length === 0) throw new Error("문제 PDF slice가 비어 있습니다");
  const ownership = slices.map((slice, index) => {
    if (!Number.isInteger(slice.from) || !Number.isInteger(slice.to) || slice.from < 1 || slice.to < slice.from) {
      throw new Error("문제 PDF slice 범위가 유효하지 않습니다");
    }
    const next = slices[index + 1];
    if (next && next.from !== slice.to - 1) {
      throw new Error("문제 PDF slice가 정확한 2쪽 overlap topology가 아닙니다");
    }
    const range = problemOwnedRange(slice, index, next?.from);
    if (range.from < slice.from || range.to > slice.to || range.from > range.to) {
      throw new Error("문제 PDF slice ownership이 원본 범위를 벗어났습니다");
    }
    return range;
  });
  for (let index = 1; index < ownership.length; index++) {
    if (ownership[index].from !== ownership[index - 1].to + 1) {
      throw new Error("문제 PDF slice ownership에 누락 또는 중복이 있습니다");
    }
  }
  return ownership;
}

export function problemChunkCount(pageCount: number): number {
  return Math.max(1, Math.ceil((pageCount - (PROBLEM_SLICE_PAGES - PROBLEM_SLICE_STRIDE)) / PROBLEM_SLICE_STRIDE));
}

export function parseCorpusManifest(value: unknown): CorpusManifest {
  const raw = object(value, "manifest");
  if (raw.schemaVersion !== 2) throw new Error("manifest.schemaVersion은 2여야 합니다");
  if (!Array.isArray(raw.entries) || raw.entries.length === 0) throw new Error("manifest.entries가 비어 있습니다");

  const ids = new Set<string>();
  const displayTitles = new Set<string>();
  const entries = raw.entries.map((entryValue, index): CorpusManifestEntry => {
    const entry = object(entryValue, `entries[${index}]`);
    const id = exactString(entry.id, `entries[${index}].id`, 200);
    const subject = exactString(entry.subject, `entries[${index}].subject`, 20) as SourceSubject;
    if (!SOURCE_SUBJECTS.has(subject)) throw new Error(`entries[${index}].subject: 지원하지 않는 원본 과목입니다`);
    const examTitle = exactString(entry.examTitle, `entries[${index}].examTitle`, 500);
    const rawTitle = exactString(entry.rawTitle, `entries[${index}].rawTitle`, 500);
    const recordDate = sourceRecordDate(entry.sourceRecordDate, `entries[${index}].sourceRecordDate`);
    const recordYear = sourceRecordYear(entry.sourceRecordYear, `entries[${index}].sourceRecordYear`);
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
    const displayTitle = `${recordYear}\0${rawTitle}`;
    if (displayTitles.has(displayTitle)) throw new Error(`중복 표시 제목: ${recordYear}년 · ${rawTitle}`);
    displayTitles.add(displayTitle);
    return {
      id,
      subject,
      examTitle,
      rawTitle,
      sourceRecordDate: recordDate,
      sourceRecordYear: recordYear,
      variant,
      form,
      sourcePageUrl,
      problemPdfUrl,
      solutionPdfUrl,
      grade: manifestGrade(entry.grade),
      raw: entry,
    };
  });
  return { schemaVersion: 2, entries, raw };
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

export function canonicalEvidenceHash(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

const TARGETED_PROBLEM_PROMPT_DIGEST = sha256Text(
  `${TARGETED_PROBLEM_TRANSCRIPTION_VERSION}\n${TARGETED_PROBLEM_TRANSCRIPTION_RULES}\n${QUIZ_EXTRACT_SPEC}`
);
export const TARGETED_PROBLEM_BATCH_PROMPT_DIGEST = sha256Text(
  `${TARGETED_PROBLEM_BATCH_VERSION}\n${TARGETED_PROBLEM_BATCH_RULES}\n${QUIZ_EXTRACT_SPEC}`
);
export const TARGETED_PROBLEM_REVISION_PROMPT_DIGEST = sha256Text(
  `${TARGETED_PROBLEM_REVISION_VERSION}\n${TARGETED_PROBLEM_REVISION_RULES}\n` +
  `${TARGETED_PROBLEM_REVISION_EVIDENCE_PREFIX}\n` +
  `${TARGETED_PROBLEM_TRANSCRIPTION_VERSION}\n${TARGETED_PROBLEM_TRANSCRIPTION_RULES}\n${QUIZ_EXTRACT_SPEC}`
);
export const TARGETED_PROBLEM_BATCH_REVISION_PROMPT_DIGEST = sha256Text(
  `${TARGETED_PROBLEM_REVISION_VERSION}\n${TARGETED_PROBLEM_REVISION_RULES}\n` +
  `${TARGETED_PROBLEM_REVISION_EVIDENCE_PREFIX}\n` +
  `${TARGETED_PROBLEM_BATCH_VERSION}\n${TARGETED_PROBLEM_BATCH_RULES}\n${QUIZ_EXTRACT_SPEC}`
);
export const TARGETED_PROBLEM_RECOVERY_PROMPT_DIGEST = sha256Text(
  `${TARGETED_PROBLEM_RECOVERY_VERSION}\n${TARGETED_PROBLEM_RECOVERY_RULES}\n` +
  `${TARGETED_PROBLEM_RECOVERY_EVIDENCE_PREFIX}\n` +
  `${TARGETED_PROBLEM_TRANSCRIPTION_VERSION}\n${TARGETED_PROBLEM_TRANSCRIPTION_RULES}\n${QUIZ_EXTRACT_SPEC}`
);
const TARGETED_SOLUTION_PROMPT_DIGEST = sha256Text(
  `${TARGETED_SOLUTION_TRANSCRIPTION_VERSION}\n${TARGETED_SOLUTION_TRANSCRIPTION_RULES}`
);
export const TARGETED_SOLUTION_REVISION_PROMPT_DIGEST = sha256Text(
  `${TARGETED_SOLUTION_REVISION_VERSION}\n${TARGETED_SOLUTION_REVISION_RULES}\n` +
  `${TARGETED_SOLUTION_REVISION_EVIDENCE_PREFIX}\n` +
  `${TARGETED_SOLUTION_TRANSCRIPTION_VERSION}\n${TARGETED_SOLUTION_TRANSCRIPTION_RULES}`
);
const SEMANTIC_CHOICE_PROMPT_DIGEST = sha256Text(
  `${SEMANTIC_CHOICE_CHECK_VERSION}\n${SEMANTIC_CHOICE_RULES}`
);

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

async function writeImmutableEvidence(path: string, value: unknown): Promise<string> {
  writeImmutableJson(path, value);
  const expected = canonicalEvidenceHash(value);
  const actual = await sha256File(path);
  if (actual !== expected) throw new Error(`체크포인트 canonical hash가 다릅니다: ${path}`);
  return actual;
}

type ImportPdfInfo = {
  pages: number;
  encrypted: boolean;
  printAllowed: boolean;
  copyAllowed: boolean;
};

export function parsePdfInfoOutput(output: string): ImportPdfInfo {
  const pages = Number(/^Pages:\s+(\d+)\s*$/mi.exec(output)?.[1]);
  const encrypted = /^Encrypted:\s+(yes|no)(.*)$/mi.exec(output);
  if (!Number.isInteger(pages) || pages < 1 || !encrypted) {
    throw new Error("pdfinfo 결과에 페이지 또는 암호화 정보가 없습니다");
  }
  const isEncrypted = encrypted[1].toLowerCase() === "yes";
  if (!isEncrypted) return { pages, encrypted: false, printAllowed: true, copyAllowed: true };
  const print = /\bprint:(yes|no)\b/i.exec(encrypted[2])?.[1]?.toLowerCase();
  const copy = /\bcopy:(yes|no)\b/i.exec(encrypted[2])?.[1]?.toLowerCase();
  if (print !== "yes") throw new Error("암호화 PDF는 인쇄 권한이 명시적으로 허용되어야 합니다");
  if (!copy) throw new Error("암호화 PDF의 복사 권한을 확인할 수 없습니다");
  return { pages, encrypted: true, printAllowed: true, copyAllowed: copy === "yes" };
}

export async function buildImageOnlyPdfFromPngs(
  pngPaths: string[],
  outputPath: string,
  dpi = 180
): Promise<void> {
  if (pngPaths.length === 0 || !Number.isFinite(dpi) || dpi <= 0) {
    throw new Error("image-only PDF 페이지 또는 DPI가 유효하지 않습니다");
  }
  const document = await PDFDocument.create();
  for (const path of pngPaths) {
    const image = await document.embedPng(readFileSync(path));
    const width = image.width * 72 / dpi;
    const height = image.height * 72 / dpi;
    const page = document.addPage([width, height]);
    page.drawImage(image, { x: 0, y: 0, width, height });
  }
  writeFileSync(outputPath, await document.save());
}

function popplerCommand(name: "pdfinfo" | "pdftocairo"): string {
  const homebrew = `/opt/homebrew/bin/${name}`;
  return existsSync(homebrew) ? homebrew : name;
}

async function readImportPdfInfo(path: string): Promise<ImportPdfInfo> {
  try {
    const { stdout } = await execFileP(popplerCommand("pdfinfo"), [path], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return parsePdfInfoOutput(String(stdout));
  } catch (error) {
    if (error instanceof Error && /인쇄 권한|복사 권한|pdfinfo 결과/.test(error.message)) throw error;
    throw new Error("PDF가 암호로 잠겼거나 pdfinfo로 읽을 수 없습니다");
  }
}

export async function withImporterPdfForAnalysis<T>(
  evidence: PdfEvidence,
  run: (analysisEvidence: PdfEvidence) => Promise<T>
): Promise<T> {
  const sharedCount = evidence.requiresNormalization ? null : await pdfPageCount(evidence.path);
  if (!evidence.requiresNormalization && sharedCount === evidence.pageCount) return run(evidence);

  const sourceInfo = await readImportPdfInfo(evidence.path);
  if (sourceInfo.pages !== evidence.pageCount) throw new Error("공식 PDF의 pdfinfo 페이지 수가 evidence와 다릅니다");
  const dir = mkdtempSync(join(tmpdir(), "studywork-ebsi-pdf-"));
  const normalizedPath = join(dir, "normalized.pdf");
  try {
    if (sourceInfo.copyAllowed) {
      await execFileP(popplerCommand("pdftocairo"), ["-pdf", evidence.path, normalizedPath], {
        encoding: "utf8",
        timeout: 2 * 60 * 1000,
        maxBuffer: 4 * 1024 * 1024,
      });
    } else {
      const prefix = join(dir, "page");
      await execFileP(popplerCommand("pdftocairo"), ["-png", "-r", "180", evidence.path, prefix], {
        encoding: "utf8",
        timeout: 5 * 60 * 1000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const pngs = readdirSync(dir).flatMap((name) => {
        const match = /^page-(\d+)\.png$/u.exec(name);
        return match ? [{ page: Number(match[1]), path: join(dir, name) }] : [];
      }).sort((left, right) => left.page - right.page);
      if (
        pngs.length !== evidence.pageCount ||
        pngs.some((item, index) => item.page !== index + 1)
      ) throw new Error("image-only PDF 렌더 페이지가 원본과 다릅니다");
      await buildImageOnlyPdfFromPngs(pngs.map((item) => item.path), normalizedPath);
    }
    const normalizedStat = statSync(normalizedPath);
    if (!normalizedStat.isFile() || normalizedStat.size < 5 || normalizedStat.size > MAX_PDF_BYTES) {
      throw new Error("정규화 PDF 크기가 AI 입력 한도를 벗어났습니다");
    }
    const normalizedInfo = await readImportPdfInfo(normalizedPath);
    if (normalizedInfo.encrypted || normalizedInfo.pages !== evidence.pageCount) {
      throw new Error("정규화 PDF가 암호화됐거나 원본 페이지 수와 다릅니다");
    }
    if (await pdfPageCount(normalizedPath) !== evidence.pageCount) {
      throw new Error("정규화 PDF를 StudyWork PDF parser로 검증할 수 없습니다");
    }
    return await run({ ...evidence, path: normalizedPath, requiresNormalization: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
  const info = await readImportPdfInfo(path);
  if (info.pages > MAX_PDF_PAGES) throw new Error(`PDF 페이지 수가 유효하지 않습니다: ${path}`);
  const sharedCount = info.encrypted ? null : await pdfPageCount(path);
  return {
    path,
    sha256: await sha256File(path),
    bytes: stat.size,
    pageCount: info.pages,
    requestedUrl,
    resolvedUrl,
    requiresNormalization: info.encrypted || sharedCount !== info.pages,
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

export function compareCorpusQuestionKeys(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

export function commitSemanticSolutionRevisionTriggers<T>(
  target: Map<string, T>,
  tentative: ReadonlyMap<string, T>,
  problemRepairCount: number
): boolean {
  if (problemRepairCount > 0 || tentative.size === 0) return false;
  for (const [key, trigger] of tentative) target.set(key, trigger);
  return true;
}

export function invalidateSemanticSolutionRevisionTriggers<T>(
  triggers: Map<string, T>,
  problemCorpusChanged: boolean
): void {
  if (problemCorpusChanged) triggers.clear();
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

function restoredSparseQuizItems(value: unknown): QuizItemEx[] {
  if (!Array.isArray(value)) throw new Error("sparse 문제 체크포인트 items가 배열이 아닙니다");
  return value.flatMap((item) => restoredQuizItems([item]));
}

export function parseDecisions(
  value: unknown,
  questions: QuizItemEx[],
  entry: Pick<CorpusManifestEntry, "subject" | "grade">
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
    const canonical = decision === "accept" ? row.canonical_subject : null;
    const canonicalSubject = canonical === null ? null : exactString(canonical, `분류 ${key}.canonical_subject`) as CanonicalSubject;
    if (canonicalSubject !== null && !(canonicalSubject in TARGET_BY_CANONICAL)) {
      throw new Error(`분류 ${key}: canonical_subject가 유효하지 않습니다`);
    }
    const rawCurriculumCourse = decision === "accept" ? row.curriculum_course : null;
    const curriculumCourse = rawCurriculumCourse === null
      ? null
      : exactString(rawCurriculumCourse, `분류 ${key}.curriculum_course`, 200);
    const rawDomain = decision === "accept" ? row.domain : null;
    const domain = rawDomain === null ? null : exactString(rawDomain, `분류 ${key}.domain`, 200);
    const achievementCodes = decision === "accept" ? row.achievement_codes : [];
    if (!Array.isArray(achievementCodes) || achievementCodes.some((code) => typeof code !== "string" || !code.trim())) {
      throw new Error(`분류 ${key}: achievement_codes가 유효하지 않습니다`);
    }
    if (!Array.isArray(row.reason_codes) || row.reason_codes.length === 0 || row.reason_codes.some((code) => typeof code !== "string" || !code.trim())) {
      throw new Error(`분류 ${key}: reason_codes가 유효하지 않습니다`);
    }
    if (!(["exact", "mismatch", "unverifiable"] as unknown[]).includes(row.transcription_status)) {
      throw new Error(`분류 ${key}: transcription_status가 유효하지 않습니다`);
    }
    const transcriptionStatus = row.transcription_status as ClassificationDecision["transcription_status"];
    const transcriptionEvidence = exactString(
      row.transcription_evidence,
      `분류 ${key}.transcription_evidence`,
      2000
    );
    const confidence = Number(row.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error(`분류 ${key}: confidence가 유효하지 않습니다`);
    }
    if (decision === "accept") {
      if (
        canonicalSubject === null || !allowed.has(canonicalSubject) || confidence < 0.9 ||
        !curriculumCourse || !domain || achievementCodes.length === 0
      ) throw new Error(`분류 ${key}: accept 근거가 부족하거나 원본 과목 범위를 벗어났습니다`);
      const invalidCode = (achievementCodes as string[]).find(
        (code) => !isAllowedAchievementCode(canonicalSubject, code)
      );
      if (invalidCode) throw new Error(`분류 ${key}: 허용 범위 밖 성취기준 코드입니다: ${invalidCode}`);
      if (["통합과학", "통합사회"].includes(entry.subject) && ![1, 2].includes(entry.grade ?? 0)) {
        throw new Error(`분류 ${key}: 통합과학/통합사회는 고1·고2 원본만 accept할 수 있습니다`);
      }
    }
    return {
      key,
      decision,
      canonical_subject: canonicalSubject,
      curriculum_course: curriculumCourse,
      domain,
      achievement_codes: [...new Set(achievementCodes as string[])],
      confidence,
      reason_codes: [...new Set(row.reason_codes as string[])],
      transcription_status: transcriptionStatus,
      transcription_evidence: transcriptionEvidence,
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
  questions: QuizItemEx[],
  opts?: { revisionEvidence?: string; targeted?: boolean }
): Promise<ClassificationDecision[]> {
  if (questions.length === 0) return [];
  const input = questions.map((question) => ({
    key: questionKey(question),
    printed_number: String(numericPrintedLocator(question.number)),
    source_page: question.page,
    qtype: question.qtype,
    question: question.question,
    choices: question.choices,
    figure: question.figure,
    figure_description: question.figure_description,
    box: question.box,
  }));
  const allowedCodes = ALLOWED_CANONICAL[entry.subject]
    .flatMap((canonical) => [...ACHIEVEMENT_CODES[canonical]])
    .sort();
  const revisionEvidence = opts?.revisionEvidence;
  if (revisionEvidence !== undefined) exactString(revisionEvidence, "problem revision evidence", 2000);
  const revisionRule = revisionEvidence === undefined ? "" :
    `\n\n${TARGETED_PROBLEM_REVISION_RULES}\n` +
    `${TARGETED_PROBLEM_REVISION_EVIDENCE_PREFIX} ${JSON.stringify(revisionEvidence)}`;
  const prompt =
    `Attached official problem PDF slice contains original pages ${from}-${to}. ` +
    `Exam source subject is ${entry.subject}; source school grade is ${entry.grade ?? "unknown"}. ` +
    `Inspect complete source passages and visual evidence, then classify every supplied question.\n\n` +
    `${TRANSCRIPTION_GATE_RULES}${revisionRule}\n\n${CURRICULUM_RULES}\n\n` +
    `Allowed exact achievement codes for this source: ${allowedCodes.join(", ")}\n\n` +
    `Questions:\n${JSON.stringify(input)}`;
  const result = await (opts?.targeted ? withTargetedAi : withFullContextAi)(() =>
    getCodexProvider({ model: IMPORT_MODEL, reasoningEffort: IMPORT_REASONING_EFFORT }).complete({
    operation: "problem-extract",
    prompt,
    file: { path, kind: "pdf" },
    schema: CLASSIFICATION_SCHEMA,
    model: IMPORT_MODEL,
    reasoningEffort: IMPORT_REASONING_EFFORT,
    lane: "bulk",
    })
  );
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

async function withProblemContextSlice<T>(
  analysisPath: string,
  contextFrom: number,
  contextTo: number,
  run: (contextPath: string) => Promise<T>
): Promise<T> {
  if (
    !Number.isInteger(contextFrom) || !Number.isInteger(contextTo) || contextFrom < 1 ||
    contextTo < contextFrom || contextTo - contextFrom + 1 > PROBLEM_SLICE_PAGES
  ) throw new Error(`문제 repair context 범위가 유효하지 않습니다: ${contextFrom}-${contextTo}`);
  const sliced = await slicePdf(analysisPath, PROBLEM_SLICE_PAGES, PROBLEM_SLICE_STRIDE);
  if (!sliced) {
    if (contextFrom !== 1 || await pdfPageCount(analysisPath) !== contextTo) {
      throw new Error(`문제 repair context ${contextFrom}-${contextTo} slice를 만들 수 없습니다`);
    }
    return run(analysisPath);
  }
  try {
    const target = sliced.slices.find((slice) => slice.from === contextFrom && slice.to === contextTo);
    if (!target) throw new Error(`문제 repair context ${contextFrom}-${contextTo} slice가 없습니다`);
    return await run(target.path);
  } finally {
    sliced.cleanup();
  }
}

function parseProblemTerminalFidelity(
  value: unknown,
  questions: ClassifiedQuestion[]
): ProblemTerminalFidelityItem[] {
  if (!Array.isArray(value)) throw new Error("terminal 문제 fidelity 결과가 배열이 아닙니다");
  const expected = new Set(questions.map((item) => questionKey(item.question)));
  const seen = new Set<string>();
  const items = value.map((raw, index): ProblemTerminalFidelityItem => {
    const row = object(raw, `terminal 문제 fidelity ${index + 1}`);
    const key = exactString(row.key, `terminal 문제 fidelity ${index + 1}.key`, 100);
    if (!expected.has(key) || seen.has(key)) throw new Error(`terminal 문제 fidelity key가 없거나 중복입니다: ${key}`);
    seen.add(key);
    if (!( ["exact", "mismatch", "unverifiable"] as unknown[]).includes(row.status)) {
      throw new Error(`terminal 문제 fidelity ${key}.status가 유효하지 않습니다`);
    }
    if (!( ["accept", "reject", "review"] as unknown[]).includes(row.scopeDecision)) {
      throw new Error(`terminal 문제 fidelity ${key}.scopeDecision이 유효하지 않습니다`);
    }
    if (typeof row.scopeConfidence !== "number" || !Number.isFinite(row.scopeConfidence) ||
        row.scopeConfidence < 0 || row.scopeConfidence > 1) {
      throw new Error(`terminal 문제 fidelity ${key}.scopeConfidence가 유효하지 않습니다`);
    }
    return {
      key,
      status: row.status as ProblemTerminalFidelityItem["status"],
      evidence: exactString(row.evidence, `terminal 문제 fidelity ${key}.evidence`, 2000),
      scopeDecision: row.scopeDecision as ProblemTerminalFidelityItem["scopeDecision"],
      scopeConfidence: row.scopeConfidence,
      scopeEvidence: exactString(row.scopeEvidence, `terminal 문제 fidelity ${key}.scopeEvidence`, 2000),
    };
  });
  if (items.length !== expected.size || seen.size !== expected.size) {
    throw new Error("terminal 문제 fidelity 결과의 exact key 집합이 다릅니다");
  }
  return items;
}

function isAuthorizedScopeRejectedMismatch(
  current: ClassifiedQuestion,
  item: ProblemTerminalFidelityItem,
  repairedKeys: ReadonlySet<string>
): boolean {
  return !repairedKeys.has(item.key) && questionKey(current.question) === item.key &&
    current.classification.decision === "reject" && current.classification.transcription_status === "mismatch" &&
    item.status === "mismatch" && item.scopeDecision === "reject" && item.scopeConfidence >= 0.9;
}

function assertTerminalProblemPolicy(
  classified: ClassifiedQuestion[],
  items: ProblemTerminalFidelityItem[],
  repairedKeys: ReadonlySet<string>
): void {
  const itemByKey = new Map(items.map((item) => [item.key, item]));
  if (itemByKey.size !== items.length || classified.length !== items.length) {
    throw new Error("terminal 문제 fidelity policy coverage가 다릅니다");
  }
  for (const current of classified) {
    const key = questionKey(current.question);
    const item = itemByKey.get(key);
    const acceptedScopeAgrees = current.classification.decision !== "accept" ||
      (item?.scopeDecision === "accept" && item.scopeConfidence >= 0.9);
    const independentlyExact = item?.status === "exact" &&
      current.classification.transcription_status === "exact" && acceptedScopeAgrees;
    if (!item || (!independentlyExact && !isAuthorizedScopeRejectedMismatch(current, item, repairedKeys))) {
      throw new Error(`${key} terminal 문제 fidelity가 최종 정책을 만족하지 않습니다`);
    }
  }
}

async function auditProblemTerminalFidelity(
  entry: CorpusManifestEntry,
  evidence: PdfEvidence,
  stateDir: string,
  classified: ClassifiedQuestion[]
): Promise<{ items: ProblemTerminalFidelityItem[]; checkpoints: ProblemTerminalFidelityCheckpoint[] }> {
  const effectiveCorpusHash = canonicalEvidenceHash(classified);
  return withImporterPdfForAnalysis(evidence, (analysisEvidence) =>
    withSlices(analysisEvidence, PROBLEM_SLICE_PAGES, PROBLEM_SLICE_STRIDE, async (slices) => {
      const ownership = validateProblemSliceTopology(slices);
      const allItems: ProblemTerminalFidelityItem[] = [];
      const checkpoints: ProblemTerminalFidelityCheckpoint[] = [];
      for (const [index, slice] of slices.entries()) {
        const owned = ownership[index];
        const questions = classified.filter(({ question }) => question.page! >= owned.from && question.page! <= owned.to);
        if (questions.length === 0) continue;
        const inputs = questions.map(({ question }) => ({
          key: questionKey(question),
          printed_number: String(numericPrintedLocator(question.number)),
          source_page: question.page,
          qtype: question.qtype,
          question: question.question,
          choices: question.choices,
          figure: question.figure,
          figure_description: question.figure_description,
          box: question.box,
        }));
        const inputHash = canonicalEvidenceHash(inputs);
        const relativePath = `problem-terminal-fidelity/v${PROBLEM_TERMINAL_FIDELITY_VERSION}-` +
          `${String(index).padStart(4, "0")}-${effectiveCorpusHash}-${inputHash}.json`;
        const path = join(stateDir, relativePath);
        let checkpoint: Record<string, unknown>;
        let items: ProblemTerminalFidelityItem[];
        if (existsSync(path)) {
          checkpoint = object(JSON.parse(readFileSync(path, "utf8")), relativePath);
          if (
            checkpoint.version !== PROBLEM_TERMINAL_FIDELITY_VERSION || checkpoint.entryId !== entry.id ||
            checkpoint.sourceHash !== evidence.sha256 || checkpoint.from !== slice.from || checkpoint.to !== slice.to ||
            checkpoint.ownedFrom !== owned.from || checkpoint.ownedTo !== owned.to ||
            checkpoint.effectiveCorpusHash !== effectiveCorpusHash || checkpoint.inputHash !== inputHash ||
            checkpoint.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
            checkpoint.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST ||
            checkpoint.rulesDigest !== CLASSIFIER_DIGEST ||
            checkpoint.scopePromptDigest !== PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST ||
            checkpoint.model !== IMPORT_MODEL || checkpoint.reasoningEffort !== IMPORT_REASONING_EFFORT ||
            canonicalEvidenceHash(checkpoint.inputs) !== canonicalEvidenceHash(inputs)
          ) throw new Error(`terminal 문제 fidelity 체크포인트 메타데이터가 다릅니다: ${path}`);
          items = parseProblemTerminalFidelity(checkpoint.items, questions);
        } else {
          const prompt = `Attached official problem PDF slice contains original pages ${slice.from}-${slice.to}. ` +
            `Exam source subject is ${entry.subject}; source school grade is ${entry.grade ?? "unknown"}. ` +
            `Independently audit every final transcription and its curriculum scope from source pixels. ` +
            `No prior classifier decision is supplied.\n\n${TRANSCRIPTION_GATE_RULES}\n\n` +
            `${PROBLEM_TERMINAL_SCOPE_RULES}\n\n${CURRICULUM_RULES}\n\n` +
            `Final questions:\n${JSON.stringify(inputs)}`;
          const result = await withFullContextAi(() => getCodexProvider({
            model: IMPORT_MODEL,
            reasoningEffort: IMPORT_REASONING_EFFORT,
          }).complete({
            operation: "problem-extract",
            prompt,
            file: { path: slice.path, kind: "pdf" },
            schema: PROBLEM_TERMINAL_FIDELITY_SCHEMA,
            model: IMPORT_MODEL,
            reasoningEffort: IMPORT_REASONING_EFFORT,
            lane: "bulk",
          }));
          items = parseProblemTerminalFidelity(schemaItems(result.text, "terminal 문제 fidelity 응답"), questions);
          checkpoint = {
            version: PROBLEM_TERMINAL_FIDELITY_VERSION,
            entryId: entry.id,
            sourceHash: evidence.sha256,
            from: slice.from,
            to: slice.to,
            ownedFrom: owned.from,
            ownedTo: owned.to,
            effectiveCorpusHash,
            inputHash,
            transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
            transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
            rulesDigest: CLASSIFIER_DIGEST,
            scopePromptDigest: PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST,
            model: IMPORT_MODEL,
            reasoningEffort: IMPORT_REASONING_EFFORT,
            inputs,
            items,
          };
          await writeImmutableEvidence(path, checkpoint);
        }
        const sha256 = await sha256File(path);
        if (sha256 !== canonicalEvidenceHash(checkpoint)) throw new Error(`terminal 문제 fidelity hash가 다릅니다: ${path}`);
        allItems.push(...items);
        checkpoints.push({ path: relativePath, sha256, from: slice.from, to: slice.to,
          ownedFrom: owned.from, ownedTo: owned.to, inputHash });
      }
      if (allItems.length !== classified.length || new Set(allItems.map((item) => item.key)).size !== classified.length) {
        throw new Error("terminal 문제 fidelity 전체 coverage가 다릅니다");
      }
      return { items: allItems.sort((a, b) => compareCorpusQuestionKeys(a.key, b.key)), checkpoints };
    })
  );
}

async function extractAndClassifyProblems(
  entry: CorpusManifestEntry,
  evidence: PdfEvidence,
  stateDir: string
): Promise<ClassifiedQuestion[]> {
  return withImporterPdfForAnalysis(evidence, (analysisEvidence) =>
    extractAndClassifyAnalysisPdf(entry, analysisEvidence, stateDir)
  );
}

async function extractAndClassifyAnalysisPdf(
  entry: CorpusManifestEntry,
  evidence: PdfEvidence,
  stateDir: string
): Promise<ClassifiedQuestion[]> {
  return withSlices(evidence, PROBLEM_SLICE_PAGES, PROBLEM_SLICE_STRIDE, async (slices) => {
    const ownershipRanges = validateProblemSliceTopology(slices);
    const combined: ClassifiedQuestion[] = [];
    for (const [index, slice] of slices.entries()) {
      const ownership = ownershipRanges[index];
      const extractionPath = join(stateDir, "problem-chunks", `v${CHECKPOINT_VERSION}-${String(index).padStart(4, "0")}.json`);
      let questions: QuizItemEx[];
      if (existsSync(extractionPath)) {
        const checkpoint = object(JSON.parse(readFileSync(extractionPath, "utf8")), "문제 체크포인트");
        if (
          checkpoint.version !== CHECKPOINT_VERSION || checkpoint.sourceHash !== evidence.sha256 ||
          checkpoint.from !== slice.from || checkpoint.to !== slice.to || checkpoint.model !== IMPORT_MODEL ||
          checkpoint.reasoningEffort !== IMPORT_REASONING_EFFORT || checkpoint.ownedFrom !== ownership.from ||
          checkpoint.ownedTo !== ownership.to
        ) throw new Error(`문제 체크포인트 메타데이터가 다릅니다: ${extractionPath}`);
        questions = restoredQuizItems(checkpoint.items);
      } else {
        questions = await withFullContextAi(() => extractProblemsFromFile(slice.path, "pdf", {
          sliceBase: slice.from,
          contentPageCount: slice.to - slice.from + 1,
          selfContained: true,
        }));
        questions = questions.filter((question) => question.page! >= ownership.from && question.page! <= ownership.to);
        for (const question of questions) questionKey(question);
        writeImmutableJson(extractionPath, {
          version: CHECKPOINT_VERSION,
          sourceHash: evidence.sha256,
          from: slice.from,
          to: slice.to,
          ownedFrom: ownership.from,
          ownedTo: ownership.to,
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
        `v${CLASSIFIER_VERSION}-${String(index).padStart(4, "0")}-${CLASSIFIER_DIGEST}.json`
      );
      let decisions: ClassificationDecision[];
      if (existsSync(classificationPath)) {
        const checkpoint = object(JSON.parse(readFileSync(classificationPath, "utf8")), "분류 체크포인트");
        if (
          checkpoint.version !== CLASSIFIER_VERSION || checkpoint.sourceHash !== evidence.sha256 ||
          checkpoint.from !== slice.from || checkpoint.to !== slice.to || checkpoint.rulesDigest !== CLASSIFIER_DIGEST ||
          checkpoint.model !== IMPORT_MODEL || checkpoint.reasoningEffort !== IMPORT_REASONING_EFFORT ||
          checkpoint.ownedFrom !== ownership.from || checkpoint.ownedTo !== ownership.to ||
          checkpoint.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
          checkpoint.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST
        ) throw new Error(`분류 체크포인트 메타데이터가 다릅니다: ${classificationPath}`);
        decisions = parseDecisions(checkpoint.items, questions, entry);
      } else {
        decisions = await classifyQuestions(entry, slice.path, slice.from, slice.to, questions);
        writeImmutableJson(classificationPath, {
          version: CLASSIFIER_VERSION,
          sourceHash: evidence.sha256,
          from: slice.from,
          to: slice.to,
          ownedFrom: ownership.from,
          ownedTo: ownership.to,
          rulesDigest: CLASSIFIER_DIGEST,
          transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
          transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
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
  return withImporterPdfForAnalysis(evidence, (analysisEvidence) =>
    extractSolutionsFromAnalysisPdf(analysisEvidence, stateDir)
  );
}

async function extractSolutionsFromAnalysisPdf(
  evidence: PdfEvidence,
  stateDir: string
): Promise<SolutionItem[]> {
  return withSlices(evidence, SOLUTION_SLICE_PAGES, SOLUTION_SLICE_STRIDE, async (slices) => {
    const combined: SolutionItem[] = [];
    for (const [index, slice] of slices.entries()) {
      const ownership = solutionOwnedStartRange(slice, slices[index + 1]?.from);
      const checkpointPath = join(
        stateDir,
        "solution-chunks",
        `v${SOLUTION_CHECKPOINT_VERSION}-${String(index).padStart(4, "0")}.json`
      );
      let items: SolutionItem[];
      if (existsSync(checkpointPath)) {
        const checkpoint = object(JSON.parse(readFileSync(checkpointPath, "utf8")), "해설 체크포인트");
        if (
          checkpoint.version !== SOLUTION_CHECKPOINT_VERSION || checkpoint.sourceHash !== evidence.sha256 ||
          checkpoint.from !== slice.from || checkpoint.to !== slice.to || checkpoint.model !== IMPORT_MODEL ||
          checkpoint.reasoningEffort !== IMPORT_REASONING_EFFORT || checkpoint.ownedFrom !== ownership.from ||
          checkpoint.ownedTo !== ownership.to
        ) throw new Error(`해설 체크포인트 메타데이터가 다릅니다: ${checkpointPath}`);
        items = parseSolutionItems(JSON.stringify(checkpoint.items));
      } else {
        items = await withFullContextAi(() => extractSolutionsFromFile(slice.path, "pdf", {
          sliceBase: slice.from,
          contentPageCount: slice.to - slice.from + 1,
          ownedStartPageRange: ownership,
          reasoningEffort: IMPORT_REASONING_EFFORT,
        }));
        if (items.some((item) => item.page < ownership.from || item.page > ownership.to)) {
          throw new Error(`해설 추출이 ${ownership.from}-${ownership.to} 시작 페이지 범위를 벗어났습니다`);
        }
        writeImmutableJson(checkpointPath, {
          version: SOLUTION_CHECKPOINT_VERSION,
          sourceHash: evidence.sha256,
          from: slice.from,
          to: slice.to,
          ownedFrom: ownership.from,
          ownedTo: ownership.to,
          model: IMPORT_MODEL,
          reasoningEffort: IMPORT_REASONING_EFFORT,
          items,
        });
      }
      if (items.some((item) => item.page < ownership.from || item.page > ownership.to)) {
        throw new Error(`해설 체크포인트가 ${ownership.from}-${ownership.to} 시작 페이지 범위를 벗어났습니다`);
      }
      combined.push(...items);
    }
    combined.sort((a, b) => a.page - b.page || numericPrintedLocator(a.number)! - numericPrintedLocator(b.number)!);
    return combined;
  });
}

function validateProblemNumberRange(
  entry: Pick<CorpusManifestEntry, "subject">,
  classified: ClassifiedQuestion[]
): Set<number> {
  const numbers = new Set<number>();
  for (const { question } of classified) {
    const number = numericPrintedLocator(question.number);
    if (number === null) throw new Error("문제 인쇄 번호가 숫자가 아닙니다");
    if (numbers.has(number)) throw new Error(`문제 인쇄 번호가 중복입니다: ${number}`);
    numbers.add(number);
  }
  const expectedCount = EXPECTED_QUESTION_COUNT[entry.subject];
  const missing = Array.from({ length: expectedCount }, (_, index) => index + 1)
    .filter((number) => !numbers.has(number));
  const extra = [...numbers].filter((number) => number < 1 || number > expectedCount);
  if (numbers.size !== expectedCount || missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${entry.subject} 문제 인쇄 번호 범위 불일치: ` +
      `기대 1-${expectedCount}, 누락 ${missing.join(",") || "없음"}, 초과 ${extra.join(",") || "없음"}`
    );
  }
  return numbers;
}

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
    (
      _match: string,
      numeratorGroup: string | undefined,
      numeratorToken: string | undefined,
      denominatorGroup: string | undefined,
      denominatorToken: string | undefined
    ) => `\\frac{${numeratorGroup ?? numeratorToken}}{${denominatorGroup ?? denominatorToken}}`
  );
  normalized = normalized.replace(
    /\\frac\{([^{}]*?)\\pi\}\{([^{}]+)\}/gu,
    (_match: string, coefficient: string, denominator: string) =>
      `\\frac{${coefficient.trim() || "1"}}{${denominator}}\\pi`
  );
  return normalized.toLowerCase().replace(/\s+/gu, "");
}

export class OfficialAnswerChoiceMismatchError extends Error {
  constructor(public readonly printedNumber: string, public readonly officialAnswer: string, message: string) {
    super(message);
    this.name = "OfficialAnswerChoiceMismatchError";
  }
}

export type OfficialAnswerResolution = {
  storedAnswer: string;
  choiceIndex: number | null;
  mode: "raw" | "choice-content" | "choice-marker";
};

export function resolveOfficialAnswer(question: QuizItemEx, answer: string): OfficialAnswerResolution {
  const official = answer.trim();
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
    throw new OfficialAnswerChoiceMismatchError(
      String(question.number ?? "?"),
      official,
      `${question.number}번 공식 객관식 정답이 보기 범위를 벗어났습니다: ${official}`
    );
  }
  const numeric = /^(?:정답\s*[:：]?\s*)?(\d{1,2})(?:\s*번)?$/.exec(official)?.[1];
  if (numeric) {
    const index = Number(numeric) - 1;
    if (index >= 0 && index < choices.length) {
      return { storedAnswer: official, choiceIndex: index, mode: "choice-marker" };
    }
  }
  throw new OfficialAnswerChoiceMismatchError(
    String(question.number ?? "?"),
    official,
    `${question.number}번 공식 객관식 정답을 보기에 대응할 수 없습니다: ${official}`
  );
}

export function officialAnswerForStorage(question: QuizItemEx, answer: string): string {
  return resolveOfficialAnswer(question, answer).storedAnswer;
}

function officialSolutionsByNumber(
  entry: Pick<CorpusManifestEntry, "subject">,
  classified: ClassifiedQuestion[],
  solutions: SolutionItem[]
): Map<number, SolutionItem> {
  const problemNumbers = validateProblemNumberRange(entry, classified);
  const byNumber = new Map<number, SolutionItem>();
  for (const solution of solutions) {
    const number = numericPrintedLocator(solution.number);
    if (number === null || byNumber.has(number)) {
      throw new Error(`해설 인쇄 번호가 없거나 중복입니다: ${solution.number}`);
    }
    byNumber.set(number, solution);
  }
  if (
    byNumber.size !== problemNumbers.size ||
    [...problemNumbers].some((number) => !byNumber.has(number)) ||
    [...byNumber].some(([number]) => !problemNumbers.has(number))
  ) throw new Error("문제와 공식 해설의 인쇄 번호 집합이 다릅니다");
  return byNumber;
}

type BaseQuestionEvidence = {
  problem: { path: string; sha256: string };
  classification: { path: string; sha256: string };
  contextFrom: number;
  contextTo: number;
  questionHash: string;
  classificationHash: string;
};

type BaseSolutionEvidence = {
  checkpoint: { path: string; sha256: string };
  contextFrom: number;
  contextTo: number;
  ownedFrom: number;
  ownedTo: number;
  itemHash: string;
};

async function baseQuestionEvidence(
  entry: CorpusManifestEntry,
  evidence: PdfEvidence,
  stateDir: string,
  classified: ClassifiedQuestion
): Promise<BaseQuestionEvidence> {
  const key = questionKey(classified.question);
  const problemDir = join(stateDir, "problem-chunks");
  const matches: Array<{ name: string; questions: QuizItemEx[]; checkpoint: Record<string, unknown> }> = [];
  for (const name of readdirSync(problemDir).filter((value) => /^v2-\d{4}\.json$/.test(value)).sort()) {
    const checkpoint = object(JSON.parse(readFileSync(join(problemDir, name), "utf8")), name);
    const questions = restoredQuizItems(checkpoint.items);
    if (questions.some((question) => questionKey(question) === key)) matches.push({ name, questions, checkpoint });
  }
  if (matches.length !== 1) throw new Error(`${key} base problem checkpoint가 정확히 하나가 아닙니다`);
  const match = matches[0];
  if (
    match.checkpoint.version !== CHECKPOINT_VERSION || match.checkpoint.sourceHash !== evidence.sha256 ||
    match.checkpoint.model !== IMPORT_MODEL || match.checkpoint.reasoningEffort !== IMPORT_REASONING_EFFORT
  ) throw new Error(`${key} base problem checkpoint 메타데이터가 다릅니다`);
  const contextFrom = Number(match.checkpoint.from);
  const contextTo = Number(match.checkpoint.to);
  if (
    !Number.isInteger(contextFrom) || !Number.isInteger(contextTo) || contextFrom < 1 ||
    contextTo < contextFrom || contextTo - contextFrom + 1 > PROBLEM_SLICE_PAGES ||
    classified.question.page! < contextFrom || classified.question.page! > contextTo
  ) throw new Error(`${key} base problem checkpoint context 범위가 유효하지 않습니다`);
  const original = match.questions.find((question) => questionKey(question) === key)!;
  if (canonicalEvidenceHash(original) !== canonicalEvidenceHash(classified.question)) {
    throw new Error(`${key} base problem checkpoint 항목이 현재 분류 입력과 다릅니다`);
  }

  const index = /^v2-(\d{4})\.json$/.exec(match.name)![1];
  const classificationName = `v${CLASSIFIER_VERSION}-${index}-${CLASSIFIER_DIGEST}.json`;
  const classificationPath = join(stateDir, "classification-chunks", classificationName);
  if (!existsSync(classificationPath)) throw new Error(`${key} base classification checkpoint가 없습니다`);
  const classificationCheckpoint = object(
    JSON.parse(readFileSync(classificationPath, "utf8")),
    classificationName
  );
  if (
    classificationCheckpoint.version !== CLASSIFIER_VERSION ||
    classificationCheckpoint.sourceHash !== evidence.sha256 ||
    classificationCheckpoint.from !== contextFrom || classificationCheckpoint.to !== contextTo ||
    classificationCheckpoint.rulesDigest !== CLASSIFIER_DIGEST ||
    classificationCheckpoint.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
    classificationCheckpoint.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST ||
    classificationCheckpoint.model !== IMPORT_MODEL ||
    classificationCheckpoint.reasoningEffort !== IMPORT_REASONING_EFFORT
  ) throw new Error(`${key} base classification checkpoint 메타데이터가 다릅니다`);
  const decisions = parseDecisions(classificationCheckpoint.items, match.questions, entry);
  const originalDecision = decisions.find((decision) => decision.key === key);
  if (!originalDecision || canonicalEvidenceHash(originalDecision) !== canonicalEvidenceHash(classified.classification)) {
    throw new Error(`${key} base classification checkpoint 항목이 현재 결정과 다릅니다`);
  }

  return {
    problem: {
      path: `problem-chunks/${match.name}`,
      sha256: await sha256File(join(problemDir, match.name)),
    },
    classification: {
      path: `classification-chunks/${classificationName}`,
      sha256: await sha256File(classificationPath),
    },
    contextFrom,
    contextTo,
    questionHash: canonicalEvidenceHash(original),
    classificationHash: canonicalEvidenceHash(originalDecision),
  };
}

async function baseSolutionEvidence(
  evidence: PdfEvidence,
  stateDir: string,
  solution: SolutionItem
): Promise<BaseSolutionEvidence> {
  const number = numericPrintedLocator(solution.number);
  if (number === null) throw new Error(`해설 인쇄 번호가 유효하지 않습니다: ${solution.number}`);
  const solutionDir = join(stateDir, "solution-chunks");
  const matches: Array<{ name: string; item: SolutionItem; checkpoint: Record<string, unknown> }> = [];
  for (const name of readdirSync(solutionDir).filter((value) => /^v3-\d{4}\.json$/.test(value)).sort()) {
    const checkpoint = object(JSON.parse(readFileSync(join(solutionDir, name), "utf8")), name);
    const item = parseSolutionItems(JSON.stringify(checkpoint.items))
      .find((candidate) => numericPrintedLocator(candidate.number) === number);
    if (item) matches.push({ name, item, checkpoint });
  }
  if (matches.length !== 1) throw new Error(`${number}번 base solution checkpoint가 정확히 하나가 아닙니다`);
  const match = matches[0];
  if (
    match.checkpoint.version !== SOLUTION_CHECKPOINT_VERSION || match.checkpoint.sourceHash !== evidence.sha256 ||
    match.checkpoint.model !== IMPORT_MODEL || match.checkpoint.reasoningEffort !== IMPORT_REASONING_EFFORT
  ) throw new Error(`${number}번 base solution checkpoint 메타데이터가 다릅니다`);
  const contextFrom = Number(match.checkpoint.from);
  const contextTo = Number(match.checkpoint.to);
  const ownedFrom = Number(match.checkpoint.ownedFrom);
  const ownedTo = Number(match.checkpoint.ownedTo);
  if (
    !Number.isInteger(contextFrom) || !Number.isInteger(contextTo) || !Number.isInteger(ownedFrom) ||
    !Number.isInteger(ownedTo) || contextFrom < 1 || contextTo < contextFrom ||
    contextTo - contextFrom + 1 > SOLUTION_SLICE_PAGES || ownedFrom < contextFrom || ownedTo > contextTo ||
    match.item.page < ownedFrom || match.item.page > ownedTo
  ) throw new Error(`${number}번 base solution checkpoint context가 유효하지 않습니다`);
  if (canonicalEvidenceHash(match.item) !== canonicalEvidenceHash(solution)) {
    throw new Error(`${number}번 base solution checkpoint 항목이 현재 공식 해설과 다릅니다`);
  }
  return {
    checkpoint: {
      path: `solution-chunks/${match.name}`,
      sha256: await sha256File(join(solutionDir, match.name)),
    },
    contextFrom,
    contextTo,
    ownedFrom,
    ownedTo,
    itemHash: canonicalEvidenceHash(match.item),
  };
}

type SolutionFidelityInput = {
  key: string;
  printedNumber: string;
  qtype: QuizItemEx["qtype"];
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

function parseSolutionFidelityDecisions(
  value: unknown,
  inputs: SolutionFidelityInput[]
): SolutionFidelityDecision[] {
  if (!Array.isArray(value)) throw new Error("해설 fidelity 결과가 배열이 아닙니다");
  const expected = new Set(inputs.map((input) => input.key));
  const seen = new Set<string>();
  const decisions = value.map((raw, index): SolutionFidelityDecision => {
    const row = object(raw, `해설 fidelity ${index + 1}`);
    const key = exactString(row.key, `해설 fidelity ${index + 1}.key`, 100);
    if (!expected.has(key) || seen.has(key)) throw new Error(`해설 fidelity key가 없거나 중복입니다: ${key}`);
    seen.add(key);
    const sourcePage = Number(row.sourcePage);
    if (!Number.isInteger(sourcePage) || sourcePage < 1) {
      throw new Error(`해설 fidelity ${key}.sourcePage가 유효하지 않습니다`);
    }
    if (!( ["exact", "mismatch", "not_visible", "unverifiable"] as unknown[]).includes(row.answerStatus)) {
      throw new Error(`해설 fidelity ${key}.answerStatus가 유효하지 않습니다`);
    }
    if (!( ["exact", "mismatch", "unverifiable"] as unknown[]).includes(row.explanationStatus)) {
      throw new Error(`해설 fidelity ${key}.explanationStatus가 유효하지 않습니다`);
    }
    return {
      key,
      sourcePage,
      answerStatus: row.answerStatus as SolutionFidelityDecision["answerStatus"],
      explanationStatus: row.explanationStatus as SolutionFidelityDecision["explanationStatus"],
      evidence: exactString(row.evidence, `해설 fidelity ${key}.evidence`, 2000),
    };
  });
  if (seen.size !== expected.size) throw new Error("해설 fidelity 결과에 누락이 있습니다");
  return decisions;
}

async function evaluateSolutionFidelity(
  path: string,
  from: number,
  to: number,
  ownership: { from: number; to: number },
  inputs: SolutionFidelityInput[]
): Promise<SolutionFidelityDecision[]> {
  const modelInputs = inputs.map((input) => ({
    key: input.key,
    printed_number: input.printedNumber,
    question_type: input.qtype,
    source_page: input.sourcePage,
    raw_answer: input.rawAnswer,
    explanation: input.explanation,
    complete: input.complete,
  }));
  const prompt =
    `Attached official solution PDF slice contains original pages ${from}-${to}. ` +
    `Inputs were assigned by their recorded start pages in owned range ${ownership.from}-${ownership.to}. ` +
    `Independently report each actual visible start page even when the recorded page is wrong; use all other pages as context.\n\n` +
    `${SOLUTION_FIDELITY_RULES}\n\nAccepted solutions:\n${JSON.stringify(modelInputs)}`;
  const result = await withFullContextAi(() => getCodexProvider({
    model: IMPORT_MODEL,
    reasoningEffort: IMPORT_REASONING_EFFORT,
  }).complete({
    operation: "problem-extract",
    prompt,
    file: { path, kind: "pdf" },
    schema: SOLUTION_FIDELITY_SCHEMA,
    model: IMPORT_MODEL,
    reasoningEffort: IMPORT_REASONING_EFFORT,
    lane: "bulk",
  }));
  return parseSolutionFidelityDecisions(schemaItems(result.text, "해설 fidelity 응답"), inputs);
}

async function solutionFidelityCheckpoint(
  entry: CorpusManifestEntry,
  evidence: PdfEvidence,
  stateDir: string,
  index: number,
  slice: SourceSlice,
  ownership: { from: number; to: number },
  effectiveProblemCorpusHash: string,
  inputs: SolutionFidelityInput[]
): Promise<{
  decisions: SolutionFidelityDecision[];
  evidence: SolutionFidelityCheckpointEvidence;
}> {
  const inputHash = canonicalEvidenceHash(inputs);
  const relativePath =
    `solution-fidelity/v${SOLUTION_FIDELITY_VERSION}-${String(index).padStart(4, "0")}-` +
    `${effectiveProblemCorpusHash}-${inputHash}.json`;
  const path = join(stateDir, relativePath);
  let checkpoint: Record<string, unknown>;
  let decisions: SolutionFidelityDecision[];
  if (existsSync(path)) {
    checkpoint = object(JSON.parse(readFileSync(path, "utf8")), relativePath);
    if (
      checkpoint.version !== SOLUTION_FIDELITY_VERSION || checkpoint.entryId !== entry.id ||
      checkpoint.sourceHash !== evidence.sha256 || checkpoint.from !== slice.from || checkpoint.to !== slice.to ||
      checkpoint.ownedFrom !== ownership.from || checkpoint.ownedTo !== ownership.to ||
      checkpoint.classifierVersion !== CLASSIFIER_VERSION || checkpoint.rulesDigest !== CLASSIFIER_DIGEST ||
      checkpoint.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
      checkpoint.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST ||
      checkpoint.effectiveProblemCorpusHash !== effectiveProblemCorpusHash || checkpoint.inputHash !== inputHash ||
      checkpoint.promptDigest !== SOLUTION_FIDELITY_PROMPT_DIGEST || checkpoint.model !== IMPORT_MODEL ||
      checkpoint.reasoningEffort !== IMPORT_REASONING_EFFORT ||
      canonicalEvidenceHash(checkpoint.inputs) !== canonicalEvidenceHash(inputs)
    ) throw new Error(`기존 해설 fidelity 체크포인트 메타데이터가 다릅니다: ${path}`);
    decisions = parseSolutionFidelityDecisions(checkpoint.items, inputs);
  } else {
    decisions = await evaluateSolutionFidelity(slice.path, slice.from, slice.to, ownership, inputs);
    checkpoint = {
      version: SOLUTION_FIDELITY_VERSION,
      entryId: entry.id,
      sourceHash: evidence.sha256,
      from: slice.from,
      to: slice.to,
      ownedFrom: ownership.from,
      ownedTo: ownership.to,
      classifierVersion: CLASSIFIER_VERSION,
      rulesDigest: CLASSIFIER_DIGEST,
      transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
      effectiveProblemCorpusHash,
      inputHash,
      promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
      model: IMPORT_MODEL,
      reasoningEffort: IMPORT_REASONING_EFFORT,
      inputs,
      items: decisions,
    };
    await writeImmutableEvidence(path, checkpoint);
  }
  const sha256 = await sha256File(path);
  if (sha256 !== canonicalEvidenceHash(checkpoint)) throw new Error(`해설 fidelity hash가 다릅니다: ${path}`);
  return {
    decisions,
    evidence: {
      path: relativePath,
      sha256,
      from: slice.from,
      to: slice.to,
      ownedFrom: ownership.from,
      ownedTo: ownership.to,
      inputHash,
    },
  };
}

async function withSolutionContextSlice<T>(
  analysisPath: string,
  contextFrom: number,
  contextTo: number,
  run: (contextPath: string) => Promise<T>
): Promise<T> {
  if (
    !Number.isInteger(contextFrom) || !Number.isInteger(contextTo) || contextFrom < 1 ||
    contextTo < contextFrom || contextTo - contextFrom + 1 > SOLUTION_SLICE_PAGES
  ) throw new Error(`해설 repair context 범위가 유효하지 않습니다: ${contextFrom}-${contextTo}`);
  const sliced = await slicePdf(analysisPath, SOLUTION_SLICE_PAGES, SOLUTION_SLICE_STRIDE);
  if (!sliced) {
    if (contextFrom !== 1 || await pdfPageCount(analysisPath) !== contextTo) {
      throw new Error(`해설 repair context ${contextFrom}-${contextTo} slice를 만들 수 없습니다`);
    }
    return run(analysisPath);
  }
  try {
    const target = sliced.slices.find((slice) => slice.from === contextFrom && slice.to === contextTo);
    if (!target) throw new Error(`해설 repair context ${contextFrom}-${contextTo} slice가 없습니다`);
    return await run(target.path);
  } finally {
    sliced.cleanup();
  }
}

async function reviseSolutionItem(
  entry: CorpusManifestEntry,
  evidence: PdfEvidence,
  stateDir: string,
  contextPath: string,
  effectiveProblemCorpusHash: string,
  base: SolutionFidelityInput,
  firstSolution: SolutionItem,
  firstDecision: SolutionFidelityDecision,
  firstEvidence: SolutionRepairEvidence,
  trigger: SolutionRevisionTrigger
): Promise<{
  solution: SolutionItem;
  decision: SolutionFidelityDecision;
  fidelityArtifact: EvidencePointer;
  evidence: SolutionRevisionEvidence;
}> {
  const firstTerminalAnswer = firstDecision.answerStatus === "exact" ||
    firstDecision.answerStatus === "not_visible" && base.allowDerivedMarkerAnswer;
  const firstTerminal = firstDecision.sourcePage === firstSolution.page &&
    firstDecision.explanationStatus === "exact" && firstTerminalAnswer;
  if (
    firstEvidence.revision || firstEvidence.key !== base.key ||
    firstEvidence.printedNumber !== base.printedNumber ||
    firstEvidence.contextFrom !== base.baseContextFrom || firstEvidence.contextTo !== base.baseContextTo ||
    firstEvidence.baseSolutionItemHash !== base.baseSolutionItemHash ||
    firstEvidence.effectiveSolutionItemHash !== canonicalEvidenceHash(firstSolution) ||
    firstEvidence.effectivePage !== firstSolution.page ||
    trigger.kind === "fidelity" && firstTerminal ||
    trigger.kind === "semantic" && (!firstTerminal || trigger.semanticDecision.key !== base.key)
  ) throw new Error(`${base.key} 해설 revision 입력이 첫 repair evidence와 다릅니다`);

  for (const [label, pointer] of [
    ["base solution", firstEvidence.baseSolutionCheckpoint],
    ["base solution fidelity", firstEvidence.baseFidelityCheckpoint],
    ["solution repair", firstEvidence.repairArtifact],
    ["solution repair fidelity", firstEvidence.fidelityArtifact],
  ] as const) {
    const path = confinedStateFile(stateDir, pointer.path, label);
    if (await sha256File(path) !== pointer.sha256) throw new Error(`${base.key} ${label} hash가 다릅니다`);
  }

  const diagnosticDecisionHash = canonicalEvidenceHash(firstDecision);
  const semanticDecisionHash = trigger.kind === "semantic"
    ? canonicalEvidenceHash(trigger.semanticDecision)
    : undefined;
  const triggerEvidence = trigger.kind === "semantic" ? {
    kind: trigger.kind,
    fidelityDecisionHash: diagnosticDecisionHash,
    semanticCheckpoint: trigger.semanticCheckpoint,
    semanticDecisionHash,
  } : {
    kind: trigger.kind,
    fidelityDecisionHash: diagnosticDecisionHash,
  };
  if (trigger.kind === "semantic") {
    const semanticPath = confinedStateFile(stateDir, trigger.semanticCheckpoint.path, "semantic choice");
    if (await sha256File(semanticPath) !== trigger.semanticCheckpoint.sha256) {
      throw new Error(`${base.key} semantic choice hash가 다릅니다`);
    }
    const checkpoint = object(JSON.parse(readFileSync(semanticPath, "utf8")), "semantic choice");
    if (
      checkpoint.inputHash !== trigger.semanticCheckpoint.inputHash ||
      checkpoint.effectiveCorpusHash !== effectiveProblemCorpusHash ||
      checkpoint.effectiveCorpusHash !== trigger.semanticCheckpoint.effectiveCorpusHash ||
      checkpoint.effectiveSolutionCorpusHash !== trigger.semanticCheckpoint.effectiveSolutionCorpusHash
    ) throw new Error(`${base.key} semantic choice corpus binding이 다릅니다`);
  }
  const revisionBasisHash = canonicalEvidenceHash({
    key: base.key,
    sourceHash: evidence.sha256,
    basePage: base.sourcePage,
    contextFrom: base.baseContextFrom,
    contextTo: base.baseContextTo,
    baseSolutionCheckpoint: firstEvidence.baseSolutionCheckpoint,
    baseSolutionItemHash: base.baseSolutionItemHash,
    baseRepairArtifact: firstEvidence.repairArtifact,
    baseRepairFidelityArtifact: firstEvidence.fidelityArtifact,
    baseRepairSolutionItemHash: firstEvidence.effectiveSolutionItemHash,
    trigger: triggerEvidence,
    revisionPromptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
  });
  const revisionRelativePath =
    `solution-revisions/v${SOLUTION_REVISION_VERSION}-${String(firstSolution.page).padStart(4, "0")}-` +
    `${base.printedNumber.padStart(4, "0")}-${revisionBasisHash}.json`;
  const revisionPath = join(stateDir, revisionRelativePath);

  let revised: SolutionItem;
  let revisionCheckpoint: Record<string, unknown>;
  if (existsSync(revisionPath)) {
    revisionCheckpoint = object(JSON.parse(readFileSync(revisionPath, "utf8")), revisionRelativePath);
    if (
      revisionCheckpoint.version !== SOLUTION_REVISION_VERSION || revisionCheckpoint.entryId !== entry.id ||
      revisionCheckpoint.key !== base.key || revisionCheckpoint.printedNumber !== base.printedNumber ||
      revisionCheckpoint.sourceHash !== evidence.sha256 ||
      revisionCheckpoint.basePage !== base.sourcePage ||
      revisionCheckpoint.contextFrom !== base.baseContextFrom || revisionCheckpoint.contextTo !== base.baseContextTo ||
      revisionCheckpoint.baseOwnedFrom !== base.baseOwnedFrom || revisionCheckpoint.baseOwnedTo !== base.baseOwnedTo ||
      revisionCheckpoint.effectiveProblemCorpusHash !== effectiveProblemCorpusHash ||
      canonicalEvidenceHash(revisionCheckpoint.baseSolutionCheckpoint) !==
        canonicalEvidenceHash(firstEvidence.baseSolutionCheckpoint) ||
      revisionCheckpoint.baseSolutionItemHash !== base.baseSolutionItemHash ||
      canonicalEvidenceHash(revisionCheckpoint.baseRepairArtifact) !==
        canonicalEvidenceHash(firstEvidence.repairArtifact) ||
      canonicalEvidenceHash(revisionCheckpoint.baseRepairFidelityArtifact) !==
        canonicalEvidenceHash(firstEvidence.fidelityArtifact) ||
      revisionCheckpoint.baseRepairPage !== firstSolution.page ||
      revisionCheckpoint.baseRepairSolutionItemHash !== firstEvidence.effectiveSolutionItemHash ||
      revisionCheckpoint.diagnosticDecisionHash !== diagnosticDecisionHash ||
      canonicalEvidenceHash(revisionCheckpoint.diagnosticDecision) !== diagnosticDecisionHash ||
      canonicalEvidenceHash(revisionCheckpoint.trigger) !== canonicalEvidenceHash(triggerEvidence) ||
      (trigger.kind === "semantic" &&
        canonicalEvidenceHash(revisionCheckpoint.semanticDecision) !== semanticDecisionHash) ||
      revisionCheckpoint.promptVersion !== TARGETED_SOLUTION_REVISION_VERSION ||
      revisionCheckpoint.promptDigest !== TARGETED_SOLUTION_REVISION_PROMPT_DIGEST ||
      revisionCheckpoint.model !== IMPORT_MODEL || revisionCheckpoint.reasoningEffort !== IMPORT_REASONING_EFFORT
    ) throw new Error(`기존 solution revision 체크포인트 메타데이터가 다릅니다: ${revisionPath}`);
    revised = parseSolutionItems(JSON.stringify([revisionCheckpoint.item]))[0];
  } else {
    revised = (await withTargetedAi(() => extractSolutionsFromFile(contextPath, "pdf", {
      sliceBase: base.baseContextFrom,
      contentPageCount: base.baseContextTo - base.baseContextFrom + 1,
      target: { printedNumber: base.printedNumber },
      revisionEvidence: trigger.kind === "semantic" ? trigger.semanticDecision.evidence : firstDecision.evidence,
      reasoningEffort: IMPORT_REASONING_EFFORT,
    })))[0];
    revisionCheckpoint = {
      version: SOLUTION_REVISION_VERSION,
      entryId: entry.id,
      key: base.key,
      printedNumber: base.printedNumber,
      sourceHash: evidence.sha256,
      basePage: base.sourcePage,
      contextFrom: base.baseContextFrom,
      contextTo: base.baseContextTo,
      baseOwnedFrom: base.baseOwnedFrom,
      baseOwnedTo: base.baseOwnedTo,
      effectiveProblemCorpusHash,
      baseSolutionCheckpoint: firstEvidence.baseSolutionCheckpoint,
      baseSolutionItemHash: base.baseSolutionItemHash,
      baseRepairArtifact: firstEvidence.repairArtifact,
      baseRepairFidelityArtifact: firstEvidence.fidelityArtifact,
      baseRepairPage: firstSolution.page,
      baseRepairSolutionItemHash: firstEvidence.effectiveSolutionItemHash,
      trigger: triggerEvidence,
      diagnosticDecision: firstDecision,
      diagnosticDecisionHash,
      ...(trigger.kind === "semantic" ? { semanticDecision: trigger.semanticDecision } : {}),
      promptVersion: TARGETED_SOLUTION_REVISION_VERSION,
      promptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
      model: IMPORT_MODEL,
      reasoningEffort: IMPORT_REASONING_EFFORT,
      effectivePage: revised.page,
      item: revised,
    };
    await writeImmutableEvidence(revisionPath, revisionCheckpoint);
  }
  if (
    numericPrintedLocator(revised.number) !== Number(base.printedNumber) ||
    revised.page < base.baseContextFrom || revised.page > base.baseContextTo ||
    revisionCheckpoint.effectivePage !== revised.page || revised.complete !== true ||
    !revised.answer.trim() || !revised.explanation.trim()
  ) throw new Error(`${base.key} 해설 revision이 번호·bounded context·완전한 공식 해설을 보존하지 않았습니다`);
  const revisionArtifactHash = await sha256File(revisionPath);
  if (revisionArtifactHash !== canonicalEvidenceHash(revisionCheckpoint)) {
    throw new Error(`${base.key} solution revision artifact hash가 다릅니다`);
  }

  const effectiveSolutionItemHash = canonicalEvidenceHash(revised);
  const revisedInput: SolutionFidelityInput = {
    ...base,
    sourcePage: revised.page,
    rawAnswer: revised.answer,
    explanation: revised.explanation,
  };
  const inputHash = canonicalEvidenceHash(revisedInput);
  const fidelityRelativePath =
    `solution-fidelity-revisions/v${SOLUTION_REVISION_FIDELITY_VERSION}-` +
    `${String(firstSolution.page).padStart(4, "0")}-${base.printedNumber.padStart(4, "0")}-` +
    `${revisionArtifactHash}-${effectiveSolutionItemHash}.json`;
  const fidelityPath = join(stateDir, fidelityRelativePath);
  let fidelityCheckpoint: Record<string, unknown>;
  let decision: SolutionFidelityDecision;
  if (existsSync(fidelityPath)) {
    fidelityCheckpoint = object(JSON.parse(readFileSync(fidelityPath, "utf8")), fidelityRelativePath);
    if (
      fidelityCheckpoint.version !== SOLUTION_REVISION_FIDELITY_VERSION ||
      fidelityCheckpoint.entryId !== entry.id || fidelityCheckpoint.key !== base.key ||
      fidelityCheckpoint.sourceHash !== evidence.sha256 ||
      fidelityCheckpoint.from !== base.baseContextFrom || fidelityCheckpoint.to !== base.baseContextTo ||
      fidelityCheckpoint.basePage !== base.sourcePage ||
      fidelityCheckpoint.baseRepairPage !== firstSolution.page || fidelityCheckpoint.effectivePage !== revised.page ||
      fidelityCheckpoint.baseOwnedFrom !== base.baseOwnedFrom || fidelityCheckpoint.baseOwnedTo !== base.baseOwnedTo ||
      fidelityCheckpoint.effectiveProblemCorpusHash !== effectiveProblemCorpusHash ||
      canonicalEvidenceHash(fidelityCheckpoint.baseSolutionCheckpoint) !==
        canonicalEvidenceHash(firstEvidence.baseSolutionCheckpoint) ||
      fidelityCheckpoint.baseSolutionItemHash !== base.baseSolutionItemHash ||
      canonicalEvidenceHash(fidelityCheckpoint.baseRepairArtifact) !==
        canonicalEvidenceHash(firstEvidence.repairArtifact) ||
      canonicalEvidenceHash(fidelityCheckpoint.baseRepairFidelityArtifact) !==
        canonicalEvidenceHash(firstEvidence.fidelityArtifact) ||
      fidelityCheckpoint.baseRepairSolutionItemHash !== firstEvidence.effectiveSolutionItemHash ||
      fidelityCheckpoint.diagnosticDecisionHash !== diagnosticDecisionHash ||
      canonicalEvidenceHash(fidelityCheckpoint.trigger) !== canonicalEvidenceHash(triggerEvidence) ||
      canonicalEvidenceHash(fidelityCheckpoint.revisionArtifact) !== canonicalEvidenceHash({
        path: revisionRelativePath,
        sha256: revisionArtifactHash,
      }) ||
      fidelityCheckpoint.effectiveSolutionItemHash !== effectiveSolutionItemHash ||
      fidelityCheckpoint.inputHash !== inputHash || fidelityCheckpoint.promptDigest !== SOLUTION_FIDELITY_PROMPT_DIGEST ||
      fidelityCheckpoint.model !== IMPORT_MODEL || fidelityCheckpoint.reasoningEffort !== IMPORT_REASONING_EFFORT ||
      canonicalEvidenceHash(fidelityCheckpoint.input) !== canonicalEvidenceHash(revisedInput)
    ) throw new Error(`기존 revision 해설 fidelity 메타데이터가 다릅니다: ${fidelityPath}`);
    decision = parseSolutionFidelityDecisions([fidelityCheckpoint.item], [revisedInput])[0];
  } else {
    decision = (await evaluateSolutionFidelity(
      contextPath,
      base.baseContextFrom,
      base.baseContextTo,
      { from: base.baseContextFrom, to: base.baseContextTo },
      [revisedInput]
    ))[0];
    fidelityCheckpoint = {
      version: SOLUTION_REVISION_FIDELITY_VERSION,
      entryId: entry.id,
      key: base.key,
      sourceHash: evidence.sha256,
      from: base.baseContextFrom,
      to: base.baseContextTo,
      basePage: base.sourcePage,
      baseRepairPage: firstSolution.page,
      effectivePage: revised.page,
      baseOwnedFrom: base.baseOwnedFrom,
      baseOwnedTo: base.baseOwnedTo,
      effectiveProblemCorpusHash,
      baseSolutionCheckpoint: firstEvidence.baseSolutionCheckpoint,
      baseSolutionItemHash: base.baseSolutionItemHash,
      baseRepairArtifact: firstEvidence.repairArtifact,
      baseRepairFidelityArtifact: firstEvidence.fidelityArtifact,
      baseRepairSolutionItemHash: firstEvidence.effectiveSolutionItemHash,
      diagnosticDecisionHash,
      trigger: triggerEvidence,
      revisionArtifact: { path: revisionRelativePath, sha256: revisionArtifactHash },
      effectiveSolutionItemHash,
      inputHash,
      promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
      model: IMPORT_MODEL,
      reasoningEffort: IMPORT_REASONING_EFFORT,
      input: revisedInput,
      item: decision,
    };
    await writeImmutableEvidence(fidelityPath, fidelityCheckpoint);
  }
  const fidelityArtifactHash = await sha256File(fidelityPath);
  if (fidelityArtifactHash !== canonicalEvidenceHash(fidelityCheckpoint)) {
    throw new Error(`${base.key} revision 해설 fidelity hash가 다릅니다`);
  }
  const terminalAnswer = decision.answerStatus === "exact" ||
    decision.answerStatus === "not_visible" && base.allowDerivedMarkerAnswer;
  if (
    decision.sourcePage !== revised.page || decision.explanationStatus !== "exact" || !terminalAnswer
  ) throw new Error(`${base.key} 두 번째 source-grounded 해설 revision도 terminal이 아닙니다`);

  return {
    solution: revised,
    decision,
    fidelityArtifact: { path: fidelityRelativePath, sha256: fidelityArtifactHash },
    evidence: {
      trigger: triggerEvidence,
      baseRepairPage: firstSolution.page,
      effectivePage: revised.page,
      baseRepairArtifact: firstEvidence.repairArtifact,
      baseRepairFidelityArtifact: firstEvidence.fidelityArtifact,
      solutionArtifact: {
        path: revisionRelativePath,
        sha256: revisionArtifactHash,
        revisionPromptVersion: TARGETED_SOLUTION_REVISION_VERSION,
        revisionPromptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
      },
      fidelityArtifact: {
        path: fidelityRelativePath,
        sha256: fidelityArtifactHash,
        promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
      },
      diagnosticDecisionHash,
      baseSolutionItemHash: base.baseSolutionItemHash,
      baseRepairSolutionItemHash: firstEvidence.effectiveSolutionItemHash,
      effectiveSolutionItemHash,
      baseRepairRawAnswerHash: sha256Text(firstSolution.answer),
      effectiveRawAnswerHash: sha256Text(revised.answer),
      baseRepairExplanationHash: sha256Text(firstSolution.explanation),
      effectiveExplanationHash: sha256Text(revised.explanation),
    },
  };
}

async function repairSolutionItem(
  entry: CorpusManifestEntry,
  evidence: PdfEvidence,
  stateDir: string,
  analysisPath: string,
  effectiveProblemCorpusHash: string,
  base: SolutionFidelityInput,
  baseFidelityCheckpoint: SolutionFidelityCheckpointEvidence,
  revisionTrigger?: Extract<SolutionRevisionTrigger, { kind: "semantic" }>
): Promise<{
  solution: SolutionItem;
  decision: SolutionFidelityDecision;
  fidelityArtifact: EvidencePointer;
  evidence: SolutionRepairEvidence;
}> {
  const number = base.printedNumber;
  const basePage = base.sourcePage;
  const repairRelativePath =
    `solution-repairs/v${SOLUTION_REPAIR_VERSION}-${String(basePage).padStart(4, "0")}-` +
    `${number.padStart(4, "0")}-${baseFidelityCheckpoint.sha256}.json`;
  const repairPath = join(stateDir, repairRelativePath);

  return withSolutionContextSlice(analysisPath, base.baseContextFrom, base.baseContextTo, async (contextPath) => {
    let corrected: SolutionItem;
    let repairCheckpoint: Record<string, unknown>;
    if (existsSync(repairPath)) {
      repairCheckpoint = object(JSON.parse(readFileSync(repairPath, "utf8")), repairRelativePath);
      if (
        repairCheckpoint.version !== SOLUTION_REPAIR_VERSION || repairCheckpoint.entryId !== entry.id ||
        repairCheckpoint.key !== base.key || repairCheckpoint.printedNumber !== number ||
        repairCheckpoint.basePage !== basePage || repairCheckpoint.sourceHash !== evidence.sha256 ||
        repairCheckpoint.contextFrom !== base.baseContextFrom || repairCheckpoint.contextTo !== base.baseContextTo ||
        repairCheckpoint.baseOwnedFrom !== base.baseOwnedFrom ||
        repairCheckpoint.baseOwnedTo !== base.baseOwnedTo ||
        repairCheckpoint.effectiveProblemCorpusHash !== effectiveProblemCorpusHash ||
        canonicalEvidenceHash(repairCheckpoint.baseSolutionCheckpoint) !==
          canonicalEvidenceHash(base.baseSolutionCheckpoint) ||
        canonicalEvidenceHash(repairCheckpoint.baseFidelityCheckpoint) !== canonicalEvidenceHash({
          path: baseFidelityCheckpoint.path,
          sha256: baseFidelityCheckpoint.sha256,
        }) ||
        repairCheckpoint.baseSolutionItemHash !== base.baseSolutionItemHash ||
        repairCheckpoint.baseRawAnswerHash !== sha256Text(base.rawAnswer) ||
        repairCheckpoint.baseExplanationHash !== sha256Text(base.explanation) ||
        repairCheckpoint.promptVersion !== TARGETED_SOLUTION_TRANSCRIPTION_VERSION ||
        repairCheckpoint.promptDigest !== TARGETED_SOLUTION_PROMPT_DIGEST ||
        repairCheckpoint.model !== IMPORT_MODEL || repairCheckpoint.reasoningEffort !== IMPORT_REASONING_EFFORT
      ) throw new Error(`기존 해설 repair 체크포인트 메타데이터가 다릅니다: ${repairPath}`);
      corrected = parseSolutionItems(JSON.stringify([repairCheckpoint.item]))[0];
    } else {
      corrected = (await withTargetedAi(() => extractSolutionsFromFile(contextPath, "pdf", {
        sliceBase: base.baseContextFrom,
        contentPageCount: base.baseContextTo - base.baseContextFrom + 1,
        target: { printedNumber: number },
        reasoningEffort: IMPORT_REASONING_EFFORT,
      })))[0];
      repairCheckpoint = {
        version: SOLUTION_REPAIR_VERSION,
        entryId: entry.id,
        key: base.key,
        printedNumber: number,
        basePage,
        contextFrom: base.baseContextFrom,
        contextTo: base.baseContextTo,
        baseOwnedFrom: base.baseOwnedFrom,
        baseOwnedTo: base.baseOwnedTo,
        sourceHash: evidence.sha256,
        effectiveProblemCorpusHash,
        baseSolutionCheckpoint: base.baseSolutionCheckpoint,
        baseFidelityCheckpoint: {
          path: baseFidelityCheckpoint.path,
          sha256: baseFidelityCheckpoint.sha256,
        },
        baseSolutionItemHash: base.baseSolutionItemHash,
        baseRawAnswerHash: sha256Text(base.rawAnswer),
        baseExplanationHash: sha256Text(base.explanation),
        promptVersion: TARGETED_SOLUTION_TRANSCRIPTION_VERSION,
        promptDigest: TARGETED_SOLUTION_PROMPT_DIGEST,
        model: IMPORT_MODEL,
        reasoningEffort: IMPORT_REASONING_EFFORT,
        effectivePage: corrected.page,
        item: corrected,
      };
      await writeImmutableEvidence(repairPath, repairCheckpoint);
    }
    if (
      numericPrintedLocator(corrected.number) !== Number(number) || corrected.page < base.baseContextFrom ||
      corrected.page > base.baseContextTo ||
      repairCheckpoint.effectivePage !== corrected.page ||
      corrected.complete !== true || !corrected.answer.trim() || !corrected.explanation.trim()
    ) throw new Error(`${base.key} 해설 repair가 번호·bounded context·완전한 공식 해설을 보존하지 않았습니다`);
    const repairArtifactHash = await sha256File(repairPath);
    if (repairArtifactHash !== canonicalEvidenceHash(repairCheckpoint)) {
      throw new Error(`${base.key} 해설 repair artifact hash가 다릅니다`);
    }

    const effectiveSolutionItemHash = canonicalEvidenceHash(corrected);
    const repairedInput: SolutionFidelityInput = {
      ...base,
      sourcePage: corrected.page,
      rawAnswer: corrected.answer,
      explanation: corrected.explanation,
    };
    const repairedInputHash = canonicalEvidenceHash(repairedInput);
    const fidelityRelativePath =
      `solution-fidelity-repairs/v${SOLUTION_REPAIR_FIDELITY_VERSION}-` +
      `${String(basePage).padStart(4, "0")}-${number.padStart(4, "0")}-` +
      `${baseFidelityCheckpoint.sha256}-${effectiveSolutionItemHash}.json`;
    const fidelityPath = join(stateDir, fidelityRelativePath);
    let fidelityCheckpoint: Record<string, unknown>;
    let decision: SolutionFidelityDecision;
    if (existsSync(fidelityPath)) {
      fidelityCheckpoint = object(JSON.parse(readFileSync(fidelityPath, "utf8")), fidelityRelativePath);
      if (
        fidelityCheckpoint.version !== SOLUTION_REPAIR_FIDELITY_VERSION || fidelityCheckpoint.entryId !== entry.id ||
        fidelityCheckpoint.key !== base.key || fidelityCheckpoint.sourceHash !== evidence.sha256 ||
        fidelityCheckpoint.from !== base.baseContextFrom || fidelityCheckpoint.to !== base.baseContextTo ||
        fidelityCheckpoint.basePage !== basePage || fidelityCheckpoint.effectivePage !== corrected.page ||
        fidelityCheckpoint.baseOwnedFrom !== base.baseOwnedFrom ||
        fidelityCheckpoint.baseOwnedTo !== base.baseOwnedTo ||
        fidelityCheckpoint.effectiveProblemCorpusHash !== effectiveProblemCorpusHash ||
        canonicalEvidenceHash(fidelityCheckpoint.baseSolutionCheckpoint) !==
          canonicalEvidenceHash(base.baseSolutionCheckpoint) ||
        canonicalEvidenceHash(fidelityCheckpoint.baseFidelityCheckpoint) !== canonicalEvidenceHash({
          path: baseFidelityCheckpoint.path,
          sha256: baseFidelityCheckpoint.sha256,
        }) ||
        canonicalEvidenceHash(fidelityCheckpoint.repairArtifact) !== canonicalEvidenceHash({
          path: repairRelativePath,
          sha256: repairArtifactHash,
        }) ||
        fidelityCheckpoint.effectiveSolutionItemHash !== effectiveSolutionItemHash ||
        fidelityCheckpoint.inputHash !== repairedInputHash ||
        fidelityCheckpoint.promptDigest !== SOLUTION_FIDELITY_PROMPT_DIGEST ||
        fidelityCheckpoint.model !== IMPORT_MODEL || fidelityCheckpoint.reasoningEffort !== IMPORT_REASONING_EFFORT ||
        canonicalEvidenceHash(fidelityCheckpoint.input) !== canonicalEvidenceHash(repairedInput)
      ) throw new Error(`기존 repair 해설 fidelity 메타데이터가 다릅니다: ${fidelityPath}`);
      decision = parseSolutionFidelityDecisions([fidelityCheckpoint.item], [repairedInput])[0];
    } else {
      decision = (await evaluateSolutionFidelity(
        contextPath,
        base.baseContextFrom,
        base.baseContextTo,
        { from: base.baseContextFrom, to: base.baseContextTo },
        [repairedInput]
      ))[0];
      fidelityCheckpoint = {
        version: SOLUTION_REPAIR_FIDELITY_VERSION,
        entryId: entry.id,
        key: base.key,
        sourceHash: evidence.sha256,
        from: base.baseContextFrom,
        to: base.baseContextTo,
        basePage,
        effectivePage: corrected.page,
        baseOwnedFrom: base.baseOwnedFrom,
        baseOwnedTo: base.baseOwnedTo,
        effectiveProblemCorpusHash,
        baseSolutionCheckpoint: base.baseSolutionCheckpoint,
        baseFidelityCheckpoint: {
          path: baseFidelityCheckpoint.path,
          sha256: baseFidelityCheckpoint.sha256,
        },
        repairArtifact: { path: repairRelativePath, sha256: repairArtifactHash },
        effectiveSolutionItemHash,
        inputHash: repairedInputHash,
        promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
        model: IMPORT_MODEL,
        reasoningEffort: IMPORT_REASONING_EFFORT,
        input: repairedInput,
        item: decision,
      };
      await writeImmutableEvidence(fidelityPath, fidelityCheckpoint);
    }
    const fidelityArtifactHash = await sha256File(fidelityPath);
    if (fidelityArtifactHash !== canonicalEvidenceHash(fidelityCheckpoint)) {
      throw new Error(`${base.key} repair 해설 fidelity hash가 다릅니다`);
    }
    const firstEvidence: SolutionRepairEvidence = {
      key: base.key,
      printedNumber: number,
      basePage,
      effectivePage: corrected.page,
      contextFrom: base.baseContextFrom,
      contextTo: base.baseContextTo,
      baseOwnedFrom: base.baseOwnedFrom,
      baseOwnedTo: base.baseOwnedTo,
      baseSolutionCheckpoint: base.baseSolutionCheckpoint,
      baseFidelityCheckpoint: {
        path: baseFidelityCheckpoint.path,
        sha256: baseFidelityCheckpoint.sha256,
      },
      repairArtifact: { path: repairRelativePath, sha256: repairArtifactHash },
      fidelityArtifact: {
        path: fidelityRelativePath,
        sha256: fidelityArtifactHash,
        promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
      },
      baseSolutionItemHash: base.baseSolutionItemHash,
      effectiveSolutionItemHash,
      baseRawAnswerHash: sha256Text(base.rawAnswer),
      effectiveRawAnswerHash: sha256Text(corrected.answer),
      baseExplanationHash: sha256Text(base.explanation),
      effectiveExplanationHash: sha256Text(corrected.explanation),
    };
    const terminalAnswer = decision.answerStatus === "exact" ||
      decision.answerStatus === "not_visible" && base.allowDerivedMarkerAnswer;
    const terminal = decision.sourcePage === corrected.page && decision.explanationStatus === "exact" && terminalAnswer;
    if (terminal && !revisionTrigger) {
      return {
        solution: corrected,
        decision,
        fidelityArtifact: { path: fidelityRelativePath, sha256: fidelityArtifactHash },
        evidence: firstEvidence,
      };
    }
    const revised = await reviseSolutionItem(
      entry,
      evidence,
      stateDir,
      contextPath,
      effectiveProblemCorpusHash,
      base,
      corrected,
      decision,
      firstEvidence,
      revisionTrigger ?? { kind: "fidelity" }
    );
    return {
      solution: revised.solution,
      decision: revised.decision,
      fidelityArtifact: revised.fidelityArtifact,
      evidence: { ...firstEvidence, revision: revised.evidence },
    };
  });
}

async function auditAcceptedSolutions(
  entry: CorpusManifestEntry,
  evidence: PdfEvidence,
  stateDir: string,
  classified: ClassifiedQuestion[],
  baseSolutions: SolutionItem[],
  revisionTriggers = new Map<string, Extract<SolutionRevisionTrigger, { kind: "semantic" }>>()
): Promise<{
  solutions: SolutionItem[];
  checkpoints: SolutionFidelityCheckpointEvidence[];
  items: SolutionFidelityTerminalItem[];
  repairs: SolutionRepairEvidence[];
  effectiveSolutionCorpusHash: string;
}> {
  const baseByNumber = officialSolutionsByNumber(entry, classified, baseSolutions);
  const accepted = classified.filter(({ classification }) => classification.decision === "accept");
  const effectiveProblemCorpusHash = canonicalEvidenceHash(classified);
  const inputs: SolutionFidelityInput[] = [];
  for (const item of accepted) {
    const number = numericPrintedLocator(item.question.number)!;
    const solution = baseByNumber.get(number)!;
    if (!solution.answer.trim() || !solution.explanation.trim() || solution.complete !== true) {
      throw new Error(`${number}번 공식 정답 또는 완전한 해설 본문이 비어 있습니다`);
    }
    const baseEvidence = await baseSolutionEvidence(evidence, stateDir, solution);
    let allowDerivedMarkerAnswer = false;
    if (item.question.qtype === "mcq") {
      try {
        allowDerivedMarkerAnswer = resolveOfficialAnswer(item.question, solution.answer).mode === "choice-marker";
      } catch (error) {
        if (!(error instanceof OfficialAnswerChoiceMismatchError)) throw error;
      }
    }
    inputs.push({
      key: questionKey(item.question),
      printedNumber: String(number),
      qtype: item.question.qtype,
      allowDerivedMarkerAnswer,
      sourcePage: solution.page,
      rawAnswer: solution.answer,
      explanation: solution.explanation,
      complete: true,
      baseSolutionCheckpoint: baseEvidence.checkpoint,
      baseSolutionItemHash: baseEvidence.itemHash,
      baseContextFrom: baseEvidence.contextFrom,
      baseContextTo: baseEvidence.contextTo,
      baseOwnedFrom: baseEvidence.ownedFrom,
      baseOwnedTo: baseEvidence.ownedTo,
    });
  }
  const effectiveByNumber = new Map(baseByNumber);
  const checkpoints: SolutionFidelityCheckpointEvidence[] = [];
  const repairs: SolutionRepairEvidence[] = [];
  const terminalItems = new Map<string, SolutionFidelityTerminalItem>();
  const expectedRepairKeys = new Set<string>();
  const seen = new Set<string>();

  if (inputs.length === 0) {
    return {
      solutions: baseSolutions,
      checkpoints,
      items: [],
      repairs,
      effectiveSolutionCorpusHash: canonicalEvidenceHash([]),
    };
  }

  await withImporterPdfForAnalysis(evidence, async (analysisEvidence) =>
    withSlices(
      analysisEvidence,
      SOLUTION_FIDELITY_SLICE_PAGES,
      SOLUTION_FIDELITY_SLICE_STRIDE,
      async (slices) => {
        const ownership = validateSolutionSliceTopology(slices);
        for (const [index, slice] of slices.entries()) {
          const owned = ownership[index];
          const ownedInputs = inputs.filter((input) =>
            input.sourcePage >= owned.from && input.sourcePage <= owned.to
          );
          if (ownedInputs.length === 0) continue;
          const result = await solutionFidelityCheckpoint(
            entry,
            evidence,
            stateDir,
            index,
            slice,
            owned,
            effectiveProblemCorpusHash,
            ownedInputs
          );
          checkpoints.push(result.evidence);
          const decisionByKey = new Map(result.decisions.map((decision) => [decision.key, decision]));
          for (const input of ownedInputs) {
            if (seen.has(input.key)) throw new Error(`해설 fidelity 대상이 중복되었습니다: ${input.key}`);
            seen.add(input.key);
            const decision = decisionByKey.get(input.key)!;
            if (decision.sourcePage < slice.from || decision.sourcePage > slice.to) {
              throw new Error(`${input.key} 해설 fidelity sourcePage가 첨부 범위를 벗어났습니다`);
            }
            const terminalAnswer = decision.answerStatus === "exact" ||
              decision.answerStatus === "not_visible" && input.allowDerivedMarkerAnswer;
            const needsRepair = decision.sourcePage !== input.sourcePage ||
              decision.explanationStatus !== "exact" || !terminalAnswer || input.baseContextTo > slice.to;
            if (!needsRepair) {
              terminalItems.set(input.key, {
                key: input.key,
                printedNumber: input.printedNumber,
                qtype: input.qtype,
                basePage: input.sourcePage,
                effectivePage: input.sourcePage,
                answerStatus: decision.answerStatus,
                explanationStatus: decision.explanationStatus,
                evidence: decision.evidence,
                fidelityArtifact: { path: result.evidence.path, sha256: result.evidence.sha256 },
                baseSolutionItemHash: input.baseSolutionItemHash,
                effectiveSolutionItemHash: input.baseSolutionItemHash,
                baseRawAnswerHash: sha256Text(input.rawAnswer),
                effectiveRawAnswerHash: sha256Text(input.rawAnswer),
                baseExplanationHash: sha256Text(input.explanation),
                effectiveExplanationHash: sha256Text(input.explanation),
              });
              continue;
            }
            expectedRepairKeys.add(input.key);
            const repaired = await repairSolutionItem(
              entry,
              evidence,
              stateDir,
              analysisEvidence.path,
              effectiveProblemCorpusHash,
              input,
              result.evidence,
              revisionTriggers.get(input.key)
            );
            effectiveByNumber.set(Number(input.printedNumber), repaired.solution);
            repairs.push(repaired.evidence);
            terminalItems.set(input.key, {
              key: input.key,
              printedNumber: input.printedNumber,
              qtype: input.qtype,
              basePage: input.sourcePage,
              effectivePage: repaired.solution.page,
              answerStatus: repaired.decision.answerStatus,
              explanationStatus: repaired.decision.explanationStatus,
              evidence: repaired.decision.evidence,
              fidelityArtifact: repaired.fidelityArtifact,
              baseSolutionItemHash: input.baseSolutionItemHash,
              effectiveSolutionItemHash: canonicalEvidenceHash(repaired.solution),
              baseRawAnswerHash: sha256Text(input.rawAnswer),
              effectiveRawAnswerHash: sha256Text(repaired.solution.answer),
              baseExplanationHash: sha256Text(input.explanation),
              effectiveExplanationHash: sha256Text(repaired.solution.explanation),
            });
          }
        }
      }
    )
  );
  if (seen.size !== inputs.length) throw new Error(`해설 fidelity 대상 누락: ${inputs.length - seen.size}문항`);
  const repairKeys = repairs.map((repair) => repair.key);
  if (
    terminalItems.size !== inputs.length || new Set(repairKeys).size !== repairKeys.length ||
    repairKeys.length !== expectedRepairKeys.size || repairKeys.some((key) => !expectedRepairKeys.has(key))
  ) throw new Error("해설 fidelity terminal coverage가 정확하지 않습니다");
  if ([...revisionTriggers.keys()].some((key) => !repairs.find((repair) => repair.key === key)?.revision)) {
    throw new Error("semantic 해설 revision 대상에 first repair가 없습니다");
  }
  const effectiveSolutions = baseSolutions.map((solution) =>
    effectiveByNumber.get(numericPrintedLocator(solution.number)!) ?? solution
  );
  officialSolutionsByNumber(entry, classified, effectiveSolutions);
  const effectiveSolutionCorpus = accepted.map((item) => {
    const number = numericPrintedLocator(item.question.number)!;
    return { key: questionKey(item.question), solution: effectiveByNumber.get(number)! };
  }).sort((a, b) => compareCorpusQuestionKeys(a.key, b.key));
  return {
    solutions: effectiveSolutions,
    checkpoints: checkpoints.sort((a, b) => a.path.localeCompare(b.path)),
    items: [...terminalItems.values()].sort((a, b) => compareCorpusQuestionKeys(a.key, b.key)),
    repairs: repairs.sort((a, b) => compareCorpusQuestionKeys(a.key, b.key)),
    effectiveSolutionCorpusHash: canonicalEvidenceHash(effectiveSolutionCorpus),
  };
}

function schemaItems(text: string, label: string): unknown[] {
  const parsed: unknown = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed;
  const envelope = object(parsed, label);
  if (!Array.isArray(envelope.items)) throw new Error(`${label}.items가 배열이 아닙니다`);
  return envelope.items;
}

function parseSemanticChoiceDecisions(
  value: unknown,
  inputs: Array<{ key: string; choices: string[]; detailedExplanation: string }>
): SemanticChoiceDecision[] {
  if (!Array.isArray(value)) throw new Error("semantic choice 결과가 배열이 아닙니다");
  const expected = new Map(inputs.map((input) => [input.key, input]));
  const seen = new Set<string>();
  const decisions = value.map((raw, index) => {
    const row = object(raw, `semantic choice ${index + 1}`);
    const key = exactString(row.key, `semantic choice ${index + 1}.key`, 100);
    const input = expected.get(key);
    if (!input || seen.has(key)) throw new Error(`semantic choice key가 없거나 중복입니다: ${key}`);
    seen.add(key);
    if (row.status !== "resolved" && row.status !== "ambiguous") {
      throw new Error(`semantic choice ${key}.status가 유효하지 않습니다`);
    }
    const evidence = exactString(row.evidence, `semantic choice ${key}.evidence`, 1000);
    const choiceIndex = row.choiceIndex === null ? null : Number(row.choiceIndex);
    if (
      row.status === "resolved"
        ? !Number.isInteger(choiceIndex) || choiceIndex! < 1 || choiceIndex! > input.choices.length
        : choiceIndex !== null
    ) throw new Error(`semantic choice ${key}.choiceIndex가 유효하지 않습니다`);
    return { key, status: row.status, choiceIndex, evidence } as SemanticChoiceDecision;
  });
  if (seen.size !== expected.size) throw new Error("semantic choice 결과에 누락이 있습니다");
  return decisions;
}

async function semanticChoiceCheckpoint(
  entry: CorpusManifestEntry,
  problem: PdfEvidence,
  solution: PdfEvidence,
  stateDir: string,
  effectiveCorpusHash: string,
  effectiveSolutionCorpusHash: string,
  inputs: Array<{ key: string; choices: string[]; detailedExplanation: string }>,
  solutionRevisionApplied = false
): Promise<{ decisions: SemanticChoiceDecision[]; path: string; sha256: string; inputHash: string }> {
  const inputHash = canonicalEvidenceHash(inputs);
  const relativePath = solutionRevisionApplied
    ? `semantic-choice-checks/v${SEMANTIC_CHOICE_CHECK_VERSION}-` +
      `${effectiveCorpusHash}-${effectiveSolutionCorpusHash}-${inputHash}.json`
    : `semantic-choice-checks/v${SEMANTIC_CHOICE_CHECK_VERSION}-${inputHash}.json`;
  const path = join(stateDir, relativePath);
  let checkpoint: Record<string, unknown>;
  let decisions: SemanticChoiceDecision[];
  if (existsSync(path)) {
    checkpoint = object(JSON.parse(readFileSync(path, "utf8")), relativePath);
    if (
      checkpoint.version !== SEMANTIC_CHOICE_CHECK_VERSION || checkpoint.entryId !== entry.id ||
      checkpoint.problemHash !== problem.sha256 || checkpoint.solutionHash !== solution.sha256 ||
      checkpoint.classifierVersion !== CLASSIFIER_VERSION || checkpoint.rulesDigest !== CLASSIFIER_DIGEST ||
      checkpoint.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
      checkpoint.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST ||
      checkpoint.effectiveCorpusHash !== effectiveCorpusHash || checkpoint.inputHash !== inputHash ||
      checkpoint.effectiveSolutionCorpusHash !== effectiveSolutionCorpusHash ||
      checkpoint.promptDigest !== SEMANTIC_CHOICE_PROMPT_DIGEST || checkpoint.model !== IMPORT_MODEL ||
      checkpoint.reasoningEffort !== IMPORT_REASONING_EFFORT ||
      canonicalEvidenceHash(checkpoint.inputs) !== canonicalEvidenceHash(inputs)
    ) throw new Error(`기존 semantic choice 체크포인트 메타데이터가 다릅니다: ${path}`);
    decisions = parseSemanticChoiceDecisions(checkpoint.items, inputs);
  } else {
    const prompt = `${SEMANTIC_CHOICE_RULES}\n\nItems:\n${JSON.stringify(inputs)}`;
    const result = await withTargetedAi(() => getCodexProvider({
      model: IMPORT_MODEL,
      reasoningEffort: IMPORT_REASONING_EFFORT,
    }).complete({
      operation: "problem-extract",
      prompt,
      schema: SEMANTIC_CHOICE_SCHEMA,
      model: IMPORT_MODEL,
      reasoningEffort: IMPORT_REASONING_EFFORT,
      lane: "bulk",
    }));
    decisions = parseSemanticChoiceDecisions(schemaItems(result.text, "semantic choice 응답"), inputs);
    checkpoint = {
      version: SEMANTIC_CHOICE_CHECK_VERSION,
      entryId: entry.id,
      problemHash: problem.sha256,
      solutionHash: solution.sha256,
      classifierVersion: CLASSIFIER_VERSION,
      rulesDigest: CLASSIFIER_DIGEST,
      transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
      effectiveCorpusHash,
      effectiveSolutionCorpusHash,
      inputHash,
      promptDigest: SEMANTIC_CHOICE_PROMPT_DIGEST,
      model: IMPORT_MODEL,
      reasoningEffort: IMPORT_REASONING_EFFORT,
      inputs,
      items: decisions,
    };
    await writeImmutableEvidence(path, checkpoint);
  }
  const sha256 = await sha256File(path);
  if (sha256 !== canonicalEvidenceHash(checkpoint)) throw new Error(`semantic choice hash가 다릅니다: ${path}`);
  return { decisions, path: relativePath, sha256, inputHash };
}

export function semanticExplanationWithoutMarkers(value: string): string {
  return value
    .replace(/\[\s*(?:정답|답)\s*\]\s*(?:[①-⑩]|(?:10|[1-9])(?!\d)(?:\s*번)?)/gu, "[CHOICE MARKER HIDDEN]")
    .replace(/(?:[①-⑩]|(?:10|[1-9])(?!\d))\s*번\s*(?:선택지\s*)?(?:이|가)?\s*(?:정답|답)(?:이다|입니다)?/gu, "[CHOICE MARKER HIDDEN]")
    .replace(/선택지\s*(?:[①-⑩]|(?:10|[1-9])(?!\d))(?:\s*번)?\s*(?:이|가)?\s*(?:정답|답)(?:이다|입니다)?/gu, "[CHOICE MARKER HIDDEN]")
    .replace(/(?:정답|답)\s+(?:[①-⑩]|(?:10|[1-9])(?!\d))\s*번/gu, "[CHOICE MARKER HIDDEN]")
    .replace(/(?:정답|답)\s*(?:은|는|이|가|:|：|=)\s*(?:[①-⑩]|(?:10|[1-9])(?!\d))(?:\s*번)?/gu, "[CHOICE MARKER HIDDEN]")
    .replace(/[①-⑩]/gu, "[CHOICE MARKER HIDDEN]");
}

async function problemRepairBatchAuthorityVersion(
  entry: CorpusManifestEntry,
  problem: PdfEvidence,
  stateDir: string,
  contextFrom: number,
  contextTo: number
): Promise<1 | 2> {
  const directory = join(stateDir, "problem-repair-batches");
  if (!existsSync(directory)) return 2;
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) {
    throw new Error("problem repair batch 디렉터리가 유효하지 않습니다");
  }
  const context = `${String(contextFrom).padStart(4, "0")}-${String(contextTo).padStart(4, "0")}`;
  const v1Pattern = new RegExp(`^v1-${context}-(\\d{4})-([a-f0-9]{64})\\.json$`, "u");
  const v2Pattern = new RegExp(`^v2-${context}-([a-f0-9]{64})\\.json$`, "u");
  const names = readdirSync(directory);
  const malformed = names.filter((name) =>
    (name.startsWith(`v1-${context}-`) || name.startsWith(`v2-${context}-`)) && name.endsWith(".json") &&
    !v1Pattern.test(name) && !v2Pattern.test(name)
  );
  if (malformed.length > 0) throw new Error(`problem repair batch filename이 유효하지 않습니다: ${malformed[0]}`);
  const v1Names = names.filter((name) => v1Pattern.test(name));
  const v2Names = names.filter((name) => v2Pattern.test(name));
  if (v1Names.length > 0 && v2Names.length > 0) {
    throw new Error(`${contextFrom}-${contextTo} problem repair batch v1/v2 authority가 섞였습니다`);
  }
  for (const name of [...v1Names, ...v2Names]) {
    const version = name.startsWith("v1-") ? 1 : 2;
    const match = (version === 1 ? v1Pattern : v2Pattern).exec(name)!;
    const relativePath = `problem-repair-batches/${name}`;
    const path = confinedStateFile(stateDir, relativePath, "problem repair batch authority");
    const checkpoint = object(JSON.parse(readFileSync(path, "utf8")), relativePath);
    const members = Array.isArray(checkpoint.members)
      ? checkpoint.members.map((value, index) => object(value, `${relativePath}.members[${index}]`))
      : [];
    const memberKeys = members.map((member, index) => exactString(member.key, `${relativePath}.members[${index}].key`));
    const corrected = restoredSparseQuizItems(checkpoint.items);
    const actualKeys = corrected.map(questionKey);
    if (
      checkpoint.version !== version || checkpoint.entryId !== entry.id || checkpoint.sourceHash !== problem.sha256 ||
      checkpoint.contextFrom !== contextFrom || checkpoint.contextTo !== contextTo ||
      checkpoint.model !== IMPORT_MODEL || checkpoint.reasoningEffort !== IMPORT_REASONING_EFFORT ||
      members.length === 0 || new Set(memberKeys).size !== memberKeys.length ||
      corrected.length !== memberKeys.length || new Set(actualKeys).size !== memberKeys.length ||
      actualKeys.some((key) => !memberKeys.includes(key)) ||
      await sha256File(path) !== canonicalEvidenceHash(checkpoint)
    ) throw new Error(`기존 problem repair batch authority가 유효하지 않습니다: ${path}`);
    if (version === 1) {
      const sourcePage = Number(match[1]);
      const membersDigest = match[2];
      if (
        checkpoint.sourcePage !== sourcePage || checkpoint.membersDigest !== membersDigest ||
        canonicalEvidenceHash(checkpoint.members) !== membersDigest ||
        checkpoint.promptVersion !== TARGETED_PROBLEM_BATCH_VERSION ||
        checkpoint.promptDigest !== TARGETED_PROBLEM_BATCH_PROMPT_DIGEST ||
        corrected.some((item) => item.page !== sourcePage)
      ) throw new Error(`기존 problem repair batch v1 authority가 유효하지 않습니다: ${path}`);
    } else {
      const targetsDigest = match[1];
      const pageByKey = new Map(memberKeys.map((key, index) => {
        const sourcePage = Number(members[index].sourcePage);
        if (!Number.isInteger(sourcePage) || sourcePage < contextFrom || sourcePage > contextTo) {
          throw new Error(`기존 problem repair batch v2 sourcePage가 유효하지 않습니다: ${path}`);
        }
        if (!/^[a-f0-9]{64}$/u.test(String(members[index].baseTranscriptionEvidenceHash))) {
          throw new Error(`기존 problem repair batch v2 transcription evidence hash가 유효하지 않습니다: ${path}`);
        }
        return [key, sourcePage] as const;
      }));
      if (
        checkpoint.targetsDigest !== targetsDigest || canonicalEvidenceHash(checkpoint.members) !== targetsDigest ||
        checkpoint.batchPromptVersion !== TARGETED_PROBLEM_BATCH_VERSION ||
        checkpoint.batchPromptDigest !== TARGETED_PROBLEM_BATCH_PROMPT_DIGEST ||
        checkpoint.revisionPromptVersion !== TARGETED_PROBLEM_REVISION_VERSION ||
        checkpoint.revisionPromptDigest !== TARGETED_PROBLEM_BATCH_REVISION_PROMPT_DIGEST ||
        !/^[a-f0-9]{64}$/u.test(String(checkpoint.diagnosticEvidenceHash)) ||
        corrected.some((item) => pageByKey.get(questionKey(item)) !== item.page)
      ) throw new Error(`기존 problem repair batch v2 authority가 유효하지 않습니다: ${path}`);
    }
  }
  return v1Names.length > 0 ? 1 : 2;
}

async function persistedProblemRepairAttemptKeys(
  entry: CorpusManifestEntry,
  problem: PdfEvidence,
  stateDir: string,
  baseByKey: ReadonlyMap<string, ClassifiedQuestion>
): Promise<Set<string>> {
  const keys = new Set<string>();
  const singleDir = join(stateDir, "problem-repairs");
  if (existsSync(singleDir)) {
    if (lstatSync(singleDir).isSymbolicLink() || !lstatSync(singleDir).isDirectory()) {
      throw new Error("problem repair 디렉터리가 유효하지 않습니다");
    }
    for (const name of readdirSync(singleDir).filter((value) => value.endsWith(".json"))) {
      if (!/^v2-\d{4}-\d{4}\.json$/u.test(name)) throw new Error(`problem repair filename이 유효하지 않습니다: ${name}`);
      const relativePath = `problem-repairs/${name}`;
      const path = confinedStateFile(stateDir, relativePath, "persisted problem repair");
      const checkpoint = object(JSON.parse(readFileSync(path, "utf8")), relativePath);
      const item = restoredQuizItems([checkpoint.item])[0];
      const key = exactString(checkpoint.key, `${relativePath}.key`, 100);
      if (
        checkpoint.version !== PROBLEM_REPAIR_VERSION || checkpoint.entryId !== entry.id ||
        checkpoint.sourceHash !== problem.sha256 || questionKey(item) !== key || !baseByKey.has(key) ||
        await sha256File(path) !== canonicalEvidenceHash(checkpoint)
      ) throw new Error(`persisted problem repair가 유효하지 않습니다: ${path}`);
      keys.add(key);
    }
  }
  const batchDir = join(stateDir, "problem-repair-batches");
  if (!existsSync(batchDir)) return keys;
  if (lstatSync(batchDir).isSymbolicLink() || !lstatSync(batchDir).isDirectory()) {
    throw new Error("problem repair batch 디렉터리가 유효하지 않습니다");
  }
  for (const name of readdirSync(batchDir).filter((value) => value.endsWith(".json"))) {
    const v1 = /^v1-(\d{4})-(\d{4})-(\d{4})-([a-f0-9]{64})\.json$/u.exec(name);
    const v2 = /^v2-(\d{4})-(\d{4})-([a-f0-9]{64})\.json$/u.exec(name);
    if (!v1 && !v2) throw new Error(`problem repair batch filename이 유효하지 않습니다: ${name}`);
    const version = v1 ? 1 : 2;
    const relativePath = `problem-repair-batches/${name}`;
    const path = confinedStateFile(stateDir, relativePath, "persisted problem repair batch");
    const checkpoint = object(JSON.parse(readFileSync(path, "utf8")), relativePath);
    const members = Array.isArray(checkpoint.members)
      ? checkpoint.members.map((value, index) => object(value, `${relativePath}.members[${index}]`))
      : [];
    const memberKeys = members.map((member, index) => exactString(member.key, `${relativePath}.members[${index}].key`, 100));
    const items = restoredSparseQuizItems(checkpoint.items);
    const itemKeys = items.map(questionKey);
    const digest = version === 1 ? v1![4] : v2![3];
    if (
      checkpoint.version !== version || checkpoint.entryId !== entry.id || checkpoint.sourceHash !== problem.sha256 ||
      checkpoint.contextFrom !== Number(v1?.[1] ?? v2![1]) || checkpoint.contextTo !== Number(v1?.[2] ?? v2![2]) ||
      checkpoint.model !== IMPORT_MODEL || checkpoint.reasoningEffort !== IMPORT_REASONING_EFFORT ||
      members.length === 0 || new Set(memberKeys).size !== memberKeys.length ||
      memberKeys.some((key) => !baseByKey.has(key)) || items.length !== memberKeys.length ||
      new Set(itemKeys).size !== itemKeys.length || itemKeys.some((key) => !memberKeys.includes(key)) ||
      canonicalEvidenceHash(checkpoint.members) !== digest ||
      (version === 1 ? checkpoint.membersDigest : checkpoint.targetsDigest) !== digest ||
      await sha256File(path) !== canonicalEvidenceHash(checkpoint)
    ) throw new Error(`persisted problem repair batch가 유효하지 않습니다: ${path}`);
    for (const key of memberKeys) keys.add(key);
  }
  return keys;
}

async function repairClassifiedQuestionsBatch(
  entry: CorpusManifestEntry,
  problem: PdfEvidence,
  solutionEvidence: PdfEvidence,
  stateDir: string,
  originals: ClassifiedQuestion[],
  officialSolutions: Map<number, SolutionItem>
): Promise<Array<{ classified: ClassifiedQuestion; evidence: ProblemRepairEvidence }>> {
  if (originals.length === 0) return [];
  const members = await Promise.all(originals.map(async (original) => {
    const key = questionKey(original.question);
    const number = numericPrintedLocator(original.question.number)!;
    const solution = officialSolutions.get(number);
    if (!solution) throw new Error(`${key} batch repair 공식 해설이 없습니다`);
    const baseQuestion = await baseQuestionEvidence(entry, problem, stateDir, original);
    const baseSolution = await baseSolutionEvidence(solutionEvidence, stateDir, solution);
    return { key, number, original, solution, baseQuestion, baseSolution };
  }));
  members.sort((a, b) => compareCorpusQuestionKeys(a.key, b.key));
  const contextGroups = new Map<string, ClassifiedQuestion[]>();
  for (const member of members) {
    const contextKey = `${member.baseQuestion.contextFrom}:${member.baseQuestion.contextTo}`;
    const group = contextGroups.get(contextKey) ?? [];
    group.push(member.original);
    contextGroups.set(contextKey, group);
  }
  if (contextGroups.size > 1) {
    const groups = await Promise.all([...contextGroups.values()].map((group) =>
      repairClassifiedQuestionsBatch(entry, problem, solutionEvidence, stateDir, group, officialSolutions)
    ));
    return groups.flat();
  }
  const contextFrom = members[0].baseQuestion.contextFrom;
  const contextTo = members[0].baseQuestion.contextTo;
  if (members.some((item) => item.baseQuestion.contextFrom !== contextFrom || item.baseQuestion.contextTo !== contextTo)) {
    throw new Error("batch repair members가 같은 owning context가 아닙니다");
  }
  return withImporterPdfForAnalysis(problem, (analysisProblem) =>
    withProblemContextSlice(analysisProblem.path, contextFrom, contextTo, async (contextPath) => {
      const authorityVersion = await problemRepairBatchAuthorityVersion(
        entry, problem, stateDir, contextFrom, contextTo
      );
      const correctedByKey = new Map<string, QuizItemEx>();
      const problemEvidenceByKey = new Map<string, EvidencePointer & { itemHash: string }>();
      for (const member of members) {
        const legacyRelativePath = `problem-repairs/v${PROBLEM_REPAIR_VERSION}-` +
          `${String(member.original.question.page).padStart(4, "0")}-${String(member.number).padStart(4, "0")}.json`;
        const legacyPath = join(stateDir, legacyRelativePath);
        if (!existsSync(legacyPath)) continue;
        const checkpoint = object(JSON.parse(readFileSync(legacyPath, "utf8")), legacyRelativePath);
        if (
          checkpoint.version !== PROBLEM_REPAIR_VERSION || checkpoint.entryId !== entry.id || checkpoint.key !== member.key ||
          checkpoint.sourcePage !== member.original.question.page || checkpoint.printedNumber !== String(member.number) ||
          checkpoint.sourceHash !== problem.sha256 || checkpoint.contextFrom !== contextFrom || checkpoint.contextTo !== contextTo ||
          canonicalEvidenceHash(checkpoint.baseProblemCheckpoint) !== canonicalEvidenceHash(member.baseQuestion.problem) ||
          checkpoint.baseQuestionHash !== member.baseQuestion.questionHash ||
          canonicalEvidenceHash(checkpoint.baseSolutionCheckpoint) !== canonicalEvidenceHash(member.baseSolution.checkpoint) ||
          checkpoint.baseSolutionItemHash !== member.baseSolution.itemHash ||
          checkpoint.officialRawAnswerHash !== sha256Text(member.solution.answer) ||
          checkpoint.promptVersion !== TARGETED_PROBLEM_TRANSCRIPTION_VERSION ||
          checkpoint.promptDigest !== TARGETED_PROBLEM_PROMPT_DIGEST || checkpoint.model !== IMPORT_MODEL ||
          checkpoint.reasoningEffort !== IMPORT_REASONING_EFFORT
        ) throw new Error(`기존 legacy problem repair 메타데이터가 다릅니다: ${legacyPath}`);
        const corrected = restoredQuizItems([checkpoint.item])[0];
        if (questionKey(corrected) !== member.key) throw new Error(`${member.key} legacy problem repair key가 다릅니다`);
        const sha256 = await sha256File(legacyPath);
        if (sha256 !== canonicalEvidenceHash(checkpoint)) throw new Error(`${member.key} legacy problem repair hash가 다릅니다`);
        correctedByKey.set(member.key, corrected);
        problemEvidenceByKey.set(member.key, { path: legacyRelativePath, sha256, itemHash: canonicalEvidenceHash(corrected) });
      }
      const missing = members.filter((item) => !correctedByKey.has(item.key));
      const missingBatches = authorityVersion === 1
        ? [...missing.reduce((byPage, member) => {
            const page = member.original.question.page!;
            byPage.set(page, [...(byPage.get(page) ?? []), member]);
            return byPage;
          }, new Map<number, typeof members>()).values()].flatMap((group) =>
            Array.from({ length: Math.ceil(group.length / 6) }, (_, index) => group.slice(index * 6, index * 6 + 6))
          )
        : Array.from({ length: Math.ceil(missing.length / 6) }, (_, index) => missing.slice(index * 6, index * 6 + 6));
      await mapPool(missingBatches, IMPORT_CONCURRENCY, async (group) => {
        const page = authorityVersion === 1 ? group[0].original.question.page! : null;
        const memberBasis = group.map((item) => ({
          key: item.key,
          printedNumber: String(item.number),
          ...(authorityVersion === 2 ? {
            sourcePage: item.original.question.page!,
            baseTranscriptionEvidenceHash: sha256Text(item.original.classification.transcription_evidence),
          } : {}),
          baseProblemCheckpoint: item.baseQuestion.problem,
          baseQuestionHash: item.baseQuestion.questionHash,
          baseClassificationCheckpoint: item.baseQuestion.classification,
          baseClassificationHash: item.baseQuestion.classificationHash,
          baseSolutionCheckpoint: item.baseSolution.checkpoint,
          baseSolutionItemHash: item.baseSolution.itemHash,
          officialRawAnswerHash: sha256Text(item.solution.answer),
        }));
        const targetsDigest = canonicalEvidenceHash(memberBasis);
        const diagnosticEvidence = authorityVersion === 2
          ? JSON.stringify(group.map((item) => ({
              key: item.key,
              evidence: item.original.classification.transcription_evidence,
            })))
          : null;
        const relativePath = authorityVersion === 1
          ? `problem-repair-batches/v1-${String(contextFrom).padStart(4, "0")}-` +
            `${String(contextTo).padStart(4, "0")}-${String(page).padStart(4, "0")}-${targetsDigest}.json`
          : `problem-repair-batches/v2-${String(contextFrom).padStart(4, "0")}-` +
            `${String(contextTo).padStart(4, "0")}-${targetsDigest}.json`;
        const path = join(stateDir, relativePath);
        let checkpoint: Record<string, unknown>;
        let corrected: QuizItemEx[];
        if (existsSync(path)) {
          checkpoint = object(JSON.parse(readFileSync(path, "utf8")), relativePath);
          const commonMismatch = checkpoint.version !== authorityVersion || checkpoint.entryId !== entry.id ||
            checkpoint.sourceHash !== problem.sha256 || checkpoint.contextFrom !== contextFrom ||
            checkpoint.contextTo !== contextTo || checkpoint.model !== IMPORT_MODEL ||
            checkpoint.reasoningEffort !== IMPORT_REASONING_EFFORT ||
            canonicalEvidenceHash(checkpoint.members) !== canonicalEvidenceHash(memberBasis);
          const versionMismatch = authorityVersion === 1
            ? checkpoint.sourcePage !== page || checkpoint.membersDigest !== targetsDigest ||
              checkpoint.promptVersion !== TARGETED_PROBLEM_BATCH_VERSION ||
              checkpoint.promptDigest !== TARGETED_PROBLEM_BATCH_PROMPT_DIGEST
            : checkpoint.targetsDigest !== targetsDigest ||
              checkpoint.batchPromptVersion !== TARGETED_PROBLEM_BATCH_VERSION ||
              checkpoint.batchPromptDigest !== TARGETED_PROBLEM_BATCH_PROMPT_DIGEST ||
              checkpoint.revisionPromptVersion !== TARGETED_PROBLEM_REVISION_VERSION ||
              checkpoint.revisionPromptDigest !== TARGETED_PROBLEM_BATCH_REVISION_PROMPT_DIGEST ||
              checkpoint.diagnosticEvidenceHash !== sha256Text(diagnosticEvidence!);
          if (commonMismatch || versionMismatch) {
            throw new Error(`기존 problem repair batch 메타데이터가 다릅니다: ${path}`);
          }
          corrected = restoredSparseQuizItems(checkpoint.items);
        } else {
          corrected = await withTargetedAi(() => extractProblemsFromFile(contextPath, "pdf", {
            sliceBase: contextFrom,
            contentPageCount: contextTo - contextFrom + 1,
            selfContained: true,
            targets: group.map((item) => ({
              page: item.original.question.page!,
              printedNumber: String(item.number),
            })),
            ...(diagnosticEvidence === null ? {} : { revisionEvidence: diagnosticEvidence }),
            reasoningEffort: IMPORT_REASONING_EFFORT,
          }));
          const common = {
            version: authorityVersion,
            entryId: entry.id,
            sourceHash: problem.sha256,
            contextFrom,
            contextTo,
            members: memberBasis,
            model: IMPORT_MODEL,
            reasoningEffort: IMPORT_REASONING_EFFORT,
            items: corrected.sort((a, b) => compareCorpusQuestionKeys(questionKey(a), questionKey(b))),
          };
          checkpoint = authorityVersion === 1 ? {
            ...common,
            sourcePage: page,
            membersDigest: targetsDigest,
            promptVersion: TARGETED_PROBLEM_BATCH_VERSION,
            promptDigest: TARGETED_PROBLEM_BATCH_PROMPT_DIGEST,
          } : {
            ...common,
            targetsDigest,
            batchPromptVersion: TARGETED_PROBLEM_BATCH_VERSION,
            batchPromptDigest: TARGETED_PROBLEM_BATCH_PROMPT_DIGEST,
            revisionPromptVersion: TARGETED_PROBLEM_REVISION_VERSION,
            revisionPromptDigest: TARGETED_PROBLEM_BATCH_REVISION_PROMPT_DIGEST,
            diagnosticEvidenceHash: sha256Text(diagnosticEvidence!),
          };
          await writeImmutableEvidence(path, checkpoint);
        }
        const expected = new Set(group.map((item) => item.key));
        const actual = corrected.map(questionKey);
        if (actual.length !== expected.size || new Set(actual).size !== expected.size || actual.some((key) => !expected.has(key))) {
          throw new Error(`${contextFrom}-${contextTo} problem repair batch exact member 집합이 다릅니다`);
        }
        const sha256 = await sha256File(path);
        if (sha256 !== canonicalEvidenceHash(checkpoint)) throw new Error("problem repair batch hash가 다릅니다");
        for (const item of corrected) {
          const key = questionKey(item);
          correctedByKey.set(key, item);
          problemEvidenceByKey.set(key, { path: relativePath, sha256, itemHash: canonicalEvidenceHash(item) });
        }
      });

      const corrected = members.map((item) => correctedByKey.get(item.key)!);
      const problemAuthorities = members.map((item) => ({ key: item.key, ...problemEvidenceByKey.get(item.key)! }));
      const classificationBasis = members.map((item, index) => ({
        key: item.key,
        problemAuthority: problemAuthorities[index],
        effectiveQuestionHash: canonicalEvidenceHash(corrected[index]),
        baseClassificationCheckpoint: item.baseQuestion.classification,
        baseClassificationHash: item.baseQuestion.classificationHash,
      }));
      const overlayDigest = canonicalEvidenceHash(classificationBasis);
      const classificationRelativePath = `classification-repair-batches/v${CLASSIFICATION_REPAIR_BATCH_VERSION}-` +
        `${String(contextFrom).padStart(4, "0")}-${String(contextTo).padStart(4, "0")}-` +
        `${overlayDigest}-${CLASSIFIER_DIGEST}.json`;
      const classificationPath = join(stateDir, classificationRelativePath);
      let classificationCheckpoint: Record<string, unknown>;
      let decisions: ClassificationDecision[];
      if (existsSync(classificationPath)) {
        classificationCheckpoint = object(JSON.parse(readFileSync(classificationPath, "utf8")), classificationRelativePath);
        if (
          classificationCheckpoint.version !== CLASSIFICATION_REPAIR_BATCH_VERSION ||
          classificationCheckpoint.entryId !== entry.id || classificationCheckpoint.sourceHash !== problem.sha256 ||
          classificationCheckpoint.contextFrom !== contextFrom || classificationCheckpoint.contextTo !== contextTo ||
          classificationCheckpoint.overlayDigest !== overlayDigest || classificationCheckpoint.classifierVersion !== CLASSIFIER_VERSION ||
          classificationCheckpoint.rulesDigest !== CLASSIFIER_DIGEST ||
          classificationCheckpoint.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
          classificationCheckpoint.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST ||
          classificationCheckpoint.model !== IMPORT_MODEL || classificationCheckpoint.reasoningEffort !== IMPORT_REASONING_EFFORT ||
          canonicalEvidenceHash(classificationCheckpoint.members) !== canonicalEvidenceHash(classificationBasis)
        ) throw new Error(`기존 classification repair batch 메타데이터가 다릅니다: ${classificationPath}`);
        decisions = parseDecisions(classificationCheckpoint.items, corrected, entry);
      } else {
        decisions = await classifyQuestions(entry, contextPath, contextFrom, contextTo, corrected);
        classificationCheckpoint = {
          version: CLASSIFICATION_REPAIR_BATCH_VERSION,
          entryId: entry.id,
          sourceHash: problem.sha256,
          contextFrom,
          contextTo,
          overlayDigest,
          classifierVersion: CLASSIFIER_VERSION,
          rulesDigest: CLASSIFIER_DIGEST,
          transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
          transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
          model: IMPORT_MODEL,
          reasoningEffort: IMPORT_REASONING_EFFORT,
          members: classificationBasis,
          items: decisions,
        };
        await writeImmutableEvidence(classificationPath, classificationCheckpoint);
      }
      const classificationSha = await sha256File(classificationPath);
      if (classificationSha !== canonicalEvidenceHash(classificationCheckpoint)) {
        throw new Error("classification repair batch hash가 다릅니다");
      }
      const decisionByKey = new Map(decisions.map((decision) => [decision.key, decision]));
      return members.map((member, index) => {
        const question = corrected[index];
        const classification = decisionByKey.get(member.key);
        if (!classification || classification.key !== member.key) {
          throw new Error(`${member.key} classification repair batch decision이 없습니다`);
        }
        const problemAuthority = problemEvidenceByKey.get(member.key)!;
        return {
          classified: { question, classification },
          evidence: {
            key: member.key,
            printedNumber: String(member.number),
            sourcePage: member.original.question.page!,
            contextFrom,
            contextTo,
            baseProblemCheckpoint: member.baseQuestion.problem,
            baseClassificationCheckpoint: member.baseQuestion.classification,
            baseSolutionCheckpoint: member.baseSolution.checkpoint,
            problemArtifact: { path: problemAuthority.path, sha256: problemAuthority.sha256 },
            problemArtifactItemHash: problemAuthority.itemHash,
            classificationArtifact: {
              path: classificationRelativePath,
              sha256: classificationSha,
              rulesDigest: CLASSIFIER_DIGEST,
              transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
              transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
            },
            classificationArtifactItemHash: canonicalEvidenceHash(classification),
            baseQuestionHash: member.baseQuestion.questionHash,
            effectiveQuestionHash: canonicalEvidenceHash(question),
            baseClassificationHash: member.baseQuestion.classificationHash,
            effectiveClassificationHash: canonicalEvidenceHash(classification),
            baseSolutionItemHash: member.baseSolution.itemHash,
            officialRawAnswerHash: sha256Text(member.solution.answer),
          },
        };
      });
    })
  );
}

type ProblemRecoveryInput = {
  key: string;
  printedNumber: string;
  sourcePage: number;
  contextFrom: number;
  contextTo: number;
  repair: ProblemRepairEvidence;
  revised: ClassifiedQuestion;
  revisionProblemArtifact: EvidencePointer & { itemHash: string };
  revisionClassificationArtifact: EvidencePointer & { itemHash: string };
};

async function recoverClassifiedQuestion(
  entry: CorpusManifestEntry,
  problem: PdfEvidence,
  stateDir: string,
  contextPath: string,
  input: ProblemRecoveryInput
): Promise<{ classified: ClassifiedQuestion; evidence: ProblemRecoveryEvidence }> {
  if (
    input.revised.classification.transcription_status === "exact" ||
    questionKey(input.revised.question) !== input.key || input.revised.question.page !== input.sourcePage ||
    canonicalEvidenceHash(input.revised.question) !== input.revisionProblemArtifact.itemHash ||
    canonicalEvidenceHash(input.revised.classification) !== input.revisionClassificationArtifact.itemHash
  ) throw new Error(`${input.key} problem recovery 입력이 failed revision과 다릅니다`);
  for (const [label, pointer] of [
    ["base problem repair", input.repair.problemArtifact],
    ["base classification repair", input.repair.classificationArtifact],
    ["problem revision", input.revisionProblemArtifact],
    ["classification revision", input.revisionClassificationArtifact],
  ] as const) {
    const path = confinedStateFile(stateDir, pointer.path, label);
    if (await sha256File(path) !== pointer.sha256) throw new Error(`${input.key} ${label} hash가 다릅니다`);
  }
  const failedClassificationEvidenceHash = sha256Text(input.revised.classification.transcription_evidence);
  const problemBasis = {
    key: input.key,
    printedNumber: input.printedNumber,
    sourcePage: input.sourcePage,
    sourceHash: problem.sha256,
    contextFrom: input.contextFrom,
    contextTo: input.contextTo,
    baseProblemRepairArtifact: input.repair.problemArtifact,
    baseProblemRepairItemHash: input.repair.problemArtifactItemHash ?? input.repair.effectiveQuestionHash,
    baseClassificationRepairArtifact: {
      path: input.repair.classificationArtifact.path,
      sha256: input.repair.classificationArtifact.sha256,
    },
    baseClassificationRepairItemHash:
      input.repair.classificationArtifactItemHash ?? input.repair.effectiveClassificationHash,
    baseProblemRevisionArtifact: {
      path: input.revisionProblemArtifact.path,
      sha256: input.revisionProblemArtifact.sha256,
    },
    baseProblemRevisionItemHash: input.revisionProblemArtifact.itemHash,
    baseClassificationRevisionArtifact: {
      path: input.revisionClassificationArtifact.path,
      sha256: input.revisionClassificationArtifact.sha256,
    },
    baseClassificationRevisionItemHash: input.revisionClassificationArtifact.itemHash,
    baseQuestionHash: canonicalEvidenceHash(input.revised.question),
    baseClassificationHash: canonicalEvidenceHash(input.revised.classification),
    failedClassificationEvidenceHash,
  };
  const basisDigest = canonicalEvidenceHash(problemBasis);
  const problemRelativePath = `problem-recoveries/v${PROBLEM_RECOVERY_VERSION}-` +
    `${String(input.sourcePage).padStart(4, "0")}-${input.printedNumber.padStart(4, "0")}-${basisDigest}.json`;
  const problemPath = join(stateDir, problemRelativePath);
  let problemCheckpoint: Record<string, unknown>;
  let recovered: QuizItemEx;
  if (existsSync(problemPath)) {
    problemCheckpoint = object(JSON.parse(readFileSync(problemPath, "utf8")), problemRelativePath);
    if (
      problemCheckpoint.version !== PROBLEM_RECOVERY_VERSION || problemCheckpoint.entryId !== entry.id ||
      problemCheckpoint.basisDigest !== basisDigest ||
      canonicalEvidenceHash(problemCheckpoint.basis) !== canonicalEvidenceHash(problemBasis) ||
      problemCheckpoint.promptVersion !== TARGETED_PROBLEM_RECOVERY_VERSION ||
      problemCheckpoint.promptDigest !== TARGETED_PROBLEM_RECOVERY_PROMPT_DIGEST ||
      problemCheckpoint.model !== IMPORT_MODEL || problemCheckpoint.reasoningEffort !== IMPORT_REASONING_EFFORT
    ) throw new Error(`기존 problem recovery 메타데이터가 다릅니다: ${problemPath}`);
    recovered = restoredQuizItems([problemCheckpoint.item])[0];
  } else {
    recovered = (await withTargetedAi(() => extractProblemsFromFile(contextPath, "pdf", {
      sliceBase: input.contextFrom,
      contentPageCount: input.contextTo - input.contextFrom + 1,
      selfContained: true,
      target: { page: input.sourcePage, printedNumber: input.printedNumber },
      recoveryEvidence: input.revised.classification.transcription_evidence,
      reasoningEffort: IMPORT_REASONING_EFFORT,
    })))[0];
    problemCheckpoint = {
      version: PROBLEM_RECOVERY_VERSION,
      entryId: entry.id,
      basisDigest,
      basis: problemBasis,
      promptVersion: TARGETED_PROBLEM_RECOVERY_VERSION,
      promptDigest: TARGETED_PROBLEM_RECOVERY_PROMPT_DIGEST,
      model: IMPORT_MODEL,
      reasoningEffort: IMPORT_REASONING_EFFORT,
      item: recovered,
    };
    await writeImmutableEvidence(problemPath, problemCheckpoint);
  }
  if (questionKey(recovered) !== input.key || recovered.page !== input.sourcePage) {
    throw new Error(`${input.key} problem recovery가 대상 문제를 정확히 한 번 반환하지 않았습니다`);
  }
  const problemSha = await sha256File(problemPath);
  if (problemSha !== canonicalEvidenceHash(problemCheckpoint)) throw new Error(`${input.key} problem recovery hash가 다릅니다`);
  const problemItemHash = canonicalEvidenceHash(recovered);
  const classificationBasis = {
    ...problemBasis,
    problemArtifact: { path: problemRelativePath, sha256: problemSha },
    problemArtifactItemHash: problemItemHash,
    effectiveQuestionHash: problemItemHash,
  };
  const classificationBasisDigest = canonicalEvidenceHash(classificationBasis);
  const classificationRelativePath = `classification-recoveries/v${CLASSIFICATION_RECOVERY_VERSION}-` +
    `${String(input.sourcePage).padStart(4, "0")}-${input.printedNumber.padStart(4, "0")}-` +
    `${classificationBasisDigest}-${CLASSIFIER_DIGEST}.json`;
  const classificationPath = join(stateDir, classificationRelativePath);
  let classificationCheckpoint: Record<string, unknown>;
  let classification: ClassificationDecision;
  if (existsSync(classificationPath)) {
    classificationCheckpoint = object(JSON.parse(readFileSync(classificationPath, "utf8")), classificationRelativePath);
    if (
      classificationCheckpoint.version !== CLASSIFICATION_RECOVERY_VERSION ||
      classificationCheckpoint.entryId !== entry.id ||
      classificationCheckpoint.basisDigest !== classificationBasisDigest ||
      canonicalEvidenceHash(classificationCheckpoint.basis) !== canonicalEvidenceHash(classificationBasis) ||
      classificationCheckpoint.classifierVersion !== CLASSIFIER_VERSION ||
      classificationCheckpoint.rulesDigest !== CLASSIFIER_DIGEST ||
      classificationCheckpoint.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
      classificationCheckpoint.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST ||
      classificationCheckpoint.recoveryPromptVersion !== TARGETED_PROBLEM_RECOVERY_VERSION ||
      classificationCheckpoint.recoveryPromptDigest !== TARGETED_PROBLEM_RECOVERY_PROMPT_DIGEST ||
      classificationCheckpoint.model !== IMPORT_MODEL ||
      classificationCheckpoint.reasoningEffort !== IMPORT_REASONING_EFFORT
    ) throw new Error(`기존 classification recovery 메타데이터가 다릅니다: ${classificationPath}`);
    classification = parseDecisions(classificationCheckpoint.items, [recovered], entry)[0];
  } else {
    classification = (await classifyQuestions(
      entry, contextPath, input.contextFrom, input.contextTo, [recovered], { targeted: true }
    ))[0];
    classificationCheckpoint = {
      version: CLASSIFICATION_RECOVERY_VERSION,
      entryId: entry.id,
      basisDigest: classificationBasisDigest,
      basis: classificationBasis,
      classifierVersion: CLASSIFIER_VERSION,
      rulesDigest: CLASSIFIER_DIGEST,
      transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
      recoveryPromptVersion: TARGETED_PROBLEM_RECOVERY_VERSION,
      recoveryPromptDigest: TARGETED_PROBLEM_RECOVERY_PROMPT_DIGEST,
      model: IMPORT_MODEL,
      reasoningEffort: IMPORT_REASONING_EFFORT,
      items: [classification],
    };
    await writeImmutableEvidence(classificationPath, classificationCheckpoint);
  }
  const classificationSha = await sha256File(classificationPath);
  if (classificationSha !== canonicalEvidenceHash(classificationCheckpoint)) {
    throw new Error(`${input.key} classification recovery hash가 다릅니다`);
  }
  if (classification.transcription_status !== "exact") {
    throw new Error(`${input.key} final source-grounded recovery도 exact가 아닙니다`);
  }
  return {
    classified: { question: recovered, classification },
    evidence: {
      key: input.key,
      printedNumber: input.printedNumber,
      sourcePage: input.sourcePage,
      sourceHash: problem.sha256,
      contextFrom: input.contextFrom,
      contextTo: input.contextTo,
      baseProblemRepairArtifact: input.repair.problemArtifact,
      baseProblemRepairItemHash: problemBasis.baseProblemRepairItemHash,
      baseClassificationRepairArtifact: {
        path: input.repair.classificationArtifact.path,
        sha256: input.repair.classificationArtifact.sha256,
      },
      baseClassificationRepairItemHash: problemBasis.baseClassificationRepairItemHash,
      baseProblemRevisionArtifact: {
        path: input.revisionProblemArtifact.path,
        sha256: input.revisionProblemArtifact.sha256,
      },
      baseProblemRevisionItemHash: input.revisionProblemArtifact.itemHash,
      baseClassificationRevisionArtifact: {
        path: input.revisionClassificationArtifact.path,
        sha256: input.revisionClassificationArtifact.sha256,
      },
      baseClassificationRevisionItemHash: input.revisionClassificationArtifact.itemHash,
      problemArtifact: { path: problemRelativePath, sha256: problemSha },
      problemArtifactItemHash: problemItemHash,
      classificationArtifact: {
        path: classificationRelativePath,
        sha256: classificationSha,
        rulesDigest: CLASSIFIER_DIGEST,
        transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
        transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
        recoveryPromptVersion: TARGETED_PROBLEM_RECOVERY_VERSION,
        recoveryPromptDigest: TARGETED_PROBLEM_RECOVERY_PROMPT_DIGEST,
      },
      classificationArtifactItemHash: canonicalEvidenceHash(classification),
      failedClassificationEvidenceHash,
      baseQuestionHash: problemBasis.baseQuestionHash,
      effectiveQuestionHash: problemItemHash,
      baseClassificationHash: problemBasis.baseClassificationHash,
      effectiveClassificationHash: canonicalEvidenceHash(classification),
    },
  };
}

async function reviseClassifiedQuestionsBatch(
  entry: CorpusManifestEntry,
  problem: PdfEvidence,
  stateDir: string,
  currents: ClassifiedQuestion[],
  repairByKey: Map<string, ProblemRepairEvidence>,
  triggers: Map<string, ProblemRevisionTrigger>
): Promise<Array<{ classified: ClassifiedQuestion; evidence: ProblemRevisionEvidence }>> {
  if (currents.length === 0) return [];
  const members = currents.map((current) => {
    const key = questionKey(current.question);
    const repair = repairByKey.get(key);
    const trigger = triggers.get(key);
    if (!repair || !trigger || repair.revision) throw new Error(`${key} batch revision authority가 없습니다`);
    if (
      canonicalEvidenceHash(current.question) !== repair.effectiveQuestionHash ||
      canonicalEvidenceHash(current.classification) !== repair.effectiveClassificationHash
    ) throw new Error(`${key} batch revision 입력이 repair evidence와 다릅니다`);
    if (
      trigger.kind === "classification"
        ? current.classification.transcription_status === "exact" ||
          trigger.evidence !== current.classification.transcription_evidence
        : current.classification.transcription_status !== "exact"
    ) throw new Error(`${key} batch revision trigger가 현재 classification과 다릅니다`);
    return {
      key,
      number: numericPrintedLocator(current.question.number)!,
      sourcePage: current.question.page!,
      current,
      repair,
      trigger,
    };
  }).sort((a, b) => compareCorpusQuestionKeys(a.key, b.key));
  const contextGroups = new Map<string, ClassifiedQuestion[]>();
  for (const member of members) {
    const contextKey = `${member.repair.contextFrom}:${member.repair.contextTo}`;
    const group = contextGroups.get(contextKey) ?? [];
    group.push(member.current);
    contextGroups.set(contextKey, group);
  }
  if (contextGroups.size > 1) {
    const groups = await Promise.all([...contextGroups.values()].map((group) =>
      reviseClassifiedQuestionsBatch(entry, problem, stateDir, group, repairByKey, triggers)
    ));
    return groups.flat();
  }
  const contextFrom = members[0].repair.contextFrom;
  const contextTo = members[0].repair.contextTo;
  for (const member of members) {
    for (const [label, pointer] of [
      ["problem repair", member.repair.problemArtifact],
      ["classification repair", member.repair.classificationArtifact],
    ] as const) {
      const path = confinedStateFile(stateDir, pointer.path, label);
      if (await sha256File(path) !== pointer.sha256) throw new Error(`${member.key} ${label} hash가 다릅니다`);
    }
    if (member.trigger.kind === "terminal") {
      const path = confinedStateFile(stateDir, member.trigger.checkpoint.path, "terminal problem fidelity");
      if (await sha256File(path) !== member.trigger.checkpoint.sha256) {
        throw new Error(`${member.key} terminal problem fidelity hash가 다릅니다`);
      }
      const checkpoint = object(JSON.parse(readFileSync(path, "utf8")), "terminal problem fidelity");
      const item = Array.isArray(checkpoint.items)
        ? checkpoint.items.find((value) => object(value, "terminal problem fidelity item").key === member.key)
        : undefined;
      if (
        checkpoint.version !== PROBLEM_TERMINAL_FIDELITY_VERSION || checkpoint.entryId !== entry.id ||
        checkpoint.sourceHash !== problem.sha256 || checkpoint.from !== member.trigger.checkpoint.from ||
        checkpoint.to !== member.trigger.checkpoint.to || checkpoint.ownedFrom !== member.trigger.checkpoint.ownedFrom ||
        checkpoint.ownedTo !== member.trigger.checkpoint.ownedTo || !item ||
        checkpoint.rulesDigest !== CLASSIFIER_DIGEST ||
        checkpoint.scopePromptDigest !== PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST ||
        canonicalEvidenceHash(item) !== member.trigger.itemHash ||
        object(item, "terminal problem fidelity item").status === "exact" ||
        object(item, "terminal problem fidelity item").evidence !== member.trigger.evidence
      ) throw new Error(`${member.key} terminal problem fidelity evidence가 다릅니다`);
    }
  }

  return withImporterPdfForAnalysis(problem, (analysisProblem) =>
    withProblemContextSlice(analysisProblem.path, contextFrom, contextTo, async (contextPath) => {
      const byPage = new Map<number, typeof members>();
      for (const member of members) {
        const group = byPage.get(member.sourcePage) ?? [];
        group.push(member);
        byPage.set(member.sourcePage, group);
      }
      const batches = [...byPage.entries()].flatMap(([page, group]) =>
        Array.from({ length: Math.ceil(group.length / 6) }, (_, index) =>
          [page, group.slice(index * 6, index * 6 + 6)] as const
        )
      );
      const revisedByKey = new Map<string, QuizItemEx>();
      const problemEvidenceByKey = new Map<string, EvidencePointer & { itemHash: string }>();
      await mapPool(batches, IMPORT_CONCURRENCY, async ([page, group]) => {
        const memberBasis = group.map((member) => ({
          key: member.key,
          printedNumber: String(member.number),
          sourcePage: member.sourcePage,
          baseProblemRepairArtifact: member.repair.problemArtifact,
          baseProblemRepairItemHash: member.repair.problemArtifactItemHash ?? member.repair.effectiveQuestionHash,
          baseClassificationRepairArtifact: {
            path: member.repair.classificationArtifact.path,
            sha256: member.repair.classificationArtifact.sha256,
          },
          baseClassificationRepairItemHash:
            member.repair.classificationArtifactItemHash ?? member.repair.effectiveClassificationHash,
          baseQuestionHash: canonicalEvidenceHash(member.current.question),
          baseClassificationHash: canonicalEvidenceHash(member.current.classification),
          trigger: member.trigger.kind === "terminal" ? {
            kind: member.trigger.kind,
            evidenceHash: sha256Text(member.trigger.evidence),
            terminalCheckpoint: member.trigger.checkpoint,
            terminalItemHash: member.trigger.itemHash,
          } : {
            kind: member.trigger.kind,
            evidenceHash: sha256Text(member.trigger.evidence),
          },
        }));
        const membersDigest = canonicalEvidenceHash(memberBasis);
        const relativePath = `problem-revision-batches/v${PROBLEM_REVISION_BATCH_VERSION}-` +
          `${String(contextFrom).padStart(4, "0")}-${String(contextTo).padStart(4, "0")}-` +
          `${String(page).padStart(4, "0")}-${membersDigest}.json`;
        const path = join(stateDir, relativePath);
        let checkpoint: Record<string, unknown>;
        let revised: QuizItemEx[];
        if (existsSync(path)) {
          checkpoint = object(JSON.parse(readFileSync(path, "utf8")), relativePath);
          if (
            checkpoint.version !== PROBLEM_REVISION_BATCH_VERSION || checkpoint.entryId !== entry.id ||
            checkpoint.sourceHash !== problem.sha256 || checkpoint.contextFrom !== contextFrom ||
            checkpoint.contextTo !== contextTo || checkpoint.sourcePage !== page ||
            checkpoint.membersDigest !== membersDigest ||
            checkpoint.batchPromptVersion !== TARGETED_PROBLEM_BATCH_VERSION ||
            checkpoint.batchPromptDigest !== TARGETED_PROBLEM_BATCH_PROMPT_DIGEST ||
            checkpoint.revisionPromptVersion !== TARGETED_PROBLEM_REVISION_VERSION ||
            checkpoint.revisionPromptDigest !== TARGETED_PROBLEM_BATCH_REVISION_PROMPT_DIGEST ||
            checkpoint.model !== IMPORT_MODEL || checkpoint.reasoningEffort !== IMPORT_REASONING_EFFORT ||
            canonicalEvidenceHash(checkpoint.members) !== canonicalEvidenceHash(memberBasis)
          ) throw new Error(`기존 problem revision batch 메타데이터가 다릅니다: ${path}`);
          revised = restoredSparseQuizItems(checkpoint.items);
        } else {
          const diagnostics = JSON.stringify(Object.fromEntries(
            group.map((member) => [member.key, member.trigger.evidence])
          ));
          revised = await withTargetedAi(() => extractProblemsFromFile(contextPath, "pdf", {
            sliceBase: contextFrom,
            contentPageCount: contextTo - contextFrom + 1,
            selfContained: true,
            targets: group.map((member) => ({
              page: member.sourcePage,
              printedNumber: String(member.number),
            })),
            revisionEvidence: diagnostics,
            reasoningEffort: IMPORT_REASONING_EFFORT,
          }));
          checkpoint = {
            version: PROBLEM_REVISION_BATCH_VERSION,
            entryId: entry.id,
            sourceHash: problem.sha256,
            contextFrom,
            contextTo,
            sourcePage: page,
            membersDigest,
            members: memberBasis,
            batchPromptVersion: TARGETED_PROBLEM_BATCH_VERSION,
            batchPromptDigest: TARGETED_PROBLEM_BATCH_PROMPT_DIGEST,
            revisionPromptVersion: TARGETED_PROBLEM_REVISION_VERSION,
            revisionPromptDigest: TARGETED_PROBLEM_BATCH_REVISION_PROMPT_DIGEST,
            model: IMPORT_MODEL,
            reasoningEffort: IMPORT_REASONING_EFFORT,
            items: revised.sort((a, b) => compareCorpusQuestionKeys(questionKey(a), questionKey(b))),
          };
          await writeImmutableEvidence(path, checkpoint);
        }
        const expected = new Set(group.map((member) => member.key));
        const actual = revised.map(questionKey);
        if (actual.length !== expected.size || new Set(actual).size !== expected.size || actual.some((key) => !expected.has(key))) {
          throw new Error(`${page}쪽 problem revision batch exact member 집합이 다릅니다`);
        }
        const sha256 = await sha256File(path);
        if (sha256 !== canonicalEvidenceHash(checkpoint)) throw new Error("problem revision batch hash가 다릅니다");
        for (const item of revised) {
          const key = questionKey(item);
          revisedByKey.set(key, item);
          problemEvidenceByKey.set(key, { path: relativePath, sha256, itemHash: canonicalEvidenceHash(item) });
        }
      });

      const revised = members.map((member) => revisedByKey.get(member.key)!);
      const classificationBasis = members.map((member, index) => ({
        key: member.key,
        problemAuthority: { key: member.key, ...problemEvidenceByKey.get(member.key)! },
        effectiveQuestionHash: canonicalEvidenceHash(revised[index]),
        baseClassificationRepairArtifact: {
          path: member.repair.classificationArtifact.path,
          sha256: member.repair.classificationArtifact.sha256,
        },
        baseClassificationRepairItemHash:
          member.repair.classificationArtifactItemHash ?? member.repair.effectiveClassificationHash,
        triggerHash: canonicalEvidenceHash(member.trigger.kind === "terminal" ? {
          kind: member.trigger.kind,
          evidenceHash: sha256Text(member.trigger.evidence),
          terminalCheckpoint: member.trigger.checkpoint,
          terminalItemHash: member.trigger.itemHash,
        } : {
          kind: member.trigger.kind,
          evidenceHash: sha256Text(member.trigger.evidence),
        }),
      }));
      const overlayDigest = canonicalEvidenceHash(classificationBasis);
      const classificationRelativePath = `classification-revision-batches/v${CLASSIFICATION_REVISION_BATCH_VERSION}-` +
        `${String(contextFrom).padStart(4, "0")}-${String(contextTo).padStart(4, "0")}-` +
        `${overlayDigest}-${CLASSIFIER_DIGEST}.json`;
      const classificationPath = join(stateDir, classificationRelativePath);
      let checkpoint: Record<string, unknown>;
      let decisions: ClassificationDecision[];
      if (existsSync(classificationPath)) {
        checkpoint = object(JSON.parse(readFileSync(classificationPath, "utf8")), classificationRelativePath);
        if (
          checkpoint.version !== CLASSIFICATION_REVISION_BATCH_VERSION || checkpoint.entryId !== entry.id ||
          checkpoint.sourceHash !== problem.sha256 || checkpoint.contextFrom !== contextFrom ||
          checkpoint.contextTo !== contextTo || checkpoint.overlayDigest !== overlayDigest ||
          checkpoint.classifierVersion !== CLASSIFIER_VERSION || checkpoint.rulesDigest !== CLASSIFIER_DIGEST ||
          checkpoint.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
          checkpoint.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST ||
          checkpoint.model !== IMPORT_MODEL || checkpoint.reasoningEffort !== IMPORT_REASONING_EFFORT ||
          canonicalEvidenceHash(checkpoint.members) !== canonicalEvidenceHash(classificationBasis)
        ) throw new Error(`기존 classification revision batch 메타데이터가 다릅니다: ${classificationPath}`);
        decisions = parseDecisions(checkpoint.items, revised, entry);
      } else {
        decisions = await classifyQuestions(entry, contextPath, contextFrom, contextTo, revised);
        checkpoint = {
          version: CLASSIFICATION_REVISION_BATCH_VERSION,
          entryId: entry.id,
          sourceHash: problem.sha256,
          contextFrom,
          contextTo,
          overlayDigest,
          classifierVersion: CLASSIFIER_VERSION,
          rulesDigest: CLASSIFIER_DIGEST,
          transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
          transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
          model: IMPORT_MODEL,
          reasoningEffort: IMPORT_REASONING_EFFORT,
          members: classificationBasis,
          items: decisions,
        };
        await writeImmutableEvidence(classificationPath, checkpoint);
      }
      const classificationSha = await sha256File(classificationPath);
      if (classificationSha !== canonicalEvidenceHash(checkpoint)) {
        throw new Error("classification revision batch hash가 다릅니다");
      }
      const decisionByKey = new Map(decisions.map((decision) => [decision.key, decision]));
      const revisionResults = members.map((member, index) => {
        const question = revised[index];
        const classification = decisionByKey.get(member.key);
        if (!classification) throw new Error(`${member.key} classification revision decision이 없습니다`);
        const problemAuthority = problemEvidenceByKey.get(member.key)!;
        const trigger = member.trigger.kind === "terminal" ? {
          kind: member.trigger.kind,
          evidenceHash: sha256Text(member.trigger.evidence),
          terminalCheckpoint: member.trigger.checkpoint,
          terminalItemHash: member.trigger.itemHash,
        } : {
          kind: member.trigger.kind,
          evidenceHash: sha256Text(member.trigger.evidence),
        };
        const evidence: ProblemRevisionEvidence = {
            baseProblemRepairArtifact: member.repair.problemArtifact,
            baseClassificationRepairArtifact: {
              path: member.repair.classificationArtifact.path,
              sha256: member.repair.classificationArtifact.sha256,
            },
            problemArtifact: { path: problemAuthority.path, sha256: problemAuthority.sha256 },
            problemArtifactItemHash: problemAuthority.itemHash,
            classificationArtifact: {
              path: classificationRelativePath,
              sha256: classificationSha,
              rulesDigest: CLASSIFIER_DIGEST,
              transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
              transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
            },
            classificationArtifactItemHash: canonicalEvidenceHash(classification),
            diagnosticEvidenceHash: sha256Text(member.trigger.evidence),
            baseQuestionHash: canonicalEvidenceHash(member.current.question),
            effectiveQuestionHash: canonicalEvidenceHash(question),
            baseClassificationHash: canonicalEvidenceHash(member.current.classification),
            effectiveClassificationHash: canonicalEvidenceHash(classification),
            trigger,
        };
        return { member, question, classification, problemAuthority, evidence };
      });
      const recoveryByKey = new Map<string, Awaited<ReturnType<typeof recoverClassifiedQuestion>>>();
      await mapPool(
        revisionResults.filter(({ classification }) => classification.transcription_status !== "exact"),
        IMPORT_CONCURRENCY,
        async ({ member, question, classification, problemAuthority }) => {
          const recovered = await recoverClassifiedQuestion(entry, problem, stateDir, contextPath, {
            key: member.key,
            printedNumber: String(member.number),
            sourcePage: member.sourcePage,
            contextFrom,
            contextTo,
            repair: member.repair,
            revised: { question, classification },
            revisionProblemArtifact: problemAuthority,
            revisionClassificationArtifact: {
              path: classificationRelativePath,
              sha256: classificationSha,
              itemHash: canonicalEvidenceHash(classification),
            },
          });
          recoveryByKey.set(member.key, recovered);
        }
      );
      return revisionResults.map(({ member, question, classification, evidence }) => {
        const recovery = recoveryByKey.get(member.key);
        return recovery ? {
          classified: recovery.classified,
          evidence: { ...evidence, recovery: recovery.evidence },
        } : {
          classified: { question, classification },
          evidence,
        };
      });
    })
  );
}

async function repairClassifiedQuestion(
  entry: CorpusManifestEntry,
  problem: PdfEvidence,
  solutionEvidence: PdfEvidence,
  stateDir: string,
  original: ClassifiedQuestion,
  officialSolution: SolutionItem
): Promise<{ classified: ClassifiedQuestion; evidence: ProblemRepairEvidence }> {
  const key = questionKey(original.question);
  const printedNumber = String(numericPrintedLocator(original.question.number));
  const sourcePage = original.question.page!;
  const baseQuestion = await baseQuestionEvidence(entry, problem, stateDir, original);
  const baseSolution = await baseSolutionEvidence(solutionEvidence, stateDir, officialSolution);
  const problemRelativePath =
    `problem-repairs/v${PROBLEM_REPAIR_VERSION}-${String(sourcePage).padStart(4, "0")}-${printedNumber.padStart(4, "0")}.json`;
  const problemPath = join(stateDir, problemRelativePath);

  return withImporterPdfForAnalysis(problem, async (analysisProblem) =>
    withProblemContextSlice(
      analysisProblem.path,
      baseQuestion.contextFrom,
      baseQuestion.contextTo,
      async (contextPath) => {
    let corrected: QuizItemEx;
    let problemCheckpoint: Record<string, unknown>;
    if (existsSync(problemPath)) {
      problemCheckpoint = object(JSON.parse(readFileSync(problemPath, "utf8")), problemRelativePath);
      if (
        problemCheckpoint.version !== PROBLEM_REPAIR_VERSION || problemCheckpoint.entryId !== entry.id ||
        problemCheckpoint.key !== key || problemCheckpoint.sourcePage !== sourcePage ||
        problemCheckpoint.printedNumber !== printedNumber || problemCheckpoint.sourceHash !== problem.sha256 ||
        problemCheckpoint.contextFrom !== baseQuestion.contextFrom ||
        problemCheckpoint.contextTo !== baseQuestion.contextTo ||
        canonicalEvidenceHash(problemCheckpoint.baseProblemCheckpoint) !== canonicalEvidenceHash(baseQuestion.problem) ||
        problemCheckpoint.baseQuestionHash !== baseQuestion.questionHash ||
        canonicalEvidenceHash(problemCheckpoint.baseSolutionCheckpoint) !== canonicalEvidenceHash(baseSolution.checkpoint) ||
        problemCheckpoint.baseSolutionItemHash !== baseSolution.itemHash ||
        problemCheckpoint.officialRawAnswerHash !== sha256Text(officialSolution.answer) ||
        problemCheckpoint.promptVersion !== TARGETED_PROBLEM_TRANSCRIPTION_VERSION ||
        problemCheckpoint.promptDigest !== TARGETED_PROBLEM_PROMPT_DIGEST ||
        problemCheckpoint.model !== IMPORT_MODEL || problemCheckpoint.reasoningEffort !== IMPORT_REASONING_EFFORT
      ) throw new Error(`기존 문제 repair 체크포인트 메타데이터가 다릅니다: ${problemPath}`);
      corrected = restoredQuizItems([problemCheckpoint.item])[0];
    } else {
      const extracted = await withTargetedAi(() => extractProblemsFromFile(contextPath, "pdf", {
        sliceBase: baseQuestion.contextFrom,
        contentPageCount: baseQuestion.contextTo - baseQuestion.contextFrom + 1,
        selfContained: true,
        target: { page: sourcePage, printedNumber },
        reasoningEffort: IMPORT_REASONING_EFFORT,
      }));
      corrected = extracted[0];
      problemCheckpoint = {
        version: PROBLEM_REPAIR_VERSION,
        entryId: entry.id,
        key,
        sourcePage,
        printedNumber,
        contextFrom: baseQuestion.contextFrom,
        contextTo: baseQuestion.contextTo,
        sourceHash: problem.sha256,
        baseProblemCheckpoint: baseQuestion.problem,
        baseQuestionHash: baseQuestion.questionHash,
        baseSolutionCheckpoint: baseSolution.checkpoint,
        baseSolutionItemHash: baseSolution.itemHash,
        officialRawAnswerHash: sha256Text(officialSolution.answer),
        promptVersion: TARGETED_PROBLEM_TRANSCRIPTION_VERSION,
        promptDigest: TARGETED_PROBLEM_PROMPT_DIGEST,
        model: IMPORT_MODEL,
        reasoningEffort: IMPORT_REASONING_EFFORT,
        item: corrected,
      };
      await writeImmutableEvidence(problemPath, problemCheckpoint);
    }
    if (
      questionKey(corrected) !== key || corrected.page !== sourcePage ||
      numericPrintedLocator(corrected.number) !== Number(printedNumber)
    ) throw new Error(`${key} 문제 repair가 원본 페이지·번호를 보존하지 않았습니다`);
    const effectiveQuestionHash = canonicalEvidenceHash(corrected);
    const problemArtifactHash = await sha256File(problemPath);
    if (problemArtifactHash !== canonicalEvidenceHash(problemCheckpoint)) {
      throw new Error(`${key} 문제 repair artifact hash가 다릅니다`);
    }

    const classificationRelativePath =
      `classification-repairs/v${CLASSIFICATION_REPAIR_VERSION}-${String(sourcePage).padStart(4, "0")}-` +
      `${printedNumber.padStart(4, "0")}-${CLASSIFIER_DIGEST}.json`;
    const classificationPath = join(stateDir, classificationRelativePath);
    let classification: ClassificationDecision;
    let classificationCheckpoint: Record<string, unknown>;
    if (existsSync(classificationPath)) {
      classificationCheckpoint = object(
        JSON.parse(readFileSync(classificationPath, "utf8")),
        classificationRelativePath
      );
      if (
        classificationCheckpoint.version !== CLASSIFICATION_REPAIR_VERSION ||
        classificationCheckpoint.entryId !== entry.id || classificationCheckpoint.key !== key ||
        classificationCheckpoint.sourceHash !== problem.sha256 ||
        classificationCheckpoint.contextFrom !== baseQuestion.contextFrom ||
        classificationCheckpoint.contextTo !== baseQuestion.contextTo ||
        canonicalEvidenceHash(classificationCheckpoint.problemArtifact) !== canonicalEvidenceHash({
          path: problemRelativePath,
          sha256: problemArtifactHash,
        }) ||
        canonicalEvidenceHash(classificationCheckpoint.baseClassificationCheckpoint) !==
          canonicalEvidenceHash(baseQuestion.classification) ||
        classificationCheckpoint.baseClassificationHash !== baseQuestion.classificationHash ||
        classificationCheckpoint.effectiveQuestionHash !== effectiveQuestionHash ||
        classificationCheckpoint.classifierVersion !== CLASSIFIER_VERSION ||
        classificationCheckpoint.rulesDigest !== CLASSIFIER_DIGEST ||
        classificationCheckpoint.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
        classificationCheckpoint.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST ||
        classificationCheckpoint.model !== IMPORT_MODEL ||
        classificationCheckpoint.reasoningEffort !== IMPORT_REASONING_EFFORT
      ) throw new Error(`기존 classification repair 체크포인트 메타데이터가 다릅니다: ${classificationPath}`);
      classification = parseDecisions([classificationCheckpoint.item], [corrected], entry)[0];
    } else {
      classification = (await classifyQuestions(
        entry,
        contextPath,
        baseQuestion.contextFrom,
        baseQuestion.contextTo,
        [corrected],
        { targeted: true }
      ))[0];
      classificationCheckpoint = {
        version: CLASSIFICATION_REPAIR_VERSION,
        entryId: entry.id,
        key,
        sourceHash: problem.sha256,
        contextFrom: baseQuestion.contextFrom,
        contextTo: baseQuestion.contextTo,
        problemArtifact: { path: problemRelativePath, sha256: problemArtifactHash },
        baseClassificationCheckpoint: baseQuestion.classification,
        baseClassificationHash: baseQuestion.classificationHash,
        effectiveQuestionHash,
        classifierVersion: CLASSIFIER_VERSION,
        rulesDigest: CLASSIFIER_DIGEST,
        transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
        transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
        model: IMPORT_MODEL,
        reasoningEffort: IMPORT_REASONING_EFFORT,
        item: classification,
      };
      await writeImmutableEvidence(classificationPath, classificationCheckpoint);
    }
    const classificationArtifactHash = await sha256File(classificationPath);
    if (classificationArtifactHash !== canonicalEvidenceHash(classificationCheckpoint)) {
      throw new Error(`${key} classification repair artifact hash가 다릅니다`);
    }
    return {
      classified: { question: corrected, classification },
      evidence: {
        key,
        printedNumber,
        sourcePage,
        contextFrom: baseQuestion.contextFrom,
        contextTo: baseQuestion.contextTo,
        baseProblemCheckpoint: baseQuestion.problem,
        baseClassificationCheckpoint: baseQuestion.classification,
        baseSolutionCheckpoint: baseSolution.checkpoint,
        problemArtifact: { path: problemRelativePath, sha256: problemArtifactHash },
        classificationArtifact: {
          path: classificationRelativePath,
          sha256: classificationArtifactHash,
          rulesDigest: CLASSIFIER_DIGEST,
          transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
          transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
        },
        baseQuestionHash: baseQuestion.questionHash,
        effectiveQuestionHash,
        baseClassificationHash: baseQuestion.classificationHash,
        effectiveClassificationHash: canonicalEvidenceHash(classification),
        baseSolutionItemHash: baseSolution.itemHash,
        officialRawAnswerHash: sha256Text(officialSolution.answer),
      },
    };
      }
    )
  );
}

async function reviseClassifiedQuestion(
  entry: CorpusManifestEntry,
  problem: PdfEvidence,
  stateDir: string,
  current: ClassifiedQuestion,
  repair: ProblemRepairEvidence
): Promise<{ classified: ClassifiedQuestion; evidence: ProblemRevisionEvidence }> {
  const key = questionKey(current.question);
  const printedNumber = String(numericPrintedLocator(current.question.number));
  const sourcePage = current.question.page!;
  if (
    key !== repair.key || printedNumber !== repair.printedNumber || sourcePage !== repair.sourcePage ||
    current.classification.transcription_status === "exact" || repair.revision ||
    canonicalEvidenceHash(current.question) !== repair.effectiveQuestionHash ||
    canonicalEvidenceHash(current.classification) !== repair.effectiveClassificationHash
  ) throw new Error(`${key} problem revision 입력이 첫 repair evidence와 다릅니다`);

  const baseProblemRepairArtifact = repair.problemArtifact;
  const baseClassificationRepairArtifact = {
    path: repair.classificationArtifact.path,
    sha256: repair.classificationArtifact.sha256,
  };
  for (const [label, pointer] of [
    ["problem repair", baseProblemRepairArtifact],
    ["classification repair", baseClassificationRepairArtifact],
  ] as const) {
    const path = confinedStateFile(stateDir, pointer.path, label);
    if (await sha256File(path) !== pointer.sha256) throw new Error(`${key} ${label} hash가 다릅니다`);
  }
  const diagnosticEvidence = current.classification.transcription_evidence;
  const diagnosticEvidenceHash = sha256Text(diagnosticEvidence);
  const baseQuestionHash = canonicalEvidenceHash(current.question);
  const baseClassificationHash = canonicalEvidenceHash(current.classification);
  const revisionBasisHash = canonicalEvidenceHash({
    baseProblemRepairArtifact,
    baseClassificationRepairArtifact,
    diagnosticEvidenceHash,
    revisionPromptDigest: TARGETED_PROBLEM_REVISION_PROMPT_DIGEST,
  });
  const problemRelativePath =
    `problem-revisions/v${PROBLEM_REVISION_VERSION}-${String(sourcePage).padStart(4, "0")}-` +
    `${printedNumber.padStart(4, "0")}-${revisionBasisHash}.json`;
  const problemPath = join(stateDir, problemRelativePath);

  return withImporterPdfForAnalysis(problem, async (analysisProblem) =>
    withProblemContextSlice(
      analysisProblem.path,
      repair.contextFrom,
      repair.contextTo,
      async (contextPath) => {
        let revised: QuizItemEx;
        let problemCheckpoint: Record<string, unknown>;
        if (existsSync(problemPath)) {
          problemCheckpoint = object(JSON.parse(readFileSync(problemPath, "utf8")), problemRelativePath);
          if (
            problemCheckpoint.version !== PROBLEM_REVISION_VERSION || problemCheckpoint.entryId !== entry.id ||
            problemCheckpoint.key !== key || problemCheckpoint.sourcePage !== sourcePage ||
            problemCheckpoint.printedNumber !== printedNumber || problemCheckpoint.sourceHash !== problem.sha256 ||
            problemCheckpoint.contextFrom !== repair.contextFrom || problemCheckpoint.contextTo !== repair.contextTo ||
            canonicalEvidenceHash(problemCheckpoint.baseProblemRepairArtifact) !==
              canonicalEvidenceHash(baseProblemRepairArtifact) ||
            canonicalEvidenceHash(problemCheckpoint.baseClassificationRepairArtifact) !==
              canonicalEvidenceHash(baseClassificationRepairArtifact) ||
            problemCheckpoint.baseQuestionHash !== baseQuestionHash ||
            problemCheckpoint.baseClassificationHash !== baseClassificationHash ||
            problemCheckpoint.diagnosticEvidence !== diagnosticEvidence ||
            problemCheckpoint.diagnosticEvidenceHash !== diagnosticEvidenceHash ||
            problemCheckpoint.promptVersion !== TARGETED_PROBLEM_REVISION_VERSION ||
            problemCheckpoint.promptDigest !== TARGETED_PROBLEM_REVISION_PROMPT_DIGEST ||
            problemCheckpoint.model !== IMPORT_MODEL ||
            problemCheckpoint.reasoningEffort !== IMPORT_REASONING_EFFORT
          ) throw new Error(`기존 problem revision 체크포인트 메타데이터가 다릅니다: ${problemPath}`);
          revised = restoredQuizItems([problemCheckpoint.item])[0];
        } else {
          revised = (await withTargetedAi(() => extractProblemsFromFile(contextPath, "pdf", {
            sliceBase: repair.contextFrom,
            contentPageCount: repair.contextTo - repair.contextFrom + 1,
            selfContained: true,
            target: { page: sourcePage, printedNumber },
            revisionEvidence: diagnosticEvidence,
            reasoningEffort: IMPORT_REASONING_EFFORT,
          })))[0];
          problemCheckpoint = {
            version: PROBLEM_REVISION_VERSION,
            entryId: entry.id,
            key,
            sourcePage,
            printedNumber,
            contextFrom: repair.contextFrom,
            contextTo: repair.contextTo,
            sourceHash: problem.sha256,
            baseProblemRepairArtifact,
            baseClassificationRepairArtifact,
            baseQuestionHash,
            baseClassificationHash,
            diagnosticEvidence,
            diagnosticEvidenceHash,
            promptVersion: TARGETED_PROBLEM_REVISION_VERSION,
            promptDigest: TARGETED_PROBLEM_REVISION_PROMPT_DIGEST,
            model: IMPORT_MODEL,
            reasoningEffort: IMPORT_REASONING_EFFORT,
            item: revised,
          };
          await writeImmutableEvidence(problemPath, problemCheckpoint);
        }
        if (
          questionKey(revised) !== key || revised.page !== sourcePage ||
          numericPrintedLocator(revised.number) !== Number(printedNumber)
        ) throw new Error(`${key} problem revision이 원본 페이지·번호를 보존하지 않았습니다`);
        const effectiveQuestionHash = canonicalEvidenceHash(revised);
        const problemArtifactHash = await sha256File(problemPath);
        if (problemArtifactHash !== canonicalEvidenceHash(problemCheckpoint)) {
          throw new Error(`${key} problem revision artifact hash가 다릅니다`);
        }

        const classificationRelativePath =
          `classification-revisions/v${CLASSIFICATION_REVISION_VERSION}-` +
          `${String(sourcePage).padStart(4, "0")}-${printedNumber.padStart(4, "0")}-` +
          `${problemArtifactHash}-${CLASSIFIER_DIGEST}.json`;
        const classificationPath = join(stateDir, classificationRelativePath);
        let classification: ClassificationDecision;
        let classificationCheckpoint: Record<string, unknown>;
        if (existsSync(classificationPath)) {
          classificationCheckpoint = object(
            JSON.parse(readFileSync(classificationPath, "utf8")),
            classificationRelativePath
          );
          if (
            classificationCheckpoint.version !== CLASSIFICATION_REVISION_VERSION ||
            classificationCheckpoint.entryId !== entry.id || classificationCheckpoint.key !== key ||
            classificationCheckpoint.sourceHash !== problem.sha256 ||
            classificationCheckpoint.contextFrom !== repair.contextFrom ||
            classificationCheckpoint.contextTo !== repair.contextTo ||
            canonicalEvidenceHash(classificationCheckpoint.problemArtifact) !== canonicalEvidenceHash({
              path: problemRelativePath,
              sha256: problemArtifactHash,
            }) ||
            canonicalEvidenceHash(classificationCheckpoint.baseProblemRepairArtifact) !==
              canonicalEvidenceHash(baseProblemRepairArtifact) ||
            canonicalEvidenceHash(classificationCheckpoint.baseClassificationRepairArtifact) !==
              canonicalEvidenceHash(baseClassificationRepairArtifact) ||
            classificationCheckpoint.baseQuestionHash !== baseQuestionHash ||
            classificationCheckpoint.baseClassificationHash !== baseClassificationHash ||
            classificationCheckpoint.diagnosticEvidenceHash !== diagnosticEvidenceHash ||
            classificationCheckpoint.effectiveQuestionHash !== effectiveQuestionHash ||
            classificationCheckpoint.classifierVersion !== CLASSIFIER_VERSION ||
            classificationCheckpoint.rulesDigest !== CLASSIFIER_DIGEST ||
            classificationCheckpoint.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
            classificationCheckpoint.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST ||
            classificationCheckpoint.revisionPromptVersion !== TARGETED_PROBLEM_REVISION_VERSION ||
            classificationCheckpoint.revisionPromptDigest !== TARGETED_PROBLEM_REVISION_PROMPT_DIGEST ||
            classificationCheckpoint.model !== IMPORT_MODEL ||
            classificationCheckpoint.reasoningEffort !== IMPORT_REASONING_EFFORT
          ) throw new Error(`기존 classification revision 체크포인트 메타데이터가 다릅니다: ${classificationPath}`);
          classification = parseDecisions([classificationCheckpoint.item], [revised], entry)[0];
        } else {
          classification = (await classifyQuestions(
            entry,
            contextPath,
            repair.contextFrom,
            repair.contextTo,
            [revised],
            { revisionEvidence: diagnosticEvidence, targeted: true }
          ))[0];
          classificationCheckpoint = {
            version: CLASSIFICATION_REVISION_VERSION,
            entryId: entry.id,
            key,
            sourceHash: problem.sha256,
            contextFrom: repair.contextFrom,
            contextTo: repair.contextTo,
            problemArtifact: { path: problemRelativePath, sha256: problemArtifactHash },
            baseProblemRepairArtifact,
            baseClassificationRepairArtifact,
            baseQuestionHash,
            baseClassificationHash,
            diagnosticEvidenceHash,
            effectiveQuestionHash,
            classifierVersion: CLASSIFIER_VERSION,
            rulesDigest: CLASSIFIER_DIGEST,
            transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
            transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
            revisionPromptVersion: TARGETED_PROBLEM_REVISION_VERSION,
            revisionPromptDigest: TARGETED_PROBLEM_REVISION_PROMPT_DIGEST,
            model: IMPORT_MODEL,
            reasoningEffort: IMPORT_REASONING_EFFORT,
            item: classification,
          };
          await writeImmutableEvidence(classificationPath, classificationCheckpoint);
        }
        const classificationArtifactHash = await sha256File(classificationPath);
        if (classificationArtifactHash !== canonicalEvidenceHash(classificationCheckpoint)) {
          throw new Error(`${key} classification revision artifact hash가 다릅니다`);
        }
        if (classification.transcription_status !== "exact") {
          throw new Error(`${key} 두 번째 source-grounded revision도 exact가 아닙니다`);
        }
        return {
          classified: { question: revised, classification },
          evidence: {
            baseProblemRepairArtifact,
            baseClassificationRepairArtifact,
            problemArtifact: { path: problemRelativePath, sha256: problemArtifactHash },
            classificationArtifact: {
              path: classificationRelativePath,
              sha256: classificationArtifactHash,
              rulesDigest: CLASSIFIER_DIGEST,
              transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
              transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
              revisionPromptVersion: TARGETED_PROBLEM_REVISION_VERSION,
              revisionPromptDigest: TARGETED_PROBLEM_REVISION_PROMPT_DIGEST,
            },
            diagnosticEvidenceHash,
            baseQuestionHash,
            effectiveQuestionHash,
            baseClassificationHash,
            effectiveClassificationHash: canonicalEvidenceHash(classification),
          },
        };
      }
    )
  );
}

export async function repairAndAuditOfficialAnswers(
  entry: CorpusManifestEntry,
  problem: PdfEvidence,
  solutionEvidence: PdfEvidence,
  stateDir: string,
  initial: ClassifiedQuestion[],
  solutions: SolutionItem[]
): Promise<AnswerAuditResult> {
  const baseByKey = new Map(initial.map((item) => [questionKey(item.question), item]));
  if (baseByKey.size !== initial.length) throw new Error("base 문제 key가 중복입니다");
  const baseSolutionsByNumber = officialSolutionsByNumber(entry, initial, solutions);
  const persistedRepairAttemptKeys = await persistedProblemRepairAttemptKeys(
    entry,
    problem,
    stateDir,
    baseByKey
  );
  let effective = [...initial];
  const repairs = new Map<string, ProblemRepairEvidence>();
  const solutionRevisionTriggers = new Map<
    string,
    Extract<SolutionRevisionTrigger, { kind: "semantic" }>
  >();
  let finalSemantic: Awaited<ReturnType<typeof semanticChoiceCheckpoint>> | null = null;
  let finalSolutionAudit: Awaited<ReturnType<typeof auditAcceptedSolutions>> | null = null;
  let finalProblemFidelity: Awaited<ReturnType<typeof auditProblemTerminalFidelity>> | null = null;

  const applyRepairs = async (
    keys: string[],
    revisionKind?: "classification" | "terminal",
    terminalTriggers?: Map<string, Extract<ProblemRevisionTrigger, { kind: "terminal" }>>
  ): Promise<Set<string>> => {
    const changedKeys = new Set<string>();
    const uniqueKeys = [...new Set(keys)];
    const initialRepairs = uniqueKeys.filter((key) => !repairs.has(key)).map((key) => {
      const original = baseByKey.get(key);
      if (!original) throw new Error(`${key} batch repair 대상이 base corpus에 없습니다`);
      return original;
    });
    const initialRepairKeys = new Set(initialRepairs.map((item) => questionKey(item.question)));
    if (initialRepairs.length > 0) {
      const batched = await repairClassifiedQuestionsBatch(
        entry,
        problem,
        solutionEvidence,
        stateDir,
        initialRepairs,
        baseSolutionsByNumber
      );
      for (const repaired of batched) {
        const index = effective.findIndex((item) => questionKey(item.question) === repaired.evidence.key);
        if (index < 0) throw new Error(`${repaired.evidence.key} batch 교체 위치가 없습니다`);
        effective[index] = repaired.classified;
        repairs.set(repaired.evidence.key, repaired.evidence);
        changedKeys.add(repaired.evidence.key);
      }
    }
    const revisionCurrents: ClassifiedQuestion[] = [];
    const revisionTriggers = new Map<string, ProblemRevisionTrigger>();
    for (const key of uniqueKeys) {
      if (initialRepairKeys.has(key)) continue;
      const index = effective.findIndex((item) => questionKey(item.question) === key);
      if (index < 0) throw new Error(`${key} effective corpus 교체 위치가 없습니다`);
      const existing = repairs.get(key);
      if (existing) {
        if (!revisionKind) continue;
        if (existing.revision) throw new Error(`${key} problem revision은 한 번만 허용됩니다`);
        const current = effective[index];
        const trigger: ProblemRevisionTrigger | undefined = revisionKind === "terminal"
          ? terminalTriggers?.get(key)
          : current.classification.transcription_status === "exact" ? undefined : {
              kind: "classification",
              evidence: current.classification.transcription_evidence,
            };
        if (!trigger) throw new Error(`${key} problem revision trigger가 없습니다`);
        revisionCurrents.push(current);
        revisionTriggers.set(key, trigger);
        continue;
      }
      // Initial repairs were handled in one page/context batch above.
    }
    if (revisionCurrents.length > 0) {
      const revised = await reviseClassifiedQuestionsBatch(
        entry,
        problem,
        stateDir,
        revisionCurrents,
        repairs,
        revisionTriggers
      );
      for (const item of revised) {
        const key = questionKey(item.classified.question);
        const index = effective.findIndex((current) => questionKey(current.question) === key);
        const existing = repairs.get(key);
        if (index < 0 || !existing || existing.revision) throw new Error(`${key} batch revision 교체 authority가 없습니다`);
        effective[index] = item.classified;
        repairs.set(key, { ...existing, revision: item.evidence });
        changedKeys.add(key);
      }
    }
    const effectiveKeys = effective.map((item) => questionKey(item.question));
    if (
      effectiveKeys.length !== initial.length || new Set(effectiveKeys).size !== effectiveKeys.length ||
      effectiveKeys.some((key) => !baseByKey.has(key))
    ) throw new Error("문제 repair가 원본 key 집합을 바꾸었습니다");
    validateProblemNumberRange(entry, effective);
    invalidateSemanticSolutionRevisionTriggers(solutionRevisionTriggers, changedKeys.size > 0);
    return changedKeys;
  };

  for (;;) {
    officialSolutionsByNumber(entry, effective, solutions);
    finalProblemFidelity = await auditProblemTerminalFidelity(entry, problem, stateDir, effective);
    const terminalByKey = new Map(finalProblemFidelity.items.map((item) => [item.key, item]));
    const repairedKeys = new Set([...persistedRepairAttemptKeys, ...repairs.keys()]);
    const authorizedScopeRejects = new Set(effective.flatMap((current) => {
      const item = terminalByKey.get(questionKey(current.question));
      return item && isAuthorizedScopeRejectedMismatch(current, item, repairedKeys) ? [item.key] : [];
    }));
    const transcriptionIssues = transcriptionRepairKeys(effective)
      .filter((key) => !authorizedScopeRejects.has(key));
    if (transcriptionIssues.length > 0) {
      const changed = await applyRepairs(transcriptionIssues, "classification");
      if (transcriptionIssues.some((key) => !changed.has(key))) {
        throw new Error(
          `문제 재전사 후에도 원본 전사를 검증할 수 없습니다: ${transcriptionIssues.join(", ")}`
        );
      }
      finalSemantic = null;
      finalSolutionAudit = null;
      finalProblemFidelity = null;
      continue;
    }
    const terminalIssues = finalProblemFidelity.items
      .filter((item) => item.status !== "exact" && !authorizedScopeRejects.has(item.key))
      .map((item) => item.key);
    if (terminalIssues.length > 0) {
      const terminalTriggers = new Map<string, Extract<ProblemRevisionTrigger, { kind: "terminal" }>>();
      for (const item of finalProblemFidelity.items.filter((candidate) => candidate.status !== "exact")) {
        const current = effective.find((candidate) => questionKey(candidate.question) === item.key);
        if (!current) throw new Error(`${item.key} terminal 문제 fidelity 대상이 없습니다`);
        const checkpoints = finalProblemFidelity.checkpoints.filter((checkpoint) =>
          current.question.page! >= checkpoint.ownedFrom && current.question.page! <= checkpoint.ownedTo
        );
        if (checkpoints.length !== 1) throw new Error(`${item.key} terminal 문제 fidelity checkpoint가 유일하지 않습니다`);
        terminalTriggers.set(item.key, {
          kind: "terminal",
          evidence: item.evidence,
          checkpoint: checkpoints[0],
          itemHash: canonicalEvidenceHash(item),
        });
      }
      const changed = await applyRepairs(terminalIssues, "terminal", terminalTriggers);
      if (terminalIssues.some((key) => !changed.has(key))) {
        throw new Error(`terminal 문제 fidelity 재검증에 실패했습니다: ${terminalIssues.join(", ")}`);
      }
      finalSemantic = null;
      finalSolutionAudit = null;
      finalProblemFidelity = null;
      continue;
    }
    assertTerminalProblemPolicy(effective, finalProblemFidelity.items, repairedKeys);
    if (effective.some(({ classification }) => classification.decision === "review")) {
      return {
        classified: effective,
        solutions,
        repairs: [...repairs.values()],
        solutionFidelityCheckpoints: [],
        solutionFidelityItems: [],
        solutionRepairs: [],
        auditPath: null,
        auditHash: null,
        effectiveCorpusHash: null,
        effectiveSolutionCorpusHash: null,
        problemTerminalFidelityCheckpoints: finalProblemFidelity.checkpoints,
        problemTerminalFidelityItems: finalProblemFidelity.items,
      };
    }
    finalSolutionAudit = await auditAcceptedSolutions(
      entry,
      solutionEvidence,
      stateDir,
      effective,
      solutions,
      solutionRevisionTriggers
    );
    const effectiveSolutionsByNumber = officialSolutionsByNumber(
      entry,
      effective,
      finalSolutionAudit.solutions
    );
    const acceptedMcq = effective.filter(
      ({ question, classification }) => classification.decision === "accept" && question.qtype === "mcq"
    );
    const resolutions = new Map<string, OfficialAnswerResolution>();
    const unresolved: string[] = [];
    for (const item of acceptedMcq) {
      const key = questionKey(item.question);
      const solution = effectiveSolutionsByNumber.get(numericPrintedLocator(item.question.number)!);
      if (!solution) throw new Error(`${key} 공식 해설이 없습니다`);
      try {
        resolutions.set(key, resolveOfficialAnswer(item.question, solution.answer));
      } catch (error) {
        if (!(error instanceof OfficialAnswerChoiceMismatchError)) throw error;
        unresolved.push(key);
      }
    }
    if (unresolved.length > 0) {
      const changed = await applyRepairs(unresolved);
      if (unresolved.some((key) => !changed.has(key))) {
        throw new Error(`문제 재전사 후에도 공식 의미값이 보기에 대응하지 않습니다: ${unresolved.join(", ")}`);
      }
      finalSemantic = null;
      finalSolutionAudit = null;
      continue;
    }

    const markerInputs = acceptedMcq.flatMap((item) => {
      const key = questionKey(item.question);
      const resolution = resolutions.get(key)!;
      if (resolution.mode !== "choice-marker") return [];
      const solution = effectiveSolutionsByNumber.get(numericPrintedLocator(item.question.number)!)!;
      if (!solution.explanation.trim()) throw new Error(`${key} 공식 해설 본문이 비어 있습니다`);
      return [{
        key,
        choices: item.question.choices!,
        detailedExplanation: semanticExplanationWithoutMarkers(solution.explanation),
      }];
    });
    finalSemantic = markerInputs.length === 0 ? null : await semanticChoiceCheckpoint(
      entry,
      problem,
      solutionEvidence,
      stateDir,
      canonicalEvidenceHash(effective),
      finalSolutionAudit.effectiveSolutionCorpusHash,
      markerInputs,
      finalSolutionAudit.repairs.some((repair) => repair.revision !== undefined)
    );
    const semanticByKey = new Map(finalSemantic?.decisions.map((item) => [item.key, item]) ?? []);
    const semanticMismatch = markerInputs.flatMap((input) => {
      const semantic = semanticByKey.get(input.key)!;
      const resolution = resolutions.get(input.key)!;
      return semantic.status !== "resolved" || semantic.choiceIndex !== resolution.choiceIndex! + 1
        ? [input.key]
        : [];
    });
    if (semanticMismatch.length > 0) {
      const solutionRepairByKey = new Map(finalSolutionAudit.repairs.map((repair) => [repair.key, repair]));
      const tentativeSolutionRevisions = new Map<
        string,
        Extract<SolutionRevisionTrigger, { kind: "semantic" }>
      >();
      const problemRepairKeys: string[] = [];
      for (const key of semanticMismatch) {
        const current = effective.find((item) => questionKey(item.question) === key)!;
        const solutionRepair = solutionRepairByKey.get(key);
        if (
          current.classification.transcription_status === "exact" && solutionRepair &&
          !solutionRepair.revision && !solutionRevisionTriggers.has(key) && finalSemantic
        ) {
          const semanticDecision = semanticByKey.get(key)!;
          tentativeSolutionRevisions.set(key, {
            kind: "semantic",
            semanticCheckpoint: {
              path: finalSemantic.path,
              sha256: finalSemantic.sha256,
              inputHash: finalSemantic.inputHash,
              effectiveCorpusHash: canonicalEvidenceHash(effective),
              effectiveSolutionCorpusHash: finalSolutionAudit.effectiveSolutionCorpusHash,
            },
            semanticDecision,
          });
        } else if (solutionRepair?.revision || solutionRevisionTriggers.has(key)) {
          throw new Error(`${key} 해설 revision 후에도 공식 marker와 상세 해설 의미가 불일치합니다`);
        } else {
          problemRepairKeys.push(key);
        }
      }
      const changedProblemKeys = problemRepairKeys.length > 0
        ? await applyRepairs(problemRepairKeys)
        : new Set<string>();
      const repairedProblem = problemRepairKeys.length > 0 &&
        problemRepairKeys.every((key) => changedProblemKeys.has(key));
      const addedSolutionRevision = commitSemanticSolutionRevisionTriggers(
        solutionRevisionTriggers,
        tentativeSolutionRevisions,
        problemRepairKeys.length
      );
      if (!addedSolutionRevision && !repairedProblem) {
        throw new Error(`문제 재전사 후에도 공식 marker와 상세 해설 의미가 불일치합니다: ${semanticMismatch.join(", ")}`);
      }
      finalSemantic = null;
      finalSolutionAudit = null;
      continue;
    }
    const fidelityByKey = new Map(finalSolutionAudit.items.map((item) => [item.key, item]));
    for (const item of effective.filter(({ classification }) => classification.decision === "accept")) {
      const key = questionKey(item.question);
      const fidelity = fidelityByKey.get(key);
      if (!fidelity) throw new Error(`${key} terminal 해설 fidelity가 없습니다`);
      if (fidelity.answerStatus === "exact") continue;
      const resolution = resolutions.get(key);
      const semantic = semanticByKey.get(key);
      if (
        fidelity.answerStatus !== "not_visible" || item.question.qtype !== "mcq" ||
        resolution?.mode !== "choice-marker" || !semantic || semantic.status !== "resolved" ||
        semantic.choiceIndex !== resolution.choiceIndex! + 1
      ) throw new Error(`${key} 보이지 않는 공식 정답에 marker semantic 증명이 없습니다`);
    }
    break;
  }

  if (!finalProblemFidelity) throw new Error("terminal 문제 fidelity 결과가 없습니다");
  const finalTerminalByKey = new Map(finalProblemFidelity.items.map((item) => [item.key, item]));
  const finalRepairedKeys = new Set(repairs.keys());
  const remainingTranscriptionIssues = transcriptionRepairKeys(effective).filter((key) => {
    const current = effective.find((item) => questionKey(item.question) === key);
    const terminal = finalTerminalByKey.get(key);
    return !current || !terminal || !isAuthorizedScopeRejectedMismatch(current, terminal, finalRepairedKeys);
  });
  if (remainingTranscriptionIssues.length > 0) {
    throw new Error(`terminal corpus에 원본 전사 미검증 문항이 있습니다: ${remainingTranscriptionIssues.join(", ")}`);
  }
  assertTerminalProblemPolicy(effective, finalProblemFidelity.items, finalRepairedKeys);
  if (!finalSolutionAudit) throw new Error("terminal 해설 fidelity 결과가 없습니다");
  const finalByNumber = officialSolutionsByNumber(entry, effective, finalSolutionAudit.solutions);
  const finalMcq = effective.filter(
    ({ question, classification }) => classification.decision === "accept" && question.qtype === "mcq"
  );
  const semanticByKey = new Map(finalSemantic?.decisions.map((item) => [item.key, item]) ?? []);
  const auditItems = finalMcq.map((item) => {
    const key = questionKey(item.question);
    const solution = finalByNumber.get(numericPrintedLocator(item.question.number)!)!;
    const resolution = resolveOfficialAnswer(item.question, solution.answer);
    const semantic = semanticByKey.get(key) ?? null;
    if (resolution.choiceIndex === null) throw new Error(`${key} 객관식 공식 정답 index가 없습니다`);
    if (resolution.mode === "choice-marker" && (
      !semantic || semantic.status !== "resolved" || semantic.choiceIndex !== resolution.choiceIndex + 1
    )) throw new Error(`${key} marker-only 공식 정답의 semantic 검증이 없습니다`);
    return {
      key,
      printedNumber: String(numericPrintedLocator(item.question.number)),
      sourcePage: item.question.page,
      officialRawAnswerHash: sha256Text(solution.answer),
      storedAnswerHash: sha256Text(resolution.storedAnswer),
      mode: resolution.mode,
      choiceIndex: resolution.choiceIndex + 1,
      semantic: semantic && {
        status: semantic.status,
        choiceIndex: semantic.choiceIndex,
        evidence: semantic.evidence,
      },
    };
  });
  const repairList = [...repairs.values()].sort((a, b) => compareCorpusQuestionKeys(a.key, b.key));
  const effectiveCorpusHash = canonicalEvidenceHash(effective);
  const accepted = effective.filter(({ classification }) => classification.decision === "accept");
  const reviews = effective.filter(({ classification }) => classification.decision === "review");
  const acceptedSolutionKeys = accepted.map((item) => questionKey(item.question)).sort(compareCorpusQuestionKeys);
  const solutionFidelityItems = [...finalSolutionAudit.items]
    .sort((a, b) => compareCorpusQuestionKeys(a.key, b.key));
  if (
    canonicalEvidenceHash(solutionFidelityItems.map((item) => item.key)) !==
      canonicalEvidenceHash(acceptedSolutionKeys)
  ) throw new Error("accepted 문제와 terminal 해설 fidelity key 집합이 다릅니다");
  const solutionFidelityCheckpoints = [...finalSolutionAudit.checkpoints]
    .sort((a, b) => a.path.localeCompare(b.path));
  const solutionRepairs = [...finalSolutionAudit.repairs]
    .sort((a, b) => compareCorpusQuestionKeys(a.key, b.key));
  const derivedAnswerKeys = solutionFidelityItems
    .filter((item) => item.answerStatus === "not_visible")
    .map((item) => item.key)
    .sort(compareCorpusQuestionKeys);
  const targetQuestionCounts = Object.fromEntries(
    TARGET_SUBJECTS.map((target) => [
      target,
      accepted.filter(({ classification }) =>
        TARGET_BY_CANONICAL[classification.canonical_subject!] === target
      ).length,
    ]).filter(([, count]) => count !== 0)
  );
  const auditBasis = {
    entryId: entry.id,
    problemHash: problem.sha256,
    solutionHash: solutionEvidence.sha256,
    classifierVersion: CLASSIFIER_VERSION,
    rulesDigest: CLASSIFIER_DIGEST,
    transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
    transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
    solutionFidelityVersion: SOLUTION_FIDELITY_VERSION,
    solutionFidelityPromptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    problemTerminalFidelityVersion: PROBLEM_TERMINAL_FIDELITY_VERSION,
    problemTerminalScopePromptDigest: PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST,
    semanticChoiceVersion: SEMANTIC_CHOICE_CHECK_VERSION,
    semanticPromptDigest: SEMANTIC_CHOICE_PROMPT_DIGEST,
    sourceQuestionCount: effective.length,
    acceptedQuestionCount: accepted.length,
    rejectedQuestionCount: effective.length - accepted.length - reviews.length,
    reviewQuestionCount: reviews.length,
    targetQuestionCounts,
    acceptedSolutionKeys,
    solutionRepairKeys: solutionRepairs.map((repair) => repair.key).sort(compareCorpusQuestionKeys),
    derivedAnswerKeys,
    acceptedMcqKeys: auditItems.map((item) => item.key).sort(compareCorpusQuestionKeys),
    effectiveCorpusHash,
    effectiveSolutionCorpusHash: finalSolutionAudit.effectiveSolutionCorpusHash,
    solutionFidelityCheckpoints,
    solutionFidelityItems,
    solutionRepairs,
    problemTerminalFidelityCheckpoints: finalProblemFidelity.checkpoints,
    problemTerminalFidelityItems: finalProblemFidelity.items,
    semanticCheckpoint: finalSemantic && {
      path: finalSemantic.path,
      sha256: finalSemantic.sha256,
      inputHash: finalSemantic.inputHash,
      effectiveSolutionCorpusHash: finalSolutionAudit.effectiveSolutionCorpusHash,
    },
    repairs: repairList,
    items: auditItems.sort((a, b) => compareCorpusQuestionKeys(a.key, b.key)),
  };
  const auditDigest = canonicalEvidenceHash(auditBasis);
  const auditRelativePath = `answer-audit/v${ANSWER_AUDIT_VERSION}-${auditDigest}.json`;
  const auditPath = join(stateDir, auditRelativePath);
  const auditCheckpoint = { version: ANSWER_AUDIT_VERSION, auditDigest, ...auditBasis };
  const auditHash = await writeImmutableEvidence(auditPath, auditCheckpoint);
  return {
    classified: effective,
    solutions: finalSolutionAudit.solutions,
    repairs: repairList,
    solutionFidelityCheckpoints,
    solutionFidelityItems,
    solutionRepairs,
    auditPath: auditRelativePath,
    auditHash,
    effectiveCorpusHash,
    effectiveSolutionCorpusHash: finalSolutionAudit.effectiveSolutionCorpusHash,
    problemTerminalFidelityCheckpoints: finalProblemFidelity.checkpoints,
    problemTerminalFidelityItems: finalProblemFidelity.items,
  };
}

function confinedStateFile(stateDir: string, relativePath: string, label: string): string {
  if (!relativePath || relativePath.includes("\0") || relativePath.startsWith("/") || relativePath.split("/").includes("..")) {
    throw new Error(`${label} 상대 경로가 유효하지 않습니다`);
  }
  const root = realpathSync(stateDir);
  const path = resolve(stateDir, relativePath);
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new Error(`${label}이 regular file이 아닙니다`);
  }
  const real = realpathSync(path);
  if (!real.startsWith(`${root}/`)) throw new Error(`${label}이 stateDir 밖을 가리킵니다`);
  return path;
}

async function assertProblemTerminalFidelityEvidence(
  stateDir: string,
  entryId: string,
  problemHash: string,
  effectiveCorpusHash: string,
  checkpoints: ProblemTerminalFidelityCheckpoint[],
  expectedItems: ProblemTerminalFidelityItem[]
): Promise<void> {
  const actualItems: ProblemTerminalFidelityItem[] = [];
  for (const pointer of checkpoints) {
    const path = confinedStateFile(stateDir, pointer.path, "problem terminal fidelity");
    if (await sha256File(path) !== pointer.sha256) throw new Error("problem terminal fidelity child hash가 다릅니다");
    const checkpoint = object(JSON.parse(readFileSync(path, "utf8")), "problem terminal fidelity");
    if (
      checkpoint.version !== PROBLEM_TERMINAL_FIDELITY_VERSION || checkpoint.entryId !== entryId ||
      checkpoint.sourceHash !== problemHash || checkpoint.effectiveCorpusHash !== effectiveCorpusHash ||
      checkpoint.from !== pointer.from || checkpoint.to !== pointer.to ||
      checkpoint.ownedFrom !== pointer.ownedFrom || checkpoint.ownedTo !== pointer.ownedTo ||
      checkpoint.inputHash !== pointer.inputHash || checkpoint.inputHash !== canonicalEvidenceHash(checkpoint.inputs) ||
      checkpoint.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
      checkpoint.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST ||
      checkpoint.rulesDigest !== CLASSIFIER_DIGEST ||
      checkpoint.scopePromptDigest !== PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST ||
      checkpoint.model !== IMPORT_MODEL || checkpoint.reasoningEffort !== IMPORT_REASONING_EFFORT ||
      !Array.isArray(checkpoint.items)
    ) throw new Error("problem terminal fidelity child metadata가 다릅니다");
    const childItems = checkpoint.items.map((item) => {
      const row = object(item, "problem terminal fidelity child item");
      if (!( ["exact", "mismatch", "unverifiable"] as unknown[]).includes(row.status) ||
          !( ["accept", "reject", "review"] as unknown[]).includes(row.scopeDecision) ||
          typeof row.scopeConfidence !== "number" || !Number.isFinite(row.scopeConfidence) ||
          row.scopeConfidence < 0 || row.scopeConfidence > 1) {
        throw new Error("problem terminal fidelity child item status 또는 scope가 유효하지 않습니다");
      }
      return {
        key: exactString(row.key, "problem terminal fidelity child item.key", 100),
        status: row.status as ProblemTerminalFidelityItem["status"],
        evidence: exactString(row.evidence, "problem terminal fidelity child item.evidence", 2000),
        scopeDecision: row.scopeDecision as ProblemTerminalFidelityItem["scopeDecision"],
        scopeConfidence: row.scopeConfidence,
        scopeEvidence: exactString(row.scopeEvidence, "problem terminal fidelity child item.scopeEvidence", 2000),
      };
    });
    const inputKeys = Array.isArray(checkpoint.inputs)
      ? checkpoint.inputs.map((input) => exactString(
          object(input, "problem terminal fidelity child input").key,
          "problem terminal fidelity child input.key",
          100
        ))
      : [];
    const childKeys = childItems.map((item) => item.key);
    if (
      new Set(inputKeys).size !== inputKeys.length || new Set(childKeys).size !== childKeys.length ||
      canonicalEvidenceHash([...inputKeys].sort(compareCorpusQuestionKeys)) !==
        canonicalEvidenceHash([...childKeys].sort(compareCorpusQuestionKeys))
    ) throw new Error("problem terminal fidelity child key coverage가 다릅니다");
    actualItems.push(...childItems);
  }
  const sortItems = (items: ProblemTerminalFidelityItem[]) =>
    [...items].sort((left, right) => compareCorpusQuestionKeys(left.key, right.key));
  if (
    new Set(actualItems.map((item) => item.key)).size !== actualItems.length ||
    canonicalEvidenceHash(sortItems(actualItems)) !== canonicalEvidenceHash(sortItems(expectedItems))
  ) throw new Error("problem terminal fidelity child coverage가 다릅니다");
}

export async function writeAnswerAttestation(
  stateDir: string,
  entryId: string,
  problemHash: string,
  solutionHash: string,
  receipt: unknown,
  answerAudit: AnswerAuditResult
): Promise<{ path: string; sha256: string }> {
  if (
    !answerAudit.auditPath || !answerAudit.auditHash || !answerAudit.effectiveCorpusHash ||
    !answerAudit.effectiveSolutionCorpusHash
  ) {
    throw new Error("answer attestation에 terminal audit 정보가 없습니다");
  }
  const receiptPath = join(stateDir, "receipt.json");
  writeImmutableJson(receiptPath, receipt);
  const receiptHash = await sha256File(receiptPath);
  if (receiptHash !== canonicalEvidenceHash(receipt)) throw new Error("receipt canonical hash가 다릅니다");
  const auditPath = confinedStateFile(stateDir, answerAudit.auditPath, "answer audit");
  if (await sha256File(auditPath) !== answerAudit.auditHash) throw new Error("answer audit hash가 다릅니다");
  const audit = object(JSON.parse(readFileSync(auditPath, "utf8")), "answer audit");
  assertTerminalProblemPolicy(
    answerAudit.classified,
    answerAudit.problemTerminalFidelityItems,
    new Set(answerAudit.repairs.map((repair) => repair.key))
  );
  if (
    audit.entryId !== entryId || audit.problemHash !== problemHash || audit.solutionHash !== solutionHash ||
    audit.classifierVersion !== CLASSIFIER_VERSION || audit.rulesDigest !== CLASSIFIER_DIGEST ||
    audit.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
    audit.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST ||
    audit.solutionFidelityVersion !== SOLUTION_FIDELITY_VERSION ||
    audit.solutionFidelityPromptDigest !== SOLUTION_FIDELITY_PROMPT_DIGEST ||
    audit.problemTerminalFidelityVersion !== PROBLEM_TERMINAL_FIDELITY_VERSION ||
    audit.problemTerminalScopePromptDigest !== PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST ||
    audit.effectiveCorpusHash !== answerAudit.effectiveCorpusHash ||
    audit.effectiveSolutionCorpusHash !== answerAudit.effectiveSolutionCorpusHash ||
    canonicalEvidenceHash(audit.repairs) !== canonicalEvidenceHash(answerAudit.repairs) ||
    canonicalEvidenceHash(audit.solutionFidelityCheckpoints) !==
      canonicalEvidenceHash(answerAudit.solutionFidelityCheckpoints) ||
    canonicalEvidenceHash(audit.solutionFidelityItems) !== canonicalEvidenceHash(answerAudit.solutionFidelityItems) ||
    canonicalEvidenceHash(audit.solutionRepairs) !== canonicalEvidenceHash(answerAudit.solutionRepairs)
    || canonicalEvidenceHash(audit.problemTerminalFidelityCheckpoints) !==
      canonicalEvidenceHash(answerAudit.problemTerminalFidelityCheckpoints)
    || canonicalEvidenceHash(audit.problemTerminalFidelityItems) !==
      canonicalEvidenceHash(answerAudit.problemTerminalFidelityItems)
  ) {
    throw new Error("answer audit terminal binding이 다릅니다");
  }
  await assertProblemTerminalFidelityEvidence(
    stateDir,
    entryId,
    problemHash,
    answerAudit.effectiveCorpusHash,
    answerAudit.problemTerminalFidelityCheckpoints,
    answerAudit.problemTerminalFidelityItems
  );
  const basis = {
    entryId,
    problemHash,
    solutionHash,
    classifierVersion: CLASSIFIER_VERSION,
    rulesDigest: CLASSIFIER_DIGEST,
    transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
    transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
    solutionFidelityVersion: SOLUTION_FIDELITY_VERSION,
    solutionFidelityPromptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    problemTerminalFidelityVersion: PROBLEM_TERMINAL_FIDELITY_VERSION,
    problemTerminalScopePromptDigest: PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST,
    receipt: { path: "receipt.json", sha256: receiptHash },
    answerAudit: {
      path: answerAudit.auditPath,
      sha256: answerAudit.auditHash,
      effectiveCorpusHash: answerAudit.effectiveCorpusHash,
      effectiveSolutionCorpusHash: answerAudit.effectiveSolutionCorpusHash,
    },
    repairs: answerAudit.repairs,
    solutionFidelityCheckpoints: answerAudit.solutionFidelityCheckpoints,
    solutionFidelityItems: answerAudit.solutionFidelityItems,
    solutionRepairs: answerAudit.solutionRepairs,
    problemTerminalFidelityCheckpoints: answerAudit.problemTerminalFidelityCheckpoints,
    problemTerminalFidelityItems: answerAudit.problemTerminalFidelityItems,
  };
  const attestationDigest = canonicalEvidenceHash(basis);
  const relativePath = `answer-attestation/v${ANSWER_ATTESTATION_VERSION}-${attestationDigest}.json`;
  const checkpoint = { version: ANSWER_ATTESTATION_VERSION, attestationDigest, ...basis };
  const sha256 = await writeImmutableEvidence(join(stateDir, relativePath), checkpoint);
  return { path: relativePath, sha256 };
}

export function matchOfficialSolutions(
  entry: Pick<CorpusManifestEntry, "subject">,
  classified: ClassifiedQuestion[],
  solutions: SolutionItem[]
): ImportedQuestion[] {
  const byNumber = officialSolutionsByNumber(entry, classified, solutions);
  return classified.flatMap(({ question, classification }) => {
    const number = numericPrintedLocator(question.number)!;
    const solution = byNumber.get(number);
    if (!solution) throw new Error(`${number}번 공식 해설이 없습니다`);
    if (classification.decision !== "accept") return [];
    if (!solution.explanation.trim()) throw new Error(`${number}번 공식 해설 본문이 비어 있습니다`);
    return [{
      ...question,
      printedNumber: String(number),
      officialAnswer: officialAnswerForStorage(question, solution.answer),
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
        problemChunkCount(problem.pageCount),
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

export function validateFilteredResult(value: unknown, entryId: string): string {
  const result = object(value, "result.json");
  if (![2, 4].includes(Number(result.version)) || result.status !== "filtered" || result.entryId !== entryId) {
    throw new Error("기존 result.json이 유효하지 않습니다");
  }
  const reason = exactString(result.reason, "result.json.reason", 100);
  if (reason === "NO_IN_SCOPE_QUESTIONS" && (
    result.version !== 4 ||
    result.rulesDigest !== CLASSIFIER_DIGEST || result.classifierVersion !== CLASSIFIER_VERSION ||
    result.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
    result.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST ||
    result.problemTerminalFidelityVersion !== PROBLEM_TERMINAL_FIDELITY_VERSION ||
    result.problemTerminalScopePromptDigest !== PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST ||
    !object(result.answerAudit, "result.json.answerAudit").path ||
    !object(result.answerAudit, "result.json.answerAudit").sha256
  )) {
    throw new Error("기존 filtered result의 classifier 또는 transcription gate가 오래되었습니다");
  }
  if (reason !== "NO_IN_SCOPE_QUESTIONS" && reason !== "SOURCE_GRADE_OUT_OF_SCOPE") {
    throw new Error("기존 result.json reason이 유효하지 않습니다");
  }
  return reason;
}

export function assertNoCommittedReceiptForFilteredResult(stateDir: string): void {
  if (existsSync(join(stateDir, "receipt.json"))) {
    throw new Error("committed receipt가 있는 entry를 filtered result로 바꿀 수 없습니다; 명시적 migration이 필요합니다");
  }
}

export function assertNoReceiptResultConflict(stateDir: string): void {
  if (existsSync(join(stateDir, "receipt.json")) && existsSync(join(stateDir, "result.json"))) {
    throw new Error("receipt.json과 result.json이 함께 존재하는 terminal conflict입니다");
  }
}

async function processEntry(
  db: Database.Database,
  dataDir: string,
  entry: CorpusManifestEntry
): Promise<EntryResult> {
  if (!SUPPORTED_SOURCES.has(entry.subject)) return { id: entry.id, status: "skipped", accepted: 0 };
  const stateDir = join(dataDir, "import-exam-corpus", entryToken(entry));
  mkdirSync(stateDir, { recursive: true });
  writeImmutableJson(join(stateDir, "entry.json"), { schemaVersion: 2, entry: entry.raw });
  const receiptPath = join(stateDir, "receipt.json");
  const resultPath = join(stateDir, "result.json");
  assertNoReceiptResultConflict(stateDir);
  if (existsSync(resultPath)) {
    assertNoCommittedReceiptForFilteredResult(stateDir);
    const rawResult = JSON.parse(readFileSync(resultPath, "utf8"));
    const reason = validateFilteredResult(rawResult, entry.id);
    if (reason === "NO_IN_SCOPE_QUESTIONS") {
      const result = object(rawResult, "result.json");
      const pointer = object(result.answerAudit, "result.json.answerAudit");
      const relativePath = exactString(pointer.path, "result.json.answerAudit.path", 500);
      const expectedHash = exactString(pointer.sha256, "result.json.answerAudit.sha256", 64);
      const path = confinedStateFile(stateDir, relativePath, "filtered answer audit");
      if (await sha256File(path) !== expectedHash) throw new Error("filtered answer audit hash가 다릅니다");
      const audit = object(JSON.parse(readFileSync(path, "utf8")), "filtered answer audit");
      const terminalItems = Array.isArray(audit.problemTerminalFidelityItems)
        ? audit.problemTerminalFidelityItems.map((item) => object(item, "filtered terminal fidelity item"))
        : [];
      const terminalKeys = terminalItems.map((item) => exactString(item.key, "filtered terminal fidelity key", 100));
      const typedTerminalItems = terminalItems.map((item) => {
        if (!( ["exact", "mismatch", "unverifiable"] as unknown[]).includes(item.status) ||
            !( ["accept", "reject", "review"] as unknown[]).includes(item.scopeDecision) ||
            typeof item.scopeConfidence !== "number" || !Number.isFinite(item.scopeConfidence) ||
            item.scopeConfidence < 0 || item.scopeConfidence > 1) {
          throw new Error("filtered terminal fidelity status 또는 scope가 유효하지 않습니다");
        }
        return {
          key: exactString(item.key, "filtered terminal fidelity key", 100),
          status: item.status as ProblemTerminalFidelityItem["status"],
          evidence: exactString(item.evidence, "filtered terminal fidelity evidence", 2000),
          scopeDecision: item.scopeDecision as ProblemTerminalFidelityItem["scopeDecision"],
          scopeConfidence: item.scopeConfidence,
          scopeEvidence: exactString(item.scopeEvidence, "filtered terminal fidelity scope evidence", 2000),
        };
      });
      const terminalCheckpoints = Array.isArray(audit.problemTerminalFidelityCheckpoints)
        ? audit.problemTerminalFidelityCheckpoints.map((value) => {
            const pointer = object(value, "filtered terminal fidelity checkpoint");
            return {
              path: exactString(pointer.path, "filtered terminal fidelity checkpoint.path", 500),
              sha256: exactString(pointer.sha256, "filtered terminal fidelity checkpoint.sha256", 64),
              from: Number(pointer.from),
              to: Number(pointer.to),
              ownedFrom: Number(pointer.ownedFrom),
              ownedTo: Number(pointer.ownedTo),
              inputHash: exactString(pointer.inputHash, "filtered terminal fidelity checkpoint.inputHash", 64),
            };
          })
        : [];
      const { version: _version, auditDigest, ...auditBasis } = audit;
      if (
        audit.version !== ANSWER_AUDIT_VERSION || audit.entryId !== entry.id ||
        audit.classifierVersion !== CLASSIFIER_VERSION || audit.rulesDigest !== CLASSIFIER_DIGEST ||
        audit.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
        audit.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST ||
        audit.problemTerminalFidelityVersion !== PROBLEM_TERMINAL_FIDELITY_VERSION ||
        audit.problemTerminalScopePromptDigest !== PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST ||
        audit.effectiveCorpusHash !== result.effectiveCorpusHash ||
        audit.sourceQuestionCount !== result.sourceQuestionCount || audit.acceptedQuestionCount !== 0 ||
        audit.rejectedQuestionCount !== result.rejectedQuestionCount || audit.reviewQuestionCount !== 0 ||
        terminalItems.length !== result.sourceQuestionCount ||
        new Set(terminalKeys).size !== terminalKeys.length || typedTerminalItems.some((item) =>
          item.status !== "exact" && !(
            item.status === "mismatch" && item.scopeDecision === "reject" && item.scopeConfidence >= 0.9
          )
        ) ||
        typeof auditDigest !== "string" || canonicalEvidenceHash(auditBasis) !== auditDigest ||
        relativePath !== `answer-audit/v${ANSWER_AUDIT_VERSION}-${auditDigest}.json`
      ) throw new Error("filtered answer audit terminal binding이 다릅니다");
      await assertProblemTerminalFidelityEvidence(
        stateDir,
        entry.id,
        exactString(audit.problemHash, "filtered answer audit.problemHash", 64),
        exactString(audit.effectiveCorpusHash, "filtered answer audit.effectiveCorpusHash", 64),
        terminalCheckpoints,
        typedTerminalItems
      );
    }
    return { id: entry.id, status: "filtered", accepted: 0, message: reason };
  }
  if (["통합과학", "통합사회"].includes(entry.subject) && ![1, 2].includes(entry.grade ?? 0)) {
    assertNoCommittedReceiptForFilteredResult(stateDir);
    writeImmutableJson(resultPath, {
      version: 2,
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
    version: 2,
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

  let classified = await extractAndClassifyProblems(entry, problem, stateDir);
  validateProblemNumberRange(entry, classified);
  const solutions = await extractSolutions(solution, stateDir);
  const answerAudit = await repairAndAuditOfficialAnswers(
    entry,
    problem,
    solution,
    stateDir,
    classified,
    solutions
  );
  classified = answerAudit.classified;
  validateProblemNumberRange(entry, classified);
  const repairedReviews = classified.filter(({ classification }) => classification.decision === "review");
  if (repairedReviews.length > 0) {
    return { id: entry.id, status: "review", accepted: 0, message: `${repairedReviews.length}문항 수동 검토 필요` };
  }
  const repairedAcceptedCount = classified.filter(
    ({ classification }) => classification.decision === "accept"
  ).length;
  if (repairedAcceptedCount === 0) {
    assertNoCommittedReceiptForFilteredResult(stateDir);
    if (!answerAudit.auditPath || !answerAudit.auditHash || !answerAudit.effectiveCorpusHash) {
      throw new Error("filtered corpus의 v4 terminal audit이 없습니다");
    }
    writeImmutableJson(resultPath, {
      version: 4,
      status: "filtered",
      entryId: entry.id,
      reason: "NO_IN_SCOPE_QUESTIONS",
      rulesDigest: CLASSIFIER_DIGEST,
      classifierVersion: CLASSIFIER_VERSION,
      transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
      problemTerminalFidelityVersion: PROBLEM_TERMINAL_FIDELITY_VERSION,
      problemTerminalScopePromptDigest: PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST,
      sourceQuestionCount: classified.length,
      acceptedQuestionCount: 0,
      rejectedQuestionCount: classified.length,
      reviewQuestionCount: 0,
      effectiveCorpusHash: answerAudit.effectiveCorpusHash,
      answerAudit: { path: answerAudit.auditPath, sha256: answerAudit.auditHash },
    });
    return { id: entry.id, status: "filtered", accepted: 0 };
  }
  if (!answerAudit.auditPath || !answerAudit.auditHash) {
    throw new Error("accepted corpus의 terminal answer audit이 없습니다");
  }
  const imported = matchOfficialSolutions(entry, classified, answerAudit.solutions);
  const receipt = {
    version: 2,
    status: "committed",
    entryId: entry.id,
    examTitle: entry.examTitle,
    rawTitle: entry.rawTitle,
    bookTitle: examBookTitle(entry),
    sourceRecordYear: entry.sourceRecordYear,
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
    problemChunking: {
      pages: PROBLEM_SLICE_PAGES,
      stride: PROBLEM_SLICE_STRIDE,
      overlap: PROBLEM_SLICE_PAGES - PROBLEM_SLICE_STRIDE,
    },
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
  await writeAnswerAttestation(
    stateDir,
    entry.id,
    problem.sha256,
    solution.sha256,
    receipt,
    answerAudit
  );
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
  console.log(
    `AI ${IMPORT_MODEL} / ${IMPORT_REASONING_EFFORT}, 동시 작업 ${IMPORT_CONCURRENCY}개` +
    ` (full-context ${FULL_CONTEXT_CONCURRENCY}개)`
  );
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
