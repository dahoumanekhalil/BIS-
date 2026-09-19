"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { RisingI } from "@/components/rising-i";
import { loginAccount, registerAccount } from "@/app/actions/account";
import { accountLoginSchema, accountRegisterSchema } from "@/lib/validations";

type Mode = "login" | "register";

export function AuthExperience({ initialMode }: { initialMode: Mode }) {
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<Mode>(initialMode);

  // Keep URL in sync (?mode=...) — replace, no scroll, no history clutter.
  useEffect(() => {
    const current = params.get("mode");
    if (current !== mode) {
      const next = new URLSearchParams(params.toString());
      next.set("mode", mode);
      router.replace(`/auth?${next.toString()}`, { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const isRegister = mode === "register";

  return (
    <section className="relative isolate overflow-hidden bg-frost">
      {/* Background atmosphere */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 grid-lines-dark opacity-[0.04]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-40 top-10 h-[520px] w-[520px] rounded-full bg-cobalt/10 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-32 bottom-0 h-[380px] w-[380px] rounded-full bg-lime/10 blur-3xl"
      />

      <div className="container-page relative flex min-h-[calc(100vh-var(--ticker-height)-var(--nav-height))] flex-col items-center justify-center py-16 lg:py-20">
        <div className="mb-10 text-center">
          <p className="eyebrow justify-center">
            <span className="h-px w-6 bg-ink/40" /> Accès BIS 2026
          </p>
          <h1 className="mt-4 font-display text-[clamp(1.75rem,3vw,2.5rem)] font-black tracking-tight">
            {isRegister ? (
              <>
                Rejoignez la <span className="text-cobalt">communauté</span>.
              </>
            ) : (
              <>
                Bienvenue <span className="text-cobalt">à nouveau</span>.
              </>
            )}
          </h1>
        </div>

        {/* MOBILE — stacked tabs */}
        <div className="w-full max-w-md md:hidden">
          <MobileAuth mode={mode} onModeChange={setMode} />
        </div>

        {/* DESKTOP — sliding brand panel */}
        <div className="hidden w-full md:block">
          <DesktopAuth mode={mode} onModeChange={setMode} />
        </div>

        <p className="mt-8 text-center text-[11px] uppercase tracking-[0.22em] text-ink/40">
          15 · 17 Novembre 2026 · CIC Alger
        </p>
      </div>
    </section>
  );
}

/* --------------------------- DESKTOP EXPERIENCE --------------------------- */

function DesktopAuth({
  mode,
  onModeChange,
}: {
  mode: Mode;
  onModeChange: (m: Mode) => void;
}) {
  const isRegister = mode === "register";

  function onMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 100;
    const y = ((e.clientY - r.top) / r.height) * 100;
    el.style.setProperty("--mx", `${x.toFixed(1)}%`);
    el.style.setProperty("--my", `${y.toFixed(1)}%`);
  }

  function onMouseLeave(e: React.MouseEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    el.style.setProperty("--mx", "50%");
    el.style.setProperty("--my", "50%");
  }

  return (
    <div
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      style={
        {
          height: 580,
          "--mx": "50%",
          "--my": "50%",
        } as React.CSSProperties
      }
      className={cn(
        "relative mx-auto w-full max-w-[960px] overflow-hidden rounded-[24px] border border-line bg-white",
        "shadow-[0_30px_80px_-40px_rgba(15,25,60,0.28)]",
      )}
    >
      {/* Two-column form layout — both mounted */}
      <div className="grid h-full grid-cols-2">
        <div className="relative h-full">
          {/* Register form sits in the LEFT column */}
          <FormShell
            visible={isRegister}
            title="Créer un compte"
            subtitle="Rejoignez la communauté BIS 2026."
          >
            <RegisterForm />
          </FormShell>
        </div>

        <div className="relative h-full">
          {/* Login form sits in the RIGHT column */}
          <FormShell
            visible={!isRegister}
            title="Se connecter"
            subtitle="Reprenez votre parcours BIS."
          >
            <LoginForm />
          </FormShell>
        </div>
      </div>

      {/* Sliding cobalt brand panel — single GPU-accelerated translate3d
          transition, silky ease-in-out. No layered keyframes so the
          motion never stutters. */}
      <div
        aria-hidden="true"
        className={cn(
          "absolute inset-y-0 left-0 z-30 w-1/2",
          "transition-transform duration-[1100ms] ease-[cubic-bezier(0.76,0,0.24,1)]",
          "motion-reduce:transition-none",
          "[backface-visibility:hidden] will-change-transform [transform-style:preserve-3d]",
        )}
        style={{
          transform: isRegister
            ? "translate3d(100%, 0, 0)"
            : "translate3d(0, 0, 0)",
        }}
      >
        <BrandPanel side={isRegister ? "right" : "left"} />
      </div>

      {/* Foreground content of the brand panel — travels with the panel
          on the same easing / duration so both feel like one surface. */}
      <div
        className={cn(
          "pointer-events-none absolute inset-y-0 z-40 w-1/2",
          "transition-transform duration-[1100ms] ease-[cubic-bezier(0.76,0,0.24,1)]",
          "motion-reduce:transition-none",
          "[backface-visibility:hidden] will-change-transform",
        )}
        style={{
          transform: isRegister
            ? "translate3d(100%, 0, 0)"
            : "translate3d(0, 0, 0)",
        }}
      >
        <div
          key={`panel-content-${mode}`}
          className="h-full w-full animate-[auth-content_900ms_cubic-bezier(0.22,1,0.36,1)_both] motion-reduce:animate-none"
        >
          <BrandPanelContent
            mode={mode}
            onSwitch={() => onModeChange(isRegister ? "login" : "register")}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The cobalt panel with the curved inner edge. Uses asymmetric
 * border-radius so the curve stays entirely within the panel's half —
 * no overflow into the form area.
 */
function BrandPanel({ side }: { side: "left" | "right" }) {
  const innerEdge = side === "left" ? "right" : "left";
  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{
        // Softer, more atmospheric gradient — warmer top-light, cooler
        // bottom shadow, subtle plum undertone bottom-right. Reads as
        // "sunlit sky over water" rather than a flat corporate blue.
        background:
          "radial-gradient(120% 100% at 15% 0%, #5D80FF 0%, transparent 55%), radial-gradient(90% 80% at 85% 100%, #3E2A7A 0%, transparent 60%), radial-gradient(80% 70% at 50% 60%, #2453E0 0%, transparent 70%), linear-gradient(160deg, #3A66E8 0%, #2247C9 50%, #17359C 100%)",
        borderRadius: "16px",
      }}
    >
      {/* Very soft top haze — warmth like morning light */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[45%]"
        style={{
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.14) 0%, transparent 100%)",
        }}
      />

      {/* Gentle grain — softens the gradient, no harsh dithering */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 noise opacity-[0.08] mix-blend-overlay"
      />

      {/* Rising-I mark — much fainter than before, sits centered as a
          quiet brand watermark, drifts slowly */}
      <div
        aria-hidden
        className="pointer-events-none absolute top-1/2 h-[360px] w-[360px] -translate-y-1/2 opacity-[0.055] will-change-transform animate-[auth-float-a_18s_ease-in-out_infinite] motion-reduce:animate-none"
        style={{ [innerEdge]: "-40px" } as React.CSSProperties}
      >
        <RisingI className="brightness-[3.5]" />
      </div>

      {/* Inner-edge highlight — the curved surface catches light */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 w-48"
        style={{
          [innerEdge]: 0,
          background:
            side === "left"
              ? "radial-gradient(120% 60% at 100% 50%, rgba(255,255,255,0.18) 0%, transparent 60%)"
              : "radial-gradient(120% 60% at 0% 50%, rgba(255,255,255,0.18) 0%, transparent 60%)",
        }}
      />

      {/* Floating lime halo — softer, wider, gentler tint */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 left-1/2 h-[420px] w-[420px] -translate-x-1/2 rounded-full bg-lime/10 blur-3xl will-change-transform animate-[auth-float-a_13s_ease-in-out_infinite] motion-reduce:animate-none"
      />

      {/* Second warm orb — sky-blue instead of cobalt to lift the mood */}
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-[-160px] left-[8%] h-[340px] w-[340px] rounded-full bg-[#7CA2FF]/30 blur-3xl will-change-transform animate-[auth-float-b_16s_ease-in-out_infinite] motion-reduce:animate-none"
      />

      {/* Cursor-following studio spotlight — softer, wider */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 mix-blend-screen"
        style={{
          background:
            "radial-gradient(480px 380px at var(--mx) var(--my), rgba(255,255,255,0.18), transparent 62%)",
        }}
      />
    </div>
  );
}

function BrandPanelContent({
  mode,
  onSwitch,
}: {
  mode: Mode;
  onSwitch: () => void;
}) {
  const isRegister = mode === "register";
  return (
    <div className="pointer-events-auto flex h-full w-full flex-col px-10 pb-9 pt-10 text-white lg:px-14 lg:pt-12">
      {/* Soft top badge */}
      <div>
        <span className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/[0.08] px-3 py-1 text-[10.5px] font-semibold uppercase tracking-[0.22em] text-white/85 backdrop-blur">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-lime opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-lime" />
          </span>
          BIS · Édition 2026
        </span>
      </div>

      {/* Title block — anchored toward vertical center for calm rhythm */}
      <div className="mt-auto">
        <h2 className="font-display text-[clamp(1.9rem,2.8vw,2.75rem)] font-black leading-[1.05] tracking-tight [text-shadow:0_2px_20px_rgba(0,0,0,0.15)]">
          {isRegister ? (
            <>
              Bon retour,
              <br />
              <span className="text-lime">nous vous attendions.</span>
            </>
          ) : (
            <>
              Bienvenue.
              <br />
              <span className="text-lime">Rejoignez BIS.</span>
            </>
          )}
        </h2>
        <p className="mt-5 max-w-[22rem] text-[13.5px] leading-[1.65] text-white/80">
          {isRegister
            ? "Reprenez votre parcours BIS 2026. Votre programme et vos favoris vous attendent."
            : "Créez votre compte pour composer votre journée et recevoir votre pass digital BIS 2026."}
        </p>

        {/* Feature chips — softer than a bullet list, easier on the eye */}
        <ul className="mt-6 space-y-2.5">
          {(isRegister
            ? ["Programme sauvegardé", "Sessions favorites", "Pass digital"]
            : [
                "Composez votre journée",
                "Sauvegardez sessions & speakers",
                "Recevez votre pass digital",
              ]
          ).map((line) => (
            <li
              key={line}
              className="inline-flex w-full items-center gap-2.5 text-[12.5px] text-white/85"
            >
              <span
                aria-hidden
                className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-lime/25 text-lime ring-1 ring-inset ring-lime/40"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                  aria-hidden
                >
                  <path
                    d="M2 5.5l2 2 4-5"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span>{line}</span>
            </li>
          ))}
        </ul>

        {/* Switch CTA */}
        <button
          type="button"
          onClick={onSwitch}
          className={cn(
            "group/switch mt-8 inline-flex w-fit items-center justify-center gap-2.5 rounded-full border border-white/60 bg-white/[0.06] px-6 py-3 text-[13px] font-semibold text-white backdrop-blur transition-all duration-300",
            "hover:border-white hover:bg-white hover:text-cobalt hover:shadow-[0_18px_40px_-18px_rgba(255,255,255,0.55)]",
          )}
        >
          {isRegister ? "Se connecter" : "Créer un compte"}
          <span
            aria-hidden
            className="inline-block transition-transform duration-300 group-hover/switch:translate-x-1"
          >
            →
          </span>
        </button>
      </div>

      {/* Bottom soft strip — no divider, just spaced with muted color */}
      <div className="mt-10 flex items-center justify-between text-[10.5px] font-semibold uppercase tracking-[0.24em] text-white/50">
        <span>15 · 17 Nov 2026</span>
        <span className="hidden sm:inline">CIC Alger</span>
      </div>
    </div>
  );
}

/* --------------------------- FORM SHELL --------------------------- */

function FormShell({
  visible,
  title,
  subtitle,
  children,
}: {
  visible: boolean;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex h-full flex-col justify-center overflow-y-auto px-10 py-10 lg:px-14",
        "transition-[opacity,transform,filter] duration-[600ms] ease-out",
        visible
          ? "opacity-100 blur-0 translate-y-0 delay-[600ms]"
          : "pointer-events-none translate-y-2 opacity-0 blur-[2px] delay-0",
      )}
      aria-hidden={!visible}
      {...(!visible ? { inert: true } : {})}
    >
      <div className="mb-6">
        <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-ink/50">
          {subtitle}
        </p>
        <h3 className="mt-2 font-display text-2xl font-black leading-tight tracking-tight text-ink">
          {title}
        </h3>
      </div>
      {children}
    </div>
  );
}

/* --------------------------- LOGIN FORM --------------------------- */

function LoginForm() {
  const router = useRouter();
  const [values, setValues] = useState({ email: "", password: "" });
  const [remember, setRemember] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMessage(null);
    setErrors({});
    const parsed = accountLoginSchema.safeParse({ ...values, remember });
    if (!parsed.success) {
      setErrors(toFieldErrors(parsed.error.issues));
      setStatus("error");
      return;
    }
    setStatus("loading");
    let result;
    try {
      result = await loginAccount(parsed.data);
    } catch {
      setMessage("Connexion au serveur impossible. Réessayez.");
      setStatus("error");
      return;
    }
    if (!result.ok) {
      setErrors(result.fieldErrors ?? {});
      setMessage(result.message);
      setStatus("error");
      return;
    }
    setStatus("success");
    setMessage("Connexion réussie — redirection…");
    router.replace("/compte");
    router.refresh();
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      <AuthInput
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        value={values.email}
        onChange={(v) => setValues((s) => ({ ...s, email: v }))}
        error={errors.email}
        required
      />
      <AuthInput
        label="Mot de passe"
        name="password"
        type="password"
        autoComplete="current-password"
        value={values.password}
        onChange={(v) => setValues((s) => ({ ...s, password: v }))}
        error={errors.password}
        required
      />

      <div className="flex items-center justify-between pt-1 text-[12px]">
        <label className="inline-flex items-center gap-2 text-ink/70">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-ink/25"
          />
          Se souvenir de moi
        </label>
        <Link
          href="#"
          className="font-semibold text-cobalt hover:underline"
          onClick={(e) => e.preventDefault()}
        >
          Mot de passe oublié ?
        </Link>
      </div>

      <SubmitButton
        loading={status === "loading"}
        idleLabel="Se connecter"
        loadingLabel="Connexion en cours…"
      />

      <AuthMessage status={status} message={message} />

      <div className="pt-2 text-center text-[11px] uppercase tracking-[0.22em] text-ink/40">
        Ou continuer avec
      </div>
      <SocialRow />
    </form>
  );
}

/* --------------------------- REGISTER FORM --------------------------- */

function RegisterForm() {
  const router = useRouter();
  const [values, setValues] = useState({
    firstName: "",
    lastName: "",
    email: "",
    password: "",
    confirm: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMessage(null);
    setErrors({});
    const parsed = accountRegisterSchema.safeParse({ ...values, consent });
    if (!parsed.success) {
      setErrors(toFieldErrors(parsed.error.issues));
      setStatus("error");
      return;
    }
    setStatus("loading");
    let result;
    try {
      result = await registerAccount(parsed.data);
    } catch {
      setMessage("Connexion au serveur impossible. Réessayez.");
      setStatus("error");
      return;
    }
    if (!result.ok) {
      setErrors(result.fieldErrors ?? {});
      setMessage(result.message);
      setStatus("error");
      return;
    }
    setStatus("success");
    setMessage("Compte créé — comment souhaitez-vous participer ?");
    // Account creation is NOT the end of the BIS registration journey. Send
    // the newly-authenticated user into the participation-selection step so
    // they can choose Visitor / Sponsor / Partner / Speaker / Content Creator.
    router.replace("/register/participation");
    router.refresh();
  }

  return (
    <form className="space-y-3.5" onSubmit={onSubmit} noValidate>
      <div className="grid grid-cols-2 gap-3">
        <AuthInput
          label="Prénom"
          name="firstName"
          autoComplete="given-name"
          value={values.firstName}
          onChange={(v) => setValues((s) => ({ ...s, firstName: v }))}
          error={errors.firstName}
          required
        />
        <AuthInput
          label="Nom"
          name="lastName"
          autoComplete="family-name"
          value={values.lastName}
          onChange={(v) => setValues((s) => ({ ...s, lastName: v }))}
          error={errors.lastName}
          required
        />
      </div>
      <AuthInput
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        value={values.email}
        onChange={(v) => setValues((s) => ({ ...s, email: v }))}
        error={errors.email}
        required
      />
      <AuthInput
        label="Mot de passe"
        name="password"
        type="password"
        autoComplete="new-password"
        value={values.password}
        onChange={(v) => setValues((s) => ({ ...s, password: v }))}
        error={errors.password}
        required
      />
      <AuthInput
        label="Confirmer le mot de passe"
        name="confirm"
        type="password"
        autoComplete="new-password"
        value={values.confirm}
        onChange={(v) => setValues((s) => ({ ...s, confirm: v }))}
        error={errors.confirm}
        required
      />

      <label className="flex items-start gap-2.5 pt-1 text-[12px] text-ink/70">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-[3px] h-3.5 w-3.5 rounded border-ink/25"
        />
        <span>
          J&apos;accepte les{" "}
          <Link
            href="#"
            className="font-semibold text-cobalt hover:underline"
            onClick={(e) => e.preventDefault()}
          >
            conditions
          </Link>{" "}
          et la politique de confidentialité BIS 2026.
          {errors.consent && (
            <span className="mt-1 block text-[11px] text-red-600">
              {errors.consent}
            </span>
          )}
        </span>
      </label>

      <SubmitButton
        loading={status === "loading"}
        idleLabel="Créer mon compte"
        loadingLabel="Création en cours…"
      />

      <AuthMessage status={status} message={message} />
    </form>
  );
}

/* --------------------------- PRIMITIVES --------------------------- */

function toFieldErrors(
  issues: { path: (string | number)[]; message: string }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) out[issue.path.join(".")] = issue.message;
  return out;
}

function AuthInput({
  label,
  name,
  type = "text",
  autoComplete,
  value,
  onChange,
  error,
  required,
}: {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  required?: boolean;
}) {
  return (
    <div>
      <label
        htmlFor={name}
        className="block text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/55"
      >
        {label}
        {required && <span className="text-cobalt"> *</span>}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        autoComplete={autoComplete}
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${name}-error` : undefined}
        className={cn(
          "mt-1.5 w-full rounded-btn border bg-white px-3.5 py-2.5 text-[13.5px] text-ink outline-none transition-colors",
          "border-line placeholder:text-ink/35",
          "focus:border-cobalt focus:ring-2 focus:ring-cobalt/15",
          error && "border-red-400 focus:border-red-500 focus:ring-red-500/15",
        )}
      />
      {error && (
        <p id={`${name}-error`} className="mt-1 text-[11px] text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

function SubmitButton({
  loading,
  idleLabel,
  loadingLabel,
}: {
  loading: boolean;
  idleLabel: string;
  loadingLabel: string;
}) {
  return (
    <button
      type="submit"
      disabled={loading}
      className={cn(
        "mt-2 inline-flex w-full items-center justify-center gap-2 rounded-btn bg-lime px-5 py-3 text-[13.5px] font-bold text-ink transition-all duration-200",
        "hover:bg-lime-600 disabled:cursor-not-allowed disabled:opacity-70",
      )}
    >
      {loading ? (
        <>
          <span
            aria-hidden
            className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-ink/60 border-t-transparent"
          />
          {loadingLabel}
        </>
      ) : (
        <>
          {idleLabel}
          <span aria-hidden>→</span>
        </>
      )}
    </button>
  );
}

function AuthMessage({
  status,
  message,
}: {
  status: "idle" | "loading" | "success" | "error";
  message: string | null;
}) {
  if (status === "success" && message) {
    return (
      <div
        role="status"
        className="rounded-btn border border-lime/40 bg-lime/10 px-3.5 py-2.5 text-[12.5px] text-ink"
      >
        {message}
      </div>
    );
  }
  if (status === "error" && message) {
    return (
      <div
        role="alert"
        className="rounded-btn border border-red-300 bg-red-50 px-3.5 py-2.5 text-[12.5px] text-red-700"
      >
        {message}
      </div>
    );
  }
  return null;
}

function SocialRow() {
  return (
    <div className="grid grid-cols-2 gap-2">
      <button
        type="button"
        className="inline-flex items-center justify-center gap-2 rounded-btn border border-line bg-white px-3 py-2 text-[12px] font-semibold text-ink transition-colors hover:border-ink/30"
      >
        <GoogleIcon /> Google
      </button>
      <button
        type="button"
        className="inline-flex items-center justify-center gap-2 rounded-btn border border-line bg-white px-3 py-2 text-[12px] font-semibold text-ink transition-colors hover:border-ink/30"
      >
        <LinkedInIcon /> LinkedIn
      </button>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#EA4335"
        d="M24 9.5c3.3 0 6.3 1.1 8.6 3.2l6.4-6.4C34.9 2.5 29.8.5 24 .5 14.6.5 6.5 5.9 2.6 13.8l7.5 5.8C11.9 13.9 17.4 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.9 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.9c-.6 3-2.4 5.5-5.1 7.2l7.8 6c4.6-4.2 7.3-10.4 7.3-17.7z"
      />
      <path
        fill="#FBBC05"
        d="M10.1 28.6c-.5-1.4-.8-2.9-.8-4.6s.3-3.2.8-4.6l-7.5-5.8C1 16.6 0 20.2 0 24s1 7.4 2.6 10.4l7.5-5.8z"
      />
      <path
        fill="#34A853"
        d="M24 47.5c6.5 0 11.9-2.1 15.9-5.8l-7.8-6c-2.2 1.5-5 2.4-8.1 2.4-6.6 0-12.1-4.4-14.1-10.4l-7.5 5.8C6.5 42.1 14.6 47.5 24 47.5z"
      />
    </svg>
  );
}

function LinkedInIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="#0A66C2"
        d="M20.45 20.45h-3.55v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.13 1.44-2.13 2.94v5.67H9.36V9h3.41v1.56h.05c.47-.9 1.63-1.85 3.36-1.85 3.6 0 4.26 2.37 4.26 5.45v6.29zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.72V1.72C24 .77 23.2 0 22.22 0z"
      />
    </svg>
  );
}

/* --------------------------- MOBILE --------------------------- */

function MobileAuth({
  mode,
  onModeChange,
}: {
  mode: Mode;
  onModeChange: (m: Mode) => void;
}) {
  const isRegister = mode === "register";
  const key = useMemo(() => mode, [mode]);

  return (
    <div className="rounded-[20px] border border-line bg-white shadow-[0_20px_60px_-30px_rgba(15,25,60,0.25)]">
      {/* Compact brand strip */}
      <div
        className="relative overflow-hidden rounded-t-[20px] px-6 py-6 text-white"
        style={{
          background:
            "linear-gradient(135deg, #2453E0 0%, #1E44C4 55%, #1339B7 100%)",
        }}
      >
        <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-white/70">
          BIS · Édition 2026
        </p>
        <h2 className="mt-2 font-display text-2xl font-black leading-tight tracking-tight">
          {isRegister ? (
            <>
              Bon retour,{" "}
              <span className="text-lime">nous vous attendions.</span>
            </>
          ) : (
            <>
              Bienvenue. <span className="text-lime">Rejoignez BIS.</span>
            </>
          )}
        </h2>
      </div>

      <div className="border-b border-line px-6 pt-4">
        <div className="flex gap-1">
          <TabButton active={!isRegister} onClick={() => onModeChange("login")}>
            Se connecter
          </TabButton>
          <TabButton
            active={isRegister}
            onClick={() => onModeChange("register")}
          >
            Créer un compte
          </TabButton>
        </div>
      </div>

      <div key={key} className="animate-fade-up px-6 py-6">
        {isRegister ? <RegisterForm /> : <LoginForm />}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex-1 rounded-t-[6px] px-3 py-2.5 text-[13px] font-semibold transition-colors",
        active ? "text-ink" : "text-ink/50 hover:text-ink/80",
      )}
    >
      {children}
      <span
        aria-hidden
        className={cn(
          "absolute inset-x-0 bottom-[-1px] h-[2px] rounded-full transition-all duration-300",
          active ? "bg-cobalt" : "bg-transparent",
        )}
      />
    </button>
  );
}
