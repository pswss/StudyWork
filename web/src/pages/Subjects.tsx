import { useEffect, useState, useRef, KeyboardEvent } from "react";
import { Subject, createSubject, deleteSubject } from "../api";
import { Reveal } from "../motion";
import { useUndoDelete } from "../UndoDelete";
import { detailUrl } from "../route-url";

interface Props {
  list: Subject[];
  onOpen: (s: Subject) => void;
  onRefresh: () => void;
}

export default function Subjects({ list, onOpen, onRefresh }: Props) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [actionErr, setActionErr] = useState("");
  const [query, setQuery] = useState(() => new URLSearchParams(window.location.search).get("q") ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const { pending, schedule } = useUndoDelete();
  const normalizedQuery = query.normalize("NFKC").trim().toLocaleLowerCase("ko-KR");
  const visibleSubjects = normalizedQuery
    ? list.filter(subject => subject.name.normalize("NFKC").toLocaleLowerCase("ko-KR").includes(normalizedQuery))
    : list;

  useEffect(() => {
    const focusSearch = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (query) params.set("q", query); else params.delete("q");
    const search = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`);
  }, [query]);

  function startAdd() {
    setAdding(true);
    setNewName("");
    setTimeout(() => inputRef.current?.focus(), 30);
  }

  async function doCreate() {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setActionErr("");
    try {
      await createSubject(name);
      onRefresh();
      setAdding(false);
      setNewName("");
    } catch (error) {
      setActionErr(`${error instanceof Error ? error.message : "과목을 만들지 못했습니다"} · 입력은 유지했습니다.`);
    } finally {
      setCreating(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") doCreate();
    if (e.key === "Escape") { setAdding(false); setNewName(""); }
  }

  function doDelete(e: React.MouseEvent, s: Subject) {
    e.stopPropagation();
    if (!confirm(`“${s.name}” 과목을 삭제하시겠습니까? 자료와 대화도 모두 삭제됩니다.`)) return;
    setActionErr("");
    schedule({
      key: `subject:${s.id}`,
      label: `“${s.name}” 과목`,
      commit: async () => {
        try {
          await deleteSubject(s.id);
        } finally {
          onRefresh();
        }
      },
    });
  }

  return (
    <div className="page subjects-page">
      <header className="subjects-head">
        <Reveal delay={0.1} as="h1" className="subjects-title">과목</Reveal>
        <Reveal delay={0.18} className="subjects-count">
          <span className="count-num">{String(list.length).padStart(2, "0")}</span>
          <span className="count-word">개 등록됨</span>
        </Reveal>
      </header>

      <div className="rule" />
      {actionErr && <div className="chat-err" role="alert">{actionErr}</div>}

      <label className="subject-search">
        <span>과목 찾기</span>
        <input
          ref={searchRef}
          type="search"
          name="subject-search"
          autoComplete="off"
          placeholder="예: 미적분…"
          value={query}
          onChange={event => setQuery(event.target.value)}
          aria-keyshortcuts="Meta+K Control+K"
        />
        <kbd>⌘ K</kbd>
      </label>
      <div className="subject-search-status" role="status" aria-live="polite">
        {query ? `${visibleSubjects.length}개 찾음` : ""}
      </div>

      <div className="subj-list">
        {visibleSubjects.map((s, i) => (
          <div
            key={s.id}
            className="subj-card clickable"
          >
            <a
              className="subj-card-open"
              href={pending === null ? detailUrl(s.id, "chat") : undefined}
              aria-label={`${s.name} 과목 열기`}
              aria-disabled={pending !== null}
              onClick={event => {
                if (pending !== null) { event.preventDefault(); return; }
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                onOpen(s);
              }}
            />
            <span className="subj-index">{String(i + 1).padStart(2, "0")}</span>
            <div className="subj-body">
              <div className="subj-name">{s.name}</div>
              <div className="subj-meta">자료 {s.material_count}</div>
            </div>
            <div className="subj-tail">
              <span className="subj-open">열기 <span className="subj-open-arrow" aria-hidden="true">→</span></span>
              <button className="subj-del" disabled={pending !== null} onClick={e => doDelete(e, s)}>
                {pending?.key === `subject:${s.id}` ? "삭제 예정" : "삭제"}
              </button>
            </div>
          </div>
        ))}

        {visibleSubjects.length === 0 && (
          <div className="subject-search-empty">“{query}”과 일치하는 과목이 없습니다.</div>
        )}

        {adding ? (
          <div className="subj-card editing">
            <span className="subj-index accent" aria-hidden="true">＋</span>
            <div className="subj-body">
              <input
                ref={inputRef}
                className="subj-add-input"
                type="text"
                name="subject-name"
                autoComplete="off"
                aria-label="새 과목 이름"
                placeholder="예: 미적분…"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={onKey}
                disabled={creating}
              />
              {creating && <span className="subj-create-status" role="status">과목 만드는 중…</span>}
            </div>
          </div>
        ) : (
          <div className="subj-card add clickable">
            <button
              type="button"
              className="subj-card-open"
              aria-label="과목 추가"
              onClick={startAdd}
            />
            <span className="subj-index accent" aria-hidden="true">＋</span>
            <div className="subj-body">
              <div className="subj-name add-name">과목 추가</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
