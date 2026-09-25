# BIS 2027 — Attendee Registration Deep Audit (Read-Only)

**Scope:** Full technical map of the registration system as it exists in the current codebase.
**Method:** Read-only inspection of source files, Prisma schema, server actions, cookies, and DB relationships. No changes made.
**Date of audit:** 2026-09-24

> **Note (2026-09-25):** This audit predates the payment-removal work.
> Any reference below to `Participant.paymentStatus`, `paymentAmount`,
> `paymentRef`, `paidAt`, `AdmissionMode`, `RoomPaymentEvent`,
> paid/free room admission, `payment.confirm.room` /
> `payment.refund.room`, or `revenue.view` / `revenue.reconcile`
> reflects the schema and RBAC as they existed BEFORE the removal.
> The final architecture is documented in
> `docs/payment-removal-final.md` — BIS 2027 is FREE-only. This
> file is retained as a historical snapshot of the registration flow
> and is otherwise unchanged.

---

## 1. Chronological User Journey

### 1.1 `/auth?mode=register` — Account Signup

| Aspect | Details |
|---|---|
| **File** | `app/auth/page.tsx` → mounts `components/auth/auth-experience.tsx` (`initialMode="register"`) |
| **User sees** | Two-tab component (Register/Login). Register tab shows fields for personal identity + password + terms consent. |
| **Fields requested** | `firstName`, `lastName`, `email`, `password`, `confirm`, `consent` |
| **Validation** | `accountRegisterSchema` in `lib/validations.ts:54` — firstName/lastName 2-80 chars, email lowercased/regex, password min 8, `confirm` must equal `password`, `consent` must be `true` |
| **Handler** | Server action `registerAccount()` in `app/actions/account.ts:45` |
| **DB writes** | 1) `AccountUser` (INSERT). 2) `EmailVerificationToken` (INSERT). 3) `AccountSession` (INSERT). 4) `EmailMessage` (queued via `sendVerificationEmail`). |
| **Cookies** | Sets `bis_account_session` (HttpOnly, SameSite=lax, 30-day TTL because `persistent=true` is hardcoded on line 124) |
| **Redirect after** | No explicit redirect in `registerAccount()` — returns `{ok:true}`; client-side redirect is in `auth-experience.tsx` (typically → `/compte` or a `redirect` param) |

### 1.2 `/register` — Step 1 Basic Registration (anonymous flow)

| Aspect | Details |
|---|---|
| **File** | `app/register/page.tsx` → `components/forms/basic-registration-form.tsx` |
| **User sees** | Multi-section form: contact, professional info, optional company block ("je représente une organisation") |
| **Fields requested** | `firstName`, `lastName`, `email`, `phone`, `country`, `jobTitle`, `registrationType` (ATTENDEE/STARTUP/INVESTOR/MEDIA/PARTNER), plus optional `organization`, `companyIndustry`, `companyWebsite`, `companySize`, mandatory `consent` |
| **Validation** | `basicRegistrationSchema` in `lib/applications.ts:57` — phone regex `/^[+0-9\s().\-]+$/`, phone required min 6 |
| **Handler** | Server action `startRegistration()` in `app/actions/onboarding.ts:78` |
| **Pre-check** | Redirects to `/register/participation` if user is already signed in (`getOnboardingStatus()` returns `"linked"` or `"wizard"`); shows conflict screen if `"conflict"` |
| **DB writes** | 1) `Participant` (INSERT with `status=PENDING`, `profile=VISITOR\|COMPANY` depending on org fields). 2) `EmailMessage` (queued `registration-visitor-received` or `registration-company-received`). 3) `OnboardingSession` (INSERT). |
| **Cookie** | `bis_reg_session` (HttpOnly, SameSite=strict, **45min TTL** — `lib/onboarding.ts:25`) |
| **Redirect** | `/register/participation` (or `/register/<slug>` if `?participation=` was passed) |

### 1.3 `/register/participation` — Step 2 Role Selector

| Aspect | Details |
|---|---|
| **File** | `app/register/participation/page.tsx` → `participation-selector.tsx` |
| **User sees** | Radio-group card selector: Visitor / Sponsor / Partner / Speaker / Content Creator |
| **Fields** | None persisted at this step — pure navigation |
| **Handler** | Client-side redirect to `/register/<slug>` |
| **DB writes** | None |
| **Cookies** | Unchanged |
| **Redirect** | `/register/<slug>` |

### 1.4 `/register/<slug>` — Step 3 Role Details

| Aspect | Details |
|---|---|
| **File** | `app/register/[slug]/page.tsx` (renders `visitor-confirm.tsx` if visitor, else `role-details-form.tsx`) |
| **VISITOR — user sees** | Confirmation panel with optional completion fields (phone/country/organization/jobTitle) — only shown if Participant is missing them (typical for AccountUser-bootstrap path) |
| **VISITOR — handler** | `confirmVisitorParticipation()` in `onboarding.ts:194` |
| **VISITOR — DB writes** | 1) `Participant.participationChoice='VISITOR'`. 2) Race-safe backfills of phone/country/organization/jobTitle if NULL. 3) Deletes `OnboardingSession` row + cookie. |
| **VISITOR — Zod** | `visitorCompletionSchema` in `onboarding.ts:46` |
| **PROFESSIONAL — user sees** | Role-specific form with organization, industry, website, LinkedIn, photo/logo URL, professional title, expertise/proposedTopic/bio/proposal (for speakers), platform/audienceSize/contentType (for creators), partnershipType/proposal (for partners), interest/focusAreas (for sponsors), free-form message |
| **PROFESSIONAL — handler** | `submitParticipation(type, ...)` in `onboarding.ts:281` |
| **PROFESSIONAL — Zod** | `sponsorDetailsSchema` / `partnerDetailsSchema` / `speakerDetailsSchema` / `creatorDetailsSchema` (`lib/applications.ts:141-188`) |
| **PROFESSIONAL — DB writes** | Transaction: 1) `Application` (INSERT, `status=RECEIVED`, snapshots contact fields from Participant). 2) `Participant.participationChoice` stamped. 3) Race-safe phone backfill. 4) `EmailMessage` queued (`application-*-received`). 5) `OnboardingSession` deleted. |
| **Guard** | Existing app check `where: { participantId, type }` + DB unique constraint `@@unique([participantId, type])` (P2002 caught) |
| **Redirect** | `/register/complete?type=<slug>` |

