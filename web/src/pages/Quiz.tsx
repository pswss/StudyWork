// Quiz.tsx — 퀴즈 탭 컴포넌트 (은행 / 플레이 / 결과)
import { useState, useEffect, useRef, useMemo, KeyboardEvent } from "react";
import { useEscape } from "../escape";
import {
  Subject, Material, Question, QuizItem, AnswerResult,
  questions as apiQuestions,
  generateQuestions as apiGenerate,
  aiJob as apiAIJob,
  quiz as apiQuiz,
  answerQuestion as apiAnswer,
  deleteQuestion as apiDeleteQuestion,
  generateQuestionExplanation as apiGenerateQuestionExplanation,
  bookFileUrl,
  pageImageUrl,
  NotFoundError,
} from "../api";
import { escapeHtmlText, Md, MdInline, MdInlineText, mdInlineHtml } from "../md";
import { useI18n, type Locale, type MessageKey, type Translate } from "../i18n";
import SourcePicker from "./SourcePicker";
import SingleSelectPicker from "./SingleSelectPicker";
import QuizScratchpad from "./QuizScratchpad";
import { AiPending } from "../Pending";
import { getAnswerAttempt, type AnswerAttempt } from "../answer-attempt";
import { useUndoDelete } from "../UndoDelete";

interface Props {
  subject: Subject;
  materials: Material[];
  active?: boolean;
  kickWrongQuiz?: number; // 오답만 즉시 시작 (카운터 증가마다 실행)
}

type View = "bank" | "play" | "result";

interface PlayScore {
  id: number; // 문제 id — 결과 화면 "틀린 것만 다시"에 사용
  correct: boolean;
  question: string;
  answer: string;
}

interface PlayState {
  items: QuizItem[];
  index: number;
  answered: boolean;
  result: AnswerResult | null;
  selectedChoice: string | null; // mcq 선택
  shortInput: string;
  scores: PlayScore[];
}

interface QuizRunOptions {
  source: string;
  diff: string;
  count: number;
  wrong?: boolean;
  questionIds?: number[];
  srcFileId?: number;
}

interface QuizFilters {
  source: "all" | "uploaded" | "generated";
  difficulty: "all" | "하" | "중" | "상";
  count: number;
  wrong: boolean;
}

interface GenerationNotice {
  key: MessageKey;
  count?: number;
  ok?: boolean;
}

type NumberFormatter = (value: number, options?: Intl.NumberFormatOptions) => string;

export function parseQuizFilters(search: string): QuizFilters {
  const params = new URLSearchParams(search);
  const source = params.get("quizSource");
  const difficulty = params.get("quizDifficulty");
  const count = Number(params.get("quizCount"));
  return {
    source: source === "uploaded" || source === "generated" ? source : "all",
    difficulty: difficulty === "하" || difficulty === "중" || difficulty === "상" ? difficulty : "all",
    count: Number.isInteger(count) && count >= 1 && count <= 50 ? count : 10,
    wrong: params.get("quizWrong") === "1",
  };
}

function shuffledQuestionIds(questions: Question[], count: number): number[] {
  const ids = questions.map(q => q.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, Math.min(count, 50));
}

function generationJobKey(subjectId: number): string {
  return `studywork:question-generation:${subjectId}`;
}

