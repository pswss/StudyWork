import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useI18n, type MessageKey } from "../i18n";

export type ScratchpadTool = "pen" | "eraser";

export interface ScratchpadPoint {
  x: number;
  y: number;
  pressure: number;
}

export interface ScratchpadStroke {
  tool: ScratchpadTool;
  points: ScratchpadPoint[];
}

interface ScratchpadHistory {
  strokes: ScratchpadStroke[];
  history: ScratchpadStroke[][];
}

export interface ScratchpadStoredState {
  strokes: ScratchpadStroke[];
  memo: string;
}

interface QuizScratchpadProps {
  questionId: number;
}

const MAX_STROKES = 160;
const MAX_POINTS_PER_STROKE = 1_200;
const MAX_HISTORY = 50;
const MAX_MEMO_LENGTH = 8_000;
const SCRATCHPAD_STORAGE_PREFIX = "studywork:quiz-scratchpad:";

export function scratchpadStorageKey(questionId: number): string {
  return `${SCRATCHPAD_STORAGE_PREFIX}${questionId}`;
}

function normalizeScratchpadStrokes(value: unknown): ScratchpadStroke[] {
  if (!Array.isArray(value)) return [];
  const strokes: ScratchpadStroke[] = [];
  for (const valueStroke of value.slice(-MAX_STROKES)) {
    if (!valueStroke || typeof valueStroke !== "object") continue;
    const candidate = valueStroke as { tool?: unknown; points?: unknown };
    if ((candidate.tool !== "pen" && candidate.tool !== "eraser") || !Array.isArray(candidate.points)) continue;
    const points: ScratchpadPoint[] = [];
    for (const valuePoint of candidate.points.slice(0, MAX_POINTS_PER_STROKE)) {
      if (!valuePoint || typeof valuePoint !== "object") continue;
      const point = valuePoint as { x?: unknown; y?: unknown; pressure?: unknown };
      if (
        typeof point.x !== "number"
        || typeof point.y !== "number"
        || typeof point.pressure !== "number"
        || !Number.isFinite(point.x)
        || !Number.isFinite(point.y)
        || !Number.isFinite(point.pressure)
      ) continue;
      points.push({
        x: Math.min(1, Math.max(0, point.x)),
        y: Math.min(1, Math.max(0, point.y)),
        pressure: Math.min(1, Math.max(0, point.pressure)),
      });
    }
    if (points.length > 0) strokes.push({ tool: candidate.tool, points });
  }
  return strokes;
}

export function decodeScratchpadState(raw: string | null): ScratchpadStoredState {
  if (!raw) return { strokes: [], memo: "" };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { strokes: normalizeScratchpadStrokes(parsed), memo: "" };
    }
    if (!parsed || typeof parsed !== "object") return { strokes: [], memo: "" };
    const candidate = parsed as { strokes?: unknown; memo?: unknown };
    return {
      strokes: normalizeScratchpadStrokes(candidate.strokes),
      memo: typeof candidate.memo === "string" ? candidate.memo.slice(0, MAX_MEMO_LENGTH) : "",
    };
  } catch {
    return { strokes: [], memo: "" };
  }
}

export function encodeScratchpadState(state: ScratchpadStoredState): string {
  return JSON.stringify({
    version: 1,
    strokes: normalizeScratchpadStrokes(state.strokes),
    memo: state.memo.slice(0, MAX_MEMO_LENGTH),
  });
}

function restoreScratchpad(questionId: number): ScratchpadStoredState {
  if (typeof window === "undefined") return { strokes: [], memo: "" };
  try {
    return decodeScratchpadState(window.localStorage.getItem(scratchpadStorageKey(questionId)));
  } catch {
    return { strokes: [], memo: "" };
  }
}

function persistScratchpad(questionId: number, state: ScratchpadStoredState): void {
  if (typeof window === "undefined") return;
  try {
    const key = scratchpadStorageKey(questionId);
    if (state.strokes.length === 0 && state.memo.length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, encodeScratchpadState(state));
  } catch {
    // 저장 공간이 없거나 로컬 저장소가 차단돼도 풀이 기능은 유지한다.
  }
}

export function recordScratchpadChange(
  current: ScratchpadStroke[],
  history: ScratchpadStroke[][],
  next: ScratchpadStroke[],
): ScratchpadHistory {
  return {
    strokes: next.slice(-MAX_STROKES),
    history: [...history, current].slice(-MAX_HISTORY),
  };
}

export function undoScratchpadChange(
  current: ScratchpadStroke[],
  history: ScratchpadStroke[][],
): ScratchpadHistory {
  if (history.length === 0) return { strokes: current, history };
  return {
    strokes: history[history.length - 1],
    history: history.slice(0, -1),
  };
}

