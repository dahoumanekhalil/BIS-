# BIS 2027 — Registration Architecture

Living design contract for the role-based registration flow.
Applies as of Commit 1 (Visitor + Speaker foundation).

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
* When an AccountUser hits `/register/*`, `lib/onboarding.getOnboardingStatus`
  reuses or creates their Participant exactly once.

## Participant status (`RegistrationStatus`)

Additive migration:

```
PENDING     (deprecated — kept transiently for backward compatibility)
REGISTERED  ← new; default for new Participants
CONFIRMED
CANCELLED
```

Semantics:

* `REGISTERED` — the person successfully completed event registration.
  Set at Participant creation.
* `CONFIRMED` — the person is confirmed to attend the event (manual admin
  transition; distinct signal, not automated).
* `CANCELLED` — event registration was cancelled.

Payment is **not** a prerequisite for `REGISTERED`.
Application approval is **not** a prerequisite for `REGISTERED`.

Migration strategy:

1. Schema adds `REGISTERED` without removing `PENDING`.
2. `scripts/migrate-pending-to-registered.ts` — one-shot data migration
   `UPDATE "Participant" SET status='REGISTERED' WHERE status='PENDING'`.
   Idempotent, reversible with the mirror script.
3. New code writes `REGISTERED`; no new code writes `PENDING`.
4. Admin dashboard's "en attente de confirmation" count now reads
   `REGISTERED` (unchanged UI label; same operational meaning).
5. `PENDING` value stays in the enum until a follow-up commit confirms
   zero live rows carry it and no analytics query still references it.

## Participation opportunities

One Participant may hold multiple opportunities on the same event:

```
AccountUser
  └── Participant
      ├── participationChoice = VISITOR      (direct)
      ├── Application(SPEAKER, RECEIVED)     (professional)
      ├── Application(SPONSOR, …)            (Commit 2)
      └── Application(CONTENT_CREATOR, …)    (Commit 2)
```

* Visitor participation is signalled by `Participant.participationChoice = VISITOR`.
* Professional roles create an `Application` row; the same
  `@@unique([participantId, type])` prevents duplicate applications.
* A returning user can add another opportunity from `/compte` without
  creating a second Participant or AccountUser.

## Badge / QR

* Every `REGISTERED` (or `CONFIRMED`) Participant is entitled to a badge.
* Badge issuance is **not** gated by payment.
* Registration flow eagerly calls `issueBadgeCredential(participantId)`;
  a subsequent visit to `/compte/badge` rotates and displays the QR
  (rotation returns a fresh raw token — the stored hash never leaves
  the DB, so first-view rotation is the honest cost of "no raw token
  at rest").
* Badge security model is unchanged: only `sha256(rawToken)` is stored;
  a partial unique index enforces one ACTIVE credential per Participant;
  QR encodes only the raw token.

## Payment

* Payment is **out of scope** for registration.
* `Participant.paymentStatus`, `paymentAmount`, `paymentRef`, `paidAt` and
  the room payment infrastructure (`RoomRegistration`, `RoomPaymentEvent`)
  are preserved for future use.
* Removed only the `paymentStatus === PAID` gate on the badge surface.

## Rooms / accommodation

Untouched. `RoomRegistration`, `ParticipantAccess`, `RoomPaymentEvent`
remain as they were. Room registration is a distinct, post-registration
service accessible from `/compte/acces`.

## Legacy anonymous Participants

Before this refactor, `/register` could create a Participant without an
AccountUser. Those rows have `accountUserId = NULL`.

Claim mechanism:

1. A user signs up an AccountUser with an email that matches an anonymous
   Participant.
2. Signup succeeds — the AccountUser is created. **No auto-linking on
   email alone.** `getOnboardingStatus` returns `kind: "conflict"` and
   the UI explains the situation.
3. A verification email is sent (existing `EmailVerificationToken`).
4. On verification link click, `consumeEmailVerificationToken` atomically:
   * marks the AccountUser as email-verified,
   * finds any anonymous Participant with the same email that is not yet
     bound (`accountUserId IS NULL`) via a `WHERE accountUserId IS NULL`
     `updateMany`, and binds it to the new AccountUser.
   * The `updateMany` with `count` semantics is race-safe — a second
     concurrent claim sees `count = 0` and does nothing.
5. Emails do not disclose whether a claim happened. The audit log records
   `participant.claim` with the participantId and userId.

Guardrails:

* Never trust a client-supplied `participantId`.
* Never bind on email equality alone from an unauthenticated request.
* An already-bound Participant (`accountUserId IS NOT NULL`) cannot be
  taken over.
* Claim is idempotent and race-safe via the `updateMany` predicate.
* Auditable — `participant.claim` in `AuditLog`.

## Routes

```
/register                 role selector (Visitor / Speaker / Sponsor / Partner / Creator)
/register/visitor         Visitor flow (Commit 1)
/register/speaker         Speaker flow (Commit 1)
/register/sponsor         Sponsor flow (Commit 2)
/register/partner         Partner flow (Commit 2)
/register/content-creator Content-creator flow (Commit 2)
/register/complete        Success page (all roles)

/auth                     login/register tabs
/auth?mode=login          login
/auth?mode=register       account creation
/auth/register            → 308 redirect → /register
/auth/mot-de-passe-oublie forgot password
/auth/mot-de-passe-reset  password reset
/auth/verifier-email      email verification confirmation
```

`/register/participation` and `/register/[slug]` for sponsor / partner /
content-creator remain reachable in Commit 1 (backward-compat for
deep links); the role selector no longer routes to them. Commit 2
replaces them with dedicated flows.

## Returning users

* Registration is persistent. A user who closes the browser can log in
  later at `/auth?mode=login`, land on `/compte`, and see badge +
  applications.
* `OnboardingSession` (45-min cookie) is optional wizard state, not the
  source of truth for whether someone is registered.
* No 45-minute dead-end. If a session expires, the user just logs in.

## Idempotency

Enforced at the DB layer:

| Row               | Uniqueness                                      |
|-------------------|-------------------------------------------------|
| AccountUser       | `email @unique`                                 |
| Participant       | `@@unique([eventId, email])`                    |
| Application       | `@@unique([participantId, type])`               |
| BadgeCredential   | partial unique on `(participantId) WHERE ACTIVE` |

Server actions treat `P2002` as "the other request won"; they resume
against the winning row rather than surfacing an error.

## Mobile app compatibility

Every identity + credential surface consumed by the future mobile
application already lives on `AccountUser` + `Participant` +
`BadgeCredential`. No web-only tables are added by this refactor.
