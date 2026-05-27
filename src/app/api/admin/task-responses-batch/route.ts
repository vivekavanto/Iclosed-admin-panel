import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { getFamilyDealIds } from "@/lib/familyDeals";
import { recalcMilestonesForFamily } from "@/lib/recalcMilestones";

/**
 * POST /api/admin/task-responses-batch
 *
 * Batch endpoint used by the admin UploadIdentificationDrawer. Accepts:
 *   { task_id, responses: Array<{ field_label, field_type, value?, file_url?, file_name? }>, draft?: boolean }
 *
 * Deletes existing rows for the task, inserts the new batch, then marks the
 * task completed unless `draft` is true. Kept separate from the existing
 * /api/admin/task-responses route (which takes one response at a time) so the
 * admin's other flows are untouched.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { task_id, responses, draft } = body as {
      task_id?: string;
      responses?: Array<{
        field_id?: string | null;
        field_label?: string;
        field_type?: string;
        value?: string | null;
        file_url?: string | null;
        file_name?: string | null;
      }>;
      draft?: boolean;
    };

    if (!task_id || !Array.isArray(responses) || responses.length === 0) {
      return NextResponse.json(
        { success: false, error: "task_id and responses[] are required" },
        { status: 400 },
      );
    }

    await supabaseAdmin.from("task_responses").delete().eq("task_id", task_id);

    const rows = responses.map((r) => ({
      task_id,
      field_id: r.field_id ?? null,
      field_label: r.field_label,
      field_type: r.field_type,
      value: r.value ?? null,
      file_url: r.file_url ?? null,
      file_name: r.file_name ?? null,
    }));

    const { error: insertError } = await supabaseAdmin
      .from("task_responses")
      .insert(rows);

    if (insertError) {
      return NextResponse.json({ success: false, error: insertError.message }, { status: 400 });
    }

    if (!draft) {
      await supabaseAdmin
        .from("tasks")
        .update({
          completed: true,
          status: "Completed",
          completed_at: new Date().toISOString(),
        })
        .eq("id", task_id);

      // Explicit milestone recalc so the co-purchaser's milestone advances
      // server-side instead of relying on the client to reload. Looks up the
      // task's deal to resolve the family. Non-blocking on failure.
      try {
        const { data: taskRow } = await supabaseAdmin
          .from("tasks")
          .select("deal_id")
          .eq("id", task_id)
          .single();
        const dealId = taskRow?.deal_id as string | undefined;
        if (dealId) {
          const familyDealIds = await getFamilyDealIds(dealId);
          if (familyDealIds.length > 0) {
            // Pass the task's own deal as primaryDealId — matches the pattern
            // used by tasks/route.ts (personal-task recalc) and
            // maybeCompleteFileTask. ID tasks are non-shared so the primary
            // arg only governs shared-task sourcing, which is empty here.
            await recalcMilestonesForFamily(familyDealIds, dealId);
          }
        }
      } catch (recalcErr) {
        console.error(
          "[task-responses-batch] milestone recalc failed (non-blocking):",
          recalcErr,
        );
      }
    }

    return NextResponse.json({ success: true, draft: !!draft });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
