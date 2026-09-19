import { StatusPill } from "./status-pill";
import {
  BADGE_STATUS_LABEL,
  BADGE_STATUS_TONE,
  PARTICIPATION_LABEL
} from "@/lib/account/labels";
import type { ComptePageParticipant } from "@/lib/account/participant";

// The Cobalt identity band that sits above every /compte/* page. Not a
// hero — kept compact so tab navigation is always visible without scrolling.
export function CompteHeader({
  firstName,
  participant
}: {
  firstName: string;
  participant: ComptePageParticipant | null;
}) {
  const badge = participant?.credentials[0] ?? null;
  const participationLabel = participant?.participationChoice
    ? PARTICIPATION_LABEL[participant.participationChoice]
    : null;

  return (
    <section
      className="relative isolate overflow-hidden bg-cobalt text-white"
      aria-label="En-tête espace personnel"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 grid-lines-dark opacity-[0.06]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 top-1/2 h-[320px] w-[320px] -translate-y-1/2 rounded-full bg-lime/15 blur-3xl"
      />
      <div className="container-page relative py-8 sm:py-10">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="eyebrow-invert">
              <span className="h-px w-6 bg-white/60" /> BIS+ Espace personnel
            </p>
            <h1 className="mt-3 font-display text-[clamp(1.8rem,3.5vw,2.4rem)] font-black leading-tight tracking-tight">
              Bonjour, {firstName}.
            </h1>
            <p className="mt-2 text-[13px] leading-relaxed text-white/70 sm:text-[13.5px]">
              Votre expérience BIS 2026 — badge, accès, inscription et
              demandes en un seul endroit.
            </p>
          </div>

          {/* Compact status row — only rendered when a participant exists so
              new AccountUsers without a Participant see just the greeting. */}
          {participant && (
            <div className="flex flex-wrap items-center gap-2">
              {participationLabel && (
                <span className="inline-flex items-center rounded-full border border-white/20 bg-white/[0.08] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/85 backdrop-blur">
                  {participationLabel}
                </span>
              )}
              {badge ? (
                <StatusPill
                  tone={BADGE_STATUS_TONE[badge.status]}
                  label={BADGE_STATUS_LABEL[badge.status]}
                />
              ) : (
                <StatusPill tone="muted" label="Badge non émis" />
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
