import {
  PrismaClient,
  PartnerTier,
  SessionType,
  SessionCategory,
  RegistrationTier,
  AdminRole,
  AdminStatus,
  AccessPointType
} from "@prisma/client";
import { hashPassword } from "../lib/admin/password";

const prisma = new PrismaClient();

// Dev-only shared password for every seeded admin account. This is a demo
// project — credentials are documented as comments in .env. In production the
// seed refuses to run entirely (see guard below), so this string is never
// used against a real database.
const DEV_ADMIN_PASSWORD = "admin123";

// Fail hard rather than wipe a prod database by mistake.
if (
  process.env.NODE_ENV === "production" &&
  process.env.ALLOW_DESTRUCTIVE_SEED !== "true"
) {
  console.error(
    "Refusing to run destructive seed in production. Set ALLOW_DESTRUCTIVE_SEED=true if you truly mean it."
  );
  process.exit(1);
}

// Extra belt-and-braces: even if someone unlocks the destructive guard in
// prod, refuse to seed the hardcoded dev password.
if (process.env.NODE_ENV === "production") {
  console.error(
    "seed.ts uses a hardcoded dev password. Refusing to run in production."
  );
  process.exit(1);
}

// Belt #3: NODE_ENV can be unset when running the seed against a remote
// database. Detect obvious non-local Postgres hosts in DATABASE_URL and
// refuse unless the caller explicitly opts in with SEED_ENV=dev.
{
  const url = process.env.DATABASE_URL ?? "";
  const localHosts = new Set([
    "localhost",
    "127.0.0.1",
    "::1",
    "postgres",
    "db"
  ]);
  const match = url.match(/^postgres(?:ql)?:\/\/[^@]*@([^:\/]+)/i);
  const host = match?.[1];
  const looksRemote = host !== undefined && !localHosts.has(host.toLowerCase());
  if (looksRemote && process.env.SEED_ENV !== "dev") {
    console.error(
      `DATABASE_URL points at a non-local host (${host}). Refusing to seed a ` +
        `hardcoded dev password there. Set SEED_ENV=dev to override.`
    );
    process.exit(1);
  }
}

