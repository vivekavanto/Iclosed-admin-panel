"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// This staff member's Online / Away for the client chat (src/lib/chatPresence.ts).
//
// Every open admin tab sends a heartbeat every 30 s. Input anywhere in ANY admin
// tab counts as activity (shared through localStorage), so a background tab
// doesn't flip someone Away while they work in another; 15 minutes without
// input reports auto-Away until the next input. A manual Away is stored
// server-side and sticks until they pick Online. Closing the LAST admin tab
// sends a beacon so clients see "Away" at once rather than after the 120 s
// expiry.

const HEARTBEAT_MS = 30_000;
const AUTO_AWAY_MS = 15 * 60_000;
const ACTIVITY_KEY = "chat-presence-activity";
const TAB_PREFIX = "chat-presence-tab:";
const TAB_FRESH_MS = 75_000;
const ENDPOINT = "/api/admin/messages/presence";

export type Availability = { manual: "online" | "away"; status: "online" | "away" | "offline" };

function readNumber(key: string): number {
  try {
    return Number(localStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private window: presence still works per tab */
  }
}

function otherTabsOpen(self: string): boolean {
  try {
    const now = Date.now();
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(TAB_PREFIX) && k !== TAB_PREFIX + self && now - readNumber(k) < TAB_FRESH_MS) return true;
    }
  } catch {
    /* unknown: assume others are open rather than flash Away */
    return true;
  }
  return false;
}

export function useStaffPresence(enabled: boolean): {
  me: Availability | null;
  setManual: (m: "online" | "away") => Promise<void>;
} {
  const [me, setMe] = useState<Availability | null>(null);
  const tabId = useRef("");
  const lastActivity = useRef(0);
  // The presence migration hasn't run: stop beating until the next page load.
  const unavailable = useRef(false);

  const post = useCallback(async (body: Record<string, unknown>) => {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json?.success && json.available && json.me) setMe(json.me as Availability);
      else if (json?.success && json.available === false) {
        unavailable.current = true;
        setMe(null);
      }
    } catch {
      /* next heartbeat retries */
    }
  }, []);

  const beat = useCallback(() => {
    if (unavailable.current) return Promise.resolve();
    const last = Math.max(lastActivity.current, readNumber(ACTIVITY_KEY));
    write(TAB_PREFIX + tabId.current, String(Date.now()));
    return post({ auto_away: Date.now() - last > AUTO_AWAY_MS });
  }, [post]);

  useEffect(() => {
    if (!enabled) return;
    tabId.current = Math.random().toString(36).slice(2);
    lastActivity.current = Date.now();
    write(ACTIVITY_KEY, String(lastActivity.current));

    let wasIdle = false;
    let lastWrite = 0;
    const onActivity = () => {
      const now = Date.now();
      lastActivity.current = now;
      // Throttle the shared write; it only needs minute precision.
      if (now - lastWrite > 15_000) {
        lastWrite = now;
        write(ACTIVITY_KEY, String(now));
      }
      // Coming back from auto-Away: report Online now, not at the next beat.
      if (wasIdle) {
        wasIdle = false;
        void beat();
      }
    };
    const events: (keyof WindowEventMap)[] = ["mousedown", "keydown", "scroll", "touchstart", "focus"];
    for (const e of events) window.addEventListener(e, onActivity, { passive: true });

    void beat();
    const timer = setInterval(() => {
      const last = Math.max(lastActivity.current, readNumber(ACTIVITY_KEY));
      wasIdle = Date.now() - last > AUTO_AWAY_MS;
      void beat();
    }, HEARTBEAT_MS);

    const onHide = () => {
      write(TAB_PREFIX + tabId.current, null);
      if (!otherTabsOpen(tabId.current)) {
        navigator.sendBeacon?.(ENDPOINT, JSON.stringify({ offline: true }));
      }
    };
    window.addEventListener("pagehide", onHide);

    return () => {
      clearInterval(timer);
      for (const e of events) window.removeEventListener(e, onActivity);
      window.removeEventListener("pagehide", onHide);
      write(TAB_PREFIX + tabId.current, null);
    };
  }, [enabled, beat]);

  const setManual = useCallback(
    async (manual: "online" | "away") => {
      setMe((cur) => (cur ? { ...cur, manual, status: manual } : { manual, status: manual }));
      lastActivity.current = Date.now();
      await post({ manual, auto_away: false });
    },
    [post],
  );

  return { me, setManual };
}
