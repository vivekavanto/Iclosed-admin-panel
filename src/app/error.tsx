"use client";

import { useEffect } from "react";

// ARC-008: route-segment error boundary. Catches render/data errors anywhere in
// the app subtree and shows a graceful fallback instead of a blank screen, with
// a "Try again" that re-renders the segment.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app error boundary]", error);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-6">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold text-gray-900">
          Something went wrong
        </h1>
        <p className="mt-2 text-sm text-gray-600">
          An unexpected error occurred. You can try again, or reload the page.
        </p>
        {error?.digest ? (
          <p className="mt-2 text-xs text-gray-400">Ref: {error.digest}</p>
        ) : null}
        <div className="mt-6 flex items-center justify-center gap-3">
          <button
            onClick={reset}
            className="rounded-lg bg-[#C10007] px-4 py-2 text-sm font-medium text-white hover:bg-[#a10006]"
          >
            Try again
          </button>
          <a
            href="/"
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}
