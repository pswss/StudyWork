import { useState, useEffect, useCallback } from "react";
import Login from "./pages/Login";
import Subjects from "./pages/Subjects";
import SubjectDetail, { type SubjectTab } from "./pages/SubjectDetail";
import { useEscape } from "./escape";
import {
  type AuthStatus,
  AuthError,
  authStatus as getAuthStatus,
  logout as apiLogout,
  Subject,
  subjects as apiSubjects,
} from "./api";
import { UndoDeleteProvider } from "./UndoDelete";
import { detailUrl, subjectsUrl } from "./route-url";
import { LocalePicker, useI18n } from "./i18n";

type Page = "login" | "subjects" | "detail";
type AppError = "" | "loadSubjects" | "logout";
const DETAIL_TABS = new Set<SubjectTab>(["chat", "quiz", "solution", "exam", "note", "settings"]);

export function parseStudyRoute(search: string): { subjectId: number; tab: SubjectTab } | null {
  const params = new URLSearchParams(search);
  const rawSubjectId = params.get("subject");
  const rawTab = params.get("tab") ?? "chat";
  if (!rawSubjectId || !/^[1-9]\d*$/.test(rawSubjectId)) return null;
  const subjectId = Number(rawSubjectId);
  const tab = rawTab as SubjectTab;
  return Number.isSafeInteger(subjectId) && DETAIL_TABS.has(tab) ? { subjectId, tab } : null;
}

