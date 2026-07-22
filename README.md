# StudyWork

수업 자료를 올리면 AI가 읽고 정리해 주는 **1인용 학습 비서 웹 앱**.

사진·PDF·텍스트로 자료를 쌓으면 그 자료를 근거로 답하는 튜터 채팅, 자료 전체를 하나로 합치는 단권화 노트, 문제 추출·생성·채점·오답 관리·시험 계획까지 제공한다. 내 맥에서 로컬 Node 서버로 동작하며, 기본 AI는 저장된 ChatGPT 로그인을 재사용하는 **로컬 Codex CLI의 `gpt-5.6-sol`**이다. API 키는 필요 없다.

> 이 문서는 사용자용 안내이자, 이후 세션의 개발자(AI 포함)가 코드베이스를 정확히 이해하기 위한 기준 문서다. 마지막 갱신: 2026-07-20.

---

## 목차

1. [기능](#기능)
2. [아키텍처](#아키텍처)
3. [설치·실행](#설치실행)
4. [접속 (폰·아이패드·외부)](#접속)
5. [저장소 구조](#저장소-구조)
6. [API 레퍼런스](#api-레퍼런스)
7. [DB 스키마](#db-스키마)
8. [AI 호출 설계 (src/claude.ts)](#ai-호출-설계)
9. [테스트](#테스트)
10. [프론트엔드](#프론트엔드)
11. [중요한 설계 결정과 함정 (다음 세션 필독)](#중요한-설계-결정과-함정)
12. [문서·이력](#문서이력)

---

## 기능

과목을 만들면 과목 상세에 6개 탭이 있다: **채팅 | 퀴즈 | 해설 | 시험 | 노트 | 설정**. 오답 목록·분석·다시 풀기는 퀴즈 탭 상단의 **문제 은행 / 오답 노트** 토글 안에 있다.

| 탭 | 내용 |
|---|---|
| (사이드바) **자료** | 사진(필기·프린트·교과서)·PDF·직접 입력 텍스트 업로드. 사진/PDF는 AI가 전체 내용을 텍스트로 추출해 DB에 저장(상태: processing→ready/error, 실패 시 재시도 버튼). 이 추출 텍스트가 채팅·단권화·문제 생성의 컨텍스트가 된다 |
| **채팅** | 과목 자료를 신뢰하지 않는 사용자 입력 JSON으로 전달하는 튜터 채팅(출처 자료 제목 표시). 자료 본문은 퀴즈 생성과 같은 **96k 문자 예산**으로 자료별 균등 발췌해 주입하고, 입력창 위 **채팅 컨텍스트** 선택으로 자료 범위를 좁힐 수 있다(기본 전체, 과목별 localStorage 영속). 고정 안전 규칙과 허용 Skill만 system/developer 지침에 둔다. 입력창 위 토글로 **자료 기반 / 일반 질문** 모드 전환 — 일반 질문은 자료 없이 일반 지식으로 답변. 대화는 DB에 저장, 최근 30개가 컨텍스트로 전달됨 |
| **퀴즈** | 문제 은행: 문제집·프린트 사진/PDF에서 **문제 추출** 또는 선택 자료 기반 **AI 생성**(개수 1~20, 난이도 하/중/상/혼합). 자료 전체·자료별 전체·개별 문제로 범위를 고른 뒤 난이도·출처·개수·오답 필터와 교차해 단일 **퀴즈 시작** 버튼으로 출제한다. AI 생성은 백그라운드 작업이라 다른 탭에서도 계속되며, 독립 검산과 엄격한 구조·논리 검증을 통과한 문제만 작업 완료 상태와 한 트랜잭션으로 저장한다. 문제 선택 후 **문제지/정답지 인쇄** 가능 |
| **해설** | 기존 문제집 선택 → 같은 책의 공식 해설 PDF/이미지 업로드. 단일 문제 원본과 1번부터 연속된 전체 해설지만 지원하며, 6쪽 청크로 읽은 뒤 문항 수·인쇄 번호·정답 순서가 모두 맞을 때만 빈 해설을 한 트랜잭션으로 채운다. 하나라도 다르면 기존 문제를 바꾸지 않는다 |
| **오답** (퀴즈 탭 안 "오답 노트" 뷰) | 퀴즈에서 틀린 문제 자동 축적(wrong_count>0). 목록은 문제·정답·해설·정오 횟수·마지막 시도 시각(`last_attempted_at`)을 펼쳐 보여준다. 학교 시험지·문제집 사진으로 **오답 직접 등록**(from_wrong_note=1, wrong_count=1로 삽입 — 사진 원본은 추출 후 삭제되므로 별도 보관 안 함), **약점 분석**(AI가 오답 패턴 요약, 저장 안 함), **틀린 문제 바로 풀기**(문제 은행 뷰로 전환 후 오답만 즉시 출제). 퀴즈 결과 화면에는 이번 세션에서 틀린 바로 그 문제들만 재출제하는 **틀린 것만 다시** 버튼이 있다 |
| **시험** | 시험 제목·날짜·범위 입력 → AI가 오늘~시험일 날짜별 공부 계획 생성. 생성·계획 조정은 백그라운드 작업이라 다른 탭에서도 계속되며, 시험·TODO·작업 완료 상태를 한 트랜잭션으로 저장한다. D-day·진도바, 날짜별 체크리스트, 완료 항목·지난 날짜를 보존하는 **계획 조정**, 삭제 지원 |
| **노트 (단권화)** | 선택 자료의 고유 시험 개념·공식·정의·함정·풀이 팁을 중복 없이 압축한 마크다운 노트. 출처 목록은 넣지 않는다. 소스가 많아져도 검색·스크롤 체크 목록·검색 결과 전체 선택/해제로 고르며, 기본은 전체 포함이다. 서로 다른 과목은 동시에 단권화할 수 있고, 긴 단권화 하나는 AI 슬롯을 최대 2개만 쓴다. 자연어 추가 요청, 직접 편집·저장, 버전 기록 지원 |

공통: 비밀번호 1개 인증(HMAC 토큰 쿠키, 90일), AI 호출 하루 200회 상한(`usage_daily` 카운터).

## 아키텍처

```
폰/PC/아이패드 브라우저 (React + Vite SPA, web/dist)
   │  같은 와이파이(http://<맥IP>:8787) 또는 Tailscale(http://100.x.x.x:8787)
   ▼
내 맥의 Node 서버 — src/server.ts (Hono, 0.0.0.0:8787)
   ├─ SQLite  : data/studywork.db  (better-sqlite3, D1 호환 어댑터 src/localdb.ts)
   ├─ 파일    : data/files/        (R2 호환 어댑터 src/filestore.ts)
   └─ AI facade (src/claude.ts)
        ├─ 기본: 로컬 Codex CLI adapter (src/codex-provider.ts)
        │    └─ 저장된 ChatGPT 로그인 · gpt-5.6-sol · effort=high
        ├─ 허용된 전역 Skill 지침 로더 (src/skills.ts)
        └─ 설정 기반 롤백: Claude Agent SDK + 로컬 claude CLI
```

**이력**: 처음에는 Cloudflare Workers + D1 + R2 + Claude API로 구현했다가(git 히스토리 `f10d26a`~`584c470`), 사용자가 Max 플랜 구독자라 API 종량 과금을 피하려고 **로컬로 전환**했다(`2ac9ffd`~). 이때 라우트 코드를 유지하기 위해 D1/R2의 API 표면을 흉내 내는 어댑터를 만들었다 — 라우트는 여전히 `c.env.DB.prepare(...).bind(...).first()` / `c.env.FILES.put(...)` 형태로 동작하므로, 클라우드로 되돌리려면 어댑터만 갈아끼우면 된다.

## 설치·실행

**요구사항**
- Node 20.12+ (`process.loadEnvFile` 사용)
- Codex CLI 설치 및 ChatGPT 로그인(`codex login status`)
- PDF 분석용 `pdftoppm`(Homebrew `poppler`)
- 선택 사항: `claude-cli` 롤백을 사용할 때만 Claude Code CLI 설치·로그인 필요

```bash
npm install
cp .env.example .env    # 비밀번호·서명 키를 .env에만 입력
npm start               # = build:web + tsx src/server.ts
```

- 개발: `npm run dev` (tsx watch — 백엔드만 자동 재시작. **프론트 수정은 `npm run build:web` 후 새로고침**, `npm start`는 watch가 아니므로 백엔드 수정 시 재시작 필요)
- 테스트: `npm test` (vitest 전체 suite)
- 서버 시작 시 로컬/LAN 주소가 출력된다. 데이터는 `./data`(env `DATA_DIR`) — 백업은 이 폴더만 복사

### AI 설정

API 키 대신 로컬 Codex CLI에 저장된 ChatGPT 로그인을 재사용한다. 모델과 effort는 과목 화면의 **설정** 탭에서 공통 기본값 또는 작업별 버튼으로 저장한다. 기본값은 `gpt-5.6-sol` / `high`다.

```dotenv
STUDYWORK_AI_PROVIDER=codex-cli
STUDYWORK_AI_MODEL=gpt-5.6-sol
STUDYWORK_AI_REASONING_EFFORT=high
```

`STUDYWORK_AI_MODEL`과 `STUDYWORK_AI_REASONING_EFFORT`는 기존 설치의 최초 fallback이다. 설정 탭에서 저장한 DB 값이 있으면 그 값이 우선한다.

- 기본 보호값은 타임아웃 300초, 동시 요청 4개다. 동시 슬롯 중 1개는 대화형(채팅) 전용 예약 — 추출·단권화 같은 배치 작업은 최대 3개까지만 점유하므로 채팅이 큐에서 굶지 않는다. Codex adapter 자체는 자동 재시도하지 않으며, 기존 문제 추출 작업의 제한된 재시도만 유지한다.
- 각 호출은 `codex exec --ephemeral` 일회성 세션이다. 사용자 config/rules, 웹, 앱, 멀티에이전트, shell 도구를 끄고 구조화 응답은 기존 strict JSON Schema와 도메인 파서로 다시 검증한다.
- 프롬프트는 stdin, 결과는 전용 출력 파일로만 전달한다. StudyWork 비밀번호·세션 키·API 키 환경변수는 child process에 넘기지 않는다.
- 이미지는 opaque 임시 이름으로 복사한다. PDF는 기존 6쪽 구간을 `pdftoppm`으로 PNG화한 뒤 이미지로 첨부하며, 원본 경로를 모델 프롬프트에 넣지 않는다.
- launchd PATH에서 Codex를 찾지 못하면 `~/.local/bin/codex`를 자동 사용한다. 다른 위치만 `STUDYWORK_CODEX_BIN` 절대 경로로 지정한다.

긴급 롤백은 `.env`에서 아래처럼 provider만 바꾸고 서버를 재시작한다. 이 경로는 로컬 `claude` CLI의 로그인 상태에 의존한다.

```dotenv
STUDYWORK_AI_PROVIDER=claude-cli
```

### Obsidian 연동 (선택)

`.env`의 `OBSIDIAN_VAULT_PATH`에 볼트 절대 경로를 설정하면 완료된 StudyWork 단권화 노트를 Obsidian에 내보낼 수 있다.

```dotenv
OBSIDIAN_VAULT_PATH="/absolute/path/to/My Vault"
OBSIDIAN_WRITE_ENABLED=false
```

- `OBSIDIAN_WRITE_ENABLED=true`일 때만 완료된 현재 단권화 노트를 새 `.md` 파일로 내보낸다.
- 내보내기는 create-only 원자 저장이다. 같은 경로가 이미 있으면 `409`로 중단하며 기존 볼트 파일을 덮어쓰지 않는다.
- Obsidian 노트를 StudyWork 자료로 가져오는 UI와 API는 제공하지 않는다.

### Skills 연동

StudyWork는 사용자 전역 `~/.codex/skills`에서 표준 `SKILL.md`를 발견하고, 개발자가 허용한 Skill의 지침을 provider와 무관하게 AI 요청에 주입한다. 기본 활성 Skill은 `learning-material-analysis`, `grounded-study-notes`다. 두 Skill은 Codex 전역 폴더에 설치되므로 StudyWork 밖의 다른 프로젝트에서도 발견·사용할 수 있다.

- `GET /api/skills`: 발견·활성·로딩 오류 수와 Skill 메타데이터 확인
- `STUDYWORK_ENABLED_SKILLS`: 활성 이름을 쉼표로 지정
- `STUDYWORK_SKILLS_DIRS`: 추가 검색 루트를 macOS/Linux 경로 구분자 `:`로 지정
- StudyWork 연동은 **instruction-only**다. 로더는 64KB 이하의 `SKILL.md` 지침만 읽고 symlink 탈출·중복 이름·잘못된 frontmatter를 거부하며, Skill의 스크립트나 shell/network 권한은 자동 실행하지 않는다. Codex에서는 같은 전역 Skill을 Codex의 정상 Skill 흐름으로 사용할 수 있다.

**AI가 안 될 때**: `codex login status`, `codex --version`, `pdftoppm -v`를 확인한다. 테스트 mock 성공은 실제 ChatGPT 로그인·모델 접근을 증명하지 않으므로 배포 후 최소 로컬 CLI 호출을 별도로 확인한다. `claude-cli` 롤백 중이라면 `claude` CLI 로그인 상태를 확인한다.

## 접속

- 맥: <http://localhost:8787>
- 같은 와이파이: `http://<맥IP>:8787` (서버 시작 로그에 출력)
- 외부: 맥·폰·아이패드에 [Tailscale](https://tailscale.com) 설치, 같은 계정 로그인 → `http://<맥의 Tailscale IP>:8787`
- iOS/iPadOS: Safari 공유 → "홈 화면에 추가"로 앱처럼 사용
- 제약: **맥이 켜져 있고 서버가 실행 중**이어야 함. 데이터 원본이 서버 한 곳이므로 기기 간 동기화는 자동

## 저장소 구조

```
src/
  server.ts       Node 엔트리: .env 로드, DB/FileStore 생성+마이그레이션, 정적 서빙(SPA fallback), 0.0.0.0 바인딩, LAN 주소 출력
  index.ts        Hono 앱 조립: Env 타입, /api/health, /api/login, 인증 미들웨어, 라우트 마운트. 프론트가 의존하는 유일한 계약면
  auth.ts         HMAC-SHA256 토큰(만료타임스탬프.서명), issueToken/verifyToken/authMiddleware
  localdb.ts      better-sqlite3 → D1 호환 어댑터 (prepare/bind/first/all/run/batch, _migrations 테이블로 마이그레이션 추적)
  filestore.ts    로컬 폴더 → R2 호환 어댑터 (put/get/delete + absolutePath, ".." 키 거부, contentType은 .meta.json 사이드카)
  claude.ts       도메인 AI facade와 프롬프트, provider 선택/롤백
  markdown.ts     Markdown 표 안 LaTeX 수직선 충돌 정규화(저장·화면·HTML 공용)
  codex-provider.ts 로컬 Codex CLI adapter(격리·PDF 이미지화·취소·동시성·응답 검증)
  skills.ts       전역 SKILL.md 발견·검증·허용 목록·instruction 주입
  usage.ts        하루 호출 상한 (DAILY_LIMIT=200, 원자적 UPDATE...RETURNING)
  subjects.ts     과목 CRUD (삭제는 messages→materials→subjects 명시적 배치 삭제 — CASCADE 의존 금지)
  upload.ts       실제 magic byte/PDF 구조·암호화·페이지·크기 검증, SHA-256 계산
  materials.ts    자료 업로드/페이지별 추출/재시도/삭제 (이미지 30MiB, PDF 200MiB·500쪽 제한)
  chat.ts         튜터 채팅 (mode=general 지원)
  consolidate.ts  단권화 생성(instructions 지원) + 노트 GET/PUT
  quiz.ts         문제 추출/생성/은행 목록/출제(wrong=1 필터)/채점/삭제
  wrong.ts        오답 목록/사진 등록/약점 분석
  exams.ts        시험 생성(계획 생성)/목록/체크 토글/replan/삭제
migrations/       순차 DB 변경(현재 0026까지): 기본 자료/노트/문제/시험, 작업 재시도·멱등성, AI 작업 설정, 추출 청크 체크포인트, 지속 AI 작업
test/             vitest(node 환경). helpers.ts의 makeEnv()(인메모리 DB+임시 FileStore)와 call()로 app.fetch 직접 호출. AI는 vi.mock("../src/claude")
web/
  vite.config.ts  root=web, outDir=dist, dev proxy /api→8787
  src/api.ts      타입드 fetch 래퍼. 401 → "sw:auth-expired" 이벤트 + AuthError
  src/App.tsx     인증 게이트(마운트 시 subjects 프로브), 상태 기반 라우팅, 글로우 카드 마우스 추적(문서 레벨 리스너)
  src/Sky.tsx     캔버스 별밭 배경(별 150·성운·유성·패럴랙스)
  src/pages/      Login, Subjects(글로우 카드 그리드), SubjectDetail(탭 컨테이너+자료+채팅+노트), Quiz, Wrong, Exam
  src/styles.css  디자인 시스템 전체 (아래 "프론트엔드" 참조)
docs/superpowers/ specs(설계서·UI 목업), plans(구현 계획 3개)
```

## API 레퍼런스

모든 /api/* 는 쿠키 인증 필요(예외: /api/login, /api/health). 인증 실패 401 `{error}`. AI 호출 라우트(⚡)는 usage guard(429) + 실패 시 502.

| 메서드·경로 | 요청 | 응답 |
|---|---|---|
| POST /api/login | `{password}` | 200 + Set-Cookie `sw_token`(HttpOnly, SameSite=Strict, **Secure 없음** — 평문 http 서빙 때문) / 401 |
| GET /api/subjects | | `[{id,name,color,material_count,created_at}]` |
| POST /api/subjects | `{name,color?}` | 201 `{id}` |
| DELETE /api/subjects/:id | | 관련 messages/materials까지 삭제 |
| GET /api/subjects/:id/materials | | 목록(추출 텍스트 제외) |
| POST /api/subjects/:id/materials ⚡(파일일 때만) | multipart `title`+(`file`\|`text`) | 201 `{id,status}` — text는 AI 호출 없이 즉시 ready |
| POST /api/materials/:id/retry ⚡ | | `{id,status}` |
| GET /api/materials/:id | | 전체 행(extracted_text 포함) |
| DELETE /api/materials/:id | | R2/파일도 삭제 |
| GET /api/subjects/:id/messages | | 대화 기록 |
| POST /api/subjects/:id/chat ⚡ | `{message, mode?: "materials"\|"general", materialIds?: number[]}` | `{reply}` — 자료 본문은 96k 예산으로 자료별 균등 발췌, materialIds 생략 시 전체 |
| POST /api/subjects/:id/consolidate ⚡ | `{instructions?, materialIds?, bookIds?}` | 202 `{status:"processing"}` — 노트 상태 폴링, 버전 누적 |
| GET /api/subjects/:id/note | | `{content,updated_at}` / 404 |
| PUT /api/subjects/:id/note | `{content}` | 수동 편집 저장 |
| GET /api/subjects/:id/questions | `?source=&difficulty=` | 전체 행(정답·해설 포함, choices는 **배열로 파싱돼** 반환) |
| GET /api/subjects/:id/books | | 문제집·파일 상태·전체 문제 수·해설 보유 문제 수 |
| POST /api/subjects/:subjectId/books/:bookId/explanations ⚡ | multipart `file` | 202 `{jobId,status}` — 전체 순서 검증 후 빈 해설 원자 추가 |
| POST /api/subjects/:id/questions/extract ⚡ | multipart `file` | 201 `{added}` |
| POST /api/subjects/:id/questions/generate ⚡ | `{count:1-20, difficulty:"하"\|"중"\|"상"\|"혼합", materialIds:[...]}` | 202 `{jobId,status}` — 선택 자료 기반 백그라운드 생성 |
| GET /api/ai-jobs/:id | | `{id,subject_id,kind,status,result,error,...}` — 문제·시험 TODO 작업 상태 |
| GET /api/subjects/:id/quiz | `?source=all\|uploaded\|generated &difficulty=all\|하\|중\|상 &count=1-50 &wrong=1` | 출제 목록(**정답·해설 제외**), SRS-lite 정렬: 오답 우세 우선 → 오래 안 본 순(`question_attempts` MAX(created_at), 미시도=가장 오래된 취급) → RANDOM() 타이브레이크 |
| POST /api/questions/:id/answer | `{answer}` (빈 문자열 400) | `{correct,answer,explanation}` + counts 갱신 |
| DELETE /api/questions/:id | | |
| GET /api/subjects/:id/wrong | | wrong_count>0 문제, 많이 틀린 순, `last_attempted_at` 포함(시도 없으면 null) |
| POST /api/subjects/:id/wrong/extract ⚡ | multipart `file` | 201 `{added}` — wrong_count=1, from_wrong_note=1 |
| POST /api/subjects/:id/wrong/analyze ⚡ | | `{analysis}` (마크다운, 저장 안 함) — 오답 없으면 400 |
| POST /api/subjects/:id/exams ⚡ | `{title, exam_date:"YYYY-MM-DD"(오늘 이후·실존 날짜), scope?}` | 202 `{jobId,status}` — TODO 계획 백그라운드 생성 |
| GET /api/subjects/:id/exams | | `[{..., items:[{id,day,task,done}], done_count}]` |
| PATCH /api/plan-items/:id | `{done:boolean}` | |
| POST /api/exams/:id/replan ⚡ | | 202 `{jobId,status}` — 완료(done=1)·과거(day<오늘) 항목 유지, 나머지 백그라운드 재생성 |
| DELETE /api/exams/:id | | items까지 삭제 |

**채점 규칙**(quiz.ts `gradeAnswer`): 공통 정규화 = trim+소문자+연속공백 압축. ox는 o/맞다/참/true/yes/1 ↔ x/틀리다/거짓/false/no/0 매핑. mcq는 **텍스트 일치 우선, 그다음 1-based 인덱스** 해석(보기가 숫자 문자열일 때 오채점 방지 — 회귀 테스트 있음).

## DB 스키마

`migrations/*.sql`을 파일명 순으로 적용, `_migrations` 테이블로 추적(서버 시작 시 자동).

- `subjects(id, name, color, created_at)`
- `materials(..., kind, title, original_filename, r2_key, extracted_text, status, error, content_hash, page_count, extraction_method, ocr_used, source_type/source_path, ...)`
- `messages(id, subject_id, role:user|assistant, content, created_at)`
- `usage_daily(day PK, calls)`
- `notes(subject_id PK, content, updated_at)` — 과목당 1개, upsert
- `questions(id, subject_id, source:uploaded|generated, qtype:mcq|short|ox, difficulty:하|중|상, question, choices(JSON문자열|NULL), answer, explanation, correct_count, wrong_count, from_wrong_note, created_at)`
- `books` / `book_files(..., content_hash, page_count, status, error, progress)` / `book_items(..., page, has_figure, figure_box)` — 문제 추출 원본과 페이지 근거
- `exams(id, subject_id, title, exam_date, scope, ai_job_id, created_at)` / `plan_items(id, exam_id, day, task, done)`
- `ai_jobs(id, subject_id, kind, status, result, error, created_at, updated_at)` — 탭 이동과 분리된 AI 작업 상태

주의: better-sqlite3에서 FK CASCADE를 신뢰하지 않는다(초기 miniflare 시절의 결정이지만 유지) — 삭제는 항상 명시적으로 자식부터.

## AI 호출 설계

`src/claude.ts`는 기존 도메인 함수와 프롬프트 계약을 유지하는 facade다. 기본 경로는 `src/codex-provider.ts`의 로컬 Codex CLI adapter이며, `STUDYWORK_AI_PROVIDER=claude-cli`일 때만 격리된 Claude CLI 경로로 전환한다. 파일 분석은 검증한 업로드 파일 하나만 이미지 입력으로 허용하고, 모델 도구는 노출하지 않는다. `src/skills.ts`는 사용자 전역 Skill을 발견하되 명시적으로 활성화된 `SKILL.md` 지침만 provider-neutral 방식으로 추가한다.

| 함수 | Codex 입력 | 용도 |
|---|---|---|
| `extractFromFile(absPath, kind, ..., source)` | 검증된 PDF/이미지 + 페이지 JSON Schema | 자료 사진/PDF → 페이지 누락·중복·범위 검증 → 원본 파일명·페이지·청크·추출 방식을 포함한 전체 전사(구조·표·수식 보존) |
| `chat(subject, materials, history, general)` | 텍스트 | 고정 지침과 자료/대화를 역할 분리. 자료·대화는 신뢰하지 않는 사용자 JSON으로 전달 |
| `consolidate(subject, materials, instructions?)` | 텍스트 | 중복·출처 표기를 제거한 단권화 노트(마크다운, 공식 박스용 display 수식·표 수식 정규화) |
| `extractQuestionsFromFile(absPath, kind)` | 검증된 PDF/이미지 + JSON Schema | 문제 배열 추출(정답 없으면 AI가 풀어서 채움) → 도메인 파서 재검증 |
| `generateQuestions(subject, materials, count, diff)` | 선택 자료의 균등 발췌 + JSON Schema | 크기 제한 근거로 생성 → 독립 검산 → 난이도·정답 유일성·자급형 도형 검증 및 재시도 |
| `analyzeWrongQuestions(subject, wrongs)` | 텍스트 | 오답 패턴·약점 분석 마크다운 |
| `generateStudyPlan(subject, title, examDate, today, scope, titles, wrongSummary)` | 텍스트 + JSON Schema | `[{day,task}]` 계획 생성 → 날짜 형식·범위 재검증 |

JSON 파서(`parseQuestionsJson`/`parsePlanJson`)는 마크다운 펜스 제거 → 첫 `[`~마지막 `]` 슬라이스 → JSON.parse → 항목별 검증(한국어 에러). **export되어 있고 vi.mock 없는 별도 테스트 파일에서 유닛 테스트됨**.

Codex 경로는 FileStore에서 검증한 이미지 또는 PDF를 작업별 임시 폴더에 격리한다. PDF는 PNG 페이지로 변환해 모델 도구 없이 첨부한다. 페이지 전사는 모든 요청 페이지가 정확히 한 번 들어왔을 때만 성공하며, 빈 페이지도 명시적으로 보존한다. `ocr_used`는 이미지면 vision, PDF면 페이지 이미지 분석이므로 `NULL`로 둔다. `claude-cli` 롤백 경로만 `FILES.absolutePath(key)`로 얻은 정확한 단일 파일을 격리된 Read 도구에 허용한다.

## 테스트

- 일반 node 환경 vitest. `test/helpers.ts`: `makeEnv()`(인메모리 LocalDB+마이그레이션+임시 FileStore), `call(env, path, init)` = `app.fetch(new Request("https://x"+path), env)`.
- AI는 `vi.mock("../src/claude", () => ({...모든 export...}))`로 통째 모킹 — **모듈 전체가 대체되므로 새 export를 추가하면 기존 mock 팩토리에도 추가**해야 로드 타임 에러를 피한다(현재는 라우트가 호출할 때만 참조해서 대부분 무해).
- 파서(claude-parse/plan-parse)는 mock 없는 별도 파일에서 실제 구현을 테스트.
- Codex adapter 테스트는 가짜 child process로 stdin·최소 환경·JSON Schema·PDF 이미지화·이미지 격리·인증/한도 오류·취소를 검증한다. `npm test`는 실제 Codex를 호출하지 않는다.
- 실제 CLI 검증은 저장된 ChatGPT 로그인으로 최소 smoke test를 따로 실행한다. mock 통과를 실제 로그인 성공으로 보고하지 않는다.
- 히스토리: Cloudflare 시절 `@cloudflare/vitest-pool-workers`를 썼고, vitest 4 버전에선 `fetchMock`이 제거되고 `vi.mock`이 SELF 워커에 안 먹혀서 miniflare `fetchMock` 옵션으로 우회했었다 — 로컬 전환 후 이 문제는 전부 사라짐(같은 모듈 그래프).

## 프론트엔드

- 디자인 시스템: 다크 잉크(#060a13) + 시안(#6cd8ff)/민트(#7ef0c3), 제목 Gowun Batang·본문 Pretendard(CDN), 캔버스 별밭 배경, 필름 그레인, **마우스 위치 추적 글로우 보더 카드**(`.card::before` mask-composite + `--mx/--my`를 문서 레벨 mousemove에서 주입). 기준 목업: `docs/superpowers/specs/mockups/studywork-tabs-v3.html`. 카피 톤: 건조하게 수치·사실만.
- 라우팅 없음(상태 기반), 상태 라이브러리 없음. 의존성은 react/marked뿐.
- 패턴: 모든 장시간 비동기에 `mountedRef` 가드, 401은 api.ts가 `sw:auth-expired` 이벤트 발행→App이 로그인 화면 복귀, 채팅은 낙관적 메시지+실패 롤백, 계획 체크는 낙관적 토글+실패 롤백.
- 마크다운 렌더: 표 안 `$|v|$` 같은 수직선을 먼저 안전한 LaTeX로 정규화하고, `marked.parse` 결과를 공통 DOMPurify 경계에서 정화한다. 앱과 HTML 다운로드 모두 display MathML 공식 박스·간격과 소단원 구분선을 같은 방식으로 표시한다.
- 오답→퀴즈 연동: SubjectDetail의 `wrongKick` 카운터 증가 → Quiz의 `kickWrongQuiz` prop effect가 wrong-only 퀴즈 즉시 시작.

## 중요한 설계 결정과 함정

다음 세션에서 코드를 만지기 전에 알아야 할 것들:

1. **어댑터 계약을 깨지 말 것** — 라우트는 D1/R2 API 표면(`prepare().bind().first/all/run`, `batch`, `put/get/delete`)만 사용한다. localdb/filestore에 없는 메서드를 라우트에서 쓰면 클라우드 복귀 옵션이 죽는다.
2. **AI 인증과 provider를 혼동하지 말 것** — 기본 경로는 API 키가 아니라 Codex CLI의 저장된 ChatGPT 로그인과 모델 접근 권한을 사용한다. CLI에는 Responses API의 `reasoning.mode=pro` 옵션이 없고 effort만 지정한다. Claude CLI 로그인은 `STUDYWORK_AI_PROVIDER=claude-cli` 롤백에서만 사용한다.
3. **날짜는 전부 로컬 기준 문자열(YYYY-MM-DD) 비교** — `toISOString()`은 UTC라 KST 자정~09시에 하루 밀린다. exams.ts·Exam.tsx의 `todayStr()`이 로컬 컴포넌트 조립인 이유. 새 날짜 코드도 같은 방식으로.
4. **questions.choices는 DB에 JSON 문자열, API 응답에선 배열** — 라우트가 파싱해서 내보낸다. 새 라우트 추가 시 동일하게.
5. **채점은 텍스트 일치 우선 → 인덱스** 순서 고정(회귀 테스트 있음). 순서 바꾸면 숫자 보기 문제에서 오채점.
6. **replan 시멘틱**: done=1 또는 day<오늘 항목은 보존, 나머지 삭제 후 재생성. 완료 요약은 scope에, 오답 통계는 wrongSummary에 — 섞으면 계획 품질 저하(과거에 낸 버그).
7. **쿠키에 Secure를 다시 넣지 말 것** — 평문 http(LAN/Tailscale)로 서빙되므로 넣는 순간 로그인이 안 된다.
8. **서버 코드 수정 후엔 재시작 필요** — `npx tsx src/server.ts`는 watch가 아님. 프론트 수정은 `npm run build:web` 후 새로고침.
9. **비밀·데이터는 커밋 금지** — `.env`(비밀번호·시크릿), `data/`(개인 학습 데이터)는 gitignore에 있다. 유지할 것.
10. 워크플로: main 직접 커밋+푸시(한국어 커밋 메시지, 논리 변경 1개당 1커밋). 리모트: github.com/pswss/StudyWork.

## 문서·이력

- 설계서: `docs/superpowers/specs/2026-07-08-studywork-design.md` (아키텍처 전환 이력 포함)
- 구현 계획: `docs/superpowers/plans/` — MVP(07-08), 퀴즈(07-08), 오답·시험(07-09)
- UI 목업: `docs/superpowers/specs/mockups/studywork-tabs-v3.html` (디자인 기준)
- 기술 스택: Hono · @hono/node-server · better-sqlite3 · Codex CLI · `pdftoppm` · @anthropic-ai/claude-agent-sdk(롤백 전용) · React 18 · Vite · marked · Vitest
