import { PrismaClient, AdminRole, AdminStatus } from "@prisma/client";
import { hashPassword } from "../lib/admin/password";

async function main() {
  const prisma = new PrismaClient();
  const email = "dahoumane@admin.com";
  const existing = await prisma.adminUser.findUnique({ where: { email } });
  if (existing) {
    console.log("Account already exists:", email);
    await prisma.$disconnect();
    return;
  }
  await prisma.adminUser.create({
    data: {
      name: "Dahoumane",
      email,
      passwordHash: hashPassword("admin123"),
      role: AdminRole.SUPER_ADMIN,
      status: AdminStatus.ACTIVE,
    },
  });
  console.log("Created SUPER_ADMIN account:", email);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});