# BIS 2027 — Registration Production Readiness Audit

Point-in-time audit performed 2026-09-25 against commits:

```
23a31dd feat(registration): complete role-specific registration flows
40dd026 harden(registration): case-insensitive claim, seed default, safeNext tests
291844e refactor(registration): establish unified account and visitor/speaker flows
```

Verdict: **REGISTRATION READY WITH DOCUMENTED BLOCKERS** — the
registration system itself is correct, race-safe, and production-ready.
One pre-existing baseline blocker (`emailTemplate`, unrelated) prevents
`next build` from finishing.

## 1. Architecture

Invariant `ONE PERSON → ONE AccountUser → ONE Participant per event →
0..n Applications → ONE ACTIVE BadgeCredential` — verified in code and
with a live concurrency test (10 parallel Participant creates + 10
parallel badge issues both converge to exactly one row).

Single entry point for identity: every registration flow goes through
`lib/register/participant.ts::ensureParticipantForAccount`. Never
matches on email alone; only on `accountUserId`. The legacy anonymous
Participant claim requires email-ownership proof through the
verification token.

## 2. Role matrix

| Role            | Route                       | Participant | Application | Badge | Payment Required |
|-----------------|-----------------------------|-------------|-------------|-------|------------------|
| Visitor         | `/register/visitor`         | Yes         | No          | Yes   | No               |
| Speaker         | `/register/speaker`         | Yes         | Yes         | Yes   | No               |
| Sponsor         | `/register/sponsor`         | Yes         | Yes         | Yes   | No               |
| Partner         | `/register/partner`         | Yes         | Yes         | Yes   | No               |
| Content Creator | `/register/content-creator` | Yes         | Yes         | Yes   | No               |

Verified against `app/actions/register-*.ts` + `app/register/**/page.tsx`.

## 3. State machine

```
REGISTERED  — successfully completed event registration
CONFIRMED   — event confirmed the person's attendance (admin action)
CANCELLED   — registration cancelled (admin action)
PENDING     — deprecated; retained for the transition window
```

Every write path uses the guard
`status IN ("PENDING","REGISTERED")` before setting REGISTERED — never
downgrades CONFIRMED, never resurrects CANCELLED. Enforced in the
professional kernel (`lib/register/professional-action.ts:195`) and in
the visitor action (`app/actions/register-visitor.ts:135`). Tested
under concurrency (20 parallel writes leave `CANCELLED` and `CONFIRMED`
untouched).

Separation-of-concerns verified by grep:
- No public registration route reads `paymentStatus`.
- Admin payment usage lives only in `app/admin/(protected)/revenue/`,
  `app/admin/(protected)/registrants/registrant-row.tsx` (display), and
  `app/admin/(protected)/registrants/actions.ts` (admin edit).
- Badge issuance only refuses when `status = CANCELLED`.

## 4. Database invariants

| Invariant                              | DB-level protection                              |
|----------------------------------------|--------------------------------------------------|
| One AccountUser per email              | `AccountUser.email @unique`                      |
| One Participant per (event, email)     | `@@unique([eventId, email])`                     |
| Participant ↔ AccountUser              | FK `Participant.accountUserId`                   |
| One Application per (participant, type) | `@@unique([participantId, type])`               |
| One ACTIVE badge per Participant       | Partial unique idx `... WHERE status='ACTIVE'`   |
| One RoomRegistration per (participant, room) | `@@unique([participantId, accessPointId])`  |

Partial unique index verified on dev DB via `\d+ "BadgeCredential"`:
```
"BadgeCredential_one_active_per_participant_uidx" UNIQUE, btree
  ("participantId") WHERE status = 'ACTIVE'::"BadgeStatus"
```

None of these invariants depend on UI logic. Every server action
catches `P2002` and treats the race as "the winning row is already in
place" (redirect to success or return existing state).

## 5. Security findings