export function scratchpadStrokeWidth(tool: ScratchpadTool, pressure: number): number {
  const normalized = Math.min(1, Math.max(0, pressure || 0.5));
  return (tool === "eraser" ? 18 : 2.4) * (0.65 + normalized * 0.7);
}

function paintStroke(
  context: CanvasRenderingContext2D,
  stroke: ScratchpadStroke,
  width: number,
  height: number,
): void {
  const points = stroke.points;
  if (points.length === 0) return;

  context.save();
  context.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
  context.strokeStyle = "#202327";
  context.fillStyle = "#202327";
  context.lineCap = "round";
  context.lineJoin = "round";

  if (points.length === 1) {
    const point = points[0];
    const radius = scratchpadStrokeWidth(stroke.tool, point.pressure) / 2;
    context.beginPath();
    context.arc(point.x * width, point.y * height, radius, 0, Math.PI * 2);
    context.fill();
    context.restore();
    return;
  }

  for (let index = 1; index < points.length; index++) {
    const before = points[index - 1];
    const point = points[index];
    context.beginPath();
    context.lineWidth = scratchpadStrokeWidth(stroke.tool, (before.pressure + point.pressure) / 2);
    context.moveTo(before.x * width, before.y * height);
    context.lineTo(point.x * width, point.y * height);
    context.stroke();
  }
  context.restore();
}