### 1.5 `/register/complete?type=<slug>` — Step 4 Confirmation

| Aspect | Details |
|---|---|
| **File** | `app/register/complete/page.tsx` |
| **User sees** | Success screen ("Inscription confirmée" for visitors, "Candidature reçue" for professionals) |
| **DB writes** | None |
| **Cookies** | Unchanged |
| **Redirect** | None (dead-end) |

### 1.6 `/compte` — Attendee Dashboard

| Aspect | Details |
|---|---|
| **Auth guard** | `requireAccount()` (`lib/account/auth.ts:80`) — redirects to `/auth?mode=login` if no session |
| **File** | `app/compte/page.tsx` + `app/compte/layout.tsx` reading `getCompteContext(account)` from `lib/account/participant.ts:214` |
| **User sees** | Registration status card, participation type, applications, quick links to badge/access/profile |
| **Data source** | Reads `Participant` via `accountUserId` (whitelist `select`, `lib/account/participant.ts:19`) |
| **DB writes** | None on view |

### 1.7 `/compte/badge` — QR Badge

| Aspect | Details |
|---|---|
| **File** | `app/compte/badge/page.tsx` (server) + client actions `app/compte/badge/actions.ts` |
| **User sees** | Physical-badge preview + "Générer mon badge" button |
| **Handler** | `generateOrRotateMyBadge()` in `app/compte/badge/actions.ts:48` |
| **Gating** | Refuses unless `Participant.status !== CANCELLED` AND `Participant.paymentStatus === PAID` |
| **Rate limit** | 10 seconds between rotations (checks most recent `BadgeCredential.issuedAt`) |
| **DB writes** | 1) Revokes any current ACTIVE `BadgeCredential` (via `rotateBadgeCredential()`). 2) Inserts new ACTIVE `BadgeCredential` (only `tokenHash` stored). 3) `AuditLog` row `badge.rotate.self`. |
| **Return** | PNG data URL — raw token never leaves the request |

### 1.8 `/compte/acces` — Room Registration

| Aspect | Details |
|---|---|
| **File** | `app/compte/acces/page.tsx` |
| **User sees** | Matrix of AccessPoints (Main Entrance + Rooms) with per-room status + register/cancel button |
| **Handler (register)** | `registerForRoom(accessPointId)` in `app/actions/room-registration.ts:150` |
| **Handler (cancel)** | `cancelMyRoomRegistration(accessPointId)` (line 319) |
| **Gating** | `Participant.status !== CANCELLED`; AccessPoint must be `ROOM` + `active` + admission mode set |
| **DB writes (FREE room)** | 1) `RoomRegistration` (`status=FREE_CONFIRMED`). 2) `ParticipantAccess` (`granted=true`, `source=REGISTRATION`). 3) `RoomPaymentEvent` (`kind=INIT`, then `CONFIRM`). 4) `EmailMessage` (best-effort). |
| **DB writes (PAID room)** | 1) `RoomRegistration` (`status=PENDING_PAYMENT`, price/currency frozen). 2) `RoomPaymentEvent` (`kind=INIT`). No access grant until admin confirms. |
| **Rate limit** | 30/account, 60/IP |

### Other actually-used routes

- `/auth/mot-de-passe-oublie` → `/auth/mot-de-passe-reset?token=...` — reset flow (`PasswordResetToken` model)
- `/auth/verifier-email?token=...` — consumes `EmailVerificationToken`, sets `AccountUser.emailVerifiedAt`
- `/compte/profil` — profile view (exists as `page.tsx`)
- `/compte/securite` — security page (change password)
- `/compte/demandes` — list of user's `Application` rows
- `/compte/inscription` — the compte-side registration summary
- `/be-a-part` — marketing page for professional participation types (linked to /register with `?participation=` preselect)

---

## 2. Field-Level Data Map

