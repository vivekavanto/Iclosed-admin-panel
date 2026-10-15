// Links a freshly booked signing to the client's file when the booking carried
// no deal id. The portal only links a booking when the client booked from their
// dashboard task or was signed in on the public link; anyone else (typed file
// number, not logged in) was saved with deal_id NULL and so never showed in the
// All Files "Signing" column. The file number alone is not trusted: the booking
// email must also belong to a person on that file, so a mistyped number can't
// attach the booking to someone else's file.

import supabaseAdmin from "./supabaseAdmin";
import { logger } from "./logger";

export async function linkAppointmentToDeal(
  appointmentId: string,
  fileNumber: string | null,
  clientEmail: string,
): Promise<void> {
  const wanted = fileNumber?.trim();
  if (!wanted) return;

  const { data, error } = await supabaseAdmin
    .from("deals")
    .select("id, lead_id, file_number, leads(email)")
    .ilike("file_number", wanted)
    .eq("is_deleted", false);
  if (error) {
    logger.error("[SigningAppointments] deal lookup failed:", error.message);
    return;
  }

  const email = clientEmail.trim().toLowerCase();
  const match = ((data ?? []) as unknown as Array<{
    id: string;
    lead_id: string | null;
    file_number: string | null;
    leads: { email: string | null } | { email: string | null }[] | null;
  }>).find((d) => {
    if ((d.file_number ?? "").trim().toLowerCase() !== wanted.toLowerCase()) return false;
    const lead = Array.isArray(d.leads) ? d.leads[0] : d.leads;
    return (lead?.email ?? "").trim().toLowerCase() === email;
  });
  if (!match) return;

  // Only fills an empty link, so a portal link made in parallel is never overwritten.
  const { error: updateError } = await supabaseAdmin
    .from("signing_appointments")
    .update({ deal_id: match.id, lead_id: match.lead_id })
    .eq("id", appointmentId)
    .is("deal_id", null);
  if (updateError) {
    logger.error("[SigningAppointments] deal link failed:", updateError.message);
  }
}
