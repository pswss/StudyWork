import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useI18n, type MessageKey } from "../i18n";

export type ScratchpadTool = "pen" | "highlighter" | "eraser";

export interface ScratchpadPoint {
  x: number;
  y: number;
  pressure: number;
}

export interface ScratchpadStroke {
  tool: ScratchpadTool;
  points: ScratchpadPoint[];
  color?: string;
  size?: number;
  pressure?: boolean;
}

interface ScratchpadHistory {
  strokes: ScratchpadStroke[];
  history: ScratchpadStroke[][];
}

export interface ScratchpadStoredState {
  strokes: ScratchpadStroke[];
  memo: string;
}

export interface InkPreferences {
  penColor: string;
  penSize: number;
  highlighterColor: string;
  highlighterSize: number;
  eraserSize: number;
  pressure: boolean;
  pencilOnly: boolean;
}

interface QuizScratchpadProps {
  questionId: number;
}

const MAX_STROKES = 160;
const MAX_POINTS_PER_STROKE = 1_200;
const MAX_HISTORY = 50;
const MAX_MEMO_LENGTH = 8_000;
const SCRATCHPAD_STORAGE_PREFIX = "studywork:quiz-scratchpad:";
const ANNOTATION_STORAGE_PREFIX = "studywork:quiz-annotation:";
const INK_PREFERENCES_KEY = "studywork:ink-preferences";
const INK_PREFERENCES_EVENT = "studywork:ink-preferences-change";
const HEX_COLOR = /^#[0-9a-f]{6}$/iu;
const DEFAULT_INK_PREFERENCES: InkPreferences = {
  penColor: "#246bfe",
  penSize: 2.6,
  highlighterColor: "#fff066",
  highlighterSize: 16,
  eraserSize: 22,
  pressure: true,
  pencilOnly: false,
};
const PEN_COLORS = ["#246bfe", "#e5484d", "#8e5cf6", "#202327", "#f4f5ef"];
const HIGHLIGHTER_COLORS = ["#fff066", "#ff72b6", "#67d5ff", "#7cf29a", "#c7a7ff"];

export function scratchpadStorageKey(questionId: number): string {
  return `${SCRATCHPAD_STORAGE_PREFIX}${questionId}`;
}

export function annotationStorageKey(questionId: number): string {
  return `${ANNOTATION_STORAGE_PREFIX}${questionId}`;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

export function decodeInkPreferences(raw: string | null): InkPreferences {
  if (!raw) return { ...DEFAULT_INK_PREFERENCES };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_INK_PREFERENCES };
    const value = parsed as Partial<Record<keyof InkPreferences, unknown>>;
    return {
      penColor: typeof value.penColor === "string" && HEX_COLOR.test(value.penColor)
        ? value.penColor.toLowerCase()
        : DEFAULT_INK_PREFERENCES.penColor,
      penSize: boundedNumber(value.penSize, DEFAULT_INK_PREFERENCES.penSize, 1, 8),
      highlighterColor:
        typeof value.highlighterColor === "string" && HEX_COLOR.test(value.highlighterColor)
          ? value.highlighterColor.toLowerCase()
          : DEFAULT_INK_PREFERENCES.highlighterColor,
      highlighterSize: boundedNumber(
        value.highlighterSize,
        DEFAULT_INK_PREFERENCES.highlighterSize,
        6,
        32,
      ),
      eraserSize: boundedNumber(value.eraserSize, DEFAULT_INK_PREFERENCES.eraserSize, 8, 40),
      pressure: typeof value.pressure === "boolean" ? value.pressure : DEFAULT_INK_PREFERENCES.pressure,
      pencilOnly:
        typeof value.pencilOnly === "boolean" ? value.pencilOnly : DEFAULT_INK_PREFERENCES.pencilOnly,
    };
  } catch {
    return { ...DEFAULT_INK_PREFERENCES };
  }
}