| User Information | Page | Form Field | Validation | Code Handler | DB Model | DB Field | Saved When | Editable Later? |
|---|---|---|---|---|---|---|---|---|
| First name | /auth?mode=register | `firstName` | 2-80 chars trim | `registerAccount` | `AccountUser` | `firstName` | On signup | Admin only (no `/compte` UI) |
| Last name | /auth?mode=register | `lastName` | 2-80 chars trim | `registerAccount` | `AccountUser` | `lastName` | On signup | Admin only |
| Email | /auth?mode=register | `email` | Zod .email(), lowercased, unique | `registerAccount` | `AccountUser` | `email` (UNIQUE) | On signup | Not exposed for edit in UI |
| Password | /auth?mode=register | `password` + `confirm` | min 8, must match | `registerAccount` (bcrypt via `lib/admin/password`) | `AccountUser` | `passwordHash` | On signup | Yes via `/compte/securite` |
| Consent | /auth?mode=register | `consent` (checkbox) | must be true | `registerAccount` | — | not persisted | — | — |
| Session cookie | /auth login/signup | — | server-issued | `createAccountSession` | `AccountSession` | `tokenHash`, `expiresAt` | On login/signup | Auto |
| Verification token | Post-signup email | click link | server-hashed | `consumeEmailVerificationToken` | `AccountUser` | `emailVerifiedAt` | On click | — |
| First name | /register step 1 | `firstName` | 2-80 chars | `startRegistration` | `Participant` | `firstName` | Step 1 or bootstrap | Admin via edit-form (`registrants/[id]/edit/edit-form.tsx`) |
| Last name | /register step 1 | `lastName` | 2-80 chars | `startRegistration` | `Participant` | `lastName` | Step 1 or bootstrap | Admin |
| Email | /register step 1 | `email` | Zod .email() | `startRegistration` | `Participant` | `email` (unique per event) | Step 1 or bootstrap | Admin |
| Phone | /register step 1 (or 3 completion) | `phone` | `/^[+0-9\s().\-]+$/`, 6-24 | `startRegistration` OR `confirmVisitorParticipation` OR `submitParticipation` | `Participant` | `phone` | Step 1 required; nullable when bootstrapped from AccountUser | Admin |
| Country | /register step 1 | `country` | max 80 | `startRegistration` | `Participant` | `country` (default "Algérie") | Step 1 | Admin |
| Job title | /register step 1 | `jobTitle` | max 120 optional | `startRegistration` | `Participant` | `jobTitle` (nullable) | Step 1 | Admin |
| Registration type | /register step 1 | `registrationType` | enum ATTENDEE/STARTUP/INVESTOR/MEDIA/PARTNER | `startRegistration` | `Participant` | `registrationType` (default ATTENDEE) | Step 1; bootstrap defaults to ATTENDEE | Admin |
| Organization | Step 1 optional (or Step 3) | `organization` | max 120 optional | `startRegistration` / `submitParticipation` | `Participant` | `organization` (nullable) | Step 1 or Step 3 backfill (visitor) | Admin |
| Company industry | Step 1 optional | `companyIndustry` | max 200 optional | `startRegistration` | `Participant` | `companyIndustry` | Step 1 | Admin |
| Company website | Step 1 optional | `companyWebsite` | http(s) URL 500 max | `startRegistration` | `Participant` | `companyWebsite` | Step 1 | Admin |
| Company size | Step 1 optional | `companySize` | max 200 optional | `startRegistration` | `Participant` | `companySize` | Step 1 | Admin |
| Profile (VISITOR/COMPANY) | Step 1 (derived) | — | inferred from company fields | `startRegistration:147` | `Participant` | `profile` | Step 1 | Admin (unclear UI) |
| Registration status | Step 1 (default) | — | — | `startRegistration` | `Participant` | `status` = PENDING | Step 1 | Admin only |
| Payment status | Admin action | — | enum | `registrants/[id]/edit/edit-form.tsx:148` (admin) | `Participant` | `paymentStatus` (default UNPAID) | Admin manual | Admin |
| Payment amount | Admin | — | int DZD | Admin | `Participant` | `paymentAmount` | Admin | Admin |
| Payment ref | Admin | — | string | Admin | `Participant` | `paymentRef` | Admin | Admin |
| Paid at | Admin | — | timestamp | Admin | `Participant` | `paidAt` | Admin | Admin |
| Tier | Admin | — | enum VVIP/VIP/VISITOR/CONTENT_CREATOR/IMPACT_MAKER | Admin | `Participant` | `tier` (nullable) | Admin | Admin |
| Gate | Admin | — | string | Admin | `Participant` | `gate` (nullable) | Admin | Admin |
| Participation choice | Step 3 | — | enum VISITOR/SPONSOR/PARTNER/SPEAKER/CONTENT_CREATOR | `confirmVisitorParticipation` / `submitParticipation` | `Participant` | `participationChoice` | Step 3 | Admin (unclear if UI supports) |
| Application role | Step 3 (pro) | — | ApplicationType | `submitParticipation` | `Application` | `type` | Step 3 | Not editable (unique-per-participant) |
| Application status | Admin only | — | enum RECEIVED/UNDER_REVIEW/CONTACTED/APPROVED/REJECTED | `applications/[id]/actions.ts:updateApplication` | `Application` | `status` | Admin | Admin |
| Application review notes | Admin only | — | text | `updateApplication` | `Application` | `reviewNotes` | Admin | Admin |
| Application details JSON | Step 3 | role-specific | role Zod | `submitParticipation` | `Application` | `details` (Json) | Step 3 | Not editable |
| Application contact snapshot | Step 3 | — | copied from Participant | `submitParticipation:371-378` | `Application` | `firstName`, `lastName`, `email`, `phone`, `country`, `organization`, `position`, `website`, `industry`, `photoUrl`, `logoUrl`, `linkedin`, `message` | Step 3 (frozen) | **NO** — never re-synced |
| Onboarding session token | Steps 1-3 | — | server-issued | `createOnboardingSession` | `OnboardingSession` | `tokenHash`, `expiresAt` | Step 1 or bootstrap | Auto-deleted at Step 3 end |
| AccountUser ↔ Participant link | Bootstrap | — | server-derived | `getOnboardingStatus:158` | `Participant` | `accountUserId` (nullable) | On AccountUser bootstrap | Not editable |
| Ticket code (legacy) | Admin | — | unique | Admin/scripts | `Participant` | `ticketCode` (unique, nullable) | Admin issuance | Admin |
| Check-in code (Phase 19) | Script `backfill-checkin-codes.mjs` | — | 12-char + dashes | Script | `Participant` | `checkinCode` (unique, nullable) | Backfill script | Admin |
| Badge credential | /compte/badge OR admin badge-panel | — | server-random 32B, sha256 stored | `rotateBadgeCredential` | `BadgeCredential` | `tokenHash`, `status`, `issuedAt`, `rotatedFromId` | On rotate | Rotate creates new row; old revoked |
| Room registration | /compte/acces | `accessPointId` | Zod min 10 max 64 | `registerForRoom` | `RoomRegistration` | `status`, `priceMinorSnapshot`, `currencySnapshot`, `paymentRef` (admin), timestamps | On self-registration | State machine (see §4) |
| Room access grant | Auto or admin | — | server-derived | `syncRoomAccessEntitlement` or admin `grantRoomAccessAction` | `ParticipantAccess` | `granted`, `source` | On room register (source=REGISTRATION) or admin (source=ADMIN) | Yes (source-scoped) |
| Check-in scan | Scanner UI (admin) | — | operator-scanned QR / text | `/admin/scan/<slug>` | `CheckIn` | `result`, `scannedAt`, `accessPointId`, `credentialId`, `gate` | On scan | Append-only |

