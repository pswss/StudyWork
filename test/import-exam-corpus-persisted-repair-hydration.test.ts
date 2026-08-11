import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const providerMock = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("../src/codex-provider", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/codex-provider")>(),
  getCodexProvider: () => ({ complete: providerMock.complete }),
}));

import {
  CLASSIFIER_DIGEST,
  CLASSIFIER_VERSION,
  canonicalEvidenceHash,
  parseCorpusManifest,
  parseDecisions,
  repairAndAuditOfficialAnswers,
  type ClassifiedQuestion,
} from "../scripts/import-exam-corpus";

const repository = join(import.meta.dirname, "..");
const sourceData = join(repository, "data");
const liveRoot = join(repository, "data/import-exam-corpus");
const execFileP = promisify(execFile);
const cases = [
  {
    entryId: "ebsi:5642949",
    token: "a777002f3e815de129348383",
    auditPath: "answer-audit/v5-8223edc254c50dca911ba3afcc74a023cdf764789d0dcacb2087acae6561f6d7.json",
    auditHash: "b334628f628f14c6a96775604b3cd5614cb4a3584f40cf9aeeb76386684feed2",
  },
  {
    entryId: "ebsi:5696440",
    token: "5d284ad3480f9a6552df0a23",
    auditPath: "answer-audit/v5-23ab32c4ce090a1ce9ba219993ae11f80ee6b321b53458c036ba32b03044d00d.json",
    auditHash: "16f98f43fcb49c26cbb8f03ab9d24d382c301e6d3ae3ff6d89f67f496570d566",
  },
  {
    entryId: "ebsi:5854175",
    token: "231f0e1a573a042551a8df8e",
    auditPath: "answer-audit/v5-8a3c3f73fa0cef2a12422204320d4a4abd85d6db817a6fa1e07c385f70449c70.json",
    auditHash: "1372f262965e9f82f37b37f46aa0b26e9f10195183bf050ba74f73819e185618",
  },
] as const;
const deferredTerminalCase = { entryId: "ebsi:5854176", token: "413873ff32393142ef756fc3" } as const;
const regroupingCases = [
  {
    entryId: "ebsi:5594500",
    token: "e9fcb8ccb0af1356a50a6de4",
    terminalBackedCorpusHash: "b987fa87a2159fb4b2cfcb99993560a9490307ef0358f302605af605869f9b17",
    finalCorpusHash: "3afdc2e5f9b32575f91acf4a7d2b6a77198f61c797d2f2694c3131d63b0e7041",
    expectedError: null,
  },
  {
    entryId: "ebsi:5594501",
    token: "b395aca2790e257b1487b455",
    terminalBackedCorpusHash: "9899689cf6ebc256fbe32d7898c3cb29d0dabda066799ccbeaaf977c70894d31",
    finalCorpusHash: "9899689cf6ebc256fbe32d7898c3cb29d0dabda066799ccbeaaf977c70894d31",
    expectedError: null,
  },
  {
    entryId: "ebsi:5643101",
    token: "5a72e90edfe68c75f79ce8ef",
    terminalBackedCorpusHash: "7f4dd66d75a99e1b3b595184bcebb8e60fff1aebdd43fac9a32fbf787d75a168",
    finalCorpusHash: null,
    expectedError: "10:26 problem repair scope adjudication이 허용된 final scope에 합의하지 않았습니다",
  },
  {
    entryId: "ebsi:5643102",
    token: "887df3e562b3dab6874de994",
    terminalBackedCorpusHash: "854ffad3fac0dd3f0c89e4cd275a8d043da15aaa2ea1c36c0aab69e2892a7721",
    finalCorpusHash: null,
    expectedError: "solution-revision-upgrades/v1-0001-0001-" +
      "a234f7a484dd4f13695b87c6fee94510ec386495aafe406f0344993e34c26d7c.json prompt upgrade parent가 없습니다",
  },
] as const;
const legacyV1ContextCase = { entryId: "ebsi:5525984", token: "7755c70fefaa45f755086e2b" } as const;
const legacySinglePreflightCase = { entryId: "ebsi:5643100", token: "194298dd83aaf47b6f3218fe" } as const;
const terminalRecoveryCase = { entryId: "ebsi:5656592", token: "c83035d36ef8d2b8f1bfe856" } as const;
const available = [
  ...cases,
  ...regroupingCases,
  deferredTerminalCase,
  legacyV1ContextCase,
  legacySinglePreflightCase,
  terminalRecoveryCase,
]
  .every(({ token }) => existsSync(join(liveRoot, token, "problem.pdf")));
