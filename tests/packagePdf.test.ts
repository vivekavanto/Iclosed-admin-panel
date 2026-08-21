// Unit tests for the deal-package renderer (src/lib/packagePdf.ts).
//
// Layout only — the module takes its data (blob bytes included) as arguments, so
// these drive it with synthetic documents and never touch Supabase or the blob
// store. src/lib/dealPackage.ts is the query layer on top.
//
// The behaviour most worth pinning down is what a merge DROPS. The clerks asked
// for the identification PDF to be a plain merge of the uploaded IDs, and a
// two-sided scan of a one-sided licence was arriving with its empty back sides
// still in it — while a page of a client's real document must never be dropped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";

import {
  PackageDoc,
  isBlankPage,
  isScaffoldPage,
  keepablePageIndices,
  textDrawCount,
  paintsXObject,
  shownText,
  detectDocKind,
  winAnsiSafe,
  splitAddress,
  startsMailForwarding,
  A4,
} from "../src/lib/packagePdf.ts";

const META = {
  fileNumber: "26S-0456",
  type: "Sale",
  status: "Active",
  propertyAddress: "Sale of 10 Milner Gate, Vaughan, Ontario, L4J 2N4",
  closingDate: "August 31, 2026",
  price: 1250000,
};

type Kind = "text" | "blank" | "vector" | "scaffold";

/** A stand-in uploaded PDF whose pages are described by `kinds`. */
async function makeSource(kinds: Kind[]): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const kind of kinds) {
    const page = doc.addPage([A4.w, A4.h]);
    if (kind === "text") {
      page.drawText("NOTICE OF FULFILLMENT OF CONDITION", { x: 64, y: 700, size: 14, font });
    } else if (kind === "vector") {
      // A signature line and nothing else: sparse, but NOT blank.
      page.drawLine({ start: { x: 64, y: 200 }, end: { x: 300, y: 200 }, thickness: 1 });
    } else if (kind === "scaffold") {
      // An older iClosed export's chrome, and nothing else of substance.
      page.drawText("DEAL FILE - 26S-0456", { x: 64, y: 785, size: 8, font });
      page.drawText("iClosed", { x: 460, y: 785, size: 12, font });
      page.drawText("CONFIDENTIAL", { x: 64, y: 40, size: 7.5, font });
      page.drawText("10 MILNER GATE - 26S-0456", { x: 380, y: 40, size: 7.5, font });
    }
  }
  // Round-trip so the content streams are the ones a real upload would carry.
  return await PDFDocument.load(await doc.save());
}

async function sourceBytes(kinds: Kind[]): Promise<Uint8Array> {
  return await (await makeSource(kinds)).save();
}

/** A 1x1 PNG. */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

// ───────────────────────── content-stream helpers ─────────────────────────

test("textDrawCount counts every string form a producer may use", () => {
  assert.equal(textDrawCount("BT (Hello) Tj ET"), 1, "literal string");
  assert.equal(textDrawCount("BT <48656C6C6F> Tj ET"), 1, "hex string — what pdf-lib writes");
  assert.equal(textDrawCount("BT [(a)-2(b)] TJ ET"), 1, "positioned array");
  assert.equal(textDrawCount("q 1 0 0 1 0 0 cm Q"), 0);
});

test("paintsXObject spots a placed image or form", () => {
  assert.equal(paintsXObject("q 100 0 0 50 0 0 cm /X1 Do Q"), true);
  assert.equal(paintsXObject("0 0 100 100 re f"), false);
});

test("shownText recovers both literal and hex-encoded text", () => {
  assert.match(shownText("BT (DEAL FILE) Tj ET"), /DEAL FILE/);
  assert.match(shownText("BT <4445414C2046494C45> Tj ET"), /DEAL FILE/);
});

test("winAnsiSafe keeps what pdf-lib's standard fonts can encode", () => {
  assert.equal(winAnsiSafe("It’s “fine” — really…"), `It's "fine" - really...`);
  assert.equal(winAnsiSafe("café"), "café", "Latin-1 survives");
  assert.equal(winAnsiSafe("你好"), "??", "anything outside WinAnsi is replaced, not thrown on");
  assert.equal(winAnsiSafe(null), "");
});

