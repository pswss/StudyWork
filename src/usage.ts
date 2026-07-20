import type { LocalDB } from "./localdb";

export const DAILY_LIMIT = 200;

export async function checkAndIncrementUsage(db: LocalDB): Promise<boolean> {
  // 로컬 날짜 기준 (exams.ts todayStr과 동일 — UTC로 하면 자정 전후 한도가 어긋남)
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  await db.prepare(
    "INSERT INTO usage_daily (day, calls) VALUES (?, 0) ON CONFLICT(day) DO NOTHING"
  ).bind(day).run();
  const row = await db.prepare(
    "UPDATE usage_daily SET calls = calls + 1 WHERE day = ? AND calls < ? RETURNING calls"
  ).bind(day, DAILY_LIMIT).first();
  return row !== null;
}
