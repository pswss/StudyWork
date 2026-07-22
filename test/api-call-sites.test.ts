// 프론트-API 배선 회귀 — api.ts에서 export된 래퍼가 web/src 어디에서도 import되지
// 않으면 실패한다. "서버는 완성됐는데 프론트가 API를 안 부름" 류 드리프트(과거
// 오답 사이클 단절 사고)를 정적 스캔으로 잡는다.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_SRC = resolve(import.meta.dirname, "..", "web", "src");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

describe("api.ts 래퍼 호출부 정적 스캔", () => {
  it("export된 모든 api 함수가 web/src 어딘가에서 import된다", () => {
    const apiSource = readFileSync(join(WEB_SRC, "api.ts"), "utf8");
    const exported = [...apiSource.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);
    expect(exported.length).toBeGreaterThan(20); // 스캔 자체가 비면 테스트가 무의미해지는 것 방지

    const files = walk(WEB_SRC).filter(
      (file) => /\.(ts|tsx)$/.test(file) && !file.endsWith(`${join("web", "src", "api.ts")}`)
    );
    const imported = new Set<string>();
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']\.{1,2}\/api["']/g)) {
        for (const spec of match[1].split(",")) {
          const name = spec.trim().split(/\s+as\s+/)[0].trim();
          if (name) imported.add(name);
        }
      }
    }

    const orphans = exported.filter((name) => !imported.has(name));
    expect(orphans, "api.ts 래퍼에 UI 호출부(import)가 없습니다 — 죽은 래퍼거나 프론트 배선 누락").toEqual([]);
  });
});
