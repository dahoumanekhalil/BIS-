import { eventInfo } from "@/lib/utils";

export function PageHeader({
  eyebrow,
  title,
  description,
  children
}: {
  eyebrow: string;
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="relative overflow-hidden border-b border-black/[0.08] bg-white">
      <div className="pointer-events-none absolute inset-0 grid-lines opacity-60" aria-hidden />
      <div className="container-wide relative py-20 sm:py-24 lg:py-32">
        <div className="max-w-4xl">
          <p className="eyebrow">
            <span className="h-px w-6 bg-black/40" />
            {eyebrow}
          </p>
          <h1 className="mt-6 font-display text-display-xl text-balance">{title}</h1>
          {description && (
            <p className="mt-6 max-w-2xl text-lg text-brand-ink/70 sm:text-xl">
              {description}
            </p>
          )}
        </div>
        <div className="mt-10 flex flex-wrap items-center gap-3">
          <span className="chip">{eventInfo.location}</span>
          <span className="chip">{eventInfo.date}</span>
          <span className="chip">{eventInfo.region}</span>
        </div>
        {children}
      </div>
    </section>
  );
}
