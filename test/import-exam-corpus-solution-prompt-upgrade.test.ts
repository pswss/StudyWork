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
  LEGACY_TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
  SOLUTION_PROMPT_UPGRADE_ALLOWLIST,
  SOLUTION_PROMPT_UPGRADE_FIDELITY_VERSION,
  SOLUTION_PROMPT_UPGRADE_VERSION,
  TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
  parseCorpusManifest,
  repairAndAuditOfficialAnswers,
  type ClassificationDecision,
  type PdfEvidence,
} from "../scripts/import-exam-corpus";

const LIVE_STATE = join(process.cwd(), "data/import-exam-corpus/887df3e562b3dab6874de994");
const REQUIRED = [
  "entry.json",
  "problem.pdf",
  "solution.pdf",
  "problem-chunks/v2-0000.json",
  "solution-chunks/v3-0000.json",
  "solution-fidelity/v1-0000-16bf213cac8005b84ef84df7046eef5ab35c47ef11cd15c9300be412bf9e42c6-df03ee35fdc7d01a19cf4c40e6622345584f4a7408bd4e77a07b38dd5e86ac1a.json",
  "solution-repairs/v1-0001-0001-1ff1b0baf4de24922fcb8a365aa0e00207fe3ab1160b5625edad3fe9861a84a4.json",
  "solution-fidelity-repairs/v1-0001-0001-1ff1b0baf4de24922fcb8a365aa0e00207fe3ab1160b5625edad3fe9861a84a4-1d1bc4aaa094bc39ec15bea9f875629982609dcb570c9d326bf0d7ee49cabbd4.json",
  "solution-revisions/v1-0001-0001-aa3f5a8be08a9e3d57f8ed97f5a19d0c20cdf15c7842d4759ba62d485bd275ec.json",
  "solution-fidelity-revisions/v1-0001-0001-c8a642d7741e859cb16a6bd0bf630b0e2c06a165cb75efd0883de3c6bd63bf8b-1fc5dc22052d9708ad408af997a70e7287798b092e3b8d966477118bd7bd4386.json",
  "semantic-choice-checks/v3-37b2ab05754d548f640d7e271cb61cdf0602371aa435a9ee67559f586c1dc8e7.json",
].map((path) => join(LIVE_STATE, path));

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
let root = "";

