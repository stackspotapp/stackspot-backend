import assert from "node:assert/strict";
import test from "node:test";
import { parseContractId, parseFunctionName, deployedContractsFromAddressTxs } from "./hiro.js";

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

test("deployedContractsFromAddressTxs keeps successful smart_contract deploys", () => {
  const ids = deployedContractsFromAddressTxs([
    {
      tx: {
        tx_type: "smart_contract",
        tx_status: "success",
        smart_contract: { contract_id: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.jackpot" },
      },
    },
    {
      tx_type: "smart_contract",
      tx_status: "success",
      smart_contract: { contract_id: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.sequential" },
    },
    {
      tx_type: "smart_contract",
      tx_status: "abort_by_response",
      smart_contract: { contract_id: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.crowd-fund" },
    },
    {
      tx_type: "token_transfer",
      tx_status: "success",
    },
  ]);
  assert.deepEqual(ids, [
    "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.jackpot",
    "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.sequential",
  ]);
});
