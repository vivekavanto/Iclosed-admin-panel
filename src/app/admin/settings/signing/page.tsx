import Link from "next/link";
import { CalendarClock, Clock, Users } from "lucide-react";

export default function SigningSettingsOverviewPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Signing appointments</h1>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Link
          href="/admin/settings/signing/lawyers"
          className="card bg-base-200 p-4 hover:bg-base-300 flex flex-col gap-1"
        >
          <Users className="w-5 h-5 text-base-content/60" />
          <span className="font-medium">Lawyers &amp; hours</span>
          <span className="text-sm text-base-content/60">Who is bookable, and when.</span>
        </Link>
        <Link
          href="/admin/settings/signing/general"
          className="card bg-base-200 p-4 hover:bg-base-300 flex flex-col gap-1"
        >
          <Clock className="w-5 h-5 text-base-content/60" />
          <span className="font-medium">General settings</span>
          <span className="text-sm text-base-content/60">Duration, buffer, office address, disclaimer.</span>
        </Link>
        <Link
          href="/admin/settings/signing/appointments"
          className="card bg-base-200 p-4 hover:bg-base-300 flex flex-col gap-1"
        >
          <CalendarClock className="w-5 h-5 text-base-content/60" />
          <span className="font-medium">Appointments</span>
          <span className="text-sm text-base-content/60">All bookings, with cancel. Reschedule ships in a later phase.</span>
        </Link>
      </div>
    </div>
  );
}
