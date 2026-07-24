import { defineMessages } from "./define";

const ko = {
  "common.language": "언어",
  "common.choose": "선택하세요",
  "common.retry": "다시 시도",
  "common.close": "닫기",
} as const;

export const commonMessages = defineMessages(ko, {
  en: {
    "common.language": "Language",
    "common.choose": "Choose",
    "common.retry": "Try again",
    "common.close": "Close",
  },
  "zh-CN": {
    "common.language": "语言",
    "common.choose": "请选择",
    "common.retry": "重试",
    "common.close": "关闭",
  },
  es: {
    "common.language": "Idioma",
    "common.choose": "Seleccionar",
    "common.retry": "Reintentar",
    "common.close": "Cerrar",
  },
});
