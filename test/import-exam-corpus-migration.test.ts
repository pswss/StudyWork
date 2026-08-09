import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  EXISTING_CORPUS_MIGRATION_ALLOWLIST,
  applyExistingCorpusMigrationPlan,
  assertMigrationAnswerEquivalent,
  canonicalEvidenceHash,
  cliOptions,
  selectExistingMigrationPlan,
  stableMigrationProjectionHash,
  type ImportedQuestion,
} from "../scripts/import-exam-corpus";

const execFileP = promisify(execFile);
const repository = resolve(import.meta.dirname, "..");
const sourceData = join(repository, "data");
const token = "bc66d0c1b35ffd8e12edd536";
const oldReceiptSha = "5e1fbea9c346a0e89fb21938176c21e00c19527e6369f5251a1f53e6446711a1";
const receiptCoreSha = "0b4cad740ed82c70e15deac8568242c6fd89714672820d0526376886e4ca6efe";

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
};
const writeCanonical = (path: string, value: unknown) =>
  writeFileSync(path, `${JSON.stringify(canonicalize(value), null, 2)}\n`);

async function runMigration(dataDir: string): Promise<{ stdout: string; stderr: string }> {
  return execFileP(process.execPath, [
    "--import", "tsx", "scripts/import-exam-corpus.ts",
    "--manifest", "data/ebsi-exam-manifest.json",
    "--data-dir", dataDir,
    "--commit",
    "--migrate-existing", "ebsi:5695028",
    "--expect-receipt-sha256", oldReceiptSha,
  ], { cwd: repository, timeout: 30_000 });
}

async function runNormalReplay(dataDir: string): Promise<{ stdout: string; stderr: string }> {
  const manifest = JSON.parse(readFileSync(join(sourceData, "ebsi-exam-manifest.json"), "utf8"));
  const path = join(dataDir, "single-entry-manifest.json");
  writeFileSync(path, JSON.stringify({
    schemaVersion: 2,
    entries: manifest.entries.filter((entry: { id: string }) => entry.id === "ebsi:5695028"),
  }));
  return execFileP(process.execPath, [
    "--import", "tsx", "scripts/import-exam-corpus.ts",
    "--manifest", path, "--data-dir", dataDir, "--commit",
  ], { cwd: repository, timeout: 30_000 });
}

async function prepareOldSnapshot(root: string): Promise<{ stateDir: string; receiptPath: string }> {
  const sourceState = join(sourceData, "import-exam-corpus", token);
  const stateDir = join(root, "import-exam-corpus", token);
  mkdirSync(join(root, "import-exam-corpus"), { recursive: true });
  cpSync(sourceState, stateDir, { recursive: true });
  mkdirSync(join(root, "files", "corpus"), { recursive: true });
  cpSync(
    join(sourceData, "files", "corpus", token),
    join(root, "files", "corpus", token),
    { recursive: true }
  );
  const planDir = join(stateDir, "migration-plans");
  const planName = existsSync(planDir)
    ? readdirSync(planDir).find((name) => /^v1-[a-f0-9]{64}\.json$/u.test(name))
    : undefined;
  if (planName) {
    const plan = JSON.parse(readFileSync(join(planDir, planName), "utf8"));
    const sourceBackup = join(sourceData, plan.backup.path);
    const targetBackup = join(root, plan.backup.path);
    mkdirSync(resolve(targetBackup, ".."), { recursive: true });
    cpSync(sourceBackup, targetBackup);
    cpSync(sourceBackup, join(root, "studywork.db"));
    const history = JSON.parse(readFileSync(
      join(stateDir, "receipt-history", `v1-${oldReceiptSha}.json`), "utf8"
    ));
    writeCanonical(join(stateDir, "receipt.json"), history.receipt.value);
    rmSync(join(stateDir, "migration-commits"), { recursive: true, force: true });
    rmSync(join(stateDir, "answer-attestation"), { recursive: true, force: true });
  } else {
    const source = new Database(join(sourceData, "studywork.db"), { readonly: true, fileMustExist: true });
    try {
      await source.backup(join(root, "studywork.db"));
    } finally {
      source.close();
    }
    expect(sha256(join(stateDir, "receipt.json"))).toBe(oldReceiptSha);
  }
  return { stateDir, receiptPath: join(stateDir, "receipt.json") };
}

function restoreOldReceipt(stateDir: string, receiptPath: string): void {
  const history = JSON.parse(readFileSync(
    join(stateDir, "receipt-history", `v1-${oldReceiptSha}.json`), "utf8"
  ));
  writeCanonical(receiptPath, history.receipt.value);
}

