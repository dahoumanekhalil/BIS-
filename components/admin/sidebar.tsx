"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import type { Permission } from "@/lib/admin/rbac";

type NavItem = {
  href: string;
  label: string;
  icon: React.ReactNode;
  permission: Permission;
  soon?: boolean;
};

type NavGroup = {
  title: string;
  items: NavItem[];
};

const GROUPS: NavGroup[] = [
  {
    title: "Overview",
    items: [
      {
        href: "/admin/dashboard",
        label: "Dashboard",
        permission: "dashboard.view",
        icon: <Icon d="M3 12l9-8 9 8v9a1 1 0 01-1 1h-5v-6h-6v6H4a1 1 0 01-1-1z" />
      }
    ]
  },
  {
    title: "Attendees",
    items: [
      {
        href: "/admin/registrants",
        label: "Registrants",
        permission: "registrants.view",
        icon: (
          <Icon d="M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0" />
        )
      },
      {
        href: "/admin/check-in",
        label: "Check-in",
        permission: "checkin.view",
        icon: (
          <Icon d="M5 12l4 4L19 6" />
        )
      },
      // Phase 16 — QR Operations. Sidebar visibility gated by
      // checkin.view (the same permission that already gates the
      // existing manual check-in page). Per-scanner authorization is
      // enforced server-side inside each route via
      // requirePermission("access.validate.main"|".room") — hiding
      // the entry is UX only.
      {
        href: "/admin/scan",
        label: "Centre de scan",
        permission: "checkin.view",
        icon: <Icon d="M4 7h4V3M20 7h-4V3M4 17h4v4M20 17h-4v4M9 12h6M12 9v6" />
      },
      {
        href: "/admin/applications",
        label: "Applications",
        permission: "applications.view",
        icon: (
          <Icon d="M8 4h9l3 3v13a1 1 0 01-1 1H8a1 1 0 01-1-1V5a1 1 0 011-1zM7 8H5a1 1 0 00-1 1v10a1 1 0 001 1h9M10 12h6M10 16h4" />
        )
      }
    ]
  },
  {
    title: "Event",
    items: [
      {
        href: "/admin/sessions",
        label: "Sessions",
        permission: "sessions.view",
        icon: <Icon d="M4 6h16v12H4z M4 10h16" />
      },
      {
        href: "/admin/speakers",
        label: "Speakers",
        permission: "speakers.view",
        icon: <Icon d="M12 12a4 4 0 100-8 4 4 0 000 8zM6 21a6 6 0 0112 0" />
      },
// Phase 8 — AccessPoint administration. Read gated by access.view;
      // mutations require settings.manage (checked server-side).
      {
        href: "/admin/access-points",
        label: "Access points",
        permission: "access.view",
        icon: <Icon d="M12 2l9 4v6c0 5-3.5 9-9 10-5.5-1-9-5-9-10V6z M9 12l2 2 4-4" />
      },
      // Phase 17 — Space management (operational view over AccessPoint).
      // Same permission gates as Phase 8 (access.view / settings.manage).
      // Reachable from /admin/access-points → "Gestion des espaces →"
      // instead of the sidebar to reduce nav duplication.
      {
        href: "/admin/amenities",
        label: "Amenities",
        permission: "amenities.view",
        soon: true,
        icon: <Icon d="M4 20l4-8 4 4 4-6 4 10H4z" />
      },
      {
        href: "/admin/itineraries",
        label: "Itineraries",
        permission: "itineraries.view",
        soon: true,
        icon: <Icon d="M4 6h16M4 12h10M4 18h16" />
      }
    ]
  },
  {
    title: "Business",
    items: [
      {
        href: "/admin/sponsors",
        label: "Sponsors",
        permission: "sponsors.view",
        icon: <Icon d="M12 2l3 6 6 1-4.5 4.5L18 20l-6-3-6 3 1.5-6.5L3 9l6-1z" />
      }
      // Revenue entry removed in Payment-removal Phase 2. The page
      // itself was deleted alongside the payment gate.
    ]
  },
  {
    title: "Analytics",
    items: [
      {
        href: "/admin/analytics",
        label: "Analytics",
        permission: "analytics.view",
        soon: true,
        icon: <Icon d="M4 20V10M10 20V4M16 20v-8M22 20H2" />
      }
    ]
  },
  {
    title: "System",
    items: [
      {
        href: "/admin/users",
        label: "Users",
        permission: "users.manage",
        icon: <Icon d="M17 21v-2a4 4 0 00-4-4H7a4 4 0 00-4 4v2M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
      },
      {
        href: "/admin/roles",
        label: "Roles",
        permission: "roles.manage",
        icon: <Icon d="M12 2l9 4v6c0 5-3.5 9-9 10-5.5-1-9-5-9-10V6z" />
      },
      {
        href: "/admin/audit-log",
        label: "Audit log",
        permission: "audit.view",
        icon: <Icon d="M4 6h16M4 12h16M4 18h10" />
      },
      {
        href: "/admin/settings",
        label: "Settings",
        permission: "settings.manage",
        icon: <Icon d="M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
      }
    ]
  }
];

function Icon({ d }: { d: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

export function AdminSidebar({
  allowedPermissions
}: {
  allowedPermissions: Permission[];
}) {
  const pathname = usePathname();
  const allowed = new Set(allowedPermissions);

  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-white/[0.06] bg-navy text-white md:flex">
      <Link
        href="/admin/dashboard"
        className="flex items-center gap-2 border-b border-white/[0.06] px-5 py-5"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-lime font-display text-[13px] font-black text-ink">
          B
        </span>
        <div className="min-w-0">
          <p className="font-display text-[14px] font-black leading-none tracking-tight">
            BIS Ops
          </p>
          <p className="mt-1 text-[9.5px] font-semibold uppercase tracking-[0.22em] text-white/45">
            15 · 17 Nov 2027
          </p>
        </div>
      </Link>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <ul className="space-y-6">
          {GROUPS.map((group) => {
            const items = group.items.filter((i) => allowed.has(i.permission));
            if (items.length === 0) return null;
            return (
              <li key={group.title}>
                <p className="px-2 text-[9px] font-bold uppercase tracking-[0.28em] text-white/35">
                  {group.title}
                </p>
                <ul className="mt-2 space-y-0.5">
                  {items.map((item) => {
                    const active =
                      pathname === item.href ||
                      pathname?.startsWith(item.href + "/");
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          className={cn(
                            "group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[12.5px] font-medium transition-colors",
                            active
                              ? "bg-white/[0.08] text-white"
                              : "text-white/65 hover:bg-white/[0.04] hover:text-white"
                          )}
                        >
                          <span
                            className={cn(
                              "flex h-6 w-6 items-center justify-center rounded-md",
                              active ? "text-lime" : "text-white/50 group-hover:text-white"
                            )}
                          >
                            {item.icon}
                          </span>
                          <span className="flex-1">{item.label}</span>
                          {item.soon && (
                            <span className="rounded-full bg-white/[0.06] px-1.5 py-[1px] text-[8.5px] font-bold uppercase tracking-[0.16em] text-white/50">
                              Bêta
                            </span>
                          )}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-white/[0.06] px-5 py-4 text-[10.5px] uppercase tracking-[0.22em] text-white/40">
        BIS · Ops Console
      </div>
    </aside>
  );
}