---

## 3. Source of Truth per Field

| Concept | First created | Authoritative table | Copied to | Copies get stale? | Admin UI reads | Attendee UI reads |
|---|---|---|---|---|---|---|
| **Login identity (email/password)** | `/auth?mode=register` → `AccountUser` | `AccountUser` | Copied into `Participant.email` at bootstrap (`onboarding.ts:164`) | **YES** — no re-sync | Admin sees `Participant.email` in `/admin/registrants` (never AccountUser) | `getCurrentAccount()` reads `AccountUser` |
| **Event registration identity (email)** | `/register` step 1 or AccountUser bootstrap | `Participant` | Copied into `Application.email` at Step 3 (`onboarding.ts:373`) | **YES** — never re-synced (comment at `onboarding.ts:367` explicitly acknowledges) | `Participant` for registrant list; `Application` for applications list (separate views) | `getParticipantForAccount` (`Participant`) |
| **Phone** | Step 1 (or Step 3 backfill / bootstrap = null) | `Participant.phone` | `Application.phone` (Step 3 snapshot) | Yes — same as above | `Participant` | `Participant` |
| **Organization** | Step 1 optional / Step 3 professional | `Participant.organization` OR `Application.organization` (competing) | Both; independently editable | Yes — conflict-prone | Both surfaces | `Participant.organization` |
| **`registrationType`** (ATTENDEE/STARTUP/…) | Step 1 (default ATTENDEE) | `Participant.registrationType` | Nowhere | — | Admin filter (`/admin/registrants`) | Not exposed to attendee UI |
| **`participationChoice`** (VISITOR/SPONSOR/…) | Step 3 | `Participant.participationChoice` (nullable) | Also present as `Application.type` (for non-visitor) | Yes — the two can drift (e.g. admin deletes Application but choice remains) | `Participant.participationChoice` on registrant page; `Application.type` on applications list | Compte UI reads `Participant.participationChoice` |
| **`tier`** (VVIP/VIP/…) | Admin action | `Participant.tier` | Nowhere | — | Admin | Attendee (badge card via `getParticipantForAccount`) |
| **`status`** (PENDING/CONFIRMED/CANCELLED) | Step 1 default = PENDING | `Participant.status` | Nowhere | — | Admin edit-form | Compte inscription page |
| **`paymentStatus`** | Admin (no auto path) | `Participant.paymentStatus` | Nowhere | — | Admin edit-form | Compte reads it as gating for badge |
| **Application review status** | Step 3 default = RECEIVED | `Application.status` | Nowhere | — | Admin `/admin/applications/[id]` | Compte demandes page (whitelist select) |
| **Badge QR token** | `/compte/badge` or admin | `BadgeCredential` (only sha256) | Raw token: nowhere. Only shown once via QR image | — | Admin badge-panel (status only) | Compte badge (regenerate) |
| **Room registration state** | `/compte/acces` (self) or admin | `RoomRegistration` | Mirror in `ParticipantAccess` via `syncRoomAccessEntitlement` | Sync is transactional in service | Admin room-registrations-panel | Compte acces |
| **Room access grant** | Domain sync OR admin manual | `ParticipantAccess` | `source` field distinguishes ownership | Split ownership prevents overwrites | Admin access-matrix | Compte acces (tri-state) |

**Special attention findings:**

- **`AccountUser` vs `Participant`** — two independent email fields. AccountUser is the login identity; Participant is the event registration. Linked by `Participant.accountUserId` (nullable). Anonymous /register creates a Participant with no AccountUser. Bootstrap from AccountUser creates a Participant. **No process reconciles the two emails after they're copied.**
- **`Participant` vs `Application`** — Application copies Participant's contact fields at Step 3 (`onboarding.ts:371-384`), with a code comment explicitly stating this is intentional and not re-synced. Admin can edit `Participant` fields without any refresh of historic Applications.
- **`RegistrationType` vs `ParticipationChoice`** — schema comment (`prisma/schema.prisma:187,196`) says they coexist. `registrationType` is legacy-flavored (ATTENDEE/STARTUP/…), `participationChoice` is the newer user-declared intent (VISITOR/SPONSOR/…). They map imperfectly — e.g., a user can have `registrationType=INVESTOR` and `participationChoice=VISITOR`.
- **`tier`** is admin-only, drives badge display via `Participant.tier`. Independent of the other two.

