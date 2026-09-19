const items = [
  "LIVE",
  "12 000 inscrits",
  "6 intervenants confirmés",
  "Inscriptions ouvertes — places limitées",
  "GET+ SUMMIT 2026",
  "CIC Alger",
  "15 Novembre 2026"
];

export function LiveTicker() {
  const stream = Array.from({ length: 4 }, () => items).flat();

  return (
    <div
      className="fixed inset-x-0 top-0 z-50 flex h-[var(--ticker-height)] items-center overflow-hidden text-white"
      style={{ backgroundColor: "#1339B7" }}
      role="status"
      aria-live="polite"
    >
      <div className="pointer-events-none flex min-w-max animate-marquee items-center will-change-transform">
        {stream.map((label, i) => {
          const isLive = label === "LIVE";
          return (
            <span
              key={`${label}-${i}`}
              className="flex items-center whitespace-nowrap"
            >
              {isLive ? (
                <span className="flex items-center gap-1.5 pl-3 pr-2 text-[10px] font-bold uppercase tracking-[0.18em] text-lime">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-pulse-soft rounded-full bg-lime" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-lime" />
                  </span>
                  LIVE
                </span>
              ) : (
                <span className="px-3 text-[10px] font-medium uppercase tracking-[0.16em] text-white/90">
                  {label}
                </span>
              )}
              <span className="text-[10px] text-white/30" aria-hidden>
                •
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
