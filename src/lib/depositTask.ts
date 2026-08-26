/**
 * The closing-funds task: "Deposit Funds Into Our Trust Account".
 *
 * Three things live here because both this app and the customer portal need
 * them to agree (the portal keeps a mirror at
 * D:\iclosed_dev_web\src\lib\depositTask.ts — keep the two in sync, the same way
 * taskKinds.ts is mirrored):
 *
 *   1. isDepositTask()      which task row this is, matched by title
 *   2. isTaskInactive()     the derived third state (see the 2026-08-26 migration)
 *   3. FUNDS_TRANSFER       the firm's trust-account details, shown to the client
 *
 * Detection is by title rather than template id because tasks.title is a
 * per-deal snapshot and a file can be seeded from either repo's conversion path;
 * a title match is the only key both sides can compute without a lookup.
 */

export function isDepositTask(title: string | null | undefined): boolean {
  return (title ?? "").toLowerCase().includes("deposit funds into our trust account");
}

/** `lead_corporate_docs.doc_type` for the admin-uploaded Final Statement of Account. */
export const STATEMENT_OF_ACCOUNT_DOC_TYPE = "statement_of_account";

/** Label of the client's single form field, seeded by the migration. */
export const PROOF_OF_DEPOSIT_FIELD_LABEL = "Upload Proof of Deposit";

/**
 * `lead_corporate_docs.doc_type` for the client's uploaded proof — set on the
 * form field's `options.doc_type` by the migration. It is the reliable way to
 * find the document: `task_responses.file_url` is frequently null on file rows.
 */
export const PROOF_OF_DEPOSIT_DOC_TYPE = "proof_of_deposit";

/**
 * A task an admin has not switched on yet: on the file, off the client's
 * dashboard, and excluded from the milestone rollup / all-tasks-complete alert.
 * Displayed as "Inactive"; `status` itself stays Pending throughout.
 */
export function isTaskInactive(task: {
  activation_required?: boolean | null;
  activated_at?: string | null;
}): boolean {
  return !!task.activation_required && !task.activated_at;
}

/** What the client is asked to do, shown above the transfer instructions. */
export const DEPOSIT_TASK_DESCRIPTION =
  "Your closing funds must be in our trust account before we can complete your " +
  "transaction. Please send us the balance due on closing using any of the three " +
  "options below, then upload your proof of deposit here.";

export type FundsTransferOption = {
  /** Heading, numbered 1..3 in the order given. */
  title: string;
  /** Lead sentence, rendered above the detail rows. */
  intro?: string;
  /** Bulleted lines under the intro. */
  bullets?: string[];
  /** Labelled detail rows — "BENEFICIARY", "TRANSIT", etc. */
  rows?: { label: string; lines: string[] }[];
  /** The deadline, shown in the firm's red at the foot of the column. */
  deadline: string;
};

/**
 * The firm's trust-account details.
 *
 * Deliberately code, not a database row or the static "Funding Instructions"
 * PDF: these are rendered inline on the task (and inside the client's email), so
 * a purchaser reads them without opening an attachment, and there is exactly one
 * copy of the account numbers in the product. Changing the firm's banking means
 * editing this constant in BOTH repos and shipping — which is the intent: a
 * trust account number is not something staff should be able to retype in an
 * admin form.
 */
export const FUNDS_TRANSFER: FundsTransferOption[] = [
  {
    title: "Bank Draft / Certified Cheque",
    intro: 'Payable to "Nava Wilson Professional Corporation, in trust", then either:',
    bullets: [
      "Deposit at any TD Canada Trust branch, or",
      "Drop off at our office: 10 Milner Business Court, Unit 210, Scarborough, ON",
    ],
    deadline: "Deposit by 12:00pm on closing day",
  },
  {
    title: "Wire Transfer",
    rows: [
      {
        label: "Beneficiary",
        lines: [
          "Nava Wilson Professional Corporation",
          "10 Milner Business Crt, Unit 210",
          "Toronto, ON M1B 3C6",
        ],
      },
      {
        label: "Bank",
        lines: ["TD Canada Trust", "1571 Sandhurst Cir, Scarborough, ON M1V 1V2"],
      },
      { label: "Transit", lines: ["03302"] },
      { label: "Account", lines: ["5278508"] },
    ],
    deadline: "Send 2+ business days before closing",
  },
  {
    title: "Bank to Bank (TD to TD)",
    intro: "Only if you hold an account with The Toronto-Dominion Bank.",
    bullets: ["Deposit at any TD Canada Trust branch"],
    rows: [
      { label: "Account name", lines: ["Nava Wilson Professional Corporation, in trust"] },
      { label: "Transit", lines: ["03302"] },
      { label: "Account", lines: ["7929-5278508"] },
      { label: "Branch", lines: ["1571 Sandhurst Circle, Scarborough, ON M1V 1V2"] },
    ],
    deadline: "Deposit by 12:00pm on closing day",
  },
];
