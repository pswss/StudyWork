import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import type { Env } from "./index";

const SESSION_TTL_MS = 90 * 24 * 3600 * 1000;
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 3;
const SCRYPT_KEY_BYTES = 64;
const SCRYPT_CONCURRENCY = 2;
let activeScrypt = 0;
const scryptWaiters: Array<() => void> = [];
const DUMMY_PASSWORD_HASH =
  `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${Buffer.alloc(16).toString("base64url")}$${Buffer.alloc(SCRYPT_KEY_BYTES).toString("base64url")}`;

export type SessionIdentity =
  | { kind: "legacy" }
  | { kind: "owner"; userId: 1; sessionVersion: number };

// 상수 시간 문자열 비교 (타이밍 공격 방지)
export function safeEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

function hmac(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

function legacyHmac(secret: string, data: string): string {
  return createHmac("sha256", secret)
    .update(data)
    .digest("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}

async function acquireScryptSlot(): Promise<void> {
  if (activeScrypt < SCRYPT_CONCURRENCY) {
    activeScrypt += 1;
    return;
  }
  // ponytail: 전역 슬롯이면 1인용 서버에 충분하다. 사용자별 처리량이 필요할 때만 키별 큐로 바꾼다.
  await new Promise<void>((resolve) => scryptWaiters.push(resolve));
}

function releaseScryptSlot(): void {
  const next = scryptWaiters.shift();
  if (next) next();
  else activeScrypt -= 1;
}

async function derivePassword(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  await acquireScryptSlot();
  try {
    return await new Promise((resolve, reject) => {
      scrypt(password, salt, SCRYPT_KEY_BYTES, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (error, key) => {
        if (error) reject(error);
        else resolve(key);
      });
    });
  } finally {
    releaseScryptSlot();
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derivePassword(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, rawN, rawR, rawP, rawSalt, rawKey, ...extra] = encoded.split("$");
  const n = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (
    algorithm !== "scrypt" || extra.length > 0 ||
    n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P ||
    !rawSalt || !rawKey
  ) return false;
  const salt = Buffer.from(rawSalt, "base64url");
  const expected = Buffer.from(rawKey, "base64url");
  if (salt.length !== 16 || expected.length !== SCRYPT_KEY_BYTES) return false;
  const actual = await derivePassword(password, salt, n, r, p);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function normalizeUsername(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("ko-KR");
}

export function validUsername(value: string): boolean {
  const normalized = normalizeUsername(value);
  return normalized.length >= 3
    && normalized.length <= 64
    && /^[\p{L}\p{N}_.-]+$/u.test(normalized);
}

export function validPassword(value: string): boolean {
  return value.length >= 10 && value.length <= 128 && Buffer.byteLength(value, "utf8") <= 512;
}

// 토큰 payload에 legacy/owner를 넣어 계정 생성 순간 모든 legacy 세션을 무효화할 수 있게 한다.
export async function issueToken(
  secret: string,
  identityOrTtl: SessionIdentity | number = { kind: "legacy" },
  ttlMs = SESSION_TTL_MS
): Promise<string> {
  const identity = typeof identityOrTtl === "number" ? { kind: "legacy" } as const : identityOrTtl;
  const exp = Date.now() + (typeof identityOrTtl === "number" ? identityOrTtl : ttlMs);
  const payload = identity.kind === "owner"
    ? `v1.owner.${identity.userId}.${identity.sessionVersion}.${exp}`
    : `v1.legacy.0.${exp}`;
  return `${payload}.${hmac(secret, payload)}`;
}

export async function verifyToken(secret: string, token: string | undefined): Promise<boolean> {
  return Boolean(await readToken(secret, token));
}

export async function readToken(secret: string, token: string | undefined): Promise<SessionIdentity | null> {
  if (!token) return null;
  const parts = token.split(".");

  // 배포 전 exp.sig 쿠키는 계정이 아직 없을 때만 legacy 세션으로 취급한다.
  if (parts.length === 2) {
    const [exp, sig] = parts;
    const expiresAt = Number(exp);
    if (!Number.isSafeInteger(expiresAt) || expiresAt < Date.now() || !sig) return null;
    return safeEqual(legacyHmac(secret, exp), sig) ? { kind: "legacy" } : null;
  }

  if (parts.length !== 5 && parts.length !== 6) return null;
  const [version, kind, rawUserId] = parts;
  const legacyToken = kind === "legacy" && parts.length === 5;
  const ownerToken = kind === "owner" && parts.length === 6;
  if (!legacyToken && !ownerToken) return null;
  const rawSessionVersion = ownerToken ? parts[3] : undefined;
  const exp = parts[ownerToken ? 4 : 3];
  const sig = parts[ownerToken ? 5 : 4];
  const expiresAt = Number(exp);
  const sessionVersion = Number(rawSessionVersion);
  const payload = parts.slice(0, -1).join(".");
  if (
    version !== "v1" ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt < Date.now() ||
    !sig ||
    !safeEqual(hmac(secret, payload), sig)
  ) return null;
  if (legacyToken && rawUserId === "0") return { kind: "legacy" };
  if (
    ownerToken &&
    rawUserId === "1" &&
    Number.isSafeInteger(sessionVersion) &&
    sessionVersion >= 1
  ) {
    return { kind: "owner", userId: 1, sessionVersion };
  }
  return null;
}

function tokenFromCookie(cookie: string, httpsOnly = false): string | undefined {
  const hostToken = cookie.match(/(?:^|;\s*)__Host-sw_token=([^;]+)/)?.[1];
  const localToken = cookie.match(/(?:^|;\s*)sw_token=([^;]+)/)?.[1];
  return httpsOnly ? hostToken : localToken ?? hostToken;
}

export async function authenticatedSession(
  c: Context<{ Bindings: Env }>
): Promise<SessionIdentity | null> {
  const identity = await readToken(
    c.env.AUTH_SECRET,
    tokenFromCookie(c.req.header("cookie") ?? "", c.env.HTTPS_ONLY)
  );
  if (!identity) return null;
  const owner = await c.env.DB.prepare(
    "SELECT id, session_version FROM users WHERE id = 1"
  ).first<{ id: number; session_version: number }>();
  if (identity.kind === "legacy") return owner ? null : identity;
  return owner?.id === identity.userId && owner.session_version === identity.sessionVersion
    ? identity
    : null;
}

export function passwordHashForUnknownUser(): string {
  return DUMMY_PASSWORD_HASH;
}

export function authMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    if (!(await authenticatedSession(c))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}
