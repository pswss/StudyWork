// 2028학년도 수능 예시문항(한국교육과정평가원, 2025-04)의 문항 수·순서·배점 틀.
// AI는 내용만 만들고 번호, 유형, 난이도, 배점은 이 청사진을 바꿀 수 없다.

export const MOCK_EXAM_AREAS = [
  "korean",
  "math",
  "english",
  "history",
  "social",
  "science",
  "vocational",
  "second-language",
] as const;

export type MockExamArea = (typeof MOCK_EXAM_AREAS)[number];
export type MockExamDifficulty = "하" | "중" | "상";

export interface MockExamQuestionSpec {
  number: number;
  section: string;
  qtype: "mcq" | "short";
  difficulty: MockExamDifficulty;
  points: number;
  passage_group: string | null;
  passage_brief: string | null;
}

export interface MockExamDraftQuestion {
  number: number;
  section: string;
  passage_group: string | null;
  passage: string | null;
  qtype: "mcq" | "short";
  difficulty: MockExamDifficulty;
  question: string;
  choices: string[] | null;
  answer: string;
  explanation: string;
}

export interface MockExamQuestion extends MockExamDraftQuestion {
  points: number;
}

export interface MockExamBlueprint {
  area: MockExamArea;
  label: string;
  count: number;
  minutes: number;
  totalPoints: number;
  chunks: ReadonlyArray<readonly [number, number]>;
  specs: MockExamQuestionSpec[];
}

interface PassageBand {
  from: number;
  to: number;
  section: string;
  group: string;
  brief: string;
}

const band = (from: number, to: number, section: string, group: string, brief: string): PassageBand =>
  ({ from, to, section, group, brief });

function individualBands(
  from: number,
  to: number,
  sectionAt: (number: number) => string,
  prefix: string,
  brief: string,
): PassageBand[] {
  return Array.from({ length: to - from + 1 }, (_, index) => {
    const number = from + index;
    return band(number, number, sectionAt(number), `${prefix} ${number}`, brief);
  });
}

const koreanPoints = [
  2, 2, 2, 2, 2, 3, 3, 2, 2, 2, 2, 2, 3, 2, 2,
  2, 3, 2, 2, 2, 2, 2, 3, 2, 2, 2, 3, 2, 2, 2,
  2, 2, 3, 2, 2, 2, 2, 3, 2, 2, 2, 3, 2, 2, 3,
];

const mathPoints = [
  2, 2, 2, 3, 3, 3, 3, 3, 3, 3,
  3, 3, 3, 4, 4, 4, 4, 4, 4, 4,
  4, 3, 3, 3, 3, 4, 4, 4, 4, 4,
];

const socialPoints = [
  2, 1.5, 2.5, 2, 2.5, 1.5, 2, 1.5, 1.5, 1.5,
  2, 2.5, 2.5, 2.5, 2.5, 2, 1.5, 1.5, 2, 2,
  2.5, 2.5, 2, 2, 1.5,
];

const sciencePoints = [
  1.5, 1.5, 1.5, 2.5, 1.5, 1.5, 2, 2, 2.5, 1.5,
  2.5, 2, 1.5, 2, 2, 2, 1.5, 2, 2, 2.5,
  2.5, 2, 2.5, 2.5, 2.5,
];

const fiftyPointStandard = Array.from({ length: 20 }, (_, index) => index % 2 === 0 ? 2 : 3);

function difficultyFor(points: number, number: number, scale: "standard" | "math" | "inquiry"): MockExamDifficulty {
  if (scale === "math") return points === 2 ? "하" : points === 3 ? "중" : "상";
  if (scale === "inquiry") return points === 1.5 ? "하" : points === 2 ? "중" : "상";
  if (points === 3) return "상";
  return number % 2 === 0 ? "하" : "중";
}

function specsFrom(
  points: number[],
  bands: PassageBand[] | null,
  sectionAt: (number: number) => string,
  qtypeAt: (number: number) => "mcq" | "short",
  scale: "standard" | "math" | "inquiry",
): MockExamQuestionSpec[] {
  return points.map((point, index) => {
    const number = index + 1;
    const passage = bands?.find((candidate) => number >= candidate.from && number <= candidate.to) ?? null;
    return {
      number,
      section: passage?.section ?? sectionAt(number),
      qtype: qtypeAt(number),
      difficulty: difficultyFor(point, number, scale),
      points: point,
      passage_group: passage?.group ?? null,
      passage_brief: passage?.brief ?? null,
    };
  });
}