function normalizeScratchpadStrokes(value: unknown): ScratchpadStroke[] {
  if (!Array.isArray(value)) return [];
  const strokes: ScratchpadStroke[] = [];
  for (const valueStroke of value.slice(-MAX_STROKES)) {
    if (!valueStroke || typeof valueStroke !== "object") continue;
    const candidate = valueStroke as {
      tool?: unknown;
      points?: unknown;
      color?: unknown;
      size?: unknown;
      pressure?: unknown;
    };
    if (
      (candidate.tool !== "pen" && candidate.tool !== "highlighter" && candidate.tool !== "eraser")
      || !Array.isArray(candidate.points)
    ) continue;
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
    if (points.length > 0) {
      const stroke: ScratchpadStroke = { tool: candidate.tool, points };
      if (typeof candidate.color === "string" && HEX_COLOR.test(candidate.color)) {
        stroke.color = candidate.color.toLowerCase();
      }
      if (typeof candidate.size === "number" && Number.isFinite(candidate.size)) {
        stroke.size = Math.min(40, Math.max(1, candidate.size));
      }
      if (typeof candidate.pressure === "boolean") stroke.pressure = candidate.pressure;
      strokes.push(stroke);
    }
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
    version: 2,
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

export function redoScratchpadChange(
  current: ScratchpadStroke[],
  history: ScratchpadStroke[][],
  future: ScratchpadStroke[][],
): ScratchpadHistory & { future: ScratchpadStroke[][] } {
  if (future.length === 0) return { strokes: current, history, future };
  return {
    strokes: future[future.length - 1],
    history: [...history, current].slice(-MAX_HISTORY),
    future: future.slice(0, -1),
  };
}

export function scratchpadStrokeWidth(
  tool: ScratchpadTool,
  pressure: number,
  size = tool === "pen" ? 2.4 : tool === "highlighter" ? 16 : 18,
  pressureEnabled = true,
): number {
  if (tool !== "pen") return size;
  const normalized = pressureEnabled ? Math.min(1, Math.max(0, pressure || 0.5)) : 0.5;
  return size * (0.65 + normalized * 0.7);
}

export function scratchpadMidpoint(a: ScratchpadPoint, b: ScratchpadPoint): ScratchpadPoint {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    pressure: (a.pressure + b.pressure) / 2,
  };
}

export function scratchpadCanvasPixelRatio(width: number, height: number, devicePixelRatio: number): number {
  const maxForArea = Math.sqrt(12_000_000 / Math.max(1, width * height));
  return Math.max(1, Math.min(2, devicePixelRatio || 1, maxForArea));
}

function paintStrokeLayer(
  context: CanvasRenderingContext2D,
  stroke: ScratchpadStroke,
  width: number,
  height: number,
  color: string,
  size: number,
  opacity: number,
  extraWidth = 0,
  latestOnly = false,
): void {
  const points = stroke.points;
  if (points.length === 0) return;

  context.save();
  context.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
  context.strokeStyle = color;
  context.fillStyle = color;
  context.globalAlpha = opacity;
  context.lineCap = "round";
  context.lineJoin = "round";

  if (points.length === 1) {
    const point = points[0];
    const radius = (
      scratchpadStrokeWidth(stroke.tool, point.pressure, size, stroke.pressure ?? true) + extraWidth
    ) / 2;
    context.beginPath();
    context.arc(point.x * width, point.y * height, radius, 0, Math.PI * 2);
    context.fill();
    context.restore();
    return;
  }

  if (latestOnly) {
    const point = points[points.length - 1];
    const before = points[points.length - 2];
    const start = points.length > 2
      ? scratchpadMidpoint(points[points.length - 3], before)
      : before;
    const end = scratchpadMidpoint(before, point);
    context.beginPath();
    context.lineWidth = scratchpadStrokeWidth(
      stroke.tool,
      (before.pressure + point.pressure) / 2,
      size,
      stroke.pressure ?? true,
    ) + extraWidth;
    context.moveTo(start.x * width, start.y * height);
    context.quadraticCurveTo(before.x * width, before.y * height, end.x * width, end.y * height);
    context.stroke();
    context.restore();
    return;
  }

  let start = points[0];
  for (let index = 1; index < points.length; index++) {
    const before = points[index - 1];
    const point = points[index];
    const end = index === points.length - 1 ? point : scratchpadMidpoint(point, points[index + 1]);
    context.beginPath();
    context.lineWidth = scratchpadStrokeWidth(
      stroke.tool,
      (before.pressure + point.pressure) / 2,
      size,
      stroke.pressure ?? true,
    ) + extraWidth;
    context.moveTo(start.x * width, start.y * height);
    context.quadraticCurveTo(point.x * width, point.y * height, end.x * width, end.y * height);
    context.stroke();
    start = end;
  }
  context.restore();
}

interface InkSurfaceStyle {
  legacyPenColor: string;
  legacyHighlighterColor: string;
  outlined: boolean;
}

function inkOutline(color: string): string {
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  const luminance = (red * 299 + green * 587 + blue * 114) / 255_000;
  return luminance < 0.42 ? "rgba(244, 245, 239, .72)" : "rgba(14, 14, 16, .78)";
}

function paintStroke(
  context: CanvasRenderingContext2D,
  stroke: ScratchpadStroke,
  width: number,
  height: number,
  surface: InkSurfaceStyle,
  latestOnly = false,
): void {
  const color = stroke.color ?? (
    stroke.tool === "highlighter" ? surface.legacyHighlighterColor : surface.legacyPenColor
  );
  const size = stroke.size ?? (stroke.tool === "pen" ? 2.4 : stroke.tool === "highlighter" ? 16 : 18);
  const opacity = stroke.tool === "highlighter" ? 0.34 : 1;
  if (stroke.tool === "pen" && surface.outlined) {
    paintStrokeLayer(context, stroke, width, height, inkOutline(color), size, 0.62, 1.4, latestOnly);
  }
  paintStrokeLayer(context, stroke, width, height, color, size, opacity, 0, latestOnly);
}

function restoreInkPreferences(): InkPreferences {
  if (typeof window === "undefined") return { ...DEFAULT_INK_PREFERENCES };
  try {
    return decodeInkPreferences(window.localStorage.getItem(INK_PREFERENCES_KEY));
  } catch {
    return { ...DEFAULT_INK_PREFERENCES };
  }
}

function persistInkPreferences(preferences: InkPreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(INK_PREFERENCES_KEY, JSON.stringify(preferences));
    window.dispatchEvent(new Event(INK_PREFERENCES_EVENT));
  } catch {
    // 설정 저장이 막혀도 현재 세션의 필기 기능은 유지한다.
  }
}

