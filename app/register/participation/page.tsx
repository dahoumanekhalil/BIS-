import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getOnboardingStatus } from "@/lib/onboarding";
import { OnboardingConflictScreen } from "@/components/forms/onboarding-conflict-screen";
import { cn } from "@/lib/utils";
import { ParticipationSelector } from "./participation-selector";

export const metadata: Metadata = {
  title: "Choisir sa participation",
  description: "Choisissez comment vous souhaitez participer au BIS 2027."
};

export const dynamic = "force-dynamic";

// All roles that appear on the participation selector.
const VISIBLE_SLUGS = [
  "visitor",
  "sponsor",
  "partner",
  "speaker",
  "content-creator"
] as const;
type VisibleSlug = (typeof VISIBLE_SLUGS)[number];

export default async function ParticipationStepPage({
  searchParams
}: {
  searchParams: Promise<{ participation?: string }>;
}) {
  const sp = await searchParams;
  const preselect = sp.participation?.toLowerCase();

  const status = await getOnboardingStatus();
  if (status.kind === "none") {
    redirect("/register");
  }
  if (status.kind === "conflict") {
    return <OnboardingConflictScreen />;
  }
  const participant = status.participant;

  const initialSlug: VisibleSlug | null = (
    VISIBLE_SLUGS as readonly string[]
  ).includes(preselect ?? "")
    ? (preselect as VisibleSlug)
    : null;

  return (
    <section className="relative overflow-hidden bg-frost pb-24 pt-14 lg:pb-32 lg:pt-20">
      {/* Backdrop — subtle grid + cobalt spotlight, unchanged from prior version. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[380px] bg-cobalt"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[380px] grid-lines-dark"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[-120px] h-[420px] w-[420px] -translate-x-1/2 rounded-full bg-lime/25 blur-3xl"
      />

      <div className="container-page relative">
        <ProgressRail current={2} />

        {/* Hero — copy per spec, same visual language as the header. */}
        <div className="mt-10 max-w-3xl text-white">
          <p className="eyebrow-invert">
            <span className="h-px w-6 bg-white/40" /> BIS 2027 · Étape 2 sur 4
          </p>
          <h1 className="mt-5 font-display text-[clamp(2.25rem,5vw,3.75rem)] font-black leading-[1.05] tracking-[-0.025em] text-white text-balance">
            Pourquoi souhaitez-vous rejoindre le BIS 2027 ?
          </h1>
          <p className="mt-5 max-w-xl text-[15.5px] leading-relaxed text-white/75">
            Votre compte est prêt. Indiquez-nous ce qui vous amène au BIS 2027
            afin de vous proposer la suite de votre parcours.
          </p>
        </div>

        {/* Mandatory selection body — client-side radio-group. */}
        <div className="mt-14">
          <ParticipationSelector initialSlug={initialSlug} />
        </div>

        {/* Session footer — unchanged idiom, minor polish. */}
        <div className="mt-14 flex flex-col items-start justify-between gap-3 border-t border-black/[0.06] pt-5 text-[12.5px] text-ink/55 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-lime/30 text-[11px] font-bold text-ink">
              {initials(participant.firstName, participant.lastName)}
            </span>
            <span>
              Connecté en tant que{" "}
              <strong className="text-ink">
                {participant.firstName} {participant.lastName}
              </strong>
              <span className="mx-2 text-ink/25">·</span>
              {participant.email}
            </span>
          </div>
          <Link
            href="/register"
            className="font-semibold uppercase tracking-[0.18em] text-cobalt hover:underline"
          >
            Recommencer
          </Link>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ SUBCOMPONENTS ------------------------------ */

function initials(a: string, b: string): string {
  return `${a.charAt(0)}${b.charAt(0)}`.toUpperCase();
}

function ProgressRail({ current }: { current: 1 | 2 | 3 | 4 }) {
  const steps = [
    { n: "01", label: "Compte" },
    { n: "02", label: "Participation" },
    { n: "03", label: "Détails" },
    { n: "04", label: "Confirmation" }
  ];
  return (
    <ol
      className="flex flex-wrap items-center gap-3 text-[10.5px] font-bold uppercase tracking-[0.22em] text-white/75"
      aria-label="Étapes"
    >
      {steps.map((s, i) => {
        const idx = i + 1;
        const active = idx === current;
        const done = idx < current;
        return (
          <li key={s.n} className="flex items-center gap-2">
            <span
              className={cn(
                "flex h-6 min-w-6 items-center justify-center rounded-full px-2 tabular-nums",
                active
                  ? "bg-lime text-ink"
                  : done
                    ? "bg-white/90 text-ink"
                    : "border border-white/25 text-white/60"
              )}
            >
              {s.n}
            </span>
            <span
              className={cn(
                "whitespace-nowrap",
                active
                  ? "text-white"
                  : done
                    ? "text-white/85"
                    : "text-white/45"
              )}
            >
              {s.label}
            </span>
            {i < steps.length - 1 && (
              <span
                className={cn(
                  "hidden h-px w-6 sm:inline-block",
                  done ? "bg-white/70" : "bg-white/20"
                )}
                aria-hidden
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
