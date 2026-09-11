import assert from "node:assert/strict";
import test from "node:test";
import { filterPotsForDetails, potMatchesOwner, potMatchesSponsor } from "./potDetails.js";

const OWNER = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";
const OTHER = "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG";
const POT = `${OWNER}.jackpot`;
const SPONSOR = `${OTHER}.stackspot-sponsor`;

const pots = [
  {
    potAddress: POT,
    potOwner: OWNER,
    potAdmin: OWNER,
    potType: "jackpot",
    values: { sponsors: [{ "sponsor-contract": SPONSOR, "ticket-id": "1" }] },
  },
  {
    potAddress: `${OTHER}.sequential`,
    potOwner: OTHER,
    potAdmin: OTHER,
    potType: "sequential",
    values: {},
  },
];

test("owner filter matches pot-owner and deployer wallet", () => {
  assert.equal(potMatchesOwner(pots[0], OWNER), true);
  assert.equal(potMatchesOwner(pots[1], OWNER), false);
  assert.equal(filterPotsForDetails(pots, { owner: OWNER }).length, 1);
});

test("contract filter returns that pot even when owner also matches", () => {
  const rows = filterPotsForDetails(pots, { owner: OWNER, contract: POT });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].potAddress, POT);
});

test("sponsor filter uses init-pot sponsor-contract list or tickets", () => {
  assert.equal(potMatchesSponsor(pots[0], SPONSOR, []), true);
  assert.equal(potMatchesSponsor(pots[1], SPONSOR, []), false);
  assert.equal(
    potMatchesSponsor(pots[1], SPONSOR, [{ potContract: `${OTHER}.sequential` }]),
    true,
  );
  assert.equal(filterPotsForDetails(pots, { sponsorContract: SPONSOR }).length, 1);
});

test("owner + contract + sponsor returns the matching pot", () => {
  const rows = filterPotsForDetails(pots, {
    owner: OWNER,
    contract: POT,
    sponsorContract: SPONSOR,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].potAddress, POT);
});
