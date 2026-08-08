import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
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

interface QuizInkWorkspaceProps {
  questionId: number;
  children: ReactNode;
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
  pencilOnly: true,
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
  tool: ScratchpadTool;
  preferences: InkPreferences;
  onChange: (strokes: ScratchpadStroke[]) => void;
  onAction: () => void;
  onStatus: (message: MessageKey) => void;
}

function useInkCanvas({
  initialStrokes,
  visible,
  surface,
  messages,
  tool,
  preferences,
  onChange,
  onAction,
  onStatus,
}: UseInkCanvasOptions) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<ScratchpadStroke[]>(initialStrokes);
  const historyRef = useRef<ScratchpadStroke[][]>([]);
  const futureRef = useRef<ScratchpadStroke[][]>([]);
  const activeRef = useRef<{ pointerId: number; stroke: ScratchpadStroke } | null>(null);
  const metricsRef = useRef({ width: 1, height: 1, dpr: 1 });
  const [strokeCount, setStrokeCount] = useState(initialStrokes.length);
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);

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
    onStatus(message);
    onChange(model.strokes);
    repaint();
  }, [onChange, onStatus, repaint]);

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
    onAction();
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

  function clear(recordAction = true) {
    if (strokesRef.current.length === 0) return false;
    applyHistory(
      recordScratchpadChange(strokesRef.current, historyRef.current, []),
      messages.cleared,
    );
    if (recordAction) onAction();
    return true;
  }

  return {
    canvasRef,
    clear,
    resizeCanvas,
    redo,
    redoCount,
    strokeCount,
    strokesRef,
    tool,
    undo,
    undoCount,
    preferences,
    appendSamples,
    finishStroke,
    startStroke,
  };
}

interface InkToolbarController {
  clear: () => void;
  preferences: InkPreferences;
  redo: () => void;
  redoCount: number;
  selectTool: (tool: ScratchpadTool) => void;
  strokeCount: number;
  tool: ScratchpadTool;
  undo: () => void;
  undoCount: number;
  updatePreferences: (patch: Partial<InkPreferences>) => void;
}

interface InkToolbarProps {
  ariaLabel: string;
  className: string;
  controller: InkToolbarController;
  clearAria: string;
  redoAria: string;
  undoAria: string;
  before?: ReactNode;
  after?: ReactNode;
}

