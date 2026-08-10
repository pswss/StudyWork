import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readlinkSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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
  PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST,
  PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_PROMPT_DIGEST,
  PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_VERSION,
  canonicalEvidenceHash,
  parseCorpusManifest,
  parseDecisions,
  repairAndAuditOfficialAnswers,
  writeAnswerAttestation,
  type ClassifiedQuestion,
  type PdfEvidence,
} from "../scripts/import-exam-corpus";

const liveState = join(
  process.cwd(),
  "data/import-exam-corpus/7755c70fefaa45f755086e2b"
);
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

describe.skipIf(!available)("Q8/Q20 terminal fidelity adjudication", () => {
  it("pins the exact false-negative terminal authority", () => {
    expect(PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_VERSION).toBe(1);
    expect(PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_PROMPT_DIGEST).toMatch(/^[a-f0-9]{64}$/u);
    expect(PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST).toEqual([
      expect.objectContaining({
        entryId: "ebsi:5525984",
        key: "3:8",
        parentKind: "manual",
        parentQuestionHash: "fbbd4e46ac18d85ae31cbe396c236f8f7a525bc3af467bbb407323ea2a1317bb",
        parentClassificationHash: "d8e26c108aba6322e9dd8a5c633d776bbf884c07414b24dd21a58d89d44f6ee6",
        failedTerminalArtifactHash: "c4f64ef621cc454e232fa42af9605fb6af83e0fba5eb4a8c6173c774412fd8c9",
        failedItemHash: "4067ed57d53fd70705c4125f0c2ff3204efaf02885d8f8340566381a380a9db6",
      }),
      expect.objectContaining({
        entryId: "ebsi:5525984",
        key: "8:20",
        parentKind: "repair",
        parentQuestionHash: "d93c3421dda810dac35f5584575a144c3d8e269619a354b8e5cfa5f701f3465a",
        parentClassificationHash: "d5d57d9a6899f7790172a79547771760f1f7fd938559db6e353e2423dea60021",
        failedTerminalArtifactHash: "c4f64ef621cc454e232fa42af9605fb6af83e0fba5eb4a8c6173c774412fd8c9",
        failedItemHash: "21a1875add25568fe3b26eeea03c0b2a785c524ac71c5a35d6097f2f71d58506",
      }),
    ]);
  });

  it("crash-resumes two hidden terminal children and replays without AI", async () => {
    const root = mkdtempSync(join(tmpdir(), "studywork-q8-terminal-adjudication-"));
    roots.push(root);
    cpSync(liveState, root, { recursive: true });
    const input = fixtureInputs(root);
    const run = () => {
      const current = fixtureInputs(root);
      return repairAndAuditOfficialAnswers(
        current.entry,
        current.problem,
        current.solution,
        root,
        current.classified,
        current.solutions
      );
    };
    const receipt = JSON.parse(readFileSync(join(root, "receipt.json"), "utf8"));
    const calls = { adjudication: [] as string[], solution: 0, semantic: 0 };
    const answerByNumber = new Map(input.solutions.map((item) => [String(Number(item.number)), item.answer]));
    let crashBeforeQ20Child = true;
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
        expect(request.prompt).toContain("Final question:\n");
        expect(request.prompt).not.toContain("y=2에도 수평 점선이 있다고 기술했다");
        expect(request.prompt).not.toContain("최고차항이 양수인");
        const [input] = JSON.parse(request.prompt.split("Final question:\n")[1]) as Array<{ key: string }>;
        calls.adjudication.push(input.key);
        if (input.key === "8:20" && crashBeforeQ20Child) throw new Error("seeded crash before Q20 child");
        return { text: JSON.stringify([{
          key: input.key,
          status: "exact",
          evidence: input.key === "3:8"
            ? "공식 3쪽 graph pixels에는 y=2 수평 점선과 열린 점 (1,2)가 모두 보인다."
            : "공식 8쪽에는 최고차항의 계수가 양수인 삼차함수라고 적혀 있다.",
          scopeDecision: "accept",
          scopeConfidence: 0.99,
          scopeEvidence: input.key === "3:8"
            ? "수학Ⅱ 함수의 극한에서 그래프의 좌극한과 우극한을 읽는 문항이다."
            : "수학Ⅱ 미분법의 함수 증가·감소와 극값을 다루는 문항이다.",
        }]) };
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
          answerStatus: "exact",
          explanationStatus: "exact",
          evidence: "공식 해설의 답과 설명이 일치한다.",
        }))) };
      }
      if (request.schema?.name === "studywork_exam_corpus_semantic_choice_check") {
        calls.semantic++;
        const inputs = JSON.parse(request.prompt.split("Items:\n")[1]) as Array<{ key: string }>;
        const markers = ["①", "②", "③", "④", "⑤"];
        return { text: JSON.stringify(inputs.map((item) => ({
          key: item.key,
          status: "resolved",
          choiceIndex: markers.indexOf(answerByNumber.get(item.key.split(":")[1])!) + 1,
          evidence: "공식 해설의 결론이 해당 선택지와 유일하게 일치한다.",
        }))) };
      }
      throw new Error(`unexpected AI call: ${request.schema?.name ?? "unknown"}: ${request.prompt.slice(0, 500)}`);
    });

    await expect(run()).rejects.toThrow("seeded crash before Q20 child");
    expect(calls).toEqual({ adjudication: ["3:8", "8:20"], solution: 0, semantic: 0 });
    const childDirectory = join(root, "problem-terminal-fidelity-adjudications");
    expect(readdirSync(childDirectory)).toHaveLength(1);

    crashBeforeQ20Child = false;
    calls.adjudication = [];
    calls.solution = 0;
    calls.semantic = 0;
    const result = await run();
    expect(calls).toEqual({ adjudication: ["8:20"], solution: 1, semantic: 1 });
    expect(readdirSync(childDirectory)).toHaveLength(2);
    expect(result.effectiveCorpusHash)
      .toBe("1e076c1128fc58f956f12db80716af215f2cedf605c1816acc5e234d0c320021");
    expect(result.problemTerminalFidelityItems).toHaveLength(30);
    expect(new Set(result.problemTerminalFidelityItems.map((item) => item.key)).size).toBe(30);
    for (const key of ["3:8", "8:20"]) {
      expect(result.problemTerminalFidelityItems.find((item) => item.key === key)).toMatchObject({
        status: "exact",
        scopeDecision: "accept",
      });
    }
    const q8Repair = result.repairs.find((item) => item.key === "3:8")!;
    const q20Repair = result.repairs.find((item) => item.key === "8:20")!;
    const q8Adjudication = q8Repair.terminalAdjudication!;
    const q20Adjudication = q20Repair.terminalAdjudication!;
    expect(q8Adjudication).toMatchObject({
      failedTerminalCheckpoint: {
        path: PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST[0].failedTerminalPath,
        sha256: PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST[0].failedTerminalArtifactHash,
      },
      adjudicationArtifact: {
        path: expect.stringMatching(/^problem-terminal-fidelity-adjudications\/v1-0003-0008-/u),
      },
    });
    expect(q20Adjudication).toMatchObject({
      failedTerminalCheckpoint: {
        path: PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST[1].failedTerminalPath,
        sha256: PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST[1].failedTerminalArtifactHash,
      },
      adjudicationArtifact: {
        path: expect.stringMatching(/^problem-terminal-fidelity-adjudications\/v1-0008-0020-/u),
      },
    });
    expect(canonicalEvidenceHash(result.classified.find((item) => item.classification.key === "3:8")!.question))
      .toBe(PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST[0].parentQuestionHash);
    expect(canonicalEvidenceHash(result.classified.find((item) => item.classification.key === "3:8")!.classification))
      .toBe(PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST[0].parentClassificationHash);
    expect(canonicalEvidenceHash(result.classified.find((item) => item.classification.key === "8:20")!.question))
      .toBe(PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST[1].parentQuestionHash);
    expect(canonicalEvidenceHash(result.classified.find((item) => item.classification.key === "8:20")!.classification))
      .toBe(PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST[1].parentClassificationHash);
    expect(q20Repair.revision).toBeUndefined();
    const audit = JSON.parse(readFileSync(join(root, result.auditPath!), "utf8"));
    expect(audit.repairs.filter((repair: { terminalAdjudication?: unknown }) => repair.terminalAdjudication))
      .toHaveLength(2);
    const attestation = await writeAnswerAttestation(
      root,
      input.entry.id,
      input.problem.sha256,
      input.solution.sha256,
      receipt,
      result
    );
    expect(attestation.path).toMatch(/^answer-attestation\/v5-/u);

    providerMock.complete.mockReset().mockRejectedValue(new Error("replay AI call"));
    const replay = await run();
    expect(replay.auditHash).toBe(result.auditHash);
    expect(providerMock.complete).not.toHaveBeenCalled();

    const q8ChildPath = join(root, q8Adjudication.adjudicationArtifact.path);
    const q20ChildPath = join(root, q20Adjudication.adjudicationArtifact.path);
    const q8ChildBytes = readFileSync(q8ChildPath);
    const q20ChildBytes = readFileSync(q20ChildPath);
    const childPath = q8ChildPath;
    const childBytes = q8ChildBytes;
    const tampered = JSON.parse(childBytes.toString("utf8"));
    tampered.unexpected = true;
    writeFileSync(childPath, `${JSON.stringify(tampered, null, 2)}\n`);
    await expect(run()).rejects.toThrow(/terminal fidelity adjudication.*(?:checkpoint|evidence|exact|hash)/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    writeFileSync(childPath, childBytes);

    rmSync(q8ChildPath);
    const tamperedQ20 = JSON.parse(q20ChildBytes.toString("utf8"));
    tamperedQ20.unexpected = true;
    writeFileSync(q20ChildPath, `${JSON.stringify(tamperedQ20, null, 2)}\n`);
    const beforeOrderedTamper = snapshot(root);
    await expect(run()).rejects.toThrow(/8:20 terminal fidelity adjudication checkpoint\/evidence/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(existsSync(q8ChildPath)).toBe(false);
    expect(snapshot(root)).toEqual(beforeOrderedTamper);
    writeFileSync(q8ChildPath, q8ChildBytes);
    writeFileSync(q20ChildPath, q20ChildBytes);

    rmSync(q8ChildPath);
    rmSync(q20ChildPath);
    const orphanName = "v1-0003-0008-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json";
    writeFileSync(join(childDirectory, orphanName), "{}\n");
    const beforeOrphan = snapshot(root);
    await expect(run()).rejects.toThrow(/terminal fidelity adjudication orphan\/conflict/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(snapshot(root)).toEqual(beforeOrphan);
    rmSync(join(childDirectory, orphanName));
    writeFileSync(q8ChildPath, q8ChildBytes);
    writeFileSync(q20ChildPath, q20ChildBytes);

    const cropViewPath = join(root, q8Repair.revision!.recovery!.manualAdjudication!.cropViews[0].artifact.path);
    const cropBytes = readFileSync(cropViewPath);
    rmSync(q8ChildPath);
    rmSync(q20ChildPath);
    writeFileSync(cropViewPath, Buffer.concat([cropBytes, Buffer.from("tampered")]));
    const beforeParentTamper = snapshot(root);
    await expect(run()).rejects.toThrow(/crop evidence view file hash/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(snapshot(root)).toEqual(beforeParentTamper);
    writeFileSync(cropViewPath, cropBytes);

    const q20ParentPath = join(root, PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST[1].parentProblemArtifactPath);
    const q20ParentBytes = readFileSync(q20ParentPath);
    const tamperedQ20Parent = JSON.parse(q20ParentBytes.toString("utf8"));
    tamperedQ20Parent.unexpected = true;
    writeFileSync(q20ParentPath, `${JSON.stringify(tamperedQ20Parent, null, 2)}\n`);
    const beforeQ20ParentTamper = snapshot(root);
    await expect(run()).rejects.toThrow(/(?:persisted problem repair|8:20 terminal fidelity parent problem)/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(snapshot(root)).toEqual(beforeQ20ParentTamper);
    writeFileSync(q20ParentPath, q20ParentBytes);

    rmSync(childDirectory, { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), "studywork-q8-terminal-outside-"));
    roots.push(outside);
    symlinkSync(outside, childDirectory);
    const beforeSymlink = snapshot(root);
    await expect(run()).rejects.toThrow(/terminal fidelity adjudication 디렉터리가 유효하지/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(snapshot(root)).toEqual(beforeSymlink);
    expect(lstatSync(childDirectory).isSymbolicLink()).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
  }, 90_000);
});
