import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ObsidianConflictError,
  ObsidianPathError,
  ObsidianVault,
} from "../src/obsidian";

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "StudyWork 볼트 "));
  outside = mkdtempSync(join(tmpdir(), "studywork-outside-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("ObsidianVault export", () => {
  it("볼트 상태를 확인하고 없는 볼트를 구분", () => {
    expect(new ObsidianVault(root).status()).toMatchObject({ canRead: true, canWrite: true });
    expect(() => new ObsidianVault(join(root, "없음"))).toThrow(ObsidianPathError);
  });

  it("경로 탈출·인코딩 우회·볼트 밖 symlink를 차단", () => {
    symlinkSync(outside, join(root, "외부 폴더"));
    const vault = new ObsidianVault(root);
    expect(() => vault.targetExists("../secret.md")).toThrow(ObsidianPathError);
    expect(() => vault.targetExists("%2e%2e/secret.md")).toThrow(ObsidianPathError);
    expect(() => vault.targetExists("외부 폴더/새 노트.md")).toThrow(ObsidianPathError);
    expect(() => vault.writeMarkdown("외부 폴더/새 노트.md", "금지")).toThrow(ObsidianPathError);
  });

  it("Markdown을 원자적으로 create-only 저장하고 동시 덮어쓰기를 거부", async () => {
    const vault = new ObsidianVault(root);
    const target = "StudyWork/수학 단권화.md";
    const results = await Promise.allSettled([
      Promise.resolve().then(() => vault.writeMarkdown(target, "# 첫 번째", { type: "studywork-note", tags: ["studywork"] })),
      Promise.resolve().then(() => vault.writeMarkdown(target, "# 두 번째", { type: "studywork-note", tags: ["studywork"] })),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(ObsidianConflictError);
    const saved = readFileSync(join(root, target), "utf8");
    expect(saved).toContain("type: studywork-note");
    expect(saved.includes("# 첫 번째") || saved.includes("# 두 번째")).toBe(true);
    expect(readdirSync(join(root, "StudyWork")).some((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toBe(false);
  });
});
