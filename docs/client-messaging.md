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
4. Recommended: copy the Resend webhook's **Signing secret** (`whsec_…`) into admin
   env `RESEND_WEBHOOK_SECRET`. From then on the route accepts ONLY deliveries with a
   valid Resend (Svix) signature made in the last 5 minutes, and `?secret=` alone is
   refused — a leaked URL is useless. Unset = the old `?secret=` check
   (`src/lib/verifyResendWebhook.ts`).
5. Without 2-3 everything still works: emails carry the normal reply-to and tell the
   client to use the portal; only reply-by-email is off.

## Attachments, edit / delete, saved replies
Migration `2026-10-23-chat-attachments-edits-saved-replies.sql`. Safe before or after
the deploy: until it runs, both apps read the old columns and the chat works as
before; only these features say they aren't available yet.
- **Attachments** (both sides): up to 5 files per message, 10 MB each, images / PDF /
  Word / Excel (`src/lib/chatAttachments.ts`, mirrored in the portal). The browser
  uploads straight to Blob under `chat/<root lead>/` (token routes:
  admin `/api/admin/messages/<root>/attachment/token`, portal
  `/api/messages/attachment/token`); the send route re-checks every URL with
  `head()` and refuses anything outside that file's prefix. Files open only through
  `/api/admin/messages/<root>/attachment` and `/api/messages/attachment`, which serve
  a URL only if it is on a live message in a thread the caller can read (the portal
  also requires `visible_to_client`). Private store when `NEXT_PUBLIC_PRIVATE_BLOB`
  is on, like every other document. The client email lists the file names and
  points to the portal; files are never emailed.
- **Edit / delete**: staff change only their own replies and notes; clients only
  their own portal messages (an emailed reply can be deleted, not edited). Delete is
  soft: `deleted_at` is set, the row and text stay for the record, and both apps show
  "This message was deleted" and stop serving its files. The first edit copies the
  text to `original_body` (what the client was emailed); the email is not re-sent.
  Staff edits / deletes are audited (`chat.message_edited` / `chat.message_deleted`).
- **Saved replies** live in `chat_saved_replies`, managed from the inbox (gear icon
  next to "Saved replies"). Seeded with the old built-in list; `{name}` becomes the
  client's first name.

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
