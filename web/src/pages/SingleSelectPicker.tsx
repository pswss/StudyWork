import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { closeDetails } from "../details-close";
import { useI18n } from "../i18n/I18nProvider";

export interface SingleSelectOption {
  value: string;
  label: string;
  description?: string;
}

export default function SingleSelectPicker({
  label,
  value,
  options,
  onChange,
  disabled = false,
  className = "",
  compact = false,
  align = "start",
}: {
  label: string;
  value: string;
  options: SingleSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  compact?: boolean;
  align?: "start" | "end";
}) {
  const { t } = useI18n();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const typeaheadRef = useRef({ value: "", at: 0 });
  const matchedIndex = options.findIndex((option) => option.value === value);
  const selectedIndex = Math.max(0, matchedIndex);
  const selected = matchedIndex >= 0 ? options[matchedIndex] : undefined;

  function close(focusSummary = false) {
    const details = detailsRef.current;
    if (!details?.open) return;
    closeDetails(details, focusSummary ? () => summaryRef.current?.focus() : undefined);
  }

  function focusOption(index: number) {
    optionRefs.current[index]?.focus({ preventScroll: true });
    optionRefs.current[index]?.scrollIntoView({ block: "nearest" });
  }

  function typeaheadIndex(key: string, current: number) {
    const char = key.normalize("NFKC").toLocaleLowerCase();
    const now = Date.now();
    const previous = now - typeaheadRef.current.at < 700 ? typeaheadRef.current.value : "";
    const repeated = previous === char;
    let needle = repeated ? char : `${previous}${char}`;
    const find = (start: number) => {
      for (let step = 0; step < options.length; step++) {
        const index = (start + step + options.length) % options.length;
        if (options[index]?.label.normalize("NFKC").toLocaleLowerCase().startsWith(needle)) return index;
      }
      return -1;
    };
    let match = find(previous && !repeated ? current : current + 1);
    if (match < 0 && needle.length > 1) {
      needle = char;
      match = find(current + 1);
    }
    typeaheadRef.current = { value: needle, at: now };
    return match;
  }

  function isTypeaheadKey(event: KeyboardEvent<HTMLElement>) {
    return event.key.length === 1
      && event.key.trim().length > 0
      && !event.ctrlKey
      && !event.metaKey
      && !event.altKey
      && !event.nativeEvent.isComposing;
  }

  function handleSummaryKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (disabled) return;
    const arrow = event.key === "ArrowDown" || event.key === "ArrowUp";
    if (!arrow && !isTypeaheadKey(event)) return;
    event.preventDefault();
    const details = detailsRef.current;
    if (!details) return;
    details.open = true;
    const next = arrow
      ? (event.key === "ArrowUp" ? options.length - 1 : selectedIndex)
      : typeaheadIndex(event.key, selectedIndex);
    if (next >= 0) queueMicrotask(() => focusOption(next));
  }

  function handleListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = optionRefs.current.filter((button): button is HTMLButtonElement => button !== null);
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    let next = current;
    if (event.key === "ArrowDown") next = (current + 1) % buttons.length;
    else if (event.key === "ArrowUp") next = (current - 1 + buttons.length) % buttons.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else if (isTypeaheadKey(event)) next = typeaheadIndex(event.key, current);
    else return;
    if (next < 0) return;
    event.preventDefault();
    buttons[next]?.focus({ preventScroll: true });
    buttons[next]?.scrollIntoView({ block: "nearest" });
  }

  function handleToggle() {
    const details = detailsRef.current;
    if (!details) return;
    if (!details.open) {
      typeaheadRef.current = { value: "", at: 0 };
      return;
    }
    requestAnimationFrame(() => optionRefs.current[selectedIndex]?.scrollIntoView({ block: "nearest" }));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDetailsElement>) {
    if (event.key !== "Escape" || !event.currentTarget.open) return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  }

  function blockDisabledToggle(event: PointerEvent<HTMLElement>) {
    if (disabled) event.preventDefault();
  }

  useEffect(() => {
    if (disabled && detailsRef.current) detailsRef.current.open = false;
  }, [disabled]);

  useEffect(() => {
    const closeOutside = (event: globalThis.PointerEvent) => {
      const details = detailsRef.current;
      if (!details?.open || !event.target || details.contains(event.target as Node)) return;
      close();
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);

  return (
    <details
      ref={detailsRef}
      className={`single-select-picker${className ? ` ${className}` : ""}${disabled ? " disabled" : ""}`}
      style={compact ? { minWidth: 108, width: 108 } : undefined}
      onToggle={handleToggle}
      onKeyDown={handleKeyDown}
    >
      <summary
        ref={summaryRef}
        aria-label={compact ? `${label}: ${selected?.label ?? t("common.choose")}` : undefined}
        aria-disabled={disabled || undefined}
        aria-haspopup="listbox"
        tabIndex={disabled ? -1 : 0}
        onPointerDown={blockDisabledToggle}
        onClick={disabled ? (event) => event.preventDefault() : undefined}
        onKeyDown={handleSummaryKeyDown}
      >
        {!compact && <span>{label}</span>}
        <strong>{selected?.label ?? t("common.choose")}</strong>
      </summary>
      <div
        className="single-select-panel"
        style={align === "end" ? { left: "auto", right: 0 } : undefined}
      >
        <div className="single-select-list" role="listbox" aria-label={label} onKeyDown={handleListKeyDown}>
          {options.map((option, index) => {
            const checked = option.value === value;
            return (
              <button
                ref={(node) => { optionRefs.current[index] = node; }}
                key={option.value}
                type="button"
                className="single-select-option"
                role="option"
                aria-selected={checked}
                disabled={disabled}
                tabIndex={index === selectedIndex ? 0 : -1}
                onClick={() => {
                  onChange(option.value);
                  close(true);
                }}
              >
                <span>
                  <strong>{option.label}</strong>
                  {option.description && <small>{option.description}</small>}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </details>
  );
}
