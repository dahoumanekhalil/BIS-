"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import {
  createSession,
  invalidateSession,
  readSessionToken,
  setSessionCookie,
  clearSessionCookie
} from "@/lib/admin/auth";
import { audit } from "@/lib/admin/audit";
import { verifyAdminLogin } from "@/lib/admin/login-service";
import { THROTTLED_MESSAGE } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";

// Phase 13 WARN 1 — hardened admin login.
//
// All authentication logic lives in `verifyAdminLogin` (pure server
// function, no cookies/redirect). This wrapper is the "use server"
// binding for the form:
//
//   1. read email/password/from from the FormData
//   2. resolve the client IP (proxy-aware; see lib/rate-limit.ts)
//   3. call verifyAdminLogin({email, password, ip})
//   4. on ok=false: return a UI state with a fixed generic message
//      (no branch-specific message, no timing side-channel — the
//      service already equalised latency via DUMMY_HASH)
//   5. on ok=true: create the session, set the cookie, audit, redirect
//
// Every failure — non-existent user, non-ACTIVE user, invalid
// password, empty input, throttled attempt — is externally
// indistinguishable except for the throttled variant, which surfaces
// the neutral "Trop de tentatives" copy (same string used by the
// attendee flow).

export type LoginState =
  | { status: "idle" }
  | { status: "error"; message: string };

// Kept as a module-level constant so every failure branch surfaces
// the byte-identical message. A future refactor cannot accidentally
// split the error copy into "user unknown" vs "wrong password".
const GENERIC_ERROR: LoginState = {
  status: "error",
  message: "Identifiants invalides."
};

const THROTTLED: LoginState = {
  status: "error",
  message: THROTTLED_MESSAGE
};

export async function adminLogin(
  _prev: LoginState,
  formData: FormData
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const from = String(formData.get("from") ?? "");

  const ip = await clientIp();
  const outcome = await verifyAdminLogin({ email, password, ip });

  if (outcome.ok === false) {
    if (outcome.kind === "THROTTLED") return THROTTLED;
    // INVALID_INPUT and INVALID_CREDENTIALS collapse into ONE
    // client-visible response. The service has already run
    // verifyPassword against DUMMY_HASH on the timing-sensitive
    // branches, so response latency is level across them.
    return GENERIC_ERROR;
  }

  const token = await createSession(outcome.userId);
  await setSessionCookie(token);
  await prisma.adminUser.update({
    where: { id: outcome.userId },
    data: { lastLoginAt: new Date() }
  });
  await audit({
    userId: outcome.userId,
    action: "auth.login",
    entity: "AdminUser",
    entityId: outcome.userId
  });

  // NOTE: the `from` parameter is validated with `.startsWith("/admin")`.
  // A stricter `.startsWith("/admin/")` (trailing slash) would rule out
  // exotic redirect vectors like `/admin\\evil.com`. Recorded as a
  // documented follow-up in the master doc (Phase 13 §Observations);
  // NOT changed in this phase per the owner's explicit scope directive.
  redirect(from && from.startsWith("/admin") ? from : "/admin/dashboard");
}

export async function adminLogout() {
  const token = await readSessionToken();
  if (token) {
    // Phase 15 — `invalidateSession` accepts the raw cookie token,
    // hashes it internally, and returns the (deleted) session's
    // userId so we can audit `auth.logout` after the row is gone.
    // No plaintext lookup remains anywhere in this file.
    const session = await invalidateSession(token);
    if (session) {
      await audit({
        userId: session.userId,
        action: "auth.logout",
        entity: "AdminUser",
        entityId: session.userId
      });
    }
  }
  await clearSessionCookie();
  redirect("/admin/login");
}
