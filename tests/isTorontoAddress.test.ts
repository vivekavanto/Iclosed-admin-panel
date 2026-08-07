// Whether the Toronto municipal land transfer tax applies.
//
// ~$18,000 either way on a $1M purchase, and the client cannot correct it — the
// portal locks the flag to what the server decided. Every case below is one the
// old `/\btoronto\b/` test got wrong.

import assert from "node:assert/strict";
import test from "node:test";

import { isTorontoAddress } from "../src/lib/isTorontoAddress.ts";

// ── The amalgamated municipalities ────────────────────────────────────
// Scarborough, North York, Etobicoke, East York and York have been the City of
// Toronto since 1998. Every one of these was previously MISSED, under-quoting
// the buyer by the whole municipal tax.

test("the former municipalities are Toronto", () => {
  const inside = [
    "2 Progress Ave, Scarborough, ON",
    "45 Yonge St, North York, ON",
    "300 The East Mall, Etobicoke, ON",
    "1 Pape Ave, East York, ON",
    "12 Weston Rd, York, ON",
    "100 Queen St W, Toronto, ON",
  ];
  for (const address of inside) {
    assert.equal(isTorontoAddress(address), true, address);
  }
});

// ── A street is not a city ────────────────────────────────────────────

test("a street named Toronto in another city is not Toronto", () => {
  // Previously charged the municipal tax on a Mississauga purchase.
  assert.equal(isTorontoAddress("5 Toronto Street, Mississauga, ON"), false);
  assert.equal(isTorontoAddress("8 Toronto Blvd, Barrie, ON"), false);
  assert.equal(isTorontoAddress("14 Toronto Ave, Oshawa, ON"), false);
});

test("neighbouring municipalities are not Toronto", () => {
  const outside = [
    "77 City Centre Dr, Mississauga, ON",
    "22 Arctic Willow Road, Brampton, ON",
    "9 Main St, Markham, ON",
    "3 Bayview Ave, Richmond Hill, ON",
    "40 Bay St, Vaughan, ON",
  ];
  for (const address of outside) {
    assert.equal(isTorontoAddress(address), false, address);
  }
});

// ── Postal code is authoritative ──────────────────────────────────────

test("an M postal code means Toronto, whatever the rest says", () => {
  assert.equal(isTorontoAddress("100 Queen St W, ON M5H 2N2"), true);
  assert.equal(isTorontoAddress("2 Progress Ave, ON M1P 2Z7"), true);
  // No spacing, lowercase — still read.
  assert.equal(isTorontoAddress("1 Yonge St m5e1e5"), true);
});

test("a non-M postal code overrules a Toronto-looking name", () => {
  // The single case the municipality list alone cannot settle.
  assert.equal(
    isTorontoAddress("5 Toronto Street, Mississauga, ON L5A 1B2"),
    false,
  );
  assert.equal(isTorontoAddress("8 Toronto Blvd, Barrie, ON L4M 1A1"), false);
});

// ── Whole words only ──────────────────────────────────────────────────

test("names that merely contain a municipality do not count", () => {
  // Yorkville is in Toronto, but not BECAUSE it contains "York" — it is caught
  // by its postal code. Without one, a bare neighbourhood name must not decide.
  assert.equal(isTorontoAddress("12 Yorkdale Rd, Yorkton, SK"), false);
  assert.equal(isTorontoAddress("Newmarket, ON"), false);
});

// ── Shapes that are not a full address ────────────────────────────────

test("a bare municipality still counts", () => {
  assert.equal(isTorontoAddress("Toronto, ON"), true);
  assert.equal(isTorontoAddress("Scarborough"), true);
});

test("nothing usable is not Toronto", () => {
  // Omitting a tax a clerk can still tick on beats charging one nobody confirmed.
  assert.equal(isTorontoAddress(""), false);
  assert.equal(isTorontoAddress("   "), false);
  assert.equal(isTorontoAddress(null), false);
  assert.equal(isTorontoAddress(undefined), false);
  assert.equal(isTorontoAddress(12345), false);
});
