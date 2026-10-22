// File-based chat: the thread belongs to the FILE and staff only handle it for a
// while. These pin the internal "handover" lines the thread shows when the
// handler changes (src/lib/chatHandlers.ts), because they are the record a new
// handler reads to understand who dealt with the file before them.
//
// chatHandlers imports supabaseAdmin, which builds its client at import time,
// hence the env assignments and the dynamic import.

import assert from "node:assert/strict";
import test from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";

const { handoverEventText } = await import("../src/lib/chatHandlers.ts");

const saru = { email: "saru@navawilson.law", name: "Saru" };
const priya = { email: "priya@iclosed.ca", name: "Priya" };
const owner = { email: "owner@iclosed.ca", name: "Owner" };

test("taking an unhandled file", () => {
  assert.equal(handoverEventText(null, saru, { by: saru }), "Saru is now handling this file");
  assert.equal(handoverEventText(null, saru, { by: priya }), "Saru is now handling this file (set by Priya)");
  assert.equal(handoverEventText(null, saru, { how: "first-reply" }), "Saru is now handling this file");
  assert.equal(handoverEventText(null, saru, { how: "online" }), "Saru is now handling this file (online)");
});

test("handing a file over from one person to another", () => {
  // The new handler takes it themselves, or the old one passes it on.
  assert.equal(handoverEventText(saru, priya, { by: priya }), "Handed over from Saru to Priya");
  assert.equal(handoverEventText(saru, priya, { by: saru }), "Handed over from Saru to Priya");
  // A third person (a manager) moves it.
  assert.equal(handoverEventText(saru, priya, { by: owner }), "Handed over from Saru to Priya by Owner");
  // Everything of someone who left, in one go.
  assert.equal(
    handoverEventText(saru, priya, { by: owner, how: "bulk" }),
    "Handed over from Saru to Priya (all of Saru's files, moved by Owner)",
  );
});

test("nobody handles it any more", () => {
  assert.equal(handoverEventText(saru, null, { by: saru }), "Saru stopped handling this file");
  assert.equal(handoverEventText(saru, null, { by: owner }), "Saru stopped handling this file (by Owner)");
});

test("no line when nothing changed (same person, any email casing)", () => {
  assert.equal(handoverEventText(saru, { ...saru, email: "SARU@navawilson.law" }, { by: owner }), null);
  assert.equal(handoverEventText(null, null), null);
});
