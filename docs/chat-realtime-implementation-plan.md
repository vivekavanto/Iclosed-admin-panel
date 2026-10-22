# Live chat: gap analysis and phased implementation plan

Status: **phases 1–4 implemented (2026-10-22), behind flags; see section 0.**
Phases 5–8 (attachments, inbox polish, widget extras, load testing) are still open.

## 0. What was built (2026-10-22)

Everything below is additive and rides on the existing chat flag
(`NEXT_PUBLIC_CHAT_ENABLED`). If a deploy has no usable shared secret, or the
presence migrations have not run, the chat degrades to the old polling and the
old header wording rather than breaking.

**Always on, no switch.** Realtime runs whenever the chat is enabled
(`NEXT_PUBLIC_CHAT_ENABLED`) and needs no new variable: channel names come from
the secret both apps already share, `SERVICE_WEBHOOK_SECRET` (`CHAT_REALTIME_SECRET`
overrides it if ever set). It must be the same in admin and portal and different
per environment. With no usable secret the chat falls back to the old polling.

| Needs | Where | Effect |
| --- | --- | --- |
| migration `2026-10-22-chat-presence.sql` | shared DB | `staff_presence` table, `deal_conversations.client_online / client_last_seen_at`. Every reader tolerates it missing |
| migration `2026-10-22-chat-file-handlers.sql` | shared DB | handler history for the file chat. Every reader tolerates it missing |

Isolation between dev / preview / prod (one Supabase project) comes from the
**per-environment secret**: a different secret yields different channel names.
`CHAT_REALTIME_ENV` is an optional extra prefix.

Design as built (differs from section 3 in two places, both simplifications):

- **Server-only broadcasts, including typing.** Browsers never send on a
  channel; they only listen. Typing goes through a throttled route
  (`POST /api/admin/messages/[leadId]/typing`, `POST /api/messages/typing`), so
  the same auth that guards messages guards typing, and staff only need the one
  `inbox:` channel (every inbox event carries `{ root }`).
- **Client presence piggybacks on the widget's existing GET** (`seen=1` while
  the tab is visible) plus a `sendBeacon` on hide; no extra heartbeat request.

Channels: `inbox:<h>` (staff: `changed`, `typing`, `presence`, `staff`),
`chat:<h(root)>` (clients on the file: `message`, `read`, `typing`),
`client:<h(clientId)>` (launcher badge: `message`), `avail:<h>` (all clients:
`availability {online}`).

Staff presence: heartbeat every 30 s from any admin tab (Messages module only),
offline after 120 s without one or when the last tab closes (beacon), auto-Away
after 15 min without input in any admin tab; a manual Away sticks until the
staff member picks Online. The portal sees only a boolean ("someone is online").

