// Document import for the blog: an uploaded file in, the author's text out.
//
// The point of these cases is that extraction is CODE, not a model. The blog
// publishes Ontario real-estate law that answer engines quote verbatim, so a
// .docx has to arrive word for word — and the two ways that quietly fails are
// both pinned here: track-changes deletions coming back from the dead, and
// Word headings arriving as ordinary paragraphs (which strands the article's
// structure, because blogFormat's prompt is forbidden from inventing headings
// for text that has none).
//
// The PDF branch is deliberately not covered: it is the one import that goes
// through Gemini, and there is nothing deterministic to assert about it.

import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";

import { extractBlogArticle, importKindFor } from "../src/lib/blogImport.ts";

/** One <w:p>, with the properties Word would have written around it. */
function para(text: string, opts: { style?: string; list?: boolean } = {}) {
  const props =
    opts.style || opts.list
      ? `<w:pPr>${opts.style ? `<w:pStyle w:val="${opts.style}"/>` : ""}${
          opts.list ? "<w:numPr><w:ilvl w:val=\"0\"/></w:numPr>" : ""
        }</w:pPr>`
      : "";
  return `<w:p>${props}<w:r><w:t>${text}</w:t></w:r></w:p>`;
}

async function docxFile(bodyXml: string, name = "article.docx"): Promise<File> {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
     <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
       <w:body>${bodyXml}</w:body>
     </w:document>`,
  );
  const bytes = await zip.generateAsync({ type: "uint8array" });
  return new File([bytes], name);
}

function textFile(contents: string, name: string): File {
  return new File([contents], name);
}

async function extract(file: File) {
  const outcome = await extractBlogArticle(file);
  assert.ok(outcome.ok, `extraction failed: ${outcome.ok ? "" : outcome.error}`);
  return outcome.data;
}

test("format is chosen by extension, not by the browser's content type", () => {
  assert.equal(importKindFor("Closing Costs.DOCX"), "docx");
  assert.equal(importKindFor("notes.md"), "markdown");
  assert.equal(importKindFor("page.htm"), "html");
  // .doc is the old binary format; there is nothing to unzip.
  assert.equal(importKindFor("legacy.doc"), null);
  assert.equal(importKindFor("cover.png"), null);
});

test("a .docx keeps the author's words and its structure", async () => {
  const data = await extract(
    await docxFile(
      [
        para("Title Insurance in Ontario", { style: "Heading1" }),
        para("A policy protects against title fraud."),
        para("What it covers", { style: "Heading2" }),
        para("Survey problems", { list: true }),
        para("Unregistered easements", { list: true }),
      ].join(""),
    ),
  );

  // The Heading 1 becomes the post's title and leaves the body, so the page
  // does not render it twice.
  assert.equal(data.title, "Title Insurance in Ontario");
  assert.ok(!data.text.includes("Title Insurance in Ontario"));

  // Headings and list items carry markers Gemini can act on.
  assert.match(data.text, /^## What it covers$/m);
  assert.match(data.text, /^- Survey problems$/m);
  assert.match(data.text, /^- Unregistered easements$/m);

  assert.ok(data.text.includes("A policy protects against title fraud."));
  assert.equal(data.needsProofread, false);
  assert.equal(data.preformattedHtml, null);
});

test("a .docx heading after the first is demoted, never emitted as h1", async () => {
  // h1 is not an allowed body tag — the page renders the post title as the
  // sole h1 — so a second Heading 1 has to come through as ##, not #.
  const data = await extract(
    await docxFile(
      [
        para("First", { style: "Heading1" }),
        para("Second", { style: "Heading 1" }),
        para("Deep", { style: "Heading5" }),
      ].join(""),
    ),
  );

  assert.equal(data.title, "First");
  assert.match(data.text, /^## Second$/m);
  // Nothing deeper than h4 is in the sanitizer's allowlist.
  assert.match(data.text, /^#### Deep$/m);
  assert.ok(!/^# /m.test(data.text));
});

test("track-changes deletions and field codes do not reach the article", async () => {
  // <w:delText> is text the author struck out with track changes on, and
  // <w:instrText> is a field code. A tag-strip that read everything would
  // publish both; only <w:t> runs count.
  const data = await extract(
    await docxFile(
      `<w:p><w:r><w:t>The buyer pays the land transfer tax</w:t></w:r>` +
        `<w:del><w:r><w:delText> and the seller's legal fees</w:delText></w:r></w:del>` +
        `<w:r><w:instrText> PAGEREF _Toc123 </w:instrText></w:r>` +
        `<w:r><w:t>.</w:t></w:r></w:p>`,
    ),
  );

  assert.equal(data.text, "The buyer pays the land transfer tax.");
});

test("XML entities are decoded once, not twice", async () => {
  const data = await extract(
    await docxFile(para("Fees &amp; disbursements &lt; $2,000 &amp;amp; rising")),
  );
  assert.equal(data.text, "Fees & disbursements < $2,000 &amp; rising");
});

test("a .docx with no readable text is refused rather than imported empty", async () => {
  const outcome = await extractBlogArticle(await docxFile(para("   ")));
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.error, /no article text/i);
});

test("something that is not a Word document is refused with a usable message", async () => {
  const zip = new JSZip();
  zip.file("hello.txt", "not a word document");
  const bytes = await zip.generateAsync({ type: "uint8array" });

  const outcome = await extractBlogArticle(new File([bytes], "notes.docx"));
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.error, /not a Word document/i);
});

test("a Markdown h1 becomes the title and leaves the body", async () => {
  const data = await extract(
    textFile("# Closing Day, Step by Step\n\nYour lawyer registers the transfer.", "post.md"),
  );

  assert.equal(data.title, "Closing Day, Step by Step");
  assert.equal(data.text, "Your lawyer registers the transfer.");
});

test("a short opening line in plain text is NOT taken as the title", async () => {
  // The heuristic would be right often and wrong occasionally, and being wrong
  // means silently deleting the article's first sentence.
  const data = await extract(textFile("Closing day is stressful.\n\nHere is why.", "post.txt"));

  assert.equal(data.title, null);
  assert.ok(data.text.startsWith("Closing day is stressful."));
});

test("an HTML upload keeps its markup instead of being flattened", async () => {
  // Round-tripping it through the formatter would destroy every hyperlink, and
  // no amount of re-formatting brings a URL back.
  const data = await extract(
    textFile(
      "<html><head><title>Ignored</title></head><body>" +
        "<h1>Land Transfer Tax</h1>" +
        '<p>See the <a href="https://ontario.ca/ltt">provincial table</a>.</p>' +
        "<script>alert(1)</script>" +
        "</body></html>",
      "article.html",
    ),
  );

  assert.equal(data.title, "Land Transfer Tax");
  assert.ok(data.preformattedHtml?.includes('href="https://ontario.ca/ltt"'));
  // The h1 is dropped: the page renders the post title itself.
  assert.ok(!data.preformattedHtml?.includes("<h1"));
  // The sanitizer's allowlist is what actually constrains an uploaded file.
  assert.ok(!data.preformattedHtml?.includes("alert(1)"));
});

test("an empty or oversized file is refused before any work is done", async () => {
  const empty = await extractBlogArticle(textFile("", "post.txt"));
  assert.equal(empty.ok, false);

  const huge = await extractBlogArticle(textFile("x".repeat(70_000), "post.txt"));
  assert.equal(huge.ok, false);
  assert.match(huge.ok ? "" : huge.error, /the limit is 60,000/);
});
