import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Deal, DealType, DealStatus } from '../types';
import { Search, Trash2, Users, AlertTriangle, Upload, ChevronDown, LogIn } from 'lucide-react';
import {
  isNonCitizenFlagged,
  NON_CITIZEN_FLAG_TOOLTIP,
} from '@/lib/isNonCitizenFlagged';
import { formatLocalDate, parseLocalDate } from '@/lib/formatDate';
import { computeDealDisplayStatus } from '@/lib/dealDisplayStatus';

interface DealListProps {
  onSelectDeal?: (dealId: string) => void;
}

// First letter of each whitespace-separated word, max 2 letters, uppercased.
// "Karthik Nathan" -> "KN", "Suganya" -> "S", "" -> "".
function getInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

// Today as a local "YYYY-MM-DD" string (not UTC, so it doesn't drift a day
// near midnight). Used to default the dashboard to upcoming closings.
function localTodayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const DealList: React.FC<DealListProps> = ({ onSelectDeal = () => { } }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState('All');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterLawyer, setFilterLawyer] = useState('');
  const [filterClerk, setFilterClerk] = useState('');
  // Default view shows upcoming closings: closing date from today onward
  // (open-ended end), so files that already closed are hidden until the admin
  // clears or changes the range.
  const [dateFrom, setDateFrom] = useState<string>(() => localTodayISO());
  const [dateTo, setDateTo] = useState('');
  const [showOnlyFlagged, setShowOnlyFlagged] = useState(false);
  // Hide test accounts — files whose client email is @navawilson.law (the
  // firm's test-domain convention) or whose client/file name contains "TEST".
  // Toggled by the "Hide test account" checkbox above the table.
  const [removeTestAccounts, setRemoveTestAccounts] = useState(false);
  // Deal id currently being logged into (client-view impersonation in flight),
  // so the row's button can show a disabled/loading state.
  const [impersonatingId, setImpersonatingId] = useState<string | null>(null);
  const [deals, setDeals] = useState<Deal[]>([]);
  // Closing-date column sort. null = no sort (API order), 'asc' = earliest
  // first, 'desc' = latest first. Clicking the header cycles asc → desc.
  // Defaults to 'asc' so the upcoming closings (the default filtered view)
  // surface soonest-first.
  const [closingSort, setClosingSort] = useState<'asc' | 'desc' | null>('asc');
  // Which file row has its pending-tasks panel expanded (one at a time). The
  // list API only returns the Steps count, not the task titles, so we lazy-fetch
  // the deal's tasks from /api/admin/tasks the first time a row is expanded and
  // cache them in pendingTasks keyed by deal id.
  const [expandedDealId, setExpandedDealId] = useState<string | null>(null);
  const [pendingTasks, setPendingTasks] = useState<
    Record<string, { loading: boolean; error: boolean; tasks: { id: string; title: string; status: string }[] }>
  >({});

  const togglePendingTasks = useCallback((dealId: string) => {
    setExpandedDealId((prev) => (prev === dealId ? null : dealId));
    // Fetch once per deal, then serve from cache on subsequent expands.
    setPendingTasks((prev) => {
      if (prev[dealId]) return prev;
      // Kick off the fetch (outside the state update is impossible here without
      // a ref, so we mark loading and fire the request in a microtask).
      fetch(`/api/admin/tasks?deal_id=${dealId}`)
        .then((res) => {
          if (!res.ok) throw new Error('Failed to load tasks');
          return res.json();
        })
        .then((data: any[]) => {
          // "Pending" = not Completed (matches the Steps count's open remainder).
          const pending = (data || [])
            .filter((t) => t?.status !== 'Completed')
            .map((t) => ({
              id: String(t.id),
              title: t.title?.trim() || 'Untitled task',
              status: t.status || 'Pending',
            }));
          setPendingTasks((p) => ({ ...p, [dealId]: { loading: false, error: false, tasks: pending } }));
        })
        .catch(() => {
          setPendingTasks((p) => ({ ...p, [dealId]: { loading: false, error: true, tasks: [] } }));
        });
      return { ...prev, [dealId]: { loading: true, error: false, tasks: [] } };
    });
  }, []);

  const fetchDeals = useCallback(() => {
    fetch('/api/admin/deals')
      .then(res => res.json())
      .then((data: any[]) => {
        const mapped: Deal[] = (data || []).map((d: any) => ({
          id: d.id,
          fileNumber: d.fileNumber ?? d.file_number ?? '',
          client: d.client ?? { id: '', firstName: '', lastName: d.client_last_name ?? '', email: d.lead_email ?? '', phone: '' },
          type: d.type,
          status: d.status,
          propertyAddress: d.propertyAddress ?? d.property_address ?? '',
          sellingPropertyAddress: d.sellingPropertyAddress ?? d.selling_property_address ?? '',
          closingDate: d.closingDate ?? d.closing_date ?? '',
          openingDate: d.openingDate ?? d.opening_date,
          requisitionDate: d.requisitionDate ?? d.requisition_date,
          price: d.price ?? 0,
          progress: d.progress ?? 0,
          completedTasks: d.completedTasks ?? 0,
          totalTasks: d.totalTasks ?? 0,
          tasks: d.tasks ?? [],
          milestones: d.milestones ?? [],
          documents: d.documents ?? [],
          notes: d.notes ?? [],
          authUserId: d.auth_user_id ?? null,
          isCoPurchaser: d.is_co_purchaser ?? false,
          hasCoPurchasers: d.has_co_purchasers ?? false,
          coPersonRole:
            d.co_person_role === "purchaser" || d.co_person_role === "seller"
              ? d.co_person_role
              : null,
          leadName: d.lead_name ?? '',
          coPartyNames: Array.isArray(d.co_party_names) ? d.co_party_names : [],
          accountCreatedAt: d.account_created_at ?? null,
          createdAt: d.created_at ?? null,
          leadCitizenshipStatus: d.lead_citizenship_status ?? null,
          fileName: d.file_name ?? '',
          lawyerName: d.lawyer_name ?? '',
          clerkName: d.clerk_name ?? '',
          purchasePropertyAddress: d.purchase_property_address ?? '',
          addressCity: d.lead_address_city ?? '',
          addressProvince: d.lead_address_province ?? '',
          addressPostalCode: d.lead_address_postal_code ?? '',
          sellingAddressCity: d.lead_selling_address_city ?? '',
          sellingAddressProvince: d.lead_selling_address_province ?? '',
          sellingAddressPostalCode: d.lead_selling_address_postal_code ?? '',
        } as Deal & {
          authUserId: string | null;
          isCoPurchaser: boolean;
          hasCoPurchasers: boolean;
          coPersonRole: "purchaser" | "seller" | null;
          leadName: string;
          coPartyNames: string[];
          accountCreatedAt: string | null;
          createdAt: string | null;
          leadCitizenshipStatus: string | null;
          fileName: string;
          lawyerName: string;
          clerkName: string;
          purchasePropertyAddress: string;
          addressCity: string;
          addressProvince: string;
          addressPostalCode: string;
          sellingAddressCity: string;
          sellingAddressProvince: string;
          sellingAddressPostalCode: string;
        }));
        setDeals(mapped);
      })
      .catch(() => setDeals([]));
  }, []);

  useEffect(() => {
    fetchDeals();
  }, [fetchDeals]);

  // Exclude co-purchaser deals from all counts and display
  const primaryDeals = deals.filter(d => !(d as any).isCoPurchaser);

  // Unique lawyer / clerk names taken directly from the deals data so the
  // filter dropdowns always reflect what the table actually contains.
  const lawyerOptions = Array.from(
    new Set(
      primaryDeals
        .map(d => ((d as any).lawyerName ?? '').trim())
        .filter((n: string) => n.length > 0),
    ),
  ).sort((a, b) => a.localeCompare(b));
  const clerkOptions = Array.from(
    new Set(
      primaryDeals
        .map(d => ((d as any).clerkName ?? '').trim())
        .filter((n: string) => n.length > 0),
    ),
  ).sort((a, b) => a.localeCompare(b));

  // Grand total of every primary file (ignores filters) — used as the "of N"
  // denominator so the admin can still see the full size of the dataset.
  const totalFiles = primaryDeals.length;

  const filteredDeals = primaryDeals.filter(deal => {

    if (searchTerm) {
      // Match every whitespace-separated term independently against the
      // haystack so "carlaw toronto on" still hits a row whose city/
      // province sit in separate columns. Single-term searches behave
      // the same as before.
      const d = deal as any;
      // Format a date both as raw ISO (so "2026-05" matches) and as a
      // human "May 2026" string (so "may 2026" matches). Empty in →
      // empty out.
      const formatDateForSearch = (val: any): string => {
        if (!val) return '';
        const s = String(val);
        const parsed = parseLocalDate(s) ?? new Date(s);
        if (Number.isNaN(parsed.getTime())) return s;
        const monthLong = parsed.toLocaleString('en-US', { month: 'long' });
        const monthShort = parsed.toLocaleString('en-US', { month: 'short' });
        const yr = parsed.getFullYear();
        const dy = parsed.getDate();
        return `${s} ${monthLong} ${monthShort} ${dy} ${yr}`;
      };
      // Price stored as number — also expose comma-formatted version so a
      // query of "500,000" matches even though the field is numeric.
      const priceNum = typeof deal.price === 'number' ? deal.price : Number(deal.price);
      const priceStr = Number.isFinite(priceNum) && priceNum > 0
        ? `${priceNum} ${priceNum.toLocaleString('en-US')} $${priceNum.toLocaleString('en-US')}`
        : '';
      const flagsStr = [
        d.isCoPurchaser ? 'co-purchaser co-seller co-client' : '',
        d.hasCoPurchasers ? 'has co-purchaser has co-seller has co-client' : '',
        isNonCitizenFlagged({ citizenship_status: d.leadCitizenshipStatus }) ? 'non-citizen flagged' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const haystack = [
        deal.fileNumber,
        deal.propertyAddress,
        deal.sellingPropertyAddress ?? '',
        deal.type,
        deal.status,
        d.fileName ?? '',
        d.lawyerName ?? '',
        d.clerkName ?? '',
        d.leadName ?? '',
        Array.isArray(d.coPartyNames) ? d.coPartyNames.join(' ') : '',
        d.purchasePropertyAddress ?? '',
        d.addressCity ?? '',
        d.addressProvince ?? '',
        d.addressPostalCode ?? '',
        d.sellingAddressCity ?? '',
        d.sellingAddressProvince ?? '',
        d.sellingAddressPostalCode ?? '',
        // Combined address strings so "123 Main, Toronto, ON" works as a
        // single query.
        [d.purchasePropertyAddress, d.addressCity, d.addressProvince, d.addressPostalCode]
          .filter(Boolean)
          .join(' '),
        [deal.sellingPropertyAddress, d.sellingAddressCity, d.sellingAddressProvince, d.sellingAddressPostalCode]
          .filter(Boolean)
          .join(' '),
        // Client (primary contact) details.
        deal.client?.firstName ?? '',
        deal.client?.lastName ?? '',
        deal.client && (deal.client.firstName || deal.client.lastName)
          ? `${deal.client.firstName ?? ''} ${deal.client.lastName ?? ''}`
          : '',
        deal.client?.email ?? '',
        deal.client?.phone ?? '',
        // Price (raw + comma-formatted + with $).
        priceStr,
        // Dates — raw ISO + month names so "may 2026" / "2026-05" both work.
        formatDateForSearch(deal.closingDate),
        formatDateForSearch(d.accountCreatedAt),
        formatDateForSearch(deal.openingDate),
        formatDateForSearch(deal.requisitionDate),
        // Family / flag labels so "co-purchaser", "co-seller", "flagged"
        // surface the rows that have those badges.
        flagsStr,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      // Split on commas, dots, semicolons, pipes, slashes, AND whitespace
      // so pasting "123 Main St, Toronto, ON" splits cleanly without
      // leaving a comma stuck to "Street," that would never match the
      // haystack (which stores fields without punctuation).
      const terms = searchTerm.toLowerCase().split(/[\s,.;|/]+/).filter(Boolean);
      if (!terms.every((t) => haystack.includes(t))) return false;
    }
    if (filterType && filterType !== 'All' && deal.type !== filterType) return false;
    if (filterStatus && filterStatus !== '' && deal.status !== filterStatus) return false;
    if (filterLawyer && ((deal as any).lawyerName ?? '').trim() !== filterLawyer) return false;
    if (filterClerk && ((deal as any).clerkName ?? '').trim() !== filterClerk) return false;
    if (showOnlyFlagged && !isNonCitizenFlagged({ citizenship_status: (deal as any).leadCitizenshipStatus })) return false;
    if (removeTestAccounts) {
      // Treat a file as a "test account" when the client email uses the firm's
      // test domain (@navawilson.law — the going-forward convention) OR "TEST"
      // appears in any name-ish field (lead/client name or file name), which
      // catches older test files created before the domain convention.
      const d = deal as any;
      const email = (deal.client?.email ?? '').trim().toLowerCase();
      if (email.endsWith('@navawilson.law')) return false;
      const nameHay = [
        d.leadName ?? '',
        deal.client?.firstName ?? '',
        deal.client?.lastName ?? '',
        d.fileName ?? '',
      ]
        .join(' ')
        .toUpperCase();
      if (nameHay.includes('TEST')) return false;
    }
    if (dateFrom || dateTo) {
      const closing = parseLocalDate(deal.closingDate);
      if (!closing) return false;
      closing.setHours(0, 0, 0, 0);
      if (dateFrom) { const from = parseLocalDate(dateFrom); if (!from) return false; from.setHours(0, 0, 0, 0); if (closing < from) return false; }
      if (dateTo) { const to = parseLocalDate(dateTo); if (!to) return false; to.setHours(23, 59, 59, 999); if (closing > to) return false; }
    }
    return true;
  });

  // Header summary counts reflect the CURRENTLY FILTERED set (not the whole
  // dataset) so the pills always agree with the rows actually listed below —
  // e.g. with the default "from today" closing-date filter the totals show the
  // upcoming files, not every file ever created.
  const visibleCount = filteredDeals.length;
  const countS = filteredDeals.filter(d => d.type === DealType.SALE).length;
  const countP = filteredDeals.filter(d => d.type === DealType.PURCHASE).length;
  const countR = filteredDeals.filter(d => d.type === DealType.REFINANCE).length;
  const countPS = filteredDeals.filter(d => d.type === DealType.PURCHASE_AND_SALE).length;

  // Apply the closing-date sort on top of the filtered list. Rows without a
  // valid closing date always sink to the bottom (regardless of direction) so
  // the dated rows stay grouped and ordered. When no sort is active the
  // original API order is preserved.
  const sortedDeals = closingSort
    ? [...filteredDeals].sort((a, b) => {
        const da = parseLocalDate(a.closingDate)?.getTime() ?? NaN;
        const db = parseLocalDate(b.closingDate)?.getTime() ?? NaN;
        const aMissing = Number.isNaN(da);
        const bMissing = Number.isNaN(db);
        if (aMissing && bMissing) return 0;
        if (aMissing) return 1;
        if (bMissing) return -1;
        return closingSort === 'asc' ? da - db : db - da;
      })
    // No closing-date sort active → order by deal creation, newest first, so a
    // just-created file always surfaces at the top of the list. Rows without a
    // creation timestamp sink to the bottom.
    : [...filteredDeals].sort((a, b) => {
        const da = Date.parse((a as any).createdAt ?? '');
        const db = Date.parse((b as any).createdAt ?? '');
        const aMissing = Number.isNaN(da);
        const bMissing = Number.isNaN(db);
        if (aMissing && bMissing) return 0;
        if (aMissing) return 1;
        if (bMissing) return -1;
        return db - da;
      });

  // Header click always activates a closing-date sort (cycling soonest ↔
  // latest). The "Recently created" button below clears it (closingSort=null),
  // which falls back to the newest-created ordering above.
  const toggleClosingSort = () =>
    setClosingSort((prev) => (prev === 'asc' ? 'desc' : 'asc'));

  const applyPreset = (preset: 'today' | 'week' | 'nextWeek' | 'month') => {
    const now = new Date();
    const toISO = (d: Date) => d.toISOString().split('T')[0];
    if (preset === 'today') {
      setDateFrom(toISO(now));
      setDateTo(toISO(now));
    } else if (preset === 'week') {
      const start = new Date(now);
      start.setDate(now.getDate() - now.getDay());
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      setDateFrom(toISO(start));
      setDateTo(toISO(end));
    } else if (preset === 'nextWeek') {
      const start = new Date(now);
      start.setDate(now.getDate() - now.getDay() + 7);
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      setDateFrom(toISO(start));
      setDateTo(toISO(end));
    } else if (preset === 'month') {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      setDateFrom(toISO(start));
      setDateTo(toISO(end));
    }
  };

  const formatDate = (dateString?: string) => formatLocalDate(dateString);


  // Open the client portal as this deal's client (admin impersonation). Reuses
  // /api/admin/impersonate, which resolves the auth user to a Supabase magic
  // link and never emails the client. Only works once the client has signed
  // into the portal (same gate as the derived "Active" status), so it's
  // gated on accountCreatedAt + authUserId.
  const handleLoginAsClient = async (deal: Deal) => {
    const d = deal as any;
    if (!d.accountCreatedAt || !d.authUserId) {
      alert("This client has not signed into the portal yet — cannot log into their view.");
      return;
    }
    setImpersonatingId(deal.id);
    try {
      const res = await fetch("/api/admin/impersonate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authUserId: d.authUserId }),
      });
      const json = await res.json();
      if (!res.ok || !json.url) throw new Error(json.error || "Failed to generate link");
      window.open(json.url, "_blank", "noopener,noreferrer");
    } catch (err: any) {
      console.error("Login as client error:", err);
      alert(`Failed to log into client view: ${err?.message ?? "unknown error"}`);
    } finally {
      setImpersonatingId(null);
    }
  };

  const handleDelete = async (dealId: string) => {
    const confirmDelete = window.confirm("Are you sure you want to delete this deal?");
    if (!confirmDelete) return;

    try {
      const res = await fetch(`/api/admin/deals/${dealId}`, {
        method: "DELETE",
      });

      if (!res.ok) throw new Error("Delete failed");

      // remove from UI
      setDeals((prev) => prev.filter((d) => d.id !== dealId));
    } catch (err) {
      console.error("Delete error:", err);
      alert("Failed to delete deal");
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border border-slate-200">
      <div className="flex flex-col xl:flex-row items-start xl:items-center justify-between p-4 sm:p-6 pb-2 gap-4">
        <div className="flex flex-wrap items-center gap-3 sm:gap-4">
          <h1 className="text-lg sm:text-xl font-bold text-slate-900 border-b-2 border-brand-primary pb-0.5">All files</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-slate-500">Total: <span className="font-bold text-slate-900">{visibleCount}</span></span>
            <span className="px-2 py-0.5 rounded-md text-xs font-bold bg-orange-100 text-orange-600" title="Sales">S {countS}</span>
            <span className="px-2 py-0.5 rounded-md text-xs font-bold bg-blue-100 text-blue-600" title="Purchases">P {countP}</span>
            <span className="px-2 py-0.5 rounded-md text-xs font-bold bg-purple-100 text-purple-600" title="Purchase &amp; Sale">PS {countPS}</span>
            <span className="px-2 py-0.5 rounded-md text-xs font-bold bg-slate-900 text-white" title="Refinances">R {countR}</span>
          </div>
        </div>

        <div className="flex flex-1 w-full xl:w-auto items-center gap-2 justify-end">
          {/* <label
            className={`h-9 flex items-center gap-1.5 px-3 rounded text-xs font-bold uppercase tracking-wide cursor-pointer border transition-colors select-none whitespace-nowrap ${
              showOnlyFlagged
                ? 'bg-red-50 border-red-200 text-red-700'
                : 'bg-white border-slate-300 text-slate-600 hover:border-red-200 hover:text-red-700'
            }`}
            title="Show only clients flagged as Non-Citizen / Unsure"
          >
            <input
              type="checkbox"
              className="sr-only"
              checked={showOnlyFlagged}
              onChange={(e) => setShowOnlyFlagged(e.target.checked)}
            />
            <AlertTriangle size={12} />
            Only Flagged
          </label> */}
          <div className="relative flex-1 xl:flex-none xl:w-72">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              type="text"
              placeholder="Search by file #, client, address, lawyer"
              className="w-full h-9 pl-8 pr-3 border border-slate-300 rounded text-sm focus:outline-none focus:border-brand-primary"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <Link
            href="/admin/bulk-import"
            className="h-9 flex items-center gap-1.5 px-3 rounded text-xs font-bold uppercase tracking-wide bg-brand-primary text-white hover:bg-brand-primaryHover transition-colors whitespace-nowrap shadow-sm"
            title="Import deals from a CSV file"
          >
            <Upload size={12} />
            Bulk Import
          </Link>
        </div>
      </div>

      <div className="px-4 sm:px-6 pb-4 sm:pb-6 pt-2 space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b border-slate-100 pb-4">
          <div>
            <label className="block text-xs text-slate-500 mb-1">Closing date</label>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
                min="1900-01-01"
                max="2100-12-31"
                className="h-9 border border-slate-300 rounded px-2 text-xs text-slate-700 focus:border-brand-primary outline-none cursor-pointer"
              />
              <span className="text-slate-400">–</span>
              <input
                type="date"
                value={dateTo}
                onChange={e => setDateTo(e.target.value)}
                min="1900-01-01"
                max="2100-12-31"
                className="h-9 border border-slate-300 rounded px-2 text-xs text-slate-700 focus:border-brand-primary outline-none cursor-pointer"
              />
              {(dateFrom || dateTo) && (
                <button
                  onClick={() => { setDateFrom(''); setDateTo(''); }}
                  className="h-9 px-2 text-xs text-slate-400 hover:text-red-500 transition-colors cursor-pointer"
                >
                  ✕ Clear
                </button>
              )}
            </div>
          </div>
          <div className="h-9 flex items-center gap-5">
            <button onClick={() => applyPreset('today')} className="text-sm font-medium text-slate-600 hover:text-brand-primary transition-colors cursor-pointer">Today</button>
            <button onClick={() => applyPreset('week')} className="text-sm font-medium text-slate-600 hover:text-brand-primary transition-colors cursor-pointer">This week</button>
            <button onClick={() => applyPreset('nextWeek')} className="text-sm font-medium text-slate-600 hover:text-brand-primary transition-colors cursor-pointer">Next week</button>
            <button onClick={() => applyPreset('month')} className="text-sm font-medium text-slate-600 hover:text-brand-primary transition-colors cursor-pointer">This month</button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <label className="block text-xs text-slate-500 mb-1">File type</label>
            <select
              value={filterType}
              onChange={e => setFilterType(e.target.value)}
              className="w-full h-8 border border-slate-300 rounded px-2 text-xs text-slate-700 focus:border-brand-primary outline-none bg-white cursor-pointer"
            >
              <option value="All">All</option>
              <option value="Purchase">Purchase</option>
              <option value="Sale">Sale</option>
              <option value="Purchase &amp; Sale">Purchase &amp; Sale</option>
              <option value="Refinance">Refinance</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Lawyer</label>
            <select
              value={filterLawyer}
              onChange={e => setFilterLawyer(e.target.value)}
              className="w-full h-8 border border-slate-300 rounded px-2 text-xs text-slate-700 focus:border-brand-primary outline-none bg-white cursor-pointer"
            >
              <option value="">Choose a lawyer</option>
              {lawyerOptions.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
              {/* Preserve a legacy/stale selection if the deal it came from is
                  no longer in the current list, so the filter doesn't silently
                  reset to "Choose a lawyer". */}
              {filterLawyer && !lawyerOptions.includes(filterLawyer) && (
                <option value={filterLawyer}>{filterLawyer}</option>
              )}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Clerk</label>
            <select
              value={filterClerk}
              onChange={e => setFilterClerk(e.target.value)}
              className="w-full h-8 border border-slate-300 rounded px-2 text-xs text-slate-700 focus:border-brand-primary outline-none bg-white cursor-pointer"
            >
              <option value="">Choose a clerk</option>
              {clerkOptions.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
              {filterClerk && !clerkOptions.includes(filterClerk) && (
                <option value={filterClerk}>{filterClerk}</option>
              )}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Account status</label>
            <select
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
              className="w-full h-8 border border-slate-300 rounded px-2 text-xs text-slate-700 focus:border-brand-primary outline-none bg-white cursor-pointer"
            >
              <option value="">Choose a status</option>
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
              <option value="Closed">Closed</option>
            </select>
          </div>
        </div>
      </div>

      <div className="px-4 sm:px-6 pb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-center gap-3">
          <span className="text-sm text-slate-600">
            Showing <span className="font-bold text-slate-900">{sortedDeals.length}</span> of {totalFiles} files
          </span>
          {/* Quick sort: clears the closing-date sort so the list falls back to
              newest-created-first, making a just-created file easy to find. */}
          <span className="hidden sm:inline text-slate-300">|</span>
          <span className="hidden sm:inline text-xs text-slate-400">Sort:</span>
          <div className="inline-flex items-center rounded-md border border-slate-200 overflow-hidden text-xs">
            <button
              type="button"
              onClick={() => setClosingSort('asc')}
              className={`px-2.5 py-1 font-medium transition-colors ${
                closingSort
                  ? 'bg-brand-primary text-white'
                  : 'bg-white text-slate-600 hover:bg-slate-50'
              }`}
              title="Sort by closing date"
            >
              Closing date
            </button>
            <button
              type="button"
              onClick={() => setClosingSort(null)}
              className={`px-2.5 py-1 font-medium border-l border-slate-200 transition-colors ${
                closingSort
                  ? 'bg-white text-slate-600 hover:bg-slate-50'
                  : 'bg-brand-primary text-white'
              }`}
              title="Show the most recently created files first"
            >
              Recently created
            </button>
          </div>
        </div>
        {/* "Hide test account" toggle — hides files on the firm's test domain
            (@navawilson.law) or with "TEST" in the name. Independent of the
            other filters, so ticking it never resets them and vice versa. */}
        <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={removeTestAccounts}
            onChange={(e) => setRemoveTestAccounts(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-brand-primary focus:ring-brand-primary cursor-pointer"
          />
          Hide test account
        </label>
      </div>

      <div className="overflow-x-auto">
        {/* Responsive table (priority: responsiveness at every width):
            - table-fixed + the colgroup percentages below keep the columns
              proportional and perfectly aligned at any browser zoom.
            - xl and up (large laptops / desktops): no min-width, so w-full makes
              the table fit the content area exactly and ALL columns show in a
              single view without horizontal scroll — even with the sidebar open.
            - below xl (small laptops, tablets): min-w-[1080px] keeps the 11
              columns readable instead of crushing them to fit; this parent's
              overflow-x-auto scrolls horizontally and the sticky Actions column
              stays pinned. We intentionally do NOT force single-view here. */}
        <table className="w-full min-w-[1080px] xl:min-w-0 table-fixed text-left border-t border-slate-200">
          {/* colgroup is the single source of truth for column widths. With
              table-fixed, the header and every body row inherit these exact
              percentages, so columns stay perfectly aligned at any browser
              zoom. The two hidden columns get 0% (their cells are display:none,
              so the column collapses). Visible widths sum to 100%. */}
          <colgroup>
            <col style={{ width: '4%' }} />{/* Row number */}
            <col style={{ width: '9%' }} />{/* Account status */}
            <col style={{ width: '8%' }} />{/* File No. */}
            <col style={{ width: '14%' }} />{/* Client Name */}
            <col style={{ width: '15%' }} />{/* Address */}
            <col style={{ width: '9%' }} />{/* Closing date */}
            <col style={{ width: '13%' }} />{/* Progress */}
            <col style={{ width: '6%' }} />{/* Lawyer */}
            <col style={{ width: '6%' }} />{/* Clerk */}
            <col style={{ width: '9%' }} />{/* Account created */}
            <col style={{ width: '0%' }} />{/* Requisition date (hidden) */}
            <col style={{ width: '0%' }} />{/* File name (hidden) */}
            <col style={{ width: '7%' }} />{/* Actions */}
          </colgroup>
          <thead>
            <tr className="bg-white text-slate-800 text-xs font-bold border-b border-slate-200">
              {/* Row number — no heading text per request. */}
              <th className="px-2 py-1.5" aria-label="Row number"></th>
              <th className="px-2 py-1.5">Account status</th>
              <th className="px-2 py-1.5">File No.</th>
              <th className="px-2 py-1.5">Client Name</th>
              <th className="px-2 py-1.5">Address</th>
              <th className="px-2 py-1.5">
                <button
                  type="button"
                  onClick={toggleClosingSort}
                  className="flex items-center gap-1 font-bold hover:text-brand-primary transition-colors"
                  title="Sort by closing date"
                >
                  Closing date
                  <span className="text-[10px] leading-none text-slate-400">
                    {closingSort === 'asc' ? '▲' : closingSort === 'desc' ? '▼' : '↕'}
                  </span>
                </button>
              </th>
              <th className="px-2 py-1.5">Progress</th>
              <th className="px-2 py-1.5">Lawyer</th>
              <th className="px-2 py-1.5">Clerk</th>
              <th className="px-2 py-1.5">Account created</th>
              {/* Requisition date column hidden per request — kept (not deleted) to avoid breaking anything. */}
              <th className="px-2 py-1.5 hidden">Requisition date</th>
              {/* File name column hidden per request — kept (not deleted) to avoid breaking anything. */}
              <th className="px-2 py-1.5 hidden">File name</th>
              <th className="sticky right-0 z-20 bg-white px-2 py-1.5 text-center">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedDeals.length > 0 ? sortedDeals.map((deal, index) => {
              // 1-based row number across the full (unpaginated) list.
              const rowNumber = index + 1;
              const isEven = index % 2 === 0;
              const rowClass = isEven ? 'bg-white' : 'bg-slate-50/80';
              // Solid background for the sticky Actions cell — the row's
              // slate-50/80 is semi-transparent, which would let scrolled
              // content bleed through a sticky cell, so use an opaque match.
              const stickyBg = isEven ? 'bg-white' : 'bg-slate-50';
              const isCombined = deal.type === DealType.PURCHASE_AND_SALE;
              return (
                <React.Fragment key={deal.id}>
                <tr onClick={() => {
                  console.log("Clicked deal id:", deal.id);
                  onSelectDeal(deal.id);
                }} className={`${rowClass} hover:bg-brand-light/20 cursor-pointer transition-colors border-b border-slate-100 text-xs text-slate-700 whitespace-nowrap`}>
                  <td className="px-2 py-1.5">{rowNumber}</td>
                  <td className="px-2 py-1.5">
                    {/* Active/Inactive is derived (not the raw DB status) —
                        "Active" = the linked client has signed into the portal
                        at least once. Shared with the Edit Deal modal via
                        computeDealDisplayStatus so the two never drift. */}
                    {(() => {
                      const displayStatus = computeDealDisplayStatus({
                        status: deal.status,
                        account_created_at: (deal as any).accountCreatedAt,
                      });
                      if (displayStatus === DealStatus.CLOSED) {
                        return (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-700 border border-green-200 shadow-sm">
                            <span className="mr-1">✓</span> Closed
                          </span>
                        );
                      }
                      if (displayStatus === DealStatus.ACTIVE) {
                        return (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-white text-green-600 border border-green-400">
                            Active
                          </span>
                        );
                      }
                      return (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-500 border border-slate-200">
                          Inactive
                        </span>
                      );
                    })()}
                  </td>
                  <td className="px-2 py-1.5 font-medium">{deal.fileNumber}</td>
                  <td className="px-2 py-1.5">
                    {/* min-w-0 + truncate lets a long name ellipsize instead of
                        spilling past this fixed-width column, while the badges
                        stay pinned (flex-shrink-0) and always visible. */}
                    <div className="flex items-center min-w-0">
                    {(deal as any).leadName ? (
                      <span
                        className="text-xs font-medium text-slate-700 truncate min-w-0"
                        title={(deal as any).leadName}
                      >
                        {(deal as any).leadName}
                      </span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                    {/* Co-purchaser / co-seller / non-citizen flag badges — moved
                        here from the now-hidden File name column. */}
                    {(deal as any).isCoPurchaser && (() => {
                      // Prefer the explicit co_person_role recorded at
                      // intake. Fall back to the deal type only when
                      // no role is set (legacy data) — that fallback
                      // can't distinguish on Purchase & Sale parents.
                      const explicit = (deal as any).coPersonRole as "purchaser" | "seller" | null | undefined;
                      const t = (deal.type ?? "").toLowerCase();
                      const tooltip = explicit === "seller"
                        ? "Co-Seller"
                        : explicit === "purchaser"
                        ? "Co-Purchaser"
                        : t === "sale"
                        ? "Co-Seller"
                        : t === "purchase"
                        ? "Co-Purchaser"
                        : "Co-Client";
                      const color = tooltip === "Co-Seller"
                        ? "text-orange-600"
                        : tooltip === "Co-Purchaser"
                        ? "text-blue-600"
                        : "text-purple-600";
                      return (
                        <span className={`ml-2 inline-flex items-center flex-shrink-0 ${color}`} title={tooltip}>
                          <Users size={14} />
                        </span>
                      );
                    })()}
                    {(deal as any).hasCoPurchasers && (() => {
                      const t = (deal.type ?? "").toLowerCase();
                      const tooltip =
                        t.includes("purchase") && t.includes("sale")
                          ? "Has Co-Client(s)"
                          : t === "sale"
                          ? "Has Co-Seller(s)"
                          : "Has Co-Purchaser(s)";
                      return (
                        <span className="ml-2 inline-flex items-center flex-shrink-0 text-green-600" title={tooltip}>
                          <Users size={14} />
                        </span>
                      );
                    })()}
                    {isNonCitizenFlagged({ citizenship_status: (deal as any).leadCitizenshipStatus }) && (
                      <span
                        className="ml-2 inline-flex items-center flex-shrink-0 text-red-600"
                        title={NON_CITIZEN_FLAG_TOOLTIP}
                      >
                        <AlertTriangle size={12} />
                      </span>
                    )}
                    </div>
                  </td>
                  <td className="px-2 py-1.5 overflow-hidden" title={isCombined ? `Purchase: ${deal.propertyAddress || "—"}\nSale: ${deal.sellingPropertyAddress || "—"}` : deal.propertyAddress}>
                    {isCombined ? (
                      <div className="flex flex-col gap-1">
                        <div className="flex items-baseline gap-2">
                          <span className="text-[9px] font-black text-blue-600 uppercase tracking-widest w-14 flex-shrink-0">Purchase</span>
                          <span className="truncate text-slate-700">{deal.propertyAddress || "—"}</span>
                        </div>
                        <div className="h-px bg-slate-100" />
                        <div className="flex items-baseline gap-2">
                          <span className="text-[9px] font-black text-orange-600 uppercase tracking-widest w-14 flex-shrink-0">Sale</span>
                          <span className="truncate text-slate-700">{deal.sellingPropertyAddress || "—"}</span>
                        </div>
                      </div>
                    ) : (
                      <span className="truncate block">{deal.propertyAddress}</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">{formatDate(deal.closingDate)}</td>
                  <td className="px-2 py-1.5">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        togglePendingTasks(deal.id);
                      }}
                      className="group/steps flex items-center gap-1.5 cursor-pointer min-w-0"
                      title="Show pending tasks for this file"
                    >
                      <div className="w-14 h-1.5 bg-slate-200 rounded-full overflow-hidden flex-shrink-0">
                        <div
                          className="h-full bg-red-500 rounded-full transition-all"
                          style={{ width: `${deal.totalTasks ? (deal.completedTasks! / deal.totalTasks) * 100 : 0}%` }}
                        />
                      </div>
                      <span className="text-[11px] text-slate-500 font-medium group-hover/steps:text-brand-primary transition-colors flex-shrink-0">{deal.completedTasks ?? 0}/{deal.totalTasks ?? 0}</span>
                      <ChevronDown
                        size={12}
                        className={`text-slate-400 group-hover/steps:text-brand-primary transition-all flex-shrink-0 ${expandedDealId === deal.id ? 'rotate-180' : ''}`}
                      />
                    </button>
                  </td>
                  <td className="px-2 py-1.5">
                    {(deal as any).lawyerName ? (
                      <span
                        className="bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded text-[10px] font-bold border border-blue-100"
                        title={(deal as any).lawyerName}
                      >
                        {getInitials((deal as any).lawyerName)}
                      </span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    {(deal as any).clerkName ? (
                      <span
                        className="bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded text-[10px] font-bold border border-blue-100"
                        title={(deal as any).clerkName}
                      >
                        {getInitials((deal as any).clerkName)}
                      </span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    {(deal as any).accountCreatedAt ? (
                      <span
                        className="text-xs text-slate-700"
                        title={new Date((deal as any).accountCreatedAt).toLocaleString()}
                      >
                        {formatDate((deal as any).accountCreatedAt)}
                      </span>
                    ) : (
                      <span className="text-slate-300" title="Client has not signed up yet">—</span>
                    )}
                  </td>
                  {/* Requisition date column hidden per request — kept (not deleted). */}
                  <td className="px-2 py-1.5 hidden">{formatDate(deal.requisitionDate)}</td>
                  {/* File name column hidden per request — kept (not deleted). */}
                  <td className="px-2 py-1.5 hidden">
                    {(deal as any).fileName || deal.propertyAddress}
                  </td>
                  <td className={`sticky right-0 z-10 ${stickyBg} px-2 py-1.5 text-center`}>
                    <div className="inline-flex items-center justify-center gap-1">
                      {(() => {
                        const canImpersonate = !!(deal as any).accountCreatedAt && !!(deal as any).authUserId;
                        const busy = impersonatingId === deal.id;
                        return (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleLoginAsClient(deal);
                            }}
                            disabled={!canImpersonate || busy}
                            className={`transition-colors p-1 ${
                              canImpersonate && !busy
                                ? 'text-slate-400 hover:text-brand-primary cursor-pointer'
                                : 'text-slate-200 cursor-not-allowed'
                            }`}
                            title={
                              canImpersonate
                                ? 'Log into client view'
                                : 'Client has not signed into the portal yet'
                            }
                          >
                            <LogIn size={14} />
                          </button>
                        );
                      })()}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(deal.id);
                        }}
                        className="text-slate-300 hover:text-red-500 transition-colors p-1 cursor-pointer"
                        title="Delete deal"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
                {expandedDealId === deal.id && (
                  <tr className="bg-brand-light/10 border-b border-slate-100">
                    <td colSpan={13} className="px-2 py-1.5">
                      {(() => {
                        const entry = pendingTasks[deal.id];
                        if (!entry || entry.loading) {
                          return <span className="text-xs text-slate-400">Loading pending tasks…</span>;
                        }
                        if (entry.error) {
                          return <span className="text-xs text-red-500">Failed to load pending tasks.</span>;
                        }
                        if (entry.tasks.length === 0) {
                          return <span className="text-xs text-green-600 font-medium">✓ No pending tasks — all steps completed.</span>;
                        }
                        return (
                          <div className="flex flex-col gap-2">
                            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                              {entry.tasks.length} pending task{entry.tasks.length > 1 ? 's' : ''} for {deal.fileNumber || 'this file'}
                            </span>
                            <div className="flex flex-wrap gap-1.5">
                              {entry.tasks.map((t) => (
                                <span
                                  key={t.id}
                                  className="inline-flex items-center gap-1.5 bg-white border border-slate-200 rounded-full px-2.5 py-1 text-[11px] text-slate-700"
                                  title={t.status}
                                >
                                  <span className="w-1.5 h-1.5 rounded-full bg-slate-300" />
                                  {t.title}
                                </span>
                              ))}
                            </div>
                          </div>
                        );
                      })()}
                    </td>
                  </tr>
                )}
                </React.Fragment>
              );
            }) : (
              <tr><td colSpan={13} className="px-6 py-12 text-center text-slate-500"><p>No files found.</p></td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Total count — pagination removed; the full list renders in one scrollable view. */}
      {sortedDeals.length > 0 && (
        <div className="flex items-center justify-end px-4 sm:px-6 py-3 border-t border-slate-200">
          <span className="text-xs text-slate-500">
            Showing all <span className="font-bold text-slate-900">{sortedDeals.length}</span> file{sortedDeals.length === 1 ? '' : 's'}
          </span>
        </div>
      )}
    </div>
  );
};

export default DealList;
