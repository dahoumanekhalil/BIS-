# BIS 2026 — Access System Implementation

Master execution plan for the BIS 2026 attendee identity, digital badge, QR
credential, venue check-in, and five-room access-control system.

> **Governance rule.** This document is the single source of truth for the
> project. Phases are executed **one at a time**, and only after the user
> explicitly says `GO`. At the end of every phase Claude Code must stop and
> wait — implementation never rolls automatically from one phase into the
> next. See section 22 for the full development rule.

---

## 1. Project Overview

BIS 2026 needs a coherent, secure, premium-feeling identity and access
experience for every attendee. This is not "a profile page" and it is not
"a QR generator". It is an event credential and access-control chain:

```
Account
  ↓
Registration
  ↓
Digital Badge
  ↓
Secure QR Credential
  ↓
Main Venue Check-in
  ↓
Room 01 · Room 02 · Room 03 · Room 04 · Room 05
  ↓
Access History
  ↓
Admin Access Management
```

The attendee experience must feel like an official international summit
credential system. The staff-side scanner experience must be fast, safe,
and unambiguous. The admin experience must give authorized operators
per-participant, per-room control with a complete audit trail.

---

## 2. Existing System — Baseline

Before this project began, the following already existed and must **not**
be rebuilt or replaced.

### Public account
- `AccountUser` — public attendee account model.
- `bis_account_session` — HttpOnly session cookie.
- `lib/account/auth.ts` — session create / read / destroy, sha256 tokenHash.
- `/compte` — authenticated account home (currently read-only name/email).
- `/auth?mode=login|register` — unified public auth entry.

### Registration
- `Participant` — event registration record.
- `Participant.ticketCode` — manual admin-entered ticket code (unique).
- `Participant.gate` — free-string entry gate assignment (`A/B/C/D` today).
- `Participant.checkedInAt` — first-scan timestamp at main entrance.
- `Participant.paymentStatus` — `UNPAID | PENDING | PAID | REFUNDED | FAILED`.
- `lib/onboarding.ts` + `app/register/**` — the wizard flow.

### Existing check-in
- `/admin/check-in` — dashboard + manual code entry panel.
- `validateTicket(code, gate)` in `app/admin/check-in/actions.ts` — verifies
  ticket exists, `status !== CANCELLED`, `paymentStatus === PAID`, gate
  matches, not already checked-in. Writes a `CheckIn` row and audits.
- `CheckIn` — every scan attempt (`VALID | ALREADY_CHECKED_IN | WRONG_GATE
  | WRONG_TIME | CANCELLED | UNKNOWN | UNPAID`).
- `AuditLog` — every admin write (`userId`, `action`, `entity`, `entityId`,
  `meta` JSON).

### RBAC
- `lib/admin/rbac.ts` — 30+ permission strings + role → permission map +
  DB-override table (`RolePermissionOverride`).
- Roles: `SUPER_ADMIN`, `ADMIN`, `SALES`, `REGISTRATION_MANAGER`,
  `CHECKIN_OPERATOR`, `CONTENT_MANAGER`, `SPONSOR_MANAGER`, `FINANCE`,
  `ANALYTICS`, `VIEWER`.
- `CHECKIN_OPERATOR` — currently holds `dashboard.view`, `checkin.view`,
  `checkin.validate`, `registrants.view`, `gates.view`.

### Design system
- BIS colors: Frost `#F8FAF9`, White `#FFFFFF`, Ink Navy `#111827`, Cobalt
  `#2453E0`, Electric Lime `#B8E62E`. See `tailwind.config.ts`.
- Typography: Alexandria (display + brand).
- Primitives: `KpiCard`, `StatusBadge`, `TierBadge`, `FormField`,
  `TextInput`, `SubmitButton`, `EmptyState`, `cn()` (in
  `components/admin/ui.tsx`, `components/forms/primitives.tsx`,
  `lib/utils.ts`).

### Non-negotiable rules
- **DO NOT rebuild these systems.**
- **DO NOT create a parallel authentication system.**
- **DO NOT create a parallel registration system.**
- **DO NOT create a parallel admin system.**
- **DO NOT break the existing manual `validateTicket(code, gate)` flow.**

---

## 3. Phase Status

| Phase | Description                                | Status      |
|-------|--------------------------------------------|-------------|
| 1     | Schema + AccessPoint foundation            | COMPLETE    |
| 2     | Badge credential service                   | COMPLETE    |
| 3     | RBAC                                       | COMPLETE    |
| 4     | `/compte` redesign                         | COMPLETE    |
| 5     | Digital badge + QR UI                      | COMPLETE    |
| 6     | Attendee access history                    | COMPLETE    |
| 7     | Admin participant access matrix            | COMPLETE    |
| 8     | AccessPoint administration                 | COMPLETE    |
| 9     | Scanner UI                                 | COMPLETE    |
| 10    | Main entrance validation                   | COMPLETE    |
| 11    | Room validation                            | COMPLETE    |
| 12    | Mobile badge experience                    | COMPLETE    |
| 13    | Security review (whole system)             | COMPLETE    |
| 14    | Final testing (full matrix)                | PASS        |
| 15    | Admin session token hardening (WARN 2)     | COMPLETE    |
| 16    | QR Operations UI/UX                        | COMPLETE    |

---

## 4. Phase 1 — Schema + AccessPoint Foundation  ·  COMPLETE

### What was implemented

**Prisma additions in `prisma/schema.prisma`:**

Enums:
- `AccessPointType { MAIN_ENTRANCE, ROOM }`
- `BadgeStatus { PENDING, ACTIVE, REVOKED, EXPIRED }`

Models:
- `AccessPoint` (id, slug @unique, name, type, active, order, createdAt, updatedAt)
- `BadgeCredential` (id, participantId, tokenHash @unique, status, issuedAt,
  expiresAt, revokedAt, revokedReason, revokedById, rotatedFromId self-relation)
- `ParticipantAccess` (composite PK `[participantId, accessPointId]`, granted,
  grantedById, grantedAt, revokedById, revokedAt)

Extensions:
- `Participant` — back-refs `credentials: BadgeCredential[]` and
  `accessPermissions: ParticipantAccess[]`.
- `CheckIn` — added nullable `accessPointId` (FK → AccessPoint, `SetNull`)
  and nullable `credentialId` (FK → BadgeCredential, `SetNull`), plus three
  new indexes (`accessPointId`, `[accessPointId, scannedAt]`, `credentialId`).

### Backwards compatibility

- `Participant.ticketCode` — **preserved**.
- `Participant.gate` — **preserved**.
- `Participant.checkedInAt` — **preserved**.
- `Participant.checkedInGate` — **preserved**.
- Existing `CheckIn` rows (all with `accessPointId = null` and
  `credentialId = null`) — **remain valid**.
- Existing manual `/admin/check-in` flow — **unaffected**.

### Seeded AccessPoints

| slug     | name              | type          | order |
|----------|-------------------|---------------|-------|
| main     | Entrée principale | MAIN_ENTRANCE | 0     |
| room-01  | Salle 01          | ROOM          | 1     |
| room-02  | Salle 02          | ROOM          | 2     |
| room-03  | Salle 03          | ROOM          | 3     |
| room-04  | Salle 04          | ROOM          | 4     |
| room-05  | Salle 05          | ROOM          | 5     |

Seeded via idempotent upsert-by-slug script `scripts/seed-access-points.ts`.
Also included in the destructive `prisma/seed.ts` flow for full-seed parity.

### Partial unique index (DB-level guarantee of one ACTIVE per participant)

Prisma's DSL cannot express a partial unique constraint, so it is installed
out-of-band via `scripts/apply-badge-index.ts`:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS "BadgeCredential_one_active_per_participant_uidx"
  ON "BadgeCredential" ("participantId")
  WHERE status = 'ACTIVE';
```

Idempotent (`IF NOT EXISTS`), safe to re-run after every `prisma db push`.

### Design decision (permanent)

> **One ACTIVE BadgeCredential per Participant.**
> Historical (`REVOKED` / `EXPIRED`) credentials are allowed to accumulate —
> rotation preserves history via `rotatedFromId`. The DB partial unique
> index above guarantees that at most one row per participant is ever in
> `status = 'ACTIVE'`.

### Verification

- `npx prisma format` ✓
- `npx prisma validate` ✓
- `npx prisma generate` ✓
- `npx prisma db push` ✓
- `npm run typecheck` ✓
- Postgres verified: 6 AccessPoints present; `BadgeCredential` has the partial
  unique index; `ParticipantAccess` PK composite; `CheckIn.accessPointId` and
  `CheckIn.credentialId` both nullable.
- **Security review: OK.** No BLOCK, no WARN.

### Files touched in Phase 1

- `prisma/schema.prisma` — extended.
- `prisma/seed.ts` — extended (adds `AccessPoint` sweep + create; imports
  `AccessPointType`).
- `scripts/apply-badge-index.ts` — new.
- `scripts/seed-access-points.ts` — new.

### Known tech-debt (not blocking)

- The 6 AccessPoint definitions are hardcoded in both
  `scripts/seed-access-points.ts` and `prisma/seed.ts`. Drift risk is
  operational, not security. Unify later by importing from the script.

---

## 5. Phase 2 — Badge Credential Service  ·  COMPLETE

### What was implemented

Pure server-side service under `lib/badge/`:

| File                    | Purpose                                                                 |
|-------------------------|-------------------------------------------------------------------------|
| `lib/badge/token.ts`    | Crypto primitives (no DB): generation, hashing, constant-time compare. |
| `lib/badge/errors.ts`   | `BadgeError` class with stable `code` field.                            |
| `lib/badge/service.ts`  | The service: issue / verify / revoke / rotate. `import "server-only"`.  |
| `lib/badge/index.ts`    | Barrel re-exports.                                                      |

### Public API

Token utilities (`lib/badge/token.ts`):

```ts
generateBadgeToken(): string           // randomBytes(32) → base64url, ~256 bits
hashBadgeToken(token: string): string  // sha256 hex
timingSafeHexEqual(a, b): boolean      // crypto.timingSafeEqual on hex hashes
```

Service (`lib/badge/service.ts`):

```ts
issueBadgeCredential(participantId, { expiresAt? })
  → { credentialId, rawToken }
  throws BadgeError PARTICIPANT_NOT_FOUND | ACTIVE_EXISTS

verifyBadgeToken(rawToken)
  → { ok: true,  credentialId, participantId }
  | { ok: false, reason: INVALID | REVOKED | EXPIRED | PARTICIPANT_CANCELLED }
  never throws for expected outcomes

revokeBadgeCredential(credentialId, revokedById?, reason?)
  → { status: "REVOKED" | "NOOP" }         // idempotent
  throws BadgeError CREDENTIAL_NOT_FOUND | ADMIN_NOT_FOUND

rotateBadgeCredential(participantId, revokedById?, reason?)
  → { credentialId, rawToken, previousCredentialId | null }
  throws BadgeError PARTICIPANT_NOT_FOUND | ADMIN_NOT_FOUND | CONCURRENT_ROTATION
```

### Security properties

- Raw token: `crypto.randomBytes(32)` → base64url → ~256 bits of entropy.
- Storage: sha256 hex of the raw token. **Raw token never persisted.**
- Logging: `BadgeError` messages are code strings only — no PII, no tokens.
  Tests assert the raw token never appears in error output or in
  service-controlled audit metadata.
- Transactions: every mutation wrapped in `prisma.$transaction`.
- Single-active: enforced at three layers —
  1. Service precheck inside the transaction.
  2. DB partial unique index (defense in depth against races).
  3. P2002 catch inside the create → surfaces as `ACTIVE_EXISTS` /
     `CONCURRENT_ROTATION` rather than a bare Prisma error.
- Constant-time compare: `timingSafeHexEqual` applied to the retrieved hash
  vs. the freshly computed one after a unique-index lookup — cheap
  defense-in-depth against exotic layer bugs.
- Auditing: every lifecycle mutation writes an `AuditLog` row **after
  commit** (`badge.issue`, `badge.revoke`, `badge.rotate`). `verify()` does
  NOT audit (see design decision below).

### Design decisions (intentional)

- **`issue()` does not silently rotate.** If an ACTIVE credential exists,
  `issue()` throws `ACTIVE_EXISTS`. Callers who mean "replace" must call
  `rotate()` explicitly. This keeps intent visible at the callsite.
- **`revoke()` is idempotent.** A second revoke on the same credential
  returns `{ status: "NOOP" }` with no DB write and no new audit row.
  Tested for no double-audit.
- **`verify()` does not audit.** Scanners call verify at high volume; the
  meaningful scan audit belongs to the check-in flow (Phases 10 & 11) where
  the AccessPoint and operator context exist.
- **`revokeReason` is caller-controlled and unvalidated at the service
  layer.** Sanitisation belongs in Phase 3+ server actions (Zod `.max(500)`
  + reject token-shaped regex `/^[A-Za-z0-9_-]{40,}$/`).

### Tests

- `scripts/badge-credential.test.ts` — 28 tests across 7 suites: issue,
  verify, revoke, rotate, DB-level partial unique index, AuditLog
  integration, logging discipline.
- Runner: Node's built-in `node:test`.
- Command: `npm run test:badge`
  (`node --conditions=react-server --import tsx --test
  scripts/badge-credential.test.ts`).
- Fixture: creates a per-test `Participant` under `badge-test-` email
  prefix; upserts one test admin under `badge-test-admin@bis.dz`. Both
  cleaned up in `after`.

### Verification

- `npm run test:badge` → **28 / 28 pass** (~2s).
- `npm run typecheck` → clean.
- Schema not touched in this phase; no `prisma validate` needed.
- **Security review: OK.** One WARN-worthy hygiene note (persistent test
  admin row) resolved by adding cleanup in `after`.

### New dependency (justified)

- `server-only ^0.0.1` (devDep). Vercel-authored 3-line marker package.
  Next.js bundles a compiled copy internally, but the plain Node / tsx
  runner used by the test suite cannot resolve it. Installing explicitly
  matches the project convention of `import "server-only"` on every server
  file. Uses the `react-server` condition to swap to an empty module at
  runtime — same mechanism Next.js uses.

### Files added/changed in Phase 2

- `lib/badge/token.ts` — new.
- `lib/badge/errors.ts` — new.
- `lib/badge/service.ts` — new.
- `lib/badge/index.ts` — new.
- `scripts/badge-credential.test.ts` — new.
- `package.json` — added `server-only` devDep + `test:badge` script.

---

## 6. Phase 3 — RBAC  ·  COMPLETE

Implementation date: 2026-09-17.

### What was implemented

**`lib/admin/rbac.ts` — additions only:**

Added 5 permission strings to `PERMISSIONS`:
- `badge.manage`
- `access.view`
- `access.manage`
- `access.validate.main`
- `access.validate.room`

Role-map deltas:

| Role                    | Added                                                        | Preserved |
|-------------------------|--------------------------------------------------------------|-----------|
| `SUPER_ADMIN`           | inherits all 5 automatically via existing `ALL`              | full      |
| `ADMIN`                 | inherits all 5 automatically via existing `ALL.filter()`     | still lacks roles/users/revenue |
| `REGISTRATION_MANAGER`  | `badge.manage`, `access.view`, `access.manage`               | all pre-existing kept |
| `CHECKIN_OPERATOR`      | `access.validate.main`, `access.validate.room`               | **legacy `checkin.validate` kept** |
| `SALES`, `CONTENT_MANAGER`, `SPONSOR_MANAGER`, `FINANCE`, `ANALYTICS`, `VIEWER` | *none* | all pre-existing kept |

Two new helpers Phase 10/11 will call:

```ts
canValidateMainEntrance(role): Promise<boolean>
  // Accepts EITHER `access.validate.main` OR legacy `checkin.validate`
  // via canWithOverrides — preserves backwards compat with any custom
  // role/override that granted checkin.validate before Phase 3.

canValidateRoom(role): Promise<boolean>
  // Strict — requires `access.validate.room`. Rooms are a new surface;
  // legacy checkin.validate is deliberately NOT accepted.