---

## 4. State Analysis

### 4.1 State transitions per model

**`Participant.status`** — `RegistrationStatus`

- **PENDING** — initial value (created by `startRegistration:152` or bootstrap `onboarding.ts:168`)
- **CONFIRMED** — never set by any code path in the repo (no `status: "CONFIRMED"` write found outside admin edit-form, which sets whatever the admin picks)
- **CANCELLED** — admin only (via `/admin/registrants/[id]/edit/edit-form.tsx`)

**Payment doesn't change status. Approval doesn't change status. Badge doesn't. Check-in doesn't.**

**`Participant.paymentStatus`** — `PaymentStatus`

- **UNPAID** — default
- **PENDING**, **PAID**, **REFUNDED**, **FAILED** — admin only via edit-form
- **No PSP webhook code path exists** for base BIS registration. (Room registrations have their own PAID state machine but do NOT change `Participant.paymentStatus`.)

**`Application.status`** — `ApplicationStatus`

- **RECEIVED** — initial (`onboarding.ts:366`)
- **UNDER_REVIEW / CONTACTED / APPROVED / REJECTED** — admin only via `updateApplication()` (`app/admin/(protected)/applications/[id]/actions.ts:46`)
- **Approval sets `reviewedAt`/`reviewedById`** but does not touch `Participant.status`.

**`BadgeCredential.status`** — `BadgeStatus`

- **ACTIVE** — set on issue/rotate (`app/compte/badge/actions.ts:116`)
- **REVOKED** — set on rotation (previous row) or admin action
- **EXPIRED**, **PENDING** — enum values exist but no code path sets them (audit finding)

**`RoomRegistration.status`** — `RoomRegistrationStatus`

- **PENDING_PAYMENT** — PAID room, self-registered, awaiting admin confirm
- **FREE_CONFIRMED** — FREE room, self-registered
- **PAID** — admin confirmed via `room-payment-actions.ts`
- **PAYMENT_FAILED / CANCELLED / REFUNDED / EXPIRED** — via `cancel()` or admin actions

### 4.2 State-flow diagram

```text
                 ┌────────────────────────────────────────────────────────┐
                 │                    AccountUser lifecycle               │
                 │                                                        │
    signup ──► emailVerifiedAt=null ──► (link clicked) ──► emailVerifiedAt=<now>
                                                          │
                                                    (independent of Participant)
                 └────────────────────────────────────────────────────────┘

                 ┌────────────────────────────────────────────────────────┐
                 │                 Participant lifecycle                  │
                 │                                                        │
    Step 1 or                                                             │
    bootstrap ──► status=PENDING                                          │
                    │                                                     │
                    │ (Step 3 stamps participationChoice, but NOT status) │
                    │                                                     │
                    │  ┌── admin edit ──► status=CONFIRMED                │
                    │  │                                                  │
                    │  └── admin edit ──► status=CANCELLED (terminal for  │
                    │                     badge/room)                     │
                    │                                                     │
                    │  paymentStatus: UNPAID ──► [admin] ──► PAID         │
                    │  (unlocks badge generation)                         │
                    │                                                     │
                 └────────────────────────────────────────────────────────┘

                 ┌────────────────────────────────────────────────────────┐
                 │                Application lifecycle                   │
                 │                                                        │
    Step 3 (pro) ─► status=RECEIVED                                       │
                       │                                                  │
                       │ [admin] ──► UNDER_REVIEW ──► CONTACTED ──► APPROVED
                       │                                          └► REJECTED
                       │                                                  │
                       │  (No back-pressure onto Participant.status)      │
                 └────────────────────────────────────────────────────────┘

                 ┌────────────────────────────────────────────────────────┐
                 │                BadgeCredential lifecycle               │
                 │                                                        │
    /compte/badge ─► [gate: paymentStatus==PAID] ─► ACTIVE (new row)      │
                                                    │                     │
                                                    ├─► (rotate) previous │
                                                    │   row → REVOKED     │
                                                    │                     │
                                                    └─► admin revoke      │
                                                        (badge-panel)     │
                 └────────────────────────────────────────────────────────┘

                 ┌────────────────────────────────────────────────────────┐
                 │              RoomRegistration lifecycle                │
                 │                                                        │
    FREE room:                                                            │
      /compte/acces ─► FREE_CONFIRMED ──► [attendee cancel] ─► CANCELLED  │
                                          [admin cancel]                  │
    PAID room:                                                            │
      /compte/acces ─► PENDING_PAYMENT                                    │
                          │                                               │
                          ├─► [admin confirm] ─► PAID                     │
                          ├─► [admin fail]    ─► PAYMENT_FAILED           │
                          ├─► [attendee/admin cancel] ─► CANCELLED        │
                          └─► [expiry]       ─► EXPIRED                   │
                          (PAID) ── [admin refund] ─► REFUNDED (terminal) │
                 └────────────────────────────────────────────────────────┘

                 ┌────────────────────────────────────────────────────────┐
                 │                   CheckIn (append-only)                │
                 │                                                        │
    Scanner ─► CheckIn.result = VALID | ALREADY_CHECKED_IN | UNPAID | …   │
              (writes Participant.checkedInAt on first VALID scan)        │
              (does NOT change Participant.status)                        │
                 └────────────────────────────────────────────────────────┘
```

