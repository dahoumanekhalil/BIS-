"use client";

import { useState, useTransition } from "react";
import { cn } from "@/lib/utils";
import {
  grantRoomAccessAction,
  revokeRoomAccessAction
} from "./access-actions";
import type { AccessPointType } from "@prisma/client";

// Admin access matrix. One row per AccessPoint the venue currently exposes.
// Each row shows the current state and (if `canManage`) offers a Grant or
// Revoke action. The tri-state ({granted, denied, unassigned}) is the one
// defined by lib/account/access-state.ts and enforced by
// scripts/access-semantics.test.ts.
//
// Both actions require `access.manage` server-side and validate the target
// resolves to a real Participant — the admin UI is gated for UX only.

type Point = {
  id: string;
  slug: string;
  name: string;
  type: AccessPointType;
};

type Permission = { accessPointId: string; granted: boolean };

type State = "granted" | "denied" | "unassigned";

function stateFor(perms: readonly Permission[], id: string): State {
  const row = perms.find((p) => p.accessPointId === id);
  if (!row) return "unassigned";
  return row.granted ? "granted" : "denied";
}

const STATE_LABEL: Record<State, string> = {
  granted: "Autorisé",
  denied: "Refusé",
  unassigned: "Non attribué"
};

const STATE_CLASS: Record<State, string> = {
  granted: "bg-lime/25 text-ink",
  denied: "bg-red-100 text-red-800",
  unassigned: "bg-ink/10 text-ink/60"
};

export function AccessMatrix({
  participantId,
  accessPoints,
  permissions,
  canManage
}: {
  participantId: string;
  accessPoints: readonly Point[];
  permissions: readonly Permission[];
  canManage: boolean;
}) {
  return (
    <section className="rounded-card border border-line bg-white p-6">
      <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
        Matrice d&apos;accès
      </p>
      <p className="mt-2 text-[12px] leading-relaxed text-ink/55">
        Chaque salle est un contrôle d&apos;accès indépendant. L&apos;entrée
        principale suit les règles de l&apos;inscription — la validation QR
        au scanner reste soumise à l&apos;éligibilité (paiement, statut).
      </p>

      <ul className="mt-5 divide-y divide-line/70 rounded-lg border border-line/70 bg-frost/40">
        {accessPoints.map((ap) => {
          const s = stateFor(permissions, ap.id);
          return (
            <AccessRow
              key={ap.slug}
              participantId={participantId}
              point={ap}
              state={s}
              canManage={canManage}
            />
          );
        })}
      </ul>
    </section>
  );
}

function AccessRow({
  participantId,
  point,
  state,
  canManage
}: {
  participantId: string;
  point: Point;
  state: State;
  canManage: boolean;
}) {
  const [pending, startTransition] = useTransition();
  // Per-row error surface. Server-side rejections (missing permission on a
  // crafted POST, unknown/inactive AccessPoint, non-Participant target,
  // Zod parse failure) need to be visible — a silent catch here made a
  // denied action look identical to a successful one, and combined with
  // the previous revalidatePath bug an admin could re-run destructive
  // work thinking it hadn't taken.
  const [error, setError] = useState<string | null>(null);

  const run = (kind: "grant" | "revoke") =>
    startTransition(async () => {
      setError(null);
      try {
        if (kind === "grant") {
          await grantRoomAccessAction(participantId, point.id);
        } else {
          await revokeRoomAccessAction(participantId, point.id);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Action refusée.");
      }
    });

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-[13.5px] font-semibold text-ink">{point.name}</p>
          <p className="mt-0.5 text-[10.5px] uppercase tracking-[0.16em] text-ink/45">
            {point.type === "MAIN_ENTRANCE" ? "Entrée du sommet" : "Salle"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2 py-[3px] text-[9.5px] font-bold uppercase tracking-[0.16em]",
              STATE_CLASS[state]
            )}
          >
            {STATE_LABEL[state]}
          </span>
          {canManage &&
            (state === "granted" ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => run("revoke")}
                className="inline-flex items-center rounded-btn border border-red-300 bg-red-50 px-2 py-1 text-[11px] font-bold text-red-800 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Révoquer
              </button>
            ) : (
              <button
                type="button"
                disabled={pending}
                onClick={() => run("grant")}
                className="inline-flex items-center rounded-btn border border-cobalt bg-cobalt/10 px-2 py-1 text-[11px] font-bold text-cobalt transition-colors hover:bg-cobalt hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                Attribuer
              </button>
            ))}
        </div>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-amber-300/60 bg-amber-50 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-amber-900"
        >
          {error}
        </p>
      )}
    </li>
  );
}
