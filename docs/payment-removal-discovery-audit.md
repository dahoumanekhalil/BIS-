# BIS 2027 — Payment Removal Discovery Audit

> **STATUS — 2026-09-25:** the payment removal is COMPLETE. See
> `docs/payment-removal-final.md` for the current architecture. This
> document is retained as the pre-removal audit and describes the
> HISTORICAL state; every dependency listed below has been removed
> from the codebase, schema, and RBAC. It is preserved so future
> readers can understand what payment surfaces existed before removal
> and why each one was retired.

Read-only investigation performed 2026-09-25 against `HEAD = 9afc381`.

No code, schema, DB, config, or dependency has been modified. This document is the sole output.

Product decision: **BIS 2027 will operate without any payment functionality.** This audit maps every dependency so the removal can be executed safely in a follow-up phase.

## 1. Executive summary

- **No real payment provider is integrated.** Zero SDK, zero webhook route, zero payment env var, zero HTTP client to any PSP. The abstract adapter type in `lib/room-registration/payment-adapter.ts` intentionally throws.
- **Public registration + badge + QR are already payment-free.** The Commit 1 registration refactor removed every payment gate from the public flow. This audit re-verifies.
- **One critical gate remains in check-in.** All three validators (`main-entrance`, `room`, `text-checkin`) refuse a scan when `Participant.paymentStatus !== PAID`, returning `CheckInResult.UNPAID`. This is the single functional path that will break the event if payment data is removed without a replacement rule.
- **Rooms are bimodal.** `AccessPoint.admissionMode ∈ {FREE, PAID}`. FREE rooms already work fully without payment. The PAID branch depends on a provider that does not exist yet — dead code in practice, but load-bearing in the schema.
- **`RoomPaymentEvent`** currently holds 0 rows in dev but exists as append-only audit for future payment reconciliation. Two audit meta helpers write to it defensively.
- **Admin surface**: `/admin/revenue` (KPIs), the registrant edit form (payment fields), and the registrant list (payment filter + payment column) are the only user-facing payment touch points. RBAC has 4 payment-scoped permissions.
- **12 files reference `RoomPaymentEvent`**; **45 files touch `paymentStatus`/`paymentAmount`/`paymentRef`/`paidAt`** (most are tests + scripts).
- **`prisma.OnboardingSession`** is unrelated to payment — do not confuse the two during cleanup.

**Verdict**: `PAYMENT REMOVAL UNDERSTOOD WITH DOCUMENTED BLOCKERS`. Two decisions must be made by product before implementation begins (see §23).

## 2. Current payment architecture

```
                           ┌─────────────────────────────────────┐
                           │  NO external provider integrated   │
                           │  (adapter type exists, unused)     │
                           └─────────────────────────────────────┘
                                          │
                                          ▼
Registration (public)  ─┐                 │
                        │  paymentStatus  │
Participant ────────────┤  paymentAmount  │
(one per event/email)   │  paymentRef     │  ← admin-editable only
                        │  paidAt         │
                        └─────────────────┘
                                  │
             ┌────────────────────┴────────────────────┐
             │                                          │
             ▼                                          ▼
     Badge / QR issuance                       Check-in validators
     ✅ NO payment gate                       ❌ REQUIRE PAID
     (Commit 1 removed it)                    (main-entrance, room, text)
                                                      │
                                                      ▼
                                              CheckIn.result = UNPAID
                                              (used by analytics)

Rooms (separate subsystem):
     AccessPoint.admissionMode = FREE            ← works today
     AccessPoint.admissionMode = PAID            ← needs unimplemented provider
     RoomRegistration.status lifecycle           ← PENDING_PAYMENT / PAID exist
     RoomPaymentEvent (audit trail)              ← 0 rows in dev

Admin:
     /admin/revenue                              ← KPI page (revenue.view)
     /admin/registrants  (list + filter + edit)  ← payment columns + status
     RBAC: revenue.view, revenue.reconcile,
           payment.confirm.room, payment.refund.room
```

## 3. Complete payment inventory

