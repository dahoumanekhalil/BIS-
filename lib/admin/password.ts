import { scryptSync, randomBytes, timingSafeEqual } from "crypto";

const KEYLEN = 64;
const N = 16384;
const R = 8;
const P = 1;

// Format: scrypt$N=…,r=…,p=…$saltBase64$hashBase64
export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$N=${N},r=${R},p=${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  try {
    const [scheme, params, saltB64, hashB64] = stored.split("$");
    if (scheme !== "scrypt") return false;
    const { N: n, r, p } = Object.fromEntries(
      params.split(",").map((kv) => {
        const [k, v] = kv.split("=");
        return [k, Number(v)];
      })
    ) as { N: number; r: number; p: number };
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const actual = scryptSync(plain, salt, expected.length, {
      N: n,
      r,
      p
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
