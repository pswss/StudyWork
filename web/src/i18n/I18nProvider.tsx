import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { detectLocale, LOCALE_STORAGE_KEY, type Locale } from "./locales";
import { messages, type MessageKey } from "./messages";

export type MessageValues = Record<string, string | number>;
export type Translate = (key: MessageKey, values?: MessageValues) => string;

export function translate(locale: Locale, key: MessageKey, values?: MessageValues): string {
  const template = messages[locale][key];
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (token, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : token
  );
}

export function formatDate(
  locale: Locale,
  value: Date | number | string,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
): string {
  const date = value instanceof Date
    ? value
    : typeof value === "number" ? new Date(value) : new Date(value);
  return new Intl.DateTimeFormat(locale, options).format(date);
}

export function formatNumber(
  locale: Locale,
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translate;
  formatDate: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
}

const fallbackValue: I18nValue = {
  locale: "ko",
  setLocale: () => {},
  t: (key, values) => translate("ko", key, values),
  formatDate: (value, options) => formatDate("ko", value, options),
  formatNumber: (value, options) => formatNumber("ko", value, options),
};

const I18nContext = createContext<I18nValue>(fallbackValue);

export function I18nProvider({
  children,
  initialLocale,
}: {
  children?: ReactNode;
  initialLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(() => initialLocale ?? detectLocale());

  const setLocale = useCallback((next: Locale) => {
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {}
    setLocaleState(next);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18nValue>(() => ({
    locale,
    setLocale,
    t: (key, values) => translate(locale, key, values),
    formatDate: (date, options) => formatDate(locale, date, options),
    formatNumber: (number, options) => formatNumber(locale, number, options),
  }), [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