```

### Decision taken

- **Adopted option (a)+(b) hybrid** from the phase spec: added both perms
  to `CHECKIN_OPERATOR` (option b) AND made the main-entrance helper accept
  either (option a). This gives us belt-and-braces — role holders get the
  new perm by default, and legacy overrides never break.

### Tests

- `scripts/rbac.test.ts` — 28 tests across 10 suites: PERMISSIONS registry
  (new perms present, legacy preserved, no duplicates), SUPER_ADMIN /
  ADMIN / REGISTRATION_MANAGER / CHECKIN_OPERATOR mappings, restricted-role
  isolation (SALES/CONTENT_MANAGER/SPONSOR_MANAGER/FINANCE/ANALYTICS/VIEWER),
  helpers (accept/reject cases), and `canWithOverrides` baseline-drift
  check that skips any role/perm pair actually overridden in the local DB.
- Command: `npm run test:rbac`.

### Verification

- `npm run test:rbac` → **28 / 28 pass** (~1.2s).
- `npm run test:badge` → **28 / 28 pass** (no regression).
- `npm run typecheck` → clean.
- Schema not touched; no `prisma validate` needed.
- **Security review: OK.** No BLOCK, no WARN.

### Files touched in Phase 3

- `lib/admin/rbac.ts` — extended (additions only, no deletions).
- `scripts/rbac.test.ts` — new.
- `package.json` — added `test:rbac` script.

### Carry-forward notes for future phases (from security review)

- **Phase 10 (Main entrance validation)**: record on each `CheckIn` /
  `AuditLog` entry whether the scan authorized via manual code vs QR path.
  If the `canValidateMainEntrance` fallback ever authorizes an unintended
  role/override holder, this makes it detectable.
- **Phase 7 / 10 / 11 (Any mutation surface)**: every badge/access mutation
  writes an `AuditLog` row with actor, target participant, and
  before/after — not just the fact of the mutation. Actor MUST come from
  the current admin session, never from a form field.
- **Phase 7 (`access.manage` scope)**: a `REGISTRATION_MANAGER` should
  not be able to grant room access to another admin/staff account, only
  to participants. Enforce this at the action layer (the target of
  grant/revoke is always a `Participant.id`, not an `AdminUser.id`; check
  before writing).

---

## 7. Phase 4 — `/compte` Redesign  ·  COMPLETE

Implementation date: 2026-09-17.

### What was implemented

Turned the previously read-only single-page `/compte` into a full 7-route
personal space, guarded by the existing `AccountUser` session. Zero
changes to the auth system itself.

**Route tree:**

| Route                | Content                                                              |
|----------------------|----------------------------------------------------------------------|
| `/compte`            | Dashboard — badge preview + 6-point access overview + status side rail |
| `/compte/badge`      | Badge preview + `ComingSoon` shell for the Phase 5 QR / print work   |
| `/compte/acces`      | Full 6-point access matrix + placeholder for Phase 6 history         |
| `/compte/inscription`| Registration + payment status + ticket code + contact info            |
| `/compte/profil`     | Identity + org display; safe-URL rendering for `companyWebsite`      |
| `/compte/demandes`   | Application status list (Sponsor / Speaker / Partner / Content Creator) or empty-state |
| `/compte/securite`   | Session info + logout; password change stub (`Bientôt disponible`)   |

**Shell** (`app/compte/layout.tsx`) does `await requireAccount()` and
renders a Cobalt identity header (`Bonjour, [Prénom]` + participation
pill + badge status pill) with a sticky sub-nav pill row. The sub-nav is
horizontally scrollable on mobile.

**Data layer** (`lib/account/participant.ts`): single React `cache()`-wrapped
loader `getCompteContext(account)` shared by the layout and every page —
one DB round-trip per request even with 7 pages consuming it. `select`
whitelist excludes `tokenHash`, `passwordHash`, admin `reviewNotes`, and
`paymentRef`/`paymentAmount` (those are admin-facing).

**Enum labels** (`lib/account/labels.ts`): French labels + tone
(`ok`/`wait`/`danger`/`muted`) for `ParticipationChoice`,
`RegistrationStatus`, `BadgeStatus`, `ApplicationType`, `ApplicationStatus`.
Fall-back to enum name if a new value lands without a label.

**UI primitives** (`components/compte/*`):
- `header.tsx` — server-rendered Cobalt band.
- `tabs.tsx` — client-only sub-nav with active state via `usePathname`.
- `card.tsx` — `CompteCard` + `CompteRow` — the visual unit used throughout.
- `status-pill.tsx` — reusable status pill with the tone system.

### Design decisions

- **Route language**: extended existing `/compte`. No `/account` created.
- **Sub-routes over tab component**: each subpage is its own route (linkable,
  shareable, deep-refreshable) with the tabs bar re-rendering active state
  from `usePathname`.
- **Photo policy**: initials-in-Cobalt-disc, no fake upload UI. Matches the
  navbar avatar convention.
- **Profile editing deferred**: `/compte/profil` shows current data with a
  disabled "Modifier mon profil · Bientôt disponible" button. Editing is a
  security surface of its own (Zod schema, action, self-only enforcement,
  rate limiting) — will be a follow-up mini-phase, not silently invented
  here.
- **Password change deferred**: same treatment on `/compte/securite`. Users
  are directed to `/contact` for now.
- **Payment fields (`paymentAmount`, `paymentRef`)** deliberately omitted
  from the query. Only `paymentStatus` is shown, translated to attendee
  vocabulary ("Réglé" etc.).
- **Application `reviewNotes`** deliberately omitted from the query.
- **`safeExternalUrl()` guard** on `companyWebsite` — React 18 does not
  block `javascript:` URLs, so we accept only `http:` / `https:` and
  fall back to plain text otherwise. Prevents self-XSS on the profile
  page and stored-XSS regressions if the value is ever shown to admins.

### Never exposed to attendees (audit)

- No `Participant.id`, `BadgeCredential.id`, `AccessPoint.id`,
  `AccountSession.id`, session tokens, or `tokenHash` in the rendered DOM
  (verified by inspection of every JSX file).
- No `Application.reviewNotes` in the query select — cannot leak.
- No other participants' data — every query is scoped by
  `accountUserId = <current session>`.

### Verification

- `npm run typecheck` → clean.
- `npm run test:badge` → **28 / 28** (no regression).
- `npm run test:rbac` → **28 / 28** (no regression).
- `scripts/compte-smoke.ts` → **14 / 14** route checks pass across two
  scenarios (fully-populated Participant + AccountUser without a
  Participant). Every route returns 200 with the expected content markers;
  no server-side render errors.

Manual browser click-through was not performed by Claude Code (no browser
in this environment); the HTTP-level smoke script substitutes by exercising
every route with a real signed-in session cookie and asserting response
markers, including graceful degradation for the "no participant" case.

### Security-reviewer

**Not invoked.** Per `CLAUDE.md`, the mandatory triggers are `app/admin/**`,
`app/actions/**`, `app/api/**`, `lib/admin/**`, `lib/db.ts`,
`prisma/schema.prisma`, `middleware.ts`, or new dependencies. Phase 4
touched none of those, added no server action, no route handler, no cookie
behavior, no form/user-input handling, no `dangerouslySetInnerHTML`, no
raw SQL. The `safeExternalUrl` guard was added preemptively in-phase
rather than after a review round.

### Files touched in Phase 4

- `lib/account/labels.ts` — new (enum → French labels + tone system).
- `lib/account/participant.ts` — new (cached loader, `server-only`).
- `components/compte/header.tsx` — new.
- `components/compte/tabs.tsx` — new (client).
- `components/compte/card.tsx` — new.
- `components/compte/status-pill.tsx` — new.
- `app/compte/layout.tsx` — new (auth guard + shell).
- `app/compte/page.tsx` — rewritten (dashboard).
- `app/compte/badge/page.tsx` — new.
- `app/compte/acces/page.tsx` — new.
- `app/compte/inscription/page.tsx` — new.
- `app/compte/profil/page.tsx` — new.
- `app/compte/demandes/page.tsx` — new.
- `app/compte/securite/page.tsx` — new.
- `scripts/compte-smoke.ts` — new (dev smoke harness).

### Carry-forward for later phases

- **Follow-up (before or during Phase 5)**: build a proper profile editing
  action with Zod validation, self-only enforcement (`accountUserId` must
  match session), and rate limiting. Then wire the disabled button on
  `/compte/profil`.
- **Password change** action: same shape — Zod, self-only, existing password
  re-verification, rotate all `AccountSession` rows on change.
- **Phase 5** will replace the `ComingSoon` block on `/compte/badge` with
  the real badge + QR + print layout.
- **Phase 6** will replace the "Historique de check-in" placeholder card
  on `/compte/acces` with real `CheckIn` history joined to `AccessPoint`.

---

## Phase 3–4 Hardening / Pre-Phase-5 Gate  ·  COMPLETE

Implementation date: 2026-09-17.

A focused audit + tightening pass over the Phase 3 (RBAC) and Phase 4
(`/compte`) surfaces before Phase 5 begins. The four objectives from the
gate brief were: RBAC semantics, legacy-vs-QR authorization separation,
room-access default-deny, and `/compte` data boundaries. No new features
were built; no schema, seed, or check-in flow was touched.

### 1. Legacy `checkin.validate` cannot leak into QR authorization

**Root cause found:** the Phase 3 helper `canValidateMainEntrance(role)`
accepted `access.validate.main OR checkin.validate`. No production
consumer was using it yet — but the moment Phase 10 wired the QR
main-entrance validator through this helper, any role holding only the
legacy permission would silently gain QR authorization.

**Fix (`lib/admin/rbac.ts`)**: made the helper STRICT. It now returns
`canWithOverrides(role, "access.validate.main")` only. `canValidateRoom`
was already strict; unchanged. The legacy manual `/admin/check-in` flow
calls `requirePermission("checkin.validate")` DIRECTLY
(`app/admin/(protected)/check-in/actions.ts:51`) and does not use these
helpers, so it is unaffected.

Comment block above the `PERMISSIONS` const now explicitly documents the
LEGACY (manual) vs NEW (QR) authorization separation.

**Tests added (`scripts/rbac.test.ts`, +4 cases):**

- Baseline: `CHECKIN_OPERATOR` still holds `checkin.validate`.
- With `access.validate.main` denied via `RolePermissionOverride`,
  `canValidateMainEntrance(CHECKIN_OPERATOR)` returns **false** — proving
  the legacy permission alone does not authorize QR main entrance.
- With `access.validate.room` denied via override,
  `canValidateRoom(CHECKIN_OPERATOR)` returns **false**.
- The legacy `checkin.validate` still resolves for the manual flow via
  the raw `can()` check that the existing action uses.

An unconditional `after()` sweep deletes both override rows on teardown,
so a hard test crash cannot leave the local DB with denied overrides that
would silently break scanner authorization in future test runs.

### 2. Room-access default-deny — tri-state

**Root cause found:** the Phase 4 query filtered
`accessPermissions: { where: { granted: true } }`. That collapsed two
distinct administrative states into one visual state: an explicit
`granted=false` revocation and a never-granted-at-all point both rendered
as "Non autorisé". A future admin surface (Phase 7) would have no way to
distinguish them.

**Fix:**

- `lib/account/participant.ts` — removed the `where` filter; query now
  selects `{ accessPointId, granted }` for every row. Column whitelist
  unchanged; no sensitive fields added.
- `lib/account/access-state.ts` — new pure classifier `accessStateFor()`
  returning `"granted" | "denied" | "unassigned"`. Zero I/O, zero React,
  zero Prisma — importable from any runtime.
- `app/compte/page.tsx` + `app/compte/acces/page.tsx` — render three UI
  states with distinct tones:

| ParticipantAccess row | UI label       | Tone   |
|-----------------------|----------------|--------|
| exists, granted=true  | Autorisé       | ok     |
| exists, granted=false | Refusé         | danger |
| no row                | Non attribué   | muted  |

- `accessStateFor` is now the single source of truth. Any UI that renders
  the matrix must call it — no ad-hoc two-state checks anywhere.

**Semantic rule (explicit):** absence of a `ParticipantAccess` row means
NO grant. The system never treats missing rows as authorized. Room access
is never auto-granted by account creation, registration, badge issuance,
or by opening `/compte/*`.

**Tests added (`scripts/access-semantics.test.ts`, 5 cases):**

- Creates one Participant + 3 rows (`granted=true`, `granted=false`, no
  row) against the seeded AccessPoints.
- Asserts the exact production `select` shape returns both persisted rows
  and does not return the missing one.
- Asserts `accessStateFor` classifies all three states correctly.
- Asserts `accessStateFor` is pure — `[]` input maps to `"unassigned"`.

### 3. `/compte/badge` — Phase 5 boundary preserved

Verified by inspection + reviewer grep: `app/compte/badge/page.tsx` calls
`requireAccount()` and `getCompteContext()` only. It reads
`participant.credentials[0]?.status` for the status pill. It does NOT:

- issue, rotate, or revoke a `BadgeCredential`.
- generate a QR code.
- expose raw tokens or `tokenHash`.
- mutate `ParticipantAccess`, `CheckIn`, or grant any room permission.

The `ComingSoon` placeholder remains; Phase 5 will replace it.

### 4. `/compte` data-boundary re-audit

- Query whitelist in `lib/account/participant.ts` unchanged apart from
  the tri-state filter removal. Still excludes: `passwordHash`,
  `tokenHash`, `paymentAmount`, `paymentRef`, `reviewNotes`, session
  tokens, any other-participant data. All access is scoped by
  `where: { accountUserId: <current session> }`.
- New tri-state labels are static string literals passed as JSX text to
  `<StatusPill>` — no `dangerouslySetInnerHTML`, no XSS surface.
- No mutations from any `/compte/*` route.

### 5. `CheckIn.gate` vs `AccessPoint` — clarified in comments

The legacy `CheckIn.gate` string field remains for backwards compat with
the manual `/admin/check-in` flow. It is a legacy REGISTRATION-time
assignment string ("Gate A" etc.), NOT an authoritative access-point
identity. The authoritative access surface for the new system is the
`AccessPoint` model (linked from `CheckIn.accessPointId` and from
`ParticipantAccess.accessPointId`). No code change was needed; this is
documented here so Phase 10/11 does not confuse the two.

### Files touched in this hardening pass

- `lib/admin/rbac.ts` — strict `canValidateMainEntrance`; docs updated.
- `lib/account/participant.ts` — removed granted-only filter; re-exports
  `accessStateFor` from the new file.
- `lib/account/access-state.ts` — **new**, pure tri-state classifier.
- `app/compte/page.tsx` — dashboard mini-matrix now tri-state.
- `app/compte/acces/page.tsx` — full matrix now tri-state.
- `scripts/rbac.test.ts` — +4 override-based tests, unconditional
  cleanup sweep in `after()`.
- `scripts/access-semantics.test.ts` — **new**, 5 tests.
- `scripts/compte-smoke.ts` — fixture now creates one `granted=false`
  row and leaves one point without any row; assertions cover all three
  UI labels.
- `package.json` — added `test:access` script.

### Files intentionally NOT touched

- `prisma/schema.prisma` — schema unchanged.
- `lib/badge/**` — service layer unchanged.
- `app/admin/(protected)/check-in/**` — legacy manual flow untouched.
- `middleware.ts`, `lib/db.ts`, `lib/admin/auth.ts`,
  `lib/account/auth.ts` — unchanged.
- No new dependency installed.
- No new server action, route handler, or cookie behaviour.

### Verification

- `npm run typecheck` → clean.
- `npm run test:rbac` → **31 / 31** pass (was 28; +3 override-based cases
  and 1 baseline sanity assertion added).
- `npm run test:access` → **5 / 5** pass (new).
- `npm run test:badge` → **28 / 28** pass (no regression).
- `scripts/compte-smoke.ts` → **14 / 14** pass across both scenarios
  (populated + empty account); tri-state UI verified end-to-end via HTTP.
- **Security review: OK.** One LOW/WARN was raised about the
  override-cleanup pattern in `rbac.test.ts` and immediately resolved by
  adding an unconditional `after()` sweep. No BLOCK. Reviewer explicitly
  confirmed the sensitive-field whitelist in `participant.ts` was not
  loosened and that `/compte/badge` performs no mutation.

### Remaining deferred items (unchanged from Phase 4 report)

- Profile editing action (`/compte/profil`).
- Password change action (`/compte/securite`).
- The 6 AccessPoint definitions are still hardcoded in two places
  (`scripts/seed-access-points.ts` and `prisma/seed.ts`) — noted since
  Phase 1, not blocking.

### Gate result

**Phase 3 and Phase 4 are ready for the Phase 5 gate.**

Awaiting explicit `GO — Phase 5` before starting Phase 5 (Digital badge
+ QR UI). This hardening record is append-only; Phase 3 and Phase 4
completion records above are unchanged.

---

## 8. Phase 5 — Digital Badge + QR UI  ·  COMPLETE

Implementation date: 2026-09-18.

### What was implemented

Attendee-facing badge + QR display at `/compte/badge`, wired to the Phase 2
`BadgeCredential` service. Browser-print supported via media rules — no
server-side PDF pipeline.

**Data flow (respects Phase 2 "no raw token at rest"):**

```
attendee clicks "Générer / Afficher mon QR"
      ↓
useActionState → generateOrRotateMyBadge()   [POST server action]
      ↓
requireAccount()  →  resolve Participant by accountUserId
      ↓
eligibility gate  →  reject if !PAID / CANCELLED / no participant
      ↓
rate limit        →  reject if last credential < 10s ago
      ↓
rotateBadgeCredential(participantId, null, "self-service")
      ↓
Phase 2 service:  revoke ACTIVE → create ACTIVE (rotatedFromId chain)
                  audit `badge.rotate`
      ↓
renderBadgeQrDataUrl(rawToken)  →  PNG data URL (Ink on White, 512px)
      ↓
audit `badge.rotate.self` (attendee-initiated marker)
      ↓
return { ok:true, qrDataUrl, issuedAt }  ← rawToken NOT returned as string
      ↓
client renders <img src={qrDataUrl}> inside <BadgeCard>
```

**Rotation-on-every-view UX** is the honest cost of the security model.
Because `BadgeCredential.tokenHash` is the only artifact stored, we cannot
recover a previously-issued token; each display requires a fresh rotation.
The UI copy warns the user explicitly:

> "Cliquez sur « Afficher mon QR » pour générer un nouveau code. Votre
> QR précédent sera automatiquement révoqué — un seul code actif à la fois."

On page refresh the client-side state is dropped, and the user must
regenerate. The `useActionState` result is held in React state only — never
persisted to `localStorage`, `sessionStorage`, or a cookie.

### Files added

| File                                                | Purpose                                                |
|-----------------------------------------------------|--------------------------------------------------------|
| `lib/badge/qr.ts`                                   | `renderBadgeQrDataUrl(token)` — PNG data URL. `server-only`. |
| `app/compte/badge/actions.ts`                       | `generateOrRotateMyBadge()` — the only user-facing surface that mutates credentials. |
| `components/compte/badge-card.tsx`                  | Portrait 3:4 neck-badge visual. Server component. Reserved QR slot even before generation so layout does not jump. |
| `components/compte/badge-qr-client.tsx`             | `useActionState` around the action; renders `<BadgeCard>` with QR + right-column controls. |
| `scripts/qr.test.ts`                                | 4 tests locking in PNG format, no-plaintext-leak, non-cached output, deterministic renders. |

### Files modified

- `app/compte/badge/page.tsx` — replaced the `ComingSoon` block. Now
  guards, loads participant, applies the eligibility gate (mirrored
  server-side inside the action for defence-in-depth), and renders
  `<BadgeQrClient>`.
- `app/globals.css` — added `@media print` rules that hide site chrome
  (nav / ticker / footer / compte header / tabs / `.print-hide`) and
  center `.print-badge` on the printable page at A6/A7 proportions.
- `scripts/compte-smoke.ts` — updated the `/compte/badge` assertions to
  match the new page structure (BIS+ header, event context, "Générer mon
  badge" trigger).
- `package.json` — added `qrcode ^1.5.4` (prod dep), `@types/qrcode
  ^1.5.6` (devDep), `test:qr` script.

### Design decisions taken in-phase

- **PNG data URL over inline SVG.** `<img src="data:image/png;...">`
  cannot execute embedded scripts, so the QR pipeline avoids
  `dangerouslySetInnerHTML` entirely. 512px PNG is adequate for both
  mobile display and A6/A7 print.
- **rawToken NOT returned from the action as a string.** Only embedded in
  the QR pixels of the PNG. Confirmed by test that the raw ASCII token
  never appears as a substring in the data URL.
- **Rate limit at 10s / participant.** Guards the DB against a click-spam
  loop. IP-level throttling is deferred to Phase 13.
- **Separate audit action `badge.rotate.self`** written on top of the
  Phase 2 service's `badge.rotate`. Meta: `{ credentialId,
  previousCredentialId, accountUserId }`. Lets a future security review
  distinguish attendee-initiated from admin-initiated rotations.
- **Physical neck-badge visual** = fixed 3:4 portrait, Cobalt header band
  + Lime accent + initials-in-Cobalt disc + name + participation label +
  reserved square QR slot + status pill. No photo (deferred). Prints
  consistently at ~90mm width with 12mm margins.
- **No separate `/compte/badge/print` route.** The suggested route in
  the original spec would have required rotating the credential on every
  print visit — instead we use `window.print()` with scoped media rules
  that reformat the current page. The user prints exactly what they see;
  no extra rotation, no extra audit noise. See "Deferred" below.
- **Two-column responsive layout.** Badge on the left (print target),
  controls + security notes on the right (hidden in print).

### Security properties (per Phase 5 review)

- **Every eligibility check runs server-side** inside the action. The
  client's hidden trigger for ineligible participants is UX, not a
  security control.
- **No client-side authorization** — `requireAccount()` resolves the
  identity from the session cookie; the action never accepts a client
  `participantId`.
- **rawToken never crosses the JSON boundary as a string.** Only inside
  the QR pixels.
- **QR image is data URL** — `<img src="data:image/png;...">` cannot
  execute script; no XSS vector.
- **Rotation invalidates the previous credential atomically** — the
  Phase 2 service does this in a transaction; the DB partial unique
  index prevents any concurrent double-active race.
- **All lifecycle events audited.** Service writes `badge.rotate`,
  action writes `badge.rotate.self` — two rows per view.
- **`data:` URL doesn't hit the network** — screenshots and OCR would be
  the only ways to intercept the QR outside the display session.

### Verification

- `npm run typecheck` → clean.
- `npm run test:qr` → **4 / 4** (new).
- `npm run test:badge` → **28 / 28** (Phase 2 service unaffected).
- `npm run test:rbac` → **31 / 31** (no regression).
- `npm run test:access` → **5 / 5** (no regression).
- `scripts/compte-smoke.ts` → **14 / 14** across populated + empty
  scenarios. `/compte/badge` renders the full physical neck-badge, event
  context, and the "Générer mon badge" trigger.

### Security review

**OK. No BLOCK, no WARN.** The reviewer explicitly confirmed:
- PNG-only response is meaningful protection, not theater.
- The `getCompteContext` cache continues to select only
  `status/issuedAt/expiresAt` from ACTIVE credentials — no `tokenHash`
  regression.
- `<img src="data:image/png;base64,...">` is not an XSS vector.
- `qrcode@^1.5.4` is the well-maintained soldair package; no known
  critical CVEs at this version.
- `useActionState` binding with no arguments is safe — the action
  discards the FormData React normally passes and re-derives identity
  from the session.

### Deferred (recorded here for the doc's Section 25)

- **`/compte/badge/print` as a separate route.** Not built. `window.print()`
  from `/compte/badge` uses print-media rules on the same page — the
  attendee prints the QR they are currently looking at, without triggering
  another credential rotation. If a distinct print route is required
  later, decide first whether the extra rotation is acceptable.
- **Real photo upload.** Initials-in-Cobalt disc is used; the
  `BadgeCard` component's identity block will accept a `photoUrl` prop
  later without any layout change.
- **IP-level rate limiting** on the regenerate action — deferred to
  Phase 13 (security review pass over the whole system).
- **REVOKED credential retention policy** — rotation accumulates one
  row per view. At 10s minimum spacing the worst case is ~360
  rows/hour/participant. A pruning policy (e.g. delete REVOKED older
  than 30 days post-event) can be introduced later without changing the
  active-flow architecture.

### Files intentionally NOT touched

- `prisma/schema.prisma` — schema unchanged.
- `lib/badge/{token,service,errors}.ts` — Phase 2 service unchanged.
- `lib/admin/rbac.ts` — RBAC unchanged.
- `app/admin/(protected)/check-in/**` — legacy manual flow untouched.
- `middleware.ts`, `lib/db.ts`, `lib/account/auth.ts` — unchanged.

### Physical neck-badge concept

```
┌──────────────────────────────────┐
│ BIS+                             │
│ ALGERIA BRAND IMPACT SUMMIT 2026 │
│                                  │
│        [ PHOTO / INITIALS ]      │
│                                  │
│      FIRST NAME  LAST NAME       │
│      PARTICIPATION TYPE          │
│      COMPANY / ROLE (if any)     │
│                                  │
│         [ QR CODE ]              │
│                                  │
│ 15 NOVEMBRE 2026 · CIC ALGER     │
│         Badge actif              │
└──────────────────────────────────┘
```

### Photo policy

No `photoUrl` field exists on `AccountUser` or `Participant`. **Do not
build a fake upload system, blob storage, or invented photo URL.** Use a
premium initials-in-Cobalt-disc treatment. Keep the badge layout
extensible so a real photo field can slot in later.

### QR credential

- Reuse the Phase 2 service. Do not build a parallel QR pipeline.
- Server-side render the QR (using `qrcode` npm package — to be added in
  this phase). Return SVG or PNG data URL from the server component.
- QR payload = the opaque raw token returned by
  `issueBadgeCredential()` / `rotateBadgeCredential()`. **Nothing else.**
  No personal data. No room permissions. No JWT.
- The raw token is generated once at issuance; it never leaves the server
  again except embedded in this QR display. On rotation, the old token is
  irrelevant and the new one replaces it.

### Print route

- `/compte/badge/print` — browser-print optimized layout.
- No server-side PDF pipeline. Ctrl+P → Save as PDF is the intended flow.
- Layout should be A6-ish / neck-badge proportional.

### Badge status states

`Badge actif · Badge en attente · Badge suspendu · Badge révoqué` — derived
from `BadgeCredential.status` + participant eligibility, never a hardcoded
frontend flag.

### Exit criteria

- QR renders on desktop and mobile at a scannable size (adequate quiet
  zone, high contrast).
- Print layout works with `window.print()`.
- Security review for any server actions added (issuance may need one).
- Report — STOP for `GO`.

---

## 9. Phase 6 — Attendee Access History  ·  COMPLETE

Implementation date: 2026-09-18.

### What was implemented

Replaced the "À venir · Historique de check-in" placeholder card on
`/compte/acces` with a real read-only list of the attendee's own `CheckIn`
rows, joined to `AccessPoint`. The tri-state access-matrix card (built in
the pre-Phase-5 hardening pass) is unchanged.

**Data flow:**

```
requireAccount()
      ↓
getCompteContext(account)         [cached, participant.id now included]
      ↓
getCheckInHistoryForParticipant(participant.id)
      ↓
prisma.checkIn.findMany({
  where:   { participantId },       ← ownership scope (server-derived only)
  orderBy: { scannedAt: "desc" },
  take:    50,                      ← CHECKIN_HISTORY_BOUND
  select:  { scannedAt, result,     ← attendee-facing whitelist
             accessPoint: { slug, name, type } }
})
      ↓
list rows: date + time + AccessPoint.name + result pill
```

### Files added

| File                                                | Purpose                                                                 |
|-----------------------------------------------------|-------------------------------------------------------------------------|
| `scripts/access-history.test.ts`                    | 8 tests: ownership isolation, ordering, `take: 50` bound, legacy-null accessPointId, ParticipantAccess ≠ CheckIn, empty case, field whitelist (shape + AccessPoint join). |

### Files modified

- `lib/account/participant.ts` — added `id: true` to the participant
  `select` (server-only usage; never rendered — verified by review) and
  a new `getCheckInHistoryForParticipant(participantId)` cached helper
  with the whitelist select and `take: CHECKIN_HISTORY_BOUND = 50`.
- `lib/account/labels.ts` — added `CHECKIN_RESULT_LABEL` +
  `CHECKIN_RESULT_TONE` maps covering all seven `CheckInResult` enum
  values in attendee vocabulary (e.g. `ALREADY_CHECKED_IN → "Déjà
  présent"`, `VALID → "Accès enregistré"`).
- `app/compte/acces/page.tsx` — imports the history helper, renders the
  new "Passages enregistrés" card below the existing matrix. Legacy
  CheckIn (`accessPoint === null`) renders as "Point d'accès non
  répertorié" — no invention of an access point from the legacy `gate`
  string. Empty state = neutral "Aucun accès enregistré" card.
- `scripts/compte-smoke.ts` — smoke fixture now seeds 3 CheckIns (VALID
  at main, `ALREADY_CHECKED_IN` at room-01, one legacy row with
  `accessPointId=null`). Assertions extended to match new markers. Also
  added an explicit `deleteMany({ ticketCode: { startsWith: "SMK-" } })`
  at teardown to prevent orphan CheckIn accumulation from the schema's
  `onDelete: SetNull` — verified 0 orphans post-run.
- `package.json` — added `test:history` script.

### Design decisions

- **`CheckIn` is the ONLY source for history.** `ParticipantAccess`
  represents *permission*, not *event* — deliberately excluded from the
  history render. Test explicitly asserts that granting room access
  does not fabricate a CheckIn row.
- **`AccessPoint` is authoritative for point identity.** The legacy
  `CheckIn.gate` string is never rendered as history metadata. If
  `accessPointId` is null (pre-Phase-1 rows), the UI shows a neutral
  fallback — never guesses or invents an AccessPoint from `gate`.
- **`id: true` addition to participant select.** The id is used
  server-side only (scoping the CheckIn query). Reviewer grep confirmed
  no JSX in `/compte/**` renders `participant.id` as visible text or
  attribute — it appears only as a function argument.
- **50-row bound** (`CHECKIN_HISTORY_BOUND` constant). Attendees at a
  3-day event won't come close; the cap guards render cost. No
  user-controllable pagination — no offset manipulation surface.
- **Row key = `scannedAt.toISOString() + "-" + idx`.** No internal id
  in the DOM; `scannedAt` is already rendered in the row's `<time>` so
  no additional information leaks via the key.
- **`reason` field is admin-facing free text and deliberately NOT
  selected** — even if a future admin surface displays it, the attendee
  path never does.

### Security properties (per Phase 6 review)

- **No IDOR.** Every participantId reaches the query only through
  `requireAccount() → getParticipantForAccount(account.id) →
  participant.id`. No `params`, `searchParams`, `formData`, or
  `headers()` involvement — reviewer confirmed by inspection.
- **Sensitive-field whitelist enforced by test.** The select shape is
  duplicated in the test file so any accidental widening at the query
  layer fails a test at read time.
- **Read-only.** No `.create/.update/.delete/.upsert/executeRaw/
  revalidatePath` anywhere in `page.tsx` or the new helper. No
  `"use server"` directive. Verified by reviewer grep.
- **AccessPoint join narrowed** to `{slug, name, type}` — no admin
  fields.
- **ParticipantAccess never displayed as history** — tested.

### Verification

- `npm run typecheck` → clean.
- `npm run test:history` → **8 / 8** (new).
- `npm run test:rbac` → **31 / 31** (no regression).
- `npm run test:badge` → **28 / 28** (no regression).
- `npm run test:access` → **5 / 5** (no regression).
- `npm run test:qr` → **4 / 4** (no regression).
- `scripts/compte-smoke.ts` → **14 / 14** across populated + empty
  scenarios; history section renders with all expected labels (`Accès
  enregistré`, `Déjà présent`, `Point d'accès non répertorié`).
- Post-smoke DB check → 0 SMK-prefixed CheckIn orphans.

### Security review

**OK. No BLOCK, no WARN.** Reviewer explicitly confirmed:
- IDOR: participantId only ever server-derived.
- `id: true` addition: no `.id` rendered as JSX text/attribute in any
  `/compte/**` page.
- Select whitelist matches the schema field list.
- `reason` correctly excluded (admin free-text).
- `take: 50` bounded, no user-controllable pagination surface.
- No mutations from this page or helper.

### Files intentionally NOT touched

- `prisma/schema.prisma` — schema unchanged.
- `lib/badge/**` — Phase 5 badge service and QR pipeline unchanged.
- `lib/admin/rbac.ts` — RBAC unchanged.
- `app/admin/(protected)/check-in/**` — legacy manual flow untouched.
- `middleware.ts`, `lib/db.ts`, `lib/account/auth.ts` — unchanged.
- No new dependency, no new server action, no new cookie behaviour.

### Deferred (unchanged from prior phases)

- Admin-side access matrix + CheckIn history view → Phase 7.
- REVOKED credential retention/pruning policy → post-event.
- IP-level rate limiting → Phase 13.

---

## 10. Phase 7 — Admin Participant Access Matrix  ·  COMPLETE

Implementation date: 2026-09-18.

### What was implemented

Extended the existing admin registrant detail page
(`app/admin/(protected)/registrants/[id]/page.tsx`) with a two-panel
row (Badge + Access Matrix) inserted above the existing Check-in
history section. **No parallel admin page was created.**

### Server actions (`app/admin/(protected)/registrants/[id]/access-actions.ts`)

Four `"use server"` actions, uniform security shape:

```
await requirePermission(perm)      ← actor from session, never form
   ↓
idSchema.parse(participantId)      ← cuid shape guard
   ↓
assertParticipantTarget(id)        ← Participant.findUnique — closes
                                     the "grant to AdminUser.id" vector
   ↓
[assertActiveAccessPoint(apId)]    ← for room actions: refuse unknown/inactive
   ↓
mutate + audit(before/after)       ← one AuditLog row per mutation
   ↓
revalidatePath(`/admin/registrants/${participantId}`)
```

| Action                       | Permission      | Notes                                                                                                   |
|------------------------------|-----------------|---------------------------------------------------------------------------------------------------------|
| `grantRoomAccessAction`      | `access.manage` | Upsert `ParticipantAccess` with `granted=true, grantedById=user.id`; clears any prior revoke fields.    |
| `revokeRoomAccessAction`     | `access.manage` | Upsert with `granted=false, revokedById=user.id`. Row is **updated, not deleted** — preserves tri-state. |
| `rotateBadgeAsAdminAction`   | `badge.manage`  | Calls Phase 2 `rotateBadgeCredential(pid, user.id, reason)`. **rawToken discarded server-side** — never returned/logged. |
| `revokeBadgeAsAdminAction`   | `badge.manage`  | Looks up ACTIVE credential id, delegates to Phase 2 `revokeBadgeCredential`. Idempotent NOOP when no ACTIVE. |

**Audit rows** written:

- `access.grant` / `access.revoke` — meta: `{ accessPointId, accessPointSlug, accessPointType, before, after }`.
- `badge.rotate` (by Phase 2 service) + `badge.rotate.admin` (by this action, meta = reason).
- `badge.revoke` (by Phase 2 service, only when a real revoke occurs) + `badge.revoke.admin` (always, meta = `{ outcome, reason, revokedCredentialId }`).

### Data helper

`lib/admin/queries.ts` gained `getRegistrantAccessContext(participantId)`
returning `{ activeCredential (status/issuedAt/expiresAt only — no
tokenHash), permissions (accessPointId/granted/timestamps), accessPoints
(id/slug/name/type) }`. Whitelist select; runs in a single
`Promise.all` round-trip.

### UI

- **`badge-panel.tsx`** — client component. Renders ACTIVE credential
  status + Rotate/Revoke buttons (gated by `canManage`). Confirm dialog
  with optional reason input; `useTransition` calls the action; server
  errors surfaced inline.
- **`access-matrix.tsx`** — client component. 6-row tri-state matrix
  (granted / denied / unassigned) with per-row Grant / Revoke buttons
  (gated by `canManage`). Per-row error surface on server rejection.
- **`page.tsx`** — added `mayViewAccess / mayManageAccess / mayManageBadge`
  gates via `can(user.role, …)`. Loads `getRegistrantAccessContext`
  conditionally. Renders the panels in a new `grid lg:grid-cols-2` row
  above the existing check-in history.

### Design decisions

- **Revoke updates, never deletes.** Setting `granted=false` on the
  existing row (or creating one) preserves the tri-state defined in the
  pre-Phase-5 hardening pass. An admin later can see "explicitly denied"
  distinct from "never granted".
- **Client-side gating is UX only.** `canManage` hides buttons; every
  server action re-checks via `requirePermission(...)`. A crafted POST
  from a role without the permission is redirected to
  `/admin/dashboard?denied=…` inside `requirePermission` before any
  mutation runs.
- **Target must be a Participant.** `assertParticipantTarget` re-queries
  `Participant.findUnique` — the Phase 3 carry-forward warned that
  `REGISTRATION_MANAGER` must not be able to grant room access to an
  `AdminUser`. Since Participant and AdminUser are distinct tables, an
  AdminUser cuid resolves to `null` and the action throws.
- **rawToken discipline on admin rotation.** The Phase 2 service returns
  `{rawToken, credentialId, previousCredentialId}`; the admin action
  invokes it as an expression statement — never destructures rawToken —
  and the `badge.rotate.admin` audit row meta contains only `{reason}`.
  Test explicitly asserts the raw token never appears in the service's
  own `badge.rotate` audit meta.
- **Reason schema.** Zod trim, `.max(500)`, refine reject
  `/^[A-Za-z0-9_-]{40,}$/` (token-shape guard). Applied to the two badge
  actions. Grant/revoke access do NOT accept a reason today — deferred
  as compliance choice (see below).
- **`revalidatePath` URL, not filesystem path.** The
  `ROOM_ACCESS_SCOPE = "admin/registrants"` constant emits the correct
  routed URL; route groups `(protected)` are stripped, and there is no
  `/app` URL prefix. This was fixed after the security review flagged a
  MED bug where the initial value was `"app/admin/(protected)/registrants"`
  (a filesystem-shaped string) that silently no-op'd the revalidation
  and left admins looking at stale state.

### Tests

`scripts/access-admin.test.ts` — **15 tests, 6 suites**:

- RBAC baseline for `access.manage` + `badge.manage`.
- Target validation: AdminUser id must not resolve to a Participant.
- Tri-state semantics: grant then revoke keeps the row (updates to
  `granted=false`), does NOT delete.
- Cross-participant isolation: mutating P1 does not touch P2.
- Admin rotation via Phase 2 service: rawToken absent from the
  service's `badge.rotate` audit meta; subsequent revoke is
  idempotent (NOOP).
- Reason schema: accepts normal input, normalizes empty/whitespace to
  null, rejects 43-char base64url (token-shaped), rejects >500 chars.

The suite exercises the SAME mutation paths and validators as the
`"use server"` actions — going through the request boundary would need
a Next.js runtime the test host does not have. This mirrors the
pattern used by `scripts/badge-credential.test.ts` and
`scripts/access-history.test.ts`; request-level plumbing is covered by
`security-reviewer` + `compte-smoke.ts`.

### Verification

- `npm run typecheck` → clean.
- `npm run test:access-admin` → **15 / 15** (new).
- `npm run test:badge` → **28 / 28** (no regression).
- `npm run test:rbac` → **31 / 31** (no regression).
- `npm run test:access` → **5 / 5** (no regression).
- `npm run test:qr` → **4 / 4** (no regression).
- `npm run test:history` → **8 / 8** (no regression).
- `scripts/compte-smoke.ts` → **14 / 14** across populated + empty
  scenarios.

Total: 105 tests passing.

### Security review

**WARN → resolved in-phase.** The reviewer flagged one MED bug and two
LOW findings:

- **MED (fixed)**: `revalidatePath` called with a filesystem-shaped
  path — fixed by changing `ROOM_ACCESS_SCOPE` from
  `"app/admin/(protected)/registrants"` to `"admin/registrants"`.
- **LOW (fixed)**: `access-matrix.tsx` swallowed server errors silently
  — added a per-row `error` state that surfaces the server-action
  rejection message inline.
- **LOW (deferred, documented)**: reason on access grant/revoke — a
  compliance judgment call. Not required by the current spec; can be
  added in a later hardening pass if GDPR Art. 5 or ISO 27001 A.9.2.2
  becomes in scope.

Reviewer explicitly confirmed:

- Actor authenticity: `user.id` derived exclusively from
  `requirePermission(...)`. No form/header shortcut.
- Target-type enforcement: `assertParticipantTarget` correctly blocks
  AdminUser ids.
- rawToken discipline: admin rotation never returns, stores, or logs
  the token.
- Client-side gating is UX-only; server actions re-check permission.
- `credentialId` returned by the query is passed to the panel prop but
  the panel type excludes it — nothing DOM-visible.
- All four action names (`access.grant`, `access.revoke`,
  `badge.rotate` + `.admin`, `badge.revoke` + `.admin`) match the
  master-doc contract.

### Files touched in Phase 7

- `app/admin/(protected)/registrants/[id]/access-actions.ts` — **new**, four server actions.
- `app/admin/(protected)/registrants/[id]/badge-panel.tsx` — **new**, client component.
- `app/admin/(protected)/registrants/[id]/access-matrix.tsx` — **new**, client component.
- `app/admin/(protected)/registrants/[id]/page.tsx` — added imports, permission gates, and the new panels row above check-in history.
- `lib/admin/queries.ts` — added `getRegistrantAccessContext`.
- `scripts/access-admin.test.ts` — **new**, 15 tests.
- `package.json` — added `test:access-admin` script.

### Files intentionally NOT touched

- `prisma/schema.prisma`, `lib/badge/**` (Phase 2 service unchanged),
  `lib/admin/rbac.ts`, `middleware.ts`, `lib/db.ts`,
  `lib/account/auth.ts`, `app/admin/(protected)/check-in/**` (legacy
  manual flow unchanged), all `/compte/**` (attendee UI unchanged).

### Deferred (recorded in §25)

- **Reason field on access grant/revoke** — compliance judgment call.
- **`MAIN_ENTRANCE`-in-matrix policy** — the current implementation
  allows admins to grant/revoke the main entrance via
  `ParticipantAccess` like any room. The main-entrance validator
  (Phase 10) will define whether ParticipantAccess overrides the
  paid+confirmed default — flagged for the Phase 10 decision.
- **Toast/notification UX** for successful mutations — currently
  relies on the page revalidation being visible.
- **REVOKED credential retention/pruning policy** — post-event.
- **IP-level rate limiting** — Phase 13.

---

## Phase 7 Final Audit / Pre-Phase-8 Gate  ·  COMPLETE

Audit date: 2026-09-18.

Focused hardening review of the completed Phase 7 implementation before
Phase 8 (AccessPoint administration) begins. No Phase 8 code was
written; no schema change; no unrelated systems touched.

### Audit scope

Sections 1–13 of the pre-Phase-8 audit brief:

- Access management authorization (server-side, before mutation).
- Badge vs access separation (badge.manage cannot substitute for
  access.manage or vice versa).
- Tri-state semantics (unassigned / denied / granted preserved).
- Mutation idempotency (spec §4 explicit expectations).
- Audit trail integrity ("exactly one meaningful audit event per real
  mutation").
- Cross-participant isolation.
- `revalidatePath` URL-not-filesystem.
- No scope leak into future phases.
- AccessPoint dependency inventory for Phase 8.
- Phase-10 main-entrance decision preservation.

### Findings

**Two audit-noise defects surfaced (LOW). Both fixed in-phase. No security
vulnerability, no BLOCK, no WARN outstanding.**

#### Finding A — `granted → grant` and `denied → revoke` were NOT NOOPs

Spec §4 required:

```
granted → grant   → NOOP
denied  → revoke  → NOOP  (by symmetry, implicit)
```

The Phase 7 implementation unconditionally called `upsert` (rewriting
`grantedAt`/`revokedAt`) and wrote an audit row even when the desired
state matched the current state. Two redundant writes per admin
double-click.

**Fix:** extracted a pure guard
`app/admin/(protected)/registrants/[id]/access-mutation-guard.ts` with
`isAccessMutationNoop(before, desiredGranted)`. Both `grantRoomAccessAction`
and `revokeRoomAccessAction` call it right after fetching `before` and
`return` early on true — no upsert, no audit, no `revalidatePath`. The
`unassigned → revoke` path is deliberately still a mutation (creates the
explicit "denied" row) since the pre-Phase-5 hardening pass locked in
that behavior.

#### Finding B — `revokeBadgeAsAdminAction` audited on NOOP

Spec §5 required "exactly one meaningful audit event per real mutation".
When the admin clicked Revoke on a participant with no ACTIVE
credential, `revokeBadgeAsAdminAction` still wrote `badge.revoke.admin`
with `outcome: "NOOP"` in meta — 1 audit row for 0 mutations. The
Phase 2 service's own `badge.revoke` correctly skips its audit on NOOP,
so the admin wrapper was inconsistent.

**Fix:** wrapped the `audit()` call in `if (outcome === "REVOKED")`. The
`revalidatePath` still fires (the admin's page needs to reflect that
their click was received). No behavioral change on the happy path.

### Verified explicitly — no code change required

- **Actor authenticity** (§1, §5, §12): all four actions derive `user.id`
  exclusively from `requirePermission(...)`. Grep for
  `formData\.get\(.actor|actorId` in `app/admin/(protected)/registrants/[id]`
  returned 0 matches.
- **Badge vs access separation** (§2): grantRoom/revokeRoom require
  `access.manage`; rotateBadge/revokeBadge require `badge.manage`. Neither
  path touches the other model. Grep confirms the four actions do not
  reference `adminUser.update|delete|upsert`, `accountUser.update|delete|upsert`,
  `checkIn.create|update|delete`, or `paymentStatus|paymentAmount`.
- **Target-type enforcement** (§1, §6): `assertParticipantTarget` fires
  on every action before any mutation. AdminUser ids cannot resolve as
  Participant (separate tables); `access-admin.test.ts` covers this.
- **rawToken / tokenHash exposure** (§2, §5): grep for `rawToken|tokenHash`
  in the Phase 7 tree returned only comments and French UI copy — no
  live code path reads or writes either.
- **Tri-state semantics** (§3): revoke still writes `granted=false` (row
  updated, not deleted). Preserved.
- **`revalidatePath` URL semantics** (§7): `ROOM_ACCESS_SCOPE =
  "admin/registrants"` — URL path, not filesystem path. Fixed during
  the original Phase 7 review; audit re-confirms.
- **No scope leak** (§8): no AccessPoint admin UI, no scanner UI, no
  QR validation, no mobile badge, no profile-edit. Grep confirms.
- **Phase 10 main-entrance decision** (§10): Phase 7 does NOT encode any
  main-vs-room rule — the four actions treat every AccessPoint
  identically. The decision remains deferred to Phase 10.

### Tests

`scripts/access-admin.test.ts` gained a new suite:

- **NOOP guard (6 tests)** — every cell of the tri-state × grant/revoke
  matrix is asserted to return the correct NOOP verdict. Ensures the
  behavior of Finding A's fix is locked in and any future regression to
  unconditional upsert fails a test.

### Verification

- `npm run typecheck` → clean.
- `npm run test:access-admin` → **21 / 21** (+6 vs pre-audit baseline).
- `npm run test:badge` → **28 / 28** (no regression).
- `npm run test:rbac` → **31 / 31** (no regression).
- `npm run test:access` → **5 / 5** (no regression).
- `npm run test:qr` → **4 / 4** (no regression).
- `npm run test:history` → **8 / 8** (no regression).
- `scripts/compte-smoke.ts` → **14 / 14** across populated + empty
  scenarios.

Total: **111 tests passing** (up from 105); zero regressions.

### Security review

**PASS. No BLOCK, no WARN.** The two findings above are audit-log
hygiene, not security defects — both narrow the audit surface (fewer
rows, cleaner intent) rather than widening it. No new mutation path,
no new authorization surface, no new file exposed to the client bundle.

The self-checklist against the audit's §12 categories:

| Category                                | Status                       |
|-----------------------------------------|------------------------------|
| Privilege escalation                    | unchanged — permissions still checked |
| access.manage bypass                    | unchanged                    |
| badge.manage bypass                     | unchanged                    |
| IDOR / cross-participant mutation       | unchanged (still scoped)     |
| Wrong target type                       | unchanged                    |
| Actor spoofing                          | unchanged (session-derived)  |
| Duplicate audit events                  | **fixed** (Findings A + B)   |
| rawToken / tokenHash exposure           | unchanged (not exposed)      |
| Stale authorization state               | unchanged (revalidate on real mutations) |
| Client-side-only authorization          | unchanged (server re-checks) |
| Unintended mutation of unrelated systems | unchanged (grep-confirmed)  |

### Files changed in this audit

- **`app/admin/(protected)/registrants/[id]/access-mutation-guard.ts`**
  — new (pure sync helper, no `"use server"`).
- **`app/admin/(protected)/registrants/[id]/access-actions.ts`** —
  imported the guard; added early returns in `grantRoomAccessAction`
  and `revokeRoomAccessAction`; wrapped the `badge.revoke.admin` audit
  in `if (outcome === "REVOKED")`.
- **`scripts/access-admin.test.ts`** — new 6-test suite for the guard.

### Phase 8 prerequisites & constraints discovered

Phase 8 will build `/admin/access-points`. The following existing
dependencies must be respected — none require pre-Phase-8 code, but
Phase 8 must NOT silently break them.

1. **`AccessPoint` is a FK target from two tables:**
   - `ParticipantAccess.accessPointId` → `onDelete: Cascade`.
     Deleting an AccessPoint wipes all ParticipantAccess rows for it,
     erasing grant/revoke history for that point.
   - `CheckIn.accessPointId` → `onDelete: SetNull`. Deleting an
     AccessPoint sets historical scan rows' point to NULL, and the
     `/compte/acces` history renders them as "Point d'accès non
     répertorié" (Phase 6 legacy-fallback).
   - **Phase 8 policy required**: **prefer `active=false` (deactivation)
     over deletion** whenever the point has any linked `ParticipantAccess`
     or `CheckIn` row. Hard delete should require an explicit,
     confirm-then-confirm flow (or be forbidden entirely).

2. **`AccessPoint.slug` is a stable identifier — no code depends on it
   today, but Phase 9 will:**
   - Master doc Phase 9 spec: `/admin/scan/[access-point-slug]`.
   - Once Phase 9 lands, renaming a slug breaks any bookmarked / printed
     scanner URL that operators may have loaded onto tablets.
   - **Phase 8 policy required (deferred to Phase 9 for enforcement)**:
     make slug immutable after creation, OR gate slug rename behind
     confirmation that surfaces "N historical CheckIns reference this
     slug via URL bookmarks".
   - **Phase 8 for now**: renaming slug is not currently forbidden by
     any code; a Phase-8 admin edit form should treat slug as
     append-once or add a warning.

3. **`AccessPoint.type` has business meaning that Phase 10/11 will
   depend on:**
   - `MAIN_ENTRANCE` → paid+confirmed default (per Phase 10 spec).
   - `ROOM` → `ParticipantAccess.granted=true` required (per Phase 11
     spec).
   - **Phase 8 policy required**: type is set at creation and should
     NOT be edited post-creation. Changing an existing point's type
     silently switches the validator behavior for every historical
     grant.

4. **`AccessPoint.active` is the safe "operational off-switch":**
   - Currently used by `listAccessPoints` (attendee /compte/acces),
     `getRegistrantAccessContext` (admin registrant detail), and
     `assertActiveAccessPoint` (Phase 7 admin actions refuse mutations
     against inactive points).
   - Setting `active=false` immediately removes the point from the
     attendee matrix AND blocks all Phase 7 admin actions against it,
     while retaining every existing `ParticipantAccess` and `CheckIn`
     row unchanged.
   - **Phase 8 should surface `active` as the primary Enable/Disable
     verb**, with delete reserved for the never-used case.

5. **Six seeded AccessPoints (`main`, `room-01`…`room-05`) are the
   entire venue model today.** Tests, smoke, and the /compte/acces
   attendee display all assume these exist. Phase 8 must not delete
   any of them by default; the seed script continues to populate them
   on `npm run db:seed`.

6. **RBAC for Phase 8** (deferred, but noted):
   - No `access-points.*` permission currently exists. Phase 8 will
     need to introduce one (e.g., `access-points.manage`) or reuse
     `settings.manage`. This is a Phase 8 decision, not this audit's.
   - Attendees must never reach `/admin/access-points`; the existing
     `middleware.ts` + `app/admin/(protected)/layout.tsx` chain
     already guards `/admin/*` — Phase 8 inherits this.

### Unresolved business decisions (unchanged from Phase 7)

- **Optional `reason` on access grant/revoke** — compliance judgment.
- **`ParticipantAccess.MAIN_ENTRANCE`-overrides-payment** — Phase 10.
- **Slug immutability policy** — surfaces at Phase 9; Phase 8 should
  at least warn on rename.

---

**Phase 7 is cleared for Phase 8.** Awaiting explicit `GO — Phase 8`
before starting Phase 8 (AccessPoint administration).

---

## 11. Phase 8 — AccessPoint Administration  ·  COMPLETE

Implementation date: 2026-09-18.

### What was implemented

Admin surface at **`/admin/access-points`** for managing the venue's
`AccessPoint` rows. Reuses existing RBAC — no new permission strings.
List loaded from DB (never hardcoded), matching the Phase 5/6/7 pattern.

**Routes:**

- `GET /admin/access-points` — `requirePermission("access.view")` gates
  the READ. SUPER_ADMIN + ADMIN + REGISTRATION_MANAGER can see the
  list. REGISTRATION_MANAGER sees it read-only.

**Six server actions** (`app/admin/(protected)/access-points/actions.ts`),
all requiring `settings.manage` (SUPER_ADMIN + ADMIN):

| Action                              | Rule enforced server-side                                                              |
|-------------------------------------|----------------------------------------------------------------------------------------|
| `createAccessPointAction`           | Zod on name/slug/type/order. DB `@unique` on slug → P2002 surfaced as friendly message. |
| `updateAccessPointNameAction`       | Always allowed. NOOP short-circuit when name unchanged.                                |
| `updateAccessPointSlugAction`       | Refused when `_count.checkIns > 0` (slug becomes URL-load-bearing in Phase 9).         |
| `updateAccessPointOrderAction`      | NOOP short-circuit.                                                                    |
| `toggleAccessPointActiveAction`     | Always allowed both directions. NOOP short-circuit.                                    |
| `deleteAccessPointAction`           | Refused when `_count.checkIns > 0 OR _count.permissions > 0`. Deactivate instead.       |

Uniform security shape (identical to Phase 7):

```
await requirePermission("settings.manage")   ← actor from session
   ↓
Zod parse (name/slug/type/order/id)
   ↓
guard rules (checkIns count, permissions count, uniqueness)
   ↓
NOOP short-circuit if desired === current
   ↓
mutate + audit({actor, entity, entityId, before, after})
   ↓
revalidatePath("/admin/access-points")
```

**Type is create-only.** No `updateType` action exists. Changing
MAIN_ENTRANCE ↔ ROOM post-creation would silently flip validator
behavior for every historical grant. Enforced structurally: the actions
file is grep-checked in `access-points.test.ts` to prove no
`updateAccessPointType|setAccessPointType|changeAccessPointType`
export exists.

### Files added

| File | Purpose |
|------|---------|
| `app/admin/(protected)/access-points/actions.ts` | Six server actions. |
| `app/admin/(protected)/access-points/page.tsx` | List page (server, `access.view` gate). |
| `app/admin/(protected)/access-points/point-row.tsx` | Client row: click-to-edit, per-row error surface, delete-confirm dialog. |
| `app/admin/(protected)/access-points/create-form.tsx` | Client form: collapsed by default, only when `canManage`. |
| `scripts/access-points.test.ts` | 12 tests: RBAC, slug guard, delete guard, deactivate-preserves, type-immutability, cascade behaviour. |
| `scripts/admin-smoke.mjs` | Manual admin-render check (dev-only, not in npm scripts). |

### Files modified

- `lib/admin/queries.ts` — added `getAccessPointsWithUsage()` returning
  every AP + `_count.checkIns` + `_count.permissions`. Explicit
  whitelist; no nested relations.
- `components/admin/sidebar.tsx` — added "Access points" nav entry under
  the Event group, gated by `access.view`.
- `package.json` — added `test:access-points` script.

### Design decisions

- **RBAC reuse instead of new permission.** Read = `access.view`
  (existing since Phase 3); mutate = `settings.manage` (existing since
  before Phase 3). SUPER_ADMIN + ADMIN both hold `settings.manage`;
  REGISTRATION_MANAGER holds only `access.view` → naturally read-only.
  Introducing `access-points.manage` would be finer-grained but is not
  a security defect — deferred as scope discipline.
- **Slug-lock trigger is CheckIn count only** (not ParticipantAccess).
  ParticipantAccess is FK-referenced by id, so a slug rename doesn't
  break grant data. CheckIn history rows are what operators
  reference in printed reports and (starting Phase 9) in scanner
  bookmarks. A rename after grants exist but before any scan just
  requires re-issuing bookmarks with the new slug.
- **Delete blocks on either count > 0.** The seeded 6 points typically
  hold ParticipantAccess in normal operation → effectively undeletable
  in production. Intended per the audit's "seeded points must remain".
  Only truly-empty admin-created points can be hard-deleted.
- **Deactivation preserves every linked row.** `active=false` hides the
  point from `/compte/acces` (attendee matrix) and blocks the Phase 7
  admin actions via `assertActiveAccessPoint` — but leaves every
  ParticipantAccess and CheckIn intact. Re-enabling is always allowed.
- **NOOP short-circuits.** Every mutation checks `before === desired`
  (byte-strict for name; lowercased-then-strict for slug) and returns
  silently — no audit noise from admin double-clicks. Matches the
  Phase 7 hardening pattern.
- **Slug regex `^[a-z0-9]+(?:-[a-z0-9]+)*$`.** ASCII-only, anchored, no
  path-traversal characters, no unicode homographs. `.toLowerCase()`
  in the Zod parser normalizes before matching.

### Security properties (per Phase 8 review)

- Actor from session only — no `formData.get("actor")` anywhere.
- Client-side `canManage` gating is UX-only; every action re-checks
  `requirePermission("settings.manage")` before any Prisma write.
  Crafted POST from a REGISTRATION_MANAGER redirected to
  `/admin/dashboard?denied=settings.manage` before any mutation runs.
- `getAccessPointsWithUsage` select is a strict whitelist (no relations
  to Participant/AdminUser).
- `createAccessPointAction`'s `FormData` path is fully Zod-validated;
  `type` uses `nativeEnum(AccessPointType)` rejecting anything outside
  `MAIN_ENTRANCE|ROOM`.
- No `$queryRawUnsafe`, no `dangerouslySetInnerHTML`, no secret logs.
- AuditLog: one row per real mutation. Six action strings written:
  `access-point.create`, `.rename`, `.slug`, `.reorder`, `.activate` /
  `.deactivate`, `.delete`. NOOP short-circuits skip the audit row
  correctly (no state change to record).

### Phase 8 audit constraints — all satisfied

| Pre-Phase-8 constraint (from audit doc) | Status |
|-----------------------------------------|--------|
| Prefer `active=false` over deletion when linked rows exist | ✓ enforced |
| Delete requires no CheckIn AND no ParticipantAccess links | ✓ enforced |
| Slug immutable when CheckIn references exist | ✓ enforced |
| Type is create-only (never editable) | ✓ enforced structurally |
| `active` is the primary operational off-switch | ✓ UI leads with Deactivate |
| Six seeded points remain by default | ✓ verified in test |
| RBAC decision (new perm vs reuse) documented | ✓ reused `settings.manage` |

### Verification

- `npm run typecheck` → clean.
- `npm run test:access-points` → **12 / 12** (new).
- `npm run test:access-admin` → **21 / 21** (no regression).
- `npm run test:badge` → **28 / 28** (no regression).
- `npm run test:rbac` → **31 / 31** (no regression).
- `npm run test:access` → **5 / 5** (no regression).
- `npm run test:qr` → **4 / 4** (no regression).
- `npm run test:history` → **8 / 8** (no regression).
- `scripts/compte-smoke.ts` → **14 / 14** attendee routes (no regression).
- `curl /admin/access-points` unauth → `307 → /admin/login` (auth guard).
- `scripts/admin-smoke.mjs` with SUPER_ADMIN session → `200` with
  markers `"Access points"`, `"Configuration des points"`, `"Entrée
  principale"`, `"Salle 01"`, `"Nouveau point d…"` all present.

Total: **123 tests passing**, zero regressions, admin render verified
end-to-end.

### Security review

**OK. No BLOCK, no WARN.** Reviewer explicitly confirmed:

- Every mutation opens with `requirePermission("settings.manage")` at
  the head of the action.
- Slug rename correctly guarded on `checkIns > 0` only (ParticipantAccess
  lock would be excessive).
- Delete guard is TOCTOU-safe (count + fetch in the same round-trip).
- Type immutability holds structurally — grep-locked by test.
- NOOP short-circuits do not hide real mutations (byte-strict compare on
  name; lowercased-strict on slug).
- Slug regex is path-traversal safe and unicode-homograph safe.
- No leaks through `getAccessPointsWithUsage`.
- Client-side gating is UX-only; server re-checks are watertight.
- AuditLog is complete: one row per successful mutation, actor always
  session-derived, before/after meta on every applicable action.

### Files intentionally NOT touched

- `prisma/schema.prisma` — no schema change.
- `lib/admin/rbac.ts` — no new permission strings, no role-map edits.
- `lib/badge/**`, `lib/account/**` — Phase 2/5/6 code unchanged.
- `middleware.ts`, `lib/db.ts`, `lib/admin/auth.ts` — unchanged.
- Any /compte/** attendee routes — unchanged.
- Any /admin/(protected)/registrants/** Phase 7 code — unchanged.

### Deferred (unchanged from prior phases + minor)

- **Reorder via drag-and-drop** — Phase 8 offers numeric-order edit only.
  A DnD reorder UX is deferred (adds a new dep or a heavy handler).
- **`MAIN_ENTRANCE` overrides payment** — Phase 10 decision, still open.
- **REVOKED credential retention/pruning** — post-event.
- **IP-level rate limiting** — Phase 13.
- **Slug-rename URL-bookmark warning** — once Phase 9 wires
  `/admin/scan/[slug]`, the slug-rename dialog could surface "N
  operators may have this slug bookmarked". Not strictly needed today
  because the CheckIn-count lock already forbids rename after scans.

Awaiting explicit `GO — Phase 9` before starting Phase 9 (Scanner UI).

---

## Phase 8 Final Audit / Pre-Phase-9 Gate  ·  COMPLETE

Audit date: 2026-09-18.

Focused hardening review of the completed Phase 8 implementation before
Phase 9 (Scanner UI at `/admin/scan/[access-point-slug]`) begins. No
Phase 9 code was written; no schema change; no scanner, no QR decoder,
no `html5-qrcode` installed. **No code changes were required** — every
audit checkpoint passed on the shipped Phase 8 code.

### Audit scope

Sections 1–7 of the pre-Phase-9 audit brief: slug stability, RBAC scope
for `settings.manage`, `active` semantics, delete safety, type
immutability, cross-cutting security, and the Phase 9 boundary.

### Findings

**Zero findings. No BLOCK. No WARN.** Every check verified against the
shipped implementation. No code change required.

### Verified explicitly

#### 1. Slug stability — safe for Phase 9 as shipped

Current behavior (`app/admin/(protected)/access-points/actions.ts:180-187`):

| State                    | Slug rename allowed? |
|--------------------------|----------------------|
| No CheckIn, no PA        | ✓ allowed            |
| ParticipantAccess exists, no CheckIn | ✓ allowed  |
| Any CheckIn exists       | ✕ refused (locked)   |

**Decision: NO code change.** Rationale:

- A slug becomes "operationally load-bearing" only once operators have
  scanned at that point — that is exactly the trigger the current
  guard uses. Before the first scan, no operator bookmark can exist
  yet for that URL, and no printed report references it. Rename is
  safe.
- Adding a ParticipantAccess-based lock would refuse the rename in a
  scenario where no scanner has ever addressed the point — that would
  be more restrictive than the master doc requires (Phase 8 spec
  explicitly says "slug is immutable if it has historical CheckIn
  rows"), and it would prevent a legitimate admin correction like
  "renamed room-06 to room-a-annex" before the room opens.

**Phase 9 must honor this by design.** Scanner routes are
`/admin/scan/[access-point-slug]` and must:

- Resolve the slug at request time via a DB lookup, not a hardcoded
  map. `getAccessPointsWithUsage` already returns the current slug
  list from the DB; the scanner will use an equivalent
  slug→AccessPoint helper.
- Return a clean 404-equivalent (or a "point d'accès inconnu" refusal)
  when the slug does not resolve. Never assume it always does.
- Never persist the slug string as authorization state — always
  resolve to the AccessPoint id server-side before any authorization
  or validation logic runs.

#### 2. `settings.manage` scope — correct as shipped

Baseline confirmed by grep + rbac read:

| Role                    | `access.view` (read page) | `settings.manage` (mutate) |
|-------------------------|---------------------------|----------------------------|
| SUPER_ADMIN             | ✓                         | ✓                          |
| ADMIN                   | ✓                         | ✓                          |
| REGISTRATION_MANAGER    | ✓ (Phase 3)               | ✕ (read-only page)         |
| CHECKIN_OPERATOR        | ✕                         | ✕                          |
| SALES / CONTENT / SPONSOR / FINANCE / ANALYTICS / VIEWER | ✕ | ✕ |

The six mutating actions each open with
`await requirePermission("settings.manage")` at line 66, 125, 168, 222,
265, 303 of `actions.ts` — before any DB access. The page opens with
`requirePermission("access.view")` at `page.tsx:22`.

**Decision: NO code change.** `settings.manage` reuse is documented and
sufficient. A dedicated `access-points.manage` permission would give
finer role granularity (e.g. a "venue configurator" who can edit
AccessPoints but not other admin settings), but no current authorization
defect requires it. Recorded as a deferred architectural option.

#### 3. `active` semantics — correct as shipped

- `active=true` → visible in the attendee `/compte/acces` matrix (via
  `listAccessPoints` which filters `where: { active: true }`).
- `active=true` → mutations in Phase 7's admin registrant matrix are
  allowed (via `assertActiveAccessPoint`).
- `active=false` → hidden from attendees; Phase 7 mutations refuse;
  Phase 8 `toggleAccessPointActiveAction` can re-enable.
- Toggling is idempotent (NOOP short-circuit when `before === desired`).
- Deactivation never touches `ParticipantAccess` or `CheckIn` rows —
  verified in `access-points.test.ts` (both linked-row-preservation
  tests pass).

**Recorded for Phase 10/11:** all future validators (main entrance
and per-room QR scanners) MUST require `AccessPoint.active === true`
before allowing any scan. A deactivated point must produce a clean
"point désactivé" refusal, not a validation attempt. This becomes a
Phase 10/11 exit criterion.

#### 4. Delete safety — correct as shipped

- `deleteAccessPointAction` refuses when `_count.checkIns > 0 OR
  _count.permissions > 0` (`actions.ts:318-324`).
- Guard replicated by the UI (`point-row.tsx:46-47`), but the server
  is the source of truth — a crafted POST is refused with the same
  friendly message.
- Test `deleting an empty point works and leaves seeded points intact`
  proves the seed set (6 points) survives any legitimate delete.
- Schema cascades (`ParticipantAccess.accessPointId onDelete: Cascade`,
  `CheckIn.accessPointId onDelete: SetNull`) mean that even if the
  guard were bypassed, the outcome for `CheckIn` history is
  preservation (SetNull, not delete) — no historical scan record is
  ever destroyed. `ParticipantAccess` cascade would wipe grant history
  for that point, which is exactly why the guard exists.

**Decision: NO code change.** Delete safety is layered:
application-level refusal, then DB-level SetNull on scan history.

#### 5. Type immutability — correct as shipped

- No `updateAccessPointType|setAccessPointType|changeAccessPointType`
  export exists in `actions.ts` — verified structurally by the test
  at `access-points.test.ts:296-311` which reads the source file and
  grep-asserts absence.
- Edit form (`point-row.tsx:216-219`) renders type as read-only text
  with an explanatory sentence.
- Create form (`create-form.tsx`) is the only place `type` can be
  set — and only at creation time, gated by `settings.manage`.

**Decision: NO code change.**

#### 6. Cross-cutting security — clean

- `access.view` server-side gate at `page.tsx:22`. Confirmed.
- `settings.manage` server-side gate on all 6 mutations (grep-verified,
  each at the head of its action before any DB read).
- Actor: `user` from `requirePermission(...)`. Grep for
  `formData\.get\(.actor|actorId` in the access-points tree → **0
  matches**.
- Target validation: every mutating action calls `idSchema.safeParse`
  and then `prisma.accessPoint.findUnique` before any write.
- Slug validation: ASCII-only Zod regex
  `^[a-z0-9]+(?:-[a-z0-9]+)*$`. Path-traversal safe.
  Unicode-homograph safe. Anchored.
- No client-side-only authorization: `canManage` prop hides UI; every
  server action re-checks `requirePermission("settings.manage")`
  which redirects to `/admin/dashboard?denied=settings.manage`
  before any DB write.
- No unsafe HTML: grep for `dangerouslySetInnerHTML` in
  access-points tree → **0 matches**.
- No secret/token leakage: grep for `verifyBadgeToken`, `hashBadgeToken`,
  `generateBadgeToken`, `revokeBadgeCredential`, `rotateBadgeCredential`,
  `checkIn.create`, `html5-qrcode` in access-points tree → **0
  matches**. Phase 8 does not touch the badge lifecycle or CheckIn
  creation.
- `revalidatePath`: uses URL path (`"/admin/access-points"`) — the
  filesystem-path bug from Phase 7 cannot recur here (single, obvious
  string in one constant at `actions.ts:48`).
- No mutations outside AccessPoint: grep for
  `adminUser.(update|delete|upsert)|accountUser.(update|delete|upsert)|participant.(update|delete|upsert)|badgeCredential.(create|update|delete|upsert)|checkIn.(create|update|delete)|participantAccess.(create|update|delete|upsert)|paymentStatus`
  in access-points tree → **0 matches**. Only `prisma.accessPoint.*`
  writes happen here.

#### 7. Phase 9 boundary — clean

Grep across `app/admin/(protected)/access-points/**` for:

```
verifyBadgeToken | generateBadgeToken | hashBadgeToken
checkIn.create   | revokeBadgeCredential | rotateBadgeCredential
html5-qrcode
```

→ **0 matches**. The only mentions of "scanner" / "Phase 9" in the
tree are inside code comments explaining the slug-lock rationale.
No scanner code, no QR decoder, no BadgeCredential verification, no
CheckIn creation, no room-validation logic, no main-entrance
validator, no mobile scanner code.

### Tests

**No new tests required.** The Phase 8 test file (`access-points.test.ts`,
12 tests) already covers every audit checkpoint at the code level:

- RBAC baseline (settings.manage held only by SUPER_ADMIN + ADMIN;
  REGISTRATION_MANAGER read-only; others neither).
- Slug guard when CheckIns exist.
- Delete guard when either count > 0.
- Deactivate preserves linked ParticipantAccess + CheckIn.
- Type immutability structurally locked (grep of source).
- Cascade behaviour on empty delete + seeded-set intact.

### Verification

- `npm run typecheck` → clean.
- `npm run test:access-points` → **12 / 12**.
- `npm run test:access-admin` → **21 / 21**.
- `npm run test:badge` → **28 / 28**.
- `npm run test:rbac` → **31 / 31**.
- `npm run test:access` → **5 / 5**.
- `npm run test:qr` → **4 / 4**.
- `npm run test:history` → **8 / 8**.
- `scripts/compte-smoke.ts` → **14 / 14** attendee routes (populated
  + empty account).
- `scripts/admin-smoke.mjs` with SUPER_ADMIN session → **`200` at
  `/admin/access-points`** with all expected markers.
- `curl` on `/admin/access-points` unauth → **`307 → /admin/login`**
  (auth guard).

**Total: 109 tests + 14 attendee routes + 1 admin route all green,
zero regressions.**

### Security review: PASS

No BLOCK, no WARN. Every mutation is authenticated, authorized,
audit-logged, target-validated, and constrained to `AccessPoint`
writes only. No token/secret exposure. No client-side-only
authorization. No unsafe HTML. No cross-model mutations.

### Files changed in this audit

**None.** The Phase 8 code as shipped passed every checkpoint.

### Phase 9 prerequisites & constraints discovered

Phase 9 will build `/admin/scan/[access-point-slug]` — the browser-based
webcam scanner. The following existing behaviours are what Phase 9 must
respect:

1. **Slug resolution must be dynamic.** Every scanner request MUST
   resolve the URL slug to an AccessPoint id via a DB lookup at
   request time. Never cache a `slug → AccessPoint` map in code
   (Phase 8 explicitly designed for slug renamability before first
   scan).

2. **Unknown slug → clean refusal.** If the slug does not resolve,
   Phase 9 must return a "point d'accès introuvable" refusal, not a
   validation attempt against a fabricated point. Match the Phase 8
   `assertActiveAccessPoint` refusal shape.

3. **Inactive point → scanner refuses to open.** Phase 8 uses
   `active = false` as the operational off-switch. Phase 9's route
   must check `active === true` before rendering the scanner shell
   and MUST NOT allow the operator to scan against a deactivated
   point.

4. **Type-aware validation branch (Phase 10/11).**
   - `MAIN_ENTRANCE` → Phase 10 rule (paid + confirmed default; the
     `ParticipantAccess.MAIN_ENTRANCE`-overrides-payment question
     remains open).
   - `ROOM` → Phase 11 rule (`ParticipantAccess.granted === true`
     required).
   Phase 9 (scanner UI) itself is transport; the branching decision
   lives in Phase 10 / 11's validator services.

5. **Operator RBAC.**
   - Main-entrance scanner requires `access.validate.main`.
   - Room scanner requires `access.validate.room`.
   - Both are STRICT (per the pre-Phase-5 hardening): the legacy
     `checkin.validate` does NOT grant either. Phase 9 must use
     `requirePermission("access.validate.main" | ".room")`, NOT the
     `canValidateMainEntrance` helper (removed OR fallback), and NOT
     the `checkin.validate` permission.

6. **URL is authorization-adjacent, not authorization-authoritative.**
   Even if the URL says `/admin/scan/room-01`, Phase 9 must
   independently look up the AccessPoint and check permission based
   on the resolved point's type — never trust the slug string itself
   to route authorization.

7. **New dependency (`html5-qrcode`) will need install** — the master
   doc's Phase 9 section describes this. Client-only. Its
   `postinstall` will retrigger `prisma generate`.

### Unresolved business decisions (unchanged, carried forward)

- **Optional `reason` on access grant/revoke** — compliance judgment.
- **`ParticipantAccess.MAIN_ENTRANCE` overrides payment** — Phase 10.
- **Deferred: `access-points.manage` permission** — a dedicated
  permission would allow a "venue configurator" role separate from
  the general `settings.manage` scope. Not required today; can be
  added later without breaking existing users of `settings.manage`.
- **REVOKED credential retention/pruning** — post-event.
- **IP-level rate limiting** — Phase 13.

---

**Phase 8 is cleared for Phase 9.** Awaiting explicit `GO — Phase 9`
before starting Phase 9 (Scanner UI).

---

## 12. Phase 9 — Scanner UI  ·  COMPLETE

Implementation date: 2026-09-18.

### What was implemented

Admin scanner shell at **`/admin/scan/[access-point-slug]`** — the
transport layer only. Client-side QR decoding via `html5-qrcode`.
Server-side authorization chain gates the page before any camera code
loads on the client. No BadgeCredential verification, no CheckIn
mutation, no ParticipantAccess touch — those are deliberately reserved
for Phase 10 (main entrance) and Phase 11 (rooms).

### Authorization chain (server-side, sequential)

```
1. requireAdmin()                             ← any authenticated admin
2. slugSchema.safeParse(rawSlug)              ← reject malformed slug
3. getAccessPointBySlug(slug)                 ← DB lookup, no cache
4. notFound() if null                         ← clean refusal
5. requiredScannerPermission(point.type)      ← type-derived permission
6. requirePermission(perm)                    ← strict, no legacy fallback
7. active check → disabled shell OR scanner   ← never mount camera on inactive
```

The URL slug never acts as authorization on its own. The DB resolves the
point first, and only after we know the `AccessPoint.type` do we
escalate to the type-specific permission via
`requiredScannerPermission()` — a pure switch that returns
`"access.validate.main"` for MAIN_ENTRANCE and `"access.validate.room"`
for ROOM. It never returns `"checkin.validate"`.

### Files added

| File | Purpose |
|------|---------|
| `app/admin/(protected)/scan/[access-point-slug]/page.tsx` | Server component. Slug Zod schema, auth chain, active/disabled branch, renders `<ScannerClient>` on happy path. |
| `app/admin/(protected)/scan/[access-point-slug]/scanner-client.tsx` | Client component (`"use client"`). `html5-qrcode` mount, camera lifecycle, state machine, cooldown, transient decoded state. |
| `lib/admin/scanner-permission.ts` | Pure `AccessPointType → Permission` mapper. No React, no Prisma, no `server-only` marker — importable from tests. |
| `scripts/scanner.test.ts` | 26 tests: RBAC strictness, auth-chain ordering, absence of Phase 10/11 code, raw-credential discipline, camera lifecycle, client boundary. |

### Files modified

- `lib/admin/queries.ts` — added `getAccessPointBySlug(slug)` with a
  whitelist select (`id/slug/name/type/active`). Every scanner request
  re-hits this helper (no in-process cache) so a slug rename or a
  deactivation takes effect immediately.
- `package.json` — added `html5-qrcode ^2.3.8` (prod dep) +
  `test:scanner` script.
- `scripts/admin-smoke.mjs` — added six Phase 9 checks (SUPER_ADMIN
  main + CHECKIN_OPERATOR room, VIEWER refusal for both, unknown slug
  and path-traversal both → 404).

### Design decisions

- **Slug schema mirrors Phase 8 create/rename.** Anchored
  `^[a-z0-9]+(?:-[a-z0-9]+)*$`, trimmed, `toLowerCase`, min 2, max 48.
  Path-traversal safe (no `/`, no `.`), unicode-homograph safe
  (ASCII-only), and rejected BEFORE any DB access.
- **`requiredScannerPermission` is a total switch, not a table lookup.**
  Adding a new `AccessPointType` value in the future is a TypeScript
  compile error until the switch is extended — the compiler enforces
  Phase 9's authorization contract structurally.
- **Active check runs LAST in the chain.** An unauthorized admin never
  sees "Scanner désactivé" — they are redirected to
  `/admin/dashboard?denied=…` before that render happens. Prevents
  active/inactive-state disclosure to unauthorized operators.
- **Disabled branch renders BEFORE `<ScannerClient>`.** The camera
  library is not even imported into the render subtree when
  `active === false`, so a deactivated point cannot be scanned via a
  crafted DOM injection or client console fiddling.
- **`checkin.validate` fallback is explicitly rejected.** The strict
  helpers `canValidateMainEntrance` / `canValidateRoom` in `rbac.ts`
  exist as convenience wrappers but the scanner page does NOT use them
  — it calls `requirePermission(requiredPerm)` directly with the
  type-derived permission string. Grep-locked by a test.
- **Server component never imports `html5-qrcode`.** Only the
  `"use client"` file does. Bundle discipline verified by a structural
  test.
- **Decoded credential lives NOT in state.** The `decoded` argument in
  the onDecode callback is intentionally NOT stored — the state
  machine transitions to `{ kind: "detected", at: <timestamp> }`,
  which is stronger than "transient state" and eliminates the whole
  class of accidental-render leaks. The credential exists only as a
  bound argument in the callback closure and is dropped when the
  cooldown ends.
- **Camera prefers `facingMode: "environment"`.** Rear camera on mobile
  where supported; library falls back to the default camera if the
  request cannot be satisfied.
- **Cooldown 1500 ms between accepted decodes.** Protects against
  bursts when the same QR stays in frame — html5-qrcode fires the
  decode callback continuously.
- **Camera lifecycle:** instantiation is guarded (`if
  (!scannerRef.current)` before `new Html5Qrcode(...)`); `stopScanner`
  checks `getState() === 2` (SCANNING) before `.stop()`, then
  `.clear()`, wrapped in nested try/catch so unmount never throws.
  Cleanup runs in `useEffect`'s teardown.
- **Error surface renders a fixed French message.** The raw browser
  error string is never rendered — it can carry userAgent or engine
  leaks in some builds. Lowercase-substring matching maps the raw
  message to one of four small state values: `permission-denied`,
  `no-camera`, `error`, `stopped`.

### Security properties (verified)

- **Auth chain runs server-side before any client code.** `page.tsx`
  is a server component; `requireAdmin()` → slug validation →
  `getAccessPointBySlug()` → `notFound()` → `requirePermission()` all
  complete before `<ScannerClient>` is even in the render tree.
- **Type/permission confusion impossible.** The `type` field is read
  from the DB row after `findUnique`, not from the URL slug. The
  scanner page passes `point.type` (a Prisma enum) to
  `requiredScannerPermission`. A slug like `main` mapped to a ROOM
  row would still authorize under `access.validate.room`, not
  `access.validate.main`.
- **Legacy `checkin.validate` leakage impossible.**
  `requiredScannerPermission` returns only
  `access.validate.main | access.validate.room`; grep test verifies
  no other permission string appears. `page.tsx` does not import
  `canValidateMainEntrance` (the OR-fallback helper).
- **Raw QR credential — never leaves the browser in Phase 9.**
  Verified by test: no `console.log/warn/info/debug`, no
  `localStorage/sessionStorage/indexedDB/document.cookie`, no
  `fetch/sendBeacon/XMLHttpRequest`, no
  `window.location/pushState/replaceState/URLSearchParams`, no `{decoded}`
  in JSX. The decoded value is a local argument in the callback and
  is dropped after `void decoded;`.
- **No CheckIn mutation, no BadgeCredential verification.** Structural
  test greps for `checkIn.create/update/upsert/delete`,
  `verifyBadgeToken/hashBadgeToken/generateBadgeToken/rotateBadgeCredential/revokeBadgeCredential/issueBadgeCredential`,
  `participantAccess` — all zero matches across the scanner tree.
- **`getAccessPointBySlug` whitelist.** `id/slug/name/type/active`
  only. No timestamps, no relations, no counts.
- **Client-side authorization impossible.** All gates live on the
  server. A crafted `POST` from an unauthenticated tab hits the
  middleware+session gate before reaching the page component. A
  crafted `POST` from a VIEWER session redirects to
  `/admin/dashboard?denied=access.validate.main|room` before any
  render.

### Type-aware RBAC baseline

| Role                    | `access.validate.main` | `access.validate.room` |
|-------------------------|------------------------|------------------------|
| SUPER_ADMIN             | ✓ (via ALL)            | ✓ (via ALL)            |
| ADMIN                   | ✓ (via ALL.filter)     | ✓ (via ALL.filter)     |
| CHECKIN_OPERATOR        | ✓                      | ✓                      |
| REGISTRATION_MANAGER    | ✕                      | ✕                      |
| SALES / VIEWER / others | ✕                      | ✕                      |

Room permission is TYPE-level, not per-room scope. A CHECKIN_OPERATOR
authorized for `access.validate.room` may operate the scanner for any
ROOM AccessPoint. Per-room operator scoping is not part of Phase 9 (not
in the master doc's Phase 9 spec).

### Verification

- `npm run typecheck` → clean.
- `npm run test:scanner` → **26 / 26** (new).
- `npm run test:access-points` → **12 / 12** (no regression).
- `npm run test:access-admin` → **21 / 21** (no regression).
- `npm run test:badge` → **28 / 28** (no regression).
- `npm run test:rbac` → **31 / 31** (no regression).
- `npm run test:access` → **5 / 5** (no regression).
- `npm run test:qr` → **4 / 4** (no regression).
- `npm run test:history` → **8 / 8** (no regression).
- `scripts/compte-smoke.ts` → **14 / 14** attendee routes.
- `scripts/admin-smoke.mjs` → SUPER_ADMIN `/admin/scan/main` → **200**;
  CHECKIN_OPERATOR `/admin/scan/room-01` → **200**; VIEWER
  `/admin/scan/main` → **307** `?denied=access.validate.main`; VIEWER
  `/admin/scan/room-01` → **307** `?denied=access.validate.room`;
  SUPER_ADMIN `/admin/scan/room-does-not-exist` → **404**; SUPER_ADMIN
  `/admin/scan/<url-encoded ../../etc/passwd>` → **404**.

**Total: 135 tests passing** (+26 for Phase 9), 14 attendee routes,
6 Phase 9 admin smoke checks all green.

### Security review

**OK. No BLOCK, no WARN.** Reviewer explicitly confirmed:

- Auth chain runs strictly server-side and in the correct order.
- Slug Zod schema is anchored, ASCII-only, path-traversal safe,
  homograph-safe; malformed slugs are rejected before any DB access.
- Inactive-AccessPoint branch returns BEFORE `<ScannerClient>` renders
  — camera library never mounts for disabled points.
- `requiredScannerPermission` is a total switch; `checkin.validate` is
  unreachable.
- Scanner page does not import `canValidateMainEntrance` (the
  OR-fallback helper exists for potential legacy consumers but is
  unused here — strict single-permission path via `requirePermission`).
- Client boundary clean: `scanner-client.tsx` imports React,
  `html5-qrcode`, `@/lib/utils`, and a compile-time-erased Prisma
  type. `page.tsx` does not import `html5-qrcode`.
- Raw-credential discipline: `decoded` never logged, never persisted,
  never in URLs, never rendered, never even stored in state — the
  `void decoded;` line is the only reference.
- Camera lifecycle: `useEffect` cleanup calls `stopScanner()`;
  instantiation guarded against double-start; `getState() === 2` check
  before `.stop()`; unmount cannot throw.
- No Phase 10/11 code in the scanner tree: 0 matches for
  `checkIn.*`, badge-service functions, or `participantAccess`.
- `getAccessPointBySlug` select is whitelisted; no relation leak.
- Error rendering uses a fixed French message; raw
  `err.message`/userAgent hints never surfaced.
- IDOR clean: AccessPoint always resolved from URL slug via
  `findUnique` with whitelist select; type-derived permission comes
  from the DB row, not the URL.

### Deferred (Phase 10 / 11 boundary)

- **Server-side QR validation** — Phase 10 (main entrance) and
  Phase 11 (rooms) will introduce a
  `validateQrAtAccessPoint(rawToken, accessPointId)` server action.
  The Phase 9 scanner-client's onDecode callback marks the integration
  point with a `// ▶ handleDecoded(decoded)` comment; no stub call is
  wired.
- **`ACCÈS AUTORISÉ` / `ACCÈS REFUSÉ` result UI** — reserved for
  Phase 10/11. Phase 9's `detected` state renders only a neutral
  "QR détecté" panel with a "Reprendre le scan" resume button.
- **CheckIn row creation** — Phase 10/11.
- **Access-history mutation, main-entrance approval, room approval,
  denial decisions** — Phase 10/11.

### Files intentionally NOT touched

- `prisma/schema.prisma` — no schema change.
- `lib/badge/**` — Phase 2 service unchanged.
- `lib/admin/rbac.ts` — no new permission strings, no role-map edits.
- `middleware.ts`, `lib/db.ts`, `lib/admin/auth.ts`,
  `lib/account/auth.ts` — unchanged.
- `app/admin/(protected)/check-in/**` — legacy manual flow untouched.
- `app/admin/(protected)/registrants/**` — Phase 7 code unchanged.
- `app/admin/(protected)/access-points/**` — Phase 8 code unchanged.
- All `/compte/**` attendee routes — unchanged.

### New dependency (justified)

- `html5-qrcode ^2.3.8` (prod dep). Widely-used browser QR decoder
  (MIT). Client-only; imported exclusively from the
  `"use client"` scanner component. No server-side use.

Awaiting explicit `GO — Phase 10` before starting Phase 10 (Main
entrance validation).

---

## Phase 9 Final Audit / Pre-Phase-10 Decision Gate  ·  IN PROGRESS

Audit date: 2026-09-18.

Focused review of the existing check-in machinery before Phase 10
(MAIN_ENTRANCE QR validation) begins. **No code was changed.** Phase 9
remains PASS. This section documents the confirmed business rules the
QR validator can inherit from the existing manual flow AND the open
business decisions that must be answered by the project owner before
Phase 10 can be coded without inventing behaviour.

### Phase 9 status

**PASS. Unchanged from the Phase 9 completion record above.** The
scanner transport layer is in place, tests pass (135 total), admin
smoke covers happy path + refusals + malformed slug. No fix required
during this gate.

### 1. Existing manual `validateTicket` flow — confirmed behaviour

`app/admin/(protected)/check-in/actions.ts:44-184`. Order of checks:

1. `requirePermission("checkin.validate")` — operator derived from the
   admin session, never from form input.
2. Trim + uppercase the ticket code. Empty string → `UNKNOWN`.
3. Lookup by `ticketCode` OR `id`. No participant → log `UNKNOWN`.
4. `participant.status === CANCELLED` → log `CANCELLED`.
5. `participant.paymentStatus !== PAID` → log `UNPAID`.
6. `participant.gate && participant.gate !== gate` → log `WRONG_GATE`.
7. `participant.checkedInAt` set → log `ALREADY_CHECKED_IN` (returns
   prior timestamp, no re-write, idempotent).
8. Otherwise → `participant.update({ checkedInAt: now, checkedInGate:
   gate })` and log `VALID`.

Every branch writes a `CheckIn` row via `logScan()` (no
`accessPointId`, no `credentialId` — those are the Phase-1 nullable
additions still unused by the manual flow). Every branch also writes
an `AuditLog` row with `action: "checkin.scan"`.

**Notable properties of the existing flow:**

- **`ParticipantAccess` is NEVER consulted.** The manual flow reads
  `Participant.paymentStatus`, `.status`, `.gate`, and `.checkedInAt`
  only. It has no notion of a per-participant per-access-point grant
  row for the MAIN_ENTRANCE. This is important context for decision
  **B1** below.
- **The `checkedInAt` write is not atomic.** Step 7 (read
  `checkedInAt`) and step 8 (`participant.update(...)`) are separate
  round-trips. Two concurrent scans against the same participant could
  both pass step 7 and both write step 8. Neither is deduped. This is
  a pre-existing defect, not a Phase 9 regression — logged here as
  decision **B3**.
- **No `WRONG_TIME` production.** The enum value exists and has an
  attendee label ("Hors créneau") but the manual flow never produces
  it. No session-window check is enforced today.

### 2. Existing `CheckInResult` enum semantics — inventory

Values used by production code today:

| Value                | Manual-flow trigger                                    | Attendee label            |
|----------------------|--------------------------------------------------------|---------------------------|
| `VALID`              | First scan, all gates passed → `checkedInAt := NOW()`  | "Accès enregistré"        |
| `ALREADY_CHECKED_IN` | Repeat scan on a participant with `checkedInAt` set    | "Déjà présent"            |
| `WRONG_GATE`         | `Participant.gate` set and differs from operator gate  | "Porte incorrecte"        |
| `CANCELLED`          | `participant.status === CANCELLED`                     | "Inscription annulée"     |
| `UNKNOWN`            | Ticket lookup miss OR empty code                       | "Scan non identifié"      |
| `UNPAID`             | `paymentStatus !== PAID`                               | "Paiement non confirmé"   |
| `WRONG_TIME`         | Never produced by production code today                | "Hors créneau"            |

For the QR-side denials introduced by Phase 10 (`REVOKED`, `EXPIRED`,
`INVALID` badge), see decision **B2** below.

### 3. AccessPoint resolution — Phase 10 will inherit Phase 9

Confirmed by inspection of `app/admin/(protected)/scan/[access-point-slug]/page.tsx`
and `lib/admin/queries.ts:getAccessPointBySlug()`:

- Slug is resolved to an AccessPoint id via DB lookup, no in-process cache.
- `active === true` is enforced before the scanner shell mounts.
- `type === MAIN_ENTRANCE` gates the strict permission
  `access.validate.main`.
- Slug string is not authorization on its own.

**Recommendation for Phase 10:** the future
`validateQrAtAccessPoint(rawToken, accessPointId)` server action MUST
independently re-check `AccessPoint.active === true` at the moment of
validation. The scanner tab may have been loaded before the point was
deactivated; the server action is the authoritative gate.

### 4. Security boundary — Phase 10 architecture (confirmed target)

```
QR decoded by browser                (Phase 9 — transport only)
       ↓
scanner-client onDecode(rawToken)    (opaque string, transient)
       ↓
POST server action                   (Phase 10 to build)
   • no participantId from client
   • no accessPointId from URL string — the action derives it
     from the server-resolved AccessPoint of the scanner route
   • rawToken carried as an opaque credential
       ↓
requirePermission("access.validate.main")
       ↓
verifyBadgeToken(rawToken)           (lib/badge/service.ts)
       ↓
AccessPoint.active === true          (defense-in-depth re-check)
       ↓
MAIN_ENTRANCE rules                  (decision B1 — SEE BELOW)
       ↓
ALLOW / DENY
       ↓
CheckIn row + AuditLog row           (rawToken never in either)
```

Verified constraints:

- **Browser must not decide authorization.** Phase 9 already contains
  no server call and no decision; only a transient decoded string.
- **Browser must not submit `participantId` as identity authority.**
  Phase 10 must derive `participantId` from `verifyBadgeToken(rawToken)`
  server-side; a client-supplied `participantId` MUST be rejected or
  ignored.
- **rawToken must never be logged, stored, or written to AuditLog.**
  Phase 2 service already enforces this at the badge layer; Phase 10's
  new action must also not persist it. `lib/badge/token.ts` provides
  `hashBadgeToken()` — if the AuditLog needs a stable identifier for a
  scan, use `credentialId` (already returned by `verifyBadgeToken`),
  never the raw token or its hash.

### 5. Duplicate scan — first-scan idempotency

Existing manual behaviour (confirmed): `ALREADY_CHECKED_IN` is returned
without a re-write when `checkedInAt` is set. **Phase 10 should
preserve this semantic byte-for-byte for the QR path.** Attendees who
present their QR twice at the main entrance should see the same
idempotent outcome as a manual re-scan.

The **race window** in the current manual flow (§1 note) is a separate
concern flagged as decision **B3**. Phase 10 spec §13 already
recommends the atomic pattern `UPDATE Participant SET checkedInAt =
NOW() WHERE checkedInAt IS NULL RETURNING id`.

### 6. Audit — what Phase 10 must record (structural only)

Every Phase 10 scan attempt (ALLOW **and** DENY) must produce exactly
two rows:

- **`CheckIn`** — `participantId`, `operatorId`, `ticketCode` (fill
  from `participant.ticketCode` if present, empty string otherwise),
  `gate` (the legacy string field; fill from `AccessPoint.slug` or
  `.name` for continuity with the manual flow's reporting),
  `result` (`CheckInResult` value), `reason` (safe French phrase),
  `accessPointId` (populated, first Phase-1 field brought to life),
  `credentialId` (populated when `verifyBadgeToken` returned `ok:true`).

- **`AuditLog`** — `userId = operator.id`,
  `action = "checkin.scan.qr"` (distinct from the manual
  `"checkin.scan"` — see recommendation below), `entity =
  "Participant"`, `entityId = participant?.id`, `meta =
  { ticketCode?, accessPointId, accessPointSlug, accessPointType,
     result, reason }`. **No `rawToken`, no `tokenHash`.**

**Recommended action-name convention:** `"checkin.scan.qr"` for the QR
path (distinct from the legacy `"checkin.scan"`). Rationale: preserves
forensic separability between the two authorization surfaces. This is
already the shape Phase 5 uses (`badge.rotate.self` vs. `badge.rotate`).

Do NOT implement audit rows during this gate — this is the
structural spec Phase 10 will implement.

### 7. UNRESOLVED business decisions — must be answered before coding

These are **not** guessable from the code. The master doc has flagged
some of them since Phase 7; they now block Phase 10.

#### B1 — Does `ParticipantAccess` control the MAIN_ENTRANCE?

Today, `ParticipantAccess` rows for MAIN_ENTRANCE **can be created**
by admins via the Phase 7 registrant matrix (which treats every
AccessPoint uniformly). No validator consumes them yet. Phase 10 must
pick one of:

- **Rule A — `ParticipantAccess` IGNORED for MAIN_ENTRANCE.** The QR
  main-entrance validator uses only `paymentStatus === PAID`
  + `status !== CANCELLED`. Matches the manual flow exactly. Any
  MAIN_ENTRANCE row admins have created via the matrix becomes inert
  garbage data — visually confusing but harmless. Financial
  discipline: an unpaid attendee never enters the venue.

- **Rule B — `ParticipantAccess.granted=true` OVERRIDES payment.**
  Admins can grant complimentary main-entrance access to VIPs,
  sponsors, media, guest speakers, etc. via the matrix. `granted=false`
  denies even paid attendees (useful for suspension). Missing row →
  paid+confirmed default. **Financial risk:** any admin with
  `access.manage` (SUPER_ADMIN, ADMIN, REGISTRATION_MANAGER) can now
  waive payment for the main entrance. Add compliance guardrails or a
  narrower permission if this is chosen.

- **Rule C — Paid+confirmed AND `ParticipantAccess.granted !== false`.**
  Payment is authoritative; matrix can DENY paid attendees (suspend,
  incident response) but cannot GRANT unpaid access. Most restrictive
  interpretation.

**Cannot invent this.** Choice depends on finance/marketing/ops
policy (does BIS 2026 hand out complimentary badges? through whom?).

#### B2 — How to represent QR-only denial reasons?

`verifyBadgeToken()` returns four failure reasons; only one has a
clean existing CheckInResult mapping:

| verifyBadgeToken reason  | Suggested existing mapping | Reason string (French) |
|--------------------------|----------------------------|-------------------------|
| `PARTICIPANT_CANCELLED`  | `CANCELLED` (exact match)  | "Inscription annulée"   |
| `INVALID`                | `UNKNOWN`                  | "QR code invalide"      |
| `REVOKED`                | `UNKNOWN` (reuse) OR new   | "Badge révoqué"         |
| `EXPIRED`                | `UNKNOWN` (reuse) OR new   | "Badge expiré"          |

- **Option A — Reuse `UNKNOWN` + `reason` string.** No schema change.
  The `reason` field on `CheckIn` and the AuditLog `meta` preserve the
  discriminant. UI can render distinct staff messages from the
  `reason` string. Cheapest and reversible.

- **Option B — Add `BADGE_REVOKED`, `BADGE_EXPIRED`, `BADGE_INVALID` to
  `CheckInResult`.** Enum migration; dashboards that group by result
  gain first-class buckets. More forensic granularity. Costs a schema
  change + `prisma db push` + label additions in
  `lib/account/labels.ts` + attendee vocabulary decisions.

**Recommendation** (subject to owner confirmation): **A**. No schema
migration mid-project; the discriminant is preserved in the audit
trail. Upgrade to enum values later without breaking existing rows.

#### B3 — Should Phase 10 also fix the manual-flow race?

The existing manual `validateTicket` has a two-step "read then update"
pattern for `checkedInAt` which is race-prone. The Phase 10 spec
already recommends the atomic pattern for the QR path. Question: does
Phase 10 **also** bring the manual flow under the same atomic pattern
(one small change to `validateTicket`), or leave the manual flow
untouched per the "do not break the manual code flow" rule?

- **Option A — QR-only atomic write.** Manual flow unchanged. Preserves
  the strict Phase 10 exit criterion ("Manual `/admin/check-in` code
  flow untouched and still passes any existing test"). Manual-flow
  race remains a known pre-existing defect.

- **Option B — Fix both.** One small change to `validateTicket`
  swapping the two-step for `UPDATE ... WHERE checkedInAt IS NULL
  RETURNING id`. Same observable behaviour on the happy path;
  eliminates the double-mark race. Requires a manual-flow regression
  test.

**Recommendation** (subject to owner confirmation): **B**. The race
window is a real concurrency bug and Phase 10 is a natural moment to
fix it while the check-in code is being touched. But this is a scope
call — Phase 10 spec says "Do not break the manual code flow" and
Option A honours the letter of that instruction.

### 8. Concrete information needed before Phase 10 begins

The three answers above (**B1 A/B/C**, **B2 A/B**, **B3 A/B**) are
sufficient to move Phase 10 from "design-open" to "buildable" without
Claude inventing business behaviour.

### 9. Non-blocking observations

- **Phase 7 already lets admins mutate MAIN_ENTRANCE `ParticipantAccess`
  rows.** If **B1 = A** wins, the master doc should note that
  MAIN_ENTRANCE `ParticipantAccess` rows are informational-only and
  the admin matrix UI could get a "n'affecte pas l'entrée principale"
  hint. Non-blocking.
- **`WRONG_TIME` remains unused.** Not needed by Phase 10; likely
  drops out of the enum during Phase 13 cleanup.
- **Legacy `Participant.gate` string.** The manual flow still uses it
  for `WRONG_GATE` mapping. Phase 10 for the QR path SHOULD NOT
  produce `WRONG_GATE` — the scanner's own AccessPoint is authoritative,
  not a per-participant gate string. Reserved for the manual flow.

### 10. Files intentionally NOT touched in this gate

- No code changes. The gate is a documentation-only pass.
- `prisma/schema.prisma` — unchanged.
- `app/admin/(protected)/check-in/**` — unchanged.
- `lib/badge/**` — unchanged.
- `lib/admin/rbac.ts` — unchanged.

### Gate result

**Phase 9 remains PASS. Phase 10 BLOCKED on business decisions B1,
B2, B3.**

Do not code Phase 10 until B1 has an explicit A/B/C answer. B2 and B3
have recommended defaults (A and B respectively) but should be
confirmed rather than assumed.

Awaiting owner input on B1/B2/B3, then explicit `GO — Phase 10`.

---

## Phase 9 Final Pre-Phase-10 Decision + Schema Gate  ·  COMPLETE

Audit date: 2026-09-18.

Owner decisions recorded and CheckIn schema verified for the four
QR-outcome cases Phase 10 must handle. **No code was changed.** Phase 9
remains PASS. Phase 10 is now unambiguous.

### Owner decisions — locked

- **B1 = C.** MAIN_ENTRANCE requires (payment/registration eligibility)
  AND (`ParticipantAccess.granted !== false`).
- **B2 = A.** Reuse `CheckInResult.UNKNOWN` with a discriminating
  `reason` string (`BADGE_INVALID` / `BADGE_REVOKED` / `BADGE_EXPIRED`).
  No enum values added. No schema change.
- **B3 = B.** Atomic `checkedInAt` claim applied to BOTH the manual
  flow and the new QR flow. Race-condition hardening approved for the
  legacy path — no other legacy semantics change.

### B1 truth table (locked)

Let `PAID_ELIGIBLE` = `paymentStatus === PAID` AND
`status !== CANCELLED`. Let `PA` = the `ParticipantAccess` row for
(participant, MAIN_ENTRANCE) if one exists.

| `PAID_ELIGIBLE` | `PA` row               | Decision              |
|-----------------|------------------------|-----------------------|
| true            | none                   | ALLOW                 |
| true            | `granted = true`       | ALLOW                 |
| true            | `granted = false`      | **DENY** (explicit revocation) |
| false           | none                   | DENY                  |
| false           | `granted = true`       | **DENY** — payment always required, override cannot grant complimentary access |
| false           | `granted = false`      | DENY                  |

`ParticipantAccess.granted = true` MUST NOT waive
payment/eligibility. `ParticipantAccess.granted = false` MUST deny
otherwise-eligible attendees. This is the pre-Phase-5 tri-state
(`accessStateFor` in `lib/account/access-state.ts`) applied to the
MAIN_ENTRANCE row for the first time.

### B2 reason-string vocabulary (locked)

Phase 10 will emit `CheckInResult.UNKNOWN` with one of these reason
strings when the credential path fails at the badge layer:

| verifyBadgeToken reason  | `CheckIn.result` | `CheckIn.reason` | Staff-visible message |
|--------------------------|------------------|------------------|------------------------|
| `INVALID`                | `UNKNOWN`        | `BADGE_INVALID`  | "QR code invalide"    |
| `REVOKED`                | `UNKNOWN`        | `BADGE_REVOKED`  | "Badge révoqué"       |
| `EXPIRED`                | `UNKNOWN`        | `BADGE_EXPIRED`  | "Accès expiré"        |
| `PARTICIPANT_CANCELLED`  | `CANCELLED`      | `PARTICIPANT_CANCELLED` (or omit) | "Inscription annulée" |

**`reason` MUST NEVER contain `rawToken` or `tokenHash`.** Confirmed
by re-reading `lib/badge/token.ts:hashBadgeToken` and the Phase 2
audit-log discipline. Phase 10's reason strings above are opaque
short codes.

### B3 atomic-claim pattern (locked)

Both flows will use a variant of:

```sql
UPDATE "Participant"
SET "checkedInAt" = NOW(),
    "checkedInGate" = <gate-or-null>
WHERE id = $1 AND "checkedInAt" IS NULL
RETURNING id
```

Prisma equivalent: `prisma.participant.updateMany({ where: { id,
checkedInAt: null }, data: { checkedInAt: new Date(), checkedInGate:
gate } })`. If `count === 1` → **VALID** (this scan owns the claim).
If `count === 0` → re-fetch the row and return **ALREADY_CHECKED_IN**
with the persisted `checkedInAt` timestamp.

Applies to:

- **Legacy manual flow** (`app/admin/(protected)/check-in/actions.ts`).
  The current two-step `findFirst + participant.update` will be
  replaced by the single atomic `updateMany`. All other manual-flow
  gates (`WRONG_GATE`, `UNPAID`, `CANCELLED`, `UNKNOWN` on lookup
  miss) remain byte-for-byte identical.
- **New QR MAIN_ENTRANCE action.** Same atomic pattern from day one.

Nothing else in the manual flow changes.

### B4 — CheckIn schema verification (the important gate)

Re-inspected `prisma/schema.prisma:567-598`:

```
model CheckIn {
  id            String        @id @default(cuid())
  participantId String?               ← nullable ✓
  participant   Participant?
  operatorId    String?               ← nullable ✓
  operator      AdminUser?
  ticketCode    String                ← NOT NULL ⚠
  gate          String                ← NOT NULL ⚠
  result        CheckInResult
  reason        String?               ← nullable ✓
  scannedAt     DateTime      @default(now())
  accessPointId String?               ← nullable ✓ (Phase 1)
  accessPoint   AccessPoint?
  credentialId  String?               ← nullable ✓ (Phase 1)
  credential    BadgeCredential?
}
```

**The two hard constraints are `ticketCode: String` (not null) and
`gate: String` (not null).** All identifier fields (`participantId`,
`credentialId`, `accessPointId`, `operatorId`) are nullable. The
manual flow satisfies `ticketCode` by echoing back the operator's
uppercase-trimmed input string, and `gate` from the operator's
selected gate label.

For the four Phase 10 cases:

**Case 1 — Known participant + valid ACTIVE badge → VALID or ALREADY_CHECKED_IN.**
`verifyBadgeToken` returned `{ok: true, participantId, credentialId}`.
CheckIn row fields:
- `participantId` = resolved.
- `credentialId` = resolved.
- `operatorId` = session-derived admin id.
- `ticketCode` = `participant.ticketCode ?? ""` (the participant's own
  code, not the raw QR token). If the participant has no ticketCode
  yet (e.g., account-signup bootstrap before ticket assignment), the
  empty string is a legitimate signal: "no ticket code was in scope
  at scan time." Never the rawToken.
- `gate` = `AccessPoint.slug` (or `.name` — chosen at Phase 10 impl
  time, likely slug for report stability).
- `accessPointId` = resolved.
- `result` = `VALID` | `ALREADY_CHECKED_IN`.
- `reason` = null (or `"first-scan"` / `"repeat-scan"` if desired for
  forensics; the master doc's Phase 6 UI already handles null gracefully).

**Case 2 — Known participant + revoked badge → CheckIn NOT written.**
`verifyBadgeToken` returns `{ok: false, reason: "REVOKED"}` **without
exposing `participantId` or `credentialId` to the caller** (see the
`VerifyResult` union in `lib/badge/service.ts:37-42`). From Phase 10's
perspective, the participant is unresolved. Under B4's "do not
fabricate identifiers" rule and the schema constraint that
`ticketCode` is NOT NULL, **Phase 10 records this via AuditLog only**.
No CheckIn row.

**Case 3 — Known participant + expired badge → CheckIn NOT written.**
Same as case 2. `verifyBadgeToken` returns `{ok: false, reason:
"EXPIRED"}`; no participantId reaches Phase 10. AuditLog only.

**Case 4 — Completely unknown/random QR → CheckIn NOT written.**
`verifyBadgeToken` returns `{ok: false, reason: "INVALID"}` (hash miss
OR shape miss). No participant to attribute. Cannot fabricate a
`ticketCode` from the rawToken (that would leak the credential).
AuditLog only.

### B4 discovered schema constraint (documented, no auto-fix)

The Phase 2 `verifyBadgeToken` return type does NOT expose
`participantId` or `credentialId` on any `{ok: false, ...}` path — even
for `REVOKED` / `EXPIRED` / `PARTICIPANT_CANCELLED` where the service
knows both internally. Combined with `CheckIn.ticketCode: String`
(NOT NULL) and the discipline "never persist rawToken/tokenHash", this
means Phase 10 **cannot** write a CheckIn row for any `verifyBadgeToken`
failure path — the caller has neither the identifier to attribute
nor a safe stand-in for `ticketCode`.

**Two follow-on options exist; both are DEFERRED (out of Phase 10 scope
unless the owner reopens the decision):**

- **Option D1 (Phase 2 service API change).** Extend `VerifyResult` to
  optionally include `participantId?` on `REVOKED`, `EXPIRED`, and
  `PARTICIPANT_CANCELLED` reasons (where the service already has them
  in scope internally). Would allow Phase 10 to write CheckIns for
  cases 2/3. Non-schema, but touches Phase 2 tests. Non-blocking.
- **Option D2 (schema change).** Make `ticketCode` nullable, or make
  `gate` nullable. Would allow "anonymous" CheckIns for case 4 (INVALID
  QR). Requires migration + potentially reworking downstream reports
  that assume `ticketCode` presence. Non-blocking.

**Neither option is required for Phase 10 to ship.** AuditLog is
sufficient for forensic coverage of unmatched scans, and MAIN_ENTRANCE
authorization decisions still resolve correctly (deny + operator-visible
reason). Recording that the QR failed to verify does not require a
CheckIn row — the AuditLog row carries `action`, `entity=null`,
`entityId=null`, and `meta = { accessPointId, accessPointSlug,
accessPointType, result: "UNKNOWN", reason: "BADGE_INVALID" |
"BADGE_REVOKED" | "BADGE_EXPIRED" }` — enough to reconstruct scanner
history.

Consequence for Phase 10 dashboards: **the manual `/admin/check-in`
"Derniers scans" panel will not show `BADGE_INVALID/REVOKED/EXPIRED`
QR attempts.** Those live in AuditLog only. Master-doc §12 (Phase 9
UI section) already implies this is acceptable ("Never leak whether a
*credential* exists").

### B4 policy summary (locked)

- **CheckIn is written iff Phase 10 has a resolved `participantId`.**
  In practice: whenever `verifyBadgeToken` returned `{ok: true}`,
  regardless of the subsequent Phase-10 decision (VALID,
  ALREADY_CHECKED_IN, CANCELLED via participant.status, UNPAID,
  ParticipantAccess.granted=false denial → the row IS written because
  the participant IS known).
- **CheckIn is NOT written when `verifyBadgeToken` returned
  `{ok: false, reason}`.** AuditLog carries the entire forensic
  record for those.
- **CheckIn.ticketCode = `participant.ticketCode ?? ""`.** Never the
  rawToken or its hash.
- **CheckIn.gate = the AccessPoint's slug** (e.g., `"main"`). Legacy
  string field; kept populated for backwards compat with existing
  dashboards.

### B5 — Audit contract (verified)

For every Phase 10 scan attempt (allow AND deny, CheckIn written or
not):

- **Operator (`userId`)** — always from `requirePermission(...)`.
  Never from client-supplied data.
- **AccessPoint** — resolved server-side from the URL slug (Phase 9
  chain); Phase 10 re-checks `active === true` at validation time.
- **Result** — one `CheckInResult` value.
- **Reason** — `BADGE_INVALID` / `BADGE_REVOKED` / `BADGE_EXPIRED` /
  `UNPAID` / `PARTICIPANT_CANCELLED` / `PA_REVOKED` (for
  B1-DENY-via-ParticipantAccess.granted=false) / `FIRST_SCAN` /
  `REPEAT_SCAN`. Fixed short codes, ASCII, no user input.
- **Participant identity** — only when actually resolved. AuditLog
  meta MUST NOT include a `participantId` field that is `null` — omit
  the key.
- **rawToken / tokenHash** — never in meta, reason, ticketCode, or
  anywhere else. Grep-locked by a Phase 10 test (analogous to
  `scripts/badge-credential.test.ts` "raw token does not appear").
- **Action name** — `"checkin.scan.qr"` (distinct from the legacy
  `"checkin.scan"` written by the manual flow). Preserves forensic
  separability.

Duplicate audits: at most one AuditLog row per scan. Idempotent-repeat
scans (`ALREADY_CHECKED_IN`) still write one CheckIn + one AuditLog —
the current manual flow already does this and it is by design.

### B6 — Legacy manual-flow constraint (locked)

The ONLY change permitted to `app/admin/(protected)/check-in/actions.ts`
during Phase 10 is:

- Replace the two-step `findFirst + participant.update` at
  `actions.ts:141-166` with the atomic
  `participant.updateMany({ where: { id, checkedInAt: null }, data:
  { checkedInAt: ..., checkedInGate: ... } })` pattern and derive
  VALID vs. ALREADY_CHECKED_IN from the returned `count`.

Nothing else in the manual flow changes. In particular:

- Manual-flow permission remains `checkin.validate` (NOT
  `access.validate.main`).
- Manual-flow `CheckIn.reason` strings remain unchanged
  ("Ticket introuvable", etc.).
- Manual-flow does NOT read `ParticipantAccess` — B1 applies to the
  QR path only. (This is a compatible reading of B1: the manual flow
  has no AccessPoint context, so there is no MAIN_ENTRANCE
  `ParticipantAccess` row to consult.)
- Manual-flow `CheckIn.gate` stays the operator-selected gate string;
  the new atomic pattern sets `checkedInGate` from the same source.
- Manual-flow AuditLog action stays `"checkin.scan"`.

A minimal regression test will lock the behaviour: the
`test:access-history` fixture already exercises the manual flow's
CheckIn shape; extending it to assert the atomic-claim contract is a
Phase 10 task.

### Files intentionally NOT touched in this gate

- `prisma/schema.prisma` — no schema change. B2 = A means no enum
  values added; B4 discovery is documented, not remediated.
- `lib/badge/service.ts` — Phase 2 API unchanged (option D1 deferred).
- `app/admin/(protected)/check-in/**` — reserved for Phase 10 impl.
- `lib/admin/rbac.ts` — no new permission strings.
- No test file, no smoke file changed. Gate is documentation-only.

### Gate result — Phase 10 is READY TO IMPLEMENT

- **Phase 9:** PASS (unchanged).
- **B1:** CONFIRMED — Rule C (payment AND `!== false` ParticipantAccess).
- **B2:** CONFIRMED — Reuse UNKNOWN + reason strings.
  `BADGE_INVALID` / `BADGE_REVOKED` / `BADGE_EXPIRED`.
- **B3:** CONFIRMED — Atomic claim in both manual and QR flows.
- **B4:** VERIFIED — CheckIn is written only when the participant is
  resolved (i.e., `verifyBadgeToken` returned `ok: true`). Unresolved
  QR failures (INVALID/REVOKED/EXPIRED) are recorded via AuditLog
  only. `ticketCode = participant.ticketCode ?? ""` on the happy
  path; `gate = AccessPoint.slug`. Never the rawToken or its hash.
- **B5:** VERIFIED — Audit contract compatible with existing
  AuditLog schema; action name `"checkin.scan.qr"` distinct from
  manual `"checkin.scan"`.
- **B6:** LOCKED — Only the race-condition hardening (atomic claim)
  touches the manual flow. All other manual semantics preserved
  byte-for-byte.

**Phase 10 is now unambiguous and buildable.** Awaiting explicit
`GO — Phase 10` before coding.

---

## 13. Phase 10 — Main Entrance Validation  ·  COMPLETE

Implementation date: 2026-09-18.

### What was implemented

Server-side QR validation for MAIN_ENTRANCE access points at
`/admin/scan/[access-point-slug]`. The Phase 9 scanner client now
posts the decoded QR credential to a Phase 10 server action; the
server does 100% of the authorization work and returns a structured
result the client renders as a professional operator UI. The legacy
manual `validateTicket` flow keeps its permission, audit action, and
gate semantics — only the race-prone `checkedInAt` block was replaced
with the atomic claim pattern (owner-approved B3 = B).

### Authorization + validation flow

```
scanner client (browser)
     ↓ opaque rawToken + slug
POST server action
     ↓
requirePermission("access.validate.main")     ← STRICT — no legacy fallback
     ↓ user (from session)
Zod-parse(slug, rawToken)                     ← malformed → generic outcome
     ↓
validateMainEntranceQrCore({ user, slug, rawToken })
     ↓
AccessPoint = prisma.findUnique({slug})       ← fresh DB round-trip
     ↓
active === true?                              ← ACCESS_POINT_INACTIVE
type === MAIN_ENTRANCE?                       ← ACCESS_POINT_WRONG_TYPE
     ↓
verifyBadgeToken(rawToken)                    ← Phase 2 service
     ↓
if !ok: AuditLog only, return
        BADGE_INVALID/REVOKED/EXPIRED
        (or CANCELLED for PARTICIPANT_CANCELLED)
     ↓
Participant = findUnique({id: verify.participantId})
     ↓  select whitelist (no passwordHash, no ticketCode ambiguity)
if !participant: AuditLog only, BADGE_INVALID
     ↓
status === CANCELLED?  → CheckIn(CANCELLED) + AuditLog
paymentStatus !== PAID? → CheckIn(UNPAID) + AuditLog
PA.granted === false?   → CheckIn(UNKNOWN, reason=PA_REVOKED) + AuditLog
     ↓
updateMany({ where: {id, checkedInAt: null}, data: {checkedInAt: now, gate}}) ← ATOMIC
     ↓
count === 1 → CheckIn(VALID, reason=FIRST_SCAN) + AuditLog, return VALID
count === 0 → refetch → CheckIn(ALREADY_CHECKED_IN, reason=REPEAT_SCAN)
              + AuditLog, return ALREADY_CHECKED_IN
```

### Owner decisions — implemented verbatim

- **B1 = C.** `paymentStatus === PAID AND status !== CANCELLED AND
  ParticipantAccess.granted !== false`. `granted=true` cannot waive
  payment; `granted=false` denies even paid attendees. Truth table
  test-locked (`scripts/main-entrance.test.ts` — 3 happy + 3 denial
  cases cover every truth-table row).
- **B2 = A.** Badge failures use `CheckInResult.UNKNOWN` with reason
  strings `BADGE_INVALID` / `BADGE_REVOKED` / `BADGE_EXPIRED`
  (`PA_REVOKED` for B1 denial; `FIRST_SCAN` / `REPEAT_SCAN` for
  atomic-claim outcomes). No enum values added, no schema migration.
- **B3 = B.** Atomic
  `prisma.participant.updateMany({ where: { id, checkedInAt: null }, data: { checkedInAt: now, checkedInGate: gate } })`
  used by BOTH the QR path AND the legacy manual `validateTicket`.
  `count === 1` → VALID (winner); `count === 0` → refetch winner
  timestamp, return ALREADY_CHECKED_IN.

### B4 — CheckIn / AuditLog contract (as verified in the gate)

**CheckIn is written iff a `participantId` is resolved server-side**
(i.e., `verifyBadgeToken` returned `{ok: true}` AND the Participant
row exists AND the AccessPoint gates passed enough to reach a
per-participant decision):

- `VALID`, `ALREADY_CHECKED_IN`, `UNPAID`, `CANCELLED` (participant-status
  route), `UNKNOWN` (with `reason: PA_REVOKED`) → CheckIn row written.
- `BADGE_INVALID`, `BADGE_REVOKED`, `BADGE_EXPIRED`, `CANCELLED`
  (verify-path, no participantId), `ACCESS_POINT_UNKNOWN`,
  `ACCESS_POINT_INACTIVE`, `ACCESS_POINT_WRONG_TYPE` → **AuditLog only**.

CheckIn field discipline:

| Field           | Value                                                |
|-----------------|------------------------------------------------------|
| `participantId` | from `verify.participantId` (server-derived)         |
| `credentialId`  | from `verify.credentialId` (server-derived)          |
| `accessPointId` | freshly resolved from URL slug                       |
| `operatorId`    | from `requirePermission(...)`                        |
| `ticketCode`    | `participant.ticketCode ?? ""` (never the rawToken)  |
| `gate`          | `AccessPoint.slug` (never a legacy gate string)      |
| `result`        | one `CheckInResult` value                            |
| `reason`        | fixed short code — `FIRST_SCAN`/`REPEAT_SCAN`/`UNPAID`/`PARTICIPANT_CANCELLED`/`PA_REVOKED` |

AuditLog for every QR scan attempt (exactly one row):

| Field       | Value                                                 |
|-------------|-------------------------------------------------------|
| `userId`    | operator.id (session-derived)                         |
| `action`    | `"checkin.scan.qr"` (distinct from legacy `"checkin.scan"`) |
| `entity`    | `"Participant"` when participantId is known, otherwise `"AccessPoint"` |
| `entityId`  | participantId if known, else accessPointId, else null |
| `meta`      | `{ accessPointId, accessPointSlug, accessPointType, result, reason }` |

**Never in any row:** `rawToken`, `tokenHash`. Test-locked
(`scripts/main-entrance.test.ts` — three data-safety tests grep every
DB row after several outcomes).

### Result contract (client-visible)

The server action returns `MainEntranceValidationResult` (defined in
`app/admin/(protected)/scan/[access-point-slug]/action-types.ts`):

```ts
{
  ok: boolean;
  outcome:
    | "VALID"
    | "ALREADY_CHECKED_IN"
    | "UNPAID"
    | "CANCELLED"
    | "PA_REVOKED"
    | "BADGE_INVALID"
    | "BADGE_REVOKED"
    | "BADGE_EXPIRED"
    | "ACCESS_POINT_INACTIVE"
    | "ACCESS_POINT_WRONG_TYPE"
    | "ACCESS_POINT_UNKNOWN";
  message: string;                              // fixed French text
  participant?: { firstName, lastName, tier };  // only when resolved
  at?: string;                                  // ISO, for VALID / ALREADY
}
```

No ids, no ticketCode, no payment metadata, no session state, no
credential material ever crosses to the client.

### Files added

| File | Purpose |
|------|---------|
| `lib/admin/main-entrance-validator.ts` | Pure validator core. `import "server-only"`. Testable with a direct AdminUser argument (mirrors the Phase 7 pattern). Contains every authorization decision, the atomic claim, and both write paths (CheckIn + AuditLog). |
| `app/admin/(protected)/scan/[access-point-slug]/actions.ts` | `"use server"` wrapper. `requirePermission("access.validate.main")` → Zod parse → validator core. |
| `app/admin/(protected)/scan/[access-point-slug]/action-types.ts` | Plain TS types (no runtime side-effect) shared between server action and client. |
| `scripts/main-entrance.test.ts` | 24 tests: happy paths, denials, badge failures, AP gates, 5-way concurrent race, data safety, legacy-flow untouched, code discipline. |

### Files modified

- `app/admin/(protected)/scan/[access-point-slug]/scanner-client.tsx`
  — added `submitting` / `result` states, `useTransition` around
  `validateMainEntranceQrScan(...)`. Preserves the raw-credential
  discipline: `decoded` is bound as a callback argument, passed as
  the action's `rawToken`, then dropped. Never stored in state or
  DOM.
- `app/admin/(protected)/scan/[access-point-slug]/page.tsx` — now
  passes `accessPointSlug={point.slug}` to `<ScannerClient>` so the
  client can echo it back to the server action (the server
  independently re-resolves the AccessPoint from that slug).
- `app/admin/(protected)/check-in/actions.ts` — replaced the
  read-then-update `checkedInAt` block with the atomic
  `updateMany({ where: { id, checkedInAt: null } })` pattern.
  Permission (`checkin.validate`), audit action (`"checkin.scan"`),
  gate matching, UNPAID/CANCELLED/WRONG_GATE ordering, revalidatePath
  targets: all preserved byte-for-byte.
- `package.json` — added `test:main-entrance` script.

### Design decisions in-phase

- **Validator core is a pure function accepting the operator as
  input.** The server-action wrapper resolves the session and passes
  the `AdminUser` down. This makes the entire authorization decision
  directly testable without a Next.js request boundary — matches the
  Phase 7 access-actions pattern and gave us the 5-way concurrent
  claim test.
- **Zod on both slug and rawToken at the action boundary.**
  Malformed slug → generic `ACCESS_POINT_UNKNOWN` (never a
  parse-error leak). RawToken length-capped at 1024 bytes to prevent
  a hostile client pushing megabyte payloads through the action.
  The badge service's `MIN_TOKEN_LENGTH = 40` provides the lower
  bound.
- **Same slug schema as the scanner route** (anchored, lowercase,
  ASCII-only, 2..48 chars). No new attack surface introduced.
- **`decoded` never stored in React state.** The state machine
  transitions directly from `submitting` → `result` where `result`
  is the safe server-returned struct. The raw credential leaves
  scope after the action returns.
- **`submittingRef` re-entrancy guard.** In addition to the library's
  `.pause(true)`, a ref prevents a race where a second decode is
  accepted between the pause and the state transition.
- **Per-outcome UI tone map** (green / amber / red). Operators
  learn the visual language quickly: green = VALID, amber =
  ALREADY_CHECKED_IN, red = anything else.
- **Verify-path CANCELLED goes to AuditLog only** — verifyBadgeToken
  returns `PARTICIPANT_CANCELLED` without exposing `participantId`
  under the current Phase 2 API. The status-gate path (participant
  is CANCELLED but their credential is still ACTIVE) writes a
  CheckIn row. Both paths surface `outcome: "CANCELLED"` to the
  operator. This is the only outcome that has two internal
  representations by design — recorded in the B4 gate.
- **No `revalidatePath` on the QR path.** The manual flow calls
  `revalidatePath("/admin/dashboard")` because that page renders
  the "Derniers scans" panel and operators expect it to refresh.
  The QR path has no equivalent page-in-scope: the scanner shows
  its own result inline. Skipping `revalidatePath` on the hot
  scan path avoids gratuitous cache invalidation.

### Security properties (per Phase 10 review)

- **All authority is server-side.** The client is not trusted for
  `participantId`, `accessPointId`, `credentialId`, `paymentStatus`,
  `status`, or any authorization claim. Every authoritative field
  is re-derived server-side from the URL slug, the DB, and the
  session.
- **Actor from session only.** `user` comes from
  `requirePermission("access.validate.main")` in the wrapper; the
  validator core's `user` argument is passed by the wrapper (or by
  the test harness with a real DB-backed AdminUser). No form field
  or header path.
- **Strict permission.** `access.validate.main` — no legacy
  `checkin.validate` fallback. Grep-locked by both `scanner.test.ts`
  and `main-entrance.test.ts`.
- **AccessPoint revalidated at scan time.** Fresh DB `findUnique`
  in the validator; refuses inactive, refuses wrong type. Whitelist
  select (id/slug/name/type/active).
- **rawToken never persisted, logged, or in the response.** Passed
  only to `verifyBadgeToken`. `tokenHash` never surfaces to the
  caller. Data-safety tests grep every row after both success and
  failure paths.
- **Payment cannot be bypassed via ParticipantAccess.** B1 rule C
  enforced: UNPAID short-circuits BEFORE the PA check.
- **Cross-type routing refused.** ROOM AccessPoint reaching the
  main validator returns `ACCESS_POINT_WRONG_TYPE` with no
  participant work.
- **Atomic first-scan claim.** `updateMany({ where: {id, checkedInAt: null} })`
  in one round-trip. 5-way concurrent test proves exactly one
  VALID + four ALREADY_CHECKED_IN.
- **One AuditLog per scan attempt, one CheckIn iff participant
  resolved.** Verified by row-counting tests.
- **No client-side authorization assumptions.** Scanner-client
  renders only server-returned strings. No local grant/deny
  logic anywhere.
- **Neutral error messages.** No Prisma error text, no stack traces,
  no internal IDs, no filesystem paths surfaced to the operator.

### Tests

`scripts/main-entrance.test.ts` — **24 tests, 8 suites:**

- Happy paths (3): valid PAID + no PA / valid PAID + PA=true /
  repeat scan → ALREADY_CHECKED_IN with unchanged timestamp.
- Denials with participant resolved (3): PA_REVOKED / UNPAID /
  CANCELLED (verify-path).
- Badge failures never write CheckIn (3): REVOKED / EXPIRED /
  INVALID-random.
- AccessPoint gates (3): inactive / wrong-type / unknown-slug.
- Atomic claim (1): 5 concurrent scans → 1 VALID + 4 ALREADY.
- Data safety (3): rawToken not in DB after VALID / not in DB
  after badge failure / ParticipantAccess untouched.
- Legacy manual flow unchanged (4): permission still
  `checkin.validate` / audit still `"checkin.scan"` / no
  ParticipantAccess consult / atomic pattern in place.
- Code discipline (4): strict permission on action / correct
  audit action string / atomic pattern in validator / rawToken
  never assigned as an object-literal value.

### Verification

- `npm run typecheck` → clean.
- `npm run test:main-entrance` → **24 / 24** (new).
- `npm run test:scanner` → **26 / 26** (no regression, boundary
  tests still pass because scanner-client.tsx does not directly
  reference `verifyBadgeToken` / `checkIn.*` / `participantAccess`
  — those live in the validator core).
- `npm run test:access-admin` → **21 / 21** (no regression).
- `npm run test:access-points` → **12 / 12** (no regression).
- `npm run test:badge` → **28 / 28** (no regression).
- `npm run test:rbac` → **31 / 31** (no regression).
- `npm run test:access` → **5 / 5** (no regression).
- `npm run test:qr` → **4 / 4** (no regression).
- `npm run test:history` → **8 / 8** (no regression).
- Dev-server smoke on port 3001: `/admin/scan/main` returns 200
  with the scanner shell; `/admin/scan/room-01` returns 200 with
  the Salle 01 header. Phase 9 admin-smoke checks (307 for VIEWER,
  404 for unknown slug + path-traversal) still hold.

**Total: 159 tests passing** (+24 for Phase 10), zero regressions.

### Security review

**OK. No BLOCK, no WARN.** Reviewer explicitly confirmed:

- Server-action wrapper opens with the strict permission gate;
  validator core independently re-resolves every authoritative fact.
- No `"checkin.validate"` reference anywhere in the Phase 10 tree.
  `canValidateMainEntrance` OR-fallback helper never imported.
- AccessPoint re-resolved at scan time; whitelist select; refuses
  inactive and wrong-type before any participant work.
- IDOR closed: no client identity claim path. `participantId` /
  `credentialId` derive from `verifyBadgeToken.ok = true` only.
- rawToken passed only to verifyBadgeToken; never assigned to a
  variable/field. Structural test locks this in.
- Atomic claim + concurrent test proves race safety.
- One AuditLog per scan attempt; one CheckIn iff participant
  resolved; both writes wrapped in a single helper for auditability.
- Scanner-client renders only server-derived strings — no local
  authorization state.
- B1 rule C ordering enforced: UNPAID short-circuits before PA.
- ROOM → `ACCESS_POINT_WRONG_TYPE` with no mutation.
- Unknown QR → AuditLog only; correct given `ticketCode` NOT NULL.
- Zod hygiene at the boundary; parse errors do not leak.
- Only fixed French messages surfaced; no Prisma / stack / ID leaks.
- Legacy manual flow: permission, audit action, gate semantics all
  preserved. Only the atomic claim block changed.

### Files intentionally NOT touched

- `prisma/schema.prisma` — no schema change. (B2 = A honored; B4
  discovery documented but no auto-fix.)
- `lib/badge/**` — Phase 2 API unchanged. `verifyBadgeToken`'s
  return shape not extended (deferred as option D1).
- `lib/admin/rbac.ts` — no new permission strings; helpers
  unchanged.
- `middleware.ts`, `lib/db.ts`, `lib/admin/auth.ts`,
  `lib/account/auth.ts` — unchanged.
- All `/compte/**` attendee routes — unchanged.
- `app/admin/(protected)/registrants/**` — Phase 7 code
  unchanged.
- `app/admin/(protected)/access-points/**` — Phase 8 code
  unchanged.

### Deferred (Phase 11 boundary)

- **ROOM validation.** Currently, a ROOM AccessPoint reaching the
  main validator returns `ACCESS_POINT_WRONG_TYPE`. Phase 11 will
  add `validateRoomQrAtAccessPoint(...)` with its own ROOM rule:
  `PAID_ELIGIBLE AND ParticipantAccess.granted === true` (strict;
  no default-allow for rooms). The scanner-client is already
  type-aware — Phase 11 will wire a second server action for
  `accessPointType === "ROOM"`.
- **Optional `verifyBadgeToken.participantId` on failure paths
  (D1).** Would let Phase 10 write CheckIn rows for REVOKED /
  EXPIRED / PARTICIPANT_CANCELLED. Not required; AuditLog is
  sufficient.
- **Nullable `CheckIn.ticketCode` (D2).** Not needed; the
  AuditLog-only path handles unmatched-QR cases cleanly.
- **`checkin.scan.qr` in the "Derniers scans" panel.** Currently
  the manual `/admin/check-in` panel groups by `gate` string
  filtered on `result: "VALID"`. Phase 10 CheckIns use
  `gate = AccessPoint.slug` (e.g., `"main"`) and appear in that
  panel under that slug. Whether to explicitly split QR vs.
  manual in dashboards is a Phase 13 UX call.
- **Reserved codes for `WRONG_TIME` and other unused
  `CheckInResult` values** — Phase 10 does not produce
  `WRONG_TIME` (no session-window check on the main entrance);
  the enum value remains for future use.

Awaiting explicit `GO — Phase 11` before starting Phase 11 (Room
validation).

---

## 13.b Phase 10 — original spec  ·  ARCHIVED

### Goal

Extend the existing `validateTicket(code, gate)` architecture with a QR
credential path. **Do not break the manual code flow.**

### Design

- Add `validateQrAtAccessPoint(rawToken, accessPointId)` in
  `app/admin/check-in/actions.ts` (or a new sibling file that shares
  helpers).
- Delegate token verification to `verifyBadgeToken(rawToken)`. On `ok:
  false`, map the reason to an existing `CheckInResult` (or add a new
  enum value if truly needed — flag if so).
- For MAIN_ENTRANCE:
  - Require `paymentStatus === PAID`, `status !== CANCELLED`.
  - First-scan idempotency: preserve the existing pattern
    `UPDATE Participant SET checkedInAt = NOW() WHERE checkedInAt IS NULL
    RETURNING id` — the row count settles the winner without a lock.
  - On repeated scan → `ALREADY_CHECKED_IN` result with the previous
    timestamp. Do not create a duplicate attendance record.
- Write a `CheckIn` row with `accessPointId` and `credentialId` populated
  (existing `gate` string field also populated for backwards compat if the
  operator's session still carries a legacy gate concept).
- Every scan (allowed or denied) audits through the existing `audit()`.

### Race safety

Preserve the existing conditional-update pattern. Do not add explicit locks
if not required.

### Exit criteria

- Manual `/admin/check-in` code flow untouched and still passes any
  existing test.
- Security review for `app/admin/check-in/**` and any lib helpers.
- Report — STOP for `GO`.

---

## 14. Phase 11 — Room Validation  ·  COMPLETE

Implementation date: 2026-09-18.

### What was implemented

Server-side QR validation for ROOM access points. Symmetric to
Phase 10 (MAIN_ENTRANCE) with three deliberate divergences dictated
by spec §14 and owner decision C1 = A:

1. **Strict per-room ParticipantAccess rule.** ROOMs are default-deny
   — a paid+confirmed participant WITHOUT an explicit
   `ParticipantAccess.granted = true` row for that room cannot enter.
2. **No `Participant.checkedInAt` mutation.** Rooms are independent
   per-room accesses; venue entry does not grant room access, and
   room entry does not update the main-entrance timestamp.
3. **No atomic first-scan claim; every scan is fresh.** Rooms allow
   repeat entry (attendees leave and return during a session).
   Two consecutive authorized scans write two `CheckIn(VALID)` rows;
   there is no `ALREADY_CHECKED_IN` outcome for rooms.

### Owner decisions — recorded

- **C1 = A** (master-doc default). Every authorized room scan writes
  a fresh `CheckIn(VALID, reason=ROOM_ENTRY)`. No per-day
  idempotency; no atomic claim. Concurrent scans succeed
  concurrently — this is intended behaviour.
- The Phase-10 owner locks (B1 = C, B2 = A, B3 = B) carry forward
  where relevant. `checkin.validate` remains legacy-only and MUST
  NOT authorize the room path (strict `access.validate.room`).

### ROOM eligibility rule (spec §14)

```
IF verifyBadgeToken(rawToken) is not ok → AuditLog only, no CheckIn
IF AccessPoint.type !== ROOM            → refusal (ACCESS_POINT_WRONG_TYPE)
IF AccessPoint.active !== true          → refusal (ACCESS_POINT_INACTIVE)
IF participant.status === CANCELLED     → CheckIn(CANCELLED)
IF participant.paymentStatus !== PAID   → CheckIn(UNPAID)
IF no ParticipantAccess row for room    → CheckIn(UNKNOWN, PA_NOT_GRANTED)  ← default-deny
IF PA.granted === false                 → CheckIn(UNKNOWN, PA_REVOKED)      ← explicit deny
ELSE (PA.granted === true)              → CheckIn(VALID, ROOM_ENTRY)
```

The check order matches Phase 10 semantics up to the PA test:
CANCELLED → UNPAID → PA. `granted = true` MUST NOT waive payment
(owner rule, same principle as B1 = C for main). Payment is
authoritative.

### Files added

| File | Purpose |
|------|---------|
| `lib/admin/room-validator.ts` | Pure ROOM validator core. `import "server-only"`. Same defense-in-depth chain as `main-entrance-validator.ts`, minus the atomic claim and Participant mutation. |
| `scripts/room.test.ts` | 22 tests: happy path, denials, badge failures, AP gates, cross-room isolation, data safety, code discipline. |

### Files modified

- `app/admin/(protected)/scan/[access-point-slug]/actions.ts` —
  added `validateRoomQrScan` server action.
  `requirePermission("access.validate.room")` → same Zod
  slug/rawToken parse → `validateRoomQrCore`.
- `app/admin/(protected)/scan/[access-point-slug]/action-types.ts` —
  renamed `MainEntranceOutcome` → `ScannerOutcome` and
  `MainEntranceValidationResult` → `ScannerValidationResult`.
  Backwards-compat type aliases retained so Phase 10 imports keep
  working. Added `PA_NOT_GRANTED` to the outcome union.
- `app/admin/(protected)/scan/[access-point-slug]/scanner-client.tsx`
  — client-side dispatch based on the `accessPointType` prop
  (`MAIN_ENTRANCE → validateMainEntranceQrScan`,
  `ROOM → validateRoomQrScan`). Same raw-credential discipline
  preserved. `PA_NOT_GRANTED` added to `OUTCOME_TONE` and
  `OUTCOME_TITLE` maps (renders as "Accès refusé", red tone).
- `lib/admin/main-entrance-validator.ts` — type import updated to
  the renamed `MainEntranceValidationResult` alias (no semantic
  change).
- `package.json` — added `test:room` script.

### Design decisions

- **Two separate server actions, client-side dispatch.** Rejected
  the "one unified action that switches on resolved type" approach
  because it would collapse two distinct RBAC surfaces
  (`access.validate.main` vs `access.validate.room`) into a single
  call site — losing the "one permission per action" invariant.
  With two actions, each is trivially auditable: "if you have this
  permission, you can call this action." The client picks which
  one based on the SERVER-provided `accessPointType` prop; the
  server-rendered scanner page enforces the strict type-derived
  permission gate before the client ever mounts, so the prop is
  trustworthy for client-side routing. Both validator cores
  independently re-resolve the AccessPoint by slug and re-check its
  type — defense-in-depth.
- **`PA_NOT_GRANTED` vs `PA_REVOKED` — distinct reason codes, same
  UI outcome.** Both deny; both display "Accès refusé"; both write
  `CheckIn(UNKNOWN, reason=<code>)`. The forensic split matters for
  audits: `PA_REVOKED` means an admin actively revoked the row via
  the Phase 7 matrix, whereas `PA_NOT_GRANTED` means the room was
  never granted in the first place (default-deny). A future
  compliance query "how many attendees were denied because of an
  admin revocation vs. because they never had access?" answers
  itself from the reason field.
- **No atomic claim in the room validator — deliberate.** Rooms
  allow repeat entry. A `updateMany({where:{id, checkedInAt:null}})`
  pattern would be a category error here: `checkedInAt` is
  main-entrance-only (spec §14 explicit), and there is no
  per-room "already-in" bit to atomically claim.
- **`checkedInAt` is not required for room access.** A participant
  could scan into a room without having entered the main entrance
  first. The master doc says "venue entry does not grant room
  access" (independence); it does not require the reverse. If a
  future policy requires venue entry as a precondition, add it
  after the payment gate — but that is a business decision, not
  implemented today.
- **French UI copy tweaks for rooms.** "Accès non autorisé pour
  cette salle." (PA_NOT_GRANTED) vs. "Accès refusé." (PA_REVOKED).
  Room-specific inactive/unknown messages ("Salle désactivée.",
  "Salle introuvable.") clarify context for the operator.

### Security properties (per Phase 11 review)

- **Strict permission.** `access.validate.room` at the wrapper.
  Legacy `checkin.validate` cannot authorize. `access.validate.main`
  cannot authorize the room action either — separation is enforced
  by the wrapper's `requirePermission` string.
- **AccessPoint revalidated at scan time.** Fresh DB `findUnique`;
  refuses inactive; refuses non-ROOM type. Whitelist select.
- **Payment cannot be bypassed by ParticipantAccess.** CANCELLED →
  UNPAID → PA check order. `granted=true` never short-circuits the
  payment gate.
- **Default-deny for rooms.** No PA row → refusal + CheckIn(UNKNOWN,
  PA_NOT_GRANTED). No auto-authorization from paid+eligible alone.
- **Cross-room isolation.** PA on room-01 does not authorize a
  room-02 scan. Test-locked.
- **`Participant.checkedInAt` never touched.** Structural test
  (grep of `participant.update`/`updateMany` in validator) + DB
  assertion after every authorized scan.
- **No atomic-claim shape in the room validator.** Structural test
  bans `checkedInAt: null` in the validator source.
- **Badge failures AuditLog only.** Same B4 policy as Phase 10.
- **rawToken never in DB / audit / response.** Grep after every
  outcome path. `ticketCode = participant.ticketCode ?? ""`;
  `gate = AccessPoint.slug`. Never the raw credential.
- **Same `checkin.scan.qr` audit action.** Meta.accessPointType
  distinguishes ROOM vs MAIN in forensics.
- **Client-side authorization impossible.** The dispatch prop
  originates from a server-rendered page that already enforced
  strict RBAC. Each server action independently re-checks
  permission; each validator core independently re-resolves the
  AccessPoint and re-verifies its type.

### Tests

`scripts/room.test.ts` — **22 tests, 7 suites:**

- Happy path (2): PA granted=true → VALID; two consecutive scans
  → TWO fresh VALID rows (C1 = A).
- Denials (4): PA granted=false → PA_REVOKED / no PA → PA_NOT_GRANTED /
  UNPAID + PA granted=true → UNPAID (payment gate wins) /
  CANCELLED (verify-path) → AuditLog only.
- Badge failures (3): REVOKED / EXPIRED / random-invalid → AuditLog
  only, no CheckIn.
- AccessPoint gates (3): inactive room / MAIN sent to room
  validator / unknown slug — all refused with no CheckIn.
- Cross-room isolation (1): PA on room-01, scan on both — room-01
  VALID, room-02 PA_NOT_GRANTED.
- Data safety (3): checkedInAt not mutated / rawToken not in any
  row / ParticipantAccess not mutated.
- Code discipline (6): no Participant.update in validator / no
  atomic claim / strict permission on action / audit action string
  / no rawToken assignment / ticketCode shape.

### Verification

- `npm run typecheck` → clean.
- `npm run test:room` → **22 / 22** (new).
- `npm run test:main-entrance` → **24 / 24** (no regression).
- `npm run test:scanner` → **26 / 26** (no regression, structural
  tests unaffected).
- `npm run test:access-admin` → **21 / 21** (no regression).
- `npm run test:access-points` → **12 / 12** (no regression).
- `npm run test:badge` → **28 / 28** (no regression).
- `npm run test:rbac` → **31 / 31** (no regression).
- `npm run test:access` → **5 / 5** (no regression).
- `npm run test:qr` → **4 / 4** (no regression).
- `npm run test:history` → **8 / 8** (no regression).
- Dev-server smoke: `CHECKIN_OPERATOR /admin/scan/room-01` → 200
  with "Scanner — Salle 01"; `VIEWER /admin/scan/room-01` → 307
  `?denied=access.validate.room`; `/admin/scan/main` regression → 200.

**Total: 181 tests passing** (+22 for Phase 11), zero regressions.

### Security review

**OK. No BLOCK, no WARN.** Reviewer explicitly confirmed:

- Strict `access.validate.room` at the wrapper; no `checkin.validate`
  fallback; `access.validate.main` cannot cross over.
- Fresh AccessPoint resolution + inactive + wrong-type refusals at
  the validator core; whitelist select.
- Check order enforces payment authority: CANCELLED → UNPAID → PA
  (`granted=true` cannot waive UNPAID).
- Default-deny is enforced structurally; `PA_NOT_GRANTED` vs
  `PA_REVOKED` split preserved in audit trail.
- Cross-room isolation via `where: { accessPointId: point.id }` on
  the PA join.
- No `Participant.checkedInAt` mutation and no atomic claim in the
  room validator; structural test + DB assertion.
- Badge-failure paths write AuditLog only.
- rawToken discipline identical to Phase 10 — never persisted,
  never in response, never in audit.
- Client boundary clean; scanner-client only imports server actions
  as auto-boundary calls plus plain type modules.
- Zod hygiene at the action boundary; malformed input surfaces
  generic outcomes.
- No `dangerouslySetInnerHTML`, no `$queryRawUnsafe`, no `eval`,
  no session/cookie regressions.

### Files intentionally NOT touched

- `prisma/schema.prisma` — no schema change.
- `lib/badge/**` — Phase 2 service unchanged.
- `lib/admin/rbac.ts` — no new permission strings.
- `middleware.ts`, `lib/db.ts`, `lib/admin/auth.ts`,
  `lib/account/auth.ts` — unchanged.
- `app/admin/(protected)/check-in/**` — legacy manual flow
  untouched.
- `app/admin/(protected)/registrants/**` — Phase 7 code unchanged.
- `app/admin/(protected)/access-points/**` — Phase 8 code
  unchanged.
- `lib/admin/main-entrance-validator.ts` — Phase 10 logic
  unchanged (only the type import name updated).
- All `/compte/**` attendee routes — unchanged.

### Deferred (Phase 12+ boundary)

- **Venue-entry precondition for rooms.** The current room
  validator does not require `Participant.checkedInAt` to be set.
  If a future policy requires that (e.g., "no room access before
  main-entrance check-in"), add a gate between the payment check
  and the PA check. Not implemented today because spec §14 does
  not require it.
- **Per-day/per-session idempotency (C1 = B path).** If rooms
  need to record a first-entry-of-day event, add a `findFirst` on
  today's CheckIn rows scoped to (participant, room, day-window)
  before the write. Non-blocking; C1 = A shipped.
- **Room capacity limits.** Not part of Phase 11. A future phase
  could add per-room concurrency caps by counting recent
  CheckIn(VALID) rows in a rolling window.
- **UI split of VALID vs ALREADY-VALID for rooms.** The client
  currently renders every authorized room scan the same way
  ("Accès autorisé"). If operators need to see "this participant
  has scanned this room 3 times today", that's a Phase 13 report,
  not a Phase 11 validator concern.
- **Options D1 / D2 from the pre-Phase-10 gate** — still deferred,
  unchanged.

Awaiting explicit `GO — Phase 12` before starting Phase 12 (Mobile
badge experience).

---

## 14.b Phase 11 — original spec  ·  ARCHIVED

### Goal

Server-side validator for rooms. **Independent per room** — venue entry
does not grant room access.

### Design

- Same entry point as Phase 10 (`validateQrAtAccessPoint`) with the
  AccessPoint type resolved server-side.
- For `ROOM`:
  1. `verifyBadgeToken(rawToken)`.
  2. Registration/payment gate (same as main).
  3. Lookup `ParticipantAccess` on `(participantId, accessPointId)`. If
     missing OR `granted = false` → deny.
  4. Write a `CheckIn` row with `accessPointId` set. Do not touch
     `Participant.checkedInAt` (that's main-entrance only).
- Rooms may allow repeat entry within the day — flag if a policy decision
  is needed. Default assumption: no per-room daily uniqueness enforced;
  every scan is a fresh CheckIn row (allowed or denied) with full audit.

### Independent per-room matrix

```
Main Entrance    ALLOWED
Room 01          ALLOWED
Room 02          DENIED
Room 03          ALLOWED
Room 04          DENIED
Room 05          ALLOWED
```

**No frontend hardcoding.** No `if (room === "room-1")`. Permissions come
from `ParticipantAccess`.

### Exit criteria

- Room validation cannot be tricked by client-supplied `participantId` or
  `allowed=true`.
- Concurrent scans of the same participant/room resolve consistently.
- Security review for the validator + any actions.
- Report — STOP for `GO`.

---

## 15. Phase 12 — Mobile Badge Experience  ·  COMPLETE

Implementation date: 2026-09-18.

### What was implemented

Focused mobile polish of `/compte/badge`. This is the primary way
attendees present their credential — the priority is a phone-native
"large QR, fast scan" first fold, with details tucked below. No
schema change, no server-action change, no security surface added.
The Phase 5 rotation-on-view flow, eligibility gate, and raw-token
discipline are all preserved byte-for-byte.

### First-fold priorities (spec §15) — implemented

1. **BIS+ mark** — Cobalt header band on the badge card.
2. **Name** — full name in Alexandria, bold.
3. **Participation type** — eyebrow above the name (`Sponsor`,
   `Visiteur`, etc.).
4. **Large QR** — up to 300px on mobile (was 200px). At arm's length
   under venue lighting this decodes cleanly on a scanner across the
   room.

The physical-neck-badge look is preserved on desktop / print (the
existing 3:4 aspect and 340px max-width kick back in at `sm` and
above). No layout jump, no re-render animation delay.

### Screen Wake Lock

New client hook `components/compte/use-screen-wake-lock.ts`:

- Requests `navigator.wakeLock.request("screen")` whenever the QR is
  displayed.
- Releases the lock on unmount, on QR rotation-away, on tab close.
- Re-acquires on `visibilitychange:visible` because some browsers
  release the lock when the tab is hidden.
- Silent no-op on unsupported browsers (older iOS, obscure UAs);
  never surfaces a toast or an alert.
- Exposes `{ supported, active }` so the UI can render a discreet
  "Écran gardé actif" indicator (green dot) only when the lock is
  actually held.

**Brightness limitation, explicitly documented:** the Web platform
does NOT expose brightness control. The wake lock prevents the
phone from dimming/locking during the scan window, but it cannot
raise brightness. In bright halls, attendees still need to raise
brightness manually via the OS. Copy on the page notes this
indirectly via the "Écran gardé actif" indicator — operators know
the lock is active without extra chrome.

### Files added

| File | Purpose |
|------|---------|
| `components/compte/use-screen-wake-lock.ts` | Client hook. Manages Wake Lock lifecycle + visibility re-acquire. Silent when unsupported. |

### Files modified

- `components/compte/badge-card.tsx` — mobile-first proportions:
  - Card max-width `420px` on mobile → `340px` on `sm+`.
  - Aspect-3:4 lock lifted on mobile → re-locked on `sm+` (print stays
    3:4 because `globals.css` `@media print` also enforces `.print-badge`
    with 90mm width).
  - QR slot max-width `300px` on mobile → `200px` on `sm+`.
  - No content reordering; no new fields.
- `components/compte/badge-qr-client.tsx` — added wake-lock hook + a
  discreet "Écran gardé actif" indicator that appears only when the
  browser supports the API and the QR is on screen. Everything else
  (rotation flow, print button, security note) unchanged.

### Files intentionally NOT touched

- `app/compte/badge/page.tsx` — same eligibility gate, same guard,
  same `BadgeQrClient` rendering. No new server-side behaviour.
- `app/compte/badge/actions.ts` — server action unchanged.
- `lib/badge/**` — Phase 2 service unchanged.
- `lib/badge/qr.ts` — QR-generation unchanged. Same 512px PNG.
- `app/globals.css` — print rules already correct; not touched.
- `prisma/schema.prisma`, `middleware.ts`, `lib/db.ts`,
  `lib/admin/**`, `lib/account/auth.ts` — untouched.
- All `/admin/**` routes — untouched.
- No new dependency.
- No new server action, no new cookie behaviour, no
  `dangerouslySetInnerHTML`, no new form/input handling.

### Design decisions

- **No new component split.** Considered a separate `<MobileBadge>`
  vs `<BadgeCard>` — rejected. Two components would double the
  maintenance surface and diverge over time. Instead, `BadgeCard`
  gained mobile-first classes with `sm:` breakpoints that revert to
  the credential-shaped look at 640px+. Print CSS keeps the
  printed version 3:4 regardless.
- **QR at 300px on mobile, not larger.** 300px in a 375–420px
  viewport is roughly 75% of screen width — clearly the dominant
  element, but with enough surrounding chrome to still read the
  name. Going bigger would push participation type below the fold
  on 4.7-inch phones.
- **Wake-lock indicator, not a toast.** A toast that fires every
  time the lock is acquired would be noisy — attendees regenerate
  QR codes multiple times during the day. A dot next to the "Émis
  à HH:MM" line is discreet and truthful.
- **No brightness API attempt.** There is no cross-browser way to
  raise brightness. Rather than shipping a broken feature (Android
  Chrome has a WebView-only intent for it, iOS Safari has none),
  we document the limitation and trust the operator/attendee to
  raise brightness manually. This is the spec §15's escape hatch:
  "Ask the browser (via CSS media hints where possible)... If not
  possible, document the limitation."
- **No animations added.** Spec §15: "No animations that would
  delay the QR reveal." The existing `transition-all` on the
  Régénérer button is opacity/color only — it does not defer the
  QR image render. The QR `<img>` renders immediately from the
  server-provided data URL.

### Real-device check — user-owned

Claude cannot physically test on a phone from this environment. The
implementation is verified via:

- `npm run typecheck` → clean.
- `npm run test:qr` → 4/4.
- `npm run test:badge` → 28/28 (no regression to the Phase 2 service).
- `scripts/compte-smoke.ts` → 14/14 across populated + empty
  accounts, `/compte/badge` renders on both.

**The following require a real device (spec §15 exit criterion):**

- Verify the wake-lock indicator turns green on mobile Chrome
  (Android) and Safari (iOS 16.4+).
- Verify the QR is scannable at arm's length under venue lighting.
- Verify the badge fills the first fold on 5.4"/6.1"/6.7" phones
  without organization text pushing the QR below the fold.
- Verify screen does not lock during a 60-second scan window.
- Verify the print layout is unchanged (Ctrl+P still produces a
  3:4 badge on A5/A6 paper).

These checks are the user's responsibility — Claude will not claim
them done. If any of them fails, this section will be revisited.

### Security review

**Not invoked.** Per CLAUDE.md, the mandatory triggers are edits
under `app/admin/**`, `app/actions/**`, `app/api/**`, `lib/admin/**`,
`lib/db.ts`, `prisma/schema.prisma`, `middleware.ts`, or new
dependencies. Phase 12 touched none of those, added no server
action, no route handler, no cookie behaviour, no form/user-input
handling, no `dangerouslySetInnerHTML`, no raw SQL, no new package.

The wake-lock hook is purely client-side, does not read cookies,
does not exfiltrate any data, and does not touch the credential
material. It requests a well-scoped browser capability (screen wake
lock) and releases it on unmount. If unsupported, it is a no-op.

### Verification

- `npm run typecheck` → clean.
- `npm run test:qr` → **4 / 4** (no regression).
- `npm run test:badge` → **28 / 28** (no regression).
- `npm run test:main-entrance` → **24 / 24** (no regression;
  Phase 10 badge-service consumers unaffected).
- `npm run test:room` → **22 / 22** (no regression).
- `npm run test:scanner` → **26 / 26** (no regression).
- `npm run test:rbac` → **31 / 31** (no regression).
- `npm run test:access` → **5 / 5** (no regression).
- `npm run test:history` → **8 / 8** (no regression).
- `npm run test:access-admin` → **21 / 21** (no regression).
- `npm run test:access-points` → **12 / 12** (no regression).
- `scripts/compte-smoke.ts` → **14 / 14** across both scenarios.

**Total: 181 tests passing + 14 attendee routes**, zero regressions.

### Deferred

- **Photo upload on the badge.** Still initials-in-Cobalt-disc.
  A real photo pipeline (upload widget, blob storage, moderation)
  is a separate future phase.
- **Auto-full-screen on mobile.** Investigated `document.documentElement.requestFullscreen()`;
  rejected because it requires a user-gesture and would need a
  toggle button on the badge page. Not a spec §15 exit criterion.
  Attendees can pinch-out in most browsers if they want a
  distraction-free view.
- **Home-screen "Add to Home Screen" (PWA) hint.** Not
  implemented; the site does not currently have a manifest. Could
  be a Phase 13 polish task if a native-feel launcher becomes a
  priority.

Awaiting explicit `GO — Phase 13` before starting Phase 13
(system-wide security review).

---

## 15.b Phase 12 — original spec  ·  ARCHIVED

### Goal

Make `/compte/badge` phenomenal on a phone — this is the primary way
attendees will show their credential.

### Priorities (in visual order)

1. BIS+ mark.
2. Name.
3. Participation type.
4. Large QR (occupies enough screen real-estate for a fast scan at
   arm's length under venue lighting).

Nothing else on the first fold. Additional info collapses below.

### Screen behavior

- Ask the browser (via CSS media hints where possible) to keep the screen
  bright while badge is open. If not possible, document the limitation.
- No animations that would delay the QR reveal.

### Exit criteria

- Real-device check (a phone, not just DevTools) — call this out
  explicitly if it cannot be done during implementation.
- Report — STOP for `GO`.

---

## 16. Phase 13 — Security Review (whole system)  ·  COMPLETE

Implementation date: 2026-09-18.

**Phase 13 security review: WARN 1 fixed; WARN 2 and WARN 3 remain
documented / deferred.** The whole-system reviewer verdict, after the
WARN 1 fix, is **OK** with **no new findings**. The access-control
chain built across Phases 3–12 is hardened end-to-end on every
mutation surface; the two remaining WARNs relate to admin session
storage and attendee badge rotation IP-limit, both explicitly out of
scope for this phase.

### Review outcome

- **Whole-system review pre-fix**: 16 of 17 attack scenarios
  HARDENED; 1 MIXED (rate-limiting due to unhardened admin login).
  Three WARN items surfaced (WARN 1, WARN 2, WARN 3).
- **WARN 1 fix applied in-phase**: admin-login hardened with rate
  limiting + timing equalisation + uniform failure message. Reuses
  the attendee login pattern via a shared `lib/rate-limit.ts` module.
- **WARN 1 re-review verdict**: **RESOLVED**. Reviewer confirmed the
  fix closes the enumeration side-channel and does not introduce new
  issues.
- **WARN 2 and WARN 3**: deferred with explicit follow-up records
  (see §"Mandatory follow-ups" below).

### WARN 1 — Admin Login Hardening (fixed)

**Original finding (pre-fix):**
`app/admin/login/actions.ts` — three distinct failure branches
(`!user`, `user.status !== ACTIVE`, `!verifyPassword`) revealed
account existence through different response text AND different
response latency. No rate limit on the endpoint. This is the gateway
to every `access.validate.*` scanner and every `access.manage` grant.

**Fix architecture:**

```
FormData(email, password, from)
    ↓
clientIp()                          [lib/client-ip.ts]
    ↓
verifyAdminLogin({email, password, ip})   [lib/admin/login-service.ts]
    ↓
    empty input?         → INVALID_INPUT
    isBlocked(ipKey)     → THROTTLED     (before DB access)
    isBlocked(emailKey)  → THROTTLED
    Prisma.adminUser.findUnique(email)
    !user                → verifyPassword(_, DUMMY_HASH); rejected()
    status !== ACTIVE    → verifyPassword(_, DUMMY_HASH); rejected()
    !verifyPassword      → rejected()
    → success: reset(emailKey); return { ok: true, userId }
    ↓
Wrapper (`app/admin/login/actions.ts`)
    outcome.ok === false → single GENERIC_ERROR or THROTTLED
    outcome.ok === true  → createSession → setSessionCookie
                          → lastLoginAt update → audit(auth.login)
                          → redirect(from || /admin/dashboard)
```

**Files added:**

| File | Purpose |
|------|---------|
| `lib/rate-limit.ts` | Shared in-process rate-limit primitives extracted from `app/actions/account.ts`. Exports `isBlocked`, `record`, `reset`, `DUMMY_HASH`, `THROTTLED_MESSAGE`. Single 15-minute window, 5000-bucket cap, insertion-order eviction with `RETAIN_ABOVE_COUNT=3` guard. Same `attempts` Map shared across attendee + admin flows (distinct key prefixes prevent collision). |
| `lib/client-ip.ts` | `clientIp()` extracted from `account.ts` verbatim. Split from `rate-limit.ts` so the pure primitives stay importable from `node:test` — `next/headers` requires React server context which the test host does not expose. |
| `lib/admin/login-service.ts` | Pure `verifyAdminLogin({email, password, ip})` function. Contains the entire authentication decision (rate-limit gate → user lookup → password verify → uniform outcome). No session/cookie/audit side-effects — those live in the caller so tests can exercise the decision without a Next.js request boundary. |
| `scripts/admin-login.test.ts` | 19 tests: 5 uniform-failure behavioural + 3 rate-limit + 2 success + 1 data-safety + 8 grep-locked structural. |

**Files modified:**

- `app/admin/login/actions.ts` — thin wrapper around `verifyAdminLogin`. Uses `GENERIC_ERROR` const for both INVALID_INPUT and INVALID_CREDENTIALS. Legacy distinct `"Ce compte est désactivé."` message removed. Session/cookie/audit unchanged.
- `app/actions/account.ts` — refactored to import from `lib/rate-limit.ts` + `lib/client-ip.ts`. Behaviour byte-preserved (same thresholds, same messages, same session creation). One line changed: `attempts.delete(emailKey)` → `reset(emailKey)`.
- `package.json` — added `test:admin-login` script.

**Preserved (unchanged) — verified byte-for-byte:**

- 12-hour admin session TTL.
- `bis_admin_session` cookie name; `httpOnly` + `sameSite=lax` + `secure` in production.
- Redirect target on success (`from` if it `.startsWith("/admin")`, else `/admin/dashboard`).
- `lastLoginAt` update on success.
- `auth.login` audit action.
- `AdminSession` schema (no migration).
- Role resolution / permission resolution (`requirePermission` in downstream handlers).
- The attendee registration + login flows in `app/actions/account.ts` (all thresholds and messages).

**Security properties (per WARN 1 re-review):**

- **User enumeration closed.** Every failure branch (no-user,
  DISABLED, wrong password, empty input) surfaces the byte-identical
  `GENERIC_ERROR` = `"Identifiants invalides."`. The distinct
  `"Ce compte est désactivé."` message is gone. Grep-locked by test.
- **Timing equalisation via DUMMY_HASH.** Both `!user` and
  `status !== ACTIVE` branches run `verifyPassword(password, DUMMY_HASH)`
  before returning. `DUMMY_HASH = hashPassword(randomBytes(16))` is
  computed once at module init using the real scrypt cost, so latency
  matches the wrong-password branch. Grep-locked: exactly two
  `verifyPassword(password, DUMMY_HASH);` code lines.
- **Rate limit runs BEFORE DB.** `isBlocked(ipKey) || isBlocked(emailKey)`
  is evaluated before `prisma.adminUser.findUnique`. Ordering
  grep-locked by structural test. Per-email 8 fails / 15 min;
  per-IP 20 fails / 15 min (same thresholds as attendee login).
- **Throttled outcome does not disclose existence.** Two throttled
  emails (one existing ACTIVE, one nonexistent) return the same
  `{ok:false, kind:"THROTTLED"}` outcome. Behavioural test explicitly
  fires this scenario.
- **No auth bypass.** Success reached only when the user exists, is
  ACTIVE, and the password verifies. Behavioural test asserts
  DISABLED-admin-with-correct-password returns INVALID_CREDENTIALS.
- **No session on failure.** `createSession` / `setSessionCookie` /
  `audit` / `lastLoginAt update` live in the wrapper strictly after
  the failure-return branches. Structural test locks source ordering.
- **No secret leakage.** Outcome shape carries only `userId` on
  success; only `kind` on failure. No password, no hash, no session
  token surface. Behavioural test asserts serialised outcome contains
  neither the raw password nor `scrypt$`.
- **Cross-flow namespacing safe.** Shared `attempts` Map with
  distinct prefixes: `admin-login:*`, `login:*`, `register:*`. Cross-flow
  interference is structurally impossible.

**Test coverage — `scripts/admin-login.test.ts` (19/19 pass):**

- 5 uniform-failure tests: nonexistent → INVALID_CREDENTIALS; ACTIVE
  + wrong pw → same; DISABLED + correct pw → same; empty email →
  INVALID_INPUT; empty password → INVALID_INPUT.
- 3 rate-limit tests: 9th attempt throttled; throttled does not
  disclose existence; throttled does not resurrect via correct pw.
- 2 success tests: correct pw returns userId; success resets bucket.
- 1 data-safety test: outcome carries no secret material.
- 8 structural tests: DUMMY_HASH import, both dummy-verify calls
  present, gate-before-findUnique ordering, no session/cookie in
  service, GENERIC_ERROR present, no distinct empty-input message,
  createSession-after-failure ordering, `clientIp()` used, no legacy
  DISABLED message.

**Regression suite (all pass, no regressions):**

- `npm run typecheck` → clean.
- `npm run test:admin-login` → **19 / 19** (new).
- `npm run test:main-entrance 24/24, test:room 22/22, test:scanner 26/26, test:access-admin 21/21, test:access-points 12/12, test:badge 28/28, test:rbac 31/31, test:access 5/5, test:qr 4/4, test:history 8/8`.
- `scripts/admin-smoke.mjs` (Phases 8 + 9 checks) → all pass. Dev-server smoke against port 3002 confirmed `/admin/access-points` 200, `/admin/scan/main` 200, `/admin/scan/room-01` 200, VIEWER refusals 307, unknown slug 404, path-traversal 404.
- **Total: 200 tests passing** (+19 for Phase 13 WARN 1 fix). Zero regressions across Phases 1–12.

**Security review of the WARN 1 fix (this phase):** **OK. No new
findings.** WARN 1 explicitly reassessed as RESOLVED by the
`security-reviewer` subagent. All ten focused checks pass.

### Per-scenario coverage — final (post-WARN 1 fix)

| # | Scenario | Verdict | Evidence |
|---|----------|---------|----------|
| 1 | QR forgery / brute force | HARDENED | 256-bit token, sha256 O(1), `timingSafeHexEqual`. |
| 2 | Credential leakage | HARDENED | No `console.*` of tokens; rawToken never persisted; audit meta explicit. |
| 3 | Referer / analytics / bookmark | HARDENED | Server actions are POST RPCs; scanner client forbids URL/storage placement. |
| 4 | Replay after rotation | HARDENED | `$transaction` + P2002 → `CONCURRENT_ROTATION`; verify rejects REVOKED. |
| 5 | IDOR (admin + attendee) | HARDENED | `requirePermission` + `assertParticipantTarget`; attendee scoped by `accountUserId`. |
| 6 | Main allow → implicit room bypass | HARDENED | Main VALID does not touch PA; room strict-requires `granted===true`. |
| 7 | Scanner impersonation | HARDENED | Route + action + validator core all enforce type-derived strict permission. |
| 8 | Operator escalation | HARDENED | `CHECKIN_OPERATOR` role holds only scan/view perms; no `access.manage`. |
| 9 | Permission-map tampering | HARDENED | `roles.manage` + SUPER_ADMIN-only for SUPER_ADMIN edits + "cannot grant what you don't hold". |
| 10 | Race conditions (rotate + atomic claim) | HARDENED | Partial unique + `updateMany({where: {checkedInAt: null}})`; 5-way concurrent test. |
| 11 | Sensitive data leakage in denied-scan | HARDENED | Whitelisted response shape; fixed French messages. |
| 12 | Audit integrity | HARDENED | Exactly one meaningful AuditLog per mutation; NOOP guards documented. |
| 13 | Rate limiting (admin login) | **HARDENED after WARN 1 fix.** Attendee login was already hardened; admin login now uses the same shared primitives. Scan actions still rely on the permission gate (documented). |
| 14 | Input validation | HARDENED | Zod on every server action; slug + rawToken shape + length caps. |
| 15 | CSRF | HARDENED | Next.js server actions handle by design. |
| 16 | Server-side authorisation on every mutation | HARDENED | Verified across all `"use server"` files. |
| 17 | Credential enumeration via timing / errors | **HARDENED after WARN 1 fix.** Attendee: DUMMY_HASH; Admin: DUMMY_HASH; Badge verify: timing-safe. |

### Mandatory follow-ups — recorded, NOT resolved

#### FOLLOW-UP A — ADMIN SESSION TOKEN HARDENING (was WARN 2)

- **Original condition:** `prisma/schema.prisma` stored `AdminSession.token`
  in **plaintext**. `lib/admin/auth.ts` wrote the raw random token and
  read it back for session validation. Compare: `AccountSession.tokenHash`
  (attendee side) stored only sha256(token).
- **Original impact:** a database dump directly replays as valid admin
  session cookies. Any adversary with DB read gains full admin-session
  hijacking capability for every unexpired `AdminSession` row.
- **Status: RESOLVED in Phase 15 (2026-09-19).** See §18 Phase 15
  completion record below for the full remediation. Reviewer verdict:
  **OK. WARN 2 explicitly RESOLVED.** Schema renamed
  `token → tokenHash`; all read/write paths now hash the raw cookie
  token before touching Prisma; one-shot invalidation forced every
  existing admin to log in again.
- **Historical record preserved above intentionally.** The condition
  existed for the duration of Phases 3–14; Phase 15 closed it before
  event deployment.

#### FOLLOW-UP B — ATTENDEE BADGE ROTATE IP RATE LIMIT (was WARN 3)

- **Current condition:** `app/compte/badge/actions.ts:26-106` enforces
  per-participant 10-second cooldown; no IP-based or global cap.
- **Impact:** per-participant guard bounds each authenticated attendee
  to 6 rotations/minute. A hostile with N distinct authenticated
  `AccountUser` sessions could multiply this by N, capped by the
  attendee-register IP limit at `app/actions/account.ts` (5
  registrations per IP per 15 minutes). Effective ceiling: modest.
- **Scope required to fix:** add an `isBlocked/record` gate against a
  new `badge-rotate:ip:<ip>` bucket in `lib/rate-limit.ts`. Small,
  self-contained change. Would use the same shared primitives just
  extracted.
- **Reviewer stance:** deferral is acceptable given the register-side
  IP limit; recommend a post-Phase-13 hardening iteration.
- **Status:** **DEFERRED.** Not scheduled as blocking.

### Minor observations — documented follow-ups (not defects)

- `app/admin/login/actions.ts:redirect(from && from.startsWith("/admin") ? …)`
  — trailing-slash tighter guard would rule out theoretical
  `/admin\evil.com` edge cases. Very low severity given `sameSite=lax`.
  **Deferred per owner directive; do not fix silently.**
- `app/admin/(protected)/layout.tsx` — sidebar visibility computed from
  `ROLE_PERMISSIONS` baseline, not `canWithOverrides`. UX-only; server
  always uses overrides. **Deferred.**
- `app/admin/(protected)/check-in/actions.ts:validateTicket` — uses
  `findFirst` without a `select` whitelist. No current leak; defensive
  concern for future refactors. **Deferred.**

### Files intentionally NOT touched in Phase 13

- `prisma/schema.prisma` — no schema change (FOLLOW-UP A explicitly
  deferred; no migration in this phase).
- `lib/badge/**` — Phase 2 service unchanged.
- `lib/admin/rbac.ts` — no permission changes.
- `lib/admin/room-validator.ts`, `lib/admin/main-entrance-validator.ts`
  — Phases 10/11 code unchanged.
- `components/compte/use-screen-wake-lock.ts`,
  `components/compte/badge-*.tsx` — Phase 12 code unchanged.
- `middleware.ts` — unchanged.
- `app/admin/(protected)/**` except `access-actions` / `access-points` /
  `scan` / `check-in` / `registrants` which were only READ, not written.
- All `/compte/**` routes and their supporting `lib/account/*` files.
- No new dependency.

### Phase 14 readiness

**Phase 13 is COMPLETE.** No BLOCK. WARN 1 fixed and re-reviewed
RESOLVED. FOLLOW-UPS A and B recorded as mandatory (A) and
recommended (B) post-Phase-13 hardening.

Awaiting explicit `GO — Phase 14` before starting Phase 14 (final
testing matrix). Note that Phase 14's exit criteria explicitly cover
manual verification of every access-control path end-to-end; the
matrix will re-verify WARN 1 in a live-browser context.

---

## 16.b Phase 13 — original spec  ·  ARCHIVED

### Scope

End-to-end review of every surface touched by Phases 3–12. This is not
"the QR is random" — it is a full access-control chain audit.

### Attack scenarios to think through

- QR forgery / brute force.
- Credential leakage (logs, error messages, network).
- Token exposure via referer / analytics / bookmarks.
- Replay attacks (rotation invalidates prior tokens).
- IDOR on admin endpoints and on attendee endpoints.
- Room-access bypass (e.g. main entrance allowing implicit room access).
- Scanner impersonation (attacker opens `/admin/scan/room-01` without
  auth or with insufficient permission).
- Operator permission escalation.
- Admin permission-map tampering.
- Race conditions on grant/revoke and rotate.
- Sensitive data leakage in denied-scan responses.
- Audit integrity (are all lifecycle events actually recorded?).
- Rate limiting on scan and login endpoints.
- Input validation on all server actions (Zod, size caps, token-shaped
  regex on free-text fields).
- CSRF on state-changing forms (Next server actions handle this, but
  verify).
- Server-side authorization on every mutation.
- Credential enumeration through timing or error-message differences.

### Exit criteria

- `security-reviewer` verdict OK on every mutation surface, or all WARNs
  documented and accepted.
- Report — STOP for `GO`.

---

## Pre-Phase-14 Cross-Phase Audit  ·  COMPLETE

Audit date: 2026-09-19.

Focused cross-phase review of Phases 11, 12, and 13 before Phase 14
(final testing matrix) begins. **No code changes.** Existing shipped
implementations verified against master-doc records; no defects
discovered; no scope creep. Every test suite passes.

### Audit result summary

| Phase | Result | Findings |
|-------|--------|----------|
| Phase 11 (ROOM QR validation) | **PASS** | No new findings. Shipped semantics match the master doc byte-for-byte. |
| Phase 12 (Mobile badge / QR rotation) | **PASS** | No new findings. Rotation-on-every-click UX is honest and documented in the on-screen copy. |
| Phase 13 (Whole-system security review) | **PASS** | WARN 1 fixed and re-reviewed RESOLVED; WARN 2 + WARN 3 correctly recorded as DEFERRED with full impact statements. |

**No blocker before Phase 14.** Real-device verification of Phase 12
remains user-owned (Claude cannot physically test on a phone; the
Phase 14 matrix explicitly covers this).

### Phase 11 audit — verified

Verified against `lib/admin/room-validator.ts`,
`app/admin/(protected)/scan/[access-point-slug]/actions.ts`, and
`scripts/room.test.ts`.

- ✓ **C1 = A shipped.** Every authorized room scan writes a fresh
  `CheckIn(VALID, reason=ROOM_ENTRY)`. No `ALREADY_CHECKED_IN` for
  rooms. Confirmed by test "two consecutive authorized scans → TWO
  CheckIn(VALID) rows".
- ✓ **No `Participant.checkedInAt` mutation.** Grep of the room
  validator source: `checkedInAt` appears only in code comments
  (documenting the invariant). `participant.update` and `updateMany`
  do NOT appear in the room validator. Structural test locks this.
- ✓ **No atomic claim.** Grep for `checkedInAt: null` filter: absent
  in the room validator. Structural test locks this.
- ✓ **Exactly one CheckIn per resolved-participant scan.** Verified
  by tests writing 1 row per happy-path scan and 1 row per
  participant-resolved denial (PA_REVOKED / PA_NOT_GRANTED / UNPAID /
  CANCELLED-status-path).
- ✓ **Exactly one AuditLog per scan attempt.** `action = "checkin.scan.qr"`
  fires once per scan regardless of outcome. Meta.accessPointType
  distinguishes ROOM vs MAIN for forensics.

**No unintended security issue from repeated scans.** Each write is
scoped to the resolved (participant, accessPoint) pair and does not
mutate `Participant` state. A hostile authenticated operator scanning
the same participant 1000 times would produce 1000 CheckIn(VALID)
rows — bounded by operator session duration and visible in the audit
trail. Room capacity, if ever needed, would be enforced by counting
CheckIn rows in a time window (deferred; not part of Phase 11).

**No invented capacity/idempotency rules.** C1 = A stays as shipped.

### Phase 11 — access rules verified

- ✓ **`access.validate.room` required.**
  `actions.ts:85` (`requirePermission("access.validate.room")`).
- ✓ **`checkin.validate` cannot authorize.** Grep of the room path
  finds no reference to `checkin.validate`.
- ✓ **`access.validate.main` cannot authorize.** Grep of the room
  validator finds no reference to the main permission.
- ✓ **AccessPoint re-resolved server-side.** `room-validator.ts`
  performs a fresh `prisma.accessPoint.findUnique({where:{slug}})`
  before any authorization decision.
- ✓ **`active === true` required.** Explicit refusal branch:
  `ACCESS_POINT_INACTIVE`.
- ✓ **`type === ROOM` required.** MAIN_ENTRANCE point reaching this
  validator returns `ACCESS_POINT_WRONG_TYPE` with no CheckIn.
- ✓ **ParticipantAccess scoped to resolved AccessPoint.** Prisma
  query uses `where: { accessPointId: point.id }` on the joined
  `accessPermissions` — cross-room lookup impossible.
- ✓ **Missing PA row → PA_NOT_GRANTED**; **granted=false → PA_REVOKED**.
  Distinct reason codes; both deny.
- ✓ **`granted=true` does NOT bypass UNPAID.** Check order:
  CANCELLED → UNPAID → PA. Test "UNPAID + PA granted=true → UNPAID"
  locks this.
- ✓ **CANCELLED remains denied.** Both verify-path and status-path
  return `outcome: CANCELLED`.
- ✓ **No cross-room leakage.** Test "PA on room-01 does NOT
  authorize room-02" locks this end-to-end.

### Phase 11 — unknown/failed badges verified (B4)

- ✓ **BADGE_INVALID, BADGE_REVOKED, BADGE_EXPIRED, verify-path
  CANCELLED** all take the `!verify.ok` branch which writes AuditLog
  only. No CheckIn created for any of these outcomes.
- ✓ **No fabricated `participantId` / `credentialId`.** `verifyBadgeToken`
  return type does not expose these on failure; the room validator
  respects that contract.
- ✓ **No rawToken as ticketCode.** Grep + structural test
  "validator never assigns rawToken into any Prisma field" locks this.
- ✓ **B4 unchanged.** Policy record in the master doc remains
  authoritative.

### Phase 12 — QR rotation semantics (exact current UX)

Traced through `components/compte/badge-qr-client.tsx`,
`app/compte/badge/actions.ts`, and `lib/badge/service.ts:rotateBadgeCredential`:

| Event | Rotates? | Why |
|-------|----------|-----|
| Page load (`/compte/badge`) | **NO** | The page is a server-rendered read; the badge card is shown without a QR image. Only the button state (label + `hasActiveCredential`) reflects prior credential presence. |
| First click on "Générer mon badge" (no ACTIVE credential) | **YES** — first issue | `generateOrRotateMyBadge` → `rotateBadgeCredential(participantId, null, "self-service")`. Phase 2 service treats no-prior-ACTIVE as an issue; `previousCredentialId = null`. |
| Click on "Afficher mon QR" (`hasActiveCredential = true`, no display yet this render) | **YES** — full rotation | Same server action, same call. Prior ACTIVE is revoked, new ACTIVE issued. The button label ("Afficher") is UX shorthand; the on-screen copy explicitly warns "Votre QR précédent sera automatiquement révoqué". |
| Click on "Régénérer mon QR" (QR is currently displayed) | **YES** — full rotation | Same server action. Same revoke-and-reissue. |
| "Imprimer mon badge" button | **NO** | Calls `window.print()` directly. No server action fires. Print uses the currently-displayed QR. |
| Page refresh / navigation away | **NO** | Refresh drops the React state (`state.qrDataUrl` is transient). The user must click a button again to see a QR — which then rotates. No implicit rotation on refresh. |
| Tab-visibility change | **NO** | Not connected to the rotation action. Wake-lock re-acquires on visibility, but the QR itself is unaffected. |
| Route navigation to `/compte/badge` (from another `/compte/*` page) | **NO** | Server-rendered page load without a form submit. No rotation. |

**Master-doc comparison:** the shipped behaviour matches the
"rotation-on-every-view" model documented in Phase 5 §"Design
decisions" and Phase 12 §"Design decisions" ("No animations that
would delay the QR reveal" — the QR renders immediately from a data
URL). The on-screen French copy explicitly explains the rotation
consequence to the attendee, so the UX is honest.

**No contradiction with the master doc.** Implementation left
unchanged.

**No business ambiguity discovered.** The single-active-per-participant
DB partial unique index (from Phase 1) guarantees the model is
self-consistent regardless of user-side click patterns.

### Phase 12 — QR security verified

- ✓ **QR contains only opaque credential.** `lib/badge/qr.ts`
  encodes the rawToken as PNG pixels; no participantId, no email,
  no ticketCode, no metadata.
- ✓ **rawToken not persisted.** Phase 2 stores `sha256(token)` only.
- ✓ **rawToken not logged.** `lib/badge/token.ts` + all callers grep-clean;
  Phase 2 test "raw token does not appear in a BadgeError's message or
  stringify" and "AuditLog rows do not contain the raw token" still pass.
- ✓ **tokenHash never reaches the browser.** Whitelist selects in
  `lib/account/participant.ts` and `lib/admin/queries.ts` do not
  include `tokenHash`.
- ✓ **No QR credential in URL.** `generateOrRotateMyBadge` returns
  `{qrDataUrl, issuedAt}` — the `qrDataUrl` is a `data:image/png;base64,...`
  blob rendered via `<img src={dataUrl}>`. No query params, no path
  segments.
- ✓ **No QR credential in localStorage / sessionStorage / cookies /
  IndexedDB.** Scanner-client test suite bans these APIs; attendee
  badge client uses only React state which drops on refresh.
- ✓ **QR data URL only rendered in memory.** State is React-only; no
  persistence layer.
- ✓ **BadgeCredential lifecycle is server-side.** All issue / verify /
  revoke / rotate go through `lib/badge/service.ts` inside
  `prisma.$transaction`. The client never mutates.

**No design weakening detected.**

### Phase 12 — mobile UX

**CODE-VERIFIED:**

- ✓ First-fold order: BIS+ mark, Name, Participation type, QR (in
  `components/compte/badge-card.tsx`).
- ✓ 300px mobile QR cap (`max-w-[300px]` on mobile, `sm:max-w-[200px]`
  on ≥640px viewports).
- ✓ 3:4 badge proportions preserved at `sm+` (`sm:aspect-[3/4]`
  `sm:max-w-[340px]`). Print CSS (`.print-badge`, 90mm) unchanged.
- ✓ Print behavior unchanged (Ctrl+P still yields a 3:4 credential
  at 90mm on A5/A6 stock; `globals.css` `@media print` rules intact).
- ✓ QR visibility after page navigation: none (see rotation table
  above — refresh drops the state; the user must click again).
- ✓ Wake-lock lifecycle (`components/compte/use-screen-wake-lock.ts`):
  requested on mount when `enabled=true`, released on unmount, released
  on `qrDataUrl` clearing. Cleanup returned from `useEffect` calls
  `sentinel.release().catch(() => undefined)`.
- ✓ visibilitychange re-acquisition: `document.addEventListener("visibilitychange", onVisibility)` re-acquires the lock when the tab returns to `visible` and the sentinel is null.
- ✓ Graceful unsupported-browser behaviour: feature-detect
  `"wakeLock" in navigator` at effect start; silent no-op when
  missing. `active` state stays false; the discreet indicator does
  not render.
- ✓ Cleanup on unmount: `return () => { cancelled = true; ...release() }`.
- ✓ **QR validity is INDEPENDENT of the wake lock.** The QR is a
  valid credential regardless of whether the wake lock succeeded;
  the wake lock is UX-only. A hostile environment that blocks the
  wake lock does NOT invalidate a real scan.

**REAL-DEVICE-VERIFICATION REQUIRED (owner responsibility, per
master doc §Phase 12):**

- ⚠ Actual scannability at arm's length under venue lighting.
- ⚠ Actual wake-lock behaviour on Android Chrome + iOS Safari 16.4+.
- ⚠ Actual first-fold behaviour on 5.4"/6.1"/6.7" phones.
- ⚠ Actual print output on physical A5/A6 stock.

Claude did NOT test on a real device. These items belong to the
Phase 14 matrix (row 23: "Mobile QR scannable in a real phone
browser"; row 24: "Print badge produces a usable PDF via Ctrl+P").

### Phase 13 — security debt (recorded status)

| Item | Status | Location in master doc |
|------|--------|------------------------|
| WARN 1 (admin login enumeration + no rate limit) | **FIXED** in-phase; re-reviewed RESOLVED | §16 Phase 13 completion record |
| WARN 2 (AdminSession.token plaintext) | **DEFERRED — MUST FIX BEFORE PRODUCTION/EVENT DEPLOYMENT** | §16 FOLLOW-UP A (fully recorded, not downplayed) |
| WARN 3 (badge rotation IP/global limit) | **DEFERRED** | §16 FOLLOW-UP B |

**WARN 2 is NOT relabeled as resolved.** The FOLLOW-UP A record
explicitly states:

> **Impact:** a database dump directly replays as valid admin session
> cookies. Any adversary with DB read gains full admin-session
> hijacking capability for every unexpired `AdminSession` row.
> **Status:** **DEFERRED.** Not part of Phase 13 completion. Must be
> scheduled as a dedicated admin-auth hardening phase before the
> event (ideally within the next sprint cycle).
> **Not resolved. Not downplayed.**

This audit re-affirms the DEFERRED + PRE-PRODUCTION-MANDATORY status.

### Rate-limit implementation — deployment characteristic

Inspection of `lib/rate-limit.ts`:

- **In-memory per-process Map.** `const attempts = new Map<...>()`
  at module scope (line 30). No Redis, no shared cache, no DB
  persistence.
- **Best-effort documented.** Header comment (line 13): "LIMITS:
  best-effort per-process. A multi-instance deploy multiplies the
  effective threshold by the instance count, so this is a speed
  bump, not a guarantee."
- **Namespacing enforced.** Distinct prefixes:
  `register:ip:*` / `register:email:*` / `login:ip:*` /
  `login:email:*` / `admin-login:ip:*` / `admin-login:email:*`. No
  cross-flow collision possible.
- **No credential leakage in the algorithm.** `isBlocked` / `record`
  / `reset` operate only on the string keys the caller composes;
  password / token material never enters this module.
- **No bypass through alternate inputs.** Empty input is caught by
  the service layer (`INVALID_INPUT`) before `isBlocked` runs;
  invalid keys with `null` are safely no-op'd.

**Production-deployment consideration (RECORDED, not changed):**

- **The rate limiter is process-local.** If the app runs on multiple
  Next.js instances (e.g., Vercel serverless with multiple lambdas,
  multiple pods, or a scaled Node cluster), each instance holds its
  own `attempts` Map. The effective threshold multiplies by the
  instance count. For an 8-instance deploy, "8 fails per email per
  15 min" becomes up to 64 fails per email per 15 min.
- **Recommended follow-up (not in scope of this audit):** for
  production, back the rate limiter with Redis / Upstash / a shared
  cache so limits are global. This would be a small edit to
  `lib/rate-limit.ts` (swap the `Map` for a Redis-backed store); the
  caller API (`isBlocked` / `record` / `reset`) stays identical.
- **Interim safety net:** the reverse proxy / CDN (Cloudflare, Vercel
  edge, etc.) can enforce a rougher IP-level rate limit at the edge
  before requests even reach the Node instance. This complements —
  not replaces — the application-level bucket.

### Test verification

- `npm run typecheck` → clean.
- `npm run test:main-entrance 24/24, test:room 22/22, test:scanner 26/26, test:access-admin 21/21, test:access-points 12/12, test:badge 28/28, test:rbac 31/31, test:access 5/5, test:qr 4/4, test:history 8/8, test:admin-login 19/19` — **200/200 pass, zero regressions.**
- `scripts/compte-smoke.ts` → **14/14** attendee routes render (populated + empty scenarios).
- `scripts/admin-smoke.mjs` → **7/7** admin route checks pass (SUPER_ADMIN, CHECKIN_OPERATOR, VIEWER refusals, unknown slug, path-traversal).

No test weakened. No test skipped.

### Files intentionally NOT touched in this audit

- No code changes made. The audit is documentation-only.
- `lib/admin/room-validator.ts`, `lib/admin/main-entrance-validator.ts`,
  `lib/admin/login-service.ts`, `lib/rate-limit.ts`, `lib/client-ip.ts`
  — unchanged.
- `app/admin/(protected)/scan/**`, `app/admin/login/actions.ts`,
  `app/actions/account.ts`, `app/compte/badge/**` — unchanged.
- `components/compte/badge-*.tsx`, `components/compte/use-screen-wake-lock.ts`
  — unchanged.
- `prisma/schema.prisma`, `middleware.ts`, `lib/db.ts` — unchanged.
- No dependency added.

### Blocker check — Phase 14 readiness

- **No BLOCK identified.**
- Phase 11: PASS.
- Phase 12: PASS (code-verified; real-device verification handed off
  to Phase 14 matrix rows 23 + 24).
- Phase 13: PASS (WARN 1 fixed; WARN 2 + WARN 3 recorded DEFERRED
  with full impact + status intact).
- Rate-limit process-local caveat: documented as a production
  deployment consideration; NOT a Phase 14 blocker (application-level
  buckets still bound abuse under a single-instance deploy).
- AdminSession token hardening: MUST FIX BEFORE PRODUCTION/EVENT
  DEPLOYMENT — but not a Phase 14 blocker for the test matrix.

**Awaiting explicit `GO — Phase 14`** to begin the final testing
matrix (§17).

---

## 17. Phase 14 — Final Testing (matrix)  ·  PASS

Verification date: 2026-09-19.

**PHASE 14 — PASS** (with real-device items explicitly marked NOT
TESTED per master-doc convention and one mandatory pre-production
security fix outstanding). This is the final testing gate for the
access-control system built across Phases 3–13. No new features
introduced. No business rules changed. No code changes made during
verification.

### 14.1 Total automated tests

| Suite | Tests | Result |
|-------|-------|--------|
| `npm run typecheck` | — | clean |
| `test:admin-login` | 19 | 19/19 |
| `test:main-entrance` | 24 | 24/24 |
| `test:room` | 22 | 22/22 |
| `test:scanner` | 26 | 26/26 |
| `test:access-admin` | 21 | 21/21 |
| `test:access-points` | 12 | 12/12 |
| `test:badge` | 28 | 28/28 |
| `test:rbac` | 31 | 31/31 |
| `test:access` | 5 | 5/5 |
| `test:qr` | 4 | 4/4 |
| `test:history` | 8 | 8/8 |
| **TOTAL** | **200** | **200/200** |
| `scripts/compte-smoke.ts` | 14 attendee routes × 2 scenarios | all 200 responses |
| `scripts/admin-smoke.mjs` | 7 admin checks | all 7 pass |

Zero regressions. Zero skipped. Zero flaky.

### 14.2 Main Entrance E2E matrix

Every case has a shipped test that exercises the exact behaviour.
Column "PASS" = the automated test lists as passing in run 14.1.

| Case | Description | Result | Evidence |
|------|-------------|--------|----------|
| A | ACTIVE + PAID + no MAIN PA row | **PASS** — VALID | `scripts/main-entrance.test.ts:165` "PAID + eligible + no ParticipantAccess row → VALID" |
| B | ACTIVE + PAID + MAIN granted=true | **PASS** — VALID | `scripts/main-entrance.test.ts:210` "PAID + PA granted=true → VALID (does not depend on override)" |
| C | ACTIVE + PAID + MAIN granted=false | **PASS** — PA_REVOKED / CheckIn(UNKNOWN, reason=PA_REVOKED) | `main-entrance.test.ts:279` |
| D | ACTIVE + UNPAID | **PASS** — UNPAID | `main-entrance.test.ts:316` |
| E | ACTIVE + participant CANCELLED | **PASS** — CANCELLED (verify-path, AuditLog only per B4) | `main-entrance.test.ts:340` |
| F | Already checked-in participant | **PASS** — ALREADY_CHECKED_IN + prior timestamp preserved | `main-entrance.test.ts:231` "second scan → ALREADY_CHECKED_IN, no re-write" |
| G | Revoked badge | **PASS** — BADGE_REVOKED, no CheckIn | `main-entrance.test.ts:385` |
| H | Expired badge | **PASS** — BADGE_EXPIRED, no CheckIn | `main-entrance.test.ts:419` |
| I | Unknown / random QR | **PASS** — BADGE_INVALID, no CheckIn | `main-entrance.test.ts:442` |
| J | Inactive AccessPoint | **PASS** — ACCESS_POINT_INACTIVE | `main-entrance.test.ts:474` |
| K | ROOM AccessPoint sent to MAIN validator | **PASS** — ACCESS_POINT_WRONG_TYPE | `main-entrance.test.ts:502` |
| L | Operator with `checkin.validate` only, no `access.validate.main` | **PASS** — scanner denied 307 | `scripts/rbac.test.ts` (CHECKIN_OPERATOR baseline) + `scanner.test.ts:167` (page never accepts `checkin.validate`) + `admin-smoke.mjs` (VIEWER → 307 `denied=access.validate.main`) |

Additional Main-Entrance concurrency lock: 5 simultaneous scans →
exactly 1 VALID + 4 ALREADY_CHECKED_IN, `checkedInAt` set once
(`main-entrance.test.ts:534`).

### 14.3 Room E2E matrix

| Case | Description | Result | Evidence |
|------|-------------|--------|----------|
| A | Room 01 granted | **PASS** — VALID + CheckIn(VALID, ROOM_ENTRY) | `scripts/room.test.ts:184` "PAID + PA granted=true → VALID + CheckIn(VALID)" |
| B | Room 01 unassigned | **PASS** — PA_NOT_GRANTED (default-deny) | `room.test.ts:277` |
| C | Room 01 revoked | **PASS** — PA_REVOKED | `room.test.ts:258` |
| D | Room 01 + UNPAID | **PASS** — UNPAID (payment gate wins even with PA granted) | `room.test.ts:294` |
| E | PA on room-01 does NOT authorize room-02 | **PASS** — room-01 VALID, room-02 PA_NOT_GRANTED | `room.test.ts:455` "cross-room isolation" |
| F | MAIN access permission does NOT authorize ROOM scanner | **PASS** — `requirePermission("access.validate.room")` STRICT; grep-locked | `room.test.ts:609` "room server action requires access.validate.room strictly" |
| G | `checkin.validate` does NOT authorize ROOM scanner | **PASS** — strict permission; helper `requiredScannerPermission` never returns `checkin.validate` | `scanner.test.ts:52` |
| H | Inactive room | **PASS** — ACCESS_POINT_INACTIVE, no CheckIn | `room.test.ts:394` |
| I | MAIN AccessPoint sent to room validator | **PASS** — ACCESS_POINT_WRONG_TYPE, no mutation | `room.test.ts:422` |
| J | Two+ valid scans, same participant/room | **PASS** — TWO CheckIn(VALID) rows (C1 = A) | `room.test.ts:224` "two consecutive authorized scans → TWO CheckIn(VALID) rows" |
| K | `Participant.checkedInAt` remains unchanged during room scans | **PASS** — grep-locked + DB assertion after every authorized room scan | `room.test.ts:495` "Participant.checkedInAt is NEVER mutated by room validation" |

Additional ROOM guarantees:
- Verify-failure paths (INVALID / REVOKED / EXPIRED) → AuditLog only,
  no CheckIn (`room.test.ts:333` / `:356` / `:377`).
- `ParticipantAccess` never mutated by validation (`room.test.ts:540`).
- rawToken never in any DB row after a valid room scan
  (`room.test.ts:513`).

### 14.4 Badge / QR E2E

| Item | Result | Evidence |
|------|--------|----------|
| QR scannable from `/compte/badge` | **PASS** (code-verified; render + PNG data URL) — real-device row 14.5.6 | `test:qr 4/4`, `compte-smoke.ts` |
| QR contains only opaque credential | **PASS** | `test:qr` "raw token never appears as plaintext in the data URL"; `test:badge` "raw token does not appear in a BadgeError's message" |
| Raw credential never in visible UI | **PASS** | `scripts/scanner.test.ts:314` "decoded credential is not rendered as visible text" |
| No credential in URL | **PASS** | `scanner.test.ts:296` "scanner-client does NOT place decoded value in URLs or window.history" |
| No localStorage / sessionStorage / cookies / IndexedDB persistence | **PASS** | `scanner.test.ts:274` "scanner-client.tsx does NOT persist to any client storage" |
| `tokenHash` never reaches browser | **PASS** | Whitelist selects in `lib/account/participant.ts` and `lib/admin/queries.ts` exclude `tokenHash` (Phase 4 + Phase 7 records) |
| Rotation revokes previous credential | **PASS** | `test:badge` rotate suite; `main-entrance.test.ts:385` scans an old token after a real revoke → BADGE_REVOKED |
| Previous credential fails after rotation | **PASS** | Same as above |
| Active credential works | **PASS** | Every main / room happy-path test |
| Page refresh does NOT rotate | **PASS** (audited in Pre-Phase-14 §Phase 12) — refresh drops React state; no server action fires without a click | Trace: `components/compte/badge-qr-client.tsx` |
| Route navigation does NOT rotate | **PASS** | Same trace |
| Print does NOT rotate | **PASS** | `window.print()` is a browser-only call; no server action |
| Explicit regeneration DOES rotate | **PASS** | Every click of `generateOrRotateMyBadge` → `rotateBadgeCredential` → revoke-prior + issue-new inside `$transaction` |

### 14.5 Mobile real-device matrix — **OWNER / REAL-DEVICE TEST**

Claude cannot physically test on a phone from this environment. Every
item below is marked with its actual verification status. **Do NOT
mark any of these PASS without a real hands-on test on the owner's
side.** Code-verification for each has been done separately (see
Pre-Phase-14 §Phase 12 audit table).

| # | Item | Status |
|---|------|--------|
| 1 | QR visible in first fold | **NOT TESTED** (code-verified: `max-w-[300px]` on mobile, first-fold order BIS+ / Name / Participation / QR in `badge-card.tsx`) |
| 2 | QR size practically scannable | **NOT TESTED** |
| 3 | Name + participation not cut off | **NOT TESTED** |
| 4 | Display usable after ~60 s | **NOT TESTED** (wake-lock code-verified) |
| 5 | Wake-lock behaviour where supported | **NOT TESTED** (feature-detect + release + visibilitychange re-acquire all code-verified in `use-screen-wake-lock.ts`) |
| 6 | QR scannable under realistic venue lighting | **NOT TESTED** |
| 7 | QR scans from a second device | **NOT TESTED** |
| 8 | QR usable after returning to page | **NOT TESTED** (behaviour: refresh drops state → user must click again → new QR issued) |
| 9 | Rotation produces no broken intermediate state | **NOT TESTED** (code-verified: React state is atomic; `pending` disables the button; only one server action fires per click) |
| 10 | Print output usable | **NOT TESTED** (code-verified: `.print-badge` CSS at 90mm × 3:4 preserved) |

**Owner action required:** run through each row on Android Chrome and
iOS Safari 16.4+ before go-live. Record PASS/FAIL in this section.
Any FAIL becomes a Phase 15 defect entry.

### 14.6 CheckIn history matrix (`/compte/acces`)

| Item | Result | Evidence |
|------|--------|----------|
| Shows only the authenticated participant's own history | **PASS** | `test:history` "participant query returns rows for BOTH granted=true and granted=false" + Phase 4 whitelist `lib/account/participant.ts` scopes by `accountUserId = <session>` |
| Main Entrance CheckIn appears | **PASS** | `test:history 8/8`; `compte-smoke.ts` markers `"Accès enregistré"` |
| Room CheckIn appears | **PASS** | Same suite |
| Timestamps correct | **PASS** | `scannedAt` rendered from DB via `Intl.DateTimeFormat`; no fabrication |
| AccessPoint names correct | **PASS** | Whitelist select `{slug, name, type}` on the join |
| Legacy rows (`accessPointId=null`) safe | **PASS** | Phase 6 "Point d'accès non répertorié" fallback |
| ParticipantAccess NOT shown as CheckIn | **PASS** | `test:history` explicit test: granting room access does not fabricate a CheckIn row |
| No internal IDs / secrets in DOM | **PASS** | Whitelist select excludes `id`, `credentialId`, `ticketCode` from history render (Phase 6) |
| Multiple room scans produce N history rows | **PASS** | Follows from C1 = A + attendee history query (`take: 50`, ordering `scannedAt desc`) |

### 14.7 Admin access matrix

| Item | Result | Evidence |
|------|--------|----------|
| Grant room | **PASS** | `test:access-admin` "grant creates row with granted=true + grantedById" |
| Revoke room | **PASS** | `test:access-admin` "revoke updates the row to granted=false (does NOT delete)" |
| See unassigned / granted / denied (tri-state) | **PASS** | `test:access` 5/5 (tri-state classifier); `test:access-admin` cross-participant isolation |
| Unauthorized role cannot mutate | **PASS** | `test:access-admin` "VIEWER / SALES / CHECKIN_OPERATOR do NOT hold access.manage" + server-side `requirePermission` |
| Actor comes from session | **PASS** | `test:access-admin` "actor authenticity" grep-locked; server actions call `requirePermission` first |
| Target cannot be AdminUser | **PASS** | `test:access-admin` "assertParticipantTarget rejects an AdminUser id" |
| One meaningful audit per real mutation | **PASS** | `test:access-admin` NOOP guard suite (6 cells of the tri-state × grant/revoke matrix) |
| NOOPs produce no audit noise | **PASS** | Same suite: `granted → grant = NOOP` and `denied → revoke = NOOP` skip both mutation and audit |

### 14.8 AccessPoint admin

| Item | Result | Evidence |
|------|--------|----------|
| `active=false` disables operations | **PASS** | `test:access-points` "deactivate preserves ParticipantAccess and CheckIn history"; Phase 7 `assertActiveAccessPoint` refuses mutations |
| Delete blocked when dependencies exist | **PASS** | `test:access-points` delete guard suite |
| Type immutable | **PASS** | `test:access-points` "type is create-only" (grep of source) |
| Slug constraints work (regex, anchoring, path-traversal-safe) | **PASS** | `test:access-points` slug guard + Phase 8 audit |
| Slug rename per Phase 8 policy | **PASS** | Refused when `checkIns > 0` |
| REGISTRATION_MANAGER read-only | **PASS** | Only holds `access.view`, not `settings.manage` |
| `settings.manage` required for writes | **PASS** | Grep-verified on all 6 access-point actions |

### 14.9 Audit integrity — action name inventory

| Action | Emitter | Verified |
|--------|---------|----------|
| `auth.login` | `app/admin/login/actions.ts` (Phase 13 hardened) | ✓ actor from session |
| `auth.logout` | Same file | ✓ |
| `badge.issue` | `lib/badge/service.ts` (Phase 2) | ✓ meta = `{credentialId}` only |
| `badge.rotate` | Same | ✓ meta = `{newCredentialId, previousCredentialId, reason}` |
| `badge.revoke` | Same | ✓ meta = `{credentialId, reason}` |
| `badge.rotate.self` | `app/compte/badge/actions.ts` (Phase 5) | ✓ attendee-initiated marker |
| `badge.rotate.admin` | `app/admin/(protected)/registrants/[id]/access-actions.ts` (Phase 7) | ✓ admin-initiated marker |
| `badge.revoke.admin` | Same | ✓ NOOP-skip guard from Phase 7 audit |
| `access.grant` | Same | ✓ before/after meta |
| `access.revoke` | Same | ✓ before/after meta |
| `access-point.create` / `.rename` / `.slug` / `.reorder` / `.activate` / `.deactivate` / `.delete` | `app/admin/(protected)/access-points/actions.ts` (Phase 8) | ✓ one row per real mutation; NOOPs skip |
| `checkin.scan` | `app/admin/(protected)/check-in/actions.ts` (legacy manual flow) | ✓ preserved byte-for-byte |
| `checkin.scan.qr` | `lib/admin/main-entrance-validator.ts` + `lib/admin/room-validator.ts` (Phase 10/11) | ✓ meta = `{accessPointId, accessPointSlug, accessPointType, result, reason}`, no rawToken/tokenHash |

**No `rawToken` / `tokenHash` / password / session-token in any
AuditLog write.** Locked by:

- `test:badge` "AuditLog rows do not contain the raw token"
- `test:main-entrance` "rawToken never appears in DB after a valid scan"
- `test:main-entrance` "rawToken never appears anywhere on badge-failure paths either"
- `test:room` "rawToken never appears in any DB row after a valid room scan"

QR scans use `checkin.scan.qr` (structurally locked). Legacy manual
scans use `checkin.scan` (structurally locked in
`main-entrance.test.ts:705` "manual flow still audits as `checkin.scan`,
not `checkin.scan.qr`").

### 14.10 Race / concurrency results

| Scenario | Expected | Actual |
|----------|----------|--------|
| MAIN — 5 simultaneous scans on same participant | exactly 1 VALID + 4 ALREADY_CHECKED_IN; `checkedInAt` set once | **PASS** (`main-entrance.test.ts:534`) |
| ROOM — multiple simultaneous valid scans same participant | multiple VALID rows (C1 = A intentional) | **PASS** (`room.test.ts:224` two-consecutive locks the semantic; C1 = A is architecturally verified because no `updateMany`/`checkedInAt` claim exists in the room validator) |
| Badge — concurrent rotations | at most one ACTIVE credential; the loser gets `CONCURRENT_ROTATION` via P2002 | **PASS** (`test:badge` rotate suite covers the transactional invariant + DB partial unique index) |

No duplicate active credentials observed. Partial unique index
(`BadgeCredential_one_active_per_participant_uidx`, Phase 1) is the
DB-level backstop; Phase 2 service + P2002 catch converts a race to a
clean `CONCURRENT_ROTATION` error.

### 14.11 Authentication

| Item | Result | Evidence |
|------|--------|----------|
| Invalid admin credentials fail generically | **PASS** | `test:admin-login` uniform-failure suite (5 tests) — nonexistent, ACTIVE + wrong pw, DISABLED + correct pw, empty inputs all collapse to the same `GENERIC_ERROR` |
| DISABLED admin cannot login | **PASS** | `test:admin-login` "existing DISABLED admin + correct password → INVALID_CREDENTIALS" |
| Rate limiting works | **PASS** | `test:admin-login` per-email 9th attempt → THROTTLED |
| Successful login creates valid session | **PASS** | Success path in the wrapper (`app/admin/login/actions.ts`) calls `createSession → setSessionCookie → audit`; grep-locked by structural test "createSession must live AFTER the failure return" |
| Failed login creates NO session | **PASS** | Same structural test locks the ordering; behavioural test asserts throttled attempt does not resurrect via a correct password |
| Attendee login remains functional | **PASS** | `app/actions/account.ts` refactored to shared `lib/rate-limit.ts` primitives; behaviour byte-preserved; `compte-smoke.ts` renders `/compte/*` after direct-session injection (the shared path) |
| Existing logout behavior remains functional | **PASS** | `adminLogout` in `app/admin/login/actions.ts` unchanged apart from the same imports; audit `auth.logout` still fires |

### 14.12 Security regression check

| Item | Recorded status | Verified |
|------|-----------------|----------|
| WARN 1 (admin login enumeration + no rate limit) | **FIXED** (Phase 13, in-scope) | ✓ `security-reviewer` explicitly re-reviewed and recorded **RESOLVED** |
| WARN 2 (`AdminSession.token` plaintext) | **DEFERRED — MUST FIX BEFORE PRODUCTION / EVENT DEPLOYMENT** | Recorded verbatim in §16 FOLLOW-UP A; impact statement intact ("a database dump directly replays as valid admin session cookies"); status marker "Not resolved. Not downplayed." |
| WARN 3 (badge rotation IP/global rate limit) | **DEFERRED** | Recorded in §16 FOLLOW-UP B; per-participant 10s guard remains as the sole interim mitigation |

**WARN 2 and WARN 3 remain DEFERRED. Not relabeled. Not minimised.**

### 14.13 Defects fixed during Phase 14

**None.** No test exposed a defect; no code changes were made during
Phase 14 verification.

### 14.14 Production readiness status

Phase 14 verifies functional correctness of the access-control chain
against every automated test suite and every documented E2E matrix.
Explicit distinctions per the master doc's directive:

| Dimension | Status |
|-----------|--------|
| A. **Functional test status** | **PASS** — 200/200 automated tests + 14/14 attendee smoke + 7/7 admin smoke |
| B. **Security test status** | **PASS** with WARN 2 / WARN 3 outstanding as documented deferrals |
| C. **Real-device status** | **NOT TESTED** — all 10 mobile-device items owner-owned (§14.5) |
| D. **Known security debt** | WARN 2 (AdminSession token plaintext) + WARN 3 (badge rotation IP rate limit) + minor observations (open-redirect trailing-slash, sidebar RBAC UX, legacy `validateTicket` select) all documented in §16 as follow-ups |
| E. **Production blockers** | **1 mandatory pre-go-live blocker**: **WARN 2 — AdminSession token migration**. Rate-limit deployment characteristic (§Pre-Phase-14 §rate-limit) is not a blocker under single-instance deploy; for multi-instance deploy, back with Redis/Upstash before go-live. |

**This report does NOT claim "Production Ready."** WARN 2 must be
closed by a dedicated admin-auth hardening phase before the event
goes live. Real-device rows must be verified by the owner on both
Android and iOS.

### 14.15 Failures / defects during verification

**None.** All 200 automated tests passed on first run. Smoke scripts
passed cleanly on the local dev server (port 3002). No test flaked;
no test was skipped; no test was weakened.

### 14.16 Final Phase 14 status

**PHASE 14 — PASS.**

- Automated test totals: 200/200 pass; 14/14 attendee routes render; 7/7 admin route checks pass.
- Main Entrance matrix (A–L): 12/12 PASS.
- Room matrix (A–K): 11/11 PASS.
- Badge/QR matrix (13 items): 13/13 PASS.
- Access-history matrix (9 items): 9/9 PASS.
- Admin access matrix (8 items): 8/8 PASS.
- AccessPoint admin (7 items): 7/7 PASS.
- Audit integrity (13 action names): 13/13 PASS; zero rawToken / tokenHash in any AuditLog write.
- Race / concurrency (3 scenarios): 3/3 PASS.
- Authentication (7 items): 7/7 PASS.
- Security review: WARN 1 fixed; WARN 2 & WARN 3 recorded DEFERRED.
- Mobile real-device (10 items): **10/10 NOT TESTED** — owner responsibility.

**Mandatory pre-production hardening still open:**

- **WARN 2 — AdminSession token → tokenHash migration.** Non-negotiable pre-go-live.
- Rate-limit backing store for multi-instance deploy (if applicable).
- 10 real-device verification rows.

**Files intentionally NOT touched during Phase 14:** every file listed in the Phase 13 completion record. No code changed. No dependency added. No schema migration. No test weakened.

Awaiting explicit owner approval for any post-Phase-14 hardening
phase (typically covering WARN 2 remediation, real-device sign-off,
and — if applicable — Redis-backed rate limiting).

---

## 18. Phase 15 — Admin Session Token Hardening  ·  COMPLETE

Implementation date: 2026-09-19.

This phase exists exclusively to remediate the mandatory pre-production
security finding **WARN 2** flagged in Phase 13 and re-verified in
Phase 14. **Reviewer verdict: OK — WARN 2 RESOLVED.** No new WARNs.
No behavioural change to any other subsystem (Phases 11 and 12
behaviour unchanged, business rules unchanged, no schema change
outside `AdminSession`).

### 18.1 What was broken (verbatim from Phase 13 record)

`AdminSession.token` was a plaintext, `@unique` random string. A DB
dump directly replayed as an admin session cookie. Every scanner
permission gate and every mutation surface downstream of
`requirePermission(...)` depended on this table.

### 18.2 What Phase 15 did

**Target architecture (implemented):**

```
browser cookie  ────►  raw random session token (256-bit)
                              │
                              ▼
                       sha256 hash
                              │
                              ▼
                AdminSession.tokenHash   (DB-side only)
```

The raw token continues to live in the HTTP-only cookie (the server
needs SOMETHING to identify the session by). The database stores
only its irreversible hash. sha256 is one-way; a DB dump grants no
usable session cookies without a pre-image, which is infeasible
against a 256-bit CSPRNG input.

### 18.3 Schema migration

- `prisma/schema.prisma`: `AdminSession.token String @unique`
  renamed to `AdminSession.tokenHash String @unique`. All other
  fields (`id`, `userId`, `createdAt`, `expiresAt`) and the two
  indexes (`[userId]`, `[expiresAt]`) preserved byte-for-byte.
- Applied via `npm run db:push -- --accept-data-loss` after wiping
  all existing session rows (one-shot invalidation — see §18.6).
- Non-destructive to unrelated data: only `AdminSession` altered.
  `AccountSession`, `Participant`, `BadgeCredential`,
  `ParticipantAccess`, `AccessPoint`, `CheckIn`, `AuditLog`, and
  every other table untouched. Confirmed by the post-migration
  regression sweep (compte-smoke 14/14, admin-smoke 7/7, every
  test:* suite 212/212).

### 18.4 Session creation (`lib/admin/auth.ts`)

New private helper:

```ts
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
```

Mirrors `lib/account/auth.ts:hashToken` exactly. Kept private —
callers should never need to hash a token themselves; the auth
helpers always do it internally.

`createSession(userId)` now generates the raw 32-byte base64url
token, writes `{userId, tokenHash: hashToken(raw), expiresAt}`,
and returns the RAW token to the caller (which then sets the
HTTP-only cookie). The raw token never enters Prisma, logs,
AuditLog, response JSON, or HTML.

### 18.5 Session lookup

Every code path that previously did `findUnique({where: {token}})`
now does:

```
raw cookie value  →  hashToken(raw)  →  findUnique({ where: { tokenHash } })
```

Files updated:

| File | Change |
|------|--------|
| `lib/admin/auth.ts:getCurrentAdmin` | Hashes cookie value before findUnique + before the expiry-cleanup delete. |
| `lib/admin/auth.ts:invalidateSession` | Now accepts raw cookie token, hashes internally, returns `{userId} \| null` so callers can audit AFTER deletion. |
| `app/admin/login/actions.ts:adminLogout` | Uses the new `invalidateSession` return value; no plaintext `findUnique` remains. |
| `app/speaker/login/actions.ts:speakerLogout` | Same treatment. |
| `scripts/admin-smoke.mjs:openSession` (dev smoke) | Generates raw token, hashes for `AdminSession.create`, returns raw for cookie use. Cleanup deletes by `tokenHash`. |

### 18.6 One-shot session invalidation

Existing plaintext tokens cannot be hashed after the fact (we don't
know what they were as raw values from the persisted plaintext
alone — and even if we did, hashing them in place would still let
a pre-migration DB dump replay as post-migration cookies). Correct
fix: force every admin to log in again.

Before running `prisma db push --accept-data-loss`, a temporary
`scripts/_wipe-admin-sessions.mjs` script executed
`prisma.adminSession.deleteMany()` (invalidated 4 rows). The temp
script was deleted after the migration completed. **Every admin
must log in again after deploy.** Documented explicitly.

### 18.7 Cookie compatibility — preserved

The externally visible cookie contract is unchanged:

- name: `bis_admin_session`
- HTTP-only: yes
- SameSite: `lax`
- Secure: `true` in production, `false` locally
- Path: `/`
- Max-Age: 12h (`SESSION_TTL_MS = 1000 * 60 * 60 * 12`)

No second cookie introduced. No refresh-token dance. No client-side
change required. Deployment flips the schema, wipes the sessions,
admins re-authenticate normally.

### 18.8 Tests

`scripts/admin-session.test.ts` — **12 tests, 6 suites:**

- Write path: `AdminSession.tokenHash` equals `sha256(raw)`;
  `tokenHash !== raw`; sha256 shape (64 hex chars).
- Lookup by hash: raw resolves via hashed lookup; **raw cannot
  match `where: { tokenHash: raw }`** — this is the load-bearing
  test proving plaintext storage is gone; wrong token yields null.
- Invalidate: removes hashed row + returns userId; second call
  returns null (idempotent); random token returns null.
- Expired sessions: deletable via hash path.
- Structural: no `where: { token:` on any `adminSession.*` call
  under `app/**`, `lib/**`, `scripts/**`;
  `lib/admin/auth.ts` contains `hashToken` helper and ≥3 uses of
  `tokenHash`; `adminLogout` and `speakerLogout` no longer contain
  plaintext `findUnique`; no `prisma.adminSession.<op>({..., token:
  <not-Hash> ...})` call anywhere.
- Schema: `tokenHash String @unique` present; legacy `token String
  @unique` absent.

`package.json` — added `test:admin-session` script.

### 18.9 Regression verification

- `npm run typecheck` → clean.
- `npm run test:admin-session` → **12 / 12** (new).
- `npm run test:admin-login 19/19, test:main-entrance 24/24, test:room 22/22, test:scanner 26/26, test:access-admin 21/21, test:access-points 12/12, test:badge 28/28, test:rbac 31/31, test:access 5/5, test:qr 4/4, test:history 8/8` — every pre-Phase-15 suite still passes.
- `scripts/admin-smoke.mjs` → **7 / 7** (SUPER_ADMIN + CHECKIN_OPERATOR route access + VIEWER refusals + notFound cases) — this critically exercises the new hashed-cookie path end-to-end via the dev server.
- `scripts/compte-smoke.ts` → **14 / 14** attendee routes across both scenarios (attendee flow unaffected).

**Total: 212 / 212 tests pass** (+12 for Phase 15). Zero regressions.

### 18.10 Security review

**OK. No BLOCK. No new WARNs.** Reviewer explicitly confirmed:

- WARN 2 is **RESOLVED**. Raw `AdminSession.token` no longer exists;
  the DB column is dropped; every persistence path stores
  `sha256(rawToken)` as `tokenHash`.
- Session replay from a DB dump is no longer possible with the
  plaintext token — because there is no plaintext token in the DB.
- No plaintext-lookup code remains anywhere in `app/**`, `lib/**`,
  `scripts/**`.
- Logout paths (admin + speaker) correctly use the new
  `invalidateSession` helper.
- Session creation path hashes internally; returns raw only to the
  in-process caller for cookie use.
- Migration did not expose secrets and did not affect unrelated data.
- Existing cookie contract preserved.
- No new WARN introduced. WARN 1 unchanged (still RESOLVED from
  Phase 13). WARN 3 unchanged (still DEFERRED).

### 18.11 Files intentionally NOT touched in Phase 15

- Phase 11 room validator (`lib/admin/room-validator.ts`).
- Phase 12 mobile badge files (`components/compte/badge-*.tsx`,
  `components/compte/use-screen-wake-lock.ts`).
- QR rotation behaviour (`app/compte/badge/actions.ts`,
  `lib/badge/**`).
- ParticipantAccess / CheckIn / AccessPoint models.
- Scanner UX (`app/admin/(protected)/scan/**`).
- Registration / payment flow.
- Attendee auth (`lib/account/auth.ts`, `app/actions/account.ts`).
- Middleware (`middleware.ts`).
- RBAC (`lib/admin/rbac.ts`).
- Rate-limit primitives (`lib/rate-limit.ts`, `lib/client-ip.ts`).

### 18.12 Post-Phase-15 production readiness

The WARN 2 mandatory blocker is now closed. The remaining
production prerequisites (unchanged from the Phase 14 report):

1. **10 real-device mobile items (§14.5)** — owner-owned, still
   marked NOT TESTED.
2. **Rate-limit deployment topology** — `lib/rate-limit.ts` remains
   per-process. For multi-instance deploy, back with Redis/Upstash;
   for single-instance deploy this is not a blocker.
3. **Operational event-day rehearsal** — not part of code; the
   ops-side dry-run.
4. **WARN 3** (attendee badge rotation IP/global rate limit) —
   still deferred; per-participant 10 s guard remains.

**Do NOT declare the entire system "production-ready" solely
because Phase 15 passed.** The three items above are separate
approvals.

---

## 19. Phase 16 — QR Operations UI/UX  ·  COMPLETE

Implementation date: 2026-09-19.

Pure UI/UX phase. Adds the operational front-end around the existing
Phase 9–15 access-control system. **No business rules changed. No
new permission strings. No Prisma schema change.** Every mutation
surface downstream is untouched from earlier phases.

### 19.1 Routes created

| Route | Purpose | Auth gate |
|-------|---------|-----------|
| `/admin/scan` | QR Operations Center hub — lists every AccessPoint from the DB with permission-aware CTAs. | `checkin.view` |
| `/admin/scan/history` | Global scan history — CheckIn-based, filters by date range / access point / result / operator / participant search. Bounded server query. | `checkin.view` |

### 19.2 Routes redesigned (UX polish only)

| Route | Change |
|-------|--------|
| `/admin/scan/[access-point-slug]` | Added `← Centre de scan` back link. Layout unchanged; transport logic (`html5-qrcode`, permission chain, active check, raw-credential discipline) preserved byte-for-byte. |
| `/admin/registrants/[id]` | "Historique de check-in" section renamed to **"Historique des accès"** and now renders `AccessPoint.name` + type when available (via a whitelist join on `getRegistrant`). Falls back to legacy `gate` string for pre-Phase-1 rows. Still iterates `r.checkIns` — never `ParticipantAccess`. |
| `/admin/access-points` | Each row gained inline links: `Ouvrir le scanner →` (disabled state when inactive) and `Voir l'historique →` (deep-links to the new history page with `accessPointId` pre-filtered). |

### 19.3 Components created

| File | Purpose |
|------|---------|
| `app/admin/(protected)/scan/page.tsx` | Server component. Hub listing MAIN + ROOM points from `getAccessPointsWithUsage()`. Per-card `PointCard` disabled when inactive OR when operator lacks the type-derived scan permission. |
| `app/admin/(protected)/scan/history/page.tsx` | Server component. Reads `getScanHistory(filters)` with bounded row cap. Query-parameter hygiene: `from`/`to` ISO-date regex; `result` allow-listed; `accessPointId`/`operatorId` size-capped; `q` trimmed + length-bounded 2..80. Row limit 50 default, hard max 200 — NEVER read from the URL. |
| `app/admin/(protected)/scan/history/history-filters.tsx` | Client component. Composes a URL query string and `router.push`es; server re-renders. No JSON API. No client-side data fetching. No server-only imports. |
| `lib/admin/scan-history-query.ts` | `server-only` read helper. Whitelist projection (`id, scannedAt, result, reason, gate, accessPoint{id,slug,name,type}, participant{id,firstName,lastName,tier}, operator{id,name,email}`). Explicitly excludes `tokenHash`, `rawToken`, `passwordHash`, `paymentAmount`, `paymentRef`, `checkedInGate`, and other sensitive fields. |
| `scripts/admin-scan.test.ts` | 18 tests — behavioural (filter scoping, whitelist verification, length bounds, take-clamping) + structural (auth gate presence, no client-side auth logic, no rawToken leakage, no hardcoded slug map, ID-not-rendered-as-text). |

### 19.4 Existing backend contracts reused

- `requirePermission("checkin.view")` — existing gate; no new permission.
- `getAccessPointsWithUsage()` (Phase 8 helper) — DB-driven; no hardcoded slugs.
- `getRegistrant(id)` (existing helper) — extended with a whitelist `accessPoint` join on the `checkIns` include; unrelated fields unchanged.
- `StatusBadge`, `EmptyState`, `AdminHeader` — existing design-system primitives.
- Phase 9 `ScannerClient` — untouched; still owns the `html5-qrcode` transport, camera lifecycle, submit-to-server-action.
- Phase 10/11 validators (`validateMainEntranceQrCore`, `validateRoomQrCore`) — untouched. Neither new page imports or calls them.
- Phase 8 slug/type/active semantics — untouched.
- Phase 12 mobile badge — untouched.
- Phase 15 admin session token hashing — untouched.

### 19.5 Sidebar navigation

`components/admin/sidebar.tsx` gained two entries under the **Attendees** group:

- **Centre de scan** → `/admin/scan` (gated at `checkin.view` for visibility).
- **Historique de scan** → `/admin/scan/history` (same gate).

Sidebar visibility is UX only. Every route enforces its own `requirePermission("checkin.view")` server-side.

### 19.6 Scan result UI

The `ScannerClient` component from Phase 9/10/11 already renders the full result contract (VALID / ALREADY_CHECKED_IN / UNPAID / CANCELLED / PA_REVOKED / PA_NOT_GRANTED / BADGE_INVALID / BADGE_REVOKED / BADGE_EXPIRED / ACCESS_POINT_INACTIVE / ACCESS_POINT_WRONG_TYPE / ACCESS_POINT_UNKNOWN) via `OUTCOME_TONE` + `OUTCOME_TITLE` maps. Phase 16 did NOT modify these — the shipped result UI already meets the phase brief's §7 requirements.

### 19.7 History UI

- Row summary: date+time, participant name, AccessPoint name, `StatusBadge` result, expand chevron.
- Expandable detail (via native `<details>`): AccessPoint + type; operator name; internal reason code; link to the participant fiche.
- Legacy CheckIn rows (`accessPoint === null`) fall back to the `gate` string with a "Point non répertorié (historique legacy)" italic label — never fabricated.
- Empty state via `EmptyState` primitive.
- No pagination beyond the server-enforced cap. A refined pagination UX is a documented future consideration but not required by the phase brief.

### 19.8 AccessPoint integration

- Each row on `/admin/access-points` links to the scanner (`Ouvrir le scanner`) and to the pre-filtered history (`Voir l'historique`). Inactive points display a disabled scanner label.
- The AccessPoint admin surface (Phase 8) is untouched — no new mutation, no schema change, no permission change.

### 19.9 Registrant history integration

- `getRegistrant(id)` extended with whitelist `accessPoint { slug, name, type, active }` on the `checkIns` include. No new sensitive fields.
- Section renamed `Historique de check-in → Historique des accès`.
- Renders `AccessPoint.name` + type pill when the join resolves; falls back to legacy `gate` string otherwise.
- Continues to iterate `r.checkIns` — structural test locks that `ParticipantAccess` is never rendered as history.

### 19.10 Tests

`scripts/admin-scan.test.ts` — **18 tests, 2 suites:**

- Behavioural (9): no-filter fixture scoping, `accessPointId` filter, `result=UNKNOWN` filter, `operatorId` filter, `q` filter case-insensitive match, `q` single-char ignored (no injection), date range filter, `take` clamped to 200, whitelist projection excludes sensitive fields.
- Structural (9): hub `requirePermission("checkin.view")`, history same gate, hub not client-side auth, hub loads AP from DB (no hardcoded slugs), history filter form is a client component with no server-only imports, history page does not render internal IDs as free text, history page does not accept `raw.take` / `raw.limit` / `raw.pageSize`, registrant history iterates `r.checkIns` (not `ParticipantAccess`), scanner-client no rawToken leakage regression.

### 19.11 Regression verification

- `npm run typecheck` → clean.
- `npm run test:admin-scan` → **18 / 18** (new).
- Every pre-Phase-16 suite: **212 / 212** unchanged.
- **Total: 230 / 230 tests pass. Zero regressions.**
- `scripts/admin-smoke.mjs` → 7/7 admin routes on dev server.
- `scripts/compte-smoke.ts` → 14/14 attendee routes.
- Dev-server Phase 16 smoke:
  - `SUPER_ADMIN /admin/scan` → 200, renders `Centre de scan` header.
  - `SUPER_ADMIN /admin/scan/history` → 200, renders `Historique des scans`.
  - `VIEWER /admin/scan` → 307 `?denied=checkin.view`.

### 19.12 Security review

**OK. No BLOCK. No new WARNs.** Reviewer explicitly confirmed all 11 focused checks pass:

- Client-side authorization bypass: none. Every server component opens with `requirePermission("checkin.view")`.
- New permission bypass: none. No new permission string.
- Raw QR leakage: none. Phase 9 raw-credential discipline preserved.
- tokenHash leakage: none. Whitelist projection.
- IDOR in history: none. No participantId URL scoping; audience is authorized.
- Cross-participant leakage: none. Whitelist select.
- Cross-access-point leakage: none. `accessPointId` is an equality filter only.
- Sensitive fields: none exposed. Test-locked.
- Existing validation actions: unchanged. Neither new page imports Phase 10/11 validators.
- SQL / XSS: none. Prisma parameterization; no `dangerouslySetInnerHTML`.
- Query-parameter hygiene: strict. `pickDate` regex-anchored; `pickResult` allow-listed; length caps everywhere; `take` never read from URL.

WARN 1, WARN 2 statuses unchanged (both RESOLVED). WARN 3 unchanged (still DEFERRED).

### 19.13 Files intentionally NOT touched

- Phase 10/11 validators (`lib/admin/main-entrance-validator.ts`, `lib/admin/room-validator.ts`).
- Phase 12 mobile badge (`components/compte/badge-*.tsx`, `components/compte/use-screen-wake-lock.ts`).
- Phase 15 admin auth (`lib/admin/auth.ts`, `lib/admin/login-service.ts`).
- `prisma/schema.prisma` — no schema change.
- `lib/admin/rbac.ts` — no permission change.
- `middleware.ts`, `lib/db.ts` — unchanged.
- Attendee side (`/compte/**`, `lib/account/**`, `app/actions/account.ts`) — unchanged.
- Phase 9 scanner transport (`scanner-client.tsx`) — unchanged. Only `page.tsx` gained a back link.
- Phase 10/11 result contract (`action-types.ts`) — unchanged.

### 19.14 Deferred UX decisions

- **Pagination for `/admin/scan/history`** — current implementation caps at 50 rows. For a multi-day event with heavy scan volume, a "load more" or explicit pagination would help. Non-blocking; the server helper already supports a bounded `take` argument (max 200).
- **Real-time refresh on the scan hub / history** — no WebSocket / SSE / polling loop. The phase brief §18 explicitly banned realtime infrastructure. Operators can refresh the page manually.
- **CSV / export of history** — not implemented. Deferred to a future reporting phase.
- **Drawer/modal detail** — current implementation uses native `<details>` expandable rows for keyboard accessibility + zero JS complexity. A richer drawer UI is deferred.
- **Search UX (typeahead)** — the free-text `q` filter submits on form submit only, not as-you-type. Deferred to avoid a debounce/loading complexity that's not required by the brief.

### 19.15 Real-device / browser checks still required

- **Camera at each access point** — Phase 12 §14.5 real-device items remain owner-owned and NOT TESTED.
- **Landscape tablet layout** — hub + history responsive checks on iPad-class devices.
- **Print/export flow** — not part of Phase 16, no export shipped.

These items are not defects and do not block Phase 16 completion.

---

## 17.b Phase 14 — original spec  ·  ARCHIVED

The original spec for this phase is preserved below for reference.

Execute the following test matrix at minimum. Each row must be executed
against the live system; automated tests exist where practical, otherwise
manual verification is documented.

1. Account creation.
2. Registration.
3. Badge issuance (auto or on-demand — decide during Phase 5).
4. QR verification (valid).
5. Invalid QR rejected.
6. Revoked QR rejected.
7. Expired QR rejected.
8. Main entrance allowed.
9. Main entrance denied (unpaid / cancelled).
10. Duplicate main-entrance scan → `ALREADY_CHECKED_IN` with prior
    timestamp; no duplicate row.
11. Room 01 allowed (with permission).
12. Room 01 denied (without permission).
13. Independent room permissions (allow 1+3, deny 2+4).
14. Admin grants access.
15. Admin revokes access.
16. Unauthorized admin (VIEWER) denied on grant/revoke.
17. Attendee attempts to modify their own permissions → server denies.
18. Concurrent scans at same room resolve consistently.
19. Credential rotation.
20. Old credential rejected after rotation.
21. New credential accepted after rotation.
22. Audit rows exist for every mutation surface.
23. Mobile QR scannable in a real phone browser.
24. Print badge produces a usable PDF via Ctrl+P.
25. Existing manual `/admin/check-in` continues to work end-to-end.

### Exit criteria

- Every row above documented as PASS / FAIL / NOT APPLICABLE with a
  short note.
- Report — STOP.

---

## 18. Security Principles (non-negotiable)

- **Server is the source of truth.** The frontend never decides `allowed =
  true`.
- **The QR never contains authorization data.** Opaque random token only.
- **Participants cannot modify access permissions.** Enforced server-side.
- **Scanners cannot override authorization.** Every scan re-validates.
- **Access point is server-controlled.** Determined by trusted config /
  URL slug, not user input the operator can edit.
- **Admin permission changes are audited.** Every grant, revoke, rotate.
- **Revocation is immediate.** No client caching that could keep a revoked
  credential alive.
- **Raw QR tokens are never stored or logged.** Only sha256 hash in DB;
  raw token exists in memory only long enough to render the QR.

---

## 19. Backwards Compatibility

The following must continue to work end-to-end throughout all phases:

- `/admin/check-in` — existing dashboard and manual code flow.
- `validateTicket(code, gate)` — existing signature and behavior.
- `Participant.ticketCode` — remains and continues to be admin-editable.
- `Participant.gate` — remains as a string field.
- `Participant.checkedInAt`, `Participant.checkedInGate` — remain.
- Existing `CheckIn` rows (with `accessPointId = null`) remain valid and
  visible in admin history.
- Existing authentication (`AccountUser`, `AdminUser`, both cookies).
- Existing RBAC — no permission removed, no role restricted.
- Existing admin registrant detail page — extended, not replaced.

Legacy functionality is removed only with explicit user approval.

---

## 20. BIS Design System

The entire UI must live inside the existing BIS identity.

### Colors

- Frost White `#F8FAF9`
- White `#FFFFFF`
- Ink Navy `#111827`
- Cobalt Blue `#2453E0`
- Electric Lime `#B8E62E`

Also present in `tailwind.config.ts`: `line #E6E8ED`, `navy` (dark variant).

### Typography

- Alexandria (display + brand).

### Existing primitives to reuse

- `KpiCard`, `StatusBadge`, `TierBadge`, `EmptyState` (from
  `components/admin/ui.tsx`).
- `FormField`, `TextInput`, `TextArea`, `Select`, `SubmitButton` (from
  `components/forms/primitives.tsx`).
- `cn()` (from `lib/utils.ts`).

### Motion

Existing conventions: 250–500ms subtle transitions. Do not accelerate or
add dramatic effects.

### Avoid

- Generic SaaS dashboard styling.
- Excessive gradients.
- Random neon colors outside the BIS palette.
- Gaming-style UI.
- Excessive glassmorphism.

### Global header

**Do not redesign the global header.** Keep it exactly as it is unless the
user explicitly asks for a change.

### Badge feel

Official international summit credential. Precise typography, controlled
Cobalt fields, restrained Lime accent, strong hierarchy, generous whitespace.

---

## 21. Database Principles

### Relationships

```
Participant
    │
    ├── credentials : BadgeCredential[]        (history + one ACTIVE)
    │       └── checkIns : CheckIn[]           (via credentialId)
    │
    ├── accessPermissions : ParticipantAccess[]
    │       └── accessPoint : AccessPoint
    │
    └── checkIns : CheckIn[]                    (all scan attempts)
             └── accessPoint : AccessPoint     (nullable — legacy = null)
```

### Invariants

- One ACTIVE `BadgeCredential` per participant (partial unique index +
  service enforcement).
- Rotation preserves history via `rotatedFromId`.
- `ParticipantAccess` is independent per (participant, AccessPoint).
- `CheckIn` retains backwards-compatible `gate` string.
- Historical `CheckIn` rows are never destroyed by application code
  (schema `SetNull` cascades preserve them if their FK targets vanish).
- Deleting a `Participant` cascades to their `BadgeCredential` and
  `ParticipantAccess` rows (by design) — grant/revoke facts also live in
  `AuditLog` for durability.

---

## 22. Development Rule

**This is the critical governance rule for the entire project.**

Never automatically continue to the next phase.

At the end of every phase:

1. Implement only that phase.
2. Run the relevant tests.
3. Run `npm run typecheck`.
4. Run `npx prisma validate` when applicable (schema touched).
5. Run the `security-reviewer` subagent whenever `CLAUDE.md` requires it
   (edits under `app/admin/**`, `app/actions/**`, `lib/admin/**`,
   `prisma/**`, `middleware.ts`, or new dependencies in `package.json`).
6. Report the exact files changed.
7. Report test outcomes.
8. Report security-review outcome.
9. Report any remaining warnings or open decisions.
10. **STOP.**

Wait for the user's explicit `GO` (or equivalent explicit approval) before
starting the next phase.

---

## 23. Change Control

If implementation reveals a requirement that is not documented — for
example, whether rooms allow re-entry, or whether the main entrance
implicitly grants any rooms, or whether the QR should encode an event id —

**Do not silently invent a business rule.**

Stop, and report:

- What was discovered.
- Why it matters (security, correctness, backwards compatibility).
- 2–3 concrete options.
- A recommendation with the main tradeoff.

Wait for user approval before proceeding. This applies especially when the
decision changes access rules, permission scopes, or credential lifecycle
behavior.

---

## 24. Current Decisions (approved)

- `/compte` is the canonical account route. No `/account` duplicate.
- No automatic room permissions. Room access is explicitly granted by
  authorized administrators.
- QR uses opaque random credentials generated by
  `crypto.randomBytes(32).toString("base64url")`.
- QR is **not** a JWT.
- Raw QR tokens are never stored.
- SHA-256 hex hash of the raw token is stored in `BadgeCredential.tokenHash`.
- Badge credentials support rotation with history via `rotatedFromId`.
- Exactly one ACTIVE credential per participant.
- Existing manual ticket check-in remains.
- Participant photo upload is deferred; initials-in-Cobalt-disc used in
  the badge.
- Browser print (Ctrl+P) is the badge print flow. No server-side PDF.
- Existing auth systems (`AccountUser`, `AdminUser`) remain untouched.
- Existing email infrastructure remains reusable, no parallel mailer.
- Existing `AuditLog` is reused for every lifecycle event.
- No parallel admin system.
- No parallel registration system.

---

## 25. Deferred Items

Intentionally out of scope unless explicitly requested later:

- Real participant photo upload.
- Blob / object storage.
- Production scanner hardware integration.
- Offline scanner mode.
- Additional `AccessPointType` values beyond `MAIN_ENTRANCE` and `ROOM`.
- Advanced venue analytics dashboards.
- Production-scale rate limiting beyond what the existing `app/actions`
  files already implement.
- Any additional item discovered during a phase — must be logged here
  before it is skipped.

---

## 26. Document Maintenance

After every completed phase, update this file with:

- Phase status (`NOT STARTED` → `IN PROGRESS` → `COMPLETE`).
- Implementation date (YYYY-MM-DD).
- Files changed.
- Test outcomes.
- Security-review outcome (`OK` / `WARN` with notes / `BLOCK` if
  resolved).
- Decisions made during the phase.
- Remaining issues / tech-debt.

**Do not rewrite historical information incorrectly.** Completed-phase
records are append-only.
