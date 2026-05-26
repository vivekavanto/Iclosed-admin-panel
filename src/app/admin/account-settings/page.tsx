"use client";

import React, { useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { Eye, EyeOff, ArrowLeft, Check, Mail, AlertTriangle, KeyRound, Lock } from "lucide-react";
import Link from "next/link";
import { useAuth } from "@/lib/AuthProvider";

type Step = "email" | "password" | "done";

export default function AccountSettingsPage() {
  const { user } = useAuth();

  const [step, setStep] = useState<Step>("email");
  const [updatedEmail, setUpdatedEmail] = useState<string>("");

  // Email stage
  const [newEmail, setNewEmail] = useState("");
  const [emailCurrentPassword, setEmailCurrentPassword] = useState("");
  const [showEmailPw, setShowEmailPw] = useState(false);
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailError, setEmailError] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Password stage
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [pwLoading, setPwLoading] = useState(false);
  const [pwError, setPwError] = useState("");

  const handleEmailSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setEmailError("");

    const trimmed = newEmail.trim().toLowerCase();
    if (!trimmed) {
      setEmailError("Please enter a new email address.");
      return;
    }
    if (trimmed === user?.email?.toLowerCase()) {
      setEmailError("New email must be different from your current email.");
      return;
    }
    setConfirmOpen(true);
  };

  const performEmailChange = async () => {
    setConfirmOpen(false);
    setEmailLoading(true);
    setEmailError("");

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        setEmailError("Session expired. Please sign in again.");
        setEmailLoading(false);
        return;
      }

      const res = await fetch("/api/admin/account/update-email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          newEmail: newEmail.trim().toLowerCase(),
          currentPassword: emailCurrentPassword,
        }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        setEmailError(data.error ?? "Failed to change email.");
        setEmailLoading(false);
        return;
      }

      // Email changed — advance to password decision stage.
      setUpdatedEmail(data.email);
      setStep("password");
    } catch (err: unknown) {
      setEmailError(err instanceof Error ? err.message : "Failed to change email.");
    } finally {
      setEmailLoading(false);
    }
  };

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError("");

    if (newPassword.length < 8) {
      setPwError("Password must contain at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwError("New passwords do not match.");
      return;
    }

    setPwLoading(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setPwLoading(false);

    if (error) {
      setPwError(error.message);
      return;
    }
    setStep("done");
  };

  const keepCurrentPassword = () => {
    setStep("done");
  };

  return (
    <div className="max-w-lg mx-auto mt-12 mb-12">
      <Link
        href="/admin/dashboard"
        className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700 mb-6"
      >
        <ArrowLeft size={16} />
        Back to Dashboard
      </Link>

      <h1 className="text-2xl font-bold text-slate-900 mb-1">Account Settings</h1>
      <p className="text-sm text-slate-500 mb-6">
        Update the email and password used to sign in to the admin panel.
      </p>

      {/* ───────────── STAGE 1: Email ───────────── */}
      {step === "email" && (
        <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8">
          <h2 className="text-lg font-semibold text-slate-900 mb-1">Step 1 — Change Email</h2>
          <p className="text-sm text-slate-500 mb-5">
            Current email: <span className="font-medium text-slate-700">{user?.email ?? "—"}</span>
          </p>

          <form onSubmit={handleEmailSubmit} className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                New Email Address
              </label>
              <div className="relative">
                <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
                  <Mail size={18} />
                </div>
                <input
                  type="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="new-admin@example.com"
                  required
                  className="w-full pl-10 pr-4 py-3 rounded-lg border border-slate-300 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition-all"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Current Password
              </label>
              <div className="relative">
                <input
                  type={showEmailPw ? "text" : "password"}
                  value={emailCurrentPassword}
                  onChange={(e) => setEmailCurrentPassword(e.target.value)}
                  placeholder="Enter current password to confirm"
                  required
                  className="w-full px-4 py-3 pr-12 rounded-lg border border-slate-300 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition-all"
                />
                <button
                  type="button"
                  onClick={() => setShowEmailPw(!showEmailPw)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
                >
                  {showEmailPw ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
              </div>
            </div>

            {emailError && (
              <div className="bg-red-50 border border-red-200 text-red-600 text-sm rounded-lg px-4 py-3">
                {emailError}
              </div>
            )}

            <button
              type="submit"
              disabled={emailLoading}
              className="w-full bg-slate-900 hover:bg-slate-800 text-white font-semibold py-3 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {emailLoading ? "Updating..." : "Change Email"}
            </button>
          </form>
        </div>
      )}

      {/* ───────────── STAGE 2: Password decision ───────────── */}
      {step === "password" && (
        <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8 space-y-6">
          <div className="flex items-start gap-2 bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg px-4 py-3">
            <Check size={16} className="mt-0.5 flex-shrink-0" />
            <span>
              Email updated to <strong>{updatedEmail}</strong>. Use this email the next time you sign in.
            </span>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-1">
              Step 2 — Do you also want to change your password?
            </h2>
            <p className="text-sm text-slate-500 mb-5">
              You can set a new password below, or keep your current password as-is.
            </p>

            <form onSubmit={handlePasswordChange} className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  New Password
                </label>
                <div className="relative">
                  <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
                    <Lock size={18} />
                  </div>
                  <input
                    type={showNew ? "text" : "password"}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    className="w-full pl-10 pr-12 py-3 rounded-lg border border-slate-300 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition-all"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNew(!showNew)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  >
                    {showNew ? <EyeOff size={20} /> : <Eye size={20} />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  Confirm New Password
                </label>
                <div className="relative">
                  <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
                    <Lock size={18} />
                  </div>
                  <input
                    type={showConfirm ? "text" : "password"}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter new password"
                    className="w-full pl-10 pr-12 py-3 rounded-lg border border-slate-300 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition-all"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirm(!showConfirm)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  >
                    {showConfirm ? <EyeOff size={20} /> : <Eye size={20} />}
                  </button>
                </div>
              </div>

              {pwError && (
                <div className="bg-red-50 border border-red-200 text-red-600 text-sm rounded-lg px-4 py-3">
                  {pwError}
                </div>
              )}

              <button
                type="submit"
                disabled={pwLoading || !newPassword}
                className="flex items-center justify-center gap-2 w-full bg-red-600 hover:bg-red-700 text-white font-semibold py-3 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <KeyRound size={16} />
                {pwLoading ? "Updating..." : "Set New Password"}
              </button>
            </form>

            <div className="flex items-center gap-3 my-5">
              <div className="flex-1 border-t border-slate-200" />
              <span className="text-xs text-slate-400 uppercase tracking-wider">or</span>
              <div className="flex-1 border-t border-slate-200" />
            </div>

            <button
              type="button"
              onClick={keepCurrentPassword}
              className="w-full bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 font-medium py-3 rounded-lg transition-colors"
            >
              Keep my current password
            </button>
          </div>
        </div>
      )}

      {/* ───────────── STAGE 3: Done ───────────── */}
      {step === "done" && (
        <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8 text-center">
          <div className="w-14 h-14 mx-auto bg-green-100 rounded-full flex items-center justify-center mb-4">
            <Check size={28} className="text-green-600" />
          </div>
          <h2 className="text-xl font-bold text-slate-900 mb-2">All done!</h2>
          <p className="text-sm text-slate-500 mb-6">
            Your account is updated. Next time you sign in, use:
          </p>
          <div className="bg-slate-50 rounded-lg px-4 py-3 mb-6 text-left">
            <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">Email</div>
            <div className="font-medium text-slate-900">{updatedEmail}</div>
          </div>
          <Link
            href="/admin/dashboard"
            className="inline-block w-full bg-slate-900 hover:bg-slate-800 text-white font-semibold py-3 rounded-lg transition-colors"
          >
            Back to Dashboard
          </Link>
        </div>
      )}

      {/* Confirmation dialog */}
      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
          onClick={() => setConfirmOpen(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 mb-4">
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
                <AlertTriangle size={20} className="text-amber-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Confirm email change</h3>
                <p className="text-sm text-slate-500 mt-1">
                  You will sign in with the new email next time. Make sure it&apos;s spelled correctly.
                </p>
              </div>
            </div>
            <div className="bg-slate-50 rounded-lg px-4 py-3 mb-5 text-sm">
              <div className="text-slate-500">From</div>
              <div className="font-medium text-slate-900 mb-2">{user?.email ?? "—"}</div>
              <div className="text-slate-500">To</div>
              <div className="font-medium text-slate-900">{newEmail.trim().toLowerCase()}</div>
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="flex-1 py-2.5 border border-slate-300 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={performEmailChange}
                className="flex-1 py-2.5 bg-red-600 text-white rounded-lg text-sm font-semibold hover:bg-red-700"
              >
                Yes, change email
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
