import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
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

function stateSnapshot(directory: string): Array<[string, string, string]> {
  const snapshot: Array<[string, string, string]> = [];
  const visit = (path: string, prefix: string) => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(child);
      if (stat.isSymbolicLink()) snapshot.push([relative, "symlink", readlinkSync(child)]);
      else if (stat.isDirectory()) visit(child, relative);
      else snapshot.push([relative, "file", sha256(child)]);
    }
  };
  visit(directory, "");
  return snapshot;
}

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

async function runNormalReplay(
  dataDir: string,
  entryId = "ebsi:5695028"
): Promise<{ stdout: string; stderr: string }> {
  const manifest = JSON.parse(readFileSync(join(sourceData, "ebsi-exam-manifest.json"), "utf8"));
  const path = join(dataDir, "single-entry-manifest.json");
  writeFileSync(path, JSON.stringify({
    schemaVersion: 2,
    entries: manifest.entries.filter((entry: { id: string }) => entry.id === entryId),
  }));
  return execFileP(process.execPath, [
    "--import", "tsx", "scripts/import-exam-corpus.ts",
    "--manifest", path, "--data-dir", dataDir, "--commit",
  ], {
    cwd: repository,
    timeout: 30_000,
    env: { ...process.env, STUDYWORK_CODEX_BIN: "/usr/bin/false" },
  });
}

type SameKeyMigrationCase = {
  entryId: string;
  entryToken: string;
  oldReceiptSha256: string;
  beforeProjectionHash: string;
  afterProjectionHash: string;
  stableAfterProjectionHash: string;
  accepted: number;
};

async function prepareSameKeySnapshot(root: string, migration: SameKeyMigrationCase): Promise<string> {
  const sourceState = join(sourceData, "import-exam-corpus", migration.entryToken);
  const stateDir = join(root, "import-exam-corpus", migration.entryToken);
  mkdirSync(join(root, "import-exam-corpus"), { recursive: true });
  cpSync(sourceState, stateDir, { recursive: true });
  mkdirSync(join(root, "files", "corpus"), { recursive: true });
  cpSync(
    join(sourceData, "files", "corpus", migration.entryToken),
    join(root, "files", "corpus", migration.entryToken),
    { recursive: true }
  );
  const planDirectory = join(stateDir, "migration-plans");
  const planName = existsSync(planDirectory)
    ? readdirSync(planDirectory).find((name) => /^v1-[a-f0-9]{64}\.json$/u.test(name))
    : undefined;
  if (planName) {
    const plan = JSON.parse(readFileSync(join(planDirectory, planName), "utf8"));
    cpSync(join(sourceData, plan.backup.path), join(root, "studywork.db"));
    const history = JSON.parse(readFileSync(
      join(stateDir, "receipt-history", `v1-${migration.oldReceiptSha256}.json`),
      "utf8"
    ));
    writeCanonical(join(stateDir, "receipt.json"), history.receipt.value);
    for (const path of [
      "migration-plans", "receipt-history", "migration-commits", "answer-attestation",
    ]) rmSync(join(stateDir, path), { recursive: true, force: true });
    rmSync(join(root, "backups"), { recursive: true, force: true });
  } else {
    const source = new Database(join(sourceData, "studywork.db"), { readonly: true, fileMustExist: true });
    try {
      await source.backup(join(root, "studywork.db"));
    } finally {
      source.close();
    }
  }
  expect(sha256(join(stateDir, "receipt.json"))).toBe(migration.oldReceiptSha256);
  return stateDir;
}

