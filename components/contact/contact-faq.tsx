"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Reveal } from "./reveal";

const FAQS: Array<{ q: string; a: string }> = [
  {
    q: "Comment participer au BIS 2026 ?",
    a: "Réservez votre billet depuis la page Inscription. Les places sont attribuées par vagues — les inscriptions tôt bénéficient des tarifs préférentiels."
  },
  {
    q: "Comment devenir partenaire ?",
    a: "Écrivez-nous via le formulaire avec le motif « Partenariat » ou « Sponsoring ». Notre équipe partenariats vous partagera le dossier détaillé et les formats disponibles."
  },
  {
    q: "Comment proposer une intervention ?",
    a: "Utilisez le formulaire avec le motif « Proposition d'intervention ». Précisez votre sujet, angle proposé et références. Les propositions sont revues chaque semaine."
  },
  {
    q: "Comment contacter l'équipe média ?",
    a: "Choisissez « Presse & médias » dans le formulaire. Les accréditations, interviews et accès presse sont traités séparément par un pôle dédié."
  }
];

export function ContactFAQ() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <section className="bg-white">
      <div className="container-page py-16 lg:py-20">
        <div className="grid gap-10 lg:grid-cols-12 lg:gap-16">
          <div className="lg:col-span-4">
            <Reveal>
              <p className="eyebrow">
                <span className="h-px w-6 bg-ink/40" /> FAQ
              </p>
            </Reveal>
            <Reveal delay={100}>
              <h2 className="mt-4 font-display text-[clamp(1.5rem,2.6vw,2.25rem)] font-black leading-[1.1] tracking-tight text-ink">
                Les questions{" "}
                <span className="text-cobalt">les plus fréquentes.</span>
              </h2>
            </Reveal>
            <Reveal delay={200}>
              <p className="mt-4 text-[14px] leading-relaxed text-ink/60">
                Vous ne trouvez pas votre réponse ? Utilisez le formulaire — notre
                équipe répond sous 48 heures ouvrées.
              </p>
            </Reveal>
          </div>
          <div className="lg:col-span-8">
            <ul className="divide-y divide-line rounded-card border border-line bg-white">
              {FAQS.map((item, i) => {
                const isOpen = open === i;
                return (
                  <li key={item.q}>
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() => setOpen(isOpen ? null : i)}
                      className="flex w-full items-start justify-between gap-4 px-5 py-5 text-left transition-colors hover:bg-frost sm:px-6"
                    >
                      <div className="flex flex-1 items-start gap-4">
                        <span className="mt-0.5 font-display text-[10px] font-black tracking-[0.24em] text-cobalt">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        <span className="font-display text-[15px] font-bold leading-snug text-ink">
                          {item.q}
                        </span>
                      </div>
                      <span
                        aria-hidden
                        className={cn(
                          "mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-full border border-line text-ink/60 transition-all duration-300",
                          isOpen && "rotate-45 border-cobalt bg-cobalt text-white"
                        )}
                      >
                        <span className="text-lg leading-none">+</span>
                      </span>
                    </button>
                    <div
                      className={cn(
                        "grid overflow-hidden transition-[grid-template-rows,opacity] duration-500 ease-out",
                        isOpen
                          ? "grid-rows-[1fr] opacity-100"
                          : "grid-rows-[0fr] opacity-0"
                      )}
                    >
                      <div className="min-h-0">
                        <p className="px-5 pb-6 pl-16 pr-6 text-[14px] leading-relaxed text-ink/70 sm:px-6 sm:pl-16">
                          {item.a}
                        </p>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
