import assert from "node:assert/strict";
import test from "node:test";
import { computeStatistics } from "./stats.js";

const POT = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.jackpot";
const OTHER = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.crowd-fund";
const STACKSPOTS = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.stackspots";
const USER = "ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5";
const SPONSOR = "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG";

test("organises pots and stats from every contract event key", () => {
  const stats = computeStatistics(
    [
      {
        event: "pre-init",
        txId: "0xa",
        blockHeight: 10,
        values: { "pot-contract": POT, "pot-type": "jackpot", "pot-name": "Alpha" },
      },
      {
        event: "init-pot",
        txId: "0xb",
        blockHeight: 11,
        values: { contract: POT, type: "jackpot" },
      },
      {
        event: "pot-registered",
        txId: "0xb",
        blockHeight: 11,
        values: { "pot-address": POT, "pot-id": "1", "pot-deploy-fee": "1000000", "pot-type": "jackpot" },
      },
      {
        event: "pot mint",
        txId: "0xb",
        blockHeight: 11,
        values: { recipient: POT, "token-id": "1", "platform-contracts-fee": "1000000" },
      },
      {
        event: "join-pot",
        txId: "0xc",
        eventIndex: 0,
        contractId: POT,
        blockHeight: 12,
        values: { participant: USER, amount: "25000000" },
      },
      {
        event: "join-pot",
        txId: "0xc",
        eventIndex: 1,
        contractId: STACKSPOTS,
        blockHeight: 12,
        values: { participant: USER, amount: "25000000" },
      },
      {
        event: "join-pot-as-sponsor",
        txId: "0xd",
        contractId: POT,
        blockHeight: 13,
        values: { sponsor: SPONSOR, amount: "5000000" },
      },
      {
        event: "start-stackspot-jackpot",
        txId: "0xe",
        blockHeight: 14,
        values: { "pot-contract": POT, "pot-locked": true, "pot-value": "30000000" },
      },
      {
        event: "stake-treasury",
        txId: "0xe",
        contractId: POT,
        blockHeight: 14,
        values: { "amount-ustx": "30000000", cycles: "1" },
      },
      {
        event: "claim-pot-reward",
        txId: "0xf",
        blockHeight: 20,
        values: { "pot-address": POT, "pot-yield-amount": "42", "pot-type": "jackpot" },
      },
      {
        event: "pre-init",
        txId: "0x10",
        blockHeight: 12,
        values: { "pot-contract": OTHER, "pot-type": "crowd-fund", "pot-name": "Beta" },
      },
      {
        event: "cancel-pot",
        txId: "0x11",
        contractId: OTHER,
        blockHeight: 15,
        values: { "pot-cancelled": true },
      },
      {
        event: "admin added/updated",
        txId: "0x12",
        blockHeight: 1,
        values: { enable: true },
      },
    ],
    [],
    { stackspotsContract: STACKSPOTS },
  );

  assert.equal(stats.totals.pots, 2);
  assert.equal(stats.totals.deployed, 0);
  assert.equal(stats.totals.joinable, 0);
  assert.equal(stats.totals.started, 0);
  assert.equal(stats.totals.cancelled, 1);
  assert.equal(stats.totals.claimed, 1);
  assert.equal(stats.totals.participants, 1);
  assert.equal(stats.totals.sponsors, 1);
  assert.equal(stats.totals.stxJoined, "25000000");
  assert.equal(stats.totals.stxSponsored, "5000000");
  assert.equal(stats.totals.stxTotal, "30000000");
  assert.equal(stats.totals.yieldClaimed, "42");
  assert.equal(stats.totals.deployFees, "1000000");
  assert.equal(stats.totals.staked, "30000000");
  assert.equal(stats.byType.jackpot, 1);
  assert.equal(stats.byType["crowd-fund"], 1);
  assert.equal(stats.byStatus.claimed, 1);
  assert.equal(stats.byStatus.cancelled, 1);
  assert.equal(stats.byEvent["join-pot"], 2);
  assert.equal(stats.byEvent["admin added/updated"], 1);

  const jackpot = stats.pots.find((pot) => pot.potAddress === POT);
  assert.equal(jackpot.status, "claimed");
  assert.equal(jackpot.potId, "1");
  assert.equal(jackpot.joins, 1);
  assert.equal(jackpot.sponsors, 1);
  assert.equal(jackpot.stxTotal, "30000000");
  assert.equal(jackpot.yieldClaimed, "42");

  const crowd = stats.pots.find((pot) => pot.potAddress === OTHER);
  assert.equal(crowd.status, "cancelled");
  assert.equal(crowd.joinable, false);
});
