import assert from "node:assert/strict";
import test from "node:test";
import { computeStatistics } from "./stats.js";

const POT = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.jackpot";
const OTHER = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.crowd-fund";
const STACKSPOTS = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.stackspots";
const PRE_INIT_LOGS = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.stackspot-pre-init-logs";
const OTHER_LOGGER = "ST76BJH7YKSVMYTWFVKYCY01Q6G7J43CZ7FJ9DFK.stackspot-pre-init-logs";
const USER = "ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5";
const SPONSOR = "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG";

test("organises pots and stats from every contract event key", () => {
  const stats = computeStatistics(
    [
      {
        event: "pre-init",
        txId: "0xa",
        blockHeight: 10,
        contractId: PRE_INIT_LOGS,
        sourceContract: PRE_INIT_LOGS,
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
        contractId: PRE_INIT_LOGS,
        sourceContract: PRE_INIT_LOGS,
        values: { "pot-contract": OTHER, "pot-type": "crowd-fund", "pot-name": "Beta" },
      },
      {
        event: "init-pot",
        txId: "0x10b",
        blockHeight: 13,
        values: { contract: OTHER, type: "crowd-fund" },
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
      {
        event: "platform sponsor contract added",
        txId: "0x20",
        blockHeight: 2,
        values: { "contract-address": "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.stackspot-sponsor" },
      },
      {
        event: "sponsor-platform",
        txId: "0x21",
        eventIndex: 0,
        contractId: STACKSPOTS,
        blockHeight: 3,
        values: {
          amount: "40000000",
          cycles: "10",
          sponsor: SPONSOR,
          "sponsor-contract": "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.stackspot-sponsor",
        },
      },
      {
        event: "sponsor-platform",
        txId: "0x21",
        eventIndex: 1,
        contractId: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.stackspot-sponsor",
        blockHeight: 3,
        values: {
          amount: "40000000",
          cycles: "10",
          sponsor: SPONSOR,
          "sponsor-contract": "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.stackspot-sponsor",
        },
      },
      {
        event: "sponsor-event",
        txId: "0x22",
        contractId: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.stackspot-sponsor",
        blockHeight: 4,
        values: { "ticket-id": "1", "pot-contract": POT },
      },
    ],
    [],
    { stackspotsContract: STACKSPOTS, preInitLogsContract: PRE_INIT_LOGS },
  );

  assert.equal(stats.totals.pots, 2);
  assert.equal(stats.totals.events, 12);
  assert.equal(stats.totals.deployed, 2);
  assert.equal(stats.totals.joinable, 0);
  assert.equal(stats.totals.started, 1);
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
  assert.equal(stats.byStatus.started, 1);
  assert.equal(stats.byStatus.claimed, 1);
  assert.equal(stats.byStatus.cancelled, 1);
  assert.equal(stats.byEvent["join-pot"], 2);
  assert.equal(stats.byEvent["admin added/updated"], 1);
  assert.equal(stats.totals.platformSponsors, 1);
  assert.equal(stats.totals.platformSponsorContracts, 1);
  assert.equal(stats.totals.platformSponsorStx, "40000000");
  assert.equal(stats.totals.sponsorEvents, 1);
  assert.equal(stats.platformEvents["sponsor-platform"], 2);

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

test("register-pot does not create pot rows", () => {
  const stats = computeStatistics(
    [
      {
        event: "pot-registered",
        txId: "0xreg",
        blockHeight: 1,
        values: { "pot-address": OTHER, "pot-id": "9", "pot-deploy-fee": "500000" },
      },
      {
        event: "register-pot",
        txId: "0xreg2",
        blockHeight: 1,
        values: { "pot-address": OTHER, "pot-id": "9" },
      },
      {
        event: "init-pot",
        txId: "0xinit",
        blockHeight: 2,
        values: { contract: POT, type: "jackpot" },
      },
    ],
    [
      {
        potAddress: OTHER,
        status: "joinable",
        lastEvent: "pot-registered",
      },
    ],
    { stackspotsContract: STACKSPOTS },
  );

  assert.equal(stats.totals.pots, 0);
  assert.equal(stats.totals.deployed, 0);
  assert.equal(stats.totals.joinable, 1);
  assert.equal(stats.totals.deployFees, "500000");
  assert.equal(stats.pots[0].potAddress, POT);
});

test("claim yield uses max per pot and reconstructs from reward slices", () => {
  const stats = computeStatistics(
    [
      {
        event: "pre-init",
        txId: "0xa",
        blockHeight: 1,
        values: { "pot-contract": POT, "pot-type": "jackpot" },
      },
      {
        event: "init-pot",
        txId: "0xb",
        blockHeight: 2,
        values: { contract: POT, type: "jackpot" },
      },
      {
        event: "claim-pot-reward",
        txId: "0xf",
        eventIndex: 0,
        contractId: STACKSPOTS,
        blockHeight: 20,
        values: {
          "pot-address": POT,
          "claimer-address": USER,
          "starter-reward-amount": "92",
          "claimer-reward-amount": "92",
        },
      },
      {
        event: "claim-pot-reward",
        txId: "0xf",
        eventIndex: 1,
        contractId: POT,
        blockHeight: 20,
        values: {
          "pot-address": POT,
          "claimer-address": USER,
          "pot-yield-amount": "4645",
          "starter-reward-amount": "92",
          "claimer-reward-amount": "92",
        },
      },
    ],
    [],
    { stackspotsContract: STACKSPOTS },
  );

  assert.equal(stats.totals.claimed, 1);
  assert.equal(stats.totals.cancelled, 0);
  assert.equal(stats.byStatus.cancelled, 0);
  assert.equal(stats.totals.started, 0);
  assert.equal(stats.byStatus.started, 0);
  assert.equal(stats.totals.yieldClaimed, "4645");
});

test("pre-init increments deployed; init joinable; start leaves joinable", () => {
  const PRE_ONLY = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.pre-only";
  const stats = computeStatistics(
    [
      {
        event: "pre-init",
        txId: "0xpre",
        blockHeight: 1,
        contractId: PRE_INIT_LOGS,
        sourceContract: PRE_INIT_LOGS,
        values: { "pot-contract": PRE_ONLY, "pot-type": "jackpot" },
      },
      {
        event: "init-pot",
        txId: "0xinit",
        blockHeight: 2,
        values: { contract: POT, type: "jackpot" },
      },
      {
        event: "start-pot",
        txId: "0xstart",
        blockHeight: 3,
        values: { "pot-contract": POT, "pot-locked": true },
      },
      {
        event: "init-pot",
        txId: "0xopen",
        blockHeight: 4,
        values: { contract: OTHER, type: "crowd-fund" },
      },
    ],
    [],
    { stackspotsContract: STACKSPOTS, preInitLogsContract: PRE_INIT_LOGS },
  );

  assert.equal(stats.totals.pots, 1);
  assert.equal(stats.totals.deployed, 1);
  assert.equal(stats.totals.joinable, 1);
  assert.equal(stats.totals.started, 1);
  assert.ok(stats.pots.some((p) => p.potAddress === PRE_ONLY));
});

test("joinable drops on start/cancel only; started and claimed stay event-only", () => {
  const JOINABLE = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.open-pot";
  const LOCKED_LAG = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.lag-status";
  const stats = computeStatistics(
    [
      {
        event: "init-pot",
        txId: "0x1",
        blockHeight: 1,
        values: { contract: JOINABLE, type: "jackpot" },
      },
      {
        event: "init-pot",
        txId: "0x2",
        blockHeight: 2,
        values: { contract: LOCKED_LAG, type: "jackpot" },
      },
      // Locked flag on a pot that still has joinable-ish history; start print marks it started.
      {
        event: "start-stackspot-jackpot",
        txId: "0x3",
        blockHeight: 3,
        values: { "pot-contract": LOCKED_LAG, "pot-locked": true },
      },
      {
        event: "init-pot",
        txId: "0x4",
        blockHeight: 4,
        values: { contract: POT, type: "jackpot" },
      },
      {
        event: "start-stackspot-jackpot",
        txId: "0x5",
        blockHeight: 5,
        values: { "pot-contract": POT, "pot-locked": true },
      },
      {
        event: "claim-pot-reward",
        txId: "0x6",
        blockHeight: 6,
        values: { "pot-address": POT, "pot-yield-amount": "10" },
      },
      // Status string joinable but pot-locked in values (stale status row).
      {
        event: "init-pot",
        txId: "0x7",
        blockHeight: 7,
        values: { contract: OTHER, type: "crowd-fund", "pot-locked": true },
      },
    ],
    [],
    { stackspotsContract: STACKSPOTS },
  );

  assert.equal(stats.totals.joinable, 2);
  assert.equal(stats.byStatus.joinable, 2);
  assert.equal(stats.totals.started, 2);
  assert.equal(stats.byStatus.started, 2);
  assert.equal(stats.totals.claimed, 1);
  assert.equal(stats.pots.find((p) => p.potAddress === JOINABLE).status, "joinable");
});

test("live pot-locked does not move joinable or started", () => {
  const LOCKED = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.blaze";
  const OPEN = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.open";
  const stats = computeStatistics(
    [
      {
        event: "init-pot",
        txId: "0x1",
        blockHeight: 1,
        values: { contract: LOCKED, type: "sequential" },
      },
      {
        event: "init-pot",
        txId: "0x2",
        blockHeight: 2,
        values: { contract: OPEN, type: "jackpot" },
      },
    ],
    [
      {
        potAddress: LOCKED,
        status: "joinable",
        lastEvent: "init-pot",
        live: { "pot-locked": true, "pot-claimer-address": null },
      },
      {
        potAddress: OPEN,
        status: "joinable",
        lastEvent: "init-pot",
        live: { "pot-locked": false },
      },
    ],
    { stackspotsContract: STACKSPOTS },
  );

  assert.equal(stats.totals.pots, 0);
  assert.equal(stats.totals.deployed, 0);
  assert.equal(stats.totals.joinable, 2);
  assert.equal(stats.totals.started, 0);
  assert.equal(stats.byStatus.joinable, 2);
  assert.equal(stats.byStatus.started, 0);
});

test("pots and deployed count every stackspot-pre-init-logs event and nothing else", () => {
  const stats = computeStatistics(
    [
      {
        event: "pre-init",
        txId: "0x1",
        blockHeight: 1,
        contractId: PRE_INIT_LOGS,
        sourceContract: PRE_INIT_LOGS,
        values: { "pot-contract": POT },
      },
      {
        event: "pre-init",
        txId: "0x2",
        blockHeight: 2,
        contractId: PRE_INIT_LOGS,
        sourceContract: PRE_INIT_LOGS,
        values: { "pot-contract": POT },
      },
      {
        event: "pre-init",
        txId: "0x3",
        blockHeight: 3,
        contractId: OTHER_LOGGER,
        sourceContract: OTHER_LOGGER,
        values: { "pot-contract": OTHER },
      },
      {
        event: "pre-init",
        txId: "0x4",
        blockHeight: 4,
        values: { "pot-contract": OTHER },
      },
      {
        event: "init-pot",
        txId: "0x5",
        blockHeight: 5,
        values: { contract: POT, type: "jackpot" },
      },
    ],
    [],
    { stackspotsContract: STACKSPOTS, preInitLogsContract: PRE_INIT_LOGS },
  );

  assert.equal(stats.totals.pots, 2);
  assert.equal(stats.totals.deployed, 2);
  assert.equal(stats.byStatus.deployed, 2);
  assert.equal(stats.totals.events, 5);
});
