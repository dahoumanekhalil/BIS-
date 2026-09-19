import "server-only";
import { prisma } from "@/lib/db";

export async function audit({
  userId,
  action,
  entity,
  entityId,
  meta
}: {
  userId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  meta?: unknown;
}) {
  await prisma.auditLog
    .create({
      data: {
        userId: userId ?? null,
        action,
        entity,
        entityId,
        meta: meta as never
      }
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("[audit] failed to write log", err);
    });
}