// 동시 생성 지원 — 저장 형식은 job id 배열. 구버전 단일 숫자 문자열도 읽는다.
function storedGenerationJobs(subjectId: number): number[] {
  try {
    const raw = sessionStorage.getItem(generationJobKey(subjectId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    const ids = Array.isArray(parsed) ? parsed : [parsed];
    return ids.filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0);
  } catch {
    return [];
  }
}

function writeStoredGenerationJobs(subjectId: number, ids: number[]): void {
  try {
    if (ids.length === 0) sessionStorage.removeItem(generationJobKey(subjectId));
    else sessionStorage.setItem(generationJobKey(subjectId), JSON.stringify(ids));
  } catch {}
}

export function qtypeLabel(q: string, t?: Translate) {
  if (!t) return q === "mcq" ? "객관식" : q === "short" ? "단답" : "OX";
  return q === "mcq"
    ? t("problems.qtype.mcq")
    : q === "short" ? t("problems.qtype.short") : t("problems.qtype.ox");
}

export function difficultyLabel(difficulty: string, t?: Translate): string {
  if (!t) return difficulty;
  if (difficulty === "하") return t("problems.difficulty.low");
  if (difficulty === "중") return t("problems.difficulty.medium");
  if (difficulty === "상") return t("problems.difficulty.high");
  return difficulty === "혼합" ? t("problems.difficulty.mixed") : difficulty;
}

export function quizShortcutChoice(item: Pick<QuizItem, "qtype" | "choices">, key: string): string | null {
  if (item.qtype === "ox" && /^[ox]$/i.test(key)) return key.toUpperCase();
  if (item.qtype !== "mcq" || !item.choices || !/^[1-9]$/.test(key)) return null;
  return item.choices[Number(key) - 1] ?? null;
}

function problemCountLabel(count: number, t: Translate, formatNumber: NumberFormatter): string {
  return t(count === 1 ? "problems.count.one" : "problems.count.many", {
    count: formatNumber(count),
  });
}

function accuracyLabel(q: Question, t: Translate, formatNumber: NumberFormatter): string {
  const total = q.correct_count + q.wrong_count;
  if (total === 0) return t("problems.accuracy.none");
  return t("problems.accuracy.correct", {
    correct: formatNumber(q.correct_count),
    total: formatNumber(total),
  });
}

export function figureAlt(
  description: string | null,
  page: number | null,
  number?: number,
  t?: Translate,
  formatNumber: NumberFormatter = String,
): string {
  if (description?.trim()) return description;
  if (!t) return `${number ? `${number}번 ` : ""}문제 풀이에 필요한 원본 도형 또는 그림 — p.${page ?? 1}`;
  const values = { number: formatNumber(number ?? 1), page: formatNumber(page ?? 1) };
  return t(number === undefined ? "problems.figure.alt" : "problems.figure.altNumbered", values);
}

// ── 인쇄 헬퍼 ──────────────────────────────────────────────────────────────────
function printQuestions(
  subjectName: string,
  qs: Question[],
  type: "question" | "answer",
  locale: Locale,
  t: Translate,
  formatNumber: NumberFormatter,
): string | null {
  let win: Window | null;
  try {
    win = window.open("", "_blank");
  } catch {
    win = null;
  }
  if (!win) {
    return t("problems.print.blocked");
  }
  try {
    win.opener = null;
  } catch {
    // 일부 브라우저는 opener 쓰기를 막는다. 출력 자체는 계속 가능하다.
  }
  const title = `${escapeHtmlText(subjectName)} ${escapeHtmlText(t(
    type === "question" ? "problems.print.questionSheet" : "problems.print.answerSheet",
  ))}`;
  const body = qs
    .map((q, i) => {
      const num = formatNumber(i + 1);
      if (type === "question") {
        let html = `<div class="q-block"><p class="q-num">${num}.</p><p class="q-text">${mdInlineHtml(q.question)}</p>`;
        if (q.src_file_id && q.has_figure) {
          const src = escapeHtmlText(new URL(pageImageUrl(q.src_file_id, q.src_page, q.figure_box), window.location.origin).href);
          const alt = escapeHtmlText(figureAlt(q.figure_description, q.src_page, i + 1, t, formatNumber));
          html += `<img class="q-figure" width="1200" height="900" src="${src}" alt="${alt}">`;
        }
        if (q.qtype === "mcq" && q.choices) {
          html += `<ol class="choices">${q.choices.map(c => `<li>${mdInlineHtml(c)}</li>`).join("")}</ol>`;
        } else if (q.qtype === "short") {
          html += `<div class="ans-blank"></div>`;
        } else {
          // OX
          html += `<p class="ox-blank">O &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; X</p>`;
        }
        html += `</div>`;
        return html;
      } else {
        return `<div class="q-block"><p class="q-num">${num}. <strong>${mdInlineHtml(q.answer)}</strong></p>${q.explanation ? `<p class="expl">${mdInlineHtml(q.explanation)}</p>` : ""}</div>`;
      }
    })
    .join("");

  win.document.write(`<!DOCTYPE html><html lang="${locale}"><head><meta charset="UTF-8"><title>${title}</title>
<style>
  body{font-family:"Nanum Myeongjo","Batang",serif;background:#fff;color:#111;padding:40px;max-width:800px;margin:0 auto;}
  h1{font-size:22px;margin-bottom:28px;border-bottom:2px solid #111;padding-bottom:8px;}
  .q-block{margin-bottom:24px;}
  .q-num{font-weight:700;margin-bottom:4px;}
  .q-text{margin-bottom:6px;line-height:1.7;}
  .q-figure{display:block;max-width:100%;max-height:420px;object-fit:contain;margin:12px auto;}
  .choices{padding-left:24px;line-height:2;}
  .ans-blank{border-bottom:1px solid #555;height:28px;margin-top:8px;}
  .ox-blank{font-size:18px;margin-top:6px;letter-spacing:8px;}
  .expl{color:#555;font-size:13px;margin-top:4px;}
  @media print{body{padding:20px;}}
</style></head><body><h1>${title}</h1>${body}</body></html>`);
  win.document.close();
  win.focus();
  win.print();
  return null;
}

// ── 메인 컴포넌트 ──────────────────────────────────────────────────────────────
export default function Quiz({ subject, materials, active = true, kickWrongQuiz }: Props) {
  const { locale, t, formatNumber } = useI18n();
  const { pending: pendingDelete, schedule: scheduleDelete } = useUndoDelete();
  const autoFocusInput = typeof window.matchMedia !== "function" || window.matchMedia("(pointer: fine)").matches;
  const initialFilters = useMemo(() => parseQuizFilters(window.location.search), []);
  const quizCountOptions = useMemo(() => Array.from({ length: 50 }, (_, index) => ({
    value: String(index + 1),
    label: problemCountLabel(index + 1, t, formatNumber),
  })), [formatNumber, t]);
  const mountedRef = useRef(true);
  const subjectIdRef = useRef(subject.id);
  const bankRequestRef = useRef(0);
  const quizRequestRef = useRef(0);
  const quizPendingRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const [view, setView] = useState<View>("bank");
  const [bankQs, setBankQs] = useState<Question[]>([]);
  const [loadErr, setLoadErr] = useState("");
  const [loading, setLoading] = useState(false);

  // 은행 - 선택
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [allInScope, setAllInScope] = useState(true);

  // 은행 - 퀴즈 시작 컨트롤
  const [startSource, setStartSource] = useState<string>(initialFilters.source);
  const [startDiff, setStartDiff] = useState<string>(initialFilters.difficulty);
  const [startCount, setStartCount] = useState(initialFilters.count);
  const [startWrong, setStartWrong] = useState(initialFilters.wrong);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (startSource === "all") params.delete("quizSource"); else params.set("quizSource", startSource);
    if (startDiff === "all") params.delete("quizDifficulty"); else params.set("quizDifficulty", startDiff);
    if (startCount === 10) params.delete("quizCount"); else params.set("quizCount", String(startCount));
    if (startWrong) params.set("quizWrong", "1"); else params.delete("quizWrong");
    window.history.replaceState(null, "", `${window.location.pathname}?${params}${window.location.hash}`);
  }, [startCount, startDiff, startSource, startWrong]);

  // 은행 - AI 생성 (동시 여러 건 — 자료 선택이 완전히 같을 때만 서버가 409로 거른다)
  const [genCount, setGenCount] = useState(5);
  const [genDiff, setGenDiff] = useState("혼합");
  const [genStarting, setGenStarting] = useState(false);
  const [genMsgs, setGenMsgs] = useState<GenerationNotice[]>([]);
  const [generationJobIds, setGenerationJobIds] = useState<number[]>(() => storedGenerationJobs(subject.id));
  const [generationOpen, setGenerationOpen] = useState(() => storedGenerationJobs(subject.id).length > 0);
  const readyMaterials = useMemo(() => materials.filter(m => m.status === "ready"), [materials]);
  // 제외 집합: 선택을 유지하면서 새 자료는 기본 포함한다 (Chat/Notes와 같은 계약).
  const [genExcluded, setGenExcluded] = useState<Set<number>>(new Set());
  const genMaterialIds = useMemo(
    () => new Set(readyMaterials.filter(m => !genExcluded.has(m.id)).map(m => m.id)),
    [readyMaterials, genExcluded],
  );

  // 은행 - 문제 상세 토글
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // 플레이
  const [play, setPlay] = useState<PlayState | null>(null);
  const [answering, setAnswering] = useState(false);
  const [startingQuiz, setStartingQuiz] = useState(false);
  const [answerErr, setAnswerErr] = useState("");
  const playGenerationRef = useRef(0);
  const answerRequestRef = useRef(0);
  const answerAttemptRef = useRef<AnswerAttempt | null>(null);
  const startButtonRef = useRef<HTMLButtonElement>(null);
  const questionFrameRef = useRef<HTMLDivElement>(null);
  const shortAnswerRef = useRef<HTMLInputElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const previousViewRef = useRef<View>("bank");

  // 결과
  const [resultScores, setResultScores] = useState<PlayScore[]>([]);
  const [lastOpts, setLastOpts] = useState<QuizRunOptions | null>(null);

  // 은행 - 에러
  const [bankErr, setBankErr] = useState("");

  // ESC: 플레이/결과 → 문제 은행 (그만두기와 동일)
  useEscape(active && (view === "play" || view === "result"), returnToBank);

  useEffect(() => {
    if (!active) return;
    const previous = previousViewRef.current;
    previousViewRef.current = view;
    if (view === "bank") {
      if (previous !== "bank") startButtonRef.current?.focus();
      return;
    }
    if (view === "result") {
      resultRef.current?.focus();
      return;
    }
    if (play?.answered) feedbackRef.current?.focus();
    else if (play?.items[play.index]?.qtype === "short" && autoFocusInput) shortAnswerRef.current?.focus();
    else questionFrameRef.current?.focus();
  }, [active, autoFocusInput, play?.answered, play?.index, view]);

  function returnToBank() {
    quizRequestRef.current++;
    quizPendingRef.current = false;
    setStartingQuiz(false);
    playGenerationRef.current++;
    answerRequestRef.current++;
    answerAttemptRef.current = null;
    setAnswering(false);
    setView("bank");
    void loadBank();
  }

  // ── 문제 목록 로드 ────────────────────────────────────────────────────────────
  async function loadBank() {
    const request = ++bankRequestRef.current;
    setLoading(true);
    setLoadErr("");
    try {
      const qs = await apiQuestions(subject.id);
      if (!mountedRef.current || request !== bankRequestRef.current) return;
      setBankQs(qs);
    } catch (e) {
      if (!mountedRef.current || request !== bankRequestRef.current) return;
      setLoadErr(locale === "ko" && e instanceof Error ? e.message : t("problems.bank.loadFailed"));
    } finally {
      if (mountedRef.current && request === bankRequestRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    subjectIdRef.current = subject.id;
    quizRequestRef.current++;
    quizPendingRef.current = false;
    setStartingQuiz(false);
    setSelected(new Set());
    setAllInScope(true);
    setOpenGroups(new Set());
    setGenExcluded(new Set());
    const savedJobIds = storedGenerationJobs(subject.id);
    setGenerationJobIds(savedJobIds);
    setGenerationOpen(savedJobIds.length > 0);
    setGenStarting(false);
    setGenMsgs(savedJobIds.length > 0 ? [{ key: "problems.generation.resume" }] : []);
    void loadBank();
  }, [subject.id]);

  // 추적 중인 생성 작업 전부를 한 주기에 확인 — 끝난 작업만 제거하고 나머지는 계속 돈다.
  useEffect(() => {
    if (generationJobIds.length === 0) return;
    const polledSubjectId = subject.id;
    const ids = [...generationJobIds];
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      const finished: number[] = [];
      const messages: GenerationNotice[] = [];
      const errors: string[] = [];
      let addedAny = false;
      for (const jobId of ids) {
        try {
          const job = await apiAIJob<{ added: number }>(jobId);
          if (stopped) return;
          if (job.subject_id !== polledSubjectId) {
            finished.push(jobId);
            errors.push(t("problems.generation.wrongSubject"));
            continue;
          }
          if (job.status === "processing") continue;
          finished.push(jobId);
          if (job.status === "error") {
            if (job.error === "사용자 중단") messages.push({ key: "problems.generation.stopped" });
            else errors.push(locale === "ko" && job.error ? job.error : t("problems.generation.failed"));
          } else {
            addedAny = true;
            messages.push({ key: "problems.generation.added", count: job.result?.added ?? 0, ok: true });
          }
        } catch (error) {
          if (stopped) return;
          if (error instanceof NotFoundError) {
            finished.push(jobId);
            errors.push(t("problems.generation.missing"));
            continue;
          }
          // 일시적 오류 — 이 작업은 다음 주기에 다시 확인한다.
          setBankErr(locale === "ko" && error instanceof Error
            ? t("problems.generation.retryWithError", { error: error.message })
            : t("problems.generation.statusFailed"));
        }
      }
      if (finished.length > 0) {
        const remaining = storedGenerationJobs(polledSubjectId).filter((id) => !finished.includes(id));
        writeStoredGenerationJobs(polledSubjectId, remaining);
        if (!stopped && subjectIdRef.current === polledSubjectId) {
          setGenerationJobIds((current) => current.filter((id) => !finished.includes(id)));
          if (messages.length > 0) setGenMsgs((prev) => [...prev, ...messages].slice(-3));
          if (errors.length > 0) setBankErr(errors[errors.length - 1]);
          else if (addedAny) setBankErr("");
          if (addedAny) await loadBank();
        }
      }
      if (stopped) return;
      timer = setTimeout(poll, 2500);
    };

    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [generationJobIds, locale, subject.id, t]);

  // ── 파일(자료)별 그룹 — 드롭다운으로 접었다 폈다 ────────────────────────────────
  const groups = useMemo(() => {
    const m = new Map<number, { key: number; label: string; items: Question[] }>();
    for (const q of bankQs) {
      const key = q.src_file_id ?? 0; // 0 = 원본 파일 없는 문제(AI 생성 등)
      let g = m.get(key);
      if (!g) {
        g = {
          key,
          label: q.src_file_id
            ? (q.src_file_name ?? t("problems.file.unnamed", { id: formatNumber(q.src_file_id) }))
            : t("problems.file.generatedOther"),
          items: [],
        };
        m.set(key, g);
      }
      g.items.push(q);
    }
    return [...m.values()];
  }, [bankQs, formatNumber, t]);
  const [openGroups, setOpenGroups] = useState<Set<number>>(new Set());
  function toggleGroup(key: number) {
    setOpenGroups(prev => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  }

  // ── 요약 ──────────────────────────────────────────────────────────────────────
  const total = bankQs.length;
  const uploadedCount = bankQs.filter(q => q.source === "uploaded").length;
  const generatedCount = bankQs.filter(q => q.source === "generated").length;
  const diffCounts = {
    "하": bankQs.filter(q => q.difficulty === "하").length,
    "중": bankQs.filter(q => q.difficulty === "중").length,
    "상": bankQs.filter(q => q.difficulty === "상").length,
  };
  const eligibleStartCount = useMemo(() => bankQs.filter(q =>
    (allInScope || selected.has(q.id))
    && (startSource === "all" || q.source === startSource)
    && (startDiff === "all" || q.difficulty === startDiff)
    && (!startWrong || q.wrong_count > 0)
  ).length, [bankQs, allInScope, selected, startSource, startDiff, startWrong]);
  const plannedStartCount = Math.min(startCount, eligibleStartCount);

  // ── 체크박스 ──────────────────────────────────────────────────────────────────
  function toggleSelect(id: number) {
    const next = allInScope ? new Set(bankQs.map(q => q.id)) : new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
    setAllInScope(next.size === bankQs.length);
  }
  function toggleGroupSelection(items: Question[]) {
    const next = allInScope ? new Set(bankQs.map(q => q.id)) : new Set(selected);
    const groupSelected = items.every(q => next.has(q.id));
    for (const q of items) {
      if (groupSelected) next.delete(q.id); else next.add(q.id);
    }
    setSelected(next);
    setAllInScope(next.size === bankQs.length);
  }
  function toggleAll() {
    if (allInScope || selected.size === bankQs.length) {
      setAllInScope(false);
      setSelected(new Set());
    } else {
      setAllInScope(true);
      setSelected(new Set());
    }
  }
  function toggleGenerationMaterial(id: number) {
    setGenExcluded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function setGenerationMaterialsVisible(ids: number[], included: boolean) {
    setGenExcluded(prev => {
      const next = new Set(prev);
      for (const id of ids) included ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // ── AI 생성 — 동시 여러 건 시작 가능. 같은 자료 선택 중복만 서버가 409로 알린다 ──
  async function doGenerate() {
    if (genStarting) return;
    if (genMaterialIds.size === 0) {
      setBankErr(t("problems.generation.selectMaterials"));
      return;
    }
    setGenStarting(true);
    setBankErr("");
    const requestedSubjectId = subject.id;
    try {
      const { jobId } = await apiGenerate(requestedSubjectId, genCount, genDiff, [...genMaterialIds]);
      writeStoredGenerationJobs(requestedSubjectId, [
        ...storedGenerationJobs(requestedSubjectId).filter((id) => id !== jobId),
        jobId,
      ]);
      if (!mountedRef.current || subjectIdRef.current !== requestedSubjectId) return;
      setGenerationJobIds(storedGenerationJobs(requestedSubjectId));
    } catch (e) {
      if (!mountedRef.current || subjectIdRef.current !== requestedSubjectId) return;
      setBankErr(locale === "ko" && e instanceof Error ? e.message : t("problems.generation.generateFailed"));
    } finally {
      if (mountedRef.current) setGenStarting(false);
    }
  }

  // ── 퀴즈 시작 ─────────────────────────────────────────────────────────────────
  async function runQuiz(opts: QuizRunOptions) {
    if (quizPendingRef.current) return;
    quizPendingRef.current = true;
    const request = ++quizRequestRef.current;
    setStartingQuiz(true);
    setBankErr("");
    try {
      const items = await apiQuiz(subject.id, {
        source: opts.source === "all" ? undefined : opts.source,
        difficulty: opts.diff === "all" ? undefined : opts.diff,
        count: opts.count,
        wrong: opts.wrong,
        questionIds: opts.questionIds,
        srcFileId: opts.srcFileId,
      });
      if (!mountedRef.current || request !== quizRequestRef.current) return;
      if (items.length === 0) {
        setBankErr(t("problems.run.noMatch"));
        setView("bank");
        return;
      }
      setLastOpts(opts);
      playGenerationRef.current++;
      answerRequestRef.current++;
      answerAttemptRef.current = null;
      setAnswering(false);
      setAnswerErr("");
      setPlay({
        items,
        index: 0,
        answered: false,
        result: null,
        selectedChoice: null,
        shortInput: "",
        scores: [],
      });
      setView("play");
    } catch (e) {
      if (!mountedRef.current || request !== quizRequestRef.current) return;
      setBankErr(locale === "ko" && e instanceof Error ? e.message : t("problems.run.startFailed"));
      setView("bank");
    } finally {
      if (request === quizRequestRef.current) {
        quizPendingRef.current = false;
        if (mountedRef.current) setStartingQuiz(false);
      }
    }
  }

  function startQuiz() {
    if (allInScope) {
      return runQuiz({ source: startSource, diff: startDiff, count: startCount, wrong: startWrong || undefined });
    }
    const eligible = bankQs.filter(q =>
      selected.has(q.id)
      && (startSource === "all" || q.source === startSource)
      && (startDiff === "all" || q.difficulty === startDiff)
      && (!startWrong || q.wrong_count > 0)
    );
    if (eligible.length === 0) {
      setBankErr(t(selected.size === 0
        ? "problems.run.selectRange"
        : "problems.run.noMatchSelection"));
      return;
    }
    const questionIds = shuffledQuestionIds(eligible, startCount);
    return runQuiz({
      source: startSource,
      diff: startDiff,
      count: questionIds.length,
      wrong: startWrong || undefined,
      questionIds,
    });
  }

  // kickWrongQuiz: 오답 탭에서 "오답만 다시 풀기" 누를 때 카운터 증가 → 즉시 실행
  const prevKick = useRef(0);
  useEffect(() => {
    if (kickWrongQuiz && kickWrongQuiz > prevKick.current) {
      prevKick.current = kickWrongQuiz;
      runQuiz({ source: "all", diff: "all", count: 10, wrong: true });
    }
  }, [kickWrongQuiz]);

  // ── 문제 삭제 ─────────────────────────────────────────────────────────────────
  function doDelete(id: number) {
    const question = bankQs.find(item => item.id === id);
    scheduleDelete({
      key: `question:${id}`,
      label: question
        ? t("problems.delete.label", { question: question.question.slice(0, 28) })
        : t("problems.delete.generic"),
      commit: async () => {
        try {
          await apiDeleteQuestion(id);
          if (!mountedRef.current) return;
          setBankQs(prev => prev.filter(q => q.id !== id));
          setSelected(prev => { const next = new Set(prev); next.delete(id); return next; });
        } catch (error) {
          await loadBank();
          throw error;
        }
      },
    });
  }

  // ── 상세 토글 ─────────────────────────────────────────────────────────────────
  function toggleExpand(id: number) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // ── 단일 문제 AI 해설 생성 — 검산 일치 시에만 저장, 불일치는 경고로 표시 ────────
  const [explGenBusy, setExplGenBusy] = useState<Set<number>>(new Set());
  const [explGenNotice, setExplGenNotice] = useState<Map<number, { tone: "warn" | "bad"; text: string }>>(new Map());
  async function generateExplanation(id: number) {
    if (explGenBusy.has(id)) return;
    setExplGenBusy(prev => new Set(prev).add(id));
    setExplGenNotice(prev => { const next = new Map(prev); next.delete(id); return next; });
    try {
      const res = await apiGenerateQuestionExplanation(id);
      if (!mountedRef.current) return;
      if (res.filled && res.explanation) {
        setBankQs(prev => prev.map(q => q.id === id ? { ...q, explanation: res.explanation! } : q));
      } else {
        setExplGenNotice(prev => new Map(prev).set(id, {
          tone: "warn",
          text: t("problems.explanation.mismatch"),
        }));
      }
    } catch (e) {
      if (!mountedRef.current) return;
      setExplGenNotice(prev => new Map(prev).set(id, {
        tone: "bad",
        text: locale === "ko" && e instanceof Error ? e.message : t("problems.explanation.failed"),
      }));
    } finally {
      if (mountedRef.current) {
        setExplGenBusy(prev => { const next = new Set(prev); next.delete(id); return next; });
      }
    }
  }

  // ── 인쇄 ──────────────────────────────────────────────────────────────────────
  function doPrint(type: "question" | "answer") {
    const targets = !allInScope
      ? bankQs.filter(q => selected.has(q.id))
      : bankQs;
    const error = printQuestions(subject.name, targets, type, locale, t, formatNumber);
    if (error) setBankErr(error);
  }

  // ── 플레이어 - 확인 ───────────────────────────────────────────────────────────
  async function doAnswer() {
    if (!play || play.answered || answering) return;
    const item = play.items[play.index];
    let userAnswer = "";
    if (item.qtype === "mcq") {
      if (!play.selectedChoice) return;
      userAnswer = play.selectedChoice;
    } else if (item.qtype === "short") {
      if (!play.shortInput.trim()) return;
      userAnswer = play.shortInput.trim();
    } else {
      if (!play.selectedChoice) return;
      userAnswer = play.selectedChoice;
    }
    const generation = playGenerationRef.current;
    const requestId = ++answerRequestRef.current;
    const attempt = getAnswerAttempt(answerAttemptRef.current, item.id, userAnswer);
    answerAttemptRef.current = attempt;
    setAnswering(true);
    setAnswerErr("");
    try {
      const res = await apiAnswer(item.id, userAnswer, attempt.id);
      if (!mountedRef.current || generation !== playGenerationRef.current || requestId !== answerRequestRef.current) return;
      setPlay(prev => {
        if (!prev || prev.answered || prev.items[prev.index]?.id !== item.id) return prev;
        return {
          ...prev,
          answered: true,
          result: res,
          scores: [...prev.scores, { id: item.id, correct: res.correct, question: item.question, answer: res.answer }],
        };
      });
    } catch (e) {
      if (mountedRef.current && generation === playGenerationRef.current && requestId === answerRequestRef.current) {
        setAnswerErr(locale === "ko" && e instanceof Error ? e.message : t("problems.run.gradingFailed"));
      }
    } finally {
      if (mountedRef.current && generation === playGenerationRef.current && requestId === answerRequestRef.current) {
        setAnswering(false);
      }
    }
  }

  function onShortKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") doAnswer();
  }

  // ── 플레이어 - 다음 ───────────────────────────────────────────────────────────
  function doNext() {
    if (!play) return;
    answerAttemptRef.current = null;
    if (play.index + 1 >= play.items.length) {
      // 결과 화면
      setResultScores(play.scores);
      setView("result");
      return;
    }
    setPlay(prev => prev ? {
      ...prev,
      index: prev.index + 1,
      answered: false,
      result: null,
      selectedChoice: null,
      shortInput: "",
    } : prev);
  }

  useEffect(() => {
    if (!active || view !== "play" || !play) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, button, a")) return;
      if (play.answered) {
        if (event.key === "Enter") {
          event.preventDefault();
          doNext();
        }
        return;
      }
      if (answering) return;
      const item = play.items[play.index];
      const choice = quizShortcutChoice(item, event.key);
      if (choice !== null) {
        event.preventDefault();
        setPlay(prev => prev ? { ...prev, selectedChoice: choice } : prev);
        return;
      }
      if (event.key === "Enter" && play.selectedChoice) {
        event.preventDefault();
        void doAnswer();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, view, play, answering]);

  // ── 다시 풀기 ─────────────────────────────────────────────────────────────────
  async function doRetry() {
    if (!lastOpts) return;
    // stale closure 방지: 직전 설정을 그대로 넘겨 즉시 재출제
    setStartSource(lastOpts.source);
    setStartDiff(lastOpts.diff);
    setStartCount(lastOpts.count);
    setStartWrong(lastOpts.wrong ?? false);
    await runQuiz(lastOpts);
  }

  // ── 틀린 것만 다시 — 이번 세션에서 틀린 바로 그 문제들만 재출제 (재추첨 아님) ─────
  async function doRetryMissed() {
    const missedIds = resultScores.filter(s => !s.correct).map(s => s.id);
    if (missedIds.length === 0) return;
    await runQuiz({ source: "all", diff: "all", count: missedIds.length, questionIds: missedIds });
  }

  // ── 렌더: 플레이 뷰 ──────────────────────────────────────────────────────────
  if (view === "play" && play) {
    const item = play.items[play.index];
    const submittedAnswer = item.qtype === "short" ? play.shortInput : play.selectedChoice ?? "";
    const progress = ((play.index + 1) / play.items.length) * 100;
    const isCorrect = play.result?.correct;

    return (
      <div className="quiz-play">
        <div className="quiz-play-header">
          <button className="btn sm" onClick={returnToBank}>{t("problems.run.stop")}</button>
          <span className="quiz-progress-label">
            {formatNumber(play.index + 1)} / {formatNumber(play.items.length)}
          </span>
        </div>
        <div
          className="quiz-progress-bar"
          role="progressbar"
          aria-label={t("problems.run.progressAria")}
          aria-valuemin={1}
          aria-valuemax={play.items.length}
          aria-valuenow={play.index + 1}
        >
          <div className="quiz-progress-fill" style={{ transform: `scaleX(${progress / 100})` }} />
        </div>
        {/* key=index — 문항이 바뀔 때마다 프레임 재마운트로 전환 애니메이션 */}
        <div className="quiz-question-frame" key={play.index} ref={questionFrameRef} tabIndex={-1}>
        <div className="quiz-chips">
          <span className={`q-chip diff-${item.difficulty}`}>{difficultyLabel(item.difficulty, t)}</span>
          <span className="q-chip qtype">{qtypeLabel(item.qtype, t)}</span>
          {item.src_file_id && (
            <a
              className="q-chip qtype"
              href={bookFileUrl(item.src_file_id, item.src_page)}
              target="_blank"
              rel="noreferrer"
              title={t("problems.run.originalTitle")}
            >
              {t("problems.run.originalView")}
              {item.src_page ? ` p.${formatNumber(item.src_page)}` : ""}
            </a>
          )}
        </div>
        <Md className="quiz-question-text" text={item.question} />
        {item.src_file_id && item.has_figure && (
          <img
            className="quiz-figure"
            width={1200}
            height={900}
            src={pageImageUrl(item.src_file_id, item.src_page, item.figure_box)}
            alt={figureAlt(item.figure_description, item.src_page, undefined, t, formatNumber)}
            loading="eager"
            fetchPriority="high"
          />
        )}
        <QuizScratchpad key={`${item.id}-${play.index}`} questionId={item.id} />

        {!play.answered && (
          <>
            {item.qtype === "mcq" && item.choices && (
              <div className="quiz-choices" role="group" aria-label={t("problems.run.mcqAria")}>
                {item.choices.map((c, i) => (
                  <button
                    key={i}
                    className={`choice-btn${play.selectedChoice === c ? " selected" : ""}`}
                    onClick={() => setPlay(prev => prev ? { ...prev, selectedChoice: c } : prev)}
                    disabled={answering}
                    aria-keyshortcuts={String(i + 1)}
                    aria-pressed={play.selectedChoice === c}
                  >
                    <span className="choice-num" aria-hidden="true">
                      {play.selectedChoice === c ? "✓" : formatNumber(i + 1)}
                    </span>{" "}
                    <MdInlineText text={c} />
                  </button>
                ))}
              </div>
            )}
            {item.qtype === "short" && (
              <div className="quiz-short">
                <input
                  ref={shortAnswerRef}
                  className="text-input"
                  style={{ maxWidth: 420 }}
                  name="short-answer"
                  autoComplete="off"
                  aria-label={t("problems.run.shortAria")}
                  value={play.shortInput}
                  onChange={e => setPlay(prev => prev ? { ...prev, shortInput: e.target.value } : prev)}
                  onKeyDown={onShortKey}
                  disabled={answering}
                  autoFocus={autoFocusInput}
                />
              </div>
            )}
            {item.qtype === "ox" && (
              <div className="quiz-ox" role="group" aria-label={t("problems.run.oxAria")}>
                <button
                  className={`ox-btn${play.selectedChoice === "O" ? " selected" : ""}`}
                  onClick={() => setPlay(prev => prev ? { ...prev, selectedChoice: "O" } : prev)}
                  disabled={answering}
                  aria-keyshortcuts="O"
                  aria-pressed={play.selectedChoice === "O"}
                >O</button>
                <button
                  className={`ox-btn${play.selectedChoice === "X" ? " selected" : ""}`}
                  onClick={() => setPlay(prev => prev ? { ...prev, selectedChoice: "X" } : prev)}
                  disabled={answering}
                  aria-keyshortcuts="X"
                  aria-pressed={play.selectedChoice === "X"}
                >X</button>
              </div>
            )}
            <p className="quiz-shortcut-hint">
              {t(item.qtype === "mcq"
                ? "problems.run.shortcutMcq"
                : item.qtype === "ox" ? "problems.run.shortcutOx" : "problems.run.shortcutShort")}
            </p>
            <div style={{ marginTop: 24 }}>
              {answerErr && <div className="chat-err" role="alert" style={{ marginBottom: 12 }}>{answerErr}</div>}
              <button
                className="btn primary"
                onClick={doAnswer}
                aria-keyshortcuts="Enter"
                disabled={
                  answering ||
                  (item.qtype === "mcq" && !play.selectedChoice) ||
                  (item.qtype === "short" && !play.shortInput.trim()) ||
                  (item.qtype === "ox" && !play.selectedChoice)
                }
              >{t(answering ? "problems.run.grading" : "problems.run.confirm")}</button>
            </div>
          </>
        )}

        {play.answered && play.result && (
          <div
            ref={feedbackRef}
            tabIndex={-1}
            className={`quiz-feedback ${isCorrect ? "correct" : "wrong"}`}
            role="status"
            aria-live="polite"
          >
            <div className="feedback-label">
              {t(isCorrect ? "problems.run.correct" : "problems.run.wrong")}
            </div>
            <div className="feedback-submitted">
              {t("problems.run.myAnswer")} <strong><MdInline text={submittedAnswer} /></strong>
            </div>
            <div className="feedback-answer">
              {t("problems.run.answer")} <strong><MdInline text={play.result.answer} /></strong>
            </div>
            {play.result.explanation && (
              <Md className="feedback-explanation" text={play.result.explanation} />
            )}
            {/* mcq: 채점 후 선택지 표시 */}
            {item.qtype === "mcq" && item.choices && (
              <div className="quiz-choices answered" role="list" aria-label={t("problems.run.gradedAria")}>
                {item.choices.map((c, i) => {
                  // 서버 채점(gradeAnswer)과 동일한 정규화: trim + 소문자 + 공백 축약
                  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
                  const isAnswer = norm(c) === norm(play.result!.answer);
                  const isUserChoice = c === play.selectedChoice;
                  let cls = "choice-btn";
                  if (isAnswer) cls += " correct-choice";
                  else if (isUserChoice && !isCorrect) cls += " wrong-choice";
                  return (
                    <div key={i} className={cls} role="listitem">
                      <span className="choice-num">{formatNumber(i + 1)}</span> <MdInline text={c} />
                      {(isAnswer || isUserChoice) && (
                        <span className="choice-state">
                          {[
                            isAnswer ? t("problems.run.correct") : "",
                            isUserChoice ? t("problems.run.myChoice") : "",
                          ].filter(Boolean).join(" · ")}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <button className="btn primary" style={{ marginTop: 16 }} onClick={doNext} aria-keyshortcuts="Enter">
              {play.index + 1 < play.items.length
                ? <>{t("problems.run.next")} <span aria-hidden="true">→</span></>
                : t("problems.run.results")}
            </button>
          </div>
        )}
        </div>
      </div>
    );
  }

  // ── 렌더: 결과 뷰 ─────────────────────────────────────────────────────────────
  if (view === "result") {
    const correctCount = resultScores.filter(s => s.correct).length;
    const pct = resultScores.length > 0 ? Math.round((correctCount / resultScores.length) * 100) : 0;
    const wrong = resultScores.filter(s => !s.correct);
    return (
      <div className="quiz-result" ref={resultRef} tabIndex={-1}>
        <div className="result-score">
          <span className="result-num">{formatNumber(correctCount)}</span>
          <span className="result-total">/ {formatNumber(resultScores.length)}</span>
          <span className="result-pct">{formatNumber(pct)}%</span>
        </div>
        {wrong.length > 0 && (
          <div className="result-wrong-list">
            <div className="result-wrong-title">{t("problems.run.wrongList")}</div>
            {wrong.map((s, i) => (
              <div key={i} className="result-wrong-item">
                <span className="result-wrong-q"><MdInline text={s.question} /></span>
                <span className="result-wrong-a">{t("problems.run.answer")} <MdInline text={s.answer} /></span>
              </div>
            ))}
          </div>
        )}
        <div className="result-actions">
          {wrong.length > 0 && (
            <button className="btn primary" onClick={doRetryMissed} disabled={startingQuiz}>
              {t(startingQuiz ? "problems.bank.loading" : "problems.run.retryMissed")}
            </button>
          )}
          <button className={`btn${wrong.length === 0 ? " primary" : ""}`} onClick={doRetry} disabled={startingQuiz}>
            {t(startingQuiz ? "problems.bank.loading" : "problems.run.retry")}
          </button>
          <button className="btn" onClick={returnToBank}>{t("problems.run.backToBank")}</button>
        </div>
      </div>
    );
  }

  // ── 렌더: 은행 뷰 ────────────────────────────────────────────────────────────
  return (
    <div className="quiz-bank">
      {/* 요약 */}
      <div className="quiz-summary">
        {t("problems.bank.summary", {
          total: formatNumber(total),
          uploaded: formatNumber(uploadedCount),
          generated: formatNumber(generatedCount),
          low: formatNumber(diffCounts["하"]),
          medium: formatNumber(diffCounts["중"]),
          high: formatNumber(diffCounts["상"]),
        })}
      </div>

      {loadErr && (
        <div className="chat-err" role="alert" style={{ marginBottom: 12 }}>
          {loadErr} <button type="button" onClick={() => void loadBank()}>{t("problems.bank.reload")}</button>
        </div>
      )}
      {bankErr && <div className="chat-err" role="alert" style={{ marginBottom: 12 }}>{bankErr}</div>}

      {/* 퀴즈 시작 컨트롤 */}
      <h2 className="quiz-control-label">{t("problems.bank.conditions")}</h2>
      <div className="quiz-start-row">
        <span className="quiz-range-label">
          {t("problems.bank.range")} · {t(
            allInScope ? "problems.bank.rangeAll" : "problems.bank.rangeSelected",
            { count: problemCountLabel(allInScope ? total : selected.size, t, formatNumber) },
          )}
        </span>
        <SingleSelectPicker
          className="quiz-filter-picker"
          label={t("problems.bank.source")}
          value={startSource}
          options={[
            {
              value: "all",
              label: t("problems.source.all"),
              description: problemCountLabel(total, t, formatNumber),
            },
            {
              value: "uploaded",
              label: t("problems.source.uploaded"),
              description: problemCountLabel(uploadedCount, t, formatNumber),
            },
            {
              value: "generated",
              label: t("problems.source.generated"),
              description: problemCountLabel(generatedCount, t, formatNumber),
            },
          ]}
          onChange={setStartSource}
        />
        <SingleSelectPicker
          className="quiz-filter-picker"
          label={t("problems.bank.difficulty")}
          value={startDiff}
          options={[
            {
              value: "all",
              label: t("problems.source.all"),
              description: problemCountLabel(total, t, formatNumber),
            },
            {
              value: "하",
              label: t("problems.difficulty.low"),
              description: problemCountLabel(diffCounts["하"], t, formatNumber),
            },
            {
              value: "중",
              label: t("problems.difficulty.medium"),
              description: problemCountLabel(diffCounts["중"], t, formatNumber),
            },
            {
              value: "상",
              label: t("problems.difficulty.high"),
              description: problemCountLabel(diffCounts["상"], t, formatNumber),
            },
          ]}
          onChange={setStartDiff}
        />
        <SingleSelectPicker
          className="quiz-filter-picker quiz-count-picker"
          label={t("problems.bank.questionCount")}
          value={String(startCount)}
          options={quizCountOptions}
          onChange={(value) => setStartCount(Number(value))}
        />
        <label className="quiz-check-label" style={{ marginLeft: 4 }}>
          <input
            type="checkbox"
            checked={startWrong}
            onChange={e => setStartWrong(e.target.checked)}
          />
          {t("problems.bank.wrongOnly")}
        </label>
        <button
          ref={startButtonRef}
          className="btn primary sm"
          onClick={startQuiz}
          disabled={eligibleStartCount === 0 || startingQuiz || pendingDelete !== null}
        >{t(startingQuiz ? "problems.bank.loading" : "problems.bank.start")}</button>
        <span className={`quiz-plan${eligibleStartCount === 0 ? " empty" : ""}`} role="status" aria-live="polite">
          {eligibleStartCount === 0
            ? t("problems.bank.noEligible")
            : t("problems.bank.plan", {
              eligible: problemCountLabel(eligibleStartCount, t, formatNumber),
              planned: problemCountLabel(plannedStartCount, t, formatNumber),
            })}
        </span>
      </div>

      {/* 문제 추가 — 파일에서의 문제 등록은 사이드바 문제집화가 담당 */}
      <details
        className="quiz-generate-disclosure"
        key={subject.id}
        open={generationOpen}
        onToggle={event => setGenerationOpen(event.currentTarget.open)}
      >
        <summary>
          <span>{t("problems.generation.create")}</span>
          <small>
            {generationJobIds.length > 0
              ? t("problems.generation.activeJobs", { count: formatNumber(generationJobIds.length) })
              : t("problems.generation.createDescription")}
          </small>
        </summary>
        <div className="quiz-add-row">
          <div className="quiz-add-section">
            <div className="quiz-generation-scope">
              {readyMaterials.length > 0 ? (
                <SourcePicker
                  label={t("problems.generation.sources")}
                  materials={readyMaterials}
                  excluded={genExcluded}
                  onToggle={toggleGenerationMaterial}
                  onSetVisible={setGenerationMaterialsVisible}
                />
              ) : (
                <>
                  <span className="quiz-generation-label">{t("problems.generation.sources")}</span>
                  <span className="quiz-status-msg">{t("problems.generation.noReady")}</span>
                </>
              )}
            </div>
            <label className="quiz-number-field">
              <span>{t("problems.bank.questionCount")}</span>
              <input
                type="number"
                className="quiz-count-input"
                name="generation-count"
                autoComplete="off"
                min={1}
                max={20}
                value={genCount}
                onChange={e => setGenCount(Math.max(1, Math.min(20, Number(e.target.value) || 5)))}
              />
            </label>
            <div className="quiz-control-field">
              <SingleSelectPicker
                className="quiz-filter-picker"
                label={t("problems.bank.difficulty")}
                value={genDiff}
                options={[
                  { value: "혼합", label: t("problems.difficulty.mixed") },
                  { value: "하", label: t("problems.difficulty.low") },
                  { value: "중", label: t("problems.difficulty.medium") },
                  { value: "상", label: t("problems.difficulty.high") },
                ]}
                onChange={setGenDiff}
              />
            </div>
            <button
              className="btn sm"
              onClick={doGenerate}
              disabled={genStarting || genMaterialIds.size === 0}
            >{t(genStarting ? "problems.generation.starting" : "problems.generation.generate")}</button>
            {generationJobIds.length > 0 && (
              <div className="pending-action-row">
                <AiPending
                  label={t("problems.generation.progress", {
                    count: formatNumber(generationJobIds.length),
                  })}
                />
              </div>
            )}
            {genMsgs.map((msg, index) => (
              <span
                key={`${index}-${msg.key}-${msg.count ?? ""}`}
                className={`quiz-status-msg${msg.ok ? " ok" : ""}`}
                role="status"
                aria-live="polite"
              >
                {t(msg.key, msg.count === undefined
                  ? undefined
                  : { count: problemCountLabel(msg.count, t, formatNumber) })}
              </span>
            ))}
          </div>
        </div>
      </details>

      <details className="context-help quiz-help">
        <summary>{t("problems.help.summary")}</summary>
        <p>{t("problems.help.text")}</p>
      </details>

      {/* 문제 목록 */}
      {loading && (
        <div className="quiz-status-msg" role="status" aria-live="polite" style={{ marginTop: 16 }}>
          {t("problems.bank.loading")}
        </div>
      )}

      {!loading && bankQs.length > 0 && (
        <div className="quiz-list">
          <div className="quiz-list-header">
            <label className="quiz-check-label">
              <input
                type="checkbox"
                checked={allInScope}
                ref={el => { if (el) el.indeterminate = !allInScope && selected.size > 0; }}
                onChange={toggleAll}
              />
              {t("problems.list.all")}
            </label>
            <div className="quiz-list-actions">
              <button className="btn sm" onClick={() => doPrint("question")}>
                {t("problems.list.printQuestion")}
              </button>
              <button className="btn sm" onClick={() => doPrint("answer")}>
                {t("problems.list.printAnswer")}
              </button>
            </div>
          </div>

          {groups.map((g, groupIndex) => {
            const open = openGroups.has(g.key) || groups.length === 1; // 그룹 하나뿐이면 항상 펼침
            const gsel = allInScope ? g.items.length : g.items.filter(q => selected.has(q.id)).length;
            return (
              <div key={g.key} className="quiz-file-group">
                <div className="quiz-file-head">
                  <label
                    className="quiz-check-label quiz-file-select"
                    title={t("problems.list.materialAllTitle")}
                  >
                    <input
                      type="checkbox"
                      checked={gsel === g.items.length}
                      ref={el => { if (el) el.indeterminate = gsel > 0 && gsel < g.items.length; }}
                      onChange={() => toggleGroupSelection(g.items)}
                      aria-label={t("problems.list.groupSelectAria", { file: g.label })}
                    />
                    <span>{t("problems.list.materialAll")}</span>
                  </label>
                  <button
                    className="quiz-file-toggle"
                    onClick={() => toggleGroup(g.key)}
                    aria-expanded={open}
                    aria-controls={`quiz-file-panel-${groupIndex}`}
                    title={t("problems.list.toggleTitle")}
                  >
                    <span className={`quiz-file-chev${open ? " open" : ""}`} aria-hidden="true">⌄</span>
                    <span className="quiz-file-name">{g.label}</span>
                    <span className="quiz-file-count">
                      {allInScope
                        ? problemCountLabel(g.items.length, t, formatNumber)
                        : t("problems.count.many", {
                          count: `${formatNumber(gsel)}/${formatNumber(g.items.length)}`,
                        })}
                    </span>
                  </button>
                </div>

                <div id={`quiz-file-panel-${groupIndex}`} className="quiz-file-panel" hidden={!open}>
                {open && g.items.map(q => (
                  <div key={q.id} className="quiz-row">
                    <label className="quiz-check-label quiz-check-box" title={t("problems.list.selectTitle")}>
                      <input
                        type="checkbox"
                        checked={allInScope || selected.has(q.id)}
                        onChange={() => toggleSelect(q.id)}
                        aria-label={t("problems.select.aria", { question: q.question.slice(0, 40) })}
                      />
                    </label>
                    <span className="q-chip qtype">{qtypeLabel(q.qtype, t)}</span>
                    <span className={`q-chip diff-${q.difficulty}`}>{difficultyLabel(q.difficulty, t)}</span>
                    <button
                      type="button"
                      className="quiz-q-text"
                      onClick={() => toggleExpand(q.id)}
                      title={t("problems.list.detailsTitle")}
                      aria-expanded={expanded.has(q.id)}
                      aria-controls={`quiz-question-detail-${q.id}`}
                    ><MdInlineText text={q.question} /></button>
                    <span className="quiz-accuracy">{accuracyLabel(q, t, formatNumber)}</span>
                    <button
                      className="del-btn"
                      aria-label={pendingDelete?.key === `question:${q.id}`
                        ? t("problems.delete.pending")
                        : t("problems.delete.aria", { question: q.question.slice(0, 40) })}
                      disabled={pendingDelete !== null}
                      onClick={() => doDelete(q.id)}
                    >✕</button>

                    <div
                      className="quiz-row-detail"
                      id={`quiz-question-detail-${q.id}`}
                      hidden={!expanded.has(q.id)}
                    >
                      {expanded.has(q.id) && (
                        <>
                        <Md className="quiz-row-full-q" text={q.question} />
                        {q.choices && (
                          <ol className="quiz-row-choices">
                            {q.choices.map((c, i) => <li key={i}><MdInline text={c} /></li>)}
                          </ol>
                        )}
                        <div className="quiz-row-answer">
                          {t("problems.run.answer")} <strong><MdInline text={q.answer} /></strong>
                        </div>
                        {q.explanation ? (
                          <Md className="quiz-row-explanation" text={q.explanation} />
                        ) : (
                          <div className="quiz-row-expl-gen">
                            {explGenBusy.has(q.id) ? (
                              <AiPending label={t("problems.explanation.pending")} />
                            ) : (
                              <button
                                type="button"
                                className="btn sm"
                                onClick={() => void generateExplanation(q.id)}
                              >{t("problems.explanation.generate")}</button>
                            )}
                            {explGenNotice.has(q.id) && (
                              <span className={`expl-gen-notice ${explGenNotice.get(q.id)!.tone}`} role="status">
                                {explGenNotice.get(q.id)!.text}
                              </span>
                            )}
                          </div>
                        )}
                        {q.src_file_id && q.has_figure === 1 && (
                          <img
                            className="quiz-figure compact"
                            width={1200}
                            height={900}
                            src={pageImageUrl(q.src_file_id, q.src_page, q.figure_box)}
                            alt={figureAlt(q.figure_description, q.src_page, undefined, t, formatNumber)}
                            loading="lazy"
                          />
                        )}
                        {q.src_file_id && (
                          <a className="q-chip qtype" href={bookFileUrl(q.src_file_id, q.src_page)} target="_blank" rel="noreferrer">
                            {t("problems.run.originalView")}
                            {q.src_page ? ` p.${formatNumber(q.src_page)}` : ""}
                          </a>
                        )}
                        </>
                      )}
                    </div>
                  </div>
                ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!loading && bankQs.length === 0 && (
        <div className="quiz-empty">{t("problems.bank.empty")}</div>
      )}
    </div>
  );
}
