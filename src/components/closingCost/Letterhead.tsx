"use client";

import React from "react";
import { docDownloadHref } from "@/lib/blobPrivacy";

// The firm letterhead above a closing-cost statement — every value from the
// firm's profile in Settings → Closing costs, so it matches the PDF's.
//
// Shared by the per-deal calculator and the standalone one; the only difference
// between them is which file number sits on the right.

const Letterhead: React.FC<{
  /** The merged config row for the firm currently selected. */
  config: Record<string, unknown>;
  /** Shown as "File No."; a standalone estimate may legitimately have none. */
  fileNo?: string | null;
}> = ({ config, fileNo }) => {
  const firmName = String(config.firm_name || config.label || "");
  const logoUrl = String(config.logo_url || "");
  const todayStr = new Date().toLocaleDateString("en-CA", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="flex flex-wrap items-start justify-between gap-5 border-b border-gray-200 pb-4">
      <div className="flex flex-col gap-1.5">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={docDownloadHref(logoUrl)}
            alt={firmName}
            className="h-[30px] w-auto object-contain"
          />
        ) : (
          <span className="text-2xl font-bold leading-none tracking-tight text-gray-900">
            {firmName}
          </span>
        )}
        <div className="text-[12.5px] leading-relaxed text-gray-500">
          {String(config.firm_address || "")}
          <br />
          Tel: {String(config.firm_phone || "—")} · Fax:{" "}
          {String(config.firm_fax || "—")} · HST #{" "}
          {String(config.firm_hst_number || "—")}
        </div>
      </div>
      <div className="text-right text-xs leading-loose text-gray-500">
        <div>
          File No.{" "}
          <span className="font-semibold tabular-nums text-gray-900">
            {fileNo || "—"}
          </span>
        </div>
        <div>Prepared {todayStr}</div>
      </div>
    </div>
  );
};

export default Letterhead;
