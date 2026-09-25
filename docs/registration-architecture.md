# BIS 2027 — Registration Architecture

Living design contract for the role-based registration flow.
Complete as of Commit 2 (all five roles + legacy retirement).

## Invariant

```
ONE PERSON
   → ONE AccountUser         (authentication identity)
   → ONE Participant         (per event; the event record)
   → REGISTERED / CONFIRMED / CANCELLED
   → ONE OR MORE PARTICIPATION OPPORTUNITIES
   → BadgeCredential + QR
```

There is **one** account per person, **one** Participant per (person × event),
and possibly **many** participation opportunities on that same Participant
(Visitor participation + zero or more Applications).

No per-role user tables. No per-role accounts.

## AccountUser

* Public authentication identity. Distinct from `AdminUser`.
* Created during registration (or opened via `/auth`).
* One row per person (`AccountUser.email` unique globally).
* Password hashed via `lib/admin/password`.
* Email verification is issued at signup; the account is usable before
  verification, but the verification link is what performs the legacy
  Participant claim (see below).
* If the email already belongs to an `AccountUser`, the registration flow
  refuses to create a second account. The user is told to **log in** or
  **reset password**; the app never silently signs the user in.

## Participant

* One `Participant` per (`eventId`, `email`) — enforced by DB
  `@@unique([eventId, email])`.
* Bound to an AccountUser via `Participant.accountUserId` (nullable for
  legacy anonymous rows only).
* Created inside the role-specific registration flow, only after the
  AccountUser is authenticated. Duplicate prevention:
  * DB uniqueness `(eventId, email)`
  * Lookup by `accountUserId` before insert
  * `P2002` catch on write treats a race as "row already there".
* All five role flows funnel through
  `lib/register/participant.ts::ensureParticipantForAccount` — the
  single seam that reuses or creates the Participant.

## Participant status (`RegistrationStatus`)

Values:

```
PENDING     (deprecated — kept transiently for backward compatibility)
REGISTERED  ← default for new Participants
CONFIRMED
CANCELLED
```

Semantics:

* `REGISTERED` — the person successfully completed event registration.
  Set at Participant creation.
* `CONFIRMED` — the person is confirmed to attend the event (manual admin
  transition; distinct signal, not automated).
* `CANCELLED` — event registration was cancelled.

**Never downgrade `CONFIRMED` → `REGISTERED`.** Never resurrect
`CANCELLED`. The kernel in `lib/register/professional-action.ts` enforces
this via `updateMany where status in ("PENDING","REGISTERED")`.

Payment is **not** a prerequisite for `REGISTERED`.
Application approval is **not** a prerequisite for `REGISTERED`.

Migration strategy (Commit 1):

1. Schema adds `REGISTERED` without removing `PENDING`.
2. `scripts/migrate-pending-to-registered.ts` — one-shot data migration
   `UPDATE "Participant" SET status='REGISTERED' WHERE status='PENDING'`.
   Idempotent, reversible with `scripts/rollback-registered-to-pending.ts`.
3. New code writes `REGISTERED`; no new code writes `PENDING` (seed
   included).
4. Admin dashboard's "en attente de confirmation" count reads both
   `REGISTERED` and legacy `PENDING` for the transition window.
5. `PENDING` value stays in the enum until a follow-up commit confirms
   zero live rows carry it.

## Participation opportunities

One Participant may hold multiple opportunities on the same event:

```
AccountUser
  └── Participant
      ├── participationChoice = VISITOR       (direct)
      ├── Application(SPEAKER, RECEIVED)      (professional)
      ├── Application(SPONSOR, RECEIVED)
      ├── Application(PARTNER, RECEIVED)
      └── Application(CONTENT_CREATOR, RECEIVED)
```

* Visitor participation is signalled by `Participant.participationChoice = VISITOR`.
* Professional roles create an `Application` row; `@@unique([participantId, type])`
  prevents duplicate applications.
* A returning user adds another opportunity from `/compte`
  ("Ajouter une candidature") without creating a second Participant or
  AccountUser.
* `participationChoice` records the *first* professional intent (or
  VISITOR); it is never overwritten. The authoritative signal for
  professional participation is the `Application` row.

## Routes

```
/register                       role selector (5 cards, all active)
/register/visitor               Visitor flow
/register/speaker               Speaker flow
/register/sponsor               Sponsor flow
/register/partner               Partner flow
/register/content-creator       Content creator flow
/register/complete              Success page (all roles)

/register/participation         → 308 → /register    (legacy compat)
/auth/register                  → 308 → /register    (legacy compat)

/auth                           login/register tabs
/auth?mode=login                login
/auth?mode=register             account creation
/auth?next=<safe-path>          post-auth redirect (whitelist-validated)
/auth/mot-de-passe-oublie       forgot password
/auth/mot-de-passe-reset        password reset
/auth/verifier-email            email verification landing
```

The dynamic `app/register/[slug]` route is **deleted**. Unknown
`/register/<something>` now returns 404 — no open-redirect surface.

## Role flow contract

All five flows share the same server-side kernel
(`lib/register/professional-action.ts::submitProfessionalApplication` for
the four professional roles; visitor has its own action that stays
directly on the same helpers because it does not create an Application).

For every role:

1. `getCurrentAccount()` — no client-supplied identity is ever trusted.
2. Per-account rate limit via `lib/rate-limit.ts`
   (`register-<slug>:acct:<userId>`).
