import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { logger } from "@/lib/logger";

/**
 * Reassign who uploads documents for a family, AFTER intake.
 *
 * The customer portal asks this once at intake (Step 5) and writes
 * `leads.upload_mode` on the PRIMARY lead. Nothing in either app could change it
 * afterwards — this route is that missing control, admin-side only (the portal
 * stays read-only by decision).
 *
 *   'me'   → the primary uploads for everyone
 *   'co'   → the co-person named in upload_consent_uploader_lead_id does
 *   'both' → each person uploads their own; nobody acts for anyone else
 *
 * All three columns live on the ROOT lead regardless of which family member's
 * deal the admin is looking at, so we resolve the root first and write there.
 *
 * Downstream this drives, in BOTH apps:
 *   - who may submit a task on another party's behalf
 *     (portal `on-behalf-targets`, admin `SubmitOnBehalfSection`)
 *   - which parties can edit their own personal-info / ID tasks
 *     (`family-task-status` → can_edit)
 *   - who gets invited to the portal at conversion time (`convertLead`)
 *
 * The last one is why the response carries `needs_invite`: switching to a mode
 * that makes someone responsible does NOT give them a login. Those people were
 * deliberately never invited under the old mode, so we report them and let the
 * admin send the invite explicitly (POST /api/admin/leads/[id]/portal-invite).
 */

const ALLOWED_MODES = new Set(["me", "co", "both"]);

type FamilyLead = {
  id: string;
  parent_lead_id: string | null;
  first_name: string | null;
  last_name: string | null;
  corporate_name: string | null;
  email: string | null;
  client_id: string | null;
};

