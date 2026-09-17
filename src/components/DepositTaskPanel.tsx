"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import { FileText, Loader2, Trash2, Upload, Sparkles } from "lucide-react";
import { BLOB_ACCESS, docDownloadHref } from "@/lib/blobPrivacy";
import { STATEMENT_OF_ACCOUNT_DOC_TYPE } from "@/lib/depositTask";
import { formatLocalDate } from "@/lib/formatDate";
import DepositFundsDrawer from "./DepositFundsDrawer";

/**
 * The admin half of "Deposit Funds Into Our Trust Account", rendered inline
 * under its row in the deal page's task table.
 *
 * The task ships switched OFF. Two things have to exist before a client can act
 * on it — the Final Statement of Account, and the balance due it states — and
 * neither exists until days before closing. So this panel is the gate: upload,
 * confirm the figure, then activate, which is the single moment the task appears
 * on the client's dashboard and they are emailed about it.
 *
 * It lives in its own file rather than inside DealDetail because it owns real
 * state (upload, extraction, activation) that nothing else on that page needs,
 * and DealDetail is already 7k lines.
 *
 * The balance is SUGGESTED by reading the uploaded statement (Gemini), never
 * taken from it: the input is prefilled and the admin confirms. A purchaser who
 * wires the wrong amount doesn't close, so the figure a client is shown is
 * always one a human has looked at.
 */

const MAX_STATEMENT_BYTES = 10 * 1024 * 1024;

type StatementDoc = {
  id: string;
  file_name: string | null;
  file_url: string | null;
  created_at: string | null;
};

/**
 * One proof of deposit on the file. Either id can be null: the client's answer
 * lives in `task_responses` and the bytes in `lead_corporate_docs`, and a
 * response row frequently records only a file name.
 */
type ProofDoc = {
  response_id: string | null;
  doc_id: string | null;
  file_name: string | null;
  file_url: string | null;
  created_at: string | null;
};

type DepositTaskState = {
  id: string;
  status: string | null;
  balance_due: number | null;
  activation_required: boolean | null;
  activated_at: string | null;
  completed_at: string | null;
  is_inactive: boolean;
};

interface DepositTaskPanelProps {
  dealId: string;
  /** Refreshes the task table once the task goes live. */
  onActivated?: () => void;
  showToast?: (message: string, type?: "success" | "error") => void;
}

