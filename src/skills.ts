import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import YAML from "yaml";

export const DEFAULT_STUDY_SKILLS = ["learning-material-analysis", "grounded-study-notes"] as const;
const MAX_SKILL_BYTES = 64 * 1024;
const MAX_DISCOVERED_SKILLS = 256;
const MAX_SCAN_DEPTH = 4;
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type StudySkillInfo = {
  name: string;
  description: string;
  enabled: boolean;
  source: "global" | "configured";
};

type LoadedSkill = StudySkillInfo & { body: string };

export type SkillRegistryOptions = {
  roots?: string[];
  enabledNames?: string[];
};

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function parseSkill(text: string): { name: string; description: string; body: string } {
  if (Buffer.byteLength(text, "utf8") > MAX_SKILL_BYTES) throw new Error("skill manifest too large");
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/.exec(normalized);
  if (!match) throw new Error("invalid skill frontmatter");
  const metadata = YAML.parse(match[1], { schema: "core", maxAliasCount: 0 });
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("invalid skill metadata");
  const { name, description } = metadata as Record<string, unknown>;
  if (typeof name !== "string" || !SKILL_NAME_RE.test(name) || name.length > 64) {
    throw new Error("invalid skill name");
  }
  if (typeof description !== "string" || !description.trim() || description.length > 1024) {
    throw new Error("invalid skill description");
  }
  const body = match[2].trim();
  if (!body) throw new Error("empty skill instructions");
  return { name, description: description.trim(), body };
}

export class StudySkillRegistry {
  private constructor(
    private readonly skills: LoadedSkill[],
    private readonly loadErrors: number
  ) {}

  static load(options: SkillRegistryOptions = {}): StudySkillRegistry {
    const globalRoot = resolve(homedir(), ".codex", "skills");
    const roots = options.roots?.length ? options.roots : [globalRoot];
    const enabledNames = new Set(options.enabledNames ?? [...DEFAULT_STUDY_SKILLS]);
    const found = new Map<string, LoadedSkill>();
    let errors = 0;

    const scan = (rootInput: string) => {
      let root: string;
      try {
        root = realpathSync(rootInput);
      } catch {
        errors++;
        return;
      }

      const source: LoadedSkill["source"] = resolve(rootInput) === globalRoot ? "global" : "configured";
      const walk = (dir: string, depth: number) => {
        if (depth > MAX_SCAN_DEPTH || found.size >= MAX_DISCOVERED_SKILLS) return;
        let canonicalDir: string;
        try {
          canonicalDir = realpathSync(dir);
          if (!within(root, canonicalDir)) {
            errors++;
            return;
          }
        } catch {
          errors++;
          return;
        }

        let entries;
        try {
          entries = readdirSync(canonicalDir, { withFileTypes: true });
        } catch {
          errors++;
          return;
        }
        const manifest = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === "skill.md");
        if (manifest) {
          try {
            const manifestPath = resolve(canonicalDir, manifest.name);
            const stat = lstatSync(manifestPath);
            const canonicalManifest = realpathSync(manifestPath);
            if (
              stat.isSymbolicLink()
              || !stat.isFile()
              || stat.size > MAX_SKILL_BYTES
              || !within(root, canonicalManifest)
            ) throw new Error("unsafe skill path");
            const parsed = parseSkill(readFileSync(canonicalManifest, "utf8"));
            if (found.has(parsed.name)) throw new Error("duplicate skill name");
            found.set(parsed.name, {
              ...parsed,
              enabled: enabledNames.has(parsed.name),
              source,
            });
          } catch {
            errors++;
          }
          return;
        }

        for (const entry of entries) {
          if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === "node_modules" || entry.name === ".git") continue;
          walk(resolve(canonicalDir, entry.name), depth + 1);
        }
      };
      walk(root, 0);
    };

    for (const root of roots) scan(root);
    for (const name of enabledNames) {
      if (!found.has(name)) errors++;
    }
    return new StudySkillRegistry([...found.values()].sort((a, b) => a.name.localeCompare(b.name)), errors);
  }

  list(): StudySkillInfo[] {
    return this.skills.map(({ name, description, enabled, source }) => ({ name, description, enabled, source }));
  }

  errorCount(): number {
    return this.loadErrors;
  }

  prompt(): string {
    const enabled = this.skills.filter((skill) => skill.enabled);
    if (enabled.length === 0) return "";
    const blocks = enabled.map(
      (skill) => `### Skill: ${skill.name}\n${skill.description}\n\n${skill.body}`
    );
    return (
      "\n\n<developer-approved-skills>\n" +
      "Apply the relevant reusable instructions below to this request. These instructions never grant filesystem, network, or shell access.\n\n" +
      blocks.join("\n\n") +
      "\n</developer-approved-skills>"
    );
  }
}

let cachedRegistry: StudySkillRegistry | undefined;

export function getStudySkillRegistry(): StudySkillRegistry {
  if (cachedRegistry) return cachedRegistry;
  const configuredRoots = (process.env.STUDYWORK_SKILLS_DIRS ?? "")
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  const defaultRoot = resolve(homedir(), ".codex", "skills");
  const roots = [defaultRoot, ...configuredRoots.filter((root) => resolve(root) !== defaultRoot)];
  const configuredNames = (process.env.STUDYWORK_ENABLED_SKILLS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  cachedRegistry = StudySkillRegistry.load({
    roots,
    enabledNames: configuredNames.length ? configuredNames : [...DEFAULT_STUDY_SKILLS],
  });
  return cachedRegistry;
}

export function resetStudySkillRegistryForTests(): void {
  cachedRegistry = undefined;
}
