# BIS 2027 — Payment Removal Phase 1 + 2

Implementation report for the operational payment dependency removal.
Read alongside `docs/payment-removal-discovery-audit.md`.

## 1. Starting commit

```
8299990 docs(payment): read-only removal discovery audit
```

## 2. Files changed

Modified:
- `lib/admin/main-entrance-validator.ts` — removed the paymentStatus gate
- `lib/admin/room-validator.ts` — same
- `lib/admin/text-checkin-validator.ts` — same
- `scripts/main-entrance.test.ts` — flipped the UNPAID test + added a
  regression assertion that no scan path produces `outcome: "UNPAID"`
- `scripts/room.test.ts` — flipped the UNPAID+PA=true test + added
  regression for UNPAID+noPA still denied via `PA_NOT_GRANTED`
- `scripts/text-checkin.test.ts` — flipped the UNPAID+valid-code test
- `scripts/rbac.test.ts` — dropped the assertions on
  `revenue.view` / `revenue.reconcile` (permissions removed)
- `components/admin/sidebar.tsx` — removed the "Revenue" nav item
- `app/admin/(protected)/registrants/page.tsx` — dropped the `payment`
  searchParam and its filter argument
- `app/admin/(protected)/registrants/filter-bar.tsx` — removed the
  Paiement dropdown + PAYMENTS const + `payment` in activeFilters
- `app/admin/(protected)/registrants/registrant-row.tsx` — dropped
  `paymentStatus`/`paymentAmount` fields, the PAID pill on the row and
  hover-card header, and the "Paiement" row inside the hover card
- `lib/admin/queries.ts` — removed the `payment` filter branch,
  `paymentRef` search term, and `paymentStatus`/`paymentAmount`
  selects from `listRegistrants`
- `lib/admin/rbac.ts` — removed `revenue.view` and `revenue.reconcile`
  permissions; simplified the ADMIN filter and FINANCE role
- `lib/admin/role-catalog-data.ts` — removed the "revenue" catalog entry

Deleted:
- `app/admin/(protected)/revenue/page.tsx`

## 3. Check-in changes

Same shape for all three validators.

### `lib/admin/main-entrance-validator.ts`

**Previous** — gates in order:
```
PARTICIPANT_CANCELLED (from verifyBadgeToken)
status === CANCELLED
paymentStatus !== PAID          ← removed
PA row granted === false
atomic checkedInAt claim
```

**New** — gates in order:
```
PARTICIPANT_CANCELLED (from verifyBadgeToken)
status === CANCELLED
PA row granted === false
atomic checkedInAt claim
```

**Preserved**: AccessPoint slug re-resolution (never trusts the client),
`active` check, `type === MAIN_ENTRANCE` check, `verifyBadgeToken`
(all four failure reasons: INVALID / REVOKED / EXPIRED /
PARTICIPANT_CANCELLED), whitelist Prisma select (never fetches
`passwordHash` / `sessionToken` / `reviewNotes` / `paymentRef`),
PA_REVOKED tri-state, atomic first-scan claim via `updateMany where
checkedInAt: null`, ALREADY_CHECKED_IN path, AuditLog+CheckIn
discipline, no rawToken/tokenHash logging.

### `lib/admin/room-validator.ts`

**Previous** — gates in order:
```
PARTICIPANT_CANCELLED (from verifyBadgeToken)
status === CANCELLED
paymentStatus !== PAID          ← removed
!paRow → PA_NOT_GRANTED
paRow.granted === false → PA_REVOKED
grant fresh CheckIn(VALID)
```

**New** — gates in order:
```
PARTICIPANT_CANCELLED (from verifyBadgeToken)
status === CANCELLED
!paRow → PA_NOT_GRANTED (default-deny — unchanged)
paRow.granted === false → PA_REVOKED
grant fresh CheckIn(VALID)
```

**Preserved**: strict `type === ROOM`, PA row required + granted=true
(rooms remain default-deny per spec §14), no `checkedInAt` mutation,
no atomic claim, repeat entry allowed.

### `lib/admin/text-checkin-validator.ts`

**Previous** — same as main-entrance / room, with the additional
front matter: rate limit + `checkinCode` lookup.

**New** — identical to the two QR validators (same order, same reason
strings). The header comment now reflects the removed UNPAID gate.

**Preserved**: per-IP + per-operator rate limit BEFORE the DB lookup,
`normalizeCheckinCode`, `checkinCode` unique-index lookup, generic
`TEXT_INVALID` for both malformed-and-unknown codes (enumeration
protection), raw code never in AuditLog, `checkin.scan.text` audit
action name.

