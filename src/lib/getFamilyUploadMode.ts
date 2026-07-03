import supabaseAdmin from "@/lib/supabaseAdmin";

export type UploadMode = "me" | "co" | "both";

/**
 * Resolves a transaction family's "Who will be uploading your documents?" answer.
 *
 * The decision lives on the PRIMARY lead's `upload_mode` column (written by the
 * customer portal after retainer sign — sql/add_lead_upload_mode.sql). Pass ANY
 * lead id in the family — primary or a co-person — and this follows
 * `parent_lead_id` up to the primary and reads it.
 *
 * Returns null when the popup hasn't been answered yet (or there are no
 * co-persons, so it never showed). Callers treat null like "me" — a single
 * uploader, no cross-party access beyond the upload_mode rules.
 *
 * Ported verbatim from the portal so the admin gates edit permissions the same
 * way the client experience does.
 */
export async function getFamilyUploadMode(
  anyFamilyLeadId: string
): Promise<UploadMode | null> {
  const { data: lead } = await supabaseAdmin
    .from("leads")
    .select("id, parent_lead_id")
    .eq("id", anyFamilyLeadId)
    .maybeSingle();
  if (!lead) return null;

  const primaryId = lead.parent_lead_id ?? lead.id;

  const { data: primary } = await supabaseAdmin
    .from("leads")
    .select("upload_mode")
    .eq("id", primaryId)
    .maybeSingle();

  const mode = primary?.upload_mode ?? null;
  return mode === "me" || mode === "co" || mode === "both" ? mode : null;
}
