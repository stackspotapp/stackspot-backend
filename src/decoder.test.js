import assert from "node:assert/strict";
import test from "node:test";
import {
  bufferCV,
  falseCV,
  listCV,
  noneCV,
  optionalCVOf,
  principalCV,
  responseErrorCV,
  responseOkCV,
  serializeCV,
  serializeCVBytes,
  someCV,
  stringAsciiCV,
  trueCV,
  tupleCV,
  uintCV,
} from "@stacks/transactions";
import { decodePrintHex, decodeClarityResult, toPlain } from "./decoder.js";

function hexOf(cv) {
  const serialized = serializeCV(cv);
  return serialized.startsWith("0x") ? serialized : `0x${serialized}`;
}

test("extracts uint, principal, optional, bool, ascii, and nested list/tuple", () => {
  const inner = tupleCV({
    event: stringAsciiCV("join-pot"),
    participant: principalCV("ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM"),
    amount: uintCV(25_000_000n),
    index: uintCV(0n),
    cancelled: falseCV(),
    starter: noneCV(),
    claimer: optionalCVOf(principalCV("ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5")),
    winners: listCV([
      tupleCV({
        address: principalCV("ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM"),
        amount: uintCV(3n),
      }),
    ]),
    enabled: trueCV(),
  });

  const decoded = decodePrintHex(hexOf(inner));
  assert.equal(decoded.event, "join-pot");
  assert.equal(decoded.values.participant, "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM");
  assert.equal(decoded.values.amount, "25000000");
  assert.equal(decoded.values.index, "0");
  assert.equal(decoded.values.cancelled, false);
  assert.equal(decoded.values.starter, null);
  assert.equal(decoded.values.claimer, "ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5");
  assert.equal(decoded.values.enabled, true);
  assert.equal(decoded.values.winners[0].address, "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM");
  assert.equal(decoded.values.winners[0].amount, "3");
  assert.equal(decoded.clarity.value.amount.type, "uint");
  assert.equal(decoded.clarity.value.participant.type, "principal");
  assert.equal(decoded.clarity.value.starter.value, null);
});

test("unwraps to-consensus-buff? print: (optional (buff <tuple>))", () => {
  const payload = tupleCV({
    event: stringAsciiCV("pot-registered"),
    "pot-id": uintCV(1n),
    "pot-address": principalCV(
      "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.jackpot",
    ),
    hash: bufferCV(new Uint8Array(32).fill(0xab)),
  });
  const wrapped = someCV(bufferCV(serializeCVBytes(payload)));
  const decoded = decodePrintHex(hexOf(wrapped));
  assert.equal(decoded.event, "pot-registered");
  assert.equal(decoded.values["pot-id"], "1");
  assert.equal(
    decoded.values["pot-address"],
    "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.jackpot",
  );
  assert.equal(
    decoded.values.hash,
    "0xabababababababababababababababababababababababababababababababab",
  );
  assert.equal(decoded.clarity.value.hash.type, "buff");
});

test("unwraps stackspots emit-log (buff 2048) print", () => {
  const payload = tupleCV({
    event: stringAsciiCV("claim-pot-reward"),
    "pot-yield-amount": uintCV(42n),
    "funding-address": noneCV(),
    "pot-cancelled": falseCV(),
  });
  const decoded = decodePrintHex(hexOf(bufferCV(serializeCVBytes(payload))));
  assert.equal(decoded.event, "claim-pot-reward");
  assert.equal(decoded.values["pot-yield-amount"], "42");
  assert.equal(decoded.values["funding-address"], null);
  assert.equal(decoded.values["pot-cancelled"], false);
});

test("toPlain leaves hash buffers as 0x hex", () => {
  const cv = bufferCV(Uint8Array.from([0xde, 0xad]));
  assert.equal(toPlain(cv), "0xdead");
});

test("decodes a real jackpot pre-init print hex from simnet", () => {
  const hex =
    "0x0c0000000c056576656e740d000000087072652d696e69740f66756e64696e672d616464726573730909706f742d61646d696e051a6d78de7b0625dfbfc16c3a8a5735f6dc3dc3f2ce0c706f742d636f6e7472616374061a6d78de7b0625dfbfc16c3a8a5735f6dc3dc3f2ce076a61636b706f7409706f742d6379636c6501000000000000000000000000000000010b706f742d69732d696e69740414706f742d6d61782d7061727469636970616e747301000000000000000000000000000000640e706f742d6d696e2d616d6f756e740100000000000000000000000005f5e10008706f742d6e616d650d0000000009706f742d6f776e6572051a6d78de7b0625dfbfc16c3a8a5735f6dc3dc3f2ce0c706f742d7472656173757279061a6d78de7b0625dfbfc16c3a8a5735f6dc3dc3f2ce076a61636b706f7408706f742d747970650d000000076a61636b706f74";
  const decoded = decodePrintHex(hex);
  assert.equal(decoded.event, "pre-init");
  assert.equal(decoded.values["pot-type"], "jackpot");
  assert.equal(decoded.values["funding-address"], null);
  assert.equal(decoded.values["pot-cycle"], "1");
  assert.equal(decoded.values["pot-min-amount"], "100000000");
  assert.equal(decoded.values["pot-max-participants"], "100");
  assert.equal(decoded.values["pot-is-init"], false);
  assert.equal(decoded.values["pot-admin"], "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM");
  assert.equal(
    decoded.values["pot-contract"],
    "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.jackpot",
  );
  assert.equal(decoded.clarity.value["pot-cycle"].type, "uint");
  assert.equal(decoded.clarity.value["pot-contract"].type, "principal");
});

test("unwraps (ok tuple) from a read-only call result", () => {
  const decoded = decodeClarityResult(
    hexOf(
      responseOkCV(
        tupleCV({
          "pot-value": uintCV(25_000_000n),
          "pot-cancelled": falseCV(),
          "pot-starter-address": noneCV(),
        }),
      ),
    ),
  );
  assert.equal(decoded.ok, true);
  assert.equal(decoded.values["pot-value"], "25000000");
  assert.equal(decoded.values["pot-cancelled"], false);
  assert.equal(decoded.values["pot-starter-address"], null);
  assert.equal(decoded.clarity.value["pot-value"].type, "uint");
});

test("unwraps (err uint) from a failed read-only call result", () => {
  const decoded = decodeClarityResult(hexOf(responseErrorCV(uintCV(1001n))));
  assert.equal(decoded.ok, false);
  assert.equal(decoded.values, "1001");
  assert.equal(decoded.error, "1001");
});
