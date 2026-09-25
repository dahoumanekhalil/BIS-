import "server-only";
import { prisma } from "@/lib/db";
import type { AdminUser, Prisma } from "@prisma/client";

// Payment-removal Phase 3: the `payment` client-log category is retired
// alongside the Prisma `paymentStatus / paymentAmount / paymentRef /
// paidAt` columns. Any surviving historical `payment.*` AuditLog rows
// still render via the generic AuditLog path below; the synthetic
// "Paiement confirmé" event that reads `Participant.paidAt` is deleted.
export type ClientLogCategory =
  | "account"
  | "profile"
  | "checkin"
  | "email"
  | "security";

export type ClientLogStatus = "success" | "failed" | "info" | "warn";

export type ClientLogEvent = {
  id: string;
  timestamp: Date;
  category: ClientLogCategory;
  action: string;
  title: string;
  description: string;
  status: ClientLogStatus;
  actor?: { id: string; name: string; email: string } | null;
  metadata?: Record<string, unknown>;
  source: "AuditLog" | "CheckIn" | "EmailMessage" | "Participant";
};

export type ClientLogFilters = {
  q?: string;
  category?: ClientLogCategory | "ALL";
  status?: ClientLogStatus | "ALL";
  range?: "today" | "yesterday" | "7d" | "30d" | "all";
  page?: number;
  pageSize?: number;
};

export type ClientLogSummary = {
  total: number;
  today: number;
  success: number;
  failed: number;
  security: number;
};

const CATEGORY_LABEL: Record<ClientLogCategory, string> = {
  account: "Compte",
  profile: "Profil",
  checkin: "Check-in",
  email: "Email",
  security: "Sécurité"
};

function rangeStart(range: ClientLogFilters["range"]): Date | undefined {
  if (!range || range === "all") return undefined;
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (range === "today") return start;
  if (range === "yesterday") {
    start.setDate(start.getDate() - 1);
    return start;
  }
  if (range === "7d") {
    start.setDate(start.getDate() - 7);
    return start;
  }
  if (range === "30d") {
    start.setDate(start.getDate() - 30);
    return start;
  }
  return undefined;
}

function rangeEnd(range: ClientLogFilters["range"]): Date | undefined {
  if (range !== "yesterday") return undefined;
  const now = new Date();
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  return end;
}

/**
 * Fetches every activity for the participant strictly by their id.
 * The client id in the URL is validated by the caller — here we simply
 * scope every DB query with `participantId = clientId` and never accept
 * a client-supplied WHERE fragment.
 */
