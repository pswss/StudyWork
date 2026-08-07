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
  CLASSIFIER_DIGEST,
  CLASSIFIER_VERSION,
  CLASSIFICATION_REPAIR_VERSION,
  CURRICULUM_RULES,
  SEMANTIC_CHOICE_CHECK_VERSION,
  TRANSCRIPTION_GATE_RULES,
  TRANSCRIPTION_GATE_VERSION,
  TRANSCRIPTION_PROMPT_DIGEST,
  SOLUTION_CHECKPOINT_VERSION,
  TARGET_SUBJECTS,
  PROBLEM_SLICE_PAGES,
  PROBLEM_SLICE_STRIDE,
  PROBLEM_REPAIR_VERSION,
  assertImportSchema,
  canonicalEvidenceHash,
  commitCorpusEntry,
  ensureCanonicalSubjects,
  examBookTitle,
  isAllowedAchievementCode,
  matchOfficialSolutions,
  officialAnswerForStorage,
  parseCorpusManifest,
  parsePdfInfoOutput,
  problemChunkCount,
  problemOwnedRange,
  solutionOwnedStartRange,
  semanticExplanationWithoutMarkers,
  transcriptionRepairKeys,
  validateFilteredResult,
  validateProblemSliceTopology,
  withImporterPdfForAnalysis,
  type ClassificationDecision,
  type PdfEvidence,
} from "../scripts/import-exam-corpus";

