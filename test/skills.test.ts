import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudySkillRegistry } from "../src/skills";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "studywork-skills-"));
  dirs.push(root);
  return root;
}

function addSkill(root: string, folder: string, name: string, body = "Keep page evidence."): void {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Analyze learning sources safely.\n---\n\n${body}\n`
  );
}

describe("StudySkillRegistry", () => {
  it("discovers and loads only explicitly enabled skill instructions", () => {
    const root = fixture();
    addSkill(root, "자료 분석", "learning-material-analysis", "Keep 페이지 evidence.");
    addSkill(root, "other", "other-skill", "Do something else.");
    const registry = StudySkillRegistry.load({ roots: [root], enabledNames: ["learning-material-analysis"] });

    expect(registry.list()).toEqual([
      expect.objectContaining({ name: "learning-material-analysis", enabled: true }),
      expect.objectContaining({ name: "other-skill", enabled: false }),
    ]);
    expect(registry.prompt()).toContain("Keep 페이지 evidence.");
    expect(registry.prompt()).not.toContain("Do something else.");
    expect(registry.errorCount()).toBe(0);
  });

  it("rejects malformed, duplicate, oversized, and symlink-escaped manifests", () => {
    const root = fixture();
    addSkill(root, "valid", "safe-skill");
    addSkill(root, "duplicate", "safe-skill");
    const malformed = join(root, "malformed");
    mkdirSync(malformed);
    writeFileSync(join(malformed, "SKILL.md"), "no frontmatter");
    const oversized = join(root, "oversized");
    mkdirSync(oversized);
    writeFileSync(join(oversized, "SKILL.md"), `---\nname: huge\ndescription: huge\n---\n${"x".repeat(70_000)}`);
    const outside = fixture();
    addSkill(outside, "outside", "outside-skill");
    symlinkSync(join(outside, "outside"), join(root, "linked"));

    const registry = StudySkillRegistry.load({ roots: [root], enabledNames: ["safe-skill"] });
    expect(registry.list().filter((skill) => skill.name === "safe-skill")).toHaveLength(1);
    expect(registry.list().some((skill) => skill.name === "outside-skill")).toBe(false);
    expect(registry.errorCount()).toBeGreaterThanOrEqual(3);
  });

  it("reports an enabled name that cannot be discovered", () => {
    const root = fixture();
    const registry = StudySkillRegistry.load({ roots: [root], enabledNames: ["missing-skill"] });
    expect(registry.prompt()).toBe("");
    expect(registry.errorCount()).toBe(1);
  });
});
