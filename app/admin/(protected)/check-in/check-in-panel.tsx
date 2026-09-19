"use client";

import { useState, useTransition, useRef, useEffect } from "react";
import { validateTicket, type CheckInResponse } from "./actions";
import { cn } from "@/lib/utils";

const GATES = ["Gate A", "Gate B", "Gate C", "Gate D"];

export function CheckInPanel({ canValidate }: { canValidate: boolean }) {
  const [gate, setGate] = useState(GATES[0]);
  const [code, setCode] = useState("");
  const [response, setResponse] = useState<CheckInResponse | null>(null);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [response]);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!canValidate || !code.trim()) return;
    startTransition(async () => {
      const r = await validateTicket({ code, gate });
      setResponse(r);
      setCode("");
    });
  }

  const tone =
    response?.ok && response.result === "VALID"
      ? "success"
      : response?.ok && response.result === "ALREADY_CHECKED_IN"
        ? "warn"
        : response
          ? "error"
          : "idle";

  return (
    <div className="space-y-4">
      <form
        onSubmit={submit}
        className="rounded-card border border-line bg-white p-6"
      >
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-ink/50">
            Gate actif
            <select
              value={gate}
              onChange={(e) => setGate(e.target.value)}
              className="rounded-btn border border-line bg-white px-3 py-1.5 text-[13px] font-semibold normal-case tracking-normal text-ink outline-none focus:border-ink/40"
            >
              {GATES.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </label>
          <span className="ml-auto text-[11px] uppercase tracking-[0.22em] text-ink/45">
            Scan / saisie manuelle
          </span>
        </div>

        <label className="block">
          <span className="block text-[10.5px] font-bold uppercase tracking-[0.2em] text-ink/50">
            Code ticket
          </span>
          <div className="mt-2 flex gap-2">
            <input
              ref={inputRef}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="BIS26-XXXXXX"
              autoComplete="off"
              autoFocus
              className="w-full rounded-btn border border-line bg-white px-4 py-3 font-mono text-[15px] tracking-wider text-ink outline-none focus:border-cobalt focus:ring-2 focus:ring-cobalt/15"
              aria-label="Code ticket"
            />
            <button
              type="submit"
              disabled={pending || !canValidate}
              className={cn(
                "inline-flex items-center gap-2 rounded-btn bg-lime px-5 py-3 text-[13.5px] font-bold text-ink transition-all",
                "hover:bg-lime-600 disabled:cursor-not-allowed disabled:opacity-70"
              )}
            >
              {pending ? "Validation…" : "Valider"}
            </button>
          </div>
        </label>

        <p className="mt-3 text-[11.5px] text-ink/45">
          Saisissez le code figurant sur le ticket ou scannez le QR — chaque
          tentative est journalisée.
        </p>
      </form>

      {/* Result panel */}
      <div
        className={cn(
          "rounded-card border p-6 transition-colors",
          tone === "success" && "border-lime bg-lime/10",
          tone === "warn" && "border-amber-400 bg-amber-50",
          tone === "error" && "border-red-300 bg-red-50",
          tone === "idle" && "border-dashed border-line bg-white"
        )}
      >
        {tone === "idle" && (
          <div className="text-center">
            <p className="font-display text-lg font-bold text-ink/50">
              En attente d&apos;un scan.
            </p>
            <p className="mt-1 text-[13px] text-ink/45">
              Le résultat apparaîtra ici en temps réel.
            </p>
          </div>
        )}

        {response && (
          <div>
            <p
              className={cn(
                "font-display text-[10.5px] font-bold uppercase tracking-[0.24em]",
                tone === "success" && "text-lime-600",
                tone === "warn" && "text-amber-700",
                tone === "error" && "text-red-700"
              )}
            >
              {response.result.replace("_", " ")}
            </p>
            <h2 className="mt-2 font-display text-2xl font-black tracking-tight text-ink">
              {response.message}
            </h2>

            {response.participant && (
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <Cell
                  label="Participant"
                  value={`${response.participant.firstName} ${response.participant.lastName}`}
                />
                <Cell
                  label="Tier"
                  value={
                    ("tier" in response.participant &&
                      response.participant.tier) ||
                    "—"
                  }
                />
                <Cell
                  label="Gate autorisé"
                  value={response.participant.gate ?? "Tous"}
                />
                {response.ok && "ticketCode" in response.participant && (
                  <Cell
                    label="Ticket"
                    value={response.participant.ticketCode ?? "—"}
                    mono
                  />
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Cell({
  label,
  value,
  mono
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-btn border border-line bg-white/60 px-4 py-3">
      <p className="text-[10.5px] font-bold uppercase tracking-[0.2em] text-ink/50">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 text-[14px] font-semibold text-ink",
          mono && "font-mono tracking-wider"
        )}
      >
        {value}
      </p>
    </div>
  );
}
