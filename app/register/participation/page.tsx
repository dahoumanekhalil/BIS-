import { permanentRedirect } from "next/navigation";

// Legacy /register/participation is retired in Commit 2. Any inbound
// deep link (bookmarks, previously-sent emails, external links) 308s to
// the new role selector at /register.
//
// Query-string is preserved verbatim (via encodeURIComponent) so a
// prior `?participation=<slug>` deep-link continues to trigger the role
// redirect that the new /register page already handles.
export default async function LegacyRegisterParticipationPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(sp)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      for (const one of v) {
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(one)}`);
      }
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
  }
  const qs = parts.length > 0 ? `?${parts.join("&")}` : "";
  permanentRedirect(`/register${qs}`);
}
