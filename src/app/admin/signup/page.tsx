"use client";
import { useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import { isCompanyEmail } from "@/lib/staffAccess";
export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setMessage("");
    const normalized = email.trim().toLowerCase();
    if (!isCompanyEmail(normalized)) { setMessage("Use your @navawilson.law or @iclosed.ca email address."); return; }
    setBusy(true);
    try {
      const { data, error } = await supabase.auth.signUp({ email: normalized, password, options: { emailRedirectTo: `${window.location.origin}/admin/auth/confirm` } });
      if (error) { setMessage(error.message); return; }
      // New accounts receive no app_metadata privileges. Confirmation must be enabled in Supabase.
      if (data.session) await supabase.auth.signOut();
      setMessage("Check your email to verify your account. If you already have an account, sign in using your existing password. Saru must grant tab access before you can use the modules.");
    } catch { setMessage("Unable to create your account. Please try again."); }
    finally { setBusy(false); }
  }
  return <main className="min-h-screen bg-slate-50 flex items-center justify-center p-6"><section className="bg-white rounded-xl border p-8 w-full max-w-md"><h1 className="text-2xl font-semibold">Create your staff account</h1><p className="mt-2 text-sm text-slate-600">For Nava Wilson and iClosed staff. Verify your email, then Saru assigns your tab access.</p><form onSubmit={submit} className="mt-6 space-y-4"><label className="block">Work email<input className="mt-1 border rounded p-3 w-full" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} /></label><label className="block">Password<input className="mt-1 border rounded p-3 w-full" type="password" autoComplete="new-password" required minLength={12} value={password} onChange={e => setPassword(e.target.value)} /></label><button className="bg-red-700 text-white rounded px-4 py-3 w-full disabled:opacity-50" disabled={busy}>{busy ? "Creating account…" : "Create account"}</button></form>{message && <p role="status" className="mt-4 text-sm">{message}</p>}<Link href="/admin/login" className="block mt-5 underline text-sm">Already have an account? Sign in</Link></section></main>;
}
