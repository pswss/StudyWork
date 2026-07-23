import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseStudyRoute } from "../web/src/App";
import { parseQuizFilters } from "../web/src/pages/Quiz";

describe("상세 화면 주소와 디자인 계약", () => {
  it("과목과 탭 주소를 복구하고 잘못된 주소는 무시한다", () => {
    expect(parseStudyRoute("?subject=12&tab=solution")).toEqual({ subjectId: 12, tab: "solution" });
    expect(parseStudyRoute("?subject=12")).toEqual({ subjectId: 12, tab: "chat" });
    expect(parseStudyRoute("?subject=0&tab=chat")).toBeNull();
    expect(parseStudyRoute("?subject=12&tab=unknown")).toBeNull();
  });

  it("퀴즈 출제 필터를 주소에서 복구하고 잘못된 값은 기본값으로 제한한다", () => {
    expect(parseQuizFilters("?quizSource=uploaded&quizDifficulty=상&quizCount=25&quizWrong=1"))
      .toEqual({ source: "uploaded", difficulty: "상", count: 25, wrong: true });
    expect(parseQuizFilters("?quizSource=x&quizDifficulty=x&quizCount=99"))
      .toEqual({ source: "all", difficulty: "all", count: 10, wrong: false });
  });

  it("장시간 작업마다 실제 중단 제어를 제공한다", () => {
    const chat = readFileSync("web/src/pages/ChatPanel.tsx", "utf8");
    const quiz = readFileSync("web/src/pages/Quiz.tsx", "utf8");
    const exam = readFileSync("web/src/pages/Exam.tsx", "utf8");
    const detail = readFileSync("web/src/pages/SubjectDetail.tsx", "utf8");

    expect(chat).toContain("답변 중단");
    expect(quiz).toContain("생성 중단");
    expect(exam).toContain("생성 중단");
    expect(detail).toContain("분석 중단");
  });

  it("커스텀 커서·지연 리빌 AI 티는 다시 넣지 않는다", () => {
    const app = readFileSync("web/src/App.tsx", "utf8");
    const css = readFileSync("web/src/styles.css", "utf8");

    expect(app).not.toContain("<Cursor");
    expect(css).not.toContain("revealUp");
    expect(css).not.toContain("has-custom-cursor");
  });

  it("한글 조합 중 Enter가 제출로 처리되지 않는다", () => {
    for (const file of ["ChatPanel.tsx", "Subjects.tsx", "Quiz.tsx"]) {
      expect(readFileSync(`web/src/pages/${file}`, "utf8")).toContain("nativeEvent.isComposing");
    }
    expect(readFileSync("web/src/pages/Login.tsx", "utf8")).toContain("<form");
  });
});
