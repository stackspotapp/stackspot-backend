import assert from "node:assert/strict";
import test from "node:test";
import { computeSponsorPage } from "./sponsorPage.js";

test("sponsor page keeps two hub prints even when one row has no sourceContract", () => {
  const page = computeSponsorPage([
    {
      event: "sponsor-platform",
      txid: "0xa",
      amount: "10",
      cycles: "1",
      "sponsor-contract": "ST1.bake",
    },
    {
      event: "sponsor-platform",
      sourceContract: "ST1.stackspots",
      txid: "0xb",
      amount: "20",
      cycles: "2",
      "sponsor-contract": "ST1.pc-mag",
    },
  ]);
  assert.equal(page.total, 2);
  assert.equal(page.stats.sponsors, 2);
});

test("sponsor page stats sum hub sponsor-platform prints", () => {
  const page = computeSponsorPage([
    {
      event: "sponsor-platform",
      txid: "0xa",
      amount: "100",
      cycles: "3",
      "sponsor-contract": "ST1.bake",
      live: { "available-reward-pool": "50" },
    },
    {
      event: "sponsor-platform",
      txid: "0xb",
      amount: "25",
      cycles: "1",
      "sponsor-contract": "ST1.pc",
      live: { "available-reward-pool": "10" },
    },
    {
      event: "sponsor-platform",
      txid: "0xa",
      amount: "100",
      cycles: "3",
      "sponsor-contract": "ST1.bake",
    },
  ]);
  assert.equal(page.total, 2);
  assert.equal(page.stats.sponsors, 2);
  assert.equal(page.stats.totalSponsored, "125");
  assert.equal(page.stats.cyclesLocked, "4");
  assert.equal(page.stats.thisCycleInflow, "60");
});
