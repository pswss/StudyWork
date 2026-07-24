// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { login, subjects } from "../web/src/api";
import { LOCALE_STORAGE_KEY } from "../web/src/i18n";

const storedValues = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    clear: () => storedValues.clear(),
    getItem: (key: string) => storedValues.get(key) ?? null,
    removeItem: (key: string) => storedValues.delete(key),
    setItem: (key: string, value: string) => storedValues.set(key, String(value)),
  },
});

beforeEach(() => window.localStorage.setItem(LOCALE_STORAGE_KEY, "ko"));

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("API 오류 문구", () => {
  it("본문 없는 서버 오류도 사용자가 복구할 수 있는 말로 보여 준다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));

    await expect(subjects()).rejects.toThrow("서버가 요청을 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
  });

  it("비한국어 UI에서는 서버의 한국어 인증 오류를 선택 언어로 바꾼다", async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "아이디 또는 비밀번호가 올바르지 않습니다",
    }), { status: 401, headers: { "content-type": "application/json" } })));

    await expect(login("owner", "wrong-password")).rejects.toThrow(
      "The username or password is incorrect."
    );
  });

  it("미등록 상세 오류는 한국어 원문 대신 현지화된 안전 문구를 쓴다", async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "es");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "동적으로 생성된 한국어 오류 17",
    }), { status: 409, headers: { "content-type": "application/json" } })));

    await expect(subjects()).rejects.toThrow(
      "No se pudo completar la solicitud. Revisa los datos e inténtalo de nuevo."
    );
  });
});
