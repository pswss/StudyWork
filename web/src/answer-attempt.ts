export interface AnswerAttempt {
  questionId: number;
  answer: string;
  id: string;
}
/** Secure-context UUID when available, with a LAN HTTP-compatible fallback. */
export function createAttemptId(cryptoApi: Crypto | undefined = globalThis.crypto): string {
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }
  // 오래된 비보안 브라우저용 최종 폴백. 키는 인증용이 아니라 중복 집계 방지용이다.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/** 네트워크 재시도는 같은 키를, 사용자가 답을 바꾼 새 제출은 새 키를 쓴다. */
export function getAnswerAttempt(
  current: AnswerAttempt | null,
  questionId: number,
  answer: string,
  createId: () => string = createAttemptId
): AnswerAttempt {
  if (current?.questionId === questionId && current.answer === answer) return current;
  return { questionId, answer, id: createId() };
}
