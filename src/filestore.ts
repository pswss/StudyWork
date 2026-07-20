// R2 호환 어댑터 — 로컬 디렉터리에 파일 저장.
//   put(key, buf) → <dir>/<key>
//   exists(key) → boolean
//   delete(key) → 파일 삭제
//   absolutePath(key) → AI provider가 검증 후 읽을 절대 경로
// key는 resolve 후 root 안을 벗어나면(경로 탈출) 거부한다.

import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

export class FileStore {
  private root: string;

  constructor(dir: string) {
    this.root = isAbsolute(dir) ? dir : resolve(dir);
    mkdirSync(this.root, { recursive: true });
  }

  private safeJoin(key: string): string {
    const filePath = resolve(this.root, key);
    if (filePath !== this.root && !filePath.startsWith(this.root + sep)) {
      throw new Error(`잘못된 키(경로 탈출): ${key}`);
    }
    return filePath;
  }

  absolutePath(key: string): string {
    return this.safeJoin(key);
  }

  async put(key: string, buf: ArrayBuffer): Promise<void> {
    const filePath = this.safeJoin(key);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, Buffer.from(buf));
  }

  // R2 get 호환 — 파일 내용 반환 (원본 서빙용)
  async get(key: string): Promise<Buffer | null> {
    const filePath = this.safeJoin(key);
    return existsSync(filePath) ? readFileSync(filePath) : null;
  }

  exists(key: string): boolean {
    return existsSync(this.safeJoin(key));
  }

  async delete(key: string): Promise<void> {
    const filePath = this.safeJoin(key);
    rmSync(filePath, { force: true });
    rmSync(`${filePath}.meta.json`, { force: true }); // 과거 버전이 남긴 메타 정리
  }

  /**
   * 한 디렉터리 안에서 key prefix와 일치하는 캐시 파일을 지운다.
   * 빈 prefix·디렉터리 전체·절대 경로는 거부하고 심볼릭 링크를 따라가지 않는다.
   */
  async deletePrefix(prefix: string): Promise<number> {
    if (!prefix || prefix.includes("\0") || isAbsolute(prefix) || /[\\/]$/.test(prefix)) {
      throw new Error(`잘못된 삭제 prefix: ${prefix}`);
    }

    const prefixPath = this.safeJoin(prefix);
    const parent = dirname(prefixPath);
    const namePrefix = basename(prefixPath);
    if (prefixPath === this.root || !namePrefix) throw new Error(`잘못된 삭제 prefix: ${prefix}`);
    if (!existsSync(parent)) return 0;

    let deleted = 0;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.name.startsWith(namePrefix) || (!entry.isFile() && !entry.isSymbolicLink())) continue;
      const target = resolve(parent, entry.name);
      if (target !== this.root && !target.startsWith(this.root + sep)) {
        throw new Error(`잘못된 삭제 대상: ${entry.name}`);
      }
      rmSync(target, { force: true });
      if (!entry.name.endsWith(".meta.json")) deleted++;
    }
    return deleted;
  }

  /** DB에 존재하지 않는 book_file의 재생성 가능한 PDF 페이지 PNG 캐시만 정리한다. */
  async prunePageCache(validFileIds: ReadonlySet<number>): Promise<number> {
    const pageDir = this.safeJoin("pages");
    if (!existsSync(pageDir)) return 0;
    let deleted = 0;
    for (const entry of readdirSync(pageDir, { withFileTypes: true })) {
      const match = /^(\d+)-.+\.png(?:\.meta\.json)?$/.exec(entry.name);
      if (!match || validFileIds.has(Number(match[1]))) continue;
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      rmSync(resolve(pageDir, entry.name), { force: true });
      if (!entry.name.endsWith(".meta.json")) deleted++;
    }
    return deleted;
  }
}
