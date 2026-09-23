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
