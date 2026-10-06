"use client";

import { useState, useTransition } from "react";
import { setBadgeRegenerateRolesAction } from "./actions";

export type RoleRow = {
  role: string;
  label: string;
  granted: boolean;
  // true → shown but not changeable (super admin / your own role)
  locked: boolean;
  lockedReason?: string;
};

export function BadgeRolesForm({ rows }: { rows: RoleRow[] }) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(rows.filter((r) => r.granted).map((r) => r.role))
  );
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const toggle = (role: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });

  const save = () => {
    setMsg(null);
    startTransition(async () => {
      try {
        // The server re-validates everything and ignores locked roles
        // (super admin / the caller's own role).
        const res = await setBadgeRegenerateRolesAction(Array.from(selected));
        setMsg({ ok: res.ok, text: res.message });
      } catch {
        setMsg({ ok: false, text: "Action refusée." });
      }
    });
  };

  return (
    <div>
      <ul className="divide-y divide-line rounded-[16px] border border-line bg-white">
        {rows.map((r) => (
          <li
            key={r.role}
            className="flex items-center justify-between gap-4 px-5 py-3"
          >
            <div>
              <p className="text-[14px] font-semibold text-ink">{r.label}</p>
              {r.locked && r.lockedReason && (
                <p className="text-[11.5px] text-ink/50">{r.lockedReason}</p>
              )}
            </div>
            <label className="inline-flex items-center gap-2 text-[12.5px] font-bold text-ink">
              <input
                type="checkbox"
                checked={r.locked ? r.granted : selected.has(r.role)}
                disabled={r.locked || pending}
                onChange={() => toggle(r.role)}
                className="h-4 w-4"
              />
              Peut régénérer
            </label>
          </li>
        ))}
      </ul>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="inline-flex items-center rounded-btn bg-ink px-4 py-2 text-[12.5px] font-bold text-lime disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Enregistrement…" : "Enregistrer"}
        </button>
        {msg && (
          <p
            role="status"
            className={
              msg.ok
                ? "text-[12.5px] font-semibold text-emerald-800"
                : "text-[12.5px] font-semibold text-red-800"
            }
          >
            {msg.text}
          </p>
        )}
      </div>
    </div>
  );
}
