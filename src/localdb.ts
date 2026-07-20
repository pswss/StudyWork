// D1 호환 어댑터 — better-sqlite3(동기) 위에 구현.
// 라우트 코드는 결과를 await 하지만, 동기 값을 await 해도 문제없다.
// D1에서 실제로 쓰는 부분집합만 지원:
//   prepare(sql) → { bind(...params), first<T>(), all<T>(), run() }
//   batch(stmts) → 트랜잭션으로 실행
// INSERT/UPDATE ... RETURNING 은 better-sqlite3 .get()/.all() 로 처리한다.

import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// SELECT 및 RETURNING 절이 있는 문장은 row(들)를 돌려준다 → .get()/.all() 사용.
// 나머지(INSERT/UPDATE/DELETE without RETURNING)는 .run() 사용.
function returnsRows(sql: string): boolean {
  const s = sql.trim().toLowerCase();
  return s.startsWith("select") || s.startsWith("with") || /\breturning\b/.test(s);
}

export class PreparedStatement {
  private params: unknown[] = [];
  constructor(
    private db: Database.Database,
    private sql: string
  ) {}

  // D1은 bind가 새 인스턴스를 준 것처럼 취급될 수 있으나, 순차 사용에는 this 반환으로 충분하다.
  bind(...params: unknown[]): PreparedStatement {
    this.params = params;
    return this;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...this.params) as T | undefined;
    return row ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(...this.params) as T[];
    return { results: rows };
  }

  async run(): Promise<{ success: true }> {
    const stmt = this.db.prepare(this.sql);
    if (returnsRows(this.sql)) {
      // RETURNING 이 있으면 .run()은 실패하므로 .all()로 실행해 부작용만 취한다.
      stmt.all(...this.params);
    } else {
      stmt.run(...this.params);
    }
    return { success: true };
  }

  // batch() 트랜잭션 내부에서 동기 실행하기 위한 헬퍼.
  _execSync(): void {
    const stmt = this.db.prepare(this.sql);
    if (returnsRows(this.sql)) {
      stmt.all(...this.params);
    } else {
      stmt.run(...this.params);
    }
  }
}

export class LocalDB {
  private db: Database.Database;

  constructor(path: string, opts?: { migrationsDir?: string }) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    if (opts?.migrationsDir) this.applyMigrations(opts.migrationsDir);
  }

  prepare(sql: string): PreparedStatement {
    return new PreparedStatement(this.db, sql);
  }

  async batch(stmts: PreparedStatement[]): Promise<{ success: true }[]> {
    const tx = this.db.transaction((list: PreparedStatement[]) => {
      for (const s of list) s._execSync();
    });
    tx(stmts);
    return stmts.map(() => ({ success: true }));
  }

  // migrations/*.sql 을 파일명 순서로 적용하고, 적용된 이름을 _migrations 테이블에 기록한다.
  applyMigrations(dir: string): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))"
    );
    const applied = new Set(
      (this.db.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name)
    );
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const insert = this.db.prepare("INSERT INTO _migrations (name) VALUES (?)");
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(dir, file), "utf8");
      const runMigration = this.db.transaction(() => {
        this.db.exec(sql);
        insert.run(file);
      });
      runMigration();
    }
  }

  close(): void {
    this.db.close();
  }
}
