// SourcePicker.tsx — 자료 다중 선택 드롭다운 (단권화 소스·채팅 컨텍스트 공용)
// 제외 집합 방식: 기본 전체 포함, 새로 올린 자료도 자동 포함된다.
import { useEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import { Material } from "../api";
import { closeDetails } from "../details-close";
import { useI18n } from "../i18n";

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
  const { locale, t, formatNumber } = useI18n();
  const [query, setQuery] = useState("");
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pointerOpenRef = useRef(false);
  const needle = query.trim().normalize("NFKC").toLocaleLowerCase(locale);
  const visible = needle
    ? materials.filter((material) =>
        `${material.title} ${material.original_filename ?? ""}`.normalize("NFKC").toLocaleLowerCase(locale).includes(needle)
      )
    : materials;
  const selected = materials.reduce((count, material) => count + (excluded.has(material.id) ? 0 : 1), 0);
  const visibleIds = visible.map((material) => material.id);
  const visibleSelected = visible.reduce((count, material) => count + (excluded.has(material.id) ? 0 : 1), 0);
  const allVisibleSelected = visible.length > 0 && visibleSelected === visible.length;
  // 상태 기준 라벨 — 액션명("전체 선택/해제") 대신 개념명; 동작은 토글 표식으로 명시
  const selectAllLabel = t(needle ? "shell.sources.searchAll" : "shell.sources.all");
  // 접근명 = 보이는 텍스트만(WCAG 2.5.3, 컨텍스트 접두 + 라벨 + 카운트) — 선택 상태는 네이티브 checked/mixed로만 전달
  const visibleCount = t(needle ? "shell.sources.searchedCount" : "shell.sources.shownCount", {
    count: formatNumber(visible.length),
  });
  const selectedCount = t("shell.sources.selectedCount", { count: formatNumber(visibleSelected) });
  const selectAllCount = t("shell.sources.countPair", { visible: visibleCount, selected: selectedCount });
  const selectAllAria = t("shell.sources.selectAllAria", {
    label,
    scope: selectAllLabel,
    count: selectAllCount,
  });

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

  // 열린 패널이 뷰포트(채팅 입력창이 있으면 그 하단까지)를 넘치면 넘친 만큼만 스크롤
  function revealPicker() {
    const details = detailsRef.current;
    if (!details) return;
    // 채팅 입력창이 뒤따르면 그 "하단"을 실측 기준으로 — 픽커 margin-bottom(16px)·행 margin까지 자동 포함
    const chatRow = details.parentElement?.querySelector<HTMLElement>(".chat-input-row");
    const anchor = chatRow && chatRow.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_PRECEDING
      ? chatRow
      : details;
    const overflow = anchor.getBoundingClientRect().bottom - window.innerHeight;
    if (overflow <= 0) return; // 이미 다 보임
    // 채팅 입력행 하단이 화면 안에 오는 것이 우선 — 소수점은 올림(정수 스크롤 양자화로 1px 미달 방지)
    window.scrollBy({ top: Math.ceil(overflow), behavior: "smooth" });
  }

  // 옵션 화살표 이동 (roving) — 전체 선택 행 + 목록 행을 하나의 순환으로 (패널에 위임)
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

  // 검색창에서 ArrowDown → 전체 선택 행(첫 체크박스)으로 진입, 이어서 목록 행
  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "ArrowDown") return;
    const first = detailsRef.current?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!first) return;
    event.preventDefault();
    event.stopPropagation(); // 패널 위임 핸들러가 포커스 이동 직후 한 칸 더 가지 않게
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

  // 페이드 마스크는 잘린 방향에만 — 위/아래 끝(또는 스크롤 불가)에선 해당 페이드 제거 (CSS at-start/at-end)
  useEffect(() => {
    const details = detailsRef.current;
    const list = details?.querySelector<HTMLElement>(".note-source-list");
    if (!details || !list) return;
    const update = () => {
      const scrollable = list.scrollHeight > list.clientHeight;
      list.classList.toggle("at-start", !scrollable || list.scrollTop <= 0);
      list.classList.toggle("at-end", !scrollable || list.scrollTop >= list.scrollHeight - list.clientHeight - 1);
    };
    update();
    // 닫힌 상태(지오메트리 0)로 계산된 값이 남지 않게 — 열림 토글 후 레이아웃이 잡히면 재계산
    const onToggle = () => { if (details.open) requestAnimationFrame(update); };
    list.addEventListener("scroll", update, { passive: true });
    details.addEventListener("toggle", onToggle);
    // 웹폰트 적용·컨테이너 크기 변화로 행 높이가 바뀌면 스크롤 가능 여부도 바뀐다 — 스테일 방지 (jsdom엔 RO 없음)
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    ro?.observe(list);
    document.fonts?.ready.then(update);
    return () => {
      list.removeEventListener("scroll", update);
      details.removeEventListener("toggle", onToggle);
      ro?.disconnect();
    };
  });

  return (
    <details ref={detailsRef} className="note-source-picker" onToggle={handleToggle} onKeyDown={handleKeyDown}>
      <summary ref={summaryRef} onPointerDown={() => { if (!detailsRef.current?.open) pointerOpenRef.current = true; }}>
        <span>{label}</span>
        <strong className={selected === 0 ? "empty" : undefined} aria-live="polite" aria-atomic="true">
          {t("shell.sources.countSummary", {
            selected: formatNumber(selected),
            total: formatNumber(materials.length),
          })}
        </strong>
      </summary>
      <div className="note-source-panel" onKeyDown={handleListKeyDown}>
        <input
          ref={searchRef}
          className="text-input note-source-search"
          type="search"
          name="source-search"
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleSearchKeyDown}
          placeholder={t("shell.sources.searchPlaceholder")}
          aria-label={t("shell.sources.searchAria", { label })}
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
              {selectAllCount}
            </small>
          </span>
        </label>
        <div className="note-source-list" role="group" aria-label={t("shell.sources.includeGroupAria", { label })}>
          {visible.map((material) => (
            <label className="note-source-row" key={material.id}>
              <input
                type="checkbox"
                checked={!excluded.has(material.id)}
                onChange={() => onToggle(material.id)}
                aria-label={t("shell.sources.includeAria", { title: material.title })}
              />
              <span>
                {/* 캡션이 유형(PDF/사진/텍스트)을 이미 보여주므로 제목의 확장자는 표시에서만 제거 */}
                <strong>{material.title.replace(/\.(pdf|png|jpe?g|webp|gif|heic|txt|md)$/i, "")}</strong>
                <small>
                  {material.kind === "pdf"
                    ? t("shell.sources.kind.pdf")
                    : material.kind === "image"
                      ? t("shell.sources.kind.photo")
                      : t("shell.sources.kind.text")}
                  {material.original_filename && material.original_filename.normalize("NFC") !== material.title.normalize("NFC")
                    ? ` · ${material.original_filename}`
                    : ""}
                </small>
              </span>
            </label>
          ))}
          {visible.length === 0 && <p className="note-source-none">{t("shell.sources.none")}</p>}
        </div>
        {/* 모바일: 패널 하단 닫기 어포던스 (마이크로 라벨 재사용) — 데스크톱은 CSS로 숨김 */}
        <button
          type="button"
          className="note-source-close"
          onClick={() => detailsRef.current && closeDetails(detailsRef.current, () => summaryRef.current?.focus())}
        >
          {t("common.close")}
        </button>
      </div>
    </details>
  );
}