### 3.1 Prisma schema (source of truth: `prisma/schema.prisma`)

| Kind   | Name                               | Location                | Purpose                                           |
|--------|------------------------------------|-------------------------|---------------------------------------------------|
| enum   | `PaymentStatus`                    | line 186–192            | `UNPAID / PENDING / PAID / REFUNDED / FAILED`     |
| field  | `Participant.paymentStatus`        | line 256                | default `UNPAID`                                  |
| field  | `Participant.paymentAmount`        | line 257                | integer DZD minor units                           |
| field  | `Participant.paymentRef`           | line 258                | admin-entered receipt/reference                   |
| field  | `Participant.paidAt`               | line 259                | timestamp — set only when admin flips to PAID     |
| index  | `@@index([paymentStatus])`         | line 283                | supports payment filters                          |
| enum   | `AdmissionMode`                    | line 487–490            | `FREE / PAID`                                     |
| enum   | `RoomRegistrationStatus`           | line 537–545            | `PENDING_PAYMENT / FREE_CONFIRMED / PAID / PAYMENT_FAILED / CANCELLED / REFUNDED / EXPIRED` |
| enum   | `RoomPaymentEventKind`             | line 553–560            | `INIT / CONFIRM / FAIL / REFUND / CANCEL / ADMIN_OVERRIDE` |
| field  | `AccessPoint.priceMinor`           | line 600                | nullable                                          |
| field  | `AccessPoint.currency`             | line 604                | nullable                                          |
| field  | `RoomRegistration.priceMinorSnapshot` | line 931             | frozen at registration                            |
| field  | `RoomRegistration.currencySnapshot` | line 932               | frozen                                            |
| field  | `RoomRegistration.paymentRef`      | line 936                | provider ref, admin-null                          |
| field  | `RoomRegistration.paidAt`          | line 941                |                                                   |
| index  | `@@index([paymentRef])` on RoomReg | line 959                |                                                   |
| model  | `RoomPaymentEvent`                 | line 966+               | append-only audit                                 |
| enum-value | `CheckInResult.UNPAID`         | line 797                | returned when validator refuses                   |

### 3.2 Application code

| File                                                              | Role      | Payment usage                                             |
|-------------------------------------------------------------------|-----------|-----------------------------------------------------------|
| `lib/room-registration/service.ts`                                | Domain    | Full state machine for paid room registrations            |
| `lib/room-registration/payment-adapter.ts`                        | Contract  | Abstract type; `NO_ADAPTER` sentinel that throws          |
| `lib/room-registration/meta-schema.ts`                            | Zod       | Meta schema for `RoomPaymentEvent` rows                   |
| `lib/room-registration/types.ts`                                  | Types     | `TrustedPaymentConfirmation`, `ConfirmPaymentInput`, …    |
| `lib/room-registration/state-machine.ts`                          | Pure      | Transitions include payment states                        |
| `lib/room-registration/sync.ts`                                   | Domain    | Materializes ParticipantAccess from PAID/FREE_CONFIRMED   |
| `lib/room-registration/audit.ts`                                  | Domain    | `auditReconciliation()` — only path for webhook audit     |
| `lib/room-registration/errors.ts`                                 | Errors    | PROVIDER_REF_CONFLICT etc.                                |
| `app/actions/room-registration.ts`                                | Actions   | User-facing FREE-room self-registration + cancel          |
| `app/admin/(protected)/registrants/[id]/room-payment-actions.ts`  | Actions   | Admin confirm / refund / cancel room payment              |
| `app/admin/(protected)/registrants/[id]/room-registrations-panel.tsx` | UI    | Per-room state + admin controls                            |
| `components/compte/room-registration-controls.tsx`                | UI        | Attendee-side self-service + `isPaid` branching           |
| `lib/email/triggers/room-registration.ts`                         | Email     | `TEMPLATE_KEY[status]` — includes payment transitions     |
| `scripts/expire-room-registrations.ts`                            | Script    | Batch expiry of `PENDING_PAYMENT`                          |
| `scripts/apply-room-payment-idempotency.ts`                       | Migration | Partial unique index on `RoomPaymentEvent(reg, ref)`      |

