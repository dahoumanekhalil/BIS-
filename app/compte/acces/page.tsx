import Link from "next/link";
import { AccessPointType, AdmissionMode } from "@prisma/client";
import { requireAccount } from "@/lib/account/auth";
import {
  accessStateFor,
  getCheckInHistoryForParticipant,
  getCompteContext,
  type AccessState,
  type CheckInHistoryItem
} from "@/lib/account/participant";
import { CompteCard } from "@/components/compte/card";
import { StatusPill } from "@/components/compte/status-pill";
import { RoomRegistrationControls } from "@/components/compte/room-registration-controls";
import {
  CHECKIN_RESULT_LABEL,
  CHECKIN_RESULT_TONE,
  type StatusTone
} from "@/lib/account/labels";

export const metadata = { title: "Mes accès" };

// Access-matrix tri-state — see lib/account/access-state.ts for semantics.
const ACCESS_STATE_LABEL: Record<AccessState, string> = {
  granted: "Autorisé",
  denied: "Refusé",
  unassigned: "Non attribué"
};

const ACCESS_STATE_TONE: Record<AccessState, StatusTone> = {
  granted: "ok",
  denied: "danger",
  unassigned: "muted"
};

export default async function CompteAccesPage() {
  const account = await requireAccount();
  const { participant, accessPoints, roomRegistrations } =
    await getCompteContext(account);

  if (!participant) {
    return (
      <div className="mx-auto max-w-2xl">
        <CompteCard title="Accès non disponibles">
          <p className="text-[14px] leading-relaxed text-ink/70">
            Vos accès seront affichés ici une fois votre inscription
            confirmée.
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

  const permissions = participant.accessPermissions;

  // Split access points: MAIN_ENTRANCE remains admin-granted (tri-state
  // matrix); ROOM points get the Sub-Phase D self-service registration
  // controls. Sorting is preserved from listAccessPoints.
  const mainEntrances = accessPoints.filter(
    (ap) => ap.type === AccessPointType.MAIN_ENTRANCE
  );
  const rooms = accessPoints.filter((ap) => ap.type === AccessPointType.ROOM);

  // Index the participant's existing registrations by AccessPoint for
  // O(1) lookup as we render each room control. Deliberately keyed on
  // the *server-owned* accessPointId — no client-supplied lookup.
  const registrationByAp = new Map(
    roomRegistrations.map((r) => [r.accessPointId, r])
  );

  // Ownership: participant.id was resolved server-side from the account
  // session (see lib/account/participant.ts). The history query is scoped
  // strictly to this participant — no URL/form input is ever considered.
  const history = await getCheckInHistoryForParticipant(participant.id);

  return (
    <div className="grid gap-6">
      <CompteCard eyebrow="Vue d'ensemble" title="Mon accès BIS 2026">
        <p className="mb-6 text-[13px] leading-relaxed text-ink/65">
          L&apos;entrée principale suit les règles de votre inscription
          BIS 2026. Chaque salle du sommet dispose d&apos;un contrôle
          d&apos;accès indépendant : certaines salles sont en accès
          libre, d&apos;autres nécessitent une réservation payante.
        </p>

        {/* Main entrance(s) — read-only tri-state pill (unchanged) */}
        {mainEntrances.length > 0 && (
          <>
            <p className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
              Entrée principale
            </p>
            <ul className="divide-y divide-line/70 rounded-lg border border-line/70 bg-frost/40">
              {mainEntrances.map((ap) => {
                const state = accessStateFor(permissions, ap.id);
                return (
                  <li
                    key={ap.slug}
                    className="flex items-center justify-between gap-4 px-4 py-4"
                  >
                    <div>
                      <p className="text-[14px] font-semibold text-ink">
                        {ap.name}
                      </p>
                      <p className="mt-0.5 text-[11px] uppercase tracking-[0.16em] text-ink/45">
                        Entrée du sommet
                      </p>
                    </div>
                    <StatusPill
                      tone={ACCESS_STATE_TONE[state]}
                      label={ACCESS_STATE_LABEL[state]}
                    />
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {/* Rooms — self-service registration controls (Sub-Phase D) */}
        {rooms.length > 0 && (
          <>
            <p className="mb-2 mt-6 text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/50">
              Salles du sommet
            </p>
            <div className="grid gap-3">
              {rooms.map((ap) => {
                const registration = registrationByAp.get(ap.id) ?? null;
                // Rooms without a configured admission mode are hidden
                // from the attendee UI — the domain would refuse
                // registration on them anyway, so there is nothing
                // actionable to render.
                if (
                  ap.admissionMode !== AdmissionMode.FREE &&
                  ap.admissionMode !== AdmissionMode.PAID
                ) {
                  return null;
                }
                return (
                  <RoomRegistrationControls
                    key={ap.slug}
                    accessPointId={ap.id}
                    accessPointName={ap.name}
                    admissionMode={ap.admissionMode}
                    currentPriceMinor={ap.priceMinor}
                    currentCurrency={ap.currency}
                    registration={
                      registration
                        ? {
                            status: registration.status,
                            priceMinorSnapshot: registration.priceMinorSnapshot,
                            currencySnapshot: registration.currencySnapshot
                          }
                        : null
                    }
                  />
                );
              })}
            </div>
          </>
        )}
      </CompteCard>

      <CompteCard
        eyebrow="Historique"
        title="Passages enregistrés"
      >
        {history.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line/70 bg-frost/40 px-4 py-10 text-center">
            <p className="font-display text-[15px] font-bold text-ink">
              Aucun accès enregistré
            </p>
            <p className="mx-auto mt-2 max-w-md text-[12.5px] leading-relaxed text-ink/60">
              Cette section listera vos passages à l&apos;entrée principale
              et dans les salles dès votre premier scan sur place.
            </p>
          </div>
        ) : (
          <>
            <p className="mb-5 text-[12.5px] leading-relaxed text-ink/60">
              Vos {history.length} derniers passages, du plus récent au plus
              ancien.
            </p>
            <ul className="divide-y divide-line/70 rounded-lg border border-line/70 bg-white">
              {history.map((entry, idx) => (
                <HistoryRow
                  // scannedAt is unique enough within a single participant
                  // to key the row without exposing an internal id.
                  key={`${entry.scannedAt.toISOString()}-${idx}`}
                  entry={entry}
                />
              ))}
            </ul>
          </>
        )}
      </CompteCard>
    </div>
  );
}

// Presentation-only. `entry` is already whitelisted by the query — no
// sensitive fields flow through here.
function HistoryRow({ entry }: { entry: CheckInHistoryItem }) {
  const ap = entry.accessPoint;
  const pointName = ap?.name ?? "Point d'accès non répertorié";
  const pointKind =
    ap === null
      ? "Historique"
      : ap.type === "MAIN_ENTRANCE"
        ? "Entrée du sommet"
        : "Salle";
  return (
    <li className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-4">
        <time
          dateTime={entry.scannedAt.toISOString()}
          className="w-[86px] flex-none"
        >
          <span className="block text-[12px] font-semibold text-ink">
            {formatDate(entry.scannedAt)}
          </span>
          <span className="block text-[11px] tabular-nums text-ink/55">
            {formatTime(entry.scannedAt)}
          </span>
        </time>
        <div className="min-w-0">
          <p className="text-[13.5px] font-semibold text-ink">{pointName}</p>
          <p className="mt-0.5 text-[10.5px] uppercase tracking-[0.16em] text-ink/45">
            {pointKind}
          </p>
        </div>
      </div>
      <StatusPill
        size="sm"
        tone={CHECKIN_RESULT_TONE[entry.result]}
        label={CHECKIN_RESULT_LABEL[entry.result]}
      />
    </li>
  );
}

function formatDate(d: Date): string {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short"
  }).format(d);
}

function formatTime(d: Date): string {
  return new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(d);
}
