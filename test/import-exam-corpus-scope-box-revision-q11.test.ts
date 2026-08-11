import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PDFDocument } from "pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";

const providerMock = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("../src/codex-provider", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/codex-provider")>(),
  getCodexProvider: () => ({ complete: providerMock.complete }),
}));

import type { QuizItemEx, SolutionItem } from "../src/claude";
import {
  CLASSIFIER_DIGEST,
  CLASSIFIER_VERSION,
  PROBLEM_SCOPE_BOX_REVISION_ALLOWLIST,
  PROBLEM_SCOPE_BOX_REVISION_PROMPT_DIGEST,
  PROBLEM_SCOPE_BOX_REVISION_VERSION,
  PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST,
  applyAllowlistedProblemScopeBoxRevision,
  assertNoCommittedReceiptForFilteredResult,
  assertNoReceiptResultConflict,
  baseDifficultyByQuestionKey,
  canonicalEvidenceHash,
  matchOfficialSolutions,
  parseCorpusManifest,
  parseDecisions,
  repairAndAuditOfficialAnswers,
  resolveOfficialAnswer,
  writeAnswerAttestation,
  type ClassifiedQuestion,
  type PdfEvidence,
} from "../scripts/import-exam-corpus";

const liveState = join(process.cwd(), "data/import-exam-corpus/b4eeaf53cd6024aa180d1f37");
const available = existsSync(join(liveState, "problem.pdf")) && existsSync(join(liveState, "solution.pdf"));
let roots: string[] = [];

afterEach(() => {
  providerMock.complete.mockReset();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function fixtureInputs(root: string) {
  const entry = parseCorpusManifest({
    schemaVersion: 2,
    entries: [JSON.parse(readFileSync(join(root, "entry.json"), "utf8")).entry],
  }).entries[0];
  const downloads = JSON.parse(readFileSync(join(root, "downloads.json"), "utf8"));
  const problem: PdfEvidence = {
    ...downloads.problem,
    path: join(root, "problem.pdf"),
    resolvedUrl: downloads.problem.requestedUrl,
  };
  const solution: PdfEvidence = {
    ...downloads.solution,
    path: join(root, "solution.pdf"),
    resolvedUrl: downloads.solution.requestedUrl,
  };
  const questions = JSON.parse(readFileSync(join(root, "problem-chunks/v2-0000.json"), "utf8"))
    .items as QuizItemEx[];
  const decisions = parseDecisions(
    JSON.parse(readFileSync(
      join(root, `classification-chunks/v${CLASSIFIER_VERSION}-0000-${CLASSIFIER_DIGEST}.json`),
      "utf8"
    )).items,
    questions,
    entry
  );
  const byKey = new Map(decisions.map((decision) => [decision.key, decision]));
  const classified: ClassifiedQuestion[] = questions.map((question) => ({
    question,
    classification: byKey.get(`${question.page}:${Number(question.number)}`)!,
  }));
  const solutions = readdirSync(join(root, "solution-chunks"))
    .filter((name) => /^v3-\d{4}\.json$/u.test(name))
    .sort()
    .flatMap((name) => JSON.parse(readFileSync(join(root, "solution-chunks", name), "utf8")).items) as
    SolutionItem[];
  return { entry, problem, solution, classified, solutions };
}

function files(root: string, path = root): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? files(root, child) : [relative(root, child)];
  }).sort();
}

function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(files(root).map((path) => [
    path,
    lstatSync(join(root, path)).isSymbolicLink()
      ? `symlink:${readlinkSync(join(root, path))}`
      : createHash("sha256").update(readFileSync(join(root, path))).digest("hex"),
  ]));
}