### 3.3 Admin surface (payment-only)

| Path                                            | Role                                       |
|-------------------------------------------------|--------------------------------------------|
| `app/admin/(protected)/revenue/page.tsx`        | KPI page: paid count, revenue sum, pending, refunded |
| `components/admin/sidebar.tsx:127`              | "Revenue" nav link                         |
| `app/admin/(protected)/registrants/page.tsx`    | Filters `payment` param                    |
| `app/admin/(protected)/registrants/filter-bar.tsx:12` | Payment filter dropdown               |
| `app/admin/(protected)/registrants/registrant-row.tsx:64,143` | "PAID" pill on the row list      |
| `app/admin/(protected)/registrants/[id]/edit/edit-form.tsx:14` | Payment fields dropdown         |
| `app/admin/(protected)/registrants/actions.ts:43,83,109-115,131-136` | `updateRegistrant` writes paymentStatus / paymentAmount / paymentRef / paidAt |
| `app/admin/(protected)/registrants/[id]/email/composer.tsx` | Payment tokens in template variables      |
| `app/admin/(protected)/registrants/[id]/logs/page.tsx` | Displays payment history rows       |
| `lib/admin/queries.ts:43-53,141-165,296-328`    | Revenue aggregation + payment select      |
| `lib/admin/rbac.ts:37-38,113-114,203-213`       | 4 permissions: `revenue.view`, `revenue.reconcile`, `payment.confirm.room`, `payment.refund.room` |
| `lib/admin/role-catalog-data.ts:152-158`        | "revenue" role-catalog section             |
| `lib/admin/client-logs.ts:484`                  | Renders `UNPAID` check-in results          |

### 3.4 Attendee surface (public-facing)

| Path                                            | Payment usage                                   |
|-------------------------------------------------|-------------------------------------------------|
| `app/compte/inscription/page.tsx:70`            | Displays `PAYMENT_LABEL[participant.paymentStatus]` — read-only status pill |
| `components/compte/room-registration-controls.tsx:113` | `isPaid` branch for the room self-service form  |
| `app/compte/acces/page.tsx`                     | Lists room registrations; shows their `status` |

No public registration action (visitor / speaker / sponsor / partner / content-creator) reads or writes any payment field.

### 3.5 Check-in validators (CRITICAL)

| File                                     | Gate line | Behaviour                                                                            |
|------------------------------------------|-----------|--------------------------------------------------------------------------------------|
| `lib/admin/main-entrance-validator.ts`   | 269       | `if (participant.paymentStatus !== PaymentStatus.PAID) return CheckInResult.UNPAID`  |
| `lib/admin/room-validator.ts`            | 238       | Same gate                                                                            |
| `lib/admin/text-checkin-validator.ts`    | 297       | Same gate                                                                            |

**These are the operational blocker.** With payment removed but paymentStatus still `UNPAID` on new registrations, no attendee can enter.

### 3.6 Configuration

Payment env vars: **none**.
Payment SDK deps: **none** (verified in `package.json`).
Payment API/webhook routes: **none** (`app/api/**` contains only email + speaker-logout).
Payment configuration files: **none**.

## 4. Routes and UI

Public routes with payment:
- `/compte/inscription` — read-only status label.
- `/compte/acces` — room registrations panel (payment for PAID rooms).

Admin routes with payment:
- `/admin/revenue` — KPI dashboard.
- `/admin/registrants` — filter by payment, payment pill on rows.
- `/admin/registrants/[id]` — payment fields visible in edit form; room-registration payment panel.
- `/admin/registrants/[id]/logs` — payment history log rows.

No public checkout/pay/order/receipt/invoice/webhook route exists.

## 5. Server actions / APIs

Payment-writing server actions:
- `updateRegistrant` (admin) — writes `paymentStatus`, `paymentAmount`, `paymentRef`, auto-sets `paidAt` when PAID.
- `confirmRoomPaymentAction`, `refundRoomPaymentAction` (admin) — RoomRegistration state transitions.
- `registerForRoom`, `cancelMyRoomRegistration` (attendee) — writes PENDING_PAYMENT for PAID rooms; PAID rooms rely on admin confirmation.

