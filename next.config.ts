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
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://*.blob.vercel-storage.com",
      "font-src 'self' data:",
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.blob.vercel-storage.com https://generativelanguage.googleapis.com https://api.resend.com",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  turbopack: {
    root: path.join(__dirname),
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
