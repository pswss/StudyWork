// parseQuestionsJson 유닛 테스트 — vi.mock 없이 실제 구현을 테스트한다.
import { describe, it, expect } from "vitest";
import {
  parsePageExtractions,
  parseQuestionsJson,
  parseQuizItemsEx,
  parseSolutionItems,
  validateGeneratedQuestions,
} from "../src/claude";

const VALID_MCQ = JSON.stringify([
  {
    qtype: "mcq",
    difficulty: "중",
    question: "다음 중 이차함수는?",
    choices: ["y=x", "y=x^2", "y=1/x", "y=x^3"],
    answer: "y=x^2",
    explanation: "이차함수는 차수가 2인 함수이다.",
  },
]);

const VALID_OX = JSON.stringify([
  {
    qtype: "ox",
    difficulty: "하",
    question: "태양은 지구 주위를 돈다.",
    choices: null,
    answer: "x",
    explanation: "지구가 태양 주위를 돈다.",
  },
]);

const VALID_SHORT = JSON.stringify([
  {
    qtype: "short",
    difficulty: "상",
    question: "뉴턴의 제2법칙을 수식으로 쓰시오.",
    choices: null,
    answer: "F=ma",
    explanation: "힘=질량×가속도",
  },
]);

describe("parseQuestionsJson", () => {
  it("유효한 MCQ → 파싱 성공, choices 배열 보존", () => {
    const result = parseQuestionsJson(VALID_MCQ);
    expect(result).toHaveLength(1);
    expect(result[0].qtype).toBe("mcq");
    expect(result[0].difficulty).toBe("중");
    expect(Array.isArray(result[0].choices)).toBe(true);
    expect(result[0].choices).toHaveLength(4);
    expect(result[0].answer).toBe("y=x^2");
  });

  it("유효한 OX → 파싱 성공, choices null", () => {
    const result = parseQuestionsJson(VALID_OX);
    expect(result).toHaveLength(1);
    expect(result[0].qtype).toBe("ox");
    expect(result[0].choices).toBeNull();
    expect(result[0].answer).toBe("x");
  });

  it("유효한 short → 파싱 성공", () => {
    const result = parseQuestionsJson(VALID_SHORT);
    expect(result).toHaveLength(1);
    expect(result[0].qtype).toBe("short");
    expect(result[0].answer).toBe("F=ma");
  });

  it("마크다운 코드 펜스(```json) 제거 후 파싱", () => {
    const fenced = "```json\n" + VALID_MCQ + "\n```";
    const result = parseQuestionsJson(fenced);
    expect(result).toHaveLength(1);
    expect(result[0].qtype).toBe("mcq");
  });

  it("마크다운 코드 펜스(```) 제거 후 파싱", () => {
    const fenced = "```\n" + VALID_OX + "\n```";
    const result = parseQuestionsJson(fenced);
    expect(result).toHaveLength(1);
  });

  it("배열 앞뒤에 여분 텍스트 있어도 첫 [ ~ 마지막 ] 추출", () => {
    const withPreamble = "여기 문제 목록입니다:\n" + VALID_MCQ + "\n이상입니다.";
    const result = parseQuestionsJson(withPreamble);
    expect(result).toHaveLength(1);
  });

  it("explanation 누락 시 빈 문자열로 기본값 처리", () => {
    const noExplanation = JSON.stringify([
      {
        qtype: "short",
        difficulty: "하",
        question: "1+1=?",
        choices: null,
        answer: "2",
        // explanation 없음
      },
    ]);
    const result = parseQuestionsJson(noExplanation);
    expect(result[0].explanation).toBe("");
  });

  it("잘못된 qtype → 에러 throw", () => {
    const bad = JSON.stringify([
      {
        qtype: "essay",  // 허용되지 않는 값
        difficulty: "중",
        question: "설명하시오",
        choices: null,
        answer: "답",
        explanation: "",
      },
    ]);
    expect(() => parseQuestionsJson(bad)).toThrow();
  });

  it("잘못된 difficulty → 에러 throw", () => {
    const bad = JSON.stringify([
      {
        qtype: "short",
        difficulty: "최상",  // 허용되지 않는 값
        question: "문제",
        choices: null,
        answer: "답",
        explanation: "",
      },
    ]);
    expect(() => parseQuestionsJson(bad)).toThrow();
  });

  it("mcq에 choices 없음 → 에러 throw", () => {
    const bad = JSON.stringify([
      {
        qtype: "mcq",
        difficulty: "중",
        question: "보기 없는 객관식?",
        choices: null,  // mcq는 choices 필수
        answer: "답",
        explanation: "",
      },
    ]);
    expect(() => parseQuestionsJson(bad)).toThrow();
  });

  it("mcq choices 빈 배열 → 에러 throw", () => {
    const bad = JSON.stringify([
      {
        qtype: "mcq",
        difficulty: "중",
        question: "보기 비어있는 객관식?",
        choices: [],
        answer: "답",
        explanation: "",
      },
    ]);
    expect(() => parseQuestionsJson(bad)).toThrow();
  });

  it("question 비어있음 → 에러 throw", () => {
    const bad = JSON.stringify([
      {
        qtype: "short",
        difficulty: "하",
        question: "  ",  // 공백만
        choices: null,
        answer: "답",
        explanation: "",
      },
    ]);
    expect(() => parseQuestionsJson(bad)).toThrow();
  });

  it("answer 비어있음 → 에러 throw", () => {
    const bad = JSON.stringify([
      {
        qtype: "short",
        difficulty: "하",
        question: "문제",
        choices: null,
        answer: "",  // 비어있음
        explanation: "",
      },
    ]);
    expect(() => parseQuestionsJson(bad)).toThrow();
  });

  it("JSON 배열 없음 → 에러 throw", () => {
    const privateOutput = "학생 주민번호 000000-0000000";
    let error: unknown;
    try {
      parseQuestionsJson(privateOutput);
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("JSON 배열");
    expect(String(error)).not.toContain(privateOutput);
  });

  it("여러 문항 포함 배열 파싱", () => {
    const multi = JSON.stringify([
      {
        qtype: "mcq",
        difficulty: "하",
        question: "1+1=?",
        choices: ["1", "2", "3", "4"],
        answer: "2",
        explanation: "산수",
      },
      {
        qtype: "ox",
        difficulty: "상",
        question: "지구는 평평하다.",
        choices: null,
        answer: "x",
        explanation: "지구는 구형이다.",
      },
    ]);
    const result = parseQuestionsJson(multi);
    expect(result).toHaveLength(2);
    expect(result[0].qtype).toBe("mcq");
    expect(result[1].qtype).toBe("ox");
  });
});

describe("validateGeneratedQuestions", () => {
  it("실제 도형이 포함되지 않은 그림 참조 문항을 저장 전에 거부", () => {
    expect(() => validateGeneratedQuestions([{
      qtype: "mcq",
      difficulty: "중",
      question: "아래 그림을 보고 넓이를 구하시오.",
      choices: ["1", "2", "3", "4"],
      answer: "2",
      explanation: "넓이는 2이다.",
    }], 1, "중")).toThrow("제공되지 않은 그림");
  });

  it("화면에서 제거되는 외부 Markdown 이미지를 거부", () => {
    expect(() => validateGeneratedQuestions([{
      qtype: "short",
      difficulty: "하",
      question: "![도형](https://example.com/figure.png)에서 점 A의 이름은?",
      choices: null,
      answer: "A",
      explanation: "도형의 표시에 A라고 적혀 있다.",
    }], 1, "하")).toThrow("안전하게 렌더링");
  });
});

describe("parseQuizItemsEx", () => {
  const base = {
    qtype: "mcq",
    difficulty: "중",
    question: "옳은 것을 고르시오.",
    choices: ["① 첫째", "② 둘째", "③ 셋째"],
    choiceCount: 3,
    answer: "③",
    explanation: "해설",
    page: 2,
    figure: false,
    box: null,
  };

  it("객관식 번호 답을 실제 보기 문자열로 정규화", () => {
    expect(parseQuizItemsEx(JSON.stringify([base]))[0].answer).toBe("③ 셋째");
  });

  it("오지선다 보기 5개를 순서대로 보존", () => {
    const item = {
      ...base,
      choices: ["① 하나", "② 둘", "③ 셋", "④ 넷", "⑤ 다섯"],
      choiceCount: 5,
      answer: "⑤",
      explanation: "",
    };
    const parsed = parseQuizItemsEx(JSON.stringify([item]))[0];
    expect(parsed.choices).toEqual(item.choices);
    expect(parsed.answer).toBe("⑤ 다섯");
    expect(parsed.explanation).toBe("");
  });

  it("OX 답을 canonical o/x로 정규화", () => {
    const item = { ...base, qtype: "ox", choices: null, choiceCount: null, answer: "참" };
    expect(parseQuizItemsEx(JSON.stringify([item]))[0].answer).toBe("o");
  });

  it.each([
    ["잘못된 qtype", { ...base, qtype: "essay" }],
    ["잘못된 난이도", { ...base, difficulty: "최상" }],
    ["빈 정답", { ...base, answer: " " }],
    ["보기 부족", { ...base, choices: ["① 하나"] }],
    ["보기 개수 불일치", { ...base, choiceCount: 5 }],
    ["보기와 불일치하는 정답", { ...base, answer: "④" }],
  ])("%s는 청크 전체를 거부", (_label, item) => {
    expect(() => parseQuizItemsEx(JSON.stringify([base, item]))).toThrow();
  });
});

describe("parseSolutionItems", () => {
  it("공식 해설의 순서·정답·페이지를 보존", () => {
    expect(parseSolutionItems(JSON.stringify([
      { number: "1", answer: "③", explanation: "$x=3$을 대입한다.", page: 4, complete: true },
      { number: "2", answer: "5", explanation: "양변을 더하면 5이다.", page: 4, complete: true },
    ]))).toEqual([
      { number: "1", answer: "③", explanation: "$x=3$을 대입한다.", page: 4, complete: true },
      { number: "2", answer: "5", explanation: "양변을 더하면 5이다.", page: 4, complete: true },
    ]);
  });

  it("정답·해설·페이지가 비정상이면 저장 전에 거부", () => {
    expect(() => parseSolutionItems(JSON.stringify([
      { number: "1", answer: "", explanation: "", page: 0, complete: false },
    ]))).toThrow();
  });

  it("청크 경계에서 잘린 해설은 거부", () => {
    expect(() => parseSolutionItems(JSON.stringify([
      { number: "1", answer: "3", explanation: "다음 페이지에 계속", page: 6, complete: false },
    ]))).toThrow("청크 경계에서 내용이 잘렸습니다");
  });
});

describe("parsePageExtractions", () => {
  it("요청한 모든 페이지가 순서대로 있으면 빈 페이지도 보존", () => {
    expect(parsePageExtractions(JSON.stringify([
      { page: 4, markdown: "본문" },
      { page: 5, markdown: "" },
    ]), [4, 5])).toEqual([
      { page: 4, markdown: "본문" },
      { page: 5, markdown: "" },
    ]);
  });

  it.each([
    ["누락", [{ page: 4, markdown: "본문" }]],
    ["중복", [{ page: 4, markdown: "본문" }, { page: 4, markdown: "중복" }]],
    ["범위 밖", [{ page: 4, markdown: "본문" }, { page: 6, markdown: "범위 밖" }]],
  ])("%s 페이지가 있으면 청크 전체를 거부", (_label, pages) => {
    expect(() => parsePageExtractions(JSON.stringify(pages), [4, 5])).toThrow("페이지 전사 검증 실패");
  });
});
