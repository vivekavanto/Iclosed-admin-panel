import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { logger } from "@/lib/logger";
import { getLawyerByInitials, getSettings } from "@/lib/signingConfig";
import { isSlotStillAvailable } from "@/lib/signingAvailability";
import { latestSigningDate } from "@/lib/signingCutoff";
import { todayInTimeZone } from "@/lib/signingTimezone";
import { createCalendarEvent, deleteCalendarEvent } from "@/lib/googleCalendar";
import { linkAppointmentToDeal } from "@/lib/linkAppointmentToDeal";
import { generateManageToken, buildManageUrl } from "@/lib/signingAppointmentToken";
import {
  buildEventTitle,
  buildEventDescription,
  buildLocation,
  buildAttendeeList,
  type SigningBookingInput,
} from "@/lib/signingEventContent";

// POST /api/signing/appointments
//
// Public route (outside /api/admin). Creates one signing appointment:
// re-validates the requested slot server-side (never trusts the client's view
// of availability), creates the Google Calendar event on the lawyer's own
// calendar, then inserts the row. No iClosed
// email is sent; Google Calendar's invitation is the only notification.

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
  const sideRaw = String(body.side ?? "").trim().toLowerCase();
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
  if (dealTypeRaw && dealTypeRaw !== "purchase" && dealTypeRaw !== "sale" && dealTypeRaw !== "refinance") {
    return NextResponse.json({ success: false, error: "dealType must be purchase, sale or refinance" }, { status: 400 });
  }

  const startAt = new Date(startAtRaw);
  if (isNaN(startAt.getTime())) {
    return NextResponse.json({ success: false, error: "Invalid startAt" }, { status: 400 });
  }

  const lawyer = await getLawyerByInitials(lawyerInitials);
  if (!lawyer) {
    return NextResponse.json({ success: false, error: "Lawyer not found" }, { status: 404 });
  }

  // Closing date too close: the booking cutoff (closing minus N business days) is
  // already behind us, so no signing day could ever satisfy it. Say so, instead of
  // the misleading "no longer available".
  const minDays = (await getSettings()).min_business_days_before_closing;
  const cutoff = await latestSigningDate(closingDate, minDays);
  if (cutoff !== null && cutoff < todayInTimeZone()) {
    return NextResponse.json(
      {
        success: false,
        error: `Your closing date is too close. Signings must be booked at least ${minDays} business days before closing, so please choose a closing date at least ${minDays} business days from today.`,
      },
      { status: 409 },
    );
  }

  // The close-the-race re-check: recompute availability right now and refuse
  // anything the client's page is stale about.
  const stillAvailable = await isSlotStillAvailable(lawyer, startAt.toISOString(), closingDate);
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
    dealType: (dealTypeRaw as "purchase" | "sale" | "refinance") || null,
    appointmentType: appointmentTypeRaw as "virtual" | "in_person",
    fileNumber,
    extraGuests,
    extraCohosts: [],
  };

  const summary = buildEventTitle(lawyer, booking);
  const description = buildEventDescription(booking, settings);
  const location = buildLocation(booking, settings);
  const allAttendees = buildAttendeeList(booking, settings);
  // Everyone, including clerk and reception, is on the create call so Google
  // emails each of them the invite.
  const attendees = allAttendees;

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
      side: sideRaw === "purchase" || sideRaw === "sale" ? sideRaw : null,
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
    // 23505 = unique_violation on signing_appointments_lawyer_slot_unique
    // (migrations/2026-10-05-signing-appointments-unique-slot.sql): another
    // request won the race for this exact lawyer/slot between our
    // isSlotStillAvailable re-check and this insert. The calendar event we
    // just created is now an orphaned duplicate — remove it rather than
    // leaving two events on the lawyer's calendar for one booked slot.
    if (insertError.code === "23505") {
      await deleteCalendarEvent(lawyer.email, lawyer.calendar_id, eventId).catch((err) =>
        logger.error("[SigningAppointments POST] cleanup of duplicate calendar event failed:", err, {
          eventId,
          lawyerId: lawyer.id,
        }),
      );
      return NextResponse.json(
        { success: false, error: "That time was just booked by someone else. Please pick another slot." },
        { status: 409 },
      );
    }

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

  // Best effort: a booking with a valid file number + matching email is linked to
  // its deal so the All Files Signing column can show it.
  await linkAppointmentToDeal(saved.id, fileNumber, clientEmail).catch((err) =>
    logger.error("[SigningAppointments POST] deal link failed:", err),
  );

  const manageUrl = buildManageUrl(manageToken);

  // No iClosed email goes to the booker, guests or lawyer: Google Calendar's
  // own invitation (sendUpdates 'all' on create) is the only notification.
  // sendSigningConfirmationEmail is intentionally not called here.

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
