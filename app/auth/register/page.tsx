import { permanentRedirect } from "next/navigation";

// Legacy compat route — external deep links to /auth/register bounce to
// the new canonical entry point at /register. `permanentRedirect` sends
// a 308 so search engines drop the old URL.
//
// Query-string preserved verbatim so any existing `?next=` / role-hint
// params still reach the role selector.
export default async function LegacyAuthRegisterPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(sp)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      for (const one of v) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(one)}`);
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
  }
  const qs = parts.length > 0 ? `?${parts.join("&")}` : "";
  permanentRedirect(`/register${qs}`);
}