test("detectDocKind trusts the magic bytes over the file name", async () => {
  assert.equal(detectDocKind(await sourceBytes(["text"]), "photo.jpg"), "pdf");
  assert.equal(detectDocKind(new Uint8Array(PNG_1PX), "scan.pdf"), "png");
  assert.equal(detectDocKind(new Uint8Array([0, 1, 2, 3]), "id.heic"), "other");
  assert.equal(detectDocKind(new Uint8Array([]), "statement.pdf"), "pdf", "name is the fallback");
});

test("splitAddress strips the transaction prefix and splits off the locality", () => {
  assert.deepEqual(splitAddress("Sale of 10 Milner Gate, Vaughan, ON"), {
    title: "10 Milner Gate",
    locality: "Vaughan, ON",
  });
  assert.deepEqual(splitAddress(null), { title: "", locality: "" });
});

test("startsMailForwarding only fires on the bare street-address field", () => {
  assert.equal(startsMailForwarding("Street Address"), true);
  assert.equal(startsMailForwarding("  street address  "), true);
  assert.equal(startsMailForwarding("Property Street Address"), false);
});

// ───────────────────────────── what a merge drops ─────────────────────────────

test("an empty page is blank; a page with text or a vector mark is not", async () => {
  const src = await makeSource(["blank", "text", "vector"]);
  assert.equal(isBlankPage(src, src.getPage(0)), true);
  assert.equal(isBlankPage(src, src.getPage(1)), false);
  assert.equal(
    isBlankPage(src, src.getPage(2)),
    false,
    "a signature line is content, not an empty page",
  );
});

test("a client's own document is never mistaken for our scaffolding", async () => {
  const src = await makeSource(["text"]);
  assert.equal(isScaffoldPage(src, src.getPage(0)), false);
});

test("a page of our own chrome and nothing else is scaffolding", async () => {
  const src = await makeSource(["scaffold"]);
  assert.equal(isScaffoldPage(src, src.getPage(0)), true);
});

test("keepablePageIndices drops blank back sides and our own scaffolding", async () => {
  const src = await makeSource(["scaffold", "text", "blank", "text", "blank"]);
  assert.deepEqual(keepablePageIndices(src), [1, 3]);
});

test("a document of nothing but content is kept whole", async () => {
  const src = await makeSource(["text", "text", "vector"]);
  assert.deepEqual(keepablePageIndices(src), [0, 1, 2]);
});

// ───────────────────────────────── the builder ─────────────────────────────────

test("merging an upload drops its blank pages and keeps the rest", async () => {
  const pkg = await PackageDoc.create(META);
  assert.equal(await pkg.mergePdf(await sourceBytes(["text", "blank", "text", "blank"])), 2);
  assert.equal(pkg.pageCount, 2);
});

test("an all-blank upload merges to nothing rather than to empty pages", async () => {
  const pkg = await PackageDoc.create(META);
  assert.equal(await pkg.mergePdf(await sourceBytes(["blank", "blank"])), 0);
  assert.equal(pkg.pageCount, 0);
});

test("identification is a plain merge — no divider page per party", async () => {
  const pkg = await PackageDoc.create(META);
  for (const name of ["Aliya Test", "Ravi Anand"]) {
    await pkg.addDocument({
      bytes: await sourceBytes(["text"]),
      fileUrl: `https://blob.example/${name}.pdf`,
      fileName: `${name}.pdf`,
      heading: name,
      sublabel: "Driver Licence",
      sectionTitle: "Identification",
    });
  }
  assert.equal(pkg.pageCount, 2, "two IDs should be two pages, with nothing in between");
});