async function main() {
  console.log("Seeding BIS 2027...");

  // CheckIn holds FKs to BadgeCredential and AccessPoint via SetNull, but
  // ParticipantAccess and BadgeCredential cascade from Participant, so their
  // rows go away automatically. Delete AccessPoints last (after the CheckIn
  // rows referencing them have been cleared) so we can reseed them cleanly.
  await prisma.checkIn.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.adminSession.deleteMany();
  await prisma.adminUser.deleteMany();
  await prisma.sessionSpeaker.deleteMany();
  await prisma.session.deleteMany();
  await prisma.speaker.deleteMany();
  await prisma.partner.deleteMany();
  await prisma.space.deleteMany();
  await prisma.participant.deleteMany();
  await prisma.accessPoint.deleteMany();
  await prisma.event.deleteMany();
  await prisma.siteContent.deleteMany();

  const event = await prisma.event.create({
    data: {
      slug: "getplus-summit-2027",
      name: "Algeria Brand Impact Summit 2027",
      tagline: "Le sommet de l'impact africain",
      description:
        "Le sommet stratégique où les marques sont construites comme des actifs financiers, des outils de souveraineté et des vecteurs d'influence. Trois piliers : Identity, Growth, Legacy.",
      startsAt: new Date("2027-11-15T08:00:00Z"),
      endsAt: new Date("2027-11-17T18:00:00Z"),
      city: "Alger",
      venue: "CIC Alger",
      country: "DZ",
      expectedAttendees: 12611
    }
  });

  // Legacy Spaces — GET BEYOND, GET ROOTED, GET ICONIC, GET CONNECTED
  const spaces = await Promise.all(
    [
      {
        slug: "get-beyond",
        name: "GET BEYOND",
        headline: "Lab du futur & innovation",
        description:
          "Le laboratoire des frontières — deep-tech, IA, climate-tech. Là où l'Afrique invente sa prochaine décennie.",
        color: "#2453E0",
        order: 1
      },
      {
        slug: "get-rooted",
        name: "GET ROOTED",
        headline: "Héritage culturel & impact",
        description:
          "L'héritage comme force motrice — patrimoine, culture, savoir-faire, transformation économique.",
        color: "#B8E62E",
        order: 2
      },
      {
        slug: "get-iconic",
        name: "GET ICONIC",
        headline: "Studio créatif & médias",
        description:
          "Le sommet devient média : podcasts, plateaux, captations. Chaque idée est produite, distribuée et amplifiée.",
        color: "#EC5B4F",
        order: 3
      },
      {
        slug: "get-connected",
        name: "GET CONNECTED",
        headline: "Hub réseau & B2B",
        description:
          "Rencontres orchestrées entre décideurs, entrepreneurs, investisseurs et institutions. Un capital relationnel structuré.",
        color: "#7C3AED",
        order: 4
      }
    ].map((s) => prisma.space.create({ data: { ...s, eventId: event.id } }))
  );

  // Speakers — names from the brief
  const speakerDefs = [
    { name: "Amira Diallo", title: "Fondatrice & CEO", org: "Diallo Ventures", country: "Sénégal" },
    { name: "Nadia Oussedik", title: "Directrice de l'innovation", org: "Axis Legacy", country: "Algérie" },
    { name: "Kofi Mensah", title: "Managing Partner", org: "Accra Capital", country: "Ghana" },
    { name: "Sara Meziane", title: "Head of Brand Strategy", org: "Meziane & Co", country: "Algérie" },
    { name: "Yasmine Benali", title: "Co-fondatrice", org: "BrandForge Africa", country: "Maroc" },
    { name: "Mehdi Chérif", title: "CTO", org: "Alger Deep Tech", country: "Algérie" },
    { name: "Fatou Sarr", title: "Directrice éditoriale", org: "Continental Media", country: "Sénégal" },
    { name: "Omar El-Amrani", title: "General Partner", org: "Atlas Capital", country: "Maroc" },
    { name: "Lila Haddad", title: "Directrice artistique", org: "Kasbah Studio", country: "Algérie" },
    { name: "Ibrahim Njoya", title: "Founder", org: "Nairobi AI", country: "Kenya" }
  ];

  const speakers = await Promise.all(
    speakerDefs.map((s, i) =>
      prisma.speaker.create({
        data: {
          eventId: event.id,
          slug: `speaker-${i + 1}-${s.name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-")}`,
          fullName: s.name,
          title: s.title,
          organization: s.org,
          country: s.country,
          photoUrl: null,
          bio: `${s.name} — ${s.title} chez ${s.org}. Profil confirmé pour l'édition 2027 de l'Algeria Brand Impact Summit.`,
          isHighlighted: i < 6,
          order: i
        }
      })
    )
  );

  // Featured sessions
  const sessionDefs = [
    {
      title: "Le paradoxe du fondateur africain",
      summary: "Ambition globale, contraintes locales — comment structurer une marque qui pèse sans se dénaturer.",
      type: SessionType.TALK,
      category: SessionCategory.LEADERSHIP,
      startsAt: new Date("2027-11-15T08:00:00Z"),
      durationMin: 20,
      stage: "Impact Stage",
      spaceIdx: 0,
      speakerIdx: [0],
      highlighted: true,
      order: 1
    },
    {
      title: "IA & Impact systémique : que se réalise ?",
      summary: "Panel — de la promesse à l'exécution. Ce que l'IA change concrètement pour les acteurs de l'impact.",
      type: SessionType.PANEL,
      category: SessionCategory.TECHNOLOGY,
      startsAt: new Date("2027-11-15T09:30:00Z"),
      durationMin: 45,
      stage: "Impact Stage",
      spaceIdx: 0,
      speakerIdx: [5, 2],
      highlighted: true,
      order: 2
    },
    {
      title: "Construire des territoires durables",
      summary: "Atelier pratique — cadre d'analyse, cartographie d'acteurs, matrices de décision.",
      type: SessionType.WORKSHOP,
      category: SessionCategory.IMPACT,
      startsAt: new Date("2027-11-15T11:00:00Z"),
      durationMin: 90,
      stage: "GET ROOTED",
      spaceIdx: 1,
      speakerIdx: [3],
      highlighted: true,
      order: 3
    },
    {
      title: "Scaling impact en marchés émergents",
      summary: "Mastermind VIP — un cercle restreint, une problématique commune, des décisions actionnables.",
      type: SessionType.MASTERMIND,
      category: SessionCategory.ENTREPRENEURSHIP,
      startsAt: new Date("2027-11-15T13:30:00Z"),
      durationMin: 90,
      stage: "GET CONNECTED",
      spaceIdx: 3,
      speakerIdx: [4, 7],
      highlighted: true,
      order: 4
    },
    {
      title: "Créer une marque continentale",
      summary: "Storytelling et distribution — construire une identité qui traverse les frontières.",
      type: SessionType.MASTERCLASS,
      category: SessionCategory.CULTURE,
      startsAt: new Date("2027-11-16T10:00:00Z"),
      durationMin: 90,
      stage: "GET ICONIC",
      spaceIdx: 2,
      speakerIdx: [8],
      highlighted: false,
      order: 5
    },
    {
      title: "Le capital comme partenaire, pas comme sortie",
      summary: "Fireside — repenser la relation founder/investor à l'échelle africaine.",
      type: SessionType.FIRESIDE,
      category: SessionCategory.INVESTMENT,
      startsAt: new Date("2027-11-16T14:30:00Z"),
      durationMin: 45,
      stage: "Impact Stage",
      spaceIdx: 0,
      speakerIdx: [2, 7],
      highlighted: false,
      order: 6
    }
  ];

  for (const s of sessionDefs) {
    const session = await prisma.session.create({
      data: {
        eventId: event.id,
        slug: `session-${s.order}-${s.title.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`,
        title: s.title,
        summary: s.summary,
        type: s.type,
        category: s.category,
        startsAt: s.startsAt,
        durationMin: s.durationMin,
        stage: s.stage,
        spaceId: spaces[s.spaceIdx].id,
        isHighlighted: s.highlighted,
        order: s.order
      }
    });
    for (const spIdx of s.speakerIdx) {
      await prisma.sessionSpeaker.create({
        data: { sessionId: session.id, speakerId: speakers[spIdx].id }
      });
    }
  }

  // Partners — tiered exactly as in the brief
  const partnerDefs: Array<{ name: string; tier: PartnerTier }> = [
    { name: "INEXACORP", tier: PartnerTier.PLATINUM },
    { name: "VORTEX GROUP", tier: PartnerTier.PLATINUM },
    { name: "ASTRA DZ", tier: PartnerTier.GOLD },
    { name: "PULSE MEDIA", tier: PartnerTier.GOLD },
    { name: "ZENITH TECH", tier: PartnerTier.GOLD },
    { name: "ORION", tier: PartnerTier.SILVER },
    { name: "APEK", tier: PartnerTier.SILVER },
    { name: "NOVA", tier: PartnerTier.SILVER },
    { name: "FUSE", tier: PartnerTier.SILVER }
  ];

  await Promise.all(
    partnerDefs.map((p, i) =>
      prisma.partner.create({
        data: {
          eventId: event.id,
          slug: `partner-${p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          name: p.name,
          tier: p.tier,
          order: i
        }
      })
    )
  );

  await prisma.siteContent.create({
    data: {
      key: "homepage.stats",
      value: {
        participants: 12611,
        speakers: 48,
        sessions: 60,
        countries: 22
      }
    }
  });

  // -------- Demo participants (for the admin ops platform) --------
  const gates = ["Gate A", "Gate B", "Gate C", "Gate D"];
  const tiers = [
    RegistrationTier.VVIP,
    RegistrationTier.VIP,
    RegistrationTier.VISITOR,
    RegistrationTier.CONTENT_CREATOR,
    RegistrationTier.IMPACT_MAKER
  ];
  const firstNames = [
    "Amine",
    "Lina",
    "Yacine",
    "Sarah",
    "Karim",
    "Nour",
    "Rania",
    "Omar",
    "Meryem",
    "Zakaria",
    "Farah",
    "Hicham"
  ];
  const lastNames = [
    "Benali",
    "Meziane",
    "Oussedik",
    "Zerhouni",
    "Cherif",
    "Haddad",
    "Bouzid",
    "Sadi",
    "Larbi",
    "Yacef",
    "Rezki",
    "Fares"
  ];

  const demoParticipants = firstNames.map((f, i) => {
    const tier = tiers[i % tiers.length];
    const gate = gates[i % gates.length];
    const confirmed = i % 3 !== 0;
    const cancelled = i === 5;
    const email = `${f.toLowerCase()}.${lastNames[i].toLowerCase()}@demo.bis.dz`;
    return {
      firstName: f,
      lastName: lastNames[i],
      email,
      phone: `+213 5${(50000000 + i * 12345).toString().slice(0, 8)}`,
      organization: i % 2 === 0 ? "BIS Demo Studio" : undefined,
      jobTitle: i % 2 === 0 ? "Founder" : "Head of Impact",
      country: i % 4 === 0 ? "Algérie" : ["Maroc", "Sénégal", "France"][i % 3],
      tier,
      gate,
      ticketCode: `BIS26-${(1000 + i).toString().padStart(6, "0")}`,
      // New rows use REGISTERED (Commit 1 of the registration refactor).
      // Legacy PENDING is retained on the enum for backward compatibility
      // but no code path — seed included — writes it going forward.
      status: cancelled
        ? ("CANCELLED" as const)
        : confirmed
          ? ("CONFIRMED" as const)
          : ("REGISTERED" as const),
      // A couple of demo check-ins so the operational dashboard has signal
      checkedIn: i < 3 && confirmed
    };
  });

  for (const p of demoParticipants) {
    const { checkedIn, ...rest } = p;
    await prisma.participant.create({
      data: {
        eventId: event.id,
        ...rest,
        checkedInAt: checkedIn ? new Date(Date.now() - 1000 * 60 * (5 + demoParticipants.indexOf(p))) : null,
        checkedInGate: checkedIn ? rest.gate : null
      }
    });
  }

  // -------- Default admin users (DEV DEMO) --------
  // All four accounts share the dev password DEV_ADMIN_PASSWORD ("admin123").
  // Credentials are documented as comments in .env. Never used in production.
  const hashed = hashPassword(DEV_ADMIN_PASSWORD);

  await prisma.adminUser.create({
    data: {
      email: "admin@admin.com",
      name: "BIS Ops Admin",
      passwordHash: hashed,
      role: AdminRole.SUPER_ADMIN,
      status: AdminStatus.ACTIVE
    }
  });

  await prisma.adminUser.create({
    data: {
      email: "admin2@bis-algeria.dz",
      name: "BIS Ops Manager",
      passwordHash: hashed,
      role: AdminRole.ADMIN,
      status: AdminStatus.ACTIVE
    }
  });

  await prisma.adminUser.create({
    data: {
      email: "sales@bis-algeria.dz",
      name: "Sales Lead",
      passwordHash: hashed,
      role: AdminRole.SALES,
      status: AdminStatus.ACTIVE
    }
  });

  await prisma.adminUser.create({
    data: {
      email: "checkin@bis-algeria.dz",
      name: "Gate Operator",
      passwordHash: hashed,
      role: AdminRole.CHECKIN_OPERATOR,
      status: AdminStatus.ACTIVE
    }
  });

  // -------- AccessPoints (venue access model) --------
  // One MAIN_ENTRANCE + five ROOMs. Room permissions are NOT auto-granted:
  // an authorized admin must assign them per-participant via
  // ParticipantAccess. See scripts/seed-access-points.ts for the idempotent
  // variant used outside destructive seeding.
  const accessPointDefs: Array<{
    slug: string;
    name: string;
    type: AccessPointType;
    order: number;
  }> = [
    { slug: "main", name: "Entrée principale", type: "MAIN_ENTRANCE", order: 0 },
    { slug: "room-01", name: "Salle 01", type: "ROOM", order: 1 },
    { slug: "room-02", name: "Salle 02", type: "ROOM", order: 2 },
    { slug: "room-03", name: "Salle 03", type: "ROOM", order: 3 },
    { slug: "room-04", name: "Salle 04", type: "ROOM", order: 4 },
    { slug: "room-05", name: "Salle 05", type: "ROOM", order: 5 }
  ];
  for (const ap of accessPointDefs) {
    await prisma.accessPoint.create({ data: { ...ap, active: true } });
  }

  console.log("\n✔ Seed complete. Credentials are documented in .env (comments only).");
  console.log("  Super Admin  admin@admin.com");
  console.log("  Admin        admin2@bis-algeria.dz");
  console.log("  Sales        sales@bis-algeria.dz");
  console.log("  Check-in     checkin@bis-algeria.dz\n");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
