"use client";

import React, { useEffect, useState } from "react";
import { CalendarClock, Loader2, X } from "lucide-react";

interface Appointment {
  id: string;
  status: "confirmed" | "cancelled";
  start_at: string;
  end_at: string;
  appointment_type: "virtual" | "in_person";
  deal_type: "purchase" | "sale" | null;
  client_name: string;
  client_email: string;
  client_phone: string | null;
  property_address: string | null;
  closing_date: string | null;
  file_number: string | null;
  google_meet_link: string | null;
  lawyer: { id: string; initials: string; full_name: string } | null;
}

const DEAL_TYPE_LABEL: Record<string, string> = { purchase: "Purchase", sale: "Sale" };
const APPT_TYPE_LABEL: Record<string, string> = { virtual: "Virtual", in_person: "In Person" };

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Toronto",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function SigningAppointmentsList() {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<"confirmed" | "cancelled" | "all">("all");
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  async function load(status: "confirmed" | "cancelled" | "all") {
    setLoading(true);
    try {
      const qs = status === "all" ? "" : `?status=${status}`;
      const res = await fetch(`/api/admin/signing/appointments${qs}`);
      const json = await res.json();
      if (json.success) setAppointments(json.data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(statusFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  async function cancel(appt: Appointment) {
    if (!confirm(`Cancel the appointment with ${appt.client_name} on ${formatDateTime(appt.start_at)}?`)) return;
    setCancellingId(appt.id);
    try {
      const res = await fetch(`/api/admin/signing/appointments/${appt.id}/cancel`, { method: "POST" });
      const json = await res.json();
      if (!json.success) {
        alert(json.error || "Failed to cancel appointment");
        return;
      }
      await load(statusFilter);
    } finally {
      setCancellingId(null);
    }
  }

  const TABS = [
    { id: "all", label: "All" },
    { id: "confirmed", label: "Confirmed" },
    { id: "cancelled", label: "Cancelled" },
  ] as const;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold flex items-center gap-2 text-slate-900">
          <CalendarClock className="w-5 h-5 text-slate-400" /> Appointments
        </h2>
        <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl w-fit">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setStatusFilter(t.id)}
              className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-all ${
                statusFilter === t.id
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-slate-500 py-6">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </p>
      ) : (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200">
                <th className="px-4 py-3 font-semibold text-slate-500">When</th>
                <th className="px-4 py-3 font-semibold text-slate-500">Lawyer</th>
                <th className="px-4 py-3 font-semibold text-slate-500">Client</th>
                <th className="px-4 py-3 font-semibold text-slate-500">Property</th>
                <th className="px-4 py-3 font-semibold text-slate-500">Type</th>
                <th className="px-4 py-3 font-semibold text-slate-500">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {appointments.map((a) => (
                <tr key={a.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3 whitespace-nowrap text-slate-900">{formatDateTime(a.start_at)}</td>
                  <td className="px-4 py-3 font-mono text-slate-700">{a.lawyer?.initials ?? "—"}</td>
                  <td className="px-4 py-3">
                    <div className="text-slate-900 font-medium">{a.client_name}</div>
                    <div className="text-xs text-slate-500">{a.client_email}</div>
                    {a.client_phone && (
                      <div className="text-xs text-slate-500">{a.client_phone}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-slate-900">{a.property_address || "—"}</div>
                    {a.file_number && (
                      <div className="text-xs text-slate-500">File: {a.file_number}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-slate-900">{APPT_TYPE_LABEL[a.appointment_type] ?? a.appointment_type}</div>
                    {a.deal_type && (
                      <div className="text-xs text-slate-500">{DEAL_TYPE_LABEL[a.deal_type]}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                        a.status === "confirmed"
                          ? "bg-green-100 text-green-700 border-green-200"
                          : "bg-slate-100 text-slate-500 border-slate-200"
                      }`}
                    >
                      {a.status === "confirmed" ? "Confirmed" : "Cancelled"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {a.status === "confirmed" && (
                      <button
                        className="inline-flex items-center gap-1 text-xs font-semibold text-red-600 hover:text-red-700 disabled:opacity-50"
                        disabled={cancellingId === a.id}
                        onClick={() => cancel(a)}
                      >
                        <X className="w-3 h-3" /> Cancel
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {appointments.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center text-slate-400 py-6">
                    No appointments yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
