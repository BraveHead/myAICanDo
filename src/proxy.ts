import { NextResponse, type NextRequest } from "next/server";
import {
  decryptSession,
  SESSION_COOKIE_NAME,
} from "@/lib/server/saas/session-core";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const session = await decryptSession(
    request.cookies.get(SESSION_COOKIE_NAME)?.value,
  );

  if (pathname === "/login") {
    if (session?.currentTenantHashId) {
      return NextResponse.redirect(
        new URL(`/${session.currentTenantHashId}`, request.url),
      );
    }

    return NextResponse.next();
  }

  if (pathname === "/switch-tenant") {
    if (!session) {
      return NextResponse.redirect(new URL("/login", request.url));
    }

    return NextResponse.next();
  }

  if (pathname === "/") {
    return NextResponse.redirect(
      new URL(
        session?.currentTenantHashId ? `/${session.currentTenantHashId}` : "/login",
        request.url,
      ),
    );
  }

  if (!session) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const tenantSegment = pathname.split("/").filter(Boolean)[0];
  if (tenantSegment && tenantSegment !== session.currentTenantHashId) {
    return NextResponse.redirect(new URL("/switch-tenant", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