No public payment initiation action exists.

## 6. Database models / fields / enums

See §3.1. Every payment field is nullable or has a default. No FK from `AuditLog` → `RoomPaymentEvent`; `RoomPaymentEvent` cascades via `RoomRegistration`.

Partial unique index on `RoomPaymentEvent(registrationId, providerRef) WHERE providerRef IS NOT NULL` — installed via `scripts/apply-room-payment-idempotency.ts`.

## 7. Provider integrations

**None active.**
- `lib/room-registration/payment-adapter.ts` — abstract `PaymentAdapter` type + `NO_ADAPTER` sentinel that throws.
- Adapter `kind` enum mentions `"stripe" | "chargily" | "cib" | "satim" | "edahabia"` as future values — no concrete implementation exists.
- No env vars, no SDK, no HTTP client, no callback route.

## 8. Environment variables

None. `.env.example` contains only `DATABASE_URL`, `NEXT_PUBLIC_SITE_URL`, admin seed guard, and email configuration (SMTP + Resend). No payment section.

## 9. Package dependencies

Payment-related: **zero**.

`package.json` production deps: `@prisma/client`, `clsx`, `html-to-image`, `html5-qrcode`, `jspdf`, `next`, `nodemailer`, `qrcode`, `react`, `react-dom`, `resend`, `sanitize-html`, `zod`, `@types/sanitize-html`. `resend` is the email provider, not payment.

## 10. Email dependencies

Payment-touching templates:
- `lib/email/triggers/room-registration.ts` — `TEMPLATE_KEY[status]` fires per RoomRegistration transition, including PAID / REFUNDED / PAYMENT_FAILED.
- `lib/admin/email-templates.ts` — no purely-payment template (verified). All 5 registration/application templates are payment-free.
- `lib/email/templates/registry.ts` — includes payment status vars in the admin composer variables.

**No payment provider callback triggers an email.** No refund email exists.

The email queue, worker, provider abstraction, verification, and password-reset flows are unrelated to payment and MUST be preserved.

## 11. Registration dependencies (public)

Verified independently by grep + reading every registration server action:

- `app/actions/register-visitor.ts` — 0 payment references.
- `app/actions/register-speaker.ts` — 0.
- `app/actions/register-sponsor.ts` — 0.
- `app/actions/register-partner.ts` — 0.
- `app/actions/register-content-creator.ts` — 0.
- `lib/register/participant.ts` — 0.
- `lib/register/professional-action.ts` — 0.

Registration is **already payment-free** at the application layer. The Commit 1 refactor completed this.

## 12. Badge dependencies

- `app/compte/badge/page.tsx` — refuses only when `status === CANCELLED`. No payment gate.
- `app/compte/badge/actions.ts::generateOrRotateMyBadge` — refuses only when `NO_PARTICIPANT` or `CANCELLED`. No payment gate.
- `lib/badge/**` — 0 payment references (verified).

**Answer to the audit's headline question**: yes, a fully registered participant can receive and use their badge without any payment system existing.

## 13. Check-in dependencies — CRITICAL

All three validators require `paymentStatus === PAID`:

- `lib/admin/main-entrance-validator.ts:269`
- `lib/admin/room-validator.ts:238`
- `lib/admin/text-checkin-validator.ts:297`

Removing the gate is a one-line change per file. The correct payment-free replacement rule (spec §14 warning about "unrestricted access") is:

> A CANCELLED participant must still be denied. Every non-CANCELLED participant with a matching credential is authorized.

`participant.status !== RegistrationStatus.CANCELLED` remains as the sole gate. That is functionally equivalent to today's `CheckInResult.CANCELLED` early-return already present in all three validators.

**Follow-on cleanup**: `CheckInResult.UNPAID` enum value and `MESSAGES.UNPAID` copy become dead — safe to remove after all three validators drop the branch.

