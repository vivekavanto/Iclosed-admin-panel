"use client";

import { useEffect, useRef, useState } from "react";
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";

// Listen on a chat realtime channel (see src/lib/chatRealtime.ts). Browsers
// only LISTEN: every ping is sent by the server after an authorised write, and
// a ping carries no content — the handler refetches through the usual API.
//
// One socket and one subscription per channel name, however many components
// listen (the sidebar badge and the inbox both follow the inbox channel).
// `connected` lets callers slow their polling while pings flow; `onResync`
// fires when the socket comes back after a drop and when the tab becomes
// visible again, so anything missed meanwhile is caught up.
//
// Always on: it listens whenever the server hands it a channel name (the server
// gives none only if it has no usable shared secret), and polling stays as the
// slow safety net either way.
//
// MIRRORED in the portal: iclosed_dev_web/src/hooks/useChatChannel.ts.

type Handler = (event: string, payload: Record<string, unknown>) => void;
type Listener = { onEvent: Handler; onStatus: (up: boolean) => void };
type Entry = { channel: RealtimeChannel; listeners: Set<Listener>; up: boolean };

let client: SupabaseClient | null = null;
const entries = new Map<string, Entry>();

function realtimeClient(): SupabaseClient | null {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  // Its own client with no session: broadcast channels need only the anon key,
  // and this must never touch (or race to refresh) the app's auth cookie.
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: "chat-realtime" },
  });
  return client;
}

function join(name: string, listener: Listener): () => void {
  let entry = entries.get(name);
  if (!entry) {
    const sb = realtimeClient();
    if (!sb) return () => {};
    const channel = sb.channel(name, { config: { broadcast: { self: false } } });
    const created: Entry = { channel, listeners: new Set(), up: false };
    channel.on("broadcast", { event: "*" }, (msg: { event?: string; payload?: Record<string, unknown> }) => {
      for (const l of created.listeners) l.onEvent(msg.event ?? "", msg.payload ?? {});
    });
    channel.subscribe((status) => {
      created.up = status === "SUBSCRIBED";
      for (const l of created.listeners) l.onStatus(created.up);
    });
    entries.set(name, created);
    entry = created;
  }
  entry.listeners.add(listener);
  if (entry.up) listener.onStatus(true);
  const e = entry;
  return () => {
    e.listeners.delete(listener);
    if (e.listeners.size === 0) {
      entries.delete(name);
      void realtimeClient()?.removeChannel(e.channel);
    }
  };
}

export function useChatChannel(
  name: string | null | undefined,
  onEvent: Handler,
  onResync?: () => void,
): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const eventRef = useRef(onEvent);
  const resyncRef = useRef(onResync);
  useEffect(() => {
    eventRef.current = onEvent;
    resyncRef.current = onResync;
  });

  useEffect(() => {
    if (!name) return;
    let wasUp = false;
    let dropped = false;
    const leave = join(name, {
      onEvent: (event, payload) => eventRef.current(event, payload),
      onStatus: (up) => {
        setConnected(up);
        if (up && dropped) resyncRef.current?.();
        if (!up && wasUp) dropped = true;
        if (up) {
          wasUp = true;
          dropped = false;
        }
      },
    });
    const onVisible = () => {
      if (document.visibilityState === "visible") resyncRef.current?.();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      leave();
      setConnected(false);
    };
  }, [name]);

  return { connected: connected && !!name };
}