function InkToolbar({
  ariaLabel,
  className,
  controller,
  clearAria,
  redoAria,
  undoAria,
  before,
  after,
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
    controller.selectTool(tool);
    if (controller.tool === tool) setSettingsOpen(true);
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
        {after}
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

const annotationMessages: InkMessages = {
  ...scratchpadMessages,
  cleared: "problems.annotation.cleared",
};

type InkSurfaceName = "problem" | "solution";
type InkWorkspaceAction = InkSurfaceName[];

export default function QuizInkWorkspace({ questionId, children }: QuizInkWorkspaceProps) {
  const { t } = useI18n();
  const initialScratchpadRef = useRef<ScratchpadStoredState | null>(null);
  if (initialScratchpadRef.current === null) initialScratchpadRef.current = restoreScratchpad(questionId);
  const initialScratchpad = initialScratchpadRef.current;
  const initialAnnotationRef = useRef<ScratchpadStroke[] | null>(null);
  if (initialAnnotationRef.current === null) initialAnnotationRef.current = restoreAnnotation(questionId);
  const memoRef = useRef(initialScratchpad.memo);
  const workspaceRef = useRef<HTMLElement>(null);
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null);
  const returnFullscreenFocusRef = useRef(false);
  const timelineHistoryRef = useRef<InkWorkspaceAction[]>([]);
  const timelineFutureRef = useRef<InkWorkspaceAction[]>([]);
  const helpId = useId();
  const solutionTitleId = useId();
  const memoId = useId();
  const memoHelpId = useId();
  const [memo, setMemo] = useState(initialScratchpad.memo);
  const [tool, setTool] = useState<ScratchpadTool>("pen");
  const [writing, setWriting] = useState(
    () => typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(pointer: coarse)").matches
      && restoreInkPreferences().pencilOnly,
  );
  const [fullscreen, setFullscreen] = useState(false);
  const [statusKey, setStatusKey] = useState<MessageKey>("problems.annotation.inactive");
  const [timelineCounts, setTimelineCounts] = useState({ undo: 0, redo: 0 });
  const { preferences, updatePreferences } = useInkPreferences();

  const saveAnnotation = useCallback((strokes: ScratchpadStroke[]) => {
    persistAnnotation(questionId, strokes);
  }, [questionId]);
  const saveScratchpad = useCallback((strokes: ScratchpadStroke[]) => {
    persistScratchpad(questionId, { strokes, memo: memoRef.current });
  }, [questionId]);
  const recordWorkspaceAction = useCallback((action: InkWorkspaceAction) => {
    timelineHistoryRef.current = [...timelineHistoryRef.current, action].slice(-MAX_HISTORY);
    timelineFutureRef.current = [];
    setTimelineCounts({ undo: timelineHistoryRef.current.length, redo: 0 });
  }, []);
  const recordProblemAction = useCallback(() => recordWorkspaceAction(["problem"]), [recordWorkspaceAction]);
  const recordSolutionAction = useCallback(() => recordWorkspaceAction(["solution"]), [recordWorkspaceAction]);

  const problemController = useInkCanvas({
    initialStrokes: initialAnnotationRef.current,
    visible: true,
    surface: annotationSurface,
    messages: annotationMessages,
    tool,
    preferences,
    onChange: saveAnnotation,
    onAction: recordProblemAction,
    onStatus: setStatusKey,
  });
  const solutionController = useInkCanvas({
    initialStrokes: initialScratchpad.strokes,
    visible: true,
    surface: scratchpadSurface,
    messages: scratchpadMessages,
    tool,
    preferences,
    onChange: saveScratchpad,
    onAction: recordSolutionAction,
    onStatus: setStatusKey,
  });

  useEffect(() => {
    if (!fullscreen) {
      if (!returnFullscreenFocusRef.current) return;
      returnFullscreenFocusRef.current = false;
      const frame = requestAnimationFrame(() => {
        problemController.resizeCanvas();
        solutionController.resizeCanvas();
        fullscreenButtonRef.current?.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
    returnFullscreenFocusRef.current = true;
    document.body.classList.add("quiz-ink-fullscreen-open");
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    const frame = requestAnimationFrame(() => {
      problemController.resizeCanvas();
      solutionController.resizeCanvas();
      fullscreenButtonRef.current?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("quiz-ink-fullscreen-open");
    };
  }, [fullscreen, problemController.resizeCanvas, solutionController.resizeCanvas]);

  function controllerFor(surface: InkSurfaceName) {
    return surface === "problem" ? problemController : solutionController;
  }

  function undo() {
    const action = timelineHistoryRef.current[timelineHistoryRef.current.length - 1];
    if (!action) return;
    timelineHistoryRef.current = timelineHistoryRef.current.slice(0, -1);
    for (const surface of [...action].reverse()) controllerFor(surface).undo();
    timelineFutureRef.current = [...timelineFutureRef.current, action].slice(-MAX_HISTORY);
    setTimelineCounts({
      undo: timelineHistoryRef.current.length,
      redo: timelineFutureRef.current.length,
    });
    setStatusKey("problems.scratch.undone");
  }

  function redo() {
    const action = timelineFutureRef.current[timelineFutureRef.current.length - 1];
    if (!action) return;
    timelineFutureRef.current = timelineFutureRef.current.slice(0, -1);
    for (const surface of action) controllerFor(surface).redo();
    timelineHistoryRef.current = [...timelineHistoryRef.current, action].slice(-MAX_HISTORY);
    setTimelineCounts({
      undo: timelineHistoryRef.current.length,
      redo: timelineFutureRef.current.length,
    });
    setStatusKey("problems.scratch.redone");
  }

  function clearAll() {
    const action: InkWorkspaceAction = [];
    if (problemController.clear(false)) action.push("problem");
    if (solutionController.clear(false)) action.push("solution");
    if (action.length === 0) return;
    recordWorkspaceAction(action);
    setStatusKey("problems.ink.cleared");
  }

  function selectTool(next: ScratchpadTool) {
    setTool(next);
    setWriting(true);
    setStatusKey(
      next === "pen"
        ? scratchpadMessages.penSelected
        : next === "highlighter" ? scratchpadMessages.highlighterSelected : scratchpadMessages.eraserSelected,
    );
  }

  function toggleWriting() {
    setWriting(current => {
      const next = !current;
      setStatusKey(next ? "problems.annotation.active" : "problems.annotation.inactive");
      return next;
    });
  }

  function changeMemo(value: string) {
    const next = value.slice(0, MAX_MEMO_LENGTH);
    memoRef.current = next;
    setMemo(next);
    persistScratchpad(questionId, { strokes: solutionController.strokesRef.current, memo: next });
  }

  function trapFullscreenFocus(event: ReactKeyboardEvent<HTMLElement>) {
    if (!fullscreen || event.key !== "Tab") return;
    const focusable = Array.from(workspaceRef.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) ?? []);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const toolbarController: InkToolbarController = {
    clear: clearAll,
    preferences,
    redo,
    redoCount: timelineCounts.redo,
    selectTool,
    strokeCount: problemController.strokeCount + solutionController.strokeCount,
    tool,
    undo,
    undoCount: timelineCounts.undo,
    updatePreferences,
  };

  const workspace = (
    <section
      ref={workspaceRef}
      className={`quiz-ink-workspace${writing ? " writing" : ""}${fullscreen ? " is-fullscreen" : ""}`}
      aria-label={t("problems.ink.workspaceAria")}
      aria-modal={fullscreen || undefined}
      role={fullscreen ? "dialog" : undefined}
      tabIndex={fullscreen ? -1 : undefined}
      onKeyDown={trapFullscreenFocus}
    >
      <InkToolbar
        ariaLabel={t("problems.ink.toolbarAria")}
        className="quiz-ink-workspace-toolbar"
        controller={toolbarController}
        clearAria={t("problems.ink.clearAria")}
        redoAria={t("problems.ink.redoAria")}
        undoAria={t("problems.ink.undoAria")}
        before={(
          <button
            type="button"
            className="quiz-ink-mode"
            aria-pressed={writing}
            onClick={toggleWriting}
          >
            {t(writing ? "problems.ink.scroll" : "problems.ink.write")}
          </button>
        )}
        after={(
          <button
            ref={fullscreenButtonRef}
            type="button"
            className="quiz-ink-fullscreen-toggle"
            aria-pressed={fullscreen}
            onClick={() => setFullscreen(current => !current)}
          >
            {t(fullscreen ? "problems.ink.exitFullscreen" : "problems.ink.fullscreen")}
          </button>
        )}
      />
      <p className="quiz-ink-workspace-help" id={helpId}>{t("problems.ink.help")}</p>
      <div className="quiz-ink-document">
        <div className="quiz-ink-problem-surface">
          <div className="quiz-ink-problem-content">{children}</div>
          <canvas
            ref={problemController.canvasRef}
            className={`quiz-ink-canvas problem${tool === "eraser" ? " erasing" : ""}${preferences.pencilOnly ? " pencil-only" : ""}`}
            aria-label={t("problems.annotation.canvasAria")}
            aria-describedby={helpId}
            aria-hidden={!writing}
            onPointerDown={problemController.startStroke}
            onPointerMove={problemController.appendSamples}
            onPointerUp={event => problemController.finishStroke(event, true)}
            onPointerCancel={event => problemController.finishStroke(event, false)}
            onContextMenu={event => event.preventDefault()}
          >
            {t("problems.scratch.unsupported")}
          </canvas>
        </div>
        <section className="quiz-ink-solution" aria-labelledby={solutionTitleId}>
          <div className="quiz-ink-solution-heading">
            <h3 id={solutionTitleId}>{t("problems.ink.solutionTitle")}</h3>
            <span>{t("problems.ink.solutionSummary")}</span>
          </div>
          <canvas
            ref={solutionController.canvasRef}
            className={`quiz-ink-canvas solution${tool === "eraser" ? " erasing" : ""}${preferences.pencilOnly ? " pencil-only" : ""}`}
            aria-label={t("problems.scratch.canvasAria")}
            aria-describedby={helpId}
            aria-hidden={!writing}
            onPointerDown={solutionController.startStroke}
            onPointerMove={solutionController.appendSamples}
            onPointerUp={event => solutionController.finishStroke(event, true)}
            onPointerCancel={event => solutionController.finishStroke(event, false)}
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
              rows={3}
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
        </section>
      </div>
      <span className="quiz-scratchpad-status" role="status" aria-live="polite">{t(statusKey)}</span>
    </section>
  );
  return fullscreen && typeof document !== "undefined" ? createPortal(workspace, document.body) : workspace;
}
