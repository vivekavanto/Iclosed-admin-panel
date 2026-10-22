import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";
import { staffGoogleAuthorizationUrl } from "@/lib/staffGoogleSignIn";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  const response = NextResponse.redirect(new URL("/admin/login?confirmation=failed", origin));
  response.headers.set("Cache-Control", "private, no-store");
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const sb = createServerClient(supabaseUrl, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: entries => entries.forEach(c => response.cookies.set(c.name, c.value, c.options)),
    },
  });
  try {
    const destination = await staffGoogleAuthorizationUrl(sb.auth, origin, supabaseUrl);
    if (destination) response.headers.set("Location", destination);
  } catch {
    // Preserve a useful retry path without leaking provider errors or OAuth values.
  }
  return response;
}
