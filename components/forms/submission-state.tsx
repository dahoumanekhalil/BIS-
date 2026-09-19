import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Uniform "form-level" error banner + success screen used by every flow.
 * Success screens differ in copy for REGISTRATION vs APPLICATION:
 *   - REGISTER  → "Inscription confirmée"
 *   - BE A PART → "Candidature reçue"
 */

export function FormErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
    >
      {message}
    </div>
  );
}

export function SuccessScreen({
  variant,
  eyebrow,
  title,
  message,
  rows,
  primaryCta,
  secondaryCta
}: {
  variant: "registration" | "application";
  eyebrow: string;
  title: string;
  message: ReactNode;
  rows?: { label: string; value: string }[];
  primaryCta?: { href: string; label: string };
  secondaryCta?: { href: string; label: string };
}) {
  return (
    <div className="mx-auto max-w-xl text-center">
      <div className="inline-flex items-center gap-2 rounded-full border border-black/10 bg-white px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-ink/70">
        <span
          className="inline-flex h-2 w-2 rounded-full"
          style={{
            background: variant === "registration" ? "var(--lime)" : "var(--cobalt)"
          }}
          aria-hidden
        />
        {eyebrow}
      </div>
      <h2 className="mt-6 font-display text-3xl font-black tracking-tight text-ink sm:text-4xl">
        {title}
      </h2>
      <div className="mt-4 text-[15.5px] leading-relaxed text-ink/70">
        {message}
      </div>

      {rows && rows.length > 0 && (
        <dl className="mx-auto mt-8 grid max-w-md gap-2 rounded-2xl border border-black/[0.08] bg-white p-5 text-left text-sm">
          {rows.map((r) => (
            <div
              key={r.label}
              className="flex items-center justify-between gap-4 border-b border-black/[0.05] pb-2 last:border-b-0 last:pb-0"
            >
              <dt className="text-[11px] font-semibold uppercase tracking-[0.2em] text-ink/50">
                {r.label}
              </dt>
              <dd className="max-w-[65%] truncate text-right font-medium text-ink">
                {r.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
        {primaryCta && (
          <Link
            href={primaryCta.href}
            className="btn-lime-lg inline-flex justify-center"
          >
            {primaryCta.label}
            <span aria-hidden>→</span>
          </Link>
        )}
        {secondaryCta && (
          <Link
            href={secondaryCta.href}
            className="text-[13px] font-semibold uppercase tracking-[0.2em] text-ink/60 transition-colors hover:text-ink"
          >
            {secondaryCta.label}
          </Link>
        )}
      </div>
    </div>
  );
}
