import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";

// In-app notification feed for the sidebar bell.
//
// `notifications` is a BROADCAST table — one row per event, seen by every
// admin — and read state is per-admin in `notification_reads`. So the GET
// overlays the acting admin's receipts onto the shared feed, and the PATCH
// writes receipts for that admin only. Nothing here is per-deal scoped; every
// admin sees every file by design (SEC-004).
//
// Gated to admins by src/middleware.ts (everything under /api/admin/*).

// What the header dropdown reads. The full-feed page at /admin/notifications
// asks for more via ?limit=.
const FEED_LIMIT = 50;
const MAX_LIMIT = 200;

/** Clamp an untrusted ?limit= to something we're willing to serve. */
function parseLimit(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return FEED_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

export async function GET(req: Request) {
  const actor = await getActingAdmin();
  if (!actor.id) {
    return NextResponse.json(
      { success: false, error: "Could not resolve the signed-in admin" },
      { status: 401 },
    );
  }

  const limit = parseLimit(new URL(req.url).searchParams.get("limit"));

  const { data: rows, error } = await supabaseAdmin
    .from("notifications")
    .select("id, type, title, body, deal_id, file_number, metadata, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    logger.error("[notifications] feed read failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to load notifications" },
      { status: 500 },
    );
  }

  const ids = (rows ?? []).map((r) => r.id);
  let readIds = new Set<string>();
  if (ids.length > 0) {
    const { data: reads } = await supabaseAdmin
      .from("notification_reads")
      .select("notification_id")
      .eq("admin_user_id", actor.id)
      .in("notification_id", ids);
    readIds = new Set((reads ?? []).map((r) => r.notification_id));
  }

  const data = (rows ?? []).map((r) => ({ ...r, read: readIds.has(r.id) }));

  return NextResponse.json({
    success: true,
    data,
    unread_count: data.filter((r) => !r.read).length,
  });
}

/**
 * Mark notifications read for the acting admin.
 *   { all: true }        → every notification currently in the feed
 *   { ids: [uuid, ...] } → just those
 */
export async function PATCH(req: Request) {
  const actor = await getActingAdmin();
  if (!actor.id) {
    return NextResponse.json(
      { success: false, error: "Could not resolve the signed-in admin" },
      { status: 401 },
    );
  }

  let body: { all?: boolean; ids?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  let targetIds: string[];

  if (body.all) {
    // MAX_LIMIT, not FEED_LIMIT: "Mark all as read" is also offered on the
    // full-feed page, which can be showing more rows than the dropdown does.
    // Clearing only the first 50 there would leave a still-lit dot behind.
    const { data: rows } = await supabaseAdmin
      .from("notifications")
      .select("id")
      .order("created_at", { ascending: false })
      .limit(MAX_LIMIT);
    targetIds = (rows ?? []).map((r) => r.id);
  } else {
    const raw = Array.isArray(body.ids) ? body.ids : [];
    targetIds = raw.filter((id): id is string => typeof id === "string" && isUuid(id));
    if (targetIds.length !== raw.length) {
      return NextResponse.json(
        { success: false, error: "ids must be an array of notification UUIDs" },
        { status: 400 },
      );
    }
  }

  if (targetIds.length === 0) {
    return NextResponse.json({ success: true, marked: 0 });
  }

  const { error } = await supabaseAdmin.from("notification_reads").upsert(
    targetIds.map((id) => ({
      notification_id: id,
      admin_user_id: actor.id,
      read_at: new Date().toISOString(),
    })),
    { onConflict: "notification_id,admin_user_id" },
  );

  if (error) {
    logger.error("[notifications] failed to record read receipts:", error);
    return NextResponse.json(
      { success: false, error: "Failed to mark notifications read" },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true, marked: targetIds.length });
}
