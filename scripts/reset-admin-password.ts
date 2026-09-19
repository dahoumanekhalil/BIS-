import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../lib/admin/password";

async function main() {
  const prisma = new PrismaClient();
  const hash = hashPassword("admin123");
  await prisma.adminUser.update({
    where: { email: "admin@admin.com" },
    data: { passwordHash: hash },
  });
  console.log("Password updated for admin@admin.com");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});