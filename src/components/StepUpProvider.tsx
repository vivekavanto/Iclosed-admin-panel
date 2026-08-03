"use client";

import React, { createContext, useCallback, useContext, useRef, useState } from "react";
import { KeyRound, X } from "lucide-react";

/**
 * The SEC-006 step-up prompt: "re-enter YOUR admin password to log in as this
 * client", with a "Don't ask me again" option.
 *
 * Replaces a bare window.prompt(), which can't carry a checkbox and looks like
 * a browser security warning. Exposed as a promise so calling code reads like
 * the prompt it replaces:
 *
 *   const answer = await requestStepUp();
 *   if (!answer) return;              // admin cancelled
 *   answer.password, answer.remember
 */

export type StepUpAnswer = { password: string; remember: boolean };

type StepUpRequest = {
  /** Shown under the title, e.g. the client being opened. */
  subject?: string;
  /** False when the server says this deploy can't remember (no session id). */
  canRemember?: boolean;
};

type StepUpContextValue = (req?: StepUpRequest) => Promise<StepUpAnswer | null>;

const StepUpContext = createContext<StepUpContextValue | null>(null);

export function useStepUp(): StepUpContextValue {
  const ctx = useContext(StepUpContext);
  if (!ctx) {
    throw new Error("useStepUp must be used inside <StepUpProvider>");
  }
  return ctx;
}

export function StepUpProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState<StepUpRequest>({});
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const resolverRef = useRef<((answer: StepUpAnswer | null) => void) | null>(null);

  const settle = useCallback((answer: StepUpAnswer | null) => {
    resolverRef.current?.(answer);
    resolverRef.current = null;
    setOpen(false);
    setPassword("");
  }, []);

  const requestStepUp = useCallback<StepUpContextValue>((req = {}) => {
    setRequest(req);
    setPassword("");
    setOpen(true);
    return new Promise<StepUpAnswer | null>((resolve) => {
      // A second request while one is open cancels the first, so no caller is
      // left waiting on a promise that never settles.
      resolverRef.current?.(null);
      resolverRef.current = resolve;
    });
  }, []);

  const canRemember = request.canRemember !== false;

  return (
    <StepUpContext.Provider value={requestStepUp}>
      {children}

      {open && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) settle(null);
          }}
        >
          <form
            className="w-full max-w-md rounded-xl bg-white shadow-xl border border-slate-200"
            onSubmit={(e) => {
              e.preventDefault();
              if (!password) return;
              settle({ password, remember: canRemember && remember });
            }}
          >
            <div className="flex items-start justify-between gap-3 p-5 pb-3">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-red-50 text-[#C10007] flex items-center justify-center shrink-0">
                  <KeyRound size={18} />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-sm">Security check</h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Re-enter YOUR admin password to log in as
                    {request.subject ? ` ${request.subject}` : " this client"}.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => settle(null)}
                className="text-slate-400 hover:text-slate-600 p-1 -m-1"
                aria-label="Cancel"
              >
                <X size={18} />
              </button>
            </div>

            <div className="px-5 pb-5 space-y-3">
              <input
                type="password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your admin password"
                autoComplete="current-password"
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-md focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007]"
              />

              {canRemember && (
                <label className="flex items-start gap-2 text-xs text-slate-600 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                    className="mt-0.5 accent-[#C10007]"
                  />
                  <span>
                    Don&apos;t ask me again
                    <span className="block text-slate-400">
                      Applies until you sign out of the admin portal.
                    </span>
                  </span>
                </label>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => settle(null)}
                  className="px-3 py-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!password}
                  className="px-4 py-1.5 text-xs font-semibold text-white bg-[#C10007] rounded-md hover:bg-[#a30006] disabled:opacity-60"
                >
                  Continue
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
    </StepUpContext.Provider>
  );
}