async function runSameKeyMigration(dataDir: string, migration: SameKeyMigrationCase) {
  return execFileP(process.execPath, [
    "--import", "tsx", "scripts/import-exam-corpus.ts",
    "--manifest", "data/ebsi-exam-manifest.json",
    "--data-dir", dataDir,
    "--commit",
    "--migrate-existing", migration.entryId,
    "--expect-receipt-sha256", migration.oldReceiptSha256,
  ], {
    cwd: repository,
    timeout: 30_000,
    env: { ...process.env, STUDYWORK_CODEX_BIN: "/usr/bin/false" },
  });
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
    cpSync(sourceBackup, join(root, "studywork.db"));
    const history = JSON.parse(readFileSync(
      join(stateDir, "receipt-history", `v1-${oldReceiptSha}.json`), "utf8"
    ));
    writeCanonical(join(stateDir, "receipt.json"), history.receipt.value);
    rmSync(join(stateDir, "migration-plans"), { recursive: true, force: true });
    rmSync(join(stateDir, "receipt-history"), { recursive: true, force: true });
    rmSync(join(stateDir, "migration-commits"), { recursive: true, force: true });
    rmSync(join(stateDir, "answer-attestation"), { recursive: true, force: true });
    rmSync(join(root, "backups"), { recursive: true, force: true });
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
    expect(EXISTING_CORPUS_MIGRATION_ALLOWLIST.map((spec) => spec.entryId)).toEqual([
      "ebsi:5695028",
      "ebsi:5734412",
      "ebsi:5696440",
      "ebsi:5854175",
      "ebsi:5525983",
      "ebsi:5578422",
      "ebsi:5853840",
      "ebsi:5853841",
      "ebsi:5642949",
      "ebsi:5642950",
      "ebsi:5734413",
      "ebsi:5656592",
      "ebsi:5577055",
      "ebsi:5594500",
      "ebsi:5525984",
      "ebsi:5594501",
      "ebsi:5769268",
      "ebsi:5875877",
      "ebsi:5578423",
      "ebsi:5772823",
      "ebsi:5525982",
    ]);
    expect(canonicalEvidenceHash(EXISTING_CORPUS_MIGRATION_ALLOWLIST))
      .toBe("0c6efd85302d9cf50e390df5281b78e7995314dac351e2005dc4da20947128a2");
    expect(EXISTING_CORPUS_MIGRATION_ALLOWLIST.filter((spec) =>
      !["ebsi:5695028", "ebsi:5853841", "ebsi:5577055", "ebsi:5525984"].includes(spec.entryId)
    ).every((spec) =>
      spec.newKeys.length === 0 && spec.newQuestions.length === 0
    )).toBe(true);
    expect(EXISTING_CORPUS_MIGRATION_ALLOWLIST.find((spec) => spec.entryId === "ebsi:5853841"))
      .toMatchObject({
        newKeys: ["1:2"],
        newQuestions: [{
          key: "1:2",
          targetSubject: "수학 - 수학Ⅰ·대수",
          qtype: "mcq",
          difficulty: "하",
          question: "$\\sqrt{4}\\times\\sqrt[3]{8}$의 값은? [2점]",
          answer: "①",
          solutionPage: 1,
        }],
      });
    expect(EXISTING_CORPUS_MIGRATION_ALLOWLIST.find((spec) => spec.entryId === "ebsi:5656592"))
      .toMatchObject({
        entryToken: "c83035d36ef8d2b8f1bfe856",
        oldReceiptSha256: "39a7e7a753e8c29d9dae9bde1707fc3cab85f6614e21b8d26f46e81873874b7e",
        beforeProjectionHash: "a3305a7556bb63f334cf825e3ca14007b4a310cbb30e20595dd76d7e6ea7ee88",
        afterProjectionHash: "7e14938c29994f017201b9246298d1f4f3aec79c8b2a98b4e95b1a32e810244f",
        newKeys: [],
        newQuestions: [],
      });
    const koreanMigration = EXISTING_CORPUS_MIGRATION_ALLOWLIST.find((spec) => spec.entryId === "ebsi:5525982")!;
    expect(koreanMigration).toMatchObject({
      receiptCoreSha256: "7e2a247ab9d1e4bed7db8fdd56486cc25b68441ac1213a8cee69391917dabf48",
      beforeProjectionHash: "460b040f3fe396e3cf4086d94132c77db66fd1b46a3498fa44afde2b03384a81",
      afterProjectionHash: "7e981e83d9a81a2cb07f603ecbc6dfdb6ae7df590b492e5e5ab12851e817647a",
      newKeys: [],
      newQuestions: [],
    });
    expect(koreanMigration.answerChoiceRevisions).toHaveLength(10);
    expect(canonicalEvidenceHash(koreanMigration.answerChoiceRevisions))
      .toBe("994bf57c028f32483050547cefa5baba67d2ec831e953318b86f7702fba600e3");
    expect(() => selectExistingMigrationPlan([{
      identity: { entryId: "ebsi:stale", oldReceipt: { sha256: oldReceiptSha } },
    }], "ebsi:5695028", oldReceiptSha)).toThrow("충돌");
  });

  it.each([
    {
      entryId: "ebsi:5734412",
      entryToken: "514652aa98da96737758368d",
      oldReceiptSha256: "d8c827753975f333c387db90d17e70b9b5e7cb363730d2e602bb2c4f3176cfc0",
      beforeProjectionHash: "fb8e8647745924db4fc46cbb3bd4dd61c0bb61bf557e7c195f83d7b406f0da4a",
      afterProjectionHash: "74648286834d0b62394055b9c5b15b850aa11282428b3b0d4534e75fea664c46",
      stableAfterProjectionHash: "c051b070db01d451b4b03c923febc9873fd2c5cc782676fbebcdaa641546baeb",
      accepted: 1,
    },
    {
      entryId: "ebsi:5854175",
      entryToken: "231f0e1a573a042551a8df8e",
      oldReceiptSha256: "cbfd646f22cecc50485180b15432bdc8c0f062094d1f351180506f8707795af9",
      beforeProjectionHash: "a12af7f2fc6f49314dc30532b7421ce34b1f430436964b763cc67bb3547d6338",
      afterProjectionHash: "21e9dd2731d0ffbd97b595333e5367224e59f5ae108ead4914c83e76ea1507a7",
      stableAfterProjectionHash: "489d4d6831de6abc37cc052e3ef5db730821a4a3a270a955441bfd004fca243f",
      accepted: 7,
    },
    {
      entryId: "ebsi:5734413",
      entryToken: "b43e38e9dede643a532780cc",
      oldReceiptSha256: "d73c2e712fbb9ccb9a4e6e1e8a7e903805b9bd98490822d67311dae50bf3f7e6",
      beforeProjectionHash: "8f5e2071cc49d696ec04506774a702fcaf86c3b29bd7053a01c8c4a6a398c2aa",
      afterProjectionHash: "cfc32af3a65c21749b53dc1ca1e8ac85233a9387bb5f5b607269e655ae39d425",
      stableAfterProjectionHash: "26dc5162061716a98b85a3d22468a0c92c3d897d95eaa11b39c26cc2878acb1e",
      accepted: 12,
    },
    {
      entryId: "ebsi:5525982",
      entryToken: "bb876a67170089dfb2022f47",
      oldReceiptSha256: "7e2a247ab9d1e4bed7db8fdd56486cc25b68441ac1213a8cee69391917dabf48",
      beforeProjectionHash: "460b040f3fe396e3cf4086d94132c77db66fd1b46a3498fa44afde2b03384a81",
      afterProjectionHash: "7e981e83d9a81a2cb07f603ecbc6dfdb6ae7df590b492e5e5ab12851e817647a",
      stableAfterProjectionHash: "151811cfa19fadbcc99381123df01916c0c6008653b0173efef189f7e32d0317",
      accepted: 30,
    },
  ] satisfies SameKeyMigrationCase[])(
    "migrates $entryId from persisted authority without AI",
    async (migration) => {
      const root = mkdtempSync(join(tmpdir(), "studywork-same-key-migration-"));
      try {
        const stateDir = await prepareSameKeySnapshot(root, migration);
        const first = await runSameKeyMigration(root, migration);
        expect(first.stdout).toContain(`existing ${migration.entryId} ${migration.accepted}`);
        const planName = readdirSync(join(stateDir, "migration-plans"))
          .find((name) => /^v1-[a-f0-9]{64}\.json$/u.test(name))!;
        const plan = JSON.parse(readFileSync(join(stateDir, "migration-plans", planName), "utf8"));
        expect(plan.identity).toMatchObject({
          beforeProjectionHash: migration.beforeProjectionHash,
          afterProjectionHash: migration.afterProjectionHash,
          stableAfterProjectionHash: migration.stableAfterProjectionHash,
        });
        expect(plan.identity.operations.questionInserts).toHaveLength(0);
        expect(plan.identity.operations.itemInserts).toHaveLength(0);
        expect(plan.identity.operations.questionUpdates).toHaveLength(migration.accepted);
        expect(plan.identity.operations.itemUpdates).toHaveLength(migration.accepted * 2);
        const replay = await runSameKeyMigration(root, migration);
        expect(replay.stdout).toContain(`existing ${migration.entryId} ${migration.accepted}`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    120_000
  );

  it("migrates 5656592 from the exact current audit and replays without AI", async () => {
    const migration = {
      entryId: "ebsi:5656592",
      entryToken: "c83035d36ef8d2b8f1bfe856",
      oldReceiptSha256: "39a7e7a753e8c29d9dae9bde1707fc3cab85f6614e21b8d26f46e81873874b7e",
      beforeProjectionHash: "a3305a7556bb63f334cf825e3ca14007b4a310cbb30e20595dd76d7e6ea7ee88",
      afterProjectionHash: "7e14938c29994f017201b9246298d1f4f3aec79c8b2a98b4e95b1a32e810244f",
      stableAfterProjectionHash: "c252907104678e4473da17a3fc3f2810745f36645f1400af5ff203e72901bb21",
      accepted: 4,
    } satisfies SameKeyMigrationCase;
    const root = mkdtempSync(join(tmpdir(), "studywork-5656592-migration-"));
    try {
      const stateDir = await prepareSameKeySnapshot(root, migration);
      const receiptPath = join(stateDir, "receipt.json");
      const beforeGuard = { db: sha256(join(root, "studywork.db")), receipt: sha256(receiptPath) };
      await expect(runNormalReplay(root, migration.entryId)).rejects.toMatchObject({
        stderr: expect.stringContaining("기존 importer 문항이 변경되었거나 일부 삭제되었습니다"),
      });
      expect({ db: sha256(join(root, "studywork.db")), receipt: sha256(receiptPath) }).toEqual(beforeGuard);
      expect(existsSync(join(stateDir, "migration-plans"))).toBe(false);
      expect(existsSync(join(stateDir, "receipt-history"))).toBe(false);

      const first = await runSameKeyMigration(root, migration);
      expect(first.stdout).toContain("existing ebsi:5656592 4");
      const planName = readdirSync(join(stateDir, "migration-plans"))
        .find((name) => /^v1-[a-f0-9]{64}\.json$/u.test(name))!;
      const planPath = join(stateDir, "migration-plans", planName);
      const plan = JSON.parse(readFileSync(planPath, "utf8"));
      expect(plan.identity).toMatchObject({
        beforeProjectionHash: migration.beforeProjectionHash,
        afterProjectionHash: migration.afterProjectionHash,
        stableAfterProjectionHash: migration.stableAfterProjectionHash,
        ownership: {
          bookIds: [130],
          fileIds: [208, 209],
          beforeQuestionIds: [3487, 3488, 3489, 3490],
          afterQuestionIds: [3487, 3488, 3489, 3490],
          beforeBookItemIds: [7504, 7505, 7506, 7507, 7508, 7509, 7510, 7511],
          afterBookItemIds: [7504, 7505, 7506, 7507, 7508, 7509, 7510, 7511],
        },
      });
      expect(plan.identity.beforeProjection.guards).toEqual({
        attempts: 0,
        materials: 0,
        bookExtractionChunks: 0,
        materialExtractionChunks: 0,
      });
      expect(plan.identity.operations.questionUpdates).toHaveLength(4);
      expect(plan.identity.operations.itemUpdates).toHaveLength(8);
      expect(plan.identity.operations.questionInserts).toHaveLength(0);
      expect(plan.identity.operations.itemInserts).toHaveLength(0);
      for (const operation of plan.identity.operations.questionUpdates) {
        expect(() => assertMigrationAnswerEquivalent(operation.before, {
          qtype: operation.after.qtype,
          choices: operation.after.choices === null ? null : JSON.parse(operation.after.choices),
          officialAnswer: operation.after.answer,
        } as ImportedQuestion)).not.toThrow();
      }
      const artifactHashes = (directory: string) => readdirSync(directory).sort()
        .map((name) => [name, sha256(join(directory, name))]);
      const snapshot = () => ({
        db: sha256(join(root, "studywork.db")),
        receipt: sha256(receiptPath),
        plan: sha256(planPath),
        commits: artifactHashes(join(stateDir, "migration-commits")),
        attestations: artifactHashes(join(stateDir, "answer-attestation")),
      });
      const migrated = snapshot();
      for (let replay = 0; replay < 2; replay++) {
        expect((await runSameKeyMigration(root, migration)).stdout).toContain("existing ebsi:5656592 4");
      }
      expect((await runNormalReplay(root, migration.entryId)).stdout).toContain("existing ebsi:5656592 4");
      expect(snapshot()).toEqual(migrated);

      const db = new Database(join(root, "studywork.db"), { readonly: true, fileMustExist: true });
      try {
        expect(db.pragma("quick_check", { simple: true })).toBe("ok");
        expect((db.prepare("SELECT id FROM questions WHERE book_id = 130 ORDER BY id").all() as Array<{ id: number }>)
          .map(({ id }) => id)).toEqual([3487, 3488, 3489, 3490]);
        expect((db.prepare("SELECT id FROM book_items WHERE book_id = 130 ORDER BY id").all() as Array<{ id: number }>)
          .map(({ id }) => id)).toEqual([7504, 7505, 7506, 7507, 7508, 7509, 7510, 7511]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("adds the source-grounded 5577055 Q5 and replays without AI", async () => {
    const migration = {
      entryId: "ebsi:5577055",
      entryToken: "b4eeaf53cd6024aa180d1f37",
      oldReceiptSha256: "51f5f9415746cfbc8c87bb20bf691ae66ca15e93e4f1ca31a2746c925988bdec",
      beforeProjectionHash: "f9f8d0c5b200aa6e7147ff9a6f5397b04e95f9e4b59062fae64667676f9c5a3b",
      afterProjectionHash: "2fe1f7dbc05af37cf42099082dd1e80ae5fe3e91500c5ec73590b87800931030",
      stableAfterProjectionHash: "e0eed6170c486eb248909bb422905caf569f9246f8b9fa75c5df6e5d796f4947",
      accepted: 6,
    } satisfies SameKeyMigrationCase;
    const root = mkdtempSync(join(tmpdir(), "studywork-5577055-migration-"));
    try {
      const stateDir = await prepareSameKeySnapshot(root, migration);
      const receiptPath = join(stateDir, "receipt.json");
      const beforeGuard = { db: sha256(join(root, "studywork.db")), receipt: sha256(receiptPath) };
      await expect(runNormalReplay(root, migration.entryId)).rejects.toMatchObject({
        stderr: expect.stringContaining("기존 체크포인트와 내용이 다릅니다"),
      });
      expect({ db: sha256(join(root, "studywork.db")), receipt: sha256(receiptPath) }).toEqual(beforeGuard);
      expect(existsSync(join(stateDir, "migration-plans"))).toBe(false);
      expect(existsSync(join(stateDir, "receipt-history"))).toBe(false);

      expect((await runSameKeyMigration(root, migration)).stdout).toContain("existing ebsi:5577055 6");
      const planName = readdirSync(join(stateDir, "migration-plans"))
        .find((name) => /^v1-[a-f0-9]{64}\.json$/u.test(name))!;
      const planPath = join(stateDir, "migration-plans", planName);
      const plan = JSON.parse(readFileSync(planPath, "utf8"));
      expect(plan.identity).toMatchObject({
        receiptCore: {
          sha256: "51d06f30a79670ee20019ac8ed3911d1fac73070170ca9a53a081213279f5bd2",
        },
        answerAudit: {
          path: "answer-audit/v5-393814389a75988dfefa8d34407cb9652bd0700c5e213e1291fc232896047992.json",
          sha256: "956737ec5dfb7bd68bfda2e6b50f72b0af7cde55d29fd99b832bcf245234dfc5",
          effectiveCorpusHash: "8e22bc17f58eb8cc8e9138389ec705646ccdbd8a375cd46d52a8a6c33637cafe",
          effectiveSolutionCorpusHash: "ac739fc7566ed2daeb1740af79c518c336c7c1087f3a6414f360e8eeb8bcf84d",
        },
        beforeProjectionHash: migration.beforeProjectionHash,
        afterProjectionHash: migration.afterProjectionHash,
        stableAfterProjectionHash: migration.stableAfterProjectionHash,
        ownership: {
          bookIds: [131],
          fileIds: [210, 211],
          beforeQuestionIds: [3491, 3492, 3493, 3494, 3495],
          afterQuestionIds: [3491, 3492, 3493, 3494, 3495, 3649],
          beforeBookItemIds: [7512, 7513, 7514, 7515, 7516, 7517, 7518, 7519, 7520, 7521],
          afterBookItemIds: [7512, 7513, 7514, 7515, 7516, 7517, 7518, 7519, 7520, 7521, 7828, 7829],
        },
      });
      expect(plan.identity.beforeProjection.guards).toEqual({
        attempts: 0,
        materials: 0,
        bookExtractionChunks: 0,
        materialExtractionChunks: 0,
      });
      expect(plan.identity.operations.questionUpdates).toHaveLength(5);
      expect(plan.identity.operations.itemUpdates).toHaveLength(10);
      expect(plan.identity.operations.questionInserts).toHaveLength(1);
      expect(plan.identity.operations.itemInserts).toHaveLength(2);
      for (const operation of plan.identity.operations.questionUpdates) {
        expect(() => assertMigrationAnswerEquivalent(operation.before, {
          qtype: operation.after.qtype,
          choices: operation.after.choices === null ? null : JSON.parse(operation.after.choices),
          officialAnswer: operation.after.answer,
        } as ImportedQuestion)).not.toThrow();
      }
      expect(plan.identity.operations.questionInserts[0].after).toMatchObject({
        id: 3649,
        src_page: 2,
        printed_number: "5",
        difficulty: "중",
        question: "좌표평면에서 곡선 $y=a^x$을 직선 $y=x$에 대하여 대칭이동한 곡선이 점 $(2,3)$을 지날 때, 양수 $a$의 값은? [3점]",
        answer: "④ $\\sqrt[3]{2}$",
      });
      expect(plan.identity.operations.itemInserts.map((item: { after: { id: number } }) => item.after.id))
        .toEqual([7828, 7829]);
      const artifactHashes = (directory: string) => readdirSync(directory).sort()
        .map((name) => [name, sha256(join(directory, name))]);
      expect(artifactHashes(join(stateDir, "answer-attestation")).filter(([name]) => name.startsWith("v5-")))
        .toEqual([[
          "v5-3c09e21d193af325204407e66236d298e45df0a73b20a79866026f0ce9dca30b.json",
          "314ee408a54ac59c584eb2b40ea3fd19a59b4db2f74107059159eaaeb6d09e7e",
        ]]);
      const snapshot = () => ({
        db: sha256(join(root, "studywork.db")),
        receipt: sha256(receiptPath),
        plan: sha256(planPath),
        commits: artifactHashes(join(stateDir, "migration-commits")),
        attestations: artifactHashes(join(stateDir, "answer-attestation")),
      });
      const migrated = snapshot();
      for (let replay = 0; replay < 2; replay++) {
        expect((await runSameKeyMigration(root, migration)).stdout).toContain("existing ebsi:5577055 6");
      }
      expect((await runNormalReplay(root, migration.entryId)).stdout).toContain("existing ebsi:5577055 6");
      expect(snapshot()).toEqual(migrated);

      const db = new Database(join(root, "studywork.db"), { readonly: true, fileMustExist: true });
      try {
        expect(db.pragma("quick_check", { simple: true })).toBe("ok");
        expect((db.prepare("SELECT id FROM questions WHERE book_id = 131 ORDER BY id").all() as Array<{ id: number }>)
          .map(({ id }) => id)).toEqual([3491, 3492, 3493, 3494, 3495, 3649]);
        expect((db.prepare("SELECT id FROM book_items WHERE book_id = 131 ORDER BY id").all() as Array<{ id: number }>)
          .map(({ id }) => id)).toEqual([7512, 7513, 7514, 7515, 7516, 7517, 7518, 7519, 7520, 7521, 7828, 7829]);
        expect((db.prepare(
          "SELECT COUNT(*) AS count FROM questions WHERE book_id = 131 AND src_page = 4 AND printed_number = '11'"
        ).get() as { count: number }).count).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it.each([{
    entryId: "ebsi:5594500",
    entryToken: "e9fcb8ccb0af1356a50a6de4",
    oldReceiptSha256: "8a5cfda41b88f36a39634f4136314015e582c8b2331413382421b576f42f356d",
    beforeProjectionHash: "c32e8d057c4f1b6e1398a8af37910670b6d91cd1bf4bb3c01a259c1063c4e0c6",
    afterProjectionHash: "592e077a4415fc7c8e40ffbc220cc6cd8e0234459c4aaa825d26efe9a7257c13",
    stableAfterProjectionHash: "eb2d05696156f56002a20ac6489a3301a10892753d1e42672d38eee1ac721fe1",
    accepted: 3,
    bookIds: [72], fileIds: [92, 93],
    beforeQuestionIds: [2946, 2947, 2948],
    beforeBookItemIds: [6422, 6423, 6424, 6425, 6426, 6427],
  }, {
    entryId: "ebsi:5525984",
    entryToken: "7755c70fefaa45f755086e2b",
    oldReceiptSha256: "b6cbf1e1874d3f996b911f0e2f9507855f5155b58b0dc31ad63b7682870fcb0f",
    beforeProjectionHash: "2c2a65902b4e0c78d35545f25a36a018a8fb61f6386eb85eef95bb4bc1946fce",
    afterProjectionHash: "74a78e48a28f366787238a8e9d901b73821ac7b4a23889002fc3e844ef2429c8",
    stableAfterProjectionHash: "648bdd1108934d0840df9d6e235f7d24b3ad0a4b2688b40cba58e359ae1f15d0",
    accepted: 13,
    bookIds: [133, 134], fileIds: [214, 215, 216, 217],
    beforeQuestionIds: [3504, 3505, 3506, 3507, 3508, 3509, 3510, 3511, 3512, 3513, 3514],
    afterQuestionIds: [3504, 3505, 3506, 3507, 3508, 3509, 3510, 3511, 3512, 3513, 3514, 3650, 3651],
    beforeBookItemIds: [7538, 7539, 7540, 7541, 7542, 7543, 7544, 7545, 7546, 7547, 7548, 7549, 7550, 7551, 7552, 7553, 7554, 7555, 7556, 7557, 7558, 7559],
    afterBookItemIds: [7538, 7539, 7540, 7541, 7542, 7543, 7544, 7545, 7546, 7547, 7548, 7549, 7550, 7551, 7552, 7553, 7554, 7555, 7556, 7557, 7558, 7559, 7830, 7831, 7832, 7833],
  }, {
    entryId: "ebsi:5594501",
    entryToken: "b395aca2790e257b1487b455",
    oldReceiptSha256: "289407874ab8bef65e817189c07e03d55901aa44bee49deff7b9aa523dd907dc",
    beforeProjectionHash: "99c8e405ccbd20c1bfbe76c10a67ceef75b8e3d0335e0edf8317525cd2ee0fe0",
    afterProjectionHash: "834e5ab1c8c5db5e4958c49e3487754ee3de10dc3739c6d8ebe121841ca0e434",
    stableAfterProjectionHash: "c5eb62809e631ac6fde2475b08880022fd504a7ab410c39638f003e5759df23d",
    accepted: 9,
    bookIds: [75, 76], fileIds: [98, 99, 100, 101],
    beforeQuestionIds: [2957, 2958, 2959, 2960, 2961, 2962, 2963, 2964, 2965],
    beforeBookItemIds: [6444, 6445, 6446, 6447, 6448, 6449, 6450, 6451, 6452, 6453, 6454, 6455, 6456, 6457, 6458, 6459, 6460, 6461],
  }, {
    entryId: "ebsi:5769268",
    entryToken: "bc7655b894a573179fae1c73",
    oldReceiptSha256: "e5ab9b993ac780ffb90d8b5f52bc5234a580e68ba69e7fc8000f072a2319dea6",
    beforeProjectionHash: "beff875fcbb5f8b55181fe864243cb84c79bac2c675ad3b1b0cfe11432eff701",
    afterProjectionHash: "22b67b72821fe5099dbd55ef89ce811ba1c7c3f155696e7d82210aa623c2659a",
    stableAfterProjectionHash: "5bccbb7b61ba89b76b983b60f391f4027b7264090afe88798b1e27ab7e0a454d",
    accepted: 13,
    bookIds: [108, 109], fileIds: [164, 165, 166, 167],
    beforeQuestionIds: [3272, 3273, 3274, 3275, 3276, 3277, 3278, 3279, 3280, 3281, 3282, 3283, 3284],
    beforeBookItemIds: [7074, 7075, 7076, 7077, 7078, 7079, 7080, 7081, 7082, 7083, 7084, 7085, 7086, 7087, 7088, 7089, 7090, 7091, 7092, 7093, 7094, 7095, 7096, 7097, 7098, 7099],
  }, {
    entryId: "ebsi:5875877",
    entryToken: "2df36741f509a5d174ef8538",
    oldReceiptSha256: "3f017d124ca92ee3101fc2e79334f57b058b2f00418e2d1e272237b8a38af9ac",
    beforeProjectionHash: "8e2516d4771eb9541d85f378f0b3628aa8399417130b72fa5db3017e161e33ff",
    afterProjectionHash: "77d8e9f47fc9e85eb7cdac32f4c7608932c7a25e102893104aaf1ad3aa64af1f",
    stableAfterProjectionHash: "cb39c754110e6408409e9c04307552c54d190bf4ebf90faa1e3358b9f2ecbf73",
    accepted: 5,
    bookIds: [125], fileIds: [198, 199],
    beforeQuestionIds: [3451, 3452, 3453, 3454, 3455],
    beforeBookItemIds: [7432, 7433, 7434, 7435, 7436, 7437, 7438, 7439, 7440, 7441],
  }, {
    entryId: "ebsi:5578423",
    entryToken: "a8beae02eaa19479bb277017",
    oldReceiptSha256: "99e7fa9f4461bb3617f15a4d150469a2e07ef44fc1c2e0c1c980d32eaa7aad57",
    beforeProjectionHash: "23503a537254ebbe86097a178329946a6dd747122fbe67d557403aebe0aacb21",
    afterProjectionHash: "d876cdad3af19a6f91fd9feafac2c7a1ef374596f3fdad6996932ac471e490b0",
    stableAfterProjectionHash: "1624dda2e68cb2d901732286ac8bb0ad92740856fcde5e13ac4b374453a530c8",
    accepted: 7,
    bookIds: [60], fileIds: [68, 69],
    beforeQuestionIds: [2843, 2844, 2845, 2846, 2847, 2848, 2849],
    beforeBookItemIds: [6216, 6217, 6218, 6219, 6220, 6221, 6222, 6223, 6224, 6225, 6226, 6227, 6228, 6229],
  }, {
    entryId: "ebsi:5772823",
    entryToken: "a6e8dc7eae6679300d9e03e2",
    oldReceiptSha256: "a8371657db6c96eeb34b80740272a6a8d8ae47c464725dc138246bbf2bb64a2f",
    beforeProjectionHash: "7d0a1b53be88801b1c2a2daf2c950799c5ac9f436c4142e685d64f69766d53e0",
    afterProjectionHash: "f72f894947f3fc73d13b6055bda0beafd2f4a78a8c8b8c3c5575fefca2fb1529",
    stableAfterProjectionHash: "7312b1bfbd2d7077ceb5a0a6fe69522a2b0f5442ed1099b58ecb0de0523d4d84",
    accepted: 17,
    bookIds: [110, 111], fileIds: [168, 169, 170, 171],
    beforeQuestionIds: [3285, 3286, 3287, 3288, 3289, 3290, 3291, 3292, 3293, 3294, 3295, 3296, 3297, 3298, 3299, 3300, 3301],
    beforeBookItemIds: [7100, 7101, 7102, 7103, 7104, 7105, 7106, 7107, 7108, 7109, 7110, 7111, 7112, 7113, 7114, 7115, 7116, 7117, 7118, 7119, 7120, 7121, 7122, 7123, 7124, 7125, 7126, 7127, 7128, 7129, 7130, 7131, 7132, 7133],
  }])("migrates $entryId from its exact current audit and replays without AI", async (migration) => {
    const root = mkdtempSync(join(tmpdir(), "studywork-audited-migration-"));
    try {
      const stateDir = await prepareSameKeySnapshot(root, migration);
      const receiptPath = join(stateDir, "receipt.json");
      const beforeGuard = { db: sha256(join(root, "studywork.db")), receipt: sha256(receiptPath) };
      await expect(runNormalReplay(root, migration.entryId)).rejects.toMatchObject({
        stderr: expect.stringContaining(migration.entryId === "ebsi:5525984"
          ? "기존 체크포인트와 내용이 다릅니다"
          : "기존 importer 문항이 변경되었거나 일부 삭제되었습니다"),
      });
      expect({ db: sha256(join(root, "studywork.db")), receipt: sha256(receiptPath) }).toEqual(beforeGuard);
      expect(existsSync(join(stateDir, "migration-plans"))).toBe(false);
      expect(existsSync(join(stateDir, "receipt-history"))).toBe(false);

      expect((await runSameKeyMigration(root, migration)).stdout)
        .toContain(`existing ${migration.entryId} ${migration.accepted}`);
      const planName = readdirSync(join(stateDir, "migration-plans"))
        .find((name) => /^v1-[a-f0-9]{64}\.json$/u.test(name))!;
      const planPath = join(stateDir, "migration-plans", planName);
      const plan = JSON.parse(readFileSync(planPath, "utf8"));
      const spec = EXISTING_CORPUS_MIGRATION_ALLOWLIST.find(({ entryId }) => entryId === migration.entryId)!;
      const afterQuestionIds = (
        "afterQuestionIds" in migration ? migration.afterQuestionIds : undefined
      ) ?? migration.beforeQuestionIds;
      const afterBookItemIds = (
        "afterBookItemIds" in migration ? migration.afterBookItemIds : undefined
      ) ?? migration.beforeBookItemIds;
      expect(plan.identity).toMatchObject({
        receiptCore: { sha256: spec.receiptCoreSha256 },
        answerAudit: {
          path: spec.auditPath,
          sha256: spec.auditSha256,
          effectiveCorpusHash: spec.effectiveCorpusHash,
          effectiveSolutionCorpusHash: spec.effectiveSolutionCorpusHash,
        },
        beforeProjectionHash: migration.beforeProjectionHash,
        afterProjectionHash: migration.afterProjectionHash,
        stableAfterProjectionHash: migration.stableAfterProjectionHash,
        ownership: {
          bookIds: migration.bookIds,
          fileIds: migration.fileIds,
          beforeQuestionIds: migration.beforeQuestionIds,
          afterQuestionIds,
          beforeBookItemIds: migration.beforeBookItemIds,
          afterBookItemIds,
        },
      });
      expect(plan.identity.beforeProjection.guards).toEqual({
        attempts: 0,
        materials: 0,
        bookExtractionChunks: 0,
        materialExtractionChunks: 0,
      });
      expect(plan.identity.operations.questionUpdates).toHaveLength(migration.beforeQuestionIds.length);
      expect(plan.identity.operations.itemUpdates).toHaveLength(migration.beforeBookItemIds.length);
      expect(plan.identity.operations.questionInserts.map(({ after }: { after: { id: number } }) => after.id))
        .toEqual(afterQuestionIds.slice(migration.beforeQuestionIds.length));
      expect(plan.identity.operations.itemInserts.map(({ after }: { after: { id: number } }) => after.id))
        .toEqual(afterBookItemIds.slice(migration.beforeBookItemIds.length));
      for (const operation of plan.identity.operations.questionUpdates) {
        expect(() => assertMigrationAnswerEquivalent(operation.before, {
          qtype: operation.after.qtype,
          choices: operation.after.choices === null ? null : JSON.parse(operation.after.choices),
          officialAnswer: operation.after.answer,
        } as ImportedQuestion)).not.toThrow();
      }

      const artifactHashes = (directory: string) => readdirSync(directory).sort()
        .map((name) => [name, sha256(join(directory, name))]);
      const snapshot = () => ({
        db: sha256(join(root, "studywork.db")),
        receipt: sha256(receiptPath),
        plan: sha256(planPath),
        commits: artifactHashes(join(stateDir, "migration-commits")),
        attestations: artifactHashes(join(stateDir, "answer-attestation")),
      });
      const migrated = snapshot();
      for (let replay = 0; replay < 2; replay++) {
        expect((await runSameKeyMigration(root, migration)).stdout)
          .toContain(`existing ${migration.entryId} ${migration.accepted}`);
      }
      expect((await runNormalReplay(root, migration.entryId)).stdout)
        .toContain(`existing ${migration.entryId} ${migration.accepted}`);
      expect(snapshot()).toEqual(migrated);

      const db = new Database(join(root, "studywork.db"), { readonly: true, fileMustExist: true });
      try {
        expect(db.pragma("quick_check", { simple: true })).toBe("ok");
        const placeholders = migration.bookIds.map(() => "?").join(",");
        expect((db.prepare(`SELECT id FROM questions WHERE book_id IN (${placeholders}) ORDER BY id`)
          .all(...migration.bookIds) as Array<{ id: number }>).map(({ id }) => id)).toEqual(afterQuestionIds);
        expect((db.prepare(`SELECT id FROM book_items WHERE book_id IN (${placeholders}) ORDER BY id`)
          .all(...migration.bookIds) as Array<{ id: number }>).map(({ id }) => id)).toEqual(afterBookItemIds);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("preflights the inert 5578423 historical Q14 recovery before writes or AI", async () => {
    const migration = {
      entryId: "ebsi:5578423",
      entryToken: "a8beae02eaa19479bb277017",
      oldReceiptSha256: "99e7fa9f4461bb3617f15a4d150469a2e07ef44fc1c2e0c1c980d32eaa7aad57",
      beforeProjectionHash: "23503a537254ebbe86097a178329946a6dd747122fbe67d557403aebe0aacb21",
      afterProjectionHash: "d876cdad3af19a6f91fd9feafac2c7a1ef374596f3fdad6996932ac471e490b0",
      stableAfterProjectionHash: "1624dda2e68cb2d901732286ac8bb0ad92740856fcde5e13ac4b374453a530c8",
      accepted: 7,
    } satisfies SameKeyMigrationCase;
    const problemName =
      "v2-0005-0014-128751e9a46e78da7afa65f5cff3c679d694a9704a06fa91c1194f375cfddb3d.json";
    const classificationName =
      "v2-0005-0014-5a76003ddc1f99328f3680768b909e18fbf007f9129950ca31c5d3641463708b-" +
      "7bb7cb863c8c4855.json";
    const currentAuditName =
      "v5-00e94aae43035db62fee1ddb79997058780a54a58b9bcdbe7350ecb36beea814.json";
    const historicalAuditName =
      "v5-841e6f0d22d791454ff7d37e9e702d22c981136e1408f3ef4d3af8f15213f56c.json";
    const cases: Array<{
      label: string;
      mutate: (root: string, stateDir: string) => void;
    }> = [{
      label: "partial recovery signal",
      mutate: (_root, stateDir) => {
        rmSync(join(stateDir, "receipt.json"));
        rmSync(join(stateDir, "answer-audit"), { recursive: true });
        rmSync(join(stateDir, "classification-recoveries"), { recursive: true });
      },
    }, {
      label: "third v5 audit signal only",
      mutate: (_root, stateDir) => {
        const checkpoint = readFileSync(join(stateDir, "answer-audit", historicalAuditName));
        rmSync(join(stateDir, "receipt.json"));
        rmSync(join(stateDir, "problem-recoveries"), { recursive: true });
        rmSync(join(stateDir, "classification-recoveries"), { recursive: true });
        rmSync(join(stateDir, "answer-audit"), { recursive: true });
        mkdirSync(join(stateDir, "answer-audit"));
        writeFileSync(join(stateDir, "answer-audit", `v5-${"0".repeat(64)}.json`), checkpoint);
      },
    }, {
      label: "tampered problem recovery",
      mutate: (_root, stateDir) => {
        const path = join(stateDir, "problem-recoveries", problemName);
        const checkpoint = JSON.parse(readFileSync(path, "utf8"));
        checkpoint.unexpected = true;
        writeCanonical(path, checkpoint);
      },
    }, {
      label: "missing classification recovery",
      mutate: (_root, stateDir) => rmSync(join(stateDir, "classification-recoveries", classificationName)),
    }, {
      label: "third same-key recovery",
      mutate: (_root, stateDir) => cpSync(
        join(stateDir, "problem-recoveries", problemName),
        join(stateDir, "problem-recoveries", `v2-0005-0014-${"0".repeat(64)}.json`)
      ),
    }, {
      label: "aliased recovery path",
      mutate: (_root, stateDir) => {
        const source = join(stateDir, "classification-recoveries", classificationName);
        const alias = join(stateDir, "classification-recoveries",
          `v2-0005-0014-${"a".repeat(64)}-7bb7cb863c8c4855.json`);
        cpSync(source, alias);
        rmSync(source);
      },
    }, {
      label: "symlinked recovery",
      mutate: (root, stateDir) => {
        const source = join(stateDir, "problem-recoveries", problemName);
        const outside = join(root, "outside-problem-recovery.json");
        cpSync(source, outside);
        rmSync(source);
        symlinkSync(outside, source);
      },
    }, {
      label: "junk recovery artifact",
      mutate: (_root, stateDir) => writeFileSync(join(stateDir, "problem-recoveries", "junk.json"), "{}\n"),
    }, {
      label: "historical audit selected as current",
      mutate: (_root, stateDir) => writeCanonical(
        join(stateDir, "answer-audit", currentAuditName),
        JSON.parse(readFileSync(join(stateDir, "answer-audit", historicalAuditName), "utf8"))
      ),
    }];

    for (const testCase of cases) {
      const root = mkdtempSync(join(tmpdir(), "studywork-5578423-history-preflight-"));
      try {
        const stateDir = await prepareSameKeySnapshot(root, migration);
        testCase.mutate(root, stateDir);
        const before = {
          db: sha256(join(root, "studywork.db")),
          state: stateSnapshot(stateDir),
        };
        await expect(runNormalReplay(root, migration.entryId), testCase.label).rejects.toMatchObject({
          stderr: expect.stringContaining("migration historical"),
        });
        expect({ db: sha256(join(root, "studywork.db")), state: stateSnapshot(stateDir) }, testCase.label)
          .toEqual(before);
        for (const path of ["migration-plans", "receipt-history", "migration-commits"]) {
          expect(existsSync(join(stateDir, path)), `${testCase.label}: ${path}`).toBe(false);
        }
        expect(existsSync(join(root, "backups")), `${testCase.label}: backups`).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it("allows a pristine 5578423 state to begin extraction", async () => {
    const migration = {
      entryId: "ebsi:5578423",
      entryToken: "a8beae02eaa19479bb277017",
      oldReceiptSha256: "99e7fa9f4461bb3617f15a4d150469a2e07ef44fc1c2e0c1c980d32eaa7aad57",
      beforeProjectionHash: "23503a537254ebbe86097a178329946a6dd747122fbe67d557403aebe0aacb21",
      afterProjectionHash: "d876cdad3af19a6f91fd9feafac2c7a1ef374596f3fdad6996932ac471e490b0",
      stableAfterProjectionHash: "1624dda2e68cb2d901732286ac8bb0ad92740856fcde5e13ac4b374453a530c8",
      accepted: 7,
    } satisfies SameKeyMigrationCase;
    const root = mkdtempSync(join(tmpdir(), "studywork-5578423-pristine-"));
    try {
      const stateDir = await prepareSameKeySnapshot(root, migration);
      for (const name of readdirSync(stateDir)) {
        if (!["entry.json", "problem.pdf", "solution.pdf"].includes(name)) {
          rmSync(join(stateDir, name), { recursive: true, force: true });
        }
      }
      mkdirSync(join(stateDir, "answer-audit"));
      writeFileSync(join(stateDir, "answer-audit", `v5-${"0".repeat(64)}.json.tmp`), "partial\n");
      const error = await runNormalReplay(root, migration.entryId).then(
        () => null,
        (reason: { stderr?: string }) => reason
      );
      expect(error).not.toBeNull();
      expect(error?.stderr).not.toContain("migration historical");
      expect(existsSync(join(stateDir, "downloads.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("adds the one pinned 5853841 question and replays without AI", async () => {
    const migration = {
      entryId: "ebsi:5853841",
      entryToken: "b9a5b631791efd3ac315db14",
      oldReceiptSha256: "4e51de5bfa4c36dfbd492568ab74aec2fa299bc5c9963e9bfc4834b4ee667924",
      beforeProjectionHash: "ab6c623c34c40c3b85ffe8d6b0ceeb66871d9c9ed9134b7a78e15af46f2285b7",
      afterProjectionHash: "7587b029267f704451aa589b93571f063352a938402fde3b02e9d7905f4f6668",
      stableAfterProjectionHash: "1f8a27732840bb54f25f177769f0837c73533156c58ce930d690946585e0fe53",
      accepted: 9,
    } satisfies SameKeyMigrationCase;
    const root = mkdtempSync(join(tmpdir(), "studywork-count-change-migration-"));
    try {
      const stateDir = await prepareSameKeySnapshot(root, migration);
      const first = await runSameKeyMigration(root, migration);
      expect(first.stdout).toContain("existing ebsi:5853841 9");
      const planName = readdirSync(join(stateDir, "migration-plans"))
        .find((name) => /^v1-[a-f0-9]{64}\.json$/u.test(name))!;
      const planPath = join(stateDir, "migration-plans", planName);
      const plan = JSON.parse(readFileSync(planPath, "utf8"));
      expect(plan.identity).toMatchObject({
        beforeProjectionHash: migration.beforeProjectionHash,
        afterProjectionHash: migration.afterProjectionHash,
        stableAfterProjectionHash: migration.stableAfterProjectionHash,
      });
      expect(plan.identity.operations.questionUpdates).toHaveLength(8);
      expect(plan.identity.operations.itemUpdates).toHaveLength(16);
      expect(plan.identity.operations.questionInserts).toHaveLength(1);
      expect(plan.identity.operations.itemInserts).toHaveLength(2);
      expect(plan.identity.operations.questionInserts[0].after).toMatchObject({
        id: 3529,
        src_page: 1,
        printed_number: "2",
        question: "$\\sqrt{4}\\times\\sqrt[3]{8}$의 값은? [2점]",
        answer: "①",
      });
      expect(plan.identity.operations.itemInserts.map((item: { after: { id: number } }) => item.after.id))
        .toEqual([7588, 7589]);
      const beforeReplay = {
        db: sha256(join(root, "studywork.db")),
        receipt: sha256(join(stateDir, "receipt.json")),
        plan: sha256(planPath),
      };
      const replay = await runSameKeyMigration(root, migration);
      expect(replay.stdout).toContain("existing ebsi:5853841 9");
      expect({
        db: sha256(join(root, "studywork.db")),
        receipt: sha256(join(stateDir, "receipt.json")),
        plan: sha256(planPath),
      }).toEqual(beforeReplay);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it("requires exact selected-choice revision pins and rejects unused authority", () => {
    const spec = EXISTING_CORPUS_MIGRATION_ALLOWLIST.find(({ entryId }) => entryId === "ebsi:5525982")!;
    const revision = spec.answerChoiceRevisions!.find(({ key }) => key === "12:31")!;
    const before = {
      id: 1, src_page: 12, printed_number: "31", qtype: "mcq", answer: "④",
      choices: JSON.stringify([
        "① dummy 1", "② dummy 2", "③ dummy 3",
        "④ 「느낌, 극락같은」의 ‘돌부처’를 만들며 가는 ‘길’은 ‘하늘’과 대비되는 곳으로 서연의 예술관이 조승인에게 전수되는 공간이군.",
        "⑤ dummy 5",
      ]),
    };
    const current = {
      qtype: "mcq", number: "31", printedNumber: "31", officialAnswer: "④",
      choices: [
        "① dummy 1", "② dummy 2", "③ dummy 3",
        "④ (나)의 ‘돌부처’를 만들며 가는 ‘길’은 ‘하늘’과 대비되는 곳으로 서연의 예술관이 조숭인에게 전수되는 공간이군.",
        "⑤ dummy 5",
      ],
    } as ImportedQuestion;
    expect(assertMigrationAnswerEquivalent(before, current, revision)).toBe(true);
    for (const tampered of [
      { ...revision, key: "12:32" },
      { ...revision, choiceIndex: 3 },
      { ...revision, beforeSelectedChoiceHash: "0".repeat(64) },
      { ...revision, afterSelectedChoiceHash: "0".repeat(64) },
    ]) expect(() => assertMigrationAnswerEquivalent(before, current, tampered)).toThrow("보기 내용");
    expect(() => assertMigrationAnswerEquivalent(before, current)).toThrow("보기 내용");
    expect(() => assertMigrationAnswerEquivalent(before, {
      ...current, officialAnswer: "③",
    })).toThrow("정답 의미");

    const exactBefore = {
      ...before, src_page: 16, printed_number: "44", answer: "⑤",
      choices: JSON.stringify(["① a", "② b", "③ c", "④ d", "⑤ ㉤: 계절감을 드러내는 표현"]),
    };
    const exactCurrent = {
      ...current, page: 16, number: "44", printedNumber: "44", officialAnswer: "⑤",
      choices: ["① a", "② b", "③ c", "④ d", "⑤ ㉤ : 계절감을 드러내는 표현"],
    };
    expect(() => assertMigrationAnswerEquivalent(exactBefore, exactCurrent, {
      ...revision, key: "16:44",
    })).toThrow("revision pin이 불필요합니다");
  });

  it("fails 5525982 migration before sidecars when approved DB ownership changes", async () => {
    const migration = {
      entryId: "ebsi:5525982",
      entryToken: "bb876a67170089dfb2022f47",
      oldReceiptSha256: "7e2a247ab9d1e4bed7db8fdd56486cc25b68441ac1213a8cee69391917dabf48",
      beforeProjectionHash: "460b040f3fe396e3cf4086d94132c77db66fd1b46a3498fa44afde2b03384a81",
      afterProjectionHash: "7e981e83d9a81a2cb07f603ecbc6dfdb6ae7df590b492e5e5ab12851e817647a",
      stableAfterProjectionHash: "151811cfa19fadbcc99381123df01916c0c6008653b0173efef189f7e32d0317",
      accepted: 30,
    } satisfies SameKeyMigrationCase;
    const root = mkdtempSync(join(tmpdir(), "studywork-5525982-migration-prewrite-"));
    try {
      const stateDir = await prepareSameKeySnapshot(root, migration);
      const receiptPath = join(stateDir, "receipt.json");
      const db = new Database(join(root, "studywork.db"));
      try {
        db.prepare("UPDATE questions SET question = 'tampered' WHERE id = 3003").run();
      } finally {
        db.close();
      }
      const before = {
        db: sha256(join(root, "studywork.db")),
        receipt: sha256(receiptPath),
        state: stateSnapshot(stateDir),
      };
      await expect(runSameKeyMigration(root, migration)).rejects.toMatchObject({
        stderr: expect.stringContaining("승인 DB projection이 다릅니다"),
      });
      expect({
        db: sha256(join(root, "studywork.db")),
        receipt: sha256(receiptPath),
        state: stateSnapshot(stateDir),
      }).toEqual(before);
      for (const path of ["migration-plans", "receipt-history", "migration-commits", "answer-attestation"]) {
        expect(existsSync(join(stateDir, path))).toBe(false);
      }
      expect(existsSync(join(root, "backups"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

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
