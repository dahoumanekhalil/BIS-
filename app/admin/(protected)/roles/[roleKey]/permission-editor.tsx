"use client";

import { useState, useTransition } from "react";
import { updateRolePermissions } from "@/app/actions/update-role-permissions";
import { OPS, OP_SHORT, STAFF_MODULES, type ModuleAccess, type Op } from "@/lib/admin/role-catalog-data";

type PermState = Record<string, boolean>;

const MODULE_OPS_MAP = Object.fromEntries(
  STAFF_MODULES.map((m) => [m.key, m.ops])
);

export function PermissionEditor({
  roleKey,
  modules,
  baseline
}: {
  roleKey: string;
  modules: ModuleAccess[];
  baseline: PermState;
}) {
  const [perms, setPerms] = useState<PermState>(baseline);
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<{ status: string; message?: string } | null>(null);

  const changedKeys = Object.keys(perms).filter((k) => perms[k] !== baseline[k]);
  const hasChanges = changedKeys.length > 0;

  function toggle(permKey: string) {
    setPerms((prev) => ({ ...prev, [permKey]: !prev[permKey] }));
    setResult(null);
  }

  function save() {
    const payload: Record<string, boolean> = {};
    for (const k of changedKeys) {
      payload[k] = perms[k];
    }
    startTransition(async () => {
      const res = await updateRolePermissions(roleKey, payload);
      setResult(res);
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-[15px] font-black tracking-tight text-ink">
          Modifier les permissions
        </h3>
        {hasChanges && (
          <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-amber-600">
            {changedKeys.length} modification{changedKeys.length > 1 ? "s" : ""} non sauvegardée{changedKeys.length > 1 ? "s" : ""}
          </span>
        )}
      </div>

      <div className="space-y-2">
        {modules.map((mod) => {
          const opsDef = MODULE_OPS_MAP[mod.key];
          if (!opsDef) return null;
          const modOps = OPS.filter((op) => opsDef[op] != null);
          if (modOps.length === 0) return null;

          return (
            <div
              key={mod.key}
              className="flex items-center justify-between rounded-lg border border-line/50 bg-white px-4 py-2.5"
            >
              <div className="min-w-0">
                <p className="text-[12.5px] font-semibold text-ink">{mod.label}</p>
                <p className="truncate text-[10.5px] text-ink/45">{mod.description}</p>
              </div>
              <div className="flex items-center gap-1.5">
                {modOps.map((op) => {
                  const permKey = opsDef[op]!;
                  const granted = perms[permKey] ?? false;
                  const isChanged = permKey in baseline && perms[permKey] !== baseline[permKey];
                  return (
                    <button
                      key={op}
                      type="button"
                      onClick={() => toggle(permKey)}
                      title={`${OP_SHORT[op]} — ${granted ? "autorisé" : "refusé"}${isChanged ? " (modifié)" : ""}`}
                      className={`relative inline-flex h-7 min-w-[28px] cursor-pointer select-none items-center justify-center rounded-md px-2 text-[10px] font-bold uppercase tracking-[0.08em] transition-all active:scale-95 ${
                        granted
                          ? "bg-lime text-ink shadow-[inset_0_-1px_0_rgba(0,0,0,0.08)] hover:bg-lime/80"
                          : "bg-red-100 text-red-600 hover:bg-red-200 hover:text-red-700"
                      } ${isChanged ? "ring-2 ring-amber-400 ring-offset-1" : ""}`}
                    >
                      {OP_SHORT[op]}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-3 pt-2">
        <button
          type="button"
          onClick={save}
          disabled={!hasChanges || isPending}
          className={`rounded-lg px-5 py-2 text-[11px] font-bold uppercase tracking-[0.18em] transition-all ${
            hasChanges && !isPending
              ? "bg-ink text-white hover:bg-ink/90"
              : "cursor-not-allowed bg-ink/10 text-ink/30"
          }`}
        >
          {isPending ? "Sauvegarde…" : "Sauvegarder"}
        </button>
        {result && (
          <span
            className={`text-[11px] font-semibold ${
              result.status === "success" ? "text-emerald-600" : "text-red-500"
            }`}
          >
            {result.message}
          </span>
        )}
      </div>
    </div>
  );
}