function useInkPreferences() {
  const [preferences, setPreferences] = useState<InkPreferences>(restoreInkPreferences);

  useEffect(() => {
    const sync = () => setPreferences(restoreInkPreferences());
    const syncStorage = (event: StorageEvent) => {
      if (event.key === INK_PREFERENCES_KEY) sync();
    };
    window.addEventListener(INK_PREFERENCES_EVENT, sync);
    window.addEventListener("storage", syncStorage);
    return () => {
      window.removeEventListener(INK_PREFERENCES_EVENT, sync);
      window.removeEventListener("storage", syncStorage);
    };
  }, []);

  const updatePreferences = useCallback((patch: Partial<InkPreferences>) => {
    const next = decodeInkPreferences(JSON.stringify({ ...preferences, ...patch }));
    setPreferences(next);
    persistInkPreferences(next);
  }, [preferences]);

  return { preferences, updatePreferences };
}

interface InkMessages {
  ready: MessageKey;
  penStroke: MessageKey;
  highlighterStroke: MessageKey;
  eraserStroke: MessageKey;
  undone: MessageKey;
  redone: MessageKey;
  cleared: MessageKey;
  penSelected: MessageKey;
  highlighterSelected: MessageKey;
  eraserSelected: MessageKey;
}

interface UseInkCanvasOptions {
  initialStrokes: ScratchpadStroke[];
  visible: boolean;
  surface: InkSurfaceStyle;
  messages: InkMessages;
  onChange: (strokes: ScratchpadStroke[]) => void;
}

