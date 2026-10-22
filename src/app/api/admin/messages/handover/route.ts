import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/recordAudit";
import { resolveMessageActor } from "@/lib/messageActor";
import { handoverAll } from "@/lib/dealMessages";

// Move every file chat one staff member handles to another — for someone
// leaving, going on leave, or swapping work. The chats belong to the files, so
// the new handler sees each one's full history; each file gets a "Handed over
// from … to …" line and a handler-history entry.
//
// GET  — { staff: [{ name, email }], handlers: [{ email, name, files }] }: who
//        can receive, and who currently handles at least one file chat
//        (including people no longer active, who most need moving).
// POST — { from: email, to: email } -> { moved: n }. Audited.
//
// Under /api/admin/messages, so src/middleware.ts admits only staff with the
// Messages module.

export async function GET() {
  try {
    const [{ data: staff }, { data: convs }] = await Promise.all([
      supabaseAdmin.from("admin_users").select("name, email").eq("is_active", true).order("name"),
      supabaseAdmin.from("deal_conversations").select("assignee_email, assignee_name").not("assignee_email", "is", null),
    ]);
    const by = new Map<string, { email: string; name: string; files: number }>();
    for (const c of convs ?? []) {
      const key = (c.assignee_email as string).toLowerCase();
      const cur = by.get(key) ?? { email: c.assignee_email as string, name: (c.assignee_name as string | null) || (c.assignee_email as string), files: 0 };
      cur.files += 1;
      by.set(key, cur);
    }
    return NextResponse.json({
      success: true,
      staff: (staff ?? []).filter((s) => s.email),
      handlers: [...by.values()].sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (err) {
    logger.error("[Handover] list failed:", err);
    return NextResponse.json({ success: false, error: "Could not load staff" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { from, to } = (await req.json().catch(() => ({}))) as { from?: unknown; to?: unknown };
    if (typeof from !== "string" || !from.trim() || typeof to !== "string" || !to.trim()) {
      return NextResponse.json({ success: false, error: "Choose who to move the files from and to" }, { status: 400 });
    }
    if (from.trim().toLowerCase() === to.trim().toLowerCase()) {
      return NextResponse.json({ success: false, error: "Pick two different people" }, { status: 400 });
    }
    const { data: person } = await supabaseAdmin
      .from("admin_users")
      .select("name, email")
      .ilike("email", to.trim())
      .eq("is_active", true)
      .maybeSingle();
    if (!person?.email) {
      return NextResponse.json({ success: false, error: "The new handler must be an active staff member" }, { status: 400 });
    }

    const actor = await resolveMessageActor();
    const moved = await handoverAll(from, { email: person.email, name: person.name || person.email }, actor);
    await recordAudit({
      action: "chat.handover_all",
      actorEmail: actor.email,
      actorUserId: actor.id,
      resourceType: "deal_conversations",
      resourceId: null,
      metadata: { from: from.trim().toLowerCase(), to: person.email.toLowerCase(), moved },
      req,
    });
    return NextResponse.json({ success: true, moved });
  } catch (err) {
    logger.error("[Handover] move failed:", err);
    return NextResponse.json({ success: false, error: "Could not move the files" }, { status: 500 });
  }
}