Not done from phases 1–4: the header bell still polls (only the sidebar badge and
the inbox are instant); per-client presence is per **file** (two co-clients share
one dot).
Source of truth for the design: the "Live Chat Prototype" artifact
(<https://claude.ai/artifact/B3h2Sj1CGFtMqC6P9kgWSf>), two boards: **Agent inbox**
(`Main.dc.html`) and **Website chat widget** (`Widget.dc.html`).
Compared against the chat that exists today on the `dev` branch of both repos
(admin: `4f8d9b9`, `e0581be`; portal: `0f6c977`, `952dca8`, plus the old-design
rewrite of `components/chat/ChatWidget.tsx`).

Two requirements were called out explicitly and drive the plan:

1. **Online / Away availability is not implemented.**
2. **Messages must appear instantly, in both directions, without a refresh.**
   Today everything is timer polling, so a reply can take up to 30 s to show.

---

## 1. What exists today (verified in code)

| Area | Admin app | Portal |
| --- | --- | --- |
| Storage | `deal_conversations`, `deal_messages` (shared DB, RLS on, service_role only) | same tables, read through `/api/messages` |
| Inbox / thread | `MessagesInbox.tsx`: Open / Mine / Unassigned / Resolved, search, thread, private note, saved replies (`/`), assign, resolve / reopen, client + file panel | n/a |
| Widget | n/a | `components/chat/ChatWidget.tsx` (old design): thread, Delivered / Seen, unread badge, file switcher, transcript, end + rate, teaser, `?chat=1` deep link |
| Email | staff reply emailed ("Client Message" template); inbound-email webhook turns an email reply into a chat message | transcript email |
| Notifications | bell event, sidebar unread badge | unread badge on the launcher |
| **Update mechanism** | `LIST_POLL` 10 s, `THREAD_POLL` 6 s, sidebar badge 20 s | 7 s while open, 30 s while closed, 3 s until first load |
| Presence / availability | **none** | **none** (header text is static) |

## 2. Gap analysis against the artifact

Legend: DONE = matches the artifact, PARTIAL = exists but differs, MISSING = not built,
N/A = does not fit this product (see section 7).

### 2.1 Agent inbox board

| Artifact feature | State | Notes |
| --- | --- | --- |
| Filters with counts (Open / Unassigned / Mine / Resolved) | DONE | |
| Search names and message text | DONE | |
| Unread count per row, total unread on the Inbox rail icon | DONE | but only refreshes by polling |
| Conversation row shows channel icon (Chat / Email / WhatsApp) | PARTIAL | text label only, no WhatsApp channel (see `docs/WhatsApp-Integration-Plan.md`) |
| Online dot on the row avatar | **MISSING** | needs client presence |
| Row preview shows "typing…" | **MISSING** | needs typing events |
| Thread header: "Online" / "Last seen X" for the client | **MISSING** | needs client presence |
| **Agent availability menu (Online / Away) on the rail avatar** | **MISSING** | requirement 1 |
| "While you're away, new chats go to teammates who are online" | **MISSING** | routing rule |
| Assign menu with team members | DONE | |
| Resolve / Reopen | DONE | |
| "More actions" menu in the header | MISSING | low priority |
| Event pills (assigned, resolved, reopened) | DONE | |
| Private note (amber composer) | DONE | |
| Saved replies via `/` with `{name}` substitution | DONE | verify `{name}` is substituted |
| Auto-assign on first reply, auto-reopen on reply | DONE | |
| Client typing indicator, with live text preview | **MISSING** | live preview deliberately dropped, see 7 |
| Operator message state "Sent" -> "Seen" | PARTIAL | shows Delivered; confirm it flips to Seen when the client reads |
| Attach a file (composer) | **MISSING** | both sides |
| **New message appears instantly** | **MISSING** | polling only, requirement 2 |
| Right panel: details, previous conversations | PARTIAL | file panel and other files exist; no past conversations list |
| Right panel: segments / tags | MISSING | optional, see 7 |
| Responsive layout (stacked below 820 px, side panel hidden below 1180 px) | UNVERIFIED | test in phase 6 |

### 2.2 Website chat widget board

| Artifact feature | State | Notes |
| --- | --- | --- |
| Launcher, teaser, unread badge | DONE | old design retained on purpose |
| Header shows agent, "Online · replies in under 5 min" | **MISSING** | needs availability, text is static today |
| Green presence dot on the agent avatar | **MISSING** | |
| Agent typing dots | **MISSING** | |
| **Staff reply appears instantly** | **MISSING** | up to 7 s open / 30 s closed |
| Delivered / Seen under the last message | DONE | |
| Email transcript, end conversation, rating, thank-you screen | DONE | thank-you screen bug fixed (reply now returns to thread) |
| Attach a file | **MISSING** | |
| Home screen with help-center search and articles | N/A / deferred | old compact design has no home screen; optional phase 7 |
| "Get replies by email" capture | N/A | clients are logged in, email is known |
| "New conversation" resets the thread | PARTIAL | thread is per file and persistent; decide whether to archive (phase 6) |

### 2.3 Things not in the artifact but needed in production

Reconnect handling, tab-hidden behaviour, dev/prod channel isolation (the two
environments share one Supabase project), rate limits on typing / presence
events, audit of who can subscribe to what, and test coverage. These are in the
phases below.

---

## 3. Architecture decision (read before the phases)

**Constraint:** both apps run on Vercel serverless, which cannot hold WebSocket
or long-lived SSE connections. So realtime has to come from a managed service.
Supabase Realtime is already in the stack (same project, `wss://*.supabase.co`
is already allowed in the portal CSP) and needs no new vendor.

**Pattern: server-authoritative "ping + refetch".**

1. Every write still goes through the existing API routes, which keep doing the
   authorization (staff module check on admin, client-owns-file on portal).
2. After a write, the server broadcasts a **small ping** on a Realtime Broadcast
   channel (no message text in the payload).
3. Subscribed browsers receive the ping and immediately refetch through the same
   authorized API they already use. Polling stays as a slow safety net.

Why not `postgres_changes` straight to the browser: `deal_messages` has RLS on
with no policies on purpose (only service_role reads it). Opening it to client
subscriptions would mean writing and maintaining RLS that mirrors the family /
root-lead model. Ping + refetch keeps one source of truth for access control.

**Channels** (namespaced per environment, because dev, preview and prod all use
the same Supabase project, so an un-namespaced channel would leak pings between
environments):

| Channel | Who joins | Carries |
| --- | --- | --- |
| `chat:<env>:<hmac(rootLeadId)>` | the staff member viewing it, and the clients on that file | `message`, `read`, `status`, `assign`, `typing` |
| `inbox:<env>` | staff with the Messages module | `list-changed`, `unread` (updates the list, sidebar badge, bell) |
| `client:<env>:<hmac(clientId)>` | the logged-in client, on every dashboard page | `unread` (launcher badge when the widget is closed) |
| `presence:<env>:staff` | signed-in staff | Presence state (online / away) |

`<hmac(...)>` = HMAC-SHA256 of the id with a new `CHAT_REALTIME_SECRET`, so a
channel name cannot be guessed from a lead id. Because payloads carry no
content, a leaked channel name reveals only that "something happened".
Hardening option for later: Supabase Realtime Authorization (private channels
with policies on `realtime.messages`).

**Fallback:** if the socket drops, the client falls back to the current polling
rates and refetches on reconnect and on tab focus. Nothing breaks without
Realtime; it only gets slower.

**Feature flag:** keep `NEXT_PUBLIC_CHAT_ENABLED`; add `NEXT_PUBLIC_CHAT_REALTIME`
so realtime can be switched off without hiding the chat.

---

## 4. Phased implementation plan

Effort figures are for one developer including tests, in working days. Phases are
ordered so each one is shippable and testable on its own.

### Phase 0: Prerequisites and decisions (0.5 day)

- Confirm the Supabase plan's Realtime limits (concurrent connections, messages
  per second) against expected concurrent clients plus staff.
