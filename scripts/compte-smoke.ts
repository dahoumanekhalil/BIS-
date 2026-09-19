// Manual smoke check for the /compte tree — Phase 4.
//
// Two scenarios exercised in a single run:
//   1. AccountUser + fully-populated Participant → every /compte/* route
//      returns 200 with expected content markers.
//   2. AccountUser with NO Participant → every route still returns 200 and
//      shows the "complete your registration" prompt (no crash on missing
//      participant).
//
// Run against a running dev server:
//   npm run dev          (in one terminal)
//   npx tsx scripts/compte-smoke.ts
//
// Cleans up both accounts on exit.

import { createHash, randomBytes } from "node:crypto";
import {
  ApplicationStatus,
  ApplicationType,
  CheckInResult,
  ParticipationChoice,
  PaymentStatus,
  PrismaClient,
  RegistrationStatus
} from "@prisma/client";
import { hashPassword } from "../lib/admin/password";

const BASE = "http://localhost:3000";
const COOKIE_NAME = "bis_account_session";
const ACCOUNT_TTL_MS = 1000 * 60 * 60; // 1h — long enough for the smoke run.

const prisma = new PrismaClient();

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function ensureEvent() {
  const ev = await prisma.event.findFirst({ orderBy: { startsAt: "asc" } });
  if (ev) return ev;
  return prisma.event.create({
    data: {
      slug: `smoke-event-${Date.now()}`,
      name: "Smoke Event",
      startsAt: new Date("2026-11-15T08:00:00Z"),
      endsAt: new Date("2026-11-17T18:00:00Z"),
      city: "Alger",
      venue: "CIC",
      country: "DZ"
    }
  });
}

async function openSession(userId: string): Promise<string> {
  const rawToken = randomBytes(32).toString("base64url");
  await prisma.accountSession.create({
    data: {
      userId,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + ACCOUNT_TTL_MS)
    }
  });
  return rawToken;
}

type Check = { path: string; expect: RegExp[] };

// React inserts `<!-- -->` between adjacent text nodes when a JSX
// expression splits them, so anything like `Bonjour, {firstName}` never
// appears as a contiguous string. Every "greeting" regex matches
// non-greedily across the boundary.

