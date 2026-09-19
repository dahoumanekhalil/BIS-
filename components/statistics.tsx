const stats = [
  { value: "12 611", suffix: "+", label: "Participants" },
  { value: "48", suffix: "+", label: "Intervenants" },
  { value: "60", suffix: "+", label: "Sessions" },
  { value: "22", suffix: "", label: "Pays représentés" }
];

export function EventStats() {
  return (
    <section id="stats" className="border-b border-line bg-white">
      <div className="container-page">
        <ul className="grid grid-cols-2 gap-y-10 py-14 sm:py-16 lg:grid-cols-4 lg:gap-y-0 lg:py-20">
          {stats.map((s) => (
            <li
              key={s.label}
              className="flex flex-col items-start lg:items-center lg:text-center"
            >
              <p className="font-display text-stat text-cobalt">
                {s.value}
                <span>{s.suffix}</span>
              </p>
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-ink/60">
                {s.label}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
