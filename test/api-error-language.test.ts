import { afterEach, describe, expect, it, vi } from "vitest";
import { subjects } from "../web/src/api";

afterEach(() => vi.unstubAllGlobals());

describe("API 오류 문구", () => {
  it("본문 없는 서버 오류도 사용자가 복구할 수 있는 말로 보여 준다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));

    await expect(subjects()).rejects.toThrow("서버가 요청을 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
  });
});
