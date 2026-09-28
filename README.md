# BIS 2027 — Ops platform

Next.js + Prisma + PostgreSQL application for the Algeria Brand Impact
Summit 2027 (BIS 2027): public registration, participant accounts, admin
console, badge/QR access control, room registrations, and transactional
email.

Detailed subsystem documentation lives under [`docs/`](./docs/).

---

## Local setup

```bash
npm install
npx prisma generate
# Docker Postgres per CLAUDE.md: admin/secret123 → getplus_summit_2026
npm run db:push
npm run db:seed
npm run dev
```

The demo admin credentials are documented in `.env.example`.

## Environment variables

See [`.env.example`](./.env.example) for the full list. The two email-
infrastructure secrets that MUST be set on every deployment:

```
EMAIL_SECRET_ENCRYPTION_KEY   # 32-byte AES-GCM key for SMTP password at rest
INTERNAL_EMAIL_TICK_SECRET    # ≥24-char secret for the worker cron endpoint
```

Generate them with:

```bash
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))"
node -e "process.stdout.write(require('crypto').randomBytes(48).toString('base64url'))"
```

## Email / SMTP infrastructure

Full guide: [`docs/EMAIL-INFRASTRUCTURE.md`](./docs/EMAIL-INFRASTRUCTURE.md).

Configure SMTP at `/admin/settings/email` (requires `settings.manage`).
The password is encrypted at rest with AES-256-GCM and is never
returned to the browser. ENV variables (`SMTP_*`) override the DB.

Trigger the worker with an external scheduler:

```
POST /api/internal/email/tick
Header: x-internal-secret: <INTERNAL_EMAIL_TICK_SECRET>
```

Windows Task Scheduler is the primary option in the current environment;
systemd timers and Vercel Cron are documented alternatives.

Emails always flow through `lib/email/queue.ts` → `lib/email/worker.ts`
→ `lib/email/service.ts` → `lib/email/transport.ts` (nodemailer). No
module bypasses the queue.

## Access control

Full guide: [`docs/BIS-2027-ACCESS-SYSTEM-IMPLEMENTATION.md`](./docs/BIS-2027-ACCESS-SYSTEM-IMPLEMENTATION.md).

## Backup & Restore

Operator runbook: [`BACKUP_RESTORE_OPERATOR_RUNBOOK.md`](./BACKUP_RESTORE_OPERATOR_RUNBOOK.md).
Production checklist: [`BACKUP_RESTORE_PRODUCTION_CHECKLIST.md`](./BACKUP_RESTORE_PRODUCTION_CHECKLIST.md).
Final security review: [`BACKUP_RESTORE_FINAL_SECURITY_REVIEW.md`](./BACKUP_RESTORE_FINAL_SECURITY_REVIEW.md).
Production deployment gate: [`BACKUP_RESTORE_PRODUCTION_DEPLOYMENT_GATE.md`](./BACKUP_RESTORE_PRODUCTION_DEPLOYMENT_GATE.md).

**Scope note.** The shipped subsystem provides encrypted OPERATIONAL
backup + restore on the local filesystem. It does **not** replicate
backup files off-host on its own — off-host disaster-recovery
replication is the operator's responsibility (rsync / snapshot /
object-store sync). Local encrypted backups protect against DB
corruption, application bugs, and operator error; they do NOT protect
against host loss, VM deletion, disk failure, ransomware, or accidental
server deletion. See the deployment-gate document for the full DR
assessment.

**Monitoring model.** Failures are visible only via `/admin/backups`
and `/admin/audit-log`. The application does NOT send email / Slack /
PagerDuty alerts. Operators must adopt an explicit daily-check cadence
or wire external alerting against the audit log independently.

Architecture at a glance:

- **Encryption** — AES-256-GCM streaming, IV/tag framing, HKDF-derived
  encryption key + manifest HMAC key with domain separation. Every
  backup file is `iv || ciphertext || tag`; the accompanying
  `<id>.manifest.json` carries an HMAC over every field.
- **Verification** — 16-stage streaming verifier (`lib/backup/verify.ts`)
  authenticates the manifest before trusting any field, cross-checks
  `manifest.backupId === filename === __meta.backupId`, streams SHA-256
  in bounded memory, and produces one of 23 sanitized failure codes.
