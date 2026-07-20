import { useState, useEffect, useCallback, Suspense, lazy, Component, ReactNode } from "react";
import Login from "./pages/Login";
import Subjects from "./pages/Subjects";
import SubjectDetail from "./pages/SubjectDetail";
import Cursor from "./Cursor";
import { Mood } from "./mood";
import { useEscape } from "./escape";
import { Subject, subjects as apiSubjects, AuthError } from "./api";

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

export default function App() {
  const [page, setPage] = useState<Page>("subjects");
  const [subjectList, setSubjectList] = useState<Subject[]>([]);
  const [openSubject, setOpenSubject] = useState<Subject | null>(null);
  const [loading, setLoading] = useState(true);
  // 상세 화면 활성 탭 인덱스(0-4) — 3D 조형물 반응용
  const [accent, setAccent] = useState(0);

  // probe auth on mount
  useEffect(() => {
    apiSubjects()
      .then(list => { setSubjectList(list); setPage("subjects"); })
      .catch(e => { if (e instanceof AuthError) setPage("login"); })
      .finally(() => setLoading(false));
  }, []);

  // 세션 만료(401) 이벤트 → 로그인 화면으로, 열려있던 과목 초기화
  useEffect(() => {
    function onAuthExpired() {
      setOpenSubject(null);
      setPage("login");
    }
    window.addEventListener("sw:auth-expired", onAuthExpired);
    return () => window.removeEventListener("sw:auth-expired", onAuthExpired);
  }, []);

  const loadSubjects = useCallback(() => {
    apiSubjects().then(list => setSubjectList(list)).catch(() => {});
  }, []);

  function onLogin() {
    // 목록 로드가 실패해도 로그인은 성공한 상태 — 화면은 넘어가고 목록만 비워둔다
    apiSubjects()
      .then(list => setSubjectList(list))
      .catch(() => {})
      .finally(() => setPage("subjects"));
  }

  function openSubjectDetail(s: Subject) {
    setOpenSubject(s);
    setAccent(0);
    setPage("detail");
  }

  function goHome() {
    setOpenSubject(null);
    setPage("subjects");
    loadSubjects();
  }

  // ESC: 상세 화면에서 과목 목록으로 (안쪽 모드가 없을 때만 — priority 0)
  useEscape(page === "detail", goHome, 0);

  const mood: Mood = page === "login" ? "login" : page === "detail" ? "detail" : "subjects";

  return (
    <>
      <SceneBoundary>
        <Suspense fallback={null}>
          <Scene mood={mood} accent={accent} />
        </Suspense>
      </SceneBoundary>
      <div className="grain" />
      <div className="vignette" aria-hidden />
      <Cursor />

      {!loading && page !== "login" && (
        <nav>
          <div className="brand" onClick={goHome}>
            <span className="brand-mark">SW</span>
            <span className="brand-name">Study<em>Work</em></span>
          </div>
          <span className="nav-label">OBSIDIAN ARCHIVE</span>
        </nav>
      )}

      {!loading && (
        <>
          {page === "login" && <Login onLogin={onLogin} />}
          {page === "subjects" && (
            <Subjects list={subjectList} onOpen={openSubjectDetail} onRefresh={loadSubjects} />
          )}
          {page === "detail" && openSubject && (
            <SubjectDetail subject={openSubject} onBack={goHome} onTabChange={setAccent} />
          )}
        </>
      )}
    </>
  );
}
