import assert from "node:assert/strict";
import test from "node:test";
import { serializeArg, serializeArgs, sponsorDetailsArgsFromPotValues } from "./encode.js";

test("serializes uint, principal, and bool args", () => {
  const args = serializeArgs([
    25,
    "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
    true,
    { type: "uint", value: "100" },
  ]);
  assert.equal(args.length, 4);
  for (const hex of args) {
    assert.match(hex, /^0x[0-9a-f]+$/i);
  }
});

test("passes through already-serialized hex", () => {
  assert.equal(serializeArg("0x01"), "0x01");
});

test("encodes get-sponsor-details pot-metric tuple", () => {
  const [arg] = sponsorDetailsArgsFromPotValues({
    "pot-value": "40000000",
    "pot-participants-count": "3",
    "pot-lock-burn-height": "30023",
  });
  assert.equal(arg.type, "tuple");
  assert.equal(arg.value.balance.value, "40000000");
  assert.equal(arg.value["participant-count"].value, "3");
  assert.equal(arg.value["lock-burn-height"].value, "30023");
  const hex = serializeArg(arg);
  assert.match(hex, /^0x[0-9a-f]+$/i);
});
