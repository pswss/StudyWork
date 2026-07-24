import { describe, expect, it } from "vitest";
import { issueToken } from "../src/auth";
import app, { type Env } from "../src/index";
import { call, makeEnv } from "./helpers";

const credentials = {
  username: "owner_01",
  password: "correct horse battery staple",
};
const legacyPassword = "test-password";

function post(env: ReturnType<typeof makeEnv>, path: string, body?: unknown, cookie?: string) {
  return call(env, path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
}

function cookieOf(response: Response): string {
  return response.headers.get("set-cookie")!.split(";")[0];
}

function requestAt(
  env: Env,
  url: string,
  init: RequestInit,
  remoteAddress: string
): Promise<Response> {
  return Promise.resolve(app.fetch(
    new Request(url, init),
    { ...env, incoming: { socket: { remoteAddress } } }
  ));
}

describe("auth", () => {
  it("공개 응답에 기본 보안 헤더를 붙인다", async () => {
    const response = await call(makeEnv(), "/api/health");
    expect(response.headers.get("strict-transport-security")).toContain("max-age=");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("계정이 없을 때만 기존 APP_PASSWORD 로그인을 허용한다", async () => {
    const env = makeEnv();
    const login = await post(env, "/api/login", { password: legacyPassword });
    expect(login.status).toBe(200);

    const cookie = cookieOf(login);
    expect((await call(env, "/api/subjects", { headers: { cookie } })).status).toBe(200);

    const signup = await post(env, "/api/signup", credentials);
    expect(signup.status).toBe(201);
    expect((await call(env, "/api/subjects", { headers: { cookie } })).status).toBe(401);
    expect((await post(env, "/api/login", { password: legacyPassword })).status).toBe(401);
  });

  it("서버 비밀번호가 없는 새 설치에서도 첫 소유자를 만들고 scrypt 해시만 저장한다", async () => {
    const env = makeEnv();
    delete env.APP_PASSWORD;
    const signup = await post(env, "/api/signup", credentials);
    expect(signup.status).toBe(201);
    expect(signup.headers.get("set-cookie")).toContain("HttpOnly");
    expect(signup.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(signup.headers.get("set-cookie")).toContain("Secure");

    const user = await env.DB.prepare(
      "SELECT username, password_hash FROM users WHERE id = 1"
    ).first<{ username: string; password_hash: string }>();
    expect(user?.username).toBe(credentials.username);
    expect(user?.password_hash).toMatch(/^scrypt\$32768\$8\$3\$/);
    expect(user?.password_hash).not.toContain(credentials.password);

    const duplicate = await post(env, "/api/signup", {
      username: "another_owner",
      password: "another secure password",
    });
    expect(duplicate.status).toBe(409);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM users").first<{ n: number }>())?.n).toBe(1);
  });

  it("HTTPS 공개 모드는 명시적으로 열지 않은 첫 가입을 막는다", async () => {
    const env = makeEnv();
    env.HTTPS_ONLY = true;
    const headers = {
      "content-type": "application/json",
      origin: "https://remap.example.ts.net",
      "x-forwarded-host": "remap.example.ts.net",
      "x-forwarded-proto": "https",
    };
    const locked = await requestAt(env, "http://127.0.0.1/api/signup", {
      method: "POST",
      headers,
      body: JSON.stringify(credentials),
    }, "127.0.0.1");
    expect(locked.status).toBe(403);

    env.SIGNUP_ENABLED = true;
    const enabled = await requestAt(env, "http://127.0.0.1/api/signup", {
      method: "POST",
      headers,
      body: JSON.stringify(credentials),
    }, "127.0.0.1");
    expect(enabled.status).toBe(201);
  });

  it("동시에 가입해도 단일 소유자만 생성한다", async () => {
    const env = makeEnv();
    const responses = await Promise.all([
      post(env, "/api/signup", credentials),
      post(env, "/api/signup", { ...credentials, username: "owner_02" }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM users").first<{ n: number }>())?.n).toBe(1);
  });

  it("소유자 로그인 오류는 아이디 존재 여부와 무관하게 일반화한다", async () => {
    const env = makeEnv();
    await post(env, "/api/signup", credentials);

    const unknown = await post(env, "/api/login", {
      username: "unknown",
      password: credentials.password,
    });
    const wrongPassword = await post(env, "/api/login", {
      username: credentials.username,
      password: "this password is wrong",
    });
    expect(unknown.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    expect(await unknown.json()).toEqual(await wrongPassword.json());

    const login = await post(env, "/api/login", credentials);
    expect(login.status).toBe(200);
    expect((await call(env, "/api/subjects", { headers: { cookie: cookieOf(login) } })).status).toBe(200);
  });

  it("인증 상태는 공개하되 아이디는 인증된 소유자에게만 반환한다", async () => {
    const env = makeEnv();
    const initial = await call(env, "/api/auth/status");
    expect(initial.headers.get("cache-control")).toBe("no-store");
    expect(await initial.json()).toEqual({
      ownerExists: false,
      authenticated: false,
      authKind: null,
    });

    const signup = await post(env, "/api/signup", credentials);
    expect(await (await call(env, "/api/auth/status")).json()).toEqual({
      ownerExists: true,
      authenticated: false,
      authKind: null,
    });
    expect(await (await call(env, "/api/auth/status", {
      headers: { cookie: cookieOf(signup) },
    })).json()).toEqual({
      ownerExists: true,
      authenticated: true,
      authKind: "owner",
      username: credentials.username,
    });
  });

  it("로그아웃은 쿠키를 지우고 복사된 기존 토큰도 즉시 무효화한다", async () => {
    const env = makeEnv();
    const signup = await post(env, "/api/signup", credentials);
    const oldCookie = cookieOf(signup);
    const logout = await post(env, "/api/logout", undefined, oldCookie);
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("sw_token=");
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(logout.headers.get("set-cookie")).toContain("HttpOnly");
    expect(logout.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect((await call(env, "/api/subjects", { headers: { cookie: oldCookie } })).status).toBe(401);

    const login = await post(env, "/api/login", credentials);
    expect(login.status).toBe(200);
    expect(cookieOf(login)).not.toBe(oldCookie);
    expect((await call(env, "/api/subjects", {
      headers: { cookie: cookieOf(login) },
    })).status).toBe(200);
  });

  it("변조되거나 만료된 토큰을 거부한다", async () => {
    const env = makeEnv();
    const signup = await post(env, "/api/signup", credentials);
    const [name, token] = cookieOf(signup).split("=");
    const last = token.at(-1);
    const tampered = `${name}=${token.slice(0, -1)}${last === "A" ? "B" : "A"}`;
    expect((await call(env, "/api/subjects", {
      headers: { cookie: tampered },
    })).status).toBe(401);

    const expired = await issueToken(
      env.AUTH_SECRET,
      { kind: "owner", userId: 1, sessionVersion: 1 },
      -1
    );
    expect((await call(env, "/api/subjects", {
      headers: { cookie: `sw_token=${expired}` },
    })).status).toBe(401);
  });

  it("아이디·비밀번호 입력을 제한한다", async () => {
    const env = makeEnv();
    expect((await post(env, "/api/signup", {
      username: "a b",
      password: credentials.password,
    })).status).toBe(400);
    expect((await post(env, "/api/signup", {
      username: credentials.username,
      password: "short",
    })).status).toBe(400);
  });

  it("실패한 로그인은 IP별 분당 5회 뒤 제한한다", async () => {
    const env = makeEnv();
    for (let i = 0; i < 5; i++) {
      expect((await post(env, "/api/login", { password: "wrong" })).status).toBe(401);
    }
    expect((await post(env, "/api/login", { password: "wrong" })).status).toBe(429);
  });

  it("실패한 가입도 IP별 분당 5회 뒤 제한한다", async () => {
    const env = makeEnv();
    for (let i = 0; i < 5; i++) {
      expect((await post(env, "/api/signup", {
        username: "x",
        password: credentials.password,
      })).status).toBe(400);
    }
    expect((await post(env, "/api/signup", credentials)).status).toBe(429);
  });

  it("인증 본문은 4KiB를 넘길 수 없다", async () => {
    const env = makeEnv();
    const response = await call(env, "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "x".repeat(5_000) }),
    });
    expect(response.status).toBe(413);
  });

  it("브라우저의 교차 출처 인증 요청을 거부한다", async () => {
    const env = makeEnv();
    const hostile = await call(env, "/api/signup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify(credentials),
    });
    expect(hostile.status).toBe(403);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM users").first<{ n: number }>())?.n).toBe(0);

    const crossSite = await call(env, "/api/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ password: legacyPassword }),
    });
    expect(crossSite.status).toBe(403);

    const sameOrigin = await call(env, "/api/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://x",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ password: legacyPassword }),
    });
    expect(sameOrigin.status).toBe(200);
  });

  it("루프백 HTTPS 프록시만 전달 헤더를 신뢰하고 __Host 쿠키를 발급한다", async () => {
    const env = makeEnv();
    env.HTTPS_ONLY = true;
    env.SIGNUP_ENABLED = true;
    const proxyHeaders = {
      "content-type": "application/json",
      origin: "https://studywork.example.ts.net",
      "x-forwarded-for": "100.64.0.7",
      "x-forwarded-host": "studywork.example.ts.net",
      "x-forwarded-proto": "https",
    };
    const proxied = await requestAt(env, "http://127.0.0.1/api/signup", {
      method: "POST",
      headers: proxyHeaders,
      body: JSON.stringify(credentials),
    }, "127.0.0.1");
    expect(proxied.status).toBe(201);
    expect(proxied.headers.get("set-cookie")).toContain("__Host-sw_token=");
    expect(proxied.headers.get("set-cookie")).toContain("; Secure");
    expect(proxied.headers.get("set-cookie")).not.toContain("Domain=");

    const protectedResponse = await requestAt(env, "http://127.0.0.1/api/subjects", {
      headers: {
        ...proxyHeaders,
        cookie: cookieOf(proxied),
      },
    }, "::1");
    expect(protectedResponse.status).toBe(200);

    const spoofed = await requestAt(makeEnv(), "http://127.0.0.1/api/login", {
      method: "POST",
      headers: proxyHeaders,
      body: JSON.stringify({ password: legacyPassword }),
    }, "100.64.0.8");
    expect(spoofed.status).toBe(403);

    const direct = makeEnv();
    direct.HTTPS_ONLY = true;
    expect((await requestAt(direct, "http://127.0.0.1/api/auth/status", {
      method: "GET",
    }, "100.64.0.8")).status).toBe(426);
  });

  it("rate limit의 전달 IP는 루프백 프록시에서만 사용한다", async () => {
    const trusted = makeEnv();
    for (let i = 1; i <= 6; i++) {
      const response = await requestAt(trusted, "https://x/api/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": `100.64.0.${i}`,
        },
        body: JSON.stringify({ password: "wrong" }),
      }, "127.0.0.1");
      expect(response.status).toBe(401);
    }

    const direct = makeEnv();
    for (let i = 1; i <= 5; i++) {
      expect((await requestAt(direct, "https://x/api/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": `100.64.1.${i}`,
        },
        body: JSON.stringify({ password: "wrong" }),
      }, "100.64.0.20")).status).toBe(401);
    }
    expect((await requestAt(direct, "https://x/api/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "100.64.1.99",
      },
      body: JSON.stringify({ password: "wrong" }),
    }, "100.64.0.20")).status).toBe(429);
  });

  it("토큰 없이 보호된 API에는 접근할 수 없다", async () => {
    expect((await call(makeEnv(), "/api/subjects")).status).toBe(401);
  });
});