## 14. Room dependencies

Rooms are a **separate subsystem**. The removal decision only affects the *payment* component of it:

**Keep**:
- `RoomRegistration` model — even without payment, per-participant per-room self-registration remains meaningful (FREE_CONFIRMED path).
- `ParticipantAccess` — access authorization.
- The scanner + validator + AccessPoint + Team functionality.
- The FREE `admissionMode` branch of `initRegistration`.

**Remove or freeze**:
- `AccessPoint.admissionMode = PAID` — no live way to complete such a registration.
- `RoomRegistrationStatus`: values `PENDING_PAYMENT`, `PAID`, `PAYMENT_FAILED`, `REFUNDED` — will have no writer.
- `RoomPaymentEventKind`: values `CONFIRM (→PAID)`, `FAIL`, `REFUND` — no writer.
- `RoomPaymentEvent` model as a whole — 0 dev rows, admin-only.
- `AccessPoint.priceMinor`, `AccessPoint.currency`, `RoomRegistration.priceMinorSnapshot`, `RoomRegistration.currencySnapshot`, `RoomRegistration.paymentRef` — no writer.
- `scripts/expire-room-registrations.ts` — targets PENDING_PAYMENT.
- `scripts/apply-room-payment-idempotency.ts` — index on the removed model.

Two removal options depending on the product decision:

- **Option A: keep the room registration domain, drop only payment.** Force `admissionMode = FREE` at the service layer (reject writes with PAID). Retain `RoomRegistration` for the FREE path.
- **Option B: drop room self-registration entirely.** Rely on admin-driven `ParticipantAccess` grants (existing today, unchanged). This eliminates half the code in `lib/room-registration/`.

Both preserve access authorization. Option B is smaller code delta; Option A preserves attendee self-service.

## 15. Admin dependencies

Classification per §10:

| Feature                                              | Class | Notes |
|------------------------------------------------------|-------|-------|
| `/admin/revenue` page + `revenue.view` + `revenue.reconcile` | A — Remove | No non-payment purpose |
| "Revenue" sidebar link                               | A — Remove |         |
| Payment KPIs on `/admin/dashboard`                   | (none — verified: dashboard has no payment KPI card after Commit 1) | already clean |
| Registrant list `payment` filter                     | A — Remove | Column disappears with `paymentStatus` |
| Registrant row "PAID" pill                           | A — Remove |         |
| Registrant edit form: `paymentStatus / Amount / Ref` | A — Remove |         |
| `updateRegistrant` action payment branch             | A — Remove |         |
| Email composer payment vars                          | A — Remove | Template variables list shrinks |
| Room-registrations panel — payment controls          | B — Adapt | Panel keeps FREE flow, loses PAID branch |
| `room-payment-actions.ts` (confirm / refund)         | A — Remove | Callers only used for PAID rooms |
| RBAC: `revenue.view`, `revenue.reconcile`, `payment.confirm.room`, `payment.refund.room` | A — Remove | Also update role catalog + tests |
| Registrant logs page — payment audit rows            | C — Keep | Displays existing audit history; will show only historical rows after removal |

## 16. Security dependencies

Payment code does **not** contribute to auth, ownership, CSRF, or rate-limit. Verified:
- `getCurrentAccount()` (auth) — never reads any payment field.
- `requirePermission()` (RBAC) — the 4 payment permissions are checked only by payment code paths.
- `safeNext` (open-redirect whitelist) — unrelated.
- Rate limiter — unrelated.

The **only** authorization gate combined with payment is the check-in validator §13. Its safe replacement is the CANCELLED-only gate, which does not weaken security — a CANCELLED participant already fails via the pre-existing `CheckInResult.CANCELLED` branch above the UNPAID branch in all three validators.

No payment gate is currently protecting anything else. Removing them all is defence-neutral, not weakening.

## 17. Historical data

Dev DB snapshot (labelled `DEV`; not production):

