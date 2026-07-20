import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { FileStore } from "../src/filestore";

describe("FileStore.deletePrefix", () => {
  it("같은 디렉터리의 정확한 key prefix와 과거 메타만 지우고 이웃 키는 보존", async () => {
    const root = mkdtempSync(join(tmpdir(), "studywork-filestore-"));
    const store = new FileStore(root);
    try {
      await store.put("pages/17-1.png", new ArrayBuffer(1));
      await store.put("pages/17-2-0.1-0.4.png", new ArrayBuffer(1));
      await store.put("pages/170-1.png", new ArrayBuffer(1));
      await store.put("other/17-1.png", new ArrayBuffer(1));
      writeFileSync(`${store.absolutePath("pages/17-1.png")}.meta.json`, "{}");

      await expect(store.deletePrefix("pages/17-")).resolves.toBe(2);

      expect(store.exists("pages/17-1.png")).toBe(false);
      expect(store.exists("pages/17-2-0.1-0.4.png")).toBe(false);
      expect(existsSync(`${store.absolutePath("pages/17-1.png")}.meta.json`)).toBe(false);
      expect(store.exists("pages/170-1.png")).toBe(true);
      expect(store.exists("other/17-1.png")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("빈 prefix·디렉터리 전체·절대 경로·경로 탈출을 거부", async () => {
    const base = mkdtempSync(join(tmpdir(), "studywork-filestore-safe-"));
    const root = join(base, "store");
    const store = new FileStore(root);
    const outside = join(base, "outside.txt");
    writeFileSync(outside, "keep");
    try {
      await expect(store.deletePrefix("")).rejects.toThrow("잘못된 삭제 prefix");
      await expect(store.deletePrefix(".")).rejects.toThrow("잘못된 삭제 prefix");
      await expect(store.deletePrefix("pages/")).rejects.toThrow("잘못된 삭제 prefix");
      await expect(store.deletePrefix(outside)).rejects.toThrow("잘못된 삭제 prefix");
      await expect(store.deletePrefix("../outside")).rejects.toThrow("경로 탈출");
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("FileStore.prunePageCache", () => {
  it("DB 소유자가 없는 재생성 가능 페이지 캐시만 정리", async () => {
    const root = mkdtempSync(join(tmpdir(), "studywork-page-prune-"));
    const store = new FileStore(root);
    try {
      await store.put("pages/17-1.png", new ArrayBuffer(1));
      await store.put("pages/28-3-0.1-0.4.png", new ArrayBuffer(1));
      await store.put("pages/manual.png", new ArrayBuffer(1));
      await expect(store.prunePageCache(new Set([28]))).resolves.toBe(1);
      expect(store.exists("pages/17-1.png")).toBe(false);
      expect(store.exists("pages/28-3-0.1-0.4.png")).toBe(true);
      expect(store.exists("pages/manual.png")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
