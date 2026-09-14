import assert from "node:assert/strict";
import test from "node:test";
import { STACKSPOTS_EVENTS, eventDedupeId, toPublicEvent } from "./catalog.js";

const HIDDEN = [
  "id",
  "txId",
  "eventIndex",
  "contractId",
  "blockHeight",
  "burnBlockHeight",
  "hex",
  "repr",
  "clarity",
  "values",
  "eventType",
  "topic",
  "sortScore",
  "decodeError",
];

test("every known event type returns only extracted print fields plus txid", () => {
  for (const [name, spec] of Object.entries(STACKSPOTS_EVENTS)) {
    const values = { event: name, extra: "not-in-hex-schema" };
    for (const field of spec.fields) {
      if (field === "event") continue;
      values[field] = field.includes("cancelled") || field === "enable" || field === "state" ? true : "1";
    }

    const pub = toPublicEvent({
      id: "0xabc:3",
      txId: "0xabc",
      eventIndex: 3,
      event: name,
      contractId: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.stackspots",
      blockHeight: 12,
      burnBlockHeight: 99,
      hex: "0x0c",
      repr: "(tuple (event ...))",
      clarity: { type: "tuple", value: {} },
      eventType: "smart_contract_log",
      topic: "print",
      sortScore: 12_000_003,
      decodeError: null,
      values,
    });

    assert.equal(pub.txid, "0xabc", name);
    assert.equal(pub.event, name);
    for (const field of spec.fields) {
      if (field === "event") continue;
      assert.equal(pub[field], values[field], `${name}.${field}`);
    }
    assert.equal(pub.extra, "not-in-hex-schema", name);
    for (const key of HIDDEN) {
      assert.equal(pub[key], undefined, `${name} leaked ${key}`);
    }
  }
});

test("stored shape keeps the full decoded print and drops hex metadata", () => {
  const stored = toPublicEvent({
    id: "0xabc:1",
    txId: "0xabc",
    eventIndex: 1,
    contractId: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.jackpot",
    blockHeight: 4,
    hex: "0x0c",
    event: "join-pot",
    values: { event: "join-pot", participant: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM", amount: "1", index: "0" },
  });
  assert.deepEqual(Object.keys(stored).sort(), ["amount", "event", "index", "participant", "txid"]);
  assert.equal(stored.hex, undefined);
  assert.deepEqual(toPublicEvent(stored), stored);
});

test("identical prints in one tx share a cache id", () => {
  const print = {
    event: "sponsor-platform",
    amount: "40000000",
    cycles: "4",
    sponsor: "ST4B1RB4STWAGXDYH05CAK2T14BBC2CJ6E1BGG7D",
    "sponsor-contract": "ST4B1RB4STWAGXDYH05CAK2T14BBC2CJ6E1BGG7D.kings-vibes",
  };
  const forwarded = toPublicEvent({ txId: "0xabc", eventIndex: 1, values: print });
  const local = toPublicEvent({ txId: "0xabc", eventIndex: 4, contractId: "ST4.kings-vibes", values: print });
  assert.equal(eventDedupeId(forwarded), eventDedupeId(local));

  const other = toPublicEvent({
    txId: "0xabc",
    eventIndex: 2,
    values: { ...print, amount: "1" },
  });
  assert.notEqual(eventDedupeId(forwarded), eventDedupeId(other));
});

test("unknown prints are not returned", () => {
  assert.equal(
    toPublicEvent({
      txId: "0xabc",
      event: "not-a-stackspots-event",
      values: { event: "not-a-stackspots-event", amount: "1" },
    }),
    null,
  );
});
