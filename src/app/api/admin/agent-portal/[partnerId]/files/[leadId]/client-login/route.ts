import { NextRequest, NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { recordAudit } from "@/lib/recordAudit";
import { loadAgentRootLead } from "@/lib/agentPortalData";
import { hasAgentPermission } from "@/lib/agentTaskPermission";
import { createPortalLoginLink } from "@/lib/portalLoginLink";

const LOCKED = ["Closed", "Cancelled", "Inactive"];

const fail = (error: string, status: number) => NextResponse.json({ success: false, error }, { status });

// POST — a magic link into the client's portal, once the client has given permission
// and signed in at least once. Audited.
export async function POST(req: NextRequest, { params }: { params: Promise<{ partnerId: string; leadId: string }> }) {
  const { partnerId, leadId } = await params;
  if (!isUuid(partnerId) || !isUuid(leadId)) return fail("Invalid id", 400);

  try {
    const root = await loadAgentRootLead(partnerId, leadId);
    if (!root) return fail("File not found", 404);
    if (!(await hasAgentPermission(partnerId, root))) return fail("The client hasn't given you permission yet", 403);

    const [{ data: lead }, { data: deal }] = await Promise.all([
      supabaseAdmin.from("leads").select("client_id").eq("id", root).maybeSingle(),
      supabaseAdmin.from("deals").select("client_id, status").eq("lead_id", root).eq("is_deleted", false).maybeSingle(),
    ]);
    if (LOCKED.includes(deal?.status ?? "")) return fail(`This file is ${deal?.status?.toLowerCase()}`, 409);

    const clientId = lead?.client_id ?? deal?.client_id;
    const { data: client } = clientId
      ? await supabaseAdmin.from("clients").select("auth_user_id").eq("id", clientId).maybeSingle()
      : { data: null };
    if (!client?.auth_user_id) return fail("The client hasn't signed in to their portal yet", 409);

    const { data: user, error: userErr } = await supabaseAdmin.auth.admin.getUserById(client.auth_user_id);
    const email = user?.user?.email;
    if (userErr || !email) return fail("Could not find the client's portal account", 400);

    const link = await createPortalLoginLink(email);
    if ("error" in link) {
      logger.error("[agent-portal] client login link failed:", link.error);
      return fail("Could not open the client's portal", 500);
    }

    const actor = await getActingAdmin();
    await recordAudit({
      action: "partner.client_login",
      actorEmail: actor.email,
      actorUserId: actor.id,
      resourceType: "user",
      resourceId: email,
      metadata: { partnerId, rootLeadId: root, target_email: email, auth_user_id: client.auth_user_id },
      req,
    });
    return NextResponse.json({ success: true, url: link.url });
  } catch (err) {
    logger.error("[agent-portal] client login failed:", err);
    return fail("Could not open the client's portal", 500);
  }
}
