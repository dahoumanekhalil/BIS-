// CI invariant guard for the Google Drive replication tree.
//
// Companion to docs/BACKUP_GOOGLE_DRIVE_IMPLEMENTATION_PLAN.md §M.2:
//
//   > Every `lib/backup/replication/*.ts` file starts with a comment
//   > declaring the invariant, plus a hand-crafted eslint rule (or a
//   > grep-based `scripts/check-replication-invariants.ts` in CI) that
//   > fails if `prisma.backup.update` appears in any file under
//   > `lib/backup/replication/`.
//
// This script implements that grep-based guard. It refuses ANY call
// that would REGRESS or MUTATE a local Backup row from inside the
// replication tree — the whole point of §M is that a Google Drive
// failure can never invalidate a successfully verified local Backup.
//
// A single documented exception is permitted for `restore-remote.ts`:
// per §N.3 step 5, remote restore INSERTS a brand-new `Backup` row
// (via `prisma.backup.create`) for a backupId that has no local
// counterpart. That is an INSERT of previously-absent state — it
// cannot regress an existing VERIFIED row. `create` is allowed there
// under an explicit allow-list; `update`, `delete`, `upsert`, and
// `updateMany` remain forbidden everywhere in the tree.
//
// Usage:
//   npx tsx scripts/check-replication-invariants.ts
//
// Exit code 0 → invariant holds. Exit code 1 → invariant violated;
// the offending file + line is printed.

import { promises as fs } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");
const REPLICATION_DIR = path.resolve(REPO_ROOT, "lib", "backup", "replication");

// Any of these substrings appearing as `<client>.backup.<verb>` (where
// <verb> is a mutating Prisma method) is a violation. The regex below
// matches an identifier (word chars) followed by `.backup.` and a
// forbidden verb. We deliberately anchor on `.backup.` (dot-backup-dot)
// rather than `backup.` so a variable literally named `backup` (as in
// `const backup = ...`) is not misidentified as a Prisma call.
const FORBIDDEN_VERBS = [
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany"
] as const;

// The single allow-list exception (§N.3 step 5): remote restore
// inserts a Backup row when none existed locally. `create` is the
// only verb permitted, and only in `restore-remote.ts`.
const ALLOWED_CREATE_FILES = new Set<string>([
  path.resolve(REPLICATION_DIR, "restore-remote.ts")
]);

type Violation = {
  file: string;
  line: number;
  snippet: string;
  reason: string;
};

async function listReplicationFiles(): Promise<string[]> {
  const entries = await fs.readdir(REPLICATION_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => path.resolve(REPLICATION_DIR, e.name));
}

function scanFile(
  filePath: string,
  source: string
): Violation[] {
  const violations: Violation[] = [];
  const lines = source.split(/\r?\n/);

  // Forbidden mutators: any occurrence of `<ident>.backup.<verb>`.
  const forbiddenRe = new RegExp(
    `\\.backup\\.(?:${FORBIDDEN_VERBS.join("|")})\\b`,
    "g"
  );

  // `create` is only allowed in the documented exception.
  const createRe = /\.backup\.create\b/g;

  const allowCreate = ALLOWED_CREATE_FILES.has(filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip trivially-empty or all-whitespace lines fast.
    if (line.trim().length === 0) continue;
    // Skip lines that are pure comments: `//` or `*` at the first
    // non-space column. This lets documentation strings mention the
    // forbidden verbs without tripping the checker.
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    const forbiddenMatch = line.match(forbiddenRe);
    if (forbiddenMatch !== null) {
      violations.push({
        file: filePath,
        line: i + 1,
        snippet: trimmed.slice(0, 160),
        reason: `forbidden Backup mutator: ${forbiddenMatch[0]}`
      });
    }
    if (!allowCreate) {
      const createMatch = line.match(createRe);
      if (createMatch !== null) {
        violations.push({
          file: filePath,
          line: i + 1,
          snippet: trimmed.slice(0, 160),
          reason:
            "Backup.create is only permitted in restore-remote.ts (Plan §N.3 step 5)"
        });
      }
    }
  }

  return violations;
}

async function main(): Promise<void> {
  const files = await listReplicationFiles();
  const violations: Violation[] = [];

  for (const f of files) {
    const src = await fs.readFile(f, "utf8");
    violations.push(...scanFile(f, src));
  }

  process.stdout.write("─── Replication invariant check (§M.2) ───\n");
  process.stdout.write(`Scanned ${files.length} file(s) under lib/backup/replication/.\n`);
  process.stdout.write(
    `Forbidden: any \`*.backup.${FORBIDDEN_VERBS.join(" / *.backup.")}\` call.\n`
  );
  process.stdout.write(
    `Allow-list: \`*.backup.create\` in restore-remote.ts only (§N.3 step 5).\n\n`
  );

  if (violations.length === 0) {
    process.stdout.write("OK — no Backup mutators found in the replication tree.\n");
    process.exit(0);
  }

  process.stdout.write(`FAIL — ${violations.length} violation(s):\n`);
  for (const v of violations) {
    const rel = path.relative(REPO_ROOT, v.file);
    process.stdout.write(`  ${rel}:${v.line}: ${v.reason}\n`);
    process.stdout.write(`    ${v.snippet}\n`);
  }
  process.exit(1);
}

main().catch((err) => {
  // Defensive: any unexpected crash surfaces a diagnostic name (never
  // the raw message, which could echo a filesystem path we would
  // rather not print in a CI log).
  const name = err instanceof Error ? err.constructor.name : "unknown-error";
  process.stderr.write(`check-replication-invariants crashed: ${name}\n`);
  process.exit(2);
});
