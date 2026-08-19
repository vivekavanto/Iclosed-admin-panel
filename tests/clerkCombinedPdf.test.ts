// The two merged PDFs "Email to Clerk" / "Download All" send: every party's
// identification in one document, every party's personal information in another.
//
// Layout only — clerkCombinedPdf.ts takes its data (blob bytes included) as
// arguments, so these run with no database, no blob store and no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import {
  detectDocKind,
  renderIdentificationPdf,
  renderPersonalInfoPdf,
  winAnsiSafe,
  type ClerkIdDoc,
  type ClerkPerson,
} from "../src/lib/clerkCombinedPdf.ts";

const PEOPLE: ClerkPerson[] = [
  { leadId: "lead-1", name: "Pavithra Kumar" },
  { leadId: "lead-2", name: "Ravi Kumar" },
];

/** A real n-page PDF, so copyPages has something genuine to merge. */
async function samplePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    doc.addPage([300, 300]).drawText(`page ${i + 1}`, { x: 20, y: 260, size: 12, font });
  }
  return doc.save();
}

/** A real 1x1 PNG, so embedPng has something genuine to decode. */
const PNG_1PX = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const doc = (leadId: string, fileUrl: string, label: string): ClerkIdDoc => ({
  leadId,
  fileUrl,
  fileName: `${label}.png`,
  label,
});

async function pageCount(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes)).getPageCount();
}

test("winAnsiSafe keeps what pdf-lib's standard fonts can encode", () => {
  // Latin-1 survives; typography is folded down; anything else becomes "?" so
  // drawText never throws mid-send.
  assert.equal(winAnsiSafe("Ramírez — “quoted”"), 'Ramírez - "quoted"');
  assert.equal(winAnsiSafe("2615 Ellesmere Rd #4"), "2615 Ellesmere Rd #4");
  assert.equal(winAnsiSafe("日本"), "??");
  assert.equal(winAnsiSafe(null), "");
});

test("detectDocKind trusts the magic bytes over the file name", async () => {
  const pdf = await samplePdf(1);
  assert.equal(detectDocKind(pdf, "1759923628_1759"), "pdf");
  assert.equal(detectDocKind(PNG_1PX, "scan.jpg"), "png");
  // No usable bytes — fall back to the name.
  assert.equal(detectDocKind(new Uint8Array(), "licence.jpeg"), "jpg");
  assert.equal(detectDocKind(new Uint8Array(), "photo.heic"), "other");
});

test("identification: every party's ID lands in ONE pdf, each behind a name page", async () => {
  const docsByLead = new Map<string, ClerkIdDoc[]>([
    ["lead-1", [doc("lead-1", "u1", "Passport"), doc("lead-1", "u2", "Driver Licence")]],
    ["lead-2", [doc("lead-2", "u3", "Passport")]],
  ]);

  const result = await renderIdentificationPdf({
    people: PEOPLE,
    docsByLead,
    fileNumber: "26S-0356",
    fetchBytes: async () => PNG_1PX,
  });

  assert.ok(result);
  assert.equal(result.count, 3);
  assert.deepEqual(result.consumedUrls, ["u1", "u2", "u3"]);
  assert.deepEqual(result.skipped, []);
  // Two divider pages (one per party) + one page per image.
  assert.equal(await pageCount(result.bytes), 5);
});

test("identification: a single party gets no divider pages", async () => {
  const result = await renderIdentificationPdf({
    people: [PEOPLE[0]],
    docsByLead: new Map([["lead-1", [doc("lead-1", "u1", "Passport")]]]),
    fileNumber: "26S-0356",
    fetchBytes: async () => PNG_1PX,
  });

  assert.ok(result);
  assert.equal(await pageCount(result.bytes), 1);
});

test("identification: an uploaded PDF's own pages are merged in", async () => {
  const pdf = await samplePdf(3);
  const result = await renderIdentificationPdf({
    people: [PEOPLE[0]],
    docsByLead: new Map([["lead-1", [{ ...doc("lead-1", "u1", "Passport"), fileName: "id.pdf" }]]]),
    fileNumber: "26S-0356",
    fetchBytes: async () => pdf,
  });

  assert.ok(result);
  assert.equal(result.count, 1);
  assert.equal(await pageCount(result.bytes), 3);
});

