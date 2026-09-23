import { adminLogout } from "@/app/admin/login/actions";
import { ROLE_LABEL } from "@/lib/admin/rbac";
import type { AdminUser } from "@prisma/client";

function summitStatus(): {
  label: string;
  tone: "upcoming" | "live" | "ended";
} {
  const now = Date.now();
  const start = new Date("2027-11-15T08:00:00Z").getTime();
  const end = new Date("2027-11-17T20:00:00Z").getTime();
  if (now < start) return { label: "Upcoming", tone: "upcoming" };
  if (now > end) return { label: "Ended", tone: "ended" };
  return { label: "Live", tone: "live" };
}

export function AdminHeader({
  user,
  title,
  subtitle
}: {
  user: AdminUser;
  title: string;
  subtitle?: string;
}) {
  const status = summitStatus();
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-white/95 backdrop-blur">
      <div className="flex items-center justify-between gap-4 px-6 py-4">
        <div className="min-w-0">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-ink/45">
            {subtitle ?? "Ops Console"}
          </p>
          <h1 className="mt-0.5 font-display text-xl font-black tracking-tight text-ink">
            {title}
          </h1>
        </div>

        <div className="flex items-center gap-3">
          <span
            className={
              status.tone === "live"
                ? "inline-flex items-center gap-2 rounded-full bg-lime/20 px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-[0.16em] text-ink"
                : status.tone === "upcoming"
                  ? "inline-flex items-center gap-2 rounded-full bg-cobalt/10 px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-[0.16em] text-cobalt"
                  : "inline-flex items-center gap-2 rounded-full bg-ink/10 px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-[0.16em] text-ink/60"
            }
          >
            {status.tone === "live" && (
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ink opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-ink" />
              </span>
            )}
            {status.label} · BIS 2027
          </span>

          <div className="hidden text-right sm:block">
            <p className="text-[12.5px] font-bold leading-tight text-ink">
              {user.name}
            </p>
            <p className="text-[10.5px] uppercase tracking-[0.18em] text-ink/50">
              {ROLE_LABEL[user.role]}
            </p>
          </div>

          <form action={adminLogout}>
            <button
              type="submit"
              className="rounded-btn border border-line bg-white px-3 py-1.5 text-[12px] font-semibold text-ink transition-colors hover:border-ink/30"
            >
              Se déconnecter
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