describe("existing corpus migration v1", () => {
  it("requires one exact allowlisted commit target", () => {
    const base = ["--manifest", "data/ebsi-exam-manifest.json"];
    expect(() => cliOptions([...base, "--migrate-existing", "ebsi:5695028"]))
      .toThrow("함께 지정");
    expect(() => cliOptions([
      ...base, "--migrate-existing", "ebsi:5695028", "--expect-receipt-sha256", oldReceiptSha,
    ])).toThrow("--commit");
    expect(cliOptions([
      ...base, "--commit", "--migrate-existing", "ebsi:5695028",
      "--expect-receipt-sha256", oldReceiptSha,
    ])).toMatchObject({ migrateExisting: "ebsi:5695028", expectedReceiptSha256: oldReceiptSha });
    expect(EXISTING_CORPUS_MIGRATION_ALLOWLIST[0]).toMatchObject({
      entryId: "ebsi:5695028",
      beforeProjectionHash: "58512b2d03488e009d80064082d7b230fdd1acefeea12401ca2572b670e6c996",
      afterProjectionHash: "1bedcd46e0c24a5138cd6213708680754caba6b1ae2ffed98cdd167d7a47e6f1",
      newKeys: ["10:26"],
    });
    expect(() => selectExistingMigrationPlan([{
      identity: { entryId: "ebsi:stale", oldReceipt: { sha256: oldReceiptSha } },
    }], "ebsi:5695028", oldReceiptSha)).toThrow("충돌");
  });

  it("requires the same MCQ ordinal and normalized selected choice", () => {
    const old = {
      id: 1,
      src_page: 1,
      printed_number: "1",
      qtype: "mcq",
      answer: "④",
      choices: JSON.stringify(["① 1", "② 2", "③ 3", "④ $4$", "⑤ 5"]),
    };
    const current = {
      number: "1",
      printedNumber: "1",
      qtype: "mcq",
      difficulty: "중",
      question: "정답 형식만 바뀐 문항",
      choices: ["① 1", "② 2", "③ 3", "④ 4", "⑤ 5"],
      answer: "",
      explanation: "",
      page: 1,
      figure: false,
      figure_description: null,
      box: null,
      officialAnswer: "4",
      officialExplanation: "4이다.",
      solutionPage: 1,
      targetSubject: "수학 - 수학Ⅰ·대수",
      classification: {
        key: "1:1", decision: "accept", canonical_subject: "math_B", curriculum_course: "대수",
        domain: "수와 연산", achievement_codes: ["12대수01-01"], confidence: 1,
        reason_codes: [], transcription_status: "exact", transcription_evidence: "exact",
      },
    } satisfies ImportedQuestion;
    expect(() => assertMigrationAnswerEquivalent(old, current)).not.toThrow();
    expect(() => assertMigrationAnswerEquivalent(old, {
      ...current,
      choices: ["① 1", "② 2", "③ 3", "④ 9", "⑤ 5"],
      officialAnswer: "④",
    })).toThrow("보기 내용");
  });

  it("migrates 5695028 once and resumes OLD/NEW filesystem phases", async () => {
    const root = mkdtempSync(join(tmpdir(), "studywork-existing-migration-"));
    try {
      const { stateDir, receiptPath } = await prepareOldSnapshot(root);
      const originalOldDb = join(root, "original-old.db");
      cpSync(join(root, "studywork.db"), originalOldDb);
      const first = await runMigration(root);
      expect(first.stdout).toContain("existing ebsi:5695028 14");
      const plans = readdirSync(join(stateDir, "migration-plans")).filter((name) => name.endsWith(".json"));
      expect(plans).toHaveLength(1);
      const plan = JSON.parse(readFileSync(join(stateDir, "migration-plans", plans[0]), "utf8"));
      expect(plan.identity.beforeProjectionHash).toBe(
        "58512b2d03488e009d80064082d7b230fdd1acefeea12401ca2572b670e6c996"
      );
      expect(plan.identity.afterProjectionHash).toBe(
        "1bedcd46e0c24a5138cd6213708680754caba6b1ae2ffed98cdd167d7a47e6f1"
      );
      expect(plan.identity.operations.questionInserts).toHaveLength(1);
      expect(plan.identity.operations.itemInserts).toHaveLength(2);
      expect(plan.identity.receiptCore.sha256).toBe(receiptCoreSha);
      expect(sha256(receiptPath)).toBe(plan.finalReceipt.sha256);
      const finalReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      const { migration, ...receiptCore } = finalReceipt;
      expect(canonicalEvidenceHash(receiptCore)).toBe(receiptCoreSha);
      expect(migration).toEqual({
        version: 1,
        previousReceipt: plan.identity.receiptHistory,
        plan: { path: `migration-plans/v1-${plan.basisDigest}.json`, basisDigest: plan.basisDigest },
        oldProjectionHash: plan.identity.beforeProjectionHash,
        newProjectionHash: plan.identity.afterProjectionHash,
        receiptCoreSha256: receiptCoreSha,
      });
      expect(existsSync(join(root, plan.backup.path))).toBe(true);
      expect(existsSync(`${join(root, plan.backup.path)}-wal`)).toBe(false);
      expect(existsSync(`${join(root, plan.backup.path)}-shm`)).toBe(false);
      expect(readdirSync(join(stateDir, "migration-commits")).filter((name) => name.endsWith(".json")))
        .toHaveLength(1);

      let db = new Database(join(root, "studywork.db"), { readonly: true });
      try {
        expect(db.pragma("quick_check", { simple: true })).toBe("ok");
        const q26 = db.prepare(
          "SELECT difficulty, question, answer, src_page FROM questions WHERE book_id = 101 AND printed_number = '26'"
        ).all();
        expect(q26).toEqual([{
          difficulty: "중",
          question: "곡선 $y=6x^2-12x$와 $x$축으로 둘러싸인 부분의 넓이를 구하시오. $[4점]$",
          answer: "8",
          src_page: 10,
        }]);
      } finally {
        db.close();
      }

      rmSync(join(stateDir, "migration-plans"), { recursive: true, force: true });
      rmSync(join(stateDir, "migration-commits"), { recursive: true, force: true });
      rmSync(join(stateDir, "answer-attestation"), { recursive: true, force: true });
      cpSync(originalOldDb, join(root, "studywork.db"));
      restoreOldReceipt(stateDir, receiptPath);
      const resumedAfterBackup = await runMigration(root);
      expect(resumedAfterBackup.stdout).toContain("existing ebsi:5695028 14");
      expect(readdirSync(join(stateDir, "migration-plans"))).toEqual(plans);

      rmSync(join(stateDir, "migration-commits"), { recursive: true, force: true });
      rmSync(join(stateDir, "answer-attestation"), { recursive: true, force: true });
      const resumedAfterReceipt = await runMigration(root);
      expect(resumedAfterReceipt.stdout).toContain("existing ebsi:5695028 14");
      expect(readdirSync(join(stateDir, "migration-commits")).filter((name) => name.endsWith(".json")))
        .toHaveLength(1);

      rmSync(join(stateDir, "migration-commits"), { recursive: true, force: true });
      rmSync(join(stateDir, "answer-attestation"), { recursive: true, force: true });
      restoreOldReceipt(stateDir, receiptPath);
      expect(sha256(receiptPath)).toBe(oldReceiptSha);
      db = new Database(join(root, "studywork.db"));
      try {
        const q26 = db.prepare(
          "SELECT id FROM questions WHERE book_id = 101 AND printed_number = '26'"
        ).get() as { id: number };
        db.prepare("UPDATE questions SET correct_count = 1, wrong_count = 1 WHERE id = ?").run(q26.id);
        db.prepare(
          "INSERT INTO question_attempts (question_id, attempt_id, correct) VALUES (?, 'before-receipt', 0)"
        ).run(q26.id);
      } finally {
        db.close();
      }
      const resumedNewDb = await runMigration(root);
      expect(resumedNewDb.stdout).toContain("existing ebsi:5695028 14");
      expect(sha256(receiptPath)).toBe(plan.finalReceipt.sha256);
      db = new Database(join(root, "studywork.db"), { readonly: true });
      try {
        expect((db.prepare("SELECT COUNT(*) AS count FROM question_attempts WHERE attempt_id = 'before-receipt'")
          .get() as { count: number }).count).toBe(1);
      } finally {
        db.close();
      }

      cpSync(join(root, plan.backup.path), join(root, "studywork.db"));
      await expect(runMigration(root)).rejects.toMatchObject({
        stderr: expect.stringContaining("migration 완료 DB stable projection이 다릅니다"),
      });
      rmSync(join(stateDir, "migration-commits"), { recursive: true, force: true });
      rmSync(join(stateDir, "answer-attestation"), { recursive: true, force: true });
      restoreOldReceipt(stateDir, receiptPath);
      db = new Database(join(root, "studywork.db"));
      try {
        db.prepare("UPDATE sqlite_sequence SET seq = seq + 1 WHERE name = 'questions'").run();
      } finally {
        db.close();
      }
      await expect(runMigration(root)).rejects.toMatchObject({
        stderr: expect.stringContaining("allocator sequence"),
      });
      cpSync(join(root, plan.backup.path), join(root, "studywork.db"));
      const resumedOldDb = await runMigration(root);
      expect(resumedOldDb.stdout).toContain("existing ebsi:5695028 14");
      expect(sha256(receiptPath)).toBe(plan.finalReceipt.sha256);

      db = new Database(join(root, "studywork.db"));
      try {
        const q26 = db.prepare(
          "SELECT id FROM questions WHERE book_id = 101 AND printed_number = '26'"
        ).get() as { id: number };
        db.prepare(
          "UPDATE questions SET correct_count = 2, wrong_count = 1, from_wrong_note = 1 WHERE id = ?"
        ).run(q26.id);
        db.prepare(
          "INSERT INTO question_attempts (question_id, attempt_id, correct) VALUES (?, 'migration-test', 1)"
        ).run(q26.id);
        db.prepare(
          "UPDATE book_files SET progress = 77, retry_chunk_count = 2, answer_key_pages = '[1]', " +
          "answer_key_scan_complete = 1 WHERE id = 148"
        ).run();
      } finally {
        db.close();
      }
      const replayAfterUse = await runMigration(root);
      expect(replayAfterUse.stdout).toContain("existing ebsi:5695028 14");
      const normalReplay = await runNormalReplay(root);
      expect(normalReplay.stdout).toContain("existing ebsi:5695028 14");
      db = new Database(join(root, "studywork.db"), { readonly: true });
      try {
        expect(db.prepare(
          "SELECT correct_count, wrong_count, from_wrong_note FROM questions WHERE book_id = 101 AND printed_number = '26'"
        ).get()).toEqual({ correct_count: 2, wrong_count: 1, from_wrong_note: 1 });
        expect((db.prepare("SELECT COUNT(*) AS count FROM question_attempts WHERE attempt_id = 'migration-test'")
          .get() as { count: number }).count).toBe(1);
        expect(db.prepare(
          "SELECT progress, retry_chunk_count, answer_key_pages, answer_key_scan_complete FROM book_files WHERE id = 148"
        ).get()).toEqual({
          progress: 77, retry_chunk_count: 2, answer_key_pages: "[1]", answer_key_scan_complete: 1,
        });
      } finally {
        db.close();
      }

      const tampered = structuredClone(plan);
      tampered.identity.operations.questionUpdates[0].after.question = "tampered";
      tampered.identity.afterProjection.questions[0].question = "tampered";
      tampered.identity.afterProjectionHash = canonicalEvidenceHash(tampered.identity.afterProjection);
      tampered.identity.stableAfterProjectionHash = stableMigrationProjectionHash(tampered.identity.afterProjection);
      tampered.basisDigest = canonicalEvidenceHash(tampered.identity);
      tampered.finalReceipt.value.migration.plan = {
        path: `migration-plans/v1-${tampered.basisDigest}.json`,
        basisDigest: tampered.basisDigest,
      };
      tampered.finalReceipt.value.migration.newProjectionHash = tampered.identity.afterProjectionHash;
      tampered.finalReceipt.sha256 = canonicalEvidenceHash(tampered.finalReceipt.value);
      tampered.backup.path = `backups/exam-corpus-migration-v1-${token}-${tampered.basisDigest}.db`;
      db = new Database(join(root, "studywork.db"));
      try {
        expect(() => applyExistingCorpusMigrationPlan(db, tampered)).toThrow("allowlist");
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("refuses a changed approved OLD projection before any DB migration write", async () => {
    const root = mkdtempSync(join(tmpdir(), "studywork-existing-migration-tamper-"));
    try {
      const { stateDir, receiptPath } = await prepareOldSnapshot(root);
      const db = new Database(join(root, "studywork.db"));
      try {
        db.prepare("UPDATE questions SET question = 'user changed' WHERE id = 3214").run();
      } finally {
        db.close();
      }
      await expect(runMigration(root)).rejects.toMatchObject({
        stderr: expect.stringContaining("승인 DB projection이 다릅니다"),
      });
      expect(sha256(receiptPath)).toBe(oldReceiptSha);
      expect(existsSync(join(stateDir, "receipt-history"))).toBe(false);
      expect(existsSync(join(stateDir, "migration-plans"))).toBe(false);
      expect(existsSync(join(root, "backups"))).toBe(false);
      const verify = new Database(join(root, "studywork.db"), { readonly: true });
      try {
        expect((verify.prepare("SELECT question FROM questions WHERE id = 3214").get() as { question: string }).question)
          .toBe("user changed");
      } finally {
        verify.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("refuses missing or changed linked PDF evidence before sidecars or DB writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "studywork-existing-migration-linked-"));
    try {
      const { stateDir, receiptPath } = await prepareOldSnapshot(root);
      const dbHash = sha256(join(root, "studywork.db"));
      writeFileSync(join(root, "files", "corpus", token, "4938012488867f83", "problem.pdf"), "tampered");
      await expect(runMigration(root)).rejects.toMatchObject({
        stderr: expect.stringContaining("linked problem evidence"),
      });
      expect(sha256(join(root, "studywork.db"))).toBe(dbHash);
      expect(sha256(receiptPath)).toBe(oldReceiptSha);
      expect(existsSync(join(stateDir, "receipt-history"))).toBe(false);
      expect(existsSync(join(stateDir, "migration-plans"))).toBe(false);
      expect(existsSync(join(root, "backups"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("refuses linked PDF evidence reached through an escaping parent symlink", async () => {
    const root = mkdtempSync(join(tmpdir(), "studywork-existing-migration-linked-parent-"));
    const outside = mkdtempSync(join(tmpdir(), "studywork-existing-migration-linked-outside-"));
    try {
      const { stateDir, receiptPath } = await prepareOldSnapshot(root);
      const dbHash = sha256(join(root, "studywork.db"));
      const linkedRoot = join(root, "files", "corpus", token);
      cpSync(linkedRoot, join(outside, token), { recursive: true });
      rmSync(linkedRoot, { recursive: true, force: true });
      symlinkSync(join(outside, token), linkedRoot);
      await expect(runMigration(root)).rejects.toMatchObject({
        stderr: expect.stringContaining("realpath가 root 밖입니다"),
      });
      expect(sha256(join(root, "studywork.db"))).toBe(dbHash);
      expect(sha256(receiptPath)).toBe(oldReceiptSha);
      expect(existsSync(join(stateDir, "receipt-history"))).toBe(false);
      expect(existsSync(join(root, "backups"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }, 120_000);

  it("refuses migration state directory symlinks before DB or outside writes", async () => {
    for (const name of ["migration-plans", "receipt-history", "migration-commits"] as const) {
      const root = mkdtempSync(join(tmpdir(), `studywork-existing-migration-${name}-`));
      const outside = mkdtempSync(join(tmpdir(), "studywork-existing-migration-state-outside-"));
      try {
        const { stateDir, receiptPath } = await prepareOldSnapshot(root);
        const dbHash = sha256(join(root, "studywork.db"));
        rmSync(join(stateDir, name), { recursive: true, force: true });
        symlinkSync(outside, join(stateDir, name));
        await expect(runMigration(root)).rejects.toMatchObject({
          stderr: expect.stringContaining(`${name}가 regular directory가 아닙니다`),
        });
        expect(readdirSync(outside)).toEqual([]);
        expect(sha256(join(root, "studywork.db"))).toBe(dbHash);
        expect(sha256(receiptPath)).toBe(oldReceiptSha);
        expect(existsSync(join(root, "backups"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it("refuses a backups symlink without writing the external target", async () => {
    const root = mkdtempSync(join(tmpdir(), "studywork-existing-migration-backup-link-"));
    const outside = mkdtempSync(join(tmpdir(), "studywork-existing-migration-outside-"));
    try {
      const { stateDir, receiptPath } = await prepareOldSnapshot(root);
      const dbHash = sha256(join(root, "studywork.db"));
      symlinkSync(outside, join(root, "backups"));
      await expect(runMigration(root)).rejects.toMatchObject({
        stderr: expect.stringContaining("backups directory가 regular directory가 아닙니다"),
      });
      expect(readdirSync(outside)).toEqual([]);
      expect(sha256(join(root, "studywork.db"))).toBe(dbHash);
      expect(sha256(receiptPath)).toBe(oldReceiptSha);
      expect(existsSync(join(stateDir, "receipt-history"))).toBe(false);
      expect(existsSync(join(stateDir, "migration-plans"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }, 120_000);
});
