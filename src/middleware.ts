import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Server-side auth gate for the admin surface.
//
// Why this exists: every /api/admin/* route uses the Supabase service-role
// client, which bypasses Row Level Security and performs NO per-route auth of
// its own. Until now the only thing protecting them was Vercel's Deployment
// Protection login wall. This middleware replaces that wall with real,
// app-owned auth so the routes are safe even when the deployment is public.
//
// It validates the cookie-backed Supabase session (set by the browser client
// in src/lib/supabaseClient.ts) and requires app_metadata.role === "admin" —
// the same gate AuthProvider and the login page already enforce on the client.

// Routes under /api/admin that are called by EXTERNAL services (the customer
// portal and first-login/retainer webhooks), not by the authenticated admin
// browser UI. They carry no admin session cookie, so the cookie gate below
// cannot apply to them without breaking those integrations.
//
// These are intentionally left at their CURRENT protection level (none) — this
// middleware neither tightens nor loosens them, so there is no regression vs.
// today. They are email-send/reset actions (no data exfiltration), but they
// remain an open gap: the proper fix is a shared service secret verified inside
// each handler, which also requires updating the portal/webhook callers. Track
// that as a follow-up; do not silently gate these here.
const PUBLIC_ADMIN_API = [
  // Customer-portal "Forgot Password" flow. Returns only generic messages.
  "/api/admin/reset-password",
  // Customer portal posts milestone-completion emails here (client_id body).
  "/api/admin/send-milestone-email",
  // Intake / lead-conversion / first-login webhook welcome emails.
  "/api/admin/send-welcome-email",
  // Customer-portal retainer auto-flow (signed-retainer family email).
  "/api/admin/send-lead-family-email",
];

function isPublicAdminApi(pathname: string): boolean {
  return PUBLIC_ADMIN_API.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Never gate the public forgot-password endpoint (incl. its CORS preflight).
  if (isPublicAdminApi(pathname)) {
    return NextResponse.next();
  }

  // The login page must stay reachable while signed out.
  if (pathname === "/admin/login") {
    return NextResponse.next();
  }

  // Build a response we can attach refreshed session cookies to. getUser()
  // may rotate the access/refresh tokens; those updates must ride back to the
  // browser on the response or the session silently dies on the next request.
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // getUser() (not getSession()) revalidates the token against the Supabase
  // auth server, so a forged/expired cookie can't satisfy the gate.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isAdmin = user?.app_metadata?.role === "admin";

  if (!isAdmin) {
    // API routes get a clean 401; pages get bounced to the login screen.
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/admin/login";
    loginUrl.search = "";
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  // Only run on the admin surface. Critically this EXCLUDES /api/auth/*
  // (e.g. /api/auth/activate, the link emailed to clients) so those stay
  // public and the middleware never touches them.
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
