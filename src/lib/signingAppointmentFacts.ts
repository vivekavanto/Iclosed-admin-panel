// Signing-appointment placeholders for milestone emails ({{ signing_date }},
// {{ signing_time }}, {{ signing_type }}).
//
// Used by sendMilestoneEmail so the agent's "signing booked" email can say when
// and how the signing happens. Best-effort: no appointment (or a failed lookup)
// yields "-" for every key, so no raw "{{ … }}" text ever reaches an inbox.

import supabaseAdmin from "./supabaseAdmin";
import { logger } from "./logger";
import { getFamilyDealIds } from "./familyDeals";
import { OFFICE_TIMEZONE } from "./signingTimezone";
import type { Side } from "./milestoneSide";

export type SigningFacts = {
  signing_date: string;
  signing_time: string;
  signing_type: string;
};

const NONE: SigningFacts = { signing_date: "-", signing_time: "-", signing_type: "-" };
const TYPE_LABEL: Record<string, string> = { virtual: "Virtual", in_person: "In Person" };

/**
 * The newest confirmed signing appointment across the file's family. On a
 * Purchase & Sale file the milestone's side picks the matching booking; a
 * side-less stage (or a booking with no recorded side) takes the newest one.
 */
export async function loadSigningFacts(
  dealId: string | null | undefined,
  side: Side | null,
): Promise<SigningFacts> {
  if (!dealId) return { ...NONE };
  try {
    const dealIds = await getFamilyDealIds(dealId);
    const { data } = await supabaseAdmin
      .from("signing_appointments")
      .select("start_at, appointment_type, side")
      .in("deal_id", dealIds)
      .eq("status", "confirmed")
      .order("created_at", { ascending: false });

    const rows = data ?? [];
    const appt =
      (side ? rows.find((r) => r.side === side) : null) ?? rows[0] ?? null;
    if (!appt?.start_at) return { ...NONE };

    const start = new Date(appt.start_at);
    return {
      signing_date: start.toLocaleDateString("en-US", {
        timeZone: OFFICE_TIMEZONE,
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
      signing_time: start.toLocaleTimeString("en-US", {
        timeZone: OFFICE_TIMEZONE,
        hour: "numeric",
        minute: "2-digit",
      }),
      signing_type: TYPE_LABEL[appt.appointment_type] ?? "-",
    };
  } catch (err) {
    logger.warn("[signingAppointmentFacts] lookup failed:", err);
    return { ...NONE };
  }
}
