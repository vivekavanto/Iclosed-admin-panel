import supabaseAdmin from "./supabaseAdmin";
import { logger } from "./logger";

// SEC-006 / SEC-026 / CMP-004 — write an audit_logs row for a sensitive action.
//
// Deliberately best-effort: auditing must never break the operation it records,
// so all failures are swallowed (and logged to the server console). Call it after
// the action succeeds, passing the request so IP + user-agent are captured.

export type AuditEntry = {
  /** Stable action key, e.g. "impersonate", "deal.delete", "lead.delete". */
  action: string;
  actorEmail?: string | null;
  actorUserId?: string | null;
  /** What was acted on, e.g. "user" / "deal" / "lead". */
  resourceType?: string | null;
  resourceId?: string | null;
  /** Action-specific extra context (no secrets). */
  metadata?: Record<string, unknown> | null;
  /** The incoming request — used to capture IP + user-agent. */
  req?: Request;
};

function clientIp(req?: Request): string | null {
  if (!req) return null;
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() || null;
  return req.headers.get("x-real-ip");
}

export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await supabaseAdmin.from("audit_logs").insert({
      action: entry.action,
      actor_email: entry.actorEmail ?? null,
      actor_user_id: entry.actorUserId ?? null,
      resource_type: entry.resourceType ?? null,
      resource_id: entry.resourceId ?? null,
      metadata: entry.metadata ?? null,
      ip: clientIp(entry.req),
      user_agent: entry.req?.headers.get("user-agent") ?? null,
    });
  } catch (err) {
    logger.error("[recordAudit] failed to write audit row:", err);
  }
}