- **Restore** — streaming decrypt + validating NDJSON parse, mandatory
  Phase-5 preflight verification, real (dump + verify) safety backup,
  Postgres-transaction destructive apply with two-pass BadgeCredential,
  and post-restore per-model row-count check. Session tables
  (`AdminSession`, `AccountSession`) are wiped atomically — every user
  re-authenticates after a restore.
- **Scheduler** — external cron POSTs `/api/internal/backup/tick` with
  `x-internal-secret`. A transaction-scoped Postgres advisory lock
  makes duplicate cron replays idempotent; the tick derives "due" from
  persisted `BackupSchedule.lastRunAt`; a watchdog reconciles rows
  stuck at `RUNNING` for > 3h.
- **Retention** — deterministic prune (age × count) with five
  protection layers (newest known-good, retention-count set,
  safety-floor of 1, in-flight restore source, in-flight safety
  snapshot). Files are unlinked FIRST, then the DB row is transitioned
  to `DELETED` (never a hard row delete — audit chain preserved).
- **Admin UI** — `/admin/backups` (RSC pages under
  `app/admin/(protected)/backups/**`). Every page starts with
  `await requirePermission("backup.<verb>")`. Restore has a 3-step
  wizard requiring a typed confirmation phrase AND password re-auth.
  Nothing security-sensitive is stored in the browser.

### Required environment variables

```
BACKUP_ENCRYPTION_KEY         # 32 raw bytes, base64url or hex; AES-256-GCM + HMAC
BACKUP_STORAGE_DIR            # absolute path OUTSIDE the app tree
INTERNAL_BACKUP_TICK_SECRET   # ≥24-char shared secret for the cron endpoint
```

Generate:

```bash
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))"
```

Validate before deploy:

```bash
npm run backup:config-check   # exit 0 = ready; exit 1 = do not deploy
```

The check prints only enum status values (`OK` / `MISSING` /
`MALFORMED` / `TOO_SHORT` / `NOT_ABSOLUTE`). It never prints secret
material.

### Development setup

`db:push` is the canonical schema evolution flow for local dev; the
tables are created on first push. For production, apply
[`prisma/sql/2026-backup-restore.sql`](./prisma/sql/2026-backup-restore.sql)
— an idempotent, additive-only SQL delta reviewable in a code review.
Do **not** invent a parallel `prisma migrate` flow; this project has
never used one.

### Production readiness

The backup subsystem is **not automatically enabled**. `BackupSchedule.enabled`
defaults to `false`. Follow the production checklist end-to-end before
enabling scheduled backups on production.

## Testing

```bash
npm run typecheck
npm run lint
npm run build
# unit tests
npm run test:rbac
npm run test:email-crypto
npm run test:email-config
npm run test:email-rate-limit
npm run test:email-templates
# DB-dependent tests
npm run test:email-verification
npm run test:password-reset
npm run test:email-worker
# backup subsystem
npm run test:backup-crypto
npm run test:backup-storage
npm run test:backup-manifest
npm run test:backup-dump
npm run test:backup-verify
npm run test:backup-rbac
npm run test:backup-restore
npm run test:backup-scheduler
npm run test:backup-e2e
# opt-in destructive restore round-trip (wipes the connected DB)
TEST_BACKUP_RESTORE_DESTRUCTIVE=1 npm run test:backup-restore
```

## Security posture

- Admin server actions start with `await requirePermission("<perm>")`;
  layouts alone are never trusted.
- Session tokens (admin + attendee) are stored as `sha256(rawToken)`;
  raw tokens live only in HTTP-only cookies.
- Email-verification and password-reset tokens are also hashed
  (`sha256`) and single-use, with all outstanding reset tokens invalidated
  on a successful password change.
- SMTP passwords are encrypted at rest (AES-256-GCM keyed by
  `EMAIL_SECRET_ENCRYPTION_KEY`) and never returned to the browser.
- Password-reset requests are enumeration-safe: identical response
  whether or not the email matches an account.
- Rate limits protect login, registration, contact, verification, reset,
  and test-email endpoints.
