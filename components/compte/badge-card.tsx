import { cn } from "@/lib/utils";
import { StatusPill } from "./status-pill";
import {
  BADGE_STATUS_LABEL,
  BADGE_STATUS_TONE,
  PARTICIPATION_LABEL
} from "@/lib/account/labels";
import type { BadgeStatus, ParticipationChoice } from "@prisma/client";

// The physical neck-badge visual — designed to hold either an initials disc
// (no QR yet) OR a QR image inside a reserved square slot. Fixed proportions
// (portrait 3 : 4) so it feels credential-like on every viewport and prints
// consistently onto A6/A7 stock. NO photo field — initials treatment only
// per Phase 5 spec; a real photo upload is a future phase.
//
// SECURITY: this component only receives already-labelled, safe strings —
// no participant id, no credential id, no ticket code, no token. The `qr`
// prop is either null or a PNG data URL produced by lib/badge/qr.ts. The
// caller is responsible for the eligibility gate.
export function BadgeCard({
  firstName,
  lastName,
  participationChoice,
  organization,
  jobTitle,
  badgeStatus,
  qr,
  className,
  compact = false
}: {
  firstName: string;
  lastName: string;
  participationChoice: ParticipationChoice | null;
  organization: string | null;
  jobTitle: string | null;
  badgeStatus: BadgeStatus | null;
  // PNG data URL, or null if no QR has been generated for this render.
  qr: string | null;
  className?: string;
  // `compact` shrinks paddings for embedded contexts (dashboard preview).
  compact?: boolean;
}) {
  const initials =
    `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase() || "?";
  const participationLabel = participationChoice
    ? PARTICIPATION_LABEL[participationChoice]
    : "Participant";
  const organizationLine =
    [organization, jobTitle].filter(Boolean).join(" · ") || null;

  return (
    <article
      className={cn(
        // Phase 12 — mobile-first proportions.
        //
        // On mobile: fill up to 420px (bigger QR at arm's length under
        // venue lighting) and drop the strict 3:4 aspect ratio so the QR
        // can dominate the first fold. The card is a "phone-native
        // credential" first, a physical neck-badge second.
        //
        // On sm+ (tablet / desktop / print): re-lock to 340px and 3:4
        // so the print layout and the desktop preview stay credential-
        // shaped. Print CSS in globals.css already constrains
        // `.print-badge` to 90mm — printed paper is unchanged.
        "print-badge relative isolate mx-auto flex w-full max-w-[420px] flex-col overflow-hidden rounded-[26px] bg-white text-ink shadow-[0_30px_80px_-40px_rgba(15,25,60,0.35),inset_0_0_0_1px_rgba(15,25,60,0.06)]",
        "sm:aspect-[3/4] sm:max-w-[340px]",
        className
      )}
      aria-label={`Badge BIS 2026 — ${firstName} ${lastName}`}
    >
      {/* Cobalt header band — brand and event context. */}
      <header className="relative flex items-center justify-between bg-cobalt px-5 pb-3 pt-4 text-white sm:px-6 sm:pt-5">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 grid-lines-dark opacity-[0.08]"
        />
        <div className="relative">
          <p className="font-display text-[22px] font-black leading-none tracking-tight">
            BIS<span className="text-lime">+</span>
          </p>
          <p className="mt-1 text-[8.5px] font-bold uppercase leading-tight tracking-[0.22em] text-white/80">
            Algeria Brand Impact
            <br />
            Summit 2026
          </p>
        </div>
        <div className="relative text-right">
          <p className="text-[9px] font-bold uppercase leading-tight tracking-[0.2em] text-white/70">
            15 Novembre 2026
          </p>
          <p className="mt-0.5 text-[9px] font-bold uppercase leading-tight tracking-[0.2em] text-lime">
            CIC Alger
          </p>
        </div>
      </header>

      {/* Lime accent line — separator between brand band and body. */}
      <div aria-hidden className="h-[3px] w-full bg-lime" />

      {/* Body — identity + QR slot. */}
      <div
        className={cn(
          "relative flex flex-1 flex-col justify-between bg-white",
          compact ? "gap-3 p-4" : "gap-4 p-5 sm:p-6"
        )}
      >
        <div className="flex items-start gap-4">
          <span
            aria-hidden
            className="flex h-14 w-14 flex-none items-center justify-center rounded-full bg-cobalt text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08),0_10px_30px_-16px_rgba(36,83,224,0.55)]"
          >
            <span className="font-display text-[18px] font-black tracking-tight">
              {initials}
            </span>
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[9px] font-bold uppercase tracking-[0.22em] text-ink/45">
              {participationLabel}
            </p>
            <p
              className={cn(
                "mt-1 font-display font-black leading-tight tracking-tight text-ink",
                compact ? "text-[15px]" : "text-[17px]"
              )}
            >
              {firstName} {lastName}
            </p>
            {organizationLine && (
              <p className="mt-1 truncate text-[11px] leading-tight text-ink/60">
                {organizationLine}
              </p>
            )}
          </div>
        </div>

        {/* QR slot — reserved even when no QR has been generated so the
            layout does not jump between states.
            Phase 12: enlarged on mobile (up to 300px) so an operator
            can scan it from arm's length without the attendee needing
            to bring the phone within 10 cm. Shrinks back to 200px at
            sm+ to preserve the desktop / print aspect ratio. */}
        <div className="flex flex-1 items-center justify-center">
          <div
            className={cn(
              "flex aspect-square w-full max-w-[300px] items-center justify-center overflow-hidden rounded-2xl border bg-white sm:max-w-[200px]",
              qr ? "border-line/70" : "border-dashed border-line"
            )}
          >
            {qr ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qr}
                alt="Code QR — credential BIS 2026"
                className="h-full w-full object-contain"
                draggable={false}
              />
            ) : (
              <div className="px-4 text-center text-[10.5px] font-medium uppercase tracking-[0.18em] text-ink/40">
                QR non affiché
              </div>
            )}
          </div>
        </div>

        {/* Footer — status pill. */}
        <div className="flex items-center justify-between gap-3 border-t border-line/60 pt-3 text-[10px] uppercase tracking-[0.16em] text-ink/50">
          <span className="font-semibold">B.I.S+ · 2026</span>
          {badgeStatus ? (
            <StatusPill
              size="sm"
              tone={BADGE_STATUS_TONE[badgeStatus]}
              label={BADGE_STATUS_LABEL[badgeStatus]}
            />
          ) : (
            <StatusPill size="sm" tone="muted" label="Badge non émis" />
          )}
        </div>
      </div>
    </article>
  );
}
