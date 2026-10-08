// Builds the Google Calendar event title/description/attendees/location for
// a signing appointment. Shared by the create route (Phase B) and the
// reschedule route (Phase D) so both produce identical wording.

import type { SigningLawyer, SigningSettings } from "./signingConfig";
import { OFFICE_TIMEZONE } from "./signingTimezone";

export interface SigningBookingInput {
  clientName: string;
  clientEmail: string;
  clientPhone: string | null;
  propertyAddress: string | null;
  closingDate: string | null; // YYYY-MM-DD
  dealType: "purchase" | "sale" | "refinance" | null;
  appointmentType: "virtual" | "in_person";
  fileNumber: string | null;
  extraGuests: string[];
  extraCohosts: string[];
}

const DEAL_TYPE_LABEL: Record<string, string> = { purchase: "Purchase", sale: "Sale", refinance: "Refinance" };
const APPT_TYPE_LABEL: Record<string, string> = { virtual: "Virtual", in_person: "In Person" };

/** "AT: 123 Main Street Signing Appointment [Virtual] [Purchase]" */
export function buildEventTitle(lawyer: SigningLawyer, booking: SigningBookingInput): string {
  const address = booking.propertyAddress?.trim() || "Property TBD";
  const apptLabel = APPT_TYPE_LABEL[booking.appointmentType] ?? booking.appointmentType;
  const dealLabel = booking.dealType ? DEAL_TYPE_LABEL[booking.dealType] : null;
  const dealPart = dealLabel ? ` [${dealLabel}]` : "";
  return `${lawyer.initials}: ${address} Signing Appointment [${apptLabel}]${dealPart}`;
}

export function buildEventDescription(
  booking: SigningBookingInput,
  settings: SigningSettings,
): string {
  const lines = [
    `Name: ${booking.clientName}`,
    `Phone: ${booking.clientPhone || "-"}`,
  ];
  if (booking.fileNumber) lines.push(`File number: ${booking.fileNumber}`);
  lines.push("", settings.disclaimer_text);
  return lines.join("\n");
}

export function buildLocation(
  booking: SigningBookingInput,
  settings: SigningSettings,
): string {
  return booking.appointmentType === "in_person" ? settings.office_address : "Google Meet (link in invite)";
}

export function buildAttendeeList(
  booking: SigningBookingInput,
  settings: SigningSettings,
): string[] {
  const set = new Set<string>([
    booking.clientEmail.toLowerCase(),
    settings.clerk_email.toLowerCase(),
    settings.reception_email.toLowerCase(),
    ...booking.extraGuests.map((e) => e.toLowerCase()),
    ...booking.extraCohosts.map((e) => e.toLowerCase()),
  ]);
  set.delete("");
  return Array.from(set);
}

export { OFFICE_TIMEZONE };
