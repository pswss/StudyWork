// 테스트 헬퍼 — 인메모리 LocalDB + 임시 FileStore로 Env를 만들고 app.fetch를 호출한다.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import app, { type Env } from "../src/index";
import { LocalDB } from "../src/localdb";
import { FileStore } from "../src/filestore";

const migrationsDir = resolve(import.meta.dirname, "..", "migrations");

export function makeEnv(): Env {
  const db = new LocalDB(":memory:", { migrationsDir });
  const dir = mkdtempSync(join(tmpdir(), "studywork-test-"));
  const files = new FileStore(dir);
  return {
    DB: db,
    FILES: files,
    APP_PASSWORD: "test-password",
    AUTH_SECRET: "test-secret",
  };
}

export function call(env: Env, path: string, init?: RequestInit): Promise<Response> {
  return Promise.resolve(app.fetch(new Request("https://x" + path, init), env));
}

/** Pause one usage increment after its caller has already claimed a job. */
export function pauseNextUsageIncrement(db: LocalDB): {
  entered: Promise<void>;
  release: () => void;
  restore: () => void;
} {
  const originalPrepare = db.prepare.bind(db);
  let releaseGate!: () => void;
  let markEntered!: () => void;
  let intercepted = false;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });

  (db as unknown as { prepare: LocalDB["prepare"] }).prepare = ((sql: string) => {
    const statement = originalPrepare(sql);
    if (!intercepted && sql.includes("UPDATE usage_daily SET calls = calls + 1")) {
      intercepted = true;
      const first = statement.first.bind(statement);
      (statement as unknown as { first: typeof statement.first }).first = (async <T>() => {
        markEntered();
        await gate;
        return first<T>();
      }) as typeof statement.first;
    }
    return statement;
  }) as LocalDB["prepare"];

  return {
    entered,
    release: releaseGate,
    restore: () => {
      releaseGate();
      (db as unknown as { prepare: LocalDB["prepare"] }).prepare = originalPrepare;
    },
  };
}