| Check                                     | Result | Evidence |
|-------------------------------------------|--------|----------|
| Auth from server session only             | OK     | Every action calls `getCurrentAccount()` before any DB work |
| No client-supplied `accountUserId`/`participantId`/`applicationId` | OK | `grep formData.get\("(accountUserId\|participantId\|applicationId)"\)` returns 0 hits in `app/actions/register-*.ts` |
| Role tampering                            | OK     | `type` is hard-coded per action file (SPEAKER / SPONSOR / PARTNER / CONTENT_CREATOR); form data cannot swap type |
| IDOR on badge rotation                    | OK     | `generateOrRotateMyBadge` resolves participant strictly from `accountUserId` |
| Duplicate Participant                     | OK     | DB unique on (eventId, email) + `accountUserId` lookup + P2002 catch |
| Duplicate Application                     | OK     | DB unique on (participantId, type) + P2002 catch |
| Duplicate ACTIVE badge                    | OK     | Partial unique index + `ACTIVE_EXISTS` catch |
| Race: 10 parallel Participant creates     | OK     | Test: 10 → 1 row |
| Race: 10 parallel badge issues            | OK     | Test: 10 → 1 ACTIVE row |
| Race: 10 parallel Application inserts per role | OK | Test: 10 → 1 row + 9 P2002 rejections |
| Race: status guard vs concurrent writes   | OK     | Test: 20 concurrent stamps do not downgrade CONFIRMED or resurrect CANCELLED |
| Legacy claim — anti-hijack (already-bound Participant) | OK | `updateMany where accountUserId IS NULL` |
| Legacy claim — case-insensitive           | OK     | Postgres `mode: "insensitive"` (Commit 1 review-gate fix) |
| Legacy claim — race (double verify)       | OK     | Token atomic single-use via `updateMany where usedAt IS NULL` |
| Legacy claim — change-email hijack        | OK     | Token's `emailAtIssue` compared to current AccountUser.email at consumption |
| Open redirect on `/auth?next=`            | OK     | `safeNext` rejects `//`, off-domain, traversal (raw + encoded), backslashes; 21/21 unit tests |
| Rate limit per account                    | OK     | Kernel throttle `register-<slug>:acct:<userId>`, 10 or 20 submits per 15-min window |
| Email verification — expired/reused/invalid | OK  | 6/6 email-verification tests |
| Account enumeration                       | OK     | Unchanged from pre-refactor `registerAccount` (uniform "already exists" response + rate limits) |
| CSRF                                      | OK     | Next.js server actions carry origin check by default |
| Token-at-rest — badge                     | OK     | Only sha256(rawToken) persisted; QR encodes the raw token which is discarded server-side |
| Token-at-rest — email verification        | OK     | Only sha256(rawToken) persisted; `emailAtIssue` snapshot prevents email-change replay |

## 6. Email behavior

All five confirmation emails use the existing `queueTemplatedEmail` →
`EmailMessage` queue → worker → provider pipeline. No parallel system.

| Role            | Template key                    | Idempotency key                              |
|-----------------|---------------------------------|----------------------------------------------|
| Visitor         | `registration-visitor-received` | `visitor-registered:<participantId>`         |
| Speaker         | `application-speaker-received`  | `application:<participantId>:SPEAKER`        |
| Sponsor         | `application-sponsor-received`  | `application:<participantId>:SPONSOR`        |
| Partner         | `application-partner-received`  | `application:<participantId>:PARTNER`        |
| Content Creator | `application-creator-received`  | `application:<participantId>:CONTENT_CREATOR`|

All five template keys exist in `lib/admin/email-templates.ts` and are
covered by `test:email-templates`. Retry, backoff, provider selection,
and rate limiting all use the pre-existing infrastructure.

## 7. Admin verification

- Registrant list (`/admin/registrants`) filters by `REGISTERED /
  CONFIRMED / CANCELLED / PENDING` (transition-window compat).
- Registrant edit form (`/admin/registrants/[id]/edit`) has all four
  status values in the dropdown; default new value is REGISTERED.
- Admin dashboard KPI links to `?status=REGISTERED` for "à confirmer".
- Applications live at `/admin/applications` with filterable type +
  status. Every ApplicationType (SPEAKER, SPONSOR, PARTNER,
  CONTENT_CREATOR) is represented.
- Registrant detail page (`/admin/registrants/[id]`) does **NOT**
  inline the participant's applications. Admin must cross-reference via
  the applications page. See §17.

## 8. Dashboard verification

`/compte` renders:

- **Badge card** — participant identity + `BadgeStatus` pill.
- **Access matrix** — per-room grant/deny.
- **Status card** — `Participant.status` + `participationChoice` +
  registered-at date.
- **Applications card** — every Application with type + status pill,
  never overwrites another.
- **Opportunities card** — filters `OPPORTUNITIES` against
  `applications.type`, so already-applied roles disappear. Visitor is
  intentionally **not** in the `OPPORTUNITIES` list (Visitor is a
  participation, not an Application), so a user who registered as
  Visitor still sees SPEAKER + SPONSOR + PARTNER + CONTENT_CREATOR
  suggestions.

## 9. Legacy cleanup status

