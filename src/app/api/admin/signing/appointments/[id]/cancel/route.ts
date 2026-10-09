import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { logger } from "@/lib/logger";
import { isUuid } from "@/lib/isUuid";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { deleteCalendarEvent } from "@/lib/googleCalendar";
import { getSettings } from "@/lib/signingConfig";

// POST /api/admin/signing/appointments/[id]/cancel — staff-initiated
// cancellation. Removes the Google Calendar event (best-effort — a lawyer who
// already deleted it by hand must not block this) then marks the row
// cancelled so it drops out of availability and the default list filter.
// Gated to admins by src/middleware.ts.

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid id" }, { status: 400 });
  }

  const { data: appt, error: fetchError } = await supabaseAdmin
    .from("signing_appointments")
    .select("*, lawyer:signing_lawyers(email, calendar_id)")
    .eq("id", id)
    .maybeSingle();

  if (fetchError || !appt) {
    return NextResponse.json({ success: false, error: "Appointment not found" }, { status: 404 });
  }
  if (appt.status === "cancelled") {
    return NextResponse.json({ success: true, data: appt });
  }

  if (appt.google_event_id && appt.lawyer?.email) {
    try {
      // Google emails its cancellation to the client and guests; clerk and
      // reception stay silent, as they were at booking.
      const settings = await getSettings();
      const clientEmail = String(appt.client_email ?? "").toLowerCase();
      const silentAttendees = [settings.clerk_email, settings.reception_email]
        .filter(Boolean)
        .map((e) => e.toLowerCase())
        .filter((e) => e !== clientEmail);
      await deleteCalendarEvent(
        appt.lawyer.email,
        appt.lawyer.calendar_id ?? "primary",
        appt.google_event_id,
        { notifyAttendees: true, silentAttendees },
      );
    } catch (err) {
      logger.error("[SigningAppointments cancel] calendar delete failed:", err);
      // Still cancel our side — staff can clean up the calendar by hand rather
      // than being stuck unable to free the slot.
    }
  }

  const { data: updated, error: updateError } = await supabaseAdmin
    .from("signing_appointments")
    .update({ status: "cancelled" })
    .eq("id", id)
    .select("*")
    .single();

  if (updateError) {
    logger.error("[SigningAppointments cancel] update failed:", updateError.message);
    return NextResponse.json({ success: false, error: updateError.message }, { status: 500 });
  }

  const actor = await getActingAdmin();
  await recordAudit({
    action: "signing_appointment.cancel",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "signing_appointment",
    resourceId: id,
    req,
  });

  return NextResponse.json({ success: true, data: updated });
}
