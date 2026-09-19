import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/db";

const COOKIE_NAME = "bis_account_session";
const PERSISTENT_TTL_MS = 1000 * 60 * 60 * 24 * 30; // "remember me"
const TRANSIENT_TTL_MS = 1000 * 60 * 60 * 12;

// Only the hash is persisted, so a leaked DB dump cannot be replayed as a cookie.
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createAccountSession(
  userId: string,
  persistent: boolean
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const ttl = persistent ? PERSISTENT_TTL_MS : TRANSIENT_TTL_MS;
  await prisma.accountSession.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + ttl)
    }
  });
  return token;
}

/**
 * `persistent: false` drops maxAge so the cookie dies with the browser. The row
 * TTL must match it — a browser that restores session cookies would otherwise
 * replay a token the user declined to have remembered.
 */
export async function setAccountCookie(token: string, persistent: boolean) {
  const jar = await cookies();
  jar.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    ...(persistent ? { maxAge: Math.floor(PERSISTENT_TTL_MS / 1000) } : {})
  });
}

export type CurrentAccount = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
};

export async function getCurrentAccount(): Promise<CurrentAccount | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) return null;

  const session = await prisma.accountSession.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      expiresAt: true,
      user: {
        select: { id: true, email: true, firstName: true, lastName: true }
      }
    }
  });
  if (!session) return null;
  if (session.expiresAt < new Date()) {
    await prisma.accountSession
      .deleteMany({ where: { tokenHash: hashToken(token) } })
      .catch(() => undefined);
    return null;
  }
  return session.user;
}

export async function requireAccount(): Promise<CurrentAccount> {
  const account = await getCurrentAccount();
  if (!account) redirect("/auth?mode=login");
  return account;
}

export async function destroyAccountSession() {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (token) {
    await prisma.accountSession
      .deleteMany({ where: { tokenHash: hashToken(token) } })
      .catch(() => undefined);
  }
  jar.delete(COOKIE_NAME);
}
