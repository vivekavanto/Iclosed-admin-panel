import { test } from "node:test";
import assert from "node:assert/strict";
import { mortgageFromAnswers } from "../src/lib/mortgageAnswer.ts";

const ask = "Are you getting a mortgage for this purchase?";

test("a stated amount is the mortgage", () => {
  assert.equal(
    mortgageFromAnswers([
      { field_label: ask, value: "Yes" },
      { field_label: "Mortgage amount", value: "$525,000" },
    ]),
    525000,
  );
});

test("no mortgage is a cash purchase", () => {
  assert.equal(
    mortgageFromAnswers([
      { field_label: ask, value: "No" },
      { field_label: "Mortgage amount", value: "400000" },
    ]),
    0,
  );
});

test("an unanswered task gives nothing", () => {
  assert.equal(mortgageFromAnswers([]), null);
  assert.equal(mortgageFromAnswers([{ field_label: ask, value: "Yes" }]), null);
  assert.equal(mortgageFromAnswers([{ field_label: "Mortgage amount", value: "" }]), null);
});
