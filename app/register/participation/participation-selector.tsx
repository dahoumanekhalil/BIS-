"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Mandatory single-select participation picker.
 *
 * UX contract (per spec):
 *   - Nothing preselected unless a valid ?participation=<slug> query says so.
 *   - Continue is disabled until a card is selected.
 *   - Radio-group semantics: keyboard navigable, screen-reader friendly.
 *   - Selected card becomes visually dominant; the other two dim.
 */

type Slug =
  | "visitor"
  | "sponsor"
  | "partner"
  | "speaker"
  | "content-creator";

type Theme = "cobalt" | "lime";

type Option = {
  slug: Slug;
  index: string; // "01"…
  category: string; // "PARTICIPATION"
  theme: Theme; // visual accent per role
  title: string;
  description: string;
  cta: string;
  hint: string;
  icon: ReactNode;
};

const OPTIONS: Option[] = [
  {
    slug: "visitor",
    index: "01",
    category: "Participation",
    theme: "cobalt",
    title: "Participant / Visiteur",
    description:
      "Je souhaite assister au sommet, découvrir les contenus et rencontrer les acteurs de l'écosystème BIS.",
    cta: "Participer au sommet",
    hint: "Aucune information supplémentaire requise.",
    icon: <IconTicket />
  },
  {
    slug: "sponsor",
    index: "02",
    category: "Business",
    theme: "lime",
    title: "Sponsor",
    description:
      "Je représente une marque ou une entreprise et souhaite explorer une opportunité de sponsoring avec le BIS 2026.",
    cta: "Explorer le sponsoring",
    hint: "Notre équipe partenariats vous répond sous 48 h.",
    icon: <IconStar />
  },
  {
    slug: "partner",
    index: "03",
    category: "Alliance",
    theme: "cobalt",
    title: "Partenaire",
    description:
      "Institution, université, ONG ou média — je souhaite construire une collaboration stratégique autour du sommet.",
    cta: "Proposer un partenariat",
    hint: "Notre équipe partenariats vous répond sous 48 h.",
    icon: <IconHandshake />
  },
  {
    slug: "speaker",
    index: "04",
    category: "Expertise",
    theme: "lime",
    title: "Intervenant",
    description:
      "Je souhaite proposer mon expertise, partager mon expérience et contribuer au programme du BIS 2026.",
    cta: "Proposer mon profil",
    hint: "Le comité éditorial étudie chaque candidature.",
    icon: <IconMic />
  },
  {
    slug: "content-creator",
    index: "05",
    category: "Média",
    theme: "cobalt",
    title: "Créateur de contenu",
    description:
      "Je souhaite amplifier les idées et histoires du sommet auprès de mon audience — accès presse et briefings dédiés.",
    cta: "Rejoindre les créateurs",
    hint: "Accréditation examinée par l'équipe éditoriale.",
    icon: <IconCamera />
  }
];

