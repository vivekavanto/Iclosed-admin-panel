// Google Calendar access for the signing-appointment booking system.
//
// Auth model: ONE Google Workspace service account, authorized for
// domain-wide delegation on navawilson.law, impersonates each lawyer's own
// calendar via JWT `subject`. There is no per-lawyer OAuth consent — a
// Workspace super-admin grants the delegation once, in the Google Admin
// console, for scope https://www.googleapis.com/auth/calendar. That grant is
// outside this codebase and is a prerequisite for anything here to work.
//
// Every call here is scoped to exactly one lawyer's calendar (impersonation
// subject = signing_lawyers.email). Reception's calendar is never queried —
// its own busy/free state must not affect a lawyer's availability
// (requirement #6).
//
// sendUpdates is 'all' on CREATE only, so Google's native invite email goes to
// the client and guests alongside our own branded templates
// (sendSigningConfirmationEmail.ts etc.). Clerk and reception are added in a
// second, silent step (sendUpdates 'none'), so they are on the event without a
// Google email. The lawyer owns the event, so Google never emails them; they
// rely on our lawyer notification. Update and cancel stay 'none': only our own
// emails announce those.

import { google, calendar_v3 } from "googleapis";
import { logger } from "./logger";

const SCOPES = ["https://www.googleapis.com/auth/calendar"];

function privateKey(): string {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ?? "";
  // Env vars can't hold real newlines cleanly, so the PEM is stored with
  // literal `\n` escapes, matching this repo's convention for multiline
  // secrets — unescape them back into real newlines here.
  return raw.replace(/\\n/g, "\n");
}

/** An authorized Calendar client impersonating one lawyer's own calendar. */
export function getCalendarClientForLawyer(lawyerEmail: string): calendar_v3.Calendar {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = privateKey();
  if (!clientEmail || !key) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY are not configured.",
    );
  }

  const auth = new google.auth.JWT({
    email: clientEmail,
    key,
    scopes: SCOPES,
    subject: lawyerEmail,
  });

  return google.calendar({ version: "v3", auth });
}

export interface BusyInterval {
  start: string; // ISO
  end: string; // ISO
}

/** Busy intervals on a lawyer's own calendar within [timeMin, timeMax]. */
export async function getFreeBusy(
  lawyerEmail: string,
  calendarId: string,
  timeMin: Date,
  timeMax: Date,
): Promise<BusyInterval[]> {
  const calendar = getCalendarClientForLawyer(lawyerEmail);
  const { data } = await calendar.freebusy.query({
    requestBody: {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      items: [{ id: calendarId }],
    },
  });
  const busy = data.calendars?.[calendarId]?.busy ?? [];
  return busy
    .filter((b) => b.start && b.end)
    .map((b) => ({ start: b.start as string, end: b.end as string }));
}

export interface CreateEventInput {
  lawyerEmail: string;
  calendarId: string;
  summary: string;
  description: string;
  start: Date;
  end: Date;
  location?: string;
  /** Email addresses to add as attendees (lawyer is implicit as the calendar owner). */
  attendees: string[];
  /**
   * Internal attendees (clerk, reception) added AFTER create with
   * sendUpdates 'none', so they are on the event but Google never emails them.
   */
  silentAttendees?: string[];
  /** When true, request a Google Meet link via conferenceData. */
  needsMeet: boolean;
}

export interface CalendarEventResult {
  eventId: string;
  meetLink: string | null;
  htmlLink: string | null;
}

export async function createCalendarEvent(
  input: CreateEventInput,
): Promise<CalendarEventResult> {
  const calendar = getCalendarClientForLawyer(input.lawyerEmail);

  const { data } = await calendar.events.insert({
    calendarId: input.calendarId,
    sendUpdates: "all",
    conferenceDataVersion: input.needsMeet ? 1 : 0,
    requestBody: {
      summary: input.summary,
      description: input.description,
      location: input.location,
      start: { dateTime: input.start.toISOString() },
      end: { dateTime: input.end.toISOString() },
      attendees: input.attendees.map((email) => ({ email })),
      conferenceData: input.needsMeet
        ? {
            createRequest: {
              requestId: `signing-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          }
        : undefined,
    },
  });

  const meetLink =
    data.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ?? null;

  if (!data.id) {
    throw new Error("Google Calendar did not return an event id.");
  }

  const silent = (input.silentAttendees ?? []).filter((e) => e && !input.attendees.includes(e));
  if (silent.length > 0) {
    // Best-effort: the event and its invites already exist, so a failure here
    // only means clerk/reception are missing from it; it must not fail the booking.
    try {
      await calendar.events.patch({
        calendarId: input.calendarId,
        eventId: data.id,
        sendUpdates: "none",
        requestBody: {
          attendees: [...input.attendees, ...silent].map((email) => ({ email })),
        },
      });
    } catch (err) {
      logger.error("[googleCalendar] adding silent attendees failed:", err, { eventId: data.id });
    }
  }

  return { eventId: data.id, meetLink, htmlLink: data.htmlLink ?? null };
}

export interface UpdateEventInput {
  lawyerEmail: string;
  calendarId: string;
  eventId: string;
  summary?: string;
  description?: string;
  start?: Date;
  end?: Date;
  location?: string;
  attendees?: string[];
}

export async function updateCalendarEvent(input: UpdateEventInput): Promise<void> {
  const calendar = getCalendarClientForLawyer(input.lawyerEmail);
  await calendar.events.patch({
    calendarId: input.calendarId,
    eventId: input.eventId,
    sendUpdates: "none",
    requestBody: {
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.start ? { start: { dateTime: input.start.toISOString() } } : {}),
      ...(input.end ? { end: { dateTime: input.end.toISOString() } } : {}),
      ...(input.attendees ? { attendees: input.attendees.map((email) => ({ email })) } : {}),
    },
  });
}

export async function deleteCalendarEvent(
  lawyerEmail: string,
  calendarId: string,
  eventId: string,
): Promise<void> {
  const calendar = getCalendarClientForLawyer(lawyerEmail);
  try {
    await calendar.events.delete({
      calendarId,
      eventId,
      sendUpdates: "none",
    });
  } catch (err: unknown) {
    // Already gone (e.g. a lawyer deleted it by hand) — cancellation should
    // still succeed on our side rather than getting stuck on a 404/410.
    const status = (err as { code?: number; response?: { status?: number } })?.code
      ?? (err as { response?: { status?: number } })?.response?.status;
    if (status === 404 || status === 410) {
      logger.warn("[googleCalendar] delete: event already gone", { eventId });
      return;
    }
    throw err;
  }
}
