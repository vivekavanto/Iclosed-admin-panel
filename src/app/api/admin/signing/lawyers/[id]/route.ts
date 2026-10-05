import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { isUuid } from "@/lib/isUuid";

// PUT /api/admin/signing/lawyers/[id] — update a lawyer (name, email, hours link lives separately).
// DELETE /api/admin/signing/lawyers/[id] — soft-delete by deactivating (never hard-delete: past
// appointments still reference this row).
// Gated to admins by src/middleware.ts.

const EDITABLE_FIELDS = ["initials", "full_name", "email", "calendar_id", "is_active"] as const;

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid id" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  for (const field of EDITABLE_FIELDS) {
    if (body[field] === undefined) continue;
    if (field === "initials" && typeof body[field] === "string") {
      updates[field] = (body[field] as string).trim().toUpperCase();
    } else if (field === "email" && typeof body[field] === "string") {
      updates[field] = (body[field] as string).trim().toLowerCase();
    } else {
      updates[field] = body[field];
    }
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ success: false, error: "No editable fields supplied" }, { status: 400 });
  }
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from("signing_lawyers")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    logger.error("[SigningLawyers PUT] update failed:", error.message);
    const status = error.code === "23505" ? 409 : 400;
    return NextResponse.json({ success: false, error: error.message }, { status });
  }

  const actor = await getActingAdmin();
  await recordAudit({
    action: "signing_lawyer.update",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "signing_lawyer",
    resourceId: id,
    metadata: { changed: Object.keys(updates).filter((k) => k !== "updated_at") },
    req,
  });

  return NextResponse.json({ success: true, data });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid id" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("signing_lawyers")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    logger.error("[SigningLawyers DELETE] deactivate failed:", error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 400 });
  }

  const actor = await getActingAdmin();
  await recordAudit({
    action: "signing_lawyer.deactivate",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "signing_lawyer",
    resourceId: id,
    req,
  });

  return NextResponse.json({ success: true, data });
}
