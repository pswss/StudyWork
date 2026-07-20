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
}
