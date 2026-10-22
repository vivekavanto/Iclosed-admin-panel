import type { SupabaseClient } from "@supabase/supabase-js";

/** Start PKCE on the server; accept only the configured Auth service's URL. */
export async function staffGoogleAuthorizationUrl(
  auth: Pick<SupabaseClient["auth"], "signInWithOAuth">,
  appOrigin: string,
  supabaseUrl: string,
): Promise<string | null> {
  const { data, error } = await auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${appOrigin}/admin/auth/confirm`,
      scopes: "openid email profile",
      queryParams: { prompt: "select_account" },
      skipBrowserRedirect: true,
    },
  });
  if (error || !data.url) return null;
  const destination = new URL(data.url);
  if (destination.origin !== new URL(supabaseUrl).origin || destination.pathname !== "/auth/v1/authorize") return null;
  return destination.toString();
}
