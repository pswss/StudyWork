import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, TARGET_SUBJECTS, verifyExamCorpus } from "../scripts/verify-exam-corpus";

type Target = (typeof TARGET_SUBJECTS)[number];
type Accepted = { canonical: string; target: Target; code: string };

const DIGEST = "1234567890abcdef";
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

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function token(value: string, length: number): string {
  return hash(value).slice(0, length);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
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
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "problem.pdf"), problem);
    writeFileSync(join(stateDir, "solution.pdf"), solution);
    writeJson(join(stateDir, "entry.json"), { schemaVersion: 1, entry });
    writeJson(join(stateDir, "downloads.json"), {
      version: 2,
      problem: { path: "problem.pdf", requestedUrl: entry.problemPdfUrl, sha256: problemHash, bytes: problem.length, pageCount: 1 },
      solution: { path: "solution.pdf", requestedUrl: entry.solutionPdfUrl, sha256: solutionHash, bytes: solution.length, pageCount: 1 },
    });
    const problems = Array.from({ length: SOURCE_COUNTS[testCase.subject] }, (_, index) => ({
      number: String(index + 1),
      qtype: "short",
      difficulty: "중",
      question: `${testCase.id} question ${index + 1}`,
      choices: null,
      answer: `${testCase.id}-answer-${index + 1}`,
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
    writeJson(join(stateDir, "classification-chunks", `v2-0000-${DIGEST}.json`), {
      version: 2,
      sourceHash: problemHash,
      from: 1,
      to: 1,
      ownedFrom: 1,
      ownedTo: 1,
      rulesDigest: DIGEST,
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
        } : {
          key: `1:${index + 1}`,
          decision: "reject",
          canonical_subject: null,
          curriculum_course: null,
          domain: null,
          achievement_codes: [],
          confidence: 0.99,
          reason_codes: ["OUT_OF_SCOPE"],
        };
      }),
    });
    writeJson(join(stateDir, "solution-chunks", "v2-0000.json"), {
      version: 2,
      sourceHash: solutionHash,
      from: 1,
      to: 1,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      items: problems.map((problemItem, index) => ({
        number: String(index + 1),
        answer: problemItem.answer,
        explanation: `${testCase.id} official explanation ${index + 1}`,
        page: 1,
        complete: true,
      })),
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
      db.prepare("INSERT INTO book_files (id, book_id, r2_key, content_hash, page_count, status) VALUES (?, ?, ?, ?, 1, 'ready')")
        .run(solutionFileId, targetBookId, solutionR2Key, solutionHash);
      const officialExplanation = `${testCase.id} official explanation ${index + 1}`;
      const id = ++questionId;
      db.prepare(
        `INSERT INTO questions
         (id, subject_id, source, qtype, question, choices, answer, explanation, book_id,
          book_number, printed_number, src_file_id, src_page)
         VALUES (?, ?, 'uploaded', 'short', ?, NULL, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(
        id,
        subjectIds.get(accepted.target),
        problems[index].question,
        problems[index].answer,
        officialExplanation,
        targetBookId,
        String(index + 1),
        String(index + 1),
        problemFileId,
      );
      db.prepare("INSERT INTO book_items (id, book_id, file_id, category, number, answer, content, page) VALUES (?, ?, ?, '문제', ?, ?, ?, 1)")
        .run(++itemId, targetBookId, problemFileId, String(index + 1), problems[index].answer, problems[index].question);
      db.prepare("INSERT INTO book_items (id, book_id, file_id, category, number, answer, content, page) VALUES (?, ?, ?, '해설', ?, ?, ?, 1)")
        .run(++itemId, targetBookId, solutionFileId, String(index + 1), problems[index].answer, officialExplanation);
      return {
        subject: accepted.target,
        examTitle: entry.examTitle,
        bookTitle: displayTitle,
        expectedQuestionCount: 1,
        problemR2Key,
        solutionR2Key,
      };
    });
    writeJson(join(stateDir, "receipt.json"), {
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

describe("exam corpus verifier", () => {
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

  it("fails closed on exclusions, review rows, missing official explanation, duplicates, and count drift", () => {
    const files = fixture();
    const mathClassification = join(files.stateDirs.math, "classification-chunks", `v2-0000-${DIGEST}.json`);
    const math = JSON.parse(readFileSync(mathClassification, "utf8"));
    math.items[0].achievement_codes = ["12미적Ⅱ-01-01"];
    writeJson(mathClassification, math);
    const koreanClassification = join(files.stateDirs.korean, "classification-chunks", `v2-0000-${DIGEST}.json`);
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
    db.prepare("UPDATE questions SET explanation = '' WHERE id = 1").run();
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
    expect(codes.has("REVIEW_PENDING")).toBe(true);
    expect(codes.has("OFFICIAL_EXPLANATION")).toBe(true);
    expect(codes.has("DUPLICATE_QUESTION")).toBe(true);
    expect(codes.has("COUNT_MISMATCH")).toBe(true);
    expect(codes.has("DB_FILE_EVIDENCE")).toBe(true);

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
