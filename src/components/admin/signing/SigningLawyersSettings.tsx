"use client";

import React, { useEffect, useState } from "react";
import { Plus, Pencil, Trash2, Save, X } from "lucide-react";

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

export default function SigningLawyersSettings() {
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Signing lawyers</h2>
        <button
          className="btn btn-sm btn-primary gap-1"
          onClick={() => setEditing(emptyLawyer())}
        >
          <Plus className="w-4 h-4" /> Add lawyer
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-base-content/60">Loading…</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Initials</th>
                <th>Name</th>
                <th>Email</th>
                <th>Calendar</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lawyers.map((l) => (
                <tr key={l.id}>
                  <td className="font-mono">{l.initials}</td>
                  <td>{l.full_name}</td>
                  <td>{l.email}</td>
                  <td>{l.calendar_id}</td>
                  <td>
                    <span className={`badge badge-sm ${l.is_active ? "badge-success" : "badge-ghost"}`}>
                      {l.is_active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="flex gap-2 justify-end">
                    <button className="btn btn-xs" onClick={() => setHoursFor(l)}>
                      Hours
                    </button>
                    <button className="btn btn-xs btn-ghost" onClick={() => setEditing(l)}>
                      <Pencil className="w-3 h-3" />
                    </button>
                    {l.is_active && (
                      <button className="btn btn-xs btn-ghost text-error" onClick={() => deactivate(l)}>
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {lawyers.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center text-base-content/50 py-6">
                    No lawyers configured yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <div className="modal modal-open">
          <div className="modal-box max-w-md">
            <h3 className="font-semibold mb-4">{editing.id ? "Edit lawyer" : "Add lawyer"}</h3>
            <div className="space-y-3">
              <label className="form-control">
                <span className="label-text text-xs">Initials (used in the booking URL and event titles)</span>
                <input
                  className="input input-bordered input-sm"
                  value={editing.initials ?? ""}
                  maxLength={4}
                  onChange={(e) => setEditing({ ...editing, initials: e.target.value.toUpperCase() })}
                />
              </label>
              <label className="form-control">
                <span className="label-text text-xs">Full name</span>
                <input
                  className="input input-bordered input-sm"
                  value={editing.full_name ?? ""}
                  onChange={(e) => setEditing({ ...editing, full_name: e.target.value })}
                />
              </label>
              <label className="form-control">
                <span className="label-text text-xs">Google Workspace email (calendar impersonated)</span>
                <input
                  className="input input-bordered input-sm"
                  value={editing.email ?? ""}
                  onChange={(e) => setEditing({ ...editing, email: e.target.value })}
                />
              </label>
              <label className="form-control">
                <span className="label-text text-xs">Calendar id</span>
                <input
                  className="input input-bordered input-sm"
                  value={editing.calendar_id ?? "primary"}
                  onChange={(e) => setEditing({ ...editing, calendar_id: e.target.value })}
                />
              </label>
              <label className="label cursor-pointer justify-start gap-2">
                <input
                  type="checkbox"
                  className="checkbox checkbox-sm"
                  checked={editing.is_active !== false}
                  onChange={(e) => setEditing({ ...editing, is_active: e.target.checked })}
                />
                <span className="label-text text-xs">Active (bookable)</span>
              </label>
            </div>
            <div className="modal-action">
              <button className="btn btn-sm" onClick={() => setEditing(null)}>
                <X className="w-3 h-3" /> Cancel
              </button>
              <button
                className="btn btn-sm btn-primary"
                disabled={savingId !== null}
                onClick={saveLawyer}
              >
                <Save className="w-3 h-3" /> Save
              </button>
            </div>
          </div>
        </div>
      )}

      {hoursFor && (
        <LawyerHoursModal lawyer={hoursFor} onClose={() => setHoursFor(null)} />
      )}
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
    <div className="modal modal-open">
      <div className="modal-box max-w-lg">
        <h3 className="font-semibold mb-4">{lawyer.full_name} — working hours</h3>
        {loading ? (
          <p className="text-sm text-base-content/60">Loading…</p>
        ) : (
          <div className="space-y-2">
            {DAY_LABELS.map((label, day) => {
              const v = hours[day] ?? { enabled: false, start: "10:00", end: "16:00" };
              return (
                <div key={day} className="flex items-center gap-3">
                  <label className="flex items-center gap-2 w-20">
                    <input
                      type="checkbox"
                      className="checkbox checkbox-sm"
                      checked={v.enabled}
                      onChange={(e) =>
                        setHours({ ...hours, [day]: { ...v, enabled: e.target.checked } })
                      }
                    />
                    <span className="text-sm">{label}</span>
                  </label>
                  <input
                    type="time"
                    className="input input-bordered input-sm"
                    disabled={!v.enabled}
                    value={v.start}
                    onChange={(e) => setHours({ ...hours, [day]: { ...v, start: e.target.value } })}
                  />
                  <span className="text-xs">to</span>
                  <input
                    type="time"
                    className="input input-bordered input-sm"
                    disabled={!v.enabled}
                    value={v.end}
                    onChange={(e) => setHours({ ...hours, [day]: { ...v, end: e.target.value } })}
                  />
                </div>
              );
            })}
          </div>
        )}
        <div className="modal-action">
          <button className="btn btn-sm" onClick={onClose}>
            <X className="w-3 h-3" /> Cancel
          </button>
          <button className="btn btn-sm btn-primary" disabled={saving || loading} onClick={save}>
            <Save className="w-3 h-3" /> Save
          </button>
        </div>
      </div>
    </div>
  );
}
