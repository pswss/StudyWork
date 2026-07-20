import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { stringify } from "yaml";

export class ObsidianError extends Error {}
export class ObsidianPathError extends ObsidianError {}
export class ObsidianConflictError extends ObsidianError {}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export class ObsidianVault {
  readonly name: string;
  private readonly root: string;

  constructor(rootPath: string) {
    if (!rootPath.trim()) throw new ObsidianPathError("Obsidian 볼트 경로가 비어 있습니다");
    let canonical: string;
    try {
      canonical = realpathSync(rootPath);
    } catch {
      throw new ObsidianPathError("Obsidian 볼트를 찾을 수 없습니다");
    }
    if (!lstatSync(canonical).isDirectory()) {
      throw new ObsidianPathError("Obsidian 볼트 경로가 디렉터리가 아닙니다");
    }
    this.root = canonical;
    this.name = basename(canonical);
  }

  status(): { vaultName: string; canRead: boolean; canWrite: boolean } {
    let canRead = false;
    let canWrite = false;
    try { accessSync(this.root, constants.R_OK); canRead = true; } catch {}
    try { accessSync(this.root, constants.W_OK); canWrite = true; } catch {}
    return { vaultName: this.name, canRead, canWrite };
  }

  private contains(path: string): boolean {
    return path === this.root || path.startsWith(this.root + sep);
  }

  private validateRelative(input: string): string {
    const value = input.trim();
    const portable = value.replaceAll("\\", "/");
    if (
      !value
      || value.includes("\0")
      || isAbsolute(value)
      || portable.startsWith("/")
      || /^[a-z]:\//i.test(portable)
    ) {
      throw new ObsidianPathError("볼트 상대 경로가 필요합니다");
    }
    if (/%(?:2e|2f|5c)/i.test(value)) throw new ObsidianPathError("인코딩된 경로 구분자는 허용되지 않습니다");
    const parts = portable.split("/").filter(Boolean);
    if (parts.some((part) => part === "." || part === "..")) {
      throw new ObsidianPathError("경로 이동 구문은 허용되지 않습니다");
    }
    const resolved = resolve(this.root, ...parts);
    if (!this.contains(resolved)) throw new ObsidianPathError("볼트 밖 경로는 허용되지 않습니다");
    return relative(this.root, resolved);
  }

  /** Resolve (and optionally create) each parent component without following an escaping symlink. */
  private secureDirectory(relativeDirectory: string, create: boolean): string | null {
    const parts = relativeDirectory === "." ? [] : relativeDirectory.split(sep).filter(Boolean);
    let current = this.root;
    for (const part of parts) {
      const candidate = resolve(current, part);
      if (!this.contains(candidate)) throw new ObsidianPathError("볼트 밖 경로는 허용되지 않습니다");
      if (!entryExists(candidate)) {
        if (!create) return null;
        try {
          mkdirSync(candidate, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      let canonical: string;
      try {
        canonical = realpathSync(candidate);
      } catch {
        throw new ObsidianPathError("Obsidian 폴더 경로를 확인할 수 없습니다");
      }
      if (!this.contains(canonical)) throw new ObsidianPathError("심볼릭 링크가 볼트 밖을 가리킵니다");
      if (!statSync(canonical).isDirectory()) throw new ObsidianPathError("Obsidian 폴더 경로가 디렉터리가 아닙니다");
      current = canonical;
    }
    return current;
  }

  targetExists(input: string): boolean {
    const relativePath = this.validateRelative(input);
    const parent = this.secureDirectory(dirname(relativePath), false);
    if (parent === null) return false;
    const target = resolve(parent, basename(relativePath));
    if (!entryExists(target)) return false;
    const canonical = realpathSync(target);
    if (!this.contains(canonical)) throw new ObsidianPathError("심볼릭 링크가 볼트 밖을 가리킵니다");
    return true;
  }

  /** Create-only atomic write. Existing notes are never overwritten silently. */
  writeMarkdown(input: string, body: string, frontmatter: Record<string, unknown> = {}): { path: string; hash: string } {
    const relativePath = this.validateRelative(input);
    if (extname(relativePath).toLowerCase() !== ".md") throw new ObsidianPathError("내보내기 경로는 .md여야 합니다");
    const canonicalParent = this.secureDirectory(dirname(relativePath), true)!;
    const target = resolve(canonicalParent, basename(relativePath));
    const content = Object.keys(frontmatter).length > 0
      ? `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${body.replace(/^\uFEFF/, "")}`
      : body.replace(/^\uFEFF/, "");
    const temp = resolve(canonicalParent, `.${basename(target)}.${randomUUID()}.tmp`);
    let descriptor: number | null = null;
    try {
      descriptor = openSync(temp, "wx", 0o600);
      writeFileSync(descriptor, content, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      try {
        linkSync(temp, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new ObsidianConflictError("같은 경로의 Obsidian 노트가 이미 있습니다");
        }
        throw error;
      }
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      if (existsSync(temp)) unlinkSync(temp);
    }
    return { path: relative(this.root, target), hash: sha256(content) };
  }
}