function useInkCanvas({
  initialStrokes,
  visible,
  surface,
  messages,
  onChange,
}: UseInkCanvasOptions) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<ScratchpadStroke[]>(initialStrokes);
  const historyRef = useRef<ScratchpadStroke[][]>([]);
  const futureRef = useRef<ScratchpadStroke[][]>([]);
  const activeRef = useRef<{ pointerId: number; stroke: ScratchpadStroke } | null>(null);
  const metricsRef = useRef({ width: 1, height: 1, dpr: 1 });
  const [tool, setTool] = useState<ScratchpadTool>("pen");
  const [strokeCount, setStrokeCount] = useState(initialStrokes.length);
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const [statusKey, setStatusKey] = useState<MessageKey>(messages.ready);
  const { preferences, updatePreferences } = useInkPreferences();

  const repaint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const { width, height, dpr } = metricsRef.current;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const stroke of strokesRef.current) {
      paintStroke(context, stroke, width, height, surface);
    }
    if (activeRef.current) {
      paintStroke(context, activeRef.current.stroke, width, height, surface);
    }
  }, [surface]);

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    const dpr = scratchpadCanvasPixelRatio(width, height, window.devicePixelRatio || 1);
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
    if (!visible) return;
    const frame = requestAnimationFrame(resizeCanvas);
    return () => cancelAnimationFrame(frame);
  }, [visible, resizeCanvas]);

  const applyHistory = useCallback((
    model: ScratchpadHistory,
    message: MessageKey,
    future: ScratchpadStroke[][] = [],
  ) => {
    strokesRef.current = model.strokes;
    historyRef.current = model.history;
    futureRef.current = future;
    setStrokeCount(model.strokes.length);
    setUndoCount(model.history.length);
    setRedoCount(future.length);
    setStatusKey(message);
    onChange(model.strokes);
    repaint();
  }, [onChange, repaint]);

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
    paintStroke(
      context,
      active.stroke,
      width,
      height,
      surface,
      true,
    );
  }, [surface]);

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
    if (preferences.pencilOnly && event.pointerType === "touch") return;
    event.preventDefault();
    const point = pointFromEvent(event.nativeEvent);
    if (!point || activeRef.current) return;
    const stroke: ScratchpadStroke = {
      tool,
      points: [point],
      size: tool === "pen"
        ? preferences.penSize
        : tool === "highlighter" ? preferences.highlighterSize : preferences.eraserSize,
      pressure: tool === "pen" ? preferences.pressure : false,
      ...(tool === "pen"
        ? { color: preferences.penColor }
        : tool === "highlighter" ? { color: preferences.highlighterColor } : {}),
    };
    activeRef.current = { pointerId: event.pointerId, stroke };
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
      active.stroke.tool === "pen"
        ? messages.penStroke
        : active.stroke.tool === "highlighter" ? messages.highlighterStroke : messages.eraserStroke,
    );
  }

  function undo() {
    if (historyRef.current.length === 0) return;
    const current = strokesRef.current;
    applyHistory(
      undoScratchpadChange(current, historyRef.current),
      messages.undone,
      [...futureRef.current, current].slice(-MAX_HISTORY),
    );
  }

  function redo() {
    if (futureRef.current.length === 0) return;
    const model = redoScratchpadChange(strokesRef.current, historyRef.current, futureRef.current);
    applyHistory(model, messages.redone, model.future);
  }

  function clear() {
    if (strokesRef.current.length === 0) return;
    applyHistory(
      recordScratchpadChange(strokesRef.current, historyRef.current, []),
      messages.cleared,
    );
  }

  function selectTool(next: ScratchpadTool) {
    setTool(next);
    setStatusKey(
      next === "pen"
        ? messages.penSelected
        : next === "highlighter" ? messages.highlighterSelected : messages.eraserSelected,
    );
  }

  return {
    canvasRef,
    clear,
    resizeCanvas,
    redo,
    redoCount,
    selectTool,
    setStatusKey,
    statusKey,
    strokeCount,
    strokesRef,
    tool,
    undo,
    undoCount,
    preferences,
    updatePreferences,
    appendSamples,
    finishStroke,
    startStroke,
  };
}

type InkCanvasController = ReturnType<typeof useInkCanvas>;

interface InkToolbarProps {
  ariaLabel: string;
  className: string;
  controller: InkCanvasController;
  clearAria: string;
  redoAria: string;
  undoAria: string;
  before?: ReactNode;
}