**Key answers:**

- **Payment does NOT change registration status.** `paymentStatus` and `status` are orthogonal columns.
- **Approval does NOT change registration status.** Application review is fully decoupled from Participant.
- **Badge does NOT change status.** Badge is a downstream artifact.
- **Check-in stamps `checkedInAt` but leaves `status=PENDING`.**

---

## 5. Duplicates / Conflicting Data (Exact Locations)

| Finding | Files | Reason |
|---|---|---|
| **Duplicate email fields (AccountUser + Participant)** | `AccountUser.email`, `Participant.email` (schema.prisma); copy at `lib/onboarding.ts:164` | Never re-synced. If admin edits Participant.email, AccountUser stays. If AccountUser email changes (if such flow exists), Participant stays. |
| **Duplicate contact snapshot on Application** | `Application.firstName/lastName/email/phone/country/organization` (`app/actions/onboarding.ts:371-378`) | Explicit comment says "kept in sync with Participant only at creation time" — admin edits to Participant do NOT retro-update. |
| **Two schemas covering the same fields** | `lib/validations.ts:3` `registrationSchema` AND `lib/applications.ts:57` `basicRegistrationSchema` | Both validate essentially the same shape. `registrationSchema` appears to be dead code (only `basicRegistrationSchema` used by `startRegistration`). |
| **Two enum-like fields describing "role"** | `Participant.registrationType`, `Participant.participationChoice` (schema.prisma:196) | Explicit comment acknowledges "Distinct from RegistrationType." Downstream code inconsistent about which to read. |
| **Third role-ish column: `tier`** | `Participant.tier` (schema.prisma:244) | Admin-set, used by badge card. Semantically overlaps the previous two. |
| **`Application` can outlive `Participant`** | `Application.participantId` is nullable with `onDelete: SetNull` (schema.prisma:324) | If Participant is deleted, Application survives with `participantId=null` — orphan row. |
| **`AccountUser` can exist without `Participant`** | Signup at /auth without proceeding to /register | Not visible in admin UI. |
| **Anonymous `Participant` can exist without `AccountUser`** | /register step 1 without prior login → `Participant.accountUserId=null` | These attendees exist in admin `/admin/registrants` but cannot log in. If they later try to sign up at /auth with the same email, the "email conflict" branch (`onboarding.ts:189`) refuses to auto-link. |
| **Duplicate Participant per email guarded by DB** | `@@unique([eventId, email])` on Participant | Race handled by P2002 catch (`onboarding.ts:96` for AccountUser; also in bootstrap `onboarding.ts:174`). BUT the anonymous /register flow returns a friendly error (`onboarding.ts:127`) instead of merging. |
| **Duplicate Application per (participant, type) guarded** | `@@unique([participantId, type])` + explicit check `onboarding.ts:344` + P2002 catch `onboarding.ts:409` | Handled. |
| **Race condition risk: bootstrap in `getOnboardingStatus`** | `lib/onboarding.ts:158` calls `prisma.participant.create` inside a page render (server component) | Two parallel requests from the same account can race → P2002; second re-fetches (line 185). But this DB write during page render is unusual — could double-fire on concurrent HTTP requests. |
| **Abandoned `OnboardingSession` rows** | `lib/onboarding.ts:53` deletes prior sessions on new creation, but no scheduled cleanup for expired rows | Rows past `expiresAt` stay until next signup by same participant. Not correctness-critical but grows the table. |
| **Abandoned Participants with `participationChoice=null`** | Anyone who started `/register` step 1 but never reached step 3 has a Participant row with no participationChoice | No cleanup, indistinguishable in admin views from "user in progress." |
| **`BadgeCredential` partial-unique lives out-of-band** | `scripts/apply-badge-index.ts` | If never run in prod, `single-ACTIVE` invariant is enforceable only via service-layer transactions. |
| **`checkinCode` backfilled by script** | `scripts/backfill-checkin-codes.mjs` referenced in schema comment | If script wasn't run, some participants have `checkinCode=null` — text-input check-in flow will reject them. |
| **`Participant.status` never advances automatically** | No code path sets `CONFIRMED` outside admin edit-form | Even a paid, badged, checked-in participant remains `PENDING` unless an admin clicks. |

---

## 6. Incomplete-Registration Behavior

