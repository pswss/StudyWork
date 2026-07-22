import type { AIJsonSchema } from "./codex-provider";

function arrayEnvelope(
  name: string,
  description: string,
  item: Record<string, unknown>
): AIJsonSchema {
  return {
    name,
    description,
    outputKey: "items",
    schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: item,
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
  };
}

const quizItem = {
  type: "object",
  properties: {
    qtype: { type: "string", enum: ["mcq", "short", "ox"] },
    difficulty: { type: "string", enum: ["하", "중", "상"] },
    question: { type: "string" },
    choices: { type: ["array", "null"], items: { type: "string" } },
    answer: { type: "string" },
    explanation: { type: "string" },
  },
  required: ["qtype", "difficulty", "question", "choices", "answer", "explanation"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

export const QUIZ_ITEMS_SCHEMA = arrayEnvelope(
  "studywork_quiz_items",
  "Quiz questions grounded in the supplied learning material.",
  quizItem
);

export const QUIZ_FILE_ITEMS_SCHEMA = arrayEnvelope(
  "studywork_file_quiz_items",
  "Quiz questions extracted from an attached PDF or image, with page and figure evidence.",
  {
    type: "object",
    properties: {
      ...(quizItem.properties as Record<string, unknown>),
      choiceCount: { type: ["integer", "null"], minimum: 2, maximum: 10 },
      page: { type: ["integer", "null"] },
      figure: { type: "boolean" },
      figure_description: { type: ["string", "null"] },
      box: {
        type: ["array", "null"],
        items: { type: "number" },
        minItems: 2,
        maxItems: 2,
      },
    },
    required: [...(quizItem.required as string[]), "choiceCount", "page", "figure", "figure_description", "box"],
    additionalProperties: false,
  }
);

export const SOLUTION_FILE_ITEMS_SCHEMA = arrayEnvelope(
  "studywork_solution_file_items",
  "Worked solutions extracted from an attached answer-and-explanation file in document order.",
  {
    type: "object",
    properties: {
      number: { type: "string" },
      answer: { type: "string" },
      explanation: { type: "string" },
      page: { type: "integer", minimum: 1 },
      complete: { type: "boolean" },
    },
    required: ["number", "answer", "explanation", "page", "complete"],
    additionalProperties: false,
  }
);

export const ANSWER_KEY_PAGES_SCHEMA = arrayEnvelope(
  "studywork_answer_key_pages",
  "Original PDF pages that visibly contain official answer tables or official solutions.",
  {
    type: "object",
    properties: { page: { type: "integer", minimum: 1 } },
    required: ["page"],
    additionalProperties: false,
  }
);

export const SECTION_MAP_SCHEMA = arrayEnvelope(
  "studywork_section_map",
  "Contiguous source-page ranges classified by learning-material part.",
  {
    type: "object",
    properties: {
      part: { type: "string", enum: ["개념", "문제", "해설", "기타"] },
      from: { type: "integer" },
      to: { type: "integer" },
    },
    required: ["part", "from", "to"],
    additionalProperties: false,
  }
);

export const STUDY_PLAN_SCHEMA = arrayEnvelope(
  "studywork_study_plan",
  "Dated study-plan tasks within the requested exam window.",
  {
    type: "object",
    properties: {
      day: { type: "string" },
      task: { type: "string" },
    },
    required: ["day", "task"],
    additionalProperties: false,
  }
);

export const PAGE_EXTRACTIONS_SCHEMA: AIJsonSchema = {
  name: "studywork_page_extractions",
  description: "A complete, ordered transcription for every requested source page.",
  outputKey: "pages",
  schema: {
    type: "object",
    properties: {
      pages: {
        type: "array",
        items: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1 },
            markdown: { type: "string" },
          },
          required: ["page", "markdown"],
          additionalProperties: false,
        },
      },
    },
    required: ["pages"],
    additionalProperties: false,
  },
};
