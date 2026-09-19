// Pure NOOP guard for the Phase 7 admin access-actions.
//
// Extracted (rather than inlined) because access-actions.ts carries the
// "use server" directive: every export from that file is registered as a
// server action, so it cannot expose sync utilities that a test would
// call directly.
//
// The guard implements the semantics required by the Phase 7 audit
// (section 4):
//   • unassigned  → grant   → mutation + audit
//   • denied      → grant   → mutation + audit
//   • granted     → grant   → NOOP
//   • granted     → revoke  → mutation + audit
//   • denied      → revoke  → NOOP     (by symmetry with granted → grant)
//   • unassigned  → revoke  → mutation + audit (creates the explicit
//     "denied" row — this is the established behavior the audit spec
//     asked to preserve, so it is NOT a NOOP).
//
// Return value: `true` means the caller should skip the mutation, the
// audit write, and the cache revalidation. `false` means proceed.
export function isAccessMutationNoop(
  before: { granted: boolean } | null,
  desiredGranted: boolean
): boolean {
  return before !== null && before.granted === desiredGranted;
}
