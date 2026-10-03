import Link from "next/link";
import { requirePermission } from "@/lib/admin/auth";
import { canWithOverrides } from "@/lib/admin/rbac";
import { AdminHeader } from "@/components/admin/header";
import { backupConfigStatus } from "@/lib/backup/config";
import { getScheduleAction } from "../actions";
import { ScheduleForm } from "./_ui/schedule-form";
import { ManualRetentionButton } from "../_ui/action-buttons";
import { loadDriveSubsystemSnapshot } from "../replication/query";
import { BootstrapDriveFolderButton } from "../replication/_ui/action-buttons";

export const dynamic = "force-dynamic";

type Tone = "ok" | "warn" | "neutral" | "info";

const TONE_DOT: Record<Tone, string> = {
  ok: "bg-lime",
  warn: "bg-amber-500",
  neutral: "bg-ink/30",
  info: "bg-cobalt"
};

const TONE_CHIP: Record<Tone, string> = {
  ok: "bg-lime/25 text-ink",
  warn: "bg-amber-100 text-amber-900",
  neutral: "bg-ink/10 text-ink/70",
  info: "bg-cobalt/10 text-cobalt"
};

function formatDate(value: string | Date | null | undefined) {
  if (!value) return null;
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

// ─── Presentational helpers ────────────────────────────────────────────────

function Icon({
  name
}: {
  name: "clock" | "trash" | "cloud" | "terminal" | "shield";
}) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true
  };
  switch (name) {
    case "clock":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      );
    case "trash":
      return (
        <svg {...common}>
          <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
        </svg>
      );
    case "cloud":
      return (
        <svg {...common}>
          <path d="M7 18a5 5 0 1 1 .9-9.9A6 6 0 0 1 19 11a3.5 3.5 0 0 1-.5 7H7Z" />
        </svg>
      );
    case "terminal":
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="m7 9 3 3-3 3M13 15h4" />
        </svg>
      );
    case "shield":
      return (
        <svg {...common}>
          <path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6l-7-3Z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
  }
}

/** Compact status tile used in the hero. */
function HeroTile({
  label,
  value,
  hint,
  tone
}: {
  label: string;
  value: string;
  hint?: string;
  tone: Tone;
}) {
  return (
    <div className="rounded-card border border-white/10 bg-white/[0.04] p-4 backdrop-blur-sm">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={`h-2 w-2 rounded-full ${TONE_DOT[tone]} ${
            tone === "ok" ? "shadow-[0_0_0_4px_rgba(184,230,46,0.18)]" : ""
          }`}
        />
        <p className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-white/55">
          {label}
        </p>
      </div>
      <p className="mt-3 font-display text-[18px] font-black leading-tight tracking-tight text-white">
        {value}
      </p>
      {hint && <p className="mt-1 text-[11.5px] text-white/50">{hint}</p>}
    </div>
  );
}

