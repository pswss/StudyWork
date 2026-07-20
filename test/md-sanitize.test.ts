// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Md, MdInline, escapeHtmlText, mdHtml, mdHtmlChunks, mdInlineHtml, sanitizeHtml } from "../web/src/md";
import { normalizeMarkdownTableMath } from "../src/markdown";

const ATTACK = `
# 안전한 제목
<script>window.__studyworkPwned = true</script>
<img src="x" onerror="alert(1)">
<a href="javascript:alert(1)">위험 링크</a>
<svg><script>alert(1)</script><a xlink:href="javascript:alert(2)">svg</a></svg>
<div style="position:fixed;inset:0;z-index:99999">화면 덮기</div>
<img src="https://tracker.example/pixel.png" alt="추적">
`;

function expectSafe(html: string) {
  expect(html).toContain("안전한 제목");
  expectNoUnsafe(html);
}

function expectNoUnsafe(html: string) {
  expect(html).not.toMatch(/<script|onerror\s*=|javascript:|<svg|xlink:href|style\s*=|<img/i);
}

describe("Markdown HTML sanitizing", () => {
  it("raw script, event handler, javascript URL, SVG를 제거한다", () => {
    expectSafe(sanitizeHtml(ATTACK));
    expectSafe(mdHtml(ATTACK));
    expectSafe(mdInlineHtml(ATTACK));
  });

  it("Md와 MdInline도 같은 정화 경계를 사용한다", () => {
    const block = Md({ text: ATTACK }).props.dangerouslySetInnerHTML.__html as string;
    const inline = MdInline({ text: ATTACK }).props.dangerouslySetInnerHTML.__html as string;
    expectSafe(block);
    expectSafe(inline);
  });

  it("정상 Markdown, 안전한 링크, KaTeX HTML·MathML을 보존한다", () => {
    const html = mdHtml("# 제목\n\n**굵게**와 <mark>암기</mark>, [문서](https://example.com) 및 $x^2 + y^2$");
    expect(html).toContain("<h1>제목</h1>");
    expect(html).toContain("<strong>굵게</strong>");
    expect(html).toContain("<mark>암기</mark>");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('class="katex"');
    expect(html).toContain("<math");
  });

  it("실제 문제형 분수·극한·첨자를 배치 정보 없는 KaTeX HTML 대신 MathML로 렌더한다", () => {
    const html = mdHtml(
      String.raw`수열 $\{a_n\}$에 대하여 $\displaystyle\lim_{n\to\infty}\frac{a_n}{n^2}=3$이다.`
    );

    expect(html).toContain('class="katex"');
    expect(html).toContain("<semantics>");
    expect(html).toContain("<annotation");
    expect(html).toContain('encoding="application/x-tex"');
    expect(html).toContain("<mfrac>");
    expect(html).toContain("<msub>");
    expect(html).toContain("<msup>");
    expect(html).not.toContain('class="katex-html"');
    expect(html).not.toMatch(/\sstyle=/i);
  });

  it("표 안 절댓값 기호를 열 구분자로 오인하지 않고 한 셀의 수식으로 렌더한다", () => {
    const html = mdHtml(String.raw`| 구분 | 계산 | 의미 |
|---|---|---|
| 변화량 | $\int_a^b v(t)\,dt$ | 부호 있는 넓이 |
| 움직인 거리 | $\displaystyle\int_a^b|v(t)|\,dt$ | 전체 넓이 |`);

    expect(html.match(/<td>/g)).toHaveLength(6);
    expect(html).not.toContain(String.raw`$\displaystyle\int_a^b`);
    expect(html).toContain("<math");
    expect(html).toContain("전체 넓이");
  });

  it("바깥 파이프가 없는 GFM 표에서도 수식과 열을 보존한다", () => {
    const html = mdHtml(String.raw`구분 | 계산
---|---
거리 | $\int_a^b|v(t)|\,dt$`);

    expect(html.match(/<td>/g)).toHaveLength(2);
    expect(html).toContain("<math");
  });

  it("인용문 안 표를 복구하고 기존 노름 기호의 수학 의미를 보존한다", () => {
    const html = mdHtml(String.raw`> | 구분 | 계산 |
> |---|---|
> | 노름 | $\|v\|$ |
> | 거리 | $|v|$ |`);

    expect(html.match(/<td>/g)).toHaveLength(4);
    expect(html).toContain(String.raw`\Vert{}v\Vert{}`);
    expect(html).toContain(String.raw`\vert{}v\vert{}`);
  });

  it("목록 안 코드 펜스의 표 예시는 바꾸지 않고 정규화는 멱등이다", () => {
    const source = String.raw`- \`\`\`md
  | 구분 | 계산 |
  |---|---|
  | 거리 | $|v|$ |
  \`\`\``.replace(/\\`/g, "`");

    expect(normalizeMarkdownTableMath(source)).toBe(source);
    const table = String.raw`| 구분 | 계산 |
|---|---|
| 거리 | $|v|$ |`;
    const once = normalizeMarkdownTableMath(table);
    expect(normalizeMarkdownTableMath(once)).toBe(once);
  });

  it("표 안 array 열 구분선도 깨진 LaTeX 없이 렌더한다", () => {
    const html = mdHtml(String.raw`| 구분 | 계산 |
|---|---|
| 배열 | $\begin{array}{c|c}a&b\\c&d\end{array}$ |`);

    expect(html.match(/<td>/g)).toHaveLength(2);
    expect(html).toContain("<mtable");
    expect(html).not.toContain("katex-error");
  });

  it("display 수식마다 공식 박스용 MathML hook을 만든다", () => {
    const html = mdHtml("$$x=1$$\n\n$$y=2$$");
    expect(html.match(/display="block"/g)).toHaveLength(2);
    const root = document.createElement("div");
    root.innerHTML = html;
    expect(root.querySelectorAll('.katex:has(> math[display="block"])')).toHaveLength(2);
  });

  it("앱과 HTML 저장이 실제 KaTeX 루트에 같은 공식 박스·간격 selector를 가진다", () => {
    const appCss = readFileSync("web/src/styles.css", "utf8");
    const detailSource = readFileSync("web/src/pages/SubjectDetail.tsx", "utf8");

    for (const source of [appCss, detailSource]) {
      expect(source).toMatch(/\.katex:has\(\s*>\s*math\[display="block"\]\s*\)/);
      expect(source).not.toContain('p:has(math[display="block"])');
      expect(source).toMatch(/margin:\s*24px 0/);
      expect(source).toMatch(/padding:\s*16px 24px/);
      expect(source).toMatch(/margin-top:\s*32px/);
      expect(source).toMatch(/h3\s*\{[^}]*border-top:/s);
    }
  });

  it("긴 노트를 코드 블록이 아닌 실제 제목에서만 렌더 조각으로 나눈다", () => {
    const chunks = mdHtmlChunks(
      "# 첫째\n본문\n\n````md\n```text\n## 긴 코드 펜스 안 제목\n```\n````\n\n    # 들여쓴 코드\n\n## 둘째\n내용",
      1
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain("긴 코드 펜스 안 제목");
    expect(chunks[0]).toContain("들여쓴 코드");
    expect(chunks[1]).toContain("둘째");
    chunks.forEach(expectNoUnsafe);
  });

  it("다운로드 문서 title용 텍스트를 HTML escape한다", () => {
    expect(escapeHtmlText(`수학 </title><script>alert("x")</script> & '시험'`)).toBe(
      "수학 &lt;/title&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;시험&#39;"
    );
  });
});
