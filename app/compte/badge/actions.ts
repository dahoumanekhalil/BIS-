"use server";

import { PaymentStatus, RegistrationStatus } from "@prisma/client";
import { requireAccount } from "@/lib/account/auth";
import { prisma } from "@/lib/db";
import { rotateBadgeCredential } from "@/lib/badge";
import { renderBadgeQrDataUrl } from "@/lib/badge/qr";
import { audit } from "@/lib/admin/audit";

// ─── Regenerate flow ─────────────────────────────────────────────────────
//
// The Phase 2 service stores only sha256(rawToken); the raw token is not
// recoverable after issuance. So every time an attendee wants to see their
// QR, we must rotate the credential to obtain a fresh raw token, embed it
// in a QR image, and return the image data URL for one-shot display.
//
// The old credential is revoked as part of the rotation — any previously
// displayed QR immediately stops verifying. This is the honest cost of the
// "no raw token at rest" security model; the UI copy warns users before
// they click.
//
// Rate limit: 10 seconds between rotations. Guards the DB against a spam
// click and gives the operator UI a stable target. The check is naïve
// (last credential timestamp) — a global attacker-scale rate limit belongs
// in Phase 13 (security review).
const MIN_ROTATION_INTERVAL_MS = 10_000;

export type BadgeGenerationResult =
  | {
      ok: true;
      // PNG data URL — safe to render via `<img src>`. The token itself is
      // present ONLY inside the QR pixels; it is never exposed as a string.
      qrDataUrl: string;
      // ISO string so it serializes cleanly across the server-action boundary.
      issuedAt: string;
    }
  | {
      ok: false;
      reason:
        | "NOT_ELIGIBLE"
        | "RATE_LIMITED"
        | "NO_PARTICIPANT"
        | "CANCELLED"
        | "UNPAID";
      message: string;
    };

export async function generateOrRotateMyBadge(): Promise<BadgeGenerationResult> {
  // Auth: the session cookie IS the identity. This action can NEVER trust a
  // client-supplied participantId — we always resolve the participant from
  // the current AccountUser session.
  const account = await requireAccount();

  const participant = await prisma.participant.findFirst({
    where: { accountUserId: account.id },
    select: {
      id: true,
      status: true,
      paymentStatus: true
    }
  });

  if (!participant) {
    return {
      ok: false,
      reason: "NO_PARTICIPANT",
      message: "Aucune inscription active liée à ce compte."
    };
  }

  if (participant.status === RegistrationStatus.CANCELLED) {
    return {
      ok: false,
      reason: "CANCELLED",
      message: "Inscription annulée — badge indisponible."
    };
  }

  if (participant.paymentStatus !== PaymentStatus.PAID) {
    return {
      ok: false,
      reason: "UNPAID",
      message:
        "Paiement non confirmé. Votre badge sera disponible une fois le règlement enregistré."
    };
  }

  // Naïve rate limit — check the most recent credential for THIS participant.
  // findFirst orderBy latest so we catch both ACTIVE and freshly revoked
  // rows from a rapid rotation loop.
  const mostRecent = await prisma.badgeCredential.findFirst({
    where: { participantId: participant.id },
    orderBy: { issuedAt: "desc" },
    select: { issuedAt: true }
  });
  if (
    mostRecent &&
    Date.now() - mostRecent.issuedAt.getTime() < MIN_ROTATION_INTERVAL_MS
  ) {
    return {
      ok: false,
      reason: "RATE_LIMITED",
      message:
        "Vous venez de générer un badge. Patientez quelques secondes avant de le régénérer."
    };
  }

  // rotate handles both cases:
  //   • no prior credential → behaves like issue(), previousCredentialId=null
  //   • ACTIVE credential exists → revokes it, creates a new ACTIVE with
  //     rotatedFromId set. Any previously-displayed QR now fails verify().
  //
  // The Phase 2 audit hook writes a `badge.rotate` AuditLog row inside the
  // service. We add a second `badge.rotate.self` row here to distinguish
  // attendee-initiated rotations from future admin-initiated ones (Phase 7).
  const { rawToken, credentialId, previousCredentialId } =
    await rotateBadgeCredential(participant.id, null, "self-service");

  const qrDataUrl = await renderBadgeQrDataUrl(rawToken);

  // Extra audit row for the attendee path so a security review can filter
  // "who rotated their own credential" from "who had it rotated by an
  // admin". Deliberately DOES NOT include the raw token or the data URL.
  await audit({
    action: "badge.rotate.self",
    entity: "Participant",
    entityId: participant.id,
    meta: {
      credentialId,
      previousCredentialId,
      accountUserId: account.id
    }
  });

  // rawToken deliberately NOT returned. The QR image already carries it in
  // visual form; we do not need to send the string separately. Reducing
  // JSON-body exposure narrows the log surface if a response body ever
  // gets captured somewhere it should not be.
  return {
    ok: true,
    qrDataUrl,
    issuedAt: new Date().toISOString()
  };
}
