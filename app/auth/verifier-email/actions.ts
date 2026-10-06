"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createHash } from "node:crypto";
import { neutralizeUnexpectedSignup } from "@/lib/account/email-verification";
import { isBlocked, record } from "@/lib/rate-limit";

// "Ce n'est pas moi" — shown right after a successful email-verification
// click. Authorization is possession of the just-consumed link, carried in
// the short-lived (5 min) httpOnly `bis_notme` cookie set by
// /api/auth/verify-email (never accepted from client input). See
// neutralizeUnexpectedSignup for exactly what it does.
//
// Throttling is keyed on the TOKEN (not the IP) and counted only for
// requests that actually carry a cookie, so cookie-less junk POSTs can
// neither drain a shared bucket nor lock a real victim out.
const NOTME_PER_TOKEN = 5;

export async function reportUnexpectedSignup(): Promise<void> {
  const jar = await cookies();
  const token = jar.get("bis_notme")?.value ?? "";
  // One-shot: always clear it, whatever the outcome.
  jar.delete("bis_notme");

  if (!token || token.length > 256) redirect("/auth/verifier-email?status=invalid");

  const key = `notme:tok:${createHash("sha256").update(token).digest("hex").slice(0, 24)}`;
  if (isBlocked(key, NOTME_PER_TOKEN)) {
    redirect("/auth/verifier-email?status=throttled");
  }
  record(key);

  const res = await neutralizeUnexpectedSignup(token);
  redirect(
    res.ok
      ? "/auth/verifier-email?status=secured"
      : "/auth/verifier-email?status=invalid"
  );
}
