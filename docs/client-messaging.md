# Client messaging (live chat with clients)

Staff <-> client chat per file, built in-house (no Crisp). Tables `deal_conversations`
+ `deal_messages` (migration `2026-10-20-deal-messages.sql`). A conversation is keyed by
the file's ROOT lead, so co-clients and all staff share one thread. Private notes and
internal events have `visible_to_client = false` and are never read by the portal.

## Where it lives
- **Admin:** sidebar "Messages" (unread badge) -> `/admin/messages` inbox: conversation
  list (Open / Mine / Unassigned / Resolved, search), thread with Reply / Private note,
  saved replies (`/`), assign, resolve/reopen, client details. The deal page has an
  "Open chat" button; the bell links a client message straight to its conversation.
- **Portal:** chat widget (launcher bottom-right on every dashboard page): Home -> Chat
  -> End conversation -> rating. Email links open it via `/dashboard?chat=1`.

## Flow
- **Staff -> client:** reply is saved, then emailed (template "Client Message", editable
  in Email Templates). Reply-To is a signed per-file address when inbound email is configured.
- **Client -> staff, by email:** `POST /api/webhooks/inbound-email?secret=...` stores it
  (quoted history stripped; sender must be a client on that file) and rings the bell.
- **Client -> staff, in portal:** `POST /api/messages` (portal) writes the same table, then
  a signed ping to `/api/webhooks/client-message` raises the bell. Writing reopens a
  resolved conversation.

## Setup (ops)
1. Run the migration in the Supabase SQL editor **before** deploying either repo.
2. Admin env: `INBOUND_EMAIL_DOMAIN` (e.g. `reply.iclosed.ca`),
   `INBOUND_EMAIL_WEBHOOK_SECRET`, optional `MESSAGE_REPLY_SECRET`
   (falls back to `SERVICE_WEBHOOK_SECRET`).
3. Point the inbound-mail provider (Resend inbound on `INBOUND_EMAIL_DOMAIN`, MX
   records) at `https://<admin>/api/webhooks/inbound-email?secret=<INBOUND_EMAIL_WEBHOOK_SECRET>`.
4. Without 2-3 everything still works: emails carry the normal reply-to and tell the
   client to use the portal; only reply-by-email is off.

## File-based chat and handovers
The chat belongs to the FILE (one thread per file, keyed by the root lead);
staff only HANDLE it for a while ("Handled by" in the inbox). Whoever takes
over sees the full history; each change writes an internal "Handed over from …
to …" line, and the side panel lists everyone who has handled the file.
"Hand over files" in the inbox moves all of one person's file chats to another
(audited as `chat.handover_all`). Run `migrations/2026-10-22-chat-file-handlers.sql`
for the handler history; without it handovers still work and the list is empty.

## Live updates, Online / Away, typing (always on)
Details and the design: `docs/chat-realtime-implementation-plan.md`, section 0.
There is no switch: messages, "Seen", typing and Online / Away are instant
whenever the chat itself is enabled (`NEXT_PUBLIC_CHAT_ENABLED=true`).
1. Run `migrations/2026-10-22-chat-presence.sql` (staff Online / Away, client
   online dot) and `migrations/2026-10-22-chat-file-handlers.sql` (handler
   history). Safe before or after the deploy; the chat works without them.
2. Realtime uses the secret the two apps already share, `SERVICE_WEBHOOK_SECRET`
   (a dedicated `CHAT_REALTIME_SECRET` overrides it if ever wanted). It must be the
   SAME in admin and portal and DIFFERENT for dev and production, because they
   share one Supabase project and the secret is what separates their channels.
3. Supabase -> Realtime settings: public channels must be allowed (the default);
   the channels are HMAC-named and carry no message text.
4. Without a usable secret the chat still works, by polling, as before.