| Item                                    | State                              | Runtime references |
|-----------------------------------------|------------------------------------|--------------------|
| `app/register/[slug]/**`                | Deleted                            | 0                  |
| `app/register/participation/page.tsx`   | Redirect module (308 → /register)  | Compat only        |
| `app/actions/onboarding.ts`             | Deleted                            | 0                  |
| `components/forms/basic-registration-form.tsx` | Deleted                    | 0                  |
| `components/forms/primitives.tsx`       | Deleted                            | 0                  |
| `components/forms/selection-cards.tsx`  | Deleted                            | 0                  |
| `lib/onboarding.ts`                     | Shrunk to `endOnboardingSession`   | Called by `logoutAccount` |
| `prisma.OnboardingSession` model        | **Retained**                       | Only cookie cleanup |
| `components/forms/submission-state.tsx :: FormErrorBanner` | Retained (dead export) | Not imported anywhere — file also exports `SuccessScreen` used by `/register/complete` |

Neither the `OnboardingSession` model nor `endOnboardingSession` is
required for correctness after the 45-minute post-deploy transition
window elapses. Both are safe to remove in a follow-up commit; not
done here to keep this audit non-destructive.

## 10. Build status

Registration code produces **0 new type errors** and **0 new build
errors**.

30 pre-existing type errors remain, all in the `emailTemplate` code
path (`lib/email/templates/service.ts`, `lib/email/queue.ts:62`,
`app/admin/(protected)/settings/email/templates/**`,
`scripts/email-template-service.test.ts`). These reference
`prisma.emailTemplate` / `prisma.emailTemplateVersion` / `EmailTemplate`
type — **the Prisma models were never added to `schema.prisma`**.

### Build investigation

```
Root cause:      Code in lib/email/templates/service.ts (and admin
                 templates pages + queue.ts:62) imports `EmailTemplate`
                 from @prisma/client and calls `prisma.emailTemplate.*`
                 and `prisma.emailTemplateVersion.*` — neither model
                 exists in prisma/schema.prisma.
Affected files:  lib/email/templates/service.ts
                 lib/email/queue.ts (line 62 only)
                 app/admin/(protected)/settings/email/templates/[key]/page.tsx
                 app/admin/(protected)/settings/email/templates/[key]/editor-client.tsx
                 app/admin/(protected)/settings/email/templates/actions.ts
                 scripts/email-template-service.test.ts
First introducing commit:
                 861f883 "production V1"
Why unrelated to registration:
                 The `queueTemplatedEmail` path used by all five role
                 flows lives in lib/email/queue.ts (not the ".templates"
                 subdirectory) and reads from lib/admin/email-templates.ts
                 (a static TypeScript module). It never touches the
                 missing Prisma models. Removing the broken files would
                 not change registration behaviour.
Recommended resolution:
                 EITHER add the `EmailTemplate` + `EmailTemplateVersion`
                 Prisma models (if the intent is a DB-backed template
                 editor)
                 OR delete the orphaned service.ts + admin template
                 pages + editor-client (if the static TS templates in
                 lib/admin/email-templates.ts are the intended source
                 of truth).
                 The evidence in the current codebase is ambiguous —
                 both a static module (lib/admin/email-templates.ts) and
                 the DB-backed skeleton coexist. This needs a product
                 decision, not an engineering guess. Do NOT decide from
                 this audit.
Risk of leaving unresolved:
                 `npm run build` fails, so production builds cannot be
                 produced by CI. `npm run dev` and the registration flow
                 itself work fine (Next.js dev mode is more lenient
                 about type errors). Registration is functionally
                 deployable via dev-mode or by patching the build to
                 skip type-checking, but neither is acceptable for a
                 production release.
```

## 11. Production deployment sequence

The project has never used `prisma migrate deploy` (there is no
`prisma/migrations/` directory). The Commit 1 convention is:

```
1. Deploy the code.
2. npm ci
3. npx prisma generate
4. npx prisma db push
   (adds REGISTERED enum value; additive, safe on live DB)
5. npx tsx scripts/apply-badge-index.ts
   (partial unique index on BadgeCredential; idempotent via IF NOT EXISTS)
6. npm run db:migrate-pending-to-registered
   (one-shot sweep; idempotent — re-runs report 0 rows if already done)
7. Verify: SELECT status, COUNT(*) FROM "Participant" GROUP BY status;
   Expect zero PENDING rows.
8. Start the app.
```

Migration script safety verified:
- Idempotent: repeated runs after 0 PENDING report `"nothing to do"`.
- Safe when zero rows exist: the `before === 0` early return.
- Safe cast: `'REGISTERED'::"RegistrationStatus"` explicit enum cast.
- Rollback: `npm run db:rollback-registered-to-pending` (mirror script).

## 12. Data audit — DEV database only

Snapshot from `getplus_summit_2026` (dev Postgres container). **These
are DEV counts. They are not production state.**

