# StudyWork 2단계: 퀴즈 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 기존 코드베이스 패턴(어댑터·라우트·테스트 헬퍼)을 따른다.

**Goal:** 업로드한 문제(사진/PDF에서 추출) 또는 AI 생성 문제로 퀴즈를 풀고, 채점·해설·오답 가중 반복·인쇄(PDF 저장)까지 지원.

**Architecture:** 기존 로컬 Node 서버에 questions 테이블 + quiz 라우트 추가. 문제 추출·생성은 Claude Agent SDK가 strict JSON으로 출력 → 서버가 파싱·저장. 채점은 서버에서. PDF 내보내기는 인쇄용 뷰(브라우저 인쇄 → PDF 저장).

**Spec:** `docs/superpowers/specs/2026-07-08-studywork-design.md` 2단계 섹션

---

## Task Q1: DB + 문제 추출·생성 (백엔드)

**Files:** Create `migrations/0003_questions.sql`, `src/quiz.ts`; Modify `src/claude.ts`, `src/index.ts`; Create `test/quiz.test.ts`

**Migration:**
```sql
CREATE TABLE questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('uploaded','generated')),
  qtype TEXT NOT NULL CHECK (qtype IN ('mcq','short','ox')),
  difficulty TEXT NOT NULL CHECK (difficulty IN ('하','중','상')),
  question TEXT NOT NULL,
  choices TEXT,
  answer TEXT NOT NULL,
  explanation TEXT NOT NULL DEFAULT '',
  correct_count INTEGER NOT NULL DEFAULT 0,
  wrong_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**claude.ts 추가:**
- JSON 배열 파서 헬퍼(마크다운 펜스 제거, 첫 `[`~마지막 `]` 추출, JSON.parse, 각 항목 검증: qtype/difficulty enum, mcq는 choices 배열 필수)
- `extractQuestionsFromFile(absPath, kind)` — Read 툴로 파일을 읽고 문제·선택지·정답·해설을 JSON 배열로 출력 (정답이 자료에 없으면 스스로 풀어서 채움, 난이도 자동 태깅). allowedTools ["Read"], maxTurns 16
- `generateQuestions(subjectName, materials, count, difficulty)` — 자료 기반 생성, qtype 골고루(mcq 위주), JSON 배열 출력. 도구 없음, maxTurns 1

**src/quiz.ts 라우트 (usage guard는 AI 호출 라우트에만):**
- `GET /api/subjects/:id/questions?source=&difficulty=` — 목록 (answer/explanation 포함 — 문제 은행·인쇄용)
- `POST /api/subjects/:id/questions/extract` — multipart file(image/pdf, 기존 크기 제한 재사용) → FileStore(`questions/` prefix) 저장 → 추출 → insert → `{added}`
- `POST /api/subjects/:id/questions/generate` — `{count(1~20), difficulty('하'|'중'|'상'|'혼합')}` → 자료 필요(없으면 400) → 생성 → insert → `{added}`
- `GET /api/subjects/:id/quiz?source=all|uploaded|generated&difficulty=all|하|중|상&count=N` — 출제: `ORDER BY (wrong_count > correct_count) DESC, RANDOM() LIMIT N` (오답 가중). answer/explanation 제외하고 반환
- `POST /api/questions/:id/answer` — `{answer}` → 정규화 비교(트림·소문자, mcq는 보기 텍스트 또는 인덱스 허용, ox는 O/X·o/x·맞다/틀리다 정규화) → counts 갱신 → `{correct, answer, explanation}`
- `DELETE /api/questions/:id`

**테스트 (vi.mock으로 AI 모킹, 기존 helpers 사용):** 생성 라우트 → 저장 확인, 퀴즈 출제(개수·필터·answer 미포함), 채점(정답/오답, counts 증가, ox 정규화), 자료 없이 generate 400, 삭제.

## Task Q2: 퀴즈 프론트엔드

**Files:** Create `web/src/pages/Quiz.tsx`; Modify `web/src/pages/SubjectDetail.tsx`(퀴즈 탭 추가), `web/src/api.ts`, `web/src/styles.css`

- SubjectDetail에 세 번째 탭 "퀴즈" → `<Quiz subject={subject} />`
- **은행 뷰(기본):** 문제 수 요약(출처·난이도별), 컨트롤(출처 select, 난이도 select, 개수 input, [퀴즈 시작]), 문제 추가 영역([문제 사진·PDF 업로드], [AI 생성] — 개수·난이도 선택 후 실행, 진행중 표시), 문제 목록(체크박스, 유형·난이도·정답률 표시, 선택 삭제, [문제지 인쇄] [정답지 인쇄])
- **플레이어 뷰:** 진행 표시(i/N), 문제, mcq=보기 버튼 / short=입력 / ox=O·X 버튼, [확인] → 정오 표시+정답+해설, [다음] → 끝나면 요약(맞춘 수/총, [다시], [은행으로])
- **인쇄:** 선택 문제(없으면 전체)로 새 창에 인쇄용 HTML(밝은 배경, 문제지=문제+보기만/정답지=정답+해설) 생성 → window.print() — 브라우저에서 PDF 저장
- 스타일은 기존 디자인 시스템(.card 글로우, 시안/민트) 재사용. 모바일에서도 동작.

**검증:** tsc, build:web, vitest 전체 통과. 커밋은 태스크당 1개(한국어).
