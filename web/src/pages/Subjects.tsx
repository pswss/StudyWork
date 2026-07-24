import { useEffect, useState, useRef, KeyboardEvent } from "react";
import { Subject, createSubject, deleteSubject } from "../api";
import { Reveal } from "../motion";
import { useUndoDelete } from "../UndoDelete";
import { detailUrl } from "../route-url";
import { useI18n } from "../i18n";

interface Props {
  list: Subject[];
  onOpen: (s: Subject) => void;
  onRefresh: () => void;
}

export default function Subjects({ list, onOpen, onRefresh }: Props) {
  const { locale, t, formatNumber } = useI18n();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [actionErr, setActionErr] = useState(false);
  const [query, setQuery] = useState(() => new URLSearchParams(window.location.search).get("q") ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const { pending, schedule } = useUndoDelete();
  const normalizedQuery = query.normalize("NFKC").trim().toLocaleLowerCase(locale);
  const visibleSubjects = normalizedQuery
    ? list.filter(subject => subject.name.normalize("NFKC").toLocaleLowerCase(locale).includes(normalizedQuery))
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
    setActionErr(false);
    try {
      await createSubject(name);
      onRefresh();
      setAdding(false);
      setNewName("");
    } catch (error) {
      setActionErr(true);
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
    if (!confirm(t("shell.subjects.deleteConfirm", { name: s.name }))) return;
    setActionErr(false);
    schedule({
      key: `subject:${s.id}`,
      label: t("shell.subjects.deleteLabel", { name: s.name }),
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
        <Reveal delay={0.1} as="h1" className="subjects-title">{t("shell.subjects.title")}</Reveal>
        <Reveal delay={0.18} className="subjects-count">
          <span className="count-num">{formatNumber(list.length, { minimumIntegerDigits: 2, useGrouping: false })}</span>
          <span className="count-word">{t("shell.subjects.registered")}</span>
        </Reveal>
      </header>

      <div className="rule" />
      {actionErr && <div className="chat-err" role="alert">{t("shell.subjects.createError")}</div>}

      <label className="subject-search">
        <span>{t("shell.subjects.find")}</span>
        <input
          ref={searchRef}
          type="search"
          name="subject-search"
          autoComplete="off"
          placeholder={t("shell.subjects.placeholder")}
          value={query}
          onChange={event => setQuery(event.target.value)}
          aria-keyshortcuts="Meta+K Control+K"
        />
        <kbd>⌘ K</kbd>
      </label>
      <div className="subject-search-status" role="status" aria-live="polite">
        {query ? t("shell.subjects.foundCount", { count: formatNumber(visibleSubjects.length) }) : ""}
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
              aria-label={t("shell.subjects.openAria", { name: s.name })}
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
              <div className="subj-meta">{t("shell.subjects.materialCount", { count: formatNumber(s.material_count) })}</div>
            </div>
            <div className="subj-tail">
              <span className="subj-open">{t("shell.subjects.open")} <span className="subj-open-arrow" aria-hidden="true">→</span></span>
              <button className="subj-del" disabled={pending !== null} onClick={e => doDelete(e, s)}>
                {pending?.key === `subject:${s.id}`
                  ? t("shell.subjects.deleteScheduled")
                  : t("shell.subjects.delete")}
              </button>
            </div>
          </div>
        ))}

        {visibleSubjects.length === 0 && (
          <div className="subject-search-empty">{t("shell.subjects.noMatch", { query })}</div>
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
                aria-label={t("shell.subjects.newNameAria")}
                placeholder={t("shell.subjects.placeholder")}
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={onKey}
                disabled={creating}
              />
              {creating && <span className="subj-create-status" role="status">{t("shell.subjects.creating")}</span>}
            </div>
          </div>
        ) : (
          <div className="subj-card add clickable">
            <button
              type="button"
              className="subj-card-open"
              aria-label={t("shell.subjects.addAria")}
              onClick={startAdd}
            />
            <span className="subj-index accent" aria-hidden="true">＋</span>
            <div className="subj-body">
              <div className="subj-name add-name">{t("shell.subjects.add")}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
