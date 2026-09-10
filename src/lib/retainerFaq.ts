import { getFirm, type FirmKey, type FirmProfile } from "@/lib/firms";

/**
 * Single source of truth for the retainer FAQ — MIRROR of the portal's
 * `iclosed_dev_web/src/lib/retainerFaq.ts`. Keep the two identical.
 *
 * The portal shows this wording on screen and renders it into the PDF at
 * signing; this repo re-renders that same PDF when it emails the agreement, so
 * a client comparing the copy they signed against the copy they were sent has
 * to find the same words. Editing one copy and not the other is how they drift.
 *
 * ── Firm-dependent wording ──────────────────────────────────────────────
 * iClosed serves clients under two entities, and the retainer is the document
 * where that actually matters: it has to name the firm the client is retaining.
 * Three answers below carry the entity name, and they are built from the firm
 * profile rather than written out twice:
 *
 *   Nava Wilson  →  "iClosed, powered by Nava Wilson PC" / "Nava Wilson PC"
 *   iClosed LLP  →  "iClosed LLP" throughout, with no mention of Nava Wilson
 *
 * Everything else is identical between the firms. "your iClosed client portal"
 * stays as it is on purpose — that is the PRODUCT, which both firms use, not
 * the legal entity.
 */
export interface RetainerFaqItem {
  question: string;
  answer: string;
}

/**
 * The FAQ as the given firm's clients must read it.
 *
 * @param firm A firm key, a firm profile, or anything coercible — an
 *             unrecognised value resolves to Nava Wilson, the pre-firms
 *             default, which is what every existing retainer already says.
 */
export function getRetainerFaqItems(
  firm: FirmKey | FirmProfile | null | undefined,
): RetainerFaqItem[] {
  const profile =
    typeof firm === "object" && firm !== null ? firm : getFirm(firm);

  return [
    {
      question: "Who are we?",
      answer: `We are ${profile.introName}, an Ontario law firm focused exclusively on real estate transactions. We handle purchases, sales, refinances, and title transfers\u2014all through secure digital platforms, including video signing.`,
    },
    {
      question: "Who is the lawyer or law firm representing me?",
      answer: `Your transaction will be handled by a licensed Ontario lawyer at ${profile.legalName}.`,
    },
    {
      question: "What legal services are included in this retainer?",
      answer:
        "Our retainer covers the full scope of legal work needed to close your real estate transaction, including title search, document preparation, registration, and trust account management.",
    },
    {
      question: "How do I sign documents and communicate with you?",
      answer:
        "All documents can be signed electronically through our secure platform. You can communicate with our team via email, phone, or through your client portal at any time.",
    },
    {
      question: "How do I provide my ID and documents?",
      answer:
        "You can securely upload your identification and documents through your iClosed client portal. We accept standard government-issued photo ID and will guide you through the process.",
    },
    {
      question: "How long does this retainer last?",
      answer:
        "This retainer remains in effect until your real estate transaction is completed and all related legal matters are resolved. You may terminate the retainer at any time by providing written notice.",
    },
    {
      question: "What are your obligations as our client?",
      answer:
        "As our client, you are expected to provide accurate information, respond to requests in a timely manner, and ensure funds are available when required for closing.",
    },
    {
      question: "What happens if I want to cancel?",
      answer:
        "You have the right to cancel this retainer at any time. If you cancel, you will only be responsible for fees and disbursements incurred up to the date of cancellation.",
    },
    {
      question: "Is this agreement legally binding?",
      answer: `Yes, once you sign and submit this retainer agreement, it becomes a legally binding contract between you and ${profile.legalName} for the provision of legal services related to your transaction.`,
    },
    {
      question: "Who can I contact with questions?",
      answer:
        "You can reach our team through your client portal, by email, or by phone during business hours. Your assigned closing manager will be your primary point of contact.",
    },
  ];
}

/**
 * The sentence above the signature block.
 *
 * Lives here rather than beside each renderer because the page and the PDF must
 * say the same thing — the screen is what the client reads before agreeing, and
 * the PDF is what they are held to.
 */
export function retainerAgreementLine(
  firm: FirmKey | FirmProfile | null | undefined,
): string {
  const profile =
    typeof firm === "object" && firm !== null ? firm : getFirm(firm);
  return `I agree to retain ${profile.legalName} to represent me in my real estate transaction under the terms outlined above.`;
}
