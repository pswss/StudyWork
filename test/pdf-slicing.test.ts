import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { slicePdf } from "../src/claude";
import { AIProviderError } from "../src/codex-provider";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "studywork-slice-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function writePdf(name: string, pages: number): Promise<string> {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < pages; index++) pdf.addPage();
  const path = join(dir, name);
  writeFileSync(path, await pdf.save());
  return path;
}

describe("PDF byte-aware slicing", () => {
  it("페이지와 바이트 한도 안의 PDF는 원본을 그대로 사용", async () => {
    const path = await writePdf("small.pdf", 2);
    await expect(slicePdf(path, 6, 6)).resolves.toBeNull();
  });

  it("페이지 수가 적어도 바이트 한도를 넘으면 재귀적으로 더 작게 분할", async () => {
    const path = await writePdf("dense.pdf", 8);
    const sliced = await slicePdf(path, 8, 8, 600);
    expect(sliced).not.toBeNull();
    try {
      expect(sliced!.slices.length).toBeGreaterThan(1);
      expect(sliced!.slices[0].from).toBe(1);
      expect(sliced!.slices.at(-1)?.to).toBe(8);
      expect(sliced!.slices.every((slice) => statSync(slice.path).size <= 600)).toBe(true);
    } finally {
      sliced!.cleanup();
    }
  });

  it("한 페이지 자체가 한도를 넘으면 API 호출 전에 명확히 거부", async () => {
    const path = await writePdf("one-page.pdf", 1);
    let error: unknown;
    try {
      await slicePdf(path, 6, 6, 500);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AIProviderError);
    expect((error as AIProviderError).code).toBe("file_too_large");
  });
});
