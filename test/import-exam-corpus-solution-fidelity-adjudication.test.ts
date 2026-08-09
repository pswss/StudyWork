import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const providerMock = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("../src/codex-provider", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/codex-provider")>(),
  getCodexProvider: () => ({ complete: providerMock.complete }),
}));

import type { QuizItemEx, SolutionItem } from "../src/claude";
import {
  SOLUTION_REVISION_FIDELITY_ADJUDICATION_ALLOWLIST,
  SOLUTION_REVISION_FIDELITY_ADJUDICATION_VERSION,
  auditAcceptedSolutions,
  canonicalEvidenceHash,
  parseCorpusManifest,
  type ClassificationDecision,
  type PdfEvidence,
} from "../scripts/import-exam-corpus";

const LIVE_STATE = join(process.cwd(), "data/import-exam-corpus/bc7655b894a573179fae1c73");
const REQUIRED = [
  "entry.json",
  "problem.pdf",
  "solution.pdf",
  "problem-chunks/v2-0000.json",
  "classification-chunks/v5-0000-7bb7cb863c8c4855.json",
  "problem-terminal-fidelity/v2-0000-3f0f4625f5ee5ba0c627c2655ae751e7fdbd334e49143b552b1280b71abbdda6-15bcf83cec42ceb2f2fa4d0640538b6b29825938998e2f8dbf095bbd940afe66.json",
  "solution-chunks/v3-0000.json",
  "solution-chunks/v3-0001.json",
  "solution-chunks/v3-0002.json",
  "solution-fidelity/v1-0000-3f0f4625f5ee5ba0c627c2655ae751e7fdbd334e49143b552b1280b71abbdda6-07041f5c4c306e5cccea957f29035517be45f115a975ebcf8329009b4407816f.json",
  "solution-repairs/v1-0006-0020-6a1bcd6840735026cb442ce830c4264d9918f245a36bf54be159b77f958afd48.json",
  "solution-fidelity-repairs/v1-0006-0020-6a1bcd6840735026cb442ce830c4264d9918f245a36bf54be159b77f958afd48-08a3140a57921a9c64e95ac4b069114c5502db37e8cd060574ffc84ab1804021.json",
  "solution-revisions/v1-0006-0020-e3583527616f630a8814e871bc7c46c0d2bb4b9a86a7eb0959ccaa9ce4164717.json",
  "solution-fidelity-revisions/v1-0006-0020-00da6e80bdbbe87cbff4ce54b57737c77167f0e2764c64ae5c87c1972ef9c9dc-7ad16feb562bc2650dc29272ca0d842e4569b512acb7ae6dae122feb30ffa94a.json",
].map((path) => join(LIVE_STATE, path));

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
let root = "";

