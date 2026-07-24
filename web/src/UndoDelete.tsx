import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useI18n, type Translate } from "./i18n";

export const UNDO_DELETE_DELAY_MS = 5000;

interface DeleteRequest {
  key: string;
  label: string;
  commit: () => Promise<void>;
}

type DeletePhase = "waiting" | "committing" | "failed";

interface DeleteState {
  request: DeleteRequest;
  phase: DeletePhase;
  error?: string;
}

interface UndoDeleteValue {
  pending: { key: string; phase: DeletePhase } | null;
  schedule: (request: DeleteRequest) => boolean;
}

const UndoDeleteContext = createContext<UndoDeleteValue | null>(null);

export function useUndoDelete(): UndoDeleteValue {
  const value = useContext(UndoDeleteContext);
  if (!value) throw new Error("useUndoDelete must be used inside UndoDeleteProvider");
  return value;
}

function errorMessage(error: unknown, t: Translate): string {
  return error instanceof Error ? error.message : t("shell.undo.deleteFailed");
}

export function UndoDeleteProvider({ children }: { children: ReactNode }) {
  const { t, formatNumber } = useI18n();
  const [state, setState] = useState<DeleteState | null>(null);
  const activeRef = useRef<DeleteRequest | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actionButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const committedRef = useRef(false);

  const commitActive = useCallback(async () => {
    const request = activeRef.current;
    if (!request) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setState({ request, phase: "committing" });
    try {
      await request.commit();
      activeRef.current = null;
      committedRef.current = true;
      setState(null);
    } catch (error) {
      setState({ request, phase: "failed", error: errorMessage(error, t) });
    }
  }, [t]);

  const schedule = useCallback((request: DeleteRequest) => {
    if (activeRef.current) return false;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    committedRef.current = false;
    activeRef.current = request;
    setState({ request, phase: "waiting" });
    timerRef.current = setTimeout(() => { void commitActive(); }, UNDO_DELETE_DELAY_MS);
    return true;
  }, [commitActive]);

  const undo = useCallback(() => {
    if (!activeRef.current || state?.phase !== "waiting") return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    activeRef.current = null;
    setState(null);
  }, [state?.phase]);

  const dismiss = useCallback(() => {
    if (state?.phase !== "failed") return;
    activeRef.current = null;
    setState(null);
  }, [state?.phase]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);
  useEffect(() => {
    if (state?.phase === "waiting" || state?.phase === "failed") {
      actionButtonRef.current?.focus();
    } else if (!state && previousFocusRef.current) {
      const main = document.getElementById("main-content");
      const target = committedRef.current && main
        ? main
        : previousFocusRef.current.isConnected ? previousFocusRef.current : main;
      target?.focus();
      previousFocusRef.current = null;
      committedRef.current = false;
    }
  }, [state?.phase]);

  const value = useMemo<UndoDeleteValue>(() => ({
    pending: state ? { key: state.request.key, phase: state.phase } : null,
    schedule,
  }), [state, schedule]);

  return (
    <UndoDeleteContext.Provider value={value}>
      {children}
      {state && (
        <div className={`undo-delete-bar ${state.phase}`} role={state.phase === "failed" ? "alert" : "status"}>
          <span>
            {state.phase === "waiting" && t("shell.undo.waiting", {
              label: state.request.label,
              seconds: formatNumber(UNDO_DELETE_DELAY_MS / 1000),
            })}
            {state.phase === "committing" && t("shell.undo.committing", { label: state.request.label })}
            {state.phase === "failed" && t("shell.undo.failed", {
              label: state.request.label,
              error: state.error ?? t("shell.undo.deleteFailed"),
            })}
          </span>
          {state.phase !== "failed" && (
            <button
              ref={actionButtonRef}
              type="button"
              onClick={undo}
              aria-disabled={state.phase === "committing"}
            >{state.phase === "waiting" ? t("shell.undo.cancel") : t("shell.undo.deleting")}</button>
          )}
          {state.phase === "failed" && (
            <>
              <button ref={actionButtonRef} type="button" onClick={() => { void commitActive(); }}>{t("shell.undo.retry")}</button>
              <button type="button" onClick={dismiss}>{t("shell.undo.close")}</button>
            </>
          )}
        </div>
      )}
    </UndoDeleteContext.Provider>
  );
}
