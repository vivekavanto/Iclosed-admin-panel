import supabaseAdmin from "@/lib/supabaseAdmin";
import { logger } from "@/lib/logger";

// Label the client portal's signing task modal saves its "I have booked" tick under.
const BOOKED_LABEL = "I have booked my appointment";

/**
 * A cancelled signing appointment puts the client's "Book your signing
 * appointment" task back to Pending, undoing the auto-complete the portal did
 * when the booking was made (src/app/api/signing/appointments/route.ts in the
 * customer repo). Same reset the admin uses when a task is moved off Completed:
 * status Pending, completed false, completed_at null.
 *
 * Skipped when the appointment was never linked to a deal, when another
 * confirmed appointment still covers the same property, or when the side can't
 * be told apart on a Purchase & Sale file. Best-effort: the caller has already
 * cancelled the appointment, so this never throws.
 */
export async function reopenSigningTask(appt: {
  id: string;
  deal_id?: string | null;
  side?: string | null;
}): Promise<void> {
  try {
    if (!appt.deal_id) return;
    const side = appt.side === "purchase" || appt.side === "sale" ? appt.side : null;

    // One booking per property: if another one is still confirmed, the task
    // should stay complete.
    const { data: stillBooked } = await supabaseAdmin
      .from("signing_appointments")
      .select("id, side")
      .eq("deal_id", appt.deal_id)
      .eq("status", "confirmed")
      .neq("id", appt.id);
    if ((stillBooked ?? []).some((a) => !side || !a.side || a.side === side)) return;

    const { data: tasks } = await supabaseAdmin
      .from("tasks")
      .select("id, milestone_id, side")
      .eq("deal_id", appt.deal_id)
      .eq("completed", true)
      .eq("is_deleted", false)
      .ilike("title", "%book your signing appointment%");
    const candidates = (tasks ?? []).filter((t) => !side || !t.side || t.side === side);
    if (candidates.length !== 1) {
      if (candidates.length > 1) {
        logger.error("[SigningAppointments cancel] ambiguous signing task, left completed:", {
          appointmentId: appt.id,
          dealId: appt.deal_id,
        });
      }
      return;
    }
    const task = candidates[0];

    await supabaseAdmin
      .from("tasks")
      .update({ status: "Pending", completed: false, completed_at: null })
      .eq("id", task.id);

    // Otherwise the modal reopens with "I have booked my appointment" pre-ticked.
    await supabaseAdmin
      .from("task_responses")
      .delete()
      .eq("task_id", task.id)
      .eq("field_label", BOOKED_LABEL);

    // The booking may have been the last open task in its stage. email_sent is
    // left alone so completing the stage again doesn't re-send the client email.
    if (task.milestone_id) {
      await supabaseAdmin
        .from("milestones")
        .update({ status: "Pending", completed_at: null })
        .eq("id", task.milestone_id)
        .eq("status", "Completed");
    }
  } catch (err) {
    logger.error("[SigningAppointments cancel] reopening signing task failed:", err);
  }
}