afterEach(() => {
  providerMock.complete.mockReset();
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

function copyAuthority(relativePath: string) {
  const destination = join(root, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(LIVE_STATE, relativePath), destination);
}

describe("legacy official solution revision prompt upgrade", () => {
  it("pins the only legacy v1 predecessor", () => {
    expect(SOLUTION_PROMPT_UPGRADE_ALLOWLIST).toEqual([{
      allowlistId: "ebsi-5643102-q1-solution-prompt-upgrade-v1",
      entryId: "ebsi:5643102",
      key: "1:1",
      sourceHash: "1e8a8a8970bafc066a2f556309e0ca3166a713c0c197b3788cdeb43f2d3de3fb",
      legacyRevisionArtifactHash: "c8a642d7741e859cb16a6bd0bf630b0e2c06a165cb75efd0883de3c6bd63bf8b",
      legacyRevisionFidelityArtifactHash: "d314eb6f85339d733bfa98edd2e9e3283252a79bd64989b489a8f9817adb5f71",
      legacyPromptVersion: 1,
      legacyPromptDigest: LEGACY_TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
      expectedAnswer: "②",
    }]);
    expect([SOLUTION_PROMPT_UPGRADE_VERSION, SOLUTION_PROMPT_UPGRADE_FIDELITY_VERSION]).toEqual([1, 1]);
  });

  it.skipIf(REQUIRED.some((path) => !existsSync(path)))(
    "upgrades Q1 answer 3 to the literal table marker, resumes after fidelity crash, and rejects tamper/orphan",
    async () => {
      root = mkdtempSync(join(tmpdir(), "studywork-solution-prompt-upgrade-"));
      for (const relativePath of [
        "solution-chunks/v3-0000.json",
        "solution-fidelity/v1-0000-16bf213cac8005b84ef84df7046eef5ab35c47ef11cd15c9300be412bf9e42c6-df03ee35fdc7d01a19cf4c40e6622345584f4a7408bd4e77a07b38dd5e86ac1a.json",
        "solution-repairs/v1-0001-0001-1ff1b0baf4de24922fcb8a365aa0e00207fe3ab1160b5625edad3fe9861a84a4.json",
        "solution-fidelity-repairs/v1-0001-0001-1ff1b0baf4de24922fcb8a365aa0e00207fe3ab1160b5625edad3fe9861a84a4-1d1bc4aaa094bc39ec15bea9f875629982609dcb570c9d326bf0d7ee49cabbd4.json",
        "solution-revisions/v1-0001-0001-aa3f5a8be08a9e3d57f8ed97f5a19d0c20cdf15c7842d4759ba62d485bd275ec.json",
        "solution-fidelity-revisions/v1-0001-0001-c8a642d7741e859cb16a6bd0bf630b0e2c06a165cb75efd0883de3c6bd63bf8b-1fc5dc22052d9708ad408af997a70e7287798b092e3b8d966477118bd7bd4386.json",
        "semantic-choice-checks/v3-37b2ab05754d548f640d7e271cb61cdf0602371aa435a9ee67559f586c1dc8e7.json",
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
        path: REQUIRED[2], sha256: hash(solutionBytes), bytes: solutionBytes.length, pageCount: 4,
        requestedUrl: entry.solutionPdfUrl, resolvedUrl: entry.solutionPdfUrl,
      };
      const questions = (JSON.parse(readFileSync(REQUIRED[3], "utf8")).items as QuizItemEx[])
        .map((question) => structuredClone(question));
      const classified = questions.map((question) => {
        const accepted = question.number === "1";
        const classification: ClassificationDecision = {
          key: `${question.page}:${question.number}`,
          decision: accepted ? "accept" : "reject",
          canonical_subject: accepted ? "math_B" : null,
          curriculum_course: accepted ? "2015 수학Ⅰ" : null,
          domain: accepted ? "지수함수와 로그함수" : null,
          achievement_codes: accepted ? ["12수학Ⅰ01-01"] : [],
          confidence: 0.99,
          reason_codes: [accepted ? "IN_SCOPE" : "OUT_OF_SCOPE"],
          transcription_status: "exact",
          transcription_evidence: "공식 문제 픽셀과 정확히 일치한다.",
        };
        return { question, classification };
      });
      const solutions = (JSON.parse(readFileSync(REQUIRED[4], "utf8")).items as SolutionItem[])
        .map((item) => structuredClone(item));
      const correctExplanation =
        "[출제의도] 지수 계산하기\n\n\\(\\left(3^{\\frac{1}{2}}\\right)^2=" +
        "3^{\\frac{1}{2}\\times 2}=3^1=3\\)이다.";
      const calls = { terminal: 0, fidelity: 0, upgrade: 0, semantic: 0 };
      let crashUpgradeFidelity = true;
      providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
        if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
          calls.terminal++;
          const inputs = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{ key: string }>;
          return { text: JSON.stringify(inputs.map((input) => ({
            key: input.key,
            status: "exact",
            evidence: "공식 문제 픽셀과 일치한다.",
            scopeDecision: input.key === "1:1" ? "accept" : "reject",
            scopeConfidence: 0.99,
            scopeEvidence: "공식 문제의 필수 교육과정 범위를 확인했다.",
          }))) };
        }
        if (request.schema?.name === "studywork_exam_corpus_solution_fidelity") {
          calls.fidelity++;
          const inputs = JSON.parse(request.prompt.split("Accepted solutions:\n")[1]) as Array<{
            key: string; source_page: number; raw_answer: string; explanation: string;
          }>;
          if (inputs[0].explanation === correctExplanation && crashUpgradeFidelity) {
            crashUpgradeFidelity = false;
            throw new Error("simulated prompt-upgrade fidelity interruption");
          }
          return { text: JSON.stringify(inputs.map((input) => ({
            key: input.key,
            sourcePage: input.source_page,
            answerStatus: input.explanation === correctExplanation ? "exact" : "exact",
            explanationStatus: "exact",
            evidence: input.explanation === correctExplanation
              ? "정답표 1번 ②와 전체 지수 계산 해설이 일치한다."
              : "현재 전사를 확인했다.",
          }))) };
        }
        if (request.schema?.name === "studywork_solution_file_items") {
          calls.upgrade++;
          expect(request.prompt).toContain('answer must be "②"');
          expect(request.prompt).toContain("정답표의 1번은 ②");
          return { text: JSON.stringify([{
            number: "1", answer: "②", explanation: correctExplanation, page: 1, complete: true,
          }]) };
        }
        if (request.schema?.name === "studywork_exam_corpus_semantic_choice_check") {
          calls.semantic++;
          return { text: JSON.stringify([{
            key: "1:1", status: "resolved", choiceIndex: 2,
            evidence: "해설의 값 3은 선택지 ②와 일치한다.",
          }]) };
        }
        throw new Error(`unexpected schema ${request.schema?.name}`);
      });

      await expect(repairAndAuditOfficialAnswers(
        entry, problem, solution, root, classified, solutions
      )).rejects.toThrow("simulated prompt-upgrade fidelity interruption");
      expect(calls.upgrade).toBe(1);
      expect(readdirSync(join(root, "solution-revision-upgrades"))).toHaveLength(1);
      expect(() => readdirSync(join(root, "solution-fidelity-revision-upgrades"))).toThrow();

      const repaired = await repairAndAuditOfficialAnswers(
        entry, problem, solution, root, classified, solutions
      );
      expect(calls.upgrade).toBe(1);
      expect(repaired.solutions[0]).toMatchObject({ answer: "②", explanation: correctExplanation });
      expect(repaired.solutionRepairs[0].revision?.trigger).toMatchObject({
        kind: "prompt-upgrade",
        promptUpgradeVersion: SOLUTION_PROMPT_UPGRADE_VERSION,
        legacyPredecessor: {
          allowlistId: "ebsi-5643102-q1-solution-prompt-upgrade-v1",
          revisionArtifact: {
            promptVersion: 1,
            promptDigest: LEGACY_TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
          },
        },
      });
      expect(repaired.solutionRepairs[0].revision?.solutionArtifact).toMatchObject({
        path: expect.stringMatching(/^solution-revision-upgrades\/v1-/u),
        revisionPromptVersion: 2,
        revisionPromptDigest: TARGETED_SOLUTION_REVISION_PROMPT_DIGEST,
      });
      const beforeReplay = { ...calls };
      const replay = await repairAndAuditOfficialAnswers(
        entry, problem, solution, root, classified, solutions
      );
      expect(calls).toEqual(beforeReplay);
      expect(replay.auditHash).toBe(repaired.auditHash);

      const upgradePath = join(root, repaired.solutionRepairs[0].revision!.solutionArtifact.path);
      const originalUpgrade = readFileSync(upgradePath, "utf8");
      const tampered = JSON.parse(originalUpgrade);
      tampered.item.answer = "3";
      writeFileSync(upgradePath, `${JSON.stringify(tampered, null, 2)}\n`);
      await expect(repairAndAuditOfficialAnswers(
        entry, problem, solution, root, classified, solutions
      )).rejects.toThrow(/canonical hash|prompt upgrade/u);
      writeFileSync(upgradePath, originalUpgrade);

      const orphanPath = join(root, "solution-revision-upgrades", `v1-0001-0001-${"f".repeat(64)}.json`);
      copyFileSync(upgradePath, orphanPath);
      await expect(repairAndAuditOfficialAnswers(
        entry, problem, solution, root, classified, solutions
      )).rejects.toThrow(/prompt upgrade|legacy prompt predecessor|orphan|authority가 중복/u);
    }
  );
});
