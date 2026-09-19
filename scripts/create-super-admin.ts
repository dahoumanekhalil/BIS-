import { PrismaClient, AdminRole, AdminStatus } from "@prisma/client";
import { hashPassword } from "../lib/admin/password";

const prisma = new PrismaClient();

async function main() {
  const email = "admin@admin.com";
  const password = "admin123";
  const hashed = hashPassword(password);

  const user = await prisma.adminUser.upsert({
    where: { email },
    update: {
      passwordHash: hashed,
      role: AdminRole.SUPER_ADMIN,
      status: AdminStatus.ACTIVE,
    },
    create: {
      email,
      name: "Super Admin",
      passwordHash: hashed,
      role: AdminRole.SUPER_ADMIN,
      status: AdminStatus.ACTIVE,
    },
    select: { id: true, email: true, role: true, status: true },
  });

  console.log("Super admin account ready:", user);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());