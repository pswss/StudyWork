import type { Locale } from "../locales";
import { apiMessages } from "./api";
import { commonMessages } from "./common";
import { learningMessages } from "./learning";
import { problemsMessages } from "./problems";
import { shellMessages } from "./shell";
import { workspaceMessages } from "./workspace";

export const messages = {
  ko: {
    ...commonMessages.ko,
    ...shellMessages.ko,
    ...workspaceMessages.ko,
    ...problemsMessages.ko,
    ...learningMessages.ko,
    ...apiMessages.ko,
  },
  en: {
    ...commonMessages.en,
    ...shellMessages.en,
    ...workspaceMessages.en,
    ...problemsMessages.en,
    ...learningMessages.en,
    ...apiMessages.en,
  },
  "zh-CN": {
    ...commonMessages["zh-CN"],
    ...shellMessages["zh-CN"],
    ...workspaceMessages["zh-CN"],
    ...problemsMessages["zh-CN"],
    ...learningMessages["zh-CN"],
    ...apiMessages["zh-CN"],
  },
  es: {
    ...commonMessages.es,
    ...shellMessages.es,
    ...workspaceMessages.es,
    ...problemsMessages.es,
    ...learningMessages.es,
    ...apiMessages.es,
  },
} as const satisfies Record<Locale, Record<string, string>>;

export type MessageKey = keyof typeof messages.ko;
