import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";
import { homePath, canSignIn } from "@/lib/staffAccess";
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const response = NextResponse.redirect(new URL("/admin/welcome", url.origin));
  const sb = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { cookies: { getAll: () => request.cookies.getAll(), setAll: entries => entries.forEach(c => response.cookies.set(c.name, c.value, c.options)) } });
  const code = url.searchParams.get("code");
  if (code) {
    const { error } = await sb.auth.exchangeCodeForSession(code);
    if (!error) {
      const { data: { user } } = await sb.auth.getUser();
      if (canSignIn(user)) { response.headers.set("Location", new URL(homePath(user), url.origin).toString()); response.headers.set("Cache-Control", "private, no-store"); return response; }
      await sb.auth.signOut();
    }
  }
  const redirect = NextResponse.redirect(new URL("/admin/login?confirmation=failed", url.origin));
  response.cookies.getAll().forEach(c => redirect.cookies.set(c));
  return redirect;
}
