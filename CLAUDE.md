# BIS 2027 — Project instructions for Claude Code

## Security is critical

This project handles registrations, payments (references — no card data),
and admin operations for a public event. Treat security as a first-class
requirement, not an afterthought.

**After any code change (Edit / Write / new file) that touches:**

- `app/admin/**`
- `app/actions/**`
- `app/api/**`
- `lib/admin/**`
- `lib/db.ts`
- `prisma/schema.prisma`
- `middleware.ts`
- `package.json` (new dependency)

…invoke the `security-reviewer` subagent on the changed files before telling
the user the task is done. This is mandatory, not a suggestion.

Also invoke it if the change adds any of:
- new server action / route handler
- new cookie / session behaviour
- new form or user input handling
- `dangerouslySetInnerHTML`
- raw SQL

If the reviewer returns `BLOCK`, fix the findings and re-run before reporting.
If it returns `WARN`, surface the warnings to the user in your summary and
explain the tradeoff. If `OK`, mention "security review: OK" in one line.

## Auth pattern (do not deviate)

- Every server action under `app/admin/(protected)/` starts with
  `await requirePermission("<perm>")` or `await requireAdmin()`.
- Never trust the layout to do the check — server actions run outside layouts.
- Permissions live in `lib/admin/rbac.ts`. Add a new permission string there
  before using it.

## Prisma

- Use the shared `prisma` client from `lib/db.ts`.
- No `$queryRawUnsafe`. Use tagged `$queryRaw` if you need raw SQL.
- When returning user data to the client, `select` only the fields you need —
  never send `passwordHash` or `AdminSession.token`.

## Client / server boundary

- Files with `"use client"` must NOT import `lib/db`, `lib/admin/auth`,
  `next/headers`, or anything marked `server-only`.
- Secrets never ship to the browser. `NEXT_PUBLIC_*` is fine for non-secrets.
