// Who the clerk emails are addressed to.
//
// This is the one part of "Email to Clerk" nobody sees before it is too late: a
// wrong address does not fail, it delivers a client's whole document package —
// ID, agreements, personal information — to somebody who should not have it, and
// the send is already audited as successful. So the routing rules the firm gave
// are pinned here rather than left to a comment:
//
//   Purchase        → iclosed.purchase@navawilson.law
//   Sale            → iclosed.sale@navawilson.law
//   Purchase & Sale → both, on ONE email
//   every file      → aliya@navawilson.law as well
//
// No network, no credentials: the functions under test read process.env and
// return strings. They live in clerkRecipients.ts precisely so this file can
// import them without dragging in Supabase, the email transport or the PDF
// builder that the sender itself needs.

import assert from "node:assert/strict";
import test from "node:test";

import {
  clerkRecipientsForType,
  clerkDocumentRecipients,
  alwaysClerkRecipients,
} from "../src/lib/clerkRecipients.ts";

const PURCHASE = "iclosed.purchase@navawilson.law";
const SALE = "iclosed.sale@navawilson.law";
const ALWAYS = "aliya@navawilson.law";

const CLERK_VARS = [
  "CLERK_PURCHASE_EMAIL",
  "CLERK_SALE_EMAIL",
  "CLERK_ALWAYS_EMAIL",
  "CLERK_DOCUMENTS_EMAIL",
] as const;

/** Run `fn` with every clerk override cleared, then put the environment back. */
function withCleanEnv(fn: () => void, overrides: Record<string, string> = {}) {
  const saved = new Map<string, string | undefined>();
  for (const key of CLERK_VARS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const key of Object.keys(overrides)) {
      if (!saved.has(key)) delete process.env[key];
    }
  }
}

test("the built-in defaults are the firm's addresses", () => {
  withCleanEnv(() => {
    assert.deepEqual(clerkDocumentRecipients("Purchase"), [PURCHASE, ALWAYS]);
    assert.deepEqual(clerkDocumentRecipients("Sale"), [SALE, ALWAYS]);
    assert.deepEqual(alwaysClerkRecipients(), [ALWAYS]);
  });
});

test("a Purchase & Sale file mails both clerks once, on one email", () => {
  withCleanEnv(() => {
    const to = clerkDocumentRecipients("Purchase & Sale");
    assert.deepEqual(to, [PURCHASE, SALE, ALWAYS]);
    // Deduped: one email each, never a duplicate row in the To: header.
    assert.equal(new Set(to).size, to.length);
  });
});

test("the type match is case- and wording-insensitive", () => {
  withCleanEnv(() => {
    for (const raw of ["purchase", "  Purchase  ", "Purchase of 12 Main St"]) {
      assert.deepEqual(clerkDocumentRecipients(raw), [PURCHASE, ALWAYS], raw);
    }
    for (const raw of ["sale", "SALE", "Sale of 12 Main St"]) {
      assert.deepEqual(clerkDocumentRecipients(raw), [SALE, ALWAYS], raw);
    }
    // "purchase and sale" names both sides, so it routes like the combined type.
    assert.deepEqual(clerkDocumentRecipients("purchase and sale"), [PURCHASE, SALE, ALWAYS]);
  });
});

test("a file with no side still reaches the always-address", () => {
  withCleanEnv(() => {
    // Refinance and a blank type name neither side. The document package is
    // still somebody's to receive, so it goes to the supervising address rather
    // than failing the send.
    assert.deepEqual(clerkDocumentRecipients("Refinance"), [ALWAYS]);
    assert.deepEqual(clerkDocumentRecipients(""), [ALWAYS]);
    assert.deepEqual(clerkDocumentRecipients(null), [ALWAYS]);
  });
});

test("the deposit-proof routing is deliberately stricter than the document routing", () => {
  withCleanEnv(() => {
    // Shared with sendDepositProofEmail: a side it cannot name means no
    // recipients and no email, rather than telling a supervisor that closing
    // funds arrived on a file that has no purchase or sale side.
    assert.deepEqual(clerkRecipientsForType("Refinance"), []);
    // The two agree everywhere a side IS named.
    for (const raw of ["Purchase", "Sale", "Purchase & Sale"]) {
      assert.deepEqual(clerkRecipientsForType(raw), clerkDocumentRecipients(raw), raw);
    }
  });
});

test("an environment override replaces a side without dropping the always-address", () => {
  withCleanEnv(
    () => {
      assert.deepEqual(clerkDocumentRecipients("Purchase"), ["tester@example.com", ALWAYS]);
      // The sale side is untouched by the purchase override.
      assert.deepEqual(clerkDocumentRecipients("Sale"), [SALE, ALWAYS]);
    },
    { CLERK_PURCHASE_EMAIL: "tester@example.com" },
  );
});

test("comma-separated overrides are split and trimmed", () => {
  withCleanEnv(
    () => {
      assert.deepEqual(clerkDocumentRecipients("Sale"), [
        "a@example.com",
        "b@example.com",
        "sup1@example.com",
        "sup2@example.com",
      ]);
    },
    {
      CLERK_SALE_EMAIL: " a@example.com , b@example.com ",
      CLERK_ALWAYS_EMAIL: "sup1@example.com, sup2@example.com",
    },
  );
});

test('CLERK_ALWAYS_EMAIL="off" drops the supervising address entirely', () => {
  withCleanEnv(
    () => {
      assert.deepEqual(clerkDocumentRecipients("Purchase"), [PURCHASE]);
      assert.deepEqual(alwaysClerkRecipients(), []);
      // With no side AND no always-address there is nobody left; the caller
      // refuses to send rather than guessing an inbox.
      assert.deepEqual(clerkDocumentRecipients("Refinance"), []);
    },
    { CLERK_ALWAYS_EMAIL: "off" },
  );
});
