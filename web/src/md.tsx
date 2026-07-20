// 마크다운 공용 렌더 — AI 출력(**굵게**, 목록 등)을 모든 화면에서 일관되게 표시.
// AI·업로드 자료에서 온 HTML은 신뢰하지 않는다. marked/KaTeX 변환 뒤 DOMPurify를 반드시 거친다.
// 폰트 크기·색은 부모에서 상속, .md-content는 구조(문단·목록·강조)만 담당.

import DOMPurify, { type Config } from "dompurify";
import { marked } from "marked";
import markedKatex from "marked-katex-extension";
import "katex/dist/katex.min.css";
import { normalizeMarkdownTableMath } from "../../src/markdown";

marked.use({ async: false });
// LaTeX 수식 렌더 — AI가 $...$ / $$...$$ 로 출력하는 수식을 KaTeX로 표시
// HTML 출력은 분수·극한·첨자 배치에 inline style을 쓰지만 보안 경계에서 style을 제거한다.
// 브라우저 기본 수식 배치를 쓰는 MathML만 출력해 보안과 수식 레이아웃을 함께 보존한다.
marked.use(markedKatex({ throwOnError: false, nonStandard: true, output: "mathml" }));

// CommonMark는 닫는 ** 바로 뒤에 한글이 붙으면(예: **와일스**가) 굵게로 인식하지 못한다(CJK 경계 문제).
// 코드 블록·인라인 코드를 제외한 구간에서 **...**를 미리 <strong>으로 치환해 우회.
function fixCjkBold(src: string): string {
  // $수식$ 구간도 보호 — <strong>이 수식 안에 주입되면 KaTeX가 깨진다(빨간 글자)
  return src
    .split(/(```[\s\S]*?```|`[^`\n]*`|\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g)
    .map((seg, i) =>
      i % 2 === 1 ? seg : seg.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
    )
    .join("");
}

// AI가 $ 델리미터 없이 내보낸 수식을 KaTeX가 먹는 $ 형태로 정규화.
// \(...\)·\[...\] 변환 + 맨몸 수식 휴리스틱 감싸기 — \명령 포함(a_n=\sqrt{..}) 또는
// ^/_ 지수·첨자 포함(f(x)=x^3-ax^2-100x+10) ASCII 토큰 연쇄가 대상.
// 화살표·그리스 문자·비교/무한 기호 등 수학 유니코드를 포함해야 lim_{x→1} 같은 식이 중간에 끊기지 않는다
// (끊기면 "lim_{x" 조각만 감싸져 KaTeX 파싱 에러 — 빨간 글자 사고)
const MATH_CH = /[A-Za-z0-9_^{}()[\]+\-=<>/*.,;:!?'|\\ Ͱ-Ͽ←-⇿∀-⋿±×÷·′″√∞]/;

// 구(舊) 추출 데이터의 평문 수식을 LaTeX로 승격 — lim/sin 등 함수명에 \ 부여, (A)/(B) → \frac{A}{B}
const PAREN = /\((?:[^()]|\([^()]*\))*\)/; // 괄호 1단 중첩까지
const FRAC = new RegExp(`(${PAREN.source})\\s*/\\s*(${PAREN.source})`, "g");
function texifyPlain(t: string): string {
  return t
    .replace(FRAC, (_, a: string, b: string) => `\\frac{${a.slice(1, -1)}}{${b.slice(1, -1)}}`)
    .replace(/(?<![A-Za-z\\])(lim|sin|cos|tan|log|ln|max|min)(?![A-Za-z])/g, "\\$1");
}

// KaTeX는 수식 모드의 한글을 렌더하지 못하고 통째로 빨간 에러를 낸다 —
// $...$ 안의 한글 구간을 \text{...}로 감싼다. (이미 \text{} 안이어도 중첩은 무해)
function hangulToText(t: string): string {
  return t.replace(/[가-힣](?:[가-힣0-9·,\s]*[가-힣0-9])?/g, (m) => `\\text{${m}}`);
}

// 맨몸 수식 런을 찾아 $로 감싼다 — 정규식 대신 괄호 깊이를 아는 스캐너.
// \sqrt{(n에 대한 이차식)}처럼 괄호 안에 한글이 섞여도 여는 괄호가 닫힐 때까지 한 식으로 본다
// (정규식 문자 클래스는 한글에서 런을 끊어 미완성 조각이 감싸지며 KaTeX 에러가 났음)
function wrapBareMath(seg: string): string {
  let out = "";
  let i = 0;
  while (i < seg.length) {
    if (!MATH_CH.test(seg[i])) { out += seg[i]; i++; continue; }
    let j = i;
    let depth = 0;
    while (j < seg.length) {
      const c = seg[j];
      if (MATH_CH.test(c)) {
        if (c === "{" || c === "(" || c === "[") depth++;
        else if (c === "}" || c === ")" || c === "]") depth = Math.max(0, depth - 1);
        j++;
      } else if (depth > 0) {
        j++; // 괄호가 닫히기 전이면 한글 등 비수식 문자도 식의 일부
      } else break;
    }
    const run = seg.slice(i, j);
    // 가장자리의 문장 부호·볼드 마커(**)·목록 대시는 수식이 아니라 마크다운/문장의 일부 — 수식 밖에 남긴다
    const t = run.trim().replace(/^[-,.;:!?*\s]+/, "").replace(/[,.;:!?*\s]+$/, "");
    // \명령이 있는 런만 수식으로 간주 — ^/_ 평문 트리거는 마크다운(볼드·목록)과 충돌해 제거.
    // (새 데이터는 프롬프트가 $...$로 감싸 내보내므로 이 경로는 옛 콘텐츠 구제용)
    const isMath = t.length > 0 && t.includes("\\");
    out += isMath ? run.replace(t, `$${hangulToText(texifyPlain(t))}$`) : run;
    i = j;
  }
  return out;
}
export function normalizeMath(src: string): string {
  // 1패스: \(...\)·\[...\] → $ 델리미터 (코드 보호)
  const converted = src
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((seg, i) =>
      i % 2 === 1
        ? seg
        : seg
            .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `$$${m}$$`)
            .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => `$${m}$`)
    )
    .join("");
  // 2패스: 코드·$수식$ 밖에 남은 맨몸 수식을 $로 감싼다 (1패스 결과 재감쌈 방지를 위해 분리 실행)
  // ponytail: \명령 또는 ^/_ 포함 ASCII 토큰 연쇄를 수식으로 간주 — 한글 문자에서 끊기므로 국문 본문에선 안전.
  // 영문 산문 사이 수식은 이웃 단어까지 묶일 수 있고 snake_case도 수식으로 오인함 — 문제되면 트리거 정제 필요
  return converted
    .split(/(```[\s\S]*?```|`[^`\n]*`|\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g)
    .map((seg, i) => {
      if (i % 2 === 1) {
        // AI가 직접 쓴 $...$ 수식 안의 한글도 \text{}로 — KaTeX 한글 에러(빨간 글자) 방지
        return seg.startsWith("$") ? hangulToText(seg) : seg;
      }
      return wrapBareMath(seg);
    })
    .join("");
}

// **$수식$** — 수식을 통째로 감싼 볼드는 fixCjkBold의 수식 보호 때문에 짝이 안 맞으니 여기서 먼저 변환
const boldMath = (src: string) => src.replace(/\*\*(\s*\$[^$\n]+\$\s*)\*\*/g, "<strong>$1</strong>");

const pre = (src: string) =>
  fixCjkBold(boldMath(normalizeMath(normalizeMarkdownTableMath(src))));

// HTML은 Markdown 표·목록과 KaTeX의 접근성용 MathML까지 허용하되 SVG는 허용하지 않는다.
// DOMPurify 기본 URI 정책이 javascript: 등 실행 가능한 URL과 모든 on* 이벤트 속성을 제거한다.
const SANITIZE_CONFIG: Config = {
  USE_PROFILES: { html: true, mathMl: true },
  // DOMPurify의 MathML 프로필에 없는 KaTeX 원문 주석 컨테이너를 보존한다.
  // 없으면 annotation 태그만 벗겨지고 LaTeX 원문이 수식 안에 노출된다.
  ADD_TAGS: ["semantics", "annotation"],
  ADD_ATTR: ["encoding"],
  FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "template", "img", "video", "audio", "source", "link"],
  FORBID_ATTR: ["style", "src", "srcset"],
  SANITIZE_NAMED_PROPS: true,
};

