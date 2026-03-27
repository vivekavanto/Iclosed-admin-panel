"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { Eye, EyeOff, ArrowLeft, Check } from "lucide-react";
import Link from "next/link";
import { useAuth } from "@/lib/AuthProvider";

export default function AccountSettingsPage() {
  const router = useRouter();
  const { user } = useAuth();

  // Display name state
  const [displayName, setDisplayName] = useState(
    (user?.user_metadata?.display_name as string) || ""
  );
  const [nameSaving, setNameSaving] = useState(false);
  const [nameSuccess, setNameSuccess] = useState(false);
  const [nameError, setNameError] = useState("");

  // Password state
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showOld, setShowOld] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [pwLoading, setPwLoading] = useState(false);
  const [pwError, setPwError] = useState("");

  const handleNameUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setNameError("");
    setNameSuccess(false);

    if (!displayName.trim()) {
      setNameError("Display name cannot be empty.");
      return;
    }

    setNameSaving(true);

    const { error } = await supabase.auth.updateUser({
      data: { display_name: displayName.trim() },
    });

    if (error) {
      setNameError(error.message);
    } else {
      setNameSuccess(true);
      setTimeout(() => setNameSuccess(false), 3000);
    }

    setNameSaving(false);
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

    if (oldPassword === newPassword) {
      setPwError("New password must be different from old password.");
      return;
    }

    setPwLoading(true);

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: user?.email ?? "",
      password: oldPassword,
    });

    if (signInError) {
      setPwError("Old password is incorrect.");
      setPwLoading(false);
      return;
    }

    const { error: updateError } = await supabase.auth.updateUser({
      password: newPassword,
    });

    if (updateError) {
      setPwError(updateError.message);
      setPwLoading(false);
      return;
    }

    setPwLoading(false);
    router.push("/admin/dashboard");
  };

  return (
    <div className="max-w-lg mx-auto mt-12">
      <Link
        href="/admin/dashboard"
        className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700 mb-6"
      >
        <ArrowLeft size={16} />
        Back to Dashboard
      </Link>

      <h1 className="text-2xl font-bold text-slate-900 mb-3">Change Password</h1>

      {/* Display Name Section */}
      {/* <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8 mb-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-1">Display Name</h2>
        <p className="text-sm text-slate-500 mb-5">
          This name will be shown in the dashboard greeting and sidebar.
        </p>

        <form onSubmit={handleNameUpdate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Name
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Enter your display name"
              required
              className="w-full px-4 py-3 rounded-lg border border-slate-300 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition-all"
            />
          </div>

          <div className="flex items-center gap-3">
            <p className="text-xs text-slate-400">
              Email: {user?.email}
            </p>
          </div>

          {nameError && (
            <div className="bg-red-50 border border-red-200 text-red-600 text-sm rounded-lg px-4 py-3">
              {nameError}
            </div>
          )}

          {nameSuccess && (
            <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-600 text-sm rounded-lg px-4 py-3">
              <Check size={16} />
              Display name updated successfully.
            </div>
          )}

          <button
            type="submit"
            disabled={nameSaving}
            className="bg-slate-900 hover:bg-slate-800 text-white font-medium px-6 py-2.5 rounded-lg transition-colors disabled:opacity-50 text-sm"
          >
            {nameSaving ? "Saving..." : "Update Name"}
          </button>
        </form>
      </div> */}
 
        {/* <p className="text-sm text-slate-500 mb-5">
          Enter your old password, then enter your new password twice to confirm.
        </p> */}
      {/* Change Password Section */}
      <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8">
       

        <form onSubmit={handlePasswordChange} className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Old Password
            </label>
            <div className="relative">
              <input
                type={showOld ? "text" : "password"}
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                placeholder="Enter current password"
                required
                className="w-full px-4 py-3 pr-12 rounded-lg border border-slate-300 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition-all"
              />
              <button
                type="button"
                onClick={() => setShowOld(!showOld)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
              >
                {showOld ? <EyeOff size={20} /> : <Eye size={20} />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              New Password
            </label>
            <div className="relative">
              <input
                type={showNew ? "text" : "password"}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter new password"
                required
                className="w-full px-4 py-3 pr-12 rounded-lg border border-slate-300 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition-all"
              />
              <button
                type="button"
                onClick={() => setShowNew(!showNew)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
              >
                {showNew ? <EyeOff size={20} /> : <Eye size={20} />}
              </button>
            </div>
            <ul className="mt-2 space-y-0.5 text-xs text-slate-500">
              <li>Must contain at least 8 characters</li>
              <li>Cannot be the same as your old password</li>
            </ul>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Confirm New Password
            </label>
            <div className="relative">
              <input
                type={showConfirm ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Enter new password again"
                required
                className="w-full px-4 py-3 pr-12 rounded-lg border border-slate-300 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition-all"
              />
              <button
                type="button"
                onClick={() => setShowConfirm(!showConfirm)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
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
            disabled={pwLoading}
            className="w-full bg-red-500 hover:bg-red-600 text-white font-semibold py-3 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {pwLoading ? "Updating..." : "Change My Password"}
          </button>
        </form>
      </div>
    </div>
  );
}
