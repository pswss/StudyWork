// SourcePicker.tsx — 자료 다중 선택 드롭다운 (단권화 소스·채팅 컨텍스트 공용)
// 제외 집합 방식: 기본 전체 포함, 새로 올린 자료도 자동 포함된다.
import { useState } from "react";
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
  const needle = query.trim().normalize("NFKC").toLowerCase();
  const visible = needle
    ? materials.filter((material) =>
        `${material.title} ${material.original_filename ?? ""}`.normalize("NFKC").toLowerCase().includes(needle)
      )
    : materials;
  const selected = materials.reduce((count, material) => count + (excluded.has(material.id) ? 0 : 1), 0);
  const visibleIds = visible.map((material) => material.id);

  return (
    <details className="note-source-picker">
      <summary>
        <span>{label}</span>
        <strong>{selected}/{materials.length}개 선택</strong>
      </summary>
      <div className="note-source-panel">
        <input
          className="text-input note-source-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="문제집·자료 이름 검색"
          aria-label={`${label} 검색`}
        />
        <div className="note-source-actions">
          <span>{visible.length}개 표시</span>
          <button type="button" onClick={() => onSetVisible(visibleIds, true)}>전체 선택</button>
          <button type="button" onClick={() => onSetVisible(visibleIds, false)}>전체 해제</button>
        </div>
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
                  {material.original_filename && material.original_filename !== material.title
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
