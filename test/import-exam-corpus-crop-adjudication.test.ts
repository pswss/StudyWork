import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
  CLASSIFICATION_CROP_ADJUDICATION_VERSION,
  PROBLEM_CROP_ADJUDICATION_ALLOWLIST,
  PROBLEM_CROP_ADJUDICATION_CLASSIFICATION_PROMPT_DIGEST,
  PROBLEM_CROP_ADJUDICATION_VERSION,
  TARGETED_PROBLEM_CROP_ADJUDICATION_PROMPT_DIGEST,
  TRANSCRIPTION_GATE_VERSION,
  TRANSCRIPTION_PROMPT_DIGEST,
  canonicalEvidenceHash,
  parseCorpusManifest,
  repairAndAuditOfficialAnswers,
  type ClassificationDecision,
  type CorpusManifestEntry,
  type PdfEvidence,
} from "../scripts/import-exam-corpus";

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

type AllowlistedCase = {
  entryId: "ebsi:5578421" | "ebsi:5594499";
  key: "11:29" | "13:34";
  page: 11 | 13;
  number: 29 | 34;
  answerIndex: 0 | 1;
};

const OFFICIAL_PROBLEM_PATHS = {
  "ebsi:5578421": join(process.cwd(), "data/import-exam-corpus/f914a5cf8d2237d6c9319e23/problem.pdf"),
  "ebsi:5594499": join(process.cwd(), "data/import-exam-corpus/4142baa37330a6d3d470294a/problem.pdf"),
} as const;

const SOURCE_GROUNDED_OUTPUTS = {
  "ebsi:5578421": {
    question: `[29~34] 다음 글을 읽고 물음에 답하시오.
CROP_FINAL
ⓐ 전통 논리학은 전제에만 있는 중명사를 통해 (1)과 (2)의 ㉠ 정언 삼단 논증을 분석한다.
(3)의 한계를 다루기 위해 ⓑ 명제 논리학은 (4)처럼 명제를 단위로 삼으며, ‘p’와 ‘q’는 논리적 연결사로 결합된다.
<전제2>가 <전제1>의 선행 조건을 긍정하는 형식을 ㉡ 전건 긍정이라 한다.
㉢ 명제 논리학은 이후 술어 논리학으로 발전하였다.
* 명사(名辭): 하나의 개념을 언어로 나타내며 명제를 구성하는 데에 요소가 되는 말.
윗글에 대한 설명으로 가장 적절한 것은?`,
    choices: [
      "① 논리학의 발전 과정을 개괄적으로 소개하고 있다.",
      "② 논리학의 의의를 다양한 관점에서 고찰하고 있다.",
      "③ 논리학의 특징을 인접 학문과 비교하여 분석하고 있다.",
      "④ 논리학의 논증 방식이 단순화된 배경을 설명하고 있다.",
      "⑤ 논리학의 변화에 영향을 준 여러 학문을 고찰하고 있다.",
    ],
  },
  "ebsi:5594499": {
    question: `[34~37] 다음 글을 읽고 물음에 답하시오.
CROP_FINAL
(가) 갑월이 윤씨 부인에게 최치수가 왔다고 알린다. [A] 치수는 혼사를 말하고 ㉮의 대화가 이어진다.
월선네가 춤을 추고 [B]의 기억 속에서 치수는 어머니와 멀어진다. 김 서방도 등장한다.
― 박경리, 「토지」 ―
(나) S#58. 안방(낮)
ⓐ 차렵이불, ⓑ 마님, ⓒ 윤씨 부인, ⓓ 치수의 대사, ⓔ 어머님이 원작 장면을 촬영 대본으로 옮긴다.
두 인물의 시선에서 O.L* 기법이 이어지고 S#59와 S#60 장면으로 전환된다.
* O.L: 하나의 화면이 끝나기 전에 다음 화면이 겹치면서 먼저 화면이 차차 사라지게 하는 기법.
― 박경리 원작, 이형우 각색, 「토지」 ―
(가)의 서술상의 특징에 대한 설명으로 가장 적절한 것은?`,
    choices: [
      "① 풍자적 서술을 통해 인물의 부정적 행위를 비판하고 있다.",
      "② 작품 밖 서술자를 통해 인물의 내면 심리를 제시하고 있다.",
      "③ 시대적 배경을 제시하여 사회 현실의 문제를 드러내고 있다.",
      "④ 의식의 흐름 기법을 활용하여 인물의 내적 욕망을 드러내고 있다.",
      "⑤ 인물의 과장된 행동을 통해 비극적 분위기의 반전을 꾀하고 있다.",
    ],
  },
} as const;

