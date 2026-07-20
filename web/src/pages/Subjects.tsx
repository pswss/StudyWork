import { useState, useRef, KeyboardEvent } from "react";
import { Subject, createSubject, deleteSubject } from "../api";
import { Reveal } from "../motion";

interface Props {
  list: Subject[];
  onOpen: (s: Subject) => void;
  onRefresh: () => void;
}

export default function Subjects({ list, onOpen, onRefresh }: Props) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function startAdd() {
    setAdding(true);
    setNewName("");
    setTimeout(() => inputRef.current?.focus(), 30);
  }

  async function doCreate() {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      await createSubject(name);
      onRefresh();
    } finally {
      setAdding(false);
      setNewName("");
      setCreating(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") doCreate();
    if (e.key === "Escape") { setAdding(false); setNewName(""); }
  }

  async function doDelete(e: React.MouseEvent, s: Subject) {
    e.stopPropagation();
    if (!confirm(`"${s.name}" 과목을 삭제하시겠습니까? 자료와 대화도 모두 삭제됩니다.`)) return;
    await deleteSubject(s.id);
    onRefresh();
  }

  return (
    <div className="page subjects-page">
      <header className="subjects-head">
        <Reveal delay={0.04} className="micro-label">OBSIDIAN ARCHIVE / 인덱스</Reveal>
        <Reveal delay={0.1} as="h1" className="subjects-title">과목</Reveal>
        <Reveal delay={0.18} className="subjects-count">
          <span className="count-num">{String(list.length).padStart(2, "0")}</span>
          <span className="count-word">개 등록됨</span>
        </Reveal>
      </header>

      <div className="rule" />

      <div className="subj-list">
        {list.map((s, i) => (
          <div
            key={s.id}
            className="subj-card clickable"
            onClick={() => onOpen(s)}
          >
            <span className="subj-index">{String(i + 1).padStart(2, "0")}</span>
            <div className="subj-body">
              <div className="subj-name">{s.name}</div>
              <div className="subj-meta">자료 {s.material_count}</div>
            </div>
            <div className="subj-tail">
              <span className="subj-open">열기 <span className="subj-open-arrow">→</span></span>
              <button className="subj-del" onClick={e => doDelete(e, s)}>삭제</button>
            </div>
          </div>
        ))}

        {adding ? (
          <div className="subj-card editing">
            <span className="subj-index accent">＋</span>
            <div className="subj-body">
              <input
                ref={inputRef}
                className="subj-add-input"
                type="text"
                placeholder="과목 이름 입력 후 Enter"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={onKey}
                disabled={creating}
              />
            </div>
          </div>
        ) : (
          <div className="subj-card add clickable" onClick={startAdd}>
            <span className="subj-index accent">＋</span>
            <div className="subj-body">
              <div className="subj-name add-name">과목 추가</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