/** marked/KaTeX가 만든 HTML을 DOM에 넣기 직전 정화하는 단일 보안 경계. */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}

/** HTML 문서의 title 같은 텍스트 컨텍스트에 안전하게 삽입한다. */
export function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const renderBlockHtml = (text: string) => sanitizeHtml(marked.parse(pre(text)) as string);
const renderInlineHtml = (text: string) => sanitizeHtml(marked.parseInline(pre(text)) as string);

/** 블록 렌더 — 말풍선·해설·문제 본문 등 여러 줄 텍스트 */
export function Md({ text, className }: { text: string; className?: string }) {
  return (
    <div
      className={className ? `md-content ${className}` : "md-content"}
      dangerouslySetInnerHTML={{ __html: renderBlockHtml(text) }}
    />
  );
}

/** 인라인 렌더 — 목록 행 제목·선택지·체크리스트 항목 등 한 줄 라벨 */
export function MdInline({ text }: { text: string }) {
  return <span dangerouslySetInnerHTML={{ __html: renderInlineHtml(text) }} />;
}

/** HTML 문자열이 필요한 곳(인쇄 시트)용 인라인 변환 */
export function mdInlineHtml(text: string): string {
  return renderInlineHtml(text);
}

/** 블록 HTML 문자열 — 기존 클래스(.note-content 등)를 그대로 쓰는 곳용 */
export function mdHtml(text: string): string {
  return renderBlockHtml(text);
}

/** 긴 노트를 실제 Markdown 제목 경계에서 나눈다. CommonMark 코드 블록 내부는 건드리지 않는다. */
export function splitMarkdownChunks(text: string, targetChars = 4_000): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  let currentChars = 0;
  let fence: { char: "`" | "~"; length: number } | null = null;

  for (const line of text.split("\n")) {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[\t ]*$/.exec(line)?.[1];
      if (close?.[0] === fence.char && close.length >= fence.length) fence = null;
      current.push(line);
      currentChars += line.length + 1;
      continue;
    }

    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { char: open[1][0] as "`" | "~", length: open[1].length };
      current.push(line);
      currentChars += line.length + 1;
      continue;
    }

    if (
      /^ {0,3}#{1,3}\s+\S/.test(line)
      && currentChars >= Math.max(1, targetChars)
      && current.some(part => part.trim())
    ) {
      sections.push(current.join("\n"));
      current = [];
      currentChars = 0;
    }
    current.push(line);
    currentChars += line.length + 1;
  }
  if (current.some(part => part.trim())) sections.push(current.join("\n"));
  return sections.length > 0 ? sections : [text];
}

/** 테스트·비동기 렌더 외 호출용 편의 함수. */
export function mdHtmlChunks(text: string, targetChars = 4_000): string[] {
  return splitMarkdownChunks(text, targetChars).map(renderBlockHtml);
}