export async function getClientLogs(
  clientId: string,
  filters: ClientLogFilters = {}
): Promise<{
  events: ClientLogEvent[];
  total: number;
  page: number;
  pageSize: number;
  summary: ClientLogSummary;
}> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(10, filters.pageSize ?? 25));
  const from = rangeStart(filters.range);
  const to = rangeEnd(filters.range);

  const participant = await prisma.participant.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      createdAt: true,
      updatedAt: true,
      checkedInAt: true,
      checkedInGate: true,
      tier: true,
      gate: true,
      status: true
    }
  });
  if (!participant) {
    return {
      events: [],
      total: 0,
      page,
      pageSize,
      summary: { total: 0, today: 0, success: 0, failed: 0, security: 0 }
    };
  }

  // Time window filter (Prisma-friendly).
  const timeWhere =
    from || to
      ? {
          gte: from,
          ...(to ? { lt: to } : {})
        }
      : undefined;

  // Pull bounded slices from each source. 500 rows per source is a
  // pragmatic upper bound per participant — combined with server-side
  // filters and indexes, it stays cheap.
  const [audit, checkins, emails] = await Promise.all([
    prisma.auditLog.findMany({
      where: {
        entity: "Participant",
        entityId: clientId,
        ...(timeWhere ? { createdAt: timeWhere } : {})
      },
      orderBy: { createdAt: "desc" },
      take: 500,
      include: { user: { select: { id: true, name: true, email: true } } }
    }),
    prisma.checkIn.findMany({
      where: {
        participantId: clientId,
        ...(timeWhere ? { scannedAt: timeWhere } : {})
      },
      orderBy: { scannedAt: "desc" },
      take: 500,
      include: {
        operator: { select: { id: true, name: true, email: true } }
      }
    }),
    prisma.emailMessage.findMany({
      where: {
        participantId: clientId,
        ...(timeWhere ? { createdAt: timeWhere } : {})
      },
      orderBy: { createdAt: "desc" },
      take: 500
    })
  ]);

  const senderIds = Array.from(
    new Set(emails.map((e) => e.sentByUserId).filter(Boolean))
  ) as string[];
  const senders = senderIds.length
    ? await prisma.adminUser.findMany({
        where: { id: { in: senderIds } },
        select: { id: true, name: true, email: true }
      })
    : [];
  const senderMap = new Map(senders.map((s) => [s.id, s]));

  const events: ClientLogEvent[] = [];

  /* ---------- Participant lifecycle (synthetic) ---------- */

  const inWindow = (d: Date) => {
    if (from && d < from) return false;
    if (to && d >= to) return false;
    return true;
  };

  if (inWindow(participant.createdAt)) {
    events.push({
      id: `p-created-${participant.id}`,
      timestamp: participant.createdAt,
      category: "account",
      action: "account.created",
      title: "Compte créé",
      description: `Inscription enregistrée avec l'email ${participant.email}.`,
      status: "success",
      source: "Participant"
    });
  }

  // Payment-removal Phase 3: synthetic "Paiement confirmé" event
  // deleted alongside the Participant.paidAt column drop.

  if (participant.checkedInAt && inWindow(participant.checkedInAt)) {
    events.push({
      id: `p-checkedin-${participant.id}`,
      timestamp: participant.checkedInAt,
      category: "checkin",
      action: "checkin.completed",
      title: `Entrée validée à ${participant.checkedInGate ?? "l'événement"}`,
      description: `Le·la participant·e est entré·e sur le site.`,
      status: "success",
      metadata: { gate: participant.checkedInGate },
      source: "Participant"
    });
  }

  /* ---------- Audit log ---------- */

  for (const a of audit) {
    events.push(mapAuditLog(a));
  }

  /* ---------- Check-ins ---------- */

  for (const c of checkins) {
    events.push(mapCheckIn(c));
  }

  /* ---------- Emails ---------- */

  for (const e of emails) {
    const sender = e.sentByUserId ? senderMap.get(e.sentByUserId) ?? null : null;
    events.push({
      id: `email-queue-${e.id}`,
      timestamp: e.createdAt,
      category: "email",
      action: "email.queued",
      title: "Email préparé",
      description: `« ${e.subject} »`,
      status: e.status === "FAILED" ? "failed" : "info",
      actor: sender,
      metadata: {
        emailId: e.id,
        template: e.templateKey,
        status: e.status,
        to: e.toEmail
      },
      source: "EmailMessage"
    });
    if (e.sentAt) {
      events.push({
        id: `email-sent-${e.id}`,
        timestamp: e.sentAt,
        category: "email",
        action: "email.sent",
        title: "Email envoyé",
        description: `« ${e.subject} »`,
        status: "success",
        actor: sender,
        metadata: {
          emailId: e.id,
          template: e.templateKey,
          to: e.toEmail
        },
        source: "EmailMessage"
      });
    }
  }

  /* ---------- Filter + sort + paginate ---------- */

  let filtered = events;

  if (filters.category && filters.category !== "ALL") {
    filtered = filtered.filter((e) => e.category === filters.category);
  }
  if (filters.status && filters.status !== "ALL") {
    filtered = filtered.filter((e) => e.status === filters.status);
  }
  if (filters.q) {
    const q = filters.q.toLowerCase();
    filtered = filtered.filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.action.toLowerCase().includes(q) ||
        (e.actor?.name.toLowerCase().includes(q) ?? false) ||
        (e.actor?.email.toLowerCase().includes(q) ?? false)
    );
  }

  filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  const total = filtered.length;
  const start = (page - 1) * pageSize;
  const paged = filtered.slice(start, start + pageSize);

  /* ---------- Summary metrics (from full filtered set, not just the page) ---------- */
  const today0 = new Date();
  today0.setHours(0, 0, 0, 0);
  const summary: ClientLogSummary = {
    total,
    today: filtered.filter((e) => e.timestamp >= today0).length,
    success: filtered.filter((e) => e.status === "success").length,
    failed: filtered.filter((e) => e.status === "failed").length,
    security: filtered.filter((e) => e.category === "security").length
  };

  return { events: paged, total, page, pageSize, summary };
}

/* ------------------------------ MAPPERS ------------------------------ */

