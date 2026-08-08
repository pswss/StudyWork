import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  QUIZ_EXTRACT_SPEC,
  TARGETED_PROBLEM_TRANSCRIPTION_RULES,
  TARGETED_PROBLEM_TRANSCRIPTION_VERSION,
  TARGETED_PROBLEM_REVISION_EVIDENCE_PREFIX,
  TARGETED_PROBLEM_REVISION_RULES,
  TARGETED_PROBLEM_REVISION_VERSION,
  TARGETED_SOLUTION_TRANSCRIPTION_RULES,
  TARGETED_SOLUTION_TRANSCRIPTION_VERSION,
  TARGETED_SOLUTION_REVISION_EVIDENCE_PREFIX,
  TARGETED_SOLUTION_REVISION_RULES,
  TARGETED_SOLUTION_REVISION_VERSION,
} from "../src/claude";
import {
  canonicalEvidenceHash,
  compareCorpusQuestionKeys,
  officialAnswerForDb,
  runCli,
  TARGET_SUBJECTS,
  verifyExamCorpus,
} from "../scripts/verify-exam-corpus";

type Target = (typeof TARGET_SUBJECTS)[number];
type Accepted = { canonical: string; target: Target; code: string };
type AnswerCase = {
  qtype: "mcq" | "short";
  choices: string[] | null;
  problemAnswer: string;
  officialRaw: string;
  storedAnswer: string;
};

const DIGEST = "1234567890abcdef";
const SEMANTIC_RULES =
  `For each item, use only its official detailed explanation and answer-choice contents to identify the one ` +
  `choice semantically supported by the reasoning. The official answer marker and the problem extractor's answer ` +
  `are intentionally hidden and must not be guessed; ordinal markers inside explanations are redacted. ` +
  `Return ambiguous when the explanation does not establish ` +
  `exactly one choice. choiceIndex is 1-based and evidence must briefly cite the decisive value or conclusion.`;
const SEMANTIC_PROMPT_DIGEST = hash(`3\n${SEMANTIC_RULES}`);
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
const CASES: Array<{ id: string; subject: string; grade: number; rawTitle: string; accepted: Accepted[] }> = [
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
      explanation TEXT NOT NULL, book_id INTEGER, book_number TEXT, printed_number TEXT,
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
      id: `ebsi:${testCase.id}`,
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
          book_number, printed_number, src_file_id, src_page)
         VALUES (?, ?, 'uploaded', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(
        id,
        subjectIds.get(accepted.target),
        answer.qtype,
        problems[index].question,
        answer.choices ? JSON.stringify(answer.choices) : null,
        answer.storedAnswer,
        officialExplanation,
        targetBookId,
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

function rewriteSolutionRepairAuthority(
  files: ReturnType<typeof fixture>,
  mutateRepair: (repair: Record<string, any>) => void,
): void {
  const stateDir = files.stateDirs.math;
  const attestationDir = join(stateDir, "answer-attestation");
  const attestationName = readdirSync(attestationDir).find((name) => /^v2-/u.test(name))!;
  const attestation = JSON.parse(readFileSync(join(attestationDir, attestationName), "utf8"));
  const audit = JSON.parse(readFileSync(join(stateDir, attestation.answerAudit.path), "utf8"));
  mutateRepair(audit.solutionRepairs[0]);
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
  attestationBasis.solutionRepairs = audit.solutionRepairs;
  const attestationDigest = canonicalEvidenceHash(attestationBasis);
  for (const name of readdirSync(attestationDir)) rmSync(join(attestationDir, name));
  writeEvidence(join(attestationDir, `v2-${attestationDigest}.json`), {
    version: 2,
    attestationDigest,
    ...attestationBasis,
  });
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
    const modifiedBefore = statSync(files.dbPath).mtimeMs;
    const report = verifyExamCorpus(files);

    expect(report.ok).toBe(true);
    expect(report.manifest).toEqual({ expected: 4, terminal: 4, committed: 4, filtered: 0, review: 0 });
    expect(report.questions).toEqual({ expected: 6, actual: 6 });
    expect(Object.values(report.targets)).toEqual(Array.from({ length: 6 }, () => ({ expected: 1, actual: 1 })));
    expect(statSync(files.dbPath).mtimeMs).toBe(modifiedBefore);
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
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("no attested revision"))).toBe(true);

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
      failure.code === "ANSWER_AUDIT_INVALID" && failure.message.includes("must not declare"))).toBe(true);
    expect(artifacts.firstFidelityArtifact).toContain("solution-fidelity-repairs/v1-");
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
      (subject_id, source, qtype, question, choices, answer, explanation, book_id,
       book_number, printed_number, src_file_id, src_page)
      SELECT subject_id, source, qtype, question, choices, answer, explanation, book_id,
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