/** "248 KB" / "1.2 MB". */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function DepositTaskPanel({
  dealId,
  onActivated,
  showToast,
}: DepositTaskPanelProps) {
  const [loading, setLoading] = useState(true);
  const [task, setTask] = useState<DepositTaskState | null>(null);
  const [statement, setStatement] = useState<StatementDoc | null>(null);
  const [proofs, setProofs] = useState<ProofDoc[]>([]);
  const [primaryLeadId, setPrimaryLeadId] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [proofDrawerOpen, setProofDrawerOpen] = useState(false);
  const [removingProof, setRemovingProof] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The typed figure is held as a string so a half-typed "1000." doesn't get
  // rewritten under the cursor; it's parsed on save.
  const [balanceInput, setBalanceInput] = useState("");
  // Size + "just now" for the file uploaded in THIS session. A statement
  // uploaded earlier only has what the database recorded, so both are optional.
  const [freshUpload, setFreshUpload] = useState<{ size: number } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback(
    (message: string, type?: "success" | "error") => {
      if (showToast) showToast(message, type);
      else if (type === "error") setError(message);
    },
    [showToast],
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/deals/${dealId}/deposit-task`);
      const data = await res.json();
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || "Could not load the deposit task");
      }
      setTask(data.task ?? null);
      setStatement(data.statement ?? null);
      setProofs(data.proofs ?? []);
      setPrimaryLeadId(data.primary_lead_id ?? null);
      setBalanceInput(
        data.task?.balance_due === null || data.task?.balance_due === undefined
          ? ""
          : String(data.task.balance_due),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the deposit task");
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  const isActive = !!task?.activated_at;

  /** Persist the balance. Called on blur and (debounced) as the admin types. */
  const saveBalance = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      try {
        const res = await fetch(`/api/admin/deals/${dealId}/deposit-task`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ balance_due: trimmed === "" ? null : trimmed }),
        });
        const data = await res.json();
        if (!res.ok || !data?.success) {
          throw new Error(data?.error || "Could not save the balance");
        }
        setTask(data.task ?? null);
      } catch (err) {
        notify(err instanceof Error ? err.message : "Could not save the balance", "error");
      }
    },
    [dealId, notify],
  );

  const handleBalanceChange = (raw: string) => {
    // Digits, one decimal point. Rejecting the rest here means the input can
    // never hold something the server would refuse.
    const cleaned = raw.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
    setBalanceInput(cleaned);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveBalance(cleaned), 600);
  };

  /** Ask the extractor for the balance and prefill the input with it. */
  const extractBalance = useCallback(async () => {
    setExtracting(true);
    try {
      const res = await fetch(`/api/admin/deals/${dealId}/deposit-task/extract-balance`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || "Could not read the balance");
      }
      if (data.balance_due === null || data.balance_due === undefined) {
        notify(
          data.reason
            ? `Could not read the balance — ${data.reason}`
            : "Could not read the balance from the statement. Enter it manually.",
          "error",
        );
        return;
      }
      const value = String(data.balance_due);
      setBalanceInput(value);
      await saveBalance(value);
      notify(
        data.confidence === "high"
          ? "Balance read from the statement — please confirm it"
          : "Balance read from the statement, but check it against the PDF",
        data.confidence === "high" ? "success" : "error",
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not read the balance", "error");
    } finally {
      setExtracting(false);
    }
  }, [dealId, notify, saveBalance]);

  const handleFile = async (file: File) => {
    if (!primaryLeadId) {
      notify("This file has no client record to attach the statement to", "error");
      return;
    }
    if (file.size > MAX_STATEMENT_BYTES) {
      notify("The statement must be 10 MB or smaller", "error");
      return;
    }

    setUploading(true);
    const replacing = statement?.id ?? null;
    try {
      // Browser → Vercel Blob directly: a 10 MB PDF would exceed the ~4.5 MB
      // serverless request-body cap if it went through the function.
      const pathname = `corporate-docs/${primaryLeadId}/${Date.now()}-${file.name}`;
      const blob = await upload(pathname, file, {
        access: BLOB_ACCESS,
        handleUploadUrl: "/api/admin/uploadblobstorage/token",
        contentType: file.type,
        clientPayload: JSON.stringify({ lead_id: primaryLeadId }),
      });

      const res = await fetch("/api/admin/uploadblobstorage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_url: blob.url,
          file_name: file.name,
          lead_id: primaryLeadId,
          doc_type: STATEMENT_OF_ACCOUNT_DOC_TYPE,
        }),
      });
      const data = await res.json();
      if (!res.ok || data?.success === false) {
        throw new Error(data?.error || "Upload failed");
      }

      // Only now drop the one being replaced. Deleting first would mean a failed
      // upload — a rejected file type, a dropped connection — leaves the file
      // with no statement at all, and there is no undo for that.
      if (replacing) {
        await fetch(`/api/admin/deals/${dealId}/deposit-task?doc_id=${replacing}`, {
          method: "DELETE",
        });
      }

      setFreshUpload({ size: file.size });
      await load();
      notify("Statement of account uploaded");

      // Read the figure off the statement straight away — it is the whole
      // reason the admin is here, and the input is empty at this point.
      void extractBalance();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Upload failed", "error");
    } finally {
      setUploading(false);
    }
  };

  /**
   * The drawer has filed the receipt. It returns the refreshed task and the
   * proofs on the file, so nothing needs refetching here — but the deal page's
   * task row does, because the task has just gone Completed.
   */
  const handleProofUploaded = (data: {
    task?: unknown;
    proofs?: unknown;
    task_completed?: boolean;
  }) => {
    setTask((data.task as DepositTaskState | null) ?? null);
    setProofs((data.proofs as ProofDoc[]) ?? []);
    notify(
      data.task_completed
        ? "Proof of deposit uploaded — task completed and the clerk notified"
        : "Proof of deposit uploaded",
    );
    onActivated?.();
  };

  /** Remove a receipt — one filed against the wrong file, or a corrected copy. */
  const removeProof = async (proof: ProofDoc) => {
    const key = proof.response_id ?? proof.doc_id;
    if (!key) return;
    if (
      !window.confirm(
        "Remove this proof of deposit? The task goes back to Pending if it is the only one on the file.",
      )
    ) {
      return;
    }

    setRemovingProof(key);
    try {
      const params = new URLSearchParams();
      if (proof.response_id) params.set("response_id", proof.response_id);
      if (proof.doc_id) params.set("doc_id", proof.doc_id);
      const res = await fetch(
        `/api/admin/deals/${dealId}/deposit-task/proof?${params.toString()}`,
        { method: "DELETE" },
      );
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || "Could not remove the proof of deposit");
      }
      setTask(data.task ?? null);
      setProofs(data.proofs ?? []);
      notify(
        data.reopened ? "Proof removed — the task is Pending again" : "Proof removed",
      );
      onActivated?.();
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "Could not remove the proof of deposit",
        "error",
      );
    } finally {
      setRemovingProof(null);
    }
  };

  const handleActivate = async (resend = false) => {
    setActivating(true);
    try {
      const res = await fetch(`/api/admin/deals/${dealId}/deposit-task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(resend ? { resend: true } : {}),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || "Could not activate the task");
      }
      setTask(data.task ?? null);

      const sent: string[] = data.notified ?? [];
      if (data.already_active) {
        notify("This task is already active");
      } else if (sent.length > 0) {
        notify(
          data.resent
            ? `Email resent to ${sent.join(", ")}`
            : `Task activated — ${sent.join(", ")} notified`,
        );
      } else {
        // The task IS live either way; say so plainly rather than implying the
        // whole action failed, so nobody activates it a second time.
        notify(
          data.email_error
            ? `Task activated, but the email failed: ${data.email_error}`
            : "Task activated, but no client on this file has an email address",
          "error",
        );
      }
      onActivated?.();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not activate the task", "error");
    } finally {
      setActivating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500 py-2">
        <Loader2 size={14} className="animate-spin" />
        Loading deposit details…
      </div>
    );
  }

  if (!task) {
    return (
      <p className="text-sm text-slate-500 py-2">
        {error ?? "This file has no deposit task."}
      </p>
    );
  }

  const isCompleted = task.status === "Completed" || !!task.completed_at;
  const hasBalance = balanceInput.trim() !== "" && Number(balanceInput) > 0;
  const canActivate = !!statement?.file_url && hasBalance && !isActive;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        {/* ── Final Statement of Account ── */}
        <div>
          <p className="text-sm font-semibold text-slate-800 mb-2">
            Final Statement of Account <span className="text-[#C10007]">*</span>
          </p>

          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,application/pdf"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Reset first: picking the same file twice must still fire.
              e.target.value = "";
              if (file) void handleFile(file);
            }}
          />

          {statement?.file_url ? (
            <div className="flex items-center gap-3 bg-white border border-slate-200 rounded-lg px-4 py-3">
              <span className="shrink-0 w-9 h-9 rounded-lg bg-red-50 flex items-center justify-center">
                <FileText size={18} className="text-[#C10007]" />
              </span>
              <div className="min-w-0 flex-1">
                <a
                  href={docDownloadHref(statement.file_url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-sm font-semibold text-slate-800 truncate hover:text-brand-primary transition-colors"
                  title={statement.file_name ?? "Statement of account"}
                >
                  {statement.file_name ?? "Statement of account"}
                </a>
                <p className="text-xs text-slate-500">
                  {freshUpload ? `${formatBytes(freshUpload.size)} · Uploaded just now` : null}
                  {!freshUpload && statement.created_at
                    ? `Uploaded ${formatLocalDate(statement.created_at)}`
                    : null}
                  {!freshUpload && !statement.created_at ? "Uploaded" : null}
                </p>
              </div>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="shrink-0 text-sm font-semibold text-[#C10007] hover:underline disabled:opacity-50"
              >
                {uploading ? "Replacing…" : "Replace"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="w-full flex items-center gap-3 border-2 border-dashed border-slate-300 rounded-lg px-4 py-3 text-left hover:border-brand-primary hover:bg-white/60 transition-colors disabled:opacity-60"
            >
              <span className="shrink-0 w-9 h-9 rounded-full bg-slate-100 flex items-center justify-center">
                {uploading ? (
                  <Loader2 size={16} className="animate-spin text-slate-500" />
                ) : (
                  <Upload size={16} className="text-slate-500" />
                )}
              </span>
              <span>
                <span className="block text-sm font-semibold text-slate-700">
                  {uploading ? "Uploading…" : "Upload final statement of account"}
                </span>
                <span className="block text-xs text-slate-500">.pdf · Max 10MB</span>
              </span>
            </button>
          )}
        </div>

        {/* ── Balance due on closing ── */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-semibold text-slate-800">
              Balance due on closing <span className="text-[#C10007]">*</span>
            </p>
            {statement?.file_url && (
              <button
                type="button"
                onClick={() => void extractBalance()}
                disabled={extracting}
                className="flex items-center gap-1 text-xs font-semibold text-brand-primary hover:underline disabled:opacity-50"
                title="Read the balance off the uploaded statement"
              >
                {extracting ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Sparkles size={12} />
                )}
                {extracting ? "Reading…" : "Read from statement"}
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-4 py-3 focus-within:border-brand-primary transition-colors">
            <span className="text-lg font-semibold text-slate-400">$</span>
            <input
              type="text"
              inputMode="decimal"
              value={balanceInput}
              placeholder="0.00"
              onChange={(e) => handleBalanceChange(e.target.value)}
              onBlur={() => {
                if (saveTimer.current) clearTimeout(saveTimer.current);
                void saveBalance(balanceInput);
              }}
              className="flex-1 text-lg font-bold text-slate-800 bg-transparent outline-none min-w-0"
            />
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Shown to the client in large type on the task.
          </p>
        </div>
      </div>

      {/* ── Activate ── */}
      {isActive ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-block bg-amber-100 border border-amber-200 text-amber-800 text-sm font-semibold rounded-lg px-4 py-3">
            Task activated · client notified
          </span>
          {/* The client may have deleted the email, or it may have gone out
              before a detail was corrected. Resending does not re-activate:
              activated_at keeps its original value. */}
          <button
            type="button"
            onClick={() => void handleActivate(true)}
            disabled={activating}
            className="text-sm font-semibold text-brand-primary hover:underline disabled:opacity-50"
          >
            {activating ? "Sending…" : "Resend email to client"}
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void handleActivate()}
            disabled={!canActivate || activating}
            className={`text-sm font-semibold rounded-lg px-5 py-3 transition-colors ${
              canActivate && !activating
                ? "bg-brand-primary hover:bg-brand-primaryHover text-white cursor-pointer"
                : "bg-slate-200 text-slate-400 cursor-not-allowed"
            }`}
          >
            {activating ? "Activating…" : "Activate task & notify client"}
          </button>
          {!canActivate && (
            <span className="text-sm font-medium text-amber-700">
              Upload the statement and enter the balance to activate.
            </span>
          )}
        </div>
      )}

      {/* ── Proof of deposit ──
          Normally the client's own answer to this task. An admin files it here
          when the funds arrived off-portal, which is the only way to close the
          task on those files. */}
      <div className="border-t border-slate-200 pt-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-semibold text-slate-800">Proof of deposit</p>
          {isCompleted && (
            <span className="text-xs font-semibold text-emerald-700">Received</span>
          )}
        </div>

        {proofs.length > 0 && (
          <ul className="space-y-2 mb-3">
            {proofs.map((proof, i) => {
              const key = proof.response_id ?? proof.doc_id ?? String(i);
              return (
                <li
                  key={key}
                  className="flex items-center gap-3 bg-white border border-slate-200 rounded-lg px-4 py-3"
                >
                  <span className="shrink-0 w-9 h-9 rounded-lg bg-emerald-50 flex items-center justify-center">
                    <FileText size={18} className="text-emerald-600" />
                  </span>
                  <div className="min-w-0 flex-1">
                    {proof.file_url ? (
                      <a
                        href={docDownloadHref(proof.file_url)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block text-sm font-semibold text-slate-800 truncate hover:text-brand-primary transition-colors"
                        title={proof.file_name ?? "Proof of deposit"}
                      >
                        {proof.file_name ?? "Proof of deposit"}
                      </a>
                    ) : (
                      // A response row that recorded only a file name — the
                      // document itself never reached either store.
                      <p className="text-sm font-semibold text-slate-800 truncate">
                        {proof.file_name ?? "Proof of deposit"}
                      </p>
                    )}
                    <p className="text-xs text-slate-500">
                      {proof.created_at
                        ? `Uploaded ${formatLocalDate(proof.created_at)}`
                        : proof.file_url
                          ? "Uploaded"
                          : "Recorded without a file"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void removeProof(proof)}
                    disabled={removingProof !== null}
                    className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg border border-slate-200 text-slate-400 hover:text-[#C10007] hover:border-red-200 hover:bg-red-50 transition-colors disabled:opacity-50"
                    title="Remove this proof"
                    aria-label="Remove this proof of deposit"
                  >
                    {removingProof === (proof.response_id ?? proof.doc_id) ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Trash2 size={14} />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <button
          type="button"
          onClick={() => setProofDrawerOpen(true)}
          disabled={removingProof !== null}
          className="w-full flex items-center gap-3 border-2 border-dashed border-slate-300 rounded-lg px-4 py-3 text-left hover:border-brand-primary hover:bg-white/60 transition-colors disabled:opacity-60"
        >
          <span className="shrink-0 w-9 h-9 rounded-full bg-slate-100 flex items-center justify-center">
            <Upload size={16} className="text-slate-500" />
          </span>
          <span>
            <span className="block text-sm font-semibold text-slate-700">
              {proofs.length > 0
                ? "Upload another proof for the client"
                : "Upload proof of deposit for the client"}
            </span>
            <span className="block text-xs text-slate-500">
              Opens the client&apos;s own screen · completes the task and emails the clerk
            </span>
          </span>
        </button>
      </div>

      {/* The client's screen, so an admin uploading for them sees the balance,
          the statement and the transfer instructions the client is reading. */}
      {proofDrawerOpen && (
        <DepositFundsDrawer
          open
          onClose={() => setProofDrawerOpen(false)}
          dealId={dealId}
          leadId={primaryLeadId}
          balanceDue={task.balance_due}
          statement={statement}
          onUploaded={handleProofUploaded}
        />
      )}

      {error && !showToast && <p className="text-sm text-[#C10007]">{error}</p>}
    </div>
  );
}