const koreanBands = [
  band(1, 3, "화법과 언어", "발표", "발표문과 발표 계획을 함께 제시"),
  band(4, 6, "화법과 언어", "토의", "공동체 문제를 다루는 토의와 관련 자료를 제시"),
  band(7, 10, "화법과 언어", "언어 탐구", "어휘·문법·국어사 탐구 자료를 제시"),
  band(11, 13, "독서와 작문", "인문·예술", "인문 또는 예술 분야의 긴 글"),
  band(14, 17, "독서와 작문", "과학·기술", "과학 또는 기술 원리를 설명하는 긴 글"),
  band(18, 23, "독서와 작문", "사회·문화", "사회·문화 쟁점의 관점과 논증이 드러나는 긴 글"),
  band(24, 27, "독서와 작문", "주제 통합", "같은 주제를 다른 관점에서 다룬 두 글과 작문 자료"),
  band(28, 30, "독서와 작문", "작문", "초고, 자료, 고쳐쓰기 상황을 함께 제시"),
  band(31, 34, "문학", "고전 시가·수필", "고전 시가와 수필을 엮은 작품 세트"),
  band(35, 38, "문학", "현대 소설", "완결된 맥락을 파악할 수 있는 현대 소설 발췌"),
  band(39, 42, "문학", "고전 소설", "완결된 맥락을 파악할 수 있는 고전 소설 발췌"),
  band(43, 45, "문학", "현대 시", "서로 비교할 수 있는 현대 시 작품 세트"),
];

const mathSections = [
  "대수", "미적분Ⅰ", "확률과 통계", "대수", "미적분Ⅰ", "확률과 통계",
  "대수", "미적분Ⅰ", "확률과 통계", "대수", "미적분Ⅰ", "확률과 통계",
  "확률과 통계", "대수", "미적분Ⅰ", "대수", "미적분Ⅰ", "미적분Ⅰ",
  "대수", "미적분Ⅰ", "확률과 통계", "대수", "미적분Ⅰ", "대수",
  "미적분Ⅰ", "확률과 통계", "대수", "미적분Ⅰ", "확률과 통계", "대수",
];

const englishBands = [
  ...individualBands(1, 15, () => "듣기", "듣기", "Woman:, Man:, Narrator: 화자 라벨을 줄마다 붙인 짧은 영어 대화 또는 담화 대본"),
  band(16, 17, "듣기", "듣기 16-17", "Woman:, Man:, Narrator: 화자 라벨을 줄마다 붙인 한 담화의 영어 대본"),
  ...individualBands(18, 24, () => "읽기", "읽기", "목적·심경·주장·요지·주제·제목을 묻는 영어 지문"),
  ...individualBands(25, 28, () => "읽기", "자료", "도표, 안내문 또는 내용 일치를 판단할 영어 자료"),
  ...individualBands(29, 40, () => "읽기", "독해", "어법·어휘·빈칸·순서·문장 삽입·요약을 묻는 영어 지문"),
  band(41, 42, "읽기", "장문 41-42", "한 영어 장문으로 푸는 두 문항"),
  band(43, 45, "읽기", "장문 43-45", "한 영어 장문으로 푸는 세 문항"),
];

const historySection = (number: number) =>
  number <= 5 ? "전근대사" : number <= 10 ? "근대사" : number <= 15 ? "일제강점기" : "현대사";

const socialSection = (number: number) => {
  if (number <= 2) return "통합적 관점과 행복";
  if (number <= 8) return "자연환경과 문화";
  if (number <= 9) return "생활공간";
  if (number <= 14) return "인권";
  if (number <= 16) return "정의";
  if (number <= 21) return "시장과 지속가능발전";
  return "세계화·평화·미래";
};

const scienceSections = [
  "환경과 생태계", "과학의 기초", "과학의 기초", "물질과 규칙성", "환경과 생태계",
  "과학과 미래 사회", "변화와 다양성", "변화와 다양성", "과학과 미래 사회", "환경과 에너지",
  "물질과 규칙성", "변화와 다양성", "물질과 규칙성", "물질과 규칙성", "시스템과 상호작용",
  "환경과 에너지", "변화와 다양성", "시스템과 상호작용", "물질과 규칙성", "시스템과 상호작용",
  "물질과 규칙성", "시스템과 상호작용", "시스템과 상호작용", "변화와 다양성", "환경과 에너지",
];

const vocationalSection = (number: number) =>
  number <= 5 ? "직업과 자기 이해" : number <= 10 ? "산업과 직업 세계" :
    number <= 15 ? "직업 윤리와 안전" : number <= 20 ? "경영과 근로" : "진로 설계";

const secondLanguageSection = (number: number) =>
  number <= 5 ? "발음·문자" : number <= 10 ? "어휘·문법" : number <= 15 ? "의사소통" : "문화·독해";

const allMcq = () => "mcq" as const;