| Scenario | Actual behavior |
|---|---|
| **Closes browser mid-registration** | Cookie may persist (HttpOnly, 45min TTL for `bis_reg_session`); if session cookie survives, user returns to Step 2/3 seamlessly. If cookie died, `getOnboardingStatus()` returns `"none"` and user restarts at Step 1 — but the `Participant` row already exists → their email hits the `@@unique([eventId, email])` guard → friendly duplicate message (`onboarding.ts:127`). Result: **they are locked out of restarting** unless they log in via /auth (if they had an account) or contact support. |
| **Refresh page mid-registration** | Cookie is intact; `getOnboardingStatus()` resolves the Participant; the page renders with prior state. No data loss. |
| **Returns later, <45 min** | Cookie still valid → resumes. |
| **Returns later, >45 min** | `OnboardingSession.expiresAt < now` → `readOnboardingSession()` deletes the row and returns null (`lib/onboarding.ts:75-80`). Same "locked out" result as browser-close unless signed in via AccountUser. |
| **Starts with /auth?mode=register** | Creates AccountUser only. If they never touch /register, they exist only as AccountUser — no admin visibility. Compte UI (`/compte`) will show "no participant" state. |
| **Starts directly with /register** | Creates Participant with `accountUserId=null`. No login possible. |
| **Uses existing Participant email at /register** | Refused with friendly message (`onboarding.ts:127`). No merge. |
| **Uses existing AccountUser email at /register** | If not signed in, the Participant creation attempt collides with `@@unique([eventId, email])` and is refused (same message). |
| **AccountUser exists but no Participant** | On visiting /register, `getOnboardingStatus()` bootstraps a Participant tied to that account. Bootstrap uses AccountUser's names + email; phone is null. |
| **Participant exists (anonymous) but no AccountUser, user then signs up at /auth** | New AccountUser created. Their subsequent /register visit tries to bootstrap a Participant, hits `@@unique([eventId, email])`, `getOnboardingStatus()` catches P2002, checks for a raced-owner row — finds none because the existing Participant has `accountUserId=null` — returns `kind: "conflict"` (`onboarding.ts:189`). UI shows `OnboardingConflictScreen`. **They can log in but never link to their pre-existing event registration** unless admin intervenes. |
| **Submits step 3 twice** | Guard at `onboarding.ts:344` (existing app check) + DB `@@unique([participantId, type])` + P2002 catch (line 409) → redirects to /register/complete. Second submit is harmless. |
| **Clicks Back and changes Step 1 info** | Step 1 form is inert for signed-in users (redirects to Step 2). For anonymous users, if they re-submit Step 1 with different data but same email → duplicate error. **If different email → creates a NEW Participant + wipes prior OnboardingSession** (`createOnboardingSession:53` deletes prior sessions). Prior Participant becomes an abandoned orphan. |

---

## 7. What Does "Registered" Mean?

The system does not have a single "registered" state. The concept fans out across multiple orthogonal signals:

| Signal | DB indicator | Set by | Meaning |
|---|---|---|---|
| **Account created** | `AccountUser` row exists | `/auth?mode=register` → `registerAccount` | Can log in |
| **Email verified** | `AccountUser.emailVerifiedAt != null` | `consumeEmailVerificationToken` | Independently confirmed email |
| **Participant created** | `Participant` row exists | `/register` step 1 OR AccountUser bootstrap | Event-registration record exists |
| **Registration form completed** | `Participant.participationChoice != null` | `confirmVisitorParticipation` OR `submitParticipation` | User picked a role and completed Step 3 |
| **Application submitted** | `Application` row exists with `type` | `submitParticipation` (non-visitor) | Professional application submitted |
| **Admin approved** | `Application.status = APPROVED` (non-visitor) OR `Participant.status = CONFIRMED` | `updateApplication` OR admin edit-form | Admin gave a thumbs-up |
| **Payment confirmed** | `Participant.paymentStatus = PAID` | Admin edit-form (no self-service) | Money in (or admin says so) |
| **Badge issued** | `BadgeCredential.status = ACTIVE` for participant | `/compte/badge` OR admin badge-panel | Attendee has a working QR |
| **Room confirmed** | `RoomRegistration.status ∈ {FREE_CONFIRMED, PAID}` | `/compte/acces` (FREE) OR admin (PAID) | Per-room entitlement |
| **Check-in completed** | `Participant.checkedInAt != null` AND `CheckIn.result=VALID` row exists | Scanner via `/admin/scan/<slug>` | Actually walked in |

**Consequence:** A participant can be "PENDING" in `status`, "PAID" in `paymentStatus`, have an ACTIVE badge, be checked in — and still show as PENDING in admin lists. There is no automated bookkeeper.

---

## 8. Final Architecture Map (actual implementation)