```
DEV: Participant.paymentStatus
  UNPAID    3
  PENDING   4
  PAID      8
  REFUNDED  1
  FAILED    0

DEV: RoomRegistration           0 rows
DEV: RoomPaymentEvent           0 rows
DEV: AccessPoint.admissionMode
  NULL   1  (main entrance — expected)
  FREE   5
  PAID   1

DEV: AuditLog (payment actions)
  payment.webhook.reconciliation_required   16
  payment.webhook.correlation_mismatch       2
```

**Production counts are unknown** — no live production DB was inspected during this audit.

Retention recommendation (audit only; do not act):

| Data                                       | Recommendation                                       |
|--------------------------------------------|------------------------------------------------------|
| `Participant.paymentStatus / Amount / Ref / paidAt` | Preserve historical values by dropping the columns in a later migration only after archiving. Practical shortcut: keep the columns nullable and stop writing them. |
| `RoomRegistration` payment fields          | Same — drop with the model or freeze |
| `RoomPaymentEvent`                         | Empty in dev; if empty in prod, safe to drop the model |
| Audit rows for `payment.*`                 | KEEP — the AuditLog is append-only history, not operational. |

## 18. Dependency graph

```
Payment System
│
├── Database
│   ├── PaymentStatus enum                                  REMOVE (with column)
│   ├── Participant.paymentStatus / Amount / Ref / paidAt   REMOVE
│   ├── @@index([paymentStatus])                            REMOVE (auto)
│   ├── AdmissionMode enum (FREE/PAID)                      ADAPT: collapse to single mode
│   ├── AccessPoint.priceMinor / currency                   REMOVE
│   ├── RoomRegistration payment fields                     REMOVE
│   ├── RoomRegistrationStatus (PAID/FAILED/REFUND)         ADAPT: collapse to FREE_CONFIRMED
│   ├── RoomPaymentEvent model                              REMOVE
│   ├── RoomPaymentEventKind enum                           REMOVE
│   └── CheckInResult.UNPAID                                REMOVE
│
├── Registration (public)
│   └── payment gate?                                       NO — clean
│
├── Badge / QR / issuance / rotation
│   └── payment gate?                                       NO — clean
│
├── Check-in
│   └── main / room / text validators                       REMOVE UNPAID branch;
│                                                            replace with CANCELLED-only
│
├── Rooms
│   ├── AccessPoint FREE flow                               KEEP
│   ├── AccessPoint PAID flow                               REMOVE (Option A) or KEEP model + freeze
│   ├── RoomRegistration FREE_CONFIRMED path                KEEP
│   ├── ParticipantAccess                                   KEEP
│   ├── RoomPaymentEvent                                    REMOVE
│   └── lib/room-registration/payment-adapter.ts            REMOVE
│
├── Admin
│   ├── /admin/revenue                                      REMOVE
│   ├── Registrant list payment filter/pill                 REMOVE
│   ├── Registrant edit payment section                     REMOVE
│   ├── updateRegistrant payment branch                     REMOVE
│   ├── Email composer payment vars                         ADAPT: strip vars
│   ├── Room-registrations panel payment controls           ADAPT: keep FREE, remove PAID
│   ├── room-payment-actions.ts                             REMOVE
│   └── RBAC 4 payment permissions                          REMOVE
│
├── Email
│   ├── registration templates (5)                          KEEP (already payment-free)
│   ├── room-registration triggers (paid transitions)       ADAPT: strip PAID/FAILED/REFUND keys
│   └── admin composer template variables                   ADAPT
│
├── API                                                     UNKNOWN — none currently exist
│
├── External Provider                                       NONE — nothing to disconnect
│
└── Configuration
    └── env vars                                            NONE — nothing to remove
```

## 19. Payment removal risk matrix

