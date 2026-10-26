import assert from "node:assert/strict";
import test from "node:test";
import {
  apiUrlForPrincipal,
  networkFromPrincipal,
  parseNetwork,
  resolveNetwork,
} from "./network.js";
import {
  isAcceptedPrintSource,
  platformSiblingContract,
  resolveRequestContext,
} from "./config.js";

test("detects mainnet and testnet from principal prefixes", () => {
  assert.equal(
    networkFromPrincipal("SP2HXAW0GEHMXGHR0PG44443HV0S58WSZQY4V26W1.stackspots"),
    "mainnet",
  );
  assert.equal(
    networkFromPrincipal("ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.jackpot"),
    "testnet",
  );
  assert.equal(parseNetwork("MAINNET"), "mainnet");
});

test("picks Hiro API from the contract address", () => {
  assert.equal(
    apiUrlForPrincipal("SP2HXAW0GEHMXGHR0PG44443HV0S58WSZQY4V26W1.stackspots", "testnet"),
    "https://api.hiro.so",
  );
  assert.equal(
    apiUrlForPrincipal("ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.jackpot", "mainnet"),
    "https://api.testnet.hiro.so",
  );
});

test("requires NETWORK when it cannot be inferred", () => {
  assert.equal(resolveNetwork({ network: "mainnet" }), "mainnet");
  assert.throws(() => resolveNetwork({}), /NETWORK is required/);
});

test("query network=testnet switches Hiro and marks source=query", () => {
  const ctx = resolveRequestContext("testnet");
  assert.equal(ctx.network, "testnet");
  assert.equal(ctx.networkSource, "query");
  assert.equal(ctx.stacksApiUrl, "https://api.testnet.hiro.so");
  assert.ok(ctx.contract, "STACKSPOTS_CONTRACT_TESTNET (or STACKSPOTS_CONTRACT) must be set in .env");
  assert.equal(
    ctx.preInitLogsContract,
    platformSiblingContract(ctx.contract, "stackspot-pre-init-logs"),
  );
});

test("pre-init logs sit on the platform sibling contract", () => {
  assert.equal(
    platformSiblingContract(
      "ST4KKK958A2BG93J06GE9S9Q80WCCMA7QXW2AFRT.stackspots",
      "stackspot-pre-init-logs",
    ),
    "ST4KKK958A2BG93J06GE9S9Q80WCCMA7QXW2AFRT.stackspot-pre-init-logs",
  );
  const ctx = {
    contract: "ST4KKK958A2BG93J06GE9S9Q80WCCMA7QXW2AFRT.stackspots",
    preInitLogsContract: "ST4KKK958A2BG93J06GE9S9Q80WCCMA7QXW2AFRT.stackspot-pre-init-logs",
  };
  assert.equal(isAcceptedPrintSource(ctx.preInitLogsContract, ctx), true);
  assert.equal(isAcceptedPrintSource(ctx.contract, ctx), true);
  assert.equal(
    isAcceptedPrintSource("ST4KKK958A2BG93J06GE9S9Q80WCCMA7QXW2AFRT.crowd-fund", ctx),
    false,
  );
  assert.equal(
    isAcceptedPrintSource("ST4KKK958A2BG93J06GE9S9Q80WCCMA7QXW2AFRT.crowd-fund", ctx, "ST4KKK958A2BG93J06GE9S9Q80WCCMA7QXW2AFRT.crowd-fund"),
    true,
  );
});

test("omitted network uses the default and source=default", () => {
  const ctx = resolveRequestContext(undefined);
  assert.equal(ctx.networkSource, "default");
  assert.ok(ctx.network === "mainnet" || ctx.network === "testnet");
});

test("rejects an unknown network query", () => {
  assert.throws(
    () => resolveRequestContext("devnet"),
    (error) => error.status === 400,
  );
});
