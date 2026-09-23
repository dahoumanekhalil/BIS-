import { PrismaClient, AccessPointType } from "@prisma/client";

// Idempotent seed: upserts the six BIS 2027 AccessPoints by slug. Safe to
// re-run at any time; will not disturb existing rows other than syncing
// display name / order / active. Use this instead of `npm run db:seed`
// (which is destructive).
const ACCESS_POINTS: Array<{
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

async function main() {
  const prisma = new PrismaClient();
  try {
    for (const p of ACCESS_POINTS) {
      await prisma.accessPoint.upsert({
        where: { slug: p.slug },
        update: { name: p.name, type: p.type, order: p.order, active: true },
        create: { ...p, active: true }
      });
    }
    const rows = await prisma.accessPoint.findMany({
      orderBy: [{ type: "asc" }, { order: "asc" }],
      select: { slug: true, name: true, type: true, active: true }
    });
    console.log("AccessPoints in DB:");
    for (const r of rows) {
      console.log(
        `  ${r.slug.padEnd(10)} ${r.type.padEnd(14)} ${r.active ? "active" : "inactive"}  ${r.name}`
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
