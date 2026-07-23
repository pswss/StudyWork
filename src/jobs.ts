/**
 * In-process background-job generations.
 *
 * A plain cancelled-key Set is unsafe when a user cancels and immediately
 * retries: clearing the key for the new run also revives the old run. The
 * AbortSignal identity makes every completion/progress write prove that
 * it still belongs to the active run.
 */
export interface JobToken {
  readonly key: string;
  readonly signal: AbortSignal;
}

interface JobState {
  controller: AbortController;
}

const jobs = new Map<string, JobState>();
export const activeSolutionBooks = new Set<number>();
export const activeBookMutations = new Set<number>();

// 대상(target) 단위 중복 가드 — 같은 (종류, 과목, 대상) 작업만 409로 막고,
// 다른 대상은 전역 세마포어 한도 안에서 동시 실행을 허용한다.
const activeTargets = new Set<string>();

export function claimTarget(key: string): boolean {
  if (activeTargets.has(key)) return false;
  activeTargets.add(key);
  return true;
}

export function releaseTarget(key: string): void {
  activeTargets.delete(key);
}

export function startJob(key: string): JobToken {
  const previous = jobs.get(key);
  previous?.controller.abort();
  const controller = new AbortController();
  jobs.set(key, { controller });
  return { key, signal: controller.signal };
}

export function cancelJob(key: string): void {
  const previous = jobs.get(key);
  previous?.controller.abort();
  jobs.delete(key);
}

export function isCurrentJob(token: JobToken): boolean {
  const current = jobs.get(token.key);
  return Boolean(current?.controller.signal === token.signal && !token.signal.aborted);
}

export function finishJob(token: JobToken): void {
  const current = jobs.get(token.key);
  if (current?.controller.signal === token.signal) {
    jobs.delete(token.key);
  }
}

/** Test-only reset; exported to keep job-race tests deterministic. */
export function resetJobsForTest(): void {
  for (const state of jobs.values()) state.controller.abort();
  jobs.clear();
  activeSolutionBooks.clear();
  activeBookMutations.clear();
  activeTargets.clear();
}
