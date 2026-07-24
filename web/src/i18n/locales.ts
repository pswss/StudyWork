export const LOCALES = ["ko", "en", "zh-CN", "es"] as const;

export type Locale = (typeof LOCALES)[number];

export const LOCALE_STORAGE_KEY = "studywork:locale";

export function matchLocale(value: string | null | undefined): Locale | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
  if (normalized === "ko" || normalized.startsWith("ko-")) return "ko";
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  if (normalized === "es" || normalized.startsWith("es-")) return "es";
  return null;
}

export function resolveLocale(
  stored: string | null | undefined,
  preferred: readonly string[] = [],
): Locale {
  const saved = matchLocale(stored);
  if (saved) return saved;
  for (const candidate of preferred) {
    const matched = matchLocale(candidate);
    if (matched) return matched;
  }
  return "ko";
}

export function detectLocale(): Locale {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {}
  const preferred = typeof navigator === "undefined"
    ? []
    : navigator.languages?.length ? navigator.languages : [navigator.language];
  return resolveLocale(stored, preferred);
}
