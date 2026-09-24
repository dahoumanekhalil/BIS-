import Link from "next/link";
import { requireAccount } from "@/lib/account/auth";
import { getCompteContext } from "@/lib/account/participant";
import { CompteCard } from "@/components/compte/card";
import { BadgeQrClient } from "@/components/compte/badge-qr-client";
import { ensureCheckinCode } from "@/lib/badge/checkin-code";
import { RegistrationStatus } from "@prisma/client";

export const metadata = { title: "Mon badge" };

// Attendee-facing badge page. This route DOES NOT trigger any credential
// mutation on load — pure read of participant state. The QR itself only
// appears after an explicit user click on the client component, which POSTs
// to the server action `generateOrRotateMyBadge()`.
//
// Eligibility gate (mirrored server-side inside the action for defence in
// depth):
//   • participant must exist for this AccountUser
//   • participant.status must not be CANCELLED
//
// Payment is NOT a prerequisite for badge issuance — see
// docs/registration-architecture.md §Badge / QR.
export default async function CompteBadgePage() {
  const account = await requireAccount();
  const { participant } = await getCompteContext(account);

  if (!participant) {
    return (
      <div className="mx-auto max-w-2xl print-hide">
        <CompteCard title="Badge indisponible">
          <p className="text-[14px] leading-relaxed text-ink/70">
            Complétez d&apos;abord votre inscription pour obtenir un badge.
          </p>
          <div className="mt-6">
            <Link href="/register" className="btn-lime">
              Compléter mon inscription
            </Link>
          </div>
        </CompteCard>
      </div>
    );
  }

  const badge = participant.credentials[0] ?? null;

  if (participant.status === RegistrationStatus.CANCELLED) {
    // Cancelled registrations are the only reason to refuse badge issuance.
    // The server action mirrors this refusal for defence in depth.
    return (
      <div className="mx-auto max-w-2xl print-hide">
        <CompteCard
          eyebrow="Badge indisponible"
          title="Votre inscription a été annulée"
        >
          <p className="text-[14px] leading-relaxed text-ink/70">
            Contactez l&apos;équipe BIS si vous pensez qu&apos;il s&apos;agit
            d&apos;une erreur.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/compte/inscription" className="btn-ghost">
              Voir mon inscription
            </Link>
            <Link href="/contact" className="btn-ghost">
              Contacter l&apos;équipe
            </Link>
          </div>
        </CompteCard>
      </div>
    );
  }

  // Phase 19 — ensure the participant has a secure human-readable
  // check-in code assigned. `ensureCheckinCode` is idempotent + atomic:
  //   • returns the existing code if already assigned,
  //   • otherwise generates a fresh cryptographically random one and
  //     stores it via an updateMany atomic-claim (Phase 10 B3 pattern)
  //     so two concurrent /compte/badge loads cannot overwrite each
  //     other's code.
  // The code lives on the participant row (public-safe surface) and
  // is displayed on the badge front. NEVER logged, never in URLs,
  // never in AuditLog metadata.
  const checkinCode = await ensureCheckinCode(participant.id);

  return (
    <BadgeQrClient
      identity={{
        firstName: participant.firstName,
        lastName: participant.lastName,
        participationChoice: participant.participationChoice,
        organization: participant.organization,
        jobTitle: participant.jobTitle,
        badgeStatus: badge?.status ?? null,
        // Phase 18 — role variant is derived from tier + participation
        // by lib/badge/role.ts:resolveBadgeRole. Adding `tier` here
        // is a whitelist-safe pass-through; the value comes from
        // getParticipantForAccount's already-authorised select.
        tier: participant.tier ?? null,
        // Phase 19 — the code just assigned / re-fetched above.
        checkinCode
      }}
      hasActiveCredential={badge !== null}
    />
  );
}
