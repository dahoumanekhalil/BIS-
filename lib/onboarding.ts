import "server-only";

import { cookies } from "next/headers";
import { createHash } from "crypto";
import { prisma } from "@/lib/db";

// Retired in Commit 2 (see docs/registration-architecture.md).
//
// The multi-step OnboardingSession wizard is gone. Every registration flow
// now creates or reuses the AccountUser-bound Participant directly (see
// `lib/register/participant.ts::ensureParticipantForAccount`), so no
// short-lived server-side state carrier is needed.
//
// This file keeps only `endOnboardingSession` — a defensive cleanup called
// by `logoutAccount` so any legacy `bis_reg_session` cookie carried over
// from the pre-Commit-2 45-minute transition window is cleared server-side
// and its DB row (if any) deleted. Once every live cookie has expired
// (45 minutes after deploy), even this helper becomes a no-op and the
// `OnboardingSession` DB model can be dropped in a follow-up commit.

const COOKIE_NAME = "bis_reg_session";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function endOnboardingSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (token) {
    await prisma.onboardingSession
      .deleteMany({ where: { tokenHash: hashToken(token) } })
      .catch(() => undefined);
  }
  jar.delete(COOKIE_NAME);
}