export default function App() {
  const { locale, t } = useI18n();
  const [page, setPage] = useState<Page>("subjects");
  const [subjectList, setSubjectList] = useState<Subject[]>([]);
  const [openSubject, setOpenSubject] = useState<Subject | null>(null);
  const [loading, setLoading] = useState(true);
  const [appErr, setAppErr] = useState<AppError>("");
  const [detailTab, setDetailTab] = useState<SubjectTab>("chat");
  const [detailDirty, setDetailDirty] = useState(false);
  const [auth, setAuth] = useState<AuthStatus>({
    ownerExists: true,
    authenticated: false,
    authKind: null,
  });
  const [loggingOut, setLoggingOut] = useState(false);

  const applyRoute = useCallback((list: Subject[]) => {
    const route = parseStudyRoute(window.location.search);
    const routedSubject = route ? list.find(subject => subject.id === route.subjectId) : undefined;
    if (route && routedSubject) {
      setOpenSubject(routedSubject);
      setDetailTab(route.tab);
      setPage("detail");
      return;
    }
    const params = new URLSearchParams(window.location.search);
    if (params.has("subject") || params.has("tab")) {
      params.delete("subject");
      params.delete("tab");
      const query = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    }
    setOpenSubject(null);
    setPage("subjects");
  }, []);

  // 공개 상태를 먼저 확인해 첫 실행은 가입, 이후는 로그인 화면으로 정확히 보낸다.
  useEffect(() => {
    getAuthStatus()
      .then(async status => {
        setAuth(status);
        if (!status.authenticated) {
          setPage("login");
          return;
        }
        const list = await apiSubjects();
        setSubjectList(list);
        applyRoute(list);
        setAppErr("");
      })
      .catch(e => {
        if (e instanceof AuthError) {
          setPage("login");
          setAuth(current => ({ ...current, authenticated: false, authKind: null }));
        }
        else setAppErr("loadSubjects");
      })
      .finally(() => setLoading(false));
  }, [applyRoute]);

  // 세션 만료(401) 이벤트 → 로그인 화면으로, 열려있던 과목 초기화
  useEffect(() => {
    function onAuthExpired() {
      setOpenSubject(null);
      setPage("login");
      setAuth(current => ({ ...current, authenticated: false, authKind: null }));
      void getAuthStatus().then(setAuth).catch(() => {});
    }
    window.addEventListener("sw:auth-expired", onAuthExpired);
    return () => window.removeEventListener("sw:auth-expired", onAuthExpired);
  }, []);

  useEffect(() => {
    if (page === "login") return;
    const onPopState = () => {
      const route = parseStudyRoute(window.location.search);
      const staysInCurrentDetail = page === "detail"
        && route?.subjectId === openSubject?.id
        && route?.tab === detailTab;
      if (page === "detail" && detailDirty && !staysInCurrentDetail) {
        if (!confirm(t("shell.unsaved.goSubjects"))) {
          window.history.pushState(null, "", detailUrl(openSubject!.id, detailTab));
          return;
        }
        setDetailDirty(false);
      }
      applyRoute(subjectList);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [applyRoute, detailDirty, detailTab, openSubject, page, subjectList, t]);

  useEffect(() => {
    if (loading) return;
    document.title = page === "detail" && openSubject
      ? `${openSubject.name} — Remap`
      : page === "login" ? t("shell.title.login") : t("shell.title.subjects");
    if (page !== "login") document.getElementById("main-content")?.focus();
  }, [loading, locale, openSubject?.id, page, t]);

  const loadSubjects = useCallback(async () => {
    try {
      const list = await apiSubjects();
      setSubjectList(list);
      setAppErr("");
    } catch (error) {
      setAppErr("loadSubjects");
    }
  }, []);

  function onLogin(status: AuthStatus) {
    setAuth(status);
    // 목록 로드가 실패해도 로그인은 성공한 상태 — 화면은 넘어가고 목록만 비워둔다
    apiSubjects()
      .then(list => { setSubjectList(list); applyRoute(list); setAppErr(""); })
      .catch(() => setAppErr("loadSubjects"))
      .finally(() => {
        if (!parseStudyRoute(window.location.search)) setPage("subjects");
      });
  }

  async function doLogout() {
    if (loggingOut) return;
    if (detailDirty && !confirm(t("shell.unsaved.logout"))) return;
    setLoggingOut(true);
    setAppErr("");
    try {
      await apiLogout();
      setDetailDirty(false);
      setOpenSubject(null);
      setAuth(current => ({ ...current, authenticated: false, authKind: null, username: undefined }));
      setPage("login");
      window.history.replaceState(null, "", subjectsUrl());
    } catch (error) {
      setAppErr("logout");
    } finally {
      setLoggingOut(false);
    }
  }

  function openSubjectDetail(s: Subject) {
    setDetailDirty(false);
    setOpenSubject(s);
    setDetailTab("chat");
    setPage("detail");
    window.history.pushState(null, "", detailUrl(s.id, "chat"));
  }

  function goHome() {
    if (detailDirty && !confirm(t("shell.unsaved.goSubjects"))) return;
    setDetailDirty(false);
    setOpenSubject(null);
    setPage("subjects");
    window.history.replaceState(null, "", subjectsUrl());
    loadSubjects();
  }

  // ESC: 상세 화면에서 과목 목록으로 (안쪽 모드가 없을 때만 — priority 0)
  useEscape(page === "detail", goHome, 0);

  return (
    <UndoDeleteProvider>
      <a className="skip-link" href="#main-content">{t("shell.skipToContent")}</a>
      <div className="vignette" aria-hidden />

      {!loading && page !== "login" && (
        <nav>
          <a
            className="brand"
            href={subjectsUrl()}
            onClick={event => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              goHome();
            }}
            aria-label={t("shell.goToSubjects")}
          >
            <span className="brand-mark" translate="no">RM</span>
            <span className="brand-name" translate="no">Re<em>map</em></span>
          </a>
          <div className="nav-account">
            <span className="nav-label">{auth.username ?? t("shell.personalLibrary")}</span>
            <LocalePicker compact />
            <button type="button" className="nav-logout" disabled={loggingOut} onClick={() => { void doLogout(); }}>
              {loggingOut ? t("shell.loggingOut") : t("shell.logout")}
            </button>
          </div>
        </nav>
      )}

      <main id="main-content" tabIndex={-1}>
        {loading && <div className="app-loading" role="status">{t("shell.loadingApp")}</div>}
        {!loading && (
          <>
            {page === "login" && <Login ownerExists={auth.ownerExists} onLogin={onLogin} />}
            {page === "subjects" && (
              <>
                {appErr && (
                  <div className="app-load-error" role="alert">
                    <span>{t(appErr === "logout" ? "shell.logoutError" : "shell.loadSubjectsError")}</span>
                    <button type="button" onClick={() => { void loadSubjects(); }}>{t("shell.retry")}</button>
                  </div>
                )}
                <Subjects list={subjectList} onOpen={openSubjectDetail} onRefresh={() => { void loadSubjects(); }} />
              </>
            )}
            {page === "detail" && openSubject && (
              <SubjectDetail
                key={openSubject.id}
                subject={openSubject}
                initialTab={detailTab}
                onBack={goHome}
                onDirtyChange={setDetailDirty}
                onTabChange={nextTab => {
                  setDetailTab(nextTab);
                  window.history.replaceState(null, "", detailUrl(openSubject.id, nextTab));
                }}
              />
            )}
          </>
        )}
      </main>
    </UndoDeleteProvider>
  );
}
