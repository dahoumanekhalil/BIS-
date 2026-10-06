import { NextResponse, type NextRequest } from "next/server";

// Edge middleware guards /admin/* by cookie presence.
// Server layouts re-verify the token against the DB.
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!pathname.startsWith("/admin")) return NextResponse.next();

  // The public participant app (User-Agent "BISApp/") must never reach the
  // admin console, whatever the client-side filter does. The staff app and
  // browsers use other User-Agents. (Defence in depth: admin access is still
  // enforced by session + RBAC on every page and action.)
  if ((request.headers.get("user-agent") ?? "").includes("BISApp/")) {
    return new NextResponse("Administration indisponible dans cette application.", {
      status: 403,
      headers: { "Cache-Control": "no-store" }
    });
  }
  if (pathname.startsWith("/admin/login")) return NextResponse.next();

  const token = request.cookies.get("bis_admin_session")?.value;
  if (!token) {
    const url = request.nextUrl.clone();
    url.pathname = "/admin/login";
    url.searchParams.set("from", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*"]
};
