// What the two package emails actually put on the wire.
//
// Both "Email to Clerk" (sendClerkDocumentsEmail.ts) and the all-tasks-complete
// alert (notifyAllTasksComplete.ts) attach a file's GENERATED pages — personal
// information, property information, one PDF per task of that task's typed
// answers — before handing the rest of the budget to the document sweep. For a
// long time only the clerk email did: the alert went out on 2026-09-15 for
// #26P-0564 with 14 uploads and not one line of the clients' details, because
// those details are answers a client TYPED and collectFamilyDocuments reads
// task_responses filtered to `field_type = "file"`. Nothing in a document sweep
// could ever have stood in for them.
//
// So the two things worth pinning are the two halves of that fix:
//   • the generated pages become attachments, named for filing; and
//   • when one cannot be attached it is REPORTED, never quietly dropped — a
//     generated page has no blob behind it, so unlike an oversized document it
//     cannot fall back to a download link.
//
// No network and no credentials: packageAttachments.ts takes its data as
// arguments and imports nothing but types, which is exactly why the packing
// rules were split out of dealPackage.ts to live there (the same move
// clerkRecipients.ts made for the addresses).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  dedupeAttachmentNames,
  packageEntryAttachments,
  reconcileTaskCoverage,
  renderPackageSummaryHtml,
  renderUncoveredTasksHtml,
} from "../src/lib/packageAttachments.ts";

type Entry = Parameters<typeof packageEntryAttachments>[0][number];

/** A generated entry of `size` bytes — the content is irrelevant to packing. */
function entry(
  title: string,
  kind: Entry["kind"],
  size: number,
  consumedUrls: string[] = [],
): Entry {
  return { title, kind, bytes: new Uint8Array(size), documents: 0, consumedUrls };
}

test("the generated pages become attachments, filed under the file number", () => {
  const result = packageEntryAttachments(
    ([
      entry("Personal Information", "personal-info", 1_000),
      entry("Property Information", "property", 500),
    ]),
    { fileNumber: "26P-0564", budgetBytes: 25 * 1024 * 1024 },
  );

  assert.deepEqual(
    result.attachments.map((a) => a.filename),
    ["26P-0564 - Personal Information.pdf", "26P-0564 - Property Information.pdf"],
  );
  assert.equal(result.bytes, 1_500);
  assert.deepEqual(result.omitted, []);
});

test("no file number — the entries still travel, under their own titles", () => {
  const result = packageEntryAttachments(
    ([entry("Personal Information", "personal-info", 10)]),
    { fileNumber: "", budgetBytes: 1_000 },
  );

  assert.deepEqual(
    result.attachments.map((a) => a.filename),
    ["Personal Information.pdf"],
  );
});

test("task answer PDFs are counted by kind, not by title", () => {
  // Counting by title is what went stale when the APS and property entries were
  // added — "Property Information" is not a task, and a task called anything at
  // all is.
  const result = packageEntryAttachments(
    ([
      entry("Personal Information", "personal-info", 10),
      entry("Property Information", "property", 10),
      entry("Identification", "identification", 10),
      entry("Home Insurance", "task", 10),
      entry("Lockbox Code", "task", 10),
      entry("Other Answers", "leftover", 10),
    ]),
    { fileNumber: "26P-0564", budgetBytes: 1_000 },
  );

  assert.equal(result.taskPdfs, 3);
  assert.equal(result.attachments.length, 6);
});

test("blobs that reached an entry come back, so the sweep can skip them", () => {
  const result = packageEntryAttachments(
    ([
      entry("Identification", "identification", 10, ["blob://id-1", "blob://id-2"]),
      entry("Personal Information", "personal-info", 10),
    ]),
    { fileNumber: "26P-0564", budgetBytes: 1_000 },
  );

  assert.deepEqual([...result.consumedUrls].sort(), ["blob://id-1", "blob://id-2"]);
});

test("an entry that does not fit is REPORTED, not silently dropped", () => {
  const result = packageEntryAttachments(
    ([
      entry("Personal Information", "personal-info", 400),
      entry("Property Information", "property", 5_000),
      entry("Home Insurance", "task", 100),
    ]),
    { fileNumber: "26P-0564", budgetBytes: 1_000 },
  );

  // The oversized entry is skipped and NAMED; packing continues, so a small
  // entry behind it is not punished for the big one in front.
  assert.deepEqual(result.omitted, ["Property Information"]);
  assert.deepEqual(
    result.attachments.map((a) => a.filename),
    ["26P-0564 - Personal Information.pdf", "26P-0564 - Home Insurance.pdf"],
  );
  assert.equal(result.bytes, 500);
});

test("an empty package spends nothing and reports nothing missing", () => {
  const result = packageEntryAttachments(([]), {
    fileNumber: "26P-0564",
    budgetBytes: 1_000,
  });

  assert.deepEqual(result.attachments, []);
  assert.deepEqual(result.omitted, []);
  assert.equal(result.bytes, 0);
  assert.equal(result.taskPdfs, 0);
});

