'use client';

import React, { useState } from 'react';
import { Loader2, RefreshCw, X } from 'lucide-react';

type SyncResult = {
  deal_id: string;
  client: string;
  address: string;
  status: 'assigned' | 'needs_review' | 'not_found' | 'error';
  file_number?: string;
  selling_file_number?: string;
  candidates?: { fileNumber: string; label: string }[];
};

const STATUS_LABEL: Record<SyncResult['status'], string> = {
  assigned: 'Assigned',
  needs_review: 'Needs review',
  not_found: 'Not in Tickler yet',
  error: 'Error',
};

export default function SyncFileNumbersButton({ onSynced }: { onSynced: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SyncResult[] | null>(null);

  const sync = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/file-numbers/sync', { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error ?? 'Sync failed');
      setResults(data.results);
      if (data.results.some((r: SyncResult) => r.status === 'assigned')) onSynced();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setBusy(false);
    }
  };

  const assigned = results?.filter((r) => r.status === 'assigned').length ?? 0;

  return (
    <>
      <button
        type="button"
        onClick={sync}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
        title="Fill pending file numbers from the Tickler sheet"
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        Sync file numbers
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}

      {results && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setResults(null)}>
          <div
            className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between border-b border-slate-100 px-5 py-4">
              <div>
                <h3 className="text-sm font-bold text-slate-900">File number sync</h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  {results.length === 0
                    ? 'No files are waiting for a file number.'
                    : `${assigned} of ${results.length} pending files assigned.`}
                </p>
              </div>
              <button onClick={() => setResults(null)} className="text-slate-400 hover:text-slate-700" aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <ul className="divide-y divide-slate-100 overflow-y-auto px-5">
              {results.map((r) => (
                <li key={r.deal_id} className="py-3 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <a href={`/admin/deals/${r.deal_id}`} className="min-w-0 truncate font-medium text-slate-800 hover:text-brand-primary">
                      {r.client || 'Unnamed client'} · {r.address}
                    </a>
                    <span
                      className={`shrink-0 font-semibold ${
                        r.status === 'assigned' ? 'text-green-700' : r.status === 'error' ? 'text-red-600' : 'text-amber-700'
                      }`}
                    >
                      {r.status === 'assigned'
                        ? [r.file_number, r.selling_file_number].filter(Boolean).join(' / ')
                        : STATUS_LABEL[r.status]}
                    </span>
                  </div>
                  {!!r.candidates?.length && (
                    <ul className="mt-1.5 space-y-0.5 text-slate-500">
                      {r.candidates.map((c) => (
                        <li key={c.fileNumber} className="truncate">Possible: {c.label}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
            {results.some((r) => r.status !== 'assigned') && (
              <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
                Files not assigned stay pending. Enter the number from the deal&apos;s Edit dialog, or sync again later.
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
