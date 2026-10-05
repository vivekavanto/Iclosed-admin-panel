import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { logger } from "@/lib/logger";
import { getLawyerByInitials, getSettings } from "@/lib/signingConfig";
import { isSlotStillAvailable } from "@/lib/signingAvailability";
import { createCalendarEvent } from "@/lib/googleCalendar";
import { generateManageToken, buildManageUrl } from "@/lib/signingAppointmentToken";
import {
  buildEventTitle,
  buildEventDescription,
  buildLocation,
  buildAttendeeList,
  type SigningBookingInput,
} from "@/lib/signingEventContent";
import { sendSigningConfirmationEmail } from "@/lib/sendSigningConfirmationEmail";

// POST /api/signing/appointments
//
// Public route (outside /api/admin). Creates one signing appointment:
// re-validates the requested slot server-side (never trusts the client's view
// of availability), creates the Google Calendar event on the lawyer's own
// calendar, then inserts the row. Sends the client confirmation email
// (sendSigningConfirmationEmail.ts) as a best-effort last step — a failed
// send does not fail the booking, since the calendar event and DB row are
// already committed by that point.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseGuestList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v) => String(v).trim().toLowerCase())
    .filter((v) => v && EMAIL_RE.test(v))
    .slice(0, 10); // a sane cap on an unauthenticated public form
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const lawyerInitials = String(body.lawyerInitials ?? "").trim();
  const startAtRaw = String(body.startAt ?? "").trim();
  const clientName = String(body.clientName ?? "").trim();
  const clientEmail = String(body.clientEmail ?? "").trim().toLowerCase();
  const clientPhone = body.clientPhone ? String(body.clientPhone).trim() : null;
  const propertyAddress = body.propertyAddress ? String(body.propertyAddress).trim() : null;
  const closingDate = body.closingDate ? String(body.closingDate).trim() : null;
  const dealTypeRaw = String(body.dealType ?? "").trim().toLowerCase();
  const appointmentTypeRaw = String(body.appointmentType ?? "").trim().toLowerCase();
  const fileNumber = body.fileNumber ? String(body.fileNumber).trim() : null;
  const extraGuests = parseGuestList(body.extraGuests);

  if (!lawyerInitials || !startAtRaw || !clientName || !clientEmail) {
    return NextResponse.json(
      { success: false, error: "lawyerInitials, startAt, clientName and clientEmail are required" },
      { status: 400 },
    );
  }
  if (!EMAIL_RE.test(clientEmail)) {
    return NextResponse.json({ success: false, error: "Invalid client email" }, { status: 400 });
  }
  if (appointmentTypeRaw !== "virtual" && appointmentTypeRaw !== "in_person") {
    return NextResponse.json({ success: false, error: "appointmentType must be virtual or in_person" }, { status: 400 });
  }
  if (dealTypeRaw && dealTypeRaw !== "purchase" && dealTypeRaw !== "sale") {
    return NextResponse.json({ success: false, error: "dealType must be purchase or sale" }, { status: 400 });
  }

  const startAt = new Date(startAtRaw);
  if (isNaN(startAt.getTime())) {
    return NextResponse.json({ success: false, error: "Invalid startAt" }, { status: 400 });
  }

  const lawyer = await getLawyerByInitials(lawyerInitials);
  if (!lawyer) {
    return NextResponse.json({ success: false, error: "Lawyer not found" }, { status: 404 });
  }

  // The close-the-race re-check: recompute availability right now and refuse
  // anything the client's page is stale about.
  const stillAvailable = await isSlotStillAvailable(lawyer, startAt.toISOString());
  if (!stillAvailable) {
    return NextResponse.json(
      { success: false, error: "That time is no longer available. Please pick another slot." },
      { status: 409 },
    );
  }

  const settings = await getSettings();
  const endAt = new Date(startAt.getTime() + settings.default_duration_minutes * 60_000);

  const booking: SigningBookingInput = {
    clientName,
    clientEmail,
    clientPhone,
    propertyAddress,
    closingDate,
    dealType: (dealTypeRaw as "purchase" | "sale") || null,
    appointmentType: appointmentTypeRaw as "virtual" | "in_person",
    fileNumber,
    extraGuests,
    extraCohosts: [],
  };

  const summary = buildEventTitle(lawyer, booking);
  const description = buildEventDescription(booking, settings);
  const location = buildLocation(booking, settings);
  const attendees = buildAttendeeList(booking, settings);

  let eventId: string;
  let meetLink: string | null = null;
  try {
    const event = await createCalendarEvent({
      lawyerEmail: lawyer.email,
      calendarId: lawyer.calendar_id,
      summary,
      description,
      start: startAt,
      end: endAt,
      location,
      attendees,
      needsMeet: booking.appointmentType === "virtual",
    });
    eventId = event.eventId;
    meetLink = event.meetLink;
  } catch (err) {
    logger.error("[SigningAppointments POST] calendar event create failed:", err);
    return NextResponse.json(
      { success: false, error: "Could not reach the lawyer's calendar. Please try again or contact the office." },
      { status: 502 },
    );
  }

  const manageToken = generateManageToken();

  const { data: saved, error: insertError } = await supabaseAdmin
    .from("signing_appointments")
    .insert({
      lawyer_id: lawyer.id,
      status: "confirmed",
      start_at: startAt.toISOString(),
      end_at: endAt.toISOString(),
      appointment_type: booking.appointmentType,
      deal_type: booking.dealType,
      client_name: clientName,
      client_email: clientEmail,
      client_phone: clientPhone,
      property_address: propertyAddress,
      closing_date: closingDate,
      file_number: fileNumber,
      extra_guests: extraGuests,
      google_event_id: eventId,
      google_meet_link: meetLink,
      manage_token: manageToken,
    })
    .select("*")
    .single();

  if (insertError) {
    // The calendar event already exists at this point; log loudly so staff can
    // reconcile by hand rather than silently losing the booking.
    logger.error(
      "[SigningAppointments POST] row insert failed AFTER calendar event was created:",
      insertError.message,
      { eventId, lawyerId: lawyer.id, startAt: startAt.toISOString() },
    );
    return NextResponse.json(
      { success: false, error: "Could not save the appointment. Please contact the office." },
      { status: 500 },
    );
  }

  const manageUrl = buildManageUrl(manageToken);

  // Best-effort: the booking is already committed (calendar + DB), so a
  // confirmation-email failure is logged inside sendSigningConfirmationEmail
  // and must not turn this into an error response.
  await sendSigningConfirmationEmail({
    lawyer,
    settings,
    booking,
    startAt,
    endAt,
    location,
    meetLink,
    manageUrl,
  });

  return NextResponse.json({
    success: true,
    data: {
      id: saved.id,
      lawyerName: lawyer.full_name,
      startAt: saved.start_at,
      endAt: saved.end_at,
      location,
      meetLink,
      manageUrl,
    },
  });
}
