import { createHash, randomBytes } from "crypto";
import supabaseAdmin from "./supabaseAdmin";
import type { AgentPermission } from "./agentPortal";

/** Missing table = migration not yet applied; surfaced to the UI rather than thrown. */
export const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205", "PGRST106"]);

/** How long the client's Accept link keeps working. */
export const PERMISSION_REQUEST_TTL_DAYS = 14;

const NONE: AgentPermission = { status: "none", grantedAt: null, requestedAt: null, requestedTo: null, declinedAt: null };

type Row = {
  id: string;
  root_lead_id: string;
  partner_id: string;
  requested_at: string | null;
  requested_to_email: string | null;
  request_token_hash: string | null;
  request_expires_at: string | null;
  declined_at: string | null;
  granted_at: string | null;
  revoked_at: string | null;
};

const COLUMNS = "id, root_lead_id, partner_id, requested_at, requested_to_email, request_token_hash, request_expires_at, declined_at, granted_at, revoked_at";

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const pending = (r: Row) => !!r.request_token_hash && !!r.request_expires_at && new Date(r.request_expires_at).getTime() > Date.now();

function toPermission(r: Row): AgentPermission {
  const base = { requestedAt: r.requested_at, requestedTo: r.requested_to_email, declinedAt: r.declined_at };
  if (r.granted_at && !r.revoked_at) return { ...base, status: "granted", grantedAt: r.granted_at };
  return { ...base, status: pending(r) ? "requested" : "none", grantedAt: null };
}

/** root lead id -> the client's permission for this agent. A missing table reads as none. */
export async function loadAgentPermissions(partnerId: string, rootLeadIds: string[]): Promise<Map<string, AgentPermission>> {
  const out = new Map<string, AgentPermission>();
  if (rootLeadIds.length === 0) return out;
  const { data, error } = await supabaseAdmin.from("agent_task_permissions").select(COLUMNS).eq("partner_id", partnerId).in("root_lead_id", rootLeadIds);
  if (error) {
    if (MISSING_TABLE_CODES.has(error.code)) return out;
    throw error;
  }
  for (const r of (data ?? []) as Row[]) out.set(r.root_lead_id, toPermission(r));
  return out;
}

export async function loadAgentPermission(partnerId: string, rootLeadId: string): Promise<AgentPermission> {
  return (await loadAgentPermissions(partnerId, [rootLeadId])).get(rootLeadId) ?? NONE;
}

export async function hasAgentPermission(partnerId: string, rootLeadId: string): Promise<boolean> {
  return (await loadAgentPermission(partnerId, rootLeadId)).status === "granted";
}

/** Opens a fresh request (replacing any earlier link) and returns the one-time token for the email. */
export async function createPermissionRequest(partnerId: string, rootLeadId: string, email: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const { error } = await supabaseAdmin.from("agent_task_permissions").upsert(
    {
      root_lead_id: rootLeadId,
      partner_id: partnerId,
      requested_at: new Date(now).toISOString(),
      requested_to_email: email,
      request_token_hash: hashToken(token),
      request_expires_at: new Date(now + PERMISSION_REQUEST_TTL_DAYS * 86_400_000).toISOString(),
      declined_at: null,
      granted_at: null,
      granted_by: null,
      granted_by_email: null,
      revoked_at: null,
    },
    { onConflict: "root_lead_id,partner_id" },
  );
  if (error) throw error;
  return token;
}

export type PermissionRequest = { id: string; rootLeadId: string; partnerId: string; email: string | null };

/** The open request a link points at, or why it can't be used. */
export async function findPermissionRequest(token: string): Promise<{ ok: true; request: PermissionRequest } | { ok: false; reason: "missing" | "expired" }> {
  if (!token) return { ok: false, reason: "missing" };
  const { data, error } = await supabaseAdmin.from("agent_task_permissions").select(COLUMNS).eq("request_token_hash", hashToken(token)).maybeSingle<Row>();
  if (error) throw error;
  if (!data) return { ok: false, reason: "missing" };
  if (!pending(data)) return { ok: false, reason: "expired" };
  return { ok: true, request: { id: data.id, rootLeadId: data.root_lead_id, partnerId: data.partner_id, email: data.requested_to_email } };
}

/** The client's answer. The link is spent either way. */
export async function answerPermissionRequest(request: PermissionRequest, accept: boolean) {
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from("agent_task_permissions")
    .update(
      accept
        ? { granted_at: now, granted_by: "client", granted_by_email: request.email, revoked_at: null, request_token_hash: null }
        : { declined_at: now, request_token_hash: null },
    )
    .eq("id", request.id);
  if (error) throw error;
}

/** Ends the permission, or cancels a pending request. */
export async function withdrawAgentPermission(partnerId: string, rootLeadId: string) {
  const { error } = await supabaseAdmin
    .from("agent_task_permissions")
    .update({ revoked_at: new Date().toISOString(), request_token_hash: null })
    .eq("root_lead_id", rootLeadId)
    .eq("partner_id", partnerId);
  if (error) throw error;
}
