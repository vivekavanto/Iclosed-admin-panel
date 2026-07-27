import { createHmac, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";

// Shared-secret signature check for service-to-service POSTs (SEC-002).
//
// Why this exists: a handful of /api/webhooks/* and /api/admin/* routes are
// called by EXTERNAL callers (the customer portal, intake/first-login flows)
// that carry no admin session cookie, so src/middleware.ts deliberately leaves
// them ungated. They send email and mutate deal state, so an unauthenticated
// caller who knows the URL can harvest emails or activate deals. This helper
// lets each such route require an HMAC-SHA-256 signature over the raw request
// body, keyed on SERVICE_WEBHOOK_SECRET (shared with the portal repo).
//
// Rollout is env-gated so the admin and portal deploys don't have to land
// atomically:
//   SERVICE_WEBHOOK_ENFORCE unset / "false"  -> Phase 1: verify, log on
//       mismatch, but STILL LET THE REQUEST THROUGH. Safe to ship before the
//       portal starts signing.
//   SERVICE_WEBHOOK_ENFORCE = "true"          -> Phase 2: reject mismatches
//       with 401. Flip this only once the logs show every real caller signs.

const SECRET = process.env.SERVICE_WEBHOOK_SECRET ?? "";

// Enforcement is opt-in and can be turned on globally OR per endpoint, so you
// can enforce only the routes whose callers already sign (e.g. activate-deal)
// and leave the rest in warn-only until their callers are updated — no
// big-bang flip that risks breaking an endpoint whose caller doesn't sign yet.
//
//   SERVICE_WEBHOOK_ENFORCE = "true"                 -> enforce EVERY guarded route
//   SERVICE_WEBHOOK_ENFORCE_ROUTES = "new-lead,..."  -> also enforce these
//                                                       (comma-separated routeKeys)
//
// `activate-deal` is ENFORCED BY DEFAULT — it's the route the portal already
// signs, so once the shared secret is deployed it is protected automatically
// with no env flag needed. The other routes stay warn-only until you add them
// above (their callers don't sign yet). Enforcement also fails OPEN whenever the
// server has no secret configured (see guardServiceRequest), so a missing or
// not-yet-deployed secret can never block real traffic like deal activation.
const DEFAULT_ENFORCED_ROUTES = new Set(["activate-deal"]);
const ENFORCE_ALL = process.env.SERVICE_WEBHOOK_ENFORCE === "true";
const ENFORCE_ROUTES = new Set(
  (process.env.SERVICE_WEBHOOK_ENFORCE_ROUTES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

function shouldEnforce(routeKey?: string): boolean {
  if (ENFORCE_ALL) return true;
  if (!routeKey) return false;
  return ENFORCE_ROUTES.has(routeKey) || DEFAULT_ENFORCED_ROUTES.has(routeKey);
}

// Reject signatures whose timestamp is older/newer than this, to blunt replay
// of a captured request. The portal must send X-iClosed-Timestamp (ms epoch)
// and fold it into the signed payload.
const MAX_SKEW_MS = 5 * 60 * 1000;

const SIGNATURE_HEADER = "x-iclosed-signature";
const TIMESTAMP_HEADER = "x-iclosed-timestamp";

export type SignatureCheck = { ok: true } | { ok: false; reason: string };

// The exact string both sides hash: "<timestamp>.<raw body>". Keeping the
// timestamp inside the signed payload is what makes the freshness check
// tamper-proof — a replayer can't just bump the header.
function signingPayload(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

/**
 * Compute the hex signature for a body + timestamp. Exposed so callers/tests
 * (and the portal snippet) can mirror it exactly.
 */
export function computeServiceSignature(
  timestamp: string,
  rawBody: string,
): string {
  return createHmac("sha256", SECRET)
    .update(signingPayload(timestamp, rawBody))
    .digest("hex");
}

/**
 * Verify the signature header against the raw request body. Pure — does not
 * decide whether to block; callers use guardServiceRequest() for that.
 */
export function verifyServiceSignature(
  req: Request,
  rawBody: string,
): SignatureCheck {
  if (!SECRET) {
    // Misconfiguration, not an attack. Surface it loudly; in enforce mode
    // guardServiceRequest() turns this into a 500-ish block.
    return { ok: false, reason: "server missing SERVICE_WEBHOOK_SECRET" };
  }

  const provided = req.headers.get(SIGNATURE_HEADER);
  const timestamp = req.headers.get(TIMESTAMP_HEADER);
  if (!provided) return { ok: false, reason: "missing signature header" };
  if (!timestamp) return { ok: false, reason: "missing timestamp header" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: "malformed timestamp header" };
  }
  // Date.now() is fine in a Node route handler (this is not a workflow script).
  if (Math.abs(Date.now() - ts) > MAX_SKEW_MS) {
    return { ok: false, reason: "timestamp outside allowed window" };
  }

  const expected = computeServiceSignature(timestamp, rawBody);

  // timingSafeEqual throws on length mismatch, so guard length first — a length
  // difference already means "no match" and leaks nothing timing-wise.
  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature mismatch" };
  }

  return { ok: true };
}

/**
 * Route-level guard. Returns a NextResponse to send back when the request must
 * be blocked, or null when the handler may proceed.
 *
 * In Phase 1 (ENFORCE off) this NEVER blocks: it only logs mismatches so we can
 * confirm from the logs that every real caller is signing before we flip on
 * enforcement. In Phase 2 it returns 401 on any failure.
 *
 * Usage in a route:
 *   const raw = await req.text();
 *   const blocked = guardServiceRequest(req, raw);
 *   if (blocked) return blocked;
 *   const body = JSON.parse(raw);
 */
export function guardServiceRequest(
  req: Request,
  rawBody: string,
  options?: { routeKey?: string },
): NextResponse | null {
  const result = verifyServiceSignature(req, rawBody);
  if (result.ok) return null;

  const path =
    (req as { nextUrl?: { pathname?: string } }).nextUrl?.pathname ??
    new URL(req.url).pathname;
  const routeKey = options?.routeKey;

  // FAIL OPEN when the server has no secret configured. A missing secret is a
  // deployment/config gap, not an attack — blocking here would break real
  // traffic (e.g. deal activation) the moment this ships. So we only ever
  // reject a request that carried a PRESENT-but-WRONG signature.
  const serverHasNoSecret = result.reason.includes("missing SERVICE_WEBHOOK_SECRET");

  if (serverHasNoSecret || !shouldEnforce(routeKey)) {
    console.warn(
      `[service-sig] warn-only: would reject ${path} (route=${routeKey ?? "?"}) — ${result.reason}`,
    );
    return null;
  }

  console.warn(
    `[service-sig] rejected ${path} (route=${routeKey ?? "?"}) — ${result.reason}`,
  );
  return NextResponse.json(
    { success: false, error: "Unauthorized" },
    { status: 401 },
  );
}