function InkToolbar({
  ariaLabel,
  className,
  controller,
  clearAria,
  redoAria,
  undoAria,
  before,
}: InkToolbarProps) {
  const { t } = useI18n();
  const settingsId = useId();
  const widthId = useId();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const toolLabel = t(
    controller.tool === "pen"
      ? "problems.scratch.pen"
      : controller.tool === "highlighter"
        ? "problems.scratch.highlighter"
        : "problems.scratch.eraser",
  );
  const size = controller.tool === "pen"
    ? controller.preferences.penSize
    : controller.tool === "highlighter"
      ? controller.preferences.highlighterSize
      : controller.preferences.eraserSize;
  const color = controller.tool === "pen"
    ? controller.preferences.penColor
    : controller.tool === "highlighter"
      ? controller.preferences.highlighterColor
      : "#f4f5ef";
  const colors = controller.tool === "highlighter" ? HIGHLIGHTER_COLORS : PEN_COLORS;
  const widthRange = controller.tool === "pen"
    ? { min: 1, max: 8, step: 0.2 }
    : controller.tool === "highlighter"
      ? { min: 6, max: 32, step: 1 }
      : { min: 8, max: 40, step: 1 };

  function selectTool(tool: ScratchpadTool) {
    if (controller.tool === tool) setSettingsOpen(true);
    else controller.selectTool(tool);
  }

  function changeSize(value: number) {
    if (controller.tool === "pen") controller.updatePreferences({ penSize: value });
    else if (controller.tool === "highlighter") controller.updatePreferences({ highlighterSize: value });
    else controller.updatePreferences({ eraserSize: value });
  }

  function changeColor(value: string) {
    if (controller.tool === "pen") controller.updatePreferences({ penColor: value });
    else if (controller.tool === "highlighter") controller.updatePreferences({ highlighterColor: value });
  }

  return (
    <div className={`${className} quiz-ink-toolbar-shell`}>
      <div className="quiz-ink-toolbar" role="toolbar" aria-label={ariaLabel}>
        {before}
        {(["pen", "highlighter", "eraser"] as const).map(tool => {
          const active = controller.tool === tool;
          const toolColor = tool === "pen"
            ? controller.preferences.penColor
            : tool === "highlighter" ? controller.preferences.highlighterColor : "#f4f5ef";
          const toolSize = tool === "pen"
            ? controller.preferences.penSize
            : tool === "highlighter" ? controller.preferences.highlighterSize : controller.preferences.eraserSize;
          const label = t(
            tool === "pen"
              ? "problems.scratch.pen"
              : tool === "highlighter" ? "problems.scratch.highlighter" : "problems.scratch.eraser",
          );
          return (
            <button
              type="button"
              key={tool}
              className={`quiz-ink-tool${active ? " active" : ""}`}
              aria-label={label}
              aria-pressed={active}
              onClick={() => selectTool(tool)}
            >
              <span>{label}</span>
              <span
                className={`quiz-ink-tool-mark ${tool}`}
                style={{
                  backgroundColor: toolColor,
                  height: `${Math.min(8, Math.max(2, toolSize / (tool === "pen" ? 1.5 : 4)))}px`,
                }}
                aria-hidden="true"
              />
            </button>
          );
        })}
        <span className="quiz-ink-toolbar-gap" />
        <button
          type="button"
          onClick={controller.undo}
          disabled={controller.undoCount === 0}
          aria-label={undoAria}
        >
          {t("problems.scratch.undo")}
        </button>
        <button
          type="button"
          onClick={controller.redo}
          disabled={controller.redoCount === 0}
          aria-label={redoAria}
        >
          {t("problems.scratch.redo")}
        </button>
        <button
          type="button"
          className={`quiz-ink-settings-toggle${settingsOpen ? " active" : ""}`}
          aria-expanded={settingsOpen}
          aria-controls={settingsId}
          onClick={() => setSettingsOpen(current => !current)}
        >
          {t("problems.scratch.settings")}
        </button>
      </div>
      {settingsOpen && (
        <div
          className="quiz-ink-settings-panel"
          id={settingsId}
          role="group"
          aria-label={t("problems.scratch.settingsTitle", { tool: toolLabel })}
        >
          <div className="quiz-ink-setting-row width">
            <label htmlFor={widthId}>{t("problems.scratch.width")}</label>
            <input
              id={widthId}
              type="range"
              min={widthRange.min}
              max={widthRange.max}
              step={widthRange.step}
              value={size}
              aria-label={t("problems.scratch.widthAria", { tool: toolLabel })}
              onChange={event => changeSize(Number(event.currentTarget.value))}
            />
            <span
              className="quiz-ink-width-preview"
              style={{ backgroundColor: color, height: `${Math.min(12, Math.max(2, size / 2))}px` }}
              aria-hidden="true"
            />
            <output htmlFor={widthId}>{size.toFixed(controller.tool === "pen" ? 1 : 0)} px</output>
          </div>
          {controller.tool !== "eraser" && (
            <fieldset className="quiz-ink-colors">
              <legend>{t("problems.scratch.color")}</legend>
              <div className="quiz-ink-color-list">
                {colors.map(option => (
                  <button
                    type="button"
                    key={option}
                    className={color === option ? "selected" : ""}
                    style={{ backgroundColor: option }}
                    aria-label={t("problems.scratch.colorAria", { color: option })}
                    aria-pressed={color === option}
                    onClick={() => changeColor(option)}
                  />
                ))}
                <label className="quiz-ink-custom-color">
                  <span>{t("problems.scratch.customColor")}</span>
                  <input
                    type="color"
                    value={color}
                    aria-label={t("problems.scratch.customColor")}
                    onChange={event => changeColor(event.currentTarget.value)}
                  />
                </label>
              </div>
            </fieldset>
          )}
          <div className="quiz-ink-setting-actions">
            {controller.tool === "pen" && (
              <label className="quiz-ink-toggle">
                <input
                  type="checkbox"
                  checked={controller.preferences.pressure}
                  onChange={event => controller.updatePreferences({ pressure: event.currentTarget.checked })}
                />
                <span>{t("problems.scratch.pressure")}</span>
              </label>
            )}
            <label className="quiz-ink-toggle">
              <input
                type="checkbox"
                checked={controller.preferences.pencilOnly}
                onChange={event => controller.updatePreferences({ pencilOnly: event.currentTarget.checked })}
              />
              <span>{t("problems.scratch.pencilOnly")}</span>
            </label>
            <button
              type="button"
              className="quiz-ink-clear"
              onClick={controller.clear}
              disabled={controller.strokeCount === 0}
              aria-label={clearAria}
            >
              {t("problems.scratch.clear")}
            </button>
          </div>
          <p className="quiz-ink-settings-help">{t("problems.scratch.pencilOnlyHelp")}</p>
        </div>
      )}
    </div>
  );
}

