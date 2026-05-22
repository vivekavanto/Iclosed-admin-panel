import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Deal, DealType, DealStatus } from '../types';
import { Search, Trash2, Users, AlertTriangle, Upload, Pencil } from 'lucide-react';
import {
  isNonCitizenFlagged,
  NON_CITIZEN_FLAG_TOOLTIP,
} from '@/lib/isNonCitizenFlagged';
import { formatLocalDate, parseLocalDate } from '@/lib/formatDate';
import EditDealModal from './EditDealModal';

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

const DealList: React.FC<DealListProps> = ({ onSelectDeal = () => { } }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState('All');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterLawyer, setFilterLawyer] = useState('');
  const [filterClerk, setFilterClerk] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [showOnlyFlagged, setShowOnlyFlagged] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [editingDealId, setEditingDealId] = useState<string | null>(null);

  const fetchDeals = useCallback(() => {
    fetch('/api/admin/deals')
      .then(res => res.json())
      .then((data: any[]) => {
        const mapped: Deal[] = (data || []).map((d: any) => ({
          id: d.id,
          fileNumber: d.fileNumber ?? d.file_number ?? '',
          client: d.client ?? { id: '', firstName: '', lastName: d.client_last_name ?? '', email: '', phone: '' },
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
          isCoPurchaser: d.is_co_purchaser ?? false,
          hasCoPurchasers: d.has_co_purchasers ?? false,
          coPersonRole:
            d.co_person_role === "purchaser" || d.co_person_role === "seller"
              ? d.co_person_role
              : null,
          leadName: d.lead_name ?? '',
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
          isCoPurchaser: boolean;
          hasCoPurchasers: boolean;
          coPersonRole: "purchaser" | "seller" | null;
          leadName: string;
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

  const countS = primaryDeals.filter(d => d.type === DealType.SALE).length;
  const countP = primaryDeals.filter(d => d.type === DealType.PURCHASE).length;
  const countR = primaryDeals.filter(d => d.type === DealType.REFINANCE).length;
  const countPS = primaryDeals.filter(d => d.type === DealType.PURCHASE_AND_SALE).length;
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
    if (dateFrom || dateTo) {
      const closing = parseLocalDate(deal.closingDate);
      if (!closing) return false;
      closing.setHours(0, 0, 0, 0);
      if (dateFrom) { const from = parseLocalDate(dateFrom); if (!from) return false; from.setHours(0, 0, 0, 0); if (closing < from) return false; }
      if (dateTo) { const to = parseLocalDate(dateTo); if (!to) return false; to.setHours(23, 59, 59, 999); if (closing > to) return false; }
    }
    return true;
  });

  const applyPreset = (preset: 'today' | 'week' | 'month') => {
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
    } else if (preset === 'month') {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      setDateFrom(toISO(start));
      setDateTo(toISO(end));
    }
  };

  const formatDate = (dateString?: string) => formatLocalDate(dateString);


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
          <h1 className="text-lg sm:text-xl font-bold text-slate-900 border-b-2 border-slate-900 pb-0.5">All files</h1>
          <div className="flex items-center gap-2 text-sm"><span className="font-bold text-slate-700">Total: {totalFiles}</span><span className="bg-orange-100 text-orange-700 border border-orange-200 px-1.5 rounded text-xs font-bold" title="Sales">S {countS}</span><span className="bg-blue-100 text-blue-700 border border-blue-200 px-1.5 rounded text-xs font-bold" title="Purchases">P {countP}</span><span className="bg-purple-100 text-purple-700 border border-purple-200 px-1.5 rounded text-xs font-bold" title="Purchase & Sale">PS {countPS}</span><span className="bg-brand-black text-white px-1.5 rounded text-xs font-bold" title="Refinances">R {countR}</span></div>
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
              placeholder="Search by file #, client, address, lawyer, clerk, price, date…"
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
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3 border-b border-slate-100 pb-4">
          <div>
            <span className="block text-xs text-slate-500 mb-1">Filter by</span>
            <div className="inline-flex h-8 border border-slate-300 rounded overflow-hidden">
              <button className="px-3 text-xs font-medium bg-brand-light text-brand-primary cursor-default">
                Closing date
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">From</label>
            <input
              type="date"
              value={dateFrom}
              onChange={e => setDateFrom(e.target.value)}
              min="1900-01-01"
              max="2100-12-31"
              className="h-8 border border-slate-300 rounded px-2 text-xs text-slate-700 focus:border-brand-primary outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">To</label>
            <input
              type="date"
              value={dateTo}
              onChange={e => setDateTo(e.target.value)}
              min="1900-01-01"
              max="2100-12-31"
              className="h-8 border border-slate-300 rounded px-2 text-xs text-slate-700 focus:border-brand-primary outline-none"
            />
          </div>
          {(dateFrom || dateTo) && (
            <button
              onClick={() => { setDateFrom(''); setDateTo(''); }}
              className="h-8 px-2 text-xs text-slate-400 hover:text-red-500 transition-colors"
            >
              ✕ Clear
            </button>
          )}
          <div className="h-8 flex items-center gap-4 ml-auto">
            <button onClick={() => applyPreset('today')} className="text-xs font-medium text-brand-primary hover:underline">Today</button>
            <button onClick={() => applyPreset('week')} className="text-xs font-medium text-brand-primary hover:underline">This week</button>
            <button onClick={() => applyPreset('month')} className="text-xs font-medium text-brand-primary hover:underline">This month</button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <label className="block text-xs text-slate-500 mb-1">File type</label>
            <select
              value={filterType}
              onChange={e => setFilterType(e.target.value)}
              className="w-full h-8 border border-slate-300 rounded px-2 text-xs text-slate-700 focus:border-brand-primary outline-none bg-white"
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
              className="w-full h-8 border border-slate-300 rounded px-2 text-xs text-slate-700 focus:border-brand-primary outline-none bg-white"
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
              className="w-full h-8 border border-slate-300 rounded px-2 text-xs text-slate-700 focus:border-brand-primary outline-none bg-white"
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
            <label className="block text-xs text-slate-500 mb-1">File status</label>
            <select
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
              className="w-full h-8 border border-slate-300 rounded px-2 text-xs text-slate-700 focus:border-brand-primary outline-none bg-white"
            >
              <option value="">Choose a status</option>
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
              <option value="Closed">Closed</option>
            </select>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-left border-t border-slate-200">
          <thead>
            <tr className="bg-white text-slate-800 text-xs font-bold border-b border-slate-200">
              <th className="px-4 py-3 w-12">No.</th>
              <th className="px-4 py-3 w-24">File No.</th>
              <th className="px-4 py-3">File name</th>
              <th className="px-4 py-3 w-48">Client</th>
              <th className="px-4 py-3 w-20">Lawyer</th>
              <th className="px-4 py-3 w-20">Clerk</th>
              <th className="px-4 py-3 w-64">Address</th>
              <th className="px-4 py-3 w-32">Closing date</th>
              <th className="px-4 py-3 w-32">Requisition date</th>
              <th className="px-4 py-3 w-40">Steps</th>
              <th className="px-4 py-3 w-32">File status</th>
              <th className="px-4 py-3 w-24 text-center">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredDeals.length > 0 ? filteredDeals.map((deal, index) => {
              const isEven = index % 2 === 0;
              const rowClass = isEven ? 'bg-white' : 'bg-slate-50/80';
              const isCombined = deal.type === DealType.PURCHASE_AND_SALE;
              return (
                <tr key={deal.id} onClick={() => {
                  console.log("Clicked deal id:", deal.id);
                  onSelectDeal(deal.id);
                }} className={`${rowClass} hover:bg-brand-light/20 cursor-pointer transition-colors border-b border-slate-100 text-xs text-slate-700 whitespace-nowrap`}>
                  <td className="px-4 py-3">{index + 1}</td>
                  <td className="px-4 py-3 font-medium">{deal.fileNumber}</td>
                  <td className="px-4 py-3">
                    <div>
                      {(deal as any).fileName || deal.propertyAddress}
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
                          <span className={`ml-2 inline-flex items-center ${color}`} title={tooltip}>
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
                          <span className="ml-2 inline-flex items-center text-green-600" title={tooltip}>
                            <Users size={14} />
                          </span>
                        );
                      })()}
                      {isNonCitizenFlagged({ citizenship_status: (deal as any).leadCitizenshipStatus }) && (
                        <span
                          className="ml-2 inline-flex items-center text-red-600"
                          title={NON_CITIZEN_FLAG_TOOLTIP}
                        >
                          <AlertTriangle size={12} />
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {(deal as any).leadName ? (
                      <span
                        className="text-xs font-medium text-slate-700"
                        title={(deal as any).leadName}
                      >
                        {(deal as any).leadName}
                      </span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
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
                  <td className="px-4 py-3">
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
                  <td className="px-4 py-3 max-w-xs" title={isCombined ? `Purchase: ${deal.propertyAddress || "—"}\nSale: ${deal.sellingPropertyAddress || "—"}` : deal.propertyAddress}>
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
                  <td className="px-4 py-3">{formatDate(deal.closingDate)}</td>
                  <td className="px-4 py-3">{formatDate(deal.requisitionDate)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-red-500 rounded-full transition-all"
                          style={{ width: `${deal.totalTasks ? (deal.completedTasks! / deal.totalTasks) * 100 : 0}%` }}
                        />
                      </div>
                      <span className="text-[11px] text-slate-500 font-medium">{deal.completedTasks ?? 0}/{deal.totalTasks ?? 0}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {deal.status === DealStatus.CLOSED ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-700 border border-green-200 shadow-sm">
                        <span className="mr-1">✓</span> Closed
                      </span>
                    ) : deal.status === DealStatus.INACTIVE ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-500 border border-slate-200">
                        Inactive
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-white text-green-600 border border-green-400">
                        Active
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="inline-flex items-center justify-center gap-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingDealId(deal.id);
                        }}
                        className="text-slate-400 hover:text-brand-primary transition-colors p-1"
                        title="Edit deal"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(deal.id);
                        }}
                        className="text-slate-300 hover:text-red-500 transition-colors p-1"
                        title="Delete deal"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            }) : (
              <tr><td colSpan={12} className="px-6 py-12 text-center text-slate-500"><p>No files found.</p></td></tr>
            )}
          </tbody>
        </table>
      </div>

      {editingDealId && (
        <EditDealModal
          dealId={editingDealId}
          onClose={() => setEditingDealId(null)}
          onSaved={fetchDeals}
        />
      )}
    </div>
  );
};

export default DealList;
