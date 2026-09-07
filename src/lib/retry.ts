// GAP-012 — retry a flaky async operation (e.g. a Resend send) a few times with
// exponential backoff before giving up, so a single transient network/API blip
// doesn't drop a transactional email.
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: {
    attempts?: number;
    baseMs?: number;
    label?: string;
    /**
     * Whether a given failure is worth another attempt. Defaults to "always",
     * which is the behaviour every existing caller had before this option
     * existed.
     *
     * Added for the email transport: some failures are PERMANENT and retrying
     * them is not merely wasted time. An SMTP server that refused the
     * credentials will refuse them again, and hammering it three times invites
     * rate-limiting (Gmail answers `454 4.7.0 Too many login attempts`), which
     * turns a clear "bad password" into an opaque outage. Same for a mail server
     * rejecting a recipient, or Resend rejecting an unverified sender domain.
     */
    shouldRetry?: (err: unknown) => boolean;
  },
): Promise<T> {
  const attempts = opts?.attempts ?? 3;
  const baseMs = opts?.baseMs ?? 400;
  const shouldRetry = opts?.shouldRetry ?? (() => true);
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Give up immediately on a failure that cannot succeed on a second try.
      if (!shouldRetry(err)) break;
      if (i < attempts - 1) {
        const wait = baseMs * 2 ** i; // 400ms, 800ms, 1600ms, …
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}