3. `ensureParticipantForAccount(account)` — reuse or create the
   AccountUser-bound Participant.
4. Contact fields (phone / country) — collected once, back-filled with
   NULL-guarded `updateMany`.
5. Professional roles: create `Application` inside a transaction with
   the DB `@@unique([participantId, type])` as the authoritative
   duplicate guard (P2002 catch redirects to success on race).
6. Stamp `participationChoice` only if currently NULL (never overwrites).
7. Stamp `status = REGISTERED` only from `PENDING`/`REGISTERED` (never
   `CONFIRMED → REGISTERED`, never resurrect `CANCELLED`).
8. `ensureActiveBadge(participantId)` — idempotent, non-fatal.
9. Queue role-specific email via
   `idempotencyKey = application:<participantId>:<type>` (visitor
   uses `visitor-registered:<participantId>`).
10. Redirect to `/register/complete?type=<slug>`.

## Badge / QR

* Every `REGISTERED` (or `CONFIRMED`) Participant is entitled to a badge.
* Badge issuance is **not** gated by payment.
* `ensureActiveBadge` eagerly issues on registration; `/compte/badge`
  rotates on demand and returns the fresh raw token (only the sha256
  hash lives at rest).
* Badge security model unchanged: partial unique index on
  `(participantId) WHERE status='ACTIVE'`; QR encodes only the raw token.

## Payment

* Payment is **out of scope** for registration.
* `Participant.paymentStatus`, `paymentAmount`, `paymentRef`, `paidAt` and
  the room payment infrastructure (`RoomRegistration`, `RoomPaymentEvent`)
  are preserved for future use.
* No payment gate on the badge surface.

## Rooms / accommodation

Untouched. `RoomRegistration`, `ParticipantAccess`, `RoomPaymentEvent`
remain. Room registration is a distinct, post-registration service
accessible from `/compte/acces`.

## Legacy anonymous Participants — claim

Rows with `accountUserId = NULL` may exist from pre-refactor demo data.

1. A user signs up an AccountUser with an email that matches an anonymous
   Participant.
2. Signup succeeds — the AccountUser is created. **No auto-linking on
   email alone.** `ensureParticipantForAccount` returns `kind: "conflict"`
   and the UI shows a conflict screen.
3. A verification email is sent (existing `EmailVerificationToken`).
4. On verification link click, `consumeEmailVerificationToken` atomically:
   * marks the AccountUser as email-verified,
   * `updateMany where { email: { equals, mode: "insensitive" }, accountUserId: null }`
     binds any anonymous Participant sharing the canonical email to
     this AccountUser (Commit 1 §6.10 + Commit 1 review-gate hardening).
5. The audit log records `participant.claim` with the count and userId.

Guardrails:

* Never trust a client-supplied `participantId`.
* Never bind on email equality alone from an unauthenticated request.
* An already-bound Participant (`accountUserId IS NOT NULL`) cannot be
  taken over.
* Case-insensitive Postgres match handles legacy imports that skipped
  Zod normalization.

## Legacy routes — retirement (Commit 2)

Removed:

| Path                                    | State                          |
|-----------------------------------------|--------------------------------|
| `app/register/[slug]/*` (dynamic)       | **Deleted**                    |
| `app/register/participation/*`          | **Redirect** (308 → /register) |
| `app/actions/onboarding.ts`             | **Deleted**                    |
| `components/forms/basic-registration-form.tsx` | **Deleted**             |
| `components/forms/primitives.tsx`       | **Deleted**                    |
| `components/forms/selection-cards.tsx`  | **Deleted**                    |

Retained (still used by `/register/complete` or unrelated code):

| Path                                    | Consumer                      |
|-----------------------------------------|-------------------------------|
| `components/forms/form-progress.tsx`    | `/register/complete`          |
| `components/forms/form-shell.tsx`       | `/register/complete`          |
| `components/forms/submission-state.tsx` | `/register/complete`          |
| `components/forms/onboarding-conflict-screen.tsx` | role pages          |

## OnboardingSession — final state

The 45-min cookie wizard is gone. `lib/onboarding.ts` retains only
`endOnboardingSession()` — a defensive cleanup called by `logoutAccount`
so any pre-Commit-2 `bis_reg_session` cookie carried by a mid-flow
transition-window user is cleared. Once 45 minutes have elapsed after
the Commit 2 deploy, no live cookie exists; the DB `OnboardingSession`
model can be dropped in a follow-up commit (deferred here to avoid a
destructive schema change while the transition window is live).

## Returning users

* Registration is persistent. A user logs in at `/auth?mode=login`, lands
  on `/compte`, sees badge + application list + remaining opportunities.
* No `OnboardingSession` cookie is required for any operation.

## Idempotency

Enforced at the DB layer:

| Row               | Uniqueness                                       |
|-------------------|--------------------------------------------------|
| AccountUser       | `email @unique`                                  |
| Participant       | `@@unique([eventId, email])`                     |
| Application       | `@@unique([participantId, type])`                |
| BadgeCredential   | partial unique on `(participantId) WHERE ACTIVE` |

Server actions treat `P2002` as "the other request won"; they resume
against the winning row rather than surfacing an error.

## Mobile app compatibility

Every identity + credential surface consumed by the future mobile
application already lives on `AccountUser` + `Participant` +
`BadgeCredential`. No web-only tables are added by this refactor.
