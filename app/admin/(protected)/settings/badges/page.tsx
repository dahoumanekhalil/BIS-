import { redirect } from "next/navigation";
import { AdminRole } from "@prisma/client";
import { requireAdmin } from "@/lib/admin/auth";
import {
  BADGE_REGENERATE_FORBIDDEN_ROLES,
  canWithOverrides,
  ROLE_LABEL
} from "@/lib/admin/rbac";
import { AdminHeader } from "@/components/admin/header";
import { BadgeRolesForm, type RoleRow } from "./roles-form";

// Settings → Badges: choose which admin roles may regenerate (and view) a
// participant's QR code. Requires `roles.manage`; the server action
// re-checks it. Hiding this page is UX, not the security boundary.
export default async function BadgeSettingsPage() {
  const { user } = await requireAdmin();
  if (!(await canWithOverrides(user.role, "roles.manage"))) {
    redirect("/admin/settings");
  }

  const rows: RoleRow[] = [];
  for (const role of Object.values(AdminRole)) {
    const granted = await canWithOverrides(role, "badge.regenerate");
    const isSuper = role === AdminRole.SUPER_ADMIN;
    const isSelf = role === user.role;
    const isForbidden = BADGE_REGENERATE_FORBIDDEN_ROLES.includes(role);
    rows.push({
      role,
      label: ROLE_LABEL[role],
      granted: isSuper ? true : granted,
      locked: isSuper || isSelf || isForbidden,
      lockedReason: isSuper
        ? "Toujours autorisé."
        : isSelf
          ? "Vous ne pouvez pas modifier votre propre rôle."
          : isForbidden
            ? "Non autorisé pour ce rôle (sécurité)."
            : undefined
    });
  }

  return (
    <>
      <AdminHeader user={user} title="Badges" subtitle="Settings" />
      <div className="max-w-3xl space-y-6 p-6">
        <div>
          <h2 className="font-display text-2xl font-black tracking-tight text-ink">
            Qui peut régénérer le QR code ?
          </h2>
          <p className="mt-3 text-[14px] leading-relaxed text-ink/65">
            Régénérer un QR invalide définitivement l&apos;ancien et remplace
            aussi le code de secours imprimé sur le badge. Pour autoriser
            aussi l&apos;affichage du QR actuel, ou révoquer un badge, utilisez
            la page détaillée du rôle (Rôles &amp; Permissions). Les
            participants ne peuvent jamais régénérer leur QR. Chaque
            modification est enregistrée dans le journal d&apos;audit.
          </p>
          <p className="mt-3 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-[12.5px] leading-relaxed text-amber-900">
            Attention : un rôle autorisé peut afficher le QR actif de
            n&apos;importe quel participant et donc se présenter à sa place
            aux scanners. Évitez d&apos;accorder cette permission aux rôles
            opérationnels (contrôle d&apos;accès, lecture seule).
          </p>
        </div>
        <BadgeRolesForm rows={rows} />
      </div>
    </>
  );
}
