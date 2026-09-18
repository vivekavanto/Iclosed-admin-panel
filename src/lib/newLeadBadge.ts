"use client";

// Client-side glue for the "new lead" dot on the sidebar's Leads button.
//
// Two components care about the same fact and neither owns the other: the
// Sidebar draws the dot, the Leads list clears it. Rather than lift that state
// into a provider wrapping the whole admin shell, they agree on a window event
// — the signal is one boolean that changes a few times a day.
//
// Without the event the dot would linger for up to a poll interval after the
// admin had already opened the leads page, which is exactly the moment it looks
// broken.

/** Fired after the leads list has marked this admin's new leads seen. */
export const NEW_LEADS_SEEN_EVENT = "iclosed:new-leads-seen";

/**
 * Tell the server this admin has looked at the new leads, then nudge the
 * sidebar to drop its dot immediately.
 *
 * Best-effort: the badge is a convenience, so a failure here must never
 * surface to the user or interrupt the page they came to read.
 */
export async function markNewLeadsSeen(): Promise<void> {
  try {
    const res = await fetch("/api/admin/notifications/new-leads", { method: "PATCH" });
    if (!res.ok) return;
    window.dispatchEvent(new Event(NEW_LEADS_SEEN_EVENT));
  } catch {
    // Offline or a transient blip — the next sidebar poll still shows the
    // truth, so there is nothing useful to say here.
  }
}
