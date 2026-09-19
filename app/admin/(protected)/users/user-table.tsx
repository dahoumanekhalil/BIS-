"use client";

import { useState } from "react";
import { AdminRole, AdminStatus } from "@prisma/client";
import { ROLE_LABEL } from "@/lib/admin/rbac";
import { EditUserDialog } from "./edit-user-dialog";
import { DeleteUserButton } from "./delete-user-button";

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  status: AdminStatus;
  lastLoginAt: Date | null;
  createdAt: Date;
};

export function UserTable({ users }: { users: UserRow[] }) {
  const [search, setSearch] = useState("");

  const filtered = users.filter(
    (u) =>
      u.name.toLowerCase().includes(search.toLowerCase()) ||
      u.email.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-4">
      {/* Search */}
      <div className="relative">
        <input
          type="text"
          placeholder="Rechercher par nom ou email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-lg border border-line bg-white px-4 py-2.5 pl-10 text-[13px] text-ink outline-none transition-colors placeholder:text-ink/35 focus:border-ink/30 focus:ring-2 focus:ring-ink/5"
        />
        <svg
          className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/30"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-line bg-white shadow-sm">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-line bg-slate-50/80">
              <th className="px-5 py-3 font-bold uppercase tracking-[0.12em] text-ink/50 text-[10px]">
                Utilisateur
              </th>
              <th className="px-5 py-3 font-bold uppercase tracking-[0.12em] text-ink/50 text-[10px]">
                Rôle
              </th>
              <th className="px-5 py-3 font-bold uppercase tracking-[0.12em] text-ink/50 text-[10px]">
                Statut
              </th>
              <th className="px-5 py-3 font-bold uppercase tracking-[0.12em] text-ink/50 text-[10px]">
                Dernière connexion
              </th>
              <th className="px-5 py-3 font-bold uppercase tracking-[0.12em] text-ink/50 text-[10px] text-right">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/50">
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-5 py-12 text-center text-ink/40"
                >
                  Aucun utilisateur trouvé.
                </td>
              </tr>
            ) : (
              filtered.map((u) => (
                <tr
                  key={u.id}
                  className="group transition-colors hover:bg-slate-50/50"
                >
                  <td className="px-5 py-3.5">
                    <p className="font-semibold text-ink">{u.name}</p>
                    <p className="text-[11.5px] text-ink/50">{u.email}</p>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="inline-flex items-center rounded-md bg-ink/5 px-2 py-0.5 text-[11px] font-bold text-ink/70">
                      {ROLE_LABEL[u.role]}
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    <StatusBadge status={u.status} />
                  </td>
                  <td className="px-5 py-3.5 text-ink/50 tabular-nums">
                    {u.lastLoginAt
                      ? new Intl.DateTimeFormat("fr-FR", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        }).format(u.lastLoginAt)
                      : "—"}
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <div className="flex items-center justify-end gap-2 opacity-0 transition-opacity group-hover:opacity-100">
                      <EditUserDialog user={u} />
                      <DeleteUserButton userId={u.id} userName={u.name} />
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-ink/40 tabular-nums">
        {filtered.length} utilisateur{filtered.length !== 1 ? "s" : ""} affiché
        {filtered.length !== 1 ? "s" : ""}
      </p>
    </div>
  );
}

function StatusBadge({ status }: { status: AdminStatus }) {
  if (status === AdminStatus.ACTIVE) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-bold text-emerald-700">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        Actif
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-0.5 text-[11px] font-bold text-red-600">
      <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
      Désactivé
    </span>
  );
}