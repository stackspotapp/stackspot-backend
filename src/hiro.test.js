import assert from "node:assert/strict";
import test from "node:test";
import { parseContractId, parseFunctionName } from "./hiro.js";

test("parses ADDRESS.NAME and split path params", () => {
  const id = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.jackpot";
  const fromJoined = parseContractId(id);
  const fromParts = parseContractId(
    "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
    "jackpot",
  );
  assert.deepEqual(fromJoined, {
    contractId: id,
    address: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
    name: "jackpot",
  });
  assert.deepEqual(fromParts, fromJoined);
});

test("rejects a bare principal without a contract name", () => {
  assert.throws(
    () => parseContractId("ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM"),
    (error) => error.status === 400,
  );
});

test("accepts get-pot-details as a function name", () => {
  assert.equal(parseFunctionName("get-pot-details"), "get-pot-details");
});
