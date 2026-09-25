import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/admin/auth";
import { can } from "@/lib/admin/rbac";
import {
  getRegistrant,
  getRegistrantAccessContext,
  getRegistrantRoomRegistrations
} from "@/lib/admin/queries";
import { AdminHeader } from "@/components/admin/header";
import { StatusBadge, TierBadge } from "@/components/admin/ui";
import { DeleteRegistrantButton } from "./delete-button";
import { BadgePanel } from "./badge-panel";
import { AccessMatrix } from "./access-matrix";
import { RoomRegistrationsPanel } from "./room-registrations-panel";

export const dynamic = "force-dynamic";

export default async function RegistrantDetail({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { user } = await requirePermission("registrants.view");
  const { id } = await params;
  const r = await getRegistrant(id);
  if (!r) notFound();

  const mayEdit = can(user.role, "registrants.edit");
  const mayDelete = can(user.role, "registrants.delete");
  const mayEmail = can(user.role, "registrants.email");
  const mayViewLogs = can(user.role, "audit.view");
  // Phase 7 — badge + access-matrix visibility gating. `access.view` is the
  // read gate for the matrix; `access.manage` gates the per-row Grant/Revoke
  // buttons. `badge.manage` gates the Rotate/Revoke actions on the badge
  // panel. Server actions re-check the permission — this is UX gating only.
  const mayViewAccess = can(user.role, "access.view");
  const mayManageAccess = can(user.role, "access.manage");
  const mayManageBadge = can(user.role, "badge.manage");
  const mayCancelRoomRegistration = can(user.role, "access.manage");
  const [accessCtx, roomRegistrations] = await Promise.all([
    mayViewAccess ? getRegistrantAccessContext(id) : Promise.resolve(null),
    mayViewAccess
      ? getRegistrantRoomRegistrations(id)
      : Promise.resolve([])
  ]);

  const dt = (d: Date | null | undefined) =>
    d
      ? new Intl.DateTimeFormat("fr-FR", {
          day: "2-digit",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        }).format(d)
      : "—";

  return (
    <>
      <AdminHeader
        user={user}
        title={`${r.firstName} ${r.lastName}`}
        subtitle="Registrant · Détail"
      />

      <div className="space-y-6 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            href="/admin/registrants"
            className="inline-flex items-center gap-1 text-[12px] font-semibold text-ink/60 hover:text-ink"
          >
            ← Retour aux inscrits
          </Link>

          {(mayEdit || mayDelete || mayEmail || mayViewLogs) && (
            <div className="flex items-center gap-2">
              {r.phone && (
                <a
                  href={`tel:${r.phone.replace(/\s+/g, "")}`}
                  className="inline-flex items-center gap-1.5 rounded-btn border border-lime bg-lime/25 px-3 py-1.5 text-[12px] font-bold text-ink transition-colors hover:bg-lime"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M22 16.92v3a2 2 0 01-2.18 2 19.86 19.86 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.86 19.86 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.13.96.37 1.9.72 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0122 16.92z" />
                  </svg>
                  Appeler
                </a>
              )}
              {mayViewLogs && (
                <Link
                  href={`/admin/registrants/${id}/logs`}
                  className="inline-flex items-center gap-1.5 rounded-btn border border-ink/15 bg-white px-3 py-1.5 text-[12px] font-bold text-ink transition-colors hover:border-cobalt hover:text-cobalt"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
                  </svg>
                  Journal
                </Link>
              )}
              {mayEmail && (
                <Link
                  href={`/admin/registrants/${id}/email`}
                  className="inline-flex items-center gap-1.5 rounded-btn border border-ink/15 bg-white px-3 py-1.5 text-[12px] font-bold text-ink transition-colors hover:border-cobalt hover:text-cobalt"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                    <path d="M22 6l-10 7L2 6" />
                  </svg>
                  Écrire
                </Link>
              )}
              {mayEdit && (
                <Link
                  href={`/admin/registrants/${id}/edit`}
                  className="inline-flex items-center gap-1.5 rounded-btn border border-cobalt bg-cobalt/10 px-3 py-1.5 text-[12px] font-bold text-cobalt transition-colors hover:bg-cobalt hover:text-white"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M17 3l4 4L7 21H3v-4L17 3z" />
                  </svg>
                  Modifier
                </Link>
              )}
              {mayDelete && (
                <DeleteRegistrantButton
                  id={id}
                  name={`${r.firstName} ${r.lastName}`}
                />
              )}
            </div>
          )}
        </div>

        <div className="grid gap-6 lg:grid-cols-12">
          {/* Identity */}
          <section className="rounded-card border border-line bg-white p-6 lg:col-span-8">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-2xl font-black tracking-tight text-ink">
                  {r.firstName} {r.lastName}
                </h2>
                <p className="mt-1 text-[13.5px] text-ink/60">
                  {r.jobTitle}
                  {r.organization && r.jobTitle && " · "}
                  {r.organization}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <TierBadge tier={r.tier} />
                <StatusBadge status={r.status} />
              </div>
            </div>

            <dl className="mt-6 grid gap-4 sm:grid-cols-2">
              <Row label="Email" value={r.email} link={`mailto:${r.email}`} />
              <Row
                label="Téléphone"
                value={r.phone ?? "—"}
                link={r.phone ? `tel:${r.phone}` : undefined}
              />
              <Row label="Pays" value={r.country} />
              <Row label="Type" value={r.registrationType} />
              <Row label="Inscription" value={dt(r.createdAt)} />
              <Row label="Dernière MAJ" value={dt(r.updatedAt)} />
            </dl>
          </section>

          {/* Ticket */}
          <section className="rounded-card border border-line bg-white p-6 lg:col-span-4">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
              Ticket · Gate
            </p>
            <p className="mt-3 font-display text-2xl font-black tracking-tight tabular-nums text-ink">
              {r.ticketCode ?? "—"}
            </p>
            <p className="mt-1 text-[12px] text-ink/50">
              Utilisé par le check-in center (flux manuel legacy).
            </p>
            {/* Phase 19 — secure text check-in code (QR fallback). */}
            <div className="mt-4 rounded-lg border border-cobalt/25 bg-cobalt/[0.03] p-3">
              <p className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-cobalt">
                Code d&apos;accès (QR fallback)
              </p>
              <p className="mt-1 font-mono text-[15px] font-black tracking-[0.14em] text-ink">
                {r.checkinCode ?? "—"}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-ink/55">
                Saisissable manuellement au scanner quand le QR ne
                fonctionne pas. Format à 12 caractères + tirets.
              </p>
            </div>
            <div className="mt-5 space-y-2 text-[13px]">
              <div className="flex items-center justify-between">
                <span className="text-ink/55">Gate assigné</span>
                <span className="font-semibold text-ink">{r.gate ?? "—"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink/55">Statut check-in</span>
                <span className="font-semibold text-ink">
                  {r.checkedInAt
                    ? `${r.checkedInGate ?? r.gate ?? "—"} · ${dt(r.checkedInAt)}`
                    : "Pas encore"}
                </span>
              </div>
            </div>
          </section>

          {/* Statut inscription */}
          <section className="rounded-card border border-line bg-white p-6 lg:col-span-8">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
              Statut inscription
            </p>
            <dl className="mt-6 grid gap-4 sm:grid-cols-2">
              <Row label="Statut inscription" value={r.status} />
            </dl>
          </section>

          {/* Actions rapides */}
          <section className="rounded-card border border-line bg-white p-6 lg:col-span-4">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
              Actions rapides
            </p>
            <ul className="mt-4 space-y-2 text-[13px] text-ink/70">
              {mayEdit && (
                <li>
                  <Link
                    href={`/admin/registrants/${id}/edit`}
                    className="hover:text-ink"
                  >
                    → Modifier toutes les informations
                  </Link>
                </li>
              )}
              {mayEmail && (
                <li>
                  <Link
                    href={`/admin/registrants/${id}/email`}
                    className="hover:text-ink"
                  >
                    → Écrire un email (modèles disponibles)
                  </Link>
                </li>
              )}
              {mayViewLogs && (
                <li>
                  <Link
                    href={`/admin/registrants/${id}/logs`}
                    className="hover:text-ink"
                  >
                    → Voir l&apos;historique d&apos;activité
                  </Link>
                </li>
              )}
              <li>
                <a
                  href={`mailto:${r.email}`}
                  className="hover:text-ink"
                >
                  → Ouvrir dans mon client mail
                </a>
              </li>
              <li>
                <Link
                  href="/admin/check-in"
                  className="hover:text-ink"
                >
                  → Ouvrir le check-in center
                </Link>
              </li>
              {mayDelete && (
                <li className="text-red-700">
                  → Utilisez « Supprimer » en haut de page
                </li>
              )}
            </ul>
          </section>
        </div>

        {/* Phase 7 — Badge + Access Matrix (visible only to holders of
            access.view / badge.manage; each server action re-checks the
            required permission independently). */}
        {mayViewAccess && accessCtx && (
          <div className="grid gap-6 lg:grid-cols-2">
            <BadgePanel
              participantId={id}
              activeCredential={accessCtx.activeCredential}
              canManage={mayManageBadge}
            />
            <AccessMatrix
              participantId={id}
              accessPoints={accessCtx.accessPoints}
              permissions={accessCtx.permissions}
              canManage={mayManageAccess}
            />
          </div>
        )}

        {/* Room registrations panel. Read gated by access.view; per-row
            cancel button re-checks access.manage on the server side. */}
        {mayViewAccess && (
          <RoomRegistrationsPanel
            participantId={id}
            registrations={roomRegistrations}
            canCancelRegistration={mayCancelRoomRegistration}
          />
        )}

        {/* Phase 16 — Historique des accès.
            Reads CheckIn (the canonical event log) joined to AccessPoint
            for a human-readable name. Legacy rows with
            accessPointId=null still render safely via the joined
            fallback below. `ParticipantAccess` is a PERMISSION model
            and is NEVER shown as history — that split is documented in
            the Pre-Phase-14 audit. */}
        <section className="rounded-card border border-line bg-white p-6">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
            Historique des accès
          </p>
          {r.checkIns.length === 0 ? (
            <p className="mt-4 text-[13px] text-ink/55">
              Aucun scan enregistré pour ce participant.
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-line">
              {r.checkIns.map((c) => {
                const pointLabel = c.accessPoint
                  ? c.accessPoint.name
                  : c.gate || "Point non répertorié";
                const typeLabel = c.accessPoint
                  ? c.accessPoint.type === "MAIN_ENTRANCE"
                    ? "Entrée principale"
                    : "Salle"
                  : null;
                return (
                  <li
                    key={c.id}
                    className="flex items-center justify-between gap-3 py-2.5 text-[13px]"
                  >
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 font-semibold text-ink">
                        <span>{pointLabel}</span>
                        {typeLabel && (
                          <span className="rounded-full bg-ink/5 px-2 py-[1px] text-[9.5px] font-bold uppercase tracking-[0.16em] text-ink/60">
                            {typeLabel}
                          </span>
                        )}
                        <StatusBadge status={c.result} />
                      </p>
                      <p className="mt-0.5 text-[11.5px] text-ink/55">
                        {dt(c.scannedAt)}
                        {c.operator && ` · par ${c.operator.name}`}
                      </p>
                    </div>
                    {c.reason && (
                      <span className="text-[12px] text-ink/60">{c.reason}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

function Row({
  label,
  value,
  link
}: {
  label: string;
  value: string;
  link?: string;
}) {
  const content = (
    <p className="mt-1 font-semibold text-ink">{value}</p>
  );
  return (
    <div>
      <dt className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
        {label}
      </dt>
      <dd>{link ? <a href={link} className="hover:underline">{content}</a> : content}</dd>
    </div>
  );
}
