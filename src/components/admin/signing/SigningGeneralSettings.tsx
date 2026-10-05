"use client";

import React, { useEffect, useState } from "react";
import { Save, Check } from "lucide-react";

interface Settings {
  default_duration_minutes: number;
  buffer_minutes: number;
  slot_increment_minutes: number;
  office_address: string;
  clerk_email: string;
  reception_email: string;
  disclaimer_text: string;
}

const inputClasses =
  "w-full px-4 py-2.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary bg-white";

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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-primary"></div>
      </div>
    );
  }
  if (!settings) {
    return <p className="text-sm text-red-600 py-6">Could not load settings.</p>;
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 space-y-5 max-w-2xl">
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="block text-xs font-semibold text-slate-500 mb-1.5">Duration (min)</label>
          <input
            type="number"
            min={5}
            className={inputClasses}
            value={settings.default_duration_minutes}
            onChange={(e) => setSettings({ ...settings, default_duration_minutes: Number(e.target.value) })}
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-500 mb-1.5">Buffer after (min)</label>
          <input
            type="number"
            min={0}
            className={inputClasses}
            value={settings.buffer_minutes}
            onChange={(e) => setSettings({ ...settings, buffer_minutes: Number(e.target.value) })}
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-500 mb-1.5">Slot increment (min)</label>
          <input
            type="number"
            min={5}
            className={inputClasses}
            value={settings.slot_increment_minutes}
            onChange={(e) => setSettings({ ...settings, slot_increment_minutes: Number(e.target.value) })}
          />
        </div>
      </div>

      <div>
        <label className="block text-xs font-semibold text-slate-500 mb-1.5">
          Office address (in-person location)
        </label>
        <input
          className={inputClasses}
          value={settings.office_address}
          onChange={(e) => setSettings({ ...settings, office_address: e.target.value })}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-semibold text-slate-500 mb-1.5">
            Clerk email (always CC&apos;d)
          </label>
          <input
            className={inputClasses}
            value={settings.clerk_email}
            onChange={(e) => setSettings({ ...settings, clerk_email: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-500 mb-1.5">
            Reception email (always CC&apos;d)
          </label>
          <input
            className={inputClasses}
            value={settings.reception_email}
            onChange={(e) => setSettings({ ...settings, reception_email: e.target.value })}
          />
        </div>
      </div>

      <div>
        <label className="block text-xs font-semibold text-slate-500 mb-1.5">
          Disclaimer text (shown on booking page + in the calendar invite)
        </label>
        <textarea
          className={inputClasses}
          rows={4}
          value={settings.disclaimer_text}
          onChange={(e) => setSettings({ ...settings, disclaimer_text: e.target.value })}
        />
      </div>

      <div className="flex items-center gap-3 pt-2">
        <button
          disabled={saving}
          onClick={save}
          className="px-4 py-2 rounded-lg bg-brand-primary text-white text-sm font-semibold hover:bg-brand-primaryHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          <Save size={16} /> Save
        </button>
        {saved && (
          <span className="text-xs font-semibold text-green-600 flex items-center gap-1">
            <Check size={14} /> Saved
          </span>
        )}
      </div>
    </div>
  );
}