test("the email body names the personal information the clerks were missing", () => {
  const html = renderPackageSummaryHtml({
    identification: 0,
    aps: 0,
    personalInfo: 2,
    propertyInfo: 3,
    taskPdfs: 4,
    separate: 14,
  });

  assert.match(html, /Personal Information/);
  assert.match(html, /all 2 clients'/);
  assert.match(html, /Property Information/);
  assert.match(html, /4 task PDFs/);
  assert.match(html, /14 documents/);
});

test("the email body says which section was left off", () => {
  const html = renderPackageSummaryHtml({
    identification: 0,
    aps: 0,
    personalInfo: 1,
    propertyInfo: 0,
    taskPdfs: 0,
    separate: 2,
    omitted: ["Property Information"],
  });

  assert.match(html, /too large to attach/);
  assert.match(html, /Property Information/);
});

test("nothing to describe renders nothing at all", () => {
  assert.equal(
    renderPackageSummaryHtml({
      identification: 0,
      aps: 0,
      personalInfo: 0,
      propertyInfo: 0,
      taskPdfs: 0,
      separate: 0,
    }),
    "",
  );
});

// ── Nothing leaves without a name of its own, and nothing leaves unaccounted ──
//
// The two guards added after "2 files (personal information) missing in the
// email to clerk", 2026-09-16. Neither half of the message could see the other:
// the generated entries were named `<file number> - <entry title>.pdf` with no
// dedupe at all, the documents were named
// `<file number> - <task name> - <client name>.<ext>` and deduped only among
// themselves, and nothing anywhere asked whether a task had reached the email.

test("attachments sharing a name are numbered rather than left to collide", () => {
  const out = dedupeAttachmentNames([
    { filename: "26P-0564 - Mortgage Details - Jane Doe.pdf", content: Buffer.from("a") },
    { filename: "26P-0564 - Mortgage Details - Jane Doe.pdf", content: Buffer.from("b") },
    { filename: "26P-0564 - Personal Information.pdf", content: Buffer.from("c") },
    { filename: "26P-0564 - Mortgage Details - Jane Doe.pdf", content: Buffer.from("d") },
  ]);

  assert.deepEqual(
    out.map((a) => a.filename),
    [
      "26P-0564 - Mortgage Details - Jane Doe.pdf",
      "26P-0564 - Mortgage Details - Jane Doe (2).pdf",
      "26P-0564 - Personal Information.pdf",
      "26P-0564 - Mortgage Details - Jane Doe (3).pdf",
    ],
  );
  // Every attachment survives — numbering, not dropping, is the fix.
  assert.equal(out.length, 4);
  assert.deepEqual(new Set(out.map((a) => a.filename)).size, 4);
});

test("a name collision across the two halves is caught, not just within one", () => {
  // The generated entry for a two-party task and a PDF uploaded against that
  // same task by that same person are built by rules that never see each other.
  const generated = packageEntryAttachments(
    [entry("Mortgage Details - Jane Doe", "task", 100)],
    { fileNumber: "26P-0564", budgetBytes: 25 * 1024 * 1024 },
  );
  const documents = [
    { filename: "26P-0564 - Mortgage Details - Jane Doe.pdf", content: Buffer.from("x") },
  ];

  const out = dedupeAttachmentNames([...generated.attachments, ...documents]);
  assert.equal(new Set(out.map((a) => a.filename)).size, 2);
});

test("a task carried by an attached entry is covered", () => {
  const uncovered = reconcileTaskCoverage(
    [
      {
        taskId: "t1",
        title: "Provide Personal Information",
        owner: "Jane Doe",
        entryTitle: "Personal Information",
        fileUrls: [],
      },
    ],
    [],
    new Set(),
  );
  assert.deepEqual(uncovered, []);
});

test("a task covered only by one of its uploads still counts as covered", () => {
  const uncovered = reconcileTaskCoverage(
    [
      {
        taskId: "t1",
        title: "Upload Identification",
        owner: "Jane Doe",
        entryTitle: null,
        fileUrls: ["https://blob/licence.jpg", "https://blob/passport.jpg"],
      },
    ],
    [],
    // Attached OR linked — a link the recipient can open is delivery too.
    new Set(["https://blob/passport.jpg"]),
  );
  assert.deepEqual(uncovered, []);
});

test("a task whose entry was omitted for budget is reported as uncovered", () => {
  const uncovered = reconcileTaskCoverage(
    [
      {
        taskId: "t1",
        title: "Provide Personal Information",
        owner: "Jane Doe",
        entryTitle: "Personal Information",
        fileUrls: [],
      },
    ],
    ["Personal Information"],
    new Set(),
  );
  assert.deepEqual(uncovered, [
    { label: "Provide Personal Information — Jane Doe", reason: "entry_omitted" },
  ]);
});

test("a task with neither an entry nor a reachable upload is reported", () => {
  const uncovered = reconcileTaskCoverage(
    [
      {
        taskId: "t1",
        title: "Provide Personal Information",
        owner: "Jane Doe",
        entryTitle: null,
        fileUrls: [],
      },
      {
        taskId: "t2",
        title: "Home Insurance",
        owner: "",
        entryTitle: null,
        fileUrls: ["https://blob/policy.pdf"],
      },
    ],
    [],
    new Set(),
  );
  assert.deepEqual(uncovered, [
    { label: "Provide Personal Information — Jane Doe", reason: "no_entry" },
    { label: "Home Insurance", reason: "documents_unreachable" },
  ]);
});

test("the uncovered block names every task and is empty when nothing is missing", () => {
  assert.equal(renderUncoveredTasksHtml([]), "");

  const html = renderUncoveredTasksHtml([
    { label: "Provide Personal Information — Jane Doe", reason: "no_entry" },
    { label: "Provide Personal Information — John <Doe>", reason: "no_entry" },
  ]);
  assert.match(html, /2 tasks are NOT on this email/);
  assert.match(html, /Provide Personal Information — Jane Doe/);
  // Client-supplied names are escaped like everywhere else in these bodies.
  assert.match(html, /John &lt;Doe&gt;/);
  assert.doesNotMatch(html, /John <Doe>/);
});
