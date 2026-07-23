// Quiz.tsx — 퀴즈 탭 컴포넌트 (은행 / 플레이 / 결과)
import { useState, useEffect, useRef, useMemo, KeyboardEvent } from "react";
import { useEscape } from "../escape";
import {
  Subject, Material, Question, QuizItem, AnswerResult,
  questions as apiQuestions,
  generateQuestions as apiGenerate,
  aiJob as apiAIJob,
  cancelAIJob,
  quiz as apiQuiz,
  answerQuestion as apiAnswer,
  deleteQuestion as apiDeleteQuestion,
  generateQuestionExplanation as apiGenerateQuestionExplanation,
  bookFileUrl,
  pageImageUrl,
  NotFoundError,
} from "../api";
import { escapeHtmlText, Md, MdInline, MdInlineText, mdInlineHtml } from "../md";
import SourcePicker from "./SourcePicker";
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

function storedGenerationJob(subjectId: number): number | null {
  try {
    const raw = sessionStorage.getItem(generationJobKey(subjectId));
    const id = raw ? Number(raw) : NaN;
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

export function qtypeLabel(q: string) {
  return q === "mcq" ? "객관식" : q === "short" ? "단답" : "OX";
}

export function quizShortcutChoice(item: Pick<QuizItem, "qtype" | "choices">, key: string): string | null {
  if (item.qtype === "ox" && /^[ox]$/i.test(key)) return key.toUpperCase();
  if (item.qtype !== "mcq" || !item.choices || !/^[1-9]$/.test(key)) return null;
  return item.choices[Number(key) - 1] ?? null;
}

function accuracyLabel(q: Question): string {
  const total = q.correct_count + q.wrong_count;
  if (total === 0) return "기록 없음";
  return `정답 ${q.correct_count}/${total}`;
}

export function figureAlt(description: string | null, page: number | null, number?: number): string {
  return description?.trim() || `${number ? `${number}번 ` : ""}문제 풀이에 필요한 원본 도형 또는 그림 — p.${page ?? 1}`;
}

// ── 인쇄 헬퍼 ──────────────────────────────────────────────────────────────────
function printQuestions(subjectName: string, qs: Question[], type: "question" | "answer"): string | null {
  let win: Window | null;
  try {
    win = window.open("", "_blank");
  } catch {
    win = null;
  }
  if (!win) {
    return "인쇄 창이 차단됐습니다. 이 사이트의 팝업을 허용한 뒤 다시 인쇄해 주세요.";
  }
  try {
    win.opener = null;
  } catch {
    // 일부 브라우저는 opener 쓰기를 막는다. 출력 자체는 계속 가능하다.
  }
  const title = `${escapeHtmlText(subjectName)} ${type === "question" ? "문제지" : "정답지"}`;
  const body = qs
    .map((q, i) => {
      const num = i + 1;
      if (type === "question") {
        let html = `<div class="q-block"><p class="q-num">${num}.</p><p class="q-text">${mdInlineHtml(q.question)}</p>`;
        if (q.src_file_id && q.has_figure) {
          const src = escapeHtmlText(new URL(pageImageUrl(q.src_file_id, q.src_page, q.figure_box), window.location.origin).href);
          const alt = escapeHtmlText(figureAlt(q.figure_description, q.src_page, num));
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

  win.document.write(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>${title}</title>
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
  const { pending: pendingDelete, schedule: scheduleDelete } = useUndoDelete();
  const autoFocusInput = typeof window.matchMedia !== "function" || window.matchMedia("(pointer: fine)").matches;
  const initialFilters = useMemo(() => parseQuizFilters(window.location.search), []);
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

  // 은행 - AI 생성
  const [genCount, setGenCount] = useState(5);
  const [genDiff, setGenDiff] = useState("혼합");
  const [generating, setGenerating] = useState(false);
  const [cancellingGeneration, setCancellingGeneration] = useState(false);
  const [genMsg, setGenMsg] = useState("");
  const [generationJobId, setGenerationJobId] = useState<number | null>(() => storedGenerationJob(subject.id));
  const [generationOpen, setGenerationOpen] = useState(() => storedGenerationJob(subject.id) !== null);
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
      setLoadErr(e instanceof Error ? e.message : "문제 불러오기 실패");
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
    const savedJobId = storedGenerationJob(subject.id);
    setGenerationJobId(savedJobId);
    setGenerationOpen(savedJobId !== null);
    setGenerating(savedJobId !== null);
    setGenMsg(savedJobId !== null ? "진행 중인 문제 생성을 이어서 확인합니다." : "");
    void loadBank();
  }, [subject.id]);

  useEffect(() => {
    if (generationJobId === null) return;
    const polledSubjectId = subject.id;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setGenerating(true);

    const poll = async () => {
      try {
        const job = await apiAIJob<{ added: number }>(generationJobId);
        if (stopped) return;
        if (job.subject_id !== polledSubjectId) {
          try { sessionStorage.removeItem(generationJobKey(polledSubjectId)); } catch {}
          setGenerationJobId(null);
          setGenerating(false);
          setGenMsg("");
          setBankErr("이 과목의 문제 생성 작업이 아닙니다. 다시 생성해 주세요.");
          return;
        }
        if (job.status === "processing") {
          timer = setTimeout(poll, 2500);
          return;
        }
        try { sessionStorage.removeItem(generationJobKey(polledSubjectId)); } catch {}
        setGenerationJobId(null);
        setGenerating(false);
        if (job.status === "error") {
          if (job.error === "사용자 중단") {
            setGenMsg("문제 생성을 중단했습니다.");
            setBankErr("");
          } else {
            setGenMsg("");
            setBankErr(job.error || "문제 생성에 실패했습니다.");
          }
          return;
        }
        const added = job.result?.added ?? 0;
        setBankErr("");
        setGenMsg(`${added}문제 추가됨`);
        await loadBank();
        if (stopped) return;
        timer = setTimeout(() => {
          if (!stopped && subjectIdRef.current === polledSubjectId) setGenMsg("");
        }, 3000);
      } catch (error) {
        if (stopped) return;
        if (error instanceof NotFoundError) {
          try { sessionStorage.removeItem(generationJobKey(polledSubjectId)); } catch {}
          setGenerationJobId(null);
          setGenerating(false);
          setGenMsg("");
          setBankErr("이전 문제 생성 작업을 찾을 수 없습니다. 다시 생성해 주세요.");
          return;
        }
        setBankErr(error instanceof Error ? `${error.message} · 작업 상태를 다시 확인합니다.` : "작업 상태 확인 실패 · 다시 확인합니다.");
        timer = setTimeout(poll, 5000);
      }
    };

    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [generationJobId, subject.id]);

  // ── 파일(자료)별 그룹 — 드롭다운으로 접었다 폈다 ────────────────────────────────
  const groups = useMemo(() => {
    const m = new Map<number, { key: number; label: string; items: Question[] }>();
    for (const q of bankQs) {
      const key = q.src_file_id ?? 0; // 0 = 원본 파일 없는 문제(AI 생성 등)
      let g = m.get(key);
      if (!g) {
        g = { key, label: q.src_file_id ? (q.src_file_name ?? `파일 #${q.src_file_id}`) : "직접 생성·기타", items: [] };
        m.set(key, g);
      }
      g.items.push(q);
    }
    return [...m.values()];
  }, [bankQs]);
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

  // ── AI 생성 ───────────────────────────────────────────────────────────────────
  async function doGenerate() {
    if (genMaterialIds.size === 0) {
      setBankErr("문제를 만들 기준 자료를 하나 이상 선택하세요.");
      return;
    }
    setGenerating(true);
    setGenMsg("");
    setBankErr("");
    const requestedSubjectId = subject.id;
    try {
      const { jobId } = await apiGenerate(requestedSubjectId, genCount, genDiff, [...genMaterialIds]);
      try { sessionStorage.setItem(generationJobKey(requestedSubjectId), String(jobId)); } catch {}
      if (!mountedRef.current || subjectIdRef.current !== requestedSubjectId) return;
      setGenerationJobId(jobId);
      setGenMsg("서버에서 생성 중 · 다른 탭으로 이동해도 계속됩니다.");
    } catch (e) {
      if (!mountedRef.current || subjectIdRef.current !== requestedSubjectId) return;
      setGenMsg("");
      setBankErr(e instanceof Error ? e.message : "생성 실패");
      setGenerating(false);
    }
  }

  async function stopGeneration() {
    if (generationJobId === null || cancellingGeneration) return;
    setCancellingGeneration(true);
    setBankErr("");
    try {
      await cancelAIJob(generationJobId);
      setGenMsg("문제 생성 중단 요청을 보냈습니다.");
    } catch (error) {
      setBankErr(error instanceof Error ? error.message : "문제 생성을 중단하지 못했습니다.");
    } finally {
      if (mountedRef.current) setCancellingGeneration(false);
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
        setBankErr("조건에 맞는 문제가 없습니다.");
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
      setBankErr(e instanceof Error ? e.message : "퀴즈 시작 실패");
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
      setBankErr(selected.size === 0
        ? "풀 범위를 먼저 선택하세요."
        : "선택 범위에 현재 난이도·출처·오답 조건과 맞는 문제가 없습니다.");
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
      label: question ? `“${question.question.slice(0, 28)}” 문제` : "문제",
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
        setExplGenNotice(prev => new Map(prev).set(id, { tone: "warn", text: "정답 불일치 — 검토 필요" }));
      }
    } catch (e) {
      if (!mountedRef.current) return;
      setExplGenNotice(prev => new Map(prev).set(id, {
        tone: "bad",
        text: e instanceof Error ? e.message : "AI 해설 생성에 실패했습니다.",
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
    const error = printQuestions(subject.name, targets, type);
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
        setAnswerErr(e instanceof Error ? e.message : "채점 실패");
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
          <button className="btn sm" onClick={returnToBank}>그만두기</button>
          <span className="quiz-progress-label">{play.index + 1} / {play.items.length}</span>
        </div>
        <div
          className="quiz-progress-bar"
          role="progressbar"
          aria-label="퀴즈 진행률"
          aria-valuemin={1}
          aria-valuemax={play.items.length}
          aria-valuenow={play.index + 1}
        >
          <div className="quiz-progress-fill" style={{ transform: `scaleX(${progress / 100})` }} />
        </div>
        {/* key=index — 문항이 바뀔 때마다 프레임 재마운트로 전환 애니메이션 */}
        <div className="quiz-question-frame" key={play.index} ref={questionFrameRef} tabIndex={-1}>
        <div className="quiz-chips">
          <span className={`q-chip diff-${item.difficulty}`}>{item.difficulty}</span>
          <span className="q-chip qtype">{qtypeLabel(item.qtype)}</span>
          {item.src_file_id && (
            <a
              className="q-chip qtype"
              href={bookFileUrl(item.src_file_id, item.src_page)}
              target="_blank"
              rel="noreferrer"
              title="문제집 원본 페이지 보기 — 도형·그림이 있는 문제는 원본으로 확인"
            >원본 보기{item.src_page ? ` p.${item.src_page}` : ""}</a>
          )}
        </div>
        <Md className="quiz-question-text" text={item.question} />
        {item.src_file_id && item.has_figure && (
          <img
            className="quiz-figure"
            width={1200}
            height={900}
            src={pageImageUrl(item.src_file_id, item.src_page, item.figure_box)}
            alt={figureAlt(item.figure_description, item.src_page)}
            loading="eager"
            fetchPriority="high"
          />
        )}

        {!play.answered && (
          <>
            {item.qtype === "mcq" && item.choices && (
              <div className="quiz-choices" role="group" aria-label="객관식 답안">
                {item.choices.map((c, i) => (
                  <button
                    key={i}
                    className={`choice-btn${play.selectedChoice === c ? " selected" : ""}`}
                    onClick={() => setPlay(prev => prev ? { ...prev, selectedChoice: c } : prev)}
                    disabled={answering}
                    aria-keyshortcuts={String(i + 1)}
                    aria-pressed={play.selectedChoice === c}
                  >
                    <span className="choice-num" aria-hidden="true">{play.selectedChoice === c ? "✓" : i + 1}</span> <MdInlineText text={c} />
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
                  aria-label="단답형 답안"
                  value={play.shortInput}
                  onChange={e => setPlay(prev => prev ? { ...prev, shortInput: e.target.value } : prev)}
                  onKeyDown={onShortKey}
                  disabled={answering}
                  autoFocus={autoFocusInput}
                />
              </div>
            )}
            {item.qtype === "ox" && (
              <div className="quiz-ox" role="group" aria-label="OX 답안">
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
              {item.qtype === "mcq" ? "1–9 선택 · Enter 확인" : item.qtype === "ox" ? "O/X 선택 · Enter 확인" : "Enter 확인"}
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
              >{answering ? "채점 중…" : "확인"}</button>
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
            <div className="feedback-label">{isCorrect ? "정답" : "오답"}</div>
            <div className="feedback-submitted">내 답: <strong><MdInline text={submittedAnswer} /></strong></div>
            <div className="feedback-answer">정답: <strong><MdInline text={play.result.answer} /></strong></div>
            {play.result.explanation && (
              <Md className="feedback-explanation" text={play.result.explanation} />
            )}
            {/* mcq: 채점 후 선택지 표시 */}
            {item.qtype === "mcq" && item.choices && (
              <div className="quiz-choices answered" role="list" aria-label="채점된 객관식 답안">
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
                      <span className="choice-num">{i + 1}</span> <MdInline text={c} />
                      {(isAnswer || isUserChoice) && (
                        <span className="choice-state">
                          {[isAnswer ? "정답" : "", isUserChoice ? "내 선택" : ""].filter(Boolean).join(" · ")}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <button className="btn primary" style={{ marginTop: 16 }} onClick={doNext} aria-keyshortcuts="Enter">
              {play.index + 1 < play.items.length ? <>다음 <span aria-hidden="true">→</span></> : "결과 보기"}
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
          <span className="result-num">{correctCount}</span>
          <span className="result-total">/ {resultScores.length}</span>
          <span className="result-pct">{pct}%</span>
        </div>
        {wrong.length > 0 && (
          <div className="result-wrong-list">
            <div className="result-wrong-title">틀린 문제</div>
            {wrong.map((s, i) => (
              <div key={i} className="result-wrong-item">
                <span className="result-wrong-q"><MdInline text={s.question} /></span>
                <span className="result-wrong-a">정답: <MdInline text={s.answer} /></span>
              </div>
            ))}
          </div>
        )}
        <div className="result-actions">
          {wrong.length > 0 && (
            <button className="btn primary" onClick={doRetryMissed} disabled={startingQuiz}>
              {startingQuiz ? "불러오는 중…" : "틀린 것만 다시"}
            </button>
          )}
          <button className={`btn${wrong.length === 0 ? " primary" : ""}`} onClick={doRetry} disabled={startingQuiz}>
            {startingQuiz ? "불러오는 중…" : "다시 풀기"}
          </button>
          <button className="btn" onClick={returnToBank}>문제 은행으로</button>
        </div>
      </div>
    );
  }

  // ── 렌더: 은행 뷰 ────────────────────────────────────────────────────────────
  return (
    <div className="quiz-bank">
      {/* 요약 */}
      <div className="quiz-summary">
        총 {total}문제 · 자료 추출 {uploadedCount} · 직접 생성 {generatedCount} · 하 {diffCounts["하"]} / 중 {diffCounts["중"]} / 상 {diffCounts["상"]}
      </div>

      {loadErr && (
        <div className="chat-err" role="alert" style={{ marginBottom: 12 }}>
          {loadErr} <button type="button" onClick={() => void loadBank()}>문제 다시 불러오기</button>
        </div>
      )}
      {bankErr && <div className="chat-err" role="alert" style={{ marginBottom: 12 }}>{bankErr}</div>}

      {/* 퀴즈 시작 컨트롤 */}
      <h2 className="quiz-control-label">출제 조건</h2>
      <div className="quiz-start-row">
        <span className="quiz-range-label">
          범위 · {allInScope ? `전체 ${total}문제` : `선택 ${selected.size}문제`}
        </span>
        <label className="quiz-control-field">
          <span>출처</span>
          <select className="quiz-select" value={startSource} onChange={e => setStartSource(e.target.value)}>
            <option value="all">전체</option>
            <option value="uploaded">업로드</option>
            <option value="generated">직접 생성</option>
          </select>
        </label>
        <label className="quiz-control-field">
          <span>난이도</span>
          <select className="quiz-select" value={startDiff} onChange={e => setStartDiff(e.target.value)}>
            <option value="all">전체</option>
            <option value="하">하</option>
            <option value="중">중</option>
            <option value="상">상</option>
          </select>
        </label>
        <label className="quiz-number-field">
          <span>문항 수</span>
          <input
            type="number"
            className="quiz-count-input"
            name="quiz-count"
            autoComplete="off"
            min={1}
            max={50}
            value={startCount}
            onChange={e => setStartCount(Math.max(1, Math.min(50, Number(e.target.value) || 10)))}
          />
        </label>
        <label className="quiz-check-label" style={{ marginLeft: 4 }}>
          <input
            type="checkbox"
            checked={startWrong}
            onChange={e => setStartWrong(e.target.checked)}
          />
          오답만
        </label>
        <button
          ref={startButtonRef}
          className="btn primary sm"
          onClick={startQuiz}
          disabled={eligibleStartCount === 0 || startingQuiz || pendingDelete !== null}
        >{startingQuiz ? "불러오는 중…" : "퀴즈 시작"}</button>
        <span className={`quiz-plan${eligibleStartCount === 0 ? " empty" : ""}`} role="status" aria-live="polite">
          {eligibleStartCount === 0 ? "조건에 맞는 문제 없음" : `${eligibleStartCount}문제 일치 · ${plannedStartCount}문제 출제`}
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
          <span>문제 만들기</span>
          <small>{generating ? "생성 중…" : "선택 자료로 새 문제 만들기"}</small>
        </summary>
        <div className="quiz-add-row">
          <div className="quiz-add-section">
            <div className="quiz-generation-scope">
              {readyMaterials.length > 0 ? (
                <SourcePicker
                  label="생성 기준 자료"
                  materials={readyMaterials}
                  excluded={genExcluded}
                  onToggle={toggleGenerationMaterial}
                  onSetVisible={setGenerationMaterialsVisible}
                />
              ) : (
                <>
                  <span className="quiz-generation-label">생성 기준 자료</span>
                  <span className="quiz-status-msg">준비된 자료 없음</span>
                </>
              )}
            </div>
            <label className="quiz-number-field">
              <span>문항 수</span>
              <input
                type="number"
                className="quiz-count-input"
                name="generation-count"
                autoComplete="off"
                min={1}
                max={20}
                value={genCount}
                onChange={e => setGenCount(Math.max(1, Math.min(20, Number(e.target.value) || 5)))}
                disabled={generating}
              />
            </label>
            <label className="quiz-control-field">
              <span>난이도</span>
              <select className="quiz-select" value={genDiff} onChange={e => setGenDiff(e.target.value)} disabled={generating}>
                <option value="혼합">혼합</option>
                <option value="하">하</option>
                <option value="중">중</option>
                <option value="상">상</option>
              </select>
            </label>
            <button
              className="btn sm"
              onClick={doGenerate}
              disabled={generating || genMaterialIds.size === 0}
            >문제 생성</button>
            {generating && (
              <div className="pending-action-row">
                <AiPending label="문제 생성 중 · 다른 탭으로 이동해도 계속됩니다" />
                {generationJobId !== null && (
                  <button type="button" className="btn sm" onClick={() => void stopGeneration()} disabled={cancellingGeneration}>
                    {cancellingGeneration ? "중단 중…" : "생성 중단"}
                  </button>
                )}
              </div>
            )}
            {genMsg && (
              <span className={`quiz-status-msg${genMsg.includes("추가됨") ? " ok" : ""}`} role="status" aria-live="polite">{genMsg}</span>
            )}
          </div>
        </div>
      </details>

      <details className="context-help quiz-help">
        <summary>퀴즈 사용법과 단축키</summary>
        <p>범위·출처·난이도를 고르면 실제 출제 수가 바로 표시됩니다. 풀이 중 숫자키로 객관식을, O/X로 진위를 고르고 Enter로 확인하거나 다음 문제로 이동할 수 있습니다.</p>
      </details>

      {/* 문제 목록 */}
      {loading && <div className="quiz-status-msg" role="status" aria-live="polite" style={{ marginTop: 16 }}>불러오는 중…</div>}

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
              전체 문제
            </label>
            <div className="quiz-list-actions">
              <button className="btn sm" onClick={() => doPrint("question")}>문제지 인쇄</button>
              <button className="btn sm" onClick={() => doPrint("answer")}>정답지 인쇄</button>
            </div>
          </div>

          {groups.map((g, groupIndex) => {
            const open = openGroups.has(g.key) || groups.length === 1; // 그룹 하나뿐이면 항상 펼침
            const gsel = allInScope ? g.items.length : g.items.filter(q => selected.has(q.id)).length;
            return (
              <div key={g.key} className="quiz-file-group">
                <div className="quiz-file-head">
                  <label className="quiz-check-label quiz-file-select" title="이 자료의 문제 전체 선택">
                    <input
                      type="checkbox"
                      checked={gsel === g.items.length}
                      ref={el => { if (el) el.indeterminate = gsel > 0 && gsel < g.items.length; }}
                      onChange={() => toggleGroupSelection(g.items)}
                      aria-label={`${g.label} 문제 전체 선택`}
                    />
                    <span>자료 전체</span>
                  </label>
                  <button
                    className="quiz-file-toggle"
                    onClick={() => toggleGroup(g.key)}
                    aria-expanded={open}
                    aria-controls={`quiz-file-panel-${groupIndex}`}
                    title="클릭해서 이 파일의 문제 열기/닫기"
                  >
                    <span className={`quiz-file-chev${open ? " open" : ""}`} aria-hidden="true">⌄</span>
                    <span className="quiz-file-name">{g.label}</span>
                    <span className="quiz-file-count">{allInScope ? g.items.length : `${gsel}/${g.items.length}`}문제</span>
                  </button>
                </div>

                <div id={`quiz-file-panel-${groupIndex}`} className="quiz-file-panel" hidden={!open}>
                {open && g.items.map(q => (
                  <div key={q.id} className="quiz-row">
                    <label className="quiz-check-label quiz-check-box" title="이 문제 선택">
                      <input
                        type="checkbox"
                        checked={allInScope || selected.has(q.id)}
                        onChange={() => toggleSelect(q.id)}
                        aria-label={`문제 선택: ${q.question.slice(0, 40)}`}
                      />
                    </label>
                    <span className={`q-chip qtype`}>{qtypeLabel(q.qtype)}</span>
                    <span className={`q-chip diff-${q.difficulty}`}>{q.difficulty}</span>
                    <button
                      type="button"
                      className="quiz-q-text"
                      onClick={() => toggleExpand(q.id)}
                      title="클릭하면 상세 보기"
                      aria-expanded={expanded.has(q.id)}
                      aria-controls={`quiz-question-detail-${q.id}`}
                    ><MdInlineText text={q.question} /></button>
                    <span className="quiz-accuracy">{accuracyLabel(q)}</span>
                    <button
                      className="del-btn"
                      aria-label={pendingDelete?.key === `question:${q.id}` ? "이 문제 삭제 예정" : `문제 삭제: ${q.question.slice(0, 40)}`}
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
                        <div className="quiz-row-answer">정답: <strong><MdInline text={q.answer} /></strong></div>
                        {q.explanation ? (
                          <Md className="quiz-row-explanation" text={q.explanation} />
                        ) : (
                          <div className="quiz-row-expl-gen">
                            {explGenBusy.has(q.id) ? (
                              <AiPending label="AI 해설 생성 중" />
                            ) : (
                              <button
                                type="button"
                                className="btn sm"
                                onClick={() => void generateExplanation(q.id)}
                              >AI 해설 생성</button>
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
                            alt={figureAlt(q.figure_description, q.src_page)}
                            loading="lazy"
                          />
                        )}
                        {q.src_file_id && (
                          <a className="q-chip qtype" href={bookFileUrl(q.src_file_id, q.src_page)} target="_blank" rel="noreferrer">
                            원본 보기{q.src_page ? ` p.${q.src_page}` : ""}
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
        <div className="quiz-empty">문제가 없습니다. 업로드하거나 AI로 생성하세요.</div>
      )}
    </div>
  );
}