const populatedChecks: Check[] = [
  {
    path: "/compte",
    expect: [
      /Bonjour,.*?Smoke/i,
      /BIS\+ Espace personnel/i,
      /Votre credential digital/,
      /Salles du sommet/,
      /Statut/
    ]
  },
  {
    path: "/compte/badge",
    expect: [
      // Physical neck-badge (BadgeCard) — brand + event context.
      /BIS/,
      /Algeria Brand Impact/,
      /Summit 2026/,
      /15 Novembre 2026/,
      /CIC Alger/,
      // Client-side controls (server-rendered initial markup).
      /Credential digital/,
      // Fresh smoke participant has never generated a badge → "Générer mon badge".
      /Générer mon badge/,
      /Sponsor/i
    ]
  },
  {
    path: "/compte/acces",
    expect: [
      /Mon accès BIS 2026/i,
      /Entrée principale/,
      /Salle 01/,
      /Salle 02/,
      /Salle 03/,
      /Salle 04/,
      /Salle 05/,
      // Tri-state UI (pre-Phase-5 hardening): granted rooms → "Autorisé",
      // explicit denials → "Refusé", missing rows → "Non attribué". The
      // fixture below grants 3 rooms + main, denies room-02, and leaves
      // room-04 without any row.
      /Autorisé/,
      /Refusé/,
      /Non attribué/,
      // Phase 6: history card is populated with the CheckIns seeded below.
      /Passages enregistrés/,
      /Accès enregistré/,
      /Déjà présent/,
      // Legacy CheckIn (accessPointId=null) renders the neutral label.
      /Point d'accès non répertorié/
    ]
  },
  {
    path: "/compte/inscription",
    expect: [/Mon inscription BIS 2026/, /Code billet/, /Réglé/]
  },
  {
    path: "/compte/profil",
    expect: [/Informations personnelles/, /Modifier mon profil/]
  },
  {
    path: "/compte/demandes",
    expect: [/Demande Sponsor/i, /En cours d'examen/i]
  },
  {
    path: "/compte/securite",
    expect: [/Session active/, /Se déconnecter/, /Bientôt disponible/]
  }
];

// AccountUser exists, no Participant. Every route must degrade gracefully
// to an invitation to finish registration — no 500s.
const emptyChecks: Check[] = [
  { path: "/compte", expect: [/Finalisez votre inscription/i, /Compléter mon inscription/i] },
  { path: "/compte/badge", expect: [/Badge indisponible/i] },
  // Phase 6: empty account has no participant → the page's early-exit
  // renders "Accès non disponibles" (participant-scoped history is never
  // reached for a null participant).
  { path: "/compte/acces", expect: [/Accès non disponibles/i] },
  { path: "/compte/inscription", expect: [/Aucune inscription active/i] },
  { path: "/compte/profil", expect: [/Informations personnelles/] },
  { path: "/compte/demandes", expect: [/Aucune demande/i, /Découvrir les rôles/i] },
  { path: "/compte/securite", expect: [/Session active/] }
];

async function runChecks(label: string, cookie: string, checks: Check[]) {
  console.log(`\n→ ${label}`);
  let failed = 0;
  for (const c of checks) {
    const res = await fetch(BASE + c.path, {
      headers: { cookie },
      redirect: "manual"
    });
    const body = await res.text();
    const missing = c.expect.filter((rx) => !rx.test(body));
    const pass = res.status === 200 && missing.length === 0;
    console.log(
      `  ${pass ? "✓" : "✗"} ${c.path.padEnd(22)} status=${res.status}${
        missing.length ? ` missing=${missing.map((r) => r.source).join(", ")}` : ""
      }`
    );
    if (!pass) failed++;
  }
  return failed;
}

async function main() {
  const event = await ensureEvent();

  // ── Scenario 1: fully populated account. ─────────────────────────────
  const emailA = `smoke-a-${Date.now()}@bis.dz`;
  const userA = await prisma.accountUser.create({
    data: {
      email: emailA,
      firstName: "Smoke",
      lastName: "Tester",
      passwordHash: hashPassword("smoke-only-do-not-use")
    }
  });
  const participantA = await prisma.participant.create({
    data: {
      eventId: event.id,
      accountUserId: userA.id,
      firstName: "Smoke",
      lastName: "Tester",
      email: emailA,
      phone: "+213 500 000 000",
      country: "Algérie",
      organization: "Smoke Studio",
      jobTitle: "Founder",
      status: RegistrationStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      paymentAmount: 45000,
      paymentRef: "BIS-SMOKE-000001",
      paidAt: new Date(),
      ticketCode: `BIS-SMOKE-${Date.now().toString().slice(-6)}`,
      participationChoice: ParticipationChoice.SPONSOR,
      profile: "COMPANY",
      companyIndustry: "Tech",
      companyWebsite: "https://example.com",
      companySize: "10-50"
    }
  });

  // Tri-state matrix on purpose:
  //   • main, room-01, room-03, room-05 → row with granted=true    ("Autorisé")
  //   • room-02                          → row with granted=false   ("Refusé")
  //   • room-04                          → NO row                   ("Non attribué")
  const points = await prisma.accessPoint.findMany();
  const grantSlugs = new Set(["main", "room-01", "room-03", "room-05"]);
  const denySlugs = new Set(["room-02"]);
  for (const p of points) {
    if (grantSlugs.has(p.slug)) {
      await prisma.participantAccess.create({
        data: {
          participantId: participantA.id,
          accessPointId: p.id,
          granted: true
        }
      });
    } else if (denySlugs.has(p.slug)) {
      await prisma.participantAccess.create({
        data: {
          participantId: participantA.id,
          accessPointId: p.id,
          granted: false
        }
      });
    }
    // Any slug not in either set is intentionally left without a row.
  }
  await prisma.application.create({
    data: {
      eventId: event.id,
      participantId: participantA.id,
      type: ApplicationType.SPONSOR,
      status: ApplicationStatus.UNDER_REVIEW,
      firstName: "Smoke",
      lastName: "Tester",
      email: emailA,
      phone: "+213 500 000 000",
      organization: "Smoke Studio",
      details: {}
    }
  });

  // Phase 6 — seed a small CheckIn history so /compte/acces exercises the
  // history-rendering path (VALID at main, ALREADY_CHECKED_IN at room-01,
  // plus one legacy row with accessPointId=null to prove the neutral
  // fallback label appears).
  const pointBySlug = new Map(points.map((p) => [p.slug, p.id]));
  const now = Date.now();
  await prisma.checkIn.createMany({
    data: [
      {
        participantId: participantA.id,
        ticketCode: "SMK-VALID",
        gate: "main",
        accessPointId: pointBySlug.get("main"),
        result: CheckInResult.VALID,
        scannedAt: new Date(now - 60_000 * 5)
      },
      {
        participantId: participantA.id,
        ticketCode: "SMK-ALREADY",
        gate: "room-01",
        accessPointId: pointBySlug.get("room-01"),
        result: CheckInResult.ALREADY_CHECKED_IN,
        scannedAt: new Date(now - 60_000 * 3)
      },
      {
        participantId: participantA.id,
        ticketCode: "SMK-LEGACY",
        gate: "Gate A",
        // accessPointId deliberately omitted → simulates pre-Phase-1 row.
        result: CheckInResult.VALID,
        scannedAt: new Date(now - 60_000 * 30)
      }
    ]
  });

  const tokenA = await openSession(userA.id);
  const cookieA = `${COOKIE_NAME}=${tokenA}`;

  // ── Scenario 2: AccountUser without a Participant. ───────────────────
  const emailB = `smoke-b-${Date.now()}@bis.dz`;
  const userB = await prisma.accountUser.create({
    data: {
      email: emailB,
      firstName: "Empty",
      lastName: "Tester",
      passwordHash: hashPassword("smoke-only-do-not-use")
    }
  });
  const tokenB = await openSession(userB.id);
  const cookieB = `${COOKIE_NAME}=${tokenB}`;

  const failedA = await runChecks(
    `populated account (${emailA})`,
    cookieA,
    populatedChecks
  );
  const failedB = await runChecks(
    `empty account (${emailB})`,
    cookieB,
    emptyChecks
  );

  console.log("\n→ cleanup");
  // Delete the seeded CheckIns first. If we relied on
  // `participant.delete` alone, the schema's `onDelete: SetNull` on
  // `CheckIn.participantId` would leave orphan rows accumulating across
  // smoke runs. We identify the smoke rows by the "SMK-" prefix on
  // `ticketCode` so we don't touch any unrelated CheckIn history.
  await prisma.checkIn.deleteMany({
    where: { ticketCode: { startsWith: "SMK-" } }
  });
  await prisma.participant.delete({ where: { id: participantA.id } });
  await prisma.accountUser.delete({ where: { id: userA.id } });
  await prisma.accountUser.delete({ where: { id: userB.id } });
  await prisma.$disconnect();

  const total = failedA + failedB;
  if (total > 0) {
    console.error(`\n${total} smoke check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll /compte/* routes rendered successfully in both scenarios.");
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
