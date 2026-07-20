import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import type { Env } from "./index";

const encoder = new TextEncoder();

// 상수 시간 문자열 비교 (타이밍 공격 방지)
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replaceAll("+", "-").replaceAll("/", "_");
}

// 토큰 = exp타임스탬프.서명
export async function issueToken(secret: string, ttlMs = 90 * 24 * 3600 * 1000): Promise<string> {
  const exp = Date.now() + ttlMs;
  return `${exp}.${await hmac(secret, String(exp))}`;
}

export async function verifyToken(secret: string, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig) return false;
  if (Number(exp) < Date.now()) return false;
  return safeEqual(await hmac(secret, exp), sig);
}

export function authMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const cookie = c.req.header("cookie") ?? "";
    const token = cookie.match(/sw_token=([^;]+)/)?.[1];
    if (!(await verifyToken(c.env.AUTH_SECRET, token))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}
