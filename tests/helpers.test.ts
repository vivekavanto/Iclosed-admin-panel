// GAP-022 — unit tests for the core pure helpers, run with Node's built-in test
// runner (no test-framework dependency):  npm test
import { test } from "node:test";
import assert from "node:assert/strict";

import { isUuid } from "../src/lib/isUuid.ts";
import { maskEmail } from "../src/lib/maskEmail.ts";
import { validateUpload } from "../src/lib/uploadValidation.ts";
import {
  escapeHtml,
  renderTemplateSafe,
  decodeTemplateBraces,
} from "../src/lib/renderEmailTemplate.ts";
import { FILE_NUMBER_REGEX } from "../src/lib/fileNumber.ts";
import { withRetry } from "../src/lib/retry.ts";
import {
  isBlobUrl,
  isPrivateBlobUrl,
  docDownloadHref,
} from "../src/lib/blobPrivacy.ts";

test("isUuid", () => {
  assert.ok(isUuid("b067478d-19a6-4627-8af7-e0552719e613"));
  assert.ok(!isUuid("not-a-uuid"));
  assert.ok(!isUuid(""));
  assert.ok(!isUuid("123"));
  assert.ok(!isUuid(null));
});

test("maskEmail", () => {
  assert.equal(maskEmail("john.doe@example.com"), "j***@example.com");
  assert.equal(maskEmail(""), "(none)");
  assert.equal(maskEmail("no-at-sign"), "(none)");
  assert.equal(maskEmail(null), "(none)");
});

test("FILE_NUMBER_REGEX", () => {
  assert.ok(FILE_NUMBER_REGEX.test("26AB-1234"));
  assert.ok(FILE_NUMBER_REGEX.test("26P-123"));
  assert.ok(!FILE_NUMBER_REGEX.test("bad"));
  assert.ok(!FILE_NUMBER_REGEX.test("26ab-1234")); // lowercase letters rejected
});

test("escapeHtml", () => {
  assert.equal(
    escapeHtml(`<a href="x" o='y'>&`),
    "&lt;a href=&quot;x&quot; o=&#39;y&#39;&gt;&amp;",
  );
});

test("renderTemplateSafe: escapes + single-pass (no reflective injection)", () => {
  const resolve = (name: string) =>
    ({ first_name: { value: "<b>Al</b>" }, email: { value: "a@x.com" } } as any)[
      name
    ] ?? null;
  // HTML in a value is escaped
  assert.equal(
    renderTemplateSafe("Hi {{ first_name }}", resolve),
    "Hi &lt;b&gt;Al&lt;/b&gt;",
  );
  // A value containing a placeholder is NOT re-substituted
  const reflective = (n: string) =>
    ({ a: { value: "{{ email }}" }, email: { value: "secret" } } as any)[n] ??
    null;
  assert.equal(renderTemplateSafe("{{ a }}", reflective), "{{ email }}");
  // Unknown placeholder left as-is
  assert.equal(renderTemplateSafe("{{ nope }}", resolve), "{{ nope }}");
  // Subject mode: no escaping
  assert.equal(
    renderTemplateSafe("{{ first_name }}", resolve, { escape: false }),
    "<b>Al</b>",
  );
});

test("decodeTemplateBraces: decimal/hex/named brace entities", () => {
  assert.equal(decodeTemplateBraces("&#123;&#123;x&#125;&#125;"), "{{x}}");
  assert.equal(decodeTemplateBraces("&#x7B;&#x7B;x&#x7D;&#x7D;"), "{{x}}");
  assert.equal(decodeTemplateBraces("&lbrace;&lbrace;x&rbrace;&rbrace;"), "{{x}}");
  // Content entities are NOT decoded (valid HTML preserved)
  assert.equal(decodeTemplateBraces("a &amp; b &lt;x&gt;"), "a &amp; b &lt;x&gt;");
});

test("blobPrivacy URL helpers", () => {
  const pub = "https://store.public.blob.vercel-storage.com/x.pdf";
  const priv = "https://store.private.blob.vercel-storage.com/x.pdf";
  assert.ok(isBlobUrl(pub) && isBlobUrl(priv));
  assert.ok(!isBlobUrl("https://evil.com/x"));
  assert.ok(isPrivateBlobUrl(priv) && !isPrivateBlobUrl(pub));
  // public/legacy URLs pass through; private go via the proxy
  assert.equal(docDownloadHref(pub), pub);
  assert.equal(
    docDownloadHref(priv),
    `/api/admin/documents/download?u=${encodeURIComponent(priv)}`,
  );
});

test("validateUpload: size + type", () => {
  const ok = new File([new Uint8Array(10)], "id.pdf", { type: "application/pdf" });
  assert.equal(validateUpload(ok).ok, true);
  const empty = new File([], "id.pdf", { type: "application/pdf" });
  assert.equal(validateUpload(empty).ok, false);
  const badType = new File([new Uint8Array(10)], "x.exe", {
    type: "application/x-msdownload",
  });
  assert.equal(validateUpload(badType).ok, false);
});

test("withRetry: succeeds after transient failures", async () => {
  let n = 0;
  const result = await withRetry(
    async () => {
      n++;
      if (n < 3) throw new Error("transient");
      return "ok";
    },
    { attempts: 3, baseMs: 1 },
  );
  assert.equal(result, "ok");
  assert.equal(n, 3);
});
