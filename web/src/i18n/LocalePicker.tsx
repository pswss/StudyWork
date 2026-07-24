import SingleSelectPicker from "../pages/SingleSelectPicker";
import { useI18n } from "./I18nProvider";
import type { Locale } from "./locales";

const OPTIONS = [
  { value: "ko", label: "한국어" },
  { value: "en", label: "English" },
  { value: "zh-CN", label: "简体中文" },
  { value: "es", label: "Español" },
] satisfies { value: Locale; label: string }[];

export default function LocalePicker({
  compact = false,
  className = "",
}: {
  compact?: boolean;
  className?: string;
}) {
  const { locale, setLocale, t } = useI18n();
  return (
    <SingleSelectPicker
      className={className}
      label={t("common.language")}
      value={locale}
      options={OPTIONS}
      onChange={(value) => setLocale(value as Locale)}
      compact={compact}
      align={compact ? "end" : "start"}
    />
  );
}
