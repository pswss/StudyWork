# StudyWork 3·4단계: 오답 노트 + 시험 계획 Implementation Plan

> **For agentic workers:** 기존 코드베이스 패턴(어댑터·라우트·테스트 헬퍼·vi.mock)을 따른다. API 계약은 프론트와 함께 아래에 고정한다.

**Goal:** ③ 오답 노트(퀴즈 오답 자동 축적 + 시험지 사진 등록 + 약점 분석 + 오답 복습) ④ 시험 계획(시험일·범위 → AI 계획 생성, 체크리스트 진도, 남은 날짜 기준 재조정)

## Task W1: 백엔드

**Migration `0004_wrong_exam.sql`:**
```sql
ALTER TABLE questions ADD COLUMN from_wrong_note INTEGER NOT NULL DEFAULT 0;

CREATE TABLE exams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  exam_date TEXT NOT NULL,          -- YYYY-MM-DD
  scope TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE plan_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER NOT NULL,
  day TEXT NOT NULL,                -- YYYY-MM-DD
  task TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
);
```

**claude.ts 추가:**
- `analyzeWrongQuestions(subjectName, wrongs: {question, answer, qtype, difficulty, wrong_count}[])` → 마크다운 텍스트: 자주 틀리는 유형·개념 패턴, 약점 3~5개, 각 약점별 보완 방법. 도구 없음, maxTurns 1.
- `generateStudyPlan(subjectName, examTitle, examDate, today, scope, materialTitles: string[], wrongSummary: string)` → strict JSON 배열 `[{"day":"YYYY-MM-DD","task":"..."}]` (today~examDate 범위, 하루 1~3개, 시험 전날 총정리 포함). 파서: 펜스 제거→JSON.parse→day 형식·범위 검증. 도구 없음, maxTurns 1.

**라우트 (src/wrong.ts, src/exams.ts, index.ts 마운트):**
- `GET /api/subjects/:id/wrong` — questions WHERE wrong_count>0 ORDER BY wrong_count DESC (전체 필드 + from_wrong_note)
- `POST /api/subjects/:id/wrong/extract` — multipart file(image/pdf, 기존 검증 재사용) → FileStore(`wrong/` prefix) → extractQuestionsFromFile → insert (source='uploaded', from_wrong_note=1, **wrong_count=1**) → {added}. usage guard.
- `POST /api/subjects/:id/wrong/analyze` — 오답 0개면 400, usage guard → {analysis}
- 기존 `GET /api/subjects/:id/quiz` 에 `wrong=1` 파라미터 추가 → WHERE wrong_count>0 추가
- `POST /api/subjects/:id/exams` — {title, exam_date, scope?}: 형식 검증(YYYY-MM-DD, 오늘 이후), usage guard → 계획 생성(자료 제목 목록 + 오답 요약 통계 전달) → exam+items insert → 전체 반환
- `GET /api/subjects/:id/exams` — 시험 목록 + 각 items + done 카운트
- `PATCH /api/plan-items/:id` — {done: boolean} 토글
- `POST /api/exams/:id/replan` — usage guard. 오늘 이후 & 미완료 items 삭제 → 남은 기간 기준 재생성(완료 항목 요약을 프롬프트에 전달) → 갱신된 exam 반환
- `DELETE /api/exams/:id` — items까지 삭제

**테스트 (vi.mock, 기존 패턴):** wrong 목록/등록(wrong_count=1)/analyze 400·200, quiz wrong=1 필터, exam 생성(items 저장)·형식 검증 400·목록·토글·replan(완료 항목 유지)·삭제.

## Task W2: 프론트엔드

- SubjectDetail 탭: **채팅 | 퀴즈 | 오답 | 시험 | 노트** (단권화 노트 → "노트"로 축약)
- `Wrong.tsx`: 오답 목록(문제 ellipsis·클릭 확장(정답/해설)·틀린 횟수·'시험 등록' 배지·삭제), [오답 사진·PDF 등록](추출 중 표시), [약점 분석](결과 마크다운 렌더, 진행 표시), [오답만 다시 풀기] → 퀴즈 탭으로 전환+즉시 wrong-only 퀴즈 시작 (SubjectDetail에서 콜백/상태로 연결, Quiz에 initialWrongOnly 전달)
- `Quiz.tsx`: 시작 컨트롤에 "오답만" 체크박스(wrong=1), 외부에서 wrong-only 즉시 시작 지원
- `Exam.tsx`: 시험 카드 목록(제목·D-day·범위·진도 bar), [시험 추가] 폼(제목/날짜 date input/범위 textarea → 생성, "계획 생성 중..." 표시), 상세: 날짜별 그룹 체크리스트(오늘 강조, 지난 날짜 흐리게, 체크 토글), [계획 조정](replan confirm), [삭제]
- api.ts에 대응 함수 추가. 스타일은 기존 시스템 재사용(D-day는 시안 글로우 크게).

**검증:** tsc, build:web, vitest 전체. 커밋 태스크당 1개(한국어).
