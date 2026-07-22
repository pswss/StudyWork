// API wrapper — all calls use same-origin cookie auth (sw_token)

export class AuthError extends Error {}

export class NotFoundError extends Error {}

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
  formData?: FormData
): Promise<T> {
  const opts: RequestInit = { method, credentials: "include" };
  if (formData) {
    opts.body = formData;
  } else if (body !== undefined) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (res.status === 401) {
    // 세션 만료를 앱 전역에 알려 로그인 화면으로 돌아가게 한다.
    window.dispatchEvent(new Event("sw:auth-expired"));
    throw new AuthError("Unauthorized");
  }
  if (res.status === 404) throw new NotFoundError("Not found");
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json() as { error?: string };
      if (j.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ===== auth =====
export async function login(password: string): Promise<void> {
  await req<void>("POST", "/api/login", { password });
}

// ===== subjects =====
export interface Subject {
  id: number;
  name: string;
  material_count: number;
  created_at: string;
}
export async function subjects(): Promise<Subject[]> {
  return req<Subject[]>("GET", "/api/subjects");
}
export async function createSubject(name: string): Promise<{ id: number }> {
  return req<{ id: number }>("POST", "/api/subjects", { name });
}
export async function deleteSubject(id: number): Promise<void> {
  await req<void>("DELETE", `/api/subjects/${id}`);
}

// ===== materials =====
export interface Material {
  id: number;
  subject_id: number;
  kind: "image" | "pdf" | "text";
  title: string;
  status: "processing" | "ready" | "error";
  error?: string | null;
  progress: number; // 분석 진행률(%) — 페이지 청크 완료 기준
  retry_chunk_count?: number | null; // 실패 후 현재 다시 돌리는 자료 청크 수
  chunk_total?: number | null;
  created_at: string;
  original_filename?: string | null;
  page_count?: number | null;
  extraction_method?: string | null;
  ocr_used?: number | null;
  integrity_warning?: string | null;
  source_type?: "obsidian" | null;
  source_path?: string | null;
  source_modified_at?: string | null;
  book_status: "processing" | "ready" | "error" | null; // 자료에서 뽑는 문제 추출 상태 (없으면 null)
  book_progress: number | null; // 문제 추출 진행률(%)
  book_retry_chunk_count?: number | null; // 실패 후 현재 다시 돌리는 문제 청크 수
  book_chunk_total?: number | null;
  book_file_id?: number | null;
  book_error?: string | null;
}
export interface MaterialDetail extends Material {
  extracted_text: string | null;
}
export async function materials(subjectId: number): Promise<Material[]> {
  return req<Material[]>("GET", `/api/subjects/${subjectId}/materials`);
}
// 통합 업로드 — 서버가 자료/문제집/해설지를 판별해 라우팅한다 (routed: "book"이면 문제집으로 감)
export interface UploadResult {
  id?: number;
  status: string;
  routed?: "book";
  bookId?: number;
}
export async function uploadMaterial(subjectId: number, data: FormData): Promise<UploadResult> {
  return req<UploadResult>("POST", `/api/subjects/${subjectId}/materials`, undefined, data);
}
export async function retryMaterial(id: number): Promise<{ id: number; status: string }> {
  return req<{ id: number; status: string }>("POST", `/api/materials/${id}/retry`);
}
export async function cancelMaterial(id: number): Promise<void> {
  await req<void>("POST", `/api/materials/${id}/cancel`);
}
export async function materialDetail(id: number): Promise<MaterialDetail> {
  return req<MaterialDetail>("GET", `/api/materials/${id}`);
}
export async function deleteMaterial(id: number): Promise<void> {
  await req<void>("DELETE", `/api/materials/${id}`);
}

// ===== messages =====
export interface Message {
  id: number;
  role: "user" | "assistant";
  content: string;
  mode?: "materials" | "general" | null; // 구버전 메시지는 null
  created_at: string;
}
export async function messages(subjectId: number): Promise<Message[]> {
  return req<Message[]>("GET", `/api/subjects/${subjectId}/messages`);
}
export async function chat(
  subjectId: number,
  message: string,
  mode: "materials" | "general" = "materials"
): Promise<{ reply: string }> {
  return req<{ reply: string }>("POST", `/api/subjects/${subjectId}/chat`, { message, mode });
}

// ===== AI runtime =====
export interface AIStatus {
  provider: "codex-cli" | "claude-cli" | "invalid";
  model: string | null;
  reasoningMode: null;
  reasoningEffort: string | null;
  state: "ready" | "rollback" | "invalid";
}
export async function aiStatus(operation?: AIOperation): Promise<AIStatus> {
  const query = operation ? `?operation=${encodeURIComponent(operation)}` : "";
  return req<AIStatus>("GET", `/api/ai/status${query}`);
}

export type AIReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type AIOperation =
  | "study"
  | "material-extract"
  | "consolidate"
  | "consolidate-chunk"
  | "consolidate-merge"
  | "answer-key-detect"
  | "problem-extract"
  | "question-extract"
  | "section-map"
  | "question-generate"
  | "wrong-answer-analysis"
  | "study-plan"
  | "chat";
export interface AIModelSetting {
  model: string;
  reasoningEffort: AIReasoningEffort;
}
export interface AISettings {
  appliesTo: "codex-cli";
  default: AIModelSetting;
  overrides: Partial<Record<AIOperation, AIModelSetting>>;
  resolved: Record<AIOperation, AIModelSetting>;
  operations: AIOperation[];
  allowedModels: string[];
  allowedEfforts: AIReasoningEffort[];
}
export interface AISettingsUpdate {
  default?: AIModelSetting;
  operations?: Partial<Record<AIOperation, AIModelSetting | null>>;
}
export async function aiSettings(): Promise<AISettings> {
  return req<AISettings>("GET", "/api/ai/settings");
}
export async function updateAISettings(update: AISettingsUpdate): Promise<AISettings> {
  return req<AISettings>("PUT", "/api/ai/settings", update);
}

// ===== quiz / questions =====
export interface Question {
  id: number;
  subject_id: number;
  source: "uploaded" | "generated";
  qtype: "mcq" | "short" | "ox";
  difficulty: "하" | "중" | "상";
  question: string;
  choices: string[] | null;
  answer: string;
  explanation: string;
  correct_count: number;
  wrong_count: number;
  created_at: string;
  src_file_id: number | null; // 원본 자료 파일 (삭제됐으면 null)
  src_file_name: string | null; // 원본 자료 파일명 — 문제 은행을 파일별로 묶는 그룹 라벨
  src_page: number | null;
  has_figure: number; // 1이면 그림 딸린 문제 — 원본 페이지 이미지 인라인 표시
  figure_box: string | null; // "top,bottom" 페이지 높이 비율 — 있으면 그 구간만 잘라 표시
}

export interface QuizItem {
  id: number;
  qtype: "mcq" | "short" | "ox";
  difficulty: "하" | "중" | "상";
  question: string;
  choices: string[] | null;
  source: "uploaded" | "generated";
  src_file_id: number | null; // 문제집 자동 등록 문제의 원본 파일 (도형·그림 확인용)
  src_page: number | null;
  has_figure: boolean; // 그림·도형 딸린 문제 — 원본 페이지 이미지를 인라인 표시
  figure_box: string | null; // "top,bottom" 페이지 높이 비율 — 있으면 그 구간만 잘라 표시
}

export interface AnswerResult {
  correct: boolean;
  answer: string;
  explanation: string;
}

export async function questions(
  subjectId: number,
  source?: string,
  difficulty?: string
): Promise<Question[]> {
  const params = new URLSearchParams();
  if (source) params.set("source", source);
  if (difficulty) params.set("difficulty", difficulty);
  const qs = params.toString();
  return req<Question[]>("GET", `/api/subjects/${subjectId}/questions${qs ? "?" + qs : ""}`);
}

export async function generateQuestions(
  subjectId: number,
  count: number,
  difficulty: string,
  materialIds: number[]
): Promise<AIJobStart> {
  return req<AIJobStart>("POST", `/api/subjects/${subjectId}/questions/generate`, { count, difficulty, materialIds });
}

export async function quiz(
  subjectId: number,
  opts: {
    source?: string;
    difficulty?: string;
    count?: number;
    wrong?: boolean;
    questionIds?: number[];
    srcFileId?: number;
  }
): Promise<QuizItem[]> {
  const params = new URLSearchParams();
  if (opts.source) params.set("source", opts.source);
  if (opts.difficulty) params.set("difficulty", opts.difficulty);
  if (opts.count !== undefined) params.set("count", String(opts.count));
  if (opts.wrong) params.set("wrong", "1");
  if (opts.questionIds !== undefined) params.set("questionIds", opts.questionIds.join(","));
  if (opts.srcFileId !== undefined) params.set("src_file_id", String(opts.srcFileId));
  const qs = params.toString();
  return req<QuizItem[]>("GET", `/api/subjects/${subjectId}/quiz${qs ? "?" + qs : ""}`);
}

export async function answerQuestion(id: number, answer: string, attemptId: string): Promise<AnswerResult> {
  return req<AnswerResult>("POST", `/api/questions/${id}/answer`, { answer, attemptId });
}

export async function deleteQuestion(id: number): Promise<void> {
  await req<void>("DELETE", `/api/questions/${id}`);
}

// ===== books (문제집 — 개념·팁·문제·해설 분류) =====
export type BookCategory = "개념" | "팁" | "문제" | "해설";

export interface BookFile {
  id: number;
  name: string;
  mime: string;
  status: "processing" | "ready" | "error";
  error: string | null;
  progress: number; // 분석 진행률(%) — 페이지 청크 완료 기준
}

export interface Book {
  id: number;
  title: string;
  created_at: string;
  files: BookFile[];
  question_count: number;
  explained_count: number;
  counts: Record<BookCategory, number>;
}

export interface BookItem {
  id: number;
  file_id: number;
  category: BookCategory;
  number: string;
  answer: string;
  content: string;
  page: number | null;
  has_figure: number; // 1이면 그림·도형 딸린 항목 — 원본 페이지 이미지를 인라인 표시
  figure_box: string | null; // "top,bottom" 페이지 높이 비율 — 있으면 그 구간만 잘라 표시
}

export interface BookDetail extends Book {
  items: BookItem[];
}

export async function books(subjectId: number): Promise<Book[]> {
  return req<Book[]>("GET", `/api/subjects/${subjectId}/books`);
}

export async function uploadBook(subjectId: number, data: FormData): Promise<{ id: number; status: string }> {
  return req<{ id: number; status: string }>("POST", `/api/subjects/${subjectId}/books`, undefined, data);
}

export async function uploadBookExplanations(
  subjectId: number,
  bookId: number,
  data: FormData
): Promise<AIJobStart> {
  return req<AIJobStart>(
    "POST",
    `/api/subjects/${subjectId}/books/${bookId}/explanations`,
    undefined,
    data
  );
}

export async function bookDetail(id: number): Promise<BookDetail> {
  return req<BookDetail>("GET", `/api/books/${id}`);
}

export async function deleteBook(id: number): Promise<void> {
  await req<void>("DELETE", `/api/books/${id}`);
}

export async function retryBookFile(fileId: number): Promise<{ id: number; status: string }> {
  return req<{ id: number; status: string }>("POST", `/api/book-files/${fileId}/retry`);
}

export async function cancelBookFile(fileId: number): Promise<void> {
  await req<void>("POST", `/api/book-files/${fileId}/cancel`);
}

export async function deleteBookFile(fileId: number): Promise<void> {
  await req<void>("DELETE", `/api/book-files/${fileId}`);
}

// 원본 파일 URL (PDF는 #page=N 으로 해당 페이지 이동)
export function bookFileUrl(fileId: number, page?: number | null): string {
  return `/api/book-files/${fileId}/file${page ? `#page=${page}` : ""}`;
}

// 원본 한 페이지의 PNG 렌더 URL — 그림·도형 딸린 항목의 인라인 표시용
export function pageImageUrl(fileId: number, page?: number | null, box?: string | null): string {
  return `/api/book-files/${fileId}/page/${page || 1}/image${box ? `?box=${box}` : ""}`;
}

// ===== wrong notes =====
export interface WrongQuestion {
  id: number;
  subject_id: number;
  source: "uploaded" | "generated";
  qtype: "mcq" | "short" | "ox";
  difficulty: "하" | "중" | "상";
  question: string;
  choices: string[] | null;
  answer: string;
  explanation: string;
  correct_count: number;
  wrong_count: number;
  from_wrong_note: number;
  created_at: string;
}

export async function wrongQuestions(subjectId: number): Promise<WrongQuestion[]> {
  return req<WrongQuestion[]>("GET", `/api/subjects/${subjectId}/wrong`);
}

export async function extractWrong(subjectId: number, data: FormData): Promise<{ added: number }> {
  return req<{ added: number }>("POST", `/api/subjects/${subjectId}/wrong/extract`, undefined, data);
}

export async function analyzeWrong(subjectId: number): Promise<{ analysis: string }> {
  return req<{ analysis: string }>("POST", `/api/subjects/${subjectId}/wrong/analyze`);
}

// ===== exams =====
export interface PlanItem {
  id: number;
  exam_id: number;
  day: string;
  task: string;
  done: number;
}

export interface Exam {
  id: number;
  subject_id: number;
  title: string;
  exam_date: string;
  scope: string;
  created_at: string;
  items: PlanItem[];
  done_count?: number;
}

export interface AIJob<T = unknown> {
  id: number;
  subject_id: number;
  kind: string;
  status: "processing" | "ready" | "error";
  result: T | null;
  error: string | null;
}

export interface AIJobStart {
  jobId: number;
  status: "processing";
}

export async function aiJob<T = unknown>(jobId: number): Promise<AIJob<T>> {
  return req<AIJob<T>>("GET", `/api/ai-jobs/${jobId}`);
}

export async function exams(subjectId: number): Promise<Exam[]> {
  return req<Exam[]>("GET", `/api/subjects/${subjectId}/exams`);
}

export async function createExam(
  subjectId: number,
  body: { title: string; exam_date: string; scope?: string }
): Promise<AIJobStart> {
  return req<AIJobStart>("POST", `/api/subjects/${subjectId}/exams`, body);
}

export async function togglePlanItem(itemId: number, done: boolean): Promise<{ ok: boolean }> {
  return req<{ ok: boolean }>("PATCH", `/api/plan-items/${itemId}`, { done });
}

export async function replanExam(examId: number): Promise<AIJobStart> {
  return req<AIJobStart>("POST", `/api/exams/${examId}/replan`);
}

export async function deleteExam(examId: number): Promise<void> {
  await req<void>("DELETE", `/api/exams/${examId}`);
}

// ===== consolidate & note =====
// 단권화는 서버 백그라운드에서 진행 — note.status를 폴링해 완료를 확인한다
export async function consolidate(
  subjectId: number,
  instructions?: string,
  materialIds?: number[],
  bookIds?: number[]
): Promise<{ status: string }> {
  // 배열을 보내면(빈 배열 포함) 그 목록만 사용, 생략하면 전체 — UI는 항상 명시적으로 보낸다
  return req<{ status: string }>("POST", `/api/subjects/${subjectId}/consolidate`, {
    ...(instructions?.trim() ? { instructions: instructions.trim() } : {}),
    ...(materialIds ? { materialIds } : {}),
    ...(bookIds ? { bookIds } : {}),
  });
}
export async function updateNote(subjectId: number, content: string): Promise<void> {
  await req<void>("PUT", `/api/subjects/${subjectId}/note`, { content });
}
export async function cancelConsolidate(subjectId: number): Promise<void> {
  await req<void>("POST", `/api/subjects/${subjectId}/consolidate/cancel`);
}
export async function deleteNote(subjectId: number): Promise<void> {
  await req<void>("DELETE", `/api/subjects/${subjectId}/note`);
}
export async function deleteNoteVersion(id: number): Promise<void> {
  await req<void>("DELETE", `/api/note-versions/${id}`);
}
export interface Note {
  content: string;
  updated_at: string;
  status: "processing" | "ready" | "error";
  progress: number; // 단권화 진행률(%) — 청크 완료 기준
}
export async function note(subjectId: number): Promise<Note | null> {
  try {
    return await req<Note>("GET", `/api/subjects/${subjectId}/note`);
  } catch (e) {
    if (e instanceof NotFoundError) return null;
    throw e;
  }
}

// 단권화 기록 (버전)
export interface NoteVersion {
  id: number;
  created_at: string;
  len: number;
}
export async function noteVersions(subjectId: number): Promise<NoteVersion[]> {
  return req<NoteVersion[]>("GET", `/api/subjects/${subjectId}/note-versions`);
}
export async function noteVersion(id: number): Promise<{ id: number; content: string; created_at: string }> {
  return req<{ id: number; content: string; created_at: string }>("GET", `/api/note-versions/${id}`);
}