function restoreAnnotation(questionId: number): ScratchpadStroke[] {
  if (typeof window === "undefined") return [];
  try {
    return decodeScratchpadState(window.localStorage.getItem(annotationStorageKey(questionId))).strokes;
  } catch {
    return [];
  }
}

function persistAnnotation(questionId: number, strokes: ScratchpadStroke[]): void {
  if (typeof window === "undefined") return;
  try {
    const key = annotationStorageKey(questionId);
    if (strokes.length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, encodeScratchpadState({ strokes, memo: "" }));
  } catch {
    // 저장 공간이 없거나 로컬 저장소가 차단돼도 필기 기능은 유지한다.
  }
}

const scratchpadMessages: InkMessages = {
  ready: "problems.scratch.ready",
  penStroke: "problems.scratch.penStroke",
  highlighterStroke: "problems.scratch.highlighterStroke",
  eraserStroke: "problems.scratch.eraserStroke",
  undone: "problems.scratch.undone",
  redone: "problems.scratch.redone",
  cleared: "problems.scratch.cleared",
  penSelected: "problems.scratch.penSelected",
  highlighterSelected: "problems.scratch.highlighterSelected",
  eraserSelected: "problems.scratch.eraserSelected",
};

const scratchpadSurface: InkSurfaceStyle = {
  legacyPenColor: "#202327",
  legacyHighlighterColor: "#fff066",
  outlined: false,
};

const annotationSurface: InkSurfaceStyle = {
  legacyPenColor: "#d9ff3f",
  legacyHighlighterColor: "#fff066",
  outlined: true,
};