test("addDocument reports a merged PDF as consumed so it isn't attached twice", async () => {
  const pkg = await PackageDoc.create(META);
  const ok = await pkg.addDocument({
    bytes: await sourceBytes(["text"]),
    fileUrl: "https://blob.example/licence.pdf",
    fileName: "licence.pdf",
    heading: "Aliya Test",
    sublabel: "Driver Licence",
  });
  assert.equal(ok, true);
  assert.deepEqual(pkg.consumedUrls, ["https://blob.example/licence.pdf"]);
  assert.equal(pkg.documents, 1);
  assert.equal(pkg.skipped.length, 0);
});

test("an image is embedded on its own page", async () => {
  const pkg = await PackageDoc.create(META);
  const ok = await pkg.addDocument({
    bytes: new Uint8Array(PNG_1PX),
    fileUrl: "https://blob.example/licence.png",
    fileName: "licence.png",
    heading: "Aliya Test",
    sublabel: "Driver Licence",
  });
  assert.equal(ok, true);
  assert.equal(pkg.pageCount, 1);
  assert.equal(pkg.documents, 1);
});

test("what can't be embedded is skipped, not consumed, so the original still ships", async () => {
  const pkg = await PackageDoc.create(META);
  const ok = await pkg.addDocument({
    bytes: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
    fileUrl: "https://blob.example/id.heic",
    fileName: "id.heic",
    heading: "Aliya Test",
  });
  assert.equal(ok, false);
  assert.equal(pkg.consumedUrls.length, 0);
  assert.equal(pkg.skipped.length, 1);
  assert.equal(pkg.skipped[0].fileName, "id.heic");
  assert.equal(pkg.pageCount, 1, "a note page still records that the document exists");
});

test("a document whose every page is droppable still leaves a note", async () => {
  const pkg = await PackageDoc.create(META);
  const ok = await pkg.addDocument({
    bytes: await sourceBytes(["blank", "blank"]),
    fileUrl: "https://blob.example/empty.pdf",
    fileName: "empty.pdf",
    heading: "Aliya Test",
  });
  assert.equal(ok, true);
  assert.equal(pkg.pageCount, 1);
});

test("a personal-information page renders and reloads as a valid A4 PDF", async () => {
  const pkg = await PackageDoc.create(META);
  pkg.newPage();
  pkg.band("Aliya Test", "Personal Information");
  pkg.kvRow("Name", "Aliya Test");
  pkg.kvRow("Phone Number", "(232) 323-2323");
  pkg.kvRow("Street Address", "10 Milner Gate", "Mail forwarding address");
  const bytes = await pkg.save();
  assert.ok(bytes && bytes.byteLength > 0);
  const reloaded = await PDFDocument.load(bytes!);
  assert.equal(reloaded.getPageCount(), 1);
  const { width, height } = reloaded.getPage(0).getSize();
  assert.ok(Math.abs(width - A4.w) < 1 && Math.abs(height - A4.h) < 1);
});

test("a long answer set flows onto further pages instead of overrunning", async () => {
  const pkg = await PackageDoc.create(META);
  pkg.newPage();
  pkg.band("Aliya Test", "Personal Information");
  for (let i = 0; i < 40; i++) pkg.kvRow(`Question number ${i}`, `Answer number ${i}`);
  const reloaded = await PDFDocument.load((await pkg.save())!);
  assert.ok(reloaded.getPageCount() > 1, "40 rows should not fit on one page");
});

test("an un-encodable answer doesn't fail the document", async () => {
  const pkg = await PackageDoc.create(META);
  pkg.newPage();
  pkg.band("Aliya Test", "Personal Information");
  pkg.kvRow("Occupation", "工程師 — Engineer");
  const bytes = await pkg.save();
  assert.ok(bytes && bytes.byteLength > 0);
  assert.equal(pkg.warnings.length, 0, "winAnsiSafe should have handled it before drawText");
});

test("the cover page reports the file it belongs to", async () => {
  const pkg = await PackageDoc.create(META);
  pkg.cover();
  const reloaded = await PDFDocument.load((await pkg.save())!);
  assert.equal(reloaded.getPageCount(), 1);
});

test("save returns null when nothing was drawn", async () => {
  const pkg = await PackageDoc.create(META);
  assert.equal(await pkg.save(), null);
});
