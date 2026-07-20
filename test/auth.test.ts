import { describe, it, expect } from "vitest";
import { makeEnv, call } from "./helpers";

describe("auth", () => {
  const env = makeEnv();

  it("잘못된 비밀번호는 401", async () => {
    const res = await call(env, "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong" })
    });
    expect(res.status).toBe(401);
  });

  it("올바른 비밀번호는 200 + 쿠키 발급", async () => {
    const res = await call(env, "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-password" })
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("sw_token=");
  });

  it("토큰 없이 보호된 API 접근시 401", async () => {
    const res = await call(env, "/api/subjects");
    expect(res.status).toBe(401);
  });

  it("발급된 토큰으로 보호된 API 접근 가능", async () => {
    const login = await call(env, "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-password" })
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const res = await call(env, "/api/subjects", { headers: { cookie } });
    expect(res.status).not.toBe(401);
  });
});
