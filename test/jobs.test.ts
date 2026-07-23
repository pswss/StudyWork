import { afterEach, describe, expect, it } from "vitest";
import {
  cancelJob,
  claimTarget,
  finishJob,
  isCurrentJob,
  releaseTarget,
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

describe("target claim (대상 단위 중복 가드)", () => {
  it("같은 대상 키는 해제 전까지 다시 점유할 수 없고, 다른 대상은 독립이다", () => {
    expect(claimTarget("expl:1:file:3")).toBe(true);
    expect(claimTarget("expl:1:file:3")).toBe(false);
    expect(claimTarget("expl:1:file:4")).toBe(true);
    expect(claimTarget("expl:2:file:3")).toBe(true);

    releaseTarget("expl:1:file:3");
    expect(claimTarget("expl:1:file:3")).toBe(true);
  });
});
