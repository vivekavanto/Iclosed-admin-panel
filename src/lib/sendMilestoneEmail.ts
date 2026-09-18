import { sendEmail } from "./email/emailTransport";
import supabaseAdmin from "./supabaseAdmin";
import { logger } from "./logger";
import { getFamilyDealIds } from "./familyDeals";
import { formatLeadTypeLabel, buildLeadAddressForEmail } from "./leadEmailAddress";
import { normalizeRecipientEmail } from "./emailIdentity";
import { getDealFirmKey } from "./leadFirm";
import { brandEmailHtml } from "./emailBrand";
import type { FirmKey } from "./firms";
import { buildAgentCcList, buildAgentRecipients } from "./agentCc";
import { loadDealTemplateFacts } from "./dealTemplateFacts";
import {
    resolveLeadRecipientSide,
    resolveMilestoneSide,
    shouldEmailForSide,
    type Side,
} from "./milestoneSide";

/**
 * Milestone emails go out ONCE per family, not once per person.
 *
 * Everyone on a file — the primary plus their co-purchasers / co-sellers — is a
 * party to the same transaction and needs the same milestone updates. Sending a
 * separate copy to each of them meant the referral agent (CC'd via the
 * template's `shared_with_agent` flag) received N copies of every update, and
 * spouses sharing an inbox got the email twice.
 *
 * So: one email, every eligible client in `to`, the agent CC'd once. Two rules
 * survive from the per-person era and must keep working:
 *
 *   • SIDE SCOPING (see milestoneSide.ts). On a Purchase & Sale file every deal
 *     in the family carries BOTH sides' milestones, so a purchase-side stage
 *     must not reach the co-sellers. The recipient list is filtered, not the
 *     send — a purchase-side stage produces one email addressed to the primary
 *     and the co-purchasers only.
 *   • PER-PERSON TOKENS. The template body is personalised. With more than one
 *     recipient there is no single correct value, so:
 *       - name tokens become a joined list ("Alice and Bob")
 *       - `{{ property_role_row }}` ("Your Role: Co-Purchaser") renders empty
 *       - `{{ lead_type }}` becomes the milestone's side, which is the one
 *         label true for everyone in the recipient set
 *     A single-recipient send keeps the original per-person behaviour exactly.
 *
 * Only MILESTONE email is combined. Account activation, password reset, the
 * retainer signing link (personal token) and the welcome email stay per-person.
 *
 * ── AGENT-ONLY TEMPLATES ────────────────────────────────────────────────
 * A template flagged `agent_only` inverts the recipients: the referral agent is
 * written TO, and the client is not on the email at all — not in `to`, not CC'd.
 * It is for milestones the agent needs to know about and the client does not
 * ("your client's signing has been booked"), which `shared_with_agent` cannot
 * express: that flag only ever adds a copy to the client's own email.
 *
 * In that mode `user.*` is the AGENT (the person being greeted) and the client
 * moves to `client_*`. The file-level placeholders — address, closing date,
 * file number — are unchanged, because they describe the same file either way.
 */

export type MilestoneRecipient = {
    dealId: string;
    email: string;
    firstName: string;
    lastName: string;
    /** The recipient's own lead row (all columns). */
    lead: any;
    /** The recipient's own deal row. */
    deal: any;
    /** No `parent_lead_id` — the root of the family. */
    isPrimary: boolean;
};

export type MilestoneSendResult = {
    success: boolean;
    /** Addresses that went into `to` (deduped, primary first). */
    recipients: string[];
    /** Addresses CC'd (the referral agent), if any. */
    cc: string[];
    error?: string;
    /** True when the template was agent_only — `recipients` are agents, not clients. */
    agentOnly?: boolean;
    /**
     * Why nothing was sent, for an outcome that is legitimate rather than a
     * failure: `no_clients` (everyone filtered out by side scoping),
     * `no_agent` (an agent-only template on a file with no agent on it).
     */
    skipped?: "no_clients" | "no_agent";
};

const DEAL_COLUMNS =
    "id, client_id, lead_id, file_number, property_address, lockbox_code, type, closing_date, partner_id";