describe.skipIf(!available)("Q11 scope box revision", () => {
  it("pins an exact box-only correction", () => {
    expect(PROBLEM_SCOPE_BOX_REVISION_VERSION).toBe(1);
    expect(PROBLEM_SCOPE_BOX_REVISION_PROMPT_DIGEST).toMatch(/^[a-f0-9]{64}$/u);
    expect(PROBLEM_SCOPE_BOX_REVISION_ALLOWLIST).toEqual([expect.objectContaining({
      entryId: "ebsi:5577055",
      key: "4:11",
      views: [{
        sourcePage: 4,
        rect: [0.07, 0.12, 0.50, 0.36],
        label: "p4 Q11 full stem, graph, and choices",
      }],
      beforeBox: [0.12, 0.27],
      afterBox: [0.12, 0.36],
      failedScopeArtifactHash: "a91d5a64c9dc71d6ea1b3521d031000c9f20b6c1f9c7ce189ea208b7bb901cc4",
      failedScopeItemHash: "696b03bb458b06aee5067cfded58c8ee6dbebfb43fc2d8a54c3e1371d1a0a50b",
      correctedQuestionHash: "35937a22d01677588672139e66a4e55a58a1711fa2b5ba7541d3181d009518d0",
    })]);
    const parent = JSON.parse(readFileSync(join(
      liveState,
      PROBLEM_SCOPE_BOX_REVISION_ALLOWLIST[0].parentRecoveryProblemArtifactPath
    ), "utf8")).item as QuizItemEx;
    const corrected = applyAllowlistedProblemScopeBoxRevision(
      "ebsi:5577055",
      PROBLEM_SCOPE_BOX_REVISION_ALLOWLIST[0].sourceHash,
      parent
    );
    expect(corrected).toEqual({ ...parent, box: [0.12, 0.36] });
    expect(canonicalEvidenceHash(corrected)).toBe(PROBLEM_SCOPE_BOX_REVISION_ALLOWLIST[0].correctedQuestionHash);
  });

  it("rejects a missing pinned scope parent before AI or writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "studywork-q11-scope-parent-missing-"));
    roots.push(root);
    cpSync(liveState, root, { recursive: true });
    rmSync(join(root, PROBLEM_SCOPE_BOX_REVISION_ALLOWLIST[0].failedScopeArtifactPath));
    const before = snapshot(root);
    providerMock.complete.mockRejectedValue(new Error("AI must not run"));
    const input = fixtureInputs(root);
    await expect(repairAndAuditOfficialAnswers(
      input.entry,
      input.problem,
      input.solution,
      root,
      input.classified,
      input.solutions
    )).rejects.toThrow(/scope box pinned failed scope/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(snapshot(root)).toEqual(before);
  });

  it("resolves the final Q11 scope disagreement from scope-box and solution evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "studywork-q11-terminal-scope-"));
    roots.push(root);
    cpSync(liveState, root, { recursive: true });
    const initial = fixtureInputs(root);
    const receipt = JSON.parse(readFileSync(join(root, "receipt.json"), "utf8"));
    const solutionByNumber = new Map(initial.solutions.map((item) => [String(Number(item.number)), item]));
    const terminalSpec = PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST.find((spec) =>
      spec.entryId === "ebsi:5577055" && spec.key === "4:11"
    )!;
    const calls = { child: 0, solution: 0, solutionRepair: 0, semantic: 0 };
    let crashSolutionRepair = true;
    providerMock.complete.mockImplementation(async (request: {
      schema?: { name?: string };
      prompt: string;
      file?: { path: string };
    }) => {
      if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
        calls.child++;
        expect(request.prompt).toContain("Final question:\n");
        expect(request.prompt).toContain(
          "page 1 is the official problem page 4 crop; pages 2-6 are official solution pages 1-5"
        );
        expect(request.prompt).not.toContain("canonical_subject=MATH_B");
        expect(request.prompt).not.toContain("IN_SCOPE_SINGLE_SUBJECT");
        expect(request.prompt).not.toContain("MIXED_SCOPE_LOG_FUNCTION_AND_COORDINATE_GEOMETRY");
        const [item] = JSON.parse(request.prompt.split("Final question:\n")[1]) as Array<{ key: string }>;
        expect(item.key).toBe("4:11");
        expect(request.file).toBeDefined();
        expect((await PDFDocument.load(readFileSync(request.file!.path))).getPageCount()).toBe(6);
        return { text: JSON.stringify([{
          key: "4:11",
          status: "exact",
          evidence: "공식 문제 crop의 전체 문항·그래프·선택지가 정확히 일치한다.",
          scopeDecision: "reject",
          scopeConfidence: 0.99,
          scopeEvidence: "공식 해설은 로그함수와 제외 대상 좌표기하의 중점·선분 길이를 함께 사용한다.",
        }]) };
      }
      if (request.schema?.name === "studywork_exam_corpus_solution_fidelity") {
        calls.solution++;
        const inputs = JSON.parse(request.prompt.split("Accepted solutions:\n")[1]) as Array<{
          key: string;
          source_page: number;
          raw_answer: string;
        }>;
        return { text: JSON.stringify(inputs.map((item) => ({
          key: item.key,
          sourcePage: item.source_page,
          answerStatus: item.key === "2:5" && item.raw_answer === "$\\sqrt2$" ? "mismatch" : "exact",
          explanationStatus: "exact",
          evidence: item.key === "2:5" && item.raw_answer === "$\\sqrt2$"
            ? "공식 1쪽은 세제곱근 2인데 base raw answer는 제곱근 2다."
            : "공식 해설의 답과 전체 설명이 일치한다.",
        }))) };
      }
      if (request.schema?.name === "studywork_solution_file_items") {
        calls.solutionRepair++;
        if (crashSolutionRepair) throw new Error("seeded crash after Q11 terminal child");
        return { text: JSON.stringify([{
          ...solutionByNumber.get("5")!,
          answer: "$\\sqrt[3]{2}$",
        }]) };
      }
      if (request.schema?.name === "studywork_exam_corpus_semantic_choice_check") {
        calls.semantic++;
        const inputs = JSON.parse(request.prompt.split("Items:\n")[1]) as Array<{
          key: string;
          choices: string[];
        }>;
        return { text: JSON.stringify(inputs.map((item) => ({
          key: item.key,
          status: "resolved",
          choiceIndex: resolveOfficialAnswer(
            { qtype: "mcq", choices: item.choices } as QuizItemEx,
            solutionByNumber.get(item.key.split(":")[1])!.answer
          ).choiceIndex! + 1,
          evidence: "공식 해설의 결론과 한 선택지가 유일하게 일치한다.",
        }))) };
      }
      throw new Error(`unexpected AI call: ${request.schema?.name ?? "unknown"}`);
    });
    const run = () => {
      const input = fixtureInputs(root);
      return repairAndAuditOfficialAnswers(
        input.entry,
        input.problem,
        input.solution,
        root,
        input.classified,
        input.solutions
      );
    };

    await expect(run()).rejects.toThrow("seeded crash after Q11 terminal child");
    expect(calls.child).toBe(1);
    expect(calls.solutionRepair).toBe(1);
    const childDirectory = join(root, "problem-terminal-fidelity-adjudications");
    expect(readdirSync(childDirectory)).toHaveLength(1);

    crashSolutionRepair = false;
    calls.child = 0;
    calls.solution = 0;
    calls.solutionRepair = 0;
    calls.semantic = 0;
    const result = await run();
    expect(calls.child).toBe(0);
    expect(calls.solutionRepair).toBe(1);
    expect(result.problemTerminalFidelityItems).toHaveLength(30);
    expect(result.problemTerminalFidelityItems.find((item) => item.key === "4:11")).toMatchObject({
      status: "exact",
      scopeDecision: "reject",
    });
    const q11 = result.classified.find((item) => item.classification.key === "4:11")!;
    expect(canonicalEvidenceHash(q11.question)).toBe(terminalSpec.parentQuestionHash);
    expect(canonicalEvidenceHash(q11.classification)).toBe(terminalSpec.parentClassificationHash);
    expect(q11.classification).toMatchObject({
      decision: "reject",
      canonical_subject: null,
      curriculum_course: null,
      domain: null,
      achievement_codes: [],
      transcription_status: "exact",
    });
    const terminalAdjudication = result.repairs.find((repair) => repair.key === "4:11")!.terminalAdjudication!;
    expect(terminalAdjudication).toMatchObject({
      parentKind: "scope-box",
      parentScopeAdjudicationHash: terminalSpec.parentScopeAdjudicationHash,
      parentScopeBoxEvidenceHash: terminalSpec.parentScopeBoxEvidenceHash,
      sourceEvidence: { kind: "scope-box-crop", sha256: "135d148a90e2695499ef1c1439cfb8aaf19a7a979470dd2d5f40270731793086" },
      baseSolutionCheckpoint: {
        path: "solution-chunks/v3-0000.json",
        sha256: "7e463c412565efc1a07c56dc3324da478426ad98822b31c95d586fee87391339",
      },
      baseSolutionItemHash: "ccf1b5bb896164a0466f3b1cd7d3a32463b07b0e640f952c05d14fb04dd74646",
      solutionContextFrom: 1,
      solutionContextTo: 5,
    });
    const childPath = join(root, terminalAdjudication.adjudicationArtifact.path);
    const childBytes = readFileSync(childPath);
    const childCheckpoint = JSON.parse(childBytes.toString("utf8"));
    expect(childCheckpoint.items[0]).toMatchObject({ status: "exact", scopeDecision: "reject" });
    expect(childCheckpoint.basis).toMatchObject({
      parentScopeAdjudicationHash: terminalSpec.parentScopeAdjudicationHash,
      parentScopeBoxEvidenceHash: terminalSpec.parentScopeBoxEvidenceHash,
      solutionContextFrom: 1,
      solutionContextTo: 5,
    });
    expect(result.auditPath).toMatch(/^answer-audit\/v5-/u);
    const audit = JSON.parse(readFileSync(join(root, result.auditPath!), "utf8"));
    expect(audit.repairs.find((repair: { key: string }) => repair.key === "4:11"))
      .toMatchObject({ terminalAdjudication: { parentKind: "scope-box" } });
    expect(matchOfficialSolutions(
      initial.entry,
      result.classified,
      result.solutions,
      baseDifficultyByQuestionKey(initial.classified)
    ).some((item) => item.printedNumber === "11")).toBe(false);
    expect((await writeAnswerAttestation(
      root,
      initial.entry.id,
      initial.problem.sha256,
      initial.solution.sha256,
      receipt,
      result
    )).path).toMatch(/^answer-attestation\/v5-/u);

    providerMock.complete.mockReset().mockRejectedValue(new Error("replay AI call"));
    const replay = await run();
    expect(replay.auditHash).toBe(result.auditHash);
    expect(providerMock.complete).not.toHaveBeenCalled();

    const tampered = JSON.parse(childBytes.toString("utf8"));
    tampered.unexpected = true;
    writeFileSync(childPath, `${JSON.stringify(tampered, null, 2)}\n`);
    await expect(run()).rejects.toThrow(/terminal fidelity adjudication checkpoint\/evidence/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    writeFileSync(childPath, childBytes);

    rmSync(childPath);
    const orphanPath = join(
      childDirectory,
      "v1-0004-0011-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json"
    );
    writeFileSync(orphanPath, "{}\n");
    const beforeOrphan = snapshot(root);
    await expect(run()).rejects.toThrow(/terminal fidelity adjudication orphan\/conflict/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(snapshot(root)).toEqual(beforeOrphan);
    rmSync(orphanPath);
    writeFileSync(childPath, childBytes);

    const parentClassificationPath = join(root, terminalSpec.parentClassificationArtifactPath);
    const parentClassificationBytes = readFileSync(parentClassificationPath);
    const parentTamper = JSON.parse(parentClassificationBytes.toString("utf8"));
    parentTamper.unexpected = true;
    writeFileSync(parentClassificationPath, `${JSON.stringify(parentTamper, null, 2)}\n`);
    await expect(run()).rejects.toThrow(/scope box classification revision (?:checkpoint|authority)/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    writeFileSync(parentClassificationPath, parentClassificationBytes);

    const failedTerminalPath = join(root, terminalSpec.failedTerminalPath);
    const failedTerminalBytes = readFileSync(failedTerminalPath);
    const terminalTamper = JSON.parse(failedTerminalBytes.toString("utf8"));
    terminalTamper.unexpected = true;
    writeFileSync(failedTerminalPath, `${JSON.stringify(terminalTamper, null, 2)}\n`);
    await expect(run()).rejects.toThrow(/terminal 문제 fidelity|failed terminal fidelity/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    writeFileSync(failedTerminalPath, failedTerminalBytes);
  }, 120_000);

  it("crash-resumes the hidden box classifier and replays without AI", async () => {
    const root = mkdtempSync(join(tmpdir(), "studywork-q11-scope-box-"));
    roots.push(root);
    cpSync(liveState, root, { recursive: true });
    for (const directory of [
      "problem-scope-box-evidence",
      "problem-scope-box-revisions",
      "classification-scope-box-revisions",
    ]) rmSync(join(root, directory), { recursive: true });
    const terminalDirectory = join(root, "problem-terminal-fidelity");
    for (const name of readdirSync(terminalDirectory)) {
      const checkpoint = JSON.parse(readFileSync(join(terminalDirectory, name), "utf8"));
      if (checkpoint.inputs.some((item: { key: string; box: unknown }) =>
        item.key === "4:11" && canonicalEvidenceHash(item.box) === canonicalEvidenceHash([0.12, 0.36])
      )) rmSync(join(terminalDirectory, name));
    }
    const initial = fixtureInputs(root);
    const receipt = JSON.parse(readFileSync(join(root, "receipt.json"), "utf8"));
    const historicalTerminalFiles = new Set(readdirSync(join(root, "problem-terminal-fidelity")));
    const terminalTemplate = JSON.parse(readFileSync(join(
      root,
      PROBLEM_SCOPE_BOX_REVISION_ALLOWLIST[0].triggerTerminalPath
    ), "utf8"));
    const scopeByKey = new Map<string, {
      scopeDecision: "accept" | "reject" | "review";
      scopeConfidence: number;
      scopeEvidence: string;
    }>(terminalTemplate.items.map((item: {
      key: string;
      scopeDecision: "accept" | "reject" | "review";
      scopeConfidence: number;
      scopeEvidence: string;
    }) => [item.key, item]));
    const solutionByNumber = new Map(initial.solutions.map((item) => [String(Number(item.number)), item]));
    const calls = { classification: 0, terminal: 0, solution: 0, solutionRepair: 0, semantic: 0 };
    let crashClassification = true;
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        calls.classification++;
        expect(request.prompt).toContain('"box":[0.12,0.36]');
        expect(request.prompt).not.toContain("box [0.12,0.27]은 아래쪽");
        if (crashClassification) throw new Error("seeded scope box classification crash");
        return { text: JSON.stringify([{
          key: "4:11",
          decision: "reject",
          canonical_subject: null,
          curriculum_course: null,
          domain: null,
          achievement_codes: [],
          confidence: 0.99,
          reason_codes: [
            "LOGARITHMIC_FUNCTION_REQUIRED",
            "EXCLUDED_COORDINATE_GEOMETRY_REQUIRED",
            "ONE_EXCLUDED_DEPENDENCY_REJECTS_WHOLE",
          ],
          transcription_status: "exact",
          transcription_evidence: "공식 4쪽 crop은 stem, 전체 로그 그래프와 다섯 선택지를 모두 포함한다.",
        }]) };
      }
      if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
        calls.terminal++;
        const inputs = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{ key: string }>;
        return { text: JSON.stringify(inputs.map((input) => {
          const scope = scopeByKey.get(input.key)!;
          return {
            key: input.key,
            status: "exact",
            evidence: input.key === "4:11"
              ? "공식 4쪽의 stem, graph, labels, choices와 확장 box가 모두 일치한다."
              : "공식 source pixels와 일치한다.",
            scopeDecision: scope.scopeDecision,
            scopeConfidence: scope.scopeConfidence,
            scopeEvidence: scope.scopeEvidence,
          };
        })) };
      }
      if (request.schema?.name === "studywork_exam_corpus_solution_fidelity") {
        calls.solution++;
        const inputs = JSON.parse(request.prompt.split("Accepted solutions:\n")[1]) as Array<{
          key: string;
          source_page: number;
        }>;
        return { text: JSON.stringify(inputs.map((item) => ({
          key: item.key,
          sourcePage: item.source_page,
          answerStatus: item.key === "2:5" && calls.solution === 1 ? "mismatch" : "exact",
          explanationStatus: "exact",
          evidence: item.key === "2:5" && calls.solution === 1
            ? "공식 1쪽은 a=세제곱근 2인데 base raw answer는 제곱근 2다."
            : "공식 해설의 답과 전체 설명이 일치한다.",
        }))) };
      }
      if (request.schema?.name === "studywork_solution_file_items") {
        calls.solutionRepair++;
        expect(request.prompt).toContain("printed solution 5");
        expect(request.prompt).toContain("original document pages 1-5");
        return { text: JSON.stringify([{
          ...solutionByNumber.get("5")!,
          answer: "$\\sqrt[3]{2}$",
        }]) };
      }
      if (request.schema?.name === "studywork_exam_corpus_semantic_choice_check") {
        calls.semantic++;
        const inputs = JSON.parse(request.prompt.split("Items:\n")[1]) as Array<{
          key: string;
          choices: string[];
        }>;
        return { text: JSON.stringify(inputs.map((item) => ({
          key: item.key,
          status: "resolved",
          choiceIndex: resolveOfficialAnswer(
            { qtype: "mcq", choices: item.choices } as QuizItemEx,
            solutionByNumber.get(item.key.split(":")[1])!.answer
          ).choiceIndex! + 1,
          evidence: "공식 해설의 결론과 한 선택지가 유일하게 일치한다.",
        }))) };
      }
      throw new Error(`unexpected AI call: ${request.schema?.name ?? "unknown"}`);
    });
    const run = () => {
      const input = fixtureInputs(root);
      return repairAndAuditOfficialAnswers(
        input.entry,
        input.problem,
        input.solution,
        root,
        input.classified,
        input.solutions
      );
    };

    await expect(run()).rejects.toThrow("seeded scope box classification crash");
    expect(calls).toEqual({ classification: 1, terminal: 0, solution: 0, solutionRepair: 0, semantic: 0 });
    expect(readdirSync(join(root, "problem-scope-box-evidence"))).toHaveLength(3);
    expect(readdirSync(join(root, "problem-scope-box-revisions"))).toHaveLength(1);
    expect(existsSync(join(root, "classification-scope-box-revisions"))).toBe(false);

    crashClassification = false;
    calls.classification = 0;
    const result = await run();
    expect(calls).toEqual({ classification: 1, terminal: 1, solution: 2, solutionRepair: 1, semantic: 0 });
    const freshTerminalFiles = readdirSync(join(root, "problem-terminal-fidelity"))
      .filter((name) => !historicalTerminalFiles.has(name));
    expect(freshTerminalFiles).toHaveLength(1);
    const finalTerminal = JSON.parse(readFileSync(join(root, "problem-terminal-fidelity", freshTerminalFiles[0]), "utf8"));
    expect(finalTerminal.items).toHaveLength(30);
    expect(new Set(finalTerminal.items.map((item: { key: string }) => item.key)).size).toBe(30);
    expect(finalTerminal.items.find((item: { key: string }) => item.key === "4:11")).toMatchObject({
      status: "exact",
      scopeDecision: "reject",
    });
    const problemPath = join(root, "problem-scope-box-revisions", readdirSync(
      join(root, "problem-scope-box-revisions")
    )[0]);
    const problemCheckpoint = JSON.parse(readFileSync(problemPath, "utf8"));
    expect(problemCheckpoint.item.box).toEqual([0.12, 0.36]);
    expect(canonicalEvidenceHash(problemCheckpoint.item))
      .toBe(PROBLEM_SCOPE_BOX_REVISION_ALLOWLIST[0].correctedQuestionHash);
    const classificationPath = join(root, "classification-scope-box-revisions", readdirSync(
      join(root, "classification-scope-box-revisions")
    )[0]);
    const classificationCheckpoint = JSON.parse(readFileSync(classificationPath, "utf8"));
    expect(classificationCheckpoint.items[0]).toMatchObject({
      decision: "reject",
      canonical_subject: null,
      curriculum_course: null,
      domain: null,
      achievement_codes: [],
      transcription_status: "exact",
    });
    const cropCheckpointPath = join(root, "problem-scope-box-evidence", readdirSync(
      join(root, "problem-scope-box-evidence")
    ).find((name) => name.endsWith(".json"))!);
    const cropCheckpoint = JSON.parse(readFileSync(cropCheckpointPath, "utf8"));
    expect(cropCheckpoint.views).toEqual([expect.objectContaining({
      rect: [0.07, 0.12, 0.50, 0.36], pixelWidth: 3017, pixelHeight: 2382,
    })]);
    expect(readdirSync(join(root, "problem-recoveries")).filter((name) => name.includes("0004-0011")))
      .toHaveLength(1);
    const q5Repair = result.solutionRepairs.find((repair) => repair.key === "2:5")!;
    expect(q5Repair).toMatchObject({
      baseSolutionItemHash: "b674ac8edb4c2dece403bdd09c28e5e4ab11832c024468e72964f90136b805a7",
      effectiveSolutionItemHash: "6fd09d50cd90a6e59e7a39a7fa298d3df7b330826138f2b295c26bdcaae087b6",
      baseRawAnswerHash: "1b65c648e3566876e3af03395e859b3c4d2ff8768568d590f7cf76172b2d5839",
      effectiveRawAnswerHash: "18eb660efcd50dde8e19c9c890afe1d9b15fb7a53f6746488c65e9468ecc9cf9",
      repairArtifact: {
        path: "solution-repairs/v1-0001-0005-0827ec5e583fdcf147a8faeef01aa0657d3000783b2db663a746bca67a783717.json",
        sha256: "6c691b4032540848bdd5a2e0f88b9ec136b14558dbed04f8a0afd56ab2f8665f",
      },
      fidelityArtifact: {
        path: "solution-fidelity-repairs/v1-0001-0005-0827ec5e583fdcf147a8faeef01aa0657d3000783b2db663a746bca67a783717-" +
          "6fd09d50cd90a6e59e7a39a7fa298d3df7b330826138f2b295c26bdcaae087b6.json",
        sha256: "6517e8dceae274c66119f16119590411adb7b02705ef2524cd0fac72405a4c45",
      },
    });
    expect(result.solutionFidelityItems.find((item) => item.key === "2:5")).toMatchObject({
      answerStatus: "exact",
      explanationStatus: "exact",
    });
    expect(result.auditPath).toMatch(/^answer-audit\/v5-/u);
    const audit = JSON.parse(readFileSync(join(root, result.auditPath!), "utf8"));
    expect(audit.repairs.find((repair: { key: string }) => repair.key === "4:11"))
      .toMatchObject({ revision: { recovery: { scopeAdjudication: { boxRevision: {
        effectiveQuestionHash: PROBLEM_SCOPE_BOX_REVISION_ALLOWLIST[0].correctedQuestionHash,
      } } } } });
    expect(audit.problemTerminalFidelityItems).toHaveLength(30);
    const imported = matchOfficialSolutions(
      initial.entry,
      result.classified,
      result.solutions,
      baseDifficultyByQuestionKey(initial.classified)
    );
    expect(imported.some((item) => item.printedNumber === "11")).toBe(false);
    rmSync(join(root, "receipt.json"));
    expect(() => assertNoCommittedReceiptForFilteredResult(root)).not.toThrow();
    const attestation = await writeAnswerAttestation(
      root,
      initial.entry.id,
      initial.problem.sha256,
      initial.solution.sha256,
      receipt,
      result
    );
    expect(attestation.path).toMatch(/^answer-attestation\/v5-/u);
    expect(() => assertNoCommittedReceiptForFilteredResult(root)).toThrow("명시적 migration");
    writeFileSync(join(root, "result.json"), "{}\n");
    expect(() => assertNoReceiptResultConflict(root)).toThrow("terminal conflict");
    rmSync(join(root, "result.json"));

    const aliasDirectory = join(root, "authority-alias");
    mkdirSync(aliasDirectory);
    const cropAliasRelativePath = "authority-alias/crop.json";
    cpSync(cropCheckpointPath, join(root, cropAliasRelativePath));
    const cropAliasResult = structuredClone(result);
    cropAliasResult.repairs.find((repair) => repair.key === "4:11")!
      .revision!.recovery!.scopeAdjudication!.boxRevision!.cropEvidenceArtifact.path = cropAliasRelativePath;
    await expect(writeAnswerAttestation(
      root,
      initial.entry.id,
      initial.problem.sha256,
      initial.solution.sha256,
      receipt,
      cropAliasResult
    )).rejects.toThrow(/scope box crop canonical path/u);

    const scopeAliasRelativePath = "authority-alias/scope.json";
    cpSync(
      join(root, PROBLEM_SCOPE_BOX_REVISION_ALLOWLIST[0].failedScopeArtifactPath),
      join(root, scopeAliasRelativePath)
    );
    const scopeAliasResult = structuredClone(result);
    const scopeAlias = scopeAliasResult.repairs.find((repair) => repair.key === "4:11")!
      .revision!.recovery!.scopeAdjudication!;
    scopeAlias.classificationArtifact.path = scopeAliasRelativePath;
    const { boxRevision: scopeAliasBoxRevision, ...scopeAliasParent } = scopeAlias;
    scopeAliasBoxRevision!.parentScopeAdjudicationHash = canonicalEvidenceHash(scopeAliasParent);
    await expect(writeAnswerAttestation(
      root,
      initial.entry.id,
      initial.problem.sha256,
      initial.solution.sha256,
      receipt,
      scopeAliasResult
    )).rejects.toThrow(/scope box parent evidence|problem scope adjudication/u);

    providerMock.complete.mockReset().mockRejectedValue(new Error("replay AI call"));
    const replay = await run();
    expect(replay.auditHash).toBe(result.auditHash);
    expect(providerMock.complete).not.toHaveBeenCalled();

    const classificationBytes = readFileSync(classificationPath);
    const tampered = JSON.parse(classificationBytes.toString("utf8"));
    tampered.unexpected = true;
    writeFileSync(classificationPath, `${JSON.stringify(tampered, null, 2)}\n`);
    await expect(run()).rejects.toThrow(/scope box classification revision checkpoint/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    writeFileSync(classificationPath, classificationBytes);

    const cropViewPath = join(root, "problem-scope-box-evidence", readdirSync(
      join(root, "problem-scope-box-evidence")
    ).find((name) => name.endsWith(".png"))!);
    const cropViewBytes = readFileSync(cropViewPath);
    writeFileSync(cropViewPath, Buffer.concat([cropViewBytes, Buffer.from("tampered")]));
    const beforeCropTamper = snapshot(root);
    await expect(run()).rejects.toThrow(/crop evidence view file hash|scope box crop view/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(snapshot(root)).toEqual(beforeCropTamper);
    writeFileSync(cropViewPath, cropViewBytes);

    for (const path of [
      problemPath,
      classificationPath,
      ...readdirSync(join(root, "problem-scope-box-evidence")).map((name) =>
        join(root, "problem-scope-box-evidence", name)
      ),
    ]) rmSync(path);
    const orphanDirectory = join(root, "problem-scope-box-revisions");
    const orphanPath = join(orphanDirectory, "v1-0004-0011-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json");
    writeFileSync(orphanPath, "{}\n");
    const beforeOrphan = snapshot(root);
    await expect(run()).rejects.toThrow(/scope box.*orphan\/conflict|crop evidence 없이/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(snapshot(root)).toEqual(beforeOrphan);

    rmSync(orphanDirectory, { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), "studywork-q11-scope-box-outside-"));
    roots.push(outside);
    symlinkSync(outside, orphanDirectory);
    await expect(run()).rejects.toThrow(/scope box revision 디렉터리가 유효하지/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(readdirSync(outside)).toEqual([]);
  }, 120_000);
});
