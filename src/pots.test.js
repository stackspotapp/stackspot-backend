import assert from "node:assert/strict";
import test from "node:test";
import {
  applyEventToPot,
  mergePotRecord,
  normalizeListedPot,
  potAddressFromValues,
  potRecordFromEvent,
} from "./pots.js";

const POT = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.jackpot";
const STACKSPOTS = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.stackspots";

test("pre-init uses pot-contract and marks deployed", () => {
  const record = potRecordFromEvent({
    event: "pre-init",
    blockHeight: 10,
    values: {
      "pot-contract": POT,
      "pot-type": "jackpot",
      "pot-name": "Alpha",
      "pot-owner": "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
    },
  });
  assert.equal(record.potAddress, POT);
  assert.equal(record.status, "deployed");
  assert.equal(record.potType, "jackpot");
});

test("init-pot, pot-registered, and pot mint mark joinable", () => {
  assert.equal(potAddressFromValues("init-pot", { contract: POT }), POT);
  assert.equal(potRecordFromEvent({ event: "init-pot", values: { contract: POT, type: "jackpot" } }).status, "joinable");
  assert.equal(
    potRecordFromEvent({ event: "pot-registered", values: { "pot-address": POT, "pot-id": "1" } }).status,
    "joinable",
  );
  assert.equal(
    potRecordFromEvent({ event: "pot mint", values: { recipient: POT, "token-id": "1" } }).potId,
    "1",
  );
});

test("join-pot on the pot contract attaches via contractId", () => {
  const record = potRecordFromEvent(
    {
      event: "join-pot",
      contractId: POT,
      values: { participant: "ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5", amount: "1" },
    },
    STACKSPOTS,
  );
  assert.equal(record.potAddress, POT);
  assert.equal(record.status, "joinable");
});

test("join-pot forwarded to stackspots without a pot address does not create a pot", () => {
  assert.equal(
    potRecordFromEvent(
      {
        event: "join-pot",
        contractId: STACKSPOTS,
        values: { participant: "ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5", amount: "1" },
      },
      STACKSPOTS,
    ),
    null,
  );
});

test("platform events never become pots", () => {
  assert.equal(
    potRecordFromEvent({
      event: "admin added/updated",
      values: { admin: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM", enable: true },
    }),
    null,
  );
});

test("start, cancel, and claim advance status and never move backwards", () => {
  let pot = potRecordFromEvent({
    event: "pre-init",
    blockHeight: 10,
    values: { "pot-contract": POT, "pot-name": "Alpha", "pot-type": "jackpot" },
  });
  pot = applyEventToPot(pot, {
    event: "init-pot",
    blockHeight: 11,
    values: { contract: POT, type: "jackpot" },
  });
  assert.equal(pot.status, "joinable");

  pot = applyEventToPot(pot, {
    event: "start-stackspot-jackpot",
    blockHeight: 12,
    values: { "pot-contract": POT, "pot-locked": true },
  });
  assert.equal(pot.status, "started");
  assert.equal(pot.potName, "Alpha");

  const stillStarted = applyEventToPot(pot, {
    event: "join-pot",
    blockHeight: 13,
    contractId: POT,
    values: { amount: "1" },
  });
  assert.equal(stillStarted.status, "started");

  const claimed = applyEventToPot(pot, {
    event: "claim-pot-reward",
    blockHeight: 20,
    values: { "pot-address": POT, "pot-yield-amount": "42" },
  });
  assert.equal(claimed.status, "claimed");

  const cancelled = applyEventToPot(pot, {
    event: "cancel-pot",
    blockHeight: 14,
    contractId: POT,
    values: { "pot-cancelled": true },
  });
  assert.equal(cancelled.status, "cancelled");
});

test("fall-back-cancel and sequential start events are mapped", () => {
  const started = potRecordFromEvent({
    event: "start-stackspot-sequential-pot",
    values: { "pot-contract": POT },
  });
  assert.equal(started.status, "started");
  assert.equal(started.potType, "sequential");
  const cancelled = applyEventToPot(started, {
    event: "fall-back-cancel",
    blockHeight: 30,
    contractId: POT,
    values: { "pot-cancelled": true },
  });
  assert.equal(cancelled.status, "cancelled");
});

test("merge keeps the later lifecycle status", () => {
  const deployed = potRecordFromEvent({
    event: "pre-init",
    blockHeight: 10,
    values: { "pot-contract": POT, "pot-name": "Alpha" },
  });
  const claimed = potRecordFromEvent({
    event: "claim-pot-reward",
    blockHeight: 20,
    values: { "pot-address": POT, "pot-type": "jackpot" },
  });
  const merged = mergePotRecord(deployed, claimed);
  assert.equal(merged.status, "claimed");
  assert.equal(merged.potName, "Alpha");
});

test("normalizeListedPot infers status from lastEvent", () => {
  assert.equal(normalizeListedPot({ potAddress: POT, lastEvent: "pre-init" }).status, "deployed");
  assert.equal(normalizeListedPot({ potAddress: POT, lastEvent: "claim-pot-reward" }).status, "claimed");
  assert.equal(normalizeListedPot({ potAddress: POT, lastEvent: "admin added/updated" }), null);
});
