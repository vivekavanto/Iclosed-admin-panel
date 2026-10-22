import { NextResponse } from "next/server";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { logger } from "@/lib/logger";
import { effectiveStatus, loadStaffPresence, recordStaffPresence } from "@/lib/chatPresence";

// Staff Online / Away for the client chat.
//
// GET  — { me: { manual, status } | null, staff: [{ email, status }] } for the
//        sidebar menu and the inbox's assign menu. `available: false` when the
//        presence migration has not run (the UI then hides the control).
// POST — heartbeat / change: { manual?: "online" | "away", auto_away?: boolean,
//        offline?: boolean }. Sent every 30 s by each admin tab, on a menu pick,
//        and as a sendBeacon when the last tab closes.
//
// Under /api/admin/messages, so src/middleware.ts admits only staff with the
// Messages module — which also makes them the only auto-routing candidates.

export async function GET() {
  try {
    const actor = await getActingAdmin();
    const rows = await loadStaffPresence();
    if (!rows) return NextResponse.json({ success: true, available: false, me: null, staff: [] });
    const now = Date.now();
    const mine = rows.find((r) => r.staff_email === (actor.email ?? "").toLowerCase());
    return NextResponse.json({
      success: true,
      available: true,
      me: mine ? { manual: mine.manual_status, status: effectiveStatus(mine, now) } : null,
      staff: rows.map((r) => ({ email: r.staff_email, status: effectiveStatus(r, now) })),
    });
  } catch (err) {
    logger.error("[Presence] read failed:", err);
    return NextResponse.json({ success: false, error: "Could not load availability" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const actor = await getActingAdmin();
    if (!actor.email) return NextResponse.json({ success: false, error: "Not signed in" }, { status: 401 });
    // sendBeacon posts text/plain, so parse the raw body rather than trust the header.
    const raw = await req.text().catch(() => "");
    let body: { manual?: unknown; auto_away?: unknown; offline?: unknown } = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return NextResponse.json({ success: false, error: "Invalid body" }, { status: 400 });
    }
    const manual = body.manual === "online" || body.manual === "away" ? body.manual : undefined;
    const result = await recordStaffPresence(actor.email, {
      manual,
      autoAway: body.auto_away === true,
      offline: body.offline === true,
    });
    if (!result) return NextResponse.json({ success: true, available: false });
    return NextResponse.json({ success: true, available: true, me: result });
  } catch (err) {
    logger.error("[Presence] write failed:", err);
    return NextResponse.json({ success: false, error: "Could not update availability" }, { status: 500 });
  }
}
