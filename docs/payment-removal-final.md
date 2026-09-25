# BIS 2027 — Final payment-removal state

Effective 2026-09-25. This document supersedes the earlier
`payment-removal-discovery-audit.md` and `payment-removal-phase-1-2.md`;
those are retained only as historical logs.

## 1. Product decision

**BIS 2027 operates without any payment subsystem.** There is:

- no payment provider
- no payment API route
- no payment webhook
- no payment secrets
- no payment transactions
- no payment confirmation, failure, refund, or expiration
- no revenue subsystem or dashboards
- no paid rooms or PAID admission mode
- no payment-based access authorization

## 2. Current room-registration architecture

Room access is a FREE-only self-service registration flow.

```
AccessPoint (ROOM)                         AccessPoint (MAIN_ENTRANCE)
      │                                             │
      ▼                                             │
RoomRegistration                                    │
  status ∈ { FREE_CONFIRMED, CANCELLED }            │
      │                                             │
      ▼   syncRoomAccessEntitlement                 │
      │   (transactional, idempotent)               │
      ▼                                             ▼
ParticipantAccess.source = REGISTRATION      ParticipantAccess.source = ADMIN
      │                                             │
      └────────────────┬────────────────────────────┘
                       ▼
              Room QR / text validator
              (reads `granted === true` only)
                       │
                       ▼
                    CheckIn
```

### Domain surface

`lib/room-registration/service.ts` exposes exactly two public operations:

- `initRegistration({ participantId, accessPointId })` — creates or
  re-activates a FREE registration for the participant at a ROOM
  AccessPoint. Idempotent; re-invoking on an existing FREE_CONFIRMED row
  is a no-op.
- `cancel({ participantId, accessPointId, actorAdminId, reason? })` —
  cancels an active registration and revokes the REGISTRATION-owned
  `ParticipantAccess` row (never touches ADMIN-owned rows).

There is no `confirmPayment`, `failPayment`, `refund`, or `expire` in
the FREE-only kernel.

### State machine

```
FREE_CONFIRMED ──cancel──▶ CANCELLED
     ▲                        │
     └───init (re-register)───┘
```

`RoomRegistrationStatus` has exactly two values now: `FREE_CONFIRMED`
and `CANCELLED`.

## 3. Authorization model

The final authorization model does NOT consult any payment status. The
validators enforce, in order:

1. Badge validity (ACTIVE, unrevoked, unexpired)
2. `participant.status !== CANCELLED`
3. `ParticipantAccess` presence + `granted` boolean

Rooms are default-deny; the main entrance is default-allow modulo
`granted=false` (explicit admin revocation).

The `AccessGrantSource` boundary is preserved so admin overrides survive
across registration lifecycles:

- `ADMIN` rows are NEVER touched by the sync layer.
- `REGISTRATION` rows are materialized/revoked exclusively by
  `syncRoomAccessEntitlement`.

## 4. Schema — final shape

Removed models: `RoomPaymentEvent`.

Removed enums: `PaymentStatus`, `RoomPaymentEventKind`, `AdmissionMode`.

Removed fields (`Participant`): `paymentStatus`, `paymentAmount`,
`paymentRef`, `paidAt`.

Removed fields (`AccessPoint`): `priceMinor`, `currency`, `admissionMode`.

Removed fields (`RoomRegistration`): every payment-derived state
(`priceMinorSnapshot`, `currencySnapshot`, `paymentRef`, `paidAt`,
`expiresAt`, and every payment-only lifecycle status such as
`PENDING_PAYMENT`, `PAID`, `PAYMENT_FAILED`, `REFUNDED`, `EXPIRED`).

`RoomRegistrationStatus` reduced to `FREE_CONFIRMED | CANCELLED`.

## 5. RBAC — final shape

Removed permissions: `payment.confirm.room`, `payment.refund.room`,
`revenue.view`, `revenue.reconcile`.

The `FINANCE` role remains as an ANALYTICS-adjacent read-only role
(`dashboard.view`, `registrants.view`, `analytics.view`, `audit.view`)
so historical assignments do not silently escalate.

## 6. Deleted implementation files

- `lib/room-registration/payment-adapter.ts`
- `lib/room-registration/audit.ts` (payment-event audit was folded into
  the plain admin audit helper)
- `app/admin/(protected)/registrants/[id]/room-payment-actions.ts`
- `app/admin/(protected)/spaces/[slug]/admission-panel.tsx`
- `scripts/apply-room-payment-idempotency.ts`
- `scripts/backfill-room-admission-mode.ts`
- `scripts/expire-room-registrations.ts`
- `scripts/paid-free-schema.test.ts`
- `scripts/paid-free-service.test.ts`
- `scripts/payment-reconciliation-safety.test.ts`
- `scripts/sub-phase-e-admin-ui.test.ts`

## 7. Historical tombstones kept in-tree

A few comments referring to `paymentStatus / paymentAmount / paymentRef`
are retained inline in `lib/admin/queries.ts`, `lib/admin/client-logs.ts`,
`lib/admin/email-templates.ts`, `app/admin/(protected)/registrants/*`
and the dashboard/side-nav. Every one is a tombstone marking *why* a
field or route is absent. None of them cause payment behaviour to
execute.

## 8. Tests

- `scripts/room-registration-actions.test.ts` was rewritten to exercise
  only the FREE-only surface (init + cancel, plus audit contract).
- `scripts/main-entrance.test.ts`, `scripts/room.test.ts`,
  `scripts/text-checkin.test.ts` had their UNPAID scenarios deleted;
  the CANCELLED / PA_REVOKED / PA_NOT_GRANTED coverage is preserved.
- `scripts/access-*`, `scripts/badge-credential.test.ts`,
  `scripts/admin-scan.test.ts`, `scripts/admin-spaces.test.ts`,
  `scripts/checkin-analytics*.test.ts`, `scripts/compte-smoke.ts`,
  `scripts/register-refactor.test.ts` had their `paymentStatus` /
  `PaymentStatus` / `AdmissionMode` fixture references removed.
