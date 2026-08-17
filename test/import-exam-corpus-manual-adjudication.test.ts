import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";

const providerMock = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("../src/codex-provider", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/codex-provider")>(),
  getCodexProvider: () => ({ complete: providerMock.complete }),
}));

import type { QuizItemEx, SolutionItem } from "../src/claude";
import {
  CLASSIFIER_DIGEST,
  CLASSIFIER_VERSION,
  IMPORT_MODEL,
  IMPORT_REASONING_EFFORT,
  PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST,
  PROBLEM_MANUAL_CLASSIFICATION_POLICY_REVISION_ALLOWLIST,
  PROBLEM_MANUAL_CLASSIFICATION_POLICY_REVISION_DIGEST,
  PROBLEM_MANUAL_CLASSIFICATION_POLICY_REVISION_VERSION,
  PROBLEM_MANUAL_REVISION_ALLOWLIST,
  PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST,
  PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST,
  PROBLEM_TERMINAL_FIDELITY_VERSION,
  PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST,
  SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST,
  SOLUTION_SOURCE_REVISION_ALLOWLIST,
  TRANSCRIPTION_GATE_VERSION,
  TRANSCRIPTION_PROMPT_DIGEST,
  actionableTerminalFidelityIssues,
  adjudicateProblemManual,
  applyAllowlistedProblemManualCorrection,
  applyAllowlistedProblemManualRevision,
  applyAllowlistedProblemManualSourceRevision,
  auditAcceptedSolutions,
  assertProblemManualAdjudicationAuthority,
  canonicalEvidenceHash,
  hasExactTerminalInputItemKeyCoverage,
  isPersistedManualHydrationSpec,
  parseCorpusManifest,
  parseDecisions,
  repairAndAuditOfficialAnswers,
  solutionRepairFidelityEvidence,
  writeAnswerAttestation,
  type ClassificationDecision,
  type ClassifiedQuestion,
  type PdfEvidence,
  type ProblemRepairEvidence,
  type ProblemRecoveryEvidence,
} from "../scripts/import-exam-corpus";
import { verifyProblemManualAdjudicationForTest } from "../scripts/verify-exam-corpus";

const q27LiveState = join(process.cwd(), "data/import-exam-corpus/bb876a67170089dfb2022f47");
const q31Q32LiveState = join(process.cwd(), "data/import-exam-corpus/f914a5cf8d2237d6c9319e23");
const q43LiveState5577054 = join(process.cwd(), "data/import-exam-corpus/4745f3573f575a93f6adcccb");
const q30Q42ManualKeys: readonly string[] = [
  "11:30", "12:31", "12:32", "14:37", "15:38", "15:40", "15:41", "15:42",
];
const newTrueRepairManualKeys: readonly string[] = ["7:18", "7:19", "15:39"];
const terminalRecoveryManualKeys: readonly string[] = [
  "3:6", "3:7", "9:21", "9:22", "9:24", "9:25", "9:26",
];
const q5525982SolutionFidelityRows = [
  ["6:16", 10, "exact", "exact", "10쪽에 ‘16. 세부 내용 추론’과 ‘정답 ②’가 명시되어 있다. 해설은 10쪽에서 시작해 11쪽의 ⑤ 설명까지 이어지며, supplied explanation과 빠짐없이 일치한다."],
  ["7:17", 11, "exact", "exact", "11쪽에 ‘17. 핵심 정보 파악’과 ‘정답 ④’가 보인다. 분석 명제·동의적 표현의 순환론 설명과 오답 ①·②·③·⑤가 모두 supplied explanation과 일치한다."],
  ["7:18", 11, "exact", "exact", "11쪽에 ‘18. 반응의 적절성 평가’와 ‘정답 ⑤’가 명시되어 있다. 해설은 12쪽의 오답 ④까지 계속되며 전체 내용이 supplied explanation과 일치한다."],
  ["7:19", 12, "exact", "exact", "12쪽에 ‘19. 내용의 비판적 이해’와 ‘정답 ⑤’가 보인다. 총체주의에 대한 비판 및 오답 ①~④의 설명이 모두 정확히 일치한다."],
  ["7:20", 12, "exact", "exact", "12쪽에서 ‘20. 어휘의 문맥적 의미 파악’이 시작되고, 13쪽에 결론 ‘다다르다’, ‘정답 ②’ 및 오답 ①·③·④·⑤가 보인다. supplied explanation과 일치한다."],
  ["9:21", 14, "exact", "exact", "14쪽에 ‘21. 외적 준거에 따른 작품 감상’과 ‘정답 ④’가 명시되어 있다. 윤씨와 지영에 관한 정답 해설부터 오답 ⑤까지 모두 supplied explanation과 일치한다."],
  ["9:22", 14, "exact", "exact", "14쪽에 ‘22. 작품의 종합적 이해’와 ‘정답 ④’가 보인다. 해설은 15쪽의 오답 ③·⑤까지 이어지며 supplied explanation 전체와 일치한다."],
  ["9:23", 15, "exact", "exact", "15쪽에 ‘23. 감상의 적절성 평가’와 ‘정답 ⑤’가 명시되어 있다. 용골대의 발언에 대한 판단과 오답 ①~④가 모두 일치한다."],
  ["9:24", 15, "exact", "exact", "15쪽에서 ‘24. 구절의 의미 파악’이 시작되고 ‘정답 ③’이 명시되어 있다. 해설은 16쪽의 오답 ④·⑤까지 이어지며 supplied explanation과 일치한다."],
  ["9:25", 16, "exact", "exact", "16쪽에 ‘25. 작품의 내용 파악’과 ‘정답 ③’이 보인다. 김씨 부인의 만류와 지영의 행동을 설명한 정답 해설 및 오답 ①·②·④·⑤가 모두 일치한다."],
  ["9:26", 16, "exact", "exact", "16쪽에 ‘26. 서술상의 특징 파악’과 ‘정답 ⑤’가 명시되어 있다. 현재형 시제와 긴박감에 관한 해설 및 오답 ①~④가 supplied explanation과 일치한다."],
  ["11:27", 17, "exact", "exact", "17쪽에 ‘27. 작품의 내용 파악’과 ‘정답 ②’가 보인다. 해설은 18쪽에서 오답 ⑤의 마지막 결론까지 계속되며 supplied explanation과 완전히 일치한다."],
  ["11:28", 18, "exact", "exact", "18쪽에 ‘28. 외적 준거에 따른 작품 감상’과 ‘정답 ②’가 명시되어 있다. ㉠·㉡의 갈등에 관한 정답 해설과 오답 ①·③·④·⑤가 모두 일치한다."],
  ["11:29", 18, "exact", "exact", "18쪽에 ‘29. 작품 간의 공통점, 차이점 파악’과 ‘정답 ①’이 보인다. 오답 해설은 19쪽의 ②·③·④·⑤까지 이어지며 supplied explanation 전체와 일치한다."],
  ["11:30", 19, "exact", "exact", "19쪽에서 30번이 시작하며 명시적 정답은 ②이다. 정답해설과 오답 ①·③·④·⑤의 설명이 모두 공급본과 일치한다."],
  ["12:31", 19, "exact", "exact", "31번은 19쪽에서 시작해 20쪽으로 이어진다. 명시적 정답 ④와 정답해설 및 오답 ①·②·③·⑤ 전체가 일치한다."],
  ["12:32", 20, "exact", "exact", "20쪽에서 32번이 시작하며 명시적 정답은 ③이다. 정답해설과 오답 ①·②·④·⑤ 설명이 모두 일치한다."],
  ["13:33", 21, "exact", "exact", "21쪽에서 33번이 시작하며 명시적 정답은 ⑤이다. F의 셀룰로스 분해 설명과 오답 ①~④의 근거가 모두 일치한다."],
  ["13:34", 22, "exact", "exact", "22쪽에서 34번이 시작하며 명시적 정답은 ④이다. ⓐ·ⓑ·ⓒ, pH 5.8·5.5·5.0·6.0 등 모든 값과 결론이 일치한다."],
  ["13:35", 22, "exact", "exact", "35번은 22쪽에서 시작해 23쪽 첫 부분까지 이어진다. 명시적 정답 ①과 정답해설 및 오답 ②의 끝 문장까지 일치한다."],
  ["13:36", 23, "exact", "exact", "23쪽에서 36번이 시작하며 명시적 정답은 ③이다. 숙신산·젖산의 배출 조건과 오답 ①·②·④·⑤ 설명이 모두 일치한다."],
  ["14:37", 24, "exact", "exact", "24쪽에서 37번이 시작하며 명시적 정답은 ③이다. 문단별 중심 내용과 오답 ①·②·④·⑤ 설명이 모두 일치한다."],
  ["15:38", 24, "exact", "exact", "24쪽에서 38번이 시작하며 명시적 정답은 ④이다. ‘중요한 사항’에 관한 추론과 오답 ①·②·③·⑤ 설명이 모두 일치한다."],
  ["15:39", 24, "exact", "exact", "39번은 24쪽에서 시작해 25쪽으로 이어진다. 명시적 정답 ⑤와 보험료율=보험료/보험금, 두 배 관계, 기댓값 및 오답 설명 전체가 일치한다."],
  ["15:40", 25, "exact", "mismatch", "25쪽의 명시적 정답은 ①이고 공급된 정답해설 문단도 일치한다. 그러나 PDF에 이어지는 [오답피하기] ②·③·④·⑤ 전체가 공급 설명에서 누락되었다."],
  ["15:41", 26, "exact", "mismatch", "26쪽의 명시적 정답은 ④이고 공급된 정답해설 문단도 일치한다. 그러나 PDF의 [오답피하기] ①·②·③·⑤가 전부 누락되었다."],
  ["15:42", 26, "exact", "mismatch", "42번은 26쪽에서 시작하며 명시적 정답은 ①이다. 공급된 정답해설은 일치하지만, 26~27쪽의 [오답피하기] ②·③·④·⑤가 누락되었다."],
  ["16:43", 27, "exact", "mismatch", "27쪽의 명시적 정답은 ③이고 공급된 정답해설 문단도 일치한다. 그러나 PDF의 [오답피하기] ①·②·④·⑤가 누락되었다."],
  ["16:44", 27, "exact", "mismatch", "44번은 27쪽에서 시작해 28쪽으로 이어지며 명시적 정답은 ⑤이다. 공급된 정답해설은 일치하지만 28쪽의 [오답피하기] ①·②·③·④가 누락되었다."],
  ["16:45", 28, "exact", "mismatch", "28쪽의 명시적 정답은 ①이고 공급된 정답해설 문단도 일치한다. 그러나 PDF의 [오답피하기] ②·③·④·⑤가 누락되었다."],
] as const;
const q5525982SolutionFidelityByKey = new Map<string, {
  key: string;
  sourcePage: number;
  answerStatus: "exact" | "mismatch";
  explanationStatus: "exact" | "mismatch";
  evidence: string;
}>(q5525982SolutionFidelityRows.map(([
  key,
  sourcePage,
  answerStatus,
  explanationStatus,
  evidence,
]) => [key, { key, sourcePage, answerStatus, explanationStatus, evidence }]));

function q5525982FidelityDecisions(prompt: string) {
  const inputs = JSON.parse(prompt.split("Accepted solutions:\n")[1]) as Array<{ key: string }>;
  return inputs.map((input) => {
    const decision = q5525982SolutionFidelityByKey.get(input.key);
    if (!decision) throw new Error(`missing frozen solution fidelity row: ${input.key}`);
    return decision;
  });
}

function q5525982CorrectedSolution(solutions: SolutionItem[], key: string): SolutionItem {
  const spec = SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0].items.find((item) => item.key === key);
  if (!spec) throw new Error(`missing forced solution repair row: ${key}`);
  const number = Number(key.split(":")[1]);
  const base = structuredClone(solutions.find((solution) => Number(solution.number) === number)!);
  for (const replacement of spec.replacements) {
    expect(base.explanation.split(replacement.from)).toHaveLength(replacement.count + 1);
    base.explanation = base.explanation.split(replacement.from).join(replacement.to);
  }
  if ("appendExplanation" in spec) base.explanation += `\n\n${spec.appendExplanation}`;
  expect(canonicalEvidenceHash(base)).toBe(spec.expectedSolutionItemHash);
  return base;
}

let root = "";
afterEach(() => {
  providerMock.complete.mockReset();
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const canonicalize = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]))
    : value;
const writeJson = (path: string, value: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const writeCanonicalJson = (path: string, value: unknown) =>
  writeFileSync(path, `${JSON.stringify(canonicalize(value), null, 2)}\n`);

function stateSnapshot(directory: string): Array<[string, string, string]> {
  const output: Array<[string, string, string]> = [];
  const visit = (path: string, prefix: string) => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(child);
      if (stat.isSymbolicLink()) output.push([relative, "symlink", readlinkSync(child)]);
      else if (stat.isDirectory()) visit(child, relative);
      else output.push([relative, "file", hash(readFileSync(child))]);
    }
  };
  visit(directory, "");
  return output;
}

function removeSolutionRepairArtifacts(stateDir: string): void {
  for (const directory of [
    "solution-repairs",
    "solution-fidelity-repairs",
    "solution-source-revisions",
    "solution-fidelity-source-revisions",
    "solution-revisions",
    "solution-fidelity-revisions",
    "solution-fidelity-adjudications",
    "solution-fidelity-adjudication-evidence",
    "solution-revision-upgrades",
    "solution-fidelity-revision-upgrades",
    "semantic-choice-checks",
    "answer-audit",
    "answer-attestation",
  ]) rmSync(join(stateDir, directory), { recursive: true, force: true });
}

function removeManualArtifacts(stateDir: string, keys: string[]): void {
  const prefixes = keys.map((key) => {
    const [page, number] = key.split(":");
    return `v1-${page.padStart(4, "0")}-${number.padStart(4, "0")}-`;
  });
  for (const directory of [
    "problem-manual-evidence",
    "problem-manual-adjudications",
    "classification-manual-adjudications",
  ]) {
    const path = join(stateDir, directory);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path)) {
      if (prefixes.some((prefix) => name.startsWith(prefix))) rmSync(join(path, name));
    }
  }
}

function removeManualGenerationArtifacts(stateDir: string, allowlistId: string): void {
  for (const directory of ["problem-manual-adjudications", "classification-manual-adjudications"]) {
    const path = join(stateDir, directory);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path)) {
      const artifactPath = join(path, name);
      const checkpoint = JSON.parse(readFileSync(artifactPath, "utf8"));
      if (checkpoint.basis?.allowlistId !== allowlistId) continue;
      if (directory === "problem-manual-adjudications") {
        const pointers = [
          checkpoint.basis.cropEvidenceArtifact,
          checkpoint.basis.cropEvidencePdf,
          ...(checkpoint.basis.cropViews ?? []).map((view: { artifact: { path: string } }) => view.artifact),
        ];
        for (const pointer of pointers) rmSync(join(stateDir, pointer.path), { force: true });
      }
      rmSync(artifactPath);
    }
  }
}

function removeManualRevisionArtifacts(stateDir: string, keys: string[]): void {
  const prefixes = keys.map((key) => {
    const [page, number] = key.split(":");
    return `v1-${page.padStart(4, "0")}-${number.padStart(4, "0")}-`;
  });
  for (const directory of [
    "problem-manual-revisions",
    "classification-manual-revisions",
    "problem-manual-second-revisions",
    "classification-manual-second-revisions",
  ]) {
    const path = join(stateDir, directory);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path)) {
      if (prefixes.some((prefix) => name.startsWith(prefix))) rmSync(join(path, name));
    }
  }
}

function removeManualSourceRevisionArtifacts(stateDir: string, keys: string[]): void {
  const prefixes = keys.map((key) => {
    const [page, number] = key.split(":");
    return `v1-${page.padStart(4, "0")}-${number.padStart(4, "0")}-`;
  });
  for (const directory of ["problem-manual-second-revisions", "classification-manual-second-revisions"]) {
    const path = join(stateDir, directory);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path)) {
      if (prefixes.some((prefix) => name.startsWith(prefix))) rmSync(join(path, name));
    }
  }
}

function withOnlyManualArtifactsForKey<T>(stateDir: string, key: string, run: () => T): T {
  const number = key.split(":")[1]!.padStart(4, "0");
  const keyPrefix = new RegExp(`^v\\d+-\\d{4}-${number}-`, "u");
  const renamed: Array<{ from: string; to: string }> = [];
  for (const directory of [
    "problem-manual-evidence",
    "problem-manual-adjudications",
    "classification-manual-adjudications",
    "problem-manual-revisions",
    "classification-manual-revisions",
    "problem-manual-second-revisions",
    "classification-manual-second-revisions",
    "classification-manual-policy-revisions",
  ]) {
    const path = join(stateDir, directory);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path)) {
      if (keyPrefix.test(name) || name.endsWith(".tmp")) continue;
      const from = join(path, name);
      const to = `${from}.tmp`;
      renameSync(from, to);
      renamed.push({ from, to });
    }
  }
  try {
    return run();
  } finally {
    for (const { from, to } of renamed.reverse()) renameSync(to, from);
  }
}

function rewindLatest5578421TerminalGeneration(stateDir: string): void {
  const paths = [
    "classification-recoveries/v1-0001-0003-59f7879d4adca4dcdea88649854cd840fdd812448869705fb086e8e9de023583-7bb7cb863c8c4855.json",
    "classification-recoveries/v1-0003-0006-f4c09a80a3326e7c37fa5c5e112c8f9977905e20348fa7c708922b64e4ad6b01-7bb7cb863c8c4855.json",
    "classification-recoveries/v1-0003-0007-d7f81f08d713dc3349cab5f6e263de1a57ab0c0c2a1860fae80fcb08161b65bd-7bb7cb863c8c4855.json",
    "classification-recoveries/v1-0003-0008-e1a5a5bc2674793d36591c03c6024d222e8106d0eb02dde6366ada9cdbb7a88d-7bb7cb863c8c4855.json",
    "classification-recoveries/v1-0005-0014-5487f99a7ba976e14e3a14986491cf4e5b37fcf40fb49c105ae20f4facb84d8f-7bb7cb863c8c4855.json",
    "classification-recoveries/v1-0008-0019-ae0af40c62b2836394b7fa8162e971b360785adab27b2a8665c2721f81eaa83b-7bb7cb863c8c4855.json",
    "classification-recoveries/v1-0008-0021-8214511bdee1cae80ddb3d14979fd8534909e8bd5dfb4869c98b99ed43fab9a2-7bb7cb863c8c4855.json",
    "classification-recoveries/v1-0015-0038-e1c28ad60aaad2b3a08d95f41817cf0a002bcc780b04077cd8be07a43746a105-7bb7cb863c8c4855.json",
    "classification-recoveries/v1-0016-0044-37f032ee3b873955527c419570c45c553085760cfd565ce18936f9a50e3df98c-7bb7cb863c8c4855.json",
    "classification-recoveries/v1-0016-0045-ac86ef329a4a89c2a03faef1c9f7466ddd06287ec6da2b6dec8245e4b18b638c-7bb7cb863c8c4855.json",
    "classification-repair-batches/v1-0001-0016-92448a232e23730533419c51b2d95f3e5e93885777d3f5a6880a8fb237768bac-7bb7cb863c8c4855.json",
    "classification-revision-batches/v1-0001-0016-55e9759e0800e4e32ccc6aa62aeceba48891c9bb703534bbd594fd0dca45e094-7bb7cb863c8c4855.json",
    "problem-recoveries/v1-0001-0003-d0679133d0fc5d5deb25c345aca9cf84f7e162e46ca6b03805dfa3f188f12981.json",
    "problem-recoveries/v1-0003-0006-e61ad047fe467e3a5229e6d7490c007329295025915d151afa927cb4185eaba0.json",
    "problem-recoveries/v1-0003-0007-e5279d8571252ab16b1995a130443d320d063b7c621c68817ecd797a2c60eac3.json",
    "problem-recoveries/v1-0003-0008-efb7c7c44d9d6c9c6c69189df61443b387c16437a2ab2a94d6571aa842867ca4.json",
    "problem-recoveries/v1-0005-0014-3cd44b3c3e34443650a5e2279b73e4447a1d619224369ac38b370bff5fa998dd.json",
    "problem-recoveries/v1-0008-0019-03d5582ab83e22766c643daac59b1b9016a5cbedc0a9922864d13dd4a12200cc.json",
    "problem-recoveries/v1-0008-0021-67477c12b03b18d7854ca3e0dcbc7960d18297953fd15cba46a5426f46ce3acd.json",
    "problem-recoveries/v1-0015-0038-20de903b4712cf3bf362331d56a2059622d5b78dccb5806b9a94b5c21094c876.json",
    "problem-recoveries/v1-0016-0044-443f3ee34795d741915056c3536eee91be67c7ff65063daed6d5e1d109c32792.json",
    "problem-recoveries/v1-0016-0045-8f00acde64a3e8f4632351d13baa28db16a1bf98f19b4024409b287a90d3ee1a.json",
    "problem-repair-batches/v1-0001-0016-0004-6d7d414104e0506f7d0f10a410017f3b2810f79823daa4c3688fea59103159f5.json",
    "problem-repair-batches/v1-0001-0016-0016-b880d54c1d40e97346e2507d0295e93d7feea4f68316d36fecafc5bac756c439.json",
    "problem-revision-batches/v1-0001-0016-0001-6fc9c110c4629f428ada002ddcde3c6c6c9e9bf684c55f0c97994637be88244b.json",
    "problem-revision-batches/v1-0001-0016-0002-8377819262ac0bac89f5a408da8127c39b7834d3214e8fde70a46d4454a90378.json",
    "problem-revision-batches/v1-0001-0016-0003-2caceaccf968ad126b001096f7bdf373f355d3970e01508cb27215ee120f3db2.json",
    "problem-revision-batches/v1-0001-0016-0005-cd8ef2914f09cf06c18e4b7e95f871f7867d106711baed5da1ef4250763f9c8f.json",
    "problem-revision-batches/v1-0001-0016-0008-65f373816ffdb30a222b5a122f2e6b7d53800fcc2af5c6a33e621fa45d8a2598.json",
    "problem-revision-batches/v1-0001-0016-0009-e81ec6e937e7be6e48e908cb4eba7d8cda11c5d2167ba2e1049372860fb8e709.json",
    "problem-revision-batches/v1-0001-0016-0010-0017ac2eabb3b48c76e0864af4d0a8d6e4081f61874e9394fd05d0ce7879a7ed.json",
    "problem-revision-batches/v1-0001-0016-0012-e13e9bcb2070601e4b5a4be6cd4e716832ee8b1f7afcfb2055272937ca61bd47.json",
    "problem-revision-batches/v1-0001-0016-0015-722967b1423592219e5b3197c7914ece2f6926738e38307ca2c1e645868a68bb.json",
    "problem-revision-batches/v1-0001-0016-0016-fe521b3e4b51f52777f84b8ce89781f9bde411e42f145774812907a7487706ff.json",
    "problem-terminal-fidelity/v2-0000-ad36c5f88b1304eb8f257b9f10c75256e72fd17d9cf4db39801833c43386eea2-3014f817dc1482555435861c475995007be7b0814d611a40bf2afc4d3c476bde.json",
    "problem-terminal-fidelity/v2-0000-e8141ab87968914365400d9ece7be837e35a248f7396c0519f73165df8a87a02-60a1c30773b630f70b1840954958305e45e1d0d651e37558bfb78203e530519d.json",
  ];
  for (const relativePath of paths) rmSync(join(stateDir, relativePath));
}

function q27FixtureInputs(stateDir: string) {
  const entry = parseCorpusManifest({
    schemaVersion: 2,
    entries: [JSON.parse(readFileSync(join(stateDir, "entry.json"), "utf8")).entry],
  }).entries[0];
  const downloads = JSON.parse(readFileSync(join(stateDir, "downloads.json"), "utf8"));
  const problem: PdfEvidence = {
    ...downloads.problem,
    path: join(stateDir, "problem.pdf"),
    resolvedUrl: downloads.problem.requestedUrl,
  };
  const solution: PdfEvidence = {
    ...downloads.solution,
    path: join(stateDir, "solution.pdf"),
    resolvedUrl: downloads.solution.requestedUrl,
  };
  const questions = JSON.parse(readFileSync(join(stateDir, "problem-chunks/v2-0000.json"), "utf8"))
    .items as QuizItemEx[];
  const decisions = parseDecisions(
    JSON.parse(readFileSync(
      join(stateDir, `classification-chunks/v${CLASSIFIER_VERSION}-0000-${CLASSIFIER_DIGEST}.json`),
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
  const solutions = readdirSync(join(stateDir, "solution-chunks"))
    .filter((name) => /^v3-\d{4}\.json$/u.test(name))
    .sort()
    .flatMap((name) => JSON.parse(readFileSync(join(stateDir, "solution-chunks", name), "utf8")).items) as
    SolutionItem[];
  return { entry, problem, solution, classified, solutions };
}

function exactRecoveryParent(
  stateDir: string,
  problemRelativePath: string,
  classificationRelativePath: string,
  expectedParentHash: string
): {
  failed: ClassifiedQuestion;
  parent: ProblemRecoveryEvidence;
} {
  const problemBytes = readFileSync(join(stateDir, problemRelativePath));
  const classificationBytes = readFileSync(join(stateDir, classificationRelativePath));
  const problemCheckpoint = JSON.parse(problemBytes.toString("utf8"));
  const classificationCheckpoint = JSON.parse(classificationBytes.toString("utf8"));
  const basis = problemCheckpoint.basis;
  const question = problemCheckpoint.item as QuizItemEx;
  const classification = classificationCheckpoint.items[0] as ClassificationDecision;
  const parent: ProblemRecoveryEvidence = {
    key: basis.key,
    printedNumber: basis.printedNumber,
    sourcePage: basis.sourcePage,
    sourceHash: basis.sourceHash,
    contextFrom: basis.contextFrom,
    contextTo: basis.contextTo,
    baseProblemRepairArtifact: basis.baseProblemRepairArtifact,
    baseProblemRepairItemHash: basis.baseProblemRepairItemHash,
    baseClassificationRepairArtifact: basis.baseClassificationRepairArtifact,
    baseClassificationRepairItemHash: basis.baseClassificationRepairItemHash,
    baseProblemRevisionArtifact: basis.baseProblemRevisionArtifact,
    baseProblemRevisionItemHash: basis.baseProblemRevisionItemHash,
    baseClassificationRevisionArtifact: basis.baseClassificationRevisionArtifact,
    baseClassificationRevisionItemHash: basis.baseClassificationRevisionItemHash,
    problemArtifact: {
      path: problemRelativePath,
      sha256: hash(problemBytes),
    },
    problemArtifactItemHash: canonicalEvidenceHash(question),
    classificationArtifact: {
      path: classificationRelativePath,
      sha256: hash(classificationBytes),
      rulesDigest: classificationCheckpoint.rulesDigest,
      transcriptionGateVersion: classificationCheckpoint.transcriptionGateVersion,
      transcriptionPromptDigest: classificationCheckpoint.transcriptionPromptDigest,
      recoveryPromptVersion: classificationCheckpoint.recoveryPromptVersion,
      recoveryPromptDigest: classificationCheckpoint.recoveryPromptDigest,
    },
    classificationArtifactItemHash: canonicalEvidenceHash(classification),
    ...(basis.trigger ? { trigger: basis.trigger } : {
      failedClassificationEvidenceHash: basis.failedClassificationEvidenceHash,
    }),
    baseQuestionHash: basis.baseQuestionHash,
    effectiveQuestionHash: canonicalEvidenceHash(question),
    baseClassificationHash: basis.baseClassificationHash,
    effectiveClassificationHash: canonicalEvidenceHash(classification),
  };
  expect(canonicalEvidenceHash(parent)).toBe(expectedParentHash);
  return { failed: { question, classification }, parent };
}

function q27ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0011-0027-e2d59ea1699886f21ab5218fd221a8fa05f0beb46a1782ed48c9ec9cb583541c.json",
    "classification-recoveries/v1-0011-0027-9cae9db11869c6adbd575b6ee6b08ce51d75c483e3897a8afe1b698044223551-" +
      "7bb7cb863c8c4855.json",
    "186e1381194aab5765fc72d88fb3e9a85901867d4a398588c7e38aa7f463dfdb"
  );
}

function q8ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0004-0008-2a1df1d1f5ce36c0a0c1953ffea79eadeaf7362fd0cfbee30dfd349fe0c97916.json",
    "classification-recoveries/v1-0004-0008-77436837e9a53cf4cc6c7bdfad9def301a9475e363bdca1d756161c92ad45718-" +
      "7bb7cb863c8c4855.json",
    "7d39ae1a99aa29102479ab0be361e01a364f2bf655bb770b81ccedec0f2f45a7"
  );
}

function q6TerminalRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v2-0003-0006-227bcbbcf6c2d079d0e34505aeed49afd8f8fe915ce78b732334ec06f94f2a70.json",
    "classification-recoveries/v2-0003-0006-91db1fa140d7e958866bba2856e5349613e6411b6051c24f9f89bb347827bb95-" +
      "7bb7cb863c8c4855.json",
    "35b80c874b7d16e717c372af1d39d62103e806a060b4fe5968298f9857afb0c2"
  );
}

function q7TerminalRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v2-0003-0007-c8c061be14a5acfc2c58eaa7f4fdaa2fc80f7bb77766dff21c0424a0992bb069.json",
    "classification-recoveries/v2-0003-0007-2f8ef852b405bebdc0b0f03f191e881d7b56d47648f13eaea3e315ddf29fac7f-" +
      "7bb7cb863c8c4855.json",
    "67020ac6d8ce2e4343f5ce0d52eef30cd77fa0fbd4daa8aecd298551c3dd17b2"
  );
}

function page9TerminalRecoveryParent(
  stateDir: string,
  number: "21" | "22" | "24" | "25" | "26"
) {
  const pins = {
    "21": [
      "86445e34deae577f301f2ce4b325ff53fc284ac874a0b8de2a861ca4e7500a95",
      "73d3e7cd0552f6b10ef91b6993b5b674096489acc34a5db24170760507278c82",
      "08b3243fba83cd4207725111e5fcb0393c712582f4072861a32c4f7403934f70",
    ],
    "22": [
      "eb6ff38dc6647dd838948efdcff5e4b42f44692cb44b8af0cb6814129672f0d2",
      "cbf2099be1ed1a53a1c87db10bb8beefb993cc69ac80478e34c41684b8f5b1f7",
      "d24ed20061fff5dcabbe556f473dd80dbb93a87bcbbc8c24b612c57d5628a7d1",
    ],
    "24": [
      "005ba132b7a8c2d9fd6e954ee527c3dfd23aeeb844f560c7d145a94382254891",
      "19c8337edf550ed436519c34aa6cce2ac47dd112c029ed666a1a948099fbc630",
      "d959f1e688a8d971d16efbb2d67390871a93d7b4b8ea82d4e0102b4edd78f88e",
    ],
    "25": [
      "4f584a486703c10dfbd89e2cbdc601a21d0b9ec790c04e526ae439af08230c32",
      "e5926551e837ba4dfc4c7a955b633e0ab248824083e1fcc226cde759cd2083b2",
      "4eca2706923d5744bb55d3e3d6d0478954f58fb67666698d34641a6d1fcf82e3",
    ],
    "26": [
      "b5e39f2045ab18db27873b8abb75b058f7f2cd9b03cf84ffc237ee494ec91b29",
      "163fa9a8dba0114be2c92c2c32b9b405a54ce87212c93979e11c01523a0bc0b8",
      "a7ce9b6e0556551215698b0de7304840ab5a6d79c4a575867f87240b312b4005",
    ],
  } as const;
  const [problemBasis, classificationBasis, parentHash] = pins[number];
  return exactRecoveryParent(
    stateDir,
    `problem-recoveries/v2-0009-00${number}-${problemBasis}.json`,
    `classification-recoveries/v2-0009-00${number}-${classificationBasis}-7bb7cb863c8c4855.json`,
    parentHash
  );
}

function q17ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0007-0017-f25fce5f04790b62b61851a6ce8771dd77d224dc962dd41f6d22bf037799b596.json",
    "classification-recoveries/v1-0007-0017-b609c64191307f85e8aefbc953a9facef111e0ecb4c4f0af1dff915210706ff8-" +
      "7bb7cb863c8c4855.json",
    "b9964bc828b45a8bb91ab4526563ffb8060cb197afb34581485673858507f6e6"
  );
}

function q18ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0007-0018-06e7d73768f018b14074754f24be4edcd44a0a827db48396f395f94619ff3295.json",
    "classification-recoveries/v1-0007-0018-95b1d6ac2ac315fed53bda0ecabd427e47b721b40a535d93d2a61aee091a863c-" +
      "7bb7cb863c8c4855.json",
    "c6e1102de25e6a751905958d31ea19375646a90d5d7e3b717d7d55bddaffbb70"
  );
}

function q19ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0007-0019-bbe87d7965f3ce7da4bfa1293717753d036729a8e02e8646c2ebf471518ca7f9.json",
    "classification-recoveries/v1-0007-0019-0389ce2367e4a98832a6f3fc9f7e75f54866d4110cc4528a16f4273a24025765-" +
      "7bb7cb863c8c4855.json",
    "dab952b2960c489006f15751116dcc7b1e8d6e9326a4278a0fd81991f8b5a50c"
  );
}

function q20ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0007-0020-bf8c01e2e30c975b6d417768d8f2fc75a0068a8c1e61ca3d1f8a7d541d9deaa6.json",
    "classification-recoveries/v1-0007-0020-417cece824faacd34b28f4b57b364033b84b39c461d0efe232d98c244cbfdab5-" +
      "7bb7cb863c8c4855.json",
    "720f3d723b4939d8d80b7a8e21e10a0559a1034872510206e3b91469d7dbe830"
  );
}

function q23ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0009-0023-fdf51b0ee15625b69b22a576c6e19e511cac3ae9916d16d88b581ef99de64dc6.json",
    "classification-recoveries/v1-0009-0023-9071e71519b2e6558466d6854af91d0b130bb5d42d02c4ac708f34723057ab68-" +
      "7bb7cb863c8c4855.json",
    "4183a4c0cceaa734b74198e0e4a78293035356fb2b53d9242c6863a2163be69f"
  );
}

function q28ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0011-0028-022c16b87254619033c6eebd32fa3777c5c80de1e314cbb92b823e85c5ec9776.json",
    "classification-recoveries/v1-0011-0028-5ad78252e58876eb4de4f041d514873c8bdd1ade2b63b0413e9b32cc91a28d5c-" +
      "7bb7cb863c8c4855.json",
    "ee49e74062dcd59bfa32d8c82b530f8de940c695da9afd364ccf174394b95fea"
  );
}

function q29ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0011-0029-d3a3866762b6cfb0894b1f74e4bb7227fec6f09109c9b66a3eaecd0cbe1313fd.json",
    "classification-recoveries/v1-0011-0029-334f8c6b9e9dbcd1203157a4c95d991692f7b7d7d4b11259623ef4d38429954e-" +
      "7bb7cb863c8c4855.json",
    "d88f9f50cdd2dfd34d7d74404027698347ffed38b98b8bb318f7d1be581d8ac2"
  );
}

function q30ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0011-0030-202d87d595e07f66b1284ec1648ff3fe3eecbb7d32274deb4e3532742d4cd262.json",
    "classification-recoveries/v1-0011-0030-c7a93c185f146d3b057945c3ed1c7be2f776c9c9698dfbf1e4e02c7f13f35fbd-" +
      "7bb7cb863c8c4855.json",
    "9d4f40e2325e13e6dd9c10f959962da421ee5a7b73bd1a7dd30c82af10cdf93b"
  );
}

function q31ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0012-0031-c07e95883d400b182b1a0ccebb4f94686df7d84207a77002fb030e9aabb326ec.json",
    "classification-recoveries/v1-0012-0031-60045db54855fe093ed30f42bc8898060e81ba88e148468ceceb36b187c76ebc-" +
      "7bb7cb863c8c4855.json",
    "a364a2fedaf9bffdba72022c2c51a2e9d672621f26c9bf723c046624d1365582"
  );
}

function q32ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0012-0032-3ceee04ce83231deaf7f91481e420fd649394a440b8c75a2c2ddd6be8563e069.json",
    "classification-recoveries/v1-0012-0032-da4e7c721ad769546d645a5538a8d4fdd577e22d9632b2a6f633d15d61e7379b-" +
      "7bb7cb863c8c4855.json",
    "10e903e5122357717cc01a3aa3a1eb86afd96f852c8deb4d2e20cf3b259926f7"
  );
}

function q37ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0014-0037-49354bf57e1ea9f037c416d839bb255905edc00c465707416482ee1c1ce54c07.json",
    "classification-recoveries/v1-0014-0037-98d4135e2f22fc494c1f0c2b9e9d11a59799af24562ebf58abfcb9b4d5b27da2-" +
      "7bb7cb863c8c4855.json",
    "d68f9a06514bb3af3d08ce4da864945d2df29c62c6152a08b457ca5067bad373"
  );
}

function q38ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0015-0038-f0a111b56171db4b4cd6d942cc4972629fccbdcadfbfbfe9757d7ff2762c8ebf.json",
    "classification-recoveries/v1-0015-0038-d19e2d9e8533fb8b35cd703c2bbf78763c3366a5bcc08ab94a2d745936355de9-" +
      "7bb7cb863c8c4855.json",
    "59a322acdb5c3211a6a26e34c906b1510533f08d7ca95cccf756d01b3e5604a8"
  );
}

function q39ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0015-0039-5f748be0e1d0c6866ae0bfa5cb116ba08d55c50ba907341481a590f04f90a195.json",
    "classification-recoveries/v1-0015-0039-1814765b3829514aeca357a4ab758b8c0a3172ac73db22bab914b5a590b7f60f-" +
      "7bb7cb863c8c4855.json",
    "c4f86ad116cf248fafcb360795081c949cd2442ed9c5375c56d5748385fdf25f"
  );
}

function q40ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0015-0040-f93efdcc07898d408ad1c4c89c2d6d57dcf96bdb6e68bd11ad6015ad15eeb24e.json",
    "classification-recoveries/v1-0015-0040-ee12e615bbaf0889c90dde6094a59607904c3b60fc85bbaebe0c74e7e89fecc3-" +
      "7bb7cb863c8c4855.json",
    "100910415cd507b1063d67a2741d3308f1543f04184fc646db245e9cbfb56d59"
  );
}

function q41ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0015-0041-89531809a502161b3e4fcea7802e0ccfca53b58938bb70e329d1c4f3c5107e63.json",
    "classification-recoveries/v1-0015-0041-ca6c2f969b6257a06b79a9ec28c8329e33d9925f0a79a5387d1a1bbcbaec6337-" +
      "7bb7cb863c8c4855.json",
    "58093bfe2be0b5b93c0495c450cb46f04c8e50df94607026f39fd42699a26e0d"
  );
}

function q42ExactRecoveryParent(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0015-0042-eadb7da9224ee4be24a7fed107de0e4251cfeab4346bb83ed32839388c0c9458.json",
    "classification-recoveries/v1-0015-0042-b5e4a0d83309d7265085ae387c1cc0ecfc7905ebf587c546e85e7d91eae43a9e-" +
      "7bb7cb863c8c4855.json",
    "6abad04cb27498469134ea70ad3f872b8a69e5f009905f223ec52211ca3185c1"
  );
}

function q42ExactRecoveryParent5577054(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0015-0042-12d32cb6f5448de87e22566e2205c9a106593466471cf6aebcd1d1d49d907df0.json",
    "classification-recoveries/v1-0015-0042-3b20ea97ba9eac7d4660626d5fe86ef79f2d43ce78c4f92c51975085ccbd8f54-" +
      "7bb7cb863c8c4855.json",
    "d3e9ad5ad035efdf5b3baed0762297735275a0c7287d7b5a6d4d5e3a6bf8afda",
  );
}

function q18ExactRecoveryParent5577054(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0006-0018-a9d0e1dc8918f501e5d51bfe66e7a34dfa3e1e2570fbd1d288c4e293bc3df01a.json",
    "classification-recoveries/v1-0006-0018-90d045acfc0dc47e6af65fdad6fbf450b1d52ad0b60c01ca5512d42a3c485db9-" +
      "7bb7cb863c8c4855.json",
    "ed98ba5f4376b7686d629f8bb95e9a4277b315303262e23edad7afecbf9d4c46",
  );
}

function q20ExactRecoveryParent5577054(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0006-0020-d05f40093fd4349a6de56fb6dfb53d8b65a58d50ecb767afc7a2c0b535bb61c2.json",
    "classification-recoveries/v1-0006-0020-28b3d10c203b901a693afa7c2d703f6b3431b95c68d70582a8cc1d831ccc9bc1-" +
      "7bb7cb863c8c4855.json",
    "f89e028e1b52502b23762ba467747b4a6726e1fb22003d85744c0e4afb6132ff",
  );
}

function q21ExactRecoveryParent5577054(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0007-0021-717c24e2e117dc11bf35d9f05953c0daed8bad95672c0a0043f5301ed34bfd7e.json",
    "classification-recoveries/v1-0007-0021-74c67e51f027144ff70feb02f1ae2bab7e86ce12109947247a140d9e0e21bdbe-" +
      "7bb7cb863c8c4855.json",
    "7935a025654eb7b4224af107fc29e149190d2b76f775a33194b3ae3b7665251e",
  );
}

function q22ExactRecoveryParent5577054(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0008-0022-8508845be3017ef55b690a6aa8e1eeef3b732189f50ba8c9a564706a0012ceba.json",
    "classification-recoveries/v1-0008-0022-caca9720f58ff52ec2925262951695de438478a2a06c44550b0325d247c7a73f-" +
      "7bb7cb863c8c4855.json",
    "296ac6cdf488ca3081168adf9e798dd31763df6bbc3d30c57e552f3c05b3c0ee",
  );
}

function q23ExactRecoveryParent5577054(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0008-0023-e4e9bb01cc7b4688bec2966b9ea33c0c0226e82f8ed34d87f2d27397b220cdc9.json",
    "classification-recoveries/v1-0008-0023-c7d7c07d9d05eb58ddf9d0a99ca4fba42e2b86445ceda79edc5f086477f8b4c3-" +
      "7bb7cb863c8c4855.json",
    "e486c77b1565458f4d68ff9df798111527610505ab2633e8809a3e71c379868a",
  );
}

function q24ExactRecoveryParent5577054(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0009-0024-b447410d8aa383d002e2695280f9bd3656fb6fbf8c44986ecea138a8390981cd.json",
    "classification-recoveries/v1-0009-0024-19c160eac2ddeb1ee8dccceb4ebba5b3b7547c091870d2a3159cdb168e237ee5-" +
      "7bb7cb863c8c4855.json",
    "d7c99f2fb8261b320d824ba8077842b842d07d94232fd22e0b003f90d36e082c",
  );
}

function q25ExactRecoveryParent5577054(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0009-0025-8888da896d940ee44e6e64cc4a5d8b876561af599acf13f89a0393f9242757e4.json",
    "classification-recoveries/v1-0009-0025-b561821ce3a2a28314e331a5769d04b4b3b4ee994669c2db05123b7bce5c7798-" +
      "7bb7cb863c8c4855.json",
    "94c0d95498e93fd60c341b59880b9bbb91d180cb086ad7a5b5f382dfe115e8b8",
  );
}

function q26ExactRecoveryParent5577054(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0009-0026-e949921601b79790243b63e7901ae39eea86e4bee0d37453da4e51801aa2edee.json",
    "classification-recoveries/v1-0009-0026-0f5a0af95aaf5276d096dd100e5f7b6522d8a799b1e107d9a91faaba54a04b90-" +
      "7bb7cb863c8c4855.json",
    "594537e6c1a0db71e5b7526ac2dd4cefbd0f6ffb63f1349ae0487505c084e49a",
  );
}

function q27ExactRecoveryParent5577054(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0010-0027-e88fa40c65c678e6874048cb6a9db299e75c5404dd261034e59d8921594bb8ca.json",
    "classification-recoveries/v1-0010-0027-f3574b249d8766840c5cbe5e9b892e35574aadd8d0ce6a738e5cf3f8940d9ec0-" +
      "7bb7cb863c8c4855.json",
    "f33a343a6709a94e86de6d671c6a8de5eb99255d84a216a57a6a66f5c952b89e",
  );
}

function q28ExactRecoveryParent5577054(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0010-0028-d573f0fb35d954720550bc4c5bad003d29562ec3603b8837c694f67d1498aaba.json",
    "classification-recoveries/v1-0010-0028-42f8c973f0b178c1a44ee4b2a1051b15f6c0adea0e04d41a44ee6ca3172e3ded-" +
      "7bb7cb863c8c4855.json",
    "a07d6c98d69371d46e2fe678b8e5e68986e9f6c3fd67379d6cbdfd7557163720",
  );
}

function q29ExactRecoveryParent5577054(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0010-0029-799f0b69ac960453402b0292a7b6b909e20fc5154f1498599ecd1b12411bcc8f.json",
    "classification-recoveries/v1-0010-0029-2d01d1f66f69e1c2f162879aa8d55d8225ccc8f48412ee5241ea6cd58dfe6213-" +
      "7bb7cb863c8c4855.json",
    "447593a3f9828e60ab2193ac5fdff82b5b2270feab312d6e1e5090032260e2bc",
  );
}

function q3ExactRecoveryParent5577054(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0001-0003-65be1c586307144e17ecdd5732155811c1efe0b193e261086bca7fba6ff7a1c3.json",
    "classification-recoveries/v1-0001-0003-dfc05b2722956fd5716030a0ded1c024369fff2eca24db0b85826b6af7e21a85-" +
      "7bb7cb863c8c4855.json",
    "b7e8aadd04697b10b457164b3f16cf14f185852964770c6437f0edc107302bed",
  );
}

function q6Q8ExactRecoveryParent5577054(stateDir: string, number: "6" | "7" | "8") {
  const pins = {
    "6": [
      "e8fb891b1ac8afb1fa91b08a32722e1d5e85d6addd86659cd91c017bd6985e06",
      "c39fc910f1d58874a0101ea52201514a1a8a858e8136a40a61edd7013e892dfe",
      "cfdbdaab54245a3fac0818a5508721396c9050c6f3ebe565308a03dc9221fee6",
    ],
    "7": [
      "f1b7abfef4fb944b1e8f15a14c93460b82bff7dbb00f28c171260c0ee926f797",
      "e49f1c7db5d83767f330fb755ef377c74e7841113a61fa7ca6b3edfd2c5be737",
      "ca02a83053d439a073df48dc02c52dfe4765466ec749d8ebf41de0ad93847c8f",
    ],
    "8": [
      "12c1c2c79d53f3e666e66be062242f968bb26ad48153c3c744af849080118b0e",
      "cdc5e032b5f8111bdaf5f4dad9e4fe5ad910415c89705d73a2a18333109280ad",
      "65a516771fed767b52e6b5532d62673e6cc7f6b1c1ca42158cc5bc71096f99f0",
    ],
  } as const;
  const [problemBasis, classificationBasis, parentHash] = pins[number];
  return exactRecoveryParent(
    stateDir,
    `problem-recoveries/v1-0003-000${number}-${problemBasis}.json`,
    `classification-recoveries/v1-0003-000${number}-${classificationBasis}-7bb7cb863c8c4855.json`,
    parentHash,
  );
}

function q14ExactRecoveryParent5577054(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0005-0014-d09919a7d33509ec552e954f5aa19eef07ee60c50f6ce368ac81e2fae7095646.json",
    "classification-recoveries/v1-0005-0014-6aa3691f9ae29f3029afcfe4f828d748ea8bd41a0d871e9f6598b4e4b3eafaf9-" +
      "7bb7cb863c8c4855.json",
    "76b4d731d9713ad680c5952a5d81b976877a8ec025576ee4f87836e49184a7e0",
  );
}

function q30Q32ExactRecoveryParent5577054(stateDir: string, number: "30" | "31" | "32") {
  const rows = {
    "30": {
      problem: "v1-0011-0030-9add287e01a3ae36253fe5b0efd88816a43855a93312054218d20abb49fbdfe4.json",
      classification: "v1-0011-0030-d0ea44cc4be46a1d9d5a3c7ae657b862c54bd0c8f7261338d680b214e52dc481-" +
        "7bb7cb863c8c4855.json",
      parent: "62008bbfa0b5e0ee0877de80ece54e5a30255ae986417b45e9e0b801814b34cc",
    },
    "31": {
      problem: "v1-0011-0031-77b78320d67f3d8e4a1a3d2c6f696807be190b5f08137b9f255e3a1fa14e7f1e.json",
      classification: "v1-0011-0031-66bdc9b355cd4871f70b11d5d9f0257eda07ea7e5f6157e9ebc4c2d5ae2787c3-" +
        "7bb7cb863c8c4855.json",
      parent: "e5b4339a692a7035baf754f713614c57aa155b176414c61b596d9f0820242f7a",
    },
    "32": {
      problem: "v1-0011-0032-3b6cb76b3589e5b7eee3eceef28f5f9675d38df5fcb6212e9a951ca60e7d55d0.json",
      classification: "v1-0011-0032-0e980f23dc645861ab42876d07957e1318a9e4db44a10a441be7fb76ccd6dee3-" +
        "7bb7cb863c8c4855.json",
      parent: "7eb6f571ff3dd72d3a7b5c45786331d99203901e94d4f2b3039b71615721d74e",
    },
  } as const;
  const row = rows[number];
  return exactRecoveryParent(
    stateDir,
    `problem-recoveries/${row.problem}`,
    `classification-recoveries/${row.classification}`,
    row.parent,
  );
}

function q35ExactRecoveryParent5577054(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0013-0035-5fd524995fdf6a4e5ee42560288f8f8f7d0da438a0dd57df29b5eb0a909c60c5.json",
    "classification-recoveries/v1-0013-0035-b8c2df1f8b77d28746eab37d09d5a70174bf8d8726bf25d39a8f2a9603d19288-" +
      "7bb7cb863c8c4855.json",
    "4c85182b48c685907a77cccac95468c529f336a70f19c9a0fca7b3e863c4c609",
  );
}

function q36ExactRecoveryParent5577054(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0013-0036-b73936b786e6dedd7ebd2838f902d8da1443b9f303e96b0b1e89fc504cb62642.json",
    "classification-recoveries/v1-0013-0036-264a5294e9889c17cd507fcc1699d34a16f58f9f3fb7e8e0c724590fbba68032-" +
      "7bb7cb863c8c4855.json",
    "67cb28e87abe133a0ba5bba0a0541898c46df8ce6326daf02d9c67db1434049b",
  );
}

function q31Q32ExactRecoveryParent5578421(stateDir: string, number: "31" | "32") {
  const pins = {
    "31": [
      "5055fe6fd48bf51df91b6ce57ef4f949f430567ac3f3b3a27265d3e9a66ac6bd",
      "c6100e65d06bdd72d07c1714eb98b33cee7b2f833ee2d3b7851ca342de055436",
      "31736e6fcf16af511a3264db1bb97303bffe4c391643659b0c503d745de7f2de",
    ],
    "32": [
      "fa06c96159bfaf04070ab67ad4a4b5ee493415b6174d32fd724822f7dea65556",
      "5482a2008b0359682eccca0410a2c3eea583b03d35fb96f889d3cd75fec86965",
      "0522267c8991e42758995b53ee672ced5c6d4ae97f83ea2c985f487bfcd6d464",
    ],
  } as const;
  const [problemBasis, classificationBasis, parentHash] = pins[number];
  return exactRecoveryParent(
    stateDir,
    `problem-recoveries/v1-0012-00${number}-${problemBasis}.json`,
    `classification-recoveries/v1-0012-00${number}-${classificationBasis}-7bb7cb863c8c4855.json`,
    parentHash
  );
}

function q33Q34ExactRecoveryParent5578421(stateDir: string, number: "33" | "34") {
  const pins = {
    "33": [
      "7a5af6b99f37155fe6589b01bd3c0d91af28409d8dccc1b7b29addec7d66a477",
      "5583504ce366c1ce323ff7bc992121c7b2ee9424e643feabe69f36861f757b36",
      "3bfbc6ff981d7c04b5803bd03ca44171950a14727490e5cf01f0382592bbab70",
    ],
    "34": [
      "8ebd97d430525b0fb6acb9fb6f5d5140857c82bb229f24574d48197799574784",
      "1ba05579bb4777640336e306502b2ee87e181dbf2f59da9cd812e674d897ca9f",
      "9ee5f4a5e633fd3354269c261f6a5a08a83f181ce7f56e2ae0d47ec33127e052",
    ],
  } as const;
  const [problemBasis, classificationBasis, parentHash] = pins[number];
  return exactRecoveryParent(
    stateDir,
    `problem-recoveries/v1-0012-00${number}-${problemBasis}.json`,
    `classification-recoveries/v1-0012-00${number}-${classificationBasis}-7bb7cb863c8c4855.json`,
    parentHash
  );
}

function q6Q7ExactRecoveryParent5578421(stateDir: string, number: "6" | "7") {
  const pins = {
    "6": [
      "f7cf8bc34cf51d591e860350412ce2147c5145b540c8295b87c1c307ad3cece5",
      "e86c226740445779a697f80fd6a5c0f06658e37ff4a37e3685b71496f12a5e89",
      "86c2932460456351d20cb215d9e768cde33886f0326d25f84cf884f80f48309f",
    ],
    "7": [
      "f2d88d1aa76834d316fa224e6197060ce5030742fe8a3f58eb95fbe013ef94fd",
      "327f07000ed249e0c894d9b9823ff6fc33fae838f09f4f08f9eebbb49ed4b40b",
      "757964e9fb4368a06ae8c04e7fcbee1ec8d77d3f9024e5239b64498b73ca06f7",
    ],
  } as const;
  const [problemBasis, classificationBasis, parentHash] = pins[number];
  return exactRecoveryParent(
    stateDir,
    `problem-recoveries/v1-0003-000${number}-${problemBasis}.json`,
    `classification-recoveries/v1-0003-000${number}-${classificationBasis}-7bb7cb863c8c4855.json`,
    parentHash
  );
}

function q19Q21ExactRecoveryParent5578421(stateDir: string, number: "19" | "20" | "21") {
  const pins = {
    "19": [
      "8b56b92181dca30de66117f4470e94cee4f27c42f83d1e87cf59a5a45d615bcd",
      "e5a6af0076be91e5c34131ae2ea2c6cded7718d13431880363b9883393444606",
      "1e4c8241e9391c05b428cd2c561da4fcb2c0b090119e3f5182b107be3b42f9da",
    ],
    "20": [
      "57b6bd2c8c024fe5975033f4ddd5f130a4ea226bfc6ff8209a9ee9469e6ecf53",
      "e1035eaafcbbf6f562a992fcd1505e3332e876bb1d9e92729ef5837d73ea3c30",
      "f92b5c7a27643d72811332be77b20512e0c96ddab611ead75e68e157c583d394",
    ],
    "21": [
      "b5307b39476b31db2346824fe58bfa5fb1f6dd1989aff35a7d0d3be312005950",
      "5dc4a3607daaa996fa38c695a7907c944b24e8a39a3df9cbef21620fac4b760f",
      "be3348b3d4d34cb6450e3620a8aa8195ed8331c370b6a30e1458d70492afcda0",
    ],
  } as const;
  const [problemBasis, classificationBasis, parentHash] = pins[number];
  return exactRecoveryParent(
    stateDir,
    `problem-recoveries/v1-0008-00${number}-${problemBasis}.json`,
    `classification-recoveries/v1-0008-00${number}-${classificationBasis}-7bb7cb863c8c4855.json`,
    parentHash
  );
}

function q44Q45ExactRecoveryParent5578421(stateDir: string, number: "44" | "45") {
  const pins = {
    "44": [
      "1996e4e2840643bb3f669e15a6a91c220ac3024db1da762ab750350f9876c5d6",
      "2ea5e9ad6ca8af868b14d280ad39a58a67d442acd6c392965e65642de0c63331",
      "e0a4da2358b622c0b6ba44bb5b6a7f3c12773d4c5b63cf0b06ae9cd69413235e",
    ],
    "45": [
      "26da0b021ebf360393ac84c67d203c4fc037ce66a7817803a87359a1ca7105cf",
      "d0e3f2e1a275b55661d0b4f8e1e38d9738f96708c7d90fd29dbdf2c09f845819",
      "509282a7d921720fc7c5507606bf80b03113c096aa5cadf3eaa59adfd8fecc33",
    ],
  } as const;
  const [problemBasis, classificationBasis, parentHash] = pins[number];
  return exactRecoveryParent(
    stateDir,
    `problem-recoveries/v2-0016-00${number}-${problemBasis}.json`,
    `classification-recoveries/v2-0016-00${number}-${classificationBasis}-7bb7cb863c8c4855.json`,
    parentHash
  );
}

function q14ExactRecoveryParent5578421(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v2-0005-0014-6cd6f92df1ac90a8d91187929301ca43f27a4b2c55e662921bd25733ff2864fc.json",
    "classification-recoveries/v2-0005-0014-fb705484127656ccbf8e08fcee6fa906444c9e0f7a4735dde7a979050ff8b738-" +
      "7bb7cb863c8c4855.json",
    "1186ce8d805522044fe8fbfba39c5c2f5529988e2000e09532c8201b30593ca1"
  );
}

function q2ExactRecoveryParent5578421(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v2-0001-0002-e322f36305803b31326fea3e23a11167842ec4b463befb6f46bf2df55961446f.json",
    "classification-recoveries/" +
      "v2-0001-0002-fa3826c3b24eeb3e28980172bec0ecf2b01592807d9186290ced69af9a0ed170-" +
      "7bb7cb863c8c4855.json",
    "c09674a75c0e93955440fe4094943cdddedaff96fc355e76620bf1b5ed86043c",
  );
}

function q3ExactRecoveryParent5578421(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v2-0001-0003-f939dbf72a7739058ba053e89d46322e7b846bee92dc9f81bce7464f9e570e0f.json",
    "classification-recoveries/" +
      "v2-0001-0003-8700b8c4d883c8d1a0b1bcefa2e189baf36429ea0a56870503896eb7424684d5-" +
      "7bb7cb863c8c4855.json",
    "fd585d64392d492db3840b3a75bd480748fe0ae6b7b22cf99982f59303edc4a0",
  );
}

function q3ExactRecoveryParentV2_5578421(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0001-0003-d0679133d0fc5d5deb25c345aca9cf84f7e162e46ca6b03805dfa3f188f12981.json",
    "classification-recoveries/" +
      "v1-0001-0003-59f7879d4adca4dcdea88649854cd840fdd812448869705fb086e8e9de023583-" +
      "7bb7cb863c8c4855.json",
    "b2a2d24967a85e0dca3a6042d2fec44a4950e00c4c9b05beb6d07bd6b009f7a8",
  );
}

function q12ExactRecoveryParent5578421(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0004-0012-f8397cbeef120e3e3bbbafaf75ccccc8648e460b12df256a0e39702d8e94641d.json",
    "classification-recoveries/" +
      "v1-0004-0012-52392aea34b513d1f1e41cdb6340d177e458cddaa48d481597ba022ac5e85a89-" +
      "7bb7cb863c8c4855.json",
    "2cec6cbd5de6b7795867c7b1897ce4c7dd35adbbc34e6be17f445e060dee9207",
  );
}

function q43ExactRecoveryParent5578421(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v2-0016-0043-68d498a2bcfb6c9c918d105e50729ebb974e35b11b5b59d780612c6f537e49c1.json",
    "classification-recoveries/" +
      "v2-0016-0043-3c6b985e67070fcb0406f0af6d02be3a4164950cb3e9d1917c4b337b1215785f-" +
      "7bb7cb863c8c4855.json",
    "a2fd297236204de0e51cae9b8a40192b01eafd98aea39e7e2ff83d46e5ea2ffc",
  );
}

function q38ExactRecoveryParent5578421(stateDir: string) {
  return exactRecoveryParent(
    stateDir,
    "problem-recoveries/v1-0015-0038-20de903b4712cf3bf362331d56a2059622d5b78dccb5806b9a94b5c21094c876.json",
    "classification-recoveries/" +
      "v1-0015-0038-e1c28ad60aaad2b3a08d95f41817cf0a002bcc780b04077cd8be07a43746a105-" +
      "7bb7cb863c8c4855.json",
    "fcedb565f4bb9c107733c378cef32039e458be2f33ee8ce3071eaff8297593b2",
  );
}

const Q43_CORRECTED_SOLUTION =
  "(가)에서는 ‘여기 하나의 상심한 사람이 있다.’와 ‘여기 하나의 굳세게 살아온 인생이 있다.’와 " +
  "같이 변주함으로써 주제 의식을 강조하고 있고, (나)에서는 ‘더 추워야겠다’와 ‘한껏 " +
  "가난해져야겠다’와 같이 유사한 시구를 변주함으로써 주제 의식을 강조하고 있다. [오답풀이] " +
  "① (가)에서는 마지막 부분에서 유사한 시구가 반복되기는 하지만 역동적 측면을 부각하는 것은 " +
  "아니며, (나)에서는 점층적 부분이 드러난다고 보기 어렵다. ② (가)에서는 의성어의 활용이 " +
  "드러나지 않고, (나)에서는 ‘카랑카랑’을 통해 새들의 목소리를 표현하고 있다. ④ 반어적 표현은 " +
  "(가)와 (나) 모두 찾기 어렵다. ⑤ 여정에 따른 공간 이동은 (가)와 (나) 모두 나타나지 않는다.";

const cases = [{
  entryId: "ebsi:5594499",
  sourceHash: "0ddccee92ce4e4ba3da53ed253e780cd7b41b5962f7e9761a920079619f81c31",
  path: join(
    process.cwd(),
    "data/import-exam-corpus/4142baa37330a6d3d470294a/" +
      "problem-crop-adjudications/v1-0013-0034-3ee24c800c83bb2f3b7c235749076619e564edc51120a003f59e0d57e7b511fb.json"
  ),
}, {
  entryId: "ebsi:5578421",
  sourceHash: "4c9aee0ec0c15f91678bc3c179efb4c781ab0f9023ca2e5347df94060012272e",
  path: join(
    process.cwd(),
    "data/import-exam-corpus/f914a5cf8d2237d6c9319e23/" +
      "problem-recoveries/v1-0012-0030-20741052441e79627764f61577085ececd18660f475b4a29a4860b98175ef1d7.json"
  ),
}, {
  entryId: "ebsi:5525984",
  sourceHash: "1621eca42821e5feccbb56604249cbcedd8adf6bae6109960f6c790a61c14ec1",
  path: join(
    process.cwd(),
    "data/import-exam-corpus/7755c70fefaa45f755086e2b/" +
      "problem-recoveries/v1-0003-0008-8a81b3c4948de9fe7211cd8db475f5858850e48d88de6dda267d3538cdebf7ad.json"
  ),
}, {
  entryId: "ebsi:5656593",
  sourceHash: "e1b0ffd692634a4a2b1500877691cf0f4ff622fb85c6dd1dba4aff65dfd29e1d",
  path: join(
    process.cwd(),
    "data/import-exam-corpus/714fd4581f778a9c559fd16e/" +
      "problem-recoveries/v1-0007-0018-8dc9e3101914ced2b5380528cdf56f5c607f0911f8a4f4460835260ae4cd6b3a.json"
  ),
}, {
  entryId: "ebsi:5854871",
  sourceHash: "c41b1ee2f3897cbde107c4ffcdec493583bacba4d14299c6c3a6a749b29a80d6",
  path: join(
    process.cwd(),
    "data/import-exam-corpus/a915803b3da3a6ea056eecd6/" +
      "problem-recoveries/v1-0002-0009-ce5a6650673a79cd5cebf9a1d0593bcc75f9acd7fc5a57551ea1becf69e443d5.json"
  ),
}, {
  entryId: "ebsi:5594499",
  sourceHash: "0ddccee92ce4e4ba3da53ed253e780cd7b41b5962f7e9761a920079619f81c31",
  path: join(
    process.cwd(),
    "data/import-exam-corpus/4142baa37330a6d3d470294a/" +
      "problem-recoveries/v1-0004-0009-bddde1723f11b47836bb403b1415e8663a05efb246e6d6d51157be0a9c1b5cf0.json"
  ),
}, {
  entryId: "ebsi:5577054",
  sourceHash: "d7664675fc1e39cc99f507d6cc7bf7c4a1404106d140d9a2f904726ddec4c062",
  path: join(
    process.cwd(),
    "data/import-exam-corpus/4745f3573f575a93f6adcccb/" +
      "problem-recoveries/v1-0016-0043-9f785a5c7a2c2ae2813ddce7acae5e846c5b29d63a7f37def793f9fd05e8a4d1.json"
  ),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(
    process.cwd(),
    "data/import-exam-corpus/bb876a67170089dfb2022f47/" +
      "problem-recoveries/v1-0011-0027-e2d59ea1699886f21ab5218fd221a8fa05f0beb46a1782ed48c9ec9cb583541c.json"
  ),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0016-0043-893ea8236c5d881c819d3336605183440bb53c94389a89db67589152ebf828d7.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0016-0044-c8841b55f41bfad8201f8aaff2df9a526b2400e2f125f0c22295b8d9d4c37ebb.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0016-0045-a3e22855003d515e214638d7d00f7ef2aa383e5310cc1c92b074fd226cacb15a.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0004-0008-2a1df1d1f5ce36c0a0c1953ffea79eadeaf7362fd0cfbee30dfd349fe0c97916.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0006-0016-0034825317e678c15add0b4805f1d433ac8ce58f1182414daeb82278b7ee4c2f.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0007-0017-f25fce5f04790b62b61851a6ce8771dd77d224dc962dd41f6d22bf037799b596.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0007-0020-bf8c01e2e30c975b6d417768d8f2fc75a0068a8c1e61ca3d1f8a7d541d9deaa6.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0009-0023-fdf51b0ee15625b69b22a576c6e19e511cac3ae9916d16d88b581ef99de64dc6.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0011-0028-022c16b87254619033c6eebd32fa3777c5c80de1e314cbb92b823e85c5ec9776.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0011-0029-d3a3866762b6cfb0894b1f74e4bb7227fec6f09109c9b66a3eaecd0cbe1313fd.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0011-0030-202d87d595e07f66b1284ec1648ff3fe3eecbb7d32274deb4e3532742d4cd262.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0012-0031-c07e95883d400b182b1a0ccebb4f94686df7d84207a77002fb030e9aabb326ec.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0012-0032-3ceee04ce83231deaf7f91481e420fd649394a440b8c75a2c2ddd6be8563e069.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0014-0037-49354bf57e1ea9f037c416d839bb255905edc00c465707416482ee1c1ce54c07.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0015-0038-f0a111b56171db4b4cd6d942cc4972629fccbdcadfbfbfe9757d7ff2762c8ebf.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0015-0040-f93efdcc07898d408ad1c4c89c2d6d57dcf96bdb6e68bd11ad6015ad15eeb24e.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0015-0041-89531809a502161b3e4fcea7802e0ccfca53b58938bb70e329d1c4f3c5107e63.json"),
}, {
  entryId: "ebsi:5525982",
  sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
  path: join(q27LiveState, "problem-recoveries/v1-0015-0042-eadb7da9224ee4be24a7fed107de0e4251cfeab4346bb83ed32839388c0c9458.json"),
}] as const;

const available = cases.every((item) => existsSync(item.path));
const itemAt = (index: number): QuizItemEx => JSON.parse(readFileSync(cases[index].path, "utf8")).item;
const q30ManualProblemPath = join(
  process.cwd(),
  "data/import-exam-corpus/f914a5cf8d2237d6c9319e23/" +
    "problem-manual-adjudications/v1-0012-0030-9160f0b6d43731cf2e42b1cfeb87067a4df0be2b12adae2946f12c560f1a9f64.json"
);
const q18ManualProblemPath = join(
  process.cwd(),
  "data/import-exam-corpus/714fd4581f778a9c559fd16e/" +
    "problem-manual-adjudications/v1-0007-0018-6bb09f45c9c5e829fcbcf1f47111735af9ec8269951655ff73239abc5ac16e94.json"
);
const q32ManualProblemPath = join(
  q27LiveState,
  "problem-manual-adjudications/v1-0012-0032-6709751f073d010e1292ae92fd604d052055fc3aef358acad94a0a27e18d7e39.json"
);

const recoveryCases = [{
  index: 1,
  stateDir: join(process.cwd(), "data/import-exam-corpus/f914a5cf8d2237d6c9319e23"),
  classificationPath: join(
    process.cwd(),
    "data/import-exam-corpus/f914a5cf8d2237d6c9319e23/" +
      "classification-recoveries/v1-0012-0030-7cc21907e44db72c61eb6a182cdd540f771bbc0efab4cae799c5bd681b53819c-7bb7cb863c8c4855.json"
  ),
  questionCount: 45,
  pageCount: 16,
  finalAnchor: "가로선은 총 2개",
  expectedDecision: "accept",
  manualRevisionClassificationPath: join(
    process.cwd(),
    "data/import-exam-corpus/f914a5cf8d2237d6c9319e23/" +
      "classification-manual-adjudications/v1-0012-0030-2415dd634f5b3bde1fa8113d4e6d2f6900a418dcc2d37da64067839a1ff2c9ae-7bb7cb863c8c4855.json"
  ),
  manualRevisionBeforeAnchor: "그리고 단순 명제 ‘$p$’와 ‘$q$’를 ‘만약 …이면 …이다.’",
  manualRevisionAfterAnchor: "그리고 단순 명제 ‘$p$’와 ‘$q$’는 ‘만약 …이면 …이다.’",
}, {
  index: 2,
  stateDir: join(process.cwd(), "data/import-exam-corpus/7755c70fefaa45f755086e2b"),
  classificationPath: join(
    process.cwd(),
    "data/import-exam-corpus/7755c70fefaa45f755086e2b/" +
      "classification-recoveries/v1-0003-0008-8d9fd17fd4f756f2fe7ede1a8557d4f6f42c6b498c0bb4e6d9dc693f7f7b6ca9-7bb7cb863c8c4855.json"
  ),
  questionCount: 30,
  pageCount: 12,
  finalAnchor: "원점 $O=(0,0)$에는 뚫린 점",
  expectedDecision: "accept",
}, {
  index: 3,
  stateDir: join(process.cwd(), "data/import-exam-corpus/714fd4581f778a9c559fd16e"),
  classificationPath: join(
    process.cwd(),
    "data/import-exam-corpus/714fd4581f778a9c559fd16e/" +
      "classification-recoveries/v1-0007-0018-eadc507490e4723cf09f622b2231222ff5cb12db3609ab381b79951dc1de3144-7bb7cb863c8c4855.json"
  ),
  questionCount: 30,
  pageCount: 12,
  finalAnchor: "읽는 순서는 단일, 단일, 복합, 복합",
  expectedDecision: "reject",
  manualRevisionClassificationPath: join(
    process.cwd(),
    "data/import-exam-corpus/714fd4581f778a9c559fd16e/" +
      "classification-manual-adjudications/v1-0007-0018-cab56b019c32271261bcb7389650c4d60fb52e22913de90a47412785e53752dc-7bb7cb863c8c4855.json"
  ),
  manualRevisionBeforeAnchor: "세 점 $L_1$, $M_1$, $N_1$이 각각 $\\overline{A_1B_1}$, " +
    "$\\overline{B_1C_1}$, $\\overline{C_1A_1}$의 중점이고,",
  manualRevisionAfterAnchor: "세 선분 $A_1B_1$, $B_1C_1$, $C_1A_1$의 중점을 각각 " +
    "$L_1$, $M_1$, $N_1$이라 하고,",
}, {
  index: 4,
  stateDir: join(process.cwd(), "data/import-exam-corpus/a915803b3da3a6ea056eecd6"),
  classificationPath: join(
    process.cwd(),
    "data/import-exam-corpus/a915803b3da3a6ea056eecd6/" +
      "classification-recoveries/v1-0002-0009-284f685922e94c9eca6aef2dc7cb776f8ee4fc04601b32ecf959f840d264fc34-7bb7cb863c8c4855.json"
  ),
  questionCount: 20,
  pageCount: 4,
  finalAnchor: "A는 노르웨이",
  expectedDecision: "accept",
  expectedCanonicalSubject: "integrated_social",
  expectedDpi: 600,
}, {
  index: 5,
  stateDir: join(process.cwd(), "data/import-exam-corpus/4142baa37330a6d3d470294a"),
  classificationPath: join(
    process.cwd(),
    "data/import-exam-corpus/4142baa37330a6d3d470294a/" +
      "classification-recoveries/v1-0004-0009-fecdbfac299fdcff5ae6e0aea267b5f41cdad60c684639b8d2e2160e937de6d2-7bb7cb863c8c4855.json"
  ),
  questionCount: 45,
  pageCount: 16,
  finalAnchor: "ⓐ, ⓑ, ⓒ, ⓓ, ⓔ는 각각 정확히 한 번 보인다.",
  expectedDecision: "reject",
  expectedDpi: 600,
}, {
  index: 6,
  stateDir: join(process.cwd(), "data/import-exam-corpus/4745f3573f575a93f6adcccb"),
  classificationPath: join(
    process.cwd(),
    "data/import-exam-corpus/4745f3573f575a93f6adcccb/" +
      "classification-recoveries/v1-0016-0043-921b9df51f48b859874f6130f78341df54117e62171d973f74c7f115d64f36a7-7bb7cb863c8c4855.json"
  ),
  questionCount: 45,
  pageCount: 16,
  finalAnchor: "서로 겹치지 않는 [A], [B], [C] 순서",
  expectedDecision: "accept",
  expectedCanonicalSubject: "korean_literature",
  expectedDpi: 600,
  repairSolution: true,
}] as const;

const recoveryCasesAvailable = recoveryCases.every((item) =>
  existsSync(join(item.stateDir, "problem.pdf")) && existsSync(join(item.stateDir, "entry.json")) &&
  existsSync(item.classificationPath) && existsSync(cases[item.index].path) &&
  (!("manualRevisionClassificationPath" in item) || existsSync(item.manualRevisionClassificationPath))
);

async function runRecoveryManualCase(testCase: typeof recoveryCases[number]) {
  root = mkdtempSync(join(tmpdir(), "studywork-manual-recovery-"));
  const storedEntry = JSON.parse(readFileSync(join(testCase.stateDir, "entry.json"), "utf8")).entry;
  const entry = parseCorpusManifest({ schemaVersion: 2, entries: [storedEntry] }).entries[0];
  const officialProblemPath = join(testCase.stateDir, "problem.pdf");
  const problemBytes = readFileSync(officialProblemPath);
  const repairSolution = "repairSolution" in testCase;
  let solutionBytes: Uint8Array;
  let solutionPath: string;
  let solutionPageCount: number;
  if (repairSolution) {
    solutionPath = join(testCase.stateDir, "solution.pdf");
    solutionBytes = readFileSync(solutionPath);
    solutionPageCount = 5;
  } else {
    const solutionDocument = await PDFDocument.create({ updateMetadata: false });
    solutionDocument.addPage([100, 100]);
    solutionBytes = await solutionDocument.save();
    solutionPath = join(root, "solution.pdf");
    solutionPageCount = 1;
    writeFileSync(solutionPath, solutionBytes);
  }
  const problem: PdfEvidence = {
    path: officialProblemPath,
    sha256: hash(problemBytes),
    bytes: problemBytes.length,
    pageCount: testCase.pageCount,
    requestedUrl: entry.problemPdfUrl,
    resolvedUrl: entry.problemPdfUrl,
  };
  const solution: PdfEvidence = {
    path: solutionPath,
    sha256: hash(solutionBytes),
    bytes: solutionBytes.length,
    pageCount: solutionPageCount,
    requestedUrl: entry.solutionPdfUrl,
    resolvedUrl: entry.solutionPdfUrl,
  };
  const exhausted = itemAt(testCase.index);
  const exhaustedClassification = JSON.parse(
    readFileSync(testCase.classificationPath, "utf8")
  ).items[0] as ClassificationDecision;
  const failedManualClassification = "manualRevisionClassificationPath" in testCase
    ? JSON.parse(readFileSync(testCase.manualRevisionClassificationPath, "utf8")).items[0] as ClassificationDecision
    : null;
  const manualRevisionBeforeAnchor = "manualRevisionBeforeAnchor" in testCase
    ? testCase.manualRevisionBeforeAnchor
    : null;
  const manualRevisionAfterAnchor = "manualRevisionAfterAnchor" in testCase
    ? testCase.manualRevisionAfterAnchor
    : null;
  const targetNumber = Number(exhausted.number);
  const targetKey = `${exhausted.page}:${targetNumber}`;
  const questions: QuizItemEx[] = Array.from({ length: testCase.questionCount }, (_, index) => {
    const number = index + 1;
    if (number === targetNumber) {
      return { ...structuredClone(exhausted), question: `${exhausted.question}\n[base transcription]` };
    }
    return {
      number: String(number),
      qtype: "short",
      difficulty: "중",
      question: `${number}번 범위 밖 문제`,
      choices: null,
      answer: String(number),
      explanation: "",
      page: Math.min(testCase.pageCount, Math.max(1, Math.ceil(number / 3))),
      figure: false,
      figure_description: null,
      box: null,
    };
  });
  const targetDecision = (
    question: QuizItemEx,
    status: "exact" | "mismatch",
    evidence = status === "exact" ? "공식 source pixels와 일치한다." : "공식 source 시각 세부가 누락됐다."
  ): ClassificationDecision => ({
    ...exhaustedClassification,
    key: `${question.page}:${question.number}`,
    transcription_status: status,
    transcription_evidence: evidence,
  });
  const decisions = questions.map((question) => Number(question.number) === targetNumber
    ? targetDecision(question, "mismatch")
    : {
        key: `${question.page}:${question.number}`,
        decision: "reject" as const,
        canonical_subject: null,
        curriculum_course: null,
        domain: null,
        achievement_codes: [],
        confidence: 0.99,
        reason_codes: ["OUT_OF_SCOPE"],
        transcription_status: "exact" as const,
        transcription_evidence: "공식 source pixels와 일치한다.",
      });
  const classified = questions.map((question, index) => ({ question, classification: decisions[index] }));
  const baseTargetSolution = repairSolution
    ? (JSON.parse(readFileSync(join(testCase.stateDir, "solution-chunks/v3-0000.json"), "utf8"))
      .items as SolutionItem[]).find((item) => Number(item.number) === targetNumber)!
    : undefined;
  if (repairSolution) {
    expect(solution.sha256).toBe("2abfea3ad57f76b754720050839da1698222201359f290054d3c5564d3121f8a");
    expect(baseTargetSolution?.explanation).toMatch(/근세게|더 추워하겠다|여성어|가랑가랑/u);
  }
  const solutions: SolutionItem[] = questions.map((question) => Number(question.number) === targetNumber &&
      baseTargetSolution
    ? structuredClone(baseTargetSolution)
    : {
        number: question.number!,
        answer: Number(question.number) === targetNumber ? exhausted.answer : question.answer,
        explanation: `${question.number}번 공식 해설`,
        page: 1,
        complete: true,
      });
  writeJson(join(root, "problem-chunks", "v2-0000.json"), {
    version: 2,
    sourceHash: problem.sha256,
    from: 1,
    to: testCase.pageCount,
    ownedFrom: 1,
    ownedTo: testCase.pageCount,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    items: questions,
  });
  writeJson(join(root, "classification-chunks", `v${CLASSIFIER_VERSION}-0000-${CLASSIFIER_DIGEST}.json`), {
    version: CLASSIFIER_VERSION,
    sourceHash: problem.sha256,
    from: 1,
    to: testCase.pageCount,
    ownedFrom: 1,
    ownedTo: testCase.pageCount,
    rulesDigest: CLASSIFIER_DIGEST,
    transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
    transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    items: decisions,
  });
  writeJson(join(root, "solution-chunks", "v3-0000.json"), {
    version: 3,
    sourceHash: solution.sha256,
    from: 1,
    to: solutionPageCount,
    ownedFrom: 1,
    ownedTo: solutionPageCount,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    items: solutions,
  });

  const calls = { extraction: 0, classification: 0, terminal: 0, solution: 0, solutionRepair: 0, semantic: 0 };
  let resumingManualRevision = false;
  providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
    if (request.schema?.name === "studywork_file_quiz_items") {
      calls.extraction++;
      const recovery = request.prompt.includes("FINAL SOURCE-GROUNDED RECOVERY");
      const item = structuredClone(exhausted);
      if (!recovery) item.question += calls.extraction === 1 ? "\n[first repair]" : "\n[first revision]";
      return { text: JSON.stringify([{ ...item, choiceCount: item.choices?.length ?? null }]) };
    }
    if (request.schema?.name === "studywork_exam_corpus_classification") {
      calls.classification++;
      const inputs = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{ question: string }>;
      if (failedManualClassification && resumingManualRevision) {
        expect(inputs).toHaveLength(1);
        expect(inputs[0].question).toContain(manualRevisionAfterAnchor);
        expect(request.prompt).not.toContain(failedManualClassification.transcription_evidence);
        return { text: JSON.stringify([targetDecision(
          exhausted,
          "exact",
          "공식 source pixels와 deterministic manual revision을 포함해 전체 문항이 일치한다."
        )]) };
      }
      if (calls.classification === 3) return { text: JSON.stringify([exhaustedClassification]) };
      if (failedManualClassification && calls.classification === 4) {
        expect(inputs[0].question).toContain(manualRevisionBeforeAnchor);
        return { text: JSON.stringify([failedManualClassification]) };
      }
      if (failedManualClassification && calls.classification === 5) {
        expect(inputs[0].question).toContain(manualRevisionAfterAnchor);
        expect(request.prompt).not.toContain(failedManualClassification.transcription_evidence);
        throw new Error("seeded manual revision crash");
      }
      return { text: JSON.stringify([targetDecision(
        exhausted,
        calls.classification === 1 ? "mismatch" : "exact",
        inputs[0].question.includes(testCase.finalAnchor)
          ? "수동 source evidence의 시각 세부까지 exact다."
          : "공식 source 시각 세부를 재검증했다."
      )]) };
    }
    if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
      calls.terminal++;
      const inputs = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{
        key: string;
        figure_description: string | null;
      }>;
      const targetScopeDecision = testCase.expectedDecision === "reject" && calls.terminal === 1 &&
        !resumingManualRevision
        ? "accept"
        : testCase.expectedDecision;
      return { text: JSON.stringify(inputs.map((input) => ({
        key: input.key,
        status: input.key !== targetKey || input.figure_description?.includes(testCase.finalAnchor)
          ? "exact"
          : "mismatch",
        evidence: input.key === targetKey && !input.figure_description?.includes(testCase.finalAnchor)
          ? "공식 source의 시각 세부가 누락됐다."
          : "공식 source pixels와 일치한다.",
        scopeDecision: input.key === targetKey ? targetScopeDecision : "reject",
        scopeConfidence: 0.99,
        scopeEvidence: input.key === targetKey && targetScopeDecision === "accept"
          ? "요청 교과 범위이다."
          : "요청 범위 밖이다.",
      }))) };
    }
    if (request.schema?.name === "studywork_exam_corpus_solution_fidelity") {
      calls.solution++;
      return { text: JSON.stringify([{
        key: targetKey,
        sourcePage: baseTargetSolution?.page ?? 1,
        answerStatus: "exact",
        explanationStatus: repairSolution && calls.solution === 1 ? "mismatch" : "exact",
        evidence: repairSolution && calls.solution === 1
          ? "공식 5쪽은 굳세게, 더 추워야겠다, 의성어, 카랑카랑인데 base 해설이 다르다."
          : "공식 답과 전체 해설이 일치한다.",
      }]) };
    }
    if (request.schema?.name === "studywork_solution_file_items") {
      calls.solutionRepair++;
      return { text: JSON.stringify([{
        number: String(targetNumber),
        answer: "③",
        explanation: Q43_CORRECTED_SOLUTION,
        page: 5,
        complete: true,
      }]) };
    }
    if (request.schema?.name === "studywork_exam_corpus_semantic_choice_check") {
      calls.semantic++;
      return { text: JSON.stringify([{
        key: targetKey,
        status: "resolved",
        choiceIndex: 3,
        evidence: "두 작품 모두 유사 시구를 변주해 주제 의식을 강조한다.",
      }]) };
    }
    throw new Error(`unexpected schema ${request.schema?.name}`);
  });

  if (failedManualClassification) {
    await expect(repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions))
      .rejects.toThrow("seeded manual revision crash");
    expect(calls).toMatchObject({
      extraction: 3,
      classification: 5,
      solution: 0,
      solutionRepair: 0,
      semantic: 0,
    });
    expect(calls.terminal).toBeGreaterThan(0);
    expect(readdirSync(join(root, "problem-manual-revisions"))).toHaveLength(1);
    expect(existsSync(join(root, "classification-manual-revisions"))).toBe(false);
    resumingManualRevision = true;
    Object.assign(calls, {
      extraction: 0,
      classification: 0,
      terminal: 0,
      solution: 0,
      solutionRepair: 0,
      semantic: 0,
    });
  }
  const result = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
  const repair = result.repairs.find((item) => item.key === targetKey)!;
  const manual = repair.revision!.recovery!.manualAdjudication!;
  expect(manual).toMatchObject({
    key: targetKey,
    cropEvidenceArtifact: { path: expect.stringMatching(/^problem-manual-evidence\/v1-/u) },
    cropEvidencePdf: { path: expect.stringMatching(/^problem-manual-evidence\/v1-/u) },
    problemArtifact: { path: expect.stringMatching(/^problem-manual-adjudications\/v1-/u) },
    classificationArtifact: { path: expect.stringMatching(/^classification-manual-adjudications\/v1-/u) },
  });
  if (failedManualClassification) {
    const revisionSpec = PROBLEM_MANUAL_REVISION_ALLOWLIST.find((candidate) =>
      candidate.entryId === entry.id && candidate.key === targetKey
    )!;
    expect(manual.revision).toMatchObject({
      allowlistId: revisionSpec.allowlistId,
      failedQuestionHash: revisionSpec.failedQuestionHash,
      failedClassificationHash: revisionSpec.failedClassificationHash,
      failedClassificationEvidenceHash: revisionSpec.failedClassificationEvidenceHash,
      problemArtifact: { path: expect.stringMatching(/^problem-manual-revisions\/v1-/u) },
      classificationArtifact: { path: expect.stringMatching(/^classification-manual-revisions\/v1-/u) },
    });
    expect(result.classified.find((item) => item.classification.key === targetKey)?.question.question)
      .toContain(manualRevisionAfterAnchor);
    expect(calls).toMatchObject({
      extraction: 0,
      classification: 1,
      terminal: 1,
      solution: testCase.expectedDecision === "accept" ? 1 : 0,
    });
    const terminalKeys = result.problemTerminalFidelityItems.map((item) => item.key);
    expect(terminalKeys).toHaveLength(testCase.questionCount);
    expect(new Set(terminalKeys).size).toBe(testCase.questionCount);
    expect(result.problemTerminalFidelityItems.find((item) => item.key === targetKey)).toMatchObject({
      status: "exact",
      scopeDecision: testCase.expectedDecision,
    });
    const persistedTerminalKeys = result.problemTerminalFidelityCheckpoints.flatMap((pointer) => {
      const checkpoint = JSON.parse(readFileSync(join(root, pointer.path), "utf8"));
      expect(checkpoint.inputs).toHaveLength(checkpoint.items.length);
      return checkpoint.items.map((item: { key: string }) => item.key) as string[];
    });
    expect(new Set(persistedTerminalKeys).size).toBe(testCase.questionCount);
  }
  expect(result.classified.find((item) => item.classification.key === targetKey)).toMatchObject({
    question: { figure_description: expect.stringContaining(testCase.finalAnchor) },
    classification: {
      decision: testCase.expectedDecision,
      transcription_status: "exact",
      ...("expectedCanonicalSubject" in testCase
        ? { canonical_subject: testCase.expectedCanonicalSubject }
        : {}),
    },
  });
  expect(result.problemTerminalFidelityItems.find((item) => item.key === targetKey)).toMatchObject({
    status: "exact",
    scopeDecision: testCase.expectedDecision,
  });
  expect(result.auditPath).toMatch(/^answer-audit\/v5-/u);
  if (repairSolution) {
    expect(calls.solution).toBe(2);
    expect(calls.solutionRepair).toBe(1);
    expect(calls.semantic).toBe(1);
    expect(result.solutionRepairs).toEqual([expect.objectContaining({
      key: targetKey,
      repairArtifact: expect.objectContaining({ path: expect.stringMatching(/^solution-repairs\/v1-/u) }),
      fidelityArtifact: expect.objectContaining({
        path: expect.stringMatching(/^solution-fidelity-repairs\/v1-/u),
      }),
    })]);
    expect(result.solutions.find((item) => Number(item.number) === targetNumber)?.explanation)
      .toBe(Q43_CORRECTED_SOLUTION);
    expect(result.solutionFidelityItems).toEqual([expect.objectContaining({
      key: targetKey,
      answerStatus: "exact",
      explanationStatus: "exact",
    })]);
    expect(result.effectiveSolutionCorpusHash).not.toBe(canonicalEvidenceHash([{
      key: targetKey,
      solution: baseTargetSolution,
    }]));
  }
  const cropCheckpoint = JSON.parse(readFileSync(join(root, manual.cropEvidenceArtifact.path), "utf8"));
  expect(cropCheckpoint.dpi).toBe("expectedDpi" in testCase ? testCase.expectedDpi : 300);

  const beforeReplay = { ...calls };
  const replay = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
  expect(calls).toEqual(beforeReplay);
  expect(replay.auditHash).toBe(result.auditHash);

  if (manual.revision) {
    const revisionClassificationPath = join(root, manual.revision.classificationArtifact.path);
    const revisionClassificationBytes = readFileSync(revisionClassificationPath);
    unlinkSync(revisionClassificationPath);
    const beforeRevisionResume = { ...calls };
    const revisionResumed = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
    expect(calls).toEqual({ ...beforeRevisionResume, classification: beforeRevisionResume.classification + 1 });
    expect(readFileSync(revisionClassificationPath)).toEqual(revisionClassificationBytes);
    expect(revisionResumed.auditHash).toBe(result.auditHash);

    const tamperedRevision = JSON.parse(revisionClassificationBytes.toString("utf8"));
    tamperedRevision.unexpected = true;
    writeJson(revisionClassificationPath, tamperedRevision);
    const beforeRevisionTamper = { ...calls };
    await expect(repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions))
      .rejects.toThrow(/classification manual revision|exact envelope|manual revision classification/u);
    expect(calls).toEqual(beforeRevisionTamper);
    writeFileSync(revisionClassificationPath, revisionClassificationBytes);

    const extraChildRepairs = structuredClone(result.repairs);
    const extraChild = extraChildRepairs.find((item) => item.key === targetKey)!
      .revision!.recovery!.manualAdjudication!.revision! as unknown as Record<string, unknown>;
    extraChild.revision = {
      problemArtifact: manual.revision.problemArtifact,
      classificationArtifact: manual.revision.classificationArtifact,
    };
    const beforeExtraChild = { ...calls };
    await expect(assertProblemManualAdjudicationAuthority(root, extraChildRepairs))
      .rejects.toThrow(/classification manual revision checkpoint/u);
    expect(calls).toEqual(beforeExtraChild);
  }

  const checkpointPath = join(root, manual.cropEvidenceArtifact.path);
  const checkpointBytes = readFileSync(checkpointPath);
  unlinkSync(checkpointPath);
  const beforeCrashReplay = { ...calls };
  const resumed = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
  expect(calls).toEqual(beforeCrashReplay);
  expect(readFileSync(checkpointPath)).toEqual(checkpointBytes);
  expect(resumed.auditHash).toBe(result.auditHash);

  const viewPath = join(root, manual.cropViews[0].artifact.path);
  const viewBytes = readFileSync(viewPath);
  writeFileSync(viewPath, Buffer.concat([viewBytes, Buffer.from("tampered")]));
  await expect(repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions))
    .rejects.toThrow(/crop evidence view file hash/u);
  expect(calls).toEqual(beforeCrashReplay);
  writeFileSync(viewPath, viewBytes);

  writeFileSync(join(root, "classification-manual-adjudications", "orphan.json"), "{}\n");
  await expect(repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions))
    .rejects.toThrow("manual adjudication orphan/conflict");
}

describe("exact allowlisted problem manual adjudication", () => {
  it.skipIf(!existsSync(join(q31Q32LiveState, "problem.pdf")))(
    "pins and applies the source-exact 5578421 Q31-Q32 pair",
    () => {
    const specs = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.filter((spec) =>
      spec.entryId === "ebsi:5578421" && ["12:31", "12:32"].includes(spec.key)
    );
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST).toHaveLength(91);
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 36)))
      .toBe("e260bb5cd9c24507cb1c434e19b03a63961ef07a29392b28fc49f6897040dd64");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 46)))
      .toBe("918b9267faab3d394cf64e5b9f02e9621024c5c6ad5d17d233fd8940fd1dac82");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST))
      .toBe("3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219");
    expect(specs.map((spec) => ({
      key: spec.key,
      rowHash: canonicalEvidenceHash(spec),
      replacementsHash: canonicalEvidenceHash(spec.replacements),
      parentRecoveryEvidenceHash: spec.parentRecoveryEvidenceHash,
      failedStatus: spec.failedStatus,
    }))).toEqual([{
      key: "12:31",
      rowHash: "b5c5cfd215a05bb6f55f88aff21fae146465e33056a42a8c7cfff831148a51ca",
      replacementsHash: "ff7c20d8564f20044eeac13207106bca16ea0964b1054f19fdd7aeaf8702ff22",
      parentRecoveryEvidenceHash: "31736e6fcf16af511a3264db1bb97303bffe4c391643659b0c503d745de7f2de",
      failedStatus: undefined,
    }, {
      key: "12:32",
      rowHash: "3aed2606c06fcdd6e45647693d4cb251196aa8b4653b8c6378fd8f9a480e336d",
      replacementsHash: "d41af9fce6387814e1e41c1af7ee2c9743f567d7d56eb7f2d8dd22c75b3ddc6d",
      parentRecoveryEvidenceHash: "0522267c8991e42758995b53ee672ced5c6d4ae97f83ea2c985f487bfcd6d464",
      failedStatus: "exact",
    }]);

    const q31 = q31Q32ExactRecoveryParent5578421(q31Q32LiveState, "31");
    const q32 = q31Q32ExactRecoveryParent5578421(q31Q32LiveState, "32");
    const corrected31 = applyAllowlistedProblemManualCorrection(
      "ebsi:5578421", specs[0].sourceHash, q31.failed.question
    );
    const corrected32 = applyAllowlistedProblemManualCorrection(
      "ebsi:5578421", specs[1].sourceHash, q32.failed.question
    );
    expect(canonicalEvidenceHash(corrected31))
      .toBe("784b252cb42674978f332dc741bbca77366b1f7c72f7b60b24c235086b855f1f");
    expect(canonicalEvidenceHash(corrected31.question))
      .toBe("20abf86d91abeb8cabd386c786bd2e652e7dd8732e8b070919eb09f9eab6a319");
    expect(canonicalEvidenceHash(corrected32))
      .toBe("ec5a2c62639228e94c405ce9f5624fe7bb88c16d3e6add611f559edea9a9a804");
    expect(canonicalEvidenceHash(corrected32.question))
      .toBe("71710e20da7a5f0d13db0449f2eea88fd3ee522510c9611afe9fa16a7447c558");
    expect(corrected31.question).toContain("단순 명제라 하여");
    expect(corrected31.question).toContain("<결론>인 $q$");
    expect(corrected31.question).not.toContain("입장에서 다음 <보기>");
    expect(corrected31.figure_description).toContain("가로선은 총 2개");
    expect(corrected32.question).toContain("전제들을 엮을 수 있도록");
    expect(corrected32.question).toContain("㉢ 명제 논리학");
    expect(corrected32.figure_description).toContain("⑤는 M-P/M-S/S-P");
    expect(corrected32.figure_description).toContain("가로선은 총 5개");
    expect(corrected31.choices).toEqual(q31.failed.question.choices);
    expect(corrected32.choices).toEqual(q32.failed.question.choices);
    expect(corrected31.answer).toBe(q31.failed.question.answer);
    expect(corrected32.answer).toBe(q32.failed.question.answer);
  });

  it.skipIf(!existsSync(join(q31Q32LiveState, "problem.pdf")))(
    "pins and applies the source-exact 5578421 Q33-Q34 pair",
    () => {
    const specs = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.filter((spec) =>
      spec.entryId === "ebsi:5578421" && ["12:33", "12:34"].includes(spec.key)
    );
    expect(specs).toHaveLength(2);
    expect(specs.map((spec) => ({
      rowHash: canonicalEvidenceHash(spec),
      replacementsHash: canonicalEvidenceHash(spec.replacements),
    }))).toEqual([{
      rowHash: "a744e96366190c657c16a10e17053c1aa098e9de01543fe2787ef7c989bb9427",
      replacementsHash: "e1b798db9879f472ca70baaeab924563811a518512f71b97baea40f598a16ff4",
    }, {
      rowHash: "a620f1b2e47c0554fd2bc0956aecc3ba26622a72ddf0a9006252bce5351e0f48",
      replacementsHash: "c5c2e15127480ffac4cfaf471441e2f316a3ae057f045df6ad3f2b95c0d65577",
    }]);
    const q33 = q33Q34ExactRecoveryParent5578421(q31Q32LiveState, "33");
    const q34 = q33Q34ExactRecoveryParent5578421(q31Q32LiveState, "34");
    const corrected33 = applyAllowlistedProblemManualCorrection(
      "ebsi:5578421", specs[0].sourceHash, q33.failed.question
    );
    const corrected34 = applyAllowlistedProblemManualCorrection(
      "ebsi:5578421", specs[1].sourceHash, q34.failed.question
    );
    expect(canonicalEvidenceHash(corrected33))
      .toBe("51c280a2726a0316148f5f9fea647a1f36f291d8623af351c485110810acf91e");
    expect(canonicalEvidenceHash(corrected33.question))
      .toBe("d30bacae21df5b21a5752a1d6d9a9555cebfecc7b1324bd694bd6e11cea1bc9a");
    expect(canonicalEvidenceHash(corrected34))
      .toBe("cd41ed6a20382fed6f21385228b1698369e81d0cb0e1c0744a0f1f77d3d479c8");
    expect(canonicalEvidenceHash(corrected34.question))
      .toBe("0846bb9134af1046402bb67e607122612901ab36ab70edf2323283b7e2814f96");
    expect(corrected33.question).toContain("㉡의 사례로 가장 적절한 것은?");
    expect(corrected33.question).toContain("<결론>인 $q$");
    expect(corrected33.figure_description).toContain("가로선은 총 2개");
    expect(corrected34.question).toContain("34. <보기>는 ㉢을 심화 학습");
    expect(corrected34.question).toContain("컴퓨터로 프로그래밍할 수 있는 길");
    expect(corrected34.figure_description).toContain("OR 게이트 회로도");
    expect(corrected34.figure_description).toContain("Y = A + B");
    expect(corrected33.choices).toEqual(q33.failed.question.choices);
    expect(corrected34.choices).toEqual(q34.failed.question.choices);
    expect(corrected33.answer).toBe(q33.failed.question.answer);
    expect(corrected34.answer).toBe(q34.failed.question.answer);
  });

  it.skipIf(!existsSync(join(q31Q32LiveState, "problem.pdf")))(
    "pins and applies the source-exact 5578421 Q6-Q7 pair",
    () => {
    const specs = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.filter((spec) =>
      spec.entryId === "ebsi:5578421" && ["3:6", "3:7"].includes(spec.key)
    );
    expect(specs).toHaveLength(2);
    expect(specs.map((spec) => ({
      rowHash: canonicalEvidenceHash(spec),
      replacementsHash: canonicalEvidenceHash(spec.replacements),
    }))).toEqual([{
      rowHash: "553ac1164ad9c803726bc8eac2de71df6f3daaf0dac74169b878b4374f4db017",
      replacementsHash: "dc47877af3ed7790c50c14285c3a01be3d6f5e31c55b75a7ec14230401a89eb3",
    }, {
      rowHash: "b0e796e5e23627f74f2b5d92c9e90e618abf5e7539b6b679775731d55874da7f",
      replacementsHash: "f63950eca6732a3eb1291a45f258f21b0b67cd690867442bdf809ec734ee03ef",
    }]);
    const q6 = q6Q7ExactRecoveryParent5578421(q31Q32LiveState, "6");
    const q7 = q6Q7ExactRecoveryParent5578421(q31Q32LiveState, "7");
    const corrected6 = applyAllowlistedProblemManualCorrection(
      "ebsi:5578421", specs[0].sourceHash, q6.failed.question
    );
    const corrected7 = applyAllowlistedProblemManualCorrection(
      "ebsi:5578421", specs[1].sourceHash, q7.failed.question
    );
    expect(canonicalEvidenceHash(corrected6))
      .toBe("7dca0fed5deedcf7178492f9206f994c596021551c0e9df67f968b87e6fb2307");
    expect(canonicalEvidenceHash(corrected6.question))
      .toBe("407ac679e07a78f20976daf095d749c5695a655d755aa51bf4c9373bf4bb3836");
    expect(canonicalEvidenceHash(corrected7))
      .toBe("1a3a885c810552a759f72ae2c1dc94210749bb3a8c3ca9cd72c6f7cc110273aa");
    expect(canonicalEvidenceHash(corrected7.question))
      .toBe("9fb8d23bc893fb6a36d2b88b459d3fabc8a7f4426442146d6a8603ed4b6524ae");
    expect(corrected6.question).toContain("봉우리들 너머 그 너머에 있는 한양 쪽");
    expect(corrected6.question).toContain("엄흥도 ㉣ 같다라고");
    expect(corrected6.question).not.toContain("환연하여");
    expect(corrected7.question).toContain("㉠ 마치게");
    expect(corrected7.question).toContain("고운 임 여의옵고");
    expect(corrected7.question).not.toContain("고운 님 여의옵고");
    expect(corrected6.choices).toEqual(q6.failed.question.choices);
    expect(corrected7.choices).toEqual(q7.failed.question.choices);
    expect(corrected6.answer).toBe(q6.failed.question.answer);
    expect(corrected7.answer).toBe(q7.failed.question.answer);
  });

  it.skipIf(!existsSync(join(q31Q32LiveState, "problem.pdf")))(
    "selects and replays pinned 5578421 manual generations among superseded recoveries",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-5578421-q6-q7-generations-"));
    cpSync(q31Q32LiveState, root, { recursive: true });
    const input = q27FixtureInputs(root);
    const q6 = q6Q7ExactRecoveryParent5578421(root, "6");
    const q7 = q6Q7ExactRecoveryParent5578421(root, "7");
    const shared = (["19", "20", "21"] as const).map((number) =>
      q19Q21ExactRecoveryParent5578421(root, number)
    );
    providerMock.complete.mockRejectedValue(new Error("unexpected manual generation replay provider"));
    const run = (row: ReturnType<typeof q6Q7ExactRecoveryParent5578421>) =>
      adjudicateProblemManual(input.entry, input.problem, root, row.failed, row.parent);

    const q6Result = await run(q6);
    const q7Result = await run(q7);
    for (const row of shared) await run(row);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(canonicalEvidenceHash(q6Result.classified.question))
      .toBe("7dca0fed5deedcf7178492f9206f994c596021551c0e9df67f968b87e6fb2307");
    expect(canonicalEvidenceHash(q7Result.classified.question))
      .toBe("1a3a885c810552a759f72ae2c1dc94210749bb3a8c3ca9cd72c6f7cc110273aa");
    const stable = stateSnapshot(root);
    await run(q6);
    await run(q7);
    for (const row of shared) await run(row);
    expect(stateSnapshot(root)).toEqual(stable);

    const selectedProblemPath = join(root, q6.parent.problemArtifact.path);
    writeFileSync(selectedProblemPath, Buffer.concat([
      readFileSync(selectedProblemPath),
      Buffer.from(" "),
    ]));
    const beforeTamper = stateSnapshot(root);
    await expect(run(q6)).rejects.toThrow(/hash|canonical|envelope/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(beforeTamper);
  }, 120_000);

  it.skipIf(!existsSync(join(q31Q32LiveState, "problem.pdf")))(
    "pins and applies the source-exact 5578421 Q19-Q21 shared passage",
    () => {
    const specs = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.filter((spec) =>
      spec.entryId === "ebsi:5578421" && ["8:19", "8:20", "8:21"].includes(spec.key)
    );
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 43)))
      .toBe("e7dfb4cb4e9985bfc3d3077b96baa9f1f7e2ff7f5b8dee6fb26b342d301b04fc");
    expect(specs.map((spec) => ({
      rowHash: canonicalEvidenceHash(spec),
      replacementsHash: canonicalEvidenceHash(spec.replacements),
    }))).toEqual([{
      rowHash: "43e3e986c08cbe180a0c82f0819e069579b44169bf52b997967172e4fa12b686",
      replacementsHash: "1ccf6153d57617ff2b299d674cc0c5c1d26584601242e53b473f80986f8e8a8d",
    }, {
      rowHash: "4afb635290ca5aa3233abc2c543c4a89cc0bc5d29faeb14a4ab6201da6fd9391",
      replacementsHash: "b3ef39251c4b771162400a3049af0e00d6495397bf51f9e594a74b8a54a330e1",
    }, {
      rowHash: "845d4e3b15dad5a08333fb92302cc46cb140a8f3d92a30b61e06d45b4841b502",
      replacementsHash: "8151710a3959e4acb075ade0db51e002e1783302e4df09119ea39db63a124f7f",
    }]);
    const rows = (["19", "20", "21"] as const).map((number) =>
      q19Q21ExactRecoveryParent5578421(q31Q32LiveState, number)
    );
    const corrected = rows.map((row, index) => applyAllowlistedProblemManualCorrection(
      "ebsi:5578421", specs[index].sourceHash, row.failed.question
    ));
    expect(corrected.map((item) => canonicalEvidenceHash(item))).toEqual([
      "fa1c211a6703f9e08448276644c1be94f41a2a05b8d8e59b34491fad6c795147",
      "f848a0ffa552671a10b588a0a1f936c6fbd12066030a1700bbbbe5b92a381929",
      "220a5aa0e7224674bdd471008ceba6e70474a8b3e81d7a6ed808dd757f6d9e82",
    ]);
    expect(corrected.map((item) => canonicalEvidenceHash(item.question))).toEqual([
      "bd552118a3b2aa90f9e747e742e460e4599e4824e26767a7b643aaab0e953e58",
      "136fb0930954306d07226a476e99f95da9d3c6010270f846bd680f00f4fbe640",
      "125ef097bdedaa0fb3bec8e4451c6e6f27d75bf646203a03ccc9e6d3d974783e",
    ]);
    const revisionSpecs = PROBLEM_MANUAL_REVISION_ALLOWLIST.filter((spec) =>
      spec.entryId === "ebsi:5578421" && ["8:19", "8:20", "8:21"].includes(spec.key)
    );
    expect(revisionSpecs.map((spec) => ({
      key: spec.key,
      rowHash: canonicalEvidenceHash(spec),
      failedStatus: spec.failedStatus,
    }))).toEqual([{
      key: "8:19",
      rowHash: "e27383cba8efdb66d85ac3e5c0c2632ec646182c54764039aff3687da458c2cc",
      failedStatus: "exact",
    }, {
      key: "8:20",
      rowHash: "647a2d54b19dc3e2b47e46f6b2905c84bd5f36d257b9378a78bedc229c6073c6",
      failedStatus: undefined,
    }, {
      key: "8:21",
      rowHash: "bb73db45feca8b695f6865792b5a86567bc0e6dda426bba14276c57867eb9cf4",
      failedStatus: "exact",
    }]);
    const revised = corrected.map((item, index) => applyAllowlistedProblemManualRevision(
      "ebsi:5578421", revisionSpecs[index].sourceHash, revisionSpecs[index].parentAllowlistId, item
    ));
    expect(revised.map((item) => canonicalEvidenceHash(item))).toEqual([
      "9e97c0a2578c2f7006e3a56dcb85c2cad3fdedc960e6eda520826c65fa673950",
      "644b9b2b70de017d86ea1eea7502809a6a803a8cf6f16a8910256c85b44afc82",
      "8ed4e485cb98c1c585106ad934abaa97a6b73871a3ad4b6dc721ffb605e58a11",
    ]);
    expect(revised.map((item) => canonicalEvidenceHash(item.question))).toEqual([
      "9f54a02bc5a2931327863797ce8be53d3c5d5e3901476d63590d691eba12b460",
      "20e6f8455eedb52eeade5b42b26f3d7656df02ba3c04c846eb097cf24e0ee7bb",
      "5b3cc64f98f9f88110406d8edc86eb005275ce45a84eb30d3bad2fe33a456419",
    ]);
    const q19Na = revised[0].question.slice(
      revised[0].question.indexOf("(나)"),
      revised[0].question.indexOf("\n\n(가), (나)의 공통점")
    );
    const q20Na = revised[1].question.slice(
      revised[1].question.indexOf("(나)"),
      revised[1].question.indexOf("\n\n시적 맥락을")
    );
    const q21Na = revised[2].question.split("\n\n<보기>")[0];
    expect(q19Na).toBe(q21Na);
    expect(q20Na).toBe(q21Na);
    expect(q21Na).toContain("곱새담*의 짚날을 뽑아 오고….");
    expect(q21Na).not.toContain("곱새담의 짚날을 뽑아 오고….");
    expect(revised[0].choices?.[1]).toContain("주체와 객체를 전도시켜");
    expect(revised[2].figure_description).toContain("왼쪽 ㉮ 상자");
    expect(revised[2].figure_description).toContain("오른쪽 ㉯ 상자");
  });

  it.skipIf(!existsSync(join(q31Q32LiveState, "problem.pdf")))(
    "writes and replays the 5578421 Q19-Q21 shared-passage revisions byte-stably",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-5578421-q19-q21-revision-"));
    cpSync(q31Q32LiveState, root, { recursive: true });
    removeManualRevisionArtifacts(root, ["8:19", "8:20", "8:21"]);
    const input = q27FixtureInputs(root);
    const rows = (["19", "20", "21"] as const).map((number) =>
      q19Q21ExactRecoveryParent5578421(root, number)
    );
    const calls: string[] = [];
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      expect(request.schema?.name).toBe("studywork_exam_corpus_classification");
      const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
        key: string;
        question: string;
      }>;
      expect(items).toHaveLength(1);
      const item = items[0];
      calls.push(item.key);
      expect(item.question).toContain("곱새담*의 짚날을 뽑아 오고….");
      expect(item.question).not.toContain("곱새담의 짚날을 뽑아 오고….");
      return { text: JSON.stringify([{
        key: item.key,
        decision: "accept",
        canonical_subject: "korean_literature",
        curriculum_course: "문학",
        domain: "현대시의 표현과 감상",
        achievement_codes: ["12문학01-03"],
        confidence: 0.99,
        reason_codes: ["SOURCE_EXACT", "IN_SCOPE_KOREAN_LITERATURE"],
        transcription_status: "exact",
        transcription_evidence: `공식 7~8쪽의 ${item.key} 공통 지문·각주·발문·선지가 일치한다.`,
      }]) };
    });
    const run = (row: ReturnType<typeof q19Q21ExactRecoveryParent5578421>) =>
      adjudicateProblemManual(input.entry, input.problem, root, row.failed, row.parent);
    const completed = [];
    for (const row of rows) completed.push(await run(row));
    expect(calls).toEqual(["8:19", "8:20", "8:21"]);
    expect(completed.map((item) => canonicalEvidenceHash(item.classified.question))).toEqual([
      "9e97c0a2578c2f7006e3a56dcb85c2cad3fdedc960e6eda520826c65fa673950",
      "644b9b2b70de017d86ea1eea7502809a6a803a8cf6f16a8910256c85b44afc82",
      "8ed4e485cb98c1c585106ad934abaa97a6b73871a3ad4b6dc721ffb605e58a11",
    ]);
    expect(completed.map((item) => item.evidence.revision?.allowlistId)).toEqual([
      "ebsi-5578421-q19-manual-revision-v1",
      "ebsi-5578421-q20-manual-revision-v1",
      "ebsi-5578421-q21-manual-revision-v1",
    ]);
    const stable = stateSnapshot(root);
    const beforeReplay = [...calls];
    for (const row of rows) await run(row);
    expect(calls).toEqual(beforeReplay);
    expect(stateSnapshot(root)).toEqual(stable);
  }, 180_000);

  it.skipIf(!existsSync(join(q43LiveState5577054, "problem.pdf")))(
    "pins the source-exact 5577054 Q3 shared-discussion sentence",
    () => {
      const spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q3-source-manual-v1"
      )!;
      const pinned = q3ExactRecoveryParent5577054(q43LiveState5577054);
      const corrected = applyAllowlistedProblemManualCorrection(
        spec.entryId,
        spec.sourceHash,
        pinned.failed.question,
      );
      expect({
        length: PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.length,
        allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST),
        rowHash: canonicalEvidenceHash(spec),
        replacementsHash: canonicalEvidenceHash(spec.replacements),
        failedQuestionHash: canonicalEvidenceHash(pinned.failed.question),
        failedClassificationHash: canonicalEvidenceHash(pinned.failed.classification),
        correctedHash: canonicalEvidenceHash(corrected),
        correctedQuestionHash: canonicalEvidenceHash(corrected.question),
      }).toEqual({
        length: 91,
        allowlistHash: "3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219",
        rowHash: "1b54e456a373449955afd6236b47e77ca58733e3248aaa3985692b8ffcec6ada",
        replacementsHash: "b6ae09e29f43d9e0fac4c89f0c703334e5a7c416e4177821c74de152f2564744",
        failedQuestionHash: "70f6e312bc064cdcdbe430e0117b1c03f94b65de74cae80db2fde06e1215419b",
        failedClassificationHash: "8a44d37526f35d0259978a0d848611f872c78f18c2d36cb0d66989093828e157",
        correctedHash: "0646d908d621e0c74e29b2ad254ffce537e1b099437b533a0d94cb978f054bbd",
        correctedQuestionHash: "ff61517b5fb1c1ce2de8665545164f2dc2e011800f54518b971eb46360e67950",
      });
      expect(corrected.question).toContain("전시도 관람도 불편합니다.");
      expect(corrected.question).not.toContain("전시도 제대로 못합니다.");
      expect(corrected.answer).toBe(pinned.failed.question.answer);
    },
  );

  it.skipIf(!existsSync(join(q43LiveState5577054, "problem.pdf")))(
    "pins the source-exact 5577054 Q6-Q8 shared writing passage",
    () => {
      const expected = {
        "6": {
          rowHash: "13f97d1579385c1004754beef89e8d1e764d4cfd2b8007b759c2cff54eb705a6",
          replacementsHash: "e42fa8790b2c2ba389d213b7bf6e972d36f354178dbe4c4667764109025f6ea9",
          correctedHash: "9b6b87c5c7d40b61b6abbbaee664eeb181ebd4073930c1518765a37d14191675",
          correctedQuestionHash: "296a431a90b3a3df88a0499a13bba47cd34911572f1047e3b0bae20a2544cef9",
        },
        "7": {
          rowHash: "0750a743b56769bfc44af68a4fc18fc1b218dcac6610767aa3b29d761fb68d9e",
          replacementsHash: "a6b83b3e5989e97b5a70e27b10d605255f773e18acadc9ad1573efb533db7022",
          correctedHash: "64ee1feef76b3da3ecedc74f5d814b59040318559ae29530bbe90b766d959881",
          correctedQuestionHash: "ddf4c7013fde878c6f6ad0a69ef2e86f605b8c769a0ed3524a06448243ec3351",
        },
        "8": {
          rowHash: "9841f792a43f946a62b2019f6902e6350a068a2b8ccd7412b18246bac8bca3e8",
          replacementsHash: "768def5d1d8440c3aa22416031a0ec759b91ca2256a14351fa3c717e3d0c492c",
          correctedHash: "d3b2f249ee50b581773db1e71f9c9ae40c827cb99e005936a87a0b8b7c572e4c",
          correctedQuestionHash: "ee5b31d8cdf2be82afb3323f0fed08cda3529b6539b1a8a862ee028f931cc7d0",
        },
      } as const;
      for (const number of ["6", "7", "8"] as const) {
        const spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
          candidate.allowlistId === `ebsi-5577054-q${number}-source-manual-v1`
        )!;
        const pinned = q6Q8ExactRecoveryParent5577054(q43LiveState5577054, number);
        const corrected = applyAllowlistedProblemManualCorrection(
          spec.entryId,
          spec.sourceHash,
          pinned.failed.question,
        );
        expect({
          rowHash: canonicalEvidenceHash(spec),
          replacementsHash: canonicalEvidenceHash(spec.replacements),
          correctedHash: canonicalEvidenceHash(corrected),
          correctedQuestionHash: canonicalEvidenceHash(corrected.question),
        }).toEqual(expected[number]);
        expect(corrected.question).toContain("전자 상거래에서 인한 피해를 입지 않도록");
        expect(corrected.question).not.toContain("…… ㉥");
        if (number === "6") {
          expect(corrected.question).toContain("노력에 동참할 것을 촉구해야겠어. …… ㉮");
        } else {
          expect(corrected.question).toContain("○ ㉮ 청소년의 전자 상거래 피해를 예방하기 위한 노력에");
          expect(corrected.question).toContain("\n\n[B]\n\n");
        }
        expect(corrected.answer).toBe(pinned.failed.question.answer);
      }
      const q6Spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q6-source-manual-v1"
      )!;
      const q6Revision = PROBLEM_MANUAL_REVISION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q6-source-manual-revision-v1"
      )!;
      const q6Base = applyAllowlistedProblemManualCorrection(
        q6Spec.entryId,
        q6Spec.sourceHash,
        q6Q8ExactRecoveryParent5577054(q43LiveState5577054, "6").failed.question,
      );
      const q6Final = applyAllowlistedProblemManualRevision(
        q6Spec.entryId,
        q6Spec.sourceHash,
        q6Spec.allowlistId,
        q6Base,
      );
      expect({
        rowHash: canonicalEvidenceHash(q6Revision),
        replacementHash: canonicalEvidenceHash(q6Revision.replacement),
        additionalHash: canonicalEvidenceHash(q6Revision.additionalReplacements),
        itemHash: canonicalEvidenceHash(q6Final),
        questionHash: canonicalEvidenceHash(q6Final.question),
      }).toEqual({
        rowHash: "a55c9037a8ae925b2f256d54831cd42444b031634c9a81f118cf10cc357582d4",
        replacementHash: "cffdbd153f445b258f8470f5a741c47a2d2858252908d2a21498bf4d7ed850b8",
        additionalHash: "221c46ffa1a97709230bdd5197be365274b073312e213cccef3593c40faca118",
        itemHash: "901149d1d5ff4f38dd20721f052deaaf0394b59f8b39ee059bba2c20d31b891c",
        questionHash: "e07cb36c96f2da8b28865626c48b187534340d8d5b090af294edfb0f29d7fea8",
      });
      expect(q6Final.question).toContain("○ ㉮ 청소년의 전자 상거래 피해를 예방하기 위한 노력에");
      expect(q6Final.question).toContain("\n\n[B]\n\n㉠~㉤ 중");
      const q7Spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q7-source-manual-v1"
      )!;
      const q7Revision = PROBLEM_MANUAL_REVISION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q7-source-manual-revision-v1"
      )!;
      const q7Base = applyAllowlistedProblemManualCorrection(
        q7Spec.entryId,
        q7Spec.sourceHash,
        q6Q8ExactRecoveryParent5577054(q43LiveState5577054, "7").failed.question,
      );
      const q7Final = applyAllowlistedProblemManualRevision(
        q7Spec.entryId,
        q7Spec.sourceHash,
        q7Spec.allowlistId,
        q7Base,
      );
      expect({
        rowHash: canonicalEvidenceHash(q7Revision),
        replacementHash: canonicalEvidenceHash(q7Revision.replacement),
        itemHash: canonicalEvidenceHash(q7Final),
        questionHash: canonicalEvidenceHash(q7Final.question),
      }).toEqual({
        rowHash: "c54424027fa8bcfb903ae2d3b8b5b134eee1b0d942bfb19a038348f78d395444",
        replacementHash: "becea9678d33e79b602ed0a19bb2643fb50de70ebe2b45e2d02159f1f841de87",
        itemHash: "171bfc0b71b0c01d49e6451373cab52133ecf74c87fef6bbaf88f4f311466e52",
        questionHash: "ddf4c7013fde878c6f6ad0a69ef2e86f605b8c769a0ed3524a06448243ec3351",
      });
      expect(q7Final.choices).toContain(
        "④ 전자 상거래로 피해를 입은 청소년에게 일어날 수 있는 2차 피해의 위험성을 뒷받침한다.",
      );
      const q8 = applyAllowlistedProblemManualCorrection(
        "ebsi:5577054",
        "d7664675fc1e39cc99f507d6cc7bf7c4a1404106d140d9a2f904726ddec4c062",
        q6Q8ExactRecoveryParent5577054(q43LiveState5577054, "8").failed.question,
      );
      expect(q8.question).toContain("전망을 바탕으로 ㉮에 관한 내용을");
    },
  );

  it.skipIf(!existsSync(join(q43LiveState5577054, "problem.pdf")))(
    "pins the source-exact 5577054 Q14-Q15 Middle Korean passage and Q14 table",
    () => {
      const spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q14-source-manual-v1"
      )!;
      const pinned = q14ExactRecoveryParent5577054(q43LiveState5577054);
      const corrected = applyAllowlistedProblemManualCorrection(
        spec.entryId,
        spec.sourceHash,
        pinned.failed.question,
      );
      expect({
        rowHash: canonicalEvidenceHash(spec),
        replacementsHash: canonicalEvidenceHash(spec.replacements),
        itemHash: canonicalEvidenceHash(corrected),
        questionHash: canonicalEvidenceHash(corrected.question),
        choicesHash: canonicalEvidenceHash(corrected.choices),
        figureDescriptionHash: canonicalEvidenceHash(corrected.figure_description),
      }).toEqual({
        rowHash: "d5e952f9e4c233fa76e561172e2196eac8a470fb2e5a50b3834984c7e1c4a052",
        replacementsHash: "8134eac4461cc9559fc304cae6a99cc8499df41be8b42730ec1ca386f147f126",
        itemHash: "fc2ab0389e5d4d85b43c91156e4fa5731a93bda907dc307337412cd85588f2af",
        questionHash: "624815aa3c3869ad3ef8feaf29583da8d75d88322b0cd9e49844308b599fb54f",
        choicesHash: "8ad4e37d9fe1c5d35fef561e705fd14e74809c363c7e44deccdb0d70fe0a521d",
        figureDescriptionHash: "503cefc6629bc8edcce99771c3fae015c394c4a204b023b99bbb179cae47d066",
      });
      expect(corrected.choices).toEqual(expect.arrayContaining([
        "③ 오- | 와 | 깨우- | 깨워",
        "④ - |  | 쓰- | 써",
        "⑤ - | 야 | 가득하- | 가득하여",
      ]));
      expect(corrected.figure).toBe(true);
      expect(corrected.figure_description).toContain("‘15세기 국어’와 ‘현대 국어’");
      expect(corrected.answer).toBe(pinned.failed.question.answer);

      const revisionSpec = PROBLEM_MANUAL_REVISION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q14-source-manual-revision-v1"
      )!;
      expect({
        length: PROBLEM_MANUAL_REVISION_ALLOWLIST.length,
        allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_REVISION_ALLOWLIST),
        rowHash: canonicalEvidenceHash(revisionSpec),
        replacementHash: canonicalEvidenceHash(revisionSpec.replacement),
        additionalHash: canonicalEvidenceHash(revisionSpec.additionalReplacements),
      }).toEqual({
        length: 29,
        allowlistHash: "d7d33cb415ed9fa39323c9acefc41e7c691875f17be9f6de87acbb574bfd2b15",
        rowHash: "7b7dbe45a753d2e8aae1e7fddb9e8ce0bb4dd96e79cf210fce3d3550a9ac7cd2",
        replacementHash: "5e627b7633c21384183415ec6d246fffbf189609d390fc9d76b4b0e9941ee77d",
        additionalHash: "e5ef4d03608dd89fb187f0d23b5eca63e6b1be4e0d09e7074c24cc9429efb3d0",
      });
      const revised = applyAllowlistedProblemManualRevision(
        spec.entryId,
        spec.sourceHash,
        spec.allowlistId,
        corrected,
      );
      expect(canonicalEvidenceHash(revised))
        .toBe("66d6d5c38a434816c4f4ce2fc114aa97041eed4b3c73a577f4ce8066c6a41baa");
      expect(canonicalEvidenceHash(revised.question))
        .toBe("ac7435a681711931e6ca4597c49dc352b414a02fc0f87e8a1785cb2f4f9a3b0e");
      expect(revised.question).toContain("‘ㅏ, ㅗ, ㆍ’ 등의 양성 모음");
      expect(revised.question).not.toContain("‘ㆍ, ㅏ, ㅗ’ 등의 양성 모음");
      expect(revised.answer).toBe("⑤ - | 야 | 가득하- | 가득하여");

      const sourceRevisionSpec = PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q14-source-manual-source-revision-v1"
      )!;
      const q15Spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q15-source-manual-v1"
      )!;
      expect({
        manualLength: PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.length,
        manualHash: canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST),
        legacy89Hash: canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 89)),
        q15Row: canonicalEvidenceHash(q15Spec),
        q15Replacements: canonicalEvidenceHash(q15Spec.replacements),
        sourceLength: PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST.length,
        sourceHash: canonicalEvidenceHash(PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST),
        q14SourceRow: canonicalEvidenceHash(sourceRevisionSpec),
        q14SourceReplacement: canonicalEvidenceHash(sourceRevisionSpec.replacement),
        q14SourceAdditional: canonicalEvidenceHash(sourceRevisionSpec.additionalReplacements),
      }).toEqual({
        manualLength: 91,
        manualHash: "3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219",
        legacy89Hash: "e0628fe3c37a10a29cb17a907fc52035dfe9c0fbb89a5a5cbcb42993553feb5c",
        q15Row: "60d5ab979e53806a005b1527cdf2f4f9fab0e1ed0673143fa4f1fa7559465bc9",
        q15Replacements: "bbb300c26a781a9e45df44e1035d3bac6cfc4c8392ffafb620d81d2ebb4e60b5",
        sourceLength: 20,
        sourceHash: "b8819b943244e1b3e6aaf2a8c48fb8509ee8df8c4b76cd7efa799cd5caef59ac",
        q14SourceRow: "c9abb604d3125e197f4978f25d26de661cd535af6d956eab796c45912ca7d056",
        q14SourceReplacement: "8582782860d2b84c5dd0ec6a20f80ce6f5ac8811a73016c00d75462b37aec590",
        q14SourceAdditional: "0a2a05b13260516ad39a26d19276fc14e4bc7d551b2e42494360068842e379b4",
      });
      const sourceRevisedQ14 = applyAllowlistedProblemManualSourceRevision(
        spec.entryId,
        sourceRevisionSpec.sourceHash,
        sourceRevisionSpec.parentRevisionAllowlistId,
        revised,
      );
      const q15Base = JSON.parse(readFileSync(join(
        q43LiveState5577054,
        "problem-recoveries/v1-0005-0015-b1b1ee318c405339911031de401e48dd7b4020a62acb4204637c806278459065.json",
      ), "utf8")).item as QuizItemEx;
      const q15 = applyAllowlistedProblemManualCorrection(q15Spec.entryId, q15Spec.sourceHash, q15Base);
      expect(canonicalEvidenceHash(sourceRevisedQ14))
        .toBe("42979436282ed2cddd374653e0da8fd91a677e2ac8aa9f91799985fe2f491f32");
      expect(canonicalEvidenceHash(q15))
        .toBe("b383d5d2049c69d965877aebebae232ef93453e0b6edcdaf40add8f5208aca80");
      const q14Passage = sourceRevisedQ14.question.split("\n\n14. ")[0];
      const q15Passage = q15.question.split("\n\n15. ")[0];
      expect(q14Passage).toBe(q15Passage);
      expect(canonicalEvidenceHash(q14Passage))
        .toBe("74fc9d142f69b7462a75cb0bc8860273193a4089734dbb84ec949c0fc81784e1");
      expect(q14Passage).toContain("[14 ~ 15] 다음을 읽고 물음에 답하시오.");
      expect(q14Passage).toContain("‘/을, /를’");
      expect(q14Passage).toContain("‘사’과 같은 단어들은 ‘사슴’과 같이");
      expect(q14Passage).toContain("‘촐랑촐랑’, ‘출렁출렁’과 같은 음성 상징어에서나 ㉡일부");
    },
  );

  it.skipIf(!existsSync(join(q43LiveState5577054, "problem.pdf")))(
    "pins the source-exact 5577054 Q30-Q32 shared novel passage",
    () => {
      const keys = ["11:30", "11:31", "11:32"] as const;
      const specs = keys.map((key) => PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
        candidate.entryId === "ebsi:5577054" && candidate.key === key
      )!);
      expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST).toHaveLength(91);
      expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST))
        .toBe("3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219");
      expect(specs.map((spec) => ({
        key: spec.key,
        row: canonicalEvidenceHash(spec),
        replacements: canonicalEvidenceHash(spec.replacements),
        failedStatus: spec.failedStatus ?? "mismatch",
      }))).toEqual([{
        key: "11:30",
        row: "dd8ab55c7e6c79f32213dd114ec0dd9d064b674e65ee43ba1335d0ddae5dd5fd",
        replacements: "e68c5b4760158b84e754fb452b43f79e39bc79a164a29d3d9e6f1a2c8835f244",
        failedStatus: "exact",
      }, {
        key: "11:31",
        row: "eec39e3225e1bcb9d9d1a175233325dc9a1a2b366ecf21e27e6f86cb2816b4ab",
        replacements: "88ca98408e477793cefe5ca801596fdb4282484686e4cf7885fbf96fe28199ba",
        failedStatus: "mismatch",
      }, {
        key: "11:32",
        row: "01693f5fc4fdf83405645eb412f9c560891732bd31081b2aa734aac13671883f",
        replacements: "e88331fbefcd0801465a3f0092e087870817b3acf36fa1e3afa2a50f25e0ecc4",
        failedStatus: "exact",
      }]);
      const corrected = keys.map((key, index) => applyAllowlistedProblemManualCorrection(
        "ebsi:5577054",
        specs[index].sourceHash,
        q30Q32ExactRecoveryParent5577054(q43LiveState5577054, key.slice(3) as "30" | "31" | "32")
          .failed.question,
      ));
      expect(corrected.map(canonicalEvidenceHash)).toEqual([
        "37fafb1776ef07b87dc4e2213137b20e8f2b20998b34d17fcbe57478f690636c",
        "d10471aa0f091ed92fde27778e24ada33c790b6b4db3b79256024cf55412400c",
        "b8ab633404e308d73e78f8168cc012bb2cc978c1232a41b7f46c3a86c67b0893",
      ]);
      expect(corrected.map((item) => canonicalEvidenceHash(item.question))).toEqual([
        "92a0f6f44b49254dc1ba50105a5f9df9c3b82f0c945538115d7735fd635402ad",
        "00c7314311bbc81cac563bd5993a0e839d755cab6899ea5efb7c57e7d64b410f",
        "a422e5734c5c788b89194ff2fa68bcba182009a88b7ce31281f9b3b22f3ceeff",
      ]);
      const q30RevisionSpec = PROBLEM_MANUAL_REVISION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q30-source-manual-revision-v1"
      )!;
      const q31RevisionSpec = PROBLEM_MANUAL_REVISION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q31-source-manual-revision-v1"
      )!;
      expect({
        length: PROBLEM_MANUAL_REVISION_ALLOWLIST.length,
        allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_REVISION_ALLOWLIST),
        rowHash: canonicalEvidenceHash(q31RevisionSpec),
        replacementHash: canonicalEvidenceHash(q31RevisionSpec.replacement),
      }).toEqual({
        length: 29,
        allowlistHash: "d7d33cb415ed9fa39323c9acefc41e7c691875f17be9f6de87acbb574bfd2b15",
        rowHash: "fda72d385b6eeef713b30efea6e85ba239c6fafcf42c78ea7a5a7a2a5ae6b343",
        replacementHash: "316b051077c2bd50690302aac4b5d2ecae3e59589fb69cd918df0298628bfa0d",
      });
      expect(canonicalEvidenceHash(q30RevisionSpec))
        .toBe("07d610439ee7a06a454273d97ac0cdf31351e22a0178e357557ef40dfb12156c");
      const revisedQ30 = applyAllowlistedProblemManualRevision(
        "ebsi:5577054",
        q30RevisionSpec.sourceHash,
        q30RevisionSpec.parentAllowlistId,
        corrected[0],
      );
      const revisedQ31 = applyAllowlistedProblemManualRevision(
        "ebsi:5577054",
        q31RevisionSpec.sourceHash,
        q31RevisionSpec.parentAllowlistId,
        corrected[1],
      );
      expect({
        itemHash: canonicalEvidenceHash(revisedQ31),
        questionHash: canonicalEvidenceHash(revisedQ31.question),
        choicesHash: canonicalEvidenceHash(revisedQ31.choices),
      }).toEqual({
        itemHash: "9d21cdbb5f23d65a61e194d24b03990bad21bf2bc09ce5f8a8fe4bbd33661cf6",
        questionHash: "00c7314311bbc81cac563bd5993a0e839d755cab6899ea5efb7c57e7d64b410f",
        choicesHash: "5e548b48f76fb6fbcdcfad3038318f27f7334e1db9318c7e70ff0296a60ec4d2",
      });
      expect(corrected[1].choices).toContain(
        "① ‘문의 유리의 하단부가 깨어진 것’은 ‘나’를 억압하는 요인이 폭력적 속성을 지녔음을 상징적으로 나타낸다고 볼 수 있어."
      );
      expect(revisedQ31.choices).toContain(
        "① ‘문의 유리의 하반부가 깨어진 것’은 ‘나’를 억압하는 요인이 폭력적 속성을 지녔음을 상징적으로 나타낸다고 볼 수 있어."
      );
      const q31SourceRevisionSpec = PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q31-source-manual-source-revision-v1"
      )!;
      expect({
        length: PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST.length,
        allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST),
        rowHash: canonicalEvidenceHash(q31SourceRevisionSpec),
      }).toEqual({
        length: 20,
        allowlistHash: "b8819b943244e1b3e6aaf2a8c48fb8509ee8df8c4b76cd7efa799cd5caef59ac",
        rowHash: "6181b64d1c6ac19c229b8d09c0b3b401e6f90d7714e36bf92a2a86e154c5c931",
      });
      const sourceRevisedQ31 = applyAllowlistedProblemManualSourceRevision(
        "ebsi:5577054",
        q31SourceRevisionSpec.sourceHash,
        q31SourceRevisionSpec.parentRevisionAllowlistId,
        revisedQ31,
      );
      expect({
        q30: canonicalEvidenceHash(revisedQ30),
        q31: canonicalEvidenceHash(sourceRevisedQ31),
        q32: canonicalEvidenceHash(corrected[2]),
      }).toEqual({
        q30: "3448ab13a4b132b05fdebb3aee35b6f9482245b0d274fb0d77d69c3dac5366c5",
        q31: "751cde127873ce3ce2fffb04d8eac6e4c51b776198abb6b4f9cf355e5aa16121",
        q32: "b8ab633404e308d73e78f8168cc012bb2cc978c1232a41b7f46c3a86c67b0893",
      });
      const finalItems = [revisedQ30, sourceRevisedQ31, corrected[2]];
      const normalizedPassages = finalItems.map((item) => {
        const start = item.question.indexOf("<앞부분의 줄거리>");
        const title = "- 최윤, ｢회색 눈사람｣ -";
        const end = item.question.indexOf(title, start) + title.length;
        return item.question.slice(start, end).replace(/\s+/gu, "");
      });
      expect(new Set(normalizedPassages).size).toBe(1);
      for (const item of finalItems) {
        expect(item.question).toContain("문의 유리의 하반부가 깨어진 것이");
        expect(item.question).toContain("강하원이지. 순순히 나를 따라와.");
        expect(item.question).toContain("그러나 설령 수소문을 할 건더지가");
        expect(item.question).toContain("- 최윤, ｢회색 눈사람｣ -");
        expect(item.question).not.toMatch(/하단부|장하(?:원|영)|수순히|어쨌든|건덕지/u);
      }
    },
  );

  it.skipIf(!existsSync(join(q43LiveState5577054, "problem.pdf")))(
    "pins the source-exact 5577054 Q24-Q29 shared-passage correction chain",
    () => {
    const q24Spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q24-source-manual-v1"
    )!;
    const q24RevisionSpec = PROBLEM_MANUAL_REVISION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q24-source-manual-revision-v1"
    )!;
    const q24SourceSpec = PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q24-source-manual-source-revision-v1"
    )!;
    const q25Spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q25-manual-v1"
    )!;
    const q25RevisionSpec = PROBLEM_MANUAL_REVISION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q25-manual-revision-v1"
    )!;
    const q25SourceSpec = PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q25-manual-source-revision-v1"
    )!;
    const q26Spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q26-manual-v1"
    )!;
    const q26RevisionSpec = PROBLEM_MANUAL_REVISION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q26-manual-revision-v1"
    )!;
    const q26SourceSpec = PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q26-manual-source-revision-v1"
    )!;
    const q27Spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q27-source-manual-v1"
    )!;
    const q28Spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q28-source-manual-v1"
    )!;
    const q29Spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q29-source-manual-v1"
    )!;

    expect({
      q24Row: canonicalEvidenceHash(q24Spec),
      q24Replacements: canonicalEvidenceHash(q24Spec.replacements),
      q24Figure: canonicalEvidenceHash(q24Spec.figureDescription),
      q24RevisionRow: canonicalEvidenceHash(q24RevisionSpec),
      q24RevisionReplacement: canonicalEvidenceHash(q24RevisionSpec.replacement),
      q24SourceRow: canonicalEvidenceHash(q24SourceSpec),
      q24SourceReplacements: canonicalEvidenceHash([
        q24SourceSpec.replacement,
        ...(q24SourceSpec.additionalReplacements ?? []),
      ]),
      q25SourceRow: canonicalEvidenceHash(q25SourceSpec),
      q25SourceReplacements: canonicalEvidenceHash([
        q25SourceSpec.replacement,
        ...(q25SourceSpec.additionalReplacements ?? []),
      ]),
      q26RevisionRow: canonicalEvidenceHash(q26RevisionSpec),
      q26RevisionReplacement: canonicalEvidenceHash(q26RevisionSpec.replacement),
      q26SourceRow: canonicalEvidenceHash(q26SourceSpec),
      q26SourceReplacements: canonicalEvidenceHash([
        q26SourceSpec.replacement,
        ...(q26SourceSpec.additionalReplacements ?? []),
      ]),
      q27Row: canonicalEvidenceHash(q27Spec),
      q27Replacements: canonicalEvidenceHash(q27Spec.replacements),
      q28Row: canonicalEvidenceHash(q28Spec),
      q28Replacements: canonicalEvidenceHash(q28Spec.replacements),
      q29Row: canonicalEvidenceHash(q29Spec),
      q29Replacements: canonicalEvidenceHash(q29Spec.replacements),
    }).toEqual({
      q24Row: "180ee4b005c3a736d6ab2f228da8faa4ffb934684d68b8c024128448b66eaec1",
      q24Replacements: "c2b4723d6bb2937f8bd81ac855bbbc2290899f5dcfe343d582c35e7599b20bf2",
      q24Figure: "2615fd37f63a6af11fc3fc1d91500cb9c3c9d7cc2d2d294e46e2eb2dd99de89a",
      q24RevisionRow: "8b60b677474f2460b70fb8441d45c8727ce1cb3a42ea22519d86a469042ed685",
      q24RevisionReplacement: "a8ee5b0a002d836b05055f87ec6b7a3f92a2242b13e8408655e57ef49b34259a",
      q24SourceRow: "4e92cf767ddfc201646f04d3b24a494f1005745cad0261a565cd3e33d3f3b091",
      q24SourceReplacements: "d9d8100e1ed02f8fd5375497542d08eb5df7bae525a1c67488d7133654be528a",
      q25SourceRow: "fb0e07e1a2d61a37d88b80c7c77711cbadca4ce683f00860f59cd9c0df1f1ad4",
      q25SourceReplacements: "5cb4aeaae93786447099db0227c8b1ee2f60b4a7fdb2f31bbc4efcbb9febe5d5",
      q26RevisionRow: "5648333450aefbc92992ab60dd6bd722ccdb95a914aac4d6f290a704b0a8d821",
      q26RevisionReplacement: "9a54abe1ea0340aa6598b4d5f22eac06992606f403350d9eee807188ac2704c4",
      q26SourceRow: "bb119e25661bf68d086a708a69041e897a53b4491867f0b75fb436783c4ec358",
      q26SourceReplacements: "d828146ad5a1fb8a428f72fa5b27602c87377cc1275af2876121f6c8b380063e",
      q27Row: "ff2b50199149166d3e8075380d89ce6ab83ffec6c0908041b5f4aefee06618e4",
      q27Replacements: "63e9af0c4b0009f94c39433515c967c6489d6da84021402399902927867657a0",
      q28Row: "b36ca29de2153a574e535e9ad18e684b855708911d2c3efcff83e8e94b089630",
      q28Replacements: "bf29fb2350b7c042fcf60f49594e4e5e7ed03e013ae3913c19a27c73fe4fbace",
      q29Row: "21c332554fb5b6e9c66dbd50ae252e029bf0803c1f6c8117afc08371754559af",
      q29Replacements: "b99127c976ae239d4e18a0ca00728ee77ae1ed26539cbf8b2cfc657c9bb8f86b",
    });

    const q24Base = applyAllowlistedProblemManualCorrection(
      q24Spec.entryId,
      q24Spec.sourceHash,
      q24ExactRecoveryParent5577054(q43LiveState5577054).failed.question,
    );
    const q24Revision = applyAllowlistedProblemManualRevision(
      q24Spec.entryId,
      q24Spec.sourceHash,
      q24Spec.allowlistId,
      q24Base,
    );
    const q24 = applyAllowlistedProblemManualSourceRevision(
      q24Spec.entryId,
      q24Spec.sourceHash,
      q24RevisionSpec.allowlistId,
      q24Revision,
    );
    const q25Base = applyAllowlistedProblemManualCorrection(
      q25Spec.entryId,
      q25Spec.sourceHash,
      q25ExactRecoveryParent5577054(q43LiveState5577054).failed.question,
    );
    const q25Revision = applyAllowlistedProblemManualRevision(
      q25Spec.entryId,
      q25Spec.sourceHash,
      q25Spec.allowlistId,
      q25Base,
    );
    const q25 = applyAllowlistedProblemManualSourceRevision(
      q25Spec.entryId,
      q25Spec.sourceHash,
      q25RevisionSpec.allowlistId,
      q25Revision,
    );
    const q26Base = applyAllowlistedProblemManualCorrection(
      q26Spec.entryId,
      q26Spec.sourceHash,
      q26ExactRecoveryParent5577054(q43LiveState5577054).failed.question,
    );
    const q26Revision = applyAllowlistedProblemManualRevision(
      q26Spec.entryId,
      q26Spec.sourceHash,
      q26Spec.allowlistId,
      q26Base,
    );
    const q26 = applyAllowlistedProblemManualSourceRevision(
      q26Spec.entryId,
      q26Spec.sourceHash,
      q26RevisionSpec.allowlistId,
      q26Revision,
    );
    const q27 = applyAllowlistedProblemManualCorrection(
      q27Spec.entryId,
      q27Spec.sourceHash,
      q27ExactRecoveryParent5577054(q43LiveState5577054).failed.question,
    );
    const q28 = applyAllowlistedProblemManualCorrection(
      q28Spec.entryId,
      q28Spec.sourceHash,
      q28ExactRecoveryParent5577054(q43LiveState5577054).failed.question,
    );
    const q29 = applyAllowlistedProblemManualCorrection(
      q29Spec.entryId,
      q29Spec.sourceHash,
      q29ExactRecoveryParent5577054(q43LiveState5577054).failed.question,
    );
    const passage = (item: QuizItemEx, number: number) =>
      item.question.slice(0, item.question.indexOf(`\n\n${number}. `));

    expect(canonicalEvidenceHash(q24))
      .toBe("83880f36070efe78a6f8681d0113ba4e17a83556243d32e944ae0e4d5c19974c");
    expect(canonicalEvidenceHash(q24.question))
      .toBe("77a271770f9980d56b81ab40a0be87449686273e79760e8294722354d71ab681");
    expect(canonicalEvidenceHash(q25))
      .toBe("30924a493e07c2777c3f67c8c2d37fff36321f5db6b6c237065ab32513776555");
    expect(canonicalEvidenceHash(q25.question))
      .toBe("c1731cf279223038509d31d4223ffcd3a541ae845892b83b13282ffc475ebbd8");
    expect(canonicalEvidenceHash(q26))
      .toBe("69dda935cec74930e78ea7ee52f2b5d538af1d72f3ee1f95ccec7cf15ed62066");
    expect(canonicalEvidenceHash(q26.question))
      .toBe("76d9119d81dff13eceda1a1dd164b35141268e2838b3802ebdb15586aea26aa1");
    expect(canonicalEvidenceHash(q26.figure_description))
      .toBe("d414c52ec3011602182bb687860e33d3084827b1bb0667b2aa3aca06f4c02c26");
    expect(canonicalEvidenceHash(q27))
      .toBe("133d2548d0b49a7d64a617ca827a31daa0f7bc866ef08a606b46b4b2b1e76ff8");
    expect(canonicalEvidenceHash(q27.question))
      .toBe("18ec795827b298b7e08596bfb2a7fc6d4798a319a7b44e1309de37b1e8439702");
    expect(canonicalEvidenceHash(q28))
      .toBe("1246a2a833daeea63269e46f805fc68be67e89ba36b3a221162a87ad07e48500");
    expect(canonicalEvidenceHash(q28.question))
      .toBe("06b35b49618b0bfb864506613b1db09579f08fb4640a02ef6ffb34f879cc0c2f");
    expect(canonicalEvidenceHash(q28.figure_description))
      .toBe("2e01adc43089d040cd927ed2c14c5191fd94661c0721d0de5e608f816fdf4a02");
    expect(canonicalEvidenceHash(q29))
      .toBe("60ce4f45023e3da24b9f2c842cf67a342c93e9c44db9d656593e3b6d3b24a6b3");
    expect(canonicalEvidenceHash(q29.question))
      .toBe("810251f1d897b221867c9371082d3669f7726f2f471394d6ae5a98b096437efd");
    expect(passage(q24, 24)).toBe(passage(q25, 25));
    expect(passage(q25, 25)).toBe(passage(q26, 26));
    expect(passage(q26, 26)).toBe(passage(q27, 27));
    expect(passage(q27, 27)).toBe(passage(q28, 28));
    expect(passage(q28, 28)).toBe(passage(q29, 29));
    expect(q24.question).toContain("㉮ <인상: 해돋이>");
    expect(q25.question).toContain("㉯ <우물가의 여인들>");
    expect(q24.question).toContain("‘$S(\\text{색})=rR+gG+bB$’");
    expect(q25.figure_description).toContain("흰 원 약 (0.33, 0.33)");
    expect(q26.figure_description).toContain("필터 A의 투과율");
    expect(q27.figure_description).toBe(q24.figure_description);
    expect(q28.question).toContain("별이 빛나는 파란 하늘과 노란 별");
    expect(q28.question).not.toContain("노란 벽");
    expect(q28.figure_description).toContain("카페 테라스의 탁자와 의자");
    expect(q29.figure_description).toBe(q24.figure_description);
    expect(q29.question).toContain("29. ㉠ ~ ㉤의 사전적 의미");
    expect(q29.choices).toContain("③ ㉢ : 일정한 한도를 넘지 못하게 막음.");
  });

  it.skipIf(!existsSync(join(q43LiveState5577054, "problem.pdf")))(
    "pins the source-exact 5577054 Q33-Q34 full shared passage and diagrams",
    () => {
      const q33Spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q33-source-manual-v1"
      )!;
      const q34Spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q34-source-manual-v1"
      )!;
      expect({
        length: PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.length,
        allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST),
        q33Row: canonicalEvidenceHash(q33Spec),
        q33Replacements: canonicalEvidenceHash(q33Spec.replacements),
        q34Row: canonicalEvidenceHash(q34Spec),
        q34Replacements: canonicalEvidenceHash(q34Spec.replacements),
      }).toEqual({
        length: 91,
        allowlistHash: "3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219",
        q33Row: "357ba6238a19d835559245a62e8470ba6075f7c644d9c2e629a1b86871429974",
        q33Replacements: "f17a6f71abf2b9ab18084b37487ce45fd072fcbcac601860d9a409aa22e75aa1",
        q34Row: "827a61b1f719b33b82901e77fc785329ef4b665b97499f55030089641d770da9",
        q34Replacements: "b10a5ebd7727f49a337f7e99e86ee0b9fa49f921e5e9d79b4eabcdd1663a6e89",
      });
      const recovery = (number: 33 | 34, name: string) => JSON.parse(readFileSync(join(
        q43LiveState5577054,
        `problem-recoveries/${name}`,
      ), "utf8")).item as QuizItemEx;
      const q33 = applyAllowlistedProblemManualCorrection(
        q33Spec.entryId,
        q33Spec.sourceHash,
        recovery(33, "v1-0012-0033-69dbac324ab3584f9be2b82c48d3b4131de3e4bc862390ce4e7c0b58b5335fad.json"),
      );
      const q34 = applyAllowlistedProblemManualCorrection(
        q34Spec.entryId,
        q34Spec.sourceHash,
        recovery(34, "v1-0012-0034-80aad87dca07d9b632082927fed2ff0fd572ba7e335de788d73245d809779178.json"),
      );
      const q35 = JSON.parse(readFileSync(join(
        q43LiveState5577054,
        "problem-manual-adjudications/v1-0013-0035-321727ab8e01323b4b02aac10bd23cbb06d777b5195378888df9da26758ca127.json",
      ), "utf8")).item as QuizItemEx;
      const passage = (item: QuizItemEx, number: number) =>
        item.question.slice(0, item.question.indexOf(`\n\n${number}. `));
      expect(canonicalEvidenceHash(q33)).toBe("fbef33b61daa76a33100ea74f451c7799253c8bc265dd938bf1ed03f51c8913c");
      expect(canonicalEvidenceHash(q34)).toBe("965a9f5fffed1d99afbe679f7c24d85ed362e59148c3b2183ef07467bc14a0e6");
      expect(passage(q33, 33)).toBe(passage(q34, 34));
      expect(passage(q33, 33)).toBe(passage(q35, 35));
      expect(q33.question).toContain("그리고 ⓐ 믿을 만하지 못하면 그제야 논리적 규칙을 적용하여");
      expect(q34.question).toContain("ⓑ 전제들이 논리적으로 더 복잡하다고 해서");
      expect(q34.question).not.toContain("[관련 지문]");
      expect(q34.figure_description).toContain("① 위쪽은 회색·흰색·회색 사각형");
      expect(q34.figure_description).toContain("⑤ 위쪽은 회색으로 채운 사각형 세 개");
    },
  );

  it.skipIf(!existsSync(join(q43LiveState5577054, "problem.pdf")))(
    "pins the source-exact 5577054 Q43-Q45 shared poems, choices, and bracket figure",
    () => {
      const q43Spec = PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q43-manual-source-revision-v1"
      )!;
      const q43ManualSpec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q43-manual-v1"
      )!;
      const q44Spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q44-source-manual-v1"
      )!;
      const q45Spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q45-source-manual-v1"
      )!;
      expect([q43ManualSpec, q44Spec, q45Spec].map(isPersistedManualHydrationSpec))
        .toEqual([true, true, true]);
      expect({
        manualLength: PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.length,
        manualHash: canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST),
        sourceRevisionLength: PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST.length,
        sourceRevisionHash: canonicalEvidenceHash(PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST),
        q43Row: canonicalEvidenceHash(q43Spec),
        q43Replacement: canonicalEvidenceHash(q43Spec.replacement),
        q44Row: canonicalEvidenceHash(q44Spec),
        q44Replacements: canonicalEvidenceHash(q44Spec.replacements),
        q45Row: canonicalEvidenceHash(q45Spec),
        q45Replacements: canonicalEvidenceHash(q45Spec.replacements),
      }).toEqual({
        manualLength: 81,
        manualHash: "3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219",
        sourceRevisionLength: 20,
        sourceRevisionHash: "b8819b943244e1b3e6aaf2a8c48fb8509ee8df8c4b76cd7efa799cd5caef59ac",
        q43Row: "be198b6e9d02562a142d371d760ef565a0d647879feca326cd9c4a3c848d3f2d",
        q43Replacement: "c9b87403eb78b5671cd19908a116e9697c3c134db8608a5809098b8ffcfa693f",
        q44Row: "ba329cba125d6693179344434a117b920d01bc95faa1d8d8c5dea487f46f9779",
        q44Replacements: "756835be50dbcd23a9e316dea49c9c49443f4f9f7512c68e8e3bd1fc796e4086",
        q45Row: "9ae28df02ba48de2741cf017606edd00d6a452ac2cbfa6dbc19f61daeb616daf",
        q45Replacements: "c703a250d633203625a31a451224ffc304e621ebe82e2dfc9bf6fa31ef58a629",
      });
      const item = (path: string) => JSON.parse(readFileSync(join(q43LiveState5577054, path), "utf8"))
        .item as QuizItemEx;
      const q43 = applyAllowlistedProblemManualSourceRevision(
        q43Spec.entryId,
        q43Spec.sourceHash,
        q43Spec.parentRevisionAllowlistId,
        item("problem-manual-revisions/" +
          "v1-0016-0043-eb2097c1be8416cc81e223638bfee67246360f01217e479046b9943389e69912.json"),
      );
      const q44 = applyAllowlistedProblemManualCorrection(
        q44Spec.entryId,
        q44Spec.sourceHash,
        item("problem-recoveries/" +
          "v2-0016-0044-867c8cd53effadea90681aedcbee6a029b7137e77962eeaa65d7b18b485fa745.json"),
      );
      const q45 = applyAllowlistedProblemManualCorrection(
        q45Spec.entryId,
        q45Spec.sourceHash,
        item("problem-recoveries/" +
          "v2-0016-0045-193a01c380532a213f3fa6f19b032bfdc932dda05b1f2665589681e052188e86.json"),
      );
      expect(canonicalEvidenceHash(q43)).toBe(
        "66f7dac4210c123c63929abab14ac7b15360146dc613243105c0e3c3f1505d92"
      );
      expect(canonicalEvidenceHash(q44)).toBe(
        "68dcb0032fcd8c1db2b63a090786546668e64abef296cd8ff0c9fe7b21d8f4ff"
      );
      expect(canonicalEvidenceHash(q45)).toBe(
        "75a5b22c62b381b84387d55b78a8d4bd9689de9c9e123c578ef8adc21d482398"
      );
      const passage = (question: QuizItemEx, number: number) =>
        question.question.slice(0, question.question.indexOf(`\n\n${number}. `));
      expect(passage(q44, 44)).toBe(passage(q43, 43));
      expect(passage(q45, 45)).toBe(passage(q43, 43));
      expect(q43.question).toContain("이 밤으로 돌아가");
      expect(q43.question).not.toContain("이 방으로 돌아가");
      expect(q44.question).toContain("작품과 인간이 격앙하고 충혈되었을 때");
      expect(q44.choices).toContain(
        "② ‘밤눈이 내려 쌓이’는 것은 시인이 일상과 개인의 문제에 관심을 기울여 문학적 성취를 이루어 감을 의미하는 것이겠군."
      );
      expect(q45.choices).toContain(
        "② [A]에서 화자는 새떼들의 아름다운 ‘몸짓’과 ‘목소리’는 ‘살얼음’과 같은 현실을 인식하는 데 방해가 된다고 여기고 있다."
      );
      expect(q44.figure_description).toBe(q43.figure_description);
      expect(q45.figure_description).toBe(q43.figure_description);
    },
  );

  it.skipIf(!existsSync(join(q43LiveState5577054, "problem.pdf")))(
    "pins the source-exact 5577054 Q35-Q36 shared-passage correction pair",
    () => {
      const q35Spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q35-source-manual-v1"
      )!;
      const q36Spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q36-source-manual-v1"
      )!;
      const q35TerminalSpec = PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q35-terminal-fidelity-v1"
      )!;
      const q36TerminalSpec = PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q36-terminal-fidelity-v1"
      )!;
      const terminalSpecsV2 = PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST.filter((candidate) =>
        [
          "ebsi-5577054-q35-terminal-fidelity-v2",
          "ebsi-5577054-q36-terminal-fidelity-v2",
        ].includes(candidate.allowlistId)
      );
      const terminalSpecsV3 = PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST.filter((candidate) =>
        [
          "ebsi-5577054-q35-terminal-fidelity-v3",
          "ebsi-5577054-q36-terminal-fidelity-v3",
        ].includes(candidate.allowlistId)
      );
      const terminalSpecsV4 = PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST.filter((candidate) =>
        [
          "ebsi-5577054-q35-terminal-fidelity-v4",
          "ebsi-5577054-q36-terminal-fidelity-v4",
        ].includes(candidate.allowlistId)
      );
      const terminalSpecsV5 = PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST.filter((candidate) =>
        [
          "ebsi-5577054-q35-terminal-fidelity-v5",
          "ebsi-5577054-q36-terminal-fidelity-v5",
        ].includes(candidate.allowlistId)
      );
      expect({
        length: PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.length,
        allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST),
        q35Row: canonicalEvidenceHash(q35Spec),
        q35Replacements: canonicalEvidenceHash(q35Spec.replacements),
        q36Row: canonicalEvidenceHash(q36Spec),
        q36Replacements: canonicalEvidenceHash(q36Spec.replacements),
      }).toEqual({
        length: 91,
        allowlistHash: "3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219",
        q35Row: "7c62c74d8995fdf80a022bde0280ec4b7cd09075e14cf501ae696b23dd0ae203",
        q35Replacements: "d3ed8443a96e767c7835bfd9364c23670b94fa7dc471732c01a238b1affefcd9",
        q36Row: "a3028fd6d52b49e2782ae981169c6ba79645cb7c8fb26adc6d71e9ddbe390632",
        q36Replacements: "65991fd169f21cec31bdc98a4764dc8afd75b3549deb5a8684c048ef19c2d1da",
      });
      expect(q36Spec.failedStatus).toBe("exact");
      expect({
        length: PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST.length,
        allowlistHash: canonicalEvidenceHash(PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST),
        q35RowHash: canonicalEvidenceHash(q35TerminalSpec),
        q36RowHash: canonicalEvidenceHash(q36TerminalSpec),
        keys: [q35TerminalSpec.key, q36TerminalSpec.key],
        parentQuestionHash: q35TerminalSpec.parentQuestionHash,
        q36ParentQuestionHash: q36TerminalSpec.parentQuestionHash,
        failedTerminalInputHashes: [
          q35TerminalSpec.failedTerminalInputHash,
          q36TerminalSpec.failedTerminalInputHash,
        ],
        failedItemHashes: [q35TerminalSpec.failedItemHash, q36TerminalSpec.failedItemHash],
        v2RowHashes: terminalSpecsV2.map((candidate) => canonicalEvidenceHash(candidate)),
        v3RowHashes: terminalSpecsV3.map((candidate) => canonicalEvidenceHash(candidate)),
        v4RowHashes: terminalSpecsV4.map((candidate) => canonicalEvidenceHash(candidate)),
        v5RowHashes: terminalSpecsV5.map((candidate) => canonicalEvidenceHash(candidate)),
      }).toEqual({
        length: 29,
        allowlistHash: "c9531cd68143e9c3a7c7a34ec93cf018cf8ff5b0cf52b482d83717317095589a",
        q35RowHash: "08c169cd5335b6fdcea2d8f5ebe6027a6ffc15009e366febf883e48a58ed750e",
        q36RowHash: "1beffca4ead0209950734f824a7b7b4e42fba3c02e89e35796b01359908daefa",
        keys: ["13:35", "13:36"],
        parentQuestionHash: "9b83c044ec4160049b0a9a30a67cd51255b61e23982a297f06a2308a121bb00e",
        q36ParentQuestionHash: "007022fe882311c79d872914965258aa346dba184f04dcb4b6dd787723075ea9",
        failedTerminalInputHashes: [
          "5ac8f0f85c39fc568602c6e173efb5b09672c30501a4f949f1e2193924e8ba88",
          "f7367de764fd780cf115097afe12efdacfd44e530ac7b593fa601635729a4962",
        ],
        failedItemHashes: [
          "bf72e1414fcd8435096e0ff864a308f1b14f2f3359ab5133153e8c7003b60164",
          "d28e5cf56ae2ca3c96c3542715ebdaea69c9bed11f48bba132aab58f61f2e25c",
        ],
        v2RowHashes: [
          "f6b8a264af86a7f1a8f878cb19f0585b49ceb38dc1be4c66aaecbcb99ab1fabc",
          "8ff6f04a3a2076a4b873bd52de91d071dfcb12e9475535f74abe00ebadbc7217",
        ],
        v3RowHashes: [
          "17e7243ec36c81b105bbe718a8431ada0bce5aef26f842e61d0ae4190e8af71d",
          "4f5b71bbbf8429298fc5678c3f993816633e1fe3732b96c578e259b256012e2b",
        ],
        v4RowHashes: [
          "5bf87e7f45655655190392daf118b70b38383c2d87c36a7f2d54c32a2e64f413",
          "ce0fde4b07148ea7313c0380b3fd3b56b2286832d40ce35109755d0fb94fe80d",
        ],
        v5RowHashes: [
          "744232062f4bb536fda6f5c136da442ce4eb3296ef90899d55b62af9d516419d",
          "bbf500136b20ae330f09f3a96998efb6fe4a4293c72c61e01d55f24fcede4bd4",
        ],
      });

      const q35 = applyAllowlistedProblemManualCorrection(
        q35Spec.entryId,
        q35Spec.sourceHash,
        q35ExactRecoveryParent5577054(q43LiveState5577054).failed.question,
      );
      const q36 = applyAllowlistedProblemManualCorrection(
        q36Spec.entryId,
        q36Spec.sourceHash,
        q36ExactRecoveryParent5577054(q43LiveState5577054).failed.question,
      );
      const passage = (item: QuizItemEx, number: number) =>
        item.question.slice(0, item.question.indexOf(`\n\n${number}. `));
      expect(canonicalEvidenceHash(q35))
        .toBe("9b83c044ec4160049b0a9a30a67cd51255b61e23982a297f06a2308a121bb00e");
      expect(canonicalEvidenceHash(q35.question))
        .toBe("db5a16340e76bf8b063d71ca5260119c78636baa862902bca1cb63b0f29495fd");
      expect(canonicalEvidenceHash(q36))
        .toBe("007022fe882311c79d872914965258aa346dba184f04dcb4b6dd787723075ea9");
      expect(canonicalEvidenceHash(q36.question))
        .toBe("a75f0fc8c328270346b4130c48bdba9e742de701ba7c34fdb1b82564d11d0fda");
      expect(passage(q35, 35)).toBe(passage(q36, 36));
      expect(q35.question).toContain("ⓐ 믿을 만하지 못하면");
      expect(q35.question).toContain("ⓑ 전제들이 논리적으로 더 복잡하다고 해서");
      expect(q35.question).not.toContain("그리고 ㉠ 믿을 만하지 못하면");
      expect(q36.question).toContain("모든 사각형은 음영이 있는 도형이다.");
    },
  );

  it.skipIf(!existsSync(join(
    q43LiveState5577054,
    "problem-manual-adjudications/" +
      "v1-0016-0043-1e93235939dc8d5e581f03b7cbeb2b76516303f5526405ed30b141614c00d950.json",
  )))("pins the source-exact 5577054 Q43 one-letter revision", () => {
    const spec = PROBLEM_MANUAL_REVISION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q43-source-manual-revision-v1"
    )!;
    const current = JSON.parse(readFileSync(join(
      q43LiveState5577054,
      "problem-manual-adjudications/" +
        "v1-0016-0043-1e93235939dc8d5e581f03b7cbeb2b76516303f5526405ed30b141614c00d950.json",
    ), "utf8")).item as QuizItemEx;
    const corrected = applyAllowlistedProblemManualRevision(
      spec.entryId,
      spec.sourceHash,
      spec.parentAllowlistId,
      current,
    );
    expect({
      length: PROBLEM_MANUAL_REVISION_ALLOWLIST.length,
      allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_REVISION_ALLOWLIST),
      rowHash: canonicalEvidenceHash(spec),
      replacementHash: canonicalEvidenceHash(spec.replacement),
      correctedHash: canonicalEvidenceHash(corrected),
      questionHash: canonicalEvidenceHash(corrected.question),
    }).toEqual({
      length: 29,
      allowlistHash: "d7d33cb415ed9fa39323c9acefc41e7c691875f17be9f6de87acbb574bfd2b15",
      rowHash: "56e66fcabc407575e42751e48d2b87105fffb2f4956214f9aac35bf00e2ec200",
      replacementHash: "3678a5434c08a15479616148574350fc42b029b33c2ea360ebc568bdf3b5c271",
      correctedHash: "13546a03e13d27bde15534f7badf2891477c1683e23d7e7dc0531ae15fbde0d1",
      questionHash: "c38ab0f847c69717789bf4fbb8069d2d7a73c81341cb410430b9b4dd43593d5b",
    });
    expect(corrected.question).toContain("이 방으로 돌아가");
    expect(corrected.question).not.toContain("이 밤으로 돌아가");
  });

  it.skipIf(!existsSync(join(
    q43LiveState5577054,
    "problem-recoveries/v1-0004-0010-ddd83a218f12e0562e69eb9309d3d9f9898b273bd42660541b997b80181a4242.json",
  )))("pins the source-exact 5577054 Q10 shared passage", () => {
    const spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q10-source-manual-v1"
    )!;
    const current = JSON.parse(readFileSync(join(
      q43LiveState5577054,
      "problem-recoveries/v1-0004-0010-ddd83a218f12e0562e69eb9309d3d9f9898b273bd42660541b997b80181a4242.json",
    ), "utf8")).item as QuizItemEx;
    const corrected = applyAllowlistedProblemManualCorrection(
      spec.entryId,
      spec.sourceHash,
      current,
    );
    expect({
      length: PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.length,
      allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST),
      rowHash: canonicalEvidenceHash(spec),
      replacementsHash: canonicalEvidenceHash(spec.replacements),
      correctedHash: canonicalEvidenceHash(corrected),
      questionHash: canonicalEvidenceHash(corrected.question),
    }).toEqual({
      length: 91,
      allowlistHash: "3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219",
      rowHash: "d29d85e7ecafdd8bcdf1f95d704825e2ed704efc3f60911cd0c99263c67d4175",
      replacementsHash: "ae38b4e5cb8475a81f7cd94bde750c5c9dac7ac36d8049bed4246820d5f65f70",
      correctedHash: "70ce3c80d7cf2e134c8599f3da41a961473680cb1cfd20594ad1144748da013c",
      questionHash: "ce2396218737f5a1ba304e5b27e0273fe018db3dbef39af2788462033078c27d",
    });
    expect(corrected.question).toContain("[9~10] 다음은 학생이 쓴 수행 평가의 후기이다. 물음에 답하시오.");
    expect(corrected.question).toContain("자신의 생각인 양 표현하는 것이 문제점임을 설명해 주셨다.");
    expect(corrected.question).not.toContain("물음에 답하십시오.");
    expect(corrected.question).not.toContain("표현하는 것이 문제임을");
  });

  it.skipIf(!existsSync(join(q43LiveState5577054, "problem.pdf")))(
    "moves the 5577054 Q37-Q41 bracket spans to their full official ranges",
    () => {
      const expected = new Map([
        ["14:37", [
          "c5b7c0f6a566acdc08879d203161bc09d4677f0e63f440500ae63992fcb5d045",
          "05d011a08f13f457f9915557401151d0b54228fc740ddafddc0aef58adb7d249",
          "713ea99813f903a5c3c9a96d8250a06b4b95fbe447c441e6bb0e993f83b87161",
          "2979c5347873bb43dbd14a36b9086a6522b113b88ec91e451ad788e0eee9ab55",
        ]],
        ["15:38", [
          "abd9ee72fc8372bd691c0efa42d6266a30a15e6e59347114c884d017d4566807",
          "763a3b50e3ea77dced41dc3a01b0490cc5aa1e3adc815243e6838fb3b2466853",
          "1dc879eabc5ed04c2eff504f4593f6bf934d09492d785ef177ddd3c5f1efe8f7",
          "e1bd8a07308e52cb2353ef3cdbd7f7c0cb6bfef87ee3007a64d3b12d894cf1a3",
        ]],
        ["15:39", [
          "f0fe2b161eedf8ab8c39c81aa95853719ab5c68afc8e49f4c914951b96c24453",
          "459eb877f9d3abd3873f4db341e7ec54cfdb52870bc5e6549a64841605c45520",
          "f248ccb694dfa61bfd07f27a76500694032a945757b6d9da514a673e56ca0fac",
          "1f07a341c64a2d7c08996ef3f88ebb478861564df802dda9e67c28acd550dcca",
        ]],
        ["15:40", [
          "134dee16ca77131535e1b4ffd753a7ff7a1c70bd37fe0b82f39ee353a8d254d3",
          "6c48dbd93756eccc78abe46b0f7e72746822be1712b871637242c46fd03ff642",
          "027f72cb84104d4b4a90c42906b3af9d14ba66240709c03669846521354b04fd",
          "ab3e97304c1cf3e484784f524e457b6ea47d84c61e8ead96950e21346fdf6280",
        ]],
        ["15:41", [
          "6727d26954756c4714e488b82433995d0ddecb8422d477bf499bf58fb8a56012",
          "d1d9d76e6447cf25a0e0f9395b062086d5c05d29a535f0c8f044ff3bcb87a248",
          "d167d732fc875bd3096278231eb3c2b6761b439e6535d24db43cfca543e094e2",
          "544b71a3b2cf90c672546c6787a9ae13f6b784593a0e23909c35ed050de7bee4",
        ]],
      ] as const);
      expect(PROBLEM_MANUAL_REVISION_ALLOWLIST).toHaveLength(29);
      expect(canonicalEvidenceHash(PROBLEM_MANUAL_REVISION_ALLOWLIST))
        .toBe("d7d33cb415ed9fa39323c9acefc41e7c691875f17be9f6de87acbb574bfd2b15");
      expect(PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST).toHaveLength(20);
      expect(canonicalEvidenceHash(PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST))
        .toBe("b8819b943244e1b3e6aaf2a8c48fb8509ee8df8c4b76cd7efa799cd5caef59ac");
      for (const [key, [rowHash, correctedHash, sourceRowHash, finalHash]] of expected) {
        const spec = PROBLEM_MANUAL_REVISION_ALLOWLIST.find((candidate) =>
          candidate.entryId === "ebsi:5577054" && candidate.key === key &&
          candidate.allowlistId.endsWith("source-manual-revision-v1")
        )!;
        const printedNumber = key.split(":")[1].padStart(4, "0");
        const name = readdirSync(join(q43LiveState5577054, "problem-manual-adjudications"))
          .find((candidate) => candidate.includes(`-${printedNumber}-`))!;
        const current = JSON.parse(readFileSync(join(
          q43LiveState5577054,
          "problem-manual-adjudications",
          name,
        ), "utf8")).item as QuizItemEx;
        const corrected = applyAllowlistedProblemManualRevision(
          spec.entryId,
          spec.sourceHash,
          spec.parentAllowlistId,
          current,
        );
        expect(canonicalEvidenceHash(spec)).toBe(rowHash);
        expect(canonicalEvidenceHash(corrected)).toBe(correctedHash);
        const sourceSpec = PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST.find((candidate) =>
          candidate.entryId === "ebsi:5577054" && candidate.key === key &&
          candidate.parentRevisionAllowlistId === spec.allowlistId
        )!;
        const final = applyAllowlistedProblemManualSourceRevision(
          sourceSpec.entryId,
          sourceSpec.sourceHash,
          sourceSpec.parentRevisionAllowlistId,
          corrected,
        );
        expect(canonicalEvidenceHash(sourceSpec)).toBe(sourceRowHash);
        expect(canonicalEvidenceHash(final)).toBe(finalHash);
        expect(final.question).toContain(
          "[A]\n갑자기 한바탕 미친 듯한 바람이 일어나며 구름 속에서 크게 불러 말하기를,",
        );
        expect(final.question).toContain(
          "(다)\n[B]\n하루는 옥황상제께서 사해용왕에게 말씀을 전하시기를,",
        );
        expect(final.figure_description).toContain("괄호 [A]가 ‘갑자기 한바탕");
        expect(final.figure_description).toContain("괄호 [B]가 ‘하루는");
        expect(final.figure_description).not.toContain("괄호 [B]가 ‘(다) 하루는");
      }
    },
  );

  it.skipIf(!existsSync(join(q43LiveState5577054, "problem.pdf")))(
    "pins the source-exact 5577054 Q16-Q20 shared passage across all five questions",
    () => {
      const q16Spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q16-source-manual-v1"
      )!;
      const q17Spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q17-source-manual-v1"
      )!;
      const q19Spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q19-source-manual-v1"
      )!;
      expect({
        length: PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.length,
        allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST),
        q16Row: canonicalEvidenceHash(q16Spec),
        q16Replacements: canonicalEvidenceHash(q16Spec.replacements),
        q17Row: canonicalEvidenceHash(q17Spec),
        q17Replacements: canonicalEvidenceHash(q17Spec.replacements),
        q19Row: canonicalEvidenceHash(q19Spec),
        q19Replacements: canonicalEvidenceHash(q19Spec.replacements),
      }).toEqual({
        length: 91,
        allowlistHash: "3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219",
        q16Row: "0796f970ca37535087480884410f709dfec0c27864ac8ea199ae1397f43c6c6f",
        q16Replacements: "42a2ed457ae3bc6891e7c1cbd79399c22bd420170fbd4b49091a84680b1b3886",
        q17Row: "b3ada309e76c39ee8f8cb21bd266bb815bb66feb90548b9796041f936566b4bc",
        q17Replacements: "d36ef2846d6857e0fae30517fbbeb0a5fe448b46029a208f7d3e7c089988eb48",
        q19Row: "543081a6108ddc1750d03965a40713704686ff06cce0f9bb93c793fb83b2364d",
        q19Replacements: "ca0dd6f36306748c130eefb153b2612aaea312f060722de62305c582bf10458d",
      });
      const q16Base = JSON.parse(readFileSync(join(
        q43LiveState5577054,
        "problem-recoveries/v1-0006-0016-642f982066d32370e6a9d142f3b218273f955fb5746ce641b1c18fc1f38eb93e.json",
      ), "utf8")).item as QuizItemEx;
      const q19Base = JSON.parse(readFileSync(join(
        q43LiveState5577054,
        "problem-recoveries/v1-0006-0019-c2e0a4ebb71ff6b8251a7106693a184dce0450f37848b80dfbb4fb0371691dff.json",
      ), "utf8")).item as QuizItemEx;
      const q17Base = JSON.parse(readFileSync(join(
        q43LiveState5577054,
        "problem-recoveries/v1-0006-0017-5df28006b7f4b5378c65c21a727af8b71103a85ba04bc0bff2be0a3795c03133.json",
      ), "utf8")).item as QuizItemEx;
      const q18 = JSON.parse(readFileSync(join(
        q43LiveState5577054,
        "problem-manual-second-revisions/v1-0006-0018-1bb29a78721cd66cc313367101281df27b8cee50549a24960195c9cdf45b17ee.json",
      ), "utf8")).item as QuizItemEx;
      const q20 = JSON.parse(readFileSync(join(
        q43LiveState5577054,
        "problem-manual-second-revisions/v1-0006-0020-2dfd167310c30503f3f8aa7cfe69edc97c3844e0151d7707ffba14f5de5407b9.json",
      ), "utf8")).item as QuizItemEx;
      const q16 = applyAllowlistedProblemManualCorrection(q16Spec.entryId, q16Spec.sourceHash, q16Base);
      const q17 = applyAllowlistedProblemManualCorrection(q17Spec.entryId, q17Spec.sourceHash, q17Base);
      const q19 = applyAllowlistedProblemManualCorrection(q19Spec.entryId, q19Spec.sourceHash, q19Base);
      expect(canonicalEvidenceHash(q16)).toBe("fc0ccb781e031c167f4b8ee12f959a4b258240fb984fb07103f73c144ca6670f");
      expect(canonicalEvidenceHash(q17)).toBe("9cc9a2d5774ea898ea721e5eb5052fb5b832ae14b7e2b789197ae290374ae8a3");
      expect(canonicalEvidenceHash(q19)).toBe("8194b1ab19d1c8c4e34eb7ed7179ff5dbf6f79601c0c4b27e37b4c552cefb941");
      const passages = [q16, q17, q18, q19, q20].map((item, index) =>
        item.question.split(`\n\n${[16, 17, 18, 19, 20][index]}. `)[0]
      );
      expect(new Set(passages).size).toBe(1);
      expect(passages[0]).toContain("[16 ~ 20] 다음을 읽고 물음에 답하시오.");
      expect(passages[0]).toContain("㉡ 이부가격설정은");
      expect(passages[0]).toContain("삼각형 $P_m\\alpha A$");
      expect(passages[0]).not.toContain("ⓑ 이부가격설정은");
      expect(q17.figure_description).toBe(q16.figure_description);
      expect(q16.figure_description).toBe(q19.figure_description);
      expect(q16.figure_description).toContain("세로축 위쪽 점은 α, 아래쪽 점은 β");
      expect(q16.figure_description).not.toContain("속 빈 원");
    },
  );

  it.skipIf(!existsSync(join(q43LiveState5577054, "problem.pdf")))(
    "pins the source-exact 5577054 Q18 shared passage and graph",
    () => {
      const spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q18-source-manual-v1"
      )!;
      const revisionSpec = PROBLEM_MANUAL_REVISION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q18-source-manual-revision-v1"
      )!;
      const sourceRevisionSpec = PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q18-manual-source-revision-v1"
      )!;
      expect({
        length: PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.length,
        allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST),
        row: canonicalEvidenceHash(spec),
        replacements: canonicalEvidenceHash(spec.replacements),
        revisionLength: PROBLEM_MANUAL_REVISION_ALLOWLIST.length,
        revisionAllowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_REVISION_ALLOWLIST),
        revisionRow: canonicalEvidenceHash(revisionSpec),
        revisionReplacement: canonicalEvidenceHash(revisionSpec.replacement),
        sourceRevisionRow: canonicalEvidenceHash(sourceRevisionSpec),
      }).toEqual({
        length: 91,
        allowlistHash: "3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219",
        row: "5b421d2a2f032b5153a6a2d50c29eacc41e31284c7cb7d0f9c89cd751218a8cb",
        replacements: "d5bd6363671f51edf245ac6844487454673902e5f88d2718c40c10e83582722a",
        revisionLength: 24,
        revisionAllowlistHash: "d7d33cb415ed9fa39323c9acefc41e7c691875f17be9f6de87acbb574bfd2b15",
        revisionRow: "67d75bbb31ce5d72746c4469e9d5c892dd778551ff7789413acf365df1be3390",
        revisionReplacement: "b73264458acca8d038c0e7a64c0a2632530f68ed2caec30ac14a058b839f8af0",
        sourceRevisionRow: "5721d2ca888c1d5017ba2d255bfb65a01c784ce985ffaffb4b2d27061f40b73f",
      });
      const base = applyAllowlistedProblemManualCorrection(
        spec.entryId,
        spec.sourceHash,
        q18ExactRecoveryParent5577054(q43LiveState5577054).failed.question,
      );
      const q18 = applyAllowlistedProblemManualRevision(
        spec.entryId,
        spec.sourceHash,
        spec.allowlistId,
        base,
      );
      const q20 = JSON.parse(readFileSync(join(
        q43LiveState5577054,
        "problem-manual-revisions/v1-0006-0020-93396422de45d65b1df940447951b501d6983ddf3bf285907c7ab7835f3f6541.json",
      ), "utf8")).item as QuizItemEx;
      expect(canonicalEvidenceHash(q18))
        .toBe("16164dc2d5f564178a6e0f11eb6d8c5c24f204fec378c226dcd4eecc79185a65");
      expect(canonicalEvidenceHash(q18.question))
        .toBe("8c63b8fddb428f8634536b376e1abc444b16252fc64ad10562daee588079df17");
      expect(canonicalEvidenceHash(q18.figure_description))
        .toBe("e95a1da2793263a121437da3ade4c737a73a979fc4e9b5e76b1b2f694e514044");
      expect(q18.question.split("\n\n18. ")[0]).toBe(q20.question.split("\n\n20. ")[0]);
      expect(q18.figure_description).toContain("$Q_1$ 위치에도 가로축에서 수요 직선까지 수직 점선");
      expect(q18.figure_description).toContain("위쪽 삼각형 aPE는 사선으로 음영 처리");
      expect(q18.figure_description).toContain("아래쪽 삼각형 PbE는 점상 무늬로 음영 처리");
      expect(q18.figure_description).not.toContain("P 높이까지 수직 점선");
      const finalQ18 = applyAllowlistedProblemManualSourceRevision(
        spec.entryId,
        spec.sourceHash,
        revisionSpec.allowlistId,
        q18,
      );
      expect(canonicalEvidenceHash(finalQ18))
        .toBe("271d65d0fdb6587d89b437e87976144d1b34f20ca4f02405aedc8d4bca17df86");
      expect(finalQ18.figure_description).not.toContain("속 빈 원");
    },
  );

  it.skipIf(!existsSync(join(q43LiveState5577054, "problem.pdf")))(
    "pins the source-exact 5577054 Q37 full shared passage",
    () => {
      const spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q37-source-manual-v1"
      )!;
      expect({
        length: PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.length,
        allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST),
        row: canonicalEvidenceHash(spec),
        replacements: canonicalEvidenceHash(spec.replacements),
      }).toEqual({
        length: 91,
        allowlistHash: "3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219",
        row: "43bd6c65dd0f78e3c41beba165b022ef7c7b4c3ddfbc9ec12616cabdbc226f9b",
        replacements: "c6829fe4992c98c42e1ffcf49df4e80a544d7e124728007ed4dbaebaf3a8076a",
      });
      const current = JSON.parse(readFileSync(join(
        q43LiveState5577054,
        "problem-recoveries/v1-0014-0037-410a5e64f8da8833fc18b3480cd59d61e4fb2643bf45b50735a16139f476315a.json",
      ), "utf8")).item as QuizItemEx;
      const q42 = JSON.parse(readFileSync(join(
        q43LiveState5577054,
        "problem-manual-second-revisions/" +
          "v1-0015-0042-151d0196ee1648f418677f0a2f571b1bb24121bd8bd68a31d5ed9df98fe5b5ce.json",
      ), "utf8")).item as QuizItemEx;
      const corrected = applyAllowlistedProblemManualCorrection(spec.entryId, spec.sourceHash, current);
      expect(canonicalEvidenceHash(corrected))
        .toBe("8e6a86634dc26baf7c3f438dc4d4da82a61801ff6d150a420c63fd3e68944a70");
      expect(canonicalEvidenceHash(corrected.question))
        .toBe("ff07d87ba4d3c820b1b28f40bf2c9c8c81c6790d8d0cba7a13599412845286a5");
      expect(corrected.question.split("\n\n37. ")[0]).toBe(q42.question.split("\n\n42. ")[0]);
      expect(corrected.figure).toBe(true);
      expect(corrected.figure_description).toBe(q42.figure_description);
      expect(corrected.question).toContain("37. (가)의 내용과 일치하지 않는 것은?");
      expect(corrected.question).not.toContain("환상적인 것으로 이것이");
    },
  );

  it.skipIf(!existsSync(join(q43LiveState5577054, "problem.pdf")))(
    "pins the source-exact 5577054 Q38 full shared passage",
    () => {
      const spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q38-source-manual-v1"
      )!;
      expect({
        length: PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.length,
        allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST),
        row: canonicalEvidenceHash(spec),
        replacements: canonicalEvidenceHash(spec.replacements),
      }).toEqual({
        length: 91,
        allowlistHash: "3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219",
        row: "4cbef3129b2f16176779536c68fd3cba7572783d391b35712368d3e7733dbc2b",
        replacements: "de9de8db132710389f9841bbcf6161e4cc576b94bf377dbc99c7e7c7f07dc0e4",
      });
      const current = JSON.parse(readFileSync(join(
        q43LiveState5577054,
        "problem-recoveries/v1-0015-0038-e9c7774cc3619c6457d81204a67bb469ba0fd01f827ce3f0400c887987bf7738.json",
      ), "utf8")).item as QuizItemEx;
      const q42 = JSON.parse(readFileSync(join(
        q43LiveState5577054,
        "problem-manual-second-revisions/" +
          "v1-0015-0042-151d0196ee1648f418677f0a2f571b1bb24121bd8bd68a31d5ed9df98fe5b5ce.json",
      ), "utf8")).item as QuizItemEx;
      const corrected = applyAllowlistedProblemManualCorrection(spec.entryId, spec.sourceHash, current);
      expect(canonicalEvidenceHash(corrected))
        .toBe("8327069bcb9e06649bf330052e14a1c9bbde8fec1b890e5887e7a3eff78c696f");
      expect(canonicalEvidenceHash(corrected.question))
        .toBe("0a777fc5f9df2d37a18fde0c3b134946cc551263d2768e1bfd08a130960cab09");
      expect(corrected.question.split("\n\n38. ")[0]).toBe(q42.question.split("\n\n42. ")[0]);
      expect(corrected.figure_description).toBe(q42.figure_description);
      expect(corrected.question).toContain("38. ‘기이성’을 중심으로");
      expect(corrected.question).not.toContain("[B] 하루는 옥황상제께서");
    },
  );

  it.skipIf(!existsSync(join(q43LiveState5577054, "problem.pdf")))(
    "pins the source-exact 5577054 Q39 full shared passage",
    () => {
      const spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q39-source-manual-v1"
      )!;
      expect({
        length: PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.length,
        allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST),
        row: canonicalEvidenceHash(spec),
        replacements: canonicalEvidenceHash(spec.replacements),
      }).toEqual({
        length: 91,
        allowlistHash: "3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219",
        row: "a42036176a0ab401a5afab917bc874c8af110eae67b7675758041638b0e57226",
        replacements: "95466ed76c7acc4a208d49d42ce24f998b9569f299d38c83dc682eccfb1d63aa",
      });
      const current = JSON.parse(readFileSync(join(
        q43LiveState5577054,
        "problem-recoveries/v1-0015-0039-3e0935b9e3ae18169a694b9b47c8330b5c1a7729441244bc141267165b2fc31c.json",
      ), "utf8")).item as QuizItemEx;
      const q42 = JSON.parse(readFileSync(join(
        q43LiveState5577054,
        "problem-manual-second-revisions/" +
          "v1-0015-0042-151d0196ee1648f418677f0a2f571b1bb24121bd8bd68a31d5ed9df98fe5b5ce.json",
      ), "utf8")).item as QuizItemEx;
      const corrected = applyAllowlistedProblemManualCorrection(spec.entryId, spec.sourceHash, current);
      expect(canonicalEvidenceHash(corrected))
        .toBe("01a3edf919c5b6b529d4eb77444dcd37a30a39c247d3e13f100825eb092dade0");
      expect(canonicalEvidenceHash(corrected.question))
        .toBe("f4625e494b8e48daa3b6e530da97234756a07f0f02fad928367006c4deb340a1");
      expect(corrected.question.split("\n\n39. ")[0]).toBe(q42.question.split("\n\n42. ")[0]);
      expect(corrected.figure_description).toBe(q42.figure_description);
      expect(corrected.question).toContain("(나)\n차설. 해룡이 벌써 집을 떠나");
      expect(corrected.question).toContain("39. ㉠을 참고하여");
    },
  );

  it.skipIf(!existsSync(join(q43LiveState5577054, "problem.pdf")))(
    "pins the source-exact 5577054 Q40 full shared passage",
    () => {
      const spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q40-source-manual-v1"
      )!;
      expect({
        length: PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.length,
        allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST),
        row: canonicalEvidenceHash(spec),
        replacements: canonicalEvidenceHash(spec.replacements),
      }).toEqual({
        length: 91,
        allowlistHash: "3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219",
        row: "df66c46fecda3f475b93ac7cd7a5dfa1a195f76e942dba2c1c5da2949ba3bbf5",
        replacements: "2305bad0b933117121bd79b4debaad9adf2378fe65c39bb05b09a7b483975a9b",
      });
      const current = JSON.parse(readFileSync(join(
        q43LiveState5577054,
        "problem-recoveries/v1-0015-0040-e87b82371bb42c4ee0b55d69c74ff08bd024c26362fb9e48eca1138c1801752a.json",
      ), "utf8")).item as QuizItemEx;
      const q42 = JSON.parse(readFileSync(join(
        q43LiveState5577054,
        "problem-manual-second-revisions/" +
          "v1-0015-0042-151d0196ee1648f418677f0a2f571b1bb24121bd8bd68a31d5ed9df98fe5b5ce.json",
      ), "utf8")).item as QuizItemEx;
      const corrected = applyAllowlistedProblemManualCorrection(spec.entryId, spec.sourceHash, current);
      expect(canonicalEvidenceHash(corrected))
        .toBe("2c2d4545838b980193754a6868497d874b3f89a3bb285ee34206fb64719d11d5");
      expect(canonicalEvidenceHash(corrected.question))
        .toBe("03bf894b4245c7cb6a559ad8d828bf6017cf9a292e8fc0606949ac4e07780b6a");
      expect(corrected.question.split("\n\n40. ")[0]).toBe(q42.question.split("\n\n42. ")[0]);
      expect(corrected.figure_description).toBe(q42.figure_description);
      expect(corrected.question).toContain("40. [A]와 [B]를 비교한 내용으로");
      expect(corrected.question).toContain("ⓐ 문득 벽력같은 소리");
      expect(corrected.question).not.toContain("㉠ 문득 벼락같은 소리");
    },
  );

  it.skipIf(!existsSync(join(q43LiveState5577054, "problem.pdf")))(
    "pins the source-exact 5577054 Q41 full shared passage and box",
    () => {
      const spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === "ebsi-5577054-q41-source-manual-v1"
      )!;
      expect({
        length: PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.length,
        allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST),
        row: canonicalEvidenceHash(spec),
        replacements: canonicalEvidenceHash(spec.replacements),
      }).toEqual({
        length: 91,
        allowlistHash: "3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219",
        row: "605988feed894c9bbb58a57b86ed6e3a3ab38d745b4e1b0d9558237f7dcc7b2b",
        replacements: "f0b6971f94884794df1ed30282d1399bf9d2010bea9ae55f8cec48930f5a00e5",
      });
      const current = JSON.parse(readFileSync(join(
        q43LiveState5577054,
        "problem-recoveries/v1-0015-0041-caa65f364cd8f62eca277ff1802437697d815a4c5148f98e7b37f61f7b803a12.json",
      ), "utf8")).item as QuizItemEx;
      const q42 = JSON.parse(readFileSync(join(
        q43LiveState5577054,
        "problem-manual-second-revisions/" +
          "v1-0015-0042-151d0196ee1648f418677f0a2f571b1bb24121bd8bd68a31d5ed9df98fe5b5ce.json",
      ), "utf8")).item as QuizItemEx;
      const corrected = applyAllowlistedProblemManualCorrection(spec.entryId, spec.sourceHash, current);
      expect(canonicalEvidenceHash(corrected))
        .toBe("dc93618fba9e6bf733013b64b1060f4bb735863cf6fad5c89de836b7d33fcf5a");
      expect(canonicalEvidenceHash(corrected.question))
        .toBe("b2eca04379608e9918ddc29e578859964b535db8adc89bd15e8bb57db1d20871");
      expect(corrected.question.split("\n\n41. ")[0]).toBe(q42.question.split("\n\n42. ")[0]);
      expect(corrected.question).toContain("41. <보기>에서 선생님의 질문에 대한 학생의 대답으로");
      expect(corrected.question).toContain("요귀의 약점인 비늘을 떼어내어");
      expect(corrected.choices).toContain("⑤ 남주인공이 요귀를 찾아가게 된 동기가 공주를 구하기 위한 것이라는 점은 유지되었습니다.");
      expect(corrected.question).not.toContain("요괴");
      expect(corrected.figure_description).toContain("직사각형 테두리 안에 선생님 발화");
    },
  );

  it.skipIf(!existsSync(join(q43LiveState5577054, "problem.pdf")))(
    "pins, writes, and verifies the source-exact 5577054 Q25 full shared passage",
    async () => {
    const spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q25-manual-v1"
    )!;
    const revisionSpec = PROBLEM_MANUAL_REVISION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q25-manual-revision-v1"
    )!;
    expect({
      length: PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.length,
      allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST),
      rowHash: canonicalEvidenceHash(spec),
      replacementsHash: canonicalEvidenceHash(spec.replacements),
      parentRecoveryEvidenceHash: spec.parentRecoveryEvidenceHash,
    }).toEqual({
      length: 91,
      allowlistHash: "3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219",
      rowHash: "cefb111d67d66b95251e07b1099d4d38364330b21f2571b43c96ad18fa3b4fcd",
      replacementsHash: "ea56ed5974ed4516c2f6f82d6a16e748fc1cf71e833402447707b533d1ab39d9",
      parentRecoveryEvidenceHash: "94c0d95498e93fd60c341b59880b9bbb91d180cb086ad7a5b5f382dfe115e8b8",
    });
    expect({
      length: PROBLEM_MANUAL_REVISION_ALLOWLIST.length,
      allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_REVISION_ALLOWLIST),
      rowHash: canonicalEvidenceHash(revisionSpec),
      replacementHash: canonicalEvidenceHash(revisionSpec.replacement),
    }).toEqual({
      length: 29,
      allowlistHash: "d7d33cb415ed9fa39323c9acefc41e7c691875f17be9f6de87acbb574bfd2b15",
      rowHash: "459f288b444fdddfc628dfc17f4e7fc8d7fc9a06aac82ffc6e099ffddf35a624",
      replacementHash: "59ba91067538c7d2e8e3baad2b74efb9e04c0af87255ac65017af59c8b4a552e",
    });
    const pinned = q25ExactRecoveryParent5577054(q43LiveState5577054);
    const corrected = applyAllowlistedProblemManualCorrection(
      "ebsi:5577054",
      spec.sourceHash,
      pinned.failed.question,
    );
    expect(canonicalEvidenceHash(corrected))
      .toBe("0cc203d2fd4bb8d230402aadcfead57419b2eefabb21bb299b937f5ccbdac749");
    expect(canonicalEvidenceHash(corrected.question))
      .toBe("98b2af6c2a669e5ac7b44e5be540c09828cc97364f0b54139bb32d204af1d9d2");
    expect(canonicalEvidenceHash(corrected.choices))
      .toBe("a23e360a2e2e5171dd861639ae82abd4e86b3f35b1418d54d837b8ef8141aa98");
    const revised = applyAllowlistedProblemManualRevision(
      "ebsi:5577054",
      spec.sourceHash,
      spec.allowlistId,
      corrected,
    );
    expect(canonicalEvidenceHash(revised))
      .toBe("053ea803cf6997b2203b32aa4882a89ceabc8993fa4baca37dbc7bb8cdbe54c2");
    expect(canonicalEvidenceHash(revised.figure_description))
      .toBe("ee649d068475385fa91150e5e95aa3622859bf0f8d2ed57179a9983b9426366f");
    expect(revised.figure_description).toContain("두 축 모두 0에서 1까지이고 0.2 간격");
    expect(revised.figure_description).toContain("세로축의 0.6 부근");
    expect(revised.figure_description).toContain("약 (0.3, 0.3)");
    expect(revised.figure_description).toContain("약 (0.8, 0.05)");
    const q24 = JSON.parse(readFileSync(join(
      q43LiveState5577054,
      "problem-recoveries/v1-0009-0024-b447410d8aa383d002e2695280f9bd3656fb6fbf8c44986ecea138a8390981cd.json",
    ), "utf8")).item as QuizItemEx;
    expect(corrected.question.slice(0, corrected.question.indexOf("\n\n25. ")))
      .toBe(q24.question.slice(0, q24.question.indexOf("\n\n24. ")));
    expect(corrected.question).toContain("빨강과 초록이 0이 되는 지점에서 파랑의 비율은 1이 된다.");
    expect(corrected.question).toContain("㉤ <인상·해돋이>");
    expect(corrected.question).toContain("아침 안개 속의 태양 빛");
    expect(corrected.question).toContain("㉦ <유람선의 여인들>");
    expect(corrected.question).not.toContain("인천 앞바다");
    expect(corrected.question).not.toContain("아를르의 포룸 광장의 카페 테라스");
    expect(corrected.answer).toBe(pinned.failed.question.answer);

    const failedManualClassification = JSON.parse(readFileSync(join(
      q43LiveState5577054,
      "classification-manual-adjudications/" +
        "v1-0009-0025-f58a98d13cf28c6a8dc67a714e44ac990f9bf256d7c20e76c09067dad5d25c76-" +
        "7bb7cb863c8c4855.json",
    ), "utf8")).items[0] as ClassificationDecision;
    expect(canonicalEvidenceHash(failedManualClassification))
      .toBe("93278c997388ccdda8ed03172f5f3c312b9e82e557187554dd8d013bc43721d7");

    root = mkdtempSync(join(tmpdir(), "studywork-5577054-q25-manual-"));
    cpSync(q43LiveState5577054, root, { recursive: true });
    removeManualArtifacts(root, ["9:25"]);
    const input = q27FixtureInputs(root);
    const row = q25ExactRecoveryParent5577054(root);
    const calls: string[] = [];
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      expect(request.schema?.name).toBe("studywork_exam_corpus_classification");
      const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
        key: string;
        question: string;
        choices: string[] | null;
        figure_description: string | null;
      }>;
      expect(items).toHaveLength(1);
      calls.push(items[0].key);
      expect(canonicalEvidenceHash(items[0].question))
        .toBe("98b2af6c2a669e5ac7b44e5be540c09828cc97364f0b54139bb32d204af1d9d2");
      expect(items[0].question).toContain("㉤ <인상·해돋이>");
      expect(items[0].question).toContain("㉦ <유람선의 여인들>");
      if (calls.length === 1) {
        expect(canonicalEvidenceHash(items[0].figure_description))
          .toBe("c9e2674c39551f8201c3954fa1c876289d3b3e8ea2df86a4292db3856f023cf5");
        return { text: JSON.stringify([failedManualClassification]) };
      }
      expect(canonicalEvidenceHash(items[0].figure_description))
        .toBe("ee649d068475385fa91150e5e95aa3622859bf0f8d2ed57179a9983b9426366f");
      return { text: JSON.stringify([{
        key: "9:25",
        decision: "accept",
        canonical_subject: "korean_reading",
        curriculum_course: "독서와 작문",
        domain: "과학·기술 설명문의 사실적·추론적 읽기와 시각 자료 해석",
        achievement_codes: ["12독작01-03", "12독작01-04"],
        confidence: 0.99,
        reason_codes: ["SOURCE_EXACT", "FIGURE_INTEGRATED_READING"],
        transcription_status: "exact",
        transcription_evidence: "공식 8~9쪽의 [24~29] 공통 지문 전체, 그림 1~3, 25번 발문과 선택지가 일치한다.",
      }]) };
    });
    const run = () => adjudicateProblemManual(
      input.entry,
      input.problem,
      root,
      row.failed,
      row.parent,
    );
    const completed = await run();
    expect(calls).toEqual(["9:25", "9:25"]);
    expect(canonicalEvidenceHash(completed.classified.question))
      .toBe("053ea803cf6997b2203b32aa4882a89ceabc8993fa4baca37dbc7bb8cdbe54c2");
    const verified = withOnlyManualArtifactsForKey(root, "9:25", () =>
      verifyProblemManualAdjudicationForTest({
        stateDir: root,
        entry: input.entry,
        problemEvidence: input.problem,
        parentRecovery: row.parent as unknown as Record<string, unknown>,
        failedQuestion: row.failed.question,
        failedClassification: row.failed.classification,
        manualAdjudication: completed.evidence,
      })) as { question: QuizItemEx; classification: ClassificationDecision };
    expect(canonicalEvidenceHash(verified.question))
      .toBe("053ea803cf6997b2203b32aa4882a89ceabc8993fa4baca37dbc7bb8cdbe54c2");
    expect(verified.classification.transcription_status).toBe("exact");
    const stable = stateSnapshot(root);
    await run();
    expect(calls).toEqual(["9:25", "9:25"]);
    expect(stateSnapshot(root)).toEqual(stable);

    const problemPath = join(root, completed.evidence.revision!.problemArtifact.path);
    const problemBytes = readFileSync(problemPath);
    writeFileSync(problemPath, Buffer.concat([problemBytes, Buffer.from(" ")]));
    const beforeTamper = stateSnapshot(root);
    await expect(run()).rejects.toThrow(/hash|canonical|envelope|allowlist/u);
    expect(calls).toEqual(["9:25", "9:25"]);
    expect(stateSnapshot(root)).toEqual(beforeTamper);
  }, 180_000);

  it.skipIf(!existsSync(join(q43LiveState5577054, "problem.pdf")))(
    "pins, writes, and verifies the source-exact 5577054 Q26 full shared passage and graphs",
    async () => {
    const spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q26-manual-v1"
    )!;
    expect({
      length: PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.length,
      allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST),
      rowHash: canonicalEvidenceHash(spec),
      replacementsHash: canonicalEvidenceHash(spec.replacements),
      parentRecoveryEvidenceHash: spec.parentRecoveryEvidenceHash,
    }).toEqual({
      length: 91,
      allowlistHash: "3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219",
      rowHash: "1291ff45e929dceaef36251a5b51c95969e0742341971a78a63352dc536d4b82",
      replacementsHash: "ced88a34bc2c9bf149abc34822f096c216529576f2ee92dd71af18d754497cde",
      parentRecoveryEvidenceHash: "594537e6c1a0db71e5b7526ac2dd4cefbd0f6ffb63f1349ae0487505c084e49a",
    });
    const pinned = q26ExactRecoveryParent5577054(q43LiveState5577054);
    const corrected = applyAllowlistedProblemManualCorrection(
      "ebsi:5577054",
      spec.sourceHash,
      pinned.failed.question,
    );
    expect(canonicalEvidenceHash(corrected))
      .toBe("6c21f5f2fa81dbe1cc7b4681ac851da5036b48f21c9353d565d03f037a78c345");
    expect(canonicalEvidenceHash(corrected.question))
      .toBe("a976585d89c0965cc7ddbd9bc916d05ebbbf2ad5024e8d1850793129b62a6252");
    expect(canonicalEvidenceHash(corrected.choices))
      .toBe("fb7b1031bf628cff6d20bfcc9a757e02d09eb8614c860d07b04f4dd729054eca");
    expect(canonicalEvidenceHash(corrected.figure_description))
      .toBe("c5b8ba5a35e7a3d74ecce3e58d9d4e0636e179fd21462ea289f8cea3d32ebe76");
    const q24 = JSON.parse(readFileSync(join(
      q43LiveState5577054,
      "problem-recoveries/v1-0009-0024-b447410d8aa383d002e2695280f9bd3656fb6fbf8c44986ecea138a8390981cd.json",
    ), "utf8")).item as QuizItemEx;
    expect(corrected.question.slice(0, corrected.question.indexOf("\n\n26. ")))
      .toBe(q24.question.slice(0, q24.question.indexOf("\n\n24. ")));
    expect(corrected.question).toContain("26. 윗글을 바탕으로 <보기>");
    expect(corrected.figure_description).toContain("세로축의 0.6 부근");
    expect(corrected.figure_description).toContain("필터 A의 투과율");
    expect(corrected.figure_description).toContain("필터 B의 투과율");
    expect(corrected.figure_description).toContain("600nm에서 0%로 수직 하강");
    expect(corrected.figure_description).toContain("500nm에서 100%로 수직 상승");
    expect(corrected.question).not.toContain("인천 안개 속");
    expect(corrected.question).not.toContain("우물가의 여인들");
    expect(corrected.answer).toBe(pinned.failed.question.answer);

    root = mkdtempSync(join(tmpdir(), "studywork-5577054-q26-manual-"));
    cpSync(q43LiveState5577054, root, { recursive: true });
    removeManualArtifacts(root, ["9:26"]);
    const input = q27FixtureInputs(root);
    const row = q26ExactRecoveryParent5577054(root);
    const calls: string[] = [];
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      expect(request.schema?.name).toBe("studywork_exam_corpus_classification");
      const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
        key: string;
        question: string;
        choices: string[] | null;
        figure_description: string | null;
      }>;
      expect(items).toHaveLength(1);
      calls.push(items[0].key);
      expect(canonicalEvidenceHash(items[0].question))
        .toBe("a976585d89c0965cc7ddbd9bc916d05ebbbf2ad5024e8d1850793129b62a6252");
      expect(canonicalEvidenceHash(items[0].figure_description))
        .toBe("c5b8ba5a35e7a3d74ecce3e58d9d4e0636e179fd21462ea289f8cea3d32ebe76");
      return { text: JSON.stringify([{
        key: "9:26",
        decision: "accept",
        canonical_subject: "korean_reading",
        curriculum_course: "독서와 작문",
        domain: "과학 설명문의 추론적 읽기와 그래프 자료 적용",
        achievement_codes: ["12독작01-03", "12독작01-04"],
        confidence: 0.99,
        reason_codes: ["SOURCE_EXACT", "TEXT_GRAPH_INFERENCE"],
        transcription_status: "exact",
        transcription_evidence: "공식 8~9쪽의 [24~29] 공통 지문·그림 1~3과 26번 필터 A/B 그래프·선지가 일치한다.",
      }]) };
    });
    const run = () => adjudicateProblemManual(
      input.entry,
      input.problem,
      root,
      row.failed,
      row.parent,
    );
    const completed = await run();
    expect(calls).toEqual(["9:26"]);
    expect(canonicalEvidenceHash(completed.classified.question))
      .toBe("6c21f5f2fa81dbe1cc7b4681ac851da5036b48f21c9353d565d03f037a78c345");
    const verified = withOnlyManualArtifactsForKey(root, "9:26", () =>
      verifyProblemManualAdjudicationForTest({
        stateDir: root,
        entry: input.entry,
        problemEvidence: input.problem,
        parentRecovery: row.parent as unknown as Record<string, unknown>,
        failedQuestion: row.failed.question,
        failedClassification: row.failed.classification,
        manualAdjudication: completed.evidence,
      })) as { question: QuizItemEx; classification: ClassificationDecision };
    expect(canonicalEvidenceHash(verified.question))
      .toBe("6c21f5f2fa81dbe1cc7b4681ac851da5036b48f21c9353d565d03f037a78c345");
    expect(verified.classification.transcription_status).toBe("exact");
    const stable = stateSnapshot(root);
    await run();
    expect(calls).toEqual(["9:26"]);
    expect(stateSnapshot(root)).toEqual(stable);

    const problemPath = join(root, completed.evidence.problemArtifact.path);
    const problemBytes = readFileSync(problemPath);
    writeFileSync(problemPath, Buffer.concat([problemBytes, Buffer.from(" ")]));
    const beforeTamper = stateSnapshot(root);
    await expect(run()).rejects.toThrow(/hash|canonical|envelope|allowlist/u);
    expect(calls).toEqual(["9:26"]);
    expect(stateSnapshot(root)).toEqual(beforeTamper);
  }, 180_000);

  it.skipIf(!existsSync(join(q31Q32LiveState, "problem.pdf")))(
    "completes and replays the Q21 shared-passage source revision",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-5578421-q21-source-revision-"));
    cpSync(q31Q32LiveState, root, { recursive: true });
    for (const directory of ["problem-manual-second-revisions", "classification-manual-second-revisions"]) {
      const path = join(root, directory);
      if (!existsSync(path)) continue;
      for (const name of readdirSync(path)) {
        if (name.startsWith("v1-0008-0021-")) rmSync(join(path, name));
      }
    }
    const input = q27FixtureInputs(root);
    const row = q19Q21ExactRecoveryParent5578421(root, "21");
    const sourceSpec = PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST.find((spec) =>
      spec.allowlistId === "ebsi-5578421-q21-manual-source-revision-v1"
    )!;
    expect({
      length: PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST.length,
      prefixHash: canonicalEvidenceHash(PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST.slice(0, 3)),
      allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST),
      rowHash: canonicalEvidenceHash(sourceSpec),
      replacementHash: canonicalEvidenceHash(sourceSpec.replacement),
      triggerHash: canonicalEvidenceHash(sourceSpec.terminalTrigger),
    }).toEqual({
      length: 20,
      prefixHash: "05d392d62117f4864b0a5964466970815e167655b12c69817909cdd43e006e1f",
      allowlistHash: "b8819b943244e1b3e6aaf2a8c48fb8509ee8df8c4b76cd7efa799cd5caef59ac",
      rowHash: "4c70814866ee7bcff53e2bb652f35158d4eada24cc14699fbcac2af4dc38a4a1",
      replacementHash: "b7c5384c744504673b8c9b0d28b3f4df5d88485c69d8e2ef192873da8773639b",
      triggerHash: "ccf2ee80611b4c2fd857538c26681d010982a8c421248b81337fc5312690b878",
    });
    const calls: string[] = [];
    providerMock.complete.mockImplementation((request: { schema?: { name?: string }; prompt: string }) => {
      expect(request.schema?.name).toBe("studywork_exam_corpus_classification");
      const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
        key: string;
        question: string;
      }>;
      expect(items).toHaveLength(1);
      const item = items[0];
      calls.push(item.key);
      expect(item.key).toBe("8:21");
      expect(item.question).toContain("[19 ~ 21] 다음 글을 읽고 물음에 답하시오.");
      expect(item.question).toContain("베틀 소리만 삐걱삐걱 처량하게 우네");
      expect(item.question).toContain("(나)\n\n이 밤 이제 조금만");
      return Promise.resolve({ text: JSON.stringify([{
        key: item.key,
        decision: "accept",
        canonical_subject: "korean_literature",
        curriculum_course: "문학",
        domain: "현대시와 현대 수필의 공통 제재 비교 감상",
        achievement_codes: ["12문학01-02", "12문학01-04"],
        confidence: 0.99,
        reason_codes: ["SOURCE_EXACT", "IN_SCOPE_KOREAN_LITERATURE"],
        transcription_status: "exact",
        transcription_evidence: "공식 7~8쪽의 [19~21] 공통 (가)·(나), 각주, <보기>, 21번이 일치한다.",
      }]) });
    });
    const completed = await adjudicateProblemManual(
      input.entry,
      input.problem,
      root,
      row.failed,
      row.parent
    );
    const { sourceRevision, ...parentRevision } = completed.evidence.revision!;
    expect({
      parentRevision: canonicalEvidenceHash(parentRevision),
      question: canonicalEvidenceHash(completed.classified.question),
      sourceAllowlistId: sourceRevision?.allowlistId,
    }).toEqual({
      parentRevision: "0accb187d715cb6e97349c8f7aff203607358d7c970f0c4bf5d80e9ab74b238d",
      question: "66503b19287bc0e25dfb441e95a19d31cf3e1ce9a33eb2eab85f1c3def672e76",
      sourceAllowlistId: "ebsi-5578421-q21-manual-source-revision-v1",
    });
    expect(calls).toEqual(["8:21"]);
    const stable = stateSnapshot(root);
    await adjudicateProblemManual(input.entry, input.problem, root, row.failed, row.parent);
    expect(calls).toEqual(["8:21"]);
    expect(stateSnapshot(root)).toEqual(stable);
  }, 120_000);

  it.skipIf(!existsSync(join(q31Q32LiveState, "problem.pdf")))(
    "pins and applies the source-exact 5578421 Q44-Q45 shared passage",
    () => {
    const specs = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.filter((spec) =>
      spec.entryId === "ebsi:5578421" && ["16:44", "16:45"].includes(spec.key)
    );
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST).toHaveLength(91);
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 46)))
      .toBe("918b9267faab3d394cf64e5b9f02e9621024c5c6ad5d17d233fd8940fd1dac82");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST))
      .toBe("3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219");
    expect(specs.map((spec) => ({
      key: spec.key,
      rowHash: canonicalEvidenceHash(spec),
      replacementsHash: canonicalEvidenceHash(spec.replacements),
      parentRecoveryEvidenceHash: spec.parentRecoveryEvidenceHash,
      failedStatus: spec.failedStatus,
    }))).toEqual([{
      key: "16:44",
      rowHash: "a218df41070334840e83c6ca5a7bc689716ba892102764a32e90249c1ee95e4c",
      replacementsHash: "2f54cb0fb33d67b812ddfc834849a52389fc7671babd287ae22cb874e9d5418c",
      parentRecoveryEvidenceHash: "e0a4da2358b622c0b6ba44bb5b6a7f3c12773d4c5b63cf0b06ae9cd69413235e",
      failedStatus: undefined,
    }, {
      key: "16:45",
      rowHash: "1c6ba6d0191e25b6991175ebf57c6dfb07f650c7969e1c335ba4a361549a8bb5",
      replacementsHash: "092952d05ee949af0b029d4ff7fd011edeeda8276e31cc0c04081f5a67d4f7cf",
      parentRecoveryEvidenceHash: "509282a7d921720fc7c5507606bf80b03113c096aa5cadf3eaa59adfd8fecc33",
      failedStatus: "exact",
    }]);
    const rows = (["44", "45"] as const).map((number) =>
      q44Q45ExactRecoveryParent5578421(q31Q32LiveState, number)
    );
    const corrected = rows.map((row, index) => applyAllowlistedProblemManualCorrection(
      "ebsi:5578421", specs[index].sourceHash, row.failed.question
    ));
    expect(corrected.map((item) => canonicalEvidenceHash(item))).toEqual([
      "699e118886163261c7dfa82ae3b664c44c4b2b4de73cfb304df740161e645342",
      "24999c59ff5e789d6193f2635937d9d56c380cda4bc9786fb327a8d1f8536b20",
    ]);
    expect(corrected.map((item) => canonicalEvidenceHash(item.question))).toEqual([
      "ec7d75199b4d43492926a8de3c07aee17373ad5b5935014c50fd476288b4ca7e",
      "9a350e5e81ac881db7058b1b6b08871229baa52644176ec0da00ad4cd8594d3d",
    ]);
    const revisionSpecs = PROBLEM_MANUAL_REVISION_ALLOWLIST.filter((spec) =>
      spec.entryId === "ebsi:5578421" && ["16:44", "16:45"].includes(spec.key)
    );
    expect(revisionSpecs.map((spec) => ({
      key: spec.key,
      rowHash: canonicalEvidenceHash(spec),
      replacementHash: canonicalEvidenceHash(spec.replacement),
    }))).toEqual([{
      key: "16:44",
      rowHash: "41d2518dfff51233a9604956b19ea7cfe8d53a7257f80958a05565ddadcadaaf",
      replacementHash: "54b0838141a647c0183807b769bca52bca0c4437186229d9d8904aef96f68886",
    }, {
      key: "16:45",
      rowHash: "b3742ae0758ddba275a8131de206fc86e3bea2f0bfdfde9dadb0eb10be8baa00",
      replacementHash: "54b0838141a647c0183807b769bca52bca0c4437186229d9d8904aef96f68886",
    }]);
    const revised = corrected.map((item, index) => applyAllowlistedProblemManualRevision(
      "ebsi:5578421", revisionSpecs[index].sourceHash, revisionSpecs[index].parentAllowlistId, item
    ));
    expect(revised.map((item) => canonicalEvidenceHash(item))).toEqual([
      "9c38330638950ef2e46c3748001b36d2c7f8ddd86249f9c859581a6dec54a93c",
      "9e7c7255f20d16b9d0f11e0ae3cdc81b51f56caf05e2df792a08c348012a0689",
    ]);
    expect(revised.map((item) => canonicalEvidenceHash(item.question))).toEqual([
      "265a789249841b8bda6cdb5e992b23f67928397d57c8604523efacf6b00f14aa",
      "8438e3ea2f766d535d473002ff045b7724a5b29a0fe81cb249a820f40611ae5f",
    ]);
    const sourceRevisionSpec = PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST.find((spec) =>
      spec.allowlistId === "ebsi-5578421-q45-manual-source-revision-v1"
    )!;
    expect({
      length: PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST.length,
      prefixHash: canonicalEvidenceHash(PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST.slice(0, 4)),
      allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST),
      rowHash: canonicalEvidenceHash(sourceRevisionSpec),
      replacementsHash: canonicalEvidenceHash([
        sourceRevisionSpec.replacement,
        ...(sourceRevisionSpec.additionalReplacements ?? []),
      ]),
    }).toEqual({
      length: 20,
      prefixHash: "ffc789e8918c8a5603c82d08faa7e2adefedba8aa15c5304f24a6ef8dd520922",
      allowlistHash: "b8819b943244e1b3e6aaf2a8c48fb8509ee8df8c4b76cd7efa799cd5caef59ac",
      rowHash: "d1838baa7e6f533817722fca9207e3ca354e28c72b0474691cd17d950dbeeaa3",
      replacementsHash: "c7d8df99440c1308c253b783a315c35360b97413e00913ef6658bdd74cec11ca",
    });
    const sourceRevised45 = applyAllowlistedProblemManualSourceRevision(
      "ebsi:5578421",
      sourceRevisionSpec.sourceHash,
      sourceRevisionSpec.parentRevisionAllowlistId,
      revised[1],
    );
    expect(canonicalEvidenceHash(sourceRevised45))
      .toBe("06bc483a24e118a3b41c2da971bffeef560fb491c5b9625928dfce214b9b4a02");
    expect(sourceRevised45.choices?.[2]).toContain("B-(가):");
    expect(sourceRevised45.choices?.[2]).toContain("B-(나):");
    expect(sourceRevised45.choices?.[3]).toContain("④ C-(가):");
    expect(sourceRevised45.choices?.[4]).toContain("⑤ C-(나):");
    expect(sourceRevised45.answer).toBe(sourceRevised45.choices?.[4]);
    const shared44 = revised[0].question.slice(
      0,
      revised[0].question.indexOf("<보기>를 바탕으로 (가)의 ㉠과 (나)의 ㉡을 이해한")
    );
    const shared45 = sourceRevised45.question.slice(
      0,
      sourceRevised45.question.indexOf("45. <보기>를 바탕으로 아래의 탐구 과제를 수행한")
    );
    expect(shared44).toBe(shared45);
    expect(shared44).toContain("※ <보기>를 읽고 44번과 45번 두 물음에 답하시오.");
    expect(shared44).toContain("아아, 너는 산(山)ㅅ새처럼 날러갔구나!");
    expect(shared44).toContain("열없이 붙어서서 입김을 흐리우니");
    expect(shared44).toContain("밀려와 부딪히고,");
    expect(shared44).toContain("보석(寶石)처럼 백힌다.");
    expect(shared44).not.toContain("부딪치고");
    expect(shared44).not.toContain("박힌다");
    expect(shared44).toContain("단절과 소통, 소멸과 생성의 이미지를");
    expect(shared44).not.toContain("파닥거린다");
    expect(sourceRevised45.figure).toBe(true);
    expect(sourceRevised45.figure_description).toContain("B-(가)와 B-(나)의 두 판단 근거는 선택지 ③ 하나");
    expect(sourceRevised45.figure_description).toContain("C-(가)는 ④, C-(나)는 ⑤");
    const terminalSpecs = PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST.filter((spec) =>
      spec.entryId === "ebsi:5578421" && ["16:44", "16:45"].includes(spec.key)
    );
    expect(canonicalEvidenceHash(PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST.slice(0, 6)))
      .toBe("ed50715b038c943772bf68371f3b835910b95db1806b2758eddc6b8a6695b048");
    expect(canonicalEvidenceHash(PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST))
      .toBe("c9531cd68143e9c3a7c7a34ec93cf018cf8ff5b0cf52b482d83717317095589a");
    expect(terminalSpecs.map((spec) => ({
      key: spec.key,
      rowHash: canonicalEvidenceHash(spec),
      failedItemHash: spec.failedItemHash,
    }))).toEqual([{
      key: "16:44",
      rowHash: "2705abdd799860ed0090f6d67e89303ccafb9c71e7703d2b53244c19ab1c368d",
      failedItemHash: "a18c117c38f96083dc886373293ea629f095e342c625e013f47f4a2eab4d5375",
    }, {
      key: "16:45",
      rowHash: "caa0e97bd439b8301ae93734be8f5f75d5741914b09adaf8d12111be9d1b5454",
      failedItemHash: "37573001f51bfc1b0ce117fe754972b880cbd7c08d99dee865296c6159faf460",
    }, {
      key: "16:44",
      rowHash: "6a2989c239c4cb690595afa06003cd2515a0d898ce6517f2a9582cf84848afb5",
      failedItemHash: "93082f2c676903c59ca65eaee755c626a0aefd3915c91443c60d61049c127c9d",
    }, {
      key: "16:45",
      rowHash: "869d075a6618382044dbb6cb381c6c38befd6fb7b9a3462c8c38a2cb3498e40c",
      failedItemHash: "047c2f80427da0e73855debf865eff4c36e345e865a1b8f7925923d04785d341",
    }, {
      key: "16:44",
      rowHash: "aa37f20570b7b5a5bb4c4edb32007b45b3dd9a18e70b21e31656673172b3ccc5",
      failedItemHash: "3f4d6e39b51eaa7437705f4f2b454223aeee5a9f2624ea69ce1abab624f070b6",
    }, {
      key: "16:45",
      rowHash: "c6ecc1d284134c9524de28420b530a6fe1b1d706dbfe7739cd3ff8a1cd9d3b75",
      failedItemHash: "cff3eb160f0d7fa43667a62fc862ad398f8921ecc43e54236d3c6e21c8caf11e",
    }]);
    expect(terminalSpecs[0].policyRevision).toMatchObject({
      allowlistId: "ebsi-5578421-q44-terminal-source-policy-v1",
      kind: "source",
      parentAdjudicationArtifactHash: "3b253ab305674f0da4f208ed8abc1af9eb836e6ea1af223f2d594c076683bed5",
      parentAdjudicationItemHash: "4d24dbf18f37b9d6bb01cad7b6bb0a72c0d1e08cc78300b2181dce1cf0e80c40",
      expectedItem: expect.objectContaining({ key: "16:44", status: "exact", scopeDecision: "accept" }),
    });
    expect(canonicalEvidenceHash(terminalSpecs[0].policyRevision))
      .toBe("0445f336e65a41b09d7c93ab6ca2cbaa7f5ced3ae736394f7d9b34ac92f9aa2e");
    expect(terminalSpecs[1].policyRevision).toMatchObject({
      allowlistId: "ebsi-5578421-q45-terminal-source-policy-v1",
      kind: "source",
      parentAdjudicationArtifactHash: "9418d9f3b996bc8c6d918aedc93ec73814586f802ab1476039567699a6bccf25",
      parentAdjudicationItemHash: "29f8b0211c08ad1094e38ef204485da4b28038e759c6d33bd5723d420c0a1bd8",
      expectedItem: expect.objectContaining({ key: "16:45", status: "exact", scopeDecision: "accept" }),
    });
    expect(canonicalEvidenceHash(terminalSpecs[1].policyRevision))
      .toBe("715e0b61ec3bde057b374c943adb63d28161b327be8352695fafb98e682e2c05");
    expect(canonicalEvidenceHash(terminalSpecs[2].policyRevision))
      .toBe("8288a5aaf2b1549e072d9c298b94aed49faff5e5bb9fe9f749ed88bd9e1de596");
    expect(canonicalEvidenceHash(terminalSpecs[4].policyRevision))
      .toBe("4ae370f23ccd88c652d9f3949a7d4cc06614edfd593c498a5e880fe58581e40d");
    expect(canonicalEvidenceHash(terminalSpecs[5].policyRevision))
      .toBe("84246e50fd628dd54e1b691a7990fde782cd4278eb51ee2c9671ad1fbe18e2af");
  });

  it.skipIf(!existsSync(join(q31Q32LiveState, "problem.pdf")))(
    "replays accumulated Q44-Q45 source policies and rejects historical tamper",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-5578421-q44-terminal-source-policy-"));
    cpSync(q31Q32LiveState, root, { recursive: true });
    for (const directory of ["semantic-choice-checks", "answer-audit", "answer-attestation"]) {
      rmSync(join(root, directory), { recursive: true, force: true });
    }
    const input = q27FixtureInputs(root);
    const terminalCalls: string[] = [];
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity" &&
        request.prompt.includes("Final question:\n")) {
        const items = JSON.parse(request.prompt.split("Final question:\n")[1]) as Array<{ key: string }>;
        terminalCalls.push(...items.map((item) => item.key));
      }
      throw new Error("seeded next importer boundary");
    });
    await expect(repairAndAuditOfficialAnswers(
      input.entry,
      input.problem,
      input.solution,
      root,
      input.classified,
      input.solutions
    )).rejects.toThrow(
      /seeded next importer boundary|problem recovery는 한 번만 허용됩니다|final source-grounded recovery도 exact가 아닙니다/u,
    );
    expect(terminalCalls).toEqual([]);
    const policyFiles = readdirSync(join(root, "problem-terminal-fidelity-policy-revisions"))
      .filter((name) => /^v1-0016-004[45]-/u.test(name));
    expect(policyFiles).toHaveLength(5);
    const policies = policyFiles.map((name) => JSON.parse(readFileSync(join(
      root,
      "problem-terminal-fidelity-policy-revisions",
      name
    ), "utf8"))).sort((left, right) => left.basis.allowlistId.localeCompare(right.basis.allowlistId));
    expect(policies.map((policy) => policy.basis.allowlistId)).toEqual([
      "ebsi-5578421-q44-terminal-source-policy-v1",
      "ebsi-5578421-q44-terminal-source-policy-v2",
      "ebsi-5578421-q44-terminal-source-policy-v3",
      "ebsi-5578421-q45-terminal-source-policy-v1",
      "ebsi-5578421-q45-terminal-source-policy-v3",
    ]);
    expect(policies.map((policy) => policy.item)).toEqual([
      expect.objectContaining({ key: "16:44", status: "exact", scopeDecision: "accept" }),
      expect.objectContaining({ key: "16:44", status: "exact", scopeDecision: "accept" }),
      expect.objectContaining({ key: "16:44", status: "exact", scopeDecision: "accept" }),
      expect.objectContaining({ key: "16:45", status: "exact", scopeDecision: "accept" }),
      expect.objectContaining({ key: "16:45", status: "exact", scopeDecision: "accept" }),
    ]);
    for (const policy of policies) {
      expect(policy.basis).toMatchObject({
        policyKind: "source",
        problemSourceEvidence: {
          path: "problem.pdf",
          sha256: "4c9aee0ec0c15f91678bc3c179efb4c781ab0f9023ca2e5347df94060012272e",
        },
      });
    }
    const currentPolicy = policies.find((policy) =>
      policy.basis.allowlistId === "ebsi-5578421-q45-terminal-source-policy-v3"
    )!;
    const currentPolicyPath = join(
      root,
      "problem-terminal-fidelity-policy-revisions",
      `v1-0016-0045-${currentPolicy.basisDigest}.json`,
    );
    writeFileSync(currentPolicyPath, Buffer.concat([readFileSync(currentPolicyPath), Buffer.from(" ")]));
    const beforeTamper = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(repairAndAuditOfficialAnswers(
      input.entry,
      input.problem,
      input.solution,
      root,
      input.classified,
      input.solutions,
    )).rejects.toThrow(/pinned terminal fidelity policy revision hash가 다릅니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(beforeTamper);
  }, 120_000);

  it.skipIf(!existsSync(join(q31Q32LiveState, "problem.pdf")))(
    "routes the persisted Q21 mismatch recovery into its manual chain",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-5578421-q21-recovery-manual-"));
    cpSync(q31Q32LiveState, root, { recursive: true });
    const frozenQ21Classification = JSON.parse(readFileSync(join(
      q31Q32LiveState,
      "classification-manual-adjudications",
      readdirSync(join(q31Q32LiveState, "classification-manual-adjudications"))
        .find((name) => name.startsWith("v1-0008-0021-"))!
    ), "utf8")).items[0];
    const frozenQ21RevisionClassification = JSON.parse(readFileSync(join(
      q31Q32LiveState,
      "classification-manual-revisions",
      readdirSync(join(q31Q32LiveState, "classification-manual-revisions"))
        .find((name) => name.startsWith("v1-0008-0021-"))!
    ), "utf8")).items[0];
    removeManualArtifacts(root, ["8:21"]);
    removeManualRevisionArtifacts(root, ["8:21"]);
    for (const directory of ["semantic-choice-checks", "answer-audit", "answer-attestation"]) {
      rmSync(join(root, directory), { recursive: true, force: true });
    }
    const input = q27FixtureInputs(root);
    const q21Calls: string[] = [];
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
          key: string;
          question: string;
        }>;
        expect(items).toHaveLength(1);
        const item = items[0];
        if (item.key !== "8:21") throw new Error(`seeded post-Q21 boundary: ${item.key}`);
        q21Calls.push(item.key);
        expect(item.question).toContain("*곱새담: 풀 짚으로 만든 담.");
        expect(item.question).not.toContain("*곱새담: 짚 풀로 만든 담.");
        return { text: JSON.stringify([
          q21Calls.length === 1 ? frozenQ21Classification : frozenQ21RevisionClassification,
        ]) };
      }
      throw new Error(`seeded post-Q21 boundary: ${request.schema?.name ?? "unknown"}`);
    });
    await expect(repairAndAuditOfficialAnswers(
      input.entry,
      input.problem,
      input.solution,
      root,
      input.classified,
      input.solutions
    )).rejects.toThrow("seeded post-Q21 boundary");
    expect(q21Calls).toEqual(["8:21", "8:21", "8:21"]);
    expect(readdirSync(join(root, "problem-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0008-0021-"))).toHaveLength(1);
    expect(readdirSync(join(root, "classification-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0008-0021-"))).toHaveLength(1);
    expect(readdirSync(join(root, "problem-manual-revisions"))
      .filter((name) => name.startsWith("v1-0008-0021-"))).toHaveLength(1);
    expect(readdirSync(join(root, "classification-manual-revisions"))
      .filter((name) => name.startsWith("v1-0008-0021-"))).toHaveLength(1);
    expect(readdirSync(join(root, "problem-manual-second-revisions"))
      .filter((name) => name.startsWith("v1-0008-0021-"))).toHaveLength(1);
    expect(readdirSync(join(root, "classification-manual-second-revisions"))
      .filter((name) => name.startsWith("v1-0008-0021-"))).toHaveLength(1);
  }, 120_000);

  it.skipIf(!existsSync(join(q31Q32LiveState, "problem.pdf")))(
    "preflights and replays the 5578421 Q44-Q45 manual pair byte-stably",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-5578421-q44-q45-manual-"));
    cpSync(q31Q32LiveState, root, { recursive: true });
    removeManualRevisionArtifacts(root, ["16:44", "16:45"]);
    const input = q27FixtureInputs(root);
    const rows = (["44", "45"] as const).map((number) =>
      q44Q45ExactRecoveryParent5578421(root, number)
    );
    const calls: string[] = [];
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      expect(request.schema?.name).toBe("studywork_exam_corpus_classification");
      const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
        key: string;
        question: string;
        figure_description: string | null;
      }>;
      expect(items).toHaveLength(1);
      const item = items[0];
      calls.push(item.key);
      expect(item.question).toContain("[43 ~ 45] 다음 글을 읽고 물음에 답하시오.");
      expect(item.question).toContain("※ <보기>를 읽고 44번과 45번 두 물음에 답하시오.");
      expect(item.question).toContain("아아, 너는 산(山)ㅅ새처럼 날러갔구나!");
      expect(item.question).toContain("열없이 붙어서서 입김을 흐리우니");
      expect(item.question).not.toContain("소멸과 재생의 이미지를");
      if (item.key === "16:45") {
        expect(item.figure_description).toContain("C의 두 판단 근거는 하나의 선택지 ⑤로 묶여 있다.");
      }
      return { text: JSON.stringify([{
        key: item.key,
        decision: "accept",
        canonical_subject: "korean_literature",
        curriculum_course: "문학",
        domain: "현대시의 소재와 표현 효과",
        achievement_codes: ["12문학01-03"],
        confidence: 0.99,
        reason_codes: ["SOURCE_EXACT", "IN_SCOPE_KOREAN_LITERATURE"],
        transcription_status: "exact",
        transcription_evidence: `공식 15~16쪽의 ${item.key} 공통 시·보기·발문·선지가 일치한다.`,
      }]) };
    });
    const run = (row: ReturnType<typeof q44Q45ExactRecoveryParent5578421>) =>
      adjudicateProblemManual(input.entry, input.problem, root, row.failed, row.parent);
    const completed = [];
    for (const row of rows) completed.push(await run(row));
    expect(calls).toEqual(["16:44", "16:45"]);
    expect(completed.map((item) => canonicalEvidenceHash(item.classified.question))).toEqual([
      "9c38330638950ef2e46c3748001b36d2c7f8ddd86249f9c859581a6dec54a93c",
      "9e7c7255f20d16b9d0f11e0ae3cdc81b51f56caf05e2df792a08c348012a0689",
    ]);
    const stable = stateSnapshot(root);
    const beforeReplay = [...calls];
    for (const row of rows) await run(row);
    expect(calls).toEqual(beforeReplay);
    expect(stateSnapshot(root)).toEqual(stable);

    removeManualRevisionArtifacts(root, ["16:44"]);
    const q45ProblemName = readdirSync(join(root, "problem-manual-revisions"))
      .find((name) => name.startsWith("v1-0016-0045-"))!;
    const q45ProblemPath = join(root, "problem-manual-revisions", q45ProblemName);
    const q45ProblemBytes = readFileSync(q45ProblemPath);
    writeFileSync(q45ProblemPath, Buffer.concat([q45ProblemBytes, Buffer.from(" ")]));
    const beforeTamper = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(run(rows[0])).rejects.toThrow(/manual revision hash가 다릅니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(beforeTamper);
  }, 240_000);

  it.skipIf(!existsSync(join(q31Q32LiveState, "problem.pdf")))(
    "hydrates pinned Q19-Q21, Q30-Q34, and Q44-Q45 ahead of superseding recoveries",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-5578421-pinned-superseded-"));
    cpSync(q31Q32LiveState, root, { recursive: true });
    const classificationKeys: string[] = [];
    let terminalCalls = 0;
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{ key: string }>;
        classificationKeys.push(...items.map((item) => item.key));
        throw new Error(`seeded later classification boundary: ${items.map((item) => item.key).join(",")}`);
      }
      if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
        terminalCalls++;
        const items = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{
          key: string;
          question: string;
          choices: string[] | null;
          figure_description: string | null;
        }>;
        const q44 = items.find((item) => item.key === "16:44");
        const q45 = items.find((item) => item.key === "16:45");
        const q30 = items.find((item) => item.key === "12:30");
        const q31 = items.find((item) => item.key === "12:31");
        const q32 = items.find((item) => item.key === "12:32");
        const q33 = items.find((item) => item.key === "12:33");
        const q34 = items.find((item) => item.key === "12:34");
        const q19 = items.find((item) => item.key === "8:19");
        const q20 = items.find((item) => item.key === "8:20");
        const q21 = items.find((item) => item.key === "8:21");
        expect(q19?.question).toContain("곱새담*의 짚날을 뽑아 오고….");
        expect(q20?.question).toContain("곱새담*의 짚날을 뽑아 오고….");
        expect(q21?.question).toContain("곱새담*의 짚날을 뽑아 오고….");
        expect(q19?.choices?.[1]).toContain("주체와 객체를 전도시켜");
        expect(q30?.question).toContain("‘걷는다’와 같이 동사인 경우");
        expect(q30?.question).toContain("단순 명제라 하여 ‘$p$, $q$, $r$’");
        expect(q30?.question).toContain("논증의 타당성을 평가했다.");
        expect(q30?.question).toContain("<결론>인 $q$가");
        expect(q31?.question).toContain("ⓐ와 ⓑ의 입장에서 <보기>를 분석한 것으로");
        expect(q31?.question).toContain("<결론>인 $q$");
        expect(q31?.question).not.toContain("입장에서 다음 <보기>");
        expect(q32?.question).toContain("전제들을 엮을 수 있도록");
        expect(q32?.question).toContain("㉢ 명제 논리학");
        expect(q33?.question).toContain("㉡의 사례로 가장 적절한 것은?");
        expect(q33?.question).toContain("<결론>인 $q$");
        expect(q34?.question).toContain("34. <보기>는 ㉢을 심화 학습");
        expect(q34?.question).toContain("컴퓨터로 프로그래밍할 수 있는 길");
        expect(q44?.question).toContain("열없이 붙어서서 입김을 흐리우니");
        expect(q44?.question).toContain("길들은 양 언 날개를 파다거린다.");
        expect(q45?.choices?.[2]).toContain("B-(가):");
        expect(q45?.choices?.[2]).toContain("B-(나):");
        expect(q45?.choices?.[3]).toContain("④ C-(가):");
        expect(q45?.choices?.[4]).toContain("⑤ C-(나):");
        throw new Error("seeded terminal after pinned Q44-Q45 hydration");
      }
      throw new Error(`seeded later boundary: ${request.schema?.name ?? "unknown"}`);
    });
    const input = q27FixtureInputs(root);
    await expect(repairAndAuditOfficialAnswers(
      input.entry,
      input.problem,
      input.solution,
      root,
      input.classified,
      input.solutions,
    )).rejects.toThrow(/seeded (?:terminal after pinned Q44-Q45 hydration|later)/u);
    expect(classificationKeys).not.toContain("16:44");
    expect(classificationKeys).not.toContain("16:45");
    expect(classificationKeys).not.toContain("8:19");
    expect(classificationKeys).not.toContain("8:20");
    expect(classificationKeys).not.toContain("8:21");
    expect(classificationKeys).not.toContain("12:31");
    expect(classificationKeys).not.toContain("12:32");
    expect(classificationKeys).not.toContain("12:33");
    expect(classificationKeys).not.toContain("12:34");
    expect(terminalCalls).toBeLessThanOrEqual(1);
  }, 180_000);

  it.skipIf(!existsSync(join(q43LiveState5577054, "problem.pdf")))(
    "hydrates all 38 persisted 5577054 manual generations before later work",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-5577054-cross-entry-hydration-"));
    cpSync(q43LiveState5577054, root, { recursive: true });
    removeManualSourceRevisionArtifacts(root, ["5:14"]);
    removeManualGenerationArtifacts(root, "ebsi-5577054-q15-source-manual-v1");
    removeManualGenerationArtifacts(root, "ebsi-5577054-q17-source-manual-v1");
    removeManualGenerationArtifacts(root, "ebsi-5577054-q32-source-manual-v1");
    removeManualRevisionArtifacts(root, ["11:30"]);
    removeManualSourceRevisionArtifacts(root, ["11:31"]);
    const writingKeys = new Set(["3:6", "3:7", "3:8"]);
    const readingKeys = new Set(["6:17"]);
    const literatureKeys = new Set(["11:30", "11:31", "11:32"]);
    const newManualKeys = new Set([...writingKeys, "5:14", "5:15", ...readingKeys, ...literatureKeys]);
    const manualClassificationKeys: string[] = [];
    let terminalCalls = 0;
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      const persistedKeys = new Set([
        "1:3", "3:6", "3:7", "3:8", "4:10", "5:14", "6:16", "6:18", "6:19", "6:20", "7:21", "8:22", "8:23",
        "9:24", "9:25", "9:26", "10:27", "10:28", "10:29",
        "12:33", "12:34", "13:35", "13:36", "14:37",
        "15:38", "15:39", "15:40", "15:41", "15:42", "16:43", "16:44", "16:45",
      ]);
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
          key: string;
          question: string;
          choices: string[] | null;
          figure_description: string | null;
        }>;
        if (items.every((item) => newManualKeys.has(item.key))) {
          manualClassificationKeys.push(...items.map((item) => item.key));
          for (const item of items.filter((candidate) => writingKeys.has(candidate.key))) {
            expect(item.question).toContain("○ ㉮ 청소년의 전자 상거래 피해를 예방하기 위한 노력에");
            expect(item.question).toContain("전자 상거래에서 인한 피해를 입지 않도록");
            expect(item.question).toContain("\n\n[B]\n\n");
          }
          const q14 = items.find((item) => item.key === "5:14");
          if (q14) {
            expect(q14.question).toContain("[14 ~ 15] 다음을 읽고 물음에 답하시오.");
            expect(q14.question).toContain("‘ㅏ, ㅗ, ㆍ’ 등의 양성 모음");
            expect(q14.question).not.toContain("‘ㆍ, ㅏ, ㅗ’ 등의 양성 모음");
            expect(q14.question).toContain("‘/을, /를’");
            expect(q14.question).toContain("‘사’과 같은 단어들은 ‘사슴’과 같이");
            expect(q14.choices).toContain("⑤ - | 야 | 가득하- | 가득하여");
            expect(q14.figure_description).toContain("‘15세기 국어’와 ‘현대 국어’");
          }
          const q15 = items.find((item) => item.key === "5:15");
          if (q15) {
            expect(q15.question).toContain("[14 ~ 15] 다음을 읽고 물음에 답하시오.");
            expect(q15.question).toContain("‘/을, /를’");
            expect(q15.question).toContain("‘사’과 같은 단어들은 ‘사슴’과 같이");
            expect(q15.question).toContain("④ 17세기에는 모음 조화의 약화에 따라 조사 사용에 혼란이");
          }
          const q17 = items.find((item) => item.key === "6:17");
          if (q17) {
            expect(q17.question).toContain("[16 ~ 20] 다음을 읽고 물음에 답하시오.");
            expect(q17.question).toContain("17. ㉠의 사례로 가장 적절한 것은?");
            expect(q17.question).toContain("삼각형 $P_m\\alpha A$");
            expect(q17.figure_description).toContain("세로축 위쪽 점은 α, 아래쪽 점은 β");
          }
          for (const item of items.filter((candidate) => literatureKeys.has(candidate.key))) {
            expect(item.question).toContain("문의 유리의 하반부가 깨어진 것이");
            expect(item.question).toContain("강하원이지. 순순히 나를 따라와.");
            expect(item.question).toContain("그러나 설령 수소문을 할 건더지가");
            expect(item.question).toContain("- 최윤, ｢회색 눈사람｣ -");
            if (item.key === "11:31") {
              expect(item.choices).toContain(
                "① ‘문의 유리의 하반부가 깨어진 것’은 ‘나’를 억압하는 요인이 폭력적 속성을 지녔음을 상징적으로 나타낸다고 볼 수 있어."
              );
            }
          }
          return { text: JSON.stringify(items.map((item) => {
            const literature = literatureKeys.has(item.key);
            const reading = readingKeys.has(item.key);
            const accepted = literature || reading;
            return {
              key: item.key,
              decision: accepted ? "accept" : "reject",
              canonical_subject: literature ? "korean_literature" : reading ? "korean_reading" : null,
              curriculum_course: literature ? "문학" : reading ? "독서와 작문" : null,
              domain: literature
                ? "현대 소설의 서술자·서술 방식과 인물의 내면"
                : reading ? "경제 개념의 사실적·추론적 읽기" : null,
              achievement_codes: literature
                ? ["12문학01-02", "12문학01-03"]
                : reading ? ["12독작01-03"] : [],
              confidence: 0.99,
              reason_codes: literature
                ? ["LITERARY_NARRATION", "NOVEL_INTERPRETATION", "SINGLE_SUBJECT_SCOPE"]
                : reading ? ["NONFICTION_READING", "ECONOMIC_CONCEPT_APPLICATION"]
                : ["EXCLUDED_WRITING_COMPOSITION"],
              transcription_status: "exact",
              transcription_evidence: `공식 PDF의 ${item.key} 공통 지문과 발문·선지가 일치한다.`,
            };
          })) };
        }
        expect(items.map((item) => item.key).filter((key) => persistedKeys.has(key))).toEqual([]);
      } else {
        expect(request.schema?.name).toBe("studywork_exam_corpus_problem_terminal_fidelity");
        terminalCalls++;
        const items = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{
          key: string;
          question: string;
          choices: string[] | null;
          figure_description: string | null;
        }>;
        const item = (key: string) => items.find((candidate) => candidate.key === key)!;
        const passage = (key: string, number: number) =>
          item(key).question.slice(0, item(key).question.indexOf(`\n\n${number}. `));
        expect(item("1:3").question).toContain("전시도 관람도 불편합니다.");
        expect(item("3:6").question).toContain("○ ㉮ 청소년의 전자 상거래 피해를 예방하기 위한 노력에");
        expect(item("3:6").question).toContain("\n\n[B]\n\n㉠~㉤ 중");
        expect(item("3:7").question).toContain("전자 상거래에서 인한 피해를 입지 않도록");
        expect(item("3:8").question).toContain("전망을 바탕으로 ㉮에 관한 내용을");
        expect(item("5:14").question).toContain("‘ㅏ, ㅗ, ㆍ’ 등의 양성 모음");
        expect(item("5:14").choices).toContain("⑤ - | 야 | 가득하- | 가득하여");
        expect(passage("5:14", 14)).toBe(passage("5:15", 15));
        expect(passage("6:16", 16)).toBe(passage("6:17", 17));
        expect(item("6:17").figure_description).toContain("세로축 위쪽 점은 α, 아래쪽 점은 β");
        const q30Q32Passages = ["11:30", "11:31", "11:32"].map((key) => {
          expect(item(key).question).toContain("강하원이지. 순순히 나를 따라와.");
          expect(item(key).question).toContain("단 하나. 청계천의 ㉤ 헌책방");
          expect(item(key).question).toContain("그러나 설령 수소문을 할 건더지가");
          expect(item(key).question).toContain("- 최윤, ｢회색 눈사람｣ -");
          const start = item(key).question.indexOf("<앞부분의 줄거리>");
          const title = "- 최윤, ｢회색 눈사람｣ -";
          return item(key).question.slice(start, item(key).question.indexOf(title, start) + title.length)
            .replace(/\s+/gu, "");
        });
        expect(new Set(q30Q32Passages).size).toBe(1);
        expect(item("4:10").question).toContain("자신의 생각인 양 표현하는 것이 문제점임을");
        expect(item("6:16").question).toContain("[16 ~ 20] 다음을 읽고 물음에 답하시오.");
        expect(passage("9:24", 24)).toBe(passage("10:29", 29));
        expect(item("9:24").question).toContain("㉮ <인상: 해돋이>");
        expect(item("10:27").question).toContain("감법 혼합의 원리는");
        expect(item("10:29").choices).toContain("③ ㉢ : 일정한 한도를 넘지 못하게 막음.");
        expect(item("13:35").question).toContain("그러나 ㉠ 이 논증의 전제를 만족시키는");
        expect(item("13:35").question).toContain("ⓐ 믿을 만하지 못하면");
        expect(item("13:36").question).toContain("모든 사각형은 음영이 있는 도형이다.");
        expect(item("14:37").question).toContain("[37 ~ 42] 다음을 읽고 물음에 답하시오.");
        expect(item("14:37").question).toContain("금령(金鈴)*");
        expect(item("16:43").question).toContain("시를 믿고 어떻게 살어가나");
        expect(item("16:43").question).toContain("잠들은 아내와 어린것의 벼개 맡에");
      }
      throw new Error("seeded 5577054 boundary after cross-entry preflight");
    });
    const input = q27FixtureInputs(root);
    await expect(repairAndAuditOfficialAnswers(
      input.entry,
      input.problem,
      input.solution,
      root,
      input.classified,
      input.solutions,
    )).rejects.toThrow("seeded 5577054 boundary after cross-entry preflight");
    expect(manualClassificationKeys.every((key) => newManualKeys.has(key))).toBe(true);
    expect(terminalCalls).toBe(1);
  }, 420_000);

  it.skipIf(!existsSync(join(q43LiveState5577054, "problem.pdf")))(
    "pins, writes, and replays the source-exact 5577054 Q42 shared passage",
    async () => {
    const spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q42-manual-v1"
    )!;
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST).toHaveLength(91);
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST))
      .toBe("3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219");
    expect({
      rowHash: canonicalEvidenceHash(spec),
      replacementsHash: canonicalEvidenceHash(spec.replacements),
      parentRecoveryEvidenceHash: spec.parentRecoveryEvidenceHash,
    }).toEqual({
      rowHash: "31ae06d441057eced80cffaf585e32a2927776a556f32182f02f4da958b459c0",
      replacementsHash: "a31c83cfa1890ec69b112975338ce9b8c16d7e5f84cfbe2f93d0841d5635fb9a",
      parentRecoveryEvidenceHash: "d3e9ad5ad035efdf5b3baed0762297735275a0c7287d7b5a6d4d5e3a6bf8afda",
    });
    const pinned = q42ExactRecoveryParent5577054(q43LiveState5577054);
    const corrected = applyAllowlistedProblemManualCorrection(
      "ebsi:5577054",
      spec.sourceHash,
      pinned.failed.question,
    );
    expect(canonicalEvidenceHash(corrected))
      .toBe("867740b94e5c3412b090da86e21bc01005fd0ef0c5ef271a3eb933427f4f034e");
    expect(canonicalEvidenceHash(corrected.question))
      .toBe("8fb2fabd02d28eac7484d6bff51d6cf59ff72a472a02d776e2fbd9ea5ca529d5");
    for (const token of [
      "[37 ~ 42] 다음을 읽고 물음에 답하시오.", "금령(金鈴)*", "바라보이매",
      "ⓐ 문득 벽력같은 소리", "금령이 아니었더라면", "기어 들어가니",
      "주궁패궐*", "누워 앓다가", "사람을 속임이", "천행으로",
      "인당수로 돌려보내어", "여덟 선녀", "부귀와 영화로", "둥덩실",
      "당나라의 옛일", "혼인날이 당하매", "42. ⓐ ~ ⓔ에 대한 설명으로",
    ]) expect(corrected.question).toContain(token);
    for (const stale of [
      "[37~42]", "암석이 바라보이며", "모든 바람막 같은 소리", "금빛 돋친",
      "돌 버섯", "사람을 죽임이", "친행으로", "부귀와 영광으로", "ⓔ 위험이",
    ]) expect(corrected.question).not.toContain(stale);
    expect(corrected.figure).toBe(true);
    expect(corrected.figure_description).toContain("묶음 괄호 [A]");
    expect(corrected.figure_description).toContain("괄호 [B]");
    expect(corrected.choices).toEqual(pinned.failed.question.choices);
    expect(corrected.answer).toBe(pinned.failed.question.answer);

    const revisionSpec = PROBLEM_MANUAL_REVISION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q42-manual-revision-v1"
    )!;
    expect({
      length: PROBLEM_MANUAL_REVISION_ALLOWLIST.length,
      allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_REVISION_ALLOWLIST),
      rowHash: canonicalEvidenceHash(revisionSpec),
      replacementHash: canonicalEvidenceHash(revisionSpec.replacement),
    }).toEqual({
      length: 29,
      allowlistHash: "d7d33cb415ed9fa39323c9acefc41e7c691875f17be9f6de87acbb574bfd2b15",
      rowHash: "16ca1e7fb9f94fd2da81648e0f408706ccc67966c14d812ae12f80848a6c639c",
      replacementHash: "81be7218cb0c77f6c65dd51f00008cef6e1bf19a09da243ef74daca44c61c777",
    });
    const revised = applyAllowlistedProblemManualRevision(
      "ebsi:5577054",
      spec.sourceHash,
      spec.allowlistId,
      corrected,
    );
    expect(canonicalEvidenceHash(revised))
      .toBe("a21ea3c7b9e3e6f7b58fd5d019ab15a13d6cad8c3660f3e6c3143c02313b560a");
    expect(canonicalEvidenceHash(revised.question))
      .toBe("8fb2fabd02d28eac7484d6bff51d6cf59ff72a472a02d776e2fbd9ea5ca529d5");
    expect(revised.figure_description).toContain("괄호 [A]가 ‘크게 불러 말하기를,’부터");
    expect(revised.figure_description).toContain("방황하느냐?’까지를 감싼다");
    expect(revised.figure_description).not.toContain("인용문만 감싼다. 공식 14쪽");

    const sourceRevisionSpec = PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q42-manual-source-revision-v1"
    )!;
    const finalSourceRevisionSpec = PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q42-manual-source-revision-v2"
    )!;
    expect({
      length: PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST.length,
      allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST),
      rowHash: canonicalEvidenceHash(sourceRevisionSpec),
      replacementHash: canonicalEvidenceHash(sourceRevisionSpec.replacement),
      parentRevisionEvidenceHash: sourceRevisionSpec.parentRevisionEvidenceHash,
    }).toEqual({
      length: 20,
      allowlistHash: "b8819b943244e1b3e6aaf2a8c48fb8509ee8df8c4b76cd7efa799cd5caef59ac",
      rowHash: "e34815c9d14643ee14f5bc34771ceb9f97894ad319a3878b1fd198db15acd999",
      replacementHash: "88ac126111a80b5b6f4fbfc135f927c2c6cd39d24392dfd6188b1dc3b5c79821",
      parentRevisionEvidenceHash: "9b6286fc828c0ea5e816ca236be868868c97e8b59a3e3235ba6c0afd02c2a802",
    });
    expect({
      rowHash: canonicalEvidenceHash(finalSourceRevisionSpec),
      replacementsHash: canonicalEvidenceHash([
        finalSourceRevisionSpec.replacement,
        ...(finalSourceRevisionSpec.additionalReplacements ?? []),
      ]),
      parentRevisionEvidenceHash: finalSourceRevisionSpec.parentRevisionEvidenceHash,
    }).toEqual({
      rowHash: "212c7c6a1e62398c1b70c754bc3324177374e9e72b21b2241ccdc34c1b680b95",
      replacementsHash: "ea62c14c33a9a348534659a7255a5b142b1ab61b1b59b7d9b79481ff32fe6349",
      parentRevisionEvidenceHash: "20726471e605134dcf01fa3aa74848e323b69335f2373878553c3262b24230dd",
    });
    const sourceCorrected = applyAllowlistedProblemManualSourceRevision(
      "ebsi:5577054",
      spec.sourceHash,
      revisionSpec.allowlistId,
      revised,
    );
    expect(canonicalEvidenceHash(sourceCorrected))
      .toBe("7b413957c243f4c4d7328649e77877dfb644b14257de20ab8eafd10019e06cb2");
    expect(canonicalEvidenceHash(sourceCorrected.question))
      .toBe("f0d6eb14980af2f6d5da0f402dbbd2afbd2e53bb015a641118bf7735f9948939");
    expect(sourceCorrected.question).toContain("부귀와 영광으로 만만세를 즐기소서.");
    expect(sourceCorrected.question).not.toContain("부귀와 영화로 만만세를 즐기소서.");
    expect(sourceCorrected.choices).toEqual(pinned.failed.question.choices);
    expect(sourceCorrected.answer).toBe(pinned.failed.question.answer);
    const finalSourceCorrected = applyAllowlistedProblemManualSourceRevision(
      "ebsi:5577054",
      spec.sourceHash,
      sourceRevisionSpec.allowlistId,
      sourceCorrected,
    );
    expect(canonicalEvidenceHash(finalSourceCorrected))
      .toBe("041f221e6e73707b95a28f63894f076b808ef694816c1f0dd9483b497ebd829c");
    expect(canonicalEvidenceHash(finalSourceCorrected.question))
      .toBe("9b1c9d8d0f18654f95a730262aa1d74385449d3a315eb074ce084b93eb3628e6");
    expect(finalSourceCorrected.question).toContain("[A]\n갑자기 한바탕 미친 듯한 바람이");
    expect(finalSourceCorrected.question).toContain("(다)\n[B]\n하루는 옥황상제께서");
    expect(finalSourceCorrected.figure_description).toContain("괄호 [B]가 ‘하루는 옥황상제께서");

    root = mkdtempSync(join(tmpdir(), "studywork-5577054-q42-manual-"));
    cpSync(q43LiveState5577054, root, { recursive: true });
    removeManualSourceRevisionArtifacts(root, ["15:42"]);
    const input = q27FixtureInputs(root);
    const row = q42ExactRecoveryParent5577054(root);
    const calls: string[] = [];
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      expect(request.schema?.name).toBe("studywork_exam_corpus_classification");
      const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
        key: string;
        question: string;
        figure_description: string | null;
      }>;
      expect(items).toHaveLength(1);
      calls.push(items[0].key);
      expect(canonicalEvidenceHash(items[0].question)).toBe(calls.length === 1
        ? "f0d6eb14980af2f6d5da0f402dbbd2afbd2e53bb015a641118bf7735f9948939"
        : "9b1c9d8d0f18654f95a730262aa1d74385449d3a315eb074ce084b93eb3628e6");
      expect(items[0].question).toContain("부귀와 영광으로 만만세를 즐기소서.");
      expect(items[0].figure_description).toContain(calls.length === 1
        ? "괄호 [A]가 ‘크게 불러 말하기를,’부터"
        : "괄호 [A]가 ‘갑자기 한바탕");
      const first = calls.length === 1;
      return { text: JSON.stringify([{
        key: "15:42",
        decision: "accept",
        canonical_subject: "korean_literature",
        curriculum_course: "문학",
        domain: first ? "고전 소설의 서술·표현 방식과 효과" : "고전 소설의 인물과 서사 전개",
        achievement_codes: ["12문학01-02"],
        confidence: 0.99,
        reason_codes: first
          ? ["CLASSICAL_FICTION_COMPREHENSION", "LITERARY_EXPRESSION_EFFECT", "SINGLE_SUBJECT_SCOPE"]
          : ["SOURCE_EXACT", "IN_SCOPE_KOREAN_LITERATURE"],
        transcription_status: "exact",
        transcription_evidence: first
          ? "공식 13~15쪽에서 (가)~(다)의 전체 제시문, 중략·주석, ⓐ~ⓔ, 42번 발문과 5개 선택지를 " +
            "대조했으며 모두 일치한다. 필수 문구 ‘부귀와 영광으로 만만세를 즐기소서.’가 확인되고, " +
            "[A]는 ‘크게 불러 말하기를,’부터 해당 인용문까지, [B]는 ‘심 소저 혼약할 기한이 가까우니’부터 " +
            "해당 인용문 끝까지를 감싸는 오른쪽 세로선·왼쪽 방향 캡으로 정확히 기술되었다."
          : "공식 13~15쪽의 [37~42] 공통 지문과 42번 발문·선지가 일치한다.",
      }]) };
    });
    const run = () => adjudicateProblemManual(
      input.entry,
      input.problem,
      root,
      row.failed,
      row.parent,
    );
    const completed = await run();
    expect(calls).toEqual(["15:42", "15:42"]);
    expect(canonicalEvidenceHash(completed.classified.question))
      .toBe("041f221e6e73707b95a28f63894f076b808ef694816c1f0dd9483b497ebd829c");
    expect(completed.classified.classification).toEqual(expect.objectContaining({
      key: "15:42",
      decision: "accept",
      canonical_subject: "korean_literature",
      transcription_status: "exact",
    }));
    const verified = withOnlyManualArtifactsForKey(root, "15:42", () =>
      verifyProblemManualAdjudicationForTest({
        stateDir: root,
        entry: input.entry,
        problemEvidence: input.problem,
        parentRecovery: row.parent as unknown as Record<string, unknown>,
        failedQuestion: row.failed.question,
        failedClassification: row.failed.classification,
        manualAdjudication: completed.evidence,
      })) as { question: QuizItemEx; classification: ClassificationDecision };
    expect(canonicalEvidenceHash(verified.question))
      .toBe("041f221e6e73707b95a28f63894f076b808ef694816c1f0dd9483b497ebd829c");
    expect(verified.classification.transcription_status).toBe("exact");
    const stable = stateSnapshot(root);
    await run();
    expect(calls).toEqual(["15:42", "15:42"]);
    expect(stateSnapshot(root)).toEqual(stable);

    const problemPath = join(root, completed.evidence.revision!.sourceRevision!.problemArtifact.path);
    const problemBytes = readFileSync(problemPath);
    writeFileSync(problemPath, Buffer.concat([problemBytes, Buffer.from(" ")]));
    const beforeTamper = stateSnapshot(root);
    await expect(run()).rejects.toThrow(/hash|canonical|envelope|allowlist/u);
    expect(calls).toEqual(["15:42", "15:42"]);
    expect(stateSnapshot(root)).toEqual(beforeTamper);
  }, 180_000);

  it.skipIf(!existsSync(join(q43LiveState5577054, "problem.pdf")))(
    "pins, writes, and verifies the source-exact 5577054 Q20 full shared passage",
    async () => {
    const spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q20-manual-v1"
    )!;
    expect({
      length: PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.length,
      allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST),
      rowHash: canonicalEvidenceHash(spec),
      replacementsHash: canonicalEvidenceHash(spec.replacements),
      parentRecoveryEvidenceHash: spec.parentRecoveryEvidenceHash,
    }).toEqual({
      length: 91,
      allowlistHash: "3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219",
      rowHash: "5a9ea7744f3204342fa8d8252daaf9f40fdca16b8fa6b6b8a5b1535ed86d63ae",
      replacementsHash: "7484bdc1477ff1a76dcf935df971e94c7be2f803ab4c959244a0c7e7dd66e709",
      parentRecoveryEvidenceHash: "f89e028e1b52502b23762ba467747b4a6726e1fb22003d85744c0e4afb6132ff",
    });
    const pinned = q20ExactRecoveryParent5577054(q43LiveState5577054);
    const corrected = applyAllowlistedProblemManualCorrection(
      "ebsi:5577054",
      spec.sourceHash,
      pinned.failed.question,
    );
    expect(canonicalEvidenceHash(corrected))
      .toBe("1536c1c410f642b57e47a46f7968ae3bd6a7586ee4afaf3a3c99ff0d22aec04c");
    expect(canonicalEvidenceHash(corrected.question))
      .toBe("fd632e833b8b4d4d0f21b0f17f0fa42823c7acbefbe2814dd091be61c8d02785");
    for (const token of [
      "[16 ~ 20] 다음을 읽고 물음에 답하시오.",
      "소비자 잉여는 소비자에게, 생산자 잉여는 생산자에게 혜택이 될 수 있다.",
      "놀이 기구를 이용할 소비자가 있다면", "한계 비용*과 한계 수입*",
      "<그림>과 같은 독점 시장", "$P_m\\alpha A$", "가격은 높다.",
      "20. ⓐ와 바꿔 쓰기에 적절한 것은?",
    ]) expect(corrected.question).toContain(token);
    expect(corrected.question).not.toContain("다음 문맥에서");
    expect(corrected.question).not.toContain("상품이 시장에서 거래될 때에 소비자에게, 생산자에게");
    expect(corrected.question).not.toContain("가격이 비싸, 따라서");
    expect(corrected.figure).toBe(true);
    expect(corrected.figure_description).toContain("세로축 위쪽 점은 α, 아래쪽 점은 β");
    expect(corrected.figure_description).toContain("Q_m·Q_c에는 수직 점선");
    expect(corrected.choices).toEqual(pinned.failed.question.choices);
    expect(corrected.answer).toBe(pinned.failed.question.answer);

    const revisionSpec = PROBLEM_MANUAL_REVISION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q20-manual-revision-v1"
    )!;
    const sourceRevisionSpec = PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q20-manual-source-revision-v1"
    )!;
    expect({
      length: PROBLEM_MANUAL_REVISION_ALLOWLIST.length,
      allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_REVISION_ALLOWLIST),
      rowHash: canonicalEvidenceHash(revisionSpec),
      replacementHash: canonicalEvidenceHash(revisionSpec.replacement),
    }).toEqual({
      length: 29,
      allowlistHash: "d7d33cb415ed9fa39323c9acefc41e7c691875f17be9f6de87acbb574bfd2b15",
      rowHash: "46b8c9b0c1548b1409d689f49da6bd0ca3028869418b5cdb7d1385890be2d0b7",
      replacementHash: "30774b846f9b85135daf0f8c906eb8238845378c78752650683cbaa3e3dbe24d",
    });
    expect(canonicalEvidenceHash(sourceRevisionSpec))
      .toBe("0a3e4a0a826baf0093f067b97a5ceda797bda6fbcb2f0b425c483d1f525ec45f");
    const revised = applyAllowlistedProblemManualRevision(
      "ebsi:5577054",
      spec.sourceHash,
      spec.allowlistId,
      corrected,
    );
    expect(canonicalEvidenceHash(revised))
      .toBe("bb8affdba9e3175e645d985471d880e0be5aa5f90cf5bfc457d12928fa10f857");
    expect(revised.figure_description)
      .toContain("A, B, C 세 점은 각각 내부가 흰 속 빈 원(○)으로 표시되어 있다.");

    root = mkdtempSync(join(tmpdir(), "studywork-5577054-q20-manual-"));
    cpSync(q43LiveState5577054, root, { recursive: true });
    removeManualRevisionArtifacts(root, ["6:20"]);
    const input = q27FixtureInputs(root);
    const row = q20ExactRecoveryParent5577054(root);
    const calls: string[] = [];
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      expect(request.schema?.name).toBe("studywork_exam_corpus_classification");
      const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
        key: string;
        question: string;
        figure_description: string | null;
      }>;
      expect(items).toHaveLength(1);
      calls.push(items[0].key);
      expect(canonicalEvidenceHash(items[0].question))
        .toBe("fd632e833b8b4d4d0f21b0f17f0fa42823c7acbefbe2814dd091be61c8d02785");
      expect(items[0].question).toContain("생산자 잉여는 생산자에게 혜택이 될 수 있다.");
      expect(items[0].figure_description).toContain("세로축 위쪽 점은 α, 아래쪽 점은 β");
      const first = calls.length === 1;
      if (first) expect(items[0].figure_description).toContain("A, B, C 세 점은 각각 내부가 흰 속 빈 원(○)");
      else expect(items[0].figure_description).not.toContain("속 빈 원");
      return { text: JSON.stringify([{
        key: "6:20",
        decision: "accept",
        canonical_subject: "korean_reading",
        curriculum_course: "독서와 작문",
        domain: first ? "맥락적 어휘 의미 이해" : "문맥을 활용한 어휘 의미 이해",
        achievement_codes: ["12독작01-03"],
        confidence: 0.99,
        reason_codes: first
          ? ["SINGLE_TARGET_KOREAN_READING", "CONTEXTUAL_VOCABULARY", "SOURCE_PIXEL_MATCH", "COMPLETE_SHARED_PASSAGE"]
          : ["SOURCE_EXACT", "CONTEXTUAL_VOCABULARY"],
        transcription_status: "exact",
        transcription_evidence: first
          ? "원본 5~6쪽의 [16~20] 공통 지문 전체, ㉠·㉡·ⓐ, 두 각주, 수식과 기호, 20번 발문 및 " +
            "다섯 선택지가 모두 일치한다. 그래프 설명도 α·β, 속 빈 A·B·C, P_m·P_c·Q_m·Q_c, " +
            "세 곡선과 점선의 위치 관계를 원본대로 보존한다."
          : "공식 5~6쪽의 [16~20] 전체 지문·공유 그래프·20번 발문과 선택지가 일치한다.",
      }]) };
    });
    const run = () => adjudicateProblemManual(
      input.entry,
      input.problem,
      root,
      row.failed,
      row.parent,
    );
    const completed = await run();
    expect(calls).toEqual(["6:20", "6:20"]);
    expect(canonicalEvidenceHash(completed.classified.question))
      .toBe("1536c1c410f642b57e47a46f7968ae3bd6a7586ee4afaf3a3c99ff0d22aec04c");
    expect(completed.classified.question.figure_description).not.toContain("속 빈 원");
    const verified = withOnlyManualArtifactsForKey(root, "6:20", () =>
      verifyProblemManualAdjudicationForTest({
        stateDir: root,
        entry: input.entry,
        problemEvidence: input.problem,
        parentRecovery: row.parent as unknown as Record<string, unknown>,
        failedQuestion: row.failed.question,
        failedClassification: row.failed.classification,
        manualAdjudication: completed.evidence,
      })) as { question: QuizItemEx; classification: ClassificationDecision };
    expect(canonicalEvidenceHash(verified.question))
      .toBe("1536c1c410f642b57e47a46f7968ae3bd6a7586ee4afaf3a3c99ff0d22aec04c");
    expect(verified.classification.transcription_status).toBe("exact");
    const stable = stateSnapshot(root);
    await run();
    expect(calls).toEqual(["6:20", "6:20"]);
    expect(stateSnapshot(root)).toEqual(stable);

    const problemPath = join(root, completed.evidence.revision!.problemArtifact.path);
    const problemBytes = readFileSync(problemPath);
    writeFileSync(problemPath, Buffer.concat([problemBytes, Buffer.from(" ")]));
    const beforeTamper = stateSnapshot(root);
    await expect(run()).rejects.toThrow(/hash|canonical|envelope|allowlist/u);
    expect(calls).toEqual(["6:20", "6:20"]);
    expect(stateSnapshot(root)).toEqual(beforeTamper);
  }, 180_000);

  it.skipIf(!existsSync(join(q43LiveState5577054, "problem.pdf")))(
    "pins, writes, and verifies the source-exact 5577054 Q21 shared passage",
    async () => {
    const spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q21-manual-v1"
    )!;
    expect({
      length: PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.length,
      allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST),
      rowHash: canonicalEvidenceHash(spec),
      replacementsHash: canonicalEvidenceHash(spec.replacements),
      parentRecoveryEvidenceHash: spec.parentRecoveryEvidenceHash,
    }).toEqual({
      length: 91,
      allowlistHash: "3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219",
      rowHash: "41404dacd564049316497afc6ff33311c02e8989cc6329378b98bfa261c13fc9",
      replacementsHash: "27b2bc2c01c3837febcdbfaed92c09cfb3c4b3da50bf174d276c6f93a8a8a5c0",
      parentRecoveryEvidenceHash: "7935a025654eb7b4224af107fc29e149190d2b76f775a33194b3ae3b7665251e",
    });
    const pinned = q21ExactRecoveryParent5577054(q43LiveState5577054);
    const corrected = applyAllowlistedProblemManualCorrection(
      "ebsi:5577054",
      spec.sourceHash,
      pinned.failed.question,
    );
    expect(canonicalEvidenceHash(corrected))
      .toBe("ab83f6a5d5e188f11c8f0f585ed05a9ca51a70ef63732b89bad063fd6dfbedca");
    expect(canonicalEvidenceHash(corrected.question))
      .toBe("0d0b8d693a00ea77d76499bd35ad6814e903c026ac5f83f70f8be7ab7d93288e");
    for (const token of [
      "[21 ~ 23] 다음을 읽고 물음에 답하시오.", "서 있 바위 유정하여 보이다",
      "직립불의(直立不倚)", "고모진태(古貌眞態)* 벗 삼아 안시니",
      "왕기순인(枉己循人)*야 내 어 옮아가리오", "｢ 입암이십구곡 ｣",
      "흉중엔 무한한(無限恨)인 채 임종하시고 만", "천도형의 연적",
      "고인과 고락을 같이한", "비단옷을 입고 수족이 험한 사람처럼",
      "대혜보각사의 ｢ 서장(書狀) ｣", "제 눈이 불급하는 것을",
      "직업적이어선 취미도", "21. (가)와 (나)의 공통점으로 적절한 것은?",
    ]) expect(corrected.question).toContain(token);
    for (const stale of [
      "보이는다", "직립불의(直立不倚)", "입암십이곡", "엄중하시고 만",
      "전도형의 연적", "고의고담", "너무 치고(至巧)", "지식적이어선",
    ]) expect(corrected.question).not.toContain(stale);
    expect(corrected.choices?.[0]).toBe("① 지나온 삶에 대한 회한이 나타나 있다.");
    expect(corrected.answer).toBe(pinned.failed.question.answer);
    expect(corrected.figure).toBe(false);

    const revisionSpec = PROBLEM_MANUAL_REVISION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q21-manual-revision-v1"
    )!;
    expect({
      length: PROBLEM_MANUAL_REVISION_ALLOWLIST.length,
      allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_REVISION_ALLOWLIST),
      rowHash: canonicalEvidenceHash(revisionSpec),
      replacementHash: canonicalEvidenceHash(revisionSpec.replacement),
    }).toEqual({
      length: 29,
      allowlistHash: "d7d33cb415ed9fa39323c9acefc41e7c691875f17be9f6de87acbb574bfd2b15",
      rowHash: "07ab54dc62ff0c4bd31034f7b96b1a491215108793e8d5eb7ad0780bd0da75fe",
      replacementHash: "c41df3c34a50bc440182e63e8d07faa4a0f2f4897e5e534c3b677a94194ef12e",
    });
    const revised = applyAllowlistedProblemManualRevision(
      "ebsi:5577054",
      spec.sourceHash,
      spec.allowlistId,
      corrected,
    );
    expect(canonicalEvidenceHash(revised))
      .toBe("f815bfabb5c9a586a55b342b9f55b7a813e6525cf8c85746e2ae9b621ffc1bd0");
    expect(canonicalEvidenceHash(revised.question))
      .toBe("5db1a7651f12e0835afccfd45c2b1c494f4f9150deb9d9327bff180b704852c1");
    expect(revised.question).toContain("오랜 세월 굳게 선 자태 고칠 적이 업다");
    expect(revised.question).not.toContain("오랜 세월 곧게 선 자태 고칠 적이 업다");

    root = mkdtempSync(join(tmpdir(), "studywork-5577054-q21-manual-"));
    cpSync(q43LiveState5577054, root, { recursive: true });
    removeManualRevisionArtifacts(root, ["7:21"]);
    const input = q27FixtureInputs(root);
    const row = q21ExactRecoveryParent5577054(root);
    const calls: string[] = [];
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      expect(request.schema?.name).toBe("studywork_exam_corpus_classification");
      const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
        key: string;
        question: string;
      }>;
      expect(items).toHaveLength(1);
      calls.push(items[0].key);
      expect(canonicalEvidenceHash(items[0].question))
        .toBe("5db1a7651f12e0835afccfd45c2b1c494f4f9150deb9d9327bff180b704852c1");
      expect(items[0].question).toContain("오랜 세월 굳게 선 자태 고칠 적이 업다");
      expect(items[0].question).toContain("왕기순인(枉己循人)*야 내 어 옮아가리오");
      expect(items[0].question).toContain("대혜보각사의 ｢ 서장(書狀) ｣");
      return { text: JSON.stringify([{
        key: "7:21",
        decision: "accept",
        canonical_subject: "korean_literature",
        curriculum_course: "문학",
        domain: "고전 시가와 현대 수필의 비교 감상",
        achievement_codes: ["12문학01-02"],
        confidence: 0.99,
        reason_codes: ["SOURCE_EXACT", "LITERARY_TEXT_COMPARISON"],
        transcription_status: "exact",
        transcription_evidence: "공식 7쪽의 [21~23] 공통 지문, 21번 발문과 다섯 선택지가 일치한다.",
      }]) };
    });
    const run = () => adjudicateProblemManual(
      input.entry,
      input.problem,
      root,
      row.failed,
      row.parent,
    );
    const completed = await run();
    expect(calls).toEqual(["7:21"]);
    expect(canonicalEvidenceHash(completed.classified.question))
      .toBe("f815bfabb5c9a586a55b342b9f55b7a813e6525cf8c85746e2ae9b621ffc1bd0");
    const verified = withOnlyManualArtifactsForKey(root, "7:21", () =>
      verifyProblemManualAdjudicationForTest({
        stateDir: root,
        entry: input.entry,
        problemEvidence: input.problem,
        parentRecovery: row.parent as unknown as Record<string, unknown>,
        failedQuestion: row.failed.question,
        failedClassification: row.failed.classification,
        manualAdjudication: completed.evidence,
      })) as { question: QuizItemEx; classification: ClassificationDecision };
    expect(canonicalEvidenceHash(verified.question))
      .toBe("f815bfabb5c9a586a55b342b9f55b7a813e6525cf8c85746e2ae9b621ffc1bd0");
    expect(verified.classification.transcription_status).toBe("exact");
    const stable = stateSnapshot(root);
    await run();
    expect(calls).toEqual(["7:21"]);
    expect(stateSnapshot(root)).toEqual(stable);

    const problemPath = join(root, completed.evidence.revision!.problemArtifact.path);
    const problemBytes = readFileSync(problemPath);
    writeFileSync(problemPath, Buffer.concat([problemBytes, Buffer.from(" ")]));
    const beforeTamper = stateSnapshot(root);
    await expect(run()).rejects.toThrow(/hash|canonical|envelope|allowlist/u);
    expect(calls).toEqual(["7:21"]);
    expect(stateSnapshot(root)).toEqual(beforeTamper);
  }, 180_000);

  it.skipIf(!existsSync(join(q43LiveState5577054, "problem.pdf")))(
    "pins, writes, and verifies the source-exact 5577054 Q22 shared passage",
    async () => {
    const spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q22-manual-v1"
    )!;
    expect({
      length: PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.length,
      allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST),
      rowHash: canonicalEvidenceHash(spec),
      replacementsHash: canonicalEvidenceHash(spec.replacements),
      parentRecoveryEvidenceHash: spec.parentRecoveryEvidenceHash,
    }).toEqual({
      length: 91,
      allowlistHash: "3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219",
      rowHash: "ff64bc2933feae809301b2978bb8d59538939db172bd0076132b3cc2d1cae45d",
      replacementsHash: "5d29986633f21c495aadcc0efe1160e2de4e9b32113752ba4220744480d90d37",
      parentRecoveryEvidenceHash: "296ac6cdf488ca3081168adf9e798dd31763df6bbc3d30c57e552f3c05b3c0ee",
    });
    const pinned = q22ExactRecoveryParent5577054(q43LiveState5577054);
    const corrected = applyAllowlistedProblemManualCorrection(
      "ebsi:5577054",
      spec.sourceHash,
      pinned.failed.question,
    );
    expect(canonicalEvidenceHash(corrected))
      .toBe("53428ca35ae5bdb9ac57fa1e1ceb948ef8ac70eda7ce42aa3e47a5251b3dd9b4");
    expect(canonicalEvidenceHash(corrected.question))
      .toBe("284d905eb3036b542b5d0d30a3d99229c6bb83ec0ea50023c560156e151ca6ae");
    expect(canonicalEvidenceHash(corrected.choices))
      .toBe("88f5c3154cd7225c2fb4d7af2649f17d20fc868a4ee10e4a45644f5f1ffb5da2");
    expect(corrected.question).toMatch(/^\[21 ~ 23\]/u);
    expect(corrected.question).toContain("22. <보기>와 관련지어");
    expect(corrected.choices?.[4]).toContain("바위의 속성에 산과 물의 속성을 더해");
    expect(corrected.answer).toBe(corrected.choices?.[4]);

    const revisionSpec = PROBLEM_MANUAL_REVISION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q22-manual-revision-v1"
    )!;
    expect({
      length: PROBLEM_MANUAL_REVISION_ALLOWLIST.length,
      allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_REVISION_ALLOWLIST),
      rowHash: canonicalEvidenceHash(revisionSpec),
      replacementHash: canonicalEvidenceHash(revisionSpec.replacement),
    }).toEqual({
      length: 29,
      allowlistHash: "d7d33cb415ed9fa39323c9acefc41e7c691875f17be9f6de87acbb574bfd2b15",
      rowHash: "67e4f2c4a3c804602bff19688eedde97e80abcbc78b550bc5378e2b659ea3199",
      replacementHash: "d9d7552367512ae81c55729c41090559bd8f1c998e8e61b5e6e78b4b1261d65b",
    });
    const revised = applyAllowlistedProblemManualRevision(
      "ebsi:5577054",
      spec.sourceHash,
      spec.allowlistId,
      corrected,
    );
    expect(canonicalEvidenceHash(revised))
      .toBe("3a36a1d8419005ba398ef0af29035a2e254a0430d84685f14f3ccc357be0f058");
    expect(canonicalEvidenceHash(revised.question))
      .toBe("e031d0d704ce834ab3dfc5677e743ee64c15955d2474c18f6a56610ba0acaa94");
    expect(revised.question).toContain("(나)\n\n우리 집엔 웃어른이 아니 계시다.");
    expect(revised.question).toContain("상심낙사: 완상하는 마음과 즐거운 일.");

    root = mkdtempSync(join(tmpdir(), "studywork-5577054-q22-manual-"));
    cpSync(q43LiveState5577054, root, { recursive: true });
    removeManualRevisionArtifacts(root, ["8:22"]);
    const input = q27FixtureInputs(root);
    const row = q22ExactRecoveryParent5577054(root);
    const calls: string[] = [];
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      expect(request.schema?.name).toBe("studywork_exam_corpus_classification");
      const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
        key: string;
        question: string;
        choices: string[] | null;
      }>;
      expect(items).toHaveLength(1);
      calls.push(items[0].key);
      expect(canonicalEvidenceHash(items[0].question))
        .toBe("e031d0d704ce834ab3dfc5677e743ee64c15955d2474c18f6a56610ba0acaa94");
      expect(items[0].question).toContain("(나)\n\n우리 집엔 웃어른이 아니 계시다.");
      expect(items[0].choices?.[4]).toContain("산과 물의 속성");
      return { text: JSON.stringify([{
        key: "8:22",
        decision: "accept",
        canonical_subject: "korean_literature",
        curriculum_course: "문학",
        domain: "고전 시가의 자연 인식과 작품 감상",
        achievement_codes: ["12문학01-04"],
        confidence: 0.99,
        reason_codes: ["SOURCE_EXACT", "CLASSICAL_POETRY_INTERPRETATION"],
        transcription_status: "exact",
        transcription_evidence: "공식 7~8쪽의 [21~23] 공통 지문 전체, <보기>, 22번 발문과 선택지가 일치한다.",
      }]) };
    });
    const run = () => adjudicateProblemManual(
      input.entry,
      input.problem,
      root,
      row.failed,
      row.parent,
    );
    const completed = await run();
    expect(calls).toEqual(["8:22"]);
    expect(canonicalEvidenceHash(completed.classified.question))
      .toBe("3a36a1d8419005ba398ef0af29035a2e254a0430d84685f14f3ccc357be0f058");
    const verified = withOnlyManualArtifactsForKey(root, "8:22", () =>
      verifyProblemManualAdjudicationForTest({
        stateDir: root,
        entry: input.entry,
        problemEvidence: input.problem,
        parentRecovery: row.parent as unknown as Record<string, unknown>,
        failedQuestion: row.failed.question,
        failedClassification: row.failed.classification,
        manualAdjudication: completed.evidence,
      })) as { question: QuizItemEx; classification: ClassificationDecision };
    expect(canonicalEvidenceHash(verified.question))
      .toBe("3a36a1d8419005ba398ef0af29035a2e254a0430d84685f14f3ccc357be0f058");
    expect(verified.classification.transcription_status).toBe("exact");
    const stable = stateSnapshot(root);
    await run();
    expect(calls).toEqual(["8:22"]);
    expect(stateSnapshot(root)).toEqual(stable);

    const problemPath = join(root, completed.evidence.revision!.problemArtifact.path);
    const problemBytes = readFileSync(problemPath);
    writeFileSync(problemPath, Buffer.concat([problemBytes, Buffer.from(" ")]));
    const beforeTamper = stateSnapshot(root);
    await expect(run()).rejects.toThrow(/hash|canonical|envelope|allowlist/u);
    expect(calls).toEqual(["8:22"]);
    expect(stateSnapshot(root)).toEqual(beforeTamper);
  }, 180_000);

  it.skipIf(!existsSync(join(q43LiveState5577054, "problem.pdf")))(
    "pins, writes, and verifies the source-exact 5577054 Q23 full shared passage",
    async () => {
    const spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5577054-q23-manual-v1"
    )!;
    expect({
      length: PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.length,
      allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST),
      rowHash: canonicalEvidenceHash(spec),
      replacementsHash: canonicalEvidenceHash(spec.replacements),
      parentRecoveryEvidenceHash: spec.parentRecoveryEvidenceHash,
    }).toEqual({
      length: 91,
      allowlistHash: "3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219",
      rowHash: "a1d9adbd5a00146552f5135dc3c044c9df7702cbfccfcbbb66e3f26a9111771c",
      replacementsHash: "b2f8320f9ac229ef89ad96f0d6c6e59deed7e11ebc94144e691441e6e539763e",
      parentRecoveryEvidenceHash: "e486c77b1565458f4d68ff9df798111527610505ab2633e8809a3e71c379868a",
    });
    const pinned = q23ExactRecoveryParent5577054(q43LiveState5577054);
    const corrected = applyAllowlistedProblemManualCorrection(
      "ebsi:5577054",
      spec.sourceHash,
      pinned.failed.question,
    );
    expect(canonicalEvidenceHash(corrected))
      .toBe("d7bd3395e9b34635185b78660852d6988e3e8c589dbb7f1e9f8159ff52e51447");
    expect(canonicalEvidenceHash(corrected.question))
      .toBe("c0103cec173cbf50033ad036ecdca890d3f15924c8b07a91cf650522099db4f7");
    expect(canonicalEvidenceHash(corrected.choices))
      .toBe("cf41035be9c5665fcb3a616adb846650a46bbcc3a955dc5cba6e5220ef73fc30");
    expect(corrected.question).toMatch(/^\[21 ~ 23\]/u);
    expect(corrected.question).toContain("(가)");
    expect(corrected.question).toContain("(나)");
    expect(corrected.question).toContain("23. (나)의 ‘나’에 대한 이해로");
    expect(corrected.choices?.[4]).toContain("대혜보각사의 ｢ 서장 ｣");
    expect(corrected.answer).toBe(pinned.failed.question.answer);

    root = mkdtempSync(join(tmpdir(), "studywork-5577054-q23-manual-"));
    cpSync(q43LiveState5577054, root, { recursive: true });
    removeManualArtifacts(root, ["8:23"]);
    const input = q27FixtureInputs(root);
    const row = q23ExactRecoveryParent5577054(root);
    const calls: string[] = [];
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      expect(request.schema?.name).toBe("studywork_exam_corpus_classification");
      const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
        key: string;
        question: string;
        choices: string[] | null;
      }>;
      expect(items).toHaveLength(1);
      calls.push(items[0].key);
      expect(canonicalEvidenceHash(items[0].question))
        .toBe("c0103cec173cbf50033ad036ecdca890d3f15924c8b07a91cf650522099db4f7");
      expect(items[0].question).toContain("(가)");
      expect(items[0].question).toContain("(나)");
      expect(items[0].choices?.[4]).toContain("대혜보각사의 ｢ 서장 ｣");
      return { text: JSON.stringify([{
        key: "8:23",
        decision: "accept",
        canonical_subject: "korean_literature",
        curriculum_course: "문학",
        domain: "현대 수필의 서술자 태도와 소재의 의미",
        achievement_codes: ["12문학01-06"],
        confidence: 0.99,
        reason_codes: ["SOURCE_EXACT", "LITERARY_ESSAY_COMPREHENSION"],
        transcription_status: "exact",
        transcription_evidence: "공식 7~8쪽의 [21~23] 공통 지문 전체, 23번 발문과 선택지가 일치한다.",
      }]) };
    });
    const run = () => adjudicateProblemManual(
      input.entry,
      input.problem,
      root,
      row.failed,
      row.parent,
    );
    const completed = await run();
    expect(calls).toEqual(["8:23"]);
    expect(canonicalEvidenceHash(completed.classified.question))
      .toBe("d7bd3395e9b34635185b78660852d6988e3e8c589dbb7f1e9f8159ff52e51447");
    const verified = withOnlyManualArtifactsForKey(root, "8:23", () =>
      verifyProblemManualAdjudicationForTest({
        stateDir: root,
        entry: input.entry,
        problemEvidence: input.problem,
        parentRecovery: row.parent as unknown as Record<string, unknown>,
        failedQuestion: row.failed.question,
        failedClassification: row.failed.classification,
        manualAdjudication: completed.evidence,
      })) as { question: QuizItemEx; classification: ClassificationDecision };
    expect(canonicalEvidenceHash(verified.question))
      .toBe("d7bd3395e9b34635185b78660852d6988e3e8c589dbb7f1e9f8159ff52e51447");
    expect(verified.classification.transcription_status).toBe("exact");
    const stable = stateSnapshot(root);
    await run();
    expect(calls).toEqual(["8:23"]);
    expect(stateSnapshot(root)).toEqual(stable);

    const problemPath = join(root, completed.evidence.problemArtifact.path);
    const problemBytes = readFileSync(problemPath);
    writeFileSync(problemPath, Buffer.concat([problemBytes, Buffer.from(" ")]));
    const beforeTamper = stateSnapshot(root);
    await expect(run()).rejects.toThrow(/hash|canonical|envelope|allowlist/u);
    expect(calls).toEqual(["8:23"]);
    expect(stateSnapshot(root)).toEqual(beforeTamper);
  }, 180_000);

  it.skipIf(!existsSync(join(q31Q32LiveState, "problem.pdf")))(
    "pins and applies the source-exact 5578421 Q14 tone diagram",
    () => {
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST).toHaveLength(91);
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 48)))
      .toBe("66ff6014e0969fa9a2f13b53c9157eb8a5ca945097cba7ee1d6416cf93e0cc8d");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST))
      .toBe("3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219");
    const spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5578421-q14-manual-v1"
    )!;
    expect({
      allowlistId: spec.allowlistId,
      key: spec.key,
      rowHash: canonicalEvidenceHash(spec),
      replacementsHash: canonicalEvidenceHash(spec.replacements),
      parentRecoveryEvidenceHash: spec.parentRecoveryEvidenceHash,
    }).toEqual({
      allowlistId: "ebsi-5578421-q14-manual-v1",
      key: "5:14",
      rowHash: "94087546341d55e4056f2b2a0421a4376db3188824972abe9ab6bb2fc11a817c",
      replacementsHash: "17b4d68ff2c352af8424f360b206e2688260549354c04c6a9e05e39b678c6fd5",
      parentRecoveryEvidenceHash: "1186ce8d805522044fe8fbfba39c5c2f5529988e2000e09532c8201b30593ca1",
    });
    const row = q14ExactRecoveryParent5578421(q31Q32LiveState);
    const corrected = applyAllowlistedProblemManualCorrection(
      "ebsi:5578421",
      spec.sourceHash,
      row.failed.question,
    );
    expect(canonicalEvidenceHash(corrected))
      .toBe("0218c03170cbb7b5e03b5119d99cb1e71a14c9f4b36926893d7e0297517fee62");
    expect(corrected.question).toContain("불·휘기·픈남·ᄀᆞᆫᄇᆞᄅᆞ·매 ⓐ 아·니:뮐·ᄊᆡ");
    expect(corrected.question).not.toContain("㉠아·니:뮐·ᄊᆡ");
    expect(corrected.answer).toBe(
      "② ‘아’ 낮음 → ‘니’ 높음 → ‘뮐’ 낮게 시작하여 높아짐 → ‘ᄊᆡ’ 높음",
    );
    expect(corrected.choices?.[1]).toBe(corrected.answer);
    expect(corrected.choices?.[4]).toBe(
      "⑤ ‘아’ 낮음 → ‘니’ 낮게 시작하여 높아짐 → ‘뮐’ 높음 → ‘ᄊᆡ’ 낮게 시작하여 높아짐",
    );
    expect(corrected.figure).toBe(true);
    expect(corrected.figure_description).toContain("②는 낮음－높음－상승－높음");
    expect(corrected.figure_description).toContain("⑤는 낮음－상승－높음－상승");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_REVISION_ALLOWLIST.slice(0, 8)))
      .toBe("1e10a56d615f8323979ecfe72bccd6f8ac2b58850545ac3beb7a409344651fd6");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_REVISION_ALLOWLIST))
      .toBe("d7d33cb415ed9fa39323c9acefc41e7c691875f17be9f6de87acbb574bfd2b15");
    const revisionSpec = PROBLEM_MANUAL_REVISION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5578421-q14-manual-revision-v1"
    )!;
    expect({
      rowHash: canonicalEvidenceHash(revisionSpec),
      replacementHash: canonicalEvidenceHash(revisionSpec.replacement),
    }).toEqual({
      rowHash: "30bdb578aac86abb60471c18d06a6f5231101a46d7c3ab753a266789e2613d25",
      replacementHash: "e0266a2e3c9f7f4129877618f4d1674dea689b064fba64115527cb7ea3b5b8ed",
    });
    const revised = applyAllowlistedProblemManualRevision(
      "ebsi:5578421",
      revisionSpec.sourceHash,
      revisionSpec.parentAllowlistId,
      corrected,
    );
    expect(canonicalEvidenceHash(revised))
      .toBe("b06ec23b682071105a7103f5987efaf1e9f1ff2a0161133c774ab6004c30873b");
    expect(revised.question).toContain("- 『 용비어천가(龍飛御天歌) 』 제2장 중에서");
    expect(revised.question).not.toContain("- 「용비어천가(龍飛御天歌)」 제2장 중에서");
  });

  it.skipIf(!existsSync(join(q31Q32LiveState, "problem.pdf")))(
    "pins and applies the source-exact 5578421 Q2 discussion wording",
    () => {
    const spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5578421-q2-manual-v1"
    )!;
    const revisionSpec = PROBLEM_MANUAL_REVISION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5578421-q2-manual-revision-v1"
    )!;
    const sourceRevisionSpec = PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5578421-q2-manual-source-revision-v1"
    )!;
    const terminalSpecs = PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST.filter((candidate) =>
      candidate.entryId === "ebsi:5578421" && candidate.key === "1:2"
    );
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 49)))
      .toBe("e0ad5b176a2568251ac73625e6e1abcd857a846f2250147f99db28fa5a07d7fe");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST))
      .toBe("3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219");
    expect({
      rowHash: canonicalEvidenceHash(spec),
      replacementsHash: canonicalEvidenceHash(spec.replacements),
      triggerHash: canonicalEvidenceHash(spec.terminalTrigger),
      parentRecoveryEvidenceHash: spec.parentRecoveryEvidenceHash,
    }).toEqual({
      rowHash: "d5bb10bb3abb82af482a85fd00fadca842c18286e4d06d77b93ee311f204767c",
      replacementsHash: "90e41ab9bc78e737301960082df32ae7a4bbc0b312a673baaf0d91193649be8e",
      triggerHash: "e24c26d81a7d288ef6a44abe4e1ed3cdecb61e22fdc8a40aabf34b9b58377b6b",
      parentRecoveryEvidenceHash: "c09674a75c0e93955440fe4094943cdddedaff96fc355e76620bf1b5ed86043c",
    });
    const row = q2ExactRecoveryParent5578421(q31Q32LiveState);
    const corrected = applyAllowlistedProblemManualCorrection(
      "ebsi:5578421",
      spec.sourceHash,
      row.failed.question,
    );
    expect(canonicalEvidenceHash(corrected))
      .toBe("c42349f636fc8e2637b53451fe5c0073a22f4b266bff44fd3fe7e3d742bdd77c");
    expect(canonicalEvidenceHash(corrected.question))
      .toBe("670bfc5caf3faf2a332f7e53ac3f37ad2cde7f69e380975e30c228d54e85401b");
    expect(corrected.question).toContain("최 교수께서 제기하신 문제에 대해서는");
    expect(corrected.question).toContain("비용을 줄일 수 있어서");
    expect(corrected.question).not.toContain("최 교수님께서 제기하신");
    expect(corrected.question).not.toContain("비용을 절감할 수 있어서");
    expect({
      allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_REVISION_ALLOWLIST),
      rowHash: canonicalEvidenceHash(revisionSpec),
      replacementHash: canonicalEvidenceHash(revisionSpec.replacement),
    }).toEqual({
      allowlistHash: "d7d33cb415ed9fa39323c9acefc41e7c691875f17be9f6de87acbb574bfd2b15",
      rowHash: "7fec9a6782faf9cc6e59837c3528335963319fabc58ea1b7adfaeb25651028e5",
      replacementHash: "da53d25545e236eadc2e0c064463a171d4678f640160ee3acb6be0928c805770",
    });
    const revised = applyAllowlistedProblemManualRevision(
      "ebsi:5578421",
      spec.sourceHash,
      spec.allowlistId,
      corrected,
    );
    expect(canonicalEvidenceHash(revised))
      .toBe("85fffcf17b1e2ca69ab3ef773c17dcd16883e04ba7e1225761634a8ac05eaccf");
    expect(canonicalEvidenceHash(revised.question))
      .toBe("ed9dbe1c783272251a4c45220bfa983cb705fa40d1eff4ebd6aef7ddcd860c46");
    expect(revised.question.startsWith("[1~3] 다음은 라디오 대담의 일부이다.")).toBe(true);
    expect({
      allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST),
      rowHash: canonicalEvidenceHash(sourceRevisionSpec),
      replacementHash: canonicalEvidenceHash(sourceRevisionSpec.replacement),
      triggerHash: canonicalEvidenceHash(sourceRevisionSpec.terminalTrigger),
    }).toEqual({
      allowlistHash: "b8819b943244e1b3e6aaf2a8c48fb8509ee8df8c4b76cd7efa799cd5caef59ac",
      rowHash: "99ec8e696ea73ba0c61d31df0df9f657bcb29e62fa6ff43e8db1389542e821aa",
      replacementHash: "b0751915ae3df15620b51fcbccf08d95e0b29abb6edc28c8ae68333a4bbbe90a",
      triggerHash: "240e0e1d3617c2d0de839ea55687ed7efb658037c62d4608f934c3426cfd4704",
    });
    const sourceRevised = applyAllowlistedProblemManualSourceRevision(
      "ebsi:5578421",
      spec.sourceHash,
      revisionSpec.allowlistId,
      revised,
    );
    expect(canonicalEvidenceHash(sourceRevised))
      .toBe("b3d4ca3602e31cff626c4f461c2f4929adf8be4ee5ad0b31f9a73c789780cd30");
    expect(sourceRevised.question).toContain("최 교수님께서 제기하신 문제에 대해서는");
    expect({
      allowlistHash: canonicalEvidenceHash(PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST),
      prefixHash: canonicalEvidenceHash(PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST.slice(0, 5)),
      rows: terminalSpecs.map((candidate) => ({
        allowlistId: candidate.allowlistId,
        parentManualRevisionAllowlistId: candidate.parentManualRevisionAllowlistId,
        failedEffectiveCorpusHash: candidate.failedEffectiveCorpusHash,
        rowHash: canonicalEvidenceHash(candidate),
      })),
    }).toEqual({
      allowlistHash: "c9531cd68143e9c3a7c7a34ec93cf018cf8ff5b0cf52b482d83717317095589a",
      prefixHash: "e4601a183669f046f4cc1f52cd30a860fe6347f96ffa41b30bdc8db2123630b3",
      rows: [{
        allowlistId: "ebsi-5578421-q2-terminal-fidelity-v1",
        parentManualRevisionAllowlistId: "ebsi-5578421-q2-manual-revision-v1",
        failedEffectiveCorpusHash: "98e42386fc739dc7764f13da3ef3bccfcd1bfe908cd2e1d5da8f8af0443ab51f",
        rowHash: "87df1415a54e290dfabd9f3ec68c837ac9f42a2786d4fdc2a80bb81a7dabee2a",
      }, {
        allowlistId: "ebsi-5578421-q2-terminal-fidelity-v2",
        parentManualRevisionAllowlistId: "ebsi-5578421-q2-manual-source-revision-v1",
        failedEffectiveCorpusHash: "89315957b0a571851f1fe43ed52d9751e050c7009307b1ec8d90ba87047dea99",
        rowHash: "de557e5cba2fcef89f669b19d22433ddc661664e029c38bd9641e72d4f4fd131",
      }, {
        allowlistId: "ebsi-5578421-q2-terminal-fidelity-v3",
        parentManualRevisionAllowlistId: "ebsi-5578421-q2-manual-source-revision-v1",
        failedEffectiveCorpusHash: "54b563c6ea850bce015a99000baa61b2b6ff193d11a7fe155649a8e7e4cc0ae8",
        rowHash: "f9d145d7a551ee1ff200ee9b109f8b539493f7cea129b0d702afa3fe3ecc035e",
      }, {
        allowlistId: "ebsi-5578421-q2-terminal-fidelity-v4",
        parentManualRevisionAllowlistId: "ebsi-5578421-q2-manual-source-revision-v1",
        failedEffectiveCorpusHash: "272dbc34871780d5cd01399234857b08635b9545a1ca3751dca142218af72793",
        rowHash: "bb0dbf05d173c07dcfc179a71cf264fce157b3bcd3809ed49e9fc7135cb015ff",
      }],
    });
    expect(terminalSpecs[1].pinnedAdjudicationArtifact).toEqual({
      path: "problem-terminal-fidelity-adjudications/" +
        "v1-0001-0002-5a601aa2ef79f13797e092f25479d5432df7d7cd984f6e346e9c8536866ed648.json",
      sha256: "75ef0affae2d3d4673b7daa85ac3dcf7fcac61decac6406b0c285e5cd5d9853d",
      itemHash: "603d5f6bebb158c51dbefdf0181c220b62b02b72ad9aabb47d605ea2cd409ded",
    });
    expect(terminalSpecs[2].pinnedAdjudicationArtifact).toEqual({
      path: "problem-terminal-fidelity-adjudications/" +
        "v1-0001-0002-da24540497a5265e01c00e114ca03663bcfec7c4a5a2a974add0e65d190de50b.json",
      sha256: "33a4e122c6e9194706f1aedaba7cb092f5b15df3dbe5dec02a3031e8ecf0e5bc",
      itemHash: "bf99e5d27f9226bcb06e448633241d5f84e798b0f93c00f4265da5285f5d1210",
    });
    expect(terminalSpecs[3].pinnedAdjudicationArtifact).toEqual({
      path: "problem-terminal-fidelity-adjudications/" +
        "v1-0001-0002-ec73f987990bfcb3dbddb90aba012379e3cbedd44cfb79755a3c4b5a8032e9ca.json",
      sha256: "2074a808f4c1d90ace8b9d8fce4f529a73c0e9a5fb6eadd22e327be335bc8365",
      itemHash: "a6dbd6b38ebb3cff581d75c4ddb452aa1f4cbec6199dce7b2cb055536895213e",
    });
  });

  it.skipIf(!existsSync(join(q31Q32LiveState, "problem.pdf")))(
    "pins and applies the source-exact 5578421 Q3 board wording",
    () => {
    const spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5578421-q3-manual-v1"
    )!;
    expect({
      length: PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.length,
      prefixHash: canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 50)),
      allowlistHash: canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST),
      rowHash: canonicalEvidenceHash(spec),
      replacementsHash: canonicalEvidenceHash(spec.replacements),
      triggerHash: canonicalEvidenceHash(spec.terminalTrigger),
      parentRecoveryEvidenceHash: spec.parentRecoveryEvidenceHash,
    }).toEqual({
      length: 91,
      prefixHash: "36c3b798d248e5fe13a0790cd1d6ae1bcac55a83f1b90856d1d93645648e4de7",
      allowlistHash: "3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219",
      rowHash: "84b4d3f2c2606efea15cfbbca0f6d15d2da56b1c78112283403472f996c6bc5d",
      replacementsHash: "3331c3f24153b9909c99169ccbfa72d8a3a4cf9771d8eb4b4d64eff059bfde49",
      triggerHash: "b26a8f937c864fd8f20ea7aee6fa38c55d03e1cd2f87051c87942fc9d3edc0cd",
      parentRecoveryEvidenceHash: "fd585d64392d492db3840b3a75bd480748fe0ae6b7b22cf99982f59303edc4a0",
    });
    const terminalSpec = PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5578421-q3-terminal-fidelity-v1"
    )!;
    expect({
      rowHash: canonicalEvidenceHash(terminalSpec),
      parentQuestionHash: terminalSpec.parentQuestionHash,
      parentClassificationHash: terminalSpec.parentClassificationHash,
      failedEffectiveCorpusHash: terminalSpec.failedEffectiveCorpusHash,
    }).toEqual({
      rowHash: "9fd89f45d0e8b1793acddf8bc1f364b4715eafba79c9d118fc86597dfb2c523e",
      parentQuestionHash: "79b440a0c4d927fdc530c2e37e5ed4f6095db27a97396a97cd9d925f078d1c34",
      parentClassificationHash: "abec36f81d33161810a02d25628c67006098de65dc90542361f6ab8b2b23b938",
      failedEffectiveCorpusHash: "54b563c6ea850bce015a99000baa61b2b6ff193d11a7fe155649a8e7e4cc0ae8",
    });
    expect(terminalSpec.pinnedAdjudicationArtifact).toEqual({
      path: "problem-terminal-fidelity-adjudications/" +
        "v1-0001-0003-6b1e07bfc35464812fef18a72617a6c9f833ad2d17c590b4c7547340558a48b1.json",
      sha256: "35c9820556d3fe993cd2d38ac9054a41a9828f15ed2cfbb9b758a37a1f222211",
      itemHash: "9ed0e60500801fff8c5b339b8421e5459a0056b44f65c83434f228ed8f486556",
    });
    const nextTerminalSpec = PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5578421-q3-terminal-fidelity-v2"
    )!;
    expect({
      rowHash: canonicalEvidenceHash(nextTerminalSpec),
      failedEffectiveCorpusHash: nextTerminalSpec.failedEffectiveCorpusHash,
    }).toEqual({
      rowHash: "723205f50a1e518e7593e9426d2b1898b09f5b91f03a6d70a8a426fadac7b262",
      failedEffectiveCorpusHash: "272dbc34871780d5cd01399234857b08635b9545a1ca3751dca142218af72793",
    });
    expect(nextTerminalSpec.pinnedAdjudicationArtifact).toEqual({
      path: "problem-terminal-fidelity-adjudications/" +
        "v1-0001-0003-c52f4b937e0aa9c30d004b2e41449d3b74ab30b3f4815ce6c0e6c1dd8681b914.json",
      sha256: "14aed3774e7df30832fc75bae72cd2070215e8c22a093a435672a41b78edb478",
      itemHash: "50d7844453708c1499cdb1fc8f09e0012f9f51c1200312b64a916c3c5a39c07b",
    });
    const row = q3ExactRecoveryParent5578421(q31Q32LiveState);
    const corrected = applyAllowlistedProblemManualCorrection(
      "ebsi:5578421",
      spec.sourceHash,
      row.failed.question,
    );
    expect(canonicalEvidenceHash(corrected))
      .toBe("79b440a0c4d927fdc530c2e37e5ed4f6095db27a97396a97cd9d925f078d1c34");
    expect(corrected.question).toContain("동전 없는 사회를 실현한 나라들도 있습니다.");
    expect(corrected.question).toContain("그러면 김 과장님, 최 교수님께서 제기하신 문제에 대해서는");
    expect(corrected.question).not.toContain("실현한 나라도 있습니다.");
    expect(corrected.question).not.toContain("그런데 김 과장님");
    expect(corrected.choices?.[1]).toBe("② [이게머니] 동전이 없으면 거스름돈은 어떻게 받나요?");
    expect(corrected.figure_description).toContain("[경제1등], [이게머니], [거스름돈]");
    expect(corrected.answer).toBe(row.failed.question.answer);
  });

  it.skipIf(!existsSync(join(q31Q32LiveState, "problem.pdf")))(
    "selects, writes, and replays the second source-exact 5578421 Q3 recovery",
    async () => {
    const spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5578421-q3-manual-v2"
    )!;
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST).toHaveLength(91);
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 53)))
      .toBe("0ccd51016dcfc75b0fe1e9f5ed88216b02aa305911b232a9f7f90eb68cc6544c");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST))
      .toBe("3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219");
    expect({
      rowHash: canonicalEvidenceHash(spec),
      replacementsHash: canonicalEvidenceHash(spec.replacements),
      parentRecoveryEvidenceHash: spec.parentRecoveryEvidenceHash,
    }).toEqual({
      rowHash: "19f644e345b0cf31411eccad2fe6f9569378a89427f9e1e3285bf12c57545a61",
      replacementsHash: "c7b05841ac72ee461dd73897e5b0421c5daeffaae1f1c23ff0b712f287844d07",
      parentRecoveryEvidenceHash: "b2a2d24967a85e0dca3a6042d2fec44a4950e00c4c9b05beb6d07bd6b009f7a8",
    });
    const pinned = q3ExactRecoveryParentV2_5578421(q31Q32LiveState);
    const corrected = applyAllowlistedProblemManualCorrection(
      "ebsi:5578421",
      spec.sourceHash,
      pinned.failed.question,
    );
    expect(canonicalEvidenceHash(corrected))
      .toBe("2bed2f68fb0acf13e9a3ac5040e2074d004e332dafb9c9037ec8104074b41f9b");
    expect(canonicalEvidenceHash(corrected.question))
      .toBe("cfe6baeade037b4a96a2494a922c4f4d1f608420f80619a160933da7cafbb4c1");
    expect(corrected.question).toContain("[1~3] 다음은 라디오 대담의 일부이다.");
    expect(corrected.question).toContain("최 교수님께서 제기하신 문제에 대해서는");
    expect(corrected.question).toContain("비용을 줄일 수 있어서");
    expect(corrected.question).toContain("\n\n3. 대담의 진행자가 선정할 추가 질문");
    expect(corrected.figure_description).toContain("각 게시물 오른쪽에는 ①부터 ⑤까지");

    root = mkdtempSync(join(tmpdir(), "studywork-5578421-q3-manual-v2-"));
    cpSync(q31Q32LiveState, root, { recursive: true });
    removeManualGenerationArtifacts(root, "ebsi-5578421-q3-manual-v2");
    expect(readdirSync(join(root, "problem-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0001-0003-"))).toHaveLength(1);
    const input = q27FixtureInputs(root);
    const row = q3ExactRecoveryParentV2_5578421(root);
    const calls: string[] = [];
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      expect(request.schema?.name).toBe("studywork_exam_corpus_classification");
      const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
        key: string;
        question: string;
        figure_description: string | null;
      }>;
      expect(items).toHaveLength(1);
      calls.push(items[0].key);
      expect(canonicalEvidenceHash(items[0].question))
        .toBe("cfe6baeade037b4a96a2494a922c4f4d1f608420f80619a160933da7cafbb4c1");
      expect(items[0].figure_description).toContain("각 게시물 오른쪽에는 ①부터 ⑤까지");
      return { text: JSON.stringify([{
        key: "1:3",
        decision: "reject",
        canonical_subject: null,
        curriculum_course: null,
        domain: null,
        achievement_codes: [],
        confidence: 0.99,
        reason_codes: ["SOURCE_EXACT", "OUT_OF_SCOPE_SPEAKING_LISTENING"],
        transcription_status: "exact",
        transcription_evidence: "공식 1쪽 [1~3] 대담, 3번 발문, 공지와 게시판이 모두 일치한다.",
      }]) };
    });
    const run = () => adjudicateProblemManual(input.entry, input.problem, root, row.failed, row.parent);
    const completed = await run();
    expect(calls).toEqual(["1:3"]);
    expect(canonicalEvidenceHash(completed.classified.question))
      .toBe("2bed2f68fb0acf13e9a3ac5040e2074d004e332dafb9c9037ec8104074b41f9b");
    const stable = stateSnapshot(root);
    await run();
    expect(calls).toEqual(["1:3"]);
    expect(stateSnapshot(root)).toEqual(stable);

    const problemPath = join(root, completed.evidence.problemArtifact.path);
    const problemBytes = readFileSync(problemPath);
    writeFileSync(problemPath, Buffer.concat([problemBytes, Buffer.from(" ")]));
    const beforeTamper = stateSnapshot(root);
    await expect(run()).rejects.toThrow(/hash|canonical|envelope|allowlist/u);
    expect(calls).toEqual(["1:3"]);
    expect(stateSnapshot(root)).toEqual(beforeTamper);
  }, 180_000);

  it.skipIf(!existsSync(join(q31Q32LiveState, "problem.pdf")))(
    "pins and replays the source-exact 5578421 Q12 grammar table",
    async () => {
    const spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5578421-q12-manual-v1"
    )!;
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 51)))
      .toBe("8377e380ffebc05e5e74bcf04896ff495c93630378b30f2051cc5c2e896c9e23");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST))
      .toBe("3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219");
    expect({
      rowHash: canonicalEvidenceHash(spec),
      replacementsHash: canonicalEvidenceHash(spec.replacements),
      parentRecoveryEvidenceHash: spec.parentRecoveryEvidenceHash,
    }).toEqual({
      rowHash: "024132dc5e89e982054fd889aa4b53364425af85c6e947e53e220ed924d18645",
      replacementsHash: "d60e37bd3a376cce498db0378b60f199255276496a69fac1662446ed80780693",
      parentRecoveryEvidenceHash: "2cec6cbd5de6b7795867c7b1897ce4c7dd35adbbc34e6be17f445e060dee9207",
    });
    const pinned = q12ExactRecoveryParent5578421(q31Q32LiveState);
    const corrected = applyAllowlistedProblemManualCorrection(
      "ebsi:5578421",
      spec.sourceHash,
      pinned.failed.question,
    );
    expect(canonicalEvidenceHash(corrected))
      .toBe("c6459fb8755e7e48af2c74ac051ce62ebc8413f1b2a9c2192cd78996cd0fea47");
    expect(canonicalEvidenceHash(corrected.question))
      .toBe("b4a185b004dfc82b136c7fb7753c0b31f25e8adf67317edfe9632420c8c0cc58");
    expect(canonicalEvidenceHash(corrected.figure_description))
      .toBe("6c31f0e0518f45ff0759f373879ba30162acb668de721083aba5ee2530dbb3b3");
    expect(corrected.question).toContain("관형어는 체언을, 부사어는 용언을 한정하는 기능을 함.");
    expect(corrected.question).not.toContain("관형어는 체언을, 부사는 용언을 한정하는 기능을 함.");
    expect(corrected.answer).toBe(pinned.failed.question.answer);
    expect(corrected.choices).toEqual(pinned.failed.question.choices);

    root = mkdtempSync(join(tmpdir(), "studywork-5578421-q12-manual-"));
    cpSync(q31Q32LiveState, root, { recursive: true });
    const input = q27FixtureInputs(root);
    const row = q12ExactRecoveryParent5578421(root);
    providerMock.complete.mockRejectedValue(new Error("unexpected Q12 replay provider"));
    const run = () => adjudicateProblemManual(
      input.entry,
      input.problem,
      root,
      row.failed,
      row.parent,
    );
    const completed = await run();
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(canonicalEvidenceHash(completed.classified.question))
      .toBe("c6459fb8755e7e48af2c74ac051ce62ebc8413f1b2a9c2192cd78996cd0fea47");
    expect(completed.classified.classification).toEqual(expect.objectContaining({
      key: "4:12",
      decision: "reject",
      canonical_subject: null,
      transcription_status: "exact",
    }));
    const stable = stateSnapshot(root);
    await run();
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(stable);

    const problemPath = join(root, completed.evidence.problemArtifact.path);
    const problemBytes = readFileSync(problemPath);
    writeFileSync(problemPath, Buffer.concat([problemBytes, Buffer.from(" ")]));
    const beforeTamper = stateSnapshot(root);
    await expect(run()).rejects.toThrow(/hash|canonical|envelope|allowlist/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(beforeTamper);
  }, 120_000);

  it.skipIf(!existsSync(join(q31Q32LiveState, "problem.pdf")))(
    "writes and replays the source-exact 5578421 Q43 shared passage",
    async () => {
    const spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5578421-q43-manual-v1"
    )!;
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST).toHaveLength(91);
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 52)))
      .toBe("d33bde802507edbe74051f14a89b6182714cbc675f3838d0245a91f405562a87");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST))
      .toBe("3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219");
    expect({
      rowHash: canonicalEvidenceHash(spec),
      replacementsHash: canonicalEvidenceHash(spec.replacements),
      parentRecoveryEvidenceHash: spec.parentRecoveryEvidenceHash,
    }).toEqual({
      rowHash: "c6937a3be30deaf2d7e9f9bad31abacae6513f4a8b9815e2a06adb2f8ec5c6f3",
      replacementsHash: "82767a2c63ea8197bc8197bbb6062c53a4c9f876a5619dd247e455e6265a820e",
      parentRecoveryEvidenceHash: "a2fd297236204de0e51cae9b8a40192b01eafd98aea39e7e2ff83d46e5ea2ffc",
    });
    const pinned = q43ExactRecoveryParent5578421(q31Q32LiveState);
    const corrected = applyAllowlistedProblemManualCorrection(
      "ebsi:5578421",
      spec.sourceHash,
      pinned.failed.question,
    );
    expect(canonicalEvidenceHash(corrected))
      .toBe("49e6d4ac17c0aa0fe2952b9e30fd3734c9d4b0f3ae880b72e811d64aa061c676");
    expect(canonicalEvidenceHash(corrected.question))
      .toBe("80bfbfb6b31c769a54d9c52a11a83a5d8a24b22c16b2361ab041110608830eb6");
    expect(corrected.question).toContain("[43 ~ 45] 다음 글을 읽고 물음에 답하시오.");
    expect(corrected.question).toContain("㉠ 유리(琉璃)에 차고 슬픈 것이 어린거린다.");
    expect(corrected.question).toContain("열없이 붙어서서 입김을 흐리우니");
    expect(corrected.question).toContain("길들은 양 언 날개를 파다거린다.");
    expect(corrected.question).toContain("아아, 너는 산(山)ㅅ새처럼 날러갔구나!");
    expect(corrected.question).toContain("푸른 날개를 마악 펴들고 있다");
    expect(corrected.question).not.toContain("어른거린다.");
    expect(corrected.question).not.toContain("파닥거린다.");
    expect(corrected.question).not.toContain("날려갔구나!");
    expect(corrected.choices).toEqual(pinned.failed.question.choices);
    expect(corrected.answer).toBe(pinned.failed.question.answer);

    root = mkdtempSync(join(tmpdir(), "studywork-5578421-q43-manual-"));
    cpSync(q31Q32LiveState, root, { recursive: true });
    removeManualArtifacts(root, ["16:43"]);
    const input = q27FixtureInputs(root);
    const row = q43ExactRecoveryParent5578421(root);
    const calls: string[] = [];
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      expect(request.schema?.name).toBe("studywork_exam_corpus_classification");
      const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
        key: string;
        question: string;
      }>;
      expect(items).toHaveLength(1);
      calls.push(items[0].key);
      expect(canonicalEvidenceHash(items[0].question))
        .toBe("80bfbfb6b31c769a54d9c52a11a83a5d8a24b22c16b2361ab041110608830eb6");
      return { text: JSON.stringify([{
        key: "16:43",
        decision: "accept",
        canonical_subject: "korean_literature",
        curriculum_course: "문학",
        domain: "현대시의 표현 방식과 작품 간 비교 감상",
        achievement_codes: ["12문학01-02"],
        confidence: 0.99,
        reason_codes: ["SOURCE_EXACT", "IN_SCOPE_KOREAN_LITERATURE"],
        transcription_status: "exact",
        transcription_evidence: "공식 15~16쪽의 [43~45] 공통 시, 43번 발문과 선택지가 일치한다.",
      }]) };
    });
    const run = () => adjudicateProblemManual(
      input.entry,
      input.problem,
      root,
      row.failed,
      row.parent,
    );
    const completed = await run();
    expect(calls).toEqual(["16:43"]);
    expect(canonicalEvidenceHash(completed.classified.question))
      .toBe("49e6d4ac17c0aa0fe2952b9e30fd3734c9d4b0f3ae880b72e811d64aa061c676");
    expect(completed.classified.classification).toEqual(expect.objectContaining({
      key: "16:43",
      decision: "accept",
      canonical_subject: "korean_literature",
      transcription_status: "exact",
    }));
    const stable = stateSnapshot(root);
    await run();
    expect(calls).toEqual(["16:43"]);
    expect(stateSnapshot(root)).toEqual(stable);

    const problemPath = join(root, completed.evidence.problemArtifact.path);
    const problemBytes = readFileSync(problemPath);
    const tamperedProblem = JSON.parse(problemBytes.toString("utf8"));
    tamperedProblem.item.question = tamperedProblem.item.question.replace("어린거린다.", "어른거린다.");
    writeCanonicalJson(problemPath, tamperedProblem);
    const beforeTamper = stateSnapshot(root);
    await expect(run()).rejects.toThrow(/hash|canonical|envelope|allowlist/u);
    expect(calls).toEqual(["16:43"]);
    expect(stateSnapshot(root)).toEqual(beforeTamper);
  }, 180_000);

  it.skipIf(!existsSync(join(q31Q32LiveState, "problem.pdf")))(
    "writes and replays the source-exact 5578421 Q38 shared passage",
    async () => {
    const spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5578421-q38-manual-v1"
    )!;
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST).toHaveLength(91);
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 54)))
      .toBe("3f9a653666b0b3b9e3d61ee0ce29700cd68f86ea98ca148a8280a22d9ec95769");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST))
      .toBe("3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219");
    expect({
      rowHash: canonicalEvidenceHash(spec),
      replacementsHash: canonicalEvidenceHash(spec.replacements),
      parentRecoveryEvidenceHash: spec.parentRecoveryEvidenceHash,
    }).toEqual({
      rowHash: "3616144e39fa2ca271a7bb4798e537f896de4f350db7faf9251c3fe4d67f0ca2",
      replacementsHash: "35cbba8850e38a3823ce8fc7b5277d410c7db6842c1097c1fc74980014267dc9",
      parentRecoveryEvidenceHash: "fcedb565f4bb9c107733c378cef32039e458be2f33ee8ce3071eaff8297593b2",
    });
    const pinned = q38ExactRecoveryParent5578421(q31Q32LiveState);
    const corrected = applyAllowlistedProblemManualCorrection(
      "ebsi:5578421",
      spec.sourceHash,
      pinned.failed.question,
    );
    expect(canonicalEvidenceHash(corrected))
      .toBe("65b5123c09f1be751e46472803126fbb2f8243c433ac761fb3f7ebc60e302ee2");
    expect(canonicalEvidenceHash(corrected.question))
      .toBe("5f6f5359f6f52a8cd9c0069f3e05a846a4792a3d7daf610eacf282a017815c75");
    expect(corrected.question).toContain("[37 ~ 42] 다음 글을 읽고 물음에 답하시오.");
    expect(corrected.question).toContain("대추, 밤 등속의 것을 주어");
    expect(corrected.question).toContain("항려(巷閭)");
    expect(corrected.question).toContain("38. (가)를 바탕으로");
    expect(corrected.question).not.toContain("향려(若閭)");

    root = mkdtempSync(join(tmpdir(), "studywork-5578421-q38-manual-"));
    cpSync(q31Q32LiveState, root, { recursive: true });
    removeManualGenerationArtifacts(root, "ebsi-5578421-q38-manual-v1");
    const input = q27FixtureInputs(root);
    const row = q38ExactRecoveryParent5578421(root);
    const calls: string[] = [];
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      expect(request.schema?.name).toBe("studywork_exam_corpus_classification");
      const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
        key: string;
        question: string;
      }>;
      expect(items).toHaveLength(1);
      calls.push(items[0].key);
      expect(canonicalEvidenceHash(items[0].question))
        .toBe("5f6f5359f6f52a8cd9c0069f3e05a846a4792a3d7daf610eacf282a017815c75");
      return { text: JSON.stringify([{
        key: "15:38",
        decision: "accept",
        canonical_subject: "korean_literature",
        curriculum_course: "문학",
        domain: "고전 소설의 서사와 인물 형상화",
        achievement_codes: ["12문학01-02"],
        confidence: 0.99,
        reason_codes: ["SOURCE_EXACT", "IN_SCOPE_KOREAN_LITERATURE"],
        transcription_status: "exact",
        transcription_evidence: "공식 13~15쪽의 [37~42] 공통 지문과 38번 발문·선택지가 일치한다.",
      }]) };
    });
    const run = () => adjudicateProblemManual(
      input.entry,
      input.problem,
      root,
      row.failed,
      row.parent,
    );
    const completed = await run();
    expect(calls).toEqual(["15:38"]);
    expect(canonicalEvidenceHash(completed.classified.question))
      .toBe("65b5123c09f1be751e46472803126fbb2f8243c433ac761fb3f7ebc60e302ee2");
    const stable = stateSnapshot(root);
    await run();
    expect(calls).toEqual(["15:38"]);
    expect(stateSnapshot(root)).toEqual(stable);

    const problemPath = join(root, completed.evidence.problemArtifact.path);
    const problemBytes = readFileSync(problemPath);
    writeFileSync(problemPath, Buffer.concat([problemBytes, Buffer.from(" ")]));
    const beforeTamper = stateSnapshot(root);
    await expect(run()).rejects.toThrow(/hash|canonical|envelope|allowlist/u);
    expect(calls).toEqual(["15:38"]);
    expect(stateSnapshot(root)).toEqual(beforeTamper);
  }, 180_000);

  it.skipIf(!existsSync(join(q31Q32LiveState, "problem.pdf")))(
    "hydrates persisted Q12 before writing Q43 in the full 5578421 flow",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-5578421-singleton-manual-flow-"));
    cpSync(q31Q32LiveState, root, { recursive: true });
    removeManualArtifacts(root, ["16:43"]);
    const input = q27FixtureInputs(root);
    const calls: string[] = [];
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      const schema = request.schema?.name ?? "unknown";
      if (schema === "studywork_exam_corpus_classification") {
        const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{ key: string }>;
        if (items.length === 1 && items[0].key === "16:43") {
          calls.push("16:43");
          return { text: JSON.stringify([{
            key: "16:43",
            decision: "accept",
            canonical_subject: "korean_literature",
            curriculum_course: "문학",
            domain: "현대시의 표현 방식과 작품 간 비교 감상",
            achievement_codes: ["12문학01-02"],
            confidence: 0.99,
            reason_codes: ["SOURCE_EXACT", "IN_SCOPE_KOREAN_LITERATURE"],
            transcription_status: "exact",
            transcription_evidence: "공식 15~16쪽의 [43~45] 공통 시와 43번이 일치한다.",
          }]) };
        }
      }
      calls.push(schema);
      throw new Error("seeded after persisted singleton manual hydration");
    });
    const run = () => repairAndAuditOfficialAnswers(
      input.entry,
      input.problem,
      input.solution,
      root,
      input.classified,
      input.solutions
    );
    await expect(run()).rejects.toThrow("seeded after persisted singleton manual hydration");
    expect(calls[0]).toBe("16:43");
    expect(calls.length).toBeGreaterThan(1);
    const q12ProblemName = readdirSync(join(root, "problem-manual-adjudications"))
      .find((name) => name.startsWith("v1-0004-0012-"))!;
    const q43ProblemName = readdirSync(join(root, "problem-manual-adjudications"))
      .find((name) => name.startsWith("v1-0016-0043-"))!;
    expect(q12ProblemName).toBeTruthy();
    expect(q43ProblemName).toBeTruthy();

    const stable = stateSnapshot(root);
    calls.length = 0;
    providerMock.complete.mockClear();
    providerMock.complete.mockRejectedValue(new Error("seeded replay boundary"));
    await expect(run()).rejects.toThrow("seeded replay boundary");
    expect(providerMock.complete).toHaveBeenCalledTimes(1);
    expect(stateSnapshot(root)).toEqual(stable);

    const q12Path = join(root, "problem-manual-adjudications", q12ProblemName);
    const q12Bytes = readFileSync(q12Path);
    writeFileSync(q12Path, Buffer.concat([q12Bytes, Buffer.from(" ")]));
    const beforeTamper = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(run()).rejects.toThrow(/Q12|4:12|hash|canonical|envelope/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(beforeTamper);
  }, 240_000);

  it.skipIf(!existsSync(join(q31Q32LiveState, "problem.pdf")))(
    "writes and replays the 5578421 Q14 tone diagram byte-stably",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-5578421-q14-manual-"));
    cpSync(q31Q32LiveState, root, { recursive: true });
    removeManualRevisionArtifacts(root, ["5:14"]);
    const input = q27FixtureInputs(root);
    const row = q14ExactRecoveryParent5578421(root);
    const calls: string[] = [];
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      expect(request.schema?.name).toBe("studywork_exam_corpus_classification");
      const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
        key: string;
        question: string;
        figure_description: string | null;
      }>;
      expect(items).toHaveLength(1);
      const item = items[0];
      calls.push(item.key);
      expect(item.question).toContain("불·휘기·픈남·ᄀᆞᆫᄇᆞᄅᆞ·매 ⓐ 아·니:뮐·ᄊᆡ");
      expect(item.question).toContain("- 『 용비어천가(龍飛御天歌) 』 제2장 중에서");
      expect(item.figure_description).toContain("⑤는 낮음－상승－높음－상승");
      return { text: JSON.stringify([{
        key: item.key,
        decision: "reject",
        canonical_subject: null,
        curriculum_course: null,
        domain: null,
        achievement_codes: [],
        confidence: 0.99,
        reason_codes: ["SOURCE_EXACT", "OUT_OF_SCOPE_KOREAN_GRAMMAR", "MIDDLE_KOREAN_PHONOLOGY"],
        transcription_status: "exact",
        transcription_evidence: "공식 5쪽 14번의 중세 국어 표기·ⓐ·성조 도식·정답 ②가 모두 일치한다.",
      }]) };
    });
    const run = () => adjudicateProblemManual(
      input.entry,
      input.problem,
      root,
      row.failed,
      row.parent,
    );
    const completed = await run();
    expect(calls).toEqual(["5:14"]);
    expect(canonicalEvidenceHash(completed.classified.question))
      .toBe("b06ec23b682071105a7103f5987efaf1e9f1ff2a0161133c774ab6004c30873b");
    expect(completed.evidence.revision?.allowlistId)
      .toBe("ebsi-5578421-q14-manual-revision-v1");
    expect(completed.classified.classification).toEqual(expect.objectContaining({
      key: "5:14",
      decision: "reject",
      canonical_subject: null,
      transcription_status: "exact",
    }));
    const stable = stateSnapshot(root);
    await run();
    expect(calls).toEqual(["5:14"]);
    expect(stateSnapshot(root)).toEqual(stable);

    const problemPath = join(root, completed.evidence.revision!.problemArtifact.path);
    const problemBytes = readFileSync(problemPath);
    const tamperedProblem = JSON.parse(problemBytes.toString("utf8"));
    tamperedProblem.item.question = tamperedProblem.item.question.replace("『", "「");
    writeCanonicalJson(problemPath, tamperedProblem);
    const beforeTamper = stateSnapshot(root);
    await expect(run()).rejects.toThrow(/problem manual revision이 exact envelope와 다릅니다/u);
    expect(calls).toEqual(["5:14"]);
    expect(stateSnapshot(root)).toEqual(beforeTamper);
  }, 180_000);

  it.skipIf(!existsSync(join(q31Q32LiveState, "problem.pdf")))(
    "routes the pinned 5578421 Q2 terminal mismatch through manual correction before a fresh terminal",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-5578421-q2-full-flow-"));
    cpSync(q31Q32LiveState, root, { recursive: true });
    removeManualArtifacts(root, ["1:2"]);
    removeManualRevisionArtifacts(root, ["1:2"]);
    for (const directory of ["answer-audit", "answer-attestation", "semantic-choice-checks"]) {
      rmSync(join(root, directory), { recursive: true, force: true });
    }
    const calls = { classification: 0, terminal: 0 };
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
          key: string;
          question: string;
        }>;
        expect(items).toHaveLength(1);
        expect(items[0].key).toBe("1:2");
        expect(
          items[0].question.includes("최 교수께서 제기하신 문제에 대해서는") ||
          items[0].question.includes("최 교수님께서 제기하신 문제에 대해서는"),
        ).toBe(true);
        expect(items[0].question).toContain("비용을 줄일 수 있어서");
        const hasOfficialHeader = items[0].question.startsWith("[1~3] ");
        const hasOfficialHonorific = items[0].question.includes("최 교수님께서 제기하신 문제에 대해서는");
        calls.classification++;
        return { text: JSON.stringify([{
          key: "1:2",
          decision: "reject",
          canonical_subject: null,
          curriculum_course: null,
          domain: null,
          achievement_codes: [],
          confidence: 0.99,
          reason_codes: hasOfficialHeader
            ? hasOfficialHonorific
              ? ["SOURCE_EXACT", "OUT_OF_SCOPE_SPEAKING_LISTENING"]
              : ["OUT_OF_SCOPE_SPEAKING_LISTENING", "RADIO_DIALOGUE_ANALYSIS"]
            : [
                "OUT_OF_SCOPE_LISTENING_SPEAKING",
                "ASSESSED_CONSTRUCT_RADIO_INTERVIEW_ANALYSIS",
                "TRANSCRIPTION_OMITS_VISIBLE_SET_LABEL",
              ],
          transcription_status: hasOfficialHeader ? "exact" : "mismatch",
          transcription_evidence: hasOfficialHeader
            ? hasOfficialHonorific
              ? "공식 1쪽의 [1~3] 머리·대담·발문·선택지와 문자 그대로 일치한다."
              : "원본 1쪽의 [1~3] 공통 라디오 대담 전체와 2번 문항의 발문 및 ①~⑤ 선지를 대조한 " +
                "결과, 문장·수치(46.9%, 500억 원, 1,000억 원, 990원/1,000원, 94%, 85%)·기호(○○, " +
                "□□, △△)·구두점과 선택지 내용이 모두 일치한다. 문항은 대담의 진행 과정과 두 " +
                "대담자의 발화 기능을 파악하는 화법·듣기 평가이므로 국어 독서 범위에서는 제외된다."
            : "원문 1·2뷰의 공통 대담과 ‘비용을 줄일 수는 있습니다’, ‘최 교수께서 제기하신 " +
              "문제에 대해서는’, ‘동전을 교환해 주고 관리하는 데 들어가는 비용을 줄일 수 있어서’가 " +
              "일치하고, 1·3뷰의 문항 2 발문과 ①~⑤도 일치한다. 다만 원문 머리의 문항군 표지 ‘[1～3]’이 " +
              "전사에서 누락되어 완전한 문자 그대로의 전사가 아니다. 문항은 라디오 대담의 진행 및 " +
              "대담자 발화를 이해하는 듣기·말하기 평가이므로 독서·문학 범위에서 제외된다.",
        }]) };
      }
      if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
        const items = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{
          key: string;
          question: string;
        }>;
        expect(items.find((item) => item.key === "1:2")?.question)
          .toContain("비용을 줄일 수 있어서");
        expect(items.find((item) => item.key === "1:2")?.question)
          .toContain("최 교수님께서 제기하신 문제에 대해서는");
        calls.terminal++;
        throw new Error("seeded 5578421 post-Q2 terminal boundary");
      }
      throw new Error(`unexpected 5578421 Q2 AI call: ${request.schema?.name ?? "unknown"}`);
    });
    const run = () => {
      const input = q27FixtureInputs(root);
      return repairAndAuditOfficialAnswers(
        input.entry,
        input.problem,
        input.solution,
        root,
        input.classified,
        input.solutions,
      );
    };

    await expect(run()).rejects.toThrow("seeded 5578421 post-Q2 terminal boundary");
    expect(calls).toEqual({ classification: 3, terminal: 1 });
    const problemName = readdirSync(join(root, "problem-manual-adjudications"))
      .find((name) => name.startsWith("v1-0001-0002-"))!;
    const problemCheckpoint = JSON.parse(readFileSync(
      join(root, "problem-manual-adjudications", problemName),
      "utf8",
    ));
    expect(canonicalEvidenceHash(problemCheckpoint.item))
      .toBe("c42349f636fc8e2637b53451fe5c0073a22f4b266bff44fd3fe7e3d742bdd77c");
    const revisionName = readdirSync(join(root, "problem-manual-revisions"))
      .find((name) => name.startsWith("v1-0001-0002-"))!;
    const revisionCheckpoint = JSON.parse(readFileSync(
      join(root, "problem-manual-revisions", revisionName),
      "utf8",
    ));
    expect(canonicalEvidenceHash(revisionCheckpoint.item))
      .toBe("85fffcf17b1e2ca69ab3ef773c17dcd16883e04ba7e1225761634a8ac05eaccf");
    const sourceRevisionName = readdirSync(join(root, "problem-manual-second-revisions"))
      .find((name) => name.startsWith("v1-0001-0002-"))!;
    const sourceRevisionCheckpoint = JSON.parse(readFileSync(
      join(root, "problem-manual-second-revisions", sourceRevisionName),
      "utf8",
    ));
    expect(canonicalEvidenceHash(sourceRevisionCheckpoint.item))
      .toBe("b3d4ca3602e31cff626c4f461c2f4929adf8be4ee5ad0b31f9a73c789780cd30");
    calls.classification = 0;
    calls.terminal = 0;
    await expect(run()).rejects.toThrow("seeded 5578421 post-Q2 terminal boundary");
    expect(calls).toEqual({ classification: 0, terminal: 1 });

    const corrupted = mkdtempSync(join(tmpdir(), "studywork-5578421-q2-terminal-tamper-"));
    cpSync(q31Q32LiveState, corrupted, { recursive: true });
    removeManualArtifacts(corrupted, ["1:2"]);
    removeManualRevisionArtifacts(corrupted, ["1:2"]);
    for (const directory of ["answer-audit", "answer-attestation", "semantic-choice-checks"]) {
      rmSync(join(corrupted, directory), { recursive: true, force: true });
    }
    const terminalPath = join(
      corrupted,
      "problem-terminal-fidelity/" +
        "v2-0000-7e42d5f6f6ffd51641a1acaf9675eb5eac413e35320fee52b6d8e1d5959db3a3-" +
        "067332e077f0988339601b958bbd264c835962cbf8b898a27c367d9d7e02ebd4.json",
    );
    writeFileSync(terminalPath, Buffer.concat([readFileSync(terminalPath), Buffer.from(" ")]));
    providerMock.complete.mockClear();
    const beforeTamper = stateSnapshot(corrupted);
    const corruptedInput = q27FixtureInputs(corrupted);
    await expect(repairAndAuditOfficialAnswers(
      corruptedInput.entry,
      corruptedInput.problem,
      corruptedInput.solution,
      corrupted,
      corruptedInput.classified,
      corruptedInput.solutions,
    )).rejects.toThrow(/manual terminal checkpoint trigger authority/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(corrupted)).toEqual(beforeTamper);
    rmSync(corrupted, { recursive: true, force: true });
  }, 240_000);

  it.skipIf(!existsSync(join(q31Q32LiveState, "problem.pdf")))(
    "adjudicates the source-revised 5578421 Q2 terminal generations by pinned bytes",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-5578421-q2-terminal-v2-"));
    cpSync(q31Q32LiveState, root, { recursive: true });
    for (const directory of ["answer-audit", "answer-attestation", "semantic-choice-checks"]) {
      rmSync(join(root, directory), { recursive: true, force: true });
    }
    const specs = ["v2", "v3", "v4"].map((version) =>
      PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === `ebsi-5578421-q2-terminal-fidelity-${version}`
      )!
    );
    const matchingChildren = (stateRoot: string, allowlistId: string) => {
      const directory = join(stateRoot, "problem-terminal-fidelity-adjudications");
      return existsSync(directory)
        ? readdirSync(directory).filter((name) => {
          const checkpoint = JSON.parse(readFileSync(join(directory, name), "utf8"));
          return checkpoint.basis?.allowlistId === allowlistId;
        })
        : [];
    };
    const adjudicationDirectory = join(root, "problem-terminal-fidelity-adjudications");
    let adjudicationCalls = 0;
    providerMock.complete.mockImplementation(async (request: { prompt: string }) => {
      if (request.prompt.includes("Final question:\n")) adjudicationCalls++;
      throw new Error("seeded 5578421 post-adjudication boundary");
    });
    const run = (stateRoot: string) => {
      const input = q27FixtureInputs(stateRoot);
      return repairAndAuditOfficialAnswers(
        input.entry,
        input.problem,
        input.solution,
        stateRoot,
        input.classified,
        input.solutions,
      );
    };

    const children = specs.map((spec) => {
      expect(matchingChildren(root, spec.allowlistId)).toEqual([
        spec.pinnedAdjudicationArtifact!.path.split("/").at(-1),
      ]);
      const path = join(adjudicationDirectory, matchingChildren(root, spec.allowlistId)[0]);
      return { path, bytes: readFileSync(path), spec };
    });
    await expect(run(root)).rejects.toThrow(
      /seeded 5578421 post-adjudication boundary|problem recovery는 한 번만 허용됩니다/u,
    );
    expect(adjudicationCalls).toBe(0);
    for (const child of children) {
      expect(readFileSync(child.path)).toEqual(child.bytes);
      expect(JSON.parse(readFileSync(child.path, "utf8"))).toMatchObject({
        basis: {
          allowlistId: child.spec.allowlistId,
          failedTerminalCheckpoint: {
            path: child.spec.failedTerminalPath,
            sha256: child.spec.failedTerminalArtifactHash,
          },
        },
        items: [{ key: "1:2", status: "exact", scopeDecision: "reject" }],
      });
    }

    for (const spec of specs) {
      const tampered = mkdtempSync(join(tmpdir(), "studywork-5578421-q2-terminal-tampered-"));
      cpSync(q31Q32LiveState, tampered, { recursive: true });
      const tamperedPath = join(tampered, spec.pinnedAdjudicationArtifact!.path);
      writeFileSync(tamperedPath, Buffer.concat([readFileSync(tamperedPath), Buffer.from(" ")]));
      const beforeTamper = stateSnapshot(tampered);
      providerMock.complete.mockClear();
      await expect(run(tampered)).rejects.toThrow(/pinned terminal fidelity adjudication hash가 다릅니다/u);
      expect(providerMock.complete).not.toHaveBeenCalled();
      expect(stateSnapshot(tampered)).toEqual(beforeTamper);
      rmSync(tampered, { recursive: true, force: true });
    }

  }, 240_000);

  it.skipIf(!existsSync(join(q31Q32LiveState, "problem.pdf")))(
    "replays the 5578421 Q3 board before a fresh terminal",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-5578421-q3-manual-"));
    cpSync(q31Q32LiveState, root, { recursive: true });
    rewindLatest5578421TerminalGeneration(root);
    const terminalSpec = PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5578421-q3-terminal-fidelity-v1"
    )!;
    rmSync(join(root, terminalSpec.pinnedAdjudicationArtifact!.path));
    for (const directory of ["answer-audit", "answer-attestation", "semantic-choice-checks"]) {
      rmSync(join(root, directory), { recursive: true, force: true });
    }
    const calls = { classification: 0, terminal: 0 };
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
          key: string;
          question: string;
          choices: string[];
          figure_description: string;
        }>;
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ key: "1:3" });
        expect(items[0].question).toContain("동전 없는 사회를 실현한 나라들도 있습니다.");
        expect(items[0].question).toContain("그러면 김 과장님, 최 교수님께서 제기하신 문제에 대해서는");
        expect(items[0].choices[1]).toContain("[이게머니]");
        expect(items[0].figure_description).toContain("[경제1등], [이게머니], [거스름돈]");
        calls.classification++;
        return { text: JSON.stringify([{
          key: "1:3",
          decision: "reject",
          canonical_subject: null,
          curriculum_course: null,
          domain: null,
          achievement_codes: [],
          confidence: 0.99,
          reason_codes: ["SOURCE_EXACT", "OUT_OF_SCOPE_SPEAKING_LISTENING"],
          transcription_status: "exact",
          transcription_evidence: "공식 1쪽의 [1~3] 대담, Q3 발문·공지·게시자명·질문 ①~⑤와 일치한다.",
        }]) };
      }
      if (
        request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity" &&
        request.prompt.includes("Final questions:\n")
      ) {
        calls.terminal++;
        throw new Error("seeded 5578421 post-Q3 terminal boundary");
      }
      throw new Error(`unexpected 5578421 Q3 AI call: ${request.schema?.name ?? "unknown"}`);
    });
    const run = () => {
      const input = q27FixtureInputs(root);
      return repairAndAuditOfficialAnswers(
        input.entry,
        input.problem,
        input.solution,
        root,
        input.classified,
        input.solutions,
      );
    };

    await expect(run()).rejects.toThrow("seeded 5578421 post-Q3 terminal boundary");
    expect(calls).toEqual({ classification: 0, terminal: 1 });
    const problemName = readdirSync(join(root, "problem-manual-adjudications"))
      .find((name) => name.startsWith("v1-0001-0003-"))!;
    const problemCheckpoint = JSON.parse(readFileSync(
      join(root, "problem-manual-adjudications", problemName),
      "utf8",
    ));
    expect(canonicalEvidenceHash(problemCheckpoint.item))
      .toBe("79b440a0c4d927fdc530c2e37e5ed4f6095db27a97396a97cd9d925f078d1c34");
    expect(problemCheckpoint.item.choices[1]).toContain("[이게머니]");

    calls.classification = 0;
    calls.terminal = 0;
    await expect(run()).rejects.toThrow("seeded 5578421 post-Q3 terminal boundary");
    expect(calls).toEqual({ classification: 0, terminal: 1 });
  }, 240_000);

  it.skipIf(!existsSync(join(q31Q32LiveState, "problem.pdf")))(
    "replays the pinned 5578421 Q3 terminal children byte-stably",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-5578421-q3-terminal-"));
    cpSync(q31Q32LiveState, root, { recursive: true });
    rewindLatest5578421TerminalGeneration(root);
    for (const directory of ["answer-audit", "answer-attestation", "semantic-choice-checks"]) {
      rmSync(join(root, directory), { recursive: true, force: true });
    }
    const specs = ["v1", "v2"].map((version) =>
      PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST.find((candidate) =>
        candidate.allowlistId === `ebsi-5578421-q3-terminal-fidelity-${version}`
      )!
    );
    const children = specs.map((spec) => ({
      path: join(root, spec.pinnedAdjudicationArtifact!.path),
      spec,
    })).map((child) => ({ ...child, bytes: readFileSync(child.path) }));
    const run = (stateRoot: string) => {
      const input = q27FixtureInputs(stateRoot);
      return repairAndAuditOfficialAnswers(
        input.entry,
        input.problem,
        input.solution,
        stateRoot,
        input.classified,
        input.solutions,
      );
    };
    const replayCalls: string[] = [];
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string } }) => {
      replayCalls.push(request.schema?.name ?? "unknown");
      throw new Error("seeded Q3 terminal replay boundary");
    });
    await expect(run(root)).rejects.toThrow("seeded Q3 terminal replay boundary");
    expect(replayCalls).toEqual(["studywork_exam_corpus_problem_terminal_fidelity"]);
    for (const child of children) expect(readFileSync(child.path)).toEqual(child.bytes);
  }, 240_000);

  it.skipIf(!existsSync(join(q31Q32LiveState, "problem.pdf")))(
    "preflights and crash-resumes the 5578421 Q31-Q32 manual pair byte-stably",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-5578421-q31-q32-manual-"));
    cpSync(q31Q32LiveState, root, { recursive: true });
    removeManualArtifacts(root, ["12:31", "12:32"]);
    const input = q27FixtureInputs(root);
    const q31 = q31Q32ExactRecoveryParent5578421(root, "31");
    const q32 = q31Q32ExactRecoveryParent5578421(root, "32");
    const calls: string[] = [];
    let crashQ31 = true;
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      expect(request.schema?.name).toBe("studywork_exam_corpus_classification");
      const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
        key: string;
        question: string;
        figure_description: string | null;
      }>;
      expect(items).toHaveLength(1);
      const item = items[0];
      calls.push(item.key);
      if (item.key === "12:31" && crashQ31) throw new Error("seeded 5578421 Q31 classification crash");
      expect(item.question).toContain("[29~34] 다음 글을 읽고 물음에 답하시오.");
      expect(item.question).toContain("<결론>인 $q$");
      expect(item.figure_description).toContain("가로선은 총 2개");
      if (item.key === "12:32") expect(item.figure_description).toContain("가로선은 총 5개");
      return { text: JSON.stringify([{
        key: item.key,
        decision: "accept",
        canonical_subject: "korean_reading",
        curriculum_course: "독서와 작문",
        domain: "독서—논리 개념의 이해와 적용",
        achievement_codes: ["12독작01-03"],
        confidence: 0.99,
        reason_codes: ["SOURCE_EXACT", "NONFICTION_COMPREHENSION"],
        transcription_status: "exact",
        transcription_evidence: `공식 11~12쪽의 ${item.key} 지문·도식·발문·선택지가 일치한다.`,
      }]) };
    });

    const run = (row: ReturnType<typeof q31Q32ExactRecoveryParent5578421>) =>
      adjudicateProblemManual(input.entry, input.problem, root, row.failed, row.parent);
    await expect(run(q31)).rejects.toThrow("seeded 5578421 Q31 classification crash");
    expect(calls).toEqual(["12:31"]);
    expect(readdirSync(join(root, "problem-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0012-0031-"))).toHaveLength(1);
    expect(readdirSync(join(root, "classification-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0012-0031-"))).toHaveLength(0);

    crashQ31 = false;
    const completed31 = await run(q31);
    const completed32 = await run(q32);
    expect(calls).toEqual(["12:31", "12:31", "12:32"]);
    expect(canonicalEvidenceHash(completed31.classified.question))
      .toBe("784b252cb42674978f332dc741bbca77366b1f7c72f7b60b24c235086b855f1f");
    expect(canonicalEvidenceHash(completed32.classified.question))
      .toBe("ec5a2c62639228e94c405ce9f5624fe7bb88c16d3e6add611f559edea9a9a804");
    const stable = stateSnapshot(root);
    const beforeReplay = [...calls];
    await run(q31);
    await run(q32);
    expect(calls).toEqual(beforeReplay);
    expect(stateSnapshot(root)).toEqual(stable);

    removeManualArtifacts(root, ["12:31"]);
    const q32ProblemName = readdirSync(join(root, "problem-manual-adjudications"))
      .find((name) => name.startsWith("v1-0012-0032-"))!;
    const q32ProblemPath = join(root, "problem-manual-adjudications", q32ProblemName);
    const q32ProblemBytes = readFileSync(q32ProblemPath);
    writeFileSync(q32ProblemPath, Buffer.concat([q32ProblemBytes, Buffer.from(" ")]));
    const beforeTamper = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(run(q31)).rejects.toThrow(/12:32 manual adjudication hash가 다릅니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(beforeTamper);

    writeFileSync(q32ProblemPath, q32ProblemBytes);
    removeManualArtifacts(root, ["12:31"]);
    const q32ClassificationName = readdirSync(join(root, "classification-manual-adjudications"))
      .find((name) => name.startsWith("v1-0012-0032-"))!;
    const q32ClassificationPath = join(root, "classification-manual-adjudications", q32ClassificationName);
    const q32ClassificationBytes = readFileSync(q32ClassificationPath);
    unlinkSync(q32ClassificationPath);
    symlinkSync(join(root, "problem.pdf"), q32ClassificationPath);
    const beforeSymlink = stateSnapshot(root);
    await expect(run(q31)).rejects.toThrow(/classification manual adjudication 파일이 유효하지 않습니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(beforeSymlink);
    unlinkSync(q32ClassificationPath);
    writeFileSync(q32ClassificationPath, q32ClassificationBytes);
  }, 300_000);

  it.skipIf(!existsSync(join(q31Q32LiveState, "problem.pdf")))(
    "forces both 5578421 manual children through the full importer before a fresh terminal",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-5578421-q31-q32-full-flow-"));
    cpSync(q31Q32LiveState, root, { recursive: true });
    removeManualArtifacts(root, ["12:31", "12:32"]);
    for (const directory of ["answer-audit", "answer-attestation", "semantic-choice-checks"]) {
      rmSync(join(root, directory), { recursive: true, force: true });
    }
    const initialSnapshot = stateSnapshot(root);
    const calls = { classification: [] as string[], terminal: 0 };
    let crashQ32 = true;
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
          key: string;
          question: string;
          figure_description: string | null;
        }>;
        expect(items).toHaveLength(1);
        const item = items[0];
        expect(["12:31", "12:32"]).toContain(item.key);
        expect(item.question).toContain("[29~34] 다음 글을 읽고 물음에 답하시오.");
        expect(item.figure_description).toContain("가로선은 총 2개");
        if (item.key === "12:32") expect(item.figure_description).toContain("가로선은 총 5개");
        calls.classification.push(item.key);
        if (item.key === "12:32" && crashQ32) throw new Error("seeded 5578421 Q32 classification crash");
        return { text: JSON.stringify([{
          key: item.key,
          decision: "accept",
          canonical_subject: "korean_reading",
          curriculum_course: "독서와 작문",
          domain: "독서—논리 개념의 이해와 적용",
          achievement_codes: ["12독작01-03"],
          confidence: 0.99,
          reason_codes: ["SOURCE_EXACT", "NONFICTION_COMPREHENSION"],
          transcription_status: "exact",
          transcription_evidence: `공식 11~12쪽의 ${item.key} 지문·도식·발문·선택지가 일치한다.`,
        }]) };
      }
      if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
        calls.terminal++;
        const items = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{
          key: string;
          question: string;
          figure_description: string | null;
        }>;
        expect(items).toHaveLength(45);
        expect(new Set(items.map((item) => item.key)).size).toBe(45);
        expect(items.find((item) => item.key === "12:31")?.question)
          .toContain("ⓐ와 ⓑ의 입장에서 <보기>를 분석한 것으로");
        expect(items.find((item) => item.key === "12:31")?.figure_description)
          .toContain("가로선은 총 2개");
        expect(items.find((item) => item.key === "12:32")?.question)
          .toContain("32. ㉠에 해당하지 않는 것은?");
        expect(items.find((item) => item.key === "12:32")?.figure_description)
          .toContain("가로선은 총 5개");
        throw new Error("seeded 5578421 post-pair terminal boundary");
      }
      throw new Error(`unexpected 5578421 pair AI call: ${request.schema?.name ?? "unknown"}`);
    });
    const run = () => {
      const input = q27FixtureInputs(root);
      return repairAndAuditOfficialAnswers(
        input.entry,
        input.problem,
        input.solution,
        root,
        input.classified,
        input.solutions
      );
    };

    await expect(run()).rejects.toThrow("seeded 5578421 Q32 classification crash");
    expect([...calls.classification].sort()).toEqual(["12:31", "12:32"]);
    expect(calls.terminal).toBe(0);
    expect(existsSync(join(root, "answer-audit"))).toBe(false);
    expect(existsSync(join(root, "answer-attestation"))).toBe(false);
    expect(stateSnapshot(root)).not.toEqual(initialSnapshot);
    crashQ32 = false;
    calls.classification = [];
    await expect(run()).rejects.toThrow("seeded 5578421 post-pair terminal boundary");
    expect(calls.classification).toEqual(["12:32"]);
    expect(calls.terminal).toBe(1);
    const problemChildren = readdirSync(join(root, "problem-manual-adjudications"));
    const classificationChildren = readdirSync(join(root, "classification-manual-adjudications"));
    expect(problemChildren.filter((name) => /^v1-0012-003[12]-/u.test(name))).toHaveLength(2);
    expect(classificationChildren.filter((name) => /^v1-0012-003[12]-/u.test(name))).toHaveLength(2);
    expect(["31", "32"].map((number) => {
      const name = problemChildren.find((candidate) => candidate.startsWith(`v1-0012-00${number}-`))!;
      const checkpoint = JSON.parse(readFileSync(join(root, "problem-manual-adjudications", name), "utf8"));
      return canonicalEvidenceHash(checkpoint.item);
    })).toEqual([
      "784b252cb42674978f332dc741bbca77366b1f7c72f7b60b24c235086b855f1f",
      "ec5a2c62639228e94c405ce9f5624fe7bb88c16d3e6add611f559edea9a9a804",
    ]);
    expect(existsSync(join(root, "answer-audit"))).toBe(false);
    expect(existsSync(join(root, "answer-attestation"))).toBe(false);

    const corrupted = mkdtempSync(join(tmpdir(), "studywork-5578421-q31-q32-preflight-"));
    cpSync(q31Q32LiveState, corrupted, { recursive: true });
    removeManualArtifacts(corrupted, ["12:31", "12:32"]);
    const q32 = q31Q32ExactRecoveryParent5578421(corrupted, "32");
    const corruptedFixture = q27FixtureInputs(corrupted);
    const seededQ32 = await adjudicateProblemManual(
      corruptedFixture.entry,
      corruptedFixture.problem,
      corrupted,
      q32.failed,
      q32.parent
    );
    const q32Path = join(corrupted, seededQ32.evidence.problemArtifact.path);
    writeFileSync(q32Path, Buffer.concat([readFileSync(q32Path), Buffer.from(" ")]));
    removeManualArtifacts(corrupted, ["12:31"]);
    rmSync(join(corrupted, "classification-repair-batches"), { recursive: true, force: true });
    providerMock.complete.mockClear();
    const beforeCorruption = stateSnapshot(corrupted);
    const corruptedInput = q27FixtureInputs(corrupted);
    await expect(repairAndAuditOfficialAnswers(
      corruptedInput.entry,
      corruptedInput.problem,
      corruptedInput.solution,
      corrupted,
      corruptedInput.classified,
      corruptedInput.solutions
    )).rejects.toThrow("manual adjudication base classification repair이 regular file이 아닙니다");
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(corrupted)).toEqual(beforeCorruption);
    rmSync(corrupted, { recursive: true, force: true });

    const missingParent = mkdtempSync(join(tmpdir(), "studywork-5578421-q31-missing-parent-"));
    cpSync(q31Q32LiveState, missingParent, { recursive: true });
    removeManualArtifacts(missingParent, ["12:31", "12:32"]);
    const missingFixture = q27FixtureInputs(missingParent);
    const missingQ32 = q31Q32ExactRecoveryParent5578421(missingParent, "32");
    const missingSeed = await adjudicateProblemManual(
      missingFixture.entry,
      missingFixture.problem,
      missingParent,
      missingQ32.failed,
      missingQ32.parent
    );
    const missingQ32Path = join(missingParent, missingSeed.evidence.problemArtifact.path);
    writeFileSync(missingQ32Path, Buffer.concat([readFileSync(missingQ32Path), Buffer.from(" ")]));
    unlinkSync(join(
      missingParent,
      "problem-recoveries/v1-0012-0031-5055fe6fd48bf51df91b6ce57ef4f949f430567ac3f3b3a27265d3e9a66ac6bd.json"
    ));
    providerMock.complete.mockClear();
    const beforeMissing = stateSnapshot(missingParent);
    await expect(repairAndAuditOfficialAnswers(
      missingFixture.entry,
      missingFixture.problem,
      missingFixture.solution,
      missingParent,
      missingFixture.classified,
      missingFixture.solutions
    )).rejects.toThrow(/12:31 manual batch recovery exact-set가 다릅니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(missingParent)).toEqual(beforeMissing);
    rmSync(missingParent, { recursive: true, force: true });

    const orphan = mkdtempSync(join(tmpdir(), "studywork-5578421-q32-later-orphan-"));
    cpSync(q31Q32LiveState, orphan, { recursive: true });
    removeManualArtifacts(orphan, ["12:31", "12:32"]);
    mkdirSync(join(orphan, "problem-manual-second-revisions"), { recursive: true });
    writeFileSync(join(orphan, "problem-manual-second-revisions/v1-0012-0032-orphan.json"), "{}\n");
    providerMock.complete.mockClear();
    const beforeOrphan = stateSnapshot(orphan);
    const orphanInput = q27FixtureInputs(orphan);
    await expect(repairAndAuditOfficialAnswers(
      orphanInput.entry,
      orphanInput.problem,
      orphanInput.solution,
      orphan,
      orphanInput.classified,
      orphanInput.solutions
    )).rejects.toThrow("problem manual second revision filename이 유효하지 않습니다: " +
      "v1-0012-0032-orphan.json");
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(orphan)).toEqual(beforeOrphan);
    rmSync(orphan, { recursive: true, force: true });

    const dangling = mkdtempSync(join(tmpdir(), "studywork-5578421-q32-later-symlink-"));
    cpSync(q31Q32LiveState, dangling, { recursive: true });
    removeManualArtifacts(dangling, ["12:31", "12:32"]);
    symlinkSync(join(dangling, "missing-directory"), join(dangling, "classification-manual-second-revisions"));
    providerMock.complete.mockClear();
    const beforeDangling = stateSnapshot(dangling);
    const danglingInput = q27FixtureInputs(dangling);
    await expect(repairAndAuditOfficialAnswers(
      danglingInput.entry,
      danglingInput.problem,
      danglingInput.solution,
      dangling,
      danglingInput.classified,
      danglingInput.solutions
    )).rejects.toThrow("classification-manual-second-revisions 디렉터리가 유효하지 않습니다");
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(dangling)).toEqual(beforeDangling);
    rmSync(dangling, { recursive: true, force: true });

    const linked = mkdtempSync(join(tmpdir(), "studywork-5578421-q32-later-linked-dir-"));
    cpSync(q31Q32LiveState, linked, { recursive: true });
    removeManualArtifacts(linked, ["12:31", "12:32"]);
    const linkedTarget = join(linked, "classification-manual-second-revisions-target");
    mkdirSync(linkedTarget);
    symlinkSync(linkedTarget, join(linked, "classification-manual-second-revisions"));
    providerMock.complete.mockClear();
    const beforeLinked = stateSnapshot(linked);
    const linkedInput = q27FixtureInputs(linked);
    await expect(repairAndAuditOfficialAnswers(
      linkedInput.entry,
      linkedInput.problem,
      linkedInput.solution,
      linked,
      linkedInput.classified,
      linkedInput.solutions
    )).rejects.toThrow("classification-manual-second-revisions 디렉터리가 유효하지 않습니다");
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(linked)).toEqual(beforeLinked);
    rmSync(linked, { recursive: true, force: true });

    const q32ClassificationName = classificationChildren
      .find((name) => name.startsWith("v1-0012-0032-"))!;
    unlinkSync(join(root, "classification-manual-adjudications", q32ClassificationName));
    calls.classification = [];
    calls.terminal = 0;
    await expect(run()).rejects.toThrow("seeded 5578421 post-pair terminal boundary");
    expect(calls).toEqual({ classification: ["12:32"], terminal: 1 });
    const stable = stateSnapshot(root);
    calls.classification = [];
    calls.terminal = 0;
    await expect(run()).rejects.toThrow("seeded 5578421 post-pair terminal boundary");
    expect(calls).toEqual({ classification: [], terminal: 1 });
    expect(stateSnapshot(root)).toEqual(stable);
  }, 300_000);

  it.skipIf(!existsSync(join(q31Q32LiveState, "problem.pdf")))(
    "repairs the source-grounded 5578421 Q29 diagram after its failed terminal adjudication",
    async () => {
    const terminalSpec = PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5578421-q29-terminal-fidelity-v2"
    )!;
    const q30TerminalSpec = PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5578421-q30-terminal-fidelity-v2"
    )!;
    const q33TerminalSpec = PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST.find((candidate) =>
      candidate.allowlistId === "ebsi-5578421-q33-terminal-fidelity-v2"
    )!;
    expect({
      prefixHash: canonicalEvidenceHash(PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST.slice(0, 14)),
      rowHash: canonicalEvidenceHash(terminalSpec),
      pinnedAdjudicationArtifact: terminalSpec.pinnedAdjudicationArtifact,
      pinnedPolicyArtifact: terminalSpec.policyRevision?.pinnedArtifact,
    }).toEqual({
      prefixHash: "6f121139b845c74c1de93f68d8fe906c7200481f187ba3810a811450683917e0",
      rowHash: "337196b42c2b29fbade3173681db9ced4cd23a0831782356fcfcb58ff4b77279",
      pinnedAdjudicationArtifact: {
        path: "problem-terminal-fidelity-adjudications/" +
          "v1-0011-0029-471a32458fb8d0a2725ac8e9d6830815e7eeebba3c5759df6a17b17f1ddd1973.json",
        sha256: "70b8ceff8d6ead8152fcc0435bb2f4485c8e73ec0e67aba1e7cac6307652ac60",
        itemHash: "aa326687b1ca686c6e4e7ed0f5984f8ed5bc88e8e304fccfb87ef8dbb53cdeab",
      },
      pinnedPolicyArtifact: {
        path: "problem-terminal-fidelity-policy-revisions/" +
          "v1-0011-0029-5cd21ac0ebc9e3b730997ccd261594978e171e4f79447ac650488e720db7052d.json",
        sha256: "e2c07cba3f712281ea8953746044102023ff518986e39c4ca3ef21d59c9d3ed6",
        itemHash: "9b9d95bfce7ba155c58a826904bcfbd4333ce3e88ef226f118f4e321d4ca9623",
      },
    });
    expect({
      prefixHash: canonicalEvidenceHash(PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST.slice(0, 15)),
      rowHash: canonicalEvidenceHash(q30TerminalSpec),
      pinnedAdjudicationArtifact: q30TerminalSpec.pinnedAdjudicationArtifact,
    }).toEqual({
      prefixHash: "4a5965fb8a86b59cc2dfb8c2a887af8e1e39fca40fc60e056b4b8a9606a68cb8",
      rowHash: "f2af862494df6ce1cdf3fe11e3e148979ad3cfd22d4528409829d4ae77a7676f",
      pinnedAdjudicationArtifact: {
        path: "problem-terminal-fidelity-adjudications/" +
          "v1-0012-0030-f9fb0b66f2dcf467685a275aa1d156ae79881cdd64a63f3035f6825716928ca3.json",
        sha256: "29d6faf5f3f60019d25f827d2c26d4348b1ec448ad460bfdcedbb80199b8f186",
        itemHash: "05795808473e0670d376c32e841be9ae41a376c1b6832362839e3e0c1e34a22b",
      },
    });
    expect({
      prefixHash: canonicalEvidenceHash(PROBLEM_TERMINAL_FIDELITY_ADJUDICATION_ALLOWLIST.slice(0, 16)),
      rowHash: canonicalEvidenceHash(q33TerminalSpec),
      pinnedAdjudicationArtifact: q33TerminalSpec.pinnedAdjudicationArtifact,
      pinnedPolicyArtifact: q33TerminalSpec.policyRevision?.pinnedArtifact,
    }).toEqual({
      prefixHash: "d5df5628172a56547553d83e667cd89b82f6d0ef36689610846026e40b36f45f",
      rowHash: "2f209f6614153eecf623868bff0659a6b756fc5f03f2fc4d41cf69833440c2f7",
      pinnedAdjudicationArtifact: {
        path: "problem-terminal-fidelity-adjudications/" +
          "v1-0012-0033-50054ed740181f5a2f6e581a015d9ac8120b3a490757fad37631ddf9bfd4c2fc.json",
        sha256: "ad50b084bd93b760a107beefd9594990f250e3c14b7bc2abcead8973820db286",
        itemHash: "36e2e90217aadd33e54c2161cb56d28a3bcda07cacf3824a0ba97ecba0139f0c",
      },
      pinnedPolicyArtifact: {
        path: "problem-terminal-fidelity-policy-revisions/" +
          "v1-0012-0033-e660b3d2e7efb16a129eb88637d2d9d31a6f250c465cb7ec8df7c1fffe1fb2d7.json",
        sha256: "7c89e964de4b3a6b5e689ee532288f1f2398b1260681e351e48b211c20873b3f",
        itemHash: "8fb889dc383a7593c543d354ef7287cb3a7583b73cc55d3ead5a4d60b468ad97",
      },
    });
    root = mkdtempSync(join(tmpdir(), "studywork-5578421-q29-terminal-manual-"));
    cpSync(q31Q32LiveState, root, { recursive: true });
    removeManualArtifacts(root, ["11:29"]);
    const input = q27FixtureInputs(root);
    const calls = { classification: 0, terminal: 0 };
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
          key: string;
          question: string;
          figure: boolean;
          figure_description: string | null;
        }>;
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ key: "11:29", figure: true });
        expect(items[0].question).toContain("⇒");
        expect(items[0].figure_description).toContain("가로선은 총 2개");
        calls.classification++;
        return { text: JSON.stringify([{
          key: "11:29",
          decision: "accept",
          canonical_subject: "korean_reading",
          curriculum_course: "독서와 작문",
          domain: "독서—논리학 설명문의 전개 구조 파악",
          achievement_codes: ["12독작01-03"],
          confidence: 0.99,
          reason_codes: ["SOURCE_EXACT", "NONFICTION_COMPREHENSION"],
          transcription_status: "exact",
          transcription_evidence: "공식 11쪽의 ⇒와 두 추론선, 지문, 발문, 선택지가 모두 일치한다.",
        }]) };
      }
      if (
        request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity" &&
        request.prompt.includes("Final questions:\n")
      ) {
        calls.terminal++;
        const items = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{
          key: string;
          question: string;
          figure: boolean;
          figure_description: string | null;
        }>;
        const q29 = items.find((item) => item.key === "11:29")!;
        expect(q29.figure).toBe(true);
        expect(q29.question).toContain("⇒");
        expect(q29.figure_description).toContain("가로선은 총 2개");
        throw new Error("seeded 5578421 post-Q29 manual terminal boundary");
      }
      throw new Error(`unexpected 5578421 Q29 AI call: ${request.schema?.name ?? "unknown"}`);
    });
    const run = () => repairAndAuditOfficialAnswers(
      input.entry,
      input.problem,
      input.solution,
      root,
      input.classified,
      input.solutions
    );

    await expect(run()).rejects.toThrow("seeded 5578421 post-Q29 manual terminal boundary");
    expect(calls).toEqual({ classification: 1, terminal: 1 });
    const problemName = readdirSync(join(root, "problem-manual-adjudications"))
      .find((name) => name.startsWith("v1-0011-0029-"))!;
    const classificationName = readdirSync(join(root, "classification-manual-adjudications"))
      .find((name) => name.startsWith("v1-0011-0029-"))!;
    const problemCheckpoint = JSON.parse(readFileSync(
      join(root, "problem-manual-adjudications", problemName),
      "utf8"
    ));
    expect(canonicalEvidenceHash(problemCheckpoint.item))
      .toBe("abb687aa942feb2b5435afdaf2ccb6a2d7a4cae5a360c01bbc7f472130fe2011");
    expect(classificationName).toMatch(/^v1-0011-0029-/u);
    const stable = stateSnapshot(root);

    calls.classification = 0;
    calls.terminal = 0;
    await expect(run()).rejects.toThrow("seeded 5578421 post-Q29 manual terminal boundary");
    expect(calls).toEqual({ classification: 0, terminal: 1 });
    expect(stateSnapshot(root)).toEqual(stable);

    const triggerPath = join(
      root,
      "problem-terminal-fidelity-adjudications/" +
        "v1-0011-0029-7ce50336926f1c9a856efe53dadcc15be0f6bb84d68687bbab8026564c750216.json"
    );
    writeFileSync(triggerPath, Buffer.concat([readFileSync(triggerPath), Buffer.from(" ")]));
    const tampered = stateSnapshot(root);
    calls.classification = 0;
    calls.terminal = 0;
    providerMock.complete.mockReset().mockRejectedValue(new Error("AI must not run"));
    await expect(run()).rejects.toThrow(/manual terminal trigger.*(?:hash|authority)/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(tampered);
  }, 120_000);

  it("pins the complete Q17-Q45 solution false-negative and Q40 source-revision authority", () => {
    expect(canonicalEvidenceHash(SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST))
      .toBe("90a2a84b2813204915a0e2df9daceabbd4b3a65e410838c590264752ec3a7015");
    expect(canonicalEvidenceHash([{ ...SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0],
      items: SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0].items.slice(0, 11) }]))
      .toBe("8f780112dc37cf0cd67b29fd3237c36a8a2dad4d81201f5f030a155f2303d8ad");
    expect(SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0].items.map((item) => canonicalEvidenceHash(item))).toEqual([
      "e17b1ed3f0ed2c3c155fee47fd0ce1db65b01aac36ddfc152551839085854980",
      "56be79294489fde849507d2f6a792331d8541e127fa65a42e55e8e3542365dd0",
      "e144bac17721cd9bc5ebf19dbbd0cefbb18975fe80be000a595cdb50b80c2095",
      "612c6ef1b6d77e58c171c3a2c42d6404cd72603a8e4964d2928a5a0344854e74",
      "aaa638b3e3f56ebc38dcc8b1f35bdd40655fc492208761a88305a83db9fb84ee",
      "72443e38d0a07797e7193dda0dd750a1bfda1f8a3f2e898aca2dcda918f719ea",
      "75fdb9bc2568ca86975675c0f079f7f1bc91abb4b1dd1038cc7d92ea512c40b7",
      "54cebc963a81df797998a4e368b9b06e97f16e5dcd4e84bd81e1e9702f83959d",
      "a4bbeb2eedf1e5ce27e51fdd229ed2e9f8b291aa322c4d433cf325122d49b454",
      "55673d5bf35b4ad22deae1b0c20fa9b97a41b4bbed858e5bd5cee992c09fde30",
      "e7132199776a4979ebfd4e0cdc1103556ee7ef3c0b4433a4fa1c916c82693802",
      "5de3213d9a314946ff9cc1e4899ea942a1e77d9fd0ae35971f94763cbba562d2",
      "307af384fd2bce21dbad093f76e4d1ede7f027d108de4fffa8fee3830affd453",
      "95a8609ae3b4486eb2d8d9fb6be4ca975ceb8f18759a48a23bf99ec9016dd023",
      "164a1e36e9d18368e16bab527cb32e1a74a737b3661a109aa80a40c0ed1282c0",
      "4a151d50050918237ce384f106e519a925af67679c3250140131b963dae3d983",
    ]);
    expect(canonicalEvidenceHash(SOLUTION_SOURCE_REVISION_ALLOWLIST))
      .toBe("f4aa29744628e0699be8c1abdcfbc2f330bf4f5376085882ac6cc2d13d529ed3");
    expect(canonicalEvidenceHash(SOLUTION_SOURCE_REVISION_ALLOWLIST[0]))
      .toBe("afaf8a15ee23d5f6bf0d6a3a6ad7c7679a2d15813a23ddfb07f3ca51b43afd7e");
  });

  it("pins the thirty-eight audited sources and exhausted child hashes", () => {
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 29).map((item) => ({
      entryId: item.entryId,
      key: item.key,
      sourcePage: item.sourcePage,
      sourceHash: item.sourceHash,
      parentKind: item.parentKind,
      failedQuestionHash: item.failedQuestionHash,
    }))).toEqual([{
      entryId: "ebsi:5594499",
      key: "13:34",
      sourcePage: 13,
      sourceHash: cases[0].sourceHash,
      parentKind: "crop",
      failedQuestionHash: "050900567ea5583ed78cf4fbeafc6cc0e014cb3eb480222bcf2cae22ed70ec7b",
    }, {
      entryId: "ebsi:5578421",
      key: "12:30",
      sourcePage: 12,
      sourceHash: cases[1].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "0bf9903e40726584efe854ea1e91984a7d8f99c4b43ff9529ed75a2903802dfc",
    }, {
      entryId: "ebsi:5525984",
      key: "3:8",
      sourcePage: 3,
      sourceHash: cases[2].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "9e4b37f842ef38b07710ff9ce1e358d847abadb1f57387c8a3b7174205027a78",
    }, {
      entryId: "ebsi:5656593",
      key: "7:18",
      sourcePage: 7,
      sourceHash: cases[3].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "79c49b622b055d72423e33d5a7038766173bf3923cf10d7c15a36a4bd7eb5e9e",
    }, {
      entryId: "ebsi:5854871",
      key: "2:9",
      sourcePage: 2,
      sourceHash: cases[4].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "3356445be5f6d28b112a307219a83cba0fefc3a8f88c30e01e2d2319498c81c1",
    }, {
      entryId: "ebsi:5594499",
      key: "4:9",
      sourcePage: 4,
      sourceHash: cases[5].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "6b45bc49e5f0e87b14c8b93fc23e845b668bd8185af847c9929021235f6a8759",
    }, {
      entryId: "ebsi:5577054",
      key: "16:43",
      sourcePage: 16,
      sourceHash: cases[6].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "59b3c10380338bed7ed9fcdcdf746d30cccddff38cce54d0c98c7b9fa4722bfb",
    }, {
      entryId: "ebsi:5525982",
      key: "11:27",
      sourcePage: 11,
      sourceHash: cases[7].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "11c3fa247bebf72d1991540323f100af892ebc44cb36c2afa945ddcadd3524fd",
    }, {
      entryId: "ebsi:5525982",
      key: "16:43",
      sourcePage: 16,
      sourceHash: cases[8].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "40fbcf1de1b8b75e83c7844f7dbc7d344f07bb4ddea4f4d6276fc4f33d2fdc64",
    }, {
      entryId: "ebsi:5525982",
      key: "16:44",
      sourcePage: 16,
      sourceHash: cases[9].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "1a9a5ffba8dc8f7fe71ce7f334f59c319024de355592e64484e552934f9473f1",
    }, {
      entryId: "ebsi:5525982",
      key: "16:45",
      sourcePage: 16,
      sourceHash: cases[10].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "ba0d851b6048c4de5f86240cda0f054a66f2c54408d47ca284abf596da4198db",
    }, {
      entryId: "ebsi:5525982",
      key: "4:8",
      sourcePage: 4,
      sourceHash: cases[11].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "36e1747efaf51d29ed27eda862928d50f00b8705e30bc427b50ceffbe5389d3f",
    }, {
      entryId: "ebsi:5525982",
      key: "6:16",
      sourcePage: 6,
      sourceHash: cases[12].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "24a18e38193f474dc03c320cf23acdf0c9d65119cf6dbb544f7a087aa0bc37e8",
    }, {
      entryId: "ebsi:5525982",
      key: "7:17",
      sourcePage: 7,
      sourceHash: cases[13].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "2961d438f823a77f24b5d2a557d1a458b3fb9e4059d61ce1784cf426b7d61a3b",
    }, {
      entryId: "ebsi:5525982",
      key: "7:20",
      sourcePage: 7,
      sourceHash: cases[14].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "08d90afec9e8002f03d8e7ed6edcfbf6a7a38330a93db371499d1557157b8c33",
    }, {
      entryId: "ebsi:5525982",
      key: "9:23",
      sourcePage: 9,
      sourceHash: cases[15].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "91a7b3510abe21512465ac1636f6b582d242c1f2bf455f63e57a7694d689f1f5",
    }, {
      entryId: "ebsi:5525982",
      key: "11:28",
      sourcePage: 11,
      sourceHash: cases[16].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "6ed99a926dd0b20613490e79e79743d762e6235237359bae97c546f44f1db123",
    }, {
      entryId: "ebsi:5525982",
      key: "11:29",
      sourcePage: 11,
      sourceHash: cases[17].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "8125959ebccf15cb44344a2d3ce04b3d53f4a3665411f82ab2da6b4b62569c63",
    }, {
      entryId: "ebsi:5525982",
      key: "11:30",
      sourcePage: 11,
      sourceHash: cases[18].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "aa9ea468897a9e81ce965dae0d7d5045787aee721330279b6918326eb81ad191",
    }, {
      entryId: "ebsi:5525982",
      key: "12:31",
      sourcePage: 12,
      sourceHash: cases[19].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "b51b5c9e1d35d7cd60e90a47a8445ac091731395bb67eca0a33d7d0db2dbab02",
    }, {
      entryId: "ebsi:5525982",
      key: "12:32",
      sourcePage: 12,
      sourceHash: cases[20].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "0303cb02dc9e96fbabbf6f9eb565af80cf83f68c50cbf52baf7406ebeccbeb98",
    }, {
      entryId: "ebsi:5525982",
      key: "14:37",
      sourcePage: 14,
      sourceHash: cases[21].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "6a672fafc65c97a5d38e24027442a39c38ab28b64ca63d54a4140a75f1cfe993",
    }, {
      entryId: "ebsi:5525982",
      key: "15:38",
      sourcePage: 15,
      sourceHash: cases[22].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "d02b6e53c873d404b58c318dc36659415b52367099bb75832e2e20266a83baa0",
    }, {
      entryId: "ebsi:5525982",
      key: "15:40",
      sourcePage: 15,
      sourceHash: cases[23].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "538abfffe335301267fbd4d7421782946db6431b38f2209ae0b8d8aa6059e52b",
    }, {
      entryId: "ebsi:5525982",
      key: "15:41",
      sourcePage: 15,
      sourceHash: cases[24].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "d495f0be4c13ab152663bd673f5809497588661cbfd68d67acd987e98665106b",
    }, {
      entryId: "ebsi:5525982",
      key: "15:42",
      sourcePage: 15,
      sourceHash: cases[25].sourceHash,
      parentKind: "recovery",
      failedQuestionHash: "190871a47391d12bc13e3cba9fadc51f92640021482be78947420e95d89fe34d",
    }, {
      entryId: "ebsi:5525982",
      key: "7:18",
      sourcePage: 7,
      sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
      parentKind: "recovery",
      failedQuestionHash: "745287373aa1ae4b0b3b722379531007f6dcac703bebddbb3305b32bdfc0163c",
    }, {
      entryId: "ebsi:5525982",
      key: "7:19",
      sourcePage: 7,
      sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
      parentKind: "recovery",
      failedQuestionHash: "f6442fc7394763ffb573b62c1294bb25aba603bbadcd4bc332447aa2c426f46e",
    }, {
      entryId: "ebsi:5525982",
      key: "15:39",
      sourcePage: 15,
      sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
      parentKind: "recovery",
      failedQuestionHash: "b0f2287b7c860d7e5141198fb5f343a4f2498cc001e5bd16956f5ccc0f6987da",
    }]);
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 11)))
      .toBe("7851318ea1e176be603db1f2679081e16ef222d90ff704e39dce8d47db446268");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 13)))
      .toBe("fe8516451df56c3030a821886a42a93d1fa88dc87529060bd608f835bc0dc990");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 15)))
      .toBe("219a859d0ab52014822efa602cc0e090f5d0f31551502386d8ab6e775ed7c53a");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 26)))
      .toBe("4d844c71cc01ae752974edb5941ed475d80e76dd03bb5ee1a51a7b256512bb80");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 29)))
      .toBe("0b5d7d19255cd91566a55b289b11f8a9460a3014a06f255f9a266ebd62980cf9");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 36)))
      .toBe("e260bb5cd9c24507cb1c434e19b03a63961ef07a29392b28fc49f6897040dd64");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 46)))
      .toBe("918b9267faab3d394cf64e5b9f02e9621024c5c6ad5d17d233fd8940fd1dac82");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST))
      .toBe("3ed755eca82ad21bffd89172e6f9706a68d331620969034d8a4ef8be48bdf219");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(0, 18)))
      .toBe("463fceef246487e1ec791ffb0489048f874cd5944d946f9c6d819f3fd3c76eda");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[11]))
      .toBe("106ddb3c73dd5a2f12005c1bfe51eaa15830a89ee8dabaa82f14fe3ef5384cdf");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[12]))
      .toBe("9e0a7e81200e3187cf951dbc22282237166d897a7ff9eb2b5c69aaff726b1d0c");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[13]))
      .toBe("3b387191b6f43e3d83babbf0068ce1fb3a9e52bd3c9ba7f835964ee543facb64");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[14]))
      .toBe("4aad2f6a1d34af97338b72d86559472a0de7c6641d7ef643aae7819a1f0c232b");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[15]))
      .toBe("6be4f4fbb1848c327beb38415b8d2faf0193bbad4ae9e31d286803096862e540");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[16]))
      .toBe("b82020b2dd5fae081a3031887b345b337b5860156b75d6d7ce6137eb7bf40beb");
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[17]))
      .toBe("fb9f306bf484870e7a355e6bd59dae03430d12c855acda631d8f7a191e74ef60");
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(18, 36).map(canonicalEvidenceHash)).toEqual([
      "0d5d73306f77fc61f30ccde3e970f80499e4db7be3fbefc646350170cde9696e",
      "a68cbd6c6b2c4f27f2db4784b2b15a1e45f2255a764a2df7b48840514bf4abd4",
      "974562dc407ca854aebb49fb2fe9a56df97383a9f44407bd54ae949d2a85a796",
      "3002ecd3c82d2ee9e4927228ef082c58e317c88a103f0cf2d29317848813006c",
      "274ff9d1bab3e2b8adaaeca6a50cbd6ebab4d8efc9ce98f241531e554f5a7fbf",
      "352f1f625a2b842cd8cfb55b3b16442aa7610cba84e9134f8cb234ecf0c20eca",
      "17d17089a45be6edc291d7d5489176dcd18d00007589089db657ae618e71f593",
      "44900a00af38a5de0486bf115b0f1e928b5ee111f9df7f9ce3749b9beb416b83",
      "27f57efde1618ebb4403d334979d92d525b274e891d5be9c6f87b1299c9a0628",
      "a694fcf5c3308d1b4b4938cbae48325ad675722cb4e467ed0c39188b99632c7a",
      "a7dbfce35c74df5e429cf0acbda8289bb5210e043202eb674775d2d200e042bd",
      "61bdf7c236673015c1fe47c727bf0b64315242c12d7b271d0c4849f99d115569",
      "910582e47939b506c4752b732461fe3c2d8395438122b3effef03d7c1506bedf",
      "62cca0160f98b7edd9dc72df0494192241b9459ed2560dfeb5a6269e5f59313f",
      "53880789c730dd79aad96464d993cf2060153b48032da54356ef32e6760e1049",
      "7c9e953027cc58010fc8ff35f249b6c6a8ca4c0bc0e30a3791d38477031c62e8",
      "0a60f910e1a7fdcc1d81769a12a638584ebf9f29f657c35c0c09700e88cafaeb",
      "9a0a740b0f41c36f825f5bf699227245f14919897a1cb3eec75050123cf58127",
    ]);
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(29, 31).map((item) =>
      canonicalEvidenceHash(item.requiredTokens))).toEqual([
      "849ad7b319ba3091229c5b3d2145a51914bea70b35182a04ba43b3dac85e6bb6",
      "c1753db3b48b98997b492997b8588d5119f3a6183e8f546e934e73a5ef8397f6",
    ]);
    expect(hasExactTerminalInputItemKeyCoverage(["3:6", "3:7"], ["3:7", "3:6"])).toBe(true);
    expect(hasExactTerminalInputItemKeyCoverage(["3:6", "3:7"], ["3:6", "9:21"])).toBe(false);
    expect(hasExactTerminalInputItemKeyCoverage(["3:6", "3:6"], ["3:6", "3:6"])).toBe(false);
  });

  it.skipIf(!existsSync(q30ManualProblemPath) || !existsSync(q18ManualProblemPath) ||
    !existsSync(q32ManualProblemPath))(
    "pins and applies the Q30/Q18/Q32 nested manual revisions and Q32 source reversion",
    () => {
    expect(PROBLEM_MANUAL_REVISION_ALLOWLIST).toEqual([expect.objectContaining({
      allowlistId: "ebsi-5578421-q30-manual-revision-v1",
      parentAllowlistId: "ebsi-5578421-q30-manual-v1",
      entryId: "ebsi:5578421",
      key: "12:30",
      sourcePage: 12,
      sourceHash: cases[1].sourceHash,
      failedQuestionHash: "08ac10119b14fcad17f0d4f8f988198d8049d2d06d19b3b16cfd4d805e4ba010",
      failedClassificationHash: "b9134b6b9fd3cd9e274bd4883f370dd794f1c5f0d2e7d573d1d2b949dcff9ff7",
      failedClassificationEvidenceHash: "e96fd127cbadd152281d8bf436e2052d15863abdf208b06af9c650e68b3c6c13",
      expectedDecision: "accept",
      expectedCanonicalSubject: "korean_reading",
    }), expect.objectContaining({
      allowlistId: "ebsi-5656593-q18-manual-revision-v1",
      parentAllowlistId: "ebsi-5656593-q18-manual-v1",
      entryId: "ebsi:5656593",
      key: "7:18",
      sourcePage: 7,
      sourceHash: cases[3].sourceHash,
      failedQuestionHash: "2ee7a2fc3b6ac355c2e88de3cec5005d6f31b6caf1dd042019190d05dca06484",
      failedClassificationHash: "cd8e788264d66fb0413604efbff3b1fdfef2c968d3f79fbb377df8bbaab67c26",
      failedClassificationEvidenceHash: "1bdb0cdfbb305d5407cdb8d711efec1e2291cf2ef8a07026f2ee64781f8f8316",
      expectedDecision: "reject",
    }), expect.objectContaining({
      allowlistId: "ebsi-5525982-q32-manual-revision-v1",
      parentAllowlistId: "ebsi-5525982-q32-manual-v1",
      entryId: "ebsi:5525982",
      key: "12:32",
      sourcePage: 12,
      sourceHash: "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
      failedQuestionHash: "e3f26787b00f65c346910a688088f941dce1b8b872e330491da0b61a8e3f5269",
      failedClassificationHash: "cf31dadc1233e5aef9e940d882a54c316fb1398c18f520d242103a40c8033ae3",
      failedClassificationEvidenceHash: "5ee5ce7694d4178d8047f9d1e30e326058c1af244e43eaacb11aad257d0abc18",
      expectedDecision: "accept",
      expectedCanonicalSubject: "korean_literature",
    }), expect.objectContaining({
      allowlistId: "ebsi-5578421-q19-manual-revision-v1",
      parentAllowlistId: "ebsi-5578421-q19-manual-v1",
      failedStatus: "exact",
    }), expect.objectContaining({
      allowlistId: "ebsi-5578421-q20-manual-revision-v1",
      parentAllowlistId: "ebsi-5578421-q20-manual-v1",
    }), expect.objectContaining({
      allowlistId: "ebsi-5578421-q21-manual-revision-v1",
      parentAllowlistId: "ebsi-5578421-q21-manual-v1",
      failedStatus: "exact",
    }), expect.objectContaining({
      allowlistId: "ebsi-5578421-q44-manual-revision-v1",
      parentAllowlistId: "ebsi-5578421-q44-manual-v1",
      entryId: "ebsi:5578421",
      key: "16:44",
      failedQuestionHash: "699e118886163261c7dfa82ae3b664c44c4b2b4de73cfb304df740161e645342",
      failedClassificationHash: "092153fdc6ba6c49d80144585e93265c9c83e4e03d590fac0a58176fd7027114",
      failedClassificationEvidenceHash: "6751546e7ea91f938c401619dbf68d865fa704c8e2a31180da410db1cd29bdca",
    }), expect.objectContaining({
      allowlistId: "ebsi-5578421-q45-manual-revision-v1",
      parentAllowlistId: "ebsi-5578421-q45-manual-v1",
      entryId: "ebsi:5578421",
      key: "16:45",
      failedQuestionHash: "24999c59ff5e789d6193f2635937d9d56c380cda4bc9786fb327a8d1f8536b20",
      failedClassificationHash: "ad8f46855df3600d237d2c8c1f1292d8ffac0a0186844c38416bd9c5bb835d2c",
      failedClassificationEvidenceHash: "2822d905a100f103c3b475c1917fc8a9dd711f3a1c8cdf7aed584413d042d5aa",
    }), expect.objectContaining({
      allowlistId: "ebsi-5578421-q14-manual-revision-v1",
      parentAllowlistId: "ebsi-5578421-q14-manual-v1",
      entryId: "ebsi:5578421",
      key: "5:14",
      failedQuestionHash: "0218c03170cbb7b5e03b5119d99cb1e71a14c9f4b36926893d7e0297517fee62",
      failedClassificationHash: "c14153a1d075664b123e836da971481f093dc88bcb2f4d275464833309287739",
      failedClassificationEvidenceHash: "870b857359eea9ecdff9f2182b6c6d27d437cfad88dbcfbd92141ab8ea8c1f20",
    }), expect.objectContaining({
      allowlistId: "ebsi-5578421-q2-manual-revision-v1",
      parentAllowlistId: "ebsi-5578421-q2-manual-v1",
    }), expect.objectContaining({
      allowlistId: "ebsi-5577054-q42-manual-revision-v1",
      parentAllowlistId: "ebsi-5577054-q42-manual-v1",
    }), expect.objectContaining({
      allowlistId: "ebsi-5577054-q20-manual-revision-v1",
      parentAllowlistId: "ebsi-5577054-q20-manual-v1",
    }), expect.objectContaining({
      allowlistId: "ebsi-5577054-q21-manual-revision-v1",
      parentAllowlistId: "ebsi-5577054-q21-manual-v1",
    }), expect.objectContaining({
      allowlistId: "ebsi-5577054-q22-manual-revision-v1",
      parentAllowlistId: "ebsi-5577054-q22-manual-v1",
    }), expect.objectContaining({
      allowlistId: "ebsi-5577054-q25-manual-revision-v1",
      parentAllowlistId: "ebsi-5577054-q25-manual-v1",
    }), expect.objectContaining({
      allowlistId: "ebsi-5577054-q26-manual-revision-v1",
      parentAllowlistId: "ebsi-5577054-q26-manual-v1",
    }), expect.objectContaining({
      allowlistId: "ebsi-5577054-q24-source-manual-revision-v1",
      parentAllowlistId: "ebsi-5577054-q24-source-manual-v1",
    })]);
    expect(PROBLEM_MANUAL_REVISION_ALLOWLIST.map(canonicalEvidenceHash)).toEqual([
      "479ebd4d7b57bd6ead1a4082b29d8c8c2cba1c7ebdb21634a3eda063986480b4",
      "9c38bfeaa57af0929eb5ec4f4a466588a5be42e59ff7be77576778d11a985792",
      "465a68f6f512ddc4e288552122287f9772ce3bddf63099b776dc5ab47663c943",
      "e27383cba8efdb66d85ac3e5c0c2632ec646182c54764039aff3687da458c2cc",
      "647a2d54b19dc3e2b47e46f6b2905c84bd5f36d257b9378a78bedc229c6073c6",
      "bb73db45feca8b695f6865792b5a86567bc0e6dda426bba14276c57867eb9cf4",
      "41d2518dfff51233a9604956b19ea7cfe8d53a7257f80958a05565ddadcadaaf",
      "b3742ae0758ddba275a8131de206fc86e3bea2f0bfdfde9dadb0eb10be8baa00",
      "30bdb578aac86abb60471c18d06a6f5231101a46d7c3ab753a266789e2613d25",
      "7fec9a6782faf9cc6e59837c3528335963319fabc58ea1b7adfaeb25651028e5",
      "16ca1e7fb9f94fd2da81648e0f408706ccc67966c14d812ae12f80848a6c639c",
      "46b8c9b0c1548b1409d689f49da6bd0ca3028869418b5cdb7d1385890be2d0b7",
      "07ab54dc62ff0c4bd31034f7b96b1a491215108793e8d5eb7ad0780bd0da75fe",
      "67e4f2c4a3c804602bff19688eedde97e80abcbc78b550bc5378e2b659ea3199",
      "459f288b444fdddfc628dfc17f4e7fc8d7fc9a06aac82ffc6e099ffddf35a624",
      "5648333450aefbc92992ab60dd6bd722ccdb95a914aac4d6f290a704b0a8d821",
      "8b60b677474f2460b70fb8441d45c8727ce1cb3a42ea22519d86a469042ed685",
    ]);
    const parent = JSON.parse(readFileSync(q30ManualProblemPath, "utf8")).item as QuizItemEx;
    expect(canonicalEvidenceHash(parent)).toBe(PROBLEM_MANUAL_REVISION_ALLOWLIST[0].failedQuestionHash);
    const revised = applyAllowlistedProblemManualRevision(
      "ebsi:5578421",
      cases[1].sourceHash,
      "ebsi-5578421-q30-manual-v1",
      parent
    );
    expect(revised).toEqual({
      ...parent,
      question: parent.question.replace(
        "그리고 단순 명제 ‘$p$’와 ‘$q$’를 ‘만약 …이면 …이다.’에 해당하는 논리적 연결사",
        "그리고 단순 명제 ‘$p$’와 ‘$q$’는 ‘만약 …이면 …이다.’에 해당하는 논리적 연결사"
      ),
    });
    expect(revised.question.match(/‘\$p\$’와 ‘\$q\$’는 ‘만약/gu)).toHaveLength(1);
    expect(revised.question).not.toContain("‘$p$’와 ‘$q$’를 ‘만약");

    const q18Parent = JSON.parse(readFileSync(q18ManualProblemPath, "utf8")).item as QuizItemEx;
    expect(canonicalEvidenceHash(q18Parent)).toBe(PROBLEM_MANUAL_REVISION_ALLOWLIST[1].failedQuestionHash);
    const q18Revised = applyAllowlistedProblemManualRevision(
      "ebsi:5656593",
      cases[3].sourceHash,
      "ebsi-5656593-q18-manual-v1",
      q18Parent
    );
    expect(q18Revised).toEqual({
      ...q18Parent,
      question: q18Parent.question.replace(
        "세 점 $L_1$, $M_1$, $N_1$이 각각 $\\overline{A_1B_1}$, $\\overline{B_1C_1}$, " +
          "$\\overline{C_1A_1}$의 중점이고,",
        "세 선분 $A_1B_1$, $B_1C_1$, $C_1A_1$의 중점을 각각 $L_1$, $M_1$, $N_1$이라 하고,"
      ),
    });
    expect(canonicalEvidenceHash(q18Revised))
      .toBe("b67987dc571ad92d8c456cd7b6936a26e9434e42ce3dddb5f78057748e99717b");

    const q32Parent = JSON.parse(readFileSync(q32ManualProblemPath, "utf8")).item as QuizItemEx;
    expect(canonicalEvidenceHash(q32Parent)).toBe(PROBLEM_MANUAL_REVISION_ALLOWLIST[2].failedQuestionHash);
    const q32Revised = applyAllowlistedProblemManualRevision(
      "ebsi:5525982",
      "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
      "ebsi-5525982-q32-manual-v1",
      q32Parent
    );
    expect(q32Revised.question).toContain("(서연 곁으로 가서 개울물을 바라본다). 물 위에 비쳐 보여요");
    expect(q32Revised.question).toContain("(물을 떠서 마신다). 물이 맑고 시원해요.");
    expect(q32Revised.question).not.toContain("개울물을 바라본다.)");
    expect(q32Revised.question).not.toContain("물을 떠서 마신다.)");
    expect(canonicalEvidenceHash(q32Revised))
      .toBe("e3649d8930138bdc731c8642e24507e5d98f12da8d83503877ef92c3f31981bb");
    expect(PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST).toEqual([expect.objectContaining({
      allowlistId: "ebsi-5525982-q32-manual-source-revision-v1",
      parentRevisionAllowlistId: "ebsi-5525982-q32-manual-revision-v1",
      parentRevisionEvidenceHash: "944ad7e2ab07ffff727e3ac8923cfbee5b9e0499610a82eca37ccd7309c0abbd",
      failedQuestionHash: "e3649d8930138bdc731c8642e24507e5d98f12da8d83503877ef92c3f31981bb",
      failedClassificationHash: "e052bfaae96839742bad356f8235d214202d18baeb4bf3cc24d7e485b8042e2b",
      failedClassificationEvidenceHash: "d403219ab15a4d2584fb01f1abbed234cc824de7a7ef2df1e75f433c7442b205",
    }), expect.objectContaining({
      allowlistId: "ebsi-5578421-q30-manual-source-revision-v1",
      parentRevisionAllowlistId: "ebsi-5578421-q30-manual-revision-v1",
      parentRevisionEvidenceHash: "0b62182d67272fae88d147ddb2e80e4b4b973b16955d5c84215d7af831197be8",
      failedQuestionHash: "cea6b791cba1ff2a19529d13cdd2c9fdef774bb5d17174e1ef1d2bfc6ad7c5fb",
      failedClassificationHash: "c5868275075ef9d18656313b2cecb97fdc9b3d2d6c6a4e8b728365aea7c8b786",
      failedClassificationEvidenceHash: "7d34789e5db02ef74ce06f85cbdee6c87318cd450bd9c9359f6688c7746b06e6",
    }), expect.objectContaining({
      allowlistId: "ebsi-5578421-q2-manual-source-revision-v1",
      parentRevisionAllowlistId: "ebsi-5578421-q2-manual-revision-v1",
    }), expect.objectContaining({
      allowlistId: "ebsi-5578421-q21-manual-source-revision-v1",
      parentRevisionAllowlistId: "ebsi-5578421-q21-manual-revision-v1",
    }), expect.objectContaining({
      allowlistId: "ebsi-5578421-q45-manual-source-revision-v1",
      parentRevisionAllowlistId: "ebsi-5578421-q45-manual-revision-v1",
    }), expect.objectContaining({
      allowlistId: "ebsi-5577054-q42-manual-source-revision-v1",
      parentRevisionAllowlistId: "ebsi-5577054-q42-manual-revision-v1",
    }), expect.objectContaining({
      allowlistId: "ebsi-5577054-q25-manual-source-revision-v1",
      parentRevisionAllowlistId: "ebsi-5577054-q25-manual-revision-v1",
    }), expect.objectContaining({
      allowlistId: "ebsi-5577054-q26-manual-source-revision-v1",
      parentRevisionAllowlistId: "ebsi-5577054-q26-manual-revision-v1",
    }), expect.objectContaining({
      allowlistId: "ebsi-5577054-q24-source-manual-source-revision-v1",
      parentRevisionAllowlistId: "ebsi-5577054-q24-source-manual-revision-v1",
    })]);
    expect(PROBLEM_MANUAL_SOURCE_REVISION_ALLOWLIST.map(canonicalEvidenceHash)).toEqual([
      "e6287eb8f4eaef8f24099c08afc13d077ad7792a1345f0296b7ce39fa4b07d39",
      "5a41a08c9612227e83e4de3d53a6559a8cf37f515193cc783b7e51def4930743",
      "99ec8e696ea73ba0c61d31df0df9f657bcb29e62fa6ff43e8db1389542e821aa",
      "4c70814866ee7bcff53e2bb652f35158d4eada24cc14699fbcac2af4dc38a4a1",
      "d1838baa7e6f533817722fca9207e3ca354e28c72b0474691cd17d950dbeeaa3",
      "e34815c9d14643ee14f5bc34771ceb9f97894ad319a3878b1fd198db15acd999",
      "fb0e07e1a2d61a37d88b80c7c77711cbadca4ce683f00860f59cd9c0df1f1ad4",
      "bb119e25661bf68d086a708a69041e897a53b4491867f0b75fb436783c4ec358",
      "4e92cf767ddfc201646f04d3b24a494f1005745cad0261a565cd3e33d3f3b091",
    ]);
    const q30SourceRevised = applyAllowlistedProblemManualSourceRevision(
      "ebsi:5578421",
      cases[1].sourceHash,
      "ebsi-5578421-q30-manual-revision-v1",
      revised
    );
    expect(canonicalEvidenceHash(q30SourceRevised))
      .toBe("275d974518a67e12ed1b52c77fdb3fedbdf49e8673640c2195661a2a735aea2f");
    expect(q30SourceRevised.question).toContain("‘걷는다’와 같이 동사인 경우");
    expect(q30SourceRevised.question).toContain("단순 명제라 하여 ‘$p$, $q$, $r$’");
    expect(q30SourceRevised.question).toContain("논증의 타당성을 평가했다.");
    expect(q30SourceRevised.question).toContain("<결론>인 $q$가");
    expect(q30SourceRevised.question).not.toContain("‘걷는다’와 같은 동사인 경우");
    expect(q30SourceRevised.question).not.toContain("단순 명제라 하며 ‘$p$, $q$, $r$’");
    expect(q30SourceRevised.question).not.toContain("논증의 타당성을 평가한다.");
    expect(q30SourceRevised.question).not.toContain("<결론>의 $q$가");
    const q32SourceRevised = applyAllowlistedProblemManualSourceRevision(
      "ebsi:5525982",
      "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
      "ebsi-5525982-q32-manual-revision-v1",
      q32Revised
    );
    expect(canonicalEvidenceHash(q32SourceRevised))
      .toBe("e3f26787b00f65c346910a688088f941dce1b8b872e330491da0b61a8e3f5269");
    expect(q32SourceRevised).toEqual(q32Parent);
  });

  it.skipIf(!existsSync(join(
    q27LiveState,
    "problem-terminal-fidelity/v2-0000-01acbf628ec2f45a8c7024b7851c396c3e9b5ad12c59480ec573ecb8e6d5028e-" +
      "4bc1636d679f790075a71a3f79c5a35e522dac90ccb5c40d60137fadb952dd22.json"
  )))("partitions only Q8 and Q23 out of the pinned 01ac terminal issues", () => {
    const terminal = JSON.parse(readFileSync(join(
      q27LiveState,
      "problem-terminal-fidelity/v2-0000-01acbf628ec2f45a8c7024b7851c396c3e9b5ad12c59480ec573ecb8e6d5028e-" +
        "4bc1636d679f790075a71a3f79c5a35e522dac90ccb5c40d60137fadb952dd22.json"
    ), "utf8")) as { items: Array<{ key: string; status: string }> };
    const terminalIssues = terminal.items.filter((item) => item.status !== "exact").map((item) => item.key);
    expect(terminalIssues).toEqual([
      "4:8", "7:18", "7:19", "9:21", "9:22", "9:23", "9:24", "9:25", "9:26", "12:32", "15:39",
    ]);
    const deferred = new Set(["4:8", "9:23"]);
    expect(actionableTerminalFidelityIssues(terminalIssues, deferred)).toEqual([
      "7:18", "7:19", "9:21", "9:22", "9:24", "9:25", "9:26", "12:32", "15:39",
    ]);
    expect(() => actionableTerminalFidelityIssues(["4:8", "9:23"], deferred))
      .toThrow("terminal fidelity 최종 adjudication 대기: 4:8, 9:23");
    expect(() => actionableTerminalFidelityIssues(["4:8"], deferred))
      .toThrow("deferred terminal fidelity issue가 terminal issue 집합에 없습니다");
  });

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "completes true repairs without touching Q8 or Q23 before the fresh terminal boundary",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-terminal-defer-live-"));
    cpSync(q27LiveState, root, { recursive: true });
    rmSync(join(root, SOLUTION_SOURCE_REVISION_ALLOWLIST[0].parentRepairArtifact.path));
    rmSync(join(root, SOLUTION_SOURCE_REVISION_ALLOWLIST[0].parentFidelityArtifact.path));
    rmSync(join(root, "solution-source-revisions"), { recursive: true, force: true });
    rmSync(join(root, "solution-fidelity-source-revisions"), { recursive: true, force: true });
    for (const directory of ["solution-repairs", "solution-fidelity-repairs"]) {
      const removed = readdirSync(join(root, directory)).flatMap((name) => {
        const match = /^v2-\d{4}-(\d{4})-[a-f0-9]{64}-[a-f0-9]{64}\.json$/u.exec(name);
        if (!match) return [];
        const number = Number(match[1]);
        if (number < 41 || number > 45) return [];
        rmSync(join(root, directory, name));
        return [number];
      });
      expect(removed.sort((left, right) => left - right), directory).toEqual([41, 42, 43, 44, 45]);
    }
    for (const directory of ["semantic-choice-checks", "answer-audit", "answer-attestation"]) {
      rmSync(join(root, directory), { recursive: true, force: true });
    }
    const seededRepairNumbers = readdirSync(join(root, "solution-repairs"))
      .map((name) => Number(/^v[12]-\d{4}-(\d{4})-/u.exec(name)?.[1]));
    expect(SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0].items.slice(0, 11)
      .every((spec) => seededRepairNumbers.includes(Number(spec.key.split(":")[1])))).toBe(true);
    expect(seededRepairNumbers.some((number) => number >= 41 && number <= 45)).toBe(false);
    const terminalRelativePath =
      "problem-terminal-fidelity/v2-0000-01acbf628ec2f45a8c7024b7851c396c3e9b5ad12c59480ec573ecb8e6d5028e-" +
      "4bc1636d679f790075a71a3f79c5a35e522dac90ccb5c40d60137fadb952dd22.json";
    expect(hash(readFileSync(join(root, terminalRelativePath))))
      .toBe("3a44b3aaf83126f90c7ec8f5fd7cc1d15f5c9e9d48420fc9bd2f21b542765b48");
    const deferredSnapshot = () => stateSnapshot(root).filter(([path]) =>
      /v1-0004-0008-|v1-0009-0023-/u.test(path) ||
      path.startsWith("problem-terminal-fidelity-adjudications/") ||
      path.startsWith("problem-terminal-fidelity-policy-revisions/")
    );
    const before = deferredSnapshot();
    const terminalBefore = stateSnapshot(join(root, "problem-terminal-fidelity"));
    const providerCalls: Array<{ schema: string; requested: string[] }> = [];
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      const schema = request.schema?.name ?? "unknown";
      if (schema === "studywork_exam_corpus_classification") {
        const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
          key: string;
          question: string;
        }>;
        const requested = items.map((item) => item.key);
        providerCalls.push({ schema, requested });
        expect(requested.every((key) => [
          ...terminalRecoveryManualKeys,
          "7:18", "7:19", "12:32", "15:39",
        ].includes(key))).toBe(true);
        return { text: JSON.stringify(items.map((item) => ({
          key: item.key,
          decision: ["3:6", "3:7"].includes(item.key) ? "reject" : "accept",
          canonical_subject: ["3:6", "3:7"].includes(item.key)
            ? null
            : ["12:32", "9:21", "9:22", "9:24", "9:25", "9:26"].includes(item.key)
              ? "korean_literature"
              : "korean_reading",
          curriculum_course: ["3:6", "3:7"].includes(item.key)
            ? null
            : ["12:32", "9:21", "9:22", "9:24", "9:25", "9:26"].includes(item.key)
              ? "문학"
              : "독서와 작문",
          domain: ["3:6", "3:7"].includes(item.key)
            ? null
            : ["12:32", "9:21", "9:22", "9:24", "9:25", "9:26"].includes(item.key)
              ? "문학 작품의 맥락과 표현 이해"
              : "비문학 제시문의 추론적 읽기",
          achievement_codes: ["3:6", "3:7"].includes(item.key)
            ? []
            : [["12:32", "9:21", "9:22", "9:24", "9:25", "9:26"].includes(item.key)
                ? "12문학01-03"
                : "12독작01-04"],
          confidence: 0.99,
          reason_codes: ["SOURCE_EXACT"],
          transcription_status: "exact",
          transcription_evidence: `공식 source pixel과 ${item.key} 전체 문항이 일치한다.`,
        }))) };
      }
      if (schema === "studywork_exam_corpus_problem_terminal_fidelity") {
        providerCalls.push({ schema, requested: [] });
        const items = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{
          key: string;
          question: string;
        }>;
        expect(items).toHaveLength(45);
        expect(new Set(items.map((item) => item.key)).size).toBe(45);
        expect(items.find((item) => item.key === "4:8")?.question)
          .toContain("기사형 광고는 기사처럼 보이는 광고를 말한다.");
        expect(items.find((item) => item.key === "7:18")?.question)
          .toContain("경험을 통한 시험의 대상");
        expect(items.find((item) => item.key === "7:19")?.question)
          .toContain("선택하겠지만 실용적 필요");
        expect(items.find((item) => item.key === "12:32")?.question)
          .toContain("(물을 떠서 마신다.) 물이 맑고 시원해요.");
        expect(items.find((item) => item.key === "15:39")?.question)
          .toContain("39. [가]를 바탕으로 <보기>의 상황을 이해한 내용으로 적절한 것은?");
        expect(items.find((item) => item.key === "9:23")?.question)
          .toContain("이들 간의 대립 구도 하에서 전개되는 이야기는");
        expect(items.find((item) => item.key === "9:23")?.question)
          .toContain("외적의 침략이나 이념 갈등과 같은 공동체 사이의 갈등");
        throw new Error("seeded fresh true-repair terminal boundary");
      }
      if (schema !== "studywork_file_quiz_items") {
        providerCalls.push({ schema, requested: [] });
        if (schema === "studywork_exam_corpus_solution_fidelity") {
          const decisions = q5525982FidelityDecisions(request.prompt);
          if (decisions.length > 1) return { text: JSON.stringify(decisions) };
          throw new Error(`seeded true-repair solution fidelity boundary: ${decisions[0].key}`);
        }
        if (schema === "studywork_solution_file_items") {
          const number = request.prompt.match(/printed solution (\d+)/u)?.[1] ?? "unknown";
          providerCalls.at(-1)!.requested = [`15:${number}`];
          expect(number).toBe("40");
          throw new Error(`seeded true-repair targeted solution boundary: ${number}`);
        }
        throw new Error(`unexpected defer-gate provider call: ${schema}`);
      }
      const single = request.prompt.match(/printed problem (\d+) starting on page (\d+)/u);
      const batch = request.prompt.match(/printed problems: ([^\n.]+)/u);
      const requested = single
        ? [`${single[2]}:${single[1]}`]
        : (batch?.[1].match(/\d+/gu) ?? []).map((number) => `9:${number}`);
      providerCalls.push({ schema, requested });
      throw new Error("unexpected generic recovery before fresh true-repair terminal");
    });
    const input = q27FixtureInputs(root);
    const boundary = await repairAndAuditOfficialAnswers(
      input.entry,
      input.problem,
      input.solution,
      root,
      input.classified,
      input.solutions
    ).then(() => "resolved unexpectedly", (error: unknown) => error instanceof Error ? error.message : String(error));
    expect(boundary).toBe("seeded true-repair targeted solution boundary: 40");
    expect(providerCalls.filter((call) => call.schema === "studywork_solution_file_items"))
      .toEqual([{ schema: "studywork_solution_file_items", requested: ["15:40"] }]);
    expect(providerCalls.length).toBeGreaterThan(0);
    const requested = [...new Set(providerCalls
      .filter((call) => call.schema === "studywork_exam_corpus_classification")
      .flatMap((call) => call.requested))].sort();
    // The copied live fixture already persisted all seven terminal-recovery manual classifiers.
    expect(requested).toEqual([]);
    expect(terminalRecoveryManualKeys.map((key) => {
      const [page, number] = key.split(":").map(Number);
      const prefix = `v1-${String(page).padStart(4, "0")}-${String(number).padStart(4, "0")}-`;
      const names = readdirSync(join(root, "classification-manual-adjudications"))
        .filter((name) => name.startsWith(prefix));
      expect(names, key).toHaveLength(1);
      const checkpoint = JSON.parse(readFileSync(join(root, "classification-manual-adjudications", names[0]), "utf8"));
      expect(checkpoint.items, key).toEqual([expect.objectContaining({ key, transcription_status: "exact" })]);
      return key;
    })).toEqual(terminalRecoveryManualKeys);
    expect(requested).not.toContain("4:8");
    expect(requested).not.toContain("9:23");
    expect(deferredSnapshot()).toEqual(before);
    expect(stateSnapshot(join(root, "problem-terminal-fidelity"))).toEqual(terminalBefore);
    expect(existsSync(join(root, "answer-audit"))).toBe(false);
    expect(existsSync(join(root, "answer-attestation"))).toBe(false);
  }, 300_000);

  it.skipIf(!available)("applies the exhaustive Q34 literal correction to the pinned crop child", () => {
    const corrected = applyAllowlistedProblemManualCorrection(cases[0].entryId, cases[0].sourceHash, itemAt(0));
    expect(corrected.question).toContain("문밖에서 삼월이 아뢰었다");
    expect(corrected.question).toContain("수천 번을 뚜드려 만든 쇠붙이 같으다");
    expect(corrected.question).toContain("적과 적의 칼이");
    expect(corrected.question).toContain("아씬 절로 가시야겄십니다");
    expect(corrected.question).toContain("가마가 내려지고 어머니가 뜰에 나섰\n[B]\n을 때");
    expect(corrected.question).toContain("치수의 두 눈에서 O.L*\n");
    expect(corrected.question).not.toMatch(/갑월|나오리|쌩쌩이|쾌척|회피였고|당황했다/u);
    expect(corrected.question.match(/^― /gmu)).toHaveLength(2);
    expect(corrected.figure_description).toContain("왼쪽 세로 묶음 괄호가 3개");
    expect(corrected.figure_description).toContain("가로 캡은 모두 6개");
    expect(corrected.figure_description).toContain("[A], ㉮, [B] 표지");
  });

  it.skipIf(!available)("preserves Q30/Q18 diagram roles and Q8 open/filled graph states", () => {
    const q30 = applyAllowlistedProblemManualCorrection(cases[1].entryId, cases[1].sourceHash, itemAt(1));
    expect(q30.question).toContain("㉢ 명제 논리학");
    expect(q30.question).toContain("$p$이다.                  ⇒       $p$");
    expect(q30.question).toContain("────────                         ────────");
    expect(q30.figure_description).toContain("가로선은 총 2개");
    expect(q30.figure_description).toContain("두 전제와 한 결론");

    const q8 = applyAllowlistedProblemManualCorrection(cases[2].entryId, cases[2].sourceHash, itemAt(2));
    expect(q8.figure_description).toContain("원점 $O=(0,0)$에는 뚫린 점");
    expect(q8.figure_description).toContain("$(0,-2)$에는 채운 점");
    expect(q8.figure_description).toContain("$(1,-3)$에는 뚫린 점");

    const q18 = applyAllowlistedProblemManualCorrection(cases[3].entryId, cases[3].sourceHash, itemAt(3));
    expect(q18.question.match(/호 \$\\overset\{\\frown\}\{N_1L_1\}\$/gu)).toHaveLength(2);
    expect(q18.question.match(/\[단일 곡선삼각형 도형문자\]/gu)).toHaveLength(2);
    expect(q18.question.match(/\[세 단일 곡선삼각형이 결합된 복합 도형문자\]/gu)).toHaveLength(2);
    expect(q18.question).not.toContain("△ 모양의 도형");
    expect(q18.figure_description).toContain("읽는 순서는 단일, 단일, 복합, 복합");
    expect(q18.figure_description).toContain("호 표기는 정확히 2회");
    expect(q18.figure_description).toContain("$R_1$, $R_2$, $R_3$ 세 단계 그림");
  });

  it.skipIf(!available)("corrects Q9 stem and all three wrong map labels while preserving C/D", () => {
    const q9 = applyAllowlistedProblemManualCorrection(cases[4].entryId, cases[4].sourceHash, itemAt(4));
    expect(q9.question).toContain("국가를 지도의 A~E에서 고른 것은?");
    expect(q9.question).not.toContain("지도에서 A~E에서");
    expect(q9.figure_description).toContain("A는 노르웨이");
    expect(q9.figure_description).toContain("B는 베트남");
    expect(q9.figure_description).toContain("C는 뉴질랜드");
    expect(q9.figure_description).toContain("D는 아르헨티나");
    expect(q9.figure_description).toContain("E는 베네수엘라");
    expect(q9.figure_description).not.toMatch(/영국|필리핀|파나마/u);
  });

  it.skipIf(!available)("applies all nine source-exact Q9 writing-plan corrections", () => {
    const q9 = applyAllowlistedProblemManualCorrection(cases[5].entryId, cases[5].sourceHash, itemAt(5));
    expect(q9.question).toContain("[9 ~ 10] 다음을 읽고 물음에 답하시오.");
    expect(q9.question).toContain("[글의 구상 도식]\n- 중앙: 그릿 / Grit");
    expect(q9.question).toContain("- 강연: ⓒ 강연 핵심 요약, ⓓ 강연을 들은 후 변화된 생각");
    expect(q9.question).toContain("천재들만 받는다는 맥아더 펠로상의 수상자");
    expect(q9.question).toContain("주변의 막연한 충고는 마음에 와 닿지 않았다.");
    for (const marker of ["㉠ 그릿", "㉡ 그릿", "㉢ 주목", "㉣ 그러나", "㉤ 떠올리고"]) {
      expect(q9.question).toContain(marker);
    }
    expect(q9.question).not.toMatch(/중심 주제:|강연 핵심 묘사|‘맥아더 펠로상’|㉠그릿|㉡그릿|㉢주목|㉣그러나|㉤떠올리고/u);
    expect(q9.figure_description).toContain("중앙에서 세 갈래 곡선이 뻗는다");
    expect(q9.figure_description).toContain("ⓐ, ⓑ, ⓒ, ⓓ, ⓔ는 각각 정확히 한 번 보인다");
  });

  it.skipIf(!available)("replaces the whole failed Q43 passage with the exact p15-p16 source", () => {
    const failed = itemAt(6);
    const spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[6];
    expect(spec.replacements).toEqual([expect.objectContaining({
      field: "question",
      from: failed.question,
      count: 1,
    })]);
    const corrected = applyAllowlistedProblemManualCorrection(cases[6].entryId, cases[6].sourceHash, failed);
    expect(corrected.question).toContain("[43 ~ 45] 다음을 읽고 물음에 답하시오.");
    expect(corrected.question).toContain("시를 믿고 어떻게 살어가나");
    expect(corrected.question).toContain("먼― 기적(汽笛) 소리 처마를 스쳐가고");
    expect(corrected.question).toContain("잠들은 아내와 어린것의 벼개 맡에");
    expect(corrected.question).toContain("등불이 나에게 속삭어린다.");
    expect(corrected.question).toContain("운암댐 소롯길에 서서");
    expect(corrected.question).toContain("머언 먼 순은의 눈나라에서나 배웠음직한 몸짓이랑");
    expect(corrected.question).toContain("네 가슴에 못 박혀 삭고 싶은 속된 내 그리움은 또");
    expect(corrected.question).toContain("저 운암의 겨울새들의 행로를 보아버린 죄로");
    expect(corrected.question).toContain("- 김광균, ｢ 노신 ｣ -");
    expect(corrected.question).toContain("- 복효근, ｢ 새에 대한 반성문 ｣ -");
    expect(corrected.question).toContain("43. (가)와 (나)의 공통점에 대한 설명으로 가장 적절한 것은?");
    expect(corrected.question).not.toMatch(/살아가나|차마를|베개 밑에|속삭거린다|몽당비자루|소줏집|아슴차니|순순의|살고 싶은|저 운하의/u);
    expect(corrected.question.match(/^\[[ABC]\]$/gmu)).toEqual(["[A]", "[B]", "[C]"]);
    expect(corrected.choices).toEqual(failed.choices);
    expect(corrected.figure_description).toContain("왼쪽으로 열린 세로 묶음 괄호가 정확히 3개");
    expect(corrected.figure_description).toContain("서로 겹치지 않는 [A], [B], [C] 순서");
  });

  it.skipIf(!available)("replaces the whole Q27 passage and its one source-wrong choice", () => {
    const failed = itemAt(7);
    const spec = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[7];
    expect(spec.replacements).toEqual([expect.objectContaining({
      field: "question",
      from: failed.question,
      count: 1,
    }), expect.objectContaining({
      field: "choices",
      from: failed.choices?.[2],
      count: 1,
    })]);
    const corrected = applyAllowlistedProblemManualCorrection(cases[7].entryId, cases[7].sourceHash, failed);
    expect(canonicalEvidenceHash(corrected))
      .toBe("0364d049bef73773465b13f09fa2f234e9c7fc4ef4f9f9bdefeef0a8692c457b");
    expect(corrected.question).toContain("[27 ~ 32] 다음 글을 읽고 물음에 답하시오.");
    expect(corrected.question).toContain("이다지 낡아빠진 생활을 하는 것은 아니리라");
    expect(corrected.question).toContain("함이정 : 처녀 때 난 생각했었지.");
    expect(corrected.question).toContain("때를 놓치지 않으려는 듯 함묘진이 다급하게");
    expect(corrected.question).toContain("27. (가)를 이해한 내용으로 적절하지 않은 것은?");
    expect(corrected.question).not.toMatch(/이지러 낡아빠진|아니라라/u);
    expect(corrected.choices?.[2]).toBe(
      "③ 화자는 ‘고생도 마음대로 할 수 없는 세상’에서 ‘존재 없이’ 살아가는 것이 어렵다고 느끼고 있다."
    );
    expect(corrected.figure).toBe(true);
    expect(corrected.figure_description).toContain("왼쪽으로 열린 세로 묶음 괄호 [A]");
    expect(corrected.figure_description).toContain("같은 모양의 세로 묶음 괄호 [B]");
  });

  it.skipIf(!available)("replaces the exact Q43-Q45 source items without changing their answers", () => {
    const expected = [
      [8, "87113019baba8982c876c340bc9f85cfdc2196c2c8bff520495ec09fca91e0b4"],
      [9, "d1442d6b9b32e207e702dbfb8c4135ceb992d54b48b599f423eb70812bf10086"],
      [10, "ac66722a22fa15b19ba54228b4f13a341e8a0c57ef69e738ddb922f9bec92732"],
    ] as const;
    for (const [index, hash] of expected) {
      const failed = itemAt(index);
      const corrected = applyAllowlistedProblemManualCorrection(cases[index].entryId, cases[index].sourceHash, failed);
      expect(canonicalEvidenceHash(corrected)).toBe(hash);
      expect(corrected.answer).toBe(failed.answer);
      expect(corrected.question).toContain("[43 ~ 45] 다음 글을 읽고 물음에 답하시오.");
      expect(corrected.question).toContain("흥정 외상 셈하려 주주리는 지저귄다");
      expect(corrected.question).toContain("- 홍순학, ｢연행가｣ -");
      expect(corrected.figure).toBe(true);
      expect(corrected.figure_description).toContain("오른쪽으로 열린 세로 묶음 괄호가 정확히 두 개");
      expect(corrected.figure_description).toContain("관소로 돌아와서 회환(回還) 날짜 택일하니");
    }
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[8].failedStatus).toBe("exact");
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[9].failedStatus).toBeUndefined();
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[10].failedStatus).toBeUndefined();
    expect(applyAllowlistedProblemManualCorrection(cases[8].entryId, cases[8].sourceHash, itemAt(8)).choices?.[3])
      .toContain("외양과 감정");
    expect(applyAllowlistedProblemManualCorrection(cases[9].entryId, cases[9].sourceHash, itemAt(9)).choices?.[3])
      .toContain("새로운 계책");
    expect(applyAllowlistedProblemManualCorrection(cases[10].entryId, cases[10].sourceHash, itemAt(10)).choices?.[4])
      .toContain("겉밤");
  });

  it.skipIf(!available)("restores the exact Q8 writing set and Q16 reading passage", () => {
    const q8Failed = itemAt(11);
    const q8 = applyAllowlistedProblemManualCorrection(cases[11].entryId, cases[11].sourceHash, q8Failed);
    expect(canonicalEvidenceHash(q8))
      .toBe("e5e1b8c0afdb43aa2bf537c2ecfb0b60b770979c8522c692db09002c3cf4680d");
    expect(q8.answer).toBe(q8Failed.answer);
    expect(q8.choices).toEqual(q8Failed.choices);
    expect(q8.question).toContain("[6 ~ 8] 다음을 읽고 물음에 답하시오.");
    expect(q8.question).toContain("매체 이용자들이 거부감 없이");
    expect(q8.question).toContain("기사형 광고는 기사처럼 보이는 광고를 말한다.");
    expect(q8.figure).toBe(true);
    expect(q8.figure_description).toContain("오른쪽으로 열린 세로 묶음 괄호가 정확히 두 개");
    expect(q8.figure_description).toContain("위에서 아래로 [A], [B] 순서");

    const q16Failed = itemAt(12);
    const q16 = applyAllowlistedProblemManualCorrection(cases[12].entryId, cases[12].sourceHash, q16Failed);
    expect(canonicalEvidenceHash(q16))
      .toBe("dd277b1ef288b108943920a59656bc3bc8c68f23c0cfad64296753248d375ea1");
    expect(q16.answer).toBe(q16Failed.answer);
    expect(q16.choices).toEqual(q16Failed.choices);
    expect(q16.question).toContain("[16 ~ 20] 다음 글을 읽고 물음에 답하시오.");
    expect(q16.question.match(/논리학 지식/gu)).toHaveLength(3);
    expect(q16.question).toContain("경험을 통한 시험의 대상");
    expect(q16.question).toContain("㉢ 도달한다");
    expect(q16.question).toContain("선택하겠지만 실용적 필요");
    expect(q16.figure).toBe(false);
    expect(q16.figure_description).toBeNull();
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.some((item) => item.key === "6:15")).toBe(false);
  });

  it.skipIf(!available)("restores the exact Q17 and Q20 reading items", () => {
    const q17Failed = itemAt(13);
    const q17 = applyAllowlistedProblemManualCorrection(cases[13].entryId, cases[13].sourceHash, q17Failed);
    expect(canonicalEvidenceHash(q17))
      .toBe("3d94de928dd1b8d443edcc908486bc81af356e352ea7edea32ee1f43166ef0be");
    expect(q17.answer).toBe(q17Failed.answer);
    expect(q17.question).toContain("[16 ~ 20] 다음 글을 읽고 물음에 답하시오.");
    expect(q17.question.match(/논리학 지식/gu)).toHaveLength(3);
    expect(q17.question).toContain("경험을 통한 시험의 대상");
    expect(q17.question).toContain("이 둘을 서로 대체하더라도");
    expect(q17.question).toContain("선택하겠지만 실용적 필요");
    expect(q17.choices?.[2]).toContain("근본적으로 다르다고 한다.");
    expect(q17.figure).toBe(false);

    const q20Failed = itemAt(14);
    const q20 = applyAllowlistedProblemManualCorrection(cases[14].entryId, cases[14].sourceHash, q20Failed);
    expect(canonicalEvidenceHash(q20))
      .toBe("1106e5ec6656305c38b4b58770b4acfa0e3e7a6a6d2ee412d10e86e8b99f75c0");
    expect(q20.answer).toBe(q20Failed.answer);
    expect(q20.choices).toEqual(q20Failed.choices);
    expect(q20.question).toContain("[16 ~ 20] 다음 글을 읽고 물음에 답하시오.");
    expect(q20.question).toContain("문맥상 ㉢과 바꿔 쓰기에 가장 적절한 것은?");
    expect(q20.figure).toBe(false);
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.filter((item) =>
      item.entryId === "ebsi:5525982" && ["7:18", "7:19"].includes(item.key)
    ).every((item) => item.failedStatus === "exact")).toBe(true);
  });

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "restores the source-exact Q18, Q19, and Q39 from exact recovery parents",
    () => {
    const rows = [
      [q18ExactRecoveryParent(q27LiveState).failed, "e6f77c8aa3a10c5549e95eb6d3b3974587b2b3a16db009fb483ad9099943417f"],
      [q19ExactRecoveryParent(q27LiveState).failed, "64e29a3f28bad8602f35bcbf89542202e7b5cc4a587ed586474626a0085090d4"],
      [q39ExactRecoveryParent(q27LiveState).failed, "45089f6c171df3fa64b68ec782741ee58212d249566ce43837941f204e9780cf"],
    ] as const;
    for (const [failed, expectedHash] of rows) {
      const corrected = applyAllowlistedProblemManualCorrection(
        "ebsi:5525982",
        "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
        failed.question
      );
      expect(canonicalEvidenceHash(corrected)).toBe(expectedHash);
      expect(corrected.choices).toEqual(failed.question.choices);
      expect(corrected.answer).toBe(failed.question.answer);
      expect(corrected.figure).toBe(false);
    }
    const q18 = applyAllowlistedProblemManualCorrection(
      "ebsi:5525982",
      "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
      rows[0][0].question
    );
    expect(q18.question).toContain("기존의 지식과 M에 열을 가했다는 조건");
    expect(q18.question).toContain("경험을 통한 시험의 대상");
    expect(q18.question).toContain("선택하겠지만 실용적 필요");
    const q39 = applyAllowlistedProblemManualCorrection(
      "ebsi:5525982",
      "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
      rows[2][0].question
    );
    expect(q39.question).toContain("[37~42] 다음 글을 읽고 물음에 답하시오.");
    expect(q39.question).toContain("39. [가]를 바탕으로 <보기>의 상황을 이해한 내용으로 적절한 것은?");
  });

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "pins and applies the terminal-recovery Q6-Q7 and Q21-Q26 rows",
    () => {
    const parents = [
      q6TerminalRecoveryParent(q27LiveState),
      q7TerminalRecoveryParent(q27LiveState),
      ...(["21", "22", "24", "25", "26"] as const)
        .map((number) => page9TerminalRecoveryParent(q27LiveState, number)),
    ];
    const expectedHashes = [
      "cad8ee9729b41ecbd7317b94e7a9e12a1433c573ed04352321c518f063b0968b",
      "12c693c31541967de63e3b19e413e088c09eb4e8f5ebe6311a8070b4750d6dac",
      "8d6d3f7980acee3f467acebcfc684da0ba69c801cbc734e9e8ae10d59477a28a",
      "f1ef2ea1220621b550ba81993986ae75e155af93dd67034edc5a3bae3bd2b648",
      "3644bdfa7c1b94fed356c4bcf7fd1adc5632ae199f4ac90771efd560f78f0e39",
      "1a9438c01f5a5be624a31f6004260e0407a5923cf44ec9f718d1226f1684c417",
      "1498565bab625f4417c144c442e81ea0f7e566ce4807fa977678ac26a589c27c",
    ];
    const corrected = parents.map(({ failed }, index) => {
      const item = applyAllowlistedProblemManualCorrection(
        "ebsi:5525982",
        "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
        failed.question
      );
      expect(canonicalEvidenceHash(item)).toBe(expectedHashes[index]);
      return item;
    });
    expect(corrected[0]).toMatchObject({ figure: true, box: null });
    expect(corrected[0].figure_description).toContain("오른쪽으로 열린 세로 묶음 괄호가 정확히 두 개 있다");
    expect(corrected[1]).toMatchObject({ figure: true, box: [0.42, 0.88] });
    expect(corrected[1].figure_description).toContain("위쪽 가장자리는 물결 모양");
    expect(corrected[1].figure_description).toContain("두 개의 가로 구분선 아래 회색 제목 띠");
    expect(corrected.slice(0, 2).every((item) =>
      !item.question.includes("㉠을 바탕으로 초고의 마지막 문단을 완성하고자 한다."))).toBe(true);
    const q7OnlyBoxRestored = { ...corrected[1], box: parents[1].failed.question.box };
    expect(canonicalEvidenceHash({ ...q7OnlyBoxRestored, box: undefined }))
      .toBe(canonicalEvidenceHash({ ...corrected[1], box: undefined }));
    expect(corrected[4].answer?.startsWith("③ ")).toBe(true);
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(29, 31).map((item) => ({
      key: item.key,
      decision: item.expectedDecision,
      subject: item.expectedCanonicalSubject,
    }))).toEqual([
      { key: "3:6", decision: "reject", subject: undefined },
      { key: "3:7", decision: "reject", subject: undefined },
    ]);
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(31, 36).map((item) => item.key))
      .toEqual(["9:21", "9:22", "9:24", "9:25", "9:26"]);
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.slice(29, 36).filter((item) =>
      item.failedStatus === "exact").map((item) => item.key)).toEqual(["3:6", "9:21", "9:26"]);

    const mutableQ7 = PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[30] as unknown as {
      beforeBox?: [number, number];
      afterBox?: [number, number];
    };
    const beforeBox = mutableQ7.beforeBox;
    mutableQ7.beforeBox = [0.61, 0.99];
    try {
      expect(() => applyAllowlistedProblemManualCorrection(
        "ebsi:5525982",
        "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
        parents[1].failed.question
      )).toThrow("3:7 manual adjudication before box가 다릅니다");
    } finally {
      mutableQ7.beforeBox = beforeBox;
    }
    const afterBox = mutableQ7.afterBox;
    delete mutableQ7.afterBox;
    try {
      expect(() => applyAllowlistedProblemManualCorrection(
        "ebsi:5525982",
        "6d28eff474ebb29ef9c097e723be6375ca62d30d1edef5d1ac5e8c82c057b132",
        parents[1].failed.question
      )).toThrow("3:7 manual adjudication box 계약이 완전하지 않습니다");
    } finally {
      mutableQ7.afterBox = afterBox;
    }
  });

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "revises the persisted wrong Q7 manual classification without AI and replays byte-stably",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q7-manual-policy-"));
    cpSync(q27LiveState, root, { recursive: true });
    rmSync(join(root, "classification-manual-policy-revisions"), { recursive: true, force: true });
    const input = q27FixtureInputs(root);
    const q7 = q7TerminalRecoveryParent(root);
    providerMock.complete.mockRejectedValue(new Error("AI must not run"));

    const completed = await adjudicateProblemManual(input.entry, input.problem, root, q7.failed, q7.parent);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(canonicalEvidenceHash(completed.classified.question))
      .toBe("12c693c31541967de63e3b19e413e088c09eb4e8f5ebe6311a8070b4750d6dac");
    expect(canonicalEvidenceHash(completed.classified.classification))
      .toBe("3fafa64dd3d16182d72a5f7a68f9fca8f9e057a376606064b0bd5cf0b228ceb4");
    expect(completed.classified.classification).toMatchObject({
      key: "3:7",
      decision: "reject",
      canonical_subject: null,
      curriculum_course: null,
      domain: null,
      achievement_codes: [],
      confidence: 1,
      reason_codes: ["EXCLUDED_PRESENTATION_MEDIA_ASSESSED"],
      transcription_status: "exact",
    });
    const policy = completed.evidence.policyRevision!;
    expect(PROBLEM_MANUAL_CLASSIFICATION_POLICY_REVISION_ALLOWLIST).toHaveLength(1);
    expect(canonicalEvidenceHash(PROBLEM_MANUAL_CLASSIFICATION_POLICY_REVISION_ALLOWLIST[0]))
      .toBe("ab0b239fa1e63a0b41a9e510259b9b3047246534ee980b9bbc95ff1f253c8a89");
    expect(policy).toMatchObject({
      parentManualEvidenceHash: "50ca6cdacfa0215bceb57685fafb4a873772739659519df6a864f4e26d063404",
      failedClassificationHash: "737fa9b5743491d62c641273a826c0761fe953560b66d8b25f9b4ca0fb09ab94",
      officialRawAnswerHash: "faab5aef76a0e31bef1dc423641a79e0b60938edcdf69194bc63e734ca7114f6",
      policyArtifact: {
        path: "classification-manual-policy-revisions/" +
          "v1-0003-0007-81ab9f4c66829d951249d2bb2eb297ed3c33cd65b587d4c242c95749162cdd8b.json",
        sha256: "71a627aa8433c793bc8ec7d7270ea5097e5fc1abb8187e52236e80b168917ae4",
        version: PROBLEM_MANUAL_CLASSIFICATION_POLICY_REVISION_VERSION,
        policyDigest: PROBLEM_MANUAL_CLASSIFICATION_POLICY_REVISION_DIGEST,
      },
      policyItemHash: "3fafa64dd3d16182d72a5f7a68f9fca8f9e057a376606064b0bd5cf0b228ceb4",
    });
    const snapshot = stateSnapshot(join(root, "classification-manual-policy-revisions"));
    const replayed = await adjudicateProblemManual(input.entry, input.problem, root, q7.failed, q7.parent);
    expect(canonicalEvidenceHash(replayed)).toBe(canonicalEvidenceHash(completed));
    expect(stateSnapshot(join(root, "classification-manual-policy-revisions"))).toEqual(snapshot);
    expect(providerMock.complete).not.toHaveBeenCalled();

    for (const directory of [
      "problem-manual-evidence",
      "problem-manual-adjudications",
      "classification-manual-adjudications",
      "problem-manual-revisions",
      "classification-manual-revisions",
      "problem-manual-second-revisions",
      "classification-manual-second-revisions",
      "classification-manual-policy-revisions",
    ]) {
      const path = join(root, directory);
      for (const name of readdirSync(path)) {
        if (!name.startsWith("v1-0003-0007-")) rmSync(join(path, name));
      }
    }
    const authorityRepair = {
      key: "3:7",
      revision: { recovery: { ...q7.parent, manualAdjudication: completed.evidence } },
    } as unknown as ProblemRepairEvidence;
    await expect(assertProblemManualAdjudicationAuthority(root, [authorityRepair])).resolves.toBeUndefined();
    const tampered = structuredClone(authorityRepair);
    tampered.revision!.recovery!.manualAdjudication!.policyRevision!.parentManualEvidenceHash = "0".repeat(64);
    await expect(assertProblemManualAdjudicationAuthority(root, [tampered]))
      .rejects.toThrow(/manual classification policy revision checkpoint\/evidence/u);
  }, 120_000);

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "resumes the live Q7-policy and Q25-classification partial state before a fresh terminal",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q7-policy-q25-partial-"));
    cpSync(q27LiveState, root, { recursive: true });
    rmSync(join(root, "classification-manual-policy-revisions"), { recursive: true, force: true });
    const input = q27FixtureInputs(root);
    const q25Prefix = "v1-0009-0025-";
    for (const name of readdirSync(join(root, "classification-manual-adjudications"))) {
      if (name.startsWith(q25Prefix)) rmSync(join(root, "classification-manual-adjudications", name));
    }
    const protectedBefore = stateSnapshot(root).filter(([path]) =>
      /v1-0004-0008-|v1-0009-0023-/u.test(path) || path.startsWith("problem-terminal-fidelity/") ||
      path.startsWith("answer-audit/") || path.startsWith("answer-attestation/")
    );
    const calls = { classification: [] as string[], terminal: 0 };
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
          key: string;
          question: string;
        }>;
        expect(items).toHaveLength(1);
        expect(items[0].key).toBe("9:25");
        expect(items[0].question).toContain("25.");
        expect(items[0].question).toContain("들춰 업는다");
        calls.classification.push(items[0].key);
        return { text: JSON.stringify([{
          key: "9:25",
          decision: "accept",
          canonical_subject: "korean_literature",
          curriculum_course: "문학",
          domain: "전쟁 소설의 사회·역사적 맥락과 비평적 감상",
          achievement_codes: ["12문학01-03"],
          confidence: 0.99,
          reason_codes: ["IN_SCOPE_KOREAN_LITERATURE"],
          transcription_status: "exact",
          transcription_evidence: "공식 source pixel과 9:25 전체 지문·발문·선지가 일치한다.",
        }]) };
      }
      if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
        calls.terminal++;
        const items = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{
          key: string;
          question: string;
          box: [number, number] | null;
        }>;
        expect(items).toHaveLength(45);
        const byKey = new Map(items.map((item) => [item.key, item]));
        expect(byKey.get("3:7")?.box).toEqual([0.42, 0.88]);
        expect(byKey.get("9:25")?.question).toContain("들춰 업는다");
        throw new Error("seeded fresh Q7-policy terminal boundary");
      }
      throw new Error(`unexpected Q7 policy partial AI call: ${request.schema?.name ?? "unknown"}`);
    });
    await expect(repairAndAuditOfficialAnswers(
      input.entry, input.problem, input.solution, root, input.classified, input.solutions
    )).rejects.toThrow("seeded fresh Q7-policy terminal boundary");
    expect(calls).toEqual({ classification: ["9:25"], terminal: 1 });
    const policyNames = readdirSync(join(root, "classification-manual-policy-revisions"));
    expect(policyNames).toEqual([
      "v1-0003-0007-81ab9f4c66829d951249d2bb2eb297ed3c33cd65b587d4c242c95749162cdd8b.json",
    ]);
    expect(hash(readFileSync(join(root, "classification-manual-policy-revisions", policyNames[0]))))
      .toBe("71a627aa8433c793bc8ec7d7270ea5097e5fc1abb8187e52236e80b168917ae4");
    expect(readdirSync(join(root, "classification-manual-adjudications"))
      .filter((name) => name.startsWith(q25Prefix))).toHaveLength(1);
    expect(stateSnapshot(root).filter(([path]) =>
      /v1-0004-0008-|v1-0009-0023-/u.test(path) || path.startsWith("problem-terminal-fidelity/") ||
      path.startsWith("answer-audit/") || path.startsWith("answer-attestation/")
    )).toEqual(protectedBefore);
  }, 300_000);

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "preflights Q7 policy authority before an earlier missing terminal-manual write",
    async () => {
    const cases: Array<{
      label: string;
      prepare: (stateDir: string) => void | Promise<void>;
      error: RegExp;
    }> = [{
      label: "missing Q7 parent with persisted policy",
      prepare: (stateDir) => {
        const name = readdirSync(join(stateDir, "classification-manual-adjudications"))
          .find((item) => item.startsWith("v1-0003-0007-"))!;
        unlinkSync(join(stateDir, "classification-manual-adjudications", name));
      },
      error: /3:7 manual classification policy revision parent coverage/u,
    }, {
      label: "tampered policy child",
      prepare: (stateDir) => {
        const path = join(
          stateDir,
          "classification-manual-policy-revisions/" +
            "v1-0003-0007-81ab9f4c66829d951249d2bb2eb297ed3c33cd65b587d4c242c95749162cdd8b.json"
        );
        writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from(" ")]));
      },
      error: /manual classification policy revision checkpoint/u,
    }, {
      label: "tampered crop view",
      prepare: (stateDir) => {
        const path = join(
          stateDir,
          "problem-manual-evidence/" +
            "v1-0003-0007-a36de92e1a8abfefc7cba639a5b86294c5ff084be548a9e6f72f4f8e7fd43bab-view-02.png"
        );
        writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from(" ")]));
      },
      error: /3:7 crop evidence view file hash/u,
    }, {
      label: "tampered solution checkpoint",
      prepare: (stateDir) => {
        const path = join(stateDir, "solution-chunks/v3-0000.json");
        writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from(" ")]));
      },
      error: /manual classification policy revision solution authority/u,
    }, {
      label: "third policy child",
      prepare: (stateDir) => {
        const directory = join(stateDir, "classification-manual-policy-revisions");
        const source = join(directory, readdirSync(directory)[0]);
        writeFileSync(join(directory, `v1-0003-0007-${"f".repeat(64)}.json`), readFileSync(source));
      },
      error: /manual classification policy revision orphan\/conflict/u,
    }, {
      label: "policy child symlink",
      prepare: (stateDir) => {
        const directory = join(stateDir, "classification-manual-policy-revisions");
        const name = readdirSync(directory)[0];
        const target = join(directory, name);
        const bytes = readFileSync(target);
        unlinkSync(target);
        writeFileSync(join(stateDir, "policy-child-target.json"), bytes);
        symlinkSync(join(stateDir, "policy-child-target.json"), target);
      },
      error: /manual classification policy revision 파일이 유효하지 않습니다/u,
    }];
    for (const testCase of cases) {
      const stateDir = mkdtempSync(join(tmpdir(), "studywork-q7-policy-preflight-"));
      try {
        cpSync(q27LiveState, stateDir, { recursive: true });
        rmSync(join(stateDir, "classification-manual-policy-revisions"), { recursive: true, force: true });
        const input = q27FixtureInputs(stateDir);
        const q7 = q7TerminalRecoveryParent(stateDir);
        providerMock.complete.mockRejectedValue(new Error("AI must not run"));
        await adjudicateProblemManual(input.entry, input.problem, stateDir, q7.failed, q7.parent);
        removeManualArtifacts(stateDir, ["3:6"]);
        await testCase.prepare(stateDir);
        const q6 = q6TerminalRecoveryParent(stateDir);
        const before = stateSnapshot(stateDir);
        providerMock.complete.mockClear();
        await expect(
          adjudicateProblemManual(input.entry, input.problem, stateDir, q6.failed, q6.parent),
          testCase.label
        ).rejects.toThrow(testCase.error);
        expect(providerMock.complete, testCase.label).not.toHaveBeenCalled();
        expect(stateSnapshot(stateDir), testCase.label).toEqual(before);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
        providerMock.complete.mockReset();
      }
    }

    for (const dangling of [false, true]) {
      const stateDir = mkdtempSync(join(tmpdir(), "studywork-q7-policy-dir-symlink-"));
      const target = mkdtempSync(join(tmpdir(), "studywork-q7-policy-dir-target-"));
      try {
        cpSync(q27LiveState, stateDir, { recursive: true });
        removeManualArtifacts(stateDir, ["3:6"]);
        const directory = join(stateDir, "classification-manual-policy-revisions");
        rmSync(directory, { recursive: true, force: true });
        if (dangling) rmSync(target, { recursive: true, force: true });
        symlinkSync(target, directory);
        const input = q27FixtureInputs(stateDir);
        const q6 = q6TerminalRecoveryParent(stateDir);
        const before = stateSnapshot(stateDir);
        providerMock.complete.mockRejectedValue(new Error("AI must not run"));
        await expect(adjudicateProblemManual(input.entry, input.problem, stateDir, q6.failed, q6.parent))
          .rejects.toThrow("manual classification policy revision 디렉터리가 유효하지 않습니다");
        expect(providerMock.complete).not.toHaveBeenCalled();
        expect(stateSnapshot(stateDir)).toEqual(before);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
        rmSync(target, { recursive: true, force: true });
        providerMock.complete.mockReset();
      }
    }

    const upstreamState = mkdtempSync(join(tmpdir(), "studywork-q7-policy-entry-preflight-"));
    try {
      cpSync(q27LiveState, upstreamState, { recursive: true });
      rmSync(join(upstreamState, "classification-manual-policy-revisions"), { recursive: true, force: true });
      const input = q27FixtureInputs(upstreamState);
      const q7 = q7TerminalRecoveryParent(upstreamState);
      providerMock.complete.mockRejectedValue(new Error("AI must not run"));
      await adjudicateProblemManual(input.entry, input.problem, upstreamState, q7.failed, q7.parent);
      unlinkSync(join(upstreamState, q7.parent.classificationArtifact.path));
      const before = stateSnapshot(upstreamState);
      providerMock.complete.mockClear();
      await expect(repairAndAuditOfficialAnswers(
        input.entry, input.problem, input.solution, upstreamState, input.classified, input.solutions
      )).rejects.toThrow(/3:7 manual batch recovery exact-set/u);
      expect(providerMock.complete).not.toHaveBeenCalled();
      expect(stateSnapshot(upstreamState)).toEqual(before);
    } finally {
      rmSync(upstreamState, { recursive: true, force: true });
      providerMock.complete.mockReset();
    }

    for (const dangling of [false, true]) {
      const stateDir = mkdtempSync(join(tmpdir(), "studywork-q7-policy-entry-dir-symlink-"));
      const target = mkdtempSync(join(tmpdir(), "studywork-q7-policy-entry-dir-target-"));
      try {
        cpSync(q27LiveState, stateDir, { recursive: true });
        const input = q27FixtureInputs(stateDir);
        const directory = join(stateDir, "classification-manual-policy-revisions");
        rmSync(directory, { recursive: true, force: true });
        if (dangling) rmSync(target, { recursive: true, force: true });
        symlinkSync(target, directory);
        const before = stateSnapshot(stateDir);
        providerMock.complete.mockRejectedValue(new Error("AI must not run"));
        await expect(repairAndAuditOfficialAnswers(
          input.entry, input.problem, input.solution, stateDir, input.classified, input.solutions
        )).rejects.toThrow("manual classification policy revision 디렉터리가 유효하지 않습니다");
        expect(providerMock.complete).not.toHaveBeenCalled();
        expect(stateSnapshot(stateDir)).toEqual(before);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
        rmSync(target, { recursive: true, force: true });
        providerMock.complete.mockReset();
      }
    }
  }, 300_000);

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "crash-resumes all seven terminal-recovery manual children before the fresh terminal",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q6-q26-terminal-manual-live-"));
    cpSync(q27LiveState, root, { recursive: true });
    const keys = ["3:6", "3:7", "9:21", "9:22", "9:24", "9:25", "9:26"];
    removeManualArtifacts(root, keys);
    rmSync(join(root, "classification-manual-policy-revisions"), { recursive: true, force: true });
    for (const directory of ["answer-audit", "answer-attestation"]) {
      rmSync(join(root, directory), { recursive: true, force: true });
    }
    const input = q27FixtureInputs(root);
    const deferredSnapshot = () => stateSnapshot(root).filter(([path]) =>
      /v1-0004-0008-|v1-0009-0023-/u.test(path) ||
      path.startsWith("problem-terminal-fidelity-adjudications/") ||
      path.startsWith("problem-terminal-fidelity-policy-revisions/")
    );
    const deferredBefore = deferredSnapshot();
    const rows = [
      q6TerminalRecoveryParent(root),
      q7TerminalRecoveryParent(root),
      ...(["21", "22", "24", "25", "26"] as const)
        .map((number) => page9TerminalRecoveryParent(root, number)),
    ];
    const calls = { classification: [] as string[], terminal: 0 };
    let crashKey: string | null = "3:7";
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
          key: string;
          question: string;
          choices: string[] | null;
          box: [number, number] | null;
          figure: boolean;
          figure_description: string | null;
        }>;
        expect(items).toHaveLength(1);
        const item = items[0];
        expect(keys).toContain(item.key);
        calls.classification.push(item.key);
        if (item.key === crashKey) throw new Error("seeded Q7 terminal-recovery manual classification crash");
        const rejected = ["3:6", "3:7"].includes(item.key);
        if (item.key === "3:6") {
          expect(item).toMatchObject({ figure: true, box: null });
          expect(item.question).not.toContain("㉠을 바탕으로 초고의 마지막 문단을 완성하고자 한다.");
        } else if (item.key === "3:7") {
          expect(item).toMatchObject({ figure: true, box: [0.42, 0.88] });
          expect(item.figure_description).toContain("위쪽 가장자리는 물결 모양");
          expect(item.figure_description).toContain("두 개의 가로 구분선 아래 회색 제목 띠");
          expect(item.question).not.toContain("㉠을 바탕으로 초고의 마지막 문단을 완성하고자 한다.");
        } else {
          expect(item.question).toContain("[21 ~ 26] 다음 글을 읽고 물음에 답하시오.");
          expect(item.question).toContain("들춰 업는다");
        }
        if (item.key === "9:24") expect(item.choices?.[2]).toContain("‘굶주린 이리떼’");
        return { text: JSON.stringify([{
          key: item.key,
          decision: rejected ? "reject" : "accept",
          canonical_subject: rejected ? null : "korean_literature",
          curriculum_course: rejected ? null : "문학",
          domain: rejected ? null : "전쟁 소설의 사회·역사적 맥락과 비평적 감상",
          achievement_codes: rejected ? [] : ["12문학01-03"],
          confidence: 0.99,
          reason_codes: [rejected ? "EXCLUDED_WRITING_MEDIA" : "IN_SCOPE_KOREAN_LITERATURE"],
          transcription_status: "exact",
          transcription_evidence: `공식 source pixel과 ${item.key} 전체 지문·발문·선지가 일치한다.`,
        }]) };
      }
      if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
        calls.terminal++;
        const items = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{
          key: string;
          question: string;
          choices: string[] | null;
          box: [number, number] | null;
        }>;
        expect(items).toHaveLength(45);
        expect(new Set(items.map((item) => item.key)).size).toBe(45);
        const byKey = new Map(items.map((item) => [item.key, item]));
        expect(byKey.get("3:6")?.question).toContain("기사형 광고는 기사처럼 보이는 광고를 말한다.");
        expect(byKey.get("3:7")?.box).toEqual([0.42, 0.88]);
        expect(byKey.get("9:21")?.question).toContain("21. (가)의 ‘전쟁의 허구화’를 바탕으로");
        expect(byKey.get("9:22")?.choices?.some((choice) => choice.includes("｢임장군전｣"))).toBe(true);
        expect(byKey.get("9:24")?.choices?.[2]).toContain("‘굶주린 이리떼’");
        expect(byKey.get("9:26")?.question).toContain("26. (다)의 서술상의 특징");
        throw new Error("seeded fresh Q6-Q26 terminal boundary");
      }
      throw new Error(`unexpected terminal-recovery manual AI call: ${request.schema?.name ?? "unknown"}`);
    });
    const runChild = (row: ReturnType<typeof q6TerminalRecoveryParent>) =>
      adjudicateProblemManual(input.entry, input.problem, root, row.failed, row.parent);

    await expect(runChild(rows[0])).resolves.toMatchObject({
      classified: { classification: { key: "3:6", decision: "reject", canonical_subject: null } },
    });
    await expect(runChild(rows[1])).rejects.toThrow("seeded Q7 terminal-recovery manual classification crash");
    expect(calls.classification).toEqual(["3:6", "3:7"]);

    crashKey = null;
    calls.classification = [];
    const beforePartialTerminal = stateSnapshot(join(root, "problem-terminal-fidelity"));
    await expect(repairAndAuditOfficialAnswers(
      input.entry, input.problem, input.solution, root, input.classified, input.solutions
    )).rejects.toThrow("seeded fresh Q6-Q26 terminal boundary");
    expect([...calls.classification].sort()).toEqual(["3:7", "9:21", "9:22", "9:24", "9:25", "9:26"]);
    expect(calls.terminal).toBe(1);
    expect(stateSnapshot(join(root, "problem-terminal-fidelity"))).toEqual(beforePartialTerminal);
    expect(deferredSnapshot()).toEqual(deferredBefore);

    const manualSnapshot = stateSnapshot(root).filter(([path]) => path.includes("manual"));
    calls.classification = [];
    for (const row of rows) await expect(runChild(row)).resolves.toBeDefined();
    expect(calls.classification).toEqual([]);
    expect(stateSnapshot(root).filter(([path]) => path.includes("manual"))).toEqual(manualSnapshot);

    const q7ProblemName = readdirSync(join(root, "problem-manual-adjudications"))
      .find((name) => name.startsWith("v1-0003-0007-"))!;
    const q7Problem = JSON.parse(readFileSync(
      join(root, "problem-manual-adjudications", q7ProblemName), "utf8"
    ));
    expect(canonicalEvidenceHash(q7Problem.item))
      .toBe("12c693c31541967de63e3b19e413e088c09eb4e8f5ebe6311a8070b4750d6dac");
    expect(q7Problem.basis).toMatchObject({
      parentRecoveryEvidenceHash: "67020ac6d8ce2e4343f5ce0d52eef30cd77fa0fbd4daa8aecd298551c3dd17b2",
      parentRecovery: { trigger: { kind: "terminal", terminalCheckpoint: {
        path: "problem-terminal-fidelity/v2-0000-" +
          "befa1e58c257e8fd05e78bc2ac6bf3601ba29f63a42c6aff5531770e01071e29-" +
          "c1edb2e1958d0e02878104b3b1c52e88a7fdbc2995126741360a0c0f2de0eb63.json",
        sha256: "7c7455a3537bdabc42328e9cf172f78681d28765d59038aca6fae260a59ee273",
      } } },
    });
    const q26ProblemName = readdirSync(join(root, "problem-manual-adjudications"))
      .find((name) => name.startsWith("v1-0009-0026-"))!;
    const q26Problem = JSON.parse(readFileSync(
      join(root, "problem-manual-adjudications", q26ProblemName), "utf8"
    ));
    expect(q26Problem.basis.cropViews.at(-1)).toMatchObject({
      rect: [0.50, 0.74, 0.95, 0.91],
      pixelSha256: "7b43f579da32b8126104df583d17ff02e64e33cbfb90604325431730a0f95cf2",
      pixelWidth: 3159,
      pixelHeight: 1688,
    });

    calls.classification = [];
    calls.terminal = 0;
    const beforeTerminal = stateSnapshot(join(root, "problem-terminal-fidelity"));
    await expect(repairAndAuditOfficialAnswers(
      input.entry, input.problem, input.solution, root, input.classified, input.solutions
    )).rejects.toThrow("seeded fresh Q6-Q26 terminal boundary");
    expect(calls.classification).toEqual([]);
    expect(calls.terminal).toBe(1);
    expect(stateSnapshot(join(root, "problem-terminal-fidelity"))).toEqual(beforeTerminal);
    expect(deferredSnapshot()).toEqual(deferredBefore);
    expect(existsSync(join(root, "answer-audit"))).toBe(false);
    expect(existsSync(join(root, "answer-attestation"))).toBe(false);

    removeManualArtifacts(root, ["3:6"]);
    const q26ProblemPath = join(root, "problem-manual-adjudications", q26ProblemName);
    writeFileSync(q26ProblemPath, Buffer.concat([readFileSync(q26ProblemPath), Buffer.from(" ")]));
    const beforeCrossRowTamper = stateSnapshot(root);
    providerMock.complete.mockClear();
    providerMock.complete.mockRejectedValue(new Error("AI must not run"));
    await expect(runChild(rows[0])).rejects.toThrow(/9:26 manual adjudication hash가 다릅니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(beforeCrossRowTamper);
  }, 300_000);

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "preflights every terminal-recovery parent before an earlier missing manual child",
    async () => {
    const cases: Array<{
      label: string;
      mutate: (stateDir: string) => void;
      error: RegExp;
    }> = [{
      label: "later terminal generation mismatch",
      mutate: (stateDir) => {
        const terminalRelativePath =
          "problem-terminal-fidelity/v2-0000-" +
          "befa1e58c257e8fd05e78bc2ac6bf3601ba29f63a42c6aff5531770e01071e29-" +
          "c1edb2e1958d0e02878104b3b1c52e88a7fdbc2995126741360a0c0f2de0eb63.json";
        const terminalPath = join(stateDir, terminalRelativePath);
        const terminal = JSON.parse(readFileSync(terminalPath, "utf8"));
        terminal.items.find((item: { key: string }) => item.key === "9:26").key = "16:46";
        terminal.inputHash = canonicalEvidenceHash(terminal.inputs);
        const terminalSha = canonicalEvidenceHash({
          version: PROBLEM_TERMINAL_FIDELITY_VERSION,
          entryId: terminal.entryId,
          sourceHash: terminal.sourceHash,
          from: terminal.from,
          to: terminal.to,
          ownedFrom: terminal.ownedFrom,
          ownedTo: terminal.ownedTo,
          effectiveCorpusHash: terminal.effectiveCorpusHash,
          inputHash: terminal.inputHash,
          transcriptionGateVersion: terminal.transcriptionGateVersion,
          transcriptionPromptDigest: terminal.transcriptionPromptDigest,
          rulesDigest: terminal.rulesDigest,
          scopePromptDigest: PROBLEM_TERMINAL_SCOPE_PROMPT_DIGEST,
          model: IMPORT_MODEL,
          reasoningEffort: IMPORT_REASONING_EFFORT,
          inputs: terminal.inputs,
          items: terminal.items,
        });
        writeCanonicalJson(terminalPath, terminal);
        for (const name of readdirSync(join(stateDir, "problem-recoveries")).filter((name) =>
          /^v2-(?:0003-000[67]|0009-00(?:21|22|24|25|26))-/u.test(name)
        )) {
          const path = join(stateDir, "problem-recoveries", name);
          const checkpoint = JSON.parse(readFileSync(path, "utf8"));
          checkpoint.basis.trigger.terminalCheckpoint.sha256 = terminalSha;
          checkpoint.basisDigest = canonicalEvidenceHash(checkpoint.basis);
          writeCanonicalJson(path, checkpoint);
        }
        for (const name of readdirSync(join(stateDir, "classification-recoveries")).filter((name) =>
          /^v2-(?:0003-000[67]|0009-00(?:21|22|24|25|26))-/u.test(name)
        )) {
          const path = join(stateDir, "classification-recoveries", name);
          const checkpoint = JSON.parse(readFileSync(path, "utf8"));
          checkpoint.basis.trigger.terminalCheckpoint.sha256 = terminalSha;
          checkpoint.basis.problemArtifact.sha256 = canonicalEvidenceHash(JSON.parse(readFileSync(join(
            stateDir,
            checkpoint.basis.problemArtifact.path
          ), "utf8")));
          checkpoint.basisDigest = canonicalEvidenceHash(checkpoint.basis);
          writeCanonicalJson(path, checkpoint);
        }
      },
      error: /manual batch (?:problem recovery|terminal trigger) envelope/u,
    }, {
      label: "base revision bytes",
      mutate: (stateDir) => {
        const revisionPath = join(
          stateDir,
          "problem-revision-batches/v1-0001-0016-0003-" +
            "0c0c5f2ff85e2e35573ce5a5846403e970e394eed480a4c6bab88eb9cdfd3212.json"
        );
        writeFileSync(revisionPath, Buffer.concat([readFileSync(revisionPath), Buffer.from(" ")]));
      },
      error: /manual batch terminal trigger envelope/u,
    }, {
      label: "v2 trigger pointer path",
      mutate: (stateDir) => {
        const path = join(
          stateDir,
          "problem-recoveries/v2-0009-0026-" +
            "b5e39f2045ab18db27873b8abb75b058f7f2cd9b03cf84ffc237ee494ec91b29.json"
        );
        const checkpoint = JSON.parse(readFileSync(path, "utf8"));
        checkpoint.basis.trigger.terminalCheckpoint.path =
          `problem-terminal-fidelity/v2-0000-${"0".repeat(64)}-${"0".repeat(64)}.json`;
        writeJson(path, checkpoint);
      },
      error: /manual batch problem recovery envelope/u,
    }, {
      label: "missing later recovery",
      mutate: (stateDir) => rmSync(join(
        stateDir,
        "classification-recoveries/v2-0009-0026-" +
          "163fa9a8dba0114be2c92c2c32b9b405a54ce87212c93979e11c01523a0bc0b8-" +
          "7bb7cb863c8c4855.json"
      )),
      error: /9:26 manual batch recovery exact-set/u,
    }];

    for (const testCase of cases) {
      const stateDir = mkdtempSync(join(tmpdir(), "studywork-q6-q26-terminal-preflight-"));
      try {
        cpSync(q27LiveState, stateDir, { recursive: true });
        removeManualArtifacts(stateDir, ["3:6", "3:7", "9:21", "9:22", "9:24", "9:25", "9:26"]);
        const input = q27FixtureInputs(stateDir);
        const q6 = q6TerminalRecoveryParent(stateDir);
        testCase.mutate(stateDir);
        const before = stateSnapshot(stateDir);
        providerMock.complete.mockRejectedValue(new Error("AI must not run"));
        await expect(
          adjudicateProblemManual(input.entry, input.problem, stateDir, q6.failed, q6.parent),
          testCase.label
        ).rejects.toThrow(testCase.error);
        expect(providerMock.complete, testCase.label).not.toHaveBeenCalled();
        expect(stateSnapshot(stateDir), testCase.label).toEqual(before);
        providerMock.complete.mockReset();
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    }
  }, 180_000);

  it.skipIf(!available)("restores the exact Q23, Q28, and Q29 literature items", () => {
    const expected = [
      [15, "e4886fd0c2386eba4d4f84d0ef6f1954fc92b8d3a5ddfe99788d533f69f8cb56"],
      [16, "a15e214e36dd59e6275e46afcb15b84b13102a55c3545dd0d25eeedfd94bb86e"],
      [17, "573a51fae9eb3e4c5ea2aa6697fcf5ad01e0aa4826645865d2e5b012416e1618"],
    ] as const;
    for (const [index, expectedHash] of expected) {
      const failed = itemAt(index);
      const corrected = applyAllowlistedProblemManualCorrection(cases[index].entryId, cases[index].sourceHash, failed);
      expect(canonicalEvidenceHash(corrected)).toBe(expectedHash);
      expect(corrected.answer).toBe(failed.answer);
    }

    const q23 = applyAllowlistedProblemManualCorrection(cases[15].entryId, cases[15].sourceHash, itemAt(15));
    expect(q23.question).toContain("[21 ~ 26] 다음 글을 읽고 물음에 답하시오.");
    expect(q23.question).toContain("그렇게들 안 할 거예요.");
    expect(q23.question).toContain("짊어지고 일어섰다.");
    expect(q23.question).toContain("“애기 엄마…….”");
    expect(q23.question).toContain("23. (가)를 바탕으로 (나)를 설명한 것으로 적절하지 않은 것은?");
    expect(q23.question).not.toMatch(/외적인 침략|범하며 벽력|구름을 드리우고|밟혀 죽으매|바탕으로,/u);
    expect(q23.figure).toBe(false);

    const q28 = applyAllowlistedProblemManualCorrection(cases[16].entryId, cases[16].sourceHash, itemAt(16));
    expect(q28.question).toContain("[27 ~ 32] 다음 글을 읽고 물음에 답하시오.");
    expect(q28.question).toContain("이다지 낡아빠진 생활을 하는 것은 아니리라");
    expect(q28.question).toContain("함이정 : 처녀 때 난 생각했었지.");
    expect(q28.question).toContain("28. <보기>를 고려하여 (가)를 감상한 내용으로 적절하지 않은 것은?");
    expect(q28.figure).toBe(true);
    expect(q28.figure_description).toBe(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[7].figureDescription);

    const q29 = applyAllowlistedProblemManualCorrection(cases[17].entryId, cases[17].sourceHash, itemAt(17));
    expect(q29.question).toContain("나의 그릇됨을 꾸짖어 주어도 좋다");
    expect(q29.question.match(/날아간 제비와 같이/gu)).toHaveLength(2);
    expect(q29.question).toContain("때를 놓치지 않으려는 듯");
    expect(q29.choices?.[4]).toBe(
      "⑤ [A]와 [B]는 대상의 속성을 반어적으로 표현함으로써 화자나 인물의 심리적 상황을 드러내고 있다."
    );
    expect(q29.figure).toBe(true);
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.filter((item) =>
      item.entryId === "ebsi:5525982" && ["9:21", "9:22", "9:24", "9:25", "9:26"].includes(item.key)
    ).map((item) => item.key).sort()).toEqual(["9:21", "9:22", "9:24", "9:25", "9:26"]);
  });

  it.skipIf(!available)("restores the exact Q30-Q42 literature and reading items", () => {
    const expected = [
      [18, "e6e694a660190ad645dcd3cbaf1549281bdd056c04802907c04db2c061784897"],
      [19, "5ab49dec77f4e47ae71671c2ebd38e16a1e387cece768bbdd45ace55cde2f6fa"],
      [20, "e3f26787b00f65c346910a688088f941dce1b8b872e330491da0b61a8e3f5269"],
      [21, "ceea23fac5375f0d514c61a3a0a49754ea67796458365b3c17de6f67ad5837fd"],
      [22, "3a84154e36d6a7a703afecb37e7e090e46ea5c9b6aa6cf6235d96718a4416c57"],
      [23, "b7fdf4136ce89e411f5e65c7e4cc2a98ef30ea97f3aae7d3098a9556884aed3d"],
      [24, "371eba06e9adf7dec40b792dd060a10fa87237384dd6b7f20c2b4629eec8a876"],
      [25, "4e708254da01f6edf7b57bde696ef5af8faec1116dfb3ebf8eb7e1a3b5daabe8"],
    ] as const;
    const corrected = expected.map(([index, expectedHash]) => {
      const item = applyAllowlistedProblemManualCorrection(cases[index].entryId, cases[index].sourceHash, itemAt(index));
      expect(canonicalEvidenceHash(item)).toBe(expectedHash);
      return item;
    });
    expect(corrected[0].question).toContain("30. 무대 상연을 전제로 하는 희곡의 특성을");
    expect(corrected[0].figure).toBe(true);
    expect(corrected[1].answer).toContain("조숭인");
    expect(corrected[1].answer).not.toContain("조승인");
    expect(corrected[2].choices?.[1]).toContain("이야기 속의 인물들을");
    expect(corrected[2].answer).toContain("조숭인");
    expect(corrected[3].question).toContain("이미 보험금을 지급했다면");
    expect(corrected[3].question).toContain("37. 윗글에 대한 설명으로 가장 적절한 것은?");
    expect(corrected.slice(3).every((item) => item.figure === false && item.figure_description === null)).toBe(true);
    expect(corrected[6].choices?.[1]).toContain("없다 하더라도 A는");
    expect(corrected[6].answer).toContain("고지하지 않은 중요한 사항");
    expect(corrected[6].answer).not.toContain("‘중요한 사항’");
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.filter((item) =>
      item.entryId === "ebsi:5525982" && item.failedStatus === "exact").map((item) => item.key).sort())
      .toEqual(["11:30", "14:37", "15:39", "16:43", "3:6", "7:18", "7:19", "9:21", "9:26"]);
    expect(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST.some((item) => item.key === "15:39")).toBe(true);
  });

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "crash-resumes Q30-Q42 children and opens the fresh 45-key terminal",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q30-q42-manual-live-"));
    cpSync(q27LiveState, root, { recursive: true });
    const keys = [...q30Q42ManualKeys, ...newTrueRepairManualKeys];
    removeManualArtifacts(root, keys);
    removeManualRevisionArtifacts(root, ["12:32"]);
    for (const directory of ["answer-audit", "answer-attestation"]) {
      rmSync(join(root, directory), { recursive: true, force: true });
    }
    const input = q27FixtureInputs(root);
    const parents = [
      q30ExactRecoveryParent(root), q31ExactRecoveryParent(root), q32ExactRecoveryParent(root),
      q37ExactRecoveryParent(root), q38ExactRecoveryParent(root), q40ExactRecoveryParent(root),
      q41ExactRecoveryParent(root), q42ExactRecoveryParent(root), q18ExactRecoveryParent(root),
      q19ExactRecoveryParent(root), q39ExactRecoveryParent(root),
    ];
    const calls = { classification: [] as string[], terminal: 0, downstream: [] as string[] };
    let crashKey: string | null = "12:31";
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
          key: string;
          question: string;
          figure_description: string | null;
        }>;
        expect(items).toHaveLength(1);
        const item = items[0];
        expect(keys).toContain(item.key);
        calls.classification.push(item.key);
        if (item.key === crashKey) throw new Error("seeded Q31 manual classification crash");
        const literature = ["11:30", "12:31", "12:32"].includes(item.key);
        if (!newTrueRepairManualKeys.includes(item.key)) {
          expect(item.question).toContain(`${item.key.split(":")[1]}.`);
        }
        if (literature) expect(item.figure_description).toContain("세로 묶음 괄호 [A]");
        else expect(item.figure_description).toBeNull();
        return { text: JSON.stringify([{
          key: item.key,
          decision: "accept",
          canonical_subject: literature ? "korean_literature" : "korean_reading",
          curriculum_course: literature ? "문학" : "독서와 작문",
          domain: literature ? "현대시와 희곡의 표현 및 감상" : "보험의 경제 원리와 고지 의무",
          achievement_codes: literature ? ["12문학01-03"] : ["12독작01-03"],
          confidence: 0.99,
          reason_codes: ["SOURCE_EXACT", "IN_SCOPE_KOREAN"],
          transcription_status: "exact",
          transcription_evidence: `공식 source의 ${item.key} 전체 지문·발문·선택지가 일치한다.`,
        }]) };
      }
      if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
        calls.terminal++;
        const items = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{
          key: string;
          question: string;
          choices: string[] | null;
          figure: boolean;
          figure_description: string | null;
        }>;
        expect(items).toHaveLength(45);
        expect(new Set(items.map((item) => item.key)).size).toBe(45);
        expect(keys.every((key) => items.some((item) => item.key === key))).toBe(true);
        const byKey = new Map(items.map((item) => [item.key, item]));
        expect(byKey.get("11:30")).toMatchObject({
          figure: true,
          question: expect.stringContaining("이다지 낡아빠진 생활을 하는 것은 아니리라"),
          figure_description: expect.stringContaining("세로 묶음 괄호 [A]"),
        });
        expect(byKey.get("12:32")?.question).toContain("조숭인 : 처음부터 다시 이야기해 주세요");
        expect(byKey.get("12:32")?.choices?.[1]).toContain("이야기 속의 인물들을");
        expect(byKey.get("14:37")?.question).toContain("이미 보험금을 지급했다면");
        expect(byKey.get("14:37")?.question).not.toContain("이미 보험금을 지급하였다면");
        expect(byKey.get("15:41")?.choices?.[1]).toContain("없다 하더라도 A는");
        expect(byKey.get("15:41")?.choices?.[3]).toContain("고지하지 않은 중요한 사항");
        expect(byKey.get("15:41")?.choices?.[3]).not.toContain("‘중요한 사항’");
        throw new Error("seeded fresh Q30-Q42 terminal boundary");
      }
      const schema = request.schema?.name ?? "unknown";
      calls.downstream.push(schema);
      throw new Error(`honest downstream blocker: ${schema}`);
    });
    const runChild = (row: ReturnType<typeof q30ExactRecoveryParent>) =>
      adjudicateProblemManual(input.entry, input.problem, root, row.failed, row.parent);

    await expect(runChild(parents[0])).resolves.toBeDefined();
    await expect(runChild(parents[1])).rejects.toThrow("seeded Q31 manual classification crash");
    expect(calls.classification).toEqual(["11:30", "12:31"]);
    crashKey = null;
    calls.classification = [];
    for (const row of parents) await expect(runChild(row)).resolves.toBeDefined();
    expect(calls.classification).toEqual([
      "12:31", "12:32", "14:37", "15:38", "15:40", "15:41", "15:42", "7:18", "7:19", "15:39",
    ]);

    const beforeReplay = stateSnapshot(root).filter(([path]) => path.includes("manual"));
    calls.classification = [];
    for (const row of parents) await expect(runChild(row)).resolves.toBeDefined();
    expect(calls.classification).toEqual([]);
    expect(stateSnapshot(root).filter(([path]) => path.includes("manual"))).toEqual(beforeReplay);

    const beforeTerminal = stateSnapshot(join(root, "problem-terminal-fidelity"));
    await expect(repairAndAuditOfficialAnswers(
      input.entry, input.problem, input.solution, root, input.classified, input.solutions
    )).rejects.toThrow("seeded fresh Q30-Q42 terminal boundary");
    expect(calls.terminal).toBe(1);
    expect(calls.downstream).toEqual([]);
    expect(stateSnapshot(join(root, "problem-terminal-fidelity"))).toEqual(beforeTerminal);
    expect(existsSync(join(root, "answer-audit"))).toBe(false);
    expect(existsSync(join(root, "answer-attestation"))).toBe(false);

    const literatureViews = [
      "5292aacb2170ebb8ae9c70ba089bce6ce689ff9276e9d997b0f3d16c3cb3d665",
      "c534698ffb42c13ef9642bdd930e2b7ddd8b54c907bed0a5dd69ed960d7013e6",
      "581577c6aba6368e2e807d3491debc8bda2c27e4e891a734a374077ba9909376",
      "f4a0912b56ff5f19180cd6701e1b9e8a1760903869fa5284ba364f854d0587e0",
    ];
    const readingViews = [
      "f040b886b1427ed078054e833d489891f27b0d99b5c16cd70e7e4066e766483a",
      "53a758c22f1823ff10bbc7361f9f37e40c46bdd2f57d353feb01bb2c6c8b2a3d",
      "f9638782429e6b95df53473a371cda77c80ad1e3a283f57cd9a2ee4635f42343",
    ];
    const expected = [
      ["11:30", "e6e694a660190ad645dcd3cbaf1549281bdd056c04802907c04db2c061784897", "문학",
        [...literatureViews, "7d92443eaa6f0ac4f34a537e127ca54b55fb968bf64fa5cfc7bb5f777df4646c"]],
      ["12:31", "5ab49dec77f4e47ae71671c2ebd38e16a1e387cece768bbdd45ace55cde2f6fa", "문학",
        [...literatureViews, "763af66685e7abed5840a675c484ffd1cef68207475c3b12f77c8498b00bbfc6"]],
      ["12:32", "e3f26787b00f65c346910a688088f941dce1b8b872e330491da0b61a8e3f5269", "문학",
        [...literatureViews, "3ceee6f7e00d9030cc8bc8b972b0660dd0aa4abad1bd610ca5b3ae9588cdbc33"]],
      ["14:37", "ceea23fac5375f0d514c61a3a0a49754ea67796458365b3c17de6f67ad5837fd", "독서와 작문",
        readingViews],
      ["15:38", "3a84154e36d6a7a703afecb37e7e090e46ea5c9b6aa6cf6235d96718a4416c57", "독서와 작문",
        [...readingViews, "119d571b4bf6c495fa6a8a7ad05df04a569c0fed673fc8890959a8837c80bd48"]],
      ["15:40", "b7fdf4136ce89e411f5e65c7e4cc2a98ef30ea97f3aae7d3098a9556884aed3d", "독서와 작문",
        [...readingViews, "34a46f0aebac0098b64feb0cddf4370866945614b38483dcaaf12c97d6de1198"]],
      ["15:41", "371eba06e9adf7dec40b792dd060a10fa87237384dd6b7f20c2b4629eec8a876", "독서와 작문",
        [...readingViews, "a0dad8b265040dcda0ac223e8382f4dd447be0a0501571d70b6b4187b060d2a5"]],
      ["15:42", "4e708254da01f6edf7b57bde696ef5af8faec1116dfb3ebf8eb7e1a3b5daabe8", "독서와 작문",
        [...readingViews, "4f2a482f02360ef1953238997f6ff7f6a18801f7d36b8382090b8f3ce3c634f2"]],
    ] as const;
    for (const [key, itemHash, course, cropHashes] of expected) {
      const [page, number] = key.split(":");
      const prefix = `v1-${page.padStart(4, "0")}-${number.padStart(4, "0")}-`;
      const problemName = readdirSync(join(root, "problem-manual-adjudications"))
        .find((name) => name.startsWith(prefix))!;
      const classificationName = readdirSync(join(root, "classification-manual-adjudications"))
        .find((name) => name.startsWith(prefix))!;
      const problemCheckpoint = JSON.parse(readFileSync(
        join(root, "problem-manual-adjudications", problemName), "utf8"
      ));
      const classificationCheckpoint = JSON.parse(readFileSync(
        join(root, "classification-manual-adjudications", classificationName), "utf8"
      ));
      expect(canonicalEvidenceHash(problemCheckpoint.item)).toBe(itemHash);
      expect(problemCheckpoint.basis.cropViews.map((view: { pixelSha256: string }) => view.pixelSha256))
        .toEqual(cropHashes);
      expect(classificationCheckpoint.items).toEqual([expect.objectContaining({
        key, decision: "accept", curriculum_course: course, transcription_status: "exact",
      })]);
    }
    expect(readdirSync(join(root, "problem-manual-adjudications"))
      .some((name) => name.startsWith("v1-0015-0039-"))).toBe(true);

    removeManualArtifacts(root, ["12:31"]);
    const q32Child = join(root, "problem-manual-adjudications", readdirSync(
      join(root, "problem-manual-adjudications")
    ).find((name) => name.startsWith("v1-0012-0032-"))!);
    writeFileSync(q32Child, Buffer.concat([readFileSync(q32Child), Buffer.from(" ")]));
    let before = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(runChild(parents[1])).rejects.toThrow(/12:32 manual adjudication hash가 다릅니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(before);

    removeManualArtifacts(root, ["15:38"]);
    const q42Child = join(root, "problem-manual-adjudications", readdirSync(
      join(root, "problem-manual-adjudications")
    ).find((name) => name.startsWith("v1-0015-0042-"))!);
    writeFileSync(q42Child, Buffer.concat([readFileSync(q42Child), Buffer.from(" ")]));
    before = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(runChild(parents[4])).rejects.toThrow(/15:42 manual adjudication hash가 다릅니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(before);

    const q30ParentClassification = join(root,
      "classification-recoveries/v1-0011-0030-c7a93c185f146d3b057945c3ed1c7be2f776c9c9698dfbf1e4e02c7f13f35fbd-" +
      "7bb7cb863c8c4855.json");
    writeFileSync(q30ParentClassification, Buffer.concat([
      readFileSync(q30ParentClassification), Buffer.from(" "),
    ]));
    before = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(runChild(parents[0])).rejects.toThrow(/11:30 manual batch classification recovery envelope가 다릅니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(before);
  }, 300_000);

  it.skipIf(!existsSync(q32ManualProblemPath))(
    "crash-resumes the pinned Q32 source reversion before the next true repair without sibling writes",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q32-manual-revision-live-"));
    cpSync(q27LiveState, root, { recursive: true });
    removeManualRevisionArtifacts(root, ["12:32"]);
    for (const directory of ["answer-audit", "answer-attestation"]) {
      rmSync(join(root, directory), { recursive: true, force: true });
    }
    const input = q27FixtureInputs(root);
    const q31 = q31ExactRecoveryParent(root);
    const q32 = q32ExactRecoveryParent(root);
    const expectedProblemRelativePath =
      "problem-manual-revisions/v1-0012-0032-e2ba87a93ce39e57d13f35edea17a11c72721b20fc0201d3dadfc466dd73801c.json";
    const expectedClassificationRelativePath =
      "classification-manual-revisions/v1-0012-0032-e0cf084146f55db4994304b3ddb21a1a57e563ea052d32951ebd2be286c4f860-" +
      "7bb7cb863c8c4855.json";
    const firstRevisionClassification = JSON.parse(readFileSync(
      join(q27LiveState, expectedClassificationRelativePath), "utf8"
    )).items[0] as ClassificationDecision;
    expect(canonicalEvidenceHash(firstRevisionClassification))
      .toBe("e052bfaae96839742bad356f8235d214202d18baeb4bf3cc24d7e485b8042e2b");
    const calls = { firstRevision: 0, sourceRevision: 0, terminal: 0 };
    let crashStage: "first" | "source" | null = "first";
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
          key: string;
          question: string;
          choices: string[] | null;
        }>;
        expect(items).toHaveLength(1);
        if (["7:18", "7:19", "15:39"].includes(items[0].key)) {
          throw new Error(`seeded next true repair boundary: ${items[0].key}`);
        }
        expect(items[0].key).toBe("12:32");
        expect(items[0].choices?.[1]).toContain("이야기 속의 인물들을");
        expect(request.prompt).not.toContain("parent manual classification");
        const sourceCorrect = items[0].question.includes("개울물을 바라본다.)");
        if (!sourceCorrect) {
          expect(items[0].question).toContain("(서연 곁으로 가서 개울물을 바라본다). 물 위에 비쳐 보여요");
          expect(items[0].question).toContain("(물을 떠서 마신다). 물이 맑고 시원해요.");
          calls.firstRevision++;
          if (crashStage === "first") throw new Error("seeded Q32 first revision classification crash");
          return { text: JSON.stringify([firstRevisionClassification]) };
        }
        expect(items[0].question).toContain("(서연 곁으로 가서 개울물을 바라본다.) 물 위에 비쳐 보여요");
        expect(items[0].question).toContain("(물을 떠서 마신다.) 물이 맑고 시원해요.");
        calls.sourceRevision++;
        if (crashStage === "source") throw new Error("seeded Q32 source revision classification crash");
        return { text: JSON.stringify([{
          key: "12:32",
          decision: "accept",
          canonical_subject: "korean_literature",
          curriculum_course: "문학",
          domain: "희곡의 인물과 극적 기능",
          achievement_codes: ["12문학01-03"],
          confidence: 0.99,
          reason_codes: ["SOURCE_EXACT", "IN_SCOPE_KOREAN_LITERATURE"],
          transcription_status: "exact",
          transcription_evidence: "공식 p10~p12의 전체 지문과 괄호 안 마침표, 32번 발문·선택지가 일치한다.",
        }]) };
      }
      if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
        calls.terminal++;
        const items = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{
          key: string;
          question: string;
        }>;
        expect(items).toHaveLength(45);
        expect(new Set(items.map((item) => item.key)).size).toBe(45);
        const q32Input = items.find((item) => item.key === "12:32")!;
        expect(q32Input.question).toContain("(서연 곁으로 가서 개울물을 바라본다.) 물 위에 비쳐 보여요");
        expect(q32Input.question).toContain("(물을 떠서 마신다.) 물이 맑고 시원해요.");
        expect(q32Input.question).not.toContain("개울물을 바라본다). 물 위에");
        expect(q32Input.question).not.toContain("물을 떠서 마신다). 물이");
        throw new Error("seeded fresh Q32 revision terminal boundary");
      }
      throw new Error(`unexpected Q32 revision AI call: ${request.schema?.name ?? "unknown"}`);
    });
    const runQ32 = () => adjudicateProblemManual(
      input.entry, input.problem, root, q32.failed, q32.parent
    );

    await expect(runQ32()).rejects.toThrow("seeded Q32 first revision classification crash");
    expect(calls).toEqual({ firstRevision: 1, sourceRevision: 0, terminal: 0 });
    expect(readdirSync(join(root, "problem-manual-revisions"))
      .filter((name) => name.startsWith("v1-0012-0032-"))).toEqual([
        expectedProblemRelativePath.slice(expectedProblemRelativePath.lastIndexOf("/") + 1),
      ]);
    expect(existsSync(join(root, "classification-manual-revisions"))
      ? readdirSync(join(root, "classification-manual-revisions"))
        .filter((name) => name.startsWith("v1-0012-0032-"))
      : []).toEqual([]);
    expect(hash(readFileSync(join(root, expectedProblemRelativePath))))
      .toBe("61e238a6d6456ce690cd951c6a6572dc3c8b1821bb1bbbd60ae6bbdff180b85d");

    const partialSnapshot = stateSnapshot(root).filter(([path]) => path.includes("manual"));
    calls.firstRevision = 0;
    calls.sourceRevision = 0;
    providerMock.complete.mockClear();
    await expect(adjudicateProblemManual(
      input.entry, input.problem, root, q31.failed, q31.parent
    )).resolves.toBeDefined();
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(calls).toEqual({ firstRevision: 0, sourceRevision: 0, terminal: 0 });
    expect(stateSnapshot(root).filter(([path]) => path.includes("manual"))).toEqual(partialSnapshot);

    crashStage = "source";
    calls.firstRevision = 0;
    calls.sourceRevision = 0;
    await expect(runQ32()).rejects.toThrow("seeded Q32 source revision classification crash");
    expect(calls).toEqual({ firstRevision: 1, sourceRevision: 1, terminal: 0 });
    const sourceProblemNames = readdirSync(join(root, "problem-manual-second-revisions"))
      .filter((name) => name.startsWith("v1-0012-0032-"));
    expect(sourceProblemNames).toHaveLength(1);
    expect(existsSync(join(root, "classification-manual-second-revisions"))
      ? readdirSync(join(root, "classification-manual-second-revisions"))
        .filter((name) => name.startsWith("v1-0012-0032-"))
      : []).toEqual([]);

    const sourcePartialSnapshot = stateSnapshot(root).filter(([path]) => path.includes("manual"));
    calls.firstRevision = 0;
    calls.sourceRevision = 0;
    providerMock.complete.mockClear();
    await expect(adjudicateProblemManual(
      input.entry, input.problem, root, q31.failed, q31.parent
    )).resolves.toBeDefined();
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root).filter(([path]) => path.includes("manual"))).toEqual(sourcePartialSnapshot);

    crashStage = null;
    calls.firstRevision = 0;
    calls.sourceRevision = 0;
    const completed = await runQ32();
    expect(calls).toEqual({ firstRevision: 0, sourceRevision: 1, terminal: 0 });
    expect(completed).toMatchObject({
      classified: {
        question: { question: expect.stringContaining("(물을 떠서 마신다.) 물이 맑고 시원해요.") },
        classification: {
          key: "12:32", decision: "accept", canonical_subject: "korean_literature",
          curriculum_course: "문학", transcription_status: "exact",
        },
      },
      evidence: {
        allowlistId: "ebsi-5525982-q32-manual-v1",
        revision: {
          allowlistId: "ebsi-5525982-q32-manual-revision-v1",
          parentManualEvidenceHash: "16774aa8f262afb4be3e751736789f475766364e58a4f1bcdb88f84d654bd2f8",
          failedQuestionHash: "e3f26787b00f65c346910a688088f941dce1b8b872e330491da0b61a8e3f5269",
          failedClassificationHash: "cf31dadc1233e5aef9e940d882a54c316fb1398c18f520d242103a40c8033ae3",
          correctionSpecHash: "cfb59de468a6066bf277f62f2f858f8ac00e3a04fca7856e8294b271d1c186f8",
          problemArtifact: {
            path: expectedProblemRelativePath,
            sha256: "61e238a6d6456ce690cd951c6a6572dc3c8b1821bb1bbbd60ae6bbdff180b85d",
          },
          problemArtifactItemHash: "e3649d8930138bdc731c8642e24507e5d98f12da8d83503877ef92c3f31981bb",
          classificationArtifact: { path: expectedClassificationRelativePath },
          sourceRevision: {
            allowlistId: "ebsi-5525982-q32-manual-source-revision-v1",
            parentRevisionAllowlistId: "ebsi-5525982-q32-manual-revision-v1",
            parentRevisionEvidenceHash: "944ad7e2ab07ffff727e3ac8923cfbee5b9e0499610a82eca37ccd7309c0abbd",
            failedQuestionHash: "e3649d8930138bdc731c8642e24507e5d98f12da8d83503877ef92c3f31981bb",
            failedClassificationHash: "e052bfaae96839742bad356f8235d214202d18baeb4bf3cc24d7e485b8042e2b",
            problemArtifact: {
              path: "problem-manual-second-revisions/v1-0012-0032-" +
                "e552ab3ccd06391eea7e158d8ebe790e89d43c2d948ac37ce23b2f8e26f98908.json",
              sha256: "ef11be1c9a5f89ef09b8ef5b2dc8c3c0a2c77e15235cafd5e8f72a17512aab48",
            },
            problemArtifactItemHash: "e3f26787b00f65c346910a688088f941dce1b8b872e330491da0b61a8e3f5269",
            classificationArtifact: {
              path: "classification-manual-second-revisions/v1-0012-0032-" +
                "b6ec6b2d5612e39892068bb88795cd99f41a7677a2d0a6245899f43e70d873f6-" +
                "7bb7cb863c8c4855.json",
              sha256: "aa3166e4d66c67062b2ad7242523485f55dae112ec6da4d598e39aa4a2a5e55f",
            },
            classificationArtifactItemHash:
              "bf7df2cec149ca24ef79b89754d21c4906621e4c02a2314ca215ff336be1cc47",
          },
        },
      },
    });

    const completedSnapshot = stateSnapshot(root).filter(([path]) => path.includes("manual"));
    calls.firstRevision = 0;
    calls.sourceRevision = 0;
    await expect(runQ32()).resolves.toEqual(completed);
    expect(calls).toEqual({ firstRevision: 0, sourceRevision: 0, terminal: 0 });
    expect(stateSnapshot(root).filter(([path]) => path.includes("manual"))).toEqual(completedSnapshot);

    const sourceEvidence = completed.evidence.revision?.sourceRevision;
    expect(sourceEvidence).toBeDefined();
    const sourceProblemPath = join(root, sourceEvidence!.problemArtifact.path);
    const sourceClassificationPath = join(root, sourceEvidence!.classificationArtifact.path);
    const sourceProblemBytes = readFileSync(sourceProblemPath);
    const sourceClassificationBytes = readFileSync(sourceClassificationPath);
    writeFileSync(sourceProblemPath, Buffer.concat([sourceProblemBytes, Buffer.from(" ")]));
    let sourceBefore = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(adjudicateProblemManual(
      input.entry, input.problem, root, q31.failed, q31.parent
    )).rejects.toThrow(/problem manual second revision/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(sourceBefore);
    writeFileSync(sourceProblemPath, sourceProblemBytes);

    writeFileSync(sourceClassificationPath, Buffer.concat([
      sourceClassificationBytes,
      Buffer.from(" "),
    ]));
    sourceBefore = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(runQ32()).rejects.toThrow(/classification manual second revision hash/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(sourceBefore);
    writeFileSync(sourceClassificationPath, sourceClassificationBytes);

    const sourceProblemDirectory = join(root, "problem-manual-second-revisions");
    const relocatedSourceProblemDirectory = join(root, "problem-manual-second-revisions-relocated");
    renameSync(sourceProblemDirectory, relocatedSourceProblemDirectory);
    symlinkSync(relocatedSourceProblemDirectory, sourceProblemDirectory);
    sourceBefore = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(runQ32()).rejects.toThrow(/problem manual second revision 디렉터리가 유효하지 않습니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(sourceBefore);
    unlinkSync(sourceProblemDirectory);
    renameSync(relocatedSourceProblemDirectory, sourceProblemDirectory);

    const sourceAlias = join(
      root,
      "problem-manual-second-revisions",
      `v1-0012-0032-${"f".repeat(64)}.json`
    );
    writeFileSync(sourceAlias, sourceProblemBytes);
    sourceBefore = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(runQ32()).rejects.toThrow(/12:32 manual adjudication preflight orphan\/conflict/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(sourceBefore);
    unlinkSync(sourceAlias);

    symlinkSync(sourceProblemPath, sourceAlias);
    sourceBefore = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(runQ32()).rejects.toThrow(/problem manual second revision 파일이 유효하지 않습니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(sourceBefore);
    unlinkSync(sourceAlias);

    unlinkSync(sourceProblemPath);
    sourceBefore = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(runQ32()).rejects.toThrow(/manual adjudication preflight orphan\/conflict/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(sourceBefore);
    writeFileSync(sourceProblemPath, sourceProblemBytes);
    writeFileSync(sourceClassificationPath, sourceClassificationBytes);

    const beforeTerminal = stateSnapshot(join(root, "problem-terminal-fidelity"));
    await expect(repairAndAuditOfficialAnswers(
      input.entry, input.problem, input.solution, root, input.classified, input.solutions
    )).rejects.toThrow("seeded fresh Q32 revision terminal boundary");
    expect(calls).toEqual({ firstRevision: 0, sourceRevision: 0, terminal: 1 });
    expect(stateSnapshot(join(root, "problem-terminal-fidelity"))).toEqual(beforeTerminal);
    expect(existsSync(join(root, "answer-audit"))).toBe(false);
    expect(existsSync(join(root, "answer-attestation"))).toBe(false);

    const revisionProblemPath = join(root, expectedProblemRelativePath);
    const revisionProblemBytes = readFileSync(revisionProblemPath);
    removeManualArtifacts(root, ["12:31"]);
    writeFileSync(revisionProblemPath, Buffer.concat([revisionProblemBytes, Buffer.from(" ")]));
    let before = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(adjudicateProblemManual(
      input.entry, input.problem, root, q31.failed, q31.parent
    )).rejects.toThrow("12:32 problem manual revision hash가 다릅니다");
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(before);

    writeFileSync(revisionProblemPath, revisionProblemBytes);
    const aliasPath = join(root, "problem-manual-revisions", `v1-0012-0032-${"f".repeat(64)}.json`);
    writeFileSync(aliasPath, revisionProblemBytes);
    before = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(runQ32()).rejects.toThrow(/12:32 manual adjudication preflight orphan\/conflict/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(before);
    unlinkSync(aliasPath);

    unlinkSync(revisionProblemPath);
    before = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(runQ32()).rejects.toThrow(/12:32 manual adjudication preflight orphan\/conflict/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(before);
    writeFileSync(revisionProblemPath, revisionProblemBytes);

    const q32Prefix = "v1-0012-0032-";
    for (const directory of [
      "problem-manual-evidence",
      "problem-manual-adjudications",
      "classification-manual-adjudications",
      "problem-manual-revisions",
      "classification-manual-revisions",
      "problem-manual-second-revisions",
      "classification-manual-second-revisions",
      "classification-manual-policy-revisions",
    ]) {
      const path = join(root, directory);
      if (!existsSync(path)) continue;
      for (const name of readdirSync(path)) {
        if (!name.startsWith(q32Prefix)) rmSync(join(path, name));
      }
    }
    const authorityRepair = {
      key: "12:32",
      revision: {
        recovery: {
          ...q32.parent,
          manualAdjudication: completed.evidence,
        },
      },
    } as unknown as ProblemRepairEvidence;
    await expect(assertProblemManualAdjudicationAuthority(root, [authorityRepair])).resolves.toBeUndefined();
    const tamperedAuthorityRepair = structuredClone(authorityRepair);
    tamperedAuthorityRepair.revision!.recovery!.manualAdjudication!.revision!.sourceRevision!
      .parentRevisionEvidenceHash = "0".repeat(64);
    await expect(assertProblemManualAdjudicationAuthority(root, [tamperedAuthorityRepair]))
      .rejects.toThrow("12:32 manual source revision evidence가 parent/allowlist와 다릅니다");
  }, 300_000);

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "crash-resumes exact-parent Q18-Q19-Q39 children and preflights the whole true-repair set",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q18-q19-q39-manual-live-"));
    cpSync(q27LiveState, root, { recursive: true });
    removeManualArtifacts(root, ["7:18", "7:19", "15:39"]);
    const input = q27FixtureInputs(root);
    const rows = [q18ExactRecoveryParent(root), q19ExactRecoveryParent(root), q39ExactRecoveryParent(root)];
    const calls: string[] = [];
    let crashKey: string | null = "7:19";
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      expect(request.schema?.name).toBe("studywork_exam_corpus_classification");
      const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
        key: string;
        question: string;
        choices: string[] | null;
      }>;
      expect(items).toHaveLength(1);
      const item = items[0];
      expect(["7:18", "7:19", "15:39"]).toContain(item.key);
      calls.push(item.key);
      if (item.key === "7:18" || item.key === "7:19") {
        expect(item.question).toContain("[16 ~ 20] 다음 글을 읽고 물음에 답하시오.");
        expect(item.question).toContain("기존의 지식과 M에 열을 가했다는 조건");
        expect(item.question).toContain("경험을 통한 시험의 대상");
        expect(item.question).toContain("선택하겠지만 실용적 필요");
      } else {
        expect(item.question).toContain("[37~42] 다음 글을 읽고 물음에 답하시오.");
        expect(item.question).toContain("39. [가]를 바탕으로 <보기>의 상황을 이해한 내용으로 적절한 것은?");
      }
      if (item.key === crashKey) throw new Error("seeded exact-parent true repair classification crash");
      return { text: JSON.stringify([{
        key: item.key,
        decision: "accept",
        canonical_subject: "korean_reading",
        curriculum_course: "독서와 작문",
        domain: "비문학 제시문의 추론적·비판적 읽기",
        achievement_codes: ["12독작01-04"],
        confidence: 0.99,
        reason_codes: ["SOURCE_EXACT", "IN_SCOPE_KOREAN_READING"],
        transcription_status: "exact",
        transcription_evidence: `공식 source pixel과 ${item.key} 전체 지문·발문·선지가 일치한다.`,
      }]) };
    });
    const run = (index: number) => adjudicateProblemManual(
      input.entry,
      input.problem,
      root,
      rows[index].failed,
      rows[index].parent
    );

    await expect(run(0)).resolves.toMatchObject({
      classified: { classification: { key: "7:18", transcription_status: "exact", decision: "accept" } },
    });
    await expect(run(1)).rejects.toThrow("seeded exact-parent true repair classification crash");
    expect(calls).toEqual(["7:18", "7:19"]);
    expect(readdirSync(join(root, "problem-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0007-0019-"))).toHaveLength(1);
    expect(readdirSync(join(root, "classification-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0007-0019-"))).toHaveLength(0);

    crashKey = null;
    await expect(run(2)).resolves.toMatchObject({
      classified: { classification: { key: "15:39", transcription_status: "exact", decision: "accept" } },
    });
    await expect(run(1)).resolves.toMatchObject({
      classified: { classification: { key: "7:19", transcription_status: "exact", decision: "accept" } },
    });
    expect(calls).toEqual(["7:18", "7:19", "15:39", "7:19"]);

    const expected = new Map<string, { itemHash: string; views: string[] }>([
      ["7:18", {
        itemHash: "e6f77c8aa3a10c5549e95eb6d3b3974587b2b3a16db009fb483ad9099943417f",
        views: [
          "af81d940bb74a611b249ff861be8a8e95eaa719f8a1978258f37e37ffd3d347e",
          "c52268ed7672f99284b07b36a6bfc7375d5cb203a651c0fa90a25edd06e353d1",
          "3ddfb710dfa5d8576496b6b37d43c90e53b2eab196db181439f60343e7da6d95",
          "e72ccd39610a51f98718e7b542d3c5d91f9354f1eb10b53d39ca6af88ac0d525",
        ],
      }],
      ["7:19", {
        itemHash: "64e29a3f28bad8602f35bcbf89542202e7b5cc4a587ed586474626a0085090d4",
        views: [
          "af81d940bb74a611b249ff861be8a8e95eaa719f8a1978258f37e37ffd3d347e",
          "c52268ed7672f99284b07b36a6bfc7375d5cb203a651c0fa90a25edd06e353d1",
          "3ddfb710dfa5d8576496b6b37d43c90e53b2eab196db181439f60343e7da6d95",
          "abd329f03c55a66e582ca236eeba453f7c214315abefb41fdbd5dd36cab7f9a9",
        ],
      }],
      ["15:39", {
        itemHash: "45089f6c171df3fa64b68ec782741ee58212d249566ce43837941f204e9780cf",
        views: [
          "f040b886b1427ed078054e833d489891f27b0d99b5c16cd70e7e4066e766483a",
          "53a758c22f1823ff10bbc7361f9f37e40c46bdd2f57d353feb01bb2c6c8b2a3d",
          "f9638782429e6b95df53473a371cda77c80ad1e3a283f57cd9a2ee4635f42343",
          "2a6bbacc283df55dacf030d892013dcf9c7a62fdc543f8fd58fea9d97f8575a5",
        ],
      }],
    ]);
    for (const [key, authority] of expected) {
      const [page, number] = key.split(":");
      const prefix = `v1-${page.padStart(4, "0")}-${number.padStart(4, "0")}-`;
      const name = readdirSync(join(root, "problem-manual-adjudications"))
        .find((candidate) => candidate.startsWith(prefix))!;
      const checkpoint = JSON.parse(readFileSync(join(root, "problem-manual-adjudications", name), "utf8"));
      expect(canonicalEvidenceHash(checkpoint.item)).toBe(authority.itemHash);
      expect(checkpoint.basis.cropViews.map((view: { pixelSha256: string }) => view.pixelSha256))
        .toEqual(authority.views);
    }

    const completedSnapshot = stateSnapshot(root).filter(([path]) => path.includes("manual"));
    calls.length = 0;
    for (let index = 0; index < rows.length; index++) await expect(run(index)).resolves.toBeDefined();
    expect(calls).toEqual([]);
    expect(stateSnapshot(root).filter(([path]) => path.includes("manual"))).toEqual(completedSnapshot);

    const q39ProblemPath = join(root, "problem-manual-adjudications", readdirSync(
      join(root, "problem-manual-adjudications")
    ).find((name) => name.startsWith("v1-0015-0039-"))!);
    const q39Bytes = readFileSync(q39ProblemPath);
    removeManualArtifacts(root, ["7:18"]);
    writeFileSync(q39ProblemPath, Buffer.concat([q39Bytes, Buffer.from(" ")]));
    const before = stateSnapshot(root);
    calls.length = 0;
    providerMock.complete.mockClear();
    await expect(run(0)).rejects.toThrow(/15:39 manual adjudication hash가 다릅니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(stateSnapshot(root)).toEqual(before);
  }, 300_000);

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "crash-resumes Q8-Q16 children before unrelated Q17-Q18 blockers",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q8-q16-manual-live-"));
    cpSync(q27LiveState, root, { recursive: true });
    removeManualArtifacts(root, ["4:8", "6:16"]);
    for (const directory of ["answer-audit", "answer-attestation"]) {
      rmSync(join(root, directory), { recursive: true, force: true });
    }
    const calls = { classification: [] as string[], extraction: [] as string[], terminal: 0 };
    const laterManualKeys = [
      ...terminalRecoveryManualKeys,
      "7:17", "7:20", "9:23", "11:28", "11:29", ...q30Q42ManualKeys, ...newTrueRepairManualKeys,
    ];
    let crashKey: string | null = "6:16";
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        const inputs = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
          key: string;
          question: string;
          figure_description: string | null;
        }>;
        expect(inputs).toHaveLength(1);
        const item = inputs[0];
        if (laterManualKeys.includes(item.key)) {
          calls.extraction.push(item.key);
          throw new Error(`unrelated persisted manual blocker: ${item.key}`);
        }
        calls.classification.push(item.key);
        expect(["4:8", "6:16"]).toContain(item.key);
        expect(request.prompt).not.toContain("원문 3쪽의 세트 표제");
        expect(request.prompt).not.toContain("원문 6쪽의 묶음 지시문");
        if (item.key === "4:8") {
          expect(item.question).toContain("[6 ~ 8] 다음을 읽고 물음에 답하시오.");
          expect(item.question).toContain("기사형 광고는 기사처럼 보이는 광고를 말한다.");
          expect(item.figure_description).toContain("오른쪽으로 열린 세로 묶음 괄호가 정확히 두 개");
        } else {
          expect(item.question).toContain("[16 ~ 20] 다음 글을 읽고 물음에 답하시오.");
          expect(item.question).toContain("선택하겠지만 실용적 필요");
          expect(item.figure_description).toBeNull();
        }
        if (item.key === crashKey) throw new Error("seeded Q16 manual classification crash");
        return { text: JSON.stringify([item.key === "4:8" ? {
          key: item.key,
          decision: "reject",
          canonical_subject: null,
          curriculum_course: null,
          domain: null,
          achievement_codes: [],
          confidence: 0.99,
          reason_codes: ["ASSESSED_CONSTRUCT_WRITING", "OUT_OF_SCOPE_KOREAN_READING"],
          transcription_status: "exact",
          transcription_evidence: "공식 3~4쪽의 작문 계획·초고·괄호·8번 발문과 선택지가 일치한다.",
        } : {
          key: item.key,
          decision: "accept",
          canonical_subject: "korean_reading",
          curriculum_course: "독서와 작문",
          domain: "인문·철학 제재의 관점 비교와 추론",
          achievement_codes: ["12독작01-03"],
          confidence: 0.99,
          reason_codes: ["NONFICTION_READING", "VIEWPOINT_COMPARISON"],
          transcription_status: "exact",
          transcription_evidence: "공식 6쪽의 전체 지문·16번 발문과 선택지가 일치한다.",
        }]) };
      }
      if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
        calls.terminal++;
        const inputs = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{
          key: string;
          question: string;
        }>;
        expect(inputs).toHaveLength(45);
        expect(new Set(inputs.map((item) => item.key)).size).toBe(45);
        expect(inputs.find((item) => item.key === "4:8")?.question)
          .toContain("기사형 광고는 기사처럼 보이는 광고를 말한다.");
        expect(inputs.find((item) => item.key === "6:16")?.question)
          .toContain("[16 ~ 20] 다음 글을 읽고 물음에 답하시오.");
        throw new Error("seeded fresh terminal boundary");
      }
      if (request.schema?.name === "studywork_file_quiz_items") {
        const single = request.prompt.match(/printed problem (\d+) starting on page (\d+)/u);
        const target = single
          ? `${single[2]}:${single[1]}`
          : request.prompt.match(/printed problems: ([^.]+)/u)?.[1] ?? "unknown";
        calls.extraction.push(target);
        throw new Error(`unrelated persisted blocker: ${target}`);
      }
      throw new Error(`unexpected AI call: ${request.schema?.name ?? "unknown"}`);
    });
    const run = () => {
      const input = q27FixtureInputs(root);
      return repairAndAuditOfficialAnswers(
        input.entry,
        input.problem,
        input.solution,
        root,
        input.classified,
        input.solutions
      );
    };

    await expect(run()).rejects.toThrow(
      /seeded Q16 manual classification crash|unrelated persisted (?:manual )?blocker: (?:3:[67]|7:(?:17|18|19|20)|9:(?:21|22|23|24|25|26)|11:(?:28|29|30)|12:(?:31|32)|14:37|15:(?:38|39|40|41|42))/u
    );
    expect([...calls.classification].sort()).toEqual(["4:8", "6:16"]);
    expect(calls.extraction).toEqual([]);
    expect(calls.extraction.every((key) => laterManualKeys.includes(key))).toBe(true);
    expect(calls.terminal).toBe(0);
    const q8Problem = readdirSync(join(root, "problem-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0004-0008-"));
    const q8Classification = readdirSync(join(root, "classification-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0004-0008-"));
    const q16Problem = readdirSync(join(root, "problem-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0006-0016-"));
    expect(q8Problem).toHaveLength(1);
    expect(q8Classification).toHaveLength(1);
    expect(q16Problem).toHaveLength(1);
    expect(readdirSync(join(root, "classification-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0006-0016-"))).toHaveLength(0);

    crashKey = null;
    calls.classification = [];
    calls.extraction = [];
    await expect(run()).rejects.toThrow("seeded fresh terminal boundary");
    expect(calls.classification).toEqual(["6:16"]);
    expect(calls.extraction).toEqual([]);
    expect(calls.terminal).toBe(1);
    const q16Classification = readdirSync(join(root, "classification-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0006-0016-"));
    expect(q16Classification).toHaveLength(1);
    for (const [key, expectedHash, expectedSpecHash, expectedDecision, expectedSubject] of [
      [
        "4:8", "e5e1b8c0afdb43aa2bf537c2ecfb0b60b770979c8522c692db09002c3cf4680d",
        "764545d31c96a9bf525791206c81b136b74f07ffb9b974fe1e9e6a1e27a8a79a", "reject", null,
      ],
      [
        "6:16", "dd277b1ef288b108943920a59656bc3bc8c68f23c0cfad64296753248d375ea1",
        "a4e52e1bf05c24a3aca3bea7ed81b74031c9b8017067074091b17702e31ad8da", "accept", "korean_reading",
      ],
    ] as const) {
      const [page, number] = key.split(":").map(Number);
      const prefix = `v1-${String(page).padStart(4, "0")}-${String(number).padStart(4, "0")}-`;
      const problemName = readdirSync(join(root, "problem-manual-adjudications"))
        .find((name) => name.startsWith(prefix))!;
      const classificationName = readdirSync(join(root, "classification-manual-adjudications"))
        .find((name) => name.startsWith(prefix))!;
      const problemCheckpoint = JSON.parse(readFileSync(
        join(root, "problem-manual-adjudications", problemName),
        "utf8"
      ));
      expect(canonicalEvidenceHash(problemCheckpoint.item)).toBe(expectedHash);
      expect(problemCheckpoint.basis.correctionSpecHash).toBe(expectedSpecHash);
      expect(problemCheckpoint.basis.cropViews.map((view: {
        pixelSha256: string;
        pixelWidth: number;
        pixelHeight: number;
      }) => ({
        pixelSha256: view.pixelSha256,
        pixelWidth: view.pixelWidth,
        pixelHeight: view.pixelHeight,
      }))).toEqual(key === "4:8" ? [{
        pixelSha256: "d712b1f65224ad29c5cf1ce98031ef221f8508a36f7a01ad69b270cca5809a0a",
        pixelWidth: 7017,
        pixelHeight: 9925,
      }, {
        pixelSha256: "8c65b3526f5acd98fc1ba51e0cf0b0437cf2518437ee4990c504905cff9f07b8",
        pixelWidth: 3018,
        pixelHeight: 8040,
      }, {
        pixelSha256: "f726265d0f701cad0c9e9942ac09e7430cae60f5f5190e276c17446784e0b8ef",
        pixelWidth: 3018,
        pixelHeight: 3078,
      }] : [{
        pixelSha256: "af81d940bb74a611b249ff861be8a8e95eaa719f8a1978258f37e37ffd3d347e",
        pixelWidth: 7017,
        pixelHeight: 9925,
      }, {
        pixelSha256: "c52268ed7672f99284b07b36a6bfc7375d5cb203a651c0fa90a25edd06e353d1",
        pixelWidth: 3018,
        pixelHeight: 5360,
      }, {
        pixelSha256: "3ddfb710dfa5d8576496b6b37d43c90e53b2eab196db181439f60343e7da6d95",
        pixelWidth: 3159,
        pixelHeight: 7345,
      }]);
      const decision = JSON.parse(readFileSync(
        join(root, "classification-manual-adjudications", classificationName),
        "utf8"
      )).items[0];
      expect(decision).toMatchObject({
        key,
        decision: expectedDecision,
        canonical_subject: expectedSubject,
        transcription_status: "exact",
      });
      if (key === "4:8") {
        expect(decision).toMatchObject({ curriculum_course: null, domain: null, achievement_codes: [] });
      } else {
        expect(decision).toMatchObject({ curriculum_course: "독서와 작문" });
      }
    }
    expect(readdirSync(join(root, "problem-manual-adjudications"))
      .some((name) => name.startsWith("v1-0006-0015-"))).toBe(false);
    expect(readdirSync(join(root, "classification-manual-adjudications"))
      .some((name) => name.startsWith("v1-0006-0015-"))).toBe(false);

    const childSnapshot = stateSnapshot(root).filter(([path]) => path.includes("manual"));
    calls.classification = [];
    calls.extraction = [];
    calls.terminal = 0;
    await expect(run()).rejects.toThrow("seeded fresh terminal boundary");
    expect(calls.classification).toEqual([]);
    expect(calls.extraction).toEqual([]);
    expect(calls.terminal).toBe(1);
    expect(stateSnapshot(root).filter(([path]) => path.includes("manual"))).toEqual(childSnapshot);

    const { failed: q8Failed, parent: q8Parent } = q8ExactRecoveryParent(root);
    removeManualArtifacts(root, ["4:8"]);
    const q16ProblemPath = join(root, "problem-manual-adjudications", q16Problem[0]);
    writeFileSync(q16ProblemPath, Buffer.concat([readFileSync(q16ProblemPath), Buffer.from(" ")]));
    const beforeCrossRowPreflight = stateSnapshot(root);
    providerMock.complete.mockClear();
    const input = q27FixtureInputs(root);
    await expect(adjudicateProblemManual(input.entry, input.problem, root, q8Failed, q8Parent))
      .rejects.toThrow(/6:16 manual adjudication hash가 다릅니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(beforeCrossRowPreflight);
  }, 180_000);

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "rejects a missing Q16 parent before Q8 writes or AI",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q8-q16-manual-missing-"));
    cpSync(q27LiveState, root, { recursive: true });
    removeManualArtifacts(root, ["4:8", "6:16"]);
    const input = q27FixtureInputs(root);
    const { failed, parent } = q8ExactRecoveryParent(root);
    rmSync(join(
      root,
      "classification-recoveries/v1-0006-0016-c3c9b85bbbe986dfd32468b1d82bd474b69ef84cf38200e7d700ef2adea16011-" +
        "7bb7cb863c8c4855.json"
    ));
    const before = stateSnapshot(root);
    providerMock.complete.mockRejectedValue(new Error("AI must not run"));
    await expect(adjudicateProblemManual(input.entry, input.problem, root, failed, parent))
      .rejects.toThrow(/6:16 manual batch recovery exact-set가 다릅니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(before);
  }, 120_000);

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "crash-resumes Q17-Q20 children before the next honest boundary",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q17-q20-manual-live-"));
    cpSync(q27LiveState, root, { recursive: true });
    removeManualArtifacts(root, ["7:17", "7:20"]);
    for (const directory of ["answer-audit", "answer-attestation"]) {
      rmSync(join(root, directory), { recursive: true, force: true });
    }
    const input = q27FixtureInputs(root);
    const q17Parent = q17ExactRecoveryParent(root);
    const q20Parent = q20ExactRecoveryParent(root);
    const calls = {
      classification: [] as string[],
      unrelated: [] as string[],
      terminal: 0,
    };
    let crashKey: string | null = "7:20";
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        const inputs = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
          key: string;
          question: string;
          figure_description: string | null;
        }>;
        if (inputs.some((item) => !["7:17", "7:20"].includes(item.key))) {
          calls.unrelated.push(...inputs.map((item) => item.key));
          throw new Error(`unrelated classification blocker: ${inputs.map((item) => item.key).join(",")}`);
        }
        expect(inputs).toHaveLength(1);
        const item = inputs[0];
        calls.classification.push(item.key);
        expect(item.question).toContain("[16 ~ 20] 다음 글을 읽고 물음에 답하시오.");
        expect(item.question.match(/논리학 지식/gu)).toHaveLength(3);
        expect(item.question).toContain("경험을 통한 시험의 대상");
        expect(item.question).toContain("이 둘을 서로 대체하더라도");
        expect(item.question).toContain("선택하겠지만 실용적 필요");
        expect(item.figure_description).toBeNull();
        expect(request.prompt).not.toMatch(/공통 지문 머리말|공식 6쪽의 세트 표기/u);
        if (item.key === "7:17") expect(item.question).toContain("윗글에 대해 이해한 내용으로");
        else expect(item.question).toContain("문맥상 ㉢과 바꿔 쓰기에");
        if (item.key === crashKey) throw new Error("seeded Q20 manual classification crash");
        return { text: JSON.stringify([{
          key: item.key,
          decision: "accept",
          canonical_subject: "korean_reading",
          curriculum_course: "독서와 작문",
          domain: item.key === "7:17"
            ? "독서: 사실적·추론적 읽기 및 논증의 개념 관계 파악"
            : "독서·문맥적 어휘 의미 파악",
          achievement_codes: item.key === "7:17" ? ["12독작01-03", "12독작01-04"] : ["12독작01-03"],
          confidence: 0.99,
          reason_codes: ["NONFICTION_READING", "SOURCE_EXACT"],
          transcription_status: "exact",
          transcription_evidence: item.key === "7:17"
            ? "공식 6~7쪽의 공통 지문, 17번 발문과 다섯 선택지가 일치한다."
            : "공식 6~7쪽의 공통 지문, 20번 발문과 다섯 선택지가 일치한다.",
        }]) };
      }
      if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
        calls.terminal++;
        const inputs = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{
          key: string;
          question: string;
          choices: string[] | null;
        }>;
        expect(inputs).toHaveLength(45);
        expect(new Set(inputs.map((item) => item.key)).size).toBe(45);
        expect(inputs.find((item) => item.key === "7:17")?.choices?.[2])
          .toContain("근본적으로 다르다고 한다.");
        expect(inputs.find((item) => item.key === "7:20")?.question)
          .toContain("문맥상 ㉢과 바꿔 쓰기에 가장 적절한 것은?");
        throw new Error("seeded fresh Q17-Q20 terminal boundary");
      }
      if (request.schema?.name === "studywork_file_quiz_items") {
        const single = request.prompt.match(/printed problem (\d+) starting on page (\d+)/u);
        const target = single
          ? `${single[2]}:${single[1]}`
          : request.prompt.match(/printed problems: ([^.]+)/u)?.[1] ?? "unknown";
        calls.unrelated.push(target);
        throw new Error(`unrelated extraction blocker: ${target}`);
      }
      throw new Error(`unexpected AI call: ${request.schema?.name ?? "unknown"}`);
    });
    const runChild = (row: ReturnType<typeof q17ExactRecoveryParent>) =>
      adjudicateProblemManual(input.entry, input.problem, root, row.failed, row.parent);
    const run = () => repairAndAuditOfficialAnswers(
      input.entry,
      input.problem,
      input.solution,
      root,
      input.classified,
      input.solutions
    );

    await expect(runChild(q17Parent)).resolves.toMatchObject({ classified: { classification: { key: "7:17" } } });
    await expect(runChild(q20Parent)).rejects.toThrow(/seeded Q20 manual classification crash/u);
    expect([...calls.classification].sort()).toEqual(["7:17", "7:20"]);
    expect(calls.terminal).toBe(0);
    expect(calls.unrelated).toEqual([]);

    crashKey = null;
    calls.classification = [];
    await expect(runChild(q17Parent)).resolves.toMatchObject({ classified: { classification: { key: "7:17" } } });
    await expect(runChild(q20Parent)).resolves.toMatchObject({ classified: { classification: { key: "7:20" } } });
    expect(calls.classification).toEqual(["7:20"]);
    const boundaryMessage = await run().then(
      () => "resolved unexpectedly",
      (error: unknown) => error instanceof Error ? error.message : String(error)
    );
    expect([
      "unrelated extraction blocker: 9:23",
      "unrelated classification blocker: 9:23",
      "unrelated classification blocker: 11:28",
      "unrelated classification blocker: 11:29",
      "11:28 final source-grounded recovery도 exact가 아닙니다",
      "seeded fresh Q17-Q20 terminal boundary",
      ...q30Q42ManualKeys.map((key) => `unrelated classification blocker: ${key}`),
      ...newTrueRepairManualKeys.map((key) => `unrelated classification blocker: ${key}`),
    ]).toContain(boundaryMessage);
    if (boundaryMessage === "seeded fresh Q17-Q20 terminal boundary") {
      expect(calls.unrelated).toEqual([]);
      expect(calls.terminal).toBe(1);
    } else {
      expect(calls.unrelated.length).toBeGreaterThan(0);
      expect(calls.unrelated.every((key) => [
        "9:23", "11:28", "11:29", ...q30Q42ManualKeys, ...newTrueRepairManualKeys,
      ].includes(key))).toBe(true);
      expect(calls.terminal).toBe(0);
    }

    const expected = [{
      key: "7:17",
      itemHash: "3d94de928dd1b8d443edcc908486bc81af356e352ea7edea32ee1f43166ef0be",
      specHash: "7bdf1e88f8f56e2c1a581afa6bd529a8dea7f43bd7a56e94125fa482c209fe96",
      lastCropHash: "b69ac51723f8e8e62ac7fa4f0404e522ed15a818eab2074ea70c450d11da85dd",
      lastCropHeight: 2680,
    }, {
      key: "7:20",
      itemHash: "1106e5ec6656305c38b4b58770b4acfa0e3e7a6a6d2ee412d10e86e8b99f75c0",
      specHash: "2fa15fb8b4490a51b19e8c1a71591694d9049cecb83b5cf952b858633b5d76d5",
      lastCropHash: "082e73f5f9917837562c97b338381be35acf16a6501a8fe510ec8827a3063211",
      lastCropHeight: 894,
    }] as const;
    for (const row of expected) {
      const [page, number] = row.key.split(":");
      const prefix = `v1-${page.padStart(4, "0")}-${number.padStart(4, "0")}-`;
      const problemName = readdirSync(join(root, "problem-manual-adjudications"))
        .find((name) => name.startsWith(prefix))!;
      const classificationName = readdirSync(join(root, "classification-manual-adjudications"))
        .find((name) => name.startsWith(prefix))!;
      const checkpoint = JSON.parse(readFileSync(
        join(root, "problem-manual-adjudications", problemName),
        "utf8"
      ));
      expect(canonicalEvidenceHash(checkpoint.item)).toBe(row.itemHash);
      expect(checkpoint.basis.correctionSpecHash).toBe(row.specHash);
      expect(checkpoint.basis.cropViews.map((view: { pixelSha256: string }) => view.pixelSha256)).toEqual([
        "af81d940bb74a611b249ff861be8a8e95eaa719f8a1978258f37e37ffd3d347e",
        "c52268ed7672f99284b07b36a6bfc7375d5cb203a651c0fa90a25edd06e353d1",
        "3ddfb710dfa5d8576496b6b37d43c90e53b2eab196db181439f60343e7da6d95",
        row.lastCropHash,
      ]);
      expect(checkpoint.basis.cropViews[3]).toMatchObject({ pixelWidth: 3018, pixelHeight: row.lastCropHeight });
      expect(JSON.parse(readFileSync(
        join(root, "classification-manual-adjudications", classificationName),
        "utf8"
      )).items[0]).toMatchObject({
        key: row.key,
        decision: "accept",
        canonical_subject: "korean_reading",
        curriculum_course: "독서와 작문",
        transcription_status: "exact",
      });
    }
    const trueRepairProblemKeys = ["7:18", "7:19"].filter((key) => {
      const number = key.split(":")[1].padStart(4, "0");
      return readdirSync(join(root, "problem-manual-adjudications"))
        .some((name) => name.startsWith(`v1-0007-${number}-`));
    });
    expect(trueRepairProblemKeys).toEqual(["7:18", "7:19"]);
    expect(readdirSync(join(root, "classification-manual-adjudications"))
      .filter((name) => /v1-0007-001[89]-/u.test(name))
      .map((name) => name.split("-").slice(1, 3).join("-")).sort())
      .toEqual(["0007-0018", "0007-0019"]);

    const childSnapshot = stateSnapshot(root).filter(([path]) => path.includes("manual"));
    calls.classification = [];
    calls.unrelated = [];
    calls.terminal = 0;
    await expect(runChild(q17Parent)).resolves.toMatchObject({ classified: { classification: { key: "7:17" } } });
    await expect(runChild(q20Parent)).resolves.toMatchObject({ classified: { classification: { key: "7:20" } } });
    expect(calls.classification).toEqual([]);
    expect(stateSnapshot(root).filter(([path]) => path.includes("manual"))).toEqual(childSnapshot);
    expect(calls.terminal).toBe(0);

    const { failed: q17Failed, parent: q17Recovery } = q17ExactRecoveryParent(root);
    removeManualArtifacts(root, ["7:17"]);
    const q20ProblemName = readdirSync(join(root, "problem-manual-adjudications"))
      .find((name) => name.startsWith("v1-0007-0020-"))!;
    const q20ProblemPath = join(root, "problem-manual-adjudications", q20ProblemName);
    writeFileSync(q20ProblemPath, Buffer.concat([readFileSync(q20ProblemPath), Buffer.from(" ")]));
    const beforeCrossRowPreflight = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(adjudicateProblemManual(input.entry, input.problem, root, q17Failed, q17Recovery))
      .rejects.toThrow(/7:20 manual adjudication hash가 다릅니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(beforeCrossRowPreflight);
  }, 180_000);

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "rejects a missing Q20 parent before Q17 writes or AI",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q17-q20-manual-missing-"));
    cpSync(q27LiveState, root, { recursive: true });
    removeManualArtifacts(root, ["7:17", "7:20"]);
    const input = q27FixtureInputs(root);
    const { failed, parent } = q17ExactRecoveryParent(root);
    rmSync(join(
      root,
      "classification-recoveries/v1-0007-0020-417cece824faacd34b28f4b57b364033b84b39c461d0efe232d98c244cbfdab5-" +
        "7bb7cb863c8c4855.json"
    ));
    const before = stateSnapshot(root);
    providerMock.complete.mockRejectedValue(new Error("AI must not run"));
    await expect(adjudicateProblemManual(input.entry, input.problem, root, failed, parent))
      .rejects.toThrow(/7:20 manual batch recovery exact-set가 다릅니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(before);
  }, 120_000);

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "crash-resumes Q23-Q29 children before the next honest boundary",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q23-q29-manual-live-"));
    cpSync(q27LiveState, root, { recursive: true });
    removeManualArtifacts(root, ["9:23", "11:28", "11:29"]);
    for (const directory of ["answer-audit", "answer-attestation"]) {
      rmSync(join(root, directory), { recursive: true, force: true });
    }
    const input = q27FixtureInputs(root);
    const parents = [q23ExactRecoveryParent(root), q28ExactRecoveryParent(root), q29ExactRecoveryParent(root)];
    const calls = { classification: [] as string[], unrelated: [] as string[], terminal: 0 };
    let crashKey: string | null = "11:28";
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        const items = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
          key: string;
          question: string;
          figure_description: string | null;
        }>;
        if (items.some((item) => !["9:23", "11:28", "11:29"].includes(item.key))) {
          calls.unrelated.push(...items.map((item) => item.key));
          throw new Error(`unrelated classification blocker: ${items.map((item) => item.key).join(",")}`);
        }
        expect(items).toHaveLength(1);
        const item = items[0];
        calls.classification.push(item.key);
        expect(request.prompt).not.toContain("전사에서 '[21~26]'이 누락되었다");
        if (item.key === "9:23") {
          expect(item.question).toContain("그렇게들 안 할 거예요.");
          expect(item.question).toContain("“애기 엄마…….”");
          expect(item.figure_description).toBeNull();
        } else {
          expect(item.question).toContain("이다지 낡아빠진 생활을 하는 것은 아니리라");
          expect(item.question).toContain("함이정 : 처녀 때 난 생각했었지.");
          expect(item.figure_description).toContain("왼쪽으로 열린 세로 묶음 괄호 [A]");
        }
        if (item.key === crashKey) throw new Error("seeded Q28 manual classification crash");
        return { text: JSON.stringify([{
          key: item.key,
          decision: "accept",
          canonical_subject: "korean_literature",
          curriculum_course: "문학",
          domain: item.key === "9:23"
            ? "전쟁 소설의 사회·역사적 맥락과 비평적 감상"
            : "현대시와 희곡의 표현 방식 및 의미 해석",
          achievement_codes: ["12문학01-03", "12문학01-04"],
          confidence: 0.99,
          reason_codes: ["IN_SCOPE_KOREAN_LITERATURE", "SOURCE_EXACT"],
          transcription_status: "exact",
          transcription_evidence: `공식 source의 ${item.key} 전체 지문·발문·선택지가 일치한다.`,
        }]) };
      }
      if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
        calls.terminal++;
        throw new Error("unexpected fresh terminal before remaining source repairs");
      }
      if (request.schema?.name === "studywork_file_quiz_items") {
        const single = request.prompt.match(/printed problem (\d+) starting on page (\d+)/u);
        const target = single
          ? `${single[2]}:${single[1]}`
          : request.prompt.match(/printed problems: ([^.]+)/u)?.[1] ?? "unknown";
        calls.unrelated.push(target);
        throw new Error(`unrelated extraction blocker: ${target}`);
      }
      throw new Error(`unexpected AI call: ${request.schema?.name ?? "unknown"}`);
    });
    const runChild = (row: ReturnType<typeof q23ExactRecoveryParent>) =>
      adjudicateProblemManual(input.entry, input.problem, root, row.failed, row.parent);
    const run = () => repairAndAuditOfficialAnswers(
      input.entry,
      input.problem,
      input.solution,
      root,
      input.classified,
      input.solutions
    );

    await expect(runChild(parents[0])).resolves.toMatchObject({ classified: { classification: { key: "9:23" } } });
    await expect(runChild(parents[1])).rejects.toThrow("seeded Q28 manual classification crash");
    expect(calls.classification).toEqual(["9:23", "11:28"]);
    expect(calls.terminal).toBe(0);

    crashKey = null;
    calls.classification = [];
    for (const row of parents) await expect(runChild(row)).resolves.toBeDefined();
    expect(calls.classification).toEqual(["11:28", "11:29"]);
    const boundary = await run().then(
      () => "resolved unexpectedly",
      (error: unknown) => error instanceof Error ? error.message : String(error)
    );
    expect([
      "12:31 final source-grounded recovery도 exact가 아닙니다",
      "12:32 final source-grounded recovery도 exact가 아닙니다",
      "15:38 final source-grounded recovery도 exact가 아닙니다",
      "15:40 final source-grounded recovery도 exact가 아닙니다",
      "15:41 final source-grounded recovery도 exact가 아닙니다",
      "15:42 final source-grounded recovery도 exact가 아닙니다",
      "unexpected fresh terminal before remaining source repairs",
      ...q30Q42ManualKeys.map((key) => `unrelated classification blocker: ${key}`),
      ...newTrueRepairManualKeys.map((key) => `unrelated classification blocker: ${key}`),
    ]).toContain(boundary);
    if (boundary === "unexpected fresh terminal before remaining source repairs") {
      expect(calls.unrelated).toEqual([]);
      expect(calls.terminal).toBe(1);
    } else {
      expect(calls.unrelated.every((key) => [...q30Q42ManualKeys, ...newTrueRepairManualKeys].includes(key)))
        .toBe(true);
      expect(calls.terminal).toBe(0);
    }

    const expected = [{
      key: "9:23",
      itemHash: "e4886fd0c2386eba4d4f84d0ef6f1954fc92b8d3a5ddfe99788d533f69f8cb56",
      specHash: "96368c6e161643bdfcfaef63e14ce6cbb3fc183fe32709ca746a018a4132a8bb",
      cropHashes: [
        "c4a3f7ada8aba20a634c7859328d22cab7bd6cb60df921d3b76423b3a45c91a2",
        "689ecb925a36bce576051f72a82ba52392eaebb18ead1b303c7eab65d658f737",
        "9d7b19a1c3201d7aafa074faa0ee73d65639afa846d7065116df7ab21f0f2dc9",
      ],
      lastSize: [3159, 2184],
    }, {
      key: "11:28",
      itemHash: "a15e214e36dd59e6275e46afcb15b84b13102a55c3545dd0d25eeedfd94bb86e",
      specHash: "53f4829e4f8279336872abe5d140e75463121cf664b3c0afe35c465a55ace04d",
      cropHashes: [
        "5292aacb2170ebb8ae9c70ba089bce6ce689ff9276e9d997b0f3d16c3cb3d665",
        "c534698ffb42c13ef9642bdd930e2b7ddd8b54c907bed0a5dd69ed960d7013e6",
        "581577c6aba6368e2e807d3491debc8bda2c27e4e891a734a374077ba9909376",
        "f4a0912b56ff5f19180cd6701e1b9e8a1760903869fa5284ba364f854d0587e0",
        "bcf9877f718ffb78a638ccde04f1525ae15d15dd0d948790344d6d7e22ea23fb",
      ],
      lastSize: [3159, 3970],
    }, {
      key: "11:29",
      itemHash: "573a51fae9eb3e4c5ea2aa6697fcf5ad01e0aa4826645865d2e5b012416e1618",
      specHash: "1fe98d0353b33fd15520a9c62f7ab18572716044597cc731bcc227cb0a9dfc20",
      cropHashes: [
        "5292aacb2170ebb8ae9c70ba089bce6ce689ff9276e9d997b0f3d16c3cb3d665",
        "c534698ffb42c13ef9642bdd930e2b7ddd8b54c907bed0a5dd69ed960d7013e6",
        "581577c6aba6368e2e807d3491debc8bda2c27e4e891a734a374077ba9909376",
        "f4a0912b56ff5f19180cd6701e1b9e8a1760903869fa5284ba364f854d0587e0",
        "31dd633179ce6373e82db5ef005052dd994d72cf0651b1b543873530b3ba952f",
      ],
      lastSize: [3159, 2382],
    }] as const;
    for (const row of expected) {
      const [page, number] = row.key.split(":");
      const prefix = `v1-${page.padStart(4, "0")}-${number.padStart(4, "0")}-`;
      const problemName = readdirSync(join(root, "problem-manual-adjudications"))
        .find((name) => name.startsWith(prefix))!;
      const classificationName = readdirSync(join(root, "classification-manual-adjudications"))
        .find((name) => name.startsWith(prefix))!;
      const checkpoint = JSON.parse(readFileSync(join(root, "problem-manual-adjudications", problemName), "utf8"));
      expect(canonicalEvidenceHash(checkpoint.item)).toBe(row.itemHash);
      expect(checkpoint.basis.correctionSpecHash).toBe(row.specHash);
      expect(checkpoint.basis.cropViews.map((view: { pixelSha256: string }) => view.pixelSha256))
        .toEqual(row.cropHashes);
      expect(checkpoint.basis.cropViews.at(-1)).toMatchObject({
        pixelWidth: row.lastSize[0],
        pixelHeight: row.lastSize[1],
      });
      expect(JSON.parse(readFileSync(
        join(root, "classification-manual-adjudications", classificationName),
        "utf8"
      )).items[0]).toMatchObject({
        key: row.key,
        decision: "accept",
        canonical_subject: "korean_literature",
        curriculum_course: "문학",
        transcription_status: "exact",
      });
    }

    const childSnapshot = stateSnapshot(root).filter(([path]) => path.includes("manual"));
    calls.classification = [];
    calls.unrelated = [];
    for (const row of parents) await expect(runChild(row)).resolves.toBeDefined();
    expect(calls.classification).toEqual([]);
    expect(stateSnapshot(root).filter(([path]) => path.includes("manual"))).toEqual(childSnapshot);

    const { failed: q23Failed, parent: q23Parent } = q23ExactRecoveryParent(root);
    removeManualArtifacts(root, ["9:23"]);
    const q29ProblemName = readdirSync(join(root, "problem-manual-adjudications"))
      .find((name) => name.startsWith("v1-0011-0029-"))!;
    const q29ProblemPath = join(root, "problem-manual-adjudications", q29ProblemName);
    writeFileSync(q29ProblemPath, Buffer.concat([readFileSync(q29ProblemPath), Buffer.from(" ")]));
    const beforeCrossRowPreflight = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(adjudicateProblemManual(input.entry, input.problem, root, q23Failed, q23Parent))
      .rejects.toThrow(/11:29 manual adjudication hash가 다릅니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(beforeCrossRowPreflight);
  }, 180_000);

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "rejects missing or orphaned Q29 authority before Q23 writes or AI",
    async () => {
    for (const mode of ["missing parent", "orphan child"] as const) {
      const stateDir = mkdtempSync(join(tmpdir(), "studywork-q23-q29-manual-prewrite-"));
      try {
        cpSync(q27LiveState, stateDir, { recursive: true });
        removeManualArtifacts(stateDir, ["9:23", "11:28", "11:29"]);
        const input = q27FixtureInputs(stateDir);
        const { failed, parent } = q23ExactRecoveryParent(stateDir);
        if (mode === "missing parent") {
          rmSync(join(
            stateDir,
            "classification-recoveries/v1-0011-0029-334f8c6b9e9dbcd1203157a4c95d991692f7b7d7d4b11259623ef4d38429954e-" +
              "7bb7cb863c8c4855.json"
          ));
        } else {
          mkdirSync(join(stateDir, "problem-manual-adjudications"), { recursive: true });
          writeFileSync(
            join(stateDir, "problem-manual-adjudications", `v1-0011-0029-${"0".repeat(64)}.json`),
            "{}\n"
          );
        }
        const before = stateSnapshot(stateDir);
        providerMock.complete.mockRejectedValue(new Error("AI must not run"));
        await expect(adjudicateProblemManual(input.entry, input.problem, stateDir, failed, parent))
          .rejects.toThrow(mode === "missing parent"
            ? /11:29 manual batch recovery exact-set가 다릅니다/u
            : /11:29 manual adjudication preflight orphan\/conflict/u);
        expect(providerMock.complete).not.toHaveBeenCalled();
        expect(stateSnapshot(stateDir)).toEqual(before);
        providerMock.complete.mockReset();
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "crash-resumes only Q27 before unrelated manual blockers",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q27-manual-live-"));
    cpSync(q27LiveState, root, { recursive: true });
    for (const directory of [
      "problem-manual-evidence",
      "problem-manual-adjudications",
      "classification-manual-adjudications",
      "classification-manual-policy-revisions",
      "answer-audit",
      "answer-attestation",
    ]) rmSync(join(root, directory), { recursive: true, force: true });
    q27FixtureInputs(root);
    const calls = { extraction: [] as string[], classification: 0, unrelated: [] as string[] };
    const otherManualKeys = [
      "4:8", "6:16", "9:23", "11:28", "11:29", "16:43", "16:44", "16:45", ...q30Q42ManualKeys,
    ];
    let crashClassification = true;
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_file_quiz_items") {
        const single = request.prompt.match(/printed problem (\d+) starting on page (\d+)/u);
        const target = single
          ? `${single[2]}:${single[1]}`
          : request.prompt.match(/printed problems: ([^.]+)/u)?.[1] ?? "unknown";
        calls.extraction.push(target);
        if (target.includes("11:27")) throw new Error("Q27 extraction must not run");
        throw new Error(`unrelated persisted blocker: ${target}`);
      }
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        const inputs = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{ key: string }>;
        expect(inputs).toHaveLength(1);
        if (inputs[0].key !== "11:27") {
          calls.unrelated.push(inputs[0].key);
          throw new Error("unrelated persisted manual blocker");
        }
        calls.classification++;
        expect(request.prompt).toContain("이다지 낡아빠진 생활을 하는 것은 아니리라");
        expect(request.prompt).toContain("‘존재 없이’ 살아가는 것이 어렵다고");
        expect(request.prompt).not.toContain("공식 10쪽의 (가)에서 원문은");
        if (crashClassification) throw new Error("seeded Q27 manual classification crash");
        return { text: JSON.stringify([{
          key: "11:27",
          decision: "accept",
          canonical_subject: "korean_literature",
          curriculum_course: "문학",
          domain: "현대시의 화자와 자기 성찰 및 시어의 의미 이해",
          achievement_codes: ["12문학01-01", "12문학01-03"],
          confidence: 0.99,
          reason_codes: ["IN_SCOPE_KOREAN_LITERATURE", "MODERN_POETRY_COMPREHENSION"],
          transcription_status: "exact",
          transcription_evidence: "공식 10~11쪽의 (가), (나), Q27과 다섯 선택지가 모두 일치한다.",
        }]) };
      }
      throw new Error(`unexpected AI call: ${request.schema?.name ?? "unknown"}: ${request.prompt.slice(0, 500)}`);
    });
    const run = () => {
      const input = q27FixtureInputs(root);
      return repairAndAuditOfficialAnswers(
        input.entry,
        input.problem,
        input.solution,
        root,
        input.classified,
        input.solutions
      );
    };

    await expect(run()).rejects.toThrow(/seeded Q27 manual classification crash|unrelated persisted manual blocker/u);
    expect(calls.extraction).toEqual([]);
    expect(calls.classification).toBe(1);
    expect(calls.unrelated.length).toBeGreaterThan(0);
    expect(calls.unrelated.every((key) => otherManualKeys.includes(key))).toBe(true);
    expect(readdirSync(join(root, "problem-manual-evidence"))
      .filter((name) => name.startsWith("v1-0011-0027-"))).toHaveLength(6);
    const q27ProblemNames = readdirSync(join(root, "problem-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0011-0027-"));
    expect(q27ProblemNames).toHaveLength(1);
    expect(existsSync(join(root, "classification-manual-adjudications"))
      ? readdirSync(join(root, "classification-manual-adjudications"))
        .filter((name) => name.startsWith("v1-0011-0027-")).length
      : 0).toBe(0);
    const problemName = q27ProblemNames[0];
    const problemPath = join(root, "problem-manual-adjudications", problemName);
    const problemBytes = readFileSync(problemPath);

    crashClassification = false;
    calls.classification = 0;
    calls.unrelated = [];
    await expect(run()).rejects.toThrow("unrelated persisted manual blocker");
    expect(calls.extraction).toEqual([]);
    expect(calls.classification).toBe(1);
    expect(calls.unrelated.length).toBeGreaterThan(0);
    expect(calls.unrelated.every((key) => otherManualKeys.includes(key))).toBe(true);
    const q27ClassificationNames = readdirSync(join(root, "classification-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0011-0027-"));
    expect(q27ClassificationNames).toHaveLength(1);
    const classificationName = q27ClassificationNames[0];
    const classificationPath = join(root, "classification-manual-adjudications", classificationName);
    const classificationBytes = readFileSync(classificationPath);
    const problemCheckpoint = JSON.parse(problemBytes.toString("utf8"));
    const classificationCheckpoint = JSON.parse(classificationBytes.toString("utf8"));
    expect(canonicalEvidenceHash(problemCheckpoint.item))
      .toBe("0364d049bef73773465b13f09fa2f234e9c7fc4ef4f9f9bdefeef0a8692c457b");
    expect(classificationCheckpoint.items).toEqual([expect.objectContaining({
      key: "11:27",
      decision: "accept",
      canonical_subject: "korean_literature",
      curriculum_course: "문학",
      domain: expect.any(String),
      achievement_codes: expect.arrayContaining(["12문학01-01"]),
      transcription_status: "exact",
    })]);
    expect(problemCheckpoint.basis).toMatchObject({
      parentRecoveryEvidenceHash: "186e1381194aab5765fc72d88fb3e9a85901867d4a398588c7e38aa7f463dfdb",
      parentRecovery: {
      problemArtifact: {
        path: "problem-recoveries/v1-0011-0027-e2d59ea1699886f21ab5218fd221a8fa05f0beb46a1782ed48c9ec9cb583541c.json",
        sha256: "28ed8a585e6bac2b0de42cc1a252b780b75c7c8dfc171ff5e19569b97d865ffe",
      },
      classificationArtifact: {
        path: "classification-recoveries/v1-0011-0027-9cae9db11869c6adbd575b6ee6b08ce51d75c483e3897a8afe1b698044223551-7bb7cb863c8c4855.json",
        sha256: "7d6c1b764a2b3d9e4e4c777c2d3a2c06ff930f9f7c329b9309ef9dd3a80d0454",
      },
      },
    });
    expect(existsSync(join(root, "answer-audit"))).toBe(false);
    expect(existsSync(join(root, "answer-attestation"))).toBe(false);

    calls.extraction = [];
    calls.unrelated = [];
    const beforeReplayClassification = calls.classification;
    await expect(run()).rejects.toThrow("unrelated persisted manual blocker");
    expect(calls.extraction).toEqual([]);
    expect(calls.classification).toBe(beforeReplayClassification);
    expect(calls.unrelated.length).toBeGreaterThan(0);
    expect(calls.unrelated.every((key) => otherManualKeys.includes(key))).toBe(true);
    expect(readFileSync(problemPath)).toEqual(problemBytes);
    expect(readFileSync(classificationPath)).toEqual(classificationBytes);
  }, 120_000);

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "preflights and crash-resumes Q43-Q45 before unrelated later blockers",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q43-45-manual-live-"));
    cpSync(q27LiveState, root, { recursive: true });
    removeManualArtifacts(root, ["16:43", "16:44", "16:45"]);
    for (const directory of ["answer-audit", "answer-attestation"]) {
      rmSync(join(root, directory), { recursive: true, force: true });
    }
    const calls = {
      classification: [] as string[],
      unrelatedClassification: [] as string[],
      extraction: [] as string[],
      terminal: 0,
    };
    let crashKey: string | null = "16:44";
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_classification") {
        const inputs = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{
          key: string;
          question: string;
          figure_description: string | null;
        }>;
        expect(inputs).toHaveLength(1);
        const item = inputs[0];
        const key = item.key;
        if ([
          "4:8", "6:16", "7:17", "7:20", "9:23", "11:28", "11:29",
          ...q30Q42ManualKeys,
          ...newTrueRepairManualKeys,
        ].includes(key)) {
          calls.unrelatedClassification.push(key);
          throw new Error(`unrelated persisted manual blocker: ${key}`);
        }
        calls.classification.push(key);
        expect(["16:43", "16:44", "16:45"]).toContain(key);
        expect(item.question).toContain("[43 ~ 45] 다음 글을 읽고 물음에 답하시오.");
        expect(item.question).toContain("흥정 외상 셈하려 주주리는 지저귄다");
        expect(item.figure_description).toContain("오른쪽으로 열린 세로 묶음 괄호가 정확히 두 개");
        if (key === crashKey) throw new Error(`seeded ${key} manual classification crash`);
        return { text: JSON.stringify([{
          key,
          decision: "accept",
          canonical_subject: "korean_literature",
          curriculum_course: "문학",
          domain: "고전 기행 가사의 내용과 표현 및 부분별 감상",
          achievement_codes: ["12문학01-02", "12문학01-03"],
          confidence: 0.99,
          reason_codes: ["CLASSICAL_GASA", "LITERARY_COMPREHENSION"],
          transcription_status: "exact",
          transcription_evidence: `공식 16쪽 전체 제시문과 ${key} 발문·선택지가 일치한다.`,
        }]) };
      }
      if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
        calls.terminal++;
        const inputs = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{ key: string }>;
        expect(inputs).toHaveLength(45);
        expect(new Set(inputs.map((input) => input.key)).size).toBe(45);
        throw new Error("seeded fresh Q43-Q45 terminal boundary");
      }
      if (request.schema?.name === "studywork_file_quiz_items") {
        const single = request.prompt.match(/printed problem (\d+) starting on page (\d+)/u);
        const target = single
          ? `${single[2]}:${single[1]}`
          : request.prompt.match(/printed problems: ([^.]+)/u)?.[1] ?? "unknown";
        calls.extraction.push(target);
        throw new Error(`unrelated persisted blocker: ${target}`);
      }
      throw new Error(`unexpected AI call: ${request.schema?.name ?? "unknown"}`);
    });
    const run = () => {
      const input = q27FixtureInputs(root);
      return repairAndAuditOfficialAnswers(
        input.entry,
        input.problem,
        input.solution,
        root,
        input.classified,
        input.solutions
      );
    };

    await expect(run()).rejects.toThrow(
      /seeded 16:44 manual classification crash|unrelated persisted (?:manual )?blocker: (?:4:8|6:16|7:(?:17|18|19|20)|9:23|11:(?:28|29|30)|12:(?:31|32)|14:37|15:(?:38|39|40|41|42))/u
    );
    expect(calls.extraction.every((key) => !["16:43", "16:44", "16:45"].includes(key))).toBe(true);
    expect(calls.terminal).toBe(0);
    expect([...calls.classification].sort()).toEqual(["16:43", "16:44", "16:45"]);
    const q43Problem = readdirSync(join(root, "problem-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0016-0043-"));
    const q43Classification = readdirSync(join(root, "classification-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0016-0043-"));
    const q44Problem = readdirSync(join(root, "problem-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0016-0044-"));
    expect(q43Problem).toHaveLength(1);
    expect(q43Classification).toHaveLength(1);
    expect(q44Problem).toHaveLength(1);
    expect(readdirSync(join(root, "classification-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0016-0044-"))).toHaveLength(0);
    expect(readdirSync(join(root, "problem-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0016-0045-"))).toHaveLength(1);
    expect(readdirSync(join(root, "classification-manual-adjudications"))
      .filter((name) => name.startsWith("v1-0016-0045-"))).toHaveLength(1);
    const q43Bytes = readFileSync(join(root, "problem-manual-adjudications", q43Problem[0]));

    crashKey = null;
    calls.classification = [];
    calls.unrelatedClassification = [];
    calls.extraction = [];
    const secondBoundary = await run().then(
      () => "resolved unexpectedly",
      (error: unknown) => error instanceof Error ? error.message : String(error)
    );
    expect([
      "seeded fresh Q43-Q45 terminal boundary",
      ...["4:8", "6:16", "7:17", "7:18", "7:19", "7:20", "9:23", "11:28", "11:29", "11:30",
        "12:31", "12:32", "14:37", "15:38", "15:39", "15:40", "15:41", "15:42"]
        .flatMap((key) => [`unrelated persisted blocker: ${key}`, `unrelated persisted manual blocker: ${key}`]),
    ]).toContain(secondBoundary);
    expect(calls.classification).toEqual(["16:44"]);
    if (secondBoundary === "seeded fresh Q43-Q45 terminal boundary") {
      expect(calls.unrelatedClassification).toEqual([]);
      expect(calls.extraction).toEqual([]);
      expect(calls.terminal).toBe(1);
    } else {
      expect(calls.unrelatedClassification.length + calls.extraction.length).toBeGreaterThan(0);
      expect(calls.terminal).toBe(0);
    }
    expect(readFileSync(join(root, "problem-manual-adjudications", q43Problem[0]))).toEqual(q43Bytes);
    for (const [key, hash] of [
      ["16:43", "87113019baba8982c876c340bc9f85cfdc2196c2c8bff520495ec09fca91e0b4"],
      ["16:44", "d1442d6b9b32e207e702dbfb8c4135ceb992d54b48b599f423eb70812bf10086"],
      ["16:45", "ac66722a22fa15b19ba54228b4f13a341e8a0c57ef69e738ddb922f9bec92732"],
    ] as const) {
      const [page, number] = key.split(":").map(Number);
      const problemName = readdirSync(join(root, "problem-manual-adjudications"))
        .find((name) => name.startsWith(`v1-${String(page).padStart(4, "0")}-${String(number).padStart(4, "0")}-`))!;
      const classificationName = readdirSync(join(root, "classification-manual-adjudications"))
        .find((name) => name.startsWith(`v1-${String(page).padStart(4, "0")}-${String(number).padStart(4, "0")}-`))!;
      expect(canonicalEvidenceHash(JSON.parse(readFileSync(
        join(root, "problem-manual-adjudications", problemName),
        "utf8"
      )).item)).toBe(hash);
      expect(JSON.parse(readFileSync(
        join(root, "classification-manual-adjudications", classificationName),
        "utf8"
      )).items).toEqual([expect.objectContaining({
        key,
        decision: "accept",
        canonical_subject: "korean_literature",
        curriculum_course: "문학",
        transcription_status: "exact",
      })]);
    }
    expect(existsSync(join(root, "answer-audit"))).toBe(false);

    const childSnapshot = stateSnapshot(root).filter(([path]) => path.includes("manual"));
    calls.classification = [];
    calls.unrelatedClassification = [];
    calls.extraction = [];
    calls.terminal = 0;
    const replayBoundary = await run().then(
      () => "resolved unexpectedly",
      (error: unknown) => error instanceof Error ? error.message : String(error)
    );
    expect([
      "seeded fresh Q43-Q45 terminal boundary",
      ...["4:8", "6:16", "7:17", "7:18", "7:19", "7:20", "9:23", "11:28", "11:29", "11:30",
        "12:31", "12:32", "14:37", "15:38", "15:39", "15:40", "15:41", "15:42"]
        .flatMap((key) => [`unrelated persisted blocker: ${key}`, `unrelated persisted manual blocker: ${key}`]),
    ]).toContain(replayBoundary);
    expect(calls.classification).toEqual([]);
    if (replayBoundary === "seeded fresh Q43-Q45 terminal boundary") {
      expect(calls.unrelatedClassification).toEqual([]);
      expect(calls.extraction).toEqual([]);
      expect(calls.terminal).toBe(1);
    } else {
      expect(calls.unrelatedClassification.length + calls.extraction.length).toBeGreaterThan(0);
      expect(calls.terminal).toBe(0);
    }
    expect(stateSnapshot(root).filter(([path]) => path.includes("manual"))).toEqual(childSnapshot);

    const q43ProblemPath = join(root, "problem-manual-adjudications", q43Problem[0]);
    const q43ProblemCheckpoint = JSON.parse(readFileSync(q43ProblemPath, "utf8"));
    const q43Parent = q43ProblemCheckpoint.basis.parentRecovery as ProblemRecoveryEvidence;
    const q43Failed: ClassifiedQuestion = {
      question: JSON.parse(readFileSync(join(root, q43Parent.problemArtifact.path), "utf8")).item,
      classification: JSON.parse(readFileSync(join(root, q43Parent.classificationArtifact.path), "utf8")).items[0],
    };
    for (const name of readdirSync(join(root, "problem-manual-evidence"))) {
      if (name.startsWith("v1-0016-0043-")) rmSync(join(root, "problem-manual-evidence", name));
    }
    rmSync(q43ProblemPath);
    rmSync(join(root, "classification-manual-adjudications", q43Classification[0]));
    const q45ProblemName = readdirSync(join(root, "problem-manual-adjudications"))
      .find((name) => name.startsWith("v1-0016-0045-"))!;
    const q45ProblemPath = join(root, "problem-manual-adjudications", q45ProblemName);
    writeFileSync(q45ProblemPath, Buffer.concat([readFileSync(q45ProblemPath), Buffer.from(" ")]));
    const beforeCrossRowPreflight = stateSnapshot(root);
    providerMock.complete.mockClear();
    const input = q27FixtureInputs(root);
    await expect(adjudicateProblemManual(input.entry, input.problem, root, q43Failed, q43Parent))
      .rejects.toThrow(/16:45 manual adjudication hash가 다릅니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(beforeCrossRowPreflight);
  }, 180_000);

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "rejects Q27 parent, source, orphan, and max-one drift before manual writes or AI",
    async () => {
    const cases: Array<{
      label: string;
      mutate: (stateDir: string, parent: ProblemRecoveryEvidence) => void;
      error: RegExp;
    }> = [{
      label: "self-consistent alternate parent pointer",
      mutate: (stateDir, parent) => {
        const alias = `problem-recoveries/v1-0011-0027-${"0".repeat(64)}.json`;
        cpSync(join(stateDir, parent.problemArtifact.path), join(stateDir, alias));
        parent.problemArtifact = { ...parent.problemArtifact, path: alias };
        expect(canonicalEvidenceHash(parent))
          .not.toBe("186e1381194aab5765fc72d88fb3e9a85901867d4a398588c7e38aa7f463dfdb");
      },
      error: /manual adjudication 입력이 exhausted recovery/u,
    }, {
      label: "tampered official problem source",
      mutate: (stateDir) => writeFileSync(
        join(stateDir, "problem.pdf"),
        Buffer.concat([readFileSync(join(stateDir, "problem.pdf")), Buffer.from("tampered")])
      ),
      error: /공식 source bytes hash/u,
    }, {
      label: "orphan manual child",
      mutate: (stateDir) => {
        mkdirSync(join(stateDir, "problem-manual-adjudications"), { recursive: true });
        writeFileSync(join(stateDir, "problem-manual-adjudications", "orphan.json"), "{}\n");
      },
      error: /problem manual adjudication filename/u,
    }, {
      label: "two manual children",
      mutate: (stateDir) => {
        mkdirSync(join(stateDir, "problem-manual-adjudications"), { recursive: true });
        for (const digest of ["0".repeat(64), "1".repeat(64)]) {
          writeFileSync(
            join(stateDir, "problem-manual-adjudications", `v1-0011-0027-${digest}.json`),
            "{}\n"
          );
        }
      },
      error: /manual adjudication preflight orphan\/conflict/u,
    }];

    for (const testCase of cases) {
      const stateDir = mkdtempSync(join(tmpdir(), "studywork-q27-manual-prewrite-"));
      try {
        cpSync(q27LiveState, stateDir, { recursive: true });
        removeManualArtifacts(stateDir, ["11:27"]);
        const input = q27FixtureInputs(stateDir);
        const { failed, parent } = q27ExactRecoveryParent(stateDir);
        testCase.mutate(stateDir, parent);
        const before = stateSnapshot(stateDir);
        providerMock.complete.mockRejectedValue(new Error("AI must not run"));
        await expect(
          adjudicateProblemManual(input.entry, input.problem, stateDir, failed, parent),
          testCase.label
        ).rejects.toThrow(testCase.error);
        expect(providerMock.complete, testCase.label).not.toHaveBeenCalled();
        expect(stateSnapshot(stateDir), testCase.label).toEqual(before);
        providerMock.complete.mockReset();
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it.skipIf(!existsSync(join(q27LiveState, "problem.pdf")))(
    "validates every existing Q27 crop byte before resuming a missing earlier view",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q27-manual-partial-"));
    cpSync(q27LiveState, root, { recursive: true });
    removeManualArtifacts(root, ["11:27"]);
    const input = q27FixtureInputs(root);
    const { failed, parent } = q27ExactRecoveryParent(root);
    providerMock.complete.mockRejectedValue(new Error("seeded Q27 classification crash"));
    await expect(adjudicateProblemManual(input.entry, input.problem, root, failed, parent))
      .rejects.toThrow("seeded Q27 classification crash");
    const evidenceDirectory = join(root, "problem-manual-evidence");
    const checkpoint = readdirSync(evidenceDirectory)
      .find((name) => name.startsWith("v1-0011-0027-") && name.endsWith(".json"))!;
    const views = readdirSync(evidenceDirectory)
      .filter((name) => name.startsWith("v1-0011-0027-") && name.endsWith(".png"))
      .sort();
    expect(views).toHaveLength(4);
    rmSync(join(evidenceDirectory, checkpoint));
    rmSync(join(evidenceDirectory, views[0]));
    writeFileSync(
      join(evidenceDirectory, views[1]),
      Buffer.concat([readFileSync(join(evidenceDirectory, views[1])), Buffer.from("tampered")])
    );
    for (const directory of ["problem-manual-adjudications", "classification-manual-adjudications"]) {
      const path = join(root, directory);
      if (!existsSync(path)) continue;
      for (const name of readdirSync(path)) {
        if (name.startsWith("v1-0011-0027-")) rmSync(join(path, name));
      }
    }
    providerMock.complete.mockReset();
    providerMock.complete.mockRejectedValue(new Error("AI must not run"));
    const before = stateSnapshot(root);
    await expect(adjudicateProblemManual(input.entry, input.problem, root, failed, parent))
      .rejects.toThrow(/기존 binary evidence가 다릅니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(before);
  }, 120_000);

  it.skipIf(!available)("rejects a changed parent item before applying any correction", () => {
    const item = structuredClone(itemAt(2));
    item.question += " tampered";
    expect(canonicalEvidenceHash(item)).not.toBe(PROBLEM_MANUAL_ADJUDICATION_ALLOWLIST[2].failedQuestionHash);
    expect(() => applyAllowlistedProblemManualCorrection(cases[2].entryId, cases[2].sourceHash, item))
      .toThrow(/failed question hash/u);
  });

  for (const testCase of recoveryCases) {
    it.skipIf(!recoveryCasesAvailable)(
      `replays ${cases[testCase.index].entryId} recovery-parent manual evidence without AI`,
      async () => runRecoveryManualCase(testCase),
      90_000
    );
  }

  it.skipIf(!existsSync(join(q27LiveState, "solution.pdf")))(
    "accepts two diagnostic evidence variants and replays each semantic projection without bulk AI",
    async () => {
    for (const suffix of [" alternate wording A", " 같은 판정의 다른 근거 문구 B"]) {
      root = mkdtempSync(join(tmpdir(), "studywork-q17-q34-solution-evidence-variant-"));
      cpSync(q27LiveState, root, { recursive: true });
      removeSolutionRepairArtifacts(root);
      rmSync(join(root, "solution-fidelity"), { recursive: true, force: true });
      const input = q27FixtureInputs(root);
      const bulkCalls: string[][] = [];
      providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
        if (request.schema?.name === "studywork_exam_corpus_solution_fidelity") {
          const decisions = q5525982FidelityDecisions(request.prompt).map((decision) => ({
            ...decision,
            evidence: `${decision.evidence}${suffix}`,
          }));
          if (decisions.length > 1) bulkCalls.push(decisions.map((decision) => decision.key));
          return { text: JSON.stringify(decisions) };
        }
        if (request.schema?.name === "studywork_solution_file_items") {
          throw new Error(`seeded evidence variant boundary:${suffix}`);
        }
        throw new Error(`unexpected AI call: ${request.schema?.name ?? "unknown"}`);
      });
      const run = () => repairAndAuditOfficialAnswers(
        input.entry,
        input.problem,
        input.solution,
        root,
        input.classified,
        input.solutions
      );
      await expect(run()).rejects.toThrow(`seeded evidence variant boundary:${suffix}`);
      expect(bulkCalls.map((keys) => keys.length)).toEqual([14, 16]);
      for (const checkpoint of SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0].checkpoints) {
        const bytes = readFileSync(join(root, checkpoint.path));
        const parsed = JSON.parse(bytes.toString("utf8"));
        expect(hash(bytes)).toBe(canonicalEvidenceHash(parsed));
        expect(parsed.items.every((decision: { evidence: string }) => decision.evidence.endsWith(suffix))).toBe(true);
      }
      const completed = stateSnapshot(root);
      bulkCalls.length = 0;
      providerMock.complete.mockClear();
      await expect(run()).rejects.toThrow(`seeded evidence variant boundary:${suffix}`);
      expect(bulkCalls).toEqual([]);
      expect(providerMock.complete).toHaveBeenCalledTimes(1);
      expect(stateSnapshot(root)).toEqual(completed);
      rmSync(root, { recursive: true, force: true });
      root = "";
      providerMock.complete.mockReset();
    }
  }, 300_000);

  it.skipIf(!existsSync(join(q27LiveState, "solution.pdf")))(
    "rejects wrong solution fidelity status, source page, and key before checkpoint writes",
    async () => {
    const cases = [{
      label: "status",
      mutate: (decision: ReturnType<typeof q5525982FidelityDecisions>[number]) => ({
        ...decision,
        answerStatus: "mismatch" as const,
      }),
      error: /semantic projection/u,
    }, {
      label: "source page",
      mutate: (decision: ReturnType<typeof q5525982FidelityDecisions>[number]) => ({
        ...decision,
        sourcePage: decision.sourcePage + 1,
      }),
      error: /semantic projection/u,
    }, {
      label: "key",
      mutate: (decision: ReturnType<typeof q5525982FidelityDecisions>[number]) => ({
        ...decision,
        key: "99:99",
      }),
      error: /key가 없거나 중복/u,
    }];
    for (const testCase of cases) {
      root = mkdtempSync(join(tmpdir(), `studywork-q17-q34-solution-wrong-${testCase.label}-`));
      cpSync(q27LiveState, root, { recursive: true });
      removeSolutionRepairArtifacts(root);
      rmSync(join(root, "solution-fidelity"), { recursive: true, force: true });
      const before = stateSnapshot(root);
      providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
        expect(request.schema?.name).toBe("studywork_exam_corpus_solution_fidelity");
        const decisions = q5525982FidelityDecisions(request.prompt);
        return { text: JSON.stringify([testCase.mutate(decisions[0]), ...decisions.slice(1)]) };
      });
      const input = q27FixtureInputs(root);
      await expect(repairAndAuditOfficialAnswers(
        input.entry,
        input.problem,
        input.solution,
        root,
        input.classified,
        input.solutions
      ), testCase.label).rejects.toThrow(testCase.error);
      expect(providerMock.complete, testCase.label).toHaveBeenCalledTimes(1);
      expect(existsSync(join(root, "solution-fidelity")), testCase.label).toBe(false);
      expect(stateSnapshot(root), testCase.label).toEqual(before);
      rmSync(root, { recursive: true, force: true });
      root = "";
      providerMock.complete.mockReset();
    }
  }, 300_000);

  it.skipIf(!existsSync(join(q27LiveState, "solution.pdf")))(
    "crash-resumes eleven pinned solution repairs and replays only the honest Q40 boundary",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q17-q34-solution-resume-"));
    cpSync(q27LiveState, root, { recursive: true });
    removeSolutionRepairArtifacts(root);
    const input = q27FixtureInputs(root);
    const calls = {
      bulk: [] as string[][],
      repair: [] as string[],
      repairFidelity: [] as string[],
    };
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_solution_fidelity") {
        const decisions = q5525982FidelityDecisions(request.prompt);
        if (decisions.length > 1) calls.bulk.push(decisions.map((decision) => decision.key));
        else calls.repairFidelity.push(decisions[0].key);
        return { text: JSON.stringify(decisions) };
      }
      if (request.schema?.name === "studywork_solution_file_items") {
        const number = Number(request.prompt.match(/printed solution (\d+)/u)?.[1]);
        const key = SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0].items
          .find((item) => Number(item.key.split(":")[1]) === number)?.key ?? `15:${number}`;
        calls.repair.push(key);
        if (number === 40) throw new Error("seeded honest Q40 solution repair boundary");
        return { text: JSON.stringify([q5525982CorrectedSolution(input.solutions, key)]) };
      }
      throw new Error(`unexpected AI call: ${request.schema?.name ?? "unknown"}`);
    });
    const run = () => repairAndAuditOfficialAnswers(
      input.entry,
      input.problem,
      input.solution,
      root,
      input.classified,
      input.solutions
    );

    await expect(run()).rejects.toThrow("seeded honest Q40 solution repair boundary");
    expect(calls.bulk.map((keys) => keys.length)).toEqual([]);
    expect(calls.repair).toEqual(["15:40"]);
    expect(calls.repairFidelity).toEqual([]);
    for (const checkpoint of SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0].checkpoints) {
      const bytes = readFileSync(join(root, checkpoint.path));
      expect(hash(bytes)).toBe(canonicalEvidenceHash(JSON.parse(bytes.toString("utf8"))));
    }
    expect(readdirSync(join(root, "solution-repairs"))).toHaveLength(11);
    expect(readdirSync(join(root, "solution-fidelity-repairs"))).toHaveLength(11);
    expect(existsSync(join(root, "answer-audit"))).toBe(false);
    expect(existsSync(join(root, "answer-attestation"))).toBe(false);

    calls.bulk = [];
    calls.repair = [];
    calls.repairFidelity = [];
    await expect(run()).rejects.toThrow("seeded honest Q40 solution repair boundary");
    expect(calls.bulk).toEqual([]);
    expect(calls.repairFidelity).toEqual([]);
    expect(calls.repair).toEqual(["15:40"]);
    const repairFiles = readdirSync(join(root, "solution-repairs")).sort();
    const fidelityFiles = readdirSync(join(root, "solution-fidelity-repairs")).sort();
    expect(repairFiles).toHaveLength(11);
    expect(fidelityFiles).toHaveLength(11);
    expect(fidelityFiles.every((name) => name.startsWith("v2-"))).toBe(true);
    for (const spec of SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0].items.slice(0, 11)) {
      const number = Number(spec.key.split(":")[1]);
      const name = repairFiles.find((candidate) => candidate.includes(`-${String(number).padStart(4, "0")}-`))!;
      const checkpoint = JSON.parse(readFileSync(join(root, "solution-repairs", name), "utf8"));
      expect(canonicalEvidenceHash(checkpoint.item), spec.key).toBe(spec.expectedSolutionItemHash);
    }
    const exactNumbers = [16, 19, 20, 24, 27, 28, 29, 33, 35, 36, 37, 38, 39];
    const repairedNumbers = repairFiles.map((name) => Number(/^v[12]-\d{4}-(\d{4})-/u.exec(name)?.[1]));
    expect(exactNumbers.some((number) => repairedNumbers.includes(number))).toBe(false);
    expect(repairedNumbers).not.toContain(40);
    expect(existsSync(join(root, "answer-audit"))).toBe(false);
    expect(existsSync(join(root, "answer-attestation"))).toBe(false);

    const completed = stateSnapshot(root);
    calls.bulk = [];
    calls.repair = [];
    calls.repairFidelity = [];
    await expect(run()).rejects.toThrow("seeded honest Q40 solution repair boundary");
    expect(calls).toEqual({ bulk: [], repair: ["15:40"], repairFidelity: [] });
    expect(stateSnapshot(root)).toEqual(completed);
  }, 420_000);

  it.skipIf(!existsSync(join(q27LiveState, "solution.pdf")))(
    "writes deterministic Q17 v2 repair and fidelity without targeted solution AI",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q17-solution-v2-repair-"));
    cpSync(q27LiveState, root, { recursive: true });
    removeSolutionRepairArtifacts(root);
    const input = q27FixtureInputs(root);
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_solution_fidelity") {
        const decisions = q5525982FidelityDecisions(request.prompt);
        return { text: JSON.stringify(decisions) };
      }
      if (request.schema?.name === "studywork_solution_file_items") {
        throw new Error("seeded deterministic forced rows completed");
      }
      throw new Error(`unexpected AI call: ${request.schema?.name ?? "unknown"}`);
    });
    const run = () => repairAndAuditOfficialAnswers(
      input.entry,
      input.problem,
      input.solution,
      root,
      input.classified,
      input.solutions
    );
    await expect(run()).rejects.toThrow("seeded deterministic forced rows completed");
    expect(readdirSync(join(root, "solution-fidelity"))).toHaveLength(2);
    const repairs = readdirSync(join(root, "solution-repairs"));
    expect(repairs).toHaveLength(11);
    const q17Repair = repairs.find((name) => /^v2-0011-0017-/u.test(name))!;
    const repair = JSON.parse(readFileSync(join(root, "solution-repairs", q17Repair), "utf8"));
    expect(repair).not.toHaveProperty("promptVersion");
    expect(repair).not.toHaveProperty("promptDigest");
    expect(repair).not.toHaveProperty("model");
    expect(repair).not.toHaveProperty("reasoningEffort");
    expect(repair.authorityKind).toBe("source-literal-replacement");
    expect(canonicalEvidenceHash(repair.item)).toBe(
      SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0].items[0].expectedSolutionItemHash
    );
    const fidelities = readdirSync(join(root, "solution-fidelity-repairs"));
    expect(fidelities).toHaveLength(11);
    const q17Fidelity = JSON.parse(readFileSync(join(
      root,
      "solution-fidelity-repairs",
      fidelities.find((name) => /^v2-0011-0017-/u.test(name))!
    ), "utf8"));
    expect(q17Fidelity).toMatchObject({
      version: 2,
      authorityKind: "source-literal-fidelity",
      key: "7:17",
      item: {
        sourcePage: 11,
        answerStatus: "exact",
        explanationStatus: "exact",
        evidence: "SOURCE_LITERAL_REPLACEMENT_AUTHORITY",
      },
    });
    expect(q17Fidelity).not.toHaveProperty("promptDigest");
    expect(q17Fidelity).not.toHaveProperty("model");
    expect(q17Fidelity).not.toHaveProperty("reasoningEffort");
    const before = stateSnapshot(root);
    providerMock.complete.mockClear();
    await expect(run()).rejects.toThrow("seeded deterministic forced rows completed");
    expect(providerMock.complete).toHaveBeenCalledTimes(1);
    expect(stateSnapshot(root)).toEqual(before);
  }, 180_000);

  it.skipIf(!existsSync(join(q27LiveState, "solution.pdf")))(
    "preflights a later wrong forced partial repair before an earlier missing repair writes",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q17-q18-solution-cross-row-"));
    cpSync(q27LiveState, root, { recursive: true });
    removeSolutionRepairArtifacts(root);
    const input = q27FixtureInputs(root);
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_solution_fidelity") {
        const decisions = q5525982FidelityDecisions(request.prompt);
        return { text: JSON.stringify(decisions) };
      }
      if (request.schema?.name === "studywork_solution_file_items") {
        const number = Number(request.prompt.match(/printed solution (\d+)/u)?.[1]);
        const key = SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0].items
          .find((item) => Number(item.key.split(":")[1]) === number)?.key;
        if (!key) throw new Error("seeded Q40 boundary");
        return { text: JSON.stringify([q5525982CorrectedSolution(input.solutions, key)]) };
      }
      throw new Error(`unexpected AI call: ${request.schema?.name ?? "unknown"}`);
    });
    const run = () => repairAndAuditOfficialAnswers(
      input.entry,
      input.problem,
      input.solution,
      root,
      input.classified,
      input.solutions
    );
    await expect(run()).rejects.toThrow("seeded Q40 boundary");
    const repairsDirectory = join(root, "solution-repairs");
    const q17 = readdirSync(repairsDirectory).find((name) => /^v2-\d{4}-0017-/u.test(name))!;
    const q18 = readdirSync(repairsDirectory).find((name) => /^v2-\d{4}-0018-/u.test(name))!;
    rmSync(join(repairsDirectory, q17));
    const q17Fidelity = readdirSync(join(root, "solution-fidelity-repairs"))
      .find((name) => /^v2-\d{4}-0017-/u.test(name))!;
    rmSync(join(root, "solution-fidelity-repairs", q17Fidelity));
    const q18Path = join(repairsDirectory, q18);
    const q18Checkpoint = JSON.parse(readFileSync(q18Path, "utf8"));
    q18Checkpoint.item.explanation += " altered";
    writeCanonicalJson(q18Path, q18Checkpoint);
    providerMock.complete.mockClear();
    providerMock.complete.mockRejectedValue(new Error("AI must not run"));
    const before = stateSnapshot(root);
    await expect(run()).rejects.toThrow(
      /7:18 persisted forced false-negative 해설 repair item이 source candidate와 다릅니다/u
    );
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(before);
  }, 240_000);

  it.skipIf(!existsSync(join(q27LiveState, "solution.pdf")))(
    "resumes partial Q40 source authority and preflights Q40-Q45 corruption before writes",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q40-q45-source-negative-seed-"));
    cpSync(q27LiveState, root, { recursive: true });
    for (const directory of ["semantic-choice-checks", "answer-audit", "answer-attestation"]) {
      rmSync(join(root, directory), { recursive: true, force: true });
    }
    const seedInput = q27FixtureInputs(root);
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_solution_fidelity") {
        return { text: JSON.stringify(q5525982FidelityDecisions(request.prompt)) };
      }
      if (request.schema?.name === "studywork_exam_corpus_semantic_choice_check") {
        throw new Error("seeded source negative boundary");
      }
      throw new Error(`unexpected AI call: ${request.schema?.name ?? "unknown"}`);
    });
    await expect(repairAndAuditOfficialAnswers(
      seedInput.entry,
      seedInput.problem,
      seedInput.solution,
      root,
      seedInput.classified,
      seedInput.solutions
    )).rejects.toThrow("seeded source negative boundary");
    const sourceRevisionName = readdirSync(join(root, "solution-source-revisions"))[0];
    const sourceFidelityName = readdirSync(join(root, "solution-fidelity-source-revisions"))[0];
    const q41RepairName = readdirSync(join(root, "solution-repairs"))
      .find((name) => /^v2-0026-0041-/u.test(name))!;
    const q41FidelityName = readdirSync(join(root, "solution-fidelity-repairs"))
      .find((name) => /^v2-0026-0041-/u.test(name))!;
    const q45RepairName = readdirSync(join(root, "solution-repairs"))
      .find((name) => /^v2-0028-0045-/u.test(name))!;
    const q45FidelityName = readdirSync(join(root, "solution-fidelity-repairs"))
      .find((name) => /^v2-0028-0045-/u.test(name))!;
    const partialState = mkdtempSync(join(tmpdir(), "studywork-q40-source-partial-"));
    try {
      cpSync(root, partialState, { recursive: true });
      rmSync(join(partialState, "solution-fidelity-source-revisions", sourceFidelityName));
      providerMock.complete.mockReset();
      const partialInput = q27FixtureInputs(partialState);
      providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
        expect(request.schema?.name).toBe("studywork_exam_corpus_semantic_choice_check");
        const items = JSON.parse(request.prompt.split("Items:\n")[1]) as Array<{
          key: string;
          choices: string[];
        }>;
        return { text: JSON.stringify(items.map((item) => {
          const number = Number(item.key.split(":")[1]);
          const answer = partialInput.solutions.find((solution) => Number(solution.number) === number)!.answer.trim();
          const markerIndex = ["①", "②", "③", "④", "⑤"].indexOf(answer);
          const choiceIndex = markerIndex >= 0 ? markerIndex + 1 : item.choices.indexOf(answer) + 1;
          return { key: item.key, status: "resolved", choiceIndex, evidence: "seeded semantic evidence" };
        })) };
      });
      await repairAndAuditOfficialAnswers(
        partialInput.entry,
        partialInput.problem,
        partialInput.solution,
        partialState,
        partialInput.classified,
        partialInput.solutions
      );
      expect(providerMock.complete).toHaveBeenCalledTimes(1);
      expect(providerMock.complete.mock.calls[0][0].schema?.name)
        .toBe("studywork_exam_corpus_semantic_choice_check");
      expect(hash(readFileSync(join(
        partialState,
        "solution-fidelity-source-revisions",
        sourceFidelityName
      )))).toBe("09049a9f46f71a25919863a8d74871b96bf179f1387f291b63de710756210801");
      const completed = stateSnapshot(partialState);
      providerMock.complete.mockClear();
      await repairAndAuditOfficialAnswers(
        partialInput.entry,
        partialInput.problem,
        partialInput.solution,
        partialState,
        partialInput.classified,
        partialInput.solutions
      );
      expect(providerMock.complete).not.toHaveBeenCalled();
      expect(stateSnapshot(partialState)).toEqual(completed);
    } finally {
      rmSync(partialState, { recursive: true, force: true });
    }
    const legacyState = mkdtempSync(join(tmpdir(), "studywork-q40-source-legacy-"));
    try {
      cpSync(root, legacyState, { recursive: true });
      rmSync(join(legacyState, "solution-source-revisions"), { recursive: true });
      rmSync(join(legacyState, "solution-fidelity-source-revisions"), { recursive: true });
      rmSync(join(legacyState, "semantic-choice-checks"), { recursive: true, force: true });
      const repairPath = join(legacyState, SOLUTION_SOURCE_REVISION_ALLOWLIST[0].parentRepairArtifact.path);
      const repair = JSON.parse(readFileSync(repairPath, "utf8"));
      repair.item.explanation += " legacy exact candidate";
      writeCanonicalJson(repairPath, repair);
      const repairedItemHash = canonicalEvidenceHash(repair.item);
      expect(hash(readFileSync(repairPath))).not.toBe(
        SOLUTION_SOURCE_REVISION_ALLOWLIST[0].parentRepairArtifact.sha256
      );
      const pinnedFidelityPath = join(
        legacyState,
        SOLUTION_SOURCE_REVISION_ALLOWLIST[0].parentFidelityArtifact.path
      );
      const fidelity = JSON.parse(readFileSync(pinnedFidelityPath, "utf8"));
      fidelity.repairArtifact.sha256 = hash(readFileSync(repairPath));
      fidelity.effectiveSolutionItemHash = repairedItemHash;
      fidelity.input.explanation = repair.item.explanation;
      fidelity.inputHash = canonicalEvidenceHash(fidelity.input);
      const fidelityName = `v1-0025-0040-${fidelity.baseFidelityCheckpoint.sha256}-${repairedItemHash}.json`;
      rmSync(pinnedFidelityPath);
      writeCanonicalJson(join(legacyState, "solution-fidelity-repairs", fidelityName), fidelity);
      providerMock.complete.mockReset();
      providerMock.complete.mockRejectedValue(new Error("seeded nonmatching Q40 legacy boundary"));
      const legacyInput = q27FixtureInputs(legacyState);
      const runLegacy = () => repairAndAuditOfficialAnswers(
        legacyInput.entry,
        legacyInput.problem,
        legacyInput.solution,
        legacyState,
        legacyInput.classified,
        legacyInput.solutions
      );
      const before = stateSnapshot(legacyState);
      await expect(runLegacy()).rejects.toThrow("seeded nonmatching Q40 legacy boundary");
      expect(providerMock.complete).toHaveBeenCalledTimes(1);
      expect(providerMock.complete.mock.calls[0][0].schema?.name)
        .toBe("studywork_exam_corpus_semantic_choice_check");
      expect(existsSync(join(legacyState, "solution-source-revisions"))).toBe(false);
      expect(existsSync(join(legacyState, "solution-fidelity-source-revisions"))).toBe(false);
      expect(stateSnapshot(legacyState)).toEqual(before);
      providerMock.complete.mockClear();
      await expect(runLegacy()).rejects.toThrow("seeded nonmatching Q40 legacy boundary");
      expect(providerMock.complete).toHaveBeenCalledTimes(1);
      expect(stateSnapshot(legacyState)).toEqual(before);
    } finally {
      rmSync(legacyState, { recursive: true, force: true });
    }
    const cases: Array<{ label: string; mutate: (stateDir: string) => void; error: RegExp }> = [{
      label: "Q40 source revision extra field",
      mutate: (stateDir) => {
        const path = join(stateDir, "solution-source-revisions", sourceRevisionName);
        const checkpoint = JSON.parse(readFileSync(path, "utf8"));
        checkpoint.unexpected = true;
        writeCanonicalJson(path, checkpoint);
      },
      error: /solution source revision envelope/u,
    }, {
      label: "Q40 source revision wrong item",
      mutate: (stateDir) => {
        const path = join(stateDir, "solution-source-revisions", sourceRevisionName);
        const checkpoint = JSON.parse(readFileSync(path, "utf8"));
        checkpoint.item.explanation += " altered";
        writeCanonicalJson(path, checkpoint);
      },
      error: /solution source revision envelope/u,
    }, {
      label: "Q40 source fidelity wrong status",
      mutate: (stateDir) => {
        const path = join(stateDir, "solution-fidelity-source-revisions", sourceFidelityName);
        const checkpoint = JSON.parse(readFileSync(path, "utf8"));
        checkpoint.item.explanationStatus = "mismatch";
        writeCanonicalJson(path, checkpoint);
      },
      error: /solution source revision fidelity envelope/u,
    }, {
      label: "Q40 source revision third child",
      mutate: (stateDir) => writeFileSync(
        join(stateDir, "solution-source-revisions", sourceRevisionName.replace(
          /-[a-f0-9]{64}\.json$/u,
          `-${"f".repeat(64)}.json`
        )),
        readFileSync(join(stateDir, "solution-source-revisions", sourceRevisionName))
      ),
      error: /solution source revision child coverage/u,
    }, {
      label: "Q40 source fidelity orphan",
      mutate: (stateDir) => {
        const source = join(stateDir, "solution-fidelity-source-revisions", sourceFidelityName);
        const checkpoint = JSON.parse(readFileSync(source, "utf8"));
        checkpoint.revisionArtifact.path = "solution-source-revisions/missing.json";
        writeCanonicalJson(join(
          stateDir,
          "solution-fidelity-source-revisions",
          sourceFidelityName.replace(/-[a-f0-9]{64}-/u, `-${"e".repeat(64)}-`)
        ), checkpoint);
        rmSync(source);
      },
      error: /solution source revision fidelity envelope/u,
    }, {
      label: "Q40 source revision leaf symlink",
      mutate: (stateDir) => {
        const path = join(stateDir, "solution-source-revisions", sourceRevisionName);
        renameSync(path, `${path}.tmp`);
        symlinkSync(`${sourceRevisionName}.tmp`, path);
      },
      error: /malformed solution authority/u,
    }, {
      label: "Q40 source revision directory symlink",
      mutate: (stateDir) => {
        const source = join(stateDir, "solution-source-revisions");
        const target = join(stateDir, "solution-source-revisions-target");
        renameSync(source, target);
        symlinkSync("solution-source-revisions-target", source);
      },
      error: /디렉터리가 유효하지 않습니다/u,
    }, {
      label: "Q40 source fidelity directory symlink",
      mutate: (stateDir) => {
        const source = join(stateDir, "solution-fidelity-source-revisions");
        const target = join(stateDir, "solution-fidelity-source-revisions-target");
        renameSync(source, target);
        symlinkSync("solution-fidelity-source-revisions-target", source);
      },
      error: /디렉터리가 유효하지 않습니다/u,
    }, {
      label: "Q41 legacy v1 repair",
      mutate: (stateDir) => {
        const repair = JSON.parse(readFileSync(join(stateDir, "solution-repairs", q41RepairName), "utf8"));
        const name = `v1-0026-0041-${repair.baseFidelityCheckpoint.sha256}.json`;
        writeCanonicalJson(join(stateDir, "solution-repairs", name), { ...repair, version: 1 });
      },
      error: /solution repair v1\/v2 parent coverage/u,
    }, {
      label: "Q45 legacy v1 fidelity",
      mutate: (stateDir) => {
        const fidelity = JSON.parse(readFileSync(
          join(stateDir, "solution-fidelity-repairs", q45FidelityName),
          "utf8"
        ));
        const name = `v1-0028-0045-${fidelity.baseFidelityCheckpoint.sha256}-${fidelity.effectiveSolutionItemHash}.json`;
        writeCanonicalJson(join(stateDir, "solution-fidelity-repairs", name), { ...fidelity, version: 1 });
      },
      error: /repair fidelity child가 중복/u,
    }, {
      label: "Q40 exact repair parent only",
      mutate: (stateDir) => {
        rmSync(join(stateDir, "solution-source-revisions"), { recursive: true });
        rmSync(join(stateDir, "solution-fidelity-source-revisions"), { recursive: true });
        rmSync(join(stateDir, SOLUTION_SOURCE_REVISION_ALLOWLIST[0].parentFidelityArtifact.path));
      },
      error: /15:40 solution source revision parent coverage/u,
    }, {
      label: "Q40 exact fidelity parent only",
      mutate: (stateDir) => {
        rmSync(join(stateDir, "solution-source-revisions"), { recursive: true });
        rmSync(join(stateDir, "solution-fidelity-source-revisions"), { recursive: true });
        rmSync(join(stateDir, SOLUTION_SOURCE_REVISION_ALLOWLIST[0].parentRepairArtifact.path));
      },
      error: /15:40 solution source revision parent coverage/u,
    }, {
      label: "Q40 parent repair symlink",
      mutate: (stateDir) => {
        const path = join(stateDir, SOLUTION_SOURCE_REVISION_ALLOWLIST[0].parentRepairArtifact.path);
        renameSync(path, `${path}.tmp`);
        symlinkSync(`${path.split("/").at(-1)}.tmp`, path);
      },
      error: /solution source revision parent repair이 regular file이 아닙니다/u,
    }, {
      label: "Q40 parent repair directory",
      mutate: (stateDir) => {
        const path = join(stateDir, SOLUTION_SOURCE_REVISION_ALLOWLIST[0].parentRepairArtifact.path);
        renameSync(path, `${path}.tmp`);
        mkdirSync(path);
      },
      error: /solution source revision parent repair이 regular file이 아닙니다/u,
    }, {
      label: "Q40 parent fidelity symlink",
      mutate: (stateDir) => {
        const path = join(stateDir, SOLUTION_SOURCE_REVISION_ALLOWLIST[0].parentFidelityArtifact.path);
        renameSync(path, `${path}.tmp`);
        symlinkSync(`${path.split("/").at(-1)}.tmp`, path);
      },
      error: /solution source revision parent fidelity이 regular file이 아닙니다/u,
    }, {
      label: "Q41 missing before Q45 self-consistent tamper",
      mutate: (stateDir) => {
        rmSync(join(stateDir, "solution-repairs", q41RepairName));
        rmSync(join(stateDir, "solution-fidelity-repairs", q41FidelityName));
        const path = join(stateDir, "solution-repairs", q45RepairName);
        const checkpoint = JSON.parse(readFileSync(path, "utf8"));
        checkpoint.item.explanation += " altered";
        writeCanonicalJson(path, checkpoint);
      },
      error: /16:45 persisted forced false-negative 해설 repair item이 source candidate와 다릅니다/u,
    }];
    for (const testCase of cases) {
      const stateDir = mkdtempSync(join(tmpdir(), "studywork-q40-q45-source-negative-"));
      try {
        cpSync(root, stateDir, { recursive: true });
        rmSync(join(stateDir, "semantic-choice-checks"), { recursive: true, force: true });
        rmSync(join(stateDir, "answer-audit"), { recursive: true, force: true });
        testCase.mutate(stateDir);
        const before = stateSnapshot(stateDir);
        providerMock.complete.mockReset();
        providerMock.complete.mockRejectedValue(new Error("AI must not run"));
        const input = q27FixtureInputs(stateDir);
        await expect(repairAndAuditOfficialAnswers(
          input.entry,
          input.problem,
          input.solution,
          stateDir,
          input.classified,
          input.solutions
        ), testCase.label).rejects.toThrow(testCase.error);
        expect(providerMock.complete, testCase.label).not.toHaveBeenCalled();
        expect(stateSnapshot(stateDir), testCase.label).toEqual(before);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    }
  }, 360_000);

  it.skipIf(!existsSync(join(q27LiveState, "solution.pdf")))(
    "rejects v2 repair XOR, envelope, pointer, and symlink corruption before AI or writes",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q17-q18-solution-v2-negatives-"));
    cpSync(q27LiveState, root, { recursive: true });
    removeSolutionRepairArtifacts(root);
    const input = q27FixtureInputs(root);
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_solution_fidelity") {
        const decisions = q5525982FidelityDecisions(request.prompt);
        return { text: JSON.stringify(decisions) };
      }
      if (request.schema?.name === "studywork_solution_file_items") {
        throw new Error("seeded Q40 v2 boundary");
      }
      throw new Error(`unexpected AI call: ${request.schema?.name ?? "unknown"}`);
    });
    await expect(repairAndAuditOfficialAnswers(
      input.entry,
      input.problem,
      input.solution,
      root,
      input.classified,
      input.solutions
    )).rejects.toThrow("seeded Q40 v2 boundary");
    const baseline = stateSnapshot(root);
    const q17 = readdirSync(join(root, "solution-repairs"))
      .find((name) => /^v2-\d{4}-0017-/u.test(name))!;
    const q18 = readdirSync(join(root, "solution-repairs"))
      .find((name) => /^v2-\d{4}-0018-/u.test(name))!;
    const q18Fidelity = readdirSync(join(root, "solution-fidelity-repairs"))
      .find((name) => /^v2-\d{4}-0018-/u.test(name))!;

    const cases: Array<{ label: string; mutate: (stateDir: string) => void; error: RegExp }> = [{
      label: "same-parent fidelity v1 and v2",
      mutate: (stateDir) => {
        const v2 = JSON.parse(readFileSync(join(stateDir, "solution-fidelity-repairs", q18Fidelity), "utf8"));
        const v1Name = `v1-${String(v2.basePage).padStart(4, "0")}-${v2.printedNumber.padStart(4, "0")}-` +
          `${v2.baseFidelityCheckpoint.sha256}-${v2.effectiveSolutionItemHash}.json`;
        writeFileSync(
          join(stateDir, "solution-fidelity-repairs", v1Name),
          readFileSync(join(stateDir, "solution-fidelity-repairs", q18Fidelity))
        );
      },
      error: /repair fidelity child가 중복/u,
    }, {
      label: "v2 fidelity extra field",
      mutate: (stateDir) => {
        const path = join(stateDir, "solution-fidelity-repairs", q18Fidelity);
        const checkpoint = JSON.parse(readFileSync(path, "utf8"));
        checkpoint.unexpected = true;
        writeCanonicalJson(path, checkpoint);
      },
      error: /persisted repair fidelity envelope/u,
    }, {
      label: "v2 fidelity reason tamper",
      mutate: (stateDir) => {
        const path = join(stateDir, "solution-fidelity-repairs", q18Fidelity);
        const checkpoint = JSON.parse(readFileSync(path, "utf8"));
        checkpoint.item.evidence = "altered";
        writeCanonicalJson(path, checkpoint);
      },
      error: /persisted repair fidelity envelope/u,
    }, {
      label: "v2 fidelity dynamic parent path tamper",
      mutate: (stateDir) => {
        const source = join(stateDir, "solution-fidelity-repairs", q18Fidelity);
        const target = q18Fidelity.replace(/-[a-f0-9]{64}-([a-f0-9]{64}\.json)$/u, `-${"0".repeat(64)}-$1`);
        renameSync(source, join(stateDir, "solution-fidelity-repairs", target));
      },
      error: /persisted repair fidelity envelope/u,
    }, {
      label: "v2 fidelity leaf symlink",
      mutate: (stateDir) => {
        const path = join(stateDir, "solution-fidelity-repairs", q18Fidelity);
        renameSync(path, `${path}.tmp`);
        symlinkSync(`${q18Fidelity}.tmp`, path);
      },
      error: /malformed solution authority/u,
    }, {
      label: "v2 fidelity orphan",
      mutate: (stateDir) => {
        const checkpoint = JSON.parse(readFileSync(
          join(stateDir, "solution-fidelity-repairs", q18Fidelity),
          "utf8"
        ));
        checkpoint.repairArtifact.path = "solution-repairs/missing.json";
        const orphanName = q18Fidelity.replace(
          /^(v2-\d{4}-0018-)[a-f0-9]{64}(-[a-f0-9]{64}\.json)$/u,
          `$1${"f".repeat(64)}$2`
        );
        expect(orphanName).not.toBe(q18Fidelity);
        writeCanonicalJson(join(
          stateDir,
          "solution-fidelity-repairs",
          orphanName
        ), checkpoint);
      },
      error: /orphan solution repair fidelity artifact/u,
    }, {
      label: "v2 fidelity directory symlink",
      mutate: (stateDir) => {
        const source = join(stateDir, "solution-fidelity-repairs");
        const target = join(stateDir, "solution-fidelity-repairs-target");
        renameSync(source, target);
        symlinkSync("solution-fidelity-repairs-target", source);
      },
      error: /디렉터리가 유효하지 않습니다/u,
    }];
    for (const testCase of cases) {
      const stateDir = mkdtempSync(join(tmpdir(), "studywork-solution-v2-negative-"));
      try {
        cpSync(root, stateDir, { recursive: true });
        rmSync(join(stateDir, "solution-repairs", q17));
        const q17Fidelity = readdirSync(join(stateDir, "solution-fidelity-repairs"))
          .find((name) => /^v2-\d{4}-0017-/u.test(name))!;
        rmSync(join(stateDir, "solution-fidelity-repairs", q17Fidelity));
        testCase.mutate(stateDir);
        const before = stateSnapshot(stateDir);
        providerMock.complete.mockReset();
        providerMock.complete.mockRejectedValue(new Error("AI must not run"));
        const current = q27FixtureInputs(stateDir);
        await expect(repairAndAuditOfficialAnswers(
          current.entry,
          current.problem,
          current.solution,
          stateDir,
          current.classified,
          current.solutions
        ), testCase.label).rejects.toThrow(testCase.error);
        expect(providerMock.complete, testCase.label).not.toHaveBeenCalled();
        expect(stateSnapshot(stateDir), testCase.label).toEqual(before);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    }
    expect(stateSnapshot(root)).toEqual(baseline);
  }, 300_000);

  it.skipIf(!existsSync(join(q27LiveState, "solution.pdf")))(
    "resumes the live mixed Q17 v1 and Q18 parent-only state with deterministic v2 fidelity",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q17-q18-solution-fidelity-mixed-"));
    cpSync(q27LiveState, root, { recursive: true });
    const q18FidelityChildren = readdirSync(join(root, "solution-fidelity-repairs"))
      .filter((name) => /^v2-\d{4}-0018-[a-f0-9]{64}-[a-f0-9]{64}\.json$/u.test(name));
    expect(q18FidelityChildren).toHaveLength(1);
    rmSync(join(root, "solution-fidelity-repairs", q18FidelityChildren[0]));
    for (const directory of ["semantic-choice-checks", "answer-audit", "answer-attestation"]) {
      rmSync(join(root, directory), { recursive: true, force: true });
    }
    const input = q27FixtureInputs(root);
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_solution_fidelity") {
        const decisions = q5525982FidelityDecisions(request.prompt);
        if (decisions.length === 1) throw new Error(`forced fidelity AI must not run: ${decisions[0].key}`);
        return { text: JSON.stringify(decisions) };
      }
      if (request.schema?.name === "studywork_solution_file_items") {
        throw new Error("seeded live mixed Q40 boundary");
      }
      if (request.schema?.name === "studywork_exam_corpus_semantic_choice_check") {
        const items = JSON.parse(request.prompt.split("Items:\n")[1]) as Array<{
          key: string;
          choices: string[];
        }>;
        return { text: JSON.stringify(items.map((item) => {
          const number = Number(item.key.split(":")[1]);
          const answer = input.solutions.find((solution) => Number(solution.number) === number)!.answer.trim();
          const markerIndex = ["①", "②", "③", "④", "⑤"].indexOf(answer);
          const choiceIndex = markerIndex >= 0 ? markerIndex + 1 : item.choices.indexOf(answer) + 1;
          expect(choiceIndex, item.key).toBeGreaterThan(0);
          return { key: item.key, status: "resolved", choiceIndex, evidence: "seeded semantic evidence" };
        })) };
      }
      throw new Error(`unexpected AI call: ${request.schema?.name ?? "unknown"}`);
    });
    const run = () => repairAndAuditOfficialAnswers(
      input.entry,
      input.problem,
      input.solution,
      root,
      input.classified,
      input.solutions
    );
    const q17Repair = readFileSync(join(
      root,
      "solution-repairs",
      readdirSync(join(root, "solution-repairs")).find((name) => /^v2-0011-0017-/u.test(name))!
    ));
    const q17FidelityName = readdirSync(join(root, "solution-fidelity-repairs"))
      .find((name) => /^v1-0011-0017-/u.test(name))!;
    const q17Fidelity = readFileSync(join(root, "solution-fidelity-repairs", q17FidelityName));
    const completedAudit = await run();
    expect(completedAudit.auditPath).toMatch(/^answer-audit\/v\d+-[a-f0-9]{64}\.json$/u);
    expect(providerMock.complete).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(
      root,
      "solution-repairs",
      readdirSync(join(root, "solution-repairs")).find((name) => /^v2-0011-0017-/u.test(name))!
    ))).toEqual(q17Repair);
    expect(readFileSync(join(root, "solution-fidelity-repairs", q17FidelityName))).toEqual(q17Fidelity);
    const fidelityFiles = readdirSync(join(root, "solution-fidelity-repairs")).sort();
    expect(fidelityFiles.filter((name) => name.startsWith("v1-"))).toEqual([
      q17FidelityName,
      SOLUTION_SOURCE_REVISION_ALLOWLIST[0].parentFidelityArtifact.path.split("/").at(-1),
    ].sort());
    expect(fidelityFiles.filter((name) => name.startsWith("v2-"))).toHaveLength(15);
    const q18Fidelity = JSON.parse(readFileSync(join(
      root,
      "solution-fidelity-repairs",
      fidelityFiles.find((name) => /^v2-0011-0018-/u.test(name))!
    ), "utf8"));
    expect(q18Fidelity).toMatchObject({
      version: 2,
      authorityKind: "source-literal-fidelity",
      key: "7:18",
      item: {
        answerStatus: "exact",
        explanationStatus: "exact",
        evidence: "SOURCE_LITERAL_REPLACEMENT_AUTHORITY",
      },
    });
    expect(q18Fidelity).not.toHaveProperty("promptDigest");
    expect(solutionRepairFidelityEvidence(
      `solution-fidelity-repairs/${q17FidelityName}`,
      hash(q17Fidelity),
      false
    )).toEqual({
      path: `solution-fidelity-repairs/${q17FidelityName}`,
      sha256: hash(q17Fidelity),
      promptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const q18FidelityName = fidelityFiles.find((name) => /^v2-0011-0018-/u.test(name))!;
    const q18FidelityBytes = readFileSync(join(root, "solution-fidelity-repairs", q18FidelityName));
    expect(solutionRepairFidelityEvidence(
      `solution-fidelity-repairs/${q18FidelityName}`,
      hash(q18FidelityBytes),
      true
    )).toEqual({
      path: `solution-fidelity-repairs/${q18FidelityName}`,
      sha256: hash(q18FidelityBytes),
      authorityKind: "source-literal-fidelity",
    });
    const sourceRevisions = readdirSync(join(root, "solution-source-revisions"));
    const sourceFidelities = readdirSync(join(root, "solution-fidelity-source-revisions"));
    expect(sourceRevisions).toEqual([
      "v1-0025-0040-09962f7d4b7ca05fcaec236021792af644c1a3565d8a7c8abecd38e3d4e31c62-" +
        "afaf8a15ee23d5f6bf0d6a3a6ad7c7679a2d15813a23ddfb07f3ca51b43afd7e.json",
    ]);
    expect(sourceFidelities).toEqual([
      "v1-0025-0040-5edaf315941096a05c7f77e6e3d2d5af74c01c5602cea3fbaf81b04bee2780f7-" +
        "afaf8a15ee23d5f6bf0d6a3a6ad7c7679a2d15813a23ddfb07f3ca51b43afd7e.json",
    ]);
    const q40Revision = JSON.parse(readFileSync(join(root, "solution-source-revisions", sourceRevisions[0]), "utf8"));
    const q40Fidelity = JSON.parse(readFileSync(
      join(root, "solution-fidelity-source-revisions", sourceFidelities[0]),
      "utf8"
    ));
    expect(hash(readFileSync(join(root, "solution-source-revisions", sourceRevisions[0]))))
      .toBe("5edaf315941096a05c7f77e6e3d2d5af74c01c5602cea3fbaf81b04bee2780f7");
    expect(hash(readFileSync(join(root, "solution-fidelity-source-revisions", sourceFidelities[0]))))
      .toBe("09049a9f46f71a25919863a8d74871b96bf179f1387f291b63de710756210801");
    expect(canonicalEvidenceHash(q40Revision.item)).toBe(SOLUTION_SOURCE_REVISION_ALLOWLIST[0].expectedSolutionItemHash);
    expect(q40Fidelity).toMatchObject({
      authorityKind: "source-literal-revision-fidelity",
      inputHash: "6d67669ba73d4c8b0d0be02abdb1f378cc714a753c1eebe5acb1a9b2096d18c8",
      item: { answerStatus: "exact", explanationStatus: "exact", evidence: "SOURCE_LITERAL_REVISION_AUTHORITY" },
    });
    for (const spec of SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0].items.slice(11)) {
      const number = Number(spec.key.split(":")[1]);
      const repairName = readdirSync(join(root, "solution-repairs"))
        .find((name) => name.startsWith("v2-") && name.includes(`-${String(number).padStart(4, "0")}-`))!;
      const repair = JSON.parse(readFileSync(join(root, "solution-repairs", repairName), "utf8"));
      expect(canonicalEvidenceHash(repair.item), spec.key).toBe(spec.expectedSolutionItemHash);
    }
    expect(existsSync(join(root, "solution-revisions"))).toBe(false);
    expect(existsSync(join(root, "answer-audit"))).toBe(true);
    expect(existsSync(join(root, "answer-attestation"))).toBe(false);
    const completed = stateSnapshot(root);
    providerMock.complete.mockReset();
    providerMock.complete.mockRejectedValue(new Error("AI must not run"));
    await expect(auditAcceptedSolutions(
      input.entry,
      input.problem,
      input.solution,
      root,
      completedAudit.classified,
      input.solutions,
      new Map([["15:40", {
        kind: "semantic" as const,
        semanticCheckpoint: {
          path: "semantic-choice-checks/missing.json",
          sha256: "0".repeat(64),
          inputHash: "0".repeat(64),
          effectiveCorpusHash: "0".repeat(64),
          effectiveSolutionCorpusHash: "0".repeat(64),
        },
        semanticDecision: {
          key: "15:40",
          status: "ambiguous" as const,
          choiceIndex: null,
          evidence: "seeded forbidden source revision trigger",
        },
      }]])
    )).rejects.toThrow(/15:40 solution source revision 뒤에는 추가 revision이 허용되지 않습니다/u);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(existsSync(join(root, "solution-revisions"))).toBe(false);
    expect(stateSnapshot(root)).toEqual(completed);
    providerMock.complete.mockClear();
    const replayed = await run();
    expect(replayed.auditHash).toBe(completedAudit.auditHash);
    expect(providerMock.complete).not.toHaveBeenCalled();
    expect(stateSnapshot(root)).toEqual(completed);
    const receipt = JSON.parse(readFileSync(join(root, "receipt.json"), "utf8"));
    const attestation = await writeAnswerAttestation(
      root,
      input.entry.id,
      input.problem.sha256,
      input.solution.sha256,
      receipt,
      completedAudit
    );
    expect(attestation.path).toMatch(/^answer-attestation\/v\d+-[a-f0-9]{64}\.json$/u);
    expect(hash(readFileSync(join(root, attestation.path)))).toBe(attestation.sha256);
    rmSync(join(root, "answer-attestation"), { recursive: true, force: true });
    const revisionPath = join(root, "solution-source-revisions", sourceRevisions[0]);
    const revisionBytes = readFileSync(revisionPath);
    const tampered = JSON.parse(revisionBytes.toString("utf8"));
    tampered.unexpected = true;
    writeCanonicalJson(revisionPath, tampered);
    await expect(writeAnswerAttestation(
      root,
      input.entry.id,
      input.problem.sha256,
      input.solution.sha256,
      receipt,
      completedAudit
    )).rejects.toThrow(/solution source revision child hash/u);
    writeFileSync(revisionPath, revisionBytes);
  }, 240_000);

  it.skipIf(!existsSync(join(q27LiveState, "solution.pdf")))(
    "preflights both pinned solution fidelity checkpoints and strict inventory before AI or writes",
    async () => {
    root = mkdtempSync(join(tmpdir(), "studywork-q17-q34-solution-seed-"));
    cpSync(q27LiveState, root, { recursive: true });
    removeSolutionRepairArtifacts(root);
    rmSync(join(root, "solution-fidelity"), { recursive: true, force: true });
    providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
      if (request.schema?.name === "studywork_exam_corpus_solution_fidelity") {
        return { text: JSON.stringify(q5525982FidelityDecisions(request.prompt)) };
      }
      if (request.schema?.name === "studywork_solution_file_items") {
        throw new Error("seeded after exact forced solution repairs");
      }
      throw new Error(`unexpected AI call: ${request.schema?.name ?? "unknown"}`);
    });
    const seededInput = q27FixtureInputs(root);
    await expect(repairAndAuditOfficialAnswers(
      seededInput.entry,
      seededInput.problem,
      seededInput.solution,
      root,
      seededInput.classified,
      seededInput.solutions
    )).rejects.toThrow("seeded after exact forced solution repairs");
    const frozen = SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0].checkpoints.map((checkpoint) => ({
      ...checkpoint,
      bytes: readFileSync(join(root, checkpoint.path)),
    }));
    expect(frozen.every((checkpoint) =>
      hash(checkpoint.bytes) === canonicalEvidenceHash(JSON.parse(checkpoint.bytes.toString("utf8")))
    )).toBe(true);

    const cases: Array<{
      label: string;
      mutate: (stateDir: string) => void;
      error: RegExp;
    }> = [{
      label: "official solution source byte tamper",
      mutate: (stateDir) => writeFileSync(
        join(stateDir, "solution.pdf"),
        Buffer.concat([readFileSync(join(stateDir, "solution.pdf")), Buffer.from("tampered")])
      ),
      error: /official source bytes hash/u,
    }, {
      label: "missing earlier with later self-consistent semantic tamper",
      mutate: (stateDir) => {
        mkdirSync(join(stateDir, "solution-fidelity"), { recursive: true });
        const checkpoint = JSON.parse(frozen[1].bytes.toString("utf8"));
        checkpoint.items[0].sourcePage += 1;
        writeCanonicalJson(join(stateDir, frozen[1].path), checkpoint);
      },
      error: /semantic projection/u,
    }, {
      label: "missing earlier with later self-consistent extra field",
      mutate: (stateDir) => {
        mkdirSync(join(stateDir, "solution-fidelity"), { recursive: true });
        const checkpoint = JSON.parse(frozen[1].bytes.toString("utf8"));
        checkpoint.unexpected = true;
        writeCanonicalJson(join(stateDir, frozen[1].path), checkpoint);
      },
      error: /체크포인트 envelope/u,
    }, {
      label: "missing earlier with later byte tamper",
      mutate: (stateDir) => {
        mkdirSync(join(stateDir, "solution-fidelity"), { recursive: true });
        writeFileSync(join(stateDir, frozen[1].path), Buffer.concat([frozen[1].bytes, Buffer.from(" ")]));
      },
      error: /해설 fidelity hash/u,
    }, {
      label: "existing checkpoint leaf symlink",
      mutate: (stateDir) => {
        mkdirSync(join(stateDir, "solution-fidelity"), { recursive: true });
        writeFileSync(join(stateDir, "solution-fidelity", "target.tmp"), frozen[1].bytes);
        symlinkSync("target.tmp", join(stateDir, frozen[1].path));
      },
      error: /파일이 유효하지 않습니다|regular file|symbolic link/u,
    }, {
      label: "third current-generation checkpoint",
      mutate: (stateDir) => {
        mkdirSync(join(stateDir, "solution-fidelity"), { recursive: true });
        for (const checkpoint of frozen) writeFileSync(join(stateDir, checkpoint.path), checkpoint.bytes);
        writeFileSync(join(
          stateDir,
          "solution-fidelity/v1-0002-" +
            `${SOLUTION_FALSE_NEGATIVE_REPAIR_ALLOWLIST[0].effectiveProblemCorpusHash}-${"0".repeat(64)}.json`
        ), frozen[1].bytes);
      },
      error: /current generation에 extra/u,
    }, {
      label: "junk checkpoint name",
      mutate: (stateDir) => {
        mkdirSync(join(stateDir, "solution-fidelity"), { recursive: true });
        writeFileSync(join(stateDir, "solution-fidelity", "junk.json"), "{}\n");
      },
      error: /filename/u,
    }, {
      label: "dangling checkpoint directory symlink",
      mutate: (stateDir) => symlinkSync("missing-fidelity-target", join(stateDir, "solution-fidelity")),
      error: /디렉터리가 유효하지 않습니다/u,
    }, {
      label: "valid-target checkpoint directory symlink",
      mutate: (stateDir) => {
        mkdirSync(join(stateDir, "solution-fidelity-target"));
        symlinkSync("solution-fidelity-target", join(stateDir, "solution-fidelity"));
      },
      error: /디렉터리가 유효하지 않습니다/u,
    }];

    for (const testCase of cases) {
      const stateDir = mkdtempSync(join(tmpdir(), "studywork-q17-q34-solution-preflight-"));
      try {
        cpSync(q27LiveState, stateDir, { recursive: true });
        removeSolutionRepairArtifacts(stateDir);
        rmSync(join(stateDir, "solution-fidelity"), { recursive: true, force: true });
        testCase.mutate(stateDir);
        const before = stateSnapshot(stateDir);
        providerMock.complete.mockReset();
        providerMock.complete.mockRejectedValue(new Error("AI must not run"));
        const input = q27FixtureInputs(stateDir);
        await expect(testCase.label === "official solution source byte tamper"
          ? auditAcceptedSolutions(
              input.entry,
              input.problem,
              input.solution,
              stateDir,
              input.classified,
              input.solutions
            )
          : repairAndAuditOfficialAnswers(
              input.entry,
              input.problem,
              input.solution,
              stateDir,
              input.classified,
              input.solutions
            ), testCase.label).rejects.toThrow(testCase.error);
        expect(providerMock.complete, testCase.label).not.toHaveBeenCalled();
        expect(stateSnapshot(stateDir), testCase.label).toEqual(before);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    }
  }, 360_000);

});