afterEach(() => {
  providerMock.complete.mockReset();
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

function copyAuthority(relativePath: string): void {
  const destination = join(root, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(LIVE_STATE, relativePath), destination);
}

function effectiveClassified(): Array<{ question: QuizItemEx; classification: ClassificationDecision }> {
  const terminal = JSON.parse(readFileSync(REQUIRED[5], "utf8")) as {
    effectiveCorpusHash: string;
    inputs: Array<{
      key: string;
      printed_number: string;
      source_page: number;
      qtype: QuizItemEx["qtype"];
      question: string;
      choices: string[];
      box: QuizItemEx["box"];
      figure: boolean;
      figure_description: string | null;
    }>;
  };
  const baseQuestions = JSON.parse(readFileSync(REQUIRED[3], "utf8")).items as QuizItemEx[];
  const baseDecisions = new Map<string, ClassificationDecision>(
    (JSON.parse(readFileSync(REQUIRED[4], "utf8")).items as ClassificationDecision[])
      .map((decision) => [decision.key, decision])
  );
  const repairedByQuestionHash = new Map<string, ClassificationDecision>();
  for (const name of readdirSync(join(LIVE_STATE, "classification-repair-batches"))) {
    const checkpoint = JSON.parse(readFileSync(join(LIVE_STATE, "classification-repair-batches", name), "utf8")) as {
      members: Array<{ key: string; effectiveQuestionHash: string }>;
      items: ClassificationDecision[];
    };
    const itemByKey = new Map(checkpoint.items.map((item) => [item.key, item]));
    for (const member of checkpoint.members) {
      repairedByQuestionHash.set(member.effectiveQuestionHash, itemByKey.get(member.key)!);
    }
  }
  const repairedQuestions = readdirSync(join(LIVE_STATE, "problem-repair-batches")).flatMap((name) =>
    JSON.parse(readFileSync(join(LIVE_STATE, "problem-repair-batches", name), "utf8")).items as QuizItemEx[]
  );
  const projection = (question: QuizItemEx) => ({
    page: question.page,
    number: question.number,
    qtype: question.qtype,
    question: question.question,
    choices: question.choices,
    box: question.box,
    figure: question.figure,
    figure_description: question.figure_description,
  });
  const questions = terminal.inputs.map((input): QuizItemEx => {
    const shared = {
      page: input.source_page,
      number: input.printed_number,
      qtype: input.qtype,
      question: input.question,
      choices: input.choices,
      box: input.box,
      figure: input.figure,
      figure_description: input.figure_description,
    };
    const repaired = repairedQuestions.find((candidate) =>
      canonicalEvidenceHash(projection(candidate)) === canonicalEvidenceHash(shared) &&
      repairedByQuestionHash.has(canonicalEvidenceHash(candidate))
    );
    if (repaired) return structuredClone(repaired);
    const base = baseQuestions.find((candidate) => `${candidate.page}:${candidate.number}` === input.key);
    if (!base || canonicalEvidenceHash(projection(base)) !== canonicalEvidenceHash(shared)) {
      throw new Error(`${input.key} effective question을 재구성할 수 없습니다`);
    }
    return structuredClone(base);
  });
  const classified = questions.map((question) => ({
    question,
    classification: repairedByQuestionHash.get(canonicalEvidenceHash(question)) ??
      baseDecisions.get(`${question.page}:${question.number}`)!,
  }));
  expect(canonicalEvidenceHash(classified)).toBe(terminal.effectiveCorpusHash);
  return classified;
}

describe("allowlisted official solution fidelity adjudication", () => {
  it("pins Q20 source and failed revision fidelity", () => {
    expect(SOLUTION_REVISION_FIDELITY_ADJUDICATION_VERSION).toBe(1);
    expect(SOLUTION_REVISION_FIDELITY_ADJUDICATION_ALLOWLIST).toMatchObject([{
      entryId: "ebsi:5769268",
      key: "8:20",
      sourceHash: "bb5b5d03101f67e1f56fe33870def9bd90d91892ed3ef893d9e6c7df4d90aa66",
      revisionArtifactHash: "00da6e80bdbbe87cbff4ce54b57737c77167f0e2764c64ae5c87c1972ef9c9dc",
      failedFidelityArtifactHash: "0fd860b862ad7015dfbaa52fdd899667168fd377cd770d33b4d5abbc2db8a89d",
      revisionSolutionItemHash: "7ad16feb562bc2650dc29272ca0d842e4569b512acb7ae6dae122feb30ffa94a",
      failedDecisionHash: "24a8ac10fc3d42e7ad9a852988d5b500c89fb7ad5acf56ecd4502d32c33432ce",
      failedEvidenceHash: "e9fabf2766b52183ab4c505a0e7e21eea3f0288f1dd2c7e4f4e8216b858f7edf",
      dpi: 600,
    }]);
  });

  it.skipIf(REQUIRED.some((path) => !existsSync(path)))(
    "uses immutable p6/p7 pixels, resumes after child crash, and rejects tamper/orphan",
    async () => {
      root = mkdtempSync(join(tmpdir(), "studywork-solution-fidelity-adjudication-"));
      for (const relativePath of [
        "solution-chunks/v3-0000.json",
        "solution-chunks/v3-0001.json",
        "solution-chunks/v3-0002.json",
        "solution-fidelity/v1-0000-3f0f4625f5ee5ba0c627c2655ae751e7fdbd334e49143b552b1280b71abbdda6-07041f5c4c306e5cccea957f29035517be45f115a975ebcf8329009b4407816f.json",
        "solution-repairs/v1-0006-0020-6a1bcd6840735026cb442ce830c4264d9918f245a36bf54be159b77f958afd48.json",
        "solution-fidelity-repairs/v1-0006-0020-6a1bcd6840735026cb442ce830c4264d9918f245a36bf54be159b77f958afd48-08a3140a57921a9c64e95ac4b069114c5502db37e8cd060574ffc84ab1804021.json",
        "solution-revisions/v1-0006-0020-e3583527616f630a8814e871bc7c46c0d2bb4b9a86a7eb0959ccaa9ce4164717.json",
        "solution-fidelity-revisions/v1-0006-0020-00da6e80bdbbe87cbff4ce54b57737c77167f0e2764c64ae5c87c1972ef9c9dc-7ad16feb562bc2650dc29272ca0d842e4569b512acb7ae6dae122feb30ffa94a.json",
      ]) copyAuthority(relativePath);

      const storedEntry = JSON.parse(readFileSync(REQUIRED[0], "utf8")).entry;
      const entry = parseCorpusManifest({ schemaVersion: 2, entries: [storedEntry] }).entries[0];
      const problemBytes = readFileSync(REQUIRED[1]);
      const solutionBytes = readFileSync(REQUIRED[2]);
      const problem: PdfEvidence = {
        path: REQUIRED[1], sha256: hash(problemBytes), bytes: problemBytes.length, pageCount: 12,
        requestedUrl: entry.problemPdfUrl, resolvedUrl: entry.problemPdfUrl,
      };
      const solution: PdfEvidence = {
        path: REQUIRED[2], sha256: hash(solutionBytes), bytes: solutionBytes.length, pageCount: 13,
        requestedUrl: entry.solutionPdfUrl, resolvedUrl: entry.solutionPdfUrl,
      };
      const classified = effectiveClassified();
      const solutions = [0, 1, 2].flatMap((index) =>
        JSON.parse(readFileSync(join(LIVE_STATE, `solution-chunks/v3-000${index}.json`), "utf8")).items as SolutionItem[]
      );
      let crashChild = true;
      let childCalls = 0;
      providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
        if (request.schema?.name === "studywork_exam_corpus_solution_fidelity") {
          expect(request.prompt).toContain("immutable 600-DPI");
          expect(request.prompt).toContain("극솟값을 갖는다. (거짓)");
          childCalls++;
          if (crashChild) {
            crashChild = false;
            throw new Error("simulated adjudication interruption");
          }
          return { text: JSON.stringify([{
            key: "8:20",
            sourcePage: 6,
            answerStatus: "exact",
            explanationStatus: "exact",
            evidence: "p7의 문구는 극댓값이 아니라 극솟값이며 revision이 공식 픽셀과 일치한다.",
          }]) };
        }
        throw new Error(`unexpected schema ${request.schema?.name}: ${request.prompt.slice(0, 1200)}`);
      });

      await expect(auditAcceptedSolutions(
        entry, problem, solution, root, classified, solutions
      )).rejects.toThrow("simulated adjudication interruption");
      expect(childCalls).toBe(1);
      expect(readdirSync(join(root, "solution-fidelity-adjudication-evidence")))
        .toHaveLength(5);

      const repaired = await auditAcceptedSolutions(
        entry, problem, solution, root, classified, solutions
      );
      expect(childCalls).toBe(2);
      const q20 = repaired.repairs.find((item) => item.key === "8:20")!;
      expect(q20.revision?.fidelityAdjudication).toMatchObject({
        allowlistId: "ebsi-5769268-q20-solution-fidelity-v1",
        adjudicationArtifact: { path: expect.stringMatching(/^solution-fidelity-adjudications\/v1-/u) },
        failedDecisionHash: SOLUTION_REVISION_FIDELITY_ADJUDICATION_ALLOWLIST[0].failedDecisionHash,
      });
      expect(repaired.items.find((item) => item.key === "8:20")).toMatchObject({
        answerStatus: "exact",
        explanationStatus: "exact",
        fidelityArtifact: { path: expect.stringMatching(/^solution-fidelity-adjudications\/v1-/u) },
      });
      const beforeReplay = childCalls;
      const replay = await auditAcceptedSolutions(entry, problem, solution, root, classified, solutions);
      expect(childCalls).toBe(beforeReplay);
      expect(canonicalEvidenceHash(replay)).toBe(canonicalEvidenceHash(repaired));

      const childPath = join(root, q20.revision!.fidelityAdjudication!.adjudicationArtifact.path);
      const original = readFileSync(childPath, "utf8");
      const tampered = JSON.parse(original);
      tampered.item.explanationStatus = "mismatch";
      writeFileSync(childPath, `${JSON.stringify(tampered, null, 2)}\n`);
      await expect(auditAcceptedSolutions(
        entry, problem, solution, root, classified, solutions
      )).rejects.toThrow(/canonical hash|adjudication/u);
      writeFileSync(childPath, original);

      const orphan = join(root, "solution-fidelity-adjudications", `v1-0006-0020-${"f".repeat(64)}.json`);
      copyFileSync(childPath, orphan);
      await expect(auditAcceptedSolutions(
        entry, problem, solution, root, classified, solutions
      )).rejects.toThrow(/adjudication.*coverage|orphan|중복/u);
    },
    30_000
  );
});