async function runCase(testCase: AllowlistedCase) {
  root = mkdtempSync(join(tmpdir(), "studywork-crop-adjudication-"));
  const solutionDocument = await PDFDocument.create();
  solutionDocument.addPage([100, 100]);
  const problemBytes = readFileSync(OFFICIAL_PROBLEM_PATHS[testCase.entryId]);
  const solutionBytes = await solutionDocument.save();
  const problemPath = join(root, "problem.pdf");
  const solutionPath = join(root, "solution.pdf");
  writeFileSync(problemPath, problemBytes);
  writeFileSync(solutionPath, solutionBytes);

  const spec = PROBLEM_CROP_ADJUDICATION_ALLOWLIST.find((item) => item.entryId === testCase.entryId)!;
  const grounded = SOURCE_GROUNDED_OUTPUTS[testCase.entryId];
  const rawTitle = testCase.entryId === "ebsi:5578421" ? "고2 3월 학평(서울) 국어" : "고3 4월 학평(경기) 국어";
  const entry: CorpusManifestEntry = parseCorpusManifest({
    schemaVersion: 2,
    entries: [{
      id: testCase.entryId,
      subject: "국어",
      examTitle: rawTitle.replace(/ 국어$/u, ""),
      rawTitle,
      sourceRecordDate: testCase.entryId === "ebsi:5578421" ? "2017-03-09" : "2017-04-12",
      sourceRecordYear: 2017,
      variant: null,
      form: null,
      sourcePageUrl: `https://www.ebsi.co.kr/exam/${testCase.entryId.slice(5)}`,
      problemPdfUrl: `https://wdown.ebsi.co.kr/${testCase.entryId.slice(5)}-problem.pdf`,
      solutionPdfUrl: `https://wdown.ebsi.co.kr/${testCase.entryId.slice(5)}-solution.pdf`,
      grade: testCase.entryId === "ebsi:5578421" ? 2 : 3,
      paperId: testCase.entryId.slice(5),
    }],
  }).entries[0];
  const problem: PdfEvidence = {
    path: problemPath, sha256: hash(problemBytes), bytes: problemBytes.length, pageCount: 16,
    requestedUrl: entry.problemPdfUrl, resolvedUrl: entry.problemPdfUrl,
  };
  const solution: PdfEvidence = {
    path: solutionPath, sha256: hash(solutionBytes), bytes: solutionBytes.length, pageCount: 1,
    requestedUrl: entry.solutionPdfUrl, resolvedUrl: entry.solutionPdfUrl,
  };
  const choices = [...grounded.choices];
  const questions: QuizItemEx[] = Array.from({ length: 45 }, (_, index) => {
    const number = index + 1;
    const target = number === testCase.number;
    return {
      number: String(number),
      qtype: target ? "mcq" : "short",
      difficulty: "중",
      question: target ? "축약된 공통 지문과 대상 문제" : `${number}번 범위 밖 문제`,
      choices: target ? choices : null,
      answer: target ? choices[testCase.answerIndex] : String(number),
      explanation: "",
      page: target ? testCase.page : Math.min(16, Math.ceil(number / 3)),
      figure: false,
      figure_description: null,
      box: null,
    };
  });
  const decision = (question: QuizItemEx, status: "exact" | "mismatch"): ClassificationDecision => {
    const target = Number(question.number) === testCase.number;
    return {
      key: `${question.page}:${question.number}`,
      decision: target ? "accept" : "reject",
      canonical_subject: target ? (testCase.number === 29 ? "korean_reading" : "korean_literature") : null,
      curriculum_course: target ? (testCase.number === 29 ? "독서와 작문" : "문학") : null,
      domain: target ? (testCase.number === 29 ? "정보적 글의 구조" : "소설의 서술 방식") : null,
      achievement_codes: target ? [testCase.number === 29 ? "12독작01-03" : "12문학01-02"] : [],
      confidence: 0.99,
      reason_codes: [target ? "IN_SCOPE" : "OUT_OF_SCOPE"],
      transcription_status: status,
      transcription_evidence: status === "exact" ? "모든 source anchor가 원본 픽셀과 일치한다." :
        "공통 지문과 source marker가 누락되거나 바뀌었다.",
    };
  };
  const decisions = questions.map((question) =>
    decision(question, Number(question.number) === testCase.number ? "mismatch" : "exact"));
  const classified = questions.map((question, index) => ({ question, classification: decisions[index] }));
  const solutions: SolutionItem[] = questions.map((question) => ({
    number: question.number!,
    answer: question.answer,
    explanation: `${question.number}번 공식 해설`,
    page: 1,
    complete: true,
  }));
  writeJson(join(root, "problem-chunks", "v2-0000.json"), {
    version: 2, sourceHash: problem.sha256, from: 1, to: 16, ownedFrom: 1, ownedTo: 16,
    model: "gpt-5.6-sol", reasoningEffort: "high", items: questions,
  });
  writeJson(join(root, "classification-chunks", `v${CLASSIFIER_VERSION}-0000-${CLASSIFIER_DIGEST}.json`), {
    version: CLASSIFIER_VERSION, sourceHash: problem.sha256, from: 1, to: 16, ownedFrom: 1, ownedTo: 16,
    rulesDigest: CLASSIFIER_DIGEST, transcriptionGateVersion: TRANSCRIPTION_GATE_VERSION,
    transcriptionPromptDigest: TRANSCRIPTION_PROMPT_DIGEST, model: "gpt-5.6-sol", reasoningEffort: "high",
    items: decisions,
  });
  writeJson(join(root, "solution-chunks", "v3-0000.json"), {
    version: 3, sourceHash: solution.sha256, from: 1, to: 1, ownedFrom: 1, ownedTo: 1,
    model: "gpt-5.6-sol", reasoningEffort: "high", items: solutions,
  });

  const calls = { extraction: 0, crop: 0, classification: 0, terminal: 0, solution: 0 };
  providerMock.complete.mockImplementation(async (request: { schema?: { name?: string }; prompt: string }) => {
    if (request.schema?.name === "studywork_file_quiz_items") {
      calls.extraction++;
      const crop = request.prompt.includes("ALLOWLISTED PIXEL-CROP ADJUDICATION");
      if (crop) {
        calls.crop++;
        for (const token of spec.requiredTokens) expect(request.prompt.replace(/\s+/gu, ""))
          .toContain(token.replace(/\s+/gu, ""));
      }
      return { text: JSON.stringify([{
        ...questions[testCase.number - 1],
        question: crop ? grounded.question : "여전히 축약된 공통 지문과 대상 문제",
        choices,
        choiceCount: 5,
      }]) };
    }
    if (request.schema?.name === "studywork_exam_corpus_classification") {
      calls.classification++;
      const inputs = JSON.parse(request.prompt.split("Questions:\n")[1]) as Array<{ question: string }>;
      return { text: JSON.stringify([decision(
        { ...questions[testCase.number - 1], question: inputs[0].question },
        inputs[0].question.includes("CROP_FINAL") ? "exact" : "mismatch"
      )]) };
    }
    if (request.schema?.name === "studywork_exam_corpus_problem_terminal_fidelity") {
      calls.terminal++;
      const inputs = JSON.parse(request.prompt.split("Final questions:\n")[1]) as Array<{
        key: string; question: string;
      }>;
      return { text: JSON.stringify(inputs.map((input) => ({
        key: input.key,
        status: input.key === testCase.key && !input.question.includes("CROP_FINAL") ? "mismatch" : "exact",
        evidence: "공식 source pixels와 독립 비교했다.",
        scopeDecision: input.key === testCase.key ? "accept" : "reject",
        scopeConfidence: 0.99,
        scopeEvidence: input.key === testCase.key ? "요청 국어 범위이다." : "요청 범위 밖이다.",
      }))) };
    }
    if (request.schema?.name === "studywork_exam_corpus_solution_fidelity") {
      calls.solution++;
      return { text: JSON.stringify([{
        key: testCase.key,
        sourcePage: 1,
        answerStatus: "exact",
        explanationStatus: "exact",
        evidence: "공식 답과 해설이 일치한다.",
      }]) };
    }
    throw new Error(`unexpected schema ${request.schema?.name}`);
  });

  const result = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
  const repair = result.repairs.find((item) => item.key === testCase.key)!;
  const adjudication = repair.revision!.recovery!.adjudication!;
  expect(PROBLEM_CROP_ADJUDICATION_VERSION).toBe(1);
  expect(calls.crop).toBe(1);
  expect(adjudication).toMatchObject({
    allowlistId: spec.allowlistId,
    key: testCase.key,
    sourcePage: testCase.page,
    sourcePages: [...new Set(spec.views.map((view) => view.sourcePage))],
    cropViews: spec.views.map((view) => ({ sourcePage: view.sourcePage, label: view.label, rect: view.rect })),
    problemArtifact: { path: expect.stringMatching(/^problem-crop-adjudications\/v1-/u) },
    classificationArtifact: { path: expect.stringMatching(/^classification-crop-adjudications\/v1-/u) },
  });
  expect(adjudication.cropViews).toHaveLength(4);
  for (const view of adjudication.cropViews) {
    expect(view.artifact.path).toMatch(/^problem-crop-evidence\/v1-.*-view-\d{2}\.png$/u);
    expect(hash(readFileSync(join(root, view.artifact.path)))).toBe(view.artifact.sha256);
    expect(view.pixelSha256).toBe(view.artifact.sha256);
  }
  expect(result.classified.find((item) => item.classification.key === testCase.key)).toMatchObject({
    question: { question: expect.stringContaining("CROP_FINAL") },
    classification: { decision: "accept", transcription_status: "exact" },
  });
  expect(result.problemTerminalFidelityItems.find((item) => item.key === testCase.key)).toMatchObject({
    status: "exact", scopeDecision: "accept",
  });
  expect(result.auditPath).toMatch(/^answer-audit\/v5-/u);

  const beforeReplay = { ...calls };
  const replay = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
  expect(calls).toEqual(beforeReplay);
  expect(replay.auditHash).toBe(result.auditHash);
  expect(canonicalEvidenceHash(replay.repairs)).toBe(canonicalEvidenceHash(result.repairs));

  const cropEvidencePath = join(root, adjudication.cropEvidenceArtifact.path);
  const cropEvidenceBytes = readFileSync(cropEvidencePath);
  unlinkSync(cropEvidencePath);
  const beforeCrashReplay = { ...calls };
  const crashReplay = await repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions);
  expect(calls).toEqual(beforeCrashReplay);
  expect(readFileSync(cropEvidencePath)).toEqual(cropEvidenceBytes);
  expect(crashReplay.auditHash).toBe(result.auditHash);

  const viewPath = join(root, adjudication.cropViews[0].artifact.path);
  const originalView = readFileSync(viewPath);
  writeFileSync(viewPath, Buffer.concat([originalView, Buffer.from("tampered")]));
  await expect(repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions))
    .rejects.toThrow("crop evidence view file hash가 다릅니다");
  writeFileSync(viewPath, originalView);

  const classificationPath = join(root, adjudication.classificationArtifact.path);
  const originalClassification = readFileSync(classificationPath);
  const failedClassification = JSON.parse(originalClassification.toString()) as {
    items: Array<{ transcription_status: string; transcription_evidence: string }>;
  };
  failedClassification.items[0].transcription_status = "mismatch";
  failedClassification.items[0].transcription_evidence = "crop adjudication 이후에도 source marker가 다르다.";
  writeCanonicalJson(classificationPath, failedClassification);
  const beforeFailedReplay = { ...calls };
  await expect(repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions))
    .rejects.toThrow("allowlisted crop adjudication도 exact가 아닙니다");
  expect(calls).toEqual(beforeFailedReplay);
  writeFileSync(classificationPath, originalClassification);

  writeFileSync(join(root, "problem-crop-adjudications", "orphan.json"), "{}\n");
  await expect(repairAndAuditOfficialAnswers(entry, problem, solution, root, classified, solutions))
    .rejects.toThrow("crop adjudication orphan/conflict");
}

