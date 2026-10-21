import supabaseAdmin from "./supabaseAdmin";
import { getActingAdmin } from "./getActingAdmin";
import type { Actor } from "./dealMessages";

/** The signed-in admin as the chat shows them: display name from admin_users. */
export async function resolveMessageActor(): Promise<Actor & { id: string | null }> {
  const actor = await getActingAdmin();
  let name = "iClosed Team";
  if (actor.email) {
    const { data } = await supabaseAdmin
      .from("admin_users")
      .select("name")
      .ilike("email", actor.email)
      .maybeSingle();
    if (data?.name?.trim()) name = data.name.trim();
  }
  return { email: actor.email, id: actor.id, name };
}
