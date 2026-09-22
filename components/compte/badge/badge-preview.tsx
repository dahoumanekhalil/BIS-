"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { BadgeFront } from "./badge-front";
import { BadgeBack } from "./badge-back";
import type { BadgeRole } from "@/lib/badge/role";

// Phase 18 — front/back preview.
//
// Desktop: side-by-side (front + back).
// Mobile: toggle between the two with tabs.
//
// The visible preview and the hidden export containers share the
// SAME BadgeFront / BadgeBack components — no duplicate design.
// Export refs come from the parent (via `useBadgeExport`) and are
// attached to the two off-screen capture wrappers below.

export type BadgePreviewProps = {
  firstName: string;
  lastName: string;
  jobTitle: string | null;
  organization: string | null;
  role: BadgeRole;
  qr: string | null;
  // Phase 19 — secure human-readable check-in code (fallback for
  // manual entry at the scanner).
  checkinCode: string | null;
  // Refs from useBadgeExport(). The parent creates them; we attach.
  frontRef: React.Ref<HTMLDivElement>;
  backRef: React.Ref<HTMLDivElement>;
};

type Face = "front" | "back";

export function BadgePreview({
  firstName,
  lastName,
  jobTitle,
  organization,
  role,
  qr,
  checkinCode,
  frontRef,
  backRef
}: BadgePreviewProps) {
  const [face, setFace] = useState<Face>("front");

  return (
    <div className="grid gap-6">
      {/* Mobile-only tab bar. Hidden at sm+ where both faces show. */}
      <div className="flex gap-2 print-hide sm:hidden">
        <FaceTab
          active={face === "front"}
          onClick={() => setFace("front")}
          label="Face avant"
        />
        <FaceTab
          active={face === "back"}
          onClick={() => setFace("back")}
          label="Face arrière"
        />
      </div>

      {/* Visible previews.
          • Mobile: one at a time, controlled by tabs.
          • sm+: both, side-by-side. */}
      <div className="grid gap-6 sm:grid-cols-2">
        <div
          className={cn(
            "mx-auto w-full max-w-[380px]",
            face === "front" ? "block" : "hidden",
            "sm:block"
          )}
        >
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.22em] text-ink/50 print-hide">
            Face avant
          </p>
          <div className="print-badge">
            <BadgeFront
              firstName={firstName}
              lastName={lastName}
              jobTitle={jobTitle}
              organization={organization}
              role={role}
              qr={qr}
              checkinCode={checkinCode}
            />
          </div>
        </div>

        <div
          className={cn(
            "mx-auto w-full max-w-[380px]",
            face === "back" ? "block" : "hidden",
            "sm:block"
          )}
        >
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.22em] text-ink/50 print-hide">
            Face arrière
          </p>
          <BadgeBack role={role} />
        </div>
      </div>

      {/* Off-screen export containers. Fixed pixel size (720 × 960)
          so PNG/PDF capture produces consistent output regardless of
          viewport. Positioned OUT of view via left:-9999px, not
          `display:none` — html-to-image needs the node to be laid
          out for capture to work. `print-hide` also keeps them out
          of the browser print. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-[9999px] top-0 print-hide"
      >
        <div
          ref={frontRef}
          style={{ width: 720, height: 960, backgroundColor: "#ffffff" }}
        >
          <BadgeFront
            firstName={firstName}
            lastName={lastName}
            jobTitle={jobTitle}
            organization={organization}
            role={role}
            qr={qr}
            checkinCode={checkinCode}
            captureMode
          />
        </div>
        <div
          ref={backRef}
          style={{ width: 720, height: 960, backgroundColor: "#111827" }}
        >
          <BadgeBack role={role} captureMode />
        </div>
      </div>
    </div>
  );
}

function FaceTab({
  active,
  onClick,
  label
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex flex-1 items-center justify-center rounded-btn border px-3 py-2 text-[12px] font-bold transition-colors",
        active
          ? "border-cobalt bg-cobalt text-white"
          : "border-line bg-white text-ink hover:border-cobalt hover:text-cobalt"
      )}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}