- Confirm Realtime is enabled for the project; no table needs to be added to a
  publication (we only use Broadcast and Presence).
- Add `CHAT_REALTIME_SECRET` (random 32 bytes) to Vercel env for admin and portal;
  **same value in both repos**, and a different value per environment.
- Confirm the **admin** CSP `connect-src` allows `wss://*.supabase.co` (the portal
  already does). Fix in `next.config.ts` if not.
- Decide the "typically reply in" wording (suggest: Online -> "usually within a
  few minutes", Away -> "we reply by email, usually within a few hours").
- Decide whether to keep the artifact's "new conversation" behaviour (section 2.2).

Exit: env set, CSP verified, wording agreed.

### Phase 1: Instant messages in both directions (3 days)  <- requirement 2

Server (both repos, mirrored helper `src/lib/chatRealtime.ts`):
- `channelName(kind, id)`: HMAC naming with env prefix.
- `broadcastChat(channel, event, payload?)`: server-side send with the service
  role key (Realtime REST broadcast endpoint, fire-and-forget, never throws into
  the request: a failed ping must not fail the send, same rule as
  `pingAdminOfClientMessage`).
- Call it after every write:
  - portal `POST /api/messages` (client message) -> `chat:` + `inbox:` pings.
  - portal `POST /api/messages/end` (rating, end) -> `chat:` + `inbox:`.
  - admin reply, private note, assign, resolve, reopen (`/api/admin/messages/[leadId]`)
    -> `chat:` + `client:` (staff replies only, never notes) + `inbox:`.
  - admin `inbound-email` webhook -> `chat:` + `inbox:`.
  - admin `client-message` webhook (already receives the portal ping) -> `inbox:`.
- Read receipts: when either side marks messages read, send `read`.

Client:
- Shared hook `useChatChannel(name, handlers)`: subscribe, resubscribe on
  disconnect, refetch on `SUBSCRIBED` after a gap, cleanup on unmount, no-op when
  `NEXT_PUBLIC_CHAT_REALTIME` is off.
- Portal `ChatWidget.tsx`: join `chat:` for the open file and `client:` always;
  on ping call the existing `load()`; also append the sent message optimistically.
  Polling slows to 60 s while the socket is up.
- Admin `MessagesInbox.tsx`: join `inbox:` always and `chat:` for the open
  conversation; ping triggers `loadList()` / `loadDetail()`. Polling slows to 60 s.
- Admin `Sidebar.tsx` unread badge and `NotificationsFeed` bell: subscribe to
  `inbox:` so they update instantly.
- Needs a new browser Supabase client in the admin only if one is not already
  initialised there (`src/lib/supabaseClient.ts` exists); portal already has
  `createBrowserClient` usage.

Acceptance:
- Client sends -> staff thread and list show it within ~1 s with no refresh.
- Staff replies -> open widget shows it within ~1 s; closed widget shows the
  unread badge within ~1 s; the user is back on the thread if they were on the
  thank-you screen.
- Kill the network for 20 s, restore: state catches up without a reload.
- Dev client cannot see pings from a prod conversation and vice versa.

### Phase 2: Online / Away availability and presence (3 days)  <- requirement 1

Data (migration `YYYY-MM-DD-chat-presence.sql`, **plus service_role GRANTs**, see
the `new-tables-need-service-role-grant` note):
- `staff_presence (staff_email pk, status 'online'|'away'|'offline', status_source
  'manual'|'auto', last_seen_at, updated_at)`.
- `deal_conversations.client_last_seen_at timestamptz`.

Staff (admin):
- Rail / sidebar avatar menu with **Online** and **Away** (artifact: "While you're
  away, new chats go to teammates who are online"). Persist the manual choice.
- Heartbeat every 30 s while a tab is visible; mark `offline` after 90 s without
  one; auto-Away after 10 min of no input (configurable), back to Online on
  activity unless the staff member chose Away manually.
- Join the `presence:` channel; the inbox reads it to show teammates' state in
  the assign menu.

Clients (portal):
- Widget header and avatar dot show **Online** if at least one staff member with
  the Messages module is online, else **Away**. The portal never subscribes to
  staff presence or sees staff names: the server aggregates and exposes
  `GET /api/messages/availability` (`{ online: boolean, typical_reply: string }`),
  and pushes an `availability` event on `client:` when it changes.
- Client presence for staff: while a dashboard tab is visible, the widget sends a
  presence heartbeat on `chat:`; the inbox shows the green dot on the row and
  "Online" / "Last seen 5 min ago" in the thread header and side panel. On tab
  close, `navigator.sendBeacon` stamps `client_last_seen_at`.

Routing (optional, flag `CHAT_AUTO_ROUTE`):
- A new client message on an unassigned conversation is assigned to an online
  staff member with the Messages module (round-robin); if nobody is online it
  stays Unassigned and the client sees the Away wording and the email promise.

Acceptance:
- Toggling Away in admin changes the portal header within ~2 s.
- Closing the last admin tab flips staff to offline within ~90 s.
- A client with the portal open shows a green dot in the inbox; closing it shows
  "Last seen" within a minute.

### Phase 3: Typing indicators (1.5 days)

- Broadcast ephemeral `typing` events on `chat:` (payload: role only, no text),
  throttled to one per 3 s while typing, expiring client-side after 5 s.
- Portal widget shows the artifact's three animated dots when staff are typing.
- Admin thread shows "<First name> is typing…" and the list row preview shows
  "typing…".
- Not building the artifact's **live text preview** (see 7).

Acceptance: typing on one side shows the dots on the other within ~1 s and clears
5 s after the last keystroke or on send.

### Phase 4: Read receipts and unread polish (1 day)

- Make "Delivered" -> "Seen" flip instantly on both sides using the `read` ping.
- Unread count in the browser tab title / favicon dot when the tab is hidden.
- Optional sound / desktop notification for staff on a new client message
  (opt-in, per user).

### Phase 5: Attachments (3 days)

- Composer paperclip on both sides; image and PDF first.
- Upload to Vercel Blob using `validateUpload` (size and type), private store
  rules from `private-blob-store-rollout`; 10 MB cap.
- Migration: `deal_messages.attachments jsonb` (name, url, size, mime), with the
  service_role grant check.
- Render as chips / image thumbnails; downloads go through an auth-gated proxy
  (`docDownloadHref()` pattern); the staff email lists attachment links.
- Orphan cleanup if the send fails; consider malware scanning before release.

### Phase 6: Inbox polish from the artifact (2 days)

- Channel icons on rows (Chat / Email, WhatsApp when that channel exists).
- Previous conversations in the side panel (past resolved threads and other files).
- "More actions" menu (copy link, mark unread, export transcript).
- Optional tags / segments.
- Responsive checks at the artifact's breakpoints (820 px and 1180 px).
- Decide archive-per-conversation vs one persistent thread per file.
- Verify `{name}` substitution in saved replies.

### Phase 7: Optional widget extras (1.5 days)

- Help-center style search that deep-links to the portal FAQ (the artifact's
  article list), only if the client wants a home screen.
- Business-hours messaging when Away.

### Phase 8: Hardening, tests, rollout (2 days)

- Tests: channel-name HMAC and env isolation, ping not leaking content, presence
  timeout maths, typing throttle, reconnect catch-up, flag-off fallback to polling.
- Load check against the Supabase Realtime limits from phase 0.
- Observability via `logger`; metric for ping failures.
- Docs: update `docs/client-messaging.md` and this file; add the migration to the
  deploy checklist.

Total estimate: about **17 to 18 working days**; phases 1 and 2 (the two
requirements) are about 6.5 days.

---

## 5. Rollout order and risks

Order: run migration (phase 2 and 5 ones) in the shared DB first, then deploy
admin, then deploy portal. The old email-only widget stays behind the flag state
described in `docs/client-messaging.md`, so testers are unaffected until
`NEXT_PUBLIC_CHAT_ENABLED` is turned on.

| Risk | Mitigation |
| --- | --- |
| Dev, preview and prod share one Supabase project | env-prefixed channel names and per-env secrets |
| Realtime quota exhausted | phase 0 check, ping-only payloads, throttled typing / presence |
| Missed ping (socket drop) | refetch on reconnect and focus, 60 s safety polling |
| Presence shows stale "Online" | heartbeat plus server-side 90 s expiry |
| New tables without GRANT | include service_role GRANTs in every migration (known failure mode here) |
| Channel name guessed | HMAC naming, no content in payloads, later move to private channels |
| Two diverging `main` refs | check `origin/main` and `vivekavanto/main` before and after merging this work |

## 6. Files expected to change

Admin: `src/lib/chatRealtime.ts` (new), `src/hooks/useChatChannel.ts` (new),
`src/components/MessagesInbox.tsx`, `src/components/Sidebar.tsx`,
`src/components/NotificationsFeed.tsx`, `src/app/api/admin/messages/**`,
`src/app/api/webhooks/{client-message,inbound-email}/route.ts`,
`src/lib/dealMessages.ts`, `src/app/api/admin/presence/route.ts` (new),
`next.config.ts` (CSP if needed), migrations (presence, attachments),
`docs/client-messaging.md`.

Portal: `src/lib/chatRealtime.ts` (mirrored), `src/hooks/useChatChannel.ts`,
`src/components/chat/ChatWidget.tsx`, `src/app/api/messages/**`,
`src/app/api/messages/availability/route.ts` (new), `src/lib/dealMessages.ts`.

## 7. Deliberately not copied from the artifact

- **Anonymous website visitors, "Visitor 4821", email capture, geo / browser /
  page tracking:** the artifact is a generic support-chat template. Here every
  chat is a logged-in client on a known file.
- **Live text preview of what the client is typing:** privacy-sensitive for a law
  firm and not needed; typing dots only.
- **Rail items Contacts, Campaigns, Help center, Analytics:** not part of this
  app's chat scope.
- **Segments / tags:** optional, phase 6 only if staff ask for it.
- **WhatsApp channel:** covered by its own plan, `docs/WhatsApp-Integration-Plan.md`.

## 8. Open questions for the product owner

1. Reply-time wording for Online and Away, and whether to show business hours.
2. Should a new client message auto-route to an online teammate, or stay in the
   shared Unassigned queue?
3. Is auto-Away after inactivity wanted, and after how many minutes?
4. Are attachments needed in the first release?
5. One persistent thread per file, or archive each ended conversation?
6. Desktop / sound notifications for staff: opt-in only?
