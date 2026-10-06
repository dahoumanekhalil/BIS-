import "server-only";

import { prisma } from "@/lib/db";

// Self-service account erasure (required by Apple App Store guideline 5.1.1(v)
// and Google Play's account-deletion policy; also good privacy practice).
//
// WHAT HAPPENS, in ONE transaction (all or nothing):
//   • the participant record(s) of the account are DELETED — their QR
//     credentials, per-room access, room registrations and onboarding
//     sessions go with them (cascade), so the QR stops working at once;
//   • their Applications are ANONYMISED, not deleted: contact PII is wiped
//     (name, email, phone, links, message, structured details) while the
//     business record (type, status, organisation, review outcome) stays for
//     the organiser's accounting;
//   • e-mail log rows addressed to the person are ANONYMISED (recipient,
//     subject, body, html) — delivery statistics remain;
//   • check-in history is KEPT but detached from the person (participantId
//     becomes NULL by the schema; it holds only a gate, a time and a result);
//   • the AccountUser (credentials, sessions, verification / reset tokens)
//     is DELETED;
//   • one audit row records the erasure with COUNTS ONLY — no name, no email.
//
// It never touches AdminUser, other people's data, or backups (backups age out
// by the retention policy — documented in the privacy policy).

export type DeleteAccountResult = {
  participants: number;
  applications: number;
  emails: number;
};

const ANON_EMAIL = "deleted@anonymized.invalid";

export async function deleteAccountData(
  accountUserId: string
): Promise<DeleteAccountResult> {
  return prisma.$transaction(
    async (tx) => {
      const account = await tx.accountUser.findUnique({
        where: { id: accountUserId },
        select: { id: true, email: true, emailVerifiedAt: true }
      });
      if (!account) throw new Error("ACCOUNT_NOT_FOUND");

      const participants = await tx.participant.findMany({
        where: { accountUserId },
        select: { id: true, email: true }
      });
      // SECURITY: an address is only treated as THIS person's once they have
      // proven they own it (verified email). An unverified account could have
      // been registered with someone else's address; matching by address there
      // would let it erase a stranger's records. Unverified → only rows that
      // are explicitly linked to the account (participantId / accountUserId).
      // Only THE ACCOUNT'S OWN verified address counts — never an address
      // that merely appears on a linked participant row (it may have been
      // edited by staff or come from another flow). Account addresses are
      // lowercased at signup (zod), and matching below is case-insensitive.
      const verified = Boolean(account.emailVerifiedAt);
      const emails = verified ? [account.email.toLowerCase()] : [];

      // Verified owners also own unclaimed registrations made with their
      // address before they had an account (accountUserId NULL).
      if (verified && emails.length) {
        const unclaimed = await tx.participant.findMany({
          where: {
            accountUserId: null,
            email: { in: emails, mode: "insensitive" }
          },
          select: { id: true, email: true }
        });
        participants.push(...unclaimed);
      }
      const ids = participants.map((p) => p.id);

      // Applications: anonymise (keep the business record).
      // Address matches never reach a row that is explicitly linked to
      // ANOTHER person's participant (participantId must be null or ours).
      const ownOrUnlinked = [
        { participantId: null },
        ...(ids.length ? [{ participantId: { in: ids } }] : [])
      ];
      const appWhere = {
        OR: [
          ...(ids.length ? [{ participantId: { in: ids } }] : []),
          ...(emails.length
            ? [
                {
                  email: { in: emails, mode: "insensitive" as const },
                  OR: ownOrUnlinked
                }
              ]
            : [])
        ]
      };
      const apps = await tx.application.findMany({
        where: appWhere,
        select: { id: true }
      });
      for (const a of apps) {
        await tx.application.update({
          where: { id: a.id },
          data: {
            firstName: "Compte",
            lastName: "supprimé",
            email: `deleted-${a.id}@anonymized.invalid`,
            phone: "",
            position: null,
            photoUrl: null,
            logoUrl: null,
            linkedin: null,
            website: null,
            message: null,
            reviewNotes: null,
            details: {},
            participantId: null
          }
        });
      }

      // E-mail log: anonymise everything that identifies the person.
      const mails = await tx.emailMessage.updateMany({
        where: {
          OR: [
            ...(ids.length ? [{ participantId: { in: ids } }] : []),
            ...(emails.length
              ? [
                  {
                    toEmail: { in: emails, mode: "insensitive" as const },
                    OR: ownOrUnlinked
                  }
                ]
              : [])
          ]
        },
        data: {
          toEmail: ANON_EMAIL,
          toName: null,
          subject: "(supprimé)",
          body: "",
          html: null,
          errorMessage: null,
          lastError: null,
          idempotencyKey: null,
          participantId: null
        }
      });

      // Participant rows (cascades: credentials, access, room registrations,
      // onboarding sessions). CheckIn.participantId → NULL by the schema; the
      // free-text columns that could carry the person's code are blanked so the
      // kept history is genuinely anonymous (gate, time, result only).
      if (ids.length) {
        await tx.checkIn.updateMany({
          where: { participantId: { in: ids } },
          data: { ticketCode: "", reason: null }
        });
        await tx.participant.deleteMany({ where: { id: { in: ids } } });
      }

      // The account itself (sessions + verification/reset tokens cascade).
      await tx.accountUser.delete({ where: { id: accountUserId } });

      await tx.auditLog.create({
        data: {
          userId: null,
          action: "account.self-delete",
          entity: "AccountUser",
          entityId: accountUserId,
          meta: {
            participants: ids.length,
            applicationsAnonymised: apps.length,
            emailsAnonymised: mails.count
          }
        }
      });

      return {
        participants: ids.length,
        applications: apps.length,
        emails: mails.count
      };
    },
    { timeout: 30000 }
  );
}
