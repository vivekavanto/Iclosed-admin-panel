// ARC-011 — tiny structured logger gated by LOG_LEVEL.
//
// Replaces bare console.* so production output can be turned down (and noisy
// identifier-laden INFO lines suppressed) without code changes. Set the env var
// LOG_LEVEL to "debug" | "info" | "warn" | "error" (default "info"). Each call
// only prints when its level is at or above the configured threshold.
//
// Usage:  import { logger } from "@/lib/logger";
//         logger.info("[Welcome Email] sent", { id });
//         logger.error("[upload] failed", err);

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const configured = (process.env.LOG_LEVEL || "info").toLowerCase() as Level;
  return ORDER[configured] ?? ORDER.info;
}

export const logger = {
  debug: (...args: unknown[]) => {
    if (threshold() <= ORDER.debug) console.debug(...args);
  },
  info: (...args: unknown[]) => {
    if (threshold() <= ORDER.info) console.log(...args);
  },
  warn: (...args: unknown[]) => {
    if (threshold() <= ORDER.warn) console.warn(...args);
  },
  error: (...args: unknown[]) => {
    // Errors always print — you never want to silently drop a real failure.
    console.error(...args);
  },
};
