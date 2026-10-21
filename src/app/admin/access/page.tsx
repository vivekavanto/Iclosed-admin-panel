"use client";
import { useEffect, useState } from "react";
import { MODULES } from "@/lib/staffAccess";
type Account = { id: string; email: string; verified: boolean; owner: boolean; disabled: boolean; modules: string[] };
export default function AccessPage() {
  const [users, setUsers] = useState<Account[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const all: Account[] = []; let page: number | null = 1;
      try {
        while (page) { const res: Response = await fetch(`/api/admin/access?page=${page}`, { cache: "no-store" }); const data: { users: Account[]; nextPage: number | null; error?: string } = await res.json(); if (!res.ok) throw new Error(data.error); all.push(...data.users); page = data.nextPage; }
        if (!cancelled) { all.sort((a, b) => Number(b.owner) - Number(a.owner) || a.email.localeCompare(b.email)); setUsers(all); setSelectedId(all.find(u => u.owner)?.id ?? all[0]?.id ?? ""); }
      } catch { if (!cancelled) setMessage("Could not load user access."); }
    }
    void load(); return () => { cancelled = true; };
  }, []);
  async function save(user: Account) {
    setBusy(user.id); setMessage("");
    try { const res = await fetch("/api/admin/access", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: user.id, modules: user.modules, disabled: user.disabled }) }); const data = await res.json(); setMessage(res.ok ? `Access saved for ${user.email}.` : data.error); }
    catch { setMessage("Could not save access. Please try again."); } finally { setBusy(null); }
  }
  function change(id: string, update: Partial<Account>) { setUsers(current => current.map(u => u.id === id ? { ...u, ...update } : u)); }
  return <section><h1 className="text-2xl font-semibold">User Access</h1><p className="mt-2 text-sm text-slate-600">Saru owns this portal. New verified staff accounts start with no tabs. Existing admins retain their modules until you change their access. Connected file modules can share supporting data.</p>{message && <p role="status" className="my-4">{message}</p>}<div className="mt-6 flex flex-col gap-3 max-w-xl"><label>Find account<input type="search" className="block border rounded p-2 w-full mt-1" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search by email" /></label><label>Account<select className="block border rounded p-2 w-full mt-1" value={selectedId} onChange={e => setSelectedId(e.target.value)}><option value="">Choose an account</option>{users.filter(u => u.id === selectedId || u.email.toLowerCase().includes(query.toLowerCase())).map(u => <option value={u.id} key={u.id}>{u.email}{u.owner ? " — Owner" : ""}</option>)}</select></label></div><div className="mt-6 space-y-5">{users.filter(u => u.id === selectedId).map(u => <fieldset key={u.id} className="border rounded-xl bg-white p-5" disabled={u.owner || busy === u.id}><legend className="font-semibold">{u.email}{u.owner ? " — Owner" : ""}</legend><p className="text-sm mb-4">{u.verified ? "Email verified" : "Awaiting email verification"}</p>{!u.owner && <label className="block mb-3"><input type="checkbox" checked={u.disabled} onChange={e => change(u.id, { disabled: e.target.checked })} /> Disable portal access</label>}<div className="flex flex-wrap gap-x-6 gap-y-3">{MODULES.map(m => <label className="flex items-center gap-2" key={m.id}><input type="checkbox" checked={u.modules.includes(m.id)} onChange={e => change(u.id, { modules: e.target.checked ? [...u.modules, m.id] : u.modules.filter(x => x !== m.id) })} />{m.label}</label>)}</div>{!u.owner && <button className="mt-5 bg-red-700 text-white px-4 py-2 rounded disabled:opacity-50" onClick={() => save(u)}>{busy === u.id ? "Saving…" : "Save access"}</button>}</fieldset>)}</div></section>;
}
