// DR-NONPROD deterministic dataset seed (W.1 Gate E).
//
// Loads `DATABASE_URL` from the DR environment and writes a controlled,
// non-production dataset into the dedicated DR database.
//
// Sentinel strings: every DR row carries a `DR_VALIDATION_*` identifier
// so a future post-restore validation can match against exact values.
//
// IMPORTANT:
//   * Refuses to run unless the DR label env var is set — belt-and-braces
//     against accidentally seeding the development DB.
//   * No real personal data. Every field is synthetic.
//   * Does NOT execute W.2. Does NOT make any Drive API call.

import { PrismaClient, AdminRole, AdminStatus } from "@prisma/client";
import { promises as fs } from "node:fs";
import { hashPassword } from "../lib/admin/password";

// DR label guard — the DR .env.dr file sets DR_ENVIRONMENT_LABEL=DR-NONPROD.
if (process.env.DR_ENVIRONMENT_LABEL !== "DR-NONPROD") {
  process.stderr.write(
    "Refusing to run DR seed: DR_ENVIRONMENT_LABEL != 'DR-NONPROD'.\n" +
      "Source /c/bis-dr-nonprod/.env.dr before running this script.\n"
  );
  process.exit(1);
}

const DR_PREFIX = "DR_VALIDATION";
const EVENT_SLUG = `dr-validation-event-001`;
const PARTICIPANT_COUNT = 7;
const SPEAKER_COUNT = 3;
const SESSION_COUNT = 2;
const SUPER_ADMIN_EMAIL = "dr-operator@dr-nonprod.local";
const SUPER_ADMIN_PASSWORD = `${DR_PREFIX}_OPERATOR_PASSWORD_${Date.now()}`;

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    // 1. Event (parent of participants / speakers / sessions).
    const event = await prisma.event.upsert({
      where: { slug: EVENT_SLUG },
      update: {},
      create: {
        slug: EVENT_SLUG,
        name: `${DR_PREFIX}_EVENT`,
        tagline: `${DR_PREFIX}_TAGLINE`,
        description: `${DR_PREFIX}_EVENT_DESC`,
        startsAt: new Date("2026-11-01T09:00:00Z"),
        endsAt: new Date("2026-11-03T18:00:00Z"),
        city: "DR_CITY",
        venue: "DR_VENUE",
        country: "DR_COUNTRY",
        expectedAttendees: 42
      }
    });

    // 2. Participants.
    for (let i = 1; i <= PARTICIPANT_COUNT; i++) {
      const email = `dr-validation-participant-${i}@dr-nonprod.local`;
      await prisma.participant.upsert({
        where: {
          eventId_email: { eventId: event.id, email }
        },
        update: {},
        create: {
          eventId: event.id,
          firstName: `${DR_PREFIX}_FIRST_${i}`,
          lastName: `${DR_PREFIX}_LAST_${i}`,
          email,
          organization: `${DR_PREFIX}_ORG`,
          country: "DR_COUNTRY"
        }
      });
    }

    // 3. Speakers.
    for (let i = 1; i <= SPEAKER_COUNT; i++) {
      await prisma.speaker.upsert({
        where: { slug: `dr-validation-speaker-${i}` },
        update: {},
        create: {
          eventId: event.id,
          slug: `dr-validation-speaker-${i}`,
          fullName: `${DR_PREFIX}_SPEAKER_${i}`,
          title: `${DR_PREFIX}_TITLE`,
          organization: `${DR_PREFIX}_ORG`
        }
      });
    }

    // 4. Sessions.
    const sessions = [];
    for (let i = 1; i <= SESSION_COUNT; i++) {
      const session = await prisma.session.upsert({
        where: { slug: `dr-validation-session-${i}` },
        update: {},
        create: {
          eventId: event.id,
          slug: `dr-validation-session-${i}`,
          title: `${DR_PREFIX}_SESSION_${i}`,
          summary: `${DR_PREFIX}_SESSION_${i}_SUMMARY`,
          startsAt: new Date(`2026-11-01T${9 + i}:00:00Z`),
          durationMin: 45
        }
      });
      sessions.push(session);
    }

    // 5. Cross-table relationship: Session ↔ Speaker.
    //    Session 1 → Speaker 1 + Speaker 2.
    //    Session 2 → Speaker 3.
    const speakers = await prisma.speaker.findMany({
      where: { slug: { startsWith: "dr-validation-speaker-" } },
      orderBy: { slug: "asc" }
    });
    await prisma.sessionSpeaker.deleteMany({
      where: { sessionId: { in: sessions.map((s) => s.id) } }
    });
    await prisma.sessionSpeaker.createMany({
      data: [
        { sessionId: sessions[0]!.id, speakerId: speakers[0]!.id },
        { sessionId: sessions[0]!.id, speakerId: speakers[1]!.id },
        { sessionId: sessions[1]!.id, speakerId: speakers[2]!.id }
      ],
      skipDuplicates: true
    });

    // 6. DR operator (SUPER_ADMIN) — baseline role holds all required perms
    //    (`backup.replication.*` + `backup.restore`). RBAC is NOT weakened.
    const existingAdmin = await prisma.adminUser.findUnique({
      where: { email: SUPER_ADMIN_EMAIL }
    });
    const operator = existingAdmin
      ? await prisma.adminUser.update({
          where: { id: existingAdmin.id },
          data: {
            // Preserve the stored password if the row already exists.
            role: AdminRole.SUPER_ADMIN,
            status: AdminStatus.ACTIVE
          }
        })
      : await prisma.adminUser.create({
          data: {
            email: SUPER_ADMIN_EMAIL,
            name: `${DR_PREFIX}_OPERATOR`,
            passwordHash: hashPassword(SUPER_ADMIN_PASSWORD),
            role: AdminRole.SUPER_ADMIN,
            status: AdminStatus.ACTIVE
          }
        });

    // 7. Baseline file (machine-readable). Never printed to stdout or chat.
    //    Password is NOT included — only its presence flag.
    const baseline = {
      generatedAt: new Date().toISOString(),
      environment: "DR-NONPROD",
      dataset: {
        datasetId: `${DR_PREFIX}_V1`,
        sentinelPrefix: DR_PREFIX,
        counts: {
          event: 1,
          participant: PARTICIPANT_COUNT,
          speaker: SPEAKER_COUNT,
          session: SESSION_COUNT,
          sessionSpeaker: 3,
          adminUserDr: 1
        },
        sentinels: {
          eventSlug: EVENT_SLUG,
          eventName: `${DR_PREFIX}_EVENT`,
          participantEmails: Array.from(
            { length: PARTICIPANT_COUNT },
            (_, i) => `dr-validation-participant-${i + 1}@dr-nonprod.local`
          ),
          speakerSlugs: Array.from(
            { length: SPEAKER_COUNT },
            (_, i) => `dr-validation-speaker-${i + 1}`
          ),
          sessionSlugs: Array.from(
            { length: SESSION_COUNT },
            (_, i) => `dr-validation-session-${i + 1}`
          ),
          operatorEmail: SUPER_ADMIN_EMAIL
        },
        relationships: {
          sessionSpeakerLinks: [
            { session: "dr-validation-session-1", speaker: "dr-validation-speaker-1" },
            { session: "dr-validation-session-1", speaker: "dr-validation-speaker-2" },
            { session: "dr-validation-session-2", speaker: "dr-validation-speaker-3" }
          ]
        }
      },
      operator: {
        email: SUPER_ADMIN_EMAIL,
        role: "SUPER_ADMIN",
        passwordFile: "/c/bis-dr-nonprod/dr-operator-password",
        createdOrUpdatedAdminId: operator.id
      }
    };

    const BASELINE_PATH = "C:\\bis-dr-nonprod\\dr-validation-baseline.json";
    await fs.writeFile(BASELINE_PATH, JSON.stringify(baseline, null, 2), "utf8");

    // Dump the operator's clear-text password ONCE to a protected local file
    // outside the repo. Only ever written when we create the operator row.
    if (!existingAdmin) {
      await fs.writeFile(
        "C:\\bis-dr-nonprod\\dr-operator-password",
        SUPER_ADMIN_PASSWORD + "\n",
        { encoding: "utf8", mode: 0o600 }
      );
      process.stdout.write(
        "[seed] operator created — clear password written to C:\\bis-dr-nonprod\\dr-operator-password (chmod 600)\n"
      );
    } else {
      process.stdout.write(
        "[seed] operator row already present; password unchanged (see C:\\bis-dr-nonprod\\dr-operator-password)\n"
      );
    }

    process.stdout.write(
      `[seed] DR dataset ready. Baseline at ${BASELINE_PATH}\n` +
        `[seed] Counts — event:1 participant:${PARTICIPANT_COUNT} speaker:${SPEAKER_COUNT} session:${SESSION_COUNT} sessionSpeaker:3 adminUserDr:1\n`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(
    "DR seed failed: " +
      (err instanceof Error ? err.constructor.name : "unknown") +
      "\n" +
      (err instanceof Error && err.message ? err.message + "\n" : "")
  );
  process.exit(1);
});