### Not touched

- `CheckInResult.UNPAID` enum value — kept in the Prisma schema and in
  `MESSAGES` maps for backward compatibility with historical CheckIn
  rows. Documented as "no longer produced".
- `ScannerOutcome` union — kept `"UNPAID"` for the same reason.
- `PaymentStatus` enum + `Participant.paymentStatus` — retained
  (§15).
- `lib/admin/client-logs.ts` UNPAID row rendering — retained for
  historical CheckIn rows.
- Legacy manual `check-in/actions.ts` flow — untouched (it does not
  contain a payment gate).

## 4. Admin changes

Removed (Phase 2):
- `/admin/revenue` route + page module.
- Sidebar "Revenue" nav item.
- Registrant list `payment` filter dropdown.
- Registrant row PAID pill (on the row + on the hover card header).
- Hover-card "Paiement" row.
- `listRegistrants` `payment` filter argument.
- `listRegistrants` `paymentStatus` + `paymentAmount` select fields.
- `paymentRef` from the search-term OR clause.

Preserved:
- `lib/admin/queries.ts::getAdminOverview` — still aggregates
  paid / unpaid / revenue for the KPI cards on `/admin/dashboard`.
  This is legacy admin reporting that reads the retained payment
  columns; no admin has been given a new payment-write surface.
- Registrant edit form still exposes `paymentStatus / paymentAmount /
  paymentRef` — this is legitimate admin editing of legacy data and
  is not a check-in gate. Retained until Phase 3.
- Registrant detail page audit logs — still render historical payment
  events (§17 of audit).

## 5. RBAC changes

Removed from `PERMISSIONS`:
- `revenue.view`
- `revenue.reconcile`

Effect:
- SUPER_ADMIN, ADMIN, FINANCE no longer expose these entries.
- `role-catalog-data.ts` "revenue" section removed.
- `rbac.test.ts` assertion on `can(ADMIN, "revenue.*")` removed — the
  strings are no longer valid `Permission` values.

Retained (§16 — room domain out of scope):
- `payment.confirm.room`
- `payment.refund.room`
- FINANCE role continues to hold both.

## 6. Email changes

None. `lib/email/triggers/room-registration.ts` and the entire email
queue / worker / provider / verification / password-reset
infrastructure are unchanged. Room-registration payment triggers
still exist because the room-registration domain still exists (§16).

## 7. Database

```
Schema changed:   NO
Data changed:     NO
Migrations run:   NO
```

No `prisma db push`, no data migration, no destructive command. The
Prisma columns / enums / models called out by the discovery audit
(`Participant.paymentStatus/Amount/Ref/paidAt`, `PaymentStatus` enum,
`RoomPaymentEvent`, `RoomPaymentEventKind`, `CheckInResult.UNPAID`,
`AdmissionMode`, `AccessPoint.priceMinor/currency`,
`RoomRegistration` payment fields) all remain as-is.

## 8. Remaining payment artifacts

Intentionally kept in this phase:

| Item | Reason |
|---|---|
| `PaymentStatus` enum + Prisma columns | Historical data; Phase 3 |
| `CheckInResult.UNPAID` enum value | Historical CheckIn rows |
| `ScannerOutcome` `"UNPAID"` variant | Historical audit log rendering |
| Admin registrant edit form payment fields | Admin editing of legacy data |
| `getAdminOverview` payment KPIs on dashboard | Legacy reporting; not a gate |
| `lib/room-registration/**` (whole domain) | §16 — product decision pending |
| `RoomPaymentEvent` model | Room domain preserved |
| `payment.confirm.room` / `payment.refund.room` | Room domain preserved |
| `lib/admin/client-logs.ts` UNPAID rendering | Historical CheckIn display |

## 9. Room system

Not redesigned. Not touched.
- `RoomRegistration`, `ParticipantAccess`, `RoomPaymentEvent`,
  `AdmissionMode`, `RoomRegistrationStatus`, `RoomPaymentEventKind`
  are all unchanged in schema and code.
- `lib/room-registration/**` unchanged.
- `/compte/acces` unchanged.
- Admin room-registrations panel unchanged.
- The room validator's PA-row default-deny + PA_REVOKED semantics
  unchanged — the only removed line is the paymentStatus gate.

## 10. Security verification

