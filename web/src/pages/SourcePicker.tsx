// SourcePicker.tsx — 자료 다중 선택 드롭다운 (단권화 소스·채팅 컨텍스트 공용)
// 제외 집합 방식: 기본 전체 포함, 새로 올린 자료도 자동 포함된다.
import { useEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import { Material } from "../api";
import { closeDetails } from "../details-close";

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
  const pointerOpenRef = useRef(false);
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
  // 상태 기준 라벨 — 액션명("전체 선택/해제") 대신 개념명; 동작은 토글 표식으로 명시
  const selectAllLabel = needle ? "검색 결과 전체" : "전체 자료";
  // 접근명은 보이는 라벨을 포함(WCAG 2.5.3) + 상태 서술(액션 아님)
  const selectAllState = allVisibleSelected ? "전체 선택됨" : visibleSelected > 0 ? "일부 선택됨" : "전체 해제됨";
  const selectAllAria = `${label} ${selectAllLabel}, ${selectAllState}`;

  function handleToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    if (!event.currentTarget.open) {
      setQuery("");
      pointerOpenRef.current = false;
      return;
    }
    // 포인터로 열었을 때만 검색창 자동 포커스 — 키보드로 열면 summary 포커스 유지
    const finePointer = typeof window.matchMedia !== "function" || window.matchMedia("(pointer: fine)").matches;
    if (pointerOpenRef.current && finePointer) queueMicrotask(() => searchRef.current?.focus({ preventScroll: true }));
    pointerOpenRef.current = false;
    // 레이아웃이 안정된 뒤(더블 rAF) 최소량만 스크롤 — summary와 패널 하단이 둘 다 보이게
    requestAnimationFrame(() => requestAnimationFrame(revealPicker));
  }

  // 열린 패널이 뷰포트(채팅 입력창이 있으면 그 위)를 넘치면 최소량만 스크롤
  function revealPicker() {
    const details = detailsRef.current;
    const summary = summaryRef.current;
    if (!details || !summary) return;
    // 채팅 입력창이 뒤따르면 그 상단을 하한으로 — 입력창이 화면 밖으로 밀리지 않게
    const chatRow = details.parentElement?.querySelector<HTMLElement>(".chat-input-row");
    const chatH = chatRow && chatRow.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_PRECEDING
      ? chatRow.getBoundingClientRect().height + 16 // margin-top:16px
      : 0;
    const bottomLimit = window.innerHeight - chatH;
    const panelBottom = details.getBoundingClientRect().bottom;
    const overflow = panelBottom - bottomLimit;
    if (overflow <= 0) return; // 이미 다 보임
    // 패널 하단이 보이도록 내리되, summary 상단이 화면 위로 잘리지 않는 선까지만
    const summaryTop = summary.getBoundingClientRect().top;
    const by = Math.min(overflow, Math.max(0, summaryTop - 8));
    if (by > 0) window.scrollBy({ top: by, behavior: "smooth" });
  }

  // 옵션 목록 화살표 이동 (roving) — 탭 리스트와 같은 접근
  function handleListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const inputs = Array.from(
      event.currentTarget.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    );
    const current = inputs.indexOf(document.activeElement as HTMLInputElement);
    if (current === -1) return;
    event.preventDefault();
    const next = (current + (event.key === "ArrowDown" ? 1 : -1) + inputs.length) % inputs.length;
    inputs[next]?.focus();
  }

  // 검색창에서 ArrowDown → 첫 옵션 행으로 진입 (리스트 밖 요소라 handleListKeyDown이 못 잡음)
  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "ArrowDown") return;
    const first = detailsRef.current?.querySelector<HTMLInputElement>(
      '.note-source-list input[type="checkbox"]'
    );
    if (!first) return;
    event.preventDefault();
    first.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDetailsElement>) {
    if (event.key !== "Escape" || !event.currentTarget.open) return;
    event.preventDefault();
    event.stopPropagation();
    // 모든 닫힘 경로를 closeDetails로 통일 — 패널만 애니메이션, 애니메이션 종료 후 open 제거
    closeDetails(event.currentTarget, () => summaryRef.current?.focus());
    setQuery("");
  }

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const details = detailsRef.current;
      if (!details?.open || !event.target || details.contains(event.target as Node)) return;
      closeDetails(details);
      setQuery("");
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);

  // 하단 마스크는 더 스크롤할 게 있을 때만 — 스크롤 끝에선 가짜 "더 있음" 신호 제거
  useEffect(() => {
    const list = detailsRef.current?.querySelector<HTMLElement>(".note-source-list");
    if (!list) return;
    const update = () => {
      const atEnd = list.scrollTop >= list.scrollHeight - list.clientHeight - 1;
      list.classList.toggle("at-end", atEnd);
    };
    update();
    list.addEventListener("scroll", update, { passive: true });
    return () => list.removeEventListener("scroll", update);
  });

  return (
    <details ref={detailsRef} className="note-source-picker" onToggle={handleToggle} onKeyDown={handleKeyDown}>
      <summary ref={summaryRef} onPointerDown={() => { if (!detailsRef.current?.open) pointerOpenRef.current = true; }}>
        <span>{label}</span>
        <strong className={selected === 0 ? "empty" : undefined} aria-live="polite" aria-atomic="true">
          {selected}/{materials.length}개 선택
        </strong>
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
          onKeyDown={handleSearchKeyDown}
          placeholder="예: 1학기 강의 노트…"
          aria-label={`${label} 검색`}
        />
        {/* 전체 선택 토글 행 — 상태 기준 라벨, 동작은 체크 표식으로 명시 */}
        <label className="note-source-row note-source-all">
          <input
            type="checkbox"
            checked={allVisibleSelected}
            ref={(el) => { if (el) el.indeterminate = !allVisibleSelected && visibleSelected > 0; }}
            onChange={() => onSetVisible(visibleIds, !allVisibleSelected)}
            aria-label={selectAllAria}
            disabled={visible.length === 0}
          />
          <span>
            <strong>{selectAllLabel}</strong>
            <small className={visibleSelected === 0 && visible.length > 0 ? "empty" : undefined}>
              {needle ? `${visible.length}개 검색됨` : `${visible.length}개 표시`} · {visibleSelected}개 선택
            </small>
          </span>
        </label>
        <div className="note-source-list" role="group" aria-label={`${label}에 포함할 자료`} onKeyDown={handleListKeyDown}>
          {visible.map((material) => (
            <label className="note-source-row" key={material.id}>
              <input
                type="checkbox"
                checked={!excluded.has(material.id)}
                onChange={() => onToggle(material.id)}
                aria-label={`${material.title} 포함`}
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
        {/* 모바일: 패널 하단 닫기 어포던스 (마이크로 라벨 재사용) — 데스크톱은 CSS로 숨김 */}
        <button
          type="button"
          className="note-source-close"
          onClick={() => detailsRef.current && closeDetails(detailsRef.current, () => summaryRef.current?.focus())}
        >
          닫기
        </button>
      </div>
    </details>
  );
}
