import type { Locale } from "../locales";

type MessageShape<Ko extends Record<string, string>> = {
  [Key in keyof Ko]: string;
};

export function defineMessages<const Ko extends Record<string, string>>(
  ko: Ko,
  translations: Record<Exclude<Locale, "ko">, MessageShape<Ko>>,
) {
  return { ko, ...translations };
}