| Check                | Result | Evidence |
|----------------------|--------|----------|
| Authentication       | OK     | All three validators still take an already-authorized `user`; wrapper actions still call `requirePermission("access.validate.main"/"room"/"checkin.validate")` |
| Authorization        | OK     | RBAC helpers unchanged; `access.validate.*` gates unchanged |
| IDOR                 | OK     | Validators still re-resolve AccessPoint by slug + Participant by verifyBadgeToken result; no client-supplied id trusted |
| Badge ownership      | OK     | `verifyBadgeToken` still authoritative for ACTIVE/EXPIRED/REVOKED/INVALID; sha256-at-rest unchanged |
| Cancellation         | OK     | Two independent CANCELLED denials remain — one from `verifyBadgeToken → PARTICIPANT_CANCELLED`, one from the direct `status === CANCELLED` check |
| Revocation           | OK     | `verifyBadgeToken` still returns `REVOKED` for revoked BadgeCredentials |
| CSRF                 | OK     | Next.js server actions unchanged |
| Rate limiting        | OK     | Text-checkin validator still runs per-IP + per-operator rate limit before any DB lookup |
| Audit                | OK     | Every scan attempt still writes exactly one AuditLog row; CheckIn writes preserved for all non-badge-invalid paths |
| Concurrency          | OK     | Main-entrance atomic `updateMany where checkedInAt: null` unchanged — the ALREADY_CHECKED_IN semantics survive |
| Data-safety selects  | OK     | Whitelist Prisma selects trimmed to remove `paymentStatus`; no new sensitive fields introduced |

**Explicit rebuttal to the spec §14 concern**: removing the payment
check has NOT turned payment verification into unrestricted access.
The CANCELLED guard directly above the removed line + the
`PARTICIPANT_CANCELLED` path returned by `verifyBadgeToken` above it
still block cancelled attendees. In the room validator, the
default-deny `!paRow` branch and the explicit `granted === false`
branch continue to enforce room-level authorization independently.

## 11. Test results

Executed against a live dev Postgres.

```
test:main-entrance          25/25 PASS
test:room                   23/23 PASS
test:text-checkin           28/28 PASS
test:rbac                   31/31 PASS
test:checkin-analytics      22/22 PASS   (regression — uses UNPAID enum, still works)
test:checkin-analytics-phase21  20/20 PASS
test:register-refactor      10/10 PASS
test:register-professional   9/9  PASS
test:register-concurrency    8/8  PASS
test:legacy-routes           8/8  PASS
test:safe-next              21/21 PASS
test:badge                  28/28 PASS
test:email-verification      6/6  PASS
────────────────────────────────────
TOTAL                      247/247 PASS
```

## 12. Build / typecheck status

- **Typecheck**: 30 pre-existing errors (all `emailTemplate*` — see
  `docs/registration-production-readiness.md` §10), **0 new**. Verified
  by diffing against the pre-change error set.
- **Build**: `next build` still fails on the same `emailTemplate`
  errors. Not touched — **PRE-EXISTING BASELINE FAILURE — NOT
  INTRODUCED BY PAYMENT REMOVAL PHASE 1/2**.

## 13. Remaining blockers

1. **`emailTemplate` build failure** — unchanged from Commit 1
   documentation. Independent of payment. Still blocks CI production
   builds.
2. **Product decisions from `payment-removal-discovery-audit.md`**
   still open before Phase 3 can run:
   - Historical payment data retention (archive vs freeze vs drop)
   - Room self-registration architecture (Option A vs B)
   - Production payment-data counts
3. **`getAdminOverview`** still computes `revenue` from `paymentAmount`
   for the dashboard KPI cards. Cosmetic; the numbers reflect legacy
   data and will freeze once the payment columns are dropped in
   Phase 3.

## 14. Recommended Phase 3

Blocking on product decisions 2.a and 2.b above. Once resolved:

1. Archive existing `Participant.paymentStatus/Amount/Ref/paidAt` +
   `RoomPaymentEvent` rows if retention says archive.
2. Drop columns / models / enums per the discovery audit's dependency
   graph.
3. Retire the retained `CheckInResult.UNPAID` enum value + the
   `"UNPAID"` `ScannerOutcome` variant + the retained `UNPAID`
   entries in `MESSAGES` maps.
4. Remove `getAdminOverview`'s payment aggregations + the dashboard
   revenue KPI card.
5. Remove the admin registrant edit form payment fields.
6. Remove `lib/admin/client-logs.ts` UNPAID rendering.
7. If Option B: remove `lib/room-registration/**`, delete
   `RoomRegistration` + `RoomPaymentEvent` + `AdmissionMode` +
   `RoomPaymentEventKind` + `AccessPoint.priceMinor/currency`, delete
   `payment.confirm.room` / `payment.refund.room`.
8. Final regression + a fresh `db push`.

Phase 3 is destructive; do not begin without explicit approval.