export default function QuizScratchpad({ questionId }: QuizScratchpadProps) {
  const { t } = useI18n();
  const initialStateRef = useRef<ScratchpadStoredState | null>(null);
  if (initialStateRef.current === null) initialStateRef.current = restoreScratchpad(questionId);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<ScratchpadStroke[]>(initialStateRef.current.strokes);
  const historyRef = useRef<ScratchpadStroke[][]>([]);
  const activeRef = useRef<{ pointerId: number; stroke: ScratchpadStroke } | null>(null);
  const metricsRef = useRef({ width: 1, height: 1, dpr: 1 });
  const memoRef = useRef(initialStateRef.current.memo);
  const helpId = useId();
  const memoId = useId();
  const memoHelpId = useId();
  const [tool, setTool] = useState<ScratchpadTool>("pen");
  const [strokeCount, setStrokeCount] = useState(initialStateRef.current.strokes.length);
  const [undoCount, setUndoCount] = useState(0);
  const [memo, setMemo] = useState(initialStateRef.current.memo);
  const [statusKey, setStatusKey] = useState<MessageKey>("problems.scratch.ready");
  const [open, setOpen] = useState(
    () => typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(pointer: coarse)").matches,
  );

  const repaint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const { width, height, dpr } = metricsRef.current;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const stroke of strokesRef.current) paintStroke(context, stroke, width, height);
    if (activeRef.current) paintStroke(context, activeRef.current.stroke, width, height);
  }, []);

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    metricsRef.current = { width, height, dpr };
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    repaint();
  }, [repaint]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resizeCanvas);
    observer?.observe(canvas);
    window.addEventListener("resize", resizeCanvas);
    resizeCanvas();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resizeCanvas);
    };
  }, [resizeCanvas]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(resizeCanvas);
    return () => cancelAnimationFrame(frame);
  }, [open, resizeCanvas]);

  const applyHistory = useCallback((model: ScratchpadHistory, message: MessageKey) => {
    strokesRef.current = model.strokes;
    historyRef.current = model.history;
    setStrokeCount(model.strokes.length);
    setUndoCount(model.history.length);
    setStatusKey(message);
    persistScratchpad(questionId, { strokes: model.strokes, memo: memoRef.current });
    repaint();
  }, [questionId, repaint]);

  const pointFromEvent = useCallback((event: PointerEvent): ScratchpadPoint | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
      pressure: Math.min(1, Math.max(0, event.pressure || 0.5)),
    };
  }, []);

  const drawActive = useCallback(() => {
    const canvas = canvasRef.current;
    const active = activeRef.current;
    if (!canvas || !active) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const { width, height, dpr } = metricsRef.current;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    const points = active.stroke.points;
    paintStroke(context, { ...active.stroke, points: points.slice(-2) }, width, height);
  }, []);

  const appendSamples = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const active = activeRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const native = event.nativeEvent;
    const samples = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [native];
    for (const sample of samples) {
      if (active.stroke.points.length >= MAX_POINTS_PER_STROKE) break;
      const point = pointFromEvent(sample);
      if (!point) continue;
      const before = active.stroke.points[active.stroke.points.length - 1];
      const { width, height } = metricsRef.current;
      if (before && Math.hypot((point.x - before.x) * width, (point.y - before.y) * height) < 0.75) continue;
      active.stroke.points.push(point);
      drawActive();
    }
  }, [drawActive, pointFromEvent]);

  function startStroke(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    const point = pointFromEvent(event.nativeEvent);
    if (!point || activeRef.current) return;
    activeRef.current = { pointerId: event.pointerId, stroke: { tool, points: [point] } };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture가 없는 테스트/구형 브라우저에서도 현재 획은 계속 처리한다.
    }
    drawActive();
  }

  function finishStroke(event: ReactPointerEvent<HTMLCanvasElement>, includeLastPoint: boolean) {
    const active = activeRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (includeLastPoint) appendSamples(event);
    activeRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // capture 미지원 환경
    }
    const model = recordScratchpadChange(
      strokesRef.current,
      historyRef.current,
      [...strokesRef.current, active.stroke],
    );
    applyHistory(
      model,
      active.stroke.tool === "pen" ? "problems.scratch.penStroke" : "problems.scratch.eraserStroke",
    );
  }

  function undo() {
    if (historyRef.current.length === 0) return;
    applyHistory(
      undoScratchpadChange(strokesRef.current, historyRef.current),
      "problems.scratch.undone",
    );
  }

  function clear() {
    if (strokesRef.current.length === 0) return;
    applyHistory(
      recordScratchpadChange(strokesRef.current, historyRef.current, []),
      "problems.scratch.cleared",
    );
  }

  function changeMemo(value: string) {
    const next = value.slice(0, MAX_MEMO_LENGTH);
    memoRef.current = next;
    setMemo(next);
    persistScratchpad(questionId, { strokes: strokesRef.current, memo: next });
  }

  return (
    <details
      className="quiz-scratchpad"
      open={open}
      onToggle={event => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="quiz-scratchpad-title">{t("problems.scratch.title")}</span>
        <span className="quiz-scratchpad-summary">{t("problems.scratch.summary")}</span>
      </summary>
      <div className="quiz-scratchpad-panel">
        <div className="quiz-scratchpad-toolbar" role="toolbar" aria-label={t("problems.scratch.toolbarAria")}>
          <button
            type="button"
            className={tool === "pen" ? "active" : ""}
            aria-label={t("problems.scratch.penAria")}
            aria-pressed={tool === "pen"}
            onClick={() => { setTool("pen"); setStatusKey("problems.scratch.penSelected"); }}
          >
            {t("problems.scratch.pen")}
          </button>
          <button
            type="button"
            className={tool === "eraser" ? "active" : ""}
            aria-label={t("problems.scratch.eraserAria")}
            aria-pressed={tool === "eraser"}
            onClick={() => { setTool("eraser"); setStatusKey("problems.scratch.eraserSelected"); }}
          >
            {t("problems.scratch.eraser")}
          </button>
          <span className="quiz-scratchpad-toolbar-gap" />
          <button
            type="button"
            onClick={undo}
            disabled={undoCount === 0}
            aria-label={t("problems.scratch.undoAria")}
          >
            {t("problems.scratch.undo")}
          </button>
          <button
            type="button"
            onClick={clear}
            disabled={strokeCount === 0}
            aria-label={t("problems.scratch.clearAria")}
          >
            {t("problems.scratch.clear")}
          </button>
        </div>
        <p className="quiz-scratchpad-help" id={helpId}>{t("problems.scratch.help")}</p>
        <canvas
          ref={canvasRef}
          className={`quiz-scratchpad-canvas${tool === "eraser" ? " erasing" : ""}`}
          aria-label={t("problems.scratch.canvasAria")}
          aria-describedby={helpId}
          onPointerDown={startStroke}
          onPointerMove={appendSamples}
          onPointerUp={event => finishStroke(event, true)}
          onPointerCancel={event => finishStroke(event, false)}
          onContextMenu={event => event.preventDefault()}
        >
          {t("problems.scratch.unsupported")}
        </canvas>
        <div className="quiz-scratchpad-text">
          <label className="quiz-scratchpad-text-label" htmlFor={memoId}>
            {t("problems.scratch.memoLabel")}
          </label>
          <textarea
            id={memoId}
            className="quiz-scratchpad-textarea"
            name={`scratchpad-memo-${questionId}`}
            rows={4}
            maxLength={MAX_MEMO_LENGTH}
            autoComplete="off"
            dir="auto"
            value={memo}
            placeholder={t("problems.scratch.memoPlaceholder")}
            aria-describedby={memoHelpId}
            onChange={event => changeMemo(event.currentTarget.value)}
            onBlur={() => setStatusKey("problems.scratch.memoSaved")}
          />
          <p className="quiz-scratchpad-help" id={memoHelpId}>
            {t("problems.scratch.memoHelp")}
          </p>
        </div>
        <span className="quiz-scratchpad-status" role="status" aria-live="polite">{t(statusKey)}</span>
      </div>
    </details>
  );
}