```text
USER (browser visitor)
 ↓  action: fill form at /auth?mode=register OR /register step 1
 ↓  handler: registerAccount() [app/actions/account.ts:45]
 ↓          OR startRegistration() [app/actions/onboarding.ts:78]
 ↓  DB op: prisma.accountUser.create()  OR  prisma.participant.create()
 ↓  state: AccountUser row exists (emailVerifiedAt=null)
 ↓          AND/OR Participant row exists (status=PENDING)
 ↓

ACCOUNT = AccountUser  (auth-only)  ─────────► AccountSession, EmailVerificationToken, PasswordResetToken
 ↓  action: sign in (or already signed in) then hit /register
 ↓  handler: getOnboardingStatus() [lib/onboarding.ts:142]
 ↓  DB op: prisma.participant.findFirst({accountUserId}); if none, prisma.participant.create({accountUserId,…})
 ↓  state: Participant row linked to account (accountUserId set)
 ↓

PARTICIPANT = Participant  (event registration)  ─────────► OnboardingSession (short-lived wizard state)
 ↓  action: Step 1 form submit
 ↓  handler: startRegistration() [onboarding.ts:78]
 ↓  DB op: prisma.participant.create({ eventId, status:PENDING, profile:VISITOR|COMPANY, … })
 ↓         prisma.onboardingSession.create({ tokenHash, participantId, expiresAt+45m })
 ↓         cookie bis_reg_session set (HttpOnly, SameSite=strict)
 ↓  state: status=PENDING, participationChoice=null
 ↓

REGISTRATION / ONBOARDING = OnboardingSession + Participant.status=PENDING
 ↓  action: pick role on /register/participation (client-side redirect only)
 ↓  handler: — (navigation)
 ↓  DB op: none
 ↓  state: unchanged
 ↓

PARTICIPATION CHOICE = Participant.participationChoice
 ↓  action: Step 3 submit
 ↓  handler: confirmVisitorParticipation() [onboarding.ts:194]
 ↓          OR submitParticipation(type) [onboarding.ts:281]
 ↓  DB op (visitor): prisma.participant.update({ participationChoice:"VISITOR" }) + backfills
 ↓  DB op (pro):    prisma.$transaction([
 ↓                    prisma.application.create({ participantId, type, status:"RECEIVED", snapshots… }),
 ↓                    prisma.participant.update({ participationChoice:<mapped> })
 ↓                  ])
 ↓  DB op (both):   OnboardingSession delete + cookie clear + queue email
 ↓  state: participationChoice set; Application row may exist
 ↓

APPLICATION (if applicable) = Application row
 ↓  action: admin opens /admin/applications/[id] and picks a status
 ↓  handler: updateApplication() [app/admin/(protected)/applications/[id]/actions.ts:20]
 ↓  DB op: prisma.application.update({ status, reviewNotes, reviewedById, reviewedAt })
 ↓         prisma.auditLog.create({ action:"application.update", … })
 ↓  state: Application.status ∈ {UNDER_REVIEW, CONTACTED, APPROVED, REJECTED}
 ↓  NOTE: does NOT touch Participant.status
 ↓

ADMIN APPROVAL (if applicable) = Application.status=APPROVED  and/or  Participant.status=CONFIRMED
 ↓  action: admin also edits /admin/registrants/[id]/edit
 ↓  handler: edit-form action
 ↓  DB op: prisma.participant.update({ status?, paymentStatus?, tier?, gate?, tickets? })
 ↓  state: any subset of Participant fields can move; each independently
 ↓

PAYMENT = Participant.paymentStatus
 ↓  action: admin only (edit-form) — no PSP webhook, no self-service
 ↓  handler: registrants/[id]/edit form
 ↓  DB op: prisma.participant.update({ paymentStatus:"PAID", paymentAmount, paymentRef, paidAt })
 ↓  state: paymentStatus=PAID  (unlocks badge)
 ↓

BADGE = BadgeCredential (ACTIVE)
 ↓  action: /compte/badge → "Générer mon badge"
 ↓  handler: generateOrRotateMyBadge() [app/compte/badge/actions.ts:48]
 ↓  gate:    Participant.status != CANCELLED  AND  paymentStatus = PAID
 ↓  DB op:  rotateBadgeCredential()
 ↓           → revoke prior ACTIVE row (status=REVOKED)
 ↓           → create new ACTIVE row (tokenHash only)
 ↓          prisma.auditLog.create({ action:"badge.rotate.self" })
 ↓  state: BadgeCredential.status=ACTIVE for participant
 ↓  return: QR data URL (raw token embedded only in image pixels)
 ↓

ROOM / ACCESS = RoomRegistration + ParticipantAccess
 ↓  action (FREE): /compte/acces → "S'inscrire"
 ↓  handler: registerForRoom(accessPointId) [app/actions/room-registration.ts:150]
 ↓  DB op: initRegistration() service transaction:
 ↓           prisma.roomRegistration.create({ status:"FREE_CONFIRMED", … })
 ↓           prisma.participantAccess.upsert({ granted:true, source:"REGISTRATION" })
 ↓           prisma.roomPaymentEvent.create({ kind:"INIT" / "CONFIRM" })
 ↓
 ↓  action (PAID): /compte/acces → "Réserver — <price>"
 ↓  handler: same registerForRoom → initRegistration()
 ↓  DB op: RoomRegistration.status="PENDING_PAYMENT"; NO ParticipantAccess grant
 ↓  followup: admin confirms via /admin/registrants/[id]/room-payment-actions.ts
 ↓            → prisma.roomRegistration.update({ status:"PAID", paidAt })
 ↓            → sync ParticipantAccess (source=REGISTRATION)
 ↓  state: ParticipantAccess.granted=true (for authorized rooms)
 ↓

CHECK-IN = CheckIn append rows + Participant.checkedInAt
 ↓  action: scanner in /admin/scan/[access-point-slug] scans QR or types text code
 ↓  handler: scan actions (validates BadgeCredential OR checkinCode)
 ↓  DB op: prisma.checkIn.create({ result, gate, scannedAt, participantId?, credentialId?, accessPointId })
 ↓         on first VALID scan at main entrance: prisma.participant.update({ checkedInAt, checkedInGate })
 ↓  state: CheckIn row appended; Participant.checkedInAt stamped (once)
 ↓  NOTE: does NOT change Participant.status — always stays "PENDING" unless admin edits
```

---

## 9. Audit Conclusion (No Changes Made)

The registration system is functional but has:

- **Three orthogonal identity concepts** — `AccountUser`, `Participant`, `Application`
- **Three overlapping role columns** — `registrationType`, `participationChoice`, `tier`
- **Four independent status axes** — `Participant.status`, `Participant.paymentStatus`, `Application.status`, per-room `RoomRegistration.status`

No code path ties these together.

**Critical gaps identified:**

1. No self-service payment path (all `paymentStatus` transitions are admin-only)
2. No `AccountUser` admin UI (silent-signup users are invisible)
3. Anonymous `Participant` + a later `AccountUser` signup with the same email is a dead-end (`kind: "conflict"`)
4. `Participant.status` never advances past `PENDING` automatically
5. Contact fields are snapshot-copied into `Application` and never re-synced
6. Anyone whose 45-min onboarding cookie expires before Step 3 is locked out of re-registering with the same email

No modifications made. This report is strictly informational and intended as the foundation for a future redesign phase.
