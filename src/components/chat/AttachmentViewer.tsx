"use client";

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Download, FileText, X } from "lucide-react";
import { formatAttachmentSize, isImageAttachment, type ChatAttachment } from "@/lib/chatAttachments";

// WhatsApp-style file viewer for chat attachments. Clicking a file in a bubble
// OPENS this overlay (nothing downloads); the Download button is the only thing
// that saves it. Images show large, PDFs render inline, and files a browser
// can't show (Word, Excel, HEIC) get a card with the name, size and Download.
// Several files on one message can be flicked through with the arrows / keys.
//
// Shared by the admin inbox and the portal widget: the file is identical in
// both repos (iclosed_dev_web/src/components/chat/AttachmentViewer.tsx), and
// each app passes its own `hrefFor`, because the two serve files from
// different routes.

export type AttachmentViewerProps = {
  items: ChatAttachment[];
  startIndex: number;
  /** URL for a file; `download` = true asks the server to send it as a download. */
  hrefFor: (a: ChatAttachment, download?: boolean) => string;
  onClose: () => void;
};

export default function AttachmentViewer({ items, startIndex, hrefFor, onClose }: AttachmentViewerProps) {
  const [index, setIndex] = useState(Math.min(Math.max(startIndex, 0), Math.max(items.length - 1, 0)));
  const [imageFailed, setImageFailed] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const current = items[index];

  const go = (delta: number) => {
    setImageFailed(false);
    setIndex((i) => (i + delta + items.length) % items.length);
  };

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden"; // the page behind must not scroll
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (items.length > 1 && e.key === "ArrowLeft") go(-1);
      else if (items.length > 1 && e.key === "ArrowRight") go(1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- go() only closes over items.length
  }, [items.length, onClose]);

  if (!current || typeof document === "undefined") return null;

  const isPdf = (current.type || "").toLowerCase() === "application/pdf";
  const showImage = isImageAttachment(current) && !imageFailed;

  // A portal, so the overlay sits above everything (the portal widget lives in a
  // low z-index stacking context and the inbox clips with overflow-hidden).
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Viewing ${current.name}`}
      className="fixed inset-0 z-[1000] flex flex-col bg-black/85"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex flex-none items-center gap-3 px-4 py-3 text-white" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="flex h-9 w-9 flex-none cursor-pointer items-center justify-center rounded-full hover:bg-white/15">
          <X size={20} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{current.name}</p>
          <p className="text-xs text-white/70">
            {formatAttachmentSize(current.size)}
            {items.length > 1 && ` · ${index + 1} of ${items.length}`}
          </p>
        </div>
        <a
          href={hrefFor(current, true)}
          download={current.name}
          className="flex h-9 flex-none items-center gap-2 rounded-full bg-white/15 px-4 text-[13px] font-semibold text-white no-underline hover:bg-white/25"
        >
          <Download size={16} /> Download
        </a>
      </div>

      <div
        className="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-6 sm:px-14"
        onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      >
        {showImage ? (
          // eslint-disable-next-line @next/next/no-img-element -- auth-gated route, not a static asset
          <img
            key={current.url}
            src={hrefFor(current)}
            alt={current.name}
            onError={() => setImageFailed(true)}
            className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
          />
        ) : isPdf ? (
          <iframe
            key={current.url}
            src={hrefFor(current)}
            title={current.name}
            className="h-full w-full max-w-4xl rounded-lg bg-white shadow-2xl"
          />
        ) : (
          // Nothing a browser can render (Word, Excel, HEIC): the WhatsApp "no preview" card.
          <div className="flex w-full max-w-xs flex-col items-center gap-3 rounded-2xl bg-white px-6 py-8 text-center shadow-2xl">
            <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gray-100 text-gray-500">
              <FileText size={32} />
            </span>
            <div className="min-w-0 max-w-full">
              <p className="break-words text-sm font-semibold text-gray-900 [overflow-wrap:anywhere]">{current.name}</p>
              <p className="mt-0.5 text-xs text-gray-500">{formatAttachmentSize(current.size)}</p>
            </div>
            <p className="text-xs text-gray-500">No preview available for this file.</p>
            <a
              href={hrefFor(current, true)}
              download={current.name}
              className="flex h-10 items-center gap-2 rounded-full bg-[#C10007] px-5 text-[13px] font-semibold text-white no-underline hover:bg-[#a30006]"
            >
              <Download size={16} /> Download
            </a>
          </div>
        )}

        {items.length > 1 && (
          <>
            <button type="button" onClick={() => go(-1)} aria-label="Previous file" className="absolute left-2 top-1/2 flex h-10 w-10 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25 sm:left-3">
              <ChevronLeft size={22} />
            </button>
            <button type="button" onClick={() => go(1)} aria-label="Next file" className="absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25 sm:right-3">
              <ChevronRight size={22} />
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
