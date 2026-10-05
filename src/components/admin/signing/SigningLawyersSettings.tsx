"use client";

import React, { useEffect, useState } from "react";
import { Plus, Pencil, Trash2, Save, X, Scale, Clock, SlidersHorizontal } from "lucide-react";
import SigningGeneralSettings from "./SigningGeneralSettings";

interface Lawyer {
  id: string;
  initials: string;
  full_name: string;
  email: string;
  calendar_id: string;
  is_active: boolean;
}

interface LawyerHour {
  day_of_week: number;
  start_time: string;
  end_time: string;
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DEFAULT_WORKDAYS = [1, 2, 3, 4, 5]; // Mon-Fri

function emptyLawyer(): Partial<Lawyer> {
  return { initials: "", full_name: "", email: "", calendar_id: "primary", is_active: true };
}

const inputClasses =
  "w-full px-4 py-2.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary bg-white";

type Tab = "lawyers" | "settings";

interface SigningLawyersSettingsProps {
  initialTab?: Tab;
}

export default function SigningLawyersSettings({ initialTab = "lawyers" }: SigningLawyersSettingsProps) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [lawyers, setLawyers] = useState<Lawyer[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<Lawyer> | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [hoursFor, setHoursFor] = useState<Lawyer | null>(null);

  // Not called synchronously as the first thing in an effect (that pattern is
  // flagged by react-hooks/set-state-in-effect) — the mount load below fetches
  // directly instead. This version is for re-fetching after a save/deactivate.
  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/signing/lawyers");
      const json = await res.json();
      if (json.success) setLawyers(json.data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/signing/lawyers");
        const json = await res.json();
        if (!cancelled && json.success) setLawyers(json.data);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveLawyer() {
    if (!editing) return;
    const isNew = !editing.id;
    const url = isNew ? "/api/admin/signing/lawyers" : `/api/admin/signing/lawyers/${editing.id}`;
    setSavingId(editing.id ?? "new");
    try {
      const res = await fetch(url, {
        method: isNew ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing),
      });
      const json = await res.json();
      if (!json.success) {
        alert(json.error || "Failed to save lawyer");
        return;
      }
      setEditing(null);
      await load();
      // A brand-new lawyer has no working hours yet — chain straight into
      // that modal instead of leaving them non-bookable until someone
      // remembers to click "Hours" separately afterward.
      if (isNew) setHoursFor(json.data as Lawyer);
    } finally {
      setSavingId(null);
    }
  }

  async function deactivate(lawyer: Lawyer) {
    if (!confirm(`Deactivate ${lawyer.full_name}? Existing appointments are kept.`)) return;
    await fetch(`/api/admin/signing/lawyers/${lawyer.id}`, { method: "DELETE" });
    await load();
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start gap-4">
        <div className="flex items-start gap-4">
          <div className="bg-brand-primary/10 p-2.5 rounded-lg">
            <Scale className="text-brand-primary" size={32} />
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">Signing</h1>
            <p className="text-sm text-slate-500 mt-1">
              {tab === "lawyers"
                ? "Manage the lawyers who can be booked for signing appointments."
                : "Booking defaults, office location and notices for signing appointments."}
            </p>
          </div>
        </div>
        {tab === "lawyers" && (
          <button
            onClick={() => setEditing(emptyLawyer())}
            className="bg-brand-primary text-white px-4 py-2.5 rounded-xl flex items-center gap-2 font-bold text-sm shadow-lg shadow-brand-primary/20 hover:bg-brand-primaryHover transition-all active:scale-95 whitespace-nowrap"
          >
            <Plus size={18} />
            Add Lawyer
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl w-fit">
        <button
          onClick={() => setTab("lawyers")}
          className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-semibold transition-all ${
            tab === "lawyers" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
          }`}
        >
          <Scale size={14} /> Lawyers
        </button>
        <button
          onClick={() => setTab("settings")}
          className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-semibold transition-all ${
            tab === "settings" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
          }`}
        >
          <SlidersHorizontal size={14} /> General Settings
        </button>
      </div>

      {tab === "settings" && <SigningGeneralSettings />}

      {/* List */}
      {tab === "lawyers" && (
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-x-auto">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-primary"></div>
          </div>
        ) : (
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-slate-50/30 border-b border-slate-100">
              <tr className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">
                <th className="px-6 py-5">Initials</th>
                <th className="px-4 py-5">Name</th>
                <th className="px-4 py-5">Email</th>
                <th className="px-4 py-5">Calendar</th>
                <th className="px-4 py-5">Status</th>
                <th className="px-4 py-5 text-center w-40">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {lawyers.map((l) => (
                <tr key={l.id} className="hover:bg-slate-50/50 transition-colors group">
                  <td className="px-6 py-4 font-mono text-slate-700">{l.initials}</td>
                  <td className="px-4 py-4 font-semibold text-slate-800">{l.full_name}</td>
                  <td className="px-4 py-4 text-slate-500">{l.email}</td>
                  <td className="px-4 py-4 text-slate-500">{l.calendar_id}</td>
                  <td className="px-4 py-4">
                    <span
                      className={`px-2.5 py-1 rounded-full text-xs font-bold ${
                        l.is_active ? "bg-green-50 text-green-700" : "bg-slate-100 text-slate-500"
                      }`}
                    >
                      {l.is_active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex items-center justify-center gap-1">
                      <button
                        onClick={() => setHoursFor(l)}
                        className="p-2 rounded-lg text-slate-400 hover:text-brand-primary hover:bg-brand-primary/10 transition-colors"
                        title="Working hours"
                      >
                        <Clock size={16} />
                      </button>
                      <button
                        onClick={() => setEditing(l)}
                        className="p-2 rounded-lg text-slate-400 hover:text-brand-primary hover:bg-brand-primary/10 transition-colors"
                        title="Edit"
                      >
                        <Pencil size={16} />
                      </button>
                      {l.is_active && (
                        <button
                          onClick={() => deactivate(l)}
                          className="p-2 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                          title="Deactivate"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {lawyers.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-12 py-20 text-center text-slate-400">
                    No lawyers configured yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      )}

      {editing && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 md:left-[var(--sidebar-w,256px)] z-50 flex justify-end items-stretch lg:justify-center lg:items-center bg-black/30 lg:bg-black/40 lg:backdrop-blur-sm lg:p-4 xl:p-12 transition-[left] duration-300"
          onClick={() => setEditing(null)}
        >
          <div
            className="bg-white shadow-2xl flex flex-col w-full h-full max-w-[480px] lg:h-auto lg:max-h-[90vh] lg:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between px-6 py-5 border-b border-gray-100">
              <h3 className="text-base font-bold text-gray-900">
                {editing.id ? "Edit lawyer" : "Add a lawyer"}
              </h3>
              <button
                onClick={() => setEditing(null)}
                className="text-gray-400 hover:text-gray-700 shrink-0 ml-4"
                aria-label="Close"
              >
                <X size={20} />
              </button>
            </div>

            <div className="px-6 py-6 space-y-4 overflow-y-auto flex-1">
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1.5">
                  Initials (used in the booking URL and event titles)
                </label>
                <input
                  className={inputClasses}
                  value={editing.initials ?? ""}
                  maxLength={4}
                  onChange={(e) => setEditing({ ...editing, initials: e.target.value.toUpperCase() })}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1.5">Full name</label>
                <input
                  className={inputClasses}
                  value={editing.full_name ?? ""}
                  onChange={(e) => setEditing({ ...editing, full_name: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1.5">
                  Google Workspace email (calendar impersonated)
                </label>
                <input
                  className={inputClasses}
                  value={editing.email ?? ""}
                  onChange={(e) => setEditing({ ...editing, email: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1.5">Calendar id</label>
                <input
                  className={inputClasses}
                  value={editing.calendar_id ?? "primary"}
                  onChange={(e) => setEditing({ ...editing, calendar_id: e.target.value })}
                />
              </div>
              <label className="flex items-center gap-2 cursor-pointer w-fit">
                <input
                  type="checkbox"
                  className="w-4 h-4 rounded border-slate-300 text-brand-primary focus:ring-brand-primary"
                  checked={editing.is_active !== false}
                  onChange={(e) => setEditing({ ...editing, is_active: e.target.checked })}
                />
                <span className="text-sm text-slate-600">Active (bookable)</span>
              </label>
            </div>

            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100">
              <button
                onClick={() => setEditing(null)}
                className="px-4 py-2 rounded-lg border border-slate-200 text-slate-700 text-sm font-semibold hover:bg-slate-50 transition-colors flex items-center gap-2"
              >
                <X size={16} /> Cancel
              </button>
              <button
                disabled={savingId !== null}
                onClick={saveLawyer}
                className="px-4 py-2 rounded-lg bg-brand-primary text-white text-sm font-semibold hover:bg-brand-primaryHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                <Save size={16} /> Save
              </button>
            </div>
          </div>
        </div>
      )}

      {hoursFor && <LawyerHoursModal lawyer={hoursFor} onClose={() => setHoursFor(null)} />}
    </div>
  );
}

function LawyerHoursModal({ lawyer, onClose }: { lawyer: Lawyer; onClose: () => void }) {
  const [hours, setHours] = useState<Record<number, { enabled: boolean; start: string; end: string }>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/admin/signing/lawyers/${lawyer.id}/hours`);
        const json = await res.json();
        const byDay: Record<number, { enabled: boolean; start: string; end: string }> = {};
        for (let d = 0; d < 7; d++) {
          byDay[d] = { enabled: DEFAULT_WORKDAYS.includes(d), start: "10:00", end: "16:00" };
        }
        if (json.success) {
          for (const row of json.data as LawyerHour[]) {
            byDay[row.day_of_week] = {
              enabled: true,
              start: row.start_time.slice(0, 5),
              end: row.end_time.slice(0, 5),
            };
          }
        }
        setHours(byDay);
      } finally {
        setLoading(false);
      }
    })();
  }, [lawyer.id]);

  async function save() {
    setSaving(true);
    try {
      const payload = Object.entries(hours)
        .filter(([, v]) => v.enabled)
        .map(([day, v]) => ({ day_of_week: Number(day), start_time: v.start, end_time: v.end }));
      const res = await fetch(`/api/admin/signing/lawyers/${lawyer.id}/hours`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hours: payload }),
      });
      const json = await res.json();
      if (!json.success) {
        alert(json.error || "Failed to save hours");
        return;
      }
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 md:left-[var(--sidebar-w,256px)] z-50 flex justify-end items-stretch lg:justify-center lg:items-center bg-black/30 lg:bg-black/40 lg:backdrop-blur-sm lg:p-4 xl:p-12 transition-[left] duration-300"
      onClick={onClose}
    >
      <div
        className="bg-white shadow-2xl flex flex-col w-full h-full max-w-[560px] lg:h-auto lg:max-h-[90vh] lg:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-6 py-5 border-b border-gray-100">
          <h3 className="text-base font-bold text-gray-900">{lawyer.full_name} — working hours</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 shrink-0 ml-4"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        <div className="px-6 py-6 overflow-y-auto flex-1">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-primary"></div>
            </div>
          ) : (
            <div className="space-y-3">
              {DAY_LABELS.map((label, day) => {
                const v = hours[day] ?? { enabled: false, start: "10:00", end: "16:00" };
                return (
                  <div key={day} className="flex items-center gap-3">
                    <label className="flex items-center gap-2 w-20 cursor-pointer">
                      <input
                        type="checkbox"
                        className="w-4 h-4 rounded border-slate-300 text-brand-primary focus:ring-brand-primary"
                        checked={v.enabled}
                        onChange={(e) =>
                          setHours({ ...hours, [day]: { ...v, enabled: e.target.checked } })
                        }
                      />
                      <span className="text-sm font-medium text-slate-700">{label}</span>
                    </label>
                    <input
                      type="time"
                      className={`${inputClasses} disabled:bg-slate-50 disabled:text-slate-400`}
                      disabled={!v.enabled}
                      value={v.start}
                      onChange={(e) => setHours({ ...hours, [day]: { ...v, start: e.target.value } })}
                    />
                    <span className="text-xs text-slate-400">to</span>
                    <input
                      type="time"
                      className={`${inputClasses} disabled:bg-slate-50 disabled:text-slate-400`}
                      disabled={!v.enabled}
                      value={v.end}
                      onChange={(e) => setHours({ ...hours, [day]: { ...v, end: e.target.value } })}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-slate-200 text-slate-700 text-sm font-semibold hover:bg-slate-50 transition-colors flex items-center gap-2"
          >
            <X size={16} /> Cancel
          </button>
          <button
            disabled={saving || loading}
            onClick={save}
            className="px-4 py-2 rounded-lg bg-brand-primary text-white text-sm font-semibold hover:bg-brand-primaryHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            <Save size={16} /> Save
          </button>
        </div>
      </div>
    </div>
  );
}