const blueprints: Record<MockExamArea, MockExamBlueprint> = {
  korean: {
    area: "korean", label: "국어", count: 45, minutes: 80, totalPoints: 100,
    chunks: [[1, 10], [11, 30], [31, 45]],
    specs: specsFrom(koreanPoints, koreanBands, () => "국어", allMcq, "standard"),
  },
  math: {
    area: "math", label: "수학", count: 30, minutes: 100, totalPoints: 100,
    chunks: [[1, 15], [16, 30]],
    specs: specsFrom(mathPoints, null, (number) => mathSections[number - 1], (number) => number <= 21 ? "mcq" : "short", "math"),
  },
  english: {
    area: "english", label: "영어", count: 45, minutes: 70, totalPoints: 100,
    chunks: [[1, 17], [18, 32], [33, 45]],
    specs: specsFrom(koreanPoints, englishBands, () => "영어", allMcq, "standard"),
  },
  history: {
    area: "history", label: "한국사", count: 20, minutes: 30, totalPoints: 50,
    chunks: [[1, 10], [11, 20]],
    specs: specsFrom(
      fiftyPointStandard,
      individualBands(1, 20, historySection, "한국사 자료", "사료·연표·지도·도표 중 적절한 자료를 Markdown으로 제시"),
      historySection,
      allMcq,
      "standard",
    ),
  },
  social: {
    area: "social", label: "통합사회", count: 25, minutes: 40, totalPoints: 50,
    chunks: [[1, 13], [14, 25]],
    specs: specsFrom(
      socialPoints,
      individualBands(1, 25, socialSection, "통합사회 자료", "사례·통계·지도·글 자료를 Markdown으로 제시"),
      socialSection,
      allMcq,
      "inquiry",
    ),
  },
  science: {
    area: "science", label: "통합과학", count: 25, minutes: 40, totalPoints: 50,
    chunks: [[1, 13], [14, 25]],
    specs: specsFrom(
      sciencePoints,
      individualBands(1, 25, (number) => scienceSections[number - 1], "통합과학 자료", "실험·그래프·표·과학 자료를 Markdown 또는 ASCII로 완전하게 제시"),
      (number) => scienceSections[number - 1],
      allMcq,
      "inquiry",
    ),
  },
  vocational: {
    area: "vocational", label: "직업탐구", count: 25, minutes: 40, totalPoints: 50,
    chunks: [[1, 13], [14, 25]],
    specs: specsFrom(
      socialPoints,
      individualBands(1, 25, vocationalSection, "직업탐구 자료", "성공적인 직업 생활의 사례·표·업무 자료를 Markdown으로 제시"),
      vocationalSection,
      allMcq,
      "inquiry",
    ),
  },
  "second-language": {
    area: "second-language", label: "제2외국어·한문", count: 20, minutes: 30, totalPoints: 50,
    chunks: [[1, 10], [11, 20]],
    specs: specsFrom(
      fiftyPointStandard,
      individualBands(1, 20, secondLanguageSection, "언어 자료", "현재 과목 언어의 대화·안내·문화·독해 자료를 제시"),
      secondLanguageSection,
      allMcq,
      "standard",
    ),
  },
};

export function isMockExamArea(value: unknown): value is MockExamArea {
  return typeof value === "string" && (MOCK_EXAM_AREAS as readonly string[]).includes(value);
}

export function getMockExamBlueprint(area: MockExamArea): MockExamBlueprint {
  return blueprints[area];
}

const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

function unsafeVisual(text: string): boolean {
  return /<\/?(?:svg|img)\b/i.test(text) || /!\[[^\]]*\]\([^)]*\)/.test(text);
}