| Item                                              | Risk       | Reason                                                |
|---------------------------------------------------|------------|-------------------------------------------------------|
| Remove `/admin/revenue` + sidebar link            | LOW        | Isolated, no callers                                  |
| Remove registrant-list payment filter/pill        | LOW        | Cosmetic                                              |
| Remove `Participant.paymentStatus/Amount/Ref/paidAt` from schema | HIGH  | 45 files reference these; requires phased application-layer removal first |
| Remove `PaymentStatus` enum                        | HIGH       | Removing enum before removing every column reference throws at Prisma generate |
| Remove `updateRegistrant` payment branch          | MEDIUM     | Straightforward; edit form is admin-only              |
| Remove check-in `UNPAID` gate                     | **CRITICAL** | Directly changes who can enter the venue. Test coverage must include a scan of a REGISTERED-not-PAID participant returning VALID |
| Remove `CheckInResult.UNPAID` enum value          | HIGH       | 30+ test references; must migrate/purge existing UNPAID CheckIn rows first |
| Remove `lib/room-registration/**`                 | HIGH       | 15 files; needs Option A vs Option B product call     |
| Remove `RoomPaymentEvent` model                   | HIGH       | Model has 0 dev rows but has append-only audit intent; confirm zero prod rows first |
| Remove `AdmissionMode` enum                       | MEDIUM     | Only if Option B; Option A collapses to a single value |
| Remove RBAC payment permissions                    | LOW        | Isolated in `lib/admin/rbac.ts` + role catalog        |
| Remove room-registration email triggers for paid transitions | LOW | Trigger table lookup falls back to no-op   |
| Drop historical AuditLog rows (`payment.*`)       | LOW        | Should be KEPT — history is a legitimate retention need |
| Drop `Participant.paymentStatus` data             | HIGH       | Irreversible without a backup; make an archive first  |

## 20. Target payment-free architecture

```
AccountUser
   → Participant (status = REGISTERED / CONFIRMED / CANCELLED)
   → Applications (SPEAKER / SPONSOR / PARTNER / CONTENT_CREATOR)
   → BadgeCredential (one ACTIVE)
   → CheckIn (allowed unless CANCELLED)

Rooms (retained as pure access-control):
   AccessPoint (FREE only — either enforced or the enum is collapsed)
   RoomRegistration (FREE_CONFIRMED / CANCELLED / EXPIRED)
   ParticipantAccess (admin grant OR REGISTRATION-materialized)
```

Guarantees:
- Registration works without payment ✅ (already true)
- Badge/QR issuance works without payment ✅ (already true)
- Check-in works without payment ⚠ (requires §13 gate removal)
- Applications work without payment ✅
- Admin manages participants + applications without financial views ✅ (after §15 removals)
- Room access remains intact ✅ (Option A or B)

## 21. Proposed removal phases

| Phase | Scope                                                                                                            | Blocking risks    |
|-------|------------------------------------------------------------------------------------------------------------------|-------------------|
| 0     | This audit                                                                                                       | none              |
| 1     | Remove check-in UNPAID gate in the three validators; keep the `CheckInResult.UNPAID` enum value for backward compat | CRITICAL — must land first and be tested BEFORE any of the below |
| 2     | Remove `/admin/revenue`, sidebar link, registrant list payment filter + column, registrant edit payment section, `updateRegistrant` payment branch, email composer payment vars | LOW-MEDIUM |
| 3     | Remove `lib/room-registration/**` payment surface. Product decision (Option A vs B) drives whether the RoomRegistration domain survives. Also delete `room-payment-actions.ts`, `scripts/expire-room-registrations.ts`, `scripts/apply-room-payment-idempotency.ts` | HIGH — largest code delta |
| 4     | Remove RBAC payment permissions; update role catalog + tests                                                     | LOW               |
| 5     | Drop the `emailTemplate` build blocker (already-documented Commit 1 issue — unrelated but blocks CI)             | separate decision |
| 6     | Schema migration: drop `Participant.paymentStatus/Amount/Ref/paidAt`, drop `PaymentStatus` enum, drop `RoomPaymentEvent` + `RoomPaymentEventKind`, drop `CheckInResult.UNPAID`, drop `AccessPoint.priceMinor/currency`, drop `RoomRegistration` payment fields, drop `AdmissionMode` enum (Option B) or collapse to single value (Option A). Preceded by an archive of the payment-column data. | HIGH — irreversible without backup |
| 7     | Regression: full test matrix + typecheck + build                                                                 | must all pass     |