describe("exam corpus importer", () => {
  it("uses one stable canonical evidence hash vector", () => {
    expect(canonicalEvidenceHash({ b: 1, a: ["x", null] }))
      .toBe("2dccb31ca7d4b9dc00ebe9e1b2fca5314ca2563469fbf6ba1c69752939768835");
  });

  it("defines the q20 same-target and q29 excluded-dependency boundary", () => {
    expect(CLASSIFIER_VERSION).toBe(4);
    expect(PROBLEM_REPAIR_VERSION).toBe(2);
    expect(CLASSIFICATION_REPAIR_VERSION).toBe(2);
    expect(SEMANTIC_CHOICE_CHECK_VERSION).toBe(2);
    expect(TRANSCRIPTION_GATE_VERSION).toBe(1);
    expect(TRANSCRIPTION_PROMPT_DIGEST).toMatch(/^[a-f0-9]{64}$/u);
    expect(TRANSCRIPTION_GATE_RULES).toContain("complete shared passage");
    expect(TRANSCRIPTION_GATE_RULES).toContain("every answer choice and distractor");
    expect(TRANSCRIPTION_GATE_RULES).toContain("Base the curriculum decision on the source pixels");
    expect(TRANSCRIPTION_GATE_RULES).toContain("reject and review items still require this source check");
    expect(CURRICULUM_RULES).toContain(
      "If every necessary concept belongs to one canonical subject, accept under that canonical subject even when multiple domains or codes are required"
    );
    expect(CURRICULUM_RULES).toContain("logarithms plus a finite sequence sum accepts as math_B");
    expect(CURRICULUM_RULES).toContain(
      "If solving necessarily depends on even one excluded or out-of-target concept, reject the whole question"
    );
    expect(CURRICULUM_RULES).toContain("coordinate geometry plus a sequence or logarithm");
    expect(CURRICULUM_RULES).toContain(
      "Use review only for genuine ambiguity, missing or unclear visual/passage context"
    );
    expect(createHash("sha256").update(CURRICULUM_RULES).digest("hex").slice(0, 16))
      .toBe("7bb7cb863c8c4855");
  });

  it("owns solution starts once and resolves official MCQ values without changing markers", () => {
    expect(SOLUTION_CHECKPOINT_VERSION).toBe(3);
    expect(solutionOwnedStartRange({ from: 1, to: 6 }, 5)).toEqual({ from: 1, to: 4 });
    expect(solutionOwnedStartRange({ from: 5, to: 10 })).toEqual({ from: 5, to: 10 });

    const question = (choices: string[]) => ({
      number: "4",
      qtype: "mcq" as const,
      difficulty: "중" as const,
      question: "공식 정답 매핑",
      choices,
      answer: "",
      explanation: "",
      page: 1,
      figure: false,
      figure_description: null,
      box: null,
    });
    expect(officialAnswerForStorage(question(["① 6", "② 9", "③ 12", "④ 15", "⑤ 18"]), "18"))
      .toBe("⑤ 18");
    expect(officialAnswerForStorage(question(["① $5$", "② $6$", "③ $7$", "④ $8$", "⑤ $9$"]), "8"))
      .toBe("④ $8$");
    expect(officialAnswerForStorage(
      question(["① $\\frac76$", "② $\\frac43$", "③ $\\frac32$", "④ $\\frac53$", "⑤ $\\frac{11}{6}$"]),
      "$\\dfrac{4}{3}$"
    )).toBe("② $\\frac43$");
    expect(officialAnswerForStorage(question(["① 2", "② 7"]), "2")).toBe("① 2");
    expect(officialAnswerForStorage(question(["① 5", "② 0.5"]), "0.5")).toBe("② 0.5");
    expect(() => officialAnswerForStorage(question(["① 5", "② 7"]), "0.5"))
      .toThrow("보기에 대응할 수 없습니다");
    expect(officialAnswerForStorage(question(["① 6", "② 9", "③ 12", "④ 15", "⑤ 18"]), "⑤"))
      .toBe("⑤");
    expect(semanticExplanationWithoutMarkers(
      "[정답] 2 / 정답: 3 / 4번이 정답 / 2번 선택지가 정답 / 선택지 2가 정답 / " +
      "계산 결과는 2이다. / 답은 20개 / 정답은 1359"
    )).toBe(
      "[CHOICE MARKER HIDDEN] / [CHOICE MARKER HIDDEN] / [CHOICE MARKER HIDDEN] / " +
      "[CHOICE MARKER HIDDEN] / [CHOICE MARKER HIDDEN] / 계산 결과는 2이다. / 답은 20개 / 정답은 1359"
    );

    const officialQ11 = "\\(\\frac{7\\pi}{6}\\)";
    expect(() => officialAnswerForStorage(question([
      "① $\\frac{1}{6}\\pi$",
      "② $\\frac{1}{3}\\pi$",
      "③ $\\frac{1}{2}\\pi$",
      "④ $\\frac{2}{3}\\pi$",
      "⑤ $\\frac{5}{6}\\pi$",
    ]), officialQ11)).toThrow("보기에 대응할 수 없습니다");
    expect(officialAnswerForStorage(question([
      "① $\\frac{7}{6}\\pi$",
      "② $\\frac{4}{3}\\pi$",
      "③ $\\frac{3}{2}\\pi$",
      "④ $\\frac{5}{3}\\pi$",
      "⑤ $\\frac{11}{6}\\pi$",
    ]), officialQ11)).toBe("① $\\frac{7}{6}\\pi$");
  });

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
      }, entry.id)).toThrow("transcription gate가 오래되었습니다");
      expect(validateFilteredResult({
        version: 2,
        status: "filtered",
        entryId: entry.id,
        reason: "NO_IN_SCOPE_QUESTIONS",
        rulesDigest: CLASSIFIER_DIGEST,
        classifierVersion: CLASSIFIER_VERSION,
        transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
        transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
      }, entry.id)).toBe("NO_IN_SCOPE_QUESTIONS");
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
        transcription_status: "exact",
        transcription_evidence: "원본 2쪽의 식과 보기가 일치한다.",
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
            transcription_status: "exact" as const,
            transcription_evidence: `원본 ${page}쪽의 문항과 일치한다.`,
          },
        };
      });
      expect(transcriptionRepairKeys([
        classified[0],
        {
          ...classified[1],
          classification: {
            ...classified[1].classification,
            transcription_status: "mismatch",
          },
        },
      ])).toEqual([`${classified[1].question.page}:2`]);
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
      await expect(commitCorpusEntry(db, filesDir, entry, problem, solution, [{
        ...imported[0],
        question: "repair로 달라진 문항",
      }], true)).rejects.toThrow("덮어쓰지 않습니다");
      await expect(commitCorpusEntry(db, filesDir, entry, problem, solution, [{
        ...imported[0],
        targetSubject: "수학 - 수학Ⅱ·미적분Ⅰ",
        classification: {
          ...imported[0].classification,
          canonical_subject: "math_A",
          achievement_codes: ["12미적Ⅰ-02-01"],
        },
      }], true)).rejects.toThrow("이전 import 책이 삭제되었습니다");

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
