import { describe, expect, it } from "vitest";
import { createAttemptId, getAnswerAttempt } from "../web/src/answer-attempt";

describe("answer attempt id", () => {
  it("randomUUID가 없는 LAN 브라우저에서도 getRandomValues로 UUID를 생성", () => {
    const cryptoApi = {
      getRandomValues<T extends ArrayBufferView | null>(array: T): T {
        if (array instanceof Uint8Array) array.fill(7);
        return array;
      },
    } as Crypto;
    expect(createAttemptId(cryptoApi)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("동일 payload만 키를 재사용하고 답이 바뀌면 새 키를 발급", () => {
    let next = 0;
    const create = () => `attempt-${++next}`;
    const first = getAnswerAttempt(null, 3, "A", create);
    expect(getAnswerAttempt(first, 3, "A", create)).toBe(first);
    expect(getAnswerAttempt(first, 3, "B", create).id).toBe("attempt-2");
    expect(getAnswerAttempt(first, 4, "A", create).id).toBe("attempt-3");
  });
});
