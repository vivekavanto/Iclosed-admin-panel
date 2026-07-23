// GAP-012 — retry a flaky async operation (e.g. a Resend send) a few times with
// exponential backoff before giving up, so a single transient network/API blip
// doesn't drop a transactional email.
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: { attempts?: number; baseMs?: number; label?: string },
): Promise<T> {
  const attempts = opts?.attempts ?? 3;
  const baseMs = opts?.baseMs ?? 400;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        const wait = baseMs * 2 ** i; // 400ms, 800ms, 1600ms, …
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}
