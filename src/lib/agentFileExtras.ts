import supabaseAdmin from "./supabaseAdmin";
import { AGENT_UPLOAD_PREFIX } from "./agentPortal";
import { MISSING_TABLE_CODES } from "./agentTaskPermission";

// The agent's Other Documents and private notes on a file, keyed by its root lead.
// Documents share the file page's store, so staff see them; the agent sees only their own.

export const OTHER_DOC_TYPE = "other";
export const AGENT_NOTE_MAX = 500;

export type AgentDocument = {
  id: string;
  fileName: string | null;
  fileUrl: string | null;
  fileSize: number | null;
  label: string | null;
  createdAt: string | null;
  shared: boolean;
};

async function familyLeadIds(rootLeadId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin.from("leads").select("id").or(`id.eq.${rootLeadId},parent_lead_id.eq.${rootLeadId}`).eq("is_deleted", false);
  if (error) throw error;
  return (data ?? []).map((l) => l.id as string);
}

export async function listAgentDocuments(rootLeadId: string): Promise<AgentDocument[]> {
  const leadIds = await familyLeadIds(rootLeadId);
  if (leadIds.length === 0) return [];
  const { data, error } = await supabaseAdmin
    .from("lead_corporate_docs")
    .select("id, file_name, file_url, file_size, custom_type, created_at, hidden_from_client")
    .in("lead_id", leadIds)
    .eq("doc_type", OTHER_DOC_TYPE)
    .ilike("file_url", `%/${AGENT_UPLOAD_PREFIX}/%`)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((d) => ({
    id: d.id,
    fileName: d.file_name,
    fileUrl: d.file_url,
    fileSize: d.file_size,
    label: d.custom_type,
    createdAt: d.created_at,
    shared: !d.hidden_from_client,
  }));
}

/** One of the agent's own documents on this file, or null. */
export async function findAgentDocument(rootLeadId: string, docId: string) {
  return (await listAgentDocuments(rootLeadId)).find((d) => d.id === docId) ?? null;
}

export type AgentNote = { note: string; updatedAt: string | null; schemaReady: boolean };

export async function loadAgentNote(partnerId: string, rootLeadId: string): Promise<AgentNote> {
  const { data, error } = await supabaseAdmin
    .from("agent_file_notes")
    .select("note, updated_at")
    .eq("partner_id", partnerId)
    .eq("root_lead_id", rootLeadId)
    .maybeSingle();
  if (error) {
    if (MISSING_TABLE_CODES.has(error.code)) return { note: "", updatedAt: null, schemaReady: false };
    throw error;
  }
  return { note: data?.note ?? "", updatedAt: data?.updated_at ?? null, schemaReady: true };
}

/** Saves the note; an empty one is removed. */
export async function saveAgentNote(partnerId: string, rootLeadId: string, note: string) {
  const { error } = note
    ? await supabaseAdmin
        .from("agent_file_notes")
        .upsert({ partner_id: partnerId, root_lead_id: rootLeadId, note, updated_at: new Date().toISOString() }, { onConflict: "root_lead_id,partner_id" })
    : await supabaseAdmin.from("agent_file_notes").delete().eq("partner_id", partnerId).eq("root_lead_id", rootLeadId);
  if (error) throw error;
}
