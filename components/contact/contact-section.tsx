"use client";

import { Reveal } from "./reveal";
import { ContactForm } from "./contact-form";
import { cn } from "@/lib/utils";

export type ContactInfoItem = {
  index: string;
  label: string;
  value: string;
  href?: string;
  hint?: string;
};

export function ContactSection({ items }: { items: ContactInfoItem[] }) {
  return (
    <section className="relative bg-frost">
      <div className="container-page py-20 lg:py-24">
        <div className="grid gap-12 lg:grid-cols-12 lg:gap-16">
          {/* LEFT — editorial info */}
          <div className="lg:col-span-5">
            <Reveal>
              <p className="eyebrow">
                <span className="h-px w-6 bg-ink/40" /> Contact
              </p>
            </Reveal>
            <Reveal delay={100}>
              <h2 className="mt-4 font-display text-[clamp(1.85rem,3.2vw,2.75rem)] font-black leading-[1.05] tracking-tight text-ink">
                Une conversation peut{" "}
                <span className="text-cobalt">tout changer.</span>
              </h2>
            </Reveal>
            <Reveal delay={200}>
              <p className="mt-4 max-w-md text-[15px] leading-relaxed text-ink/65">
                L&apos;équipe BIS 2026 est basée à Alger et accompagne chaque
                demande avec attention. Choisissez le canal qui vous convient
                — nous privilégions les échanges structurés.
              </p>
            </Reveal>

            <ul className="mt-10 space-y-2.5">
              {items.map((item, i) => (
                <Reveal key={item.label} delay={280 + i * 80} as="li">
                  <ContactInfoCard item={item} />
                </Reveal>
              ))}
            </ul>
          </div>

          {/* RIGHT — form */}
          <div className="lg:col-span-7">
            <Reveal delay={220}>
              <div className="rounded-[20px] border border-line bg-white p-6 shadow-[0_20px_60px_-40px_rgba(15,25,60,0.2)] sm:p-8 lg:p-10">
                <div className="mb-6">
                  <p className="text-[10.5px] font-bold uppercase tracking-[0.2em] text-ink/50">
                    Formulaire · Réponse sous 48h
                  </p>
                  <h3 className="mt-2 font-display text-2xl font-black leading-tight tracking-tight text-ink">
                    Écrivez-nous.
                  </h3>
                </div>
                <ContactForm />
              </div>
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  );
}

function ContactInfoCard({ item }: { item: ContactInfoItem }) {
  const inner = (
    <div
      className={cn(
        "group relative flex items-start gap-4 rounded-card border border-line bg-white p-5 transition-all duration-300",
        item.href &&
          "hover:-translate-y-1 hover:border-ink/20 hover:shadow-[0_20px_40px_-24px_rgba(15,25,60,0.25)]"
      )}
    >
      <span
        className="mt-0.5 font-display text-[10px] font-black uppercase tracking-[0.24em] text-cobalt"
        aria-hidden
      >
        {item.index}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/50">
          {item.label}
        </p>
        <p className="mt-1 font-display text-[15px] font-bold leading-snug text-ink">
          {item.value}
        </p>
        {item.hint && (
          <p className="mt-0.5 text-[12px] text-ink/50">{item.hint}</p>
        )}
      </div>
      {item.href && (
        <span
          aria-hidden
          className="mt-1 flex h-8 w-8 flex-none items-center justify-center rounded-full border border-line text-ink/50 transition-all duration-300 group-hover:border-cobalt group-hover:bg-cobalt group-hover:text-white"
        >
          <span className="inline-block transition-transform duration-300 group-hover:translate-x-0.5">
            →
          </span>
        </span>
      )}
    </div>
  );

  if (item.href) {
    const isMail = item.href.startsWith("mailto:");
    const isTel = item.href.startsWith("tel:");
    return (
      <a
        href={item.href}
        target={isMail || isTel ? undefined : "_blank"}
        rel={isMail || isTel ? undefined : "noopener noreferrer"}
        className="block outline-none focus-visible:ring-2 focus-visible:ring-cobalt focus-visible:ring-offset-2 focus-visible:ring-offset-frost"
      >
        {inner}
      </a>
    );
  }
  return inner;
}
