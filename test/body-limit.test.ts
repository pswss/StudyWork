import { beforeAll, describe, expect, it } from "vitest";
import { MAX_UPLOAD_REQUEST_BYTES } from "../src/index";
import { call, makeEnv } from "./helpers";

const env = makeEnv();
let cookie: string;

beforeAll(async () => {
  const login = await call(env, "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-password" }),
  });
  cookie = login.headers.get("set-cookie")!.split(";")[0];
});

describe("request body limit", () => {
  it("multipart 파싱 전에 전체 요청 상한을 413으로 거부", async () => {
    const response = await call(env, "/api/subjects/1/materials", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/octet-stream",
        "content-length": String(MAX_UPLOAD_REQUEST_BYTES + 1),
      },
      body: new Uint8Array([1]),
    });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "업로드 요청 전체 크기는 202MB 이하만 지원합니다",
    });
  });
});
