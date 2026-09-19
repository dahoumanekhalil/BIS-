import { PrismaClient, AdminRole, AdminStatus } from "@prisma/client";
import { hashPassword } from "../lib/admin/password";

async function main() {
  const prisma = new PrismaClient();
  const email = "superadmin@admin.com";
  const password = "admin123";

  const existing = await prisma.adminUser.findUnique({ where: { email } });
  if (existing) {
    await prisma.adminUser.update({
      where: { email },
      data: {
        passwordHash: hashPassword(password),
        role: AdminRole.SUPER_ADMIN,
        status: AdminStatus.ACTIVE,
      },
    });
    console.log("Updated existing SUPER_ADMIN account:", email);
  } else {
    await prisma.adminUser.create({
      data: {
        name: "Super Admin",
        email,
        passwordHash: hashPassword(password),
        role: AdminRole.SUPER_ADMIN,
        status: AdminStatus.ACTIVE,
      },
    });
    console.log("Created SUPER_ADMIN account:", email);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
