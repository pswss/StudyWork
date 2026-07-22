import { useState, useEffect, useCallback, Suspense, lazy, Component, ReactNode } from "react";
import Login from "./pages/Login";
import Subjects from "./pages/Subjects";
import SubjectDetail, { type SubjectTab } from "./pages/SubjectDetail";
import { useEscape } from "./escape";
import { Subject, subjects as apiSubjects, AuthError } from "./api";
import { UndoDeleteProvider } from "./UndoDelete";
import { detailUrl, subjectsUrl } from "./route-url";

const Scene = lazy(() => import("./Scene"));

// WebGL을 못 만드는 환경(구형 iPad Safari, 저사양, 헤드리스)에서도
// 앱이 정상 동작하도록 3D 캔버스를 에러 바운더리로 감싼다.
// 실패 시 조용히 배경 없이(정적 차콜) 렌더링 계속.
class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { /* 3D 실패는 치명적이지 않음 — 무시 */ }
  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

type Page = "login" | "subjects" | "detail";
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
  const [page, setPage] = useState<Page>("subjects");
  const [subjectList, setSubjectList] = useState<Subject[]>([]);
  const [openSubject, setOpenSubject] = useState<Subject | null>(null);
  const [loading, setLoading] = useState(true);
  const [appErr, setAppErr] = useState("");
  const [detailTab, setDetailTab] = useState<SubjectTab>("chat");
  const [detailDirty, setDetailDirty] = useState(false);

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

  // probe auth on mount
  useEffect(() => {
    apiSubjects()
      .then(list => { setSubjectList(list); applyRoute(list); setAppErr(""); })
      .catch(e => {
        if (e instanceof AuthError) setPage("login");
        else setAppErr(e instanceof Error ? e.message : "과목 목록을 불러오지 못했습니다");
      })
      .finally(() => setLoading(false));
  }, [applyRoute]);

  // 세션 만료(401) 이벤트 → 로그인 화면으로, 열려있던 과목 초기화
  useEffect(() => {
    function onAuthExpired() {
      setOpenSubject(null);
      setPage("login");
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
        if (!confirm("저장하지 않은 노트 수정 내용이 있습니다. 과목 목록으로 이동할까요?")) {
          window.history.pushState(null, "", detailUrl(openSubject!.id, detailTab));
          return;
        }
        setDetailDirty(false);
      }
      applyRoute(subjectList);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [applyRoute, detailDirty, detailTab, openSubject, page, subjectList]);

  useEffect(() => {
    if (loading) return;
    document.title = page === "detail" && openSubject
      ? `${openSubject.name} — StudyWork`
      : page === "login" ? "로그인 — StudyWork" : "과목 — StudyWork";
    if (page !== "login") document.getElementById("main-content")?.focus();
  }, [loading, openSubject?.id, page]);

  const loadSubjects = useCallback(async () => {
    try {
      const list = await apiSubjects();
      setSubjectList(list);
      setAppErr("");
    } catch (error) {
      setAppErr(error instanceof Error ? error.message : "과목 목록을 불러오지 못했습니다");
    }
  }, []);

  function onLogin() {
    // 목록 로드가 실패해도 로그인은 성공한 상태 — 화면은 넘어가고 목록만 비워둔다
    apiSubjects()
      .then(list => { setSubjectList(list); applyRoute(list); setAppErr(""); })
      .catch(error => setAppErr(error instanceof Error ? error.message : "과목 목록을 불러오지 못했습니다"))
      .finally(() => {
        if (!parseStudyRoute(window.location.search)) setPage("subjects");
      });
  }

  function openSubjectDetail(s: Subject) {
    setDetailDirty(false);
    setOpenSubject(s);
    setDetailTab("chat");
    setPage("detail");
    window.history.pushState(null, "", detailUrl(s.id, "chat"));
  }

  function goHome() {
    if (detailDirty && !confirm("저장하지 않은 노트 수정 내용이 있습니다. 과목 목록으로 이동할까요?")) return;
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
      <a className="skip-link" href="#main-content">본문으로 건너뛰기</a>
      {page !== "detail" && (
        <SceneBoundary>
          <Suspense fallback={null}>
            <Scene mood={page === "login" ? "login" : "subjects"} accent={0} />
          </Suspense>
        </SceneBoundary>
      )}
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
            aria-label="과목 목록으로 이동"
          >
            <span className="brand-mark" translate="no">SW</span>
            <span className="brand-name" translate="no">Study<em>Work</em></span>
          </a>
          <span className="nav-label">개인 학습 자료함</span>
        </nav>
      )}

      <main id="main-content" tabIndex={-1}>
        {loading && <div className="app-loading" role="status">StudyWork 불러오는 중…</div>}
        {!loading && (
          <>
            {page === "login" && <Login onLogin={onLogin} />}
            {page === "subjects" && (
              <>
                {appErr && (
                  <div className="app-load-error" role="alert">
                    <span>{appErr}</span>
                    <button type="button" onClick={() => { void loadSubjects(); }}>다시 시도</button>
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
