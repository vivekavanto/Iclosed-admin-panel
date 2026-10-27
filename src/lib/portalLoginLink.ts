import supabaseAdmin from "./supabaseAdmin";

/** A one-time magic link into the customer portal as `email`, via its auth callback; nothing is emailed. */
export async function createPortalLoginLink(email: string): Promise<{ url: string } | { error: string }> {
  const portalBase = (process.env.NEXT_PUBLIC_CUSTOMER_PORTAL_URL ?? "").replace(/\/+$/, "");
  const redirectTo = portalBase ? `${portalBase}/api/auth/callback` : undefined;
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: redirectTo ? { redirectTo } : undefined,
  });
  if (error) return { error: error.message };
  const url = data?.properties?.action_link;
  return url ? { url } : { error: "Could not generate link" };
}
