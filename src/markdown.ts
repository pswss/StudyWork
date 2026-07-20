// Markdown tables use `|` as a cell delimiter even when it appears inside $...$.
// Convert them to equivalent named LaTeX delimiters only on actual GFM rows.
function normalizeLiteralMathPipes(source: string): string {
  // KaTeX's array preamble accepts | structurally but not \vert. `:` keeps a
  // visible column divider without leaving a Markdown cell delimiter behind.
  const math = source.replace(
    /(\\begin\{array\}\{)([^{}]*)(\})/g,
    (_, open: string, columns: string, close: string) => open + columns.replace(/\\?\|/g, ":") + close
  );
  let out = "";
  let backslashes = 0;

  for (const char of math) {
    if (char === "|") {
      if (backslashes % 2 === 1) {
        // TeX \| is the double norm delimiter; preserve that meaning explicitly.
        out = out.slice(0, -1) + "\\Vert{}";
      } else {
        out += "\\vert{}";
      }
    } else {
      out += char;
    }

    backslashes = char === "\\" ? backslashes + 1 : 0;
  }
  return out;
}

function normalizeTableRowMath(line: string): string {
  let out = "";
  let cursor = 0;

  while (cursor < line.length) {
    if (line[cursor] === "`") {
      let ticks = 1;
      while (line[cursor + ticks] === "`") ticks++;
      const delimiter = "`".repeat(ticks);
      const end = line.indexOf(delimiter, cursor + ticks);
      if (end === -1) return out + line.slice(cursor);
      out += line.slice(cursor, end + ticks);
      cursor = end + ticks;
      continue;
    }

    if (line[cursor] !== "$" || isEscaped(line, cursor)) {
      out += line[cursor++];
      continue;
    }

    const delimiter = line[cursor + 1] === "$" ? "$$" : "$";
    const bodyStart = cursor + delimiter.length;
    const end = findUnescaped(line, delimiter, bodyStart);
    if (end === -1) return out + line.slice(cursor);

    out += delimiter + normalizeLiteralMathPipes(line.slice(bodyStart, end)) + delimiter;
    cursor = end + delimiter.length;
  }
  return out;
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 1;
}

function findUnescaped(text: string, needle: string, from: number): number {
  for (let index = text.indexOf(needle, from); index !== -1; index = text.indexOf(needle, index + 1)) {
    if (!isEscaped(text, index)) return index;
  }
  return -1;
}

const TABLE_DIVIDER = /^ {0,3}\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/;

function blockquoteParts(line: string): { depth: number; content: string } {
  let content = line;
  let depth = 0;
  while (true) {
    const match = /^ {0,3}>[\t ]?/.exec(content);
    if (!match) return { depth, content };
    content = content.slice(match[0].length);
    depth++;
  }
}

function fenceSyntax(line: string): { depth: number; content: string } {
  const parts = blockquoteParts(line);
  return {
    depth: parts.depth,
    content: parts.content.replace(/^ {0,3}(?:[-+*]|\d+[.)])[\t ]+/, ""),
  };
}

function fencedLineMask(lines: string[]): boolean[] {
  let fence: { char: "`" | "~"; length: number; depth: number } | null = null;
  return lines.map((line) => {
    const syntax = fenceSyntax(line);
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[\t ]*$/.exec(syntax.content)?.[1];
      if (syntax.depth === fence.depth && close?.[0] === fence.char && close.length >= fence.length) fence = null;
      return true;
    }

    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(syntax.content);
    if (!open || (open[1][0] === "`" && open[2].includes("`"))) return false;
    fence = { char: open[1][0] as "`" | "~", length: open[1].length, depth: syntax.depth };
    return true;
  });
}

/** Keep Markdown table cells intact when inline LaTeX contains absolute-value bars. */
export function normalizeMarkdownTableMath(markdown: string): string {
  const lines = markdown.split("\n");
  const fenced = fencedLineMask(lines);
  const syntax = lines.map(blockquoteParts);
  const tableRows = new Set<number>();

  for (let index = 1; index < lines.length; index++) {
    if (
      fenced[index] || fenced[index - 1]
      || syntax[index].depth !== syntax[index - 1].depth
      || !TABLE_DIVIDER.test(syntax[index].content)
      || !syntax[index - 1].content.includes("|")
    ) {
      continue;
    }
    tableRows.add(index - 1);
    tableRows.add(index);
    for (let body = index + 1; body < lines.length; body++) {
      if (
        fenced[body]
        || syntax[body].depth !== syntax[index].depth
        || !syntax[body].content.trim()
        || !syntax[body].content.includes("|")
      ) break;
      tableRows.add(body);
    }
  }

  return lines
    .map((line, index) => tableRows.has(index) && line.includes("$")
      ? normalizeTableRowMath(line)
      : line)
    .join("\n");
}
