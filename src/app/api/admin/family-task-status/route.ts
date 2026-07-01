import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { getFamilyTaskRoster } from "@/lib/familyTaskTargets";
import { isUploadIdTask, REQUIRED_ID_DOCS } from "@/lib/taskKinds";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/family-task-status?task_id=<taskId>&self_lead_id=<leadId>
 *
 * Admin-side mirror of the portal's /api/family-task-status. For a per-party
 * task (Personal Information / Upload Identification) on a deal with co-persons,
 * returns every involved party's copy status so the admin's multi-party
 * accordion can render "1 of 2 complete", per-person doc counts, and — crucially
 * — the SAME edit gating the client sees.
 *
 * Back-office rule: the admin can edit EVERY party's section (`can_edit: true`),
 * regardless of the family's upload_mode / submit_on_behalf. Those client-side
 * permissions govern who may submit in the customer portal; admin staff fill on
 * behalf of anyone, so the accordion never locks a section here. `self_lead_id`
 * (the viewed deal's lead) is used only to flag `is_self` for display.
 *
 * Access is gated by the admin-session middleware (all /api/admin/* routes), so
 * no per-caller ownership check is performed here — the admin sees every deal.
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const taskId = searchParams.get("task_id");
    if (!taskId) {
      return NextResponse.json({ success: false, error: "task_id is required" }, { status: 400 });
    }

    const roster = await getFamilyTaskRoster(taskId);
    if (!roster) {
      return NextResponse.json({ success: false, error: "Task not found" }, { status: 404 });
    }

    // The person whose client experience the admin is mirroring — the viewed
    // deal's lead — defaults to the opened task's own lead.
    const selfLeadId = searchParams.get("self_lead_id") || roster.selfLeadId;

    const isIdTask = isUploadIdTask(roster.task.title);

    // For Upload ID, count each party's uploaded identification documents.
    const docCounts: Record<string, number> = {};
    if (isIdTask) {
      const leadIds = roster.members.map((m) => m.lead_id);
      const { data: docs } = await supabaseAdmin
        .from("lead_corporate_docs")
        .select("lead_id")
        .in("lead_id", leadIds)
        .eq("doc_type", "identification");
      for (const d of docs ?? []) {
        docCounts[d.lead_id] = (docCounts[d.lead_id] ?? 0) + 1;
      }
    }

    const members = roster.members.map((m) => {
      const isSelf = m.lead_id === selfLeadId;
      return {
        lead_id: m.lead_id,
        deal_id: m.deal_id,
        task_id: m.task_id,
        name: `${m.first_name} ${m.last_name}`.trim(),
        first_name: m.first_name,
        last_name: m.last_name,
        role_label: m.role_label,
        is_primary: m.is_primary,
        is_self: isSelf,
        // Back-office: admin may fill any party's section.
        can_edit: true,
        completed: m.completed,
        ...(isIdTask
          ? { doc_count: docCounts[m.lead_id] ?? 0, doc_total: REQUIRED_ID_DOCS }
          : {}),
      };
    });

    const all_completed = members.every((m) => m.completed);
    const completed_count = members.filter((m) => m.completed).length;

    return NextResponse.json({
      success: true,
      task_id: roster.task.id,
      title: roster.task.title,
      is_id_task: isIdTask,
      is_multi_party: members.length > 1,
      all_completed,
      completed_count,
      total_count: members.length,
      members,
    });
  } catch (err) {
    console.error("GET /api/admin/family-task-status error:", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
