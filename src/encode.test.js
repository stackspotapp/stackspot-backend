import assert from "node:assert/strict";
import test from "node:test";
import { serializeArg, serializeArgs } from "./encode.js";

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
