import assert from "node:assert/strict";
import test from "node:test";
import {
  apiUrlForPrincipal,
  networkFromPrincipal,
  parseNetwork,
  resolveNetwork,
} from "./network.js";
import { resolveRequestContext } from "./config.js";

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
