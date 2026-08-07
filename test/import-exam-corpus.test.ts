import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { LocalDB } from "../src/localdb";
import { problemExtractionSelfContainedRule } from "../src/claude";
import {
  TARGET_SUBJECTS,
  PROBLEM_SLICE_PAGES,
  PROBLEM_SLICE_STRIDE,
  assertImportSchema,
  commitCorpusEntry,
  ensureCanonicalSubjects,
  examBookTitle,
  isAllowedAchievementCode,
  matchOfficialSolutions,
  parseCorpusManifest,
  parsePdfInfoOutput,
  problemChunkCount,
  problemOwnedRange,
  validateFilteredResult,
  validateProblemSliceTopology,
  withImporterPdfForAnalysis,
  type ClassificationDecision,
  type PdfEvidence,
} from "../scripts/import-exam-corpus";

describe("exam corpus importer", () => {
  it("commits once, resumes without duplicates, and preserves same-title books", async () => {
    const root = mkdtempSync(join(tmpdir(), "studywork-corpus-test-"));
    const dbPath = join(root, "studywork.db");
    const migrated = new LocalDB(dbPath, { migrationsDir: resolve(import.meta.dirname, "..", "migrations") });
    migrated.close();
    const db = new Database(dbPath);
    try {
      db.pragma("foreign_keys = ON");
      assertImportSchema(db);
      const subjects = ensureCanonicalSubjects(db);
      expect([...subjects.keys()]).toEqual(TARGET_SUBJECTS);

      const entry = parseCorpusManifest({
        schemaVersion: 2,
        entries: [{
          id: "ebsi:paper-1",
          subject: "수학",
          examTitle: "2026학년도 3월 전국연합학력평가 수학 영역",
          rawTitle: "2026학년도 3월 전국연합학력평가 수학 영역 미적분",
          sourceRecordDate: "2026-03-24",
          sourceRecordYear: 2026,
          variant: "미적분",
          form: null,
          sourcePageUrl: "https://www.ebsi.co.kr/exam/1",
          problemPdfUrl: "https://wdown.ebsi.co.kr/problem.pdf",
          solutionPdfUrl: "https://wdown.ebsi.co.kr/solution.pdf",
          grade: 3,
          paperId: "paper-1",
        }],
      }).entries[0];
      const historicalVariants = parseCorpusManifest({
        schemaVersion: 2,
        entries: [
          {
            ...entry.raw,
            id: "ebsi:ga",
            rawTitle: "2017학년도 대학수학능력시험 수학가형 홀수형",
            examTitle: "2017학년도 대학수학능력시험",
            sourceRecordDate: "2016-11-17",
            sourceRecordYear: 2016,
            variant: "수학가형",
            form: "odd",
          },
          {
            ...entry.raw,
            id: "ebsi:na",
            rawTitle: "2017학년도 대학수학능력시험 수학나형 홀수형",
            examTitle: "2017학년도 대학수학능력시험",
            sourceRecordDate: "2016-11-17",
            sourceRecordYear: 2016,
            variant: "수학나형",
            form: "odd",
            problemPdfUrl: "https://wdown.ebsi.co.kr/problem-na.pdf",
            solutionPdfUrl: "https://wdown.ebsi.co.kr/solution-na.pdf",
          },
        ],
      }).entries;
      expect(examBookTitle(historicalVariants[0])).toBe("2016년 · 2017학년도 대학수학능력시험 수학가형 홀수형");
      expect(examBookTitle(historicalVariants[1])).toBe("2016년 · 2017학년도 대학수학능력시험 수학나형 홀수형");
      expect(examBookTitle(historicalVariants[0])).not.toBe(examBookTitle(historicalVariants[1]));
      expect(examBookTitle({ sourceRecordYear: 2025, rawTitle: "고2 3월 학평(서울) 국어" })).not.toBe(
        examBookTitle({ sourceRecordYear: 2017, rawTitle: "고2 3월 학평(서울) 국어" })
      );
      expect(() => parseCorpusManifest({
        schemaVersion: 2,
        entries: [
          historicalVariants[0].raw,
          {
            ...historicalVariants[0].raw,
            id: "ebsi:duplicate-title",
            problemPdfUrl: "https://wdown.ebsi.co.kr/problem-duplicate.pdf",
            solutionPdfUrl: "https://wdown.ebsi.co.kr/solution-duplicate.pdf",
          },
        ],
      })).toThrow("중복 표시 제목");
      expect([PROBLEM_SLICE_PAGES, PROBLEM_SLICE_STRIDE]).toEqual([20, 18]);
      expect(problemOwnedRange({ from: 1, to: 20 }, 0, 19)).toEqual({ from: 1, to: 19 });
      expect(problemOwnedRange({ from: 19, to: 38 }, 1, 37)).toEqual({ from: 20, to: 37 });
      expect(problemOwnedRange({ from: 37, to: 45 }, 2)).toEqual({ from: 38, to: 45 });
      expect([19, 20].map((page) => [
        page >= 1 && page <= 19,
        page >= 20 && page <= 37,
      ].filter(Boolean).length)).toEqual([1, 1]);
      expect([problemChunkCount(20), problemChunkCount(21), problemChunkCount(38), problemChunkCount(39)])
        .toEqual([1, 2, 2, 3]);
      expect(validateProblemSliceTopology([
        { from: 1, to: 20 }, { from: 19, to: 38 }, { from: 37, to: 45 },
      ])).toEqual([{ from: 1, to: 19 }, { from: 20, to: 37 }, { from: 38, to: 45 }]);
      expect(() => validateProblemSliceTopology([{ from: 1, to: 10 }, { from: 11, to: 20 }]))
        .toThrow("2쪽 overlap topology");
      expect(validateFilteredResult({
        version: 2,
        status: "filtered",
        entryId: entry.id,
        reason: "SOURCE_GRADE_OUT_OF_SCOPE",
      }, entry.id)).toBe("SOURCE_GRADE_OUT_OF_SCOPE");
      expect(() => validateFilteredResult({
        version: 2,
        status: "filtered",
        entryId: entry.id,
        reason: "NO_IN_SCOPE_QUESTIONS",
        rulesDigest: "stale",
      }, entry.id)).toThrow("rulesDigest가 오래되었습니다");
      expect(() => parseCorpusManifest({
        schemaVersion: 2,
        entries: [{ ...entry.raw, problemPdfUrl: "https://example.test/problem.pdf" }],
      })).toThrow("wdown.ebsi.co.kr");
      expect(problemExtractionSelfContainedRule(false)).toBe("");
      expect(problemExtractionSelfContainedRule(true)).toContain("complete shared passage");
      expect([
        isAllowedAchievementCode("math_A", "12미적Ⅰ-02-10"),
        isAllowedAchievementCode("math_B", "12대수03-07"),
        isAllowedAchievementCode("korean_reading", "12독작01-14"),
        isAllowedAchievementCode("korean_literature", "12문학01-09"),
        isAllowedAchievementCode("integrated_science", "10통과2-03-04"),
        isAllowedAchievementCode("integrated_social", "10통사2-05-03"),
      ]).toEqual([true, true, true, true, true, true]);
      expect(isAllowedAchievementCode("math_A", "12미적Ⅱ-02-01")).toBe(false);
      expect(isAllowedAchievementCode("integrated_science", "10통과2-03-05")).toBe(false);
      const decision: ClassificationDecision = {
        key: "2:1",
        decision: "accept",
        canonical_subject: "math_B",
        curriculum_course: "2022 대수",
        domain: "지수함수와 로그함수",
        achievement_codes: ["12대수01-01"],
        confidence: 0.99,
        reason_codes: ["IN_SCOPE"],
      };
      const classified = Array.from({ length: 30 }, (_, index) => {
        const number = index + 1;
        const page = 2 + Math.floor(index / 5);
        return {
          question: number === 1 ? {
            number: "1",
            qtype: "mcq" as const,
            difficulty: "중" as const,
            question: "$2^x=2$일 때 $x$는?",
            choices: ["① 1", "② 2"],
            answer: "② 2",
            explanation: "",
            page,
            figure: false,
            figure_description: null,
            box: null,
          } : {
            number: String(number),
            qtype: "short" as const,
            difficulty: "중" as const,
            question: `${number}번 제외 문항`,
            choices: null,
            answer: String(number),
            explanation: "",
            page,
            figure: false,
            figure_description: null,
            box: null,
          },
          classification: number === 1 ? decision : {
            key: `${page}:${number}`,
            decision: "reject" as const,
            canonical_subject: null,
            curriculum_course: null,
            domain: null,
            achievement_codes: [],
            confidence: 0.99,
            reason_codes: ["OUT_OF_SCOPE"],
          },
        };
      });
      const officialSolutions = Array.from({ length: 30 }, (_, index) => ({
        number: String(index + 1),
        answer: index === 0 ? "①" : String(index + 1),
        explanation: index === 0 ? "$x=1$이다." : "",
        page: 3 + Math.floor(index / 5),
        complete: true as const,
      }));
      const imported = matchOfficialSolutions(entry, classified, officialSolutions);
      expect(imported[0].officialAnswer).toBe("①");
      expect(() => matchOfficialSolutions(entry, classified, officialSolutions.map((solution, index) =>
        index === 0 ? { ...solution, explanation: "" } : solution
      ))).toThrow(
        "공식 해설 본문이 비어 있습니다"
      );
      expect(() => matchOfficialSolutions(entry, classified.map((item, index) =>
        index === 29 ? { ...item, question: { ...item.question, number: "29" } } : item
      ), officialSolutions)).toThrow("문제 인쇄 번호가 중복입니다");
      expect(() => matchOfficialSolutions(entry, classified, officialSolutions.map((solution, index) =>
        index === 29 ? { ...solution, number: "31" } : solution
      ))).toThrow("인쇄 번호 집합이 다릅니다");
      expect(() => matchOfficialSolutions(entry, classified, officialSolutions.map((solution, index) =>
        index === 0 ? { ...solution, answer: "③" } : solution
      ))).toThrow("보기 범위를 벗어났습니다");

      expect(parsePdfInfoOutput("Pages: 28\nEncrypted: yes (print:yes copy:yes change:no algorithm:AES)\n"))
        .toEqual({ pages: 28, encrypted: true });
      expect(() => parsePdfInfoOutput("Pages: 28\nEncrypted: yes (print:yes copy:no algorithm:AES)\n"))
        .toThrow("인쇄와 복사가 모두 허용");
      const sourcePdf = await PDFDocument.create();
      sourcePdf.addPage();
      sourcePdf.addPage();
      const sourcePdfBytes = Buffer.from(await sourcePdf.save());
      const sourcePdfPath = join(root, "normalization-source.pdf");
      writeFileSync(sourcePdfPath, sourcePdfBytes);
      let normalizedPath = "";
      await expect(withImporterPdfForAnalysis({
        path: sourcePdfPath,
        sha256: createHash("sha256").update(sourcePdfBytes).digest("hex"),
        bytes: sourcePdfBytes.length,
        pageCount: 2,
        requestedUrl: entry.solutionPdfUrl,
        resolvedUrl: entry.solutionPdfUrl,
        requiresNormalization: true,
      }, async (analysis) => {
        normalizedPath = analysis.path;
        expect(analysis.path).not.toBe(sourcePdfPath);
        expect(analysis.sha256).toBe(createHash("sha256").update(sourcePdfBytes).digest("hex"));
        expect(analysis.pageCount).toBe(2);
        expect(existsSync(analysis.path)).toBe(true);
      })).resolves.toBeUndefined();
      expect(existsSync(normalizedPath)).toBe(false);
      expect(existsSync(sourcePdfPath)).toBe(true);

      const makeEvidence = (name: string, url: string): PdfEvidence => {
        const path = join(root, name);
        const bytes = Buffer.from(`%PDF-1.4\n${name}\n`);
        writeFileSync(path, bytes);
        return {
          path,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
          pageCount: 4,
          requestedUrl: url,
          resolvedUrl: url,
        };
      };
      const problem = makeEvidence("problem.pdf", entry.problemPdfUrl);
      const solution = makeEvidence("solution.pdf", entry.solutionPdfUrl);
      const filesDir = join(root, "files");
      const userBookId = Number(db.prepare("INSERT INTO books (subject_id, title) VALUES (?, ?)").run(
        subjects.get("수학 - 수학Ⅰ·대수"),
        examBookTitle(entry),
      ).lastInsertRowid);

      const first = await commitCorpusEntry(db, filesDir, entry, problem, solution, imported);
      expect(first.insertedTargets).toEqual(["수학 - 수학Ⅰ·대수"]);
      db.prepare("UPDATE questions SET correct_count = 2 WHERE book_id IS NOT NULL").run();
      const resumed = await commitCorpusEntry(db, filesDir, entry, problem, solution, imported, true);
      expect(resumed.existingTargets).toEqual(["수학 - 수학Ⅰ·대수"]);
      expect((db.prepare("SELECT COUNT(*) AS n FROM subjects").get() as { n: number }).n).toBe(6);
      expect((db.prepare("SELECT COUNT(*) AS n FROM books").get() as { n: number }).n).toBe(2);
      expect((db.prepare("SELECT COUNT(*) AS n FROM questions").get() as { n: number }).n).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS n FROM book_items").get() as { n: number }).n).toBe(2);
      expect((db.prepare("SELECT correct_count FROM questions").get() as { correct_count: number }).correct_count).toBe(2);
      expect((db.prepare("SELECT title FROM books WHERE id = ?").get(userBookId) as { title: string }).title).toBe(examBookTitle(entry));

      const sameTitleExam = { ...entry, id: "ebsi:paper-2", raw: { ...entry.raw, id: "ebsi:paper-2" } };
      const second = await commitCorpusEntry(db, filesDir, sameTitleExam, problem, solution, imported);
      expect(second.insertedTargets).toEqual(["수학 - 수학Ⅰ·대수"]);
      expect((db.prepare("SELECT COUNT(*) AS n FROM books").get() as { n: number }).n).toBe(3);
      expect((db.prepare("SELECT COUNT(*) AS n FROM questions").get() as { n: number }).n).toBe(2);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
