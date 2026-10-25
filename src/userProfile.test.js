import assert from "node:assert/strict";
import test from "node:test";
import { computeUserProfile, sameUserAddress } from "./userProfile.js";

const POT = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.jackpot";
const OTHER = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.crowd-fund";
const USER = "ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5";
const OTHER_USER = "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG";
const STACKSPOTS = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.stackspots";
const PRE_INIT_LOGS = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.stackspot-pre-init-logs";

const opts = { stackspotsContract: STACKSPOTS, preInitLogsContract: PRE_INIT_LOGS };

test("sameUserAddress matches wallet vs contract principal", () => {
  assert.equal(sameUserAddress(USER, USER), true);
  assert.equal(sameUserAddress(USER, `${USER}.stackspot-sponsor`), true);
  assert.equal(sameUserAddress(USER, OTHER_USER), false);
});

test("computeUserProfile uses logger source + sender / winner participant", () => {
  const profile = computeUserProfile(
    [
      {
        event: "pre-init",
        txid: "0xa",
        sourceContract: PRE_INIT_LOGS,
        sender: USER,
        "pot-contract": POT,
        "pot-owner": USER,
        "pot-name": "Alpha",
        "pot-type": "jackpot",
      },
      {
        event: "pre-init",
        txid: "0xa-skip",
        sourceContract: STACKSPOTS,
        sender: USER,
        "pot-contract": OTHER,
        "pot-name": "Not from pre-init-logs",
      },
      {
        event: "join-pot",
        txid: "0xb-pot",
        sourceContract: OTHER,
        sender: USER,
        participant: USER,
        amount: "20000000",
        "pot-contract": OTHER,
      },
      {
        event: "join-pot",
        txid: "0xb",
        sourceContract: STACKSPOTS,
        sender: USER,
        participant: USER,
        amount: "20000000",
        "pot-contract": OTHER,
        "pot-name": "Beta",
        "pot-type": "crowdfund",
      },
      {
        event: "join-pot",
        txid: "0xc",
        sourceContract: STACKSPOTS,
        sender: OTHER_USER,
        participant: OTHER_USER,
        amount: "10000000",
        "pot-contract": POT,
      },
      {
        event: "join-pot-as-sponsor",
        txid: "0xd",
        sourceContract: STACKSPOTS,
        sender: USER,
        sponsor: USER,
        amount: "5000000",
        "pot-contract": OTHER,
        "pot-name": "Beta",
        "pot-type": "crowdfund",
      },
      {
        event: "claim-pot-reward",
        txid: "0xe",
        sourceContract: STACKSPOTS,
        sender: OTHER_USER,
        "pot-address": OTHER,
        "pot-contract": OTHER,
        "pot-name": "Beta",
        "winners-values": { participant: USER, "winner-address": USER, "winner-id": "1" },
      },
    ],
    USER,
    opts,
  );

  assert.equal(profile.totals.created, 1);
  assert.equal(profile.totals.joined, 1);
  assert.equal(profile.totals.sponsored, 1);
  assert.equal(profile.totals.won, 1);
  assert.equal(profile.joined[0].contract, OTHER);
  assert.equal(profile.joined[0].sender, USER);
  assert.equal(profile.totals.contributedUstx, "25000000");
  assert.equal(profile.created[0].potName, "Alpha");
  assert.equal(profile.won[0].winnerId, "1");
  assert.equal(profile.won[0].winnerAddress, USER);
});

test("join-pot still counts when only the stackspots print is cached", () => {
  const profile = computeUserProfile(
    [
      {
        event: "join-pot",
        txid: "0xjoin",
        sourceContract: STACKSPOTS,
        sender: USER,
        participant: USER,
        amount: "20000000",
        "pot-contract": POT,
      },
    ],
    USER,
    opts,
  );
  assert.equal(profile.totals.joined, 1);
  assert.equal(profile.joined[0].amount, "20000000");
  assert.equal(profile.joined[0].contract, POT);
});

test("sponsor-platform is not a sponsored pot", () => {
  const profile = computeUserProfile(
    [
      {
        event: "sponsor-platform",
        txid: "0xsp",
        sourceContract: STACKSPOTS,
        sender: USER,
        sponsor: USER,
        amount: "1500000000",
        "sponsor-contract": `${USER}.bake`,
        "project-name": "bake",
      },
    ],
    USER,
    opts,
  );
  assert.equal(profile.totals.sponsored, 0);
  assert.equal(profile.totals.contributedUstx, "0");
  assert.deepEqual(profile.sponsored, []);
});

test("stackspots logger matches by contract name across deployers", () => {
  const profile = computeUserProfile(
    [
      {
        event: "join-pot",
        txid: "0xst3",
        sourceContract: "ST3BSH7YA48AK2PCKCMGNPB4GXT09Y9JVTBCHA0A7.stackspots",
        sender: USER,
        participant: USER,
        amount: "3000000",
        "pot-contract": POT,
      },
    ],
    USER,
    opts,
  );
  assert.equal(profile.totals.joined, 1);
  assert.equal(profile.totals.contributedUstx, "3000000");
});

test("claim win matches winners-values.participant when winner-address is absent", () => {
  const profile = computeUserProfile(
    [
      {
        event: "claim-pot-reward",
        txid: "0xwin",
        sourceContract: STACKSPOTS,
        "pot-contract": POT,
        "pot-name": "Alpha",
        "winners-values": { participant: USER, "winner-id": "2" },
      },
    ],
    USER,
    opts,
  );
  assert.equal(profile.totals.won, 1);
  assert.equal(profile.won[0].contract, POT);
});
