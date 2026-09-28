// Real restore drill — Phase 12 final gate.
//
// Executes the FULL production pipeline (dump → verify → mutate → restore
// → post-restore verify) against an isolated Postgres database.
// Timings, sizes, and row-counts are printed to stdout.
//
// Usage:
//   DATABASE_URL="postgresql://admin:secret123@localhost:5432/bis_restore_drill?schema=public" \
//     BACKUP_ENCRYPTION_KEY=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))") \
//     BACKUP_STORAGE_DIR=/tmp/bis-restore-drill \
//     TEST_BACKUP_RESTORE_DESTRUCTIVE=1 \
//     npx tsx scripts/backup-restore-drill.ts
//
// SAFETY: this script wipes the connected database. `DATABASE_URL` MUST
// point at a disposable scratch DB — the script refuses to run if the
// DB name matches `getplus_summit_2026` (the dev DB) to prevent an
// accidental double-click.

import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!dbUrl.includes("bis_restore_drill")) {
    process.stderr.write(
      "REFUSED: DATABASE_URL must point at a disposable DB named 'bis_restore_drill'.\n" +
        "Set:\n" +
        '  DATABASE_URL="postgresql://admin:secret123@localhost:5432/bis_restore_drill?schema=public"\n'
    );
    process.exit(1);
  }
  if (!process.env.BACKUP_ENCRYPTION_KEY) {
    process.stderr.write("REFUSED: BACKUP_ENCRYPTION_KEY not set.\n");
    process.exit(1);
  }
  if (!process.env.BACKUP_STORAGE_DIR) {
    process.stderr.write("REFUSED: BACKUP_STORAGE_DIR not set.\n");
    process.exit(1);
  }
  if (process.env.TEST_BACKUP_RESTORE_DESTRUCTIVE !== "1") {
    process.stderr.write("REFUSED: set TEST_BACKUP_RESTORE_DESTRUCTIVE=1 to opt in.\n");
    process.exit(1);
  }

  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  const { runBackupDump } = await import("../lib/backup/dump");
  const { verifyBackup } = await import("../lib/backup/verify");
  const { runRestore } = await import("../lib/backup/restore");
  const { hashPassword } = await import("../lib/admin/password");
  const { statPublishedBackup } = await import("../lib/backup/storage");

  const log = (msg: string) => process.stdout.write(`[drill] ${msg}\n`);

  try {
    // ── Seed representative data ────────────────────────────────────────
    log("Seeding representative rows...");
    const adminPassword = "drill-password-not-used-elsewhere";
    const drillAdmin = await prisma.adminUser.create({
      data: {
        email: `drill-super-${Date.now()}@bis.dz`,
        name: "Drill Super",
        passwordHash: hashPassword(adminPassword),
        role: "SUPER_ADMIN",
        status: "ACTIVE"
      }
    });
    const event = await prisma.event.create({
      data: {
        slug: `drill-event-${Date.now()}`,
        name: "Drill Event",
        tagline: "Restore drill",
        description: "Ephemeral event for the Phase 12 restore drill.",
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        city: "Alger",
        venue: "Drill",
        country: "DZ",
        expectedAttendees: 25
      }
    });
    const participants: string[] = [];
    for (let i = 0; i < 25; i++) {
      const p = await prisma.participant.create({
        data: {
          email: `drill-p${i}-${Date.now()}@bis.dz`,
          firstName: `Drill${i}`,
          lastName: `Participant${i}`,
          phone: `+21355000${String(i).padStart(4, "0")}`,
          status: "REGISTERED",
          tier: "VIP",
          eventId: event.id
        }
      });
      participants.push(p.id);
    }
    for (const pid of participants.slice(0, 10)) {
      await prisma.checkIn.create({
        data: {
          participantId: pid,
          ticketCode: `TCK-${pid.slice(0, 8)}`,
          result: "VALID",
          gate: "Gate A",
          scannedAt: new Date()
        }
      });
    }
    const initialCounts = {
      AdminUser: await prisma.adminUser.count(),
      Participant: await prisma.participant.count(),
      CheckIn: await prisma.checkIn.count(),
      AuditLog: await prisma.auditLog.count()
    };
    log(`  seeded: ${JSON.stringify(initialCounts)}`);

    // ── Backup ──────────────────────────────────────────────────────────
    log("Running backup dump...");
    const t0 = Date.now();
    const dump = await runBackupDump({
      kind: "MANUAL",
      createdById: drillAdmin.id,
      client: prisma
    });
    const backupMs = Date.now() - t0;
    const stat = await statPublishedBackup(dump.backupId);
    log(`  backup id: ${dump.backupId}`);
    log(`  backup duration: ${backupMs}ms`);
    log(`  bin size: ${stat.binSize} bytes`);
    log(`  manifest size: ${stat.manifestSize} bytes`);
    log(`  total rows dumped: ${dump.totalRows}`);

    // ── Verify ──────────────────────────────────────────────────────────
    log("Verifying backup...");
    const t1 = Date.now();
    const verify = await verifyBackup({
      backupId: dump.backupId,
      client: prisma,
      persist: true,
      verifiedById: drillAdmin.id,
      compareDb: true
    });
    const verifyMs = Date.now() - t1;
    log(`  outcome: ${verify.outcome} (${verify.code}) at stage ${verify.stage}`);
    log(`  duration: ${verifyMs}ms`);
    if (verify.outcome !== "VERIFIED") {
      throw new Error(`Verify failed: ${verify.code}/${verify.stage}`);
    }

    // ── Mutate ──────────────────────────────────────────────────────────
    log("Mutating scratch DB (inserting marker + deleting rows)...");
    const marker = await prisma.auditLog.create({
      data: {
        userId: drillAdmin.id,
        action: "backup.drill.marker",
        entity: "Drill",
        meta: { note: "must be wiped by restore" }
      }
    });
    // Delete some participants to prove restore brings them back.
    await prisma.checkIn.deleteMany({});
    const deletedParticipants = await prisma.participant.deleteMany({
      where: { id: { in: participants.slice(10) } }
    });
    const preRestoreCounts = {
      Participant: await prisma.participant.count(),
      CheckIn: await prisma.checkIn.count()
    };
    log(
      `  deleted ${deletedParticipants.count} participants, wiped all check-ins`
    );
    log(`  pre-restore: ${JSON.stringify(preRestoreCounts)}`);

    // ── Restore ─────────────────────────────────────────────────────────
    log("Running destructive restore...");
    const t2 = Date.now();
    const restore = await runRestore({
      actor: { id: drillAdmin.id, role: "SUPER_ADMIN" },
      backupId: dump.backupId,
      confirmationPhrase: `RESTORE ${dump.backupId.slice(0, 8)}`,
      adminPassword,
      client: prisma
    });
    const restoreMs = Date.now() - t2;
    log(`  restore duration: ${restoreMs}ms`);
    log(`  restore outcome: ${restore.ok ? "OK" : restore.code}`);
    log(`  restoreOperationId: ${restore.restoreOperationId ?? "(none)"}`);
    log(`  safetyBackupId: ${restore.safetyBackupId ?? "(none)"}`);
    if (!restore.ok) {
      throw new Error(`Restore failed: ${restore.code}`);
    }

    // ── Post-restore verify ─────────────────────────────────────────────
    log("Verifying post-restore state...");
    const postCounts = {
      AdminUser: await prisma.adminUser.count(),
      Participant: await prisma.participant.count(),
      CheckIn: await prisma.checkIn.count(),
      AuditLog: await prisma.auditLog.count()
    };
    log(`  post-restore: ${JSON.stringify(postCounts)}`);
    const markerStillThere = await prisma.auditLog.findUnique({
      where: { id: marker.id }
    });
    log(`  marker wiped: ${markerStillThere === null ? "YES" : "NO"}`);
    // The RestoreOperation row must survive.
    const opRow = await prisma.restoreOperation.findUnique({
      where: { id: restore.restoreOperationId! }
    });
    log(
      `  RestoreOperation persisted: status=${opRow?.status ?? "missing"}`
    );
    // Sessions must be empty.
    const sessions = await prisma.adminSession.count();
    log(`  AdminSession count post-restore: ${sessions} (expect 0)`);

    // ── Summary ─────────────────────────────────────────────────────────
    log("");
    log("─── DRILL SUMMARY ────────────────────────────────────────────────");
    log(`Backup duration:       ${backupMs}ms`);
    log(`Backup size:           ${stat.binSize + stat.manifestSize} bytes (bin ${stat.binSize} + manifest ${stat.manifestSize})`);
    log(`Verification duration: ${verifyMs}ms`);
    log(`Restore duration:      ${restoreMs}ms`);
    log(`Rows restored:         ${JSON.stringify(postCounts)}`);
    log(`Marker wiped:          ${markerStillThere === null ? "YES" : "NO"}`);
    log(`Sessions post-restore: ${sessions}`);
    log("─────────────────────────────────────────────────────────────────");

    if (
      postCounts.Participant !== initialCounts.Participant ||
      postCounts.CheckIn !== initialCounts.CheckIn ||
      markerStillThere !== null ||
      sessions !== 0
    ) {
      throw new Error(
        "Post-restore invariants violated — see counts above."
      );
    }
    log("");
    log("DRILL PASSED ✓");
    process.exit(0);
  } catch (err) {
    log("");
    log(`DRILL FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
