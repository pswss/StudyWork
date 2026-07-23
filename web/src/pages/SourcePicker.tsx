// SourcePicker.tsx — 자료 다중 선택 드롭다운 (단권화 소스·채팅 컨텍스트 공용)
// 제외 집합 방식: 기본 전체 포함, 새로 올린 자료도 자동 포함된다.
import { useEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import { Material } from "../api";

export default function SourcePicker({
  label,
  materials,
  excluded,
  onToggle,
  onSetVisible,
}: {
  label: string;
  materials: Material[];
  excluded: Set<number>;
  onToggle: (id: number) => void;
  onSetVisible: (ids: number[], included: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const needle = query.trim().normalize("NFKC").toLowerCase();
  const visible = needle
    ? materials.filter((material) =>
        `${material.title} ${material.original_filename ?? ""}`.normalize("NFKC").toLowerCase().includes(needle)
      )
    : materials;
  const selected = materials.reduce((count, material) => count + (excluded.has(material.id) ? 0 : 1), 0);
  const visibleIds = visible.map((material) => material.id);
  const visibleSelected = visible.reduce((count, material) => count + (excluded.has(material.id) ? 0 : 1), 0);
  const allVisibleSelected = visible.length > 0 && visibleSelected === visible.length;
  const selectAllAction = allVisibleSelected ? "전체 해제" : "전체 선택";
  const selectAllLabel = needle ? `검색 결과 ${selectAllAction}` : selectAllAction;

  function handleToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    if (!event.currentTarget.open) {
      setQuery("");
      return;
    }
    const finePointer = typeof window.matchMedia !== "function" || window.matchMedia("(pointer: fine)").matches;
    if (finePointer) queueMicrotask(() => searchRef.current?.focus({ preventScroll: true }));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDetailsElement>) {
    if (event.key !== "Escape" || !event.currentTarget.open) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.open = false;
    setQuery("");
    summaryRef.current?.focus();
  }

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const details = detailsRef.current;
      if (!details?.open || !event.target || details.contains(event.target as Node)) return;
      details.open = false;
      setQuery("");
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);

  return (
    <details ref={detailsRef} className="note-source-picker" onToggle={handleToggle} onKeyDown={handleKeyDown}>
      <summary ref={summaryRef}>
        <span>{label}</span>
        <strong aria-live="polite" aria-atomic="true">{selected}/{materials.length}개 선택</strong>
      </summary>
      <div className="note-source-panel">
        <input
          ref={searchRef}
          className="text-input note-source-search"
          type="search"
          name="source-search"
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="예: 1학기 강의 노트…"
          aria-label={`${label} 검색`}
        />
        {/* 전체 선택 토글 행 — 전부 선택되면 행이 라임으로 점등, 일부만이면 라임 테두리 */}
        <label className="note-source-row note-source-all">
          <input
            type="checkbox"
            checked={allVisibleSelected}
            ref={(el) => { if (el) el.indeterminate = !allVisibleSelected && visibleSelected > 0; }}
            onChange={() => onSetVisible(visibleIds, !allVisibleSelected)}
            aria-label={`${label} ${selectAllLabel}`}
            disabled={visible.length === 0}
          />
          <span>
            <strong>{selectAllLabel}</strong>
            <small aria-live="polite" aria-atomic="true">
              {needle ? `${visible.length}개 검색됨` : `${visible.length}개 표시`} · {visibleSelected}개 선택
            </small>
          </span>
        </label>
        <div className="note-source-list" role="group" aria-label={`${label}에 포함할 자료`}>
          {visible.map((material) => (
            <label className="note-source-row" key={material.id}>
              <input
                type="checkbox"
                checked={!excluded.has(material.id)}
                onChange={() => onToggle(material.id)}
              />
              <span>
                <strong>{material.title}</strong>
                <small>
                  {material.kind === "pdf" ? "PDF" : material.kind === "image" ? "사진" : "텍스트"}
                  {material.original_filename && material.original_filename.normalize("NFC") !== material.title.normalize("NFC")
                    ? ` · ${material.original_filename}`
                    : ""}
                </small>
              </span>
            </label>
          ))}
          {visible.length === 0 && <p className="note-source-none">일치하는 소스가 없습니다.</p>}
        </div>
      </div>
    </details>
  );
}
