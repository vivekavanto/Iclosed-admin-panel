import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { Deal, DealType, DealStatus } from '../types';
import { toDeal } from '@/lib/dealMapper';
import {
  Search,
  Trash2,
  Users,
  AlertTriangle,
  Upload,
  ChevronDown,
  LogIn,
  UserPlus,
  Loader2,
  CheckCircle2,
} from 'lucide-react';
import {
  isNonCitizenFlagged,
  NON_CITIZEN_FLAG_TOOLTIP,
} from '@/lib/isNonCitizenFlagged';
import { formatLocalDate, parseLocalDate } from '@/lib/formatDate';
import { computeDealDisplayStatus } from '@/lib/dealDisplayStatus';

interface DealListProps {
  onSelectDeal?: (dealId: string) => void;
}

// A row from the `partners` master — the referral agent/broker on a file.
interface ReferralPartner {
  id: string;
  agent_name: string | null;
  agent_email: string | null;
  agent_phone: string | null;
  brokerage_type: string | null;
  brokerage_name: string | null;
  referral_code: string | null;
}

/**
 * The referral fields fetchDeals attaches to each deal on top of `Deal`.
 *
 * `deals` is typed as Deal[] and the list casts for its other extras too; this
 * keeps the agent ones structurally typed rather than reaching through `any`.
 */
type ReferralFields = {
  referralPartner?: ReferralPartner | null;
  referralAgentName?: string | null;
  referralAgentCompany?: string | null;
  leadId?: string | null;
  leadName?: string;
};

const referralOf = (deal: Deal): ReferralFields => deal as Deal & ReferralFields;

