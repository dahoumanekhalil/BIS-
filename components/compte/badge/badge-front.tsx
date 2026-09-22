import { cn } from "@/lib/utils";
import {
  BADGE_ROLE_ACCENTS,
  BADGE_ROLE_LABEL,
  BIS_EVENT_2027,
  type BadgeRole
} from "@/lib/badge/role";

// Phase 18 — front side of the physical-credential badge.
//
// PURE PRESENTATION. This component:
//   • receives already-safe, already-labelled props — no participant
//     id, no credential id, no ticketCode, no token hash, no raw token
//   • never fetches or mutates anything
//   • uses inline style for the role accent instead of dynamic Tailwind
//     classes so PNG/PDF capture works without Tailwind's JIT surprise
//   • is used verbatim for web preview, PNG export, PDF export, and
//     print — single source of truth prevents drift
//
// Portrait 3:4 physical proportion. The wrapping preview component
// controls total dimensions.

export type BadgeFrontProps = {
  firstName: string;
  lastName: string;
  jobTitle: string | null;
  organization: string | null;
  role: BadgeRole;
  // PNG data URL for the QR image. When null, a reserved slot with a
  // subtle hint is rendered so layout does not shift. The credential
  // lifecycle that produced this data URL is UNCHANGED (Phase 5/12).
  qr: string | null;
  // Phase 19 — secure human-readable check-in code (format
  // XXXX-XXXX-XXXX). Displayed below the QR as a print-friendly
  // fallback for operators when the QR cannot be scanned. Null
  // when the participant has no code assigned yet (never happens
  // after the Phase 19 backfill + ensureCheckinCode wiring).
  checkinCode: string | null;
  className?: string;
  // If true, the badge omits animations and interactive-only cues so
  // export capture is stable.
  captureMode?: boolean;
};

export function BadgeFront({
  firstName,
  lastName,
  jobTitle,
  organization,
  role,
  qr,
  checkinCode,
  className,
  captureMode = false
}: BadgeFrontProps) {
  const accent = BADGE_ROLE_ACCENTS[role];
  const roleLabel = BADGE_ROLE_LABEL[role];

  return (
    <article
      className={cn(
        "relative isolate flex aspect-[3/4] w-full flex-col overflow-hidden rounded-[26px] bg-white text-ink",
        !captureMode &&
          "shadow-[0_30px_80px_-40px_rgba(15,25,60,0.35),inset_0_0_0_1px_rgba(15,25,60,0.06)]",
        captureMode &&
          "shadow-[inset_0_0_0_1px_rgba(15,25,60,0.10)]",
        className
      )}
      aria-label={`Badge BIS 2027 — ${firstName} ${lastName}`}
    >
      {/* Cobalt brand band. Full-bleed at the top. */}
      <header
        className="relative flex items-start justify-between bg-cobalt px-6 pb-4 pt-5 text-white"
        style={{ backgroundColor: "#2453E0" }}
      >
        {/* Subtle grid lines — decorative, low opacity. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 grid-lines-dark opacity-[0.10]"
        />
        <div className="relative">
          <p className="font-display text-[26px] font-black leading-none tracking-tight">
            BIS
            <span className="ml-0.5" style={{ color: "#B8E62E" }}>
              +
            </span>
          </p>
          <p className="mt-1 text-[8.5px] font-bold uppercase leading-tight tracking-[0.22em] text-white/80">
            {BIS_EVENT_2027.name}
            <br />
            {BIS_EVENT_2027.edition}
          </p>
        </div>
        <div className="relative text-right">
          <p className="text-[9px] font-bold uppercase leading-tight tracking-[0.2em] text-white/70">
            {BIS_EVENT_2027.datesLabel}
          </p>
          <p
            className="mt-0.5 text-[9px] font-bold uppercase leading-tight tracking-[0.2em]"
            style={{ color: "#B8E62E" }}
          >
            {BIS_EVENT_2027.city}
          </p>
        </div>
      </header>

      {/* Role accent stripe — 3px, tinted per variant. */}
      <div
        aria-hidden
        className="h-[3px] w-full"
        style={{ backgroundColor: accent.stripe }}
      />

      {/* Body — identity + QR. */}
      <div
        className="relative flex flex-1 flex-col justify-between bg-white p-6"
        style={{
          // Soft accent gradient in the top-right corner of the body —
          // subtle, restrained, never dominant.
          backgroundImage: `radial-gradient(600px circle at 100% 0%, ${accent.softBg}, transparent 60%)`
        }}
      >
        {/* Role pill + name block. */}
        <div>
          <div className="flex items-center gap-2">
            <span
              className="inline-flex items-center rounded-full px-3 py-[3px] font-display text-[10px] font-black uppercase leading-none tracking-[0.22em]"
              style={{
                backgroundColor: accent.pillBg,
                color: accent.pillText
              }}
            >
              {roleLabel}
            </span>
          </div>
          <p className="mt-4 font-display text-[24px] font-black leading-[1.05] tracking-tight text-ink">
            {firstName}
            <br />
            {lastName}
          </p>
          {jobTitle && (
            <p className="mt-2 text-[12px] font-medium leading-tight text-ink/70">
              {jobTitle}
            </p>
          )}
          {organization && !jobTitle && (
            <p className="mt-2 text-[12px] font-medium leading-tight text-ink/70">
              {organization}
            </p>
          )}
        </div>

        {/* QR block — dominant lower half. Preserves quiet zone. */}
        <div className="mt-4 flex items-center justify-center">
          <div
            className={cn(
              "flex aspect-square w-full max-w-[240px] items-center justify-center overflow-hidden rounded-2xl bg-white p-3",
              qr ? "border border-[rgba(15,25,60,0.10)]" : "border border-dashed border-[rgba(15,25,60,0.15)]"
            )}
          >
            {qr ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qr}
                alt="Code QR — credential BIS 2027"
                className="h-full w-full object-contain"
                draggable={false}
                crossOrigin="anonymous"
              />
            ) : (
              <div className="px-4 text-center text-[10.5px] font-medium uppercase tracking-[0.18em] text-ink/40">
                QR non affiché
              </div>
            )}
          </div>
        </div>

        {/* Phase 19 — human-readable check-in code. Sits BELOW the
            QR (secondary visual weight) but printable at legible
            size. Uses tabular-nums so digits align visually. */}
        {checkinCode && (
          <div className="mt-3 rounded-lg border border-[rgba(15,25,60,0.10)] bg-white px-3 py-2 text-center">
            <p className="text-[8.5px] font-bold uppercase tracking-[0.22em] text-ink/50">
              Code d&apos;accès
            </p>
            <p
              className="mt-0.5 font-mono text-[16px] font-black leading-none tracking-[0.16em] text-ink tabular-nums"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {checkinCode}
            </p>
          </div>
        )}

        {/* Footer — event edition + hashtag. */}
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-[rgba(15,25,60,0.08)] pt-3 text-[9.5px] uppercase tracking-[0.20em] text-ink/50">
          <span className="font-bold">BIS+ · 2027</span>
          <span className="font-semibold">{BIS_EVENT_2027.hashtag}</span>
        </div>
      </div>
    </article>
  );
}
