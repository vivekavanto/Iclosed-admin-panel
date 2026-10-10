import { NextResponse } from "next/server";
import { getLawyerByInitials, getSettings } from "@/lib/signingConfig";
import { getAvailableSlots } from "@/lib/signingAvailability";
import { latestSigningDate, normalizeClosingDate } from "@/lib/signingCutoff";
import { todayInTimeZone, OFFICE_TIMEZONE } from "@/lib/signingTimezone";

// GET /api/signing/lawyers/[initials]/availability?date=YYYY-MM-DD
//
// Public route (outside /api/admin — see src/middleware.ts). Returns bookable
// start times for one lawyer on one office-local calendar date. Never trusts
// a client-supplied slot elsewhere — this is the read side; the create route
// recomputes the same thing immediately before inserting.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ initials: string }> },
) {
  const { initials } = await params;
  const lawyer = await getLawyerByInitials(initials);
  if (!lawyer) {
    return NextResponse.json({ success: false, error: "Lawyer not found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const date = url.searchParams.get("date") || todayInTimeZone(OFFICE_TIMEZONE);
  if (!DATE_RE.test(date)) {
    return NextResponse.json({ success: false, error: "date must be YYYY-MM-DD" }, { status: 400 });
  }

  // Optional: the file's closing date. Slots after (closing - N business days)
  // come back empty; latestBookableDate lets the portal grey those days out.
  const closingDate = normalizeClosingDate(url.searchParams.get("closingDate"));

  const [result, settings] = await Promise.all([
    getAvailableSlots(lawyer, date, closingDate),
    getSettings(),
  ]);
  const minBusinessDays = settings.min_business_days_before_closing;

  return NextResponse.json({
    success: true,
    data: {
      lawyer: { initials: lawyer.initials, fullName: lawyer.full_name },
      date,
      durationMinutes: result.durationMinutes,
      bufferMinutes: result.bufferMinutes,
      slotIncrementMinutes: result.slotIncrementMinutes,
      officeAddress: settings.office_address,
      disclaimer: settings.disclaimer_text,
      minBusinessDaysBeforeClosing: minBusinessDays,
      latestBookableDate: await latestSigningDate(closingDate, minBusinessDays),
      slots: result.slots,
    },
  });
}
