import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { AdminHeader } from "@/components/admin/header";
import { requireAdmin, requirePermission } from "@/lib/admin/auth";
import { getAccessPointBySlug } from "@/lib/admin/queries";
import { requiredScannerPermission } from "@/lib/admin/scanner-permission";
import { ScannerClient } from "./scanner-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Scanner" };

// Slug parameter mirror of the create/rename Zod schema from Phase 8
// (lowercase alnum + hyphen, anchored). Route rejects anything else
// BEFORE any DB lookup — path-traversal safe, unicode-homograph safe.
const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

// Scanner route — Phase 9 transport layer.
//
// Authorization chain (server-side, sequential, before any camera code
// even loads on the client):
//
//   1. requireAdmin()                        ← any authenticated admin
//   2. slugSchema.safeParse(rawSlug)         ← reject malformed slug
//   3. getAccessPointBySlug(slug)            ← DB lookup, no cache
//   4. notFound() if null                    ← clean refusal
//   5. requiredScannerPermission(type)       ← type-derived permission
//   6. requirePermission(perm)               ← strict, no legacy fallback
//   7. active check → disabled shell OR scanner shell
//
// The URL slug NEVER acts as authorization on its own. The order is
// deliberate: session is verified first (via requireAdmin), then the DB
// resolves the point, and only after we know the AccessPoint.type do we
// escalate to the type-specific permission. The active check runs LAST
// so an unauthorized admin never sees "Scanner désactivé" either — they
// are redirected before that render happens. `checkin.validate` is
// DELIBERATELY not accepted — see lib/admin/scanner-permission.ts.
export default async function ScanPage({
  params
}: {
  params: Promise<{ "access-point-slug": string }>;
}) {
  // Step 1: floor auth. Middleware already enforces the admin cookie;
  // requireAdmin adds the session-still-valid + status ACTIVE check.
  await requireAdmin();

  // Step 2: reject malformed slugs before any DB access.
  const raw = (await params)["access-point-slug"];
  const parsed = slugSchema.safeParse(raw);
  if (!parsed.success) notFound();

  // Step 3–4: dynamic DB resolution. No hardcoded slug→point map anywhere.
  const point = await getAccessPointBySlug(parsed.data);
  if (!point) notFound();

  // Step 5–6: type-derived strict permission. Runs BEFORE the active
  // check so an unauthorized admin cannot even confirm whether a point
  // is deactivated — they get redirected first.
  const requiredPerm = requiredScannerPermission(point.type);
  const { user } = await requirePermission(requiredPerm);

  // Step 7: active check. Disabled points render a clean refusal — the
  // camera is never even asked for, because <ScannerClient> is only
  // rendered on the happy path below.
  if (!point.active) {
    return (
      <>
        <AdminHeader
          user={user}
          title={`Scanner — ${point.name}`}
          subtitle="Point d'accès désactivé"
        />
        <div className="space-y-4 p-6">
          <Link
            href="/admin/scan"
            className="inline-flex items-center gap-1 text-[12px] font-semibold text-ink/60 hover:text-ink"
          >
            ← Centre de scan
          </Link>
          <section className="rounded-card border border-amber-300/60 bg-amber-50 p-6">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-amber-900/80">
              Scanner indisponible
            </p>
            <h2 className="mt-3 font-display text-xl font-black tracking-tight text-amber-900">
              Ce point d&apos;accès est actuellement désactivé.
            </h2>
            <p className="mt-3 text-[13px] leading-relaxed text-amber-900/80">
              Un administrateur peut le réactiver depuis{" "}
              <a
                href="/admin/access-points"
                className="font-semibold underline hover:no-underline"
              >
                Access points
              </a>
              . Aucun scan ne sera accepté tant que le point reste
              désactivé.
            </p>
          </section>
        </div>
      </>
    );
  }

  return (
    <>
      <AdminHeader
        user={user}
        title={`Scanner — ${point.name}`}
        subtitle={
          point.type === "MAIN_ENTRANCE" ? "Entrée principale" : "Salle"
        }
      />
      <div className="space-y-4 p-6">
        <Link
          href="/admin/scan"
          className="inline-flex items-center gap-1 text-[12px] font-semibold text-ink/60 hover:text-ink"
        >
          ← Centre de scan
        </Link>
        <ScannerClient
          accessPointName={point.name}
          accessPointType={point.type}
          accessPointSlug={point.slug}
        />
      </div>
    </>
  );
}