test("identification: what can't be embedded is skipped, not consumed", async () => {
  // A HEIC (no server-side decoder) and a blob that won't download. Both must
  // stay out of consumedUrls so the caller keeps attaching them separately.
  const heic = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
  const result = await renderIdentificationPdf({
    people: [PEOPLE[0]],
    docsByLead: new Map([
      [
        "lead-1",
        [
          { ...doc("lead-1", "u1", "Passport"), fileName: "id.heic" },
          doc("lead-1", "u2", "Driver Licence"),
          doc("lead-1", "u3", "Health Card"),
        ],
      ],
    ]),
    fileNumber: "26S-0356",
    fetchBytes: async (url) => {
      if (url === "u1") return heic;
      if (url === "u2") throw new Error("private blob not found");
      return PNG_1PX;
    },
  });

  assert.ok(result);
  assert.equal(result.count, 1);
  assert.deepEqual(result.consumedUrls, ["u3"]);
  assert.equal(result.skipped.length, 2);
});

test("identification: nothing embeddable returns null rather than an empty pdf", async () => {
  const result = await renderIdentificationPdf({
    people: PEOPLE,
    docsByLead: new Map([["lead-1", [doc("lead-1", "u1", "Passport")]]]),
    fileNumber: "26S-0356",
    fetchBytes: async () => {
      throw new Error("gone");
    },
  });
  assert.equal(result, null);
});

test("personal information: one page per party, in the order given", async () => {
  const result = await renderPersonalInfoPdf({
    people: PEOPLE,
    rowsByLead: new Map([
      [
        "lead-1",
        [
          { label: "Marital Status", value: "Married" },
          { label: "Citizenship Status", value: "Canadian Citizen" },
        ],
      ],
      ["lead-2", [{ label: "Occupation", value: "Engineer" }]],
    ]),
    fileNumber: "26S-0356",
  });

  assert.ok(result);
  assert.equal(result.count, 2);
  assert.equal(await pageCount(result.bytes), 2);
});

test("personal information: a party with no answers is left out entirely", async () => {
  const result = await renderPersonalInfoPdf({
    people: PEOPLE,
    rowsByLead: new Map([["lead-2", [{ label: "Occupation", value: "Engineer" }]]]),
    fileNumber: "26S-0356",
  });

  assert.ok(result);
  assert.equal(result.count, 1);
  assert.equal(await pageCount(result.bytes), 1);

  // …and no answers at all means no attachment.
  assert.equal(
    await renderPersonalInfoPdf({ people: PEOPLE, rowsByLead: new Map(), fileNumber: "26S-0356" }),
    null,
  );
});

test("personal information: a long form flows onto further pages", async () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({
    label: `Field ${i + 1}`,
    value: `Answer ${i + 1}`,
  }));
  const result = await renderPersonalInfoPdf({
    people: [PEOPLE[0]],
    rowsByLead: new Map([["lead-1", rows]]),
    fileNumber: "26S-0356",
  });

  assert.ok(result);
  assert.ok((await pageCount(result.bytes)) > 1, "60 answers must not be crammed onto one page");
});

test("personal information: an un-encodable answer doesn't fail the document", async () => {
  const result = await renderPersonalInfoPdf({
    people: [PEOPLE[0]],
    rowsByLead: new Map([
      ["lead-1", [{ label: "Name — 名前", value: "Ramírez … “quoted”" }]],
    ]),
    fileNumber: "26S-0356",
  });

  assert.ok(result);
  assert.equal(await pageCount(result.bytes), 1);
});

// Keeps the pdf-lib colour import honest — a page we generate is a real page.
test("generated pages are A4", async () => {
  const result = await renderPersonalInfoPdf({
    people: [PEOPLE[0]],
    rowsByLead: new Map([["lead-1", [{ label: "Occupation", value: "Engineer" }]]]),
    fileNumber: "26S-0356",
  });
  assert.ok(result);
  const page = (await PDFDocument.load(result.bytes)).getPage(0);
  assert.equal(Math.round(page.getWidth()), 595);
  assert.equal(Math.round(page.getHeight()), 842);
  assert.ok(rgb(0, 0, 0));
});