/**
 * Loads every family deal's client and drops the ones this milestone doesn't
 * concern, then dedupes by address.
 *
 * Deals that resolve to the same inbox (spouses sharing an address) collapse to
 * a single recipient. The primary is sorted first so it anchors the file-level
 * placeholders — its deal is the one that carries the lockbox code, and on a
 * P&S file it is the only party who is both purchaser and seller.
 */
export async function collectMilestoneRecipients(
    dealIds: string[],
    milestoneSide: Side | null,
): Promise<{ recipients: MilestoneRecipient[]; skippedDealIds: string[] }> {
    const recipients: MilestoneRecipient[] = [];
    const skippedDealIds: string[] = [];

    for (const dealId of dealIds) {
        const { data: deal } = await supabaseAdmin
            .from("deals")
            .select(DEAL_COLUMNS)
            .eq("id", dealId)
            .maybeSingle();

        if (!deal?.client_id) {
            skippedDealIds.push(dealId);
            continue;
        }

        const { data: client } = await supabaseAdmin
            .from("clients")
            .select("email, first_name, last_name")
            .eq("id", deal.client_id)
            .maybeSingle();

        if (!client?.email) {
            skippedDealIds.push(dealId);
            continue;
        }

        let lead: any = null;
        if (deal.lead_id) {
            const { data: leadData } = await supabaseAdmin
                .from("leads")
                .select("*")
                .eq("id", deal.lead_id)
                .maybeSingle();
            lead = leadData;
        }

        // Same gate as before, just applied to the recipient list instead of to
        // an individual send. `resolveLeadRecipientSide` is used directly rather
        // than `resolveDealRecipientSide` because the lead row is already loaded.
        if (!shouldEmailForSide(milestoneSide, resolveLeadRecipientSide(lead))) {
            skippedDealIds.push(dealId);
            continue;
        }

        recipients.push({
            dealId,
            email: client.email,
            firstName: client.first_name ?? "",
            lastName: client.last_name ?? "",
            lead,
            deal,
            isPrimary: !lead?.parent_lead_id,
        });
    }

    // Primary first, then family order. Stable so the anchor is deterministic.
    recipients.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));

    const seen = new Set<string>();
    const deduped = recipients.filter((r) => {
        const key = r.email.trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    return { recipients: deduped, skippedDealIds };
}

/** "Alice" / "Alice and Bob" / "Alice, Bob and Carol". */
function joinNames(names: string[]): string {
    const clean = names.map((n) => n.trim()).filter(Boolean);
    if (clean.length === 0) return "";
    if (clean.length === 1) return clean[0];
    return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}`;
}

/**
 * "Shared with agent?" templates CC everyone attached to the file — once for the
 * whole family now, not once per person: the partner's primary agent, any
 * additional `partner_contacts`, and each deal's own `cc_emails`
 * (see buildAgentCcList).
 *
 * The union runs over EVERY recipient's deal, not just the anchor's: a partner
 * contact or one-off CC attached to a single deal in the family must still be
 * copied on the one merged email. Addresses already in `to` are dropped so a
 * client who is also the referring agent doesn't get a duplicate copy.
 */
async function resolveAgentCc(
    template: { shared_with_agent?: boolean | null },
    recipients: MilestoneRecipient[],
    toAddresses: string[],
): Promise<string[]> {
    if (!template.shared_with_agent) return [];

    // One buildAgentCcList call per distinct (partner, deal) pair in the family.
    const pairs = new Map<string, { partnerId: string | null; dealId: string | null }>();
    for (const r of recipients) {
        const partnerId = r.deal?.partner_id ?? r.lead?.partner_id ?? null;
        const dealId = r.deal?.id ?? null;
        pairs.set(`${partnerId ?? ""}|${dealId ?? ""}`, { partnerId, dealId });
    }

    const seen = new Set<string>();
    const out: string[] = [];
    for (const { partnerId, dealId } of pairs.values()) {
        const list = await buildAgentCcList({
            partnerId,
            dealId,
            exclude: toAddresses,
        });
        for (const addr of list) {
            const key = addr.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(addr);
        }
    }

    return out;
}

/**
 * Who an agent-only email is addressed to: the union of every family deal's
 * agent side, with every client address excluded by construction.
 *
 * The union runs over the whole family for the same reason the CC does — a
 * partner contact or per-file CC hanging off one deal still belongs on the one
 * merged email. The greeting name comes from the FIRST partner that has one
 * (the anchor's, since recipients are sorted primary-first), because a single
 * "Hi ..." cannot address two brokerages.
 */
async function resolveAgentAudience(
    recipients: MilestoneRecipient[],
    clientAddresses: string[],
): Promise<{ to: string[]; cc: string[]; agentName: string | null }> {
    const pairs = new Map<string, { partnerId: string | null; dealId: string | null }>();
    for (const r of recipients) {
        const partnerId = r.deal?.partner_id ?? r.lead?.partner_id ?? null;
        const dealId = r.deal?.id ?? null;
        pairs.set(`${partnerId ?? ""}|${dealId ?? ""}`, { partnerId, dealId });
    }

    const seen = new Set<string>();
    const to: string[] = [];
    let agentName: string | null = null;

    for (const { partnerId, dealId } of pairs.values()) {
        const part = await buildAgentRecipients({
            partnerId,
            dealId,
            exclude: clientAddresses,
        });
        if (!agentName && part.agentName) agentName = part.agentName;
        for (const addr of part.to) {
            const key = addr.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            to.push(addr);
        }
    }

    // The standing oversight copy is computed once, against the final To list.
    const cc = to.length
        ? (await buildAgentRecipients({ exclude: [...clientAddresses, ...to] })).cc
        : [];

    return { to, cc, agentName };
}

/**
 * Renders the template once for the whole recipient set and sends a single
 * email. Returns `success: true` with an empty recipient list when there is
 * nobody to email (every family member was filtered out by side scoping) —
 * that is a legitimate outcome, not a failure.
 */
export async function sendCombinedMilestoneEmail(opts: {
    recipients: MilestoneRecipient[];
    milestone: { title?: string | null; status?: string | null };
    template: {
        name?: string | null;
        subject?: string | null;
        body: string;
        shared_with_agent?: boolean | null;
        /** Sends TO the referral agent instead of the client. See the file header. */
        agent_only?: boolean | null;
    };
    /** The firm the file is retained under — sets the sender and the lockup. */
    firm: FirmKey;
    milestoneSide: Side | null;
    /** Conversion passes the just-generated file number; the deal row may not carry it yet. */
    fileNumberOverride?: string | null;
}): Promise<MilestoneSendResult> {
    // The Resend client used to be injected by the caller. It no longer is:
    // which transport carries this email is a property of the FILE'S FIRM, not
    // of whoever happens to be calling, and letting a caller supply the client
    // would let it pick a provider the firm did not choose.
    const { recipients, milestone, template, firm, milestoneSide } = opts;

    if (recipients.length === 0) {
        return { success: true, recipients: [], cc: [], skipped: "no_clients" };
    }

    try {
        // The primary anchors every file-level placeholder (address, file
        // number, lockbox). collectMilestoneRecipients sorts it first.
        const anchor = recipients[0];
        const { lead, deal } = anchor;
        const combined = recipients.length > 1;

        const leadAddress =
            (await buildLeadAddressForEmail(lead)) || deal.property_address || "";
        const leadType = formatLeadTypeLabel(lead?.lead_type ?? deal.type);
        const fileNumber = opts.fileNumberOverride ?? deal.file_number ?? "";

        const firstName = joinNames(recipients.map((r) => r.firstName));
        // Surnames dedupe — a married couple is "Smith", not "Smith and Smith".
        // First names never do: two people who share one still need both listed.
        const lastName = joinNames(Array.from(new Set(recipients.map((r) => r.lastName))));
        const fullName = joinNames(
            recipients.map((r) => `${r.firstName} ${r.lastName}`.trim()),
        );
        const emailList = recipients.map((r) => r.email).join(", ");

        // An agent-only template writes TO the agent. Resolve them before
        // rendering: they are the person the body greets, and a file with no
        // agent on it has nobody to send to at all.
        const agentOnly = !!template.agent_only;
        const clientAddresses = recipients
            .map((r) => normalizeRecipientEmail(r.email))
            .filter(Boolean);
        const agentAudience = agentOnly
            ? await resolveAgentAudience(recipients, clientAddresses)
            : { to: [] as string[], cc: [] as string[], agentName: null as string | null };

        if (agentOnly && agentAudience.to.length === 0) {
            logger.info(
                `[Milestone Email] agent-only template "${template.name ?? ""}" not sent — no agent, partner contact or cc address on this file. milestone: "${milestone?.title ?? ""}"`,
            );
            return { success: true, recipients: [], cc: [], agentOnly: true, skipped: "no_agent" };
        }

        // The greeting. In agent-only mode `user.*` is the AGENT — they are who
        // the email is written to — and the client moves to `client_*`.
        const agentTokens = (agentAudience.agentName ?? "").trim().split(/\s+/).filter(Boolean);
        const agentFirstName = agentTokens[0] ?? "";
        const agentLastName = agentTokens.slice(1).join(" ");
        const agentFullName = (agentAudience.agentName ?? "").trim();
        const agentEmailList = agentAudience.to.join(", ");

        const greetFirst = agentOnly ? agentFirstName : firstName;
        const greetLast = agentOnly ? agentLastName : lastName;
        const greetFull = agentOnly ? agentFullName : fullName;
        const greetEmail = agentOnly ? agentEmailList : emailList;

        // Lock box code is stored per-deal on the primary PURCHASE deal (it's
        // deliberately not mirrored across the family). A co-purchaser's own
        // deal has no code, so fall back to the primary purchaser's deal —
        // it's the same physical property. Sale-side people (co-sellers) never
        // inherit it. `lockboxValue` is bolded for the HTML email; an empty
        // code stays empty so we don't emit an orphan <strong></strong>.
        let lockboxCode = deal.lockbox_code ?? "";
        if (!lockboxCode && lead?.parent_lead_id && lead?.co_person_role === "purchaser") {
            const { data: primaryDeal } = await supabaseAdmin
                .from("deals")
                .select("lockbox_code")
                .eq("lead_id", lead.parent_lead_id)
                .limit(1)
                .maybeSingle();
            lockboxCode = primaryDeal?.lockbox_code ?? "";
        }
        const lockboxValue = lockboxCode ? `<strong>${lockboxCode}</strong>` : "";

        const leadTypeLower = leadType.toLowerCase();
        const sideSuffix = leadTypeLower.includes("purchase") && leadTypeLower.includes("sale")
            ? " (Purchase & Sale)"
            : leadTypeLower === "sale" || (leadTypeLower.includes("sale") && !leadTypeLower.includes("purchase"))
                ? " (Sale)"
                : "";

        const computeRole = (l: any): string => {
            const lt = (l?.lead_type ?? leadType ?? "").toLowerCase().trim();
            const isCombinedType = lt.includes("purchase") && lt.includes("sale");
            const isSaleOnly = lt === "sale" || (lt.includes("sale") && !lt.includes("purchase"));
            if (l?.parent_lead_id) {
                if (isSaleOnly) return "Co-Seller";
                if (isCombinedType && l?.selling_address_street) return "Co-Seller";
                if (lt.includes("purchase") && !isSaleOnly) return "Co-Purchaser";
                if (l?.selling_address_street) return "Co-Seller";
                return "Co-Purchaser";
            }
            if (isCombinedType) return "Purchaser & Seller";
            if (isSaleOnly) return "Seller";
            return "Purchaser";
        };

        // "Your Role: Co-Purchaser" can only be true for one person, so a
        // combined email omits the line entirely rather than mislabel someone.
        const role = computeRole(lead);
        const propertyRoleRow = combined ? "" : role ? `Your Role: ${role}` : "";

        // Per-recipient transaction label: a co-person on a Purchase & Sale deal
        // retains us for only one side, so a solo email shows just that side —
        // Co-Seller → "Sale", Co-Purchaser → "Purchase". The primary client keeps
        // the full "Purchase & Sale" label. Mirrors formatLeadTypeLabelForRecipient
        // in iclosed_web.
        //
        // A combined email has no single recipient to narrow to, so it uses the
        // MILESTONE's side instead — the one label that is true for everyone who
        // survived the side filter. A side-less stage falls back to the file's
        // own type.
        const isPSDeal = leadTypeLower.includes("purchase") && leadTypeLower.includes("sale");
        let displayLeadType = leadType;
        if (combined) {
            if (isPSDeal && milestoneSide === "purchase") displayLeadType = "Purchase";
            else if (isPSDeal && milestoneSide === "sale") displayLeadType = "Sale";
        } else if (isPSDeal && lead?.parent_lead_id) {
            if (role === "Co-Seller") displayLeadType = "Sale";
            else if (role === "Co-Purchaser") displayLeadType = "Purchase";
        }

        // File-level facts ({{ transaction }}, {{ closing_date }},
        // {{ party_summary }}, {{ task_count }}…). A template written for one of
        // the automatic senders is pickable here too, and without these it would
        // email raw "{{ … }}" text. Loaded per recipient because the family a
        // co-person belongs to is resolved from their own lead row.
        const facts = await loadDealTemplateFacts(lead);

        const placeholders: Record<string, string> = {
            // File-level facts first — every explicit key below overrides them,
            // so the recipient-scoped values (their address, their side's lead
            // type) still win.
            ...Object.fromEntries(
                Object.entries(facts).flatMap(([k, v]) => [
                    [`{{ ${k} }}`, v],
                    [`{{${k}}}`, v],
                ]),
            ),
            // User placeholders — whoever this email is ADDRESSED to, which is
            // the agent on an agent-only template and the client otherwise.
            "{{ user.first_name }}": greetFirst,
            "{{ user.last_name }}": greetLast,
            "{{ user.full_name }}": greetFull,
            "{{ user.get_full_name }}": greetFull,
            "{{ user.email }}": greetEmail,
            "{{user.first_name}}": greetFirst,
            "{{user.last_name}}": greetLast,
            "{{user.full_name}}": greetFull,
            "{{user.get_full_name}}": greetFull,
            "{{user.email}}": greetEmail,
            // The client, named explicitly — the only way an agent-only body can
            // say "your client Alice Smith". Always the client, in both modes.
            "{{ client_first_name }}": firstName,
            "{{ client_last_name }}": lastName,
            "{{ client_name }}": fullName,
            "{{ client_full_name }}": fullName,
            "{{ client_email }}": emailList,
            "{{client_first_name}}": firstName,
            "{{client_last_name}}": lastName,
            "{{client_name}}": fullName,
            "{{client_full_name}}": fullName,
            "{{client_email}}": emailList,
            // The agent, named explicitly. Empty on a file whose only agent
            // addresses came from `deals.cc_emails`, where nobody has a name.
            "{{ agent_first_name }}": agentFirstName,
            "{{ agent_name }}": agentFullName,
            "{{agent_first_name}}": agentFirstName,
            "{{agent_name}}": agentFullName,
            // Lead / deal placeholders
            "{{ lead_address }}": leadAddress,
            "{{lead_address}}": leadAddress,
            "{{ lead.address_line1 }}": lead?.address_street ?? deal.property_address ?? "",
            "{{lead.address_line1}}": lead?.address_street ?? deal.property_address ?? "",
            "{{ lead.address_city }}": lead?.address_city ?? "",
            "{{lead.address_city}}": lead?.address_city ?? "",
            "{{ lead.address_province }}": lead?.address_province ?? "",
            "{{lead.address_province}}": lead?.address_province ?? "",
            "{{ lead.file_number }}": fileNumber,
            "{{lead.file_number}}": fileNumber,
            "{{ lead_type }}": displayLeadType,
            "{{lead_type}}": displayLeadType,
            // Milestone placeholders
            "{{ stage_name }}": milestone?.title ?? "",
            "{{stage_name}}": milestone?.title ?? "",
            "{{ stage_status }}": milestone?.status ?? "Completed",
            "{{stage_status}}": milestone?.status ?? "Completed",
            // Short-form aliases (retainer agreement and similar templates)
            "{{ first_name }}": firstName,
            "{{ last_name }}": lastName,
            "{{ full_name }}": fullName,
            "{{ email }}": emailList,
            "{{ property_address }}": leadAddress,
            "{{ lockbox_code }}": lockboxValue,
            "{{lockbox_code}}": lockboxValue,
            "{{ lead.lockbox_code }}": lockboxValue,
            "{{lead.lockbox_code}}": lockboxValue,
            "{{ file_number }}": fileNumber,
            "{{ side_suffix }}": sideSuffix,
            "{{ property_role_row }}": propertyRoleRow,
            "{{first_name}}": firstName,
            "{{last_name}}": lastName,
            "{{full_name}}": fullName,
            "{{email}}": emailList,
            "{{property_address}}": leadAddress,
            "{{file_number}}": fileNumber,
            "{{side_suffix}}": sideSuffix,
            "{{property_role_row}}": propertyRoleRow,
        };

        let processedBody = template.body
            .replace(/&#123;/g, "{")
            .replace(/&#125;/g, "}")
            .replace(/&nbsp;/g, " ")
            .replace(/ /g, " ");
        for (const [key, value] of Object.entries(placeholders)) {
            processedBody = processedBody.replaceAll(key, value);
        }

        // Catch remaining placeholders with flexible whitespace
        for (const [k, v] of Object.entries(facts)) {
            processedBody = processedBody.replace(
                new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "gi"),
                v,
            );
        }
        processedBody = processedBody.replace(/\{\{\s*user\.get_full_name\s*\}\}/gi, greetFull);
        processedBody = processedBody.replace(/\{\{\s*user\.first_name\s*\}\}/gi, greetFirst);
        processedBody = processedBody.replace(/\{\{\s*user\.last_name\s*\}\}/gi, greetLast);
        processedBody = processedBody.replace(/\{\{\s*user\.full_name\s*\}\}/gi, greetFull);
        processedBody = processedBody.replace(/\{\{\s*user\.email\s*\}\}/gi, greetEmail);
        processedBody = processedBody.replace(/\{\{\s*client_first_name\s*\}\}/gi, firstName);
        processedBody = processedBody.replace(/\{\{\s*client_last_name\s*\}\}/gi, lastName);
        processedBody = processedBody.replace(/\{\{\s*client_(full_)?name\s*\}\}/gi, fullName);
        processedBody = processedBody.replace(/\{\{\s*client_email\s*\}\}/gi, emailList);
        processedBody = processedBody.replace(/\{\{\s*agent_first_name\s*\}\}/gi, agentFirstName);
        processedBody = processedBody.replace(/\{\{\s*agent_name\s*\}\}/gi, agentFullName);
        processedBody = processedBody.replace(/\{\{\s*lead_address\s*\}\}/gi, leadAddress);
        processedBody = processedBody.replace(/\{\{\s*lead\.address_line1\s*\}\}/gi, lead?.address_street ?? deal.property_address ?? "");
        processedBody = processedBody.replace(/\{\{\s*lead\.address_city\s*\}\}/gi, lead?.address_city ?? "");
        processedBody = processedBody.replace(/\{\{\s*lead\.address_province\s*\}\}/gi, lead?.address_province ?? "");
        processedBody = processedBody.replace(/\{\{\s*lead\.file_number\s*\}\}/gi, fileNumber);
        processedBody = processedBody.replace(/\{\{\s*lead_type\s*\}\}/gi, displayLeadType);
        processedBody = processedBody.replace(/\{\{\s*stage_name\s*\}\}/gi, milestone?.title ?? "");
        processedBody = processedBody.replace(/\{\{\s*stage_status\s*\}\}/gi, milestone?.status ?? "Completed");
        // Short-form alias fallbacks
        processedBody = processedBody.replace(/\{\{\s*first_name\s*\}\}/gi, firstName);
        processedBody = processedBody.replace(/\{\{\s*last_name\s*\}\}/gi, lastName);
        processedBody = processedBody.replace(/\{\{\s*full_name\s*\}\}/gi, fullName);
        processedBody = processedBody.replace(/\{\{\s*email\s*\}\}/gi, emailList);
        processedBody = processedBody.replace(/\{\{\s*property_address\s*\}\}/gi, leadAddress);
        processedBody = processedBody.replace(/\{\{\s*lockbox_code\s*\}\}/gi, lockboxValue);
        processedBody = processedBody.replace(/\{\{\s*lead\.lockbox_code\s*\}\}/gi, lockboxValue);
        processedBody = processedBody.replace(/\{\{\s*file_number\s*\}\}/gi, fileNumber);
        processedBody = processedBody.replace(/\{\{\s*side_suffix\s*\}\}/gi, sideSuffix);
        processedBody = processedBody.replace(/\{\{\s*property_role_row\s*\}\}/gi, propertyRoleRow);

        // No HTML wrapper / logo injection — the DB template owns its layout.
        const htmlBody = processedBody;

        // Apply placeholder replacement to subject — derived from template only.
        let processedSubject = (template.subject || template.name || "")
            .replace(/&#123;/g, "{")
            .replace(/&#125;/g, "}");
        for (const [key, value] of Object.entries(placeholders)) {
            processedSubject = processedSubject.replaceAll(key, value);
        }
        processedSubject = processedSubject.replace(/\{\{\s*lead_address\s*\}\}/gi, leadAddress);
        processedSubject = processedSubject.replace(/\{\{\s*lead\.file_number\s*\}\}/gi, fileNumber);
        processedSubject = processedSubject.replace(/\{\{\s*user\.first_name\s*\}\}/gi, greetFirst);
        processedSubject = processedSubject.replace(/\{\{\s*user\.full_name\s*\}\}/gi, greetFull);
        processedSubject = processedSubject.replace(/\{\{\s*client_(full_)?name\s*\}\}/gi, fullName);
        processedSubject = processedSubject.replace(/\{\{\s*agent_first_name\s*\}\}/gi, agentFirstName);
        processedSubject = processedSubject.replace(/\{\{\s*agent_name\s*\}\}/gi, agentFullName);
        processedSubject = processedSubject.replace(/\{\{\s*first_name\s*\}\}/gi, firstName);
        processedSubject = processedSubject.replace(/\{\{\s*full_name\s*\}\}/gi, fullName);
        processedSubject = processedSubject.replace(/\{\{\s*property_address\s*\}\}/gi, leadAddress);
        processedSubject = processedSubject.replace(/\{\{\s*file_number\s*\}\}/gi, fileNumber);
        processedSubject = processedSubject.replace(/\{\{\s*side_suffix\s*\}\}/gi, sideSuffix);

        // Agent-only: the agents are the recipients and the clients are on
        // neither line. Otherwise: the clients, with the agent CC'd if the
        // template says to share it.
        const to = agentOnly ? agentAudience.to : clientAddresses;
        const cc = agentOnly
            ? agentAudience.cc
            : await resolveAgentCc(template, recipients, to);

        const sendResult = await sendEmail(
            {
                to,
                ...(cc.length ? { cc } : {}),
                subject: processedSubject,
                html: brandEmailHtml(htmlBody, firm),
            },
            { firm, label: "milestone" },
        );

        if (!sendResult.ok) {
            return { success: false, recipients: to, cc, agentOnly, error: sendResult.error };
        }

        logger.info(
            `[Milestone Email] Sent${agentOnly ? " (agent only)" : ""} to ${to.join(", ")}` +
            `${cc.length ? ` (cc ${cc.length}: ${cc.join(", ")})` : template.shared_with_agent ? " (shared_with_agent on, but no cc addresses on file — no cc)" : ""}` +
            `, milestone: "${milestone?.title ?? ""}", id: ${sendResult.id}`,
        );

        return { success: true, recipients: to, cc, agentOnly };
    } catch (err: any) {
        return { success: false, recipients: [], cc: [], error: err.message };
    }
}

/**
 * An auto-completed milestone whose email is still owed, handed back by
 * `convertSingleLead` instead of being sent inline.
 */
export type PendingMilestoneEmail = {
    milestoneId: string;
    dealId: string;
    stageTemplateId: string;
    emailTemplateId: string;
    stageName: string;
    /** Freshly generated at conversion — the deal row may not carry it yet. */
    fileNumber: string | null;
};

/**
 * Sends the auto-complete milestone emails a conversion earned — one combined
 * email per stage, after the whole family exists.
 *
 * Conversion runs `convertSingleLead` once per family member, so sending inline
 * meant the primary and each co-client got their own copy of the same stage
 * email (and the referral agent got one CC per party). Callers collect the
 * pending entries across the whole family convert and call this once at the end.
 *
 * A party who has ALREADY had this stage's email — the primary, when a
 * co-purchaser is added to a file months later — is dropped from the recipient
 * list, so a late addition emails only the new party. Never throws: an email
 * failure must not fail a conversion.
 */
export async function dispatchAutoCompleteMilestoneEmails(
    entries: PendingMilestoneEmail[],
): Promise<void> {
    if (!entries.length) return;

    if (!process.env.RESEND_API_KEY) {
        logger.warn("[Convert] Auto-complete emails skipped — RESEND_API_KEY not configured");
        return;
    }


    // One send per stage, not per party: every family member's copy of the same
    // auto-completed stage collapses into a single group.
    const byStage = new Map<string, PendingMilestoneEmail[]>();
    for (const entry of entries) {
        const group = byStage.get(entry.stageTemplateId);
        if (group) group.push(entry);
        else byStage.set(entry.stageTemplateId, [entry]);
    }

    for (const [stageTemplateId, group] of byStage) {
        try {
            const { data: template } = await supabaseAdmin
                .from("email_templates")
                .select("name, subject, body, is_active, shared_with_agent, agent_only")
                .eq("id", group[0].emailTemplateId)
                .maybeSingle();

            if (!template?.body) continue;

            // Strict is_active check — skip the auto-complete email if admin
            // disabled this template. Milestones stay completed.
            if (!template.is_active) {
                logger.info(
                    `[Convert] Auto-complete email skipped — template "${template.name}" is inactive. stage="${group[0].stageName}"`,
                );
                continue;
            }

            const milestoneSide = await resolveMilestoneSide({ stage_template_id: stageTemplateId });
            const familyDealIds = await getFamilyDealIds(group[0].dealId);

            // Anyone whose copy of this stage was already emailed drops out —
            // that is how adding a co-client later emails only the newcomer.
            const { data: stageMilestones } = await supabaseAdmin
                .from("milestones")
                .select("id, deal_id, email_sent")
                .eq("stage_template_id", stageTemplateId)
                .in("deal_id", familyDealIds);

            const alreadySent = new Set(
                (stageMilestones ?? []).filter((m) => m.email_sent).map((m) => m.deal_id),
            );

            const { recipients } = await collectMilestoneRecipients(familyDealIds, milestoneSide);
            const pending = recipients.filter((r) => !alreadySent.has(r.dealId));

            if (!pending.length) continue;

            const result = await sendCombinedMilestoneEmail({
                recipients: pending,
                milestone: { title: group[0].stageName, status: "Completed" },
                template,
                // Every entry in a stage group is one family's file, so any of
                // them answers for the firm.
                firm: await getDealFirmKey(group[0].dealId ?? null),
                milestoneSide,
                fileNumberOverride: group[0].fileNumber,
            });

            if (!result.success) {
                logger.error(
                    `[Convert] Auto-complete email failed for stage "${group[0].stageName}":`,
                    result.error,
                );
                continue;
            }

            // Mark every family copy of this stage, including the wrong-side
            // ones we deliberately did not email — otherwise they look un-sent
            // and get retried forever. Mirrors the send-milestone-email route.
            const milestoneIds = (stageMilestones ?? []).map((m) => m.id);
            if (milestoneIds.length) {
                await supabaseAdmin
                    .from("milestones")
                    .update({ email_sent: true })
                    .in("id", milestoneIds);
            }
        } catch (err) {
            logger.error("[Convert] Auto-complete email failed (non-blocking):", err);
        }
    }
}
