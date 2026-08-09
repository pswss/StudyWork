import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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
} from "../scripts/import-exam-corpus";

const repository = join(import.meta.dirname, "..");
const liveRoot = join(repository, "data/import-exam-corpus");
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
const legacyV1ContextCase = { entryId: "ebsi:5525984", token: "7755c70fefaa45f755086e2b" } as const;
const legacySinglePreflightCase = { entryId: "ebsi:5643100", token: "194298dd83aaf47b6f3218fe" } as const;
const available = [...cases, deferredTerminalCase, legacyV1ContextCase, legacySinglePreflightCase]
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
    createHash("sha256").update(readFileSync(join(root, path))).digest("hex"),
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
  const classified = questions.map((question: { page: number; number: string }) => ({
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

describe.skipIf(!available)("persisted v2 repair graph hydration", () => {
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

  it("leaves a mixed v1-context repair checkpoint on the existing whole-checkpoint path", async () => {
    const root = mkdtempSync(join(tmpdir(), `studywork-persisted-${legacyV1ContextCase.token}-`));
    roots.push(root);
    cpSync(join(liveRoot, legacyV1ContextCase.token), root, { recursive: true });
    const before = Object.fromEntries(Object.entries(snapshot(root)).filter(([path]) =>
      /^(problem-repairs|problem-repair-batches|classification-repair-batches)\//u.test(path)
    ));
    providerMock.complete.mockRejectedValue(new Error("expected legacy normal-path call"));
    const input = replayInputs(root);

    await expect(repairAndAuditOfficialAnswers(
      input.entry,
      input.problem,
      input.solution,
      root,
      input.classified,
      input.solutions
    )).rejects.toThrow("expected legacy normal-path call");
    expect(providerMock.complete).toHaveBeenCalledTimes(1);
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
