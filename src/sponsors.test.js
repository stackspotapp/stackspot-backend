import assert from "node:assert/strict";
import test from "node:test";
import {
  applyEventToSponsor,
  mergeSponsorRecord,
  normalizeListedSponsor,
  resolveSponsorContract,
  sponsorIndexKeys,
  toSponsorPageRecord,
  withProjectName,
} from "./sponsors.js";

const SPONSOR = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.stackspot-sponsor";
const STACKSPOTS = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.stackspots";
const POT = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.jackpot";
const WALLET = "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG";

test("init-pot sponsors list indexes each sponsor contract", () => {
  const keys = sponsorIndexKeys(
    {
      event: "init-pot",
      values: {
        contract: POT,
        sponsors: [
          { "sponsor-contract": SPONSOR, "ticket-id": "1" },
          { "sponsor-contract": `${WALLET}.other-sponsor`, "ticket-id": "2" },
        ],
      },
    },
    STACKSPOTS,
  );
  assert.deepEqual(keys.sort(), [SPONSOR, `${WALLET}.other-sponsor`].sort());
});

test("platform sponsor contract added registers the sponsor contract", () => {
  const record = applyEventToSponsor(null, {
    event: "platform sponsor contract added",
    blockHeight: 8,
    txId: "0xa",
    values: { "contract-address": SPONSOR, hash: "0xabc" },
  });
  assert.equal(record.sponsorContract, SPONSOR);
  assert.equal(record.allowed, true);
  assert.equal(record.lastEvent, "platform sponsor contract added");
});

test("sponsor-platform attaches amount, cycles, and wallet from stackspots or the sponsor contract", () => {
  const fromHub = applyEventToSponsor(
    null,
    {
      event: "sponsor-platform",
      contractId: STACKSPOTS,
      blockHeight: 10,
      txId: "0xb",
      values: {
        amount: "40000000",
        cycles: "10",
        sponsor: WALLET,
        "sponsor-contract": SPONSOR,
        "burn-block-height": "1000",
        "rule-list": [{ label: "min-pot", state: true, required: "1000000", score: "3" }],
      },
    },
    STACKSPOTS,
  );
  assert.equal(fromHub.sponsorContract, SPONSOR);
  assert.equal(fromHub.sponsor, WALLET);
  assert.equal(fromHub.amount, "40000000");
  assert.equal(fromHub.cycles, "10");
  assert.equal(fromHub.ruleList[0].label, "min-pot");

  const fromLocal = resolveSponsorContract(
    {
      event: "sponsor-platform",
      contractId: SPONSOR,
      values: { amount: "1", sponsor: WALLET },
    },
    STACKSPOTS,
  );
  assert.equal(fromLocal, SPONSOR);
});

test("sponsor-event tickets are merged without double-counting", () => {
  const first = applyEventToSponsor(
    null,
    {
      event: "sponsor-event",
      contractId: SPONSOR,
      blockHeight: 12,
      txId: "0xc",
      values: {
        "ticket-id": "1",
        "pot-contract": POT,
        "pot-details": { "pot-value": "5000000", "pot-locked": true },
      },
    },
    STACKSPOTS,
  );
  const again = applyEventToSponsor(
    first,
    {
      event: "sponsor-event",
      contractId: SPONSOR,
      blockHeight: 12,
      txId: "0xc",
      values: {
        "ticket-id": "1",
        "pot-contract": POT,
        "pot-details": { "pot-value": "5000000", "pot-locked": true },
      },
    },
    STACKSPOTS,
  );
  const secondPot = applyEventToSponsor(
    again,
    {
      event: "sponsor-event",
      contractId: SPONSOR,
      blockHeight: 13,
      txId: "0xd",
      values: { "ticket-id": "2", "pot-contract": "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.sequential" },
    },
    STACKSPOTS,
  );
  const listed = normalizeListedSponsor(secondPot);
  assert.equal(listed.sponsoredPotCount, 2);
  assert.equal(listed.tickets[0].ticketId, "1");
});

test("newer sponsor-platform wins amount while tickets are preserved", () => {
  const allowed = applyEventToSponsor(null, {
    event: "platform sponsor contract added",
    blockHeight: 1,
    values: { "contract-address": SPONSOR },
  });
  const locked = applyEventToSponsor(
    allowed,
    {
      event: "sponsor-platform",
      blockHeight: 5,
      values: { amount: "40000000", cycles: "4", sponsor: WALLET, "sponsor-contract": SPONSOR },
    },
    STACKSPOTS,
  );
  const ticketed = applyEventToSponsor(
    locked,
    {
      event: "sponsor-event",
      contractId: SPONSOR,
      blockHeight: 6,
      values: { "ticket-id": "1", "pot-contract": POT },
    },
    STACKSPOTS,
  );
  const relock = applyEventToSponsor(
    ticketed,
    {
      event: "sponsor-platform",
      blockHeight: 9,
      values: { amount: "80000000", cycles: "8", sponsor: WALLET, "sponsor-contract": SPONSOR },
    },
    STACKSPOTS,
  );
  const merged = mergeSponsorRecord(ticketed, relock);
  assert.equal(merged.amount, "80000000");
  assert.equal(merged.cycles, "8");
  assert.equal(merged.allowed, true);
  assert.equal(merged.tickets.length, 1);
});

test("sponsor page keeps only sponsor-platform values", () => {
  const added = applyEventToSponsor(null, {
    event: "platform sponsor contract added",
    blockHeight: 1,
    txId: "0xadded",
    values: { "contract-address": SPONSOR },
  });
  assert.equal(toSponsorPageRecord(added), null);

  const locked = applyEventToSponsor(
    added,
    {
      event: "sponsor-platform",
      blockHeight: 5,
      txId: "0xlock",
      values: {
        amount: "50000000",
        cycles: "1",
        sponsor: WALLET,
        "sponsor-contract": SPONSOR,
        "burn-block-height": "15755",
        "rule-list": [{ label: "min-pot", state: true, required: "100", score: "100" }],
      },
    },
    STACKSPOTS,
  );
  const ticketed = applyEventToSponsor(
    locked,
    {
      event: "sponsor-event",
      contractId: SPONSOR,
      blockHeight: 6,
      txId: "0xticket",
      values: { "ticket-id": "1", "pot-contract": POT },
    },
    STACKSPOTS,
  );
  const page = toSponsorPageRecord(ticketed);
  assert.equal(page.sponsorContract, SPONSOR);
  assert.equal(page.sponsor, WALLET);
  assert.equal(page.amount, "50000000");
  assert.equal(page.cycles, "1");
  assert.equal(page.lastEvent, "sponsor-platform");
  assert.equal(page.lastTxId, "0xlock");
  assert.equal(page.tickets, undefined);
  assert.equal(page.allowed, undefined);
});

test("project-name is the contract name after the dot", () => {
  const row = withProjectName({
    event: "sponsor-platform",
    "sponsor-contract": SPONSOR,
    txid: "0xlock",
  });
  assert.equal(row["project-name"], "stackspot-sponsor");
  assert.equal(withProjectName({ sponsor: WALLET })["project-name"], undefined);
});