/** AI가 청사진의 번호·유형·난이도·지문 묶음을 한 글자도 바꾸지 못하게 검증한다. */
export function validateMockExamChunk(
  questions: MockExamDraftQuestion[],
  specs: MockExamQuestionSpec[],
): MockExamQuestion[] {
  if (questions.length !== specs.length) {
    throw new Error(`모의고사 청사진 ${specs.length}문항 중 ${questions.length}문항만 생성되었습니다`);
  }
  const seenQuestions = new Set<string>();
  const passages = new Map<string, string>();

  return questions.map((question, index) => {
    const spec = specs[index];
    if (question.number !== spec.number) throw new Error(`모의고사 ${spec.number}번 번호가 순서와 다릅니다`);
    if (question.section !== spec.section) throw new Error(`모의고사 ${spec.number}번 영역이 청사진과 다릅니다`);
    if (question.qtype !== spec.qtype) throw new Error(`모의고사 ${spec.number}번 문항 유형이 청사진과 다릅니다`);
    if (question.difficulty !== spec.difficulty) throw new Error(`모의고사 ${spec.number}번 난이도가 청사진과 다릅니다`);
    if (question.passage_group !== spec.passage_group) throw new Error(`모의고사 ${spec.number}번 지문 묶음이 청사진과 다릅니다`);

    const stem = question.question.trim();
    const answer = question.answer.trim();
    const explanation = question.explanation.trim();
    if (!stem || stem.length > 10_000) throw new Error(`모의고사 ${spec.number}번 문제 본문이 유효하지 않습니다`);
    if (!answer || answer.length > 3_000) throw new Error(`모의고사 ${spec.number}번 정답이 유효하지 않습니다`);
    if (!explanation || explanation.length > 20_000) throw new Error(`모의고사 ${spec.number}번 검증 해설이 없습니다`);
    const key = normalize(stem);
    if (seenQuestions.has(key)) throw new Error(`모의고사 ${spec.number}번 문제가 중복되었습니다`);
    seenQuestions.add(key);

    let choices: string[] | null = null;
    if (spec.qtype === "mcq") {
      if (!question.choices || question.choices.length !== 5) {
        throw new Error(`모의고사 ${spec.number}번 객관식 보기는 정확히 5개여야 합니다`);
      }
      choices = question.choices.map((choice) => choice.trim());
      if (choices.some((choice) => !choice || choice.length > 3_000)) {
        throw new Error(`모의고사 ${spec.number}번 보기가 유효하지 않습니다`);
      }
      if (new Set(choices.map(normalize)).size !== 5) {
        throw new Error(`모의고사 ${spec.number}번 보기가 중복되었습니다`);
      }
      if (choices.filter((choice) => normalize(choice) === normalize(answer)).length !== 1) {
        throw new Error(`모의고사 ${spec.number}번 정답이 보기 하나와 정확히 일치하지 않습니다`);
      }
    } else {
      if (question.choices !== null) {
        throw new Error(`모의고사 ${spec.number}번 단답형의 choices는 null이어야 합니다`);
      }
      if (!/^(?:0|[1-9]\d{0,2})$/.test(answer)) {
        throw new Error(`모의고사 ${spec.number}번 단답형 정답은 0~999 정수여야 합니다`);
      }
    }

    let passage: string | null = null;
    if (spec.passage_group) {
      const existing = passages.get(spec.passage_group);
      if (existing === undefined) {
        if (typeof question.passage !== "string" || !question.passage.trim() || question.passage.length > 30_000) {
          throw new Error(`모의고사 ${spec.number}번의 첫 지문이 비어 있거나 너무 깁니다`);
        }
        passage = question.passage.trim();
        passages.set(spec.passage_group, passage);
      } else {
        if (question.passage !== null) {
          throw new Error(`모의고사 ${spec.number}번은 같은 지문을 반복 출력하지 말아야 합니다`);
        }
        passage = existing;
      }
    } else if (question.passage !== null) {
      throw new Error(`모의고사 ${spec.number}번에는 별도 지문이 없어야 합니다`);
    }

    const safeText = [passage ?? "", stem, ...(choices ?? []), answer, explanation].join("\n");
    if (unsafeVisual(safeText)) throw new Error(`모의고사 ${spec.number}번에 안전하지 않은 그림 형식이 있습니다`);
    if (
      /(?:위|아래|다음|주어진)\s*(?:의\s*)?(?:그림|도형|그래프|사진|이미지)/.test(safeText)
      && !/```[\s\S]+```/.test(safeText)
      && !/\n\s*\|.+\|\s*\n\s*\|[-: |]+\|/.test(safeText)
    ) {
      throw new Error(`모의고사 ${spec.number}번이 제공되지 않은 그림을 참조합니다`);
    }

    return {
      ...question,
      passage,
      question: stem,
      choices,
      answer,
      explanation,
      points: spec.points,
    };
  });
}

export function validateCompleteMockExam(
  questions: MockExamQuestion[],
  blueprint: MockExamBlueprint,
): MockExamQuestion[] {
  if (questions.length !== blueprint.count) {
    throw new Error(`완성 모의고사가 ${blueprint.count}문항이 아닙니다`);
  }
  const seenQuestions = new Set<string>();
  const passages = new Map<string, string>();
  let points = 0;
  questions.forEach((question, index) => {
    const spec = blueprint.specs[index];
    if (question.number !== spec.number || question.qtype !== spec.qtype || question.section !== spec.section) {
      throw new Error(`완성 모의고사 ${spec.number}번 순서가 청사진과 다릅니다`);
    }
    const key = normalize(question.question);
    if (seenQuestions.has(key)) throw new Error(`완성 모의고사 ${spec.number}번 문제가 중복되었습니다`);
    seenQuestions.add(key);
    if (question.passage_group) {
      const previous = passages.get(question.passage_group);
      if (!question.passage || (previous !== undefined && previous !== question.passage)) {
        throw new Error(`완성 모의고사 ${spec.number}번 지문 연결이 깨졌습니다`);
      }
      passages.set(question.passage_group, question.passage);
    }
    points += question.points;
  });
  if (points !== blueprint.totalPoints) throw new Error(`완성 모의고사 총점이 ${blueprint.totalPoints}점이 아닙니다`);
  return questions;
}
