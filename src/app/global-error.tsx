"use client";

import { useEffect } from "react";

// ARC-008: root-level error boundary. Catches errors thrown in the root layout
// itself, where the normal error.tsx can't run. It replaces the whole document,
// so it must render its own <html>/<body> and use inline styles (the app's CSS
// may not be available at this point).
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[global error boundary]", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: "system-ui, sans-serif",
          background: "#f9fafb",
        }}
      >
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "24px",
          }}
        >
          <div style={{ maxWidth: "28rem", textAlign: "center" }}>
            <h1
              style={{
                fontSize: "1.25rem",
                fontWeight: 600,
                color: "#111827",
                margin: 0,
              }}
            >
              Something went wrong
            </h1>
            <p
              style={{
                marginTop: "0.5rem",
                fontSize: "0.875rem",
                color: "#4b5563",
              }}
            >
              The application ran into an unexpected error. Please reload the
              page.
            </p>
            {error?.digest ? (
              <p
                style={{
                  marginTop: "0.5rem",
                  fontSize: "0.75rem",
                  color: "#9ca3af",
                }}
              >
                Ref: {error.digest}
              </p>
            ) : null}
            <button
              onClick={reset}
              style={{
                marginTop: "1.5rem",
                borderRadius: "0.5rem",
                background: "#C10007",
                color: "#fff",
                border: "none",
                padding: "0.5rem 1rem",
                fontSize: "0.875rem",
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
