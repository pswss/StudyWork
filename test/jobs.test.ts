import { afterEach, describe, expect, it } from "vitest";
import {
  cancelJob,
  finishJob,
  isCurrentJob,
  resetJobsForTest,
  startJob,
} from "../src/jobs";

afterEach(resetJobsForTest);

describe("background job identity", () => {
  it("cancel 후 재시도해도 이전 작업이 다시 유효해지지 않는다", () => {
    const oldRun = startJob("mat:1");
    cancelJob("mat:1");
    const retry = startJob("mat:1");

    expect(oldRun.signal.aborted).toBe(true);
    expect(isCurrentJob(oldRun)).toBe(false);
    expect(isCurrentJob(retry)).toBe(true);

    finishJob(oldRun);
    expect(isCurrentJob(retry)).toBe(true);
  });

  it("새 실행은 같은 키의 기존 실행을 중단한다", () => {
    const first = startJob("note:2");
    const second = startJob("note:2");

    expect(first.signal.aborted).toBe(true);
    expect(isCurrentJob(first)).toBe(false);
    expect(isCurrentJob(second)).toBe(true);
  });
});
