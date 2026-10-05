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
  const [statusFilter, setStatusFilter] = useState<"confirmed" | "cancelled" | "all">("confirmed");
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <CalendarClock className="w-5 h-5 text-base-content/60" /> Appointments
        </h2>
        <div className="join">
          {(["confirmed", "cancelled", "all"] as const).map((s) => (
            <button
              key={s}
              className={`btn btn-sm join-item ${statusFilter === s ? "btn-active" : ""}`}
              onClick={() => setStatusFilter(s)}
            >
              {s[0].toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-base-content/60">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>When</th>
                <th>Lawyer</th>
                <th>Client</th>
                <th>Property</th>
                <th>Type</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {appointments.map((a) => (
                <tr key={a.id}>
                  <td className="whitespace-nowrap">{formatDateTime(a.start_at)}</td>
                  <td className="font-mono">{a.lawyer?.initials ?? "—"}</td>
                  <td>
                    <div>{a.client_name}</div>
                    <div className="text-xs text-base-content/60">{a.client_email}</div>
                    {a.client_phone && (
                      <div className="text-xs text-base-content/60">{a.client_phone}</div>
                    )}
                  </td>
                  <td>
                    <div>{a.property_address || "—"}</div>
                    {a.file_number && (
                      <div className="text-xs text-base-content/60">File: {a.file_number}</div>
                    )}
                  </td>
                  <td>
                    <div>{APPT_TYPE_LABEL[a.appointment_type] ?? a.appointment_type}</div>
                    {a.deal_type && (
                      <div className="text-xs text-base-content/60">{DEAL_TYPE_LABEL[a.deal_type]}</div>
                    )}
                  </td>
                  <td>
                    <span
                      className={`badge badge-sm ${a.status === "confirmed" ? "badge-success" : "badge-ghost"}`}
                    >
                      {a.status === "confirmed" ? "Confirmed" : "Cancelled"}
                    </span>
                  </td>
                  <td>
                    {a.status === "confirmed" && (
                      <button
                        className="btn btn-xs btn-ghost text-error"
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
                  <td colSpan={7} className="text-center text-base-content/50 py-6">
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