/** Section card with icon header and optional status chip. */
function SectionCard({
  id,
  icon,
  eyebrow,
  title,
  description,
  chip,
  children
}: {
  id: string;
  icon: "clock" | "trash" | "cloud" | "terminal" | "shield";
  eyebrow: string;
  title: string;
  description: string;
  chip?: { label: string; tone: Tone };
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-6 overflow-hidden rounded-[20px] border border-line bg-white"
    >
      <header className="flex flex-col gap-4 border-b border-line bg-frost/60 px-6 py-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-ink text-lime">
            <Icon name={icon} />
          </span>
          <div>
            <p className="text-[10.5px] font-bold uppercase tracking-[0.24em] text-cobalt">
              {eyebrow}
            </p>
            <h2 className="mt-1 font-display text-[19px] font-black tracking-tight text-ink">
              {title}
            </h2>
            <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-ink/60">
              {description}
            </p>
          </div>
        </div>
        {chip && (
          <span
            className={`inline-flex shrink-0 items-center gap-2 self-start rounded-full px-3 py-1 text-[11px] font-semibold ${TONE_CHIP[chip.tone]}`}
          >
            <span
              aria-hidden
              className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[chip.tone]}`}
            />
            {chip.label}
          </span>
        )}
      </header>
      <div className="p-6">{children}</div>
    </section>
  );
}

function StatTile({
  label,
  value
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="rounded-card border border-line bg-white p-4">
      <p className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/45">
        {label}
      </p>
      <p className="mt-2 font-display text-[22px] font-black leading-none tracking-tight text-ink tabular-nums">
        {value}
      </p>
    </div>
  );
}

/**
 * Categorical status tile for the Drive subsystem's flag/credentials/
 * folder/reachable labels. NEVER receives a folder id, token, or
 * free-form text — only enum labels.
 */
function DriveCheck({ label, state }: { label: string; state: string }) {
  const positive = state === "OK" || state === "ENABLED";
  const informational =
    state === "NOT_CHECKED" ||
    state === "DISABLED" ||
    state === "NOT_BOOTSTRAPPED";
  const tone: Tone = positive ? "ok" : informational ? "neutral" : "warn";
  return (
    <li
      className={`rounded-card border p-3.5 ${
        positive
          ? "border-lime/50 bg-lime/10"
          : informational
            ? "border-line bg-white"
            : "border-amber-200 bg-amber-50"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={`h-2 w-2 rounded-full ${TONE_DOT[tone]}`}
        />
        <span className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/55">
          {label}
        </span>
      </div>
      <p
        className={`mt-2 font-mono text-[12.5px] font-semibold ${
          tone === "warn" ? "text-amber-900" : "text-ink"
        }`}
      >
        {state}
      </p>
    </li>
  );
}

function EndpointCard({
  title,
  path,
  note
}: {
  title: string;
  path: string;
  note: React.ReactNode;
}) {
  return (
    <div className="rounded-card border border-line bg-white p-4">
      <p className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/45">
        {title}
      </p>
      <div className="mt-3 flex items-center gap-2 overflow-x-auto rounded-btn bg-navy px-3 py-2.5">
        <span className="shrink-0 rounded bg-lime px-1.5 py-0.5 font-mono text-[10px] font-bold text-ink">
          POST
        </span>
        <code className="whitespace-nowrap font-mono text-[12px] text-white/90">
          {path}
        </code>
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-ink/55">{note}</p>
    </div>
  );
}

function NavLink({
  href,
  label,
  step
}: {
  href: string;
  label: string;
  step: number;
}) {
  return (
    <a
      href={href}
      className="group flex items-center gap-3 rounded-btn px-3 py-2 text-[12.5px] font-semibold text-ink/70 transition-colors hover:bg-white hover:text-ink"
    >
      <span
        aria-hidden
        className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-ink/[0.07] text-[10px] font-bold tabular-nums text-ink/60 transition-colors group-hover:bg-cobalt group-hover:text-white"
      >
        {step}
      </span>
      {label}
    </a>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────

export default async function BackupSettingsPage() {
  const { user } = await requirePermission("backup.settings");
  const [result, driveSnapshot, canReplicationSettings, canReplicationView] =
    await Promise.all([
      getScheduleAction(),
      loadDriveSubsystemSnapshot(),
      canWithOverrides(user.role, "backup.replication.settings"),
      canWithOverrides(user.role, "backup.replication.view")
    ]);
  const config = backupConfigStatus();

  if (!result.ok) {
    return (
      <>
        <AdminHeader user={user} title="Paramètres" subtitle="Sauvegardes" />
        <div className="p-6">
          <div
            role="alert"
            className="rounded-card border border-red-200 bg-red-50 p-4 text-[13px] text-red-900"
          >
            <p className="font-semibold">
              Impossible de charger les paramètres.
            </p>
            <p className="mt-1">
              {result.publicMessage}
              <br />
              <span className="font-mono text-[11px]">
                Op {result.operationId}
              </span>
            </p>
          </div>
        </div>
      </>
    );
  }

  const localReady =
    config.encryptionKey === "OK" &&
    config.storageDir === "OK" &&
    config.tickSecret === "OK";

  const driveDisabled = driveSnapshot.status.flag === "DISABLED";
  const driveTone: Tone = driveSnapshot.ready
    ? "ok"
    : driveDisabled
      ? "neutral"
      : "warn";
  const driveLabel = driveSnapshot.ready
    ? "Prête"
    : driveDisabled
      ? "Désactivée"
      : "Configuration incomplète";

  const automationStep = canReplicationView ? 4 : 3;

  return (
    <>
      <AdminHeader user={user} title="Paramètres" subtitle="Sauvegardes" />

      <div className="space-y-6 p-6" id="top">
        {/* ─── Hero ─────────────────────────────────────────────────── */}
        <section className="relative overflow-hidden rounded-[24px] bg-navy p-7 text-white sm:p-8">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-lime/10 blur-[90px]"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-32 left-1/3 h-64 w-64 rounded-full bg-cobalt/20 blur-[100px]"
          />
          <div className="relative">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[10.5px] font-bold uppercase tracking-[0.28em] text-lime">
                Configuration
              </p>
              <Link
                href="/admin/backups"
                className="text-[11.5px] font-semibold text-white/60 transition-colors hover:text-white"
              >
                ← Tableau de bord des sauvegardes
              </Link>
            </div>
            <h1 className="mt-3 font-display text-[28px] font-black leading-tight tracking-tight sm:text-[32px]">
              Sauvegardes &amp; restauration
            </h1>
            <p className="mt-3 max-w-3xl text-[13.5px] leading-relaxed text-white/60">
              Le planificateur crée périodiquement une sauvegarde chiffrée. La
              réplication Google Drive expédie la copie chiffrée vers un
              stockage indépendant. Les deux états sont affichés séparément :
              une panne distante ne peut jamais dégrader le statut d&apos;une
              sauvegarde locale vérifiée.
            </p>

            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <HeroTile
                label="Stockage local"
                value={localReady ? "Prêt" : "Incomplet"}
                hint={
                  localReady
                    ? "Clé, répertoire et secret valides"
                    : "Une variable requise manque"
                }
                tone={localReady ? "ok" : "warn"}
              />
              <HeroTile
                label="Planificateur"
                value={
                  result.enabled
                    ? `Toutes les ${result.frequencyHours}h`
                    : "Désactivé"
                }
                hint={
                  result.enabled
                    ? `Conserve ${result.retentionCount} sauvegardes`
                    : "Aucune sauvegarde automatique"
                }
                tone={result.enabled ? "ok" : "neutral"}
              />
              {canReplicationView && (
                <HeroTile
                  label="Google Drive"
                  value={driveLabel}
                  hint={
                    driveSnapshot.lastReconciledAt
                      ? `Réconcilié ${formatDate(driveSnapshot.lastReconciledAt)}`
                      : "Jamais réconcilié"
                  }
                  tone={driveTone}
                />
              )}
            </div>
          </div>
        </section>

        {/* ─── Body: sticky nav + sections ──────────────────────────── */}
        <div className="grid items-start gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
          <nav
            aria-label="Sections des paramètres"
            className="rounded-card border border-line bg-frost p-2 lg:sticky lg:top-6"
          >
            <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.24em] text-ink/40">
              Sur cette page
            </p>
            <div className="flex flex-wrap gap-1 lg:flex-col">
              <NavLink href="#planificateur" label="Planificateur" step={1} />
              <NavLink href="#retention" label="Rétention" step={2} />
              {canReplicationView && (
                <NavLink href="#drive" label="Google Drive" step={3} />
              )}
              <NavLink
                href="#automation"
                label="Automatisation"
                step={automationStep}
              />
            </div>
          </nav>

          <div className="space-y-6">
            {/* Section 1 · Planificateur */}
            <SectionCard
              id="planificateur"
              icon="clock"
              eyebrow="Automatisation"
              title="Planificateur"
              description="Configurer la fréquence des sauvegardes automatiques et la politique de rétention. Les modifications sont auditées."
              chip={{
                label: result.enabled
                  ? `Activé · toutes les ${result.frequencyHours}h`
                  : "Désactivé",
                tone: result.enabled ? "info" : "neutral"
              }}
            >
              <ScheduleForm
                initial={{
                  enabled: result.enabled,
                  frequencyHours: result.frequencyHours,
                  retentionCount: result.retentionCount,
                  retentionAgeDays: result.retentionAgeDays
                }}
              />
            </SectionCard>

            {/* Section 2 · Rétention manuelle */}
            <SectionCard
              id="retention"
              icon="trash"
              eyebrow="Cycle de vie"
              title="Rétention manuelle"
              description="Lance un cycle de prune immédiat. Ne supprime jamais la dernière sauvegarde COMPLETED/VERIFIED ni un instantané référencé par une restauration en cours."
            >
              <div className="grid gap-3 sm:grid-cols-3">
                <StatTile label="Cible conservée" value={result.retentionCount} />
                <StatTile
                  label="Âge maximum"
                  value={
                    result.retentionAgeDays === 0
                      ? "Illimité"
                      : `${result.retentionAgeDays} j`
                  }
                />
                <StatTile label="Plancher de sécurité" value="1 min." />
              </div>
              <div className="mt-5 flex flex-col gap-3 rounded-card border border-line bg-ink/[0.02] p-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="max-w-lg text-[12.5px] leading-relaxed text-ink/65">
                  Applique immédiatement la politique ci-dessus aux sauvegardes
                  existantes, sans attendre le prochain cycle du planificateur.
                </p>
                <div className="shrink-0">
                  <ManualRetentionButton />
                </div>
              </div>
            </SectionCard>

            {/* Section 3 · Google Drive */}
            {canReplicationView && (
              <SectionCard
                id="drive"
                icon="cloud"
                eyebrow="Réplication distante"
                title="Google Drive"
                description="État de la copie chiffrée hors-site. Aucun secret (client secret, refresh token, access token, folder id) n'est jamais affiché ici."
                chip={{ label: driveLabel, tone: driveTone }}
              >
                <div className="space-y-5">
                  <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <DriveCheck label="Flag" state={driveSnapshot.status.flag} />
                    <DriveCheck
                      label="Credentials"
                      state={driveSnapshot.status.credentials}
                    />
                    <DriveCheck
                      label="Dossier"
                      state={driveSnapshot.status.folder}
                    />
                    <DriveCheck
                      label="Accessibilité"
                      state={driveSnapshot.status.reachable}
                    />
                  </ul>

                  <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <div className="rounded-card border border-line p-4">
                      <dt className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/45">
                        Nom du dossier
                      </dt>
                      <dd className="mt-2 break-words font-mono text-[12.5px] text-ink">
                        {driveSnapshot.folderName}
                      </dd>
                    </div>
                    <div className="rounded-card border border-line p-4">
                      <dt className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/45">
                        Initialisé
                      </dt>
                      <dd className="mt-2 text-[12.5px] text-ink">
                        {driveSnapshot.bootstrapped ? (
                          (driveSnapshot.bootstrappedAt
                            ? formatDate(driveSnapshot.bootstrappedAt)
                            : "oui")
                        ) : (
                          <span className="text-amber-900">
                            non — exécuter{" "}
                            <code className="font-mono text-[11.5px]">
                              scripts/backup-drive-bootstrap.ts
                            </code>
                          </span>
                        )}
                      </dd>
                    </div>
                    <div className="rounded-card border border-line p-4">
                      <dt className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink/45">
                        Dernière réconciliation
                      </dt>
                      <dd className="mt-2 text-[12.5px] text-ink">
                        {formatDate(driveSnapshot.lastReconciledAt) ?? "—"}
                      </dd>
                    </div>
                  </dl>

                  {canReplicationSettings ? (
                    <div className="flex flex-col gap-3 rounded-card border border-line bg-ink/[0.02] p-4 sm:flex-row sm:items-center sm:justify-between">
                      <p className="max-w-lg text-[12.5px] leading-relaxed text-ink/70">
                        La redécouverte cherche le dossier via son marker Drive
                        et met à jour la ligne de configuration. Elle ne crée
                        aucun nouveau dossier — la première initialisation
                        reste le domaine du script CLI opérateur.
                      </p>
                      <div className="shrink-0">
                        <BootstrapDriveFolderButton />
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 rounded-card border border-line bg-ink/[0.02] px-4 py-3 text-[12px] text-ink/55">
                      <Icon name="shield" />
                      <span>
                        Permission requise pour lancer la redécouverte :{" "}
                        <code className="font-mono">
                          backup.replication.settings
                        </code>
                        .
                      </span>
                    </div>
                  )}
                </div>
              </SectionCard>
            )}

            {/* Section 4 · Cron externe */}
            <SectionCard
              id="automation"
              icon="terminal"
              eyebrow="Infrastructure"
              title="Automatisation cron"
              description="Le planificateur et le worker de réplication sont déclenchés par un cron externe. La comparaison de secret est en temps constant côté serveur."
            >
              <div className="grid gap-3 md:grid-cols-2">
                <EndpointCard
                  title="Sauvegarde locale"
                  path="/api/internal/backup/tick"
                  note={
                    <>
                      Header{" "}
                      <code className="font-mono">x-internal-secret</code> =
                      valeur de{" "}
                      <code className="font-mono">
                        INTERNAL_BACKUP_TICK_SECRET
                      </code>
                      .
                    </>
                  }
                />
                <EndpointCard
                  title="Réplication Google Drive"
                  path="/api/internal/backup/replicate/tick"
                  note="Même header, même secret. Une cadence externe distincte est recommandée."
                />
              </div>
              <div className="mt-5 flex items-center justify-between border-t border-line pt-4">
                <Link
                  href="/admin/audit-log?entity=BackupSchedule"
                  className="text-[12px] font-semibold text-cobalt hover:underline"
                >
                  Voir le journal d&apos;audit du planificateur →
                </Link>
                <a
                  href="#top"
                  className="text-[11px] font-semibold text-ink/40 hover:text-cobalt"
                >
                  ↑ Haut de page
                </a>
              </div>
            </SectionCard>
          </div>
        </div>
      </div>
    </>
  );
}
