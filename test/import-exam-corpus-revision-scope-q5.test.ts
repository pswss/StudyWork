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
  PROBLEM_REVISION_SCOPE_ADJUDICATION_ALLOWLIST,
  PROBLEM_REVISION_SCOPE_ADJUDICATION_VERSION,
  canonicalEvidenceHash,
  parseCorpusManifest,
  repairAndAuditOfficialAnswers,
  type ClassificationDecision,
  type PdfEvidence,
} from "../scripts/import-exam-corpus";

const LIVE_STATE = join(process.cwd(), "data/import-exam-corpus/7a91a9795ad1d977e6772a42");
const HISTORICAL_TERMINAL = "problem-terminal-fidelity/" +
  "v2-0000-4a746a86d66e5e199fbd26ba64b79656abc9cc79f16a37c4ab85674f5a439d1e-" +
  "a6772cf04df9ea73ecdd492d7db12772a0bcc546d4f65afc266ed1aac6ffbb20.json";
const CURRENT_TERMINAL = "problem-terminal-fidelity/" +
  "v2-0000-6947e33df96347cb9dbc91d95fa5e67622bf330d3deedf8412378a3a4813c7b7-" +
  "2eba07d3fbe55a0627e4f4ece8ac62dfb6b519a15b5ab33af82e538b89f0e004.json";
const REQUIRED = [
  "entry.json",
  "problem.pdf",
  "solution.pdf",
  "problem-chunks/v2-0000.json",
  "classification-chunks/v5-0000-7bb7cb863c8c4855.json",
  "solution-chunks/v3-0000.json",
  HISTORICAL_TERMINAL,
  CURRENT_TERMINAL,
].map((path) => join(LIVE_STATE, path));
const available = REQUIRED.every(existsSync);
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
let root = "";

afterEach(() => {
  providerMock.complete.mockReset();
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

function copyAuthority(relativePath: string): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(LIVE_STATE, relativePath), target);
}

