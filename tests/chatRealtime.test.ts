// Live chat realtime: channel naming and presence maths
// (docs/chat-realtime-implementation-plan.md).
//
// Channel names are what keep environments apart (dev, preview and prod share
// one Supabase project) and what stop a lead id being turned into a channel to
// listen on. The presence thresholds decide what clients see in the widget
// header. The portal mirrors both (iclosed_dev_web/src/lib/chatRealtime.ts,
// chatPresence.ts): a change here that is not made there splits the channels.
//
// chatPresence imports supabaseAdmin, which builds its client at import time,
// hence the env assignments and the dynamic import.

import assert from "node:assert/strict";
import test from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";

const { channelName, channelNameWith, realtimeEnabled, broadcast } = await import("../src/lib/chatRealtime.ts");
const { effectiveStatus, clientIsOnline, teamOnline, STALE_MS, CLIENT_STALE_MS } = await import("../src/lib/chatPresence.ts");

const ROOT = "6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d";

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const out = fn();
  if (out instanceof Promise) return out.finally(restore);
  restore();
}

test("a channel name is stable and does not contain the id it stands for", () => {
  const a = channelNameWith("secret-one-0123456789", "chat", ROOT);
  assert.equal(a, channelNameWith("secret-one-0123456789", "chat", ROOT));
  assert.match(a, /^chat:[0-9a-f]{32}$/);
  assert.ok(!a.includes(ROOT.replace(/-/g, "").slice(0, 8)));
});

test("a different secret (another environment) gives a different channel", () => {
  assert.notEqual(
    channelNameWith("dev-secret-0123456789", "chat", ROOT),
    channelNameWith("prod-secret-0123456789", "chat", ROOT),
  );
});

test("kinds never collide for the same id", () => {
  const key = "secret-one-0123456789";
  assert.notEqual(channelNameWith(key, "chat", ROOT).split(":")[1], channelNameWith(key, "client", ROOT).split(":")[1]);
});

test("realtime needs no switch: it runs whenever a usable shared secret exists", () => {
  // The shared webhook secret is enough; no chat-specific variable is required.
  withEnv({ CHAT_REALTIME_SECRET: undefined, SERVICE_WEBHOOK_SECRET: "a-long-enough-shared-secret" }, () => {
    assert.equal(realtimeEnabled(), true);
    assert.match(channelName("inbox") ?? "", /^inbox:[0-9a-f]{32}$/);
  });
  // A dedicated secret, if one is ever set, wins over the shared one.
  withEnv({ CHAT_REALTIME_SECRET: "dedicated-secret-0123456", SERVICE_WEBHOOK_SECRET: "a-long-enough-shared-secret" }, () => {
    assert.notEqual(channelName("inbox"), channelNameWith("a-long-enough-shared-secret", "inbox"));
    assert.equal(channelName("inbox"), channelNameWith("dedicated-secret-0123456", "inbox"));
  });
  // No usable secret (missing or too short) -> nothing is named, the chat polls.
  withEnv({ CHAT_REALTIME_SECRET: undefined, SERVICE_WEBHOOK_SECRET: undefined }, () => {
    assert.equal(realtimeEnabled(), false);
    assert.equal(channelName("inbox"), null);
  });
  withEnv({ CHAT_REALTIME_SECRET: undefined, SERVICE_WEBHOOK_SECRET: "short" }, () => {
    assert.equal(realtimeEnabled(), false);
  });
  withEnv({ CHAT_REALTIME_SECRET: undefined, SERVICE_WEBHOOK_SECRET: "a-long-enough-shared-secret", CHAT_REALTIME_ENV: "Dev!" }, () => {
    assert.match(channelName("chat", ROOT) ?? "", /^dev:chat:[0-9a-f]{32}$/);
  });
});

test("broadcast with no usable secret sends nothing and never throws", async () => {
  await withEnv({ CHAT_REALTIME_SECRET: undefined, SERVICE_WEBHOOK_SECRET: undefined }, async () => {
    const realFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    try {
      assert.equal(await broadcast([{ channel: channelName("inbox"), event: "changed" }]), false);
      assert.equal(called, false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("broadcast payloads carry ids only, never message text, and a failure resolves false", async () => {
  await withEnv({ CHAT_REALTIME_SECRET: undefined, SERVICE_WEBHOOK_SECRET: "a-long-enough-shared-secret" }, async () => {
    const realFetch = globalThis.fetch;
    let sent = "";
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      sent = String(init?.body ?? "");
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    try {
      const { pingVisibleMessage } = await import("../src/lib/chatRealtime.ts");
      assert.equal(await pingVisibleMessage(ROOT, ["c1", "c1", "c2"]), true);
      const body = JSON.parse(sent) as { messages: { topic: string; event: string; payload: Record<string, unknown> }[] };
      // chat + inbox + one per DISTINCT client
      assert.equal(body.messages.length, 4);
      assert.deepEqual(Object.keys(body.messages[1].payload), ["root"]);
      assert.ok(body.messages.every((m) => !("body" in m.payload) && !("text" in m.payload)));

      globalThis.fetch = (async () => {
        throw new Error("network down");
      }) as typeof fetch;
      assert.equal(await pingVisibleMessage(ROOT), false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("a staff heartbeat older than the stale window reads as offline", () => {
  const now = Date.parse("2026-10-22T12:00:00Z");
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  assert.equal(effectiveStatus({ status: "online", last_seen_at: at(10_000) }, now), "online");
  assert.equal(effectiveStatus({ status: "away", last_seen_at: at(10_000) }, now), "away");
  assert.equal(effectiveStatus({ status: "online", last_seen_at: at(STALE_MS + 1) }, now), "offline");
  assert.equal(effectiveStatus({ status: "offline", last_seen_at: at(1) }, now), "offline");
  assert.equal(effectiveStatus(null, now), "offline");
});

test("the team is online only if someone is fresh AND online (away does not count)", () => {
  const now = Date.parse("2026-10-22T12:00:00Z");
  const row = (status: "online" | "away" | "offline", msAgo: number) => ({
    staff_email: `${status}${msAgo}@iclosed.ca`,
    manual_status: "online" as const,
    status,
    last_seen_at: new Date(now - msAgo).toISOString(),
  });
  assert.equal(teamOnline([row("away", 1000), row("online", STALE_MS + 5)], now), false);
  assert.equal(teamOnline([row("away", 1000), row("online", 1000)], now), true);
  assert.equal(teamOnline([], now), false);
});

test("a client is online only while flagged and recently seen", () => {
  const now = Date.parse("2026-10-22T12:00:00Z");
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  assert.equal(clientIsOnline({ client_online: true, client_last_seen_at: at(30_000) }, now), true);
  assert.equal(clientIsOnline({ client_online: true, client_last_seen_at: at(CLIENT_STALE_MS + 1) }, now), false);
  assert.equal(clientIsOnline({ client_online: false, client_last_seen_at: at(1) }, now), false);
  assert.equal(clientIsOnline(undefined, now), false);
});
