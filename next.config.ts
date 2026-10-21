import type { NextConfig } from "next";
import path from "node:path";

// SEC-010 — baseline security headers on every response.
//
// The five headers below are safe to ENFORCE (they don't change what the app can
// load, only how browsers treat the responses). The Content-Security-Policy is
// shipped as REPORT-ONLY: it never blocks anything, it only reports violations to
// the browser console — so it can't break the app. Once you've clicked through
// the app + portal and confirmed there are no CSP violations in the console for
// legitimate features, rename the header key from
// "Content-Security-Policy-Report-Only" to "Content-Security-Policy" to enforce.
const securityHeaders = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains; preload",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  {
    // Report-only: does NOT block. Covers the app's known external origins
    // (Supabase, Vercel Blob, Google Gemini, Resend). Widen this from the
    // console reports before switching it to the enforcing header name.
    key: "Content-Security-Policy-Report-Only",
    value: [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      // globals.css @imports the Inter face from Google Fonts, so the
      // stylesheet origin and the font-file origin both have to be named here.
      // Without them the app falls back to a system font the day this header is
      // switched to enforcing - already visible as a report-only violation.
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: blob: https://*.blob.vercel-storage.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "connect-src 'self' blob: data: https://*.supabase.co wss://*.supabase.co https://*.blob.vercel-storage.com https://generativelanguage.googleapis.com https://api.resend.com",
      // HEIC identification photos are decoded to JPEG in the browser (heic-to
      // → libheif/WASM) when building a deal or task PDF. libheif runs in a
      // worker created from a blob: URL, which without this directive falls
      // back to default-src 'self' and is refused — so HEIC IDs would silently
      // drop back to a "could not be converted" placeholder the day this
      // header is switched to enforcing.
      "worker-src 'self' blob:",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  logging: { incomingRequests: { ignore: [/\/api\/admin\/legal-assistant\/mailbox\/callback/, /\/admin\/auth\/confirm/] } },
  turbopack: {
    root: path.join(__dirname),
  },
  // The deposit-task email attaches assets/funds-transfer-instructions.pdf, read
  // off the filesystem at send time (see sendDepositTaskEmail.ts). Nothing
  // imports it, so Next's tracer cannot see it and the file would be absent from
  // the deployed function — the email would then silently go out with only the
  // Final Statement of Account. Name it here so it is bundled.
  // public/email-logo.png is ALSO read off the filesystem, by packagePdf.ts, for
  // the running header of the emailed deal package. Being in public/ makes it a
  // CDN asset (which is what the email templates need) but does NOT put it in a
  // serverless function's filesystem, so it has to be named here too. Without
  // it the package silently falls back to the plain text wordmark.
  // nodemailer is a CJS package that resolves ./lib/well-known/services.json and
  // its own package.json by relative path, and requires node builtins
  // conditionally. It is not in Next's default externals list, so without this
  // the bundler pulls it into every function that can reach the email module.
  // Leaving it external eliminates a class of build-succeeds/runtime-fails
  // divergence you would only discover in production.
  serverExternalPackages: ["nodemailer"],
  outputFileTracingIncludes: {
    "/api/admin/legal-assistant/coo/preview": ["./scripts/coo/render_preview.py", "./scripts/coo/assets/nw-letterhead.jpg"],
    "/api/admin/deals/[id]/deposit-task": ["./assets/funds-transfer-instructions.pdf"],
    "/api/admin/deals/[id]/package": ["./public/email-logo.png"],
    "/api/admin/deals/[id]/email-to-clerk": ["./public/email-logo.png"],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // ARC-004: legacy top-level URLs now redirect to their /admin/* home instead of
  // being duplicated as redirect-only page stubs. Keeps old bookmarks working.
  async redirects() {
    return [
      { source: "/deals", destination: "/admin/deals", permanent: true },
      { source: "/deals/:id", destination: "/admin/deals/:id", permanent: true },
      { source: "/leads", destination: "/admin/leads", permanent: true },
      { source: "/tasks", destination: "/admin/tasks", permanent: true },
      { source: "/settings", destination: "/admin/settings", permanent: true },
      {
        source: "/settings/default-tasks",
        destination: "/admin/settings/default-tasks",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