describe("Q5 exact allowlisted revision-parent scope adjudication", () => {
  it("pins the two official sources, revision parents, and rejecting terminal", () => {
    expect(PROBLEM_REVISION_SCOPE_ADJUDICATION_VERSION).toBe(1);
    expect(PROBLEM_REVISION_SCOPE_ADJUDICATION_ALLOWLIST).toEqual([{
      allowlistId: "ebsi-5854872-q5-revision-scope-v1",
      entryId: "ebsi:5854872",
      key: "1:5",
      sourcePage: 1,
      sourceHash: "983b160d8149a02aadc8be8e2f6791fb3ed0db7e0055f3be0929fc8029556b47",
      solutionSourceHash: "005b3a21fe032c74f63604f7d6dc68099f22dff0d2981a85a2fb6179435d5a7c",
      parentProblemArtifactHash: "da793744650ed65a79de220d4e51f746cecb39b9e932aa6829a39a977edcd7a0",
      parentClassificationArtifactHash: "84e8fb1957108e36433a5afae777dc230d0cab3dee0a5cb18481a5010247cdf5",
      terminalArtifactHash: "59fe7d9b37963f6dfc84f47815aba628492d3c468e06a8ab1fff330236aa37a4",
    }]);
  });

  it.skipIf(!available)(
    "replays the exact revision, rejects the false integrated_science accept, and rejects tamper/orphan",
    async () => {
      root = mkdtempSync(join(tmpdir(), "studywork-q5-revision-scope-"));
      for (const relativePath of [
        "problem-chunks/v2-0000.json",
        "classification-chunks/v5-0000-7bb7cb863c8c4855.json",
        "solution-chunks/v3-0000.json",
        HISTORICAL_TERMINAL,
        CURRENT_TERMINAL,
      ]) copyAuthority(relativePath);
      for (const directory of [
        "problem-repair-batches",
        "classification-repair-batches",
        "problem-revision-batches",
        "classification-revision-batches",
      ]) {
        for (const name of readdirSync(join(LIVE_STATE, directory))) {
          if (
            name.includes("cbe8d8bf1fdae66b7d27e998aaf2ee807d88efbd3f50d249f49b4414642397e6") ||
            name.includes("18ceb86725d9f3c05bb735e662d603d694528b6323d0faef008c15926f4dcda9")
          ) continue;
          copyAuthority(`${directory}/${name}`);
        }
      }

      const storedEntry = JSON.parse(readFileSync(REQUIRED[0], "utf8")).entry;
      const entry = parseCorpusManifest({ schemaVersion: 2, entries: [storedEntry] }).entries[0];
      const problemBytes = readFileSync(REQUIRED[1]);
      const solutionBytes = readFileSync(REQUIRED[2]);
      const problem: PdfEvidence = {
        path: REQUIRED[1], sha256: hash(problemBytes), bytes: problemBytes.length, pageCount: 4,
        requestedUrl: entry.problemPdfUrl, resolvedUrl: entry.problemPdfUrl,
      };
      const solution: PdfEvidence = {
        path: REQUIRED[2], sha256: hash(solutionBytes), bytes: solutionBytes.length, pageCount: 2,
        requestedUrl: entry.solutionPdfUrl, resolvedUrl: entry.solutionPdfUrl,
      };
      const questions = (JSON.parse(readFileSync(REQUIRED[3], "utf8")).items as QuizItemEx[])
        .map((item) => structuredClone(item));
      const decisions = (JSON.parse(readFileSync(REQUIRED[4], "utf8")).items as ClassificationDecision[])
        .map((item) => structuredClone(item));
      for (const [problemBatch, classificationBatch] of [[
        "problem-repair-batches/v2-0001-0004-cbe8d8bf1fdae66b7d27e998aaf2ee807d88efbd3f50d249f49b4414642397e6.json",
        "classification-repair-batches/v1-0001-0004-18ceb86725d9f3c05bb735e662d603d694528b6323d0faef008c15926f4dcda9-7bb7cb863c8c4855.json",
      ]] as const) {
        const repairedQuestions = JSON.parse(readFileSync(join(LIVE_STATE, problemBatch), "utf8")).items as QuizItemEx[];
        const repairedDecisions = JSON.parse(readFileSync(
          join(LIVE_STATE, classificationBatch),
          "utf8"
        )).items as ClassificationDecision[];
        for (const repairedQuestion of repairedQuestions) {
          const key = `${repairedQuestion.page}:${Number(repairedQuestion.number)}`;
          const index = questions.findIndex((item) => `${item.page}:${Number(item.number)}` === key);
          questions[index] = structuredClone(repairedQuestion);
          decisions[index] = structuredClone(repairedDecisions.find((item) => item.key === key)!);
        }
      }
      const classified = questions.map((question, index) => ({ question, classification: decisions[index] }));
      const solutions = (JSON.parse(readFileSync(REQUIRED[5], "utf8")).items as SolutionItem[])
        .map((item) => structuredClone(item));
      const answerByNumber = new Map(solutions.map((item) => [Number(item.number), item.answer]));
      const terminalItems = JSON.parse(readFileSync(join(LIVE_STATE, CURRENT_TERMINAL), "utf8")).items as Array<{
        key: string;
        status: "exact";
        evidence: string;
        scopeDecision: "accept" | "reject" | "review";
        scopeConfidence: number;
        scopeEvidence: string;
      }>;
      const terminalByKey = new Map(terminalItems.map((item) => [item.key, item]));
      const historicalTerminalByKey = new Map((JSON.parse(readFileSync(
        join(LIVE_STATE, HISTORICAL_TERMINAL),
        "utf8"
      )).items as typeof terminalItems).map((item) => [item.key, item]));
      const terminalRepairQuestions = (JSON.parse(readFileSync(join(
        LIVE_STATE,
        "problem-repair-batches/v2-0001-0004-4bb840d42ee1616c1d1e8516474475fc1d0e0908c18e3352d3cd7a467902568a.json"
      ), "utf8")) as { items: QuizItemEx[] }).items;
      const terminalRepairClassifications = (JSON.parse(readFileSync(join(
        LIVE_STATE,
        "classification-repair-batches/v1-0001-0004-14ea19a28281a0ac248d28a3547b9f79c5f3a019dc7bce912a5231b67bb96e15-7bb7cb863c8c4855.json"
      ), "utf8")) as { items: ClassificationDecision[] }).items;
      const reject: ClassificationDecision = {
        key: "1:5",
        decision: "reject",
        canonical_subject: null,
        curriculum_course: null,
        domain: null,
        achievement_codes: [],
        confidence: 0.99,
        reason_codes: ["EXCLUDED_MECHANICAL_ENERGY_AND_WORK_DEPENDENCY"],
        transcription_status: "exact",
        transcription_evidence: "공식 문제와 해설 픽셀에서 역학적 에너지 보존·마찰열·일과 거리가 필수이다.",
      };
      const calls = { scope: 0, terminal: 0, problem: 0, classification: 0, solution: 0, semantic: 0 };
      providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
        if (request.schema?.name === "studywork_exam_corpus_scope_adjudication") {
          calls.scope++;
          expect(request.prompt).not.toContain("scopeDecision");
          expect(request.prompt).not.toContain("MECHANICAL_ENERGY_IN_SCOPE");
          expect(request.prompt).toContain("official solution pages");
          return { text: JSON.stringify([reject]) };
        }
        if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
          calls.terminal++;
          const inputs = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{
            key: string;
            question: string;
          }>;
          return { text: JSON.stringify(inputs.map((input) => {
            const item = (input.key === "2:9" && !input.question.includes("○")) ||
              (input.key === "3:11" && !input.question.includes("| 눈금실린더 |"))
              ? terminalByKey.get(input.key)
              : historicalTerminalByKey.get(input.key);
            return { ...(item ?? {
              key: input.key,
              status: "exact",
              evidence: "공식 source pixels와 일치한다.",
              scopeDecision: "reject",
              scopeConfidence: 0.99,
              scopeEvidence: "요청 범위 밖이다.",
            }) };
          })) };
        }
        if (request.schema?.name === "studywork_file_quiz_items") {
          calls.problem++;
          const items = terminalRepairQuestions.filter((item) =>
            request.prompt.includes(`${item.page}:${Number(item.number)}`)
          );
          return { text: JSON.stringify(items.map((item) => ({
            ...item,
            choiceCount: item.choices?.length ?? null,
          }))) };
        }
        if (request.schema?.name === "studywork_exam_corpus_classification") {
          calls.classification++;
          return { text: JSON.stringify(terminalRepairClassifications.filter((item) =>
            request.prompt.includes(`\"key\":\"${item.key}\"`)
          )) };
        }
        if (request.schema?.name === "studywork_exam_corpus_solution_fidelity") {
          calls.solution++;
          const inputs = JSON.parse(request.prompt.split("Accepted solutions:\n")[1]) as Array<{
            key: string;
            source_page: number;
          }>;
          return { text: JSON.stringify(inputs.map((input) => ({
            key: input.key,
            sourcePage: input.source_page,
            answerStatus: "exact",
            explanationStatus: "exact",
            evidence: "공식 정답과 완전한 해설이 일치한다.",
          }))) };
        }
        if (request.schema?.name === "studywork_exam_corpus_semantic_choice_check") {
          calls.semantic++;
          const inputs = JSON.parse(request.prompt.split("Items:\n")[1]) as Array<{ key: string }>;
          return { text: JSON.stringify(inputs.map((input) => {
            const answer = answerByNumber.get(Number(input.key.split(":")[1])) ?? "①";
            return {
              key: input.key,
              status: "resolved",
              choiceIndex: Math.max(1, "①②③④⑤".indexOf(answer.trim()[0]) + 1),
              evidence: "공식 상세 해설과 선택지 내용을 대조했다.",
            };
          })) };
        }
        throw new Error(`unexpected schema ${request.schema?.name}: ${request.prompt.slice(0, 800)}`);
      });

      const result = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
      expect(calls.scope).toBe(1);
      const repair = result.repairs.find((item) => item.key === "1:5")!;
      expect(repair.scopeAdjudication).toBeUndefined();
      expect(repair.revision?.recovery).toBeUndefined();
      expect(repair.revision?.scopeAdjudication).toMatchObject({
        allowlistId: "ebsi-5854872-q5-revision-scope-v1",
        key: "1:5",
        trigger: {
          terminalCheckpoint: { sha256: "59fe7d9b37963f6dfc84f47815aba628492d3c468e06a8ab1fff330236aa37a4" },
          terminalItem: { status: "exact", scopeDecision: "reject" },
        },
        classificationArtifact: {
          path: expect.stringMatching(/^classification-revision-scope-adjudications\/v1-/u),
        },
      });
      expect(result.classified.find((item) => item.classification.key === "1:5")).toMatchObject({
        question: {
          choices: expect.arrayContaining([expect.stringContaining("역학적 에너지는 B에서가 A에서보다 크다")]),
        },
        classification: { decision: "reject", canonical_subject: null, transcription_status: "exact" },
      });
      expect(result.problemTerminalFidelityItems.find((item) => item.key === "1:5")).toMatchObject({
        status: "exact", scopeDecision: "reject",
      });
      const beforeReplay = { ...calls };
      const replay = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
      expect(calls).toEqual(beforeReplay);
      expect(replay.auditHash).toBe(result.auditHash);
      expect(canonicalEvidenceHash(replay.repairs)).toBe(canonicalEvidenceHash(result.repairs));

      const historicalPath = join(root, HISTORICAL_TERMINAL);
      const historicalOriginal = readFileSync(historicalPath, "utf8");
      writeFileSync(historicalPath, historicalOriginal.replace("0.96", "0.95"));
      await expect(repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions))
        .rejects.toThrow(/historical terminal|hash가 다릅니다/u);
      writeFileSync(historicalPath, historicalOriginal);

      const childPath = join(root, repair.revision!.scopeAdjudication!.classificationArtifact.path);
      const original = readFileSync(childPath, "utf8");
      const tampered = JSON.parse(original);
      tampered.items[0].decision = "accept";
      writeFileSync(childPath, `${JSON.stringify(tampered, null, 2)}\n`);
      await expect(repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions))
        .rejects.toThrow(/scope adjudication|canonical hash|hash가 다릅니다|accept 근거/u);
      writeFileSync(childPath, original);
      writeFileSync(join(root, "classification-revision-scope-adjudications", "orphan.json"), "{}\n");
      await expect(repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions))
        .rejects.toThrow(/revision scope adjudication orphan\/conflict|malformed/u);
    },
    90_000
  );
});
