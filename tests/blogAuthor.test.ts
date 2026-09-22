// Reading the author out of an article body.
//
// The risk being tested is asymmetric: a wrong name republishes the article
// under someone else's byline and into its Article structured data, while a
// missed name only means the admin fills the field by hand. So most of these
// are about what it must REFUSE to guess.

import assert from "node:assert/strict";
import test from "node:test";

const { detectAuthorFromHtml, looksLikePersonName } = await import("../src/lib/blogAuthor.ts");

test("reads the name out of a byline paragraph", () => {
  const html =
    "<p>By Kubeskaran Navaratnam, Managing Partner and Real Estate Lawyer, iClosed · " +
    "Licensed by the Law Society of Ontario, LSO #605399 · Last reviewed: September 2026</p>" +
    "<h2>Key takeaways</h2><p>The APS is the contract.</p>";

  assert.deepEqual(detectAuthorFromHtml(html), {
    name: "Kubeskaran Navaratnam",
    source: "Byline",
  });
});

test("prefers the About the author section over an earlier byline", () => {
  const html =
    "<p>By The Editor, iClosed</p>" +
    "<h2>About the author — Kubeskaran Navaratnam</h2>" +
    "<p>Kubeskaran is the Managing Partner of iClosed.</p>";

  assert.deepEqual(detectAuthorFromHtml(html), {
    name: "Kubeskaran Navaratnam",
    source: "About the author",
  });
});

test("takes the name from the line under a bare About the author heading", () => {
  const html = "<h2>About the author</h2><p>Aliya Shaikha is a real estate lawyer.</p>";

  assert.equal(detectAuthorFromHtml(html)?.name, "Aliya Shaikha");
});

test("ignores inline markup inside the byline", () => {
  const html = '<p>Written by <strong>Sarujan Kana</strong>, LL.B.</p>';

  assert.equal(detectAuthorFromHtml(html)?.name, "Sarujan Kana");
});

test("falls back to a reviewer only when nothing better is stated", () => {
  const withBoth =
    "<p>By Kubeskaran Navaratnam</p><p>Reviewed by Aliya Shaikha</p>";
  const reviewerOnly = "<p>Reviewed by Aliya Shaikha</p>";

  assert.equal(detectAuthorFromHtml(withBoth)?.name, "Kubeskaran Navaratnam");
  assert.equal(detectAuthorFromHtml(reviewerOnly)?.source, "Reviewed by");
});

test("returns null for an article that names nobody", () => {
  const html = "<h2>What is an APS?</h2><p>By law, an offer becomes binding on acceptance.</p>";

  assert.equal(detectAuthorFromHtml(html), null);
});

test("returns null for empty input", () => {
  assert.equal(detectAuthorFromHtml(""), null);
  assert.equal(detectAuthorFromHtml(null), null);
});

test("does not mistake a house byline for a person", () => {
  // The default the field already holds. Suggesting it back is noise, and the
  // same shape ("By the <something> Desk") must never look like a name.
  assert.equal(detectAuthorFromHtml("<p>By the iClosed Real Estate Law Desk</p>"), null);
  assert.equal(detectAuthorFromHtml("<p>By our editorial team</p>"), null);
});

test("looksLikePersonName holds the line on shape", () => {
  assert.equal(looksLikePersonName("Kubeskaran Navaratnam"), true);
  assert.equal(looksLikePersonName("Ali van der Meer"), true);
  assert.equal(looksLikePersonName("Mary-Jane O’Brien"), true);
  assert.equal(looksLikePersonName("J. R. Smith"), true);

  assert.equal(looksLikePersonName("Kubeskaran"), false); // one word
  assert.equal(looksLikePersonName("iClosed Real Estate Law Desk"), false);
  assert.equal(looksLikePersonName("Reviewed 2026 by Someone"), false); // digits
  assert.equal(looksLikePersonName("law, an offer becomes binding"), false);
  assert.equal(looksLikePersonName(""), false);
});