export function ParticipationSelector({
  initialSlug
}: {
  initialSlug: Slug | null;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Slug | null>(initialSlug);
  const [pending, startTransition] = useTransition();

  function onContinue() {
    if (!selected || pending) return;
    startTransition(() => {
      router.push(`/register/${selected}`);
    });
  }

  const anySelected = selected !== null;

  return (
    <div>
      <fieldset>
        <legend className="sr-only">Choix de participation</legend>
        <div
          role="radiogroup"
          aria-label="Choix de participation"
          className="grid gap-4 sm:grid-cols-2 md:gap-5 lg:grid-cols-3"
        >
          {OPTIONS.map((opt) => (
            <ChoiceCard
              key={opt.slug}
              option={opt}
              selected={selected === opt.slug}
              subdued={anySelected && selected !== opt.slug}
              onSelect={() => setSelected(opt.slug)}
            />
          ))}
        </div>
      </fieldset>

      {/* Continue rail — pinned below the cards, generous whitespace. */}
      <div className="mt-10 flex flex-col-reverse items-center justify-between gap-4 sm:flex-row">
        <p className="text-[12.5px] text-ink/50" aria-live="polite">
          {anySelected
            ? "Vous pourrez revenir en arrière pour ajuster votre choix."
            : "Sélectionnez une option pour continuer."}
        </p>
        <button
          type="button"
          onClick={onContinue}
          disabled={!anySelected || pending}
          aria-disabled={!anySelected || pending}
          className={cn(
            "inline-flex items-center justify-center gap-2 rounded-btn px-6 py-3.5 text-sm font-semibold transition-all duration-200",
            anySelected
              ? "bg-lime text-ink hover:bg-lime-600"
              : "cursor-not-allowed bg-ink/[0.08] text-ink/40"
          )}
        >
          {pending ? "Chargement…" : "Continuer"}
          <span
            aria-hidden
            className={cn(
              "transition-transform duration-200",
              anySelected && !pending && "group-hover:translate-x-1"
            )}
          >
            →
          </span>
        </button>
      </div>
    </div>
  );
}

/* ------------------------------ CARD ------------------------------ */

function ChoiceCard({
  option,
  selected,
  subdued,
  onSelect
}: {
  option: Option;
  selected: boolean;
  subdued: boolean;
  onSelect: () => void;
}) {
  const id = `participation-${option.slug}`;
  const descId = `${id}-desc`;
  const isLime = option.theme === "lime";

  return (
    <label
      htmlFor={id}
      className={cn(
        "group relative flex h-full cursor-pointer flex-col overflow-hidden rounded-[24px] border bg-white p-6 transition-all duration-300 sm:p-7",
        selected
          ? isLime
            ? "border-lime shadow-[0_28px_60px_-28px_rgba(184,230,46,0.55)] ring-1 ring-lime/70"
            : "border-cobalt shadow-[0_28px_60px_-28px_rgba(36,83,224,0.45)] ring-1 ring-cobalt/60"
          : "border-black/[0.08] hover:-translate-y-0.5 hover:border-black/25 hover:shadow-[0_20px_50px_-32px_rgba(15,25,60,0.25)]",
        subdued && "opacity-55 saturate-50 hover:opacity-80"
      )}
    >
      {/* Top accent bar — reveals the role's theme colour. */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 h-[3px] transition-opacity duration-300",
          isLime ? "bg-lime" : "bg-cobalt",
          selected ? "opacity-100" : "opacity-40 group-hover:opacity-80"
        )}
      />
      {/* Native radio — screen reader + keyboard driver. */}
      <input
        id={id}
        type="radio"
        name="participation"
        value={option.slug}
        checked={selected}
        onChange={onSelect}
        aria-describedby={descId}
        className="peer sr-only"
      />

      {/* Focus ring reflects the radio's focus-visible state. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[24px] ring-2 ring-cobalt/0 transition-all duration-200 peer-focus-visible:ring-cobalt/70"
      />

      {/* Top row — index / category / selection indicator */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <span
            className={cn(
              "font-display text-[26px] font-black leading-none tabular-nums transition-colors",
              selected ? "text-ink" : "text-ink/25"
            )}
          >
            {option.index}
          </span>
          <span
            className={cn(
              "text-[10px] font-bold uppercase tracking-[0.22em] transition-colors",
              selected ? "text-ink/70" : "text-ink/45"
            )}
          >
            {option.category}
          </span>
        </div>

        <SelectionIndicator selected={selected} theme={option.theme} />
      </div>

      {/* Icon */}
      <div
        className={cn(
          "mt-8 flex h-12 w-12 items-center justify-center rounded-2xl transition-all duration-300",
          selected
            ? isLime
              ? "bg-lime text-ink scale-105"
              : "bg-cobalt text-white scale-105"
            : "bg-ink/[0.05] text-ink"
        )}
      >
        {option.icon}
      </div>

      {/* Title + description */}
      <div className="mt-5 min-w-0">
        <h3 className="font-display text-[22px] font-black leading-tight tracking-tight text-ink">
          {option.title}
        </h3>
        <p
          id={descId}
          className="mt-3 text-[14px] leading-relaxed text-ink/65"
        >
          {option.description}
        </p>
      </div>

      {/* Bottom row — supporting hint + CTA label */}
      <div className="mt-auto flex flex-col gap-3 border-t border-black/[0.06] pt-5">
        <p className="text-[11.5px] text-ink/45">{option.hint}</p>
        <div
          className={cn(
            "flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.18em] transition-colors",
            selected
              ? "text-ink"
              : isLime
                ? "text-ink/80"
                : "text-cobalt"
          )}
        >
          {option.cta}
          <span
            aria-hidden
            className={cn(
              "transition-transform duration-300",
              selected ? "translate-x-1" : "group-hover:translate-x-1"
            )}
          >
            →
          </span>
        </div>
      </div>
    </label>
  );
}

function SelectionIndicator({
  selected,
  theme
}: {
  selected: boolean;
  theme: Theme;
}) {
  const isLime = theme === "lime";
  return (
    <span
      aria-hidden
      className={cn(
        "relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 transition-all duration-200",
        selected
          ? isLime
            ? "border-lime bg-lime text-ink"
            : "border-cobalt bg-cobalt text-white"
          : "border-ink/15 bg-white text-transparent"
      )}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cn(
          "transition-transform duration-200",
          selected ? "scale-100" : "scale-0"
        )}
      >
        <path d="M5 12l4 4L19 6" />
      </svg>
    </span>
  );
}

/* ------------------------------ ICONS ------------------------------ */

function IconTicket() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 10V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4z" />
      <path d="M13 5v2M13 11v2M13 17v2" />
    </svg>
  );
}

function IconStar() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 2l3 6 6 1-4.5 4.5L18 20l-6-3-6 3 1.5-6.5L3 9l6-1z" />
    </svg>
  );
}

function IconMic() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
    </svg>
  );
}

function IconHandshake() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 12l4-4 3 3 4-4 4 4 3-3" />
      <path d="M7 13l3 3a2 2 0 0 0 2.8 0l1.2-1.2 2 2a1.6 1.6 0 0 0 2.3-2.3L14 9.5" />
      <path d="M10 12l2.5-2.5" />
    </svg>
  );
}

function IconCamera() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 8h3l2-2h6l2 2h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}
