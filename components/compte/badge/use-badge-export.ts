"use client";

import { useCallback, useRef, useState } from "react";

// Phase 18 — client-side PNG + PDF export.
//
// Design decisions:
//   • Uses `html-to-image` for the DOM → PNG conversion. Two capture
//     targets: `frontRef` and `backRef`. The refs point at hidden
//     off-screen "export containers" that render the badges at a
//     fixed pixel size (independent of viewport) so the output PNG
//     is high-resolution regardless of the user's screen.
//   • Uses `jspdf` for PDF assembly. The PDF contains two pages
//     (front + back), each at a realistic physical size (85 × 113 mm
//     — 3:4 portrait, near business-card proportions). The PNG is
//     placed centred on each page. This mirrors the print flow but
//     produces a downloadable file directly.
//   • No new API endpoint. No server-side rendering. No token or
//     hash leaves the client. The QR image is the same data URL the
//     Phase 5 credential service already returned; capture just
//     rasterises what the user already sees.
//   • DO NOT touch the credential lifecycle. Export never calls
//     `generateOrRotateMyBadge`. Print / PNG / PDF all read the
//     current QR from React state.
//   • Fonts + images: `html-to-image` waits for images and inline
//     styles. We also call `document.fonts.ready` before capture so
//     Alexandria is loaded (avoids fallback-font PNGs).

type CaptureOpts = {
  scale?: number; // Pixel-density multiplier. 3 = high-DPI print.
};

async function waitForFonts(): Promise<void> {
  if (typeof document === "undefined") return;
  try {
    // fonts.ready resolves once all currently declared @font-face
    // faces have loaded (or timed out). It's a Promise on
    // FontFaceSet — cast tightly rather than pull the DOM lib type.
    const fonts = (document as { fonts?: { ready?: Promise<unknown> } })
      .fonts;
    await fonts?.ready;
  } catch {
    // Older browsers: no fonts.ready. Fall through — the image will
    // still render, just with the browser's font-fallback timing.
  }
}

async function nodeToPng(
  node: HTMLElement,
  opts: CaptureOpts = {}
): Promise<string> {
  const { toPng } = await import("html-to-image");
  await waitForFonts();
  // Small delay to give the browser one animation frame to settle
  // any layout that just happened (e.g. font swap).
  await new Promise((r) => requestAnimationFrame(r));
  return toPng(node, {
    // Higher pixel ratio → sharper QR + text.
    pixelRatio: opts.scale ?? 3,
    // The `bacground` fallback is white — avoids transparent PNG on
    // Safari where computed background isn't captured cleanly.
    backgroundColor: "#ffffff",
    // Prevent capture from including any parent overflow.
    cacheBust: true,
    // html-to-image adds a `style` element per capture; harmless.
    skipAutoScale: true
  });
}

function triggerDownload(dataUrl: string, filename: string): void {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Slugify a name for a filename. ASCII only, safe on every OS.
function safeFilenameBase(firstName: string, lastName: string): string {
  const raw = `${firstName}-${lastName}`
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return raw || "badge";
}

export function useBadgeExport(participantName: {
  firstName: string;
  lastName: string;
}) {
  const frontRef = useRef<HTMLDivElement | null>(null);
  const backRef = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState<"png-front" | "png-back" | "pdf" | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);

  const base = safeFilenameBase(
    participantName.firstName,
    participantName.lastName
  );

  const downloadPngFront = useCallback(async () => {
    if (!frontRef.current) return;
    setError(null);
    setBusy("png-front");
    try {
      const png = await nodeToPng(frontRef.current);
      triggerDownload(png, `badge-bis2027-${base}-recto.png`);
    } catch {
      setError("L'export PNG a échoué. Réessayez.");
    } finally {
      setBusy(null);
    }
  }, [base]);

  const downloadPngBack = useCallback(async () => {
    if (!backRef.current) return;
    setError(null);
    setBusy("png-back");
    try {
      const png = await nodeToPng(backRef.current);
      triggerDownload(png, `badge-bis2027-${base}-verso.png`);
    } catch {
      setError("L'export PNG a échoué. Réessayez.");
    } finally {
      setBusy(null);
    }
  }, [base]);

  const downloadPdf = useCallback(async () => {
    if (!frontRef.current || !backRef.current) return;
    setError(null);
    setBusy("pdf");
    try {
      // Import jsPDF lazily so the PDF library is not pulled into
      // the initial /compte/badge bundle. Only the click cost.
      const { jsPDF } = await import("jspdf");
      const [frontPng, backPng] = await Promise.all([
        nodeToPng(frontRef.current),
        nodeToPng(backRef.current)
      ]);

      // Physical badge dimensions: 85 × 113 mm (3:4 portrait, close
      // to standard ISO badge stock).
      const PAGE_W = 85;
      const PAGE_H = 113;
      const doc = new jsPDF({
        unit: "mm",
        format: [PAGE_W, PAGE_H],
        orientation: "portrait",
        compress: true
      });

      // Front page.
      doc.addImage(frontPng, "PNG", 0, 0, PAGE_W, PAGE_H, undefined, "FAST");
      // Back page.
      doc.addPage([PAGE_W, PAGE_H], "portrait");
      doc.addImage(backPng, "PNG", 0, 0, PAGE_W, PAGE_H, undefined, "FAST");

      doc.save(`badge-bis2027-${base}.pdf`);
    } catch {
      setError("L'export PDF a échoué. Réessayez.");
    } finally {
      setBusy(null);
    }
  }, [base]);

  const doPrint = useCallback(() => {
    // Reuse the existing print CSS (globals.css `@media print`) —
    // the front badge is rendered inside a `.print-badge` container
    // that the media rules already isolate. No mutation, no server
    // call, no credential rotation.
    if (typeof window !== "undefined") window.print();
  }, []);

  return {
    frontRef,
    backRef,
    busy,
    error,
    downloadPngFront,
    downloadPngBack,
    downloadPdf,
    doPrint
  };
}
