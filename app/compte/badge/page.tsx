import Link from "next/link";
import { headers } from "next/headers";
import { requireAccount } from "@/lib/account/auth";
import { getCompteContext } from "@/lib/account/participant";
import { CompteCard } from "@/components/compte/card";
import {
  BadgeQrClient,
  type BadgeUnavailableReason
} from "@/components/compte/badge-qr-client";
import { getCurrentBadgeToken } from "@/lib/badge";
import { renderBadgeQrDataUrl } from "@/lib/badge/qr";
import { ensureActiveBadge } from "@/lib/register/participant";
import { ensureCheckinCode } from "@/lib/badge/checkin-code";
import { isAccountEmailVerified } from "@/lib/account/email-verification";
import { OfflineSnapshotSync } from "@/components/mobile/offline-snapshot-sync";
import { offlineAccountKey } from "@/lib/mobile/account-key";
import { resolveBadgeRole, BADGE_ROLE_LABEL } from "@/lib/badge/role";
import {
  PARTICIPATION_LABEL,
  REGISTRATION_STATUS_LABEL
} from "@/lib/account/labels";
import { RegistrationStatus } from "@prisma/client";

export const metadata = { title: "Mon badge" };

// Attendee-facing badge page — VIEW ONLY.
//
// The participant has ONE persistent QR. This page re-derives it on the
// server from the current credential and renders it as an image: opening,
// refreshing, another browser or another session always shows the SAME QR.
// There is no server action here and nothing that can rotate, replace or
// revoke a credential. Only an administrator can regenerate (see
// regenerateBadgeAsAdminAction).
//
// The only write on this route is FIRST issuance for a participant who has
// never had any credential (ensureActiveBadge refuses when any history
// exists, so it can never undo an admin revoke or replace a credential).
//
// Eligibility: participant must exist and must not be CANCELLED. Payment is
// NOT a prerequisite — see docs/registration-architecture.md §Badge / QR.
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

  // The QR is issued automatically once the email is verified. Until then
  // there is nothing to show (the banner above offers to re-send the link).
  if (!(await isAccountEmailVerified(account.id))) {
    return (
      <div className="mx-auto max-w-2xl print-hide">
        <CompteCard
          eyebrow="Badge en attente"
          title="Confirmez votre email pour recevoir votre QR"
        >
          <p className="text-[14px] leading-relaxed text-ink/70">
            Votre QR code d&apos;accès sera généré automatiquement dès que
            votre adresse email sera confirmée. Utilisez le bouton « Renvoyer
            le lien de confirmation » en haut de la page si vous n&apos;avez
            pas reçu l&apos;email.
          </p>
        </CompteCard>
      </div>
    );
  }

  // First issuance only (no-op when any credential history exists).
  await ensureActiveBadge(participant.id);

  // The mobile app identifies itself in the User-Agent (BISApp/…). Only then
  // is the owner's own raw token handed to the page, so the app can keep an
  // offline copy in the OS secure storage. Browsers never receive it.
  const inApp = ((await headers()).get("user-agent") ?? "").includes("BISApp/");
  let appToken: string | null = null;
  let qrDataUrl: string | null = null;
  let unavailableReason: BadgeUnavailableReason | null = null;
  try {
    const current = await getCurrentBadgeToken(participant.id);
    if (current.ok) {
      // The token exists only inside the QR image pixels sent to the
      // browser; it is never passed as a string and never logged.
      qrDataUrl = await renderBadgeQrDataUrl(current.rawToken);
      if (inApp) appToken = current.rawToken;
    } else {
      unavailableReason = current.reason;
    }
  } catch (err) {
    // Log the error CODE only — never a token, hash or secret.
    // eslint-disable-next-line no-console
    console.error(
      "[compte/badge] QR unavailable:",
      err instanceof Error ? err.name + ":" + err.message : "unknown"
    );
    unavailableReason = "ERROR";
  }

  // Idempotent: returns the existing code, assigns one only if missing.
  const checkinCode = await ensureCheckinCode(participant.id);

  const roleLabel =
    BADGE_ROLE_LABEL[
      resolveBadgeRole({
        tier: participant.tier ?? null,
        participationChoice: participant.participationChoice
      })
    ];

  return (
    <>
    <BadgeQrClient
      identity={{
        firstName: participant.firstName,
        lastName: participant.lastName,
        participationChoice: participant.participationChoice,
        organization: participant.organization,
        jobTitle: participant.jobTitle,
        badgeStatus: badge?.status ?? null,
        tier: participant.tier ?? null,
        checkinCode
      }}
      qrDataUrl={qrDataUrl}
      unavailableReason={unavailableReason}
    />
    {qrDataUrl && (
      // Offline copy of THIS participant's own badge (device-local, cleared
      // at logout / after 14 days). Only rendered with a valid, current QR.
      <div className="mx-auto mt-6 max-w-md">
        <OfflineSnapshotSync
          appToken={appToken}
          data={{
            firstName: participant.firstName,
            lastName: participant.lastName,
            organization: participant.organization,
            jobTitle: participant.jobTitle,
            roleLabel,
            owner: offlineAccountKey(account.id),
            email: participant.email,
            phone: participant.phone,
            country: participant.country,
            participationLabel: participant.participationChoice
              ? PARTICIPATION_LABEL[participant.participationChoice]
              : null,
            statusLabel: REGISTRATION_STATUS_LABEL[participant.status],
            qrDataUrl,
            checkinCode
          }}
        />
      </div>
    )}
    </>
  );
}