export default function QuizScratchpad({ questionId }: QuizScratchpadProps) {
  const { t } = useI18n();
  const initialStateRef = useRef<ScratchpadStoredState | null>(null);
  if (initialStateRef.current === null) initialStateRef.current = restoreScratchpad(questionId);
  const initialState = initialStateRef.current;
  const memoRef = useRef(initialState.memo);
  const helpId = useId();
  const memoId = useId();
  const memoHelpId = useId();
  const [memo, setMemo] = useState(initialState.memo);
  const [open, setOpen] = useState(
    () => typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(pointer: coarse)").matches,
  );
  const saveStrokes = useCallback((strokes: ScratchpadStroke[]) => {
    persistScratchpad(questionId, { strokes, memo: memoRef.current });
  }, [questionId]);
  const controller = useInkCanvas({
    initialStrokes: initialState.strokes,
    visible: open,
    surface: scratchpadSurface,
    messages: scratchpadMessages,
    onChange: saveStrokes,
  });

  function changeMemo(value: string) {
    const next = value.slice(0, MAX_MEMO_LENGTH);
    memoRef.current = next;
    setMemo(next);
    persistScratchpad(questionId, { strokes: controller.strokesRef.current, memo: next });
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
        <InkToolbar
          ariaLabel={t("problems.scratch.toolbarAria")}
          className="quiz-scratchpad-toolbar"
          controller={controller}
          clearAria={t("problems.scratch.clearAria")}
          redoAria={t("problems.scratch.redoAria")}
          undoAria={t("problems.scratch.undoAria")}
        />
        <p className="quiz-scratchpad-help" id={helpId}>{t("problems.scratch.help")}</p>
        <canvas
          ref={controller.canvasRef}
          className={`quiz-scratchpad-canvas${controller.tool === "eraser" ? " erasing" : ""}${controller.preferences.pencilOnly ? " pencil-only" : ""}`}
          aria-label={t("problems.scratch.canvasAria")}
          aria-describedby={helpId}
          onPointerDown={controller.startStroke}
          onPointerMove={controller.appendSamples}
          onPointerUp={event => controller.finishStroke(event, true)}
          onPointerCancel={event => controller.finishStroke(event, false)}
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
            onBlur={() => controller.setStatusKey("problems.scratch.memoSaved")}
          />
          <p className="quiz-scratchpad-help" id={memoHelpId}>
            {t("problems.scratch.memoHelp")}
          </p>
        </div>
        <span className="quiz-scratchpad-status" role="status" aria-live="polite">{t(controller.statusKey)}</span>
      </div>
    </details>
  );
}

interface QuizQuestionAnnotationProps {
  questionId: number;
  children: ReactNode;
}

const annotationMessages: InkMessages = {
  ...scratchpadMessages,
  ready: "problems.annotation.inactive",
  cleared: "problems.annotation.cleared",
};

export function QuizQuestionAnnotation({ questionId, children }: QuizQuestionAnnotationProps) {
  const { t } = useI18n();
  const initialStrokesRef = useRef<ScratchpadStroke[] | null>(null);
  if (initialStrokesRef.current === null) initialStrokesRef.current = restoreAnnotation(questionId);
  const helpId = useId();
  const [active, setActive] = useState(false);
  const saveStrokes = useCallback((strokes: ScratchpadStroke[]) => {
    persistAnnotation(questionId, strokes);
  }, [questionId]);
  const controller = useInkCanvas({
    initialStrokes: initialStrokesRef.current,
    visible: true,
    surface: annotationSurface,
    messages: annotationMessages,
    onChange: saveStrokes,
  });

  function toggleActive() {
    setActive(current => {
      const next = !current;
      controller.setStatusKey(next ? "problems.annotation.active" : "problems.annotation.inactive");
      return next;
    });
  }

  return (
    <section
      className={`quiz-annotation${active ? " active" : ""}`}
      aria-label={t("problems.annotation.toolbarAria")}
    >
      <InkToolbar
        ariaLabel={t("problems.annotation.toolbarAria")}
        className="quiz-annotation-toolbar"
        controller={controller}
        clearAria={t("problems.annotation.clearAria")}
        redoAria={t("problems.annotation.redoAria")}
        undoAria={t("problems.annotation.undoAria")}
        before={(
          <button
            type="button"
            className="quiz-annotation-mode"
            aria-pressed={active}
            onClick={toggleActive}
          >
            {t(active ? "problems.annotation.stop" : "problems.annotation.start")}
          </button>
        )}
      />
      <p className="quiz-annotation-help" id={helpId}>{t("problems.annotation.help")}</p>
      <div className="quiz-annotation-surface">
        <div className="quiz-annotation-content">{children}</div>
        <canvas
          ref={controller.canvasRef}
          className={`quiz-annotation-canvas${controller.tool === "eraser" ? " erasing" : ""}${controller.preferences.pencilOnly ? " pencil-only" : ""}`}
          aria-label={t("problems.annotation.canvasAria")}
          aria-describedby={helpId}
          aria-hidden={!active}
          onPointerDown={controller.startStroke}
          onPointerMove={controller.appendSamples}
          onPointerUp={event => controller.finishStroke(event, true)}
          onPointerCancel={event => controller.finishStroke(event, false)}
          onContextMenu={event => event.preventDefault()}
        >
          {t("problems.scratch.unsupported")}
        </canvas>
      </div>
      <span className="quiz-scratchpad-status" role="status" aria-live="polite">{t(controller.statusKey)}</span>
    </section>
  );
}
