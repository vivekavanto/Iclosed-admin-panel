import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { NEW_LEAD_TYPE } from "@/lib/notificationTypes";
import { logger } from "@/lib/logger";

// Backs the yellow dot on the sidebar's "Leads" button.
//
// Deliberately NOT served off /api/admin/notifications: the sidebar is mounted
// on every admin page and polls on its own cadence, and that route returns up
// to 200 fully-hydrated rows (titles, addresses, metadata) just to answer a
// yes/no question. This one reads ids only.
//
// "New" is per-admin unread, not a lead column. Reusing notification_reads
// means the badge, the bell and /admin/notifications can never disagree about
// what has been seen, and one admin clearing it doesn't blank it for the rest
// of the team — the same broadcast/receipt split the feed already uses.
//
// Gated to admins by src/middleware.ts (everything under /api/admin/*).

// The badge is binary, so there is no reason to scan deeper than this. A back
// office sitting on 200 unread new leads has a bigger problem than the dot.
const SCAN_LIMIT = 200;

/**
 * Unread `lead.created` notification ids for the acting admin, newest first.
 * Shared by GET (count them) and PATCH (mark them read).
 */
async function unreadNewLeadIds(adminId: string): Promise<string[] | null> {
  const { data: rows, error } = await supabaseAdmin
    .from("notifications")
    .select("id")
    .eq("type", NEW_LEAD_TYPE)
    .order("created_at", { ascending: false })
    .limit(SCAN_LIMIT);

  if (error) {
    logger.error("[notifications/new-leads] feed read failed:", error);
    return null;
  }

  const ids = (rows ?? []).map((r) => r.id);
  if (ids.length === 0) return [];

  const { data: reads, error: readErr } = await supabaseAdmin
    .from("notification_reads")
    .select("notification_id")
    .eq("admin_user_id", adminId)
    .in("notification_id", ids);

  if (readErr) {
    logger.error("[notifications/new-leads] read receipts lookup failed:", readErr);
    return null;
  }

  const readIds = new Set((reads ?? []).map((r) => r.notification_id));
  return ids.filter((id) => !readIds.has(id));
}

/** GET → `{ success, count }` — how many new leads this admin hasn't looked at. */
export async function GET() {
  const actor = await getActingAdmin();
  if (!actor.id) {
    return NextResponse.json(
      { success: false, error: "Could not resolve the signed-in admin" },
      { status: 401 },
    );
  }

  const ids = await unreadNewLeadIds(actor.id);
  if (ids === null) {
    return NextResponse.json(
      { success: false, error: "Failed to load new lead count" },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true, count: ids.length });
}

/**
 * PATCH → mark every unread `lead.created` row read for the acting admin.
 *
 * Called by the leads list when it mounts: opening the page IS the act of
 * looking, which is what the alert asks staff to do, so the dot clears there
 * rather than only from the bell.
 */
export async function PATCH() {
  const actor = await getActingAdmin();
  if (!actor.id) {
    return NextResponse.json(
      { success: false, error: "Could not resolve the signed-in admin" },
      { status: 401 },
    );
  }

  const ids = await unreadNewLeadIds(actor.id);
  if (ids === null) {
    return NextResponse.json(
      { success: false, error: "Failed to mark new leads seen" },
      { status: 500 },
    );
  }

  if (ids.length === 0) {
    return NextResponse.json({ success: true, marked: 0 });
  }

  const { error } = await supabaseAdmin.from("notification_reads").upsert(
    ids.map((id) => ({
      notification_id: id,
      admin_user_id: actor.id,
      read_at: new Date().toISOString(),
    })),
    { onConflict: "notification_id,admin_user_id" },
  );

  if (error) {
    logger.error("[notifications/new-leads] failed to record read receipts:", error);
    return NextResponse.json(
      { success: false, error: "Failed to mark new leads seen" },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true, marked: ids.length });
}
