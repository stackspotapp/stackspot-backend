import assert from "node:assert/strict";
import test from "node:test";
import { computePlatformState } from "./state.js";

const HUB = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.stackspots";
const LOGS = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.stackspot-pre-init-logs";
const POT = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.jackpot";

test("platform state counts logger prints, not live pots", () => {
  const stats = computePlatformState(
    [
      {
        event: "pre-init",
        sourceContract: LOGS,
        values: { "pot-contract": POT, sender: "ST1A" },
      },
      {
        event: "pre-init",
        sourceContract: LOGS,
        values: { "pot-contract": `${POT}2`, sender: "ST1B" },
      },
      {
        event: "init-pot",
        sourceContract: HUB,
        values: { contract: POT, type: "jackpot" },
      },
      {
        event: "init-pot",
        sourceContract: POT,
        values: { contract: POT, type: "jackpot" },
      },
      {
        event: "start-pot",
        sourceContract: HUB,
        values: { "pot-contract": POT },
      },
      {
        event: "cancel-pot",
        sourceContract: HUB,
        values: { "pot-contract": POT },
      },
      {
        event: "claim-pot-reward",
        sourceContract: HUB,
        values: { "pot-contract": POT },
      },
      {
        event: "register-pot",
        sourceContract: HUB,
        values: { "pot-address": POT, "pot-deploy-fee": "1000000" },
      },
      {
        event: "start-pot",
        sourceContract: POT,
        values: { "pot-contract": POT },
      },
    ],
    { stackspotsContract: HUB, preInitLogsContract: LOGS },
  );

  assert.equal(stats.totals.deployed, 2);
  assert.equal(stats.totals.started, 1);
  assert.equal(stats.totals.cancelled, 1);
  assert.equal(stats.totals.claimed, 1);
  assert.equal(stats.totals.joinable, 0);
  assert.equal(stats.totals.deployFees, "1000000");
  assert.equal(stats.kind, "platform-state-v1");
});

test("joinable is unique hub init pots minus started minus cancelled", () => {
  const stats = computePlatformState(
    [
      { event: "init-pot", sourceContract: HUB, values: { contract: POT } },
      { event: "init-pot", sourceContract: POT, values: { contract: POT } },
      { event: "register-pot", sourceContract: HUB, values: { "pot-address": POT, contract: POT } },
      { event: "init-pot", sourceContract: HUB, values: { contract: `${POT}2` } },
      { event: "init-pot", sourceContract: HUB, values: { contract: `${POT}3` } },
      { event: "start-pot", sourceContract: HUB, values: { "pot-contract": POT } },
    ],
    { stackspotsContract: HUB, preInitLogsContract: LOGS },
  );
  assert.equal(stats.totals.joinable, 2);
});

test("hiro logger totals overlay events; pots stay unique pre-init rows", () => {
  const stats = computePlatformState(
    [{ event: "pre-init", sourceContract: LOGS, values: {} }],
    {
      stackspotsContract: HUB,
      preInitLogsContract: LOGS,
      eventTotals: { preInit: 9, stackspots: 40 },
    },
  );
  assert.equal(stats.totals.deployed, 1);
  assert.equal(stats.totals.pots, 1);
  assert.equal(stats.totals.events, 49);
});
