"use client";

import React, { useEffect, useState } from "react";
import { Save } from "lucide-react";

interface Settings {
  default_duration_minutes: number;
  buffer_minutes: number;
  slot_increment_minutes: number;
  office_address: string;
  clerk_email: string;
  reception_email: string;
  disclaimer_text: string;
}

export default function SigningGeneralSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/admin/signing/settings");
      const json = await res.json();
      if (json.success) setSettings(json.data);
      setLoading(false);
    })();
  }, []);

  async function save() {
    if (!settings) return;
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/admin/signing/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const json = await res.json();
      if (!json.success) {
        alert(json.error || "Failed to save settings");
        return;
      }
      setSettings(json.data);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-sm text-base-content/60">Loading…</p>;
  if (!settings) return <p className="text-sm text-error">Could not load settings.</p>;

  return (
    <div className="space-y-4 max-w-xl">
      <h2 className="text-lg font-semibold">Signing appointments — general settings</h2>

      <div className="grid grid-cols-3 gap-3">
        <label className="form-control">
          <span className="label-text text-xs">Duration (min)</span>
          <input
            type="number"
            min={5}
            className="input input-bordered input-sm"
            value={settings.default_duration_minutes}
            onChange={(e) => setSettings({ ...settings, default_duration_minutes: Number(e.target.value) })}
          />
        </label>
        <label className="form-control">
          <span className="label-text text-xs">Buffer after (min)</span>
          <input
            type="number"
            min={0}
            className="input input-bordered input-sm"
            value={settings.buffer_minutes}
            onChange={(e) => setSettings({ ...settings, buffer_minutes: Number(e.target.value) })}
          />
        </label>
        <label className="form-control">
          <span className="label-text text-xs">Slot increment (min)</span>
          <input
            type="number"
            min={5}
            className="input input-bordered input-sm"
            value={settings.slot_increment_minutes}
            onChange={(e) => setSettings({ ...settings, slot_increment_minutes: Number(e.target.value) })}
          />
        </label>
      </div>

      <label className="form-control">
        <span className="label-text text-xs">Office address (in-person location)</span>
        <input
          className="input input-bordered input-sm"
          value={settings.office_address}
          onChange={(e) => setSettings({ ...settings, office_address: e.target.value })}
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="form-control">
          <span className="label-text text-xs">Clerk email (always CC&apos;d)</span>
          <input
            className="input input-bordered input-sm"
            value={settings.clerk_email}
            onChange={(e) => setSettings({ ...settings, clerk_email: e.target.value })}
          />
        </label>
        <label className="form-control">
          <span className="label-text text-xs">Reception email (always CC&apos;d)</span>
          <input
            className="input input-bordered input-sm"
            value={settings.reception_email}
            onChange={(e) => setSettings({ ...settings, reception_email: e.target.value })}
          />
        </label>
      </div>

      <label className="form-control">
        <span className="label-text text-xs">Disclaimer text (shown on booking page + in the calendar invite)</span>
        <textarea
          className="textarea textarea-bordered textarea-sm"
          rows={4}
          value={settings.disclaimer_text}
          onChange={(e) => setSettings({ ...settings, disclaimer_text: e.target.value })}
        />
      </label>

      <div className="flex items-center gap-3">
        <button className="btn btn-sm btn-primary gap-1" disabled={saving} onClick={save}>
          <Save className="w-3 h-3" /> Save
        </button>
        {saved && <span className="text-xs text-success">Saved.</span>}
      </div>
    </div>
  );
}