function mapAuditLog(
  a: Prisma.AuditLogGetPayload<{
    include: { user: { select: { id: true; name: true; email: true } } };
  }>
): ClientLogEvent {
  const meta = (a.meta ?? undefined) as Record<string, unknown> | undefined;
  const base = {
    id: `audit-${a.id}`,
    timestamp: a.createdAt,
    actor: (a.user as AdminUser | null) as ClientLogEvent["actor"],
    metadata: meta,
    source: "AuditLog" as const
  };

  switch (a.action) {
    case "registrant.update": {
      const changes = (meta?.changes ?? {}) as Record<string, unknown>;
      const fields = Object.keys(changes);
      return {
        ...base,
        category: "profile",
        action: a.action,
        title: "Profil mis à jour",
        description:
          fields.length > 0
            ? `Champs modifiés : ${fields.join(", ")}.`
            : "Le profil a été modifié.",
        status: "success"
      };
    }
    case "registrant.delete":
      return {
        ...base,
        category: "account",
        action: a.action,
        title: "Compte supprimé",
        description: "Le compte a été supprimé définitivement.",
        status: "warn"
      };
    case "email.queue":
      // Redundant with EmailMessage-based event but kept for actor tracing.
      return {
        ...base,
        category: "email",
        action: a.action,
        title: "Email préparé",
        description:
          typeof meta?.subject === "string"
            ? `« ${meta.subject as string} »`
            : "Un message a été préparé.",
        status: "info"
      };
    case "checkin.scan":
      // Full detail exists in the CheckIn table; skip the audit dupe.
      return {
        ...base,
        category: "checkin",
        action: a.action,
        title: "Scan enregistré",
        description:
          typeof meta?.gate === "string"
            ? `Scan opéré à ${meta.gate as string}.`
            : "Un scan a été enregistré.",
        status: "info"
      };
    case "auth.login":
      return {
        ...base,
        category: "security",
        action: a.action,
        title: "Connexion admin",
        description: "Un administrateur s'est connecté à la console.",
        status: "info"
      };
    default:
      return {
        ...base,
        category: "account",
        action: a.action,
        title: humanizeAction(a.action),
        description: "Événement enregistré dans le journal d'audit.",
        status: "info"
      };
  }
}

function mapCheckIn(
  c: Prisma.CheckInGetPayload<{
    include: {
      operator: { select: { id: true; name: true; email: true } };
    };
  }>
): ClientLogEvent {
  const base = {
    id: `checkin-${c.id}`,
    timestamp: c.scannedAt,
    actor: c.operator as ClientLogEvent["actor"],
    metadata: {
      gate: c.gate,
      ticketCode: c.ticketCode,
      reason: c.reason,
      result: c.result
    },
    source: "CheckIn" as const
  };

  switch (c.result) {
    case "VALID":
      return {
        ...base,
        category: "checkin",
        action: "checkin.valid",
        title: `Check-in validé · ${c.gate}`,
        description: "Le·la participant·e est entré·e sur le site.",
        status: "success"
      };
    case "ALREADY_CHECKED_IN":
      return {
        ...base,
        category: "checkin",
        action: "checkin.duplicate",
        title: `Second scan à ${c.gate}`,
        description: "Le ticket a déjà été utilisé pour entrer.",
        status: "warn"
      };
    case "WRONG_GATE":
      return {
        ...base,
        category: "checkin",
        action: "checkin.wrong-gate",
        title: `Accès refusé · mauvaise porte`,
        description: `Scan tenté à ${c.gate}. ${c.reason ?? ""}`.trim(),
        status: "failed"
      };
    case "WRONG_TIME":
      return {
        ...base,
        category: "checkin",
        action: "checkin.wrong-time",
        title: "Accès refusé · hors créneau",
        description: c.reason ?? "Le créneau d'entrée n'est pas actif.",
        status: "failed"
      };
    case "CANCELLED":
      return {
        ...base,
        category: "checkin",
        action: "checkin.cancelled",
        title: "Accès refusé · inscription annulée",
        description: "L'inscription était annulée au moment du scan.",
        status: "failed"
      };
    case "UNKNOWN":
    default:
      return {
        ...base,
        category: "checkin",
        action: "checkin.unknown",
        title: "Scan avec ticket inconnu",
        description: c.reason ?? "Ticket introuvable.",
        status: "failed"
      };
  }
}

function humanizeAction(a: string): string {
  return a
    .split(".")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" · ");
}

export { CATEGORY_LABEL };