/** The agent to show for a file: the linked partner, else the intake free text. */
function agentLabel(deal: Deal): string {
  const r = referralOf(deal);
  return (
    r.referralPartner?.agent_name ||
    r.referralAgentName ||
    r.referralPartner?.brokerage_name ||
    r.referralAgentCompany ||
    ''
  );
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
  // "Last updated" sort: most recently edited note first. Overrides closingSort.
  const [noteSort, setNoteSort] = useState(false);
  // Which file row has its progress panel expanded (one at a time). The list
  // API only returns the Steps count, not the titles, so we lazy-fetch the
  // deal's tasks from /api/admin/tasks and its milestones from
  // /api/admin/milestones the first time a row is expanded, and cache both in
  // pendingTasks keyed by deal id.
  //
  // Tasks and milestones are BOTH listed, always. Milestone status is derived
  // from the tasks under it (recalcMilestones.ts), so the two answer different
  // questions: the tasks say what is outstanding, the milestones say what stage
  // the file is stuck at. A file can also carry open milestones with no open
  // tasks — an admin-role or auto-complete stage — so showing milestones only
  // as a fallback hid them on exactly the files where they were the answer.
  const [expandedDealId, setExpandedDealId] = useState<string | null>(null);
  const [pendingTasks, setPendingTasks] = useState<
    Record<
      string,
      {
        loading: boolean;
        error: boolean;
        tasks: { id: string; title: string; status: string }[];
        milestones: { id: string; title: string; status: string; leadType: string | null }[];
      }
    >
  >({});

  // ── Inline file note ───────────────────────────────────────────────────────
  // Which row's note is being edited, its draft text, and the in-flight save.
  const [noteEditId, setNoteEditId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [noteSavingId, setNoteSavingId] = useState<string | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  // Enter and Escape have already decided the outcome; the blur that follows
  // (the input unmounts) must not save again — or, after Escape, save the
  // text the admin just abandoned.
  const noteSkipBlurRef = useRef(false);

  // ── Referral agent (partner) linking ───────────────────────────────────────
  // Intake was the only place that could originally attach an agent, so a file
  // created before the agent was known had no way back. This mirrors the Partner
  // Details flow on the Leads page, addressed by file:
  // /api/admin/deals/[id]/agent applies the change family-wide, exactly as the
  // lead-level route does.
  const [agentDeal, setAgentDeal] = useState<Deal | null>(null);
  const [partners, setPartners] = useState<ReferralPartner[]>([]);
  const [partnersLoading, setPartnersLoading] = useState(false);
  const [partnersError, setPartnersError] = useState<string | null>(null);
  const [partnerSearch, setPartnerSearch] = useState('');
  const [pickedPartnerId, setPickedPartnerId] = useState<string | null>(null);
  const [savingAgent, setSavingAgent] = useState(false);
  // Success shows as a banner above the table (the modal closes); failure shows
  // inside the modal, which stays open so the pick isn't lost.
  const [agentResult, setAgentResult] = useState<{ success: boolean; message: string } | null>(null);

  const openAgentModal = useCallback(async (deal: Deal) => {
    setAgentDeal(deal);
    setPickedPartnerId(referralOf(deal).referralPartner?.id ?? null);
    setPartnerSearch('');
    setAgentResult(null);

    // Partners rarely change during a session, so fetch once and reuse.
    if (partners.length > 0) return;
    setPartnersLoading(true);
    setPartnersError(null);
    try {
      const res = await fetch('/api/admin/partners');
      if (!res.ok) throw new Error('Failed to load partners.');
      const data = await res.json();
      setPartners(Array.isArray(data) ? data : []);
    } catch (err) {
      setPartnersError(err instanceof Error ? err.message : 'Failed to load partners.');
    } finally {
      setPartnersLoading(false);
    }
  }, [partners.length]);

  // partnerId null clears the agent. The server applies it to everyone on the
  // file, so every affected row in the list is patched — not just this one —
  // otherwise a co-client's row would still show the old agent.
  const saveAgent = useCallback(async (deal: Deal, partnerId: string | null) => {
    setSavingAgent(true);
    setAgentResult(null);
    try {
      const res = await fetch(`/api/admin/deals/${deal.id}/agent`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partnerId }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || 'Failed to update the agent.');
      }

      const partner: ReferralPartner | null = data.partner ?? null;
      const familyLeadId = referralOf(deal).leadId ?? null;
      setDeals((prev) =>
        prev.map((d) => {
          const sameFile =
            d.id === deal.id ||
            (!!familyLeadId && referralOf(d).leadId === familyLeadId) ||
            (!!deal.fileNumber && d.fileNumber === deal.fileNumber);
          if (!sameFile) return d;
          return {
            ...d,
            referralPartner: partner,
            referralAgentName: null,
            referralAgentCompany: null,
          } as Deal;
        }),
      );

      const name = partner?.agent_name || 'Agent';
      const parts = [
        partnerId
          ? `${name} linked to file ${deal.fileNumber || ''}`.trim() + '.'
          : `Agent removed from file ${deal.fileNumber || ''}`.trim() + '.',
      ];
      if (data.agentNotified) {
        parts.push('The signup email was sent to the agent.');
      } else if (data.agentNotifyError) {
        parts.push(`The signup email could not be sent: ${data.agentNotifyError}`);
      } else if (data.notify?.eligible) {
        parts.push('They have not had the signup email — send it from the lead’s Partner Details.');
      }
      if (Array.isArray(data.warnings)) parts.push(...data.warnings);

      setAgentDeal(null);
      setAgentResult({ success: true, message: parts.join(' ') });
    } catch (err) {
      setAgentResult({
        success: false,
        message: err instanceof Error ? err.message : 'Failed to update the agent.',
      });
    } finally {
      setSavingAgent(false);
    }
  }, []);

  // Loads what the panel shows for one file: the open tasks exactly as the file
  // page lists them, and the open milestones in stage order. Both every time —
  // one request each, made once per file and then served from the cache.
  const loadFileProgress = useCallback(async (dealId: string) => {
    // The handful of fields the panel reads off each API row.
    type TaskRow = {
      id: string;
      title: string | null;
      status: string | null;
      role_type: string | null;
      order_index: number | null;
      owner_name?: string | null;
    };
    type MilestoneRow = {
      id: string;
      title: string | null;
      status: string | null;
      stage_templates?: { lead_type: string | null } | null;
    };
    try {
      // include_family=1 returns the same rows the deal page renders: the
      // primary's shared tasks plus EVERY person's personal tasks, each
      // annotated with its owner. Without it the panel shows one collapsed
      // "Personal Information" for a 3-person file instead of one per person.
      // Every row in this list is a primary deal (co-client rows are filtered
      // out), which is exactly where the family view applies.
      const res = await fetch(`/api/admin/tasks?deal_id=${dealId}&include_family=1`);
      if (!res.ok) throw new Error('Failed to load tasks');
      const data: TaskRow[] = await res.json();

      // "Pending" = not Completed (matches the Steps count's open remainder).
      // Admin-role rows are the office's own records, not client steps — the
      // Steps count excludes them, so the panel must too or the two disagree.
      const pending = (data || [])
        .filter((t) => (t?.role_type ?? '').toLowerCase() !== 'admin')
        .filter((t) => t?.status !== 'Completed')
        // order_index is the file's own task sequence, so the chips read in the
        // same order as the deal page's Tasks table. Unordered rows fall last.
        .sort(
          (a, b) =>
            (a?.order_index ?? Number.MAX_SAFE_INTEGER) -
            (b?.order_index ?? Number.MAX_SAFE_INTEGER),
        )
        .map((t) => {
          // The owner name is rendered, never stored on the title — same as the
          // deal page's "<task> - <name>".
          const base = t.title?.trim() || 'Untitled task';
          const owner = (t.owner_name ?? '').trim();
          return {
            id: String(t.id),
            title: owner ? `${base} - ${owner}` : base,
            status: t.status || 'Pending',
          };
        });

      // Milestones come back already ordered by order_index (the canonical
      // stage sequence), so the open ones read in the order the file works
      // through them. Family milestones mirror by stage, so the primary's rows
      // speak for the whole file.
      //
      // A milestone fetch that fails does NOT fail the panel: the tasks are the
      // more important half, and an empty milestone list reads as "none open",
      // which is why the failure is swallowed here rather than thrown.
      let milestones: { id: string; title: string; status: string; leadType: string | null }[] = [];
      const msRes = await fetch(`/api/admin/milestones?deal_id=${dealId}`);
      if (msRes.ok) {
        const ms: MilestoneRow[] = await msRes.json();
        milestones = (ms || [])
          .filter((m) => m?.status !== 'Completed')
          .map((m) => ({
            id: String(m.id),
            title: m.title?.trim() || 'Untitled milestone',
            status: m.status || 'Pending',
            leadType: m.stage_templates?.lead_type ?? null,
          }));
      }

      setPendingTasks((p) => ({
        ...p,
        [dealId]: { loading: false, error: false, tasks: pending, milestones },
      }));
    } catch {
      setPendingTasks((p) => ({
        ...p,
        [dealId]: { loading: false, error: true, tasks: [], milestones: [] },
      }));
    }
  }, []);

  const togglePendingTasks = useCallback((dealId: string) => {
    setExpandedDealId((prev) => (prev === dealId ? null : dealId));
    // Fetch once per deal, then serve from cache on subsequent expands.
    setPendingTasks((prev) => {
      if (prev[dealId]) return prev;
      loadFileProgress(dealId);
      return { ...prev, [dealId]: { loading: true, error: false, tasks: [], milestones: [] } };
    });
  }, [loadFileProgress]);

  // Save the inline file note. The server mirrors admin_note across the
  // co-purchaser/co-seller family (one file, one note), so the row this list
  // shows — always the primary — is the only one that needs patching here.
  // A no-op edit skips the request entirely.
  const saveNote = useCallback(async (deal: Deal, text: string) => {
    const next = text.trim().slice(0, 500);
    const current = ((deal as Deal & { adminNote?: string | null }).adminNote ?? '').trim();
    setNoteEditId(null);
    if (next === current) return;

    setNoteSavingId(deal.id);
    setNoteError(null);
    try {
      const res = await fetch(`/api/admin/deals/${deal.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_note: next || null }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || 'Failed to save the note.');
      }
      const stampedAt = next ? (data?.data?.admin_note_updated_at ?? new Date().toISOString()) : null;
      setDeals((prev) =>
        prev.map((d) =>
          d.id === deal.id
            ? ({ ...d, adminNote: next || null, adminNoteUpdatedAt: stampedAt } as Deal)
            : d,
        ),
      );
    } catch (err) {
      setNoteError(err instanceof Error ? err.message : 'Failed to save the note.');
    } finally {
      setNoteSavingId(null);
    }
  }, []);

  const fetchDeals = useCallback(() => {
    fetch('/api/admin/deals')
      .then(res => res.json())
      .then((data: any[]) => {
        const mapped: Deal[] = (data || []).map((d: any) => ({
          // ARC-005: core fields via the shared mapper; list-only extras below.
          ...toDeal(d),
          // List keeps the lead email in the client fallback.
          client: d.client ?? { id: '', firstName: '', lastName: d.client_last_name ?? '', email: d.lead_email ?? '', phone: '' },
          completedTasks: d.completedTasks ?? 0,
          totalTasks: d.totalTasks ?? 0,
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
          // Referral attribution. referralPartner is the linked `partners` row;
          // the referralAgent* fields are the free-text agent a client could name
          // at intake, read only as a fallback behind it.
          referralPartner: d.referral_partner ?? null,
          referralAgentName: d.referral_agent_name ?? null,
          referralAgentCompany: d.referral_agent_company ?? null,
          // Linking an agent applies to everyone on the file, so the list needs
          // the lead id to find the sibling rows and patch them too.
          leadId: d.lead_id ?? null,
          // Internal, admin-only "where is this file at" note (Notes column).
          adminNote: d.admin_note ?? null,
          adminNoteUpdatedAt: d.admin_note_updated_at ?? null,
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
          referralPartner: ReferralPartner | null;
          referralAgentName: string | null;
          referralAgentCompany: string | null;
          leadId: string | null;
          adminNote: string | null;
          adminNoteUpdatedAt: string | null;
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
        // The admin's own note, so "waiting on lender" finds every file the
        // admin marked that way — the main reason to keep notes in a column.
        d.adminNote ?? '',
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
  const noteUpdatedAt = (d: Deal) =>
    (d as Deal & { adminNoteUpdatedAt?: string | null }).adminNoteUpdatedAt ?? null;
  const sortedDeals = noteSort
    // Most recently updated note first; files with no note timestamp sink.
    ? [...filteredDeals].sort((a, b) => {
        const da = Date.parse(noteUpdatedAt(a) ?? '');
        const db = Date.parse(noteUpdatedAt(b) ?? '');
        const aMissing = Number.isNaN(da);
        const bMissing = Number.isNaN(db);
        if (aMissing && bMissing) return 0;
        if (aMissing) return 1;
        if (bMissing) return -1;
        return db - da;
      })
    : closingSort
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
  const toggleClosingSort = () => {
    setNoteSort(false);
    setClosingSort((prev) => (prev === 'asc' ? 'desc' : 'asc'));
  };
  const sortMode: 'closing' | 'created' | 'note' = noteSort
    ? 'note'
    : closingSort
    ? 'closing'
    : 'created';

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
    // No password prompt: an authenticated admin session is enough (the
    // SEC-006 step-up was removed by business decision). The server still
    // audits every impersonation.
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
              onClick={() => {
                setNoteSort(false);
                setClosingSort('asc');
              }}
              className={`px-2.5 py-1 font-medium transition-colors ${
                sortMode === 'closing'
                  ? 'bg-brand-primary text-white'
                  : 'bg-white text-slate-600 hover:bg-slate-50'
              }`}
              title="Sort by closing date"
            >
              Closing date
            </button>
            <button
              type="button"
              onClick={() => {
                setNoteSort(false);
                setClosingSort(null);
              }}
              className={`px-2.5 py-1 font-medium border-l border-slate-200 transition-colors ${
                sortMode === 'created'
                  ? 'bg-brand-primary text-white'
                  : 'bg-white text-slate-600 hover:bg-slate-50'
              }`}
              title="Show the most recently created files first"
            >
              Recently created
            </button>
            <button
              type="button"
              onClick={() => setNoteSort(true)}
              className={`px-2.5 py-1 font-medium border-l border-slate-200 transition-colors ${
                sortMode === 'note'
                  ? 'bg-brand-primary text-white'
                  : 'bg-white text-slate-600 hover:bg-slate-50'
              }`}
              title="Show the most recently updated notes first"
            >
              Last updated
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

      {/* Agent link/unlink outcome. Lives above the table rather than in the row
          because the change applies to every person on the file, not just the
          row that was clicked. */}
      {agentResult && (
        <div className="px-4 sm:px-6 pb-3">
          <div
            className={`flex items-start gap-2 px-3 py-2.5 rounded-lg border text-sm font-medium ${
              agentResult.success
                ? 'bg-green-50 border-green-200 text-green-800'
                : 'bg-red-50 border-red-200 text-red-700'
            }`}
          >
            {agentResult.success ? (
              <CheckCircle2 size={16} className="flex-shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
            )}
            <span className="flex-1">{agentResult.message}</span>
            <button
              type="button"
              onClick={() => setAgentResult(null)}
              className="text-xl leading-none font-bold opacity-40 hover:opacity-100"
              aria-label="Dismiss"
            >
              &times;
            </button>
          </div>
        </div>
      )}

      {/* A failed note save. Surfaced here (not in the cell) because the edit
          box is already closed by then — silently dropping the text would look
          like it saved. */}
      {noteError && (
        <div className="px-4 sm:px-6 pb-3">
          <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg border text-sm font-medium bg-red-50 border-red-200 text-red-700">
            <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
            <span className="flex-1">{noteError}</span>
            <button
              type="button"
              onClick={() => setNoteError(null)}
              className="text-xl leading-none font-bold opacity-40 hover:opacity-100"
              aria-label="Dismiss"
            >
              &times;
            </button>
          </div>
        </div>
      )}

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
              zoom.

              ORDER MATTERS: a hidden cell (display:none) is dropped from the
              row entirely, so the remaining cells map onto the cols in order.
              The hidden columns' entries therefore have to sit at the END of
              this list — otherwise Notes/Actions inherit their 0% widths.
              Visible widths sum to 100%. */}
          <colgroup>
            <col style={{ width: '4%' }} />{/* Row number */}
            <col style={{ width: '6%' }} />{/* Account status */}
            <col style={{ width: '7%' }} />{/* File No. */}
            <col style={{ width: '13%' }} />{/* Client Name */}
            <col style={{ width: '13%' }} />{/* Address */}
            <col style={{ width: '8%' }} />{/* Closing date */}
            <col style={{ width: '9%' }} />{/* Progress */}
            <col style={{ width: '6%' }} />{/* Lawyer */}
            <col style={{ width: '6%' }} />{/* Clerk */}
            <col style={{ width: '14%' }} />{/* Notes */}
            <col style={{ width: '7%' }} />{/* Last updated */}
            <col style={{ width: '7%' }} />{/* Actions */}
            {/* Hidden columns — Agent, Account created, Requisition date, File
                name. Their cells are display:none, so these collapse to 0%. */}
            <col style={{ width: '0%' }} />
            <col style={{ width: '0%' }} />
            <col style={{ width: '0%' }} />
            <col style={{ width: '0%' }} />
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
                    {sortMode !== 'closing' ? '↕' : closingSort === 'asc' ? '▲' : '▼'}
                  </span>
                </button>
              </th>
              <th className="px-2 py-1.5">Progress</th>
              <th className="px-2 py-1.5">Lawyer</th>
              <th className="px-2 py-1.5">Clerk</th>
              {/* Agent column hidden per request — kept (not deleted) to avoid breaking anything. */}
              <th className="px-2 py-1.5 hidden">Agent</th>
              {/* Account created column hidden per request — kept (not deleted) to avoid breaking anything. */}
              <th className="px-2 py-1.5 hidden">Account created</th>
              {/* Free-text status the admin keeps by hand — see the cell below. */}
              <th className="px-2 py-1.5">Notes</th>
              <th className="px-2 py-1.5">
                <button
                  type="button"
                  onClick={() => setNoteSort(true)}
                  className="flex items-center gap-1 font-bold hover:text-brand-primary transition-colors"
                  title="Most recently updated notes first"
                >
                  Last updated
                  <span className="text-[10px] leading-none text-slate-400">
                    {sortMode === 'note' ? '▼' : '↕'}
                  </span>
                </button>
              </th>
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
                      title="Show pending tasks and milestones for this file"
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
                  {/* Agent — the referral partner, and the entry point for
                      attaching one after intake. Clicking must not open the file,
                      hence stopPropagation on the row's onClick.
                      Hidden per request — kept (not deleted) to avoid breaking anything. */}
                  <td className="px-2 py-1.5 hidden">
                    {(() => {
                      const label = agentLabel(deal);
                      return (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openAgentModal(deal);
                          }}
                          title={
                            label
                              ? `${label} — click to change the referral agent`
                              : 'Add a referral agent to this file'
                          }
                          className={`inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors ${
                            label
                              ? 'text-slate-700 hover:bg-brand-light/40 hover:text-brand-primary'
                              : 'text-slate-300 hover:bg-brand-light/40 hover:text-brand-primary'
                          }`}
                        >
                          {label ? (
                            <span className="truncate">{label}</span>
                          ) : (
                            <>
                              <UserPlus size={12} className="flex-shrink-0" />
                              <span>Add</span>
                            </>
                          )}
                        </button>
                      );
                    })()}
                  </td>
                  {/* Account created — hidden per request, kept (not deleted). */}
                  <td className="px-2 py-1.5 hidden">
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
                  {/* Notes — where the file is at, in the admin's own words.
                      Click to edit in place: Enter or blur saves, Escape
                      cancels. Clicking must not open the file, hence
                      stopPropagation on the row's onClick. */}
                  <td className="px-2 py-1.5 align-middle">
                    {(() => {
                      const note =
                        (deal as Deal & { adminNote?: string | null }).adminNote ?? '';
                      if (noteEditId === deal.id) {
                        return (
                          <input
                            autoFocus
                            value={noteDraft}
                            maxLength={500}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setNoteDraft(e.target.value)}
                            onBlur={() => {
                              if (noteSkipBlurRef.current) {
                                noteSkipBlurRef.current = false;
                                return;
                              }
                              saveNote(deal, noteDraft);
                            }}
                            onKeyDown={(e) => {
                              e.stopPropagation();
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                noteSkipBlurRef.current = true;
                                saveNote(deal, noteDraft);
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                noteSkipBlurRef.current = true;
                                setNoteEditId(null);
                              }
                            }}
                            placeholder="e.g. waiting on lender"
                            className="w-full rounded border border-brand-primary/60 px-1.5 py-0.5 text-[11px] text-slate-700 outline-none focus:ring-1 focus:ring-brand-primary/40"
                          />
                        );
                      }
                      return (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setNoteError(null);
                            setNoteDraft(note);
                            setNoteEditId(deal.id);
                          }}
                          disabled={noteSavingId === deal.id}
                          title={note ? `${note} — click to edit` : 'Add a note on where this file is at'}
                          className={`inline-flex w-full max-w-full items-start gap-1 rounded px-1.5 py-0.5 text-[11px] leading-snug text-left transition-colors ${
                            note
                              ? 'text-slate-700 hover:bg-brand-light/40 hover:text-brand-primary'
                              : 'text-slate-300 hover:bg-brand-light/40 hover:text-brand-primary'
                          }`}
                        >
                          {noteSavingId === deal.id ? (
                            <Loader2 size={12} className="animate-spin mt-0.5 flex-shrink-0" />
                          ) : null}
                          <span className="whitespace-normal break-words">{note || 'Add note'}</span>
                        </button>
                      );
                    })()}
                  </td>
                  {/* Last updated — when the note was last added/edited. */}
                  <td className="px-2 py-1.5 text-slate-600">
                    {(deal as Deal & { adminNote?: string | null }).adminNote && noteUpdatedAt(deal)
                      ? new Date(noteUpdatedAt(deal)!).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })
                      : <span className="text-slate-300">—</span>}
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
                    <td colSpan={15} className="px-2 py-1.5">
                      {(() => {
                        const entry = pendingTasks[deal.id];
                        if (!entry || entry.loading) {
                          return <span className="text-xs text-slate-400">Loading pending tasks and milestones…</span>;
                        }
                        if (entry.error) {
                          return <span className="text-xs text-red-500">Failed to load pending tasks and milestones.</span>;
                        }
                        if (entry.tasks.length === 0 && entry.milestones.length === 0) {
                          return (
                            <span className="text-xs text-green-600 font-medium">
                              ✓ All tasks and milestones completed.
                            </span>
                          );
                        }
                        const fileLabel = deal.fileNumber || 'this file';
                        return (
                          <div className="flex flex-col gap-2.5">
                            {/* ── Pending tasks ── */}
                            <div className="flex flex-col gap-2">
                              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                                {entry.tasks.length === 0 ? (
                                  <span className="text-green-600">✓ All tasks completed</span>
                                ) : (
                                  <>
                                    {entry.tasks.length} pending task{entry.tasks.length > 1 ? 's' : ''} for {fileLabel}
                                  </>
                                )}
                              </span>
                              {entry.tasks.length > 0 && (
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
                              )}
                            </div>

                            {/* ── Pending milestones ──
                                Listed in stage order, so the first chip is the
                                stage the file is actually sitting at. */}
                            <div className="flex flex-col gap-2">
                              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                                {entry.milestones.length === 0 ? (
                                  <span className="text-green-600">✓ All milestones completed</span>
                                ) : (
                                  <>
                                    {entry.milestones.length} pending milestone{entry.milestones.length > 1 ? 's' : ''} for {fileLabel}
                                  </>
                                )}
                              </span>
                              {entry.milestones.length > 0 && (
                                <div className="flex flex-wrap gap-1.5">
                                  {entry.milestones.map((m, i) => (
                                    <span
                                      key={m.id}
                                      className="inline-flex items-center gap-1.5 bg-white border border-slate-200 rounded-full px-2.5 py-1 text-[11px] text-slate-700"
                                      title={m.status}
                                    >
                                      <span className="text-[9px] font-bold text-slate-400">{i + 1}</span>
                                      {/* A Purchase & Sale file carries both sides'
                                          stages, so name the side or the sequence
                                          reads as one confused list. */}
                                      {isCombined && m.leadType && (
                                        <span
                                          className={`text-[9px] font-black uppercase tracking-widest ${
                                            m.leadType.toLowerCase() === 'sale' ? 'text-orange-600' : 'text-blue-600'
                                          }`}
                                        >
                                          {m.leadType}
                                        </span>
                                      )}
                                      {m.title}
                                    </span>
                                  ))}
                                </div>
                              )}
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
              <tr><td colSpan={15} className="px-6 py-12 text-center text-slate-500"><p>No files found.</p></td></tr>
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

      {/* ── Link Referral Agent Modal ──
          Portalled out of the table's overflow-x-auto wrapper, which would
          otherwise clip and scroll it with the columns. */}
      {agentDeal && createPortal(
        (() => {
          const q = partnerSearch.trim().toLowerCase();
          // Match on anything an admin might have to hand: the person, the firm,
          // their email, or the referral code from a business card.
          const visiblePartners = q
            ? partners.filter((p) =>
                [p.agent_name, p.brokerage_name, p.agent_email, p.referral_code]
                  .some((v) => (v ?? '').toLowerCase().includes(q)),
              )
            : partners;
          const currentPartnerId = referralOf(agentDeal).referralPartner?.id ?? null;
          const close = () => !savingAgent && setAgentDeal(null);

          return (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 overflow-y-auto"
              onClick={close}
            >
              <div
                className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden my-auto"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Header */}
                <div className="flex-shrink-0 flex items-center justify-between px-6 py-4 border-b border-slate-200">
                  <div className="min-w-0">
                    <h3 className="text-lg font-bold text-slate-900">
                      {currentPartnerId ? 'Change Referral Agent' : 'Add Referral Agent'}
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5 truncate">
                      File {agentDeal.fileNumber || '—'}
                      {referralOf(agentDeal).leadName
                        ? ` · ${referralOf(agentDeal).leadName}`
                        : ''}
                      {' · applies to everyone on this file.'}
                    </p>
                  </div>
                  <button
                    onClick={close}
                    className="text-slate-400 hover:text-slate-600 text-xl font-bold leading-none ml-3"
                    aria-label="Close"
                  >
                    &times;
                  </button>
                </div>

                {/* Search */}
                <div className="flex-shrink-0 px-6 py-3 border-b border-slate-100">
                  <div className="relative">
                    <Search
                      size={15}
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                    />
                    <input
                      type="text"
                      value={partnerSearch}
                      onChange={(e) => setPartnerSearch(e.target.value)}
                      placeholder="Search by name, brokerage, email or code"
                      className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary"
                    />
                  </div>
                </div>

                {/* Partner list */}
                <div className="flex-1 overflow-y-auto px-3 py-2 min-h-[8rem]">
                  {partnersLoading ? (
                    <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
                      <Loader2 size={16} className="animate-spin" />
                      Loading partners…
                    </div>
                  ) : partnersError ? (
                    <div className="flex items-start gap-2 m-3 px-3 py-2.5 rounded-lg border border-red-200 bg-red-50 text-sm text-red-700">
                      <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
                      <span>{partnersError}</span>
                    </div>
                  ) : visiblePartners.length === 0 ? (
                    <div className="px-4 py-10 text-center">
                      <p className="text-sm font-bold text-slate-700">
                        {partners.length === 0
                          ? 'No partners yet'
                          : 'No partners match that search'}
                      </p>
                      <p className="text-xs text-slate-500 mt-1">
                        Only agents in the Partners list can be linked. Add them
                        under Partners first, then come back here.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {visiblePartners.map((p) => {
                        const picked = pickedPartnerId === p.id;
                        const isCurrent = currentPartnerId === p.id;
                        return (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => setPickedPartnerId(p.id)}
                            className={`w-full text-left px-3 py-2.5 rounded-lg border transition ${
                              picked
                                ? 'border-brand-primary bg-brand-light/40'
                                : 'border-transparent hover:bg-slate-50'
                            }`}
                          >
                            <div className="flex items-start gap-3">
                              <div
                                className={`mt-0.5 w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
                                  picked ? 'border-brand-primary' : 'border-slate-300'
                                }`}
                              >
                                {picked && (
                                  <span className="w-2 h-2 rounded-full bg-brand-primary" />
                                )}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-sm font-bold text-slate-900">
                                    {p.agent_name || 'Unnamed partner'}
                                  </span>
                                  {p.brokerage_type && (
                                    <span
                                      className={`px-1.5 py-0.5 rounded text-[9px] font-black uppercase border ${
                                        p.brokerage_type.toLowerCase().includes('agent')
                                          ? 'bg-blue-100 text-blue-700 border-blue-200'
                                          : 'bg-amber-100 text-amber-700 border-amber-200'
                                      }`}
                                    >
                                      {p.brokerage_type}
                                    </span>
                                  )}
                                  {isCurrent && (
                                    <span className="px-1.5 py-0.5 rounded text-[9px] font-black uppercase border bg-green-100 text-green-700 border-green-200">
                                      Current
                                    </span>
                                  )}
                                </div>
                                <p className="text-xs text-slate-500 truncate">
                                  {[p.brokerage_name, p.agent_email]
                                    .filter(Boolean)
                                    .join(' · ') || 'No contact details'}
                                </p>
                                {p.referral_code && (
                                  <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide mt-0.5">
                                    {p.referral_code}
                                  </p>
                                )}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Save failures land here — the modal stays open so the pick
                    isn't lost. Successes close it and report above the table. */}
                {agentResult && !agentResult.success && (
                  <div className="flex-shrink-0 mx-6 mb-3 flex items-start gap-2 px-3 py-2.5 rounded-lg border border-red-200 bg-red-50 text-sm text-red-700">
                    <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
                    <span>{agentResult.message}</span>
                  </div>
                )}

                {/* Footer */}
                <div className="flex-shrink-0 flex items-center gap-2 px-6 py-4 border-t border-slate-200 bg-slate-50/50">
                  {currentPartnerId && (
                    <button
                      type="button"
                      onClick={() => {
                        if (
                          !confirm(
                            "Remove the referral agent from this file? They'll stop being copied on client emails.",
                          )
                        ) {
                          return;
                        }
                        saveAgent(agentDeal, null);
                      }}
                      disabled={savingAgent}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-red-200 bg-white text-red-600 text-sm font-bold hover:bg-red-50 transition disabled:opacity-50"
                    >
                      <Trash2 size={14} />
                      Remove
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={close}
                    disabled={savingAgent}
                    className="ml-auto px-4 py-2 rounded-lg border border-slate-300 bg-white text-slate-700 text-sm font-bold hover:bg-slate-50 transition disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => pickedPartnerId && saveAgent(agentDeal, pickedPartnerId)}
                    disabled={
                      savingAgent || !pickedPartnerId || pickedPartnerId === currentPartnerId
                    }
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-primary text-white text-sm font-bold hover:opacity-90 transition disabled:opacity-50"
                  >
                    {savingAgent && <Loader2 size={14} className="animate-spin" />}
                    {savingAgent ? 'Saving…' : 'Link Agent'}
                  </button>
                </div>
              </div>
            </div>
          );
        })(),
        document.body,
      )}
    </div>
  );
};

export default DealList;
