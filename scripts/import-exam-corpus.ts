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
  TARGETED_PROBLEM_CROP_ADJUDICATION_RULES,
  TARGETED_PROBLEM_CROP_ADJUDICATION_VERSION,
  TARGETED_PROBLEM_CROP_ADJUDICATION_EVIDENCE_PREFIX,
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
export const IMPORT_CONCURRENCY = 10;
export function parseImporterFullContextConcurrency(value: string | undefined): number {
  const parsed = value?.trim() ? Number(value) : 5;
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
export const PROBLEM_TERMINAL_RECOVERY_VERSION = 2;
export const CLASSIFICATION_TERMINAL_RECOVERY_VERSION = 2;
export const PROBLEM_CROP_ADJUDICATION_VERSION = 1;
export const CLASSIFICATION_CROP_ADJUDICATION_VERSION = 1;
export const PROBLEM_SCOPE_ADJUDICATION_VERSION = 1;
export const PROBLEM_REPAIR_SCOPE_ADJUDICATION_VERSION = 1;
export const PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_VERSION = 1;
export const PROBLEM_REVISION_SCOPE_ADJUDICATION_VERSION = 1;
export const PROBLEM_MANUAL_ADJUDICATION_VERSION = 1;
export const CLASSIFICATION_MANUAL_ADJUDICATION_VERSION = 1;
export const SOLUTION_FIDELITY_VERSION = 1;
export const SOLUTION_FIDELITY_SLICE_PAGES = 22;
export const SOLUTION_FIDELITY_SLICE_STRIDE = 18;
export const SOLUTION_REPAIR_VERSION = 1;
export const SOLUTION_REPAIR_FIDELITY_VERSION = 1;
export const PERSISTED_SOLUTION_REPAIR_SEED_VERSION = 1;
export const SOLUTION_REVISION_VERSION = 1;
export const SOLUTION_REVISION_FIDELITY_VERSION = 1;
export const PERSISTED_SOLUTION_REVISION_TRIGGER_VERSION = 1;
export const SOLUTION_PROMPT_UPGRADE_VERSION = 1;
export const SOLUTION_PROMPT_UPGRADE_FIDELITY_VERSION = 1;
export const SOLUTION_REVISION_FIDELITY_ADJUDICATION_VERSION = 1;
export const LEGACY_TARGETED_SOLUTION_REVISION_VERSION = 1;
export const LEGACY_TARGETED_SOLUTION_REVISION_PROMPT_DIGEST =
  "d357d4bf715cea8b712b02546272f353c31eb94accfaefa960da616f2abd7884";
export const PROBLEM_TERMINAL_FIDELITY_VERSION = 2;
export const SEMANTIC_CHOICE_CHECK_VERSION = 5;
export const ANSWER_AUDIT_VERSION = 5;
export const ANSWER_ATTESTATION_VERSION = 5;
export const EXISTING_CORPUS_MIGRATION_VERSION = 1;

type ExistingCorpusMigrationSpec = {
  entryId: string;
  entryToken: string;
  oldReceiptSha256: string;
  receiptCoreSha256: string;
  beforeProjectionHash: string;
  afterProjectionHash: string;
  auditPath: string;
  auditSha256: string;
  effectiveCorpusHash: string;
  effectiveSolutionCorpusHash: string;
  problemHash: string;
  solutionHash: string;
  bookIds: number[];
  fileIds: number[];
  questionIds: number[];
  bookItemIds: number[];
  newKeys: string[];
  newQuestions: Array<{
    key: string;
    targetSubject: TargetSubject;
    qtype: QuizItemEx["qtype"];
    difficulty: QuizItemEx["difficulty"];
    question: string;
    answer: string;
    solutionPage: number;
  }>;
};

export const EXISTING_CORPUS_MIGRATION_ALLOWLIST: readonly ExistingCorpusMigrationSpec[] = [{
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
    targetSubject: "수학 - 수학Ⅱ·미적분Ⅰ",
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
}] as const;

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

const PROBLEM_SCOPE_ADJUDICATION_SCHEMA: AIJsonSchema = {
  ...CLASSIFICATION_SCHEMA,
  name: "studywork_exam_corpus_scope_adjudication",
  description: "Allowlisted source-and-solution grounded curriculum adjudication for one exact problem.",
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
  scopeAdjudication?: ProblemScopeAdjudicationEvidence;
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
  scopeAdjudication?: ProblemScopeAdjudicationEvidence;
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
  failedClassificationEvidenceHash?: string;
  trigger?: {
    kind: "terminal";
    evidenceHash: string;
    terminalCheckpoint: ProblemTerminalFidelityCheckpoint;
    terminalItemHash: string;
    terminalItem: ProblemTerminalFidelityItem;
    preRecoveryEffectiveCorpusHash: string;
  };
  baseQuestionHash: string;
  effectiveQuestionHash: string;
  baseClassificationHash: string;
  effectiveClassificationHash: string;
  adjudication?: ProblemCropAdjudicationEvidence;
  scopeAdjudication?: ProblemScopeAdjudicationEvidence;
  manualAdjudication?: ProblemManualAdjudicationEvidence;
};

export type ProblemManualAdjudicationEvidence = {
  allowlistId: string;
  key: string;
  printedNumber: string;
  sourcePage: number;
  sourcePages: number[];
  sourceHash: string;
  parentRecoveryEvidenceHash: string;
  parentCropAdjudicationHash?: string;
  failedQuestionHash: string;
  failedClassificationHash: string;
  failedClassificationEvidenceHash: string;
  correctionSpecHash: string;
  cropEvidenceArtifact: EvidencePointer;
  cropEvidencePdf: EvidencePointer;
  cropViews: ProblemCropAdjudicationEvidence["cropViews"];
  problemArtifact: EvidencePointer & {
    correctionVersion: number;
    correctionDigest: string;
  };
  problemArtifactItemHash: string;
  classificationArtifact: EvidencePointer & {
    rulesDigest: string;
    transcriptionGateVersion: number;
    transcriptionPromptDigest: string;
    adjudicationVersion: number;
    adjudicationPromptDigest: string;
  };
  classificationArtifactItemHash: string;
  baseQuestionHash: string;
  effectiveQuestionHash: string;
  baseClassificationHash: string;
  effectiveClassificationHash: string;
};

export type ProblemScopeAdjudicationEvidence = {
  allowlistId: string;
  key: string;
  printedNumber: string;
  sourcePage: number;
  sourceHash: string;
  solutionSourceHash: string;
  problemContextFrom: number;
  problemContextTo: number;
  solutionContextFrom: number;
  solutionContextTo: number;
  baseSolutionCheckpoint: EvidencePointer;
  baseSolutionItemHash: string;
  parentRecoveryEvidenceHash?: string;
  parentRepairEvidenceHash?: string;
  parentRevisionEvidenceHash?: string;
  trigger: {
    terminalCheckpoint: ProblemTerminalFidelityCheckpoint;
    terminalItemHash: string;
    terminalItem: ProblemTerminalFidelityItem;
    evidenceHash: string;
    scopeEvidenceHash: string;
    preAdjudicationEffectiveCorpusHash: string;
  };
  classificationArtifact: EvidencePointer & {
    rulesDigest: string;
    transcriptionGateVersion: number;
    transcriptionPromptDigest: string;
    adjudicationPromptVersion: number;
    adjudicationPromptDigest: string;
  };
  classificationArtifactItemHash: string;
  baseQuestionHash: string;
  effectiveQuestionHash: string;
  baseClassificationHash: string;
  effectiveClassificationHash: string;
};

export type ProblemCropAdjudicationEvidence = {
  allowlistId: string;
  key: string;
  printedNumber: string;
  sourcePage: number;
  sourcePages: number[];
  sourceHash: string;
  parentRecoveryEvidenceHash: string;
  cropEvidenceArtifact: EvidencePointer;
  cropEvidencePdf: EvidencePointer;
  cropViews: Array<{
    sourcePage: number;
    label: string;
    rect: [number, number, number, number];
    pixelWidth: number;
    pixelHeight: number;
    pixelSha256: string;
    artifact: EvidencePointer;
  }>;
  problemArtifact: EvidencePointer & {
    promptVersion: number;
    promptDigest: string;
  };
  problemArtifactItemHash: string;
  classificationArtifact: EvidencePointer & {
    rulesDigest: string;
    transcriptionGateVersion: number;
    transcriptionPromptDigest: string;
    adjudicationPromptVersion: number;
    adjudicationPromptDigest: string;
    classificationPromptDigest: string;
  };
  classificationArtifactItemHash: string;
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
      item: ProblemTerminalFidelityItem;
      effectiveCorpusHash: string;
    };

type ProblemRecoveryTrigger =
  | { kind: "classification"; evidence: string }
  | Extract<ProblemRevisionTrigger, { kind: "terminal" }>;

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
    kind: "fidelity" | "semantic" | "persisted" | "prompt-upgrade";
    fidelityDecisionHash: string;
    semanticCheckpoint?: EvidencePointer & {
      inputHash: string;
      effectiveCorpusHash: string;
      effectiveSolutionCorpusHash: string;
    };
    semanticDecisionHash?: string;
    persistedTriggerVersion?: number;
    predecessor?: PersistedSolutionRevisionAuthority;
    promptUpgradeVersion?: number;
    legacyPredecessor?: LegacySolutionRevisionPredecessor;
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
  fidelityAdjudication?: SolutionRevisionFidelityAdjudicationEvidence;
};

export type SolutionRevisionFidelityAdjudicationEvidence = {
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
  cropViews: ProblemCropAdjudicationEvidence["cropViews"];
  adjudicationArtifact: EvidencePointer & {
    version: number;
    promptDigest: string;
  };
  adjudicationDecisionHash: string;
};

export type LegacySolutionRevisionPredecessor = {
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

export type PersistedSolutionRevisionAuthority = {
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

type PersistedSolutionFirstAuthority = {
  generationId: string;
  key: string;
  effectiveProblemCorpusHash: string;
  baseFidelityCheckpoint: EvidencePointer;
  repairArtifact: EvidencePointer;
  repairFidelityArtifact: EvidencePointer;
  repairedItem: SolutionItem;
  repairedItemHash: string;
  seededFromGenerationId?: string;
  persistedSeed?: Record<string, unknown>;
  revision?: PersistedSolutionRevisionAuthority;
  revisionTrigger?: SolutionRevisionTrigger;
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
  }
  | { kind: "persisted"; authority: PersistedSolutionRevisionAuthority }
  | { kind: "prompt-upgrade"; predecessor: LegacySolutionRevisionPredecessor };

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

function exactHash(value: unknown, label: string): string {
  const hash = exactString(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error(`${label}: SHA-256이 아닙니다`);
  return hash;
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

export const TARGETED_PROBLEM_PROMPT_DIGEST = sha256Text(
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
export const TARGETED_PROBLEM_CROP_ADJUDICATION_PROMPT_DIGEST = sha256Text(
  `${TARGETED_PROBLEM_CROP_ADJUDICATION_VERSION}\n${TARGETED_PROBLEM_CROP_ADJUDICATION_RULES}\n` +
  `${TARGETED_PROBLEM_CROP_ADJUDICATION_EVIDENCE_PREFIX}\n` +
  `${TARGETED_PROBLEM_TRANSCRIPTION_VERSION}\n${TARGETED_PROBLEM_TRANSCRIPTION_RULES}\n${QUIZ_EXTRACT_SPEC}`
);
const PROBLEM_CROP_ADJUDICATION_CLASSIFICATION_RULES =
  `The attached PDF is an immutable 300-DPI evidence bundle. Its pages are labeled duplicate full-page or bounded ` +
  `crop views of the stated official source pages, not additional source pages. Compare the entire supplied ` +
  `self-contained question against every relevant view and classify scope from those pixels.`;
export const PROBLEM_CROP_ADJUDICATION_CLASSIFICATION_PROMPT_DIGEST = sha256Text(
  `${CLASSIFIER_VERSION}\n${TRANSCRIPTION_GATE_VERSION}\n${TRANSCRIPTION_GATE_RULES}\n` +
  `${PROBLEM_CROP_ADJUDICATION_CLASSIFICATION_RULES}\n${CURRICULUM_RULES}`
);

export const PROBLEM_SCOPE_ADJUDICATION_RULES = `
The attached evidence PDF contains one bounded official problem context followed by the owning bounded official
solution context. Previous classifier and terminal-audit labels are intentionally hidden. Independently identify every
concept that the official solution necessarily uses, then apply the supplied curriculum rules to the source-pixel
problem. Do not accept merely because the official source names an in-scope topic: one necessary excluded dependency
rejects the whole question. Also compare the supplied final transcription with the official problem pixels and return
transcription_status exact only when it is faithful. Keep the supplied key exactly once.
`.trim();
export const PROBLEM_SCOPE_ADJUDICATION_PROMPT_DIGEST = sha256Text(
  `${PROBLEM_SCOPE_ADJUDICATION_VERSION}\n${PROBLEM_SCOPE_ADJUDICATION_RULES}\n` +
  `${TRANSCRIPTION_GATE_VERSION}\n${TRANSCRIPTION_GATE_RULES}\n${CURRICULUM_RULES}`
);
export const PROBLEM_REPAIR_SCOPE_ADJUDICATION_PROMPT_DIGEST = sha256Text(
  `${PROBLEM_REPAIR_SCOPE_ADJUDICATION_VERSION}\n${PROBLEM_SCOPE_ADJUDICATION_RULES}\n` +
  `${TRANSCRIPTION_GATE_VERSION}\n${TRANSCRIPTION_GATE_RULES}\n${CURRICULUM_RULES}`
);
export const PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_RULES = `
${PROBLEM_SCOPE_ADJUDICATION_RULES}
Distinguish notation that states the standard definition of an in-scope concept from an independently required
excluded technique. Ground that distinction in the owning official solution rather than the notation alone.
For an accept result, include the exact reason code ALLOWLISTED_POSITIVE_SCOPE_AUTHORITY.
`.trim();
export const PROBLEM_REPAIR_POSITIVE_SCOPE_AUTHORITY_REASON_CODE =
  "ALLOWLISTED_POSITIVE_SCOPE_AUTHORITY";
export const PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_PROMPT_DIGEST = sha256Text(
  `${PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_VERSION}\n` +
  `${PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_RULES}\n` +
  `${TRANSCRIPTION_GATE_VERSION}\n${TRANSCRIPTION_GATE_RULES}\n${CURRICULUM_RULES}`
);
export const PROBLEM_REVISION_SCOPE_ADJUDICATION_PROMPT_DIGEST = sha256Text(
  `${PROBLEM_REVISION_SCOPE_ADJUDICATION_VERSION}\n${PROBLEM_SCOPE_ADJUDICATION_RULES}\n` +
  `${TRANSCRIPTION_GATE_VERSION}\n${TRANSCRIPTION_GATE_RULES}\n${CURRICULUM_RULES}`
);

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

export const PROBLEM_SCOPE_ADJUDICATION_ALLOWLIST: readonly ProblemScopeAdjudicationSpec[] = [{
  allowlistId: "ebsi-5577055-q11-scope-v1",
  entryId: "ebsi:5577055",
  key: "4:11",
  sourcePage: 4,
  sourceHash: "b4381bc3b831323375b2c4a25319d308185c930be5d2e3b07dfc28e7646a5fde",
  solutionSourceHash: "1753328f4b4360a9d81312d0d1610c7a11063bbefeeb1e1fd286d54c601ec5fa",
}] as const;

export const PROBLEM_REPAIR_SCOPE_ADJUDICATION_ALLOWLIST: readonly ProblemScopeAdjudicationSpec[] = [{
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

export const PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_ALLOWLIST:
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

export const PROBLEM_REVISION_SCOPE_ADJUDICATION_ALLOWLIST: readonly ProblemScopeAdjudicationSpec[] = [{
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

type ProblemCropAdjudicationSpec = {
  allowlistId: string;
  entryId: string;
  key: string;
  sourcePage: number;
  sourceHash: string;
  views: Array<{
    sourcePage: number;
    label: string;
    rect: [number, number, number, number];
  }>;
  requiredTokens: string[];
};

export const PROBLEM_CROP_ADJUDICATION_ALLOWLIST: readonly ProblemCropAdjudicationSpec[] = [
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

export const PROBLEM_MANUAL_ADJUDICATION_RULES = `
The attached PDF is immutable source-pixel evidence for one exact allowlisted problem. The supplied transcription was
produced by deterministic, count-checked literal replacements or a narrowly bounded accessibility surrogate for a
non-text diagram. Independently compare the complete corrected item with every relevant evidence view. Visible Korean,
labels, formulas, punctuation, choices, and shared passages remain literal. A diagram surrogate is exact only when it
preserves every glyph's identity, order, orientation, count, premise/conclusion role, open/filled state, and coordinates.
Previous classification and mismatch labels are intentionally hidden. Classify curriculum scope from source pixels and
return transcription_status exact only when the corrected item is fully faithful.
`.trim();
export const PROBLEM_MANUAL_ADJUDICATION_PROMPT_DIGEST = sha256Text(
  `${PROBLEM_MANUAL_ADJUDICATION_VERSION}\n${PROBLEM_MANUAL_ADJUDICATION_RULES}\n` +
  `${TRANSCRIPTION_GATE_VERSION}\n${TRANSCRIPTION_GATE_RULES}\n${CURRICULUM_RULES}`
);
export const PROBLEM_MANUAL_CORRECTION_DIGEST = sha256Text(
  `${PROBLEM_MANUAL_ADJUDICATION_VERSION}\ncount-checked-literal-replacements+bounded-glyph-surrogate`
);

type ProblemManualReplacement = {
  field: "question" | "figure_description";
  from: string;
  to: string;
  count: number;
};

type ProblemManualAdjudicationSpec = ProblemCropAdjudicationSpec & {
  parentKind: "recovery" | "crop";
  dpi?: number;
  failedQuestionHash: string;
  failedClassificationHash: string;
  failedClassificationEvidenceHash: string;
  replacements: ProblemManualReplacement[];
  figure?: boolean;
  figureDescription?: string;
  expectedDecision?: "accept" | "reject";
  expectedCanonicalSubject?: CanonicalSubject;
};

const Q30_FIGURE_DESCRIPTION =
  "공식 11쪽 오른쪽의 (4)와 (4′) 논증 도식이 좌우로 배치되어 있다. 왼쪽 (4)는 첫째 전제 " +
  "‘만약 p이면 q이다.’와 둘째 전제 ‘p이다.’ 아래에 수평 가로선 하나가 있고, 그 아래 결론 " +
  "‘그러므로 q이다.’가 놓인다. 오른쪽 (4′)는 첫째 전제 ‘p → q’와 둘째 전제 ‘p’ 아래에 수평 " +
  "가로선 하나가 있고, 그 아래 결론 ‘q’가 놓인다. 두 도식 사이에는 왼쪽에서 오른쪽을 가리키는 " +
  "‘⇒’가 하나 있다. 가로선은 총 2개이며 각각 두 전제와 한 결론을 구분한다.";

const Q34_FIGURE_DESCRIPTION =
  "공식 12쪽의 (가)에는 왼쪽 세로 묶음 괄호가 3개 있다. 각 괄호는 세로선 하나와 오른쪽을 향한 " +
  "위·아래 가로 캡 2개로 이루어져 가로 캡은 모두 6개이다. 첫째 [A] 괄호는 ‘마님, 나으리께서 " +
  "드십니다.’부터 ‘치수는 어머니의 흩어진 모습을 본 일이 없었다.’까지를 묶는다. 둘째 ㉮ 괄호는 " +
  "‘앞으로 혼자 있을 수 없는 일이며’부터 ‘신랑감이 필요할 뿐이지요.’까지의 혼사 대화를 묶는다. " +
  "셋째 [B] 괄호는 ‘이듬해 이월달 꽃바람이’부터 ‘불렀을 때 어머니의 눈은 불꽃이 튀는 듯 " +
  "험악했다.’까지의 회상 장면을 묶는다. [A], ㉮, [B] 표지는 각 괄호의 왼쪽에 놓인다.";

const Q8_FIGURE_DESCRIPTION =
  "좌표평면에 함수 $y=f(x)$의 그래프가 그려져 있다. $x$축은 오른쪽, $y$축은 위쪽을 향하는 " +
  "화살표이며 원점 $O=(0,0)$에는 뚫린 점이 표시되어 있다. 왼쪽 위에서 뚫린 원점 $O$까지 " +
  "내려오는 직선 조각과, 뚫린 원점 $O$에서 $(1,2)$의 뚫린 점까지 올라가는 직선 조각이 있다. " +
  "$(1,3)$에는 채운 점이 있다. $y=3$, $y=2$, $y=-3$에서 각각 $y$축과 $x=1$ 사이에 수평 " +
  "점선이 그어져 있고, $x=1$에는 $y=-3$부터 $y=3$까지 수직 점선이 그어져 있다. $x$축에는 " +
  "$1$과 $3$, $y$축에는 $3$, $2$, $-2$, $-3$이 표시되어 있다. $(0,-2)$에는 채운 점이 있고, " +
  "$(1,-3)$에는 뚫린 점이 있다. $(1,-3)$에서 오른쪽 위로 올라가는 직선 조각은 $x$축의 " +
  "$x=3$을 지나며, 그 옆에 $y=f(x)$가 표시되어 있다.";

const Q18_FIGURE_DESCRIPTION =
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

export const PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST: readonly ProblemManualAdjudicationSpec[] = [
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
    figureDescription: Q34_FIGURE_DESCRIPTION,
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
    figureDescription: Q30_FIGURE_DESCRIPTION,
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
    figureDescription: Q8_FIGURE_DESCRIPTION,
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
        field: "question",
        from: "호 $N_1L_1$",
        to: "호 $\\overset{\\frown}{N_1L_1}$",
        count: 2,
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
    figureDescription: Q18_FIGURE_DESCRIPTION,
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
] as const;
const TARGETED_SOLUTION_PROMPT_DIGEST = sha256Text(
  `${TARGETED_SOLUTION_TRANSCRIPTION_VERSION}\n${TARGETED_SOLUTION_TRANSCRIPTION_RULES}`
);
export const TARGETED_SOLUTION_REVISION_PROMPT_DIGEST = sha256Text(
  `${TARGETED_SOLUTION_REVISION_VERSION}\n${TARGETED_SOLUTION_REVISION_RULES}\n` +
  `${TARGETED_SOLUTION_REVISION_EVIDENCE_PREFIX}\n` +
  `${TARGETED_SOLUTION_TRANSCRIPTION_VERSION}\n${TARGETED_SOLUTION_TRANSCRIPTION_RULES}`
);
export const SOLUTION_PROMPT_UPGRADE_ALLOWLIST = [{
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
export const SOLUTION_REVISION_FIDELITY_ADJUDICATION_RULES = `
The attached image-only PDF contains immutable 600-DPI full-page and bounded crop evidence from the official solution.
The supplied solution transcription is unchanged from its prior source-grounded revision. Independently compare its raw
answer and complete explanation with every relevant source pixel. Treat the previous mismatch diagnostic only as an
untrusted locator. Do not solve, rewrite, summarize, or infer alternate wording. For this exact allowlisted source,
the visible statement "함수 f(x)는 극솟값을 갖는다. (거짓)" must be preserved literally. Report answerStatus exact and
explanationStatus exact only when the raw answer and every explanation detail agree with the pixels.
`.trim();
export const SOLUTION_REVISION_FIDELITY_ADJUDICATION_PROMPT_DIGEST = sha256Text(
  `${SOLUTION_REVISION_FIDELITY_ADJUDICATION_VERSION}\n` +
  `${SOLUTION_REVISION_FIDELITY_ADJUDICATION_RULES}\n${SOLUTION_FIDELITY_RULES}`
);
export const SOLUTION_REVISION_FIDELITY_ADJUDICATION_ALLOWLIST = [{
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
  const document = await PDFDocument.create({ updateMetadata: false });
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

const PROBLEM_CROP_DPI = 300;

function pngDimensions(path: string): { width: number; height: number } {
  const header = readFileSync(path).subarray(0, 24);
  if (
    header.length < 24 || header.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    header.subarray(12, 16).toString("ascii") !== "IHDR"
  ) throw new Error(`crop evidence PNG header가 유효하지 않습니다: ${path}`);
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  if (width < 1 || height < 1) throw new Error(`crop evidence PNG 크기가 유효하지 않습니다: ${path}`);
  return { width, height };
}

function outwardCropPixels(
  rect: readonly [number, number, number, number],
  width: number,
  height: number
): { x: number; y: number; width: number; height: number } {
  const [left, top, right, bottom] = rect;
  if (
    ![left, top, right, bottom].every((value) => Number.isFinite(value)) || left < 0 || top < 0 ||
    right > 1 || bottom > 1 || right <= left || bottom <= top
  ) throw new Error("crop evidence normalized rect가 유효하지 않습니다");
  const x = Math.floor(left * width);
  const y = Math.floor(top * height);
  const cropRight = Math.ceil(right * width);
  const cropBottom = Math.ceil(bottom * height);
  return { x, y, width: cropRight - x, height: cropBottom - y };
}

async function copyImmutableBinary(source: string, target: string): Promise<string> {
  const expected = await sha256File(source);
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile() || await sha256File(target) !== expected) {
      throw new Error(`기존 binary evidence가 다릅니다: ${target}`);
    }
    return expected;
  }
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    copyFileSync(source, temp, constants.COPYFILE_EXCL);
    if (await sha256File(temp) !== expected) throw new Error(`binary evidence 복사 hash가 다릅니다: ${target}`);
    renameSync(temp, target);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
  return expected;
}

type PreparedProblemCropEvidence = {
  artifact: EvidencePointer;
  pdf: EvidencePointer & { absolutePath: string };
  views: ProblemCropAdjudicationEvidence["cropViews"];
};

async function prepareProblemCropEvidence(
  entry: CorpusManifestEntry,
  problem: PdfEvidence,
  stateDir: string,
  spec: ProblemCropAdjudicationSpec,
  options: { namespace?: string; version?: number; dpi?: number } = {}
): Promise<PreparedProblemCropEvidence> {
  const namespace = options.namespace ?? "problem-crop-evidence";
  const version = options.version ?? PROBLEM_CROP_ADJUDICATION_VERSION;
  const dpi = options.dpi ?? PROBLEM_CROP_DPI;
  if (!Number.isInteger(dpi) || dpi < 72 || dpi > 600) throw new Error("crop evidence DPI가 유효하지 않습니다");
  if (problem.sha256 !== spec.sourceHash || await sha256File(problem.path) !== problem.sha256) {
    throw new Error(`${spec.key} crop adjudication official source hash가 allowlist와 다릅니다`);
  }
  const sourcePages = [...new Set(spec.views.map((view) => view.sourcePage))].sort((a, b) => a - b);
  const basis = {
    allowlistId: spec.allowlistId,
    entryId: entry.id,
    key: spec.key,
    sourcePage: spec.sourcePage,
    sourcePages,
    sourceHash: problem.sha256,
    dpi,
    views: spec.views,
    requiredTokens: spec.requiredTokens,
  };
  const basisDigest = canonicalEvidenceHash(basis);
  const stem = `v${version}-${String(spec.sourcePage).padStart(4, "0")}-` +
    `${spec.key.split(":")[1]!.padStart(4, "0")}-${basisDigest}`;
  const relativePath = `${namespace}/${stem}.json`;
  const pdfRelativePath = `${namespace}/${stem}.pdf`;
  const checkpointPath = join(stateDir, relativePath);
  const pdfPath = join(stateDir, pdfRelativePath);
  let checkpoint: Record<string, unknown>;
  if (existsSync(checkpointPath)) {
    const safeCheckpointPath = confinedStateFile(stateDir, relativePath, "crop evidence checkpoint");
    checkpoint = object(JSON.parse(readFileSync(safeCheckpointPath, "utf8")), relativePath);
    if (
      checkpoint.version !== version || checkpoint.entryId !== entry.id ||
      checkpoint.basisDigest !== basisDigest || canonicalEvidenceHash(checkpoint.basis) !== canonicalEvidenceHash(basis) ||
      checkpoint.renderer !== "pdftocairo-png+pdf-lib" || checkpoint.dpi !== dpi ||
      canonicalEvidenceHash(checkpoint.evidencePdf) !== canonicalEvidenceHash({
        path: pdfRelativePath,
        sha256: object(checkpoint.evidencePdf, "crop evidence PDF").sha256,
      }) || !Array.isArray(checkpoint.views) || checkpoint.views.length !== spec.views.length
    ) throw new Error(`기존 crop evidence 메타데이터가 다릅니다: ${checkpointPath}`);
  } else {
    await withImporterPdfForAnalysis(problem, async (analysisProblem) => {
      const tempDir = mkdtempSync(join(tmpdir(), "studywork-problem-crop-"));
      try {
        const fullByPage = new Map<number, { path: string; width: number; height: number }>();
        for (const page of sourcePages) {
          const prefix = join(tempDir, `source-${String(page).padStart(4, "0")}`);
          await execFileP(popplerCommand("pdftocairo"), [
            "-png", "-r", String(dpi), "-f", String(page), "-l", String(page),
            "-singlefile", analysisProblem.path, prefix,
          ], { encoding: "utf8", timeout: 5 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
          const path = `${prefix}.png`;
          fullByPage.set(page, { path, ...pngDimensions(path) });
        }
        const rendered: Array<{
          path: string;
        } & Omit<ProblemCropAdjudicationEvidence["cropViews"][number], "artifact">> = [];
        for (const [index, view] of spec.views.entries()) {
          const full = fullByPage.get(view.sourcePage)!;
          const pixels = outwardCropPixels(view.rect, full.width, full.height);
          let path = full.path;
          if (!(pixels.x === 0 && pixels.y === 0 && pixels.width === full.width && pixels.height === full.height)) {
            const prefix = join(tempDir, `view-${String(index).padStart(2, "0")}`);
            await execFileP(popplerCommand("pdftocairo"), [
              "-png", "-r", String(dpi), "-f", String(view.sourcePage),
              "-l", String(view.sourcePage), "-singlefile", "-x", String(pixels.x), "-y", String(pixels.y),
              "-W", String(pixels.width), "-H", String(pixels.height), analysisProblem.path, prefix,
            ], { encoding: "utf8", timeout: 5 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
            path = `${prefix}.png`;
          }
          const actual = pngDimensions(path);
          if (actual.width !== pixels.width || actual.height !== pixels.height) {
            throw new Error(`${spec.key} crop evidence pixel 크기가 요청 범위와 다릅니다`);
          }
          rendered.push({
            path,
            sourcePage: view.sourcePage,
            label: view.label,
            rect: [...view.rect],
            pixelWidth: actual.width,
            pixelHeight: actual.height,
            pixelSha256: await sha256File(path),
          });
        }
        const tempPdf = join(tempDir, "evidence.pdf");
        await buildImageOnlyPdfFromPngs(rendered.map((view) => view.path), tempPdf, dpi);
        const pdfStat = statSync(tempPdf);
        if (!pdfStat.isFile() || pdfStat.size < 5 || pdfStat.size > MAX_PDF_BYTES) {
          throw new Error(`${spec.key} crop evidence PDF 크기가 AI 입력 한도를 벗어났습니다`);
        }
        if (await pdfPageCount(tempPdf) !== rendered.length) {
          throw new Error(`${spec.key} crop evidence PDF page coverage가 다릅니다`);
        }
        const persistedViews: ProblemCropAdjudicationEvidence["cropViews"] = [];
        for (const [index, { path, ...view }] of rendered.entries()) {
          const viewRelativePath = `${namespace}/${stem}-view-${String(index).padStart(2, "0")}.png`;
          const viewSha = await copyImmutableBinary(path, join(stateDir, viewRelativePath));
          if (viewSha !== view.pixelSha256) throw new Error(`${spec.key} crop evidence view hash가 다릅니다`);
          persistedViews.push({ ...view, artifact: { path: viewRelativePath, sha256: viewSha } });
        }
        const evidencePdfSha = await copyImmutableBinary(tempPdf, pdfPath);
        checkpoint = {
          version,
          entryId: entry.id,
          basisDigest,
          basis,
          renderer: "pdftocairo-png+pdf-lib",
          dpi,
          evidencePdf: { path: pdfRelativePath, sha256: evidencePdfSha },
          views: persistedViews,
        };
        await writeImmutableEvidence(checkpointPath, checkpoint);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  }
  const checkpointSha = await sha256File(checkpointPath);
  if (checkpointSha !== canonicalEvidenceHash(checkpoint!)) {
    throw new Error(`${spec.key} crop evidence checkpoint hash가 다릅니다`);
  }
  const evidencePdf = object(checkpoint!.evidencePdf, "crop evidence PDF");
  const evidencePdfPath = confinedStateFile(stateDir, exactString(evidencePdf.path, "crop evidence PDF path", 500), "crop evidence PDF");
  const evidencePdfSha = exactHash(evidencePdf.sha256, "crop evidence PDF hash");
  if (await sha256File(evidencePdfPath) !== evidencePdfSha) throw new Error(`${spec.key} crop evidence PDF hash가 다릅니다`);
  const views: ProblemCropAdjudicationEvidence["cropViews"] = [];
  for (const [index, raw] of (checkpoint!.views as unknown[]).entries()) {
    const row = object(raw, `crop evidence view ${index + 1}`);
    const expected = spec.views[index];
    const rect = row.rect;
    const artifact = object(row.artifact, `crop evidence view ${index + 1} artifact`);
    const expectedPath = `${namespace}/${stem}-view-${String(index).padStart(2, "0")}.png`;
    const artifactPath = exactString(artifact.path, `crop evidence view ${index + 1} path`, 500);
    const artifactSha = exactHash(artifact.sha256, `crop evidence view ${index + 1} artifact hash`);
    const pixelSha256 = exactHash(row.pixelSha256, `crop evidence view ${index + 1} hash`);
    if (
      row.sourcePage !== expected.sourcePage || row.label !== expected.label ||
      canonicalEvidenceHash(rect) !== canonicalEvidenceHash(expected.rect) ||
      !Number.isInteger(row.pixelWidth) || Number(row.pixelWidth) < 1 ||
      !Number.isInteger(row.pixelHeight) || Number(row.pixelHeight) < 1 || artifactPath !== expectedPath ||
      artifactSha !== pixelSha256 || canonicalEvidenceHash(artifact) !== canonicalEvidenceHash({
        path: expectedPath,
        sha256: pixelSha256,
      })
    ) throw new Error(`${spec.key} crop evidence view 메타데이터가 다릅니다`);
    const absoluteViewPath = confinedStateFile(stateDir, artifactPath, `crop evidence view ${index + 1}`);
    if (await sha256File(absoluteViewPath) !== pixelSha256) {
      throw new Error(`${spec.key} crop evidence view file hash가 다릅니다`);
    }
    const dimensions = pngDimensions(absoluteViewPath);
    if (dimensions.width !== row.pixelWidth || dimensions.height !== row.pixelHeight) {
      throw new Error(`${spec.key} crop evidence view file 크기가 다릅니다`);
    }
    views.push({
      sourcePage: expected.sourcePage,
      label: expected.label,
      rect: [...expected.rect] as [number, number, number, number],
      pixelWidth: Number(row.pixelWidth),
      pixelHeight: Number(row.pixelHeight),
      pixelSha256,
      artifact: { path: artifactPath, sha256: artifactSha },
    });
  }
  return {
    artifact: { path: relativePath, sha256: checkpointSha },
    pdf: { path: pdfRelativePath, sha256: evidencePdfSha, absolutePath: evidencePdfPath },
    views,
  };
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

function parseHistoricalDecision(value: unknown, expectedKey: string, label: string): ClassificationDecision {
  const row = object(value, label);
  if (Object.keys(row).sort().join(",") !== [
    "achievement_codes",
    "canonical_subject",
    "confidence",
    "curriculum_course",
    "decision",
    "domain",
    "key",
    "reason_codes",
    "transcription_evidence",
    "transcription_status",
  ].join(",")) throw new Error(`${label} exact key 집합이 다릅니다`);
  const key = exactString(row.key, `${label}.key`, 100);
  if (key !== expectedKey) throw new Error(`${label} key가 다릅니다`);
  if (!( ["accept", "reject", "review"] as unknown[]).includes(row.decision)) {
    throw new Error(`${label} decision이 유효하지 않습니다`);
  }
  const decision = row.decision as ClassificationDecision["decision"];
  const canonicalSubject = row.canonical_subject === null
    ? null
    : exactString(row.canonical_subject, `${label}.canonical_subject`, 100) as CanonicalSubject;
  if (canonicalSubject !== null && !(canonicalSubject in TARGET_BY_CANONICAL)) {
    throw new Error(`${label} canonical_subject가 유효하지 않습니다`);
  }
  const curriculumCourse = row.curriculum_course === null
    ? null
    : exactString(row.curriculum_course, `${label}.curriculum_course`, 200);
  const domain = row.domain === null ? null : exactString(row.domain, `${label}.domain`, 200);
  if (!Array.isArray(row.achievement_codes) || row.achievement_codes.some(
    (code) => typeof code !== "string" || !code.trim() || code !== code.trim()
  )) throw new Error(`${label} achievement_codes가 유효하지 않습니다`);
  if (!Array.isArray(row.reason_codes) || row.reason_codes.length === 0 || row.reason_codes.some(
    (code) => typeof code !== "string" || !code.trim() || code !== code.trim()
  )) throw new Error(`${label} reason_codes가 유효하지 않습니다`);
  if (!( ["exact", "mismatch", "unverifiable"] as unknown[]).includes(row.transcription_status)) {
    throw new Error(`${label} transcription_status가 유효하지 않습니다`);
  }
  const confidence = Number(row.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`${label} confidence가 유효하지 않습니다`);
  }
  const achievementCodes = [...new Set(row.achievement_codes as string[])];
  if (decision === "accept") {
    if (!canonicalSubject || !curriculumCourse || !domain || achievementCodes.length === 0 || confidence < 0.9) {
      throw new Error(`${label} historical accept 근거가 부족합니다`);
    }
  } else if (canonicalSubject !== null || curriculumCourse !== null || domain !== null || achievementCodes.length !== 0) {
    throw new Error(`${label} historical reject/review scope fields가 null이 아닙니다`);
  }
  return {
    key,
    decision,
    canonical_subject: canonicalSubject,
    curriculum_course: curriculumCourse,
    domain,
    achievement_codes: achievementCodes,
    confidence,
    reason_codes: [...new Set(row.reason_codes as string[])],
    transcription_status: row.transcription_status as ClassificationDecision["transcription_status"],
    transcription_evidence: exactString(row.transcription_evidence, `${label}.transcription_evidence`, 2_000),
  };
}

async function classifyQuestions(
  entry: CorpusManifestEntry,
  path: string,
  from: number,
  to: number,
  questions: QuizItemEx[],
  opts?: { revisionEvidence?: string; sourceEvidenceNote?: string; targeted?: boolean }
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
  const sourceEvidenceNote = opts?.sourceEvidenceNote;
  if (sourceEvidenceNote !== undefined) exactString(sourceEvidenceNote, "problem source evidence note", 8000);
  const revisionRule = revisionEvidence === undefined ? "" :
    `\n\n${TARGETED_PROBLEM_REVISION_RULES}\n` +
    `${TARGETED_PROBLEM_REVISION_EVIDENCE_PREFIX} ${JSON.stringify(revisionEvidence)}`;
  const prompt =
    `Attached official problem PDF slice contains original pages ${from}-${to}. ` +
    `Exam source subject is ${entry.subject}; source school grade is ${entry.grade ?? "unknown"}. ` +
    `Inspect complete source passages and visual evidence, then classify every supplied question.` +
    (sourceEvidenceNote ? ` ${sourceEvidenceNote}` : "") + `\n\n` +
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
  repairedKeys: ReadonlySet<string>,
  scopeAdjudicatedKeys: ReadonlySet<string> = new Set(),
  positiveScopeAuthorityKeys: ReadonlySet<string> = new Set()
): void {
  const itemByKey = new Map(items.map((item) => [item.key, item]));
  if (itemByKey.size !== items.length || classified.length !== items.length) {
    throw new Error("terminal 문제 fidelity policy coverage가 다릅니다");
  }
  for (const current of classified) {
    const key = questionKey(current.question);
    const item = itemByKey.get(key);
    const acceptedScopeAgrees = positiveScopeAuthorityKeys.has(key)
      ? true
      : scopeAdjudicatedKeys.has(key)
      ? item?.scopeDecision === current.classification.decision && item.scopeConfidence >= 0.9
      : current.classification.decision !== "accept" ||
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

function solutionRevisionFidelityAdjudicationSpec(
  entry: CorpusManifestEntry,
  evidence: PdfEvidence,
  key: string,
  revisionArtifactHash: string,
  failedFidelityArtifactHash: string,
  revisionSolutionItemHash: string,
  failedDecision: SolutionFidelityDecision
) {
  return SOLUTION_REVISION_FIDELITY_ADJUDICATION_ALLOWLIST.find((candidate) =>
    candidate.entryId === entry.id && candidate.key === key && candidate.sourceHash === evidence.sha256 &&
    candidate.revisionArtifactHash === revisionArtifactHash &&
    candidate.failedFidelityArtifactHash === failedFidelityArtifactHash &&
    candidate.revisionSolutionItemHash === revisionSolutionItemHash &&
    candidate.failedDecisionHash === canonicalEvidenceHash(failedDecision) &&
    candidate.failedEvidenceHash === sha256Text(failedDecision.evidence)
  );
}

function normalizedSolutionLiteral(value: string): string {
  return value.replace(/\\\(|\\\)|\$/gu, "").replace(/\s+/gu, "");
}

function assertSolutionRevisionFidelityAdjudicationLiteral(
  spec: typeof SOLUTION_REVISION_FIDELITY_ADJUDICATION_ALLOWLIST[number],
  solution: SolutionItem
): void {
  if (
    solution.answer !== "③" ||
    !normalizedSolutionLiteral(solution.explanation).includes(normalizedSolutionLiteral(spec.literalToken))
  ) throw new Error(`${spec.key} allowlisted 해설 literal이 공식 source와 다릅니다`);
}

async function adjudicateSolutionRevisionFidelity(
  entry: CorpusManifestEntry,
  evidence: PdfEvidence,
  stateDir: string,
  effectiveProblemCorpusHash: string,
  input: SolutionFidelityInput,
  solution: SolutionItem,
  revisionArtifact: EvidencePointer,
  failedFidelityArtifact: EvidencePointer & { promptDigest: string },
  failedDecision: SolutionFidelityDecision
): Promise<{
  decision: SolutionFidelityDecision;
  artifact: EvidencePointer;
  evidence: SolutionRevisionFidelityAdjudicationEvidence;
}> {
  const revisionSolutionItemHash = canonicalEvidenceHash(solution);
  const spec = solutionRevisionFidelityAdjudicationSpec(
    entry,
    evidence,
    input.key,
    revisionArtifact.sha256,
    failedFidelityArtifact.sha256,
    revisionSolutionItemHash,
    failedDecision
  );
  if (
    !spec || failedFidelityArtifact.promptDigest !== SOLUTION_FIDELITY_PROMPT_DIGEST ||
    failedDecision.sourcePage !== solution.page || terminalSolutionFidelity(input, solution, failedDecision) ||
    await sha256File(evidence.path) !== evidence.sha256
  ) throw new Error(`${input.key} solution fidelity adjudication authority가 없습니다`);
  assertSolutionRevisionFidelityAdjudicationLiteral(spec, solution);
  for (const [label, pointer] of [
    ["solution revision", revisionArtifact],
    ["failed solution revision fidelity", failedFidelityArtifact],
  ] as const) {
    const path = confinedStateFile(stateDir, pointer.path, label);
    if (await sha256File(path) !== pointer.sha256) throw new Error(`${input.key} ${label} hash가 다릅니다`);
  }
  const cropSpec: ProblemCropAdjudicationSpec = {
    allowlistId: spec.allowlistId,
    entryId: spec.entryId,
    key: spec.key,
    sourcePage: spec.sourcePage,
    sourceHash: spec.sourceHash,
    views: spec.views.map((view) => ({ ...view, rect: [...view.rect] })),
    requiredTokens: [...spec.requiredTokens],
  };
  const prepared = await prepareProblemCropEvidence(entry, evidence, stateDir, cropSpec, {
    namespace: "solution-fidelity-adjudication-evidence",
    version: SOLUTION_REVISION_FIDELITY_ADJUDICATION_VERSION,
    dpi: spec.dpi,
  });
  const sourcePages = [...new Set(spec.views.map((view) => view.sourcePage))].sort((a, b) => a - b);
  const failedDecisionHash = canonicalEvidenceHash(failedDecision);
  const failedEvidenceHash = sha256Text(failedDecision.evidence);
  const inputHash = canonicalEvidenceHash(input);
  const basis = {
    allowlistId: spec.allowlistId,
    entryId: entry.id,
    key: input.key,
    sourcePage: spec.sourcePage,
    sourcePages,
    sourceHash: evidence.sha256,
    dpi: spec.dpi,
    effectiveProblemCorpusHash,
    revisionArtifact,
    failedFidelityArtifact,
    revisionSolutionItemHash,
    failedDecision,
    failedDecisionHash,
    failedEvidenceHash,
    cropEvidenceArtifact: prepared.artifact,
    cropEvidencePdf: { path: prepared.pdf.path, sha256: prepared.pdf.sha256 },
    cropViews: prepared.views,
    inputHash,
    promptDigest: SOLUTION_REVISION_FIDELITY_ADJUDICATION_PROMPT_DIGEST,
  };
  const basisDigest = canonicalEvidenceHash(basis);
  const relativePath = `solution-fidelity-adjudications/v${SOLUTION_REVISION_FIDELITY_ADJUDICATION_VERSION}-` +
    `${String(solution.page).padStart(4, "0")}-${input.printedNumber.padStart(4, "0")}-${basisDigest}.json`;
  const path = join(stateDir, relativePath);
  let checkpoint: Record<string, unknown>;
  let decision: SolutionFidelityDecision;
  if (existsSync(path)) {
    checkpoint = object(JSON.parse(readFileSync(path, "utf8")), relativePath);
    decision = parseSolutionFidelityDecisions([checkpoint.item], [input])[0];
  } else {
    const prompt =
      `The attached image-only evidence PDF contains ordered views of official solution pages ` +
      `${sourcePages.join(", ")}. View labels and normalized crop rectangles are ` +
      `${JSON.stringify(spec.views)}.\n\n${SOLUTION_REVISION_FIDELITY_ADJUDICATION_RULES}\n\n` +
      `Solution transcription:\n${JSON.stringify([{
        key: input.key,
        printed_number: input.printedNumber,
        question_type: input.qtype,
        source_page: input.sourcePage,
        raw_answer: input.rawAnswer,
        explanation: input.explanation,
        complete: input.complete,
      }])}`;
    const result = await withFullContextAi(() => getCodexProvider({
      model: IMPORT_MODEL,
      reasoningEffort: IMPORT_REASONING_EFFORT,
    }).complete({
      operation: "problem-extract",
      prompt,
      file: { path: prepared.pdf.absolutePath, kind: "pdf" },
      schema: SOLUTION_FIDELITY_SCHEMA,
      model: IMPORT_MODEL,
      reasoningEffort: IMPORT_REASONING_EFFORT,
      lane: "bulk",
    }));
    decision = parseSolutionFidelityDecisions(schemaItems(result.text, "해설 fidelity adjudication 응답"), [input])[0];
    checkpoint = {
      version: SOLUTION_REVISION_FIDELITY_ADJUDICATION_VERSION,
      basisDigest,
      basis,
      model: IMPORT_MODEL,
      reasoningEffort: IMPORT_REASONING_EFFORT,
      input,
      item: decision,
    };
    await writeImmutableEvidence(path, checkpoint);
  }
  const expectedCheckpoint = {
    version: SOLUTION_REVISION_FIDELITY_ADJUDICATION_VERSION,
    basisDigest,
    basis,
    model: IMPORT_MODEL,
    reasoningEffort: IMPORT_REASONING_EFFORT,
    input,
    item: decision,
  };
  if (
    canonicalEvidenceHash(checkpoint) !== canonicalEvidenceHash(expectedCheckpoint) ||
    decision.sourcePage !== solution.page || decision.answerStatus !== "exact" ||
    decision.explanationStatus !== "exact"
  ) throw new Error(`${input.key} solution fidelity adjudication이 terminal exact가 아닙니다`);
  const sha256 = await sha256File(path);
  if (sha256 !== canonicalEvidenceHash(checkpoint)) {
    throw new Error(`${input.key} solution fidelity adjudication hash가 다릅니다`);
  }
  return {
    decision,
    artifact: { path: relativePath, sha256 },
    evidence: {
      allowlistId: spec.allowlistId,
      key: input.key,
      sourcePage: spec.sourcePage,
      sourcePages,
      sourceHash: evidence.sha256,
      dpi: spec.dpi,
      revisionArtifact,
      failedFidelityArtifact,
      revisionSolutionItemHash,
      failedDecisionHash,
      failedEvidenceHash,
      cropEvidenceArtifact: prepared.artifact,
      cropEvidencePdf: { path: prepared.pdf.path, sha256: prepared.pdf.sha256 },
      cropViews: prepared.views,
      adjudicationArtifact: {
        path: relativePath,
        sha256,
        version: SOLUTION_REVISION_FIDELITY_ADJUDICATION_VERSION,
        promptDigest: SOLUTION_REVISION_FIDELITY_ADJUDICATION_PROMPT_DIGEST,
      },
      adjudicationDecisionHash: canonicalEvidenceHash(decision),
    },
  };
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

type CanonicalSolutionArtifact = {
  relativePath: string;
  sha256: string;
  checkpoint: Record<string, unknown>;
};

type PersistedSolutionHistory = {
  stickyFirst: Map<string, PersistedSolutionFirstAuthority>;
  revisionTriggers: Map<string, Exclude<SolutionRevisionTrigger, { kind: "fidelity" }>>;
  requiredRevisionKeys: Set<string>;
  currentPartialKeys: Set<string>;
};

function persistedEvidencePointer(value: unknown, label: string): EvidencePointer {
  const row = object(value, label);
  const pointer = {
    path: exactString(row.path, `${label}.path`, 500),
    sha256: exactHash(row.sha256, `${label}.sha256`),
  };
  if (canonicalEvidenceHash(row) !== canonicalEvidenceHash(pointer)) {
    throw new Error(`${label}에 예상하지 않은 필드가 있습니다`);
  }
  return pointer;
}

function persistedRevisionAuthority(value: unknown, label: string): PersistedSolutionRevisionAuthority {
  const row = object(value, label);
  const fidelityAdjudication = row.fidelityAdjudication === undefined
    ? undefined
    : structuredClone(object(row.fidelityAdjudication, `${label}.fidelityAdjudication`)) as
      unknown as SolutionRevisionFidelityAdjudicationEvidence;
  const authority: PersistedSolutionRevisionAuthority = {
    generationId: exactHash(row.generationId, `${label}.generationId`),
    key: exactString(row.key, `${label}.key`, 100),
    repairArtifact: persistedEvidencePointer(row.repairArtifact, `${label}.repairArtifact`),
    repairFidelityArtifact: persistedEvidencePointer(
      row.repairFidelityArtifact,
      `${label}.repairFidelityArtifact`
    ),
    revisionArtifact: persistedEvidencePointer(row.revisionArtifact, `${label}.revisionArtifact`),
    revisionFidelityArtifact: persistedEvidencePointer(
      row.revisionFidelityArtifact,
      `${label}.revisionFidelityArtifact`
    ),
    finalSolutionItemHash: exactHash(row.finalSolutionItemHash, `${label}.finalSolutionItemHash`),
    diagnosticDecisionHash: exactHash(row.diagnosticDecisionHash, `${label}.diagnosticDecisionHash`),
    diagnosticEvidence: exactString(row.diagnosticEvidence, `${label}.diagnosticEvidence`, 2000),
    ...(fidelityAdjudication ? { fidelityAdjudication } : {}),
  };
  if (canonicalEvidenceHash(row) !== canonicalEvidenceHash(authority)) {
    throw new Error(`${label}에 예상하지 않은 필드가 있습니다`);
  }
  return authority;
}

function legacySolutionRevisionPredecessor(
  value: unknown,
  label: string
): LegacySolutionRevisionPredecessor {
  const row = object(value, label);
  const revisionArtifactRow = object(row.revisionArtifact, `${label}.revisionArtifact`);
  const revisionArtifact = {
    path: exactString(revisionArtifactRow.path, `${label}.revisionArtifact.path`, 500),
    sha256: exactHash(revisionArtifactRow.sha256, `${label}.revisionArtifact.sha256`),
    promptVersion: Number(revisionArtifactRow.promptVersion),
    promptDigest: exactHash(revisionArtifactRow.promptDigest, `${label}.revisionArtifact.promptDigest`),
  };
  const predecessor: LegacySolutionRevisionPredecessor = {
    allowlistId: exactString(row.allowlistId, `${label}.allowlistId`, 200),
    generationId: exactHash(row.generationId, `${label}.generationId`),
    key: exactString(row.key, `${label}.key`, 100),
    effectiveProblemCorpusHash: exactHash(
      row.effectiveProblemCorpusHash,
      `${label}.effectiveProblemCorpusHash`
    ),
    repairArtifact: persistedEvidencePointer(row.repairArtifact, `${label}.repairArtifact`),
    repairFidelityArtifact: persistedEvidencePointer(
      row.repairFidelityArtifact,
      `${label}.repairFidelityArtifact`
    ),
    revisionArtifact,
    revisionFidelityArtifact: persistedEvidencePointer(
      row.revisionFidelityArtifact,
      `${label}.revisionFidelityArtifact`
    ),
    revisionSolutionItemHash: exactHash(
      row.revisionSolutionItemHash,
      `${label}.revisionSolutionItemHash`
    ),
    failedDecisionHash: exactHash(row.failedDecisionHash, `${label}.failedDecisionHash`),
    failedEvidenceHash: exactHash(row.failedEvidenceHash, `${label}.failedEvidenceHash`),
    failedEvidence: exactString(row.failedEvidence, `${label}.failedEvidence`, 2000),
  };
  if (
    !Number.isInteger(revisionArtifact.promptVersion) ||
    canonicalEvidenceHash(row) !== canonicalEvidenceHash(predecessor)
  ) throw new Error(`${label}에 예상하지 않은 필드가 있습니다`);
  return predecessor;
}

function terminalSolutionFidelity(
  input: SolutionFidelityInput,
  solution: SolutionItem,
  decision: SolutionFidelityDecision
): boolean {
  const terminalAnswer = decision.answerStatus === "exact" ||
    decision.answerStatus === "not_visible" && input.allowDerivedMarkerAnswer;
  return decision.sourcePage === solution.page && decision.explanationStatus === "exact" && terminalAnswer;
}

async function readCanonicalSolutionArtifacts(
  stateDir: string,
  directory: string,
  fileName: RegExp
): Promise<CanonicalSolutionArtifact[]> {
  const absoluteDirectory = join(stateDir, directory);
  if (!existsSync(absoluteDirectory)) return [];
  const artifacts: CanonicalSolutionArtifact[] = [];
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name))) {
    if (entry.isFile() && entry.name.endsWith(".tmp")) continue;
    if (!entry.isFile() || entry.isSymbolicLink() || !fileName.test(entry.name)) {
      throw new Error(`${directory}에 malformed solution authority가 있습니다: ${entry.name}`);
    }
    const relativePath = `${directory}/${entry.name}`;
    const absolutePath = confinedStateFile(stateDir, relativePath, directory);
    const checkpoint = object(JSON.parse(readFileSync(absolutePath, "utf8")), relativePath);
    const sha256 = await sha256File(absolutePath);
    if (sha256 !== canonicalEvidenceHash(checkpoint)) {
      throw new Error(`${relativePath} canonical hash가 다릅니다`);
    }
    artifacts.push({ relativePath, sha256, checkpoint });
  }
  return artifacts;
}

async function validatePersistedSolutionRevisionFidelityAdjudication(
  entry: CorpusManifestEntry,
  evidence: PdfEvidence,
  stateDir: string,
  effectiveProblemCorpusHash: string,
  input: SolutionFidelityInput,
  solution: SolutionItem,
  revisionArtifact: EvidencePointer,
  failedFidelityArtifact: EvidencePointer & { promptDigest: string },
  failedDecision: SolutionFidelityDecision,
  candidates: CanonicalSolutionArtifact[]
): Promise<{
  decision: SolutionFidelityDecision;
  evidence: SolutionRevisionFidelityAdjudicationEvidence;
  childPath: string;
  evidencePaths: string[];
}> {
  const revisionSolutionItemHash = canonicalEvidenceHash(solution);
  const spec = solutionRevisionFidelityAdjudicationSpec(
    entry,
    evidence,
    input.key,
    revisionArtifact.sha256,
    failedFidelityArtifact.sha256,
    revisionSolutionItemHash,
    failedDecision
  );
  if (
    !spec || failedDecision.sourcePage !== solution.page ||
    failedDecision.answerStatus !== "exact" || failedDecision.explanationStatus !== "mismatch" ||
    terminalSolutionFidelity(input, solution, failedDecision)
  ) throw new Error(`${input.key} persisted solution fidelity adjudication allowlist가 다릅니다`);
  assertSolutionRevisionFidelityAdjudicationLiteral(spec, solution);

  const children = candidates.filter((candidate) => {
    const basis = object(candidate.checkpoint.basis, `${candidate.relativePath}.basis`);
    const pointer = object(basis.revisionArtifact, `${candidate.relativePath}.basis.revisionArtifact`);
    return pointer.path === revisionArtifact.path;
  });
  if (children.length !== 1) {
    throw new Error(`${input.key} solution fidelity adjudication child coverage가 다릅니다`);
  }
  const child = children[0];
  const sourcePages = [...new Set(spec.views.map((view) => view.sourcePage))].sort((a, b) => a - b);
  const evidenceBasis = {
    allowlistId: spec.allowlistId,
    entryId: entry.id,
    key: input.key,
    sourcePage: spec.sourcePage,
    sourcePages,
    sourceHash: evidence.sha256,
    dpi: spec.dpi,
    views: spec.views,
    requiredTokens: spec.requiredTokens,
  };
  const evidenceDigest = canonicalEvidenceHash(evidenceBasis);
  const evidenceStem = `v${SOLUTION_REVISION_FIDELITY_ADJUDICATION_VERSION}-` +
    `${String(spec.sourcePage).padStart(4, "0")}-${input.printedNumber.padStart(4, "0")}-${evidenceDigest}`;
  const evidenceRelativePath = `solution-fidelity-adjudication-evidence/${evidenceStem}.json`;
  const evidencePdfRelativePath = `solution-fidelity-adjudication-evidence/${evidenceStem}.pdf`;
  const evidencePath = confinedStateFile(stateDir, evidenceRelativePath, "solution fidelity adjudication evidence");
  const evidenceCheckpoint = object(JSON.parse(readFileSync(evidencePath, "utf8")), evidenceRelativePath);
  const evidencePdf = object(evidenceCheckpoint.evidencePdf, `${evidenceRelativePath}.evidencePdf`);
  const cropViews: ProblemCropAdjudicationEvidence["cropViews"] = [];
  if (Array.isArray(evidenceCheckpoint.views)) {
    for (const [index, raw] of evidenceCheckpoint.views.entries()) {
      const row = object(raw, `${evidenceRelativePath}.views[${index}]`);
      const expected = spec.views[index];
      if (!expected) throw new Error(`${evidenceRelativePath} crop view가 초과되었습니다`);
      const artifact = persistedEvidencePointer(row.artifact, `${evidenceRelativePath}.views[${index}].artifact`);
      const view = {
        sourcePage: Number(row.sourcePage),
        label: exactString(row.label, `${evidenceRelativePath}.views[${index}].label`, 200),
        rect: row.rect as [number, number, number, number],
        pixelWidth: Number(row.pixelWidth),
        pixelHeight: Number(row.pixelHeight),
        pixelSha256: exactHash(row.pixelSha256, `${evidenceRelativePath}.views[${index}].pixelSha256`),
        artifact,
      };
      const expectedViewPath = `solution-fidelity-adjudication-evidence/${evidenceStem}-view-` +
        `${String(index).padStart(2, "0")}.png`;
      const viewPath = confinedStateFile(stateDir, artifact.path, `solution fidelity adjudication view ${index + 1}`);
      const dimensions = pngDimensions(viewPath);
      if (
        view.sourcePage !== expected.sourcePage || view.label !== expected.label ||
        canonicalEvidenceHash(view.rect) !== canonicalEvidenceHash(expected.rect) ||
        view.pixelWidth !== dimensions.width || view.pixelHeight !== dimensions.height ||
        artifact.path !== expectedViewPath || artifact.sha256 !== view.pixelSha256 ||
        await sha256File(viewPath) !== view.pixelSha256 ||
        canonicalEvidenceHash(row) !== canonicalEvidenceHash(view)
      ) throw new Error(`${input.key} persisted solution fidelity crop view가 다릅니다`);
      cropViews.push(view);
    }
  }
  const evidencePdfPointer = {
    path: exactString(evidencePdf.path, `${evidenceRelativePath}.evidencePdf.path`, 500),
    sha256: exactHash(evidencePdf.sha256, `${evidenceRelativePath}.evidencePdf.sha256`),
  };
  const expectedEvidence = {
    version: SOLUTION_REVISION_FIDELITY_ADJUDICATION_VERSION,
    entryId: entry.id,
    basisDigest: evidenceDigest,
    basis: evidenceBasis,
    renderer: "pdftocairo-png+pdf-lib",
    dpi: spec.dpi,
    evidencePdf: evidencePdfPointer,
    views: cropViews,
  };
  if (
    evidencePdfPointer.path !== evidencePdfRelativePath || cropViews.length !== spec.views.length ||
    await sha256File(evidencePath) !== canonicalEvidenceHash(evidenceCheckpoint) ||
    canonicalEvidenceHash(evidenceCheckpoint) !== canonicalEvidenceHash(expectedEvidence) ||
    await sha256File(confinedStateFile(stateDir, evidencePdfRelativePath, "solution fidelity evidence PDF")) !==
      evidencePdfPointer.sha256
  ) throw new Error(`${input.key} persisted solution fidelity crop evidence가 다릅니다`);

  const failedDecisionHash = canonicalEvidenceHash(failedDecision);
  const failedEvidenceHash = sha256Text(failedDecision.evidence);
  const inputHash = canonicalEvidenceHash(input);
  const cropEvidenceArtifact = { path: evidenceRelativePath, sha256: canonicalEvidenceHash(evidenceCheckpoint) };
  const basis = {
    allowlistId: spec.allowlistId,
    entryId: entry.id,
    key: input.key,
    sourcePage: spec.sourcePage,
    sourcePages,
    sourceHash: evidence.sha256,
    dpi: spec.dpi,
    effectiveProblemCorpusHash,
    revisionArtifact,
    failedFidelityArtifact,
    revisionSolutionItemHash,
    failedDecision,
    failedDecisionHash,
    failedEvidenceHash,
    cropEvidenceArtifact,
    cropEvidencePdf: evidencePdfPointer,
    cropViews,
    inputHash,
    promptDigest: SOLUTION_REVISION_FIDELITY_ADJUDICATION_PROMPT_DIGEST,
  };
  const basisDigest = canonicalEvidenceHash(basis);
  const expectedChildPath = `solution-fidelity-adjudications/` +
    `v${SOLUTION_REVISION_FIDELITY_ADJUDICATION_VERSION}-${String(solution.page).padStart(4, "0")}-` +
    `${input.printedNumber.padStart(4, "0")}-${basisDigest}.json`;
  const decision = parseSolutionFidelityDecisions([child.checkpoint.item], [input])[0];
  const expectedChild = {
    version: SOLUTION_REVISION_FIDELITY_ADJUDICATION_VERSION,
    basisDigest,
    basis,
    model: IMPORT_MODEL,
    reasoningEffort: IMPORT_REASONING_EFFORT,
    input,
    item: decision,
  };
  if (
    child.relativePath !== expectedChildPath || canonicalEvidenceHash(child.checkpoint) !== canonicalEvidenceHash(expectedChild) ||
    decision.sourcePage !== solution.page || decision.answerStatus !== "exact" ||
    decision.explanationStatus !== "exact"
  ) throw new Error(`${input.key} persisted solution fidelity adjudication child가 다릅니다`);
  return {
    decision,
    childPath: child.relativePath,
    evidencePaths: [
      evidenceRelativePath,
      evidencePdfRelativePath,
      ...cropViews.map((view) => view.artifact.path),
    ],
    evidence: {
      allowlistId: spec.allowlistId,
      key: input.key,
      sourcePage: spec.sourcePage,
      sourcePages,
      sourceHash: evidence.sha256,
      dpi: spec.dpi,
      revisionArtifact,
      failedFidelityArtifact,
      revisionSolutionItemHash,
      failedDecisionHash,
      failedEvidenceHash,
      cropEvidenceArtifact,
      cropEvidencePdf: evidencePdfPointer,
      cropViews,
      adjudicationArtifact: {
        path: child.relativePath,
        sha256: child.sha256,
        version: SOLUTION_REVISION_FIDELITY_ADJUDICATION_VERSION,
        promptDigest: SOLUTION_REVISION_FIDELITY_ADJUDICATION_PROMPT_DIGEST,
      },
      adjudicationDecisionHash: canonicalEvidenceHash(decision),
    },
  };
}

function historicalTranscriptionBinding(checkpoint: Record<string, unknown>): boolean {
  if (checkpoint.rulesDigest !== CLASSIFIER_DIGEST) return false;
  if (
    checkpoint.transcriptionGateVersion === TRANSCRIPTION_GATE_VERSION &&
    checkpoint.transcriptionPromptDigest === TRANSCRIPTION_PROMPT_DIGEST &&
    checkpoint.classifierVersion === CLASSIFIER_VERSION
  ) return true;
  return checkpoint.transcriptionGateVersion === 1 && checkpoint.classifierVersion === 4 &&
    checkpoint.transcriptionPromptDigest ===
      "d5c9f2a9cdf24a7249fe99d32b940775b72c95a1cab9016a60641672dc6a344a";
}

async function persistedSemanticRevisionTrigger(
  entry: CorpusManifestEntry,
  problemEvidence: PdfEvidence,
  solutionEvidence: PdfEvidence,
  stateDir: string,
  effectiveProblemCorpusHash: string,
  key: string,
  fidelityDecisionHash: string,
  rawTrigger: Record<string, unknown>,
  rawDecision: unknown
): Promise<{
  evidence: SolutionRevisionEvidence["trigger"];
  runtime: Extract<SolutionRevisionTrigger, { kind: "semantic" }>;
  diagnosticEvidence: string;
}> {
  const pointerRow = object(rawTrigger.semanticCheckpoint, "persisted semantic checkpoint pointer");
  const pointer = {
    path: exactString(pointerRow.path, "persisted semantic checkpoint pointer.path", 500),
    sha256: exactHash(pointerRow.sha256, "persisted semantic checkpoint pointer.sha256"),
    inputHash: exactHash(pointerRow.inputHash, "persisted semantic input hash"),
    effectiveCorpusHash: exactHash(pointerRow.effectiveCorpusHash, "persisted semantic problem corpus hash"),
    effectiveSolutionCorpusHash: exactHash(
      pointerRow.effectiveSolutionCorpusHash,
      "persisted semantic solution corpus hash"
    ),
  };
  if (canonicalEvidenceHash(pointerRow) !== canonicalEvidenceHash(pointer)) {
    throw new Error(`${key} persisted semantic pointer envelope가 다릅니다`);
  }
  const path = confinedStateFile(stateDir, pointer.path, "persisted semantic checkpoint");
  if (await sha256File(path) !== pointer.sha256) throw new Error(`${key} semantic checkpoint hash가 다릅니다`);
  const checkpoint = object(JSON.parse(readFileSync(path, "utf8")), pointer.path);
  const version = Number(checkpoint.version);
  if (![3, 4, 5].includes(version) || !Array.isArray(checkpoint.inputs) || !Array.isArray(checkpoint.items)) {
    throw new Error(`${key} persisted semantic checkpoint version/schema가 유효하지 않습니다`);
  }
  const inputs = checkpoint.inputs.map((value, index) => {
    const row = object(value, `${pointer.path}.inputs[${index}]`);
    const input = {
      key: exactString(row.key, `${pointer.path}.inputs[${index}].key`, 100),
      choices: Array.isArray(row.choices)
        ? row.choices.map((choice, choiceIndex) => exactString(
            choice,
            `${pointer.path}.inputs[${index}].choices[${choiceIndex}]`,
            20_000
          ))
        : [],
      detailedExplanation: exactString(
        row.detailedExplanation,
        `${pointer.path}.inputs[${index}].detailedExplanation`,
        100_000
      ),
    };
    if (input.choices.length === 0 || canonicalEvidenceHash(row) !== canonicalEvidenceHash(input)) {
      throw new Error(`${pointer.path}.inputs[${index}]가 유효하지 않습니다`);
    }
    return input;
  });
  const inputHash = canonicalEvidenceHash(inputs);
  const effectiveSolutionCorpusHash = exactHash(
    checkpoint.effectiveSolutionCorpusHash,
    "persisted semantic checkpoint solution corpus hash"
  );
  const simplePath = `semantic-choice-checks/v${version}-${inputHash}.json`;
  const boundPath = `semantic-choice-checks/v${version}-${effectiveProblemCorpusHash}-` +
    `${effectiveSolutionCorpusHash}-${inputHash}.json`;
  if (pointer.path !== boundPath && (version === 5 || pointer.path !== simplePath)) {
    throw new Error(`${key} persisted semantic checkpoint path가 canonical하지 않습니다`);
  }
  const decisions = parseSemanticChoiceDecisions(checkpoint.items, inputs);
  const decision = decisions.find((candidate) => candidate.key === key);
  if (!decision || decisions.filter((candidate) => candidate.key === key).length !== 1) {
    throw new Error(`${key} persisted semantic decision이 유일하지 않습니다`);
  }
  const semanticDecision = object(rawDecision, "persisted semantic decision");
  const semanticDecisionHash = canonicalEvidenceHash(decision);
  const expectedCheckpoint = {
    version,
    entryId: entry.id,
    problemHash: problemEvidence.sha256,
    solutionHash: solutionEvidence.sha256,
    classifierVersion: checkpoint.classifierVersion,
    rulesDigest: CLASSIFIER_DIGEST,
    transcriptionGateVersion: checkpoint.transcriptionGateVersion,
    transcriptionPromptDigest: checkpoint.transcriptionPromptDigest,
    effectiveCorpusHash: effectiveProblemCorpusHash,
    effectiveSolutionCorpusHash,
    inputHash,
    promptDigest: sha256Text(`${version}\n${SEMANTIC_CHOICE_RULES}`),
    model: IMPORT_MODEL,
    reasoningEffort: IMPORT_REASONING_EFFORT,
    inputs,
    items: decisions,
  };
  const evidence = {
    kind: "semantic" as const,
    fidelityDecisionHash,
    semanticCheckpoint: pointer,
    semanticDecisionHash,
  };
  if (
    pointer.inputHash !== inputHash || pointer.effectiveCorpusHash !== effectiveProblemCorpusHash ||
    pointer.effectiveSolutionCorpusHash !== effectiveSolutionCorpusHash ||
    !historicalTranscriptionBinding(checkpoint) ||
    canonicalEvidenceHash(checkpoint) !== canonicalEvidenceHash(expectedCheckpoint) ||
    canonicalEvidenceHash(semanticDecision) !== semanticDecisionHash ||
    rawTrigger.semanticDecisionHash !== semanticDecisionHash ||
    canonicalEvidenceHash(rawTrigger) !== canonicalEvidenceHash(evidence)
  ) throw new Error(`${key} persisted semantic checkpoint/decision envelope가 다릅니다`);
  return {
    evidence,
    runtime: { kind: "semantic", semanticCheckpoint: pointer, semanticDecision: decision },
    diagnosticEvidence: decision.evidence,
  };
}

async function scanPersistedSolutionHistory(
  entry: CorpusManifestEntry,
  problemEvidence: PdfEvidence,
  evidence: PdfEvidence,
  stateDir: string,
  classified: ClassifiedQuestion[],
  baseSolutions: SolutionItem[],
  currentEffectiveProblemCorpusHash: string,
  allowCurrentPartial: boolean
): Promise<PersistedSolutionHistory> {
  const repairFiles = await readCanonicalSolutionArtifacts(
    stateDir,
    "solution-repairs",
    /^v1-\d{4}-\d{4}-[a-f0-9]{64}\.json$/u
  );
  const repairFidelityFiles = await readCanonicalSolutionArtifacts(
    stateDir,
    "solution-fidelity-repairs",
    /^v1-\d{4}-\d{4}-[a-f0-9]{64}-[a-f0-9]{64}\.json$/u
  );
  const revisionFiles = await readCanonicalSolutionArtifacts(
    stateDir,
    "solution-revisions",
    /^v1-\d{4}-\d{4}-[a-f0-9]{64}\.json$/u
  );
  const revisionFidelityFiles = await readCanonicalSolutionArtifacts(
    stateDir,
    "solution-fidelity-revisions",
    /^v1-\d{4}-\d{4}-[a-f0-9]{64}-[a-f0-9]{64}\.json$/u
  );
  const revisionFidelityAdjudicationFiles = await readCanonicalSolutionArtifacts(
    stateDir,
    "solution-fidelity-adjudications",
    /^v1-\d{4}-\d{4}-[a-f0-9]{64}\.json$/u
  );
  const promptUpgradeFiles = await readCanonicalSolutionArtifacts(
    stateDir,
    "solution-revision-upgrades",
    /^v1-\d{4}-\d{4}-[a-f0-9]{64}\.json$/u
  );
  const promptUpgradeFidelityFiles = await readCanonicalSolutionArtifacts(
    stateDir,
    "solution-fidelity-revision-upgrades",
    /^v1-\d{4}-\d{4}-[a-f0-9]{64}-[a-f0-9]{64}\.json$/u
  );
  const hasRevisionFidelityAdjudicationEvidence = existsSync(
    join(stateDir, "solution-fidelity-adjudication-evidence")
  ) && readdirSync(join(stateDir, "solution-fidelity-adjudication-evidence")).some((name) =>
    !name.endsWith(".tmp"));
  if (
    repairFiles.length + repairFidelityFiles.length + revisionFiles.length + revisionFidelityFiles.length +
      revisionFidelityAdjudicationFiles.length +
      promptUpgradeFiles.length + promptUpgradeFidelityFiles.length === 0 &&
    !hasRevisionFidelityAdjudicationEvidence
  ) return {
    stickyFirst: new Map(),
    revisionTriggers: new Map(),
    requiredRevisionKeys: new Set(),
    currentPartialKeys: new Set(),
  };

  const classifiedByNumber = new Map<number, ClassifiedQuestion>();
  for (const current of classified) {
    const number = numericPrintedLocator(current.question.number)!;
    if (classifiedByNumber.has(number)) throw new Error(`${number}번 current problem이 중복입니다`);
    classifiedByNumber.set(number, current);
  }
  const solutionsByNumber = new Map(baseSolutions.map((solution) => [numericPrintedLocator(solution.number)!, solution]));
  if (solutionsByNumber.size !== baseSolutions.length) throw new Error("base solution 번호가 중복입니다");
  const baseEvidenceByNumber = new Map<number, BaseSolutionEvidence>();
  const assignedRepairFidelity = new Set<string>();
  const assignedRevision = new Set<string>();
  const assignedRevisionFidelity = new Set<string>();
  const assignedRevisionFidelityAdjudication = new Set<string>();
  const assignedRevisionFidelityAdjudicationEvidence = new Set<string>();
  const assignedPromptUpgrade = new Set<string>();
  const assignedPromptUpgradeFidelity = new Set<string>();
  const generations = new Map<string, PersistedSolutionFirstAuthority>();
  const generationContexts = new Map<string, {
    input: SolutionFidelityInput;
    baseEvidence: BaseSolutionEvidence;
    repairFile: CanonicalSolutionArtifact;
    fidelityFile: CanonicalSolutionArtifact;
    firstDecision: SolutionFidelityDecision;
    repairedItem: SolutionItem;
    repairedItemHash: string;
  }>();
  const legacyPromptUpgradePredecessors = new Map<string, LegacySolutionRevisionPredecessor>();
  const partialCurrentKeys = new Set<string>();
  const partialRevisionTriggers = new Map<
    string,
    Exclude<SolutionRevisionTrigger, { kind: "fidelity" }>
  >();

  for (const repairFile of repairFiles) {
    const repair = repairFile.checkpoint;
    const match = /^solution-repairs\/v1-(\d{4})-(\d{4})-([a-f0-9]{64})\.json$/u.exec(
      repairFile.relativePath
    )!;
    const basePage = Number(match[1]);
    const printedNumber = Number(match[2]);
    const baseFidelitySha = match[3];
    const current = classifiedByNumber.get(printedNumber);
    const baseSolution = solutionsByNumber.get(printedNumber);
    if (!current || !baseSolution || questionKey(current.question) !== repair.key) {
      throw new Error(`${repairFile.relativePath}이 unknown/renumbered solution key를 가리킵니다`);
    }
    let baseEvidence = baseEvidenceByNumber.get(printedNumber);
    if (!baseEvidence) {
      baseEvidence = await baseSolutionEvidence(evidence, stateDir, baseSolution);
      baseEvidenceByNumber.set(printedNumber, baseEvidence);
    }
    const baseFidelityPointer = object(repair.baseFidelityCheckpoint, "persisted base fidelity pointer");
    const baseFidelityPath = exactString(baseFidelityPointer.path, "persisted base fidelity path", 500);
    const baseFidelityPointerSha = exactHash(baseFidelityPointer.sha256, "persisted base fidelity hash");
    if (baseFidelityPointerSha !== baseFidelitySha) {
      throw new Error(`${repairFile.relativePath} filename base fidelity hash가 다릅니다`);
    }
    const baseFidelityAbsolute = confinedStateFile(stateDir, baseFidelityPath, "persisted base fidelity");
    if (await sha256File(baseFidelityAbsolute) !== baseFidelityPointerSha) {
      throw new Error(`${repairFile.relativePath} base fidelity pointer hash가 다릅니다`);
    }
    const baseFidelity = object(JSON.parse(readFileSync(baseFidelityAbsolute, "utf8")), baseFidelityPath);
    const effectiveProblemCorpusHash = exactHash(
      repair.effectiveProblemCorpusHash,
      "persisted effective problem corpus hash"
    );
    const baseFidelityName = /^solution-fidelity\/v1-(\d{4})-([a-f0-9]{64})-([a-f0-9]{64})\.json$/u.exec(
      baseFidelityPath
    );
    const sliceIndex = baseFidelityName ? Number(baseFidelityName[1]) : -1;
    const expectedFrom = 1 + sliceIndex * SOLUTION_FIDELITY_SLICE_STRIDE;
    const expectedTo = Math.min(evidence.pageCount, expectedFrom + SOLUTION_FIDELITY_SLICE_PAGES - 1);
    const expectedOwnedTo = expectedTo === evidence.pageCount
      ? expectedTo
      : expectedFrom + SOLUTION_FIDELITY_SLICE_STRIDE - 1;
    const expectedBaseFidelityPath = baseFidelityName
      ? `solution-fidelity/v${SOLUTION_FIDELITY_VERSION}-${String(sliceIndex).padStart(4, "0")}-` +
        `${effectiveProblemCorpusHash}-${baseFidelity.inputHash}.json`
      : "";
    if (
      !baseFidelityName || baseFidelityPath !== expectedBaseFidelityPath ||
      baseFidelityName[2] !== effectiveProblemCorpusHash ||
      baseFidelityName[3] !== baseFidelity.inputHash ||
      baseFidelityPointerSha !== canonicalEvidenceHash(baseFidelity) ||
      baseFidelity.version !== SOLUTION_FIDELITY_VERSION || baseFidelity.entryId !== entry.id ||
      baseFidelity.sourceHash !== evidence.sha256 ||
      baseFidelity.from !== expectedFrom || baseFidelity.to !== expectedTo ||
      baseFidelity.ownedFrom !== expectedFrom || baseFidelity.ownedTo !== expectedOwnedTo ||
      baseFidelity.effectiveProblemCorpusHash !== effectiveProblemCorpusHash ||
      baseFidelity.promptDigest !== SOLUTION_FIDELITY_PROMPT_DIGEST ||
      baseFidelity.model !== IMPORT_MODEL || baseFidelity.reasoningEffort !== IMPORT_REASONING_EFFORT ||
      !historicalTranscriptionBinding(baseFidelity) || !Array.isArray(baseFidelity.inputs) ||
      baseFidelity.inputHash !== canonicalEvidenceHash(baseFidelity.inputs) ||
      !Array.isArray(baseFidelity.items)
    ) throw new Error(`${baseFidelityPath} persisted base fidelity 메타데이터가 다릅니다`);
    const baseInputs = baseFidelity.inputs as SolutionFidelityInput[];
    const input = baseInputs.find((candidate) => candidate.key === repair.key);
    if (!input || baseInputs.filter((candidate) => candidate.key === repair.key).length !== 1) {
      throw new Error(`${baseFidelityPath} persisted input key가 유일하지 않습니다`);
    }
    let allowDerivedMarkerAnswer = false;
    if (current.question.qtype === "mcq") {
      try {
        allowDerivedMarkerAnswer = resolveOfficialAnswer(current.question, baseSolution.answer).mode === "choice-marker";
      } catch (error) {
        if (!(error instanceof OfficialAnswerChoiceMismatchError)) throw error;
      }
    }
    const expectedBaseInput = {
      key: repair.key,
      printedNumber: String(printedNumber),
      qtype: current.question.qtype,
      allowDerivedMarkerAnswer,
      sourcePage: baseSolution.page,
      rawAnswer: baseSolution.answer,
      explanation: baseSolution.explanation,
      complete: true,
      baseSolutionCheckpoint: baseEvidence.checkpoint,
      baseSolutionItemHash: baseEvidence.itemHash,
      baseContextFrom: baseEvidence.contextFrom,
      baseContextTo: baseEvidence.contextTo,
      baseOwnedFrom: baseEvidence.ownedFrom,
      baseOwnedTo: baseEvidence.ownedTo,
    } satisfies SolutionFidelityInput;
    const decisions = parseSolutionFidelityDecisions(baseFidelity.items, baseInputs);
    const baseDecision = decisions.find((decision) => decision.key === repair.key)!;
    const from = Number(baseFidelity.from);
    const to = Number(baseFidelity.to);
    const ownedFrom = Number(baseFidelity.ownedFrom);
    const ownedTo = Number(baseFidelity.ownedTo);
    const expectedBaseFidelity = {
      version: SOLUTION_FIDELITY_VERSION,
      entryId: entry.id,
      sourceHash: evidence.sha256,
      from: expectedFrom,
      to: expectedTo,
      ownedFrom: expectedFrom,
      ownedTo: expectedOwnedTo,
      classifierVersion: baseFidelity.classifierVersion,
      rulesDigest: CLASSIFIER_DIGEST,
      transcriptionGateVersion: baseFidelity.transcriptionGateVersion,
      transcriptionPromptDigest: baseFidelity.transcriptionPromptDigest,
      effectiveProblemCorpusHash,
      inputHash: canonicalEvidenceHash(baseInputs),
      promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
      model: IMPORT_MODEL,
      reasoningEffort: IMPORT_REASONING_EFFORT,
      inputs: baseInputs,
      items: decisions,
    };
    if (
      canonicalEvidenceHash(baseFidelity) !== canonicalEvidenceHash(expectedBaseFidelity) ||
      canonicalEvidenceHash(input) !== canonicalEvidenceHash(expectedBaseInput) ||
      !Number.isInteger(from) || !Number.isInteger(to) || !Number.isInteger(ownedFrom) || !Number.isInteger(ownedTo) ||
      from < 1 || to < from || ownedFrom < from || ownedTo > to || input.sourcePage < ownedFrom ||
      input.sourcePage > ownedTo || terminalSolutionFidelity(input, baseSolution, baseDecision) &&
        input.baseContextTo <= to && repair.persistedSeed === undefined
    ) throw new Error(`${baseFidelityPath}은 genuine nonterminal base fidelity가 아닙니다`);
    if (
      repair.version !== SOLUTION_REPAIR_VERSION || repair.entryId !== entry.id || repair.key !== input.key ||
      repair.printedNumber !== input.printedNumber || repair.basePage !== basePage || basePage !== input.sourcePage ||
      repair.sourceHash !== evidence.sha256 || repair.contextFrom !== input.baseContextFrom ||
      repair.contextTo !== input.baseContextTo || repair.baseOwnedFrom !== input.baseOwnedFrom ||
      repair.baseOwnedTo !== input.baseOwnedTo ||
      canonicalEvidenceHash(repair.baseSolutionCheckpoint) !== canonicalEvidenceHash(baseEvidence.checkpoint) ||
      repair.baseSolutionItemHash !== baseEvidence.itemHash || repair.baseRawAnswerHash !== sha256Text(baseSolution.answer) ||
      repair.baseExplanationHash !== sha256Text(baseSolution.explanation) ||
      repair.promptVersion !== TARGETED_SOLUTION_TRANSCRIPTION_VERSION ||
      repair.promptDigest !== TARGETED_SOLUTION_PROMPT_DIGEST || repair.model !== IMPORT_MODEL ||
      repair.reasoningEffort !== IMPORT_REASONING_EFFORT
    ) throw new Error(`${repairFile.relativePath} persisted repair 메타데이터가 다릅니다`);
    const repairedItem = parseSolutionItems(JSON.stringify([repair.item]))[0];
    const repairedItemHash = canonicalEvidenceHash(repairedItem);
    if (
      numericPrintedLocator(repairedItem.number) !== printedNumber || repairedItem.page !== repair.effectivePage ||
      repairedItem.page < input.baseContextFrom || repairedItem.page > input.baseContextTo || repairedItem.complete !== true ||
      !repairedItem.answer.trim() || !repairedItem.explanation.trim()
    ) throw new Error(`${repairFile.relativePath} persisted repair item이 유효하지 않습니다`);
    const generationId = canonicalEvidenceHash({
      key: input.key,
      effectiveProblemCorpusHash,
      baseFidelityCheckpointSha256: baseFidelityPointerSha,
    });
    if (generations.has(generationId)) throw new Error(`${input.key} persisted solution generation이 중복입니다`);
    let seededFromGenerationId: string | undefined;
    let persistedSeed: Record<string, unknown> | undefined;
    if (repair.persistedSeed !== undefined) {
      const seed = object(repair.persistedSeed, "persisted repair seed");
      persistedSeed = seed;
      seededFromGenerationId = exactHash(seed.generationId, "persisted repair seed generation");
      if (
        seed.version !== PERSISTED_SOLUTION_REPAIR_SEED_VERSION ||
        exactHash(seed.effectiveProblemCorpusHash, "persisted repair seed corpus hash") === effectiveProblemCorpusHash ||
        seed.repairedItemHash !== repairedItemHash
      ) throw new Error(`${repairFile.relativePath} persisted repair seed 메타데이터가 다릅니다`);
      for (const [label, rawPointer] of [
        ["persisted seed base fidelity", seed.baseFidelityCheckpoint],
        ["persisted seed repair", seed.repairArtifact],
        ["persisted seed repair fidelity", seed.repairFidelityArtifact],
      ] as const) {
        const pointer = object(rawPointer, label);
        const path = confinedStateFile(stateDir, exactString(pointer.path, `${label} path`, 500), label);
        if (await sha256File(path) !== exactHash(pointer.sha256, `${label} hash`)) {
          throw new Error(`${repairFile.relativePath} ${label} hash가 다릅니다`);
        }
      }
    }
    const expectedRepair = {
      version: SOLUTION_REPAIR_VERSION,
      entryId: entry.id,
      key: input.key,
      printedNumber: input.printedNumber,
      basePage,
      contextFrom: input.baseContextFrom,
      contextTo: input.baseContextTo,
      baseOwnedFrom: input.baseOwnedFrom,
      baseOwnedTo: input.baseOwnedTo,
      sourceHash: evidence.sha256,
      effectiveProblemCorpusHash,
      baseSolutionCheckpoint: baseEvidence.checkpoint,
      baseFidelityCheckpoint: { path: baseFidelityPath, sha256: baseFidelityPointerSha },
      baseSolutionItemHash: baseEvidence.itemHash,
      baseRawAnswerHash: sha256Text(baseSolution.answer),
      baseExplanationHash: sha256Text(baseSolution.explanation),
      promptVersion: TARGETED_SOLUTION_TRANSCRIPTION_VERSION,
      promptDigest: TARGETED_SOLUTION_PROMPT_DIGEST,
      model: IMPORT_MODEL,
      reasoningEffort: IMPORT_REASONING_EFFORT,
      ...(persistedSeed ? { persistedSeed } : {}),
      effectivePage: repairedItem.page,
      item: repairedItem,
    };
    if (canonicalEvidenceHash(repair) !== canonicalEvidenceHash(expectedRepair)) {
      throw new Error(`${repairFile.relativePath} persisted repair envelope가 다릅니다`);
    }
    const fidelityChildren = repairFidelityFiles.filter((candidate) =>
      object(candidate.checkpoint.repairArtifact, "persisted repair fidelity parent").path === repairFile.relativePath
    );
    if (fidelityChildren.length === 0) {
      if (!allowCurrentPartial || effectiveProblemCorpusHash !== currentEffectiveProblemCorpusHash) {
        throw new Error(`${repairFile.relativePath} persisted repair fidelity child가 없습니다`);
      }
      partialCurrentKeys.add(input.key);
      continue;
    }
    if (fidelityChildren.length !== 1) throw new Error(`${repairFile.relativePath} repair fidelity child가 중복입니다`);
    const fidelityFile = fidelityChildren[0];
    assignedRepairFidelity.add(fidelityFile.relativePath);
    const fidelity = fidelityFile.checkpoint;
    const repairedInput: SolutionFidelityInput = {
      ...input,
      sourcePage: repairedItem.page,
      rawAnswer: repairedItem.answer,
      explanation: repairedItem.explanation,
    };
    const repairedInputHash = canonicalEvidenceHash(repairedInput);
    const expectedFidelityPath = `solution-fidelity-repairs/v${SOLUTION_REPAIR_FIDELITY_VERSION}-` +
      `${String(basePage).padStart(4, "0")}-${String(printedNumber).padStart(4, "0")}-` +
      `${baseFidelityPointerSha}-${repairedItemHash}.json`;
    if (
      fidelityFile.relativePath !== expectedFidelityPath || fidelity.version !== SOLUTION_REPAIR_FIDELITY_VERSION ||
      fidelity.entryId !== entry.id || fidelity.key !== input.key || fidelity.sourceHash !== evidence.sha256 ||
      fidelity.from !== input.baseContextFrom || fidelity.to !== input.baseContextTo || fidelity.basePage !== basePage ||
      fidelity.effectivePage !== repairedItem.page || fidelity.baseOwnedFrom !== input.baseOwnedFrom ||
      fidelity.baseOwnedTo !== input.baseOwnedTo ||
      fidelity.effectiveProblemCorpusHash !== effectiveProblemCorpusHash ||
      canonicalEvidenceHash(fidelity.baseSolutionCheckpoint) !== canonicalEvidenceHash(baseEvidence.checkpoint) ||
      canonicalEvidenceHash(fidelity.baseFidelityCheckpoint) !== canonicalEvidenceHash({
        path: baseFidelityPath,
        sha256: baseFidelityPointerSha,
      }) || canonicalEvidenceHash(fidelity.repairArtifact) !== canonicalEvidenceHash({
        path: repairFile.relativePath,
        sha256: repairFile.sha256,
      }) || fidelity.effectiveSolutionItemHash !== repairedItemHash || fidelity.inputHash !== repairedInputHash ||
      fidelity.promptDigest !== SOLUTION_FIDELITY_PROMPT_DIGEST || fidelity.model !== IMPORT_MODEL ||
      fidelity.reasoningEffort !== IMPORT_REASONING_EFFORT ||
      canonicalEvidenceHash(fidelity.input) !== canonicalEvidenceHash(repairedInput)
    ) throw new Error(`기존 repair 해설 fidelity 메타데이터가 다릅니다: ${fidelityFile.relativePath}`);
    const firstDecision = parseSolutionFidelityDecisions([fidelity.item], [repairedInput])[0];
    const expectedFidelity = {
      version: SOLUTION_REPAIR_FIDELITY_VERSION,
      entryId: entry.id,
      key: input.key,
      sourceHash: evidence.sha256,
      from: input.baseContextFrom,
      to: input.baseContextTo,
      basePage,
      effectivePage: repairedItem.page,
      baseOwnedFrom: input.baseOwnedFrom,
      baseOwnedTo: input.baseOwnedTo,
      effectiveProblemCorpusHash,
      baseSolutionCheckpoint: baseEvidence.checkpoint,
      baseFidelityCheckpoint: { path: baseFidelityPath, sha256: baseFidelityPointerSha },
      repairArtifact: { path: repairFile.relativePath, sha256: repairFile.sha256 },
      effectiveSolutionItemHash: repairedItemHash,
      inputHash: repairedInputHash,
      promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
      model: IMPORT_MODEL,
      reasoningEffort: IMPORT_REASONING_EFFORT,
      input: repairedInput,
      item: firstDecision,
    };
    if (canonicalEvidenceHash(fidelity) !== canonicalEvidenceHash(expectedFidelity)) {
      throw new Error(`${fidelityFile.relativePath} persisted repair fidelity envelope가 다릅니다`);
    }
    const firstTerminal = terminalSolutionFidelity(repairedInput, repairedItem, firstDecision);
    const revisionChildren = revisionFiles.filter((candidate) =>
      object(candidate.checkpoint.baseRepairArtifact, "persisted revision parent").path === repairFile.relativePath
    );
    if (revisionChildren.length > 1) throw new Error(`${repairFile.relativePath} persisted revision child가 중복입니다`);
    if (!firstTerminal && revisionChildren.length !== 1) {
      if (!allowCurrentPartial || effectiveProblemCorpusHash !== currentEffectiveProblemCorpusHash) {
        throw new Error(`${repairFile.relativePath} nonterminal repair에 revision이 없습니다`);
      }
      partialCurrentKeys.add(input.key);
      continue;
    }
    let revisionAuthority: PersistedSolutionRevisionAuthority | undefined;
    let revisionTrigger: SolutionRevisionTrigger | undefined;
    if (revisionChildren.length === 1) {
      const revisionFile = revisionChildren[0];
      assignedRevision.add(revisionFile.relativePath);
      const revision = revisionFile.checkpoint;
      const trigger = object(revision.trigger, "persisted revision trigger");
      const diagnosticDecisionHash = canonicalEvidenceHash(firstDecision);
      let triggerEvidence: SolutionRevisionEvidence["trigger"];
      let diagnosticEvidence: string;
      if (trigger.kind === "fidelity") {
        if (firstTerminal) throw new Error(`${revisionFile.relativePath} terminal repair가 fidelity revision을 가리킵니다`);
        triggerEvidence = { kind: "fidelity", fidelityDecisionHash: diagnosticDecisionHash };
        revisionTrigger = { kind: "fidelity" };
        diagnosticEvidence = firstDecision.evidence;
      } else if (trigger.kind === "semantic") {
        if (!firstTerminal) throw new Error(`${revisionFile.relativePath} nonterminal repair가 semantic revision을 가리킵니다`);
        const semantic = await persistedSemanticRevisionTrigger(
          entry,
          problemEvidence,
          evidence,
          stateDir,
          effectiveProblemCorpusHash,
          input.key,
          diagnosticDecisionHash,
          trigger,
          revision.semanticDecision
        );
        triggerEvidence = semantic.evidence;
        revisionTrigger = semantic.runtime;
        diagnosticEvidence = semantic.diagnosticEvidence;
      } else if (trigger.kind === "persisted") {
        if (trigger.persistedTriggerVersion !== PERSISTED_SOLUTION_REVISION_TRIGGER_VERSION) {
          throw new Error(`${revisionFile.relativePath} persisted revision trigger version이 다릅니다`);
        }
        const predecessor = persistedRevisionAuthority(
          trigger.predecessor,
          `${revisionFile.relativePath}.trigger.predecessor`
        );
        triggerEvidence = {
          kind: "persisted",
          fidelityDecisionHash: diagnosticDecisionHash,
          persistedTriggerVersion: PERSISTED_SOLUTION_REVISION_TRIGGER_VERSION,
          predecessor,
        };
        revisionTrigger = { kind: "persisted", authority: predecessor };
        diagnosticEvidence = predecessor.diagnosticEvidence;
      } else {
        throw new Error(`${revisionFile.relativePath} persisted revision trigger kind가 유효하지 않습니다`);
      }
      if (
        trigger.fidelityDecisionHash !== diagnosticDecisionHash ||
        canonicalEvidenceHash(trigger) !== canonicalEvidenceHash(triggerEvidence)
      ) throw new Error(`${revisionFile.relativePath} persisted revision trigger가 다릅니다`);
      const revisedItem = parseSolutionItems(JSON.stringify([revision.item]))[0];
      const revisedItemHash = canonicalEvidenceHash(revisedItem);
      if (
        numericPrintedLocator(revisedItem.number) !== printedNumber || revisedItem.page !== revision.effectivePage ||
        revisedItem.page < input.baseContextFrom || revisedItem.page > input.baseContextTo || revisedItem.complete !== true ||
        !revisedItem.answer.trim() || !revisedItem.explanation.trim()
      ) throw new Error(`${revisionFile.relativePath} persisted revision item이 유효하지 않습니다`);
      const baseRepairFidelityArtifact = {
        path: fidelityFile.relativePath,
        sha256: fidelityFile.sha256,
        promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
      };
      const legacyPromptUpgradeSpec = SOLUTION_PROMPT_UPGRADE_ALLOWLIST.find((candidate) =>
        candidate.entryId === entry.id && candidate.key === input.key && candidate.sourceHash === evidence.sha256 &&
        candidate.legacyRevisionArtifactHash === revisionFile.sha256 &&
        revision.promptVersion === candidate.legacyPromptVersion &&
        revision.promptDigest === candidate.legacyPromptDigest
      );
      const revisionPromptVersion = legacyPromptUpgradeSpec?.legacyPromptVersion ??
        TARGETED_SOLUTION_REVISION_VERSION;
      const revisionPromptDigest = legacyPromptUpgradeSpec?.legacyPromptDigest ??
        TARGETED_SOLUTION_REVISION_PROMPT_DIGEST;
      const revisionBasisHash = canonicalEvidenceHash({
        key: input.key,
        sourceHash: evidence.sha256,
        basePage: input.sourcePage,
        contextFrom: input.baseContextFrom,
        contextTo: input.baseContextTo,
        baseSolutionCheckpoint: baseEvidence.checkpoint,
        baseSolutionItemHash: baseEvidence.itemHash,
        baseRepairArtifact: { path: repairFile.relativePath, sha256: repairFile.sha256 },
        baseRepairFidelityArtifact,
        baseRepairSolutionItemHash: repairedItemHash,
        trigger: triggerEvidence,
        revisionPromptDigest,
      });
      const expectedRevisionPath = `solution-revisions/v${SOLUTION_REVISION_VERSION}-` +
        `${String(repairedItem.page).padStart(4, "0")}-${String(printedNumber).padStart(4, "0")}-` +
        `${revisionBasisHash}.json`;
      const expectedRevision = {
        version: SOLUTION_REVISION_VERSION,
        entryId: entry.id,
        key: input.key,
        printedNumber: input.printedNumber,
        sourceHash: evidence.sha256,
        basePage: input.sourcePage,
        contextFrom: input.baseContextFrom,
        contextTo: input.baseContextTo,
        baseOwnedFrom: input.baseOwnedFrom,
        baseOwnedTo: input.baseOwnedTo,
        effectiveProblemCorpusHash,
        baseSolutionCheckpoint: baseEvidence.checkpoint,
        baseSolutionItemHash: baseEvidence.itemHash,
        baseRepairArtifact: { path: repairFile.relativePath, sha256: repairFile.sha256 },
        baseRepairFidelityArtifact,
        baseRepairPage: repairedItem.page,
        baseRepairSolutionItemHash: repairedItemHash,
        trigger: triggerEvidence,
        diagnosticDecision: firstDecision,
        diagnosticDecisionHash,
        ...(trigger.kind === "semantic"
          ? { semanticDecision: (revisionTrigger as Extract<SolutionRevisionTrigger, { kind: "semantic" }>).semanticDecision }
          : {}),
        promptVersion: revisionPromptVersion,
        promptDigest: revisionPromptDigest,
        model: IMPORT_MODEL,
        reasoningEffort: IMPORT_REASONING_EFFORT,
        effectivePage: revisedItem.page,
        item: revisedItem,
      };
      if (
        revisionFile.relativePath !== expectedRevisionPath ||
        canonicalEvidenceHash(revision) !== canonicalEvidenceHash(expectedRevision)
      ) throw new Error(`기존 solution revision 체크포인트 메타데이터가 다릅니다: ${revisionFile.relativePath}`);
      const revisionFidelityChildren = revisionFidelityFiles.filter((candidate) =>
        object(candidate.checkpoint.revisionArtifact, "persisted revision fidelity parent").path ===
          revisionFile.relativePath
      );
      if (revisionFidelityChildren.length !== 1) {
        if (!allowCurrentPartial || effectiveProblemCorpusHash !== currentEffectiveProblemCorpusHash ||
            revisionFidelityChildren.length > 1) {
          throw new Error(`${revisionFile.relativePath} revision fidelity child coverage가 다릅니다`);
        }
        partialCurrentKeys.add(input.key);
        if (revisionTrigger?.kind === "semantic" || revisionTrigger?.kind === "persisted") {
          const prior = partialRevisionTriggers.get(input.key);
          if (prior && canonicalEvidenceHash(prior) !== canonicalEvidenceHash(revisionTrigger)) {
            throw new Error(`${input.key} partial solution revision trigger가 충돌합니다`);
          }
          partialRevisionTriggers.set(input.key, revisionTrigger);
        }
        continue;
      }
      const revisionFidelityFile = revisionFidelityChildren[0];
      assignedRevisionFidelity.add(revisionFidelityFile.relativePath);
      const revisionFidelity = revisionFidelityFile.checkpoint;
      const revisedInput: SolutionFidelityInput = {
        ...input,
        sourcePage: revisedItem.page,
        rawAnswer: revisedItem.answer,
        explanation: revisedItem.explanation,
      };
      const revisedInputHash = canonicalEvidenceHash(revisedInput);
      const expectedRevisionFidelityPath = `solution-fidelity-revisions/v${SOLUTION_REVISION_FIDELITY_VERSION}-` +
        `${String(repairedItem.page).padStart(4, "0")}-${String(printedNumber).padStart(4, "0")}-` +
        `${revisionFile.sha256}-${revisedItemHash}.json`;
      const finalDecision = parseSolutionFidelityDecisions([revisionFidelity.item], [revisedInput])[0];
      const expectedRevisionFidelity = {
        version: SOLUTION_REVISION_FIDELITY_VERSION,
        entryId: entry.id,
        key: input.key,
        sourceHash: evidence.sha256,
        from: input.baseContextFrom,
        to: input.baseContextTo,
        basePage: input.sourcePage,
        baseRepairPage: repairedItem.page,
        effectivePage: revisedItem.page,
        baseOwnedFrom: input.baseOwnedFrom,
        baseOwnedTo: input.baseOwnedTo,
        effectiveProblemCorpusHash,
        baseSolutionCheckpoint: baseEvidence.checkpoint,
        baseSolutionItemHash: baseEvidence.itemHash,
        baseRepairArtifact: { path: repairFile.relativePath, sha256: repairFile.sha256 },
        baseRepairFidelityArtifact,
        baseRepairSolutionItemHash: repairedItemHash,
        diagnosticDecisionHash,
        trigger: triggerEvidence,
        revisionArtifact: { path: revisionFile.relativePath, sha256: revisionFile.sha256 },
        effectiveSolutionItemHash: revisedItemHash,
        inputHash: revisedInputHash,
        promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
        model: IMPORT_MODEL,
        reasoningEffort: IMPORT_REASONING_EFFORT,
        input: revisedInput,
        item: finalDecision,
      };
      if (
        revisionFidelityFile.relativePath !== expectedRevisionFidelityPath ||
        canonicalEvidenceHash(revisionFidelity) !== canonicalEvidenceHash(expectedRevisionFidelity)
      ) throw new Error(`${revisionFidelityFile.relativePath} persisted revision fidelity 메타데이터가 다릅니다`);
      if (!terminalSolutionFidelity(revisedInput, revisedItem, finalDecision)) {
        const failedFidelityArtifact = {
          path: revisionFidelityFile.relativePath,
          sha256: revisionFidelityFile.sha256,
          promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
        };
        const adjudicationSpec = solutionRevisionFidelityAdjudicationSpec(
          entry,
          evidence,
          input.key,
          revisionFile.sha256,
          revisionFidelityFile.sha256,
          revisedItemHash,
          finalDecision
        );
        if (adjudicationSpec) {
          const adjudicationChildren = revisionFidelityAdjudicationFiles.filter((candidate) => {
            const basis = object(candidate.checkpoint.basis, `${candidate.relativePath}.basis`);
            return object(
              basis.revisionArtifact,
              `${candidate.relativePath}.basis.revisionArtifact`
            ).path === revisionFile.relativePath;
          });
          if (adjudicationChildren.length === 0) {
            if (!allowCurrentPartial || effectiveProblemCorpusHash !== currentEffectiveProblemCorpusHash) {
              throw new Error(`${revisionFile.relativePath} solution fidelity adjudication child가 없습니다`);
            }
            const cropSpec: ProblemCropAdjudicationSpec = {
              allowlistId: adjudicationSpec.allowlistId,
              entryId: adjudicationSpec.entryId,
              key: adjudicationSpec.key,
              sourcePage: adjudicationSpec.sourcePage,
              sourceHash: adjudicationSpec.sourceHash,
              views: adjudicationSpec.views.map((view) => ({ ...view, rect: [...view.rect] })),
              requiredTokens: [...adjudicationSpec.requiredTokens],
            };
            const prepared = await prepareProblemCropEvidence(entry, evidence, stateDir, cropSpec, {
              namespace: "solution-fidelity-adjudication-evidence",
              version: SOLUTION_REVISION_FIDELITY_ADJUDICATION_VERSION,
              dpi: adjudicationSpec.dpi,
            });
            for (const path of [
              prepared.artifact.path,
              prepared.pdf.path,
              ...prepared.views.map((view) => view.artifact.path),
            ]) assignedRevisionFidelityAdjudicationEvidence.add(path);
            partialCurrentKeys.add(input.key);
            continue;
          }
          if (adjudicationChildren.length !== 1) {
            throw new Error(`${revisionFile.relativePath} solution fidelity adjudication child가 중복입니다`);
          }
          const adjudicated = await validatePersistedSolutionRevisionFidelityAdjudication(
            entry,
            evidence,
            stateDir,
            effectiveProblemCorpusHash,
            revisedInput,
            revisedItem,
            { path: revisionFile.relativePath, sha256: revisionFile.sha256 },
            failedFidelityArtifact,
            finalDecision,
            revisionFidelityAdjudicationFiles
          );
          assignedRevisionFidelityAdjudication.add(adjudicated.childPath);
          for (const path of adjudicated.evidencePaths) {
            if (assignedRevisionFidelityAdjudicationEvidence.has(path)) {
              throw new Error(`${input.key} solution fidelity adjudication evidence가 중복입니다`);
            }
            assignedRevisionFidelityAdjudicationEvidence.add(path);
          }
          revisionAuthority = {
            generationId,
            key: input.key,
            repairArtifact: { path: repairFile.relativePath, sha256: repairFile.sha256 },
            repairFidelityArtifact: { path: fidelityFile.relativePath, sha256: fidelityFile.sha256 },
            revisionArtifact: { path: revisionFile.relativePath, sha256: revisionFile.sha256 },
            revisionFidelityArtifact: {
              path: revisionFidelityFile.relativePath,
              sha256: revisionFidelityFile.sha256,
            },
            finalSolutionItemHash: revisedItemHash,
            diagnosticDecisionHash,
            diagnosticEvidence,
            fidelityAdjudication: adjudicated.evidence,
          };
        } else {
          if (
            !legacyPromptUpgradeSpec ||
            revisionFidelityFile.sha256 !== legacyPromptUpgradeSpec.legacyRevisionFidelityArtifactHash ||
            finalDecision.answerStatus !== "mismatch" || finalDecision.explanationStatus !== "exact" ||
            finalDecision.sourcePage !== revisedItem.page
          ) throw new Error(`${revisionFidelityFile.relativePath} persisted revision이 terminal이 아닙니다`);
          const predecessor: LegacySolutionRevisionPredecessor = {
            allowlistId: legacyPromptUpgradeSpec.allowlistId,
            generationId,
            key: input.key,
            effectiveProblemCorpusHash,
            repairArtifact: { path: repairFile.relativePath, sha256: repairFile.sha256 },
            repairFidelityArtifact: { path: fidelityFile.relativePath, sha256: fidelityFile.sha256 },
            revisionArtifact: {
              path: revisionFile.relativePath,
              sha256: revisionFile.sha256,
              promptVersion: legacyPromptUpgradeSpec.legacyPromptVersion,
              promptDigest: legacyPromptUpgradeSpec.legacyPromptDigest,
            },
            revisionFidelityArtifact: {
              path: revisionFidelityFile.relativePath,
              sha256: revisionFidelityFile.sha256,
            },
            revisionSolutionItemHash: revisedItemHash,
            failedDecisionHash: canonicalEvidenceHash(finalDecision),
            failedEvidenceHash: sha256Text(finalDecision.evidence),
            failedEvidence: finalDecision.evidence,
          };
          if (legacyPromptUpgradePredecessors.has(revisionFile.relativePath)) {
            throw new Error(`${input.key} legacy solution revision predecessor가 중복입니다`);
          }
          legacyPromptUpgradePredecessors.set(revisionFile.relativePath, predecessor);
        }
      } else {
        if (legacyPromptUpgradeSpec) {
          throw new Error(`${revisionFidelityFile.relativePath} legacy prompt v1 revision을 terminal로 승격할 수 없습니다`);
        }
        revisionAuthority = {
          generationId,
          key: input.key,
          repairArtifact: { path: repairFile.relativePath, sha256: repairFile.sha256 },
          repairFidelityArtifact: { path: fidelityFile.relativePath, sha256: fidelityFile.sha256 },
          revisionArtifact: { path: revisionFile.relativePath, sha256: revisionFile.sha256 },
          revisionFidelityArtifact: {
            path: revisionFidelityFile.relativePath,
            sha256: revisionFidelityFile.sha256,
          },
          finalSolutionItemHash: revisedItemHash,
          diagnosticDecisionHash,
          diagnosticEvidence,
        };
      }
    } else if (!firstTerminal) {
      throw new Error(`${fidelityFile.relativePath} persisted first repair가 terminal이 아닙니다`);
    }
    const generation: PersistedSolutionFirstAuthority = {
      generationId,
      key: input.key,
      effectiveProblemCorpusHash,
      baseFidelityCheckpoint: { path: baseFidelityPath, sha256: baseFidelityPointerSha },
      repairArtifact: { path: repairFile.relativePath, sha256: repairFile.sha256 },
      repairFidelityArtifact: { path: fidelityFile.relativePath, sha256: fidelityFile.sha256 },
      repairedItem,
      repairedItemHash,
      ...(seededFromGenerationId ? { seededFromGenerationId } : {}),
      ...(persistedSeed ? { persistedSeed } : {}),
      revision: revisionAuthority,
      revisionTrigger,
    };
    generations.set(generationId, generation);
    generationContexts.set(generationId, {
      input,
      baseEvidence,
      repairFile,
      fidelityFile,
      firstDecision,
      repairedItem,
      repairedItemHash,
    });
  }
  const usedLegacyPromptUpgradePredecessors = new Set<string>();
  const generationByRepairPath = new Map(
    [...generationContexts.entries()].map(([generationId, context]) => [
      context.repairFile.relativePath,
      { generationId, context, generation: generations.get(generationId)! },
    ] as const)
  );
  for (const upgradeFile of promptUpgradeFiles) {
    const upgrade = upgradeFile.checkpoint;
    const baseRepairPointer = object(upgrade.baseRepairArtifact, "prompt upgrade base repair pointer");
    const parent = generationByRepairPath.get(exactString(
      baseRepairPointer.path,
      "prompt upgrade base repair path",
      500
    ));
    if (!parent) throw new Error(`${upgradeFile.relativePath} prompt upgrade parent가 없습니다`);
    const { generationId, context, generation } = parent;
    const { input, baseEvidence, repairFile, fidelityFile, firstDecision, repairedItem, repairedItemHash } = context;
    if (generation.revision) throw new Error(`${input.key} solution revision authority가 중복입니다`);
    const rawTrigger = object(upgrade.trigger, `${upgradeFile.relativePath}.trigger`);
    const predecessor = legacySolutionRevisionPredecessor(
      rawTrigger.legacyPredecessor,
      `${upgradeFile.relativePath}.trigger.legacyPredecessor`
    );
    const registeredPredecessor = legacyPromptUpgradePredecessors.get(predecessor.revisionArtifact.path);
    if (
      !registeredPredecessor ||
      canonicalEvidenceHash(registeredPredecessor) !== canonicalEvidenceHash(predecessor) ||
      usedLegacyPromptUpgradePredecessors.has(predecessor.revisionArtifact.path)
    ) throw new Error(`${upgradeFile.relativePath} legacy prompt predecessor가 유효하지 않습니다`);
    const spec = SOLUTION_PROMPT_UPGRADE_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === predecessor.allowlistId && candidate.entryId === entry.id &&
      candidate.key === input.key && candidate.sourceHash === evidence.sha256 &&
      candidate.legacyRevisionArtifactHash === predecessor.revisionArtifact.sha256 &&
      candidate.legacyRevisionFidelityArtifactHash === predecessor.revisionFidelityArtifact.sha256
    );
    if (!spec) throw new Error(`${upgradeFile.relativePath} prompt upgrade allowlist가 다릅니다`);
    const diagnosticDecisionHash = canonicalEvidenceHash(firstDecision);
    const triggerEvidence: SolutionRevisionEvidence["trigger"] = {
      kind: "prompt-upgrade",
      fidelityDecisionHash: diagnosticDecisionHash,
      promptUpgradeVersion: SOLUTION_PROMPT_UPGRADE_VERSION,
      legacyPredecessor: predecessor,
    };
    const revisedItem = parseSolutionItems(JSON.stringify([upgrade.item]))[0];
    const revisedItemHash = canonicalEvidenceHash(revisedItem);
    const baseRepairFidelityArtifact = {
      path: fidelityFile.relativePath,
      sha256: fidelityFile.sha256,
      promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
    };
    const revisionBasisHash = canonicalEvidenceHash({
      key: input.key,
      sourceHash: evidence.sha256,
      basePage: input.sourcePage,
      contextFrom: input.baseContextFrom,
      contextTo: input.baseContextTo,
      baseSolutionCheckpoint: baseEvidence.checkpoint,
      baseSolutionItemHash: baseEvidence.itemHash,
      baseRepairArtifact: { path: repairFile.relativePath, sha256: repairFile.sha256 },
      baseRepairFidelityArtifact,
      baseRepairSolutionItemHash: repairedItemHash,
      trigger: triggerEvidence,
      revisionPromptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
    });
    const expectedUpgradePath = `solution-revision-upgrades/v${SOLUTION_PROMPT_UPGRADE_VERSION}-` +
      `${String(repairedItem.page).padStart(4, "0")}-${String(input.printedNumber).padStart(4, "0")}-` +
      `${revisionBasisHash}.json`;
    const expectedUpgrade = {
      version: SOLUTION_PROMPT_UPGRADE_VERSION,
      entryId: entry.id,
      key: input.key,
      printedNumber: input.printedNumber,
      sourceHash: evidence.sha256,
      basePage: input.sourcePage,
      contextFrom: input.baseContextFrom,
      contextTo: input.baseContextTo,
      baseOwnedFrom: input.baseOwnedFrom,
      baseOwnedTo: input.baseOwnedTo,
      effectiveProblemCorpusHash: generation.effectiveProblemCorpusHash,
      baseSolutionCheckpoint: baseEvidence.checkpoint,
      baseSolutionItemHash: baseEvidence.itemHash,
      baseRepairArtifact: { path: repairFile.relativePath, sha256: repairFile.sha256 },
      baseRepairFidelityArtifact,
      baseRepairPage: repairedItem.page,
      baseRepairSolutionItemHash: repairedItemHash,
      trigger: triggerEvidence,
      diagnosticDecision: firstDecision,
      diagnosticDecisionHash,
      promptVersion: TARGETED_SOLUTION_REVISION_VERSION,
      promptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
      model: IMPORT_MODEL,
      reasoningEffort: IMPORT_REASONING_EFFORT,
      effectivePage: revisedItem.page,
      item: revisedItem,
    };
    if (
      upgradeFile.relativePath !== expectedUpgradePath ||
      numericPrintedLocator(revisedItem.number) !== Number(input.printedNumber) ||
      revisedItem.page !== upgrade.effectivePage || revisedItem.page < input.baseContextFrom ||
      revisedItem.page > input.baseContextTo || revisedItem.complete !== true ||
      revisedItem.answer !== spec.expectedAnswer ||
      !revisedItem.answer.trim() || !revisedItem.explanation.trim() ||
      canonicalEvidenceHash(upgrade) !== canonicalEvidenceHash(expectedUpgrade)
    ) throw new Error(`${upgradeFile.relativePath} solution prompt upgrade가 유효하지 않습니다`);
    assignedPromptUpgrade.add(upgradeFile.relativePath);
    usedLegacyPromptUpgradePredecessors.add(predecessor.revisionArtifact.path);
    const fidelityChildren = promptUpgradeFidelityFiles.filter((candidate) =>
      object(candidate.checkpoint.revisionArtifact, "prompt upgrade fidelity parent").path ===
        upgradeFile.relativePath
    );
    if (fidelityChildren.length !== 1) {
      if (
        fidelityChildren.length > 1 || !allowCurrentPartial ||
        generation.effectiveProblemCorpusHash !== currentEffectiveProblemCorpusHash
      ) throw new Error(`${upgradeFile.relativePath} prompt upgrade fidelity child coverage가 다릅니다`);
      partialCurrentKeys.add(input.key);
      const trigger: Extract<SolutionRevisionTrigger, { kind: "prompt-upgrade" }> = {
        kind: "prompt-upgrade",
        predecessor,
      };
      const prior = partialRevisionTriggers.get(input.key);
      if (prior && canonicalEvidenceHash(prior) !== canonicalEvidenceHash(trigger)) {
        throw new Error(`${input.key} partial solution prompt upgrade trigger가 충돌합니다`);
      }
      partialRevisionTriggers.set(input.key, trigger);
      continue;
    }
    const upgradeFidelityFile = fidelityChildren[0];
    assignedPromptUpgradeFidelity.add(upgradeFidelityFile.relativePath);
    const fidelity = upgradeFidelityFile.checkpoint;
    const revisedInput: SolutionFidelityInput = {
      ...input,
      sourcePage: revisedItem.page,
      rawAnswer: revisedItem.answer,
      explanation: revisedItem.explanation,
    };
    const inputHash = canonicalEvidenceHash(revisedInput);
    const finalDecision = parseSolutionFidelityDecisions([fidelity.item], [revisedInput])[0];
    const expectedFidelityPath =
      `solution-fidelity-revision-upgrades/v${SOLUTION_PROMPT_UPGRADE_FIDELITY_VERSION}-` +
      `${String(repairedItem.page).padStart(4, "0")}-${String(input.printedNumber).padStart(4, "0")}-` +
      `${upgradeFile.sha256}-${revisedItemHash}.json`;
    const expectedFidelity = {
      version: SOLUTION_PROMPT_UPGRADE_FIDELITY_VERSION,
      entryId: entry.id,
      key: input.key,
      sourceHash: evidence.sha256,
      from: input.baseContextFrom,
      to: input.baseContextTo,
      basePage: input.sourcePage,
      baseRepairPage: repairedItem.page,
      effectivePage: revisedItem.page,
      baseOwnedFrom: input.baseOwnedFrom,
      baseOwnedTo: input.baseOwnedTo,
      effectiveProblemCorpusHash: generation.effectiveProblemCorpusHash,
      baseSolutionCheckpoint: baseEvidence.checkpoint,
      baseSolutionItemHash: baseEvidence.itemHash,
      baseRepairArtifact: { path: repairFile.relativePath, sha256: repairFile.sha256 },
      baseRepairFidelityArtifact,
      baseRepairSolutionItemHash: repairedItemHash,
      diagnosticDecisionHash,
      trigger: triggerEvidence,
      revisionArtifact: { path: upgradeFile.relativePath, sha256: upgradeFile.sha256 },
      effectiveSolutionItemHash: revisedItemHash,
      inputHash,
      promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
      model: IMPORT_MODEL,
      reasoningEffort: IMPORT_REASONING_EFFORT,
      input: revisedInput,
      item: finalDecision,
    };
    if (
      upgradeFidelityFile.relativePath !== expectedFidelityPath ||
      canonicalEvidenceHash(fidelity) !== canonicalEvidenceHash(expectedFidelity) ||
      finalDecision.sourcePage !== revisedItem.page || finalDecision.answerStatus !== "exact" ||
      finalDecision.explanationStatus !== "exact"
    ) throw new Error(`${upgradeFidelityFile.relativePath} solution prompt upgrade fidelity가 유효하지 않습니다`);
    generation.revision = {
      generationId,
      key: input.key,
      repairArtifact: { path: repairFile.relativePath, sha256: repairFile.sha256 },
      repairFidelityArtifact: { path: context.fidelityFile.relativePath, sha256: context.fidelityFile.sha256 },
      revisionArtifact: { path: upgradeFile.relativePath, sha256: upgradeFile.sha256 },
      revisionFidelityArtifact: {
        path: upgradeFidelityFile.relativePath,
        sha256: upgradeFidelityFile.sha256,
      },
      finalSolutionItemHash: revisedItemHash,
      diagnosticDecisionHash,
      diagnosticEvidence: predecessor.failedEvidence,
    };
    generation.revisionTrigger = { kind: "prompt-upgrade", predecessor };
  }
  for (const predecessor of legacyPromptUpgradePredecessors.values()) {
    if (usedLegacyPromptUpgradePredecessors.has(predecessor.revisionArtifact.path)) continue;
    if (!allowCurrentPartial) {
      throw new Error(`${predecessor.key} legacy solution revision prompt upgrade가 없습니다`);
    }
    const trigger: Extract<SolutionRevisionTrigger, { kind: "prompt-upgrade" }> = {
      kind: "prompt-upgrade",
      predecessor,
    };
    const prior = partialRevisionTriggers.get(predecessor.key);
    if (prior && canonicalEvidenceHash(prior) !== canonicalEvidenceHash(trigger)) {
      throw new Error(`${predecessor.key} legacy prompt upgrade trigger가 충돌합니다`);
    }
    partialRevisionTriggers.set(predecessor.key, trigger);
  }
  if (repairFidelityFiles.some((file) => !assignedRepairFidelity.has(file.relativePath))) {
    throw new Error("orphan solution repair fidelity artifact가 있습니다");
  }
  if (revisionFiles.some((file) => !assignedRevision.has(file.relativePath))) {
    throw new Error("orphan solution revision artifact가 있습니다");
  }
  if (revisionFidelityFiles.some((file) => !assignedRevisionFidelity.has(file.relativePath))) {
    throw new Error("orphan solution revision fidelity artifact가 있습니다");
  }
  if (revisionFidelityAdjudicationFiles.some((file) =>
    !assignedRevisionFidelityAdjudication.has(file.relativePath)
  )) throw new Error("orphan solution revision fidelity adjudication artifact가 있습니다");
  const fidelityAdjudicationEvidenceDirectory = join(stateDir, "solution-fidelity-adjudication-evidence");
  const actualFidelityAdjudicationEvidence = new Set<string>();
  if (existsSync(fidelityAdjudicationEvidenceDirectory)) {
    for (const child of readdirSync(fidelityAdjudicationEvidenceDirectory, { withFileTypes: true })) {
      if (child.isFile() && child.name.endsWith(".tmp")) continue;
      if (!child.isFile() || child.isSymbolicLink()) {
        throw new Error(`solution fidelity adjudication evidence에 regular file이 아닌 항목이 있습니다: ${child.name}`);
      }
      actualFidelityAdjudicationEvidence.add(`solution-fidelity-adjudication-evidence/${child.name}`);
    }
  }
  if (
    [...actualFidelityAdjudicationEvidence].some((path) =>
      !assignedRevisionFidelityAdjudicationEvidence.has(path)
    ) || [...assignedRevisionFidelityAdjudicationEvidence].some((path) =>
      !actualFidelityAdjudicationEvidence.has(path)
    )
  ) throw new Error("solution fidelity adjudication evidence orphan/conflict가 있습니다");
  if (promptUpgradeFiles.some((file) => !assignedPromptUpgrade.has(file.relativePath))) {
    throw new Error("orphan solution prompt upgrade artifact가 있습니다");
  }
  if (promptUpgradeFidelityFiles.some((file) => !assignedPromptUpgradeFidelity.has(file.relativePath))) {
    throw new Error("orphan solution prompt upgrade fidelity artifact가 있습니다");
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
    if (
      !seed || seed === generation || seed.key !== generation.key ||
      seed.repairedItemHash !== generation.repairedItemHash || !generation.persistedSeed ||
      canonicalEvidenceHash(generation.persistedSeed) !== canonicalEvidenceHash(expectedSeed)
    ) throw new Error(`${generation.key} persisted repair seed generation이 유효하지 않습니다`);
  }
  for (const generation of generations.values()) {
    if (generation.revisionTrigger?.kind !== "persisted") continue;
    const predecessor = generation.revisionTrigger.authority;
    const candidates = [...generations.values()].filter((candidate) =>
      candidate.revision && canonicalEvidenceHash(candidate.revision) === canonicalEvidenceHash(predecessor)
    );
    if (
      candidates.length !== 1 || candidates[0] === generation ||
      candidates[0].generationId !== predecessor.generationId || candidates[0].key !== generation.key
    ) throw new Error(`${generation.key} persisted revision predecessor가 유효하지 않습니다`);
  }
  const stickyFirst = new Map<string, PersistedSolutionFirstAuthority>();
  const revisionTriggers = new Map<string, Exclude<SolutionRevisionTrigger, { kind: "fidelity" }>>();
  const requiredRevisionKeys = new Set<string>();
  const byKey = new Map<string, PersistedSolutionFirstAuthority[]>();
  for (const generation of generations.values()) {
    const values = byKey.get(generation.key) ?? [];
    values.push(generation);
    byKey.set(generation.key, values);
  }
  for (const [key, values] of byKey) {
    values.sort((left, right) => {
      const leftCurrent = left.effectiveProblemCorpusHash === currentEffectiveProblemCorpusHash ? 1 : 0;
      const rightCurrent = right.effectiveProblemCorpusHash === currentEffectiveProblemCorpusHash ? 1 : 0;
      return rightCurrent - leftCurrent || left.generationId.localeCompare(right.generationId);
    });
    const current = values.find((value) => value.effectiveProblemCorpusHash === currentEffectiveProblemCorpusHash);
    const withRevision = values.find((value) => value.revision);
    const currentSeed = current?.seededFromGenerationId
      ? generations.get(current.seededFromGenerationId)
      : undefined;
    const selected = currentSeed ?? current ?? withRevision ?? values[0];
    stickyFirst.set(key, selected);
    if (!withRevision?.revision) continue;
    requiredRevisionKeys.add(key);
    if (withRevision.effectiveProblemCorpusHash !== currentEffectiveProblemCorpusHash) {
      revisionTriggers.set(key, { kind: "persisted", authority: withRevision.revision });
    } else if (
      withRevision.revisionTrigger?.kind === "semantic" ||
      withRevision.revisionTrigger?.kind === "persisted" ||
      withRevision.revisionTrigger?.kind === "prompt-upgrade"
    ) {
      revisionTriggers.set(key, withRevision.revisionTrigger);
    }
  }
  for (const [key, trigger] of partialRevisionTriggers) {
    const prior = revisionTriggers.get(key);
    if (prior && canonicalEvidenceHash(prior) !== canonicalEvidenceHash(trigger)) {
      throw new Error(`${key} complete/partial solution revision trigger가 충돌합니다`);
    }
    revisionTriggers.set(key, trigger);
    requiredRevisionKeys.add(key);
  }
  return { stickyFirst, revisionTriggers, requiredRevisionKeys, currentPartialKeys: partialCurrentKeys };
}

async function assertSolutionRevisionFidelityAdjudicationAuthority(
  stateDir: string,
  repairs: Iterable<SolutionRepairEvidence>
): Promise<void> {
  const declared = new Map<string, string>();
  const declare = async (label: string, pointer: EvidencePointer): Promise<void> => {
    if (declared.has(pointer.path)) throw new Error(`${label} artifact가 중복 선언됐습니다: ${pointer.path}`);
    const path = confinedStateFile(stateDir, pointer.path, label);
    if (await sha256File(path) !== pointer.sha256) throw new Error(`${label} hash가 다릅니다: ${pointer.path}`);
    declared.set(pointer.path, pointer.sha256);
  };
  for (const repair of repairs) {
    const revision = repair.revision;
    const adjudication = revision?.fidelityAdjudication;
    if (!revision || !adjudication) continue;
    const spec = SOLUTION_REVISION_FIDELITY_ADJUDICATION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === adjudication.allowlistId && candidate.key === repair.key &&
      candidate.sourceHash === adjudication.sourceHash && candidate.sourcePage === adjudication.sourcePage &&
      candidate.revisionArtifactHash === revision.solutionArtifact.sha256 &&
      candidate.failedFidelityArtifactHash === revision.fidelityArtifact.sha256 &&
      candidate.revisionSolutionItemHash === revision.effectiveSolutionItemHash &&
      candidate.failedDecisionHash === adjudication.failedDecisionHash &&
      candidate.failedEvidenceHash === adjudication.failedEvidenceHash
    );
    if (
      !spec || adjudication.key !== repair.key || adjudication.dpi !== spec.dpi ||
      canonicalEvidenceHash(adjudication.revisionArtifact) !== canonicalEvidenceHash({
        path: revision.solutionArtifact.path,
        sha256: revision.solutionArtifact.sha256,
      }) || canonicalEvidenceHash(adjudication.failedFidelityArtifact) !== canonicalEvidenceHash(
        revision.fidelityArtifact
      ) || adjudication.revisionSolutionItemHash !== revision.effectiveSolutionItemHash ||
      adjudication.adjudicationArtifact.version !== SOLUTION_REVISION_FIDELITY_ADJUDICATION_VERSION ||
      adjudication.adjudicationArtifact.promptDigest !==
        SOLUTION_REVISION_FIDELITY_ADJUDICATION_PROMPT_DIGEST ||
      canonicalEvidenceHash(adjudication.sourcePages) !== canonicalEvidenceHash(
        [...new Set(spec.views.map((view) => view.sourcePage))].sort((a, b) => a - b)
      ) || canonicalEvidenceHash(adjudication.cropViews.map(({ sourcePage, label, rect }) => ({
        sourcePage,
        label,
        rect,
      }))) !== canonicalEvidenceHash(spec.views)
    ) throw new Error(`${repair.key} solution fidelity adjudication evidence가 parent/allowlist와 다릅니다`);
    for (const [label, pointer] of [
      ["solution fidelity adjudication revision", adjudication.revisionArtifact],
      ["solution fidelity adjudication failed fidelity", adjudication.failedFidelityArtifact],
    ] as const) {
      const path = confinedStateFile(stateDir, pointer.path, label);
      if (await sha256File(path) !== pointer.sha256) throw new Error(`${label} hash가 다릅니다`);
    }
    await declare("solution fidelity adjudication evidence", adjudication.cropEvidenceArtifact);
    await declare("solution fidelity adjudication PDF", adjudication.cropEvidencePdf);
    for (const [index, view] of adjudication.cropViews.entries()) {
      if (view.pixelSha256 !== view.artifact.sha256) {
        throw new Error(`${repair.key} solution fidelity adjudication view ${index + 1} hash가 다릅니다`);
      }
      await declare(`solution fidelity adjudication view ${index + 1}`, view.artifact);
      const dimensions = pngDimensions(confinedStateFile(
        stateDir,
        view.artifact.path,
        `solution fidelity adjudication view ${index + 1}`
      ));
      if (dimensions.width !== view.pixelWidth || dimensions.height !== view.pixelHeight) {
        throw new Error(`${repair.key} solution fidelity adjudication view ${index + 1} 크기가 다릅니다`);
      }
    }
    await declare("solution fidelity adjudication child", adjudication.adjudicationArtifact);
    const child = object(JSON.parse(readFileSync(confinedStateFile(
      stateDir,
      adjudication.adjudicationArtifact.path,
      "solution fidelity adjudication child"
    ), "utf8")), adjudication.adjudicationArtifact.path);
    if (
      canonicalEvidenceHash(child.item) !== adjudication.adjudicationDecisionHash ||
      object(child.basis, "solution fidelity adjudication basis").failedDecisionHash !==
        adjudication.failedDecisionHash
    ) throw new Error(`${repair.key} solution fidelity adjudication child decision binding이 다릅니다`);
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
    trigger.kind === "semantic" && (!firstTerminal || trigger.semanticDecision.key !== base.key) ||
    trigger.kind === "persisted" && trigger.authority.key !== base.key ||
    trigger.kind === "prompt-upgrade" && trigger.predecessor.key !== base.key
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
  const triggerEvidence: SolutionRevisionEvidence["trigger"] = trigger.kind === "semantic" ? {
      kind: trigger.kind,
      fidelityDecisionHash: diagnosticDecisionHash,
      semanticCheckpoint: trigger.semanticCheckpoint,
      semanticDecisionHash,
    } : trigger.kind === "persisted" ? {
      kind: trigger.kind,
      fidelityDecisionHash: diagnosticDecisionHash,
      persistedTriggerVersion: PERSISTED_SOLUTION_REVISION_TRIGGER_VERSION,
      predecessor: trigger.authority,
    } : trigger.kind === "prompt-upgrade" ? {
      kind: trigger.kind,
      fidelityDecisionHash: diagnosticDecisionHash,
      promptUpgradeVersion: SOLUTION_PROMPT_UPGRADE_VERSION,
      legacyPredecessor: trigger.predecessor,
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
  } else if (trigger.kind === "persisted") {
    if (
      trigger.authority.key !== base.key || trigger.authority.diagnosticDecisionHash.length !== 64 ||
      !trigger.authority.diagnosticEvidence.trim()
    ) throw new Error(`${base.key} persisted solution revision authority가 유효하지 않습니다`);
    for (const [label, pointer] of [
      ["persisted predecessor repair", trigger.authority.repairArtifact],
      ["persisted predecessor repair fidelity", trigger.authority.repairFidelityArtifact],
      ["persisted predecessor revision", trigger.authority.revisionArtifact],
      ["persisted predecessor revision fidelity", trigger.authority.revisionFidelityArtifact],
    ] as const) {
      const path = confinedStateFile(stateDir, pointer.path, label);
      if (await sha256File(path) !== pointer.sha256) throw new Error(`${base.key} ${label} hash가 다릅니다`);
    }
  } else if (trigger.kind === "prompt-upgrade") {
    const predecessor = trigger.predecessor;
    const spec = SOLUTION_PROMPT_UPGRADE_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === predecessor.allowlistId && candidate.entryId === entry.id &&
      candidate.key === base.key && candidate.sourceHash === evidence.sha256 &&
      candidate.legacyRevisionArtifactHash === predecessor.revisionArtifact.sha256 &&
      candidate.legacyRevisionFidelityArtifactHash === predecessor.revisionFidelityArtifact.sha256 &&
      predecessor.revisionArtifact.promptVersion === candidate.legacyPromptVersion &&
      predecessor.revisionArtifact.promptDigest === candidate.legacyPromptDigest
    );
    if (
      !spec || predecessor.failedEvidenceHash !== sha256Text(predecessor.failedEvidence) ||
      await sha256File(evidence.path) !== evidence.sha256
    ) {
      throw new Error(`${base.key} legacy solution prompt upgrade authority가 유효하지 않습니다`);
    }
    for (const [label, pointer] of [
      ["legacy repair", predecessor.repairArtifact],
      ["legacy repair fidelity", predecessor.repairFidelityArtifact],
      ["legacy revision", predecessor.revisionArtifact],
      ["legacy revision fidelity", predecessor.revisionFidelityArtifact],
    ] as const) {
      const path = confinedStateFile(stateDir, pointer.path, label);
      if (await sha256File(path) !== pointer.sha256) throw new Error(`${base.key} ${label} hash가 다릅니다`);
    }
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
  const revisionVersion = trigger.kind === "prompt-upgrade"
    ? SOLUTION_PROMPT_UPGRADE_VERSION
    : SOLUTION_REVISION_VERSION;
  const revisionDirectory = trigger.kind === "prompt-upgrade"
    ? "solution-revision-upgrades"
    : "solution-revisions";
  const revisionRelativePath =
    `${revisionDirectory}/v${revisionVersion}-${String(firstSolution.page).padStart(4, "0")}-` +
    `${base.printedNumber.padStart(4, "0")}-${revisionBasisHash}.json`;
  const revisionPath = join(stateDir, revisionRelativePath);

  let revised: SolutionItem;
  let revisionCheckpoint: Record<string, unknown>;
  if (existsSync(revisionPath)) {
    revisionCheckpoint = object(JSON.parse(readFileSync(revisionPath, "utf8")), revisionRelativePath);
    if (
      revisionCheckpoint.version !== revisionVersion || revisionCheckpoint.entryId !== entry.id ||
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
      revisionEvidence: trigger.kind === "semantic"
        ? trigger.semanticDecision.evidence
        : trigger.kind === "persisted" ? trigger.authority.diagnosticEvidence
        : trigger.kind === "prompt-upgrade" ? trigger.predecessor.failedEvidence : firstDecision.evidence,
      reasoningEffort: IMPORT_REASONING_EFFORT,
    })))[0];
    revisionCheckpoint = {
      version: revisionVersion,
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
  if (trigger.kind === "prompt-upgrade") {
    const expectedAnswer = SOLUTION_PROMPT_UPGRADE_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === trigger.predecessor.allowlistId
    )?.expectedAnswer;
    if (!expectedAnswer || revised.answer !== expectedAnswer) {
      throw new Error(`${base.key} prompt upgrade가 공식 정답표 marker를 보존하지 않았습니다`);
    }
  }
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
  const revisionFidelityVersion = trigger.kind === "prompt-upgrade"
    ? SOLUTION_PROMPT_UPGRADE_FIDELITY_VERSION
    : SOLUTION_REVISION_FIDELITY_VERSION;
  const revisionFidelityDirectory = trigger.kind === "prompt-upgrade"
    ? "solution-fidelity-revision-upgrades"
    : "solution-fidelity-revisions";
  const fidelityRelativePath =
    `${revisionFidelityDirectory}/v${revisionFidelityVersion}-` +
    `${String(firstSolution.page).padStart(4, "0")}-${base.printedNumber.padStart(4, "0")}-` +
    `${revisionArtifactHash}-${effectiveSolutionItemHash}.json`;
  const fidelityPath = join(stateDir, fidelityRelativePath);
  let fidelityCheckpoint: Record<string, unknown>;
  let decision: SolutionFidelityDecision;
  if (existsSync(fidelityPath)) {
    fidelityCheckpoint = object(JSON.parse(readFileSync(fidelityPath, "utf8")), fidelityRelativePath);
    if (
      fidelityCheckpoint.version !== revisionFidelityVersion ||
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
      version: revisionFidelityVersion,
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
  const revisionArtifact = { path: revisionRelativePath, sha256: revisionArtifactHash };
  const failedFidelityArtifact = {
    path: fidelityRelativePath,
    sha256: fidelityArtifactHash,
    promptDigest: SOLUTION_FIDELITY_PROMPT_DIGEST,
  };
  let terminalDecision = decision;
  let terminalFidelityArtifact: EvidencePointer = failedFidelityArtifact;
  let fidelityAdjudication: SolutionRevisionFidelityAdjudicationEvidence | undefined;
  const terminalAnswer = decision.answerStatus === "exact" ||
    decision.answerStatus === "not_visible" && base.allowDerivedMarkerAnswer;
  const terminal = decision.sourcePage === revised.page && decision.explanationStatus === "exact" &&
    (trigger.kind === "prompt-upgrade" ? decision.answerStatus === "exact" : terminalAnswer);
  const adjudicationSpec = solutionRevisionFidelityAdjudicationSpec(
    entry,
    evidence,
    base.key,
    revisionArtifactHash,
    fidelityArtifactHash,
    effectiveSolutionItemHash,
    decision
  );
  if (!terminal && adjudicationSpec) {
    const adjudicated = await adjudicateSolutionRevisionFidelity(
      entry,
      evidence,
      stateDir,
      effectiveProblemCorpusHash,
      revisedInput,
      revised,
      revisionArtifact,
      failedFidelityArtifact,
      decision
    );
    terminalDecision = adjudicated.decision;
    terminalFidelityArtifact = adjudicated.artifact;
    fidelityAdjudication = adjudicated.evidence;
  } else if (!terminal) {
    throw new Error(`${base.key} 두 번째 source-grounded 해설 revision도 terminal이 아닙니다`);
  }

  return {
    solution: revised,
    decision: terminalDecision,
    fidelityArtifact: terminalFidelityArtifact,
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
      ...(fidelityAdjudication ? { fidelityAdjudication } : {}),
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
  revisionTrigger?: Exclude<SolutionRevisionTrigger, { kind: "fidelity" }>,
  persistedFirst?: PersistedSolutionFirstAuthority
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
  const persistedSeed = persistedFirst ? {
    version: PERSISTED_SOLUTION_REPAIR_SEED_VERSION,
    generationId: persistedFirst.generationId,
    effectiveProblemCorpusHash: persistedFirst.effectiveProblemCorpusHash,
    baseFidelityCheckpoint: persistedFirst.baseFidelityCheckpoint,
    repairArtifact: persistedFirst.repairArtifact,
    repairFidelityArtifact: persistedFirst.repairFidelityArtifact,
    repairedItemHash: persistedFirst.repairedItemHash,
  } : undefined;

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
      if (persistedFirst && persistedSeed) {
        for (const [label, pointer] of [
          ["persisted first base fidelity", persistedFirst.baseFidelityCheckpoint],
          ["persisted first repair", persistedFirst.repairArtifact],
          ["persisted first repair fidelity", persistedFirst.repairFidelityArtifact],
        ] as const) {
          const path = confinedStateFile(stateDir, pointer.path, label);
          if (await sha256File(path) !== pointer.sha256) throw new Error(`${base.key} ${label} hash가 다릅니다`);
        }
        corrected = structuredClone(persistedFirst.repairedItem);
      } else {
        corrected = (await withTargetedAi(() => extractSolutionsFromFile(contextPath, "pdf", {
          sliceBase: base.baseContextFrom,
          contentPageCount: base.baseContextTo - base.baseContextFrom + 1,
          target: { printedNumber: number },
          reasoningEffort: IMPORT_REASONING_EFFORT,
        })))[0];
      }
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
        ...(persistedSeed ? { persistedSeed } : {}),
        effectivePage: corrected.page,
        item: corrected,
      };
      await writeImmutableEvidence(repairPath, repairCheckpoint);
    }
    if (repairCheckpoint.persistedSeed !== undefined) {
      const seed = object(repairCheckpoint.persistedSeed, "persisted solution repair seed");
      if (
        !persistedSeed ||
        canonicalEvidenceHash(seed) !== canonicalEvidenceHash(persistedSeed) ||
        seed.version !== PERSISTED_SOLUTION_REPAIR_SEED_VERSION ||
        typeof seed.generationId !== "string" || !/^[a-f0-9]{64}$/u.test(seed.generationId) ||
        typeof seed.effectiveProblemCorpusHash !== "string" ||
        !/^[a-f0-9]{64}$/u.test(seed.effectiveProblemCorpusHash) ||
        seed.repairedItemHash !== canonicalEvidenceHash(corrected)
      ) throw new Error(`${base.key} persisted solution repair seed가 유효하지 않습니다`);
      for (const [label, rawPointer] of [
        ["persisted seed base fidelity", seed.baseFidelityCheckpoint],
        ["persisted seed repair", seed.repairArtifact],
        ["persisted seed repair fidelity", seed.repairFidelityArtifact],
      ] as const) {
        const pointer = object(rawPointer, label);
        const path = confinedStateFile(stateDir, exactString(pointer.path, `${label} path`, 500), label);
        if (await sha256File(path) !== exactHash(pointer.sha256, `${label} hash`)) {
          throw new Error(`${base.key} ${label} hash가 다릅니다`);
        }
      }
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

export async function auditAcceptedSolutions(
  entry: CorpusManifestEntry,
  problemEvidence: PdfEvidence,
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
  const persistedHistory = await scanPersistedSolutionHistory(
    entry,
    problemEvidence,
    evidence,
    stateDir,
    classified,
    baseSolutions,
    effectiveProblemCorpusHash,
    true
  );

  if (inputs.length === 0) {
    await scanPersistedSolutionHistory(
      entry,
      problemEvidence,
      evidence,
      stateDir,
      classified,
      baseSolutions,
      effectiveProblemCorpusHash,
      false
    );
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
              decision.explanationStatus !== "exact" || !terminalAnswer || input.baseContextTo > slice.to ||
              persistedHistory.stickyFirst.has(input.key) ||
              persistedHistory.currentPartialKeys.has(input.key);
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
            const persistedTrigger = persistedHistory.revisionTriggers.get(input.key);
            const semanticTrigger = revisionTriggers.get(input.key);
            if (
              persistedTrigger?.kind === "semantic" && semanticTrigger &&
              canonicalEvidenceHash(persistedTrigger) !== canonicalEvidenceHash(semanticTrigger)
            ) throw new Error(`${input.key} persisted/current semantic revision authority가 충돌합니다`);
            const repaired = await repairSolutionItem(
              entry,
              evidence,
              stateDir,
              analysisEvidence.path,
              effectiveProblemCorpusHash,
              input,
              result.evidence,
              persistedTrigger ?? semanticTrigger,
              persistedHistory.stickyFirst.get(input.key)
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
  if ([...persistedHistory.requiredRevisionKeys].some((key) =>
    inputs.some((input) => input.key === key) && !repairs.find((repair) => repair.key === key)?.revision
  )) throw new Error("persisted 해설 revision depth가 current audit에 유지되지 않았습니다");
  const strictHistory = await scanPersistedSolutionHistory(
    entry,
    problemEvidence,
    evidence,
    stateDir,
    classified,
    baseSolutions,
    effectiveProblemCorpusHash,
    false
  );
  if ([...strictHistory.requiredRevisionKeys].some((key) =>
    inputs.some((input) => input.key === key) && !repairs.find((repair) => repair.key === key)?.revision
  )) throw new Error("persisted 해설 revision authority가 current audit에서 누락되었습니다");
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

export function semanticChoiceCheckpointPath(
  effectiveCorpusHash: string,
  effectiveSolutionCorpusHash: string,
  inputHash: string
): string {
  if ([effectiveCorpusHash, effectiveSolutionCorpusHash, inputHash].some((hash) => !/^[a-f0-9]{64}$/u.test(hash))) {
    throw new Error("semantic choice checkpoint hash가 유효하지 않습니다");
  }
  return `semantic-choice-checks/v${SEMANTIC_CHOICE_CHECK_VERSION}-` +
    `${effectiveCorpusHash}-${effectiveSolutionCorpusHash}-${inputHash}.json`;
}

async function semanticChoiceCheckpoint(
  entry: CorpusManifestEntry,
  problem: PdfEvidence,
  solution: PdfEvidence,
  stateDir: string,
  effectiveCorpusHash: string,
  effectiveSolutionCorpusHash: string,
  inputs: Array<{ key: string; choices: string[]; detailedExplanation: string }>
): Promise<{ decisions: SemanticChoiceDecision[]; path: string; sha256: string; inputHash: string }> {
  const inputHash = canonicalEvidenceHash(inputs);
  const relativePath = semanticChoiceCheckpointPath(effectiveCorpusHash, effectiveSolutionCorpusHash, inputHash);
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
  solutionEvidence: PdfEvidence,
  stateDir: string,
  baseByKey: ReadonlyMap<string, ClassifiedQuestion>,
  officialSolutions: ReadonlyMap<number, SolutionItem>
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
      const original = baseByKey.get(key);
      const number = original && numericPrintedLocator(original.question.number);
      const solution = number === null || number === undefined ? undefined : officialSolutions.get(number);
      if (!original || !solution) throw new Error(`persisted problem repair base가 없습니다: ${path}`);
      const baseQuestion = await baseQuestionEvidence(entry, problem, stateDir, original);
      const baseSolution = await baseSolutionEvidence(solutionEvidence, stateDir, solution);
      const expectedRelativePath = `problem-repairs/v${PROBLEM_REPAIR_VERSION}-` +
        `${String(original.question.page).padStart(4, "0")}-${String(number).padStart(4, "0")}.json`;
      const expectedCheckpoint = {
        version: PROBLEM_REPAIR_VERSION,
        entryId: entry.id,
        key,
        sourcePage: original.question.page,
        printedNumber: String(number),
        contextFrom: baseQuestion.contextFrom,
        contextTo: baseQuestion.contextTo,
        sourceHash: problem.sha256,
        baseProblemCheckpoint: baseQuestion.problem,
        baseQuestionHash: baseQuestion.questionHash,
        baseSolutionCheckpoint: baseSolution.checkpoint,
        baseSolutionItemHash: baseSolution.itemHash,
        officialRawAnswerHash: sha256Text(solution.answer),
        promptVersion: TARGETED_PROBLEM_TRANSCRIPTION_VERSION,
        promptDigest: TARGETED_PROBLEM_PROMPT_DIGEST,
        model: IMPORT_MODEL,
        reasoningEffort: IMPORT_REASONING_EFFORT,
        item,
      };
      if (
        relativePath !== expectedRelativePath || keys.has(key) ||
        checkpoint.version !== PROBLEM_REPAIR_VERSION || checkpoint.entryId !== entry.id ||
        checkpoint.key !== key || checkpoint.sourcePage !== original.question.page ||
        checkpoint.printedNumber !== String(number) || checkpoint.sourceHash !== problem.sha256 ||
        checkpoint.contextFrom !== baseQuestion.contextFrom || checkpoint.contextTo !== baseQuestion.contextTo ||
        canonicalEvidenceHash(checkpoint.baseProblemCheckpoint) !== canonicalEvidenceHash(baseQuestion.problem) ||
        checkpoint.baseQuestionHash !== baseQuestion.questionHash ||
        canonicalEvidenceHash(checkpoint.baseSolutionCheckpoint) !== canonicalEvidenceHash(baseSolution.checkpoint) ||
        checkpoint.baseSolutionItemHash !== baseSolution.itemHash ||
        checkpoint.officialRawAnswerHash !== sha256Text(solution.answer) ||
        checkpoint.promptVersion !== TARGETED_PROBLEM_TRANSCRIPTION_VERSION ||
        checkpoint.promptDigest !== TARGETED_PROBLEM_PROMPT_DIGEST || checkpoint.model !== IMPORT_MODEL ||
        checkpoint.reasoningEffort !== IMPORT_REASONING_EFFORT || questionKey(item) !== key ||
        canonicalEvidenceHash(checkpoint) !== canonicalEvidenceHash(expectedCheckpoint) ||
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
    if (memberKeys.some((key) => keys.has(key))) {
      throw new Error("persisted problem repair key가 중복되었습니다");
    }
    for (const key of memberKeys) keys.add(key);
  }
  return keys;
}

async function hydratePersistedProblemRepairBatches(
  entry: CorpusManifestEntry,
  problem: PdfEvidence,
  solutionEvidence: PdfEvidence,
  stateDir: string,
  baseByKey: ReadonlyMap<string, ClassifiedQuestion>,
  officialSolutions: ReadonlyMap<number, SolutionItem>
): Promise<Array<{ classified: ClassifiedQuestion; evidence: ProblemRepairEvidence }>> {
  const directory = join(stateDir, "problem-repair-batches");
  type Record = {
    key: string;
    original: ClassifiedQuestion;
    solution: SolutionItem;
    baseQuestion: Awaited<ReturnType<typeof baseQuestionEvidence>>;
    baseSolution: Awaited<ReturnType<typeof baseSolutionEvidence>>;
    question: QuizItemEx;
    problemArtifact: EvidencePointer & { itemHash: string };
  };
  const groups: Record[][] = [];
  const legacySingleByClassificationPath = new Map<string, Record>();
  const recordsByKey = new Map<string, Record>();
  const seenKeys = new Set<string>();
  const singleDirectory = join(stateDir, "problem-repairs");
  if (existsSync(singleDirectory)) {
    for (const name of readdirSync(singleDirectory).filter((value) => value.endsWith(".json")).sort()) {
      if (!/^v2-\d{4}-\d{4}\.json$/u.test(name)) continue;
      const relativePath = `problem-repairs/${name}`;
      const path = confinedStateFile(stateDir, relativePath, "persisted legacy problem repair graph");
      const checkpoint = object(JSON.parse(readFileSync(path, "utf8")), relativePath);
      const key = exactString(checkpoint.key, `${relativePath}.key`, 100);
      const original = baseByKey.get(key);
      const number = original && numericPrintedLocator(original.question.number);
      const solution = number === null || number === undefined ? undefined : officialSolutions.get(number);
      if (!original || !solution) throw new Error(`persisted legacy problem repair base가 없습니다: ${path}`);
      const baseQuestion = await baseQuestionEvidence(entry, problem, stateDir, original);
      const baseSolution = await baseSolutionEvidence(solutionEvidence, stateDir, solution);
      const question = restoredQuizItems([checkpoint.item])[0];
      const problemSha = await sha256File(path);
      const expectedRelativePath = `problem-repairs/v${PROBLEM_REPAIR_VERSION}-` +
        `${String(original.question.page).padStart(4, "0")}-${String(number).padStart(4, "0")}.json`;
      const expectedCheckpoint = {
        version: PROBLEM_REPAIR_VERSION,
        entryId: entry.id,
        key,
        sourcePage: original.question.page,
        printedNumber: String(number),
        contextFrom: baseQuestion.contextFrom,
        contextTo: baseQuestion.contextTo,
        sourceHash: problem.sha256,
        baseProblemCheckpoint: baseQuestion.problem,
        baseQuestionHash: baseQuestion.questionHash,
        baseSolutionCheckpoint: baseSolution.checkpoint,
        baseSolutionItemHash: baseSolution.itemHash,
        officialRawAnswerHash: sha256Text(solution.answer),
        promptVersion: TARGETED_PROBLEM_TRANSCRIPTION_VERSION,
        promptDigest: TARGETED_PROBLEM_PROMPT_DIGEST,
        model: IMPORT_MODEL,
        reasoningEffort: IMPORT_REASONING_EFFORT,
        item: question,
      };
      if (
        relativePath !== expectedRelativePath ||
        checkpoint.version !== PROBLEM_REPAIR_VERSION || checkpoint.entryId !== entry.id ||
        checkpoint.sourceHash !== problem.sha256 || checkpoint.sourcePage !== original.question.page ||
        checkpoint.printedNumber !== String(number) || checkpoint.contextFrom !== baseQuestion.contextFrom ||
        checkpoint.contextTo !== baseQuestion.contextTo ||
        canonicalEvidenceHash(checkpoint.baseProblemCheckpoint) !== canonicalEvidenceHash(baseQuestion.problem) ||
        checkpoint.baseQuestionHash !== baseQuestion.questionHash ||
        canonicalEvidenceHash(checkpoint.baseSolutionCheckpoint) !== canonicalEvidenceHash(baseSolution.checkpoint) ||
        checkpoint.baseSolutionItemHash !== baseSolution.itemHash ||
        checkpoint.officialRawAnswerHash !== sha256Text(solution.answer) ||
        checkpoint.promptVersion !== TARGETED_PROBLEM_TRANSCRIPTION_VERSION ||
        checkpoint.promptDigest !== TARGETED_PROBLEM_PROMPT_DIGEST || checkpoint.model !== IMPORT_MODEL ||
        checkpoint.reasoningEffort !== IMPORT_REASONING_EFFORT || questionKey(question) !== key ||
        canonicalEvidenceHash(checkpoint) !== canonicalEvidenceHash(expectedCheckpoint) ||
        problemSha !== canonicalEvidenceHash(checkpoint) || seenKeys.has(key)
      ) throw new Error(`persisted legacy problem repair graph가 유효하지 않습니다: ${path}`);
      const record = {
        key,
        original,
        solution,
        baseQuestion,
        baseSolution,
        question,
        problemArtifact: { path: relativePath, sha256: problemSha, itemHash: canonicalEvidenceHash(question) },
      };
      const legacyClassificationRelativePath =
        `classification-repairs/v3-` +
        `${String(original.question.page).padStart(4, "0")}-${String(number).padStart(4, "0")}-` +
        `${CLASSIFIER_DIGEST}.json`;
      legacySingleByClassificationPath.set(legacyClassificationRelativePath, record);
      if (await problemRepairBatchAuthorityVersion(
        entry,
        problem,
        stateDir,
        baseQuestion.contextFrom,
        baseQuestion.contextTo
      ) === 1) continue;
      seenKeys.add(key);
      recordsByKey.set(key, record);
      groups.push([record]);
    }
  }
  if (existsSync(directory)) {
    const names = readdirSync(directory).sort();
    const contexts = new Set(names.flatMap((name) => {
      const match = /^v[12]-(\d{4})-(\d{4})-/u.exec(name);
      return match ? [`${Number(match[1])}:${Number(match[2])}`] : [];
    }));
    for (const context of contexts) {
      const [from, to] = context.split(":").map(Number);
      await problemRepairBatchAuthorityVersion(entry, problem, stateDir, from, to);
    }
    for (const name of names) {
      const match = /^v2-(\d{4})-(\d{4})-([a-f0-9]{64})\.json$/u.exec(name);
      if (!match) continue;
      const relativePath = `problem-repair-batches/${name}`;
      const path = confinedStateFile(stateDir, relativePath, "persisted problem repair graph");
      const checkpoint = object(JSON.parse(readFileSync(path, "utf8")), relativePath);
      const rawMembers = Array.isArray(checkpoint.members)
        ? checkpoint.members.map((value, index) => object(value, `${relativePath}.members[${index}]`))
        : [];
      const keys = rawMembers.map((member, index) => exactString(member.key, `${relativePath}.members[${index}].key`, 100));
      if (keys.length === 0 || keys.some((key) => seenKeys.has(key))) {
        throw new Error("persisted problem repair v2 key가 중복되었습니다");
      }
      const originals = keys.map((key) => {
        const original = baseByKey.get(key);
        if (!original) throw new Error(`${key} persisted problem repair v2 base가 없습니다`);
        return original;
      });
      const members = await Promise.all(originals.map(async (original) => {
        const key = questionKey(original.question);
        const number = numericPrintedLocator(original.question.number)!;
        const solution = officialSolutions.get(number);
        if (!solution) throw new Error(`${key} persisted problem repair v2 공식 해설이 없습니다`);
        return {
          key,
          number,
          original,
          solution,
          baseQuestion: await baseQuestionEvidence(entry, problem, stateDir, original),
          baseSolution: await baseSolutionEvidence(solutionEvidence, stateDir, solution),
        };
      }));
      members.sort((left, right) => compareCorpusQuestionKeys(left.key, right.key));
      const contextFrom = Number(match[1]);
      const contextTo = Number(match[2]);
      const memberBasis = members.map((member) => ({
        key: member.key,
        printedNumber: String(member.number),
        sourcePage: member.original.question.page!,
        baseTranscriptionEvidenceHash: sha256Text(member.original.classification.transcription_evidence),
        baseProblemCheckpoint: member.baseQuestion.problem,
        baseQuestionHash: member.baseQuestion.questionHash,
        baseClassificationCheckpoint: member.baseQuestion.classification,
        baseClassificationHash: member.baseQuestion.classificationHash,
        baseSolutionCheckpoint: member.baseSolution.checkpoint,
        baseSolutionItemHash: member.baseSolution.itemHash,
        officialRawAnswerHash: sha256Text(member.solution.answer),
      }));
      const targetsDigest = canonicalEvidenceHash(memberBasis);
      const diagnosticEvidence = JSON.stringify(members.map((member) => ({
        key: member.key,
        evidence: member.original.classification.transcription_evidence,
      })));
      const corrected = restoredSparseQuizItems(checkpoint.items);
      const correctedByKey = new Map(corrected.map((item) => [questionKey(item), item]));
      const expectedCheckpoint = {
        version: 2,
        entryId: entry.id,
        sourceHash: problem.sha256,
        contextFrom,
        contextTo,
        members: memberBasis,
        model: IMPORT_MODEL,
        reasoningEffort: IMPORT_REASONING_EFFORT,
        items: [...corrected].sort((left, right) =>
          compareCorpusQuestionKeys(questionKey(left), questionKey(right))
        ),
        targetsDigest,
        batchPromptVersion: TARGETED_PROBLEM_BATCH_VERSION,
        batchPromptDigest: TARGETED_PROBLEM_BATCH_PROMPT_DIGEST,
        revisionPromptVersion: TARGETED_PROBLEM_REVISION_VERSION,
        revisionPromptDigest: TARGETED_PROBLEM_BATCH_REVISION_PROMPT_DIGEST,
        diagnosticEvidenceHash: sha256Text(diagnosticEvidence),
      };
      if (
        checkpoint.version !== 2 || checkpoint.entryId !== entry.id || checkpoint.sourceHash !== problem.sha256 ||
        checkpoint.contextFrom !== contextFrom || checkpoint.contextTo !== contextTo ||
        checkpoint.targetsDigest !== targetsDigest || match[3] !== targetsDigest ||
        canonicalEvidenceHash(checkpoint.members) !== canonicalEvidenceHash(memberBasis) ||
        checkpoint.diagnosticEvidenceHash !== sha256Text(diagnosticEvidence) ||
        checkpoint.batchPromptVersion !== TARGETED_PROBLEM_BATCH_VERSION ||
        checkpoint.batchPromptDigest !== TARGETED_PROBLEM_BATCH_PROMPT_DIGEST ||
        checkpoint.revisionPromptVersion !== TARGETED_PROBLEM_REVISION_VERSION ||
        checkpoint.revisionPromptDigest !== TARGETED_PROBLEM_BATCH_REVISION_PROMPT_DIGEST ||
        checkpoint.model !== IMPORT_MODEL || checkpoint.reasoningEffort !== IMPORT_REASONING_EFFORT ||
        members.some((member) => member.baseQuestion.contextFrom !== contextFrom || member.baseQuestion.contextTo !== contextTo) ||
        correctedByKey.size !== members.length || members.some((member) => {
          const item = correctedByKey.get(member.key);
          return !item || item.page !== member.original.question.page;
        }) || canonicalEvidenceHash(checkpoint) !== canonicalEvidenceHash(expectedCheckpoint) ||
        await sha256File(path) !== canonicalEvidenceHash(checkpoint)
      ) throw new Error(`persisted problem repair v2 graph가 유효하지 않습니다: ${path}`);
      const problemSha = canonicalEvidenceHash(checkpoint);
      const group = members.map((member): Record => {
        const question = correctedByKey.get(member.key)!;
        return {
          key: member.key,
          original: member.original,
          solution: member.solution,
          baseQuestion: member.baseQuestion,
          baseSolution: member.baseSolution,
          question,
          problemArtifact: { path: relativePath, sha256: problemSha, itemHash: canonicalEvidenceHash(question) },
        };
      });
      for (const record of group) {
        seenKeys.add(record.key);
        recordsByKey.set(record.key, record);
      }
      groups.push(group);
    }
  }

  const hydrated = new Map<string, { classified: ClassifiedQuestion; evidence: ProblemRepairEvidence }>();
  const classificationDirectory = join(stateDir, "classification-repair-batches");
  if (existsSync(classificationDirectory)) {
    if (lstatSync(classificationDirectory).isSymbolicLink() || !lstatSync(classificationDirectory).isDirectory()) {
      throw new Error("classification repair batch 디렉터리가 유효하지 않습니다");
    }
    for (const name of readdirSync(classificationDirectory).sort()) {
      if (!name.endsWith(".json")) continue;
      const match = /^v1-(\d{4})-(\d{4})-([a-f0-9]{64})-([a-f0-9]{16})\.json$/u.exec(name);
      if (!match) {
        throw new Error(`classification repair batch filename이 유효하지 않습니다: ${name}`);
      }
      const relativePath = `classification-repair-batches/${name}`;
      const path = confinedStateFile(stateDir, relativePath, "persisted classification repair graph");
      const checkpoint = object(JSON.parse(readFileSync(path, "utf8")), relativePath);
      const members = Array.isArray(checkpoint.members)
        ? checkpoint.members.map((value, index) => object(value, `${relativePath}.members[${index}]`))
        : [];
      const items = Array.isArray(checkpoint.items) ? checkpoint.items : [];
      const memberKeys = members.map((member, index) => exactString(member.key, `${relativePath}.members[${index}].key`, 100));
      const itemKeys = items.map((item, index) => exactString(
        object(item, `${relativePath}.items[${index}]`).key,
        `${relativePath}.items[${index}].key`,
        100
      ));
      const graphRecords = members.map((member, index) => {
        const authority = object(member.problemAuthority, `${relativePath}.members[${index}].problemAuthority`);
        const problemPath = exactString(authority.path, `${relativePath}.members[${index}].problemAuthority.path`, 500);
        const record = recordsByKey.get(memberKeys[index]);
        return record?.problemArtifact.path === problemPath ? record : null;
      });
      const checkpointSha = await sha256File(path);
      if (
        checkpoint.version !== CLASSIFICATION_REPAIR_BATCH_VERSION || checkpoint.entryId !== entry.id ||
        checkpoint.sourceHash !== problem.sha256 || checkpoint.contextFrom !== Number(match[1]) ||
        checkpoint.contextTo !== Number(match[2]) || checkpoint.overlayDigest !== match[3] ||
        checkpoint.classifierVersion !== CLASSIFIER_VERSION || checkpoint.rulesDigest !== match[4] ||
        match[4] !== CLASSIFIER_DIGEST || checkpoint.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
        checkpoint.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST ||
        checkpoint.model !== IMPORT_MODEL || checkpoint.reasoningEffort !== IMPORT_REASONING_EFFORT ||
        members.length === 0 || members.length !== items.length || new Set(memberKeys).size !== memberKeys.length ||
        new Set(itemKeys).size !== itemKeys.length || itemKeys.some((key) => !memberKeys.includes(key)) ||
        canonicalEvidenceHash(checkpoint.members) !== match[3] || checkpointSha !== canonicalEvidenceHash(checkpoint)
      ) throw new Error(`classification repair graph가 유효하지 않습니다: ${path}`);
      const authorityVersion = await problemRepairBatchAuthorityVersion(
        entry,
        problem,
        stateDir,
        Number(match[1]),
        Number(match[2])
      );
      if (authorityVersion === 1) {
        if (graphRecords.some(Boolean)) {
          throw new Error(`classification repair graph의 v1/v2 authority가 섞였습니다: ${path}`);
        }
        continue;
      }
      if (graphRecords.some((record) => !record)) {
        throw new Error(`classification repair graph가 부분 authority만 참조합니다: ${path}`);
      }
      const expectedMembers = graphRecords.map((record, index) => {
        if (!record) throw new Error(`classification repair graph가 부분 authority만 참조합니다: ${path}`);
        const key = memberKeys[index];
        return {
          key,
          problemAuthority: { key, ...record.problemArtifact },
          effectiveQuestionHash: canonicalEvidenceHash(record.question),
          baseClassificationCheckpoint: record.baseQuestion.classification,
          baseClassificationHash: record.baseQuestion.classificationHash,
        };
      });
      const decisions = parseDecisions(
        items,
        graphRecords.map((record) => {
          if (!record) throw new Error(`classification repair graph가 부분 authority만 참조합니다: ${path}`);
          return record.question;
        }),
        entry
      );
      const expectedCheckpoint = {
        version: CLASSIFICATION_REPAIR_BATCH_VERSION,
        entryId: entry.id,
        sourceHash: problem.sha256,
        contextFrom: Number(match[1]),
        contextTo: Number(match[2]),
        overlayDigest: match[3],
        classifierVersion: CLASSIFIER_VERSION,
        rulesDigest: CLASSIFIER_DIGEST,
        transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
        transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
        model: IMPORT_MODEL,
        reasoningEffort: IMPORT_REASONING_EFFORT,
        members: expectedMembers,
        items: decisions,
      };
      if (canonicalEvidenceHash(checkpoint) !== canonicalEvidenceHash(expectedCheckpoint)) {
        throw new Error(`classification repair graph exact envelope가 다릅니다: ${path}`);
      }
      const decisionByKey = new Map(decisions.map((decision) => [decision.key, decision]));
      for (const [index, member] of members.entries()) {
        const authority = object(member.problemAuthority, `${relativePath}.members[${index}].problemAuthority`);
        const problemPath = exactString(authority.path, `${relativePath}.members[${index}].problemAuthority.path`, 500);
        const key = memberKeys[index];
        const record = graphRecords[index];
        if (!record || record.problemArtifact.path !== problemPath || hydrated.has(key)) {
          throw new Error(`classification repair v2 graph가 orphan/conflict입니다: ${path}`);
        }
        const expectedMember = {
          key,
          problemAuthority: { key, ...record.problemArtifact },
          effectiveQuestionHash: canonicalEvidenceHash(record.question),
          baseClassificationCheckpoint: record.baseQuestion.classification,
          baseClassificationHash: record.baseQuestion.classificationHash,
        };
        if (canonicalEvidenceHash(member) !== canonicalEvidenceHash(expectedMember)) {
          throw new Error(`${key} classification repair v2 graph member가 다릅니다`);
        }
        const classification = decisionByKey.get(key);
        if (!classification) throw new Error(`${key} classification repair graph decision이 없습니다`);
        hydrated.set(key, {
          classified: { question: record.question, classification },
          evidence: {
            key,
            printedNumber: String(numericPrintedLocator(record.original.question.number)!),
            sourcePage: record.original.question.page!,
            contextFrom: record.baseQuestion.contextFrom,
            contextTo: record.baseQuestion.contextTo,
            baseProblemCheckpoint: record.baseQuestion.problem,
            baseClassificationCheckpoint: record.baseQuestion.classification,
            baseSolutionCheckpoint: record.baseSolution.checkpoint,
            problemArtifact: { path: record.problemArtifact.path, sha256: record.problemArtifact.sha256 },
            problemArtifactItemHash: record.problemArtifact.itemHash,
            classificationArtifact: {
              path: relativePath,
              sha256: checkpointSha,
              rulesDigest: CLASSIFIER_DIGEST,
              transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
              transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
            },
            classificationArtifactItemHash: canonicalEvidenceHash(classification),
            baseQuestionHash: record.baseQuestion.questionHash,
            effectiveQuestionHash: canonicalEvidenceHash(record.question),
            baseClassificationHash: record.baseQuestion.classificationHash,
            effectiveClassificationHash: canonicalEvidenceHash(classification),
            baseSolutionItemHash: record.baseSolution.itemHash,
            officialRawAnswerHash: sha256Text(record.solution.answer),
          },
        });
      }
    }
  }

  const pendingGroups = groups.flatMap((group) => {
    const partial = group.filter((record) => !hydrated.has(record.key));
    if (partial.length === 0) return [];
    if (partial.length !== group.length) {
      throw new Error("persisted problem repair v2 classification coverage가 부분적으로 충돌합니다");
    }
    const contextFrom = partial[0].baseQuestion.contextFrom;
    const contextTo = partial[0].baseQuestion.contextTo;
    if (partial.some((record) =>
      record.baseQuestion.contextFrom !== contextFrom || record.baseQuestion.contextTo !== contextTo
    )) throw new Error("persisted problem repair v2 partial context가 다릅니다");
    return [partial];
  });

  const singleClassificationDirectory = join(stateDir, "classification-repairs");
  if (existsSync(singleClassificationDirectory)) {
    if (
      lstatSync(singleClassificationDirectory).isSymbolicLink() ||
      !lstatSync(singleClassificationDirectory).isDirectory()
    ) throw new Error("classification repair 디렉터리가 유효하지 않습니다");
    for (const child of readdirSync(singleClassificationDirectory, { withFileTypes: true })) {
      if (child.isFile() && child.name.endsWith(".tmp")) continue;
      if (!child.isFile() || child.isSymbolicLink() ||
        !/^v3-\d{4}-\d{4}-[a-f0-9]{16}\.json$/u.test(child.name)) {
        throw new Error(`classification repair 파일이 유효하지 않습니다: ${child.name}`);
      }
      const relativePath = `classification-repairs/${child.name}`;
      const record = legacySingleByClassificationPath.get(relativePath);
      if (!record) throw new Error(`classification repair graph가 orphan입니다: ${relativePath}`);
      const path = confinedStateFile(stateDir, relativePath, "legacy classification repair graph");
      const checkpoint = object(JSON.parse(readFileSync(path, "utf8")), relativePath);
      const basePointerRaw = object(
        checkpoint.baseClassificationCheckpoint,
        `${relativePath}.baseClassificationCheckpoint`
      );
      const problemIndex = /^problem-chunks\/v2-(\d{4})\.json$/u.exec(record.baseQuestion.problem.path)?.[1];
      if (!problemIndex) throw new Error(`${record.key} legacy classification base problem path가 다릅니다`);
      const baseClassificationPointer = {
        path: exactString(basePointerRaw.path, `${relativePath}.baseClassificationCheckpoint.path`, 500),
        sha256: exactString(basePointerRaw.sha256, `${relativePath}.baseClassificationCheckpoint.sha256`, 64),
      };
      const expectedBaseClassificationPath =
        `classification-chunks/v4-${problemIndex}-${CLASSIFIER_DIGEST}.json`;
      const baseClassificationPath = confinedStateFile(
        stateDir,
        baseClassificationPointer.path,
        "legacy base classification graph"
      );
      const baseClassification = object(
        JSON.parse(readFileSync(baseClassificationPath, "utf8")),
        baseClassificationPointer.path
      );
      const baseProblem = object(JSON.parse(readFileSync(confinedStateFile(
        stateDir,
        record.baseQuestion.problem.path,
        "legacy base problem graph"
      ), "utf8")), record.baseQuestion.problem.path);
      const baseQuestions = restoredQuizItems(baseProblem.items);
      if (!Array.isArray(baseClassification.items)) {
        throw new Error(`${record.key} legacy base classification items가 배열이 아닙니다`);
      }
      const baseQuestionByKey = new Map(baseQuestions.map((question) => [questionKey(question), question]));
      const baseDecisions = baseClassification.items.map((value, index) => {
        const key = exactString(
          object(value, `${baseClassificationPointer.path}.items[${index}]`).key,
          `${baseClassificationPointer.path}.items[${index}].key`,
          100
        );
        if (!baseQuestionByKey.has(key)) {
          throw new Error(`${baseClassificationPointer.path} legacy classification key가 다릅니다: ${key}`);
        }
        return parseHistoricalDecision(value, key, `${baseClassificationPointer.path}.items[${index}]`);
      });
      if (
        baseDecisions.length !== baseQuestions.length ||
        new Set(baseDecisions.map((decision) => decision.key)).size !== baseQuestions.length
      ) {
        throw new Error(`${baseClassificationPointer.path} legacy classification key coverage가 다릅니다`);
      }
      const baseDecision = baseDecisions.find((decision) => decision.key === record.key);
      if (!baseDecision) throw new Error(`${record.key} legacy base classification item이 없습니다`);
      const expectedBaseClassification = {
        version: 4,
        sourceHash: problem.sha256,
        from: baseProblem.from,
        to: baseProblem.to,
        ownedFrom: baseProblem.ownedFrom,
        ownedTo: baseProblem.ownedTo,
        rulesDigest: CLASSIFIER_DIGEST,
        transcriptionGateVersion: 1,
        transcriptionPromptDigest:
          "d5c9f2a9cdf24a7249fe99d32b940775b72c95a1cab9016a60641672dc6a344a",
        model: IMPORT_MODEL,
        reasoningEffort: IMPORT_REASONING_EFFORT,
        items: baseDecisions,
      };
      const classification = parseHistoricalDecision(checkpoint.item, record.key, `${relativePath}.item`);
      const expectedCheckpoint = {
        version: 3,
        entryId: entry.id,
        key: record.key,
        sourceHash: problem.sha256,
        contextFrom: record.baseQuestion.contextFrom,
        contextTo: record.baseQuestion.contextTo,
        problemArtifact: {
          path: record.problemArtifact.path,
          sha256: record.problemArtifact.sha256,
        },
        baseClassificationCheckpoint: baseClassificationPointer,
        baseClassificationHash: canonicalEvidenceHash(baseDecision),
        effectiveQuestionHash: canonicalEvidenceHash(record.question),
        classifierVersion: 4,
        rulesDigest: CLASSIFIER_DIGEST,
        transcriptionGateVersion: 1,
        transcriptionPromptDigest:
          "d5c9f2a9cdf24a7249fe99d32b940775b72c95a1cab9016a60641672dc6a344a",
        model: IMPORT_MODEL,
        reasoningEffort: IMPORT_REASONING_EFFORT,
        item: classification,
      };
      if (
        baseClassificationPointer.path !== expectedBaseClassificationPath ||
        await sha256File(baseClassificationPath) !== baseClassificationPointer.sha256 ||
        canonicalEvidenceHash(baseClassification) !== canonicalEvidenceHash(expectedBaseClassification) ||
        baseClassificationPointer.sha256 !== canonicalEvidenceHash(baseClassification) ||
        canonicalEvidenceHash(checkpoint) !== canonicalEvidenceHash(expectedCheckpoint) ||
        await sha256File(path) !== canonicalEvidenceHash(checkpoint)
      ) throw new Error(`${record.key} legacy classification repair exact envelope가 다릅니다`);
    }
  }

  for (const partial of pendingGroups) {
    const contextFrom = partial[0].baseQuestion.contextFrom;
    const contextTo = partial[0].baseQuestion.contextTo;
    const classificationBasis = partial.map((record) => ({
      key: record.key,
      problemAuthority: { key: record.key, ...record.problemArtifact },
      effectiveQuestionHash: canonicalEvidenceHash(record.question),
      baseClassificationCheckpoint: record.baseQuestion.classification,
      baseClassificationHash: record.baseQuestion.classificationHash,
    }));
    const overlayDigest = canonicalEvidenceHash(classificationBasis);
    const classificationRelativePath = `classification-repair-batches/v${CLASSIFICATION_REPAIR_BATCH_VERSION}-` +
      `${String(contextFrom).padStart(4, "0")}-${String(contextTo).padStart(4, "0")}-` +
      `${overlayDigest}-${CLASSIFIER_DIGEST}.json`;
    const classificationPath = join(stateDir, classificationRelativePath);
    const decisions = await withImporterPdfForAnalysis(problem, (analysisProblem) =>
      withProblemContextSlice(analysisProblem.path, contextFrom, contextTo, (contextPath) =>
        classifyQuestions(entry, contextPath, contextFrom, contextTo, partial.map((record) => record.question))
      )
    );
    const classificationCheckpoint = {
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
    const classificationSha = await sha256File(classificationPath);
    if (classificationSha !== canonicalEvidenceHash(classificationCheckpoint)) {
      throw new Error("persisted problem repair v2 partial classification hash가 다릅니다");
    }
    const decisionByKey = new Map(decisions.map((decision) => [decision.key, decision]));
    for (const record of partial) {
      const classification = decisionByKey.get(record.key);
      if (!classification || hydrated.has(record.key)) {
        throw new Error(`${record.key} persisted problem repair v2 partial classification이 없습니다`);
      }
      hydrated.set(record.key, {
        classified: { question: record.question, classification },
        evidence: {
          key: record.key,
          printedNumber: String(numericPrintedLocator(record.original.question.number)!),
          sourcePage: record.original.question.page!,
          contextFrom,
          contextTo,
          baseProblemCheckpoint: record.baseQuestion.problem,
          baseClassificationCheckpoint: record.baseQuestion.classification,
          baseSolutionCheckpoint: record.baseSolution.checkpoint,
          problemArtifact: { path: record.problemArtifact.path, sha256: record.problemArtifact.sha256 },
          problemArtifactItemHash: record.problemArtifact.itemHash,
          classificationArtifact: {
            path: classificationRelativePath,
            sha256: classificationSha,
            rulesDigest: CLASSIFIER_DIGEST,
            transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
            transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
          },
          classificationArtifactItemHash: canonicalEvidenceHash(classification),
          baseQuestionHash: record.baseQuestion.questionHash,
          effectiveQuestionHash: canonicalEvidenceHash(record.question),
          baseClassificationHash: record.baseQuestion.classificationHash,
          effectiveClassificationHash: canonicalEvidenceHash(classification),
          baseSolutionItemHash: record.baseSolution.itemHash,
          officialRawAnswerHash: sha256Text(record.solution.answer),
        },
      });
    }
  }
  return [...hydrated.values()].sort((left, right) =>
    compareCorpusQuestionKeys(left.evidence.key, right.evidence.key)
  );
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
  trigger: ProblemRecoveryTrigger;
};

function problemCropAdjudicationSpec(
  entry: CorpusManifestEntry,
  key: string,
  sourcePage: number,
  sourceHash: string
): ProblemCropAdjudicationSpec | null {
  const matches = PROBLEM_CROP_ADJUDICATION_ALLOWLIST.filter((spec) =>
    spec.entryId === entry.id && spec.key === key && spec.sourcePage === sourcePage
  );
  if (matches.length > 1) throw new Error(`${entry.id} ${key} crop adjudication allowlist가 중복입니다`);
  const match = matches[0];
  if (match && match.sourceHash !== sourceHash) {
    throw new Error(`${entry.id} ${key} crop adjudication source hash가 allowlist와 다릅니다`);
  }
  return match ?? null;
}

export function assertProblemCropAdjudicationTokens(item: QuizItemEx, requiredTokens: readonly string[]): void {
  const source = [item.question, ...(item.choices ?? []), item.figure_description ?? ""]
    .join("\n").replace(/\s+/gu, "");
  const missing = requiredTokens.filter((token) => !source.includes(token.replace(/\s+/gu, "")));
  if (missing.length > 0) {
    throw new Error(`${questionKey(item)} crop adjudication 필수 source token 누락: ${missing.join(", ")}`);
  }
}

function problemManualAdjudicationSpec(
  entryId: string,
  key: string,
  sourcePage: number,
  sourceHash: string
): ProblemManualAdjudicationSpec | null {
  const matches = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.filter((spec) =>
    spec.entryId === entryId && spec.key === key && spec.sourcePage === sourcePage
  );
  if (matches.length > 1) throw new Error(`${entryId} ${key} manual adjudication allowlist가 중복입니다`);
  const match = matches[0];
  if (match && match.sourceHash !== sourceHash) {
    throw new Error(`${entryId} ${key} manual adjudication source hash가 allowlist와 다릅니다`);
  }
  return match ?? null;
}

function exactOccurrenceCount(source: string, target: string): number {
  if (!target) throw new Error("manual adjudication replacement target이 비어 있습니다");
  let count = 0;
  let offset = 0;
  for (;;) {
    const index = source.indexOf(target, offset);
    if (index < 0) return count;
    count++;
    offset = index + target.length;
  }
}

function problemManualCorrectionSpecHash(spec: ProblemManualAdjudicationSpec): string {
  return canonicalEvidenceHash({
    allowlistId: spec.allowlistId,
    parentKind: spec.parentKind,
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

function matchesProblemManualExpectedDecision(
  spec: ProblemManualAdjudicationSpec,
  classification: Pick<ClassificationDecision,
    "decision" | "canonical_subject" | "curriculum_course" | "domain" | "achievement_codes">
): boolean {
  if (!spec.expectedDecision) return true;
  if (spec.expectedDecision === "reject") {
    return classification.decision === "reject" && classification.canonical_subject === null &&
      classification.curriculum_course === null && classification.domain === null &&
      classification.achievement_codes.length === 0;
  }
  return classification.decision === "accept" &&
    classification.canonical_subject === spec.expectedCanonicalSubject &&
    classification.curriculum_course !== null && classification.domain !== null &&
    classification.achievement_codes.length > 0;
}

export function applyAllowlistedProblemManualCorrection(
  entryId: string,
  sourceHash: string,
  item: QuizItemEx
): QuizItemEx {
  const key = questionKey(item);
  const spec = problemManualAdjudicationSpec(entryId, key, item.page!, sourceHash);
  if (!spec) throw new Error(`${entryId} ${key} manual adjudication allowlist에 없습니다`);
  if (canonicalEvidenceHash(item) !== spec.failedQuestionHash) {
    throw new Error(`${entryId} ${key} manual adjudication failed question hash가 다릅니다`);
  }
  const corrected = structuredClone(item);
  for (const replacement of spec.replacements) {
    const current = replacement.field === "question"
      ? corrected.question
      : corrected.figure_description ?? "";
    if (exactOccurrenceCount(current, replacement.from) !== replacement.count) {
      throw new Error(`${key} manual adjudication replacement occurrence가 다릅니다: ${replacement.from}`);
    }
    const next = current.split(replacement.from).join(replacement.to);
    if (replacement.field === "question") corrected.question = next;
    else corrected.figure_description = next;
  }
  if (spec.figure !== undefined) corrected.figure = spec.figure;
  if (spec.figureDescription !== undefined) corrected.figure_description = spec.figureDescription;
  if (questionKey(corrected) !== key || corrected.page !== spec.sourcePage) {
    throw new Error(`${key} manual adjudication이 원본 key/page를 바꿨습니다`);
  }
  assertProblemCropAdjudicationTokens(corrected, spec.requiredTokens);
  if (canonicalEvidenceHash(corrected) === spec.failedQuestionHash) {
    throw new Error(`${key} manual adjudication이 문제를 바꾸지 않았습니다`);
  }
  return corrected;
}

async function adjudicateCropClassifiedQuestion(
  entry: CorpusManifestEntry,
  problem: PdfEvidence,
  stateDir: string,
  failed: ClassifiedQuestion,
  parentRecovery: ProblemRecoveryEvidence
): Promise<{ classified: ClassifiedQuestion; evidence: ProblemCropAdjudicationEvidence }> {
  const key = questionKey(failed.question);
  const sourcePage = failed.question.page!;
  const spec = problemCropAdjudicationSpec(entry, key, sourcePage, problem.sha256);
  if (!spec) throw new Error(`${key} crop adjudication allowlist에 없습니다`);
  if (
    parentRecovery.adjudication || parentRecovery.key !== key || parentRecovery.sourcePage !== sourcePage ||
    parentRecovery.sourceHash !== problem.sha256 || failed.classification.transcription_status === "exact" ||
    canonicalEvidenceHash(failed.question) !== parentRecovery.effectiveQuestionHash ||
    canonicalEvidenceHash(failed.classification) !== parentRecovery.effectiveClassificationHash
  ) throw new Error(`${key} crop adjudication 입력이 failed recovery와 다릅니다`);
  for (const [label, pointer] of [
    ["base problem repair", parentRecovery.baseProblemRepairArtifact],
    ["base classification repair", parentRecovery.baseClassificationRepairArtifact],
    ["base problem revision", parentRecovery.baseProblemRevisionArtifact],
    ["base classification revision", parentRecovery.baseClassificationRevisionArtifact],
    ["problem recovery", parentRecovery.problemArtifact],
    ["classification recovery", parentRecovery.classificationArtifact],
  ] as const) {
    const path = confinedStateFile(stateDir, pointer.path, `crop adjudication ${label}`);
    if (await sha256File(path) !== pointer.sha256) throw new Error(`${key} crop adjudication ${label} hash가 다릅니다`);
  }
  const parentRecoveryEvidenceHash = canonicalEvidenceHash(parentRecovery);
  const prepared = await prepareProblemCropEvidence(entry, problem, stateDir, spec);
  const sourcePages = [...new Set(spec.views.map((view) => view.sourcePage))].sort((a, b) => a - b);
  const commonBasis = {
    allowlistId: spec.allowlistId,
    entryId: entry.id,
    key,
    printedNumber: parentRecovery.printedNumber,
    sourcePage,
    sourcePages,
    sourceHash: problem.sha256,
    parentRecovery,
    parentRecoveryEvidenceHash,
    failedRecoveryQuestionHash: canonicalEvidenceHash(failed.question),
    failedRecoveryClassificationHash: canonicalEvidenceHash(failed.classification),
    failedRecoveryEvidenceHash: sha256Text(failed.classification.transcription_evidence),
    cropEvidenceArtifact: prepared.artifact,
    cropEvidencePdf: { path: prepared.pdf.path, sha256: prepared.pdf.sha256 },
    cropViews: prepared.views,
    requiredTokensHash: canonicalEvidenceHash(spec.requiredTokens),
  };
  const basisDigest = canonicalEvidenceHash(commonBasis);
  const stem = `v${PROBLEM_CROP_ADJUDICATION_VERSION}-${String(sourcePage).padStart(4, "0")}-` +
    `${parentRecovery.printedNumber.padStart(4, "0")}-${basisDigest}`;
  const problemRelativePath = `problem-crop-adjudications/${stem}.json`;
  const problemPath = join(stateDir, problemRelativePath);
  let problemCheckpoint: Record<string, unknown>;
  let adjudicated: QuizItemEx;
  if (existsSync(problemPath)) {
    const safeProblemPath = confinedStateFile(stateDir, problemRelativePath, "problem crop adjudication");
    problemCheckpoint = object(JSON.parse(readFileSync(safeProblemPath, "utf8")), problemRelativePath);
    if (
      problemCheckpoint.version !== PROBLEM_CROP_ADJUDICATION_VERSION || problemCheckpoint.entryId !== entry.id ||
      problemCheckpoint.basisDigest !== basisDigest ||
      canonicalEvidenceHash(problemCheckpoint.basis) !== canonicalEvidenceHash(commonBasis) ||
      problemCheckpoint.promptVersion !== TARGETED_PROBLEM_CROP_ADJUDICATION_VERSION ||
      problemCheckpoint.promptDigest !== TARGETED_PROBLEM_CROP_ADJUDICATION_PROMPT_DIGEST ||
      problemCheckpoint.model !== IMPORT_MODEL || problemCheckpoint.reasoningEffort !== IMPORT_REASONING_EFFORT
    ) throw new Error(`기존 problem crop adjudication 메타데이터가 다릅니다: ${problemPath}`);
    adjudicated = restoredQuizItems([problemCheckpoint.item])[0];
  } else {
    adjudicated = (await withTargetedAi(() => extractProblemsFromFile(prepared.pdf.absolutePath, "pdf", {
      sliceBase: sourcePages[0],
      contentPageCount: spec.views.length,
      selfContained: true,
      target: { page: sourcePage, printedNumber: parentRecovery.printedNumber },
      cropAdjudication: {
        evidence: failed.classification.transcription_evidence,
        views: spec.views.map(({ sourcePage: page, label }) => ({ sourcePage: page, label })),
        requiredTokens: spec.requiredTokens,
      },
      reasoningEffort: IMPORT_REASONING_EFFORT,
    })))[0];
    assertProblemCropAdjudicationTokens(adjudicated, spec.requiredTokens);
    problemCheckpoint = {
      version: PROBLEM_CROP_ADJUDICATION_VERSION,
      entryId: entry.id,
      basisDigest,
      basis: commonBasis,
      promptVersion: TARGETED_PROBLEM_CROP_ADJUDICATION_VERSION,
      promptDigest: TARGETED_PROBLEM_CROP_ADJUDICATION_PROMPT_DIGEST,
      model: IMPORT_MODEL,
      reasoningEffort: IMPORT_REASONING_EFFORT,
      item: adjudicated,
    };
    await writeImmutableEvidence(problemPath, problemCheckpoint);
  }
  if (
    questionKey(adjudicated) !== key || adjudicated.page !== sourcePage ||
    numericPrintedLocator(adjudicated.number) !== Number(parentRecovery.printedNumber)
  ) throw new Error(`${key} crop adjudication이 원본 페이지·번호를 보존하지 않았습니다`);
  assertProblemCropAdjudicationTokens(adjudicated, spec.requiredTokens);
  const problemSha = await sha256File(problemPath);
  if (problemSha !== canonicalEvidenceHash(problemCheckpoint)) throw new Error(`${key} crop adjudication hash가 다릅니다`);
  const problemItemHash = canonicalEvidenceHash(adjudicated);
  const classificationBasis = {
    ...commonBasis,
    problemArtifact: { path: problemRelativePath, sha256: problemSha },
    problemArtifactItemHash: problemItemHash,
    effectiveQuestionHash: problemItemHash,
  };
  const classificationBasisDigest = canonicalEvidenceHash(classificationBasis);
  const classificationRelativePath = `classification-crop-adjudications/` +
    `v${CLASSIFICATION_CROP_ADJUDICATION_VERSION}-${String(sourcePage).padStart(4, "0")}-` +
    `${parentRecovery.printedNumber.padStart(4, "0")}-${classificationBasisDigest}-${CLASSIFIER_DIGEST}.json`;
  const classificationPath = join(stateDir, classificationRelativePath);
  const mappingNote = `${PROBLEM_CROP_ADJUDICATION_CLASSIFICATION_RULES} Evidence mapping: ` +
    spec.views.map((view, index) => `view ${index + 1}=${view.label}, original page ${view.sourcePage}`).join("; ") +
    `. Required source anchors: ${spec.requiredTokens.join(" | ")}.`;
  let classificationCheckpoint: Record<string, unknown>;
  let classification: ClassificationDecision;
  if (existsSync(classificationPath)) {
    const safeClassificationPath = confinedStateFile(
      stateDir,
      classificationRelativePath,
      "classification crop adjudication"
    );
    classificationCheckpoint = object(JSON.parse(readFileSync(safeClassificationPath, "utf8")), classificationRelativePath);
    if (
      classificationCheckpoint.version !== CLASSIFICATION_CROP_ADJUDICATION_VERSION ||
      classificationCheckpoint.entryId !== entry.id || classificationCheckpoint.basisDigest !== classificationBasisDigest ||
      canonicalEvidenceHash(classificationCheckpoint.basis) !== canonicalEvidenceHash(classificationBasis) ||
      classificationCheckpoint.classifierVersion !== CLASSIFIER_VERSION ||
      classificationCheckpoint.rulesDigest !== CLASSIFIER_DIGEST ||
      classificationCheckpoint.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
      classificationCheckpoint.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST ||
      classificationCheckpoint.adjudicationPromptVersion !== TARGETED_PROBLEM_CROP_ADJUDICATION_VERSION ||
      classificationCheckpoint.adjudicationPromptDigest !== TARGETED_PROBLEM_CROP_ADJUDICATION_PROMPT_DIGEST ||
      classificationCheckpoint.classificationPromptDigest !==
        PROBLEM_CROP_ADJUDICATION_CLASSIFICATION_PROMPT_DIGEST ||
      classificationCheckpoint.model !== IMPORT_MODEL ||
      classificationCheckpoint.reasoningEffort !== IMPORT_REASONING_EFFORT
    ) throw new Error(`기존 classification crop adjudication 메타데이터가 다릅니다: ${classificationPath}`);
    classification = parseDecisions(classificationCheckpoint.items, [adjudicated], entry)[0];
  } else {
    classification = (await classifyQuestions(
      entry,
      prepared.pdf.absolutePath,
      sourcePages[0],
      sourcePages[sourcePages.length - 1],
      [adjudicated],
      { targeted: true, sourceEvidenceNote: mappingNote }
    ))[0];
    classificationCheckpoint = {
      version: CLASSIFICATION_CROP_ADJUDICATION_VERSION,
      entryId: entry.id,
      basisDigest: classificationBasisDigest,
      basis: classificationBasis,
      classifierVersion: CLASSIFIER_VERSION,
      rulesDigest: CLASSIFIER_DIGEST,
      transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
      adjudicationPromptVersion: TARGETED_PROBLEM_CROP_ADJUDICATION_VERSION,
      adjudicationPromptDigest: TARGETED_PROBLEM_CROP_ADJUDICATION_PROMPT_DIGEST,
      classificationPromptDigest: PROBLEM_CROP_ADJUDICATION_CLASSIFICATION_PROMPT_DIGEST,
      model: IMPORT_MODEL,
      reasoningEffort: IMPORT_REASONING_EFFORT,
      items: [classification],
    };
    await writeImmutableEvidence(classificationPath, classificationCheckpoint);
  }
  const classificationSha = await sha256File(classificationPath);
  if (classificationSha !== canonicalEvidenceHash(classificationCheckpoint)) {
    throw new Error(`${key} classification crop adjudication hash가 다릅니다`);
  }
  return {
    classified: { question: adjudicated, classification },
    evidence: {
      allowlistId: spec.allowlistId,
      key,
      printedNumber: parentRecovery.printedNumber,
      sourcePage,
      sourcePages,
      sourceHash: problem.sha256,
      parentRecoveryEvidenceHash,
      cropEvidenceArtifact: prepared.artifact,
      cropEvidencePdf: { path: prepared.pdf.path, sha256: prepared.pdf.sha256 },
      cropViews: prepared.views,
      problemArtifact: {
        path: problemRelativePath,
        sha256: problemSha,
        promptVersion: TARGETED_PROBLEM_CROP_ADJUDICATION_VERSION,
        promptDigest: TARGETED_PROBLEM_CROP_ADJUDICATION_PROMPT_DIGEST,
      },
      problemArtifactItemHash: problemItemHash,
      classificationArtifact: {
        path: classificationRelativePath,
        sha256: classificationSha,
        rulesDigest: CLASSIFIER_DIGEST,
        transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
        transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
        adjudicationPromptVersion: TARGETED_PROBLEM_CROP_ADJUDICATION_VERSION,
        adjudicationPromptDigest: TARGETED_PROBLEM_CROP_ADJUDICATION_PROMPT_DIGEST,
        classificationPromptDigest: PROBLEM_CROP_ADJUDICATION_CLASSIFICATION_PROMPT_DIGEST,
      },
      classificationArtifactItemHash: canonicalEvidenceHash(classification),
      baseQuestionHash: canonicalEvidenceHash(failed.question),
      effectiveQuestionHash: problemItemHash,
      baseClassificationHash: canonicalEvidenceHash(failed.classification),
      effectiveClassificationHash: canonicalEvidenceHash(classification),
    },
  };
}

async function adjudicateProblemManual(
  entry: CorpusManifestEntry,
  problem: PdfEvidence,
  stateDir: string,
  failed: ClassifiedQuestion,
  parentRecovery: ProblemRecoveryEvidence
): Promise<{ classified: ClassifiedQuestion; evidence: ProblemManualAdjudicationEvidence }> {
  const key = questionKey(failed.question);
  const sourcePage = failed.question.page!;
  const spec = problemManualAdjudicationSpec(entry.id, key, sourcePage, problem.sha256);
  if (!spec) throw new Error(`${key} manual adjudication allowlist에 없습니다`);
  if (problem.sha256 !== spec.sourceHash || await sha256File(problem.path) !== problem.sha256) {
    throw new Error(`${key} manual adjudication 공식 source bytes hash가 다릅니다`);
  }
  const parentQuestionHash = spec.parentKind === "crop"
    ? parentRecovery.adjudication?.effectiveQuestionHash
    : parentRecovery.effectiveQuestionHash;
  const parentClassificationHash = spec.parentKind === "crop"
    ? parentRecovery.adjudication?.effectiveClassificationHash
    : parentRecovery.effectiveClassificationHash;
  if (
    parentRecovery.manualAdjudication || parentRecovery.scopeAdjudication || parentRecovery.key !== key ||
    parentRecovery.sourcePage !== sourcePage || parentRecovery.sourceHash !== problem.sha256 ||
    (spec.parentKind === "crop") !== Boolean(parentRecovery.adjudication) ||
    canonicalEvidenceHash(failed.question) !== parentQuestionHash ||
    canonicalEvidenceHash(failed.classification) !== parentClassificationHash ||
    canonicalEvidenceHash(failed.question) !== spec.failedQuestionHash ||
    canonicalEvidenceHash(failed.classification) !== spec.failedClassificationHash ||
    sha256Text(failed.classification.transcription_evidence) !== spec.failedClassificationEvidenceHash ||
    failed.classification.transcription_status === "exact"
  ) throw new Error(`${key} manual adjudication 입력이 exhausted recovery와 다릅니다`);

  const pointers: Array<readonly [string, EvidencePointer]> = [
    ["base problem repair", parentRecovery.baseProblemRepairArtifact],
    ["base classification repair", parentRecovery.baseClassificationRepairArtifact],
    ["base problem revision", parentRecovery.baseProblemRevisionArtifact],
    ["base classification revision", parentRecovery.baseClassificationRevisionArtifact],
    ["problem recovery", parentRecovery.problemArtifact],
    ["classification recovery", parentRecovery.classificationArtifact],
  ];
  if (parentRecovery.adjudication) {
    pointers.push(
      ["crop evidence", parentRecovery.adjudication.cropEvidenceArtifact],
      ["crop evidence PDF", parentRecovery.adjudication.cropEvidencePdf],
      ...parentRecovery.adjudication.cropViews.map((view, index) =>
        [`crop view ${index + 1}`, view.artifact] as const
      ),
      ["problem crop adjudication", parentRecovery.adjudication.problemArtifact],
      ["classification crop adjudication", parentRecovery.adjudication.classificationArtifact],
    );
  }
  for (const [label, pointer] of pointers) {
    const path = confinedStateFile(stateDir, pointer.path, `manual adjudication ${label}`);
    if (await sha256File(path) !== pointer.sha256) throw new Error(`${key} manual adjudication ${label} hash가 다릅니다`);
  }

  const prepared: PreparedProblemCropEvidence = parentRecovery.adjudication
    ? {
        artifact: parentRecovery.adjudication.cropEvidenceArtifact,
        pdf: {
          ...parentRecovery.adjudication.cropEvidencePdf,
          absolutePath: confinedStateFile(
            stateDir,
            parentRecovery.adjudication.cropEvidencePdf.path,
            "manual adjudication crop evidence PDF"
          ),
        },
        views: parentRecovery.adjudication.cropViews,
      }
    : await prepareProblemCropEvidence(entry, problem, stateDir, spec, {
        namespace: "problem-manual-evidence",
        version: PROBLEM_MANUAL_ADJUDICATION_VERSION,
        dpi: spec.dpi ?? PROBLEM_CROP_DPI,
      });
  if (
    canonicalEvidenceHash(prepared.views.map(({ sourcePage: page, label, rect }) => ({ sourcePage: page, label, rect }))) !==
      canonicalEvidenceHash(spec.views) ||
    await sha256File(prepared.pdf.absolutePath) !== prepared.pdf.sha256
  ) throw new Error(`${key} manual adjudication crop evidence가 allowlist와 다릅니다`);

  const parentRecoveryEvidenceHash = canonicalEvidenceHash(parentRecovery);
  const parentCropAdjudicationHash = parentRecovery.adjudication
    ? canonicalEvidenceHash(parentRecovery.adjudication)
    : undefined;
  const correctionSpecHash = problemManualCorrectionSpecHash(spec);
  const sourcePages = [...new Set(spec.views.map((view) => view.sourcePage))].sort((a, b) => a - b);
  const commonBasis = {
    allowlistId: spec.allowlistId,
    entryId: entry.id,
    key,
    printedNumber: parentRecovery.printedNumber,
    sourcePage,
    sourcePages,
    sourceHash: problem.sha256,
    parentRecovery,
    parentRecoveryEvidenceHash,
    ...(parentCropAdjudicationHash ? { parentCropAdjudicationHash } : {}),
    failedQuestionHash: spec.failedQuestionHash,
    failedClassificationHash: spec.failedClassificationHash,
    failedClassificationEvidenceHash: spec.failedClassificationEvidenceHash,
    correctionSpecHash,
    cropEvidenceArtifact: prepared.artifact,
    cropEvidencePdf: { path: prepared.pdf.path, sha256: prepared.pdf.sha256 },
    cropViews: prepared.views,
  };
  const basisDigest = canonicalEvidenceHash(commonBasis);
  const stem = `v${PROBLEM_MANUAL_ADJUDICATION_VERSION}-${String(sourcePage).padStart(4, "0")}-` +
    `${parentRecovery.printedNumber.padStart(4, "0")}-${basisDigest}`;
  const problemRelativePath = `problem-manual-adjudications/${stem}.json`;
  const problemPath = join(stateDir, problemRelativePath);
  let problemCheckpoint: Record<string, unknown>;
  let corrected: QuizItemEx;
  if (existsSync(problemPath)) {
    const safePath = confinedStateFile(stateDir, problemRelativePath, "problem manual adjudication");
    problemCheckpoint = object(JSON.parse(readFileSync(safePath, "utf8")), problemRelativePath);
    if (
      problemCheckpoint.version !== PROBLEM_MANUAL_ADJUDICATION_VERSION ||
      problemCheckpoint.entryId !== entry.id || problemCheckpoint.basisDigest !== basisDigest ||
      canonicalEvidenceHash(problemCheckpoint.basis) !== canonicalEvidenceHash(commonBasis) ||
      problemCheckpoint.correctionVersion !== PROBLEM_MANUAL_ADJUDICATION_VERSION ||
      problemCheckpoint.correctionDigest !== PROBLEM_MANUAL_CORRECTION_DIGEST
    ) throw new Error(`기존 problem manual adjudication 메타데이터가 다릅니다: ${problemPath}`);
    corrected = restoredQuizItems([problemCheckpoint.item])[0];
  } else {
    corrected = applyAllowlistedProblemManualCorrection(entry.id, problem.sha256, failed.question);
    problemCheckpoint = {
      version: PROBLEM_MANUAL_ADJUDICATION_VERSION,
      entryId: entry.id,
      basisDigest,
      basis: commonBasis,
      correctionVersion: PROBLEM_MANUAL_ADJUDICATION_VERSION,
      correctionDigest: PROBLEM_MANUAL_CORRECTION_DIGEST,
      item: corrected,
    };
    await writeImmutableEvidence(problemPath, problemCheckpoint);
  }
  const expectedCorrected = applyAllowlistedProblemManualCorrection(entry.id, problem.sha256, failed.question);
  if (
    canonicalEvidenceHash(corrected) !== canonicalEvidenceHash(expectedCorrected) ||
    questionKey(corrected) !== key || corrected.page !== sourcePage ||
    numericPrintedLocator(corrected.number) !== Number(parentRecovery.printedNumber)
  ) throw new Error(`${key} manual adjudication corrected item이 allowlist와 다릅니다`);
  const problemSha = await sha256File(problemPath);
  if (problemSha !== canonicalEvidenceHash(problemCheckpoint)) throw new Error(`${key} manual adjudication hash가 다릅니다`);
  const problemItemHash = canonicalEvidenceHash(corrected);
  const classificationBasis = {
    ...commonBasis,
    problemArtifact: { path: problemRelativePath, sha256: problemSha },
    problemArtifactItemHash: problemItemHash,
    effectiveQuestionHash: problemItemHash,
  };
  const classificationBasisDigest = canonicalEvidenceHash(classificationBasis);
  const classificationRelativePath = `classification-manual-adjudications/` +
    `v${CLASSIFICATION_MANUAL_ADJUDICATION_VERSION}-${String(sourcePage).padStart(4, "0")}-` +
    `${parentRecovery.printedNumber.padStart(4, "0")}-${classificationBasisDigest}-${CLASSIFIER_DIGEST}.json`;
  const classificationPath = join(stateDir, classificationRelativePath);
  const mappingNote = `${PROBLEM_MANUAL_ADJUDICATION_RULES} Evidence mapping: ` +
    spec.views.map((view, index) => `view ${index + 1}=${view.label}, original page ${view.sourcePage}`).join("; ") +
    `. Required source anchors: ${spec.requiredTokens.join(" | ")}.`;
  let classificationCheckpoint: Record<string, unknown>;
  let classification: ClassificationDecision;
  if (existsSync(classificationPath)) {
    const safePath = confinedStateFile(stateDir, classificationRelativePath, "classification manual adjudication");
    classificationCheckpoint = object(JSON.parse(readFileSync(safePath, "utf8")), classificationRelativePath);
    if (
      classificationCheckpoint.version !== CLASSIFICATION_MANUAL_ADJUDICATION_VERSION ||
      classificationCheckpoint.entryId !== entry.id || classificationCheckpoint.basisDigest !== classificationBasisDigest ||
      canonicalEvidenceHash(classificationCheckpoint.basis) !== canonicalEvidenceHash(classificationBasis) ||
      classificationCheckpoint.classifierVersion !== CLASSIFIER_VERSION ||
      classificationCheckpoint.rulesDigest !== CLASSIFIER_DIGEST ||
      classificationCheckpoint.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
      classificationCheckpoint.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST ||
      classificationCheckpoint.adjudicationVersion !== PROBLEM_MANUAL_ADJUDICATION_VERSION ||
      classificationCheckpoint.adjudicationPromptDigest !== PROBLEM_MANUAL_ADJUDICATION_PROMPT_DIGEST ||
      classificationCheckpoint.model !== IMPORT_MODEL ||
      classificationCheckpoint.reasoningEffort !== IMPORT_REASONING_EFFORT
    ) throw new Error(`기존 classification manual adjudication 메타데이터가 다릅니다: ${classificationPath}`);
    classification = parseDecisions(classificationCheckpoint.items, [corrected], entry)[0];
  } else {
    classification = (await classifyQuestions(
      entry,
      prepared.pdf.absolutePath,
      sourcePages[0],
      sourcePages[sourcePages.length - 1],
      [corrected],
      { targeted: true, sourceEvidenceNote: mappingNote }
    ))[0];
    classificationCheckpoint = {
      version: CLASSIFICATION_MANUAL_ADJUDICATION_VERSION,
      entryId: entry.id,
      basisDigest: classificationBasisDigest,
      basis: classificationBasis,
      classifierVersion: CLASSIFIER_VERSION,
      rulesDigest: CLASSIFIER_DIGEST,
      transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
      adjudicationVersion: PROBLEM_MANUAL_ADJUDICATION_VERSION,
      adjudicationPromptDigest: PROBLEM_MANUAL_ADJUDICATION_PROMPT_DIGEST,
      model: IMPORT_MODEL,
      reasoningEffort: IMPORT_REASONING_EFFORT,
      items: [classification],
    };
    await writeImmutableEvidence(classificationPath, classificationCheckpoint);
  }
  const classificationSha = await sha256File(classificationPath);
  if (classificationSha !== canonicalEvidenceHash(classificationCheckpoint)) {
    throw new Error(`${key} classification manual adjudication hash가 다릅니다`);
  }
  if (
    classification.transcription_status !== "exact" ||
    !matchesProblemManualExpectedDecision(spec, classification)
  ) {
    throw new Error(`${key} allowlisted manual adjudication도 exact가 아닙니다`);
  }
  return {
    classified: { question: corrected, classification },
    evidence: {
      allowlistId: spec.allowlistId,
      key,
      printedNumber: parentRecovery.printedNumber,
      sourcePage,
      sourcePages,
      sourceHash: problem.sha256,
      parentRecoveryEvidenceHash,
      ...(parentCropAdjudicationHash ? { parentCropAdjudicationHash } : {}),
      failedQuestionHash: spec.failedQuestionHash,
      failedClassificationHash: spec.failedClassificationHash,
      failedClassificationEvidenceHash: spec.failedClassificationEvidenceHash,
      correctionSpecHash,
      cropEvidenceArtifact: prepared.artifact,
      cropEvidencePdf: { path: prepared.pdf.path, sha256: prepared.pdf.sha256 },
      cropViews: prepared.views,
      problemArtifact: {
        path: problemRelativePath,
        sha256: problemSha,
        correctionVersion: PROBLEM_MANUAL_ADJUDICATION_VERSION,
        correctionDigest: PROBLEM_MANUAL_CORRECTION_DIGEST,
      },
      problemArtifactItemHash: problemItemHash,
      classificationArtifact: {
        path: classificationRelativePath,
        sha256: classificationSha,
        rulesDigest: CLASSIFIER_DIGEST,
        transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
        transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
        adjudicationVersion: PROBLEM_MANUAL_ADJUDICATION_VERSION,
        adjudicationPromptDigest: PROBLEM_MANUAL_ADJUDICATION_PROMPT_DIGEST,
      },
      classificationArtifactItemHash: canonicalEvidenceHash(classification),
      baseQuestionHash: spec.failedQuestionHash,
      effectiveQuestionHash: problemItemHash,
      baseClassificationHash: spec.failedClassificationHash,
      effectiveClassificationHash: canonicalEvidenceHash(classification),
    },
  };
}

async function assertProblemCropAdjudicationAuthority(
  stateDir: string,
  repairs: Iterable<ProblemRepairEvidence>
): Promise<void> {
  const declared = new Map<string, string>();
  for (const repair of repairs) {
    const adjudication = repair.revision?.recovery?.adjudication;
    if (!adjudication) continue;
    for (const [label, pointer] of [
      ["crop evidence", adjudication.cropEvidenceArtifact],
      ["crop evidence PDF", adjudication.cropEvidencePdf],
      ...adjudication.cropViews.map((view, index) => [`crop view ${index + 1}`, view.artifact] as const),
      ["problem crop adjudication", adjudication.problemArtifact],
      ["classification crop adjudication", adjudication.classificationArtifact],
    ] as const) {
      if (declared.has(pointer.path)) throw new Error(`crop adjudication artifact가 중복 선언됐습니다: ${pointer.path}`);
      const path = confinedStateFile(stateDir, pointer.path, label);
      if (await sha256File(path) !== pointer.sha256) throw new Error(`${label} hash가 다릅니다: ${pointer.path}`);
      declared.set(pointer.path, pointer.sha256);
    }
  }
  const actual = new Set<string>();
  for (const directory of [
    "problem-crop-evidence",
    "problem-crop-adjudications",
    "classification-crop-adjudications",
  ]) {
    const path = join(stateDir, directory);
    if (!existsSync(path)) continue;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".tmp")) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`crop adjudication directory에 regular file이 아닌 항목이 있습니다: ${directory}/${entry.name}`);
      actual.add(`${directory}/${entry.name}`);
    }
  }
  const extras = [...actual].filter((path) => !declared.has(path));
  const missing = [...declared.keys()].filter((path) => !actual.has(path));
  if (extras.length > 0 || missing.length > 0) {
    throw new Error(`crop adjudication orphan/conflict: extra=${extras.join(",") || "-"}, missing=${missing.join(",") || "-"}`);
  }
}

async function assertProblemManualAdjudicationAuthority(
  stateDir: string,
  repairs: Iterable<ProblemRepairEvidence>
): Promise<void> {
  const declared = new Map<string, string>();
  const declare = async (label: string, pointer: EvidencePointer, manualDirectory = true): Promise<void> => {
    const path = confinedStateFile(stateDir, pointer.path, label);
    if (await sha256File(path) !== pointer.sha256) throw new Error(`${label} hash가 다릅니다: ${pointer.path}`);
    if (!manualDirectory) return;
    if (declared.has(pointer.path)) throw new Error(`manual adjudication artifact가 중복 선언됐습니다: ${pointer.path}`);
    declared.set(pointer.path, pointer.sha256);
  };
  for (const repair of repairs) {
    const recovery = repair.revision?.recovery;
    const manual = recovery?.manualAdjudication;
    if (!recovery || !manual) continue;
    const { manualAdjudication: _manualAdjudication, ...parentRecovery } = recovery;
    const matches = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.filter((candidate) =>
      candidate.allowlistId === manual.allowlistId && candidate.key === manual.key &&
      candidate.sourcePage === manual.sourcePage && candidate.sourceHash === manual.sourceHash
    );
    if (matches.length !== 1) throw new Error(`${repair.key} manual adjudication allowlist authority가 없습니다`);
    const spec = matches[0];
    const parentCrop = parentRecovery.adjudication;
    const expectedParentQuestionHash = spec.parentKind === "crop"
      ? parentCrop?.effectiveQuestionHash
      : parentRecovery.effectiveQuestionHash;
    const expectedParentClassificationHash = spec.parentKind === "crop"
      ? parentCrop?.effectiveClassificationHash
      : parentRecovery.effectiveClassificationHash;
    if (
      repair.key !== manual.key || manual.printedNumber !== parentRecovery.printedNumber || recovery.scopeAdjudication ||
      canonicalEvidenceHash(parentRecovery) !== manual.parentRecoveryEvidenceHash ||
      (spec.parentKind === "crop") !== Boolean(parentCrop) ||
      (parentCrop ? canonicalEvidenceHash(parentCrop) : undefined) !== manual.parentCropAdjudicationHash ||
      manual.failedQuestionHash !== spec.failedQuestionHash ||
      manual.failedQuestionHash !== expectedParentQuestionHash ||
      manual.failedClassificationHash !== spec.failedClassificationHash ||
      manual.failedClassificationHash !== expectedParentClassificationHash ||
      manual.failedClassificationEvidenceHash !== spec.failedClassificationEvidenceHash ||
      manual.correctionSpecHash !== problemManualCorrectionSpecHash(spec) ||
      manual.baseQuestionHash !== spec.failedQuestionHash ||
      manual.baseClassificationHash !== spec.failedClassificationHash ||
      manual.effectiveQuestionHash !== manual.problemArtifactItemHash ||
      manual.effectiveClassificationHash !== manual.classificationArtifactItemHash ||
      canonicalEvidenceHash(manual.sourcePages) !== canonicalEvidenceHash(
        [...new Set(spec.views.map((view) => view.sourcePage))].sort((a, b) => a - b)
      ) ||
      canonicalEvidenceHash(manual.cropViews.map(({ sourcePage, label, rect }) => ({ sourcePage, label, rect }))) !==
        canonicalEvidenceHash(spec.views)
    ) throw new Error(`${repair.key} manual adjudication evidence가 allowlist/parent와 다릅니다`);

    const isManualEvidence = spec.parentKind === "recovery";
    await declare("manual crop evidence", manual.cropEvidenceArtifact, isManualEvidence);
    await declare("manual crop evidence PDF", manual.cropEvidencePdf, isManualEvidence);
    for (const [index, view] of manual.cropViews.entries()) {
      if (view.pixelSha256 !== view.artifact.sha256) {
        throw new Error(`${repair.key} manual crop view ${index + 1} pixel/artifact hash가 다릅니다`);
      }
      await declare(`manual crop view ${index + 1}`, view.artifact, isManualEvidence);
      const dimensions = pngDimensions(confinedStateFile(stateDir, view.artifact.path, `manual crop view ${index + 1}`));
      if (dimensions.width !== view.pixelWidth || dimensions.height !== view.pixelHeight) {
        throw new Error(`${repair.key} manual crop view ${index + 1} 크기가 다릅니다`);
      }
    }
    await declare("problem manual adjudication", manual.problemArtifact);
    await declare("classification manual adjudication", manual.classificationArtifact);

    if (isManualEvidence) {
      const manualDpi = spec.dpi ?? PROBLEM_CROP_DPI;
      const evidenceBasis = {
        allowlistId: spec.allowlistId,
        entryId: spec.entryId,
        key: spec.key,
        sourcePage: spec.sourcePage,
        sourcePages: manual.sourcePages,
        sourceHash: spec.sourceHash,
        dpi: manualDpi,
        views: spec.views,
        requiredTokens: spec.requiredTokens,
      };
      const evidenceDigest = canonicalEvidenceHash(evidenceBasis);
      const evidenceStem = `v${PROBLEM_MANUAL_ADJUDICATION_VERSION}-${String(spec.sourcePage).padStart(4, "0")}-` +
        `${spec.key.split(":")[1]!.padStart(4, "0")}-${evidenceDigest}`;
      const expectedArtifactPath = `problem-manual-evidence/${evidenceStem}.json`;
      const expectedPdfPath = `problem-manual-evidence/${evidenceStem}.pdf`;
      const checkpoint = object(
        JSON.parse(readFileSync(confinedStateFile(stateDir, expectedArtifactPath, "manual evidence checkpoint"), "utf8")),
        expectedArtifactPath
      );
      if (
        manual.cropEvidenceArtifact.path !== expectedArtifactPath || manual.cropEvidencePdf.path !== expectedPdfPath ||
        checkpoint.version !== PROBLEM_MANUAL_ADJUDICATION_VERSION || checkpoint.entryId !== spec.entryId ||
        checkpoint.basisDigest !== evidenceDigest ||
        canonicalEvidenceHash(checkpoint.basis) !== canonicalEvidenceHash(evidenceBasis) ||
        checkpoint.renderer !== "pdftocairo-png+pdf-lib" || checkpoint.dpi !== manualDpi ||
        canonicalEvidenceHash(checkpoint.evidencePdf) !== canonicalEvidenceHash(manual.cropEvidencePdf) ||
        canonicalEvidenceHash(checkpoint.views) !== canonicalEvidenceHash(manual.cropViews) ||
        manual.cropViews.some((view, index) => view.artifact.path !==
          `problem-manual-evidence/${evidenceStem}-view-${String(index).padStart(2, "0")}.png`)
      ) throw new Error(`${repair.key} manual crop evidence checkpoint가 다릅니다`);
    } else if (
      !parentCrop ||
      canonicalEvidenceHash(manual.cropEvidenceArtifact) !== canonicalEvidenceHash(parentCrop.cropEvidenceArtifact) ||
      canonicalEvidenceHash(manual.cropEvidencePdf) !== canonicalEvidenceHash(parentCrop.cropEvidencePdf) ||
      canonicalEvidenceHash(manual.cropViews) !== canonicalEvidenceHash(parentCrop.cropViews)
    ) throw new Error(`${repair.key} manual adjudication이 parent crop evidence를 바꿨습니다`);

    const commonBasis = {
      allowlistId: spec.allowlistId,
      entryId: spec.entryId,
      key: spec.key,
      printedNumber: manual.printedNumber,
      sourcePage: spec.sourcePage,
      sourcePages: manual.sourcePages,
      sourceHash: spec.sourceHash,
      parentRecovery,
      parentRecoveryEvidenceHash: manual.parentRecoveryEvidenceHash,
      ...(manual.parentCropAdjudicationHash
        ? { parentCropAdjudicationHash: manual.parentCropAdjudicationHash }
        : {}),
      failedQuestionHash: manual.failedQuestionHash,
      failedClassificationHash: manual.failedClassificationHash,
      failedClassificationEvidenceHash: manual.failedClassificationEvidenceHash,
      correctionSpecHash: manual.correctionSpecHash,
      cropEvidenceArtifact: manual.cropEvidenceArtifact,
      cropEvidencePdf: manual.cropEvidencePdf,
      cropViews: manual.cropViews,
    };
    const basisDigest = canonicalEvidenceHash(commonBasis);
    const stem = `v${PROBLEM_MANUAL_ADJUDICATION_VERSION}-${String(spec.sourcePage).padStart(4, "0")}-` +
      `${manual.printedNumber.padStart(4, "0")}-${basisDigest}`;
    const expectedProblemPath = `problem-manual-adjudications/${stem}.json`;
    const problemCheckpoint = object(
      JSON.parse(readFileSync(confinedStateFile(stateDir, expectedProblemPath, "problem manual adjudication"), "utf8")),
      expectedProblemPath
    );
    const failedArtifact = spec.parentKind === "crop" ? parentCrop!.problemArtifact : parentRecovery.problemArtifact;
    const failedCheckpoint = object(
      JSON.parse(readFileSync(confinedStateFile(stateDir, failedArtifact.path, "manual parent problem"), "utf8")),
      failedArtifact.path
    );
    const failedItem = restoredQuizItems([failedCheckpoint.item])[0];
    const expectedItem = applyAllowlistedProblemManualCorrection(spec.entryId, spec.sourceHash, failedItem);
    if (
      manual.problemArtifact.path !== expectedProblemPath ||
      problemCheckpoint.version !== PROBLEM_MANUAL_ADJUDICATION_VERSION ||
      problemCheckpoint.entryId !== spec.entryId || problemCheckpoint.basisDigest !== basisDigest ||
      canonicalEvidenceHash(problemCheckpoint.basis) !== canonicalEvidenceHash(commonBasis) ||
      problemCheckpoint.correctionVersion !== PROBLEM_MANUAL_ADJUDICATION_VERSION ||
      problemCheckpoint.correctionDigest !== PROBLEM_MANUAL_CORRECTION_DIGEST ||
      manual.problemArtifact.correctionVersion !== PROBLEM_MANUAL_ADJUDICATION_VERSION ||
      manual.problemArtifact.correctionDigest !== PROBLEM_MANUAL_CORRECTION_DIGEST ||
      numericPrintedLocator(expectedItem.number) !== Number(manual.printedNumber) ||
      canonicalEvidenceHash(problemCheckpoint.item) !== canonicalEvidenceHash(expectedItem) ||
      canonicalEvidenceHash(expectedItem) !== manual.problemArtifactItemHash
    ) throw new Error(`${repair.key} problem manual adjudication checkpoint가 다릅니다`);

    const classificationBasis = {
      ...commonBasis,
      problemArtifact: { path: expectedProblemPath, sha256: manual.problemArtifact.sha256 },
      problemArtifactItemHash: manual.problemArtifactItemHash,
      effectiveQuestionHash: manual.effectiveQuestionHash,
    };
    const classificationBasisDigest = canonicalEvidenceHash(classificationBasis);
    const expectedClassificationPath = `classification-manual-adjudications/` +
      `v${CLASSIFICATION_MANUAL_ADJUDICATION_VERSION}-${String(spec.sourcePage).padStart(4, "0")}-` +
      `${manual.printedNumber.padStart(4, "0")}-${classificationBasisDigest}-${CLASSIFIER_DIGEST}.json`;
    const classificationCheckpoint = object(
      JSON.parse(readFileSync(confinedStateFile(
        stateDir,
        expectedClassificationPath,
        "classification manual adjudication"
      ), "utf8")),
      expectedClassificationPath
    );
    const manualClassification = Array.isArray(classificationCheckpoint.items) &&
      classificationCheckpoint.items.length === 1
      ? object(classificationCheckpoint.items[0], "manual classification item")
      : null;
    const expectedDecisionMismatch = Boolean(spec.expectedDecision) && (
      !manualClassification || !Array.isArray(manualClassification.achievement_codes) ||
      !matchesProblemManualExpectedDecision(
        spec,
        manualClassification as unknown as ClassificationDecision
      )
    );
    if (
      manual.classificationArtifact.path !== expectedClassificationPath ||
      classificationCheckpoint.version !== CLASSIFICATION_MANUAL_ADJUDICATION_VERSION ||
      classificationCheckpoint.entryId !== spec.entryId ||
      classificationCheckpoint.basisDigest !== classificationBasisDigest ||
      canonicalEvidenceHash(classificationCheckpoint.basis) !== canonicalEvidenceHash(classificationBasis) ||
      classificationCheckpoint.classifierVersion !== CLASSIFIER_VERSION ||
      classificationCheckpoint.rulesDigest !== CLASSIFIER_DIGEST ||
      classificationCheckpoint.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
      classificationCheckpoint.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST ||
      classificationCheckpoint.adjudicationVersion !== PROBLEM_MANUAL_ADJUDICATION_VERSION ||
      classificationCheckpoint.adjudicationPromptDigest !== PROBLEM_MANUAL_ADJUDICATION_PROMPT_DIGEST ||
      classificationCheckpoint.model !== IMPORT_MODEL ||
      classificationCheckpoint.reasoningEffort !== IMPORT_REASONING_EFFORT ||
      !Array.isArray(classificationCheckpoint.items) || classificationCheckpoint.items.length !== 1 ||
      canonicalEvidenceHash(classificationCheckpoint.items[0]) !== manual.classificationArtifactItemHash ||
      expectedDecisionMismatch
    ) throw new Error(`${repair.key} classification manual adjudication checkpoint가 다릅니다`);
  }

  const actual = new Set<string>();
  for (const directory of [
    "problem-manual-evidence",
    "problem-manual-adjudications",
    "classification-manual-adjudications",
  ]) {
    const path = join(stateDir, directory);
    if (!existsSync(path)) continue;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".tmp")) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`manual adjudication directory에 regular file이 아닌 항목이 있습니다: ${directory}/${entry.name}`);
      }
      actual.add(`${directory}/${entry.name}`);
    }
  }
  const extras = [...actual].filter((path) => !declared.has(path));
  const missing = [...declared.keys()].filter((path) => !actual.has(path));
  if (extras.length > 0 || missing.length > 0) {
    throw new Error(
      `manual adjudication orphan/conflict: extra=${extras.join(",") || "-"}, missing=${missing.join(",") || "-"}`
    );
  }
}

function problemScopeAdjudicationSpec(
  entry: CorpusManifestEntry,
  key: string,
  sourcePage: number,
  sourceHash: string,
  solutionSourceHash: string
): ProblemScopeAdjudicationSpec | null {
  const matches = PROBLEM_SCOPE_ADJUDICATION_ALLOWLIST.filter((spec) =>
    spec.entryId === entry.id && spec.key === key && spec.sourcePage === sourcePage
  );
  if (matches.length > 1) throw new Error(`${entry.id} ${key} scope adjudication allowlist가 중복입니다`);
  const match = matches[0];
  if (match && (match.sourceHash !== sourceHash || match.solutionSourceHash !== solutionSourceHash)) {
    throw new Error(`${entry.id} ${key} scope adjudication source hash가 allowlist와 다릅니다`);
  }
  return match ?? null;
}

function problemRepairScopeAdjudicationSpec(
  entry: CorpusManifestEntry,
  key: string,
  sourcePage: number,
  sourceHash: string,
  solutionSourceHash: string
): ProblemScopeAdjudicationSpec | null {
  const matches = PROBLEM_REPAIR_SCOPE_ADJUDICATION_ALLOWLIST.filter((spec) =>
    spec.entryId === entry.id && spec.key === key && spec.sourcePage === sourcePage
  );
  if (matches.length > 1) throw new Error(`${entry.id} ${key} repair scope adjudication allowlist가 중복입니다`);
  const match = matches[0];
  if (match && (match.sourceHash !== sourceHash || match.solutionSourceHash !== solutionSourceHash)) {
    throw new Error(`${entry.id} ${key} repair scope adjudication source hash가 allowlist와 다릅니다`);
  }
  return match ?? null;
}

function problemRepairPositiveScopeAdjudicationSpec(
  entry: CorpusManifestEntry,
  key: string,
  sourcePage: number,
  sourceHash: string,
  solutionSourceHash: string
): ProblemRepairPositiveScopeAdjudicationSpec | null {
  const matches = PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_ALLOWLIST.filter((spec) =>
    spec.entryId === entry.id && spec.key === key && spec.sourcePage === sourcePage
  );
  if (matches.length > 1) throw new Error(`${entry.id} ${key} positive repair scope allowlist가 중복입니다`);
  const match = matches[0];
  if (match && (match.sourceHash !== sourceHash || match.solutionSourceHash !== solutionSourceHash)) {
    throw new Error(`${entry.id} ${key} positive repair scope source hash가 allowlist와 다릅니다`);
  }
  return match ?? null;
}

function hasPositiveRepairScopeAuthority(repair: ProblemRepairEvidence): boolean {
  const adjudication = repair.scopeAdjudication;
  return Boolean(adjudication && PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_ALLOWLIST.some((spec) =>
    spec.allowlistId === adjudication.allowlistId && spec.key === repair.key &&
    spec.sourcePage === adjudication.sourcePage && spec.sourceHash === adjudication.sourceHash &&
    spec.solutionSourceHash === adjudication.solutionSourceHash
  ));
}

function positiveRepairScopeAuthorityKeys(repairs: Iterable<ProblemRepairEvidence>): Set<string> {
  return new Set([...repairs].filter(hasPositiveRepairScopeAuthority).map((repair) => repair.key));
}

function isAllowedPositiveRepairScopeDecision(
  classification: ClassificationDecision,
  spec: ProblemRepairPositiveScopeAdjudicationSpec
): boolean {
  return classification.decision === "accept" &&
    classification.canonical_subject === spec.expectedCanonicalSubject &&
    Boolean(classification.curriculum_course) && Boolean(classification.domain) &&
    classification.achievement_codes.length > 0 && classification.achievement_codes.every((code) =>
      spec.allowedAchievementCodes.includes(code) && isAllowedAchievementCode(spec.expectedCanonicalSubject, code)
    ) && classification.reason_codes.includes(PROBLEM_REPAIR_POSITIVE_SCOPE_AUTHORITY_REASON_CODE) &&
    classification.confidence >= 0.9 && classification.transcription_status === "exact";
}

function problemRevisionScopeAdjudicationSpec(
  entry: CorpusManifestEntry,
  key: string,
  sourcePage: number,
  sourceHash: string,
  solutionSourceHash: string
): ProblemScopeAdjudicationSpec | null {
  const matches = PROBLEM_REVISION_SCOPE_ADJUDICATION_ALLOWLIST.filter((spec) =>
    spec.entryId === entry.id && spec.key === key && spec.sourcePage === sourcePage
  );
  if (matches.length > 1) throw new Error(`${entry.id} ${key} revision scope adjudication allowlist가 중복입니다`);
  const match = matches[0];
  if (match && (match.sourceHash !== sourceHash || match.solutionSourceHash !== solutionSourceHash)) {
    throw new Error(`${entry.id} ${key} revision scope adjudication source hash가 allowlist와 다릅니다`);
  }
  return match ?? null;
}

async function withCombinedPdfContexts<T>(
  paths: string[],
  run: (path: string) => Promise<T>
): Promise<T> {
  const tempDir = mkdtempSync(join(tmpdir(), "studywork-scope-adjudication-"));
  const path = join(tempDir, "evidence.pdf");
  try {
    const document = await PDFDocument.create({ updateMetadata: false });
    for (const sourcePath of paths) {
      const source = await PDFDocument.load(readFileSync(sourcePath));
      const pages = await document.copyPages(source, source.getPageIndices());
      for (const page of pages) document.addPage(page);
    }
    writeFileSync(path, await document.save());
    return await run(path);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

type ProblemScopeAdjudicationInput = {
  current: ClassifiedQuestion;
  preAdjudicationClassified: ClassifiedQuestion[];
  repair: ProblemRepairEvidence;
  recovery: ProblemRecoveryEvidence;
  solution: SolutionItem;
  terminalCheckpoint: ProblemTerminalFidelityCheckpoint;
  terminalItem: ProblemTerminalFidelityItem;
  preAdjudicationEffectiveCorpusHash: string;
};

type ProblemRepairScopeAdjudicationInput = Omit<ProblemScopeAdjudicationInput, "recovery">;

async function adjudicateProblemScope(
  entry: CorpusManifestEntry,
  problem: PdfEvidence,
  solutionEvidence: PdfEvidence,
  stateDir: string,
  input: ProblemScopeAdjudicationInput
): Promise<{ classified: ClassifiedQuestion; evidence: ProblemScopeAdjudicationEvidence }> {
  const key = questionKey(input.current.question);
  const sourcePage = input.current.question.page!;
  const spec = problemScopeAdjudicationSpec(
    entry, key, sourcePage, problem.sha256, solutionEvidence.sha256
  );
  if (!spec) throw new Error(`${key} scope adjudication allowlist에 없습니다`);
  if (
    await sha256File(problem.path) !== problem.sha256 ||
    await sha256File(solutionEvidence.path) !== solutionEvidence.sha256
  ) throw new Error(`${key} scope adjudication 공식 source bytes hash가 다릅니다`);
  if (
    input.recovery.scopeAdjudication || input.recovery.adjudication || input.recovery.key !== key ||
    input.recovery.sourcePage !== sourcePage || input.recovery.sourceHash !== problem.sha256 ||
    canonicalEvidenceHash(input.current.question) !== input.recovery.effectiveQuestionHash ||
    canonicalEvidenceHash(input.current.classification) !== input.recovery.effectiveClassificationHash ||
    input.current.classification.transcription_status !== "exact" ||
    input.current.classification.decision !== "accept" || input.terminalItem.key !== key ||
    input.terminalItem.status !== "exact" || input.terminalItem.scopeDecision !== "reject" ||
    input.terminalItem.scopeConfidence < 0.9
  ) throw new Error(`${key} scope adjudication 입력이 exact accept/reject conflict가 아닙니다`);

  for (const [label, pointer] of [
    ["base problem repair", input.recovery.baseProblemRepairArtifact],
    ["base classification repair", input.recovery.baseClassificationRepairArtifact],
    ["problem revision", input.recovery.baseProblemRevisionArtifact],
    ["classification revision", input.recovery.baseClassificationRevisionArtifact],
    ["problem recovery", input.recovery.problemArtifact],
    ["classification recovery", input.recovery.classificationArtifact],
  ] as const) {
    const path = confinedStateFile(stateDir, pointer.path, `scope adjudication ${label}`);
    if (await sha256File(path) !== pointer.sha256) throw new Error(`${key} scope adjudication ${label} hash가 다릅니다`);
  }

  const terminalPath = confinedStateFile(
    stateDir,
    input.terminalCheckpoint.path,
    "scope adjudication terminal fidelity"
  );
  if (await sha256File(terminalPath) !== input.terminalCheckpoint.sha256) {
    throw new Error(`${key} scope adjudication terminal fidelity hash가 다릅니다`);
  }
  const terminalCheckpoint = object(
    JSON.parse(readFileSync(terminalPath, "utf8")),
    "scope adjudication terminal fidelity"
  );
  if (canonicalEvidenceHash(input.preAdjudicationClassified) !== input.preAdjudicationEffectiveCorpusHash) {
    throw new Error(`${key} scope adjudication pre-terminal corpus hash가 다릅니다`);
  }
  const terminalQuestions = input.preAdjudicationClassified.filter(({ question }) =>
    question.page! >= input.terminalCheckpoint.ownedFrom && question.page! <= input.terminalCheckpoint.ownedTo
  );
  const terminalInputs = terminalQuestions.map(({ question }) => ({
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
  const terminalItems = parseProblemTerminalFidelity(terminalCheckpoint.items, terminalQuestions);
  const terminalMatches = terminalItems.filter((item) => item.key === key);
  const terminalItemHash = canonicalEvidenceHash(input.terminalItem);
  const expectedTerminalPath = `problem-terminal-fidelity/v${PROBLEM_TERMINAL_FIDELITY_VERSION}-0000-` +
    `${input.preAdjudicationEffectiveCorpusHash}-${input.terminalCheckpoint.inputHash}.json`;
  if (
    input.terminalCheckpoint.path !== expectedTerminalPath || terminalMatches.length !== 1 ||
    problem.pageCount > PROBLEM_SLICE_PAGES || input.terminalCheckpoint.from !== 1 ||
    input.terminalCheckpoint.to !== problem.pageCount || input.terminalCheckpoint.ownedFrom !== 1 ||
    input.terminalCheckpoint.ownedTo !== problem.pageCount ||
    input.recovery.contextFrom !== 1 || input.recovery.contextTo !== problem.pageCount ||
    canonicalEvidenceHash(terminalMatches[0]) !== terminalItemHash ||
    input.terminalCheckpoint.sha256 !== canonicalEvidenceHash(terminalCheckpoint) ||
    terminalCheckpoint.version !== PROBLEM_TERMINAL_FIDELITY_VERSION || terminalCheckpoint.entryId !== entry.id ||
    terminalCheckpoint.sourceHash !== problem.sha256 || terminalCheckpoint.from !== input.terminalCheckpoint.from ||
    terminalCheckpoint.to !== input.terminalCheckpoint.to ||
    terminalCheckpoint.ownedFrom !== input.terminalCheckpoint.ownedFrom ||
    terminalCheckpoint.ownedTo !== input.terminalCheckpoint.ownedTo ||
    terminalCheckpoint.inputHash !== input.terminalCheckpoint.inputHash ||
    terminalCheckpoint.inputHash !== canonicalEvidenceHash(terminalInputs) ||
    canonicalEvidenceHash(terminalCheckpoint.inputs) !== canonicalEvidenceHash(terminalInputs) ||
    terminalCheckpoint.effectiveCorpusHash !== input.preAdjudicationEffectiveCorpusHash ||
    terminalCheckpoint.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
    terminalCheckpoint.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST ||
    terminalCheckpoint.rulesDigest !== CLASSIFIER_DIGEST ||
    terminalCheckpoint.scopePromptDigest !== PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST ||
    terminalCheckpoint.model !== IMPORT_MODEL || terminalCheckpoint.reasoningEffort !== IMPORT_REASONING_EFFORT
  ) throw new Error(`${key} scope adjudication terminal fidelity evidence가 다릅니다`);

  const solutionBase = await baseSolutionEvidence(solutionEvidence, stateDir, input.solution);
  const parentRecoveryEvidenceHash = canonicalEvidenceHash(input.recovery);
  const trigger = {
    terminalCheckpoint: input.terminalCheckpoint,
    terminalItemHash,
    terminalItem: input.terminalItem,
    evidenceHash: sha256Text(input.terminalItem.evidence),
    scopeEvidenceHash: sha256Text(input.terminalItem.scopeEvidence),
    preAdjudicationEffectiveCorpusHash: input.preAdjudicationEffectiveCorpusHash,
  };
  const basis = {
    allowlistId: spec.allowlistId,
    entryId: entry.id,
    key,
    printedNumber: input.recovery.printedNumber,
    sourcePage,
    sourceHash: problem.sha256,
    solutionSourceHash: solutionEvidence.sha256,
    problemContextFrom: input.recovery.contextFrom,
    problemContextTo: input.recovery.contextTo,
    solutionContextFrom: solutionBase.contextFrom,
    solutionContextTo: solutionBase.contextTo,
    baseSolutionCheckpoint: solutionBase.checkpoint,
    baseSolutionItemHash: solutionBase.itemHash,
    parentRecovery: input.recovery,
    parentRecoveryEvidenceHash,
    trigger,
    baseQuestionHash: canonicalEvidenceHash(input.current.question),
    baseClassificationHash: canonicalEvidenceHash(input.current.classification),
  };
  const basisDigest = canonicalEvidenceHash(basis);
  const relativePath = `classification-scope-adjudications/v${PROBLEM_SCOPE_ADJUDICATION_VERSION}-` +
    `${String(sourcePage).padStart(4, "0")}-${input.recovery.printedNumber.padStart(4, "0")}-` +
    `${basisDigest}-${CLASSIFIER_DIGEST}.json`;
  const path = join(stateDir, relativePath);
  let checkpoint: Record<string, unknown>;
  let classification: ClassificationDecision;
  if (existsSync(path)) {
    const safePath = confinedStateFile(stateDir, relativePath, "problem scope adjudication");
    checkpoint = object(JSON.parse(readFileSync(safePath, "utf8")), relativePath);
    if (
      checkpoint.version !== PROBLEM_SCOPE_ADJUDICATION_VERSION || checkpoint.entryId !== entry.id ||
      checkpoint.basisDigest !== basisDigest || canonicalEvidenceHash(checkpoint.basis) !== canonicalEvidenceHash(basis) ||
      checkpoint.classifierVersion !== CLASSIFIER_VERSION || checkpoint.rulesDigest !== CLASSIFIER_DIGEST ||
      checkpoint.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
      checkpoint.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST ||
      checkpoint.adjudicationPromptVersion !== PROBLEM_SCOPE_ADJUDICATION_VERSION ||
      checkpoint.adjudicationPromptDigest !== PROBLEM_SCOPE_ADJUDICATION_PROMPT_DIGEST ||
      checkpoint.model !== IMPORT_MODEL || checkpoint.reasoningEffort !== IMPORT_REASONING_EFFORT
    ) throw new Error(`기존 problem scope adjudication 메타데이터가 다릅니다: ${path}`);
    classification = parseDecisions(checkpoint.items, [input.current.question], entry)[0];
  } else {
    const allowedCodes = ALLOWED_CANONICAL[entry.subject]
      .flatMap((canonical) => [...ACHIEVEMENT_CODES[canonical]])
      .sort();
    const question = {
      key,
      printed_number: input.recovery.printedNumber,
      source_page: sourcePage,
      qtype: input.current.question.qtype,
      question: input.current.question.question,
      choices: input.current.question.choices,
      figure: input.current.question.figure,
      figure_description: input.current.question.figure_description,
      box: input.current.question.box,
    };
    classification = await withImporterPdfForAnalysis(problem, (analysisProblem) =>
      withProblemContextSlice(
        analysisProblem.path,
        input.recovery.contextFrom,
        input.recovery.contextTo,
        (problemContextPath) => withImporterPdfForAnalysis(solutionEvidence, (analysisSolution) =>
          withSolutionContextSlice(
            analysisSolution.path,
            solutionBase.contextFrom,
            solutionBase.contextTo,
            (solutionContextPath) => withCombinedPdfContexts(
              [problemContextPath, solutionContextPath],
              async (evidencePath) => {
                const problemPages = input.recovery.contextTo - input.recovery.contextFrom + 1;
                const prompt =
                  `Attached evidence PDF pages 1-${problemPages} are official problem pages ` +
                  `${input.recovery.contextFrom}-${input.recovery.contextTo}; pages ${problemPages + 1}-` +
                  `${problemPages + solutionBase.contextTo - solutionBase.contextFrom + 1} are official solution pages ` +
                  `${solutionBase.contextFrom}-${solutionBase.contextTo}. Exam source subject is ${entry.subject}; ` +
                  `source school grade is ${entry.grade ?? "unknown"}. Inspect printed problem ${input.recovery.printedNumber} ` +
                  `and its owning official solution. No prior classifier or audit decision is supplied.\n\n` +
                  `${PROBLEM_SCOPE_ADJUDICATION_RULES}\n\n${TRANSCRIPTION_GATE_RULES}\n\n${CURRICULUM_RULES}\n\n` +
                  `Allowed exact achievement codes for this source: ${allowedCodes.join(", ")}\n\n` +
                  `Final question:\n${JSON.stringify(question)}`;
                const result = await withTargetedAi(() => getCodexProvider({
                  model: IMPORT_MODEL,
                  reasoningEffort: IMPORT_REASONING_EFFORT,
                }).complete({
                  operation: "problem-extract",
                  prompt,
                  file: { path: evidencePath, kind: "pdf" },
                  schema: PROBLEM_SCOPE_ADJUDICATION_SCHEMA,
                  model: IMPORT_MODEL,
                  reasoningEffort: IMPORT_REASONING_EFFORT,
                  lane: "bulk",
                }));
                return parseDecisions(JSON.parse(result.text), [input.current.question], entry)[0];
              }
            )
          )
        )
      )
    );
    checkpoint = {
      version: PROBLEM_SCOPE_ADJUDICATION_VERSION,
      entryId: entry.id,
      basisDigest,
      basis,
      classifierVersion: CLASSIFIER_VERSION,
      rulesDigest: CLASSIFIER_DIGEST,
      transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
      adjudicationPromptVersion: PROBLEM_SCOPE_ADJUDICATION_VERSION,
      adjudicationPromptDigest: PROBLEM_SCOPE_ADJUDICATION_PROMPT_DIGEST,
      model: IMPORT_MODEL,
      reasoningEffort: IMPORT_REASONING_EFFORT,
      items: [classification],
    };
    await writeImmutableEvidence(path, checkpoint);
  }
  const sha256 = await sha256File(path);
  if (sha256 !== canonicalEvidenceHash(checkpoint)) throw new Error(`${key} problem scope adjudication hash가 다릅니다`);
  if (
    classification.decision !== "reject" || classification.canonical_subject !== null ||
    classification.curriculum_course !== null || classification.domain !== null ||
    classification.achievement_codes.length !== 0 || classification.confidence < 0.9 ||
    classification.transcription_status !== "exact"
  ) throw new Error(`${key} problem scope adjudication이 reject/null exact에 합의하지 않았습니다`);
  const evidence: ProblemScopeAdjudicationEvidence = {
    allowlistId: spec.allowlistId,
    key,
    printedNumber: input.recovery.printedNumber,
    sourcePage,
    sourceHash: problem.sha256,
    solutionSourceHash: solutionEvidence.sha256,
    problemContextFrom: input.recovery.contextFrom,
    problemContextTo: input.recovery.contextTo,
    solutionContextFrom: solutionBase.contextFrom,
    solutionContextTo: solutionBase.contextTo,
    baseSolutionCheckpoint: solutionBase.checkpoint,
    baseSolutionItemHash: solutionBase.itemHash,
    parentRecoveryEvidenceHash,
    trigger,
    classificationArtifact: {
      path: relativePath,
      sha256,
      rulesDigest: CLASSIFIER_DIGEST,
      transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
      adjudicationPromptVersion: PROBLEM_SCOPE_ADJUDICATION_VERSION,
      adjudicationPromptDigest: PROBLEM_SCOPE_ADJUDICATION_PROMPT_DIGEST,
    },
    classificationArtifactItemHash: canonicalEvidenceHash(classification),
    baseQuestionHash: canonicalEvidenceHash(input.current.question),
    effectiveQuestionHash: canonicalEvidenceHash(input.current.question),
    baseClassificationHash: canonicalEvidenceHash(input.current.classification),
    effectiveClassificationHash: canonicalEvidenceHash(classification),
  };
  return { classified: { question: input.current.question, classification }, evidence };
}

async function adjudicateProblemRepairScope(
  entry: CorpusManifestEntry,
  problem: PdfEvidence,
  solutionEvidence: PdfEvidence,
  stateDir: string,
  input: ProblemRepairScopeAdjudicationInput
): Promise<{ classified: ClassifiedQuestion; evidence: ProblemScopeAdjudicationEvidence }> {
  const key = questionKey(input.current.question);
  const sourcePage = input.current.question.page!;
  const repairSpec = problemRepairScopeAdjudicationSpec(
    entry, key, sourcePage, problem.sha256, solutionEvidence.sha256
  );
  const positiveSpec = problemRepairPositiveScopeAdjudicationSpec(
    entry, key, sourcePage, problem.sha256, solutionEvidence.sha256
  );
  const revisionSpec = problemRevisionScopeAdjudicationSpec(
    entry, key, sourcePage, problem.sha256, solutionEvidence.sha256
  );
  if ([repairSpec, positiveSpec, revisionSpec].filter(Boolean).length > 1) {
    throw new Error(`${key} scope adjudication parent mode가 중복입니다`);
  }
  const spec = revisionSpec ?? positiveSpec ?? repairSpec;
  const revisionParent = Boolean(revisionSpec);
  const positiveAuthority = Boolean(positiveSpec);
  const revision = input.repair.revision;
  const adjudicationVersion = revisionParent
    ? PROBLEM_REVISION_SCOPE_ADJUDICATION_VERSION
    : positiveAuthority
      ? PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_VERSION
      : PROBLEM_REPAIR_SCOPE_ADJUDICATION_VERSION;
  const adjudicationPromptDigest = revisionParent
    ? PROBLEM_REVISION_SCOPE_ADJUDICATION_PROMPT_DIGEST
    : positiveAuthority
      ? PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_PROMPT_DIGEST
      : PROBLEM_REPAIR_SCOPE_ADJUDICATION_PROMPT_DIGEST;
  const adjudicationRules = positiveAuthority
    ? PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_RULES
    : PROBLEM_SCOPE_ADJUDICATION_RULES;
  const adjudicationDirectory = revisionParent
    ? "classification-revision-scope-adjudications"
    : positiveAuthority
      ? "classification-repair-positive-scope-adjudications"
      : "classification-repair-scope-adjudications";
  if (!spec) throw new Error(`${key} repair/revision scope adjudication allowlist에 없습니다`);
  if (
    await sha256File(problem.path) !== problem.sha256 ||
    await sha256File(solutionEvidence.path) !== solutionEvidence.sha256
  ) throw new Error(`${key} repair scope adjudication 공식 source bytes hash가 다릅니다`);
  if (
    input.repair.scopeAdjudication || input.repair.key !== key ||
    input.repair.sourcePage !== sourcePage ||
    (revisionParent
      ? !revision || revision.recovery || revision.scopeAdjudication ||
        canonicalEvidenceHash(input.current.question) !== revision.effectiveQuestionHash ||
        canonicalEvidenceHash(input.current.classification) !== revision.effectiveClassificationHash
      : Boolean(revision) ||
        canonicalEvidenceHash(input.current.question) !== input.repair.effectiveQuestionHash ||
        canonicalEvidenceHash(input.current.classification) !== input.repair.effectiveClassificationHash) ||
    input.current.classification.transcription_status !== "exact" ||
    input.current.classification.decision !== "accept" || input.terminalItem.key !== key ||
    input.terminalItem.status !== "exact" || input.terminalItem.scopeDecision !== "reject" ||
    input.terminalItem.scopeConfidence < 0.9
  ) throw new Error(`${key} repair scope adjudication 입력이 exact accept/reject conflict가 아닙니다`);
  if (
    revisionParent && (
      revision!.problemArtifact.sha256 !== spec.parentProblemArtifactHash ||
      revision!.classificationArtifact.sha256 !== spec.parentClassificationArtifactHash ||
      input.terminalCheckpoint.sha256 !== spec.terminalArtifactHash
    )
  ) throw new Error(`${key} revision scope adjudication pinned parent/terminal hash가 다릅니다`);

  for (const [label, pointer] of [
    ["base problem checkpoint", input.repair.baseProblemCheckpoint],
    ["base classification checkpoint", input.repair.baseClassificationCheckpoint],
    ["base solution checkpoint", input.repair.baseSolutionCheckpoint],
    ["problem repair", input.repair.problemArtifact],
    ["classification repair", input.repair.classificationArtifact],
  ] as const) {
    const path = confinedStateFile(stateDir, pointer.path, `repair scope adjudication ${label}`);
    if (await sha256File(path) !== pointer.sha256) {
      throw new Error(`${key} repair scope adjudication ${label} hash가 다릅니다`);
    }
  }
  if (revisionParent) {
    for (const [label, pointer] of [
      ["problem revision", revision!.problemArtifact],
      ["classification revision", revision!.classificationArtifact],
    ] as const) {
      const path = confinedStateFile(stateDir, pointer.path, `revision scope adjudication ${label}`);
      if (await sha256File(path) !== pointer.sha256) {
        throw new Error(`${key} revision scope adjudication ${label} hash가 다릅니다`);
      }
    }
  }

  const terminalPath = confinedStateFile(
    stateDir,
    input.terminalCheckpoint.path,
    "repair scope adjudication terminal fidelity"
  );
  if (await sha256File(terminalPath) !== input.terminalCheckpoint.sha256) {
    throw new Error(`${key} repair scope adjudication terminal fidelity hash가 다릅니다`);
  }
  const terminalCheckpoint = object(
    JSON.parse(readFileSync(terminalPath, "utf8")),
    "repair scope adjudication terminal fidelity"
  );
  if (canonicalEvidenceHash(input.preAdjudicationClassified) !== input.preAdjudicationEffectiveCorpusHash) {
    throw new Error(`${key} repair scope adjudication pre-terminal corpus hash가 다릅니다`);
  }
  const terminalQuestions = input.preAdjudicationClassified.filter(({ question }) =>
    question.page! >= input.terminalCheckpoint.ownedFrom && question.page! <= input.terminalCheckpoint.ownedTo
  );
  const terminalInputs = terminalQuestions.map(({ question }) => ({
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
  const terminalItems = parseProblemTerminalFidelity(terminalCheckpoint.items, terminalQuestions);
  const terminalMatches = terminalItems.filter((item) => item.key === key);
  const terminalItemHash = canonicalEvidenceHash(input.terminalItem);
  const expectedTerminalPath = `problem-terminal-fidelity/v${PROBLEM_TERMINAL_FIDELITY_VERSION}-0000-` +
    `${input.preAdjudicationEffectiveCorpusHash}-${input.terminalCheckpoint.inputHash}.json`;
  if (
    input.terminalCheckpoint.path !== expectedTerminalPath || terminalMatches.length !== 1 ||
    problem.pageCount > PROBLEM_SLICE_PAGES || input.terminalCheckpoint.from !== 1 ||
    input.terminalCheckpoint.to !== problem.pageCount || input.terminalCheckpoint.ownedFrom !== 1 ||
    input.terminalCheckpoint.ownedTo !== problem.pageCount || input.repair.contextFrom !== 1 ||
    input.repair.contextTo !== problem.pageCount ||
    canonicalEvidenceHash(terminalMatches[0]) !== terminalItemHash ||
    input.terminalCheckpoint.sha256 !== canonicalEvidenceHash(terminalCheckpoint) ||
    terminalCheckpoint.version !== PROBLEM_TERMINAL_FIDELITY_VERSION || terminalCheckpoint.entryId !== entry.id ||
    terminalCheckpoint.sourceHash !== problem.sha256 || terminalCheckpoint.from !== input.terminalCheckpoint.from ||
    terminalCheckpoint.to !== input.terminalCheckpoint.to ||
    terminalCheckpoint.ownedFrom !== input.terminalCheckpoint.ownedFrom ||
    terminalCheckpoint.ownedTo !== input.terminalCheckpoint.ownedTo ||
    terminalCheckpoint.inputHash !== input.terminalCheckpoint.inputHash ||
    terminalCheckpoint.inputHash !== canonicalEvidenceHash(terminalInputs) ||
    canonicalEvidenceHash(terminalCheckpoint.inputs) !== canonicalEvidenceHash(terminalInputs) ||
    terminalCheckpoint.effectiveCorpusHash !== input.preAdjudicationEffectiveCorpusHash ||
    terminalCheckpoint.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
    terminalCheckpoint.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST ||
    terminalCheckpoint.rulesDigest !== CLASSIFIER_DIGEST ||
    terminalCheckpoint.scopePromptDigest !== PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST ||
    terminalCheckpoint.model !== IMPORT_MODEL || terminalCheckpoint.reasoningEffort !== IMPORT_REASONING_EFFORT
  ) throw new Error(`${key} repair scope adjudication terminal fidelity evidence가 다릅니다`);

  const solutionBase = await baseSolutionEvidence(solutionEvidence, stateDir, input.solution);
  if (
    canonicalEvidenceHash(solutionBase.checkpoint) !== canonicalEvidenceHash(input.repair.baseSolutionCheckpoint) ||
    solutionBase.itemHash !== input.repair.baseSolutionItemHash
  ) throw new Error(`${key} repair scope adjudication owning solution evidence가 repair와 다릅니다`);
  const parentRepairEvidenceHash = canonicalEvidenceHash(input.repair);
  const parentRevisionEvidenceHash = revisionParent ? canonicalEvidenceHash(revision) : undefined;
  const trigger = {
    terminalCheckpoint: input.terminalCheckpoint,
    terminalItemHash,
    terminalItem: input.terminalItem,
    evidenceHash: sha256Text(input.terminalItem.evidence),
    scopeEvidenceHash: sha256Text(input.terminalItem.scopeEvidence),
    preAdjudicationEffectiveCorpusHash: input.preAdjudicationEffectiveCorpusHash,
  };
  const basis = {
    allowlistId: spec.allowlistId,
    entryId: entry.id,
    key,
    printedNumber: input.repair.printedNumber,
    sourcePage,
    sourceHash: problem.sha256,
    solutionSourceHash: solutionEvidence.sha256,
    problemContextFrom: input.repair.contextFrom,
    problemContextTo: input.repair.contextTo,
    solutionContextFrom: solutionBase.contextFrom,
    solutionContextTo: solutionBase.contextTo,
    baseSolutionCheckpoint: solutionBase.checkpoint,
    baseSolutionItemHash: solutionBase.itemHash,
    parentRepair: input.repair,
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
    baseQuestionHash: canonicalEvidenceHash(input.current.question),
    baseClassificationHash: canonicalEvidenceHash(input.current.classification),
  };
  const basisDigest = canonicalEvidenceHash(basis);
  const relativePath = `${adjudicationDirectory}/` +
    `v${adjudicationVersion}-${String(sourcePage).padStart(4, "0")}-` +
    `${input.repair.printedNumber.padStart(4, "0")}-${basisDigest}-${CLASSIFIER_DIGEST}.json`;
  const path = join(stateDir, relativePath);
  let checkpoint: Record<string, unknown>;
  let classification: ClassificationDecision;
  if (existsSync(path)) {
    const safePath = confinedStateFile(stateDir, relativePath, "problem repair scope adjudication");
    checkpoint = object(JSON.parse(readFileSync(safePath, "utf8")), relativePath);
    if (
      checkpoint.version !== adjudicationVersion || checkpoint.entryId !== entry.id ||
      checkpoint.basisDigest !== basisDigest || canonicalEvidenceHash(checkpoint.basis) !== canonicalEvidenceHash(basis) ||
      checkpoint.classifierVersion !== CLASSIFIER_VERSION || checkpoint.rulesDigest !== CLASSIFIER_DIGEST ||
      checkpoint.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
      checkpoint.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST ||
      checkpoint.adjudicationPromptVersion !== adjudicationVersion ||
      checkpoint.adjudicationPromptDigest !== adjudicationPromptDigest ||
      checkpoint.model !== IMPORT_MODEL || checkpoint.reasoningEffort !== IMPORT_REASONING_EFFORT
    ) throw new Error(`기존 problem repair scope adjudication 메타데이터가 다릅니다: ${path}`);
    classification = parseDecisions(checkpoint.items, [input.current.question], entry)[0];
  } else {
    const allowedCodes = ALLOWED_CANONICAL[entry.subject]
      .flatMap((canonical) => [...ACHIEVEMENT_CODES[canonical]])
      .sort();
    const question = {
      key,
      printed_number: input.repair.printedNumber,
      source_page: sourcePage,
      qtype: input.current.question.qtype,
      question: input.current.question.question,
      choices: input.current.question.choices,
      figure: input.current.question.figure,
      figure_description: input.current.question.figure_description,
      box: input.current.question.box,
    };
    classification = await withImporterPdfForAnalysis(problem, (analysisProblem) =>
      withProblemContextSlice(
        analysisProblem.path,
        input.repair.contextFrom,
        input.repair.contextTo,
        (problemContextPath) => withImporterPdfForAnalysis(solutionEvidence, (analysisSolution) =>
          withSolutionContextSlice(
            analysisSolution.path,
            solutionBase.contextFrom,
            solutionBase.contextTo,
            (solutionContextPath) => withCombinedPdfContexts(
              [problemContextPath, solutionContextPath],
              async (evidencePath) => {
                const problemPages = input.repair.contextTo - input.repair.contextFrom + 1;
                const prompt =
                  `Attached evidence PDF pages 1-${problemPages} are official problem pages ` +
                  `${input.repair.contextFrom}-${input.repair.contextTo}; pages ${problemPages + 1}-` +
                  `${problemPages + solutionBase.contextTo - solutionBase.contextFrom + 1} are official solution pages ` +
                  `${solutionBase.contextFrom}-${solutionBase.contextTo}. Exam source subject is ${entry.subject}; ` +
                  `source school grade is ${entry.grade ?? "unknown"}. Inspect printed problem ${input.repair.printedNumber} ` +
                  `and its owning official solution. No prior classifier or audit decision is supplied.\n\n` +
                  `${adjudicationRules}\n\n${TRANSCRIPTION_GATE_RULES}\n\n${CURRICULUM_RULES}\n\n` +
                  `Allowed exact achievement codes for this source: ${allowedCodes.join(", ")}\n\n` +
                  `Final question:\n${JSON.stringify(question)}`;
                const result = await withTargetedAi(() => getCodexProvider({
                  model: IMPORT_MODEL,
                  reasoningEffort: IMPORT_REASONING_EFFORT,
                }).complete({
                  operation: "problem-extract",
                  prompt,
                  file: { path: evidencePath, kind: "pdf" },
                  schema: PROBLEM_SCOPE_ADJUDICATION_SCHEMA,
                  model: IMPORT_MODEL,
                  reasoningEffort: IMPORT_REASONING_EFFORT,
                  lane: "bulk",
                }));
                return parseDecisions(JSON.parse(result.text), [input.current.question], entry)[0];
              }
            )
          )
        )
      )
    );
    checkpoint = {
      version: adjudicationVersion,
      entryId: entry.id,
      basisDigest,
      basis,
      classifierVersion: CLASSIFIER_VERSION,
      rulesDigest: CLASSIFIER_DIGEST,
      transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
      adjudicationPromptVersion: adjudicationVersion,
      adjudicationPromptDigest,
      model: IMPORT_MODEL,
      reasoningEffort: IMPORT_REASONING_EFFORT,
      items: [classification],
    };
    await writeImmutableEvidence(path, checkpoint);
  }
  const sha256 = await sha256File(path);
  if (sha256 !== canonicalEvidenceHash(checkpoint)) {
    throw new Error(`${key} problem repair scope adjudication hash가 다릅니다`);
  }
  const invalidDecision = positiveSpec
    ? !isAllowedPositiveRepairScopeDecision(classification, positiveSpec) ||
      canonicalEvidenceHash(classification) === canonicalEvidenceHash(input.current.classification)
    : classification.decision !== "reject" || classification.canonical_subject !== null ||
      classification.curriculum_course !== null || classification.domain !== null ||
      classification.achievement_codes.length !== 0 || classification.confidence < 0.9 ||
      classification.transcription_status !== "exact";
  if (invalidDecision) {
    throw new Error(`${key} problem repair scope adjudication이 허용된 final scope에 합의하지 않았습니다`);
  }
  const evidence: ProblemScopeAdjudicationEvidence = {
    allowlistId: spec.allowlistId,
    key,
    printedNumber: input.repair.printedNumber,
    sourcePage,
    sourceHash: problem.sha256,
    solutionSourceHash: solutionEvidence.sha256,
    problemContextFrom: input.repair.contextFrom,
    problemContextTo: input.repair.contextTo,
    solutionContextFrom: solutionBase.contextFrom,
    solutionContextTo: solutionBase.contextTo,
    baseSolutionCheckpoint: solutionBase.checkpoint,
    baseSolutionItemHash: solutionBase.itemHash,
    parentRepairEvidenceHash,
    ...(parentRevisionEvidenceHash ? { parentRevisionEvidenceHash } : {}),
    trigger,
    classificationArtifact: {
      path: relativePath,
      sha256,
      rulesDigest: CLASSIFIER_DIGEST,
      transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
      transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
      adjudicationPromptVersion: adjudicationVersion,
      adjudicationPromptDigest,
    },
    classificationArtifactItemHash: canonicalEvidenceHash(classification),
    baseQuestionHash: canonicalEvidenceHash(input.current.question),
    effectiveQuestionHash: canonicalEvidenceHash(input.current.question),
    baseClassificationHash: canonicalEvidenceHash(input.current.classification),
    effectiveClassificationHash: canonicalEvidenceHash(classification),
  };
  return { classified: { question: input.current.question, classification }, evidence };
}

async function assertProblemScopeAdjudicationAuthority(
  stateDir: string,
  repairs: Iterable<ProblemRepairEvidence>
): Promise<void> {
  const declared = new Map<string, string>();
  for (const repair of repairs) {
    const recovery = repair.revision?.recovery;
    const adjudication = recovery?.scopeAdjudication;
    if (!recovery || !adjudication) continue;
    const { scopeAdjudication: _scopeAdjudication, ...parentRecovery } = recovery;
    if (canonicalEvidenceHash(parentRecovery) !== adjudication.parentRecoveryEvidenceHash) {
      throw new Error(`${repair.key} problem scope adjudication parent recovery hash가 다릅니다`);
    }
    const pointer = adjudication.classificationArtifact;
    if (declared.has(pointer.path)) throw new Error(`problem scope adjudication artifact가 중복 선언됐습니다: ${pointer.path}`);
    const path = confinedStateFile(stateDir, pointer.path, "problem scope adjudication");
    if (await sha256File(path) !== pointer.sha256) throw new Error(`problem scope adjudication hash가 다릅니다: ${pointer.path}`);
    declared.set(pointer.path, pointer.sha256);
  }
  const directory = join(stateDir, "classification-scope-adjudications");
  const actual = new Set<string>();
  if (existsSync(directory)) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".tmp")) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`problem scope adjudication directory에 regular file이 아닌 항목이 있습니다: ${entry.name}`);
      }
      actual.add(`classification-scope-adjudications/${entry.name}`);
    }
  }
  const extras = [...actual].filter((path) => !declared.has(path));
  const missing = [...declared.keys()].filter((path) => !actual.has(path));
  if (extras.length > 0 || missing.length > 0) {
    throw new Error(
      `problem scope adjudication orphan/conflict: extra=${extras.join(",") || "-"}, ` +
      `missing=${missing.join(",") || "-"}`
    );
  }
}

async function assertProblemRepairScopeAdjudicationAuthority(
  stateDir: string,
  repairs: Iterable<ProblemRepairEvidence>,
  classified: readonly ClassifiedQuestion[]
): Promise<void> {
  const declared = new Map<string, string>();
  for (const repair of repairs) {
    const adjudication = repair.scopeAdjudication;
    if (!adjudication) continue;
    const { scopeAdjudication: _scopeAdjudication, ...parentRepair } = repair;
    const negativeMatches = PROBLEM_REPAIR_SCOPE_ADJUDICATION_ALLOWLIST.filter((spec) =>
      spec.allowlistId === adjudication.allowlistId && spec.key === adjudication.key &&
      spec.sourcePage === adjudication.sourcePage && spec.sourceHash === adjudication.sourceHash &&
      spec.solutionSourceHash === adjudication.solutionSourceHash
    );
    const positiveMatches = PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_ALLOWLIST.filter((spec) =>
      spec.allowlistId === adjudication.allowlistId && spec.key === adjudication.key &&
      spec.sourcePage === adjudication.sourcePage && spec.sourceHash === adjudication.sourceHash &&
      spec.solutionSourceHash === adjudication.solutionSourceHash
    );
    const matches = [...negativeMatches, ...positiveMatches];
    const positiveSpec = positiveMatches[0];
    const currentMatches = classified.filter((item) => questionKey(item.question) === repair.key);
    if (
      matches.length !== 1 || repair.key !== adjudication.key || repair.sourcePage !== adjudication.sourcePage ||
      repair.revision || adjudication.parentRecoveryEvidenceHash !== undefined ||
      canonicalEvidenceHash(parentRepair) !== adjudication.parentRepairEvidenceHash ||
      adjudication.printedNumber !== parentRepair.printedNumber ||
      adjudication.problemContextFrom !== parentRepair.contextFrom ||
      adjudication.problemContextTo !== parentRepair.contextTo ||
      canonicalEvidenceHash(adjudication.baseSolutionCheckpoint) !==
        canonicalEvidenceHash(parentRepair.baseSolutionCheckpoint) ||
      adjudication.baseSolutionItemHash !== parentRepair.baseSolutionItemHash ||
      adjudication.baseQuestionHash !== parentRepair.effectiveQuestionHash ||
      adjudication.effectiveQuestionHash !== parentRepair.effectiveQuestionHash ||
      adjudication.baseClassificationHash !== parentRepair.effectiveClassificationHash ||
      adjudication.effectiveClassificationHash !== adjudication.classificationArtifactItemHash ||
      adjudication.trigger.terminalItem.key !== repair.key ||
      adjudication.trigger.terminalItem.status !== "exact" ||
      adjudication.trigger.terminalItem.scopeDecision !== "reject" ||
      adjudication.trigger.terminalItem.scopeConfidence < 0.9 ||
      canonicalEvidenceHash(adjudication.trigger.terminalItem) !== adjudication.trigger.terminalItemHash ||
      sha256Text(adjudication.trigger.terminalItem.evidence) !== adjudication.trigger.evidenceHash ||
      sha256Text(adjudication.trigger.terminalItem.scopeEvidence) !== adjudication.trigger.scopeEvidenceHash ||
      adjudication.classificationArtifact.rulesDigest !== CLASSIFIER_DIGEST ||
      adjudication.classificationArtifact.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
      adjudication.classificationArtifact.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST ||
      (positiveSpec && (
        currentMatches.length !== 1 ||
        canonicalEvidenceHash(currentMatches[0].question) !== adjudication.effectiveQuestionHash ||
        canonicalEvidenceHash(currentMatches[0].classification) !== adjudication.effectiveClassificationHash ||
        adjudication.baseClassificationHash === adjudication.effectiveClassificationHash ||
        !isAllowedPositiveRepairScopeDecision(currentMatches[0].classification, positiveSpec)
      ))
    ) throw new Error(`${repair.key} problem repair scope adjudication evidence가 parent/allowlist와 다릅니다`);

    for (const [label, pointer] of [
      ["repair scope terminal fidelity", adjudication.trigger.terminalCheckpoint],
      ["problem repair scope adjudication", adjudication.classificationArtifact],
    ] as const) {
      const path = confinedStateFile(stateDir, pointer.path, label);
      if (await sha256File(path) !== pointer.sha256) throw new Error(`${label} hash가 다릅니다: ${pointer.path}`);
    }
    if (positiveSpec) {
      const terminalPointer = adjudication.trigger.terminalCheckpoint;
      const parentClassificationCheckpoint = object(JSON.parse(readFileSync(confinedStateFile(
        stateDir,
        parentRepair.classificationArtifact.path,
        "positive repair scope parent classification"
      ), "utf8")), "positive repair scope parent classification");
      const parentClassificationItems = Array.isArray(parentClassificationCheckpoint.items)
        ? parentClassificationCheckpoint.items.map((item) => object(item, "positive repair scope parent item"))
        : [];
      const parentClassificationMatches = parentClassificationItems.filter((item) => item.key === repair.key);
      const parentClassification = parentClassificationMatches[0];
      const preAdjudicationClassified = classified.map((item) => questionKey(item.question) === repair.key
        ? { question: item.question, classification: parentClassification }
        : item);
      const preAdjudicationEffectiveCorpusHash = canonicalEvidenceHash(preAdjudicationClassified);
      const finalEffectiveCorpusHash = canonicalEvidenceHash(classified);
      const terminalCheckpoint = object(JSON.parse(readFileSync(confinedStateFile(
        stateDir,
        terminalPointer.path,
        "positive repair scope terminal fidelity"
      ), "utf8")), "positive repair scope terminal fidelity");
      const terminalQuestions = classified.filter(({ question }) =>
        question.page! >= terminalPointer.ownedFrom && question.page! <= terminalPointer.ownedTo
      );
      const terminalInputs = terminalQuestions.map(({ question }) => ({
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
      const terminalItems = parseProblemTerminalFidelity(terminalCheckpoint.items, terminalQuestions);
      const terminalTargetItems = terminalItems.filter((item) => item.key === repair.key);
      const expectedTerminalPath = `problem-terminal-fidelity/v${PROBLEM_TERMINAL_FIDELITY_VERSION}-0000-` +
        `${adjudication.trigger.preAdjudicationEffectiveCorpusHash}-${terminalPointer.inputHash}.json`;
      if (
        parentClassificationMatches.length !== 1 ||
        canonicalEvidenceHash(parentClassification) !== parentRepair.effectiveClassificationHash ||
        canonicalEvidenceHash(parentClassification) !== parentRepair.classificationArtifactItemHash ||
        preAdjudicationEffectiveCorpusHash !== adjudication.trigger.preAdjudicationEffectiveCorpusHash ||
        finalEffectiveCorpusHash === preAdjudicationEffectiveCorpusHash ||
        terminalPointer.path !== expectedTerminalPath || terminalPointer.from !== 1 ||
        terminalPointer.to !== parentRepair.contextTo || terminalPointer.ownedFrom !== 1 ||
        terminalPointer.ownedTo !== parentRepair.contextTo || parentRepair.contextFrom !== 1 ||
        terminalPointer.sha256 !== canonicalEvidenceHash(terminalCheckpoint) ||
        terminalCheckpoint.version !== PROBLEM_TERMINAL_FIDELITY_VERSION ||
        terminalCheckpoint.entryId !== positiveSpec.entryId || terminalCheckpoint.sourceHash !== positiveSpec.sourceHash ||
        terminalCheckpoint.from !== terminalPointer.from || terminalCheckpoint.to !== terminalPointer.to ||
        terminalCheckpoint.ownedFrom !== terminalPointer.ownedFrom ||
        terminalCheckpoint.ownedTo !== terminalPointer.ownedTo ||
        terminalCheckpoint.effectiveCorpusHash !== preAdjudicationEffectiveCorpusHash ||
        terminalCheckpoint.inputHash !== terminalPointer.inputHash ||
        terminalCheckpoint.inputHash !== canonicalEvidenceHash(terminalInputs) ||
        canonicalEvidenceHash(terminalCheckpoint.inputs) !== canonicalEvidenceHash(terminalInputs) ||
        terminalCheckpoint.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
        terminalCheckpoint.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST ||
        terminalCheckpoint.rulesDigest !== CLASSIFIER_DIGEST ||
        terminalCheckpoint.scopePromptDigest !== PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST ||
        terminalCheckpoint.model !== IMPORT_MODEL || terminalCheckpoint.reasoningEffort !== IMPORT_REASONING_EFFORT ||
        terminalTargetItems.length !== 1 ||
        canonicalEvidenceHash(terminalTargetItems[0]) !== adjudication.trigger.terminalItemHash
      ) throw new Error(`${repair.key} positive repair scope terminal checkpoint가 다릅니다`);
    }
    const basis = {
      allowlistId: adjudication.allowlistId,
      entryId: matches[0].entryId,
      key: repair.key,
      printedNumber: parentRepair.printedNumber,
      sourcePage: adjudication.sourcePage,
      sourceHash: adjudication.sourceHash,
      solutionSourceHash: adjudication.solutionSourceHash,
      problemContextFrom: parentRepair.contextFrom,
      problemContextTo: parentRepair.contextTo,
      solutionContextFrom: adjudication.solutionContextFrom,
      solutionContextTo: adjudication.solutionContextTo,
      baseSolutionCheckpoint: adjudication.baseSolutionCheckpoint,
      baseSolutionItemHash: adjudication.baseSolutionItemHash,
      parentRepair,
      parentRepairEvidenceHash: adjudication.parentRepairEvidenceHash,
      ...(positiveSpec ? {
        scopeAuthority: {
          decision: "accept",
          canonicalSubject: positiveSpec.expectedCanonicalSubject,
          allowedAchievementCodes: [...positiveSpec.allowedAchievementCodes],
          requiredReasonCode: PROBLEM_REPAIR_POSITIVE_SCOPE_AUTHORITY_REASON_CODE,
        },
      } : {}),
      trigger: adjudication.trigger,
      baseQuestionHash: adjudication.baseQuestionHash,
      baseClassificationHash: adjudication.baseClassificationHash,
    };
    const basisDigest = canonicalEvidenceHash(basis);
    const adjudicationVersion = positiveSpec
      ? PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_VERSION
      : PROBLEM_REPAIR_SCOPE_ADJUDICATION_VERSION;
    const adjudicationPromptDigest = positiveSpec
      ? PROBLEM_REPAIR_POSITIVE_SCOPE_ADJUDICATION_PROMPT_DIGEST
      : PROBLEM_REPAIR_SCOPE_ADJUDICATION_PROMPT_DIGEST;
    const directory = positiveSpec
      ? "classification-repair-positive-scope-adjudications"
      : "classification-repair-scope-adjudications";
    const expectedPath = `${directory}/` +
      `v${adjudicationVersion}-${String(adjudication.sourcePage).padStart(4, "0")}-` +
      `${parentRepair.printedNumber.padStart(4, "0")}-${basisDigest}-${CLASSIFIER_DIGEST}.json`;
    const checkpoint = object(
      JSON.parse(readFileSync(confinedStateFile(stateDir, expectedPath, "problem repair scope adjudication"), "utf8")),
      expectedPath
    );
    if (
      adjudication.classificationArtifact.path !== expectedPath ||
      adjudication.classificationArtifact.adjudicationPromptVersion !==
        adjudicationVersion ||
      adjudication.classificationArtifact.adjudicationPromptDigest !==
        adjudicationPromptDigest ||
      checkpoint.version !== adjudicationVersion || checkpoint.entryId !== matches[0].entryId ||
      checkpoint.basisDigest !== basisDigest || canonicalEvidenceHash(checkpoint.basis) !== canonicalEvidenceHash(basis) ||
      checkpoint.classifierVersion !== CLASSIFIER_VERSION || checkpoint.rulesDigest !== CLASSIFIER_DIGEST ||
      checkpoint.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
      checkpoint.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST ||
      checkpoint.adjudicationPromptVersion !== adjudicationVersion ||
      checkpoint.adjudicationPromptDigest !== adjudicationPromptDigest ||
      checkpoint.model !== IMPORT_MODEL || checkpoint.reasoningEffort !== IMPORT_REASONING_EFFORT ||
      !Array.isArray(checkpoint.items) || checkpoint.items.length !== 1 ||
      canonicalEvidenceHash(checkpoint.items[0]) !== adjudication.classificationArtifactItemHash ||
      (positiveSpec && canonicalEvidenceHash(checkpoint.items[0]) !==
        canonicalEvidenceHash(currentMatches[0].classification))
    ) throw new Error(`${repair.key} problem repair scope adjudication checkpoint가 다릅니다`);
    if (declared.has(expectedPath)) {
      throw new Error(`problem repair scope adjudication artifact가 중복 선언됐습니다: ${expectedPath}`);
    }
    declared.set(expectedPath, adjudication.classificationArtifact.sha256);
  }
  const actual = new Set<string>();
  for (const directory of [
    "classification-repair-scope-adjudications",
    "classification-repair-positive-scope-adjudications",
  ]) {
    const path = join(stateDir, directory);
    if (!existsSync(path)) continue;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".tmp")) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(
          `problem repair scope adjudication directory에 regular file이 아닌 항목이 있습니다: ${directory}/${entry.name}`
        );
      }
      actual.add(`${directory}/${entry.name}`);
    }
  }
  const extras = [...actual].filter((path) => !declared.has(path));
  const missing = [...declared.keys()].filter((path) => !actual.has(path));
  if (extras.length > 0 || missing.length > 0) {
    throw new Error(
      `problem repair scope adjudication orphan/conflict: extra=${extras.join(",") || "-"}, ` +
      `missing=${missing.join(",") || "-"}`
    );
  }
}

async function assertProblemRevisionScopeAdjudicationAuthority(
  stateDir: string,
  repairs: Iterable<ProblemRepairEvidence>
): Promise<void> {
  const declared = new Map<string, string>();
  for (const repair of repairs) {
    const revision = repair.revision;
    const adjudication = revision?.scopeAdjudication;
    if (!revision || !adjudication) continue;
    const { scopeAdjudication: _scopeAdjudication, ...parentRevision } = revision;
    const parentRepair: ProblemRepairEvidence = { ...repair, revision: parentRevision };
    const matches = PROBLEM_REVISION_SCOPE_ADJUDICATION_ALLOWLIST.filter((spec) =>
      spec.allowlistId === adjudication.allowlistId && spec.key === adjudication.key &&
      spec.sourcePage === adjudication.sourcePage && spec.sourceHash === adjudication.sourceHash &&
      spec.solutionSourceHash === adjudication.solutionSourceHash &&
      spec.parentProblemArtifactHash === parentRevision.problemArtifact.sha256 &&
      spec.parentClassificationArtifactHash === parentRevision.classificationArtifact.sha256 &&
      spec.terminalArtifactHash === adjudication.trigger.terminalCheckpoint.sha256
    );
    if (
      matches.length !== 1 || repair.key !== adjudication.key || repair.scopeAdjudication || parentRevision.recovery ||
      canonicalEvidenceHash(parentRepair) !== adjudication.parentRepairEvidenceHash ||
      canonicalEvidenceHash(parentRevision) !== adjudication.parentRevisionEvidenceHash ||
      adjudication.parentRecoveryEvidenceHash !== undefined ||
      adjudication.printedNumber !== repair.printedNumber ||
      adjudication.problemContextFrom !== repair.contextFrom || adjudication.problemContextTo !== repair.contextTo ||
      canonicalEvidenceHash(adjudication.baseSolutionCheckpoint) !==
        canonicalEvidenceHash(repair.baseSolutionCheckpoint) ||
      adjudication.baseSolutionItemHash !== repair.baseSolutionItemHash ||
      adjudication.baseQuestionHash !== parentRevision.effectiveQuestionHash ||
      adjudication.effectiveQuestionHash !== parentRevision.effectiveQuestionHash ||
      adjudication.baseClassificationHash !== parentRevision.effectiveClassificationHash ||
      adjudication.effectiveClassificationHash !== adjudication.classificationArtifactItemHash ||
      adjudication.trigger.terminalItem.key !== repair.key || adjudication.trigger.terminalItem.status !== "exact" ||
      adjudication.trigger.terminalItem.scopeDecision !== "reject" ||
      adjudication.trigger.terminalItem.scopeConfidence < 0.9 ||
      canonicalEvidenceHash(adjudication.trigger.terminalItem) !== adjudication.trigger.terminalItemHash ||
      sha256Text(adjudication.trigger.terminalItem.evidence) !== adjudication.trigger.evidenceHash ||
      sha256Text(adjudication.trigger.terminalItem.scopeEvidence) !== adjudication.trigger.scopeEvidenceHash ||
      adjudication.classificationArtifact.rulesDigest !== CLASSIFIER_DIGEST ||
      adjudication.classificationArtifact.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
      adjudication.classificationArtifact.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST
    ) throw new Error(`${repair.key} problem revision scope adjudication evidence가 parent/allowlist와 다릅니다`);

    for (const [label, pointer] of [
      ["revision scope terminal fidelity", adjudication.trigger.terminalCheckpoint],
      ["problem revision scope adjudication", adjudication.classificationArtifact],
      ["problem revision parent", parentRevision.problemArtifact],
      ["classification revision parent", parentRevision.classificationArtifact],
    ] as const) {
      const path = confinedStateFile(stateDir, pointer.path, label);
      if (await sha256File(path) !== pointer.sha256) throw new Error(`${label} hash가 다릅니다: ${pointer.path}`);
    }
    const revisionProblemCheckpoint = object(JSON.parse(readFileSync(confinedStateFile(
      stateDir,
      parentRevision.problemArtifact.path,
      "revision scope parent problem revision"
    ), "utf8")), "revision scope parent problem revision");
    const revisionQuestions = Array.isArray(revisionProblemCheckpoint.items)
      ? revisionProblemCheckpoint.items.map((value) => object(value, "revision scope parent question"))
      : [];
    const revisionQuestion = revisionQuestions.find((value) =>
      Number(value.page) === adjudication.sourcePage && Number(value.number) === Number(repair.printedNumber)
    );
    const currentPath = confinedStateFile(
      stateDir,
      adjudication.trigger.terminalCheckpoint.path,
      "revision scope current terminal fidelity"
    );
    const currentCheckpoint = object(
      JSON.parse(readFileSync(currentPath, "utf8")),
      "revision scope current terminal fidelity"
    );
    const currentInputs = Array.isArray(currentCheckpoint.inputs)
      ? currentCheckpoint.inputs.map((value) => object(value, "revision scope current terminal input"))
      : [];
    const currentItems = Array.isArray(currentCheckpoint.items)
      ? currentCheckpoint.items.map((value) => object(value, "revision scope current terminal item"))
      : [];
    const currentInputKeys = currentInputs.map((value) => exactString(
      value.key,
      "revision scope current terminal input key",
      100
    ));
    const currentItemKeys = currentItems.map((value) => exactString(
      value.key,
      "revision scope current terminal item key",
      100
    ));
    const currentTargetInputs = currentInputs.filter((value) => value.key === repair.key);
    const currentTargetItems = currentItems.filter((value) => value.key === repair.key);
    const currentEffectiveCorpusHash = adjudication.trigger.preAdjudicationEffectiveCorpusHash;
    const expectedCurrentPath = `problem-terminal-fidelity/v${PROBLEM_TERMINAL_FIDELITY_VERSION}-0000-` +
      `${currentEffectiveCorpusHash}-${adjudication.trigger.terminalCheckpoint.inputHash}.json`;
    const expectedCurrentInput = revisionQuestion && {
      key: repair.key,
      printed_number: repair.printedNumber,
      source_page: Number(revisionQuestion.page),
      qtype: revisionQuestion.qtype,
      question: revisionQuestion.question,
      choices: revisionQuestion.choices,
      figure: revisionQuestion.figure,
      figure_description: revisionQuestion.figure_description,
      box: revisionQuestion.box,
    };
    if (
      !revisionQuestion || canonicalEvidenceHash(revisionQuestion) !==
        (parentRevision.problemArtifactItemHash ?? parentRevision.effectiveQuestionHash) ||
      adjudication.trigger.terminalCheckpoint.path !== expectedCurrentPath ||
      adjudication.trigger.terminalCheckpoint.from !== 1 ||
      adjudication.trigger.terminalCheckpoint.to !== adjudication.problemContextTo ||
      adjudication.trigger.terminalCheckpoint.ownedFrom !== 1 ||
      adjudication.trigger.terminalCheckpoint.ownedTo !== adjudication.problemContextTo ||
      canonicalEvidenceHash(currentCheckpoint) !== adjudication.trigger.terminalCheckpoint.sha256 ||
      currentCheckpoint.version !== PROBLEM_TERMINAL_FIDELITY_VERSION ||
      currentCheckpoint.entryId !== matches[0].entryId || currentCheckpoint.sourceHash !== adjudication.sourceHash ||
      currentCheckpoint.effectiveCorpusHash !== currentEffectiveCorpusHash ||
      currentCheckpoint.inputHash !== adjudication.trigger.terminalCheckpoint.inputHash ||
      currentCheckpoint.inputHash !== canonicalEvidenceHash(currentCheckpoint.inputs) ||
      currentCheckpoint.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
      currentCheckpoint.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST ||
      currentCheckpoint.rulesDigest !== CLASSIFIER_DIGEST ||
      currentCheckpoint.scopePromptDigest !== PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST ||
      currentCheckpoint.model !== IMPORT_MODEL || currentCheckpoint.reasoningEffort !== IMPORT_REASONING_EFFORT ||
      currentInputKeys.length !== currentItemKeys.length || new Set(currentInputKeys).size !== currentInputKeys.length ||
      new Set(currentItemKeys).size !== currentItemKeys.length ||
      canonicalEvidenceHash([...currentInputKeys].sort(compareCorpusQuestionKeys)) !==
        canonicalEvidenceHash([...currentItemKeys].sort(compareCorpusQuestionKeys)) ||
      currentTargetInputs.length !== 1 || canonicalEvidenceHash(currentTargetInputs[0]) !==
        canonicalEvidenceHash(expectedCurrentInput) || currentTargetItems.length !== 1 ||
      canonicalEvidenceHash(currentTargetItems[0]) !== adjudication.trigger.terminalItemHash
    ) throw new Error(`${repair.key} revision scope current terminal checkpoint가 다릅니다`);
    const basis = {
      allowlistId: adjudication.allowlistId,
      entryId: matches[0].entryId,
      key: repair.key,
      printedNumber: repair.printedNumber,
      sourcePage: adjudication.sourcePage,
      sourceHash: adjudication.sourceHash,
      solutionSourceHash: adjudication.solutionSourceHash,
      problemContextFrom: repair.contextFrom,
      problemContextTo: repair.contextTo,
      solutionContextFrom: adjudication.solutionContextFrom,
      solutionContextTo: adjudication.solutionContextTo,
      baseSolutionCheckpoint: adjudication.baseSolutionCheckpoint,
      baseSolutionItemHash: adjudication.baseSolutionItemHash,
      parentRepair,
      parentRepairEvidenceHash: adjudication.parentRepairEvidenceHash,
      parentRevisionEvidenceHash: adjudication.parentRevisionEvidenceHash,
      trigger: adjudication.trigger,
      baseQuestionHash: adjudication.baseQuestionHash,
      baseClassificationHash: adjudication.baseClassificationHash,
    };
    const basisDigest = canonicalEvidenceHash(basis);
    const expectedPath = `classification-revision-scope-adjudications/` +
      `v${PROBLEM_REVISION_SCOPE_ADJUDICATION_VERSION}-${String(adjudication.sourcePage).padStart(4, "0")}-` +
      `${repair.printedNumber.padStart(4, "0")}-${basisDigest}-${CLASSIFIER_DIGEST}.json`;
    const checkpoint = object(JSON.parse(readFileSync(confinedStateFile(
      stateDir,
      expectedPath,
      "problem revision scope adjudication"
    ), "utf8")), expectedPath);
    if (
      adjudication.classificationArtifact.path !== expectedPath ||
      adjudication.classificationArtifact.adjudicationPromptVersion !==
        PROBLEM_REVISION_SCOPE_ADJUDICATION_VERSION ||
      adjudication.classificationArtifact.adjudicationPromptDigest !==
        PROBLEM_REVISION_SCOPE_ADJUDICATION_PROMPT_DIGEST ||
      checkpoint.version !== PROBLEM_REVISION_SCOPE_ADJUDICATION_VERSION || checkpoint.entryId !== matches[0].entryId ||
      checkpoint.basisDigest !== basisDigest || canonicalEvidenceHash(checkpoint.basis) !== canonicalEvidenceHash(basis) ||
      checkpoint.classifierVersion !== CLASSIFIER_VERSION || checkpoint.rulesDigest !== CLASSIFIER_DIGEST ||
      checkpoint.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
      checkpoint.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST ||
      checkpoint.adjudicationPromptVersion !== PROBLEM_REVISION_SCOPE_ADJUDICATION_VERSION ||
      checkpoint.adjudicationPromptDigest !== PROBLEM_REVISION_SCOPE_ADJUDICATION_PROMPT_DIGEST ||
      checkpoint.model !== IMPORT_MODEL || checkpoint.reasoningEffort !== IMPORT_REASONING_EFFORT ||
      !Array.isArray(checkpoint.items) || checkpoint.items.length !== 1 ||
      canonicalEvidenceHash(checkpoint.items[0]) !== adjudication.classificationArtifactItemHash
    ) throw new Error(`${repair.key} problem revision scope adjudication checkpoint가 다릅니다`);
    if (declared.has(expectedPath)) {
      throw new Error(`problem revision scope adjudication artifact가 중복 선언됐습니다: ${expectedPath}`);
    }
    declared.set(expectedPath, adjudication.classificationArtifact.sha256);
  }
  const directory = join(stateDir, "classification-revision-scope-adjudications");
  const actual = new Set<string>();
  if (existsSync(directory)) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".tmp")) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`problem revision scope adjudication directory에 regular file이 아닌 항목이 있습니다: ${entry.name}`);
      }
      actual.add(`classification-revision-scope-adjudications/${entry.name}`);
    }
  }
  const extras = [...actual].filter((path) => !declared.has(path));
  const missing = [...declared.keys()].filter((path) => !actual.has(path));
  if (extras.length > 0 || missing.length > 0) {
    throw new Error(
      `problem revision scope adjudication orphan/conflict: extra=${extras.join(",") || "-"}, ` +
      `missing=${missing.join(",") || "-"}`
    );
  }
}

async function recoverClassifiedQuestion(
  entry: CorpusManifestEntry,
  problem: PdfEvidence,
  stateDir: string,
  contextPath: string,
  input: ProblemRecoveryInput
): Promise<{ classified: ClassifiedQuestion; evidence: ProblemRecoveryEvidence }> {
  if (
    questionKey(input.revised.question) !== input.key || input.revised.question.page !== input.sourcePage ||
    canonicalEvidenceHash(input.revised.question) !== input.revisionProblemArtifact.itemHash ||
    canonicalEvidenceHash(input.revised.classification) !== input.revisionClassificationArtifact.itemHash
  ) throw new Error(`${input.key} problem recovery 입력이 failed revision과 다릅니다`);
  if (
    input.trigger.kind === "classification"
      ? input.revised.classification.transcription_status === "exact" ||
        input.trigger.evidence !== input.revised.classification.transcription_evidence
      : input.revised.classification.transcription_status !== "exact"
  ) throw new Error(`${input.key} problem recovery trigger가 revision과 다릅니다`);
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
  let terminalTrigger: Extract<ProblemRecoveryEvidence["trigger"], { kind: "terminal" }> | undefined;
  if (input.trigger.kind === "terminal") {
    const terminalPath = confinedStateFile(stateDir, input.trigger.checkpoint.path, "terminal recovery fidelity");
    if (await sha256File(terminalPath) !== input.trigger.checkpoint.sha256) {
      throw new Error(`${input.key} terminal recovery fidelity hash가 다릅니다`);
    }
    const terminalCheckpoint = object(JSON.parse(readFileSync(terminalPath, "utf8")), "terminal recovery fidelity");
    const terminalItem = Array.isArray(terminalCheckpoint.items)
      ? terminalCheckpoint.items.find((value) => object(value, "terminal recovery fidelity item").key === input.key)
      : undefined;
    if (
      terminalCheckpoint.version !== PROBLEM_TERMINAL_FIDELITY_VERSION ||
      terminalCheckpoint.entryId !== entry.id || terminalCheckpoint.sourceHash !== problem.sha256 ||
      terminalCheckpoint.from !== input.trigger.checkpoint.from ||
      terminalCheckpoint.to !== input.trigger.checkpoint.to ||
      terminalCheckpoint.ownedFrom !== input.trigger.checkpoint.ownedFrom ||
      terminalCheckpoint.ownedTo !== input.trigger.checkpoint.ownedTo ||
      terminalCheckpoint.inputHash !== input.trigger.checkpoint.inputHash ||
      terminalCheckpoint.effectiveCorpusHash !== input.trigger.effectiveCorpusHash ||
      terminalCheckpoint.transcriptionGateVersion !== TRANSCRIPTION_GATE_VERSION ||
      terminalCheckpoint.transcriptionPromptDigest !== TRANSCRIPTION_PROMPT_DIGEST ||
      terminalCheckpoint.rulesDigest !== CLASSIFIER_DIGEST ||
      terminalCheckpoint.scopePromptDigest !== PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST ||
      terminalCheckpoint.model !== IMPORT_MODEL ||
      terminalCheckpoint.reasoningEffort !== IMPORT_REASONING_EFFORT ||
      !terminalItem || canonicalEvidenceHash(terminalItem) !== input.trigger.itemHash ||
      canonicalEvidenceHash(input.trigger.item) !== input.trigger.itemHash ||
      object(terminalItem, "terminal recovery fidelity item").status === "exact" ||
      object(terminalItem, "terminal recovery fidelity item").evidence !== input.trigger.evidence
    ) throw new Error(`${input.key} terminal recovery fidelity evidence가 다릅니다`);
    terminalTrigger = {
      kind: "terminal",
      evidenceHash: sha256Text(input.trigger.evidence),
      terminalCheckpoint: input.trigger.checkpoint,
      terminalItemHash: input.trigger.itemHash,
      terminalItem: input.trigger.item,
      preRecoveryEffectiveCorpusHash: input.trigger.effectiveCorpusHash,
    };
  }
  const commonProblemBasis = {
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
  };
  const problemBasis = terminalTrigger
    ? { ...commonProblemBasis, trigger: terminalTrigger }
    : { ...commonProblemBasis, failedClassificationEvidenceHash };
  const problemRecoveryVersion = terminalTrigger ? PROBLEM_TERMINAL_RECOVERY_VERSION : PROBLEM_RECOVERY_VERSION;
  const classificationRecoveryVersion = terminalTrigger
    ? CLASSIFICATION_TERMINAL_RECOVERY_VERSION
    : CLASSIFICATION_RECOVERY_VERSION;
  const basisDigest = canonicalEvidenceHash(problemBasis);
  const problemRelativePath = `problem-recoveries/v${problemRecoveryVersion}-` +
    `${String(input.sourcePage).padStart(4, "0")}-${input.printedNumber.padStart(4, "0")}-${basisDigest}.json`;
  const problemPath = join(stateDir, problemRelativePath);
  let problemCheckpoint: Record<string, unknown>;
  let recovered: QuizItemEx;
  if (existsSync(problemPath)) {
    problemCheckpoint = object(JSON.parse(readFileSync(problemPath, "utf8")), problemRelativePath);
    if (
      problemCheckpoint.version !== problemRecoveryVersion || problemCheckpoint.entryId !== entry.id ||
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
      recoveryEvidence: input.trigger.evidence,
      reasoningEffort: IMPORT_REASONING_EFFORT,
    })))[0];
    problemCheckpoint = {
      version: problemRecoveryVersion,
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
  const classificationRelativePath = `classification-recoveries/v${classificationRecoveryVersion}-` +
    `${String(input.sourcePage).padStart(4, "0")}-${input.printedNumber.padStart(4, "0")}-` +
    `${classificationBasisDigest}-${CLASSIFIER_DIGEST}.json`;
  const classificationPath = join(stateDir, classificationRelativePath);
  let classificationCheckpoint: Record<string, unknown>;
  let classification: ClassificationDecision;
  if (existsSync(classificationPath)) {
    classificationCheckpoint = object(JSON.parse(readFileSync(classificationPath, "utf8")), classificationRelativePath);
    if (
      classificationCheckpoint.version !== classificationRecoveryVersion ||
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
      version: classificationRecoveryVersion,
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
  const recoveryEvidence: ProblemRecoveryEvidence = {
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
      ...(terminalTrigger ? { trigger: terminalTrigger } : { failedClassificationEvidenceHash }),
      baseQuestionHash: problemBasis.baseQuestionHash,
      effectiveQuestionHash: problemItemHash,
      baseClassificationHash: problemBasis.baseClassificationHash,
      effectiveClassificationHash: canonicalEvidenceHash(classification),
  };
  if (classification.transcription_status !== "exact") {
    let failed: ClassifiedQuestion = { question: recovered, classification };
    let parentRecovery = recoveryEvidence;
    let usedCropAdjudication = false;
    if (problemCropAdjudicationSpec(entry, input.key, input.sourcePage, problem.sha256)) {
      const adjudicated = await adjudicateCropClassifiedQuestion(entry, problem, stateDir, failed, parentRecovery);
      usedCropAdjudication = true;
      failed = adjudicated.classified;
      parentRecovery = { ...parentRecovery, adjudication: adjudicated.evidence };
      if (failed.classification.transcription_status === "exact") {
        return { classified: failed, evidence: parentRecovery };
      }
    }
    if (problemManualAdjudicationSpec(entry.id, input.key, input.sourcePage, problem.sha256)) {
      const adjudicated = await adjudicateProblemManual(entry, problem, stateDir, failed, parentRecovery);
      return {
        classified: adjudicated.classified,
        evidence: { ...parentRecovery, manualAdjudication: adjudicated.evidence },
      };
    }
    if (usedCropAdjudication) throw new Error(`${input.key} allowlisted crop adjudication도 exact가 아닙니다`);
    throw new Error(`${input.key} final source-grounded recovery도 exact가 아닙니다`);
  }
  return {
    classified: { question: recovered, classification },
    evidence: recoveryEvidence,
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
            trigger: { kind: "classification", evidence: classification.transcription_evidence },
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
    const expectedClassificationCheckpoint = {
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
    if (canonicalEvidenceHash(classificationCheckpoint) !== canonicalEvidenceHash(expectedClassificationCheckpoint)) {
      throw new Error(`${key} classification repair exact envelope가 다릅니다`);
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
    solutionEvidence,
    stateDir,
    baseByKey,
    baseSolutionsByNumber
  );
  let effective = [...initial];
  const repairs = new Map<string, ProblemRepairEvidence>();
  const persistedRepairs = await hydratePersistedProblemRepairBatches(
    entry,
    problem,
    solutionEvidence,
    stateDir,
    baseByKey,
    baseSolutionsByNumber
  );
  for (const repaired of persistedRepairs) {
    const key = repaired.evidence.key;
    const index = effective.findIndex((item) => questionKey(item.question) === key);
    if (index < 0 || repairs.has(key)) throw new Error(`${key} persisted problem repair hydration이 중복되었습니다`);
    effective[index] = repaired.classified;
    repairs.set(key, repaired.evidence);
  }
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
    const terminalRecoveryCurrents: Array<{
      key: string;
      current: ClassifiedQuestion;
      repair: ProblemRepairEvidence;
      trigger: Extract<ProblemRecoveryTrigger, { kind: "terminal" }>;
    }> = [];
    for (const key of uniqueKeys) {
      if (initialRepairKeys.has(key)) continue;
      const index = effective.findIndex((item) => questionKey(item.question) === key);
      if (index < 0) throw new Error(`${key} effective corpus 교체 위치가 없습니다`);
      const existing = repairs.get(key);
      if (existing) {
        if (!revisionKind) continue;
        if (existing.scopeAdjudication || existing.revision?.scopeAdjudication) {
          throw new Error(`${key} problem scope adjudication 뒤에는 추가 revision을 허용하지 않습니다`);
        }
        const current = effective[index];
        const trigger: ProblemRevisionTrigger | undefined = revisionKind === "terminal"
          ? terminalTriggers?.get(key)
          : current.classification.transcription_status === "exact" ? undefined : {
              kind: "classification",
              evidence: current.classification.transcription_evidence,
            };
        if (!trigger) throw new Error(`${key} problem revision trigger가 없습니다`);
        if (existing.revision) {
          if (trigger.kind !== "terminal" || existing.revision.recovery) {
            throw new Error(`${key} problem recovery는 한 번만 허용됩니다`);
          }
          terminalRecoveryCurrents.push({ key, current, repair: existing, trigger });
          continue;
        }
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
    if (terminalRecoveryCurrents.length > 0) {
      const recovered = await mapPool(terminalRecoveryCurrents, IMPORT_CONCURRENCY, async (item) => {
        const revision = item.repair.revision!;
        return withImporterPdfForAnalysis(problem, (analysisProblem) =>
          withProblemContextSlice(
            analysisProblem.path,
            item.repair.contextFrom,
            item.repair.contextTo,
            async (contextPath) => ({
              key: item.key,
              recovered: await recoverClassifiedQuestion(entry, problem, stateDir, contextPath, {
                key: item.key,
                printedNumber: item.repair.printedNumber,
                sourcePage: item.current.question.page!,
                contextFrom: item.repair.contextFrom,
                contextTo: item.repair.contextTo,
                repair: item.repair,
                revised: item.current,
                revisionProblemArtifact: {
                  ...revision.problemArtifact,
                  itemHash: revision.problemArtifactItemHash ?? revision.effectiveQuestionHash,
                },
                revisionClassificationArtifact: {
                  path: revision.classificationArtifact.path,
                  sha256: revision.classificationArtifact.sha256,
                  itemHash: revision.classificationArtifactItemHash ?? revision.effectiveClassificationHash,
                },
                trigger: item.trigger,
              }),
            })
          )
        );
      });
      for (const item of recovered) {
        const index = effective.findIndex((current) => questionKey(current.question) === item.key);
        const existing = repairs.get(item.key);
        if (index < 0 || !existing?.revision || existing.revision.recovery) {
          throw new Error(`${item.key} terminal problem recovery authority가 없습니다`);
        }
        effective[index] = item.recovered.classified;
        repairs.set(item.key, {
          ...existing,
          revision: { ...existing.revision, recovery: item.recovered.evidence },
        });
        changedKeys.add(item.key);
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
      const preRecoveryEffectiveCorpusHash = canonicalEvidenceHash(effective);
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
          item,
          effectiveCorpusHash: preRecoveryEffectiveCorpusHash,
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
    const preAdjudicationClassified = [...effective];
    const preAdjudicationEffectiveCorpusHash = canonicalEvidenceHash(preAdjudicationClassified);
    const repairScopeConflicts = finalProblemFidelity.items.filter((item) => {
      const current = effective.find((candidate) => questionKey(candidate.question) === item.key);
      if (
        !current || current.classification.decision !== "accept" ||
        current.classification.transcription_status !== "exact" || item.status !== "exact" ||
        item.scopeDecision !== "reject" || item.scopeConfidence < 0.9
      ) return false;
      const positiveSpec = problemRepairPositiveScopeAdjudicationSpec(
        entry, item.key, current.question.page!, problem.sha256, solutionEvidence.sha256
      );
      if (positiveSpec && repairs.get(item.key) && hasPositiveRepairScopeAuthority(repairs.get(item.key)!)) {
        return false;
      }
      return problemRepairScopeAdjudicationSpec(
        entry, item.key, current.question.page!, problem.sha256, solutionEvidence.sha256
      ) !== null || problemRevisionScopeAdjudicationSpec(
        entry, item.key, current.question.page!, problem.sha256, solutionEvidence.sha256
      ) !== null || positiveSpec !== null;
    });
    if (repairScopeConflicts.length > 0) {
      for (const item of repairScopeConflicts) {
        const index = effective.findIndex((candidate) => questionKey(candidate.question) === item.key);
        const current = effective[index];
        const repair = repairs.get(item.key);
        const revisionScope = current && problemRevisionScopeAdjudicationSpec(
          entry, item.key, current.question.page!, problem.sha256, solutionEvidence.sha256
        ) !== null;
        if (
          index < 0 || !repair || repair.scopeAdjudication ||
          (revisionScope
            ? !repair.revision || repair.revision.recovery || repair.revision.scopeAdjudication
            : Boolean(repair.revision))
        ) {
          throw new Error(`${item.key} problem repair/revision scope adjudication parent가 유효하지 않습니다`);
        }
        const checkpoints = finalProblemFidelity.checkpoints.filter((checkpoint) =>
          current.question.page! >= checkpoint.ownedFrom && current.question.page! <= checkpoint.ownedTo
        );
        if (checkpoints.length !== 1) {
          throw new Error(`${item.key} problem repair scope adjudication terminal checkpoint가 유일하지 않습니다`);
        }
        const number = numericPrintedLocator(current.question.number);
        const solution = number === null ? undefined : baseSolutionsByNumber.get(number);
        if (!solution) throw new Error(`${item.key} problem repair scope adjudication 공식 해설이 없습니다`);
        const adjudicated = await adjudicateProblemRepairScope(
          entry,
          problem,
          solutionEvidence,
          stateDir,
          {
            current,
            preAdjudicationClassified,
            repair,
            solution,
            terminalCheckpoint: checkpoints[0],
            terminalItem: item,
            preAdjudicationEffectiveCorpusHash,
          }
        );
        effective[index] = adjudicated.classified;
        repairs.set(item.key, revisionScope
          ? {
              ...repair,
              revision: { ...repair.revision!, scopeAdjudication: adjudicated.evidence },
            }
          : { ...repair, scopeAdjudication: adjudicated.evidence });
      }
      invalidateSemanticSolutionRevisionTriggers(solutionRevisionTriggers, true);
      finalSemantic = null;
      finalSolutionAudit = null;
      finalProblemFidelity = null;
      continue;
    }
    const scopeConflicts = finalProblemFidelity.items.filter((item) => {
      const current = effective.find((candidate) => questionKey(candidate.question) === item.key);
      if (
        !current || current.classification.decision !== "accept" ||
        current.classification.transcription_status !== "exact" || item.status !== "exact" ||
        item.scopeDecision !== "reject" || item.scopeConfidence < 0.9
      ) return false;
      return problemScopeAdjudicationSpec(
        entry, item.key, current.question.page!, problem.sha256, solutionEvidence.sha256
      ) !== null;
    });
    if (scopeConflicts.length > 0) {
      for (const item of scopeConflicts) {
        const index = effective.findIndex((candidate) => questionKey(candidate.question) === item.key);
        const current = effective[index];
        const repair = repairs.get(item.key);
        const recovery = repair?.revision?.recovery;
        if (index < 0 || !repair?.revision || !recovery || recovery.scopeAdjudication) {
          throw new Error(`${item.key} problem scope adjudication은 recovery 뒤 한 번만 허용됩니다`);
        }
        const checkpoints = finalProblemFidelity.checkpoints.filter((checkpoint) =>
          current.question.page! >= checkpoint.ownedFrom && current.question.page! <= checkpoint.ownedTo
        );
        if (checkpoints.length !== 1) {
          throw new Error(`${item.key} problem scope adjudication terminal checkpoint가 유일하지 않습니다`);
        }
        const number = numericPrintedLocator(current.question.number);
        const solution = number === null ? undefined : baseSolutionsByNumber.get(number);
        if (!solution) throw new Error(`${item.key} problem scope adjudication 공식 해설이 없습니다`);
        const adjudicated = await adjudicateProblemScope(
          entry,
          problem,
          solutionEvidence,
          stateDir,
          {
            current,
            preAdjudicationClassified,
            repair,
            recovery,
            solution,
            terminalCheckpoint: checkpoints[0],
            terminalItem: item,
            preAdjudicationEffectiveCorpusHash,
          }
        );
        effective[index] = adjudicated.classified;
        repairs.set(item.key, {
          ...repair,
          revision: {
            ...repair.revision,
            recovery: { ...recovery, scopeAdjudication: adjudicated.evidence },
          },
        });
      }
      invalidateSemanticSolutionRevisionTriggers(solutionRevisionTriggers, true);
      finalSemantic = null;
      finalSolutionAudit = null;
      finalProblemFidelity = null;
      continue;
    }
    const scopeAdjudicatedKeys = new Set([...repairs.values()].flatMap((repair) =>
      repair.scopeAdjudication || repair.revision?.scopeAdjudication ||
        repair.revision?.recovery?.scopeAdjudication ||
        repair.revision?.recovery?.manualAdjudication
        ? [repair.key]
        : []
    ));
    assertTerminalProblemPolicy(
      effective,
      finalProblemFidelity.items,
      repairedKeys,
      scopeAdjudicatedKeys,
      positiveRepairScopeAuthorityKeys(repairs.values())
    );
    await assertProblemCropAdjudicationAuthority(stateDir, repairs.values());
    await assertProblemManualAdjudicationAuthority(stateDir, repairs.values());
    await assertProblemScopeAdjudicationAuthority(stateDir, repairs.values());
    await assertProblemRepairScopeAdjudicationAuthority(stateDir, repairs.values(), effective);
    await assertProblemRevisionScopeAdjudicationAuthority(stateDir, repairs.values());
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
      problem,
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
      markerInputs
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
  const finalScopeAdjudicatedKeys = new Set([...repairs.values()].flatMap((repair) =>
    repair.scopeAdjudication || repair.revision?.scopeAdjudication ||
      repair.revision?.recovery?.scopeAdjudication ||
      repair.revision?.recovery?.manualAdjudication
      ? [repair.key]
      : []
  ));
  const finalPositiveScopeAuthorityKeys = positiveRepairScopeAuthorityKeys(repairs.values());
  const remainingTranscriptionIssues = transcriptionRepairKeys(effective).filter((key) => {
    const current = effective.find((item) => questionKey(item.question) === key);
    const terminal = finalTerminalByKey.get(key);
    return !current || !terminal || !isAuthorizedScopeRejectedMismatch(current, terminal, finalRepairedKeys);
  });
  if (remainingTranscriptionIssues.length > 0) {
    throw new Error(`terminal corpus에 원본 전사 미검증 문항이 있습니다: ${remainingTranscriptionIssues.join(", ")}`);
  }
  assertTerminalProblemPolicy(
    effective,
    finalProblemFidelity.items,
    finalRepairedKeys,
    finalScopeAdjudicatedKeys,
    finalPositiveScopeAuthorityKeys
  );
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
      effectiveCorpusHash,
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
    new Set(answerAudit.repairs.map((repair) => repair.key)),
    new Set(answerAudit.repairs.flatMap((repair) =>
      repair.scopeAdjudication || repair.revision?.scopeAdjudication ||
        repair.revision?.recovery?.scopeAdjudication ||
        repair.revision?.recovery?.manualAdjudication
        ? [repair.key]
        : []
    )),
    positiveRepairScopeAuthorityKeys(answerAudit.repairs)
  );
  await assertProblemManualAdjudicationAuthority(stateDir, answerAudit.repairs);
  await assertProblemScopeAdjudicationAuthority(stateDir, answerAudit.repairs);
  await assertProblemRepairScopeAdjudicationAuthority(stateDir, answerAudit.repairs, answerAudit.classified);
  await assertProblemRevisionScopeAdjudicationAuthority(stateDir, answerAudit.repairs);
  await assertSolutionRevisionFidelityAdjudicationAuthority(stateDir, answerAudit.solutionRepairs);
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

export function baseDifficultyByQuestionKey(
  classified: ClassifiedQuestion[]
): Map<string, QuizItemEx["difficulty"]> {
  const result = new Map<string, QuizItemEx["difficulty"]>();
  for (const { question } of classified) {
    const key = questionKey(question);
    if (result.has(key)) throw new Error(`base difficulty key가 중복입니다: ${key}`);
    result.set(key, question.difficulty);
  }
  return result;
}

export function matchOfficialSolutions(
  entry: Pick<CorpusManifestEntry, "subject">,
  classified: ClassifiedQuestion[],
  solutions: SolutionItem[],
  baseDifficultyByKey: ReadonlyMap<string, QuizItemEx["difficulty"]>
): ImportedQuestion[] {
  const effectiveKeys = classified.map(({ question }) => questionKey(question));
  const effectiveKeySet = new Set(effectiveKeys);
  if (effectiveKeySet.size !== effectiveKeys.length) throw new Error("effective difficulty key가 중복입니다");
  if (
    baseDifficultyByKey.size !== effectiveKeySet.size ||
    effectiveKeys.some((key) => !baseDifficultyByKey.has(key)) ||
    [...baseDifficultyByKey.keys()].some((key) => !effectiveKeySet.has(key))
  ) throw new Error("base difficulty key 집합이 effective corpus와 다릅니다");
  const byNumber = officialSolutionsByNumber(entry, classified, solutions);
  return classified.flatMap(({ question, classification }) => {
    const key = questionKey(question);
    const difficulty = baseDifficultyByKey.get(key)!;
    if (difficulty !== "하" && difficulty !== "중" && difficulty !== "상") {
      throw new Error(`${key} base difficulty가 유효하지 않습니다`);
    }
    const number = numericPrintedLocator(question.number)!;
    const solution = byNumber.get(number);
    if (!solution) throw new Error(`${number}번 공식 해설이 없습니다`);
    if (classification.decision !== "accept") return [];
    if (!solution.explanation.trim()) throw new Error(`${number}번 공식 해설 본문이 비어 있습니다`);
    return [{
      ...question,
      difficulty,
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

export function buildCorpusReceipt(
  entry: CorpusManifestEntry,
  problem: PdfEvidence,
  solution: PdfEvidence,
  classified: ClassifiedQuestion[],
  imported: ImportedQuestion[]
) {
  return {
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
}

type MigrationRow = Record<string, unknown> & { id: number };
type MigrationProjection = {
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
  sequences: { questions: number; bookItems: number };
};
type OwnedMigrationProjection = Omit<MigrationProjection, "sequences">;

type MigrationOperations = {
  questionUpdates: Array<{ id: number; before: MigrationRow; after: MigrationRow }>;
  questionInserts: Array<{ after: MigrationRow }>;
  itemUpdates: Array<{ id: number; before: MigrationRow; after: MigrationRow }>;
  itemInserts: Array<{ after: MigrationRow }>;
};

type ExistingCorpusMigrationPlan = {
  version: number;
  basisDigest: string;
  identity: {
    entryId: string;
    entryRaw: unknown;
    entryRawHash: string;
    oldReceipt: { path: "receipt.json"; sha256: string; value: unknown };
    receiptCore: { sha256: string; value: unknown };
    receiptHistory: { path: string; sha256: string };
    answerAudit: {
      path: string;
      sha256: string;
      effectiveCorpusHash: string;
      effectiveSolutionCorpusHash: string;
    };
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
type ExistingCorpusMigrationIdentity = ExistingCorpusMigrationPlan["identity"];
type ExistingCorpusMigrationIdentityDraft = Omit<ExistingCorpusMigrationIdentity, "backup">;

const MIGRATION_QUESTION_MUTABLE_COLUMNS = [
  "subject_id", "source", "qtype", "difficulty", "question", "choices", "answer", "explanation",
  "book_id", "book_number", "printed_number", "src_file_id", "src_page", "has_figure",
  "figure_description", "figure_box",
] as const;
const MIGRATION_ITEM_MUTABLE_COLUMNS = [
  "book_id", "file_id", "category", "number", "answer", "content", "page", "has_figure", "figure_box",
] as const;

function migrationSpec(entryId: string): ExistingCorpusMigrationSpec | null {
  const matches = EXISTING_CORPUS_MIGRATION_ALLOWLIST.filter((candidate) => candidate.entryId === entryId);
  if (matches.length > 1) throw new Error(`${entryId} existing migration pin이 중복입니다`);
  return matches[0] ?? null;
}

function sortedNumeric(values: Iterable<number>): number[] {
  return [...values].sort((left, right) => left - right);
}

function migrationProjectionHash(value: MigrationProjection): string {
  return canonicalEvidenceHash(ownedMigrationProjection(value));
}

function ownedMigrationProjection(value: MigrationProjection): OwnedMigrationProjection {
  const { sequences: _sequences, ...owned } = value;
  return owned;
}

function ownedMigrationProjectionHash(value: OwnedMigrationProjection): string {
  return canonicalEvidenceHash(value);
}

export function stableMigrationProjectionHash(value: MigrationProjection | OwnedMigrationProjection): string {
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

function sqliteSequence(db: Database.Database, name: string): number {
  const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(name) as { seq?: number } | undefined;
  return Number(row?.seq ?? 0);
}

function readMigrationProjection(db: Database.Database, bookIds: number[]): MigrationProjection {
  if (bookIds.length === 0 || new Set(bookIds).size !== bookIds.length) {
    throw new Error("migration book ID 집합이 유효하지 않습니다");
  }
  const placeholders = bookIds.map(() => "?").join(",");
  const books = db.prepare(
    `SELECT b.*, s.name AS subject_name FROM books b JOIN subjects s ON s.id = b.subject_id ` +
    `WHERE b.id IN (${placeholders}) ORDER BY b.id`
  ).all(...bookIds) as MigrationRow[];
  const files = db.prepare(
    `SELECT * FROM book_files WHERE book_id IN (${placeholders}) ORDER BY id`
  ).all(...bookIds) as MigrationRow[];
  const questions = db.prepare(
    `SELECT * FROM questions WHERE book_id IN (${placeholders}) ORDER BY id`
  ).all(...bookIds) as MigrationRow[];
  const items = db.prepare(
    `SELECT * FROM book_items WHERE book_id IN (${placeholders}) ORDER BY id`
  ).all(...bookIds) as MigrationRow[];
  const questionIds = questions.map((row) => row.id);
  const fileIds = files.map((row) => row.id);
  const questionPlaceholders = questionIds.length > 0 ? questionIds.map(() => "?").join(",") : "NULL";
  const filePlaceholders = fileIds.length > 0 ? fileIds.map(() => "?").join(",") : "NULL";
  const count = (sql: string, values: unknown[]): number => Number(
    (db.prepare(sql).get(...values) as { count: number }).count
  );
  const materials = count(
    `SELECT COUNT(*) AS count FROM materials WHERE book_id IN (${placeholders})`,
    bookIds
  );
  return {
    books,
    files,
    questions,
    items,
    guards: {
      attempts: count(
        `SELECT COUNT(*) AS count FROM question_attempts WHERE question_id IN (${questionPlaceholders})`,
        questionIds
      ),
      materials,
      bookExtractionChunks: count(
        `SELECT COUNT(*) AS count FROM book_extraction_chunks WHERE file_id IN (${filePlaceholders})`,
        fileIds
      ),
      materialExtractionChunks: materials === 0 ? 0 : count(
        `SELECT COUNT(*) AS count FROM material_extraction_chunks ` +
        `WHERE material_id IN (SELECT id FROM materials WHERE book_id IN (${placeholders}))`,
        bookIds
      ),
    },
    sequences: {
      questions: sqliteSequence(db, "questions"),
      bookItems: sqliteSequence(db, "book_items"),
    },
  };
}

function ownedMigrationBookIds(
  db: Database.Database,
  entry: CorpusManifestEntry,
  imported: ImportedQuestion[]
): number[] {
  const expectedSubjects = new Set(imported.map((question) => question.targetSubject));
  const foundSubjects = new Set<TargetSubject>();
  const ids: number[] = [];
  for (const subject of TARGET_SUBJECTS) {
    const subjectRows = db.prepare("SELECT id FROM subjects WHERE name = ? ORDER BY id").all(subject) as Array<{
      id: number;
    }>;
    if (subjectRows.length !== 1) throw new Error(`migration 대상 과목이 유일하지 않습니다: ${subject}`);
    const id = findBook(db, subjectRows[0].id, examBookTitle(entry), evidenceKeys(entry, subject));
    if (id !== null) {
      foundSubjects.add(subject);
      ids.push(id);
    }
  }
  if (
    foundSubjects.size !== expectedSubjects.size ||
    [...foundSubjects].some((subject) => !expectedSubjects.has(subject))
  ) {
    throw new Error("migration target book 추가/제거를 허용하지 않습니다");
  }
  return sortedNumeric(ids);
}

function migrationQuestionKey(row: MigrationRow): string {
  const page = Number(row.src_page);
  const number = Number(row.printed_number);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(number) || number < 1) {
    throw new Error(`migration 기존 question ${row.id}의 source locator가 유효하지 않습니다`);
  }
  return `${page}:${number}`;
}

function parsedMigrationChoices(value: unknown, label: string): string[] | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${label} choices가 문자열 JSON이 아닙니다`);
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((choice) => typeof choice === "string")) {
    throw new Error(`${label} choices가 문자열 배열이 아닙니다`);
  }
  return parsed;
}

export function assertMigrationAnswerEquivalent(before: MigrationRow, after: ImportedQuestion): void {
  if (before.qtype !== after.qtype || typeof before.answer !== "string") {
    throw new Error(`${migrationQuestionKey(before)} migration qtype/answer가 바뀌었습니다`);
  }
  const beforeChoices = parsedMigrationChoices(before.choices, `${migrationQuestionKey(before)} old`);
  if (after.qtype === "mcq") {
    if (!beforeChoices || !after.choices) throw new Error(`${migrationQuestionKey(before)} 객관식 보기가 없습니다`);
    const oldQuestion = { ...after, choices: beforeChoices };
    const oldResolution = resolveOfficialAnswer(oldQuestion, before.answer);
    const newResolution = resolveOfficialAnswer(after, after.officialAnswer);
    const oldMatches = beforeChoices.filter((choice) =>
      resolveOfficialAnswer(oldQuestion, choice).choiceIndex === oldResolution.choiceIndex
    );
    const newMatches = after.choices.filter((choice) =>
      resolveOfficialAnswer(after, choice).choiceIndex === newResolution.choiceIndex
    );
    if (
      oldResolution.choiceIndex === null || newResolution.choiceIndex === null ||
      oldResolution.choiceIndex !== newResolution.choiceIndex || oldMatches.length !== 1 || newMatches.length !== 1
    ) throw new Error(`${migrationQuestionKey(before)} 객관식 정답 의미가 바뀌었습니다`);
    if (
      normalizedChoiceContent(beforeChoices[oldResolution.choiceIndex]) !==
      normalizedChoiceContent(after.choices[newResolution.choiceIndex])
    ) throw new Error(`${migrationQuestionKey(before)} 객관식 정답 보기 내용이 바뀌었습니다`);
    return;
  }
  if (normalizedAnswerText(before.answer) !== normalizedAnswerText(after.officialAnswer)) {
    throw new Error(`${migrationQuestionKey(before)} 주관식/OX 정답 의미가 바뀌었습니다`);
  }
}

type MigrationBookBinding = {
  book: MigrationRow;
  problemFile: MigrationRow;
  solutionFile: MigrationRow;
};

function migrationBindings(
  entry: CorpusManifestEntry,
  projection: MigrationProjection,
  imported: ImportedQuestion[],
  problem: PdfEvidence,
  solution: PdfEvidence
): Map<TargetSubject, MigrationBookBinding> {
  const result = new Map<TargetSubject, MigrationBookBinding>();
  const targetSubjects = [...new Set(imported.map((question) => question.targetSubject))].sort();
  for (const subject of targetSubjects) {
    const books = projection.books.filter((book) => book.subject_name === subject);
    if (books.length !== 1 || books[0].title !== examBookTitle(entry)) {
      throw new Error(`migration 대상 책이 유일하지 않습니다: ${subject}`);
    }
    const keys = evidenceKeys(entry, subject);
    const files = projection.files.filter((file) => file.book_id === books[0].id);
    const problemFiles = files.filter((file) => file.r2_key === keys.problem);
    const solutionFiles = files.filter((file) => file.r2_key === keys.solution);
    if (
      files.length !== 2 || problemFiles.length !== 1 || solutionFiles.length !== 1 ||
      problemFiles[0].status !== "ready" || solutionFiles[0].status !== "ready" ||
      problemFiles[0].content_hash !== problem.sha256 || solutionFiles[0].content_hash !== solution.sha256 ||
      problemFiles[0].page_count !== problem.pageCount || solutionFiles[0].page_count !== solution.pageCount
    ) {
      throw new Error(`migration 대상 책의 원본 파일 2개가 유일하지 않습니다: ${subject}`);
    }
    result.set(subject, { book: books[0], problemFile: problemFiles[0], solutionFile: solutionFiles[0] });
  }
  if (result.size !== projection.books.length) throw new Error("migration target book 추가/제거를 허용하지 않습니다");
  return result;
}

function questionMigrationFields(question: ImportedQuestion, binding: MigrationBookBinding): Record<string, unknown> {
  return {
    subject_id: binding.book.subject_id,
    source: "uploaded",
    qtype: question.qtype,
    difficulty: question.difficulty,
    question: question.question,
    choices: question.choices ? JSON.stringify(question.choices) : null,
    answer: question.officialAnswer,
    explanation: question.officialExplanation,
    book_id: binding.book.id,
    book_number: question.printedNumber,
    printed_number: question.printedNumber,
    src_file_id: binding.problemFile.id,
    src_page: question.page,
    has_figure: question.figure ? 1 : 0,
    figure_description: question.figure_description,
    figure_box: question.box ? question.box.join(",") : null,
  };
}

function itemMigrationFields(
  question: ImportedQuestion,
  binding: MigrationBookBinding,
  category: "문제" | "해설"
): Record<string, unknown> {
  return category === "문제" ? {
    book_id: binding.book.id,
    file_id: binding.problemFile.id,
    category,
    number: question.printedNumber,
    answer: question.officialAnswer,
    content: question.question,
    page: question.page,
    has_figure: question.figure ? 1 : 0,
    figure_box: question.box ? question.box.join(",") : null,
  } : {
    book_id: binding.book.id,
    file_id: binding.solutionFile.id,
    category,
    number: question.printedNumber,
    answer: question.officialAnswer,
    content: question.officialExplanation,
    page: question.solutionPage,
    has_figure: 0,
    figure_box: null,
  };
}

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

function assertMigrationRowColumns(
  row: MigrationRow,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(row).sort();
  const wanted = [...expected].sort();
  if (canonicalEvidenceHash(actual) !== canonicalEvidenceHash(wanted)) {
    throw new Error(`${label} DB column 집합이 migration v1과 다릅니다`);
  }
}

function migrationImportedKey(question: ImportedQuestion): string {
  const number = numericPrintedLocator(question.number);
  const printed = numericPrintedLocator(question.printedNumber);
  if (
    !Number.isInteger(question.page) || question.page! < 1 || number === null || printed === null || number !== printed
  ) throw new Error("migration current question locator가 유효하지 않습니다");
  return `${question.page}:${printed}`;
}

function assertMigrationQuestionDefaults(row: MigrationRow): void {
  assertMigrationRowColumns(row, MIGRATION_QUESTION_COLUMNS, `question ${row.id}`);
  if (
    row.source !== "uploaded" || row.correct_count !== 0 || row.wrong_count !== 0 || row.from_wrong_note !== 0 ||
    row.mock_exam_job_id !== null || row.mock_exam_title !== null || row.exam_order !== null ||
    row.exam_points !== null || row.exam_section !== null || row.passage_group !== null || row.passage !== null ||
    typeof row.created_at !== "string" || !row.created_at
  ) throw new Error(`migration question ${row.id}에 사용자 학습/시험 상태가 있습니다`);
}

function assertMigrationItemDefaults(row: MigrationRow): void {
  assertMigrationRowColumns(row, MIGRATION_ITEM_COLUMNS, `book_item ${row.id}`);
  if (typeof row.created_at !== "string" || !row.created_at) {
    throw new Error(`migration book_item ${row.id} created_at이 유효하지 않습니다`);
  }
}

function assertMigrationProjectionAuthority(
  entry: CorpusManifestEntry,
  problem: PdfEvidence,
  solution: PdfEvidence,
  projection: MigrationProjection,
  imported: ImportedQuestion[],
  spec: ExistingCorpusMigrationSpec | null
): Map<TargetSubject, MigrationBookBinding> {
  if (
    projection.guards.attempts !== 0 || projection.guards.materials !== 0 ||
    projection.guards.bookExtractionChunks !== 0 || projection.guards.materialExtractionChunks !== 0
  ) throw new Error("migration 대상에 학습 이력 또는 extraction child가 있습니다");
  if (
    new Set(projection.books.map((row) => row.id)).size !== projection.books.length ||
    new Set(projection.files.map((row) => row.id)).size !== projection.files.length ||
    new Set(projection.questions.map((row) => row.id)).size !== projection.questions.length ||
    new Set(projection.items.map((row) => row.id)).size !== projection.items.length
  ) throw new Error("migration DB projection ID가 중복입니다");
  for (const row of projection.questions) assertMigrationQuestionDefaults(row);
  for (const row of projection.items) assertMigrationItemDefaults(row);
  if (projection.items.length !== projection.questions.length * 2) {
    throw new Error("migration question마다 book_item이 정확히 2개여야 합니다");
  }
  const bindings = migrationBindings(entry, projection, imported, problem, solution);
  if (spec) {
    const equalIds = (actual: number[], expected: number[]) =>
      canonicalEvidenceHash(sortedNumeric(actual)) === canonicalEvidenceHash(sortedNumeric(expected));
    if (
      entryToken(entry) !== spec.entryToken || problem.sha256 !== spec.problemHash || solution.sha256 !== spec.solutionHash ||
      !equalIds(projection.books.map((row) => row.id), spec.bookIds) ||
      !equalIds(projection.files.map((row) => row.id), spec.fileIds) ||
      !equalIds(projection.questions.map((row) => row.id), spec.questionIds) ||
      !equalIds(projection.items.map((row) => row.id), spec.bookItemIds) ||
      migrationProjectionHash(projection) !== spec.beforeProjectionHash
    ) throw new Error(`${entry.id} migration 승인 DB projection이 다릅니다`);
  }
  return bindings;
}

function migrationItemsForQuestion(
  projection: MigrationProjection,
  question: MigrationRow,
  binding: MigrationBookBinding
): { problem: MigrationRow; solution: MigrationRow } {
  const rows = projection.items.filter((row) =>
    row.book_id === question.book_id && row.number === question.printed_number
  );
  const problems = rows.filter((row) => row.category === "문제");
  const solutions = rows.filter((row) => row.category === "해설");
  if (
    rows.length !== 2 || problems.length !== 1 || solutions.length !== 1 ||
    question.book_id !== binding.book.id || question.subject_id !== binding.book.subject_id ||
    question.src_file_id !== binding.problemFile.id || question.book_number !== question.printed_number ||
    problems[0].file_id !== binding.problemFile.id || solutions[0].file_id !== binding.solutionFile.id ||
    problems[0].answer !== question.answer || solutions[0].answer !== question.answer ||
    problems[0].content !== question.question || solutions[0].content !== question.explanation ||
    problems[0].page !== question.src_page || problems[0].has_figure !== question.has_figure ||
    problems[0].figure_box !== question.figure_box || solutions[0].has_figure !== 0 ||
    solutions[0].figure_box !== null
  ) throw new Error(`${migrationQuestionKey(question)} 기존 question/book_item authority가 다릅니다`);
  return { problem: problems[0], solution: solutions[0] };
}

function newMigrationQuestionRow(
  id: number,
  question: ImportedQuestion,
  binding: MigrationBookBinding
): MigrationRow {
  return {
    id,
    ...questionMigrationFields(question, binding),
    correct_count: 0,
    wrong_count: 0,
    created_at: binding.book.created_at,
    from_wrong_note: 0,
    mock_exam_job_id: null,
    mock_exam_title: null,
    exam_order: null,
    exam_points: null,
    exam_section: null,
    passage_group: null,
    passage: null,
  };
}

function newMigrationItemRow(
  id: number,
  question: ImportedQuestion,
  binding: MigrationBookBinding,
  category: "문제" | "해설"
): MigrationRow {
  return { id, ...itemMigrationFields(question, binding, category), created_at: binding.book.created_at };
}

function buildMigrationOperations(
  entry: CorpusManifestEntry,
  problem: PdfEvidence,
  solution: PdfEvidence,
  before: MigrationProjection,
  imported: ImportedQuestion[],
  spec: ExistingCorpusMigrationSpec | null
): { operations: MigrationOperations; after: MigrationProjection } {
  const bindings = assertMigrationProjectionAuthority(entry, problem, solution, before, imported, spec);
  const currentByKey = new Map<string, ImportedQuestion>();
  for (const question of imported) {
    const key = migrationImportedKey(question);
    if (currentByKey.has(key)) throw new Error(`migration current question key가 중복입니다: ${key}`);
    currentByKey.set(key, question);
  }
  const beforeByKey = new Map<string, MigrationRow>();
  for (const row of before.questions) {
    const key = migrationQuestionKey(row);
    if (beforeByKey.has(key)) throw new Error(`migration old question key가 중복입니다: ${key}`);
    beforeByKey.set(key, row);
  }
  if ([...beforeByKey.keys()].some((key) => !currentByKey.has(key))) {
    throw new Error("migration accepted key 축소를 허용하지 않습니다");
  }
  const newKeys = [...currentByKey.keys()].filter((key) => !beforeByKey.has(key)).sort(compareCorpusQuestionKeys);
  if (spec && canonicalEvidenceHash(newKeys) !== canonicalEvidenceHash([...spec.newKeys].sort(compareCorpusQuestionKeys))) {
    throw new Error(`${entry.id} migration 승인 new key가 다릅니다`);
  }
  const operations: MigrationOperations = {
    questionUpdates: [], questionInserts: [], itemUpdates: [], itemInserts: [],
  };
  const afterQuestions: MigrationRow[] = [];
  const afterItems: MigrationRow[] = [];
  for (const [key, beforeQuestion] of [...beforeByKey].sort(([left], [right]) => compareCorpusQuestionKeys(left, right))) {
    const question = currentByKey.get(key)!;
    const binding = bindings.get(question.targetSubject)!;
    assertMigrationAnswerEquivalent(beforeQuestion, question);
    const items = migrationItemsForQuestion(before, beforeQuestion, binding);
    const afterQuestion = { ...beforeQuestion, ...questionMigrationFields(question, binding) };
    const afterProblem = { ...items.problem, ...itemMigrationFields(question, binding, "문제") };
    const afterSolution = { ...items.solution, ...itemMigrationFields(question, binding, "해설") };
    assertMigrationQuestionDefaults(afterQuestion);
    assertMigrationItemDefaults(afterProblem);
    assertMigrationItemDefaults(afterSolution);
    operations.questionUpdates.push({ id: beforeQuestion.id, before: beforeQuestion, after: afterQuestion });
    operations.itemUpdates.push(
      { id: items.problem.id, before: items.problem, after: afterProblem },
      { id: items.solution.id, before: items.solution, after: afterSolution },
    );
    afterQuestions.push(afterQuestion);
    afterItems.push(afterProblem, afterSolution);
  }
  let nextQuestionId = Math.max(before.sequences.questions, ...before.questions.map((row) => row.id), 0) + 1;
  let nextItemId = Math.max(before.sequences.bookItems, ...before.items.map((row) => row.id), 0) + 1;
  for (const key of newKeys) {
    const question = currentByKey.get(key)!;
    const binding = bindings.get(question.targetSubject)!;
    const questionRow = newMigrationQuestionRow(nextQuestionId++, question, binding);
    const problemRow = newMigrationItemRow(nextItemId++, question, binding, "문제");
    const solutionRow = newMigrationItemRow(nextItemId++, question, binding, "해설");
    assertMigrationQuestionDefaults(questionRow);
    assertMigrationItemDefaults(problemRow);
    assertMigrationItemDefaults(solutionRow);
    operations.questionInserts.push({ after: questionRow });
    operations.itemInserts.push({ after: problemRow }, { after: solutionRow });
    afterQuestions.push(questionRow);
    afterItems.push(problemRow, solutionRow);
  }
  if (spec) {
    const pinnedByKey = new Map(spec.newQuestions.map((question) => [question.key, question]));
    if (
      pinnedByKey.size !== spec.newQuestions.length ||
      canonicalEvidenceHash([...pinnedByKey.keys()].sort(compareCorpusQuestionKeys)) !==
        canonicalEvidenceHash([...spec.newKeys].sort(compareCorpusQuestionKeys))
    ) throw new Error(`${entry.id} migration 승인 신규 문항 pin이 다릅니다`);
    for (const key of newKeys) {
      const question = currentByKey.get(key)!;
      const pinned = pinnedByKey.get(key);
      if (
        !pinned || question.targetSubject !== pinned.targetSubject || question.qtype !== pinned.qtype ||
        question.difficulty !== pinned.difficulty || question.question !== pinned.question ||
        question.officialAnswer !== pinned.answer || question.solutionPage !== pinned.solutionPage
      ) throw new Error(`${entry.id} migration 승인 신규 문항이 다릅니다`);
    }
  }
  const after: MigrationProjection = {
    books: before.books,
    files: before.files,
    questions: afterQuestions.sort((left, right) => left.id - right.id),
    items: afterItems.sort((left, right) => left.id - right.id),
    guards: before.guards,
    sequences: {
      questions: Math.max(before.sequences.questions, ...afterQuestions.map((row) => row.id)),
      bookItems: Math.max(before.sequences.bookItems, ...afterItems.map((row) => row.id)),
    },
  };
  return { operations, after };
}

function assertMigrationReceipt(
  value: unknown,
  entry: CorpusManifestEntry,
  problem: PdfEvidence,
  solution: PdfEvidence,
  label: string
): Record<string, unknown> {
  const receipt = object(value, label);
  if (
    receipt.version !== 2 || receipt.status !== "committed" || receipt.entryId !== entry.id ||
    receipt.examTitle !== entry.examTitle || receipt.rawTitle !== entry.rawTitle ||
    receipt.bookTitle !== examBookTitle(entry) || receipt.problemHash !== problem.sha256 ||
    receipt.solutionHash !== solution.sha256 || receipt.rulesDigest !== CLASSIFIER_DIGEST ||
    !Number.isInteger(receipt.sourceQuestionCount) || !Number.isInteger(receipt.acceptedQuestionCount) ||
    !Number.isInteger(receipt.rejectedQuestionCount) || receipt.reviewQuestionCount !== 0 ||
    Number(receipt.acceptedQuestionCount) + Number(receipt.rejectedQuestionCount) !== Number(receipt.sourceQuestionCount) ||
    !Array.isArray(receipt.targetBooks)
  ) throw new Error(`${label} metadata가 current entry와 다릅니다`);
  return receipt;
}

function buildExistingCorpusMigrationIdentity(
  db: Database.Database,
  entry: CorpusManifestEntry,
  problem: PdfEvidence,
  solution: PdfEvidence,
  imported: ImportedQuestion[],
  oldReceipt: unknown,
  expectedOldReceiptSha256: string,
  receiptCore: unknown,
  receiptHistory: { path: string; sha256: string },
  answerAudit: AnswerAuditResult
): ExistingCorpusMigrationIdentityDraft {
  const spec = migrationSpec(entry.id);
  if (!spec) throw new Error(`${entry.id} existing migration allowlist가 없습니다`);
  assertMigrationReceipt(oldReceipt, entry, problem, solution, "old receipt");
  assertMigrationReceipt(receiptCore, entry, problem, solution, "receipt core");
  const oldReceiptSha256 = canonicalEvidenceHash(oldReceipt);
  const receiptCoreSha256 = canonicalEvidenceHash(receiptCore);
  if (oldReceiptSha256 !== expectedOldReceiptSha256) throw new Error("migration expected old receipt hash가 다릅니다");
  if (
    !answerAudit.auditPath || !answerAudit.auditHash || !answerAudit.effectiveCorpusHash ||
    !answerAudit.effectiveSolutionCorpusHash
  ) throw new Error("migration current terminal audit이 없습니다");
  if (spec && (
    expectedOldReceiptSha256 !== spec.oldReceiptSha256 || receiptCoreSha256 !== spec.receiptCoreSha256 ||
    answerAudit.auditPath !== spec.auditPath || answerAudit.auditHash !== spec.auditSha256 ||
    answerAudit.effectiveCorpusHash !== spec.effectiveCorpusHash ||
    answerAudit.effectiveSolutionCorpusHash !== spec.effectiveSolutionCorpusHash
  )) throw new Error(`${entry.id} migration 승인 receipt/audit가 다릅니다`);

  const bookIds = ownedMigrationBookIds(db, entry, imported);
  const before = readMigrationProjection(db, bookIds);
  const { operations, after } = buildMigrationOperations(entry, problem, solution, before, imported, spec);
  const beforeProjectionHash = migrationProjectionHash(before);
  const afterProjectionHash = migrationProjectionHash(after);
  if (beforeProjectionHash === afterProjectionHash) {
    throw new Error("migration DB projection 변경이 없습니다");
  }
  if (afterProjectionHash !== spec.afterProjectionHash) {
    throw new Error(
      `${entry.id} migration 승인 NEW DB projection이 다릅니다: ${afterProjectionHash}`
    );
  }
  return {
    entryId: entry.id,
    entryRaw: entry.raw,
    entryRawHash: canonicalEvidenceHash(entry.raw),
    oldReceipt: { path: "receipt.json", sha256: oldReceiptSha256, value: oldReceipt },
    receiptCore: { sha256: receiptCoreSha256, value: receiptCore },
    receiptHistory,
    answerAudit: {
      path: answerAudit.auditPath,
      sha256: answerAudit.auditHash,
      effectiveCorpusHash: answerAudit.effectiveCorpusHash,
      effectiveSolutionCorpusHash: answerAudit.effectiveSolutionCorpusHash,
    },
    problemHash: problem.sha256,
    solutionHash: solution.sha256,
    ownership: {
      bookIds,
      fileIds: sortedNumeric(before.files.map((row) => row.id)),
      beforeQuestionIds: sortedNumeric(before.questions.map((row) => row.id)),
      afterQuestionIds: sortedNumeric(after.questions.map((row) => row.id)),
      beforeBookItemIds: sortedNumeric(before.items.map((row) => row.id)),
      afterBookItemIds: sortedNumeric(after.items.map((row) => row.id)),
    },
    beforeProjectionHash,
    afterProjectionHash,
    stableAfterProjectionHash: stableMigrationProjectionHash(after),
    beforeSequences: before.sequences,
    afterSequences: after.sequences,
    beforeProjection: ownedMigrationProjection(before),
    afterProjection: ownedMigrationProjection(after),
    operations,
  };
}

function buildMigratedCorpusReceipt(
  receiptCore: unknown,
  identity: ExistingCorpusMigrationIdentity,
  basisDigest: string
): Record<string, unknown> {
  const core = object(receiptCore, "migration receipt core");
  if ("migration" in core || identity.receiptCore.sha256 !== canonicalEvidenceHash(core)) {
    throw new Error("migration receipt core가 유효하지 않습니다");
  }
  return {
    ...core,
    migration: {
      version: EXISTING_CORPUS_MIGRATION_VERSION,
      previousReceipt: identity.receiptHistory,
      plan: { path: `migration-plans/v1-${basisDigest}.json`, basisDigest },
      oldProjectionHash: identity.beforeProjectionHash,
      newProjectionHash: identity.afterProjectionHash,
      receiptCoreSha256: identity.receiptCore.sha256,
    },
  };
}

function assertMigrationOperationColumns(
  before: MigrationRow,
  after: MigrationRow,
  mutable: readonly string[],
  label: string
): void {
  const allowed = new Set(mutable);
  for (const key of Object.keys(before)) {
    if (!allowed.has(key) && canonicalEvidenceHash(before[key]) !== canonicalEvidenceHash(after[key])) {
      throw new Error(`${label} immutable column이 바뀌었습니다: ${key}`);
    }
  }
}

function assertMigrationKeys(value: unknown, expected: readonly string[], label: string): void {
  const actual = Object.keys(object(value, label)).sort();
  if (canonicalEvidenceHash(actual) !== canonicalEvidenceHash([...expected].sort())) {
    throw new Error(`${label} key 집합이 다릅니다`);
  }
}

function applyOperationsToOwnedProjection(
  before: OwnedMigrationProjection,
  operations: MigrationOperations
): OwnedMigrationProjection {
  const questions = new Map(before.questions.map((row) => [row.id, row]));
  const items = new Map(before.items.map((row) => [row.id, row]));
  for (const operation of operations.questionUpdates) {
    const current = questions.get(operation.id);
    if (!current || canonicalEvidenceHash(current) !== canonicalEvidenceHash(operation.before) ||
        operation.after.id !== operation.id) {
      throw new Error(`migration question update ${operation.id} parent가 다릅니다`);
    }
    assertMigrationOperationColumns(operation.before, operation.after, MIGRATION_QUESTION_MUTABLE_COLUMNS,
      `migration question update ${operation.id}`);
    questions.set(operation.id, operation.after);
  }
  for (const operation of operations.questionInserts) {
    if (questions.has(operation.after.id)) throw new Error(`migration question insert ID가 중복입니다: ${operation.after.id}`);
    assertMigrationQuestionDefaults(operation.after);
    questions.set(operation.after.id, operation.after);
  }
  for (const operation of operations.itemUpdates) {
    const current = items.get(operation.id);
    if (!current || canonicalEvidenceHash(current) !== canonicalEvidenceHash(operation.before) ||
        operation.after.id !== operation.id) {
      throw new Error(`migration book_item update ${operation.id} parent가 다릅니다`);
    }
    assertMigrationOperationColumns(operation.before, operation.after, MIGRATION_ITEM_MUTABLE_COLUMNS,
      `migration book_item update ${operation.id}`);
    items.set(operation.id, operation.after);
  }
  for (const operation of operations.itemInserts) {
    if (items.has(operation.after.id)) throw new Error(`migration book_item insert ID가 중복입니다: ${operation.after.id}`);
    assertMigrationItemDefaults(operation.after);
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

function assertExistingCorpusMigrationPlan(value: unknown): ExistingCorpusMigrationPlan {
  const plan = object(value, "migration plan") as ExistingCorpusMigrationPlan;
  const identity = plan.identity;
  assertMigrationKeys(plan, ["version", "basisDigest", "identity", "finalReceipt", "backup"], "migration plan");
  assertMigrationKeys(identity, [
    "entryId", "entryRaw", "entryRawHash", "oldReceipt", "receiptCore", "receiptHistory", "answerAudit",
    "problemHash", "solutionHash", "ownership", "beforeProjectionHash", "afterProjectionHash",
    "stableAfterProjectionHash", "beforeSequences", "afterSequences", "beforeProjection", "afterProjection",
    "operations", "backup",
  ], "migration identity");
  assertMigrationKeys(identity.oldReceipt, ["path", "sha256", "value"], "migration old receipt pointer");
  assertMigrationKeys(identity.receiptCore, ["sha256", "value"], "migration receipt core pointer");
  assertMigrationKeys(identity.receiptHistory, ["path", "sha256"], "migration history pointer");
  assertMigrationKeys(identity.answerAudit,
    ["path", "sha256", "effectiveCorpusHash", "effectiveSolutionCorpusHash"], "migration audit pointer");
  assertMigrationKeys(identity.ownership, [
    "bookIds", "fileIds", "beforeQuestionIds", "afterQuestionIds", "beforeBookItemIds", "afterBookItemIds",
  ], "migration ownership");
  assertMigrationKeys(identity.beforeSequences, ["questions", "bookItems"], "migration before sequences");
  assertMigrationKeys(identity.afterSequences, ["questions", "bookItems"], "migration after sequences");
  assertMigrationKeys(identity.operations,
    ["questionUpdates", "questionInserts", "itemUpdates", "itemInserts"], "migration operations");
  assertMigrationKeys(identity.beforeProjection,
    ["books", "files", "questions", "items", "guards"], "migration before projection");
  assertMigrationKeys(identity.afterProjection,
    ["books", "files", "questions", "items", "guards"], "migration after projection");
  assertMigrationKeys(identity.beforeProjection.guards,
    ["attempts", "materials", "bookExtractionChunks", "materialExtractionChunks"], "migration before guards");
  assertMigrationKeys(identity.afterProjection.guards,
    ["attempts", "materials", "bookExtractionChunks", "materialExtractionChunks"], "migration after guards");
  for (const operation of [...identity.operations.questionUpdates, ...identity.operations.itemUpdates]) {
    assertMigrationKeys(operation, ["id", "before", "after"], "migration update operation");
  }
  for (const operation of [...identity.operations.questionInserts, ...identity.operations.itemInserts]) {
    assertMigrationKeys(operation, ["after"], "migration insert operation");
  }
  assertMigrationKeys(identity.backup, ["sha256", "bytes"], "migration identity backup");
  assertMigrationKeys(plan.finalReceipt, ["path", "sha256", "value"], "migration final receipt");
  assertMigrationKeys(plan.backup, ["path", "sha256", "bytes"], "migration backup pointer");
  const finalReceiptValue = object(plan.finalReceipt.value, "migration final receipt value");
  const migration = object(finalReceiptValue.migration, "migration receipt envelope");
  assertMigrationKeys(migration, [
    "version", "previousReceipt", "plan", "oldProjectionHash", "newProjectionHash", "receiptCoreSha256",
  ], "migration receipt envelope");
  assertMigrationKeys(migration.previousReceipt, ["path", "sha256"], "migration receipt previous pointer");
  assertMigrationKeys(migration.plan, ["path", "basisDigest"], "migration receipt plan pointer");
  if (
    plan.version !== EXISTING_CORPUS_MIGRATION_VERSION || !identity || !plan.finalReceipt || !plan.backup ||
    !/^[a-f0-9]{64}$/u.test(plan.basisDigest) || canonicalEvidenceHash(identity) !== plan.basisDigest ||
    identity.entryId !== object(identity.oldReceipt.value, "migration old receipt").entryId ||
    identity.entryId !== object(identity.receiptCore.value, "migration receipt core").entryId ||
    identity.entryRawHash !== canonicalEvidenceHash(identity.entryRaw) ||
    identity.oldReceipt.path !== "receipt.json" ||
    identity.oldReceipt.sha256 !== canonicalEvidenceHash(identity.oldReceipt.value) ||
    identity.receiptCore.sha256 !== canonicalEvidenceHash(identity.receiptCore.value) ||
    identity.receiptHistory.path !== `receipt-history/v1-${identity.oldReceipt.sha256}.json` ||
    !/^[a-f0-9]{64}$/u.test(identity.receiptHistory.sha256) ||
    identity.beforeProjectionHash !== ownedMigrationProjectionHash(identity.beforeProjection) ||
    identity.afterProjectionHash !== ownedMigrationProjectionHash(identity.afterProjection) ||
    identity.stableAfterProjectionHash !== stableMigrationProjectionHash(identity.afterProjection) ||
    !Number.isSafeInteger(identity.beforeSequences.questions) || !Number.isSafeInteger(identity.beforeSequences.bookItems) ||
    !Number.isSafeInteger(identity.afterSequences.questions) || !Number.isSafeInteger(identity.afterSequences.bookItems) ||
    identity.afterSequences.questions < identity.beforeSequences.questions ||
    identity.afterSequences.bookItems < identity.beforeSequences.bookItems ||
    identity.backup.sha256 !== plan.backup.sha256 || identity.backup.bytes !== plan.backup.bytes ||
    plan.finalReceipt.path !== "receipt.json" ||
    plan.finalReceipt.sha256 !== canonicalEvidenceHash(plan.finalReceipt.value) ||
    canonicalEvidenceHash(plan.finalReceipt.value) !==
      canonicalEvidenceHash(buildMigratedCorpusReceipt(identity.receiptCore.value, identity, plan.basisDigest))
  ) throw new Error("migration plan basis가 유효하지 않습니다");
  const reconstructed = applyOperationsToOwnedProjection(identity.beforeProjection, identity.operations);
  if (
    ownedMigrationProjectionHash(reconstructed) !== identity.afterProjectionHash ||
    canonicalEvidenceHash(reconstructed) !== canonicalEvidenceHash(identity.afterProjection) ||
    canonicalEvidenceHash(identity.beforeProjection.books) !== canonicalEvidenceHash(identity.afterProjection.books) ||
    canonicalEvidenceHash(identity.beforeProjection.files) !== canonicalEvidenceHash(identity.afterProjection.files) ||
    canonicalEvidenceHash(identity.beforeProjection.guards) !== canonicalEvidenceHash(identity.afterProjection.guards) ||
    canonicalEvidenceHash(sortedNumeric(identity.operations.questionUpdates.map((row) => row.id))) !==
      canonicalEvidenceHash(sortedNumeric(identity.beforeProjection.questions.map((row) => row.id))) ||
    canonicalEvidenceHash(sortedNumeric(identity.operations.itemUpdates.map((row) => row.id))) !==
      canonicalEvidenceHash(sortedNumeric(identity.beforeProjection.items.map((row) => row.id))) ||
    canonicalEvidenceHash(sortedNumeric(identity.operations.questionInserts.map((row) => row.after.id))) !==
      canonicalEvidenceHash(sortedNumeric(identity.ownership.afterQuestionIds.filter((id) =>
        !identity.ownership.beforeQuestionIds.includes(id)
      ))) ||
    canonicalEvidenceHash(sortedNumeric(identity.operations.itemInserts.map((row) => row.after.id))) !==
      canonicalEvidenceHash(sortedNumeric(identity.ownership.afterBookItemIds.filter((id) =>
        !identity.ownership.beforeBookItemIds.includes(id)
      ))) ||
    canonicalEvidenceHash(sortedNumeric(identity.beforeProjection.questions.map((row) => row.id))) !==
      canonicalEvidenceHash(identity.ownership.beforeQuestionIds) ||
    canonicalEvidenceHash(sortedNumeric(identity.afterProjection.questions.map((row) => row.id))) !==
      canonicalEvidenceHash(identity.ownership.afterQuestionIds) ||
    canonicalEvidenceHash(sortedNumeric(identity.beforeProjection.items.map((row) => row.id))) !==
      canonicalEvidenceHash(identity.ownership.beforeBookItemIds) ||
    canonicalEvidenceHash(sortedNumeric(identity.afterProjection.items.map((row) => row.id))) !==
      canonicalEvidenceHash(identity.ownership.afterBookItemIds) ||
    canonicalEvidenceHash(sortedNumeric(identity.beforeProjection.books.map((row) => row.id))) !==
      canonicalEvidenceHash(identity.ownership.bookIds) ||
    canonicalEvidenceHash(sortedNumeric(identity.beforeProjection.files.map((row) => row.id))) !==
      canonicalEvidenceHash(identity.ownership.fileIds)
  ) throw new Error("migration plan projection/operation binding이 다릅니다");
  for (const row of [...identity.beforeProjection.questions, ...identity.afterProjection.questions]) {
    assertMigrationQuestionDefaults(row);
  }
  for (const row of [...identity.beforeProjection.items, ...identity.afterProjection.items]) {
    assertMigrationItemDefaults(row);
  }
  const spec = migrationSpec(identity.entryId);
  if (!spec) throw new Error(`${identity.entryId} existing migration allowlist가 없습니다`);
  const sameIds = (actual: number[], expected: number[]) =>
    canonicalEvidenceHash(sortedNumeric(actual)) === canonicalEvidenceHash(sortedNumeric(expected));
  const beforeQuestionIds = new Set(identity.beforeProjection.questions.map((row) => row.id));
  const addedQuestions = identity.afterProjection.questions.filter((row) => !beforeQuestionIds.has(row.id));
  const addedKeys = addedQuestions.map(migrationQuestionKey).sort(compareCorpusQuestionKeys);
  const beforeItemIds = new Set(identity.beforeProjection.items.map((item) => item.id));
  const addedItems = identity.afterProjection.items.filter((row) =>
    !beforeItemIds.has(row.id)
  );
  const pinnedNew = new Map(spec.newQuestions.map((question) => [question.key, question]));
  if (
    entryToken({ id: identity.entryId } as CorpusManifestEntry) !== spec.entryToken ||
    identity.oldReceipt.sha256 !== spec.oldReceiptSha256 ||
    identity.receiptCore.sha256 !== spec.receiptCoreSha256 ||
    identity.answerAudit.path !== spec.auditPath || identity.answerAudit.sha256 !== spec.auditSha256 ||
    identity.answerAudit.effectiveCorpusHash !== spec.effectiveCorpusHash ||
    identity.answerAudit.effectiveSolutionCorpusHash !== spec.effectiveSolutionCorpusHash ||
    identity.problemHash !== spec.problemHash || identity.solutionHash !== spec.solutionHash ||
    identity.beforeProjectionHash !== spec.beforeProjectionHash ||
    identity.afterProjectionHash !== spec.afterProjectionHash ||
    !sameIds(identity.ownership.bookIds, spec.bookIds) ||
    !sameIds(identity.ownership.fileIds, spec.fileIds) ||
    !sameIds(identity.ownership.beforeQuestionIds, spec.questionIds) ||
    !sameIds(identity.ownership.beforeBookItemIds, spec.bookItemIds) ||
    canonicalEvidenceHash(addedKeys) !== canonicalEvidenceHash([...spec.newKeys].sort(compareCorpusQuestionKeys)) ||
    pinnedNew.size !== spec.newQuestions.length
  ) throw new Error("migration plan이 exact allowlist authority와 다릅니다");
  for (const row of addedQuestions) {
    const key = migrationQuestionKey(row);
    const pinned = pinnedNew.get(key);
    const book = identity.afterProjection.books.find((candidate) => candidate.id === row.book_id);
    const solutionItems = addedItems.filter((item) =>
      item.book_id === row.book_id && item.number === row.printed_number && item.category === "해설"
    );
    if (
      !pinned || !book || solutionItems.length !== 1 || book.subject_name !== pinned.targetSubject ||
      row.qtype !== pinned.qtype || row.difficulty !== pinned.difficulty || row.question !== pinned.question ||
      row.answer !== pinned.answer || solutionItems[0].page !== pinned.solutionPage
    ) throw new Error(`${key} migration plan 신규 문항이 allowlist와 다릅니다`);
  }
  if (
    typeof plan.backup.path !== "string" ||
    plan.backup.path !== `backups/exam-corpus-migration-v1-${entryToken({ id: identity.entryId } as CorpusManifestEntry)}-${plan.basisDigest}.db` ||
    !/^[a-f0-9]{64}$/u.test(plan.backup.sha256) || !Number.isSafeInteger(plan.backup.bytes) || plan.backup.bytes < 1
  ) throw new Error("migration plan backup pointer가 유효하지 않습니다");
  return plan;
}

function migrationCasUpdate(
  db: Database.Database,
  table: "questions" | "book_items",
  mutableColumns: readonly string[],
  operation: { id: number; before: MigrationRow; after: MigrationRow }
): void {
  const columns = Object.keys(operation.before);
  const sql = `UPDATE ${table} SET ${mutableColumns.map((column) => `${column} = ?`).join(", ")} ` +
    `WHERE ${columns.map((column) => `${column} IS ?`).join(" AND ")}`;
  const result = db.prepare(sql).run(
    ...mutableColumns.map((column) => operation.after[column]),
    ...columns.map((column) => operation.before[column]),
  );
  if (result.changes !== 1) throw new Error(`${table} ${operation.id} migration CAS가 실패했습니다`);
}

function migrationInsert(db: Database.Database, table: "questions" | "book_items", row: MigrationRow): void {
  const columns = Object.keys(row);
  const existing = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(row.id);
  if (existing) throw new Error(`${table} migration insert ID가 이미 사용 중입니다: ${row.id}`);
  const result = db.prepare(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
  ).run(...columns.map((column) => row[column]));
  if (result.changes !== 1) throw new Error(`${table} ${row.id} migration insert가 실패했습니다`);
}

export function applyExistingCorpusMigrationPlan(
  db: Database.Database,
  rawPlan: unknown
): "applied" | "already-applied" {
  const plan = assertExistingCorpusMigrationPlan(rawPlan);
  const identity = plan.identity;
  const current = readMigrationProjection(db, identity.ownership.bookIds);
  const currentHash = migrationProjectionHash(current);
  if (currentHash === identity.afterProjectionHash) return "already-applied";
  if (currentHash !== identity.beforeProjectionHash) {
    throw new Error("migration DB가 OLD/NEW 어느 projection과도 일치하지 않습니다");
  }
  db.transaction(() => {
    const locked = readMigrationProjection(db, identity.ownership.bookIds);
    if (migrationProjectionHash(locked) !== identity.beforeProjectionHash) {
      throw new Error("migration DB projection이 transaction 직전에 바뀌었습니다");
    }
    if (
      sqliteSequence(db, "questions") !== identity.beforeSequences.questions ||
      sqliteSequence(db, "book_items") !== identity.beforeSequences.bookItems
    ) throw new Error("migration DB allocator sequence가 transaction 직전에 바뀌었습니다");
    for (const operation of identity.operations.questionInserts) {
      if (db.prepare("SELECT 1 FROM questions WHERE id = ?").get(operation.after.id)) {
        throw new Error(`migration question insert ID가 충돌합니다: ${operation.after.id}`);
      }
    }
    for (const operation of identity.operations.itemInserts) {
      if (db.prepare("SELECT 1 FROM book_items WHERE id = ?").get(operation.after.id)) {
        throw new Error(`migration book_item insert ID가 충돌합니다: ${operation.after.id}`);
      }
    }
    for (const operation of identity.operations.questionUpdates) {
      migrationCasUpdate(db, "questions", MIGRATION_QUESTION_MUTABLE_COLUMNS, operation);
    }
    for (const operation of identity.operations.itemUpdates) {
      migrationCasUpdate(db, "book_items", MIGRATION_ITEM_MUTABLE_COLUMNS, operation);
    }
    for (const operation of identity.operations.questionInserts) migrationInsert(db, "questions", operation.after);
    for (const operation of identity.operations.itemInserts) migrationInsert(db, "book_items", operation.after);
    if (migrationProjectionHash(readMigrationProjection(db, identity.ownership.bookIds)) !== identity.afterProjectionHash) {
      throw new Error("migration DB NEW projection 검증에 실패했습니다");
    }
    if (
      sqliteSequence(db, "questions") !== identity.afterSequences.questions ||
      sqliteSequence(db, "book_items") !== identity.afterSequences.bookItems
    ) throw new Error("migration DB NEW allocator sequence가 다릅니다");
  }).immediate();
  return "applied";
}

function readCanonicalMigrationJson(path: string, label: string): { value: unknown; sha256: string } {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new Error(`${label}이 regular file이 아닙니다`);
  }
  const bytes = readFileSync(path, "utf8");
  const value: unknown = JSON.parse(bytes);
  const canonical = canonicalJson(value);
  if (bytes !== canonical) throw new Error(`${label}이 canonical JSON이 아닙니다`);
  return { value, sha256: sha256Text(bytes) };
}

function migrationRelativeFile(root: string, relativePath: string, label: string): string {
  if (
    !relativePath || relativePath.includes("\0") || relativePath.startsWith("/") ||
    relativePath.split("/").includes("..")
  ) throw new Error(`${label} 상대 경로가 유효하지 않습니다`);
  if (!existsSync(root) || lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) {
    throw new Error(`${label} root가 regular directory가 아닙니다`);
  }
  const path = resolve(root, relativePath);
  const resolvedRoot = realpathSync(root);
  if (!path.startsWith(`${resolve(root)}/`) || !existsSync(path)) {
    throw new Error(`${label} 경로가 root 밖이거나 없습니다`);
  }
  if (!realpathSync(path).startsWith(`${resolvedRoot}/`)) throw new Error(`${label} realpath가 root 밖입니다`);
  return path;
}

function migrationStateDirectory(
  stateDir: string,
  name: "receipt-history" | "migration-plans" | "migration-commits",
  create: boolean
): string | null {
  const root = realpathSync(stateDir);
  const directory = join(stateDir, name);
  if (!existsSync(directory)) {
    if (!create) return null;
    mkdirSync(directory);
  }
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) {
    throw new Error(`${name}가 regular directory가 아닙니다`);
  }
  if (!realpathSync(directory).startsWith(`${root}/`)) throw new Error(`${name}가 stateDir 밖입니다`);
  return directory;
}

function migrationBackupDirectory(dataDir: string, create: boolean): string {
  const root = realpathSync(dataDir);
  const directory = join(dataDir, "backups");
  if (!existsSync(directory)) {
    if (!create) throw new Error("migration backups directory가 없습니다");
    mkdirSync(directory);
  }
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) {
    throw new Error("migration backups directory가 regular directory가 아닙니다");
  }
  const real = realpathSync(directory);
  if (!real.startsWith(`${root}/`)) throw new Error("migration backups directory가 dataDir 밖입니다");
  return directory;
}

function migrationBackupFile(dataDir: string, relativePath: string, createDirectory: boolean): string {
  if (!/^backups\/[^/]+\.db$/u.test(relativePath)) {
    throw new Error("migration backup 상대 경로가 유효하지 않습니다");
  }
  const directory = migrationBackupDirectory(dataDir, createDirectory);
  const path = join(directory, relativePath.slice("backups/".length));
  if (existsSync(path) && !realpathSync(path).startsWith(`${realpathSync(directory)}/`)) {
    throw new Error("migration backup file이 backups directory 밖입니다");
  }
  return path;
}

async function assertLinkedMigrationEvidence(
  filesDir: string,
  entry: CorpusManifestEntry,
  problem: PdfEvidence,
  solution: PdfEvidence,
  imported: ImportedQuestion[]
): Promise<void> {
  for (const subject of [...new Set(imported.map((question) => question.targetSubject))].sort()) {
    const keys = evidenceKeys(entry, subject);
    for (const [label, key, expectedHash] of [
      ["problem", keys.problem, problem.sha256],
      ["solution", keys.solution, solution.sha256],
    ] as const) {
      const path = migrationRelativeFile(filesDir, key, `migration linked ${label}`);
      if (
        !existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() ||
        await sha256File(path) !== expectedHash
      ) throw new Error(`migration linked ${label} evidence가 없거나 변조되었습니다: ${subject}`);
    }
  }
}

async function assertMigrationBackup(
  dataDir: string,
  plan: ExistingCorpusMigrationPlan
): Promise<void> {
  const path = migrationBackupFile(dataDir, plan.backup.path, false);
  if (
    !existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() ||
    statSync(path).size !== plan.backup.bytes || await sha256File(path) !== plan.backup.sha256
  ) throw new Error("migration backup artifact가 다릅니다");
  const backup = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const quick = backup.pragma("quick_check") as Array<{ quick_check: string }>;
    if (
      quick.length !== 1 || quick[0].quick_check !== "ok" ||
      backup.pragma("journal_mode", { simple: true }) !== "delete"
    ) throw new Error("quick_check");
    assertImportSchema(backup);
    const projection = readMigrationProjection(backup, plan.identity.ownership.bookIds);
    if (migrationProjectionHash(projection) !== plan.identity.beforeProjectionHash) {
      throw new Error("projection");
    }
  } catch {
    throw new Error("migration backup DB 검증에 실패했습니다");
  } finally {
    backup.close();
  }
}

async function prepareMigrationBackupSnapshot(
  db: Database.Database,
  dataDir: string,
  beforeProjectionHash: string,
  bookIds: number[]
): Promise<{ tempPath: string; sha256: string; bytes: number }> {
  const directory = migrationBackupDirectory(dataDir, true);
  const tempPath = join(directory, `.exam-corpus-migration-v1-${process.pid}-${randomUUID()}.tmp`);
  await db.backup(tempPath);
  const backup = new Database(tempPath, { fileMustExist: true });
  try {
    if (backup.pragma("journal_mode = DELETE", { simple: true }) !== "delete") {
      throw new Error("migration backup journal mode를 고정하지 못했습니다");
    }
    const quick = backup.pragma("quick_check") as Array<{ quick_check: string }>;
    if (
      quick.length !== 1 || quick[0].quick_check !== "ok" ||
      migrationProjectionHash(readMigrationProjection(backup, bookIds)) !== beforeProjectionHash
    ) throw new Error("migration backup snapshot이 다릅니다");
  } finally {
    backup.close();
  }
  return { tempPath, sha256: await sha256File(tempPath), bytes: statSync(tempPath).size };
}

async function publishMigrationBackup(
  prepared: { tempPath: string; sha256: string; bytes: number },
  dataDir: string,
  entryId: string,
  basisDigest: string
): Promise<ExistingCorpusMigrationPlan["backup"]> {
  const relativePath = `backups/exam-corpus-migration-v1-${sha256Text(entryId).slice(0, 24)}-${basisDigest}.db`;
  const path = migrationBackupFile(dataDir, relativePath, true);
  try {
    if (existsSync(path)) {
      if (
        lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || statSync(path).size !== prepared.bytes ||
        await sha256File(path) !== prepared.sha256
      ) throw new Error("기존 migration backup이 prepared snapshot과 다릅니다");
    } else {
      renameSync(prepared.tempPath, path);
    }
  } finally {
    if (existsSync(prepared.tempPath)) unlinkSync(prepared.tempPath);
    if (existsSync(`${prepared.tempPath}-wal`)) unlinkSync(`${prepared.tempPath}-wal`);
    if (existsSync(`${prepared.tempPath}-shm`)) unlinkSync(`${prepared.tempPath}-shm`);
  }
  return { path: relativePath, sha256: prepared.sha256, bytes: prepared.bytes };
}

function migrationPlans(stateDir: string): ExistingCorpusMigrationPlan[] {
  const directory = migrationStateDirectory(stateDir, "migration-plans", false);
  if (!directory) return [];
  const plans: ExistingCorpusMigrationPlan[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (name.endsWith(".tmp") || name.includes(".tmp.")) {
      const temp = join(directory, name);
      if (lstatSync(temp).isSymbolicLink() || !lstatSync(temp).isFile()) {
        throw new Error(`migration plan temp artifact가 regular file이 아닙니다: ${name}`);
      }
      continue;
    }
    const match = /^v1-([a-f0-9]{64})\.json$/u.exec(name);
    if (!match) throw new Error(`알 수 없는 migration plan artifact입니다: ${name}`);
    const path = join(directory, name);
    const { value, sha256 } = readCanonicalMigrationJson(path, "migration plan");
    const plan = assertExistingCorpusMigrationPlan(value);
    if (plan.basisDigest !== match[1] || sha256 !== canonicalEvidenceHash(plan)) {
      throw new Error("migration plan filename/hash가 다릅니다");
    }
    plans.push(plan);
  }
  return plans;
}

export function selectExistingMigrationPlan<T extends {
  identity: { entryId: string; oldReceipt: { sha256: string } };
}>(plans: T[], entryId: string, expectedOldReceiptSha256: string): T | null {
  if (plans.length > 1) throw new Error("migration plan이 orphan/duplicate입니다");
  if (plans.length === 0) return null;
  const [plan] = plans;
  if (
    plan.identity.entryId !== entryId ||
    plan.identity.oldReceipt.sha256 !== expectedOldReceiptSha256
  ) throw new Error("migration plan이 current entry/old receipt와 충돌합니다");
  return plan;
}

function migrationJsonArtifacts(
  stateDir: string,
  directoryName: "receipt-history" | "migration-commits",
  pattern: RegExp
): Array<{ name: string; value: unknown; sha256: string }> {
  const directory = migrationStateDirectory(stateDir, directoryName, false);
  if (!directory) return [];
  return readdirSync(directory).sort().flatMap((name) => {
    if (name.endsWith(".tmp") || name.includes(".tmp.")) {
      const temp = join(directory, name);
      if (lstatSync(temp).isSymbolicLink() || !lstatSync(temp).isFile()) {
        throw new Error(`${directoryName} temp artifact가 regular file이 아닙니다: ${name}`);
      }
      return [];
    }
    if (!pattern.test(name)) throw new Error(`알 수 없는 ${directoryName} artifact입니다: ${name}`);
    const artifact = readCanonicalMigrationJson(join(directory, name), directoryName);
    return [{ name, ...artifact }];
  });
}

function assertSingleMigrationBackup(dataDir: string, plan: ExistingCorpusMigrationPlan): void {
  const directory = migrationBackupDirectory(dataDir, false);
  const prefix = `exam-corpus-migration-v1-${sha256Text(plan.identity.entryId).slice(0, 24)}-`;
  const candidates = readdirSync(directory).filter((name) => {
    if (name.startsWith(".") && name.includes(".tmp")) return false;
    return name.startsWith(prefix);
  });
  if (canonicalEvidenceHash(candidates.sort()) !== canonicalEvidenceHash([plan.backup.path.split("/").at(-1)!])) {
    throw new Error("migration backup artifact가 없거나 orphan/duplicate입니다");
  }
}

function assertMigrationPlanInvocation(
  plan: ExistingCorpusMigrationPlan,
  entry: CorpusManifestEntry,
  problem: PdfEvidence,
  solution: PdfEvidence,
  expectedOldReceiptSha256: string,
  receiptCore: unknown,
  answerAudit: AnswerAuditResult
): void {
  const spec = migrationSpec(entry.id);
  if (!spec) throw new Error(`${entry.id} existing migration allowlist가 없습니다`);
  const identity = plan.identity;
  if (
    identity.entryId !== entry.id || identity.entryRawHash !== canonicalEvidenceHash(entry.raw) ||
    canonicalEvidenceHash(identity.entryRaw) !== canonicalEvidenceHash(entry.raw) ||
    identity.oldReceipt.sha256 !== expectedOldReceiptSha256 ||
    identity.receiptCore.sha256 !== canonicalEvidenceHash(receiptCore) ||
    canonicalEvidenceHash(identity.receiptCore.value) !== canonicalEvidenceHash(receiptCore) ||
    identity.problemHash !== problem.sha256 || identity.solutionHash !== solution.sha256 ||
    identity.answerAudit.path !== answerAudit.auditPath || identity.answerAudit.sha256 !== answerAudit.auditHash ||
    identity.answerAudit.effectiveCorpusHash !== answerAudit.effectiveCorpusHash ||
    identity.answerAudit.effectiveSolutionCorpusHash !== answerAudit.effectiveSolutionCorpusHash ||
    identity.beforeProjectionHash !== spec.beforeProjectionHash ||
    identity.afterProjectionHash !== spec.afterProjectionHash ||
    identity.oldReceipt.sha256 !== spec.oldReceiptSha256 ||
    identity.receiptCore.sha256 !== spec.receiptCoreSha256 ||
    identity.answerAudit.path !== spec.auditPath || identity.answerAudit.sha256 !== spec.auditSha256 ||
    identity.answerAudit.effectiveCorpusHash !== spec.effectiveCorpusHash ||
    identity.answerAudit.effectiveSolutionCorpusHash !== spec.effectiveSolutionCorpusHash
  ) throw new Error("migration plan이 current invocation/allowlist와 다릅니다");
}

function replaceMigrationReceipt(
  path: string,
  oldSha256: string,
  newSha256: string,
  newReceipt: unknown
): void {
  const current = readCanonicalMigrationJson(path, "migration receipt");
  if (current.sha256 === newSha256) return;
  if (current.sha256 !== oldSha256) throw new Error("migration receipt CAS가 실패했습니다");
  const next = canonicalJson(newReceipt);
  if (sha256Text(next) !== newSha256) throw new Error("migration NEW receipt hash가 다릅니다");
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, next, { encoding: "utf8", flag: "wx" });
    if (readCanonicalMigrationJson(path, "migration receipt").sha256 !== oldSha256) {
      throw new Error("migration receipt가 교체 직전에 바뀌었습니다");
    }
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

async function migrateExistingCorpusEntry(
  db: Database.Database,
  dataDir: string,
  stateDir: string,
  entry: CorpusManifestEntry,
  problem: PdfEvidence,
  solution: PdfEvidence,
  imported: ImportedQuestion[],
  receiptCore: unknown,
  answerAudit: AnswerAuditResult,
  expectedOldReceiptSha256: string
): Promise<void> {
  if (!answerAudit.auditPath || !answerAudit.auditHash) throw new Error("migration current audit pointer가 없습니다");
  const currentAuditPath = confinedStateFile(stateDir, answerAudit.auditPath, "migration current answer audit");
  if (await sha256File(currentAuditPath) !== answerAudit.auditHash) {
    throw new Error("migration current answer audit hash가 다릅니다");
  }
  await assertLinkedMigrationEvidence(join(dataDir, "files"), entry, problem, solution, imported);
  const receiptPath = join(stateDir, "receipt.json");
  migrationStateDirectory(stateDir, "receipt-history", false);
  const existingPlans = migrationPlans(stateDir);
  const existingCommits = migrationJsonArtifacts(
    stateDir, "migration-commits", /^v1-[a-f0-9]{64}\.json$/u
  );
  if (
    existingCommits.length > 1 ||
    (existingPlans.length === 0 && existingCommits.length > 0) ||
    (existingPlans.length === 1 && existingCommits.length === 1 &&
      existingCommits[0].name !== `v1-${existingPlans[0].basisDigest}.json`)
  ) throw new Error("migration commit이 orphan/duplicate입니다");
  let plan = selectExistingMigrationPlan(existingPlans, entry.id, expectedOldReceiptSha256);
  if (!plan) {
    const currentReceipt = readCanonicalMigrationJson(receiptPath, "migration old receipt");
    if (currentReceipt.sha256 !== expectedOldReceiptSha256) {
      throw new Error("migration 시작 receipt가 --expect-receipt-sha256과 다릅니다");
    }
    const historyRelativePath = `receipt-history/v1-${expectedOldReceiptSha256}.json`;
    const historyValue = {
      version: EXISTING_CORPUS_MIGRATION_VERSION,
      entryId: entry.id,
      receipt: { path: "receipt.json", sha256: currentReceipt.sha256, value: currentReceipt.value },
    };
    const historySha256 = canonicalEvidenceHash(historyValue);
    const identityDraft = buildExistingCorpusMigrationIdentity(
      db, entry, problem, solution, imported, currentReceipt.value, expectedOldReceiptSha256,
      receiptCore, { path: historyRelativePath, sha256: historySha256 }, answerAudit
    );
    migrationBackupDirectory(dataDir, true);
    const historyDirectory = migrationStateDirectory(stateDir, "receipt-history", true)!;
    if (await writeImmutableEvidence(join(historyDirectory, historyRelativePath.split("/").at(-1)!), historyValue) !== historySha256) {
      throw new Error("migration receipt history hash가 다릅니다");
    }
    const preparedBackup = await prepareMigrationBackupSnapshot(
      db, dataDir, identityDraft.beforeProjectionHash, identityDraft.ownership.bookIds
    );
    const identity: ExistingCorpusMigrationIdentity = {
      ...identityDraft,
      backup: { sha256: preparedBackup.sha256, bytes: preparedBackup.bytes },
    };
    const basisDigest = canonicalEvidenceHash(identity);
    const finalReceiptValue = buildMigratedCorpusReceipt(receiptCore, identity, basisDigest);
    const finalReceipt = {
      path: "receipt.json" as const,
      sha256: canonicalEvidenceHash(finalReceiptValue),
      value: finalReceiptValue,
    };
    const planDirectory = migrationStateDirectory(stateDir, "migration-plans", true)!;
    const backup = await publishMigrationBackup(preparedBackup, dataDir, entry.id, basisDigest);
    plan = { version: EXISTING_CORPUS_MIGRATION_VERSION, basisDigest, identity, finalReceipt, backup };
    assertExistingCorpusMigrationPlan(plan);
    await writeImmutableEvidence(join(planDirectory, `v1-${basisDigest}.json`), plan);
  }
  assertMigrationPlanInvocation(
    plan, entry, problem, solution, expectedOldReceiptSha256, receiptCore, answerAudit
  );
  assertSingleMigrationBackup(dataDir, plan);
  await assertMigrationBackup(dataDir, plan);
  const historyRelativePath = plan.identity.receiptHistory.path;
  const historyPath = confinedStateFile(stateDir, historyRelativePath, "migration receipt history");
  const history = readCanonicalMigrationJson(historyPath, "migration receipt history");
  const historyArtifacts = migrationJsonArtifacts(
    stateDir, "receipt-history", /^v1-[a-f0-9]{64}\.json$/u
  );
  if (
    historyArtifacts.length !== 1 || historyArtifacts[0].name !== historyRelativePath.split("/").at(-1) ||
    historyArtifacts[0].sha256 !== plan.identity.receiptHistory.sha256
  ) throw new Error("migration receipt history가 orphan/duplicate입니다");
  assertMigrationKeys(history.value, ["version", "entryId", "receipt"], "migration receipt history");
  assertMigrationKeys(object(history.value, "migration receipt history").receipt,
    ["path", "sha256", "value"], "migration receipt history pointer");
  if (canonicalEvidenceHash(history.value) !== history.sha256 || canonicalEvidenceHash(history.value) !== canonicalEvidenceHash({
    version: EXISTING_CORPUS_MIGRATION_VERSION,
    entryId: entry.id,
    receipt: plan.identity.oldReceipt,
  })) throw new Error("migration receipt history가 다릅니다");
  const commitDirectory = migrationStateDirectory(stateDir, "migration-commits", true)!;

  const currentProjection = readMigrationProjection(db, plan.identity.ownership.bookIds);
  const currentProjectionHash = migrationProjectionHash(currentProjection);
  const currentReceipt = readCanonicalMigrationJson(receiptPath, "migration receipt");
  if (existingCommits.length === 1 && currentReceipt.sha256 !== plan.finalReceipt.sha256) {
    throw new Error("migration commit이 있지만 final receipt가 없습니다");
  }
  if (currentReceipt.sha256 === plan.finalReceipt.sha256) {
    if (
      stableMigrationProjectionHash(currentProjection) !==
      stableMigrationProjectionHash(plan.identity.afterProjection)
    ) throw new Error("migration 완료 DB stable projection이 다릅니다");
  } else if (currentReceipt.sha256 === plan.identity.oldReceipt.sha256) {
    if (currentProjectionHash === plan.identity.beforeProjectionHash) {
      applyExistingCorpusMigrationPlan(db, plan);
    } else if (
      stableMigrationProjectionHash(currentProjection) !== plan.identity.stableAfterProjectionHash
    ) {
      throw new Error("migration DB가 partial/mixed 상태입니다");
    }
  } else {
    if (currentProjectionHash === plan.identity.beforeProjectionHash) {
      throw new Error("migration DB OLD + receipt NEW/unknown 상태입니다");
    }
    throw new Error("migration DB NEW + receipt unknown 상태입니다");
  }
  replaceMigrationReceipt(
    receiptPath, plan.identity.oldReceipt.sha256, plan.finalReceipt.sha256, plan.finalReceipt.value
  );
  const attestation = await writeAnswerAttestation(
    stateDir, entry.id, problem.sha256, solution.sha256, plan.finalReceipt.value, answerAudit
  );
  const planRelativePath = `migration-plans/v1-${plan.basisDigest}.json`;
  const planHash = await sha256File(confinedStateFile(stateDir, planRelativePath, "migration plan"));
  const commitBasis = {
    entryId: entry.id,
    basisDigest: plan.basisDigest,
    plan: { path: planRelativePath, sha256: planHash },
    receiptHistory: { path: historyRelativePath, sha256: history.sha256 },
    backup: plan.backup,
    dbProjectionHash: plan.identity.afterProjectionHash,
    stableDbProjectionHash: stableMigrationProjectionHash(plan.identity.afterProjection),
    receipt: plan.finalReceipt,
    answerAttestation: attestation,
  };
  const commit = {
    version: EXISTING_CORPUS_MIGRATION_VERSION,
    commitDigest: canonicalEvidenceHash(commitBasis),
    ...commitBasis,
  };
  const commitRelativePath = `migration-commits/v1-${plan.basisDigest}.json`;
  await writeImmutableEvidence(join(commitDirectory, commitRelativePath.split("/").at(-1)!), commit);
  const commits = migrationJsonArtifacts(stateDir, "migration-commits", /^v1-[a-f0-9]{64}\.json$/u);
  if (
    commits.length !== 1 || commits[0].name !== commitRelativePath.split("/").at(-1) ||
    canonicalEvidenceHash(commits[0].value) !== canonicalEvidenceHash(commit)
  ) throw new Error("migration commit이 orphan/duplicate입니다");
}

type EntryResult = {
  id: string;
  status: "imported" | "existing" | "filtered" | "review" | "skipped" | "error";
  accepted: number;
  message?: string;
};

export function validateFilteredResult(value: unknown, entryId: string): string {
  const result = object(value, "result.json");
  if (
    typeof result.version !== "number" || !Number.isInteger(result.version) ||
    ![2, 4, 5].includes(result.version) || result.status !== "filtered" || result.entryId !== entryId
  ) {
    throw new Error("기존 result.json이 유효하지 않습니다");
  }
  const reason = exactString(result.reason, "result.json.reason", 100);
  if (reason === "NO_IN_SCOPE_QUESTIONS" && (
    ![4, 5].includes(result.version) ||
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

function hasCurrentAnswerEvidence(stateDir: string): boolean {
  return ["semantic-choice-checks", "answer-audit", "answer-attestation"].some((directory) => {
    const path = join(stateDir, directory);
    return existsSync(path) && readdirSync(path).some((name) => name.startsWith("v5-") && name.endsWith(".json"));
  });
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
  entry: CorpusManifestEntry,
  migrationExpectedReceiptSha256: string | null = null
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
    if (object(rawResult, "result.json").version === 4 && hasCurrentAnswerEvidence(stateDir)) {
      throw new Error("legacy v4 filtered result와 current v5 evidence가 함께 존재합니다; 명시적 migration이 필요합니다");
    }
    if (reason === "NO_IN_SCOPE_QUESTIONS") {
      const result = object(rawResult, "result.json");
      const pointer = object(result.answerAudit, "result.json.answerAudit");
      const relativePath = exactString(pointer.path, "result.json.answerAudit.path", 500);
      const expectedHash = exactString(pointer.sha256, "result.json.answerAudit.sha256", 64);
      const path = confinedStateFile(stateDir, relativePath, "filtered answer audit");
      if (await sha256File(path) !== expectedHash) throw new Error("filtered answer audit hash가 다릅니다");
      const audit = object(JSON.parse(readFileSync(path, "utf8")), "filtered answer audit");
      const filteredVersion = Number(object(rawResult, "result.json").version);
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
        audit.version !== filteredVersion || audit.entryId !== entry.id ||
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
        relativePath !== `answer-audit/v${filteredVersion}-${auditDigest}.json`
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
  const baseDifficultyByKey = baseDifficultyByQuestionKey(classified);
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
      throw new Error("filtered corpus의 current terminal audit이 없습니다");
    }
    writeImmutableJson(resultPath, {
      version: 5,
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
  const imported = matchOfficialSolutions(entry, classified, answerAudit.solutions, baseDifficultyByKey);
  const receipt = buildCorpusReceipt(entry, problem, solution, classified, imported);
  if (migrationExpectedReceiptSha256) {
    await migrateExistingCorpusEntry(
      db, dataDir, stateDir, entry, problem, solution, imported, receipt, answerAudit,
      migrationExpectedReceiptSha256
    );
    return { id: entry.id, status: "existing", accepted: imported.length };
  }
  if (existsSync(receiptPath)) {
    const existingReceipt = readCanonicalMigrationJson(receiptPath, "existing corpus receipt");
    if ("migration" in object(existingReceipt.value, "existing corpus receipt")) {
      const plans = migrationPlans(stateDir).filter((plan) => plan.finalReceipt.sha256 === existingReceipt.sha256);
      if (plans.length !== 1) throw new Error("migration receipt의 plan이 유일하지 않습니다");
      await migrateExistingCorpusEntry(
        db, dataDir, stateDir, entry, problem, solution, imported, receipt, answerAudit,
        plans[0].identity.oldReceipt.sha256
      );
      return { id: entry.id, status: "existing", accepted: imported.length };
    }
  }
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
  return "npx tsx scripts/import-exam-corpus.ts --manifest data/ebsi-exam-manifest.json [--data-dir ./data] " +
    "[--commit [--migrate-existing <entryId> --expect-receipt-sha256 <64hex>]]";
}

export function cliOptions(argv: string[]): {
  manifest: string;
  dataDir: string;
  commit: boolean;
  migrateExisting: string | null;
  expectedReceiptSha256: string | null;
} {
  let manifest = "";
  let dataDir = process.env.DATA_DIR || "./data";
  let commit = false;
  let migrateExisting: string | null = null;
  let expectedReceiptSha256: string | null = null;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--manifest") manifest = argv[++index] ?? "";
    else if (arg === "--data-dir") dataDir = argv[++index] ?? "";
    else if (arg === "--commit") commit = true;
    else if (arg === "--migrate-existing") migrateExisting = argv[++index] ?? "";
    else if (arg === "--expect-receipt-sha256") expectedReceiptSha256 = argv[++index] ?? "";
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else throw new Error(`알 수 없는 옵션: ${arg}`);
  }
  if (!manifest) throw new Error(`--manifest가 필요합니다\n${usage()}`);
  if (!dataDir) throw new Error("--data-dir가 비어 있습니다");
  if ((migrateExisting === null) !== (expectedReceiptSha256 === null)) {
    throw new Error("--migrate-existing와 --expect-receipt-sha256를 함께 지정해야 합니다");
  }
  if (migrateExisting !== null && (
    !commit || !migrateExisting || !expectedReceiptSha256 || !/^[a-f0-9]{64}$/u.test(expectedReceiptSha256)
  )) throw new Error("existing migration은 --commit과 exact entry/receipt SHA가 필요합니다");
  return {
    manifest: resolve(manifest), dataDir: resolve(dataDir), commit,
    migrateExisting, expectedReceiptSha256,
  };
}

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* optional */ }
  const options = cliOptions(process.argv.slice(2));
  const manifest = parseCorpusManifest(JSON.parse(readFileSync(options.manifest, "utf8")));
  const supported = manifest.entries.filter((entry) => SUPPORTED_SOURCES.has(entry.subject));
  const migrationEntry = options.migrateExisting === null
    ? null
    : manifest.entries.filter((entry) => entry.id === options.migrateExisting);
  if (migrationEntry && migrationEntry.length !== 1) {
    throw new Error(`migration manifest entry가 유일하지 않습니다: ${options.migrateExisting}`);
  }
  if (migrationEntry) {
    const spec = migrationSpec(migrationEntry[0].id);
    if (!spec || spec.oldReceiptSha256 !== options.expectedReceiptSha256) {
      throw new Error(`${migrationEntry[0].id} existing migration allowlist/old receipt SHA가 다릅니다`);
    }
  }
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
    if (!migrationEntry) ensureCanonicalSubjects(db);
    const runEntry = async (entry: CorpusManifestEntry): Promise<EntryResult> => {
      try {
        const result = await processEntry(db, options.dataDir, entry, options.expectedReceiptSha256);
        console.log(`${result.status.padEnd(8)} ${entry.id} ${result.accepted}`);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`error    ${entry.id} ${message}`);
        return { id: entry.id, status: "error", accepted: 0, message } satisfies EntryResult;
      }
    };
    const results = migrationEntry
      ? [await runEntry(migrationEntry[0])]
      : await mapPool(manifest.entries, IMPORT_CONCURRENCY, runEntry);
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