function displayName(l: FamilyLead): string {
  const person = `${l.first_name ?? ""} ${l.last_name ?? ""}`.trim();
  return person || l.corporate_name || l.email || "Unknown";
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid deal id" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const mode = typeof body.mode === "string" ? body.mode : null;
  const requestedUploaderId =
    typeof body.uploader_lead_id === "string" ? body.uploader_lead_id : null;

  if (!mode || !ALLOWED_MODES.has(mode)) {
    return NextResponse.json(
      { success: false, error: "mode must be one of 'me', 'co', 'both'" },
      { status: 400 },
    );
  }
  if (requestedUploaderId && !isUuid(requestedUploaderId)) {
    return NextResponse.json(
      { success: false, error: "Invalid uploader_lead_id" },
      { status: 400 },
    );
  }

  // ── Resolve the family from the deal ───────────────────────────────────────
  const { data: deal } = await supabaseAdmin
    .from("deals")
    .select("id, lead_id")
    .eq("id", id)
    .maybeSingle();

  if (!deal?.lead_id) {
    return NextResponse.json({ success: false, error: "Deal not found" }, { status: 404 });
  }

  const { data: lead } = await supabaseAdmin
    .from("leads")
    .select("id, parent_lead_id")
    .eq("id", deal.lead_id)
    .maybeSingle();

  if (!lead) {
    return NextResponse.json(
      { success: false, error: "This deal has no lead record" },
      { status: 404 },
    );
  }

  const rootLeadId: string = (lead.parent_lead_id as string | null) ?? (lead.id as string);
  // rootLeadId is spliced into an .or() filter string — guard it as a UUID
  // (SEC-013) even though it came off a DB row.
  if (!isUuid(rootLeadId)) {
    return NextResponse.json(
      { success: false, error: "Could not resolve the primary lead for this file" },
      { status: 500 },
    );
  }

  const { data: familyRows, error: familyErr } = await supabaseAdmin
    .from("leads")
    .select(
      "id, parent_lead_id, first_name, last_name, corporate_name, email, client_id, upload_mode, upload_consent_uploader_lead_id",
    )
    .or(`id.eq.${rootLeadId},parent_lead_id.eq.${rootLeadId}`);

  if (familyErr) {
    logger.error("[upload-mode] family lookup failed:", familyErr);
    return NextResponse.json(
      { success: false, error: "Could not load the people on this file" },
      { status: 500 },
    );
  }

  const family = (familyRows ?? []) as unknown as (FamilyLead & {
    upload_mode: string | null;
    upload_consent_uploader_lead_id: string | null;
  })[];
  const rootLead = family.find((l) => l.id === rootLeadId);
  const coLeads = family.filter((l) => l.id !== rootLeadId);

  if (!rootLead) {
    return NextResponse.json(
      { success: false, error: "Could not resolve the primary lead for this file" },
      { status: 500 },
    );
  }
  if (coLeads.length === 0) {
    return NextResponse.json(
      {
        success: false,
        error:
          "There is only one person on this file, so there is nothing to reassign.",
      },
      { status: 400 },
    );
  }

  // ── Validate the target uploader ───────────────────────────────────────────
  // 'co' must name an actual co-person on THIS file. Naming the primary is a
  // request for 'me', not 'co' — we normalise rather than reject so the UI can
  // treat "who uploads" as a single list of people.
  let nextMode = mode;
  let uploaderLeadId: string | null = null;

  if (mode === "co") {
    if (!requestedUploaderId) {
      return NextResponse.json(
        { success: false, error: "Select which co-person will upload the documents." },
        { status: 400 },
      );
    }
    if (requestedUploaderId === rootLeadId) {
      nextMode = "me";
      uploaderLeadId = null;
    } else if (!coLeads.some((l) => l.id === requestedUploaderId)) {
      return NextResponse.json(
        { success: false, error: "That person is not on this file." },
        { status: 400 },
      );
    } else {
      uploaderLeadId = requestedUploaderId;
    }
  }

  const previousMode = rootLead.upload_mode ?? null;
  const previousUploaderId = rootLead.upload_consent_uploader_lead_id ?? null;

  // ── Write ──────────────────────────────────────────────────────────────────
  // Mirrors what the portal's intake route persists. `upload_consent_at` is the
  // audit trail for a designated-uploader arrangement, so it is only meaningful
  // for 'co' and is cleared otherwise — an admin reassignment stamps it now.
  const { error: updateErr } = await supabaseAdmin
    .from("leads")
    .update({
      upload_mode: nextMode,
      upload_consent_at: nextMode === "co" ? new Date().toISOString() : null,
      upload_consent_uploader_lead_id: nextMode === "co" ? uploaderLeadId : null,
    })
    .eq("id", rootLeadId);

  if (updateErr) {
    logger.error("[upload-mode] update failed:", updateErr);
    return NextResponse.json(
      { success: false, error: "Could not save the document-upload assignment" },
      { status: 500 },
    );
  }

  const actor = await getActingAdmin();
  await recordAudit({
    action: "lead.upload_mode.change",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "lead",
    resourceId: rootLeadId,
    metadata: {
      deal_id: id,
      from_mode: previousMode,
      to_mode: nextMode,
      from_uploader_lead_id: previousUploaderId,
      to_uploader_lead_id: nextMode === "co" ? uploaderLeadId : null,
    },
    req,
  });

  // ── Who now needs a portal login? ──────────────────────────────────────────
  // The set of people the new mode makes responsible for uploading. Under 'me'
  // and 'co' only the single uploader acts; under 'both' everyone does.
  const responsibleIds =
    nextMode === "both"
      ? family.map((l) => l.id)
      : nextMode === "co" && uploaderLeadId
        ? [uploaderLeadId]
        : [rootLeadId];

  const clientIds = Array.from(
    new Set(
      family
        .filter((l) => responsibleIds.includes(l.id))
        .map((l) => l.client_id)
        .filter(Boolean) as string[],
    ),
  );
  const { data: clientRows } = clientIds.length
    ? await supabaseAdmin
        .from("clients")
        .select("id, auth_user_id")
        .in("id", clientIds)
    : { data: [] as { id: string; auth_user_id: string | null }[] };
  const authIdByClientId = new Map<string, string | null>(
    (clientRows ?? []).map((c) => [c.id as string, (c.auth_user_id as string | null) ?? null]),
  );

  const needsInvite = family
    .filter((l) => responsibleIds.includes(l.id))
    .filter((l) => !!l.email)
    .filter((l) => !(l.client_id && authIdByClientId.get(l.client_id)))
    .map((l) => ({
      lead_id: l.id,
      name: displayName(l),
      email: l.email as string,
      is_primary: l.id === rootLeadId,
      // No clients row means the lead was never converted — an invite can't be
      // linked to a portal account yet, so the UI surfaces this differently.
      convertible: !!l.client_id,
    }));

  return NextResponse.json({
    success: true,
    upload_mode: nextMode,
    uploader_lead_id: nextMode === "co" ? uploaderLeadId : nextMode === "me" ? rootLeadId : null,
    previous_upload_mode: previousMode,
    root_lead_id: rootLeadId,
    needs_invite: needsInvite,
  });
}
