import { describe, it, expect } from "vitest";
import { checkAndIncrementUsage, DAILY_LIMIT } from "../src/usage";
import { makeEnv } from "./helpers";

describe("usage guard", () => {
  it("한도 내에서는 허용하고 카운트 증가", async () => {
    const { DB } = makeEnv();
    const ok = await checkAndIncrementUsage(DB);
    expect(ok).toBe(true);
    const row = await DB.prepare("SELECT calls FROM usage_daily").first<{ calls: number }>();
    expect(row!.calls).toBe(1);
  });

  it("한도 도달 시 거부", async () => {
    const { DB } = makeEnv();
    // usage.ts와 동일한 로컬 날짜 (UTC toISOString이면 자정 전후에 어긋남)
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    await DB.prepare("INSERT OR REPLACE INTO usage_daily (day, calls) VALUES (?, ?)")
      .bind(day, DAILY_LIMIT).run();
    expect(await checkAndIncrementUsage(DB)).toBe(false);
  });
});