## 22. Required regression tests

### Registration (existing suites are sufficient)
- `test:register-refactor`, `test:register-professional`, `test:register-concurrency`, `test:legacy-routes`, `test:safe-next`

### Badge / QR
- `test:badge` (28 tests) — must remain green
- **NEW**: badge issued for an unpaid REGISTERED Participant, then rotated, verified via QR

### Check-in — NEW required
- Valid badge on a REGISTERED (never-paid) Participant scans successfully at the main entrance
- Same at a room scanner (with ParticipantAccess granted)
- Same via text-checkin code
- CANCELLED Participant still refused at all three surfaces
- Revoked BadgeCredential still refused
- No path returns `CheckInResult.UNPAID`

### Rooms
- FREE-room self-registration still works
- Attendee cannot register for a PAID room after Option A/B lands (either 4xx or the mode does not exist)
- ParticipantAccess admin grant/revoke unchanged

### Admin
- Registrant list renders without payment column
- Registrant edit form saves without payment fields
- `/admin/revenue` returns 404
- No admin page crashes on missing `paymentStatus`

### Security (existing)
- `test:safe-next`, auth guards, RBAC — all unchanged

### Database
- Prisma schema validates
- No foreign-key/index errors after migration
- `npx prisma db push` succeeds

### Build
- `npm run typecheck` — 30 pre-existing errors remain (emailTemplate); Payment removal must not add any new error
- `npm run build` — will still fail until emailTemplate is resolved (separate track)

## 23. Open questions

| # | Question | Why it matters | Affected | Options | Recommended investigation |
|---|----------|----------------|----------|---------|---------------------------|
| 1 | Retention of historical payment data | Compliance / accounting may require archival | `Participant.paymentStatus/Amount/Ref/paidAt`, `AuditLog(payment.*)` | (a) archive to CSV, then drop columns; (b) keep columns nullable, stop writing; (c) drop immediately | Ask Finance/Legal owner |
| 2 | Room self-registration | Whether attendees still self-register for rooms in a payment-free world | `RoomRegistration`, `ParticipantAccess`, `/compte/acces` | Option A (keep FREE flow) or Option B (drop domain, use admin grants only) | Ask event ops |
| 3 | Production payment data existence | Determines whether a data-archive step is necessary before schema drop | Production Postgres | count `paymentStatus <> 'UNPAID'`, count `RoomPaymentEvent` | Query production read replica |
| 4 | `emailTemplate` build blocker fate | Independent of payment; still blocks `npm run build` | 6 files listed in `registration-production-readiness.md` §10 | Product decision on DB-backed template editor vs static TS | Not part of payment removal |
| 5 | Backward-compat of `CheckInResult.UNPAID` value | Removing the value breaks 30+ tests + any analytics tile counting UNPAID historical scans | `CheckInResult` enum, all tests, `checkin-analytics-phase21` | (a) drop value and rewrite tests; (b) keep as deprecated | Recommend (b) for the current commit, (a) once analytics is validated |

## 24. Recommended next step

Two independent tracks:

1. **Product decisions** — resolve Open Questions #1 (retention) and #2 (Room A vs B). Both are one-line product calls; without them, Phase 3 and Phase 6 cannot begin.
2. **Engineering** — begin with **Phase 1 (check-in gate removal)** and **Phase 2 (admin surface removal)** in a single commit. These two phases are independent of the product decisions above and unblock the practical concern (unpaid REGISTERED attendees currently cannot enter). Everything downstream (Phase 3+) becomes safer once these two are in.

Do NOT start Phase 6 (schema drop) until (a) product decisions land and (b) production payment-data counts are confirmed and archived.

---

**Final engineering state**: `PAYMENT REMOVAL UNDERSTOOD WITH DOCUMENTED BLOCKERS`

The audit is complete. No code was modified. Two product decisions and one production-data confirmation gate the destructive parts of the removal. Non-destructive parts (Phase 1 + Phase 2) are ready to implement whenever authorized.