```
Participant.status:
  REGISTERED  7
  CONFIRMED   8
  CANCELLED   1
  PENDING     0    ← migration was cleanly applied

Participant.accountUserId:
  NULL (anonymous)     12    ← claimable via email verification
  NOT NULL (bound)      4

Application:
  SPONSOR         · UNDER_REVIEW  21
  SPONSOR         · RECEIVED       6
  SPEAKER         · RECEIVED       2
  PARTNER         · RECEIVED       4
  CONTENT_CREATOR · RECEIVED       4

BadgeCredential:
  ACTIVE   1     ← partial unique index verified
  REVOKED  4
```

## 13. Mobile readiness

Every identity + credential surface a mobile app would need is
web-agnostic:

- `AccountUser` — password + `AccountSession` (cookie-based today,
  trivially swappable for a bearer-token surface).
- `Participant` — pure data model.
- `Application` — pure data model.
- `BadgeCredential` — raw token in QR, sha256 at rest; QR scannable by
  any client.
- `CheckIn` — records via `verifyBadgeToken(rawToken)` which needs only
  the raw token from a QR — no browser API involved.

Web-only assumptions to fix before mobile:
- Password hashing lives in `lib/admin/password` (scrypt) — no
  browser-specific crypto, safe for a mobile-backed API.
- Session issue currently sets an HttpOnly cookie; a mobile client
  needs a token-in-body variant (add a new route; do not change the
  cookie flow for the web).
- Rate limiter is in-process only — a multi-instance API deploy needs a
  shared store (Redis) before serving mobile at scale.

None of these block Commit 2's registration guarantees; they are
Phase-3 mobile infrastructure work.

## 14. Payment separation

Verified. The invariant

```
Registration ≠ Application approval ≠ Payment ≠ Room booking
```

holds:

- No public registration route reads `paymentStatus`.
- `/compte/badge` gates only on `status !== CANCELLED`.
- `generateOrRotateMyBadge` gates only on `status !== CANCELLED`.
- Payment fields (`paymentStatus`, `paymentAmount`, `paymentRef`,
  `paidAt`) remain intact for future use — nothing was removed.

## 15. Room / accommodation separation

Verified. The room registration layer is fully untouched by both
Commit 1 and Commit 2:

- `RoomRegistration`, `ParticipantAccess`, `RoomPaymentEvent` unchanged.
- `lib/room-registration/service.ts` unchanged.
- Admin room-registrations panel unchanged.
- `/compte/acces` unchanged.

Room registration remains a distinct post-registration service.

## 16. Test results

```
test:register-refactor       10/10 PASS
test:register-professional    9/9  PASS
test:register-concurrency     8/8  PASS   ← new in this audit
test:legacy-routes            8/8  PASS
test:safe-next               21/21 PASS
test:badge                   28/28 PASS
test:email-verification       6/6  PASS
──────────────────────────────────────
TOTAL                        90/90 PASS

typecheck: 30 pre-existing errors, 0 new
           (all in emailTemplate orphan path — see §10)

build:     FAIL — pre-existing baseline errors only
           (Commit 1, Commit 2, and Commit 1's parent all fail identically)
```

## 17. Remaining risks

1. **`emailTemplate` build failure** (blocker for CI production builds).
   Not a registration correctness issue; needs a product decision on
   whether the DB-backed template editor is intended or the static
   `lib/admin/email-templates.ts` is the source of truth.
2. **Legacy anonymous Participants** (12 rows in DEV). Cannot be
   claimed until the owner signs up an AccountUser with the matching
   email AND clicks the verification link. Communication may be needed
   before the event.
3. **`OnboardingSession` DB model + `endOnboardingSession` helper**
   retained until the 45-min post-deploy transition window elapses.
   Safe to drop in a follow-up commit.
4. **Admin registrant detail page does not inline applications.**
   Admins currently cross-reference via `/admin/applications`. Not a
   correctness bug; ergonomic gap only.
5. **In-process rate limiter** — a multi-instance production deploy
   would multiply the effective threshold by instance count. Acceptable
   for a single-instance deploy; Redis-backed limiter is Phase-3 work.
6. **Dead export `FormErrorBanner`** in
   `components/forms/submission-state.tsx`. Cleanup, not risk.

## 18. Recommended next engineering step

Resolve the `emailTemplate` build failure (§10). This is the **only
blocker** for a real production build. The decision required is
product-level (add the missing Prisma models vs. delete the orphan
files). Once resolved, `npm run build` will succeed and the
registration system as delivered by commits `291844e / 40dd026 /
23a31dd` is ready for production deployment following the sequence
in §11.

Do NOT begin payment or mobile work before that blocker is closed.
