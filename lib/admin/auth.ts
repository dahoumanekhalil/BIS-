import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { AdminStatus, type AdminUser } from "@prisma/client";
import { canWithOverrides, type Permission } from "./rbac";

const COOKIE_NAME = "bis_admin_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12h

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

// Phase 15 — the DB stores only sha256(rawToken). The raw token lives
// exclusively in the client's HTTP-only cookie; a DB dump cannot be
// replayed directly as a session because sha256 is one-way. Mirrors the
// AccountSession pattern (lib/account/auth.ts:hashToken).
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string): Promise<string> {
  const token = newSessionToken();
  await prisma.adminSession.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS)
    }
  });
  return token;
}

export async function setSessionCookie(token: string) {
  const jar = await cookies();
  jar.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000)
  });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.delete(COOKIE_NAME);
}

export async function readSessionToken(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(COOKIE_NAME)?.value ?? null;
}

export type CurrentAdmin = {
  user: AdminUser;
};

export async function getCurrentAdmin(): Promise<CurrentAdmin | null> {
  const token = await readSessionToken();
  if (!token) return null;
  const tokenHash = hashToken(token);
  const session = await prisma.adminSession.findUnique({
    where: { tokenHash },
    include: { user: true }
  });
  if (!session) return null;
  if (session.expiresAt < new Date()) {
    // clean up expired token
    await prisma.adminSession
      .delete({ where: { tokenHash } })
      .catch(() => undefined);
    return null;
  }
  if (session.user.status !== AdminStatus.ACTIVE) return null;
  return { user: session.user };
}

/**
 * Require an authenticated admin. Redirects to /admin/login if missing.
 * Use inside protected server components / server actions.
 */
export async function requireAdmin(): Promise<CurrentAdmin> {
  const admin = await getCurrentAdmin();
  if (!admin) redirect("/admin/login");
  return admin;
}

export async function requirePermission(perm: Permission): Promise<CurrentAdmin> {
  const admin = await requireAdmin();
  if (!(await canWithOverrides(admin.user.role, perm))) {
    // 403 handling — send to dashboard with a query flag.
    redirect(`/admin/dashboard?denied=${perm}`);
  }
  return admin;
}

// Phase 15 — accepts the raw cookie token and hashes internally before
// looking up / deleting. Returns the deleted session's userId so
// callers can audit `auth.logout` (or the speaker equivalent) after
// the deletion. Returns null if no session existed for the token
// (already logged out / expired).
export async function invalidateSession(
  rawToken: string
): Promise<{ userId: string } | null> {
  const tokenHash = hashToken(rawToken);
  const session = await prisma.adminSession
    .findUnique({
      where: { tokenHash },
      select: { userId: true }
    })
    .catch(() => null);
  if (!session) return null;
  await prisma.adminSession
    .delete({ where: { tokenHash } })
    .catch(() => undefined);
  return session;
}