let roots: string[] = [];

afterEach(() => {
  providerMock.complete.mockReset();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function files(root: string, path = root): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? files(root, child) : [relative(root, child)];
  }).sort();
}

function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(files(root).map((path) => [
    path,
    createHash("sha256").update(lstatSync(join(root, path)).isSymbolicLink()
      ? `symlink:${readlinkSync(join(root, path))}`
      : readFileSync(join(root, path))).digest("hex"),
  ]));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

function writeCanonical(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(canonicalize(value), null, 2)}\n`);
}

function replayInputs(root: string) {
  const entry = parseCorpusManifest({
    schemaVersion: 2,
    entries: [JSON.parse(readFileSync(join(root, "entry.json"), "utf8")).entry],
  }).entries[0];
  const downloads = JSON.parse(readFileSync(join(root, "downloads.json"), "utf8"));
  const problem = {
    ...downloads.problem,
    path: join(root, "problem.pdf"),
    resolvedUrl: downloads.problem.requestedUrl,
  };
  const solution = {
    ...downloads.solution,
    path: join(root, "solution.pdf"),
    resolvedUrl: downloads.solution.requestedUrl,
  };
  const questions = JSON.parse(readFileSync(join(root, "problem-chunks/v2-0000.json"), "utf8")).items;
  const decisions = parseDecisions(
    JSON.parse(readFileSync(
      join(root, `classification-chunks/v${CLASSIFIER_VERSION}-0000-${CLASSIFIER_DIGEST}.json`),
      "utf8"
    )).items,
    questions,
    entry
  );
  const byKey = new Map(decisions.map((decision) => [decision.key, decision]));
  const classified: ClassifiedQuestion[] = questions.map((question: { page: number; number: string }) => ({
    question,
    classification: byKey.get(`${question.page}:${Number(question.number)}`)!,
  }));
  const solutions = readdirSync(join(root, "solution-chunks"))
    .filter((name) => /^v3-\d{4}\.json$/u.test(name))
    .sort()
    .flatMap((name) => {
      const checkpoint = JSON.parse(readFileSync(join(root, "solution-chunks", name), "utf8"));
      return checkpoint.items.filter((item: { page: number }) =>
        item.page >= checkpoint.ownedFrom && item.page <= checkpoint.ownedTo
      );
    });
  return { entry, problem, solution, classified, solutions };
}

function fixtureQuestionKey(question: { page: number | null; number: string | null }): string {
  if (question.page === null || question.number === null) throw new Error("fixture question locator가 없습니다");
  return `${question.page}:${Number(question.number)}`;
}

function classifiedFromRepairGraphs(root: string, graphDigests: string[]) {
  const input = replayInputs(root);
  const overlay = new Map<string, (typeof input.classified)[number]>();
  const directory = join(root, "classification-repair-batches");
  for (const digest of graphDigests) {
    const name = readdirSync(directory).find((candidate) => candidate.includes(digest))!;
    const checkpoint = JSON.parse(readFileSync(join(directory, name), "utf8"));
    const questions: ClassifiedQuestion["question"][] = checkpoint.members.map(
      (member: { key: string; problemAuthority: { path: string } }) => {
      const problemCheckpoint = JSON.parse(readFileSync(join(root, member.problemAuthority.path), "utf8"));
      const items = problemCheckpoint.items ?? [problemCheckpoint.item];
      return items.find((item: { page: number; number: string }) => fixtureQuestionKey(item) === member.key)!;
      }
    );
    const decisions = parseDecisions(checkpoint.items, questions, input.entry);
    for (const [index, member] of checkpoint.members.entries()) {
      overlay.set(member.key, { question: questions[index], classification: decisions[index] });
    }
  }
  return input.classified.map((item) => overlay.get(fixtureQuestionKey(item.question)) ?? item);
}

function addTerminalFixture(
  root: string,
  classified: ReturnType<typeof classifiedFromRepairGraphs>,
  templateCorpusHash: string
): string {
  const directory = join(root, "problem-terminal-fidelity");
  const templateName = readdirSync(directory).find((name) => name.includes(templateCorpusHash))!;
  const template = JSON.parse(readFileSync(join(directory, templateName), "utf8"));
  const inputs = classified
    .filter(({ question }) => question.page! >= template.ownedFrom && question.page! <= template.ownedTo)
    .map(({ question }) => ({
      key: fixtureQuestionKey(question),
      printed_number: String(Number(question.number)),
      source_page: question.page,
      qtype: question.qtype,
      question: question.question,
      choices: question.choices,
      figure: question.figure,
      figure_description: question.figure_description,
      box: question.box,
    }));
  const effectiveCorpusHash = canonicalEvidenceHash(classified);
  const inputHash = canonicalEvidenceHash(inputs);
  const checkpoint = { ...template, effectiveCorpusHash, inputHash, inputs };
  const index = /^v2-(\d{4})-/u.exec(templateName)![1];
  const name = `v2-${index}-${effectiveCorpusHash}-${inputHash}.json`;
  writeCanonical(join(directory, name), checkpoint);
  return name;
}

describe.skipIf(!available)("persisted v2 repair graph hydration", () => {
  it("replays the source-authorized ebsi:5656592 Q11 and Q15 recoveries without AI or writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "studywork-persisted-terminal-recovery-"));
    roots.push(root);
    cpSync(join(liveRoot, terminalRecoveryCase.token), root, { recursive: true });
    const before = snapshot(root);
    providerMock.complete.mockRejectedValue(new Error("unexpected replay AI call"));
    const input = replayInputs(root);

    const result = await repairAndAuditOfficialAnswers(
      input.entry,
      input.problem,
      input.solution,
      root,
      input.classified,
      input.solutions
    );
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      auditPath: "answer-audit/v5-b8e7b69c44cf1cfb5d4527d7d25a9f062db5bdd9ce645244ccc2f46b6acbca7a.json",
      auditHash: "74ed4b805d9d0055b66e91a805e55cb801fed7b92c86de8e5e07b88aea09c838",
      effectiveCorpusHash: "fd27b3f4d9b4d9224c116326f7f5e9892d58dabf928cfecd838a260c93c14cbf",
    });
    expect(result.repairs.find((repair) => repair.key === "4:11")?.revision?.recovery?.problemArtifact.path)
      .toContain("a16c7f3c13454e8f23d75f4e7b53480212e5d06c4125af6c09e7e7c8f68783d8");
    expect(result.repairs.find((repair) => repair.key === "6:15")?.revision?.recovery?.problemArtifact.path)
      .toContain("2871fee6201e5c3ad8c5e1efedc77398b214cf99963671a5e377a68304347b7d");
    expect(snapshot(root)).toEqual(before);
  });

  it("reaches the ebsi:5656592 DB ownership guard with the provider disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "studywork-persisted-terminal-recovery-db-"));
    roots.push(root);
    const stateDir = join(root, "import-exam-corpus", terminalRecoveryCase.token);
    mkdirSync(join(root, "import-exam-corpus"), { recursive: true });
    cpSync(join(liveRoot, terminalRecoveryCase.token), stateDir, { recursive: true });
    mkdirSync(join(root, "files", "corpus"), { recursive: true });
    cpSync(
      join(sourceData, "files", "corpus", terminalRecoveryCase.token),
      join(root, "files", "corpus", terminalRecoveryCase.token),
      { recursive: true }
    );
    const sourceDb = new Database(join(sourceData, "studywork.db"), { readonly: true, fileMustExist: true });
    try {
      await sourceDb.backup(join(root, "studywork.db"));
    } finally {
      sourceDb.close();
    }
    const entry = JSON.parse(readFileSync(join(stateDir, "entry.json"), "utf8")).entry;
    const manifestPath = join(root, "manifest.json");
    writeCanonical(manifestPath, { schemaVersion: 2, entries: [entry] });
    const beforeState = snapshot(stateDir);
    const beforeDb = createHash("sha256").update(readFileSync(join(root, "studywork.db"))).digest("hex");

    let output = "";
    try {
      await execFileP(process.execPath, [
        "--import", "tsx", "scripts/import-exam-corpus.ts",
        "--manifest", manifestPath,
        "--data-dir", root,
        "--commit",
      ], {
        cwd: repository,
        timeout: 30_000,
        env: { ...process.env, STUDYWORK_CODEX_BIN: "/usr/bin/false" },
      });
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
    }
    expect(output).toContain("기존 importer 문항이 변경되었거나 일부 삭제되었습니다; 덮어쓰지 않습니다");
    expect(output).not.toContain("Codex CLI가 응답하지 않았습니다");
    expect(snapshot(stateDir)).toEqual(beforeState);
    expect(createHash("sha256").update(readFileSync(join(root, "studywork.db"))).digest("hex")).toBe(beforeDb);
  });

  it("falls back to one fresh terminal when the pinned final audit is absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "studywork-persisted-terminal-recovery-resume-"));
    roots.push(root);
    cpSync(join(liveRoot, terminalRecoveryCase.token), root, { recursive: true });
    rmSync(join(
      root,
      "answer-audit/v5-b8e7b69c44cf1cfb5d4527d7d25a9f062db5bdd9ce645244ccc2f46b6acbca7a.json"
    ));
    const before = snapshot(root);
    providerMock.complete.mockRejectedValue(new Error("expected fresh terminal call"));
    const input = replayInputs(root);

    await expect(repairAndAuditOfficialAnswers(
      input.entry,
      input.problem,
      input.solution,
      root,
      input.classified,
      input.solutions
    )).rejects.toThrow("expected fresh terminal call");
    expect(providerMock.complete).toHaveBeenCalledTimes(1);
    expect(providerMock.complete.mock.calls[0][0].schema?.name)
      .toBe("studywork_exam_corpus_problem_terminal_fidelity");
    expect(snapshot(root)).toEqual(before);
  });

  it.each([
    "selected-problem",
    "selected-classification",
    "historical-problem",
    "companion-problem",
    "companion-classification",
    "companion-revision",
    "companion-trigger",
    "companion-missing",
    "companion-orphan",
    "final-audit",
    "final-terminal",
    "final-terminal-missing",
    "child-swap",
    "trigger",
    "upstream",
    "missing",
    "orphan",
    "symlink",
    "directory-symlink",
    "source-symlink",
  ] as const)("rejects %s persisted terminal recovery corruption before AI/write", async (mode) => {
    const root = mkdtempSync(join(tmpdir(), `studywork-persisted-terminal-recovery-${mode}-`));
    roots.push(root);
    cpSync(join(liveRoot, terminalRecoveryCase.token), root, { recursive: true });
    const selectedProblem = join(
      root,
      "problem-recoveries",
      "v2-0004-0011-a16c7f3c13454e8f23d75f4e7b53480212e5d06c4125af6c09e7e7c8f68783d8.json"
    );
    const selectedClassification = join(
      root,
      "classification-recoveries",
      "v2-0004-0011-3a56ded3e11de92f106ce8d5e0690e4c8bbb495cc796a4bcec8eed9886a043a9-" +
      `${CLASSIFIER_DIGEST}.json`
    );
    const historicalProblem = join(
      root,
      "problem-recoveries",
      "v2-0004-0011-189d47abd4090fb221f78c7cc9dc94df7530e47ea1b09c2d22d0c2155c93c090.json"
    );
    const companionProblem = join(
      root,
      "problem-recoveries",
      "v2-0006-0015-2871fee6201e5c3ad8c5e1efedc77398b214cf99963671a5e377a68304347b7d.json"
    );
    const companionClassification = join(
      root,
      "classification-recoveries",
      "v2-0006-0015-69898d0bdb86d9253bfee5590ecd733822f9ca0768b4de1df669626d9e427d58-" +
      `${CLASSIFIER_DIGEST}.json`
    );
    const tamper = (path: string) => {
      const checkpoint = JSON.parse(readFileSync(path, "utf8"));
      checkpoint.unexpected = true;
      writeCanonical(path, checkpoint);
    };
    if (mode === "selected-problem") tamper(selectedProblem);
    else if (mode === "selected-classification") tamper(selectedClassification);
    else if (mode === "historical-problem") tamper(historicalProblem);
    else if (mode === "companion-problem") tamper(companionProblem);
    else if (mode === "companion-classification") tamper(companionClassification);
    else if (mode === "companion-revision") tamper(join(
      root,
      "problem-revision-batches/" +
        "v1-0001-0012-0006-9bb41487b85aa7161eef13d1f23c2fc8da17ece5fe172b1b7eb12789ae8ee49f.json"
    ));
    else if (mode === "companion-trigger") tamper(join(
      root,
      "problem-terminal-fidelity/" +
        "v2-0000-f469ad8d5e38cb71c9ab980e783a4ed92a86788e1130075bd7064682af467aa5-" +
        "16800533754aa321e63d9c11541247d8825ef91ff57cd4bf7aed1dfcf9aa094a.json"
    ));
    else if (mode === "companion-missing") rmSync(companionClassification);
    else if (mode === "companion-orphan") {
      cpSync(companionProblem, join(root, "problem-recoveries", `v2-0006-0015-${"0".repeat(64)}.json`));
    }
    else if (mode === "final-audit") tamper(join(
      root,
      "answer-audit/v5-b8e7b69c44cf1cfb5d4527d7d25a9f062db5bdd9ce645244ccc2f46b6acbca7a.json"
    ));
    else if (mode === "final-terminal" || mode === "final-terminal-missing") {
      const finalTerminal = join(
        root,
        "problem-terminal-fidelity/" +
          "v2-0000-fd27b3f4d9b4d9224c116326f7f5e9892d58dabf928cfecd838a260c93c14cbf-" +
          "d6c42b6b5577981c398d014fe5e45171b83ec36884e47df7cf0bc853f76bff05.json"
      );
      if (mode === "final-terminal") tamper(finalTerminal);
      else rmSync(finalTerminal);
    }
    else if (mode === "child-swap") {
      const historicalClassification = join(
        root,
        "classification-recoveries",
        "v2-0004-0011-af846d70c50441e4974d709bd5e4dfdeccd14b622b2d9d6c2592fd97b26c2b3d-" +
        `${CLASSIFIER_DIGEST}.json`
      );
      cpSync(historicalClassification, selectedClassification);
    }
    else if (mode === "trigger") {
      tamper(join(
        root,
        "problem-terminal-fidelity",
        "v2-0000-b9f1d1f6130bfb155e8e1a9c6b9c399d3b763a669e7a40537f6455da7bd941bd-" +
        "c0fd4e92c73adf737bea28b839e815dddfefd6206fc79be440527e508b18eb43.json"
      ));
    } else if (mode === "upstream") {
      tamper(join(root, "problem-revision-batches",
        "v1-0001-0012-0004-d75af2aacce6cd1be02091e1bf0855a8245287d6dc0258a23e891013a28ccddb.json"));
    } else if (mode === "missing") rmSync(selectedClassification);
    else if (mode === "orphan") {
      cpSync(selectedProblem, join(root, "problem-recoveries", `v2-0004-0011-${"0".repeat(64)}.json`));
    } else if (mode === "symlink") {
      const target = join(root, "classification-recovery-copy.json");
      cpSync(selectedClassification, target);
      rmSync(selectedClassification);
      symlinkSync(target, selectedClassification);
    } else if (mode === "directory-symlink") {
      const directory = join(root, "classification-recoveries");
      const target = join(root, "classification-recoveries-copy");
      cpSync(directory, target, { recursive: true });
      rmSync(directory, { recursive: true });
      symlinkSync(target, directory);
    } else {
      const source = join(root, "problem.pdf");
      const target = join(root, "problem-copy.pdf");
      cpSync(source, target);
      rmSync(source);
      symlinkSync(target, source);
    }
    const before = snapshot(root);
    providerMock.complete.mockRejectedValue(new Error("unexpected AI call"));
    const input = replayInputs(root);
    await expect(repairAndAuditOfficialAnswers(
      input.entry,
      input.problem,
      input.solution,
      root,
      input.classified,
      input.solutions
    )).rejects.toThrow(/persisted terminal/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(snapshot(root)).toEqual(before);
  });

  it.each(regroupingCases)("selects the unique terminal-backed regrouping cover for $entryId", async (testCase) => {
    const { token, terminalBackedCorpusHash, finalCorpusHash, expectedError } = testCase;
    const root = mkdtempSync(join(tmpdir(), `studywork-regrouping-${token}-`));
    roots.push(root);
    cpSync(join(liveRoot, token), root, { recursive: true });
    expect(readdirSync(join(root, "problem-terminal-fidelity"))
      .some((name) => name.includes(terminalBackedCorpusHash))).toBe(true);
    providerMock.complete.mockImplementation((request: { schema?: { name?: string } }) =>
      Promise.reject(new Error(`unexpected AI call: ${request.schema?.name ?? "unknown"}`))
    );
    const input = replayInputs(root);

    if (expectedError) {
      const before = snapshot(root);
      await expect(repairAndAuditOfficialAnswers(
        input.entry,
        input.problem,
        input.solution,
        root,
        input.classified,
        input.solutions
      )).rejects.toThrow(expectedError);
      expect(providerMock.complete).not.toHaveBeenCalled();
      expect(snapshot(root)).toEqual(before);
      return;
    }

    const first = await repairAndAuditOfficialAnswers(
      input.entry, input.problem, input.solution, root, input.classified, input.solutions
    );
    expect(first.effectiveCorpusHash).toBe(finalCorpusHash);
    expect(providerMock.complete).not.toHaveBeenCalled();
    const afterFirst = snapshot(root);
    const replay = await repairAndAuditOfficialAnswers(
      input.entry, input.problem, input.solution, root, input.classified, input.solutions
    );
    expect(replay).toMatchObject(first);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(snapshot(root)).toEqual(afterFirst);
  });

  it.each([
    "tampered-terminal",
    "terminal-symlink",
    "no-terminal",
    "ambiguous-terminal",
    "orphan-partial-graph",
    "unreferenced-parent",
    "orphan-junk",
  ] as const)(
    "fails closed for a %s regrouping graph before AI",
    async (mode) => {
      const testCase = regroupingCases[0];
      const root = mkdtempSync(join(tmpdir(), `studywork-regrouping-${mode}-`));
      roots.push(root);
      cpSync(join(liveRoot, testCase.token), root, { recursive: true });
      const terminalDirectory = join(root, "problem-terminal-fidelity");
      const terminalName = readdirSync(terminalDirectory)
        .find((name) => name.includes(testCase.terminalBackedCorpusHash))!;
      if (mode === "tampered-terminal") {
        const path = join(terminalDirectory, terminalName);
        const checkpoint = JSON.parse(readFileSync(path, "utf8"));
        checkpoint.unexpected = true;
        writeCanonical(path, checkpoint);
      } else if (mode === "terminal-symlink") {
        const path = join(terminalDirectory, terminalName);
        const target = join(root, "terminal-authority-copy.json");
        cpSync(path, target);
        rmSync(path);
        symlinkSync(target, path);
      } else if (mode === "no-terminal") {
        rmSync(join(terminalDirectory, terminalName));
      } else if (mode === "ambiguous-terminal") {
        const historical = classifiedFromRepairGraphs(root, ["5f3c70fa", "65ec252e"]);
        const historicalHash = canonicalEvidenceHash(historical);
        expect(readdirSync(terminalDirectory).some((name) => name.includes(historicalHash))).toBe(false);
        addTerminalFixture(root, historical, testCase.terminalBackedCorpusHash);
      } else if (mode === "orphan-partial-graph") {
        const directory = join(root, "classification-repair-batches");
        const sourceName = readdirSync(directory).find((candidate) => candidate.includes("45da6057"))!;
        const checkpoint = JSON.parse(readFileSync(join(directory, sourceName), "utf8"));
        checkpoint.members = [checkpoint.members[0]];
        checkpoint.items = checkpoint.items.filter((item: { key: string }) => item.key === checkpoint.members[0].key);
        checkpoint.overlayDigest = canonicalEvidenceHash(checkpoint.members);
        writeCanonical(
          join(directory, `v1-0001-0012-${checkpoint.overlayDigest}-${CLASSIFIER_DIGEST}.json`),
          checkpoint
        );
      } else {
        const directory = join(root, "classification-repair-batches");
        if (mode === "unreferenced-parent") {
          const name = readdirSync(directory).find((candidate) => candidate.includes("5f3c70fa"))!;
          rmSync(join(directory, name));
        } else {
          writeFileSync(join(directory, "undeclared.txt"), "orphan\n");
        }
      }
      const before = snapshot(root);
      providerMock.complete.mockRejectedValue(new Error("unexpected AI call"));
      const input = replayInputs(root);
      await expect(repairAndAuditOfficialAnswers(
        input.entry,
        input.problem,
        input.solution,
        root,
        input.classified,
        input.solutions
      )).rejects.toThrow(
        /terminal 문제 fidelity exact envelope|terminal 문제 fidelity checkpoint|terminal-backed full-cover|disjoint full-cover에 속하지|classification graph에서 누락|classification repair batch (?:파일|filename)/u
      );
      expect(providerMock.complete).not.toHaveBeenCalled();
      expect(snapshot(root)).toEqual(before);
    }
  );

  it.each(cases)("replays $entryId byte-for-byte without AI", async ({ token, auditPath, auditHash }) => {
    const root = mkdtempSync(join(tmpdir(), `studywork-persisted-${token}-`));
    roots.push(root);
    cpSync(join(liveRoot, token), root, { recursive: true });
    const before = snapshot(root);
    providerMock.complete.mockRejectedValue(new Error("unexpected AI call"));

    const { entry, problem, solution, classified, solutions } = replayInputs(root);

    const replay = await repairAndAuditOfficialAnswers(
      entry,
      problem,
      solution,
      root,
      classified,
      solutions
    );
    expect(replay).toMatchObject({ auditPath, auditHash });
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(snapshot(root)).toEqual(before);
    if (entry.id === "ebsi:5642949") {
      const classificationDirectory = join(root, "classification-repair-batches");
      const mixedName = readdirSync(classificationDirectory).find((name) => {
        const checkpoint = JSON.parse(readFileSync(join(classificationDirectory, name), "utf8"));
        const paths = checkpoint.members.map((member: { problemAuthority: { path: string } }) =>
          member.problemAuthority.path
        );
        return paths.some((path: string) => path.startsWith("problem-repairs/")) &&
          paths.some((path: string) => path.startsWith("problem-repair-batches/v2-"));
      })!;
      const mixedPath = `classification-repair-batches/${mixedName}`;
      const mixed = JSON.parse(readFileSync(join(root, mixedPath), "utf8"));
      const repairByKey = new Map(replay.repairs.map((repair) => [repair.key, repair]));
      expect(mixed.members.every((member: { key: string }) =>
        repairByKey.get(member.key)?.classificationArtifact.path === mixedPath
      )).toBe(true);
    }
  });

  it("defers ebsi:5854176 at its first fresh terminal generation without regrouping repair calls", async () => {
    const root = mkdtempSync(join(tmpdir(), `studywork-persisted-${deferredTerminalCase.token}-`));
    roots.push(root);
    cpSync(join(liveRoot, deferredTerminalCase.token), root, { recursive: true });
    const before = snapshot(root);
    providerMock.complete.mockRejectedValue(new Error("expected fresh terminal call"));
    const input = replayInputs(root);

    await expect(repairAndAuditOfficialAnswers(
      input.entry,
      input.problem,
      input.solution,
      root,
      input.classified,
      input.solutions
    )).rejects.toThrow("expected fresh terminal call");
    expect(providerMock.complete).toHaveBeenCalledTimes(1);
    expect(providerMock.complete.mock.calls[0][0].schema?.name)
      .toBe("studywork_exam_corpus_problem_terminal_fidelity");
    expect(snapshot(root)).toEqual(before);
  });

  it("replays a mixed v1-context repair checkpoint on the existing whole-checkpoint path", async () => {
    const root = mkdtempSync(join(tmpdir(), `studywork-persisted-${legacyV1ContextCase.token}-`));
    roots.push(root);
    cpSync(join(liveRoot, legacyV1ContextCase.token), root, { recursive: true });
    const before = Object.fromEntries(Object.entries(snapshot(root)).filter(([path]) =>
      /^(problem-repairs|problem-repair-batches|classification-repair-batches)\//u.test(path)
    ));
    providerMock.complete.mockRejectedValue(new Error("unexpected AI call"));
    const input = replayInputs(root);

    await repairAndAuditOfficialAnswers(
      input.entry,
      input.problem,
      input.solution,
      root,
      input.classified,
      input.solutions
    );
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(Object.fromEntries(Object.entries(snapshot(root)).filter(([path]) =>
      /^(problem-repairs|problem-repair-batches|classification-repair-batches)\//u.test(path)
    ))).toEqual(before);
  });

  it("rejects a tampered or duplicate v2 parent before AI", async () => {
    for (const mode of ["tamper", "duplicate"] as const) {
      const root = mkdtempSync(join(tmpdir(), `studywork-persisted-${mode}-`));
      roots.push(root);
      cpSync(join(liveRoot, cases[0].token), root, { recursive: true });
      const directory = join(root, "problem-repair-batches");
      const name = readdirSync(directory).find((candidate) => candidate.startsWith("v2-"))!;
      const path = join(directory, name);
      const checkpoint = JSON.parse(readFileSync(path, "utf8"));
      if (mode === "tamper") {
        checkpoint.members[0].baseTranscriptionEvidenceHash = "0".repeat(64);
        writeCanonical(path, checkpoint);
      } else {
        writeCanonical(join(directory, name.replace(/[a-f0-9]{64}\.json$/u, `${"0".repeat(64)}.json`)), checkpoint);
      }
      providerMock.complete.mockRejectedValue(new Error("unexpected AI call"));
      const input = replayInputs(root);
      await expect(repairAndAuditOfficialAnswers(
        input.entry,
        input.problem,
        input.solution,
        root,
        input.classified,
        input.solutions
      )).rejects.toThrow(/persisted problem repair/u);
      expect(providerMock.complete).not.toHaveBeenCalled();
      providerMock.complete.mockReset();
    }
  });

  it.each(["legacy", "legacy-classification", "v2", "classification"] as const)(
    "rejects an extra field in the %s graph envelope before AI",
    async (kind) => {
      const root = mkdtempSync(join(tmpdir(), `studywork-persisted-extra-${kind}-`));
      roots.push(root);
      cpSync(join(liveRoot, cases[0].token), root, { recursive: true });
      const directory = join(root, kind === "legacy" ? "problem-repairs" :
        kind === "legacy-classification" ? "classification-repairs" :
        kind === "v2" ? "problem-repair-batches" : "classification-repair-batches");
      const name = readdirSync(directory).find((candidate) => candidate.endsWith(".json"))!;
      const path = join(directory, name);
      const checkpoint = JSON.parse(readFileSync(path, "utf8"));
      checkpoint.unexpected = true;
      writeCanonical(path, checkpoint);
      const before = snapshot(root);
      providerMock.complete.mockRejectedValue(new Error("unexpected AI call"));
      const input = replayInputs(root);
      await expect(repairAndAuditOfficialAnswers(
        input.entry,
        input.problem,
        input.solution,
        root,
        input.classified,
        input.solutions
      )).rejects.toThrow(/persisted problem repair|classification repair graph|legacy classification repair/u);
      expect(providerMock.complete).not.toHaveBeenCalled();
      expect(snapshot(root)).toEqual(before);
    }
  );

  it("preflights every missing and partial group before classification writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "studywork-persisted-preflight-"));
    roots.push(root);
    cpSync(join(liveRoot, cases[0].token), root, { recursive: true });
    const directory = join(root, "classification-repair-batches");
    const name = readdirSync(directory).find((candidate) => candidate.endsWith(".json"))!;
    const path = join(directory, name);
    const checkpoint = JSON.parse(readFileSync(path, "utf8"));
    const batchGroups = [...checkpoint.members.reduce(
      (byPath: Map<string, string[]>, member: { key: string; problemAuthority: { path: string } }) => {
        if (!member.problemAuthority.path.startsWith("problem-repair-batches/v2-")) return byPath;
        byPath.set(member.problemAuthority.path, [...(byPath.get(member.problemAuthority.path) ?? []), member.key]);
        return byPath;
      },
      new Map<string, string[]>()
    ).values()].filter((keys) => keys.length > 1);
    expect(batchGroups.length).toBeGreaterThanOrEqual(2);
    const removed = new Set([...batchGroups[0], batchGroups[1][0]]);
    checkpoint.members = checkpoint.members.filter((member: { key: string }) => !removed.has(member.key));
    checkpoint.items = checkpoint.items.filter((item: { key: string }) => !removed.has(item.key));
    checkpoint.overlayDigest = canonicalEvidenceHash(checkpoint.members);
    const match = /^(v1-\d{4}-\d{4}-)[a-f0-9]{64}(-[a-f0-9]{16}\.json)$/u.exec(name)!;
    const replacement = `${match[1]}${checkpoint.overlayDigest}${match[2]}`;
    writeCanonical(join(directory, replacement), checkpoint);
    rmSync(path);
    const before = snapshot(root);
    providerMock.complete.mockRejectedValue(new Error("unexpected AI call"));
    const input = replayInputs(root);
    await expect(repairAndAuditOfficialAnswers(
      input.entry,
      input.problem,
      input.solution,
      root,
      input.classified,
      input.solutions
    )).rejects.toThrow("classification coverage가 부분적으로 충돌합니다");
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(snapshot(root)).toEqual(before);
  });

  it("validates every existing legacy single child before writing a missing shared child", async () => {
    const root = mkdtempSync(join(tmpdir(), "studywork-persisted-single-preflight-"));
    roots.push(root);
    cpSync(join(liveRoot, legacySinglePreflightCase.token), root, { recursive: true });
    rmSync(join(root, "classification-repair-batches"), { recursive: true, force: true });
    const directory = join(root, "classification-repairs");
    const names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
    expect(names.length).toBeGreaterThanOrEqual(2);
    rmSync(join(directory, names[0]));
    const tamperedPath = join(directory, names[1]);
    const tampered = JSON.parse(readFileSync(tamperedPath, "utf8"));
    tampered.unexpected = true;
    writeCanonical(tamperedPath, tampered);
    const before = snapshot(root);
    providerMock.complete.mockRejectedValue(new Error("unexpected AI call"));
    const input = replayInputs(root);
    await expect(repairAndAuditOfficialAnswers(
      input.entry,
      input.problem,
      input.solution,
      root,
      input.classified,
      input.solutions
    )).rejects.toThrow("legacy classification repair exact envelope가 다릅니다");
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(snapshot(root)).toEqual(before);
  });
});
