import {
  AdminRole,
  RegistrationStatus,
  RegistrationTier
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin/auth";
import { canWithOverrides } from "@/lib/admin/rbac";
import { audit } from "@/lib/admin/audit";
import { toCsv } from "@/lib/admin/csv";
import {
  listRegistrantsForExport,
  MAX_REGISTRANT_EXPORT_ROWS,
  type RegistrantFilters
} from "@/lib/admin/queries";

export const dynamic = "force-dynamic";

// `id` is intentionally not exported: the legacy manual check-in accepts a
// Participant id as a credential, so a leaked CSV would be a credential dump.
const HEADERS = [
  "Code billet",
  "Prénom",
  "Nom",
  "Email",
  "Téléphone",
  "Pays",
  "Organisation",
  "Poste",
  "Type d'inscription",
  "Profil",
  "Choix de participation",
  "Secteur",
  "Site web",
  "Taille entreprise",
  "Tier",
  "Statut",
  "Gate",
  "Check-in (date)",
  "Check-in (gate)",
  "Inscrit le"
] as const;

function parseFilters(url: URL): RegistrantFilters {
  const sp = url.searchParams;
  const tier = sp.get("tier");
  const status = sp.get("status");
  const gate = (sp.get("gate") ?? "").trim().slice(0, 64);
  const q = (sp.get("q") ?? "").trim().slice(0, 200);
  return {
    q: q || undefined,
    tier: Object.values(RegistrationTier).includes(tier as RegistrationTier)
      ? (tier as RegistrationTier)
      : "ALL",
    status: Object.values(RegistrationStatus).includes(
      status as RegistrationStatus
    )
      ? (status as RegistrationStatus)
      : "ALL",
    gate: gate || "ALL"
  };
}

function plain(status: number, body: string) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

export async function GET(request: Request) {
  // Auth first (redirects to /admin/login when there is no valid session).
  const { user } = await requireAdmin();

  // SUPER_ADMIN only. The role check is hard-coded on purpose: a
  // RolePermissionOverride can revoke this permission from SUPER_ADMIN but can
  // never grant it to another role.
  const allowed =
    user.role === AdminRole.SUPER_ADMIN &&
    (await canWithOverrides(user.role, "registrants.export.csv"));
  if (!allowed) {
    await audit({
      userId: user.id,
      action: "registrants.export.csv.denied",
      entity: "Participant",
      meta: { role: user.role }
    });
    return plain(403, "Forbidden");
  }

  // Refuse cross-site navigations (SameSite=Lax still sends the cookie on
  // top-level GETs). Same-origin clicks and direct address-bar use pass.
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return plain(403, "Forbidden");
  }

  const url = new URL(request.url);
  const filters = parseFilters(url);
  const { rows, truncated } = await listRegistrantsForExport(filters);

  const csv = toCsv(
    HEADERS,
    rows.map((r) => [
      r.ticketCode,
      r.firstName,
      r.lastName,
      r.email,
      r.phone,
      r.country,
      r.organization,
      r.jobTitle,
      r.registrationType,
      r.profile,
      r.participationChoice,
      r.companyIndustry,
      r.companyWebsite,
      r.companySize,
      r.tier,
      r.status,
      r.gate,
      r.checkedInAt,
      r.checkedInGate,
      r.createdAt
    ])
  );

  // Fail closed: audit() swallows write errors, which would let a PII export
  // succeed with no record. Write the row directly and refuse to return data
  // if it cannot be recorded.
  try {
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "registrants.export.csv",
        entity: "Participant",
        meta: {
          rowCount: rows.length,
          truncated,
          // Never store the search text itself (it may contain an email).
          filters: {
            tier: filters.tier,
            status: filters.status,
            gate: filters.gate,
            hasQuery: Boolean(filters.q)
          }
        }
      }
    });
  } catch {
    return plain(500, "Export refused: audit log unavailable.");
  }

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="registrants-${stamp}.csv"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(truncated
        ? {
            "X-Export-Truncated": `true; limit=${MAX_REGISTRANT_EXPORT_ROWS}`
          }
        : {})
    }
  });
}