describe("allowlisted problem crop adjudication", () => {
  it("keeps the exceptional authority to the two exact entry/page/number identities", () => {
    expect(PROBLEM_CROP_ADJUDICATION_ALLOWLIST.map(({ entryId, key, sourcePage, sourceHash }) => ({
      entryId, key, sourcePage, sourceHash,
    }))).toEqual([
      {
        entryId: "ebsi:5578421", key: "11:29", sourcePage: 11,
        sourceHash: "4c9aee0ec0c15f91678bc3c179efb4c781ab0f9023ca2e5347df94060012272e",
      },
      {
        entryId: "ebsi:5594499", key: "13:34", sourcePage: 13,
        sourceHash: "0ddccee92ce4e4ba3da53ed253e780cd7b41b5962f7e9761a920079619f81c31",
      },
    ]);
    expect(PROBLEM_CROP_ADJUDICATION_VERSION).toBe(1);
    expect(CLASSIFICATION_CROP_ADJUDICATION_VERSION).toBe(1);
    expect(TARGETED_PROBLEM_CROP_ADJUDICATION_PROMPT_DIGEST).toMatch(/^[a-f0-9]{64}$/u);
    expect(PROBLEM_CROP_ADJUDICATION_CLASSIFICATION_PROMPT_DIGEST).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.skipIf(!existsSync(OFFICIAL_PROBLEM_PATHS["ebsi:5578421"]))(
  "recovers only ebsi:5578421 Q29 from bound p11 full/crop pixels", async () => {
    await runCase({ entryId: "ebsi:5578421", key: "11:29", page: 11, number: 29, answerIndex: 0 });
  }, 60_000);

  it.skipIf(!existsSync(OFFICIAL_PROBLEM_PATHS["ebsi:5594499"]))(
  "recovers only ebsi:5594499 Q34 from bound p12-p13 crop pixels", async () => {
    await runCase({ entryId: "ebsi:5594499", key: "13:34", page: 13, number: 34, answerIndex: 1 });
  }, 60_000);
});
